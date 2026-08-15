#!/usr/bin/env node
/**
 * The merge-bead: what a worker files instead of merging, and the queue state on it.
 *
 *     npm test
 *     node test/mergebead.mjs
 *
 * bc-r941.1. Four things are worth a suite here and none of them is visible by reading
 * one function:
 *
 * 1. **The block is the delivery card's block.** A merge-bead carries `beadpr`, written
 *    by lib/delivery.js's serialiser and parsed by lib/delivery.js's parser, because the
 *    failure path hands a refused merge to Adam as exactly that card. Two serialisers for
 *    one block would drift into a card whose Merge button acts on a pull request the bead
 *    no longer names, so a round trip through both is asserted rather than assumed.
 * 2. **The state block is a *separate* block, and rewriting it must not touch anything
 *    else in `notes`.** The two have opposite lifetimes — identity written once, progress
 *    rewritten every tick — and the markers exist so a tick cannot eat a human's note.
 * 3. **The three names agree.** `MERGE_ASSIGNEE`, `MERGE_ADVOCATE` and the key in
 *    lib/foundation.js's BASELINES are the same string, deliberately not imported from
 *    one another (a cycle, which lib/agents.js already paid for once). An assignee typo
 *    is a merge-bead nothing ever picks up and no error anywhere — the exact failure a
 *    test catches and a comment does not.
 * 4. **One merge-bead per pull request.** `clearOpenCards` in bin/deliver.js exists
 *    because two cards on one delivery were each a blocker on the work bead's close. A
 *    merge-bead is a blocker *by construction*, so the same pile here is strictly worse.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const {
  MERGE_LABEL,
  MERGE_ASSIGNEE,
  MAX_ATTEMPTS,
  QUEUE_OPEN,
  QUEUE_CLOSE,
  isMergeBead,
  mergeSpec,
  queueState,
  queueBlock,
  withQueueBlock,
  mergeBeadTitle,
  mergeBeadBody,
  openMergeBeadFor,
} = await import(LIB('mergebead.js'));
const { MERGE_ADVOCATE } = await import(LIB('mergeadvocate.js'));
const { AGENTS } = await import(LIB('foundation.js'));
const { parseDelivery } = await import(LIB('delivery.js'));

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

console.log('\nthe merge-bead — a worker hands the merge over\n');

const spec = {
  workspace: 'beadcause',
  bead: 'bc-7qo',
  title: 'The thing the worker did',
  repo: 'mordam/beadcause',
  number: 42,
  url: 'https://github.com/mordam/beadcause/pull/42',
  branch: 'worktree-thing-a3f',
  base: 'main',
  method: 'merge',
  summary: 'What changed and why.',
  tests: 'npm test — 239 files, all green',
  risk: '',
};

/* --------------------------------------------------------------- the identity */

check('the body carries a beadpr block the delivery parser reads back unchanged', () => {
  const body = mergeBeadBody(spec, { tests: spec.tests });
  const back = parseDelivery(body);
  assert.ok(back && !back.error, `the block did not parse: ${back?.error}`);
  for (const field of ['workspace', 'bead', 'repo', 'number', 'url', 'branch', 'base', 'method']) {
    assert.equal(back[field], spec[field], `${field} did not survive the round trip`);
  }
  assert.equal(back.summary, spec.summary);
  assert.equal(back.tests, spec.tests);
});

check('and mergeSpec reads it off a row the way the sweep hands one over', () => {
  const row = { id: 'bc-zz1', description: mergeBeadBody(spec), notes: '', design: '' };
  const back = mergeSpec(row);
  assert.equal(back.number, 42);
  assert.equal(back.bead, 'bc-7qo');
});

check('a block that will not parse is an error, not an absence', () => {
  // The distinction is the whole safety of it: a merge-bead the queue reads as "nothing
  // here" is one it skips in silence for the rest of its life, where an error is a
  // sentence somebody can act on.
  const row = { id: 'bc-zz2', description: '```beadpr\n: : not yaml : :\n```' };
  const back = mergeSpec(row);
  assert.ok(back?.error, 'a broken block read as a bead with nothing behind it');
});

check('the title names the pull request first, because that is what the queue is of', () => {
  const t = mergeBeadTitle(spec);
  assert.match(t, /^Merge #42 — bc-7qo/);
  assert.ok(t.length <= 160);
});

check('the body says what depends on what — the first question anyone opening one has', () => {
  const body = mergeBeadBody(spec, { tests: spec.tests });
  assert.match(body, /bc-7qo depends on this bead/, 'it does not say what the dependency is for');
  assert.match(body, /close gate refuses a bead with an open blocker/, 'it does not say why the dependency is the rule');
});

/* ------------------------------------------------------------------ the label */

check('the label is what marks one, and nothing else does', () => {
  assert.equal(isMergeBead({ labels: [MERGE_LABEL] }), true);
  assert.equal(isMergeBead({ labels: ['pr-delivery'] }), false);
  assert.equal(isMergeBead({ labels: [] }), false);
  assert.equal(isMergeBead({}), false);
  // Whitespace, because labels arrive from bd as strings a human may have typed.
  assert.equal(isMergeBead({ labels: [` ${MERGE_LABEL} `] }), true);
});

/* ------------------------------------------------------------- the queue state */

check('a bead nothing has tried has been tried nought times, not null times', () => {
  const s = queueState({ notes: '' });
  assert.equal(s.attempts, 0);
  assert.equal(s.refused, null, 'refused must stay null — an empty sentence is a different state');
  assert.deepEqual(s.baseline, []);
  assert.equal(s.resolving, false);
});

check('the state survives a round trip through notes', () => {
  const notes = withQueueBlock('', {
    attempts: 2,
    refused: 'GitHub said the branch conflicts with its base.',
    at: '2026-08-14T12:00:00.000Z',
    baseline: ['test/reenter.mjs'],
    resolving: true,
  });
  const s = queueState({ notes });
  assert.equal(s.attempts, 2);
  assert.match(s.refused, /conflicts with its base/);
  assert.deepEqual(s.baseline, ['test/reenter.mjs']);
  assert.equal(s.resolving, true);
});

check('rewriting it leaves everything else in notes alone', () => {
  const before = withQueueBlock('A human wrote this line.\n\nAnd this one.', { attempts: 1 });
  const after = withQueueBlock(before, { attempts: 2 });
  assert.match(after, /A human wrote this line\./);
  assert.match(after, /And this one\./);
  assert.equal(queueState({ notes: after }).attempts, 2);
  // One block, not two stacked up — a tick per minute would otherwise grow the field
  // without bound.
  assert.equal(after.split(QUEUE_OPEN).length - 1, 1, 'the block was appended rather than replaced');
  assert.equal(after.split(QUEUE_CLOSE).length - 1, 1);
});

check('a block a human broke reads as untried rather than as exhausted', () => {
  // The safe direction: untried costs one more attempt, where "exhausted" silently
  // strands the pull request with nothing saying why.
  const notes = `${QUEUE_OPEN}\n: : not yaml : :\n${QUEUE_CLOSE}`;
  assert.equal(queueState({ notes }).attempts, 0);
});

check('the block is bounded — a refusal cannot grow notes without limit', () => {
  const s = queueState({ notes: withQueueBlock('', { attempts: 1, refused: 'x'.repeat(2000) }) });
  assert.ok(s.refused.length <= 400, `a 2000-character refusal survived at ${s.refused.length}`);
});

/* ------------------------------------------------------------- who it goes to */

check('the assignee, the kind id and the foundation key are one string', () => {
  assert.equal(MERGE_ASSIGNEE, MERGE_ADVOCATE);
  assert.ok(
    AGENTS.includes(MERGE_ASSIGNEE),
    'a merge-bead is assigned to something that is not an agent kind — nothing will ever pick it up'
  );
});

/* -------------------------------------------------- one merge-bead per request */

const row = (id, d, extra = {}) => ({
  id,
  status: 'open',
  labels: [MERGE_LABEL],
  description: mergeBeadBody({ ...spec, ...d }),
  ...extra,
});

check('a re-delivery finds the merge-bead already open for the same pull request', () => {
  const rows = [row('bc-m1', {}), row('bc-m2', { number: 99, url: 'https://github.com/mordam/beadcause/pull/99', bead: 'bc-other' })];
  const found = openMergeBeadFor(rows, { repo: 'mordam/beadcause', number: 42, bead: 'bc-7qo' });
  assert.deepEqual(found.map((f) => f.id), ['bc-m1']);
});

check('and the one for the same work bead on an abandoned branch', () => {
  // The pull request number alone misses this: a session that abandoned its branch and
  // delivered the same bead on a new one leaves the first merge-bead pointing at a pull
  // request nobody is going to merge.
  const rows = [row('bc-m1', { number: 41, url: 'https://github.com/mordam/beadcause/pull/41' })];
  const found = openMergeBeadFor(rows, { repo: 'mordam/beadcause', number: 42, bead: 'bc-7qo' });
  assert.deepEqual(found.map((f) => f.id), ['bc-m1']);
  assert.equal(found[0].number, 41, 'it must say which request it found, or the close reason looks like a mistake');
});

check('a closed one is not found, and neither is a bead that is not a merge-bead', () => {
  const rows = [row('bc-m1', {}, { status: 'closed' }), { ...row('bc-m2', {}), labels: ['pr-delivery'] }];
  assert.deepEqual(openMergeBeadFor(rows, { repo: 'mordam/beadcause', number: 42, bead: 'bc-7qo' }), []);
});

check('nothing to compare matches nothing — not everything', () => {
  // The worst thing this could do: a caller with neither half known closing every open
  // merge-bead in the workspace.
  assert.deepEqual(openMergeBeadFor([row('bc-m1', {})], {}), []);
});

check('a different repo with the same number is a different pull request', () => {
  const rows = [row('bc-m1', { repo: 'mordam/other', url: 'https://github.com/mordam/other/pull/42', bead: 'zz-1' })];
  assert.deepEqual(openMergeBeadFor(rows, { repo: 'mordam/beadcause', number: 42 }), []);
});

/* --------------------------------------------------------------------- limits */

check('MAX_ATTEMPTS is small enough that a stuck merge reaches a person', () => {
  assert.ok(MAX_ATTEMPTS >= 2 && MAX_ATTEMPTS <= 5, `${MAX_ATTEMPTS} attempts is not a retry, it is a loop`);
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
