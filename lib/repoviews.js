/**
 * Repo views — a screen a repo declares about itself, hosted by this app.
 *
 * ## The thing that was missing
 *
 * Every view in beadcause is about *beads*: the inbox, the ledger, the advocate console,
 * the release board. That is the right spine and it is not the whole of what a repo needs
 * to manage itself. deluvia is a production company — five gates, three production lines,
 * nineteen agents, a canon change log — and none of that is derivable from the issue graph
 * alone. It already had the answer as a script, `scripts/studio_board.py`, which reads the
 * beads *and* the trunk's history *and* two markdown documents and renders one page. That
 * page then had to be published as an Artifact to be read on a phone, which means it is a
 * snapshot with a timestamp on it rather than the live thing.
 *
 * The general shape of that problem is: **the repo knows something about itself that this
 * app cannot know, and the phone is where it needs to be read.** So the app stops trying
 * to know and starts hosting. A repo declares a view; beadcause discovers it, serves it,
 * gives it a pill, a pane, an address and an SDK, and gets out of the way.
 *
 * ## What a repo declares
 *
 * One file in the checkout, `.beadcause/views.json`:
 *
 *     {
 *       "views": [
 *         {
 *           "id": "studio",
 *           "label": "Studio",
 *           "icon": "🎬",
 *           "script": "studio.js",
 *           "style": "studio.css",
 *           "data": { "run": ["python3", "scripts/studio_board.py", "--json"], "ttl": 120 }
 *         }
 *       ]
 *     }
 *
 * `script` is the module the pane loads and is the whole of the view — it draws whatever
 * it likes into a container this app hands it, through the SDK in public/viewhost.js.
 * `data.run` is how it gets what it draws: an argv this daemon runs *in the checkout*,
 * whose stdout is JSON, cached for `ttl` seconds. Both are optional and neither is special
 * — a view with no `data` fetches from `/api/*` like any other page, and a view with no
 * `script` is a declaration with nothing to draw and is refused rather than shown blank.
 *
 * ## Why the manifest is in the checkout and not in config.json
 *
 * The same argument lib/repos.js makes for reading a service token out of the repo rather
 * than restating it: **one source of truth, and it moves with the commit that changes it.**
 * A view is a fact about a repo at a revision — it names scripts in that repo and reads
 * documents in that repo — so a branch that renames `scripts/studio_board.py` renames it in
 * the manifest too, in the same diff, and there is no JSON file on one Mac left saying
 * otherwise. It also means a repo gains a view by landing a commit, with nothing to
 * configure here, which is the whole of what "pluggable" has to mean to be worth having.
 *
 * The cost is the one lib/repos.js names: the manifest is a fact about a checkout on disk,
 * so it can be missing, unparseable, or name a script that is not there. All three are
 * reported and none is guessed at — see `problems` on every answer below. A view that
 * cannot be built is a row in `/api/views` saying why, not a silent absence.
 *
 * ## The trust boundary, stated plainly
 *
 * `data.run` spawns a process this repo chose, and `script` is JavaScript this repo wrote
 * running on the app's own origin. Both are as trusted as the checkout, which is exactly
 * as trusted as everything else this daemon does with it: the advocate opens Claude Code
 * sessions in these directories, `lib/gate.js` runs their test suites, and `lib/deploy.js`
 * runs their deploy scripts. A repo that can make this daemon run its tests can already
 * make it run anything. So the boundary is *which directories*, not *what they may do*:
 *
 *   - only a workspace beadcause is already configured for, resolved through
 *     `resolveSessionDir` — the same answer that decides where a session opens;
 *   - only under `<checkout>/.beadcause/`, with every path resolved and re-checked
 *     against that prefix, so a manifest cannot name `../../.ssh/id_rsa` as its stylesheet;
 *   - `run` is an argv and never a shell string, so nothing in it is word-split, globbed
 *     or substituted, and a manifest cannot smuggle `; rm -rf` through a filename;
 *   - a timeout and an output cap, because a generator that hangs must not take the poll
 *     down with it and one that prints a gigabyte must not take the daemon's memory.
 *
 * What is deliberately *not* a boundary: the id, the label and the icon are drawn as text
 * and the front end escapes them. Refusing an emoji because it might be a script tag is
 * how a feature becomes unusable to buy nothing.
 *
 * ## Why the payload is cached, and why the cache is not clever
 *
 * `scripts/studio_board.py` walks 120 commits of trunk history and shells out to `bd` and
 * `git` a dozen times. That is a second or two — fine on a tap, ruinous on the 25-second
 * poll that redraws the shell. So a payload is held for `ttl` seconds and every reader
 * inside that window gets the held one; a reader that wants the truth asks with
 * `?refresh=1`, which is what the ⟳ in the mark's menu sends.
 *
 * One process at a time per view, and concurrent callers share the one in flight rather
 * than each starting their own. That is the whole of the cleverness. There is deliberately
 * no invalidation on git activity, no watcher on the checkout and no precomputation on a
 * timer: a stale board is a board with a timestamp on it, and the failure mode of the
 * alternatives is a generator running when nobody is looking at it.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { resolveSessionDir } from './session.js';

/** The one directory in a checkout this module will read, relative to its root. */
export const VIEW_DIR = '.beadcause';

/** The manifest inside it. */
export const MANIFEST = 'views.json';

/** How long a `data.run` may take before it is killed and reported as trouble. */
const RUN_TIMEOUT_MS = 30_000;

/** How much stdout a `data.run` may produce. A board is kilobytes; this is a backstop. */
const RUN_MAX_BYTES = 8 * 1024 * 1024;

/** Default seconds a payload is held. Long enough that the poll never pays for a run. */
const DEFAULT_TTL = 120;

/**
 * What an id may be.
 *
 * Lowercase, digits and hyphens, and that is not tidiness — the id becomes part of a URL
 * hash (`#deluvia.studio`), part of a path (`/v/deluvia/studio`) and part of a `data-pill`
 * attribute. A dot is refused because the *workspace* dot is what separates the two halves
 * of the view id, and a second one would make the split ambiguous; a slash and a colon are
 * refused because public/hashroute.js reads both as the shape of a bead card key.
 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** A repo-relative asset path: no absolute paths, no traversal, no funny business. */
const REL_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * Every view id is `<workspace>.<id>`, and this is the only place that spells it.
 *
 * The workspace has to be in the id because two repos may both call a view `board` and the
 * pill row, the hash grammar and the pane map are all keyed by one flat string. It is a dot
 * rather than a slash or a colon for the reason `ID_RE` gives: those two shapes already mean
 * "this hash is a bead card" in public/hashroute.js, and a view that parsed as a card would
 * be a pill that opened the inbox.
 */
export const viewId = (workspace, id) => `${workspace}.${id}`;

/** The other direction. `null` for anything that is not one of ours. */
export function splitViewId(full) {
  const s = String(full == null ? '' : full);
  const at = s.indexOf('.');
  if (at <= 0) return null;
  const workspace = s.slice(0, at);
  const id = s.slice(at + 1);
  if (!workspace || !ID_RE.test(id)) return null;
  return { workspace, id };
}

/**
 * The workspace record for a name, or the record it was already given.
 *
 * Both shapes arrive, and mixing them up is the kind of mistake that produces a URL with
 * `[object Object]` in it rather than an exception — so it is normalised once, here, and
 * every function below takes whichever is convenient at its call site. `resolveSessionDir`
 * needs the record (it reads `dir`); a URL and a view id need the name.
 */
const record = (cfg, ws) =>
  typeof ws === 'string' ? (cfg?.workspaces || []).find((w) => w.name === ws) || null : ws || null;

/** The name, from either shape. */
const nameOf = (ws) => (typeof ws === 'string' ? ws : ws?.name || '');

/** Where a workspace's view directory is, or `null` if the workspace resolves nowhere. */
export function viewDirFor(cfg, workspace) {
  const ws = record(cfg, workspace);
  if (!ws?.name) return null;
  try {
    const dir = resolveSessionDir(cfg, ws);
    return dir ? path.join(path.resolve(dir), VIEW_DIR) : null;
  } catch {
    // `resolveSessionDir` throws a 409 for a workspace whose checkout is missing or
    // ambiguous. That is a real condition and it is reported by the caller as a problem
    // against the workspace; it is not a reason for the whole discovery sweep to fail.
    return null;
  }
}

/**
 * Resolve a repo-relative asset inside a workspace's view directory.
 *
 * Two checks, and the second is the one that matters: the shape is refused first because a
 * refusal with a reason is better than a resolve that happens to land outside, and then the
 * *resolved* path is re-checked against the resolved prefix. The second check is what
 * catches a symlink, which the first cannot see — `.beadcause/style.css` may be a link to
 * anywhere, and `REL_RE` is perfectly happy with it.
 *
 * Returns `{ full }` or `{ problem }`. Never throws.
 */
export function resolveAsset(cfg, workspace, rel) {
  const base = viewDirFor(cfg, workspace);
  if (!base) return { problem: `no checkout resolves for the ${nameOf(workspace)} workspace` };
  const want = String(rel == null ? '' : rel);
  if (!REL_RE.test(want)) return { problem: `${want || '(empty)'} is not a repo-relative path` };
  const full = path.resolve(base, want);
  if (full !== base && !full.startsWith(base + path.sep)) {
    return { problem: `${want} resolves outside ${VIEW_DIR}/` };
  }
  /* Both sides through `realpath`, and the *base* as well as the file.
     A prefix comparison between a resolved path and an unresolved one is a comparison
     between two spellings of the same directory: on macOS `/var` is a symlink to
     `/private/var`, so every file under a temporary directory realpaths into a string the
     unresolved base is not a prefix of, and a correct file reads as one that links out.
     That is the wrong direction to be wrong in twice over — it refuses good views on some
     machines and, had the two been compared the other way round, would have admitted a
     link out on all of them. */
  let realBase;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    return { problem: `${VIEW_DIR}/ is not there` };
  }
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    return { problem: `${want} is not there` };
  }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    return { problem: `${want} links outside ${VIEW_DIR}/` };
  }
  return { full: real };
}

/**
 * One workspace's declared views, and everything wrong with them.
 *
 * Answers for a workspace with no manifest — `{ views: [], problems: [] }` — because that
 * is every workspace by default and an absent manifest is not a fault. It is only once a
 * manifest exists that its contents can be wrong, and from then on every fault is reported:
 * a manifest that will not parse, a view with no usable id, a duplicate id, a `script` that
 * is not there. The one thing that is *not* checked here is whether the script runs, which
 * is the browser's to find out.
 */
export function viewsIn(cfg, workspace) {
  // The name, once, at the top: everything below spells it into a view id and three URLs,
  // and a record reaching one of those is an `[object Object]` in a path rather than an
  // exception — which is to say, a bug nothing reports.
  const name = nameOf(workspace);
  const base = viewDirFor(cfg, workspace);
  if (!base || !name) return { views: [], problems: [] };
  const file = path.join(base, MANIFEST);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { views: [], problems: [] };
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { views: [], problems: [`${name}: ${VIEW_DIR}/${MANIFEST} will not parse — ${err.message}`] };
  }

  const list = Array.isArray(doc?.views) ? doc.views : null;
  if (!list) {
    return { views: [], problems: [`${name}: ${VIEW_DIR}/${MANIFEST} has no "views" array`] };
  }

  const views = [];
  const problems = [];
  const seen = new Set();
  for (const entry of list) {
    const id = String(entry?.id ?? '');
    if (!ID_RE.test(id)) {
      problems.push(`${name}: "${id || '(no id)'}" is not a usable view id — lowercase, digits and hyphens`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${name}: two views both call themselves "${id}" — the second is ignored`);
      continue;
    }
    seen.add(id);

    const script = String(entry?.script ?? '');
    const found = script ? resolveAsset(cfg, name, script) : { problem: 'declares no "script"' };
    if (found.problem) {
      problems.push(`${name}.${id}: ${found.problem}`);
      continue;
    }

    // A stylesheet that is named and missing is trouble worth saying out loud, and not a
    // reason to withhold the view: a board with no CSS still reads, because the pane it is
    // drawn into inherits the app's own.
    let style = '';
    if (entry?.style) {
      const at = resolveAsset(cfg, name, String(entry.style));
      if (at.problem) problems.push(`${name}.${id}: stylesheet ${at.problem}`);
      else style = String(entry.style);
    }

    const run = Array.isArray(entry?.data?.run) ? entry.data.run.map((a) => String(a)) : null;
    if (entry?.data?.run && !run) {
      problems.push(`${name}.${id}: "data.run" must be an argv array, not a command string`);
    }
    const ttl = Number(entry?.data?.ttl);

    views.push({
      view: viewId(name, id),
      workspace: name,
      id,
      // The pill's two halves. Both fall back rather than refusing: a view with no label
      // is a pill that says its own id, which is worse than a good label and far better
      // than a missing screen.
      label: String(entry?.label || id),
      icon: String(entry?.icon || '🧩'),
      script,
      style,
      // Where the browser fetches each of them. Built here rather than in the page so
      // there is one spelling of the route, and `encodeURIComponent` because a workspace
      // name is a directory name and this app has never promised those are URL-safe.
      scriptUrl: assetUrl(name, id, script),
      styleUrl: style ? assetUrl(name, id, style) : '',
      dataUrl: run ? `/api/views/${encodeURIComponent(name)}/${encodeURIComponent(id)}/data` : '',
      // The address a home-screen shortcut can hold. The server hops it to the hash, the
      // way it hops `/history` — see `viewHop` in lib/server.js.
      path: `/v/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
      // What this view needs off the document's one long poll. `'questions'` is the wide
      // one — it makes the daemon sweep `bd` on every event — and anything else is the
      // free park. Defaulted to the free one rather than to the useful one, exactly as
      // public/panestage.js defaults it, because the cost of guessing the other way is a
      // sweep per event for a board nobody is looking at.
      want: entry?.want === 'questions' ? 'questions' : 'presence',
      run,
      ttl: Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_TTL,
    });
  }

  return { views, problems };
}

/** The URL a repo asset is served under. One spelling, used by the manifest and the route. */
export const assetUrl = (workspace, id, rel) =>
  `/v/${encodeURIComponent(workspace)}/${encodeURIComponent(id)}/asset/${rel
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

/**
 * Every view every configured workspace declares, in workspace order.
 *
 * The order is the config's, not the filesystem's, so the pill row is stable across
 * restarts — a row whose rightmost pills swap places because a directory was read in a
 * different order is a row nobody can build muscle memory against.
 */
export function allViews(cfg, workspaces) {
  const views = [];
  const problems = [];
  for (const workspace of workspaces || []) {
    const one = viewsIn(cfg, workspace);
    views.push(...one.views);
    problems.push(...one.problems);
  }
  return { views, problems };
}

/** One view by its full `<workspace>.<id>`, or null. */
export function findView(cfg, workspaces, full) {
  const split = splitViewId(full);
  if (!split) return null;
  const ws = (workspaces || []).find((w) => nameOf(w) === split.workspace);
  if (!ws) return null;
  return viewsIn(cfg, ws).views.find((v) => v.id === split.id) || null;
}

/* ------------------------------------------------------------------ the payload */

/**
 * Held payloads, by full view id.
 *
 * Module-level rather than per-server, deliberately: the generator reads a checkout, and a
 * checkout is a fact about the machine rather than about which daemon instance asked. A
 * second instance on a spare port (see the observer-mode note in lib/config.js) reading the
 * same board should not make it run twice.
 */
const held = new Map();

/** Runs currently out, by full view id, so concurrent callers share one process. */
const inflight = new Map();

/** Drop everything held. For a test, and for a config reload that may have moved a repo. */
export const forgetPayloads = () => {
  held.clear();
  inflight.clear();
};

/** Spawn one generator and take its stdout as JSON. Resolves to `{ data }` or `{ problem }`. */
function runGenerator(view, cwd) {
  return new Promise((resolve) => {
    const [cmd, ...args] = view.run;
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: RUN_MAX_BYTES,
        // Never a shell. See the trust-boundary note at the top: an argv is what makes a
        // filename with a space in it a filename with a space in it.
        shell: false,
      },
      (err, stdout, stderr) => {
        if (err) {
          // The generator's own last words are worth more than the spawn error, because
          // "python: no such file" and a traceback are two different problems and only one
          // of them is fixable by whoever is holding the phone.
          const said = String(stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
          const why = err.killed ? `timed out after ${RUN_TIMEOUT_MS / 1000}s` : err.message;
          return resolve({ problem: said ? `${why} — ${said}` : why });
        }
        try {
          return resolve({ data: JSON.parse(String(stdout || '')) });
        } catch (parseErr) {
          return resolve({ problem: `did not print JSON — ${parseErr.message}` });
        }
      }
    );
  });
}

/**
 * The view's payload: the held one inside its ttl, a fresh one otherwise.
 *
 * `{ data, at, age, stale }` on success and `{ problem, at }` on failure, and a failure
 * does **not** evict what is held. A board that was right two minutes ago beside a line
 * saying the refresh failed is strictly more use than a blank pane, and the front end draws
 * exactly that — see `onData` in public/viewhost.js.
 */
export async function payloadFor(cfg, view, { refresh = false } = {}) {
  if (!view?.run?.length) return { problem: 'this view declares no "data.run"' };
  const key = view.view;
  const now = Date.now();
  const have = held.get(key);
  if (!refresh && have?.data !== undefined && now - have.at < view.ttl * 1000) {
    return { data: have.data, at: have.at, age: Math.round((now - have.at) / 1000), stale: false };
  }

  // Share the process rather than starting a second. Two panes and a poll can all want the
  // same board in the same second, and the generator is the expensive part.
  let run = inflight.get(key);
  if (!run) {
    const dir = viewDirFor(cfg, view.workspace);
    const cwd = dir ? path.dirname(dir) : null;
    run = cwd
      ? runGenerator(view, cwd)
      : Promise.resolve({ problem: `no checkout resolves for the ${view.workspace} workspace` });
    inflight.set(key, run);
    run.finally(() => inflight.delete(key));
  }
  const out = await run;

  if (out.problem) {
    // Hand back what is held, flagged, alongside the reason. See the note above.
    if (have?.data !== undefined) {
      return {
        data: have.data,
        at: have.at,
        age: Math.round((now - have.at) / 1000),
        stale: true,
        problem: out.problem,
      };
    }
    return { problem: out.problem, at: now };
  }

  held.set(key, { data: out.data, at: now });
  return { data: out.data, at: now, age: 0, stale: false };
}

/** What is being held right now, for `/api/views` and for a test. */
export const heldAges = () =>
  Object.fromEntries([...held].map(([k, v]) => [k, Math.round((Date.now() - v.at) / 1000)]));

/** Read one asset's bytes and its mtime, for the route that serves it. */
export async function readAsset(full) {
  const [stat, body] = await Promise.all([fsp.stat(full), fsp.readFile(full)]);
  return { body, size: stat.size, mtime: stat.mtimeMs };
}
