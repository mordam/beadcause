/**
 * Reclaim sessions — asking a window whether it is still working, without an iTerm.
 *
 * The button this replaces could not be wrong, because it never claimed anything: it
 * emptied the slot list and that was the whole behaviour. This one makes claims, and
 * every way it can be wrong costs something real:
 *
 * 1. **A slot taken from a session that answered.** The worst failure available here
 *    — an agent three hours into a bead loses its slot to the next launch while it is
 *    still typing. So a window that takes the message keeps its slot, and only the
 *    clock starts.
 * 2. **A stale check-in answering a new question.** The check-in is a file, and a file
 *    from the last round is still there for the next one. If "a file exists" were the
 *    test, a session that hung after checking in once would hold its slot forever.
 * 3. **macOS refusing the Apple event read as "the window is gone".** Then the first
 *    reclaim after a TCC prompt lapses would free every slot in the house.
 * 4. **A check-in that arrives as six lines of prose.** The channel carries newlines now
 *    — `messageSession` pastes and presses Return once — so this is no longer a message
 *    split in half; it is a wall of text landing in a window someone is working in, when
 *    the whole content is one instruction and one command to run. `checkinMessage` closes
 *    it up itself, which is why that is asserted here rather than assumed downstream.
 * 5. **The daemon and the bin disagreeing about where a check-in lives.** The session
 *    answers, the answer lands in a directory nobody reads, and the slot goes anyway.
 *
 * The channel is stubbed — `createAdvocates` takes `say` for exactly this reason. No
 * Apple events, no iTerm, no `bd`. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reclaim-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const STATE = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'advocates.json');

const { createAdvocates, answersCheckin, checkinFileFor } = await import(LIB('advocate.js'));
const { checkinMessage } = await import(LIB('session.js'));

/* ------------------------------------------------------------------ fixtures */

const cfg = {
  workspaces: [{ name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') }],
  advocates: { enabled: true, workspaces: '*', maxWorkers: 3, maxWorkersLimit: 3, checkinMinutes: 10 },
};

/** One worker as `launch` leaves it: a bead, a window handle, nothing asked yet. */
const worker = (id, extra = {}) => ({
  id,
  title: `work on ${id}`,
  at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  dir: path.join(tmp, 'alpha', id),
  attempt: 1,
  claimed: true,
  term: `w0t0p0:${id}`,
  asked: null,
  checkedInAt: null,
  checkinNote: '',
  ...extra,
});

/**
 * Advocates over a persisted state file, with the iTerm channel replaced by a script.
 *
 * `answers` maps a window handle to what saying something to it does: `'sent'`,
 * `'missing'`, or an Error to throw the way a refused Apple event does.
 */
function harness(workers, answers = {}) {
  fs.writeFileSync(STATE, JSON.stringify({ alpha: { workers } }));
  const said = [];
  const events = [];
  const advocates = createAdvocates(cfg, {
    bd: {},
    bus: { emit: (e) => events.push(e) },
    say: async (term, text) => {
      said.push({ term, text });
      const answer = answers[term] ?? 'sent';
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { advocates, said, events };
}

const slots = (advocates) => advocates.snapshot()[0].workers;

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

console.log('\nreclaim sessions\n');

/* ------------------------------------------------------------------- checks */

await check('a window that takes the message keeps its slot', async () => {
  const { advocates, said } = harness([worker('al-1')]);
  await advocates.control('alpha', 'reclaim');
  const [w] = slots(advocates);
  assert.equal(said.length, 1, 'it has to actually be asked');
  assert.equal(said[0].term, 'w0t0p0:al-1');
  assert.ok(w, 'the slot is still held — this is the whole point');
  assert.ok(w.asked, 'and the clock is running on the answer');
});

await check('a window that is gone gives its slot back', async () => {
  const { advocates } = harness([worker('al-1')], { 'w0t0p0:al-1': 'missing' });
  await advocates.control('alpha', 'reclaim');
  assert.deepEqual(slots(advocates), [], 'no window, no slot');
});

await check('macOS refusing the Apple event does not free anything', async () => {
  const refused = Object.assign(new Error('macOS blocked beadcause from controlling iTerm'), { status: 403 });
  const { advocates } = harness([worker('al-1')], { 'w0t0p0:al-1': refused });
  await advocates.control('alpha', 'reclaim');
  const [w] = slots(advocates);
  assert.ok(w, 'a refusal is evidence about iTerm, not about the session');
  assert.equal(w.asked, null, 'and nothing was asked, so no clock starts');
});

await check('each window is asked separately, and only the missing one loses its slot', async () => {
  const { advocates, said } = harness([worker('al-1'), worker('al-2'), worker('al-3')], {
    'w0t0p0:al-2': 'missing',
  });
  await advocates.control('alpha', 'reclaim');
  assert.equal(said.length, 3);
  assert.deepEqual(
    slots(advocates).map((w) => w.id),
    ['al-1', 'al-3']
  );
});

await check('a worker with no window handle is freed, the way the old button did it', async () => {
  const { advocates, said } = harness([worker('al-1', { term: null })]);
  await advocates.control('alpha', 'reclaim');
  assert.deepEqual(said, [], 'there is nothing to address');
  assert.deepEqual(slots(advocates), []);
  // And the card can tell the two apart before you press anything.
  const { advocates: b } = harness([worker('al-9', { term: null })]);
  assert.equal(slots(b)[0].reachable, false);
});

await check('`release` still works — a cached page has not heard the new name', async () => {
  const { advocates, said } = harness([worker('al-1')], { 'w0t0p0:al-1': 'missing' });
  await advocates.control('alpha', 'release');
  assert.equal(said.length, 1, 'the old name must do the new thing, not the old thing');
  assert.deepEqual(slots(advocates), []);
});

await check('an unknown action is still refused', async () => {
  const { advocates } = harness([worker('al-1')]);
  await assert.rejects(() => advocates.control('alpha', 'liberate'), /unknown action/);
});

await check('asking again clears the last answer, so the card cannot show a stale one', async () => {
  const { advocates } = harness([
    worker('al-1', { checkedInAt: new Date(Date.now() - 86400000).toISOString(), checkinNote: 'yesterday' }),
  ]);
  await advocates.control('alpha', 'reclaim');
  const [w] = slots(advocates);
  assert.equal(w.checkedInAt, null);
  assert.equal(w.checkinNote, '');
});

await check('and a check-in left on disk from before the question is wiped with it', async () => {
  fs.mkdirSync(path.dirname(checkinFileFor('alpha', 'al-1')), { recursive: true });
  fs.writeFileSync(checkinFileFor('alpha', 'al-1'), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', note: 'old' }));
  const { advocates } = harness([worker('al-1')]);
  await advocates.control('alpha', 'reclaim');
  assert.equal(fs.existsSync(checkinFileFor('alpha', 'al-1')), false);
});

await check('a check-in older than the question does not answer it', () => {
  const asked = '2026-08-09T12:00:00.000Z';
  assert.equal(answersCheckin(asked, { at: '2026-08-09T11:59:59.000Z' }), false, 'this is failure mode 2');
  assert.equal(answersCheckin(asked, { at: '2026-08-09T12:00:01.000Z' }), true);
  assert.equal(answersCheckin(asked, null), false, 'silence is a no');
  assert.equal(answersCheckin(null, { at: '2026-08-09T12:00:01.000Z' }), false, 'nothing was asked');
});

await check('the check-in file is where the bin will write it', () => {
  const file = checkinFileFor('alpha', 'al-1');
  assert.equal(path.dirname(file), path.join(process.env.BEADCAUSE_CONFIG_DIR, 'workers'));
  assert.ok(file.endsWith('alpha-al-1.checkin'));
  // A workspace or bead id with a path separator in it must not escape the directory.
  assert.equal(path.dirname(checkinFileFor('a/../..', 'x/y')), path.dirname(file));
});

await check('the message is one line, and names the command that answers it', () => {
  const msg = checkinMessage('alpha', 'al-1', 10);
  assert.ok(!/\n/.test(msg), 'the template closes its own newlines up — failure mode 4');
  assert.match(msg, /bin\/checkin\.js -w alpha -i al-1 -m /, 'the answer has to be copy-pasteable');
  assert.match(msg, /BEAD WORK DONE/, 'the other ending is the one already in the brief');
  assert.match(msg, /10 minutes/, 'and it says what silence costs');
});

// What this suite cannot see, and what covers it instead:
// - that iTerm really delivers the line, and that Claude Code accepts it mid-turn:
//   only a real window can show that. It is the one manual step in the feature.
// - that the slot of a silent session is actually taken back after checkinMinutes:
//   that lives in `reconcile`, behind a full `bd` stub and a clock.
skip('iTerm actually delivering the line — needs a real window');
skip('the checkinMinutes deadline expiring in reconcile — needs a bd stub and a clock');

console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
