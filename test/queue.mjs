/**
 * What happens to words typed while a turn is still running.
 *
 * The composer on both chat surfaces now stays live for the whole turn, and the
 * thing that makes that safe rather than merely permissive is `public/sendqueue.js`:
 * a message said mid-turn is held, shown, and delivered when the turn lands. Every
 * way that can go wrong is silent from the outside — a message that was queued and
 * never sent looks exactly like one you forgot to type, and a message sent twice
 * looks like the agent repeating itself.
 *
 * So this covers the queue and nothing above it:
 *
 * - typing while a turn runs queues instead of delivering, and delivers on the turn
 *   ending — the whole feature;
 * - two messages queued during one turn arrive as **one** delivery, because two
 *   `claude -p` runs back to back would answer the first without knowing the second
 *   exists;
 * - a refused delivery (the server's 409 stands — nothing here bypasses it) puts the
 *   words back rather than dropping them, and does not spin: it retries a bounded
 *   number of times and then waits for the next turn to end;
 * - a queued message can be pulled back out to be edited, or dropped;
 * - an idle repaint does not re-send anything — `sync` acts on the falling edge, and
 *   getting that wrong would deliver the same words on every render.
 *
 * The browser half — that the textarea is really enabled and the send button really
 * tappable mid-turn — is `scripts/queue-check.mjs`, which needs Chrome. This suite
 * stays pure Node. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'public', 'sendqueue.js');

/**
 * Load the real browser file.
 *
 * Through a vm context with nothing in it but a `window`, deliberately: this is the
 * file the phone runs, and a copy of its logic rewritten as a module would pass this
 * suite while the page shipped something else.
 */
function loadQueue() {
  const ctx = vm.createContext({ window: {}, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'sendqueue.js' });
  return ctx.window.beadcause.sendQueue;
}

const sendQueue = loadQueue();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the console: it records what was delivered, and can be told to
 * refuse the way the server does mid-turn.
 */
function harness({ refuse = 0 } = {}) {
  const sent = [];
  const errors = [];
  const seen = [];
  let toRefuse = refuse;
  const q = sendQueue.create({
    deliver: async (text) => {
      if (toRefuse > 0) {
        toRefuse -= 1;
        throw Object.assign(new Error('this console is already working on a turn'), { status: 409 });
      }
      sent.push(text);
    },
    // `Array.from` rather than `.map`: everything the queue hands back was built
    // inside the vm realm, and an array from over there is never deep-equal to one
    // from here however identical it looks.
    onChange: (items) => seen.push(Array.from(items, (i) => i.text)),
    onError: (err, info) => errors.push({ message: err.message, ...info }),
  });
  return { q, sent, errors, seen };
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

console.log('\nsend queue\n');

/* ------------------------------------------------------------------- checks */

await check('with nothing running, saying something delivers it', async () => {
  const { q, sent } = harness();
  q.say('one bead for the importer');
  await tick();
  assert.deepEqual(sent, ['one bead for the importer']);
  assert.equal(q.size(), 0);
});

await check('mid-turn it is queued, not delivered', async () => {
  const { q, sent } = harness();
  q.sync(true);
  q.say('and one for the exporter');
  await tick();
  assert.deepEqual(sent, [], 'nothing may be pushed into a running turn');
  assert.equal(q.size(), 1);
  assert.deepEqual(Array.from(q.list(), (i) => i.text), ['and one for the exporter']);
});

await check('and it goes when the turn lands', async () => {
  const { q, sent } = harness();
  q.sync(true);
  q.say('and one for the exporter');
  q.sync(false);
  await tick();
  assert.deepEqual(sent, ['and one for the exporter']);
  assert.equal(q.size(), 0);
});

await check('two queued during one turn arrive as one turn', async () => {
  const { q, sent } = harness();
  q.sync(true);
  q.say('first thought');
  q.say('second thought');
  await tick();
  q.sync(false);
  await tick();
  assert.equal(sent.length, 1, `one delivery, got ${sent.length}: ${JSON.stringify(sent)}`);
  assert.equal(sent[0], 'first thought\n\nsecond thought');
});

await check('an idle repaint does not re-send anything', async () => {
  const { q, sent } = harness();
  q.say('the only thing I said');
  await tick();
  for (let i = 0; i < 5; i++) q.sync(false); // what a render loop does
  await tick();
  assert.deepEqual(sent, ['the only thing I said']);
});

await check('nothing is sent while the composer only holds blank space', async () => {
  const { q, sent } = harness();
  assert.equal(q.say('   \n  '), null);
  await tick();
  assert.deepEqual(sent, []);
  assert.equal(q.size(), 0);
});

await check('a queued message can be taken back to be edited', async () => {
  const { q, sent } = harness();
  q.sync(true);
  const entry = q.say('teh exporter');
  assert.equal(q.take(entry.ref), 'teh exporter');
  assert.equal(q.size(), 0, 'taking it out is what puts it in the composer');
  q.say('the exporter');
  q.sync(false);
  await tick();
  assert.deepEqual(sent, ['the exporter']);
});

await check('or dropped outright', async () => {
  const { q, sent } = harness();
  q.sync(true);
  const entry = q.say('never mind');
  assert.equal(q.remove(entry.ref), true);
  assert.equal(q.remove(entry.ref), false, 'removing it twice is not an error, and is not a resend');
  q.sync(false);
  await tick();
  assert.deepEqual(sent, []);
});

await check('a refused delivery keeps the words and retries', async () => {
  const { q, sent, errors } = harness({ refuse: 1 });
  q.say('said into a race');
  await tick();
  assert.deepEqual(sent, [], 'the 409 stands — nothing bypasses it');
  assert.equal(q.size(), 1, 'and the words are still here');
  assert.equal(errors[0].willRetry, true);
  // The retry is on a timer inside the queue, so this is the one place a wait is
  // the thing being tested rather than a way of letting a promise settle.
  await tick(3200);
  assert.deepEqual(sent, ['said into a race']);
  assert.equal(q.size(), 0);
});

await check('a delivery that keeps failing gives up rather than spinning', async () => {
  const { q, sent, errors } = harness({ refuse: 99 });
  q.say('into a wall');
  await tick(12000);
  assert.deepEqual(sent, []);
  assert.equal(q.size(), 1, 'still held — it is on screen, and can be taken back');
  assert.equal(errors.length, 4, `four attempts, got ${errors.length}`);
  assert.equal(errors[errors.length - 1].willRetry, false, 'the last one says so');
});

await check('and the next turn ending is a fresh reason to try', async () => {
  const { q, sent } = harness({ refuse: 4 });
  q.say('into a wall, then not');
  await tick(12000);
  assert.deepEqual(sent, [], 'four refusals, four attempts, still queued');
  q.sync(true);
  q.sync(false);
  await tick();
  assert.deepEqual(sent, ['into a wall, then not']);
});

await check('the queue reports itself, so a screen can draw it', async () => {
  const { q, seen } = harness();
  q.sync(true);
  q.say('one');
  q.say('two');
  q.sync(false);
  await tick();
  assert.deepEqual(seen[0], ['one']);
  assert.deepEqual(seen[1], ['one', 'two']);
  assert.deepEqual(seen[seen.length - 1], [], 'emptied on delivery, so the strip hides itself');
});

// Honest about what is not covered here: whether the textarea and the send button
// are actually usable mid-turn is a property of the two pages, not of this file, and
// it needs a real layout to be worth anything. `scripts/queue-check.mjs` drives the
// real console.js in headless Chrome for exactly that.
skip('the composer staying live on screen — scripts/queue-check.mjs');

console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
