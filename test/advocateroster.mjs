#!/usr/bin/env node
/**
 * The advocates console draws *both* advocates — the repo's and each epic's.
 *
 *     npm test
 *     node test/advocateroster.mjs
 *
 * There is more than one advocate per repo and there has been since epic planning
 * landed. The **repo advocate** is the card: its name is the heading, its state is the
 * chip beside it, its Pause and Reclaim are in its head. An **EpicAdvocate** is a window
 * opened on one P0 to write that epic's plan — `wantsAdvocate` in lib/epicadvocate.js,
 * a P0 that is open, owned and not a crash. Both decide what gets worked on. Only the
 * first was ever drawn.
 *
 * bc-jk4m put the two fields the page needed on the wire — `planning` and `group` on
 * every worker row in `snapshot()` — and nothing read either of them, which is bc-ss05.
 * The cost is specific rather than cosmetic: **a planner finishes with its bead still
 * open, on purpose.** An epic is its children and the planner's job ends when the plan
 * is written. Every *other* worker that ends with its bead open has given up. So on the
 * card as it was, the one window doing exactly the right thing and the one that ran out
 * of room were the same row, and the four windows a single judgement dispatched read as
 * four unrelated beads.
 *
 * These are source assertions, the shape test/closedpill.mjs and test/globalcap.mjs use
 * for this page: there is no DOM here, and what they pin is the wiring rather than the
 * pixels. Each is a way this could ship looking finished and be inert —
 *
 *   1. the roster is built from the daemon's field, not guessed from a title;
 *   2. it is drawn on every card, first, and counts the repo advocate itself, so a shut
 *      panel still says whether any epic is being argued for;
 *   3. **the slot arithmetic is untouched** — a planner holds a session slot, so it is
 *      still listed and still counted under "Working now". A roster that quietly moved
 *      rows out of that count would make the number on the card disagree with the number
 *      the daemon is enforcing, which is the one thing this page must never do;
 *   4. the empty state is drawn rather than hidden, because "no EpicAdvocate is open" is
 *      the state that follows a P0 closing — six epics went quiet that way on
 *      2026-08-12 with nothing on screen saying so (bc-arj0.3);
 *   5. the two fields it depends on are still on the wire.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const page = read('public/monitor.js');
const daemon = read('lib/advocate.js');
const css = read('public/style.css');

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

console.log('\nThe advocates console — the repo advocate and the EpicAdvocates\n');

/* ------------------------------------------------------------------ the roster */

check('the roster is built from the daemon\'s own field, not from a title or an id shape', () => {
  assert.match(page, /plannersOf\s*=\s*\(a\)\s*=>\s*\(a\.workers\s*\|\|\s*\[\]\)\.filter\(\(w\)\s*=>\s*w\.planning\)/,
    'nothing selects the planning windows by `planning`');
  assert.ok(
    !/\.filter\(\(w\)\s*=>\s*\/epic\/i\.test/.test(page),
    'a guess about which windows are planners would be right until an epic is titled something else'
  );
});

check('it draws the repo advocate and each EpicAdvocate in one section', () => {
  const fn = page.slice(page.indexOf('function advocatesHtml'), page.indexOf('function workerRow'));
  assert.ok(fn.length > 200, 'advocatesHtml is not there at all');
  assert.match(fn, /The repo advocate/, 'the repo advocate is not a row in its own roster');
  assert.match(fn, /EpicAdvocate/, 'the epic side of the roster is not drawn');
  assert.match(fn, /stateOf\(a\)/, 'the repo row invents a state instead of quoting the one the card already shows');
});

check('the section is first, and its count includes the repo advocate', () => {
  const secs = page.slice(page.indexOf('const secs = ['), page.indexOf(':work`'));
  assert.match(secs, /:advocates`/, 'the section is not in the card at all');
  assert.match(secs, /String\(1 \+ plannersOf\(a\)\.length\)/,
    'a count of the planners alone reads 0 on a repo that has an advocate — the card would say nobody is arguing for it');
  assert.ok(
    page.indexOf(':advocates`') < page.indexOf(':work`'),
    'the sections under it are what these advocates decided; the deciders come first'
  );
});

check('an absent EpicAdvocate is drawn, not hidden', () => {
  const fn = page.slice(page.indexOf('function advocatesHtml'), page.indexOf('function workerRow'));
  assert.match(fn, /No EpicAdvocate is open/, 'the empty case renders nothing, which reads as a section still loading');
  assert.match(fn, /open, owned and not a crash/,
    'and it does not say what would make one appear, which is the only actionable half');
});

/* ------------------------------------- the count the daemon is actually enforcing */

check('a planner is still listed and still counted under Working now', () => {
  const card = page.slice(page.indexOf('const secs = ['), page.indexOf(`${'${key}'}:next`));
  assert.match(card, /a\.workers\.map\(\(x\) => workerRow\(a, x\)\)/,
    'the sessions list no longer maps every worker — a planner holding a slot has vanished from the list that accounts for slots');
  assert.match(card, /a\.workers\.length \? `\$\{a\.workers\.length\}\/\$\{a\.limit\}`/,
    'the n/limit chip no longer counts every worker, so the card and the daemon now disagree about how many slots are gone');
});

/* -------------------------------------------------------------- the worker rows */

check('a planning window says so on its row, and says why ending open is correct', () => {
  const row = page.slice(page.indexOf('function workerRow'), page.indexOf('function closingRow'));
  assert.match(row, /w\.planning/, 'workerRow does not read the field');
  assert.match(row, /still open/,
    'the chip does not say that a planner ends with its bead open on purpose — which is the whole reason it needs a chip');
});

check('a window dispatched by a plan names the group and the epic it came from', () => {
  const row = page.slice(page.indexOf('function workerRow'), page.indexOf('function closingRow'));
  assert.match(row, /w\.group\?\.name/, 'workerRow does not read the group');
  assert.match(row, /w\.group\.epic/, 'the chip names the group but not the epic, so one judgement still reads as several');
});

/* ------------------------------------------------------------------- the wiring */

check('both fields the page now depends on are still in the snapshot', () => {
  const snap = daemon.slice(daemon.indexOf('const snapshot = ()'));
  assert.match(snap, /planning: Boolean\(w\.planning\)/, 'lib/advocate.js stopped sending `planning` — the roster would be empty and say so wrongly');
  assert.match(snap, /group: w\.group && w\.group\.name/, 'lib/advocate.js stopped sending `group`');
});

check('the roster reuses the styling the card already has', () => {
  const fn = page.slice(page.indexOf('function advocatesHtml'), page.indexOf('function workerRow'));
  for (const cls of ['work-row adv-worker', 'session-label', 'pill id']) {
    assert.ok(fn.includes(cls), `the roster does not use .${cls.split(' ').pop()}`);
  }
  // Reused rather than added: a new top-level selector here is exactly what bc-b4dk's
  // guard exists to refuse, and .adv-worker already styles a row in this card.
  assert.ok(css.includes('.adv-worker'), 'public/style.css has no .adv-worker for these rows to borrow');
});

console.log(`\n${ran - failures}/${ran} passed\n`);
if (failures) process.exit(1);
