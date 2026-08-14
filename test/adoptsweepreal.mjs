#!/usr/bin/env node
/**
 * The `Adopts:` line applied against the real bd — the round trip, end to end.
 *
 *     npm test
 *     node test/adoptsweepreal.mjs
 *
 * test/adoptsweep.mjs puts every rule in front of a fixture and is where the interesting
 * cases live. This asks the three questions a fixture cannot answer, and they are the
 * three the whole of bc-arj0.2 rests on:
 *
 *  1. **Does the write land?** `bd update <bead> --parent=<epic>` is the one line that
 *     turns a description into structure, and a fake that records the call proves only
 *     that the call was made. Here the bead is a child afterwards by bd's own answer.
 *  2. **Does the close gate then stop complaining?** This is the contract, and it is a
 *     loop between three files that were written at different times: lib/adopts.js reads
 *     the line, lib/adoptsweep.js applies it, `Bd.gateFor` refuses to close an epic over
 *     an entry that is not a child. If the parser and the applier ever disagree about
 *     what the line says, an epic is held closed over an adoption nothing believes in and
 *     the phone cannot fix it. One pass of the sweep has to clear the gate, and that is
 *     what "the daemon applies it" *means*.
 *  3. **Is a refusal decided on the index the same refusal the binary would give?** The
 *     plan refuses a pair that already holds an edge without asking bd, so that a doomed
 *     write is not attempted thirty times an hour forever. That is only safe while bd
 *     really does refuse — and the day it stops, this file is how anybody finds out.
 *
 * Nothing here is shared: a fresh mkdtemp workspace, so it takes no Dolt write lock any
 * other session is waiting on. Skipped loudly where `bd` is not installed, exactly as
 * test/epicedgereal.mjs and test/closegatereal.mjs are — a machine without the tracker
 * cannot answer the question, and failing there would say something untrue about the code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { Bd } = await import(path.join(HERE, '..', 'lib', 'bd.js'));
const { sweepAdoptions, adoptionPlan, describeRefusal } = await import(path.join(HERE, '..', 'lib', 'adoptsweep.js'));

let failures = 0;
let ran = 0;
const check = (fn, name) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

console.log('\napplying the Adopts: line against the real bd\n');

const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what it accepts cannot be asked here');
  console.log('\n0/0 passed\n');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-adoptreal-'));
const dir = path.join(tmp, '.beads');
fs.mkdirSync(dir, { recursive: true });

// Spawned directly, never through a shell: `~/.zshenv` rewrites BEADS_DIR from the
// shell's cwd, so a shell here would resolve to somebody's actual tracker — and this
// suite reparents beads.
const env = { ...process.env, BEADS_DIR: dir };
const bdRun = (args) => spawnSync('bd', args, { env, cwd: tmp, encoding: 'utf8', timeout: 120_000 });
const saidBy = (r) => `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n')[0];

const init = bdRun(['init', '--skip-agents', '--prefix', 'ar']);
if (init.status !== 0) {
  console.log(`  \x1b[31m✗\x1b[0m a temp workspace can be made to ask in\n      ${saidBy(init)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n1/1 failed\n');
  process.exit(1);
}

const bd = new Bd({ bin: 'bd', actor: 'beadcause' });
const ws = { name: 'adoptsweepreal', dir };
/** `labels: []` on purpose — `Bd.create` defaults to `['human']`, which is the inbox shape. */
const make = (over = {}) => bd.create(ws, { title: 'a bead', body: 'x', priority: 2, type: 'task', labels: [], ...over });
const childIds = async (id) => (await bd.children(ws, id)).map((c) => c.id).sort();
const show = async (id) => bd.show(ws, id);

/* ------------------------------------------------------- the free ones, and the gate */

// Made before the epic, so the epic's own description can name them. `Bd.create` runs
// lib/mentions.js over what it writes, which relates the epic to every id in its list —
// exactly the collision the sweep's `relates-to` rule exists for, and it is worth having
// it in the fixture rather than assumed away.
const free1 = await make({ title: 'the first bead the epic claims' });
const free2 = await make({ title: 'the second' });
const elsewhere = await make({ title: 'a bead another epic already holds' });
const otherEpic = await make({ type: 'epic', title: 'the epic that got there first' });
await bd.adopt(ws, elsewhere, otherEpic);

const epic = await make({
  type: 'epic',
  title: 'the epic with a list',
  body: `An epic that claims its work in prose.\n\nAdopts: ${free1}, ${free2}, ${elsewhere}, ar-nope.\n`,
});

{
  const before = await bd.gateFor(ws, await show(epic), { reason: 'done with the theme' });
  check(() => assert.equal(before?.kind, 'adopts', JSON.stringify(before)), 'before the sweep the close gate refuses the epic over its unapplied list');
}

// The sweep reads `Bd.graph`, which caches for a minute — so on the daemon an adoption
// written now is applied within about a cycle and a half, and in a suite that has just
// written five beads the cached index predates all of them. Refreshed here rather than
// inside the sweep, because a sweep that forced an export every thirty seconds per
// workspace would be paying nine seconds a cycle to be sixty seconds less patient.
await bd.graph(ws, { refresh: true });

{
  // The collision the whole `relates-to` rule exists for, and it is real rather than
  // imagined: `Bd.create` runs lib/mentions.js over what it writes, so the epic arrives
  // already see-also'd to every id in its own list — and bd allows one edge per pair, so
  // without the rule not a single adoption on any graph beadcause has written could ever
  // be applied. If bd or the mention hook ever stops doing this, the assertion below goes
  // red rather than the rule quietly becoming dead code.
  const drawn = (await show(free1)).dependencies || [];
  check(
    () => assert.ok(drawn.some((d) => d.id === epic && /^relate/.test(d.dependency_type)), JSON.stringify(drawn)),
    'writing the list draws a see-also to every bead in it, which is what would otherwise refuse every adoption'
  );
}

const said = [];
const out = await sweepAdoptions(bd, [ws], { onLog: (l) => said.push(l) });

check(() => assert.deepEqual(out.applied.map((a) => a.bead).sort(), [free1, free2].sort(), JSON.stringify(out)), 'the sweep applies the entries that were free');

{
  const kids = await childIds(epic);
  check(() => assert.deepEqual(kids, [free1, free2].sort(), `children: ${kids.join(', ')}`), 'and bd itself now says they are children of the epic');
}

check(() => {
  const why = out.refused.map(describeRefusal).join(' | ');
  assert.match(why, new RegExp(`cannot adopt ${elsewhere}: already a child of ${otherEpic}`), why);
  assert.match(why, /cannot adopt ar-nope: no bead of that id/, why);
}, 'and refuses the two it must not decide, saying which is which');

check(() => assert.equal(out.refused.length, 2, JSON.stringify(out.refused)), 'and refuses nothing else');

/* ------------------------------------------- the gate, which is what the round trip is */

{
  // **Adopting a bead holds the epic behind it**, which is the direction worth being sure
  // of: the two beads are open children now, so the gate's *first* refusal is theirs and
  // not the list's. That is right — an epic is not finished while its work is open — and
  // it is why nothing here reparents a bead that was parked or superseded (lib/superseded.js
  // draws a see-also for exactly that reason).
  const held = await bd.gateFor(ws, await show(epic), { reason: 'done with the theme' });
  check(
    () => assert.deepEqual((held?.blockers || []).map((b) => b.id).sort(), [free1, free2].sort(), JSON.stringify(held)),
    'the beads it adopted now hold the epic open, which is what a child is for'
  );

  // And with those closed, the list still names two beads that were refused, so the gate
  // is still right to refuse — over only those two. A gate still complaining about a bead
  // that is demonstrably a child would be the parser and the applier disagreeing.
  bdRun(['close', free1, '--reason', 'done']);
  bdRun(['close', free2, '--reason', 'done']);
  const after = await bd.gateFor(ws, await show(epic), { reason: 'done with the theme' });
  check(
    () => assert.deepEqual((after?.blockers || []).map((b) => b.id).sort(), [elsewhere, 'ar-nope'].sort(), JSON.stringify(after)),
    'and with those closed it holds the epic only over what the sweep refused'
  );
}

{
  // And an epic whose whole list applied closes. This is the contract in one assertion:
  // write the line, wait a tick, close the epic.
  const only = await make({ title: 'the one bead of a tidy epic' });
  const tidy = await make({ type: 'epic', title: 'a tidy epic', body: `Adopts: ${only}.` });
  await bd.graph(ws, { refresh: true });
  await sweepAdoptions(bd, [ws]);
  const kids = await childIds(tidy);
  check(() => assert.deepEqual(kids, [only], `children: ${kids.join(', ')}`), 'an epic whose list is all free has all of it applied in one pass');
  bdRun(['close', only, '--reason', 'done']);
  const gate = await bd.gateFor(ws, await show(tidy));
  check(() => assert.equal(gate, null, JSON.stringify(gate)), 'and the close gate then lets it go, which is the whole of the contract');
}

/* ---------------------------- the refusal the plan makes without asking bd, asked of bd */

{
  const provenance = await make({ title: 'a bead filed from the epic' });
  bdRun(['dep', 'add', provenance, epic, '--type', 'discovered-from']);
  bdRun(['update', epic, '--notes', `Adopts: ${provenance}.`]);

  const plan = adoptionPlan(await bd.graph(ws, { refresh: true }));
  check(
    () => assert.match(plan.refused.map(describeRefusal).join(' | '), new RegExp(`cannot adopt ${provenance}: already linked by a discovered-from edge`)),
    'the plan refuses a pair that already holds a provenance edge, without spawning anything'
  );
  const refused = bdRun(['update', provenance, `--parent=${epic}`]);
  check(
    () => assert.notEqual(refused.status, 0, `bd said: ${saidBy(refused)}`),
    'and bd refuses that write, which is what makes not attempting it right rather than timid'
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
