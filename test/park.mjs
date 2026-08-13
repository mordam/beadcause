#!/usr/bin/env node
/**
 * Parking work behind a question, when the work is an epic.
 *
 *     npm test
 *     node test/park.mjs
 *
 * bc-p9vx, and the bug is worth stating precisely because the obvious fix is the wrong
 * one. `bd dep add <an epic> <a task>` is refused — bd will only let an epic be blocked
 * by another epic — and all three commands that park work behind a question create the
 * question *first*. So `beadcause-ask -t '…' --blocks <a P0 epic>` filed the question,
 * labelled it `human`, put it on Adam's phone, and *then* died with a raw Node stack
 * trace: the caller was told the command had failed while the question existed, so a
 * session that believed it asked nothing and a session that retried asked twice. And
 * the epic it was supposed to park went on being `bd ready`, so the next advocate tick
 * opened a window on work that was explicitly waiting for an answer.
 *
 * The fix is not a nicer error. It is to type the question after the bead it is going
 * to park, so the edge bd was refusing goes in and the work genuinely un-parks when the
 * answer lands. That is what most of this file asserts, and it asserts it end to end
 * for the two commands a session actually runs — the question's *type* is the whole
 * mechanism, and a unit test of `questionType` alone would pass just as happily against
 * a `bin/ask.js` that still hardcodes `--type task`.
 *
 * The three properties, in the order they were broken:
 *
 * 1. **An epic is parked.** `--blocks <epic>` types the question `epic` and the edge is
 *    there afterwards. This is the regression.
 * 2. **Nothing exists that the caller was told did not.** A bad `--blocks` id is
 *    refused *before* the create, and once the question exists the command prints its
 *    id and exits 0 whatever the parking did — with the reason on stderr, in one plain
 *    sentence, never a stack trace.
 * 3. **A failed park still takes the bead out of the queue.** `human` on the work bead
 *    is what a session had to do by hand; it is honest and it is not the same thing, so
 *    the sentence says the label does not come off when the answer lands.
 *
 * `bin/deliver.js` parks the same way and is not driven here — it needs a git remote and
 * a GitHub pull request to reach the line. It takes the type off the bead row it has
 * already fetched and passes `label: false`, both of which are covered as units below.
 *
 * The real `bd` is never run: the stub is a tracker in a JSON file that enforces bd's
 * epic rule, so what is under test is the argv these commands build. `HOME` points into
 * the temp tree so `discoverWorkspaces` finds no `~/beads` to reconcile onto stdout,
 * which is the stream the ids come back on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-park-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { bdSaid, beadRow, beadType, park, questionType, HUMAN_LABEL } = await import(path.join(ROOT, 'lib', 'park.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, and a `bd` that reads and writes it.
 *
 * The one rule that has to be implemented exactly is `dep add`'s, because it is the
 * rule the bug is made of, and it is copied off the real binary rather than guessed:
 * measured against bd on 2026-08-11, epic→epic is accepted, epic→task is
 * `epics can only block other epics, not tasks`, task→epic is the same sentence with
 * the nouns swapped, and every other pair — bug→task, feature→task, chore→decision —
 * goes in. So the rule is epic-ness matching and nothing else.
 *
 * `LOCKED` is the second way an edge fails, and the reason `park` still has a fallback
 * now that types are handled: embedded Dolt is single-writer, and around twenty agent
 * sessions share these workspaces.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
const all = () => Object.values(w.issues);
const one = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (args[0] === 'create') {
  const id = 'zz-n' + (Object.keys(w.issues).length + 1);
  w.issues[id] = {
    id,
    title: one('--title', ''),
    description: one('--description', ''),
    status: 'open',
    issue_type: one('--type', 'task'),
    priority: Number(one('--priority', '1')),
    labels: many('--label'),
    dependencies: [],
  };
  save();
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found matching "' + args[1] + '"');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'add') {
  const blocked = w.issues[args[2]];
  const blocker = w.issues[args[3]];
  if (!blocked || !blocker) die('Error: no issue found matching "' + (blocked ? args[3] : args[2]) + '"');
  // The one bd rule this whole suite is about, and the second way an edge fails.
  if (w.locked) die('Error: database is locked');
  const epic = (i) => i.issue_type === 'epic';
  if (epic(blocked) && !epic(blocker)) die('Error: epics can only block other epics, not tasks');
  if (!epic(blocked) && epic(blocker)) die('Error: tasks can only block other tasks, not epics');
  blocked.dependencies = [...(blocked.dependencies || []), { id: blocker.id, dependency_type: 'blocks', status: blocker.status }];
  save();
  process.stdout.write('ok\\n');
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'add') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  if (w.labelsBroken) die('Error: database is locked');
  issue.labels = [...new Set([...(issue.labels || []), args[3]])];
  save();
  process.stdout.write('ok\\n');
  process.exit(0);
}
if (args[0] === 'list') {
  process.stdout.write(JSON.stringify(all().filter((i) => i.status !== 'closed')));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/** The stub, called the way the three commands call the real one: argv in, stdout out. */
const runBd = (args) => {
  const res = spawnSync(FAKE_BD, args, { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr || `bd exited ${res.status}`);
  return res.stdout;
};

const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  dependencies: [],
  ...extra,
});

/** A task to park, an epic to park, and the epic is the one that used to fail. */
const reset = (extra = {}) => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        ...extra,
        issues: {
          'zz-task': issue('zz-task', { title: 'An ordinary bead a session is working' }),
          'zz-epic': issue('zz-epic', {
            title: 'Beadcause for a scrum squad — federate the engineers',
            issue_type: 'epic',
            priority: 0,
          }),
        },
      },
      null,
      2
    )
  );
};
reset();

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const bead = (id) => world().issues[id];
const blockers = (id) => (bead(id)?.dependencies || []).map((d) => d.id);
const created = () => Object.values(world().issues).filter((i) => /^zz-n/.test(i.id));

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }] }, null, 2)
);

/** `bin/ask.js`, run the way the brief tells a worker to run it: body on stdin, id on stdout. */
const run = (script, args, input = 'Which of these two did you mean?\n') => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', script), ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: (res.stdout || '').trim(), stderr: res.stderr || '' };
};
const ask = (args, input) => run('ask.js', ['-w', 'demo', '-t', 'Gross or net?', ...args], input);
const propose = (args) =>
  run(
    'propose.js',
    ['-w', 'demo', ...args],
    '- title: Two things disagree\n  type: task\n  priority: 2\n  description: |\n    Which way?\n'
  );

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

console.log('\nparking work behind a question, when the work is an epic\n');

/* ------------------------------------------------------------------ the rule itself */

await check('a question is typed epic for an epic and task for everything else', () => {
  assert.equal(questionType('epic'), 'epic');
  assert.equal(questionType('EPIC'), 'epic', 'and bd is not asked to be consistent about case');
  for (const t of ['task', 'bug', 'feature', 'chore', 'decision']) assert.equal(questionType(t), 'task');
  assert.equal(questionType(null), 'task', 'a bead we could not read is asked about as a task — the old behaviour');
  assert.equal(questionType(undefined), 'task');
});

await check('a bead is read off bd, and a missing one is null rather than a throw', () => {
  reset();
  assert.equal(beadType(runBd, 'zz-epic'), 'epic');
  assert.equal(beadType(runBd, 'zz-task'), 'task');
  assert.equal(beadRow(runBd, 'zz-task')?.title, 'An ordinary bead a session is working');
  assert.equal(beadRow(runBd, 'zz-nope'), null, 'and that is what refuses the command, before anything is created');
  assert.equal(beadType(runBd, 'zz-nope'), null);
  assert.equal(beadRow(runBd, ''), null, 'no id is not a lookup');
});

/* ------------------------------------------------------- beadcause-ask, end to end */

await check('--blocks an epic parks the epic — the bug', () => {
  reset();
  const res = ask(['--blocks', 'zz-epic']);
  assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`);
  const id = res.stdout;
  assert.match(id, /^zz-n/, 'the id is still what comes back on stdout');
  assert.equal(bead(id).issue_type, 'epic', 'the question is typed to match the bead it has to block');
  assert.deepEqual(bead(id).labels, ['human'], 'and is otherwise an ordinary question');
  assert.deepEqual(blockers('zz-epic'), [id], 'the epic is parked behind it');
  assert.equal(res.stderr, '', 'and nothing was reported, because nothing went wrong');
});

await check('--blocks an ordinary bead is unchanged — the question is still a task', () => {
  reset();
  const res = ask(['--blocks', 'zz-task']);
  assert.equal(res.status, 0);
  assert.equal(bead(res.stdout).issue_type, 'task');
  assert.deepEqual(blockers('zz-task'), [res.stdout]);
});

await check('asking without --blocks parks nothing and stays a task', () => {
  reset();
  const res = ask([]);
  assert.equal(res.status, 0);
  assert.equal(bead(res.stdout).issue_type, 'task');
  assert.deepEqual(blockers('zz-epic'), []);
  assert.deepEqual(blockers('zz-task'), []);
});

await check('a --blocks id that is not in the workspace asks nothing at all', () => {
  reset();
  const res = ask(['--blocks', 'zz-nope']);
  assert.equal(res.status, 1, 'refused — and it can refuse, because nothing has been created yet');
  assert.equal(created().length, 0, 'no question on the phone about a bead that does not exist');
  assert.match(res.stderr, /no bead zz-nope in demo/);
  assert.doesNotMatch(res.stderr, /^\s+at /m, 'and a session is not handed a stack trace');
});

await check('an edge bd refuses for any other reason still leaves a question, not an error', () => {
  reset({ locked: true });
  const res = ask(['--blocks', 'zz-epic']);
  assert.equal(res.status, 0, 'the question exists, so the caller must not be told this failed');
  const id = res.stdout;
  assert.match(id, /^zz-n/, 'and must be told which question it is, or it will ask twice');
  assert.deepEqual(blockers('zz-epic'), [], 'the edge genuinely did not go in');
  assert.match(res.stderr, /database is locked/, 'bd’s own reason reaches the session — it always did');

  // One sentence of ours, and only one. bd's line is the one above it: nothing here
  // pipes the child's stderr, so what bd printed went straight to this stream.
  const ours = res.stderr.split('\n').filter((l) => l.startsWith('beadcause-ask:'));
  assert.equal(ours.length, 1, `one sentence, not ${ours.length}: ${JSON.stringify(res.stderr)}`);
  assert.match(ours[0], /could not park zz-epic behind it/);
  assert.doesNotMatch(ours[0], /Command failed/, 'and not node’s placeholder for it, which names a path and no reason');
  assert.doesNotMatch(res.stderr, /^\s+at /m, 'never a stack trace');
  assert.deepEqual(bead('zz-epic').labels, [HUMAN_LABEL], 'and the work is out of the queue by hand instead');
  assert.match(ours[0], /does\s+NOT come off when you answer/, 'which is not the same thing, and says so');
});

await check('and when even the label will not go on, it says what to run', () => {
  reset({ locked: true, labelsBroken: true });
  const res = ask(['--blocks', 'zz-epic']);
  assert.equal(res.status, 0);
  assert.deepEqual(bead('zz-epic').labels, []);
  assert.match(res.stderr, /bd label add zz-epic human/);
  assert.doesNotMatch(res.stderr, /^\s+at /m);
});

/* --------------------------------------------------- beadcause-propose, end to end */

await check('a conflict on an epic parks the epic too', () => {
  reset();
  const res = propose(['--from', 'zz-epic', '--kind', 'conflict']);
  assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`);
  const id = res.stdout.split('\n').pop();
  assert.equal(bead(id).issue_type, 'epic');
  assert.deepEqual(blockers('zz-epic'), [id], 'the session is stopped, so the epic must not stay ready');
});

await check('a discovery parks nothing, and is an ordinary task whatever it was found under', () => {
  reset();
  const res = propose(['--from', 'zz-epic', '--kind', 'discovery']);
  assert.equal(res.status, 0);
  assert.equal(bead(res.stdout.split('\n').pop()).issue_type, 'task');
  assert.deepEqual(blockers('zz-epic'), [], 'the work that found it carries on');
});

/* ------------------------------------------------- park(), without a command around it */

await check('the reason quoted is bd’s, and never node’s placeholder for it', () => {
  assert.equal(bdSaid({ stderr: 'Error: epics can only block other epics, not tasks\n' }), 'Error: epics can only block other epics, not tasks');
  assert.equal(bdSaid({ stdout: 'Error: locked' }), 'Error: locked', 'wherever bd chose to print it');
  assert.equal(
    bdSaid(new Error('Command failed: /opt/homebrew/bin/bd dep add bc-y3qk bc-uccd')),
    'bd refused it, and said why on the line above',
    'an unpiped stderr means the reason is already on screen — do not bury it under an argv'
  );
  assert.equal(bdSaid(new Error('something else entirely')), 'something else entirely');
});

await check('park reports rather than throws, and never on the happy path', () => {
  const calls = [];
  const ok = (args) => {
    calls.push(args.join(' '));
    return 'ok';
  };
  assert.deepEqual(park(ok, 'a', 'b'), { parked: true, labelled: false, note: '' });
  assert.deepEqual(calls, ['dep add a b'], 'and adds exactly one edge, in bd’s argument order');
});

await check('park falls back to the label, unless the caller says not to', () => {
  const calls = [];
  const refuse = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'dep') throw new Error('Error: epics can only block other epics, not tasks\n    at Object.<anonymous>');
    return 'ok';
  };

  const fell = park(refuse, 'zz-epic', 'zz-q');
  assert.equal(fell.parked, false);
  assert.equal(fell.labelled, true);
  assert.deepEqual(calls, ['dep add zz-epic zz-q', 'label add zz-epic human']);
  assert.doesNotMatch(fell.note, /\bat Object\b/, 'only bd’s first line survives into the sentence');
  assert.match(fell.note, /^filed zz-q, but could not park zz-epic/, 'the question that exists is named first');
  assert.match(fell.note, /epics can only block other epics/, 'and bd’s words are quoted when there are any');

  calls.length = 0;
  const quiet = park(refuse, 'zz-epic', 'zz-q', { label: false });
  assert.equal(quiet.labelled, false);
  assert.deepEqual(calls, ['dep add zz-epic zz-q'], 'bin/deliver.js closes its bead on the merge — no label');
  assert.match(quiet.note, /could not park zz-epic behind it/);
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `all ${ran} checks passed`}`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
