/**
 * Adding a bead-space from the app — a path, or a GitHub URL.
 *
 * Everything else about a tracker can be done from a phone. Muting it, setting its quiet
 * hours, deciding whether an agent may answer a comment in it unasked, retiring it when
 * the project is finished (`POST /api/workspaces`, lib/server.js) — all of it. The one
 * thing that could not was *having* one. A new repo meant opening
 * `~/.config/beadcause/config.json` in an editor, writing a `workspaceDirs` entry, and
 * restarting the backend, on the Mac, which is the single device this app was built so
 * you would not need.
 *
 * ## The three words, because two of them used to be one word
 *
 * `space` and `workspace` are a syllable apart and mean nothing like each other, and on a
 * four-inch screen that is not a distinction anybody makes correctly. So on every surface
 * a person reads — the picker, this dialog, /config — they are now:
 *
 *   - a **group** is what the config calls a `space`: "Personal", "Climative". A name, a
 *     list of trackers, and the answer to *when may this reach me* (lib/spaces.js).
 *   - a **bead-space** is what the config calls a `workspace`: one `.beads`, one Dolt
 *     database, one id prefix. `bc-`, `sp-`, `cl-`.
 *   - a **bead-repo** is a checkout attached to a bead-space, which is the shape
 *     lib/repos.js exists for: forty Climative services filing into one `cl-` graph.
 *
 * The config keys and every identifier under `lib/` still say `space` and `workspace`,
 * deliberately and only for now — see bc-35qub. Renaming a key is a migration and
 * renaming an identifier is a sweep of forty files, and neither is a thing to land in the
 * same diff as a new button while four other sessions are inside the same three files.
 * **Nothing in this module renames anything.** It reads and writes the config exactly as
 * it stands; the new words appear in the sentences it hands to the screen.
 *
 * ## Two grains of "add", and the second one is the interesting one
 *
 * Point at a directory and there are two entirely different things you may have pointed
 * at, and which one it is cannot be asked of the person — they mostly do not know:
 *
 *   - **it has a `.beads`** — that is a bead-space. Register it and it is on the picker.
 *   - **it has none** — and then it is a checkout with no tracker, which is two questions
 *     rather than one: does it want a graph of its own, or do its beads belong in a graph
 *     that already exists? The first is `bd init` and a new prefix. The second is
 *     `repos.<bead-space>.approved`, the mechanism that lets `athena-service` file into
 *     `architecture`'s tracker — and it is not a rare case, it is how a work install is
 *     shaped.
 *
 * So the flow asks *after* it looks, never before: resolve or clone, inspect, and only if
 * there is no tracker put the choice on screen, with the bead-spaces listed to attach to.
 * A form that asked up front would be asking every person, every time, a question that
 * the directory itself answers correctly in the common case.
 *
 * ## Steps run here, and lib/team.js runs them in the caller — why the difference
 *
 * lib/team.js is scrupulous about this: it turns a profile plus an observation into a
 * *list of steps as data*, and `scripts/onboard.mjs` owns every side effect, so
 * `test/team.mjs` can assert on all six states without a `bd` on `PATH`. That is right
 * there because the caller is an installer somebody is watching.
 *
 * Here the caller is the daemon, answering a POST from a phone, and there is no script to
 * hand a plan to — a step list nobody executes is a button that does nothing. So the
 * effects live in this file and the *runner* is the injected part: `run` defaults to
 * `execFile` and every suite passes its own, which buys the same thing the step list
 * bought over there. What stays pure is everything that decides: `readSource`,
 * `nameProblem`, `pinBeadSpace`, `attachBeadRepo` touch no disk and no process, and they
 * are where all the refusals are.
 *
 * ## What it refuses, and why each one is a refusal rather than a repair
 *
 * A phone has no working directory, so **a relative path means nothing** and is refused
 * instead of being resolved against whatever the daemon's cwd happens to be — which is
 * `/` under launchd. **A clone into a directory that already has something in it** is
 * refused because the alternative is git's own half-written failure inside somebody's
 * checkout. **A name already served** is refused because the name is the key for
 * `sessionDirs`, `jira`, `advocates.perWorkspace` and every group's list, so two trackers
 * sharing one would silently share all of those. **A retired name** is refused with the
 * word Restore in it, because the retirement is one line and undoing it is one press on
 * the admin screen — adding a second entry over the top of it would leave the daemon
 * carrying both.
 *
 * The one thing this module will not do at all is **create a tracker where a tracker's
 * data might already be**. `bd bootstrap` refuses to clone over an existing database, so
 * a `bd init` here on a clone that carries `refs/dolt/data` would mean the team's history
 * can never arrive and every later `bd dolt pull` meets two unrelated histories — the one
 * outcome lib/team.js says never retries its way out. `carriesBeadsData` is the check,
 * and it is a refusal with `npm run onboard` named in it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expandHome } from './repos.js';
import { containerRoots, isDirectory } from './workspaceroots.js';

const execFileAsync = promisify(execFile);

/** The two things a person can point at. Anything else is a refusal, not a guess. */
export const SOURCES = ['path', 'git'];

/**
 * The default runner: `execFile`, no shell.
 *
 * No shell for the reason lib/bd.js gives at the top of the file — `~/.zshenv` rewrites
 * `BEADS_DIR` from the cwd, so anything reached through `zsh -c` resolves to a workspace
 * nobody asked for. It matters twice as much here, where the whole point of the call is
 * to create the tracker that variable would be pointing at.
 *
 * Returns `{ok, stdout, stderr}` rather than throwing, because every caller below wants
 * the reason in a sentence on a screen rather than a stack.
 */
export async function runCommand(bin, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: 10 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    const detail = `${err.stderr || ''}${err.stdout || ''}`.trim();
    return {
      ok: false,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      // `killed` with no output is our own timeout, and undecorated it reads as a broken
      // remote rather than a slow one — the same distinction lib/bd.js draws.
      error: err.killed && !detail ? `timed out after ${Math.round((opts.timeout ?? 600000) / 1000)}s` : detail || err.message,
    };
  }
}

/* ------------------------------------------------------------------ reading the source */

/**
 * `git@github.com:Climative/safeleaf.git`, `https://github.com/o/r`, `file:///…`.
 *
 * A scheme is required, and a bare path is deliberately not one of them: `~/x/safeleaf` is
 * the *other* source, and a field that accepted both would make "add this directory" and
 * "clone this thing" the same press with two different outcomes. `file://` is on the list
 * because it is a real git URL — it is how you take a second checkout of something already
 * on the Mac, and it is what makes the clone path testable without a network.
 */
const GIT_URL = /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i;

/**
 * The repo name a URL implies: the last path segment, with `.git` and any trailing
 * slash taken off.
 *
 * Deliberately not the owner: `Climative/safeleaf` becomes `safeleaf`, because the name
 * is what every other key in the config is keyed by and what the picker draws. Two repos
 * of the same name under different owners collide, and that collision is caught by
 * `nameProblem` with a sentence rather than avoided by inventing a name nobody would
 * recognise.
 */
export function repoNameFromUrl(url) {
  const s = String(url || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  const tail = s.split(/[/:]/).pop() || '';
  return tail.replace(/\.git$/i, '');
}

/** A name that can be a directory, a config key and a `<select>` row all at once. */
const NAME_OK = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Does this path say where it starts — `/…` or `~/…` — rather than leaving it to be
 * guessed?
 *
 * Asked of the **raw text**, before `expandHome`, and that order is the whole point.
 * `expandHome` ends in `path.resolve`, so `projects/safeleaf` comes back as an absolute
 * path resolved against *this process's* working directory — which under launchd is `/`.
 * A check made after it can therefore never fail: every input is absolute by the time it
 * is looked at, and `~/projects/safeleaf` and `projects/safeleaf` would both be accepted,
 * the second one silently naming `/projects/safeleaf`. The person typed a path that means
 * something on their laptop and got a directory in the filesystem root.
 */
const rooted = (value) => {
  const s = String(value || '').trim();
  return s.startsWith('/') || s === '~' || s.startsWith('~/');
};

const relativeRefusal = (value, because) =>
  `${value} does not say where it starts — give it as /… or ~/…, because ${because}`;

/**
 * Where a clone lands when nobody says otherwise.
 *
 * `projectRoot` first, because on an install that has one it is the answer by
 * construction: it is where the checkouts are, and a shell there resolves `BEADS_DIR`
 * back to the matching bead-space, which is the whole reason the setting exists. Failing
 * that, the first *container* root — `~/beads` on a default install — which is where a
 * tracker with no separate checkout goes.
 *
 * It is a default and not a rule: the dialog puts it in an editable field, so a repo that
 * belongs somewhere else costs a line of typing rather than a config edit.
 */
export function defaultCloneRoot(cfg = {}) {
  const project = cfg?.projectRoot ? expandHome(cfg.projectRoot) : '';
  if (project) return project;
  return defaultTrackerRoot(cfg);
}

/**
 * Where a tracker made here goes — and it is not where the clone goes.
 *
 * The *first container root*, which is `~/beads` on an install that has never said
 * otherwise: the tree whose subdirectories are trackers, and the one `~/.zshenv` resolves
 * `BEADS_DIR` to. Never `projectRoot`, and never an in-repo root — the first would put a
 * `.beads` beside somebody's source, and the second is already a bead-space, so making
 * one inside it would be a second tracker under the first.
 *
 * `containerRoots` and not `workspaceRoots` for that second reason: a root that *is* a
 * bead-space is filtered out by construction (lib/workspaceroots.js), so this can never
 * answer with a directory that already has a `.beads` at the top of it.
 */
export function defaultTrackerRoot(cfg = {}) {
  return containerRoots(cfg)[0] || path.join(os.homedir(), 'beads');
}

/**
 * A source as the dialog sends it → what it is, what it is called, where it lives.
 *
 * `{kind, name, dir, url, problem}`. `problem` is a sentence for the screen and every
 * other field is then meaningless; there is no half-answer. Pure — it decides nothing by
 * looking at the disk, which is what lets `test/newspace.mjs` assert every refusal
 * without building a tree for each one.
 */
export function readSource(raw = {}, cfg = {}) {
  const kind = String(raw.source || '').trim();
  const value = String(raw.value || '').trim();
  const none = { kind, name: '', dir: '', url: '' };

  if (!SOURCES.includes(kind)) return { ...none, problem: `unknown source: ${kind || '(none given)'}` };
  if (!value) return { ...none, problem: kind === 'git' ? 'no URL given' : 'no path given' };

  if (kind === 'path') {
    if (!rooted(value)) return { ...none, problem: relativeRefusal(value, 'a path from the app is resolved on the Mac, and there is no directory to be relative to') };
    const dir = expandHome(value);
    // `~/beads/sophab/.beads` and `~/beads/sophab` name the same bead-space, and the
    // first is the one somebody copies out of a config file. `namedWorkspaces` accepts
    // either for exactly this reason; the checkout is the thing a person knows.
    const base = path.basename(dir) === '.beads' ? path.dirname(dir) : dir;
    const name = path.basename(base);
    if (!NAME_OK.test(name)) return { ...none, problem: `${name || value} cannot be a bead-space name` };
    return { kind, name, dir: base, url: '', problem: null };
  }

  if (!GIT_URL.test(value)) {
    return { ...none, problem: `${value} is not a git URL — it needs to start with https://, git@ or ssh://` };
  }
  const name = repoNameFromUrl(value);
  if (!NAME_OK.test(name)) return { ...none, problem: `cannot tell what ${value} would be called` };
  const cloneTo = String(raw.cloneTo || '').trim();
  if (cloneTo && !rooted(cloneTo)) {
    return { ...none, problem: relativeRefusal(cloneTo, 'the clone happens on the Mac, not on this device') };
  }
  const dir = cloneTo ? expandHome(cloneTo) : path.join(defaultCloneRoot(cfg), name);
  return { kind, name, dir, url: value, problem: null };
}

/* ------------------------------------------------------------------ looking at the disk */

/** Is there anything in this directory? A directory that is not there is empty too. */
export function isEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/**
 * What is at a directory, in the three facts that decide what happens next.
 *
 * `beads` is the `.beads` path when there is one — a bead-space that already exists, and
 * the whole flow is then one config line. `data` is the other half of the same question
 * and the more dangerous one: a clone that carries `refs/dolt/data` is a *team* tracker
 * that has not been bootstrapped yet, and it must never be `bd init`-ed over. See the
 * header, and lib/team.js for the failure in full.
 */
export function inspect(dir) {
  const beads = path.join(dir, '.beads');
  return {
    exists: isDirectory(dir),
    empty: isEmptyDir(dir),
    beads: isDirectory(beads) ? beads : null,
    data: carriesBeadsData(dir),
  };
}

/**
 * Does this checkout carry beads history that `bd bootstrap` has not yet unpacked?
 *
 * Dolt data rides `refs/dolt/data`, which a plain `git clone` does fetch into the remote
 * refs but which nothing reads until `bd bootstrap` runs. The ref is the evidence, and it
 * is read off the filesystem rather than by spawning `git`: `git for-each-ref` on a fresh
 * clone is a process for a question `packed-refs` answers, and this is on the path of a
 * button press.
 *
 * A false negative is safe here and a false positive is not, which is why it looks in
 * both places a ref can be: missing the ref means offering `bd init`, which is exactly
 * the mistake this guard exists to prevent, so it looks in the loose refs *and* the
 * packed file.
 */
export function carriesBeadsData(dir) {
  const git = path.join(dir, '.git');
  if (!fs.existsSync(git)) return false;
  // A worktree's `.git` is a file pointing elsewhere. Not a case that arises for a fresh
  // clone, and answering false for it is the safe direction — it only means the tracker
  // question gets asked.
  if (!isDirectory(git)) return false;
  if (isDirectory(path.join(git, 'refs', 'dolt'))) return true;
  try {
    return fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').includes('refs/dolt/');
  } catch {
    return false;
  }
}

/**
 * The id prefix a bead-space uses, read from its own `.beads/metadata.json`.
 *
 * `dolt_database` is the field: `sp` for sophab, `bc` here. Asked so that a new tracker
 * cannot be given a prefix one already has — two graphs both minting `bc-…` would make an
 * id ambiguous across the fleet, and every screen in this app addresses beads by id.
 */
export function prefixOf(beadsDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(beadsDir, 'metadata.json'), 'utf8'));
    return String(meta?.dolt_database || '').trim() || null;
  } catch {
    return null;
  }
}

/** Every prefix this Mac already serves → the bead-space using it. */
export function prefixesInUse(workspaces = []) {
  const out = new Map();
  for (const w of workspaces) {
    const p = w?.dir ? prefixOf(w.dir) : null;
    if (p && !out.has(p)) out.set(p, w.name);
  }
  return out;
}

/**
 * A prefix for a new tracker: the first two letters, then three, then four.
 *
 * `bd-newws` takes `${1:0:2}` and stops, which is right for a person who can see the
 * clash and pick again. Here nobody can, so it walks — `safeleaf` → `sa`, and if `sa` is
 * taken, `saf`. Null when even four letters collide, which is a refusal with the
 * offending bead-space named rather than a fifth guess.
 */
export function suggestPrefix(name, workspaces = []) {
  const taken = prefixesInUse(workspaces);
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!base) return null;
  for (let n = 2; n <= 4; n += 1) {
    const p = base.slice(0, n);
    if (p.length < Math.min(n, base.length)) break;
    if (!taken.has(p)) return p;
  }
  return null;
}

/** 2–4 lowercase letters or digits, which is every prefix `bd` will accept as an id stem. */
export const PREFIX_OK = /^[a-z0-9]{2,4}$/;

/* ------------------------------------------------------------------ is the name free */

/**
 * Whether this Mac can serve a bead-space by this name, as a sentence or null.
 *
 * `served` is the live map's keys and `cfg` is asked about the retired ones separately,
 * because they fail differently: a served name is a collision and a retired one is a
 * button somebody already pressed, so the sentence names Restore instead of asking them
 * to pick a different name for a repo that is already theirs.
 */
export function nameProblem(cfg = {}, served = [], name = '') {
  if (!NAME_OK.test(name)) return `${name || '(no name)'} cannot be a bead-space name`;
  if (served.includes(name)) return `${name} is already a bead-space on this Mac`;
  if ((cfg.workspaceDirs || {})[name] === null) {
    return `${name} is a bead-space you retired — bring it back with Restore on the admin screen rather than adding it again`;
  }
  return null;
}

/* ------------------------------------------------------------------ the effects */

/**
 * `git clone <url> <dir>`, with the refusals in front of it.
 *
 * `--` before the URL is deliberately **absent**: every argument here is passed through
 * `execFile`, so there is no shell to confuse and no glob to expand, and a `--` in an
 * argv array is just an argument git has to interpret. (The hazard `--` normally guards
 * against is the shell's, and there is no shell in this file at all.)
 *
 * The parent is created but the target is not: `git clone` wants to make the last
 * component itself, and a pre-made empty directory is the shape where a half-failed clone
 * leaves something behind that the next attempt then refuses.
 */
export async function cloneRepo({ url, dir, run = runCommand }) {
  if (isDirectory(dir) && !isEmptyDir(dir)) {
    return { ok: false, error: `${dir} already has something in it — clone it somewhere else, or add that directory by path instead` };
  }
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not make ${path.dirname(dir)}: ${err.message}` };
  }
  const res = await run('git', ['clone', url, dir]);
  if (!res.ok) return { ok: false, error: `git clone failed: ${firstLine(res.error)}` };
  return { ok: true, dir };
}

/**
 * `bd init` for a brand new tracker, in the container root and never in the checkout.
 *
 * This is `bd-newws` (in `~/.zshenv`) as a function, and the two things it does that a
 * bare `bd init` does not are the whole reason it is not a bare `bd init`:
 *
 * - **`--skip-agents`.** `bd init` writes `AGENTS.md`, `CLAUDE.md`, `.claude/`,
 *   `.agents/` and `.codex/` into the current directory as well as the tracker. Run
 *   inside a checkout that overwrites the repo's own instructions file — a real,
 *   silent, committed-by-accident loss.
 * - **run from the workspace directory**, with `BEADS_DIR` pointing at it, so those
 *   files could not land in a checkout even if the flag stopped working.
 *
 * The tracker goes to `<container root>/<name>/.beads` rather than inside the checkout
 * because that is where every personal tracker on this Mac lives and what `~/.zshenv`
 * resolves to; a checkout keeps its own tree. An in-repo tracker is a real shape
 * (lib/workspaceroots.js) but it is the *team* shape, and it arrives by being cloned
 * rather than by being made here.
 */
export async function initTracker({ root, name, prefix, bin = 'bd', actor = '', run = runCommand }) {
  const dir = path.join(root, name);
  const beads = path.join(dir, '.beads');
  if (isDirectory(beads)) return { ok: false, error: `${beads} already exists` };
  if (!PREFIX_OK.test(prefix || '')) {
    return { ok: false, error: `"${prefix}" is not a usable id prefix — two to four letters or digits, like bc or sp` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not make ${dir}: ${err.message}` };
  }
  const res = await run(bin, ['init', '--prefix', prefix, '--role', 'maintainer', '--skip-agents', '--non-interactive'], {
    cwd: dir,
    env: { ...process.env, BEADS_DIR: beads, ...(actor ? { BEADS_ACTOR: actor } : {}) },
  });
  if (!res.ok) return { ok: false, error: `bd init failed: ${firstLine(res.error)}` };
  if (!isDirectory(beads)) return { ok: false, error: `bd init reported success but ${beads} is not there` };
  return { ok: true, dir, beads };
}

/* ------------------------------------------------------------------ the config writes */

/**
 * Put a bead-space in the config. Mutates `cfg` and returns what changed, in sentences.
 *
 * Two keys, and which one is used is the interesting part. A tracker a root already
 * reaches needs **nothing**: `discoverWorkspaces` finds it on every start, and pinning it
 * would freeze it in place so that renaming its directory drops the bead-space instead of
 * moving it — the rot `isDiscoverable` exists to prevent (see lib/workspaceroots.js). One
 * anywhere else gets a `workspaceDirs` pin, which is the key whose whole job is naming a
 * tracker wherever it lives.
 *
 * `cfg.workspaces` is appended to either way, because that array is what the daemon
 * serves from this tick — the file is what survives a restart and the array is what is
 * true now, and a write that did only one of them is a bead-space that appears an hour
 * later or one that vanishes at the next restart.
 */
export function pinBeadSpace(cfg, { name, dir, discoverable = false }) {
  const changed = [];
  const beads = path.basename(dir) === '.beads' ? dir : path.join(dir, '.beads');
  if (!discoverable) {
    cfg.workspaceDirs = { ...(cfg.workspaceDirs || {}), [name]: tilde(dir) };
    changed.push(`workspaceDirs.${name} = ${tilde(dir)}`);
  } else {
    // A pin that says exactly what looking would have found is not a no-op, it is a
    // future bug. Left unwritten on purpose, and said out loud so the reply can.
    changed.push(`${name} is under a configured root — no pin needed`);
  }
  const entry = { name, dir: beads };
  cfg.workspaces = [...(cfg.workspaces || []).filter((w) => w.name !== name), entry].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  return { changed, entry };
}

/**
 * Attach a checkout to a bead-space that already exists — the second grain of "add".
 *
 * This is `repos.<bead-space>.approved`, and the entry is written as a **path** rather
 * than a bare name. A bare name is joined to `repos.<ws>.root` and is what the list looks
 * like when every checkout is in one tree; a path is the accepted form for the checkout
 * that lives somewhere else (`entryDir` in lib/repos.js), and it is the only honest one
 * here because the clone went wherever the dialog's field said.
 *
 * **`approved` is a list Adam writes, and this is Adam writing it** — one repo, named, by
 * hand, on a screen. That is the distinction lib/repos.js draws when it refuses to
 * discover a root's contents: the danger was never "an entry was added", it was "a
 * directory appearing under the root is enough to make it workable". Nothing here reads a
 * directory listing.
 *
 * The service token is *not* invented. A checkout with no `serviceToken` in its
 * `config/config.yaml` resolves to nothing and `repoList` already says so in a warning —
 * so the caller is handed `tokenless: true` and says it on the screen, rather than this
 * writing a token into somebody's repo to make its own reply tidier.
 */
export function attachBeadRepo(cfg, { workspace, dir }) {
  const block = { ...((cfg.repos || {})[workspace] || {}) };
  const approved = [...(block.approved || [])];
  const already = approved.some((e) => samePath(entryPath(e, block.root), dir));
  if (already) return { changed: [], already: true };
  approved.push(tilde(dir));
  block.approved = approved;
  cfg.repos = { ...(cfg.repos || {}), [workspace]: block };
  return { changed: [`repos.${workspace}.approved += ${tilde(dir)}`], already: false };
}

/**
 * Pin where a bead-space's sessions open, when the checkout is not where the rule looks.
 *
 * The rule is `<projectRoot>/<name>` and it is right most of the time — it is the same
 * one `~/.zshenv` uses, which is what makes a shell opened there resolve back to this
 * tracker. `sessionDirs` is the override for a bead-space with no matching directory
 * under it, and a clone the dialog sent somewhere else is exactly that case.
 *
 * Written only when it is needed. An entry that restates the rule is a pin that stops
 * following it the day the tree moves, and lib/repos.js already warns about a
 * `sessionDirs` entry on a bead-space that has an approved repo list.
 */
export function pinSessionDir(cfg, { name, dir }) {
  const project = cfg?.projectRoot ? expandHome(cfg.projectRoot) : '';
  if (project && samePath(path.join(project, name), dir)) return { changed: [] };
  if (!project) return { changed: [] };
  cfg.sessionDirs = { ...(cfg.sessionDirs || {}), [name]: tilde(dir) };
  return { changed: [`sessionDirs.${name} = ${tilde(dir)}`] };
}

/* ------------------------------------------------------------------ small shared things */

/** `/Users/you/x` → `~/x`, so a hand-editable file keeps hand-written paths. */
export function tilde(p) {
  const home = os.homedir();
  const s = String(p || '');
  return s === home ? '~' : s.startsWith(`${home}/`) ? `~${s.slice(home.length)}` : s;
}

const samePath = (a, b) => Boolean(a) && Boolean(b) && path.resolve(a) === path.resolve(b);

/** One approved entry → the directory it means, for the duplicate check above. */
function entryPath(entry, root) {
  const raw = String(entry || '').trim();
  if (!raw) return '';
  const isPath = raw.startsWith('~') || raw.startsWith('/') || raw.startsWith('.') || raw.includes('/');
  if (isPath) return expandHome(raw);
  return root ? path.join(expandHome(root), raw) : '';
}

/** git and bd both say the useful thing first and the stack trace afterwards. */
function firstLine(text) {
  return String(text || '').trim().split('\n')[0] || 'no reason given';
}
