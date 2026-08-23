#!/usr/bin/env node
/**
 * Which held beads somebody has an open question about — the join, on its own.
 *
 *     npm test
 *     node test/openquestion.mjs
 *
 * test/endorsequeue.mjs drives this through the whole sweep against a stub `bd`, which is
 * the assertion that matters: the row that reaches a phone carries the question. What that
 * cannot reach cheaply is the *join itself*, which is where every way this can be wrong
 * lives — and each of them is silent. A question read too loosely flags beads nobody asked
 * about, and a row that cries wolf is a row you learn to scroll past, which costs the
 * feature everything. A question read too tightly draws nothing, which is precisely the
 * state bc-xl7n.76.2 was filed about, and is indistinguishable from "nobody has asked".
 *
 * What is asserted here, and why each is a real way to get it wrong:
 *
 * 1. **A dotted child id never collapses to its parent.** `bc-xl7n.101` must not read as
 *    `bc-xl7n`. lib/beadref.js has this bug twice in its history — once labelling seven P0
 *    epics `shipped` because one child of each had merged — and it is the same regex either
 *    way.
 * 2. **Every field a person could have written the id in** — the title, the description, the
 *    notes (which is where `bd update --append-notes` puts a decision block), the design and
 *    the acceptance criteria. Reading only the description would miss the one shape the
 *    advocate console actually produces.
 * 3. **A question that names only itself is not about anything else.** A held bead can carry
 *    `human`, which puts it in both lists at once.
 * 4. **A `human` epic is a board card, not a question.** Measured against the live tracker:
 *    four of seventeen open `human` beads were epics, and those four produced *every* false
 *    positive, because an epic's notes are an advocate's running log naming every bead it
 *    has touched. One line of exclusion took the same measurement from four flags to one
 *    true one.
 * 5. **Loudest first, and bounded.** A row is a row.
 * 6. **A workspace that could not be read leaves `null`, never `[]`.** `[]` is the sentence
 *    *nobody has asked about this bead*, and saying it over a `bd` call that never came back
 *    is exactly the failure this file exists to end.
 * 7. **Only the workspaces with rows in the queue are read at all.** Seven repos and three
 *    held beads in one of them is one `bd human list`, not seven.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-openquestion-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { addOpenQuestions, idsIn, namesIn, toQuestionRef, QUESTIONS_PER_ROW } = await import(LIB('openquestion.js'));
const cache = await import(LIB('cache.js'));

const ALPHA = { name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') };
const BETA = { name: 'beta', dir: path.join(tmp, 'beta', '.beads') };

/** A row as `toRow` in lib/endorsequeue.js hands it over — only the three fields read here. */
const row = (workspace, id) => ({ key: `${workspace}/${id}`, workspace, id, questions: null });

/** One open `human` bead. */
const ask = (id, extra = {}) => ({ id, title: `About something`, priority: 2, ...extra });

/**
 * A `bd` that answers `listHuman` out of a plain object, and counts how often it was asked.
 *
 * The count is an assertion in its own right (6 above): this join is one call per workspace
 * *with rows*, and a version of it that swept every configured workspace would pass every
 * other check in this file while costing a seven-repo install four wasted spawns a sweep.
 */
function fakeBd(byWorkspace) {
  const calls = [];
  return {
    calls,
    async listHuman(ws) {
      calls.push(ws.name);
      const answer = byWorkspace[ws.name];
      if (answer === 'broken') throw new Error('dolt: could not read');
      return answer || [];
    },
  };
}

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

console.log('\nthe open question on an endorse row\n');

/* ------------------------------------------------------------- reading the prose */

await check('a dotted child id comes out whole, so it can never be read as its parent', () => {
  assert.deepEqual(idsIn('close bc-xl7n.101 instead'), ['bc-xl7n.101']);
  assert.deepEqual(idsIn('bc-rfnr.9.3 nests, and so does the suffix'), ['bc-rfnr.9.3']);
  assert.ok(
    !idsIn('close bc-xl7n.101 instead').includes('bc-xl7n'),
    'this exact truncation labelled seven P0 epics shipped once — see lib/beadref.js'
  );
});

await check('and a bare id is still a bare id, sentence-final full stop and all', () => {
  assert.deepEqual(idsIn('It is bc-wi3s.'), ['bc-wi3s'], 'a full stop is punctuation, not a child suffix');
  assert.deepEqual(idsIn('BC-WI3S'), ['bc-wi3s'], 'lower-cased, because the join is on ids and ids are lower case');
});

await check('every field a person could have written the id in is read', () => {
  assert.ok(namesIn({ title: 'close bc-a1' }).has('bc-a1'), 'title');
  assert.ok(namesIn({ description: 'about bc-a2' }).has('bc-a2'), 'description');
  assert.ok(
    namesIn({ notes: '```decision\nquestion: close bc-a3?\n```' }).has('bc-a3'),
    'notes — where `bd update --append-notes` puts a decision block, which is the shape an advocate writes'
  );
  assert.ok(namesIn({ design: 'bc-a4' }).has('bc-a4'), 'design');
  assert.ok(namesIn({ acceptance_criteria: 'bc-a5 is closed' }).has('bc-a5'), 'acceptance');
  assert.equal(namesIn({}).size, 0);
  assert.equal(namesIn(null).size, 0);
});

await check('a question carries four fields onto the row and no more', () => {
  const ref = toQuestionRef('alpha', ask('aa-q', { title: 'Close it?', priority: 0, description: 'a whole essay' }));
  assert.deepEqual(ref, { key: 'alpha/aa-q', workspace: 'alpha', id: 'aa-q', title: 'Close it?', priority: 0 });
});

/* ------------------------------------------------------------------- the join */

await check('the question lands on the row it names, and on no other', async () => {
  cache.clear();
  const rows = [row('alpha', 'aa-one'), row('alpha', 'aa-two')];
  const bd = fakeBd({ alpha: [ask('aa-q', { description: 'is aa-one already done?' })] });
  await addOpenQuestions(bd, [ALPHA], rows);
  assert.deepEqual(rows[0].questions.map((q) => q.id), ['aa-q']);
  assert.deepEqual(rows[1].questions, [], 'nobody asked about aa-two, and the row has to be able to say so');
});

await check('a human epic is a board card and never flags a row', async () => {
  cache.clear();
  const rows = [row('alpha', 'aa-one')];
  // An advocate's running log on a standing P0 names every bead it has touched this week.
  // Measured on the live tracker before this exclusion existed: four `human` epics between
  // them produced every false positive there was.
  const bd = fakeBd({
    alpha: [
      ask('aa-epic', {
        issue_type: 'epic',
        notes: 'This week: aa-one, aa-two, and a dozen others were touched by the sweep.',
      }),
    ],
  });
  await addOpenQuestions(bd, [ALPHA], rows);
  assert.deepEqual(rows[0].questions, [], 'a row that cries wolf is a row you learn to scroll past');
});

await check('but a task, bug or decision carrying human is a question and does flag', async () => {
  for (const kind of ['task', 'bug', 'decision', undefined]) {
    cache.clear();
    const rows = [row('alpha', 'aa-one')];
    const bd = fakeBd({ alpha: [ask('aa-q', { issue_type: kind, description: 'about aa-one' })] });
    await addOpenQuestions(bd, [ALPHA], rows);
    assert.equal(rows[0].questions.length, 1, `a ${kind || 'typeless'} human bead is somebody asking`);
  }
});

await check('a question that names only itself is about nothing on the queue', async () => {
  cache.clear();
  // A held bead carrying `human` is in both lists at once, which is the one way this could
  // draw a row pointing at itself.
  const rows = [row('alpha', 'aa-self')];
  const bd = fakeBd({ alpha: [ask('aa-self', { description: 'aa-self needs a decision' })] });
  await addOpenQuestions(bd, [ALPHA], rows);
  assert.deepEqual(rows[0].questions, []);
});

await check('several questions on one bead come loudest first, and are bounded', async () => {
  cache.clear();
  const rows = [row('alpha', 'aa-hot')];
  const bd = fakeBd({
    alpha: Array.from({ length: QUESTIONS_PER_ROW + 3 }, (_, i) =>
      // Descending priority as the index rises, so the array order and the wanted order
      // disagree — a join that merely kept insertion order would pass a sorted fixture.
      ask(`aa-q${i}`, { description: 'about aa-hot', priority: 4 - Math.min(4, i) })
    ),
  });
  await addOpenQuestions(bd, [ALPHA], rows);
  assert.equal(rows[0].questions.length, QUESTIONS_PER_ROW, 'a row is a row, not the inbox');
  assert.deepEqual(
    rows[0].questions.map((q) => q.priority),
    rows[0].questions.map((q) => q.priority).slice().sort((a, b) => a - b),
    'a P0 asking about this bead outranks a P3, and the row has room for three'
  );
  assert.equal(rows[0].questions[0].priority, 0);
});

await check('the same question naming a bead twice counts once', async () => {
  cache.clear();
  const rows = [row('alpha', 'aa-one')];
  const bd = fakeBd({ alpha: [ask('aa-q', { title: 'aa-one?', description: 'yes, aa-one', notes: 'aa-one' })] });
  await addOpenQuestions(bd, [ALPHA], rows);
  assert.equal(rows[0].questions.length, 1, 'one bead asked once, however many times its id appears in the prose');
});

/* -------------------------------------------------------------- what it costs */

await check('only the workspaces with rows in the queue are asked', async () => {
  cache.clear();
  const rows = [row('alpha', 'aa-one')];
  const bd = fakeBd({ alpha: [], beta: [] });
  await addOpenQuestions(bd, [ALPHA, BETA], rows);
  assert.deepEqual(bd.calls, ['alpha'], 'a repo with nothing held has no row to hang a question on');
});

await check('a workspace nobody configured is skipped rather than guessed at', async () => {
  cache.clear();
  const rows = [row('ghost', 'gg-one')];
  const bd = fakeBd({ alpha: [] });
  await addOpenQuestions(bd, [ALPHA], rows);
  assert.deepEqual(bd.calls, []);
  assert.equal(rows[0].questions, null, 'never asked, so never answered — and that is not the same as no questions');
});

await check('a workspace whose bd fell over leaves null, and the others still answer', async () => {
  cache.clear();
  const rows = [row('alpha', 'aa-one'), row('beta', 'bb-one')];
  const bd = fakeBd({ alpha: [ask('aa-q', { description: 'aa-one?' })], beta: 'broken' });
  await addOpenQuestions(bd, [ALPHA, BETA], rows);
  assert.equal(rows[0].questions.length, 1, 'one broken repo must not blank the queue');
  assert.equal(
    rows[1].questions,
    null,
    '`[]` would be this screen saying "nobody has asked" on the strength of a call that never came back'
  );
});

await check('the answer is kept on the key the inbox already keeps warm', async () => {
  cache.clear();
  const rows = [row('alpha', 'aa-one')];
  const bd = fakeBd({ alpha: [ask('aa-q', { description: 'aa-one?' })] });
  await addOpenQuestions(bd, [ALPHA], rows);
  assert.ok(cache.peek('questions:alpha'), 'the key `allQuestions()` in lib/server.js writes, deliberately shared');

  const again = [row('alpha', 'aa-one')];
  await addOpenQuestions(bd, [ALPHA], again);
  assert.deepEqual(bd.calls, ['alpha'], 'a second sweep inside the window spends no spawn at all');
  assert.equal(again[0].questions.length, 1, 'and still answers, off the keep');
});

await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
