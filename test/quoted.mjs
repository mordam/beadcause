#!/usr/bin/env node
/**
 * `b7e-quoted` — every file, sha, branch and count a bead quotes, checked against the
 * tree it names. lib/quoted.js and bin/b7e-quoted.
 *
 *   npm test
 *   node test/quoted.mjs
 *
 * **The three shapes bc-dgx7.74's acceptance criteria name are rebuilt here as fixtures
 * rather than asserted against the live beads and checkouts they cite.** That is not
 * timidity, it is the same lesson the bead itself is about: a bead's own quoted example
 * is one session's narrative, and two of this bead's three were already false when the
 * command was built.
 *
 *   - It says bc-dgx7.60's `reference/deluvia.archaeo-anthro-overview.md` should report
 *     as *renamed*. Against the real deluvia checkout `git show -M --name-status` calls
 *     it a plain `A` + `D` — the commit rewrote too much of the file — and only the
 *     permissive second pass (`-M10%`) finds `R032`. The command was built to make that
 *     pass, and **fixture A below is that shape**: a file replaced by one with mostly
 *     new content in a single commit.
 *   - It says bc-khoe.67's `e60d0b87` should report as touching **none** of the paths
 *     that bead names. It touches three of them (`public/config.js`, `public/spacebar.js`
 *     and `scripts/space-check.mjs`) and the command says so, because that is what the
 *     tree says. bc-khoe.67's actual finding was narrower — the commit left the failing
 *     *assertion strings* unchanged — which is a claim about file contents that no
 *     path-intersection can make. **Fixture B is the behaviour the criterion describes**,
 *     built so a commit really does touch none of the quoted paths.
 *   - It says bc-dgx7.58's `atlas/public-launch` should report as diverged from the
 *     checkout's actual branch. That one is still true, and it is reproduced as fixture C
 *     as well as being the one criterion that was spot-checked live.
 *
 * Asserting the literal examples would have pinned this suite to two other repos' moving
 * `origin/main`, which is the failure mode described in this repo's own memory note
 * `a-real-repo-assertion-in-a-test-rots-between-your-run-and-ci`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-quoted');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7equoted-'));
process.on('exit', () => removeTreeSync(tmp));

/* ------------------------------------------------------------------- fixture repo */

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const REPO = path.join(tmp, 'repo');
fs.mkdirSync(path.join(REPO, 'reference'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'lib'), { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 'test@localhost');
git(REPO, 'config', 'user.name', 'test');

const write = (rel, body) => fs.writeFileSync(path.join(REPO, rel), body);

// Fixture A, part one: the file the bead will quote, with content that will mostly not
// survive the rename — which is what makes git's default -M refuse to call it one.
write(
  'reference/old-overview.md',
  Array.from({ length: 40 }, (_, i) => `original overview paragraph ${i}, since deleted wholesale`).join('\n') + '\n'
);
write('scripts/space-check.mjs', 'export const assertions = 39;\n');
write('lib/stable.js', 'export const stable = true;\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'base');
const BASE_SHA = git(REPO, 'rev-parse', 'HEAD');

// Fixture B: a commit that touches only a file the bead never names, so the intersection
// against the bead's own paths is genuinely empty.
write('scripts/unrelated.mjs', 'export const nothing = true;\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'a commit about something else entirely');
const UNRELATED_SHA = git(REPO, 'rev-parse', 'HEAD');

// …and one that does touch a quoted path, so "touches" is proved in both directions.
write('lib/stable.js', 'export const stable = true;\nexport const andMore = 1;\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'change lib/stable.js');
const TOUCHING_SHA = git(REPO, 'rev-parse', 'HEAD');

// Fixture A, part two: the rename that git will not call a rename at 50% similarity.
fs.rmSync(path.join(REPO, 'reference/old-overview.md'));
write(
  'reference/NEW_EVIDENCE.md',
  Array.from({ length: 40 }, (_, i) => `original overview paragraph ${i}, since deleted wholesale`)
    .slice(0, 13)
    .join('\n') +
    '\n' +
    Array.from({ length: 27 }, (_, i) => `entirely new evidence paragraph ${i}`).join('\n') +
    '\n'
);
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'retire the overview, keep its evidence as NEW_EVIDENCE.md');
const RENAME_SHA = git(REPO, 'rev-parse', '--short', 'HEAD');

// Fixture C: a branch that exists and has diverged from `main`, which is what the
// checkout stays on.
git(REPO, 'checkout', '-q', '-b', 'atlas/public-launch', BASE_SHA);
write('reference/only-on-atlas.md', 'atlas\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'atlas only');
git(REPO, 'checkout', '-q', 'main');
// A ref that is neither `main` nor divergent from it — the "same commit" answer.
git(REPO, 'update-ref', 'refs/heads/mirror-of-main', 'main');

/* ---------------------------------------------------------------------- fake bd */

/**
 * One bead, carrying every shape the extractor has to get right — the three acceptance
 * fixtures plus the tokens that must NOT become rows.
 */
const BEAD = {
  id: 'fx-1',
  title: 'b7e-quoted fixture bead',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  description: [
    'The four claims are about reference/old-overview.md, which is the file that moved.',
    'lib/stable.js is still there and scripts/space-check.mjs is too.',
    `The failing run blamed ${UNRELATED_SHA.slice(0, 8)}, and ${TOUCHING_SHA.slice(0, 8)} is the other one.`,
    'A sha nobody has: 4b0b54cd. A word that is only hex: defaced.',
    "The checkout is parked on atlas/public-launch, and mirror-of-main is where main is.",
    'Counts asked for were 243/50 and 86/33, and the bead said "12 checks".',
    'It also names lib/never-existed.js, which has never been in this tree.',
    'Read and write is an ahead/behind question, not a branch.',
    'See https://github.com/mordam/beadcause/pull/731 and ~/neadamthal.projects/deluvia.',
    'Two fragments that are not files: packages[""].bin and test/<name>.mjs.',
    'A glob is not a file either: scripts/check_*.py.',
    'Recovering it took `git fetch`, which nobody counted.',
  ].join('\n\n'),
  design: '',
  notes: '',
  acceptance_criteria: 'It reports reference/old-overview.md as renamed.',
  updated_at: '2026-08-28T12:00:00Z',
  comments: [{ author: 'beadcause', text: 'Nothing since then touches lib/ at all.', created_at: '2026-08-28T12:30:00Z' }],
};

/** A bead quoting only things that still hold — what `--strict` must exit 0 over. */
const CLEAN_BEAD = {
  ...BEAD,
  id: 'fx-clean',
  title: 'a bead whose quotes all still hold',
  description: `lib/stable.js is present and mirror-of-main is where main is, at ${TOUCHING_SHA.slice(0, 8)}.`,
  acceptance_criteria: '',
  comments: [],
};

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const world = ${JSON.stringify({ 'fx-1': BEAD, 'fx-clean': CLEAN_BEAD })};
const args = process.argv.slice(2);
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
if (args[0] === 'show') {
  const issue = world[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found matching "' + args[1] + '"');
  if (args.includes('--include-comments')) { process.stdout.write(JSON.stringify([issue])); process.exit(0); }
  const { comments, ...rest } = issue;
  process.stdout.write(JSON.stringify([rest]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write(JSON.stringify(world[args[1]]?.comments || [])); process.exit(0); }
die('stub bd: unexpected verb "' + args[0] + '"');
`,
  { mode: 0o755 }
);

/* -------------------------------------------------------------------------- config */

const TRACKER = path.join(tmp, 'tracker');
fs.mkdirSync(TRACKER, { recursive: true });
const CONFIG_DIR = fs.mkdtempSync(path.join(tmp, 'config-'));
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'quoted-ws', dir: TRACKER }] }, null, 2)
);

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: CONFIG_DIR, NO_COLOR: '1' },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: (res.stdout || '').replace(/\x1b\[[0-9;]*m/g, ''), stderr: res.stderr || '' };
}

const REPORT = run(['fx-1', '--dir', REPO, '--ref', 'main']);
const JSON_ROWS = run(['fx-1', '--dir', REPO, '--ref', 'main', '--json']).stdout
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const rowFor = (kind, value) => JSON_ROWS.find((r) => r.kind === kind && r.value === value);

/* ------------------------------------------------------------------------- harness */

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 10).join('\n       ')}`);
  }
};

console.log('\nb7e-quoted\n');

/* ------------------------------------------------------------------------ argv */

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-quoted/);
});

check('no bead id is refused', () => {
  const { status, stderr } = run(['--dir', REPO]);
  assert.notEqual(status, 0);
  assert.match(stderr, /need a bead id/);
});

check('two bead ids are refused', () => {
  const { status, stderr } = run(['fx-1', 'fx-2', '--dir', REPO]);
  assert.notEqual(status, 0);
  assert.match(stderr, /exactly one bead id/);
});

check('-w and --dir together are refused', () => {
  const { status, stderr } = run(['fx-1', '-w', 'quoted-ws', '--dir', REPO]);
  assert.notEqual(status, 0);
  assert.match(stderr, /mutually exclusive/);
});

check('an unknown workspace is refused, naming the ones there are', () => {
  const { status, stderr } = run(['fx-1', '-w', 'nope']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no workspace named nope — have: quoted-ws/);
});

check('a bead no tracker has is refused, naming the trackers asked', () => {
  const { status, stderr } = run(['fx-404', '--dir', REPO]);
  assert.equal(status, 2);
  assert.match(stderr, /no bead fx-404 in quoted-ws/);
});

check('a ref that does not resolve is refused rather than counted as an empty tree', () => {
  const { status, stderr } = run(['fx-1', '--dir', REPO, '--ref', 'no-such-ref']);
  assert.equal(status, 2);
  assert.match(stderr, /no-such-ref does not resolve to a tree/);
});

/* ------------------------------------------------- acceptance A: a path that moved */

check('acceptance: a path replaced by a mostly-rewritten file reports as renamed, to the new name', () => {
  assert.equal(REPORT.status, 0);
  const row = rowFor('path', 'reference/old-overview.md');
  assert.equal(row.state, 'renamed');
  assert.equal(row.to, 'reference/NEW_EVIDENCE.md');
  assert.match(REPORT.stdout, /renamed\s+reference\/old-overview\.md/);
  assert.match(REPORT.stdout, /renamed to reference\/NEW_EVIDENCE\.md/);
});

check('a rename git\'s default threshold refuses is reported with its similarity score', () => {
  // The point of the second pass: at -M this is an A plus a D and nothing more.
  const strict = git(REPO, 'show', '--name-status', '--format=', RENAME_SHA);
  assert.doesNotMatch(strict, /^R/m);
  const hop = rowFor('path', 'reference/old-overview.md').chain[0];
  assert.equal(hop.weak, true);
  assert.ok(hop.similarity > 0 && hop.similarity < 50, `similarity ${hop.similarity} should be a weak match`);
  assert.match(REPORT.stdout, /below git's default rename threshold/);
});

check('a path still in the tree reports present, and one that never was reports absent', () => {
  assert.equal(rowFor('path', 'lib/stable.js').state, 'present');
  assert.equal(rowFor('path', 'lib/never-existed.js').state, 'absent');
  assert.match(REPORT.stdout, /nothing by that name has ever been in this tree/);
});

check('quotes carry the field they were written in and the sentence around them', () => {
  const row = rowFor('path', 'reference/old-overview.md');
  const fields = row.quotes.map((q) => q.field);
  assert.ok(fields.includes('description'), `expected a description quote, got ${fields.join(', ')}`);
  assert.ok(fields.includes('acceptance'), `expected an acceptance quote, got ${fields.join(', ')}`);
  assert.ok(row.quotes.some((q) => /four claims/.test(q.sentence)));
});

check('a comment is part of the corpus, not just the description', () => {
  assert.ok(JSON_ROWS.some((r) => r.quotes.some((q) => /^comment /.test(q.field))));
});

/* ------------------------------------- acceptance B: a commit that touches nothing quoted */

check('acceptance: a commit that exists but touches none of the paths the bead names says so', () => {
  const row = rowFor('commit', UNRELATED_SHA.slice(0, 8));
  assert.equal(row.state, 'present');
  assert.deepEqual(row.touches, []);
  assert.ok(row.checkedAgainst > 0, 'the intersection must have had paths to check against');
  assert.match(REPORT.stdout, /touches none of the \d+ paths this bead also names/);
});

check('a commit that does touch a quoted path names it', () => {
  const row = rowFor('commit', TOUCHING_SHA.slice(0, 8));
  assert.equal(row.state, 'present');
  assert.deepEqual(row.touches, ['lib/stable.js']);
});

check('a sha this checkout has never seen reports unknown', () => {
  assert.equal(rowFor('commit', '4b0b54cd').state, 'unknown');
});

check('a hex-only English word is never reported as a commit', () => {
  assert.equal(rowFor('commit', 'defaced'), undefined);
});

/* ------------------------------------------ acceptance C: a branch that has diverged */

check("acceptance: a branch that exists reports as diverged from the checkout's actual branch", () => {
  const row = rowFor('branch', 'atlas/public-launch');
  assert.equal(row.state, 'diverged');
  assert.equal(row.current, 'main');
  assert.ok(row.currentAhead > 0 && row.branchAhead > 0, `expected divergence both ways, got ${JSON.stringify(row)}`);
  assert.match(REPORT.stdout, /diverged from main: \d+ ahead \/ \d+ behind/);
});

check('a branch pointing at the same commit as the checkout is not a finding', () => {
  assert.equal(rowFor('branch', 'mirror-of-main').state, 'same-commit');
});

/* ------------------------------------------------------------------------- counts */

check('a census pair is a count, never a branch', () => {
  assert.equal(rowFor('count', '243/50').state, 'unchecked');
  assert.equal(rowFor('count', '86/33').state, 'unchecked');
  assert.equal(rowFor('branch', '243/50'), undefined);
});

check('a number and its noun is a count, and the count section says it was not checked', () => {
  assert.equal(rowFor('count', '12 checks').state, 'unchecked');
  assert.match(REPORT.stdout, /COUNTS \(not checked — recount before quoting\)/);
});

check('a backticked command is never offered as the literal a count was measuring', () => {
  for (const row of JSON_ROWS.filter((r) => r.kind === 'count')) {
    assert.ok(!/^git |^bd |^-/.test(row.literal || ''), `${row.value} offered ${row.literal} as its literal`);
  }
});

/* ---------------------------------------------------------------- what must not be a row */

check('ordinary prose written with a slash in it is dropped, not reported as an unknown branch', () => {
  assert.equal(rowFor('branch', 'ahead/behind'), undefined);
  assert.equal(rowFor('path', 'ahead/behind'), undefined);
});

check('a URL and a home-relative absolute path are neither paths nor branches', () => {
  assert.ok(!JSON_ROWS.some((r) => /github\.com/.test(r.value)), 'a URL became a row');
  assert.ok(!JSON_ROWS.some((r) => r.value.startsWith('/')), 'an absolute path became a row');
});

check('an extension with no filename in front of it is not a file', () => {
  assert.equal(rowFor('path', '.bin'), undefined);
  assert.equal(rowFor('path', '.mjs'), undefined);
});

check('a glob cut short at its asterisk is not reported as an absent file', () => {
  assert.equal(rowFor('path', 'scripts/check_'), undefined);
});

/* -------------------------------------------------------------------- json and exit codes */

check('--json emits one parseable row per artifact, each carrying bead, ref and dir', () => {
  assert.ok(JSON_ROWS.length > 8, `expected a report, got ${JSON_ROWS.length} rows`);
  for (const row of JSON_ROWS) {
    assert.equal(row.bead, 'fx-1');
    assert.equal(row.ref, 'main');
    assert.equal(row.dir, REPO);
    assert.ok(['path', 'commit', 'branch', 'count'].includes(row.kind));
  }
});

check('the printed report ends with a count of what no longer holds', () => {
  assert.match(REPORT.stdout, /\n\d+ of \d+ quoted things no longer holds\./);
});

check('a rotted quote is not a failure by default, and is one under --strict', () => {
  assert.equal(REPORT.status, 0);
  assert.equal(run(['fx-1', '--dir', REPO, '--ref', 'main', '--strict']).status, 1);
});

check('--strict is 0 when every quote still holds', () => {
  // A separate bead rather than an earlier ref: branch divergence is a fact about the
  // checkout, not about the tree at `--ref`, so `atlas/public-launch` is a finding at
  // every ref and no `--ref` can make fx-1 clean.
  const clean = run(['fx-clean', '--dir', REPO, '--ref', 'main', '--strict']);
  assert.equal(clean.status, 0, `expected a clean run, got ${clean.status}:\n${clean.stdout}`);
  assert.match(clean.stdout, /\n0 of \d+ quoted things no longer holds\./);
});

check('--ref decides which tree is asked, not the checkout', () => {
  const atBase = run(['fx-1', '--dir', REPO, '--ref', BASE_SHA, '--json']).stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const row = atBase.find((r) => r.kind === 'path' && r.value === 'reference/old-overview.md');
  assert.equal(row.state, 'present', 'at the base commit the file is still there');
});

console.log(`\n${failures ? `${failures} failed` : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
