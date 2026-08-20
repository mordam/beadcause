/**
 * A bead this advocate has given up on says so — on the note and on the card.
 *
 * bc-xl7n.111. `candidates` will not offer a bead whose attempt counter has reached
 * `maxAttemptsPerBead`, and nothing ever decrements that counter: it is cleared on the
 * four endings that are not failures — closed, delivered, handed back, stood down — and
 * on nothing else. So two windows that die without reaching one of them retire the bead
 * from this machine's queue permanently, and every surface there is goes on drawing it as
 * ordinary available work: open, unclaimed, no label, in `bd ready`, counted in the
 * advocate's own queue number.
 *
 * The only line that ever mentioned the state welded it to a thirty-second settle —
 * `3 ready · 3 settling or already tried` — and named no ids. bc-xl7n.37 was read as
 * healthy by five consecutive Epic Advocate passes on the strength of it, and the reading
 * was reasonable every time, because the Mac genuinely was at its worker limit. It cost
 * that bead a committed, passing, never-pushed test suite: its second window had the work
 * on disk when it died, and there is no third.
 *
 * Four claims, and the last two are what keep the first two honest:
 *
 *   - **a bead at the cap is named**, in the note, with its id — not folded into
 *     `settling`, which is now only what really does clear itself;
 *   - **and it is on the card**, as its own list with the attempt count attached, because
 *     the cure (`Forget attempts`) clears *every* counter and pressing it blind is the
 *     reason it went unpressed;
 *   - **and the note says so on a tick that is opening windows too**, because a tick that
 *     launches two sessions beside a bead retired for ever looks exactly like a tick that
 *     launches two sessions;
 *   - **and a bead one attempt short of the cap is not named**, and still gets its window.
 *     A filter that reported every bead that had ever failed would be a pill nobody reads.
 *
 *     node test/givenup.mjs
 *
 * Built on test/livequeue.mjs's harness: `open` is injected, so a tick that would have
 * opened an iTerm window pushes a bead id onto an array instead, and `prs` is injected,
 * so nothing here needs a `gh` on PATH. The attempt counters are seeded into the
 * `advocates.json` the record is built from, which is where the daemon's own live ones
 * are — that is the file bc-xl7n.111 was diagnosed by reading, by hand.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { cleanupTmp, quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-givenup-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const REPO = path.join(tmp, 'projects', 'alpha');
const SESSIONS = path.join(tmp, 'claude-sessions');
fs.mkdirSync(REPO, { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });

const MONITOR = fs.readFileSync(path.join(HERE, '..', 'public', 'monitor.js'), 'utf8');

const { createAdvocates } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, title, over = {}) => ({
  id,
  title,
  priority: 2,
  issue_type: 'task',
  created_at: OLD,
  ...over,
});

/**
 * One tick, over a tracker that says what the case needs it to.
 *
 * `attempts` is written into `advocates.json` *before* the advocates are created, which
 * is the only way to stage a counter without running two ticks' worth of failed launches
 * — and it is the same file the daemon persists its own into, so a fixture that passes
 * here is one that would hold against the live state.
 */
async function tick({ ready = [], attempts = {}, workers = [], overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // `quiesce` + `removeTree` rather than a bare recursive `rmSync`: every write of
  // `advocates.json` schedules a common-repo commit 2000ms out whose `git init` lands in
  // `CONFIG_DIR`, and rmdir on a directory that gained a file since it was read is
  // ENOTEMPTY. test/tmpadoption.mjs fails the repo for the bare form (bc-9d37.9).
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    sessionDirs: { alpha: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Other features with their own suites, each of which would otherwise run real git,
      // a real `gh` or a real agent against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      sessionLog: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { attempts, workers } }, null, 2));

  const opened = [];
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => [],
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
  });
  await advocates.tick();
  return { opened, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

const goneIds = (card) => (card.givenUp || []).map((g) => g.id);

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
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/* ------------------------------------------------------------------ the cases */

/** The incident, in the smallest queue that can hold it. */
await check('a bead at the attempt cap is named in the note', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'Cover the three bin entry points no suite imports')],
    attempts: { 'x-1': 2 },
  });

  assert.deepEqual(opened, [], 'no window — 2 < 2 is false, and will stay false');
  assert.equal(card.queue, 1, 'and it is still in the queue, which is what made it invisible');
  assert.match(card.note, /given up on/, card.note);
  assert.match(card.note, /x-1/, `the id is the whole point — ${card.note}`);
  assert.doesNotMatch(card.note, /1 settling/, `not folded into settling — ${card.note}`);
});

/** And the card carries it as a list, because the cure clears every counter at once. */
await check('and the card carries it, with the attempt count on it', async () => {
  const { card } = await tick({ ready: [bead('x-1', 'a')], attempts: { 'x-1': 2 } });

  assert.deepEqual(goneIds(card), ['x-1'], 'a list, not a number');
  assert.equal(card.givenUp[0].attempts, 2, 'the count travels');
  assert.equal(card.givenUp[0].title, 'a', 'and the title, so the button can name it');
  assert.equal(card.attemptCap, 2, 'and the cap, so the card need not hardcode it');
  assert.match(card.givenUp[0].why, /Forget attempts/, card.givenUp[0].why);
});

/**
 * The case the old line could never have reported: a tick that is opening a window
 * anyway. Nothing about the shape of it says a second bead has been retired for ever, and
 * the launching note is the only line written on a tick like this one.
 */
await check('it is said on a tick that is opening sessions too', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'retired'), bead('x-2', 'fine')],
    attempts: { 'x-1': 2 },
  });

  assert.deepEqual(opened, ['x-2'], 'the healthy bead still gets its window');
  assert.match(card.note, /opening 1 session/, card.note);
  assert.match(card.note, /1 given up on after 2 attempt\(s\) \(x-1\)/, card.note);
  assert.deepEqual(goneIds(card), ['x-1']);
});

/** One attempt short of the cap is not given up on, and still gets its window. */
await check('a bead with one attempt left is neither named nor held', async () => {
  const { opened, card } = await tick({ ready: [bead('x-1', 'a')], attempts: { 'x-1': 1 } });

  assert.deepEqual(opened, ['x-1'], 'attempt 2 is still owed to it');
  assert.deepEqual(goneIds(card), []);
  assert.doesNotMatch(card.note, /given up/, card.note);
});

/** A queue with nothing at the cap says nothing about it at all. */
await check('an ordinary queue draws none of this', async () => {
  const { opened, card } = await tick({ ready: [bead('x-1', 'a')] });

  assert.deepEqual(opened, ['x-1']);
  assert.deepEqual(card.givenUp, []);
  assert.doesNotMatch(card.note, /given up/, card.note);
});

/**
 * The cap is config, not a constant, so the sentence has to quote what is in force. A
 * card that said "after 2 attempts" over a `maxAttemptsPerBead` of 4 would send whoever
 * read it to the wrong knob.
 */
await check('the cap in the sentence is the cap in force', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a')],
    attempts: { 'x-1': 2 },
    overrides: { maxAttemptsPerBead: 4 },
  });

  assert.deepEqual(opened, ['x-1'], 'two attempts of four leaves two');
  assert.deepEqual(goneIds(card), []);
  assert.equal(card.attemptCap, 4);
});

/**
 * And the one bead the filter must not name: one this advocate has a window open on
 * right now. Its counter is incremented at the launch and cleared at the ending, so it is
 * at the cap for as long as the window is up — and reporting that as given up on would
 * name the single case where another window is the last thing anybody wants.
 */
await check('a bead with a window open on it is not given up on', async () => {
  const { card } = await tick({
    ready: [bead('x-1', 'a')],
    attempts: { 'x-1': 2 },
    // This process's own pid, which is the only one a test can be sure is alive: the
    // worker sweep resolves it before the note is written, and a made-up number would be
    // reaped first and the case would pass for the wrong reason.
    workers: [{ id: 'x-1', title: 'a', at: new Date().toISOString(), pid: process.pid, attempt: 2, claimed: true }],
  });

  assert.equal(card.workers.length, 1, 'the window survived the sweep, or this case proves nothing');
  assert.deepEqual(goneIds(card), [], 'a live window is not a bead nobody will come back to');
  assert.doesNotMatch(card.note, /given up/, card.note);
});

/* --------------------------------------------------- the card, in a room of its own */

/**
 * `public/monitor.js` for real, with the handful of things it touches stubbed — the shape
 * test/spacecard.mjs worked out and test/heldsubcard.mjs uses for this same page. A source
 * read could confirm the strings and still miss the pill landing on a card the payload
 * does not reach, which is the half that matters here: the whole complaint is that the
 * state was true and nothing drew it.
 */
async function drawConsole(payload) {
  const node = () => ({
    innerHTML: '',
    textContent: '',
    title: '',
    className: '',
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const nodes = { mon: node(), pulse: node(), tally: node(), observing: node(), refresh: node() };
  const store = { 'beadcause.token': 'tok', 'beadcause.mon.open': JSON.stringify([]) };
  const ctx = vm.createContext({
    window: {
      beadcause: {
        space: { filter: { space: 'All' }, matches: () => true, label: () => 'All', adopt() {}, onChange() {} },
      },
    },
    document: { getElementById: (id) => nodes[id] || null, addEventListener() {}, activeElement: null },
    location: { search: '', pathname: '/monitor', hash: '' },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k) => store[k] ?? null,
      setItem(k, v) {
        store[k] = v;
      },
    },
    URLSearchParams,
    JSON,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (url) => {
      const body = url.startsWith('/api/work')
        ? payload
        : url.startsWith('/api/questions')
          ? { questions: [] }
          : url.startsWith('/api/prs')
            ? { prs: [] }
            : {};
      return { ok: true, status: 200, json: async () => body };
    },
  });
  vm.runInContext(MONITOR, ctx, { filename: 'monitor.js' });
  // The boot is async and the IIFE hands nothing back, so settle on the stubs' own
  // microtasks. Bounded rather than timed: nothing here waits on a clock.
  for (let i = 0; i < 80; i += 1) await new Promise((r) => setImmediate(r));
  return nodes.mon.innerHTML;
}

/** One advocate card's payload, with only the fields it reads. */
const card = (over = {}) => ({
  workspace: 'alpha',
  workers: [],
  epicAdvocates: [],
  limit: 2,
  epicLimit: 2,
  queue: 1,
  closing: [],
  parked: [],
  paused: false,
  surveying: false,
  archive: null,
  attemptCap: 2,
  givenUp: [],
  lastSurveyAt: '2026-08-17T12:00:00Z',
  ...over,
});

const payloadFor = (a) => ({
  workspaces: [{ name: 'alpha', working: [], sessions: [], counts: {} }],
  advocates: [a],
  roster: [],
  observing: false,
});

await check('the card draws it as a pill, with the beads in the tooltip', async () => {
  const html = await drawConsole(
    payloadFor(
      card({
        givenUp: [
          { id: 'x-1', title: 'Cover the bin entry points', attempts: 2, why: '2 window(s) ended without delivering' },
        ],
      })
    )
  );

  assert.match(html, /given up on after 2 attempts/, 'the pill says how many and after how many windows');
  assert.match(html, /1 given up on/, 'and how many beads');
  assert.match(html, /x-1 — 2 window\(s\) ended without delivering/, 'and the tooltip names each one');
});

/**
 * The other half, and the one bc-xl7n.111 is really about: the button that fixes this has
 * been on the card since the counter existed, and nothing ever told it what it would be
 * clearing. `forget` empties every counter at once, so a press without the list also
 * re-arms a bead that really does break every window it gets.
 */
await check('the Forget attempts button carries the count and the list', async () => {
  const html = await drawConsole(
    payloadFor(card({ givenUp: [{ id: 'x-1', title: 'a bead', attempts: 2, why: 'gave up' }] }))
  );

  assert.match(html, /Forget attempts \(1\)/, 'the count is the subject the control never had');
  assert.match(html, /Right now that is:/, 'and the tooltip lists them');
  assert.match(html, /x-1 — a bead \(2\)/, 'by id, title and attempts');
});

/** And an advocate that has given up on nothing draws neither, as it always did. */
await check('an advocate that has given up on nothing draws neither', async () => {
  const html = await drawConsole(payloadFor(card()));

  assert.doesNotMatch(html, /given up on after/, 'no pill');
  assert.match(html, /Forget attempts</, 'the button is still there, with no count on it');
  assert.match(html, /It has not given up on anything/, 'and says so rather than staying blank');
});

/* ---------------------------------------------------------------------- done */

await quiesce();
await cleanupTmp(tmp);
console.log(failures ? `\n${failures} of ${ran} checks failed` : `\nall ${ran} checks passed`);
process.exit(failures ? 1 : 0);
