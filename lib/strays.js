/**
 * The headless Chromes and scratch directories that outlived the run that made them.
 *
 * Every browser check (`scripts/*-check.mjs`) and most test suites make a
 * directory under `$TMPDIR` named `beadcause-<something>-XXXXXX`, and the browser checks
 * hand one of those to Chrome as a `--user-data-dir`. Both are removed in a `finally`,
 * and a `finally` covers exactly one of the three ways a run can end. It does not cover
 * `SIGTERM` — which is how `scripts/checks.mjs` ends a check that overran its timeout,
 * and how a shell ends a run somebody walked away from — and it does not cover `SIGKILL`
 * at all. When that happens Chrome is reparented to launchd and goes on running forever,
 * because nothing about a headless Chrome makes it notice that whoever asked for it has
 * gone.
 *
 * Measured on this Mac on 2026-08-15 (bc-5isv): **15 orphaned processes and 9,324
 * `beadcause-*` directories totalling 15.38 GB** — essentially the whole of `$TMPDIR`.
 * Measured again on 2026-08-17, after a hand sweep had already removed 1,907 of them:
 * **13,458 directories, 7,922 of them over a day old, and 18 headless Chromes, four of
 * which had been running since the 13th.** Nothing bounds this but macOS's own periodic
 * purge, which is why it reached the size of the disk it is on.
 *
 * ## Two halves, and this is the second one
 *
 * The first half is not being the thing that leaks: `scripts/helpers/chrome.mjs` now
 * takes its Chrome and its profile with it when the check process dies for *any*
 * catchable reason, and `scripts/test.mjs` gives each suite a `TMPDIR` of its own and
 * removes it from the parent when the suite exits, so a suite that never cleaned up
 * cannot leave anything behind. Between them, a run that fails or is interrupted stops
 * adding to the pile.
 *
 * This file is the other half: what earlier runs already stranded, and what a `SIGKILL`
 * — the one signal nothing can catch — will still strand tomorrow. It runs on the
 * daemon's slow clock (see `sweepStrays` in lib/server.js) and it is deliberately dull.
 *
 * ## Everything here is about not killing the wrong thing
 *
 * A signal is the one act in beadcause with no undo, and the target came out of a
 * process table that also contains the browser Adam is reading this in. Three guards,
 * and the first is the one that matters:
 *
 * 1. **Age.** Nothing under `strayHours` — a day, by default — is touched, ever. That is
 *    the whole safety margin and it is Adam's own ruling on this bead: a check another
 *    session started thirty seconds ago is indistinguishable from a check that was
 *    abandoned thirty seconds ago, and the only thing that tells them apart is waiting.
 *    Three such processes were observed finishing normally between two measurements one
 *    afternoon. No real run lasts a day; every orphan does.
 * 2. **The profile, not the process name.** A match needs `--headless=new` *and* a
 *    `--user-data-dir` under a top-level `beadcause-` directory in `$TMPDIR` *and* an
 *    executable whose own name contains "chrom". Adam's own Chrome (pid 4248 at the time
 *    of the measurement) is `PPID 1` and is a Chrome, so "orphaned Chrome" — the obvious
 *    rule, and the one the incident report warned against in the bead's notes — matches
 *    it. This rule cannot: his profile is in his home directory.
 * 3. **A directory a live Chrome is using is never removed**, whatever its age. The
 *    profiles of *every* matching Chrome are collected, including the young ones this
 *    sweep is leaving alone, and held out of the directory pass. An `mtime` is a poor
 *    proxy for "in use" and this costs nothing.
 *
 * ## What it does not do
 *
 * It does not touch the orphaned `bin/beadcause.js` fixture daemons that two of the
 * checks leave behind the same way. That is a real leak — one was found alongside the
 * Chromes — but a daemon is not identifiable the way a Chrome is: the live daemon and
 * the live router are the same program, and a rule broad enough to catch the fixture is
 * broad enough to catch the thing reading this. Those two checks now register their own
 * `onExit` for the daemon they started (lib/teardown.js), which is the fix that does not
 * require identifying anything from the outside.
 *
 * It also does not report bytes freed. A `du` over eight thousand trees costs more than
 * removing them, and the count is the number that says whether this is working.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NO_LAUNCH, startedByASuite } from './launchguard.js';

const run = promisify(execFile);

/** Every scratch directory this program makes is named for it. Nothing else is touched. */
export const PREFIX = 'beadcause-';

/** The default age floor, in hours — see guard 1 in the header. */
export const DEFAULT_HOURS = 24;

/**
 * The lowest age floor that can be configured, in hours.
 *
 * An hour, not zero. Lowering this is not a preference, it is removing the only thing
 * that distinguishes an orphan from a run in progress, and a sweep with no floor would
 * kill the browser check of whichever session happened to be mid-flight when the daemon's
 * clock came round. `strayHours: 0` switches the sweep **off** instead, which is the
 * honest way to disable it — the same shape `slowRequestMs` uses.
 */
export const FLOOR_HOURS = 1;

/** How many directories one pass will remove before leaving the rest for the next one. */
export const MAX_PER_PASS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `strayHours` as milliseconds, or `0` for "do not sweep".
 *
 * Unset is the default rather than off, because the pile this exists for accumulated on
 * a machine where nobody had opted into anything. A number between zero and the floor is
 * raised to the floor rather than honoured or rejected: it is a disk decision written in
 * the place a safety decision lives, and see `FLOOR_HOURS`.
 */
export function sweepMs(cfg = {}) {
  const raw = cfg?.strayHours;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_HOURS * 3600_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(n, FLOOR_HOURS) * 3600_000;
}

/**
 * May this process reap anything at all? **No, if it is a test.**
 *
 * Twenty-odd suites boot a real `bin/beadcause.js`, and a daemon booted by a suite runs
 * the same cycle the real one does — so without this, `npm test` would spend its first
 * beat killing processes and deleting directories belonging to the other sessions sharing
 * this Mac. That is not a hypothetical: it took `test/filter.mjs` from green to eight
 * failures the first time this sweep was wired in, because a beat that a suite is waiting
 * on went away to remove two thousand directories.
 *
 * The predicate is lib/launchguard.js's, for its reason: `argv[1]` catches a suite run
 * directly with no runner above it, and `BEADCAUSE_NO_LAUNCH` catches the case `argv[1]`
 * cannot see — a suite that starts a *daemon*, whose `argv[1]` is `bin/beadcause.js` and
 * looks like production from the inside. Both, because neither is the guarantee alone.
 *
 * `BEADCAUSE_ALLOW_LAUNCH` is deliberately **not** honoured here, unlike in `mayLaunch`.
 * That variable means "a stub AppleScript is in front of the window opener", which is a
 * statement about windows and says nothing about the process table. There is no stub in
 * front of `process.kill`.
 */
export const mayReap = (env = process.env, argv = process.argv) => !env[NO_LAUNCH] && !startedByASuite(argv);

/** `$TMPDIR` with the symlink resolved — the form every `mkdtemp` in this repo uses. */
export function tmpRoot() {
  try {
    return fs.realpathSync(os.tmpdir());
  } catch {
    return os.tmpdir();
  }
}

/**
 * `ps`'s `etime` — `mm:ss`, `hh:mm:ss` or `dd-hh:mm:ss` — as milliseconds.
 *
 * `etime` rather than `lstart`, and that is not a style choice: `lstart` is formatted
 * through the locale (`Mon 17 Aug 11:09:27 2026` here, `Mon Aug 17 …` elsewhere) and
 * parsing it means either guessing at the order of the fields or shipping a date parser
 * for a number that is already available as an elapsed count. `etime` has one shape on
 * every Unix and it is the number this file actually wants.
 *
 * `null` for anything that does not parse, and the caller treats that as "too young to
 * touch" — an unreadable age is not a licence to signal.
 */
export function elapsedMs(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime || '').trim());
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return ((Number(d || 0) * 24 + Number(h || 0)) * 3600 + Number(mm) * 60 + Number(ss)) * 1000;
}

/**
 * The executable a `ps` command line starts with, which may well have spaces in it.
 *
 * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` has two, so the first
 * whitespace-separated token is not the program. Splitting at the first ` --` is, for
 * everything this needs to recognise: Chrome's own command line is all long options.
 *
 * This is guard 2's teeth, and it is also what stops the sweep matching *itself*. A
 * `ps | grep -- --headless=new` finds its own `grep`, every time, because the pattern is
 * on that process's command line — the oldest bug in process-table code. Here the
 * executable would have to be called something with "chrom" in it before anything else
 * is even considered.
 */
export function executableOf(args) {
  const at = args.indexOf(' --');
  return at === -1 ? args : args.slice(0, at);
}

/**
 * The top-level `beadcause-*` directory under `$TMPDIR` that `p` lives in, or `null`.
 *
 * Not simply `dirname(p) === root`, because a run may nest: `scripts/checks.mjs` gives
 * each check a `TMPDIR` of its own inside one run directory, so a Chrome profile made by
 * a check is two levels down. What matters for both passes is which top-level directory
 * the thing belongs to, since that is the unit removed.
 */
export function ownedBy(root, p) {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const top = rel.split(path.sep)[0];
  return top.startsWith(PREFIX) ? path.join(root, top) : null;
}

/**
 * One `ps` line → a candidate, or `null`.
 *
 * A "candidate" is any headless Chrome running on a `beadcause-` profile, at any age.
 * Age is applied by the caller and not here, because the young ones are wanted too: their
 * profiles are what guard 3 holds out of the directory pass.
 */
export function parseLine(line, { root }) {
  const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
  if (!m) return null;
  const [, pid, etime, args] = m;
  if (!args.includes('--headless=new')) return null;
  if (!/chrom/i.test(path.basename(executableOf(args)))) return null;
  const profile = /--user-data-dir=(\S+)/.exec(args)?.[1];
  if (!profile) return null;
  // `path.resolve` rather than `realpath`: the directory may be gone already (a run that
  // removed its profile but whose Chrome has not noticed), and a candidate whose profile
  // cannot be stat'd is still a process worth ageing.
  const dir = path.resolve(profile);
  const owned = ownedBy(root, dir);
  if (!owned) return null;
  const ageMs = elapsedMs(etime);
  return {
    pid: Number(pid),
    profile: dir,
    // The top-level `beadcause-*` directory under `$TMPDIR` that this profile is inside,
    // which is usually the profile itself and is not always: `test/browse.mjs` and
    // `scripts/checks.mjs` sandbox a whole run under one directory and make profiles
    // inside it. That ancestor is the unit `reapTemps` works in, so it is what guard 3
    // has to hold back — protecting a nested path it never looks at would protect nothing.
    owns: owned,
    ageMs,
    // A `--type=renderer` or `--type=gpu-process` is a child of the browser process
    // above it, and killing the browser takes it. Kept apart so the browsers can be
    // signalled first and the leftovers dealt with after — an orphaned renderer whose
    // browser died is a real thing, and it holds the same megabytes.
    helper: /--type=\S+/.test(args),
  };
}

/** Every headless Chrome on a `beadcause-` profile, whatever its age. */
export async function listChromes({ root = tmpRoot(), ps } = {}) {
  const out = ps ? await ps() : (await run('ps', ['-Ao', 'pid=,etime=,args='], { maxBuffer: 32 * 1024 * 1024 })).stdout;
  const found = [];
  for (const line of String(out).split('\n')) {
    const hit = parseLine(line, { root });
    if (hit) found.push(hit);
  }
  return found;
}

/**
 * Whether a pid is still there.
 *
 * Signal `0` sends nothing and only asks the question — and `EPERM` is a *yes*: the
 * process exists, it simply belongs to somebody else. Reading that as "gone" would be the
 * wrong direction, because the next thing the caller does with a "gone" pid is nothing,
 * and the next thing it does with a live one is escalate.
 *
 * Through `send` rather than `process.kill` directly so a suite can drive the escalation
 * without owning a real process. It is the same call either way — `kill(pid, 0)` is how
 * every Unix asks this question — so the seam is not a stub of the behaviour, it is the
 * behaviour with the destination swapped.
 */
function alive(pid, send) {
  try {
    send(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * SIGTERM, then SIGKILL what would not go — the order lib/browse.js and bin/router.js
 * both keep, and for the same reason.
 *
 * SIGTERM is the only signal Chrome can act on, and a Chrome that shuts down properly
 * takes its renderer, GPU and crashpad children with it. That is most of the work done
 * without a second signal, and it is why the browsers go first and the leftover helpers
 * are re-checked afterwards rather than signalled alongside.
 *
 * The pid is re-verified against a fresh `ps` before the SIGKILL. Two seconds is not long
 * enough for macOS to recycle a pid in practice, but "in practice" is not the standard for
 * the one act with no undo, and re-reading the table costs a single `ps`.
 */
async function killAll(targets, { root, ps, graceMs = 2000, signal }) {
  const send = signal || ((pid, sig) => process.kill(pid, sig));
  const killed = [];
  const refused = [];
  for (const t of targets) {
    try {
      send(t.pid, 'SIGTERM');
      killed.push(t);
    } catch (err) {
      // ESRCH is the ordinary case: it exited between the `ps` and here.
      if (err.code !== 'ESRCH') refused.push({ ...t, why: err.code || err.message });
    }
  }
  if (!killed.length) return { killed, refused };

  await sleep(graceMs);
  const still = new Set((await listChromes({ root, ps })).map((c) => c.pid));
  for (const t of killed) {
    // Both, and in this order: the table is what says the pid is still *the process we
    // meant*, and the probe is what says it is still there at all.
    if (!still.has(t.pid) || !alive(t.pid, send)) continue;
    try {
      send(t.pid, 'SIGKILL');
    } catch {
      /* gone between the two checks, which is the outcome wanted */
    }
  }
  return { killed, refused };
}

/**
 * Reap the Chromes older than the floor, and hand back every profile still in use.
 *
 * The second half of the return value is the point of taking `listChromes` at every age:
 * `keep` is what the directory pass must not touch, and it includes the profile of the
 * check another session started ten minutes ago.
 */
export async function reapChromes({ olderThanMs, root = tmpRoot(), ps, signal, graceMs } = {}) {
  const all = await listChromes({ root, ps });
  const old = (c) => c.ageMs != null && c.ageMs >= olderThanMs;
  const stray = all.filter(old);
  const keep = new Set(all.filter((c) => !old(c)).map((c) => c.owns));

  // Browsers first — see `killAll`. The helpers are re-read from the table afterwards so
  // that the ones whose browser has just taken them down are not signalled at all.
  const browsers = await killAll(stray.filter((c) => !c.helper), { root, ps, signal, graceMs });
  const left = (await listChromes({ root, ps })).filter((c) => c.helper && old(c));
  const helpers = await killAll(left, { root, ps, signal, graceMs });

  return {
    killed: [...browsers.killed, ...helpers.killed].map((c) => c.pid),
    refused: [...browsers.refused, ...helpers.refused],
    // Every profile a stray was on is now free, so it joins the directory pass rather
    // than being protected by it.
    keep,
  };
}

/**
 * Remove the `beadcause-*` directories older than the floor, except the ones in `keep`.
 *
 * `fs.promises.rm` rather than `rmSync` because this runs inside the daemon, and the
 * daemon is what a phone is waiting on: eight thousand synchronous recursive removals
 * would hold the event loop for the whole of it. `maxRetries` covers the case a
 * just-signalled Chrome is still letting go of its profile.
 *
 * Bounded per pass, and the remainder is *reported* rather than silently dropped — a
 * sweep that stops at a cap and says "removed 2000" reads as a sweep that found 2000.
 */
export async function reapTemps({ olderThanMs, root = tmpRoot(), now = Date.now(), keep = new Set(), max = MAX_PER_PASS } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return { removed: 0, failed: 0, remaining: 0 };
  }

  const due = [];
  let seen = 0;
  for (const name of names) {
    // One `lstat` is nothing; thirteen thousand of them in a row is a tenth of a second
    // with the event loop held, inside a process that is also serving a phone. Yielding
    // every few hundred costs nothing and bounds the stall — the same reason the removals
    // below are `fs.promises.rm` rather than `rmSync`.
    if ((seen += 1) % 500 === 0) await sleep(0);
    if (!name.startsWith(PREFIX)) continue;
    const p = path.join(root, name);
    if (keep.has(p)) continue;
    try {
      const st = fs.lstatSync(p);
      // `mtime` and not `birthtime`: a directory something is still writing into has a
      // fresh one, which is the conservative answer for a long run whose scratch space
      // was made hours ago. Both would have to be old for this to be wrong, and the age
      // floor is a day.
      if (now - st.mtimeMs < olderThanMs) continue;
      due.push(p);
    } catch {
      /* vanished between the readdir and the stat — somebody else's teardown */
    }
  }

  let removed = 0;
  let failed = 0;
  for (const p of due.slice(0, max)) {
    try {
      await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    } catch {
      // A directory that will not go is a few megabytes the OS clears eventually, and it
      // must never be the thing that stops the sweep — the same rule test/helpers/tmp.mjs
      // keeps about a teardown.
      failed += 1;
    }
  }
  return { removed, failed, remaining: Math.max(0, due.length - max) };
}

/**
 * One pass: the processes, then the directories they were holding.
 *
 * That order is load-bearing. A profile removed out from under a live Chrome is a Chrome
 * that recreates parts of it, which is how a directory comes back after `rm` reported it
 * gone (bc-rcrt, one module along in lib/browse.js). Killing first means the directory
 * pass is working on profiles nothing owns.
 */
export async function reapStrays({ olderThanMs = DEFAULT_HOURS * 3600_000, root = tmpRoot(), now = Date.now(), ps, signal, graceMs, max } = {}) {
  const chromes = await reapChromes({ olderThanMs, root, ps, signal, graceMs });
  const temps = await reapTemps({ olderThanMs, root, now, keep: chromes.keep, max });
  return {
    hours: Math.round(olderThanMs / 3600_000),
    killed: chromes.killed,
    refused: chromes.refused,
    ...temps,
  };
}

/** One line, or none at all when a pass found nothing — which is the settled state. */
export function describeStrays(out) {
  if (!out) return '';
  const bits = [];
  if (out.killed.length) bits.push(`killed ${out.killed.length} stranded headless Chrome(s)`);
  if (out.removed) bits.push(`removed ${out.removed} scratch director${out.removed === 1 ? 'y' : 'ies'}`);
  if (!bits.length) return '';
  let line = `${bits.join(' and ')} older than ${out.hours}h`;
  if (out.remaining) line += ` — ${out.remaining} more left for the next pass`;
  if (out.failed) line += ` — ${out.failed} would not go`;
  if (out.refused.length) line += ` — ${out.refused.length} process(es) refused the signal`;
  return line;
}
