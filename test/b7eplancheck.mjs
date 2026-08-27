#!/usr/bin/env node
//
// b7e-plancheck — the read side of bin/plan.js (bc-dgx7.18). A session audit found
// three planners each rebuilding the same read-back by hand: heredocs re-measuring a
// prompt's length after every trim, scratchpad programs reconstructing a plan through
// planFrom before revising it, a dump-then-python pass to print prompt length per group.
//
//   npm test
//   node test/b7eplancheck.mjs
//
// Driven as a real subprocess against a stub `bd`, for the reason test/b7eorient.mjs
// gives: the flags reaching `bd` are the thing under test, and this command must never
// spawn a write verb (`comment`, `label`, `update`) — the stub refuses any verb it does
// not explicitly recognise, which is what would catch that regression.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-plancheck');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eplancheck-'));
process.on('exit', () => removeTreeSync(tmp));

/* ---------------------------------------------------------------------- the stub bd */

const FAKE_BD = path.join(tmp, 'bd');
const CALLS = path.join(tmp, 'calls.jsonl');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.BEADS_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, dir }) + '\\n');
const world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const verb = args[0];
const rest = args.slice(1);

function collectIds(list) {
  const ids = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--json' || a === '--all' || a === '--include-comments') continue;
    if (a === '--actor' || a === '--limit' || a === '--parent') { i += 1; continue; }
    if (a === '--exclude-label') { i += 1; continue; }
    ids.push(a);
  }
  return ids;
}

if (verb === 'show') {
  const ids = collectIds(rest);
  const rows = [];
  for (const id of ids) {
    const issue = world.issues[id];
    if (!issue) die('Error fetching ' + id + ': no issue found matching "' + id + '"');
    rows.push({ ...issue });
  }
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (verb === 'comments') {
  const id = collectIds(rest)[0];
  process.stdout.write(JSON.stringify(world.comments[id] || []));
  process.exit(0);
}
if (verb === 'export') {
  const lines = Object.values(world.issues).map((i) => JSON.stringify(i));
  process.stdout.write(lines.join('\\n') + '\\n');
  process.exit(0);
}
if (verb === 'list') {
  const pi = rest.indexOf('--parent');
  const parentId = pi === -1 ? null : rest[pi + 1];
  const rows = Object.values(world.issues).filter((i) => i.parent === parentId);
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (verb === 'ready') {
  const excluded = new Set();
  for (let i = 0; i < rest.length; i += 1) if (rest[i] === '--exclude-label') excluded.add(rest[i + 1]);
  const rows = Object.values(world.issues).filter(
    (i) => i.status === 'open' && !(i.labels || []).some((l) => excluded.has(l))
  );
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
die('stub bd: unexpected verb "' + verb + '" — this command must never write');
`,
  { mode: 0o755 }
);

/* ------------------------------------------------------------------- the world */

const dep = (from, to, type) => ({ issue_id: from, depends_on_id: to, type });

const issue = (id, over = {}) => ({
  id,
  title: '',
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  assignee: '',
  owner: '',
  labels: [],
  acceptance_criteria: '',
  parent: null,
  dependencies: [],
  ...over,
});

const child = (id, parentId, over = {}) =>
  issue(id, { parent: parentId, dependencies: [dep(id, parentId, 'parent-child')], ...over });

const PLAN_OPEN = '<!-- beadcause:plan -->';
const PLAN_CLOSE = '<!-- /beadcause:plan -->';
const WHOLE_OPEN = '<!-- beadcause:whole -->';
const WHOLE_CLOSE = '<!-- /beadcause:whole -->';

const LIVE_PROMPT = 'Do the live-group work, which one bead of this group is already claimed on.';
const READY_PROMPT = 'Do the ready-group work, which nothing is holding yet.';

const PLAN_OBJ = {
  epic: 'pc-epic',
  groups: [
    {
      name: 'grp-live',
      repo: 'plan-ws',
      beads: ['pc-epic.1', 'pc-epic.2'],
      files: ['lib/a.js'],
      prs: [{ repo: 'plan-ws', title: 'Ship the live group' }],
      prompt: LIVE_PROMPT,
    },
    {
      name: 'grp-ready',
      repo: 'plan-ws',
      beads: ['pc-epic.4'],
      files: [],
      prs: [{ repo: 'plan-ws', title: 'Ship the ready group' }],
      prompt: READY_PROMPT,
    },
  ],
};
const PLAN_TEXT = ['Plan for pc-epic.', '', PLAN_OPEN, '```json', JSON.stringify(PLAN_OBJ, null, 2), '```', PLAN_CLOSE].join('\n');

const WHOLE_WHY = 'This epic is one edit to one file and splitting it would file a bead so a second window could hold what the first already has open.';
const WHOLE_OBJ = { epic: 'pc-whole', whole: true, why: WHOLE_WHY };
const WHOLE_TEXT = ['**pc-whole is one job.**', '', WHOLE_WHY, '', WHOLE_OPEN, '```json', JSON.stringify(WHOLE_OBJ, null, 2), '```', WHOLE_CLOSE].join('\n');

const WORLD = {
  issues: {
    'pc-epic': issue('pc-epic', { title: 'The plan under test', issue_type: 'epic', labels: ['planned'] }),
    'pc-epic.1': child('pc-epic.1', 'pc-epic', { title: 'Already claimed', status: 'in_progress' }),
    'pc-epic.2': child('pc-epic.2', 'pc-epic', { title: 'Second of the live group', description: 'touches lib/a.js' }),
    'pc-epic.3': child('pc-epic.3', 'pc-epic', { title: 'Ready but nobody grouped it' }),
    'pc-epic.4': child('pc-epic.4', 'pc-epic', { title: 'The one dispatchable group' }),
    'pc-whole': issue('pc-whole', { title: 'A childless epic decided whole', issue_type: 'epic', labels: ['whole-job'] }),
    'pc-empty': issue('pc-empty', { title: 'Nothing decided yet', issue_type: 'epic' }),
    'pc-check': issue('pc-check', { title: 'For --check candidates', issue_type: 'epic' }),
    'pc-check.1': child('pc-check.1', 'pc-check', { title: 'A real child of pc-check' }),
    'pc-other': issue('pc-other', { title: 'Not under pc-check at all' }),
  },
  comments: {
    'pc-epic': [{ id: 1, issue_id: 'pc-epic', author: 'beadcause', text: PLAN_TEXT, created_at: '2026-01-01T00:00:00Z' }],
    'pc-whole': [{ id: 2, issue_id: 'pc-whole', author: 'beadcause', text: WHOLE_TEXT, created_at: '2026-01-01T00:00:00Z' }],
    'pc-empty': [],
    'pc-check': [],
  },
};

const dirFor = (name) => {
  const dir = path.join(tmp, 'beads', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(WORLD, null, 2));
  return dir;
};
const WS = { name: 'plan-ws', dir: dirFor('plan-ws') };

const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [WS] }, null, 2)
);

/* ------------------------------------------------------------------------- run */

const UNRELATED_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eplancheck-elsewhere-'));

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: UNRELATED_CWD,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir },
    input: opts.input,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const callCount = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const verbsCalled = () =>
  fs
    .readFileSync(CALLS, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).args[0]);

/* --------------------------------------------------------------------- harness */

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

console.log('\nb7e-plancheck\n');

check('--help prints usage and exits 0, without ever calling bd', () => {
  const before = callCount();
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-plancheck/);
  assert.equal(callCount(), before, 'help must not spawn bd');
});

check('a missing -w is refused before anything is resolved', () => {
  const before = callCount();
  const { status, stderr } = run(['pc-epic']);
  assert.notEqual(status, 0);
  assert.match(stderr, /workspaces: plan-ws/);
  assert.equal(callCount(), before);
});

check('a missing epic id is refused before anything is resolved', () => {
  const before = callCount();
  const { status, stderr } = run(['-w', 'plan-ws']);
  assert.notEqual(status, 0);
  assert.match(stderr, /workspaces: plan-ws/);
  assert.equal(callCount(), before);
});

check('an unconfigured workspace name is refused, naming the ones that exist', () => {
  const before = callCount();
  const { status, stderr } = run(['pc-epic', '-w', 'nope']);
  assert.notEqual(status, 0);
  assert.match(stderr, /workspaces: plan-ws/);
  assert.equal(callCount(), before);
});

check('a bead that does not exist is a clean refusal (exit 2), not a crash', () => {
  const { status, stderr } = run(['pc-zzz', '-w', 'plan-ws']);
  assert.equal(status, 2);
  assert.match(stderr, /could not read pc-zzz/);
});

check('never spawns a write verb — the stub itself would refuse one', () => {
  run(['pc-epic', '-w', 'plan-ws']);
  for (const v of verbsCalled()) assert.ok(!['comment', 'label', 'update', 'claim', 'close'].includes(v), `unexpected write verb ${v}`);
});

check('default mode prints each group with its beads, files, prs and prompt length', () => {
  const { status, stdout } = run(['pc-epic', '-w', 'plan-ws']);
  assert.equal(status, 0);
  assert.match(stdout, /grp-live — beads pc-epic\.1, pc-epic\.2 · files lib\/a\.js · prs plan-ws \(Ship the live group\) · prompt \d+\/4000/);
  assert.match(stdout, new RegExp(`prompt ${LIVE_PROMPT.length}/4000`));
  assert.match(stdout, /grp-ready — beads pc-epic\.4/);
  assert.match(stdout, new RegExp(`prompt ${READY_PROMPT.length}/4000`));
});

check('unplanned names the ready bead no group claims, and only that one', () => {
  const { stdout } = run(['pc-epic', '-w', 'plan-ws']);
  assert.match(stdout, /unplanned \(freezes the subtree until grouped\): pc-epic\.3/);
  assert.doesNotMatch(stdout, /unplanned.*pc-epic\.4/);
});

check('a group with a live (in_progress) bead is not dispatchable, and its ready sibling is plannedInto the lead', () => {
  const { stdout } = run(['pc-epic', '-w', 'plan-ws']);
  assert.match(stdout, /dispatchable now: grp-ready \(lead pc-epic\.4\)/);
  assert.doesNotMatch(stdout, /grp-live \(lead/);
});

check('nothing named by the plan is closed, so it reports what is still open rather than done', () => {
  const { stdout } = run(['pc-epic', '-w', 'plan-ws']);
  assert.match(stdout, /still open: pc-epic\.1, pc-epic\.2, pc-epic\.4/);
  assert.doesNotMatch(stdout, /^done:/m);
});

check('--json carries the same facts in a machine-readable shape', () => {
  const { status, stdout } = run(['pc-epic', '-w', 'plan-ws', '--json']);
  assert.equal(status, 0);
  const d = JSON.parse(stdout);
  assert.equal(d.epic, 'pc-epic');
  assert.equal(d.groups.length, 2);
  const live = d.groups.find((g) => g.name === 'grp-live');
  assert.equal(live.promptChars, LIVE_PROMPT.length);
  assert.equal(live.promptMax, 4000);
  assert.deepEqual(d.unplanned, ['pc-epic.3']);
  assert.deepEqual(d.dispatchable, [{ lead: 'pc-epic.4', name: 'grp-ready' }]);
  assert.equal(d.plannedInto['pc-epic.2'], 'pc-epic.1');
  assert.equal(d.done, false);
  assert.deepEqual(d.unclosed.sort(), ['pc-epic.1', 'pc-epic.2', 'pc-epic.4']);
});

check('an epic with a whole-job decision prints it, not a plan', () => {
  const { status, stdout } = run(['pc-whole', '-w', 'plan-ws']);
  assert.equal(status, 0);
  assert.match(stdout, /pc-whole is one job, no children filed/);
  assert.match(stdout, new RegExp(WHOLE_WHY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

check('an epic with neither says so plainly, and exits 0', () => {
  const { status, stdout } = run(['pc-empty', '-w', 'plan-ws']);
  assert.equal(status, 0);
  assert.match(stdout, /pc-empty has no plan and no whole-job decision on it/);
});

check('--check on a valid candidate says it would be accepted, and writes nothing', () => {
  const candidate = {
    groups: [
      {
        name: 'proposed',
        beads: ['pc-check.1'],
        prs: [{ repo: 'plan-ws', title: 'Ship it' }],
        prompt: 'Do the one thing pc-check.1 is for.',
      },
    ],
  };
  const file = path.join(tmp, 'candidate.yaml');
  fs.writeFileSync(file, `groups:\n  - name: proposed\n    beads: [pc-check.1]\n    prs:\n      - repo: plan-ws\n        title: Ship it\n    prompt: Do the one thing pc-check.1 is for.\n`);
  const { status, stdout } = run(['pc-check', '-w', 'plan-ws', '--check', file]);
  assert.equal(status, 0);
  assert.match(stdout, /would be accepted — pc-check, 1 group/);
  assert.match(stdout, /proposed — beads pc-check\.1/);
  for (const v of verbsCalled()) assert.ok(!['comment', 'label', 'update'].includes(v));
  void candidate;
});

check('--check reads from stdin when no file is given', () => {
  const yaml = 'groups:\n  - name: proposed\n    beads: [pc-check.1]\n    prs:\n      - repo: plan-ws\n        title: Ship it\n    prompt: Do the one thing pc-check.1 is for.\n';
  const { status, stdout } = run(['pc-check', '-w', 'plan-ws', '--check'], { input: yaml });
  assert.equal(status, 0);
  assert.match(stdout, /would be accepted/);
});

check('--check refuses a candidate naming a bead that is not under the epic, and exits 4', () => {
  const yaml = 'groups:\n  - name: bad\n    beads: [pc-other]\n    prs:\n      - repo: plan-ws\n        title: Nope\n    prompt: This bead does not belong to pc-check at all.\n';
  const { status, stderr } = run(['pc-check', '-w', 'plan-ws', '--check'], { input: yaml });
  assert.equal(status, 4);
  assert.match(stderr, /would be refused/);
  assert.match(stderr, /not under pc-check/);
});

check('--check refuses invalid YAML with exit 3, distinct from a validation refusal', () => {
  const { status, stderr } = run(['pc-check', '-w', 'plan-ws', '--check'], { input: '{ unterminated' });
  assert.equal(status, 3);
  assert.match(stderr, /not valid YAML/);
});

check('--check refuses a document naming neither groups nor whole, with exit 3', () => {
  const { status, stderr } = run(['pc-check', '-w', 'plan-ws', '--check'], { input: 'foo: bar\n' });
  assert.equal(status, 3);
  assert.match(stderr, /no groups in that input/);
});

check('--check accepts a whole-job candidate on a childless epic', () => {
  const { status, stdout } = run(['pc-empty', '-w', 'plan-ws', '--check'], { input: `whole:\n  why: |\n    ${WHOLE_WHY}\n` });
  assert.equal(status, 0);
  assert.match(stdout, /would be accepted — pc-empty is one job/);
});

check('--check refuses a whole-job candidate on an epic that already has children', () => {
  const { status, stderr } = run(['pc-check', '-w', 'plan-ws', '--check'], { input: `whole:\n  why: |\n    ${WHOLE_WHY}\n` });
  assert.equal(status, 4);
  assert.match(stderr, /already has 1 child/);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
