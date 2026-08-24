/**
 * The AI risk register, and the treatment of every risk in it — ISO/IEC 23894, and
 * Clause 6.1.2 and 6.1.3 of ISO/IEC 42001.
 *
 * Clause 6.1.2 does not ask for a list of risks. It asks for a *process*: criteria that
 * say what counts as acceptable before anything is rated against them, identification,
 * analysis, evaluation, and then 6.1.3's treatment — with the residual risk left over
 * accepted by somebody, by name, rather than left to be nobody's. A register produced
 * without the criteria is a list of worries in a spreadsheet; the criteria are what turn
 * "this feels bad" into "this is above the line we drew in March, so it is treated".
 *
 * ## Why this is a module and not the tracker
 *
 * Most of the register already exists. A risk here *is* a bead — it has an owner, work
 * that treats it, and a date somebody should look at it again — and the tracker is much
 * better at those three than any file would be. What the tracker cannot hold is the
 * **vocabulary**: a likelihood spelled two ways is two likelihoods, an "acceptable" that
 * means whatever the reader thinks is not a criterion, and a treatment naming a control
 * nobody minted treats nothing. So this file holds the vocabulary, the criteria and the
 * ratings, and cites the tracker where the work lives — which is the same division
 * `lib/policies.js` makes between a register and the fifteen documents it tracks.
 *
 * ## The chain is the point
 *
 * Risk → control → evidence. {@link RISKS} names, per risk, the corpus ids that treat it
 * (`controls`), the modules in this repository that make that treatment real today
 * (`enforcedBy`), and the classes of record an auditor could sample to see it operating
 * (`evidence`, which are `lib/evidence.js` ids). {@link chain} returns the three together.
 * That chain is what makes a Statement of Applicability *generatable* rather than argued
 * — bc-eqn1.14 reads {@link controlsClaimed} and gets, for every 42001 control, the risks
 * that selected it and the records that would show it working. An SoA whose justification
 * column is prose typed by hand is one nobody can re-derive next year.
 *
 * ## Which framework's ids a risk names, and why it is not SOC 2
 *
 * The leaf rule `lib/servicescope.js` established is that a register keeps corpus ids as
 * literals and its *suite* resolves them, so the register still loads in a release where
 * `lib/controls.js` is absent. That rule is kept here. What is deliberately different is
 * the framework: `lib/policies.js` names SOC 2 criteria because a policy set answers a
 * SOC 2 request list, and every ISO row in the corpus already crosswalks *into* those
 * ids. AI risk treatment is the opposite direction — Annex A of 42001 is a list of
 * treatments and exists to be selected from, and Clause 6.1.2/6.1.3 are the clauses that
 * say to do so. Naming SOC 2 criteria here would be inventing a second crosswalk; naming
 * 42001 ids and walking the corpus outward is {@link alsoServes}, and it is how CC3 and
 * CC9 read off this one register rather than growing a second (bc-4r10.8).
 *
 * ## The scales are ordinal, and the multiplication is a sort key
 *
 * Five likelihoods, five consequences, and a band from the product. Nobody should mistake
 * that for arithmetic: "possible × major" is not a number of dollars, and two risks with
 * the same score are not interchangeable. What the product buys is a *stable order* and a
 * threshold that can be written down before the ratings are, which is the whole of what
 * 6.1.2 asks the criteria to do. {@link CRITERIA} says so out loud rather than letting a
 * reader assume a quantitative model is hiding behind it.
 *
 * ## Harm to whom, which is 23894's distinctive demand
 *
 * A register that rates every risk by its cost to the organisation is the register 23894
 * exists to refuse. `harmTo` is a closed set — the organisation, individuals, society —
 * and the criteria state that a consequence to individuals is rated on its own and never
 * netted off against a benefit to the organisation. Most of this register is
 * organisational, because the system is a development tool run by one person on one Mac,
 * and {@link CRITERIA} says where that stops being true rather than leaving the imbalance
 * to look like an oversight.
 *
 * ## Nothing here is accepted yet, and that is the honest state
 *
 * Every residual above the acceptable band carries `acceptance.state === 'owed'` with a
 * sentence saying what is missing. Writing an acceptor and a date anyway would produce a
 * register that passes every check and is false in the one way that matters — the same
 * refusal `lib/policies.js` makes about fifteen unwritten policies and `lib/documents.js`
 * makes about an approver nobody asked. {@link entryProblems} enforces it in both
 * directions: an accepted risk with no acceptor is refused, and an owed one carrying a
 * date is refused just as hard.
 *
 * Review expiry is `lib/documents.js`'s, unchanged, for the reason that module gives: a
 * second definition of *overdue* is how two registers come to disagree about one date.
 * Roles are `lib/aims.js`'s, unchanged, for the same reason aimed at a different noun —
 * a risk owner who is not one of the five roles the management system has is an owner
 * nobody is accountable as.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ROLES as AIMS_ROLES, mayApprove } from './aims.js';
import { MAX_REVIEW_MONTHS, WARN_DAYS, parseDate, reviewStatus } from './documents.js';

export { MAX_REVIEW_MONTHS, WARN_DAYS };

const text = (v) => String(v ?? '').trim();
const named = (v) => typeof v === 'string' && v.trim().length >= 2;
const prose = (v) => typeof v === 'string' && v.trim().length >= 40;

/** The approval kind a residual acceptance is, in `lib/aims.js`'s vocabulary. */
export const ACCEPTANCE_APPROVAL = 'residual-risk-acceptance';

/**
 * The role that may accept a residual in any band it is permitted to be accepted in.
 *
 * Named rather than inlined because two rules read it — the criteria's own table below,
 * and the one exception {@link acceptanceProblems} makes to it.
 */
const TOP = 'top-management';

/* ------------------------------------------------------------- the scales */

/**
 * How likely, on a five-point ordinal scale anchored on an observable frequency.
 *
 * Anchored on *this daemon's year* rather than on a percentage, because a percentage
 * invites a reader to average two of them and an anchor does not. `level` is the sort
 * key and nothing else; see {@link CRITERIA}.
 */
export const LIKELIHOOD = Object.freeze([
  Object.freeze({
    id: 'rare',
    level: 1,
    means: 'Would need a combination of failures none of which has been seen here — plausible on paper, unobserved in practice.',
  }),
  Object.freeze({
    id: 'unlikely',
    level: 2,
    means: 'Could happen in a year of this daemon running, and has not; a single existing control is what stands between it and happening.',
  }),
  Object.freeze({
    id: 'possible',
    level: 3,
    means: 'Has happened here at least once, or happens routinely in systems built this way and nothing specific to this one prevents it.',
  }),
  Object.freeze({
    id: 'likely',
    level: 4,
    means: 'Would be expected several times a year at the rate this system is used, absent the treatment.',
  }),
  Object.freeze({
    id: 'almost-certain',
    level: 5,
    means: 'Happens as a matter of course — the question is not whether but how often, and the treatment is about the blast radius.',
  }),
]);

/**
 * How bad, on the same five points.
 *
 * Each anchor says what the consequence *is*, not what it costs, because this
 * organisation has no loss figures and inventing a dollar band would be the most
 * quotable false thing in the file.
 */
export const CONSEQUENCE = Object.freeze([
  Object.freeze({
    id: 'negligible',
    level: 1,
    means: 'Noticed, corrected within the session that caused it, and leaves no record anybody would have to explain.',
  }),
  Object.freeze({
    id: 'minor',
    level: 2,
    means: 'Costs an operator an hour or a session its work, and is fully recoverable from records the system already keeps.',
  }),
  Object.freeze({
    id: 'moderate',
    level: 3,
    means: 'Wrong work lands or wrong output reaches a person, and undoing it takes deliberate effort by somebody who was not there.',
  }),
  Object.freeze({
    id: 'major',
    level: 4,
    means: 'A control an auditor was told operates did not, or something left the machine that should not have, and the record of it is the only reason anyone would know.',
  }),
  Object.freeze({
    id: 'severe',
    level: 5,
    means: 'Harm to a person that cannot be withdrawn, or a claim about this system published to others that turns out to be untrue.',
  }),
]);

/** Who the consequence falls on. Rated separately; see {@link CRITERIA}. */
export const HARMS = Object.freeze(['organisation', 'individuals', 'society']);

/** The bands, weakest first. The order is load-bearing — {@link atLeastBand} reads it. */
export const BANDS = Object.freeze(['low', 'medium', 'high', 'critical']);

/**
 * ISO 31000's four, which 23894 uses unchanged: stop doing the thing, make it less
 * likely or less bad, put it on somebody else, or decide to live with it.
 *
 * `retain` is a real answer and the one most often taken silently. Naming it forces the
 * acceptance rules below to apply to it, which is the whole reason it is in the list.
 */
export const TREATMENTS = Object.freeze(['avoid', 'reduce', 'share', 'retain']);

/** Whether a residual has been accepted, is still owed, or is below the line entirely. */
export const ACCEPTANCE = Object.freeze(['accepted', 'owed', 'not-required']);

/** Fields an acceptance carries only once it has actually been given. */
export const ACCEPTED_FIELDS = Object.freeze(['by', 'role', 'on']);

/** The likelihood row for an id, or `null` if that is not one. */
export const likelihood = (id) => LIKELIHOOD.find((l) => l.id === text(id)) || null;

/** The consequence row for an id, or `null` if that is not one. */
export const consequence = (id) => CONSEQUENCE.find((c) => c.id === text(id)) || null;

/** The level product for a rating, or `null` if either half is not on the scale. */
export function scoreOf(rating) {
  const l = likelihood(rating?.likelihood);
  const c = consequence(rating?.consequence);
  return l && c ? l.level * c.level : null;
}

/**
 * The band a score falls in — the thresholds, written once.
 *
 * Boundaries stated as a table rather than as a chain of comparisons so a reader can see
 * where the lines are without executing anything, and so {@link CRITERIA} can quote them.
 */
export const THRESHOLDS = Object.freeze([
  Object.freeze({ band: 'low', upTo: 4 }),
  Object.freeze({ band: 'medium', upTo: 9 }),
  Object.freeze({ band: 'high', upTo: 16 }),
  Object.freeze({ band: 'critical', upTo: 25 }),
]);

/** Which band a score is in, or `null` for a score off the scale. */
export function bandOf(score) {
  if (!Number.isInteger(score) || score < 1 || score > 25) return null;
  return THRESHOLDS.find((t) => score <= t.upTo)?.band ?? null;
}

/** Is `band` at least as bad as `floor`? Compares by position in {@link BANDS}. */
export const atLeastBand = (band, floor) => {
  const a = BANDS.indexOf(text(band));
  const b = BANDS.indexOf(text(floor));
  return a >= 0 && b >= 0 && a >= b;
};

/** The rating of one half of an entry — `'inherent'` or `'residual'` — as score and band. */
export function ratingOf(entry, which = 'residual') {
  const score = scoreOf(entry?.[which]);
  return { score, band: bandOf(score) };
}

/* ---------------------------------------------------------- the criteria */

/**
 * Clause 6.1.2's risk criteria: what this organisation decided counts as acceptable,
 * decided before anything below was rated against it.
 *
 * The order matters more than the content. Criteria written after the register is rated
 * are criteria drawn around the answers, and an auditor asks for the date on this for
 * exactly that reason — which is why `statedOn` is here and why moving it is a change to
 * the method rather than a tidy-up.
 */
export const CRITERIA = Object.freeze({
  statedOn: '2026-08-24',
  scale:
    'Five likelihoods against five consequences, each anchored on something observable rather than on a percentage or a ' +
    'loss figure. The band comes from the product of the two levels, and the product is a sort key and a threshold — not ' +
    'a quantity. Two risks scoring 12 are not interchangeable and nothing here averages them.',
  acceptable: Object.freeze(['low']),
  requiresTreatment: Object.freeze(['medium', 'high', 'critical']),
  /**
   * Which role must accept a residual left in each band. A band absent from this map is
   * below the line and needs no acceptance; `null` means it may not be accepted at all.
   */
  acceptedBy: Object.freeze({
    medium: 'system-owner',
    high: 'top-management',
    critical: null,
  }),
  unacceptable:
    'A critical residual may not be retained. If treatment cannot bring a risk below critical then the activity stops or ' +
    'the criteria change — and changing them is a decision recorded here with a new date, not a rating edited quietly.',
  harmWeighting:
    'A consequence to individuals or to society is rated on its own and never netted off against a benefit to the ' +
    'organisation. Where a risk falls on more than one, the entry carries all of them and is rated at the worst.',
  whyMostlyOrganisational:
    'Almost every entry below harms the organisation and no one else, and that is a fact about this system rather than a ' +
    'gap in the method: it is a development tool run by one person on one Mac, its outputs are pull requests a person ' +
    'merges, and no member of the public interacts with it. What would change that is any of three things, each of which ' +
    'is a re-rating of this whole register and not an entry appended to it — a second operator whose work an agent could ' +
    'destroy, personal data entering the repositories agents write into, or a claim about this system published to people ' +
    'who cannot check it.',
  reviewMonths: 6,
  reviewedOn: '2026-08-24',
});

/* ------------------------------------------------------------- the method */

/**
 * The eight steps of ISO/IEC 23894's risk management process, and what this system
 * actually does for each — the *documented method* Clause 6.1.2 asks for, as opposed to
 * the register it produces.
 *
 * Written as the standard's own eight rather than as whatever this system happens to do,
 * because the value of the list is that a step nobody performs is *visible as an empty
 * one*. {@link methodProblems} requires all eight, in the standard's order, exactly once
 * — so a step quietly dropped fails a check by name rather than becoming a gap somebody
 * finds during fieldwork. `does` is what happens; `where` is what to read to see it.
 */
export const METHOD = Object.freeze([
  Object.freeze({
    process: 'ISO23894.Process.CommunicationAndConsultation',
    clauses: Object.freeze(['ISO42001.Clause7.4']),
    does:
      'Every rating and every acceptance in this register is a commit in a repository the operator reads, and a residual ' +
      'left unaccepted becomes a card. There is no consultation beyond that, because the organisation is one person.',
    where: Object.freeze(['lib/risk.js', 'lib/aims.js']),
    gap:
      'Interested parties are enumerated for the management system but none of them is consulted on a risk rating. With one ' +
      'operator there is nobody to consult; with two there would be, and this is the step that changes first.',
  }),
  Object.freeze({
    process: 'ISO23894.Process.ScopeContextCriteria',
    clauses: Object.freeze(['ISO42001.Clause6.1.2', 'ISO42001.Clause4.1', 'ISO42001.Clause4.3']),
    does:
      'The scope and the context are the AI management system\'s own, stated once in `lib/aims.js`, and the criteria are ' +
      'the `CRITERIA` object here — the scales, the bands, what counts as acceptable, and who has to sign for what is left.',
    where: Object.freeze(['lib/risk.js', 'lib/aims.js', 'lib/boundary.js']),
    gap: '',
  }),
  Object.freeze({
    process: 'ISO23894.Process.RiskIdentification',
    clauses: Object.freeze(['ISO42001.Clause6.1.2']),
    does:
      'Risks are identified from what the system does rather than from a checklist: each entry names its sources, and each ' +
      'was chosen because something in this codebase already partly treats it, which is what makes the rating checkable.',
    where: Object.freeze(['lib/risk.js']),
    gap:
      'Identification is a person reading the system, performed once, on the date in CRITERIA. Nothing prompts it again ' +
      'except the review dates, so a risk introduced by a change lands in this register only if somebody puts it there.',
  }),
  Object.freeze({
    process: 'ISO23894.Process.RiskAnalysis',
    clauses: Object.freeze(['ISO42001.Clause6.1.2', 'ISO42001.Clause8.2']),
    does:
      'Each risk is analysed twice — inherent and residual — on the five-by-five ordinal scales, with the anchors stated so ' +
      'two people rating the same risk have something to disagree against, and with who the harm falls on rated separately.',
    where: Object.freeze(['lib/risk.js']),
    gap: '',
  }),
  Object.freeze({
    process: 'ISO23894.Process.RiskEvaluation',
    clauses: Object.freeze(['ISO42001.Clause6.1.2']),
    does:
      'The band from the analysis is compared against the criteria, and the comparison is code rather than judgement: what ' +
      'needs treatment, what needs an acceptance and whose signature it needs are all read off the criteria table.',
    where: Object.freeze(['lib/risk.js']),
    gap: '',
  }),
  Object.freeze({
    process: 'ISO23894.Process.RiskTreatment',
    clauses: Object.freeze(['ISO42001.Clause6.1.3', 'ISO42001.Clause8.3']),
    does:
      'Every risk carries one of the four treatment options, the controls it selects from Annex A, the modules here that ' +
      'make the treatment real, and a sentence saying what is still missing — and the residual may not be worse than the ' +
      'inherent rating, nor equal to it without an explanation.',
    where: Object.freeze(['lib/risk.js', 'lib/controls.js']),
    gap: '',
  }),
  Object.freeze({
    process: 'ISO23894.Process.MonitoringAndReview',
    clauses: Object.freeze(['ISO42001.Clause9.1']),
    does:
      'Each risk and the criteria themselves carry a review date on the same expiry machinery every other controlled ' +
      'document here uses, so an overdue re-rating fails a check in this repository before it is an audit exception.',
    where: Object.freeze(['lib/risk.js', 'lib/documents.js']),
    gap:
      'Review is on a clock and not on a trigger: nothing re-rates a risk because the code that treated it changed. What ' +
      'catches part of that is the check that every `enforcedBy` file still exists, which is a rename and not a rewrite.',
  }),
  Object.freeze({
    process: 'ISO23894.Process.RecordingAndReporting',
    clauses: Object.freeze(['ISO42001.Clause7.5.3']),
    does:
      'The register is source in a repository, so every change to a rating is a commit with an author, a date and a diff, ' +
      'and the register is itself a controlled document with an owner and an expiry in `lib/documents.js`.',
    where: Object.freeze(['lib/risk.js', 'lib/documents.js']),
    gap: '',
  }),
]);

/**
 * The eight steps in the order ISO/IEC 23894 states them, written out rather than derived
 * from {@link METHOD}.
 *
 * Deriving it would make the completeness check circular — a list compared against itself
 * agrees with itself no matter which step somebody deleted. This is the independent copy
 * the check has something to be wrong against.
 */
export const PROCESS_ORDER = Object.freeze([
  'ISO23894.Process.CommunicationAndConsultation',
  'ISO23894.Process.ScopeContextCriteria',
  'ISO23894.Process.RiskIdentification',
  'ISO23894.Process.RiskAnalysis',
  'ISO23894.Process.RiskEvaluation',
  'ISO23894.Process.RiskTreatment',
  'ISO23894.Process.MonitoringAndReview',
  'ISO23894.Process.RecordingAndReporting',
]);

/** A 23894 process id, held to shape here and resolved against the corpus by the suite. */
const PROCESS_RE = /^ISO23894\.(Principle|Framework|Process)\.[A-Za-z]+$/;

/** Is this the shape a 23894 process id has? Says nothing about whether it is minted. */
export const isProcessId = (id) => PROCESS_RE.test(text(id));

/**
 * Everything wrong with the documented method — the half Clause 6.1.2 is about, and the
 * half a register makes it easy to forget.
 *
 * The completeness rule is the one worth having: all eight of 23894's process steps,
 * once each, in the standard's order. A method missing a step is not a shorter method, it
 * is a step nobody performs, and the only way that is ever noticed is a check that knows
 * how many there should be.
 */
export function methodProblems(method = METHOD, order = PROCESS_ORDER) {
  const problems = [];
  const seen = method.map((s) => text(s?.process));

  for (const id of order) if (!seen.includes(id)) problems.push(`METHOD: no step for ${id} — a step nobody performs is not a shorter method`);
  for (const id of seen) if (!order.includes(id)) problems.push(`METHOD: ${id || 'a step with no process id'} is not one of the eight`);
  if (seen.length !== new Set(seen).size) problems.push('METHOD: the same process step appears twice');
  if (seen.length === order.length && seen.join() !== order.join()) {
    problems.push("METHOD: the steps are not in the standard's order — the order is the process, not a presentation choice");
  }

  for (const step of method) {
    const at = `METHOD[${text(step?.process) || '?'}]`;
    if (!isProcessId(step?.process)) problems.push(`${at}: \`process\` must be a 23894 process id`);
    if (!Array.isArray(step?.clauses) || step.clauses.length === 0) {
      problems.push(`${at}: \`clauses\` must name the 42001 clause this step answers — a step answering no clause is a habit`);
    } else {
      for (const id of step.clauses) if (!isControlId(id)) problems.push(`${at}: \`${text(id)}\` is not the shape a 42001 corpus id has`);
    }
    if (!prose(step?.does)) problems.push(`${at}: \`does\` must say what this system actually does for the step, in a sentence`);
    if (!Array.isArray(step?.where) || step.where.length === 0) problems.push(`${at}: \`where\` must name what to read to see it`);
    if (typeof step?.gap !== 'string') {
      problems.push(`${at}: \`gap\` must be a sentence or the empty string — an absent gap reads as "nobody looked"`);
    } else if (step.gap !== '' && !prose(step.gap)) {
      problems.push(`${at}: \`gap\` must be a sentence if it is anything at all`);
    }
  }

  return problems;
}

/** The steps of the method that admit to a gap, in order. */
export const methodGaps = (method = METHOD) => method.filter((s) => text(s.gap) !== '');

/**
 * The role the criteria require for a residual in this band, or `null` for neither.
 *
 * Takes the criteria rather than reading {@link CRITERIA}, for the reason every rule here
 * takes its subject: a rule hardwired to the real table is a rule that can only ever be
 * run against a table which passes.
 */
export const acceptorFor = (band, criteria = CRITERIA) => criteria?.acceptedBy?.[text(band)] ?? null;

/** Does a residual in this band have to be accepted by somebody at all? */
export const needsAcceptance = (band, criteria = CRITERIA) =>
  Object.prototype.hasOwnProperty.call(criteria?.acceptedBy || {}, text(band));

/* ----------------------------------------------------------- the register */

/**
 * The risks this system actually runs on.
 *
 * Chosen by the test the description of bc-eqn1.5 sets: each one already has a partial
 * control in this codebase, which is what makes the register writable in an afternoon and
 * checkable rather than aspirational. A risk nobody has built anything against belongs in
 * the tracker as work, not here as a row with an empty `enforcedBy` and a confident
 * residual.
 *
 * `controls` are 42001 corpus ids and are held to shape here and resolved against the
 * real corpus by `test/risk.mjs`. `enforcedBy` is checked to exist on disk by
 * {@link setProblems}. `evidence` are `lib/evidence.js` register ids, resolved in the
 * suite the same way — a treatment with nothing kept behind it is a treatment nobody can
 * sample, and saying so is cheaper than an auditor finding it.
 */
export const RISKS = Object.freeze([
  Object.freeze({
    id: 'unattended-merge-to-main',
    title: 'An unattended agent merges its own work into main',
    statement:
      'Sessions run while nobody is awake, and the thing they produce is a change to the software that runs the management ' +
      'system itself. An agent that could merge its own branch would be the author, the reviewer and the release of the ' +
      'same change, and the first anybody would know is a behaviour that changed overnight.',
    sources: Object.freeze([
      'Every worker window has a shell, a checkout and a git binary, so the capability is present in every session.',
      'The work is finished at the moment the temptation is highest — a branch that passes its tests and has nobody to merge it.',
      'Several sessions run at once against one local main, so even a well-meant merge races the other four.',
    ]),
    harmTo: Object.freeze(['organisation']),
    inherent: Object.freeze({ likelihood: 'likely', consequence: 'major' }),
    treatment: 'reduce',
    treats:
      'The worker is stopped at delivery: it pushes a branch and opens a pull request, and a separate agent in the daemon ' +
      'merges one branch at a time with the whole board in front of it, after a review gate and after judging the checks ' +
      'against what the base is already failing.',
    controls: Object.freeze(['ISO42001.A.6.2.5', 'ISO42001.A.9.2', 'ISO42001.Clause8.1']),
    enforcedBy: Object.freeze([
      'lib/mergequeue.js',
      'lib/mergeadmit.js',
      'lib/reviewgate.js',
      'lib/premerge.js',
      'lib/endorse.js',
    ]),
    evidence: Object.freeze(['merge-notes', 'session-transcripts']),
    residual: Object.freeze({ likelihood: 'unlikely', consequence: 'major' }),
    owes:
      'The separation is a brief and a queue rather than a permission. Nothing on this Mac would refuse a push to main typed ' +
      'by a session that decided to, and the remote has no rule in force on main either — checked on 2026-08-24 against ' +
      'the effective-rules endpoint rather than the protection one, which answers 404 for an unprotected branch and for a ' +
      'branch governed by a ruleset alike. So the technical barrier a reader would assume is behind this is not there. ' +
      'What holds it is that every worker brief says so in as many words and that the queue is the only path that ' +
      'produces a merge at all: a single control, which is exactly what `unlikely` is anchored on rather than something ' +
      'stronger.',
    owner: 'system-owner',
    acceptance: Object.freeze({
      state: 'owed',
      by: null,
      role: null,
      on: null,
      why:
        'No residual acceptance has been recorded for anything in this register, and this one should wait on the decision ' +
        'about whether main is protected on the remote — accepting it now would be accepting a rating whose one control is ' +
        'a sentence in a prompt.',
    }),
    beads: Object.freeze(['bc-eqn1.5']),
    reviewedOn: '2026-08-24',
    reviewMonths: 6,
  }),
  Object.freeze({
    id: 'amendment-widens-an-agent',
    title: 'A foundation amendment widens what an agent may do',
    statement:
      'What an agent *is* — the tools it holds, the repositories it may write, whether it may run unattended — is one ' +
      'amendable object. An amendment that widens it is the single change with the largest reach in the system, and it ' +
      'looks like every other approved change while it is being made.',
    sources: Object.freeze([
      'Agents themselves request amendments, so the party that benefits from a wider grant is the party that drafts it.',
      'A grant reads as a small addition to a list, and the consequence of it is not visible in the diff that adds it.',
      'The widening takes effect for every future session of that kind at once, including the ones already queued.',
    ]),
    harmTo: Object.freeze(['organisation', 'individuals']),
    inherent: Object.freeze({ likelihood: 'possible', consequence: 'major' }),
    treatment: 'reduce',
    treats:
      'An amendment is a decision only a person may approve, the approval is a tap rather than an agent action, what each ' +
      'grant actually means is decided in this repository rather than inferred from the grant, and every request — approved ' +
      'or declined — is appended to a record that cannot be quietly rewritten.',
    controls: Object.freeze(['ISO42001.A.3.2', 'ISO42001.A.6.2.2', 'ISO42001.Clause6.3']),
    enforcedBy: Object.freeze(['lib/foundation.js', 'lib/amendment.js', 'lib/authority.js', 'lib/grants.js', 'lib/approval.js']),
    evidence: Object.freeze(['foundation-amendments', 'configuration-history']),
    residual: Object.freeze({ likelihood: 'unlikely', consequence: 'major' }),
    owes:
      'The approver is told what is being asked for and not what it would let an agent reach that it cannot reach today. ' +
      'Nothing computes the difference between the grant set before and after, so the person approving is reading a request ' +
      'rather than a consequence.',
    owner: 'top-management',
    acceptance: Object.freeze({
      state: 'owed',
      by: null,
      role: null,
      on: null,
      why:
        'Waiting on the same thing the whole register is: a session in which each residual is read and either signed for or ' +
        'sent back for more treatment.',
    }),
    beads: Object.freeze([]),
    reviewedOn: '2026-08-24',
    reviewMonths: 6,
  }),
  Object.freeze({
    id: 'model-routed-by-an-editable-label',
    title: 'A model is routed by a label anyone with tracker access can edit',
    statement:
      'Which model a session runs on is chosen from a complexity label on the bead. That label is an ordinary tracker field ' +
      'that any agent or person may write, so the routing decision can be moved by whoever touches the bead last — including ' +
      'an agent filing the bead that will later be worked.',
    sources: Object.freeze([
      'The label is the routing input and is also part of the ordinary bead vocabulary agents write when filing.',
      'A bead with no label routes to the capable model, so the failure that matters is a label added, not one missing.',
      'Nothing at dispatch compares the label against the work; the label is trusted because it is there.',
    ]),
    harmTo: Object.freeze(['organisation']),
    inherent: Object.freeze({ likelihood: 'likely', consequence: 'moderate' }),
    treatment: 'reduce',
    treats:
      'The default is the capable model rather than the cheap one, so an absent or unreadable label fails safe; and what a ' +
      'session actually ran on is recorded on the bead after the fact and drawn on the card, so the plan and the outcome are ' +
      'two different records and a mismatch is visible rather than inferred.',
    controls: Object.freeze(['ISO42001.A.4.5', 'ISO42001.A.6.2.6', 'ISO42001.A.6.2.8']),
    enforcedBy: Object.freeze(['lib/complexity.js', 'lib/ranmodel.js', 'lib/modelcard.js']),
    evidence: Object.freeze(['agent-run-logs', 'session-transcripts']),
    residual: Object.freeze({ likelihood: 'possible', consequence: 'moderate' }),
    owes:
      'Every control here is detective. The record says what ran after it ran, and nothing refuses a routing that is wrong ' +
      'for the work, so the residual likelihood stays close to the inherent one — what changed is that it is now knowable, ' +
      'not that it is prevented.',
    owner: 'system-owner',
    acceptance: Object.freeze({
      state: 'owed',
      by: null,
      role: null,
      on: null,
      why:
        'This is the one most likely to be accepted as it stands — a cheap model doing expensive work produces a bad pull ' +
        'request, which the merge queue and the reviewer already catch — but that argument has been made in a header comment ' +
        'and never signed.',
    }),
    beads: Object.freeze([]),
    reviewedOn: '2026-08-24',
    reviewMonths: 6,
  }),
  Object.freeze({
    id: 'prompt-content-reaches-a-third-party',
    title: 'Content that should not leave the machine reaches a third-party API in a prompt',
    statement:
      'Every dispatched session sends its brief, the files it reads and what it says back to a model provider. That is how ' +
      'the system works and is not itself the risk. The risk is what travels with it: a credential in a file an agent read, ' +
      "another organisation's source, or a person's data in a repository nobody thought of as containing any.",
    sources: Object.freeze([
      'A brief carries whatever the bead says, and beads are written without a leaving-the-machine rule in mind.',
      'An agent reads files to answer a question, and which files is decided by the agent mid-task.',
      'The workspace spans repositories owned by an employer as well as personal ones, and one session can be rooted in either.',
    ]),
    harmTo: Object.freeze(['organisation', 'individuals']),
    inherent: Object.freeze({ likelihood: 'possible', consequence: 'major' }),
    treatment: 'reduce',
    treats:
      'The third parties are enumerated with what may be sent to each and under what terms, what may be published to the ' +
      'central service is a closed vocabulary rather than a judgement, and the system boundary records which repositories ' +
      'are inside the described system at all.',
    controls: Object.freeze(['ISO42001.A.10.3', 'ISO42001.A.4.3', 'ISO42001.A.9.4']),
    enforcedBy: Object.freeze(['lib/suppliers.js', 'lib/publishable.js', 'lib/boundary.js']),
    evidence: Object.freeze(['session-transcripts', 'configuration-history']),
    residual: Object.freeze({ likelihood: 'possible', consequence: 'major' }),
    owes:
      'The residual is unchanged from the inherent rating and that is the finding rather than an oversight. Two of the three ' +
      'modules govern what this daemon publishes, which is a different act from what a session sends to a model provider, ' +
      'and nothing inspects a prompt at the moment it is sent. The register says what may leave; no code enforces it on the ' +
      'path that carries the most.',
    owner: 'system-owner',
    acceptance: Object.freeze({
      state: 'owed',
      by: null,
      role: null,
      on: null,
      why:
        'This one should not be accepted as it stands. It is the entry in this register that most deserves a treatment bead ' +
        'before an acceptance, and recording it as owed rather than accepted is what keeps that true.',
    }),
    beads: Object.freeze([]),
    reviewedOn: '2026-08-24',
    reviewMonths: 6,
  }),
  Object.freeze({
    id: 'agent-writes-outside-what-it-was-asked-about',
    title: 'An agent writes into repositories it was never asked about',
    statement:
      'One tracker serves roughly forty service repositories, and a session opened against one of them is a shell on a Mac ' +
      'that can reach all of them. A session that misreads its scope — or reasons its way into a "related" fix — can commit ' +
      'in a repository nobody dispatched it to, where nobody is watching for its branch.',
    sources: Object.freeze([
      'A single tracker covers many repositories, so the bead an agent is working does not by itself name one checkout.',
      'The nearby repositories are on the same disk with the same credentials, so nothing external stands in the way.',
      'Work genuinely does span repositories sometimes, so the wrong behaviour and the right one look alike at the start.',
    ]),
    harmTo: Object.freeze(['organisation', 'individuals']),
    inherent: Object.freeze({ likelihood: 'possible', consequence: 'major' }),
    treatment: 'reduce',
    treats:
      'Which repositories a workspace may be worked in is data rather than inference, where trackers are looked for is a ' +
      'pinned set of roots, an agent that owns a repository owns exactly one, and the shared repository every agent can ' +
      'reach is a single named place rather than whatever checkout is nearest.',
    controls: Object.freeze(['ISO42001.A.4.2', 'ISO42001.A.9.4', 'ISO42001.A.10.2']),
    enforcedBy: Object.freeze(['lib/repos.js', 'lib/workspaceroots.js', 'lib/agentrepo.js', 'lib/commonrepo.js']),
    evidence: Object.freeze(['agent-owned-repos', 'session-transcripts', 'merge-notes']),
    residual: Object.freeze({ likelihood: 'unlikely', consequence: 'major' }),
    owes:
      'What is scoped is the dispatch, not the process. The brief, the worktree and the tracker all point at one repository ' +
      'and the shell underneath them is unconstrained, so the control is an instruction an agent follows rather than a ' +
      'boundary it meets. A sandboxed session would move this to rare; nothing plans to.',
    owner: 'system-owner',
    acceptance: Object.freeze({
      state: 'owed',
      by: null,
      role: null,
      on: null,
      why:
        'Needs the employer-side repositories considered separately before one acceptance covers both — the consequence of a ' +
        'stray commit is not the same on a personal repo and on a shared service one.',
    }),
    beads: Object.freeze([]),
    reviewedOn: '2026-08-24',
    reviewMonths: 6,
  }),
  Object.freeze({
    id: 'autonomous-filing-loop',
    title: 'Agents file work for each other until the queue is theirs',
    statement:
      'An agent that finds work files a bead, and a queue that finds a ready bead opens a session on it. Those two rules ' +
      'compose into a loop with no person in it: sessions filing work that opens sessions that file work, at a priority ' +
      'they chose, until the queue is mostly about itself.',
    sources: Object.freeze([
      'Filing is deliberately unrestricted, because a discovery kept to itself is a discovery nobody can act on.',
      'The dispatcher takes what is ready without asking who filed it or why.',
      'Two agents finding the same thing file it twice, and both copies are ready work.',
    ]),
    harmTo: Object.freeze(['organisation']),
    inherent: Object.freeze({ likelihood: 'possible', consequence: 'moderate' }),
    treatment: 'reduce',
    treats:
      'Four independent brakes, each of which alone would slow it: an agent-filed bead is clamped to a middling priority and ' +
      'the clamp is written on the bead, a bead may not be worked until it is endorsed, an already-filed duplicate is ' +
      'recognised rather than re-filed, and the number of windows open at once is a budget rather than a consequence.',
    controls: Object.freeze(['ISO42001.A.9.2', 'ISO42001.A.6.2.6', 'ISO42001.A.6.2.8']),
    enforcedBy: Object.freeze(['lib/filing.js', 'lib/endorse.js', 'lib/dupe.js', 'lib/advocate.js', 'lib/onewindow.js']),
    evidence: Object.freeze(['advocate-dispatch-state', 'agent-run-logs', 'session-transcripts']),
    residual: Object.freeze({ likelihood: 'unlikely', consequence: 'minor' }),
    owes:
      'Nothing is owed for the loop itself; the brakes are real, they are tested, and the priority clamp in particular is ' +
      'load-bearing. What is not measured is the shape of the queue over time — nothing here would notice that the ratio of ' +
      'agent-filed to human-filed work had been climbing for a month, which is the slow version of this risk.',
    owner: 'system-owner',
    acceptance: Object.freeze({
      state: 'not-required',
      by: null,
      role: null,
      on: null,
      why: 'The residual is in the acceptable band, so no acceptance is owed — the criteria decide that, not the owner.',
    }),
    beads: Object.freeze([]),
    reviewedOn: '2026-08-24',
    reviewMonths: 6,
  }),
  Object.freeze({
    id: 'instruction-from-untrusted-text',
    title: 'Text somebody else wrote reaches an agent as an instruction',
    statement:
      'A brief is assembled from a bead body, its comments, review comments on a pull request and titles of things other ' +
      'people published. Every one of those is text this organisation did not write, and an agent reading a brief has no ' +
      'mechanism for treating one paragraph as data and the next as an instruction.',
    sources: Object.freeze([
      'Beads, comments and review threads are the intended input to a brief, so untrusted text arrives through the front door.',
      'Text from outside is included on purpose, because a review comment an agent ignores is a review that did not happen.',
      'Nothing marks a span of a prompt as quoted rather than addressed to the reader.',
    ]),
    harmTo: Object.freeze(['organisation', 'individuals']),
    inherent: Object.freeze({ likelihood: 'possible', consequence: 'major' }),
    treatment: 'reduce',
    treats:
      'What an injected instruction could reach is bounded by the same gates every legitimate session meets: nothing is ' +
      'worked until it is endorsed, nothing reaches main except through a pull request the queue admits, and the review gate ' +
      'reads the diff before the merge does.',
    controls: Object.freeze(['ISO42001.A.6.2.4', 'ISO42001.A.9.2', 'ISO42001.A.6.2.6']),
    enforcedBy: Object.freeze(['lib/endorse.js', 'lib/mergequeue.js', 'lib/reviewgate.js', 'lib/approval.js']),
    evidence: Object.freeze(['session-transcripts', 'merge-notes', 'agent-run-logs']),
    residual: Object.freeze({ likelihood: 'possible', consequence: 'moderate' }),
    owes:
      'Every treatment here is downstream. They bound what an injected instruction can land, and none of them stops one being ' +
      'followed — a session can still be steered into reading files, filing beads or asking a question that serves whoever ' +
      'wrote the text. Nothing in the brief-building path marks third-party text as untrusted, and the likelihood is ' +
      'unchanged for that reason.',
    owner: 'system-owner',
    acceptance: Object.freeze({
      state: 'owed',
      by: null,
      role: null,
      on: null,
      why:
        'Needs a decision first about whether third-party text should be delimited where a brief is assembled; accepting the ' +
        'residual before that question is asked would close it by default.',
    }),
    beads: Object.freeze([]),
    reviewedOn: '2026-08-24',
    reviewMonths: 6,
  }),
  Object.freeze({
    id: 'human-oversight-that-is-a-rubber-stamp',
    title: 'A decision is recorded as the operator’s when nobody really made it',
    statement:
      'The strongest claim this management system makes is that certain things only a person may decide. Those decisions ' +
      'arrive as cards on a phone, with the options written by the agent that raised them and the recommended answer already ' +
      'drafted into the answer box. A tap is indistinguishable, in every record kept, from a considered decision.',
    sources: Object.freeze([
      'The agent that needs the answer writes the question, the options and the sentence recorded as the answer.',
      'Cards are answered on a phone, at whatever moment the notification arrives, without the work in front of the reader.',
      'One option is marked recommended, which is useful and is also the answer most likely to be taken.',
    ]),
    harmTo: Object.freeze(['organisation', 'individuals', 'society']),
    inherent: Object.freeze({ likelihood: 'likely', consequence: 'major' }),
    treatment: 'reduce',
    treats:
      'The tap is genuinely the act: no agent closes a gate and no agent closes a bead waiting to be approved, so the ' +
      'decision cannot be manufactured by the party that wants it. Who may approve what is a table with refusals behind it ' +
      'rather than a convention, and the answer is kept with the question it answered.',
    controls: Object.freeze(['ISO42001.A.9.2', 'ISO42001.A.3.2', 'ISO42001.Clause5.3']),
    enforcedBy: Object.freeze(['lib/approval.js', 'lib/aims.js', 'lib/answered.js', 'lib/decision.js']),
    evidence: Object.freeze(['foundation-amendments', 'election-history', 'management-transitions']),
    residual: Object.freeze({ likelihood: 'possible', consequence: 'major' }),
    owes:
      'What is enforced is that a person tapped, which is not the same claim as that a person decided. Nothing records how ' +
      'long the card was open, whether the material behind it was opened, or that the answer differed from the recommended ' +
      'one — and an oversight control nobody can distinguish from a reflex is the finding A.9.2 exists to raise. This is the ' +
      'entry whose consequence reaches furthest, because it is the one that makes every other treatment here true or hollow.',
    owner: 'top-management',
    acceptance: Object.freeze({
      state: 'owed',
      by: null,
      role: null,
      on: null,
      why:
        'It would be a strange thing for the operator to accept alone, since it is a risk about that operator’s own ' +
        'attention, and it is the one entry here where a second reader is worth most. Recording it as owed keeps the ' +
        'question open rather than answering it with a tap.',
    }),
    beads: Object.freeze([]),
    reviewedOn: '2026-08-24',
    reviewMonths: 6,
  }),
]);

/* ---------------------------------------------------------- what must hold */

/**
 * A 42001 corpus id, held to shape here and resolved against the real corpus by the
 * suite — the leaf arrangement `lib/servicescope.js` established.
 *
 * At least two dots is deliberate: a pattern of the form `^[A-Za-z0-9]+(\.[A-Za-z0-9]+)+$`
 * happily accepts `A.9.2`, which is the framework-less id the framework token exists to
 * prevent, and `ISO27001.A.5.2` and `ISO42001.A.5.2` are different controls.
 */
const CONTROL_RE = /^ISO42001\.(A\.\d+(?:\.\d+){1,2}|Clause\d+(?:\.\d+){1,2})$/;

/** Is this the shape a 42001 corpus id has? Says nothing about whether it is minted. */
export const isControlId = (id) => CONTROL_RE.test(text(id));

/** An evidence class id, as `lib/evidence.js` mints them. Resolved for real in the suite. */
const EVIDENCE_RE = /^[a-z][a-z0-9-]*$/;

/** A bead id, held to shape only — this file reads no tracker. */
const BEAD_RE = /^[a-z]{2}-[a-z0-9]+(\.\d+)*$/;

/** The role ids the management system has, from `lib/aims.js` rather than from a copy. */
export const OWNER_ROLES = Object.freeze(AIMS_ROLES.map((r) => r.id));

/**
 * Everything wrong with one risk, as sentences.
 *
 * Takes an entry rather than reading {@link RISKS}, for the reason `lib/evidence.js`,
 * `lib/documents.js` and `lib/policies.js` all give for the same split: the register is
 * frozen and supposed to be clean, so a rule that only ever runs against it can report a
 * pass and can never be shown to fail. `test/risk.mjs` runs these against entries broken
 * one field at a time.
 */
export function entryProblems(r, criteria = CRITERIA) {
  const problems = [];
  const at = `RISKS[${text(r?.id) || '?'}]`;

  if (!/^[a-z][a-z0-9-]*$/.test(text(r?.id))) problems.push(`${at}: id must be kebab-case`);
  if (!named(r?.title)) problems.push(`${at}: \`title\` must name the risk in a line`);
  if (!prose(r?.statement)) {
    problems.push(`${at}: \`statement\` must say what could happen and how, in sentences — a title is not a risk description`);
  }

  if (!Array.isArray(r?.sources) || r.sources.length === 0) {
    problems.push(`${at}: \`sources\` must name at least one source of the risk — a risk with no source is a worry`);
  } else {
    for (const s of r.sources) if (!prose(s)) problems.push(`${at}: a \`sources\` entry must be a sentence, not a word`);
  }

  if (!Array.isArray(r?.harmTo) || r.harmTo.length === 0) {
    problems.push(
      `${at}: \`harmTo\` must name at least one of ${HARMS.join(', ')} — a register that never asks who the harm falls on ` +
        'is the register ISO/IEC 23894 exists to refuse'
    );
  } else {
    for (const h of r.harmTo) if (!HARMS.includes(text(h))) problems.push(`${at}: \`${text(h)}\` is not one of ${HARMS.join(', ')}`);
    if (new Set(r.harmTo.map(text)).size !== r.harmTo.length) problems.push(`${at}: \`harmTo\` names the same party twice`);
  }

  for (const which of ['inherent', 'residual']) {
    if (!likelihood(r?.[which]?.likelihood)) {
      problems.push(`${at}: \`${which}.likelihood\` must be one of ${LIKELIHOOD.map((l) => l.id).join(', ')}`);
    }
    if (!consequence(r?.[which]?.consequence)) {
      problems.push(`${at}: \`${which}.consequence\` must be one of ${CONSEQUENCE.map((c) => c.id).join(', ')}`);
    }
  }

  const inherent = ratingOf(r, 'inherent');
  const residual = ratingOf(r, 'residual');

  if (inherent.score !== null && residual.score !== null) {
    if (residual.score > inherent.score) {
      problems.push(
        `${at}: the residual (${residual.score}) is worse than the inherent risk (${inherent.score}) — a treatment that ` +
          'makes a risk worse is a mistake being recorded as a control'
      );
    }
    if (text(r?.treatment) !== 'retain' && residual.score === inherent.score && !prose(r?.owes)) {
      problems.push(
        `${at}: the treatment changed nothing and \`owes\` does not say why. Either the treatment is \`retain\`, or the ` +
          'sentence explaining what is still missing is the point of the entry'
      );
    }
  }

  if (!TREATMENTS.includes(text(r?.treatment))) problems.push(`${at}: \`treatment\` must be one of ${TREATMENTS.join(', ')}`);
  if (!prose(r?.treats)) problems.push(`${at}: \`treats\` must say what the treatment actually is, in a sentence`);

  if (!Array.isArray(r?.controls) || r.controls.length === 0) {
    problems.push(`${at}: \`controls\` must name at least one control that treats this — a treatment resolving to nothing treats nothing`);
  } else {
    for (const id of r.controls) {
      if (!isControlId(id)) {
        problems.push(
          `${at}: \`${text(id)}\` is not the shape a 42001 corpus id has — the framework token is part of the id, because ` +
            'ISO27001.A.5.2 and ISO42001.A.5.2 are different controls'
        );
      }
    }
    if (new Set(r.controls.map(text)).size !== r.controls.length) problems.push(`${at}: \`controls\` names the same control twice`);
  }

  if (!Array.isArray(r?.enforcedBy)) {
    problems.push(`${at}: \`enforcedBy\` must be a list of files, empty if nothing here enforces it — an absent list reads as "not applicable"`);
  }

  if (!Array.isArray(r?.evidence)) {
    problems.push(`${at}: \`evidence\` must be a list of evidence class ids, empty if nothing is kept`);
  } else {
    for (const id of r.evidence) if (!EVIDENCE_RE.test(text(id))) problems.push(`${at}: \`${text(id)}\` is not the shape an evidence class id has`);
    if (Array.isArray(r?.enforcedBy) && r.enforcedBy.length > 0 && r.evidence.length === 0) {
      problems.push(
        `${at}: something enforces this and no class of record is named. A control operating with nothing kept is a control ` +
          'nobody can sample, which is the exception fieldwork writes up as "unable to test"'
      );
    }
  }

  if (Array.isArray(r?.enforcedBy) && r.enforcedBy.length === 0 && !prose(r?.owes)) {
    problems.push(`${at}: nothing enforces this and \`owes\` does not say so — an empty enforcement is a finding, in a sentence`);
  }

  if (!OWNER_ROLES.includes(text(r?.owner))) {
    problems.push(
      `${at}: \`owner\` must be one of the management system's roles (${OWNER_ROLES.join(', ')}) — an owner who is not a ` +
        'role is an owner nobody is accountable as'
    );
  }

  if (!Array.isArray(r?.beads)) problems.push(`${at}: \`beads\` must be a list, empty if no bead tracks the treatment yet`);
  else for (const b of r.beads) if (!BEAD_RE.test(text(b))) problems.push(`${at}: \`${text(b)}\` is not the shape a bead id has`);

  if (parseDate(r?.reviewedOn) === null) problems.push(`${at}: \`reviewedOn\` must be a real date, as YYYY-MM-DD`);
  if (!Number.isInteger(r?.reviewMonths) || r.reviewMonths < 1 || r.reviewMonths > MAX_REVIEW_MONTHS) {
    problems.push(
      `${at}: \`reviewMonths\` must be a whole number of months between 1 and ${MAX_REVIEW_MONTHS} — a rating nobody ` +
        'revisits is a rating about a system that has since changed'
    );
  }

  problems.push(...acceptanceProblems(r, residual.band, at, criteria));
  return problems;
}

/**
 * Everything wrong with one risk's acceptance, given the band its residual is in.
 *
 * Split out because this is the rule 6.1.3 is actually about and it is the one worth
 * being able to point a fixture at: three states, and every one of them wrong in a
 * different way.
 */
export function acceptanceProblems(
  r,
  band = ratingOf(r, 'residual').band,
  at = `RISKS[${text(r?.id) || '?'}]`,
  criteria = CRITERIA
) {
  const problems = [];
  const a = r?.acceptance;

  if (!a || typeof a !== 'object') return [`${at}: \`acceptance\` must say whether the residual is accepted, owed, or below the line`];
  if (!ACCEPTANCE.includes(text(a.state))) {
    problems.push(`${at}: \`acceptance.state\` must be one of ${ACCEPTANCE.join(', ')}`);
    return problems;
  }
  if (!prose(a.why)) problems.push(`${at}: \`acceptance.why\` must say why it is in that state, in a sentence`);

  if (band === null) return problems;
  const required = acceptorFor(band, criteria);
  const owed = needsAcceptance(band, criteria);

  if (!owed && text(a.state) !== 'not-required') {
    problems.push(
      `${at}: the residual is ${band}, which the criteria call acceptable, so \`acceptance.state\` is \`not-required\` — ` +
        'accepting a risk that needed no acceptance reads as a decision somebody made and did not have to'
    );
  }
  if (owed && text(a.state) === 'not-required') {
    problems.push(
      `${at}: the residual is ${band} and the criteria require an acceptance for that band — \`not-required\` here is the ` +
        'register quietly moving its own line'
    );
  }
  if (owed && required === null && text(a.state) === 'accepted') {
    problems.push(`${at}: ${text(criteria?.unacceptable) || 'a residual in this band may not be retained'}`);
  }

  if (text(a.state) === 'accepted') {
    if (!named(a.by)) problems.push(`${at}: \`acceptance.by\` must name the person who accepted it — "the owner" is not a name`);
    if (parseDate(a.on) === null) problems.push(`${at}: \`acceptance.on\` must be the date it was accepted, as YYYY-MM-DD`);

    if (!OWNER_ROLES.includes(text(a.role))) {
      problems.push(`${at}: \`acceptance.role\` must be the role they accepted it as, and one the management system has`);
    } else if (!mayApprove(text(a.role), ACCEPTANCE_APPROVAL)) {
      problems.push(`${at}: the ${text(a.role)} role may not give a ${ACCEPTANCE_APPROVAL} approval`);
    } else if (required !== null && text(a.role) !== required && text(a.role) !== TOP) {
      // Top management may accept anything that may be accepted at all; anybody else may
      // accept only their own band. The criteria decide that, never the entry.
      problems.push(
        `${at}: a ${band} residual is accepted by the ${required} role or by ${TOP}, and this one is signed by ` +
          `${text(a.role)}`
      );
    }
  } else {
    for (const field of ACCEPTED_FIELDS) {
      if (a[field] != null) {
        problems.push(`${at}: \`acceptance.${field}\` is set on a residual nobody has accepted — an acceptance nobody gave cannot be recorded`);
      }
    }
  }

  return problems;
}

/** Everything wrong with the criteria themselves — the half 6.1.2 is about. */
export function criteriaProblems(criteria = CRITERIA) {
  const problems = [];
  const at = 'CRITERIA';

  if (parseDate(criteria?.statedOn) === null) {
    problems.push(`${at}: \`statedOn\` must be the date the criteria were decided — criteria with no date are criteria drawn around the answers`);
  }
  for (const field of ['scale', 'unacceptable', 'harmWeighting', 'whyMostlyOrganisational']) {
    if (!prose(criteria?.[field])) problems.push(`${at}: \`${field}\` must be stated in sentences`);
  }
  if (parseDate(criteria?.reviewedOn) === null) problems.push(`${at}: \`reviewedOn\` must be a real date, as YYYY-MM-DD`);
  if (!Number.isInteger(criteria?.reviewMonths) || criteria.reviewMonths < 1 || criteria.reviewMonths > MAX_REVIEW_MONTHS) {
    problems.push(`${at}: \`reviewMonths\` must be a whole number of months between 1 and ${MAX_REVIEW_MONTHS}`);
  }

  const acceptable = Array.isArray(criteria?.acceptable) ? criteria.acceptable.map(text) : [];
  const treat = Array.isArray(criteria?.requiresTreatment) ? criteria.requiresTreatment.map(text) : [];
  if (acceptable.length === 0) problems.push(`${at}: \`acceptable\` must name at least one band, or nothing is ever acceptable`);
  for (const band of [...acceptable, ...treat]) if (!BANDS.includes(band)) problems.push(`${at}: \`${band}\` is not one of ${BANDS.join(', ')}`);
  for (const band of BANDS) {
    const both = acceptable.includes(band) && treat.includes(band);
    const neither = !acceptable.includes(band) && !treat.includes(band);
    if (both) problems.push(`${at}: ${band} is both acceptable and requires treatment`);
    if (neither) problems.push(`${at}: ${band} is neither acceptable nor requires treatment — every band has to fall on one side`);
  }
  for (const band of acceptable) {
    if (needsAcceptance(band, criteria)) {
      problems.push(`${at}: ${band} is acceptable and also names an acceptor — a band below the line needs nobody's signature`);
    }
  }
  for (const [band, role] of Object.entries(criteria?.acceptedBy || {})) {
    if (!BANDS.includes(text(band))) problems.push(`${at}: \`acceptedBy\` names ${text(band)}, which is not a band`);
    if (role === null) continue;
    if (!OWNER_ROLES.includes(text(role))) problems.push(`${at}: \`acceptedBy.${band}\` names ${text(role)}, which is not a role`);
    else if (!mayApprove(text(role), ACCEPTANCE_APPROVAL)) {
      problems.push(`${at}: \`acceptedBy.${band}\` names ${text(role)}, which may not give a ${ACCEPTANCE_APPROVAL} approval`);
    }
  }

  const covered = THRESHOLDS.map((t) => t.band);
  if (covered.join() !== BANDS.join()) problems.push(`${at}: THRESHOLDS and BANDS disagree about the bands or their order`);
  if (THRESHOLDS[THRESHOLDS.length - 1]?.upTo !== 25) problems.push(`${at}: the top threshold must reach 25, the largest score the scales can produce`);
  for (let i = 1; i < THRESHOLDS.length; i++) {
    if (THRESHOLDS[i].upTo <= THRESHOLDS[i - 1].upTo) problems.push(`${at}: the thresholds do not increase — ${THRESHOLDS[i].band} is not above ${THRESHOLDS[i - 1].band}`);
  }

  return problems;
}

/**
 * Everything wrong with the register as a register, without touching the disk or the
 * clock.
 *
 * Thrown at import, below, the way `lib/policies.js` and `lib/servicescope.js` throw
 * theirs: a register that could ship malformed is one that answers "nothing is untreated"
 * on the machine reporting what is untreated. Dates and files are deliberately *not* here
 * — an overdue review must fail a check rather than crash every process that imports this.
 */
export function registerProblems(register = RISKS, criteria = CRITERIA, method = METHOD) {
  if (!Array.isArray(register)) return ['the risk register is a list of risks'];

  const problems = [...methodProblems(method), ...criteriaProblems(criteria)];
  const seen = new Set();
  for (const r of register) {
    problems.push(...entryProblems(r, criteria));
    if (seen.has(text(r?.id))) problems.push(`RISKS[${text(r?.id)}]: two risks with the same id`);
    seen.add(text(r?.id));
  }
  return problems;
}

/* -------------------------------------------------------------- the reads */

/** Every control id any risk names as a treatment, deduplicated and sorted. */
export function controlsClaimed(register = RISKS) {
  const ids = new Set();
  for (const r of register) for (const id of r.controls || []) ids.add(text(id));
  return [...ids].sort();
}

/** Every evidence class id any risk names, deduplicated and sorted. */
export function evidenceClaimed(register = RISKS) {
  const ids = new Set();
  for (const r of register) for (const id of r.evidence || []) ids.add(text(id));
  return [...ids].sort();
}

/** Which risks this control was selected to treat — the Statement of Applicability's column. */
export const risksFor = (id, register = RISKS) => register.filter((r) => (r.controls || []).some((c) => text(c) === text(id)));

/** Every risk that names this party in `harmTo`. */
export const harming = (party, register = RISKS) => register.filter((r) => (r.harmTo || []).some((h) => text(h) === text(party)));

/**
 * The risks whose residual is in `band` or worse — "show me everything high or above",
 * which is the cut a management review reads and the one a report leads with.
 *
 * Ordered by score, worst first, so the list is the same list however the register is
 * sorted; ties keep the register's own order, because two risks scoring the same are not
 * ranked against each other by anything here and pretending otherwise would be arithmetic.
 */
export function atOrAbove(band, register = RISKS) {
  return register
    .map((r, i) => ({ r, i, score: ratingOf(r, 'residual').score ?? 0, band: ratingOf(r, 'residual').band }))
    .filter((x) => atLeastBand(x.band, band))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.r);
}

/**
 * One risk's chain, in the order the audit reads it: the risk, what treats it, what makes
 * the treatment real here, and what could be sampled to see it working.
 *
 * The shape bc-eqn1.14 needs. Nothing is looked up — this is the entry rearranged, so it
 * works with a doctored register in a fixture exactly as it does with the real one.
 */
export function chain(entry) {
  const inherent = ratingOf(entry, 'inherent');
  const residual = ratingOf(entry, 'residual');
  return {
    risk: text(entry?.id),
    title: text(entry?.title),
    owner: text(entry?.owner),
    harmTo: [...(entry?.harmTo || [])],
    inherent,
    treatment: text(entry?.treatment),
    controls: [...(entry?.controls || [])],
    enforcedBy: [...(entry?.enforcedBy || [])],
    evidence: [...(entry?.evidence || [])],
    residual,
    acceptance: text(entry?.acceptance?.state),
    acceptedBy: entry?.acceptance?.by ?? null,
  };
}

/**
 * The other frameworks these treatments serve, read off the corpus rather than written
 * here.
 *
 * `crosswalk` is `lib/controls.js`'s, passed in: for a 42001 control or clause, the ids it
 * declares an edge to. So a risk treated by `ISO42001.Clause6.1.2` is evidence for
 * whichever SOC 2 criteria that clause points at — which is bc-4r10.8's whole argument,
 * that CC3 and CC9 read off this register rather than growing a second one. A second
 * mapping typed out here is how the two come to disagree.
 */
export function alsoServes(entry, crosswalk) {
  const ids = new Set();
  for (const id of entry?.controls || []) for (const other of crosswalk(text(id)) || []) ids.add(text(other));
  return [...ids].sort();
}

/** What this risk is right now: how its review date stands. `now` is a parameter on purpose. */
export function stateOf(entry, now = new Date()) {
  const { due, days, state } = reviewStatus(entry, now);
  return { state: state ?? null, due, days };
}

/** The risks whose residual is above the line and whose acceptance nobody has given. */
export const unaccepted = (register = RISKS) =>
  register.filter((r) => needsAcceptance(ratingOf(r, 'residual').band) && text(r.acceptance?.state) !== 'accepted');

/** The risks nothing in this repository enforces — the readiness gap, in order. */
export const untreated = (register = RISKS) => register.filter((r) => (r.enforcedBy || []).length === 0);

/** The risks whose treatment left the rating exactly where it was. */
export const unmoved = (register = RISKS) =>
  register.filter((r) => {
    const i = ratingOf(r, 'inherent').score;
    const d = ratingOf(r, 'residual').score;
    return i !== null && d !== null && i === d;
  });

/* --------------------------------------------------------------- the check */

/**
 * Everything wrong with the register in this checkout, split into what fails and what
 * warns.
 *
 * Returned rather than thrown so one run names every problem — reviews come due in
 * batches, and the day somebody sits down to do one they should be told about all of
 * them. `controls` and `evidence` are optional: hand them the neighbouring registers and
 * the resolution rules run, leave them out and everything else still does, which is what
 * lets the suite keep working in a release where one of them has not landed.
 */
export function setProblems(
  root,
  now = new Date(),
  { register = RISKS, criteria = CRITERIA, method = METHOD, controls = null, evidence = null } = {}
) {
  const problems = [...registerProblems(register, criteria, method)];
  const warnings = [];

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const stale = (entry, at, what) => {
    const { state, due, days } = stateOf(entry, now);
    if (state === 'overdue') {
      problems.push(
        `${at}: ${what} was due for review ${due}, ${-days} day${days === -1 ? '' : 's'} ago. Re-rate it against what the ` +
          'system does now, then move `reviewedOn` — a rating nobody revisited is a rating about a system that has changed.'
      );
    }
    if (state === 'approaching') warnings.push(`${at}: review due ${due}, in ${days} day${days === 1 ? '' : 's'}.`);
  };

  for (const field of ['statedOn', 'reviewedOn']) {
    const t = parseDate(criteria?.[field]);
    if (t !== null && t > today) problems.push(`CRITERIA: \`${field}\` is ${criteria[field]}, which has not happened yet`);
  }
  stale(criteria, 'CRITERIA', 'the risk criteria');

  for (const step of method) {
    const at = `METHOD[${text(step?.process) || '?'}]`;
    for (const file of step.where || []) {
      if (file.includes('/') && !fs.existsSync(path.join(root, file))) {
        problems.push(`${at}: \`where\` names ${file}, which is not in the repo — the method points at something nobody can read`);
      }
    }
    if (controls) {
      for (const id of [text(step?.process), ...(step.clauses || [])]) {
        if (!controls.includes(text(id))) {
          problems.push(`${at}: \`${text(id)}\` is not in the control corpus — the method cites a clause that does not exist`);
        }
      }
    }
  }

  for (const r of register) {
    const at = `RISKS[${text(r?.id) || '?'}]`;

    for (const file of r.enforcedBy || []) {
      if (!fs.existsSync(path.join(root, file))) {
        problems.push(
          `${at}: \`enforcedBy\` names ${file}, which is not in the repo — either it was renamed, in which case say so ` +
            'here, or the treatment it claimed is gone and the residual is wrong'
        );
      }
    }

    for (const field of ['reviewedOn']) {
      const t = parseDate(r?.[field]);
      if (t !== null && t > today) problems.push(`${at}: \`${field}\` is ${r[field]}, which has not happened yet`);
    }
    const accepted = parseDate(r?.acceptance?.on);
    if (accepted !== null && accepted > today) problems.push(`${at}: \`acceptance.on\` is ${r.acceptance.on}, which has not happened yet`);

    stale(r, at, 'this risk');

    if (controls) {
      for (const id of r.controls || []) {
        if (!controls.includes(text(id))) {
          problems.push(
            `${at}: \`${text(id)}\` is not in the control corpus — a treatment naming a control that does not exist treats ` +
              'nothing, and it is the column of a Statement of Applicability that cannot be generated'
          );
        }
      }
    }

    if (evidence) {
      for (const id of r.evidence || []) {
        if (!evidence.includes(text(id))) {
          problems.push(
            `${at}: \`${text(id)}\` is not a class in the evidence register — either it was renamed there, or this risk ` +
              'claims a record nobody keeps'
          );
        }
      }
    }
  }

  return { problems, warnings };
}

/** The register in one paragraph, for a README, a report or a card. */
export function summarise(register = RISKS, now = new Date()) {
  const bands = register.map((r) => ratingOf(r, 'residual').band);
  const above = bands.filter((b) => needsAcceptance(b)).length;
  const overdue = register.filter((r) => stateOf(r, now).state === 'overdue').length;
  const owed = unaccepted(register).length;
  const still = unmoved(register).length;
  return (
    `${register.length} risks, ${above} of them with a residual above the acceptable band` +
    `${overdue ? `, ${overdue} past their review date` : ''}. ` +
    `${owed} residual${owed === 1 ? '' : 's'} still owe${owed === 1 ? 's' : ''} an acceptance, ` +
    `${untreated(register).length} have nothing in this repository enforcing them, and ${still} ` +
    `${still === 1 ? 'was' : 'were'} not moved at all by ${still === 1 ? 'its' : 'their'} treatment. Between them they ` +
    `select ${controlsClaimed(register).length} controls and rest on ${evidenceClaimed(register).length} classes of record. ` +
    `The method has ${methodGaps().length} of ISO/IEC 23894's eight process steps admitting to a gap.`
  );
}

const BROKEN = registerProblems();
if (BROKEN.length) throw new Error(`risk register: ${BROKEN.join('; ')}`);
