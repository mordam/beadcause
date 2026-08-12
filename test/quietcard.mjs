#!/usr/bin/env node
/**
 * "Arrived quietly" on the card — and which kind of quiet it was.
 *
 *     npm test
 *     node test/quietcard.mjs
 *
 * `quietReasonFor` has answered `'filtered'` or `'muted'` for a while — and `'addressed'`
 * since bc-cvwk, for a question somebody else was asked — and until now only the
 * daemon's log and the Android logcat line read the answer. On screen a card the filter
 * hid and a card a mute quietened were the same card, and both were the same card as one
 * that rang while you were asleep. Four things are worth a suite, and none of them is
 * visible by reading one function:
 *
 * 1. **The reason has to be recorded, not recomputed.** This is the whole design and
 *    it is the one part a reasonable refactor would undo — "why keep state when
 *    `quietReasonFor` is right there" is a sensible-sounding question with a wrong
 *    answer. Recomputed, the filtered half reads `null` at exactly the moment the
 *    card is on screen (you can see it *because* the filter is wide enough now), and
 *    the muted half changes its mind at 09:00. The check drives the real poller with
 *    a real filter and then asserts the record survived on disk.
 *
 * 2. **A bead that rang must carry nothing.** The failure to keep out is a card
 *    claiming a silence that never happened — that would make every one of these
 *    lines unbelievable, which is worse than not drawing them.
 *
 * 3. **The record has to reach the card, through both fetches.** The list row and the
 *    detail fetch that merges over it when the card opens: `answeredBefore` was
 *    dropped by exactly that merge once, and an open card that loses the line has
 *    lost it at the moment you are reading most carefully.
 *
 * 4. **A record whose reason cannot be named reads as no record.** The acceptance
 *    criterion is that the card says *which*; a card that says "this was quiet" and
 *    stops is the half-drawn state the 🔕 on the space chip is already in, and a
 *    half-written state file must not produce one.
 *
 * The client half is a static read of public/app.js and public/style.css. The card
 * renderer needs the whole inbox document to run, so what is checked is what a
 * refactor actually breaks silently: that the render reads the field at all, that
 * both reasons are named in words, and that the class it draws has a rule.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-quietcard-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
};

const { loadState, saveState } = await import(LIB('config.js'));
const { arrivedQuiet, quietArrival, retainQuiet } = await import(LIB('hushed.js'));

console.log('arrived quietly — which kind of quiet it was');

/* ------------------------------------------------------------- the record itself */

const NOW = new Date('2026-08-11T09:00:00Z');

check('a filtered arrival keeps the filter as it stood, because by now it has moved', () => {
  const rec = quietArrival('filtered', { space: 'Personal' }, { space: 'Work', workspace: 'acme' }, NOW);
  assert.equal(rec.reason, 'filtered');
  assert.equal(rec.at, NOW.toISOString());
  assert.equal(rec.space, 'Personal');
  assert.equal(rec.filter, 'Work / acme');
});

check('a muted arrival names the space, and does not name a filter it matched', () => {
  const rec = quietArrival('muted', { space: 'Work' }, { space: 'all', workspace: 'all' }, NOW);
  assert.equal(rec.reason, 'muted');
  assert.equal(rec.space, 'Work');
  assert.equal(rec.filter, null);
});

check('a bead in no configured space still records — it just has no space to name', () => {
  const rec = quietArrival('filtered', { space: null }, { space: 'Work', workspace: 'all' }, NOW);
  assert.equal(rec.space, null);
  assert.equal(rec.filter, 'Work');
});

check('nothing recorded reads as "it made a noise"', () => {
  assert.equal(arrivedQuiet({}, 'bc/never'), null);
  assert.equal(arrivedQuiet(null, 'bc/never'), null);
  assert.equal(arrivedQuiet(undefined, 'bc/never'), null);
});

check('a record whose reason cannot be named reads as no record at all', () => {
  // The point of criterion 4: the card's job is to say *which*, so a reason this
  // version cannot name must not produce an unexplained "this was quiet".
  assert.equal(arrivedQuiet({ 'bc/x': { reason: 'because', at: NOW.toISOString() } }, 'bc/x'), null);
  assert.equal(arrivedQuiet({ 'bc/x': { at: NOW.toISOString() } }, 'bc/x'), null);
  assert.equal(arrivedQuiet({ 'bc/x': 'filtered' }, 'bc/x'), null);
  assert.equal(arrivedQuiet({ 'bc/x': ['filtered'] }, 'bc/x'), null);
  assert.equal(arrivedQuiet({ 'bc/x': null }, 'bc/x'), null);
});

check('a half-written record keeps the reason and loses only the fields it lacks', () => {
  assert.deepEqual(arrivedQuiet({ 'bc/x': { reason: 'muted', at: 7, space: {}, filter: 3, for: 'bob' } }, 'bc/x'), {
    reason: 'muted',
    at: null,
    space: null,
    filter: null,
    for: null,
  });
});

check('an addressed arrival names who was asked, and nothing else does', () => {
  // The third reason (bc-cvwk). It is the only one whose explanation is a *person*, so
  // it is the only one that keeps `for` — and a record written before it existed reads
  // as null rather than as an empty list, so the card says the short sentence instead
  // of a longer one with a hole in it.
  const rec = quietArrival('addressed', { space: 'Work', addressees: ['carol@example.com'] }, { space: 'all', workspace: 'all' }, NOW);
  assert.deepEqual(rec.for, ['carol@example.com']);
  assert.equal(rec.filter, null, 'the filter is not what hid it');
  assert.deepEqual(arrivedQuiet({ 'bc/x': rec }, 'bc/x').for, ['carol@example.com']);
  assert.equal(quietArrival('muted', { space: 'Work', addressees: ['carol@example.com'] }, { space: 'all', workspace: 'all' }, NOW).for, null);
  assert.equal(arrivedQuiet({ 'bc/x': { reason: 'addressed', at: NOW.toISOString() } }, 'bc/x').for, null);
});

check('a bead that has left the inbox has nothing left to tell', () => {
  const map = { 'bc/here': { reason: 'muted' }, 'bc/gone': { reason: 'filtered' } };
  assert.deepEqual(Object.keys(retainQuiet(map, new Set(['bc/here']))), ['bc/here']);
  assert.deepEqual(retainQuiet(map, []), {});
  assert.deepEqual(retainQuiet(null, ['bc/here']), {});
});

/* -------------------------------------------------- the state file, both directions */

check('a junk quiet map reads as nothing quiet rather than throwing', () => {
  saveState({ quiet: {} });
  fs.writeFileSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'state.json'), '{"quiet": "nope"}');
  assert.deepEqual(loadState().quiet, {});
  fs.writeFileSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'state.json'), '{"quiet": ["nope"]}');
  assert.deepEqual(loadState().quiet, {});
});

check('and writing it does not clobber the rest of the file, nor the reverse', () => {
  saveState({ notified: [], commentCounts: {}, quiet: {} });
  saveState({ quiet: { 'bc/x': { reason: 'muted', at: NOW.toISOString() } } });
  saveState({ notified: ['bc/x'], commentCounts: { 'bc/x': 1 } });
  const s = loadState();
  assert.deepEqual(s.notified, ['bc/x'], 'notified');
  assert.equal(s.quiet['bc/x']?.reason, 'muted', 'quiet survived the poll write');
});

/* --------------------------------------- the poller, for real: recorded and not recorded */
//
// The real `tick`, the real reconciliation, a real filter written to disk the way a
// phone would have left it. Two fresh beads, one inside the filter and one outside,
// and afterwards the disk has to be able to tell them apart.

const { startPoller, createApp, listen } = await import(LIB('server.js'));
const { createEventBus } = await import(LIB('events.js'));

const q = (workspace, space, id) => ({
  key: `${workspace}/${id}`,
  workspace,
  space,
  id,
  title: `${id} in ${workspace}`,
  question: `${id} in ${workspace}`,
  priority: 2,
});

const pollCfg = {
  baseUrl: 'http://127.0.0.1',
  token: 'quietcard-token',
  actor: 'beadcause-test',
  workspaces: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }],
  spaces: [
    { name: 'Work', workspaces: ['alpha'] },
    { name: 'Personal', workspaces: ['beta'] },
    // Muted outright, so its bead is quiet while matching the filter — the other half
    // of the pair, and the only way to prove the two reasons are told apart end to end.
    { name: 'Evening', workspaces: ['gamma'], muted: true },
  ],
  pollSeconds: 5,
  autoDispatch: false,
  ntfy: { enabled: false },
};

// Filtered to Work, which holds alpha and not beta. Written before the poller starts,
// exactly as a phone would have left it.
//
// Two sweeps are needed rather than one, and the reason is the feature: a single
// filter cannot produce all three outcomes at once, because "quiet because the filter
// excluded it" and "quiet because its space is muted" require the filter to exclude
// one bead and admit another whose space is muted, and a filter admits either one
// space or all of them. So the filter is narrow for the first sweep and wide for the
// second — which is exactly the gesture the acceptance criterion is about, and lets
// the second sweep assert the first sweep's record is still there afterwards.
saveState({
  notified: [],
  commentCounts: {},
  quiet: {},
  ringing: {},
  filter: { space: 'Work', workspace: 'all' },
});

let inbox = [];
const bus = createEventBus();
const timer = startPoller(pollCfg, {
  bus,
  hooks: {},
  bd: { comments: async () => [], removeLabel: async () => {} },
  allQuestions: async () => inbox,
});

const settled = async (fn, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const seen = (key) => (bus.since(0) || []).some((e) => e.type === 'question' && e.key === key);

// The first cycle is the baseline sweep: it pushes nothing and records nothing by
// design. Wait for it before moving the fixture underneath it.
await settled(() => loadState().notified.length === 0 && bus.seq === 0);
await new Promise((r) => setTimeout(r, 100));

/* sweep one — narrowed to Work */
inbox = [q('alpha', 'Work', 'a-loud'), q('beta', 'Personal', 'b-filtered')];
const arrivedFirst = await settled(() => seen('alpha/a-loud') && seen('beta/b-filtered'));
await settled(() => Boolean(loadState().quiet['beta/b-filtered']), 5000);
const narrow = loadState();

check('both beads arrive on the narrowed sweep — quiet quietens, it never drops', () => {
  assert.ok(arrivedFirst, `two question events (saw ${(bus.since(0) || []).map((e) => e.key).join(', ')})`);
});

check('the bead the filter hid is recorded as filtered, with the filter it was hidden by', () => {
  const rec = arrivedQuiet(narrow.quiet, 'beta/b-filtered');
  assert.ok(rec, `recorded (quiet map: ${JSON.stringify(narrow.quiet)})`);
  assert.equal(rec.reason, 'filtered');
  assert.equal(rec.filter, 'Work');
  assert.equal(rec.space, 'Personal');
  assert.ok(rec.at, 'with when it arrived');
});

check('the bead that rang carries nothing — no card may claim a silence that never happened', () => {
  assert.equal(arrivedQuiet(narrow.quiet, 'alpha/a-loud'), null);
  assert.ok(narrow.ringing['alpha/a-loud'], 'it is in `ringing` instead');
  assert.equal(narrow.ringing['beta/b-filtered'], undefined, 'and the quiet one is not');
});

/* sweep two — the filter widened, which is the gesture this is all for */
saveState({ filter: { space: 'all', workspace: 'all' } });
inbox = [...inbox, q('gamma', 'Evening', 'g-muted')];
const arrivedMuted = await settled(() => seen('gamma/g-muted'));
await settled(() => Boolean(loadState().quiet['gamma/g-muted']), 5000);
clearInterval(timer);
const wide = loadState();

check('the bead a mute quietened is recorded as muted, naming the space', () => {
  assert.ok(arrivedMuted, 'the muted bead arrived');
  const rec = arrivedQuiet(wide.quiet, 'gamma/g-muted');
  assert.ok(rec, `recorded (quiet map: ${JSON.stringify(wide.quiet)})`);
  assert.equal(rec.reason, 'muted');
  assert.equal(rec.space, 'Evening');
  // A muted bead matched the filter, so there is no filter to blame for it.
  assert.equal(rec.filter, null);
});

check('and widening the filter does not make the bead it was hiding read as a new arrival', () => {
  // The criterion this whole feature is for. The record is written at the arrival and
  // survives the filter moving off it — recomputing the reason here would answer
  // `null`, because the filter that hid it is the filter you have just widened.
  const rec = arrivedQuiet(wide.quiet, 'beta/b-filtered');
  assert.ok(rec, `still recorded after the widen (quiet map: ${JSON.stringify(wide.quiet)})`);
  assert.equal(rec.reason, 'filtered');
  assert.equal(rec.filter, 'Work', 'and still says what it was hidden by, not what the filter is now');
});

/* ------------------------------------------- and it reaches the card, through both fetches */

const WS = { name: 'bc', dir: path.join(tmp, 'ws') };
fs.mkdirSync(path.join(WS.dir, '.beads'), { recursive: true });
const BIN = path.join(tmp, 'bd');
fs.writeFileSync(
  BIN,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const bead = {
  id: 'bc-ss7',
  issue_type: 'task',
  status: 'open',
  title: 'Say on the card which kind of quiet it was',
  priority: 3,
  labels: ['human'],
  comment_count: 0,
  dependencies: [],
  description: 'a question',
};
if (args[0] === 'human' && args[1] === 'list') { process.stdout.write(JSON.stringify([bead])); process.exit(0); }
if (args[0] === 'show') { process.stdout.write(JSON.stringify([bead])); process.exit(0); }
process.stdout.write('[]');
process.exit(0);
`,
  { mode: 0o755 }
);

const httpCfg = {
  host: '127.0.0.1',
  port: 0,
  baseUrl: 'http://127.0.0.1',
  token: 'quietcard-token',
  actor: 'beadcause',
  bdBin: BIN,
  workspaces: [WS],
  spaces: [],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  terminal: false,
  pollSeconds: 3600,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(httpCfg);
const servers = listen(httpCfg, app.handler);
const httpPort = await boundPort(servers);
const call = async (pathname) => {
  const res = await fetch(`http://127.0.0.1:${httpPort}${pathname}`, {
    headers: { 'x-beadcause-token': httpCfg.token },
  });
  return { status: res.status, body: await res.json() };
};

try {
  saveState({ quiet: {}, filter: { space: 'all', workspace: 'all' } });
  const loud = await call('/api/questions');
  check('a card that rang arrives with the field null, exactly as it always did', () => {
    const row = loud.body.questions.find((r) => r.id === 'bc-ss7');
    assert.ok(row, `the bead is in the inbox (saw ${JSON.stringify(loud.body.questions.map((r) => r.id))})`);
    assert.equal(row.arrivedQuiet, null);
  });

  saveState({
    quiet: { 'bc/bc-ss7': { reason: 'filtered', at: NOW.toISOString(), space: 'Personal', filter: 'Work / acme' } },
  });
  const quiet = await call('/api/questions');
  check('and a card that arrived quietly carries the reason on the list row', () => {
    const row = quiet.body.questions.find((r) => r.id === 'bc-ss7');
    assert.ok(row, 'the bead is in the inbox');
    assert.equal(row.arrivedQuiet?.reason, 'filtered', JSON.stringify(row.arrivedQuiet));
    assert.equal(row.arrivedQuiet?.filter, 'Work / acme');
  });

  const detail = await call('/api/question?workspace=bc&id=bc-ss7');
  check('the detail fetch carries it too, so opening the card does not lose the line', () => {
    assert.equal(detail.status, 200, detail.body?.error || '');
    assert.equal(detail.body.arrivedQuiet?.reason, 'filtered', JSON.stringify(detail.body.arrivedQuiet));
  });
} finally {
  servers.forEach((s) => s.close());
}

/* ------------------------------------------------------ the client half, statically */

const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

check('the card render reads the field the server now sends', () => {
  assert.match(appJs, /q\.arrivedQuiet/, 'public/app.js never reads q.arrivedQuiet');
  assert.match(appJs, /\$\{arrivedQuietHtml\(q\)\}/, 'the card template never calls arrivedQuietHtml');
});

check('and it says which of the three kinds it was, in words', () => {
  assert.match(appJs, /'muted'/, "the render never branches on 'muted'");
  assert.match(appJs, /was muted/, 'no sentence naming the mute');
  assert.match(appJs, /hidden by the inbox filter/, 'no sentence naming the filter');
  // The third (bc-cvwk), and the one whose sentence has to name a person: an addressed
  // question is on somebody else's phone, and a card that said only "arrived quietly"
  // would send you to widen a filter that was never hiding it.
  assert.match(appJs, /'addressed'/, "the render never branches on 'addressed'");
  assert.match(appJs, /asked of /, 'no sentence naming who the question was for');
  // The fact that stops a widened filter reading as a rush of new arrivals.
  assert.match(appJs, /Arrived quietly/, 'the line never says the arrival was quiet');
});

check('the class it draws has a rule, so the line is not an unstyled paragraph', () => {
  assert.match(css, /^\.quiet-note \{/m, 'public/style.css has no .quiet-note rule');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
