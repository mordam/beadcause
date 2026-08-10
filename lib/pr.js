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
 * 2. **A missing `gh` is a state, not a crash.** `available()` answers it once and
 *    caches, and every caller is expected to have asked. The whole PR channel
 *    switches off cleanly when the answer is no, which is what makes this safe to
 *    ship into a repo with no GitHub remote.
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
function gh(args, { cwd, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
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
 * Is there a usable `gh` on this Mac?
 *
 * Cached for the life of the process on purpose: the answer changes when someone
 * installs a CLI or runs `gh auth login`, neither of which happens while the daemon
 * is mid-poll, and asking GitHub on every tick would turn a check into traffic.
 * Restarting the daemon is the documented way to change the answer.
 */
export async function available() {
  if (cached) return cached;
  try {
    await gh(['auth', 'status'], { timeout: 10000 });
    cached = { ok: true, reason: '' };
  } catch (err) {
    cached = {
      ok: false,
      reason: /not found|ENOENT/i.test(err.message)
        ? 'the gh CLI is not installed — `brew install gh`'
        : `gh is installed but not authenticated — \`gh auth login\` (${err.message})`,
    };
  }
  return cached;
}

/** Forget the cached answer. For tests, and for anything that knows gh just changed. */
export const forgetAvailability = () => {
  cached = null;
};

/**
 * `owner/repo` for the checkout at `dir`, or null when it has no GitHub remote.
 *
 * Null is a legitimate answer and every caller treats it as one: a workspace whose
 * checkout is local-only keeps the old ending — work the bead, close the bead — and
 * simply never gets a delivery question. Making that an error would mean one repo
 * without a remote breaks the advocate for all the others.
 */
export async function slugFor(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  try {
    const out = await gh(['repo', 'view', '--json', 'nameWithOwner'], { cwd: dir });
    return JSON.parse(out).nameWithOwner || null;
  } catch {
    return null;
  }
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
  const out = await gh(['pr', 'view', String(ref), '--json', PR_FIELDS], { cwd: dir });
  return normalize(JSON.parse(out));
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
  const out = await gh(['pr', 'list', '--state', state, '--limit', String(limit), '--json', LIST_FIELDS], {
    cwd: dir,
    timeout: 60000,
  });
  const rows = JSON.parse(out);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...normalize(row),
    // Kept out of `normalize` so a card built from `view()` never carries a `body`
    // key that is always empty — an absent field reads as "not asked for", an empty
    // one as "this PR has no description", and only one of those is true.
    body: String(row.body || ''),
    author: row.author?.login || '',
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  }));
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
  const out = await gh(args, { cwd: dir, timeout: 60000 });
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
 * Valid `gh pr merge` methods. An unknown one would fail at the CLI with a usage dump.
 *
 * Null-prototype so the lookup below is a real lookup: on a plain object literal,
 * `METHODS['constructor']` is truthy and would be pushed into argv as a function,
 * turning "unrecognised method" — which should quietly become a squash — into a
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
 */
export async function merge(dir, number, { method = 'squash', deleteBranch = true } = {}) {
  const flag = METHODS[method] || METHODS.squash;
  const pr = await view(dir, number);

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
    await gh(args, { cwd: dir, timeout: 120000 });
  } catch (err) {
    // GitHub's own refusal is the most useful thing anyone will read here — a
    // failing check, a required review, a protected branch — so it travels intact.
    throw Object.assign(new Error(err.detail || err.message), { status: 409 });
  }
  return { ...(await view(dir, number)), alreadyMerged: false };
}

/** Close it without merging, with a reason on the PR so the tab is not a mystery later. */
export async function close(dir, number, { comment = '', deleteBranch = false } = {}) {
  const args = ['pr', 'close', String(number)];
  if (comment) args.push('--comment', comment);
  if (deleteBranch) args.push('--delete-branch');
  await gh(args, { cwd: dir });
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
