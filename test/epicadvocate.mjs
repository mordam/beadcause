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
  ADVOCATE_LABEL,
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
// bc-jvt0.4. Imported rather than spelled out, for the reason test/plandispatch.mjs imports
// `DISPATCHED_PREFIX`: the brief quotes a document lib/plan.js owns and the daemon reads, so
// a suite carrying its own copy of the label would go on passing after a rename and the epic
// would be held for ever by a brief telling an advocate to write the wrong thing.
const { MIN_WHY_CHARS, WHOLE_CLOSE, WHOLE_LABEL, WHOLE_OPEN } = await import(LIB('plan.js'));

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

/* --------------------- the child list says which in_progress is which (bc-xl7n.99)

   `in_progress` is the tracker's status and nothing more — a worker that reached one of
   its two documented endings (delivered, or handed back with a question) is left in
   exactly this state, and every prior pass at this epic paid a PR read, a worktree check
   and a lock check to tell it apart from a real stall. Both facts are free at this call:
   `human` is a label already on the row, and `deliveryCard` is the caller's own index,
   already walked for `reentryFor`. */

check('an in_progress child under `human` reads as handed back, not merely in_progress', () => {
  const kids = [{ id: 'zz-p0.1', title: 'a question', status: 'in_progress', priority: 1, labels: ['human'] }];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam');
  assert.match(text, /`zz-p0\.1` P1 in_progress — handed back, waiting on an answer — a question/);
});

check('an in_progress child parked behind a delivery card names it, by id', () => {
  const kids = [{ id: 'zz-p0.2', title: 'a pull request', status: 'in_progress', priority: 1 }];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam', {
    deliveryCard: (k) => (k.id === 'zz-p0.2' ? 'zz-rnk4' : null),
  });
  assert.match(text, /`zz-p0\.2` P1 in_progress — delivered, waiting on `zz-rnk4` — a pull request/);
});

check('`human` wins over a delivery card if somehow both fire', () => {
  // Cannot happen through the real doors — bin/deliver.js's park() and a handback are
  // different endings of the same worker window — but the read should still say
  // something rather than pick between two clauses in the same slot at random.
  const kids = [{ id: 'zz-p0.3', title: 'both', status: 'in_progress', priority: 1, labels: ['human'] }];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam', { deliveryCard: () => 'zz-rnk4' });
  assert.match(text, /handed back, waiting on an answer/);
  assert.ok(!text.includes('delivered, waiting on'), 'one annotation per row, not two');
});

check('a supervised child epic reads as supervised, and the brief forbids releasing it', () => {
  // bc-xl7n.118. On a root, `in_progress` is not a worker's claim — `boardMove` writes it
  // when Adam presses Start, deliberately into the tracker so the board is the same fact
  // on every device. The stall prescription two sections up (`--status open --assignee ""`)
  // is that write's exact inverse, so it would silently take the epic off the board.
  // `reentryFor` already drops such a row from the stall clock; the row is still drawn,
  // because it is still a child of this epic, and it now says which kind of `in_progress`
  // it is.
  const kids = [
    { id: 'zz-p0.4', title: 'a sub-epic', status: 'in_progress', priority: 0, issue_type: 'epic', labels: [ADVOCATE_LABEL] },
  ];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam');
  assert.match(text, /`zz-p0\.4` P0 in_progress — supervised by an advocate of its own, not stalled — a sub-epic/);
  assert.match(text, /Never run that on a child that is an epic with an advocate of its own/);
  // The cost, not just the prohibition — and the owner is named off the epic, the same
  // source the filing bullet above uses, rather than hardcoded.
  assert.match(text, /takes the epic off \S+'s board/);

  // And the same child with nobody on it is an ordinary row again: the annotation follows
  // the enrolment, not the type. Asserted on the *row* rather than on the whole brief,
  // because the caveat prose quotes the annotation — a whole-brief `!includes` here would
  // be a test that can never fail.
  const alone = epicAdvocatePrompt('beadcause', p0(), [{ ...kids[0], labels: [] }], null, 'Adam');
  assert.match(alone, /`zz-p0\.4` P0 in_progress — a sub-epic/, 'an unsupervised sub-epic is just in_progress');
});

/* --------------------- and what the child list cannot see (bc-khoe.33)

   A plan reaches the whole subtree — `unplanned` counts a ready bead at any depth as work
   the epic's plan has to cover, and since bc-khoe.33 `validatePlan` will let a group name
   one. `kids` is direct children, so an advocate deciding whether the plan still fits was
   deciding it over one level of a tree that may be several. bc-khoe had eleven beads it
   could neither see here nor group. `advocatedRoots` already walks the subtree beside the
   children, so this costs the caller nothing. */

check('the brief lists what is open further down, and says a group may name it', () => {
  const kids = [{ id: 'zz-p0.1', title: 'a sub-epic', status: 'open', priority: 1 }];
  const tree = [
    { id: 'zz-p0.1', title: 'a sub-epic', status: 'open', priority: 1 },
    { id: 'zz-p0.1.1', title: 'a grandchild', status: 'open', priority: 2 },
    { id: 'zz-p0.1.2', title: 'a closed one', status: 'closed', priority: 2 },
  ];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam', { tree });
  assert.match(text, /1 more bead is open further down/, 'the count is of what the list above omits');
  assert.match(text, /`zz-p0\.1\.1` P2 open — a grandchild/, 'and it is named, the way a child is');
  assert.match(text, /A group may name any of them/, 'seeing it is no use without being told it is groupable');
  assert.ok(!text.includes('zz-p0.1.2'), 'a closed one is not outstanding work');
});

check('a caller with no subtree in hand says nothing rather than guessing', () => {
  // The card-driven door has no index to walk, exactly as it has none for `deliveryCard`.
  // Silence is the safe direction: the alternative is a fresh `bd.graph` call on a tap.
  const kids = [{ id: 'zz-p0.1', title: 'one', status: 'open', priority: 1 }];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam');
  assert.ok(!text.includes('open further down'), 'no tree, no section');
});

check('a subtree that is only the direct children adds nothing to the brief', () => {
  const kids = [{ id: 'zz-p0.1', title: 'one', status: 'open', priority: 1 }];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam', { tree: [...kids] });
  assert.ok(!text.includes('open further down'), 'the section is for what `kids` cannot show, not a second copy of it');
});

check('a genuinely stalled in_progress child reads exactly as it always has', () => {
  const kids = [{ id: 'zz-p0.4', title: 'stuck', status: 'in_progress', priority: 1 }];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam');
  assert.match(text, /`zz-p0\.4` P1 in_progress — stuck/, 'no annotation, no dash inserted, nothing missing');
});

check('open and closed children carry no annotation, whatever `deliveryCard` says', () => {
  const kids = [
    { id: 'zz-p0.5', title: 'ready', status: 'open', priority: 2 },
    { id: 'zz-p0.6', title: 'done', status: 'closed', priority: 2 },
  ];
  // A misbehaving injectable that answers yes to everything must still only speak for
  // `in_progress` rows — the annotation is about telling a stall from its two endings,
  // not about redecorating every line.
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam', { deliveryCard: () => 'zz-rnk4' });
  assert.match(text, /`zz-p0\.5` P2 open — ready/);
  assert.ok(!text.includes('zz-p0.6'), 'closed children are not in the list at all');
});

check('with no `deliveryCard` injected, delivery is simply never claimed', () => {
  // The card-driven door (`POST /api/bead/advocate`) has no index to build one from
  // without a fresh `bd.graph` call — the default must be silent, not a thrown error.
  const kids = [{ id: 'zz-p0.7', title: 'maybe delivered', status: 'in_progress', priority: 1 }];
  const text = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam');
  assert.match(text, /`zz-p0\.7` P1 in_progress — maybe delivered/);
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

/* ------------------------------------- the childless branch is a decision, not an order
   (bc-jvt0.4)

   This branch used to open "planning it is the whole job this time" and go straight on to
   filing children — an instruction to decompose, given to the one agent that had read the
   bead, whatever the bead said. Adam's decision (2026-08-21) is that this agent judges and
   the default is to do the work; the queue half is `heldByChildren` check 4 in
   lib/advocate.js, pinned in test/epicqueue.mjs.

   Three cases, one per answer, and then the two things about them that are easy to get
   wrong: the default has to be *stated* as the default (an agent handed three equal options
   picks by temperament), and the third answer has to be *named* (an agent with no third
   answer has to pick one of the first two, which is the plan-filed-to-look-productive
   failure this bead was filed about). */

check('THE DEFAULT IS TO DO IT WHOLE, AND IT SAYS SO', () => {
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(text, /Do it whole — and this is the default/, 'the default is not stated as the default');
  assert.match(text, /one branch and one pull request/, 'nothing says what "simple enough" is measured against');
  // The refusal that is the whole point: a bead filed so that a worker has something to
  // hold is the failure mode, and it has to be named rather than merely not-recommended.
  assert.match(text, /merely to give a worker something to hold/, 'nothing refuses a bead filed for the dispatcher');
  // And it is not left as a conclusion in a conversation nobody keeps: the label is what
  // the queue reads, so a decision that does not write it is an epic that stays held.
  assert.ok(text.includes(WHOLE_LABEL), 'the label the queue reads is not named');
  // bc-jvt0.6: it is handed a command to run, not a block to retype by hand — the door
  // that validates before anything is written, rather than markers it cannot check itself.
  assert.match(text, new RegExp(`beadcause-epicplan -w beadcause -b ${p0().id}`), 'the validated door is not named');
  assert.ok(!text.includes(WHOLE_OPEN) && !text.includes(WHOLE_CLOSE), 'it is still quoting the raw markers to retype');
  assert.match(text, /whole:\s*\n\s*why: \|/, 'the YAML shape it is handed does not match what beadcause-epicplan reads');
  assert.match(text, new RegExp(`floor of\\s+${MIN_WHY_CHARS} characters`), 'the reason has no stated floor');
});

check('SPLITTING IS THE SECOND ANSWER AND IT OWES A REASON', () => {
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(text, /Split it — and say why/, 'the split answer does not ask for a reason');
  assert.match(text, /genuinely needs to be several/, 'nothing says when a split is the right answer');
  assert.match(text, /--parent zz-p0/, 'the one thing a filed child must carry is missing');
  // Why no marker: the children are the record, and saying so is what stops a window
  // adding the whole-job label alongside a split it just filed.
  assert.match(text, /no label to add/, 'nothing says a split needs no marker of its own');
});

check('AND ASKING IS THE THIRD, NAMED OUTRIGHT RATHER THAN LEFT IMPLIED', () => {
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(text, /Neither — ask/, 'the third answer is not offered');
  assert.match(text, /not a failure/, 'asking is offered without being made safe to choose');
  assert.match(text, /Do not invent a decomposition/, 'the failure mode this bead is about is not refused');
  // Both writes, because only one of them is the question: a `human` bead reaches the
  // phone, and `human` on the epic itself is what stops the queue offering it meanwhile.
  assert.match(text, /`human` bead carrying a `decision` block/, 'the question has no door to a phone');
  assert.match(text, /put\n?`human` on zz-p0 itself/, 'the epic is left in the queue while the question stands');
});

check('and the brief says the queue is waiting on this, so a visit that decides nothing costs a tick', () => {
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(text, /the queue holds this epic/, 'nothing tells it that the dispatch is waiting on its answer');
  assert.match(text, /yours to decide/, 'the decision is not claimed for this agent');
});

check('with no children it decides the shape; with children it is told to take stock', () => {
  const fresh = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(fresh, /This epic has no children, so the one thing this visit decides/);
  // The sentence that used to be here, gone on purpose — see the heading above.
  assert.ok(!fresh.includes('planning it is the whole job this time'), 'the brief still orders a decomposition');
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
