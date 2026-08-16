#!/usr/bin/env node
/**
 * A bead id written in prose gets an edge behind it — lib/mentions.js and the hook.
 *
 *     npm test
 *     node test/mentions.mjs
 *
 * Measured on 2026-08-13 over 850 beads, the tracker held **1,633** references from one
 * bead's prose to another and **two** see-also edges in the whole graph. "The same
 * defect as bc-767a", "see also bc-rcrt", "sits in bc-42ow's neighbourhood" were real
 * relationships that `bd show`, `bd dep tree`, the graph page and every dispatch brief
 * were blind to, so each session rebuilt the neighbourhood by reading — and mostly did
 * not.
 *
 * Three things are checked, and the middle one is the one that would have gone wrong
 * quietly:
 *
 * 1. **What earns an edge**, in lib/mentions.js: the dotted child rather than its epic,
 *    a bead's own id never, a pair the graph already joins never, and an id that does
 *    not exist never — that last one because bulk wiring validates the whole batch and
 *    rejects **every** line of it over one bad id, so a single typo in a description
 *    could cost a sweep of thirteen hundred good edges.
 * 2. **That the hook cannot break the write it hangs off.** A comment is what the caller
 *    was asked to record; the edge is a courtesy. A `bd dep relate` that fails — a bead
 *    deleted since the id was typed, an edge somebody else drew a second ago — must
 *    leave the comment written and say nothing. The reverse, a tracker that refused to
 *    record an answer because a see-also would not draw, would be far worse than a
 *    missing edge.
 * 3. **That the prose costs nothing when it names no beads.** Most comments name none.
 *    The regex runs in process, before any spawn, and the fake `bd` here is what proves
 *    it: the argv of every invocation is on disk, so "it did not ask" is checkable
 *    rather than assumed.
 *
 * There is a fourth, in test/graphwaits.mjs rather than here: `bd dep relate` writes the
 * type `relates-to` and every reader in this repo was written against `related`. Left
 * alone that would have put 1,308 fresh edges on cards counted as live blockers.
 *
 * Nothing here touches a tracker: `Bd` is pointed at a fake `bd` that records its argv.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MENTION_CAP,
  RELATED_EDGE,
  RELATED_EDGES,
  WRITE_CAP,
  edgeRows,
  isRelated,
  linkedIds,
  mentionsIn,
  planFor,
  prefixOf,
  proseOf,
} from '../lib/mentions.js';
import { Bd } from '../lib/bd.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const check = (name, fn) => {
  try {
    const out = fn();
    if (out instanceof Promise) return out.then(() => console.log(`  \x1b[32m✓\x1b[0m ${name}`), fail);
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    fail(err);
  }
  function fail(err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(err.message).split('\n')[0]}`);
  }
};

/* ------------------------------------------------------------- what is a mention */

console.log('\nwhat counts as a mention');

check('a plain id in a sentence', () => {
  assert.deepEqual(mentionsIn('the same defect as bc-767a, more or less', 'bc'), ['bc-767a']);
});

check('the dotted child, not the epic it hangs under', () => {
  // "see also bc-rfnr.9.1" means the child. An edge to the wrong end of a family is
  // worse than no edge — it says the epic was mentioned when it was not.
  assert.deepEqual(mentionsIn('see also bc-rfnr.9.1 for the shape', 'bc'), ['bc-rfnr.9.1']);
});

check('a full stop after an id is a full stop, not part of it', () => {
  assert.deepEqual(mentionsIn('This is the same job as bc-arj0. Nothing else.', 'bc'), ['bc-arj0']);
});

check('the same id twice is one mention, in the order it was written', () => {
  assert.deepEqual(mentionsIn('bc-rcrt, then bc-42ow, then bc-rcrt again', 'bc'), ['bc-rcrt', 'bc-42ow']);
});

check('case is not part of an id', () => {
  assert.deepEqual(mentionsIn('BC-767A is the one', 'bc'), ['bc-767a']);
});

check('a prefix inside a longer word is not a mention', () => {
  assert.deepEqual(mentionsIn('abc-767a and xbc-rcrt are not bead ids', 'bc'), []);
});

check('another workspace’s ids are not this one’s', () => {
  assert.deepEqual(mentionsIn('filed as cl-1234 over in the work tracker', 'bc'), []);
});

check('no prefix, no mentions — rather than a pattern built out of junk', () => {
  assert.deepEqual(mentionsIn('bc-767a', prefixOf('')), []);
  assert.equal(prefixOf('bc-arj0.4'), 'bc');
  assert.equal(prefixOf('not an id at all'), null);
});

check('prose is every field a bead can hold, comments included', () => {
  const text = proseOf(
    {
      title: 'the same defect as bc-767a',
      description: 'see bc-rcrt',
      acceptance_criteria: 'as in bc-42ow',
      design: 'per bc-dte',
      notes: 'and bc-tlk',
      close_reason: 'superseded by bc-2tr',
    },
    [{ text: 'discussed on bc-es8' }, 'and bc-dmt']
  );
  assert.deepEqual(mentionsIn(text, 'bc'), [
    'bc-767a',
    'bc-rcrt',
    'bc-42ow',
    'bc-dte',
    'bc-tlk',
    'bc-2tr',
    'bc-es8',
    'bc-dmt',
  ]);
});

/* ---------------------------------------------------------------- what earns one */

console.log('\nand which of those earns an edge');

check('a bead never relates to itself', () => {
  assert.deepEqual(planFor({ id: 'bc-arj0.4', prose: 'bc-arj0.4 is this one, and bc-767a is not' }), ['bc-767a']);
});

check('a pair the graph already joins is left alone', () => {
  // The parent said it in a paragraph and the parent-child edge already says it better.
  // A see-also over the top would put the same neighbour on the card twice, under two
  // headings — and `bd dep relate` refuses the write anyway, having written half of it.
  assert.deepEqual(planFor({ id: 'bc-arj0', prose: 'children: bc-arj0.4 and bc-28ef', linked: ['bc-arj0.4'] }), [
    'bc-28ef',
  ]);
});

check('an id nobody has ever heard of is dropped when the ids are known', () => {
  // Ten of these were in this workspace's prose on the day it was swept: bc-swr, bc-q1,
  // bc-xxx — typos, placeholders and beads long deleted. One of them in a bulk batch
  // rejects the entire batch, so this filter is what stands between a sweep and nothing.
  const known = new Set(['bc-767a']);
  assert.deepEqual(planFor({ id: 'bc-a1', prose: 'like bc-767a, unlike bc-xxx', known }), ['bc-767a']);
});

check('and is kept when they are not, because bd refuses better than a guess', () => {
  // The write-time hook passes no id set: asking would be a spawn per mention, where
  // bd's own refusal is free, authoritative, and costs only that one pair.
  assert.deepEqual(planFor({ id: 'bc-a1', prose: 'like bc-767a, unlike bc-xxx' }), ['bc-767a', 'bc-xxx']);
});

check('a runaway stops at the cap', () => {
  const ids = Array.from({ length: MENTION_CAP + 12 }, (_, i) => `bc-r${String(i).padStart(3, '0')}`);
  const plan = planFor({ id: 'bc-dump', prose: ids.join(' ') });
  assert.equal(plan.length, MENTION_CAP);
  // The first ones, not a sample: a queue dump's tail is the part nobody wrote on
  // purpose, and the top of a description is the part somebody did.
  assert.equal(plan[0], ids[0]);
});

check('the cap is above every real description and far below a queue dump', () => {
  assert.ok(MENTION_CAP >= 30 && MENTION_CAP <= 60, `cap is ${MENTION_CAP}`);
});

check('and one write gets a much lower one, because somebody is holding a phone', () => {
  // The hook runs inside `bd.respond`, awaited on the request path, at about a second
  // and a half per `bd dep relate`. Forty of those is a minute of waiting for an answer
  // that was recorded before the first edge was drawn.
  assert.ok(WRITE_CAP < MENTION_CAP / 2, `${WRITE_CAP} against ${MENTION_CAP}`);
});

check('an edge is written at both ends, because that is what bd does', () => {
  assert.deepEqual(edgeRows('bc-a', ['bc-b']), [
    { from: 'bc-a', to: 'bc-b', type: RELATED_EDGE },
    { from: 'bc-b', to: 'bc-a', type: RELATED_EDGE },
  ]);
  assert.equal(RELATED_EDGE, 'relates-to');
});

check('both spellings of a see-also are one thing', () => {
  // `related` is the older name and one edge here still carries it (bc-dte ↔ bc-tlk).
  assert.ok(isRelated('relates-to') && isRelated('related'));
  assert.ok(!isRelated('blocks') && !isRelated('parent-child'));
  assert.ok(RELATED_EDGES.has('related'));
});

check('what a bead is joined to is read off both ends of every row', () => {
  const linked = linkedIds({
    id: 'bc-a',
    dependencies: [
      { id: 'bc-b', dependency_type: 'blocks' },
      { issue_id: 'bc-a', depends_on_id: 'bc-c', type: 'parent-child' },
    ],
  });
  assert.deepEqual([...linked].sort(), ['bc-b', 'bc-c']);
});

/* ----------------------------------------------------------------- and the hook */

console.log('\nthe write-time hook');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-mentions-'));
const WS = { name: 'beadcause', dir: tmp };
const LOG = path.join(tmp, 'argv.jsonl');

/**
 * A `bd` that answers the two reads and records everything, so "it did not ask" is a
 * fact on disk rather than an assumption. `refuse` is a substring: any invocation whose
 * argv contains it exits non-zero, which is how the deleted-bead case is staged.
 */
const fakeBd = (name, { down = [], up = [], refuse = null } = {}) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(argv) + '\\n');
const has = (s) => argv.includes(s);
${refuse ? `if (argv.join(' ').includes(${JSON.stringify(refuse)})) { process.stderr.write('bd: nope'); process.exit(1); }` : ''}
if (has('dep') && has('list')) {
  process.stdout.write(JSON.stringify(has('up') ? ${JSON.stringify(up)} : ${JSON.stringify(down)}));
  process.exit(0);
}
if (has('create')) { process.stdout.write(JSON.stringify({ id: 'bc-new' })); process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 }
  );
  return new Bd({ bin: file, actor: 'beadcause' });
};

const calls = () =>
  fs
    .readFileSync(LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const reset = () => fs.writeFileSync(LOG, '');
const relates = () => calls().filter((a) => a[0] === 'dep' && a[1] === 'relate');

await check('a comment naming a bead draws the edge', async () => {
  reset();
  const bd = fakeBd('bd-plain');
  await bd.comment(WS, 'bc-arj0.4', 'the same defect as bc-767a');
  assert.deepEqual(
    relates().map((a) => a.slice(0, 4)),
    [['dep', 'relate', 'bc-arj0.4', 'bc-767a']]
  );
  // The comment itself still went first, and unchanged.
  assert.equal(calls()[0][0], 'comment');
});

await check('one write stops at the write cap, however long the list is', async () => {
  reset();
  const bd = fakeBd('bd-capped');
  const ids = Array.from({ length: WRITE_CAP + 6 }, (_, i) => `bc-w${String(i).padStart(3, '0')}`);
  await bd.comment(WS, 'bc-arj0.4', `all of: ${ids.join(' ')}`);
  assert.equal(relates().length, WRITE_CAP);
});

await check('a comment naming nothing spawns nothing beyond the comment', async () => {
  // The whole cost argument. Most comments name no bead, and the regex is what decides
  // that — in process, before a single child. Two reads on every comment written by
  // this daemon would be a bill paid forever for the ones that had nothing to link.
  reset();
  const bd = fakeBd('bd-quiet');
  await bd.comment(WS, 'bc-arj0.4', 'looks right to me');
  assert.deepEqual(
    calls().map((a) => a[0]),
    ['comment']
  );
});

await check('a bead already joined to what it names writes nothing', async () => {
  // The steady state after the sweep: it reads, finds the edge, and takes no write
  // lock at all. Dolt has one writer and this is a comment path.
  reset();
  const bd = fakeBd('bd-linked', { up: [{ id: 'bc-767a', dependency_type: 'parent-child' }] });
  await bd.comment(WS, 'bc-arj0.4', 'the same defect as bc-767a');
  assert.equal(relates().length, 0);
  assert.equal(calls().filter((a) => a[0] === 'dep' && a[1] === 'list').length, 2);
});

await check('both directions are read, because bd has no way to ask for both', async () => {
  // `bd show --json` carries only the outgoing half: bc-arj0, an epic with eight
  // children, comes back with an empty dependencies[] and dependent_count: 8. An epic
  // commenting about its own children would look unlinked to every one of them.
  reset();
  const bd = fakeBd('bd-dirs');
  await bd.comment(WS, 'bc-arj0', 'bc-arj0.4 is the one');
  const lists = calls().filter((a) => a[0] === 'dep' && a[1] === 'list');
  assert.equal(lists.length, 2);
  assert.ok(lists.some((a) => a.includes('up')), 'no --direction up read');
});

await check('a refused relate leaves the comment written and says nothing', async () => {
  reset();
  const bd = fakeBd('bd-refuses', { refuse: 'relate' });
  await bd.comment(WS, 'bc-arj0.4', 'see bc-767a');
  assert.ok(calls().some((a) => a[0] === 'comment'));
});

await check('and a tracker that cannot be read at all does not fail the write either', async () => {
  reset();
  const bd = fakeBd('bd-halfdead', { refuse: 'dep' });
  await bd.comment(WS, 'bc-arj0.4', 'see bc-767a');
  assert.ok(calls().some((a) => a[0] === 'comment'));
});

await check('a close reason is prose too', async () => {
  // "Superseded by bc-x", "the same job as bc-y, which landed" — the one line `bd show`
  // still prints months later, on a bead nobody will open the description of again.
  reset();
  const bd = fakeBd('bd-close');
  await bd.close(WS, 'bc-arj0.4', 'Superseded by bc-767a');
  assert.deepEqual(relates().map((a) => a[3]), ['bc-767a']);
});

await check('so is a note appended to a bead', async () => {
  reset();
  const bd = fakeBd('bd-notes');
  await bd.appendNotes(WS, 'bc-arj0.4', 'turned out to be bc-rcrt all along');
  assert.deepEqual(relates().map((a) => a[3]), ['bc-rcrt']);
});

await check('and the description a bead is filed with', async () => {
  // The highest-value moment of the lot: "found while working bc-3zo9.4", written on
  // the way in by whoever knew, on a bead nobody will read again.
  reset();
  const bd = fakeBd('bd-create');
  const id = await bd.create(WS, { title: 'A thing', body: 'found while working bc-3zo9.4' });
  assert.equal(id, 'bc-new');
  assert.deepEqual(relates().map((a) => a[3]), ['bc-3zo9.4']);
});

await check('an update relates only the fields that actually moved', async () => {
  // A save that rewrote the title alone must not re-link what the description said last
  // week: that prose is not being written here, and what it named was linked when it was.
  reset();
  const bd = fakeBd('bd-update');
  await bd.update(WS, 'bc-arj0.4', { title: 'Now about bc-rcrt' });
  assert.deepEqual(relates().map((a) => a[3]), ['bc-rcrt']);
});

await check('an update with nothing in it stays the no-op it was', async () => {
  reset();
  const bd = fakeBd('bd-noop');
  await bd.update(WS, 'bc-arj0.4', {});
  assert.deepEqual(calls(), []);
});

await check('an answer typed by a person is linked, after it has been recorded', async () => {
  reset();
  const bd = fakeBd('bd-respond');
  await bd.respond(WS, 'bc-arj0.4', 'do it the way bc-767a did');
  // Writes only. `respond` reads the thread first since bc-ko7n — `answerOnce` is what
  // stops a re-answer duplicating a comment the last attempt already wrote — and the
  // claim here is about the order of what it *writes*, which that read does not change.
  const verbs = calls()
    .map((a) => a[0])
    .filter((v) => !['comments', 'show', 'list'].includes(v));
  assert.deepEqual(verbs.slice(0, 2), ['comment', 'close']);
  assert.deepEqual(relates().map((a) => a[3]), ['bc-767a']);
});

/* --------------------------------------------------------- the client half, in source */

console.log('\nand the card that draws them');

const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'graph.js'), 'utf8');

check('the sheet groups `relates-to` with the see-alsos, not with what blocks', () => {
  // A textual check because public/graph.js is served to a browser and imports nothing,
  // so the set cannot be reached from here. Without the spelling, every edge the sweep
  // drew arrives on the card under "Waits on".
  const set = CLIENT.match(/const RELATED = new Set\(\[[^\]]*\]\)/s)?.[0] || '';
  assert.ok(set.includes("'relates-to'"), `RELATED is ${set}`);
});

check('and does not print the same neighbour twice, because bd stores both ends', () => {
  // `bd dep relate` writes a row at each end, so the pair is already above the
  // description under Related; drawing the incoming half as well is the same
  // duplication the parent-child rule below it exists to prevent.
  const fn = CLIENT.slice(CLIENT.indexOf('function dependentsHtml'), CLIENT.indexOf('function dependentsHtml') + 400);
  assert.ok(fn.includes("!== 'relates-to'"), fn.split('\n').slice(0, 6).join('\n'));
});

/* ------------------------------------------------------------------------ verdict */

console.log('');
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall good\x1b[0m');
