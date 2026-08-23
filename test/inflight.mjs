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
import { behindOf, staleOf, touchesAny, describeChecks } from '../lib/prsurvey.js';
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
  out(JSON.stringify(state.prs || []));
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
      '56d4c4d1abcdef1234567890abcdef1234567890...main': {
        status: 'diverged',
        commits: Array.from({ length: 593 }, (_, i) => ({ sha: String(i), parents: 1, message: 'm', login: 'x' })),
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
  const rows = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
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
  const rows = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
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
  const row = JSON.parse(run.stdout.trim());
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
  const rows = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
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
  const rows = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  // Asked `gh` in REPO (the fake), got REPO's own PR #900 — never crossed into
  // `otherDir`, which the fake `gh` was never even pointed at.
  assert.deepEqual(rows.map((r) => r.number), [900]);
  assert.deepEqual(rows[0].beads, []); // no workspace resolved, so no bead lookup at all
});

await acheck('CLI: an unrecognised flag refuses rather than silently ignoring it', async () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--nope'], { encoding: 'utf8', env: env() });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unrecognised flag/);
});

cleanupTmp(tmp);

console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
