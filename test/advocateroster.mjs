#!/usr/bin/env node
/**
 * An EpicAdvocate belongs to its epic, not to its window.
 *
 *     npm test
 *     node test/advocateroster.mjs
 *
 * Until bc-xl7n.8.1 an EpicAdvocate *was* a planner window: it existed while a session
 * was up, it was drawn as one row among the coding workers, and it came out of the repo
 * advocate's session budget. Measured on 2026-08-13: twenty P0s in this repo had an
 * advocate assigned, one had a window, and the console drew one row — so nineteen epics
 * looked like nobody was arguing for them, and planning an epic cost a coding window.
 *
 * Three rules replace that, and they are what this suite holds:
 *
 *   1. **Assignment is a property of the epic.** Open, owned, not a crash → it has an
 *      advocate. Closed → it does not. The window is a state that assignment reports,
 *      not the thing itself, so an exited window leaves the epic still advocated for and
 *      a closed epic takes its advocate with it whether or not a window is up.
 *   2. **Its own budget.** `maxEpicAdvocates` is a separate number from `maxWorkers`,
 *      with a separate ceiling and a separate per-workspace key, and neither reads the
 *      other. Stepping the session limit must leave the EpicAdvocate count untouched —
 *      that is Adam's requirement in one sentence, and it is the assertion below that
 *      would actually catch a regression, because sharing a key or a ceiling is exactly
 *      how the coupling would come back.
 *   3. **`/monitor` draws a card each**, whether or not a window is up, and "Working
 *      now" counts coders only — a card saying `2 of 2 sessions` over a repo whose second
 *      window is a planner is claiming the repo is full while the daemon still has a slot.
 *      It was a *section* inside the repo advocate's card until bc-henk; the nesting said
 *      an EpicAdvocate was part of the repo advocate, and everything above says it is not.
 *
 * The roster and the two limits are pure functions and are driven for real. The tick's
 * slot arithmetic and the page are source assertions, the shape test/closedpill.mjs and
 * test/globalcap.mjs use for this file pair: no DOM here, and what they pin is the wiring.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignedAdvocates, wantsAdvocate } from '../lib/epicadvocate.js';
import { namesBead } from '../lib/reap.js';
import { epicAdvocateLimit, workerLimit, MAX_EPIC_ADVOCATES_CEILING } from '../lib/advocate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const page = read('public/monitor.js');
const daemon = read('lib/advocate.js');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

/** A graph row the shape `bd.graph()` caches — see indexFrom in lib/ancestry.js. */
const bead = (id, over = {}) => ({
  id,
  title: id,
  status: 'open',
  priority: 0,
  issue_type: 'epic',
  labels: ['owner:adam@example.com'],
  ...over,
});

console.log('\nAn EpicAdvocate belongs to its epic, not to its window\n');

/* ------------------------------------------------------------------ the roster */

check('every open, owned root has an advocate assigned', () => {
  const roster = assignedAdvocates([bead('bc-a'), bead('bc-b'), bead('bc-c')]);
  assert.deepEqual(
    roster.map((r) => r.id),
    ['bc-a', 'bc-b', 'bc-c']
  );
});

check('a closed epic has none — this is the rule the whole change exists for', () => {
  const roster = assignedAdvocates([bead('bc-a'), bead('bc-shut', { status: 'closed' })]);
  assert.deepEqual(
    roster.map((r) => r.id),
    ['bc-a'],
    'a closed epic still has an advocate assigned to it'
  );
});

check('and the three other noes are unchanged — not a root, unowned, a crash', () => {
  const roster = assignedAdvocates([
    bead('bc-task', { priority: 2, issue_type: 'task' }),
    bead('bc-nobody', { labels: [] }),
    bead('bc-crash', { labels: ['owner:adam@example.com', 'app-error'] }),
    bead('bc-real'),
  ]);
  assert.deepEqual(
    roster.map((r) => r.id),
    ['bc-real'],
    'the roster disagrees with wantsAdvocate, which is the one thing it must never do'
  );
  // Same predicate, asked one bead at a time: the roster must be that function over the
  // graph and nothing else, or the door and the board can disagree about who is assigned.
  for (const b of [bead('bc-task', { priority: 2, issue_type: 'task' }), bead('bc-nobody', { labels: [] })])
    assert.equal(wantsAdvocate(b), false);
});

check('AND A P2 EPIC IS ON THE ROSTER — bc-htoy', () => {
  // The first no used to be "not a P0", and this row is what it cost: an epic somebody
  // owns, open, not a crash, and refused an advocate for no reason but its priority. The
  // roster is `wantsAdvocate` over the graph, so it is also where that would silently
  // come back — a gate widened in lib/epicadvocate.js but not reflected here would mean
  // the door opened windows on epics the agents screen said had no advocate.
  const roster = assignedAdvocates([bead('bc-p2', { priority: 2 }), bead('bc-p4', { priority: 4 })]);
  assert.deepEqual(
    roster.map((r) => r.id),
    ['bc-p2', 'bc-p4'],
    'an owned open epic is advocatable at whatever priority it carries'
  );
});

check('a Map is accepted, because that is what bd.graph() hands over', () => {
  const m = new Map([
    ['bc-b', bead('bc-b')],
    ['bc-a', bead('bc-a')],
  ]);
  assert.deepEqual(
    assignedAdvocates(m).map((r) => r.id),
    ['bc-a', 'bc-b'],
    'insertion order reached the card — the sections would reshuffle under a thumb on every repaint'
  );
  assert.deepEqual(assignedAdvocates(null), [], 'a cold graph cache throws instead of drawing nothing');
});

/* ------------------------------------------------------------------ the budget */

check('the EpicAdvocate budget is a different number from the session limit', () => {
  const cfg = { advocates: { maxWorkers: 1, maxEpicAdvocates: 3 } };
  assert.equal(workerLimit(cfg, 'repo').limit, 1);
  assert.equal(epicAdvocateLimit(cfg, 'repo').limit, 3);
});

check('stepping the session limit does not move it — the requirement, asserted', () => {
  const before = epicAdvocateLimit({ advocates: { maxWorkers: 1, maxEpicAdvocates: 3 } }, 'repo').limit;
  // The shape `saveWorkerLimit` writes: a per-workspace maxWorkers, and a raised ceiling.
  const after = epicAdvocateLimit(
    { advocates: { maxWorkers: 1, maxWorkersLimit: 9, maxEpicAdvocates: 3, perWorkspace: { repo: { maxWorkers: 9 } } } },
    'repo'
  ).limit;
  assert.equal(after, before, 'raising maxWorkers changed how many EpicAdvocates this repo may open');
});

check('and it has a ceiling of its own, not the worker ceiling', () => {
  const cfg = { advocates: { maxEpicAdvocates: 99 } };
  assert.equal(epicAdvocateLimit(cfg, 'repo').limit, MAX_EPIC_ADVOCATES_CEILING);
  assert.equal(epicAdvocateLimit(cfg, 'repo').ceiling, MAX_EPIC_ADVOCATES_CEILING);
  assert.ok(
    !/MAX_EPIC_ADVOCATES_CEILING\s*=\s*MAX_WORKERS_CEILING/.test(daemon),
    'the two ceilings are one constant again — raising the worker ceiling would raise this too'
  );
});

check('per workspace, like every other cap here', () => {
  const cfg = { advocates: { maxEpicAdvocates: 1, perWorkspace: { busy: { maxEpicAdvocates: 5 } } } };
  assert.equal(epicAdvocateLimit(cfg, 'busy').limit, 5);
  assert.equal(epicAdvocateLimit(cfg, 'quiet').limit, 1);
});

/* --------------------------------------------------- the tick's slot arithmetic */

check('planners and coders are rationed against different numbers', () => {
  assert.match(daemon, /const free = a\.limit - codersOf\(a\)\.length/, 'the session limit still counts planners');
  assert.match(daemon, /const epicFree = \(a\.epicLimit \?\? DEFAULTS\.maxEpicAdvocates\) - plannersOf\(a\)\.length/);
  assert.match(daemon, /const planSlots = Math\.max\(0, Math\.min\(epicFree, readyPlans\.length\)\)/);
  // The one that matters: epicFree must not be bounded by globalFree either.
  assert.ok(
    !/Math\.min\([^)]*epicFree[^)]*globalFree/.test(daemon),
    'the global session cap is binding EpicAdvocates through the back door'
  );
});

check('the global session count is coders only', () => {
  assert.match(
    daemon,
    /const totalWorkers = \(\) => \[\.\.\.advocates\.values\(\)\]\.reduce\(\(n, a\) => n \+ codersOf\(a\)\.length, 0\)/,
    'globalMaxWorkers counts planners, so opening one takes a coding slot from another repo'
  );
});

check('the roster is rebuilt from the graph every tick, and never persisted', () => {
  assert.match(daemon, /a\.epicAdvocates = await rosterFor\(a\)/, 'nothing recomputes the roster on a tick');
  assert.match(daemon, /assignedAdvocates\(beads\)/, 'rosterFor does not read the graph');
  assert.ok(
    !/epicAdvocates: Array\.isArray\(prev\.epicAdvocates\)/.test(daemon),
    'the roster survives a restart — an epic closed while the daemon was down would come back assigned'
  );
});

/* ------------------------------------------------------------------- the page */

check('the console draws a card per assigned epic, from the roster on the wire', () => {
  assert.match(daemon, /epicAdvocates: a\.epicAdvocates \|\| \[\]/, 'the roster is not in the snapshot');
  assert.match(page, /function epicCard\(a, e\)/, 'nothing draws the cards');
  assert.match(page, /epicsOf\(a\)\.map\(\(e\) => epicCard\(a, e\)\)/, 'the cards are not built from the roster');
  assert.match(page, /const fold = `\$\{key\}:epic:\$\{e\.id\}`/, 'the fold has lost the key it had as a section, so every open epic shuts on deploy');
  assert.match(page, /advocateCard\(w, a, proposals, r\) \+ epicCards\(a\)/, 'they are built but never placed in the run');
});

check('and each one is a top-level card, not a fold inside the repo advocate', () => {
  // The whole of bc-henk in two assertions. An `<article class="card">` at the same level
  // as the repo's, and nothing left in `advocateCard` that draws an epic inside itself.
  const fn = page.slice(page.indexOf('function epicCard(a, e)'), page.indexOf('const epicCards ='));
  assert.match(fn, /<article class="card work-card mon-card epic-card/, 'an epic is still drawn as something other than a card');
  const card = page.slice(page.indexOf('function advocateCard'), page.indexOf('function plainCard'));
  assert.ok(!/epicSections/.test(card), 'the repo card still folds its epics inside itself');
  assert.ok(!/'Advocates', String\(1 \+ epicsOf\(a\)\.length\)/.test(card), 'the roster count still adds the epics to the repo advocate');
  // Paused and "Open the epic" both reachable from the head, which is the part of a shut
  // card you can see — a card that has to be opened to be paused is a fold with a border.
  const head = fn.slice(fn.indexOf('const controls ='), fn.indexOf('const plan ='));
  assert.match(head, /data-epic="\$\{e\.paused \? 'epicResume' : 'epicPause'\}/, 'the pause is not in the head');
  assert.match(head, /Open the epic/, 'nor the way into the epic');
});

check('a window is on exactly one card, and the repo card says where the rest went', () => {
  const card = page.slice(page.indexOf('function advocateCard'), page.indexOf('function plainCard'));
  assert.match(card, /const claimed = carded\(a\)/, 'the repo card no longer knows which epics have cards');
  assert.match(card, /codersOf\(a\)\.filter\(\(w\) => !claimed\.has\(w\.group\?\.epic\)\)/, 'the repo card draws epic-dispatched windows too');
  assert.match(card, /came out of an epic's plan/, 'nothing accounts for the rows the count includes and the list does not');
  assert.match(page, /const dispatchedFrom = \(a, id\) => codersOf\(a\)\.filter\(\(w\) => w\.group\?\.epic === id\)/, 'the epic card cannot find its own sessions');
});

check('an epic with no window is drawn as fully as one with it, and says which reason', () => {
  const fn = page.slice(page.indexOf('function epicStateOf'), page.indexOf('const epicCards ='));
  assert.match(fn, /No window right now/, 'an unwindowed epic renders an empty card');
  assert.match(fn, /e\.why/, 'and it does not say why, which is the only actionable half');
  // In the head chip as well as the body, because a shut card is only its head.
  assert.match(fn, /return \{ text: e\.why \|\| 'no window'/, 'the reason is only readable once the card is opened');
  assert.match(daemon, /waiting for a slot/, 'the daemon never sends the out-of-budget reason');
  assert.match(daemon, /nothing under it is ready to plan yet/, 'nor the other one');
});

check('Working now counts coders only, in both the number and the rows', () => {
  const card = page.slice(page.indexOf('const secs = ['), page.indexOf('Only drawn when there is one'));
  assert.match(card, /codersOf\(a\)\.length \? `\$\{codersOf\(a\)\.length\}\/\$\{a\.limit\}`/, 'the count still includes planners');
  assert.ok(!/a\.workers\.map\(\(x\) => workerRow\(a, x\)\)/.test(card), 'the rows still include planners');
  // The rows are the coders no epic claimed — a subset of the same population, never
  // `a.workers`. The count above stays every coder, so it agrees with what `tickOne`
  // rations; see the comment in the card.
  assert.match(card, /unclaimed\.map\(\(x\) => workerRow\(a, x\)\)/);
});

check('and the head chip does too, so it can never read "2 of 1 sessions"', () => {
  const st = page.slice(page.indexOf('function stateOf'), page.indexOf('How many sessions this advocate may open'));
  assert.match(st, /codersOf\(a\)\.length/, 'stateOf counts every window against the session limit');
});

/* ------------------------------------------- assigning one by hand, from the card */

check('a session on a descendant no longer blocks an advocate on its ancestor', () => {
  // The live names on this Mac when the bug was reported, 2026-08-13. `bc-xl7n` was
  // refused because of a window on `bc-xl7n.8.1`, and `bc-1kwl` because of one on
  // `bc-1kwl.2` — every parent id is a prefix of its children's, which is the exact
  // failure `namesBead` was written for and this route never adopted.
  const live = ['human.bc-xl7n.8.1.EpicAdvocate sections', 'beadcause - bc-1kwl.2 implement the SWR cache layer'];
  const held = (id) => live.some((n) => namesBead(n, id));
  assert.equal(held('bc-xl7n'), false, 'a descendant still holds its ancestor');
  assert.equal(held('bc-1kwl'), false, 'a descendant still holds its ancestor');
  assert.equal(held('bc-1kwl.2'), true, 'the bead a session really is on is no longer held — the guard is now inert');
  // And the old test, kept as the control: it is wrong on three of the four.
  const naive = (id) => live.some((n) => n.includes(id));
  assert.equal(naive('bc-xl7n'), true, 'the substring test would not have failed here, so this suite proves nothing');
});

check('the route uses the shared matcher rather than its own', () => {
  const server = read('lib/server.js');
  const route = server.slice(server.indexOf("p === '/api/bead/advocate'"), server.indexOf("p === '/api/unendorsed'"));
  // `advocateSession` rather than a bare `namesBead` here: bc-d6yk arrived at the same
  // defect from the card's side and put the answer in lib/epicadvocate.js, where the door
  // and the button in front of it can share it — which is strictly better than two call
  // sites agreeing by coincidence. It is `namesBead` underneath, and test/epicadvocate.mjs
  // holds that end.
  assert.match(route, /advocateSession\(liveSessions\(cfg\), id/, 'the route matches sessions its own way again');
  assert.ok(!/\.name \|\| ''\)\.includes\(id\)/.test(route), 'the substring match is back');
  assert.match(route, /already\.name/, 'the refusal does not name the window holding the bead, so it cannot be acted on');
});

console.log(`\n${ran - failures}/${ran} passed\n`);
if (failures) process.exit(1);
