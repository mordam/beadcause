/**
 * What happens to an answer between the tap and the tracker.
 *
 * Submitting from the inbox used to block: every caller awaited `submit()`, and
 * `submit()` awaited the write and then the flight's absorb. Four cards answered in a
 * row was four sequential round trips against a tracker that can spend seconds
 * retrying the Dolt lock, with the second thumb press unable to start until the first
 * answer was on the record. `public/submitqueue.js` is what took the write off the
 * tap, and every way it can go wrong is invisible from the outside: an answer that
 * was queued and never sent looks exactly like one you forgot to give, and two writes
 * in the air at once look like nothing at all until bd starts refusing one of them.
 *
 * So this covers the queue and nothing above it:
 *
 * - a tap returns before its write does — the whole feature;
 * - jobs run **one at a time**, because bd is a single Dolt writer, and never
 *   overlap however fast they are tapped;
 * - they run in **tap order**, because the beads one answer creates can be what the
 *   next answer is about;
 * - a job that throws does not stop the drain — one refused write must not strand
 *   every answer tapped behind it, and app.js's job owns its own failure anyway;
 * - `size()` counts the write that is *on the wire* as well as the ones behind it,
 *   because the unload guard exists for exactly that one;
 * - nothing joins. This is the difference from `public/sendqueue.js`, which
 *   concatenates on purpose — see `test/queue.mjs` — and joining two submits would
 *   be answering one question with another question's words.
 *
 * The browser half — that the list, the composer and the next card are really usable
 * while a write is out, and that a refused one comes back red — is
 * `scripts/absorb-check.mjs`, which needs Chrome. This suite stays pure Node.
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'public', 'submitqueue.js');

/**
 * Load the real browser file, the way test/queue.mjs loads its neighbour: through a
 * vm context with nothing in it but a `window`. A copy of the logic rewritten as a
 * module would pass this suite while the phone shipped something else.
 */
function loadQueue() {
  const ctx = vm.createContext({ window: {}, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'submitqueue.js' });
  return ctx.window.beadcause.submitQueue;
}

const submitQueue = loadQueue();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the write. Records the order things ran in, how many were in the air
 * at once, and can be told to refuse a given key the way a 500 from bd does.
 */
function harness({ refuse = [], delay = 5 } = {}) {
  const started = [];
  const finished = [];
  const seen = [];
  let inAir = 0;
  let mostInAir = 0;
  const q = submitQueue.create({
    // `Array.from` rather than `.map`: everything the queue hands back was built
    // inside the vm realm, and an array from over there is never deep-equal to one
    // from here however identical it looks.
    onChange: (items) => seen.push(Array.from(items, (i) => `${i.key}${i.sending ? '!' : ''}`)),
  });
  const job = (key) => async () => {
    started.push(key);
    inAir += 1;
    mostInAir = Math.max(mostInAir, inAir);
    await tick(delay);
    inAir -= 1;
    if (refuse.includes(key)) throw new Error(`bd: database is locked (${key})`);
    finished.push(key);
  };
  return { q, job, started, finished, seen, mostInAir: () => mostInAir };
}

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
function skip(name) {
  console.log(`  skip ${name}`);
}

const drain = async (q, tries = 200) => {
  for (let i = 0; i < tries && q.size(); i++) await tick(2);
  return q.size() === 0;
};

console.log('\nsubmit queue\n');

/* ------------------------------------------------------------------- checks */

await check('the tap returns before the write does — that is the whole point', async () => {
  const { q, job, finished } = harness({ delay: 20 });
  q.add('bc-1', job('bc-1'));
  // Synchronously after add(): nothing has been written, and control is back.
  assert.deepEqual(finished, [], 'add() waited for the write');
  assert.equal(q.size(), 1, 'and the answer is owed');
  assert.ok(await drain(q));
  assert.deepEqual(finished, ['bc-1']);
});

await check('three answered back to back are three writes, in tap order', async () => {
  const { q, job, started, finished } = harness();
  q.add('bc-1', job('bc-1'));
  q.add('bc-2', job('bc-2'));
  q.add('bc-3', job('bc-3'));
  assert.equal(q.size(), 3, 'all three are owed the moment they are tapped');
  assert.ok(await drain(q));
  assert.deepEqual(started, ['bc-1', 'bc-2', 'bc-3'], 'started in the order they were tapped');
  assert.deepEqual(finished, ['bc-1', 'bc-2', 'bc-3']);
});

await check('never two writes in the air at once — bd is one writer', async () => {
  const { q, job, mostInAir } = harness({ delay: 12 });
  for (const k of ['bc-1', 'bc-2', 'bc-3', 'bc-4']) q.add(k, job(k));
  assert.ok(await drain(q));
  assert.equal(mostInAir(), 1, 'two overlapping writes would race the Dolt lock for nothing');
});

await check('nothing is joined — each entry stays its own write', async () => {
  const { q, job, started } = harness();
  q.add('bc-1', job('bc-1'));
  q.add('bc-2', job('bc-2'));
  assert.ok(await drain(q));
  assert.equal(started.length, 2, 'sendqueue concatenates; this one must not');
});

await check('a refused write does not strand the ones tapped behind it', async () => {
  const { q, job, started, finished } = harness({ refuse: ['bc-2'] });
  for (const k of ['bc-1', 'bc-2', 'bc-3']) q.add(k, job(k));
  assert.ok(await drain(q), 'the queue stopped on the refusal');
  assert.deepEqual(started, ['bc-1', 'bc-2', 'bc-3'], 'every one was attempted');
  assert.deepEqual(finished, ['bc-1', 'bc-3'], 'and only the refused one failed');
});

await check('a job added while one is draining joins the same drain', async () => {
  const { q, job, started } = harness({ delay: 10 });
  q.add('bc-1', job('bc-1'));
  await tick(4); // bc-1 is on the wire
  assert.ok(q.sending(), 'the first write should be out by now');
  q.add('bc-2', job('bc-2'));
  assert.ok(await drain(q));
  assert.deepEqual(started, ['bc-1', 'bc-2'], 'a second pump() must not run a second loop');
});

await check('size() counts the write that is on the wire, not just the ones behind it', async () => {
  const { q, job } = harness({ delay: 25 });
  q.add('bc-1', job('bc-1'));
  await tick(6);
  // This is the one the unload guard exists for: it has left `pending` and has not
  // landed, so a size() reading zero here is a page that closes over a lost answer.
  assert.ok(q.sending(), 'it should be out');
  assert.equal(q.size(), 1, 'the write in the air is still owed');
  assert.ok(await drain(q));
  assert.equal(q.size(), 0);
});

await check('has() says whether a card still owes a write', async () => {
  const { q, job } = harness({ delay: 15 });
  q.add('bc-1', job('bc-1'));
  q.add('bc-2', job('bc-2'));
  assert.ok(q.has('bc-1') && q.has('bc-2'));
  assert.ok(!q.has('bc-9'));
  assert.ok(await drain(q));
  assert.ok(!q.has('bc-1') && !q.has('bc-2'));
});

await check('the queue announces every move, and ends empty', async () => {
  const { q, job, seen } = harness({ delay: 8 });
  q.add('bc-1', job('bc-1'));
  q.add('bc-2', job('bc-2'));
  assert.ok(await drain(q));
  // Three announcements before the second tap even happens: queued, then on the wire.
  // `pump()` runs as far as the first await synchronously, which is why the second tap
  // already sees bc-1 marked `!`.
  assert.deepEqual(seen[0], ['bc-1'], 'announced on the first tap');
  assert.deepEqual(seen[1], ['bc-1!'], 'and again the moment it went on the wire');
  assert.deepEqual(seen[2], ['bc-1!', 'bc-2'], 'the second tap queues behind the one sending');
  assert.deepEqual(seen[seen.length - 1], [], 'emptied when the last write landed');
});

await check('an empty queue announces nothing and stays idle', async () => {
  const { q, seen } = harness();
  assert.equal(q.size(), 0);
  assert.ok(!q.sending());
  await tick(4);
  assert.deepEqual(seen, [], 'a queue nobody used must not repaint anything');
});

// Honest about what is not covered here: whether the list and the answer box are
// really live while a write is out, whether three cards can be answered without
// waiting, and whether a refused one comes back red and in view are properties of the
// page rather than of this file, and they need a real layout to be worth anything.
// `scripts/absorb-check.mjs` drives the real app.js in headless Chrome for exactly
// that, against a fixture whose /api/respond is deliberately slow.
skip('the list staying answerable mid-write — scripts/absorb-check.mjs');

console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
