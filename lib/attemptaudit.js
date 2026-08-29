/**
 * What the attempt counter *would* say if the two fixes had always been there —
 * bc-xl7n.149.
 *
 * `maxAttemptsPerBead` is a floor nothing decrements. A bead reaches it and leaves the
 * dispatcher for good while still sitting in `bd ready` looking like ordinary unstarted
 * work; `givenUp` in lib/advocate.js is the report that says so, and its docblock is the
 * argument for why the cap itself is right. None of that is in question here.
 *
 * What is in question is the arithmetic. Two shapes charged a bead for a window nobody
 * chose to end:
 *
 * - **bc-xl7n.146.** `parkIdle` closes a quiet window on purpose. The shell writes `$?`
 *   on the way out, so the next `reconcile` finds a done file and takes the `ended` arm,
 *   whose whole premise — "it exited, closed nothing, delivered nothing and asked
 *   nothing, that is the one ending here nobody chose" — is false about a window this
 *   daemon shut itself. Fixed by `w.idleParked`, which the `ended` arm now reads.
 * - **The replay.** The next dispatch resumes that same conversation rather than briefing
 *   a new one, it goes quiet into the same silence, and the second park charged again. So
 *   a bead could reach a cap of two having had *one* reading of its brief and one replay
 *   of that reading's silence.
 *
 * **Neither fix touches a counter already written**, and there was no per-bead door that
 * did. That left the console's `forget`, which clears every counter in the workspace at
 * once — the right shape for "I have read the list and none of these deserve it" and the
 * wrong one for a repair that has to leave a bead which genuinely broke two windows
 * exactly where it is. 64 beads were at the cap in this workspace when this was written,
 * 36 of them live open work, about a third of the ready queue.
 *
 * # A recount, not a guess
 *
 * Every ending `reconcile` reaches writes one line to the daemon log through `finish`,
 * and the sentence on it says which ending it was. So the whole history of a bead's
 * counter is in the log, in order, and can be replayed twice: once under the rule that
 * was in force when the lines were written, and once under the rule in force now. The
 * first number is the **proof** and the second is the **repair**.
 *
 * - If the replay under the old rule lands on the number the counter actually holds, the
 *   log explains that counter completely — nothing charged it before the log begins, and
 *   nothing charged it by a path this module cannot read. `explained` is that equality,
 *   and it is the only warrant for touching anything.
 * - `owed` is then the same walk with one charge withheld: **the ones for an ending this
 *   daemon chose**. It is never larger than `counted`, and where it is smaller the
 *   difference is exactly the charges the two shapes above produced.
 *
 * That second rule is stated as "an ending this daemon chose" rather than "what today's
 * code would charge", and the difference is worth being exact about. Today's code asks
 * `carryOver` before it parks, so a conversation that has spent its trips is *closed*
 * rather than parked and its charge stands. The log records which of the two happened —
 * the verb is right there in the line — so the replay reads the fact rather than
 * re-deriving it, and a park written by the buggy code (which dropped the trip count, so
 * every idle park read as the first) is forgiven here even where today's code would have
 * refused the trip. That is the right answer for a repair: those windows really were shut
 * by this daemon, and the bead really did get one brief and one replay of its silence. It
 * does not reopen the loop `maxResumes` bounds, because a repaired bead starts again at a
 * fresh brief and reaches the cap in two more windows exactly as it always would.
 *
 * A bead the log cannot explain — charged before the log begins, or charged by a path
 * with no sentence — is left alone and says so. That is the conservative direction and
 * the one the bead asks for: a bead that really did break two windows has to still be
 * retired afterwards, and "I could not tell" must never read as "clear it".
 *
 * **It is a recount and not a second opinion about the cap.** `owed` is what
 * lib/advocate.js's own arms would have written; every sentence matched below is one of
 * theirs. When one of those templates changes, the matching sentence here stops matching,
 * the bead stops being `explained`, and the failure is that this module repairs nothing —
 * never that it repairs the wrong thing. test/attemptaudit.mjs pins the sentences against
 * lib/advocate.js's source so that drift is caught before it can get that far.
 *
 * `bc-khoe.21` is the worked example of a rule having changed underneath, and of the
 * guard doing its job: the log holds 27 `the nightly maintenance window is closing the
 * Mac down` endings for it and its counter holds 2, because that ending only started
 * charging with bc-7qo.19 and most of those lines predate it. `counted` comes back 27,
 * the equality fails, and nothing is touched. Left to a heuristic — "it was never really
 * given a fair go" — that bead would have been cleared on the strength of the one reading
 * of the log that happens to be wrong about it.
 */
import fs from 'node:fs';
import readline from 'node:readline';

export { DAEMON_LOG } from './moment.js';

/** `2026-08-27T18:51:46.165Z [advocate] beadcause: …` — the stamp lib/logstamp.js writes. */
const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s/;

/**
 * The endings, as the sentences `finish` actually prints, grouped by what each does to
 * `a.attempts` — the only property of an ending this module is about.
 *
 * The neutral list is written out rather than left as a default so that an unrecognised
 * sentence stays *unrecognised*: a line nothing matches makes its bead unexplainable,
 * which is the safe answer, where a line silently treated as neutral would be a charge
 * this replay had quietly lost.
 */
const CLEARS = [
  // `done` — the bead closed under the window. lib/advocate.js deletes the counter first.
  /^landed #\d+ — the session merged its own pull request/,
  /^#\d+ was merged on GitHub — closed by the sweep, not by the session$/,
  /^closed by the session(?:, which then exited)?$/,
  // `delivered` and `handback` — the two endings the worker brief asks for.
  /^delivered as a pull request — waiting on \S+ for the merge$/,
  /^handed back to you — it needs a decision$/,
  // `standDown` — losing a lease race to another Mac drops the charges already there.
  // Not the maintenance window's sentence, which charges; the two share a `finish` kind
  // and share nothing else.
  /^stood down — /,
];

const NEUTRAL = [
  /^the bead is gone$/,
  /^its window opened and never ran the command — no attempt charged/,
  /^asked to check in \d+m ago and never answered$/,
  /^no window was recorded for it — the slot was freed without asking$/,
  /^its window is gone — the slot is free$/,
];

/** Charged whatever the rule: nothing about these three endings changed. */
const CHARGES = [
  /^still open after \d+h — releasing the slot$/,
  /^the session went away without claiming it$/,
  /^the nightly maintenance window is closing the Mac down$/,
];

/**
 * `ended` — the one arm bc-xl7n.146 changed, and the reason this is a recount.
 *
 * The suffix is the fixed code saying out loud that it did not charge. A line without it
 * was written either by the old code or by the new code for a window it had not parked,
 * and whether *that* one is a charge under today's rule is what the park flag answers.
 */
const EXITED_RE = /^the session exited without closing it(?: \(exit \d+\))?(.*)$/;
const EXITED_FREE = ' — this daemon parked it for being quiet';

/**
 * `gone` — `carryOver` gives the first disappearance a free trip, and the sentence says
 * which way it went. Read rather than inferred: the trip count lives on the worker, and
 * the worker is gone by the time anybody reads this.
 */
const GONE_RE = /^its window is gone after \d+m — (.*)$/;
const GONE_CHARGED = 'it has already been brought back';

/** iTerm refused. Charged at the launch site, so it is not a `finish` sentence. */
const LAUNCH_FAILED_RE = /^could not open a session on (\S+) — /;

/**
 * A window opens — the episode boundary, and there are two spellings of it.
 *
 * The bare one is `opened a session on <id> in <dir> (auto, …, attempt N)`; a bead
 * dispatched out of an epic's plan reads `opened a session on <id> for "<slug>" in
 * <epic>'s plan in <dir> (…)` instead, so the id cannot be anchored on a following
 * `in `. An epic's own planner opens by a third line entirely, which is why
 * `EPIC_OPENED_RE` is here as well: without it a park recorded against the epic carries
 * across into whatever its *next* window ended as, and forgives a charge that was earned.
 */
const OPENED_RE = /^opened a session on (\S+) /;
const EPIC_OPENED_RE = /^re-opened the Epic Advocate on (\S+) — /;

/** `resumed <id> in <sha> rather than briefing a new session` — the same episode again. */
const RESUMED_RE = /^resumed (\S+) in \S+ rather than briefing a new session$/;

/**
 * `parked <kind> <what> — <why>` and `closed <kind> <what> — <why>`, from `parkIdle`.
 *
 * The verb is the whole of the difference and it is not cosmetic. **Parked** means the
 * conversation reached the disk and `w.idleParked` was set, so today's `ended` arm skips
 * the charge. **Closed** means `carryOver` refused the trip — the transcript is thrown
 * away, the next window gets a fresh brief, and the charge is owed exactly as it always
 * was. A recount that read the two the same way would forgive the one charge `maxResumes`
 * exists to write.
 *
 * The kind is left open rather than listed, because the sweep parks every kind of window
 * it holds — `worker`, `epic-advocate`, `merge-advocate`, `review-advocate` are all in
 * this log — and an epic charged for a planner window the daemon parked is the same
 * defect wearing the roster's other hat. What keeps the loose token safe is the id: only
 * a bead already in `attempts` is followed, so a line of some other shape that happens to
 * begin with the verb matches nothing.
 */
const PARKED_RE = /^(parked|closed) ([a-z][a-z0-9-]*) (\S+) — /;

/** Which of the six an ending sentence is, or `null` for one this module does not know. */
export function endingKind(rest) {
  if (CLEARS.some((re) => re.test(rest))) return 'clear';
  if (NEUTRAL.some((re) => re.test(rest))) return 'neutral';
  if (CHARGES.some((re) => re.test(rest))) return 'charge';
  const exited = EXITED_RE.exec(rest);
  if (exited) return exited[1].startsWith(EXITED_FREE) ? 'exited-free' : 'exited';
  const gone = GONE_RE.exec(rest);
  if (gone) return gone[1].startsWith(GONE_CHARGED) ? 'charge' : 'neutral';
  return null;
}

/**
 * Replay one workspace's advocate log and say what each charged bead's counter should
 * hold.
 *
 * `lines` is the daemon log in file order, stamps and all — the caller hands the whole
 * file because a bead's history can start anywhere in it. `attempts` is the live map,
 * `{ [beadId]: charges }`; only ids it names are followed, because that map is the whole
 * population and tracking every id in the log would count beads nothing is holding.
 *
 * One row comes back per id in `attempts`, whether or not the log had anything to say
 * about it — for the reason lib/moment.js returns all five of its keys: a source that
 * came back empty and a source nobody asked look the same, and only one of them is a
 * finding.
 */
export function auditLines(lines, { workspace, attempts = {} } = {}) {
  const prefix = `[advocate] ${workspace}: `;
  const tracked = new Set(Object.keys(attempts));
  /** Per bead: the running replay under both rules, and whether a park is open. */
  const state = new Map();
  const at = (id) => {
    if (!state.has(id)) {
      state.set(id, { counted: 0, owed: 0, parked: false, resumed: false, episodes: 0, endedAt: null });
    }
    return state.get(id);
  };
  let scanned = 0;
  let advocateLines = 0;

  for (const line of lines) {
    scanned += 1;
    const cut = line.indexOf(prefix);
    if (cut < 0) continue;
    advocateLines += 1;
    const stamp = STAMP_RE.exec(line)?.[1] || null;
    const rest = line.slice(cut + prefix.length);

    const opened = OPENED_RE.exec(rest) || EPIC_OPENED_RE.exec(rest);
    if (opened) {
      if (!tracked.has(opened[1])) continue;
      // A new window on this bead: whatever the last one was parked as is finished with.
      const s = at(opened[1]);
      s.parked = false;
      s.episodes += 1;
      continue;
    }
    const resumed = RESUMED_RE.exec(rest);
    if (resumed) {
      if (tracked.has(resumed[1])) at(resumed[1]).resumed = true;
      continue;
    }
    const park = PARKED_RE.exec(rest);
    if (park) {
      // `closed` is a park that did not happen, so it clears the flag rather than setting
      // it — see PARKED_RE.
      if (tracked.has(park[3])) at(park[3]).parked = park[1] === 'parked';
      continue;
    }
    const failed = LAUNCH_FAILED_RE.exec(rest);
    if (failed) {
      if (!tracked.has(failed[1])) continue;
      const s = at(failed[1]);
      s.counted += 1;
      s.owed += 1;
      continue;
    }
    // Everything left is `finish`: `<id> — <why>`. The id has to be one we are following
    // *and* the sentence one of the six, or the line is not an ending at all — the log is
    // full of `<id> — <note>` warnings that look identical up to the dash.
    const dash = rest.indexOf(' — ');
    if (dash < 0) continue;
    const id = rest.slice(0, dash);
    if (!tracked.has(id)) continue;
    const kind = endingKind(rest.slice(dash + 3));
    if (kind === null) continue;
    const s = at(id);
    if (kind === 'clear') {
      s.counted = 0;
      s.owed = 0;
    } else if (kind === 'charge') {
      s.counted += 1;
      s.owed += 1;
    } else if (kind === 'exited') {
      s.counted += 1;
      // The repair, and the only place the two replays part company.
      if (!s.parked) s.owed += 1;
    }
    // `exited-free` needs neither arm: the fixed code already declined to charge, so the
    // two replays agree about it and both leave the running totals alone.
    if (kind !== 'neutral') {
      s.parked = false;
      s.resumed = false;
      s.endedAt = stamp;
    }
  }

  const verdicts = Object.entries(attempts).map(([id, held]) => {
    const charges = Number(held) || 0;
    const s = state.get(id) || null;
    const counted = s ? s.counted : 0;
    const owed = s ? s.owed : 0;
    const explained = Boolean(s) && counted === charges;
    return {
      id,
      charges,
      counted,
      owed,
      explained,
      // The one field a caller acts on. Both halves are load-bearing: without
      // `explained` this would clear a bead whose history predates the log, and without
      // the inequality it would rewrite counters it agrees with.
      repairable: explained && owed < charges,
      episodes: s ? s.episodes : 0,
      endedAt: s ? s.endedAt : null,
      why: !s
        ? 'nothing in the log names it — its charges predate this log, or came by a path that writes no sentence'
        : !explained
          ? `the log accounts for ${counted} of its ${charges} charge(s), so the rest predate it — left alone`
          : owed < charges
            ? `${charges - owed} of its ${charges} charge(s) were for a window this daemon parked and closed itself`
            : 'every charge it carries was earned by a window that ended on its own',
    };
  });
  return { workspace, scanned, advocateLines, verdicts };
}

/**
 * The same replay, streamed — `readline` over a `createReadStream`, never the whole file
 * held twice. The log this was written against is 39,339,831 bytes and grows for the life
 * of the daemon; the caller is expected to ask only when a bead has newly reached the cap,
 * which is what keeps this off the tick's ordinary path.
 *
 * A missing log is "this source has nothing to say" rather than a throw, exactly as
 * `scanLog` treats it: every verdict then comes back unexplained, which is the answer
 * that repairs nothing.
 */
export async function auditLog(logFile, { workspace, attempts = {} } = {}) {
  const lines = [];
  const stream = fs.createReadStream(logFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let exists = true;
  try {
    for await (const line of rl) lines.push(line);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    exists = false;
  } finally {
    rl.close();
    stream.destroy();
  }
  return { ...auditLines(lines, { workspace, attempts }), path: logFile, exists };
}

/**
 * The sentence the daemon logs when it repairs one, and the sentence the console shows.
 *
 * Kept here beside the rules that produce it so the two cannot drift: a repair that
 * cleared three charges and said "cleared the attempts" would be indistinguishable from
 * `forget`, which is the one thing this must never be mistaken for.
 */
export function repairNote(v, cap) {
  const cleared = v.charges - v.owed;
  return (
    `${v.id}: ${cleared} of ${v.charges} attempt charge(s) were for a window this daemon parked and closed itself` +
    (v.owed
      ? `, leaving ${v.owed} of ${cap}`
      : `, and it was retired at ${cap} of ${cap} — a window can open on it again`)
  );
}
