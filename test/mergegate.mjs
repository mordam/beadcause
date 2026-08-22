#!/usr/bin/env node
/**
 * The MergeAdvocate: a sixth kind, and the gate it applies to somebody else's branch.
 *
 *     npm test
 *     node test/mergegate.mjs
 *
 * bc-r941.2 and the decision half of bc-r941.3. Three things here:
 *
 * 1. **A sixth kind has to be a whole kind.** `AGENTS` is what `POST /api/console` gates
 *    on, `MARKS` is what draws a conversation's pill, and lib/foundation.js says out loud
 *    that a new kind should *fail* the coverage check rather than quietly ship as a
 *    generic 🤖. What matters most here is the shape of its permissions: it is the only
 *    agent that may not close a bead, and the absence of `bd close` from its allowlist is
 *    load-bearing rather than an oversight — a window that could close the work bead
 *    would be able to declare work finished over a branch still in a pull request, which
 *    is the exact failure bc-r941 exists to remove.
 * 2. **`newlyFailing` is bc-y738**, answered by Adam in session: a check the base is
 *    already failing says nothing about the branch, and what says something is the
 *    difference. The two directions of that are the whole suite — nothing new gets
 *    through, and an inherited red does not stop a merge. Both are pinned, because
 *    loosening either is a one-line change that reads as a tidy-up.
 * 3. **An unknown baseline is not an empty one.** `baseChecks` returns null when it could
 *    not ask GitHub, and reading that as "the base is green" turns every one of the base's
 *    red checks into a refusal. Unknown falls back to the strict rule, which is the
 *    direction that stops merges rather than letting them through.
 *
 * The gate is asserted as a pure function, the way test/epicadvocate.mjs asserts the
 * planner's brief: what is under test is the decision an unattended queue makes about
 * merging to `main`, and a test must be able to reach every branch of it without a
 * network, a checkout or a pull request.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const { MERGE_ADVOCATE, newlyFailing, gateVerdict, baselineNote, queueFor, anyQueued, mergeAdvocatePrompt } = await import(
  LIB('mergeadvocate.js')
);
const { MERGE_LABEL, MERGE_ASSIGNEE, MAX_ATTEMPTS, mergeBeadBody, withQueueBlock } = await import(LIB('mergebead.js'));
const { AGENTS, baseline, mark } = await import(LIB('foundation.js'));

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

console.log('\nthe merge queue — judging somebody else’s branch\n');

/* -------------------------------------------------------------------- the kind */

check('it is a sixth kind, with a foundation and a mark of its own', () => {
  assert.ok(AGENTS.includes(MERGE_ADVOCATE), 'merge-advocate is not in AGENTS, so nothing can own a conversation as one');
  const b = baseline(MERGE_ADVOCATE);
  assert.equal(b.id, MERGE_ADVOCATE);
  assert.ok(b.role && b.role.length > 200, 'a kind with no role is a mode with extra steps');
  const m = mark(MERGE_ADVOCATE);
  assert.ok(m?.name && m?.emoji, 'lib/foundation.js says a new kind must fail this rather than draw as 🤖');
  assert.notEqual(m.emoji, mark('advocate').emoji, 'it draws the same pill as the repo advocate');
  assert.notEqual(m.emoji, mark('epic-advocate').emoji, 'it draws the same pill as the P0 advocate');
});

check('IT CANNOT CLOSE A BEAD, AND THAT ABSENCE IS THE POINT', () => {
  const b = baseline(MERGE_ADVOCATE);
  const tools = b.allowedTools || [];
  assert.ok(
    !tools.some((t) => /bd close/.test(t)),
    'the merge window has gained bd close — it can now declare work finished over an unmerged branch'
  );
  assert.ok(
    !tools.some((t) => /^Bash\(bd \*/.test(t)),
    'Bash(bd *) is back, and it carries close, create and delete with it'
  );
  // What it *may* do on the tracker is say what it worked out. Without this the failure
  // path has nowhere to leave the sentence the next window starts from.
  assert.ok(tools.includes('Bash(bd comment:*)'), 'it cannot write down what it concluded, so it is not re-entrant');
});

check('and it may not merge by hand — the queue owns the door into main', () => {
  const tools = baseline(MERGE_ADVOCATE).allowedTools || [];
  assert.ok(!tools.some((t) => /gh pr merge/.test(t)), 'the window can merge on its own, which is a second door into main');
  // It does need the resolution itself: fetch, merge into the branch it is standing on,
  // and push. Those are the conflicted downmerge it is opened for.
  for (const need of ['Bash(git fetch:*)', 'Bash(git merge:*)', 'Bash(git push:*)']) {
    assert.ok(tools.includes(need), `${need} is missing, so it cannot resolve the conflict it was opened for`);
  }
});

check('it writes, and it owns a repo, because it is re-entrant and unattended', () => {
  const b = baseline(MERGE_ADVOCATE);
  assert.equal(b.writes, true);
  assert.equal(b.ownsRepo, true);
  assert.equal(b.protocolOwner, 'lib/mergeadvocate.js');
});

/* --------------------------------------------------------- bc-y738: the baseline */

check('a check the base is already failing is not counted against the branch', () => {
  assert.deepEqual(newlyFailing(['test/reenter.mjs'], ['test/reenter.mjs']), []);
});

check('a check the branch broke is', () => {
  assert.deepEqual(newlyFailing(['test/reenter.mjs', 'lint'], ['test/reenter.mjs']), ['lint']);
});

check('a green base leaves every red check on the branch', () => {
  assert.deepEqual(newlyFailing(['lint'], []), ['lint']);
});

check('and duplicates on either side do not change the answer', () => {
  assert.deepEqual(newlyFailing(['lint', 'lint'], ['test/reenter.mjs', 'test/reenter.mjs']), ['lint']);
});

/* ---------------------------------------------------------------- the verdict */

const green = { failed: [], failing: 0, pending: 0, total: 3, state: 'passing' };
const red = (names) => ({ failed: names, failing: names.length, pending: 0, total: 3, state: 'failing' });

check('green checks and a green base merge', () => {
  const v = gateVerdict({ checks: green, baseline: [] });
  assert.equal(v.merge, true);
  assert.equal(v.refused, '');
  assert.deepEqual(v.baseline, []);
});

check('A RED CHECK THE BASE ALSO HAS MERGES, AND SAYS WHAT IT MERGED OVER', () => {
  const v = gateVerdict({ checks: red(['test/reenter.mjs']), baseline: ['test/reenter.mjs'] });
  assert.equal(v.merge, true, 'bc-y738: an inherited red check stopped the queue, so nothing will ever merge');
  assert.deepEqual(v.baseline, ['test/reenter.mjs']);
  assert.match(baselineNote(v.baseline), /test\/reenter\.mjs/);
  assert.match(baselineNote(v.baseline), /already failing/);
});

check('A RED CHECK THE BASE DOES NOT HAVE REFUSES, AND NAMES IT', () => {
  const v = gateVerdict({ checks: red(['test/reenter.mjs', 'lint']), baseline: ['test/reenter.mjs'] });
  assert.equal(v.merge, false, 'the branch broke a check and the queue merged anyway');
  assert.match(v.refused, /lint/);
  assert.ok(!/Could not merge/.test(v.refused), 'the refusal says the one thing Adam can already see');
  // And it says which reds it discounted, or the sentence reads as if lint were the only
  // red on the pull request — which sends you looking at a page showing two.
  assert.match(v.refused, /base is already failing test\/reenter\.mjs/);
});

check('AN UNKNOWN BASELINE FALLS BACK TO THE STRICT RULE, NOT TO A GREEN ONE', () => {
  // `baseChecks` returns null when it could not ask GitHub. Reading null as an empty
  // array would discount nothing and refuse everything — which is at least safe; reading
  // it as "the base is green" is also refusing everything. What must never happen is the
  // opposite: null read as "discount whatever the branch is failing".
  const v = gateVerdict({ checks: red(['lint']), baseline: null });
  assert.equal(v.merge, false);
  assert.match(v.refused, /lint/);
  assert.deepEqual(v.baseline, [], 'an unknown baseline was reported as something merged over');
});

/* ------------------------------------------------------- bc-ysqd.1: zero checks */

const none = { failed: [], failing: 0, pending: 0, total: 0, state: 'none' };

check('ZERO CHECKS ON A COMMIT WHOSE BASE HAS CHECKS REFUSES, IN ADAM\'S OWN WORDS', () => {
  // #480, 2026-08-18: a push authored with the Actions/Copilot token does not trigger a
  // pull_request workflow, so the head commit it left behind carried zero check runs —
  // and the queue read that the same as green.
  const v = gateVerdict({ checks: none, baseline: ['test/reenter.mjs'], baseHasChecks: true });
  assert.equal(v.merge, false);
  assert.match(v.refused, /nothing ran on this commit at all/);
});

check('AND AN UNKNOWN BASELINE FALLS BACK TO REFUSING IT TOO', () => {
  // `baseHasChecks` is null when the caller never asked or could not — the same direction
  // as an unknown `baseline` above: guessing "this base has no checks" is the guess that
  // would have let #480 through.
  const v = gateVerdict({ checks: none, baseline: null, baseHasChecks: null });
  assert.equal(v.merge, false);
  assert.match(v.refused, /nothing ran on this commit at all/);
});

check('a CI-less workspace never wedges — zero checks on both sides merges', () => {
  const v = gateVerdict({ checks: none, baseline: [], baseHasChecks: false });
  assert.equal(v.merge, true, 'a base that also runs no checks is the ordinary state of a CI-less space');
});

check('a conflict is not a verdict — it is the thing a resolver fixes', () => {
  const v = gateVerdict({ checks: green, baseline: [], mergeable: 'CONFLICTING' });
  assert.equal(v.merge, false);
  assert.equal(v.conflicted, true, 'a conflicted branch has to be distinguishable, or it becomes a card nobody can act on');
  assert.match(v.refused, /base has to come into the branch/);
});

check('checks still running is a wait, and the sentence says how long it waited', () => {
  const v = gateVerdict({
    checks: { failed: [], failing: 0, pending: 2, total: 3, state: 'pending' },
    baseline: [],
    timedOut: true,
    waitMs: 300000,
  });
  assert.equal(v.merge, false);
  assert.match(v.refused, /2 of its 3 checks were still running after 5 minutes/);
});

check('AWAITING AN APPROVAL IS NOT A REFUSAL — NOTHING WAS ASKED', () => {
  // bin/deliver.js keeps this in a separate flag and the reason is kept here: a card that
  // says "it could not merge" over green checks and a satisfied policy sends you hunting
  // for a switch that is already set the way you want it.
  const v = gateVerdict({ checks: green, baseline: [], requireApproval: true, reviewDecision: 'REVIEW_REQUIRED' });
  assert.equal(v.merge, false);
  assert.equal(v.awaitingApproval, true);
  assert.equal(v.refused, '', 'a wait was reported as a refusal');
});

check('and an approval satisfies it', () => {
  const v = gateVerdict({ checks: green, baseline: [], requireApproval: true, reviewDecision: 'APPROVED' });
  assert.equal(v.merge, true);
});

check('a red check outranks a missing approval — the more useful thing to be told', () => {
  const v = gateVerdict({ checks: red(['lint']), baseline: [], requireApproval: true, reviewDecision: null });
  assert.equal(v.awaitingApproval, false);
  assert.match(v.refused, /lint/);
});

check('baselineNote is empty when nothing was merged over, so it can be concatenated blind', () => {
  assert.equal(baselineNote([]), '');
  assert.equal(baselineNote(null), '');
});

/* ------------------------------------------------------------------ the queue */

const spec = {
  workspace: 'beadcause',
  bead: 'bc-7qo',
  repo: 'mordam/beadcause',
  number: 42,
  url: 'https://github.com/mordam/beadcause/pull/42',
  branch: 'worktree-thing-a3f',
  base: 'main',
  method: 'merge',
};
const bead = (id, extra = {}, over = {}) => ({
  id,
  status: 'open',
  labels: [MERGE_LABEL],
  assignee: MERGE_ASSIGNEE,
  description: mergeBeadBody({ ...spec, ...over }),
  notes: '',
  ...extra,
});

check('the queue is every open merge-bead assigned to it, oldest id first', () => {
  const { queued } = queueFor([bead('bc-m2'), bead('bc-m1')]);
  assert.deepEqual(queued.map((q) => q.issue.id), ['bc-m1', 'bc-m2']);
});

check('and nothing else: not closed, not unassigned, not another agent’s', () => {
  const rows = [
    bead('bc-m1', { status: 'closed' }),
    bead('bc-m2', { assignee: 'adam' }),
    { id: 'bc-m3', status: 'open', labels: [], assignee: MERGE_ASSIGNEE, description: 'an ordinary bead' },
  ];
  assert.deepEqual(queueFor(rows).queued, []);
});

check('one out of attempts is stuck, not queued — a retry forever is not a queue', () => {
  const rows = [bead('bc-m1', { notes: withQueueBlock('', { attempts: MAX_ATTEMPTS, refused: 'lint is red.' }) })];
  const { queued, stuck } = queueFor(rows);
  assert.deepEqual(queued, []);
  assert.deepEqual(stuck.map((q) => q.issue.id), ['bc-m1']);
});

check('one a resolver is already on is neither — lib/resolvers.js allows one window per PR', () => {
  const rows = [bead('bc-m1', { notes: withQueueBlock('', { attempts: 1, resolving: true }) })];
  const { queued, stuck, broken } = queueFor(rows);
  assert.deepEqual([...queued, ...stuck, ...broken], []);
});

check('a bead whose block will not parse is reported, not skipped in silence', () => {
  const rows = [bead('bc-m1', { description: '```beadpr\n: : nope : :\n```' })];
  const { queued, broken } = queueFor(rows);
  assert.deepEqual(queued, []);
  assert.equal(broken.length, 1);
  assert.ok(broken[0].why, 'nothing says why it is not being merged');
});

/* ------------------------------------------------------------- the cheap no */

check('anyQueued answers off the graph cache, which carries labels and assignee', () => {
  const index = (rows) => ({ beads: new Map(rows.map((r) => [r.id, r])) });
  assert.equal(anyQueued(index([{ id: 'zz-1', status: 'open', labels: [MERGE_LABEL], assignee: MERGE_ASSIGNEE }])), true);
  assert.equal(anyQueued(index([{ id: 'zz-1', status: 'open', labels: ['tracker'], assignee: MERGE_ASSIGNEE }])), false);
  assert.equal(anyQueued(index([{ id: 'zz-1', status: 'closed', labels: [MERGE_LABEL], assignee: MERGE_ASSIGNEE }])), false);
  assert.equal(anyQueued(index([{ id: 'zz-1', status: 'open', labels: [MERGE_LABEL], assignee: 'adam' }])), false);
  assert.equal(anyQueued(index([])), false);
});

check('A FAILED GRAPH READ IS A YES — unknown must not stop the queue in silence', () => {
  // `graph()` hands back `{ error }` rather than throwing, and reading that as "nothing
  // queued" would stop merges on exactly the loaded Dolt where things are most likely to
  // be waiting. Falling through costs a subprocess; the alternative costs a merge.
  assert.equal(anyQueued({ error: 'bd export timed out', beads: new Map() }), true);
  assert.equal(anyQueued(null), true);
  assert.equal(anyQueued({}), true);
});

/* ----------------------------------------------------------------- the brief */

check('the brief tells it the one thing that makes this job different', () => {
  const issue = { id: 'bc-m1' };
  const text = mergeAdvocatePrompt('beadcause', issue, spec, { attempts: 1, refused: 'lint is red.' }, { owner: 'Adam' });
  assert.match(text, /You did not write this code/, 'the brief does not say whose code this is');
  assert.match(text, /Hand it back rather than guess/, 'the escalation is not named, so the only move left is to guess');
  assert.match(text, /may not close bc-7qo/, 'the brief does not forbid closing the work bead');
  assert.match(text, /may not/, 'nothing is forbidden at all');
  assert.match(text, /lint is red\./, 'what stopped it last time is not carried in, so it starts from zero');
});

check('it is told to say on the pull request what it is about to do, before it touches the tree', () => {
  // bc-kan5f. From GitHub's side a branch that will not merge is indistinguishable from
  // an abandoned one, for as long as the resolution takes — so the window says it has it
  // *first*, and says what it expects, which is the half that makes the closing record
  // worth reading. The order is the assertion: a prediction posted after the work is a
  // report, and the brief already asks for one of those at the end.
  const text = mergeAdvocatePrompt('beadcause', { id: 'bc-m1' }, spec, { attempts: 1 }, { owner: 'Adam' });
  assert.match(text, /Say on #42 that you have it, before you touch the tree/, 'nothing tells it to speak first');
  assert.match(text, /gh pr comment 42/, 'it is asked to say something with no way named to say it');
  assert.ok(
    text.indexOf('Say on #42') < text.indexOf('Bring `main` into'),
    'the arrival comment is asked for after the merge, which makes it a report rather than a prediction'
  );
});

check('and a second attempt is asked for what stopped the first, rather than for a risk note', () => {
  // The two openings are not the same window. On attempt 1 the useful thing to say in
  // advance is which of the worker's risks it will read hardest; on attempt 2 the useful
  // thing is what already went wrong, which the first window has by then written down.
  const first = mergeAdvocatePrompt('beadcause', { id: 'bc-m1' }, spec, { attempts: 1 });
  const again = mergeAdvocatePrompt('beadcause', { id: 'bc-m1' }, spec, { attempts: 3 });
  assert.match(first, /any risk the worker flagged/);
  assert.match(again, /what stopped the last attempt/);
  assert.doesNotMatch(again, /any risk the worker flagged/, 'a third window is still being briefed as a first one');
});

check('and it says it is re-entrant, because the next window starts from the bead', () => {
  const text = mergeAdvocatePrompt('beadcause', { id: 'bc-m1' }, spec, { attempts: 2 });
  assert.match(text, /re-entrant/);
  assert.match(text, /starts from bc-m1, not from this conversation/);
});

check('an approval-gated repo says so, or a perfect resolution reads as a failure', () => {
  const text = mergeAdvocatePrompt('beadcause', { id: 'bc-m1' }, spec, { attempts: 1 }, { policy: { requireApproval: true } });
  assert.match(text, /waits for an approving review/);
});

/* ---------------------------------------------------------------- the door */

check('AND THE DOOR OPENS IT AS ITSELF, WHICH IS THE WHOLE ARGUMENT FOR THE KIND', () => {
  // The same check test/epicadvocate.mjs makes about its own door, for the same reason:
  // this is the half no brief can show. A window opened without `agent` runs with the
  // worker's reach — `bd close` and `gh pr merge` both in it — over somebody else's
  // branch, which is exactly the position bc-r941 exists to take the merge out of. And
  // `bead` alongside it is what stamps BEADCAUSE_BEAD, without which `beadcause-memory
  // debrief` refuses in the one window opened on the same bead all afternoon (bc-nib3.9).
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'session.js'), 'utf8');
  const from = src.indexOf('export async function openMergeAdvocateSession');
  assert.ok(from > 0, 'openMergeAdvocateSession has been renamed — re-point this check');
  const body = src.slice(from, src.indexOf('\n}\n', from));
  assert.match(body, /agent: MERGE_ADVOCATE, bead: issue\.id/, 'the merge window is opened as something else, with something else’s permissions');
  assert.match(body, /mergeAdvocatePrompt\(/, 'and with a brief that is not its own');
});

check('and the queue reaches that door rather than the worker-reach one', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'server.js'), 'utf8');
  const from = src.indexOf('openResolver: async (entry, dir)');
  assert.ok(from > 0, 'the queue no longer wires a resolver — re-point this check');
  const body = src.slice(from, from + 2600);
  assert.match(body, /openMergeAdvocateSession\(/, 'the queue opens a conflict window with the worker’s permissions');
  assert.ok(!/openConflictSession\(/.test(body), 'it fell back to the worker-reach session');
  // And through the registry that allows one window per pull request — the reason
  // lib/mergesweep.js records a merge rather than sweeping it.
  assert.match(body, /resolveFor\(/, 'nothing stops a second window opening on the same pull request');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
