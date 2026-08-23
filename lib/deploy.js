import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CONFIG_DIR, CONFIG_PATH, loadState, saveState } from './config.js';
import { writeJsonAtomic } from './atomic.js';
import { resolveSessionDir } from './session.js';
import { allUnits, multiRepo, repoList, repoUnits, unitFor, whereLanded } from './repos.js';
import { configuredBase } from './prbase.js';
// Both only ever called from inside a function, which is what makes the loop through
// lib/config.js safe — the same arrangement every other importer of it uses.
import { snapshot } from './commonrepo.js';
import { LABEL, hotSwapProblem } from './service.js';

/**
 * Deploy a repo — the one act after a merge that this daemon could not do at all.
 *
 * Everything else that finishes a piece of work already has a home. Merging goes
 * through GitHub (lib/pr.js). The board that says whether a merge reached the running
 * build is lib/prboard.js. What was missing between them is the verb: `grep` for
 * `launchctl` across `lib/` and `bin/` found prose in comments and nothing that runs.
 * Every deploy on this Mac had been Adam at a keyboard, and the Ship button on the PR
 * board opened an iTerm window to ask him to be. It now runs what is declared here and
 * opens that window only for a repo that has declared nothing.
 *
 * Four things shape this file, and the awkward one is third.
 *
 * **A deploy is declared, never guessed.** `cfg.deploys[<repo>]` or nothing — and
 * nothing is the default for every repo. beadcause restarts under launchd, sophab
 * runs `fly deploy`, a third repo rsyncs somewhere; there is no shape those share that
 * could be inferred from a checkout, and a daemon that guessed would eventually guess
 * at three in the morning in a repo nobody was watching. A repo with no entry is
 * the state lib/prboard.js already has a sentence for: "this repo has no deploy
 * beadcause can see."
 *
 * **Keyed per repo, and a workspace is not one.** `deploys.beadcause`, and
 * `deploys["climative/athena-service"]` — the key is `repoKey` in lib/repos.js, which for
 * every workspace that is one repo is still just the workspace's name. That was the whole
 * of bc-l853.6: keyed by workspace, "how do I deploy climative" had no single answer, and
 * the reverse map below — a directory back to the workspace whose sessions open in it —
 * answered `climative` for all forty-odd checkouts, so one entry would have deployed
 * `architecture` whichever repo's Ship was pressed. A bare `climative` key is therefore
 * **refused** rather than resolved to the default repo: an ambiguous declaration that runs
 * something is worse than one that says it cannot be read, because the something it runs is
 * a deploy of the one repo nobody asked about.
 *
 * **The declaration is argv, never a shell string.** `["launchctl", "kickstart", …]`,
 * not `"launchctl kickstart …"`. A string would mean a shell, and a shell would make
 * `~/.config/beadcause/config.json` — a file that is edited by hand, rewritten by
 * `saveConfig`, and synced by lib/commonrepo.js — into somewhere a metacharacter can
 * change what runs. argv has no such reading. The cost is that `&&` and pipes are not
 * available; the answer to wanting them is a script in the repo, which is a thing you
 * can read and test.
 *
 * **The deploy cannot be awaited, because it may kill the caller.** `launchctl
 * kickstart -k gui/<uid>/m4m.beadcause` SIGKILLs the very process that asked for it.
 * An `await` on that never returns, the HTTP response is never written, and — worse —
 * anything the caller had not yet flushed dies with it. So `startDeploy` spawns a
 * **detached** child and returns; the child is what runs the command, and by the time
 * the command lands its parent has already answered. The ordering the caller owes is
 * the other half: make the answer durable *first*, then call this. It is written that
 * way round for exactly this reason, and `graceMs` buys a beat on top so an in-flight
 * response gets out of the socket.
 *
 * **Silence is never success.** Every state a deploy can be in has a name on disk, and
 * the two that mean "we do not know" are named too. A runner killed by its own deploy
 * — which is the *expected* ending for a restart, since launchd may take the whole
 * process tree — leaves `deploying`, and the sweep turns that into `unconfirmed`, not
 * into `ok`. A runner that vanished for any other reason becomes `lost`. Neither ever
 * reads as a deploy that worked.
 *
 * ## Why the journal is a directory, not a key in state.json
 *
 * Two processes are involved and they overlap: the runner writes its own progress
 * while the daemon reads it, and for a restart the daemon in the middle *changes
 * identity*. A single JSON file read-modify-written by both is last-writer-wins over
 * the whole document, so a daemon marking a record announced would silently drop the
 * runner's last step. One file per deploy under `deploys/` gives each runner sole
 * ownership of its own file; the daemon only ever reads them, plus writes a separate
 * empty `<id>.announced` marker beside it. Nothing races.
 *
 * It also sidesteps `loadState`'s fallback entirely, which is the trap a pending-deploy
 * flag in `state.json` would have walked into: an unreadable record here is one deploy
 * whose outcome is unknown — which is exactly what it is — rather than a defaulted
 * field that reads as a deploy nobody asked for or, worse, one silently dropped.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'scripts', 'deploy-runner.mjs');
/** This checkout — the tree a restart of our own LaunchAgent would actually start. */
const ROOT = path.join(HERE, '..');

export const DEPLOY_DIR = path.join(CONFIG_DIR, 'deploys');

/** How many records are kept. A deploy log is for the last few, not for history. */
const KEEP = 40;

/** How long a step may run before the runner gives up on it. */
const DEFAULT_TIMEOUT_MS = 1800000;

/**
 * How long the runner waits before touching anything.
 *
 * Not superstition: the caller is a request handler that has just written a response
 * onto a socket, and the first thing a beadcause deploy does is SIGKILL that process.
 * A second is enough for the write to leave, costs nothing on a deploy that takes
 * minutes, and turns "the phone sometimes sees a dropped connection" into "it doesn't".
 */
const DEFAULT_GRACE_MS = 1000;

/** Statuses a runner still owns. Anything else is settled. */
const LIVE = new Set(['queued', 'pulling', 'building', 'deploying']);

/**
 * Is this record still on its way — as opposed to having ended, however it ended?
 *
 * The predicate rather than the set, because the set is mutable and the four words in it
 * are this file's to change: lib/queues.js needs to know whether a deploy is the release a
 * merge is currently riding, and a caller holding its own copy of the list is how a fifth
 * status added here would quietly read as "settled" over there.
 */
export const inFlight = (rec) => LIVE.has(String(rec?.status || ''));

const iso = () => new Date().toISOString();

/* --------------------------------------------------------------- declarations */

/**
 * This user's numeric uid, or undefined where there is no such thing.
 *
 * `os.userInfo()` throws rather than returning null when the uid has no passwd entry —
 * which happens in containers — and a declaration that mentions `{uid}` is not a reason
 * for `deployFor` to throw on a machine where every *other* repo's deploy is fine. An
 * unexpanded `{uid}` fails later, loudly, in the one command that asked for it.
 */
function currentUid() {
  try {
    return os.userInfo().uid;
  } catch {
    return process.getuid?.();
  }
}

/**
 * Substitute the handful of things a declaration cannot know when it is written.
 *
 * A closed set, deliberately. `{uid}` exists because `gui/501/m4m.beadcause` is the
 * one value in a launchd target that differs per machine and would otherwise make the
 * config unshareable; the rest are here because they were already computed. Anything
 * unrecognised is left exactly as it was typed — a brace in an argument is far more
 * likely to be someone's literal brace than a placeholder this file forgot.
 */
function expand(arg, vars) {
  return String(arg).replace(/\{(uid|home|dir|base)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
}

function argv(value, vars, what) {
  if (!Array.isArray(value) || !value.length) {
    throw Object.assign(new Error(`${what} must be a non-empty array of strings — argv, not a shell line`), { status: 422 });
  }
  if (value.some((a) => typeof a !== 'string' && typeof a !== 'number')) {
    throw Object.assign(new Error(`${what} must contain only strings`), { status: 422 });
  }
  return value.map((a) => expand(a, vars));
}

/**
 * The deploy declared for one repo, resolved against this machine — or null.
 *
 * `key` is `repoKey` in lib/repos.js: a workspace name where the workspace is one repo,
 * `<workspace>/<repo>` where it holds many. Both are looked up in `cfg.deploys` exactly as
 * written, so no install that predates multi-repo workspaces has a config to edit.
 *
 * Null is a state and not an error: most repos have no deploy, and the ones that do
 * are the exception. A declaration that is *present and wrong* is the opposite, and
 * throws — a typo in `command` must surface when the button is pressed, not by
 * running something unintended or by shrugging and reporting nothing to deploy. A key
 * that names no checkout is the same kind of wrong and throws the same way: it is a
 * declaration nobody can act on, and `deploys.climative` is now exactly that.
 */
export function deployFor(cfg, key) {
  const raw = (cfg.deploys || {})[key];
  if (!raw || typeof raw !== 'object') return null;

  // Which checkout this entry is about, before anything is expanded into it. An entry
  // keyed by a bare multi-repo workspace lands here, and its `problem` is the sentence
  // that says how to key it instead — surfaced at the button rather than at load, because
  // a declaration nobody presses is a config line to fix rather than an outage.
  const unit = unitFor(cfg, key);
  if (unit.problem) {
    throw Object.assign(new Error(`deploys["${key}"] names no checkout — ${unit.problem}`), { status: 422 });
  }

  let dir = raw.dir ? String(raw.dir) : null;
  if (!dir) {
    // The repo's own checkout, where the workspace has an approved list; otherwise the
    // same directory every session for this workspace opens in. A workspace with no
    // directory at all cannot be deployed, and says so rather than defaulting to
    // somewhere plausible — `~` has been somewhere plausible before now.
    const ws = (cfg.workspaces || []).find((w) => w.name === unit.workspace) || { name: unit.workspace };
    dir = unit.repo ? unit.repo.dir : resolveSessionDir(cfg, ws);
  }
  dir = path.resolve(dir);

  // The branch a deploy fast-forwards to and substitutes into its commands. The
  // workspace's own where it has one: fast-forwarding deluvia to `origin/main` would
  // ship a branch its work never reaches. See lib/prbase.js.
  const base = String(raw.base || configuredBase(cfg, unit.workspace));
  const vars = { uid: currentUid(), home: os.homedir(), dir, base };

  const rebuild = (Array.isArray(raw.rebuild) ? raw.rebuild : []).map((r, i) => ({
    // Path prefixes, matched against what the fast-forward actually moved — so an APK
    // is rebuilt when `android/` moved and not when a comment in lib/ did. No `when`
    // at all means every time, which is a legitimate thing to declare for a repo whose
    // build is cheap, and the honest reading of having named no condition.
    when: Array.isArray(r?.when) ? r.when.map(String) : [],
    command: argv(r?.command, vars, `deploys["${key}"].rebuild[${i}].command`),
    label: r?.label ? String(r.label) : 'rebuild',
  }));

  return {
    key: unit.key,
    workspace: unit.workspace,
    // The checkout's own name, or null where the workspace is the repo — `repoSummary`'s
    // rule, for `repoSummary`'s reason: every install that is not Climative answers no.
    repo: unit.repo?.name || null,
    token: unit.repo?.token || '',
    dir,
    base,
    command: argv(raw.command, vars, `deploys["${key}"].command`),
    // Bring the checkout up to date before deploying, so what goes live is the merged
    // tree rather than whatever this Mac happened to have. Fast-forward only, and it
    // refuses over uncommitted work — see the runner.
    pull: raw.pull !== false,
    rebuild,
    // What the LaunchAgent this deploy restarts is allowed to be running. Only ever
    // consulted for a `launchctl kickstart`-shaped command, and the default — nothing
    // declared — is the derived check in lib/launchagent.js. `false` turns it off for a
    // job that is loaded some way this cannot see; a path names the program exactly.
    launchAgent: raw.launchAgent === false ? false : raw.launchAgent ? String(raw.launchAgent) : null,
    // Does this deploy restart beadcause itself? It changes only how an interrupted
    // runner is *read*: for a restart, being killed at the deploy step is the normal
    // ending and means "it ran, nobody outlived it to confirm"; anywhere else it means
    // the runner was lost. Declared rather than sniffed, because a wrong guess here is
    // the difference between `unconfirmed` and `lost`.
    restarts: Boolean(raw.restarts),
    graceMs: Number.isFinite(raw.graceMs) ? Math.max(0, raw.graceMs) : DEFAULT_GRACE_MS,
    timeoutMs: Number.isFinite(raw.timeoutMs) ? Math.max(1000, raw.timeoutMs) : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * What this repo's deploy will actually do, in a phrase a button can carry.
 *
 * The Ship option on a delivery card is the one answer in the inbox that changes what
 * is *running*, and the difference between repos is the whole of what makes it worth
 * a second's thought: `fly deploy` costs nothing you would notice, and `launchctl
 * kickstart -k` on this Mac SIGKILLs the daemon you are looking at. A generic "and
 * deploy it" hides exactly the part that differs, so this names the command, every
 * artefact that gets rebuilt, and the restart when there is one.
 *
 * Only the command's first word, deliberately: `launchctl kickstart -k gui/501/m4m.
 * beadcause` is a line of argv and not a sentence, and the argument that makes it
 * specific is the one nobody reads on a phone. `''` for a repo with no deploy, which
 * is the signal the card uses to not offer the option at all.
 */
export function deployHint(plan) {
  if (!plan) return '';
  const parts = [`runs \`${plan.command[0]}\``];
  if (plan.rebuild.length) parts.push(`rebuilds ${plan.rebuild.map((r) => r.label).join(' + ')}`);
  if (plan.restarts) parts.push('restarts beadcause');
  return parts.join(' · ');
}

/**
 * Every repo with a deploy this daemon could run, as keys, for a screen that asks.
 *
 * Over units rather than workspaces (see `allUnits`), so a Climative repo that has declared
 * one is offered the button and the thirty-nine that have not are not. A key in
 * `cfg.deploys` that names no unit at all is deliberately absent from this list *and*
 * unmentioned: it is the same broken-declaration case as a typo in `command`, and it
 * surfaces where it can be acted on — at the button, with `deployFor`'s sentence.
 */
export function deployable(cfg) {
  return allUnits(cfg)
    .map((u) => {
      try {
        return deployFor(cfg, u.key) ? u.key : null;
      } catch {
        // A broken declaration is not "deployable", but it must not take the list
        // down with it — the other repos' buttons are unaffected by this one's typo.
        return null;
      }
    })
    .filter(Boolean);
}

/* ----------------------------------------------------------------- our own one */

/**
 * The one repo whose deploy this daemon does not have to be told: itself.
 *
 * Everything above is built on "a deploy is declared, never guessed", and that rule is
 * not being weakened here — it is about *other* repos. A daemon cannot read a deploy
 * off a checkout it has never run. It can read its own: the label is `LABEL`, a
 * constant in this repo kept in step with scripts/install.sh; the tree that label
 * starts is a plist on disk this file can open; and whether restarting it kills the
 * caller is not a guess but a fact about `launchctl kickstart -k`.
 *
 * The cost of *not* declaring it was the whole of bc-t6je. `deploys` is empty by
 * default, so on the machine this was written on the beadcause entry never existed,
 * and every Ship on a merged beadcause PR fell through to lib/prboard.js's other
 * branch — an iTerm window asking Adam to deploy by hand. The deploy runner, the
 * journal, the screen, the plist check, the announcement: all of it built, none of it
 * ever reached by the repo it was built in.
 *
 * ## What it refuses to declare, and why each refusal is the honest answer
 *
 * A wrong entry here is worse than no entry: it would fast-forward a checkout nobody
 * is serving, or SIGKILL a job that is running someone else's tree. So four things
 * have to be true, and each failing one leaves the config exactly as it was.
 *
 *   - **The LaunchAgent must already be installed and pointing at this checkout.**
 *     `hotSwapProblem` is the same test bin/beadcause.js prints a banner about at
 *     startup and lib/launchagent.js refuses a deploy over: it reads the plist and
 *     compares its program with this tree's bin/router.js. A checkout that has never
 *     been installed as a service, or one whose label starts a *different* clone, has
 *     no business declaring a kickstart of it. This is also what makes the entry
 *     truthful the moment it is written rather than only once somebody re-runs the
 *     installer.
 *   - **A configured repo has to map to this checkout.** The entry is keyed per repo and
 *     `deployFor` resolves its directory back, so the key is picked by asking which unit
 *     opens *here* — `ownRepoKey`. Guessing from the directory's basename would declare a
 *     deploy for a workspace whose beads live somewhere else entirely.
 *   - **It is written once, ever.** The receipt is a flag in state.json, spent on the
 *     first successful write — the bound lib/config.js's `moveSquashDefault` uses for
 *     the same reason. Delete the entry deliberately and it stays deleted; nothing
 *     here puts it back.
 *   - **An entry that already exists is never touched.** Not merged into, not
 *     "corrected". A hand-written declaration is the more specific knowledge.
 *
 * ## Why the APK rebuild is conditional
 *
 * `npm run android` needs the Android SDK, and scripts/build-android.sh exits non-zero
 * with instructions when it is absent — which would turn every deploy that moved
 * `android/` into a failed deploy on a Mac that has never built the app and does not
 * want to. The signal that this machine builds it is the artefact itself:
 * `public/beadcause.apk` is what the daemon serves to a phone, it is gitignored, and it
 * exists only because a build here put it there. Where it exists, a deploy that moved
 * `android/` without rebuilding would leave that exact file stale — served, installable,
 * and older than the tree. So the rebuild step is declared precisely where it is both
 * possible and needed.
 *
 * Nothing declares `scripts/install.sh` as a rebuild step, though the shape is
 * available (see lib/launchagent.js). A deploy that rewrites its own LaunchAgent
 * unattended is a big hammer, and the drift it would swing at already has a sentence
 * and a refusal.
 */
export function ownDeployDeclaration({ root = ROOT, home = os.homedir() } = {}) {
  if (hotSwapProblem({ root, home })) return null;
  const declaration = {
    // `{uid}` stays a placeholder rather than being expanded now: `expand()` resolves it
    // at deploy time, and the config file is synced by lib/commonrepo.js, so a literal
    // 501 in it would be one machine's number written into everyone's copy.
    command: ['launchctl', 'kickstart', '-k', `gui/{uid}/${LABEL}`],
    restarts: true,
  };
  if (fs.existsSync(path.join(root, 'public', 'beadcause.apk'))) {
    declaration.rebuild = [{ label: 'apk', when: ['android'], command: ['npm', 'run', 'android'] }];
  }
  return declaration;
}

/**
 * The configured workspace whose sessions open in this checkout, or null.
 *
 * Exported for a second caller that wants the same question answered: bin/beadcause.js
 * asks it to decide which graph the daemon's *own* crashes belong on (lib/crash.js). A
 * beadcause bug filed onto whichever workspace happens to be first in the config is a
 * bug filed into somebody else's tracker, and `cfg.workspaces[0]` is very often
 * `climative` — which is the one graph on this Mac wired to a team's JIRA.
 *
 * This is the one caller that runs `resolveSessionDir` **backwards**, and it is why a
 * multi-repo workspace needs its own line here. Forwards, that workspace answers with
 * the repo a bead named — with no bead, with the `default` repo — so asking it once and
 * comparing would match `architecture` and miss the other forty checkouts, and a crash
 * in a session running in `~/climative.dev/athena-service` would be filed onto whichever
 * workspace came next in the list. Every approved repo of a workspace *is* that
 * workspace, so all of them are compared.
 */
export function ownWorkspace(cfg, root = ROOT) {
  const want = path.resolve(root);
  for (const w of cfg.workspaces || []) {
    if (multiRepo(cfg, w.name)) {
      if (repoList(cfg, w.name).repos.some((r) => path.resolve(r.dir) === want)) return w.name;
      continue;
    }
    try {
      if (path.resolve(resolveSessionDir(cfg, w)) === want) return w.name;
    } catch {
      // A workspace with no directory this Mac can name is not the one we are in.
    }
  }
  return null;
}

/**
 * The same question one grain finer: which *repo*'s key is this checkout, or null.
 *
 * `ownWorkspace` answers with a tracker, which is the right answer for the caller that
 * wants one — a crash belongs on a graph. A deploy is not declared for a graph, so
 * `declareOwnDeploy` needs the unit, and on a Mac where this clone happened to sit inside a
 * multi-repo workspace's approved list the two answers differ by exactly the bug bc-l853.6
 * is about: writing `deploys.climative` for it would declare a kickstart of this daemon as
 * the deploy of forty other checkouts.
 */
export function ownRepoKey(cfg, root = ROOT) {
  const want = path.resolve(root);
  for (const w of cfg.workspaces || []) {
    for (const unit of repoUnits(cfg, w.name)) {
      if (unit.repo) {
        if (path.resolve(unit.repo.dir) === want) return unit.key;
        continue;
      }
      try {
        if (path.resolve(resolveSessionDir(cfg, w)) === want) return unit.key;
      } catch {
        // A workspace with no directory this Mac can name is not the one we are in.
      }
    }
  }
  return null;
}

/**
 * Write the declaration above into the config — once, ever. Returns what to print,
 * or '' when there was nothing to do, which is every call after the first.
 *
 * `cfg` is mutated as well as saved, so the process that does the writing does not
 * have to be restarted to see it — the button works on the deploy after this one, not
 * on the boot after this one.
 */
export function declareOwnDeploy(cfg, { root = ROOT, home = os.homedir() } = {}) {
  if (loadState().ownDeployDeclared) return '';
  const name = ownRepoKey(cfg, root);
  if (!name) return '';
  if ((cfg.deploys || {})[name]) return '';
  const declaration = ownDeployDeclaration({ root, home });
  if (!declaration) return '';

  /**
   * The stored file, edited rather than rewritten — the distinction `moveSquashDefault`
   * draws for the same reason. By the time this runs `cfg` has every default merged
   * into it, so `saveConfig(cfg)` would turn a hand-kept config into a dump of every
   * setting this repo has and commit that to the common repo.
   *
   * A write that fails leaves the flag unspent, and the in-memory entry stands for this
   * process: the button works now and the next load tries the file again, rather than
   * the file saying one thing forever while the daemon says another.
   */
  cfg.deploys = { ...(cfg.deploys || {}), [name]: declaration };
  try {
    const raw = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
    if (raw?.deploys?.[name]) return '';
    raw.deploys = { ...(raw.deploys || {}), [name]: declaration };
    writeJsonAtomic(CONFIG_PATH, raw);
    snapshot('config');
  } catch (err) {
    return `could not declare the ${name} deploy in ${CONFIG_PATH} — ${err.message.split('\n')[0]}`;
  }

  saveState({ ownDeployDeclared: true });
  return (
    `deploys["${name}"] declared: ${deployHint(deployFor(cfg, name))}. ` +
    'Ship on a merged beadcause pull request now deploys, instead of opening a window to ask ' +
    'for it by hand. Delete the entry to turn it off — this writes it once and never again.'
  );
}

/* -------------------------------------------------------------------- journal */

const recordPath = (id) => path.join(DEPLOY_DIR, `${id}.json`);
const markPath = (id) => path.join(DEPLOY_DIR, `${id}.announced`);
export const logPath = (id) => path.join(DEPLOY_DIR, `${id}.log`);

function readRecord(id) {
  try {
    const rec = JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
    return rec && typeof rec === 'object' && rec.id === id ? rec : null;
  } catch {
    // Half-written, hand-mangled, or gone. A record we cannot read is not a deploy
    // that succeeded, and the honest thing is to leave it out of the list rather than
    // to invent fields for it.
    return null;
  }
}

/**
 * Newest first. Unreadable records are omitted; there is nothing true to say.
 *
 * `requestedAt` is an ISO string, so two records written inside one millisecond compare
 * equal — and a stable sort then leaves them in `readdirSync` order, which is an order
 * nothing here chose and which differs between one machine and the next. `id` breaks the
 * tie instead: it carries the same millisecond in base 36 and then a random suffix, so
 * it cannot invent an order that means anything, but it does make this list a function
 * of the records rather than of the filesystem — which is what stops the *reader* of
 * this list (`deployTrouble`, whose whole answer is the newest settled record per key)
 * from being one thing locally and another on a faster box.
 */
export function listDeploys({ limit = KEEP } = {}) {
  let names;
  try {
    names = fs.readdirSync(DEPLOY_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readRecord(n.slice(0, -5)))
    .filter(Boolean)
    .sort(
      (a, b) =>
        String(b.requestedAt).localeCompare(String(a.requestedAt)) ||
        String(b.id).localeCompare(String(a.id))
    )
    .slice(0, limit);
}

export const showDeploy = (id) => (/^[\w.-]+$/.test(String(id)) ? readRecord(String(id)) : null);

/** How much of a failed step's output travels with the list. The log has the rest. */
const FAIL_TAIL = 800;

/**
 * One record, cut down to what a list can afford to carry.
 *
 * Every step keeps up to 4 kB of what it printed, which is right for the record and
 * wrong for a payload: twenty deploys of six steps is most of a megabyte, and the
 * screen that wants this is polling every few seconds while a deploy is in flight.
 * So the list drops the output of steps that *worked* — nobody has ever read the
 * output of a `git fetch` that exited 0 — and keeps the tail of the one that did not,
 * because "why did it fail" must be answerable from the list rather than costing a
 * second request at the moment you least want one.
 *
 * Everything else is left exactly as the runner wrote it. The full record, with every
 * step's output and the runner's own log, is one `?id=` away.
 */
export function briefDeploy(rec) {
  if (!rec) return null;
  return {
    ...rec,
    steps: (rec.steps || []).map((s) =>
      // `undefined` is dropped by JSON.stringify, so a passing step carries no key at
      // all — which is what tells a reader "there was nothing to see", rather than an
      // empty string that reads as "it printed nothing".
      s.code === 0 ? { ...s, output: undefined } : { ...s, output: String(s.output || '').slice(-FAIL_TAIL) }
    ),
  };
}

/** The tail of a runner's own output, for a screen that wants to see why. */
export function deployLog(id, { bytes = 16384 } = {}) {
  if (!/^[\w.-]+$/.test(String(id))) return '';
  try {
    const buf = fs.readFileSync(logPath(id));
    return buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8');
  } catch {
    return '';
  }
}

/** Is that pid still there? `false` only when we are sure it is not. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means a process with that pid exists and belongs to someone else. That is
    // not our runner, but it is not evidence our runner is gone either — and calling
    // it gone would let pid reuse turn an unknown into a verdict.
    return err.code === 'EPERM';
  }
}

/**
 * How long a record may sit with no pid on it before it counts as never started.
 *
 * There is one unavoidable gap in the handover: the parent writes the record, spawns,
 * and from that instant the file belongs to the child — so the *child* writes the pid,
 * because a parent writing it afterwards would clobber whatever the child had already
 * recorded. Between those two moments the record is pid-less and perfectly healthy.
 * Thirty seconds is far longer than an exec takes and far shorter than anybody waits;
 * past it, `node` did not come up and that is a real failure worth naming.
 */
const STARTUP_GRACE_MS = 30000;

/**
 * Is this record's runner still on the job?
 *
 * The pid-less window above is the whole subtlety: "no pid yet" has to read as alive
 * for a moment and as lost thereafter, or every deploy is either declared dead the
 * instant it starts or never declared dead at all.
 */
function running(rec) {
  if (!LIVE.has(rec.status)) return false;
  if (rec.pid == null) return Date.now() - Date.parse(rec.requestedAt || 0) < STARTUP_GRACE_MS;
  return pidAlive(rec.pid);
}

/**
 * Settle every record whose runner is no longer there.
 *
 * Run at boot and on the poll, and it is the whole of "a failed deploy does not
 * silently read as success". A deploy that restarts beadcause is *expected* to end
 * this way — launchd takes the job's processes and the runner is one of them — so
 * that ending gets its own word, `unconfirmed`, which says the command ran and
 * nothing survived to report on it. Every other disappearance is `lost`.
 *
 * Only ever writes a record whose pid is confirmed dead, which is what keeps "the
 * runner owns its file" true.
 */
export function sweepDeploys() {
  const changed = [];
  for (const rec of listDeploys({ limit: 200 })) {
    if (!LIVE.has(rec.status)) continue;
    if (running(rec)) continue;
    const restartEnding = rec.status === 'deploying' && rec.restarts;
    const settled = {
      ...rec,
      status: restartEnding ? 'unconfirmed' : 'lost',
      finishedAt: rec.finishedAt || iso(),
      error: restartEnding
        ? 'The deploy command ran and the runner did not outlive it — which is what a restart looks like from here. Whether it worked is a question for the running build, not for this record.'
        : rec.pid == null
          ? 'The runner never started: no process ever claimed this deploy.'
          : `The runner disappeared at "${rec.status}" without recording an outcome.`,
    };
    try {
      writeJsonAtomic(recordPath(rec.id), settled);
      changed.push(settled);
    } catch {
      /* the directory may have been swept from under us; nothing useful to do */
    }
  }
  return changed;
}

/**
 * Settled deploys nobody has been told about yet.
 *
 * A marker file rather than a field on the record, because the record belongs to the
 * runner and this is the daemon's bookkeeping — and because it has to survive the
 * daemon being replaced mid-deploy by the deploy itself, which is precisely the case
 * where the notification matters most.
 */
export function unannounced() {
  return listDeploys({ limit: 200 })
    .filter((r) => !LIVE.has(r.status))
    .filter((r) => !fs.existsSync(markPath(r.id)))
    .reverse();
}

export function markAnnounced(id) {
  try {
    fs.mkdirSync(DEPLOY_DIR, { recursive: true });
    fs.writeFileSync(markPath(id), `${iso()}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which repos the last deploy left stuck — right now, not on the tick it happened.
 *
 * `settleDeploys` fires `deployEvent`/`deployClearEvent` once, on the tick a record
 * settles, and that is right for not saying the same thing every cycle — bc-ka5y.15.5's
 * whole argument. But a phone that just lost its tray (a restart, a reboot) is not
 * asking "what changed", it is asking "what is true", and a bus of one-off transitions
 * has nothing left to answer that with once the moment has passed.
 *
 * The journal already can: the *newest settled* record per key is exactly what the next
 * `deployEvent` would build from if the daemon re-ran this tick right now, so building
 * one from it needs no field of its own to keep in step with `deployClearEvent` — an
 * `ok` or `unconfirmed` record overwriting a `failed`/`lost` one for the same key *is*
 * the clear, because it is the newest settled word and there is nothing here left to
 * disagree with it.
 *
 * A record still `LIVE` (`queued`/`pulling`/`building`/`deploying`) is skipped rather
 * than read as "nothing wrong yet": a fresh attempt in flight does not erase the
 * previous failure's card until *it* settles, one way or the other.
 */
export function deployTrouble() {
  const seen = new Set();
  const settled = [];
  for (const rec of listDeploys({ limit: 200 })) {
    if (LIVE.has(rec.status)) continue;
    const key = keyOf(rec);
    if (seen.has(key)) continue;
    seen.add(key);
    settled.push(rec);
  }
  return settled.filter((rec) => rec.status === 'failed' || rec.status === 'lost');
}

/** Keep the directory to the last `KEEP` deploys, markers and logs with them. */
function prune() {
  let names;
  try {
    names = fs.readdirSync(DEPLOY_DIR);
  } catch {
    return;
  }
  const ids = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .sort();
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) {
    const rec = readRecord(id);
    if (rec && running(rec)) continue;
    for (const p of [recordPath(id), markPath(id), logPath(id)]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Which repo a record is about, as a key — and the only place that reads a journal entry
 * written before deploys were keyed per repo.
 *
 * Those records carry `workspace` and no `key`, which for every install that is not
 * Climative is the same string the key is now, so the fallback is exact rather than a
 * best effort. It matters because the journal is history: 40 records survive a restart and
 * `shippedState` reads them to decide whether a merge is live, so a record the grouping
 * could not place would quietly stop counting as a deploy that had happened.
 */
export const keyOf = (rec) => String(rec?.key || rec?.workspace || '');

/** `climative · athena-service`, or just `beadcause` — how a record names where it ran. */
export const whereOf = (rec) => whereLanded(rec?.workspace, rec?.repo ? { name: rec.repo } : null);

/** Is a deploy already in flight for this repo? Returns it, so the caller can say so. */
export function runningFor(key) {
  return listDeploys({ limit: 200 }).find((r) => keyOf(r) === String(key) && running(r)) || null;
}

/* ------------------------------------------------------------ the quiet window */

/**
 * How long after a restart the phones are still expected to be failing.
 *
 * The outage itself files nothing, which surprises everybody who reasons about this for
 * the first time: a page whose fetch failed posts the report through the same dead
 * socket, and public/report.js drops what it cannot deliver rather than queueing it. The
 * window that *does* file is the reconnect — the daemon is answering again, and requests
 * that failed a second ago are only now being described to it. Thirty seconds is
 * comfortably past the point where the last of those has arrived (public/stream.js backs
 * off before retrying, and public/warm.js prefetches four other views on a page load),
 * and short enough that a bug you hit while watching a deploy land is still filed while
 * you are looking at it.
 */
export const REPORT_GRACE_MS = 30000;

/**
 * The ceiling on a record that is still `deploying` with no runner behind it.
 *
 * That state is the *normal* ending of a restart — launchd takes the runner along with
 * the daemon — and the process that comes back cannot tell from the record when its
 * predecessor died, only that it did. So it reads as "just now", which is right, and
 * would go on being right forever without this: `sweepDeploys` settles those records at
 * boot and on the poll, but one it never reached would otherwise silence every report
 * this Mac ever makes. Past here the honest failure direction is to file again — a false
 * P0 is a bead you close, and silence is a bug nobody ever hears about.
 */
const ORPHAN_QUIET_MS = 20 * 60 * 1000;

/**
 * Where the router writes down that the service has just changed hands.
 *
 * bc-kttd, and it is the honest limit of everything above: the journal covers a
 * *declared* deploy, and the restart that happens most often on this Mac is not one.
 * `npm run swap` — which the ship skill runs, which the router-poisoning path runs, and
 * which bin/router.js also runs unasked the moment `lib/` moves on disk — replaces the
 * backend every open phone is talking to and writes no record anywhere. So nothing
 * hushed anything, and the same reconnect this whole section exists for filed a P0 per
 * screen per endpoint.
 *
 * **A file of its own rather than a record in the journal**, which is the decision worth
 * knowing. A swap wearing a deploy record would turn up in `listDeploys`, and from there
 * on the release board, in the deploy history, and — through `unannounced` — in a push to
 * the phone announcing a deploy nobody asked for. The journal is a list of things
 * somebody pressed Ship on and it has to stay one. This is a single fact that overwrites
 * itself: the last time the port changed hands.
 *
 * It needs no ceiling of its own, for the reason the stale-record case above needs one: a
 * bare timestamp expires by arithmetic, so a file nobody ever cleans up goes quiet on its
 * own one grace period later. A stamp *ahead* of now — a clock stepped back, a config
 * directory copied off another machine — is read as no restart at all, which is the same
 * direction that ceiling chose: a false P0 is a bead you close, and silence is a bug
 * nobody ever hears about.
 */
export const RESTART_PATH = path.join(CONFIG_DIR, 'restart.json');

/**
 * Say that a new backend is now the one answering. Called from bin/router.js, at the
 * moment of the handover and deliberately not at the moment the new process was spawned.
 *
 * That distinction is most of why this is written by the router at all. A backend that is
 * merely *slow* to start is spawned, health-checked, timed out and tried again while the
 * old one goes on serving perfectly (lib/startup.js) — and a marker written at spawn
 * would hush a daemon that never went anywhere, for as long as the retries went on, which
 * is precisely the window in which you most want to hear that the app is broken.
 *
 * Best-effort by contract. A router that cannot write this is a router that swaps and
 * files a few beads, which is exactly what it did before this existed; it is never a
 * reason to fail a swap.
 */
export function markRestart({ build = null, pid = null, reason = '', at = iso() } = {}) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    writeJsonAtomic(RESTART_PATH, { at, build, pid, reason });
    return true;
  } catch {
    return false;
  }
}

/** The last handover, or `null` when there has been none this process can read. */
export function lastRestart() {
  try {
    const rec = JSON.parse(fs.readFileSync(RESTART_PATH, 'utf8'));
    return rec && typeof rec === 'object' && rec.at ? rec : null;
  } catch {
    // Absent, half-written or hand-mangled. A marker we cannot read is not evidence that
    // anything restarted, and inventing one would silence this Mac on a bad guess.
    return null;
  }
}

/**
 * Is error reporting held off right now, because a deploy is restarting this daemon?
 *
 * bc-p38c.3's harder half, and it lives here rather than in lib/errors.js because the
 * deploy journal is the only thing on this Mac that knows. A restart makes every open
 * page fail every fetch at once, from four screens; without this each of those is a P0
 * in front of the advocate, and every one of them is the same fact — that you pressed
 * Ship.
 *
 * **Only a deploy that `restarts` beadcause.** `fly deploy` for another repo takes
 * nothing down that a phone was talking to, and a repo whose deploy is an rsync is no
 * reason to stop hearing that the app is broken.
 *
 * **It answers with an `until`, which is what the page is told**, so a page refused once
 * stops asking instead of spending its per-minute cap on requests that are dropped on
 * arrival. That answer is deliberately a *floor*: while a deploy is in flight nobody
 * knows when it ends, so the page is quietened for one grace period and asks again — a
 * deploy that takes ten minutes hushes it ten times rather than being trusted once for
 * ten minutes.
 *
 * **Two sources, and the second one is not a deploy at all.** The journal answers first
 * because it can say which deploy and why; behind it is the restart marker the router
 * leaves on every handover, which is what covers a hand-run `npm run swap` and every
 * automatic one (bc-kttd). See `RESTART_PATH`.
 */
export function reportingQuiet({ now = Date.now(), graceMs = REPORT_GRACE_MS } = {}) {
  const held = (rec, until, why) => ({
    id: rec.id,
    workspace: rec.workspace,
    repo: rec.repo || null,
    status: rec.status,
    until: new Date(until).toISOString(),
    why,
  });
  const ago = (t) => `${Math.round((now - t) / 1000)}s ago`;
  // Newest first, so the deploy that is actually happening is the one that answers.
  for (const rec of listDeploys({ limit: 200 })) {
    if (!rec.restarts) continue;
    const started = Date.parse(rec.requestedAt || '') || 0;

    if (!LIVE.has(rec.status)) {
      // Settled: the runner wrote when, or the sweep did. `requestedAt` is the fallback
      // for a record whose ending was never written down — a record already lying about
      // something, but not about having been asked for.
      const ended = Date.parse(rec.finishedAt || '') || started;
      if (ended && now - ended < graceMs) {
        return held(rec, ended + graceMs, `a deploy of ${whereOf(rec)} finished ${ago(ended)} (${rec.id})`);
      }
      continue;
    }

    if (running(rec)) return held(rec, now + graceMs, `a deploy of ${whereOf(rec)} is in flight (${rec.id})`);

    // A live status with no runner. This is what a restart looks like from the process
    // that came back: the command ran, and nothing outlived it to record the ending.
    if (started && now - started < ORPHAN_QUIET_MS) {
      return held(rec, now + graceMs, `a deploy of ${whereOf(rec)} restarted this daemon ${ago(started)} and is not settled yet (${rec.id})`);
    }
  }

  // Nothing in the journal says so — which is not the same as nothing having restarted.
  // A blue/green swap replaces the backend every phone is talking to and writes no
  // record at all; what it leaves is this. Unlike a deploy it has already happened by
  // the time it is written, so the window is measured from the handover and not from
  // now: a swap is not something a page has to be hushed through, only reconnected past.
  const restart = lastRestart();
  const at = Date.parse(restart?.at || '') || 0;
  const since = now - at;
  if (at && since >= 0 && since < graceMs) {
    return {
      id: null,
      workspace: null,
      repo: null,
      status: 'restarted',
      until: new Date(at + graceMs).toISOString(),
      why:
        `this daemon was replaced ${ago(at)}` +
        (restart.build ? `, onto build ${restart.build}` : '') +
        (restart.reason ? ` (${restart.reason})` : ''),
    };
  }

  return null;
}

/**
 * The deploy a handover that is happening *right now* belongs to, or null.
 *
 * bc-khoe.8, and it is the one question lib/handover.js cannot answer for itself. The
 * router records when the service changed hands; what makes that fact useful to a release
 * entry is *which release* it carried, and nothing in a swap says so — the router swaps
 * because `lib/` moved on disk, and a deploy is one of several reasons it might have.
 *
 * So the attribution is made here, at the moment of the handover, off the journal, and it
 * is the same read `reportingQuiet` makes one function up: the newest record that
 * `restarts` this daemon and has not been settled into something that never ran. Two
 * statuses count, and the second is the one that matters most:
 *
 * - **in flight** — the ordinary shape of a deploy of another repo, and of the window
 *   before this Mac's own kickstart lands.
 * - **`unconfirmed`** — the ordinary *ending* of a deploy that restarts beadcause. launchd
 *   takes the runner along with the daemon, so by the time the new router is handing over,
 *   the record may already have been swept. Refusing to attribute it would mean the one
 *   deploy shape this repo actually uses never got a handover.
 *
 * `failed` and `lost` are refused: nothing went live in either, so a handover cannot be
 * evidence about them. And a record older than `windowMs` is refused, because a handover an
 * hour after a deploy is a handover that deploy did not cause.
 *
 * **It can over-claim, and the reader is where that is fixed.** An `unconfirmed` record
 * from twenty minutes ago is still the newest one when somebody runs `npm run swap` by
 * hand, so that swap's handover names it too. `handoverFor` in lib/handover.js takes the
 * *earliest* handover claiming a deploy for exactly this reason: the real one is first, and
 * a later loose claim cannot displace it. The alternative — a window tight enough that no
 * hand-run swap could ever fall inside it — would also be tight enough to miss a build step
 * that took longer than usual, and that failure is silent where this one is not.
 */
export function restartingDeploy({ now = Date.now(), windowMs = ORPHAN_QUIET_MS } = {}) {
  for (const rec of listDeploys({ limit: 200 })) {
    if (!rec.restarts) continue;
    if (!inFlight(rec) && rec.status !== 'unconfirmed') continue;
    // `startedAt` where the runner got that far, `requestedAt` where it did not: a deploy
    // that was killed at `queued` still restarted this daemon, and the record that says
    // when it was asked for is the only clock it has.
    const at = Date.parse(rec.startedAt || rec.requestedAt || '') || 0;
    if (!at || at > now || now - at > windowMs) continue;
    return rec;
  }
  return null;
}

/* --------------------------------------------------------------------- start */

/**
 * Start a deploy and return immediately.
 *
 * The contract, in the order it has to happen: whatever made this deploy worth doing
 * is already durable — the merge, the answer, the closed bead — *before* this is
 * called. Nothing here writes to beads or to a question, deliberately, because a
 * process that may be SIGKILLed inside the next second is the wrong one to be holding
 * the only copy of anything.
 *
 * What comes back is the record, which is on disk before the child is spawned. So a
 * deploy that kills this process a moment later is still a deploy that is written
 * down, with the reason it was asked for and the bead that asked.
 *
 * `pin` is the commit to deploy, for a caller that has already decided which one — the
 * release queue's settle window does, because the batch it closed is the batch it means
 * to ship and the branch keeps moving. Without it the runner fast-forwards to
 * `origin/<base>` as it finds it, which is what a tapped Ship wants: pressing the button
 * means *everything that is owed*, and that is answered at the fetch or not at all.
 */
export function startDeploy(cfg, key, { bead = null, reason = '', graceMs = null, pin = null } = {}) {
  const plan = deployFor(cfg, key);
  if (!plan) throw Object.assign(new Error(`no deploy is declared for ${key}`), { status: 409 });

  const already = runningFor(plan.key);
  if (already) throw Object.assign(new Error(`a deploy of ${key} is already running (${already.id})`), { status: 409 });

  /*
   * A pin that is not a full object name is refused rather than dropped, and refused
   * here rather than in the runner.
   *
   * Dropped, it would deploy — just not the commit anyone asked for, and the caller that
   * asked would have no way to tell the difference afterwards. Refused in the runner, it
   * would be refused by a detached process that has already been handed a record, after
   * the daemon that could have reported it is gone. So the one place the check belongs is
   * in front of the record: a bad pin is a deploy that never started, which is a sentence
   * the release sweep already knows how to say.
   *
   * An abbreviated hash or a symbolic ref is refused too. `origin/main` resolved at deploy
   * time is exactly the moving target a pin exists to hold still against, and a short hash
   * is one an unrelated object can grow into.
   */
  // Forty hex for sha1, sixty-four for a repo initialised with sha256 — `git rev-parse`
  // hands back whichever the repo uses, and this is not the place to have an opinion.
  if (pin !== null && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(String(pin))) {
    throw Object.assign(new Error(`${pin} is not a commit hash, so there is nothing to pin this deploy to`), { status: 400 });
  }

  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  prune();

  const id = `d-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const record = {
    id,
    // Both, and neither is derivable from the other by a reader of the journal: `key` is
    // what the queue, the board and `runningFor` group by, and `workspace` is the tracker a
    // notification about this deploy files and comments on. For every install that is one
    // repo per workspace they are the same string, which is why records written before this
    // existed still group correctly — see `keyOf`.
    key: plan.key,
    workspace: plan.workspace,
    repo: plan.repo,
    dir: plan.dir,
    base: plan.base,
    bead: bead || null,
    reason: String(reason || ''),
    // A full object name, or nothing. Checked above, before the record exists.
    pin: pin ? String(pin) : null,
    restarts: plan.restarts,
    status: 'queued',
    requestedAt: iso(),
    startedAt: null,
    finishedAt: null,
    heartbeatAt: iso(),
    pid: null,
    from: null,
    to: null,
    changed: [],
    steps: [],
    error: null,
    // Filled in only by a refusal: the verdict on the LaunchAgent this deploy would
    // have restarted. Null is "the question never came up, or the answer was yes".
    //
    // It is the *structured* half of what `error` says in a paragraph — `label`,
    // `program`, `plist`, `fix`, `fixCommand` — and it exists because the paragraph is
    // the wrong shape for both of the things that read it. See lib/launchagent.js.
    launchAgent: null,
    plan: {
      pull: plan.pull,
      command: plan.command,
      rebuild: plan.rebuild,
      launchAgent: plan.launchAgent,
      timeoutMs: plan.timeoutMs,
      graceMs: graceMs === null ? plan.graceMs : Math.max(0, graceMs),
    },
  };
  writeJsonAtomic(recordPath(id), record);

  // Detached, with its own session, and its output on a file rather than on a pipe
  // this process owns. All three are the same requirement: the child has to outlive
  // its parent, and a parent that is about to be SIGKILLed cannot be holding the
  // other end of anything the child still needs.
  const out = fs.openSync(logPath(id), 'a', 0o600);
  const child = spawn(process.execPath, [RUNNER, recordPath(id)], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: plan.dir,
    env: { ...process.env },
  });
  child.unref();
  try {
    fs.closeSync(out);
  } catch {
    /* the child holds its own descriptor now */
  }

  // The record on disk is the runner's from the spawn onwards, and it writes its own
  // pid first thing — so nothing is written back here. The pid on the returned object
  // is for this process's log line and for the response; it is deliberately not the
  // record, because a write from here would land on top of whatever the child had
  // already recorded and the loser of that race would be the truth.
  return { ...record, pid: child.pid };
}
