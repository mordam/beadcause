#!/usr/bin/env node
/**
 * The same rule against the real bd — filing a bead that explains its own dependency.
 *
 *     npm test
 *     node test/declarededgereal.mjs
 *
 * test/declarededge.mjs puts every branch in front of a fake and is where the
 * interesting cases live. This asks the four questions a fake cannot answer, and each of
 * them is a thing this fix would be wrong about if the binary disagreed:
 *
 *  1. **Does the description really draw the see-also?** The whole bug rests on
 *     `relateMentions` firing inside `Bd.create` for an id in the body. A fixture that
 *     staged the edge by hand would prove the demotion works on a collision nobody can
 *     actually reach.
 *  2. **Is bd's refusal per *ordered* pair?** Measured 2026-08-17: yes, and it is the
 *     reason both ends are demoted. If bd ever starts refusing on the unordered pair,
 *     the second `dep remove` becomes unnecessary rather than wrong — but if it stops
 *     refusing at all, this whole path is dead code and this file is how anybody finds
 *     out.
 *  3. **Is what is left one edge?** The acceptance criterion, in bd's own words: a
 *     `blocks` between the pair and no `relates-to` in either direction.
 *  4. **Does the prose hook then leave it alone?** Both passes have to be idempotent, or
 *     the next comment naming the same bead puts the collision straight back.
 *
 * Nothing here is shared: a fresh mkdtemp workspace, so it takes no Dolt write lock any
 * other session is waiting on. Skipped loudly where `bd` is not installed, exactly as
 * test/adoptsweepreal.mjs and test/epicedgereal.mjs are — a machine without the tracker
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
const { isRelated } = await import(path.join(HERE, '..', 'lib', 'mentions.js'));

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

console.log('\na declared dependency against the real bd\n');

const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what it accepts cannot be asked here');
  console.log('\n0/0 passed\n');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-declaredreal-'));
const dir = path.join(tmp, '.beads');
fs.mkdirSync(dir, { recursive: true });

// Spawned directly, never through a shell: `~/.zshenv` rewrites BEADS_DIR from the
// shell's cwd, so a shell here would resolve to somebody's actual tracker — and this
// suite deletes edges.
const env = { ...process.env, BEADS_DIR: dir };
const bdRun = (args) => spawnSync('bd', args, { env, cwd: tmp, encoding: 'utf8', timeout: 120_000 });
const saidBy = (r) => `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n')[0];

const init = bdRun(['init', '--skip-agents', '--prefix', 'dr']);
if (init.status !== 0) {
  console.log(`  \x1b[31m✗\x1b[0m a temp workspace can be made to ask in\n      ${saidBy(init)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const ws = { name: 'declaredreal', dir };
const bd = new Bd({ bin: 'bd', actor: 'beadcause' });

/** Every edge out of one bead, `[id, type]`, straight off the binary. */
const out = (id) => {
  const r = bdRun(['dep', 'list', String(id), '--json']);
  try {
    return (JSON.parse(r.stdout) || []).map((x) => [x.id, x.dependency_type]);
  } catch {
    return [];
  }
};
/** Both directions, so "no relates-to between that pair" can be asserted as written. */
const between = (a, b) => [
  ...out(a).filter(([id]) => id === b).map(([, t]) => `${a}>${b} ${t}`),
  ...out(b).filter(([id]) => id === a).map(([, t]) => `${b}>${a} ${t}`),
];

const mk = (title, body) => bd.create(ws, { title, body, type: 'task', priority: 2, labels: [] });

/* ------------------------------------------------- the shape the app asks people to write */

const target = await mk('The seam this needs', 'It stands on its own.');
const dependant = await mk(
  'Waits on the seam',
  `This cannot start until ${target} lands, because it is built on the seam ${target} adds.`
);

check(() => {
  assert.ok(target && dependant, `created ${target} / ${dependant}`);
  assert.deepEqual(
    between(dependant, target).sort(),
    [`${dependant}>${target} relates-to`, `${target}>${dependant} relates-to`].sort()
  );
}, 'a description naming the bead it depends on arrives see-also-linked to it, both ends');

check(() => {
  // The bug, as bd states it. Not asserted through `addDep` — this is the raw binary,
  // so the day it stops refusing, this line is what says so.
  const r = bdRun(['dep', 'add', dependant, target]);
  assert.notEqual(r.status, 0, 'bd allowed a second type on the pair');
  assert.match(saidBy(r), /already exists with type "relates-to"/);
}, 'and bd refuses the dependency that was actually declared');

check(() => {
  // Ordered, not unordered — the measurement the two-row demotion rests on.
  const r = bdRun(['dep', 'add', target, dependant]);
  assert.notEqual(r.status, 0);
  assert.match(saidBy(r), new RegExp(`dependency ${target} -> ${dependant} already exists`));
}, 'from the other side too, and it names the ordered pair rather than the pair');

await (async () => {
  ran += 1;
  try {
    await bd.addDep(ws, dependant, target);
    console.log(`  \x1b[32m✓\x1b[0m Bd.addDep writes it anyway`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m Bd.addDep writes it anyway\n      ${String(err.message).split('\n')[0]}`);
  }
})();

check(() => {
  // The acceptance criterion, in bd's own words: one edge, and it is the declared one.
  assert.deepEqual(between(dependant, target), [`${dependant}>${target} blocks`]);
}, 'and what is left is a blocks edge and no relates-to in either direction');

check(() => {
  assert.ok(
    out(target).every(([, t]) => !isRelated(t)),
    `the far end still holds ${JSON.stringify(out(target))}`
  );
}, 'including the row at the far end, which is the half a one-sided fix leaves behind');

/* ------------------------------------------------------- and the prose pass afterwards */

await (async () => {
  ran += 1;
  const made = await bd.relateMentions(ws, dependant, `still very much about ${target}`);
  try {
    assert.deepEqual(made, []);
    assert.deepEqual(between(dependant, target), [`${dependant}>${target} blocks`]);
    console.log(`  \x1b[32m✓\x1b[0m the prose hook run afterwards leaves it alone`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m the prose hook run afterwards leaves it alone\n      ${err.message}`);
  }
})();

await (async () => {
  ran += 1;
  const other = await mk('Nothing to do with it', 'Alone.');
  const made = await bd.relateMentions(ws, dependant, `worth reading next to ${other}`);
  try {
    assert.deepEqual(made, [other]);
    assert.deepEqual(
      between(dependant, other).sort(),
      [`${dependant}>${other} relates-to`, `${other}>${dependant} relates-to`].sort()
    );
    console.log(`  \x1b[32m✓\x1b[0m and a mention on a pair with no edge still draws one`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m and a mention on a pair with no edge still draws one\n      ${err.message}`);
  }
})();

/* ------------------------------------------------------------------- and what is not a mention */

await (async () => {
  ran += 1;
  const from = await mk('Found while doing it', 'x');
  const seed = await mk('Where it came from', 'y');
  bdRun(['dep', 'add', from, seed, '--type', 'discovered-from']);
  let threw = null;
  try {
    await bd.addDep(ws, from, seed);
  } catch (err) {
    threw = err;
  }
  try {
    assert.ok(threw, 'the declared edge went in over provenance');
    assert.match(String(threw.message), /discovered-from/);
    assert.deepEqual(out(from), [[seed, 'discovered-from']]);
    console.log(`  \x1b[32m✓\x1b[0m provenance is refused, and survives the refusal intact`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m provenance is refused, and survives the refusal intact\n      ${err.message}`);
  }
})();

/* ---------------------------------------------------------------------------- verdict */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ran - failures}/${ran} passed\n`);
if (failures) process.exit(1);
