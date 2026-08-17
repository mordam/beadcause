#!/usr/bin/env node
/**
 * Admitting a pull request to the merge queue — bc-okja.
 *
 *     npm test
 *     node test/mergeadmit.mjs
 *
 * lib/mergeraise.js takes a pull request *out* of the queue and hands it to Adam; this is
 * the inverse, and the whole risk in an inverse is that it is not one. Four things are
 * pinned here, and each is a way the round trip could be lossy without anything failing:
 *
 * 1. **The labels are exactly the ones the raise moved**, in both directions. `queueFor`
 *    selects on `merge-queue` *and* on the assignee, so a bead that gets the label back
 *    and not the owner is invisible to the queue in a way that reads, from a board, as
 *    queued. That one is asserted directly against `queueFor` rather than against a list
 *    of strings, because the list of strings is the thing that would drift.
 * 2. **A card that was never in the queue is admitted the same way**, which is the
 *    Climative case: `autoMerge` off means the worker filed a question, not a merge-bead,
 *    so there is nothing to re-arm — and the point of matching on the `beadpr` block
 *    rather than on labels is that both shapes are found by one function.
 * 3. **The state is reset and not merely edited.** An admitted bead that kept its three
 *    spent attempts would be handed straight back on the next tick, and the card that came
 *    back would say "tried 3 times" about a decision Adam had just made.
 * 4. **The approval is a gate input, not a bypass.** `gateVerdict` takes it in place of a
 *    GitHub review — which the author of a branch cannot give themselves — and takes it
 *    *only* in that position, so a red check still refuses a merge with an approval on it.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const { admitPlan, admittedState, approvedState, beadsAbout, admitComment, HUMAN_LABEL } = await import(LIB('mergeadmit.js'));
const { MAX_ATTEMPTS, MERGE_ASSIGNEE, MERGE_LABEL, mergeBeadBody, queueState, withQueueBlock } = await import(LIB('mergebead.js'));
const { gateVerdict, queueFor } = await import(LIB('mergeadvocate.js'));
const { DELIVERY_LABEL, deliveryBody } = await import(LIB('delivery.js'));

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

console.log('\nadmitting a pull request to the merge queue\n');

/* ------------------------------------------------------------------ the world */

const SPEC = {
  workspace: 'demo',
  bead: 'zz-work',
  repo: 'acme/widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  branch: 'work-a',
  base: 'main',
  method: 'merge',
};

/** A merge-bead the queue is holding, as `bd list` hands one over. */
const queuedBead = (notes = '', over = {}) => ({
  id: 'zz-merge',
  title: 'Merge #42 — zz-work',
  status: 'open',
  labels: [MERGE_LABEL],
  assignee: MERGE_ASSIGNEE,
  description: mergeBeadBody(SPEC),
  notes,
  ...over,
});

/**
 * The same bead after lib/mergeraise.js handed it over: label off, inbox on — and the
 * queue's own state block still in `notes`, which is what that function keeps on purpose
 * and the only thing that still says this bead was ever the queue's.
 */
const raisedBead = (notes = withQueueBlock('', { attempts: 1, refused: 'lint' }), over = {}) =>
  queuedBead(notes, {
    labels: [HUMAN_LABEL, DELIVERY_LABEL],
    description: deliveryBody({ ...SPEC, title: 'a widget' }, { refused: '1 check failing (lint).' }),
    ...over,
  });

/** A delivery card from a space with auto-merge off — never in a queue at all. */
const card = (over = {}) => ({
  id: 'zz-card',
  title: 'Merge #42? a widget',
  status: 'open',
  labels: [HUMAN_LABEL, DELIVERY_LABEL],
  assignee: '',
  description: deliveryBody({ ...SPEC, title: 'a widget' }, {}),
  notes: '',
  ...over,
});

const about = { repo: 'acme/widgets', number: 42, by: 'Adam', at: '2026-08-15T00:00:00Z' };

/* ------------------------------------------------------------------ the finding */

check('a merge-bead, a raised one and a card are all found by the block they share', () => {
  for (const row of [queuedBead(), raisedBead(), card()]) {
    const found = beadsAbout([row], about);
    assert.equal(found.length, 1, `${row.id} was not matched`);
    assert.equal(found[0].spec.number, 42);
  }
});

check('and a bead about a different pull request is not', () => {
  const other = queuedBead('', { id: 'zz-other', description: mergeBeadBody({ ...SPEC, number: 43, url: 'https://github.com/acme/widgets/pull/43' }) });
  assert.equal(beadsAbout([other], about).length, 0);
});

check('a number alone does not match another repo of the same number', () => {
  const elsewhere = queuedBead('', {
    id: 'zz-elsewhere',
    description: mergeBeadBody({ ...SPEC, repo: 'acme/other', url: 'https://github.com/acme/other/pull/42' }),
  });
  assert.equal(beadsAbout([elsewhere], about).length, 0);
  // …and the work bead still finds it, which is the half a number cannot answer.
  assert.equal(beadsAbout([elsewhere], { ...about, number: null, bead: 'zz-work' }).length, 1);
});

check('nothing to compare matches nothing, rather than everything', () => {
  assert.deepEqual(beadsAbout([queuedBead(), card()], { repo: 'acme/widgets' }), []);
});

/* ------------------------------------------------------------------- the plan */

check('a raised merge-bead is re-armed with exactly the labels the raise moved', () => {
  const plan = admitPlan([raisedBead(withQueueBlock('', { attempts: 2, refused: 'lint', resolving: true }))], about);
  assert.equal(plan.action, 'admit');
  assert.equal(plan.id, 'zz-merge');
  assert.deepEqual(plan.addLabels, [MERGE_LABEL]);
  assert.deepEqual(plan.removeLabels.sort(), [DELIVERY_LABEL, HUMAN_LABEL].sort());
  assert.equal(plan.assignee, MERGE_ASSIGNEE);
});

check('and the bead that comes out of it is one the queue will actually pick up', () => {
  const row = raisedBead(withQueueBlock('', { attempts: 3, refused: 'lint', resolving: true }));
  const plan = admitPlan([row], about);
  // The row as it is after the writes bin/merge.js makes from the plan.
  const admitted = {
    ...row,
    labels: [...row.labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels],
    assignee: plan.assignee,
    description: mergeBeadBody(SPEC),
    notes: withQueueBlock(row.notes, plan.state),
  };
  const { queued, stuck, broken } = queueFor([admitted]);
  assert.equal(queued.length, 1, 'the queue does not see the bead this admitted');
  assert.equal(stuck.length + broken.length, 0);
  assert.equal(queued[0].state.approved, true, 'the approval did not survive the write');
});

check('a delivery card from a space with auto-merge off becomes the queue entry itself', () => {
  const plan = admitPlan([card()], about);
  assert.equal(plan.action, 'admit');
  assert.equal(plan.id, 'zz-card', 'it filed something new beside a card that was already there');
  assert.equal(plan.assignee, MERGE_ASSIGNEE, 'a card carries no assignee, so one has to be set');
  assert.match(plan.why, /card in the inbox/);
});

check('a bead already queued and moving is left where it is', () => {
  const plan = admitPlan([queuedBead(withQueueBlock('', { attempts: 1 }))], about);
  assert.equal(plan.action, 'approve');
  assert.deepEqual(plan.addLabels, []);
  assert.deepEqual(plan.removeLabels, []);
  assert.equal(plan.assignee, null);
  assert.equal(plan.state.attempts, 1, 'it reset the attempts of a bead the queue is mid-way through');
  assert.equal(plan.state.approved, true);
});

check('one that carries the label but is out of attempts is re-armed rather than left', () => {
  const plan = admitPlan([queuedBead(withQueueBlock('', { attempts: MAX_ATTEMPTS, refused: 'lint' }))], about);
  assert.equal(plan.action, 'admit');
  assert.equal(plan.state.attempts, 0);
  assert.match(plan.why, /attempts/);
});

check('one a resolver window is on is re-armed too — being asked about is what has just ended', () => {
  const plan = admitPlan([queuedBead(withQueueBlock('', { attempts: 1, resolving: true }))], about);
  assert.equal(plan.action, 'admit');
  assert.equal(plan.state.resolving, false);
});

check('nothing open about the pull request means one is filed', () => {
  const plan = admitPlan([], about);
  assert.equal(plan.action, 'file');
  assert.equal(plan.id, null);
  assert.equal(plan.state.approved, true);
});

check('a second open bead about the same pull request is named rather than ignored', () => {
  const plan = admitPlan([raisedBead(), card()], about);
  assert.equal(plan.id, 'zz-merge', 'the merge-bead is the one to act on when both exist');
  assert.deepEqual(plan.others, ['zz-card']);
});

/* ------------------------------------------------------------------ the state */

check('an admitted state is a reset, and keeps only what is not an opinion about the branch', () => {
  const state = admittedState({ attempts: 3, downmerges: 2, refused: 'lint', resolving: true, baseline: ['test/reenter'] }, { by: 'Adam', at: 'now' });
  assert.equal(state.attempts, 0);
  assert.equal(state.downmerges, 0);
  assert.equal(state.refused, null);
  assert.equal(state.resolving, false);
  assert.deepEqual(state.baseline, ['test/reenter'], 'what main was already failing is a fact, not a verdict');
  assert.equal(state.approved, true);
  assert.equal(state.approvedBy, 'Adam');
});

check('approving without moving keeps the attempt count', () => {
  const state = approvedState({ attempts: 2, downmerges: 1, refused: 'lint' }, { by: 'Adam', at: 'now' });
  assert.equal(state.attempts, 2);
  assert.equal(state.downmerges, 1);
  assert.equal(state.approved, true);
});

check('the approval survives the notes block it is written into', () => {
  const notes = withQueueBlock('a note somebody left', admittedState(null, { by: 'Adam', at: '2026-08-15T00:00:00Z' }));
  const read = queueState({ notes });
  assert.equal(read.approved, true);
  assert.equal(read.approvedBy, 'Adam');
  assert.equal(read.approvedAt, '2026-08-15T00:00:00Z');
  assert.match(notes, /a note somebody left/, 'the block ate what was already in notes');
});

check('and a bead nobody approved says so', () => {
  assert.equal(queueState({ notes: withQueueBlock('', { attempts: 1 }) }).approved, false);
  assert.equal(queueState({ notes: '' }).approved, false);
  assert.ok(!/approved/.test(withQueueBlock('', { attempts: 1 })), 'every merge-bead now carries an approval field');
});

/* ------------------------------------------------------------------- the gate */

const green = { failed: [], failing: 0, pending: 0, total: 3, state: 'success' };
const red = { failed: ['lint'], failing: 1, pending: 0, total: 3, state: 'failure' };

check('an approval on the bead satisfies a space that asks for one', () => {
  const v = gateVerdict({ checks: green, baseline: [], requireApproval: true, reviewDecision: 'REVIEW_REQUIRED', approved: true });
  assert.equal(v.merge, true);
  assert.equal(v.awaitingApproval, false);
});

check('without one, the same pull request still waits', () => {
  const v = gateVerdict({ checks: green, baseline: [], requireApproval: true, reviewDecision: 'REVIEW_REQUIRED' });
  assert.equal(v.merge, false);
  assert.equal(v.awaitingApproval, true);
});

check('an approval is not a bypass: a check the branch broke still refuses', () => {
  const v = gateVerdict({ checks: red, baseline: [], requireApproval: true, approved: true });
  assert.equal(v.merge, false);
  assert.match(v.refused, /lint/);
  assert.equal(v.awaitingApproval, false, 'a refusal was reported as a wait');
});

check('nor a way past a conflict', () => {
  const v = gateVerdict({ checks: green, baseline: [], mergeable: 'CONFLICTING', requireApproval: true, approved: true });
  assert.equal(v.merge, false);
  assert.equal(v.conflicted, true);
});

/* ---------------------------------------------------------------- the sentence */

check('the comment names who approved it and says the gates still apply', () => {
  const text = admitComment(admitPlan([raisedBead()], about), { by: 'Adam' });
  assert.match(text, /Adam approved/);
  assert.match(text, /gates still apply/i);
});

check('and an already-queued one does not claim to have moved anything', () => {
  const text = admitComment(admitPlan([queuedBead()], about), { by: 'Adam' });
  assert.match(text, /already on the merge queue/);
});

/* ------------------------------------------- the bead that carries both — bc-7qo.8 */

/**
 * A merge-bead wearing the queue's label *and* `human`, which is the state lib/inmain.js
 * used to create by finding a `worktree-` string in the bead's own text.
 *
 * The reason it is worth a section of its own is that it is the one shape where every
 * signal `beadsAbout` reads says *queued* and the queue cannot see the bead at all: the
 * exclusion is in `bd.listAgent`, a layer above `queueFor`, so nothing counts it and an
 * empty sweep prints nothing. Adam approved one of these five times over twenty hours.
 */
const shunnedBead = (notes = '') => queuedBead(notes, { labels: [MERGE_LABEL, HUMAN_LABEL] });

check('a merge-bead carrying `human` is not reported as queued, label and assignee notwithstanding', () => {
  const [found] = beadsAbout([shunnedBead()], about);
  assert.equal(found.labelled, true, 'it does carry the queue label');
  assert.equal(found.assigned, true, 'and the queue assignee');
  assert.equal(found.shunned, true, 'but the read excludes it');
  assert.equal(found.queued, false, 'so it must not read as queued');
});

check('so re-approving it re-arms it and strips the label, rather than recording a fifth opinion', () => {
  const plan = admitPlan([shunnedBead()], about);
  assert.equal(plan.action, 'admit', 'it was treated as already moving');
  assert.ok(plan.removeLabels.includes(HUMAN_LABEL), '`human` was left on the bead');
  assert.ok(plan.addLabels.includes(MERGE_LABEL));
  assert.equal(plan.assignee, MERGE_ASSIGNEE);
});

check('and the sentence says what was actually wrong, not one of the reassuring ones', () => {
  const plan = admitPlan([shunnedBead()], about);
  assert.match(plan.why, /invisible/i);
  assert.doesNotMatch(plan.why, /already on the queue/i);
});

check('the state is reset too, so a re-armed bead does not arrive with spent attempts', () => {
  const plan = admitPlan([shunnedBead(withQueueBlock('', { attempts: MAX_ATTEMPTS, refused: 'lint' }))], about);
  assert.equal(plan.action, 'admit');
  assert.equal(plan.state.attempts, 0);
});

check('an ordinary queued bead is untouched by all of this', () => {
  const plan = admitPlan([queuedBead()], about);
  assert.equal(plan.action, 'approve');
  assert.deepEqual(plan.removeLabels, []);
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
