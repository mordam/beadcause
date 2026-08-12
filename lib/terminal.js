import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSessionRepo, permissionFlag } from './session.js';
import { promptArgs } from './foundation.js';
import { repoLabelsOf, repoSummary, whereLanded } from './repos.js';
import { CONFIG_DIR } from './config.js';
import { writeJsonAtomic } from './atomic.js';

/**
 * A real Claude Code session, on a pty, driven from the phone.
 *
 * Everything else in beadcause hands an agent a brief and reads back what it did.
 * This is the one place you steer one yourself: the actual TUI, keystroke for
 * keystroke, in the workspace's own directory. `POST /api/session` opens the same
 * thing on the Mac's screen — this opens it on a screen you are holding.
 *
 * Three decisions shape this file, and the third is the one that took the work.
 *
 * **The pty comes from `expect`, not from Node.** There is no `openpty(3)` in the
 * standard library and `node-pty` is a native module ABI-locked to whichever Node
 * the launchd plist pins, so the pty has to come from a system binary. It cannot be
 * `script(1)` — see the long note at the top of `scripts/pty-relay.exp` for why, in
 * detail. `expect` is in the base system, relays raw bytes both ways over ordinary
 * pipes, and lets the daemon resize the pty from outside, which is what makes
 * rotating the phone reflow the TUI instead of leaving it drawn at 40 columns.
 *
 * **The pty outlives the socket.** This is the whole lifecycle problem. A phone
 * that locks its screen drops the WebSocket within seconds, and a terminal whose
 * process died with its socket would lose the conversation every time the screen
 * went dark — worse than having no terminal at all. So the process belongs to this
 * registry, not to any connection: sockets attach and detach, output keeps
 * accumulating into a scrollback ring while nobody is watching, and reconnecting
 * replays it. What ends a terminal is exiting `claude`, pressing the button, or the
 * idle reaper — never a dropped connection.
 *
 * **Output is bytes, and stays bytes.** The ring buffer holds Buffers and the
 * socket sends binary frames. A pty carries partial UTF-8 sequences across chunk
 * boundaries constantly — a box-drawing character split down the middle — and
 * decoding per chunk turns them into replacement characters that are then in the
 * scrollback forever. xterm.js does the decoding, once, at the end.
 *
 * **The conversation outlives the daemon, and the pty does not.** A restart still
 * kills every pty — one relaying to a registry that no longer exists is a leak, and
 * `shutdownTerminals()` has always said so. What is new is that it is no longer a
 * *loss*: the record is on disk, the claude session id was chosen by us at open time,
 * and the next time someone attaches the pty comes back with `claude --resume`. The
 * resume is lazy on purpose. A daemon that respawned four `claude` processes at boot
 * would be resurrecting sessions nobody asked for, and doing it before anyone was
 * watching — the phone attaching is the signal that the conversation is still wanted.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, '..', 'scripts', 'pty-relay.exp');

/** Base-system expect. Not looked up on PATH: the daemon's PATH under launchd is not yours. */
const EXPECT = '/usr/bin/expect';

/** Single-quote for /bin/sh, same rule as lib/session.js. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Clamp a window size the client asked for to something a tty will accept. */
const dim = (n, fallback, max) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : fallback;
};

const now = () => Date.now();
const iso = () => new Date().toISOString();

/** Live, resumable and recently-exited terminals, by id. */
const terminals = new Map();

/**
 * One JSON record per terminal, beside the consoles.
 *
 * Small and written at lifecycle boundaries only — open, resume, exit, shutdown —
 * never per chunk. The scrollback is deliberately NOT in it: it is up to
 * `terminalScrollbackBytes` of raw pty output per terminal, it would have to be
 * written continuously to be worth anything, and replaying a dead session's bytes
 * into a freshly resumed TUI would draw a screen that is half history and half live.
 * `claude --resume` redraws the conversation itself, which is the honest version of
 * the same thing.
 */
const TERMINAL_DIR = path.join(CONFIG_DIR, 'terminals');
const recordPath = (id) => path.join(TERMINAL_DIR, `${id}.json`);

/** Set by shutdownTerminals so the exit handler does not record a kill as an ending. */
let shuttingDown = false;

/** Is this feature switched on at all? */
export const terminalsEnabled = (cfg) => cfg.terminal !== false;

const idleMs = (cfg) => Math.max(1, cfg.terminalIdleMinutes ?? 30) * 60000;
const scrollbackBytes = (cfg) => Math.max(8192, cfg.terminalScrollbackBytes ?? 256 * 1024);
const maxTerminals = (cfg) => Math.max(1, cfg.terminalMax ?? 4);

/**
 * How long an exited terminal stays listed.
 *
 * Not zero, because the interesting thing about a session that ended is usually the
 * last screen before it did — a stack trace, a permission prompt you missed, the
 * reason it stopped. Reconnecting to a dead terminal replays that and says so,
 * rather than 404ing as though it had never existed.
 */
const KEEP_EXITED_MS = 10 * 60000;

/* ------------------------------------------------------------------ the ring */

/**
 * Append to the scrollback, dropping from the front once it is over budget.
 *
 * Whole chunks are dropped rather than sliced. A pty chunk usually begins mid-escape
 * sequence, so slicing one leaves a fragment that xterm.js renders as garbage on the
 * first line of the replay; dropping it loses a little more scrollback and nothing
 * else. The first replayed line is imperfect either way — this is the version that
 * looks like a scrolled-off line rather than like a bug.
 */
function append(t, chunk) {
  t.buf.push(chunk);
  t.bytes += chunk.length;
  while (t.bytes > t.cap && t.buf.length > 1) {
    t.bytes -= t.buf.shift().length;
    t.truncated = true;
  }
}

/** Everything the terminal has said, as one Buffer. */
export const scrollback = (t) => Buffer.concat(t.buf);

/* ------------------------------------------------------------------- on disk */

/**
 * What survives the daemon: enough to find the directory again and to resume the
 * conversation, and nothing that only means something to a running process.
 *
 * `status` is stored as the two states that outlive a restart. A terminal that was
 * running is stored `live` — meaning "this session did not end" — and comes back as
 * `resumable`; one that ended is stored `exited` and never comes back as anything
 * else. That distinction is the whole feature: a session you closed must stay closed.
 */
const record = (t) => ({
  id: t.id,
  workspace: t.workspace,
  // Written down as well as held in memory: a terminal resumed after a restart comes
  // back off this file alone, and a card that stopped naming its checkout across a
  // `launchctl kickstart` would be worse than one that never named it.
  repo: t.repo || null,
  dir: t.dir,
  bead: t.bead,
  cols: t.cols,
  rows: t.rows,
  claudeSessionId: t.claudeSessionId,
  status: t.status === 'exited' ? 'exited' : 'live',
  startedAt: t.startedAt,
  endedAt: t.endedAt,
  exitCode: t.exitCode,
  exitSignal: t.exitSignal,
  resumedAt: t.resumedAt,
  savedAt: iso(),
});

function persist(t) {
  try {
    fs.mkdirSync(TERMINAL_DIR, { recursive: true });
    writeJsonAtomic(recordPath(t.id), record(t));
  } catch (err) {
    // Never fatal. A terminal that cannot be written down still works for as long as
    // this daemon lives, which is exactly what it did before any of this existed.
    console.error(`[beadcause] could not save terminal ${t.id}: ${err.message}`);
  }
}

/** Drop the record. Called when the terminal leaves the registry for good. */
function forget(id) {
  try {
    fs.rmSync(recordPath(id), { force: true });
  } catch {
    /* the next restore will skip it anyway */
  }
}

/** The in-memory half of a terminal — the parts no file can carry. */
function blank(cfg, rec) {
  return {
    ...rec,
    slaveFile: path.join(os.tmpdir(), `beadcause-pty-${rec.id}`),
    slave: null,
    buf: [],
    bytes: 0,
    cap: scrollbackBytes(cfg),
    truncated: false,
    listeners: new Set(),
    clients: 0,
    child: null,
    lastActivity: now(),
  };
}

/* --------------------------------------------------------------- the process */

/**
 * What `claude` is started with.
 *
 * The brief goes through a temp file the shell reads and deletes, exactly as
 * lib/session.js does it, so a multi-line markdown prompt never has to survive
 * being re-quoted. `exec` on the front means the login shell replaces itself with
 * `expect`, so there is no extra process between the daemon and the pty for a
 * signal to get lost behind.
 */
export function commandFor(cfg, slaveFile, promptFile, { claudeSessionId = null, resume = false } = {}) {
  // The id is ours, chosen before the process exists. `--session-id` on the first
  // start and `--resume` on every one after is the same trick the chat session uses
  // (lib/console.js), and it is what makes a restart recoverable at all: without it
  // there is no handle to reattach to, only a transcript nobody named.
  const session = claudeSessionId
    ? resume
      ? ` --resume ${shq(claudeSessionId)}`
      : ` --session-id ${shq(claudeSessionId)}`
    : '';
  const claude = `claude${permissionFlag(cfg.terminalPermissionMode, 'terminalPermissionMode')}${session}`;
  const relay = `exec ${shq(EXPECT)} ${shq(RELAY)} ${shq(slaveFile)}`;
  if (!promptFile) return `${relay} ${claude}`;
  // Read and delete before exec, so the brief is off disk the moment it is in argv.
  // `--` before the prompt because this one is typed by a person into the terminal's
  // opening field, which makes it the likeliest of all of them to begin with a dash —
  // and the `expect` relay in between would report the parse failure as the pty simply
  // closing. See `promptArgs`.
  const prompt = promptArgs().join(' ');
  return `P="$(cat ${shq(promptFile)})" && rm -f ${shq(promptFile)} && ${relay} ${claude} ${prompt}`;
}

/**
 * Open a terminal on a workspace.
 *
 * The directory is resolved by `resolveSessionRepo` and by nothing else — the same
 * guard `POST /api/session` and the chat session apply. `~/.zshenv` derives
 * `BEADS_DIR`, `BEADS_ACTOR` and `CLAUDE_CONFIG_DIR` from `$PWD`, so where this
 * process starts is what decides which tracker it writes to and which account it
 * bills. A terminal that came up in the wrong directory would be a session quietly
 * doing work against the wrong project, which is the failure this whole convention
 * exists to prevent.
 */
export function openTerminal(cfg, workspace, { prompt = null, bead = null, cols, rows } = {}) {
  // A resumable terminal counts against the cap: it is a conversation that is still
  // yours to come back to, and the first attach turns it back into a process.
  const live = listTerminals().filter((t) => t.status === 'live' || t.status === 'resumable');
  if (live.length >= maxTerminals(cfg)) {
    throw Object.assign(
      new Error(`${live.length} terminals are already open (terminalMax is ${maxTerminals(cfg)}) — close one first`),
      { status: 429 }
    );
  }

  // Resolved before anything is written or spawned, so a bead naming a checkout that
  // cannot be placed refuses here — with `resolveRepo`'s own sentence, on the phone that
  // tapped it — rather than opening a pty in the default repo.
  const { dir, repo } = resolveSessionRepo(cfg, workspace, bead);
  const id = crypto.randomBytes(8).toString('hex');

  let promptFile = null;
  if (prompt) {
    promptFile = path.join(os.tmpdir(), `beadcause-term-${id}.md`);
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  }

  const t = {
    ...blank(cfg, {
      id,
      workspace: workspace.name,
      dir,
      // The `repo:` labels ride along, and only those. /admin replaces a terminal
      // whose pty is gone from this record alone (`open` in lib/server.js), and
      // without them the replacement for an `athena-service` terminal would come up
      // in `architecture` — see `repoLabelsOf`.
      bead: bead ? { id: bead.id, title: bead.title || '', labels: repoLabelsOf(bead) } : null,
      // Which checkout it came up in, for the card. Null everywhere but a workspace
      // with an approved repo list.
      repo: repoSummary(repo),
      cols: dim(cols, 80, 500),
      rows: dim(rows, 24, 200),
      status: 'live',
      exitCode: null,
      exitSignal: null,
      startedAt: iso(),
      endedAt: null,
      // Chosen here rather than read back from claude, so the first turn and every
      // resume after a restart name the same conversation.
      claudeSessionId: crypto.randomUUID(),
      resumedAt: null,
    }),
  };

  spawnPty(cfg, t, { promptFile });
  terminals.set(id, t);
  persist(t);
  console.log(
    `[beadcause] terminal ${id} opened on ${whereLanded(workspace.name, repo)}${bead ? ` from ${bead.id}` : ''} in ${dir}`
  );
  return t;
}

/**
 * Start the pty for a terminal record — the first time, or again after a restart.
 *
 * Everything about the process is identical either way except the one flag: a fresh
 * session names itself with `--session-id`, a resumed one asks for the same
 * conversation back with `--resume`. Keeping them in one function is deliberate; the
 * failure this whole feature exists to prevent is a resumed terminal that is subtly
 * not the same thing as a live one.
 */
function spawnPty(cfg, t, { promptFile = null, resume = false } = {}) {
  const command = commandFor(cfg, t.slaveFile, promptFile, {
    claudeSessionId: t.claudeSessionId,
    resume,
  });
  const child = spawn('/bin/zsh', ['-lc', command], {
    cwd: t.dir,
    env: {
      ...process.env,
      // Read by pty-relay.exp as it creates the pty, so the TUI is never briefly
      // drawn at 0x0 and then reflowed — Ink samples its width at startup.
      COLUMNS: String(t.cols),
      LINES: String(t.rows),
      TERM: 'xterm-256color',
      // Nothing here is a Claude Code session opened by hand, and CI-ish env vars
      // make some tools drop colour. Say plainly that colour is wanted.
      FORCE_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.child = child;
  t.status = 'live';

  const out = (chunk) => {
    t.lastActivity = now();
    append(t, chunk);
    for (const fn of t.listeners) {
      try {
        fn(chunk);
      } catch {
        /* a socket that throws on write is a socket about to close; the close
           handler detaches it. Losing this chunk to that client is fine — every
           other client, and the scrollback, still have it. */
      }
    }
  };
  child.stdout.on('data', out);
  // expect's own complaints (a missing `claude`, a spawn failure) are the only
  // thing on stderr, and they are exactly what you want to see on the screen.
  child.stderr.on('data', out);

  child.on('error', (err) => {
    out(Buffer.from(`\r\n[beadcause] could not start the terminal: ${err.message}\r\n`));
  });

  child.on('exit', (code, signal) => {
    // Suspended on purpose — see suspendTerminal. Same as the shutdown case in
    // spirit: the pty is dead and the conversation is not. It differs in that this
    // daemon is staying up, so the in-memory record has to become `resumable` here
    // rather than being rebuilt from disk by the next boot.
    if (t.suspending) {
      t.suspending = false;
      t.status = 'resumable';
      t.lastActivity = now();
      fs.rmSync(t.slaveFile, { force: true });
      if (promptFile) fs.rmSync(promptFile, { force: true });
      out(Buffer.from(`\r\n\x1b[2m[beadcause] paused from the admin screen — resuming reopens this conversation\x1b[0m\r\n`));
      for (const fn of t.listeners) {
        try {
          fn(null, { type: 'suspend' });
        } catch {
          /* a listener that throws must not take the others with it */
        }
      }
      console.log(`[beadcause] terminal ${t.id} suspended — resumable`);
      return;
    }
    t.status = 'exited';
    t.exitCode = code;
    t.exitSignal = signal;
    t.endedAt = iso();
    t.lastActivity = now();
    fs.rmSync(t.slaveFile, { force: true });
    if (promptFile) fs.rmSync(promptFile, { force: true });
    // The one case where a dead pty is not an ended session: the daemon is going
    // away and took it with it. Recording that as `exited` would be the daemon
    // deciding, on its way out, that your conversation is over.
    if (!shuttingDown) persist(t);
    out(Buffer.from(`\r\n\x1b[2m[beadcause] session ended${signal ? ` (${signal})` : code ? ` (exit ${code})` : ''}\x1b[0m\r\n`));
    for (const fn of t.listeners) {
      try {
        fn(null, { type: 'exit', code, signal });
      } catch {
        /* same as above */
      }
    }
    console.log(`[beadcause] terminal ${t.id} ended (${signal || `exit ${code}`})`);
  });

  // The slave name only exists once expect has spawned, so poll briefly for it
  // rather than making the caller wait on it. Resize simply does not work until it
  // lands, which is a few milliseconds and long before anyone can rotate a phone.
  pollForSlave(t);
  return t;
}

/**
 * Bring a resumable terminal back — the first attach after a restart.
 *
 * Says so on the screen before the TUI draws over it, because the alternative is a
 * pane that comes back subtly different (no scrollback, a conversation that has
 * apparently forgotten the last minute) with nothing to explain why.
 */
export function resumeTerminal(cfg, t) {
  if (!t || t.status !== 'resumable') return t;
  t.resumedAt = iso();
  append(
    t,
    Buffer.from(
      `\r\n\x1b[2m[beadcause] the daemon restarted — resuming this session (${t.claudeSessionId.slice(0, 8)}). ` +
        `The screen from before it is gone; claude redraws the conversation itself.\x1b[0m\r\n`
    )
  );
  spawnPty(cfg, t, { resume: true });
  persist(t);
  console.log(`[beadcause] terminal ${t.id} resumed on ${t.workspace} (${t.dir})`);
  return t;
}

/**
 * Rebuild the registry from disk, once, at startup.
 *
 * Nothing is spawned here — see the header. A record that was running comes back
 * `resumable` and gets its pty on the first attach; one that had ended comes back
 * `exited` and never gets one, which is the difference between a session the daemon
 * interrupted and a session you finished.
 */
export function restoreTerminals(cfg) {
  let names;
  try {
    names = fs.readdirSync(TERMINAL_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return 0; // No directory: nothing has ever been persisted here.
  }
  let restored = 0;
  for (const name of names) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(TERMINAL_DIR, name), 'utf8'));
    } catch {
      continue; // Half-written or hand-edited. One bad record must not lose the rest.
    }
    const id = String(rec?.id || '');
    if (!/^[a-f0-9]{16}$/i.test(id) || terminals.has(id)) continue;
    if (!rec.claudeSessionId || !rec.dir) {
      // Written by a version before this feature: there is no handle to resume with,
      // so listing it as resumable would promise something that cannot be delivered.
      forget(id);
      continue;
    }
    const ended = rec.status === 'exited';
    if (ended && Date.now() - Date.parse(rec.endedAt || rec.savedAt || 0) > KEEP_EXITED_MS) {
      forget(id);
      continue;
    }
    const t = blank(cfg, {
      ...rec,
      // The one state that is derived rather than stored: `live` on disk means "this
      // session did not end", and what that becomes after a restart is an offer.
      status: ended ? 'exited' : 'resumable',
    });
    terminals.set(id, t);
    restored += 1;
  }
  if (restored) {
    const resumable = [...terminals.values()].filter((t) => t.status === 'resumable').length;
    console.log(`[beadcause] restored ${restored} terminal(s) — ${resumable} resumable, the rest already ended`);
  }
  return restored;
}

/** Watch for the slave device name pty-relay.exp writes once the pty exists. */
function pollForSlave(t, attempts = 40) {
  if (t.slave || t.status !== 'live') return;
  let name = '';
  try {
    name = fs.readFileSync(t.slaveFile, 'utf8').trim();
  } catch {
    /* not written yet */
  }
  if (name) {
    t.slave = name;
    // Apply whatever size the client asked for in the meantime. Usually a no-op —
    // COLUMNS/LINES already set it — but a phone that rotated during startup would
    // otherwise stay at the size it launched with until the next rotation.
    return resize(t.id, t.cols, t.rows);
  }
  if (attempts <= 0) {
    console.warn(`[beadcause] terminal ${t.id}: no pty name after 2s — resize will not work`);
    return;
  }
  setTimeout(() => pollForSlave(t, attempts - 1), 50);
}

/* ------------------------------------------------------------------ the API */

export function getTerminal(id) {
  if (!/^[a-f0-9]{16}$/i.test(String(id || ''))) return null;
  return terminals.get(id) || null;
}

/** Newest first, slim enough to list. */
export function listTerminals() {
  return [...terminals.values()]
    .map(summary)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** What a terminal looks like over HTTP — everything except the bytes. */
export function summary(t) {
  return {
    id: t.id,
    workspace: t.workspace,
    // The checkout, beside the workspace rather than instead of it: with N repos
    // behind one tracker name, "climative" no longer says where this window landed.
    // Null — and absent from every card — for a workspace that is one repo.
    repo: t.repo || null,
    dir: t.dir,
    bead: t.bead,
    status: t.status,
    exitCode: t.exitCode,
    exitSignal: t.exitSignal,
    cols: t.cols,
    rows: t.rows,
    clients: t.clients,
    bytes: t.bytes,
    truncated: t.truncated,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    // Set once this terminal has been brought back after a restart. The client uses
    // it to say so rather than leaving you to wonder where the screen went.
    resumedAt: t.resumedAt || null,
    idleSeconds: Math.round((now() - t.lastActivity) / 1000),
  };
}

/** Keystrokes from the phone. Bytes straight through — control characters included. */
export function writeTo(id, data) {
  const t = getTerminal(id);
  if (!t || t.status !== 'live' || !t.child?.stdin?.writable) return false;
  t.lastActivity = now();
  t.child.stdin.write(data);
  return true;
}

/**
 * Reflow the pty when the phone rotates.
 *
 * `stty` against the slave device is the whole mechanism: the kernel raises
 * SIGWINCH in the pty's foreground process group, and the TUI redraws itself. This
 * is the part `script(1)` could not have done — it is why the relay writes the
 * device name out at startup.
 */
export function resize(id, cols, rows) {
  const t = getTerminal(id);
  if (!t || t.status !== 'live') return false;
  t.cols = dim(cols, t.cols, 500);
  t.rows = dim(rows, t.rows, 200);
  if (!t.slave) return false;
  execFile('/bin/sh', ['-c', `stty rows ${t.rows} cols ${t.cols} < ${shq(t.slave)}`], (err) => {
    // Losing a resize is cosmetic — the TUI stays drawn at the old width — so it is
    // logged and never thrown. The common cause is the session having just exited.
    if (err && t.status === 'live') console.warn(`[beadcause] terminal ${id}: resize failed — ${err.message}`);
  });
  return true;
}

/** Subscribe to output. Returns an unsubscribe. */
export function attach(id, fn) {
  const t = getTerminal(id);
  if (!t) return null;
  t.listeners.add(fn);
  t.clients += 1;
  t.lastActivity = now();
  return () => {
    t.listeners.delete(fn);
    t.clients = Math.max(0, t.clients - 1);
    // Detaching counts as activity: it is the moment the idle clock should start,
    // not a moment already thirty minutes into it.
    t.lastActivity = now();
  };
}

/**
 * End a terminal on purpose.
 *
 * SIGTERM to the relay, which passes the child its own death; SIGKILL after a grace
 * period for the case where `claude` is wedged. Note this is deliberately not what
 * a closed socket does — see the header.
 */
export function closeTerminal(id, { signal = 'SIGTERM' } = {}) {
  const t = getTerminal(id);
  if (!t) return false;
  // Closing a conversation you never came back to is still closing it: there is no
  // process to signal, but the record must stop offering itself as resumable.
  if (t.status === 'resumable') {
    t.status = 'exited';
    t.endedAt = iso();
    t.lastActivity = now();
    persist(t);
    console.log(`[beadcause] terminal ${t.id} closed before it was resumed`);
    return true;
  }
  if (t.status !== 'live' || !t.child) return true;
  try {
    t.child.kill(signal);
  } catch {
    return false;
  }
  setTimeout(() => {
    if (t.status === 'live') {
      try {
        t.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, 5000).unref?.();
  return true;
}

/**
 * Reap terminals nobody came back to, and forget the ones that ended a while ago.
 *
 * The idle clock only runs with no socket attached. A terminal you are watching is
 * never reaped for being quiet, because "quiet" is what a Claude session looks like
 * for the four minutes it spends reading a repo before it says anything.
 */
export function reapTerminals(cfg) {
  const cutoff = idleMs(cfg);
  let reaped = 0;
  for (const t of [...terminals.values()]) {
    // A resumable terminal holds no process, but it is still an offer — and an offer
    // nobody took up inside the idle window is one nobody is coming back for. Aged
    // out on the same clock as a live one, so the list means the same thing either way.
    if (t.status === 'live' || t.status === 'resumable') {
      if (t.clients > 0) continue;
      if (now() - t.lastActivity < cutoff) continue;
      console.log(`[beadcause] terminal ${t.id} reaped — idle and unwatched for ${Math.round(cutoff / 60000)} min`);
      closeTerminal(t.id);
      reaped += 1;
    } else if (t.endedAt && now() - t.lastActivity > KEEP_EXITED_MS) {
      terminals.delete(t.id);
      forget(t.id);
    }
  }
  return reaped;
}

/** Sweep on a timer. Unref'd, so it never holds the daemon open on its own. */
export function startTerminalReaper(cfg) {
  const timer = setInterval(() => reapTerminals(cfg), 60000);
  timer.unref?.();
  return timer;
}

/**
 * Kill every pty, for shutdown. A pty outliving the daemon has nothing to talk to.
 *
 * The kill is unchanged; what changed is that it is no longer the end of the
 * conversation. Each record is written down first, still marked as running, and the
 * flag stops the exit handler that follows from overwriting it with `exited` — so the
 * next boot offers to resume rather than reporting that everything ended at 4am.
 */
/**
 * Stop a terminal's pty without ending its conversation.
 *
 * The admin screen's pause-all needs a third verb. `closeTerminal` means "I am
 * finished with this" and is recorded as `exited`, which the next boot deliberately
 * never offers to resume — right for the ✕ on the terminal itself, wrong for a pause
 * whose entire promise is that resuming brings the same session back.
 *
 * So this is `shutdownTerminals` for one terminal, with the daemon staying up: the
 * record is written down while it still says `live`, the flag stops the exit handler
 * from overwriting that with `exited`, and the in-memory record lands on `resumable`
 * — the same state a restart would have left it in, reached without one.
 *
 * SIGTERM rather than the shutdown path's SIGKILL: nothing is racing a dying daemon
 * here, so `claude` gets its chance to write its own session file, which is what
 * `--resume` reads on the way back.
 */
export function suspendTerminal(id) {
  const t = getTerminal(id);
  if (!t) return false;
  if (t.status !== 'live' || !t.child) return t.status === 'resumable';
  t.suspending = true;
  persist(t);
  closeTerminal(t.id, { signal: 'SIGTERM' });
  return true;
}

export function shutdownTerminals() {
  shuttingDown = true;
  for (const t of terminals.values()) {
    if (t.status !== 'live') continue;
    persist(t);
    closeTerminal(t.id, { signal: 'SIGKILL' });
  }
}
