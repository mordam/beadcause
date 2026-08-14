#!/usr/bin/env node
/**
 * What an epic can and cannot hold — asked of the real bd, not of a stub.
 *
 *     npm test
 *     node test/epicedgereal.mjs
 *
 * lib/superseded.js's `mark` rests on four claims about the binary, and every one of
 * them is the kind a fixture would happily confirm while being wrong:
 *
 *   1. **`bd dep add <task> <an epic>` is refused.** The same one-line rule lib/park.js
 *      is built around, from the other side. This is bc-28ef: a bead superseded by an
 *      epic took the label and no edge, and nothing said so.
 *   2. **No other edge type can stand in for the hold.** Of the ten types `--type`
 *      accepts, `blocks` is the only one bd polices across the epic boundary — and the
 *      only one that takes a bead out of `bd ready`. The refusal and the hold are the
 *      same property, so there is no clever second choice.
 *   3. **A pair holds exactly one edge**, of any type, in either direction. Any existing
 *      edge — the `discovered-from` `bin/file.js --from` leaves behind is the common one
 *      — makes every other type refuse, `bd update --parent` included.
 *   4. **`--status=open` is what puts a claimed bead back in the queue.** `bd ready` is
 *      open rows only, so a marked bead left `in_progress` by the worker that marked it
 *      is invisible to `readySuperseded` forever: held, with nobody ever asked.
 *
 * Claim 2 is the one worth the wall clock. It is what makes `mark` draw a `relates-to`
 * edge and then *say* the bead is held by the marker rather than by the graph — and if
 * bd ever grew a non-blocks type that holds, this file going red is how anyone would
 * find out, because everything in test/superseded.mjs would go on passing.
 *
 * Nothing here is shared: a fresh mkdtemp workspace, so it takes no Dolt write lock any
 * other session is waiting on. Skipped loudly where `bd` is not installed, exactly as
 * test/closegatereal.mjs and test/attribution.mjs are — a machine without the tracker
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
const { mark, supersedeLabel, HOLDING_EDGE, RELATED_EDGE } = await import(
  path.join(HERE, '..', 'lib', 'superseded.js')
);

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, String(err.message).split('\n').slice(0, 6).join('\n      '));
  }
};

console.log('\nwhat an epic can hold, against the real bd\n');

const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what it refuses cannot be asked here');
  console.log('\n0/0 passed\n');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-epicedge-'));
const dir = path.join(tmp, '.beads');
fs.mkdirSync(dir, { recursive: true });

// Spawned directly, never through a shell: `~/.zshenv` rewrites BEADS_DIR from the
// shell's cwd, so a shell here would resolve to somebody's actual tracker.
const env = { ...process.env, BEADS_DIR: dir };
const bdRun = (args) => spawnSync('bd', args, { env, cwd: tmp, encoding: 'utf8', timeout: 120_000 });
const saidBy = (r) => `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n')[0];

const init = bdRun(['init', '--skip-agents', '--prefix', 'ee']);
if (init.status !== 0) {
  bad('a temp workspace can be made to ask in', saidBy(init));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${failures}/${ran} failed\n`);
  process.exit(1);
}

const bd = new Bd({ bin: 'bd', actor: 'beadcause' });
const ws = { name: 'epicedgereal', dir };
const make = (over = {}) => bd.create(ws, { title: 'a bead', body: 'x', priority: 2, type: 'task', labels: [], ...over });

/** Every id `bd ready` returns right now — the only question that matters about a hold. */
const readyIds = async () => (await bd.ready(ws, { excludeLabels: [] })).map((r) => r.id);

const epic = await make({ type: 'epic', title: 'the epic that adopted it' });

/* ------------------------------------------------- 1. the refusal that started bc-28ef */

{
  const dup = await make({ title: 'the duplicate' });
  const refused = bdRun(['dep', 'add', dup, epic]);
  check(() => assert.notEqual(refused.status, 0, `bd said: ${saidBy(refused)}`), 'bd refuses a blocking edge from a task onto an epic');
  check(() => assert.match(saidBy(refused), /can only block/i), 'and says so in the words lib/superseded.js quotes');
}

/* ------------------------------- 2. every other type goes in, and not one of them holds */

{
  // The whole point: if any of these held, `mark` would use it instead of admitting the
  // bead is out of the queue by its label alone.
  for (const type of ['tracks', 'relates-to', 'supersedes', 'parent-child', 'discovered-from']) {
    const dup = await make({ title: `a bead edged ${type} to the epic` });
    const added = bdRun(['dep', 'add', dup, epic, '--type', type]);
    check(() => assert.equal(added.status, 0, `bd said: ${saidBy(added)}`), `bd allows a ${type} edge onto an epic`);
    const ready = await readyIds();
    check(
      () => assert.ok(ready.includes(dup), `ready: ${ready.join(', ')}`),
      `and a ${type} edge to an open epic holds nothing — the bead is still ready`
    );
  }

  // The control, and the reason the five above mean anything: the one type bd polices is
  // the one type that holds. Between two tasks, where bd permits it.
  const blocker = await make({ title: 'an ordinary blocker' });
  const held = await make({ title: 'a bead behind it' });
  const added = bdRun(['dep', 'add', held, blocker, '--type', HOLDING_EDGE]);
  check(() => assert.equal(added.status, 0, `bd said: ${saidBy(added)}`), `a ${HOLDING_EDGE} edge between two tasks goes in`);
  const ready = await readyIds();
  check(
    () => assert.ok(!ready.includes(held) && ready.includes(blocker), `ready: ${ready.join(', ')}`),
    `and it is the only one that takes the bead out of bd ready`
  );
}

/* ---------------------------------------------------- 3. a pair may hold exactly one edge */

{
  const dup = await make({ title: 'a bead filed from the epic' });
  bdRun(['dep', 'add', dup, epic, '--type', 'discovered-from']);

  const related = bdRun(['dep', 'relate', dup, epic]);
  check(() => assert.notEqual(related.status, 0, `bd said: ${saidBy(related)}`), 'a second edge between the same pair is refused');
  check(() => assert.match(saidBy(related), /already exists with type/i), 'in the words `mark` reads as "already linked"');

  const parented = bdRun(['update', dup, `--parent=${epic}`]);
  check(
    () => assert.notEqual(parented.status, 0, `bd said: ${saidBy(parented)}`),
    'and --parent is refused by the same rule, which is what makes reparenting cost provenance'
  );
}

/* ------------------------------------ 4. what puts a claimed bead back into the queue */

{
  const dup = await make({ title: 'a bead a worker claimed' });
  bdRun(['update', dup, '--claim']);
  const claimed = await readyIds();
  check(() => assert.ok(!claimed.includes(dup), `ready: ${claimed.join(', ')}`), 'a claimed bead is out of bd ready');

  bdRun(['update', dup, '--status=open']);
  const back = await readyIds();
  check(
    () => assert.ok(back.includes(dup), `ready: ${back.join(', ')}`),
    'and --status=open alone puts it back, assignee still set — which is the write mark makes'
  );
}

/* ------------------------------------------- and `mark` itself, driving the real binary */

{
  const dup = await make({ title: 'the bead the epic covers' });
  bdRun(['update', dup, '--claim']);
  const row = (id) => {
    const out = JSON.parse(bdRun(['show', id, '--json']).stdout);
    return Array.isArray(out) ? out[0] : out;
  };
  const sync = (args) => {
    const r = bdRun(args);
    if (r.status !== 0) throw Object.assign(new Error('Command failed: bd'), { stderr: r.stderr, stdout: r.stdout });
    return r.stdout;
  };

  const out = mark(sync, dup, epic, { dupRow: row(dup), originalRow: row(epic) });
  check(() => assert.equal(out.marked, true, JSON.stringify(out)), 'mark marks a bead superseded by an epic against the real bd');
  check(() => assert.equal(out.edge, RELATED_EDGE, JSON.stringify(out)), 'and draws the see-also bd will actually accept');
  check(() => assert.equal(out.held, false), 'and does not claim a hold bd cannot give it');
  check(() => assert.equal(out.reopened, true), 'and puts the worker’s claimed bead back to open');

  const after = row(dup);
  check(() => assert.ok((after.labels || []).includes(supersedeLabel(epic)), `labels: ${(after.labels || []).join(', ')}`), 'the label is on the bead');
  check(() => assert.equal(String(after.status).toLowerCase(), 'open'), 'the status is one the sweep can see');
  check(
    () => assert.ok((after.dependencies || []).some((d) => d.id === epic && d.dependency_type === RELATED_EDGE), JSON.stringify(after.dependencies)),
    'and the graph records which bead covered it, which is what bc-28ef was about'
  );

  const swept = await bd.readySuperseded(ws);
  check(
    () => assert.ok(swept.some((r) => r.id === dup), `readySuperseded: ${swept.map((r) => r.id).join(', ')}`),
    'the sweep can see it, so the close card is raised when the epic closes'
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
