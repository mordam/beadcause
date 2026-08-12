import { execFile } from 'node:child_process';
import fs from 'node:fs';

/**
 * The one place that shells out to `gh`.
 *
 * Everything above this file — the delivery question, the answer that merges it,
 * the worktree sweep that waits for the merge — asks *questions* about a pull
 * request and never learns how one is fetched. That matters more here than it
 * usually does, because `gh` is the single dependency in beadcause that can be
 * absent, unauthenticated, or pointed at a repo that has no remote at all, and
 * each of those has to degrade into something readable rather than a stack trace
 * on a phone.
 *
 * Three rules, the same three the rest of the daemon keeps:
 *
 * 1. **Nothing here writes to a branch.** It opens, reads, comments on, merges and
 *    closes pull requests. The commits are the session's business; there is
 *    deliberately no `push` in this file, and no `git` at all — everything it does,
 *    it does through GitHub's own API, where the act is gated and logged.
 *
 *    That rule outlived the reason first given for it. It used to read "landing them
 *    is Adam's, through the inbox", because the only caller that merged was his tap
 *    on a delivery card. A worker now merges its own pull request (bin/deliver.js),
 *    so `merge()` below has two callers with very different amounts of judgement
 *    behind them — and the rule still holds, because it was never really about who
 *    presses merge. It is about there being exactly one route into `main`: a pull
 *    request, with a diff, a number and a merge commit, that GitHub recorded. A
 *    `push` in this file would be a second route with none of that.
 * 2. **A missing `gh` is a state, not a crash.** `available()` answers it and every
 *    caller is expected to have asked. The whole PR channel switches off cleanly when
 *    the answer is no, which is what makes this safe to ship into a repo with no
 *    GitHub remote — and it switches back on by itself, because a no expires where a
 *    yes does not.
 * 3. **The merge is checked before it is attempted, and reported after.** A merge
 *    refused by GitHub — failing checks, a conflict, a review gate — comes back as
 *    a 409 with GitHub's own sentence in it, because "it didn't merge" with no
 *    reason attached is the single most annoying thing this could tell you from
 *    another room.
 */

/** How long any one `gh` call may take. Network-bound, so generous but finite. */
const TIMEOUT_MS = 30000;

/**
 * The fields a delivery question needs, in `gh pr view --json` vocabulary.
 *
 * Named once because three callers want the same set and a PR fetched with fewer
 * fields renders as a card with holes in it — worse than not rendering at all,
 * since the holes look like the PR is missing things rather than the query.
 */
export const PR_FIELDS = [
  'number',
  'url',
  'title',
  'state',
  'isDraft',
  'mergeable',
  'mergeStateStatus',
  'headRefName',
  'baseRefName',
  'additions',
  'deletions',
  'changedFiles',
  'statusCheckRollup',
  'reviewDecision',
  'mergedAt',
  'mergeCommit',
].join(',');

/** `gh` with a working directory, resolved to stdout or rejected with its first stderr line. */
function gh(args, { cwd, timeout = TIMEOUT_MS, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, timeout, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const detail = String(stderr || err.message || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      // gh writes its real complaint on the first non-empty stderr line and then
      // often a usage hint under it. The first line is the sentence worth putting
      // on a card; the rest is for the log.
      const message = detail[0] || 'gh failed';
      reject(Object.assign(new Error(message), { detail: detail.join(' — '), code: err.code ?? null }));
    });
  });
}

let cached = null;

/**
 * How long a *no* is believed before `gh` is asked again, and the ceiling it backs
 * off to.
 *
 * A yes is kept forever (see below); a no is not, because a no is exactly the answer
 * somebody is standing at the keyboard about to change. One minute is short enough
 * that `gh auth login` in a terminal starts working before anyone gives up on it, and
 * long enough that a Mac with no `gh` at all does not pay a process spawn per poll
 * tick. It doubles from there to a quarter of an hour, so a permanently
 * unauthenticated daemon settles into four checks an hour rather than sixty.
 */
const RECHECK_MS = 60000;
const RECHECK_MAX_MS = 15 * 60 * 1000;

/** When the current no stops being believed, and how long it was held for. */
let missUntil = 0;
let missWait = 0;

/** An ask already in flight, so a burst of callers costs one `gh auth status`. */
let asking = null;

/**
 * The one command that makes a fresh `gh auth login` visible to the daemon *now*
 * rather than at the next re-check.
 *
 * Deliberately duplicated from `restartCommand()` in lib/tlsswitch.js rather than
 * imported: this file's only imports are node builtins, which is what keeps it out of
 * the lib/ import graph entirely — and importing a lib/ module here to save one line
 * of string interpolation would reorder that graph for everything that loads pr.js.
 */
const restart = () => `launchctl kickstart -k gui/${process.getuid?.() ?? 501}/m4m.beadcause`;

/** Ask `gh`, and remember the answer for as long as that particular answer deserves. */
async function ask(now) {
  try {
    await gh(['auth', 'status'], { timeout: 10000 });
    cached = { ok: true, reason: '' };
    missWait = 0;
    missUntil = 0;
  } catch (err) {
    cached = {
      ok: false,
      reason: /not found|ENOENT/i.test(err.message)
        ? 'the gh CLI is not installed — `brew install gh`'
        : `gh is not authenticated in the daemon — \`gh auth login\`, then \`${restart()}\` (${err.message})`,
    };
    missWait = missWait ? Math.min(missWait * 2, RECHECK_MAX_MS) : RECHECK_MS;
    missUntil = now + missWait;
  }
  return cached;
}

/**
 * Is there a usable `gh` on this Mac?
 *
 * A **yes** is cached for the life of the process on purpose: it is asked on every
 * poll, it does not stop being true, and asking GitHub each tick would turn a check
 * into traffic.
 *
 * A **no** is not, and holding one used to be a real outage rather than a quirk. The
 * daemon boots at login, before anybody has logged into anything; it asked once, got
 * "not authenticated", and then answered every PR card, every delivery question and
 * every merge with that same sentence until it was restarted. The sentence told you
 * to run `gh auth login` — which is precisely what did not help, because the process
 * was no longer listening. So a no expires: it is re-asked after `RECHECK_MS`, backing
 * off to `RECHECK_MAX_MS`, and the reason names the restart as the way to skip the
 * wait rather than as the only way through.
 *
 * `now` is a parameter for the same reason `sleep` is one on `settle()` below —
 * otherwise the test that proves a no expires has to take a minute to do it.
 */
export async function available({ now = Date.now() } = {}) {
  if (cached?.ok) return cached;
  if (cached && now < missUntil) return cached;
  if (asking) return asking;
  asking = ask(now).finally(() => {
    asking = null;
  });
  return asking;
}

/* ------------------------------------------------------------ which account */

/**
 * `gh` has one *active* account, this Mac has two, and the wrong one is a silent
 * downgrade rather than an error anyone can read.
 *
 * The work account is the active one, because that is what the day job needs. Every
 * personal repo here — sophab, deluvia, ehatt — is private and owned by the other
 * account, so `gh repo view` in one of those checkouts answers:
 *
 *     GraphQL: Could not resolve to a Repository with the name 'NeanderthalMan/sophab'
 *
 * which is indistinguishable, from `slugFor`'s side, from a directory with no GitHub
 * remote at all. So `slugFor` was null, `prMode` was null, and every worker the
 * advocate opened on those three repos got the *older* brief: no propose channel, no
 * delivery, close your own bead and hope somebody reads the comment. Which `gh`
 * account happened to be active decided how much a worker was allowed to say.
 *
 * The fix stays inside beadcause and changes nothing global. `gh auth switch` would
 * also have worked and is exactly what must not happen: it would repoint Adam's
 * Climative work as a side effect of a personal repo becoming visible. Instead each
 * checkout is probed once — the ambient account first, then every other account
 * `gh auth status` lists, each with its own token passed in `GH_TOKEN` for that one
 * call — and whichever could see it is remembered for that directory. Nothing on disk
 * is touched and `gh auth status` reports the same active account afterwards.
 *
 * The probe happens once per directory per process, failures included — a checkout
 * nothing can see is remembered as "ambient", so it costs one sweep rather than one
 * per `gh` call. Like `available()` above, the way to change the answer after a
 * `gh auth login` is to restart the daemon.
 */
const accountFor = new Map();
const tokens = new Map();
let accountsCache = null;
/** The default branch of each repo we have asked about, keyed by `owner/repo`. */
const defaultBranches = new Map();

/** Every account `gh auth status` lists, with the active one flagged. */
async function accountList() {
  if (accountsCache) return accountsCache;
  const list = [];
  try {
    const out = await gh(['auth', 'status'], { timeout: 10000 });
    let current = null;
    for (const line of out.split('\n')) {
      // "✓ Logged in to github.com account mordam (keyring)", then an indented
      // "- Active account: true" under it. A gh that prints neither leaves the list
      // empty, which is an ordinary answer meaning "ambient account only".
      const named = line.match(/\baccount\s+(\S+)/);
      if (named) {
        current = { user: named[1], active: false };
        list.push(current);
        continue;
      }
      if (current && /Active account:\s*true/i.test(line)) current.active = true;
    }
  } catch {
    // No gh, or no login at all. `available()` is what reports that; here it only
    // means there is no second account worth trying.
  }
  accountsCache = list;
  return accountsCache;
}

/** One account's token, or null. Cached — it is a keyring read and it cannot change mid-run. */
async function tokenOf(user) {
  if (tokens.has(user)) return tokens.get(user);
  let token = null;
  try {
    token = (await gh(['auth', 'token', '--user', user], { timeout: 10000 })).trim() || null;
  } catch {
    token = null;
  }
  tokens.set(user, token);
  return token;
}

/**
 * The environment one `gh` call runs in.
 *
 * `''` means the ambient account — no `GH_TOKEN`, whatever `gh auth status` calls
 * active — and it is deliberately the default, so a Mac with a single login behaves
 * exactly as it did before any of this existed.
 */
async function envOf(user) {
  if (!user) return undefined;
  const token = await tokenOf(user);
  return token ? { ...process.env, GH_TOKEN: token } : undefined;
}

/** `owner/repo` as one account sees it, or null when that account cannot see it. */
async function seenBy(dir, user) {
  try {
    const out = await gh(['repo', 'view', '--json', 'nameWithOwner'], { cwd: dir, env: await envOf(user) });
    return JSON.parse(out).nameWithOwner || null;
  } catch {
    return null;
  }
}

/** Which account can see `dir`, and what the repo there is called. Null when none can. */
async function resolve(dir) {
  if (!dir || !fs.existsSync(dir)) return null;

  const known = accountFor.get(dir);
  if (known !== undefined) {
    const slug = await seenBy(dir, known);
    return slug ? { user: known, slug } : null;
  }

  const ambient = await seenBy(dir, '');
  if (ambient) {
    accountFor.set(dir, '');
    return { user: '', slug: ambient };
  }

  for (const acct of await accountList()) {
    // The active account *was* the ambient attempt above; asking it again would
    // double the cost of every local-only checkout and learn nothing.
    if (acct.active) continue;
    if (!(await tokenOf(acct.user))) continue;
    const slug = await seenBy(dir, acct.user);
    if (slug) {
      accountFor.set(dir, acct.user);
      return { user: acct.user, slug };
    }
  }

  // Nothing could see it, and that is remembered too — as the ambient account, which
  // is what the callers below should run as anyway so the error they surface is
  // `gh`'s. Not remembering it meant every single call in a local-only checkout paid
  // for a fresh sweep of every account, so one `merge()` cost three of them.
  accountFor.set(dir, '');
  return null;
}

/**
 * The account a call against `dir` should run as, probing if this is the first one.
 *
 * Falls back to the ambient account when nothing resolved, so what the caller sees is
 * `gh`'s own sentence about that repo rather than one invented here.
 */
async function accountIn(dir) {
  if (accountFor.has(dir)) return accountFor.get(dir);
  const found = await resolve(dir);
  return found ? found.user : '';
}

/** `gh`, in a checkout, as whichever account can see that checkout. */
async function ghIn(dir, args, opts = {}) {
  return gh(args, { ...opts, cwd: dir, env: await envOf(await accountIn(dir)) });
}

/** Forget the cached answers. For tests, and for anything that knows gh just changed. */
export const forgetAvailability = () => {
  cached = null;
  missUntil = 0;
  missWait = 0;
  accountsCache = null;
  accountFor.clear();
  tokens.clear();
  defaultBranches.clear();
};

/**
 * `owner/repo` for the checkout at `dir`, or null when no account here can see a
 * GitHub repo there.
 *
 * Null is a legitimate answer and every caller treats it as one: a workspace whose
 * checkout is local-only keeps the old ending — work the bead, close the bead — and
 * simply never gets a delivery question. Making that an error would mean one repo
 * without a remote breaks the advocate for all the others.
 */
export async function slugFor(dir) {
  const found = await resolve(dir);
  return found ? found.slug : null;
}

/**
 * The branch GitHub itself calls this repo's default, or null when it will not say.
 *
 * **Asked of GitHub, never of the checkout**, and the difference is not academic. The
 * obvious local answer is `git symbolic-ref refs/remotes/origin/HEAD`, which costs no
 * network and is wrong often enough to be dangerous: that ref is written once, by
 * `clone`, and nothing ever refreshes it. Every one of the forty-seven Climative
 * checkouts on this Mac was read on 2026-08-12, and three of them name an `origin/HEAD`
 * GitHub disagrees with —
 * `climative-api-service` and `synapse-repo` both say `origin/develop`, and
 * `frontend-base` says `origin/TECH-5989-bootstrap-nginx`, a feature branch — while
 * GitHub says `main` for all three. A delivery that trusted the local ref would open
 * those pull requests into a branch nobody merges, and it would do it silently, because
 * a PR into the wrong base is a perfectly valid pull request.
 *
 * Cached per `owner/repo` for the life of the process, because a repo's default branch
 * changes about once in its life and this is asked on the delivery path. A **null is not
 * cached**: it means `gh` is missing, unauthenticated or offline, and all three are the
 * kind of no that someone is at a keyboard fixing.
 */
export async function defaultBranch(dir) {
  const found = await resolve(dir);
  if (!found) return null;
  if (defaultBranches.has(found.slug)) return defaultBranches.get(found.slug);
  let name = null;
  try {
    const out = await ghIn(dir, ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']);
    name = String(out || '').trim() || null;
  } catch {
    // Every flavour of "cannot say" — no such repo, no auth, no network — is a null,
    // and the caller's own fallback is what decides what to do about it.
    return null;
  }
  if (name) defaultBranches.set(found.slug, name);
  return name;
}

/**
 * The same fields plus the three a *list* needs and a single PR doesn't.
 *
 * `body` is here because it is where a bead id is usually written — the delivery
 * block names one outright, and a hand-opened PR mentions it in a sentence — and
 * the board has no other way to know which bead a pull request belongs to. `author`
 * and the two timestamps are what let a list be sorted and aged; `view()` needs
 * neither, because a card you opened is self-evidently the one you meant.
 */
export const LIST_FIELDS = [PR_FIELDS, 'body', 'author', 'createdAt', 'updatedAt'].join(',');

/** Everything `gh pr view` knows about one PR, by number or by branch name. */
export async function view(dir, ref) {
  const out = await ghIn(dir, ['pr', 'view', String(ref), '--json', PR_FIELDS]);
  return normalize(JSON.parse(out));
}

/**
 * The four fields `normalize` deliberately leaves off, folded on.
 *
 * Kept out of `normalize` itself so a card built from `view()` never carries a `body`
 * key that is always empty — an absent field reads as "not asked for", an empty one as
 * "this PR has no description", and only one of those is true. Written once here rather
 * than twice because `list` and `viewDetail` want exactly the same four.
 */
const detailed = (row) => ({
  ...normalize(row),
  body: String(row.body || ''),
  author: row.author?.login || '',
  createdAt: row.createdAt || null,
  updatedAt: row.updatedAt || null,
});

/**
 * One pull request, with the half a *full view* needs on top of the half a merge does.
 *
 * `view()` above is what the merge is gated on and is deliberately narrow: the diffstat,
 * the checks, and whether GitHub will take it. A screen you *read* — the full-screen PR
 * view, bc-l8jp.7 — needs three more things that no card needed, and the board cannot
 * supply any of them:
 *
 * - **the description**, which lib/prboard.js strips from every row on purpose
 *   (`body: undefined`) because several thousand characters times twelve rows times six
 *   repos is the whole board payload, for prose nobody reads while scanning;
 * - **the datetimes** — opened, last touched, merged — which `list` carries and `view`
 *   does not, since a card you tapped is self-evidently the one you meant;
 * - **the author's login**, which is the fallback when nothing on this Mac can say which
 *   session produced the branch (see lib/prauthor.js).
 *
 * So: one `gh pr view` with the list's field set, made when a view is actually opened.
 * That ordering is the point — the board stays cheap, and the expensive read happens
 * once per pull request you decided to look at.
 */
export async function viewDetail(dir, ref) {
  const out = await ghIn(dir, ['pr', 'view', String(ref), '--json', LIST_FIELDS]);
  return detailed(JSON.parse(out));
}

/**
 * Every pull request in one repo, newest first — the board's only source of PRs.
 *
 * `--state all` rather than `open`, and that is the whole point of the view it
 * feeds: an open PR is a decision waiting, but a *merged* one is the question this
 * exists to answer — did it reach origin, and is it running? A list that stopped at
 * open would show nothing at exactly the moment you wanted to know.
 *
 * The limit is a limit on the query, not a filter on the answer: everything comes
 * back and lib/prboard.js decides what is recent enough to draw, because "how far
 * back" is a property of the screen and not of the repo.
 */
export async function list(dir, { limit = 40, state = 'all' } = {}) {
  const out = await ghIn(dir, ['pr', 'list', '--state', state, '--limit', String(limit), '--json', LIST_FIELDS], {
    timeout: 60000,
  });
  const rows = JSON.parse(out);
  return (Array.isArray(rows) ? rows : []).map(detailed);
}

/**
 * The fields a *merged* pull request is read for, which is a much smaller set.
 *
 * `LIST_FIELDS` above is the board's set, and the board is a screen about pull requests
 * that have not landed yet: whether GitHub will take it, what the checks say, how big
 * the diff is. None of that is a question you can still ask about a merge that already
 * happened — and one of those fields is not merely useless here, it is the expensive
 * one. `statusCheckRollup` walks every check run on every row, and measured against
 * this repo on 2026-08-11 it was the whole difference between **15.9 seconds** and
 * **2.2 seconds** for the same 152 merged pull requests. That factor of seven is what
 * pays for lib/landed.js asking about a fortnight instead of about forty rows.
 *
 * `body` stays, and is the only heavy thing left (~4KB a row, and no measurable time).
 * It is where a bead id is usually written — the delivery block names one outright —
 * so dropping it would quietly weaken `beadsFor` into guessing from titles and branch
 * names, which is a correctness cost paid to save bytes.
 */
export const MERGED_FIELDS = ['number', 'url', 'title', 'state', 'headRefName', 'baseRefName', 'mergedAt', 'mergeCommit', 'body'].join(',');

/**
 * A GitHub search stamp: whole seconds, UTC, which is the finest `merged:` understands.
 *
 * Rounded *outwards* — the lower bound down, the upper bound up — so the range asked for
 * always contains the range wanted. Truncating both would put the top of the window a
 * fraction of a second in the past, and the row it would drop is the one most worth
 * having: a pull request merged in the second the sweep ran. The cost is that adjacent
 * slices can overlap by a second, which the deduplication by number absorbs.
 */
const stampFrom = (t) => new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const stampTo = (t) => new Date(Math.ceil(t / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * Every pull request merged into this repo inside a window of *time* — not a row count.
 *
 * `list()` above takes a limit and answers newest-first, which is the right shape for a
 * screen and the wrong one for a sweep. lib/landed.js wants "everything merged in the
 * last fortnight", and asking for that as a row count means the count decides: forty
 * merged pull requests is under a day on this repo, so the fortnight was a ceiling it
 * never once touched, and a bead stranded past the fortieth row was stranded *for good*
 * — the next sweep asks the same question of a window that has moved further forward.
 * bc-8ug and bc-jin were both closed by hand for exactly that reason.
 *
 * So the window goes into the query, as GitHub's own `merged:A..B`, and the limit
 * becomes what it should always have been: a guard against a runaway answer.
 *
 * **The paging is a bisection, and it has to be.** The obvious page-by-date loop — take
 * the oldest row you got, ask again for everything older — is wrong here, because
 * `gh pr list --search` answers in *creation* order and not in merge order. A full page
 * is therefore an arbitrary subset with respect to `mergedAt`, and moving the bound to
 * its minimum would step straight over every row that merged in between and was not on
 * that page. Verified on this repo: 60 rows came back with `mergedAt` non-monotonic.
 * Halving the interval instead needs no assumption about order at all — a slice that
 * answers with fewer rows than the limit answered *whole*, and that is the only fact
 * being relied on. Ranges are inclusive at both ends, so the halves are split a second
 * apart and everything is deduplicated by number regardless.
 *
 * In practice this is one call. It only becomes two when more than `limit` pull
 * requests merged in the window, which on a repo doing 120 merges a day means about
 * four days' worth — and the alternative to those extra seconds is not a cheaper sweep,
 * it is beads going quietly missing.
 *
 * Returns `{ rows, complete, cap }`. `complete: false` is the honest version of the old
 * silence: the window was not covered. `cap` is then *which number stopped it* — the
 * row ceiling, the query budget, or the per-query limit against a slice already too
 * narrow to halve — because "a cap bit" is only actionable if you know which one.
 *
 * `maxRows` is a ceiling on *continuing to slice*, not on the answer: a single query
 * that overshoots it and leaves nothing left to ask is a covered window, and saying
 * otherwise would report a truncation that did not happen.
 */
export async function listMergedSince(dir, { since, until = Date.now(), limit = 500, maxRows = 4000, maxQueries = 24 } = {}) {
  const found = new Map();
  const slices = [[new Date(since).getTime(), new Date(until).getTime()]];
  let complete = true;
  let cap = null;
  let queries = 0;

  while (slices.length) {
    if (found.size >= maxRows || queries >= maxQueries) {
      complete = false;
      cap = found.size >= maxRows ? maxRows : maxQueries;
      break;
    }
    const [from, to] = slices.pop();
    if (to < from) continue;
    queries += 1;
    const out = await ghIn(
      dir,
      ['pr', 'list', '--state', 'merged', '--search', `merged:${stampFrom(from)}..${stampTo(to)}`, '--limit', String(limit), '--json', MERGED_FIELDS],
      { timeout: 120000 }
    );
    const rows = JSON.parse(out);
    for (const row of Array.isArray(rows) ? rows : []) if (!found.has(row.number)) found.set(row.number, detailed(row));
    // Short of the limit means the slice was answered whole, and there is nothing
    // hiding behind it. Only a full page is evidence that GitHub had more to say.
    if (!Array.isArray(rows) || rows.length < limit) continue;
    if (to - from < 2000) {
      // A one-second slice with more merges in it than the limit. Nothing left to
      // halve, so say so rather than looping.
      complete = false;
      cap = cap ?? limit;
      continue;
    }
    // The midpoint of the *interval*, and deliberately not anything cleverer. Splitting
    // at the median merge time of the page that just came back looks like the obvious
    // improvement — merges are bursty, and half of every clock-midpoint split can be the
    // small hours — and it is measurably worse: the page is the highest-numbered rows,
    // creation order tracks merge order because a pull request usually merges soon after
    // it is opened, so that median sits near the *top* of the interval every time. The
    // split then peels half a page off the recent end and recurses on almost the whole
    // window again. Measured on the 60-row bisection in test/landed.mjs: 21 queries for
    // the clock midpoint, 24 for the median, which is the query budget exhausted and a
    // covered window reported as truncated.
    const mid = from + Math.floor((to - from) / 2);
    slices.push([from, mid], [mid + 1000, to]);
  }

  const all = [...found.values()].sort((a, b) => String(b.mergedAt || '').localeCompare(String(a.mergedAt || '')));
  return { rows: all, complete, cap };
}

/**
 * The PR for a branch, or null when the branch has none.
 *
 * `gh pr view <branch>` fails rather than returning empty when nothing is open for
 * it, and "no PR yet" is the ordinary state of a branch a session is still working
 * on — so the failure is swallowed here and nowhere else.
 */
export async function viewForBranch(dir, branch) {
  try {
    return await view(dir, branch);
  } catch {
    return null;
  }
}

/**
 * Open a pull request and return it, fully populated.
 *
 * `gh pr create` prints only the URL, and a delivery question needs the diffstat
 * and the check state to be worth reading — so the create is followed by a view.
 * The number is parsed out of the URL rather than trusted from anywhere else: it
 * is the one identifier every later call uses.
 */
export async function create(dir, { base = 'main', head, title, body, draft = false }) {
  const args = ['pr', 'create', '--base', base, '--title', title, '--body', body || ''];
  if (head) args.push('--head', head);
  if (draft) args.push('--draft');
  const out = await ghIn(dir, args, { timeout: 60000 });
  const url = (out.match(/https:\/\/\S+\/pull\/\d+/) || [])[0];
  if (!url) throw new Error(`gh pr create said nothing that looks like a PR url: ${out.trim().split('\n').pop()}`);
  return view(dir, url.split('/').pop());
}

/** `setTimeout` as a promise. Injectable below so the wait can be tested without one. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a pull request's checks have stopped being pending, and hand back what
 * it looks like when they have.
 *
 * Only a worker about to merge its own work needs this, and it needs it badly. A pull
 * request is at its most pending in the two seconds after `gh pr create` returns: CI
 * has been triggered and nothing has reported. A worker that merged there would merge
 * every time before its own tests had spoken, and one that treated pending as a
 * refusal would fall back to asking Adam every single time — the change that let a
 * worker land its own work would land nothing.
 *
 * So it waits, and the two ways out of the wait are deliberately different states:
 *
 * - **The checks settled** — `passing`, `failing` or `none`. `timedOut` is false and
 *   the caller decides on the verdict.
 * - **They never did** — `timedOut` is true and `pr.checks.state` is still `pending`.
 *   That is not "safe to merge": a queue that has not run in fifteen minutes is a
 *   fact about CI, and merging over it would be merging over an unknown. The caller
 *   is expected to treat it as a refusal it can explain.
 *
 * `sleep` is a parameter because the alternative is a test that takes as long as the
 * thing it is testing. Nothing else passes it.
 */
export async function settle(dir, number, { timeoutMs = 300000, intervalMs = 10000, sleep = wait } = {}) {
  const started = Date.now();
  let pr = await view(dir, number);
  while (pr.checks.state === 'pending' && Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
    pr = await view(dir, number);
  }
  return { pr, waited: Date.now() - started, timedOut: pr.checks.state === 'pending' };
}

/**
 * How long to wait for GitHub to work out whether a pull request can merge, and how
 * often to ask while waiting.
 *
 * Thirty seconds because the window observed in life was twelve — `UNKNOWN UNKNOWN` on
 * the poll immediately after a push, `MERGEABLE CLEAN` on the same pull request twelve
 * seconds later. Three-second asks because each one is a single round trip, and the
 * cost of being a little eager is one extra `gh pr view` while the cost of being slow
 * is a session that ends in a card nobody needed.
 *
 * Deliberately not a config key. Nothing about it is a preference — it is the length of
 * a race in somebody else's bookkeeping, and a setting for it would be a setting whose
 * right value nobody here could know.
 */
const MERGEABILITY_TIMEOUT_MS = 30000;
const MERGEABILITY_INTERVAL_MS = 3000;

/**
 * Read a pull request, waiting out the window in which GitHub has not yet worked out
 * whether it can merge.
 *
 * `mergeable` is computed asynchronously, and for a few seconds after a push it is
 * `UNKNOWN` — not "we looked and cannot tell" but "we have not looked yet". That
 * matters because the only two things anyone does with this field are merge on it and
 * refuse on it, and `UNKNOWN` is grounds for neither.
 *
 * A worker lands in that window every single time. `bin/deliver.js` pushes, opens the
 * pull request, waits for the checks — and in a repo with no CI configured, which
 * beadcause itself is, `settle()` has nothing to wait for and returns on its first
 * read. The merge then goes out a second or so after the push, against a pull request
 * GitHub has not finished thinking about, and GitHub's merge endpoint refuses a pull
 * request whose mergeability is unresolved with *Pull request is not mergeable* —
 * which is word for word what it says about a real conflict. That refusal ends the
 * session, files a handover card and tells Adam his branch conflicts with main, over a
 * branch that merges perfectly well twelve seconds later.
 *
 * So this polls to a bounded deadline and hands back what it found, plus whether the
 * answer ever arrived. `unresolved: true` is a real ending and the caller must not read
 * it as a conflict: a conflict is `CONFLICTING`, which is something GitHub said, and
 * `UNKNOWN` is the absence of GitHub having said anything.
 *
 * The loop only turns on an **open** pull request, and that guard is load-bearing
 * rather than tidy: a merged or closed one reports `mergeable: UNKNOWN` for good, so
 * without it every already-merged answer would spend the whole timeout rediscovering
 * what its first read already knew.
 *
 * `sleep` is a parameter for the same reason it is one on `settle` above — otherwise
 * the test for this takes as long as the race it is about.
 */
export async function mergeability(
  dir,
  number,
  { timeoutMs = MERGEABILITY_TIMEOUT_MS, intervalMs = MERGEABILITY_INTERVAL_MS, sleep = wait } = {}
) {
  const started = Date.now();
  let pr = await view(dir, number);
  while (pr.mergeable === 'UNKNOWN' && pr.state === 'OPEN' && Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
    pr = await view(dir, number);
  }
  return { pr, waited: Date.now() - started, unresolved: pr.state === 'OPEN' && pr.mergeable === 'UNKNOWN' };
}

/**
 * Valid `gh pr merge` methods. An unknown one would fail at the CLI with a usage dump.
 *
 * Null-prototype so the lookup below is a real lookup: on a plain object literal,
 * `METHODS['constructor']` is truthy and would be pushed into argv as a function,
 * turning "unrecognised method" — which should quietly become a merge — into a
 * TypeError from execFile. Nothing reaches it with a method it did not validate
 * today, and that is exactly the kind of guarantee that stops being true later.
 */
const METHODS = Object.assign(Object.create(null), { squash: '--squash', merge: '--merge', rebase: '--rebase' });

/**
 * Merge it — the act the whole channel exists to gate.
 *
 * Two things are deliberate. The PR is re-read first, so a merge attempted against
 * something already merged, closed, or in conflict fails *here*, with a sentence
 * that names which of those it was, rather than as a raw `gh` error. And the merge
 * is never `--auto`: queuing a merge to happen later when checks go green would
 * mean the tap on the phone was a promise rather than an act, and the question
 * would close on work that had not landed. A worker that wants to merge once its
 * checks are green waits for them itself — see `settle` above — so that whatever
 * closes a bead is a merge that has already happened.
 *
 * `deleteBranch` is worth one warning, because its right value depends on where the
 * caller is standing. True for a tap from the phone: the daemon is in the main
 * checkout and the branch is almost never checked out there. False for a worker
 * merging its own pull request, because that caller *is* in a worktree with that
 * branch checked out — `gh` tidies the local branch after the remote one, cannot
 * delete a branch it is standing on, and would turn a merge that worked into a
 * command that failed.
 *
 * The preflight read is `mergeability` rather than a bare `view`, so nothing here is
 * decided from a mergeability GitHub has not computed yet. See it above; it costs one
 * `gh pr view` in every ordinary case and a handful of seconds in the one case that
 * used to end a session over a race.
 */
export async function merge(dir, number, { method = 'merge', deleteBranch = true, ...waiting } = {}) {
  // `merge`, not `squash`, when the caller says nothing or says something unknown: a
  // squash merge is the one method that leaves the branch a non-ancestor of main, and
  // the worktree cleanup at both ends of this repo keeps anything that fails that
  // test. See `pr.mergeMethod` in lib/config.js for the whole of the reasoning.
  const flag = METHODS[method] || METHODS.merge;
  const { pr, waited, unresolved } = await mergeability(dir, number, waiting);

  if (pr.state === 'MERGED') {
    return { ...pr, alreadyMerged: true };
  }
  if (pr.state === 'CLOSED') {
    throw Object.assign(new Error(`#${number} is closed — reopen it on GitHub before merging`), { status: 409 });
  }
  if (pr.mergeable === 'CONFLICTING') {
    // `pr.base`, not `pr.baseRefName`: this object has already been through
    // `normalize`, which is where gh's own field names stop applying. Reading the
    // raw name here put the word "undefined" in the one sentence on the one path
    // that exists to explain why the merge did not happen.
    throw Object.assign(
      new Error(`#${number} conflicts with ${pr.base} — the branch needs a rebase before it can merge`),
      { status: 409 }
    );
  }

  const args = ['pr', 'merge', String(number), flag];
  if (deleteBranch) args.push('--delete-branch');
  try {
    // Still `UNKNOWN` after the wait above, and the merge goes out anyway. GitHub's
    // merge endpoint is the only thing that can settle this, and it settles it
    // atomically — it either lands the merge or refuses it, and both are better
    // answers than one invented here from a field that never got filled in. What the
    // wait bought is that the refusal below can no longer be the race.
    await ghIn(dir, args, { timeout: 120000 });
  } catch (err) {
    // GitHub's own refusal is the most useful thing anyone will read here — a
    // failing check, a required review, a protected branch — so it travels intact.
    const said = String(err.detail || err.message || '').trim();
    if (!unresolved) throw Object.assign(new Error(said), { status: 409 });
    // Except when it refused a pull request it had not finished assessing. *Pull
    // request is not mergeable* is what GitHub says about a conflict and also what it
    // says about a mergeability it never computed, and repeating it alone would hand
    // Adam a card claiming his branch conflicts with main on no evidence at all. So
    // the sentence keeps GitHub's words and says what else they might mean.
    const secs = Math.max(1, Math.round(waited / 1000));
    throw Object.assign(
      new Error(
        `${/[.!?]$/.test(said) ? said : `${said}.`} GitHub had still not worked out whether #${number} could merge ` +
          `after ${secs}s of asking, so that may be what it is refusing rather than anything wrong with the branch — ` +
          `the same merge a minute later may well go through.`
      ),
      { status: 409 }
    );
  }
  return { ...(await view(dir, number)), alreadyMerged: false };
}

/** Close it without merging, with a reason on the PR so the tab is not a mystery later. */
export async function close(dir, number, { comment = '', deleteBranch = false } = {}) {
  const args = ['pr', 'close', String(number)];
  if (comment) args.push('--comment', comment);
  if (deleteBranch) args.push('--delete-branch');
  await ghIn(dir, args);
  return view(dir, number);
}

/** Say something on the PR. What "request changes" writes, so the thread is on GitHub too. */
export async function comment(dir, number, text) {
  await gh(['pr', 'comment', String(number), '--body', text], { cwd: dir });
}

/**
 * Fold `statusCheckRollup` into three numbers and a verdict.
 *
 * The raw array is one object per check run with nine fields each; a phone wants to
 * know whether it is safe to press merge. `pending` is kept separate from `failing`
 * because they mean opposite things: pending is "wait", failing is "don't".
 */
function rollup(checks) {
  const list = Array.isArray(checks) ? checks : [];
  let passing = 0;
  let failing = 0;
  let pending = 0;
  const failed = [];
  for (const c of list) {
    // Two shapes: CheckRun has status/conclusion, StatusContext has state.
    const state = String(c.conclusion || c.state || c.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state)) passing++;
    else if (['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED'].includes(state)) pending++;
    else {
      failing++;
      if (c.name || c.context) failed.push(String(c.name || c.context));
    }
  }
  return {
    total: list.length,
    passing,
    failing,
    pending,
    failed: failed.slice(0, 6),
    state: failing ? 'failing' : pending ? 'pending' : list.length ? 'passing' : 'none',
  };
}

/**
 * The shape everything above this file sees.
 *
 * `gh`'s own JSON is passed through where it is already the right thing and folded
 * where it isn't, so no caller has to know that `mergeCommit` is an object or that
 * a PR with no CI at all reports an empty array rather than a missing field.
 */
function normalize(pr) {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title || '',
    state: String(pr.state || '').toUpperCase(),
    draft: !!pr.isDraft,
    mergeable: String(pr.mergeable || 'UNKNOWN').toUpperCase(),
    mergeState: String(pr.mergeStateStatus || '').toUpperCase(),
    branch: pr.headRefName || '',
    base: pr.baseRefName || '',
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    files: pr.changedFiles ?? 0,
    checks: rollup(pr.statusCheckRollup),
    reviewDecision: pr.reviewDecision || null,
    mergedAt: pr.mergedAt || null,
    mergeCommit: pr.mergeCommit?.oid || null,
  };
}
