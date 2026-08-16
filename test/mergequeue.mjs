#!/usr/bin/env node
/**
 * The tick: one pass over the merge queue, driven through every state GitHub can be in.
 *
 *     npm test
 *     node test/mergequeue.mjs
 *
 * bc-r941.3 and bc-r941.4. `sweepMergeQueue` is the only thing on this Mac that merges to
 * `main` unattended and the only thing that closes a work bead, so what it must do and —
 * more importantly — what it must *not* do are both worth pinning one state at a time.
 *
 * Everything effectful is injected, which is why this suite needs no git server, no fake
 * `gh` on PATH and no tracker: the module takes `prApi`, `resolve`, `openResolver`,
 * `raise` and `afterMerge` as arguments for exactly this reason. What is under test is a
 * decision procedure, and a decision procedure asserted through a subprocess is one you
 * can only cover the happy path of.
 *
 * The four assertions that matter most, in the order they would hurt:
 *
 * 1. **A pending check costs no attempt.** The retry budget exists to carry a *refusal*
 *    towards a card. If waiting spent one, a pull request whose CI is slow would be
 *    handed to Adam three ticks after it was filed, with nothing wrong with it.
 * 2. **Both beads close, merge-bead first.** The work bead depends on the merge-bead, so
 *    the other order is refused by the close gate — and the order reads backwards, which
 *    is precisely why it needs a test rather than a comment.
 * 3. **An epic work bead does not close.** `landHere` in bin/deliver.js carved that out
 *    (bc-arj0.3) and the carve-out travelled here with the close. It is the assertion
 *    that would silently disappear in a refactor.
 * 4. **A refused close is written down.** lib/owed.js, and bc-ec6: a bead reported as
 *    closed over a close that bd refused is the failure mode that took an afternoon to
 *    see, because everything upstream said it had worked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-mergequeue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { sweepMergeQueue, describeMergeQueue, MERGES_PER_TICK } = await import(LIB('mergequeue.js'));
const { MERGE_LABEL, MERGE_ASSIGNEE, MAX_ATTEMPTS, mergeBeadBody, queueState, withQueueBlock } = await import(LIB('mergebead.js'));
const { MAX_DOWNMERGES } = await import(LIB('mergequeue.js'));

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

console.log('\none tick of the merge queue\n');

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

/** A merge-bead row, as `bd.listAgent` would hand one over. */
const bead = (over = {}, spec = {}, notes = '') => ({
  id: 'zz-merge',
  title: 'Merge #42 — zz-work',
  status: 'open',
  labels: [MERGE_LABEL],
  assignee: MERGE_ASSIGNEE,
  description: mergeBeadBody({ ...SPEC, ...spec }),
  notes,
  ...over,
});

/**
 * A tracker that records rather than one that pretends.
 *
 * `closes` in order is the assertion for the two-beads-in-one-order case, and `refuse`
 * lets one close fail the way bd's close gate fails — which is the only way to reach the
 * `oweClose` path without a real tracker.
 */
function fakeBd({ rows = [], issues = {}, refuse = null } = {}) {
  const calls = { closes: [], comments: [], updates: [] };
  return {
    calls,
    listAgent: async () => rows,
    show: async (ws, id) => issues[id] || null,
    close: async (ws, id, reason) => {
      if (refuse && refuse(id)) throw new Error(`cannot close ${id}: blocked by open issues [zz-blocker]`);
      calls.closes.push({ id, reason });
    },
    comment: async (ws, id, text) => calls.comments.push({ id, text }),
    update: async (ws, id, patch) => calls.updates.push({ id, ...patch }),
  };
}

/** A `gh` that answers with whatever state this scenario is about. */
const fakePr = (view, { merge = null, base = { failed: [] }, update = { updated: true, reason: '' } } = {}) => {
  const calls = { merges: [], updates: [] };
  return {
    calls,
    view: async () => view,
    baseChecks: async () => base,
    updateBranch: async (dir, n) => {
      calls.updates.push(n);
      return update;
    },
    merge: async (dir, n, opts) => {
      calls.merges.push({ n, ...opts });
      if (merge instanceof Error) throw merge;
      return merge || { mergeCommit: 'abcdef1234' };
    },
  };
};

const GREEN = { failed: [], failing: 0, pending: 0, total: 3, state: 'passing' };
const openPr = (over = {}) => ({
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  checks: GREEN,
  reviewDecision: null,
  mergedAt: null,
  ...over,
});

const resolve = async () => ({ unit: { key: 'demo/widgets' }, dir: '/tmp/widgets', reason: '' });

const run = (bd, prApi, opts = {}) =>
  sweepMergeQueue(bd, { name: 'demo' }, { resolve, prApi, ...opts });

/* ------------------------------------------------------------- the happy path */

await check('a green, clean, up-to-date pull request merges', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi);
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.equal(prApi.calls.merges.length, 1);
  assert.equal(prApi.calls.merges[0].method, 'merge', 'it merged with a method the bead did not ask for');
});

await check('and never with --delete-branch, which the worktree sweep depends on', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  await run(bd, prApi);
  // lib/tidy.js finds out a pull request landed by asking about its branch, so the
  // branch outliving the merge is load-bearing — the same argument bin/deliver.js made
  // when the merge was there.
  assert.equal(prApi.calls.merges[0].deleteBranch, false);
});

await check('BOTH BEADS CLOSE, AND THE MERGE-BEAD GOES FIRST', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  await run(bd, fakePr(openPr()));
  // The work bead depends on the merge-bead, so the other order is refused by the close
  // gate. It reads backwards — "close the work, then tidy up the queue entry" — which is
  // exactly why it is pinned.
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
  assert.match(bd.calls.closes[1].reason, /#42/, 'the work bead closed without saying what landed');
});

await check('and the sweep behind it runs, with the local main brought up', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const after = [];
  await run(bd, fakePr(openPr()), { afterMerge: async (entry, landed, where) => after.push({ id: entry.issue.id, dir: where.dir }) });
  // What `landHere` in bin/deliver.js used to do and why: this Mac's `main` is a commit
  // behind until something fetches, and every other open branch is now measured against
  // a base it has never seen (lib/mergesweep.js).
  assert.deepEqual(after, [{ id: 'zz-merge', dir: '/tmp/widgets' }]);
});

await check('a sweep that throws cannot un-merge what has merged', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), {
    afterMerge: async () => {
      throw new Error('no checkout');
    },
  });
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
});

/* ------------------------------------------------------------- bc-y738, live */

await check('a red check the base also has still merges, and the close says what it merged over', async () => {
  const red = openPr({ checks: { failed: ['test/reenter.mjs'], failing: 1, pending: 0, total: 3, state: 'failing' } });
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(red, { base: { failed: ['test/reenter.mjs'] } }));
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.match(bd.calls.closes[0].reason, /already failing: test\/reenter\.mjs/, 'it merged over a red check in silence');
});

await check('a red check the base does not have refuses, and spends an attempt', async () => {
  const red = openPr({ checks: { failed: ['lint'], failing: 1, pending: 0, total: 3, state: 'failing' } });
  const bd = fakeBd({ rows: [bead()] });
  const out = await run(bd, fakePr(red, { base: { failed: ['test/reenter.mjs'] } }));
  assert.deepEqual(out.refused, ['zz-merge']);
  assert.deepEqual(bd.calls.closes, [], 'it closed a bead over a merge that did not happen');
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.ok(written, 'nothing was written back, so the next tick starts from zero');
  assert.equal(queueState({ notes: written.notes }).attempts, 1);
  assert.match(queueState({ notes: written.notes }).refused, /lint/);
});

/* ---------------------------------------------------------------- the waits */

await check('A PENDING CHECK COSTS NO ATTEMPT — the budget is for refusals', async () => {
  const pending = openPr({ checks: { failed: [], failing: 0, pending: 2, total: 3, state: 'pending' } });
  const bd = fakeBd({ rows: [bead()] });
  const out = await run(bd, fakePr(pending));
  assert.deepEqual(out.waiting, ['zz-merge']);
  assert.deepEqual(out.refused, []);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.equal(written, undefined, 'waiting spent an attempt, so slow CI reaches Adam as a failure');
});

await check('a behind branch is downmerged, and the tick stops there', async () => {
  const behind = openPr({ mergeState: 'BEHIND' });
  const bd = fakeBd({ rows: [bead()] });
  const prApi = fakePr(behind);
  const out = await run(bd, prApi);
  assert.deepEqual(out.updated, ['zz-merge']);
  assert.deepEqual(prApi.calls.updates, [42]);
  // Judging the checks now would be judging a diff that is being replaced as we look at
  // it: the update re-runs them against what is actually going to land.
  assert.equal(prApi.calls.merges.length, 0, 'it merged on the strength of checks that ran before the downmerge');
});

await check('AND IT STOPS DOWNMERGING RATHER THAN CHASING A BASE THAT KEEPS MOVING', async () => {
  // The one way this loop could starve a pull request forever: on a busy afternoon `main`
  // moves faster than CI finishes, so a queue that unconditionally downmerged-and-waited
  // would hand each branch a fresh base every tick and never once get as far as judging
  // it. Every individual tick would look sensible, which is what makes it hard to notice.
  const behind = openPr({ mergeState: 'BEHIND' });
  const bd = fakeBd({
    rows: [bead({ notes: withQueueBlock('', { attempts: 0, downmerges: MAX_DOWNMERGES }) })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(behind);
  const out = await run(bd, prApi);
  assert.equal(prApi.calls.updates.length, 0, 'it downmerged a fourth time');
  assert.deepEqual(out.merged, ['zz-merge'], 'and it never got as far as judging the branch');
});

await check('a downmerge is counted apart from an attempt — being unlucky is not being refused', async () => {
  const behind = openPr({ mergeState: 'BEHIND' });
  const bd = fakeBd({ rows: [bead()] });
  await run(bd, fakePr(behind));
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.equal(queueState({ notes: written.notes }).downmerges, 1);
  assert.equal(queueState({ notes: written.notes }).attempts, 0, 'a downmerge spent one of the three attempts');
});

await check('and a downmerge GitHub refuses is a wait, not an attempt', async () => {
  const behind = openPr({ mergeState: 'BEHIND' });
  const bd = fakeBd({ rows: [bead()] });
  const out = await run(bd, fakePr(behind, { update: { updated: false, reason: 'the base moved under it' } }));
  assert.deepEqual(out.waiting, ['zz-merge']);
  assert.equal(bd.calls.updates.length, 0);
});

/* ------------------------------------------------------------ the conflict */

await check('a conflicted branch opens a resolver rather than being retried', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const bd = fakeBd({ rows: [bead()] });
  const seen = [];
  const out = await run(bd, fakePr(dirty), { openResolver: async (entry, dir) => (seen.push(dir), true) });
  assert.deepEqual(out.raised, ['zz-merge']);
  assert.deepEqual(seen, ['/tmp/widgets']);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  // Marked, so the next tick leaves it alone: lib/resolvers.js allows one window per pull
  // request and a queue that picked it up again would open the second.
  assert.equal(queueState({ notes: written.notes }).resolving, true);
  assert.equal(queueState({ notes: written.notes }).attempts, 0, 'opening a resolver spent an attempt');
});

await check('and one already being resolved is left alone while it still conflicts', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 1, resolving: true }) })] });
  const prApi = fakePr(dirty);
  const out = await run(bd, prApi, { openResolver: async () => true });
  assert.equal(out.queued, 0);
  assert.equal(prApi.calls.merges.length, 0);
  // And no second window: the flag is what lib/resolvers.js's one-per-pull-request rule
  // looks like from in here, and a resolver still in that tree is bc-utyr waiting to happen.
  assert.deepEqual(out.reclaimed, []);
});

/**
 * bc-91ft, and the assertion that fails against the version that shipped.
 *
 * `resolving` was written when the window opened and nothing anywhere wrote it back, so a
 * branch the resolver had *fixed* — pushed, green, MERGEABLE — stayed invisible to the
 * queue until Adam approved it a second time. This is that exact state: flagged bead,
 * clean pull request. It has to merge.
 */
await check('A BRANCH ITS RESOLVER FIXED COMES BACK ON ITS OWN, WITH NO SECOND APPROVAL', async () => {
  const bd = fakeBd({
    rows: [bead({ notes: withQueueBlock('', { attempts: 1, resolving: true, refused: 'the branch conflicts with its base' }) })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi);
  assert.deepEqual(out.reclaimed, ['zz-merge']);
  assert.equal(out.queued, 1);
  assert.equal(prApi.calls.merges.length, 1, 'the queue still could not see a branch its resolver had fixed');
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  const state = queueState({ notes: written.notes });
  assert.equal(state.resolving, false);
  // The sentence went with the state it was about — `admittedState`'s reasoning, and the
  // reason a reclaimed bead does not read as one that is still refusing to merge.
  assert.equal(state.refused, null);
  // The budget is untouched: reclaiming is not an attempt, and a bead that came back with
  // one attempt already spent must not arrive looking like a fresh one either.
  assert.equal(state.attempts, 1);
});

await check('and an unreadable pull request leaves the flag exactly where it is', async () => {
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 1, resolving: true }) })] });
  const prApi = fakePr(openPr());
  prApi.view = async () => {
    throw new Error('gh: API rate limit exceeded');
  };
  const out = await run(bd, prApi);
  // Unknown is not "the resolver finished". A rate limit costs a tick; the other direction
  // merges a branch somebody may still be mid-merge in.
  assert.deepEqual(out.reclaimed, []);
  assert.equal(prApi.calls.merges.length, 0);
  assert.equal(bd.calls.updates.length, 0, 'it rewrote the state block over an answer it never got');
});

await check('a conflict with nowhere to open a window is a refusal that says so', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const bd = fakeBd({ rows: [bead()] });
  const out = await run(bd, fakePr(dirty), { openResolver: async () => false });
  assert.deepEqual(out.refused, ['zz-merge']);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.match(queueState({ notes: written.notes }).refused, /conflicts with/);
});

/* ------------------------------------------- the window that delivered it */

await check('THE WINDOW THAT DELIVERED IT IS TOLD ITS BRANCH LANDED', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const marked = [];
  await run(bd, fakePr(openPr()), { markMerged: async (id) => marked.push(id) });
  // The *work* bead, not the merge-bead: the window is named after the work, and its
  // name is the only thing tying a session to a bead (lib/reap.js `namesBead`). The
  // worker renamed itself `QUEUED-` when it handed the branch over, which was all it
  // could honestly claim; this is the moment anything knows better.
  assert.deepEqual(marked, ['zz-work']);
});

await check('and it happens before the closes, because the reaper is right behind them', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const order = [];
  const bdSpy = { ...bd, close: async (...a) => { order.push(`close ${a[1]}`); return bd.close(...a); } };
  await run(bdSpy, fakePr(openPr()), { markMerged: async (id) => order.push(`rename ${id}`) });
  // Closing the work bead is what makes the window reapable — `sweepCandidate` wants a
  // finished name and a closed bead. Rename after the close and the race is real: the
  // window can be gone before it is told what happened to its branch.
  assert.equal(order[0], 'rename zz-work', `renamed too late — ${order.join(', ')}`);
});

await check('an epic window is renamed too, even though its bead stays open', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'epic' } } });
  const marked = [];
  await run(bd, fakePr(openPr()), { markMerged: async (id) => marked.push(id) });
  // The prefix is a claim about the *session*, not about the bead's lifecycle. The epic
  // stays open because its theme is not done; the window that wrote the branch is just
  // as finished as any other, and one left saying `QUEUED-` reads as still waiting on a
  // queue that is done with it.
  assert.deepEqual(marked, ['zz-work']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge']);
});

await check('a rename that throws cannot un-merge what has merged', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), {
    markMerged: async () => {
      throw new Error('no ~/.claude here');
    },
  });
  // Same argument the sweep above makes: a window wearing the wrong name is a cosmetic
  // fault, and a merge that reports itself as not having happened is not.
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
});

await check('a pull request merged outside the queue renames it too', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const marked = [];
  // Adam tapping merge on his phone is the ordinary way this happens, and the window is
  // no less finished for the queue not having been the one to press it.
  const prApi = fakePr(openPr({ state: 'MERGED', mergedAt: '2026-08-15T12:00:00Z', mergeCommit: 'abcdef123456' }));
  await run(bd, prApi, { markMerged: async (id) => marked.push(id) });
  assert.deepEqual(marked, ['zz-work']);
});

/* -------------------------------------------------------------- the epic */

await check('AN EPIC WORK BEAD DOES NOT CLOSE ON A MERGE', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'epic' } } });
  await run(bd, fakePr(openPr()));
  // bc-arj0.3, carried over from `landHere`: an epic is finished when its theme is, and a
  // branch that shared its name merging is no evidence about that.
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge'], 'the epic closed on a branch merging');
  assert.ok(
    bd.calls.comments.some((c) => c.id === 'zz-work' && /stays \*\*open\*\*/.test(c.text)),
    'and nothing on it says why it is still open'
  );
});

/* ---------------------------------------------- a close bd will not take */

await check('a refused close is written down, not reported as done', async () => {
  const owedPath = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'owed-closes.json');
  fs.rmSync(owedPath, { force: true });
  const bd = fakeBd({
    rows: [bead()],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
    refuse: (id) => id === 'zz-work',
  });
  await run(bd, fakePr(openPr()));
  const owed = fs.existsSync(owedPath) ? JSON.parse(fs.readFileSync(owedPath, 'utf8')) : {};
  assert.ok(Object.keys(owed).some((k) => k.endsWith('zz-work')), `nothing was written down: ${JSON.stringify(owed)}`);
  assert.ok(
    bd.calls.comments.some((c) => c.id === 'zz-work' && /did \*\*not\*\* close/.test(c.text)),
    'and the bead was not told, so it reads as closed work that is open'
  );
});

/* ------------------------------------------------------- already gone */

await check('a pull request merged on github.com finishes the bookkeeping', async () => {
  const bd = fakeBd({
    rows: [bead()],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(openPr({ state: 'MERGED', mergedAt: '2026-08-14T10:00:00Z', mergeCommit: 'deadbeef99' }));
  const out = await run(bd, prApi);
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.equal(prApi.calls.merges.length, 0, 'it tried to merge a pull request that was already merged');
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
});

await check('and one closed without merging closes the queue entry only', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr({ state: 'CLOSED' })));
  // A decline puts the work back in the queue. Closing the work bead here would be
  // recording as finished the one outcome that means "start again".
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge']);
  assert.deepEqual(out.merged, []);
});

/* ------------------------------------------------------------ handing over */

await check('one out of attempts is handed over before anything else in the tick', async () => {
  const spent = bead({ id: 'zz-stuck', notes: withQueueBlock('', { attempts: MAX_ATTEMPTS, refused: 'lint is red.' }) });
  const bd = fakeBd({ rows: [spent] });
  const raised = [];
  const out = await run(bd, fakePr(openPr()), { raise: async (entry, why) => (raised.push({ id: entry.issue.id, why }), true) });
  assert.deepEqual(out.raised, ['zz-stuck']);
  assert.match(raised[0].why, /3 times/);
  assert.match(raised[0].why, /lint is red/, 'the card does not carry what actually stopped it');
});

await check('and so is one whose block will not parse — silence is the failure this replaces', async () => {
  const broken = bead({ id: 'zz-broken', description: '```beadpr\n: : nope : :\n```' });
  const bd = fakeBd({ rows: [broken] });
  const raised = [];
  await run(bd, fakePr(openPr()), { raise: async (entry, why) => (raised.push(why), true) });
  assert.equal(raised.length, 1);
  assert.ok(raised[0], 'it was handed over with no sentence saying why');
});

await check('a missing approval is raised once, not every tick', async () => {
  const bd = fakeBd({ rows: [bead()] });
  const raised = [];
  const out = await run(bd, fakePr(openPr()), {
    policy: { requireApproval: true },
    raise: async (entry, why, opts) => (raised.push(opts), true),
  });
  assert.deepEqual(out.waiting, ['zz-merge']);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].approval, true, 'a wait was raised as a refusal');
  // Marked, so the second tick does not file the same card again.
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.equal(queueState({ notes: written.notes }).resolving, true);
  assert.equal(queueState({ notes: written.notes }).attempts, 0, 'waiting for a human spent an attempt');
});

await check('no checkout for the repo is a refusal that names the repo', async () => {
  const bd = fakeBd({ rows: [bead()] });
  const out = await sweepMergeQueue(bd, { name: 'demo' }, {
    resolve: async () => ({ unit: null, dir: '', reason: 'no approved demo repo is acme/widgets' }),
    prApi: fakePr(openPr()),
  });
  assert.deepEqual(out.refused, ['zz-merge']);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.match(queueState({ notes: written.notes }).refused, /acme\/widgets/);
});

/* ------------------------------------------------------------- the limit */

await check('a tick merges at most MERGES_PER_TICK, and says what it left', async () => {
  const rows = [bead({ id: 'zz-m1' }), bead({ id: 'zz-m2' }), bead({ id: 'zz-m3' })];
  const bd = fakeBd({
    rows,
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi);
  // Every merge moves the base under every other branch in the queue, so the third would
  // be judged against checks that ran two merges ago — the stale baseline this whole
  // queue exists to fix, reintroduced inside one pass.
  assert.equal(prApi.calls.merges.length, MERGES_PER_TICK);
  assert.equal(out.merged.length, MERGES_PER_TICK);
  assert.ok(out.waiting.includes('zz-m3'), 'the one it did not get to is not reported at all');
});

/* ----------------------------------------------------------------- the note */

await check('the line it hands the card says what happened, or nothing at all', async () => {
  assert.equal(describeMergeQueue({ ok: true, merged: [], updated: [], refused: [], raised: [], waiting: [] }), '');
  assert.match(describeMergeQueue({ ok: true, merged: ['a'], updated: [], refused: ['b'], raised: [], waiting: [] }), /merged 1/);
  // A tick whose only news is a branch coming back from its resolver still has news.
  assert.match(
    describeMergeQueue({ ok: true, merged: [], updated: [], refused: [], raised: [], waiting: [], reclaimed: ['a'] }),
    /back from a resolver/
  );
  assert.match(describeMergeQueue({ ok: false, reason: 'bd list failed' }), /bd list failed/);
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
