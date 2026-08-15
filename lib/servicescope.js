/**
 * The control daemon inside the boundary of the audits it serves.
 *
 * The recursion bc-3muu.7 exists to make cheap: this service will hold the continuity
 * evidence for Climative's SOC 2 and ISO/IEC 27001 reports, and **a system that holds the
 * evidence for an audit is inside that audit**. Its own access, availability, change
 * management and logging get tested, by the same auditor, in the same engagement — and
 * the cheapest moment to know which controls those are is now, while the service is still
 * three open beads and a payload contract, rather than in a fieldwork week where the
 * answer arrives as a finding.
 *
 * ## Two boundaries, and conflating them is the mistake this file refuses
 *
 * The bead's title says *inside the boundary*, lib/boundary.js records beadcause as
 * *carved out*, and both are true because they are answers to different questions.
 *
 * - **The boundary of the system described.** Energy Navigator / Insights is the system;
 *   what a user entity reaches, submits to and receives from. The control daemon is
 *   development-side machinery no user entity has ever heard of, so it is **carved out of
 *   the description**, exactly as lib/boundary.js already carves out beadcause and the Mac
 *   it runs on. Writing it `inside` would put a witness for chain heads into a report
 *   about home-energy assessments, under a heading it does not belong to.
 * - **The boundary of the audit.** Everything the auditor tests. The control daemon is
 *   squarely inside it, and more deeply than the rest of the tooling: the records it holds
 *   are the *population an auditor samples*. A carve-out is a statement about the
 *   description and carries no implication whatsoever about what gets tested — that
 *   sentence is lib/boundary.js's and this file is its sharpest case.
 *
 * So `COMPONENTS` records the carve-out with a `bearsOn` naming the evidence path, and
 * {@link CONTROLS} is the other half: the service's own controls, enumerated, in the
 * corpus everything else in this programme is written against.
 *
 * ## The subservice question, and why the answer is still a record
 *
 * bc-3muu.9 settled it: every organisation installs and runs its own control daemon, and
 * `VENDOR_OPERATES` in lib/operator.js is empty. So nobody holds anybody else's evidence,
 * nothing here is a subservice organisation, and the carve-out-or-inclusive decision an
 * auditor asks about **does not arise**.
 *
 * That is an answer, not an absence, and the difference is the whole of
 * {@link methodFor}. A system description with nothing written under subservice
 * organisations is indistinguishable from one where nobody looked; `not-a-subservice` is
 * the decision written down, with the arrangement it was derived from beside it. And it
 * is derived rather than declared — hand {@link methodFor} an arrangement in which
 * somebody else operates the control deployment and it says a method is now **required**,
 * names the party, and {@link methodProblems} refuses the record that still claims
 * otherwise. The day somebody stands up a hosted control daemon for a customer, the
 * consequence arrives from a function rather than from an auditor.
 *
 * ## The service must not be its own evidence
 *
 * The trap in a system that monitors other systems is to answer its own control questions
 * with its own product. bc-3muu.5 makes a silent or modified *instance* a finding — that
 * is the service watching its tenants, and it is not monitoring of the service. Nothing
 * in the enumeration below cites a control daemon capability as the control over the
 * control daemon, and a later edit that does is the reviewable mistake this paragraph
 * exists to name.
 *
 * ## What a state here does and does not claim
 *
 * `enforced` means code in *this release* refuses the thing the control is about, and
 * names the module — which test/servicescope.mjs opens, because a module named here and
 * deleted there is a control that reads as built. `partial` means some of it is built and
 * a bead carries the rest. `owed` means nothing is built and a bead says who will.
 *
 * **None of the three is an operating-effectiveness claim.** A Type II report says a
 * control operated over a period, and only a running service across a real period
 * produces that. This is design: what the control is, why it applies here, and where it
 * stands today. Reading `enforced` as tested is the misstatement lib/operator.js refuses
 * one layer up, and this file inherits the rule rather than restating it as a flag.
 *
 * A leaf, and near enough to lib/operator.js's shape to be read beside it: one import,
 * no state read and none written, so a check, an installer, a report generator and the
 * system-description build (bc-4r10.3) can each hold it. It deliberately does **not**
 * import lib/controls.js — the corpus is a sibling landing on its own bead, ids here are
 * held to their shape and resolved against the corpus by test/servicescope.mjs the moment
 * that module exists, which is the same one-way seam lib/boundary.js has into
 * lib/election.js.
 */

import { subservices, arrangementProblems } from './operator.js';

/**
 * What the service is, in the words a description uses, and — the load-bearing half —
 * what it never holds.
 *
 * The second sentence is the whole confidentiality argument of the epic: criteria over a
 * pile of hashes are cheap, criteria over a pile of everybody's source code are the
 * hardest part of the programme. lib/publishable.js is what makes it a property of a
 * closed field table rather than a promise, and it is why {@link CONTROLS} can mark
 * `SOC2.C1.1` enforced today with nothing running.
 */
export const SERVICE = Object.freeze({
  id: 'control-daemon',
  label: 'the control daemon — the continuous corroborating witness for an organisation',
  holds: 'chain heads, digests, enrolment records and posture metadata, per instance and per organisation',
  neverHolds: 'bead text, prompts, file contents, screenshots, or anything else a digest was taken of',
});

/**
 * The shortest a `why` or a `how` may be. Longer than lib/boundary.js's twenty, because
 * every sentence here has to survive being read out to somebody testing the control.
 */
const PROSE_MIN = 40;

/**
 * A control id, held to its shape only — one shape per framework, because there is one.
 *
 * The corpus is the authority on whether an id *resolves* and this file will not keep a
 * second, weaker copy of the vocabulary — the mistake lib/operator.js's header warns about
 * with organisation ids. What a shape check buys is that a typo in the table cannot sit
 * here looking like a control until the corpus lands; what it cannot buy is truth, which
 * is why test/servicescope.mjs resolves every id against lib/controls.js the moment that
 * module exists. Three shapes rather than one, for the corpus's own reason: `ISO27001.A.5.2`
 * and `ISO42001.A.5.2` are different controls, and a single permissive pattern over all
 * three would accept a 42001 id spelled the 27001 way.
 */
const CONTROL_ID_SHAPE = {
  SOC2: /^SOC2\.(CC|PI|[ACP])\d+\.\d+$/,
  ISO27001: /^ISO27001\.A\.\d+\.\d+$/,
  ISO42001: /^ISO42001\.A\.\d+(\.\d+)+$/,
};

/** A bead id, including the dotted children this epic is made of. */
const BEAD_RE = /^bc-[a-z0-9]{4}(\.[0-9]+)*$/;

/* ------------------------------------------------- the components it contributes */

/**
 * What the control daemon adds to an organisation's boundary record, in lib/boundary.js's
 * component shape.
 *
 * Two, and the split is the confidentiality argument made structural rather than
 * rhetorical. The daemon is a `host` — something that runs, listens and can be reached.
 * What it holds is a `datastore`, and a datastore is the kind of component an auditor
 * asks the hardest questions of: what is in it, whose it is, how long it is kept. Folding
 * them into one row answers those questions about a process instead of about a pile of
 * data, which is precisely where "we only hold hashes" would stop being checkable.
 *
 * Both are `carved-out`, both name what they `bearsOn`, and the header says why.
 */
export const COMPONENTS = Object.freeze([
  Object.freeze({
    id: 'control-daemon',
    kind: 'host',
    label: 'the control daemon — the corroborating witness each organisation runs for itself',
    disposition: 'carved-out',
    why:
      'Development-side machinery. No user entity reaches it, submits to it or receives anything from ' +
      'it, and none of their data is in it — it witnesses the chains beadcause writes about how this ' +
      "organisation's software is changed. Carved out of the description, and not excused from the audit.",
    bearsOn:
      'The evidence itself. It holds the continuity record an auditor samples when testing change ' +
      'management and monitoring, so its own access, availability, change management and logging are ' +
      'tested in the same engagement — which is what the enumeration below is for.',
  }),
  Object.freeze({
    id: 'control-daemon-store',
    kind: 'datastore',
    label: 'what the control daemon holds — chain heads, digests, enrolment and posture records',
    disposition: 'carved-out',
    why:
      'It holds no user entity data and no content of any kind: digests, instance identities, ' +
      'organisation ids and timestamps, under a closed field table that refuses anything else. That ' +
      'refusal is what keeps the confidentiality criteria over this store cheap enough to be true.',
    bearsOn:
      'Confidentiality and retention. It is the population a sample is drawn from, so how long it is ' +
      'kept and how it is disposed of are questions asked of it directly rather than of the estate ' +
      'around it.',
  }),
]);

/* ----------------------------------------------------- the subservice decision */

/** What a subservice organisation's controls may do to a report — lib/boundary.js's word for word. */
export const METHODS = Object.freeze(['carve-out', 'inclusive']);

/**
 * The third answer, and the one that only looks like no answer.
 *
 * A method describes what to do about somebody else's controls. When there is nobody
 * else, the honest record is not an empty subservice list — an empty list is what an
 * unsurveyed estate also looks like — it is this word, next to the arrangement it was
 * read off.
 */
export const NOT_A_SUBSERVICE = 'not-a-subservice';

/** Everything a system description may record here. */
export const DECISIONS = Object.freeze([...METHODS, NOT_A_SUBSERVICE]);

/**
 * What a carve-out would shift onto the user entity, if a hosted control daemon ever
 * existed.
 *
 * Written now, while nobody is under time pressure to write it. lib/boundary.js's rule is
 * that a carve-out owes at least one complementary user entity control, and a CUEC
 * invented during fieldwork is a CUEC that describes what the customer happened to be
 * doing rather than what they must do.
 */
export const CARVE_OUT_CUECS = Object.freeze([
  'The user entity enrols only instances it recognises, and withdraws an instance it no longer operates.',
  'The user entity retains its own local chain, so a head held by the operator can be reconciled against a copy the operator never had.',
  'The user entity reviews the intervals reported as unverified rather than treating a report that renders as a report that passed.',
]);

/**
 * What this arrangement makes of the subservice question.
 *
 * Returns `null` for an arrangement that is not sound — the same distinction
 * `assuranceOf` draws, and for the same reason: a caller handed `not-a-subservice` for a
 * record nobody could read would write it into a system description.
 *
 * Otherwise `{ decision, required, operators, why, cuecs }`. `required` is the field that
 * changes: false in the model beadcause ships, where `decision` is already
 * `not-a-subservice`; true the moment anybody other than the organisation operates a
 * deployment that holds its evidence, where `decision` is `null` because a method is a
 * commitment somebody makes and not a default anything can pick.
 */
export function methodFor(deployments) {
  if (arrangementProblems(deployments).length) return null;

  const held = subservices(deployments);
  if (!held.length) {
    return Object.freeze({
      decision: NOT_A_SUBSERVICE,
      required: false,
      operators: Object.freeze([]),
      why:
        'The organisation operates every deployment that holds its evidence, so no party performs part ' +
        'of its service commitments on its behalf and there is no subservice organisation to carve out ' +
        'or include. Recorded rather than left blank, because a blank is what an unsurveyed estate ' +
        'looks like too.',
      cuecs: Object.freeze([]),
    });
  }

  const operators = [...new Set(held.map((s) => s.operator))].sort();
  return Object.freeze({
    decision: null,
    required: true,
    operators: Object.freeze(operators),
    why:
      `${held.map((s) => `the ${s.role} deployment is operated by the ${s.operator}`).join(', and ')} — ` +
      'a party holding the organisation\'s evidence on its behalf is a subservice organisation, and the ' +
      'system description owes a carve-out or inclusive-method decision for it. A carve-out leaves its ' +
      'controls out and shifts the reliance onto the user entity; the inclusive method drags its controls ' +
      'into the test population, which is a far larger promise.',
    cuecs: CARVE_OUT_CUECS,
  });
}

/**
 * Everything wrong with recording `decision` over this arrangement, as sentences.
 *
 * Two refusals and they fail in opposite directions, which is why neither is enough on
 * its own. Claiming `not-a-subservice` while somebody else holds the evidence is the
 * understatement that removes a party from the description; recording a method while
 * nobody else holds anything is the overstatement that puts a party into it that does not
 * exist, and an auditor asking to see the agreement with them finds nothing.
 */
export function methodProblems(deployments, decision) {
  if (!DECISIONS.includes(decision)) {
    return [`"${decision}" is not something a system description can record here — one of ${DECISIONS.join(', ')}`];
  }

  const found = methodFor(deployments);
  if (!found) {
    return [
      'the arrangement cannot carry a subservice decision until it is sound: ' +
        arrangementProblems(deployments).join('; '),
    ];
  }

  const problems = [];
  if (found.required && decision === NOT_A_SUBSERVICE) {
    problems.push(
      `${found.operators.join(' and ')} operates a deployment holding this organisation's evidence, so ` +
        'this is a subservice organisation and the description owes a carve-out or inclusive decision — ' +
        'recording no-subservice here removes a party from the description rather than deciding about it'
    );
  }
  if (!found.required && METHODS.includes(decision)) {
    problems.push(
      `nobody outside the organisation operates any deployment here, so recording "${decision}" describes ` +
        'a subservice organisation that does not exist — and an auditor asking to see the agreement with ' +
        'them, or the complementary controls it owes, finds nothing'
    );
  }
  return problems;
}

/* ----------------------------------------------------------- its own controls */

/** Where a control stands in this release. Never a claim that it operated — see the header. */
export const STATES = Object.freeze(['enforced', 'partial', 'owed']);

/**
 * The control daemon's own controls, against the corpus everything else uses.
 *
 * Ordered by framework and then by the corpus's own order, so this reads next to a
 * control matrix rather than next to the epic. Every entry answers two questions an
 * auditor asks in this order: *why does this control apply to this component* — never the
 * generic reason, always the one that is true of a witness holding digests — and *where
 * does it stand*.
 *
 * The ISO entries are the ones with nothing to say in SOC 2 terms. Where a 27001 or 42001
 * control is simply the counterpart of a criterion already listed, it is not repeated
 * here: the corpus's crosswalk is what joins them, and a second list maintained by hand is
 * the two-copies problem lib/controls.js was built to avoid.
 */
export const CONTROLS = Object.freeze([
  {
    id: 'SOC2.CC6.1',
    why:
      'The service accepts publications from daemons it has never met. Until an instance can prove which ' +
      'install it is, the only thing between the witness and anybody at all is that nobody has looked.',
    state: 'owed',
    bead: 'bc-3muu.2',
    how: 'Instance identity and enrolment is the whole of bc-3muu.2, and nothing in this release authenticates anything.',
  },
  {
    id: 'SOC2.CC6.2',
    why:
      'Enrolment is registration, and the deprovisioning half is the one that rots: a decommissioned Mac ' +
      'whose instance is still enrolled goes on being counted as an install that owes publications.',
    state: 'owed',
    bead: 'bc-3muu.2',
    how: 'The withdrawal path is bc-3muu.2, alongside enrolment — lib/organisation.js already carries a withdrawn status for the organisation half of the same question.',
  },
  {
    id: 'SOC2.CC6.3',
    why:
      'One witness holds several organisations. Least privilege here is tenancy: a request in one ' +
      "organisation's name must not reach another's heads, and the failure is silent in both directions.",
    state: 'partial',
    by: 'lib/organisation.js',
    bead: 'bc-3muu.11',
    how:
      'lib/organisation.js mints the tenancy key, refuses a derived one and partitions foreign records; ' +
      'putting `org` in the published envelope so there is something to enforce over is bc-3muu.11.',
  },
  {
    id: 'SOC2.CC6.6',
    why:
      'This is the first part of beadcause reachable from outside a tailnet. Every other component ' +
      'answers only on a private network, and that assumption is written through the product.',
    state: 'owed',
    bead: 'bc-3muu.3',
    how: 'The protocol and everything that terminates it is bc-3muu.3; there is no listener in this release.',
  },
  {
    id: 'SOC2.CC6.7',
    why:
      'What may cross the boundary is the epic\'s central promise — hashes and metadata, never content — ' +
      'and a promise about transmission is worth what the thing enforcing it is worth.',
    state: 'partial',
    by: 'lib/publishable.js',
    bead: 'bc-3muu.3',
    how:
      'lib/publishable.js refuses any field its closed table does not mint, so a record carrying content ' +
      'cannot be built; the transport that carries the records is bc-3muu.3.',
  },
  {
    id: 'SOC2.CC7.1',
    why:
      'A control daemon on the customer\'s own hardware can be misconfigured into producing evidence that ' +
      'looks exactly like good evidence — append-only enforced nowhere, anchoring never set up.',
    state: 'owed',
    bead: 'bc-3muu.12',
    how: 'The deployment observes and publishes its own posture in bc-3muu.12, and bc-3muu.13 is the configuration it must prove rather than be trusted to have.',
  },
  {
    id: 'SOC2.CC7.2',
    why:
      'Monitoring *of* the witness, which is a different thing from the witness monitoring its tenants. ' +
      'A service whose own anomalies are only visible in its own output has no monitoring at all.',
    state: 'owed',
    bead: 'bc-3muu.16',
    how:
      'Nothing watches the service in this release, and bc-3muu.16 is what will. The enumeration ' +
      'deliberately does not answer this with bc-3muu.5, which is the product rather than the control.',
  },
  {
    id: 'SOC2.CC7.3',
    why:
      'A discrepancy between a local chain and the head the witness holds is either tampering or a bug, ' +
      'and deciding which is a security event with a clock on it.',
    state: 'owed',
    bead: 'bc-3muu.5',
    how: 'Making a silent or modified instance a finding is bc-3muu.5; the severity, clock and post-incident review it then owes are bc-4r10.9.',
  },
  {
    id: 'SOC2.CC7.4',
    why:
      'The incident with no precedent elsewhere in beadcause: the evidence store itself is compromised, ' +
      'and the response cannot be to consult the evidence store.',
    state: 'owed',
    bead: 'bc-4r10.9',
    how: 'Incident response for the whole programme is bc-4r10.9; the anchor receipts that would survive a compromised witness are bc-3muu.10.',
  },
  {
    id: 'SOC2.CC8.1',
    why:
      'A witness that changed under a report is a witness nobody can rely on for the period. Which build ' +
      'was running, and when it changed, is a question asked of this service before any other.',
    state: 'owed',
    bead: 'bc-3muu.12',
    how: 'The build identity a deployment publishes about itself is part of bc-3muu.12; beadcause\'s own change-management evidence is already registered in lib/evidence.js and does not cover a deployment somebody else runs.',
  },
  {
    id: 'SOC2.CC9.2',
    why:
      'The question this epic answered before it could be asked: who else is in the arrangement, and what ' +
      'does each of them hold. An anchor is a supplier; a hosted witness would be a subservice organisation.',
    state: 'partial',
    by: 'lib/operator.js',
    bead: 'bc-eqn1.9',
    how:
      'lib/operator.js records who administers each deployment, refuses an anchor operated from inside the ' +
      'arrangement, and keeps the vendor operating nothing; the supplier register every egress is named in is bc-eqn1.9.',
  },
  {
    id: 'SOC2.A1.1',
    why:
      'Capacity for a witness is not request throughput — it is whether it can accept every publication ' +
      'every enrolled instance owes, because a publication it could not accept is an interval nobody can claim.',
    state: 'owed',
    bead: 'bc-3muu.4',
    how:
      'bc-3muu.4 is what makes this survivable rather than critical: local work never blocks on the service. ' +
      'What it does not do is let a period be claimed, so capacity stays a real control here.',
  },
  {
    id: 'SOC2.A1.2',
    why:
      'The witness is recoverable in a way most stores are not — the local chains are the source and it ' +
      'holds copies — except for the one thing that cannot be rebuilt: that a head existed by a given time.',
    state: 'owed',
    bead: 'bc-3muu.10',
    how: 'Backup of the store is unbuilt; the receipts that make the timing half recoverable at all are bc-3muu.10.',
  },
  {
    id: 'SOC2.C1.1',
    why:
      'The mitigation the whole epic turns on. What is confidential here is identified by being refused: ' +
      'a store of digests and instance ids can be described exactly, and a store of everybody\'s source cannot.',
    state: 'enforced',
    by: 'lib/publishable.js',
    how:
      'lib/publishable.js mints four record kinds from closed field tables, refuses any key a table does not ' +
      'name, and its own test feeds content fields in and asserts the refusal.',
  },
  {
    id: 'SOC2.C1.2',
    why:
      'Retention of the witness store is a compliance decision, not an operational one: too short and the ' +
      'period a report covers has no population behind it, unbounded and nobody can say what is in it.',
    state: 'owed',
    bead: 'bc-3muu.18',
    how:
      'lib/evidence.js already requires a retention and a disposal rule of every evidence class beadcause ' +
      'holds; the witness store is outside that register because it is not on this machine, and bc-3muu.18 owes it the same two answers.',
  },
  {
    id: 'ISO27001.A.5.23',
    why:
      'The control that bc-3muu.9 answered rather than left open: the organisation runs its own witness, so ' +
      'this is not a cloud service arrangement at all — and that is a decision somebody has to be able to read.',
    state: 'partial',
    by: 'lib/operator.js',
    bead: 'bc-3muu.13',
    how:
      'lib/operator.js is the arrangement as data, with the vendor operating nothing; proving a self-hosted ' +
      'deployment is configured the way the arrangement says is bc-3muu.13.',
  },
  {
    id: 'ISO27001.A.5.28',
    why:
      'Collection of evidence is what this service is. The control that governs how evidence is collected, ' +
      'preserved and shown to be unaltered applies to the collector before it applies to anything it collects.',
    state: 'partial',
    by: 'lib/publishable.js',
    bead: 'bc-3muu.10',
    how:
      'Every record carries a digest and a link to the one before it, so a run of them is checkable; what ' +
      'makes the run evidence against the party holding it, rather than a self-consistent story, is bc-3muu.10.',
  },
  {
    id: 'ISO27001.A.5.33',
    why:
      'The store is records in the strict sense — kept to demonstrate conformity to somebody who was not ' +
      'there. Protection of records is therefore the control over the store, not a control the store helps with.',
    state: 'owed',
    bead: 'bc-3muu.3',
    how: 'Append-only storage, and enforcing it somewhere other than the application that writes it, is bc-3muu.3 with bc-3muu.12 observing whether it is really enforced.',
  },
  {
    id: 'ISO27001.A.8.15',
    why:
      'The service\'s own log, which is not the chain it holds. Who published what and when is the record ' +
      'it is for; who reached it, from where, and what was refused is a separate record that does not exist.',
    state: 'owed',
    bead: 'bc-3muu.16',
    how: 'No listener, so no access log; bc-3muu.16 owns it. Beadcause\'s own agent log is registered in lib/evidence.js and is about a different system.',
  },
  {
    id: 'ISO27001.A.8.17',
    why:
      'Every claim this service supports is a claim about time, and it is the one control where being ' +
      'wrong is invisible: a witness with a drifting clock produces intervals that read perfectly.',
    state: 'partial',
    by: 'lib/publishable.js',
    bead: 'bc-3muu.10',
    how:
      'Records carry a UTC instant in one spelling every module here checks; an external clock nobody in ' +
      'the arrangement administers arrives with the anchor receipts in bc-3muu.10.',
  },
  {
    id: 'ISO27001.A.8.34',
    why:
      'The recursion in a single control: the auditor tests the system that holds the evidence for the ' +
      'test. Fieldwork against a live witness can disturb the very population it is sampling.',
    state: 'owed',
    bead: 'bc-3muu.17',
    how:
      'A verifiable export, and audit access that is not operator access, are bc-3muu.17; bc-3muu.12 already ' +
      'reports from published records alone, which is most of the first half of it.',
  },
  {
    id: 'ISO42001.A.6.2.8',
    why:
      'For an install that publishes, this service is the durable half of the AI system event log — what ' +
      'the agents were, what changed about them, and that the sequence has not been rewritten since.',
    state: 'partial',
    by: 'lib/publishable.js',
    bead: 'bc-3muu.3',
    how:
      'The transition record kind carries what changed about a foundation or an election; publishing it ' +
      'continuously, so absence is visible rather than assumed, is bc-3muu.3.',
  },
  {
    id: 'ISO42001.A.10.2',
    why:
      'Responsibility between the organisation and everybody else in the arrangement is exactly what ' +
      'bc-3muu.9 allocated, and an allocation nothing can read is one every party remembers differently.',
    state: 'enforced',
    by: 'lib/operator.js',
    how:
      'Each deployment records who administers it as a relation rather than a name, the vendor operates ' +
      'nothing, and an anchor run from inside the arrangement is refused by name.',
  },
].map((c) => Object.freeze(c)));

/* -------------------------------------------------------------------- validating */

const text = (v) => String(v ?? '').trim();

/**
 * Everything wrong with one enumerated control, as sentences.
 *
 * The state is what decides which fields are owed, and both directions are refused. An
 * `owed` entry with a module named against it is a claim that something already does this;
 * an `enforced` entry with a bead is a control still being built wearing the word for one
 * that is not. The mistakes are symmetrical and only the second one flatters.
 */
function entryProblems(c, where) {
  const problems = [];
  const id = text(c?.id);
  const shape = CONTROL_ID_SHAPE[id.split('.')[0]];
  if (!shape || !shape.test(id)) {
    problems.push(`${where}: "${id}" is not the shape of a corpus control id, such as SOC2.CC6.1 or ISO27001.A.8.15`);
  }
  if (!STATES.includes(c?.state)) {
    problems.push(`${where}: state "${text(c?.state)}" is not one of ${STATES.join(', ')}`);
  }
  for (const field of ['why', 'how']) {
    if (text(c?.[field]).length < PROSE_MIN) {
      problems.push(
        `${where}: needs a \`${field}\` of at least ${PROSE_MIN} characters — ` +
          (field === 'why'
            ? 'the reason this control applies to a witness holding digests, not the reason it exists'
            : 'where it stands, in a sentence somebody testing it can act on')
      );
    }
  }

  const by = text(c?.by);
  const bead = text(c?.bead);
  if (c?.state === 'enforced' || c?.state === 'partial') {
    if (!by) problems.push(`${where}: ${c.state} needs \`by\` — the module in this release that does it, or the word is a claim with nothing behind it`);
  } else if (by) {
    problems.push(`${where}: owed names ${by}, which says something already does this — say partial, or drop the module`);
  }
  if (c?.state === 'partial' || c?.state === 'owed') {
    if (!bead) problems.push(`${where}: ${c.state} needs \`bead\` — who closes the rest of it, or it is a gap nobody owns`);
    else if (!BEAD_RE.test(bead)) problems.push(`${where}: "${bead}" is not the shape of a bead id`);
  } else if (bead) {
    problems.push(`${where}: enforced names ${bead}, so it is not enforced yet — say partial`);
  }

  const known = new Set(['id', 'why', 'state', 'how', 'by', 'bead']);
  for (const name of Object.keys(c || {})) {
    if (!known.has(name)) problems.push(`${where}: "${name}" is not part of an enumerated control`);
  }
  return problems;
}

/**
 * Everything wrong with the enumeration as a whole, as sentences.
 *
 * Run at import, below, and thrown — the discipline lib/controls.js and lib/boundary.js
 * both use. An enumeration that could ship broken is one that answers "nothing is owed"
 * on the machine reporting what is owed.
 */
export function enumerationProblems(controls = CONTROLS) {
  if (!Array.isArray(controls)) return ['the enumeration is a list of controls'];

  const problems = [];
  const seen = new Set();
  for (const [i, c] of controls.entries()) {
    const where = `control ${i}${c?.id ? ` (${c.id})` : ''}`;
    problems.push(...entryProblems(c, where));
    const id = text(c?.id);
    if (id && seen.has(id)) {
      problems.push(`${where}: ${id} is enumerated twice — two rows for one control is two answers to one question`);
    }
    seen.add(id);
  }
  return problems;
}

/* --------------------------------------------------------------------- reading */

/** Every control enumerated against the service, or only those in one state. */
export function controls(state = null) {
  if (state === null) return CONTROLS;
  return CONTROLS.filter((c) => c.state === state);
}

/**
 * What is not finished, worst first, with who closes it.
 *
 * `owed` before `partial`, because a control with nothing behind it is a different
 * conversation from one that is half built, and a report that sorts them by framework
 * buries the first kind among the second.
 */
export function owed() {
  return [...controls('owed'), ...controls('partial')].map((c) => ({
    id: c.id,
    state: c.state,
    bead: c.bead,
    how: c.how,
  }));
}

/** The framework token an id belongs to — read off the id, which is where it lives. */
export const frameworkOf = (id) => text(id).split('.')[0] || null;

/** Every enumerated control in one framework, in enumeration order. */
export const inFramework = (token) => CONTROLS.filter((c) => frameworkOf(c.id) === text(token));

/**
 * How far along the enumeration is, by state and by framework.
 *
 * A count rather than a percentage, deliberately. A percentage over a list this file
 * chose the length of reads as progress against the standard, which it is not: the gap
 * assessment across every elected criterion is bc-4r10.4's, and this is one component's
 * controls inside it.
 */
export function coverage() {
  const byState = Object.fromEntries(STATES.map((s) => [s, controls(s).length]));
  const byFramework = {};
  for (const c of CONTROLS) {
    const token = frameworkOf(c.id);
    byFramework[token] = (byFramework[token] || 0) + 1;
  }
  return { total: CONTROLS.length, byState, byFramework };
}

/**
 * The whole system-description entry for this service, for one organisation's
 * arrangement.
 *
 * The single seam the description build (bc-4r10.3) needs: the components to spread into
 * the boundary record, the subservice decision with the arrangement it was derived from,
 * and the controls that are tested whatever the description says. `null` for an
 * arrangement that is not sound, so a description cannot be generated from one nobody
 * could read.
 */
export function entry(deployments) {
  const method = methodFor(deployments);
  if (!method) return null;
  return {
    service: SERVICE,
    components: COMPONENTS,
    method,
    controls: CONTROLS,
    owed: owed(),
    coverage: coverage(),
  };
}

/**
 * The paragraph a system description carries about this service.
 *
 * Generated rather than typed, for lib/boundary.js's reason: a scope statement somebody
 * maintains by hand and a record a gate cites drift apart, and the drift is discovered by
 * the person least able to fix it.
 */
export function statement(deployments) {
  const method = methodFor(deployments);
  if (!method) return null;

  const subservice =
    method.decision === NOT_A_SUBSERVICE
      ? 'It is not a subservice organisation: the organisation operates it itself, and no party performs any part of the service commitments on its behalf.'
      : `A carve-out or inclusive-method decision is owed for it: ${method.operators.join(' and ')} operates a deployment holding this organisation's evidence.`;

  const count = coverage();
  const label = SERVICE.label.charAt(0).toUpperCase() + SERVICE.label.slice(1);
  return (
    `${label}, carved out of the system description and inside the boundary of the audit. It holds ` +
    `${SERVICE.holds}, and never ${SERVICE.neverHolds}. ${subservice} ${count.total} of its own controls are ` +
    `enumerated against the corpus, of which ${count.byState.owed + count.byState.partial} are not yet complete.`
  );
}

const BROKEN = enumerationProblems();
if (BROKEN.length) throw new Error(`service scope: ${BROKEN.join('; ')}`);
