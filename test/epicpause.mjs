#!/usr/bin/env node
/**
 * Pausing an epic stops the *next* window, never the one that is up.
 *
 *     npm test
 *     node test/epicpause.mjs
 *
 * bc-lco2. An EpicAdvocate had two states — a window or no window — and no way to say
 * "stop". Everything that could hold a subtree back held it for contention: a twin, a
 * branch, a lease, a file. None of those is a decision, and every one of them clears
 * itself once the other thing finishes, so the only way to stop an epic was to close it
 * or to pause the whole repo — which stops four other epics that were fine.
 *
 * What a pause is, in four claims, and the fourth is the one worth the file:
 *
 *   1. **Nothing new is dispatched under it.** Every ready bead in the subtree leaves the
 *      queue, the P0 itself with them, and `reenter` opens no advocate window on it.
 *   2. **And it is visible as held**, naming the epic — because a queue that silently
 *      shrinks reads exactly like an advocate that has decided there is nothing to do,
 *      and this is the one hold whose fix is a button rather than a wait.
 *   3. **The epic beside it is untouched.** A pause is per-P0; a pause that leaked to a
 *      sibling would be the repo pause with extra steps.
 *   4. **The windows already open keep their slots — and are told.** A session ordinarily
 *      hands its unfinished thinking to the next window on the bead half an hour later,
 *      and a pause is a promise there will not be one. So each of them is messaged, asked
 *      for `beadcause-memory debrief` before it exits, and *not* finished: a pause that
 *      took the slot back would lose exactly the work it was pressed to protect.
 *
 * And the carrier: the fact is a **label on the bead**, so a resume from another machine,
 * from `bd` on the command line, or from the advocate itself lands within a tick — and a
 * daemon that dies between writing the label and reaching the windows leaves the epic
 * paused rather than half-paused.
 *
 * Built on test/livequeue.mjs's harness: `open`, `openAdvocate` and `say` are injected, so
 * a tick that would have opened an iTerm window pushes a bead id onto an array and a
 * message that would have been typed into one is captured. No iTerm, no `bd`, no agent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp, quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-epicpause-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { isPaused, PAUSED_LABEL, pausedEpics } = await import(LIB('epicadvocate.js'));
const { pauseMessage } = await import(LIB('session.js'));
const { indexFrom } = await import(LIB('ancestry.js'));
const { debriefFamily } = await import(LIB('memory.js'));

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const OWNER = 'owner:adam@example.com';

/** A queue row, as `bd ready --json` gives it. */
const bead = (id, title, over = {}) => ({
  id,
  title,
  priority: 2,
  issue_type: 'task',
  created_at: OLD,
  ...over,
});

/** A graph row, as `bd export` writes it and `indexFrom` reads it. An owned, open P0. */
const row = (id, over = {}) =>
  JSON.stringify({
    id,
    title: id,
    status: 'open',
    priority: 0,
    issue_type: 'epic',
    labels: [OWNER],
    ...over,
  });

/**
 * A child row, with the parent edge written out.
 *
 * The dotted id is not enough here and that is not a fixture detail: `hasP0Above` walks
 * `index.parents`, which `indexFrom` builds from the dependency rows of the export, so a
 * child with no edge is an orphan and `withoutOrphans` takes it out of the queue before
 * anything in this file is reached. `withoutPausedEpics` reads the id instead, because it
 * is asked about beads that are still in the queue — but a fixture that skipped the edge
 * would be testing the orphan filter and calling it a pause.
 */
const kid = (id, parent, over = {}) =>
  JSON.stringify({
    id,
    title: id,
    status: 'open',
    priority: 2,
    issue_type: 'task',
    labels: [],
    dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }],
    ...over,
  });

/**
 * One tick, over a tracker that says what the case needs it to.
 *
 * `graph` is the export the roster and the re-entry sweep read — the paused label lives
 * there and nowhere else, which is the point of the design and so has to be the point of
 * the fixture too. `before` runs against the live advocates *before* the tick under test,
 * which is the real order of every case here: a window is opened, the button is pressed,
 * and the next tick is the first one that can see either.
 */
async function tick({ ready = [], graph = [], overrides = {}, before = null } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case: `quiesce` + `removeTree` rather than a bare recursive
  // `rmSync`, because every write of `advocates.json` schedules a common-repo commit
  // 2000ms out whose `git init` lands in `CONFIG_DIR`, and rmdir on a directory that
  // gained a file since it was read is ENOTEMPTY. test/tmpadoption.mjs fails the repo for
  // the bare form (bc-9d37.9).
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: path.join(tmp, 'no-sessions'),
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    sessionDirs: { alpha: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Features with suites of their own, each of which would otherwise run real git, a
      // real `gh` or a real agent against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      flagNotInMain: false,
      filePromotions: false,
      holdLiveSessions: false,
      sessionLog: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const index = indexFrom(graph.join('\n'));
  const labelled = [];
  const opened = [];
  const advocated = [];
  const said = [];

  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => [],
    comments: async () => [],
    graph: async () => index,
    addLabel: async (_ws, id, label) => {
      labelled.push(['add', id, label]);
      const b = index.beads.get(id);
      if (b) b.labels = [...(b.labels || []), label];
    },
    removeLabel: async (_ws, id, label) => {
      labelled.push(['remove', id, label]);
      const b = index.beads.get(id);
      if (b) b.labels = (b.labels || []).filter((l) => l !== label);
    },
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: `term-${b.id}` };
    },
    openPlan: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: `term-${b.id}` };
    },
    // The real one drives iTerm. A fixture with an enrolled P0 in it that did not stub
    // this would open a window on Adam's Mac.
    openAdvocate: async (_cfg, _ws, b) => {
      advocated.push(b.id);
      return { dir: REPO, mode: 'test', term: `term-${b.id}` };
    },
    say: async (handle, text) => {
      said.push([handle, text]);
      return 'sent';
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
    terminals: () => [],
  });

  if (before) await before(advocates);
  await advocates.tick();
  const card = advocates.snapshot().find((x) => x.workspace === 'alpha');
  return { opened, advocated, said, labelled, card, advocates, index };
}

const heldIds = (card) => (card.heldByPause || []).map((h) => h.id);
const whyFor = (card, id) => ((card.heldByPause || []).find((h) => h.id === id) || {}).why || '';

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

console.log('\nPausing an epic stops the next window, never the one that is up\n');

/* ---------------------------------------------------------------- the carrier */

await check('the paused fact is a label, read off the bead', () => {
  assert.equal(isPaused({ labels: [OWNER, PAUSED_LABEL] }), true);
  assert.equal(isPaused({ labels: [OWNER] }), false);
  assert.equal(isPaused({}), false, 'a bead with no labels at all is not paused');
  // Trimmed, because a pause that failed open would be a button that reports success and
  // dispatches anyway — the one direction this feature must never fail in.
  assert.equal(isPaused({ labels: [` ${PAUSED_LABEL} `] }), true);
});

await check('and the set is read from the whole graph, not from the roster', () => {
  // A paused P0 that has since lost its owner drops out of `assignedAdvocates` and is
  // still paused. Reading the roster instead would start dispatching under an epic
  // somebody stopped, by the back door.
  const beads = [
    { id: 'x-1', priority: 0, labels: [PAUSED_LABEL] },
    { id: 'x-2', priority: 0, labels: [OWNER] },
  ];
  assert.deepEqual([...pausedEpics(beads)], ['x-1']);
  assert.deepEqual([...pausedEpics(new Map(beads.map((b) => [b.id, b])))], ['x-1'], 'a Map answers the same');
  assert.equal(pausedEpics(null).size, 0);
});

/* ------------------------------------------------------------------ the queue */

await check('a bead under a paused epic gets no window', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1.1', 'a child of the paused epic')],
    graph: [row('x-1', { labels: [OWNER, PAUSED_LABEL] }), kid('x-1.1', 'x-1')],
  });

  assert.deepEqual(opened, [], 'a window was opened under a paused epic');
  assert.equal(card.queue, 0, 'and it is out of the queue, not merely unpicked');
  assert.deepEqual(heldIds(card), ['x-1.1'], 'held rather than vanished');
  assert.match(whyFor(card, 'x-1.1'), /x-1 is paused/, whyFor(card, 'x-1.1'));
  assert.equal(card.heldByPause[0].epic, 'x-1', 'the epic travels — it is the only actionable part');
});

await check('and so does the P0 itself', async () => {
  // A leaf P0 is workable in its own right. Pausing its advocate and then dispatching a
  // window onto the P0 is the one reading of "pause" nobody could defend.
  const { opened, card } = await tick({
    ready: [bead('x-1', 'the P0 itself', { priority: 0 })],
    graph: [row('x-1', { labels: [OWNER, PAUSED_LABEL] })],
  });

  assert.deepEqual(opened, []);
  assert.match(whyFor(card, 'x-1'), /its own advocate is paused/, whyFor(card, 'x-1'));
});

await check('it holds the whole subtree, however deep', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1.2.3', 'a grandchild')],
    graph: [row('x-1', { labels: [OWNER, PAUSED_LABEL] }), kid('x-1.2', 'x-1'), kid('x-1.2.3', 'x-1.2')],
  });

  assert.deepEqual(opened, []);
  assert.deepEqual(heldIds(card), ['x-1.2.3']);
});

await check('the epic beside it is untouched', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1.1', 'under the paused one'), bead('x-2.1', 'under the other one')],
    graph: [row('x-1', { labels: [OWNER, PAUSED_LABEL] }), kid('x-1.1', 'x-1'), row('x-2'), kid('x-2.1', 'x-2')],
  });

  assert.deepEqual(opened, ['x-2.1'], 'a pause is per-P0; this one leaked to a sibling');
  assert.deepEqual(heldIds(card), ['x-1.1']);
});

await check('a bead that merely starts alike is not under it', async () => {
  // The dot is required. Without it `x-1` would swallow `x-12`, and an advocate would
  // hold work back on the strength of two ids that begin the same way.
  const { opened } = await tick({
    ready: [bead('x-12', 'a different epic entirely', { priority: 0 })],
    graph: [row('x-1', { labels: [OWNER, PAUSED_LABEL] }), row('x-12')],
  });

  assert.deepEqual(opened, ['x-12']);
});

await check('nothing is held when nothing is paused', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1.1', 'an ordinary child')],
    graph: [row('x-1'), kid('x-1.1', 'x-1')],
  });

  assert.deepEqual(opened, ['x-1.1']);
  assert.deepEqual(card.heldByPause, [], 'the list is present and empty, not absent');
});

/* --------------------------------------------------------------- the re-entry */

await check('no advocate window is re-opened on a paused P0', async () => {
  // Enrolment is the waiting-on block in the notes (lib/reenter.js), and the sweep fires
  // on a child that was filed. Both are true here; the pause is the only thing stopping it.
  const graph = [
    row('x-1', {
      labels: [OWNER, PAUSED_LABEL],
      notes: '<!-- beadcause:waiting -->on its children<!-- /beadcause:waiting -->',
    }),
    kid('x-1.1', 'x-1'),
  ];
  const { advocated } = await tick({
    graph,
    overrides: { reenterIntervalMinutes: 0, reenterCooldownMinutes: 0 },
    // Two ticks: the first is the sweep's first sight, which is silent by design, and the
    // second is the one that would fire on what it saw. A one-tick fixture would pass
    // whether or not the pause worked.
    before: async (advocates) => {
      await advocates.tick();
    },
  });

  assert.deepEqual(advocated, [], 'a P0 advocate window was opened on a paused epic');
});

/* ---------------------------------------------------------------- the control */

await check('pressing pause writes the label and nothing else', async () => {
  const { labelled, index } = await tick({
    graph: [row('x-1')],
    before: async (advocates) => {
      await advocates.tick();
      await advocates.control('alpha', 'epicPause', 'x-1');
    },
  });

  assert.deepEqual(labelled, [['add', 'x-1', PAUSED_LABEL]], 'the label is the fact; it was not written');
  assert.equal(isPaused(index.beads.get('x-1')), true);
});

await check('and resuming takes it off again', async () => {
  const { labelled, opened } = await tick({
    ready: [bead('x-1.1', 'a child')],
    graph: [row('x-1', { labels: [OWNER, PAUSED_LABEL] }), kid('x-1.1', 'x-1')],
    before: async (advocates) => {
      await advocates.tick();
      await advocates.control('alpha', 'epicResume', 'x-1');
    },
  });

  assert.deepEqual(labelled, [['remove', 'x-1', PAUSED_LABEL]]);
  assert.deepEqual(opened, ['x-1.1'], 'dispatch did not come back after the resume');
});

await check('the button takes effect before the graph cache turns over', async () => {
  // `bd.graph` is cached for a minute, so a pause that waited for the roster to re-derive
  // it would be a button you press twice. Nothing has read the label back here — `control`
  // writing into `a.pausedEpics` is the whole of what is being asserted.
  const { opened } = await tick({
    ready: [bead('x-1.1', 'a child')],
    graph: [row('x-1'), kid('x-1.1', 'x-1')],
    before: async (advocates) => {
      await advocates.control('alpha', 'epicPause', 'x-1');
    },
  });

  assert.deepEqual(opened, [], 'the pause did not bite until the next graph read');
});

await check('a pause with no bead named is refused rather than applied to everything', async () => {
  await tick({
    graph: [row('x-1')],
    before: async (advocates) => {
      await assert.rejects(() => advocates.control('alpha', 'epicPause', ''), /which epic/);
    },
  });
});

/* ------------------------------------------ the windows that are already up */

await check('an open window under the epic is told, and keeps its slot', async () => {
  const { said, card } = await tick({
    ready: [bead('x-1.1', 'a child worth a window')],
    graph: [row('x-1'), kid('x-1.1', 'x-1')],
    before: async (advocates) => {
      // The first tick opens the window; the button is pressed with it up, which is the
      // case the whole feature is about.
      await advocates.tick();
      await advocates.control('alpha', 'epicPause', 'x-1');
    },
  });

  assert.equal(said.length, 1, 'the open window was not told its epic had been paused');
  const [handle, text] = said[0];
  assert.equal(handle, 'term-x-1.1', 'it was addressed by the window handle the launch recorded');
  assert.match(text, /beadcause-memory debrief "/, 'the debrief is the ask, and it is not in the message');
  assert.match(text, /not a check-in/, 'it reads as a reclaim, which takes work away');
  assert.equal(card.workers.length, 1, 'the pause took the slot back — it must not');
  assert.equal(card.workers[0].id, 'x-1.1');
});

await check('a window under another epic is left alone', async () => {
  const { said } = await tick({
    ready: [bead('x-1.1', 'under the paused one'), bead('x-2.1', 'under the other one')],
    graph: [row('x-1'), kid('x-1.1', 'x-1'), row('x-2'), kid('x-2.1', 'x-2')],
    before: async (advocates) => {
      await advocates.tick();
      await advocates.control('alpha', 'epicPause', 'x-1');
    },
  });

  assert.equal(said.length, 1, 'the pause typed into a window that has nothing to do with it');
  assert.equal(said[0][0], 'term-x-1.1');
});

await check('resuming types into nobody', async () => {
  // The windows that were told were told there is no next session. A "resumed" line
  // arriving in one that has since wound down is noise in a window somebody is reading.
  const { said } = await tick({
    ready: [bead('x-1.1', 'a child')],
    graph: [row('x-1'), kid('x-1.1', 'x-1')],
    before: async (advocates) => {
      await advocates.tick();
      await advocates.control('alpha', 'epicResume', 'x-1');
    },
  });

  assert.deepEqual(said, []);
});

/* ------------------------------------------------------------------ the message */

await check('the message says what it takes, which is nothing', () => {
  const text = pauseMessage('x-1.1', 'x-1', { title: 'The epic' });
  assert.match(text, /x-1\.1 is still claimed/, 'it does not say the claim is kept');
  assert.match(text, /your slot is still yours/);
  assert.match(text, /until it is unpaused/, 'it does not say what has actually changed');
  const debrief = text.indexOf('beadcause-memory debrief');
  assert.ok(debrief > text.indexOf('before you exit'), 'the ask arrives before the reason for it');
});

/* ------------------------------------------------ and what the resume reads back */

await check('a debrief written during the pause reaches the window opened after it', () => {
  // The other half of the ask, and the half that would otherwise be an assumption: it is
  // no use telling a window to write a report if nothing hands it on. `debriefFamily`
  // keys off the **root** of the dotted id, so every report written under the epic —
  // this bead's own last run, and its siblings' — is in front of whatever opens next
  // under that epic. Asserted as a pure function, because that is what it is; the door
  // that calls it is the source read below.
  const family = debriefFamily(['x-1', 'x-1.1', 'x-1.2', 'x-9.1'], { id: 'x-1.1' });
  assert.deepEqual(family, ['x-1.1', 'x-1', 'x-1.2'], 'own run first, then the epic, then the siblings');
  assert.ok(!family.includes('x-9.1'), 'another epic’s reports are not folded in');
});

await check('and the worker door is what hands them over', () => {
  const src = read('lib/session.js');
  const from = src.indexOf('export async function openWorkSession');
  assert.ok(from > 0, 'openWorkSession has been renamed — re-point this check');
  const body = src.slice(from, src.indexOf('\n}\n', from));
  // The *field*, not the variable it is handed: what matters is that the worker's brief
  // carries a `debriefs` section read from the store, and the local name for the bead row
  // has already changed once under this check.
  assert.match(body, /debriefs: await debriefsFor\(dir, \w+\)/, 'a resumed worker is briefed without what the paused ones wrote');
});

/* -------------------------------------------------------------------- the wiring */

await check('the launch door refuses a paused P0', () => {
  // A source assertion, like test/epicadvocate.mjs's door check and for its reason: the
  // real door opens an iTerm window. What matters is that the button cannot get round a
  // pause the sweep respects — two doors, one rule.
  const src = read('lib/session.js');
  const from = src.indexOf('export async function openEpicAdvocateSession');
  assert.ok(from > 0, 'openEpicAdvocateSession has been renamed — re-point this check');
  const body = src.slice(from, src.indexOf('\n}\n', from));
  assert.match(body, /isPaused\(row\)/, 'the launch door does not check the pause');
  assert.match(body, /status: 409/, 'and it does not refuse with a status the app can read');
});

await check('the console offers the button on every epic section', () => {
  const page = read('public/monitor.js');
  assert.match(page, /data-epic="/, 'no pause control on an epic section');
  assert.match(page, /epicControl\(epic\.dataset\.ws, epic\.dataset\.id/, 'the button is drawn but not wired');
  // `control` sends `Number(value)`, deliberately, because every value it has carried has
  // been a session count. A bead id through that is `NaN`.
  const at = page.indexOf('async function epicControl');
  assert.ok(at > 0, 'epicControl has been renamed — re-point this check');
  const body = page.slice(at, page.indexOf('\n  }\n', at));
  assert.ok(!/Number\(/.test(body), 'the bead id is being coerced to a number on the way out');
});

await check('and a paused epic keeps its section rather than losing it', () => {
  const src = read('lib/epicadvocate.js');
  const from = src.indexOf('export function wantsAdvocate');
  const body = src.slice(from, src.indexOf('\n}\n', from));
  assert.ok(
    !/isPaused|PAUSED_LABEL/.test(body),
    'a paused P0 has been folded out of the roster — the only control that brings it back goes with it'
  );
});

/* ---------------------------------------------------------------------- report */

await quiesce();
await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
