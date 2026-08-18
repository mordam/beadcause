#!/usr/bin/env node
/**
 * `Requested endorsements` on the advocate console — the beads each advocate is waiting on.
 *
 *     npm test
 *     node test/heldsubcard.mjs
 *
 * The endorsement queue used to be a place you went: a topbar button, a page of its own,
 * and a muted `N held for endorsement` pill on the advocate console that was the only
 * number anywhere saying there was anything to go there *for*. bc-8t3b moves it to where
 * Adam already is, and the half that landed first (bc-w156.5) put it in the inbox. This
 * is the other half — the advocate console, where an endorsement is not an item in a list
 * but *a decision one particular advocate is stopped on*.
 *
 * **The split is Adam's answer to bc-w156.2 and it is a hybrid**, so it is worth stating
 * exactly, because two of the three options that were offered are wrong and this suite is
 * the only thing that says which behaviour shipped. Verbatim: *"shown under EpicAdvocate
 * if they were produced by its work or by the agents it spawns. per workspace
 * otherwise."* Per-advocate on its own was rejected because a bead no advocate owns would
 * vanish from the console; per-workspace on its own does not answer what was asked. So
 * both, with the repo as the bucket nothing can fall out of.
 *
 * Four claims, and they are in two halves because the answer is joined from two producers
 * that only meet in the browser:
 *
 * 1. **The rows cost nothing.** `bd.readyHeld` already ran — it is one of `sweep`'s four
 *    calls in lib/work.js, and it has to be, because `ready` is a lie until the held beads
 *    come out of it. The count was kept and the rows were thrown away; now they are not.
 *    That is a claim about argv, so `bd` here is a stub binary that logs every call.
 * 2. **The chain above each bead comes off the graph, and this row never builds one.**
 *    lib/work.js asks `bd.graphReady` before `bd.parents(ws, { wait: false })`, so a
 *    process where nothing else wants the graph gets an empty map rather than a `bd
 *    export` per workspace it did not ask for. Every held bead then falls to the repo's
 *    own section — the degradation the hybrid was chosen for, and not an error.
 * 3. **Nearest ancestor wins.** A bead under an epic that is itself under a P0, where both
 *    have an advocate, belongs to the nearer one — anything else puts every bead in the
 *    repo on the P0's card.
 * 4. **Nothing is unreachable.** A held bead with no parent, or one under an epic nobody
 *    is planning, is drawn on the repo's own section rather than nowhere. This is the
 *    claim the whole design rests on and it is asserted against the real rendered page.
 *
 * The page half runs public/monitor.js in a `node:vm` (the shape test/spacecard.mjs works
 * out), because the join is the feature: a source read could confirm the strings and still
 * miss a bead landing in two sections or in none.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MONITOR = fs.readFileSync(path.join(ROOT, 'public', 'monitor.js'), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-heldsubcard-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(path.join(ROOT, 'lib', 'bd.js'));
const { collectWork, forget, HELD_ROWS_MAX } = await import(path.join(ROOT, 'lib', 'work.js'));

let ran = 0;
let failures = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
};

console.log('\nthe advocate console carries the beads each advocate is waiting to have endorsed');

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, keyed by workspace directory — `BEADS_DIR` is how `Bd.run`
 * says which workspace it means, so the stub resolves the same way bd itself does. The
 * same shape test/closedpill.mjs uses, with `export` added: the parent chain on each held
 * row is read off `bd export`, so a stub that cannot answer it would test the fallback
 * and call it the feature.
 *
 * Every call is appended to `BD_LOG` before anything is answered, because one of the
 * claims here is how many calls a repaint makes and not how many of them succeeded.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const dir = process.env.BEADS_DIR || '';
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify([dir, ...args]) + '\\n');
const world = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const w = world[dir];
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
if (!w) die('no beads database found in ' + dir);
if (w.broken) die('Error: dolt: could not open database');
if (args[0] === 'status') { process.stdout.write(JSON.stringify({ summary: w.summary })); process.exit(0); }
if (args[0] === 'export') { process.stdout.write((w.graph || []).map((r) => JSON.stringify(r)).join('\\n')); process.exit(0); }
if (args[0] === 'ready' && args.includes('${'unendorsed'}')) { process.stdout.write(JSON.stringify(w.held || [])); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const clearCalls = () => fs.rmSync(BD_LOG, { force: true });

const spaceDir = (name) => path.join(tmp, 'ws', name, '.beads');
const workspace = (name) => ({ name, dir: spaceDir(name) });
for (const name of ['alpha', 'flat', 'broken', 'huge', 'unread']) fs.mkdirSync(spaceDir(name), { recursive: true });

/** One `bd ready --json` row, as `readyHeld` hands it to lib/work.js. */
const heldBead = (id, extra = {}) => ({
  id,
  title: `${id} — something an agent found`,
  issue_type: 'task',
  priority: 2,
  status: 'open',
  labels: ['unendorsed'],
  created_at: '2026-08-14T10:00:00Z',
  ...extra,
});

/** One `bd export` row. `parent` is spelled as the edge bd really writes. */
const node = (id, parent = null) => ({
  id,
  title: id,
  status: 'open',
  issue_type: parent ? 'task' : 'epic',
  labels: [],
  dependencies: parent ? [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] : [],
});

const SUMMARY = { open_issues: 12, ready_issues: 6, blocked_issues: 0, in_progress_issues: 1, closed_issues: 100 };

const huge = Array.from({ length: HELD_ROWS_MAX + 7 }, (_, i) =>
  heldBead(`bc-h${String(i).padStart(3, '0')}`, { created_at: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T09:00:00Z` })
);

fs.writeFileSync(
  WORLD,
  JSON.stringify(
    {
      // The shape the join is for: two epics with an advocate, one nested inside the
      // other, plus a bead hanging off neither.
      [spaceDir('alpha')]: {
        summary: SUMMARY,
        held: [heldBead('bc-deep'), heldBead('bc-mid'), heldBead('bc-loose'), heldBead('bc-orphan')],
        graph: [
          node('bc-root'),
          node('bc-epic', 'bc-root'),
          node('bc-deep', 'bc-epic'),
          node('bc-mid', 'bc-root'),
          node('bc-loose', 'bc-nobody'),
          node('bc-orphan'),
        ],
      },
      // Everything held, nothing above any of it. The console still has to draw them.
      [spaceDir('flat')]: {
        summary: SUMMARY,
        held: [heldBead('bc-a1'), heldBead('bc-a2')],
        graph: [node('bc-a1'), node('bc-a2')],
      },
      [spaceDir('huge')]: { summary: SUMMARY, held: huge, graph: huge.map((b) => node(b.id)) },
      // Never graphed by any case here — `PARENT_CACHE` in lib/bd.js is module-level and
      // survives a new `Bd`, so "cold" has to mean a workspace nothing has exported yet.
      [spaceDir('unread')]: {
        summary: SUMMARY,
        held: [heldBead('bc-c1'), heldBead('bc-c2')],
        graph: [node('bc-root'), node('bc-c1', 'bc-root'), node('bc-c2', 'bc-root')],
      },
      [spaceDir('broken')]: { broken: true },
    },
    null,
    2
  )
);

const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

/** Both caches, so each case starts where a fresh daemon does. See lib/bd.js `graph`. */
const cold = async (name) => {
  forget(name);
  return bd;
};

/** The graph cache is per-process and 60s; a case that wants it warm asks for it. */
const warmGraph = async (name) => {
  await bd.graph(workspace(name), { refresh: true });
  forget(name);
};

/* ------------------------------------------------------------- what the row carries */

await check('the rows behind the held count ride on the row that already counted them', async () => {
  await warmGraph('alpha');
  const [row] = await collectWork(bd, [workspace('alpha')], {}, []);
  assert.equal(row.counts.held, 4, 'the pill still quotes every held bead');
  assert.deepEqual(
    row.heldRows.map((b) => b.id).sort(),
    ['bc-deep', 'bc-loose', 'bc-mid', 'bc-orphan'],
    'the rows are the ones behind that number and no others'
  );
  const deep = row.heldRows.find((b) => b.id === 'bc-deep');
  assert.equal(deep.title, 'bc-deep — something an agent found');
  // `issue_type` renamed once, here, so the page never sees bd's vocabulary — the trap
  // `toRow` in lib/endorsequeue.js exists for.
  assert.equal(deep.type, 'task', 'a client reading `.type` off a raw bd row gets undefined');
  assert.equal(deep.priority, 2);
});

await check('and each carries the chain of epics above it, nearest first', async () => {
  await warmGraph('alpha');
  const [row] = await collectWork(bd, [workspace('alpha')], {}, []);
  const under = Object.fromEntries(row.heldRows.map((b) => [b.id, b.under]));
  assert.deepEqual(under['bc-deep'], ['bc-epic', 'bc-root'], 'nearest first is what makes the join pick the right one');
  assert.deepEqual(under['bc-mid'], ['bc-root']);
  assert.deepEqual(under['bc-loose'], ['bc-nobody'], 'a parent that is not itself in the export still ends the walk');
  assert.deepEqual(under['bc-orphan'], [], 'a bead with nothing above it is not an error, it is the repo bucket');
});

await check('it costs no `bd` call the row was not already making, and never waits on the export', async () => {
  await warmGraph('alpha');
  clearCalls();
  await collectWork(bd, [workspace('alpha')], {}, []);
  const verbs = bdCalls()
    .map((c) => c[1])
    .sort();
  // The same four `forWorkspace` has always made — `readyHeld` is one of them, and these
  // rows are a projection of a list it was already fetching and discarding. The graph is
  // not in here at all: it is `wait: false` against a cache lib/bd.js holds for a minute
  // and every other reader on this daemon has already paid for.
  assert.deepEqual(verbs, ['list', 'ready', 'ready', 'status'], `got ${JSON.stringify(bdCalls())}`);
});

await check('a graph nothing has ever read costs the rows their epic, and starts no export', async () => {
  // A process where nothing else reads the graph — `graphReady` is false, so this row
  // does not go and build one. Every held bead falls to the repo's own section, which is
  // exactly the bucket bc-w156.2 put under the whole feature; the split arrives on the
  // repaint after somebody who does want the graph has paid for it.
  await cold('unread');
  clearCalls();
  const [row] = await collectWork(bd, [workspace('unread')], {}, []);
  assert.equal(row.heldRows.length, 2, 'the rows are all still there');
  assert.deepEqual(
    row.heldRows.map((b) => b.under),
    [[], []],
    'and none of them claims an epic it could not read'
  );
  const verbs = bdCalls().map((c) => c[1]);
  assert.ok(
    !verbs.includes('export'),
    'this row must never be the reason a `bd export` runs — 7.3 seconds for nine workspaces, on a card that repaints every twenty'
  );
});

await check('a workspace whose tracker fell over reports the error and no rows', async () => {
  const [row] = await collectWork(bd, [workspace('broken')], {}, []);
  assert.ok(row.error, 'the row still reports, which is the point of the error path');
  assert.equal(row.heldRows, undefined, 'an empty list here would say this repo has nothing waiting');
});

await check('a backlog is capped, and the count it is measured against is not', async () => {
  await warmGraph('huge');
  const [row] = await collectWork(bd, [workspace('huge')], {}, []);
  assert.equal(row.counts.held, HELD_ROWS_MAX + 7, 'the pill quotes the truth');
  assert.equal(row.heldRows.length, HELD_ROWS_MAX, 'the card carries at most the cap');
  // Newest first, the order /endorse draws them in — so what the cap takes off is the
  // oldest end of the queue rather than an arbitrary slice.
  const dates = row.heldRows.map((b) => b.createdAt);
  assert.deepEqual([...dates].sort().reverse(), dates, 'the cap has to take the far end, not the near one');
});

/* --------------------------------------------------- the page, in a room of its own */

/**
 * `public/monitor.js` for real, with the handful of things it touches stubbed — the shape
 * test/spacecard.mjs worked out. Every section on this page is folded by default and the
 * open set lives in `localStorage`, so the keys the cases want to read are put there:
 * that is the honest equivalent of the tap a browser check would make.
 */
async function drawConsole(payload, open) {
  const node = () => ({
    innerHTML: '',
    textContent: '',
    title: '',
    className: '',
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const nodes = { mon: node(), pulse: node(), tally: node(), observing: node(), refresh: node() };
  const store = { 'beadcause.token': 'tok', 'beadcause.mon.open': JSON.stringify(open) };
  const ctx = vm.createContext({
    window: {
      beadcause: {
        space: { filter: { space: 'All' }, matches: () => true, label: () => 'All', adopt() {}, onChange() {} },
      },
    },
    document: { getElementById: (id) => nodes[id] || null, addEventListener() {}, activeElement: null },
    location: { search: '', pathname: '/monitor', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: (k) => store[k] ?? null, setItem(k, v) { store[k] = v; } },
    URLSearchParams,
    JSON,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (url) => {
      const body = url.startsWith('/api/work')
        ? payload
        : url.startsWith('/api/questions')
          ? { questions: [] }
          : url.startsWith('/api/prs')
            ? { prs: [] }
            : {};
      return { ok: true, status: 200, json: async () => body };
    },
  });
  vm.runInContext(MONITOR, ctx, { filename: 'monitor.js' });
  // The boot is async and the IIFE hands nothing back, so settle on the stubs' own
  // microtasks. Bounded rather than timed: nothing here waits on a clock.
  for (let i = 0; i < 80; i += 1) await new Promise((r) => setImmediate(r));
  return nodes.mon.innerHTML;
}

/** One advocate, with only the fields the card reads. */
const advocate = (workspaceName, epics) => ({
  workspace: workspaceName,
  workers: [],
  epicAdvocates: epics,
  limit: 2,
  epicLimit: 2,
  queue: 0,
  closing: [],
  parked: [],
  paused: false,
  surveying: false,
  archive: null,
  lastSurveyAt: '2026-08-17T12:00:00Z',
});

const epic = (id) => ({ id, title: `${id} — an epic`, type: 'epic', labels: [], paused: false, window: null, why: 'nothing under it is ready to plan yet' });

/** The section a bead was drawn in, by cutting the card at each section's own key. */
function sectionOf(html, beadId) {
  const marks = [];
  const OPEN = 'data-toggle="';
  for (let i = html.indexOf(OPEN); i !== -1; i = html.indexOf(OPEN, i + 1)) {
    marks.push({ at: i, key: html.slice(i + OPEN.length, html.indexOf('"', i + OPEN.length)) });
  }
  const at = html.indexOf(`/endorse?bead=alpha%2F${beadId}"`);
  if (at === -1) return null;
  let owner = null;
  for (const m of marks) if (m.at < at) owner = m.key;
  return owner;
}

const PAYLOAD = (heldRows, counts) => ({
  workspaces: [{ name: 'alpha', working: [], sessions: [], counts: { held: counts, ...{} }, heldRows }],
  advocates: [advocate('alpha', [epic('bc-epic'), epic('bc-root')])],
  roster: [],
  observing: false,
});

// The same four beads the server half produced, with the chains it computed.
const ROWS = [
  { id: 'bc-deep', title: 'deep', type: 'task', priority: 2, createdAt: '2026-08-14T10:00:00Z', under: ['bc-epic', 'bc-root'] },
  { id: 'bc-mid', title: 'mid', type: 'task', priority: 2, createdAt: '2026-08-14T10:00:00Z', under: ['bc-root'] },
  { id: 'bc-loose', title: 'loose', type: 'bug', priority: 1, createdAt: '2026-08-14T10:00:00Z', under: ['bc-nobody'] },
  { id: 'bc-orphan', title: 'orphan', type: 'task', priority: 2, createdAt: '2026-08-14T10:00:00Z', under: [] },
];

const OPEN_ALL = [
  'alpha:epic:bc-epic',
  'alpha:epic:bc-root',
  'alpha:epic:bc-epic:held',
  'alpha:epic:bc-root:held',
  'alpha:held',
];

await check('a bead lands under the nearest advocate above it, and only that one', async () => {
  const html = await drawConsole(PAYLOAD(ROWS, 4), OPEN_ALL);
  assert.equal(sectionOf(html, 'bc-deep'), 'alpha:epic:bc-epic:held', 'the nearer epic owns it, not the P0 above that');
  assert.equal(sectionOf(html, 'bc-mid'), 'alpha:epic:bc-root:held');
  // Drawn once. A bead in two sections is counted twice on a card whose numbers are what
  // you read instead of opening the panels.
  const hits = html.split('/endorse?bead=alpha%2Fbc-deep"').length - 1;
  assert.equal(hits, 1, `bc-deep is drawn ${hits} times`);
});

await check('and one no advocate produced lands on the repo, rather than nowhere', async () => {
  const html = await drawConsole(PAYLOAD(ROWS, 4), OPEN_ALL);
  // The claim the hybrid rests on: per-advocate alone was rejected because these two
  // would have been invisible on this screen entirely.
  assert.equal(sectionOf(html, 'bc-loose'), 'alpha:held', 'an epic nobody is planning is not an advocate');
  assert.equal(sectionOf(html, 'bc-orphan'), 'alpha:held', 'and a bead with no parent at all still has to be reachable');
});

await check('every held bead this repo has is on the card exactly once', async () => {
  const html = await drawConsole(PAYLOAD(ROWS, 4), OPEN_ALL);
  for (const row of ROWS) {
    const hits = html.split(`/endorse?bead=alpha%2F${row.id}"`).length - 1;
    assert.equal(hits, 1, `${row.id} is drawn ${hits} times`);
  }
});

await check('the row is a door to the queue, on the bead it names', async () => {
  const html = await drawConsole(PAYLOAD(ROWS, 4), OPEN_ALL);
  assert.ok(
    html.includes('href="/endorse?bead=alpha%2Fbc-deep"'),
    'the same deep link the inbox uses (public/app.js), so the queue opens on the bead rather than at the top'
  );
});

await check('an advocate with nothing waiting draws no section at all', async () => {
  const html = await drawConsole(PAYLOAD([ROWS[0]], 1), OPEN_ALL);
  assert.ok(html.includes('alpha:epic:bc-epic:held'), 'the advocate that has one still has its section');
  assert.ok(
    !html.includes('alpha:epic:bc-root:held'),
    'a dozen epics each carrying an empty `Requested endorsements 0` is a card you stop reading'
  );
  assert.ok(!html.includes('data-toggle="alpha:held"'), 'and the repo draws none either when nothing is left over');
});

await check('what the cap took off is said on the card, not left to look complete', async () => {
  const html = await drawConsole(PAYLOAD([ROWS[3]], 108), OPEN_ALL);
  assert.ok(html.includes('107 more are held in this repo'), 'a truncation nobody is told about makes the screen lie');
  assert.ok(html.includes('href="/endorse"'), 'and the queue is where the rest of them are');
});

await check('a daemon too old to send the rows draws no section rather than an empty one', async () => {
  // A page cached from a newer deploy against an older daemon: `heldRows` is absent, the
  // `N held for endorsement` pill still works, and the card must not gain a section
  // claiming this repo has nothing waiting.
  const html = await drawConsole(
    {
      workspaces: [{ name: 'alpha', working: [], sessions: [], counts: { held: 4 } }],
      advocates: [advocate('alpha', [epic('bc-epic')])],
      roster: [],
      observing: false,
    },
    OPEN_ALL
  );
  assert.ok(!html.includes('Requested endorsements'), 'no rows means no section, not a section saying nought');
  assert.ok(html.includes('4 held for endorsement'), 'and the pill that has always been there is untouched');
});

console.log(`\n${ran - failures}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
