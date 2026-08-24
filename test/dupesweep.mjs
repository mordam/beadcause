#!/usr/bin/env node
/**
 * The other half of bc-arj0.6 — every live near-verbatim title, joined.
 *
 *     npm test
 *     node test/dupesweep.mjs
 *
 * bc-arj0.17. `duplicatePlan` is pure — an index in, a list of pairs out — built the same
 * way test/adoptsweep.mjs builds its fixtures: real `bd export` JSONL through the real
 * `indexFrom`, so the plan is only as good as what the index actually says is there. The
 * round trip at the end drives `sweepDuplicates` with a fake `bd` the way
 * test/adoptsweep.mjs drives `sweepAdoptions` — a write for what clears the bar, a row in
 * `failed` rather than a throw for one `bd` rejects, one refresh per batch rather than
 * one per write.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { indexFrom } = await import(path.join(HERE, '..', 'lib', 'ancestry.js'));
const { duplicatePlan, sweepDuplicates } = await import(path.join(HERE, '..', 'lib', 'dupesweep.js'));

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

console.log('\njoining live near-verbatim titles\n');

/** `bd export` JSONL, written the way bd writes it. */
const exportOf = (rows) =>
  rows
    .map((r) => JSON.stringify({ _type: 'issue', status: 'open', issue_type: 'task', priority: 2, labels: [], ...r }))
    .join('\n');

const bead = (id, title, over = {}) => ({ id, title, ...over });
const linked = (id, other, type) => ({ dependencies: [{ issue_id: id, depends_on_id: other, type }] });

// A pair that scores 0.947 against `titleSimilarity` — one word added, same claim —
// well clear of `DUPE_THRESHOLD` (0.9).
const TITLE_A = 'The router refuses a websocket upgrade it cannot proxy';
const TITLE_B = 'The router refuses a websocket upgrade that it cannot proxy';
const UNRELATED = 'A completely different bead about something else entirely';

const planOf = (rows) => duplicatePlan(indexFrom(exportOf(rows)));
const pairs = (plan) => plan.map((p) => `${p.a}~${p.b}`);

/* ------------------------------------------------------------------- the pure plan */

await check('two unjoined live beads with near-verbatim titles are planned', () => {
  const plan = planOf([bead('bc-a1', TITLE_A), bead('bc-b2', TITLE_B)]);
  assert.deepEqual(pairs(plan), ['bc-a1~bc-b2']);
  assert.ok(plan[0].score >= 0.9, plan[0].score);
});

await check('a pair already joined by any edge type is not planned again', () => {
  // `discovered-from`, not `relates-to` — any edge at all counts as "already found each
  // other", the same rule scripts/relate-sweep.mjs's `linkedPairs` uses.
  const plan = planOf([bead('bc-a1', TITLE_A, linked('bc-a1', 'bc-b2', 'discovered-from')), bead('bc-b2', TITLE_B)]);
  assert.deepEqual(plan, []);
});

await check('titles that merely share a few words are left alone', () => {
  const plan = planOf([bead('bc-a1', TITLE_A), bead('bc-c3', UNRELATED)]);
  assert.deepEqual(plan, []);
});

await check('a closed bead is not a candidate on either side', () => {
  const plan = planOf([bead('bc-a1', TITLE_A, { status: 'closed' }), bead('bc-b2', TITLE_B)]);
  assert.deepEqual(plan, []);
});

await check('in_progress and blocked are still live', () => {
  const plan = planOf([bead('bc-a1', TITLE_A, { status: 'in_progress' }), bead('bc-b2', TITLE_B, { status: 'blocked' })]);
  assert.deepEqual(pairs(plan), ['bc-a1~bc-b2']);
});

await check('a question on either side is skipped — its title is formulaic by construction', () => {
  const withHuman = planOf([bead('bc-a1', TITLE_A, { labels: ['human'] }), bead('bc-b2', TITLE_B)]);
  assert.deepEqual(withHuman, []);
  const bothHuman = planOf([bead('bc-a1', TITLE_A, { labels: ['human'] }), bead('bc-b2', TITLE_B, { labels: ['human'] })]);
  assert.deepEqual(bothHuman, []);
});

await check('three-way near ties are named in id order, the same on every machine', () => {
  const plan = planOf([bead('bc-c3', TITLE_A), bead('bc-a1', TITLE_A), bead('bc-b2', TITLE_A)]);
  assert.deepEqual(pairs(plan), ['bc-a1~bc-b2', 'bc-a1~bc-c3', 'bc-b2~bc-c3']);
});

await check('an index that could not be read plans nothing at all', () => {
  assert.deepEqual(duplicatePlan({ beads: new Map(), error: 'bd export timed out' }), []);
  assert.deepEqual(duplicatePlan(null), []);
});

/* ------------------------------------------------------------------- the sweep itself */

/** A bd that answers one graph and records what was written to it. */
const fakeBd = (rows, { failOn = null } = {}) => {
  const calls = { relate: [], refresh: 0 };
  return {
    calls,
    async graph(_ws, { refresh = false } = {}) {
      if (refresh) calls.refresh += 1;
      return indexFrom(exportOf(rows));
    },
    async run(_ws, args) {
      const [, sub, a, b] = args;
      assert.equal(sub, 'relate');
      if (failOn && (failOn === a || failOn === b)) throw new Error('bd: database is locked\nand a second line nobody should print');
      calls.relate.push([a, b]);
    },
  };
};

await check('the sweep writes what the plan says and reports it', async () => {
  const bd = fakeBd([bead('bc-a1', TITLE_A), bead('bc-b2', TITLE_B)]);
  const said = [];
  const out = await sweepDuplicates(bd, [{ name: 'beadcause' }], { onLog: (l) => said.push(l) });
  assert.deepEqual(bd.calls.relate, [['bc-a1', 'bc-b2']]);
  assert.deepEqual(out.applied.map((p) => `${p.a}~${p.b}`), ['bc-a1~bc-b2']);
  assert.deepEqual(out.workspaces, [{ workspace: 'beadcause', applied: 1 }]);
  assert.ok(said.some((l) => /bc-a1 ↔ bc-b2 linked/.test(l)), said.join(' | '));
});

await check('the graph is refreshed once for the whole batch, not once per write', async () => {
  const bd = fakeBd([bead('bc-a1', TITLE_A), bead('bc-b2', TITLE_B), bead('bc-c3', TITLE_A)]);
  await sweepDuplicates(bd, [{ name: 'beadcause' }]);
  assert.equal(bd.calls.relate.length, 3);
  assert.equal(bd.calls.refresh, 1);
});

await check('and not at all over a workspace that needed no write', async () => {
  const bd = fakeBd([bead('bc-a1', TITLE_A), bead('bc-c3', UNRELATED)]);
  await sweepDuplicates(bd, [{ name: 'beadcause' }]);
  assert.equal(bd.calls.refresh, 0);
});

await check('a write bd rejects is a row in the answer, not a throw into the poll cycle', async () => {
  const bd = fakeBd([bead('bc-a1', TITLE_A), bead('bc-b2', TITLE_B)], { failOn: 'bc-a1' });
  const out = await sweepDuplicates(bd, [{ name: 'beadcause' }]);
  assert.deepEqual(out.failed.map((f) => `${f.a}~${f.b}`), ['bc-a1~bc-b2']);
  assert.equal(out.failed[0].why, 'bd: database is locked');
  assert.deepEqual(out.applied, []);
});

await check('a workspace whose export could not be read is left alone rather than emptied', async () => {
  const calls = [];
  const bd = {
    async graph() {
      return { beads: new Map(), edges: new Map(), error: 'bd export timed out' };
    },
    async run(...a) {
      calls.push(a);
    },
  };
  const out = await sweepDuplicates(bd, [{ name: 'beadcause' }]);
  assert.deepEqual(calls, []);
  assert.deepEqual(out.workspaces, []);
});

await check('a stale index plans nothing rather than reporting against beads it predates', async () => {
  const calls = [];
  const bd = {
    async graph() {
      return { beads: new Map(), edges: new Map(), stale: 'bd export could not be re-read' };
    },
    async run(...a) {
      calls.push(a);
    },
  };
  const out = await sweepDuplicates(bd, [{ name: 'beadcause' }]);
  assert.deepEqual(calls, []);
  assert.deepEqual(out.workspaces, []);
});

await check('a bd whose graph throws is one line, and the other workspaces still sweep', async () => {
  const good = fakeBd([bead('bc-a1', TITLE_A), bead('bc-b2', TITLE_B)]);
  const said = [];
  const bd = {
    graph: async (ws, opts) => {
      if (ws.name === 'broken') throw new Error('no such workspace');
      return good.graph(ws, opts);
    },
    run: good.run,
  };
  const out = await sweepDuplicates(bd, [{ name: 'broken' }, { name: 'beadcause' }], { onLog: (l) => said.push(l) });
  assert.deepEqual(out.applied.map((p) => `${p.a}~${p.b}`), ['bc-a1~bc-b2']);
  assert.ok(said.some((l) => /could not read broken/.test(l)), said.join(' | '));
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
