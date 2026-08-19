/**
 * The incident lifecycle: how bad it was, how long we said we would take, whether we
 * took it, and what we learned.
 *
 * `lib/errors.js` already does the hard, unglamorous half — an error becomes a P0 bead
 * the moment it happens, deduped, with the stack on it. Detection and recording are the
 * same act here, which is further than most incident programmes ever get: theirs is a
 * document describing a process that runs when somebody remembers to run it.
 *
 * What that leaves missing is everything an auditor asks *after* "do you detect them":
 *
 * - **A severity.** A daemon that exited and a toast on one phone are both `app-error`,
 *   and treating them alike means either everything is an emergency or nothing is.
 * - **A clock, against a commitment made in advance.** "We respond promptly" is not a
 *   control. "P1 acknowledged within 15 minutes, resolved within 4 hours" is one, and it
 *   is only a control if the number was written down before the incident rather than
 *   after it.
 * - **A communication step** — who is told, and by when.
 * - **A post-incident review** for the ones that were bad enough, which is the step that
 *   turns an incident into a change in the risk register instead of a bad afternoon.
 *
 * **THE CLOCK IS READ, NEVER WRITTEN, AND THAT IS THE WHOLE DESIGN.** Nothing in here
 * stamps a timestamp of its own. `created_at` is when the error filed itself, `started_at`
 * is when a session claimed the bead, `closed_at` is when it closed — three timestamps bd
 * already keeps, written by people and agents doing their ordinary work with no idea an
 * auditor will ever read them. That is exactly what makes them evidence: a log kept
 * *for* the audit is a log somebody maintains, and a log somebody maintains is a log
 * that gets maintained the week before the audit. See `clockFor`.
 *
 * So the acknowledgement is `bd update --claim`, which every worker session runs as its
 * third line, and the resolution is the merge queue closing the bead. Neither was built
 * for this and neither has to change.
 *
 * **What this module deliberately does not do is talk to anybody.** `communicationFor`
 * says who must be told and within what window; it does not send anything. Two reasons,
 * and the second is the real one. The bead *is* the notification for a single-tenant
 * daemon — a P0 lands on the inbox the phone is already polling. And the interesting half
 * of a communication commitment belongs to a different system entirely: **bc-228x settled
 * that the system a SOC 2 report here is written about is Climative's Energy Navigator /
 * Insights, and beadcause is carved out of it.** So the user entities who must be told
 * within a contractual window are NYSERDA and TD, the windows are in agreements this repo
 * does not hold, and the obligation is carried as a gap against `SOC2.CC7.4` in
 * lib/gapassessment.js rather than guessed at here. A commitment stated on the bead and
 * measured is worth having for the daemon; a notification list for somebody else's
 * contract is not this module's to invent. See {@link SCOPE}.
 *
 * **The criteria are named here, and minted nowhere.** {@link CRITERIA} says which SOC 2
 * criterion each part of this answers, in ids lib/controls.js holds — and this module does
 * not import it. That is the leaf discipline lib/servicescope.js keeps for the same
 * reason: a register that pulls the corpus in stops being readable in a release where the
 * corpus is not there, and the place to resolve the ids is the test, which is exactly what
 * test/incident.mjs does. Only the SOC 2 ids appear. The corpus already carries the
 * ISO 27001 and 42001 edges *into* them — `A.5.26` names `SOC2.CC7.4`, `A.5.27` names
 * `SOC2.CC7.5` — so `satisfiedBy` answers the three-framework question from one edge set,
 * and restating those counterparts here would be the second crosswalk bc-4r10.1 exists to
 * prevent.
 */

/** The class label. `bd list --label incident --status=…closed` is the incident register. */
export const INCIDENT_LABEL = 'incident';

/** The label a post-incident review carries, so the register can see whether one exists. */
export const REVIEW_LABEL = 'post-incident-review';

/** `pir:<incident id>` — which incident a review is the review of. */
export const REVIEW_OF_PREFIX = 'pir:';

/**
 * **Which system this register is about, and which one it is not.**
 *
 * The distinction an auditor asks first and the one a compliance module is likeliest to
 * blur. Everything below measures **beadcause** — the daemon, its sweeps, its surfaces —
 * and beadcause is carved out of the system a SOC 2 report here describes. A daemon crash
 * is not an incident in Energy Navigator / Insights, and a register that let itself be
 * read as if it were would be evidence for a control that does not exist.
 *
 * Carved out of the description is not out of the audit, which is the other half people
 * get wrong: lib/boundary.js records the carve-out with a `bearsOn` naming CC8.1, and
 * `held` below names where the described system's own CC7 obligation is tracked instead —
 * a gap row, not a silence, because a criterion with nothing written under it is
 * indistinguishable from one nobody looked at.
 */
export const SCOPE = Object.freeze({
  covers: 'beadcause — the control daemon, its sweeps and the surfaces it serves',
  carvedOutOf: 'Climative Energy Navigator / Insights — the system a SOC 2 report here is written about',
  settledBy: 'bc-228x',
  held:
    'The described system\'s CC7 is a Climative-held gap: lib/gapassessment.js carries the SOC2.CC7.1–CC7.5 rows, ' +
    'and the breach-notification windows that CC7.4 turns on are in the NYSERDA and TD agreements.',
});

/**
 * **What this register answers, criterion by criterion — for the system {@link SCOPE}
 * covers and no other.**
 *
 * Ids only, and they are lib/controls.js's. See the header for why this module names them
 * without importing the corpus, and why the ISO counterparts are deliberately absent.
 *
 * `SOC2.CC7.1` is not here: its half that this programme actually performs is dependency
 * scanning, and that lives in lib/vulnscan.js with its own `CRITERIA`. Splitting one
 * criterion across two modules is fine; claiming it twice would not be.
 */
export const CRITERIA = Object.freeze([
  Object.freeze({
    id: 'SOC2.CC7.2',
    by: 'lib/errors.js',
    how:
      'Every uncaught exception, unhandled rejection, sweep failure and reported page error becomes a deduped P0 ' +
      'bead the moment it happens, with the stack on it. Detection and recording are one act, so there is no ' +
      'separate monitoring system whose own silence has to be monitored.',
  }),
  Object.freeze({
    id: 'SOC2.CC7.3',
    by: 'severityOf, escalated, incidentLabels',
    how:
      'The determination that an event is an incident and how bad it is, recorded on the bead as a label from a ' +
      'closed vocabulary — so an id nobody minted is a refusal rather than a row that sorts first. Volume ' +
      'escalates a severity and can never manufacture a sev1, which is a statement that the process died.',
  }),
  Object.freeze({
    id: 'SOC2.CC7.4',
    by: 'commitmentFor, communicationFor, clockFor, breaches, exerciseBead',
    how:
      'The commitment is stated in advance and on the bead, and the clock is read off created_at, started_at and ' +
      'closed_at rather than stamped for the record. `breaches` is the exceptions list for a period, and ' +
      '`exerciseBead` is the tabletop that stops the plan being a document nobody has run.',
  }),
  Object.freeze({
    id: 'SOC2.CC7.5',
    by: 'reviewsOwed, reviewBead',
    how:
      'A resolved incident at or above `reviewFrom` owes a post-incident review, as a bead the register can see ' +
      'the absence of. Its fourth question is whether the risk register moves, which is the step that makes ' +
      'recovery change something rather than end.',
  }),
]);

/**
 * Everything wrong with a crosswalk, as sentences — the shape half, which needs no corpus.
 *
 * Run at import over {@link CRITERIA} and thrown, the discipline lib/controls.js,
 * lib/boundary.js and lib/servicescope.js all use: an enumeration that could ship broken
 * is one that answers "this is covered" on the machine reporting what is covered. Whether
 * each id *resolves* is the corpus's question and is asserted in test/incident.mjs, where
 * importing lib/controls.js costs this module nothing.
 */
export function crosswalkProblems(rows = CRITERIA, where = 'lib/incident.js') {
  if (!Array.isArray(rows)) return [`${where}: the crosswalk is a list of rows`];
  const problems = [];
  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    const at = `${where} row ${i}${r?.id ? ` (${r.id})` : ''}`;
    for (const field of ['id', 'by', 'how']) {
      if (!String(r?.[field] || '').trim()) problems.push(`${at}: "${field}" is empty`);
    }
    const id = String(r?.id || '').trim();
    // A framework token, then the criterion, then its number — at least two dots. The
    // point of insisting is the id with the framework left off: `CC7.4` reads perfectly
    // to a person and resolves in no corpus, which is the one mistake a crosswalk can
    // make that still looks like a crosswalk.
    if (id && !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9]+(\.[A-Za-z0-9]+)+$/.test(id)) {
      problems.push(`${at}: "${id}" is not the shape of a corpus control id, such as SOC2.CC7.4`);
    }
    if (id && seen.has(id)) {
      problems.push(`${at}: ${id} is claimed twice — two rows for one criterion is two answers to one question`);
    }
    seen.add(id);
    for (const name of Object.keys(r || {})) {
      if (!['id', 'by', 'how'].includes(name)) problems.push(`${at}: "${name}" is not part of a crosswalk row`);
    }
  }
  return problems;
}

{
  const problems = crosswalkProblems();
  if (problems.length) throw new Error(`lib/incident.js crosswalk is broken:\n  - ${problems.join('\n  - ')}`);
}

/** How long a minute is, so the arithmetic below reads as arithmetic. */
const MIN_MS = 60_000;

/**
 * **The closed severity vocabulary.** Four, ordered worst-first, and an id nobody minted
 * is a refusal rather than a warning — the same rule the requirements corpus is built on
 * and for the same reason: a severity scale you can add to at the moment of the incident
 * is a scale that says whatever the person filing wanted it to say.
 *
 * The distinctions are about **impact**, not about how alarming the stack looked. That is
 * why `sev1` is not "an uncaught exception": an uncaught exception in a worker script is
 * one script; an uncaught exception in the daemon takes the daemon down, and `lib/crash.js`
 * exits 1 immediately after filing. The classifier below reads the *kind* the reporter
 * gave, and the kinds are exactly the ones the two reporters emit.
 *
 * The default minutes are the commitment, and they are in code rather than only in config
 * on purpose: an installation that has never configured anything still has a stated
 * commitment it can be measured against. `cfg.incidents` overrides any of them.
 */
export const SEVERITIES = [
  {
    id: 'sev1',
    rank: 1,
    name: 'down',
    means: 'the daemon is not running — nothing works until it is back',
    acknowledge: 15,
    resolve: 240,
    tell: 'Adam, immediately — and the bead is a P0 on the inbox the phone polls',
  },
  {
    id: 'sev2',
    rank: 2,
    name: 'degraded',
    means: 'the daemon is up and a function of it has stopped working',
    acknowledge: 60,
    resolve: 1440,
    tell: 'Adam, within the hour, on the inbox',
  },
  {
    id: 'sev3',
    rank: 3,
    name: 'broken surface',
    means: 'one page or one action is broken for whoever is looking at it',
    acknowledge: 1440,
    resolve: 10_080,
    tell: 'nobody in particular — it is on the board',
  },
  {
    id: 'sev4',
    rank: 4,
    name: 'handled',
    means: 'the app caught it and said so; something did not work and nothing was lost',
    acknowledge: 10_080,
    resolve: 43_200,
    tell: 'nobody — it is on the board',
  },
];

const BY_ID = new Map(SEVERITIES.map((s) => [s.id, s]));

/** The severity a report gets when its kind is not one we know. See `severityOf`. */
export const UNKNOWN_SEVERITY = 'sev3';

/** At and above this severity (i.e. this rank or worse), a resolved incident owes a review. */
export const DEFAULT_REVIEW_FROM = 'sev2';

/** Occurrences of one fingerprint before it escalates a level. See `escalated`. */
export const DEFAULT_ESCALATE_AT = 10;

/**
 * A severity id → its record, or a throw.
 *
 * The refusal is the point. Everything that reads a severity off a bead label goes
 * through here, so a bead carrying `sev0` because somebody typed it by hand is a loud
 * failure in the register rather than a row that silently sorts first.
 */
export function requireSeverity(id) {
  const found = BY_ID.get(String(id || '').trim().toLowerCase());
  if (!found) {
    throw new Error(`no such severity: ${JSON.stringify(id)} — the vocabulary is ${SEVERITIES.map((s) => s.id).join(', ')}`);
  }
  return found;
}

/** The same lookup for a caller that would rather have null than a throw. */
export function severity(id) {
  return BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

/**
 * **What a report's `kind` says about how bad this is.**
 *
 * The two reporters between them emit nine kinds and no more: `public/report.js` sends
 * `error`, `rejection`, `fetch`, `sw`, `toast` and `manual`; `lib/crash.js` sends
 * `uncaughtException`, `unhandledRejection` and `daemon sweep — <label>`. Each is mapped
 * by what it *implies about the system*, not by how it was thrown:
 *
 * - **`uncaughtException` / `unhandledRejection`** are `sev1` and nothing else can be.
 *   Those two arrive only from `installCrashHandlers`, which prints the stack and then
 *   exits 1 — by the time the bead is written the daemon is going down. That is the one
 *   fact about impact this system can know for certain, and it is why volume can never
 *   escalate anything *to* `sev1` (see `escalated`): a `sev1` is a statement that the
 *   process died, not a statement that something happened a lot.
 * - **`daemon sweep — …`** is `sev2`. A background sweep that threw was caught, logged,
 *   and the daemon carried on — so the service is up and one of its functions has
 *   silently stopped. That is the definition of degraded, and it is the failure mode
 *   nobody notices without a bead, because carrying on is what it looks like.
 * - **`fetch`** is `sev2` as well, and this is the least obvious one. The browser only
 *   reports a fetch failure when the daemon did not answer or answered 5xx; from the
 *   phone's side that is indistinguishable from the daemon being down, and it is a
 *   backend fault rather than a page fault.
 * - **`error`, `rejection`, `sw`** are `sev3`: a page, or the service worker behind it,
 *   is broken for whoever is looking at it. The daemon is fine.
 * - **`toast`, `manual`** are `sev4`: the app caught this and told you about it. It is
 *   worth a bead — that is the whole of bc-p38c — and it is not an outage.
 *
 * **An unrecognised kind is `sev3`, not `sev4`**, and that direction is deliberate. A
 * report whose kind we do not know is one we cannot say is harmless, and the cheaper
 * mistake is the one that puts a middling bead on the board rather than the one that
 * quietly buries something with a 30-day commitment on it.
 */
export function severityOf(report = {}) {
  const kind = String(report?.kind || '').trim().toLowerCase();
  if (kind === 'uncaughtexception' || kind === 'unhandledrejection') return BY_ID.get('sev1');
  if (kind.startsWith('daemon sweep')) return BY_ID.get('sev2');
  if (kind === 'fetch') return BY_ID.get('sev2');
  if (kind === 'error' || kind === 'rejection' || kind === 'sw') return BY_ID.get('sev3');
  if (kind === 'toast' || kind === 'manual') return BY_ID.get('sev4');
  return BY_ID.get(UNKNOWN_SEVERITY);
}

/**
 * **The same bug, over and over, is worse than the same bug once.**
 *
 * A `sev3` that has happened three times is a `sev3`. One that has happened forty times
 * since Tuesday is a surface nobody can use, and reading it as "one broken page" is how a
 * real outage hides behind a low number for a week. So past a threshold the severity goes
 * up one level.
 *
 * **The ceiling is `sev2` and it is load-bearing.** `sev1` means the process died, which
 * is a fact `lib/crash.js` knows and a counter does not; letting volume manufacture one
 * would make the most serious thing in the register the least trustworthy. A `sev1` is
 * always a `sev1` already, so the clamp costs nothing real.
 */
export function escalated(sev, { occurrences = 0, escalateAt = DEFAULT_ESCALATE_AT } = {}) {
  const from = typeof sev === 'string' ? requireSeverity(sev) : sev || BY_ID.get(UNKNOWN_SEVERITY);
  const at = Number(escalateAt);
  if (!Number.isFinite(at) || at <= 0) return from;
  if (Number(occurrences) < at) return from;
  // The clamp is a floor on the *rank*, so it can neither reach sev1 nor — the mistake
  // this spells out — quietly demote one. `Math.max(2, rank - 1)` reads as the same thing
  // and turns a sev1 into a sev2 the first time one recurs.
  if (from.rank <= 2) return from;
  return SEVERITIES.find((s) => s.rank === from.rank - 1) || from;
}

/** Every label an incident bead carries. `incident` is the register; the id is the sort key. */
export function incidentLabels(sev) {
  const s = typeof sev === 'string' ? requireSeverity(sev) : sev;
  return [INCIDENT_LABEL, s.id];
}

/**
 * The severity a bead is carrying, or null.
 *
 * Null rather than a throw for the one case that is not anybody's mistake: a bead filed
 * before this existed carries `app-error` and no severity at all, and the register has to
 * be able to say so rather than fall over on the history. A label that *is* severity-shaped
 * and unknown is still a throw, via `requireSeverity` — that one is a typo, not history.
 */
export function severityFromLabels(labels = []) {
  const list = (labels || []).map((l) => String(l || '').trim().toLowerCase());
  const found = list.find((l) => /^sev\d+$/.test(l));
  return found ? requireSeverity(found) : null;
}

/**
 * **The commitment**: how long we said we would take, for this severity, on this install.
 *
 * `cfg.incidents.sev2 = { acknowledge: 30 }` overrides one number and leaves the rest,
 * because a half-configured commitment must not silently become no commitment. Both
 * numbers are clamped to at least a minute: a zero would make every incident breached at
 * the moment it was filed, which is the shape of a control that gets turned off.
 */
export function commitmentFor(sev, config = null) {
  const s = typeof sev === 'string' ? requireSeverity(sev) : sev;
  const over = config?.incidents?.[s.id] || {};
  const minutes = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : fallback;
  };
  return {
    severity: s.id,
    name: s.name,
    means: s.means,
    tell: s.tell,
    acknowledge: minutes(over.acknowledge, s.acknowledge),
    resolve: minutes(over.resolve, s.resolve),
  };
}

/** Who is told, and by when — stated, measured, and not dispatched. See the header. */
export function communicationFor(sev, config = null) {
  const c = commitmentFor(sev, config);
  return { who: c.tell, withinMinutes: c.acknowledge };
}

/** Which severity, and worse, owes a review once it is resolved. */
export function reviewFrom(config = null) {
  const want = config?.incidents?.reviewFrom;
  return want ? requireSeverity(want) : requireSeverity(DEFAULT_REVIEW_FROM);
}

const stamp = (value) => {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
};

const minutesBetween = (from, to) => (from == null || to == null ? null : Math.max(0, Math.round((to - from) / MIN_MS)));

/**
 * **One incident bead → its whole clock**, from three timestamps bd was already keeping.
 *
 * - **`detected`** is `created_at`. For this system detection and recording are one act,
 *   so there is no separate "when did you notice" to be wrong about.
 * - **`acknowledged`** is `started_at` — the moment somebody or something claimed it.
 *   Every worker session runs `bd update --claim` as its third line and the advocate does
 *   it for an unclaimed bead, so this is stamped by the ordinary work rather than for the
 *   record.
 * - **`resolved`** is `closed_at`, which the merge queue writes when the fix lands.
 *
 * **`met` is three-valued and that matters.** `true` met the commitment, `false` missed
 * it, and `null` means *not yet, and not yet late* — an incident filed ninety seconds ago
 * has not missed a 15-minute acknowledgement and must not be counted as if it had. Only
 * `false` is a breach; a period report that folded `null` into `false` would show a
 * hundred per cent breach rate every time it was run during an incident.
 *
 * The severity may be passed in — the caller sometimes knows it from the report it is
 * about to file — and is otherwise read off the labels. A bead with no severity gets the
 * unknown default so the register can still hold it, and says so via `classified: false`.
 */
export function clockFor(row = {}, { now = Date.now(), config = null, severity: given = null } = {}) {
  const found = given ? (typeof given === 'string' ? requireSeverity(given) : given) : severityFromLabels(row.labels);
  const sev = found || requireSeverity(UNKNOWN_SEVERITY);
  const commitment = commitmentFor(sev, config);

  const detected = stamp(row.created_at);
  const acknowledged = stamp(row.started_at);
  // A bead can close without ever having been claimed — a duplicate, or a fix that landed
  // under another bead's pull request. Closing is an acknowledgement by any reading, so it
  // stands in rather than leaving the bead as never-acknowledged forever.
  const resolved = stamp(row.closed_at) ?? (row.status === 'closed' ? stamp(row.updated_at) : null);
  const ackAt = acknowledged ?? resolved;

  const ackDue = detected == null ? null : detected + commitment.acknowledge * MIN_MS;
  const resolveDue = detected == null ? null : detected + commitment.resolve * MIN_MS;

  const verdict = (at, due) => {
    if (due == null) return null;
    if (at != null) return at <= due;
    return now > due ? false : null;
  };

  const ackMet = verdict(ackAt, ackDue);
  const resolveMet = verdict(resolved, resolveDue);
  const s = reviewFrom(config);

  return {
    id: row.id || '',
    title: row.title || '',
    status: row.status || '',
    severity: sev.id,
    rank: sev.rank,
    classified: Boolean(found),
    commitment,
    detected,
    acknowledged: ackAt,
    resolved,
    ackDue,
    resolveDue,
    ackMinutes: minutesBetween(detected, ackAt ?? now),
    resolveMinutes: minutesBetween(detected, resolved ?? now),
    ackMet,
    resolveMet,
    breached: ackMet === false || resolveMet === false,
    open: resolved == null,
    // Owed the moment it is resolved, not the moment somebody remembers. `reviewedBy` is
    // filled in by `register` once it can see whether the review bead exists.
    reviewOwed: resolved != null && sev.rank <= s.rank,
    reviewedBy: '',
  };
}

/**
 * **The register**: every incident bead, resolved ones included, each with its clock.
 *
 * Closed rows are not optional here and that is the difference between a register and a
 * queue. An incident register that drops incidents when they are fixed can evidence
 * nothing at all — the question an auditor asks is "of the incidents in the period, how
 * many met the commitment", and every one of those is closed by the time they ask. Feed
 * it `bd.listLabelAny(ws, 'incident')`, which is the one call that keeps them.
 *
 * The review beads arrive in the same list (they carry `incident` too, so that one call
 * stays one call) and are pulled out here rather than counted as incidents of their own —
 * and so do the tabletop exercises, for exactly the same reason. **Neither is an
 * incident**, and counting either as one would inflate every number in the period report
 * with the paperwork *about* the incidents: a bad month would look worse for having been
 * reviewed properly, which is precisely backwards.
 */
const isPaperwork = (row) => {
  const labels = row?.labels || [];
  return labels.includes(REVIEW_LABEL) || labels.includes(EXERCISE_LABEL);
};

export function register(rows = [], { now = Date.now(), config = null } = {}) {
  const all = (rows || []).filter(Boolean);
  const reviews = all.filter((r) => (r.labels || []).includes(REVIEW_LABEL));
  const reviewOf = new Map();
  for (const r of reviews) {
    const label = (r.labels || []).find((l) => String(l).startsWith(REVIEW_OF_PREFIX));
    if (label) reviewOf.set(String(label).slice(REVIEW_OF_PREFIX.length), r.id);
  }
  const clocks = all
    .filter((r) => !isPaperwork(r))
    .map((r) => {
      const clock = clockFor(r, { now, config });
      clock.reviewedBy = reviewOf.get(clock.id) || '';
      return clock;
    });
  // Worst first, then oldest — the same order the advocate's queue uses, because the
  // question this list answers is "what is on fire" before it is "what happened".
  clocks.sort((a, b) => a.rank - b.rank || (a.detected || 0) - (b.detected || 0) || String(a.id).localeCompare(String(b.id)));
  return clocks;
}

/** The ones past a commitment right now — acknowledged late, or not resolved in time. */
export function breaches(clocks = []) {
  return clocks.filter((c) => c.breached);
}

/** Resolved, bad enough to owe a review, and no review bead exists. */
export function reviewsOwed(clocks = []) {
  return clocks.filter((c) => c.reviewOwed && !c.reviewedBy);
}

/**
 * **The evidence**: of the incidents detected in a period, what actually happened.
 *
 * This is the number an auditor samples and the reason none of it is asserted: every
 * count below is derived from bd's own timestamps, and re-running this over the same
 * window a year later gives the same answer. `from` and `to` bound by *detection*, not by
 * resolution — an incident belongs to the period it happened in, not the period it was
 * finally closed in, or a bad week could be moved out of the window by taking longer.
 *
 * `pending` is counted apart from `met` and `missed` for the reason `clockFor` explains:
 * an incident that is inside its window and still open has neither met nor missed
 * anything yet, and folding it either way is a lie in one direction or the other.
 */
export function periodEvidence(clocks = [], { from = null, to = null } = {}) {
  const lo = from == null ? -Infinity : (typeof from === 'number' ? from : Date.parse(from));
  const hi = to == null ? Infinity : (typeof to === 'number' ? to : Date.parse(to));
  const inPeriod = clocks.filter((c) => c.detected != null && c.detected >= lo && c.detected <= hi);

  const tally = (pick) => ({
    met: inPeriod.filter((c) => pick(c) === true).length,
    missed: inPeriod.filter((c) => pick(c) === false).length,
    pending: inPeriod.filter((c) => pick(c) === null).length,
  });

  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s.id] = inPeriod.filter((c) => c.severity === s.id).length;

  const owed = inPeriod.filter((c) => c.reviewOwed);
  return {
    from: lo === -Infinity ? null : lo,
    to: hi === Infinity ? null : hi,
    total: inPeriod.length,
    bySeverity,
    acknowledgement: tally((c) => c.ackMet),
    resolution: tally((c) => c.resolveMet),
    unclassified: inPeriod.filter((c) => !c.classified).length,
    reviews: { owed: owed.length, done: owed.filter((c) => c.reviewedBy).length },
    open: inPeriod.filter((c) => c.open).length,
    breached: inPeriod.filter((c) => c.breached).length,
  };
}

const hhmm = (minutes) => {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '—';
  if (n < 90) return `${n} min`;
  if (n < 60 * 48) return `${Math.round(n / 60)}h`;
  return `${Math.round(n / (60 * 24))}d`;
};

/** How long it took, or how long it has been — for a table where the two look the same. */
export const humanMinutes = hhmm;

/**
 * The paragraph that goes on the incident bead itself, stating the commitment.
 *
 * On the bead rather than only in the config, because the commitment has to have been
 * knowable *at the time* for the measurement to mean anything, and a number nobody could
 * see is a number that can be edited afterwards. This is the same argument as writing the
 * fingerprints into the description in readable form: the label is for lookup, the prose
 * is for the person reading it three weeks later.
 */
export function commitmentNote(sev, config = null) {
  const c = commitmentFor(sev, config);
  return [
    `**Severity ${c.severity}** — ${c.means}.`,
    '',
    '| | |',
    '|---|---|',
    `| **Acknowledge by** | ${hhmm(c.acknowledge)} after it was detected — claiming this bead is the acknowledgement |`,
    `| **Resolve by** | ${hhmm(c.resolve)} after it was detected — closing this bead is the resolution |`,
    `| **Who is told** | ${c.tell} |`,
    '',
    '_The clock is read off this bead: `created_at` detected it, `started_at` acknowledged it, `closed_at` ' +
      'resolved it. Nothing has to be maintained for the record — see lib/incident.js._',
  ].join('\n');
}

/** The label a tabletop exercise carries, so it is findable and countable. See `exerciseBead`. */
export const EXERCISE_LABEL = 'incident-exercise';

/**
 * **The scenarios worth walking, drawn from what this system actually does.**
 *
 * A response plan that has never been run is an exception waiting to happen, and the
 * cheapest fix for that is not a better plan — it is one hour spent walking a scenario
 * with somebody writing down what everybody could not answer. These three are chosen
 * because each breaks a *different* assumption the machinery above quietly makes.
 */
export const EXERCISES = [
  {
    id: 'night-exit',
    severity: 'sev1',
    scenario:
      'The daemon takes an uncaughtException at 02:00 and launchd restarts it into the same fault, four times. ' +
      'Nobody is awake. Walk it from the first exit to the fix being live.',
    breaks: 'that the P0 reaching the inbox is the same thing as somebody being told',
  },
  {
    id: 'silent-sweep',
    severity: 'sev2',
    scenario:
      'A background sweep has been throwing for six days and the daemon has carried on each time. Walk how ' +
      'anybody finds out, and what the acknowledgement clock says when they do.',
    breaks: 'that a degraded system looks different from a working one',
  },
  {
    id: 'no-fix-critical',
    severity: 'sev2',
    scenario:
      'A critical advisory lands against a transitive dependency with no published fix, seven days before its ' +
      'SLA expires. Walk what closing that bead honestly looks like.',
    breaks: 'that every finding has a remediation you can perform',
  },
];

/**
 * **A tabletop exercise, as a bead with a date and participants on it.**
 *
 * This is the whole of CC7.4 evidence and it costs an hour: a scenario, who was in the
 * room, what they could not answer, and what changed as a result. The bead is filed
 * *before* the exercise so it can be scheduled and so its absence is visible; the four
 * answers go on it afterwards, which is what makes the record contemporaneous rather than
 * reconstructed.
 *
 * `participants` is deliberately required by the acceptance rather than by the code — a
 * refusal would only mean the exercise gets recorded somewhere else, and the point is that
 * an exercise with nobody named is one nobody can attest to.
 */
export function exerciseBead({ scenario = '', id = '', participants = [], when = '' } = {}) {
  const known = EXERCISES.find((e) => e.id === id) || null;
  const text = String(scenario || known?.scenario || '').trim();
  if (!text) throw new Error(`no scenario — pass one, or one of: ${EXERCISES.map((e) => e.id).join(', ')}`);
  const who = (participants || []).map((p) => String(p).trim()).filter(Boolean);
  return {
    title: `Incident response exercise: ${(known?.id || text).slice(0, 80)}`,
    type: 'task',
    priority: 2,
    labels: [INCIDENT_LABEL, EXERCISE_LABEL, ...(known ? [`exercise:${known.id}`] : [])],
    description: [
      '**The scenario.** ' + text,
      '',
      known ? `It is chosen because it breaks the assumption ${known.breaks}.` : '',
      '',
      `Treat it as a **${known?.severity || 'sev2'}** and walk the commitment for that severity: who notices, how, ` +
        'how long until it is acknowledged, who is told, and what resolving it actually requires.',
      '',
      '| | |',
      '|---|---|',
      `| **When** | ${when || '_to be scheduled_'} |`,
      `| **Who was there** | ${who.length ? who.join(', ') : '_to be filled in on the day_'} |`,
      '',
      'Four things go on this bead afterwards, and the third is the one worth the hour:',
      '',
      '1. **What the walk-through said would happen**, step by step.',
      '2. **Where it stopped** — the first question nobody in the room could answer.',
      '3. **What the plan says that is not true.** Every response plan has some; the ones nobody has walked have more.',
      '4. **What changed as a result** — a bead, a commitment revised, a risk registered. If nothing changed, say so ' +
        'and say why, because "we ran an exercise and learned nothing" is a finding of its own.',
      '',
      '_An incident response plan that has never been run is an exception waiting to happen — see lib/incident.js._',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    acceptance:
      'The exercise happened on a stated date with named participants, and all four answers are on this bead — ' +
      'including the fourth, even when the answer is that nothing changed.',
    rationale: 'A plan nobody has exercised is a document. This is the cheapest thing that makes it not one.',
  };
}

/**
 * **The post-incident review, as a bead the register can see.**
 *
 * A review that lives in somebody's head, or in a document, is the thing that does not
 * happen — and worse, its absence is invisible. As a bead it is owed, it is countable,
 * and the register says how many of the ones that were owed exist.
 *
 * It carries `incident` as well as `post-incident-review` so the register is still one
 * `bd list`, and `pir:<id>` so it can be matched back without a second read.
 *
 * **The last question is the one this exists for.** A review whose output is "we fixed
 * the bug" changed nothing — the bug was already fixed, that is why the review is being
 * written. The output that matters is whether the risk register moves, and asking it as a
 * question with two answers is the cheapest way to make somebody answer it.
 */
export function reviewBead(clock, { workspace = '' } = {}) {
  const id = clock.id;
  const took = clock.resolveMinutes == null ? 'an unknown time' : hhmm(clock.resolveMinutes);
  const missed = [];
  if (clock.ackMet === false) missed.push(`acknowledged in ${hhmm(clock.ackMinutes)} against a ${hhmm(clock.commitment.acknowledge)} commitment`);
  if (clock.resolveMet === false) missed.push(`resolved in ${took} against a ${hhmm(clock.commitment.resolve)} commitment`);
  return {
    title: `Post-incident review: ${clock.title || id}`.slice(0, 140),
    type: 'task',
    priority: clock.rank <= 1 ? 1 : 2,
    labels: [INCIDENT_LABEL, REVIEW_LABEL, `${REVIEW_OF_PREFIX}${id}`],
    deps: [`discovered-from:${id}`],
    description: [
      `${id} was a **${clock.severity}** incident — ${clock.commitment.means}. It was detected at ` +
        `${clock.detected ? new Date(clock.detected).toISOString() : 'an unknown time'} and resolved ${took} later.`,
      '',
      missed.length
        ? `**It missed its commitment**: ${missed.join(', and ')}. That is the first thing this review has to explain.`
        : '**It met its commitment**, on both clocks. That is worth writing down too — a review is not only for the ones that went badly.',
      '',
      'Four questions, and the last one is the only one that changes anything:',
      '',
      '1. **What happened**, in the order it happened, from the first symptom.',
      '2. **Why it happened** — the cause, not the trigger. The trigger is on the bead already.',
      '3. **What held, and what did not.** Detection filed this in seconds; did anything else work as it was meant to?',
      '4. **Does the risk register move?** Either a risk in it now has a different likelihood or a different ' +
        'treatment, or this incident was not covered by any risk in it and one is missing. Say which, and name it.',
    ].join('\n'),
    acceptance:
      'The four questions are answered on this bead, and question 4 names either an existing risk that changed or a ' +
      'new one that has been filed.',
    rationale:
      `Owed by ${clock.severity} incident ${id}${workspace ? ` in ${workspace}` : ''}. A review nobody filed is a ` +
      'review nobody notices is missing — see lib/incident.js.',
  };
}
