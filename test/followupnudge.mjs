#!/usr/bin/env node
/**
 * The Epic Advocate of a root a review follow-up landed under, told about it — bc-9ntye.3.
 *
 *     npm test
 *     node test/followupnudge.mjs
 *
 * bc-9ntye.2 files the bead; this is the sentence after it. The bead is open and unclaimed
 * under a root, which is already what `bd ready` and the re-entry sweep are for — so the
 * interesting failures here are almost all in the *other* direction, and that is what this
 * suite is mostly about.
 *
 * The four worth a suite, in the order they would hurt:
 *
 * 1. **Typing into a window that has no advocate on it.** `wantsAdvocate` is a display
 *    predicate — true of every open, owned root, including the great many nothing has ever
 *    advocated. Messaging one of those is a paragraph typed into somebody's ordinary
 *    worker window about an epic it is not on. `advocatedRootOver` is `wantsAdvocate` *and*
 *    `isEnrolled`, which is the pair `advocatedRoots` queues on, and the two must not
 *    disagree about which roots have an advocate.
 * 2. **Reporting a nudge that never happened.** The daemon log quotes `describeNudge`, and
 *    "told bc-x's advocate" over a window that had already closed is the same class of lie
 *    as a comment claiming a bead closed when it had not. `told`, `missing` and `none` are
 *    three answers on purpose.
 * 3. **Standing between a merge and its closes.** `finish` has one rule over all others.
 *    An iTerm refusal, a session with no terminal, a `liveSessions` that threw — every one
 *    of them has to come back as a value, never as a throw.
 * 4. **Saying it twice.** A follow-up an earlier tick filed was announced by that tick.
 *    `finish` is best-effort end to end and the next tick arrives at the same state, so the
 *    `already` case must be silent — `askAdvocate` in lib/mergequeue.js guards on `filed`,
 *    and this pins the shape that guard reads.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const { advocatedRootOver, nudgeMessage, tellEpicAdvocate, describeNudge } = await import(LIB('followupnudge.js'));
const { ADVOCATE_LABEL, WAITING_OPEN, WAITING_CLOSE } = await import(LIB('epicadvocate.js'));

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

console.log('\ntelling an epic advocate that a review follow-up landed under it\n');

/* ------------------------------------------------------------------- the world */

const OWNED = ['owner:someone@example.com'];

/** A root with an advocate on it, by whichever carrier — both are `isEnrolled`. */
const enrolledEpic = (id, extra = {}) => ({
  id,
  issue_type: 'epic',
  status: 'open',
  labels: [...OWNED, ADVOCATE_LABEL],
  title: `${id}'s theme`,
  ...extra,
});

const index = (rows, parents = []) => ({
  beads: new Map(rows.map((r) => [r.id, r])),
  parents: new Map(parents),
});

const SPEC = { number: 671, bead: 'zz-work', repo: 'Someone/demo', workspace: 'demo' };
const FOLLOWUP = { id: 'zz-f1', filed: true, already: false, comments: [1, 2], children: ['zz-f1.1', 'zz-f1.2'] };

/* --------------------------------------------------- which roots have an advocate */

await check('an enrolled epic over the bead is the root to tell', () => {
  const i = index([enrolledEpic('zz-epic'), { id: 'zz-work', issue_type: 'task', priority: 2, status: 'open' }], [['zz-work', 'zz-epic']]);
  assert.equal(advocatedRootOver(i, 'zz-epic'), 'zz-epic');
  // And from the work bead, which is what `rootOver` is for.
  assert.equal(advocatedRootOver(i, 'zz-work'), 'zz-epic');
});

await check('a waiting-on block enrols just as the label does — the old carrier goes on counting', () => {
  const epic = enrolledEpic('zz-epic', {
    labels: OWNED,
    notes: `${WAITING_OPEN}waiting on the second child${WAITING_CLOSE}`,
  });
  assert.equal(advocatedRootOver(index([epic]), 'zz-epic'), 'zz-epic');
});

await check('a root nothing has ever advocated is not told — wantsAdvocate alone is not enough', () => {
  // Open, owned, a root: `wantsAdvocate` says yes and there is still no advocate to tell.
  const epic = { id: 'zz-epic', issue_type: 'epic', status: 'open', labels: OWNED };
  assert.equal(advocatedRootOver(index([epic]), 'zz-epic'), '');
});

await check('an unowned root is not told either, which is the launch door\'s own refusal', () => {
  const epic = { id: 'zz-epic', issue_type: 'epic', status: 'open', labels: [ADVOCATE_LABEL] };
  assert.equal(advocatedRootOver(index([epic]), 'zz-epic'), '');
});

await check('a P0 task root counts, because that is what an advocated epic means everywhere else here', () => {
  const p0 = { id: 'zz-p0', issue_type: 'task', priority: 0, status: 'open', labels: [...OWNED, ADVOCATE_LABEL] };
  assert.equal(advocatedRootOver(index([p0]), 'zz-p0'), 'zz-p0');
});

await check('no root above the bead is the bead\'s own "then do nothing"', () => {
  const i = index([{ id: 'zz-loose', issue_type: 'task', priority: 2, status: 'open' }]);
  assert.equal(advocatedRootOver(i, 'zz-loose'), '');
});

await check('an index that could not be read answers nothing rather than guessing', () => {
  assert.equal(advocatedRootOver(null, 'zz-work'), '');
  assert.equal(advocatedRootOver({ beads: new Map(), error: 'bd export failed' }, 'zz-work'), '');
  assert.equal(advocatedRootOver(index([enrolledEpic('zz-epic')]), ''), '');
});

/* ------------------------------------------------------------------ what it says */

await check('the message names the bead, the epic and the pull request', () => {
  const said = nudgeMessage('zz-epic', FOLLOWUP, SPEC, { title: 'Review stops gating the merge' });
  assert.match(said, /zz-f1/);
  assert.match(said, /zz-epic/);
  assert.match(said, /Review stops gating the merge/);
  assert.match(said, /#671/);
  assert.match(said, /2 review findings/);
  assert.match(said, /2 children/);
});

await check('it says the branch has landed, so nothing goes looking for a review to do', () => {
  const said = nudgeMessage('zz-epic', FOLLOWUP, SPEC);
  assert.match(said, /nothing left to review/);
  assert.match(said, /zz-work/);
});

await check('it says closing a child is a real answer — the failure it is most likely to cause', () => {
  assert.match(nudgeMessage('zz-epic', FOLLOWUP, SPEC), /Closing a child is a real answer/);
});

await check('one finding is said in the singular, and a childless follow-up claims no children', () => {
  const said = nudgeMessage('zz-epic', { id: 'zz-f1', comments: [1], children: [] }, SPEC);
  assert.match(said, /1 review finding still open/);
  // The count clause only — the two later sentences talk about children unconditionally,
  // and rightly: a follow-up whose children all failed to file still has findings on it.
  assert.doesNotMatch(said, /with \d+ child/);
});

await check('no carriage returns, because one would submit the message halfway through', () => {
  // `messageSession` normalises, but a template that grew a `\r` would be submitting a
  // paragraph into a live window in two halves — cheaper to pin here than to find there.
  assert.doesNotMatch(nudgeMessage('zz-epic', FOLLOWUP, SPEC, { title: 'x' }), /\r/);
});

/* ------------------------------------------------------- telling the live window */

const session = (pid, name) => ({ pid, name, status: 'idle' });

await check('a live window on the root is typed into, and the answer says so', async () => {
  const sent = [];
  const result = await tellEpicAdvocate(
    {},
    { root: 'zz-epic', followUp: FOLLOWUP, spec: SPEC, title: 'a theme' },
    {
      sessions: [session(4242, 'Beadcause - zz-epic epic advocate')],
      reach: async () => ({ can: true, tty: '/dev/ttys004', why: null }),
      say: async (tty, text) => {
        sent.push({ tty, text });
        return 'sent';
      },
    }
  );
  assert.equal(result.state, 'told');
  assert.equal(result.pid, 4242);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tty, '/dev/ttys004');
  assert.match(sent[0].text, /zz-f1/);
  assert.match(describeNudge(result, FOLLOWUP), /told zz-epic's advocate about zz-f1/);
});

await check('nothing on this Mac names the root — silent, and that is the ordinary answer', async () => {
  let said = 0;
  const result = await tellEpicAdvocate(
    {},
    { root: 'zz-epic', followUp: FOLLOWUP, spec: SPEC },
    { sessions: [session(4242, 'Beadcause - zz-other something else')], say: async () => (said += 1) }
  );
  assert.equal(result.state, 'none');
  assert.equal(said, 0);
  // The re-entry sweep's `filed` event is what covers this, and it is not news.
  assert.equal(describeNudge(result, FOLLOWUP), '');
});

await check('a child\'s window does not answer for its parent epic', async () => {
  // `namesBead` and not `includes`: every parent id is a prefix of its children's, so a
  // worker on zz-epic.1 must not be reported as the advocate on zz-epic.
  const result = await tellEpicAdvocate(
    {},
    { root: 'zz-epic', followUp: FOLLOWUP, spec: SPEC },
    { sessions: [session(4242, 'Beadcause - zz-epic.1 a child')], say: async () => 'sent' }
  );
  assert.equal(result.state, 'none');
});

await check('a window that closed between the list and the typing is `missing`, not `told`', async () => {
  const result = await tellEpicAdvocate(
    {},
    { root: 'zz-epic', followUp: FOLLOWUP, spec: SPEC },
    {
      sessions: [session(4242, 'Beadcause - zz-epic')],
      reach: async () => ({ can: true, tty: '/dev/ttys004' }),
      say: async () => 'missing',
    }
  );
  assert.equal(result.state, 'missing');
  assert.match(describeNudge(result, FOLLOWUP), /had gone before zz-f1 could be handed to it/);
});

await check('a session with no terminal is reported in sessionReach\'s own words', async () => {
  const why = 'It has no terminal — nothing on this Mac has an input line for it.';
  const result = await tellEpicAdvocate(
    {},
    { root: 'zz-epic', followUp: FOLLOWUP, spec: SPEC },
    { sessions: [session(4242, 'Beadcause - zz-epic')], reach: async () => ({ can: false, tty: null, why }), say: async () => 'sent' }
  );
  assert.equal(result.state, 'none');
  assert.equal(result.why, why);
  assert.match(describeNudge(result, FOLLOWUP), /could not reach zz-epic's advocate/);
});

await check('iTerm refusing an Apple event is not the window being gone, and never throws', async () => {
  const result = await tellEpicAdvocate(
    {},
    { root: 'zz-epic', followUp: FOLLOWUP, spec: SPEC },
    {
      sessions: [session(4242, 'Beadcause - zz-epic')],
      reach: async () => ({ can: true, tty: '/dev/ttys004' }),
      say: async () => {
        throw new Error('Not authorised to send Apple events to iTerm2.\nsecond line');
      },
    }
  );
  assert.equal(result.state, 'none');
  assert.equal(result.why, 'Not authorised to send Apple events to iTerm2.');
});

await check('a session list that threw is a value, not an exception into the close path', async () => {
  const result = await tellEpicAdvocate(
    {},
    { root: 'zz-epic', followUp: FOLLOWUP, spec: SPEC },
    {
      sessions: null,
      // The default would read the real Mac; hand over one that fails the way it could.
      reach: async () => {
        throw new Error('ps went away');
      },
      say: async () => 'sent',
    }
  );
  // `liveSessions` is the real one here and finds nothing about zz-epic on this Mac, so
  // this stops before `reach` — either way the answer is a value.
  assert.equal(result.state, 'none');
});

await check('no root and no follow-up are both nothing to do', async () => {
  assert.equal((await tellEpicAdvocate({}, { root: '', followUp: FOLLOWUP })).state, 'none');
  assert.equal((await tellEpicAdvocate({}, { root: 'zz-epic', followUp: null })).state, 'none');
  assert.equal((await tellEpicAdvocate({}, {})).state, 'none');
});

await check('describeNudge says nothing without a bead to name', () => {
  assert.equal(describeNudge({ state: 'told', root: 'zz-epic' }, null), '');
  assert.equal(describeNudge(null, FOLLOWUP), '');
});

console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
