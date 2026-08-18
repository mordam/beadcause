#!/usr/bin/env node
/**
 * Handing a merge back: the merge-bead *becomes* the card, and does not spawn one.
 *
 *     npm test
 *     node test/mergeraise.mjs
 *
 * bc-r941.4. The obvious design — the queue files a delivery card when it gives up — is
 * the wrong one, and the reason is bc-ec6: a merge-bead is already a blocker on the work
 * bead, so a second bead beside it leaves the work bead behind two of them, and answering
 * either is reported as having closed a bead that neither could close. `clearOpenCards`
 * in bin/deliver.js is the scar tissue from exactly that pile in its milder form.
 *
 * So there are three properties here and each one is a way this could quietly go wrong:
 *
 * 1. **One bead, relabelled.** `human` and `pr-delivery` on, `merge-queue` off. The
 *    removal is the handover: `queueFor` selects on that label, so a bead that keeps it
 *    is one the queue picks up again underneath the person now looking at it.
 * 2. **The card is a real delivery card.** Same body builder, same `beadpr` block, so the
 *    Merge button on it goes through `resolveDeliveryFor` — the door that already exists.
 * 3. **It says how many times this was tried.** A card reading "checks failed" over a
 *    pull request the queue has attempted three times reads as a first look, and the
 *    natural response to a first look is to press Merge — which is the thing that was
 *    already refused.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const { raiseMergeCard, raiseOpening } = await import(LIB('mergeraise.js'));
const { MERGE_LABEL, MAX_ATTEMPTS, mergeBeadBody, queueState } = await import(LIB('mergebead.js'));
const { DELIVERY_LABEL, parseDelivery, deliveryAction } = await import(LIB('delivery.js'));

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

console.log('\nthe queue gives up: the merge-bead becomes the card\n');

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

const entryFor = (state = { attempts: 3, refused: 'lint is red.' }) => ({
  issue: { id: 'zz-merge', title: 'Merge #42 — zz-work', notes: '', labels: [MERGE_LABEL] },
  spec: SPEC,
  state,
});

function fakeBd({ fail = false } = {}) {
  const updates = [];
  return {
    updates,
    update: async (ws, id, patch) => {
      if (fail) throw new Error('bd said no');
      updates.push({ id, ...patch });
    },
  };
}

await check('it relabels the one bead rather than filing a second', async () => {
  const bd = fakeBd();
  const ok = await raiseMergeCard(bd, { name: 'demo' }, entryFor(), 'the checks went red.');
  assert.equal(ok, true);
  assert.equal(bd.updates.length, 1, 'more than one write means more than one bead');
  const patch = bd.updates[0];
  assert.equal(patch.id, 'zz-merge');
  assert.deepEqual(patch.addLabels, ['human', DELIVERY_LABEL]);
  assert.deepEqual(patch.removeLabels, [MERGE_LABEL], 'the queue will pick it up again under the person reading it');
});

await check('the description it writes is a real delivery card', async () => {
  const bd = fakeBd();
  await raiseMergeCard(bd, { name: 'demo' }, entryFor(), 'the checks went red.');
  const body = bd.updates[0].description;
  const d = parseDelivery(body);
  assert.ok(d && !d.error, `the card does not parse as a delivery: ${d?.error}`);
  assert.equal(d.number, 42);
  assert.equal(d.bead, 'zz-work');
  assert.equal(d.method, 'merge');
  // The four answers, which is what makes it answerable from a lock screen at all.
  assert.match(body, /id: merge/);
  assert.match(body, /id: changes/);
  assert.match(body, /id: decline/);
  assert.ok(deliveryAction('MERGE: merge #42')?.action === 'merge');
});

await check('and it carries the sentence that refused it, in the words of what refused', async () => {
  const bd = fakeBd();
  await raiseMergeCard(bd, { name: 'demo' }, entryFor(), 'GitHub said the base branch policy prohibits the merge.');
  assert.match(bd.updates[0].description, /base branch policy prohibits/);
});

await check('IT SAYS HOW MANY TIMES IT WAS TRIED, or the card reads as a first look', async () => {
  assert.match(raiseOpening({ attempts: 3 }, 'lint is red.'), /Tried 3 times/);
  assert.match(raiseOpening({ attempts: MAX_ATTEMPTS }, 'lint is red.'), /that was the last/);
  // Nothing tried yet — a conflict handed over immediately — says only what happened.
  assert.equal(raiseOpening({ attempts: 0 }, 'the branch conflicts.'), 'the branch conflicts.');
});

await check('an approval wait is not written as a refusal', async () => {
  const bd = fakeBd();
  await raiseMergeCard(bd, { name: 'demo' }, entryFor({ attempts: 0 }), '', { approval: true });
  const body = bd.updates[0].description;
  assert.match(body, /waiting on an approving review/);
  assert.ok(!/could not/.test(body), 'a wait was written as an attempt that failed');
});

await check('A DEADLOCKED REVIEW BECOMES THE SAME ONE CARD, and not a second bead', async () => {
  // bc-36xx.7. The third way in, and it goes through this function rather than through a
  // raiser of its own for the reason at the top of the file: a merge-bead is already a
  // blocker on the work bead, so a second bead beside it leaves the work behind two.
  const bd = fakeBd();
  const why = 'The reviewer and the worker did not agree in 2 rounds of review, which is as many as this gets.';
  const ok = await raiseMergeCard(bd, { name: 'demo' }, entryFor({ attempts: 0 }), why, { review: true });
  assert.equal(ok, true);
  assert.equal(bd.updates.length, 1, 'a review escalation filed something beside the merge-bead');

  const body = bd.updates[0].description;
  assert.match(body, /did not end in an approval/, 'the review escalation borrowed another opening');
  assert.match(body, /did not agree in 2 rounds/, "the reviewer's own sentence is the whole of the card");
  assert.ok(!/tried to merge it/.test(body), 'a review that stopped early was written as a merge that failed');

  // The same relabel as every other way in — `human` is what puts it in the inbox, and
  // `merge-queue` coming off is the handover.
  assert.ok(bd.updates[0].addLabels.includes('human'), 'the card will not reach the inbox');
  assert.ok(bd.updates[0].addLabels.includes(DELIVERY_LABEL), 'the four answers will not work on it');
  assert.deepEqual(bd.updates[0].removeLabels, [MERGE_LABEL]);
  // And it is a real delivery card: Merge on it goes through the door that already exists.
  assert.ok(parseDelivery(body), 'the beadpr block did not survive the rewrite');
});

await check('a review escalation does not count merge attempts at you', async () => {
  // The tally is about merging, and this stopped before the queue tried anything. "Tried
  // 0 times" beside a deadlocked review counts the wrong thing at somebody working out
  // what to do about it.
  assert.equal(raiseOpening({ attempts: 2 }, 'the reviewer will not approve this.', { review: true }), 'the reviewer will not approve this.');
});

await check('the queue state stays on the bead — a card that lost it claims to be a first look', async () => {
  const bd = fakeBd();
  await raiseMergeCard(bd, { name: 'demo' }, entryFor({ attempts: 2, refused: 'lint is red.' }), 'lint is red.');
  const state = queueState({ notes: bd.updates[0].notes });
  assert.equal(state.attempts, 2);
  assert.match(state.refused, /lint/);
  assert.equal(state.resolving, false, 'it is still marked as being resolved by something');
});

await check('a tracker that refuses the relabel leaves it in the queue rather than losing it', async () => {
  const bd = fakeBd({ fail: true });
  const ok = await raiseMergeCard(bd, { name: 'demo' }, entryFor(), 'lint is red.');
  assert.equal(ok, false, 'a failed handover reported success, so nothing will try again');
});

await check('it says so on the pull request, where whoever opens the diff is standing', async () => {
  const bd = fakeBd();
  const said = [];
  await raiseMergeCard(bd, { name: 'demo' }, entryFor(), 'lint is red.', {
    prComment: async (spec, text) => said.push({ number: spec.number, text }),
  });
  assert.equal(said.length, 1);
  assert.equal(said[0].number, 42);
  assert.match(said[0].text, /merge queue/i);
  assert.match(said[0].text, /zz-merge/, 'the comment does not say where the decision now lives');
});

await check('and what it says on the pull request is which of the three stopped it', async () => {
  // Whoever opens the diff is standing at the pull request, not at the card, and "the
  // merge queue tried to merge this and could not" over a review that was never merged is
  // the one sentence that sends them looking at the checks instead of at the objection.
  const bd = fakeBd();
  const said = [];
  await raiseMergeCard(bd, { name: 'demo' }, entryFor({ attempts: 0 }), 'the reviewer will not approve this.', {
    review: true,
    prComment: async (spec, text) => said.push(text),
  });
  assert.match(said[0], /review loop/i);
  assert.ok(!/tried to merge/.test(said[0]), 'a review escalation was announced as a failed merge');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
