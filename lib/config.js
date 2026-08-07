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
    // Commenting without answering dispatches an unattended `claude -p` to reply.
    // Without this, `human-replied` is only a passive flag — it waits for an agent
    // session to come looking, and if none ever does the comment is never answered.
    autoDispatch: true,
    // Workspaces that never auto-dispatch. Put any *shared* tracker here: an
    // unattended agent commenting on a graph your team also reads is visible to
    // everyone, which is a different bar than talking to yourself.
    autoDispatchExclude: ['climative'],
    autoDispatchTimeoutMs: 600000,
    // Absolute paths that /api/asset is allowed to read images from.
    // Add the directory your code lives in — a question can only show you an image
    // or a document that sits under one of these.
    assetRoots: [path.join(os.homedir(), 'beads')],
    pollSeconds: 30,
    ntfy: {
      enabled: true,
      server: 'https://ntfy.sh',
      topic: `beadcause-${crypto.randomBytes(9).toString('base64url').toLowerCase()}`,
      // "full" puts the question and its option buttons in the notification.
      // "minimal" sends a contentless nudge you tap through to the tailnet — the
      // right setting for anything you would not post on a public ntfy.sh topic.
      detail: 'full',
      // Workspaces forced to "minimal" regardless. Work questions default here,
      // because ntfy.sh topics are readable by anyone who guesses the name.
      minimalWorkspaces: ['climative'],
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
