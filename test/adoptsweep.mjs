#!/usr/bin/env node
/**
 * The `Adopts:` line applied — what the daemon will reparent, and what it refuses.
 *
 *     npm test
 *     node test/adoptsweep.mjs
 *
 * bc-arj0.2. lib/adopts.js reads the line and lib/bd.js's close gate holds an epic open
 * over an entry nothing applied; this is the half that makes the entry into an edge, and
 * every interesting thing about it is a **refusal**. Applying is one `bd update
 * --parent`; not applying is six separate judgements, each one a case where the write
 * would destroy something somebody decided on purpose, and none of them visible from the
 * one line of code that does the write.
 *
 * So the fixtures below are the refusals. Each is built as real `bd export` JSONL and put
 * through the real `indexFrom`, because the plan is only as good as what the index says
 * is there — the `Adopts:` list, the parent edges *and* the non-parent edges, all off one
 * read (bc-arj0.2 added the last two to lib/ancestry.js for exactly this caller).
 *
 * The end of the file is the round trip that is the actual contract, driven with fakes:
 * a sweep that applies what is free, refuses the rest, refreshes the graph once rather
 * than once per write, and reports a bd that rejects a write anyway instead of throwing
 * it into the poll cycle. test/adoptsweepreal.mjs asks the real binary the questions a
 * fake cannot answer.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { indexFrom } = await import(path.join(HERE, '..', 'lib', 'ancestry.js'));
const { adoptionPlan, describeRefusal, sweepAdoptions } = await import(path.join(HERE, '..', 'lib', 'adoptsweep.js'));

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 5).join('\n      ')}`);
  }
};

console.log('\napplying the Adopts: line\n');

/**
 * `bd export` JSONL for a graph, written the way bd writes it: a parent link is a
 * `parent-child` dependency row on the *child*, and every other edge rides the same array.
 */
const exportOf = (rows) =>
  rows
    .map((r) => JSON.stringify({ _type: 'issue', status: 'open', issue_type: 'task', priority: 2, labels: [], ...r }))
    .join('\n');

const epic = (id, adopts, over = {}) => ({
  id,
  issue_type: 'epic',
  priority: 0,
  description: `An epic.\n\nAdopts: ${adopts.join(', ')}.\n`,
  ...over,
});

const child = (id, parent) => ({ id, dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] });
const linked = (id, other, type) => ({ id, dependencies: [{ issue_id: id, depends_on_id: other, type }] });

const planOf = (rows) => adoptionPlan(indexFrom(exportOf(rows)));
const pairs = (list) => list.map((a) => `${a.epic}->${a.bead}`);
const whyOf = (plan, bead) => plan.refused.find((r) => r.bead === bead)?.why || '(not refused)';

/* -------------------------------------------------------------- the index carries it */

await check('the export pass now carries the list, the parents and every other edge', () => {
  const index = indexFrom(exportOf([epic('bc-e1', ['bc-a1', 'bc-b2']), { id: 'bc-a1' }, linked('bc-b2', 'bc-e1', 'discovered-from')]));
  assert.deepEqual(index.adopts.get('bc-e1'), ['bc-a1', 'bc-b2']);
  assert.deepEqual(index.edges.get('bc-b2~bc-e1'), { type: 'discovered-from', from: 'bc-b2', to: 'bc-e1' });
  // And the thing it deliberately does not carry: seven hundred descriptions in a cache.
  assert.equal(index.beads.get('bc-e1').description, undefined);
});

await check('a bead with no list at all is not a key in it', () => {
  const index = indexFrom(exportOf([{ id: 'bc-a1', description: 'This sits in bc-42ow neighbourhood.' }]));
  assert.equal(index.adopts.size, 0);
});

/* ------------------------------------------------------------------ what it applies */

await check('an epic that names a free bead adopts it', () => {
  const plan = planOf([epic('bc-e1', ['bc-a1']), { id: 'bc-a1' }]);
  assert.deepEqual(pairs(plan.apply), ['bc-e1->bc-a1']);
  assert.deepEqual(plan.refused, []);
});

await check('a bead that is already the child is neither applied nor refused', () => {
  const plan = planOf([epic('bc-e1', ['bc-a1']), child('bc-a1', 'bc-e1')]);
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.refused, []);
});

await check('an epic adopting an epic is an ordinary adoption', () => {
  const plan = planOf([epic('bc-e1', ['bc-e2']), epic('bc-e2', [])]);
  assert.deepEqual(pairs(plan.apply), ['bc-e1->bc-e2']);
});

await check('the writes are planned in a fixed order, so two machines agree', () => {
  const rows = [epic('bc-zz', ['bc-a1']), epic('bc-aa', ['bc-b2']), { id: 'bc-a1' }, { id: 'bc-b2' }];
  assert.deepEqual(pairs(planOf(rows).apply), ['bc-aa->bc-b2', 'bc-zz->bc-a1']);
  assert.deepEqual(pairs(planOf([...rows].reverse()).apply), ['bc-aa->bc-b2', 'bc-zz->bc-a1']);
});

/* ------------------------------------------------------------------- what it refuses */

await check('a bead that already has a parent keeps it, and the epic is told whose', () => {
  const plan = planOf([epic('bc-e1', ['bc-a1']), child('bc-a1', 'bc-p9')]);
  assert.deepEqual(plan.apply, []);
  assert.match(whyOf(plan, 'bc-a1'), /already a child of bc-p9/);
});

await check('an edge of any other type to the same epic refuses it, because bd allows one per pair', () => {
  for (const type of ['discovered-from', 'blocks', 'supersedes', 'tracks']) {
    const plan = planOf([epic('bc-e1', ['bc-a1']), linked('bc-a1', 'bc-e1', type)]);
    assert.deepEqual(plan.apply, [], type);
    assert.match(whyOf(plan, 'bc-a1'), new RegExp(`already linked by a ${type} edge`), type);
  }
});

await check('and the direction the edge was written in makes no difference', () => {
  // bd's rule is about the pair. `bin/file.js --from` writes the row on the discovered
  // bead; a plan that only looked one way would apply an adoption bd then refuses.
  const plan = planOf([
    { ...epic('bc-e1', ['bc-a1']), dependencies: [{ issue_id: 'bc-e1', depends_on_id: 'bc-a1', type: 'discovered-from' }] },
    { id: 'bc-a1' },
  ]);
  assert.deepEqual(plan.apply, []);
  assert.match(whyOf(plan, 'bc-a1'), /already linked by a discovered-from edge/);
});

await check('a see-also the mention hook drew is replaced, not treated as a claim', () => {
  // Without this the feature applies nothing on any graph beadcause has been running
  // against: lib/mentions.js relates a bead to every id its prose names, and an
  // `Adopts:` list is prose naming ids. Both spellings, since bd renamed the type.
  for (const type of ['relates-to', 'related']) {
    const plan = planOf([epic('bc-e1', ['bc-a1']), linked('bc-a1', 'bc-e1', type)]);
    assert.deepEqual(pairs(plan.apply), ['bc-e1->bc-a1'], type);
    // The ends in the order bd wrote them, which is what `bd dep remove` takes.
    assert.deepEqual(plan.apply[0].drop, ['bc-a1', 'bc-e1'], type);
  }
});

await check('a bead two epics both name is refused for both, each told about the other', () => {
  const plan = planOf([epic('bc-e1', ['bc-a1']), epic('bc-e2', ['bc-a1']), { id: 'bc-a1' }]);
  assert.deepEqual(plan.apply, []);
  assert.equal(plan.refused.length, 2);
  assert.match(plan.refused.find((r) => r.epic === 'bc-e1').why, /bc-e2 claims it too/);
  assert.match(plan.refused.find((r) => r.epic === 'bc-e2').why, /bc-e1 claims it too/);
});

await check('an id naming no bead here is refused rather than skipped, so the gate sentence has a cause', () => {
  const plan = planOf([epic('bc-e1', ['cl-d4u'])]);
  assert.deepEqual(plan.apply, []);
  assert.match(whyOf(plan, 'cl-d4u'), /no bead of that id/);
});

await check('a closed epic adopts nothing — its list is a record, and a closed parent holds a bead invisible', () => {
  const plan = planOf([epic('bc-e1', ['bc-a1'], { status: 'closed' }), { id: 'bc-a1' }]);
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.refused, []);
});

await check('a list on something that is not an epic is prose and stays prose', () => {
  const plan = planOf([{ ...epic('bc-t1', ['bc-a1']), issue_type: 'task' }, { id: 'bc-a1' }]);
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.refused, []);
});

await check('an epic naming a bead it already hangs below would close a loop, and is refused', () => {
  const plan = planOf([{ ...epic('bc-e1', ['bc-a1']), dependencies: [{ issue_id: 'bc-e1', depends_on_id: 'bc-mid', type: 'parent-child' }] }, child('bc-mid', 'bc-a1'), { id: 'bc-a1' }]);
  assert.deepEqual(plan.apply, []);
  assert.match(whyOf(plan, 'bc-a1'), /would close a loop/);
});

await check('two epics adopting each other plan one edge, not a loop', () => {
  // Both are parentless in the index, so a plan that read only the index would write both
  // and hand bd the second one to refuse — every tick, for as long as both lines stand.
  const plan = planOf([epic('bc-e1', ['bc-e2']), epic('bc-e2', ['bc-e1'])]);
  assert.deepEqual(pairs(plan.apply), ['bc-e1->bc-e2']);
  assert.match(whyOf(plan, 'bc-e1'), /already a child of bc-e1|would close a loop/);
});

await check('an index that could not be read plans nothing at all', () => {
  assert.deepEqual(adoptionPlan({ parents: new Map(), beads: new Map(), error: 'bd export timed out' }).apply, []);
  assert.deepEqual(adoptionPlan(null).apply, []);
});

await check('a refusal reads as one sentence naming both beads', () => {
  const plan = planOf([epic('bc-4bet', ['bc-d5sv']), child('bc-d5sv', 'bc-xl7n.1')]);
  assert.equal(describeRefusal(plan.refused[0]), 'bc-4bet cannot adopt bc-d5sv: already a child of bc-xl7n.1');
});

/* ------------------------------------------------------------------- the sweep itself */

/** A bd that answers one graph and records what was written to it. */
const fakeBd = (rows, { failOn = null } = {}) => {
  const calls = { adopt: [], refresh: 0, order: [] };
  return {
    calls,
    async graph(_ws, { refresh = false } = {}) {
      if (refresh) calls.refresh += 1;
      return indexFrom(exportOf(rows));
    },
    async dropDep(_ws, a, b) {
      calls.order.push(`drop ${a} ${b}`);
    },
    async adopt(_ws, id, parent, opts = {}) {
      if (failOn === id) throw new Error('bd: database is locked\nand a second line nobody should print');
      calls.order.push(`adopt ${id} ${parent}`);
      calls.adopt.push({ id, parent, refresh: opts.refresh });
    },
  };
};

await check('the see-also is dropped before the parent link goes in, since bd allows one edge per pair', async () => {
  const bd = fakeBd([epic('bc-e1', ['bc-a1']), linked('bc-a1', 'bc-e1', 'relates-to')]);
  await sweepAdoptions(bd, [{ name: 'beadcause' }]);
  assert.deepEqual(bd.calls.order, ['drop bc-a1 bc-e1', 'adopt bc-a1 bc-e1']);
});

await check('the sweep writes what the plan says and reports what it refused', async () => {
  const bd = fakeBd([epic('bc-e1', ['bc-a1', 'bc-b2']), { id: 'bc-a1' }, child('bc-b2', 'bc-p9')]);
  const said = [];
  const out = await sweepAdoptions(bd, [{ name: 'beadcause' }], { onLog: (l) => said.push(l) });
  assert.deepEqual(bd.calls.adopt, [{ id: 'bc-a1', parent: 'bc-e1', refresh: false }]);
  assert.deepEqual(out.applied.map((a) => a.bead), ['bc-a1']);
  assert.deepEqual(out.refused.map((r) => r.bead), ['bc-b2']);
  assert.equal(out.refused[0].workspace, 'beadcause');
  assert.deepEqual(out.workspaces, [{ workspace: 'beadcause', applied: 1, refused: 1 }]);
  assert.ok(said.some((l) => /bc-e1 adopted bc-a1/.test(l)), said.join(' | '));
});

await check('the graph is refreshed once for the whole batch, not once per write', async () => {
  const bd = fakeBd([epic('bc-e1', ['bc-a1', 'bc-b2', 'bc-c3']), { id: 'bc-a1' }, { id: 'bc-b2' }, { id: 'bc-c3' }]);
  await sweepAdoptions(bd, [{ name: 'beadcause' }]);
  assert.equal(bd.calls.adopt.length, 3);
  assert.ok(bd.calls.adopt.every((c) => c.refresh === false));
  assert.equal(bd.calls.refresh, 1);
});

await check('and not at all over a workspace that needed no write', async () => {
  const bd = fakeBd([epic('bc-e1', ['bc-a1']), child('bc-a1', 'bc-e1')]);
  await sweepAdoptions(bd, [{ name: 'beadcause' }]);
  assert.equal(bd.calls.refresh, 0);
});

await check('a write bd rejects is a row in the answer, not a throw into the poll cycle', async () => {
  const bd = fakeBd([epic('bc-e1', ['bc-a1', 'bc-b2']), { id: 'bc-a1' }, { id: 'bc-b2' }], { failOn: 'bc-a1' });
  const out = await sweepAdoptions(bd, [{ name: 'beadcause' }]);
  assert.deepEqual(out.failed.map((f) => f.bead), ['bc-a1']);
  assert.equal(out.failed[0].why, 'bd: database is locked');
  // The rest of the batch still lands: one locked row must not cost the other nine.
  assert.deepEqual(out.applied.map((a) => a.bead), ['bc-b2']);
});

await check('a workspace whose export could not be read is left alone rather than emptied', async () => {
  const calls = [];
  const bd = {
    async graph() {
      return { parents: new Map(), beads: new Map(), adopts: new Map(), edges: new Map(), error: 'bd export timed out' };
    },
    async adopt(...a) {
      calls.push(a);
    },
  };
  const out = await sweepAdoptions(bd, [{ name: 'beadcause' }]);
  assert.deepEqual(calls, []);
  assert.deepEqual(out.refused, []);
  assert.deepEqual(out.workspaces, []);
});

await check('a bd whose graph throws is one line, and the other workspaces still sweep', async () => {
  const good = fakeBd([epic('bc-e1', ['bc-a1']), { id: 'bc-a1' }]);
  const said = [];
  const bd = {
    graph: async (ws, opts) => {
      if (ws.name === 'broken') throw new Error('no such workspace');
      return good.graph(ws, opts);
    },
    adopt: good.adopt,
  };
  const out = await sweepAdoptions(bd, [{ name: 'broken' }, { name: 'beadcause' }], { onLog: (l) => said.push(l) });
  assert.deepEqual(out.applied.map((a) => a.bead), ['bc-a1']);
  assert.ok(said.some((l) => /could not read broken/.test(l)), said.join(' | '));
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
