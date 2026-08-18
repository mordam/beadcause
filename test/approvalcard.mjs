#!/usr/bin/env node
/**
 * Both cards say where the *ruling* on a bead is, beside where its branch is.
 *
 *     npm test
 *     node test/approvalcard.mjs
 *
 * bc-bmry.5, answering dv-uhl. deluvia's `docs/APPROVAL_PIPELINE.md` defines a four-state
 * machine over labels — draft → in-review → approved (a close) → revise — and until this
 * landed no code read a word of it. The answer to dv-uhl was explicitly *not* to teach
 * `lib/prstage.js` a second ladder: the pull request axis stays exactly as it was and the
 * ruling is drawn beside it, because they are two facts rather than two readings of one.
 *
 * Five things that could quietly come apart, and one of them is the whole suite:
 *
 * 1. **`lib/prstage.js` is untouched.** The decision was "second axis, not a ladder
 *    refactor", and the cheapest way for that to be undone is for somebody to helpfully
 *    unify them later. Asserted here rather than trusted.
 * 2. **The derivation**, which is mostly about the answers that are *not* a state: a bead
 *    with no approval labels gets `null` and no chip at all, `human-replied` on its own
 *    never means `revise` (it is set on every commented-on bead in every workspace), and
 *    `approved` is a close rather than a label.
 * 3. **The field reaches both readers.** `toQuestion` drops `labels`, so the inbox has
 *    nothing to work from client-side; `/api/bead` hands the sheet the identical object.
 * 4. **Each renderer, run for real**, over the shapes that matter. Not "the source
 *    mentions `a.state`", which passes just as happily from inside a comment.
 * 5. **The absent case.** Almost every bead in every workspace is outside this pipeline
 *    and both renderers must draw *nothing* — which is also what a page cached from a
 *    newer deploy sees against a daemon that predates the field.
 *
 * No browser, no network, no `bd`. public/app.js is one IIFE with nothing exported, so
 * the chip is sliced out and run in a `vm` the way test/modelcard.mjs does it; public/
 * graph.js is sliced the same way.
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
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-approvalcard-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { approvalCard, APPROVAL_IDS, approvalInfo } = await import(LIB('approvalcard.js'));
const { toQuestion } = await import(LIB('decision.js'));

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
const GRAPH = read('public/graph.js');
const CSS = read('public/style.css');
const SERVER = read('lib/server.js');
const PRSTAGE = read('lib/prstage.js');

/** A `bd show --json` row, as thin as either card needs it. */
const bead = (labels, status = 'open') => ({ id: 'dv-x1', title: 'Chapter 7', status, labels });

/* ------------------------------------------------- 1. the axis that was not touched */

console.log('\nthe PR ladder is still the PR ladder');

check('lib/prstage.js knows nothing about approval — dv-uhl chose a second axis, not a refactor', () => {
  // The decision, in one assertion. "Teach stageOf to take a ladder" was option (a) and
  // it lost; the way it comes back is somebody unifying the two files a month from now
  // because they look alike. They are not alike: one is about a branch and one is about
  // a ruling, and half of deluvia's deliverables never have a branch at all.
  // Word boundaries, not `includes`: `lib/prstage.js` is mostly prose, and a header that
  // one day says "propagate" or "delegate" must not read as the two axes being joined.
  for (const word of ['approval', 'in-review', 'needs-approval', 'gate']) {
    const at = new RegExp(`\\b${word}\\b`, 'i');
    assert.ok(!at.test(PRSTAGE), `lib/prstage.js mentions \`${word}\` — the two axes have been joined`);
  }
  // And still six rungs, in the order the board sorts on.
  assert.match(PRSTAGE, /id: 'review'/);
  assert.match(PRSTAGE, /id: 'live'/);
});

/* ------------------------------------------------------------- 2. the derivation */

console.log('\nthe one derivation both cards draw from');

check('a bead outside the pipeline gets nothing at all, which is most of every tracker', () => {
  // The opposite call from lib/modelcard.js beside it, and deliberately: every bead is
  // routed to a model, almost none is a review packet, and every inbox payload pays for
  // whatever is added to it.
  assert.equal(approvalCard(bead([])), null);
  assert.equal(approvalCard(bead(['human', 'P1', 'canon'])), null);
  assert.equal(approvalCard({ id: 'dv-x1' }), null);
  assert.equal(approvalCard(null), null);
});

check('`human-replied` alone is never `revise` — beadcause sets it on every tracker it has', () => {
  // The trap the whole file is arranged around. REPLIED_LABEL is written by /api/comment
  // whenever you comment without answering, in any workspace; read on its own it would
  // put a `revise` chip across half of beadcause.
  assert.equal(approvalCard(bead(['human', 'human-replied'])), null);
  assert.equal(approvalCard(bead(['needs-approval', 'human', 'human-replied'])).state, 'revise');
});

check('the four states, off the labels the document defines', () => {
  assert.equal(approvalCard(bead(['draft'])).state, 'draft');
  assert.equal(approvalCard(bead(['needs-approval', 'human'])).state, 'in-review');
  assert.equal(approvalCard(bead(['needs-approval', 'human'], 'closed')).state, 'approved');
  assert.equal(approvalCard(bead(['needs-approval', 'human', 'human-replied'])).state, 'revise');
  assert.deepEqual(APPROVAL_IDS, ['draft', 'in-review', 'approved', 'revise']);
});

check('approval is the close, so it is read off the status and never off a label', () => {
  // "There is no 'approved but still open' state, and there is no way to approve two
  // things with one tap." A closed packet is approved however it closed — calling it
  // `in-review` because the label is still sitting there would have the card claiming an
  // outstanding question that is not outstanding.
  assert.equal(approvalCard(bead(['needs-approval', 'human'], 'closed')).state, 'approved');
  assert.equal(approvalCard(bead(['needs-approval', 'human'], 'in_progress')).state, 'in-review');
});

check('a closed draft is finished work, not an approval — no state rather than a wrong one', () => {
  const a = approvalCard(bead(['draft', 'gate:G2'], 'closed'));
  assert.equal(a.state, null, 'a closed draft was reported as being in a state');
  assert.deepEqual(a.gates, ['G2'], 'and its gate went missing with it');
});

check('revise outranks in-review while the bead still carries both labels', () => {
  // Between your comment and the agent's next pass both labels are on the bead; the
  // truer of the two is that it is no longer waiting on you.
  const a = approvalCard(bead(['needs-approval', 'human', 'human-replied']));
  assert.equal(a.state, 'revise');
  assert.equal(a.label, 'revise');
  assert.match(a.note, /back with the agent/i);
});

check('a gate is the thing states are counted towards, and says so with no state of its own', () => {
  const a = approvalCard(bead(['gate']));
  assert.equal(a.state, null);
  assert.equal(a.isGate, true);
  assert.deepEqual(a.gates, []);
});

check('`gate:G2` means it counts towards G2 — the opposite of the bare label', () => {
  const a = approvalCard(bead(['gate:G2', 'draft']));
  assert.equal(a.isGate, false, 'a deliverable was read as a gate — `startsWith` bit somebody');
  assert.deepEqual(a.gates, ['G2']);
  assert.equal(a.state, 'draft');
});

check('two gates are two gates, and a repeat is one', () => {
  assert.deepEqual(approvalCard(bead(['gate:G2', 'gate:G4', 'gate:G2'])).gates, ['G2', 'G4']);
});

check('the gate is spelled as bd stores it, capital G and all', () => {
  // bd does not normalise labels, so matching is case-insensitive and display is not:
  // `gate:G2` is what `bd list -l "gate:G2"` wants and a lower-cased chip would be
  // quietly correcting the document.
  const a = approvalCard(bead(['Gate:G2']));
  assert.deepEqual(a.gates, ['G2']);
});

check('the revision counter rides the child that does the pass', () => {
  assert.equal(approvalCard(bead(['draft', 'revision:2'])).revision, 2);
  assert.equal(approvalCard(bead(['draft'])).revision, null);
  // A bare `revision:` and a word are not a number and must not be drawn as one.
  assert.equal(approvalCard(bead(['revision:'])), null);
  assert.equal(approvalCard(bead(['revision:soon'])), null);
});

check('needs-approval without human is the bug the document calls out by name', () => {
  // The worst shape available: it never reaches the phone — the inbox is `bd human list`
  // — *and* the advocate, whose definition of work is ready-minus-`human`, may open an
  // unattended session on it.
  const a = approvalCard(bead(['needs-approval']));
  assert.equal(a.state, 'in-review');
  assert.match(a.problem, /never reaches the phone/);
  assert.equal(approvalCard(bead(['needs-approval', 'human'])).problem, null);
});

check('a packet that has been ruled on is not flagged for a label it no longer needs', () => {
  assert.equal(approvalCard(bead(['needs-approval'], 'closed')).problem, null);
});

check('a bead claiming to be a gate and to count towards one is flagged', () => {
  assert.match(approvalCard(bead(['gate', 'gate:G2'])).problem, /never `gate:GN`/);
});

check('every state carries its own words, so no renderer writes them', () => {
  for (const id of APPROVAL_IDS) {
    const info = approvalInfo(id);
    assert.ok(info?.label && info?.note, `${id} has no words`);
  }
  assert.equal(approvalInfo('merged'), null, 'a PR rung resolved as an approval state');
});

/* ------------------------------------------------- 3. it reaches both card payloads */

console.log('\nthe field reaches both cards');

check('toQuestion carries it, because the inbox has no labels to read', () => {
  const q = toQuestion('deluvia', {
    id: 'dv-x1',
    title: 'Chapter 7',
    status: 'open',
    labels: ['needs-approval', 'human', 'gate:G2'],
  });
  assert.ok(!('labels' in q), 'toQuestion started passing labels through — this check is now about the wrong thing');
  assert.deepEqual(q.approval, approvalCard(bead(['needs-approval', 'human', 'gate:G2'])));
});

check('and it is null on the cards this tracker actually draws', () => {
  const q = toQuestion('beadcause', { id: 'bc-x1', title: 'A bead', status: 'open', labels: ['human'] });
  assert.equal(q.approval, null);
});

check('/api/bead hands the sheet the same object, as a field rather than a route', () => {
  const handler = SERVER.slice(SERVER.indexOf("p === '/api/bead' &&"), SERVER.indexOf("p === '/api/bead-links'"));
  assert.match(handler, /approvalCard\(issue\)/, '/api/bead no longer derives the approval state');
  assert.match(handler, /\bapproval,?\n/, 'it is derived and then not put on the response');
});

/* ------------------------------------------------------------ 4. the inbox chip */

/** Lift one declaration out of public/app.js — copied from test/modelcard.mjs. */
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

const chipCtx = vm.createContext({ String, JSON });
vm.runInContext([lift(APP, 'const esc = ('), lift(APP, 'function approvalChipHtml(q)')].join('\n'), chipCtx);
const chip = (labels, status) =>
  vm.runInContext('approvalChipHtml(Q)', Object.assign(chipCtx, { Q: { approval: approvalCard(bead(labels, status)) } }));
/** What a phone can actually read: the text, with every attribute taken off it. */
const visible = (html) => html.replace(/<[^>]*>/g, '').trim();

console.log('\nthe inbox chip');

check('a review packet says it is in review', () => {
  assert.match(visible(chip(['needs-approval', 'human'])), /in-review/);
  assert.match(chip(['needs-approval', 'human']), /class="pill approval is-in-review"/);
});

check('the gate it counts towards is in the text, not only in the title', () => {
  // A phone has no hover. The `title` is for a desktop and nothing depends on it.
  assert.match(visible(chip(['needs-approval', 'human', 'gate:G2'])), /in-review · G2/);
});

check('a revision pass is legible without opening anything', () => {
  assert.match(visible(chip(['draft', 'revision:2'])), /draft · rev 2/);
});

check('a gate bead reads as a gate rather than as a state', () => {
  assert.match(visible(chip(['gate'])), /gate/);
});

check('the label the document calls a bug is marked on the chip and named in the title', () => {
  const html = chip(['needs-approval']);
  assert.match(visible(html), /⚠/);
  assert.match(html, /class="pill approval bad"/);
  assert.match(html, /title="[^"]*never reaches the phone/);
});

check('a bead outside the pipeline draws no chip at all', () => {
  assert.equal(chip([]), '');
  assert.equal(chip(['human']), '');
});

check('a payload from a daemon that predates the field draws nothing rather than throwing', () => {
  // The phone caches its own script, and a card is drawn before anything checks versions.
  assert.equal(vm.runInContext('approvalChipHtml(Q)', Object.assign(chipCtx, { Q: {} })), '');
  assert.equal(vm.runInContext('approvalChipHtml(Q)', Object.assign(chipCtx, { Q: { approval: null } })), '');
  assert.equal(vm.runInContext('approvalChipHtml(Q)', Object.assign(chipCtx, { Q: { approval: {} } })), '');
});

check('a label somebody put a quote in cannot write markup into the chip', () => {
  const html = vm.runInContext(
    'approvalChipHtml(Q)',
    Object.assign(chipCtx, {
      Q: { approval: { state: null, label: '', note: '', gates: ['"><img src=x>'], isGate: false, revision: null, problem: null } },
    })
  );
  assert.ok(!html.includes('<img'), html);
  assert.match(html, /&quot;&gt;&lt;img/);
});

check('the chip is drawn in the card meta row, beside the model chip', () => {
  assert.match(APP, /\$\{approvalChipHtml\(q\)\}/, 'the chip is defined and never called');
  const at = APP.indexOf('function cardHtml(q)');
  const head = APP.slice(APP.indexOf('<div class="card-head">', at), APP.indexOf('<button type="button" class="q"', at));
  assert.match(head, /approvalChipHtml\(q\)/, 'the chip is called from somewhere other than the card head');
});

/* -------------------------------------------------------------- 5. the sheet row */

const START = 'const beadUrl = (id) =>';
const END = "return parts.join('');";
const from = GRAPH.indexOf(START);
const to = GRAPH.indexOf(END, from);
if (from < 0 || to < 0) {
  console.log('  \x1b[31m✗\x1b[0m public/graph.js no longer has a beadUrl…sheetHtml region to slice');
  process.exit(1);
}
const region = GRAPH.slice(from, GRAPH.indexOf('\n  }', to) + 4);
const sheetCtx = vm.createContext({
  esc: (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    ),
  statusColor: (s) => `colour(${s || 'open'})`,
  md: (t) => `<p>${t}</p>`,
  FROM_BD: { fromBd: true },
  workspace: 'deluvia',
});
const { sheetHtml, approvalRowHtml } = vm.runInContext(`${region}\n;({ sheetHtml, approvalRowHtml })`, sheetCtx);
const row = (labels, status) =>
  approvalRowHtml({ id: 'dv-x1', title: 'Chapter 7', approval: approvalCard(bead(labels, status)) });

console.log('\nthe bead details sheet');

check('the row has room for the sentence the chip compresses', () => {
  const html = row(['needs-approval', 'human']);
  assert.match(visible(html), /in-review/);
  assert.match(visible(html), /waiting on a ruling/);
});

check('the gate is its own clause rather than a replacement for the state', () => {
  const html = row(['needs-approval', 'human', 'gate:G2']);
  assert.match(visible(html), /in-review/);
  assert.match(visible(html), /counts towards G2/);
});

check('a deliverable ward has not filed yet says which way the silence is resolved', () => {
  const html = row(['gate:G2']);
  assert.match(visible(html), /no state yet/);
  assert.match(html, /approval-state is-none/);
});

check('the sheet is the only surface that can ever draw the missing-human bug', () => {
  // And that is the point rather than a limitation: the inbox *is* the set of `human`
  // beads, so a packet missing the label is by construction not on the card that would
  // have complained about it.
  const html = row(['needs-approval']);
  assert.match(visible(html), /⚠/);
  assert.match(visible(html), /advocate may open a session on it/);
  assert.match(html, /approval-problem/);
});

check('a bead outside the pipeline draws no row at all', () => {
  assert.equal(row([]), '');
  assert.equal(approvalRowHtml({ id: 'dv-x1' }), '');
  assert.equal(approvalRowHtml(null), '');
});

check('the row is on the sheet for an open bead and a closed one alike', () => {
  for (const status of ['open', 'closed', 'in_progress']) {
    const html = sheetHtml({
      id: 'dv-x1',
      title: 'Chapter 7',
      status,
      approval: approvalCard(bead(['needs-approval', 'human'], status)),
    });
    assert.match(html, /id="sheet-approval"/, `no approval row on a ${status} bead`);
  }
});

check('an ordinary bead sheet is exactly what it was', () => {
  const html = sheetHtml({ id: 'bc-x1', title: 'A bead', status: 'open', description: 'Some prose.' });
  assert.ok(!html.includes('sheet-approval'), 'an approval row was drawn on a bead with no approval field');
});

check('it sits above the session row, with the run below it', () => {
  const html = sheetHtml({
    id: 'dv-x1',
    title: 'Chapter 7',
    status: 'open',
    description: 'Some prose.',
    approval: approvalCard(bead(['needs-approval', 'human'])),
  });
  const approval = html.indexOf('id="sheet-approval"');
  const session = html.indexOf('id="sheet-session"');
  const desc = html.indexOf('class="md"');
  assert.ok(approval >= 0 && session > approval, 'the approval row landed below the session row');
  assert.ok(desc > approval, 'the approval row landed below the description');
});

/* ------------------------------------------------------------------- 6. the styles */

console.log('\nboth are styled, in one stylesheet');

check('every class either renderer draws has a rule behind it', () => {
  const drawn = [
    '.pill.approval',
    '.pill.approval.is-in-review',
    '.pill.approval.bad',
    '.approval-row',
    '.approval-kind',
    '.approval-state',
    '.approval-state.is-none',
    '.approval-state.is-gate',
    '.approval-why',
    '.approval-rev',
    '.approval-gate',
    '.approval-problem',
  ];
  for (const sel of drawn) assert.ok(CSS.includes(sel), `public/style.css has no rule for ${sel}`);
});

check('the chip does not shout the pipeline own words', () => {
  // `.pill` uppercases, and `in-review` is what APPROVAL_PIPELINE.md and `bd list -l`
  // say. `IN-REVIEW` is a spelling this app would have invented.
  const rules = CSS.slice(CSS.indexOf('.pill.approval {'), CSS.indexOf('.pill.approval.is-in-review'));
  assert.match(rules, /text-transform:\s*none/);
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `all ${ran} checks passed`}`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
