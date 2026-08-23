import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beadsFor, prefixFor } from './beadref.js';
import * as cache from './cache.js';
import { deployFor, deployHint, keyOf, listDeploys } from './deploy.js';
import { git, gitCode, mainCheckout, ok } from './gitref.js';
import * as pr from './pr.js';
import { baseFor, configuredBase } from './prbase.js';
import { RANK, STAGE_IDS, stageOf } from './prstage.js';
import { shippedState } from './release.js';
import { repoUnits } from './repos.js';
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
 *    That split is also what makes this survive a forty-repo workspace: git is local and
 *    costs nothing, `gh` is the network and is now asked about forty checkouts instead of
 *    six. See `ROWS_MS` — the `gh` half of a sweep is cached per repo and the git half is
 *    redone every time, so the lamps stay as fresh as they were and the traffic does not
 *    multiply by the size of somebody's org.
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

/**
 * How long a swept board is served again before the sweep is redone.
 *
 * Both caches in this file sit on lib/cache.js as of bc-1kwl.3, and the windows below
 * are the ones they always had. What changed is the sixteenth second: this board is the
 * most expensive route in the app — **74 seconds** measured under bc-1kwl.1 with nine
 * workspaces at a load average of 32 — and past the window whoever asked next used to
 * pay for the whole sweep. It could therefore never be warm *on its own*: the sweep
 * outlasts its own window by a factor of three, so the poll behind the page arrived to
 * find the entry already expired every single time. Now a stale read hands back the
 * 25-second-old board immediately and the sweep runs behind the response, which is the
 * one shape that works for a route whose producer is slower than its freshness.
 */
const CACHE_MS = 25000;

/** How often any one checkout is re-fetched. Network per repo, so: rarely. */
const FETCH_MS = 120000;

/**
 * How long one repo's `gh` answers — its slug and its pull requests — are reused.
 *
 * The board's own cache above is per *board*: 25 seconds, chosen so two phones watching
 * the same screen are not twice the traffic of one. That was the whole story while a
 * workspace was a repo and there were six of them. A Climative workspace of forty approved
 * checkouts is a `gh repo view` plus a `gh pr list` each — eighty network calls per sweep,
 * and at one sweep per 25 seconds that is over eleven thousand an hour against a limit of
 * five, reached by nothing more than leaving /prs open on a phone.
 *
 * So the `gh` half of a sweep has a cache of its own and a much longer one. What it buys is
 * exactly the part that is expensive and never the part that is interesting: `pushed`,
 * `local`, `deployed` and `shipped` are all read fresh on every sweep, because they are git
 * and the journal, and they are what changes when you press Ship. What goes stale for two
 * minutes is "has a new pull request appeared", which is the one fact on this board that
 * nobody is watching a second hand for — and three things drop it: the ⟳ (`force`), every
 * acting call, all of which sweep forced, and `forgetBoard(dir)`, which every merge, close
 * and comment from this daemon calls for the checkout it acted on.
 */
const ROWS_MS = 120000;

/**
 * How many repos are asked at once.
 *
 * `Promise.all` over forty units is eighty concurrent `gh` subprocesses, each of which is a
 * node process of its own; the laptop notices, and the ones that time out come back as
 * per-card errors that look like real ones. Six at a time is enough that a sweep of six
 * repos is as parallel as it ever was, and turns forty into seven waves rather than one
 * stampede.
 */
const SWEEP_AT_ONCE = 6;

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

/**
 * One checkout's `gh` answers, on the shared layer as `prs:<dir>` for `ROWS_MS`.
 *
 * Keyed by directory rather than by repo key, because the directory is what `gh` was asked
 * about: two units that somehow resolved to the same checkout would be asking the same
 * question, and a repo taken out of `approved` stops being asked without leaving anything
 * behind that has to be swept. The directory comes from `approved` and from
 * `resolveSessionDir` — config, never a request — which is the condition lib/cache.js sets
 * on anything that becomes a key.
 *
 * A failure is **still not served**, and this is the one place in bc-1kwl.3's sweep where a
 * caller declines the layer's last-good-beats-empty. lib/history.js takes it, because a
 * ledger of ten-second-old rows over a `bd` that just fell over is obviously worth more than
 * a blank screen and the page has an `errors[]` to say so in. This board does not have that
 * shape: rule 1 at the top of this file is *report what is true, never what is likely*, and
 * the only thing a card can say about itself is `error` or `note`, both of which replace the
 * rows rather than annotate them (see `repoHtml` in public/prs.js). So a kept answer served
 * quietly under a broken `gh` would be a board silently drawing two-minute-old pull requests
 * on the screen whose entire subject is whether something has happened yet. The failure is
 * rethrown and the card goes red exactly as it did before.
 *
 * What the layer *does* buy here is the sixteenth-second cliff and single-flight: two phones
 * and a poll landing together on an expired repo cause one `gh pr list`, not three, and past
 * the window nobody waits for the network.
 */
const ROWS_PREFIX = 'prs:';
const rowsKey = (dir) => `${ROWS_PREFIX}${dir}`;

async function rowsFor(dir, force) {
  const got = await cache.read(rowsKey(dir), () => askGh(dir), { freshMs: ROWS_MS, refresh: force });
  if (!got.error) return got.value;
  // A failure over a kept answer, which the layer would ordinarily let you serve. **Dropped
  // and rethrown**, and the drop is the half that is easy to miss: lib/cache.js leaves the
  // failure on the entry until a refresh succeeds, and an entry that is still inside its
  // window is never refreshed by a read. So a `gh` that failed once during a forced sweep
  // would mark a *fresh* entry broken and nothing would ask again for two minutes — a red
  // card held long after the thing had healed, which is the exact failure the paragraph
  // above refuses. Dropping makes "a failure is not cached" true of the failure as well as
  // of the answer: the next sweep asks `gh` from cold.
  cache.drop(rowsKey(dir));
  throw new Error(got.error);
}

async function askGh(dir) {
  const slug = await pr.slugFor(dir);
  // No remote is a *fact* about the checkout and worth remembering: it is stable, and the
  // probe behind it is up to one `gh repo view` per configured account (see lib/pr.js).
  return { slug, rows: slug ? recent(await pr.list(dir, { limit: QUERY_LIMIT })) : [] };
}

/** Drop the per-repo `gh` cache. For a test, and for anything that knows `gh` just changed. */
export const forgetRows = () => cache.dropPrefix(ROWS_PREFIX);

/**
 * `Promise.all` with a ceiling — see `SWEEP_AT_ONCE`.
 *
 * Order in is order out, which the callers rely on: a board sorted afterwards still has to
 * be built from cards in `approved`'s order, or two sweeps of the same unchanged config
 * would draw the repos in different places.
 */
async function atMost(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
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
function deployDeclarationFor(cfg, key) {
  try {
    const plan = deployFor(cfg, key);
    return { declared: Boolean(plan), hint: deployHint(plan) };
  } catch {
    return { declared: false, hint: '' };
  }
}

/**
 * One repo's card of the board.
 *
 * A *repo*, not a workspace, and that is bc-l853.6: a workspace with an approved list gets
 * one card per approved checkout (`repoUnits`), because a pull request board keyed by
 * tracker would draw one Climative card listing `architecture`'s pull requests and call it
 * the org. Every card names its own repo — `card.repo` is the GitHub slug it always was,
 * and `card.key` is what every button on it acts through.
 *
 * Every failure lands *in* the card rather than taking the board down with it: a
 * workspace with no GitHub remote, a `gh` that cannot reach the network, a checkout
 * that has moved. Six repos and one of them broken must still be five repos you can
 * read — the same rule lib/work.js keeps for a workspace whose database is busy.
 */
async function forRepo(bd, cfg, unit, { boot, seen, force, deploys = [] }) {
  const ws = unit.ws;
  const declaration = deployDeclarationFor(cfg, unit.key);
  const card = {
    // The configured base is what the card carries until there is a directory to ask
    // about — it is only on the error path below, where the row says why this workspace
    // has no checkout at all, and a card with no `base` at all renders worse than one
    // carrying the install's default.
    base: configuredBase(cfg, ws.name),
    // The three names a card has, and they are three different things: `key` is the address
    // (a workspace name, or `<workspace>/<repo>`), `workspace` is the tracker its beads live
    // in, and `repoName` is the checkout. `repo` stays what it has always been — the GitHub
    // slug — because that is what a row is *about* and what the marker on a ship bead uses.
    key: unit.key,
    workspace: ws.name,
    repoName: unit.repo?.name || null,
    token: unit.repo?.token || '',
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
    dir = unit.repo ? unit.repo.dir : resolveSessionDir(cfg, ws);
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

  let repo;
  let rows;
  try {
    ({ slug: repo, rows } = await rowsFor(dir, force));
  } catch (err) {
    card.error = err.message;
    return card;
  }
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

  // One fetch for the repo, not one per pull request, and only if something merged
  // is actually waiting on the answer.
  if (rows.some((r) => r.state === 'MERGED')) await refreshRemote(dir, base, force);

  const prefix = await prefixFor(bd, ws);

  // This repo's deploys, newest first — the journal `shippedState` reads to tell a merge
  // that a deploy has carried from one that is still waiting for one. Narrowed here
  // rather than in the loop so it is one pass over the journal per repo, not per row.
  // By key, so a Climative deploy of one service does not read as a deploy of the other
  // thirty-nine — which is the same fact `keyOf` keeps true for the records that predate it.
  const mine = deploys.filter((d) => keyOf(d) === unit.key);

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
        // `<key>#<number>`, because a pull request number is only unique within a repo and
        // a workspace is no longer one — two Climative services both have a #1. This is the
        // string the inbox deep-links with (`#pr:<key>#<number>`) and, for every workspace
        // that is one repo, it is character for character what it was.
        key: `${unit.key}#${row.number}`,
        repoKey: unit.key,
        workspace: ws.name,
        repoName: card.repoName,
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

/**
 * Rows for pull requests that are **not on the board**, asked for by number.
 *
 * `recent` above trims the settled rows to `RECENT_MAX` because a board is a screen and
 * twelve merged rows per repo is as much as anybody reads. That trim is a decision about
 * a display and it has no business deciding anything else — but until bc-xl7n.108 it did:
 * `sweepReleases` in lib/release.js took its work list from `card.prs`, so a merge closed
 * its ship bead only for as long as nothing pushed it off the twelve. On a repo that
 * merges in batches — this one — thirteen merges inside three minutes is enough, and on
 * 2026-08-17 exactly that happened: nine pull requests merged at 23:47–23:49, thirteen
 * more merged by 23:54, and the nine were off the board before the next sweep tick ran.
 * Their ship beads stayed open for four days and nothing ever logged a line about them,
 * because nothing walked the *tracker's* side of the join.
 *
 * So this is the other direction of the same question, and it is deliberately narrow:
 * given numbers something else already knows it cares about, say what those pull requests
 * are, with the same lamps every board row carries. It is not "the board, uncapped" —
 * enriching forty rows per repo per poll is nine `git` calls apiece for prose nobody is
 * reading, which is the reason the cap exists at all.
 *
 * One `gh pr view` per number, in series, and the caller is expected to have bounded the
 * list: this runs on the sweep's clock and the ordinary answer is an empty array.
 *
 * `deploys` is **this repo's** records, already narrowed — the sweep groups the journal
 * once per tick rather than once per row, and re-filtering here would mean this file's
 * idea of the key having to agree with a grouping that has already happened.
 */
export async function offBoardRows(bd, ws, card, numbers, deploys = []) {
  if (!card?.dir || !card?.repo || !numbers?.length) return [];
  const boot = await BOOT;
  const prefix = await prefixFor(bd, ws);
  const seen = new Map();
  // The address every row on this card wears. `card.key` on any board this daemon builds;
  // the fallback is for the shape a card had before a workspace could be forty repos, and
  // costs nothing to keep honest here rather than producing `undefined#425`.
  const key = card.key ?? card.workspace;
  const rows = [];
  for (const number of numbers) {
    let got;
    try {
      got = await pr.viewDetail(card.dir, number);
    } catch {
      // A pull request this Mac cannot ask about is one this tick has no answer for — a
      // rate limit, a network, a repository that moved. Skipped rather than reported as a
      // state, because "could not ask" must never come back reading as "not merged".
      continue;
    }
    // Only merges. An open pull request is on the board by construction (`recent` never
    // ages one out), so anything else reaching here is a number whose bead is about
    // something that closed *unmerged* — and what to do about that is a different
    // decision, taken somewhere else.
    if (got.state !== 'MERGED') continue;
    const commit = got.mergeCommit;
    const [pushed, local, deployed] = await Promise.all([
      contains(card.dir, `origin/${card.base}`, commit),
      contains(card.dir, card.base, commit),
      card.deployTracked && boot ? contains(card.dir, boot.commit, commit) : Promise.resolve(null),
    ]);
    const out = {
      ...got,
      key: `${key}#${got.number}`,
      repoKey: key,
      workspace: ws.name,
      repoName: card.repoName,
      repo: card.repo,
      merged: true,
      pushed,
      local,
      deployed,
      deployTracked: card.deployTracked,
      deployDeclared: card.deployDeclared,
      deployHint: card.deployHint,
      beads: await beadsFor(bd, ws, prefix, got, seen),
      /**
       * The mark that keeps this row out of everything a board row is *for*.
       *
       * It never reaches a phone — nothing puts these on `card.prs` — and lib/release.js
       * reads it to refuse the one thing a row off the board must not do: arm a deploy.
       * The Ship button's queue is `owedFor`, which is board-derived, so a batch that
       * quietly included a merge the queue never counted would deploy a number the very
       * screen it came from does not show.
       */
      offBoard: true,
    };
    out.shipped = shippedState(out, deploys);
    out.stage = stageOf(out, deploys);
    out.note = noteFor(out);
    rows.push(out);
  }
  return rows;
}

/** The board's key on the shared layer. One board per daemon, so no scope after the colon. */
const BOARD_KEY = 'board:';

/**
 * Every repo's pull requests, swept together.
 *
 * Cached for `CACHE_MS` because the page behind it polls and the sweep is a `gh` call
 * per repo plus a handful of `bd` lookups — a board that re-ran on every request would
 * make two phones looking at it twice the work of one. `force` is the ⟳ on the page,
 * which must mean *now*, or it is a lie about a screen whose whole subject is whether
 * something has happened yet. It reaches lib/cache.js as `refresh` and keeps meaning
 * exactly that, including joining a sweep already in flight rather than starting a
 * second one — which is the right reading of ⟳ over a sweep that takes a minute.
 *
 * The deploy journal is read here, into the cached snapshot, and that is a deliberate
 * choice about staleness rather than an oversight: a stage is a fact about this board,
 * and a board whose lamps are 25 seconds old but whose *word* was recomputed per request
 * would be one screen disagreeing with itself. The release queue is the other way round
 * — `decorateBoard` rebuilds it from a fresh journal on every request — because a queue
 * is a thing you are about to press a button on. A deploy settling also busts this cache
 * from the page itself (`load({refresh: true})` in public/prs.js).
 *
 * **The return is a fresh shallow copy with `kept` on it**, not the swept object itself.
 * The copy is what makes the note on `decorateBoard` (lib/release.js) cheap to keep true
 * — every reader already had to treat the swept board as shared — and `kept` is how old
 * this answer is, which the route puts on the wire and out of the body. See `KEPT_HEADER`
 * in lib/cache.js. `repos` and `counts` are still shared by reference, exactly as before:
 * nothing may write into them.
 */
export async function collectBoard(bd, cfg, { force = false, boot: override, deploys: journal } = {}) {
  // **A forced sweep drops the key first, rather than only asking for `refresh`.**
  //
  // lib/cache.js's `refresh: true` *joins* a sweep already in flight, and it is right to:
  // a producer that started a moment ago is reading its source now, so it is exactly as
  // fresh as one started here would be. That argument does not hold for this one producer,
  // because this producer reads **another cache**. A background board refresh takes its
  // rows from `prs:<checkout>`, which is two minutes wide; joining it would hand an acting
  // call — a merge, a close, a Ship — pull requests that `gh` last answered for two minutes
  // ago, while the code around it believes it re-swept. `drop` takes the in-flight slot with
  // it (see `generation` in lib/cache.js), so the read below really does start a sweep, and
  // that sweep really does force its way through to `gh`.
  //
  // The cost is that two ⟳ a second apart are two sweeps. They always were: the board had
  // no single-flight at all before this, so nothing regresses and the guarantee survives.
  if (force) cache.drop(BOARD_KEY);
  const got = await cache.read(BOARD_KEY, () => sweepBoard(bd, cfg, { force, override, journal }), {
    freshMs: CACHE_MS,
    refresh: force,
  });
  return { ...got.value, kept: cache.combine([got]) };
}

async function sweepBoard(bd, cfg, { force, override, journal }) {
  const gh = await pr.available();
  // `boot` is the daemon's own commit, read once at import. The override exists so the
  // test can put a known commit there — the whole deployed column is ancestry against
  // this value, and a test that could not set it could only ever assert "not tracked".
  const boot = override === undefined ? await BOOT : override;
  if (!gh.ok) {
    // A board with no `gh` is one sentence, not an error: this is the single
    // dependency in beadcause that is allowed to be absent.
    return { unavailable: gh.reason, repos: [], build: boot, counts: empty(), at: new Date().toISOString() };
  }

  const seen = new Map();
  // Read once for the whole sweep. The override is the test's, for the same reason `boot`
  // has one: two of the six rungs are answers about deploys, and a test that could not
  // put a record in the journal could only ever assert the other four.
  const deploys = journal === undefined ? listDeploys({ limit: 200 }) : journal || [];
  // One card per repo, and a workspace with an approved list is many of them. Bounded
  // because forty repos is now a possible number — see `SWEEP_AT_ONCE`.
  const units = (cfg.workspaces || []).flatMap((ws) => repoUnits(cfg, ws.name).map((u) => ({ ...u, ws })));
  const repos = await atMost(units, SWEEP_AT_ONCE, (unit) => forRepo(bd, cfg, unit, { boot, seen, force, deploys }));

  // Repos with something to act on first; a repo with no pull requests at all sinks,
  // but never disappears — "no PRs here" is an answer you came for too.
  const weight = (c) => c.prs.filter((p) => p.stage === 'review' || p.stage === 'merged' || p.stage === 'pushed').length;
  repos.sort((a, b) => weight(b) - weight(a) || b.prs.length - a.prs.length || a.key.localeCompare(b.key));

  return { unavailable: null, repos, build: boot, counts: count(repos), at: new Date().toISOString() };
}

/**
 * The same board with only the repos an account can see, and its counts taken again
 * over what is left.
 *
 * A *narrowing of the answer*, deliberately, rather than a narrowing of the sweep. The
 * sweep is cached for the whole daemon and shared by every caller (see `CACHE_MS`), so
 * building it per account would make switching account cost a full `gh` walk of every
 * repo — and the rows are identical either way. What must not survive the narrowing is
 * `counts`: it is drawn as a number over the columns, and a board showing three cards
 * above a count of eleven is the kind of wrong that reads as a bug in the board rather
 * than as eight cards belonging to your other life.
 *
 * Returns the board untouched when nothing is dropped, so an install with no accounts
 * hands back the very object it cached.
 */
export function narrowBoard(board, keep) {
  if (!board || !Array.isArray(board.repos) || typeof keep !== 'function') return board;
  const repos = board.repos.filter((card) => keep(card));
  if (repos.length === board.repos.length) return board;
  return { ...board, repos, counts: count(repos) };
}

/**
 * Drop the cached sweep — for anything that just changed what a sweep would find.
 *
 * It drops the per-repo `gh` cache with it, and that is the point rather than a side effect.
 * Every caller of this has just *acted* at GitHub — merged, closed, commented — so the thing
 * that is now wrong is the `gh` answer, not the ancestry derived from it; a board rebuilt
 * from two-minute-old rows would still draw a merged pull request as open. `dir` narrows it
 * to the checkout that was acted on, which is what the callers who know it pass; with no
 * argument every repo is asked again, which is exactly what happened before `ROWS_MS`
 * existed.
 */
export const forgetBoard = (dir = null) => {
  cache.drop(BOARD_KEY);
  if (dir) cache.drop(rowsKey(dir));
  else cache.dropPrefix(ROWS_PREFIX);
};

/**
 * Fill the board's key if nothing is kept for it, and never otherwise. bc-1kwl.4.
 *
 * **The only warmer in this repo that is allowed to reach the network, and it is
 * allowed exactly once per daemon.** bc-1kwl.4's acceptance has two halves that pull
 * against each other: the pull request board's first paint must be under a second, and
 * daemon `gh` traffic with nobody looking must not rise. A board kept fresh on the poll
 * would be a `gh pr list` per repo every thirty seconds all day, which is the second
 * half broken outright — it is why the release queue has a clock of its own (see
 * `sweepRelease` in lib/server.js) and why that clock is five minutes rather than
 * thirty seconds.
 *
 * Cold-only is the shape that satisfies both. After the first sweep something is kept
 * for this key forever — nothing here evicts — so a phone arriving an hour later is
 * served from memory and the refresh lands behind it, exactly as it would have. The
 * steady-state traffic this adds is therefore *none*: with nobody looking and the key
 * filled, this function makes no call at all.
 *
 * What it does add is one board sweep per daemon start, which the release queue would
 * otherwise have made five minutes later. That window is not an arbitrary five minutes:
 * a beadcause deploy *is* a daemon restart, so it is the five minutes right after a
 * merge — which is when somebody is most likely to open the board to watch the thing
 * they just merged go out, and the one time it was guaranteed to be cold.
 *
 * `gh` being absent needs no special case: `collectBoard` answers `{ unavailable }`,
 * that answer is kept like any other, and so this never asks again.
 *
 * Returns whether it swept, for the log line and for the suite.
 */
export async function warmBoard(bd, cfg) {
  if (cache.peek(BOARD_KEY)) return false;
  await collectBoard(bd, cfg);
  return true;
}

/**
 * The card a request is about: by key, or — for a caller that only knows the GitHub repo —
 * by slug within a workspace.
 *
 * The second way exists for one caller and it is not a convenience. A delivery card in the
 * inbox carries `repo: Climative/athena-service` and a pull request number, because that is
 * what identifies a pull request anywhere outside this Mac; what it does *not* carry is which
 * of forty checkouts on this laptop that repo is. Answering "the workspace's directory" — as
 * every path here did before bc-l853.6 — means `gh pr merge` running in `architecture` for a
 * pull request in `athena-service`, and `gh` obliges, because `architecture` has a #123 too.
 *
 * Null when nothing matches, which the callers turn into a refusal rather than a fallback.
 */
export function pickCard(board, { key = '', workspace = '', slug = '' } = {}) {
  const cards = board?.repos || [];
  if (key) return cards.find((c) => (c.key ?? c.workspace) === key) || null;
  const want = String(slug || '').toLowerCase();
  if (want) {
    const inWs = cards.filter((c) => !workspace || c.workspace === workspace);
    return inWs.find((c) => String(c.repo || '').toLowerCase() === want) || null;
  }
  // A workspace and nothing else. It is only an answer where the workspace is one repo;
  // where it is forty, the caller has not said which and must not be given one.
  const mine = cards.filter((c) => c.workspace === workspace);
  return mine.length === 1 ? mine[0] : null;
}

/**
 * Which of a multi-repo workspace's checkouts have an open pull request against them
 * right now — bc-xl7n.103.
 *
 * `watchOwnBase` in lib/server.js only ever runs for a workspace that is *one* repo,
 * for the reason its own comment gives: forty `gh api …/check-runs` calls every five
 * minutes to answer a question that matters at one of them is the wrong trade. But
 * "nothing is queued" (`anyQueued`, lib/mergeadvocate.js) is not "nothing is open" — the
 * merge queue only ever asks about a base once something has been *delivered* into it,
 * and a repo can carry an open pull request for hours before anybody queues it. So a
 * red base under one sits unfiled and unnoticed for exactly as long as it did before
 * `bc-arf8` existed, on the one workspace with the most repos to hide it in.
 *
 * The board is the answer already being paid for: `collectBoard` asks every approved
 * repo for its pull requests on its own short cache, kept warm by anyone with the PR
 * page open and by `warmBoard` once at daemon start either way. This is a *narrowing*
 * of that answer, not a second sweep — the repos worth asking a red base about are the
 * ones the board already says have something open, which is a much smaller set than
 * every approved repo and exactly the set where the red base costs somebody something.
 *
 * A draft is excluded for the reason `anyQueued` excludes one: nothing can merge it, so
 * a red base underneath it costs nobody anything today. A card `forRepo` already gave
 * up on — no directory, or an error reading it — has nothing here to check a base
 * against either.
 */
export function openBaseCards(board, workspaceName) {
  const cards = board?.repos || [];
  return cards.filter(
    (c) =>
      c.workspace === workspaceName &&
      c.dir &&
      !c.error &&
      (c.prs || []).some((p) => String(p?.state || '').toUpperCase() === 'OPEN' && !p.isDraft)
  );
}

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

/** How many dirty paths a refusal names before it stops listing them. */
const DIRT_SHOWN = 3;

/** The porcelain lines, minus the blank one at the end. */
const dirtLines = (porcelain) => porcelain.split('\n').filter((l) => l.trim());

/** Nothing here is anybody's unsaved edit — every line is a file git has never seen. */
const allUntracked = (lines) => lines.length > 0 && lines.every((l) => l.startsWith('??'));

/**
 * Which paths, short enough to sit in a bead comment.
 *
 * `git status --porcelain` lines are `XY path`, and a rename is `XY old -> new`, where
 * the new name is the one worth printing.
 *
 * This used to end `(all untracked)` where nothing was edited, because that was the
 * fact a reader acted on: the difference between "leave it, that is Adam mid-edit" and
 * "that is residue, and clearing it unblocks every delivery on this laptop". bc-45g8
 * retired the suffix by making it unreachable — a checkout whose every dirty line is
 * `??` is now fast-forwarded rather than described, so nobody has to clear it. Anything
 * still refused has at least one edited path in it, whatever else the list holds.
 */
function listDirt(lines) {
  const paths = lines.map((l) => l.slice(2).trim().split(' -> ').pop());
  const more = paths.length - DIRT_SHOWN;
  return paths.slice(0, DIRT_SHOWN).join(', ') + (more > 0 ? ` and ${more} more` : '');
}

/**
 * Bring the local `base` up to what GitHub now has — the "& push" half of the button.
 *
 * `gh pr merge` puts the merge commit on `origin/main` itself, so by the time this
 * runs the work is already off the laptop and safe; what is left is that the Mac's own
 * `main` is a commit behind, which is how a session started an hour later ends up
 * branching from before the merge.
 *
 * Everything about it is deliberately timid, and the guard is the same one step 4 of
 * the ship skill insists on: a checkout with **edited work** in it is not touched and
 * says so. Adam edits inside these repos while sessions run, and a daemon that
 * fast-forwarded over a dirty tree from a phone in another room would be the single
 * most destructive thing in this codebase.
 *
 * *Edited* work, and no longer any dirt at all — bc-45g8, and the one thing about this
 * function that has ever been relaxed. The reason the guard exists is unsaved edits, and
 * an untracked file is not an edit to anything; meanwhile the checkout is **shared**, so
 * a single `.DS_Store` used to hold up every session's fast-forward on this Mac at once,
 * and the two paths that actually do it are the two the Finder and a JetBrains IDE
 * recreate. What makes the relaxation safe is that the destructive case is already
 * covered a second time, by git: `merge --ff-only` refuses outright rather than clobber
 * an untracked file an incoming commit would write, and that refusal is reported below
 * like any other. `scripts/deploy-runner.mjs` has always read its own dirt with
 * `--untracked-files=no` for the same reason. A tracked modification still stops it dead.
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

  // Which paths, and not merely that there are some. The porcelain output is already
  // here and used to be thrown away, so `there is uncommitted work in beadcause` left a
  // session no way to tell its own mess from somebody else's — and because this refusal
  // was silent about *what*, one stray path held up **every** delivery on this Mac until
  // a person happened to look. That is bc-s7fs: a `.beads/` left behind by a reverted
  // `bd init` held the fast-forward for a day and 114 commits, and each session that hit
  // it paid to rediscover why. bc-45g8 then went the rest of the way — residue no longer
  // *stops* it, only edited work does — so the list below is now read either over a
  // genuine refusal or beside a fast-forward that stepped past it.
  const lines = dirtLines((await ok(git(dir, ['status', '--porcelain']))) || '');
  const untrackedOnly = allUntracked(lines);
  if (lines.length && !untrackedOnly) {
    out.note =
      `left ${base} where it is — there is uncommitted work in ${path.basename(dir)}: ` +
      listDirt(lines);
    return out;
  }

  const ff = await gitCode(dir, ['merge', '--ff-only', `origin/${base}`]);
  out.advanced = ff.code === 0;
  // Say when it went past residue, because "fast-forwarded" over a checkout the reader
  // knows is dirty otherwise reads as the guard having failed rather than having been
  // asked a narrower question. And on the failure, name the untracked paths beside git's
  // own first line: where it refused *because* of them, they are the thing to clear.
  const past = untrackedOnly ? `, past untracked ${listDirt(lines)}` : '';
  out.note = out.advanced
    ? `fast-forwarded ${base} to origin/${base}${past}`
    : `could not fast-forward ${base} — ${ff.stderr.split('\n')[0] || 'it has commits origin does not'}` +
      (untrackedOnly ? ` (untracked here: ${listDirt(lines)})` : '');
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
 * Everything below it is unchanged, deliberately: the refusal over edited work is the
 * same refusal, in the same words, for the same reason. Adam edits in these checkouts
 * while sessions run, and a worker at three in the morning has even less business
 * fast-forwarding over open files than a phone in another room does. What it will step
 * past — untracked residue, and only that — it steps past for both of them equally.
 */
export async function landParent(dir, base = 'main') {
  const home = (await ok(mainCheckout(dir))) || path.resolve(dir);
  return { ...(await landLocally(home, base)), dir: home };
}
