#!/usr/bin/env node
/**
 * Moving a bead into another bead-space — lib/movespace.js, against the real `bd`.
 *
 *     npm test
 *     node test/movespace.mjs
 *
 * ## Why this one cannot be a stub suite
 *
 * The whole claim of lib/movespace.js is about what *bd* does with an export it has
 * never seen: whether `bd import` accepts an id whose prefix is foreign to the target,
 * whether comments and labels survive the round trip, whether a `parent-child` edge
 * carried in `dependencies` really re-parents on the far side, and whether a dependency
 * naming a bead the target has never heard of is an error or a shrug. Every one of those
 * is a fact about the binary, and a fake `bd` can only ever confirm what this repo
 * already believes about it — the argument test/closegatereal.mjs makes at length and
 * that this file inherits whole. The half that *is* ours — the id map, the subtree walk,
 * which edges are dropped — is asserted purely at the top, with no tracker at all, so a
 * machine without `bd` still checks the part it can.
 *
 * ## Two workspaces, which is the shape nothing else here needs
 *
 * Every other real-`bd` suite provisions one workspace. This one needs two, because the
 * thing under test is precisely what happens *between* two Dolt databases — and they are
 * given different prefixes (`mv`, `mt`) on purpose, since "the copy is under the target's
 * prefix" is an acceptance criterion and a shared prefix would make it unfalsifiable.
 *
 * ## What the cases cover, and it is the acceptance list line for line
 *
 * The dry run writes nothing; `children: 'move'` takes the subtree and remaps the edges
 * inside it; `children: 'leave'` reparents onto the grandparent; `leave` with no
 * grandparent mints an epic and puts the children under it; comments, labels, status,
 * priority and type all survive; every original is closed and names its successor and
 * none is deleted; and a live window on a bead being moved is a refusal that says which.
 * The one refusal not driven here is the open pull request, which needs `gh` and a
 * checkout — `planMove` takes the rows in the shape lib/inflight.js does, and
 * test/inflight.mjs already owns what that map means.
 *
 * Skipped, loudly, where `bd` is not installed — the pure half still runs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { provisionBdWorkspace } from './helpers/bdtemplate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  CHILD_MODES,
  blockingEdges,
  childrenOf,
  closeReason,
  defaultEpicTitle,
  indexRows,
  mintId,
  moveSpace,
  parentOf,
  publicPlan,
  remapRow,
  subtree,
} = await import(path.join(HERE, '..', 'lib', 'movespace.js'));
const { Bd } = await import(path.join(HERE, '..', 'lib', 'bd.js'));
const { supersedeLabel, supersededBy } = await import(path.join(HERE, '..', 'lib', 'superseded.js'));

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
    bad(name, err.message);
  }
};

console.log('\nmoving a bead into another bead-space\n');

/* ------------------------------------------------------------------ the pure half */

const rowFor = (id, over = {}) => ({
  _type: 'issue',
  id,
  title: `bead ${id}`,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  dependencies: [],
  comments: [],
  ...over,
});

const kid = (id, parent) => rowFor(id, { dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] });

{
  const jsonl = [rowFor('mv-a'), kid('mv-a.1', 'mv-a'), kid('mv-a.1.1', 'mv-a.1'), rowFor('mv-b')]
    .map((r) => JSON.stringify(r))
    .join('\n');
  const rows = indexRows(`${jsonl}\n\n{"_type":"memory","key":"x"}\n{not json}\n`);

  check(() => assert.equal(rows.size, 4), 'indexRows keeps the issues and drops blanks, memories and unparseable lines');
  check(() => assert.equal(parentOf(rows.get('mv-a.1')), 'mv-a'), 'parenthood is read off the parent-child edge, not off the dots');
  check(() => assert.deepEqual(childrenOf(rows, 'mv-a'), ['mv-a.1']), 'childrenOf names only the direct children');
  check(
    () => assert.deepEqual(subtree(rows, 'mv-a'), ['mv-a', 'mv-a.1', 'mv-a.1.1']),
    'subtree is breadth-first with the root first, and stops at the family'
  );
}

{
  // A flat id adopted into a subtree — `bd update --parent` does not renumber, which is
  // exactly why the walk must not read the dots.
  const rows = indexRows([rowFor('mv-a'), kid('mv-zzz9', 'mv-a')].map((r) => JSON.stringify(r)).join('\n'));
  check(() => assert.deepEqual(subtree(rows, 'mv-a'), ['mv-a', 'mv-zzz9']), 'a child with a flat id is still in the subtree');
}

check(() => assert.equal(mintId('mt', 'beadcause', 'bc-ka5y.42'), mintId('mt', 'beadcause', 'bc-ka5y.42')), 'mintId is deterministic, so the dry run names the ids the real run uses');
check(() => assert.notEqual(mintId('mt', 'beadcause', 'bc-ka5y.42'), mintId('mt', 'beadcause', 'bc-ka5y.42', 1)), 'a salt bump mints a different id');
check(() => assert.notEqual(mintId('mt', 'other', 'bc-ka5y.42'), mintId('mt', 'beadcause', 'bc-ka5y.42')), 'the source bead-space is part of the seed');
check(() => assert.match(mintId('mt', 'beadcause', 'bc-ka5y.42'), /^mt-[a-z0-9]{5}$/), 'a minted id has bd’s own shape: prefix, dash, five lowercase base-36 characters');

{
  const map = new Map([
    ['mv-a', 'mt-aaaaa'],
    ['mv-a.1', 'mt-aaaaa.1'],
  ]);
  const dropped = [];
  const row = rowFor('mv-a.1', {
    dependencies: [
      { issue_id: 'mv-a.1', depends_on_id: 'mv-a', type: 'parent-child' },
      { issue_id: 'mv-a.1', depends_on_id: 'mv-outside', type: 'blocks' },
    ],
    comments: [{ id: 'c1', issue_id: 'mv-a.1', author: 'beadcause', text: 'kept' }],
    dependency_count: 2,
    dependent_count: 7,
  });
  const out = remapRow(row, map, dropped);

  check(() => assert.equal(out.id, 'mt-aaaaa.1'), 'remapRow renames the row');
  check(() => assert.deepEqual(out.dependencies.map((d) => d.depends_on_id), ['mt-aaaaa']), 'an edge inside the moving set is remapped');
  check(() => assert.deepEqual(dropped, [{ from: 'mv-a.1', to: 'mv-outside', type: 'blocks' }]), 'an edge to a bead staying behind is dropped and reported');
  check(() => assert.equal(out.comments[0].issue_id, 'mt-aaaaa.1'), 'a comment follows its bead');
  check(() => assert.equal(out.comments[0].text, 'kept'), 'and it carries the text that was the whole point');
  check(() => assert.equal('dependency_count' in out || 'dependent_count' in out, false), 'bd’s own summary counts are left for bd to recompute');
  check(() => assert.equal(row.id, 'mv-a.1'), 'the source row is not mutated, so the plan and the application describe the same thing');
}

{
  const out = remapRow(
    rowFor('mv-a', {
      status: 'in_progress',
      assignee: 'somebody',
      lease_expires_at: '2026-08-28T00:00:00Z',
      heartbeat_at: '2026-08-28T00:00:00Z',
    }),
    new Map([['mv-a', 'mt-aaaaa']])
  );
  check(() => assert.equal('lease_expires_at' in out, false), 'a lease on a window in the old bead-space does not cross');
  check(() => assert.equal('heartbeat_at' in out, false), 'and neither does its heartbeat');
  check(() => assert.equal(out.status, 'in_progress'), 'the status does, because that is what the acceptance asks for');
  check(() => assert.equal(out.assignee, 'somebody'), 'and so does who was working it — that is a fact about the work, not about a process');
}

{
  const rows = indexRows(
    [
      rowFor('mv-a', {
        dependencies: [
          { issue_id: 'mv-a', depends_on_id: 'mv-blocker', type: 'blocks' },
          { issue_id: 'mv-a', depends_on_id: 'mv-cousin', type: 'relates-to' },
          { issue_id: 'mv-a', depends_on_id: 'mv-parent', type: 'parent-child' },
        ],
      }),
      rowFor('mv-b'),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')
  );
  check(
    () => assert.deepEqual(blockingEdges(rows, ['mv-a', 'mv-b']), [{ from: 'mv-a', to: 'mv-blocker' }]),
    'only the blocking edge comes off before a close — `blocks` is the one type bd polices'
  );
}

check(() => assert.deepEqual(CHILD_MODES, ['move', 'leave']), 'there are two child modes and nothing else is one');
check(() => assert.match(closeReason('mt', 'mt-aaaaa'), /mt\/mt-aaaaa/), 'the close reason names where the bead went');
check(() => assert.match(defaultEpicTitle({ title: 'a thing' }), /a thing/), 'the minted epic is titled after the bead that left');

/* --------------------------------------------------------------- against the real bd */

const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped the tracker half: no `bd` on PATH, so what it imports cannot be asked here');
  console.log(`\n${failures ? `${failures}/${ran} failed` : `${ran}/${ran} passed`}\n`);
  process.exit(failures ? 1 : 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-movespace-'));
const srcRoot = path.join(tmp, 'src');
const dstRoot = path.join(tmp, 'dst');
fs.mkdirSync(srcRoot);
fs.mkdirSync(dstRoot);

const provisioned = [
  provisionBdWorkspace({ prefix: 'mv', destRoot: srcRoot }),
  provisionBdWorkspace({ prefix: 'mt', destRoot: dstRoot }),
];
if (provisioned.some((p) => !p.ok)) {
  bad('two temp workspaces can be made to move between', provisioned.map((p) => p.reason).filter(Boolean).join('; '));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${failures}/${ran} failed\n`);
  process.exit(1);
}

const bd = new Bd({ bin: 'bd', actor: 'beadcause' });
const from = { name: 'movesrc', dir: path.join(srcRoot, '.beads') };
const to = { name: 'movedst', dir: path.join(dstRoot, '.beads') };
const make = (ws, over = {}) =>
  bd.create(ws, { title: 'a bead', body: 'x', priority: 2, type: 'task', labels: [], ...over });

const show = async (ws, id) => {
  try {
    return await bd.show(ws, id);
  } catch {
    return null;
  }
};

/**
 * Who a bead's parent is, **according to `bd show`** — which is not the shape
 * `parentOf` reads, and finding that out cost this suite a round of red.
 *
 * `bd export` puts parenthood in `dependencies[]` as `{issue_id, depends_on_id, type:
 * 'parent-child'}`. `bd show --json` puts it in a top-level `parent` field and rewrites
 * `dependencies[]` into a list of the *neighbours themselves* — `{id, title, …,
 * dependency_type}` — with no `depends_on_id` anywhere in it. So `parentOf` is correct on
 * an export row and silently answers `''` on a show row, which reads as "this bead is a
 * root" about a bead that is not one. lib/movespace.js only ever hands it export rows;
 * this is the assertion side, and it has to ask the other way round.
 */
const parentSeenBy = (row) => String(row?.parent || '').trim();

/* ------------------------------------------- leave: the children go to the grandparent */

{
  const epic = await make(from, { type: 'epic', title: 'the epic that stays' });
  const bead = await make(from, { parent: epic, title: 'the bead that leaves', body: 'the description', priority: 1 });
  const one = await make(from, { parent: bead, title: 'first child' });
  const two = await make(from, { parent: bead, title: 'second child' });
  await bd.addLabel(from, bead, 'tracker');
  await bd.comment(from, bead, 'a comment that has to survive the crossing');

  const dry = await moveSpace(bd, { from, to, id: bead, children: 'leave', dryRun: true });
  const newId = new Map(dry.map).get(bead);

  check(() => assert.equal(dry.ok, true), 'the dry run plans a move it can make');
  check(() => assert.equal(dry.applied, false), 'a dry run applies nothing');
  check(() => assert.deepEqual(dry.moving, [bead]), 'with children left, only the one bead crosses');
  check(() => assert.match(newId || '', /^mt-/), 'and it is given an id under the target’s prefix');
  check(() => assert.deepEqual(dry.leaving.map((l) => l.id).sort(), [one, two].sort()), 'the plan names both children that stay');
  check(() => assert.deepEqual([...new Set(dry.leaving.map((l) => l.to))], [epic]), 'and says they land on the grandparent');
  check(() => assert.equal(dry.epic, null), 'no epic is minted when there is already something above');
  check(() => assert.equal('rows' in publicPlan(dry), false), 'publicPlan strips the export index before anything reaches the wire');

  check(() => assert.equal(fs.existsSync(to.dir), true), 'the target workspace is there to look in');
  const before = await show(to, newId);
  check(() => assert.equal(before, null), 'and the dry run really did write nothing into it');

  const done = await moveSpace(bd, { from, to, id: bead, children: 'leave' });
  check(() => assert.deepEqual(done.problems, []), `the move goes through cleanly (${JSON.stringify(done.problems)})`);
  check(() => assert.equal(new Map(done.map).get(bead), newId), 'the real run mints exactly the id the dry run named');

  const copy = await show(to, newId);
  check(() => assert.equal(copy?.title, 'the bead that leaves'), 'the copy carries the title');
  check(() => assert.equal(copy?.description, 'the description'), 'and the description');
  check(() => assert.equal(copy?.priority, 1), 'and the priority');
  check(() => assert.equal((copy?.labels || []).includes('tracker'), true), 'and the labels');
  const thread = await bd.comments(to, newId);
  check(
    () => assert.equal(thread.some((c) => String(c.text || '').includes('has to survive the crossing')), true),
    'and the thread, which is the whole reason this is an import rather than a create'
  );
  check(() => assert.equal(parentSeenBy(copy), ''), 'the copy lands as a root, because no parent edge reaches another bead-space');

  const original = await show(from, bead);
  check(() => assert.equal(original?.status, 'closed'), 'the original is closed rather than deleted');
  check(() => assert.equal(supersededBy(original), `${to.name}/${newId}`), 'and it names its successor, workspace-qualified');
  check(() => assert.match(String(original?.close_reason || ''), /Moved to/), 'and its close reason says where it went');

  const kids = await Promise.all([show(from, one), show(from, two)]);
  check(
    () => assert.deepEqual(kids.map((k) => parentSeenBy(k)), [epic, epic]),
    'both children stayed behind, under the grandparent, with their ids unchanged'
  );
  check(() => assert.deepEqual(kids.map((k) => k?.status), ['open', 'open']), 'and they are still open work');
}

/* --------------------------------------------- leave, with nothing above: an epic is minted */

{
  const bead = await make(from, { title: 'a root that leaves' });
  const child = await make(from, { parent: bead, title: 'the orphan-to-be' });

  const dry = await moveSpace(bd, { from, to, id: bead, children: 'leave', dryRun: true });
  check(() => assert.equal(dry.epic?.needed, true), 'with nothing above it, the plan says an epic is needed');
  check(() => assert.match(dry.epic?.title || '', /a root that leaves/), 'titled after the bead that is leaving');

  const done = await moveSpace(bd, { from, to, id: bead, children: 'leave', epicTitle: 'somewhere for the children' });
  check(() => assert.deepEqual(done.problems, []), `the move goes through cleanly (${JSON.stringify(done.problems)})`);
  check(() => assert.match(done.epicId || '', /^mv-/), 'and an epic was really created, in the old bead-space');

  const minted = await show(from, done.epicId);
  check(() => assert.equal(minted?.title, 'somewhere for the children'), 'with the title the caller asked for');
  check(() => assert.equal(String(minted?.issue_type || '').toLowerCase(), 'epic'), 'and it is an epic, so hasRootAbove treats it as a root');
  const orphan = await show(from, child);
  check(() => assert.equal(parentSeenBy(orphan), done.epicId), 'the child ended up under it');
  const departed = await show(from, bead);
  check(() => assert.equal(departed?.status, 'closed'), 'and the departing bead closed over nothing open');
}

/* ------------------------------------------------- move: the whole subtree crosses together */

{
  const bead = await make(from, { title: 'a family that moves together' });
  const child = await make(from, { parent: bead, title: 'travelling child' });
  const stays = await make(from, { title: 'a bead that stays put' });
  await bd.addDep(from, child, stays);

  const done = await moveSpace(bd, { from, to, id: bead, children: 'move' });
  const map = new Map(done.map);
  check(() => assert.deepEqual(done.problems, []), `the move goes through cleanly (${JSON.stringify(done.problems)})`);
  check(() => assert.equal(done.moving.length, 2), 'both beads crossed');
  check(() => assert.equal(map.get(child), `${map.get(bead)}.${child.slice(bead.length + 1)}`), 'the child keeps its position under the new root');

  const copiedChild = await show(to, map.get(child));
  check(() => assert.equal(copiedChild?.title, 'travelling child'), 'the child arrived');
  check(
    () => assert.equal(parentSeenBy(copiedChild), map.get(bead)),
    'and its parent edge points at the new root, not the old one'
  );
  check(
    () => assert.equal((copiedChild?.dependencies || []).some((d) => String(d.depends_on_id).startsWith('mv-')), false),
    'no edge on the copy still names a bead in the other tracker'
  );
  check(
    () => assert.deepEqual(done.droppedEdges.map((d) => d.to), [stays]),
    'and the one edge that could not cross is reported rather than silently gone'
  );
  const untouched = await show(from, stays);
  check(() => assert.equal(untouched?.status, 'open'), 'the bead it pointed at is untouched and still holds its half');

  const originals = await Promise.all([show(from, bead), show(from, child)]);
  check(() => assert.deepEqual(originals.map((o) => o?.status), ['closed', 'closed']), 'both originals are closed');
  check(
    () => assert.deepEqual(originals.map((o) => supersededBy(o)), [`${to.name}/${map.get(bead)}`, `${to.name}/${map.get(child)}`]),
    'and each names its own successor'
  );
}

/* ----------------------------------- move, with a child whose id is not under the parent's */

{
  // `bd update --parent` does not renumber, so this is the ordinary shape of a bead that
  // was adopted rather than born under its parent — and slicing a prefix it never had off
  // its id is how you get `mt-x1y2zzz9`.
  const bead = await make(from, { title: 'a parent by adoption' });
  const adopted = await make(from, { title: 'a child with a flat id of its own' });
  await bd.adopt(from, adopted, bead);

  const moved = await moveSpace(bd, { from, to, id: bead, children: 'move' });
  const map = new Map(moved.map);
  check(() => assert.deepEqual(moved.problems, []), `the move goes through cleanly (${JSON.stringify(moved.problems)})`);
  check(() => assert.equal(moved.moving.includes(adopted), true), 'the adopted child is in the moving set');
  check(
    () => assert.match(map.get(adopted) || '', /^mt-[a-z0-9]{5}$/),
    'and it is minted a root-shaped id of its own rather than having a prefix it never had sliced off'
  );

  const copy = await show(to, map.get(adopted));
  check(() => assert.equal(copy?.title, 'a child with a flat id of its own'), 'it really arrived under that id');
  check(() => assert.equal(parentSeenBy(copy), map.get(bead)), 'and its parent-child edge carries the parenthood, exactly as it did on this side');
}

/* -------------------------------------- move, with a descendant that is already finished */

{
  const bead = await make(from, { title: 'a bead with finished work under it' });
  const done = await make(from, { parent: bead, title: 'work that is already finished' });
  await bd.close(from, done, 'Landed as #1.');

  const moved = await moveSpace(bd, { from, to, id: bead, children: 'move' });
  const map = new Map(moved.map);
  check(() => assert.deepEqual(moved.problems, []), `the move goes through cleanly (${JSON.stringify(moved.problems)})`);
  check(() => assert.equal(moved.moving.length, 2), 'a closed descendant crosses too — the record of finished work is part of the family');

  const copy = await show(to, map.get(done));
  check(() => assert.equal(copy?.status, 'closed'), 'and it arrives closed');
  check(() => assert.match(String(copy?.close_reason || ''), /Landed as #1/), 'still carrying the reason it actually closed for');

  const original = await show(from, done);
  check(() => assert.equal(supersededBy(original), `${to.name}/${map.get(done)}`), 'the closed original is marked all the same');
  check(
    () => assert.match(String(original?.close_reason || ''), /Landed as #1/),
    'and it was not re-closed, so its own close reason still says what happened rather than that it moved'
  );
}

/* ------------------------------------------------------------------------- the refusals */

{
  const bead = await make(from, { title: 'a bead a window is working' });
  // The qualified form is what a worker brief actually carries, and `alive(pid)` drops a
  // row for a process that is gone — so the pid has to be one that really exists.
  const ps = async () => `${process.pid} claude -- You are working bead **${from.name}/${bead}** and here is the brief\n`;
  const out = await moveSpace(bd, { from, to, id: bead, children: 'leave', ps });

  check(() => assert.equal(out.ok, false), 'a live window on the bead refuses the move');
  check(() => assert.match(out.refused, new RegExp(bead)), 'and the refusal names which bead');
  check(() => assert.match(out.refused, /window is working it/), 'and says what is in the way');
  const untouched = await show(from, bead);
  check(() => assert.equal(untouched?.status, 'open'), 'and nothing was written');
}

{
  const bead = await make(from, { title: 'a bead with a bad request against it' });
  const same = await moveSpace(bd, { from, to: from, id: bead });
  check(() => assert.match(same.refused, /already where that bead lives/), 'moving a bead into its own bead-space is refused');

  const mode = await moveSpace(bd, { from, to, id: bead, children: 'scatter' });
  check(() => assert.match(mode.refused, /children may be/), 'an unknown children mode is refused');

  const gone = await moveSpace(bd, { from, to, id: 'mv-nope' });
  check(() => assert.match(gone.refused, /no bead mv-nope/), 'a bead that is not there is refused by name');

  const notAnId = await moveSpace(bd, { from, to, id: 'not an id' });
  check(() => assert.match(notAnId.refused, /is not a bead id/), 'and so is something that is not an id at all');
}

{
  // The marker is what holds a bead out of every queue, and the spelling has to be the
  // one lib/superseded.js reads back — a move that wrote its own would hold nothing.
  // Every row, not just the closed ones: a marked bead that would not close is exactly
  // the failure worth seeing here, and asking only the closed half would hide it.
  const rows = await bd.listAll(from);
  const marked = rows.filter((r) => (r.labels || []).some((l) => String(l).startsWith('superseded-by:')));
  check(() => assert.equal(marked.length >= 4, true, `found ${marked.length}`), 'every original this suite moved carries a marker');
  check(
    () => assert.deepEqual(marked.filter((r) => r.status !== 'closed').map((r) => r.id), []),
    'and none of them was left marked but open, which is the state nothing ever asks about'
  );
  check(
    () => assert.equal(marked.every((r) => supersededBy(r).startsWith(`${to.name}/`)), true),
    'and every one of them is workspace-qualified, because the successor is in another tracker'
  );
  check(
    () => assert.equal(marked.every((r) => (r.labels || []).includes(supersedeLabel(supersededBy(r)))), true),
    'written with supersedeLabel’s own spelling'
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures ? `${failures}/${ran} failed` : `${ran}/${ran} passed`}\n`);
process.exit(failures ? 1 : 0);
