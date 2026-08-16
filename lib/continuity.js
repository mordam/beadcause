/**
 * What a period of history may actually be claimed to be — and why an offline daemon is
 * ordinary while an unpublished period is not clean.
 *
 * Two rules, and they point in opposite directions on purpose. **Fail open for work:**
 * a daemon with no route to the service keeps doing everything it does today. Sessions
 * open, merges land, questions arrive; nothing waits on a server being up and no gate
 * fires because one is unreachable. **Fail closed for claims:** a period nobody witnessed
 * is not evidence that nothing happened, it is an absence of evidence, and a report over
 * it says `unverified` rather than compliant. Trading either rule for the other makes
 * beadcause worse — the first would make an outage stop work, and the second would let an
 * outage render as a clean window, which is the exact failure this file exists to prevent.
 *
 * **Linked is not continuous, and this is the file that refuses to conflate them.**
 * `linkProblems` in lib/publishable.js walks the digests and proves that a run of records
 * is one unbroken chain — and an instance that published nothing for a fortnight has a
 * perfectly linked chain straight across the fortnight, because the record either side of
 * a gap links onto the record before it whatever happened in between. Chaining is an
 * argument about *order*; continuity is an argument about *time*, and only one thing on
 * this Mac carries an argument about time that the Mac cannot make by itself: a receipt,
 * stamped by the witness's own clock.
 *
 * **So coverage is measured in receipts, never in records.** A record's `at` is the local
 * clock, written by the very machine whose history is in question — a record stamped
 * 03:00 and witnessed at 09:00 proves nothing about 03:00 that could not have been
 * assembled at 08:59. lib/witness.js already says this in the field it chose to attest
 * with: `received` is the service's clock rather than the record's, "because a record
 * stamped an hour before it was witnessed is an hour nobody was watching". That sentence
 * is this file's whole arithmetic.
 *
 * **The bracket rule, in one line: an interval is verified when it is bracketed by two
 * witnessed instants no further apart than `tolerance`.** Not "a receipt covers the hour
 * after it" and not "a receipt covers the hour before it" — either of those buys time
 * from a single point, and a single point is exactly what a machine can manufacture.
 * Two points, close together, are what bound how long anything could have sat unwitnessed
 * and therefore alterable. Where consecutive witnesses are further apart than `tolerance`,
 * the *whole* interval between them goes unverified rather than only the excess: something
 * recorded a minute into a six-hour silence waited six hours to be seen, and shaving the
 * first hour off the gap would claim the least defensible part of it.
 *
 * **Two edges, and they are not symmetric.** Nothing before the first witnessed instant is
 * ever verified — there is no bracket before it, and a report that vouched backwards from
 * the first publication would vouch for time in which the install did not exist. The
 * trailing edge is the one concession: the interval from the last witness to the end of
 * the window is verified if it is within `tolerance`, with the end of the window standing
 * in for the bracket the next publication will supply. That is the single place the report
 * extends past what it holds, it is bounded by `tolerance` and by nothing else, and it is
 * why `tolerance` is a staleness budget rather than a knob — widen it and you widen
 * exactly this.
 *
 * **The reason is as much of the answer as the duration.** An unverified interval says
 * which of two things it was, from the local chain: records stamped inside it means the
 * instance kept working and could not publish, which is an outage; no records inside it
 * means nothing was recorded either, which is silence. An auditor reading "4h 12m
 * unverified" has a question; one reading "4h 12m unverified — the instance kept working,
 * 37 records stamped inside it and witnessed only afterwards" has an answer.
 *
 * Pure, and a leaf but for lib/publishable.js, for the same reason lib/witness.js is: the
 * continuity report is asked for at both ends — by the instance about itself, and by the
 * service about an instance it holds — and a module that reaches for `~/.config/beadcause`
 * on import cannot run on the far end. Nothing here reads state, writes state, or takes a
 * clock it was not handed; a window is two instants a caller names.
 *
 * What it is not: it is not the anchor (bc-3muu.10), and `tolerance` says nothing about
 * anchoring resolution — lib/operator.js keeps those axes deliberately apart. It is not
 * the transport, and it does not decide when to publish; lib/publication.js does that, and
 * `publishQuietly` there is the other half of the fail-open rule, in code rather than in
 * prose.
 */
import { TYPES } from './publishable.js';

/**
 * How long a period may go unwitnessed before it stops being claimable. One hour.
 *
 * Not a tuning number, and deliberately two orders of magnitude looser than the cadence it
 * governs: `pollSeconds` is 30, so a daemon publishing on its ordinary tick is witnessed
 * 120 times inside one tolerance. That gap between the two is the property being bought.
 * A threshold close to the cadence is a threshold that work has to *race* — a slow sweep,
 * a restart, a lid closed through a meeting would each punch a hole in a window, and a
 * report that cries outage over a lunch break is a report nobody reads to the end. At an
 * hour, an interval only goes unverified when publication genuinely stopped.
 *
 * It is generous in the one direction that can be defended and not in the other: an hour
 * is short enough that a rewrite of history has an hour, at most, in which to be invisible.
 */
export const TOLERANCE_MS = 60 * 60 * 1000;

/** The units a duration is read in, largest first. Nothing here is smaller than a second. */
const UNITS = Object.freeze([
  ['d', 24 * 60 * 60 * 1000],
  ['h', 60 * 60 * 1000],
  ['m', 60 * 1000],
  ['s', 1000],
]);

/**
 * A span of milliseconds as somebody reads it — `6h 12m`, `3d 2h`, `45s`.
 *
 * Two units at most, because the third is noise at every scale that matters here and a
 * duration nobody can hold in their head is a duration that gets skimmed past. Rounded
 * down rather than to nearest, so a reported gap is never longer than the gap.
 */
export function duration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  if (total < 1000) return `${total}ms`;
  const parts = [];
  let rest = total;
  for (const [suffix, size] of UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n) parts.push(`${n}${suffix}`);
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/** An instant back out in the one form `at` accepts, for a `why` somebody reads. */
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The instants a witness attested to, sorted and deduplicated, plus what was unreadable.
 *
 * A receipt that does not carry a usable `received` is dropped rather than guessed at, and
 * dropping is the safe direction: a receipt nobody can read buys no coverage, so the window
 * gets smaller. It is still counted and said out loud, because a report that silently
 * ignored half its evidence and came back verified would be the failure in miniature.
 */
function witnessedAt(receipts) {
  const problems = [];
  const points = [];
  receipts.forEach((r, i) => {
    if (!r || typeof r !== 'object' || !TYPES.at.ok(r.received)) {
      problems.push(`receipt ${i} carries no readable \`received\`, so it witnesses no instant and was left out`);
      return;
    }
    points.push(Date.parse(r.received));
  });
  points.sort((a, b) => a - b);
  return { points: points.filter((p, i) => i === 0 || p !== points[i - 1]), problems };
}

/** The local records' own stamps, sorted — used only to say *why* a gap is a gap. */
function recordedAt(records) {
  return records
    .filter((r) => r && typeof r === 'object' && TYPES.at.ok(r.at))
    .map((r) => Date.parse(r.at))
    .sort((a, b) => a - b);
}

/** How many stamps fall inside `[a, b)` — the half-open interval, so a boundary counts once. */
const within = (stamps, a, b) => stamps.filter((s) => s >= a && s < b).length;

/**
 * Why this interval could not be verified, in a sentence that names the gap *and* the
 * reason for it.
 *
 * The distinction being drawn is the bead's: an outage and a silence read identically in
 * the published record and are entirely different events, and the local chain is what tells
 * them apart. Records stamped inside a gap mean the instance kept working — fail open did
 * what it says — and those records were witnessed late or not at all. No records inside it
 * means there is nothing to witness late, and the interval is silence rather than a queue.
 */
function gapWhy({ from, to, points, stamps }) {
  const span = duration(to - from);
  const inside = within(stamps, from, to);

  const where = !points.length
    ? 'nothing has been witnessed at all, so no part of this window is corroborated'
    : to <= points[0]
      ? `nothing had been witnessed before ${stamp(points[0])}`
      : from >= points[points.length - 1]
        ? `nothing has been witnessed since ${stamp(points[points.length - 1])}`
        : 'no publication was witnessed across it';

  const witnessedLater = points.some((p) => p >= to);
  const queue = !inside
    ? 'nothing was recorded here either, so the interval is silence rather than a queue'
    : witnessedLater
      ? `the instance kept working — ${inside} record(s) are stamped inside it and were witnessed only afterwards`
      : `the instance kept working — ${inside} record(s) are stamped inside it and are still unwitnessed`;

  return `${span} unverified: ${where}, and ${queue}`;
}

/**
 * Whether a window may be claimed, interval by interval — the continuity report.
 *
 * `ledger` is `{ records, receipts }`, which is exactly the shape lib/witness.js keeps, so
 * the service can hand its own ledger straight in and an instance that has retained what
 * came back from `publish` can hand in the same shape. Neither array is required and
 * neither is trusted: receipts decide coverage, records only ever explain a gap, and
 * anything that is not a receipt or not a record is left out and reported.
 *
 * The window is two instants and a staleness budget, because a report that read the clock
 * itself could not be run twice with the same answer — and a continuity report that cannot
 * be reproduced is not evidence of anything.
 */
export function continuity(ledger, { from, to, tolerance = TOLERANCE_MS } = {}) {
  if (!TYPES.at.ok(from) || !TYPES.at.ok(to))
    throw new Error(`a continuity window is two UTC instants, such as 2026-08-15T17:48:35Z — got ${from} to ${to}`);
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (end <= start) throw new Error(`a window ends after it begins, and ${to} does not come after ${from}`);
  if (!Number.isSafeInteger(tolerance) || tolerance <= 0)
    throw new Error(`tolerance is a whole number of milliseconds greater than zero, and ${tolerance} is not one`);

  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const { points, problems } = witnessedAt(Array.isArray(ledger?.receipts) ? ledger.receipts : []);
  const stamps = recordedAt(records);

  // The raw spans, over the whole timeline rather than the window, so an interval that
  // straddles an edge is decided by the witnesses either side of it and then clipped —
  // clipping first would hide the bracket that decides it.
  const spans = [];
  if (!points.length) spans.push({ verified: false, from: start, to: end, gap: end - start });
  else {
    if (start < points[0]) spans.push({ verified: false, from: start, to: points[0], gap: points[0] - start });
    for (let i = 0; i < points.length - 1; i++) {
      const gap = points[i + 1] - points[i];
      spans.push({ verified: gap <= tolerance, from: points[i], to: points[i + 1], gap });
    }
    const last = points[points.length - 1];
    // The trailing concession, and the only one: the end of the window stands in for the
    // bracket the next publication will supply, for at most `tolerance` and no longer.
    if (end > last) spans.push({ verified: end - last <= tolerance, from: last, to: end, gap: end - last });
  }

  const clipped = spans
    .map((s) => ({ ...s, from: Math.max(s.from, start), to: Math.min(s.to, end) }))
    .filter((s) => s.to > s.from);

  // Merged after clipping and annotated after merging: a `why` written per raw span would
  // describe a fragment of the interval a reader is shown, which is how a report acquires
  // three sentences about one outage.
  const merged = [];
  for (const s of clipped) {
    const prev = merged[merged.length - 1];
    if (prev && prev.verified === s.verified) {
      prev.to = s.to;
      prev.gap = Math.max(prev.gap, s.gap);
    } else merged.push({ ...s });
  }

  const intervals = merged.map((s) => {
    const ms = s.to - s.from;
    return Object.freeze({
      verified: s.verified,
      from: stamp(s.from),
      to: stamp(s.to),
      ms,
      duration: duration(ms),
      records: within(stamps, s.from, s.to),
      why: s.verified
        ? `${duration(ms)} continuously witnessed — never more than ${duration(s.gap)} between publications`
        : gapWhy({ from: s.from, to: s.to, points, stamps }),
    });
  });

  const unverifiedMs = intervals.filter((i) => !i.verified).reduce((n, i) => n + i.ms, 0);
  const verifiedMs = intervals.filter((i) => i.verified).reduce((n, i) => n + i.ms, 0);

  return Object.freeze({
    from: stamp(start),
    to: stamp(end),
    ms: end - start,
    duration: duration(end - start),
    tolerance,
    // `unverified` rather than `unmet`, and the same three words lib/publishable.js mints a
    // criterion with: a window nobody could check is not a window that failed a check, and
    // rounding the two together loses the distinction at the point it is being relied on.
    state: unverifiedMs === 0 ? 'verified' : 'unverified',
    verifiedMs,
    unverifiedMs,
    coverage: verifiedMs / (end - start),
    witnessed: points.length,
    records: records.length,
    intervals: Object.freeze(intervals),
    problems: Object.freeze(problems),
  });
}

/**
 * Everything wrong with claiming this window, as sentences — empty means it may be claimed.
 *
 * The same shape `claimProblems` in lib/operator.js has, and for the same reason: a claim
 * is refused by a function that says what is missing, rather than permitted by a flag
 * somebody set. There is no argument here for *how much* of a window may be unverified,
 * because there is no honest one — a Type II window is only as good as its densest gap,
 * and 99% coverage with a six-hour hole in March is a window with a six-hour hole in March.
 */
export function claimProblems(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.intervals))
    return ['there is no continuity report to claim over, and an unread window is not a clean one'];

  const problems = [...(report.problems ?? [])];
  const gaps = report.intervals.filter((i) => !i.verified);
  if (gaps.length) {
    problems.push(
      `${gaps.length} unverified interval(s) totalling ${duration(report.unverifiedMs)} of a ${report.duration} window — ` +
        'a period that was never published is an absence of evidence rather than evidence that nothing happened, ' +
        'so this window is unverified rather than compliant'
    );
    for (const gap of gaps) problems.push(`${gap.from} to ${gap.to}: ${gap.why}`);
  }
  return problems;
}
