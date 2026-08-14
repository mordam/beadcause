#!/usr/bin/env node
/**
 * What an epic can and cannot hold — asked of the real bd, not of a stub.
 *
 *     npm test
 *     node test/epicedgereal.mjs
 *
 * **This file used to pin the opposite rule, and the change is the point.** Until bd
 * 1.2.1 a `blocks` edge required epic-ness to match on both ends: `bd dep add <task>
 * <an epic>` was refused with `tasks can only block other tasks, not epics`, and its
 * mirror with `epics can only block other epics, not tasks`. lib/park.js's
 * `questionType` and lib/superseded.js's `edgeFor` are both built around that refusal.
 *
 * bd 1.2.1 (2026-08-11) deleted it — "Cross-type blocking dependencies are now allowed"
 * (bd-wg7ve, PR #4034) — and replaced the blanket same-type rule (GH#1495) with a
 * **hierarchy deadlock guard** that refuses only the two shapes that actually wedge the
 * graph. So the four claims this file exists to hold bd to have moved:
 *
 *   1. **Cross-type blocking is allowed, and it holds.** `bd dep add <task> <an epic>`
 *      goes in, the task leaves `bd ready`, and closing the epic gives it back. This is
 *      the claim lib/park.js's whole `questionType` dance existed to route around, and
 *      it is why one question can now park an epic and a task at once.
 *   2. **The guard refuses ancestor and descendant gating, and nothing else.** An issue
 *      gated on its own parent is refused because children already inherit the parent's
 *      completion; an epic gated on its own descendant is refused because blocked status
 *      cascades down to the very bead that has to close to clear it. Sibling ordering
 *      edges — the ones a park actually draws — stay allowed.
 *   3. **No non-`blocks` edge type holds.** Unchanged, and still the reason
 *      lib/superseded.js cannot swap a `relates-to` in for a hold and pretend: of the
 *      types `--type` accepts, `blocks` is the only one that takes a bead out of
 *      `bd ready`. What changed is *why* `edgeFor` still draws `relates-to` onto an
 *      epic — no longer because bd refuses the blocking edge outright, but because the
 *      common adoption case is an epic adopting its own child, which claim 2 refuses.
 *   4. **A pair holds exactly one edge**, of any type, in either direction, and
 *      **`--status=open` is what puts a claimed bead back in the queue.** Both unchanged.
 *
 * If bd ever restores the same-type rule, or loosens the deadlock guard, this file going
 * red is how anyone finds out — everything in test/park.mjs would go on passing, because
 * it drives a fake `bd` that reproduces the refusal by hand.
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

const probe = spawnSync('bd', ['version'], { encoding: 'utf8' });
if (probe.error) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what it refuses cannot be asked here');
  console.log('\n0/0 passed\n');
  process.exit(0);
}

/**
 * The one skip that is about a *version* rather than an absence.
 *
 * Sections 1 and 2 pin behaviour bd only grew in 1.2.1, so on an older binary they go
 * red — four failures that read like a broken repo and are really a stale Homebrew. The
 * repo's own machine is bumped (bc-xl7n.39); a second Mac, or a checkout someone cloned
 * before bumping, is not, and telling it the truth beats failing it. `bd upgrade` or
 * `brew upgrade beads` is the whole fix, and the line below says so.
 */
const MIN = [1, 2, 1];
const found = (String(probe.stdout || '').match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
const older = found.length === 3 && found.some((n, i) => n !== MIN[i] && n < MIN[i] && found.slice(0, i).every((m, j) => m === MIN[j]));
if (older) {
  console.log(
    `  \x1b[33m—\x1b[0m skipped: this pins bd >= ${MIN.join('.')} and found ${found.join('.')} — ` +
      'cross-type blocking arrived in 1.2.1 (`brew upgrade beads`)'
  );
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

/* ------------------------- 1. the refusal that started bc-28ef, and its deletion in 1.2.1 */

{
  const epic = await make({ type: 'epic', title: 'the epic a task waits on' });
  const gated = await make({ title: 'a task gated on the epic' });
  const added = bdRun(['dep', 'add', gated, epic]);
  check(
    () => assert.equal(added.status, 0, `bd said: ${saidBy(added)}`),
    'bd allows a blocking edge from a task onto an epic — the same-type rule is gone (bd 1.2.1)'
  );

  const held = await readyIds();
  check(
    () => assert.ok(!held.includes(gated), `ready: ${held.join(', ')}`),
    'and the edge really holds — the task is out of bd ready while the epic is open'
  );

  // The other direction, which is the one lib/park.js parks an epic with. Both are the
  // same deleted rule seen from opposite ends, so both are asked.
  const gatedEpic = await make({ type: 'epic', title: 'an epic gated on a task' });
  const blocker = await make({ title: 'the task it waits on' });
  const other = bdRun(['dep', 'add', gatedEpic, blocker]);
  check(
    () => assert.equal(other.status, 0, `bd said: ${saidBy(other)}`),
    'and an epic may be blocked by a task, which is what lets one question park both'
  );

  bdRun(['close', epic]);
  const released = await readyIds();
  check(
    () => assert.ok(released.includes(gated), `ready: ${released.join(', ')}`),
    'and closing the epic gives the task back, so the hold is a gate and not a grave'
  );
}

/* --------------------------------- 2. the guard that replaced it: ancestors and descendants */

{
  const parent = await make({ type: 'epic', title: 'an epic with a child' });
  const child = await bd.create(ws, {
    title: 'its child',
    body: 'x',
    priority: 2,
    type: 'task',
    labels: [],
    parent,
  });

  const onAncestor = bdRun(['dep', 'add', child, parent]);
  check(
    () => assert.notEqual(onAncestor.status, 0, `bd said: ${saidBy(onAncestor)}`),
    'bd refuses gating an issue on its own ancestor'
  );
  check(
    () => assert.match(saidBy(onAncestor), /already a child|deadlock/i),
    'and says the child already inherits the parent, so the edge would deadlock'
  );

  const onDescendant = bdRun(['dep', 'add', parent, child]);
  check(
    () => assert.notEqual(onDescendant.status, 0, `bd said: ${saidBy(onDescendant)}`),
    'and refuses gating an issue on its own descendant'
  );
  check(
    () => assert.match(saidBy(onDescendant), /descendant|cascade/i),
    'and says blocked status cascades down to the bead that has to close to clear it'
  );
}

/* ------------------------------- 3. every other type goes in, and not one of them holds */

{
  // The whole point: if any of these held, `mark` would have a second choice. None does,
  // so a bead marked over an epic it is a child of is out of the queue by its label alone.
  const open = await make({ type: 'epic', title: 'an open epic to edge onto' });
  for (const type of ['tracks', 'relates-to', 'supersedes', 'parent-child', 'discovered-from']) {
    const dup = await make({ title: `a bead edged ${type} to the epic` });
    const added = bdRun(['dep', 'add', dup, open, '--type', type]);
    check(() => assert.equal(added.status, 0, `bd said: ${saidBy(added)}`), `bd allows a ${type} edge onto an epic`);
    const ready = await readyIds();
    check(
      () => assert.ok(ready.includes(dup), `ready: ${ready.join(', ')}`),
      `and a ${type} edge to an open epic holds nothing — the bead is still ready`
    );
  }

  // The control, and the reason the five above mean anything: the one type that holds.
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

/* ---------------------------------------------------- 4. a pair may hold exactly one edge */

{
  const target = await make({ type: 'epic', title: 'an epic a bead was filed from' });
  const dup = await make({ title: 'a bead filed from the epic' });
  bdRun(['dep', 'add', dup, target, '--type', 'discovered-from']);

  const related = bdRun(['dep', 'relate', dup, target]);
  check(() => assert.notEqual(related.status, 0, `bd said: ${saidBy(related)}`), 'a second edge between the same pair is refused');
  check(() => assert.match(saidBy(related), /already exists with type/i), 'in the words `mark` reads as "already linked"');

  const parented = bdRun(['update', dup, `--parent=${target}`]);
  check(
    () => assert.notEqual(parented.status, 0, `bd said: ${saidBy(parented)}`),
    'and --parent is refused by the same rule, which is what makes reparenting cost provenance'
  );
}

/* ------------------------------------ 5. what puts a claimed bead back into the queue */

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
  // `edgeFor` still chooses the see-also for an epic, and after 1.2.1 that is a *choice*
  // rather than a refusal it cannot get past. The reason is section 2: adoption by an
  // epic is usually an epic adopting its own child, and that blocking edge is exactly
  // what the deadlock guard refuses. Pinned here so a future simplification of `edgeFor`
  // has to come past this file and say which case it is claiming.
  const adopter = await make({ type: 'epic', title: 'the epic that covers it' });
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

  const out = mark(sync, dup, adopter, { dupRow: row(dup), originalRow: row(adopter) });
  check(() => assert.equal(out.marked, true, JSON.stringify(out)), 'mark marks a bead superseded by an epic against the real bd');
  check(() => assert.equal(out.edge, RELATED_EDGE, JSON.stringify(out)), 'and draws the see-also it chooses for an epic');
  check(() => assert.equal(out.held, false), 'and does not claim a hold that edge does not give it');
  check(() => assert.equal(out.reopened, true), 'and puts the worker’s claimed bead back to open');

  const after = row(dup);
  check(() => assert.ok((after.labels || []).includes(supersedeLabel(adopter)), `labels: ${(after.labels || []).join(', ')}`), 'the label is on the bead');
  check(() => assert.equal(String(after.status).toLowerCase(), 'open'), 'the status is one the sweep can see');
  check(
    () => assert.ok((after.dependencies || []).some((d) => d.id === adopter && d.dependency_type === RELATED_EDGE), JSON.stringify(after.dependencies)),
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
