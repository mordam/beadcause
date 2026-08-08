import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const CONFIG_DIR =
  process.env.BEADCAUSE_CONFIG_DIR || path.join(os.homedir(), '.config', 'beadcause');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const STATE_PATH = path.join(CONFIG_DIR, 'state.json');

const BD_CANDIDATES = ['/opt/homebrew/bin/bd', '/usr/local/bin/bd', '/usr/bin/bd'];

function findBd() {
  for (const p of BD_CANDIDATES) if (fs.existsSync(p)) return p;
  try {
    return execFileSync('/usr/bin/which', ['bd'], { encoding: 'utf8' }).trim();
  } catch {
    return 'bd';
  }
}

/** Every ~/beads/<name>/.beads workspace, in alphabetical order. */
function discoverWorkspaces() {
  const root = path.join(os.homedir(), 'beads');
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, dir: path.join(root, name, '.beads') }))
    .filter((w) => fs.existsSync(w.dir))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The machine's Tailscale IPv4, so the phone gets a URL that works off-LAN. */
export function tailscaleIp() {
  for (const bin of ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    if (!fs.existsSync(bin)) continue;
    try {
      const out = execFileSync(bin, ['ip', '-4'], { encoding: 'utf8', timeout: 5000 }).trim();
      const ip = out.split('\n')[0].trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch {
      /* tailscale down — fall through */
    }
  }
  return null;
}

function defaults() {
  const ip = tailscaleIp();
  const port = 4318;
  return {
    port,
    // Extra address to listen on besides 127.0.0.1. The Tailscale IP keeps the
    // server off every other interface — no LAN or public exposure.
    host: ip || '127.0.0.1',
    baseUrl: `http://${ip || '127.0.0.1'}:${port}`,
    bdBin: findBd(),
    actor: 'beadcause',
    // Mirror agent progress into beads as `agent:<phase>` state labels. Off by
    // default: `bd set-state` writes an event bead per change, which inflates the
    // issue's dependent count ("blocks 7") and clutters the graph with churn that
    // is obsolete within seconds. Progress lives in status.json instead.
    mirrorStateToBeads: false,
    // Only turn on if you actually run `bd dolt start`. The workspaces pin
    // dolt_mode="embedded", and forcing shared mode without a live server makes
    // every bd call fail. Left off, writes just retry through the Dolt lock.
    sharedServer: false,
    // Shared secret. Required on every /api/* call: the phone stores it after the
    // first visit, ntfy action buttons send it as a header.
    token: crypto.randomBytes(24).toString('base64url'),
    workspaces: discoverWorkspaces(),
    // Let the phone open a Claude session on the Mac (POST /api/session). This is
    // the only endpoint that starts a process rather than running `bd`, so it gets
    // its own off switch.
    openSessions: true,
    // Override where a workspace's session opens. Normally unnecessary: the
    // directory is derived from the same rule ~/.zshenv uses, so the shell picks up
    // the right BEADS_DIR and Claude account on its own. Set an entry here only if
    // a workspace has no matching directory under `projectRoot`.
    sessionDirs: {},
    // Set this only if your shell derives BEADS_DIR from the working directory
    // (a `chpwd` hook mapping `<projectRoot>/<repo>` → `~/beads/<repo>`). When set,
    // a session opens in the matching checkout and beadcause verifies a shell there
    // really would resolve back to the same workspace. Left null — the default —
    // sessions open in `~/beads/<workspace>`, where `bd` finds `.beads` on its own.
    projectRoot: null,
    // Workspace a shell OUTSIDE projectRoot resolves to, if yours has one.
    fallbackWorkspace: null,
    // Permission mode for a session opened from the phone. `auto` because you are
    // by definition not at the keyboard — a session that halts on the first
    // permission prompt defeats the button. One of: auto, acceptEdits, manual,
    // dontAsk, plan, bypassPermissions. Set null to launch `claude` with no flag
    // and inherit whatever your settings default to.
    sessionPermissionMode: 'auto',
    // The bead console: a chat where you work out what to file, and beadcause
    // creates it only once you have reviewed and edited the proposal. Like
    // `openSessions` it starts a `claude` process, so it gets its own off switch —
    // though unlike that one it stays headless, with a read-only allowlist, and
    // writes nothing to the tracker except through the button you press.
    beadConsole: true,
    // Model for a console turn. Null inherits whatever `claude` would use on its
    // own, which is almost always what you want; set it to `sonnet` if you would
    // rather trade some judgement for a cheaper conversation.
    consoleModel: null,
    // Kill a console turn that has been going this long. Generous, because a turn
    // may be reading half a repo before it answers.
    consoleTimeoutMs: 900000,
    // Commenting without answering dispatches an unattended `claude -p` to reply.
    // Without this, `human-replied` is only a passive flag — it waits for an agent
    // session to come looking, and if none ever does the comment is never answered.
    autoDispatch: true,
    // Workspaces that never auto-dispatch. Put any *shared* tracker here: an
    // unattended agent commenting on a graph your team also reads is visible to
    // everyone, which is a different bar than talking to yourself. `npm run
    // configure` asks which of yours are shared.
    autoDispatchExclude: [],
    autoDispatchTimeoutMs: 600000,
    // An agent per repo whose only interest is that repo's queue reaching zero —
    // see lib/advocate.js. `workspaces` is an explicit opt-in list ("*" for every
    // one) and is EMPTY by default: an advocate opens Claude sessions on your Mac
    // without being asked, and nobody installing this should discover that as a
    // surprise. Everything else below only matters once a repo is named.
    advocates: {
      enabled: true,
      // Which repos get one. [] means none; ["*"] means every configured workspace.
      workspaces: [],
      // Sessions ONE advocate may have open at once, clamped to maxWorkersLimit.
      // Per-repo overrides go in perWorkspace: { sophab: { maxWorkers: 2 } }.
      maxWorkers: 1,
      maxWorkersLimit: 3,
      // Across every advocate, so four repos each allowed 3 can't open twelve
      // windows. When this is what stops a launch, it says so rather than looking
      // like an advocate with nothing to do.
      globalMaxWorkers: 3,
      perWorkspace: {},
      // Beads with a priority above this don't count as work. P4 is a backlog —
      // a list of things deliberately not being done — so the queue can reach zero.
      minPriority: 3,
      // How long a newly-ready bead sits before a session is opened on it. A bead
      // is often still being written a few seconds after it appears.
      settleSeconds: 60,
      launchCooldownSeconds: 120,
      // A window opened on a bead that never claimed it, and left no process
      // behind, is treated as closed by hand after this — the slot is freed and
      // the bead costs an attempt.
      lapseMinutes: 10,
      workerTimeoutMinutes: 120,
      maxAttemptsPerBead: 2,
      // A quiet space's advocate watches without launching, the same asymmetry the
      // notifications keep: quiet means "don't act on my evening", not "hide it".
      respectQuietHours: true,
      // Ask to create beads when the queue is empty. NOTHING is created without
      // your approval — the ask arrives as an ordinary question carrying the full
      // text of every bead it wants. See lib/proposal.js.
      propose: true,
      // Keep each finished session's log in the repo itself, on
      // refs/beadcause/sessions/<bead>, with a git note on the commits it made and
      // on the merge that landed them — see lib/sessionlog.js. Nothing is pushed
      // unless you name the refs.
      sessionLog: true,
      // Also store the raw Claude Code transcript (megabytes, and it carries
      // absolute paths and whatever tool output scrolled past). Off by default; set
      // per repo in perWorkspace if you want it somewhere private.
      sessionTranscripts: false,
      proposeCooldownHours: 12,
      maxProposals: 5,
      proposeTimeoutMs: 600000,
    },
    // Groups of workspaces that share a notification policy — see lib/spaces.js.
    // Empty means no grouping, and the phone shows a flat workspace filter as before.
    // A space can be muted outright, or quiet on given hours/days, which is usually
    // what "keep work separate from personal" actually means.
    spaces: [],
    // Read ~/.claude/sessions for the current-sessions page — one record per running
    // Claude Code process, which is the only place a session that has claimed no
    // bead shows up at all. See lib/claude.js. Best-effort: no such directory is not
    // an error, it just means that page is made only of beads. `claudeSessionsDir`
    // overrides where to look ($CLAUDE_CONFIG_DIR/sessions, else ~/.claude/sessions).
    claudeSessions: true,
    // Absolute paths that /api/asset is allowed to read images from.
    // Add the directory your code lives in — a question can only show you an image
    // or a document that sits under one of these.
    assetRoots: [path.join(os.homedir(), 'beads')],
    pollSeconds: 30,
    // A live terminal view of what the daemon is doing (bin/monitor.js). `enabled`
    // only controls whether `npm run install-service` generates a *second*
    // LaunchAgent that opens the window at login — `npm run monitor` works either
    // way. Off by default: nobody installing this for the first time should find a
    // terminal window opening itself every time they log in.
    monitor: {
      enabled: false,
    },
    ntfy: {
      enabled: true,
      server: 'https://ntfy.sh',
      topic: `beadcause-${crypto.randomBytes(9).toString('base64url').toLowerCase()}`,
      // "full" puts the question and its option buttons in the notification.
      // "minimal" sends a contentless nudge you tap through to the tailnet — the
      // right setting for anything you would not post on a public ntfy.sh topic.
      detail: 'full',
      // Workspaces forced to "minimal" regardless, because an ntfy.sh topic is
      // readable by anyone who guesses its name. Anything shared or confidential
      // belongs here; `npm run configure` asks.
      minimalWorkspaces: [],
      // Answer straight from the notification. ntfy allows at most 3 action buttons.
      actionButtons: true,
    },
  };
}

export function loadConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  let cfg;
  if (fs.existsSync(CONFIG_PATH)) {
    cfg = { ...defaults(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    cfg.ntfy = { ...defaults().ntfy, ...(cfg.ntfy || {}) };
    cfg.monitor = { ...defaults().monitor, ...(cfg.monitor || {}) };
    // Same one-level merge, and for the same reason: a config written before a
    // setting existed must not lose the default for it. It matters more here —
    // an absent `maxWorkersLimit` would leave the clamp with nothing to clamp to.
    cfg.advocates = { ...defaults().advocates, ...(cfg.advocates || {}) };
  } else {
    cfg = defaults();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    console.log(`[beadcause] wrote fresh config to ${CONFIG_PATH}`);
  }
  cfg.workspaces = reconcileWorkspaces(cfg.workspaces, cfg);
  return cfg;
}

/**
 * Keep the saved workspace list honest against what's actually on disk.
 *
 * The list is persisted so it can be hand-edited, and that is exactly how it rots.
 * Observed for real: renaming a `~/beads/<name>` directory left a saved entry
 * pointing at a path that no longer existed. Every poll then logged an ENOENT for
 * it and that whole workspace — seven open questions, one of them P0 — silently
 * stopped reaching the phone. Nothing surfaced it, because a workspace that throws
 * is already treated as "no questions here".
 *
 * So: drop what's gone, pick up what's new, say so out loud, and write it back once
 * so the next rename is a one-line log rather than a week of missing questions.
 */
function reconcileWorkspaces(saved, cfg) {
  const discovered = discoverWorkspaces();
  const live = (saved || []).filter((w) => w?.dir && fs.existsSync(w.dir));
  const gone = (saved || []).filter((w) => !live.includes(w));
  const added = discovered.filter((d) => !live.some((w) => w.dir === d.dir));

  for (const w of gone) console.warn(`[beadcause] dropping workspace ${w.name} — ${w.dir} no longer exists`);
  for (const w of added) console.log(`[beadcause] adding workspace ${w.name} — ${w.dir}`);

  const merged = [...live, ...added].sort((a, b) => a.name.localeCompare(b.name));
  if ((gone.length || added.length) && cfg) {
    saveConfig({ ...cfg, workspaces: merged });
  }
  return merged.length ? merged : discovered;
}

export function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { notified: [] };
  }
}

export function saveState(state) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
