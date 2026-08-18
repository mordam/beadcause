/**
 * The stray reaper only ever kills the right thing — lib/strays.js, bc-5isv.
 *
 * This is the one sweep in beadcause that signals a process it did not start, so the
 * assertions worth having are almost all *refusals*. A sweep that removes the pile is
 * easy; a sweep that removes the pile and never touches the browser Adam is reading in,
 * or the browser check another session started thirty seconds ago, is the whole job.
 *
 * The four that matter, in the order they would hurt:
 *
 * 1. **Adam's own Chrome is not a match**, and the obvious rule — "an orphaned Chrome" —
 *    matches it. His is `PPID 1`, is a Chrome, and has a `--user-data-dir` in his home
 *    directory; the profile is the only thing that tells them apart, so the profile is
 *    what the rule is written on. The bead's own notes warn about this by pid.
 * 2. **A young Chrome is never signalled and its directory is never removed**, whatever
 *    else is true. That is the age floor, and it is Adam's ruling on this bead.
 * 3. **The sweep does not match itself.** A `ps | grep -- --headless=new` finds its own
 *    `grep` every time, because the pattern is on that process's command line. Anything
 *    reading a process table has this bug until it is asserted against.
 * 4. **A daemon booted by a suite reaps nothing at all.** Twenty-odd suites here start a
 *    real `bin/beadcause.js`, which runs the real cycle; without `mayReap` an `npm test`
 *    would spend its first beat deleting other sessions' directories.
 *
 * Nothing here signals a real process or reads the real process table: `reapChromes`
 * takes the `ps` output and the `kill` as parameters, and the directory half works in a
 * scratch root of its own. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PREFIX,
  DEFAULT_HOURS,
  FLOOR_HOURS,
  sweepMs,
  mayReap,
  elapsedMs,
  executableOf,
  ownedBy,
  parseLine,
  listChromes,
  reapChromes,
  reapTemps,
  reapStrays,
  describeStrays,
} from '../lib/strays.js';
import { NO_LAUNCH, ALLOW_LAUNCH } from '../lib/launchguard.js';
import { cleanupTmp } from './helpers/tmp.mjs';

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-strays-'));

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
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** One `ps -Ao pid=,etime=,args=` line, in the column shape the real one produces. */
const psLine = (pid, etime, args) => `${String(pid).padStart(6)} ${etime.padStart(11)} ${args}`;

/** A headless Chrome command line on `profile`, optionally a `--type=` child. */
const chromeArgs = (profile, type) =>
  `${CHROME} --headless=new --remote-debugging-port=0 --user-data-dir=${profile} --no-first-run` +
  `${type ? ` --type=${type}` : ''} about:blank`;

/* ------------------------------------------------------------------ the ages */

await check('etime parses all three shapes ps produces', () => {
  assert.equal(elapsedMs('05:12'), (5 * 60 + 12) * 1000);
  assert.equal(elapsedMs('02:27:12'), (2 * 3600 + 27 * 60 + 12) * 1000);
  assert.equal(elapsedMs('02-02:24:17'), (2 * 24 * 3600 + 2 * 3600 + 24 * 60 + 17) * 1000);
});

await check('an age it cannot read is not a licence to signal — null, and the caller leaves it alone', () => {
  assert.equal(elapsedMs('Mon 17 Aug 11:09:27 2026'), null);
  assert.equal(elapsedMs(''), null);
  assert.equal(elapsedMs(undefined), null);
  // And that is what the filter actually does with it, not merely what it returns.
  const line = psLine(4242, '??:??', chromeArgs(path.join(tmp, `${PREFIX}old-XXXX`)));
  assert.equal(parseLine(line, { root: tmp })?.ageMs, null);
});

/* ----------------------------------------------------------- what is a match */

await check('a headless Chrome on a beadcause profile in $TMPDIR is a match', () => {
  const profile = path.join(tmp, `${PREFIX}space-AbCdEf`);
  const hit = parseLine(psLine(9160, '1-07:12:00', chromeArgs(profile)), { root: tmp });
  assert.equal(hit.pid, 9160);
  assert.equal(hit.profile, profile);
  assert.equal(hit.owns, profile);
  assert.equal(hit.helper, false);
});

await check("Adam's own Chrome is not a match — the profile is what separates them, not the parent", () => {
  // The real shape: no `--headless`, and a profile in his home directory. Both would have
  // to be wrong for this to match, and the bead's notes say what it costs if it does.
  const his = `${CHROME} --user-data-dir=/Users/adammorgan/Library/Application Support/Google/Chrome`;
  assert.equal(parseLine(psLine(4248, '02-02:24:17', his), { root: tmp }), null);
  // And not even a *headless* Chrome outside $TMPDIR — somebody's own automation.
  const elsewhere = `${CHROME} --headless=new --user-data-dir=/Users/adammorgan/scratch/beadcause-lookalike`;
  assert.equal(parseLine(psLine(4249, '02-02:24:17', elsewhere), { root: tmp }), null);
});

await check('a beadcause-named profile that is not under $TMPDIR is not a match either', () => {
  const outside = path.join(path.dirname(tmp), `${PREFIX}decoy`);
  assert.equal(parseLine(psLine(4250, '1-00:00:00', chromeArgs(outside)), { root: tmp }), null);
});

await check('a directory in $TMPDIR that is not ours is not a match', () => {
  const notours = path.join(tmp, 'someone-elses-profile');
  assert.equal(parseLine(psLine(4251, '1-00:00:00', chromeArgs(notours)), { root: tmp }), null);
});

await check('the sweep does not match itself — a grep carrying the pattern on its own command line', () => {
  const self = `grep -rn --headless=new --user-data-dir=${path.join(tmp, `${PREFIX}x`)} /some/tree`;
  assert.equal(parseLine(psLine(28257, '00:00:01', self), { root: tmp }), null);
  // The executable is what refuses it, and it survives a name with spaces in it.
  assert.equal(executableOf(self), 'grep -rn');
  assert.equal(executableOf(chromeArgs('/x')), CHROME);
});

await check('a profile nested inside a run sandbox is owned by the top-level directory', () => {
  // What scripts/checks.mjs and scripts/test.mjs now produce: one run directory, a
  // per-child TMPDIR inside it, and the Chrome profile inside that.
  const run = path.join(tmp, `${PREFIX}checkrun-QQ`);
  const profile = path.join(run, 'space-check-RR', `${PREFIX}space-SS`);
  const hit = parseLine(psLine(777, '00:30:00', chromeArgs(profile)), { root: tmp });
  assert.equal(hit.profile, profile);
  assert.equal(hit.owns, run, 'the unit removed is the top-level directory, so that is what must be protected');
  assert.equal(ownedBy(tmp, profile), run);
  assert.equal(ownedBy(tmp, path.join(path.dirname(tmp), 'elsewhere')), null);
});

await check('a --type= child is recognised as one, so the browser above it can be signalled first', () => {
  const profile = path.join(tmp, `${PREFIX}space-TT`);
  assert.equal(parseLine(psLine(122, '02:27:12', chromeArgs(profile, 'renderer')), { root: tmp }).helper, true);
});

/* ------------------------------------------------------------- the age floor */

const fakePs = (lines) => async () => lines.join('\n');

await check('only the strays are signalled — a young Chrome is left running', async () => {
  const oldProfile = path.join(tmp, `${PREFIX}space-OLD`);
  const youngProfile = path.join(tmp, `${PREFIX}space-NEW`);
  const signalled = [];
  const out = await reapChromes({
    olderThanMs: 24 * 3600_000,
    root: tmp,
    graceMs: 0,
    ps: fakePs([
      psLine(101, '1-07:12:00', chromeArgs(oldProfile)),
      psLine(202, '00:00:30', chromeArgs(youngProfile)),
    ]),
    signal: (pid, sig) => signalled.push(`${pid}:${sig}`),
  });
  assert.deepEqual(out.killed, [101]);
  assert.ok(signalled.includes('101:SIGTERM'), signalled.join(','));
  assert.ok(!signalled.some((s) => s.startsWith('202:')), `the young one was signalled: ${signalled.join(',')}`);
});

await check("and the young one's directory is held out of the removal pass, however old it looks", async () => {
  const youngProfile = path.join(tmp, `${PREFIX}space-KEEPME`);
  const out = await reapChromes({
    olderThanMs: 24 * 3600_000,
    root: tmp,
    graceMs: 0,
    ps: fakePs([psLine(202, '00:00:30', chromeArgs(youngProfile))]),
    signal: () => {},
  });
  assert.ok(out.keep.has(youngProfile), 'guard 3 — an mtime is a poor proxy for "in use"');
});

await check('SIGKILL follows SIGTERM only for a pid the table still shows', async () => {
  const gone = path.join(tmp, `${PREFIX}space-GONE`);
  const stuck = path.join(tmp, `${PREFIX}space-STUCK`);
  let call = 0;
  const signalled = [];
  await reapChromes({
    olderThanMs: 3600_000,
    root: tmp,
    graceMs: 0,
    // First read sees both; the read after the grace shows only the one that ignored it.
    ps: async () => {
      call += 1;
      return call === 1
        ? [psLine(301, '05:00:00', chromeArgs(gone)), psLine(302, '05:00:00', chromeArgs(stuck))].join('\n')
        : psLine(302, '05:00:00', chromeArgs(stuck));
    },
    // `0` is the liveness probe, not a signal — see `alive`. Answering it for 302 only is
    // how this fixture says "that one is still there and the other is not".
    signal: (pid, sig) => {
      if (sig === 0) {
        if (pid !== 302) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        return;
      }
      signalled.push(`${pid}:${sig}`);
    },
  });
  assert.ok(signalled.includes('302:SIGKILL'), `the one that ignored SIGTERM: ${signalled.join(',')}`);
  assert.ok(!signalled.includes('301:SIGKILL'), `a pid that had already gone was SIGKILLed: ${signalled.join(',')}`);
});

/* --------------------------------------------------------- the directory half */

/** A directory under `root` with a real file in it and an mtime `ageMs` in the past. */
function aged(root, name, ageMs) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deep', 'leaf'), 'x');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
  return dir;
}

await check('directories older than the floor go, and younger ones and other people\'s stay', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const stale = aged(root, `${PREFIX}claims-AAA`, 48 * 3600_000);
  const fresh = aged(root, `${PREFIX}claims-BBB`, 60_000);
  const theirs = aged(root, 'someone-else-CCC', 48 * 3600_000);
  const out = await reapTemps({ olderThanMs: 24 * 3600_000, root });
  assert.equal(out.removed, 1, JSON.stringify(out));
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true, 'the age floor is the whole safety margin');
  assert.equal(fs.existsSync(theirs), true, 'only directories this program names are ever touched');
});

await check('a directory a live Chrome is on is never removed, however old it is', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const held = aged(root, `${PREFIX}space-HELD`, 96 * 3600_000);
  const out = await reapTemps({ olderThanMs: 24 * 3600_000, root, keep: new Set([held]) });
  assert.equal(out.removed, 0);
  assert.equal(fs.existsSync(held), true);
});

await check('the cap is reported rather than swallowed — a truncated pass never reads as a whole one', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  for (let i = 0; i < 5; i += 1) aged(root, `${PREFIX}quiet-${i}`, 48 * 3600_000);
  const out = await reapTemps({ olderThanMs: 24 * 3600_000, root, max: 2 });
  assert.equal(out.removed, 2);
  assert.equal(out.remaining, 3);
  assert.ok(describeStrays({ hours: 24, killed: [], refused: [], ...out }).includes('3 more'));
});

await check('a $TMPDIR that is not there at all is an answer, not a throw', async () => {
  const out = await reapTemps({ olderThanMs: 1, root: path.join(tmp, 'no-such-root') });
  assert.deepEqual(out, { removed: 0, failed: 0, remaining: 0 });
});

await check('one pass kills first and removes second, so nothing is removed under a live browser', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const strayProfile = aged(root, `${PREFIX}space-STRAY`, 48 * 3600_000);
  const liveProfile = aged(root, `${PREFIX}space-LIVE`, 48 * 3600_000);
  const signalled = [];
  const out = await reapStrays({
    olderThanMs: 24 * 3600_000,
    root,
    graceMs: 0,
    ps: fakePs([
      psLine(401, '2-00:00:00', chromeArgs(strayProfile)),
      // Old directory, *young process* — the check somebody started a minute ago in a
      // sandbox made hours earlier. Neither half of the sweep may touch it.
      psLine(402, '00:01:00', chromeArgs(liveProfile)),
    ]),
    signal: (pid, sig) => signalled.push(`${pid}:${sig}`),
  });
  assert.deepEqual(out.killed, [401]);
  assert.equal(fs.existsSync(strayProfile), false, "the stray's profile went with it");
  assert.equal(fs.existsSync(liveProfile), true, 'the live one kept both its process and its directory');
  assert.ok(!signalled.some((s) => s.startsWith('402:')));
});

/* ------------------------------------------------------------- the two gates */

await check('strayHours: unset is a day, small numbers are raised to the floor, 0 is off', () => {
  assert.equal(sweepMs({}), DEFAULT_HOURS * 3600_000);
  assert.equal(sweepMs({ strayHours: 48 }), 48 * 3600_000);
  assert.equal(sweepMs({ strayHours: 0.001 }), FLOOR_HOURS * 3600_000, 'a disk decision may not lower the safety floor');
  assert.equal(sweepMs({ strayHours: 0 }), 0);
  assert.equal(sweepMs({ strayHours: -5 }), 0);
  assert.equal(sweepMs({ strayHours: 'nonsense' }), 0);
});

await check('a daemon booted by a suite reaps nothing — both layers, and ALLOW_LAUNCH does not open it', () => {
  const daemon = ['/usr/local/bin/node', '/Users/x/beadcause/bin/beadcause.js'];
  assert.equal(mayReap({}, daemon), true);
  // Layer 2: the env var scripts/test.mjs sets, which is the only thing that can see a
  // suite that started a *daemon* — its argv[1] is bin/beadcause.js and looks like this.
  assert.equal(mayReap({ [NO_LAUNCH]: '1' }, daemon), false);
  // Layer 1: a suite run directly, with no runner above it to have set anything.
  assert.equal(mayReap({}, ['/usr/local/bin/node', '/Users/x/beadcause/test/filter.mjs']), false);
  // And the window opener's opt-out is not an opt-out of this: there is no stub in front
  // of process.kill.
  assert.equal(mayReap({ [NO_LAUNCH]: '1', [ALLOW_LAUNCH]: '1' }, daemon), false);
});

/* ------------------------------------------------------------------ the line */

await check('a settled machine says nothing at all', () => {
  assert.equal(describeStrays({ hours: 24, killed: [], refused: [], removed: 0, failed: 0, remaining: 0 }), '');
  assert.equal(describeStrays(null), '');
});

await check('and a pass that did something says what, and how old it had to be', () => {
  const line = describeStrays({ hours: 24, killed: [1, 2], refused: [], removed: 7, failed: 0, remaining: 0 });
  assert.ok(line.includes('killed 2'), line);
  assert.ok(line.includes('removed 7'), line);
  assert.ok(line.includes('24h'), line);
});

/* ------------------------------------------------------- the real process table */

await check('the real ps is readable and answers with the shape the parser expects', async () => {
  // Read-only, and deliberately the real one: a parser proven only against fixtures is a
  // parser proven against its author's idea of `ps`. Nothing is signalled here.
  const found = await listChromes();
  assert.ok(Array.isArray(found));
  for (const c of found) {
    assert.equal(typeof c.pid, 'number');
    assert.ok(c.pid > 1, 'never pid 1');
    assert.ok(path.basename(c.owns).startsWith(PREFIX), c.owns);
  }
});

/* -------------------------------------------------------------------- the end */

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
