#!/usr/bin/env node
/**
 * `beadcause-epicplan` — the door an Epic Advocate can walk through without a `node`
 * grant. bin/beadcause-epicplan and bin/plan.js.
 *
 *     npm test
 *     node test/epicplanwrite.mjs
 *
 * bc-jvt0.6. `bin/beadcause-epicplan` decides nothing of its own — it spawns
 * `node bin/plan.js` with its own argv and stdin, unchanged, and exits with whatever that
 * exits with. So this suite is not a second copy of test/wholejob.mjs's cases; it is proof
 * that the wrapper actually *is* transparent: a valid decision reaches the tracker the same
 * way running `bin/plan.js` directly would, a refused one is refused with the same exit
 * code and writes nothing, and the flags/stdin bin/plan.js reads (`-w`, `-b`, stdin YAML)
 * all survive the extra hop. The world/fake-`bd` fixture is test/wholejob.mjs's, reused
 * rather than re-invented, because a divergent fake here would only prove this wrapper
 * agrees with itself.
 *
 * No `bd` binary, no tracker, no network, nothing written outside a temp directory.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-epicplan-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { MIN_WHY_CHARS, WHOLE_LABEL, PLANNED_LABEL, wholeFrom } = await import(LIB('plan.js'));

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nbeadcause-epicplan — the wrapper an Epic Advocate can actually run\n');

const WHY =
  'The description names both files and the check, and the change is one edit to each — ' +
  'splitting it would file beads so that two windows could each hold one.';

/* --------------------------------------------------------- the same fake bd as plan */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const WORLD = ${JSON.stringify(WORLD)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const die = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'list' && args[1] === '--parent') {
  process.stdout.write(JSON.stringify(w.kids[args[2]] || []));
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (issue.comments = issue.comments || []).push(args[2]);
  save();
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'add') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.labels = [...(issue.labels || []), args[3]];
  save();
  process.exit(0);
}
if (args[0] === 'export') {
  const rows = Object.keys(w.issues).map((id) => ({ id, title: id, status: 'open', issue_type: 'task', dependencies: [] }));
  process.stdout.write(rows.map((r) => JSON.stringify(r)).join('\\n'));
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (flag('--status')) issue.status = flag('--status');
  issue.assignee = flag('--assignee') || '';
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const WS_DIR = path.join(tmp, 'beads', 'alpha', '.beads');
fs.mkdirSync(WS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify({ projectRoot: path.join(tmp, 'projects'), bdBin: FAKE_BD, workspaces: [{ name: 'alpha', dir: WS_DIR }] })
);

const resetWorld = () =>
  fs.writeFileSync(
    WORLD,
    JSON.stringify({
      issues: { 'zz-1': { id: 'zz-1', title: 'an epic', status: 'in_progress', issue_type: 'epic', labels: [], assignee: 'adam' } },
      kids: {},
    })
  );

/** Run bin/beadcause-epicplan with YAML on stdin, exactly as the Epic Advocate would. Never throws. */
function epicPlan(yaml, argv = ['-w', 'alpha', '-b', 'zz-1']) {
  resetWorld();
  fs.writeFileSync(BD_LOG, '');
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'beadcause-epicplan'), ...argv], {
      input: yaml,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    return { code: 0, out, err: '', world: JSON.parse(fs.readFileSync(WORLD, 'utf8')) };
  } catch (err) {
    return {
      code: err.status,
      out: String(err.stdout || ''),
      err: String(err.stderr || ''),
      world: JSON.parse(fs.readFileSync(WORLD, 'utf8')),
    };
  }
}

/* -------------------------------------------------------------------- the cases */

check('A VALID WHOLE-JOB DECISION REACHES THE TRACKER THROUGH THE WRAPPER', () => {
  const r = epicPlan(`whole:\n  why: |\n    ${WHY}\n`);
  assert.equal(r.code, 0, `exited ${r.code}: ${r.err}`);
  assert.match(r.out, /decided zz-1 — one job/, `stdout was not forwarded: ${r.out}`);
  const epic = r.world.issues['zz-1'];
  assert.ok(epic.labels.includes(WHOLE_LABEL), 'the label never landed — the wrapper did not really call plan.js');
  assert.ok(!epic.labels.includes(PLANNED_LABEL));
  assert.ok(wholeFrom([{ text: epic.comments[0] }]), 'the comment does not parse back as a decision');
  assert.equal(epic.status, 'open', 'the handback did not happen through the wrapper');
});

check('A REFUSED DECISION WRITES NOTHING, THROUGH THE WRAPPER EITHER', () => {
  const r = epicPlan('whole:\n  why: too short\n');
  assert.equal(r.code, 4, `expected plan.js's own refusal code, got ${r.code}`);
  assert.match(r.err, new RegExp(`floor is ${MIN_WHY_CHARS}`), `plan.js's stderr was not forwarded: ${r.err}`);
  assert.deepEqual(r.world.issues['zz-1'].comments ?? [], [], 'a refused decision was written anyway');
  assert.deepEqual(r.world.issues['zz-1'].labels, []);
});

check('NEITHER ANSWER IS STILL A REFUSAL, NAMING BOTH — plan.js\'s own usage, not a copy', () => {
  const r = epicPlan('epic: zz-1\n');
  assert.equal(r.code, 3);
  assert.match(r.err, /`groups:` list, or `whole:`/);
});

check('THE FLAGS SURVIVE THE HOP — a wrong workspace is plan.js\'s own refusal, not silence', () => {
  const r = epicPlan(`whole:\n  why: |\n    ${WHY}\n`, ['-w', 'nowhere', '-b', 'zz-1']);
  assert.equal(r.code, 1, `expected plan.js's usage-error exit, got ${r.code}`);
  assert.match(r.err, /usage: beadcause-plan/, `argv was not actually forwarded: ${r.err}`);
});

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
