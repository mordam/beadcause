import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beadsFor, prefixFor } from './beadref.js';
import { deployFor, deployHint, listDeploys } from './deploy.js';
import { git, gitCode, mainCheckout, ok } from './gitref.js';
import * as pr from './pr.js';
import { baseFor, configuredBase } from './prbase.js';
import { RANK, STAGE_IDS, stageOf } from './prstage.js';
import { shippedState } from './release.js';
import { resolveSessionDir } from './session.js';

/**
 * The pull requests, and how far each one has actually got.
 *
 * lib/delivery.js asks *may I merge this?* — one card, one decision, and the card is
 * gone the moment you answer. This answers the question that starts the second the
 * card disappears and had nowhere to be asked: **is it merged, is it pushed, is it
 * running?** Those are three different facts, they go true at three different times,
 * and until now the only way to know any of them was a terminal on the Mac.
 *
 * Three rules shape the whole file, and they are all the same rule wearing different
 * hats: *report what is true, never what is likely.*
 *
 * 1. **`gh` is the source of PRs; git is the source of where they got to.** The list
 *    comes from `gh pr list --state all`, so a pull request opened by hand — no bead,
 *    no delivery block, no beadcause involvement at all — is on the board like any
 *    other. Whether its merge commit reached `origin/main` is then a question for the
 *    checkout, because GitHub cannot tell you what this Mac has, and "this Mac has
 *    it" is half of what you are asking.
 *
 * 2. **Deployed means the running process, not the newest commit.** beadcause
 *    deploys by `launchctl kickstart` — a restart — so the code that is *running* is
 *    the code that was at HEAD when this process started, and nothing after it. That
 *    commit is read once, at module load, and never again: reading it lazily would
 *    report main's newest commit as deployed the moment another session merged
 *    something, which is precisely the lie this column exists to prevent.
 *
 * 3. **Three states, never two.** Every ancestry question answers true, false, or
 *    *null* — and null is the interesting one: this Mac has never fetched that
 *    commit, or has no such branch. A null drawn as "no" would tell you work was not
 *    pushed when the truth is that nobody has looked. See `gitCode` in lib/gitref.js
 *    for the exit-code plumbing that keeps the three apart.
 *
 * What this file will not do is push a branch or run a deploy. lib/pr.js states the
 * reason for the first and it holds here: the daemon merges through GitHub, where the
 * act is gated and logged. What it *says* about deploying is two facts that are easy
 * to confuse and are on every row: `deployTracked` — can this daemon see whether the
 * merge reached the running build, which it only can for its own repo — and
 * `deployDeclared` — is there a deploy in the config it could run if Ship were
 * pressed. Neither implies the other, and the button's label is the second one; see
 * `POST /api/pr/ship` in lib/server.js for what it does with it.
 */

/** How long a swept board is served again before the sweep is redone. */
const CACHE_MS = 25000;

/** How often any one checkout is re-fetched. Network per repo, so: rarely. */
const FETCH_MS = 120000;

/** How many pull requests to ask each repo for. A cap on the query, not on the answer. */
const QUERY_LIMIT = 40;

/** How far back a *settled* PR stays on the board. Open ones are never aged out. */
const RECENT_DAYS = 21;

/** And how many of them, per repo, once the age filter has had its say. */
const RECENT_MAX = 12;

const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The commit this daemon is running, resolved **now** — at import, which is process
 * start — and never again.
 *
 * A promise rather than a value because there is no top-level await to spare here and
 * every caller is already async. It cannot reject: a daemon installed from a tarball
 * with no `.git` is a perfectly ordinary deployment, and the honest answer there is
 * "deploy state is not tracked", not a board that fails to load.
 */
const BOOT = (async () => {
  const commit = (await ok(git(SELF_DIR, ['rev-parse', 'HEAD'])))?.trim();
  if (!commit) return null;
  return {
    dir: SELF_DIR,
    // The checkout that owns the object database — the daemon may be running from a
    // worktree, and a worktree's commits are the main checkout's commits.
    common: (await ok(mainCheckout(SELF_DIR))) || SELF_DIR,
    commit,
    short: commit.slice(0, 7),
    at: new Date().toISOString(),
  };
})();

/** What is running, and where it was read from. Null when this daemon is not a checkout. */
export const runningBuild = () => BOOT;

/* ------------------------------------------------------------------ git questions */

/**
 * Is `commit` an ancestor of `ref` in this checkout?
 *
 * `null` for every flavour of "cannot say": no such commit here, no such ref here, or
 * git itself refusing to run. Each of those is a real state on a Mac where six repos
 * are at six different stages of being set up, and none of them means "no".
 */
async function contains(dir, ref, commit) {
  if (!dir || !ref || !commit) return null;
  // `^{commit}` on both sides: a tag or a tree with the same name would otherwise
  // satisfy `cat-file -e` and then blow up inside merge-base with a different error.
  if ((await gitCode(dir, ['cat-file', '-e', `${commit}^{commit}`])).code !== 0) return null;
  if ((await gitCode(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code !== 0) return null;
  const anc = await gitCode(dir, ['merge-base', '--is-ancestor', commit, ref]);
  return anc.code === 0 ? true : anc.code === 1 ? false : null;
}

const lastFetch = new Map();

/**
 * Bring `origin/<base>` up to date, at most every couple of minutes per checkout.
 *
 * The board is polled while you look at it, and a fetch per poll per repo would turn
 * a screen into traffic — six repos on a 45-second refresh is 8,000 fetches a day for
 * a value that changes when somebody merges something. The throttle is per directory
 * and in memory, so a restart re-fetches immediately, which is the right bias: the
 * first board after a deploy is the one you are most likely to be reading.
 *
 * Read-only by construction. It updates `refs/remotes/origin/*` and nothing else —
 * no working tree, no local branch, nothing a session in that repo would notice.
 */
async function refreshRemote(dir, base, force = false) {
  const now = Date.now();
  const last = lastFetch.get(dir) || 0;
  if (!force && now - last < FETCH_MS) return false;
  lastFetch.set(dir, now);
  const r = await gitCode(dir, ['fetch', '--quiet', 'origin', base]);
  return r.code === 0;
}

/* --------------------------------------------------------------- beads in a PR */

/**
 * Which beads a row is for lives in lib/beadref.js, not here.
 *
 * It was written here and moved out the day lib/landed.js needed the same answer for
 * a different act — closing a bead whose pull request was merged on github.com rather
 * than drawing a row about it. A screen that links a PR to one bead while a sweep
 * closes another is a worse failure than either could be alone, so there is one
 * implementation and both import it.
 */

/* ------------------------------------------------------------------- the board */

/** Newest first, and never age out something still open. */
function recent(rows) {
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  const open = rows.filter((r) => r.state === 'OPEN');
  const settled = rows
    .filter((r) => r.state !== 'OPEN')
    .filter((r) => new Date(r.mergedAt || r.updatedAt || 0).getTime() >= cutoff)
    .slice(0, RECENT_MAX);
  return [...open, ...settled];
}

/*
 * Where a pull request has actually got to, as one word, is `stageOf` in
 * lib/prstage.js — six rungs, and the only place that decides.
 *
 * It was written here and moved out the day the inbox started drawing pull requests as
 * cards (bc-l8jp.6) and the ladder grew its fifth rung. Deliberately a ladder rather
 * than four independent flags on the wire as well as in the data: the flags are all
 * still on the row, but the *stage* is what a phone sorts, colours and filters by, and
 * computing it in two places is how the list and the card start disagreeing about the
 * same PR. Same reason `beadsFor` left this file, a few paragraphs down.
 */

/**
 * The sentence under the lamps: what is missing, and what would fix it.
 *
 * Only ever one, and only when there is something to say — a PR that is merged,
 * pushed and running needs no explanation, and a note on every row would make the
 * rows that matter unfindable.
 */
function noteFor(row) {
  if (row.state === 'OPEN') {
    if (row.draft) return 'Draft — not up for merge yet.';
    if (row.mergeable === 'CONFLICTING') return `Conflicts with ${row.base} — it needs a rebase before it can merge.`;
    if (row.checks?.state === 'failing') {
      return `${row.checks.failing} check${row.checks.failing === 1 ? '' : 's'} failing${
        row.checks.failed.length ? ` — ${row.checks.failed.join(', ')}` : ''
      }.`;
    }
    if (row.checks?.state === 'pending') return `${row.checks.pending} check${row.checks.pending === 1 ? '' : 's'} still running.`;
    return '';
  }
  if (row.state === 'CLOSED') return 'Closed without merging.';
  if (row.pushed === null) return `Nothing here has seen ${row.mergeCommit ? 'that commit' : 'a merge commit'} yet — this Mac may not have fetched.`;
  if (row.pushed === false) return `Merged on GitHub, but not on origin/${row.base} as this Mac last fetched it.`;
  if (row.local === false) return `On origin/${row.base}, but your local ${row.base} has not pulled it.`;
  // A deploy of this repo has run since the merge and this daemon is not the thing it
  // deployed, so that record is the best answer anyone here has. Said before the two
  // sentences below, which are both about *not knowing*: this is knowing something.
  if (row.shipped === true && row.deployed !== true) {
    return `Merged, pushed, and a deploy has carried it. Whether what came up is what went out is not visible from here.`;
  }
  if (!row.deployTracked) {
    // Two different unknowns, and until the Ship button could deploy they had the same
    // sentence. *Tracked* is whether this daemon can see the running build — it only
    // can for its own repo. *Declared* is whether it could deploy this one if asked.
    // A repo that declares a deploy it cannot watch is the ordinary case for every
    // repo but this one, and telling you nothing can be deployed there would now be
    // flatly untrue of the button sitting next to the sentence.
    return row.deployDeclared
      ? `Merged and pushed. Whether it is running is not visible from here — Ship deploys it anyway.`
      : 'Merged and pushed. This repo has no deploy this daemon can see.';
  }
  if (row.deployed === false) return 'Merged and pushed — but not in the build that is running. Ship it.';
  return '';
}

/**
 * What Ship will do to this repo, decided once per card rather than per row.
 *
 * A broken declaration reads as *no* declaration here on purpose: this is what a
 * button is labelled from, and a board that fails to draw over a typo in
 * `~/.config/beadcause/config.json` would take six repos down for one. The endpoint
 * asks `deployFor` again when the button is actually pressed, and *that* is where the
 * typo becomes an error with the message in it — at the moment someone is asking for
 * the thing that cannot be read, rather than on a screen they were only scanning.
 */
function deployDeclarationFor(cfg, workspaceName) {
  try {
    const plan = deployFor(cfg, workspaceName);
    return { declared: Boolean(plan), hint: deployHint(plan) };
  } catch {
    return { declared: false, hint: '' };
  }
}

/**
 * One repo's row of the board.
 *
 * Every failure lands *in* the card rather than taking the board down with it: a
 * workspace with no GitHub remote, a `gh` that cannot reach the network, a checkout
 * that has moved. Six repos and one of them broken must still be five repos you can
 * read — the same rule lib/work.js keeps for a workspace whose database is busy.
 */
async function forWorkspace(bd, cfg, ws, { boot, seen, force, deploys = [] }) {
  const declaration = deployDeclarationFor(cfg, ws.name);
  const card = {
    // The configured base is what the card carries until there is a directory to ask
    // about — it is only on the error path below, where the row says why this workspace
    // has no checkout at all, and a card with no `base` at all renders worse than one
    // carrying the install's default.
    base: configuredBase(cfg),
    workspace: ws.name,
    repo: null,
    dir: null,
    prs: [],
    error: null,
    deployTracked: false,
    deployDeclared: declaration.declared,
    deployHint: declaration.hint,
  };

  let dir;
  try {
    dir = resolveSessionDir(cfg, ws);
  } catch (err) {
    card.error = err.message;
    return card;
  }
  card.dir = dir;

  // Every ancestry question below — pushed, local, deployed — is asked against this
  // branch, so a repo whose default branch is not the install's would have every lamp
  // on every one of its rows answered about a branch its work never reaches. See
  // lib/prbase.js.
  const base = await baseFor(cfg, ws.name, dir);
  card.base = base;

  const repo = await pr.slugFor(dir);
  if (!repo) {
    // Not an error. A scratch tracker under ~/beads has no checkout and no remote,
    // and saying so once is more useful than a red card that never goes away.
    card.note = 'No GitHub remote — nothing here opens pull requests.';
    return card;
  }
  card.repo = repo;

  // Is this repo the one the daemon is running from? Compared through the *common*
  // directory so a daemon started in a worktree still recognises its own repo.
  const common = (await ok(mainCheckout(dir))) || dir;
  card.deployTracked = Boolean(boot && path.resolve(common) === path.resolve(boot.common));

  let rows;
  try {
    rows = recent(await pr.list(dir, { limit: QUERY_LIMIT }));
  } catch (err) {
    card.error = err.message;
    return card;
  }

  // One fetch for the repo, not one per pull request, and only if something merged
  // is actually waiting on the answer.
  if (rows.some((r) => r.state === 'MERGED')) await refreshRemote(dir, base, force);

  const prefix = await prefixFor(bd, ws);

  // This repo's deploys, newest first — the journal `shippedState` reads to tell a merge
  // that a deploy has carried from one that is still waiting for one. Narrowed here
  // rather than in the loop so it is one pass over the journal per repo, not per row.
  const mine = deploys.filter((d) => d.workspace === ws.name);

  card.prs = await Promise.all(
    rows.map(async (row) => {
      const commit = row.mergeCommit;
      const merged = row.state === 'MERGED';
      const [pushed, local, deployed] = merged
        ? await Promise.all([
            contains(dir, `origin/${base}`, commit),
            contains(dir, base, commit),
            card.deployTracked ? contains(dir, boot.commit, commit) : Promise.resolve(null),
          ])
        : [false, false, false];

      const out = {
        ...row,
        key: `${ws.name}#${row.number}`,
        workspace: ws.name,
        repo,
        merged,
        pushed,
        local,
        deployed,
        deployTracked: card.deployTracked,
        // Repeated on every row, as `deployTracked` already is: the phone draws its
        // buttons from the row and nothing else, and a Ship that had to reach back up
        // to the card for its own label is a Ship that gets it wrong on one screen.
        deployDeclared: declaration.declared,
        deployHint: declaration.hint,
        beads: await beadsFor(bd, ws, prefix, row, seen),
        // The list is what the board draws; nobody needs a PR description on a phone,
        // and several thousand characters per row is the whole payload.
        body: undefined,
      };
      // The fourth lamp, and the rung between `pushed` and `live`: has a deploy run
      // that carried this merge? True, false, or null for the state that must never be
      // either — see `shippedState`. On the row rather than only inside the stage,
      // because the lamps draw the evidence and the stage draws the conclusion.
      out.shipped = shippedState(out, mine);
      out.stage = stageOf(out, mine);
      out.note = noteFor(out);
      return out;
    })
  );

  // What you have to act on, first: PRs waiting on a decision, then merged work that has
  // not landed where it needs to, then everything already done. The order is `RANK` in
  // lib/prstage.js, beside the words it orders.
  card.prs.sort(
    (a, b) => RANK[a.stage] - RANK[b.stage] || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  );
  return card;
}

let cache = null;

/**
 * Every repo's pull requests, swept together.
 *
 * Cached for `CACHE_MS` because the page behind it polls and the sweep is a `gh` call
 * per repo plus a handful of `bd` lookups — a board that re-ran on every request would
 * make two phones looking at it twice the work of one. `force` is the ⟳ on the page,
 * which must mean *now*, or it is a lie about a screen whose whole subject is whether
 * something has happened yet.
 *
 * The deploy journal is read here, into the cached snapshot, and that is a deliberate
 * choice about staleness rather than an oversight: a stage is a fact about this board,
 * and a board whose lamps are 25 seconds old but whose *word* was recomputed per request
 * would be one screen disagreeing with itself. The release queue is the other way round
 * — `decorateBoard` rebuilds it from a fresh journal on every request — because a queue
 * is a thing you are about to press a button on. A deploy settling also busts this cache
 * from the page itself (`load({refresh: true})` in public/prs.js).
 */
export async function collectBoard(bd, cfg, { force = false, boot: override, deploys: journal } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.board;

  const gh = await pr.available();
  // `boot` is the daemon's own commit, read once at import. The override exists so the
  // test can put a known commit there — the whole deployed column is ancestry against
  // this value, and a test that could not set it could only ever assert "not tracked".
  const boot = override === undefined ? await BOOT : override;
  if (!gh.ok) {
    // A board with no `gh` is one sentence, not an error: this is the single
    // dependency in beadcause that is allowed to be absent.
    const board = { unavailable: gh.reason, repos: [], build: boot, counts: empty(), at: new Date().toISOString() };
    cache = { at: Date.now(), board };
    return board;
  }

  const seen = new Map();
  // Read once for the whole sweep. The override is the test's, for the same reason `boot`
  // has one: two of the six rungs are answers about deploys, and a test that could not
  // put a record in the journal could only ever assert the other four.
  const deploys = journal === undefined ? listDeploys({ limit: 200 }) : journal || [];
  const repos = await Promise.all(
    (cfg.workspaces || []).map((ws) => forWorkspace(bd, cfg, ws, { boot, seen, force, deploys }))
  );

  // Repos with something to act on first; a repo with no pull requests at all sinks,
  // but never disappears — "no PRs here" is an answer you came for too.
  const weight = (c) => c.prs.filter((p) => p.stage === 'review' || p.stage === 'merged' || p.stage === 'pushed').length;
  repos.sort((a, b) => weight(b) - weight(a) || b.prs.length - a.prs.length || a.workspace.localeCompare(b.workspace));

  const board = { unavailable: null, repos, build: boot, counts: count(repos), at: new Date().toISOString() };
  cache = { at: Date.now(), board };
  return board;
}

/** Drop the cached sweep — for anything that just changed what a sweep would find. */
export const forgetBoard = () => {
  cache = null;
};

/** A count per rung of the ladder, plus the one number that spans several of them. */
const empty = () => ({ ...Object.fromEntries(STAGE_IDS.map((id) => [id, 0])), owed: 0 });

/**
 * The numbers the chrome draws.
 *
 * `owed` is the one that matters and the one this whole view was built to make
 * visible: work that is merged and is not running anywhere. PRs in review are counted
 * beside it rather than folded into it — one is a decision, a merged one that has not
 * shipped is a chore, and a single number over both would say neither.
 *
 * The keys are the ladder's, generated from it, so a rung added there is counted here
 * without anyone remembering to.
 */
function count(repos) {
  const c = empty();
  for (const repo of repos) {
    for (const p of repo.prs) {
      c[p.stage] += 1;
      if (p.stage === 'merged' || (p.stage === 'pushed' && p.deployTracked)) c.owed += 1;
    }
  }
  return c;
}

/* ------------------------------------------------------------------- landing it */

/**
 * Bring the local `base` up to what GitHub now has — the "& push" half of the button.
 *
 * `gh pr merge` puts the merge commit on `origin/main` itself, so by the time this
 * runs the work is already off the laptop and safe; what is left is that the Mac's own
 * `main` is a commit behind, which is how a session started an hour later ends up
 * branching from before the merge.
 *
 * Everything about it is deliberately timid, and the guard is the same one step 4 of
 * the ship skill insists on: a checkout with uncommitted work in it is **not touched**
 * and says so. Adam edits inside these repos while sessions run, and a daemon that
 * fast-forwarded over a dirty tree from a phone in another room would be the single
 * most destructive thing in this codebase.
 */
export async function landLocally(dir, base = 'main') {
  const out = { fetched: false, advanced: false, note: '' };

  out.fetched = await refreshRemote(dir, base, true);
  if (!out.fetched) {
    out.note = `could not fetch origin/${base} — the merge is on GitHub, this Mac just has not seen it`;
    return out;
  }

  const branch = (await ok(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])))?.trim();
  if (branch !== base) {
    // `base` is not checked out here, so the ref can be moved without a working tree
    // being involved at all. It still fails — correctly — if another worktree of this
    // repo has it checked out, and that failure is reported rather than forced.
    const r = await gitCode(dir, ['fetch', '--quiet', 'origin', `${base}:${base}`]);
    out.advanced = r.code === 0;
    out.note = out.advanced
      ? `local ${base} moved up to origin/${base}`
      : `left local ${base} alone — ${r.stderr.split('\n')[0] || 'git would not move it'}`;
    return out;
  }

  const dirty = ((await ok(git(dir, ['status', '--porcelain']))) || '').trim();
  if (dirty) {
    out.note = `left ${base} where it is — there is uncommitted work in ${path.basename(dir)}`;
    return out;
  }

  const ff = await gitCode(dir, ['merge', '--ff-only', `origin/${base}`]);
  out.advanced = ff.code === 0;
  out.note = out.advanced
    ? `fast-forwarded ${base} to origin/${base}`
    : `could not fast-forward ${base} — ${ff.stderr.split('\n')[0] || 'it has commits origin does not'}`;
  return out;
}

/**
 * The same fast-forward, asked for from inside a worktree.
 *
 * `landLocally` is the daemon's: it is handed a checkout and moves *that* checkout's
 * `base`. A worker session is never standing in one — it is in
 * `.claude/worktrees/<name>` with its own branch checked out, and everything
 * `landLocally` does there is either wrong or refused: `git fetch origin main:main`
 * fails outright because the main checkout has `main`, and a fast-forward would move a
 * branch nobody is about to branch from.
 *
 * So the only thing this adds is *which directory*. `--git-common-dir` names the
 * checkout that owns the object database, which is the checkout whose `main` is a
 * commit behind after a worker's pull request merges at GitHub — and the one the next
 * `git worktree add` on this Mac will branch from. Run from the main checkout itself it
 * resolves to itself, so a delivery from there needs no special case.
 *
 * Everything below it is unchanged, deliberately: the refusal over uncommitted work is
 * the same refusal, in the same words, for the same reason. Adam edits in these
 * checkouts while sessions run, and a worker at three in the morning has even less
 * business fast-forwarding over his open files than a phone in another room does.
 */
export async function landParent(dir, base = 'main') {
  const home = (await ok(mainCheckout(dir))) || path.resolve(dir);
  return { ...(await landLocally(home, base)), dir: home };
}
