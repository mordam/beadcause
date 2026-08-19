/**
 * The gap assessment — every elected criterion, with a state nobody asserted and an owner.
 *
 * A readiness assessment sold by a firm is this exercise with an invoice attached. What it
 * produces is one line per criterion saying whether a control exists, whether that control
 * produces something an auditor could sample, and who closes the difference. Doing it in
 * the tracker first makes the engagement cheap, or unnecessary.
 *
 * ## The state is computed, and that is the whole design
 *
 * bc-4r10.4 names three states, and each is a sentence about two things rather than one:
 * **met** is a control that exists *and* produces evidence, **partial** is one of the two,
 * **absent** is neither. So a record here does not carry a state. It carries the two
 * halves — {@link ASSESSMENT}'s `control` and `evidence`, each a sentence or `null` — and
 * {@link stateOf} derives the word from them.
 *
 * That is not tidiness. A hand-written state is the field that goes green first and stays
 * green: somebody writes `met` in a planning meeting, the control is descoped a month
 * later, and the row still says met because nothing about deleting a control touches it.
 * Deriving it means **`met` cannot be written without naming both halves**, and removing
 * either one moves the state on its own. `lib/policies.js` makes the same argument about a
 * review date and `lib/documents.js` made it first.
 *
 * ## Absent has two meanings and conflating them is the expensive mistake
 *
 * "We looked and there is no control" and "nobody has enumerated the population this would
 * be tested against" are both absences, and only the first is a finding. The second is an
 * instruction to go and survey something, and a gap assessment that renders them the same
 * hands a remediation plan to the wrong people.
 *
 * So every record names the census kinds its criterion is tested against — `population` —
 * and {@link confidenceOf} reads those against `lib/boundary.js`'s census: any kind the
 * boundary records as `partial` makes the row **provisional**, and a row tested against
 * documents and management rather than an enumerated estate is **assessed**. Derived, so
 * closing a census in `lib/boundary.js` upgrades rows here without an edit, and letting one
 * go partial downgrades them the same way.
 *
 * ## No criterion silently absent
 *
 * The failure this bead is named for: a criterion with no control is a row that says so and
 * somebody sees it; a criterion missing from the list is invisible, and a report is written
 * without it. A hand-kept list cannot refuse that, so the list is not hand-kept — the
 * corpus enumerates, and {@link assessmentProblems} requires exactly one record per elected
 * criterion, no record for an unelected one, and no duplicates. It runs at import, so a
 * criterion added to `lib/controls.js` and not assessed here is a failing import in every
 * suite rather than a blank in a report.
 *
 * Election has the same hole one level up: a category that is simply not mentioned is
 * indistinguishable from one nobody considered. {@link NOT_ELECTED} records the two that
 * were declined, with the decision that declined them, so the absence of eighteen privacy
 * criteria is an answer rather than an omission.
 *
 * ## What it does not carry, and where those come from instead
 *
 * **The control ids that claim to satisfy a criterion are not written here.** bc-4r10.1
 * settled that an edge has exactly one home: crosswalks are declared on controls pointing
 * at criteria and `satisfiedBy()` is the computed inverse. {@link claims} asks the corpus.
 * A second hand-written mapping is how a criterion comes to cite a control that stopped
 * covering it. **Which policy is the documented answer** is `lib/policies.js`'s, and
 * {@link documentedBy} asks it. Both are joins performed at the moment of asking.
 *
 * That makes this a joining module rather than a fourth register — it imports the three
 * leaves the way `lib/systemdescription.js` does, and for the same reason: the leaves
 * deliberately do not import each other, so anything needing two of them is a file of its
 * own. Nothing here writes; there is no config directory, no git and no network, and the
 * register ships compiled into the release.
 *
 * ## The subject is Climative's platform, and that changes the answer
 *
 * bc-228x settled it: the system is Energy Navigator / Insights, Climative is the service
 * organisation, and beadcause is carved out of the description while remaining a
 * development-side change-management control over the in-scope system. The prediction in
 * bc-4r10.4's own description — that CC8 and parts of CC6 are already strong because
 * beadcause enforces them — was written before that answer and only held under the other
 * one. Beadcause's endorsement gate and merge queue do not govern how a release reaches
 * Energy Navigator's production; they govern how source changes are authored, which is one
 * input to CC8.1 and none of CC6.
 *
 * ## Zero met is the finding, not a gap in the assessment
 *
 * Nothing below is met, and that is what a readiness call would charge to say. Eighteen rows
 * are assessed-absent — organisational controls where nothing has been written down, and
 * `lib/policies.js` already enumerates the fifteen documents that would write them.
 * Nineteen are provisional-absent, waiting on a survey of the estate rather than on a
 * control, which is bc-j8pz. One is partial, and it is CC8.1: records an auditor could
 * sample, and no described control over the system they are records of. Writing a
 * comfortable number here instead would produce a register that passes every check and is
 * false in the only way that matters.
 */
import { CENSUS_KINDS, boundaryFor } from './boundary.js';
import { byFramework, control as corpusRecord, isControl, satisfiedBy } from './controls.js';
import { ELECTED, HELD_BY, ROLES, categoryOf, isElected, policiesFor } from './policies.js';

/**
 * Re-exported rather than restated.
 *
 * `ELECTED` and `ROLES` have one home and it is `lib/policies.js`; a second copy here is
 * two answers to "which categories are in scope" and they would disagree within a quarter.
 * `HELD_BY` names the organisation whose boundary and policy set this is assessed against.
 */
export { ELECTED, HELD_BY, ROLES };

/** What settled the two questions the shape of this register rests on. */
export const DECIDED_BY = Object.freeze({
  subject: 'bc-228x',
  categories: 'bc-yfgo',
});

/** The three states bc-4r10.4 names. Derived by {@link stateOf}, never written down. */
export const STATES = Object.freeze(['met', 'partial', 'absent']);

/** Whether the row rests on a population somebody has enumerated. See {@link confidenceOf}. */
export const CONFIDENCE = Object.freeze(['assessed', 'provisional']);

/** The shortest a `why` may be. It is the only part of a row a person actually reads. */
const WHY_MIN = 40;

/**
 * The two Trust Services categories that were considered and declined, and by what.
 *
 * A category nobody mentions and a category somebody declined look identical in a register
 * that only lists what is in scope. These are the twenty-three criteria this assessment
 * deliberately does not cover, so that "why is there nothing about privacy in here" has an
 * answer that is not a shrug.
 */
export const NOT_ELECTED = Object.freeze([
  Object.freeze({
    category: 'PI',
    label: 'Processing Integrity',
    decision: 'bc-yfgo',
    disposition: 'deferred',
    why:
      'Deferred to renewal. Climative ships a modelled output — energy assessments and insights — and a ' +
      'buyer challenging whether the number is right is asking a processing-integrity question whether or ' +
      'not they use the phrase. It was left out of the first report rather than out of the programme.',
  }),
  Object.freeze({
    category: 'P',
    label: 'Privacy',
    decision: 'bc-yfgo',
    disposition: 'declined',
    why:
      'Declined. Eighteen criteria, and the corpus has no framework token that can claim twelve of them — ' +
      'ISO/IEC 27701 is the missing one, filed as bc-iykl. Electing privacy is a decision to add a ' +
      'framework, not a decision to add a category.',
  }),
]);

/* ------------------------------------------------------------------ the register */

/**
 * One record per elected criterion: what exists, what could be sampled, and whose it is.
 *
 * `control` is a control **the service organisation operates over the in-scope system** —
 * described, approved, and somebody's. Not a control over the tooling that builds it: the
 * boundary carves that out, and reading beadcause's own access control as CC6.1 for Energy
 * Navigator is the misstatement `lib/servicescope.js` refuses one layer down.
 *
 * `evidence` is an artefact an auditor could sample **today**. Not one that would exist if
 * the control did; a control with no evidence is exactly the half-state `partial` is for.
 *
 * `bears` is the third thing, and it is the one that stops this register lying in the other
 * direction: something that touches the criterion without satisfying it. Beadcause appears
 * there repeatedly, which is the honest description of a carved-out system that an auditor
 * will still ask for records out of.
 *
 * `held` is where the answer lives when it does not live here. A gap without an address is
 * a shrug with a schema — `lib/boundary.js`'s census makes the same demand of itself.
 *
 * Ordered by criterion id, which is the order a request list arrives in and the order the
 * report is written in. Adding a row is not enough to add a criterion and removing one is
 * not enough to drop it: the corpus decides which criteria exist, and
 * {@link assessmentProblems} refuses any disagreement.
 */
export const ASSESSMENT = Object.freeze([
  {
    id: 'SOC2.CC1.1',
    owner: 'executive sponsor',
    population: [],
    control: null,
    evidence: null,
    why:
      'No code of conduct exists, nothing records that anyone has read one, and no disciplinary path is ' +
      'written down. lib/policies.js carries the code of conduct as owed, which is the same finding said ' +
      'from the document side.',
    bears: null,
    held: 'Climative — this is an organisational control and nothing in this repository can hold it.',
  },
  {
    id: 'SOC2.CC1.2',
    owner: 'executive sponsor',
    population: [],
    control: null,
    evidence: null,
    why:
      'There is no board charter, no recorded oversight of security, and no minute of anyone independent ' +
      'reviewing the control environment. This is the criterion a CPA firm asks about first in a small ' +
      'organisation and the one least likely to have an artefact behind it.',
    bears: null,
    held: 'Climative — governance records, if any exist, are held by the company and not by this programme.',
  },
  {
    id: 'SOC2.CC1.3',
    owner: 'executive sponsor',
    population: [],
    control: null,
    evidence: null,
    why:
      'Reporting lines and who holds authority for security decisions are not written down anywhere this ' +
      'programme can see. bc-eqn1.1 settles top management and the roles table for the management system; ' +
      'until it lands there is no approved structure to test against.',
    bears: 'bc-eqn1.1, which settles the roles table this criterion would be tested against.',
    held: 'Climative, as an organisation chart the tracker does not hold.',
  },
  {
    id: 'SOC2.CC1.4',
    owner: 'people lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'No job descriptions naming security responsibility, no background screening record, no security ' +
      'awareness training and no evidence anybody completed any. HR security is one of the fifteen owed ' +
      'policies and none of the practices underneath it are recorded either.',
    bears: null,
    held: 'Climative — hiring, screening and training records live in the company HR system.',
  },
  {
    id: 'SOC2.CC1.5',
    owner: 'executive sponsor',
    population: [],
    control: null,
    evidence: null,
    why:
      'Nobody is recorded as accountable for any control in this programme, and no performance measure or ' +
      'consequence attaches to one. Every owner in this register is a function rather than a person, which ' +
      'is honest and is also exactly what this criterion asks to be closed.',
    bears: 'This register, which names an owning function per criterion but no accountable person.',
    held: 'Climative — accountability is assigned by the company, not derivable from here.',
  },
  {
    id: 'SOC2.CC2.1',
    owner: 'security lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'No definition of what security information management needs, how often, or in what form. There is no ' +
      'management report, no metric and no cadence — so there is nothing to test whether the information ' +
      'reaching a decision is relevant or of quality.',
    bears: null,
    held: 'Climative — whatever reporting exists today is internal and has not been collected here.',
  },
  {
    id: 'SOC2.CC2.2',
    owner: 'people lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'Nothing communicates security responsibilities to the people who hold them: no onboarding pack, no ' +
      'acknowledgement, no channel for reporting a concern. A policy set that is entirely owed cannot have ' +
      'been communicated.',
    bears: null,
    held: 'Climative — internal communication records belong to the company.',
  },
  {
    id: 'SOC2.CC2.3',
    owner: 'executive sponsor',
    population: [],
    control: null,
    evidence: null,
    why:
      'NYSERDA and TD are named as user entities, and what Climative has committed to them — availability, ' +
      'confidentiality, breach notification — has not been collected into this programme from the executed ' +
      'agreements. A system description cannot state service commitments that nobody has read out of a ' +
      'contract.',
    bears:
      'lib/boundary.js names NYSERDA and TD as user entities on the authority of bc-228x, which is the ' +
      'population this criterion is about.',
    held: 'The executed NYSERDA and TD agreements, held by Climative.',
  },
  {
    id: 'SOC2.CC3.1',
    owner: 'executive sponsor',
    population: [],
    control: null,
    evidence: null,
    why:
      'No security or availability objectives are stated with enough specificity to identify a risk against ' +
      'them. Objectives are the thing risk assessment is performed relative to, so this one being absent is ' +
      'what makes CC3.2 unassessable rather than merely undone.',
    bears: null,
    held: 'Climative — objectives would be set by management, and none are recorded.',
  },
  {
    id: 'SOC2.CC3.2',
    owner: 'security lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'There is no risk register for the in-scope system: nothing identifies risks to it, rates them, or ' +
      'records a treatment decision. This is the single largest organisational gap in the assessment, ' +
      'because half the criteria below are supposed to trace back to it.',
    bears: null,
    held: 'Climative — no risk assessment for Energy Navigator / Insights has been performed or filed here.',
  },
  {
    id: 'SOC2.CC3.3',
    owner: 'executive sponsor',
    population: [],
    control: null,
    evidence: null,
    why:
      'Fraud risk has not been considered as part of any risk assessment, because no risk assessment exists. ' +
      'Auditors accept a short and specific answer here; they do not accept silence.',
    bears: null,
    held: 'Climative — falls out of CC3.2 once a risk assessment is performed.',
  },
  {
    id: 'SOC2.CC3.4',
    owner: 'engineering lead',
    population: ['repo'],
    control: null,
    evidence: null,
    why:
      'Nothing assesses whether a change to the in-scope system is significant enough to need a risk ' +
      'decision before it ships. Beadcause records that a change happened and under whose authority, which ' +
      'is a different question from whether anybody weighed it.',
    bears:
      'Beadcause\'s bead-to-commit edges record the authority a change was made under, which is where a ' +
      'significance assessment would be attached if one existed.',
    held:
      'github.com/Climative/architecture — which repositories build the in-scope system is unsurveyed, so ' +
      'the population a significance rule would apply to is not known.',
  },
  {
    id: 'SOC2.CC4.1',
    owner: 'security lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'No internal audit, no control self-assessment and no management review of whether the controls are ' +
      'present and working. This register is the closest thing that exists, and it is a design assessment ' +
      'rather than an evaluation of operation.',
    bears: 'This register, and lib/management.js\'s management-review machinery for the carved-out system.',
    held: 'Climative — an evaluation programme has to be run by the organisation, not generated.',
  },
  {
    id: 'SOC2.CC4.2',
    owner: 'security lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'Nothing defines who a control deficiency is reported to or how its remediation is tracked to closure. ' +
      'lib/capa.js does exactly that for the carved-out management system, which shows the shape without ' +
      'covering the population.',
    bears: 'lib/capa.js records corrective action for beadcause\'s own management system, which is carved out.',
    held: 'Climative — deficiencies in the in-scope system have nowhere to be reported to today.',
  },
  {
    id: 'SOC2.CC5.1',
    owner: 'security lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'Control activities have not been selected against risks, because there are no rated risks to select ' +
      'against. The controls that exist in the estate exist because somebody built them, not because a ' +
      'risk decision put them there — which is the distinction this criterion tests.',
    bears: null,
    held: 'Climative — follows CC3.2.',
  },
  {
    id: 'SOC2.CC5.2',
    owner: 'engineering lead',
    population: ['host', 'repo'],
    control: null,
    evidence: null,
    why:
      'The general IT controls over the in-scope infrastructure — who can change it, how it is configured, ' +
      'how that is monitored — are not described. Some almost certainly exist as practice; none of them is ' +
      'written, approved or evidenced anywhere this programme can reach.',
    bears: null,
    held:
      'github.com/Climative/architecture — the hosting estate for Energy Navigator / Insights has not been ' +
      'enumerated, so neither the population nor its controls are known here.',
  },
  {
    id: 'SOC2.CC5.3',
    owner: 'security lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'The most precisely measured gap in the register: lib/policies.js enumerates the fifteen documents a ' +
      'SOC 2 engagement asks for and records every one of them as owed. Nothing has been approved, so ' +
      'nothing has been deployed, so no procedure derives from an approved policy.',
    bears: 'lib/policies.js, which names the fifteen owed documents and what each would be the answer for.',
    held: 'lib/policies.js holds the list; Climative holds the writing and the approval.',
  },
  {
    id: 'SOC2.CC6.1',
    owner: 'security lead',
    population: ['host', 'datastore', 'role'],
    control: null,
    evidence: null,
    why:
      'Logical access to the in-scope system — the identity provider, the cloud consoles, the databases ' +
      'holding user entity data — is administered in tools this repository has no integration with, and ' +
      'nobody has enumerated them. Beadcause authenticates access to beadcause, which the boundary carves ' +
      'out and which no user entity reaches.',
    bears:
      'lib/auth.js and lib/access.js govern access to the carved-out daemon, and so bear on who can reach ' +
      'the change path rather than on who can reach the system.',
    held:
      'github.com/Climative/architecture — the host, datastore and human-role censuses are all partial, so ' +
      'the population this is tested against does not exist yet.',
  },
  {
    id: 'SOC2.CC6.2',
    owner: 'security lead',
    population: ['role'],
    control: null,
    evidence: null,
    why:
      'No joiner-mover-leaver process is recorded: nothing authorises an account before it is created and ' +
      'nothing removes one when somebody leaves. This is the criterion that most often produces an ' +
      'exception in a first report, because the leaver half is the half nobody performs.',
    bears: null,
    held: 'Climative — the human roles inside the boundary are not knowable from here.',
  },
  {
    id: 'SOC2.CC6.3',
    owner: 'security lead',
    population: ['role', 'repo'],
    control: null,
    evidence: null,
    why:
      'No role definitions, no least-privilege statement and — the half that is tested hardest — no periodic ' +
      'access review over the in-scope systems or the repositories they are built from. lib/policies.js ' +
      'names the review as the part nothing here performs.',
    bears: null,
    held:
      'github.com/Climative/architecture and the Climative identity provider — the entitlement population ' +
      'is unsurveyed.',
  },
  {
    id: 'SOC2.CC6.4',
    owner: 'operations lead',
    population: ['host'],
    control: null,
    evidence: null,
    why:
      'Physical access to wherever the in-scope system runs is almost certainly a hosting provider\'s ' +
      'control rather than Climative\'s, which makes this a subservice question — and the subservice list ' +
      'is empty because nobody has surveyed it, not because there are none.',
    bears:
      'lib/boundary.js records the subservice census as partial and says explicitly that an empty list means ' +
      'unsurveyed.',
    held: 'The hosting provider\'s own attestation, once the subservice organisations are identified.',
  },
  {
    id: 'SOC2.CC6.5',
    owner: 'operations lead',
    population: ['datastore', 'host'],
    control: null,
    evidence: null,
    why:
      'Nothing describes how media and data are disposed of when a host is retired or a datastore dropped. ' +
      'Where user entity data rests, and under whose keys, is recorded as an enumeration nobody has done.',
    bears: null,
    held: 'github.com/Climative/architecture — the datastore census is partial.',
  },
  {
    id: 'SOC2.CC6.6',
    owner: 'engineering lead',
    population: ['host', 'egress'],
    control: null,
    evidence: null,
    why:
      'The network boundary of the in-scope system is not drawn anywhere this programme can read: no ' +
      'segmentation description, no ingress rules, no record of what is exposed. The boundary record draws ' +
      'the audit boundary, which is a different question and does not answer this one.',
    bears: null,
    held: 'github.com/Climative/architecture — the host and egress censuses are partial.',
  },
  {
    id: 'SOC2.CC6.7',
    owner: 'engineering lead',
    population: ['datastore', 'egress'],
    control: null,
    evidence: null,
    why:
      'Encryption in transit and at rest for user entity data, and any restriction on moving it to removable ' +
      'or personal devices, are undescribed. Every destination in-scope traffic leaves for is one of the ' +
      'censuses recorded as partial.',
    bears: null,
    held: 'github.com/Climative/architecture — the egress census is partial.',
  },
  {
    id: 'SOC2.CC6.8',
    owner: 'engineering lead',
    population: ['host', 'repo'],
    control: null,
    evidence: null,
    why:
      'Nothing prevents or detects unauthorised software on the in-scope hosts, and no dependency or ' +
      'artefact integrity control is recorded for the repositories they are built from.',
    bears: null,
    held: 'github.com/Climative/architecture — the host and repository censuses are partial.',
  },
  {
    id: 'SOC2.CC7.1',
    owner: 'engineering lead',
    population: ['host', 'repo'],
    control: null,
    evidence: null,
    why:
      'No configuration baseline for the in-scope estate and no vulnerability scanning or patch cadence ' +
      'recorded against it. An auditor tests this against a list of hosts, and the list does not exist.',
    bears: null,
    held: 'github.com/Climative/architecture — the host census is partial.',
  },
  {
    id: 'SOC2.CC7.2',
    owner: 'operations lead',
    population: ['host', 'datastore'],
    control: null,
    evidence: null,
    why:
      'Nothing monitors the in-scope system for anomalies, or if something does, it has not been described ' +
      'or pointed at a criterion. Beadcause monitors beadcause and files its own failures as beads, which ' +
      'is monitoring of the carved-out tooling.',
    bears:
      'Beadcause files its own errors as P0 beads, which is a control over the carved-out daemon and not ' +
      'over the system described.',
    held: 'github.com/Climative/architecture — the host and datastore censuses are partial.',
  },
  {
    id: 'SOC2.CC7.3',
    owner: 'security lead',
    population: ['host'],
    control: null,
    evidence: null,
    why:
      'No triage exists to decide whether a detected event is a security incident, because nothing is ' +
      'detecting events. CC7.2 has to close before this one can be more than a document.',
    bears: null,
    held: 'Climative — follows CC7.2.',
  },
  {
    id: 'SOC2.CC7.4',
    owner: 'security lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'No incident response plan for the in-scope system: no severity scale, no notification obligation to ' +
      'NYSERDA or TD, no post-incident review. lib/incident.js builds precisely that for the carved-out ' +
      'daemon, so the shape is known and the population is not covered.',
    bears:
      'lib/incident.js is the incident record for beadcause itself, which the Climative boundary carves out ' +
      '— a daemon crash is not an incident in the described system.',
    held: 'Climative — and the breach-notification terms are in the NYSERDA and TD agreements.',
  },
  {
    id: 'SOC2.CC7.5',
    owner: 'operations lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'Nothing records how the in-scope system is recovered after an incident, or that recovery has ever ' +
      'been exercised. This is CC7.4\'s other half and is absent for the same reason.',
    bears: null,
    held: 'Climative — follows CC7.4.',
  },
  {
    id: 'SOC2.CC8.1',
    owner: 'engineering lead',
    population: ['repo'],
    control: null,
    evidence:
      'Beadcause holds a per-change record for the repositories it drives: the bead a change was authorised ' +
      'under, the pull request that carried it, the reviewing agent\'s decision, the merge queue\'s ' +
      'merge, and a chained amendment log — all on git refs rather than in prose. lib/changesample.js is ' +
      'built to hand an auditor a sample of them.',
    why:
      'The one row that is not absent, and it is evidence without a control rather than the other way ' +
      'round. Nothing describes or approves how a change reaches production in Energy Navigator / Insights ' +
      '— what is reviewed, who authorises a release, how an emergency change is handled — so there is no ' +
      'control to test. What exists is a sampleable record of the authoring half, which lib/boundary.js ' +
      'records as the reason beadcause is carved out of the description and still inside the audit.',
    bears:
      'lib/boundary.js records beadcause as carved out with `bearsOn` naming exactly this criterion, and ' +
      'lib/servicescope.js enumerates the daemon\'s own controls for the same auditor.',
    held:
      'github.com/Climative/architecture — which of roughly forty repositories build the in-scope system, ' +
      'and how a build of them reaches production, is the survey the repository census is waiting on. Until ' +
      'it is done the records above cover an unknown fraction of the population.',
  },
  {
    id: 'SOC2.CC9.1',
    owner: 'operations lead',
    population: [],
    control: null,
    evidence: null,
    why:
      'No business continuity or disaster recovery plan for the in-scope system, and no analysis of what a ' +
      'disruption would cost NYSERDA or TD. Business continuity is one of the fifteen owed policies.',
    bears: null,
    held: 'Climative.',
  },
  {
    id: 'SOC2.CC9.2',
    owner: 'security lead',
    population: ['egress', 'subservice'],
    control: null,
    evidence: null,
    why:
      'No vendor register for the in-scope system, no risk assessment of any vendor, and no carve-out or ' +
      'inclusive decision for the processors behind the platform. bc-eqn1.9 builds a supplier register for ' +
      'beadcause\'s own egress; the in-scope system\'s is a separate survey nobody has started.',
    bears: 'lib/suppliers.js registers beadcause\'s own egress, which is carved out of the description.',
    held:
      'github.com/Climative/architecture — the subservice census is empty meaning unsurveyed, which ' +
      'lib/boundary.js says in as many words.',
  },
  {
    id: 'SOC2.A1.1',
    owner: 'operations lead',
    population: ['host'],
    control: null,
    evidence: null,
    why:
      'Availability is elected, and nothing monitors or forecasts capacity for the in-scope system. Electing ' +
      'a category adds criteria to the report whether or not controls exist for them, which is what makes ' +
      'this row a commitment rather than an observation.',
    bears: null,
    held: 'github.com/Climative/architecture — the host census is partial.',
  },
  {
    id: 'SOC2.A1.2',
    owner: 'operations lead',
    population: ['host', 'datastore'],
    control: null,
    evidence: null,
    why:
      'Backups, environmental protection and recovery infrastructure are undescribed for the in-scope ' +
      'system. Whether backups run is very likely a yes in practice and entirely unrecorded here, which is ' +
      'the difference between operating a control and being able to show one.',
    bears: null,
    held: 'github.com/Climative/architecture — the host and datastore censuses are partial.',
  },
  {
    id: 'SOC2.A1.3',
    owner: 'operations lead',
    population: ['host'],
    control: null,
    evidence: null,
    why:
      'No recovery test has been performed or recorded. This is the availability criterion auditors sample ' +
      'hardest, because a plan nobody has exercised is the ordinary finding.',
    bears: null,
    held: 'Climative — follows A1.2.',
  },
  {
    id: 'SOC2.C1.1',
    owner: 'security lead',
    population: ['datastore'],
    control: null,
    evidence: null,
    why:
      'Confidentiality is elected, and nothing identifies which information is confidential, classifies it, ' +
      'or states how long it is retained. Data classification is one of the fifteen owed policies and the ' +
      'datastore census is the population it would apply to.',
    bears: null,
    held: 'github.com/Climative/architecture — where user entity data rests is not written down here.',
  },
  {
    id: 'SOC2.C1.2',
    owner: 'security lead',
    population: ['datastore'],
    control: null,
    evidence: null,
    why:
      'Nothing describes how confidential information is disposed of at the end of its retention period, and ' +
      'no retention period has been set for any of it.',
    bears: null,
    held: 'github.com/Climative/architecture — follows C1.1.',
  },
].map(Object.freeze));

/* ------------------------------------------------------------------- deriving */

const text = (v) => String(v ?? '').trim();

/**
 * The state, from the two halves rather than from a field somebody typed.
 *
 * A control that produces evidence is met; one of the two is partial; neither is absent.
 * That is bc-4r10.4's definition verbatim, and computing it is what stops a row claiming
 * met after the control it named was descoped.
 */
export function stateOf(record) {
  const hasControl = Boolean(text(record?.control));
  const hasEvidence = Boolean(text(record?.evidence));
  if (hasControl && hasEvidence) return 'met';
  if (hasControl || hasEvidence) return 'partial';
  return 'absent';
}

/**
 * Whether the row rests on a population somebody has actually enumerated.
 *
 * Read out of `lib/boundary.js`'s census rather than asserted here, so surveying the estate
 * upgrades rows without an edit and letting a census lapse downgrades them the same way. A
 * row with an empty `population` is tested against documents and management rather than an
 * estate, so it is assessed — there is nothing left to survey before believing it.
 */
export function confidenceOf(record, boundary = boundaryFor(HELD_BY)) {
  const census = boundary?.census || {};
  const kinds = Array.isArray(record?.population) ? record.population : [];
  return kinds.some((k) => census[k]?.state === 'partial') ? 'provisional' : 'assessed';
}

/** The control ids that claim to satisfy this criterion, asked of the corpus. */
export const claims = (id) => satisfiedBy(id);

/** The policies that are the documented answer for this criterion, asked of the policy set. */
export const documentedBy = (id) => policiesFor(id);

/** The elected criteria the corpus holds, in id order. The list this register must match. */
export const electedCriteria = () =>
  byFramework('SOC2')
    .filter((r) => r.kind === 'criterion' && isElected(r.id))
    .map((r) => r.id)
    .sort();

/* ----------------------------------------------------------------- validating */

/** A repository path named inside a sentence, so a check can open it. */
const PATH_RE = /\b(?:lib|bin|test|scripts)\/[a-z0-9][a-z0-9-]*\.(?:js|mjs)\b/g;

/** Every module path a record names, across all three of its prose fields. */
export function pathsNamed(record) {
  const found = new Set();
  for (const field of ['control', 'evidence', 'bears', 'held']) {
    for (const hit of text(record?.[field]).matchAll(PATH_RE)) found.add(hit[0]);
  }
  return [...found].sort();
}

/** Everything wrong with one record, as sentences. */
export function recordProblems(record, { boundary = boundaryFor(HELD_BY) } = {}) {
  const problems = [];
  const id = text(record?.id);
  const at = id || '(no id)';

  if (!id) problems.push('a record has no criterion id');
  else if (!isControl(id)) problems.push(`${at}: not an id the control corpus mints`);
  else if (corpusRecord(id)?.kind !== 'criterion') problems.push(`${at}: is a ${corpusRecord(id)?.kind}, not a criterion`);
  else if (!categoryOf(id)) problems.push(`${at}: not a SOC 2 Trust Services criterion`);
  else if (!isElected(id)) {
    problems.push(`${at}: category ${categoryOf(id)} is not elected — elect it in lib/policies.js or drop the row`);
  }

  if (!ROLES.includes(text(record?.owner))) {
    problems.push(`${at}: owner "${text(record?.owner)}" is not one of ${ROLES.join(', ')}`);
  }

  const kinds = record?.population;
  if (!Array.isArray(kinds)) problems.push(`${at}: population must be an array of census kinds, even when empty`);
  else {
    for (const k of kinds) {
      if (!CENSUS_KINDS.includes(k)) problems.push(`${at}: population names "${k}", which is not a boundary census kind`);
    }
    if (new Set(kinds).size !== kinds.length) problems.push(`${at}: population repeats a census kind`);
  }

  const why = text(record?.why);
  if (why.length < WHY_MIN) problems.push(`${at}: why is ${why.length} characters; a state nobody explained is a state nobody can argue with`);

  for (const field of ['control', 'evidence', 'bears', 'held']) {
    const v = record?.[field];
    if (v !== null && v !== undefined && typeof v !== 'string') problems.push(`${at}: ${field} must be a sentence or null`);
    else if (typeof v === 'string' && !text(v)) problems.push(`${at}: ${field} is an empty string — use null, which means something`);
  }

  const state = stateOf(record);
  if (state === 'met' && text(record?.held)) {
    problems.push(`${at}: met, and still names somewhere the answer is held — a met criterion has its answer here`);
  }
  if (state !== 'met' && !text(record?.held)) {
    problems.push(`${at}: ${state}, and does not say where the answer is held — a gap without an address is a shrug`);
  }
  if (state === 'met' && confidenceOf(record, boundary) === 'provisional') {
    problems.push(
      `${at}: met against a population nobody has enumerated — the boundary census for ` +
        `${(record.population || []).filter((k) => boundary?.census?.[k]?.state === 'partial').join(', ')} is partial`
    );
  }

  return problems;
}

/**
 * Everything wrong with the register as a whole — and the check the bead is named for.
 *
 * One record per elected criterion, no record for an unelected one, no duplicates. Run
 * against the corpus rather than against a list kept beside it, because the failure worth
 * refusing is the criterion nobody wrote a row for: a hand-kept list agrees with itself by
 * construction and is silent about exactly the thing that went missing.
 */
export function assessmentProblems(register = ASSESSMENT, { boundary = boundaryFor(HELD_BY) } = {}) {
  const problems = [];
  if (!boundary) problems.push(`no boundary is recorded for "${HELD_BY}" — the assessment has nothing to be scoped by`);

  const seen = new Set();
  for (const record of register) {
    problems.push(...recordProblems(record, { boundary }));
    const id = text(record?.id);
    if (!id) continue;
    if (seen.has(id)) problems.push(`${id}: assessed twice`);
    seen.add(id);
  }

  for (const id of electedCriteria()) {
    if (!seen.has(id)) {
      problems.push(`${id}: elected and not assessed — ${corpusRecord(id)?.title || 'no title'}`);
    }
  }

  const declined = new Set(NOT_ELECTED.map((c) => c.category));
  for (const category of ['CC', 'A', 'C', 'PI', 'P']) {
    if (!ELECTED.includes(category) && !declined.has(category)) {
      problems.push(`category ${category} is neither elected nor recorded as declined — that is the silent absence`);
    }
  }

  return problems;
}

/* -------------------------------------------------------------------- reading */

/**
 * The register, joined to everything derived from it.
 *
 * One computation behind both the readable rendering and `--json`, which is what stops the
 * artefact a person reads and the payload a check gates on from disagreeing.
 */
export function assess(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  return register.map((record) => ({
    ...record,
    title: corpusRecord(record.id)?.title || null,
    category: categoryOf(record.id),
    state: stateOf(record),
    confidence: confidenceOf(record, boundary),
    claims: claims(record.id),
    documentedBy: documentedBy(record.id).map((p) => p.id),
  }));
}

/** The rows in one state, joined. */
export const byState = (state, register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) =>
  assess(register, boundary).filter((r) => r.state === text(state));

/** Everything that is not met — the remediation list, in the order a report is written. */
export const gaps = (register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) =>
  assess(register, boundary).filter((r) => r.state !== 'met');

/** What each owning function is carrying, worst state first. */
export function byOwner(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  const rank = { absent: 0, partial: 1, met: 2 };
  const out = new Map(ROLES.map((r) => [r, []]));
  for (const row of assess(register, boundary)) out.get(row.owner)?.push(row);
  for (const rows of out.values()) rows.sort((a, b) => rank[a.state] - rank[b.state] || a.id.localeCompare(b.id));
  return out;
}

/** Counts by state and by confidence, for a header or a check. */
export function counts(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  const rows = assess(register, boundary);
  const tally = (key, keys) => Object.fromEntries(keys.map((k) => [k, rows.filter((r) => r[key] === k).length]));
  return { total: rows.length, state: tally('state', STATES), confidence: tally('confidence', CONFIDENCE) };
}

/**
 * One line, for a log or a check.
 *
 * The provisional count is in it deliberately. A summary reading "0 met, 1 partial, 37
 * absent" and stopping is the summary that sends somebody to write thirty-seven controls
 * when twenty-one of the rows are waiting on a survey instead.
 */
export function summarise(register = ASSESSMENT, boundary = boundaryFor(HELD_BY)) {
  const c = counts(register, boundary);
  return (
    `${text(boundary?.serviceOrganisation) || HELD_BY} · ${text(boundary?.system) || 'no system recorded'} · ` +
    `${c.total} elected criteri${c.total === 1 ? 'on' : 'a'} · ` +
    `${c.state.met} met, ${c.state.partial} partial, ${c.state.absent} absent · ` +
    `${c.confidence.provisional} provisional`
  );
}

/**
 * One criterion as the bead bc-4r10.4 asks for, ready for `bin/file.js`.
 *
 * A projection rather than a filing, and the distinction is the point. Thirty-eight beads
 * typed by hand drift from the register within a quarter, and a criterion quietly dropped
 * from the tracker is the exact failure this module exists to refuse — the register is what
 * cannot lose one, because the corpus enumerates it. So the beads are emitted from here,
 * carry their state, their owner, the control ids that claim them and what would be
 * sampled, and can be regenerated when any of those change.
 */
export function beadFor(row) {
  const claimed = row.claims?.length ? row.claims.join(', ') : 'nothing in the corpus';
  const docs = row.documentedBy?.length ? row.documentedBy.join(', ') : 'no policy';
  return {
    title: `${row.id} ${row.title} — ${row.state}${row.confidence === 'provisional' ? ' (provisional)' : ''}`,
    type: 'task',
    priority: 2,
    complexity: 'medium',
    description:
      `${row.why}\n\n` +
      `State: ${row.state}, ${row.confidence}. Owner: ${row.owner}.\n` +
      `Control today: ${row.control || 'none described'}\n` +
      `Evidence an auditor could sample today: ${row.evidence || 'none'}\n` +
      `Claimed by, in the control corpus: ${claimed}\n` +
      `Documented answer, in the policy set: ${docs}\n` +
      (row.bears ? `Bears on it without satisfying it: ${row.bears}\n` : '') +
      (row.held ? `Held: ${row.held}\n` : ''),
    acceptance:
      `A control over ${row.id} is described, approved and owned, and an artefact exists that an auditor ` +
      'could sample for the period — at which point lib/gapassessment.js records both halves and the state ' +
      'computes to met.',
    rationale: 'Generated from lib/gapassessment.js by beadcause-gaps, on bc-4r10.4.',
  };
}

const shipped = assessmentProblems();
if (shipped.length) {
  throw new Error(`lib/gapassessment.js: the shipped gap assessment is broken —\n  ${shipped.join('\n  ')}`);
}
