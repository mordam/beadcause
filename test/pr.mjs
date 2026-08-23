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
// '--input -' is only ever sent by callers that wrote something to stdin (submitReview),
// so reading fd 0 here is safe: every other call leaves stdin unwritten and unclosed, and
// a synchronous read against that would hang the fake forever rather than fail loudly.
const inputIdx = args.indexOf('--input');
const stdinBody = inputIdx >= 0 && args[inputIdx + 1] === '-' ? fs.readFileSync(0, 'utf8') : null;
// The token is logged because "which account was this call made as" is the whole
// question one scenario below exists to answer, and it is invisible in argv.
fs.appendFileSync(
  state.log,
  JSON.stringify({ args: args, cwd: process.cwd(), token: process.env.GH_TOKEN || null, stdin: stdinBody }) + '\\n'
);

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
  // bc-36xx.14: GraphQL flapping, simulated. state.repoOutage.count 503s are served
  // before this falls through to whatever the rest of this handler would otherwise
  // have said — a blip that clears (count less than the caller's own retries) and an
  // outage that outlasts them (count at or above it) are both driven from here.
  if (state.repoOutage && state.repoOutage.count > 0) {
    state.repoOutage.count -= 1;
    save();
    fail(state.repoOutage.message || 'HTTP 503: No server is currently available to service your request (https://api.github.com/graphql)');
  }
  // The two-account world: which repo you can see depends on the token you sent.
  if (state.repoByToken) {
    var seen = state.repoByToken[process.env.GH_TOKEN || ''];
    if (!seen) fail("GraphQL: Could not resolve to a Repository with the name 'them/private'. (repository)");
    out(JSON.stringify(seen));
  }
  if (!state.repo) fail('none of the git remotes configured for this repository point to a known GitHub host');
  out(JSON.stringify(state.repo));
}

if (a === 'api' && b === 'graphql') {
  // The one place this fake speaks GraphQL: thread listing and thread resolution, neither
  // of which REST can answer at all. Routed by which field name the query text carries,
  // exactly the way pr.js's two callers are told apart from each other.
  //
  // bc-36xx.26: the same flapping repo-view simulates above, on this endpoint instead —
  // state.graphqlOutage.count 503s are served, on EITHER query, before falling through to
  // whatever this handler would otherwise have said. One counter for both queries because
  // the outage this simulates is GraphQL itself answering with a shrug, not one query in
  // particular.
  if (state.graphqlOutage && state.graphqlOutage.count > 0) {
    state.graphqlOutage.count -= 1;
    save();
    fail(state.graphqlOutage.message || 'HTTP 503: No server is currently available to service your request (https://api.github.com/graphql)');
  }
  var qArg = args.filter(function (x) { return x.indexOf('query=') === 0; })[0] || '';
  var query = qArg.slice('query='.length);
  if (query.indexOf('resolveReviewThread') >= 0) {
    if (state.resolveRefusal) fail(state.resolveRefusal);
    var tArg = args.filter(function (x) { return x.indexOf('threadId=') === 0; })[0] || '';
    var threadId = tArg.slice('threadId='.length);
    var threads = state.threads || [];
    var match = null;
    for (var ti = 0; ti < threads.length; ti++) {
      if (threads[ti].id === threadId) match = threads[ti];
    }
    if (!match) fail("Could not resolve to a node with the global id of '" + threadId + "'");
    match.isResolved = true;
    save();
    out(JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } }));
  }
  if (query.indexOf('reviewThreads') >= 0) {
    if (state.threadsRefusal) fail(state.threadsRefusal);
    out(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: state.threads || [] } } } } }));
  }
  fail('unknown graphql query');
}

if (a === 'api') {
  // The reviews endpoint, which is how an approval (or an inline-commented review) is
  // submitted: it hands back the review it created, and that response is where the
  // permanent anchor to the approval comes from.
  var route = args.filter(function (x) { return x.indexOf('repos/') === 0; })[0] || '';
  if (/\\/pulls\\/\\d+\\/reviews$/.test(route)) {
    if (state.reviewRefusal) fail(state.reviewRefusal);
    var n = route.match(/pulls\\/(\\d+)/)[1];
    // submitReview() sends its whole body over stdin rather than as -f fields, because
    // 'comments' is an array and gh's field flags only ever set one scalar apiece; approve()
    // still sends -f event=/-f body= and stdinBody is null for it, exactly as before.
    out(JSON.stringify({
      id: 909,
      node_id: 'PRR_909',
      html_url: 'https://github.com/them/shared/pull/' + n + '#pullrequestreview-909',
      state: (stdinBody && JSON.parse(stdinBody).event) || 'APPROVED',
      submitted_at: '2026-08-17T15:02:03Z',
      user: { login: state.reviewAs || 'somebody' },
    }));
  }
  fail('unknown api route: ' + route);
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
    // Simulates a real permission flip: the account this call actually ran as (its
    // token, '' for ambient) may not be the one that answered the earlier probe.
    if (state.writeRefusal && (process.env.GH_TOKEN || null) !== (state.writeRefusal.token || null)) {
      fail(state.writeRefusal.message);
    }
    if (state.create && state.create.stderr) fail(state.create.stderr);
    out((state.create && state.create.stdout) || '');
  }
  if (b === 'merge') {
    if (state.writeRefusal && (process.env.GH_TOKEN || null) !== (state.writeRefusal.token || null)) {
      fail(state.writeRefusal.message);
    }
    if (state.mergeRefusal) fail(state.mergeRefusal);
    const found = find(rest[0]);
    if (!found) fail('no pull requests found');
    found.state = 'MERGED';
    found.mergedAt = '2026-08-09T15:04:05Z';
    found.mergeCommit = { oid: '0ff1ce0ff1ce' };
    save();
    // The merge landed and *then* something went wrong — real gh's own shape when it
    // cannot delete the local branch. The write above happens either way, which is the
    // whole point: the exit code says no and github.com says yes.
    if (state.mergeCleanupFailure) fail(state.mergeCleanupFailure);
    out('Merged pull request #' + found.number + '\\n');
  }
  if (b === 'close') {
    const found = find(rest[0]);
    if (!found) fail('no pull requests found');
    found.state = 'CLOSED';
    save();
    out('Closed pull request #' + found.number + '\\n');
  }
  if (b === 'comment') {
    if (state.commentRefusal) fail(state.commentRefusal);
    out('https://github.com/acme/widgets/pull/1#issuecomment-1\\n');
  }
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
  latestReviews: [],
  mergedAt: null,
  mergeCommit: null,
  ...over,
});

/** One row of `latestReviews`, in the shape gh actually hands it over. */
const rawReview = (over = {}) => ({
  id: '',
  author: { login: 'somebody' },
  authorAssociation: 'COLLABORATOR',
  body: '',
  submittedAt: '2026-08-17T14:40:19Z',
  includesCreatedEdit: false,
  reactionGroups: [],
  state: 'APPROVED',
  commit: { oid: '' },
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

/* -------------------------------------------- GitHub answering with a shrug */

/**
 * bc-36xx.14: a null from `slugFor` used to mean one thing to every caller — no GitHub
 * repo here — and it was wrong the moment the probe itself was the thing that failed.
 * `gh repo view` is GraphQL, and GraphQL flapping (measured 2026-08-17, both here and
 * against a real repo: REST answered throughout while `repo view` 503'd on roughly
 * four calls in five, and the exact same command worked five minutes later) says
 * nothing about whether the repo exists. `probeTransient` is what tells the two apart,
 * and `noRepoMessage` — the exact sentence `bin/deliver.js` dies with — is read
 * straight off it here, so this is proving the real seam rather than a copy of it.
 */
console.log('\nGitHub answering with a shrug, rather than an answer');

world({ repo: { nameWithOwner: 'acme/widgets' }, repoOutage: { count: 1 } });
resetLog();
check(
  'a blip that clears within the retries still resolves the repo',
  (await pr.slugFor(REPO)) === 'acme/widgets'
);
check('and it did retry — more than one gh repo view for the one answer', calls().filter((c) => c.args[0] === 'repo').length > 1, JSON.stringify(calls()));
check('a repo that answered after a blip is not reported as unreachable', pr.probeTransient(REPO) === false);

world({ repo: { nameWithOwner: 'acme/widgets' }, repoOutage: { count: 9 } });
resetLog();
check(
  'an outage that outlasts every retry still comes back null, same as a real absence',
  (await pr.slugFor(REPO)) === null
);
check(
  'but it is flagged transient — GitHub never actually answered',
  pr.probeTransient(REPO) === true
);
check(
  'so the sentence deliver.js dies with says outage, not absence, and says to retry rather than to give up',
  /outage/.test(pr.noRepoMessage(REPO, 'work-x', 'zz-1')) &&
    /retry this delivery/.test(pr.noRepoMessage(REPO, 'work-x', 'zz-1')) &&
    !/no GitHub repo is visible/.test(pr.noRepoMessage(REPO, 'work-x', 'zz-1')),
  pr.noRepoMessage(REPO, 'work-x', 'zz-1')
);

world({ repo: null });
resetLog();
check('a checkout that genuinely has no remote is still null', (await pr.slugFor(REPO)) === null);
check(
  'and it is NOT flagged transient — a clean "no remote" is answered, not a shrug',
  pr.probeTransient(REPO) === false
);
check(
  'so the same checkout gets the old sentence back — give up here, not retry',
  /no GitHub repo is visible/.test(pr.noRepoMessage(REPO, 'work-x', 'zz-1')) &&
    !/outage/.test(pr.noRepoMessage(REPO, 'work-x', 'zz-1')),
  pr.noRepoMessage(REPO, 'work-x', 'zz-1')
);
check(
  'a 404-shaped refusal is a real answer too, not a shrug — no retry, no transient flag',
  calls().filter((c) => c.args[0] === 'repo').length === 1
);

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

/* --------------------------------------------- and as one that can merge */

/**
 * The second half of the same question, and the half that was not asked.
 *
 * beadcause's own repo is `mordam/beadcause`. Both logins can see it — the active one
 * is a collaborator with READ, the owner has ADMIN — so the ambient probe answered,
 * the sweep stopped there, and every `gh` call in that checkout ran as the READ
 * account. Nothing looked wrong: listing PRs, reading checks, posting comments all
 * work with READ. The merge did not, and it failed at the end of a ship with
 *
 *     GraphQL: NeanderthalMan does not have the correct permissions to execute
 *     `MergePullRequest`
 *
 * after the work was already done. So visibility is no longer enough to win the probe.
 */
console.log('\nand which account can merge in it');

pr.forgetAvailability();
resetLog();
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'readonlyacct', active: true },
      { user: 'owneracct', active: false },
    ],
  },
  tokens: { readonlyacct: 'tok-readonly', owneracct: 'tok-owner' },
  repoByToken: {
    '': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
    'tok-owner': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
  },
  prs: { 42: rawPR() },
});

check('a repo the active account can only read still resolves', (await pr.slugFor(REPO)) === 'them/shared');

resetLog();
await pr.merge(REPO, 42, { method: 'squash' }).catch(() => null);
const ownerMerges = calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
check(
  'but `gh pr merge` runs as the account that may actually merge, not the one that answered first',
  ownerMerges.length === 1 && ownerMerges[0].token === 'tok-owner',
  JSON.stringify(calls().map((c) => [c.args.join(' '), c.token]))
);
check(
  'and so does everything else in that checkout',
  calls().length > 0 && calls().every((c) => c.token === 'tok-owner'),
  JSON.stringify(calls().map((c) => [c.args.join(' '), c.token]))
);

pr.forgetAvailability();
resetLog();
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'readonlyacct', active: true },
      { user: 'otheracct', active: false },
    ],
  },
  tokens: { readonlyacct: 'tok-readonly', otheracct: 'tok-other' },
  repoByToken: { '': { nameWithOwner: 'them/shared', viewerPermission: 'READ' } },
});

check(
  'a repo nobody here can write to is still resolved read-only rather than lost',
  (await pr.slugFor(REPO)) === 'them/shared'
);
check(
  'and that answer is the ambient account, carrying no token',
  calls().filter((c) => c.args[0] === 'repo').every((c) => c.token === null || c.token === 'tok-other') &&
    calls().filter((c) => c.args[0] === 'repo')[0].token === null,
  JSON.stringify(calls().map((c) => [c.args.join(' '), c.token]))
);

/**
 * bc-khoe.11 — the account cache outliving the account it remembered.
 *
 * `accountFor` is cached for the life of the process, on purpose: it is asked on
 * every `gh` call, and re-sweeping every account on every one would be traffic for
 * nothing on the common day nothing changes. But a `gh auth switch` run by some
 * *other* session sharing this Mac's one `~/.config/gh/hosts.yml` can flip who the
 * ambient account actually is without this process ever finding out — its cached
 * answer keeps naming an account that could write when it was first asked, and
 * every write after the flip fails with GitHub's own permission refusal until the
 * daemon is restarted. That is the whole outage bc-khoe.11 describes.
 *
 * So a write that fails this way re-sweeps once, right there, rather than trusting
 * the stale answer for the rest of the process's life.
 */
console.log('\nand the account cache surviving a flip underneath it');

pr.forgetAvailability();
resetLog();
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'readonlyacct', active: true },
      { user: 'owneracct', active: false },
    ],
  },
  tokens: { readonlyacct: 'tok-readonly', owneracct: 'tok-owner' },
  // The world as this process first saw it: the ambient account could write, so
  // `resolve()` cached it and never asked again.
  repoByToken: {
    '': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
    'tok-owner': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
  },
});
check('the ambient account is cached as the writer', (await pr.slugFor(REPO)) === 'them/shared');

// The flip: something else on the Mac ran `gh auth switch`. Nothing in this process
// asked again, so its cache still says "ambient can write" — exactly as wrong as the
// real outage. The account that can actually write now is the other one.
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'readonlyacct', active: true },
      { user: 'owneracct', active: false },
    ],
  },
  tokens: { readonlyacct: 'tok-readonly', owneracct: 'tok-owner' },
  repoByToken: {
    '': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
    'tok-owner': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
  },
  writeRefusal: { token: 'tok-owner', message: 'GraphQL: must be a collaborator (createPullRequest)' },
  create: { stdout: 'https://github.com/them/shared/pull/77\n' },
  prs: { 77: rawPR({ number: 77, url: 'https://github.com/them/shared/pull/77', title: 'After the flip' }) },
});

resetLog();
const madeAfterFlip = await pr.create(REPO, { head: 'worktree-thing-a1b', title: 'After the flip', body: 'why' });
const createCalls = calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
check(
  'the stale cached account is tried first, and refused',
  createCalls.length === 2 && createCalls[0].token === null,
  JSON.stringify(createCalls)
);
check(
  'a fresh sweep finds the account that can actually write, and the retry lands',
  createCalls[1].token === 'tok-owner' && madeAfterFlip.number === 77,
  JSON.stringify({ createCalls, made: madeAfterFlip })
);

resetLog();
check('and the corrected account is what stays cached', (await pr.slugFor(REPO)) === 'them/shared');
check(
  'costing one `gh repo view` to re-confirm it, not another sweep of every account',
  calls().filter((c) => c.args[0] === 'repo').length === 1 && calls().every((c) => c.args[0] !== 'auth'),
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

// The mirror image, on `merge()` — the other sentence GitHub uses for the same refusal.
pr.forgetAvailability();
resetLog();
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'readonlyacct', active: true },
      { user: 'owneracct', active: false },
    ],
  },
  tokens: { readonlyacct: 'tok-readonly', owneracct: 'tok-owner' },
  repoByToken: {
    '': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
    'tok-owner': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
  },
  prs: { 43: rawPR({ number: 43 }) },
});
await pr.slugFor(REPO);

world({
  auth: {
    ok: true,
    accounts: [
      { user: 'readonlyacct', active: true },
      { user: 'owneracct', active: false },
    ],
  },
  tokens: { readonlyacct: 'tok-readonly', owneracct: 'tok-owner' },
  repoByToken: {
    '': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
    'tok-owner': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
  },
  writeRefusal: {
    token: 'tok-owner',
    message: 'GraphQL: readonlyacct does not have the correct permissions to execute `MergePullRequest`',
  },
  prs: { 43: rawPR({ number: 43 }) },
});

resetLog();
const mergedAfterFlip = await pr.merge(REPO, 43, { method: 'squash' });
const mergeCallsAfterFlip = calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
check(
  'merge() re-sweeps and retries on the same shape of refusal',
  mergeCallsAfterFlip.length === 2 && mergeCallsAfterFlip[0].token === null && mergeCallsAfterFlip[1].token === 'tok-owner',
  JSON.stringify(mergeCallsAfterFlip)
);
check('and the merge that landed is what comes back', mergedAfterFlip.state === 'MERGED', JSON.stringify(mergedAfterFlip));

pr.forgetAvailability();
resetLog();
world({
  auth: { ok: true, accounts: [{ user: 'soloacct', active: true }] },
  tokens: { soloacct: 'tok-solo' },
  repo: { nameWithOwner: 'acme/widgets' },
});
check('a Mac with one login is unchanged — no permission, no sweep', (await pr.slugFor(REPO)) === 'acme/widgets');
check(
  'and it costs the one `gh repo view` it always did',
  calls().filter((c) => c.args[0] === 'repo').length === 1,
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

/* --------------------------------------------------------- and which reviews */

/**
 * `reviewerFor` — the *second* identity for the same checkout, and the one question
 * `resolve` above is structurally unable to answer.
 *
 * `resolve` picks by capability and takes the account that can write, because it is
 * picking the account that will merge. GitHub refuses an approving review from a pull
 * request's own author, so the winner of that sweep is precisely the account that can
 * never approve what it opened. A reviewer therefore has to be chosen by *role* — can
 * see the repo, and is not the account `resolve` returned — and getting that backwards
 * is not a visible failure: `gh pr review --approve` under the author comes back as a
 * 422 at the end of a review loop, on a live pull request, in another room.
 *
 * The one-login case matters as much as the two-login one and is the commoner of the
 * two everywhere except this Mac. It must be a null the caller falls back from, not a
 * throw, or every delivery on a single-account install dies on a reviewer nobody
 * promised.
 */
console.log('\nand which account can review in it');

pr.forgetAvailability();
resetLog();
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'readonlyacct', active: true },
      { user: 'owneracct', active: false },
    ],
  },
  tokens: { readonlyacct: 'tok-readonly', owneracct: 'tok-owner' },
  repoByToken: {
    '': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
    'tok-owner': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
  },
});

const acting = await pr.slugFor(REPO);
const reviewer = await pr.reviewerFor(REPO);
check('a checkout with two logins has a reviewer at all', !!reviewer && acting === 'them/shared', JSON.stringify(reviewer));
check(
  'and it is the account resolve did NOT return — the one that may only read',
  reviewer && reviewer.login === 'readonlyacct' && reviewer.permission === 'READ',
  JSON.stringify(reviewer)
);
check(
  'READ is enough, because a read collaborator may approve a PR it did not open',
  reviewer && reviewer.permission === 'READ',
  JSON.stringify(reviewer)
);
check(
  'the token key is the ambient one, which is how that account is actually reached',
  reviewer && reviewer.user === '',
  JSON.stringify(reviewer)
);
check('and it carries the repo it is a reviewer of', reviewer && reviewer.slug === 'them/shared', JSON.stringify(reviewer));

resetLog();
await pr.reviewerFor(REPO);
check(
  'the answer is cached — asking twice costs no second sweep',
  calls().filter((c) => c.args[0] === 'repo').length === 0,
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

// The mirror image: the ambient account is the one that can write, so the reviewer has
// to be a *named* account reached with its own token. Getting this the wrong way round
// would look identical in the case above and fail only here.
pr.forgetAvailability();
resetLog();
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'owneracct', active: true },
      { user: 'helperacct', active: false },
    ],
  },
  tokens: { owneracct: 'tok-owner', helperacct: 'tok-helper' },
  repoByToken: {
    '': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
    'tok-helper': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
  },
});

const reviewer2 = await pr.reviewerFor(REPO);
check(
  'when the ambient account is the one that writes, the reviewer is the other one',
  reviewer2 && reviewer2.login === 'helperacct' && reviewer2.user === 'helperacct',
  JSON.stringify(reviewer2)
);
check(
  'and it is reached with its own token rather than ambiently',
  calls().some((c) => c.args[0] === 'repo' && c.token === 'tok-helper'),
  JSON.stringify(calls().map((c) => [c.args.join(' '), c.token]))
);

pr.forgetAvailability();
resetLog();
world({
  auth: { ok: true, accounts: [{ user: 'soloacct', active: true }] },
  tokens: { soloacct: 'tok-solo' },
  repo: { nameWithOwner: 'acme/widgets' },
});
const solo = await pr.reviewerFor(REPO);
check(
  'a Mac with one login has no reviewer, and says so as a null rather than a throw',
  solo === null,
  JSON.stringify(solo)
);
check(
  'and it does not offer the acting account back as its own reviewer',
  solo === null || solo.login !== 'soloacct',
  JSON.stringify(solo)
);

pr.forgetAvailability();
resetLog();
world({
  auth: { ok: true, accounts: [{ user: 'soloacct', active: true }] },
  tokens: { soloacct: 'tok-solo' },
  repoByToken: {},
});
check(
  'a checkout nothing here can see has no reviewer either — there is no first identity to differ from',
  (await pr.reviewerFor(REPO)) === null
);

pr.forgetAvailability();
resetLog();
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'readonlyacct', active: true },
      { user: 'owneracct', active: false },
    ],
  },
  tokens: { readonlyacct: 'tok-readonly', owneracct: 'tok-owner' },
  repoByToken: {
    '': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
    'tok-owner': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
  },
});
await pr.reviewerFor(REPO);
pr.forgetAvailability();
resetLog();
await pr.reviewerFor(REPO);
check(
  'forgetAvailability() clears the reviewer too — a gh auth login must be able to change this answer',
  calls().filter((c) => c.args[0] === 'repo').length > 0,
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

// The older `gh auth status` output names no accounts, so nothing can say which login
// the ambient one *is*. There may well be a second account here, and it may well be able
// to see the repo — but it might equally be the acting account under its own name, and a
// reviewer that turns out to be the author fails at the 422 on a live pull request after
// looking correct the whole way. No reviewer is the honest answer.
pr.forgetAvailability();
resetLog();
world({
  auth: { ok: true },
  repoByToken: { '': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' } },
});
check(
  'and a gh that will not name its accounts yields no reviewer rather than a guess at one',
  (await pr.reviewerFor(REPO)) === null
);

/* ------------------------------------------------------------- the approval */

/**
 * `approve` — the only write in lib/pr.js deliberately made as somebody *other* than the
 * account everything else here runs as, and the first thing in beadcause that puts state on
 * GitHub under a second identity.
 *
 * Four failures are what these scenarios are for, and none of them is visible by reading
 * the happy path:
 *
 * 1. **Approving as the wrong account.** It comes back as a 422 from GitHub, at the end of a
 *    review loop, on somebody's live pull request. The fake logs `GH_TOKEN` per call, so
 *    "which identity spoke" is an assertion here rather than something you find out later —
 *    and the mirror world is the one used, where the *ambient* account is the owner and the
 *    reviewer is a named account with its own token, because getting the two the wrong way
 *    round passes trivially when the reviewer happens to be the ambient one.
 * 2. **A bare tick.** A review submitted with no body is indistinguishable on the page from
 *    the owner glancing at a diff and pressing approve, which is precisely what Adam asked
 *    this whole path not to look like. So an empty body must refuse *before* shelling out,
 *    and the assertion is the absence of a call.
 * 3. **The comment landing before the review.** It has to be the last thing on the thread —
 *    that is the requirement, in Adam's words — so the order of the two calls is asserted,
 *    not assumed from the order of the source.
 * 4. **The pair treated as atomic.** A comment that fails after the review succeeded must
 *    still report `submitted: true`, because the approval *is* on GitHub at that point and a
 *    caller that read the failure as "nothing was approved" would record a merge-bead saying
 *    a pull request with an approval on it has none.
 */
console.log('\nsubmitting an approving review');

/**
 * The mirror of this Mac's arrangement: the account that can write is the ambient one, and
 * the reviewer is a named account reached with its own token. `reviewAs` is only the login
 * the fake echoes back in the created review.
 */
const twoAccounts = () =>
  world({
    auth: {
      ok: true,
      accounts: [
        { user: 'owneracct', active: true },
        { user: 'helperacct', active: false },
      ],
    },
    tokens: { owneracct: 'tok-owner', helperacct: 'tok-helper' },
    repoByToken: {
      '': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
      'tok-helper': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
    },
    reviewAs: 'helperacct',
  });

const APPROVAL_BODY = '**Approved on #42 by the ReviewAdvocate — an agent, not Adam.** No comments.';
const APPROVAL_NOTE = "**That approval is an agent's, not Adam's.**";

pr.forgetAvailability();
twoAccounts();
resetLog();
const approved = await pr.approve(REPO, 42, { body: APPROVAL_BODY, note: APPROVAL_NOTE });
const reviewCall = calls().find((c) => c.args[0] === 'api');
const noteCall = calls().find((c) => c.args[0] === 'pr' && c.args[1] === 'comment');

check(
  'an approving review is submitted, and it is submitted as the account that did not open the PR',
  approved.submitted === true && approved.reviewer === 'helperacct',
  JSON.stringify(approved)
);
check(
  'the review call carries the reviewer’s token and not the acting account’s',
  !!reviewCall && reviewCall.token === 'tok-helper',
  JSON.stringify(reviewCall)
);
check(
  'it goes to the reviews endpoint with event=APPROVE and the body as a string field',
  !!reviewCall &&
    reviewCall.args.includes('--method') &&
    reviewCall.args.includes('POST') &&
    reviewCall.args.some((a) => /\/pulls\/42\/reviews$/.test(a)) &&
    reviewCall.args.includes('event=APPROVE') &&
    reviewCall.args.includes(`body=${APPROVAL_BODY}`),
  JSON.stringify(reviewCall && reviewCall.args)
);
check(
  'and the answer carries an anchor to the approval itself, not to the pull request',
  approved.url === 'https://github.com/them/shared/pull/42#pullrequestreview-909' && approved.at === '2026-08-17T15:02:03Z',
  JSON.stringify({ url: approved.url, at: approved.at })
);
check(
  'the comment naming the agent is posted, as the same identity that reviewed',
  approved.noted === true && !!noteCall && noteCall.token === 'tok-helper' && noteCall.args.includes(APPROVAL_NOTE),
  JSON.stringify({ noted: approved.noted, call: noteCall })
);
check(
  'and it is posted after the review, so it is the last thing on the thread',
  calls().findIndex((c) => c.args[0] === 'api') < calls().findIndex((c) => c.args[0] === 'pr' && c.args[1] === 'comment'),
  JSON.stringify(calls().map((c) => c.args.slice(0, 2).join(' ')))
);
check('nothing went wrong, so there is no sentence about it', approved.reason === '', approved.reason);

// A review with no body is a green tick with nothing beside it. Refused before `gh` is
// reached, which is the only way that assertion can be made at all.
pr.forgetAvailability();
twoAccounts();
resetLog();
const bare = await pr.approve(REPO, 42, { body: '   ', note: APPROVAL_NOTE });
check(
  'an approval with an empty body is refused rather than submitted',
  bare.submitted === false && /empty body/.test(bare.reason),
  JSON.stringify(bare)
);
check('and refusing it costs no gh call at all', calls().length === 0, JSON.stringify(calls().map((c) => c.args.join(' '))));

// The common case everywhere except this Mac: one login, so no account can approve what
// that account opened. A null reviewer, an unsubmitted approval, and nothing on the PR.
pr.forgetAvailability();
world({
  auth: { ok: true, accounts: [{ user: 'soloacct', active: true }] },
  tokens: { soloacct: 'tok-solo' },
  repo: { nameWithOwner: 'acme/widgets' },
});
resetLog();
const solitary = await pr.approve(REPO, 42, { body: APPROVAL_BODY, note: APPROVAL_NOTE });
check(
  'a Mac with one login submits nothing and says why, rather than throwing',
  solitary.submitted === false && /second GitHub account/.test(solitary.reason),
  JSON.stringify(solitary)
);
check(
  'and it posts no comment either — there is no tick anybody could mistake for a person’s',
  !calls().some((c) => c.args[0] === 'api' || (c.args[0] === 'pr' && c.args[1] === 'comment')),
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

// GitHub refusing the review — the 422 that means `reviewerFor` and `resolve` returned the
// same account. The sentence has to survive, because it is the only thing that says which.
pr.forgetAvailability();
twoAccounts();
world({
  ...JSON.parse(fs.readFileSync(STATE, 'utf8')),
  reviewRefusal: 'HTTP 422: Can not approve your own pull request (https://api.github.com/repos/them/shared/pulls/42/reviews)',
});
resetLog();
const rejected = await pr.approve(REPO, 42, { body: APPROVAL_BODY, note: APPROVAL_NOTE });
check(
  'a review GitHub refuses comes back unsubmitted, with GitHub’s own sentence',
  rejected.submitted === false && /Can not approve your own pull request/.test(rejected.reason),
  JSON.stringify(rejected)
);
check(
  'and it still says which account it tried, because that is what names the bug',
  rejected.reviewer === 'helperacct',
  JSON.stringify(rejected)
);
check(
  'no comment is posted about an approval that did not happen',
  !calls().some((c) => c.args[0] === 'pr' && c.args[1] === 'comment'),
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

// And the half-failure: the approval landed, the disclosure did not. `submitted` stays true
// because it is true, and the sentence is about the comment.
pr.forgetAvailability();
twoAccounts();
world({ ...JSON.parse(fs.readFileSync(STATE, 'utf8')), commentRefusal: 'HTTP 403: Resource not accessible by integration' });
resetLog();
const half = await pr.approve(REPO, 42, { body: APPROVAL_BODY, note: APPROVAL_NOTE });
check(
  'a comment that fails after the review does not un-approve the pull request',
  half.submitted === true && half.noted === false,
  JSON.stringify(half)
);
check(
  'and the sentence says which half is missing',
  /approval is on the pull request/.test(half.reason) && /403/.test(half.reason),
  half.reason
);

// A caller with nothing to add at the bottom of the thread still gets its review. The body
// is the required disclosure; the comment is the belt beside the braces.
pr.forgetAvailability();
twoAccounts();
resetLog();
const quiet = await pr.approve(REPO, 42, { body: APPROVAL_BODY });
check(
  'with no note there is still a review, and nothing pretends a comment was posted',
  quiet.submitted === true && quiet.noted === false && quiet.reason === '',
  JSON.stringify(quiet)
);
check(
  'and no empty comment is left on the pull request',
  !calls().some((c) => c.args[0] === 'pr' && c.args[1] === 'comment'),
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

pr.forgetAvailability();
world();

/* ------------------------------------------------------- inline comments */

/**
 * `submitReview` — the general shape `approve()` sits on top of: a review that carries
 * inline comments, sent as a JSON body over stdin rather than as `-f` fields, because a
 * nested `comments` array has no `-f`/`-F` syntax at all.
 */
console.log('\nsubmitting a review with inline comments');

pr.forgetAvailability();
twoAccounts();
resetLog();
const commented = await pr.submitReview(REPO, 42, {
  event: 'request_changes',
  body: 'Two things worth a look before this merges.',
  comments: [
    { path: 'lib/pr.js', line: 42, body: 'this drops the reviewer identity on retry' },
    { path: 'lib/pr.js', line: 0, body: 'a comment with no real line, dropped' },
    { path: '', line: 5, body: 'a comment with no path, dropped' },
  ],
});
const reviewCall2 = calls().find((c) => c.args[0] === 'api');
check(
  'it is submitted, under the reviewer identity, with the two bad comments dropped',
  commented.submitted === true && commented.reviewer === 'helperacct' && commented.dropped === 2,
  JSON.stringify(commented)
);
check(
  'it goes out over stdin as one JSON body, the event upper-cased',
  !!reviewCall2 &&
    reviewCall2.args.includes('--input') &&
    reviewCall2.args.includes('-') &&
    JSON.parse(reviewCall2.stdin).event === 'REQUEST_CHANGES' &&
    JSON.parse(reviewCall2.stdin).comments.length === 1,
  reviewCall2 && reviewCall2.stdin
);
check(
  'the surviving comment carries path, line and a RIGHT side',
  JSON.parse(reviewCall2.stdin).comments[0].path === 'lib/pr.js' &&
    JSON.parse(reviewCall2.stdin).comments[0].line === 42 &&
    JSON.parse(reviewCall2.stdin).comments[0].side === 'RIGHT',
  reviewCall2.stdin
);
check(
  "the review call carries the reviewer's token and not the acting account's",
  reviewCall2.token === 'tok-helper',
  JSON.stringify(reviewCall2)
);
check(
  'and the answer carries the same kind of anchor approve() does',
  commented.url === 'https://github.com/them/shared/pull/42#pullrequestreview-909',
  commented.url
);

pr.forgetAvailability();
twoAccounts();
resetLog();
const defaulted = await pr.submitReview(REPO, 42, { comments: [{ path: 'lib/pr.js', line: 1, body: 'a question, not a demand' }] });
const defCall = calls().find((c) => c.args[0] === 'api');
check(
  'with no event given, it defaults to a plain comment review',
  defaulted.submitted === true && !!defCall && JSON.parse(defCall.stdin).event === 'COMMENT',
  defCall && defCall.stdin
);

pr.forgetAvailability();
twoAccounts();
resetLog();
const weirdEvent = await pr.submitReview(REPO, 42, { event: 'banana', body: 'still says something' });
const weirdCall = calls().find((c) => c.args[0] === 'api');
check(
  'an event nothing recognises falls back to a plain comment rather than failing the call',
  weirdEvent.submitted === true && !!weirdCall && JSON.parse(weirdCall.stdin).event === 'COMMENT',
  weirdCall && weirdCall.stdin
);

// Nothing to say at all — no body, no comment that survives — is refused the same
// direction an empty `approve()` body is, and for the same reason.
pr.forgetAvailability();
twoAccounts();
resetLog();
const emptyReview = await pr.submitReview(REPO, 42, {});
check(
  'nothing to say at all is refused before gh is reached',
  emptyReview.submitted === false && /nothing to submit/.test(emptyReview.reason),
  JSON.stringify(emptyReview)
);
check('and it costs no gh call', calls().length === 0, JSON.stringify(calls().map((c) => c.args.join(' '))));

pr.forgetAvailability();
twoAccounts();
resetLog();
const allDropped = await pr.submitReview(REPO, 42, { comments: [{ path: '', line: 1, body: 'x' }] });
check(
  'a submission whose only comment does not survive validation is refused the same way',
  allDropped.submitted === false && allDropped.dropped === 1,
  JSON.stringify(allDropped)
);

// The common case everywhere except this Mac: one login, so nobody may review what that
// account opened — the same degrade `approve()` makes, from the same cause.
pr.forgetAvailability();
world({ auth: { ok: true, accounts: [{ user: 'soloacct', active: true }] }, tokens: { soloacct: 'tok-solo' }, repo: { nameWithOwner: 'acme/widgets' } });
resetLog();
const soloReview = await pr.submitReview(REPO, 42, { body: 'still nobody to say it as' });
check(
  'a Mac with one login has no reviewer to submit as, and says why rather than throwing',
  soloReview.submitted === false && /second GitHub account/.test(soloReview.reason),
  JSON.stringify(soloReview)
);

// GitHub's own refusal survives intact, exactly as it does for `approve()`.
pr.forgetAvailability();
twoAccounts();
world({ ...JSON.parse(fs.readFileSync(STATE, 'utf8')), reviewRefusal: 'HTTP 422: Can not request changes on your own pull request' });
resetLog();
const refusedReview = await pr.submitReview(REPO, 42, {
  event: 'REQUEST_CHANGES',
  body: 'x',
  comments: [{ path: 'a', line: 1, body: 'y' }],
});
check(
  "a review GitHub refuses comes back unsubmitted, with GitHub's own sentence",
  refusedReview.submitted === false && /Can not request changes/.test(refusedReview.reason),
  JSON.stringify(refusedReview)
);

pr.forgetAvailability();
world();

/* ------------------------------------------------------ review threads */

/**
 * `reviewThreads` — the GraphQL read that gives each thread its GitHub id and whether
 * *GitHub* considers it resolved, which is the anchor a review block's own `resolved`
 * flag (lib/mergebead.js) is not: one is the reviewer's bookkeeping, the other is what
 * the pull request page actually shows.
 */
console.log("\nreading a pull request's review threads");

pr.forgetAvailability();
twoAccounts();
world({
  ...JSON.parse(fs.readFileSync(STATE, 'utf8')),
  threads: [
    { id: 'PRRT_kwABC', isResolved: false, comments: { nodes: [{ databaseId: 5551, path: 'lib/pr.js', line: 42, body: 'why not X' }] } },
    { id: 'PRRT_kwXYZ', isResolved: true, comments: { nodes: [{ databaseId: 5552, path: 'lib/pr.js', line: 7, body: 'nit' }] } },
  ],
});
resetLog();
const threads = await pr.reviewThreads(REPO, 42);
check(
  "each thread carries GitHub's own id, its own resolved state, and the comments inside it",
  Array.isArray(threads) &&
    threads.length === 2 &&
    threads[0].id === 'PRRT_kwABC' &&
    threads[0].resolved === false &&
    threads[0].comments.length === 1 &&
    threads[0].comments[0].id === '5551' &&
    threads[0].comments[0].path === 'lib/pr.js' &&
    threads[0].comments[0].line === 42 &&
    threads[1].resolved === true,
  JSON.stringify(threads)
);
const threadsCall = calls().find((c) => c.args[0] === 'api' && c.args[1] === 'graphql');
check(
  'read under the reviewer identity, the same as the write it anchors',
  !!threadsCall && threadsCall.token === 'tok-helper',
  JSON.stringify(threadsCall)
);
check(
  'and it asks GraphQL for this owner, repo and pull request number',
  !!threadsCall && threadsCall.args.includes('owner=them') && threadsCall.args.includes('repo=shared') && threadsCall.args.includes('number=42'),
  JSON.stringify(threadsCall && threadsCall.args)
);

// No account here can see any repo at all, so there is nothing to anchor to — null, not
// a throw the sweep would have to catch.
pr.forgetAvailability();
world({ auth: { ok: true } });
resetLog();
const noRepoThreads = await pr.reviewThreads(EMPTY, 42);
check('no repo anybody can see means no threads to read', noRepoThreads === null, JSON.stringify(noRepoThreads));
check(
  'and nothing reaches the graphql query at all',
  !calls().some((c) => c.args[0] === 'api'),
  JSON.stringify(calls().map((c) => c.args.join(' ')))
);

// The repo is real and visible; there is simply nobody to read the threads *as* the
// reviewer, which is the same one-login degrade every other write in this file makes.
pr.forgetAvailability();
world({ auth: { ok: true, accounts: [{ user: 'soloacct', active: true }] }, tokens: { soloacct: 'tok-solo' }, repo: { nameWithOwner: 'acme/widgets' } });
resetLog();
const soloThreads = await pr.reviewThreads(REPO, 42);
check('a Mac with one login has nobody to read the threads as, so this is null too', soloThreads === null);
check('and it costs no graphql call', !calls().some((c) => c.args[0] === 'api'), JSON.stringify(calls().map((c) => c.args.join(' '))));

// GitHub refusing the query outright.
pr.forgetAvailability();
twoAccounts();
world({ ...JSON.parse(fs.readFileSync(STATE, 'utf8')), threadsRefusal: 'HTTP 403: Resource not accessible by integration' });
resetLog();
const failedThreads = await pr.reviewThreads(REPO, 42);
check('gh refusing the query is null, not a throw the sweep has to catch', failedThreads === null, JSON.stringify(failedThreads));
check('and a genuine refusal is never reported as an outage', pr.threadsTransient(REPO, 42) === false);

/**
 * bc-36xx.26: GitHub answering `reviewThreads`'s own GraphQL call with a shrug, the exact
 * shape bc-36xx.14 fixed for the repo probe — reusing `isTransientErr` here rather than a
 * second classifier for the same API. `threadsTransient(dir, number)` is `probeTransient`'s
 * counterpart: a null caused by an outage must be tellable apart from a null that genuinely
 * means "no threads" or "nobody can read them here", both proven above.
 */
console.log('\nreviewThreads and a GraphQL outage');

pr.forgetAvailability();
twoAccounts();
world({
  ...JSON.parse(fs.readFileSync(STATE, 'utf8')),
  threads: [{ id: 'PRRT_kwABC', isResolved: false, comments: { nodes: [] } }],
  graphqlOutage: { count: 1 },
});
resetLog();
const blippedThreads = await pr.reviewThreads(REPO, 42);
check(
  'a blip that clears within the retries still reads the threads',
  Array.isArray(blippedThreads) && blippedThreads.length === 1,
  JSON.stringify(blippedThreads)
);
check(
  'and it did retry — more than one graphql call for the one answer',
  calls().filter((c) => c.args[0] === 'api').length > 1,
  JSON.stringify(calls())
);
check('a read that succeeded after a blip is not reported as unreachable', pr.threadsTransient(REPO, 42) === false);

pr.forgetAvailability();
twoAccounts();
world({ ...JSON.parse(fs.readFileSync(STATE, 'utf8')), graphqlOutage: { count: 9 } });
resetLog();
const outagedThreads = await pr.reviewThreads(REPO, 42);
check(
  'an outage that outlasts every retry still comes back null, same as a real empty answer',
  outagedThreads === null,
  JSON.stringify(outagedThreads)
);
check('but it is flagged transient — GitHub never actually answered', pr.threadsTransient(REPO, 42) === true);

pr.forgetAvailability();
world();

/* ------------------------------------------------------- resolving one */

/**
 * `resolveThread` — the one write in this whole file that only the reviewer may make, in
 * Adam's own words: "only the reviewer marks a thread resolved." Nobody else calls it and
 * this is the seam that would let them if it were wrong.
 */
console.log('\nresolving a thread');

pr.forgetAvailability();
twoAccounts();
world({
  ...JSON.parse(fs.readFileSync(STATE, 'utf8')),
  threads: [{ id: 'PRRT_kwABC', isResolved: false, comments: { nodes: [] } }],
});
resetLog();
const resolved = await pr.resolveThread(REPO, 'PRRT_kwABC');
check('the thread resolves', resolved.resolved === true && resolved.reason === '', JSON.stringify(resolved));
const resolveCall = calls().find((c) => c.args[0] === 'api' && c.args[1] === 'graphql');
check(
  'it runs as the reviewer, not the account that opened the pull request',
  !!resolveCall && resolveCall.token === 'tok-helper',
  JSON.stringify(resolveCall)
);
check(
  "the mutation carries GitHub's own thread id",
  !!resolveCall && resolveCall.args.includes('threadId=PRRT_kwABC'),
  JSON.stringify(resolveCall && resolveCall.args)
);

// The fake's own state is what a real GitHub would remember — the closest this suite
// gets to it without a network — and a read straight after agrees.
resetLog();
const afterResolve = await pr.reviewThreads(REPO, 42);
check('and the very next read agrees it is resolved now', Array.isArray(afterResolve) && afterResolve[0].resolved === true, JSON.stringify(afterResolve));

pr.forgetAvailability();
twoAccounts();
resetLog();
const noId = await pr.resolveThread(REPO, '   ');
check('an empty thread id is refused before gh is reached', noId.resolved === false && /no thread id/.test(noId.reason), JSON.stringify(noId));
check('and it costs no call at all', calls().length === 0, JSON.stringify(calls().map((c) => c.args.join(' '))));

pr.forgetAvailability();
world({ auth: { ok: true, accounts: [{ user: 'soloacct', active: true }] }, tokens: { soloacct: 'tok-solo' }, repo: { nameWithOwner: 'acme/widgets' } });
resetLog();
const soloResolve = await pr.resolveThread(REPO, 'PRRT_kwABC');
check(
  'a Mac with one login cannot resolve a thread either, and says so rather than throwing',
  soloResolve.resolved === false && /second GitHub account/.test(soloResolve.reason),
  JSON.stringify(soloResolve)
);
check('and it never reaches the graphql endpoint', !calls().some((c) => c.args[0] === 'api'), JSON.stringify(calls().map((c) => c.args.join(' '))));

pr.forgetAvailability();
twoAccounts();
world({ ...JSON.parse(fs.readFileSync(STATE, 'utf8')), resolveRefusal: 'HTTP 403: Resource not accessible by integration' });
resetLog();
const refusedResolve = await pr.resolveThread(REPO, 'PRRT_kwABC');
check(
  "GitHub refusing the mutation comes back unresolved, with GitHub's own sentence",
  refusedResolve.resolved === false && /403/.test(refusedResolve.reason),
  JSON.stringify(refusedResolve)
);
check('and a genuine refusal carries no transient flag', !refusedResolve.transient, JSON.stringify(refusedResolve));

/**
 * bc-36xx.26: the same outage, on the mutation. `resolveThread` already returns an
 * object rather than null on every failure, so the outage rides as `transient: true` on
 * that same shape instead of a separate flag — a caller checks one field rather than a
 * second lookup keyed by dir+number.
 */
console.log('\nresolveThread and a GraphQL outage');

pr.forgetAvailability();
twoAccounts();
world({
  ...JSON.parse(fs.readFileSync(STATE, 'utf8')),
  threads: [{ id: 'PRRT_kwABC', isResolved: false, comments: { nodes: [] } }],
  graphqlOutage: { count: 1 },
});
resetLog();
const blippedResolve = await pr.resolveThread(REPO, 'PRRT_kwABC');
check(
  'a blip that clears within the retries still resolves the thread',
  blippedResolve.resolved === true && !blippedResolve.transient,
  JSON.stringify(blippedResolve)
);
check('and it did retry', calls().filter((c) => c.args[0] === 'api').length > 1, JSON.stringify(calls()));

pr.forgetAvailability();
twoAccounts();
world({ ...JSON.parse(fs.readFileSync(STATE, 'utf8')), graphqlOutage: { count: 9 } });
resetLog();
const outagedResolve = await pr.resolveThread(REPO, 'PRRT_kwABC');
check(
  'an outage that outlasts every retry is flagged transient, not read as a genuine refusal',
  outagedResolve.resolved === false && outagedResolve.transient === true,
  JSON.stringify(outagedResolve)
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

/* ------------------------------------------------------------- the reviews */

/**
 * `reviewDecision` cannot see an approval on this repo, and `latestReviews` is the
 * only thing that can.
 *
 * GitHub's `reviewDecision` answers "does this pull request satisfy its review
 * *requirement*". mordam/beadcause configures none — no branch protection, no rulesets,
 * verified against the live API on 2026-08-17 — so it is the empty string with an
 * approving review sitting on the pull request, exactly as it is with none. A gate that
 * read it would wait forever and would look, from the outside, like a reviewer that
 * never reviewed.
 *
 * So the first case below is not a hypothetical: it is the real repo's shape. The last
 * two are the distinctions that make `approvedBy` worth deriving in one place — a
 * dismissed review is not an approval, and neither is a comment, and both come back in
 * the same array as one.
 */
console.log('\nand the reviews on it');

world({
  prs: {
    42: rawPR({
      reviewDecision: '',
      latestReviews: [rawReview({ author: { login: 'NeanderthalMan' }, submittedAt: '2026-08-17T14:40:19Z' })],
    }),
  },
});
const reviewed = await pr.view(REPO, 42);
check(
  'an approving review is visible even though reviewDecision is empty — the shape this repo is actually in',
  reviewed.reviewDecision === null && reviewed.approvedBy.join(',') === 'NeanderthalMan',
  JSON.stringify({ reviewDecision: reviewed.reviewDecision, approvedBy: reviewed.approvedBy })
);
check(
  'and the review is folded to what a caller can act on',
  reviewed.reviews.length === 1 &&
    reviewed.reviews[0].author === 'NeanderthalMan' &&
    reviewed.reviews[0].state === 'APPROVED' &&
    reviewed.reviews[0].association === 'COLLABORATOR' &&
    reviewed.reviews[0].submittedAt === '2026-08-17T14:40:19Z',
  JSON.stringify(reviewed.reviews)
);
check(
  'the review body is deliberately not carried — it would ride into every board row',
  reviewed.reviews[0].body === undefined,
  JSON.stringify(reviewed.reviews[0])
);

world({
  prs: {
    42: rawPR({
      latestReviews: [
        rawReview({ author: { login: 'dismissed-one' }, state: 'DISMISSED' }),
        rawReview({ author: { login: 'chatty' }, state: 'COMMENTED' }),
        rawReview({ author: { login: 'unhappy' }, state: 'CHANGES_REQUESTED' }),
      ],
    }),
  },
});
const mixedReviews = await pr.view(REPO, 42);
check(
  'a dismissed, a commented and a changes-requested review are none of them approvals',
  mixedReviews.reviews.length === 3 && mixedReviews.approvedBy.length === 0,
  JSON.stringify({ reviews: mixedReviews.reviews, approvedBy: mixedReviews.approvedBy })
);
check(
  'but they are all still readable, because "who has looked at this" is a different question',
  mixedReviews.reviews.map((r) => r.state).join(',') === 'DISMISSED,COMMENTED,CHANGES_REQUESTED',
  JSON.stringify(mixedReviews.reviews.map((r) => r.state))
);

world({ prs: { 42: rawPR() } });
const unreviewed = await pr.view(REPO, 42);
check(
  'a pull request nobody has reviewed reads as empty arrays, never undefined',
  Array.isArray(unreviewed.reviews) &&
    unreviewed.reviews.length === 0 &&
    Array.isArray(unreviewed.approvedBy) &&
    unreviewed.approvedBy.length === 0,
  JSON.stringify({ reviews: unreviewed.reviews, approvedBy: unreviewed.approvedBy })
);

world({ prs: { 9: { number: 9, url: 'https://github.com/acme/widgets/pull/9' } } });
const noField = await pr.view(REPO, 9);
check(
  'and so does one gh answered without the field at all',
  noField.reviews.length === 0 && noField.approvedBy.length === 0,
  JSON.stringify({ reviews: noField.reviews, approvedBy: noField.approvedBy })
);

check(
  'latestReviews is in the field list, or none of the above is ever asked for',
  pr.PR_FIELDS.split(',').includes('latestReviews'),
  pr.PR_FIELDS
);
check(
  'and rides into the list query too, since the board reads the same set',
  pr.LIST_FIELDS.split(',').includes('latestReviews'),
  pr.LIST_FIELDS
);
check(
  'but not into the merged-PR set, where no review question can still be asked',
  !pr.MERGED_FIELDS.split(',').includes('latestReviews'),
  pr.MERGED_FIELDS
);

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

// And the failure that is not a refusal at all. `gh pr merge --delete-branch` merges,
// deletes the remote branch, then deletes the local one — and that last act fails
// whenever the branch is checked out in a worktree, which in this repo is every branch
// a worker ever pushed. Read as a refusal, it told Adam *bc-g0tx was not answered,
// nothing was written and nothing was lost* over #371, already merged, with its work
// bead left in_progress and the card still sitting there. The exit code is not the
// verdict; the pull request is.
world({
  prs: { 42: rawPR() },
  mergeCleanupFailure:
    "failed to delete local branch worktree-epicadvocate-foundation-x8k: failed to run git: error: Cannot delete " +
    "branch 'worktree-epicadvocate-foundation-x8k' checked out at '/repo/.claude/worktrees/epicadvocate-foundation-x8k'",
});
resetLog();
let landedAnyway = null;
const tidied = await threw(async () => {
  landedAnyway = await pr.merge(REPO, 42);
});
check('a merge that landed is not thrown away because gh failed to tidy up after it', !tidied, tidied && tidied.message);
check(
  'it comes back as the merged pull request',
  landedAnyway && landedAnyway.state === 'MERGED' && landedAnyway.mergeCommit === '0ff1ce0ff1ce',
  JSON.stringify(landedAnyway && { state: landedAnyway.state, sha: landedAnyway.mergeCommit })
);
check(
  'carrying what gh complained about, so the card can say the local branch survived',
  landedAnyway && /Cannot delete branch/.test(landedAnyway.cleanup || ''),
  JSON.stringify(landedAnyway && landedAnyway.cleanup)
);

// The distinction that makes the above safe: a `gh` that failed *before* merging leaves
// the PR open, and that is still a refusal with GitHub's words on it.
world({ prs: { 42: rawPR() }, mergeRefusal: 'Pull request is not mergeable: a required check is failing.' });
resetLog();
const stillRefused = await threw(() => pr.merge(REPO, 42));
check(
  'a failure with the pull request still open is a refusal, as before',
  stillRefused && stillRefused.status === 409 && /required check is failing/.test(stillRefused.message),
  stillRefused && stillRefused.message
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

// comment() used to shell out to bare `gh`, with no env at all, so it posted as whatever
// account gh was ambiently on rather than the one `resolve` picked for this checkout —
// exactly the split `merge` was proven against above. Same shape here: an active account
// that can only read, and the write-capable one `resolve` should actually pick.
console.log('\nand comment() runs as the account resolve picked, not the ambient one');

pr.forgetAvailability();
world({
  auth: {
    ok: true,
    accounts: [
      { user: 'readonlyacct', active: true },
      { user: 'owneracct', active: false },
    ],
  },
  tokens: { readonlyacct: 'tok-readonly', owneracct: 'tok-owner' },
  repoByToken: {
    '': { nameWithOwner: 'them/shared', viewerPermission: 'READ' },
    'tok-owner': { nameWithOwner: 'them/shared', viewerPermission: 'ADMIN' },
  },
  prs: { 42: rawPR() },
});
resetLog();
await pr.comment(REPO, 42, 'RESOLVER_SAYS: still conflicting.');
const identityComment = calls().find((c) => c.args[0] === 'pr' && c.args[1] === 'comment');
check(
  'comment() goes out under the resolved token, exactly like every other write in this file',
  !!identityComment && identityComment.token === 'tok-owner',
  JSON.stringify(calls().map((c) => [c.args.join(' '), c.token]))
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
