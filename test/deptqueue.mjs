/**
 * **Department capacity** — the first thing a relay does to *dispatch* rather than to a
 * brief, and the first number in this program that a repo gets to write.
 *
 * bc-ogicx.6. Until now the queue picked the bead and the chain was computed afterwards at
 * launch, so a department with four beads near the top of one workspace's queue could take
 * every window the workspace had and a department with one could wait all day. A department
 * may now declare `capacity: N` in its own `.beadcause/relays.yaml`, and `candidates` drops
 * a bead whose department is already at it.
 *
 *     node test/deptqueue.mjs
 *
 * Four things this suite is here to hold, and each of them is a way the feature goes wrong
 * in a direction nobody would see:
 *
 *   - **the department comes from the graph, not from the queue row.** `bd ready --json`
 *     carries no `assignee` at all, so a filter reading the row could only ever see a
 *     `dept:` label — a ceiling that applied to labelled beads and silently not to the
 *     rest. And a graph that would not answer means *no cap*, never an empty one.
 *   - **both sides of the count ask the same question.** A bead gets a ceiling only where
 *     it would get a chain, because a window with no chain records no department and could
 *     never be counted as occupying one. The asymmetry — hold on a label, count on a chain
 *     — is a cap that subtracts for ever.
 *   - **within the tick as well as across it.** A tick opens several windows from the top
 *     of one list, so a ceiling counted only against *running* windows binds on a quiet
 *     tick and not on a busy one, which is backwards.
 *   - **a definition that will not load is said out loud and holds nothing.** Its beads
 *     dispatch exactly as they did before the file existed. bc-ogicx.5 carried the sentence
 *     as far as the launcher and stopped; this is where it stops dying.
 *
 * Built on test/repoqueue.mjs's harness — `open` is injected, so a tick that would have
 * opened an iTerm window pushes a record onto an array instead. What is *not* faked is the
 * relay resolution: the fake `open` calls the real `relayDefFor` + `chainIn`, which is what
 * lib/session.js does at the same moment, so a window's recorded department is the whole
 * chain from a YAML file on disk rather than a string this file made up. That the launcher
 * really does resolve it that way is pinned separately, on the source, at the end.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
import { quiesce, removeTree } from './helpers/tmp.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-deptqueue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
fs.mkdirSync(SESSIONS, { recursive: true });

/** One checkout, which is what every workspace but Climative is. */
const REPO = path.join(tmp, 'projects', 'studio');
fs.mkdirSync(path.join(REPO, '.beadcause'), { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { chainIn } = await import(LIB('relay.js'));
const { relayDefFor, forgetRelayDefs, deptCapacityFor, departmentsFor, withinCapacity } = await import(
  LIB('relaydefs.js')
);

/* ------------------------------------------------------------------ fixtures */

/**
 * deluvia's shape in miniature: two producing departments, one of them capped at a single
 * window, and one executive role that is in no department at all.
 */
const DEFINITION = `
relays:
  studio:
    filer: ward
    executive: [vox]
    departments:
      dept:story:
        lead: aria
        members: [aria, clio]
        check: [muse]
        capacity: 1
      dept:design:
        lead: lens
        members: [lens, palette]
        check: [clio]
`;

const writeDefinition = (text) => {
  fs.writeFileSync(path.join(REPO, '.beadcause', 'relays.yaml'), text);
  // The read is memoised by path and mtime, and two cases a millisecond apart share a
  // stamp — the daemon never rewrites one of these mid-second, and a suite does.
  forgetRelayDefs();
};

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, title, labels = [], over = {}) => ({
  id,
  title,
  priority: 2,
  issue_type: 'task',
  created_at: OLD,
  labels,
  ...over,
});

/** The `bd export` index, in the only two fields anything here reads off it. */
const graphOf = (rows) => ({
  parents: new Map(),
  adopts: new Map(),
  edges: new Map(),
  beads: new Map(
    Object.entries(rows).map(([id, r]) => [
      id,
      { id, title: '', status: 'open', assignee: r.assignee || '', labels: r.labels || [] },
    ])
  ),
});

/**
 * One tick against one checkout.
 *
 * `assignees` is the graph's half and `ready` is the queue's, deliberately separate: the
 * whole point of the first assertion below is that these are two different reads and only
 * one of them carries a role.
 */
async function tick({ ready = [], assignees = {}, graph = true, workers = 2, ticks = 1, overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case — see test/repoqueue.mjs for why `quiesce` rather than a bare
  // recursive unlink: every write of `advocates.json` schedules a common-repo commit a
  // couple of seconds out, and rmdir on a directory that gained a file is ENOTEMPTY.
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    spaces: [],
    workspaces: [{ name: 'studio', dir: path.join(os.homedir(), 'beads', 'studio', '.beads') }],
    sessionDirs: { studio: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: workers,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Everything with a suite of its own, each of which would otherwise run real git, a
      // real `gh` or a real agent against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      sessionLog: false,
      planEpics: false,
      holdOpenPrs: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const opened = [];
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => [],
    // `null` is a tracker that would not answer this tick, which `tickGraph` reads as its
    // own kind of silence — the case the cap has to fail open on.
    graph: async () => (graph ? graphOf(assignees) : null),
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    // The real relay resolution, the same two calls lib/session.js makes at the same
    // moment: a fake that invented a department could not tell a working chain from a
    // string. `row` is the launcher's `bd show` row there and the graph row here, which
    // carries the same two fields the chain is derived from.
    open: async (c, ws, b) => {
      const subject = { assignee: assignees[b.id]?.assignee || '', labels: b.labels || [] };
      const { def } = relayDefFor(c, ws.name, REPO, subject);
      const relay = chainIn(def, ws.name, subject);
      opened.push({ id: b.id, dept: relay?.dept || null });
      return { dir: REPO, mode: 'test', term: null, dept: relay?.dept || null, relayProblem: null };
    },
    openPlan: async () => {
      throw new Error('openPlan must not be reached with planEpics off');
    },
  });
  // Captured rather than silenced, because "a full department must not fill the log" is a
  // property with a case of its own below and no other way to observe it. `ticks` runs the
  // same advocate more than once, which is what makes a *spell* of being held distinguishable
  // from a single tick's worth of it.
  const said = [];
  const wasLog = console.log;
  console.log = (...args) => {
    said.push(args.join(' '));
  };
  try {
    for (let i = 0; i < ticks; i += 1) await advocates.tick();
  } finally {
    console.log = wasLog;
  }
  return { opened, said, card: advocates.snapshot().find((a) => a.workspace === 'studio') };
}

const openedIds = (r) => r.opened.map((o) => o.id).sort();
const heldIds = (card) => (card.heldByDept || []).map((h) => h.id).sort();

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

writeDefinition(DEFINITION);

/* ------------------------------------------------- the rule, on its own terms */

await check('a department states its own ceiling; a relay cannot', async () => {
  const story = deptCapacityFor({}, 'studio', REPO, { assignee: 'aria' });
  assert.equal(story.dept, 'dept:story');
  assert.equal(story.capacity, 1, 'read off the department block');

  // Design states no `capacity:`, and that is not zero — it is *no ceiling*. The two are
  // one line apart in a file and opposite answers.
  const design = deptCapacityFor({}, 'studio', REPO, { assignee: 'lens' });
  assert.equal(design.dept, 'dept:design');
  assert.equal(design.capacity, null, 'an unstated capacity is no ceiling, not a ceiling of nothing');

  // And nothing above a department may state one: `capacity` at the relay level is an
  // unknown key, which refuses the whole file rather than being ignored.
  const at = path.join(tmp, 'refuses');
  fs.mkdirSync(path.join(at, '.beadcause'), { recursive: true });
  fs.writeFileSync(
    path.join(at, '.beadcause', 'relays.yaml'),
    'relays:\n  studio:\n    capacity: 3\n    departments:\n      dept:story:\n        members: [aria]\n'
  );
  forgetRelayDefs();
  const { problem } = deptCapacityFor({}, 'studio', at, { assignee: 'aria' });
  assert.match(String(problem), /unknown key "capacity"/, 'a relay-level capacity refuses the file');
  forgetRelayDefs();
});

await check('a ceiling is only ever a ceiling — nothing here can raise one', async () => {
  // Four candidates, capacity 1, nothing running: three are held. There is no arrangement
  // of a `capacity:` that produces *more* kept rows than the list handed in, which is the
  // whole reason a branch is allowed to write one.
  const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id, dept: 'dept:story', capacity: 1 }));
  const { kept, held } = withinCapacity(rows, { open: [] });
  assert.equal(kept.length, 1);
  assert.equal(held.length, 3);

  const generous = withinCapacity(rows, { open: [] }).kept.length;
  const wider = withinCapacity(
    rows.map((r) => ({ ...r, capacity: 99 })),
    { open: [] }
  ).kept.length;
  assert.equal(wider, rows.length, 'a large capacity keeps everything and adds nothing');
  assert.ok(generous <= rows.length && wider <= rows.length, 'never more rows out than in');
});

await check('the ceiling binds within one tick, not only across ticks', async () => {
  // The failure this catches: a tick opens `min(free, globalFree, ready)` windows straight
  // down the list, so counting only *running* windows would let three windows into a
  // department capped at one, in one tick, and the next tick would find it over its own
  // ceiling with nothing able to say how.
  const rows = [
    { id: 'a', dept: 'dept:story', capacity: 2 },
    { id: 'b', dept: 'dept:story', capacity: 2 },
    { id: 'c', dept: 'dept:story', capacity: 2 },
  ];
  const { kept, held } = withinCapacity(rows, { open: [] });
  assert.deepEqual(kept.map((k) => k.id), ['a', 'b'], 'two, in pick order');
  assert.deepEqual(held.map((h) => h.id), ['c']);
  assert.match(held[0].why, /this same tick/, 'and it says which of the two is holding it');
  assert.equal(held[0].open, 0, 'no window is running, and the sentence must not claim one is');
  assert.equal(held[0].tick, 2);
});

await check('a running window and a same-tick sibling are counted, and told apart', async () => {
  const one = withinCapacity([{ id: 'b', dept: 'dept:story', capacity: 1 }], { open: ['dept:story'] });
  assert.equal(one.kept.length, 0);
  assert.match(one.held[0].why, /already open/);
  assert.equal(one.held[0].open, 1);

  const both = withinCapacity(
    [
      { id: 'b', dept: 'dept:story', capacity: 2 },
      { id: 'c', dept: 'dept:story', capacity: 2 },
    ],
    { open: ['dept:story'] }
  );
  assert.deepEqual(both.kept.map((k) => k.id), ['b']);
  assert.match(both.held[0].why, /1 window\(s\) open and 1 more/, 'both halves of the count, in one sentence');

  // Another department's window is not this one's business.
  const elsewhere = withinCapacity([{ id: 'b', dept: 'dept:story', capacity: 1 }], { open: ['dept:design'] });
  assert.equal(elsewhere.kept.length, 1, 'a full Design does not hold a Story bead');
});

await check('capacity: 0 is a department switched off, and says so', async () => {
  const { kept, held } = withinCapacity([{ id: 'a', dept: 'dept:story', capacity: 0 }], { open: [] });
  assert.equal(kept.length, 0);
  assert.match(held[0].why, /switched off/);
  // And it must not read as a wait: nothing is running, so "1 window open" would send
  // somebody looking for a window that is not there.
  assert.doesNotMatch(held[0].why, /already open/);
});

await check('no department and no capacity are both kept, and count against nothing', async () => {
  const { kept, held } = withinCapacity(
    [
      { id: 'a', dept: null, capacity: null },
      { id: 'b', dept: 'dept:design', capacity: null },
      { id: 'c', dept: 'dept:story', capacity: 1 },
    ],
    { open: [] }
  );
  assert.deepEqual(kept.map((k) => k.id), ['a', 'b', 'c'], 'every bead in every workspace today');
  assert.equal(held.length, 0);
});

/* ------------------------------------ where a department comes from, per bead */

await check('a chain is what puts a bead under a ceiling — a label on its own is not', async () => {
  // The asymmetry this refuses. `departmentOf` matches any label against the department
  // keys, so a bead carrying `dept:story` with a *person* for an assignee looks like Story
  // work — but its window resolves no chain, records no department, and could never be
  // counted as occupying one. Holding it would be a ceiling that subtracts for ever.
  const labelled = deptCapacityFor({}, 'studio', REPO, {
    assignee: 'adam.morgan@example.com',
    labels: ['dept:story'],
  });
  assert.equal(labelled.dept, null, 'no chain, so no ceiling');
  assert.equal(labelled.capacity, null);

  // An executive role is the same answer for the other reason lib/relay.js gives: vox
  // produces process rather than a reviewable deliverable, gets no relay, and so is in no
  // department to be capped.
  assert.equal(deptCapacityFor({}, 'studio', REPO, { assignee: 'vox' }).dept, null);

  // And the label *does* route a bead whose assignee is a role — that is the half that has
  // to keep working. clio is a Story member checking Design; the label wins.
  assert.equal(deptCapacityFor({}, 'studio', REPO, { assignee: 'clio', labels: ['dept:design'] }).dept, 'dept:design');
  assert.equal(deptCapacityFor({}, 'studio', REPO, { assignee: 'clio' }).dept, 'dept:story');
});

await check('one broken checkout is one sentence, however many beads are in it', async () => {
  const at = path.join(tmp, 'broken');
  fs.mkdirSync(path.join(at, '.beadcause'), { recursive: true });
  fs.writeFileSync(path.join(at, '.beadcause', 'relays.yaml'), 'relays:\n  studio:\n    deparments:\n      x: y\n');
  forgetRelayDefs();

  const rows = ['a', 'b', 'c'].map((id) => ({ id, dir: at, assignee: 'aria', labels: [] }));
  const { seen, problems } = departmentsFor({}, 'studio', rows);
  assert.equal(problems.length, 1, 'a broken file is a fact about a directory, not about a bead');
  assert.match(problems[0].why, /unknown key "deparments"/);
  assert.equal(problems[0].id, 'a', 'and the first bead that hit it, so there is somewhere to start');
  assert.deepEqual(seen.map((s) => s.dept), [null, null, null], 'a refused file falls through and caps nothing');
  forgetRelayDefs();
});

await check('a workspace that defines nothing anywhere answers without a ceiling', async () => {
  const bare = path.join(tmp, 'bare');
  fs.mkdirSync(bare, { recursive: true });
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `x-${i}`, dir: bare, assignee: 'aria', labels: [] }));
  const { seen, problems } = departmentsFor({}, 'studio', rows);
  assert.equal(problems.length, 0);
  assert.ok(seen.every((s) => s.dept === null && s.capacity === null), 'every workspace on this Mac today');
  // And a row with no checkout at all — a scratch tracker under ~/beads — is answered
  // rather than thrown at.
  assert.deepEqual(departmentsFor({}, 'studio', [{ id: 'x', dir: '', assignee: 'aria' }]).seen, [
    { id: 'x', dept: null, capacity: null },
  ]);
});

/* ------------------------------------------------------- and now a whole tick */

await check('two Story beads, capacity 1: one window opens and the other is held', async () => {
  const r = await tick({
    ready: [bead('st-1', 'Draft the launch post'), bead('st-2', 'Draft the follow-up')],
    assignees: { 'st-1': { assignee: 'aria' }, 'st-2': { assignee: 'clio' } },
  });

  assert.deepEqual(openedIds(r), ['st-1'], 'one window, not two, though maxWorkers is 2');
  assert.equal(r.opened[0].dept, 'dept:story', 'and it recorded the department it is spending');
  assert.deepEqual(heldIds(r.card), ['st-2']);
  const held = r.card.heldByDept[0];
  assert.equal(held.dept, 'dept:story');
  assert.equal(held.capacity, 1);
  assert.match(held.why, /capacity: 1/);
  assert.match(r.card.note, /waiting on a busy department \(dept:story\)/, 'and the tick says so');
});

await check('a second department is untouched by the first being full', async () => {
  const r = await tick({
    ready: [bead('st-1', 'Draft the launch post'), bead('st-2', 'Draft the follow-up'), bead('de-1', 'Lay it out')],
    assignees: {
      'st-1': { assignee: 'aria' },
      'st-2': { assignee: 'clio' },
      'de-1': { assignee: 'lens' },
    },
  });
  // Which is the whole point of the bead: Story working on two things no longer starves
  // Design. Design states no capacity, so it is held by nothing.
  assert.deepEqual(openedIds(r), ['de-1', 'st-1']);
  assert.deepEqual(heldIds(r.card), ['st-2']);
});

await check('the department comes from the graph — a queue row has no assignee to read', async () => {
  // The row `bd ready --json` hands over carries no `assignee` field at all, so this is
  // the same queue as the case above with the *graph* half taken away. If anything ever
  // starts reading the row instead, this is the case that goes red.
  const r = await tick({
    ready: [bead('st-1', 'Draft the launch post'), bead('st-2', 'Draft the follow-up')],
    assignees: {},
  });
  assert.deepEqual(openedIds(r), ['st-1', 'st-2'], 'no assignee is no chain, and no chain is no ceiling');
  assert.deepEqual(heldIds(r.card), []);
});

await check('a tracker that will not answer means no cap, never an empty one', async () => {
  const r = await tick({
    ready: [bead('st-1', 'Draft the launch post'), bead('st-2', 'Draft the follow-up')],
    assignees: { 'st-1': { assignee: 'aria' }, 'st-2': { assignee: 'clio' } },
    graph: false,
  });
  // The other reading — a silent graph means "no departments, so hold nothing back" —
  // happens to be this same answer. What matters is the shape: a subtraction must never
  // *grow* because a read failed, and the pair of cases is what pins the direction.
  assert.deepEqual(openedIds(r), ['st-1', 'st-2']);
  assert.deepEqual(heldIds(r.card), []);
});

await check('a definition that will not load dispatches everything, and is said out loud', async () => {
  writeDefinition('relays:\n  studio:\n    departments:\n      story:\n        members: [aria]\n');
  try {
    const r = await tick({
      ready: [bead('st-1', 'Draft the launch post'), bead('st-2', 'Draft the follow-up')],
      assignees: { 'st-1': { assignee: 'aria' }, 'st-2': { assignee: 'clio' } },
    });
    assert.deepEqual(openedIds(r), ['st-1', 'st-2'], 'a broken file is never a hold');
    assert.deepEqual(heldIds(r.card), [], 'and it takes no heldBy* entry');
    assert.equal(r.card.relayProblems.length, 1);
    assert.match(r.card.relayProblems[0].why, /does not start with "dept:"/);
    assert.match(r.card.note, /does not start with "dept:"/, 'the tick note carries it');
    assert.match(r.card.note, /without a relay/);
  } finally {
    writeDefinition(DEFINITION);
  }
});

await check('a queue with nothing pickable in it says why, and does not call it settling', async () => {
  // `settling` is `queue − ready − retired − held`, and the last term is what this holds.
  // Without it, a bead waiting on a `capacity:` is reported as one that is thirty seconds
  // old and about to be picked up — which is precisely the welded number bc-xl7n.111 cost
  // a bead: two states with opposite prognoses, added together, and neither named.
  //
  // `capacity: 0` is the shortest way to empty `candidates` without emptying the queue,
  // which is the only tick that reaches the line under test.
  writeDefinition(DEFINITION.replace('capacity: 1', 'capacity: 0'));
  try {
    const r = await tick({
      ready: [bead('st-1', 'Draft the launch post'), bead('st-2', 'Draft the follow-up')],
      assignees: { 'st-1': { assignee: 'aria' }, 'st-2': { assignee: 'clio' } },
    });
    assert.deepEqual(openedIds(r), [], 'a department switched off opens nothing');
    assert.deepEqual(heldIds(r.card), ['st-1', 'st-2']);
    assert.equal(r.card.queue, 2, 'and they are still in the queue, and still counted in it');
    assert.doesNotMatch(r.card.note || '', /settling/, `held is not settling: ${r.card.note}`);
    assert.match(r.card.note || '', /2 waiting on a busy department/);
  } finally {
    writeDefinition(DEFINITION);
  }
});

await check('a department full for an hour is one log line, not a hundred and twenty', async () => {
  // A tick is thirty seconds and a department can be full all afternoon, so the sentence is
  // printed once per *spell* of a bead being held — the same discipline
  // `withoutUnplaceable` keeps for a `repo:` token nothing declares. It needs its own
  // memory rather than the card's list, because the card's list is emptied at the top of
  // every tick so a paused advocate stops drawing a department that was busy an hour ago.
  const r = await tick({
    ready: [bead('st-1', 'Draft the launch post'), bead('st-2', 'Draft the follow-up')],
    assignees: { 'st-1': { assignee: 'aria' }, 'st-2': { assignee: 'clio' } },
    ticks: 3,
  });
  const lines = r.said.filter((l) => l.includes('st-2') && l.includes('capacity: 1'));
  assert.equal(lines.length, 1, `said it ${lines.length} times:\n${lines.join('\n')}`);
  // And it is still *reported* on every tick — the log going quiet must not take the hold
  // off the card, which is the mistake the two-field split exists to make impossible.
  assert.deepEqual(heldIds(r.card), ['st-2']);
  assert.match(r.card.note || '', /waiting on a busy department/);
});

/* --------------------------------------- the two writes this rests on, pinned */

await check('the launcher hands the department back, because the claim destroys it', async () => {
  // A window's first act is `bd update --claim`, which overwrites the assignee — so a
  // department re-derived a minute later is `null` for every window that has started work,
  // and a ceiling counted that way never binds at all. It is written down at the launch or
  // it cannot be known. Asserted on the source because the alternative is opening a window.
  const src = fs.readFileSync(LIB('session.js'), 'utf8');
  const at = src.indexOf('const { def: relayDef, problem: relayProblem } = relayDefFor(');
  assert.ok(at > 0, 'lib/session.js still resolves the definition off the bead’s own checkout');
  assert.match(src.slice(at), /dept: relay\?\.dept \|\| null/, 'and hands the department back with it');

  const adv = fs.readFileSync(LIB('advocate.js'), 'utf8');
  assert.match(adv, /dept: dept \|\| null,/, 'and the worker record keeps it');
  assert.match(adv, /open: a\.workers\.map\(\(w\) => w\.dept \|\| null\)/, 'and the cap counts it');
});

await check('nothing here throws, and nothing here refuses', async () => {
  // The standing rule for this whole family: a definition problem is a sentence and never
  // a refusal. bc-ogicx.5 pinned it inside the launcher; this is the other end.
  const src = fs.readFileSync(LIB('relaydefs.js'), 'utf8');
  assert.ok(!/throw[^;]*capacity/.test(src), 'a capacity became a throw');
  assert.deepEqual(withinCapacity(undefined, undefined), { kept: [], held: [] });
  assert.deepEqual(departmentsFor().seen, []);
  assert.equal(deptCapacityFor().dept, null);
});

await quiesce();
await removeTree(tmp);

console.log(`\n${failures ? `${failures} of ${ran} checks failed` : `all ${ran} checks passed`}`);
process.exit(failures ? 1 : 0);
