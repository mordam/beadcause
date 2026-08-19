/**
 * What the service says about the population it holds — where a missing instance is
 * louder than a present one.
 *
 * This is the payoff of the whole arrangement and the answer to the question that started
 * it: what stops somebody quietly running a build with the compliance layer stripped out?
 * Nothing stops them, and nothing here pretends to. What the service does is *notice*, and
 * noticing is a different engineering problem from preventing — it is the problem of making
 * sure that the thing which happens when an instance stops publishing is a row somebody
 * reads, rather than a row that is simply not there.
 *
 * **Absence of evidence rendering as evidence of absence is the failure this file exists to
 * prevent, and it is the easiest failure in the world to ship.** Every natural way to write
 * a report iterates the things it holds. A service that iterates its ledgers cannot report
 * the instance whose ledger it no longer has, and the report it produces is not merely
 * incomplete — it is *clean*, confidently, with every row it printed correct. That is worse
 * than an error, because an error gets looked at. lib/changesample.js learned exactly this
 * against the tracker: a sample where nothing could be asked reported 47 of 47 clean, which
 * is the most confident possible way to say nothing at all, and the fix there is the fix
 * here. Clean is *every member of the population accounted for and current*, never "no
 * findings".
 *
 * **So the survey is built from the union of everything that could name an instance, and
 * every one of those sources is capable of producing a row the ledgers cannot.** The
 * ledgers the service holds; the refusals it recorded, which name instances whose *first*
 * publication was rejected and which therefore have no ledger at all; the comparisons an
 * auditor ran; and — the one that closes the loop — the previous survey. An instance in
 * last night's survey and not in this one is a `vanished` finding, at the highest severity
 * there is. Deleting a ledger to quieten a report therefore makes the report louder, and
 * that is the only defence against erasure that does not depend on the erasing party.
 * Surveys chain for the same reason records do.
 *
 * **"Within a stated interval" means the interval has to be stated, and the survey has to
 * have run.** `EXPECTED_MS` is the interval and every silence finding quotes it, because
 * "instance X is silent" is a sentence with no denominator and cannot be checked by anybody
 * who was not there. And a survey that has not run since longer than the interval raises
 * `unsurveyed` against itself: an instance can only be found silent by somebody looking,
 * so a gap between surveys is a gap in the guarantee, and it is reported in the same list
 * as everything else rather than being inferred from a missing file.
 *
 * **The second half of the bead is publication-time, and it is already refused — what was
 * missing was that it be reported.** `witnessProblems` in lib/witness.js refuses a record
 * that does not extend what the service holds; a refusal that only becomes an HTTP status
 * is an event that exists for as long as the connection does. `rejection` turns those
 * sentences into a finding with a place to live, so "rejected and reported" is two things
 * rather than one thing said twice.
 *
 * **A verdict is trusted; a flag on somebody's object is not.** `divergence` decides whether
 * a comparison is divergent by looking the verdict up in `VERDICTS`, and never by reading
 * `comparison.divergent`. The flag is derived from the same table one function earlier, so
 * consulting it would be harmless today and would be the seam by which a hand-built or
 * transported comparison could arrive pre-declared clean. A verdict this file does not
 * recognise is a finding too, because the one thing an unknown answer must never be is
 * silence.
 *
 * **`surveyProblems` is the third-party check, and it is why none of this rests on trusting
 * `surveyOf`.** Point it at a report and the inputs the report was made from and it says
 * what the report fails to account for — an instance dropped, a row marked current with
 * findings on it, a report marked clean carrying findings, a report marked clean covering
 * nobody. Same discipline as `tableProblems` in lib/publishable.js and `entryProblems` in
 * lib/evidence.js: a rule that is only ever run against inputs that pass is a rule nobody
 * has watched fire.
 *
 * Pure, and a leaf below the config directory for the same reason lib/witness.js is: the
 * far end has to be hostable somewhere that is not this Mac. No git, no filesystem, no
 * clock but the one a caller passes. It cannot mint a record either — `record`, `next` and
 * `genesis` are not imported, and `test/findings.mjs` reads this source and fails the repo
 * if they ever are. A surveyor that could author is a surveyor that could answer its own
 * question.
 *
 * What this does *not* answer is whether a period an instance *was* publishing across can
 * be claimed — linked is not continuous, and that is bc-3muu.4. Silence here is a finding
 * about the population; coverage there is a refusal about a claim. Neither substitutes for
 * the other, and rounding them together would let the weaker fact be quoted as the stronger.
 */
import { TYPES } from './publishable.js';
import { VERDICTS, ledgerProblems } from './witness.js';

/**
 * How long an enrolled instance may say nothing before that is a finding.
 *
 * Six hours, and the number is a policy rather than a measurement — which is exactly why it
 * is a named export with a sentence attached instead of a literal inside a comparison. It
 * has to be longer than an ordinary quiet stretch (a laptop shut for an afternoon, a flight,
 * a weekend of not working) or the findings are noise and a reader learns to scroll past
 * them, and short enough that a daemon somebody turned off in the morning is a question the
 * same day rather than the same quarter. A caller with a different population passes its own.
 */
export const EXPECTED_MS = 6 * 60 * 60 * 1000;

/**
 * How serious a finding is, weakest first, so a comparison is an index rather than a table.
 *
 * Two, and the line between them is *what is in doubt*. A `finding` is something to explain:
 * the record may be complete and the answer may be "the laptop was shut". A `material` one
 * puts the record itself in doubt — something the service held is gone, or the two sides
 * hold different histories, or a publication was refused because it rewrote rather than
 * extended. Same ordering trick as `ASSURANCE` in lib/operator.js.
 */
export const SEVERITIES = Object.freeze(['finding', 'material']);

/**
 * Every kind of finding, and how serious it is. A closed vocabulary, like every other table
 * in this family — `raise` is the only way to make one and it refuses a kind not listed here.
 *
 * `means` is the standing sentence, said once. The `why` on an individual finding is the
 * particular one, with the numbers in it, because a report of seven identical sentences is
 * a report nobody can act on.
 */
export const FINDINGS = Object.freeze({
  silent: Object.freeze({
    severity: 'finding',
    means: 'an enrolled instance has published nothing within the interval',
  }),
  unsurveyed: Object.freeze({
    severity: 'finding',
    means: 'nobody has surveyed the population within the interval, so nothing could have been found',
  }),
  unenrolled: Object.freeze({
    severity: 'finding',
    means: 'the service holds a chain that does not begin with an enrolment',
  }),
  vanished: Object.freeze({
    severity: 'material',
    means: 'the service no longer holds what a previous survey recorded it holding',
  }),
  rejected: Object.freeze({
    severity: 'material',
    means: 'a publication was refused because it did not extend what was already held',
  }),
  diverged: Object.freeze({
    severity: 'material',
    means: 'the instance and the service do not hold the same history',
  }),
  unsound: Object.freeze({
    severity: 'material',
    means: 'the chain the service holds does not link to itself',
  }),
  duplicated: Object.freeze({
    severity: 'material',
    means: 'the service holds more than one chain for one instance',
  }),
});

/** The kinds, in the order the table declares them. */
export const FINDING_KINDS = Object.freeze(Object.keys(FINDINGS));

/** How serious a kind is, or `null` for a name this file does not mint. */
export function severityOf(kind) {
  // `Object.hasOwn` rather than `in`: `'constructor' in FINDINGS` is true of every plain
  // object, and a closed vocabulary that admits the prototype chain is not closed. Same
  // hole lib/publishable.js very nearly shipped.
  return typeof kind === 'string' && Object.hasOwn(FINDINGS, kind) ? FINDINGS[kind].severity : null;
}

/** The worst severity in a list of findings, or `null` for a list with none. */
export function worst(findings = []) {
  let rank = -1;
  for (const f of Array.isArray(findings) ? findings : []) {
    const i = SEVERITIES.indexOf(severityOf(f?.kind));
    if (i > rank) rank = i;
  }
  return rank < 0 ? null : SEVERITIES[rank];
}

/** A duration in words a sentence can carry — "45 seconds", "12 minutes", "3.1 hours". */
function span(ms) {
  // `sinceWords` in lib/release.js is the same six lines, and is not imported on purpose:
  // that file reaches for the config directory at import, and the far end has to run
  // somewhere that has no ~/.config/beadcause to reach for. A duplicated formatter is the
  // cheaper of the two mistakes available here.
  const secs = Math.max(0, Math.round(Number(ms) / 1000)) || 0;
  if (secs < 90) return `${secs} second${secs === 1 ? '' : 's'}`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 6) / 10;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** One line of prose, flattened and bounded — nothing here is published, but nothing sprawls. */
const sentence = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);

/**
 * Make a finding, or refuse to — the one funnel, for the reason `record` is one.
 *
 * `detail` is spread *first* so the fixed fields cannot be overwritten by it. A caller
 * passing `{ severity: 'finding' }` alongside a material kind would otherwise downgrade its
 * own finding, which is the single most useful thing an attacker of this file could do, and
 * it would read in review as an ordinary spread.
 */
export function raise(kind, instance, why, at, detail = {}) {
  const severity = severityOf(kind);
  if (!severity) throw new Error(`"${kind}" is not a kind of finding — one of ${FINDING_KINDS.join(', ')}`);
  if (!TYPES.at.ok(at)) throw new Error(`a finding is stamped with ${TYPES.at.why}, and "${at}" is not one`);
  return Object.freeze({ ...detail, kind, severity, instance: instance ?? null, at, why: sentence(why) });
}

/**
 * A refused publication, as something that outlives the request that was refused.
 *
 * The reporting half of "a chain that does not extend its predecessor is rejected and
 * reported". `witnessProblems` does the rejecting and hands back sentences; a service that
 * turns those into a 400 and nothing else has an event that lives as long as a socket. The
 * refused record itself is deliberately not carried: it was refused, so the service does not
 * hold it, and a finding that quietly stores what the admission rule turned away is a second
 * copy of the vocabulary boundary nobody is checking.
 */
export function rejection(instance, seq, problems, at) {
  const list = (Array.isArray(problems) ? problems : [problems]).filter(Boolean).map((p) => sentence(p));
  const why = list.length ? list[0] : 'no reason was recorded, which is itself worth asking about';
  return raise('rejected', instance, `a publication was refused: ${why}`, at, {
    seq: Number.isSafeInteger(seq) ? seq : null,
    problems: Object.freeze(list),
  });
}

/**
 * A comparison, as a finding or as nothing at all.
 *
 * `null` for an ordinary verdict — `agreed`, `ahead`, `unwitnessed`, `nothing` — because an
 * offline laptop with a tail to send is the everyday state and reporting it as a discrepancy
 * is how a reader is trained to ignore the list. Everything else is a finding, including a
 * verdict this file has never heard of: a comparison that reaches an answer the surveyor
 * cannot classify is precisely the case where saying nothing would be worst.
 */
export function divergence(instance, comparison, at) {
  const verdict = comparison?.verdict;
  const known = typeof verdict === 'string' && Object.hasOwn(VERDICTS, verdict);
  // `comparison.divergent` is not consulted, here or anywhere. It is derived from this same
  // table inside `compare`, so reading it would be identical today and would be the seam by
  // which a comparison built anywhere else could arrive pre-declared clean.
  if (known && VERDICTS[verdict] !== true) return null;
  const why = known
    ? `${verdict} — ${comparison?.why || FINDINGS.diverged.means}`
    : `the comparison reached "${verdict}", which is not a verdict this service knows how to read`;
  return raise('diverged', instance, why, at, { verdict: known ? verdict : null });
}

/**
 * Silence, measured against the stated interval — `null` when the instance is current.
 *
 * `lastWitnessed` is the service's own clock at the moment it was told, never the `at` the
 * record carries. A record stamped an hour before it arrived is an hour nobody was watching,
 * and dating silence by the publisher's clock lets a publisher that is behind on everything
 * else also be the authority on whether it is late.
 */
export function silence({ instance, lastWitnessed = null, records = 0 } = {}, at, expect = EXPECTED_MS) {
  const interval = span(expect);
  if (!TYPES.at.ok(lastWitnessed)) {
    return raise(
      'silent',
      instance,
      records
        ? `the service holds ${records} record(s) for this instance and no receipt to date any of them by, so there is nothing that says it has published within ${interval}`
        : `nothing has ever been witnessed from this instance, and one publication every ${interval} is expected`,
      at,
      { silentFor: null, expected: expect }
    );
  }
  const quiet = Date.parse(at) - Date.parse(lastWitnessed);
  if (!(quiet > expect)) return null;
  return raise(
    'silent',
    instance,
    `last witnessed ${lastWitnessed}, ${span(quiet)} ago, and one publication every ${interval} is expected`,
    at,
    { silentFor: quiet, expected: expect }
  );
}

/** The instance a ledger belongs to, from the ledger or from the chain it holds. */
const instanceOf = (ledger) => ledger?.instance ?? (Array.isArray(ledger?.records) ? ledger.records[0]?.instance : null) ?? null;

/** A fresh row. Every source that can name an instance goes through this, so none can be the only one. */
const rowFor = (instance) => ({ instance, records: 0, seq: null, lastWitnessed: null, findings: [] });

/**
 * The survey — one row per member of the population, and the population is the union.
 *
 * Read the order the rows are gathered in rather than the arithmetic at the end: `ledgers`
 * first because that is what the service holds, then `refusals` and `comparisons` because an
 * instance can be named by either without the service holding a ledger for it, then
 * `previous` because that is the only source that can name an instance the service has
 * *stopped* holding. Take any one of the four away and there is a way for a member of the
 * population to be absent from the report instead of being reported as absent.
 *
 * Every argument is data. No clock is read, nothing is fetched, and `at` is required rather
 * than defaulted, because a survey is a claim about a moment and a surveyor that supplies
 * its own moment is a surveyor that cannot be replayed by an auditor holding the same inputs.
 */
export function surveyOf({ ledgers = [], refusals = [], comparisons = [], previous = null, at, expect = EXPECTED_MS } = {}) {
  if (!TYPES.at.ok(at)) throw new Error(`a survey is stamped with ${TYPES.at.why}, and "${at}" is not one`);
  if (!Number.isFinite(expect) || expect <= 0) throw new Error(`the expected interval is a positive number of milliseconds, and ${expect} is not one`);

  const rows = new Map();
  /**
   * The row for an instance, made if it is not there yet.
   *
   * A ledger that names no instance gets a row of its own rather than sharing one, because
   * collapsing two anonymous ledgers into a single row is a row disappearing — the thing
   * this whole file is written to prevent, arriving by way of a Map key.
   */
  let anonymous = 0;
  const row = (instance) => {
    const key = instance ?? `anonymous#${(anonymous += 1)}`;
    if (!rows.has(key)) rows.set(key, rowFor(instance ?? null));
    return rows.get(key);
  };

  /* ------------------------------------------------------ what the service holds now */

  /** Every instance the service actually holds a chain for — the answer `previous` is read against. */
  const held = new Set();

  for (const ledger of Array.isArray(ledgers) ? ledgers : []) {
    const instance = instanceOf(ledger);
    const r = row(instance);
    const records = Array.isArray(ledger?.records) ? ledger.records : [];
    const receipts = Array.isArray(ledger?.receipts) ? ledger.receipts : [];
    // A second ledger for an instance already seen is *added to* rather than written over.
    // One row per instance is the whole shape of the report, and the natural way to write
    // this loop — assign, unconditionally — makes a duplicate chain vanish into the one
    // before it. An instance has one chain; two is a finding, not an overwrite.
    if (instance && held.has(instance)) {
      r.findings.push(raise('duplicated', instance, `the service holds a second chain for this instance, of ${records.length} record(s) up to seq ${records[records.length - 1]?.seq}`, at));
      continue;
    }
    if (instance) held.add(instance);
    r.records = records.length;
    r.seq = records.length ? records[records.length - 1].seq : null;
    const last = receipts[receipts.length - 1]?.received;
    r.lastWitnessed = TYPES.at.ok(last) ? last : null;

    if (!instance) {
      r.findings.push(raise('unenrolled', null, 'the service holds a ledger that names no instance at all', at));
    } else if (records.length) {
      const broken = ledgerProblems(ledger);
      if (broken.length) r.findings.push(raise('unsound', instance, `the held chain does not hold together: ${broken[0]}`, at, { problems: Object.freeze(broken.map(sentence)) }));
      // Enrolment is the genesis record of an instance's chain (bc-3muu.2), so a chain that
      // starts with anything else is a chain the service accepted from somebody it never
      // admitted. It is a survey finding rather than an admission rule because `witness`
      // sees one record at a time and this is a property of the whole chain — and because a
      // chain that predates enrolment existing is a real historical state rather than a forgery.
      if (records[0]?.kind !== 'enrolment')
        r.findings.push(raise('unenrolled', instance, `the chain begins with a ${records[0]?.kind} record at seq ${records[0]?.seq}, and an instance's first record is its enrolment`, at));
    }
  }

  /* ------------------------------- what was refused, and what somebody has compared */

  for (const refusal of Array.isArray(refusals) ? refusals : []) {
    const instance = refusal?.instance ?? null;
    row(instance).findings.push(rejection(instance, refusal?.seq, refusal?.problems, TYPES.at.ok(refusal?.at) ? refusal.at : at));
  }

  for (const entry of Array.isArray(comparisons) ? comparisons : []) {
    const instance = entry?.instance ?? entry?.comparison?.local?.instance ?? null;
    const finding = divergence(instance, entry?.comparison ?? entry, TYPES.at.ok(entry?.at) ? entry.at : at);
    // An ordinary verdict still puts the instance in the population — it was compared, so
    // somebody knows it exists, and a member of the population that only appears when it is
    // in trouble is a population nobody can count. A comparison naming no instance and
    // finding nothing is the one case with nothing to account for.
    if (finding) row(instance).findings.push(finding);
    else if (instance) row(instance);
  }

  /* --------------------------------------- what a previous survey held and this one does not */

  for (const before of Array.isArray(previous?.instances) ? previous.instances : []) {
    const instance = before?.instance ?? null;
    if (!instance) continue;
    const r = row(instance);
    if (!held.has(instance)) {
      r.findings.push(
        raise('vanished', instance, `the survey of ${previous.at} held ${before.records ?? 0} record(s) for this instance up to seq ${before.seq}, and the service holds no ledger for it now`, at, {
          was: before.seq ?? null,
        })
      );
      continue;
    }
    if (Number.isSafeInteger(before.seq) && Number.isSafeInteger(r.seq) && r.seq < before.seq)
      r.findings.push(
        raise('vanished', instance, `the survey of ${previous.at} held this instance at seq ${before.seq} and the service now holds only seq ${r.seq} — records it had are gone`, at, {
          was: before.seq,
        })
      );
  }

  /* ------------------------------------------------------------------- silence, and the survey's own */

  const report = { instances: [], findings: [] };
  for (const r of rows.values()) {
    // Asked last, so an instance with a material finding is not also reported as quiet: a
    // ledger that was deleted is trivially silent, and saying both makes the list longer
    // without making it more informative.
    if (r.instance && !r.findings.length) {
      const quiet = silence(r, at, expect);
      if (quiet) r.findings.push(quiet);
    }
    r.findings.sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.kind.localeCompare(b.kind));
    // The row's state is the worst thing said about it, and `current` only when nothing is.
    // Named after the finding rather than after the severity, because "material" tells a
    // reader how much to care and `vanished` tells them what to go and look at.
    r.state = r.findings.length ? r.findings[0].kind : 'current';
    r.findings = Object.freeze(r.findings);
    report.instances.push(Object.freeze(r));
  }
  report.instances.sort((a, b) => String(a.instance).localeCompare(String(b.instance)));

  const findings = report.instances.flatMap((r) => r.findings);
  if (previous && TYPES.at.ok(previous.at) && Date.parse(at) - Date.parse(previous.at) > expect)
    findings.push(
      raise('unsurveyed', null, `the last survey was ${previous.at}, ${span(Date.parse(at) - Date.parse(previous.at))} ago, and the population is surveyed every ${span(expect)} — nothing could have been found in between`, at, {
        since: previous.at,
      })
    );
  findings.sort(
    (a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || String(a.instance).localeCompare(String(b.instance)) || a.kind.localeCompare(b.kind)
  );

  const states = {};
  for (const r of report.instances) states[r.state] = (states[r.state] || 0) + 1;

  /**
   * Clean is *every instance accounted for and current*, and it is never "no findings".
   *
   * A survey that accounts for nobody has no findings on it and is not clean — a service
   * holding no ledgers, or handed no inputs, is the one that says nothing wrong most
   * confidently, and that is the exact shape lib/changesample.js shipped and had to fix.
   */
  const clean = report.instances.length > 0 && findings.length === 0;

  return Object.freeze({
    at,
    expect,
    previous: TYPES.at.ok(previous?.at) ? previous.at : null,
    instances: Object.freeze(report.instances),
    findings: Object.freeze(findings),
    states: Object.freeze(states),
    enrolled: report.instances.length,
    current: states.current || 0,
    material: findings.filter((f) => f.severity === 'material').length,
    clean,
    why: clean
      ? `${report.instances.length} instance(s), all current within ${span(expect)}`
      : report.instances.length
        ? `${findings.length} finding(s) across ${report.instances.length} instance(s), of which ${states.current || 0} are current`
        : 'the service accounts for no instances at all, which is not the same as every instance being current',
  });
}

/**
 * Everything wrong with a survey, given what it was made from — the check that makes the
 * rest of this file untrusted.
 *
 * `surveyOf` is careful. That is not the same as being checkable, and a report is a thing
 * that travels: it is read by somebody who did not run it, later, possibly after passing
 * through a service somebody else administers. So point this at a report and at the same
 * inputs, and it says what the report fails to account for. A row quietly dropped, a row
 * marked `current` with findings hanging off it, a report marked clean carrying findings, a
 * report marked clean that covers nobody — each is a sentence rather than a boolean, because
 * the reader of a refused survey has to know which row to go and look at.
 *
 * Pointed at a table so it can be pointed at a bad one, exactly like `tableProblems` in
 * lib/publishable.js and `entryProblems` in lib/evidence.js. A rule only ever run against
 * inputs that pass is a rule nobody has watched fire.
 */
export function surveyProblems(report, { ledgers = [], refusals = [], comparisons = [], previous = null } = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['not a survey'];
  const problems = [];
  if (!TYPES.at.ok(report.at)) problems.push(`a survey is stamped with ${TYPES.at.why}, and "${report.at}" is not one`);

  const instances = Array.isArray(report.instances) ? report.instances : [];
  if (!Array.isArray(report.instances)) problems.push('a survey accounts for a list of instances, and this one has none');
  const named = new Set(instances.map((r) => r?.instance).filter(Boolean));

  const expected = new Map();
  const expect = (instance, source) => {
    if (instance && !expected.has(instance)) expected.set(instance, source);
  };
  for (const ledger of Array.isArray(ledgers) ? ledgers : []) expect(instanceOf(ledger), 'the service holds a ledger for it');
  for (const refusal of Array.isArray(refusals) ? refusals : []) expect(refusal?.instance, 'the service recorded a refused publication from it');
  for (const entry of Array.isArray(comparisons) ? comparisons : []) expect(entry?.instance ?? entry?.comparison?.local?.instance, 'a comparison was run against it');
  for (const before of Array.isArray(previous?.instances) ? previous.instances : []) expect(before?.instance, `the survey of ${previous?.at} accounted for it`);

  for (const [instance, source] of expected)
    if (!named.has(instance)) problems.push(`the survey does not account for ${instance}, and ${source}`);

  const findings = Array.isArray(report.findings) ? report.findings : [];
  if (!Array.isArray(report.findings)) problems.push('a survey carries a list of findings, and this one carries none at all');

  for (const f of findings) {
    if (!severityOf(f?.kind)) problems.push(`a finding of kind "${f?.kind}" is not one this service mints`);
    else if (f.severity !== FINDINGS[f.kind].severity)
      problems.push(`a ${f.kind} finding is ${FINDINGS[f.kind].severity} and this one claims to be ${f.severity}`);
  }

  for (const r of instances) {
    const own = Array.isArray(r?.findings) ? r.findings : [];
    if (own.length && r?.state === 'current')
      problems.push(`${r.instance} is reported current and carries ${own.length} finding(s)`);
    for (const f of own)
      if (!findings.includes(f) && !findings.some((g) => g?.kind === f?.kind && g?.instance === f?.instance))
        problems.push(`${r.instance} carries a ${f?.kind} finding that the survey's own list does not`);
  }

  if (report.clean && findings.length) problems.push(`the survey is marked clean and carries ${findings.length} finding(s)`);
  if (report.clean && !instances.length) problems.push('the survey is marked clean and accounts for no instances at all');
  if (Number.isSafeInteger(report.enrolled) && report.enrolled !== instances.length)
    problems.push(`the survey says it covers ${report.enrolled} instance(s) and lists ${instances.length}`);

  return problems;
}

/**
 * One line, and it states every denominator it has.
 *
 * `describeCoverage` in lib/reqcoverage.js makes the argument and lib/changesample.js
 * repeats it: "no findings" is a number that sounds like a result and cannot be checked,
 * where "2 findings across 7 instances, 5 current, interval 6 hours" is the same fact and
 * cannot be mistaken for anything else.
 */
export function describe(report) {
  if (!report || typeof report !== 'object') return 'no survey';
  const n = Array.isArray(report.instances) ? report.instances.length : 0;
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const material = findings.filter((f) => f?.severity === 'material').length;
  const head = `${n} instance(s), ${report.current || 0} current within ${span(report.expect ?? EXPECTED_MS)}`;
  const tail = findings.length ? `${findings.length} finding(s)${material ? `, ${material} material` : ''}` : n ? 'no findings' : 'nothing to be found';
  return `${head} — ${tail}, surveyed ${report.at}${report.previous ? ` (previous ${report.previous})` : ''}`;
}
