import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeJsonAtomic } from './atomic.js';
// Circular on purpose and safe: lib/commonrepo.js reads CONFIG_DIR through a
// function rather than at module load, so neither half needs the other to have
// finished evaluating. The alternative — a second copy of the `~/.config/beadcause`
// path — is the one that goes wrong, quietly, when BEADCAUSE_CONFIG_DIR is set.
import { snapshot } from './commonrepo.js';
// Circular for the same reason and in the same shape: `detectOwner` is called from
// `defaults()` below, never while this module is being evaluated.
import { detectOwner } from './owner.js';

export const CONFIG_DIR =
  process.env.BEADCAUSE_CONFIG_DIR || path.join(os.homedir(), '.config', 'beadcause');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const STATE_PATH = path.join(CONFIG_DIR, 'state.json');

/**
 * Observer mode — a second instance that watches and never acts.
 *
 * `BEADCAUSE_CONFIG_DIR` isolates the config, the state file and the token, and
 * that is all it isolates. The tracker, the repos and the worktree tree belong to
 * the machine, not to the config directory, so a second daemon booted on a spare
 * port to look at the UI is a *fully live* daemon. Observed for real: thirty
 * seconds after such an instance started, its first tick had opened two Claude
 * sessions in two repos and swept a worktree in the shared checkout. Nothing was
 * broken — it did exactly what the live one does. There was simply no way to say
 * "watch, don't act".
 *
 * This is that way. Set it and every autonomous act is off:
 *
 *   - no advocate opens a session (it still surveys, so the queue is still on screen)
 *   - no bead proposals
 *   - no worktree sweeps, and no session logs written to git refs
 *   - no unattended reply agent dispatched to a comment
 *   - no ntfy push, so the live instance's notifications stay unambiguous
 *   - `POST /api/session` is refused: a button whose consequence is an hour of
 *     unattended agent in a shared checkout belongs on this side of the line
 *
 * What still works is everything you sit in front of — the terminal, the bead
 * console, answering a question — because that is what a spare-port instance is
 * booted to try, and a mode that broke it would simply not get used. The *tracker*
 * is still shared either way: a bead you create from the console of an observer
 * instance is a real bead.
 *
 * Nothing here is written to the config file. The switches stay exactly as you
 * configured them; the mode is asked about at each point where the daemon would
 * otherwise act, so it can never leak into the live instance's config.
 *
 * `BEADCAUSE_READONLY` is accepted as the same thing. Not for elegance — because
 * an env var you get *wrong* fails silently by opening windows, and that is the one
 * failure this flag exists to prevent.
 */
export const OBSERVING = ['BEADCAUSE_OBSERVE', 'BEADCAUSE_READONLY'].some((k) => {
  const v = process.env[k];
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
});

/** Said in one voice everywhere something is refused because of it. */
export const OBSERVING_NOTE = 'observing — this instance never acts on its own';

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
    // What the app calls you. Every unattended agent is told whose queue it is
    // working, who approves a bead before it exists, and who a pull request is
    // waiting on — so this name goes into prompts, pull request bodies and the notes
    // that land on a bead. Guessed from your git identity and asked for by
    // `npm run configure`; see lib/owner.js.
    owner: detectOwner(),
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
    // The chat session: a chat where you work out what to file, and beadcause
    // creates it only once you have reviewed and edited the proposal. Like
    // `openSessions` it starts a `claude` process, so it gets its own off switch —
    // though unlike that one it stays headless, with a read-only allowlist, and
    // writes nothing to the tracker except through the button you press.
    beadConsole: true,
    // Model for a chat-session turn. Null inherits whatever `claude` would use on its
    // own, which is almost always what you want; set it to `sonnet` if you would
    // rather trade some judgement for a cheaper conversation.
    consoleModel: null,
    // Kill a chat-session turn that has been going this long. Generous, because a turn
    // may be reading half a repo before it answers.
    consoleTimeoutMs: 900000,
    // The in-app terminal: a real Claude Code TUI on a pty, driven from the phone
    // over a WebSocket. On by default for the same reason `openSessions` is — the
    // things that gate it are the tailnet and the token, and both already gate
    // `POST /api/session`, which starts an *unattended* agent on this Mac. This one
    // does nothing you did not just type. Set false if you would rather the phone
    // could only read and answer.
    terminal: true,
    // `--permission-mode` for a terminal. Null — inherit whatever your settings
    // default to — because unlike a session opened from the phone to run by itself,
    // you are sitting in front of this one; the prompts are the point, and `auto`
    // here would mean tapping a button that silently skips them.
    terminalPermissionMode: null,
    // Close a terminal that has been running with nobody watching it for this long.
    // The clock only runs while no socket is attached: a session you are watching
    // is never reaped for being quiet, because quiet is what one looks like while
    // it reads a repo.
    terminalIdleMinutes: 30,
    // Scrollback kept per terminal, so a phone that locked its screen can reconnect
    // and see what it missed. Bytes, not lines — it is a pty, and the difference
    // between the two is a screenful of escape sequences.
    terminalScrollbackBytes: 262144,
    // How many may be open at once. Each is a full Claude Code process.
    terminalMax: 4,
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
    // How finished work gets in: a branch, a pull request, and — unless the merge is
    // refused — the worker's own `gh pr merge`. See lib/delivery.js and bin/deliver.js.
    //
    // On by default and it needs no configuration, because it configures itself out
    // of the way: a workspace with no `gh`, or a checkout with no GitHub remote, is
    // simply told the older ending — work the bead, close the bead — and everything
    // else carries on. There is nothing to switch on per repo, and nothing that
    // breaks in a repo that cannot use it.
    pr: {
      // `false` puts every workspace back on the old ending, everywhere. The escape
      // hatch for "GitHub is down" or "not today"; not something to leave off.
      enabled: true,
      // What a PR is opened against, and what merging squashes into.
      base: 'main',
      // squash | merge | rebase. Squash because a session's branch is thirty
      // commits of an agent thinking out loud, and main should carry the conclusion.
      mergeMethod: 'squash',
      // Does a worker land its own work, or ask first?
      //
      // On: `beadcause-deliver` pushes the branch, opens the pull request, waits for
      // its checks, merges it, and closes the bead. Off: it stops after opening the
      // PR and files the question whose answer is the merge, which is what every
      // delivery did before this existed.
      //
      // The reason it is on is arithmetic. Every delivery was a question, so the
      // queue's throughput was capped by how often Adam looked at his phone — work
      // finished at three in the morning sat unmerged until breakfast, and the next
      // bead that touched the same file started from a main that did not have it.
      // The reason it is a switch is that the argument against it is also real:
      // nothing reviews the diff before it is in. What makes that bearable is not
      // this flag but the two things underneath it — GitHub serialises the merges, so
      // concurrent workers cannot race each other into main, and a merge GitHub
      // refuses for any reason at all falls back to the question, unchanged.
      autoMerge: true,
      // How long a worker waits for its pull request's checks before giving up on
      // merging it. A PR is at its most pending the second after it is opened, so
      // without a wait a repo with CI would fall back to the question every time; and
      // a queue that has not reported in five minutes is a fact about CI, not a
      // licence to merge over it. Five minutes, then it asks.
      mergeWaitMs: 300000,
      // Sweep a worktree once its PR has merged, rather than waiting for the branch
      // to become an ancestor of main — which a squash-merge never makes it.
      tidyMerged: true,
    },
    // What "deploy this repo" actually is — per repo, and EMPTY by default.
    //
    // The one act after a merge the daemon could not do at all until now (lib/deploy.js),
    // and the one it must never infer. beadcause restarts under launchd, sophab runs
    // `fly deploy`, the next repo will do something else; no shape those share could be
    // read off a checkout, and a daemon that guessed would guess at three in the morning
    // in a repo nobody was watching. A workspace with no entry stays what lib/prboard.js
    // already calls it: a repo with no deploy beadcause can see.
    //
    // Each entry is argv and never a shell line — this file is hand-edited, rewritten by
    // `saveConfig` and synced by lib/commonrepo.js, and a string here would make every
    // one of those a place a metacharacter can change what runs. `{uid}`, `{home}`,
    // `{dir}` and `{base}` are substituted; nothing else is.
    //
    //   "deploys": {
    //     "beadcause": {
    //       "command": ["launchctl", "kickstart", "-k", "gui/{uid}/m4m.beadcause"],
    //       "restarts": true,
    //       "rebuild": [{ "label": "apk", "when": ["android"], "command": ["npm", "run", "android"] }]
    //     },
    //     "sophab": { "command": ["fly", "deploy"] }
    //   }
    //
    // `restarts` says this deploy kills beadcause itself, which changes only how an
    // interrupted deploy is *read* — see the sweep in lib/deploy.js. `pull` (default
    // true) fast-forwards the checkout to `origin/<base>` first, so what goes live is
    // the merged tree, and refuses outright over uncommitted work.
    deploys: {},
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
      // How long a session asked to check in has to answer before its slot goes back.
      // Long enough for a turn in flight to land and run the command; short enough
      // that pressing Reclaim sessions is worth doing at all.
      checkinMinutes: 10,
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
    // Extra reply agents, on top of the four built into lib/agents.js. Each is a
    // name and a foundation — a paragraph that goes in front of the standard thread
    // instructions — and you pick which one answers when you comment. `tools` and
    // `model` are honoured here but deliberately cannot be set from the phone: an
    // agent created on a lock screen must never be able to grant itself more reach
    // than the one before it.
    agents: [],
    defaultAgent: 'answerer',
    // Groups of workspaces that share a notification policy — see lib/spaces.js.
    // Empty means no grouping, and the phone shows a flat workspace filter as before.
    // A space can be muted outright, or quiet on given hours/days, which is usually
    // what "keep work separate from personal" actually means.
    spaces: [],
    // Read ~/.claude/sessions for the current-sessions page — one record per running
    // Claude Code process, which is the only place a session that has claimed no
    // bead shows up at all. See lib/claude.js. Best-effort: no such directory is not
    // an error, it just means that page is made only of beads. `claudeSessionsDir`
    // overrides where to look ($CLAUDE_CONFIG_DIR/sessions, else ~/.claude/sessions),
    // and `claudeProjectsDir` does the same for the transcripts those sessions write
    // (lib/transcript.js). This one switch governs both: with it off, the page reads
    // no session records and serves no transcripts.
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
    // And again for PR delivery, which every config written before it existed is
    // missing entirely — without the merge those all read as `pr.enabled === undefined`
    // and the branch that checks `=== false` would be right by luck rather than by
    // construction, while `base` and `mergeMethod` would be undefined at the CLI.
    cfg.pr = { ...defaults().pr, ...(cfg.pr || {}) };
  } else {
    cfg = defaults();
    writeJsonAtomic(CONFIG_PATH, cfg);
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
  writeJsonAtomic(CONFIG_PATH, cfg);
  snapshot('config');
}

/**
 * The shape state.json is guaranteed to have, whatever is actually on disk.
 *
 * A fresh object every call, never a shared constant: these are handed straight to
 * callers who mutate them, and one shared `notified` array would be appended to by
 * every reader in the process.
 */
// `dismissed` is keyed `workspace/id`: the cards you have set aside, and what has
// to change before each comes back. It lives here rather than on the bead because
// dismissing is an inbox act, not a tracker one — see `withoutDismissed`.
// `ringing` is keyed the same way: the beads whose notification this daemon actually
// caused and has not cancelled, so a filter change can offer to clear the ones it has
// just decided to stop showing you. `ringingDeclined` is what you said "leave them"
// about, and `shadeSeen` is when a client that owns a shade last polled — without one
// there is nothing to clear. See lib/ringing.js for all three.
// `answered` is keyed the same way once more: what you said the last time this bead
// was a question, kept so a bead reopened after its answer comes back to the inbox
// showing that answer rather than as a card you have never seen. See lib/answered.js.
const stateDefaults = () => ({
  notified: [],
  commentCounts: {},
  dismissed: {},
  filter: { space: 'all', workspace: 'all' },
  ringing: {},
  ringingDeclined: [],
  shadeSeen: null,
  answered: {},
});

/**
 * Read state, defaulted.
 *
 * The fallback used to be `{ notified: [] }`, which meant every other field arrived
 * `undefined` on an unreadable file and each caller invented its own default. The
 * filter in particular has to come back as "all/all" — a filter that reads as empty
 * rather than absent hides every bead in the inbox and gives no clue why.
 */
export function loadState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    raw = {};
  }
  if (!raw || typeof raw !== 'object') raw = {};
  const base = stateDefaults();
  return {
    ...base,
    ...raw,
    // Normalised field by field rather than spread, because a spread of a
    // half-written `{ filter: { space } }` would leave `workspace` undefined and put
    // the "empty list, no explanation" failure back.
    filter: {
      space: typeof raw.filter?.space === 'string' ? raw.filter.space : base.filter.space,
      workspace: typeof raw.filter?.workspace === 'string' ? raw.filter.workspace : base.filter.workspace,
    },
    // Same reasoning as the filter: a half-written or wrong-shaped value here would
    // hide cards with no way to find out why, so anything that is not an object
    // reads as "nothing dismissed" rather than throwing or hiding everything.
    dismissed: raw.dismissed && typeof raw.dismissed === 'object' && !Array.isArray(raw.dismissed) ? raw.dismissed : {},
    // And the same again for the shade bookkeeping. The failure to avoid here is the
    // opposite one — a wrong shape must read as "nothing is ringing", so a junk file
    // costs a prompt that never appears rather than one that offers to clear beads it
    // knows nothing about.
    ringing: raw.ringing && typeof raw.ringing === 'object' && !Array.isArray(raw.ringing) ? raw.ringing : {},
    ringingDeclined: Array.isArray(raw.ringingDeclined) ? raw.ringingDeclined.filter((k) => typeof k === 'string') : [],
    shadeSeen: typeof raw.shadeSeen === 'string' ? raw.shadeSeen : null,
    // And once more for the answers already given — see lib/answered.js. The failure
    // to keep out is a card asserting you said something you did not, so anything
    // that is not a plain object reads as "nothing has been answered yet".
    answered: raw.answered && typeof raw.answered === 'object' && !Array.isArray(raw.answered) ? raw.answered : {},
  };
}

/**
 * Merge `patch` into what is on disk. **Not** a wholesale write.
 *
 * Four call sites in lib/server.js each save `{ notified, commentCounts }` — the
 * poll's own two fields — and before this they replaced the file, so any other key
 * was dropped by whichever writer ran next. That was survivable while the poll owned
 * every field in the file; it stops being survivable the moment a client writes one
 * too, because the filter would vanish on the next sweep.
 *
 * Read-modify-write, so it is still last-writer-wins per key between processes. That
 * is enough here: one daemon owns this file, and the atomic write keeps a reader from
 * ever seeing a half-file.
 */
export function saveState(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeJsonAtomic(STATE_PATH, { ...loadState(), ...patch });
  snapshot('state');
}
