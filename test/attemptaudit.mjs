#!/usr/bin/env node
//
// The attempt-charge recount — bc-xl7n.149.
//
//   npm test                     (runs it alongside the rest)
//   node test/attemptaudit.mjs
//
// bc-xl7n.146 stopped the `ended` arm charging a bead for a window `parkIdle` closed, and
// bc-xl7n.147 stopped the resumed conversation waking as somebody's answer. Neither fix
// touches a counter already written, and when this landed 64 beads in this workspace sat
// at `maxAttemptsPerBead`, 36 of them live open work — every one of them in `bd ready`
// looking exactly like work about to be picked up, and none of them reachable by anything
// short of `forget`, which clears all 64.
//
// lib/attemptaudit.js replays the daemon log twice: once under the rule that was in force
// when each ending was written, and once withholding the charges for endings this daemon
// chose. Four things about that are worth a suite and none is visible by reading one
// function:
//
// 1. **`explained` is the whole safety property.** The replay may only touch a counter it
//    can reconcile exactly. Section 4 is the bc-khoe.21 shape — 27 endings in the log
//    against a counter of 2, because the maintenance stand-down only started charging with
//    bc-7qo.19 — and the answer has to be "left alone", not "cleared".
// 2. **A repair can only ever lower.** Section 5 asserts it over every fixture here,
//    because the one direction this must never reach is retiring something.
// 3. **The verb is the discriminator.** `parked` means the conversation reached the disk
//    and today's `ended` arm skips the charge; `closed` means `carryOver` refused the trip
//    and the charge is owed exactly as it always was. Reading the two the same way would
//    forgive the one charge `maxResumes` exists to write.
// 4. **The sentences are lib/advocate.js's, and drift is silent.** Section 6 pins every
//    one of them against that file's source. When a template changes, the match here stops
//    matching, beads stop being `explained`, and the module repairs *nothing* — which is
//    the safe failure but is also indistinguishable from a healthy quiet pass. This is
//    what makes it loud.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const { auditLines, auditLog, endingKind, repairNote } = await import(path.join(ROOT, 'lib', 'attemptaudit.js'));

/* ------------------------------------------------------------------ fixtures */

const WS = 'demo';
let clock = Date.parse('2026-08-27T18:00:00.000Z');
/** One advocate line, stamped the way lib/logstamp.js stamps it. */
const line = (text) => {
  clock += 60_000;
  return `${new Date(clock).toISOString()} [advocate] ${WS}: ${text}`;
};
/** The four shapes a log holds about one bead, spelled as lib/advocate.js spells them. */
const opened = (id, n = 1) =>
  line(`opened a session on ${id} in /Users/x/repo (auto, sonnet (low), attempt ${n})`);
const openedInPlan = (id, slug, epic) =>
  line(`opened a session on ${id} for "${slug}" in ${epic}'s plan in /Users/x/repo (auto, attempt 1)`);
const resumed = (id) => line(`resumed ${id} in 32b64067 rather than briefing a new session`);
const parked = (id, kind = 'worker') => line(`parked ${kind} ${id} — quiet for 20m — it is waiting on you`);
const shut = (id, kind = 'worker') =>
  line(`closed ${kind} ${id} — quiet for 20m — it is waiting on you, and it has already been brought back 1 time(s); closed without parking it, so the next window gets a fresh brief`);
const exited = (id) => line(`${id} — the session exited without closing it (exit 143)`);
const exitedFree = (id) =>
  line(
    `${id} — the session exited without closing it (exit 143) — this daemon parked it for being quiet, so no attempt is charged and the conversation comes back on the next dispatch`
  );
const timedOut = (id) => line(`${id} — still open after 2h — releasing the slot`);
const lapsed = (id) => line(`${id} — the session went away without claiming it`);
const maintenance = (id) => line(`${id} — the nightly maintenance window is closing the Mac down`);
const goneFree = (id) =>
  line(`${id} — its window is gone after 13m — no attempt charged, and the conversation comes back on the next dispatch`);
const goneCharged = (id) =>
  line(
    `${id} — its window is gone after 13m — it has already been brought back 1 time(s), so this one is charged and the next window gets a fresh brief`
  );
const delivered = (id, card) => line(`${id} — delivered as a pull request — waiting on ${card} for the merge`);
const handedBack = (id) => line(`${id} — handed back to you — it needs a decision`);
const closedBySession = (id) => line(`${id} — closed by the session, which then exited`);
const launchFailed = (id) => line(`could not open a session on ${id} — iTerm refused`);

const audit = (lines, attempts) => auditLines(lines, { workspace: WS, attempts });
const one = (lines, attempts, id) => audit(lines, attempts).verdicts.find((v) => v.id === id);

/* ----------------------------------------------------- 1. the ending vocabulary */

console.log('\nwhat each ending sentence is');
{
  const cases = [
    ['the session exited without closing it (exit 143)', 'exited'],
    ['the session exited without closing it', 'exited'],
    [
      'the session exited without closing it (exit 143) — this daemon parked it for being quiet, so no attempt is charged and the conversation comes back on the next dispatch',
      'exited-free',
    ],
    ['still open after 2h — releasing the slot', 'charge'],
    ['the session went away without claiming it', 'charge'],
    ['the nightly maintenance window is closing the Mac down', 'charge'],
    ['its window is gone after 13m — no attempt charged, and the conversation comes back on the next dispatch', 'neutral'],
    ['its window is gone after 13m — it has already been brought back 1 time(s), so this one is charged and the next window gets a fresh brief', 'charge'],
    ['delivered as a pull request — waiting on bc-abcd for the merge', 'clear'],
    ['handed back to you — it needs a decision', 'clear'],
    ['stood down — another Mac holds the claim', 'clear'],
    ['closed by the session', 'clear'],
    ['closed by the session, which then exited', 'clear'],
    ['landed #42 — the session merged its own pull request and exited', 'clear'],
    ['#42 was merged on GitHub — closed by the sweep, not by the session', 'clear'],
    ['the bead is gone', 'neutral'],
    ['its window opened and never ran the command — no attempt charged, 3 temp file(s) cleaned up', 'neutral'],
    ['asked to check in 45m ago and never answered', 'neutral'],
    ['no window was recorded for it — the slot was freed without asking', 'neutral'],
    ['its window is gone — the slot is free', 'neutral'],
    ['a live process already names this bead on its own command line', null],
    ['another session is editing lib/advocate.js on worktree-x — opening a window anyway', null],
  ];
  for (const [sentence, want] of cases) {
    const got = endingKind(sentence);
    check(
      `${want === null ? 'not an ending' : want}: ${sentence.slice(0, 52)}…`,
      got === want,
      `wanted ${want}, got ${got}`
    );
  }
}

/* ------------------------------------------------- 2. the shape the bead is about */

console.log('\nthe park-and-reap shape — bc-xl7n.142');
{
  // Briefed, went quiet, parked, reaped and charged; resumed, went quiet again, parked
  // again, reaped again and charged again. Two charges, a cap of two, and one reading of
  // the brief between them.
  const log = [
    opened('bc-x.142', 1),
    parked('bc-x.142'),
    exited('bc-x.142'),
    resumed('bc-x.142'),
    opened('bc-x.142', 2),
    parked('bc-x.142'),
    exited('bc-x.142'),
  ];
  const v = one(log, { 'bc-x.142': 2 }, 'bc-x.142');
  check('the log accounts for both charges', v.counted === 2, `counted ${v.counted}`);
  check('neither was for an ending anybody chose', v.owed === 0, `owed ${v.owed}`);
  check('so it is explained and repairable', v.explained && v.repairable);
  check('and it counted two windows', v.episodes === 2, `episodes ${v.episodes}`);
  check(
    'the sentence says which and how many',
    repairNote(v, 2) ===
      'bc-x.142: 2 of 2 attempt charge(s) were for a window this daemon parked and closed itself, and it was retired at 2 of 2 — a window can open on it again',
    repairNote(v, 2)
  );
}

/* ---------------------------------------------------- 3. what must stay retired */

console.log('\nwhat a repair must leave alone');
{
  const twoTimeouts = [opened('bc-a', 1), timedOut('bc-a'), opened('bc-a', 2), timedOut('bc-a')];
  const v = one(twoTimeouts, { 'bc-a': 2 }, 'bc-a');
  check('two windows that ran themselves out keep both charges', v.owed === 2 && !v.repairable);
  check('and it says so', v.why.includes('earned by a window that ended on its own'), v.why);
}
{
  // The park belongs to the *previous* window. A charge for the one after it is earned,
  // and a replay that let the flag survive the episode boundary would forgive it.
  const log = [opened('bc-b', 1), parked('bc-b'), exited('bc-b'), opened('bc-b', 2), exited('bc-b')];
  const v = one(log, { 'bc-b': 2 }, 'bc-b');
  check('a park does not carry into the next window', v.owed === 1, `owed ${v.owed}`);
  check('so the counter drops to one rather than to nothing', v.repairable && v.counted === 2);
}
{
  // `closed` rather than `parked`: `carryOver` refused the trip, the transcript was thrown
  // away and the next window gets a fresh brief. That charge is `maxResumes` doing its job.
  const log = [opened('bc-c', 1), parked('bc-c'), exited('bc-c'), resumed('bc-c'), opened('bc-c', 2), shut('bc-c'), exited('bc-c')];
  const v = one(log, { 'bc-c': 2 }, 'bc-c');
  check('a conversation whose trips ran out keeps its charge', v.owed === 1, `owed ${v.owed}`);
}
{
  // A timeout after a park is still charged, because the `timeout` arm never read
  // `idleParked` — the recount is faithful to lib/advocate.js rather than kinder than it.
  const log = [opened('bc-d', 1), parked('bc-d'), timedOut('bc-d'), opened('bc-d', 2), timedOut('bc-d')];
  const v = one(log, { 'bc-d': 2 }, 'bc-d');
  check('a park raced by the two-hour timeout keeps its charge', v.owed === 2 && !v.repairable);
}
{
  const log = [opened('bc-e', 1), parked('bc-e'), exitedFree('bc-e'), opened('bc-e', 2), timedOut('bc-e')];
  const v = one(log, { 'bc-e': 1 }, 'bc-e');
  check('the fixed code charging nothing is agreed with, not double-counted', v.counted === 1 && v.owed === 1);
  check('and a bead below the cap with only earned charges is not repairable', !v.repairable);
}
{
  const log = [launchFailed('bc-f'), launchFailed('bc-f')];
  const v = one(log, { 'bc-f': 2 }, 'bc-f');
  check('iTerm refusing twice is two earned charges', v.counted === 2 && v.owed === 2 && !v.repairable);
}
{
  const log = [opened('bc-g', 1), goneFree('bc-g'), opened('bc-g', 2), goneCharged('bc-g'), opened('bc-g', 3), maintenance('bc-g')];
  const v = one(log, { 'bc-g': 2 }, 'bc-g');
  check('a first disappearance is free and the second is not', v.counted === 2 && v.owed === 2);
}

/* --------------------------------------------------- 4. the reconciliation guard */

console.log('\nthe counter has to reconcile before anything is touched');
{
  // bc-khoe.21 verbatim: 27 maintenance stand-downs in the log against a counter of 2,
  // because that ending only started charging with bc-7qo.19 and most of the lines predate
  // it. A heuristic would have cleared this bead; the equality refuses to.
  const log = [];
  for (let i = 0; i < 27; i += 1) {
    log.push(opened('bc-h', 2), maintenance('bc-h'));
  }
  const v = one(log, { 'bc-h': 2 }, 'bc-h');
  check('a log that over-counts leaves the bead alone', !v.explained && !v.repairable, `counted ${v.counted}`);
  check('and says how far apart the two are', v.why.includes('accounts for 27 of its 2'), v.why);
}
{
  const v = one([opened('bc-i', 1), exited('bc-i')], { 'bc-i': 2 }, 'bc-i');
  check('a log that under-counts leaves the bead alone', !v.explained && !v.repairable, `counted ${v.counted}`);
}
{
  const v = one([opened('bc-j', 1)], { 'bc-k': 2 }, 'bc-k');
  check('a bead the log never names is left alone', !v.explained && !v.repairable);
  check('and says the log is the reason', v.why.includes('nothing in the log names it'), v.why);
}
{
  // A clear resets the running total, so a bead that delivered once and was charged after
  // reconciles at one rather than at three.
  const log = [
    opened('bc-l', 1),
    exited('bc-l'),
    opened('bc-l', 2),
    exited('bc-l'),
    opened('bc-l', 3),
    delivered('bc-l', 'bc-card'),
    opened('bc-l', 1),
    timedOut('bc-l'),
  ];
  const v = one(log, { 'bc-l': 1 }, 'bc-l');
  check('a delivery resets the replay the way it resets the map', v.counted === 1 && v.explained, `counted ${v.counted}`);
  check('and what came after it is earned', v.owed === 1 && !v.repairable);
}
{
  const log = [opened('bc-m', 1), exited('bc-m'), handedBack('bc-m'), opened('bc-m', 1), parked('bc-m'), exited('bc-m')];
  const v = one(log, { 'bc-m': 1 }, 'bc-m');
  check('a hand-back resets it too', v.counted === 1 && v.owed === 0 && v.repairable);
}
{
  const log = [opened('bc-n', 1), exited('bc-n'), closedBySession('bc-n'), opened('bc-n', 1), exited('bc-n')];
  const v = one(log, { 'bc-n': 1 }, 'bc-n');
  check('the bead closing under the window resets it', v.counted === 1 && v.explained);
}

/* ------------------------------------------------------ 5. it can only ever lower */

console.log('\nwhat the repair is not allowed to do');
{
  const log = [
    opened('bc-o', 1),
    parked('bc-o'),
    exited('bc-o'),
    opened('bc-p', 1),
    timedOut('bc-p'),
    opened('bc-q', 1),
    lapsed('bc-q'),
  ];
  const r = audit(log, { 'bc-o': 1, 'bc-p': 1, 'bc-q': 1, 'bc-r': 4 });
  check('every verdict has a row, including the one nothing knows about', r.verdicts.length === 4);
  check(
    'owed never exceeds what is held',
    r.verdicts.every((v) => v.owed <= v.charges),
    JSON.stringify(r.verdicts.map((v) => [v.id, v.charges, v.owed]))
  );
  check(
    'nothing is repairable unless it is explained',
    r.verdicts.every((v) => !v.repairable || v.explained)
  );
  check('a repairable one really is lower', r.verdicts.find((v) => v.id === 'bc-o').owed === 0);
}

/* --------------------------------------------------- 6. the sentences are not ours */

console.log('\nevery sentence matched is one lib/advocate.js writes');
{
  const advocate = read('lib/advocate.js');
  const parkedJs = read('lib/parked.js');
  // Each entry is a literal fragment of a template in that file. A template that changes
  // takes its fragment with it, and this is what says so — because the module's own
  // failure mode is silence.
  const pins = [
    ['the ending line itself', '${a.name}: ${w.id} — ${why}'],
    ['exited without closing', 'the session exited without closing it'],
    ['the no-charge suffix', ' — this daemon parked it for being quiet, so no attempt is charged'],
    ['the two-hour timeout', 'still open after '],
    ['releasing the slot', 'h — releasing the slot'],
    ['lapsed', 'the session went away without claiming it'],
    ['the nightly window', 'the nightly maintenance window is closing the Mac down'],
    ['a window that is gone', 'its window is gone after '],
    ['a gone window that is charged', 'it has already been brought back '],
    ['a gone window that is not', 'no attempt charged, and the conversation comes back on the next dispatch'],
    ['delivered', 'delivered as a pull request — waiting on '],
    ['handed back', 'handed back to you — it needs a decision'],
    ['stood down', 'stood down — '],
    ['closed by the session', 'closed by the session'],
    ['landed under its own window', ' — the session merged its own pull request'],
    ['swept as merged', ' was merged on GitHub — closed by the sweep, not by the session'],
    ['the bead is gone', 'the bead is gone'],
    ['never started', 'its window opened and never ran the command — no attempt charged'],
    ['never checked in', ' ago and never answered'],
    ['reclaimed without asking', 'no window was recorded for it — the slot was freed without asking'],
    ['gone, slot freed', 'its window is gone — the slot is free'],
    ['a window opening', 'opened a session on ${bead.id}'],
    ['a conversation resumed', ' rather than briefing a new session'],
    ["an epic's planner opening", 're-opened the Epic Advocate on ${epic.id} — '],
    ['iTerm refusing', 'could not open a session on ${bead.id} — '],
    ['the park line', "${bringBack ? 'parked' : 'closed'} ${rec.kind} ${what} — ${said}"],
  ];
  for (const [what, fragment] of pins) {
    check(`lib/advocate.js still writes ${what}`, advocate.includes(fragment), `missing: ${fragment}`);
  }
  // The two `why` texts a park carries come from the other file, and the regex here does
  // not read them — but a park with no ` — ` after the id would slip past it entirely.
  check(
    'a park always has a reason after the dash',
    parkedJs.includes('quiet for ') && parkedJs.includes('its status has said '),
    'lib/parked.js no longer writes either park reason'
  );
  // And the arm the whole recount is about: the guard bc-xl7n.146 added, in the file it
  // was added to. Without it every `exited` is a charge again and the replay's two halves
  // stop being different questions.
  check(
    'the ended arm still asks whether this daemon parked it',
    /const ours = Boolean\(w\.idleParked\);\s*\n\s*if \(!ours\) a\.attempts\[w\.id\]/.test(advocate),
    "lib/advocate.js's `ended` arm no longer reads w.idleParked"
  );
}

/* ---------------------------------------------------------- 7. reading a real file */

console.log('\nreading the log off disk');
{
  const r = await auditLog(path.join(ROOT, 'no', 'such', 'log'), { workspace: WS, attempts: { 'bc-s': 2 } });
  check('a log that is not there is a source with nothing to say', r.exists === false);
  check('and repairs nothing', r.verdicts.every((v) => !v.repairable));
}
{
  const file = path.join(ROOT, 'test', `.attemptaudit-${process.pid}.log`);
  const lines = [
    opened('bc-t', 1),
    parked('bc-t'),
    exited('bc-t'),
    // Another workspace's window, interleaved: a name that is not ours must not be read,
    // and the daemon's log is every workspace's at once.
    `2026-08-27T19:00:00.000Z [advocate] other: opened a session on bc-t in /x (auto, attempt 1)`,
    `2026-08-27T19:01:00.000Z [advocate] other: bc-t — still open after 2h — releasing the slot`,
    opened('bc-t', 2),
    parked('bc-t'),
    exited('bc-t'),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  try {
    const r = await auditLog(file, { workspace: WS, attempts: { 'bc-t': 2 } });
    const v = r.verdicts[0];
    check('a stream reads the same as an array', r.exists && v.counted === 2 && v.owed === 0 && v.repairable);
    check("another workspace's lines are not counted", v.counted === 2, `counted ${v.counted}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
}
{
  // A bead dispatched out of an epic's plan has the slug between the id and the `in`, so
  // the episode boundary cannot be anchored on it. This is the shape that was missed.
  const log = [
    openedInPlan('bc-u.11', 'gate-wait-record', 'bc-u'),
    parked('bc-u.11'),
    exited('bc-u.11'),
    openedInPlan('bc-u.11', 'gate-wait-record', 'bc-u'),
    exited('bc-u.11'),
  ];
  const v = one(log, { 'bc-u.11': 2 }, 'bc-u.11');
  check('a window opened out of a plan still closes its episode', v.owed === 1 && v.episodes === 2, `owed ${v.owed}`);
}
{
  // A planner park is the same defect wearing the roster's other hat.
  const log = [
    line("re-opened the Epic Advocate on bc-v — `bc-v.1` was filed under it"),
    parked('bc-v', 'epic-advocate'),
    exited('bc-v'),
    line("re-opened the Epic Advocate on bc-v — `bc-v.2` was filed under it"),
    exited('bc-v'),
  ];
  const v = one(log, { 'bc-v': 2 }, 'bc-v');
  check("an epic's own planner is read the same way", v.owed === 1 && v.episodes === 2, `owed ${v.owed}`);
}

console.log(
  failures ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m` : `\n\x1b[32mall ${ran} checks passed\x1b[0m`
);
process.exit(failures ? 1 : 0);
