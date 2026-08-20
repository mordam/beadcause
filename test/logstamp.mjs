#!/usr/bin/env node
/**
 * Every line the daemon writes carries the time it wrote it — bc-zjab.4.
 *
 *     npm test
 *     node test/logstamp.mjs
 *
 * The question this whole change exists to make answerable is an ORDERING one, and it
 * is the question the suite is built around: given two lines out of
 * `~/Library/Logs/beadcause.log`, can you tell which came first and how far apart? Two
 * sessions failed to close bc-zjab's central question — did a tick's survey run before
 * or after the `planned` label landed — because the log recorded both events in order
 * and stamped neither, and line order alone cannot separate "recovered on the next
 * tick" from "recovered four hours later". So `two lines are orderable and measurable`
 * below is the headline check, and it does it against a real subprocess rather than
 * against the wrapper in-process, because the wrapper being right is not the claim.
 *
 * The rest are the ways this could do harm rather than good:
 *
 * - **Content must be otherwise unchanged.** Greps and line-number citations into this
 *   log are already written into beads, notes and suites — test/reassignguard.mjs
 *   quotes a refusal verbatim, test/closeverify.mjs cites line 42283 — so the fixture
 *   here is real log lines and the check is that everything after the prefix is
 *   byte-identical, and that one line in gives exactly one line out.
 * - **`--url` must not be stamped.** `BASE_URL=$(node bin/beadcause.js --url)` in
 *   scripts/build-android.sh, and the same shape in scripts/install.sh. A stamp there is
 *   an address nothing resolves, and it would break the Android build rather than the
 *   log. This is the one check worth running against the real binary.
 * - **Nothing may be stamped twice.** A line carrying two timestamps reads as a broken
 *   clock, and the router re-enters plenty.
 *
 * Multi-line output and blank lines are decisions rather than discoveries, argued in
 * lib/logstamp.js's header; they are pinned here so a later "tidy-up" has to argue back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installLogStamp, uninstallLogStamp, isDaemonEntry, stampLines, stampOf } from '../lib/logstamp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

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

/** The shape a stamp has to have to be sortable as text and unambiguous about UTC. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

/**
 * A console that records instead of printing, so a check can read what a line came out
 * as. The wrapper installs over the *methods* of whatever object it is handed, which is
 * what makes this possible without touching the real streams.
 */
const recorder = () => {
  const lines = [];
  const push = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  return { lines, log: push, info: push, warn: push, error: push, debug: push };
};

// ------------------------------------------------------------------ the format

{
  const s = stampOf(new Date(Date.UTC(2026, 7, 18, 22, 41, 3, 512)));
  if (s === '2026-08-18T22:41:03.512Z') ok('the stamp is ISO 8601 in UTC, to the millisecond');
  else bad('the stamp is ISO 8601 in UTC, to the millisecond', `got ${JSON.stringify(s)}`);

  // Sortable as plain text is the property that makes `sort` on this file mean
  // something — and it is exactly the property a local wall clock loses twice a year.
  const early = stampOf(new Date(Date.UTC(2026, 7, 18, 22, 41, 3, 512)));
  const late = stampOf(new Date(Date.UTC(2026, 7, 18, 22, 41, 3, 513)));
  if ([late, early].sort().join('|') === `${early}|${late}`) ok('stamps sort chronologically as plain strings');
  else bad('stamps sort chronologically as plain strings', `${early} vs ${late}`);
}

// ------------------------------------------------- content is otherwise unchanged

{
  // Verbatim from ~/Library/Logs/beadcause.log — the shapes the bead quotes, plus the
  // two prefixes every line in the file actually starts with.
  const REAL = [
    '[advocate] opened a session on bc-y3qk.3 in /Users/adammorgan/neadamthal.projects/beadcause (auto, opus (unrated), attempt 1)',
    '[bd] claimed bc-y3qk for neadamthal@gmail.com — a window here has it open (pid 74048)',
    '[router] supervising /Users/adammorgan/neadamthal.projects/beadcause/bin/beadcause.js',
    '[beadcause] tls         certificate renewed, 89 days left',
  ];
  const stamp = '2026-08-18T22:41:03.512Z';
  let clean = true;
  for (const line of REAL) {
    const out = stampLines(line, stamp);
    if (out.split('\n').length !== 1) {
      clean = false;
      bad('one line in, one line out', JSON.stringify(out));
      break;
    }
    if (!out.startsWith(`${stamp} `) || out.slice(stamp.length + 1) !== line) {
      clean = false;
      bad('a real log line survives byte-identical after the prefix', JSON.stringify(out));
      break;
    }
  }
  if (clean) ok('real log lines are prefixed and otherwise byte-identical, one line in one line out');

  // The grep that is already written down keeps working. This is not a formality: the
  // README tells you to run it, and a stamp that anchored or reflowed would break it.
  const stamped = REAL.map((l) => stampLines(l, stamp));
  if (stamped.filter((l) => l.includes('claimed bc-y3qk')).length === 1) ok('an existing unanchored grep still matches');
  else bad('an existing unanchored grep still matches', stamped.join('\n'));
}

// ------------------------------------------------------- multi-line and blank lines

{
  const stamp = '2026-08-18T22:41:03.512Z';

  // Every line, continuations included. An unstamped continuation is the exact failure
  // being fixed: you grep for a phrase, land on a line, and it has no time.
  const banner = stampLines('first\nsecond\nthird', stamp);
  const lines = banner.split('\n');
  if (lines.length === 3 && lines.every((l) => STAMP.test(l))) ok('every line of a multi-line write is stamped, continuations included');
  else bad('every line of a multi-line write is stamped', JSON.stringify(banner));

  // A blank line stays blank — stamping it would turn a separator into content and
  // push every banner's shape around for a timestamp that orders nothing.
  const spaced = stampLines('head\n\ntail\n', stamp);
  const parts = spaced.split('\n');
  if (parts[1] === '' && parts[3] === '' && STAMP.test(parts[0]) && STAMP.test(parts[2])) {
    ok('blank lines and a trailing newline are left blank');
  } else {
    bad('blank lines and a trailing newline are left blank', JSON.stringify(spaced));
  }

  if (stampLines('', stamp) === '') ok('an empty write stays empty');
  else bad('an empty write stays empty', JSON.stringify(stampLines('', stamp)));
}

// -------------------------------------------------------------- the wrapper itself

{
  const c = recorder();
  const installed = installLogStamp({ console: c, now: () => new Date(Date.UTC(2026, 7, 18, 22, 41, 3, 512)) });
  try {
    c.log('through log');
    c.error('through error');
    c.warn('through warn');
    const every = c.lines.length === 3 && c.lines.every((l) => STAMP.test(l));
    if (installed && every) ok('log, warn and error all come out stamped');
    else bad('log, warn and error all come out stamped', c.lines.join(' | '));

    // Only the first argument is prefixed — a later one is joined with a space by the
    // console and never begins a line, so stamping it would put a time mid-sentence.
    c.lines.length = 0;
    c.log('%s claimed', 'bc-y3qk');
    if (c.lines[0] === '2026-08-18T22:41:03.512Z %s claimed bc-y3qk') ok('only the first argument is prefixed');
    else bad('only the first argument is prefixed', JSON.stringify(c.lines[0]));

    // A bare console.log() is a separator and stays one.
    c.lines.length = 0;
    c.log();
    if (c.lines[0] === '') ok('a bare console.log() is still a blank line');
    else bad('a bare console.log() is still a blank line', JSON.stringify(c.lines[0]));

    // The second install must be a no-op. Two stamps on one line reads as a broken
    // clock, and the router restarts backends and re-enters enough for this to matter.
    const again = installLogStamp({ console: c, now: () => new Date(Date.UTC(2026, 7, 18, 22, 41, 3, 512)) });
    c.lines.length = 0;
    c.log('once only');
    const twice = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \d{4}-/.test(c.lines[0]);
    if (again === false && !twice) ok('installing twice stamps once');
    else bad('installing twice stamps once', `second install returned ${again}: ${JSON.stringify(c.lines[0])}`);
  } finally {
    uninstallLogStamp();
  }

  // Uninstall has to put the methods back, not merely clear the flag — a suite that
  // leaves a wrapper on the real console poisons every suite after it in the runner.
  c.lines.length = 0;
  c.log('bare again');
  if (c.lines[0] === 'bare again') ok('uninstall restores the original console methods');
  else bad('uninstall restores the original console methods', JSON.stringify(c.lines[0]));
}

// --------------------------------------------- the headline: order, and how far apart

{
  // In a real subprocess, through the real module, over a real interval. The claim is
  // not "the wrapper prefixes strings" — it is "you can settle an ordering question off
  // this file", and that needs two lines written at two different times and parsed back.
  const GAP_MS = 60;
  const script = `
    import { installLogStamp } from ${JSON.stringify(path.join(ROOT, 'lib', 'logstamp.js'))};
    installLogStamp();
    console.log('[advocate] surveying');
    await new Promise((r) => setTimeout(r, ${GAP_MS}));
    console.error('[bd] planned label landed on bc-zjab');
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  const out = `${run.stdout || ''}${run.stderr || ''}`
    .split('\n')
    .filter((l) => l.trim() !== '');

  const times = out.map((l) => (STAMP.test(l) ? Date.parse(l.slice(0, 24)) : NaN));
  if (out.length === 2 && times.every((t) => Number.isFinite(t))) {
    // Which came first: the survey line is the earlier stamp, and it is the earlier
    // stamp *whichever stream it came out on* — which is the half line order cannot do,
    // because stdout and stderr are two pipes into one file.
    const ordered = times[0] <= times[1];
    // How far apart: the gap is real and measured, not inferred from line numbers.
    // A busy Mac can add to it; nothing can take it away.
    const gap = times[1] - times[0];
    if (ordered && gap >= GAP_MS - 5) ok(`two lines are orderable and measurable (${gap}ms apart, ${GAP_MS}ms slept)`);
    else bad('two lines are orderable and measurable', `ordered=${ordered} gap=${gap}ms from ${out.join(' | ')}`);
  } else {
    bad('two lines are orderable and measurable', `unparseable output: ${JSON.stringify(out)} (status ${run.status})`);
  }
}

// ------------------------------------------------- the two bins, for real

{
  // The one that would break a build rather than a log. `--url` is command-substituted
  // in scripts/build-android.sh; a stamp in front of it is an address nothing resolves.
  //
  // The URL is the LAST line rather than the only one, and that is not this change's
  // doing: lib/resolvers.js announces restored windows on stdout at module load, so on
  // a Mac whose previous daemon left resolver windows behind, `--url` has always had a
  // line in front of it. Filed separately — here the claim is only that nothing this
  // process prints in this mode is stamped.
  const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'beadcause.js'), '--url'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  const lines = (run.stdout || '').split('\n').filter((l) => l.trim() !== '');
  const url = lines[lines.length - 1] || '';
  if (url.startsWith('http') && !lines.some((l) => STAMP.test(l))) ok('`beadcause.js --url` prints a bare URL, unstamped');
  else bad('`beadcause.js --url` prints a bare URL, unstamped', `status ${run.status}: ${JSON.stringify(lines)} ${run.stderr || ''}`);
}

{
  // `--status` is a human's terminal. It is read-only whether or not a router answers,
  // and either answer — the status block, or "no router answering" — must be plain.
  const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'router.js'), '--status'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  const lines = `${run.stdout || ''}${run.stderr || ''}`.split('\n').filter((l) => l.trim() !== '');
  if (lines.length && !lines.some((l) => STAMP.test(l))) ok('`router.js --status` prints plain lines, unstamped');
  else bad('`router.js --status` prints plain lines, unstamped', JSON.stringify(lines.slice(0, 3)));
}

{
  // The predicate, in both directions, because everything above rides on it. A suite,
  // a script or another bin importing lib/logstamp.js must install nothing — otherwise
  // this very file could not test the wrapper — and a console mode must install nothing
  // even from the right entry point.
  const entry = (rel, ...flags) => [process.execPath, path.join(ROOT, rel), ...flags];
  const cases = [
    [entry('bin/router.js'), true, 'the router installs'],
    [entry('bin/beadcause.js', '--port', '4319', '--standby'), true, 'a spawned backend installs'],
    [entry('bin/beadcause.js', '--url'), false, '`--url` does not'],
    [entry('bin/beadcause.js', '--qr'), false, '`--qr` does not'],
    [entry('bin/router.js', '--status'), false, '`--status` does not'],
    [entry('bin/router.js', '--swap'), false, '`--swap` does not'],
    [entry('bin/deliver.js'), false, 'another bin does not'],
    [entry('test/logstamp.mjs'), false, 'a suite does not'],
    [[process.execPath, '/elsewhere/bin/router.js'], false, 'a router.js outside this repo does not'],
  ];
  let wrong = null;
  for (const [argv, want, what] of cases) {
    if (isDaemonEntry(argv, ROOT) !== want) wrong = what;
  }
  if (!wrong) ok('only the two daemon entry points install, and never in a console mode');
  else bad('only the two daemon entry points install, and never in a console mode', `wrong for: ${wrong}`);
}

{
  // The wiring, because every check above passes just as well if the bins never imported
  // it. It has to be the FIRST import in each: lib/resolvers.js prints while it is being
  // evaluated, so an install ordered after it would arrive too late to stamp that line.
  for (const rel of ['bin/router.js', 'bin/beadcause.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const first = src.match(/^import .*$/m)?.[0] || '';
    if (first === "import '../lib/logstamp.js';") ok(`${rel} imports lib/logstamp.js before anything else`);
    else bad(`${rel} imports lib/logstamp.js before anything else`, `first import is ${JSON.stringify(first)}`);
  }
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
