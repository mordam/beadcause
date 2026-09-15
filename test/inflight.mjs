#!/usr/bin/env node
//
// b7e-inflight — what the open pull requests are actually doing, and whether a red
// check is even current (bc-4r10.19). Three sessions (bc-4r10.1, bc-khoe.30.6,
// bc-khoe.30.5) each hand-rolled a different raw-`gh` survey of this; this is the
// command that would have replaced all three.
//
//   npm test
//   node test/inflight.mjs
//
// Two kinds of proof, same split test/pr.mjs argues for lib/pr.js itself: the folding
// in lib/prsurvey.js (behind-count, staleness, exact-path file matching) is pure over
// fabricated inputs, no `gh` involved. Then bin/b7e-inflight is driven as a real
// subprocess against a fake `gh` on PATH and a fake `bd`, because the wiring — which
// flag reaches which `gh`/`bd` call, and whether an unreachable answer is ever
// mistaken for a clean one — is the thing worth failing loudly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { behindOf, staleOf, touchesAny, describeChecks, describeScope, mentionsBead, inflightRows, OPEN_LIMIT, DEFAULT_SINCE_DAYS } from '../lib/prsurvey.js';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-inflight');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};
const acheck = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nb7e-inflight\n');

/* ================================================================== lib/prsurvey.js */

check('behindOf: null when there is nothing to compare', () => {
  assert.equal(behindOf(null), null);
  assert.equal(behindOf({ status: 'identical' }), null); // no `commits` array at all
});

check('behindOf: the count of commits on the base not reachable from the head', () => {
  assert.equal(behindOf({ status: 'ahead', commits: [{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }] }), 3);
  assert.equal(behindOf({ status: 'diverged', commits: [] }), 0);
});

check('behindOf: reads GitHub\'s total, not the 250-commit page it hands back', () => {
  // The compare endpoint caps `.commits` at 250 and reports the real figure in
  // `total_commits`. Measured against this repo on 2026-08-23, `4ea4b599...main`
  // answers `{returned: 250, total_commits: 348}` — so reading the array's length
  // printed "250 commits behind main" for every branch 250 or more behind, and the
  // README's own headline example (593) could not be produced by the binary at all.
  const page = Array.from({ length: 250 }, (_, i) => ({ sha: String(i) }));
  assert.equal(behindOf({ status: 'diverged', total: 593, commits: page }), 593);
  assert.equal(behindOf({ status: 'ahead', total: 348, commits: page }), 348);
  // No `total` at all — an older payload or a hand-written fixture — falls back to the
  // page, which is exactly right for every compare too small to have been truncated.
  assert.equal(behindOf({ status: 'ahead', commits: [{ sha: 'a' }, { sha: 'b' }] }), 2);
});

check('describeScope: an incomplete sweep says so, and says which cap bit', () => {
  assert.match(describeScope({ mode: 'open', open: 43, complete: true }), /searched 43 open pull requests/);
  const cut = describeScope({ mode: 'open', open: 400, complete: false, cap: 400 });
  assert.match(cut, /INCOMPLETE/);
  assert.match(cut, /400/);
  assert.match(
    describeScope({ mode: 'window', open: 43, merged: 278, sinceDays: 14, since: '2026-08-09T00:00:00.000Z', complete: true }),
    /43 open \+ 278 merged in the last 14 days \(since 2026-08-09\)/
  );
  assert.equal(describeScope({ mode: 'one' }), ''); // one number is not a page of anything
  assert.equal(describeScope(null), '');
});

check('mentionsBead: a superset of what the tracker could confirm, never a narrowing of it', () => {
  const row = { title: 'bc-4r10.19: b7e-inflight', branch: 'worktree-b7e-inflight-4r10-19', body: '' };
  assert.equal(mentionsBead(row, 'bc', 'bc-4r10.19'), true);
  assert.equal(mentionsBead({ title: '', branch: '', body: 'fixes bc-x9y' }, 'bc', 'bc-x9y'), true);
  // The branch-tail guess `candidateTiers` makes: `worktree-launcher-tabs-jin` can
  // resolve to `bc-jin` without those five characters appearing anywhere as an id.
  assert.equal(mentionsBead({ title: '', branch: 'worktree-launcher-tabs-jin', body: '' }, 'bc', 'bc-jin'), true);
  assert.equal(mentionsBead({ title: 'something else', branch: 'wip', body: '' }, 'bc', 'bc-4r10.19'), false);
});

check('staleOf: only a COMPLETED check counts — pending is its own state, not stale', () => {
  assert.equal(staleOf('pending', 593), false);
  assert.equal(staleOf('none', 593), false);
});

check('staleOf: a completed check is stale only when the base has actually moved', () => {
  assert.equal(staleOf('failing', 0), false);
  assert.equal(staleOf('failing', null), false); // unknown is not "moved" — see the header note
  assert.equal(staleOf('failing', 593), true);
  assert.equal(staleOf('passing', 12), true); // staleness is about the base, not the verdict
});

check('touchesAny: exact path match, not a prefix or a glob', () => {
  assert.equal(touchesAny(['public/monitor.js'], ['public/monitor.js']), true);
  assert.equal(touchesAny(['public/monitor.js.bak'], ['public/monitor.js']), false);
  assert.equal(touchesAny(['public/monitor.js'], ['public/app.js']), false);
  assert.equal(touchesAny(null, ['public/app.js']), false);
  assert.equal(touchesAny(['a'], []), false);
});

check('describeChecks: the bc-4r10.1 shape — a stale red carries its own date, sha and behind-count, and says so rather than presenting the branch as broken', () => {
  const row = {
    headSha: '56d4c4d1abcdef',
    base: 'main',
    checks: { state: 'failing', failing: 1, pending: 0, total: 1, failed: ['test/outagepush.mjs'], at: '2026-08-15T14:31:00Z' },
    behind: 593,
    stale: true,
  };
  const line = describeChecks(row);
  assert.match(line, /test\/outagepush\.mjs/);
  assert.match(line, /2026-08-15T14:31:00Z/);
  assert.match(line, /56d4c4d1/);
  assert.match(line, /593 commits behind main/);
  assert.match(line, /STALE/);
  assert.match(line, /not \(yet\) a fact about this branch's own diff/);
});

check('describeChecks: the same failure with nothing behind is NOT marked stale', () => {
  const row = {
    headSha: 'aaaaaaaaaaaa',
    base: 'main',
    checks: { state: 'failing', failing: 1, pending: 0, total: 1, failed: ['test/x.mjs'], at: '2026-08-20T00:00:00Z' },
    behind: 0,
    stale: false,
  };
  assert.doesNotMatch(describeChecks(row), /STALE/);
});

check('describeChecks: an unknown behind-count reads as unknown, never as "0" (clean)', () => {
  const row = {
    headSha: 'bbbbbbbbbbbb',
    base: 'main',
    checks: { state: 'failing', failing: 1, pending: 0, total: 1, failed: ['test/x.mjs'], at: '2026-08-20T00:00:00Z' },
    behind: null,
    stale: false,
  };
  assert.match(describeChecks(row), /behind main: unknown \(could not compare\)/);
});

/* ------------------------------------------------------------------------ the fake gh */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-inflight-'));
const BIN_DIR = path.join(tmp, 'bin');
const REPO = path.join(tmp, 'repo');
for (const d of [BIN_DIR, REPO]) fs.mkdirSync(d, { recursive: true });

const STATE = path.join(tmp, 'gh-state.json');
const world = (s = {}) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

// Extensionless, same trick test/pr.mjs uses so node runs it whatever this package's
// own "type" says. Answers `auth status`, `pr list`, `pr view`, `pr diff --name-only`
// and the `api .../compare/A...B` call `commitsBetween` makes — the four verbs
// bin/b7e-inflight actually reaches through lib/pr.js.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.GH_FAKE_STATE, 'utf8'));
const args = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
const fail = (msg) => { process.stderr.write(msg + '\\nUsage: gh <command> [flags]\\n'); process.exit(1); };

if (state.authFail) fail(state.authFail);
if (args[0] === 'auth' && args[1] === 'status') out('github.com\\n  Logged in to github.com\\n');

const byNumber = (n) => (state.prs || []).find((p) => String(p.number) === String(n));

if (args[0] === 'pr' && args[1] === 'list') {
  // Honours --state, --search merged:A..B and --limit, because the bug this suite
  // exists to pin is a *limit* silently truncating the sweep — a fake that answers
  // every list with every row can never see it.
  const flag = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
  const want = String(flag('--state') || 'all').toLowerCase();
  const limit = Number(flag('--limit') || 30);
  const search = String(flag('--search') || '');
  let rows = (state.prs || []).filter((p) => want === 'all' || String(p.state || '').toLowerCase() === want);
  const m = search.match(/merged:(\S+)\.\.(\S+)/);
  if (m) rows = rows.filter((p) => p.mergedAt && p.mergedAt >= m[1] && p.mergedAt <= m[2]);
  out(JSON.stringify(rows.slice(0, limit)));
}
if (args[0] === 'pr' && args[1] === 'view') {
  const found = byNumber(args[2]);
  if (!found) fail('no pull requests found for branch "' + args[2] + '"');
  out(JSON.stringify(found));
}
if (args[0] === 'pr' && args[1] === 'diff') {
  const n = args[2];
  if (state.diffFail && state.diffFail.includes(Number(n))) fail('gh: pull request diff could not be fetched');
  out(((state.filesByNumber || {})[n] || []).join('\\n') + '\\n');
}
if (args[0] === 'api') {
  const route = args[1] || '';
  const m = route.match(/compare\\/([^.]+)\\.\\.\\.(.+)$/);
  if (m) {
    const key = m[1] + '...' + m[2];
    const found = (state.compares || {})[key];
    if (!found) fail('compare not stubbed for ' + key);
    out(JSON.stringify(found));
  }
  fail('unknown api route: ' + route);
}
fail('unknown gh invocation: ' + args.join(' '));
`;
fs.writeFileSync(path.join(BIN_DIR, 'gh'), FAKE_GH, { mode: 0o755 });

const rawPR = (over = {}) => ({
  number: 1,
  url: 'https://github.com/acme/widgets/pull/1',
  title: 'A pull request',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'worktree-a',
  headRefOid: '1111111111111111111111111111111111111111',
  baseRefName: 'main',
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  statusCheckRollup: [],
  reviewDecision: null,
  latestReviews: [],
  mergedAt: null,
  mergeCommit: null,
  body: '',
  author: { login: 'somebody' },
  createdAt: '2026-08-19T00:00:00Z',
  updatedAt: '2026-08-19T00:00:00Z',
  ...over,
});

const env = () => ({ ...process.env, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}`, GH_FAKE_STATE: STATE });

/**
 * The rows out of a `--json` run, without the scope envelope.
 *
 * `--json` leads with one `{ scope }` line — what the sweep actually covered — and only
 * then the rows, because a caller reading this stream has the same right as a human
 * reader to know that an empty answer was an empty sweep and not a truncated one.
 */
const jsonRows = (stdout) =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => typeof r.number === 'number');
const jsonScope = (stdout) => JSON.parse(stdout.split('\n').filter(Boolean)[0]).scope;

/* ---------------------------------------------------------- the bc-4r10.1 shape, end to end */

await acheck('CLI: a stale red is printed with its date, sha and behind-count, and flagged STALE rather than as this branch\'s own failure', async () => {
  world({
    prs: [
      rawPR({
        number: 323,
        headRefOid: '56d4c4d1abcdef1234567890abcdef1234567890',
        statusCheckRollup: [{ name: 'test/outagepush.mjs', conclusion: 'FAILURE', completedAt: '2026-08-15T14:31:00Z' }],
      }),
    ],
    compares: {
      // **The real payload's shape.** GitHub's compare endpoint lists at most 250
      // commits and reports the true figure separately in `total_commits`, so this is
      // what a 593-behind branch actually answers — and the README's headline example
      // was unreachable while `behindOf` read the page length instead of the total.
      '56d4c4d1abcdef1234567890abcdef1234567890...main': {
        status: 'diverged',
        total: 593,
        commits: Array.from({ length: 250 }, (_, i) => ({ sha: String(i), parents: 1, message: 'm', login: 'x' })),
      },
    },
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /#323/);
  assert.match(run.stdout, /test\/outagepush\.mjs/);
  assert.match(run.stdout, /2026-08-15T14:31:00/); // rollup() normalises to ISO with milliseconds
  assert.match(run.stdout, /56d4c4d1/);
  assert.match(run.stdout, /593 commits behind main/);
  assert.match(run.stdout, /STALE/);
});

/* -------------------------------------------------------------------------- --files */

await acheck('CLI: --files narrows to PRs whose diff touches the path, and nothing else', async () => {
  world({
    prs: [
      rawPR({ number: 433, headRefOid: 'a'.repeat(40) }),
      rawPR({ number: 438, headRefOid: 'b'.repeat(40) }),
      rawPR({ number: 410, headRefOid: 'c'.repeat(40) }),
      rawPR({ number: 999, headRefOid: 'd'.repeat(40) }), // unrelated — must not appear
    ],
    filesByNumber: {
      433: ['public/monitor.js'],
      438: ['public/monitor.js', 'README.md'],
      410: ['public/monitor.js'],
      999: ['lib/other.js'],
    },
    compares: {
      [`${'a'.repeat(40)}...main`]: { status: 'identical', commits: [] },
      [`${'b'.repeat(40)}...main`]: { status: 'identical', commits: [] },
      [`${'c'.repeat(40)}...main`]: { status: 'identical', commits: [] },
      [`${'d'.repeat(40)}...main`]: { status: 'identical', commits: [] },
    },
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--files', 'public/monitor.js', '--json'], {
    encoding: 'utf8',
    env: env(),
  });
  assert.equal(run.status, 0, run.stderr);
  const rows = jsonRows(run.stdout);
  assert.deepEqual(
    rows.map((r) => r.number).sort((a, b) => a - b),
    [410, 433, 438]
  );
});

await acheck('CLI: a PR whose diff could not be fetched is KEPT and flagged unknown, never silently dropped', async () => {
  world({
    prs: [rawPR({ number: 500, headRefOid: 'e'.repeat(40) })],
    diffFail: [500],
    compares: { [`${'e'.repeat(40)}...main`]: { status: 'identical', commits: [] } },
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--files', 'public/monitor.js', '--json'], {
    encoding: 'utf8',
    env: env(),
  });
  assert.equal(run.status, 0, run.stderr);
  const rows = jsonRows(run.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, 500);
  assert.equal(rows[0].filesUnknown, true);
});

/* --------------------------------------------------------------------- one number */

await acheck('CLI: a bare PR number fetches that one PR via `gh pr view`, not the list', async () => {
  world({
    prs: [rawPR({ number: 77, headRefOid: 'a1'.repeat(20) })],
    compares: { [`${'a1'.repeat(20)}...main`]: { status: 'identical', commits: [] } },
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '77', '--json'], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 0, run.stderr);
  const [row] = jsonRows(run.stdout);
  assert.equal(row.number, 77);
  assert.equal(row.behind, 0);
});

await acheck('CLI: a PR number together with --bead is refused as two ways of narrowing at once', async () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '77', '--bead', 'bc-x'], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 2);
});

/* --------------------------------------------------------------- gh unreachable */

await acheck('CLI: gh unreachable is reported as unknown — never as "no open pull requests"', async () => {
  world({ authFail: 'You are not logged into any GitHub hosts.' });
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 3);
  assert.match(run.stderr, /could not ask gh/);
  assert.doesNotMatch(run.stdout, /nothing matches/);
});

await acheck('CLI: gh unreachable in --json mode still says reachable: false, not an empty rows array alone', async () => {
  world({ authFail: 'You are not logged into any GitHub hosts.' });
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--json'], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 3);
  const payload = JSON.parse(run.stdout.trim().split('\n')[0]);
  assert.equal(payload.reachable, false);
  assert.deepEqual(payload.rows, []);
});

/* -------------------------------------------------------------------------- --bead */

await acheck('CLI: --bead resolves against a fake tracker and finds the PR naming it', async () => {
  world({
    prs: [rawPR({ number: 44, headRefOid: 'f'.repeat(40), body: 'bead: bc-fake' })],
    compares: { [`${'f'.repeat(40)}...main`]: { status: 'identical', commits: [] } },
  });

  const fakeBd = path.join(tmp, 'bd');
  fs.writeFileSync(
    fakeBd,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'show') {
  if (args[1] === 'bc-fake') process.stdout.write(JSON.stringify([{ id: 'bc-fake', title: 't', status: 'open' }]));
  else process.stdout.write('[]');
  process.exit(0);
}
if (args[0] === 'list') { process.stdout.write(JSON.stringify([{ id: 'bc-fake' }])); process.exit(0); }
process.stdout.write('[]');
`,
    { mode: 0o755 }
  );

  // `workspace.dir` is the tracker's own `.beads` directory, exactly as it is for a
  // real personal workspace — never the checkout itself. `resolveSessionDir` turns
  // this back into REPO (its parent) with no `projectRoot` configured at all: "the
  // checkout itself for a tracker that lives inside the repo it tracks".
  // `loadConfig()` drops any workspace whose `dir` does not exist on disk (reconciling
  // against real ones it can discover) — so the fake `.beads` has to actually be there
  // for `demo` to survive that reconciliation.
  fs.mkdirSync(path.join(REPO, '.beads'), { recursive: true });
  const configDir = path.join(tmp, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ bdBin: fakeBd, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: path.join(REPO, '.beads') }] }, null, 2)
  );

  const run = spawnSync(process.execPath, [BIN, '--bead', 'bc-fake', '-w', 'demo', '--json'], {
    // No `--dir` at all — `-w demo` alone has to find REPO on its own, through
    // `resolveSessionDir`, or this is just re-testing `--dir`.
    cwd: REPO,
    encoding: 'utf8',
    env: { ...env(), BEADCAUSE_CONFIG_DIR: configDir },
  });
  assert.equal(run.status, 0, run.stderr);
  const rows = jsonRows(run.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, 44);
  assert.deepEqual(rows[0].beads.map((b) => b.id), ['bc-fake']);
});

await acheck('CLI: with no -w, an unrelated workspace listed first in config is never used as a fallback — a checkout matching no workspace still asks gh about ITSELF', async () => {
  world({
    prs: [rawPR({ number: 900, headRefOid: '9'.repeat(40) })],
    compares: { [`${'9'.repeat(40)}...main`]: { status: 'identical', commits: [] } },
  });

  const otherDir = path.join(tmp, 'unrelated-repo');
  fs.mkdirSync(otherDir, { recursive: true });
  const configDir = path.join(tmp, 'config-fallback');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    // `unrelated` sorts first — the bug this guards against was falling back to
    // `cfg.workspaces[0]` when nothing matched ROOT, which silently pointed a bare
    // `b7e-inflight` at whichever repo happened to be configured first.
    JSON.stringify({ bdBin: '/nonexistent/bd', actor: 'beadcause-test', workspaces: [{ name: 'unrelated', dir: otherDir }] }, null, 2)
  );

  // No `-w` at all — REPO matches no configured workspace.
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--json'], {
    encoding: 'utf8',
    env: { ...env(), BEADCAUSE_CONFIG_DIR: configDir },
  });
  assert.equal(run.status, 0, run.stderr);
  const rows = jsonRows(run.stdout);
  // Asked `gh` in REPO (the fake), got REPO's own PR #900 — never crossed into
  // `otherDir`, which the fake `gh` was never even pointed at.
  assert.deepEqual(rows.map((r) => r.number), [900]);
  assert.deepEqual(rows[0].beads, []); // no workspace resolved, so no bead lookup at all
});

/* ------------------------------------------------- the sweep is not a fixed page */

await acheck('CLI: --files finds a MERGED pull request that no page of open ones would have reached — the #433 case', async () => {
  // **The round-one bug, in fixture form.** `inflightRows` asked
  // `gh pr list --state all --limit 100` and returned that page as the answer. On the
  // real repo that page stopped at #562 of 661, so `--files public/monitor.js` printed
  // five pull requests and silently omitted #433 — the number the acceptance criteria
  // name — whose worktree had been retired and which had since merged. Here #433 is
  // deliberately the 121st row of `state.prs`, so any single capped page misses it, and
  // it is reachable only because the merged half of the sweep is a dated `merged:`
  // search rather than a slice off the top of a list.
  const older = Array.from({ length: 120 }, (_, i) =>
    rawPR({ number: 700 + i, headRefOid: String(700 + i).padStart(40, '0'), state: 'OPEN' })
  );
  const mergedAt = new Date(Date.now() - 4 * 86400000).toISOString();
  world({
    prs: [
      ...older,
      rawPR({ number: 433, headRefOid: '4'.repeat(40), state: 'MERGED', mergedAt, mergeStateStatus: 'UNKNOWN' }),
    ],
    filesByNumber: { 433: ['public/monitor.js'], ...Object.fromEntries(older.map((p) => [p.number, ['lib/other.js']])) },
    compares: { [`${'4'.repeat(40)}...main`]: { status: 'ahead', total: 280, commits: [] } },
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--files', 'public/monitor.js', '--json'], {
    encoding: 'utf8',
    env: env(),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(jsonRows(run.stdout).map((r) => r.number), [433]);
  // And the sweep says what it covered, so the answer can be read for what it is.
  const scope = jsonScope(run.stdout);
  assert.equal(scope.complete, true);
  assert.equal(scope.open, 120);
  assert.equal(scope.merged, 1);
  assert.equal(scope.sinceDays, DEFAULT_SINCE_DAYS);
});

await acheck('CLI: a merged row arrives without a head sha and is re-read in full rather than printed blank', async () => {
  const mergedAt = new Date(Date.now() - 2 * 86400000).toISOString();
  world({
    prs: [rawPR({ number: 433, headRefOid: '4'.repeat(40), state: 'MERGED', mergedAt })],
    filesByNumber: { 433: ['public/monitor.js'] },
    compares: { [`${'4'.repeat(40)}...main`]: { status: 'ahead', total: 280, commits: [] } },
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--files', 'public/monitor.js'], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /#433/);
  assert.match(run.stdout, /44444444/); // the sha, not a blank where the sha should be
  assert.match(run.stdout, /280 commits behind main/);
  // A merged pull request is not going to be re-run, so the STALE marker — which means
  // "re-run this before believing the red" — has nothing to say about it.
  assert.doesNotMatch(run.stdout, /STALE/);
});

await acheck('a sweep GitHub cut off is reported INCOMPLETE, never as the whole answer', async () => {
  world({
    prs: [
      rawPR({ number: 1, headRefOid: '1'.repeat(40) }),
      rawPR({ number: 2, headRefOid: '2'.repeat(40) }),
      rawPR({ number: 3, headRefOid: '3'.repeat(40) }),
      rawPR({ number: 4, headRefOid: '5'.repeat(40) }),
    ],
    compares: Object.fromEntries(['1', '2', '3', '5'].map((c) => [`${c.repeat(40)}...main`, { status: 'identical', total: 0, commits: [] }])),
  });
  // In-process, because the only way to reach a full page from a fixture is to lower
  // the ceiling — `openLimit` exists for exactly this and the binary never passes it.
  const savedPath = process.env.PATH;
  const savedState = process.env.GH_FAKE_STATE;
  process.env.PATH = `${BIN_DIR}${path.delimiter}${savedPath}`;
  process.env.GH_FAKE_STATE = STATE;
  try {
    const full = await inflightRows(REPO, { openLimit: 2 });
    assert.equal(full.reachable, true); // it DID ask — this is not the unknown case
    assert.equal(full.rows.length, 2);
    assert.equal(full.scope.complete, false);
    assert.equal(full.scope.cap, 2);
    assert.match(describeScope(full.scope), /INCOMPLETE/);
    // And with room to spare, the same sweep is complete rather than permanently hedged.
    const fits = await inflightRows(REPO, { openLimit: OPEN_LIMIT });
    assert.equal(fits.scope.complete, true);
    assert.equal(fits.rows.length, 4);
  } finally {
    process.env.PATH = savedPath;
    if (savedState === undefined) delete process.env.GH_FAKE_STATE;
    else process.env.GH_FAKE_STATE = savedState;
  }
});

await acheck('CLI: --files with no paths after it refuses rather than quietly printing everything', async () => {
  // `b7e-inflight --files --json` used to yield an empty path list, become `null`
  // downstream, and print every open pull request as though that had been the question
  // — a narrowing the user asked for that silently did not happen, which is the same
  // shape as the truncated sweep above and gets the same answer as the two refusals
  // already beside it.
  world({ prs: [rawPR({ number: 1, headRefOid: '1'.repeat(40) })] });
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--files', '--json'], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--files needs at least one path/);
  assert.doesNotMatch(run.stdout, /"number"/);
});

await acheck('CLI: --since takes days, and refuses anything that is not a number', async () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--files', 'a.js', '--since', 'last-week'], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--since takes a number of days/);
});

await acheck('CLI: an unrecognised flag refuses rather than silently ignoring it', async () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--nope'], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unrecognised flag/);
});

cleanupTmp(tmp);

console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
