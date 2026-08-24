#!/usr/bin/env node
/**
 * A merge over open review findings files work, once — bc-9ntye.2.
 *
 *     npm test
 *     node test/reviewfollowup.mjs
 *
 * Under bc-9ntye a review no longer holds a branch unless it found something `blocking`.
 * That is only half an answer: the other half is that the suggestions and questions it
 * *did* raise have to land somewhere a person or an advocate will see them again, or the
 * epic has quietly turned "review everything" into "review nothing".
 *
 * The four failures worth a suite, in the order they would hurt:
 *
 * 1. **A second copy of somebody's whole verdict.** `finish` is best-effort from end to
 *    end and the sweep re-reads the same review block every tick, so a crash between the
 *    filing and the close brings the next tick back to exactly this state. The key is
 *    asked over *closed* beads too, because a follow-up that was filed, worked and closed
 *    an hour ago is precisely the one a live-only lookup would answer "no" about.
 * 2. **A follow-up parented under a bead that is closing this second.** The merge-bead
 *    and (usually) the work bead both close in the next few lines; an open child of a
 *    closed parent is bc-rfnr.7's held-forever bead, drawn on every screen as ordinary
 *    open work. `followUpFrom` is the whole of the guard and its interesting case is the
 *    work bead that is *itself* a root.
 * 3. **Filing work for a change the worker already made.** A comment answered `changed`
 *    is on the branch that just merged; asking for it again is the review loop reopened
 *    by the mechanism that was meant to close it.
 * 4. **A merge that says nothing about where the findings went.** The epic asks in as
 *    many words for the merge-bead's sentence and the card to name the follow-up, and a
 *    "merged with open findings" that does not say *where* is the same dead end as a
 *    comment claiming a bead closed when it did not.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const {
  FOLLOWUP_LABEL,
  FOLLOWUP_KEY_PREFIX,
  FOLLOWUP_PRIORITY,
  fileReviewFollowUp,
  followUpFrom,
  followUpKey,
  followUpOwed,
  followUpPlan,
  followUpSentence,
} = await import(LIB('reviewfollowup.js'));
const { reviewState, withReviewBlock } = await import(LIB('mergebead.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

console.log('\nfiling a follow-up when a branch merges over open review findings\n');

/* ------------------------------------------------------------------- the world */

const SPEC = {
  workspace: 'demo',
  repo: 'Someone/demo',
  number: 671,
  url: 'https://github.com/Someone/demo/pull/671',
  base: 'main',
  branch: 'worktree-x',
  bead: 'zz-work',
};

/** A review block as `reviewState` hands one back — through the real writer, never by hand. */
const review = (over = {}) =>
  reviewState({
    notes: withReviewBlock('', {
      round: 1,
      verdict: 'changes',
      reviewedSha: 'abcdef1',
      refused: 'two things worth a second look',
      comments: [
        { id: 'c1', path: 'lib/example.js', line: 42, body: 'this could be a Set', severity: 'suggestion', why: 'it is O(n) per call' },
        { id: 'c2', path: '', line: null, body: 'why is the retry four and not three', severity: 'question' },
      ],
      ...over,
    }),
  });

/**
 * A tracker that records rather than one that pretends — the same shape
 * test/mergequeue.mjs uses, with the two calls this path actually makes.
 *
 * `existing` is what `listLabelAny` answers, which is the only way to reach the
 * already-filed branch without a real tracker and two ticks.
 */
function fakeBd({ existing = [], failCreate = null } = {}) {
  const calls = { created: [], asked: [] };
  let n = 0;
  return {
    calls,
    listLabelAny: async (ws, label) => {
      calls.asked.push(label);
      return existing;
    },
    create: async (ws, issue) => {
      if (failCreate && failCreate(issue)) throw new Error(`bd refused: ${issue.title}`);
      n += 1;
      const id = `zz-f${n}`;
      calls.created.push({ id, ...issue });
      return id;
    },
  };
}

/* ------------------------------------------------------------------ the key */

await check('the key names the repo, the pull request and the round', () => {
  assert.equal(followUpKey({ repo: 'Someone/demo', number: 671, round: 2 }), `${FOLLOWUP_KEY_PREFIX}someone/demo#671:r2`);
});

await check('a round of nought has no key, so nothing can be filed under one', () => {
  assert.equal(followUpKey({ repo: 'Someone/demo', number: 671, round: 0 }), '');
  assert.equal(followUpKey({ repo: 'Someone/demo', number: null, round: 1 }), '');
});

await check('a delivery that named no repo is keyed by its workspace, not by `unknown`', () => {
  assert.equal(followUpKey({ workspace: 'demo', number: 4, round: 1 }), `${FOLLOWUP_KEY_PREFIX}demo#4:r1`);
});

await check('two rounds on the same pull request are different keys', () => {
  const one = followUpKey({ repo: 'a/b', number: 9, round: 1 });
  const two = followUpKey({ repo: 'a/b', number: 9, round: 2 });
  assert.notEqual(one, two);
});

/* ------------------------------------------------------------- what is owed */

await check('an unresolved comment is owed whatever its severity', () => {
  assert.deepEqual(followUpOwed(review()).map((c) => c.id), ['c1', 'c2']);
});

await check('a resolved comment is not owed — the reviewer looked again and was satisfied', () => {
  const r = review({ comments: [{ id: 'c1', body: 'a', severity: 'suggestion', resolved: true }] });
  assert.deepEqual(followUpOwed(r), []);
});

await check('a comment the worker answered `changed` is not owed — it is on the branch that merged', () => {
  const r = review({
    comments: [
      { id: 'c1', body: 'use a Set', severity: 'suggestion', answer: 'changed', note: 'done in the second commit' },
      { id: 'c2', body: 'why four', severity: 'question', answer: 'clarify', note: 'four is the retry budget' },
    ],
  });
  assert.deepEqual(followUpOwed(r).map((c) => c.id), ['c2'], 'a clarify is still open; a change is not');
});

await check('a declined comment is still owed, and it is the one most likely to be dropped', () => {
  const r = review({ comments: [{ id: 'c1', body: 'split this file', severity: 'suggestion', answer: 'declined', note: 'it is one idea' }] });
  assert.deepEqual(followUpOwed(r).map((c) => c.id), ['c1']);
});

await check('a bead nothing reviewed owes nothing', () => {
  assert.deepEqual(followUpOwed(reviewState({})), []);
  assert.deepEqual(followUpOwed(null), []);
});

/* ------------------------------------------------------------ where it hangs */

const INDEX = {
  beads: new Map([
    ['zz-epic', { id: 'zz-epic', issue_type: 'epic', priority: 1, status: 'open' }],
    ['zz-work', { id: 'zz-work', issue_type: 'task', priority: 2, status: 'open' }],
    ['zz-p0', { id: 'zz-p0', issue_type: 'task', priority: 0, status: 'open' }],
  ]),
  parents: new Map([
    ['zz-work', 'zz-epic'],
    ['zz-p0', 'zz-epic'],
  ]),
};

await check('an ordinary work bead is homed from its parent, not from itself', () => {
  assert.equal(followUpFrom(INDEX, 'zz-work'), 'zz-epic');
});

await check('a P0 work bead is a root, and homing from it would parent under a bead that is closing', () => {
  // The whole point: `rootOver` puts a root above itself, so `from: zz-p0` would have
  // answered `zz-p0` — a bead the merge closes three lines later.
  assert.equal(followUpFrom(INDEX, 'zz-p0'), 'zz-epic');
});

await check('an epic work bead answers itself, because an epic stays open over a merge', () => {
  assert.equal(followUpFrom(INDEX, 'zz-epic'), 'zz-epic');
});

await check('a work bead with no parent, and an index that would not read, both answer nothing', () => {
  assert.equal(followUpFrom(INDEX, 'zz-loose'), '');
  assert.equal(followUpFrom(null, 'zz-work'), '');
  assert.equal(followUpFrom(INDEX, ''), '');
});

/* -------------------------------------------------------------------- the plan */

await check('the plan is one parent and one child per finding', () => {
  const plan = followUpPlan(SPEC, review(), { mergeBead: 'zz-merge', parent: 'zz-epic' });
  assert.equal(plan.children.length, 2);
  assert.equal(plan.parent.parent, 'zz-epic');
  assert.equal(plan.parent.priority, FOLLOWUP_PRIORITY, 'never above the ceiling an agent-filed bead has');
  assert.ok(plan.parent.labels.includes(FOLLOWUP_LABEL));
  assert.ok(plan.parent.labels.includes(plan.key), 'the key is on the bead, which is what makes it findable');
});

await check('the parent names the pull request, the work bead and the merge bead', () => {
  const plan = followUpPlan(SPEC, review(), { mergeBead: 'zz-merge', parent: 'zz-epic' });
  assert.match(plan.parent.title, /#671/);
  assert.match(plan.parent.title, /zz-work/, 'naming it is also what draws the relates-to edge');
  assert.match(plan.parent.body, /zz-merge/);
});

await check('a child carries the file, the line, the severity and the words', () => {
  const plan = followUpPlan(SPEC, review(), { mergeBead: 'zz-merge' });
  const first = plan.children[0];
  assert.match(first.title, /lib\/example\.js:42/);
  assert.match(first.title, /this could be a Set/);
  assert.match(first.body, /suggestion/);
  assert.match(first.body, /it is O\(n\) per call/, "the reviewer's own why, not a paraphrase");
});

await check('a comment about no file at all is still a child, said as such', () => {
  const plan = followUpPlan(SPEC, review(), {});
  assert.match(plan.children[1].body, /about the diff as a whole/);
  assert.match(plan.children[1].title, /why is the retry four/);
});

await check("a declined comment's child carries the worker's own answer", () => {
  const r = review({ comments: [{ id: 'c1', body: 'split this file', severity: 'suggestion', answer: 'declined', note: 'it is one idea' }] });
  const plan = followUpPlan(SPEC, r, {});
  assert.match(plan.children[0].body, /declined/);
  assert.match(plan.children[0].body, /it is one idea/);
  assert.match(plan.children[0].body, /never re-reviewed/, 'an unreviewed answer is context, not a settlement');
});

await check('nothing owed is no plan at all', () => {
  assert.equal(followUpPlan(SPEC, reviewState({}), {}), null);
  assert.equal(followUpPlan(SPEC, review({ comments: [] }), {}), null);
});

/* ------------------------------------------------------------------ the filing */

await check('it files a parent and one child each, under the home it was given', async () => {
  const bd = fakeBd();
  const out = await fileReviewFollowUp(bd, { name: 'demo' }, { issue: { id: 'zz-merge' }, spec: SPEC, review: review(), parent: 'zz-epic', endorsed: true });
  assert.equal(out.filed, true);
  assert.equal(out.id, 'zz-f1');
  assert.equal(out.children.length, 2);
  assert.equal(bd.calls.created.length, 3);
  assert.equal(bd.calls.created[0].parent, 'zz-epic');
  assert.equal(bd.calls.created[1].parent, 'zz-f1', 'the findings hang off the follow-up, not off the epic');
});

await check('an endorsing workspace files it workable; anything else files it held', async () => {
  const open = fakeBd();
  await fileReviewFollowUp(open, { name: 'demo' }, { spec: SPEC, review: review(), endorsed: true });
  assert.ok(!open.calls.created[0].labels.includes(UNENDORSED));

  const held = fakeBd();
  await fileReviewFollowUp(held, { name: 'demo' }, { spec: SPEC, review: review(), endorsed: false });
  assert.ok(held.calls.created[0].labels.includes(UNENDORSED));
  assert.ok(
    held.calls.created[1].labels.includes(UNENDORSED),
    'the children too — `--no-inherit-labels` means a held parent no longer holds them'
  );
});

await check('a second tick over the same verdict files nothing', async () => {
  const key = followUpKey({ repo: SPEC.repo, number: SPEC.number, round: 1 });
  const bd = fakeBd({ existing: [{ id: 'zz-already', status: 'open', labels: [key] }] });
  const out = await fileReviewFollowUp(bd, { name: 'demo' }, { spec: SPEC, review: review() });
  assert.equal(out.filed, false);
  assert.equal(out.already, true);
  assert.equal(out.id, 'zz-already');
  assert.equal(bd.calls.created.length, 0);
  assert.deepEqual(bd.calls.asked, [key]);
});

await check('a follow-up that has been worked and CLOSED still blocks a second one', async () => {
  // The one a live-only lookup would get wrong: `listLabelAny` asks over every status.
  const bd = fakeBd({ existing: [{ id: 'zz-already', status: 'closed' }] });
  const out = await fileReviewFollowUp(bd, { name: 'demo' }, { spec: SPEC, review: review() });
  assert.equal(out.already, true);
  assert.equal(bd.calls.created.length, 0);
});

await check('a tracker that will not answer holds the filing rather than duplicating it', async () => {
  const bd = {
    listLabelAny: async () => {
      throw new Error('dolt: database is locked');
    },
    create: async () => 'zz-should-not-happen',
  };
  const said = [];
  const out = await fileReviewFollowUp(bd, { name: 'demo' }, { spec: SPEC, review: review(), log: (m) => said.push(m) });
  assert.equal(out, null);
  assert.equal(said.length, 1);
  assert.match(said[0], /already filed/);
});

await check('a create that throws never reaches the caller — the merge has already happened', async () => {
  const bd = fakeBd({ failCreate: () => true });
  const said = [];
  const out = await fileReviewFollowUp(bd, { name: 'demo' }, { spec: SPEC, review: review(), log: (m) => said.push(m) });
  assert.equal(out, null);
  assert.match(said[0], /could not file the follow-up/);
});

await check('one child colliding does not lose the others, or the parent', async () => {
  const bd = fakeBd({ failCreate: (issue) => /retry four/.test(issue.title) });
  const said = [];
  const out = await fileReviewFollowUp(bd, { name: 'demo' }, { spec: SPEC, review: review(), log: (m) => said.push(m) });
  assert.equal(out.filed, true);
  assert.equal(out.children.length, 1, 'the one that did not collide is still filed');
  assert.equal(said.length, 1);
});

/* ---------------------------------------------------------------- the sentence */

await check('the sentence names the bead, which is the whole of the epic asking for it', () => {
  const said = followUpSentence({ id: 'zz-f1', children: ['a', 'b'], comments: [1, 2] });
  assert.match(said, /zz-f1/);
  assert.match(said, /2 review findings/);
});

await check('an already-filed follow-up says so rather than claiming a fresh one', () => {
  const said = followUpSentence({ id: 'zz-f1', already: true, comments: [1] });
  assert.match(said, /already filed/);
  assert.match(said, /1 open review finding\b/);
});

await check('nothing filed is an empty sentence, so every caller can append it blind', () => {
  assert.equal(followUpSentence(null), '');
  assert.equal(followUpSentence({ id: '' }), '');
});

console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
