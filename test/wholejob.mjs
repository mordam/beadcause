#!/usr/bin/env node
/**
 * "This epic is one job" — the second answer, and the door both answers go through.
 *
 *     npm test
 *     node test/wholejob.mjs
 *
 * bc-jvt0.4. A childless epic had two rules pointed at it that gave opposite answers. The
 * Epic Advocate's brief said *"planning it is the whole job this time"* — decompose it,
 * whatever it says — and `heldByChildren` in lib/advocate.js deliberately left a leaf epic
 * workable, so the queue dispatched it as an ordinary ready bead on the first tick it saw
 * it. Whichever got there first decided, and on every tick that is the queue: the one agent
 * that had read the bead answered a question already settled.
 *
 * Adam's decision (2026-08-21) is that the advocate judges and **the default is to do the
 * work.** Which makes the missing fact not "is this planned" — a plan is groups, and an
 * epic that is one job has none — but "has anybody decided yet". Three suites hold the
 * three halves of that, and this is the document half:
 *
 *   - **the brief** — test/epicadvocate.mjs, one case per answer.
 *   - **the hold** — test/epicqueue.mjs, `heldByChildren` check 4.
 *   - **the document and its door** — here: what `validateWhole` refuses, what a comment
 *     carries, and what `bin/plan.js` actually writes when it takes the second answer.
 *
 * The last of those is driven for real, against a fake `bd` on disk, rather than asserted
 * as source. The reason is that the three writes are the whole feature and their *order* is
 * load-bearing — comment, then label, then hand the epic back — and a source assertion that
 * three calls appear in a file cannot tell you that a refusal halfway through leaves a
 * recoverable state rather than a label with nothing behind it. The fake logs every argv,
 * which is also what makes the negative assertions possible: no `bd create` (a whole-job
 * decision files nothing) and no `planned` label (that one belongs to the other answer).
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-wholejob-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  MAX_WHY_CHARS,
  MIN_WHY_CHARS,
  PLANNED_LABEL,
  WHOLE_CLOSE,
  WHOLE_LABEL,
  WHOLE_OPEN,
  formatWhole,
  isWholeJob,
  parseWhole,
  validateWhole,
  wholeFrom,
} = await import(LIB('plan.js'));

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

console.log('\na childless epic that is one job\n');

const WHY =
  'The description names both files and the check, and the change is one edit to each — ' +
  'splitting it would file beads so that two windows could each hold one.';

/* --------------------------------------------------------------- the document */

check('the label is one string and reads off the row the queue already has', () => {
  assert.equal(WHOLE_LABEL, 'whole-job');
  assert.notEqual(WHOLE_LABEL, PLANNED_LABEL, 'one label for two opposite answers');
  assert.ok(isWholeJob({ labels: ['owner:adam', WHOLE_LABEL] }));
  assert.ok(!isWholeJob({ labels: [PLANNED_LABEL] }), '`planned` is a group plan and means the other thing');
  assert.ok(!isWholeJob({}), 'a row with no labels at all must answer, not throw');
});

check('a decision survives the round trip through a comment', () => {
  const whole = validateWhole({ whole: { why: WHY } }, { epic: 'zz-1', children: [] });
  assert.deepEqual(whole, { epic: 'zz-1', whole: true, why: WHY });
  const body = formatWhole(whole);
  assert.match(body, /\*\*zz-1 is one job\*\*/, 'the human half does not say what was decided');
  assert.ok(body.includes(WHY), 'the reason is not in the part a person reads');
  assert.deepEqual(wholeFrom([{ text: body }]), whole);
});

check('and the LAST one wins, because a revisited epic writes a second', () => {
  const first = formatWhole(validateWhole({ whole: { why: WHY } }, { epic: 'zz-1' }));
  const second = formatWhole(validateWhole({ whole: { why: `${WHY} On a second look, still true.` } }, { epic: 'zz-1' }));
  assert.match(wholeFrom([{ text: first }, { body: second }]).why, /second look/, 'the first revision is the decision');
});

check('a hand-edited block cannot stop a tick — it reads as no decision', () => {
  assert.equal(parseWhole(`${WHOLE_OPEN}\n{oops\n${WHOLE_CLOSE}`), null, 'unparseable JSON throws instead of returning null');
  assert.equal(parseWhole(''), null);
  assert.equal(parseWhole(`${WHOLE_OPEN}\n${WHOLE_CLOSE}`), null);
  // A plan is not a decision, and the two markers must not be confusable: `planFrom` and
  // `wholeFrom` walk the same comment thread.
  assert.equal(parseWhole('<!-- beadcause:plan -->\n```json\n{"groups":[]}\n```\n'), null);
  // And a block that says something other than `whole: true` is not this document either.
  assert.equal(parseWhole(`${WHOLE_OPEN}\n{"epic":"zz-1","whole":false}\n${WHOLE_CLOSE}`), null);
});

/* -------------------------------------------------------------- the refusals */

const refused = (name, arg, opts, pattern) =>
  check(name, () => {
    assert.throws(() => validateWhole(arg, opts), pattern);
  });

refused(
  'AN EPIC WITH CHILDREN CANNOT BE ONE JOB — that is the opposite answer, already given',
  { whole: { why: WHY } },
  { epic: 'zz-1', children: [{ id: 'zz-1.1' }] },
  /already has 1 child bead\(s\) \(zz-1\.1\)/
);
refused(
  'and a closed child still counts, because the judgement is in the graph either way',
  { whole: { why: WHY } },
  { epic: 'zz-1', children: [{ id: 'zz-1.1', status: 'closed' }] },
  /its children are the work/
);
refused(
  'THE REASON IS THE DECISION, so there has to be one',
  { whole: {} },
  { epic: 'zz-1', children: [] },
  /has to say why/
);
refused(
  'AND ENOUGH OF ONE — the only prose floor in the repo, and this is why it exists',
  { whole: { why: 'it is simple' } },
  { epic: 'zz-1', children: [] },
  new RegExp(`the floor is ${MIN_WHY_CHARS}`)
);
refused(
  'a paragraph is not a card, so there is a ceiling too',
  { whole: { why: 'x'.repeat(MAX_WHY_CHARS + 1) } },
  { epic: 'zz-1', children: [] },
  new RegExp(`${MAX_WHY_CHARS} is the most`)
);
refused(
  'IT MAY NOT WRITE THE BRIEF, exactly as a group prompt may not',
  { whole: { why: `${WHY} Then run bin/deliver.js.` } },
  { epic: 'zz-1', children: [] },
  /belongs to the brief/
);
refused('and it has to say which epic it is for', { whole: { why: WHY } }, {}, /which epic/);
refused('a decision that is not a mapping is not a decision', 'whole', { epic: 'zz-1' }, /not a decision/);

check('the reason may be the value itself, because that is how a person would write it', () => {
  assert.equal(validateWhole({ whole: WHY }, { epic: 'zz-1' }).why, WHY);
  assert.equal(validateWhole({ whole: { reason: WHY } }, { epic: 'zz-1' }).why, WHY, '`reason:` is not accepted');
});

/* ------------------------------------------------------------------ the door */

/**
 * A `bd` that answers the five calls bin/plan.js makes and logs every argv it is given.
 *
 * Small on purpose — test/approval.mjs's fake is the model and most of it is about beads
 * this path never touches. What it has to be honest about is `list --parent`, because the
 * children read is what one of the two refusals is decided on, and *whether a call happened
 * at all*, which is what the log is for.
 */
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
  if (w.refuseLabel) die('bd: label add refused');
  issue.labels = [...(issue.labels || []), args[3]];
  save();
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

// The directory has to exist: `loadConfig` drops a workspace whose `.beads` is gone, and
// the drop is silent enough from here that every case below would fail on "no workspaces".
const WS_DIR = path.join(tmp, 'beads', 'alpha', '.beads');
fs.mkdirSync(WS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify({ projectRoot: path.join(tmp, 'projects'), bdBin: FAKE_BD, workspaces: [{ name: 'alpha', dir: WS_DIR }] })
);

const bdCalls = () =>
  fs
    .readFileSync(BD_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** Run the real bin/plan.js with YAML on stdin. Never throws — the exit code is the answer. */
function plan(yaml, { kids = {} } = {}) {
  fs.writeFileSync(
    WORLD,
    JSON.stringify({
      issues: { 'zz-1': { id: 'zz-1', title: 'an epic', status: 'in_progress', issue_type: 'epic', labels: [], assignee: 'adam' } },
      kids,
    })
  );
  fs.writeFileSync(BD_LOG, '');
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'plan.js'), '-w', 'alpha', '-b', 'zz-1'], {
      input: yaml,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    return { code: 0, out, err: '', world: JSON.parse(fs.readFileSync(WORLD, 'utf8')), calls: bdCalls() };
  } catch (err) {
    return {
      code: err.status,
      out: String(err.stdout || ''),
      err: String(err.stderr || ''),
      world: JSON.parse(fs.readFileSync(WORLD, 'utf8')),
      calls: bdCalls(),
    };
  }
}

check('THE SECOND MODE WRITES THE COMMENT, THE LABEL AND THE HANDBACK — in that order', () => {
  const r = plan(`whole:\n  why: |\n    ${WHY}\n`);
  assert.equal(r.code, 0, `exited ${r.code}: ${r.err}`);
  assert.match(r.out, /decided zz-1 — one job/, `stdout was: ${r.out}`);

  const epic = r.world.issues['zz-1'];
  assert.equal(epic.comments.length, 1, 'the decision is not on the bead');
  assert.ok(epic.comments[0].includes(WHOLE_OPEN), 'the comment carries no machine-readable block');
  assert.ok(wholeFrom([{ text: epic.comments[0] }]), 'what it wrote does not parse back as a decision');
  assert.ok(epic.labels.includes(WHOLE_LABEL), 'the label the queue reads was not written');
  assert.ok(!epic.labels.includes(PLANNED_LABEL), 'it wrote the other answer’s label as well');
  // The handback: the planning window claimed the epic, and a claimed epic is out of
  // `bd ready`, so without this the decision is one nothing can act on.
  assert.equal(epic.status, 'open');
  assert.equal(epic.assignee, '', 'the claim is still on, so the epic cannot be dispatched');

  const verbs = r.calls.map((c) => c.slice(0, 2).join(' '));
  assert.deepEqual(
    verbs.filter((v) => v.startsWith('comment') || v.startsWith('label') || v.startsWith('update')),
    ['comment zz-1', 'label add', 'update zz-1'],
    `the three writes are out of order: ${JSON.stringify(verbs)}`
  );
  assert.ok(!r.calls.some((c) => c[0] === 'create'), 'a whole-job decision filed a bead');
});

check('a refused label still leaves the decision on the bead, and says how to finish by hand', () => {
  // The one inconsistent state this can leave, and it is the recoverable direction: the
  // comment is the document, so a label that would not go on is a warning and not a
  // rollback. Asserted because the alternative — exiting non-zero — would send a session
  // back to rewrite a decision that is already written.
  const r = plan(`whole:\n  why: |\n    ${WHY}\n`);
  assert.equal(r.code, 0);
  const world = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
  world.refuseLabel = true;
  world.issues['zz-1'].labels = [];
  world.issues['zz-1'].comments = [];
  fs.writeFileSync(WORLD, JSON.stringify(world));
  const again = execFileSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'plan.js'), '-w', 'alpha', '-b', 'zz-1'],
    { input: `whole:\n  why: |\n    ${WHY}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  assert.match(again, /decided zz-1/, 'a refused label lost the decision');
  const after = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
  assert.equal(after.issues['zz-1'].comments.length, 1, 'the comment did not survive the label refusal');
});

check('BOTH ANSWERS IN ONE DOCUMENT IS REFUSED, not resolved', () => {
  const r = plan(`whole:\n  why: |\n    ${WHY}\ngroups:\n  - name: a\n    beads: [zz-1.1]\n    prs: [{repo: alpha, title: t}]\n    prompt: do it\n`);
  assert.equal(r.code, 3);
  assert.match(r.err, /opposite answers/);
  assert.deepEqual(r.world.issues['zz-1'].labels, [], 'it wrote something before refusing');
});

check('and neither answer is still the refusal it always was, now naming both', () => {
  const r = plan('epic: zz-1\n');
  assert.equal(r.code, 3);
  assert.match(r.err, /`groups:` list, or `whole:`/);
});

check('AN ILLEGAL DECISION WRITES NOTHING — the refusal comes back to the session that can fix it', () => {
  const r = plan('whole:\n  why: too short\n');
  assert.equal(r.code, 4);
  assert.match(r.err, new RegExp(`floor is ${MIN_WHY_CHARS}`));
  assert.deepEqual(r.world.issues['zz-1'].comments ?? [], [], 'a refused decision was written anyway');
  assert.deepEqual(r.world.issues['zz-1'].labels, []);
});

check('and so does one on an epic that already has children', () => {
  const r = plan(`whole:\n  why: |\n    ${WHY}\n`, { kids: { 'zz-1': [{ id: 'zz-1.1', title: 'a child', status: 'open' }] } });
  assert.equal(r.code, 4);
  assert.match(r.err, /already has 1 child bead/);
  assert.deepEqual(r.world.issues['zz-1'].labels, []);
});

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
