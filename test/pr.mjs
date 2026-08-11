#!/usr/bin/env node
/**
 * lib/pr.js — the one file in beadcause that shells out to `gh`.
 *
 *     npm test
 *     node test/pr.mjs
 *
 * Everything above this file asks it questions and never learns how a pull request
 * is fetched, which is what makes it testable at all: swap the `gh` on PATH for a
 * fake and the whole module is exercised without a network, a token, or a repo. That
 * is what happens here — a real `gh`, if you have one, is never called.
 *
 * Three failures are worth this file, and they are not evenly weighted:
 *
 * 1. **The merge preflight going quiet.** `merge()` re-reads the PR and refuses,
 *    with a sentence, on already-merged / closed / conflicting *before* it shells
 *    out. If that check ever stops firing, the symptom is not an exception — it is
 *    `gh` being asked to merge something it cannot, from a phone, in another room.
 *    So the assertions here are not just "it threw": they read the call log to prove
 *    `gh pr merge` was never reached.
 * 2. **`rollup()` collapsing a distinction.** `pending` and `failing` mean opposite
 *    things (wait vs. do not), and a PR with no CI at all must read `none` rather
 *    than `passing` — otherwise the card claims green on a repo that has no checks.
 *    Both of gh's check shapes are covered, because only one of them is the one you
 *    happen to have in front of you when you write the code.
 * 3. **`available()` getting the asymmetry wrong in either direction.** It is asked on
 *    every poll, so a *yes* must cost one `gh` per process — the test asserts the
 *    absence of a second call, which is the only way that regression is ever visible.
 *    A *no* must not be permanent, because the daemon boots before anyone has logged
 *    in and used to hold "not authenticated" until it was restarted, while telling you
 *    to run the command that could not reach it. The clock is injected, so the interval
 *    is asserted rather than waited out.
 * 4. **`settle()` calling a timeout a verdict.** A worker merges its own pull request
 *    once the checks report, so this is what stands between "CI said yes" and "CI has
 *    not said anything for five minutes" — and those must not both come back as
 *    something a merge can proceed on. The wait is driven by an injected `sleep` that
 *    changes the fake's world, so the pending-then-green case is exercised in
 *    milliseconds rather than in CI's own time.
 * 5. **`UNKNOWN` mergeability read as a conflict.** GitHub works out whether a pull
 *    request can merge asynchronously, and for a few seconds after a push the answer
 *    is `UNKNOWN` — then it refuses a merge it has not assessed with the same words it
 *    uses for a real conflict. Untested, that is a session ending in a card telling
 *    Adam his branch conflicts with main when it does not, and the way it goes wrong
 *    again is silently, because the code path looks identical either way.
 *
 * Nothing here touches the network, spawns an agent, runs the real `gh`, or writes
 * outside a temp directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib', 'pr.js');

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/** Run `fn` and hand back the error it threw, or null. Throwing is the assertion here. */
const threw = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};

/* --------------------------------------------------------------- the fake gh */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-pr-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const BIN = path.join(tmp, 'bin');
const EMPTY = path.join(tmp, 'empty');
const REPO = path.join(tmp, 'repo');
for (const d of [BIN, EMPTY, REPO]) fs.mkdirSync(d, { recursive: true });

const STATE = path.join(tmp, 'gh-state.json');
const LOG = path.join(tmp, 'gh-calls.log');

// Extensionless on purpose, so node runs it as CommonJS whatever this package's
// "type" says. It answers from a JSON file the test rewrites between scenarios, and
// appends every invocation to a log — the log is what turns "it never shelled out"
// into an assertion rather than a hope.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.GH_FAKE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
// The token is logged because "which account was this call made as" is the whole
// question one scenario below exists to answer, and it is invisible in argv.
fs.appendFileSync(state.log, JSON.stringify({ args: args, cwd: process.cwd(), token: process.env.GH_TOKEN || null }) + '\\n');

const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const out = (s) => { process.stdout.write(s); process.exit(0); };
const fail = (msg) => {
  // Real gh writes its complaint first and a usage hint under it; pr.js keeps the
  // first line and puts the rest on .detail, so the fake needs a second line to drop.
  process.stderr.write(msg + '\\nUsage: gh <command> <subcommand> [flags]\\n');
  process.exit(1);
};

const a = args[0];
const b = args[1];
const rest = args.slice(2);

if (a === 'auth' && b === 'status') {
  if (state.auth && state.auth.ok) {
    // Real gh names each account and flags the active one. state.auth.accounts opts
    // into that shape; without it the output is the older, account-less one, which
    // is a case pr.js has to keep handling.
    var accts = (state.auth && state.auth.accounts) || null;
    if (!accts) out('github.com\\n  Logged in to github.com\\n');
    var lines = ['github.com'];
    for (var i = 0; i < accts.length; i++) {
      lines.push('  \\u2713 Logged in to github.com account ' + accts[i].user + ' (keyring)');
      lines.push('  - Active account: ' + (accts[i].active ? 'true' : 'false'));
      lines.push('  - Token: gho_************************************');
    }
    out(lines.join('\\n') + '\\n');
  }
  fail((state.auth && state.auth.stderr) || 'You are not logged into any GitHub hosts.');
}

if (a === 'auth' && b === 'token') {
  var user = rest[rest.indexOf('--user') + 1];
  var token = (state.tokens || {})[user];
  if (!token) fail('no oauth token found for ' + user);
  out(token + '\\n');
}

if (a === 'repo' && b === 'view') {
  // The two-account world: which repo you can see depends on the token you sent.
  if (state.repoByToken) {
    var seen = state.repoByToken[process.env.GH_TOKEN || ''];
    if (!seen) fail("GraphQL: Could not resolve to a Repository with the name 'them/private'. (repository)");
    out(JSON.stringify(seen));
  }
  if (!state.repo) fail('none of the git remotes configured for this repository point to a known GitHub host');
  out(JSON.stringify(state.repo));
}

if (a === 'pr') {
  const prs = state.prs || {};
  const find = (ref) => {
    if (prs[String(ref)]) return prs[String(ref)];
    const keys = Object.keys(prs);
    for (let i = 0; i < keys.length; i++) {
      const p = prs[keys[i]];
      if (p && p.headRefName === String(ref)) return p;
    }
    return null;
  };

  if (b === 'view') {
    const found = find(rest[0]);
    if (!found) fail('no pull requests found for branch "' + rest[0] + '"');
    out(JSON.stringify(found));
  }
  if (b === 'create') {
    if (state.create && state.create.stderr) fail(state.create.stderr);
    out((state.create && state.create.stdout) || '');
  }
  if (b === 'merge') {
    if (state.mergeRefusal) fail(state.mergeRefusal);
    const found = find(rest[0]);
    if (!found) fail('no pull requests found');
    found.state = 'MERGED';
    found.mergedAt = '2026-08-09T15:04:05Z';
    found.mergeCommit = { oid: '0ff1ce0ff1ce' };
    save();
    out('Merged pull request #' + found.number + '\\n');
  }
  if (b === 'close') {
    const found = find(rest[0]);
    if (!found) fail('no pull requests found');
    found.state = 'CLOSED';
    save();
    out('Closed pull request #' + found.number + '\\n');
  }
  if (b === 'comment') out('https://github.com/acme/widgets/pull/1#issuecomment-1\\n');
}

fail('unknown gh invocation: ' + args.join(' '));
`;

fs.writeFileSync(path.join(BIN, 'gh'), FAKE_GH, { mode: 0o755 });

process.env.GH_FAKE_STATE = STATE;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const REAL_PATH = process.env.PATH;
const REPO_REAL = fs.realpathSync(REPO);

/** Replace the fake's whole world. Every scenario starts from a known one. */
const world = (s = {}) => fs.writeFileSync(STATE, JSON.stringify({ log: LOG, auth: { ok: true }, ...s }, null, 2));
const resetLog = () => fs.writeFileSync(LOG, '');
const calls = () =>
  fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** One PR as `gh pr view --json` hands it over, before pr.js folds it. */
const rawPR = (over = {}) => ({
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  title: 'Branch-and-PR delivery',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'worktree-pr-delivery-q7n',
  baseRefName: 'main',
  additions: 498,
  deletions: 12,
  changedFiles: 6,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: null,
  mergeCommit: null,
  ...over,
});

world();
resetLog();

const pr = await import(LIB);

/* ------------------------------------------------------------ is gh usable? */

console.log('\nis there a usable gh');

pr.forgetAvailability();
resetLog();
world({ auth: { ok: true } });

const authed = await pr.available();
check('an installed, authenticated gh is ok', authed.ok === true, JSON.stringify(authed));
check('and says nothing, because there is nothing to say', authed.reason === '');

await pr.available();
await pr.available();
const authCalls = calls().filter((c) => c.args[0] === 'auth').length;
check('the answer is cached — three asks, one `gh auth status`', authCalls === 1, `${authCalls} calls`);

pr.forgetAvailability();
resetLog();
const reasked = await pr.available();
check(
  'forgetAvailability() is what makes it ask again',
  reasked.ok === true && calls().filter((c) => c.args[0] === 'auth').length === 1
);

world({ auth: { ok: false, stderr: 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.' } });
pr.forgetAvailability();
const unauthed = await pr.available();
check('an unauthenticated gh is not ok', unauthed.ok === false);
check('and the reason names the command that fixes it', /gh auth login/.test(unauthed.reason), unauthed.reason);
check(
  'and the restart, because a login alone does not reach a daemon holding the old answer',
  /launchctl kickstart -k gui\/\d+\/m4m\.beadcause/.test(unauthed.reason),
  unauthed.reason
);

/*
 * The no has to expire, and this is the whole bug: the daemon boots before anyone has
 * logged in, caches "not authenticated", and then tells you to run `gh auth login` —
 * the one thing that cannot change its mind. Time is injected rather than waited out,
 * so the minute is asserted rather than slept.
 */
const T0 = 1_760_000_000_000;
pr.forgetAvailability();
resetLog();
const auths = () => calls().filter((c) => c.args[0] === 'auth').length;

await pr.available({ now: T0 });
await pr.available({ now: T0 + 59_000 });
check('a no is held for a bounded interval, not re-asked on every poll', auths() === 1, `${auths()} calls`);

const later = await pr.available({ now: T0 + 61_000 });
check('and is re-asked once that interval is up', auths() === 2, `${auths()} calls`);
check('still a no while nothing has changed', later.ok === false);

await pr.available({ now: T0 + 121_000 });
check(
  'the interval backs off — a second no is held longer than the first',
  auths() === 2,
  `${auths()} calls at +121s`
);

world({ auth: { ok: true } });
const fixed = await pr.available({ now: T0 + 181_000 });
check('a `gh auth login` starts working without restarting the daemon', fixed.ok === true, JSON.stringify(fixed));
check('and says nothing once it is yes', fixed.reason === '');

resetLog();
await pr.available({ now: T0 + 10 * 60 * 60 * 1000 });
check('and that yes is cached for good — no re-ask, however long it has been', auths() === 0, `${auths()} calls`);

world({ auth: { ok: false, stderr: 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.' } });

process.env.PATH = EMPTY;
pr.forgetAvailability();
const missing = await pr.available();
process.env.PATH = REAL_PATH;
check('a gh that is not installed at all is not ok', missing.ok === false);
check(
  'and the reason names the install, not the login',
  /brew install gh/.test(missing.reason) && !/auth login/.test(missing.reason),
  missing.reason
);

world();
pr.forgetAvailability();

/* ----------------------------------------------------------- owner/repo slug */

console.log('\nwhich repo is this');

world({ repo: { nameWithOwner: 'acme/widgets' } });
check('reads owner/repo out of gh repo view', (await pr.slugFor(REPO)) === 'acme/widgets');

resetLog();
check('a directory that does not exist is null', (await pr.slugFor(path.join(tmp, 'nope'))) === null);
check('and costs no gh call at all', calls().length === 0, JSON.stringify(calls()));
check('so is no directory', (await pr.slugFor('')) === null && (await pr.slugFor(null)) === null);

world({ repo: null });
check(
  'a checkout with no GitHub remote is null, not an error — that repo simply never gets a PR',
  (await pr.slugFor(REPO)) === null
);

world({ repo: { nameWithOwner: '' } });
check('an empty nameWithOwner is null too', (await pr.slugFor(REPO)) === null);

/* ------------------------------------------------- and as which gh account */

/**
 * The failure this covers did not look like a failure.
 *
 * `gh` has one active account; this Mac has two. The active one is the work account,
 * and Adam's personal repos are private and owned by the other — so `gh repo view` in
 * those checkouts answered "Could not resolve to a Repository", `slugFor` read that as
 * "no GitHub remote", `prMode` returned null, and every worker the advocate opened on
 * three of his four repos was quietly given a lesser brief: no propose channel, no way
 * to ask him anything, no delivery. A login decided how much an agent could say.
 *
 * So: the ambient account cannot see this repo, the second one can, and the assertion
 * is not merely that the slug comes back — it is *which token the call carried*. That
 * is the difference between resolving it per repo, here, and `gh auth switch`, which
 * would have repointed his day job as a side effect.
 */
console.log('\nwhich account can see it');

pr.forgetAvailability();
resetLog();
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'workacct', active: true },
      { user: 'personalacct', active: false },
    ],
  },
  tokens: { workacct: 'tok-work', personalacct: 'tok-personal' },
  repoByToken: { 'tok-personal': { nameWithOwner: 'them/private' } },
});

check('a repo the active account cannot see is still found, as the account that can', (await pr.slugFor(REPO)) === 'them/private');

const probes = calls().filter((c) => c.args[0] === 'repo');
check(
  'the ambient account is tried first, with no token forced on it',
  probes.length >= 2 && probes[0].token === null,
  JSON.stringify(probes.map((c) => c.token))
);
check(
  'and the one that answered carried the other account’s token',
  probes[probes.length - 1].token === 'tok-personal',
  JSON.stringify(probes.map((c) => c.token))
);
check(
  'the token came from `gh auth token --user`, not from anywhere on disk',
  calls().some((c) => c.args.join(' ') === 'auth token --user personalacct')
);

resetLog();
check('a second ask reuses the account it found', (await pr.slugFor(REPO)) === 'them/private');
check(
  'and costs one `gh repo view`, not another sweep of every account',
  calls().filter((c) => c.args[0] === 'repo').length === 1 && calls().every((c) => c.args[0] !== 'auth'),
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

resetLog();
await pr.view(REPO, 42).catch(() => null);
check(
  'and every later call in that checkout runs as that account too',
  calls().every((c) => c.token === 'tok-personal'),
  JSON.stringify(calls().map((c) => [c.args[0], c.token]))
);

// A repo nothing can see stays null — the local-only checkout that must not break the
// advocate for every other workspace.
resetLog();
world({
  auth: { ok: true, accounts: [{ user: 'workacct', active: true }, { user: 'personalacct', active: false }] },
  tokens: { workacct: 'tok-work', personalacct: 'tok-personal' },
  repoByToken: {},
});
pr.forgetAvailability();
check('a checkout no account can see is null, having asked them all', (await pr.slugFor(REPO)) === null);
check(
  'and the active account is not asked twice for it',
  calls().filter((c) => c.args[0] === 'repo').length === 2,
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

pr.forgetAvailability();
world();

/* ------------------------------------------------------------------- view */

console.log('\nreading one pull request');

world({
  prs: {
    42: rawPR({
      isDraft: true,
      mergeable: 'mergeable',
      mergeStateStatus: 'blocked',
      state: 'open',
      reviewDecision: 'APPROVED',
      mergeCommit: { oid: 'cafebabe' },
    }),
  },
});

const viewed = await pr.view(REPO, 42);
check('number and url survive untouched', viewed.number === 42 && /\/pull\/42$/.test(viewed.url));
check('state is uppercased whatever case gh sent', viewed.state === 'OPEN', viewed.state);
check('mergeable is uppercased too', viewed.mergeable === 'MERGEABLE', viewed.mergeable);
check('mergeStateStatus lands as mergeState', viewed.mergeState === 'BLOCKED', viewed.mergeState);
check('isDraft becomes draft', viewed.draft === true);
check(
  'headRefName becomes branch, baseRefName becomes base',
  viewed.branch === 'worktree-pr-delivery-q7n' && viewed.base === 'main'
);
check('changedFiles becomes files', viewed.files === 6);
check('the diffstat comes through', viewed.additions === 498 && viewed.deletions === 12);
check(
  'mergeCommit is flattened to its oid, so no caller has to unwrap an object',
  viewed.mergeCommit === 'cafebabe',
  JSON.stringify(viewed.mergeCommit)
);
check('reviewDecision passes through', viewed.reviewDecision === 'APPROVED');
check('gh ran in the directory it was handed', calls().at(-1).cwd === REPO_REAL, `${calls().at(-1).cwd} vs ${REPO_REAL}`);

world({ prs: { 9: { number: 9, url: 'https://github.com/acme/widgets/pull/9' } } });
const sparse = await pr.view(REPO, 9);
check(
  'a PR gh answered sparsely still renders — zeros and empties, never undefined',
  sparse.additions === 0 &&
    sparse.deletions === 0 &&
    sparse.files === 0 &&
    sparse.title === '' &&
    sparse.branch === '' &&
    sparse.base === '' &&
    sparse.draft === false &&
    sparse.mergeCommit === null,
  JSON.stringify(sparse)
);
check('and an absent mergeable reads as UNKNOWN rather than blank', sparse.mergeable === 'UNKNOWN', sparse.mergeable);

const gone = await threw(() => pr.view(REPO, 404));
check('a PR that does not exist throws', gone !== null);
check(
  "and carries gh's own first line, not the usage dump under it",
  gone && /no pull requests found/.test(gone.message) && !/Usage:/.test(gone.message),
  gone && gone.message
);
check('with the rest kept on .detail, for the log', gone && /Usage:/.test(gone.detail || ''));

/* ---------------------------------------------------------------- the rollup */

console.log('\nfolding statusCheckRollup into something a phone can read');

const checksFor = async (rollup) => {
  world({ prs: { 7: rawPR({ number: 7, statusCheckRollup: rollup }) } });
  return (await pr.view(REPO, 7)).checks;
};

const noCI = await checksFor([]);
check(
  'a repo with no CI at all is "none", not "passing" — the card must not claim a green it never saw',
  noCI.state === 'none' && noCI.total === 0,
  JSON.stringify(noCI)
);
check('a missing rollup is "none" as well', (await checksFor(null)).state === 'none');
check('and so is one gh sent as something other than an array', (await checksFor({})).state === 'none');

const bothShapes = await checksFor([
  { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', context: 'ci/travis', state: 'SUCCESS' },
]);
check(
  'both of gh’s check shapes count — CheckRun by conclusion, StatusContext by state',
  bothShapes.passing === 2 && bothShapes.total === 2 && bothShapes.state === 'passing',
  JSON.stringify(bothShapes)
);

const lenient = await checksFor([
  { name: 'a', conclusion: 'SUCCESS' },
  { name: 'b', conclusion: 'NEUTRAL' },
  { name: 'c', conclusion: 'SKIPPED' },
]);
check(
  'NEUTRAL and SKIPPED are not failures',
  lenient.passing === 3 && lenient.state === 'passing',
  JSON.stringify(lenient)
);

const waiting = await checksFor([
  { name: 'a', status: 'QUEUED' },
  { name: 'b', status: 'IN_PROGRESS' },
  { name: 'c', state: 'PENDING' },
  { name: 'd', state: 'WAITING' },
  { name: 'e', state: 'REQUESTED' },
]);
check('every flavour of not-yet is pending', waiting.pending === 5 && waiting.state === 'pending', JSON.stringify(waiting));

const mixed = await checksFor([
  { name: 'unit', conclusion: 'SUCCESS' },
  { name: 'lint', conclusion: 'FAILURE' },
  { name: 'e2e', status: 'IN_PROGRESS' },
]);
check(
  'pending and failing are counted apart, because they mean opposite things',
  mixed.passing === 1 && mixed.failing === 1 && mixed.pending === 1,
  JSON.stringify(mixed)
);
check('and one failure outranks anything still running', mixed.state === 'failing', mixed.state);
check('the failing check is named, so the card can say which', mixed.failed.join() === 'lint', JSON.stringify(mixed.failed));

const byContext = await checksFor([{ context: 'ci/circleci', state: 'FAILURE' }]);
check(
  'a StatusContext failure is named by its context',
  byContext.failed.join() === 'ci/circleci',
  JSON.stringify(byContext.failed)
);

const many = await checksFor(Array.from({ length: 8 }, (_, i) => ({ name: `job-${i}`, conclusion: 'FAILURE' })));
check('all eight failures are counted', many.failing === 8 && many.total === 8, JSON.stringify(many));
check('but only six are named — this is a phone card, not a log', many.failed.length === 6, JSON.stringify(many.failed));

const nameless = await checksFor([{ conclusion: 'FAILURE' }]);
check(
  'a failure with no name still counts, it just cannot be listed',
  nameless.failing === 1 && nameless.failed.length === 0,
  JSON.stringify(nameless)
);

const unknown = await checksFor([{ name: 'mystery', conclusion: '', state: '', status: '' }]);
check(
  'a check in no state anyone recognises counts as failing — unknown means do not merge',
  unknown.failing === 1 && unknown.state === 'failing',
  JSON.stringify(unknown)
);

/* ------------------------------------------------------ the PR for a branch */

console.log('\nthe PR for a branch, if there is one');

world({ prs: { 42: rawPR() } });
const forBranch = await pr.viewForBranch(REPO, 'worktree-pr-delivery-q7n');
check('a branch with a PR gets it', forBranch && forBranch.number === 42, JSON.stringify(forBranch));

const noneYet = await pr.viewForBranch(REPO, 'worktree-not-pushed-yet');
check(
  'a branch with no PR is null and does not throw — that is the ordinary state of work in progress',
  noneYet === null,
  JSON.stringify(noneYet)
);
check(
  'while view() on the same branch still does throw, because there the caller asked for a PR',
  (await threw(() => pr.view(REPO, 'worktree-not-pushed-yet'))) !== null
);

/* ------------------------------------------------------------------- create */

console.log('\nopening one');

world({
  create: { stdout: 'Warning: 1 uncommitted change\nhttps://github.com/acme/widgets/pull/99\n' },
  prs: { 99: rawPR({ number: 99, url: 'https://github.com/acme/widgets/pull/99', title: 'A new one' }) },
});
resetLog();

const made = await pr.create(REPO, { head: 'worktree-thing-a1b', title: 'A new one', body: 'why' });
check('the number is dug out of the url gh printed, past the noise', made.number === 99, JSON.stringify(made.number));
check('and the PR comes back fully populated, not just as a url', made.title === 'A new one' && made.checks.state === 'none');

const createArgs = calls().find((c) => c.args[1] === 'create').args;
check('base defaults to main', createArgs[createArgs.indexOf('--base') + 1] === 'main');
check('the head branch is passed when given', createArgs[createArgs.indexOf('--head') + 1] === 'worktree-thing-a1b');
check(
  'title and body go as arguments, never interpolated into a shell',
  createArgs.includes('--title') && createArgs.includes('--body')
);
check('and it is not a draft unless asked', !createArgs.includes('--draft'));

resetLog();
await pr.create(REPO, { base: 'develop', title: 'draft one', draft: true });
const draftArgs = calls().find((c) => c.args[1] === 'create').args;
check('draft: true adds --draft', draftArgs.includes('--draft'));
check('an explicit base is used instead of main', draftArgs[draftArgs.indexOf('--base') + 1] === 'develop');
check('and no --head is sent when none was given', !draftArgs.includes('--head'));

world({ create: { stdout: 'Creating pull request for a branch that is not pushed\n' }, prs: {} });
const noUrl = await threw(() => pr.create(REPO, { title: 't' }));
check('output with no PR url in it throws rather than parsing garbage', noUrl !== null);
check('and quotes what gh actually said', noUrl && /not pushed/.test(noUrl.message), noUrl && noUrl.message);

world({ create: { stderr: 'pull request create failed: GraphQL: No commits between main and feature' }, prs: {} });
const refusedCreate = await threw(() => pr.create(REPO, { title: 't' }));
check(
  "a refusal from gh comes back as gh's own sentence",
  refusedCreate && /No commits between/.test(refusedCreate.message),
  refusedCreate && refusedCreate.message
);

/* ------------------------------------------------------------ waiting for CI */

console.log('\nwaiting for the checks to report');

const pending = [{ name: 'build', status: 'IN_PROGRESS' }];
const green = [{ name: 'build', conclusion: 'SUCCESS' }];
const viewCalls = () => calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'view').length;

// Nothing to wait for: one look, no sleep, and a verdict.
world({ prs: { 42: rawPR({ statusCheckRollup: green }) } });
resetLog();
let slept = 0;
let settled = await pr.settle(REPO, 42, { sleep: async () => (slept += 1) });
check('checks that have already reported are not waited on', slept === 0 && settled.timedOut === false, `slept ${slept}`);
check('and it costs exactly one gh pr view', viewCalls() === 1, `${viewCalls()} views`);
check('the verdict travels back on the PR itself', settled.pr.checks.state === 'passing', settled.pr.checks.state);

// The ordinary case, and the whole reason this exists: pending the instant the PR is
// opened, green a moment later. The world changes *in the sleep*, which is where it
// changes in life too.
world({ prs: { 42: rawPR({ statusCheckRollup: pending }) } });
resetLog();
slept = 0;
settled = await pr.settle(REPO, 42, {
  sleep: async () => {
    slept += 1;
    world({ prs: { 42: rawPR({ statusCheckRollup: green }) } });
  },
});
check('a pending check is waited for, then read again', slept === 1 && viewCalls() === 2, `slept ${slept}, ${viewCalls()} views`);
check('and the answer is the settled one', settled.pr.checks.state === 'passing' && !settled.timedOut, settled.pr.checks.state);

// A red check settles just as truthfully as a green one. `settle` does not judge —
// it only stops waiting — and the caller is the one that refuses to merge over it.
world({ prs: { 42: rawPR({ statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }] }) } });
resetLog();
settled = await pr.settle(REPO, 42, { sleep: async () => (slept += 1) });
check('a failing check is settled, not waited on', settled.pr.checks.state === 'failing' && !settled.timedOut);
check('and it names which one, for the sentence that has to explain it', settled.pr.checks.failed.join() === 'build');

// Checks that never report. The timeout must come back as `timedOut`, still pending —
// not as a settled verdict, because "CI has not run in five minutes" is emphatically
// not "safe to merge".
world({ prs: { 42: rawPR({ statusCheckRollup: pending }) } });
resetLog();
settled = await pr.settle(REPO, 42, { timeoutMs: 0, sleep: async () => (slept += 1) });
check('a zero timeout looks once and gives up', settled.timedOut === true && viewCalls() === 1, `${viewCalls()} views`);
check('and hands back pending rather than a verdict', settled.pr.checks.state === 'pending', settled.pr.checks.state);

resetLog();
settled = await pr.settle(REPO, 42, { timeoutMs: 40, intervalMs: 1, sleep: (ms) => new Promise((r) => setTimeout(r, 25)) });
check('a wait that never settles ends — bounded, not forever', settled.timedOut === true && viewCalls() < 6, `${viewCalls()} views`);

/* ------------------------------------------- waiting for mergeability itself */

/**
 * The second wait, and the one nothing used to do at all.
 *
 * GitHub computes `mergeable` asynchronously: for a few seconds after a push it is
 * `UNKNOWN`, which is not a verdict but the absence of one. Observed in life at twelve
 * seconds — `UNKNOWN UNKNOWN` on the poll straight after the push, `MERGEABLE CLEAN` on
 * the same pull request a moment later — and a worker in a repo with no CI reaches the
 * merge inside that window every time, because `settle()` above has nothing to wait for.
 *
 * What makes it worth a test rather than a comment is that the failure is a *lie*, not
 * an error: GitHub refuses a merge it has not assessed with the same sentence it uses
 * for a real conflict, so the session ends telling Adam his branch conflicts with main
 * over a branch that merges fine.
 */
console.log('\nwaiting for GitHub to work out whether it can merge');

world({ prs: { 42: rawPR() } });
resetLog();
slept = 0;
let assessed = await pr.mergeability(REPO, 42, { sleep: async () => (slept += 1) });
check('a mergeability GitHub already has is not waited on', slept === 0 && viewCalls() === 1, `slept ${slept}, ${viewCalls()} views`);
check('and it is not called unresolved', assessed.unresolved === false && assessed.pr.mergeable === 'MERGEABLE');

// The ordinary case and the whole point: UNKNOWN the instant the branch is pushed,
// MERGEABLE a moment later. As with `settle`, the world changes *in the sleep*.
world({ prs: { 42: rawPR({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) } });
resetLog();
slept = 0;
assessed = await pr.mergeability(REPO, 42, {
  sleep: async () => {
    slept += 1;
    world({ prs: { 42: rawPR() } });
  },
});
check('an UNKNOWN mergeability is waited for, then read again', slept === 1 && viewCalls() === 2, `slept ${slept}, ${viewCalls()} views`);
check('and the answer is the one GitHub eventually gave', assessed.pr.mergeable === 'MERGEABLE' && !assessed.unresolved);

// A conflict is a verdict. Nothing waits on one, because waiting for GitHub to change
// its mind is not what this is for.
world({ prs: { 42: rawPR({ mergeable: 'CONFLICTING' }) } });
resetLog();
slept = 0;
assessed = await pr.mergeability(REPO, 42, { sleep: async () => (slept += 1) });
check('CONFLICTING is an answer and is not waited on', slept === 0 && assessed.unresolved === false, `slept ${slept}`);

// The guard that keeps an already-merged answer cheap. GitHub reports `mergeable:
// UNKNOWN` on a merged or closed pull request permanently, so without the open check
// every re-delivery of landed work would sit out the whole timeout to learn nothing.
for (const state of ['MERGED', 'CLOSED']) {
  world({ prs: { 42: rawPR({ state, mergeable: 'UNKNOWN' }) } });
  resetLog();
  slept = 0;
  assessed = await pr.mergeability(REPO, 42, { sleep: async () => (slept += 1) });
  check(
    `a ${state} pull request reports UNKNOWN for good, so it is read once and not waited on`,
    slept === 0 && viewCalls() === 1 && assessed.unresolved === false,
    `slept ${slept}, ${viewCalls()} views, unresolved ${assessed.unresolved}`
  );
}

// And when the answer never comes, it says so — bounded, and *not* as a conflict.
world({ prs: { 42: rawPR({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) } });
resetLog();
assessed = await pr.mergeability(REPO, 42, { timeoutMs: 0, sleep: async () => (slept += 1) });
check('a zero timeout looks once and gives up', assessed.unresolved === true && viewCalls() === 1, `${viewCalls()} views`);
check('handing back UNKNOWN rather than inventing a verdict', assessed.pr.mergeable === 'UNKNOWN', assessed.pr.mergeable);

resetLog();
assessed = await pr.mergeability(REPO, 42, { timeoutMs: 40, intervalMs: 1, sleep: () => new Promise((r) => setTimeout(r, 25)) });
check('a mergeability that never resolves ends — bounded, not forever', assessed.unresolved === true && viewCalls() < 6, `${viewCalls()} views`);

/* -------------------------------------------------------------------- merge */

console.log('\nmerging — the act the whole channel exists to gate');

const mergeCalls = () => calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');

world({ prs: { 42: rawPR({ state: 'MERGED', mergedAt: '2026-08-09T15:04:05Z', mergeCommit: { oid: 'abc123' } }) } });
resetLog();
const already = await pr.merge(REPO, 42);
check('an already-merged PR does not throw — answering twice is not an error', already.alreadyMerged === true);
check('it reports the merge that happened', already.state === 'MERGED' && already.mergeCommit === 'abc123');
check(
  'and gh pr merge was never reached',
  mergeCalls().length === 0,
  JSON.stringify(calls().map((c) => c.args.slice(0, 2)))
);

world({ prs: { 42: rawPR({ state: 'CLOSED' }) } });
resetLog();
const closedErr = await threw(() => pr.merge(REPO, 42));
check('a closed PR refuses', closedErr !== null);
check(
  'with 409, so the inbox can tell a refusal from a crash',
  closedErr && closedErr.status === 409,
  closedErr && String(closedErr.status)
);
check(
  'and a sentence that says to reopen it',
  closedErr && /closed/.test(closedErr.message) && /reopen/.test(closedErr.message),
  closedErr && closedErr.message
);
check('without ever asking gh to merge it', mergeCalls().length === 0);

world({ prs: { 42: rawPR({ mergeable: 'CONFLICTING' }) } });
resetLog();
const conflictErr = await threw(() => pr.merge(REPO, 42));
check('a conflicting PR refuses', conflictErr !== null && conflictErr.status === 409);
check(
  'naming the base branch and the rebase that fixes it',
  conflictErr && /main/.test(conflictErr.message) && /rebase/.test(conflictErr.message),
  conflictErr && conflictErr.message
);
check('without ever asking gh to merge it', mergeCalls().length === 0);

world({ prs: { 42: rawPR() } });
resetLog();
const merged = await pr.merge(REPO, 42);
check(
  'a mergeable PR merges',
  merged.alreadyMerged === false && merged.state === 'MERGED',
  JSON.stringify({ already: merged.alreadyMerged, state: merged.state })
);
check('and comes back re-read, with the merge commit gh recorded', merged.mergeCommit === '0ff1ce0ff1ce' && merged.mergedAt !== null);
// A merge commit, not a squash, and the reason is worktree cleanup rather than taste:
// a squash-merged branch is never an ancestor of main, and both the daemon's sweep and
// the attic sweep outside this repo gate on exactly that. See lib/config.js.
check('a merge commit is the default', mergeCalls()[0].args.includes('--merge'));
check('the branch is deleted by default', mergeCalls()[0].args.includes('--delete-branch'));
check(
  'and the merge is never queued with --auto — a tap on the phone is an act, not a promise',
  !mergeCalls()[0].args.includes('--auto'),
  JSON.stringify(mergeCalls()[0].args)
);
check(
  'the PR is read before the merge and read again after',
  // `pr view` specifically: `repo view` is the account probe, which is a different
  // question asked once per checkout and has nothing to do with the merge preflight.
  calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'view').length === 2,
  JSON.stringify(calls().map((c) => c.args.slice(0, 2)))
);

for (const [method, flag] of [
  ['rebase', '--rebase'],
  ['merge', '--merge'],
  ['squash', '--squash'],
]) {
  world({ prs: { 42: rawPR() } });
  resetLog();
  await pr.merge(REPO, 42, { method });
  check(`method "${method}" becomes ${flag}`, mergeCalls()[0].args.includes(flag), JSON.stringify(mergeCalls()[0].args));
}

world({ prs: { 42: rawPR() } });
resetLog();
await pr.merge(REPO, 42, { method: 'fast-forward-if-you-please' });
check(
  'an unrecognised method falls back to the default rather than reaching the CLI as a usage error',
  mergeCalls()[0].args.includes('--merge'),
  JSON.stringify(mergeCalls()[0].args)
);

world({ prs: { 42: rawPR() } });
resetLog();
await pr.merge(REPO, 42, { deleteBranch: false });
check('deleteBranch: false keeps the branch', !mergeCalls()[0].args.includes('--delete-branch'));

world({
  prs: { 42: rawPR() },
  mergeRefusal: 'Pull request is not mergeable: the base branch policy prohibits the merge.',
});
resetLog();
const refused = await threw(() => pr.merge(REPO, 42));
check('a merge GitHub refuses comes back as 409', refused && refused.status === 409, refused && String(refused.status));
check(
  'carrying GitHub’s own reason, because "it did not merge" with nothing attached is the worst thing this could say',
  refused && /base branch policy/.test(refused.message),
  refused && refused.message
);
check(
  'and saying nothing about mergeability, which GitHub had perfectly well worked out',
  refused && !/UNKNOWN|had still not/i.test(refused.message),
  refused && refused.message
);

/* ------------------------------- merging inside GitHub's mergeability window */

// The sequence this whole thing is about, driven through `merge()` rather than through
// `mergeability()` alone: what has to be right is the *decision*, and the decision is
// here. UNKNOWN on the first read, MERGEABLE by the time it is asked again, merged.
world({ prs: { 42: rawPR({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) } });
resetLog();
slept = 0;
const raced = await pr.merge(REPO, 42, {
  sleep: async () => {
    slept += 1;
    world({ prs: { 42: rawPR() } });
  },
});
check(
  'a pull request GitHub has not assessed yet is waited on, not refused',
  slept === 1 && raced.state === 'MERGED' && mergeCalls().length === 1,
  `slept ${slept}, ${raced.state}, ${mergeCalls().length} merges`
);

// Still UNKNOWN when the wait runs out, and GitHub refuses. It goes out anyway — the
// merge endpoint is the only thing that can settle this and it settles it atomically —
// but the sentence must not be read as a conflict, because nothing established one.
world({
  prs: { 42: rawPR({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) },
  mergeRefusal: 'Pull request is not mergeable',
});
resetLog();
const unknownErr = await threw(() => pr.merge(REPO, 42, { timeoutMs: 0 }));
check('an unresolved mergeability still asks GitHub, which is the only thing that knows', mergeCalls().length === 1);
check('a refusal there is a 409 like any other', unknownErr && unknownErr.status === 409, unknownErr && String(unknownErr.status));
check(
  'carrying GitHub’s own sentence',
  unknownErr && /not mergeable/.test(unknownErr.message),
  unknownErr && unknownErr.message
);
check(
  'and saying that GitHub had not worked mergeability out, so it may be the race',
  unknownErr && /had still not worked out/.test(unknownErr.message),
  unknownErr && unknownErr.message
);
check(
  'without ever calling it a conflict or asking for a rebase — nothing established either',
  unknownErr && !/conflict/i.test(unknownErr.message) && !/rebase/i.test(unknownErr.message),
  unknownErr && unknownErr.message
);

// The other half of the same guarantee: a mergeability GitHub *did* work out is still
// refused on the spot, with no wait and no merge call.
world({ prs: { 42: rawPR({ mergeable: 'CONFLICTING' }) } });
resetLog();
slept = 0;
const stillConflict = await threw(() => pr.merge(REPO, 42, { sleep: async () => (slept += 1) }));
check(
  'a real conflict is refused without waiting for a second opinion',
  stillConflict && stillConflict.status === 409 && slept === 0 && mergeCalls().length === 0,
  `slept ${slept}, ${mergeCalls().length} merges`
);

/* -------------------------------------------------------- close and comment */

console.log('\nclosing one, and saying why');

world({ prs: { 42: rawPR() } });
resetLog();
const shut = await pr.close(REPO, 42, { comment: 'superseded by #43' });
check('close returns the PR, re-read', shut.number === 42 && shut.state === 'CLOSED', shut.state);
const closeArgs = calls().find((c) => c.args[1] === 'close').args;
check(
  'the reason goes on the PR, so the tab is not a mystery later',
  closeArgs.includes('--comment') && closeArgs.includes('superseded by #43')
);
check('and the branch survives unless deleting it was asked for', !closeArgs.includes('--delete-branch'));

world({ prs: { 42: rawPR() } });
resetLog();
await pr.close(REPO, 42, { deleteBranch: true });
const closeArgs2 = calls().find((c) => c.args[1] === 'close').args;
check('deleteBranch: true deletes it', closeArgs2.includes('--delete-branch'));
check('and no empty --comment is sent when there is nothing to say', !closeArgs2.includes('--comment'));

world({ prs: { 42: rawPR() } });
resetLog();
await pr.comment(REPO, 42, 'Adam asked for changes: see the bead.');
const commentArgs = calls().find((c) => c.args[1] === 'comment').args;
check(
  'a comment reaches the PR thread intact',
  commentArgs.includes('--body') && commentArgs.includes('Adam asked for changes: see the bead.')
);

/* -------------------------------------------------------------- the one rule */

console.log('\nthe rule the file is built around');

const src = fs.readFileSync(LIB, 'utf8');
check(
  'nothing in lib/pr.js shells out to a push — a daemon that can push is one that can land work nobody approved',
  !/['"]push['"]/.test(src),
  (src.match(/.*['"]push['"].*/) || [])[0]
);
check(
  'and nothing there writes to a branch behind the PR verbs',
  !/['"](commit|reset|checkout|cherry-pick)['"]/.test(src),
  (src.match(/.*['"](commit|reset|checkout|cherry-pick)['"].*/) || [])[0]
);

/* ------------------------------------------------------------------ verdict */

console.log('');
if (failures) {
  console.log(`${failures} check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('all checks passed');
