/**
 * The auditor engagement — what the letter has to name, and the two dates nobody may type.
 *
 * SOC 2 has no accredited body and no certificate. The report is signed by a licensed CPA
 * firm subject to AICPA peer review, so *which firm* is a commercial decision with a
 * technical half, and *when the period starts* is the decision that quietly decides whether
 * the report comes back clean. This module holds both, and holds them the way the rest of
 * this layer holds everything: the judgements are data, and every state read off them is
 * derived at the moment of asking.
 *
 * ## The dates are computed, and the computation refuses to produce a date
 *
 * `bc-j0o3` was answered: **Type I now, with the Type II observation window opening the
 * same day.** The Type I is largely a by-product of preparing for the Type II, so having
 * both costs little, and starting the clock early is the only lever that shortens a
 * timeline otherwise made of elapsed time.
 *
 * The rule that answer creates is the one that gets broken. The window opens when the
 * controls demonstrably **operate** — not when a report is wanted. Opening it earlier does
 * not shorten anything; it produces a report containing exceptions, which is commercially
 * worse than a later clean one. So a stored `windowOpensOn: '2026-09-01'` is not a plan, it
 * is a bet that thirty-eight criteria will be met by a date chosen before anybody looked,
 * and the bet is settled by an auditor rather than by the person who typed it.
 *
 * So this module has no date field. {@link readiness} asks `lib/gapassessment.js` two
 * questions — is every elected criterion's control *described* (the design gate, which is
 * what a Type I opines on), and is every one of them *met against an enumerated population*
 * (the operating gate, which is what a window needs) — and {@link schedule} reports whether
 * a date may be set at all and what is holding it. Today neither gate is open and
 * thirty-eight criteria are holding, which is the same finding the gap assessment makes,
 * arriving where somebody is about to pick a date.
 *
 * Because `bc-j0o3` put both on one day, the binding gate is the stricter of the two. That
 * falls out rather than being written down: {@link REPORT_PLAN}`.sameDay` is the recorded
 * answer, and {@link schedule} reads it.
 *
 * ## A firm is not selected here, and the emptiness is the record
 *
 * {@link QUOTES} is empty and {@link ENGAGED} is `null`. That is not a placeholder. An
 * engagement with no quotes and an engagement whose quotes were solicited and rejected look
 * identical in a register that lists only what was chosen — the same absence the gap
 * assessment refuses one level down. {@link selection} names four states and derives which
 * one holds from the quotes present, so *nobody has asked yet* is a legible answer with a
 * next action attached rather than a blank.
 *
 * {@link FIRM_CLASSES} records what the choice is between rather than who to call, because
 * the class decides cost, duration and how much the report is trusted, and the specific
 * firms inside a class change faster than this file will. {@link SEPARATING} is the pair of
 * questions from `bc-4r10.13` that actually discriminate: how a control is tested when its
 * evidence is a git ref rather than a screenshot, and whether the firm has signed for a
 * service organisation whose privileged actors are mostly automated. The list is two long
 * and closed on purpose — a question every firm answers the same way is not a question, it
 * is a paragraph in a proposal.
 *
 * {@link QUOTE_TERMS} is what a quote must cover to be comparable at all. `bc-4r10.13` asks
 * for two or three quotes *covering both Type I and Type II*, so that the sequencing
 * `bc-j0o3` chose is priced rather than guessed; a quote for one of the two prices a
 * different plan and comparing it to a quote for both is how the cheap number wins.
 *
 * ## The letter names four things and two of them cannot be filled in yet
 *
 * {@link LETTER_TERMS} is the engagement letter reduced to the four things it must name —
 * the elected criteria, the description criteria, the period, and the subservice method —
 * and each is *resolved from a neighbour* rather than restated. {@link letter} asks, and
 * gets two answers and two refusals:
 *
 * - **the elected criteria** resolve, out of the gap assessment, which takes them from
 *   `lib/policies.js`, which is the one home for `ELECTED`;
 * - **the description criteria** resolve, out of `lib/systemdescription.js`'s DC section 200
 *   sections;
 * - **the period** does not, because the gates are shut;
 * - **the subservice method** does not, and this is the one worth reading twice. The
 *   boundary's subservice list is empty under a **partial** census — which says *nobody has
 *   surveyed the processors*, not *there are none*. A method is a decision per subservice
 *   organisation, and there is no list to decide over. An engagement letter naming
 *   `carve-out` today would be asserting a decision about organisations nobody has
 *   enumerated, and each carve-out owes a CUEC the user entities have to act on.
 *
 * ## Bridge letters are two dates and a rule, so they are computed too
 *
 * A report covers a period. A customer asks for it on some later date. The gap between
 * period end and the request is what a bridge letter covers, and {@link bridge} derives
 * which of three states holds from those two dates alone. Past {@link BRIDGE_MAX_MONTHS} a
 * bridge is not what is wanted — the honest answer is a new report, and a firm asked for a
 * six-month bridge will say so after the invoice.
 *
 * ## What it is, structurally
 *
 * A joining module, like `lib/systemdescription.js` and `lib/gapassessment.js`: it imports
 * the boundary, the description and the assessment, and nothing else. It is one level above
 * the leaves rather than beside them — it asks the gap assessment for readiness rather than
 * re-deriving it from the corpus, because a second opinion about whether a criterion is met
 * is exactly the second copy this layer exists to refuse. Nothing here writes: no config
 * directory, no tracker, no git, no network. The register ships compiled into the release.
 */
import { boundaryFor, subservice } from './boundary.js';
import { ASSESSMENT, ELECTED, HELD_BY, ROLES, assess, counts } from './gapassessment.js';
import { SECTION_IDS, periodProblems } from './systemdescription.js';

/**
 * Re-exported rather than restated, for the reason `lib/gapassessment.js` re-exports them.
 *
 * `ELECTED` and `ROLES` have one home and it is `lib/policies.js`. An engagement letter that
 * named a different set of categories than the assessment was run against is the single
 * most expensive disagreement this layer could ship, so there is no second copy to disagree.
 */
export { ELECTED, HELD_BY, ROLES };

/** What settled each half of this, so an answer can be argued with rather than guessed at. */
export const DECIDED_BY = Object.freeze({
  subject: 'bc-228x',
  order: 'bc-lws1',
  type: 'bc-j0o3',
  categories: 'bc-yfgo',
  tooling: 'bc-4r10.17',
});

/**
 * What `bc-j0o3` actually answered, as data rather than as a sentence in a comment.
 *
 * `sameDay` is the load-bearing field: it is why {@link schedule} reports the stricter of
 * the two gates as binding instead of dating the Type I early and the window later.
 */
export const REPORT_PLAN = Object.freeze({
  typeOne: true,
  typeTwo: true,
  sameDay: true,
  decidedBy: 'bc-j0o3',
  why:
    'The Type I is largely a by-product of preparing for the Type II, so having both costs little, and ' +
    'starting the clock early is the only lever that shortens a timeline otherwise made of elapsed time. ' +
    'The window still opens when the controls demonstrably operate — a window opened before that produces ' +
    'a report containing exceptions rather than a shorter timeline.',
});

/* --------------------------------------------------------------- the firm */

/**
 * What the choice is between. Not who to call — the class is what moves the numbers.
 *
 * Named firms belong in a quote, not in a module that ships compiled into a release: the
 * roster inside each class turns over faster than this file will, and a stale name reads as
 * a recommendation. What does not turn over is the shape of the trade: an audit-tech
 * platform bundles the firm with the evidence tooling and is fastest, a boutique
 * security-assurance firm is read as more credible by buyers who read the report, and a
 * general accounting firm with a small assurance practice is cheapest and least persuasive.
 */
export const FIRM_CLASSES = Object.freeze(
  [
    {
      id: 'audit-tech',
      label: 'An audit-tech platform that bundles a CPA firm',
      bundlesTooling: true,
      cost: 'lowest sticker price, and the subscription is the other half of it',
      credibility:
        'Adequate for procurement checkboxes. Buyers who read the report notice the template, and the ' +
        'report tends to describe the platform’s integrations rather than the system.',
      risk:
        'The bundle answers the tooling question in `bc-4r10.17` and the firm question at once, which is ' +
        'convenient and is also how a firm gets chosen by a tooling decision nobody framed that way.',
    },
    {
      id: 'boutique-assurance',
      label: 'A boutique security-assurance firm',
      bundlesTooling: false,
      cost: 'highest, and quoted per report rather than per seat',
      credibility:
        'Highest with security-literate buyers, who are the ones who read the description and the ' +
        'exceptions rather than the cover page.',
      risk:
        'Availability. The firms worth having are booked out, which makes the readiness call the thing ' +
        'to schedule early even when the window cannot open for months.',
    },
    {
      id: 'general-accounting',
      label: 'A general accounting firm with a small assurance practice',
      bundlesTooling: false,
      cost: 'lowest fee, and the most of our own time',
      credibility:
        'Least persuasive, and the period is spent explaining what a service organisation is before ' +
        'anything about this one gets tested.',
      risk:
        'A firm that has not signed many of these writes a description that reads like a questionnaire, ' +
        'and the description is the part a user entity actually reads.',
    },
  ].map(Object.freeze)
);

/**
 * The two questions that separate firms, from `bc-4r10.13`.
 *
 * Two, and closed. A question every firm answers the same way discriminates nothing and
 * makes a comparison table look thorough while comparing nothing — and the answers to these
 * two predict how much of the observation window is spent explaining the system rather than
 * being tested against it, which is the cost nobody quotes.
 */
export const SEPARATING = Object.freeze(
  [
    {
      id: 'git-ref-evidence',
      asks: 'How do you test a control whose evidence is a git ref rather than a screenshot?',
      predicts:
        'Whether the sample can be handed over as refs and verified, or has to be re-photographed into ' +
        'screenshots for a workpaper — which is weeks of somebody’s time and produces worse evidence than ' +
        'the ref it was copied from.',
    },
    {
      id: 'automated-actors',
      asks:
        'Have you signed a report for a service organisation where most privileged actors are automated ' +
        'rather than human?',
      predicts:
        'Whether CC6 gets tested against agent identity as it exists, or against a user-access-review ' +
        'template that assumes every principal is a person with a laptop.',
    },
  ].map(Object.freeze)
);

/** Two or three quotes, per `bc-4r10.13`. Below this there is nothing to compare. */
export const MIN_QUOTES = 2;

/**
 * What a quote has to cover before it can be compared to another one.
 *
 * `type-i` and `type-ii` are both required by `bc-4r10.13` for one reason: the sequencing
 * `bc-j0o3` chose has to be *priced* rather than guessed, and a quote for one of the two
 * prices a different plan. Comparing a Type-II-only quote against a both-reports quote is
 * how the cheapest number wins an argument it was not in.
 */
export const QUOTE_TERMS = Object.freeze(
  [
    { id: 'type-i', required: true, asks: 'The fee and the elapsed time for the Type I report.' },
    { id: 'type-ii', required: true, asks: 'The fee and the elapsed time for the Type II report, per window length quoted.' },
    {
      id: 'readiness',
      required: false,
      asks:
        'The fee for a readiness assessment, and whether it is separable — the gap assessment is already ' +
        'done, so a bundled readiness fee is being paid for work in hand.',
    },
    { id: 'bridge', required: false, asks: 'Whether bridge letters are included, and what each one costs.' },
    { id: 'peer-review', required: true, asks: 'The date of the firm’s most recent AICPA peer review, and its result.' },
  ].map(Object.freeze)
);

/**
 * Every quote received. Empty, and the emptiness is the record.
 *
 * Nobody has been asked. That is a different fact from "we asked three and none fit", and a
 * register that holds only what was chosen renders them identically — which is the same
 * silent absence `lib/gapassessment.js` refuses one level down. {@link selection} says which.
 */
export const QUOTES = Object.freeze([]);

/** The signed engagement letter, or `null`. No firm is engaged. */
export const ENGAGED = null;

/** Derived by {@link selection} from the quotes present. Never written down. */
export const SELECTION_STATES = Object.freeze(['unsolicited', 'quoting', 'quoted', 'engaged']);

/* -------------------------------------------------------------- the letter */

/**
 * The engagement letter, reduced to the four things it must name.
 *
 * Each resolves from a neighbour at the moment of asking. Restating any of them here would
 * produce a letter that agrees with itself and disagrees with the assessment it was written
 * from, which is the failure mode that survives every review because both copies read fine.
 */
export const LETTER_TERMS = Object.freeze(
  [
    {
      id: 'criteria',
      names: 'The Trust Services categories and the criteria within them the opinion covers.',
      from: 'lib/policies.js `ELECTED`, by way of lib/gapassessment.js — one home, so the letter and the assessment cannot disagree.',
    },
    {
      id: 'description-criteria',
      names: 'The description criteria the system description is written against — DC section 200.',
      from: 'lib/systemdescription.js `SECTIONS`, which generates the description rather than describing one written by hand.',
    },
    {
      id: 'period',
      names: 'The as-of date for the Type I and the window for the Type II.',
      from: 'Derived from readiness — see the header. There is no field to fill in.',
    },
    {
      id: 'subservice-method',
      names: 'Carve-out or inclusive, per subservice organisation.',
      from: 'lib/boundary.js `subservice()`, whose census is partial — so there is no list to decide over.',
    },
  ].map(Object.freeze)
);

/* --------------------------------------------------------------- the steps */

/**
 * The path `bc-4r10.13` sets out, in order, with the dependency written down.
 *
 * `needs` is what makes a step's state derivable: a step is `done` when its own predicate
 * holds, `ready` when everything it needs is done, and `blocked` otherwise. Nothing carries
 * a state, so a step cannot be ticked off in a planning meeting and stay ticked.
 */
export const STEPS = Object.freeze(
  [
    {
      id: 'gap-assessment',
      label: 'The internal gap assessment, so the readiness call is short',
      needs: [],
      owner: 'security lead',
      why:
        'A readiness assessment sold by a firm is this exercise with an invoice attached. Doing it first ' +
        'makes the engagement cheap, or makes the readiness line item refusable.',
      bead: 'bc-4r10.4',
    },
    {
      id: 'quotes',
      label: 'The readiness call, and two or three quotes each covering both Type I and Type II',
      needs: ['gap-assessment'],
      owner: 'executive sponsor',
      why:
        'So the sequencing bc-j0o3 chose is priced rather than guessed. The readiness call is part of this ' +
        'step rather than a step of its own: the gap assessment is already done, so what the call is for is ' +
        'the two questions that separate firms and a quote, not an assessment sold back to us.',
      bead: 'bc-4r10.13',
    },
    {
      id: 'letter',
      label: 'An engagement letter naming criteria, description criteria, period and subservice method',
      needs: ['quotes'],
      owner: 'executive sponsor',
      why:
        'The four terms are what the opinion is bounded by. A letter that leaves one of them to be settled ' +
        'later settles it in the auditor’s favour.',
      bead: 'bc-4r10.13',
    },
    {
      id: 'type-i',
      label: 'The Type I as-of date',
      needs: ['letter'],
      gate: 'design',
      owner: 'security lead',
      why: 'A Type I opines on suitability of design at a date. A criterion with no described control has no design to opine on.',
      bead: 'bc-4r10.13',
    },
    {
      id: 'window-open',
      label: 'The Type II observation window opens',
      needs: ['letter'],
      gate: 'operating',
      owner: 'security lead',
      why:
        'The window opens when the controls demonstrably operate. Opened earlier it produces exceptions, ' +
        'which is commercially worse than a later clean report.',
      bead: 'bc-4r10.13',
    },
    {
      id: 'bridge',
      label: 'Bridge letters covering period end to a customer’s request date',
      needs: ['window-open'],
      owner: 'executive sponsor',
      why: 'A report ages the day the period ends, and the gap is what a user entity’s security review asks about.',
      bead: 'bc-4r10.13',
    },
  ].map(Object.freeze)
);

/** Derived by {@link stepState}. Never written down. */
export const STEP_STATES = Object.freeze(['done', 'ready', 'blocked']);

/** The two gates a date has to clear, and which report each belongs to. */
export const GATES = Object.freeze(['design', 'operating']);

/* -------------------------------------------------------------- the tooling */

/**
 * `bc-4r10.17` answered: buy a compliance platform, two to three months before the window
 * opens, with dated manual collection in the interim.
 *
 * Which makes the purchase date derived from a date that does not exist yet, and that is the
 * useful consequence — {@link platformPurchase} returns `null` rather than a quarter, so
 * nobody buys a subscription that starts burning months before there is anything to collect.
 */
export const PLATFORM_LEAD_MONTHS = Object.freeze({ min: 2, max: 3 });

/**
 * `bc-4r10.13`'s explicit non-goal: do not buy evidence-collection tooling before `bc-4r10.1`
 * and `bc-4r10.5` exist.
 *
 * The pitch for those platforms is that they collect evidence you do not otherwise have, and
 * the premise of this programme is that the evidence is a by-product of work that is already
 * gated. Buying first is how you pay a subscription to re-photograph a git ref.
 *
 * {@link nonGoal} checks it rather than asserting it: the corpus is present when the elected
 * criteria enumerate, and `bc-4r10.5` is done when CC8.1 carries evidence in the assessment.
 */
export const TOOLING_GATED_ON = Object.freeze(['bc-4r10.1', 'bc-4r10.5']);

/** The criterion `bc-4r10.5` is about, and the one {@link nonGoal} reads to see that it landed. */
const CHANGE_CRITERION = 'SOC2.CC8.1';

/* ------------------------------------------------------------- the bridge */

/**
 * How far past period end a bridge letter is the honest instrument.
 *
 * Three months is where user entity security reviews start asking for a current report
 * instead, and where a firm asked for a bridge will tell you the same thing after the
 * invoice. Past it the state is `stale`, which is not a worse bridge — it is a different
 * purchase.
 */
export const BRIDGE_MAX_MONTHS = 3;

/** Derived by {@link bridge} from two dates. Never written down. */
export const BRIDGE_STATES = Object.freeze(['covered', 'bridge', 'stale']);

/* ------------------------------------------------------------------ deriving */

const text = (v) => String(v ?? '').trim();
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(text(v));
const day = (v) => Date.parse(`${text(v)}T00:00:00Z`);

/**
 * The two gates, read off the gap assessment rather than re-derived from the corpus.
 *
 * **design** is what a Type I opines on: every elected criterion has a *described control*,
 * whether or not it has yet produced anything to sample. **operating** is what a window
 * needs: every criterion is `met` — control and evidence both — *and* `assessed` rather than
 * `provisional`, because a control cannot have been tested over a population nobody has
 * enumerated. The provisional half is the one people leave out, and it is why the operating
 * gate can be shut on a register whose every row says met.
 */
export function readiness(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  const rows = assess(register, boundary);
  const design = rows.filter((r) => !text(r.control));
  const operating = rows.filter((r) => r.state !== 'met' || r.confidence === 'provisional');
  return {
    design: {
      open: design.length === 0,
      holding: design.map((r) => r.id).sort(),
      why: 'A Type I opines on suitability of design. A criterion with no described control has nothing to opine on.',
    },
    operating: {
      open: operating.length === 0,
      holding: operating.map((r) => r.id).sort(),
      why:
        'The window opens when the controls demonstrably operate. A criterion that is not met, or that is ' +
        'met against a population nobody has enumerated, cannot be sampled across a period.',
    },
  };
}

/**
 * Whether a date may be set, and what is holding it — never a date.
 *
 * The two dates `bc-4r10.13` is named for are returned as `null` throughout. That is the
 * whole point: a date here would be a bet settled by an auditor, and the only honest thing
 * this module can compute is whether the bet would be a bet. `binding` is the gate that has
 * to open first — the stricter of the two while {@link REPORT_PLAN}`.sameDay` holds, and the
 * per-report gate otherwise.
 */
export function schedule(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  const gates = readiness(register, boundary);
  const same = REPORT_PLAN.sameDay === true;
  // The operating gate is strictly the stricter of the two — `met` cannot hold without a
  // described control — so while both dates are one day, it is the only one that binds, and
  // there is nothing binding once it opens.
  const bindingId = gates.operating.open ? null : 'operating';
  const typeOneGate = same ? gates.operating : gates.design;
  return {
    sameDay: same,
    decidedBy: REPORT_PLAN.decidedBy,
    binding: same ? bindingId : null,
    typeOneAsOf: null,
    typeTwoOpensOn: null,
    settable: gates.design.open && gates.operating.open,
    typeOne: { gate: same ? 'operating' : 'design', open: typeOneGate.open, holding: typeOneGate.holding },
    typeTwo: { gate: 'operating', open: gates.operating.open, holding: gates.operating.holding },
    why:
      same
        ? 'bc-j0o3 put the Type I as-of date and the Type II window open date on one day, so the binding gate is the stricter of the two.'
        : 'The Type I is dated on design and the window opens on operation, so each has its own gate.',
  };
}

/**
 * One step's state, from its predicate and from what it needs. Never written down.
 *
 * `gap-assessment` is done when the register enumerates the elected criteria, which is
 * checkable from here — the assessment refuses at import to be missing one, so a register
 * that loaded is a register that covers them. `quotes` and `letter` read {@link selection}.
 * The two dated steps read their gate. `bridge` cannot be done before there is a period.
 */
export function stepState(step, ctx) {
  const done = doneOf(step, ctx);
  if (done) return 'done';
  const needs = Array.isArray(step?.needs) ? step.needs : [];
  const blocked = needs.some((id) => {
    const prior = STEPS.find((s) => s.id === id);
    return !prior || !doneOf(prior, ctx);
  });
  return blocked ? 'blocked' : 'ready';
}

function doneOf(step, ctx) {
  switch (step?.id) {
    case 'gap-assessment':
      return ctx.criteria > 0;
    case 'quotes':
      return ctx.selection === 'quoted' || ctx.selection === 'engaged';
    case 'letter':
      return ctx.selection === 'engaged';
    case 'type-i':
      return ctx.selection === 'engaged' && ctx.schedule.typeOne.open;
    case 'window-open':
      return ctx.selection === 'engaged' && ctx.schedule.typeTwo.open;
    case 'bridge':
      return false;
    default:
      return false;
  }
}

/**
 * Which of the four selection states holds, derived from the quotes present.
 *
 * `unsolicited` is the one worth having a word for. It says nobody has been asked, which has
 * a next action attached; a register that only records the chosen firm says the same nothing
 * whether the search has not started or has failed.
 */
export function selection(quotes = QUOTES, engaged = ENGAGED) {
  const received = Array.isArray(quotes) ? quotes : [];
  const covers = (q) =>
    QUOTE_TERMS.filter((t) => t.required).every((t) => (Array.isArray(q?.covers) ? q.covers : []).includes(t.id));
  const comparable = received.filter(covers);
  const state = engaged ? 'engaged' : received.length === 0 ? 'unsolicited' : comparable.length >= MIN_QUOTES ? 'quoted' : 'quoting';
  return {
    state,
    received: received.length,
    comparable: comparable.length,
    needed: MIN_QUOTES,
    firm: engaged ? text(engaged.firm) || null : null,
    classes: FIRM_CLASSES.map((c) => c.id),
    why:
      state === 'unsolicited'
        ? 'No firm has been asked. The gap assessment is done, so the readiness call is short and the quotes are the next step.'
        : state === 'quoting'
          ? `${comparable.length} of ${received.length} quotes cover both reports; ${MIN_QUOTES} are needed to compare a price to anything.`
          : state === 'quoted'
            ? 'Enough comparable quotes to choose from. Nothing is signed.'
            : 'An engagement letter is in place.',
  };
}

/** Everything wrong with one quote, as sentences — so a quote can be added and checked. */
export function quoteProblems(quote) {
  const problems = [];
  const firm = text(quote?.firm);
  const at = firm || '(no firm)';
  if (!firm) problems.push('a quote names no firm');
  const cls = text(quote?.class);
  if (!FIRM_CLASSES.some((c) => c.id === cls)) {
    problems.push(`${at}: class "${cls}" is not one of ${FIRM_CLASSES.map((c) => c.id).join(', ')}`);
  }
  const covers = quote?.covers;
  if (!Array.isArray(covers)) problems.push(`${at}: covers must be an array of quote terms, even when empty`);
  else {
    for (const id of covers) {
      if (!QUOTE_TERMS.some((t) => t.id === id)) problems.push(`${at}: covers names "${id}", which is not a quote term`);
    }
    for (const term of QUOTE_TERMS.filter((t) => t.required)) {
      if (!covers.includes(term.id)) problems.push(`${at}: does not cover ${term.id} — it is not comparable to a quote that does`);
    }
  }
  const answers = quote?.answers && typeof quote.answers === 'object' ? quote.answers : {};
  for (const q of SEPARATING) {
    if (!text(answers[q.id])) problems.push(`${at}: did not answer "${q.id}" — that is one of the two questions that separate firms`);
  }
  if (quote?.peerReviewedOn !== undefined && quote?.peerReviewedOn !== null && !isDay(quote.peerReviewedOn)) {
    problems.push(`${at}: peerReviewedOn "${text(quote.peerReviewedOn)}" is not a date — YYYY-MM-DD`);
  }
  return problems;
}

/**
 * The four terms of the engagement letter, each resolved or refused with a reason.
 *
 * A refusal is a sentence somebody can act on, not a blank. Two of the four refuse today and
 * they refuse for different reasons: the period has no date because the gates are shut, and
 * the subservice method has no value because the list it would be a decision *over* has not
 * been surveyed.
 */
export function letter({ register = ASSESSMENT, boundary = boundaryFor(HELD_BY), period = null, engaged = ENGAGED } = {}) {
  const rows = assess(register, boundary);
  const sched = schedule(register, boundary);
  const processors = subservice(boundary);
  const censusState = boundary?.census?.subservice?.state || null;
  const periodIssues = period === null ? ['no period is stated'] : periodProblems(period);

  const terms = LETTER_TERMS.map((term) => {
    switch (term.id) {
      case 'criteria':
        return {
          ...term,
          resolved: true,
          value: { categories: [...ELECTED], criteria: rows.map((r) => r.id).sort() },
          says: `${ELECTED.join(', ')} — ${rows.length} criteri${rows.length === 1 ? 'on' : 'a'}.`,
        };
      case 'description-criteria':
        return {
          ...term,
          resolved: true,
          value: { sections: [...SECTION_IDS] },
          says: `DC section 200, across ${SECTION_IDS.length} generated sections.`,
        };
      case 'period':
        return {
          ...term,
          resolved: periodIssues.length === 0,
          value: periodIssues.length === 0 ? period : null,
          says:
            periodIssues.length === 0
              ? 'Stated.'
              : `Not settable — ${sched.binding || 'the'} gate is shut, with ${sched.typeTwo.holding.length} criteria holding it.`,
        };
      case 'subservice-method':
      default:
        return {
          ...term,
          resolved: processors.length > 0 && processors.every((s) => text(s.method)),
          value: processors.map((s) => ({ id: s.id, method: s.method || null })),
          says:
            processors.length === 0 && censusState === 'partial'
              ? 'No method can be named — the subservice census is partial, so the empty list means unsurveyed rather than none.'
              : processors.length === 0
                ? 'None — every subservice organisation is enumerated and there are none.'
                : `${processors.length} subservice organisation${processors.length === 1 ? '' : 's'}, each with a method.`,
        };
    }
  });

  return {
    engaged: engaged ? text(engaged.firm) : null,
    terms,
    complete: terms.every((t) => t.resolved) && Boolean(engaged),
    unresolved: terms.filter((t) => !t.resolved).map((t) => t.id),
  };
}

/** Everything the letter cannot yet say, as sentences. Empty means it could be signed. */
export function letterProblems(opts = {}) {
  const l = letter(opts);
  const problems = l.terms.filter((t) => !t.resolved).map((t) => `${t.id}: ${t.says}`);
  if (!l.engaged) problems.push('no firm is engaged — a letter with four resolved terms and no signatory is a template');
  return problems;
}

/**
 * The bridge state between period end and a request date, from those two dates alone.
 *
 * `covered` means the report’s own period already covers the request and there is nothing to
 * bridge. `bridge` is what a bridge letter is for. `stale` is the answer a firm gives after
 * the invoice, and having it as a state here is what stops somebody buying a six-month
 * bridge when what the buyer wanted was a current report.
 */
export function bridge(periodEnd, requestedOn) {
  if (!isDay(periodEnd)) return { state: null, why: `period end "${text(periodEnd)}" is not a date — YYYY-MM-DD` };
  if (!isDay(requestedOn)) return { state: null, why: `request date "${text(requestedOn)}" is not a date — YYYY-MM-DD` };
  const days = Math.round((day(requestedOn) - day(periodEnd)) / 86400000);
  if (days <= 0) {
    return { state: 'covered', days, why: 'The request falls inside the period the report already covers.' };
  }
  const limit = Math.round(BRIDGE_MAX_MONTHS * 30.44);
  if (days <= limit) {
    return {
      state: 'bridge',
      days,
      why: `${days} days past period end. A bridge letter asserts no material change since, and that is what it is for.`,
    };
  }
  return {
    state: 'stale',
    days,
    why:
      `${days} days past period end, beyond the ${BRIDGE_MAX_MONTHS}-month limit. What the buyer wants is a current ` +
      'report; a bridge this long asserts more than the firm will sign.',
  };
}

/**
 * When the compliance platform `bc-4r10.17` chose should be bought — or `null`.
 *
 * Two to three months before the window opens, so there is a populated history when the
 * period starts and not a subscription burning months against nothing. The window has no
 * date, so neither does this, and returning `null` is the answer rather than a failure.
 */
export function platformPurchase(openDate) {
  if (!isDay(openDate)) return null;
  const back = (months) => {
    const d = new Date(day(openDate));
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString().slice(0, 10);
  };
  return { from: back(PLATFORM_LEAD_MONTHS.max), to: back(PLATFORM_LEAD_MONTHS.min) };
}

/**
 * Whether `bc-4r10.13`'s non-goal has been discharged — checked, not asserted.
 *
 * "Do not buy evidence-collection tooling before `bc-4r10.1` and `bc-4r10.5` exist." Both are
 * readable from here: the corpus is present when the elected criteria enumerate, and
 * `bc-4r10.5` landed when CC8.1 carries evidence in the assessment. A comment saying they
 * landed would still say so after somebody deleted one.
 */
export function nonGoal(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  const rows = assess(register, boundary);
  const change = rows.find((r) => r.id === CHANGE_CRITERION) || null;
  const corpus = rows.length > 0;
  const evidenced = Boolean(change && text(change.evidence));
  return {
    gatedOn: [...TOOLING_GATED_ON],
    corpus,
    evidenced,
    discharged: corpus && evidenced,
    why:
      corpus && evidenced
        ? `The corpus enumerates ${rows.length} elected criteria and ${CHANGE_CRITERION} carries evidence, so tooling may be priced. ` +
          'It still may not be bought before the purchase window, which has no dates while the observation window has none.'
        : 'Tooling is still gated — the premise is that the evidence is a by-product of work that is already gated, and it is not yet.',
  };
}

/* ----------------------------------------------------------------- validating */

/** Everything wrong with the shipped engagement, as sentences. Runs at import. */
export function engagementProblems() {
  const problems = [];
  const seen = new Set();

  for (const c of FIRM_CLASSES) {
    if (!text(c.id)) problems.push('a firm class has no id');
    if (seen.has(c.id)) problems.push(`${c.id}: declared twice`);
    seen.add(c.id);
    for (const field of ['label', 'cost', 'credibility', 'risk']) {
      if (text(c[field]).length < 20) problems.push(`${c.id}: ${field} is too short to be an argument`);
    }
    if (typeof c.bundlesTooling !== 'boolean') problems.push(`${c.id}: bundlesTooling must be stated, because it is what merges two decisions`);
  }

  if (SEPARATING.length !== 2) {
    problems.push(`${SEPARATING.length} separating questions — bc-4r10.13 names two, and a question every firm answers alike separates nothing`);
  }
  for (const q of SEPARATING) {
    if (!text(q.id)) problems.push('a separating question has no id');
    if (!text(q.asks).endsWith('?')) problems.push(`${q.id}: asks is not a question`);
    if (text(q.predicts).length < 40) problems.push(`${q.id}: does not say what the answer predicts, which is the only reason to ask it`);
  }

  if (!QUOTE_TERMS.some((t) => t.id === 'type-i' && t.required) || !QUOTE_TERMS.some((t) => t.id === 'type-ii' && t.required)) {
    problems.push('both reports must be required of a quote — bc-j0o3 chose a sequencing, and an unpriced half is a guess');
  }

  const stepIds = new Set(STEPS.map((s) => s.id));
  for (const s of STEPS) {
    if (!ROLES.includes(text(s.owner))) problems.push(`${s.id}: owner "${text(s.owner)}" is not one of ${ROLES.join(', ')}`);
    if (text(s.why).length < 40) problems.push(`${s.id}: why is too short — a step nobody explained is a step nobody sequences`);
    for (const need of s.needs) {
      if (!stepIds.has(need)) problems.push(`${s.id}: needs "${need}", which is not a step`);
      if (need === s.id) problems.push(`${s.id}: needs itself`);
    }
    if (s.gate !== undefined && !GATES.includes(s.gate)) problems.push(`${s.id}: gate "${s.gate}" is not one of ${GATES.join(', ')}`);
  }
  const order = STEPS.map((s) => s.id);
  for (const s of STEPS) {
    for (const need of s.needs) {
      if (order.indexOf(need) >= order.indexOf(s.id)) problems.push(`${s.id}: needs ${need}, which is not earlier in the sequence`);
    }
  }

  for (const q of QUOTES) problems.push(...quoteProblems(q));

  for (const term of LETTER_TERMS) {
    if (text(term.names).length < 20) problems.push(`${term.id}: names is too short to bound an opinion`);
    if (text(term.from).length < 20) problems.push(`${term.id}: does not say where it resolves from, which is how a second copy starts`);
  }
  if (LETTER_TERMS.length !== 4) problems.push(`${LETTER_TERMS.length} letter terms — bc-4r10.13 names four, and a missing one is settled in the auditor's favour`);

  if (!boundaryFor(HELD_BY)) problems.push(`no boundary is recorded for "${HELD_BY}" — the engagement has nothing to be scoped by`);
  if (REPORT_PLAN.typeOne !== true || REPORT_PLAN.typeTwo !== true) {
    problems.push('bc-j0o3 answered both reports; a plan naming one of them is a different answer and needs a different bead');
  }

  return problems;
}

/* -------------------------------------------------------------------- reading */

/** The whole engagement, joined — one computation behind the rendering and `--json` both. */
export function engagement(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  const sel = selection();
  const sched = schedule(register, boundary);
  const ctx = { selection: sel.state, schedule: sched, criteria: counts(register, boundary).total };
  return {
    heldBy: HELD_BY,
    system: text(boundary?.system) || null,
    plan: REPORT_PLAN,
    decidedBy: DECIDED_BY,
    selection: sel,
    schedule: sched,
    readiness: readiness(register, boundary),
    letter: letter({ register, boundary }),
    tooling: { ...nonGoal(register, boundary), purchase: platformPurchase(sched.typeTwoOpensOn) },
    steps: STEPS.map((s) => ({ ...s, state: stepState(s, ctx) })),
  };
}

/** The steps in one state — `ready` is the whole of "what happens next". */
export const stepsIn = (state, register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) =>
  engagement(register, boundary).steps.filter((s) => s.state === text(state));

/**
 * One line, for a log or a check.
 *
 * The holding count is in it deliberately. A summary reading "no firm engaged" and stopping
 * sends somebody to call three firms, when the thing between here and a report is
 * thirty-eight criteria and no amount of firm selection moves one of them.
 */
export function summarise(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  const e = engagement(register, boundary);
  const holding = e.schedule.typeTwo.holding.length;
  const dates = e.schedule.settable
    ? 'a date is settable, both gates open'
    : `no date settable, ${holding} criteri${holding === 1 ? 'on' : 'a'} holding the ${e.schedule.binding} gate`;
  return (
    `${text(boundary?.serviceOrganisation) || HELD_BY} · ${e.system || 'no system recorded'} · ` +
    `${e.selection.state}, ${e.selection.received} quote${e.selection.received === 1 ? '' : 's'} · ` +
    `Type I + Type II ${e.plan.sameDay ? 'same day' : 'sequenced'} · ` +
    dates
  );
}

/** The engagement as a person reads it — the same computation as the payload. */
export function render(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  const e = engagement(register, boundary);
  const out = [summarise(register, boundary), ''];
  out.push('STEPS');
  for (const s of e.steps) out.push(`  ${s.state.padEnd(7)} ${s.id.padEnd(20)} ${s.label}`);
  out.push('', 'DATES');
  const dated = (label, date, gate) =>
    `  ${label.padEnd(21)}${date || 'not settable'} — ${gate.gate} gate, ${gate.holding.length} holding`;
  out.push(dated('Type I as-of', e.schedule.typeOneAsOf, e.schedule.typeOne));
  out.push(dated('Type II window opens', e.schedule.typeTwoOpensOn, e.schedule.typeTwo));
  out.push(`  ${e.schedule.why}`);
  out.push('', 'ENGAGEMENT LETTER');
  for (const t of e.letter.terms) out.push(`  ${t.resolved ? 'resolved  ' : 'unresolved'} ${t.id.padEnd(22)} ${t.says}`);
  return out.join('\n');
}

const shipped = engagementProblems();
if (shipped.length) {
  throw new Error(`lib/engagement.js: the shipped engagement is broken —\n  ${shipped.join('\n  ')}`);
}
