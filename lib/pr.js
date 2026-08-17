import { execFile } from 'node:child_process';
import fs from 'node:fs';
// A leaf that imports nothing — see the note at the top of lib/timing.js.
import { spend } from './timing.js';

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
  // `reviewDecision` alone can never tell beadcause that a review happened *here*, and
  // that is not a subtlety — it is the whole reason this field is in the list.
  //
  // GitHub's `reviewDecision` answers "does this pull request satisfy its review
  // *requirement*", not "has anybody approved it". A repo with no branch protection and
  // no ruleset has no requirement, so the answer is the empty string however many
  // approving reviews are sitting on the pull request. mordam/beadcause is exactly that
  // repo — measured 2026-08-17: `repos/mordam/beadcause/branches/main/protection` is a
  // 404 and `.../rulesets` is `[]`, and `reviewDecision` is `""` on every one of the
  // last thirty pull requests, merged and open alike.
  //
  // `latestReviews` is the same question asked of the reviews themselves: the most
  // recent review from each reviewer, with its state. It is what an approval is
  // actually visible in, and it costs nothing measurable — timed against this repo the
  // same day, a forty-row `gh pr list` with the field and without it both came back in
  // 3.5–4.3s, which is the noise. Unlike `statusCheckRollup`, it is not a walk over
  // every check run on every row.
  'latestReviews',
  'mergedAt',
  'mergeCommit',
].join(',');

/** `gh` with a working directory, resolved to stdout or rejected with its first stderr line. */
function gh(args, { cwd, timeout = TIMEOUT_MS, env } = {}) {
  return new Promise((resolve, reject) => {
    // The `gh` half of the request timing — the other chokepoint beside `Bd.run`, and
    // the more expensive one per call, because this is a network round trip to GitHub
    // rather than a local process. See lib/timing.js.
    const spawned = process.hrtime.bigint();
    execFile('gh', args, { cwd, timeout, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      spend('gh', spawned);
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
 *
 * Seeing a repo is not the same as being allowed to change it, and asking only the
 * first question put the merge queue on the wrong account. beadcause itself lives in
 * `mordam/beadcause`, which *both* logins can see — the active one as a collaborator
 * with READ, the owner with ADMIN. So the ambient probe succeeded, short-circuited
 * the sweep, and every `gh` call in that checkout ran as the account that may only
 * read it. Reading a PR worked. Merging one came back as:
 *
 *     GraphQL: NeanderthalMan does not have the correct permissions to execute
 *     `MergePullRequest`
 *
 * at the end of a ship, after the work was already done. So the probe now asks for
 * `viewerPermission` in the same call and keeps sweeping until it finds an account
 * that can write, remembering the first one that could merely see it as the fallback.
 * A read-only account is still a usable answer — it is how a repo nobody here can push
 * to still gets its PRs listed — it is just no longer the first one taken.
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

/**
 * What one account can do with `dir` — its `owner/repo`, and whether that account may
 * push there. Null when the account cannot see the repo at all.
 *
 * `viewerPermission` rides along in the same call because it costs nothing extra and
 * because the answer without it sent merges to a read-only login. `gh` can answer it
 * as `null`; that is treated as unknown rather than as "no", so a Mac with a single
 * account behaves exactly as it did before this field was asked for.
 */
async function seenBy(dir, user) {
  try {
    const out = await gh(['repo', 'view', '--json', 'nameWithOwner,viewerPermission'], {
      cwd: dir,
      env: await envOf(user),
    });
    const view = JSON.parse(out);
    if (!view.nameWithOwner) return null;
    return { slug: view.nameWithOwner, permission: view.viewerPermission || null };
  } catch {
    return null;
  }
}

/** The permissions GitHub lets merge a pull request. TRIAGE and READ are not among them. */
const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** Whether a `seenBy` answer belongs to an account that can actually merge. */
function canWrite(view) {
  return !!view && WRITE_PERMISSIONS.has(String(view.permission || '').toUpperCase());
}

/**
 * Which account should act on `dir`, and what the repo there is called. Null when no
 * account can see it.
 *
 * Preference order is: an account that can write, then any account that can see it.
 * The sweep does not stop at the first account that answers, because that is what
 * handed the merge queue a READ collaborator on a repo whose owner also had a login.
 */
async function resolve(dir) {
  if (!dir || !fs.existsSync(dir)) return null;

  const known = accountFor.get(dir);
  if (known !== undefined) {
    const view = await seenBy(dir, known);
    return view ? { user: known, slug: view.slug } : null;
  }

  // The first account that can merely see the repo is kept as the fallback and the
  // sweep carries on. It is returned only if nothing better turns up.
  let fallback = null;

  const ambient = await seenBy(dir, '');
  if (canWrite(ambient)) {
    accountFor.set(dir, '');
    return { user: '', slug: ambient.slug };
  }
  if (ambient) fallback = { user: '', slug: ambient.slug };

  for (const acct of await accountList()) {
    // The active account *was* the ambient attempt above; asking it again would
    // double the cost of every local-only checkout and learn nothing.
    if (acct.active) continue;
    if (!(await tokenOf(acct.user))) continue;
    const view = await seenBy(dir, acct.user);
    if (!view) continue;
    if (canWrite(view)) {
      accountFor.set(dir, acct.user);
      return { user: acct.user, slug: view.slug };
    }
    if (!fallback) fallback = { user: acct.user, slug: view.slug };
  }

  if (fallback) {
    accountFor.set(dir, fallback.user);
    return fallback;
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

/** The login `gh auth status` flags active, which is who the ambient account *is*. */
async function activeLogin() {
  const found = (await accountList()).find((a) => a.active);
  return found ? found.user : '';
}

/** What `reviewerFor` answered for a directory. A cached `null` is an answer too. */
const reviewerCache = new Map();

/**
 * A second identity for the same checkout — one that can see the repo and is *not* the
 * account everything else here runs as.
 *
 * **This is chosen by role, where `resolve` above chooses by capability, and the two
 * questions genuinely have different answers.** `resolve` sweeps for an account that can
 * write and takes it, because the thing it is picking an account for is a merge; on this
 * Mac that is the owner login, which is why every recent pull request is authored by it.
 * A reviewer must be the account `resolve` did *not* return, and no amount of ranking by
 * permission produces that — GitHub refuses an approving review from the pull request's
 * own author, so the one account best qualified to merge is the one account that cannot
 * approve. Hence a separate lookup rather than a flag on `resolve`, and hence `accountFor`
 * keeping exactly one account per directory is left alone: it is right about its own
 * question.
 *
 * READ is enough, and that is the point rather than a compromise. A collaborator with
 * read access may submit an approving review on a pull request it did not open — so
 * `seenBy` answering at all is the whole test, and `viewerPermission` is carried through
 * only so a caller can say which account it is about to speak as.
 *
 * Returns `{ user, login, slug, permission }`, or **null**, and null is an ordinary
 * answer that every caller must handle rather than an error:
 *
 * - `user` is the key `envOf` takes — `''` for the ambient account, a login otherwise.
 *   It is *not* interchangeable with `login`, which is why both are here: running as the
 *   ambient account means sending no `GH_TOKEN` at all, and the account that is is only
 *   discoverable from `gh auth status`.
 * - **null on a Mac with one login**, which is the common case everywhere except here.
 *   One account cannot both open and approve a pull request, so there is no reviewer to
 *   be had and the caller falls back — records the approval on the bead, says plainly
 *   that no GitHub review was submitted — rather than failing a delivery over a second
 *   account nobody promised.
 * - null, too, when nothing can see the repo at all, since then there is no first
 *   identity either.
 *
 * Cached per directory for the life of the process, negatives included, for the same
 * reason `resolve` caches: this is asked on a path that runs every tick, and an
 * uncached no costs a `gh repo view` per account per ask. A `gh auth login` becomes
 * visible the way every other answer in this file does — by restarting the daemon, or
 * by `forgetAvailability()`.
 */
export async function reviewerFor(dir) {
  if (reviewerCache.has(dir)) return reviewerCache.get(dir);

  const remember = (value) => {
    reviewerCache.set(dir, value);
    return value;
  };

  const acting = await resolve(dir);
  if (!acting) return remember(null);

  // Who `resolve` picked, as a *login* rather than as a token key. `''` there means the
  // ambient account, and the candidate sweep below has to be able to recognise it under
  // its own name or it would offer the acting account back as its own reviewer.
  const actingLogin = acting.user || (await activeLogin());

  // The ambient account won the sweep and `gh auth status` will not say which login
  // that is — the older, account-less output shape. Every candidate below could then be
  // the acting account under another name, and a reviewer that is secretly the author
  // fails at the 422, on a live pull request, having looked right the whole way here.
  // No reviewer is the honest answer; the caller already handles it.
  if (!actingLogin) return remember(null);

  for (const acct of await accountList()) {
    if (acct.user === actingLogin) continue;
    // The active account is reached by sending no token — the same ambient call
    // `resolve` makes — because that is what `envOf('')` does and a keyring read for a
    // token we would not use is a spawn wasted.
    const user = acct.active ? '' : acct.user;
    if (user && !(await tokenOf(user))) continue;
    const view = await seenBy(dir, user);
    if (!view) continue;
    return remember({ user, login: acct.user, slug: view.slug, permission: view.permission });
  }

  return remember(null);
}

/** Forget the cached answers. For tests, and for anything that knows gh just changed. */
export const forgetAvailability = () => {
  cached = null;
  missUntil = 0;
  missWait = 0;
  accountsCache = null;
  accountFor.clear();
  reviewerCache.clear();
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
 *
 * `head` narrows it to one branch, and it is the only way to ask about a branch whose
 * *ref* is gone. `gh pr view <branch>` resolves the ref and fails once a merge has
 * deleted it — which is exactly what a merge from the card does — while `--head` is
 * matched against the `headRefName` GitHub keeps on the pull request forever. It also
 * takes the limit out of the answer's way, which is the fix bc-kbr6 asked for: forty
 * merged pull requests is under a day on this repo, so a branch that merged the day
 * before last was invisible to an unfiltered list of forty however it was sorted.
 */
export async function list(dir, { limit = 40, state = 'all', head = '' } = {}) {
  const args = ['pr', 'list', '--state', state, '--limit', String(limit)];
  if (head) args.push('--head', String(head));
  const out = await ghIn(dir, [...args, '--json', LIST_FIELDS], {
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
 * What the *base branch* is already failing — the baseline a pull request is judged
 * against rather than in isolation.
 *
 * bc-y738, and the reason it needed deciding rather than assuming: CI on this repo's
 * `main` was red for five consecutive pushes (bc-f31f) while every worker refused to
 * merge over a red check. Under the strict reading that is correct and the queue merges
 * nothing at all — every pull request becomes a card, which is the state the MergeAdvocate
 * exists to end. A check that is red on `main` is red on every branch cut from it and says
 * nothing about the branch; what says something is the *difference*. See `newlyFailing` in
 * lib/mergeadvocate.js, which is where the comparison lives.
 *
 * Asked of the commit rather than of a pull request, because the base has no pull request
 * — `gh api repos/{owner}/{repo}/commits/<ref>/check-runs`, the placeholders resolved by
 * `gh` from the checkout's own remote, so this cannot be pointed at the wrong repo by a
 * caller that got a slug wrong.
 *
 * Folded through the same `rollup` the pull request's own checks go through, so the two
 * sides of the comparison are the same shape and the same normalisation — a name that
 * counts as failing on one side and passing on the other would be a diff that is always
 * non-empty, and a queue that never merges.
 *
 * **A failure to ask is not an empty baseline.** `null`, and the caller treats it as "no
 * baseline is known" — because an empty array means `main` is green, which is the reading
 * that turns every one of its red checks into a refusal. That distinction is the whole
 * safety of this function: guessing green is the direction that stops merges, guessing
 * red is the direction that lets them through, and neither guess is available here.
 */
/**
 * Bring the base into the branch — the downmerge, asked of GitHub rather than of a
 * checkout.
 *
 * bc-r941.3's first step is "downmerge main into the branch", and the obvious way to do
 * it is the way the worker's brief used to ask for: `git fetch && git merge origin/main`
 * in the branch's own worktree. That is not available to the daemon, and the reason is
 * not laziness. **The worktree is usually gone.** lib/tidy.js retires a worker's worktree
 * once GitHub says its pull request landed or its session ended, and a merge-bead can sit
 * in the queue across several of those sweeps. A queue that could only act on branches
 * whose worktrees still existed would work perfectly in testing and merge nothing on a
 * tidy Mac.
 *
 * GitHub's own `update-branch` does the same merge — base into head, a real merge commit
 * on the branch, checks re-run against what is actually going to land — with no checkout
 * involved and no local `main` to be stale. It is the button labelled "Update branch" on
 * the pull request page.
 *
 * **It refuses on conflict, and that refusal is the useful half.** A conflicted downmerge
 * is exactly the case that needs a person or an agent in a worktree, and this is where the
 * queue finds that out cheaply — before it has spent anything, and without having had to
 * find a checkout first. The caller turns that into a resolver window (lib/resolvers.js).
 *
 * `{ updated: true }` when GitHub merged the base in, `{ updated: false, reason }` when it
 * would not. Never throws: every caller is in a sweep, and a pull request that will not
 * update is a fact about that pull request rather than a reason to stop the tick.
 */
export async function updateBranch(dir, number, { timeoutMs = TIMEOUT_MS } = {}) {
  try {
    await gh(['api', '--method', 'PUT', `repos/{owner}/{repo}/pulls/${Number(number)}/update-branch`], {
      cwd: dir,
      timeout: timeoutMs,
    });
    return { updated: true, reason: '' };
  } catch (err) {
    return { updated: false, reason: String(err?.message || err || 'gh refused the update').split('\n')[0] };
  }
}

export async function baseChecks(dir, ref = 'main', { timeoutMs = TIMEOUT_MS } = {}) {
  let raw;
  try {
    raw = await gh(
      ['api', `repos/{owner}/{repo}/commits/${encodeURIComponent(ref)}/check-runs`, '--jq', '.check_runs'],
      { cwd: dir, timeout: timeoutMs }
    );
  } catch {
    return null;
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  return rollup(list);
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
 * checkout and the remote branch is the one worth tidying. False for a worker
 * merging its own pull request, because that caller *is* in a worktree with that
 * branch checked out — `gh` tidies the local branch after the remote one, cannot
 * delete a branch it is standing on, and would turn a merge that worked into a
 * command that failed. The main checkout is not immune to that either: its own
 * worktrees hold every worker's branch, so `gh` fails the local delete there too.
 * That is why the failure path below reads the pull request back rather than
 * trusting the exit code — the local branch is the least of the three things
 * `--delete-branch` does, and losing the merge to it is not a trade worth making.
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
    // But first: did it fail *after* the merge? `gh pr merge --delete-branch` is three
    // acts, not one — merge, delete the remote branch, delete the local branch — and a
    // non-zero exit says only that one of them went wrong. The last one goes wrong here
    // routinely, because the daemon merges from the main checkout and this repo's own
    // workers leave every branch checked out in a worktree of it, which git refuses to
    // delete out from under them. Read the pull request back before believing the exit
    // code: a merge that landed must never be reported as a refusal, because what the
    // caller says on the card is *nothing was written and nothing was lost* — and on
    // bc-g0tx that sentence went out over #371, merged, with its branch gone from the
    // remote and its work bead left in_progress because the answer never ran.
    const after = await view(dir, number).catch(() => null);
    // `err.message` rather than `said`: the first stderr line is gh's actual complaint
    // and everything after it is a usage hint, and this one is read on a card.
    if (after && after.state === 'MERGED') return { ...after, alreadyMerged: false, cleanup: String(err.message || said).trim() };
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

/**
 * Correct a pull request's title in place.
 *
 * The one field a redelivery is allowed to overwrite — argued at the call site in
 * `bin/deliver.js`. Titles are not anchors for anything: no review comment hangs off one,
 * nothing in lib/landed.js needs the *old* one, and a stale title is read on a board by
 * somebody deciding whether to open the thing at all.
 *
 * Deliberately not a general `edit`. The body is not in the same class and a function
 * that could rewrite it would eventually be used to.
 */
export async function retitle(dir, number, title) {
  await ghIn(dir, ['pr', 'edit', String(number), '--title', String(title)]);
}

/** Say something on the PR. What "request changes" writes, so the thread is on GitHub too. */
export async function comment(dir, number, text) {
  await gh(['pr', 'comment', String(number), '--body', text], { cwd: dir });
}

/**
 * The thread, oldest first — the only durable channel out of an unattended session.
 *
 * Read by lib/sweepcard.js for one sentence: a resolver that stopped without making its
 * branch mergeable is told to say why here (`RESOLVER_SAYS`, lib/session.js), because the
 * window it would otherwise say it in closes when it stops. Nothing else reads this yet,
 * and it is deliberately not folded into `viewDetail` — a thread is unbounded, the full
 * view draws none of it, and paying for it on every card open would be paying for prose
 * nothing renders.
 *
 * Review comments are a different resource on a different endpoint and are not here.
 * What this returns is the issue-comment thread, which is where `gh pr comment` writes
 * and therefore the only place a resolver's sentence can be.
 */
export async function comments(dir, number) {
  const out = await ghIn(dir, ['pr', 'view', String(number), '--json', 'comments']);
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed?.comments) ? parsed.comments : []).map((c) => ({
    author: c.author?.login || '',
    body: String(c.body || ''),
    at: c.createdAt || '',
    url: c.url || '',
  }));
}

/**
 * Approve a pull request — a real review on GitHub, submitted as the account that did
 * **not** open it, with a comment under it saying an agent is what approved.
 *
 * This is the one write in this file that is deliberately made as somebody other than
 * `accountIn(dir)`. Everything else here runs as the account `resolve` picked, because
 * everything else here is a read or a merge; an approval cannot, because GitHub refuses
 * one from the pull request's own author and `resolve` returns exactly that author. So
 * the identity comes from `reviewerFor` — chosen by role rather than by capability — and
 * `envOf` sends that account's token for these two calls and no others.
 *
 * **Three things have to be true at once, and each of them is a separate failure.**
 *
 * 1. *The approval is real GitHub state.* Not a field on a bead that says a review
 *    happened: a review, with a submitter, a timestamp and a permanent URL, on the pull
 *    request page a person opens six months later. Which is why this posts to the reviews
 *    endpoint rather than shelling `gh pr review --approve` — the endpoint hands back the
 *    review it just created, so `url` is an anchor to *the approval itself* rather than to
 *    the pull request it is on, and that is the field the merge-bead's review block keeps
 *    for the reader who no longer has the bead. It is also the endpoint an inline review
 *    comment has to go through, so the next thing that needs one extends a call that is
 *    already here instead of introducing a second mechanism beside it.
 * 2. *Nobody reading it concludes Adam approved it.* GitHub's own timeline says
 *    "NeanderthalMan approved these changes", which is a person's name as far as the page
 *    is concerned. So `body` is **required** — a review submitted with nothing in it is a
 *    bare green tick, indistinguishable from the owner glancing at a diff, and this
 *    refuses rather than submitting one. `note` is posted *after* the review so it is the
 *    last thing on the thread, which is where the eye lands, and it is the caller's
 *    sentence about who that login actually is.
 * 3. *A one-login Mac is not a broken delivery.* `reviewerFor` returning null is the
 *    ordinary answer everywhere except this Mac, and the answer here is
 *    `{ submitted: false, reason }` — the caller records the approval on the bead and says
 *    plainly that no review was submitted. Nothing is posted to the pull request in that
 *    case, deliberately: with no review on it there is no green tick to be mistaken for a
 *    person's, so a comment disclaiming one would be disclaiming something that is not
 *    there.
 *
 * `submitted` is the authoritative fact and `reason` is prose about whatever went wrong,
 * whichever half it went wrong in. The two are independent on purpose: a comment that
 * fails to post after the review landed leaves `submitted: true`, `noted: false` and a
 * sentence — because the approval *is* on GitHub at that point and a caller that treated
 * the pair as one atomic act would go on to record that nothing had been approved.
 */
export async function approve(dir, number, { body = '', note = '' } = {}) {
  const blank = { submitted: false, noted: false, reviewer: '', permission: '', url: '', at: '', reason: '' };

  const text = String(body || '').trim();
  if (!text) {
    return { ...blank, reason: 'refusing to approve with an empty body — a bare tick reads as a person having approved it' };
  }

  const reviewer = await reviewerFor(dir);
  if (!reviewer) {
    return {
      ...blank,
      reason: 'there is no second GitHub account here, and an account may not approve a pull request it opened itself',
    };
  }

  const env = await envOf(reviewer.user);
  const found = { ...blank, reviewer: reviewer.login, permission: reviewer.permission || '' };

  let review = null;
  try {
    const out = await gh(
      [
        'api',
        '--method',
        'POST',
        `repos/{owner}/{repo}/pulls/${Number(number)}/reviews`,
        '-f',
        'event=APPROVE',
        // `-f` is gh's *string* field: no type conversion and no `@file` reading, which
        // matters because the body is somebody's prose and may begin with anything.
        '-f',
        `body=${text}`,
      ],
      { cwd: dir, env }
    );
    review = JSON.parse(out);
  } catch (err) {
    // The 422 for approving your own pull request lands here, and it is the one failure
    // worth recognising by sight: it means `reviewerFor` and `resolve` returned the same
    // account, which is a bug in the identity sweep rather than in this review.
    return { ...found, reason: err.message };
  }

  const done = {
    ...found,
    submitted: true,
    url: String(review?.html_url || ''),
    at: String(review?.submitted_at || new Date().toISOString()),
  };

  const trailer = String(note || '').trim();
  if (!trailer) return done;
  try {
    // As the reviewer, not as the acting account. A comment from the *owner* explaining
    // that the reviewer is an agent is a second identity vouching for the first; from the
    // reviewer it is the same voice that left the review, which is what it is about.
    await gh(['pr', 'comment', String(number), '--body', trailer], { cwd: dir, env });
    return { ...done, noted: true };
  } catch (err) {
    return {
      ...done,
      reason: `the approval is on the pull request, but the comment naming the agent is not: ${err.message}`,
    };
  }
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
 * The reviews on a pull request, folded to the four things a caller can act on.
 *
 * `latestReviews` is *one row per reviewer* — GitHub's own de-duplication, the latest
 * review each person left — which is why it is the field asked for rather than
 * `reviews`. A reviewer who requested changes and then approved appears once, approved,
 * and a gate reading the raw list would otherwise have to re-derive that ordering and
 * would get it wrong the first time somebody reviewed twice.
 *
 * Four fields kept, and one deliberately dropped:
 *
 * - `author` is the login, flattened out of `{ author: { login } }`.
 * - `state` is `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED`, upper-cased
 *   so nothing above compares case-sensitively against GitHub's spelling.
 * - `association` is how a reader tells an approval by somebody with standing from a
 *   drive-by one, and it is **not** the two-or-three-value field it looks like. The first
 *   review ever submitted here (#404, 2026-08-17) came back `CONTRIBUTOR` from an account
 *   that is a `READ` *collaborator* on the repo — GitHub answers with whichever association
 *   it considers strongest, and having commits in the repo outranks being a collaborator.
 *   So it is carried as GitHub's own string and nothing compares against a closed set;
 *   anything gating on `COLLABORATOR` here would have been wrong on the very first review.
 * - `submittedAt` is when, and it is the only way to say "the review predates the last
 *   push" without a second query.
 * - **`body` is not kept.** The reviewer's prose reaches the worker through the review
 *   block on the merge-bead, written by the agent that did the reviewing; nothing needs
 *   to read it back off GitHub. Keeping it would put every review's full text into the
 *   board's list payload, which is the cost lib/prboard.js already strips the pull
 *   request's own `body` to avoid. If something ever genuinely needs it, add it here on
 *   purpose rather than discovering it arrived for free.
 *
 * Two fields `gh` reports but does not fill are also left off: `id` and `commit.oid` both
 * come back as the empty string on every review measured (cli/cli#14147, 2026-08-17), so
 * carrying them would be carrying a promise this cannot keep.
 */
function reviews(list) {
  if (!Array.isArray(list)) return [];
  return list.map((r) => ({
    author: r?.author?.login || '',
    state: String(r?.state || '').toUpperCase(),
    association: String(r?.authorAssociation || '').toUpperCase(),
    submittedAt: r?.submittedAt || null,
  }));
}

/**
 * The logins whose *latest* review is an approval — the derived answer a merge gate
 * wants, folded here so the rule lives in one place rather than in each caller.
 *
 * The whole content of the rule is that `APPROVED` is the only state that counts.
 * `DISMISSED` is what an approval becomes when somebody takes it back, `COMMENTED` is a
 * review that deliberately withheld one, and both arrive in the same array as the real
 * thing — so "has anybody reviewed this" and "has anybody approved it" are different
 * questions off the same rows, and only the second one may open a merge.
 */
const approvers = (rows) => rows.filter((r) => r.state === 'APPROVED').map((r) => r.author).filter(Boolean);

/**
 * The shape everything above this file sees.
 *
 * `gh`'s own JSON is passed through where it is already the right thing and folded
 * where it isn't, so no caller has to know that `mergeCommit` is an object or that
 * a PR with no CI at all reports an empty array rather than a missing field.
 */
function normalize(pr) {
  const reviewed = reviews(pr.latestReviews);
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
    // Beside `reviewDecision`, never instead of it. On a repo that *does* configure a
    // review requirement, `reviewDecision` is the better answer and stays the one to
    // prefer; `reviews` is what makes an approval visible on a repo that does not.
    reviews: reviewed,
    approvedBy: approvers(reviewed),
    mergedAt: pr.mergedAt || null,
    mergeCommit: pr.mergeCommit?.oid || null,
  };
}
