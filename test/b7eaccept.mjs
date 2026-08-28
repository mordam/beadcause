#!/usr/bin/env node
/**
 * `b7e-accept` — run the invocations a bead's own `acceptance_criteria` field quotes.
 * `lib/accept.js` (pure) and `bin/b7e-accept` (the CLI).
 *
 *     npm test
 *     node test/b7eaccept.mjs
 *
 * Two halves. First, `lib/accept.js`'s pure functions driven directly against a small
 * fixture `bin/` this suite builds and fully controls (one script per `@grant` kind,
 * one undeclared, one with no `b7e-` prefix at all) — the same arrangement
 * `lib/tooldecl.js`'s own suite uses for the identical reason: a check that can only be
 * run against the real repo can only ever be shown passing. Second, `bin/b7e-accept`
 * itself, spawned for real, against a fake `bd` that answers with `bc-dgx7.81`'s and
 * `bc-dgx7.82`'s own real `acceptance_criteria` text (captured verbatim, so a later edit
 * to those closed beads cannot rot this suite) but a REAL target: the invocations it
 * runs are this repo's own actual `bin/b7e-already`, exactly as `bc-dgx7.85` argued for
 * — proof against real files, not just fixtures, for the one part a fixture cannot
 * stand in for: whether the resolved command actually runs and reports its exit code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';
import {
  backtickSpans,
  splitCriteria,
  candidateInvocation,
  findInvocation,
  classifyTarget,
  planCriterion,
  planBead,
} from '../lib/accept.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-accept');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eaccept-'));
process.on('exit', () => removeTreeSync(tmp));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 12).join('\n       ')}`);
  }
};

console.log('\nb7e-accept\n');

/* ============================================================== fixture bin/ */

const FIXTURE_ROOT = fs.mkdtempSync(path.join(tmp, 'fixture-'));
const FIXTURE_BIN = path.join(FIXTURE_ROOT, 'bin');
fs.mkdirSync(FIXTURE_BIN, { recursive: true });

function writeTool(name, { grant, exit = 0, echo = name } = {}) {
  const lines = ['#!/usr/bin/env node'];
  if (grant) lines.push('/**', ` * @grant ${grant}`, ' */');
  lines.push(`console.log(${JSON.stringify(echo)} + ' ' + process.argv.slice(2).join(' '));`, `process.exit(${exit});`);
  const file = path.join(FIXTURE_BIN, name);
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o755 });
  return file;
}

writeTool('b7e-ok', { grant: 'read', exit: 0 });
writeTool('b7e-sad', { grant: 'read', exit: 1 });
writeTool('b7e-hidden', { grant: 'write' });
writeTool('b7e-trampoline', { grant: 'excluded' });
writeTool('b7e-nothing', { grant: null }); // undeclared
fs.writeFileSync(path.join(FIXTURE_BIN, 'deliver.js'), '#!/usr/bin/env node\nconsole.log("nope");\n', { mode: 0o755 });
fs.writeFileSync(
  path.join(FIXTURE_BIN, 'b7e-slow'),
  '#!/usr/bin/env node\n/**\n * @grant read\n */\nsetTimeout(() => { console.log("done"); process.exit(0); }, 2000);\n',
  { mode: 0o755 }
);

/* -------------------------------------------------------------- backtickSpans */

check('backtickSpans finds every span, in order', () => {
  assert.deepEqual(backtickSpans('`a` and `b c` and plain text `d`'), ['a', 'b c', 'd']);
  assert.deepEqual(backtickSpans('no backticks here'), []);
});

/* -------------------------------------------------------------- splitCriteria */

check('splitCriteria does not split on a period inside backticks', () => {
  const sentences = splitCriteria('`dv-b5d.32` names it. `transcript.json` too.');
  assert.deepEqual(sentences, ['`dv-b5d.32` names it.', '`transcript.json` too.']);
});

check('splitCriteria replays bc-dgx7.81\'s own acceptance_criteria into 4 sentences', () => {
  const text =
    '`b7e-already time ago` names `ago` in lib/resolvers.js AND\n' +
    'says it is private, in one\n' +
    'call. `b7e-already resolve session dir` finds\n' +
    '`resolveSessionDir` even though it is\n' +
    '`export const … =>`, which `grep "^export function"` misses. `b7e-already --module\n' +
    'lib/bd.js` lists the `Bd` methods bc-dgx7.62 needed four calls to enumerate. Exit 1,\n' +
    'not a crash, on a phrase nothing matches.';
  const sentences = splitCriteria(text);
  assert.equal(sentences.length, 4);
  assert.match(sentences[0], /^`b7e-already time ago`.*in one call\.$/);
  assert.match(sentences[1], /^`b7e-already resolve session dir`.*misses\.$/);
  assert.match(sentences[2], /^`b7e-already --module lib\/bd\.js`.*enumerate\.$/);
  assert.equal(sentences[3], 'Exit 1, not a crash, on a phrase nothing matches.');
});

check('splitCriteria replays bc-dgx7.82\'s own acceptance_criteria into 3 sentences', () => {
  const text =
    '`b7e-propagated -w deluvia 108 --at <commit before dv-b5d.32 landed>` exits 1 and lists\n' +
    '`pipeline/lib/checks.py`, `SPECIES_GUIDE.md` §8A, `docs/CONTINUITY_GUIDE.md`, the\n' +
    'compendium phylogeny page and `FAUNA_AND_FLORA.md`\'s short-faced bear line — the four\n' +
    '`dv-b5d.32` found plus the one it missed that `dv-5eu` found later, and it must find\n' +
    'the bear line at the real path rather than in a worktree copy.\n' +
    '`b7e-propagated -w deluvia 037` names `webseries/episodes/kazran-orves/script.txt` and\n' +
    '`transcript.json`. An entry whose checklist is genuinely complete exits 0 and prints\n' +
    'one line per verified box.';
  const sentences = splitCriteria(text);
  assert.equal(sentences.length, 3);
  assert.match(sentences[0], /^`b7e-propagated -w deluvia 108 --at <commit before dv-b5d\.32 landed>`.*worktree copy\.$/);
  assert.match(sentences[1], /^`b7e-propagated -w deluvia 037`.*`transcript\.json`\.$/);
  assert.equal(sentences[2], 'An entry whose checklist is genuinely complete exits 0 and prints one line per verified box.');
});

check('splitCriteria on an empty or whitespace-only field returns nothing', () => {
  assert.deepEqual(splitCriteria(''), []);
  assert.deepEqual(splitCriteria('   \n  '), []);
  assert.deepEqual(splitCriteria(null), []);
});

/* --------------------------------------------------------- candidateInvocation */

check('candidateInvocation resolves a bare name, ./bin/, bin/ and node bin/ alike', () => {
  for (const span of ['b7e-ok x y', './bin/b7e-ok x y', 'bin/b7e-ok x y', 'node bin/b7e-ok x y']) {
    const c = candidateInvocation(span, FIXTURE_ROOT);
    assert.ok(c, `expected a candidate for "${span}"`);
    assert.equal(c.command, 'b7e-ok');
    assert.deepEqual(c.args, ['x', 'y']);
  }
});

check('candidateInvocation is null for a name with no file in bin/', () => {
  assert.equal(candidateInvocation('grep "^export function"', FIXTURE_ROOT), null);
  assert.equal(candidateInvocation('SPECIES_GUIDE.md §8A', FIXTURE_ROOT), null);
  assert.equal(candidateInvocation('', FIXTURE_ROOT), null);
});

check('candidateInvocation flags an angle-bracket placeholder', () => {
  const c = candidateInvocation('b7e-ok --at <commit before X landed>', FIXTURE_ROOT);
  assert.ok(c.hasPlaceholder);
  const clean = candidateInvocation('b7e-ok --at HEAD', FIXTURE_ROOT);
  assert.equal(clean.hasPlaceholder, false);
});

check('findInvocation picks the FIRST candidate span in a sentence, ignoring the rest', () => {
  const inv = findInvocation('`b7e-ok a` finds `resolveSessionDir` which is `export const x =>`.', FIXTURE_ROOT);
  assert.equal(inv.command, 'b7e-ok');
  assert.deepEqual(inv.args, ['a']);
});

check('findInvocation is null when no span in the sentence resolves', () => {
  assert.equal(findInvocation('Exit 1, not a crash, on a phrase nothing matches.', FIXTURE_ROOT), null);
});

/* ------------------------------------------------------------- classifyTarget */

check('classifyTarget: read only for a tool that actually declares @grant read', () => {
  assert.equal(classifyTarget(path.join(FIXTURE_BIN, 'b7e-ok')).kind, 'read');
});

check('classifyTarget refuses write, excluded, undeclared and non-b7e- alike', () => {
  assert.equal(classifyTarget(path.join(FIXTURE_BIN, 'b7e-hidden')).kind, 'write');
  assert.equal(classifyTarget(path.join(FIXTURE_BIN, 'b7e-trampoline')).kind, 'excluded');
  assert.equal(classifyTarget(path.join(FIXTURE_BIN, 'b7e-nothing')).kind, 'write');
  assert.match(classifyTarget(path.join(FIXTURE_BIN, 'b7e-nothing')).reason, /declares no @grant/);
  const nonB7e = classifyTarget(path.join(FIXTURE_BIN, 'deliver.js'));
  assert.equal(nonB7e.kind, 'write');
  assert.match(nonB7e.reason, /not a b7e-\* tool/);
});

check('classifyTarget on the REAL bin/b7e-run (this repo\'s own) is excluded, not read', () => {
  assert.equal(classifyTarget(path.join(ROOT, 'bin', 'b7e-run')).kind, 'excluded');
});

/* ------------------------------------------------------------- planCriterion */

check('planCriterion: runnable when the sentence quotes a @grant read tool cleanly', () => {
  const p = planCriterion('`b7e-ok a b` should work.', FIXTURE_ROOT);
  assert.equal(p.runnable, true);
  assert.equal(p.refused, false);
  assert.equal(p.invocation.command, 'b7e-ok');
});

check('planCriterion: refused, not run, for a write/excluded/undeclared target', () => {
  for (const name of ['b7e-hidden', 'b7e-trampoline', 'b7e-nothing']) {
    const p = planCriterion(`\`${name} a\` does something.`, FIXTURE_ROOT);
    assert.equal(p.runnable, false);
    assert.equal(p.refused, true, `expected ${name} to be refused`);
    assert.match(p.reason, /^refused —/);
  }
});

check('planCriterion: not runnable, not refused, when a placeholder is present (bc-dgx7.82 shape)', () => {
  const p = planCriterion('`b7e-ok --at <commit before X landed>` exits 1.', FIXTURE_ROOT);
  assert.equal(p.runnable, false);
  assert.equal(p.refused, false);
  assert.match(p.reason, /contains a placeholder/);
  assert.match(p.reason, /not guessed at/);
});

check('planCriterion: not runnable, no invocation, for plain prose', () => {
  const p = planCriterion('An entry whose checklist is genuinely complete exits 0.', FIXTURE_ROOT);
  assert.equal(p.runnable, false);
  assert.equal(p.refused, false);
  assert.equal(p.invocation, null);
  assert.match(p.reason, /no invocation found/);
});

/* ----------------------------------------------------------------- planBead */

check('planBead: acceptance (empty field) — a distinct state from "ran and found nothing wrong"', () => {
  assert.deepEqual(planBead('', FIXTURE_ROOT), { empty: true, criteria: [] });
  assert.deepEqual(planBead('   ', FIXTURE_ROOT), { empty: true, criteria: [] });
});

check('planBead: a mixed field produces one plan entry per sentence, each independently judged', () => {
  const text = '`b7e-ok a` works. `b7e-hidden b` is a write. `b7e-ok --at <X>` is a placeholder. Plain prose here.';
  const plan = planBead(text, FIXTURE_ROOT);
  assert.equal(plan.empty, false);
  assert.equal(plan.criteria.length, 4);
  assert.equal(plan.criteria[0].runnable, true);
  assert.equal(plan.criteria[1].refused, true);
  assert.match(plan.criteria[2].reason, /placeholder/);
  assert.equal(plan.criteria[3].invocation, null);
});

/* ======================================================================= CLI */

const FAKE_BD = path.join(tmp, 'bd');
const CRITERIA = {
  'ws-b7e81': [
    '`b7e-already time ago` names `ago` in lib/resolvers.js AND says it is private, in one',
    'call. `b7e-already resolve session dir` finds `resolveSessionDir` even though it is',
    '`export const … =>`, which `grep "^export function"` misses. `b7e-already --module',
    'lib/bd.js` lists the `Bd` methods bc-dgx7.62 needed four calls to enumerate. Exit 1,',
    'not a crash, on a phrase nothing matches.',
  ].join('\n'),
  'ws-empty': '',
  'ws-refused': '`b7e-run b7e-gate --jobs 3` runs the whole gate through the trampoline.',
  'ws-mixed': '`b7e-already zzznothingatall` matches nothing. `b7e-run b7e-gate` is refused.',
  'ws-fixture-cmd': '`b7e-ok hello` should print hello and exit 0.',
  'ws-slow': '`b7e-slow` takes a couple seconds to finish.',
};

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const world = ${JSON.stringify(CRITERIA)};
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const verb = args[0];
if (verb === 'show') {
  const id = args[1];
  if (!(id in world)) die('Error fetching ' + id + ': no issue found matching "' + id + '"');
  process.stdout.write(JSON.stringify([{ id, acceptance_criteria: world[id] }]));
  process.exit(0);
}
die('stub bd: unexpected verb "' + verb + '"');
`,
  { mode: 0o755 }
);

const CONFIG_DIR = fs.mkdtempSync(path.join(tmp, 'config-'));
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'accept-ws', dir: path.join(tmp, 'tracker') }] }, null, 2)
);
fs.mkdirSync(path.join(tmp, 'tracker'), { recursive: true });

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function run(args, { cwd = ROOT } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: stripAnsi(res.stdout || ''), stderr: stripAnsi(res.stderr || '') };
}

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-accept/);
});

check('a missing -w is refused, exit 2', () => {
  const { status, stderr } = run(['-b', 'ws-b7e81']);
  assert.equal(status, 2);
  assert.match(stderr, /-w\/--workspace is required/);
});

check('a missing -b is refused, exit 2', () => {
  const { status, stderr } = run(['-w', 'accept-ws']);
  assert.equal(status, 2);
  assert.match(stderr, /-b\/--bead is required/);
});

check('an unknown workspace is refused, exit 4', () => {
  const { status, stderr } = run(['-w', 'nope', '-b', 'ws-b7e81']);
  assert.equal(status, 4);
  assert.match(stderr, /no workspace named "nope"/);
});

check('an unknown bead is refused, exit 4', () => {
  const { status, stderr } = run(['-w', 'accept-ws', '-b', 'ws-nosuch']);
  assert.equal(status, 4);
  assert.match(stderr, /has no bead ws-nosuch/);
});

check('an empty acceptance_criteria exits 2, saying so — not 0 saying nothing failed', () => {
  const { status, stdout } = run(['-w', 'accept-ws', '-b', 'ws-empty']);
  assert.equal(status, 2);
  assert.match(stdout, /empty acceptance_criteria field/);
});

check('acceptance (bc-dgx7.81 shape): extracts the three b7e-already invocations plus the no-match case, runs them against a checkout that has bin/b7e-already, reports each with an exit code', () => {
  const { status, stdout } = run(['-w', 'accept-ws', '-b', 'ws-b7e81'], { cwd: ROOT });
  assert.equal(status, 0);
  assert.match(stdout, /\[1\] `b7e-already time ago`/);
  assert.match(stdout, /runs: .*bin\/b7e-already time ago/);
  assert.match(stdout, /exit 0/);
  assert.match(stdout, /\[2\] `b7e-already resolve session dir`/);
  assert.match(stdout, /\[3\] `b7e-already --module lib\/bd\.js`/);
  assert.match(stdout, /\[4\] Exit 1, not a crash, on a phrase nothing matches\./);
  assert.match(stdout, /not runnable — no invocation found/);
  assert.match(stdout, /verdict: 4 criteria — 3 run \(3 ok, 0 failed\), 0 refused, 1 not runnable/);
});

check('acceptance: refuses to execute a write/excluded-classified invocation, and it counts as refused not failed', () => {
  const { status, stdout } = run(['-w', 'accept-ws', '-b', 'ws-refused'], { cwd: ROOT });
  assert.equal(status, 3);
  assert.match(stdout, /refused — b7e-run is declared @grant excluded, not read/);
  assert.match(stdout, /verdict: 1 criteria — 0 run \(0 ok, 0 failed\), 1 refused, 0 not runnable/);
});

check('a criterion whose real invocation legitimately exits non-zero is reported, not treated as a crash', () => {
  const { status, stdout } = run(['-w', 'accept-ws', '-b', 'ws-mixed'], { cwd: ROOT });
  assert.equal(status, 1);
  assert.match(stdout, /exit 1/);
  assert.match(stdout, /not ok/);
});

check('--list resolves and prints without running anything, exit 0', () => {
  const { status, stdout } = run(['-w', 'accept-ws', '-b', 'ws-b7e81', '--list'], { cwd: ROOT });
  assert.equal(status, 0);
  assert.match(stdout, /--list, nothing will run/);
  assert.match(stdout, /runs: .*bin\/b7e-already time ago/);
  assert.doesNotMatch(stdout, /exit \d/);
  assert.match(stdout, /verdict: 4 criteria — 0 run \(0 ok, 0 failed\)/);
});

check('--dir points resolution at another checkout entirely', () => {
  // b7e-ok exists only in the fixture tree, not in the real repo's bin/ — so the same
  // criterion text is "not runnable" against the default root and genuinely runs, for
  // real, against --dir.
  const withoutDir = run(['-w', 'accept-ws', '-b', 'ws-fixture-cmd'], { cwd: ROOT });
  assert.equal(withoutDir.status, 0);
  assert.match(withoutDir.stdout, /not runnable — no invocation found/);

  const withDir = run(['-w', 'accept-ws', '-b', 'ws-fixture-cmd', '--dir', FIXTURE_ROOT]);
  assert.equal(withDir.status, 0);
  assert.match(withDir.stdout, new RegExp(`runs: ${FIXTURE_BIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/b7e-ok hello`));
  assert.match(withDir.stdout, /exit 0/);
  assert.match(withDir.stdout, /b7e-ok hello/);
});

check('a criterion whose invocation blows the --timeout is reported timed out, not hung on', () => {
  const { status, stdout } = run(['-w', 'accept-ws', '-b', 'ws-slow', '--dir', FIXTURE_ROOT, '--timeout', '0.3']);
  assert.equal(status, 1);
  assert.match(stdout, /timed out after 0\.3s/);
});

check('--timeout is validated', () => {
  const { status, stderr } = run(['-w', 'accept-ws', '-b', 'ws-b7e81', '--timeout', 'nope']);
  assert.equal(status, 2);
  assert.match(stderr, /--timeout wants a positive number of seconds/);
});

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
