#!/usr/bin/env node
/**
 * The release sweep's account of its own silence — bc-68ou.8.
 *
 *     npm test
 *     node test/releasegap.mjs
 *
 * On 2026-08-14 the release sweep filed nothing for roughly three hours while eight
 * pull requests merged, and then caught the whole backlog up in a single pass. The
 * mechanism was fine. What was missing was any way to *notice*, and there were two
 * separate holes:
 *
 * 1. **`sweepRelease` returned silently on `board.unavailable`.** Every other outcome of
 *    a sweep gets a log line; the one that means "no sweep happened at all" got none, so
 *    a board that would not collect for three hours read exactly like three quiet hours.
 * 2. **`~/.config/beadcause/releases.json` recorded only what was *found*.** It is the
 *    file the gap was diagnosed from, and it could not distinguish a sweep that found
 *    nothing from a sweep that never ran — which is why the diagnosis took a log and a
 *    guess rather than a timestamp. And the gap spanned six daemon restarts, so nothing
 *    held in the poller's own memory could have seen across it either.
 *
 * So: a heartbeat written on every completed pass, whether or not anything changed, and
 * a small stateful voice that turns a run of skipped sweeps into three lines — the first
 * one, a nag while it goes on, and a recovery naming what it cost. The shape is a storm
 * rather than a tick on purpose: `gh` being absent is a legitimate permanent state on a
 * machine that never installed it, and a line every five minutes forever would be the
 * same silence by other means.
 *
 * Nothing here reaches the network, a tracker of yours, or a real config directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-releasegap-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the ledger this file is about lives under it.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const {
  LEDGER_PATH,
  SWEEP_KEY,
  SWEEP_NAG_MS,
  anyArmed,
  lastSweptAt,
  loadLedger,
  sinceWords,
  sweepReleases,
  sweepVoice,
} = await import(LIB('release.js'));

const MINUTE = 60_000;
const EVERY = 5 * MINUTE;

/* ============================================================ the words for a gap */

console.log('\nhow long it has been, in the words a log line can use\n');

await check(() => assert.equal(sinceWords(0), '0 seconds'), 'no time at all is still a duration');
await check(() => assert.equal(sinceWords(1000), '1 second'), 'one second is singular');
await check(() => assert.equal(sinceWords(45_000), '45 seconds'), 'under a minute and a half stays in seconds');
await check(() => assert.equal(sinceWords(12 * MINUTE), '12 minutes'), 'minutes past that');
await check(() => assert.equal(sinceWords(184 * MINUTE), '3.1 hours'), 'and hours to one decimal past ninety minutes');
await check(() => assert.equal(sinceWords(60 * MINUTE), '60 minutes'), 'an hour is still minutes — the crossover is 90, not 60');

/* ====================================================== a board that will not collect */

console.log('\na sweep that could not collect the board says so\n');

{
  const t0 = Date.UTC(2026, 7, 14, 6, 0, 0);
  const voice = sweepVoice();

  const first = voice.skipped('gh is not installed', { at: t0 });
  await check(() => assert.equal(first.length, 1), 'the first skip of a run is one line');
  await check(() => assert.match(first[0], /unavailable/), 'and it says the board is unavailable');
  await check(() => assert.match(first[0], /gh is not installed/), 'carrying the reason it was given');
  await check(
    () => assert.match(first[0], /filed, armed or shipped/),
    'and what the skip actually costs, which is the part nothing else in the log will mention'
  );

  await check(
    () => assert.deepEqual(voice.skipped('gh is not installed', { at: t0 + 5 * MINUTE }), []),
    'the next sweep says nothing — a line every five minutes forever is the same silence by other means'
  );
  await check(
    () => assert.deepEqual(voice.skipped('gh is not installed', { at: t0 + SWEEP_NAG_MS - 1 }), []),
    'and nothing right up to the nag window'
  );

  const nag = voice.skipped('gh is not installed', { at: t0 + SWEEP_NAG_MS + MINUTE });
  await check(() => assert.equal(nag.length, 1), 'past it, it says so again');
  await check(() => assert.match(nag[0], /still skipping after 31 minutes/), 'naming how long the run has gone on');
  await check(() => assert.match(nag[0], /4 attempts/), 'and how many sweeps it has cost, which is the four it has seen');

  const back = voice.ran({ at: t0 + 40 * MINUTE, since: 40 * MINUTE, every: EVERY });
  await check(() => assert.equal(back.length, 1), 'the sweep that finally collects says the board is back');
  await check(() => assert.match(back[0], /readable again after 40 minutes/), 'naming how long it was out');
  await check(() => assert.match(back[0], /4 sweeps skipped/), 'and what it cost, so the catch-up burst that follows reads as one');
  await check(
    () => assert.doesNotMatch(back[0], /last completed sweep/),
    'and not the lateness line as well — one gap is one fault, however many sentences could describe it'
  );

  await check(
    () => assert.deepEqual(voice.ran({ at: t0 + 45 * MINUTE, since: EVERY, every: EVERY }), []),
    'an ordinary sweep after that is silent again — the run is over and is not re-reported'
  );

  const again = voice.skipped('gh auth expired', { at: t0 + 50 * MINUTE });
  await check(() => assert.equal(again.length, 1), 'and a fresh outage is fresh news rather than a continuation of the old one');
}

/* ======================================================= a sweep that is simply late */

console.log('\na sweep that ran, but long after it should have\n');

{
  const voice = sweepVoice();
  await check(
    () => assert.deepEqual(voice.ran({ since: 2 * EVERY, every: EVERY }), []),
    'a sweep one interval late is ordinary — a cycle ahead of it ran long, and nothing is wrong'
  );
  const late = voice.ran({ since: 184 * MINUTE, every: EVERY });
  await check(() => assert.equal(late.length, 1), 'three hours late is a line');
  await check(() => assert.match(late[0], /3\.1 hours since the last completed sweep/), 'naming the gap');
  await check(() => assert.match(late[0], /5 minutes cadence/), 'and the cadence it is measured against');
  await check(
    () => assert.match(late[0], /did not deploy itself when it landed/),
    'and what it meant, which is the sentence bc-68ou exists to be able to say'
  );
  await check(
    () => assert.deepEqual(voice.ran({ since: null, every: EVERY }), []),
    'a first run has no gap to report and says nothing — an empty ledger is not a fault'
  );
  await check(
    () => assert.deepEqual(voice.ran({ since: 10 * 60 * MINUTE, every: 0 }), []),
    'and with no cadence to compare against it stays quiet rather than guessing one'
  );
}

/* ============================================================ the durable heartbeat */

console.log('\nthe ledger records that a sweep happened, not only what it found\n');

const CFG = {
  workspaces: [{ name: 'demo', dir: path.join(tmp, 'beads-demo') }],
  release: { beads: true },
};

/** A tracker nothing here asks anything of — the boards below carry no repos. */
const bd = {
  listLabel: async () => [],
  create: async () => 'zz-1',
  close: async () => {},
  update: async () => {},
};

const EMPTY = { repos: [] };

fs.rmSync(LEDGER_PATH, { force: true });

{
  const t0 = Date.UTC(2026, 7, 14, 6, 0, 0);
  const first = await sweepReleases(bd, CFG, EMPTY, { deploys: [], now: t0 });

  await check(
    () => assert.equal(first.since, null),
    'the first sweep ever reports no gap — there is no previous pass to measure from'
  );
  await check(
    () => assert.ok(fs.existsSync(LEDGER_PATH)),
    'and it writes the ledger even though it found nothing, which is the whole change'
  );
  await check(
    () => assert.equal(loadLedger()[SWEEP_KEY].at, new Date(t0).toISOString()),
    'the heartbeat is the sweep’s own clock, stamped where nothing else in the file writes'
  );
  await check(() => assert.equal(lastSweptAt(loadLedger()), t0), 'and reads back as a number');
  await check(() => assert.equal(lastSweptAt({}), null), 'an empty ledger has never been swept');
  await check(() => assert.equal(lastSweptAt({ [SWEEP_KEY]: { at: 'whenever' } }), null), 'and so has one whose stamp is not a date');

  const later = await sweepReleases(bd, CFG, EMPTY, { deploys: [], now: t0 + 184 * MINUTE });
  await check(
    () => assert.equal(later.since, 184 * MINUTE),
    'the next sweep reports the gap since the last one — the number nobody could get on the morning this was filed'
  );
  await check(
    () => assert.equal(lastSweptAt(loadLedger()), t0 + 184 * MINUTE),
    'and the heartbeat moves on, so the gap is measured from the last pass rather than the first'
  );

  await check(
    () => assert.equal(anyArmed(loadLedger()), false),
    'the heartbeat is not a workspace: the sweep’s own clock reads as nothing armed'
  );
  await check(
    () => assert.equal(anyArmed({ ...loadLedger(), demo: { armedAt: new Date(t0).toISOString() } }), true),
    'and a real armed window beside it still reads as armed'
  );
}

/* -------------------------------------------------- and it survives the daemon dying */

{
  // The gap bc-68ou.8 is about spanned six restarts. A timestamp in the poller's memory
  // could not have seen across one of them; this one is on disk, so a process that has
  // never swept anything still knows when the last one did.
  const stamped = lastSweptAt(loadLedger());
  const fresh = await sweepReleases(bd, CFG, EMPTY, { deploys: [], now: stamped + 7 * MINUTE });
  await check(
    () => assert.equal(fresh.since, 7 * MINUTE),
    'a sweep in a process that has never swept before still measures from the file, not from its own boot'
  );
}

/* ----------------------------------------------- a sweep that did not happen has no gap */

{
  const off = await sweepReleases(bd, { ...CFG, release: { beads: false } }, EMPTY, { deploys: [] });
  await check(
    () => assert.equal(off.since, null),
    'filing switched off is a sweep that did not happen, so it reports no gap and stamps no heartbeat'
  );
}

/* ================================================================== the wiring itself */

console.log('\nand lib/server.js actually says it\n');

const server = fs.readFileSync(path.join(HERE, '..', 'lib', 'server.js'), 'utf8');

await check(
  () => assert.doesNotMatch(server, /if \(board\.unavailable\) return;/),
  'the silent `return` on an uncollectable board is gone from the release sweep'
);
await check(
  () => assert.match(server, /releaseVoice\.skipped\(board\.unavailable\)/),
  'the skip goes through the voice instead'
);
await check(
  () => assert.match(server, /releaseVoice\.ran\(\{ since: out\.since, every: slowEvery\(\) \}\)/),
  'and a sweep that ran is handed the gap the ledger measured, against the *ordinary* cadence — ' +
    'the armed one is thirty seconds, and measuring against that would call every settle window late'
);

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
