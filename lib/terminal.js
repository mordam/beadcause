import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSessionDir, permissionFlag } from './session.js';

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

/** Live and recently-exited terminals, by id. */
const terminals = new Map();

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
function commandFor(cfg, slaveFile, promptFile) {
  const claude = `claude${permissionFlag(cfg.terminalPermissionMode, 'terminalPermissionMode')}`;
  const relay = `exec ${shq(EXPECT)} ${shq(RELAY)} ${shq(slaveFile)}`;
  if (!promptFile) return `${relay} ${claude}`;
  // Read and delete before exec, so the brief is off disk the moment it is in argv.
  return `P="$(cat ${shq(promptFile)})" && rm -f ${shq(promptFile)} && ${relay} ${claude} "$P"`;
}

/**
 * Open a terminal on a workspace.
 *
 * The directory is resolved by `resolveSessionDir` and by nothing else — the same
 * guard `POST /api/session` and the bead console apply. `~/.zshenv` derives
 * `BEADS_DIR`, `BEADS_ACTOR` and `CLAUDE_CONFIG_DIR` from `$PWD`, so where this
 * process starts is what decides which tracker it writes to and which account it
 * bills. A terminal that came up in the wrong directory would be a session quietly
 * doing work against the wrong project, which is the failure this whole convention
 * exists to prevent.
 */
export function openTerminal(cfg, workspace, { prompt = null, bead = null, cols, rows } = {}) {
  const live = listTerminals().filter((t) => t.status === 'live');
  if (live.length >= maxTerminals(cfg)) {
    throw Object.assign(
      new Error(`${live.length} terminals are already open (terminalMax is ${maxTerminals(cfg)}) — close one first`),
      { status: 429 }
    );
  }

  const dir = resolveSessionDir(cfg, workspace);
  const id = crypto.randomBytes(8).toString('hex');
  const slaveFile = path.join(os.tmpdir(), `beadcause-pty-${id}`);

  let promptFile = null;
  if (prompt) {
    promptFile = path.join(os.tmpdir(), `beadcause-term-${id}.md`);
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  }

  const t = {
    id,
    workspace: workspace.name,
    dir,
    bead: bead ? { id: bead.id, title: bead.title || '' } : null,
    cols: dim(cols, 80, 500),
    rows: dim(rows, 24, 200),
    status: 'live',
    exitCode: null,
    exitSignal: null,
    startedAt: iso(),
    endedAt: null,
    lastActivity: now(),
    // Scrollback: whole chunks, capped in bytes. See append().
    buf: [],
    bytes: 0,
    cap: scrollbackBytes(cfg),
    truncated: false,
    // Where the pty's slave device name lands, so we can resize it from outside.
    slaveFile,
    slave: null,
    listeners: new Set(),
    clients: 0,
    child: null,
  };

  const command = commandFor(cfg, slaveFile, promptFile);
  const child = spawn('/bin/zsh', ['-lc', command], {
    cwd: dir,
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
    t.status = 'exited';
    t.exitCode = code;
    t.exitSignal = signal;
    t.endedAt = iso();
    t.lastActivity = now();
    fs.rmSync(slaveFile, { force: true });
    if (promptFile) fs.rmSync(promptFile, { force: true });
    out(Buffer.from(`\r\n[2m[beadcause] session ended${signal ? ` (${signal})` : code ? ` (exit ${code})` : ''}[0m\r\n`));
    for (const fn of t.listeners) {
      try {
        fn(null, { type: 'exit', code, signal });
      } catch {
        /* same as above */
      }
    }
    console.log(`[beadcause] terminal ${id} ended (${signal || `exit ${code}`})`);
  });

  terminals.set(id, t);
  // The slave name only exists once expect has spawned, so poll briefly for it
  // rather than making the caller wait on it. Resize simply does not work until it
  // lands, which is a few milliseconds and long before anyone can rotate a phone.
  pollForSlave(t);
  console.log(`[beadcause] terminal ${id} opened on ${workspace.name}${bead ? ` from ${bead.id}` : ''} in ${dir}`);
  return t;
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
    if (t.status === 'live') {
      if (t.clients > 0) continue;
      if (now() - t.lastActivity < cutoff) continue;
      console.log(`[beadcause] terminal ${t.id} reaped — idle and unwatched for ${Math.round(cutoff / 60000)} min`);
      closeTerminal(t.id);
      reaped += 1;
    } else if (t.endedAt && now() - t.lastActivity > KEEP_EXITED_MS) {
      terminals.delete(t.id);
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

/** Kill everything, for shutdown. A pty outliving the daemon has nothing to talk to. */
export function shutdownTerminals() {
  for (const t of terminals.values()) if (t.status === 'live') closeTerminal(t.id, { signal: 'SIGKILL' });
}
