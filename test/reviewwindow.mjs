/**
 * One pull request, one reviewer — the door bc-36xx.5 opens, and the ways it must not open
 * twice.
 *
 * The rest of this epic was built in front of a door that did not exist. The kind was
 * registered (bc-36xx.1), the verdict block written (bc-36xx.2), the gate that reads one
 * wired into the sweep (bc-36xx.4) — and nothing anywhere imported lib/reviewadvocate.js,
 * so a brief nobody was ever handed sat in the tree looking finished. This suite is about
 * the four claims that door has to make good, and three of them fail silently:
 *
 *   - **a second tick opens nothing**, which is the whole of it. The merge queue sweeps
 *     every thirty seconds and a review takes minutes, so a door with no registry behind it
 *     is not one extra window, it is one every tick for as long as the reviewer reads —
 *     each of them arguing with the same diff and writing its own verdict onto the same
 *     bead. Asserted as a count of launches, because a door that answered "already open"
 *     and opened one anyway would pass a status assertion;
 *   - **and the worker's door and the reviewer's door share that registry**, which a
 *     per-door one would have missed: the two agents on one branch at once are an author
 *     editing the diff underneath the reviewer reading it;
 *   - **a second round is opened as a second round.** `reviewState.round` counts rounds
 *     *finished* and `withAnswers` deliberately never touches it, so a window opened under
 *     the block's own number is handed the *first* round's brief and re-reviews the diff it
 *     was opened to stop re-reviewing. An off-by-one that reads as a working loop;
 *   - **and `openSessions: false` opens nothing at all**, which is the switch every other
 *     door in the daemon honours and the one a new door forgets.
 *
 *     node test/reviewwindow.mjs
 *
 * No iTerm, no `gh`, no tracker: `sweepMergeQueue` and `resolveFor` are both the real
 * modules and only the window itself is faked, so what is under test is the composition
 * rather than a re-description of it. The two claims that live inside a closure in
 * lib/server.js — the `openSessions` guard and which session function is reached — are
 * pinned against the source, as test/mergegate.mjs pins the resolver door beside it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before lib/resolvers.js is reached through the import below: CONFIG_DIR resolves once, at
// module load, and the daemon's own record of which windows are open is not this suite's to
// read — or, worse, to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reviewwindow-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { resolveFor, reset, restart } = await import(LIB('resolvers.js'));
const { sweepMergeQueue } = await import(LIB('mergequeue.js'));
const { MERGE_ASSIGNEE, MERGE_LABEL, mergeBeadBody, nextReviewRound, reviewState, withReviewBlock } = await import(
  LIB('mergebead.js')
);
const { reviewAdvocatePrompt } = await import(LIB('reviewadvocate.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('\none pull request, one reviewer\n');

/* --------------------------------------------------------------------- the world */

const SPEC = {
  workspace: 'demo',
  bead: 'zz-work',
  repo: 'acme/widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  branch: 'work-a',
  base: 'main',
  method: 'merge',
  tests: 'npm test, green',
};

const HEAD = 'aaaaaaa1';
const REVIEW_ON = { reviewRequired: true };

const beadWith = (review) => ({
  id: 'zz-merge',
  title: 'Merge #42 — zz-work',
  status: 'open',
  labels: [MERGE_LABEL],
  assignee: MERGE_ASSIGNEE,
  description: mergeBeadBody(SPEC),
  notes: withReviewBlock('', review),
});

const fakeBd = (review) => ({
  updates: [],
  listAgent: async () => [beadWith(review)],
  show: async (ws, id) => (id === 'zz-work' ? { id, issue_type: 'task' } : null),
  close: async () => {},
  comment: async () => {},
  update: async function (ws, id, patch) {
    this.updates.push({ id, ...patch });
  },
});

const fakePr = () => ({
  view: async () => ({
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    checks: { failed: [], failing: 0, pending: 0, total: 3, state: 'passing' },
    reviewDecision: null,
    mergedAt: null,
    headSha: HEAD,
  }),
  baseChecks: async () => ({ failed: [] }),
  updateBranch: async () => ({ updated: true, reason: '' }),
  merge: async () => ({ mergeCommit: 'abcdef1234' }),
});

const resolve = async () => ({ unit: { key: 'demo/widgets' }, dir: '/tmp/widgets', reason: '' });

/**
 * The daemon's door, minus the two things a test cannot have: the checkout lookup and the
 * window. Everything else is the real thing — the real sweep decides whether a review is
 * wanted, and the real registry decides whether a window may open for it.
 */
function daemon(state, { term = 'iterm-1', now = Date.parse('2026-08-18T13:45:00Z') } = {}) {
  const through = (kind) => async (entry, dir, outcome) => {
    const out = await resolveFor(
      'demo/widgets',
      entry.spec.number,
      async () => {
        const seen = reviewState(entry.issue);
        state.opened.push({
          kind,
          bead: entry.issue.id,
          dir,
          round: nextReviewRound(seen),
          why: outcome?.why || '',
        });
        return { dir, mode: 'acceptEdits', term };
      },
      {
        branch: entry.spec.branch,
        owner: 'Adam',
        now,
        say: async (handle, text) => {
          state.said.push({ handle, text });
          return 'sent';
        },
      }
    );
    if (out?.error) return false;
    return Boolean(out?.opened || out?.queued || out?.reused);
  };
  return { openReview: through('review'), openAnswer: through('answer') };
}

const fresh = () => ({ opened: [], said: [] });

const tick = (bd, state, opts = {}) =>
  sweepMergeQueue(bd, { name: 'demo' }, { resolve, prApi: fakePr(), policy: REVIEW_ON, ...daemon(state, opts), ...opts });

/* --------------------------------------------------------------------- the cases */

await check('a delivered pull request nothing has judged opens one reviewer', async () => {
  const state = fresh();
  const bd = fakeBd({ round: 0 });
  const out = await tick(bd, state);
  assert.equal(state.opened.length, 1, 'one window');
  assert.equal(state.opened[0].kind, 'review');
  assert.equal(state.opened[0].bead, 'zz-merge', 'the window is opened on the merge-bead, which is where its verdict goes');
  assert.equal(state.opened[0].dir, '/tmp/widgets', 'and in the checkout the branch is actually in');
  assert.equal(state.opened[0].round, 1);
  assert.deepEqual(out.reviewing, ['zz-merge']);
  assert.deepEqual(out.merged, [], 'it merged a pull request it had just decided nobody had read');
});

/**
 * The whole point of the registry, in the smallest form it takes here: tick, then tick
 * again. The merge queue sweeps every thirty seconds and a review is minutes of reading.
 */
await check('AND A SECOND TICK OPENS NOTHING — ONE WINDOW PER PULL REQUEST', async () => {
  const state = fresh();
  const bd = fakeBd({ round: 0 });
  await tick(bd, state);
  const out = await tick(bd, state, { now: Date.parse('2026-08-18T13:49:00Z') });
  assert.equal(state.opened.length, 1, 'a second reviewer was opened on a diff one is already reading');
  assert.equal(state.said.length, 1, 'and the live one was not told the sweep had come round again');
  assert.match(state.said[0].text, /#42/);
  // Still counted: a reused window is somebody dealing with it, which is what the resolver
  // door has always taken those three answers to mean.
  assert.deepEqual(out.reviewing, ['zz-merge']);
});

await check('and the worker’s door cannot open one either while a reviewer holds it', async () => {
  // The case a per-door registry would have missed entirely: an author editing the diff
  // underneath the reviewer reading it. One window per pull request, whichever door.
  const state = fresh();
  await tick(fakeBd({ round: 0 }), state);
  const answering = fakeBd({
    round: 1,
    verdict: 'changes',
    reviewedSha: HEAD,
    comments: [{ id: 'c1', body: 'this leaks a handle' }],
  });
  await tick(answering, state, { now: Date.parse('2026-08-18T13:50:00Z') });
  assert.deepEqual(
    state.opened.map((o) => o.kind),
    ['review'],
    'the worker was opened on a branch a reviewer is reading'
  );
});

await check('A DAEMON RESTART DOES NOT OPEN A SECOND ONE EITHER', async () => {
  // The trap this bead was filed knowing about: the registry is in memory. It is also on
  // disk, and `restart()` is what a boot does with it — the records come back with no
  // handle, and a record with no handle still *holds*. Nothing here invents a second answer
  // for it; the durable record of where a review got to is the block on the bead.
  const state = fresh();
  const bd = fakeBd({ round: 0 });
  await tick(bd, state);
  restart();
  const out = await tick(bd, state, { now: Date.parse('2026-08-18T13:50:00Z') });
  assert.equal(state.opened.length, 1, 'the daemon restarted and opened a second window at the same diff');
  // And it is not counted as a window that went up, because none did — the pull request is
  // still awaiting a review, which is exactly what the sweep says about it.
  assert.deepEqual(out.reviewing, []);
  assert.deepEqual(out.awaiting, ['zz-merge']);
});

await check('A SECOND REVIEW IS OPENED AS THE SECOND ROUND, NOT AS ANOTHER FIRST', async () => {
  // `reviewState.round` counts rounds finished, and `withAnswers` never touches it — the
  // round belongs to the reviewer's passes. So a window opened under the block's own number
  // is handed the first round's brief and re-reviews the whole diff.
  const state = fresh();
  const bd = fakeBd({
    round: 1,
    verdict: 'changes',
    reviewedSha: HEAD,
    comments: [{ id: 'c1', body: 'this leaks a handle', answer: 'changed', note: 'closed in the finally now' }],
  });
  const out = await tick(bd, state);
  assert.equal(state.opened.length, 1);
  assert.equal(state.opened[0].round, 2, 'the second reviewer was opened as round 1');
  assert.match(state.opened[0].why, /answered every comment from round 1/);
  assert.deepEqual(out.reviewing, ['zz-merge']);
});

/* ------------------------------------------------------------------- the brief */

await check('and the brief it is opened with names the pull request and the merge-bead', async () => {
  const text = reviewAdvocatePrompt('demo', { id: 'zz-merge' }, SPEC, { round: 1 }, { owner: 'Adam', maxRounds: 2 });
  assert.match(text, /zz-merge/, 'the reviewer is not told which bead its verdict goes on');
  assert.match(text, /#42/);
  assert.match(text, /zz-work/, 'nor which work the branch was supposed to deliver');
  assert.match(text, /https:\/\/github\.com\/acme\/widgets\/pull\/42/);
});

await check('AND A SECOND ROUND IS HANDED THE COMMENTS AS THE BLOCK ACTUALLY STORES THEM', async () => {
  /**
   * The shape mismatch this bead's door exposed. `checkVerdict` normalises a verdict's own
   * comments to `{file, what, severity}`; the block that survives between two windows stores
   * `{path, body, answer, note}`, with `answer` an enum and the prose beside it. Rendered
   * from the first shape alone, every second-round brief read `(undefined) — you said:` with
   * nothing after it — a reviewer asked to weigh answers it was never shown.
   */
  const state = {
    round: 2,
    comments: [
      { id: 'c1', path: 'lib/fetch.js', line: 88, body: 'no ceiling on the retry', answer: 'declined', note: 'the caller times out at 30s' },
    ],
  };
  const text = reviewAdvocatePrompt('demo', { id: 'zz-merge' }, SPEC, state, { owner: 'Adam', maxRounds: 2 });
  assert.ok(!/undefined/.test(text), 'the brief printed `undefined` where a comment should be');
  assert.match(text, /no ceiling on the retry/, 'the reviewer is not shown what it said last round');
  assert.match(text, /lib\/fetch\.js:88/);
  assert.match(text, /declined — the caller times out at 30s/, 'the worker’s answer is not shown, or not its reason');
  assert.match(text, /not a fresh review/i, 'a second round was handed the first round’s instructions');
});

/* -------------------------------------------------------------------- the door */

/**
 * The two claims that live inside a closure in the daemon and cannot be reached without one.
 * Pinned against the source, as test/mergegate.mjs pins the resolver door beside it — and
 * for its reason: a window opened without `agent` runs with the *worker's* reach, `bd close`
 * and `gh pr merge` both in it, over somebody else's branch.
 */
check('the daemon reaches the reviewer’s door, through the registry, and honours openSessions', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'server.js'), 'utf8');
  const from = src.indexOf('openReview: async (entry, dir, outcome)');
  assert.ok(from > 0, 'the merge queue no longer wires a reviewer — re-point this check');
  const body = src.slice(from, from + 1800);
  assert.match(body, /cfg\.openSessions === false/, 'the one switch that turns every window in the daemon off is not honoured');
  assert.match(body, /resolveFor\(/, 'nothing stops a second reviewer opening on the same pull request');
  assert.match(body, /openReviewAdvocateSession\(/, 'the reviewer is opened as something else, with something else’s permissions');
  assert.match(body, /nextReviewRound\(/, 'a second round is opened under the round that has already finished');
});

check('AND THAT DOOR OPENS IT AS ITSELF, WHICH IS THE WHOLE ARGUMENT FOR THE KIND', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'session.js'), 'utf8');
  const from = src.indexOf('export async function openReviewAdvocateSession');
  assert.ok(from > 0, 'openReviewAdvocateSession has been renamed — re-point this check');
  const body = src.slice(from, src.indexOf('\n}\n', from));
  assert.match(body, /agent: REVIEW_ADVOCATE, bead: issue\.id/, 'the reviewer runs with a reach the foundation does not give it');
  assert.match(body, /reviewAdvocatePrompt\(/, 'and with a brief that is not its own');
  assert.match(body, /notesIn\(where, REVIEW_ADVOCATE\)/, 'it is handed the worker’s notes — the defendant’s own file on the case');
});

cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
