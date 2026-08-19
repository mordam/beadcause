#!/usr/bin/env node
/**
 * The Epic Advocate: a fifth agent kind, and the three beads that must not get one.
 *
 *     npm test
 *     node test/epicadvocate.mjs
 *
 * bc-rfnr.3, and the half of bc-rfnr.4 that is a rule rather than a wiring. Two things
 * here are worth a suite and neither is visible by reading one function:
 *
 * 1. **A fifth kind has to be a whole kind.** `AGENTS` is what `POST /api/console` gates
 *    on, `MARKS` is what draws a conversation's pill, and lib/foundation.js says out loud
 *    that a fifth kind should *fail* the coverage check rather than quietly ship as a
 *    generic 🤖. So this asserts the entry exists, carries a role, carries a mark, and —
 *    the one that matters — that its allowlist grants the writes the repo advocate is
 *    deliberately refused, since that difference is the entire argument for it being a
 *    kind at all.
 * 2. **`wantsAdvocate` is a gate, and every no is a bead it would be wrong about.** An
 *    unowned P0 has nobody to report to. A closed one has nothing to plan and would be
 *    reopened by a planner's last act (lib/stillopen.js). And a crash is not an epic:
 *    lib/errors.js files every daemon crash at P0 by construction, so without this every
 *    stack trace would spin up a planning agent.
 *
 * The brief is asserted as a pure function, the way test/planbrief.mjs asserts the
 * planner's: what is under test is the text an unattended window is handed, and the two
 * sentences it must always contain are the two it is forbidden by.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-epicadv-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  EPIC_ADVOCATE,
  WAITING_OPEN,
  WAITING_CLOSE,
  WAITING_MAX,
  waitingBlock,
  waitingLine,
  waitingOn,
  wantsAdvocate,
  isCrash,
  epicAdvocatePrompt,
} = await import(LIB('epicadvocate.js'));
const { AGENTS, baseline, mark } = await import(LIB('foundation.js'));
const { ERROR_LABEL } = await import(LIB('errors.js'));

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

console.log('\none advocate per owned P0\n');

const p0 = (extra = {}) => ({
  id: 'zz-p0',
  title: 'A P0 somebody owns',
  status: 'open',
  priority: 0,
  labels: ['owner:adam@example.com'],
  ...extra,
});

/* ------------------------------------------------------------------ the kind */

check('it is a fifth kind, not a mode — with a foundation and a mark of its own', () => {
  assert.ok(AGENTS.includes(EPIC_ADVOCATE), 'epic-advocate is not in AGENTS, so nothing can own a conversation as one');
  // Seven since bc-36xx.1 added `review-advocate` (six before it, when bc-r941 added
  // `merge-advocate`). The number is asserted rather than the membership because that is
  // what makes a *new* kind fail here — lib/foundation.js's own note says a kind added
  // without a mark should fail a check rather than quietly ship as a generic 🤖, and this
  // is that check.
  assert.equal(AGENTS.length, 7);
  const b = baseline(EPIC_ADVOCATE);
  assert.equal(b.id, EPIC_ADVOCATE);
  assert.ok(b.role && b.role.length > 200, 'a kind with no role is a mode with extra steps');
  const m = mark(EPIC_ADVOCATE);
  assert.ok(m?.name && m?.emoji, 'lib/foundation.js says a fifth kind must fail this rather than draw as 🤖');
  assert.notEqual(m.emoji, mark('advocate').emoji, 'the two advocates draw the same pill');
});

check('AND ITS PERMISSIONS ARE THE WHOLE ARGUMENT FOR IT BEING ONE', () => {
  const epic = baseline(EPIC_ADVOCATE);
  const repo = baseline('advocate');
  // The repo advocate may not invent work — that is its `writes: false`, and the review
  // step it protects. This one plans a P0 the user has already agreed to by owning it.
  assert.equal(repo.writes, false);
  assert.equal(epic.writes, true);
  assert.ok(epic.allowedTools.includes('Bash(bd create:*)'), 'it cannot file the children it exists to file');
  assert.ok(!repo.allowedTools.includes('Bash(bd create:*)'), 'the repo advocate has quietly gained create');
  // And since bc-goo.12 it is a tier 3 subject too — the experiment starved on the repo
  // advocate alone, whose runs are gated behind a cooldown and an unanswered proposal.
  assert.equal(epic.ownsRepo, true);
});

/* ------------------------------------------------- the foundation as a document
   (bc-xl7n.8.1)

   A role is not prose nobody depends on: it is what this agent is told on *every* run,
   and the failures it is the only guard against are the ones where doing the forbidden
   thing works. Two of these are the writes the allowlist grants and the sentence is the
   whole of the restraint — `bd update` can set a status, so "may not close" is the only
   thing between an advocate and closing the epic it is answerable for; `bd label
   remove` can strip `unendorsed`, which *is* the endorsement tap. The rest is the
   carrier map, without which "write everything down on the bead" names one of four
   places and the other three fill up with copies of the same sentence. */

check('THE ROLE NAMES ALL FOUR CARRIERS, NOT JUST THE BEAD', () => {
  const { role } = baseline(EPIC_ADVOCATE);
  assert.match(role, /waiting-on block in `notes`/, 'the line the P0 card draws is not named as a carrier');
  assert.match(role, /`beads` block in a comment/, 'the plan is not named as a carrier');
  assert.match(role, /\*\*Labels\*\*/, 'nothing says which facts have to be machine-readable');
  assert.match(role, /beadcause-memory debrief/, 'a re-entrant agent is not told where a visit report goes');
  // And that they are distinguished. Four names in a list is not a carrier map; the
  // failure this guards is one conclusion written into all four.
  assert.match(role, /four different\s+things/, 'the four are named but never told apart');
});

check('AND THE REFUSALS COVER THE WRITES ITS OWN ALLOWLIST GRANTS', () => {
  const { role, allowedTools } = baseline(EPIC_ADVOCATE);
  // `bd close` is absent, `bd update` is not, and a status is a field.
  assert.ok(!allowedTools.includes('Bash(bd close:*)'));
  assert.ok(allowedTools.includes('Bash(bd update:*)'));
  assert.match(role, /may not close anything/i, 'nothing stops it closing the P0 it is answerable for');
  // The endorsement refusal, aimed at the write that exists rather than at filing.
  assert.ok(allowedTools.includes('Bash(bd label remove:*)'));
  assert.match(role, /carrying\s+`unendorsed`/, 'the endorsement refusal does not name the label it is about');
  // The pause label is a button on Adam's screen; this agent can add labels.
  assert.ok(allowedTools.includes('Bash(bd label add:*)'));
  assert.match(role, /may not silence yourself/i, 'nothing stops an advocate pausing its own P0');
  // And the three that were already there stay there. The priority refusal is worded for an
  // epic rather than for a P0 since bc-htoy: the advocate's epic carries whatever priority
  // its owner gave it, so "raise a P0" named the one shape this refusal is no longer about.
  assert.match(role, /may not change your epic's priority, own it, or change who owns it/i);
  assert.match(role, /may not merge, push, deploy, or open a window/i);
});

check('and it says how it is re-entered, in the terms the sweep actually uses', () => {
  const { role } = baseline(EPIC_ADVOCATE);
  assert.match(role, /closes, is filed, or stalls/, 'the three events are not named');
  assert.match(role, /never when a child\s+merely starts/, 'the event that is deliberately excluded is not named');
  assert.match(role, /enrolment/i, 'nothing tells it that erasing its own sentence un-enrols the P0');
});

check('its brief and its protocol are owned by files that exist', () => {
  const b = baseline(EPIC_ADVOCATE);
  for (const f of [b.briefOwner, b.protocolOwner]) {
    assert.ok(fs.existsSync(path.join(HERE, '..', f)), `${f} does not exist, so the signpost points nowhere`);
  }
  assert.equal(b.briefOwner, 'lib/epicadvocate.js');
});

/* -------------------------------------------------------------- who gets one */

check('an owned, open P0 gets an advocate', () => {
  assert.equal(wantsAdvocate(p0()), true);
});

check('AN UNOWNED P0 DOES NOT — there is nobody for it to report to', () => {
  assert.equal(wantsAdvocate(p0({ labels: [] })), false);
  assert.equal(wantsAdvocate(p0({ labels: ['inbox'] })), false);
});

check('A CLOSED P0 DOES NOT — a planner’s last act is to reopen its epic', () => {
  assert.equal(wantsAdvocate(p0({ status: 'closed' })), false);
  assert.equal(wantsAdvocate(p0({ status: 'CLOSED' })), false);
  assert.equal(wantsAdvocate(p0({ status: 'in_progress' })), true, 'but in_progress is ordinary');
});

check('A CRASH P0 DOES NOT — a stack trace is not an epic (bc-rfnr.4)', () => {
  // lib/errors.js files every daemon crash at P0 by construction. Without this, six
  // crashes on a bad afternoon is six planning agents.
  const crash = p0({ labels: ['owner:adam@example.com', ERROR_LABEL] });
  assert.equal(isCrash(crash), true);
  assert.equal(wantsAdvocate(crash), false);
  // It is still a P0 and still owned — it leads the board and is dispatchable directly,
  // which is the point. Only the advocate is withheld.
  assert.equal(isCrash(p0()), false);
});

check('and nothing below P0 gets one, whoever owns it', () => {
  assert.equal(wantsAdvocate(p0({ priority: 1 })), false);
  assert.equal(wantsAdvocate(p0({ priority: 2 })), false);
  assert.equal(wantsAdvocate({}), false);
  assert.equal(wantsAdvocate(null), false);
});

/* --------------------------------------------------- what it writes down */

check('the waiting sentence survives a round trip, and an absent one is null', () => {
  const notes = `some provenance\n\n${waitingBlock('the merge queue in bc-rcrt')}\n\nmore`;
  assert.equal(waitingOn({ notes }), 'the merge queue in bc-rcrt');
  assert.equal(waitingOn({ notes: 'nothing marked here' }), null);
  assert.equal(waitingOn({}), null);
  assert.equal(waitingOn(null), null);
});

check('it is one line, bounded, and an empty one erases rather than writing a hollow block', () => {
  assert.equal(waitingBlock('  a   \n  b  '), `${WAITING_OPEN}\na b\n${WAITING_CLOSE}`);
  assert.equal(waitingBlock(''), '');
  assert.equal(waitingBlock(null), '');
  const long = waitingBlock('x'.repeat(500));
  assert.ok(long.length < 260, 'an unbounded sentence would push the card off the screen');
});

check('an unclosed block still reads, because half a sentence beats none', () => {
  assert.equal(waitingOn({ notes: `${WAITING_OPEN}\nwaiting on review` }), 'waiting on review');
});

/* ------- bc-zjab.5: the cap is enforced on the path the advocate actually takes.
   It writes the block by hand through `bd update --notes`, so no write path of ours is
   ever reached; the read is. Measured on bc-y3qk: 942 characters, drawn in full. */

check('THE CAP IS ENFORCED ON READ, SO A BLOCK NOBODY OF OURS WROTE STILL FITS THE CARD', () => {
  // The block as an advocate writes it: typed into a whole notes field, never through
  // `waitingBlock`. This is the exact shape that rendered a paragraph on bc-y3qk.
  const sentence = 'waiting on the merge queue, '.repeat(40).trim();
  assert.ok(sentence.length > 900, 'the fixture is no longer the size that caused this');
  const notes = `provenance\n\n${WAITING_OPEN}\n${sentence}\n${WAITING_CLOSE}\n\nmore`;
  const line = waitingOn({ notes });
  assert.ok(line.length <= WAITING_MAX, `a ${line.length}-character sentence still reaches the card`);
  assert.ok(line.endsWith('\u2026'), 'it stops mid-word, which reads as a broken card rather than a long sentence');
  assert.ok(sentence.startsWith(line.slice(0, 40)), 'and it is not the same sentence any more');
});

check('a sentence that already fits is untouched, ellipsis and all', () => {
  // The truncation must not be visible on the 30 epics whose line was always fine — an
  // ellipsis on a sentence that fits would be a card claiming words were dropped.
  const exact = 'x'.repeat(WAITING_MAX);
  assert.equal(waitingLine(exact), exact);
  assert.equal(waitingLine(`${exact}y`).length, WAITING_MAX);
  assert.equal(waitingOn({ notes: `${WAITING_OPEN}\n${exact}\n${WAITING_CLOSE}` }), exact);
  // And it cannot turn a line into nothing, which is what `isEnrolled` and `advocacyOn`'s
  // `by` read it for — an epic that fell out of enrolment because its sentence was long
  // would be an off switch nobody pressed.
  assert.ok(waitingOn({ notes: `${WAITING_OPEN}\n${'y'.repeat(2000)}\n${WAITING_CLOSE}` }));
});

check('and the two paths share one cap, so they cannot drift', () => {
  // The whole defect in one line: the limit used to live in `waitingBlock` alone.
  const long = 'z'.repeat(500);
  assert.equal(waitingOn({ notes: waitingBlock(long) }), waitingLine(long));
});

/* ------------------------------------------------------------------ the brief */

check('the brief names the P0, its owner, and what it may not do', () => {
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(text, /zz-p0/);
  assert.match(text, /adam@example\.com/, 'the brief does not say who it is answerable to');
  assert.match(text, /may not endorse/i, 'nothing stops it agreeing to its own work');
  assert.match(text, /priority or the owner/i, 'nothing stops it promoting its own P0');
  assert.match(text, /may not close anything/i, 'nothing stops it closing the P0 it is answerable for');
  assert.match(text, /--parent zz-p0/, 'a child filed anywhere else is a bead nothing will work');
});

/* ------------------------------------------- what the reason asks of it (bc-xl7n.8.1)

   The sweep hands this window one prose sentence saying what moved, and the brief used
   to say nothing at all about what to do with it. The stall is the one worth the words:
   a child left `in_progress` by a window that died is out of `bd ready` for good, and
   nothing — no advocate, no worker, no queue — looks at it again. Releasing the claim is
   inside this agent's allowlist, so the only thing missing was the sentence. */

check('WITH CHILDREN, THE BRIEF READS THE REASON AS ONE OF THREE SHAPES', () => {
  const kids = [{ id: 'zz-p0.1', title: 'one', status: 'in_progress', priority: 1 }];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam', {
    reason: 'zz-p0.1 has been in progress for over 1h with nothing on this Mac in a window on it',
  });
  assert.match(text, /A child closed\./, 'a close asks nothing in particular of it');
  assert.match(text, /A child was filed\./, 'a filing asks nothing in particular of it');
  assert.match(text, /A child stalled/, 'a stall asks nothing in particular of it');
});

check('AND A STALL NAMES THE WRITE THAT PUTS THE BEAD BACK IN THE QUEUE', () => {
  const kids = [{ id: 'zz-p0.1', title: 'one', status: 'in_progress', priority: 1 }];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam');
  assert.match(text, /--status open --assignee ""/, 'a dead window’s claim holds the bead out of every queue for good');
  assert.match(text, /invisible to `bd\s+ready`/, 'nothing says why an unreleased claim matters');
  // And it is not a reflex: the work may exist on a branch, in which case the bead is
  // exactly where it should be and the queue's own pull-request filter is holding it.
  assert.match(text, /branch or an open pull request/, 'it is told to release a claim without looking for the work first');
});

check('a fresh P0 with no children is not given the three shapes at all', () => {
  // There is nothing to have moved. A section that is noise on a first visit is a
  // section that stops being read on the visits where it matters.
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.ok(!text.includes('A child stalled'), 'a P0 with no children is briefed on child events');
});

check('AND A DECISION IT CANNOT MAKE HAS A DOOR THAT REACHES A PHONE', () => {
  // It has `bd create` and `bd label add` and nothing else that reaches Adam. A question
  // left in a comment is a question nobody is shown; one filed without `human` is picked
  // up as work by the next worker window.
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(text, /labelled `human`/, 'a question it files reaches nobody');
  assert.match(text, /`decision` block/, 'the question arrives with no options to tap');
  assert.match(text, /recommended: true/, 'and with no recommendation, which is the cheapest thing it can give');
});

check('with no children it is told to plan; with children it is told to take stock', () => {
  const fresh = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(fresh, /no children yet/);
  const kids = [
    { id: 'zz-p0.1', title: 'one', status: 'open', priority: 1 },
    { id: 'zz-p0.2', title: 'two', status: 'closed', priority: 1 },
  ];
  const going = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam');
  assert.match(going, /1 of 2 children are still open/);
  assert.match(going, /zz-p0\.1/);
  assert.ok(!going.includes('zz-p0.2'), 'a closed child is listed as work still to do');
});

check('a long child list is cut rather than shipped whole', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `zz-p0.${i}`, title: 't', status: 'open', priority: 2 }));
  const text = epicAdvocatePrompt('beadcause', p0(), many, null, 'Adam');
  assert.match(text, /…and 20 more\./);
});

check('and it always says where to write down what it concluded', () => {
  // It is re-entrant. Anything it keeps only in the conversation is gone when the window
  // closes, and the next one starts from the bead.
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.ok(text.includes(WAITING_OPEN) && text.includes(WAITING_CLOSE));
  assert.match(text, /re-entrant/);
});

check('AND IT SAYS HOW LONG THE SENTENCE MAY BE, WHICH THE MARKERS CANNOT (bc-zjab.5)', () => {
  // The brief quotes `WAITING_OPEN` and `WAITING_CLOSE`, and a marker says nothing about
  // length — so the number was in the code and nowhere an advocate could reach it. Four
  // consecutive visits to bc-y3qk each wrote ~900 characters. The digits are asserted,
  // not just the word "limit": a brief that says "keep it short" is what we already had.
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.ok(text.includes(String(WAITING_MAX)), 'the advocate is asked for the sentence and not told the cap');
  const at = text.indexOf(String(WAITING_MAX));
  assert.ok(at > text.indexOf(WAITING_CLOSE), 'the cap is stated before the block it is about');
  assert.ok(at < text.indexOf('beadcause-memory debrief'), 'and after the closing steps, where it is not about this');
});

/* ------------------------------------- the index of what it already knows (bc-goo.14) */
//
// This agent is re-entrant by design: it thinks for one turn, writes a sentence on the
// bead and exits, and the next window on the same P0 starts from the bead rather than
// from that conversation. Which makes it the one kind here that *cannot* carry anything
// between runs except what it wrote down — and until this landed, the only thing it was
// handed was `memoryBrief`, which says a store exists and never says what is in it. Four
// consecutive windows on bc-goo rebuilt the same conclusions from the tracker.
//
// The rule and its caps live in lib/memory.js and are tested there. What is asserted
// here is the same three things test/land.mjs asserts for the worker — that the brief
// carries the selection, that every other key is still visible so a capped section never
// reads as the whole store, and that an empty store gets no heading at all — plus the
// two that are this agent's own: the selection is against the P0 alone, and the store it
// is read from is the advocate's.

const NOTES = {
  'epic-adoption-is-prose-not-edges': {
    value:
      'A P0 "adopts" a bead by naming it in its description; there is no dep edge, so a subtree survey ' +
      'that walks edges alone misses half of what a P0 is answerable for. Bead: zz-p0.',
    at: '2026-08-13T09:00:00.000Z',
  },
  'standing-root-epics-are-dispatch-bait': {
    value:
      'A P0 with no children and an owner is opened on by the advocate every tick, so a standing root ' +
      'epic nobody means to decompose burns a window a day.',
    at: '2026-08-13T10:00:00.000Z',
  },
  'sw-cache-version-conflicts': {
    value: 'public/sw.js is the most likely merge conflict here — read both blocks before renumbering.',
    at: '2026-08-11T14:36:36.114Z',
  },
};

check('the brief carries the note that is about this P0', () => {
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam', { notes: NOTES });
  assert.match(text, /already worked out/, 'the index never reached the brief');
  assert.ok(text.includes('adopts'), 'the note naming this P0 was not the one it was handed');
});

check('and names the rest by key, so a capped section never reads as the whole store', () => {
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam', { notes: NOTES });
  assert.ok(text.includes('`sw-cache-version-conflicts`'), 'a note it was not handed is invisible from the brief');
  assert.ok(text.includes('beadcause-memory notes <key>'), 'and there is no way given to go and read it');
});

check('IT IS TOLD THESE ARE AN ADVOCATE’S NOTES, NOT A WORKER’S', () => {
  // The section says these are "what another <who> wrote down for its own future self",
  // and that clause is what makes them evidence rather than instructions. A P0
  // advocate's store is written by supervisors taking stock, never by somebody with the
  // file open, and an agent that misreads the author misreads the weight.
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam', { notes: NOTES });
  assert.match(text, /another Epic Advocate wrote down/);
  assert.ok(!/another worker wrote down/.test(text), 'it is being told a worker wrote its own memory');
});

check('an empty store gets no heading rather than a heading over nothing', () => {
  // The state every workspace was in on the day this shipped. An agent shown an empty
  // section twice learns the section is furniture and stops reading it on the day it has
  // something in it.
  for (const notes of [undefined, null, {}]) {
    const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam', { notes });
    assert.ok(!text.includes('already worked out'), `a hollow section for ${JSON.stringify(notes)}`);
    assert.ok(!text.includes('beadcause-memory notes <key>'));
  }
});

check('the index sits above the block telling it what to write down', () => {
  // Recall first, writing second — bc-714o's answer, and the reason the write half was
  // deferred. A supervisor that writes its waiting-on sentence without having read the
  // last four windows' is the write-only diary this epic exists to avoid.
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam', { notes: NOTES });
  assert.ok(
    text.indexOf('already worked out') < text.indexOf('Before you exit'),
    `${text.indexOf('already worked out')} vs ${text.indexOf('Before you exit')}`
  );
});

check('SELECTION IS AGAINST THE P0 ALONE, NOT THE P0 PLUS ITS CHILDREN', () => {
  // The open design question on bc-goo.14, answered by the epic worker's precedent
  // (`planPromptFor`, lib/session.js). A supervisor's subject is the subtree, so folding
  // the children's text in is tempting — and it is what turns the section into noise:
  // twenty beads' vocabulary matches nearly every note in the store. Here the children
  // are entirely about service workers and the sw note must still stay out of the body.
  const kids = [
    { id: 'zz-p0.1', title: 'Bump the sw.js cache version', status: 'open', priority: 1 },
    { id: 'zz-p0.2', title: 'public/sw.js precache list and the merge conflict', status: 'open', priority: 1 },
  ];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam', { notes: NOTES });
  assert.ok(!text.includes('read both blocks before renumbering'), 'the children pulled their own notes into the P0 brief');
  assert.ok(text.includes('`sw-cache-version-conflicts`'), 'and it is still listed by key, as everything unpicked is');
});

check('THE DAEMON READS THE ADVOCATE’S OWN STORE, NOT THE WORKER’S', () => {
  // The one thing here a pure-function test cannot see, and the one that would look
  // entirely correct while being wrong: the other two doors into an unattended session
  // pass `notesIn(dir, 'worker')` because a worker is what they open, and copying that
  // line would hand this agent another kind's memory under a heading saying it is its
  // own. Pinned as source rather than behaviour because reaching the call needs a
  // tracker, a checkout and a window, and this is one identifier.
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'session.js'), 'utf8');
  const from = src.indexOf('export async function openEpicAdvocateSession');
  assert.ok(from > 0, 'openEpicAdvocateSession has been renamed — re-point this check');
  const body = src.slice(from, src.indexOf('\n}\n', from));
  assert.match(body, /notesIn\(dir, EPIC_ADVOCATE\)/, 'the Epic Advocate is opened with no index, or with somebody else’s');
  assert.ok(!/notesIn\(dir, 'worker'\)/.test(body), 'it is being handed the worker’s notes');
});

/* --------------------------------------------------- tier 4, in the one window that
   could not see it (bc-nib3.9) */

check('THE BRIEF ASKS FOR A DEBRIEF, AND NAMES IT AS THE THIRD THING', () => {
  // The write half. A supervisor already leaves two things behind — the waiting-on
  // sentence and its notes — so the failure this guards against is not "it says nothing
  // about memory", it is the closing step reading as a restatement of those two. The
  // command has to be there and it has to be distinguished from them.
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(text, /beadcause-memory debrief "/, 'the Epic Advocate is never asked for a report on its visit');
  const at = text.indexOf('beadcause-memory debrief');
  assert.ok(at > text.indexOf(WAITING_CLOSE), 'the report is asked for before the sentence the card draws');
  assert.ok(at < text.indexOf('Three things you may not do'), 'and it is not the last word — the refusals are');
});

check('AND IT IS HANDED WHAT ITS PREVIOUS VISITS LEFT', () => {
  // The read half, without which the ask above is the write-only diary bc-714o refused
  // to build the other half of.
  const debriefs = [
    { bead: 'zz-p0', at: '2026-08-13T09:00:00Z', text: 'The build here needs vendor run first; two hours lost to that.' },
  ];
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam', { debriefs });
  assert.match(text, /two hours lost to that/, 'the last visit’s report is not in the brief');
  assert.match(text, /an earlier run at this bead/, 'and it is not attributed, so its weight cannot be judged');
});

check('and a P0 nobody has reported on gets no heading at all', () => {
  // `notesBrief`’s rule, for `debriefBrief`’s reason: a heading with nothing under it
  // teaches this agent that the section is furniture, and it is re-opened for weeks.
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam', { debriefs: [] });
  assert.ok(!text.includes('What the last runs at this bead actually hit'), 'an empty tier 4 section is still drawn');
});

check('AND THE DOOR STAMPS THE BEAD, WHICH IS THE HALF NO BRIEF CAN SHOW', () => {
  // The whole of bc-nib3.9 in one argument: `launch` writes `BEADCAUSE_BEAD` only when
  // it is handed a bead, and this door passed an agent and no bead — so `beadcause-memory
  // debrief` refused in the one window opened on the same bead for weeks. Pinned as
  // source for the same reason the notes-store check above is: reaching the call needs a
  // tracker, a checkout and a window, and this is one property.
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'session.js'), 'utf8');
  const from = src.indexOf('export async function openEpicAdvocateSession');
  assert.ok(from > 0, 'openEpicAdvocateSession has been renamed — re-point this check');
  const body = src.slice(from, src.indexOf('\n}\n', from));
  assert.match(body, /agent: EPIC_ADVOCATE, bead: row\.id/, 'the Epic Advocate is opened with no bead, so debrief refuses');
  assert.match(body, /debriefs: await debriefsFor\(dir, row\)/, 'and it is asked for a report it is never shown one of');
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
