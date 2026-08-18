#!/usr/bin/env node
/**
 * The relay journal — the trail a department relay writes, and the epic card that draws it.
 *
 *     npm test
 *     node test/relayjournal.mjs
 *
 * bc-bmry.4. `dv-vzg` let a relay run through four or five roles in one unattended window
 * *on condition* that every step and handoff is readable from the epic card, so this file
 * is really about one property: **a step that ran is a step that can still be read**. Five
 * things could take that away quietly.
 *
 * 1. **An entry destroying an earlier one.** Every other marked block in this repo is a
 *    current answer that later writes replace, and lib/mergebead.js needs a hardened cutter
 *    for exactly that. This one is appended and never cut — so what is asserted is that
 *    appending a second entry leaves the first, that a hand-written note beside it survives,
 *    and that a block whose closing marker has been lost costs one row rather than the file.
 * 2. **A role's own words ending the HTML comment.** `-->` inside a note would close the
 *    block early and take the rest of the notes out of the document with it.
 * 3. **The trail not reaching the card.** Two payloads, not one: the whole trail on
 *    `/api/bead` for the bead you tapped, the last entry alone on each tree row of the
 *    board. A feature drawn on two surfaces fails by one of them silently losing its field.
 * 4. **The renderers drawing nothing, or drawing the wrong thing.** Both are run for real
 *    over the shapes that matter, rather than the source being grepped for a property name.
 * 5. **A phone having no hover.** Everything the row carries has to be in its text.
 *
 * No browser, no network, no `bd`, nothing under `~`: lib/relayjournal.js is pure, and
 * public/app.js is one IIFE with nothing exported, so its renderers are sliced out and run
 * in a `vm` the way test/modelcard.mjs does it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const { RELAY_CLOSE, RELAY_MAX, RELAY_OPEN, RELAY_STEPS, journalFrom, relayEntryBlock, relayMark, relayTrail } =
  await import(path.join(ROOT, 'lib', 'relayjournal.js'));

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
};

const APP = read('public/app.js');
const CSS = read('public/style.css');
const SERVER = read('lib/server.js');
const SESSION = read('lib/session.js');
const BIN = read('bin/relaystep.js');

/** What `bd update --append-notes` does: adds, with a newline, and never rewrites. */
const append = (notes, block) => (notes ? `${notes}\n${block}` : block);

const entry = (over = {}) =>
  relayEntryBlock({ at: '2026-08-18T12:00:00.000Z', role: 'aria', step: 'draft', note: 'the outline', ...over });

/* ------------------------------------------------------------ 1. round trip */

console.log('\nthe journal, written and read back');

check('an entry survives the round trip with every field it was given', () => {
  const notes = entry({ next: 'clio', flag: 'two dates unsourced' });
  assert.deepEqual(journalFrom(notes), [
    {
      at: '2026-08-18T12:00:00.000Z',
      role: 'aria',
      step: 'draft',
      note: 'the outline',
      next: 'clio',
      flag: 'two dates unsourced',
    },
  ]);
});

check('the block is an HTML comment, so nothing of it draws in the notes field', () => {
  const block = entry();
  assert.ok(block.startsWith(RELAY_OPEN), 'the open marker is not an HTML comment opener');
  assert.ok(block.endsWith(RELAY_CLOSE), 'the close marker does not terminate the comment');
  assert.ok(RELAY_OPEN.startsWith('<!--') && RELAY_CLOSE.endsWith('-->'));
  assert.ok(!block.includes('\n'), 'one line, so a trail is not a wall of text in `bd show`');
});

check('a second entry does not touch the first, and neither touches a human note', () => {
  // The whole reason this is `--append-notes` and not a rewritten block: there is no cutter
  // here, so there is nothing that can cut too much.
  let notes = 'Adam: leave the harbour scene alone.';
  notes = append(notes, entry());
  notes = append(notes, entry({ at: '2026-08-18T12:40:00.000Z', role: 'clio', step: 'check', note: 'fact pass' }));
  const rows = journalFrom(notes);
  assert.deepEqual(rows.map((r) => `${r.role}:${r.step}`), ['aria:draft', 'clio:check']);
  assert.ok(notes.includes('leave the harbour scene alone'), 'the human note was eaten');
});

check('entries come back in the order they were written', () => {
  let notes = '';
  for (const [i, role] of ['aria', 'clio', 'muse', 'aria', 'ward'].entries()) {
    notes = append(notes, entry({ at: `2026-08-18T1${i}:00:00.000Z`, role, note: `step ${i}` }));
  }
  assert.deepEqual(journalFrom(notes).map((r) => r.note), ['step 0', 'step 1', 'step 2', 'step 3', 'step 4']);
});

/* ------------------------------------------------------ 2. what could break it */

console.log('\nwhat a role writing prose could do to it');

check('a note containing the comment terminator does not end the block early', () => {
  const notes = append(entry({ note: 'the arrow --> in section 3 is wrong' }), 'and a line after it');
  assert.ok(!notes.includes('wrong -->'), 'the terminator went in raw and closed the comment');
  const rows = journalFrom(notes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, 'the arrow --> in section 3 is wrong', 'the escape was not reversed on read');
  assert.ok(notes.trimEnd().endsWith('and a line after it'), 'the text after the block was swallowed');
});

check('unparseable junk between the markers costs one row, not a throw', () => {
  const notes = [`${RELAY_OPEN} {not json at all} ${RELAY_CLOSE}`, entry({ role: 'clio' })].join('\n');
  const rows = journalFrom(notes);
  assert.equal(rows.length, 1, 'the scan did not resume after the bad block');
  assert.equal(rows[0].role, 'clio');
});

check('a block with no closing marker ends the scan and keeps what came before it', () => {
  const notes = [entry(), `${RELAY_OPEN} {"role":"clio"`].join('\n');
  const rows = journalFrom(notes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'aria');
});

check('a bead with no journal at all reads as an empty list and never as null rows', () => {
  assert.deepEqual(journalFrom(''), []);
  assert.deepEqual(journalFrom(null), []);
  assert.deepEqual(journalFrom('ordinary notes somebody typed'), []);
});

check('a hollow entry is not written, and a hollow one already there is not read', () => {
  for (const over of [{ role: '' }, { step: '' }, { note: '' }, { note: '   ' }]) {
    assert.equal(entry(over), '', `${JSON.stringify(over)} produced a block`);
  }
  const hollow = `${RELAY_OPEN} {"at":"x","role":"aria","step":"draft","note":""} ${RELAY_CLOSE}`;
  assert.deepEqual(journalFrom(hollow), []);
});

check('a field is clamped rather than refused, and newlines in it are flattened', () => {
  const rows = journalFrom(entry({ note: `${'x'.repeat(RELAY_MAX + 50)}`, flag: 'a\nb\n\nc' }));
  assert.equal(rows[0].note.length, RELAY_MAX);
  assert.equal(rows[0].flag, 'a b c');
});

check('a role is lower-cased on the way in, so the card never draws two of one agent', () => {
  const rows = journalFrom(entry({ role: 'Clio', next: 'MUSE' }));
  assert.equal(rows[0].role, 'clio');
  assert.equal(rows[0].next, 'muse');
});

/* ------------------------------------------------------------- 3. the readers */

console.log('\nthe two readers, and why there are two');

check('relayTrail counts the flags and reads the hand-back off the last entry only', () => {
  let notes = entry({ flag: 'a date' });
  notes = append(notes, entry({ role: 'clio', step: 'check', note: 'checked', flag: 'a source' }));
  notes = append(notes, entry({ role: 'aria', step: 'revise', note: 'answered both' }));
  const trail = relayTrail({ notes });
  assert.equal(trail.entries.length, 3);
  assert.equal(trail.flagged, 2);
  assert.equal(trail.handedBack, false, 'a relay that was flagged is not a relay that stopped');
  assert.equal(trail.last.step, 'revise');
});

check('a hand-back is the last word, and being picked up again takes it back', () => {
  const back = append(entry(), entry({ role: 'clio', step: 'handback', note: 'ran out of room' }));
  assert.equal(relayTrail({ notes: back }).handedBack, true);
  const resumed = append(back, entry({ role: 'clio', step: 'check', note: 'picked it up' }));
  assert.equal(relayTrail({ notes: resumed }).handedBack, false);
});

check('relayMark is the last entry plus how far it has got — and carries no trail with it', () => {
  const notes = append(entry(), entry({ at: '2026-08-18T12:40:00.000Z', role: 'clio', step: 'check', note: 'fact pass' }));
  assert.deepEqual(relayMark({ notes }), {
    role: 'clio',
    step: 'check',
    at: '2026-08-18T12:40:00.000Z',
    steps: 2,
    flagged: 0,
    flag: null,
  });
  assert.ok(!('entries' in relayMark({ notes })), 'the whole trail rode out on every tree row');
});

check('both readers answer null for a bead nothing has ever relayed', () => {
  for (const bead of [{}, { notes: '' }, { notes: 'nothing marked here' }, null]) {
    assert.equal(relayTrail(bead), null);
    assert.equal(relayMark(bead), null);
  }
});

check('handback is a step the writer accepts — it is the one the chain cannot contain', () => {
  assert.ok(RELAY_STEPS.includes('handback'));
  for (const s of ['draft', 'check', 'revise', 'file']) assert.ok(RELAY_STEPS.includes(s), s);
});

/* ---------------------------------------------------------- 4. reaching the card */

console.log('\nthe field reaching both surfaces');

check('the whole trail is on /api/bead, and the last step alone on every tree row', () => {
  assert.match(SERVER, /import \{ relayMark, relayTrail \} from '\.\/relayjournal\.js';/);
  assert.match(SERVER, /const relay = relayTrail\(issue\);/, 'the sheet route lost its trail');
  assert.match(SERVER, /relay: relayMark\(beads\.get\(row\.id\)\)/, 'the tree row lost its mark');
});

check('the relay brief tells the session to write it, with the tool and not by hand', () => {
  assert.match(SESSION, /const RELAY_CMD = \(\) => `node \$\{path\.join\(MAIN, 'bin', 'relaystep\.js'\)\}`;/);
  // Once per handoff and once for the hand-back: the hand-back is the entry the card most
  // needs, and it is the one a session under pressure would skip.
  assert.ok(SESSION.split('${RELAY_CMD()}').length - 1 >= 2, 'the hand-back no longer records a step');
  assert.match(SESSION, /--step handback/);
});

check('the writer stamps the time itself, because that is the fact the card is read for', () => {
  assert.match(BIN, /relayEntryBlock\(\{ role, step, next, note, flag \}\)/);
  assert.ok(!/--at\b/.test(BIN), 'a timestamp an agent types by hand is one that can be wrong');
  assert.match(BIN, /appendNotes/, 'the writer stopped appending and can now destroy a trail');
});

/* -------------------------------------------------------------- 5. the drawing */

function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  if (opener.startsWith('function')) {
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (!depth) return src.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener}`);
  }
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${opener}`);
}

const ctx = vm.createContext({ String, JSON, Date, Math, Array, Number });
vm.runInContext(
  [
    lift(APP, 'const esc = ('),
    lift(APP, 'function relTime(iso)'),
    lift(APP, 'function p0RelayHtml(relay)'),
    lift(APP, 'function p0RelayTrailHtml(relay)'),
  ].join('\n'),
  ctx
);
const rowHtml = (mark) => vm.runInContext('p0RelayHtml(M)', Object.assign(ctx, { M: mark }));
const trailHtml = (trail) => vm.runInContext('p0RelayTrailHtml(T)', Object.assign(ctx, { T: trail }));
/** What a phone can actually read: the text, with every attribute taken off it. */
const visible = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const minsAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

console.log('\nthe row on the epic card');

check('a bead nothing relayed draws nothing at all', () => {
  assert.equal(rowHtml(null), '');
  assert.equal(rowHtml(undefined), '');
  assert.equal(rowHtml({ steps: 3 }), '', 'a mark with no role drew a row anyway');
  assert.equal(trailHtml(null), '');
  assert.equal(trailHtml({ entries: [] }), '');
});

check('the row says which role, which step, how far, and how long ago', () => {
  const seen = visible(rowHtml(relayMark({ notes: append(entry(), entry({ role: 'clio', step: 'check', at: minsAgo(40), note: 'fact pass' })) })));
  assert.match(seen, /clio/);
  assert.match(seen, /check/);
  assert.match(seen, /2 steps/);
  assert.match(seen, /40m ago/, 'the age is the whole difference between stalled and working');
});

check('every one of those facts is in the text, because a phone has no hover', () => {
  const html = rowHtml(relayMark({ notes: entry({ at: minsAgo(5), role: 'muse' }) }));
  const seen = visible(html);
  for (const want of ['muse', 'draft', 'ago']) assert.ok(seen.includes(want), `\`${want}\` is only in an attribute`);
});

check('a flagged step and a hand-back are marked, and marked differently', () => {
  const flagged = rowHtml(relayMark({ notes: entry({ flag: 'two dates unsourced' }) }));
  assert.match(flagged, /class="[^"]*\bflagged\b/);
  assert.match(visible(flagged), /⚑/, 'the flag is invisible on the row');
  const back = rowHtml(relayMark({ notes: entry({ step: 'handback', note: 'ran out of room' }) }));
  assert.match(back, /class="[^"]*\bback\b/);
  assert.ok(!/\bflagged\b/.test(back), 'an unflagged hand-back is drawn as a flag');
});

console.log('\nthe trail on the opened bead');

check('every step is drawn, oldest first, with its note', () => {
  let notes = entry({ next: 'clio' });
  notes = append(notes, entry({ role: 'clio', step: 'check', note: 'fact pass done', flag: 'a date' }));
  notes = append(notes, entry({ role: 'ward', step: 'file', note: 'packet filed as dv-9' }));
  const html = trailHtml(relayTrail({ notes }));
  const seen = visible(html);
  assert.ok(seen.indexOf('aria') < seen.indexOf('clio'), 'the trail is drawn newest first');
  assert.ok(seen.indexOf('clio') < seen.indexOf('ward'));
  for (const want of ['the outline', 'fact pass done', 'packet filed as dv-9', 'a date']) {
    assert.ok(seen.includes(want), `\`${want}\` never reached the screen`);
  }
  assert.match(seen, /3 steps/);
  assert.match(seen, /1 flagged/);
});

check('a hand-back says so above the rows as well as on the row itself', () => {
  const html = trailHtml(relayTrail({ notes: append(entry(), entry({ step: 'handback', note: 'out of room' })) }));
  assert.match(visible(html), /handed back/);
  assert.match(html, /class="p0-trail-row back"/);
});

check('a role writing markup writes text, not markup', () => {
  const html = trailHtml(relayTrail({ notes: entry({ note: '<img src=x onerror=1>', flag: '<b>bold</b>' }) }));
  assert.ok(!/<img/.test(html), 'a note was interpolated as HTML');
  assert.ok(!/<b>bold/.test(html), 'a flag was interpolated as HTML');
  assert.match(html, /&lt;img/);
});

check('every class either renderer draws has a rule in the stylesheet', () => {
  for (const cls of [
    'p0-relay',
    'p0-relay.back',
    'p0-relay.flagged',
    'p0-relay-sum',
    'p0-trail',
    'p0-trail-row',
    'p0-trail-row.back',
    'p0-trail-who',
    'p0-trail-step',
    'p0-trail-when',
    'p0-trail-note',
    'p0-trail-flag',
  ]) {
    assert.ok(CSS.includes(`.${cls}`), `\`.${cls}\` is drawn and styled by nothing`);
  }
});

console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
