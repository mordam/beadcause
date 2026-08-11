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
// And again, through lib/auth.js — which imports CONFIG_DIR from here and reads it only
// inside functions, so neither half needs the other to have finished evaluating.
// `absorbClientSecret` is called from `loadConfig()`, and it lives over there because
// the knowledge it needs is auth's: where the secret is read from, and why that file is
// named so the snapshotter in lib/commonrepo.js refuses it.
import { absorbClientSecret } from './auth.js';
// And once more, for the same reason again. `baseUrl` is the URL a phone is handed,
// and whether that can be `https://<name>` is a question about certificates, which
// lib/tls.js owns. `publicBaseUrl` is called from `defaults()` and from
// `reconcileBaseUrl()`, both of which run long after both modules have evaluated.
import { publicBaseUrl } from './tls.js';

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

const TAILSCALE_CANDIDATES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

/**
 * The `tailscale` CLI, or null. Absolute paths and no PATH lookup on purpose: this is
 * called from a launchd agent, whose PATH is not yours.
 *
 * `BEADCAUSE_TAILSCALE` overrides the list, and has to exist to count — a path that was
 * typed wrong should read as "no tailscale" rather than as a command that fails
 * mysteriously later. It is what lets `test/certrenew.mjs` exercise the renewal against
 * a certificate authority it made up, instead of asking Let's Encrypt for a real one
 * every time somebody runs the suite; the candidate list is also macOS-only, so it is
 * the answer for an install that put the binary anywhere else.
 */
export function tailscaleBin() {
  const named = process.env.BEADCAUSE_TAILSCALE;
  if (named) return fs.existsSync(named) ? named : null;
  return TAILSCALE_CANDIDATES.find((bin) => fs.existsSync(bin)) || null;
}

/** The machine's Tailscale IPv4, so the phone gets a URL that works off-LAN. */
export function tailscaleIp() {
  for (const bin of TAILSCALE_CANDIDATES) {
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
    // The *address* is what we bind; the *name* is what we hand out. They differ on
    // purpose — no authority will sign `100.x.y.z`, so the certificate is for the
    // MagicDNS name, and a URL naming the address could never be an https one. See
    // `publicBaseUrl`, which falls back to this address when there is no certificate
    // to serve, and `reconcileBaseUrl`, which moves a saved one across once there is.
    baseUrl: publicBaseUrl({ port }),
    bdBin: findBd(),
    // How long bin/router.js waits for a *first* attempt at a backend to answer, in ms.
    //
    // A starting point, not a limit: the router doubles it per attempt and remembers
    // how slow this machine has been proving to be, because a backend that binds in two
    // seconds on an idle Mac took longer than twenty on one running ten agent sessions.
    // Lower it only in a test that needs the slow-start path to be reachable on demand;
    // raising it here is rarely the answer, since the scaling already does that.
    healthTimeoutMs: 20000,
    // HTTPS on the tailnet address, terminated in the daemon — see lib/tls.js.
    //
    // On, because everything it unlocks is a browser feature that is simply absent
    // over plain http (service workers off loopback, the microphone, Google sign-in's
    // redirect URI), and because it cannot break a machine that cannot have it: the
    // certificate comes from `tailscale cert`, and a tailnet without **HTTPS
    // Certificates** enabled just logs why and stays on http.
    //
    // Loopback is never TLS whatever this says: it is where the control plane lives,
    // and 127.0.0.1 is already a secure context. `name` overrides the MagicDNS name
    // if `tailscale status` reports one you do not want a certificate for; null asks.
    // The protocol floor is deliberately not settable — see MIN_VERSION in lib/tls.js.
    tls: {
      enabled: true,
      name: null,
    },
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
    // The second credential, for the one caller that has a face — see lib/auth.js.
    //
    // OFF by default and it stays off until all three of clientId, a secret and a
    // non-empty allowlist are here: a half-configured sign-in would be a login screen
    // nobody can get past, in front of the inbox that tells you why. The token is
    // unaffected either way, and it is what every non-browser caller uses — ntfy
    // action buttons, lib/notify.js, the Android app, scripts/shot.mjs.
    //
    //   "auth": {
    //     "google": {
    //       "clientId": "1234-abc.apps.googleusercontent.com",
    //       "allowed": ["you@gmail.com"]
    //     }
    //   }
    //
    // **The secret is deliberately not a field here.** This file is committed to the git
    // repo lib/commonrepo.js keeps, after every write, so a secret in it is not on disk
    // in the clear — it is in a history no rotation can reach back into. It goes in
    // `~/.config/beadcause/google-client-secret.key`, whose name that repo both ignores
    // and refuses, or in BEADCAUSE_GOOGLE_CLIENT_SECRET, which leaves no copy at all.
    // `clientSecretFile` overrides the path. A `clientSecret` left here by an older
    // version is emptied into that file on load and deleted — see `absorbClientSecret`.
    //
    // `redirectUri` is derived from the tailnet certificate's name and normally left
    // null. Set it only if the callback registered in the Google client differs — and
    // note that sign-in cannot switch on without one, because Google refuses a
    // plain-http callback and a Secure cookie is dropped over plain http anyway.
    auth: {
      google: {
        enabled: true,
        clientId: null,
        clientSecretFile: null,
        allowed: [],
        redirectUri: null,
        sessionDays: 30,
      },
    },
    // Publishing a document to Confluence — see lib/confluence.js and the README.
    //
    // OFF until `site` and `email` are both filled in, and nothing here reads a
    // credential until they are: an install that never wanted this never opens a file
    // and never draws a button. `space` is the Confluence space a document lands in;
    // a beadcause space may name a different one with `confluenceSpace`, or refuse to
    // publish at all with `confluenceSpace: false`.
    //
    // **The API token is deliberately not a field here**, for the same reason the
    // Google client secret is not: this file is committed to the git repo
    // lib/commonrepo.js keeps, after every write, so a token in it is in a history a
    // rotation cannot reach back into. It goes in
    // `~/.config/beadcause/confluence.key` at 0600 — a name that repo both ignores and
    // refuses — or in BEADCAUSE_CONFLUENCE_TOKEN, which leaves no copy at all.
    // `apiTokenFile` overrides the path.
    confluence: {
      site: null,
      email: null,
      space: null,
      apiTokenFile: null,
    },
    workspaces: discoverWorkspaces(),
    // The repos ONE workspace may be worked in — an approved list, keyed by workspace
    // name, and empty by default. See lib/repos.js.
    //
    // Almost every workspace is one repo, and for those this stays absent and costs
    // nothing. The shape it exists for is an org that shares a single tracker across
    // many checkouts: only one Climative repo has beads installed, so forty services
    // file into the same `cl-` graph, and a bead there is not about "climative" — it is
    // about `athena-service`. Each repo declares a short **service token** in its own
    // `config/config.yaml`, and that token is what a bead carries to say which checkout
    // it is about.
    //
    //   "repos": {
    //     "climative": {
    //       "root": "~/climative.dev",
    //       "default": "architecture",
    //       "approved": ["architecture", "athena-service", "building-service"]
    //     }
    //   }
    //
    // **An approved list, deliberately, and never discovery.** `discoverWorkspaces()`
    // above reads a directory and takes what is in it; that is right for `~/beads` and
    // it is the pattern NOT to follow here. An org has repos nobody wants an unattended
    // agent inside, and a directory appearing under the root because somebody told you
    // to clone it must not be enough to make it workable. Nothing ever reads the root —
    // only the entries named in `approved`.
    //
    // **The token is read from the checkout rather than restated here**, so a repo that
    // renames its service says so itself in the commit that renames it. What that costs
    // is that a token can be missing, unreadable, or shared with another repo — all
    // three are named in the startup log (`repoWarnings`) and none is guessed at. In
    // particular a bead whose token cannot be resolved resolves to *nothing*: falling
    // back to `default` there is how work aimed at one service lands in another.
    //
    // `default` is the repo a bead carrying no token belongs to. `tokenPath` and
    // `tokenKey` override where the token is read from, and are rarely needed.
    repos: {},
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
    // Where session windows go, and whether they take the keyboard on the way.
    //
    // A dozen live sessions used to land wherever iTerm cascaded them — across every
    // display, on top of whatever you were typing in. They are dealt onto one screen
    // instead, in a grid of slots with each window wandering a little inside its own
    // slot, so the set reads as cards on a table rather than a stack. See lib/iterm.js
    // for the arithmetic and for the dynamic profile they open with.
    sessionWindows: {
      // false leaves the windows where iTerm puts them, as before. The profile is still
      // written and still used — this switch is about placement only.
      layout: true,
      // Which display: `largest` (the point of a table is room for several readable
      // windows), `main` for the one with the menu bar, or a 0-based index.
      screen: 'largest',
      // A card, in points, and the gap around it inside its slot.
      card: { width: 780, height: 540, gap: 24 },
      // How far a card may wander inside its slot. 0 snaps them to the grid; the slot
      // is what prevents overlap, so this can be raised without cards colliding.
      jitter: 18,
      // Leave the keyboard where it was. iTerm takes focus for a fraction of a second
      // whatever anyone asks — there is no background-window API — so this is focus
      // *returned*, not focus never taken. Set true if you would rather the new window
      // came to you, which is the old behaviour.
      stealFocus: false,
    },
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
    // Do beads an agent files itself (`beadcause-file`) arrive endorsed — that is,
    // workable, queued by an advocate, launchable — instead of held for a tap?
    //
    // `false`, and it is the one policy default here that is deliberately the
    // restrictive one. Everything else in this file defaults to letting the daemon get
    // on with it, because the cost of being wrong is a notification or a merge you
    // would have made anyway; the cost here is an unattended session on work nobody has
    // read, which is the single thing `unendorsed` exists to prevent (lib/endorse.js).
    // So it only ever happens because you asked for it — and the useful place to ask is
    // per space rather than here, on the space details screen: a personal repo where the
    // tap was a formality can say yes while a repo other people read goes on holding.
    // See `autoEndorseAllowed` in lib/spaces.js.
    autoEndorse: false,
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
      // What a PR is opened against, and what merging lands in.
      base: 'main',
      /**
       * squash | merge | rebase — and `merge`, because ancestry is load-bearing here.
       *
       * This was `squash`, on the argument that a session's branch is thirty commits
       * of an agent thinking out loud and main should carry only the conclusion. That
       * argument is right about the log and wrong about the cost, because a squash
       * merge writes a *new* commit with the branch's tree and none of its history —
       * so the branch never becomes an ancestor of anything, and two pieces of
       * worktree cleanup ask exactly that question:
       *
       *   • the `ship` skill's step 8 retirement gate, and
       *   • ~/.claude-personal/skills/ship/prune-retired.sh, which re-checks it
       *     before removing an aged entry and keeps anything that fails with
       *     "NOT merged into main — removing it destroys its only copy".
       *
       * That gate is correct and must not be relaxed: it is the thing that stops the
       * attic sweep destroying the only copy of unmerged work. So a squash-delivered
       * worktree became a permanent attic resident instead — kept forever, however
       * old, over work that shipped last week.
       *
       * `merge` is the way out that needs no gate weakened anywhere. It also matches
       * what this repo has always actually done: every `ship` produces a merge commit,
       * the log is wall-to-wall "Merge branch 'worktree-…'", and when this was first
       * noticed on bc-h2s the merge commit was chosen by hand. And the log stays
       * readable — `git log --first-parent` reads exactly like a squash history, one
       * line per branch, with the thirty commits still there when you want them.
       *
       * `squash` is still supported and still honoured; what it costs is that the
       * attic keeps its worktrees. `lib/tidy.js` covers the daemon's own sweep by
       * asking GitHub whether the PR merged (see `tidyMerged`), but nothing can make
       * an external `--is-ancestor` say yes.
       */
      mergeMethod: 'merge',
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
      // Must a pull request carry an approving review before a worker may merge it?
      //
      // Off, because on a solo repo nobody is going to review it and a worker that
      // waited for one would hand back every delivery it ever made. On, it reads
      // `reviewDecision` off the pull request it just opened — the field lib/pr.js has
      // always fetched and nothing has ever gated on — and anything short of `APPROVED`
      // becomes a merge card rather than a merge, with the checks still green and the
      // card saying which of the two it is waiting on.
      //
      // Like `autoMerge` this is a default a space overrides, and it is the half that
      // makes "other people work in this repo" expressible: see `prPolicyFor` in
      // lib/spaces.js. Answering **Merge** on the card *is* the review — beadcause's
      // gate is the tap, not GitHub's branch protection, which is free to require its
      // own on top and will refuse the merge in its own words if it does.
      requireApproval: false,
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
    // The release queue — what merged and is not running yet. See lib/release.js.
    //
    // It needs no configuration and has none worth setting: the queue itself is derived
    // from the board and the deploy journal, and these two knobs only govern the bead it
    // files per merge. That bead exists because the notification a delivery sends ("still
    // owed: deploy") is gone by morning, and a merge nobody shipped should still be
    // somewhere the next time you look at the tracker.
    release: {
      // File a bead per merged pull request, and close it when a deploy makes it live.
      // `false` leaves the number on the Ship button and stops writing to any tracker.
      // Only ever files in a repo whose deploy beadcause can see the outcome of — a bead
      // nothing could ever close is a chore invented rather than found.
      beads: true,
      // How often the queue is swept. Slow on purpose: it is a `gh pr list` per repo when
      // nobody has looked at the board recently, and its news — "this merged and has not
      // shipped" — keeps for five minutes. The board is cached, so a phone reading /prs
      // makes this sweep free.
      seconds: 300,
    },
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
      // Across every advocate, so six repos each allowed 3 can't open eighteen
      // windows. When this is what stops a launch, it says so rather than looking
      // like an advocate with nothing to do — and it is now a stepper on the console
      // rather than a number you have to stop the daemon to change.
      // `moveGlobalWorkersDefault` below is what carries this to a machine that
      // already stored the old 10.
      globalMaxWorkers: 20,
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
      // Close a work session's window once the session has finished. `claude` is
      // interactive, so a session that has finished goes back to waiting for a human
      // who is not there and the window never ends — and a screen of those is
      // indistinguishable from a screen of sessions that stopped to ask something.
      // Only ever an ending the session *reached* — the bead closed, a pull request
      // delivered, the bead handed back — never one this daemon merely inferred from a
      // window going quiet. Only ever an idle process, and only ever one whose pid
      // Claude Code still reports under that bead's name. See lib/reap.js.
      closeFinishedSessions: true,
      // Between the session finishing and the first signal: the tail of a delivery — the
      // rename, the last message — happens in these seconds.
      closeGraceSeconds: 90,
      // How long SIGTERM gets before SIGKILL, and how long the whole thing gets
      // before it gives up and leaves the window open for you to look at.
      closeHardSeconds: 45,
      closeGiveUpMinutes: 30,
      // The same thing for the windows no advocate is holding a worker for — the ones
      // that were already open before any of this existed, and the ones left by a
      // daemon that was down when a session finished. Nothing else will ever close
      // those: the pid left the slot list, so there is nothing to signal from.
      //
      // It is a wider claim than the setting above — "any session in this repo whose
      // name looks finished" rather than "a window I opened" — so it is its own switch,
      // and it keeps two guards that make the widening safe: the name must *start* with
      // `DONE-`/`done-`, which is a thing only a session writes about itself at the end
      // of its work, and the bead named in that name must be closed. A window of your
      // own, named after a bead you are still working, cannot be reached by this.
      // `closeFinishedSessions: false` switches this off too.
      sweepFinishedWindows: true,
      // How long such a window must have been idle first. Minutes, not seconds: the
      // only evidence here is what the session called itself, and anybody actually
      // reading the window would have touched it inside twenty.
      sweepIdleMinutes: 20,
      // And how often to look. Each candidate window costs a `bd show`, and nothing
      // makes one appear suddenly.
      sweepIntervalMinutes: 5,
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
    // what "keep work separate from personal" actually means. It can also override
    // `autoDispatch`, `autoEndorse`, and the two `pr` answers below — `autoMerge` and
    // `requireApproval` — for every workspace in it.
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
    // JIRA, per workspace. Empty — the default — is every workspace off, and off costs
    // nothing: no network call is made about a workspace that is not named here.
    //
    //   "jira": { "climative": { "enabled": true, "email": "you@company.com" } }
    //
    // Keyed by workspace name, like `sessionDirs` and `advocates.perWorkspace`, and
    // deliberately **not** a field on a `workspaces` entry: that array is discovered
    // and reconciled on every start, so anything written onto it by hand disappears at
    // the next restart. The site URL and the project keys come from that workspace's
    // own `bd config get jira.url` / `jira.projects`, which is already how the tracker
    // reaches JIRA — set `url` / `projects` here only for a workspace whose bd has
    // never been pointed at one.
    //
    // **The API token is deliberately not a field here**, for the same reason
    // `auth.google.clientSecret` is not: this file is committed to the git repo in
    // `~/.config/beadcause` after every write, so a secret in it is in a history no
    // rotation can reach. It goes in `jira-<workspace>.key` in that directory, whose
    // name that repo both ignores and refuses. See lib/jira.js.
    jira: {},
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
    /**
     * The second delivery surface for the same decision — see lib/slack.js.
     *
     * **Off, and it stays off until a channel and a bot token both exist.** Not
     * conservatism for its own sake: the failure this default prevents is a question
     * from a private repo appearing in a channel other people read, and the only
     * setting that cannot do that is one where no code path runs at all.
     *
     * **Neither token is a field here, for the same reason `auth.google`'s secret is
     * not.** This file is committed to the git repo lib/commonrepo.js keeps, after
     * every write — so a token in it is not on disk in the clear, it is in a history
     * no rotation can reach back into. They live in `~/.config/beadcause/slack-bot.key`
     * and `slack-app.key`, whose names that repo both ignores and refuses, or in
     * BEADCAUSE_SLACK_BOT_TOKEN / BEADCAUSE_SLACK_APP_TOKEN, which leave no copy at
     * all. The two `*File` fields override the paths.
     *
     * The app token is the one that makes the buttons work. beadcause lives on a
     * tailnet with no address Slack can reach, so interactivity arrives over Socket
     * Mode — an outbound WebSocket — rather than over a Request URL. Without it the
     * questions still post and the buttons are dead, which lib/slack.js says out loud
     * at startup rather than leaving you to discover by pressing one.
     */
    slack: {
      enabled: false,
      // Where questions go: a channel id (C…) or a DM id (D…), not a #name — the API
      // takes ids, and a name that has been renamed since you typed it fails at post
      // time rather than at configure time.
      channel: null,
      // Per-space overrides live on the space itself (`slackChannel`, `slackDetail`),
      // because "which repos may reach a channel" is the same kind of answer as "which
      // repos may reach my evening". See `slackChannelFor` in lib/spaces.js.
      //
      // This is the per-repo veto beside them, mirroring `ntfy.minimalWorkspaces`: one
      // repo you never want in a channel does not deserve a space of its own.
      excludeWorkspaces: [],
      // "full" posts the question and a button per option. "minimal" posts a
      // contentless nudge you tap through to the tailnet — unlike ntfy this defaults
      // to full, because a channel you named is not a public relay.
      detail: 'full',
      // Answer straight from the channel. Slack has no three-button ceiling; this caps
      // the row at five so a ten-option question is still a message rather than a wall.
      buttons: true,
      maxButtons: 5,
      botTokenFile: null,
      appTokenFile: null,
      // The API root, so a suite can point it at a server it started itself. There is
      // no reason to change it on a real install.
      apiBase: 'https://slack.com/api',
      // Where a pressed button sends its answer. Null means this daemon's own API over
      // loopback — `http://127.0.0.1:<port>/api/respond`, which is the router, which is
      // the same process tree. Deliberately not `baseUrl`: that is the tailnet name a
      // phone is told, and it changes shape the day a certificate arrives.
      answerBase: null,
    },
  };
}

/**
 * Move a stored `pr.mergeMethod: "squash"` onto the merge commit — once, ever.
 *
 * Changing the default in `defaults()` above fixes nothing on a machine that already
 * has a config, because the stored value wins the merge below: this one's said
 * `"squash"` since the day the key was added, and it was the default then. So the whole
 * of the fix would have been notional — every delivery would go on squashing, and every
 * delivered worktree would go on being stranded in the attic, until somebody
 * remembered to edit a file, which is exactly the "nothing tells the next session" this
 * came from.
 *
 * The distinction that makes this safe is the one `reconcileBaseUrl` draws below: move
 * what this repo wrote, never what you typed. It cannot be read off the value here — a
 * `"squash"` is a `"squash"` — so it is bounded by *count* instead. It happens once,
 * the fact that it happened is recorded in `state.json`, and it says so on stdout when
 * it does. Set `squash` back deliberately and it stays: the flag has already been spent
 * and nothing will move it again.
 *
 * Returns the sentence to print, or '' when there was nothing to do — which is every
 * call after the first, on every machine, forever.
 */
export function moveSquashDefault(cfg) {
  if (cfg.pr?.mergeMethod !== 'squash') return '';
  if (loadState().squashDefaultMoved) return '';
  cfg.pr.mergeMethod = 'merge';

  /**
   * The file, edited rather than rewritten — and that distinction is the whole of this
   * block. `saveConfig(cfg)` would have been one line, but by the time this runs `cfg`
   * has every default merged into it, so saving it would turn a hand-kept nine-line
   * config into a dump of every setting this repo has and commit that to the common
   * repo. So the stored JSON is re-read, one value in it changes, and nothing else in
   * the file moves.
   *
   * A write that fails leaves the flag unspent on purpose. The in-memory move still
   * stands for this process — the new default is the behaviour either way — and the
   * next load tries the file again, rather than the file saying one thing forever while
   * every process says another.
   */
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (raw?.pr?.mergeMethod === 'squash') {
        raw.pr.mergeMethod = 'merge';
        writeJsonAtomic(CONFIG_PATH, raw);
        snapshot('config');
      }
    }
  } catch (err) {
    return `pr.mergeMethod is still "squash" in ${CONFIG_PATH} — ${err.message.split('\n')[0]}`;
  }

  saveState({ squashDefaultMoved: true });
  return (
    'pr.mergeMethod: "squash" → "merge". A squash-merged branch is never an ancestor of ' +
    'main, and the worktree cleanup will not remove a worktree that fails that test — so ' +
    'every delivered worktree stayed in the attic for good. Set it back if you meant it; ' +
    'this moves it once and never again.'
  );
}

/**
 * Move a stored `advocates.globalMaxWorkers: 10` up to 20 — once, ever.
 *
 * Same shape as `moveSquashDefault` above and for the same reason: the stored value
 * wins the merge in `loadConfig`, so a machine that has been running beadcause since
 * before today has 10 written down and would never see the new default. This is the
 * cap that most often actually binds — the console prints "held by globalMaxWorkers"
 * when it does — so leaving it notional would mean the number on screen went on saying
 * 10 while the file said 10 and the code said 20, which is the worst of the three.
 *
 * Bounded by count rather than by cleverness, because a 10 you typed and a 10 this repo
 * shipped are the same 10 and no reading of the value can tell them apart: it happens
 * once, `state.json` records that it did, and a 10 set deliberately afterwards stays.
 *
 * Returns the sentence to print, or '' when there was nothing to do — which is every
 * call after the first, on every machine, forever.
 */
export function moveGlobalWorkersDefault(cfg) {
  if (cfg.advocates?.globalMaxWorkers !== 10) return '';
  if (loadState().globalWorkersDefaultMoved) return '';
  cfg.advocates.globalMaxWorkers = 20;

  // The file edited rather than rewritten — `cfg` has every default merged into it by
  // now, and `saveConfig(cfg)` would turn a hand-kept config into a dump of every
  // setting this repo has. A write that fails leaves the flag unspent on purpose: the
  // in-memory move stands for this process either way, and the next load tries again
  // rather than the file saying one thing forever while every process says another.
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (raw?.advocates?.globalMaxWorkers === 10) {
        raw.advocates.globalMaxWorkers = 20;
        writeJsonAtomic(CONFIG_PATH, raw);
        snapshot('config');
      }
    }
  } catch (err) {
    return `advocates.globalMaxWorkers is still 10 in ${CONFIG_PATH} — ${err.message.split('\n')[0]}`;
  }

  saveState({ globalWorkersDefaultMoved: true });
  return (
    'advocates.globalMaxWorkers: 10 → 20. It is the cap that binds first on a busy day, ' +
    'and it is now a stepper on the advocates console — set it back from there if you ' +
    'meant 10; this moves it once and never again.'
  );
}

export function loadConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  let cfg;
  if (fs.existsSync(CONFIG_PATH)) {
    cfg = { ...defaults(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    cfg.ntfy = { ...defaults().ntfy, ...(cfg.ntfy || {}) };
    // And the other delivery surface, which every config written before it existed is
    // missing outright. Without the merge `cfg.slack` is undefined, and while every
    // resolver reads it with `?.` — so the absent case is already "off" — `apiBase` and
    // `maxButtons` would arrive undefined the moment somebody wrote `{"slack":
    // {"enabled": true}}` by hand, which is exactly how a hand-edited config gets
    // turned on.
    cfg.slack = { ...defaults().slack, ...(cfg.slack || {}) };
    cfg.monitor = { ...defaults().monitor, ...(cfg.monitor || {}) };
    // Same one-level merge, and for the same reason: a config written before a
    // setting existed must not lose the default for it. It matters more here —
    // an absent `maxWorkersLimit` would leave the clamp with nothing to clamp to.
    cfg.advocates = { ...defaults().advocates, ...(cfg.advocates || {}) };
    // And then the one stored value in that block that has to move for the new default
    // to mean anything on a machine that already has a config. See
    // `moveGlobalWorkersDefault` above; it writes the file itself, surgically.
    const movedCap = moveGlobalWorkersDefault(cfg);
    if (movedCap) console.log(`[beadcause] ${movedCap}`);
    // Two levels again, and for the same reason as `auth.google`: `card` is the object
    // somebody edits to make the windows bigger, and a one-level merge would drop the
    // other two dimensions the moment they wrote `{"card":{"width":900}}` — leaving the
    // grid dividing by an undefined height.
    cfg.sessionWindows = { ...defaults().sessionWindows, ...(cfg.sessionWindows || {}) };
    cfg.sessionWindows.card = { ...defaults().sessionWindows.card, ...(cfg.sessionWindows.card || {}) };
    // And again for PR delivery, which every config written before it existed is
    // missing entirely — without the merge those all read as `pr.enabled === undefined`
    // and the branch that checks `=== false` would be right by luck rather than by
    // construction, while `base` and `mergeMethod` would be undefined at the CLI.
    cfg.pr = { ...defaults().pr, ...(cfg.pr || {}) };
    // And then, once per install, the one stored value in that block that has to move
    // for the new default to mean anything — it writes the file itself, surgically.
    // See `moveSquashDefault` above.
    const movedMethod = moveSquashDefault(cfg);
    if (movedMethod) console.log(`[beadcause] ${movedMethod}`);
    // Two levels here, not one: `auth.google` is the object people actually edit, and
    // a one-level merge of `auth` alone would drop every default under it the moment
    // somebody wrote `{"auth":{"google":{"clientId":"…"}}}` by hand — leaving
    // `sessionDays` undefined and `allowed` absent, which lib/auth.js reads as "off"
    // for the second one and would otherwise read as a session of length NaN.
    cfg.auth = { ...defaults().auth, ...(cfg.auth || {}) };
    cfg.auth.google = { ...defaults().auth.google, ...(cfg.auth.google || {}) };
    // And for TLS, which every config written before it existed is missing outright —
    // without the merge `cfg.tls` would be undefined and the `!== false` default that
    // turns HTTPS on for an existing install would be reading a field on nothing.
    cfg.tls = { ...defaults().tls, ...(cfg.tls || {}) };
    // And the release queue, which every config written before it existed is missing —
    // without the merge `cfg.release` is undefined, `release.beads !== false` would be
    // true by luck rather than by construction, and `release.seconds` would clamp
    // against NaN.
    cfg.release = { ...defaults().release, ...(cfg.release || {}) };
    // Before anything else can snapshot this file: a client secret in it is a secret in
    // the common repo's history, so it is moved to a file that repo refuses and the
    // config is written back without it. Every process that loads the config does this,
    // which is what bounds the window on a config edited by hand under a running daemon —
    // until the next load, the commit guard is what holds the line.
    const absorbed = absorbClientSecret(cfg);
    if (absorbed?.error) console.warn(`[auth] ${absorbed.error}`);
    if (absorbed?.removed) {
      saveConfig(cfg);
      console.log(`[auth] ${absorbed.note}`);
    }
  } else {
    cfg = defaults();
    writeJsonAtomic(CONFIG_PATH, cfg);
    console.log(`[beadcause] wrote fresh config to ${CONFIG_PATH}`);
  }
  cfg.workspaces = reconcileWorkspaces(cfg.workspaces, cfg);
  reconcileBaseUrl(cfg, { persist: true });
  return cfg;
}

/**
 * A `baseUrl` this repo generated, as opposed to one you typed.
 *
 * The distinction is the only thing standing between "move everyone onto the name"
 * and "silently overwrite a setting somebody chose". Three shapes have ever come out
 * of `publicBaseUrl` and its predecessor — a Tailscale address (the 100.64.0.0/10
 * carrier-grade NAT range Tailscale allocates from), loopback, and a MagicDNS name —
 * and anything else is yours: a reverse proxy, a real domain, a tunnel. Those are
 * left exactly as they are, forever.
 *
 * A stale *address* matches too, which is the point: the machine's Tailscale IP may
 * have changed since it was written, and that copy is precisely the one that most
 * needs moving.
 */
const GENERATED_BASE_URL =
  /^https?:\/\/(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1|[a-z0-9.-]+\.ts\.net)(?::\d+)?$/i;

/**
 * Whether this repo wrote that `baseUrl`, asked from outside.
 *
 * The same question `reconcileBaseUrl` asks itself, exported because the admin screen
 * has to answer it *before* anything moves: "turning HTTPS on changes the origin and
 * signs every browser out" is true of a generated URL and false of a reverse proxy in
 * front of this daemon, and a warning that cried wolf on the second case would be a
 * warning nobody reads on the first.
 */
export const isGeneratedBaseUrl = (url) => GENERATED_BASE_URL.test(String(url || ''));

/**
 * Point a generated `baseUrl` at what this daemon can actually serve, and say so.
 *
 * Called twice for a reason. `loadConfig()` calls it so every short-lived CLI — `--qr`,
 * `--url`, `beadcause-ask` — prints the same URL the daemon does, off the certificate
 * already cached on disk. `bin/beadcause.js` and `bin/router.js` call it again once
 * `listen()` has run, because that is the one moment a certificate can *appear*: the
 * first boot after HTTPS is switched on obtains one, and without the second call the
 * config would keep saying `http://100.x.y.z` until something else happened to reload
 * it.
 *
 * Nothing is lost in the window between the two. Every URL already in a QR, an ntfy
 * notification or an installed PWA names the address, and the TLS front answers those
 * with a 307 to the name — see `redirectToHttps`. What moving `baseUrl` buys is that
 * *new* links stop needing the hop, which matters most for the pairing link: a phone
 * that lands on the address origin stores its token there, and localStorage does not
 * follow a redirect to a different origin.
 *
 * On stderr, not stdout: `node bin/beadcause.js --url` is piped in shell scripts, and
 * a one-time notice on the URL's own channel would corrupt exactly the thing it is
 * reporting about.
 */
export function reconcileBaseUrl(cfg, { persist = false } = {}) {
  const was = String(cfg.baseUrl || '');
  if (!GENERATED_BASE_URL.test(was)) return cfg.baseUrl;
  const want = publicBaseUrl(cfg);
  if (want === was) return cfg.baseUrl;
  cfg.baseUrl = want;
  if (persist) saveConfig(cfg);
  console.error(`[beadcause] base URL    ${was} → ${want}`);
  return want;
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
// `quiet` is the other half of `ringing`, keyed the same way again: the beads whose
// arrival this daemon deliberately made no noise about, and which of the two reasons
// it was, so the card can say so once you are looking at it. See lib/hushed.js.
const stateDefaults = () => ({
  notified: [],
  commentCounts: {},
  dismissed: {},
  filter: { space: 'all', workspace: 'all' },
  ringing: {},
  ringingDeclined: [],
  shadeSeen: null,
  answered: {},
  quiet: {},
  // Keyed `workspace/id` once more: the Slack message this daemon posted for a bead —
  // its channel, its timestamp, and the options its buttons stand for. It has to be on
  // disk rather than in memory because the router hot-swaps the backend every deploy,
  // and a message whose `ts` was lost is a message with live buttons that nothing will
  // ever settle. See lib/slack.js.
  slack: {},
  // Not an inbox fact like the rest of these: it is the receipt for a one-time config
  // move (`moveSquashDefault`), and it lives here because "has this already happened
  // once" is machine state and not something to add to the config it edits.
  squashDefaultMoved: false,
  // And the receipt for the other one-time config write: `declareOwnDeploy` in
  // lib/deploy.js, which fills in this repo's own `deploys` entry on a Mac where the
  // installed LaunchAgent really does start this checkout. Spent on the first
  // successful write, so deleting the entry deletes it for good.
  ownDeployDeclared: false,
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
    // And for the quiet arrivals. Same direction of failure as `ringing` above: a junk
    // file costs a card that does not mention it was quiet, never a card asserting a
    // silence that never happened.
    quiet: raw.quiet && typeof raw.quiet === 'object' && !Array.isArray(raw.quiet) ? raw.quiet : {},
    // And for the posted Slack messages. Same direction of failure again: a junk file
    // reads as "nothing has been posted", which costs a message left with its buttons
    // on rather than a `chat.update` aimed at a timestamp that was never real.
    slack: raw.slack && typeof raw.slack === 'object' && !Array.isArray(raw.slack) ? raw.slack : {},
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
