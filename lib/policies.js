/**
 * The policy set, as a controlled document set that expires — not a folder of PDFs.
 *
 * A SOC 2 engagement expects roughly fifteen policies, and the request list is close to
 * identical between firms: information security, access control, change management, risk
 * assessment, vendor management, incident response, business continuity and disaster
 * recovery, data classification and handling, acceptable use, secure development,
 * encryption, logging and monitoring, physical security, HR security, and a code of
 * conduct. **The auditor's test is rarely the content.** It is the approval record and
 * the review date, and the exception written up more often than any other is a policy
 * last reviewed before the observation period began.
 *
 * So this file is a register of fifteen documents rather than the documents. Each entry
 * carries the four things fieldwork asks about — who owns it, who approved it, when, and
 * how often it is reviewed — and a state computed from a date rather than asserted, so
 * **an overdue review is a red bead before it is an audit exception**. The machinery for
 * that already exists: `lib/documents.js` (bc-eqn1.11) decided what a controlled document
 * is and how a review date expires, and everything below imports it rather than restating
 * it. A second definition of "overdue" is how two registers come to disagree about the
 * same date.
 *
 * ## The criteria mapping is the load-bearing half
 *
 * A policy set that nobody has mapped to criteria is fifteen documents and an argument in
 * fieldwork. Each entry here names the SOC 2 criteria it is the documented answer for,
 * and {@link setProblems} refuses two failures the auditor would otherwise find first:
 *
 * - **A policy naming a criterion that does not exist.** Held to shape here, and resolved
 *   against the real corpus by `test/policies.mjs` the moment `lib/controls.js` lands —
 *   the same guarded arrangement `test/servicescope.mjs` uses, for the same reason.
 * - **A criterion no policy claims.** The drift that reads as coverage: every policy in
 *   the set is current, and CC7.2 is in none of them. Every elected criterion must be
 *   claimed by at least one entry, and {@link unclaimed} is the list that has to be empty.
 *
 * `ELECTED` is why that check can be exhaustive without inventing anything. The corpus
 * holds all 61 criteria because electing a category is a decision (bc-4r10.4); a policy
 * set is written against the categories actually elected, and Security, Availability and
 * Confidentiality is what this programme is built around today — `lib/servicescope.js`
 * enumerates `A1` and `C1` controls and no `PI1` or `P` ones, and this agrees with it.
 * **Electing one more category is meant to turn this red**: five processing-integrity
 * criteria or eighteen privacy ones arrive unclaimed, and the policy set has to grow
 * before the report can. That red is the feature, exactly as it is in `test/controls.mjs`.
 *
 * ## One source, two renderings
 *
 * No entry names an ISO 27001 or ISO 42001 control. That is not an omission and a second
 * hand-written mapping is what it is refusing to be: the corpus already declares the
 * crosswalk, so {@link alsoServes} walks it — a policy claiming `SOC2.CC6.1` serves
 * whichever Annex A controls satisfy CC6.1, computed at the moment it is asked. Two
 * mappings maintained by two people is how a policy comes to be evidence for a 27001
 * control it stopped covering a year ago.
 *
 * ## Owed is a state, and it is the honest one today
 *
 * Not one of these fifteen documents exists. Writing owners and approval dates for them
 * anyway would produce a register that passes every check and is false in the only way
 * that matters — `lib/documents.js` refuses to invent an approver and this refuses the
 * same thing. So an entry is `adopted` or `owed`, the adoption fields are all `null`
 * while it is owed, and {@link entryProblems} enforces the split in both directions: an
 * adopted policy with no approver is refused, and an owed one carrying an approval date
 * is refused just as hard.
 *
 * What an owed entry does carry is `ownerRole` and `reviewMonths` — the role that has to
 * own it and the cadence already decided — because "who owns this" has a useful answer
 * before a name is on it, and a cadence argued now is a cadence nobody negotiates during
 * fieldwork. And it carries `enforcedBy`: the modules in this repository that already
 * make the policy's substance true. **A policy that is written but not operating is the
 * common exception; the inverse is what this install actually has,** and recording it is
 * what stops a merge queue, an endorsement gate and a supplier register from being
 * re-described from scratch when somebody finally writes the change-management policy.
 * An empty `enforcedBy` is a real answer and says so: nothing here enforces it.
 *
 * ## Whose policies these are
 *
 * Climative's. bc-228x settled the subject — Climative is the service organisation,
 * Energy Navigator / Insights is the system, and beadcause is outside that boundary
 * (`lib/boundary.js`). A policy is an organisational document, so the set belongs to the
 * organisation and not to this daemon, and `HELD_BY` names it once. *First* service
 * organisation was load-bearing in Adam's answer: a second one means keying this the way
 * `lib/boundary.js` keys `BOUNDARIES`, which is a small change made deliberately rather
 * than a shape guessed at now for a tenant that may never arrive.
 *
 * A leaf, like the register it is built on: `lib/documents.js` and node builtins, no
 * state read and none written, so a check, a report generator and a CLI can each hold it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { MAX_REVIEW_MONTHS, WARN_DAYS, parseDate, reviewStatus } from './documents.js';

export { MAX_REVIEW_MONTHS, WARN_DAYS };

/**
 * The organisation whose policy set this is (bc-228x).
 *
 * One value rather than a registry, and the reason is the same one `lib/boundary.js`
 * gives for `CARVE_OUTS_ARE_ENUMERATED`: a shape built for tenants that do not exist is a
 * shape nobody has ever tested with two of anything in it.
 */
export const HELD_BY = 'climative';

/**
 * The Trust Services categories this policy set is written against.
 *
 * `CC` is the common criteria and is in every SOC 2 report. `A` is availability and `C`
 * confidentiality — elected, and `lib/servicescope.js` already enumerates its own
 * controls against both. `PI` (processing integrity) and `P` (privacy) are not elected;
 * bc-4r10.4 owns that decision and electing either is meant to make {@link unclaimed}
 * non-empty until the policy set grows to meet it.
 */
export const ELECTED = Object.freeze(['CC', 'A', 'C']);

/** Whether a policy exists as an approved document, or is still owed. */
export const ADOPTION = Object.freeze(['adopted', 'owed']);

/**
 * What a policy is, right now.
 *
 * `owed` is not a review state — nothing expires that was never approved — and the other
 * three are `lib/documents.js`'s, unchanged, because a policy going stale and a register
 * going stale are the same event with the same fuse.
 */
export const STATES = Object.freeze(['owed', 'current', 'approaching', 'overdue']);

/** A SOC 2 criterion id, held to the shape the corpus holds its own to. */
const CRITERION_RE = /^SOC2\.(CC|PI|[ACP])(\d+)\.(\d+)$/;

/** Which Trust Services category a criterion belongs to, or `null` if that is not one. */
export function categoryOf(id) {
  const hit = CRITERION_RE.exec(String(id ?? '').trim());
  return hit ? hit[1] : null;
}

/** Is this criterion one the elected categories cover? */
export const isElected = (id) => ELECTED.includes(categoryOf(id));

/**
 * The functions a policy can be owned by, rather than the job titles somebody holds.
 *
 * Fifteen invented job titles would be an org chart nobody has approved, so this is a
 * closed set of *functions* — and closed for the reason every vocabulary here is: an
 * owner spelled two ways is two owners as far as anything reading this is concerned.
 * bc-eqn1.1 settles top management and the roles table for real; when it does, adoption
 * replaces the function with the name of the person who signed, which is what `owner`
 * is for and why it stays `null` until then.
 */
export const ROLES = Object.freeze([
  'executive sponsor',
  'security lead',
  'engineering lead',
  'operations lead',
  'people lead',
]);

/**
 * The fifteen policies, what each is the documented answer for, and what already
 * enforces it here.
 *
 * Ordered the way a request list arrives: the apex policy, then the ones an engineering
 * organisation is asked for first, then the organisational ones. Adding a sixteenth is a
 * code change on purpose — `lib/documents.js` makes the argument, and it is stronger
 * here, because a policy set that can be extended from a form grows entries that name a
 * criterion nobody checked and an owner nobody told.
 *
 * `criteria` is what the policy is the documented answer for. It is not a claim that the
 * criterion is *met* — that is `lib/servicescope.js`'s `state`, and a policy is one
 * input to it. `enforcedBy` is the other direction: what in this repository already makes
 * the substance true, which for several of these is considerably more than the document
 * would have claimed.
 */
export const POLICIES = Object.freeze([
  {
    id: 'information-security',
    title: 'Information Security Policy',
    aim:
      'The apex policy: what the organisation is protecting, who is accountable for it, that the rest of this set exists ' +
      'and is followed, and that management reviews whether the controls are present and working.',
    ownerRole: 'executive sponsor',
    reviewMonths: 12,
    criteria: ['SOC2.CC1.2', 'SOC2.CC1.3', 'SOC2.CC4.1', 'SOC2.CC4.2', 'SOC2.CC5.1', 'SOC2.CC5.3'],
    enforcedBy: ['lib/management.js', 'lib/election.js', 'lib/capa.js'],
    owes:
      'Nothing signs it. lib/management.js records that the management system is on and lib/capa.js records what was done ' +
      'about a nonconformity, but the statement of intent those operate under has never been written or approved.',
    adoption: 'owed',
  },
  {
    id: 'access-control',
    title: 'Access Control Policy',
    aim:
      'Who may reach what, on whose authorisation, at what privilege, and how an entitlement ends — including the review ' +
      'that catches the access nobody removed.',
    ownerRole: 'security lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC6.1', 'SOC2.CC6.2', 'SOC2.CC6.3', 'SOC2.CC6.6'],
    enforcedBy: ['lib/access.js', 'lib/auth.js'],
    owes:
      'The periodic review is the half nothing here performs. Access to this daemon is enforced and recorded; access to the ' +
      'systems inside the boundary — cloud consoles, the identity provider, the repositories — is authorised in tools this ' +
      'repository has no integration with, and CC6.3 is tested against that population.',
    adoption: 'owed',
  },
  {
    id: 'change-management',
    title: 'Change Management Policy',
    aim:
      'How a change to software, infrastructure or a procedure is authorised, reviewed, tested and released, and what makes ' +
      'a change significant enough to be assessed before it takes effect rather than after.',
    ownerRole: 'engineering lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC3.4', 'SOC2.CC5.2', 'SOC2.CC7.1', 'SOC2.CC8.1'],
    enforcedBy: ['lib/endorse.js', 'lib/mergequeue.js', 'lib/mergeadmit.js', 'lib/requirements.js'],
    owes:
      'This is the policy with the least distance to travel and it is still not written. The gate no unattended session may ' +
      'cross, the queue that merges one branch at a time against the checks, and the requirement-to-bead-to-commit edges are ' +
      'the control operating; what is missing is the document saying that is how changes are made, so an auditor can test ' +
      'the practice against a stated one rather than against whatever the tooling happens to do.',
    adoption: 'owed',
  },
  {
    id: 'risk-assessment',
    title: 'Risk Assessment and Treatment Policy',
    aim:
      'What the objectives are, how risks to them are identified, analysed and rated, who decides the treatment, and how ' +
      'often the assessment is redone — including the fraud and control-override risks nobody volunteers.',
    ownerRole: 'security lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC3.1', 'SOC2.CC3.2', 'SOC2.CC3.3'],
    enforcedBy: [],
    owes:
      'Nothing in this repository performs, records or expires a risk assessment, and the empty list is the finding. It is ' +
      'the largest gap in the set: CC3 is tested by asking to see the current assessment and the one before it, and a ' +
      'programme with none has no evidence that its control selection was decided rather than assembled. bc-eqn1.5 builds ' +
      'the register and bc-4r10.8 is the argument that CC3 and CC9 read off that one rather than growing a second.',
    adoption: 'owed',
  },
  {
    id: 'vendor-management',
    title: 'Vendor and Third-Party Management Policy',
    aim:
      'Which third parties may be introduced, what may be sent to each, what the agreement has to commit them to, and how ' +
      'often that is looked at again.',
    ownerRole: 'security lead',
    reviewMonths: 6,
    criteria: ['SOC2.CC9.2'],
    enforcedBy: ['lib/suppliers.js'],
    owes:
      'Six months rather than twelve for the reason the supplier register itself is on six: every entry restates somebody ' +
      "else's terms and those change without telling anybody. The register answers what is sent and under what terms; the " +
      'policy that says who may add an eighth supplier, and against what assessment, does not exist.',
    adoption: 'owed',
  },
  {
    id: 'incident-response',
    title: 'Incident Response Policy',
    aim:
      'How an event becomes an incident, who decides, the severities and the response times attached to each, who is told ' +
      'inside and outside the organisation, and what has to change afterwards.',
    ownerRole: 'security lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC2.3', 'SOC2.CC7.3', 'SOC2.CC7.4', 'SOC2.CC7.5'],
    enforcedBy: ['lib/incident.js', 'lib/capa.js', 'lib/findings.js'],
    owes:
      'The commitments are already measured — lib/incident.js derives acknowledge and resolve times from the tracker rather ' +
      'than from a state file — but they are measured against numbers no approved document states. External communication ' +
      '(CC2.3) has no mechanism at all: no user entity is notified of anything by anything here.',
    adoption: 'owed',
  },
  {
    id: 'business-continuity',
    title: 'Business Continuity and Disaster Recovery Policy',
    aim:
      'What has to keep running, how long it may be down and how much data may be lost, what the recovery arrangements are, ' +
      'and the test that establishes the plan works rather than reads well.',
    ownerRole: 'operations lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC7.5', 'SOC2.CC9.1', 'SOC2.A1.1', 'SOC2.A1.2', 'SOC2.A1.3'],
    enforcedBy: ['lib/continuity.js', 'lib/posture.js'],
    owes:
      'A1.3 is the one that fails engagements: an untested recovery plan is an exception however good the plan is. ' +
      'lib/posture.js records what a deployment can back up and lib/continuity.js what survives a restart; neither is a ' +
      'restore performed on a date, which is what the auditor samples.',
    adoption: 'owed',
  },
  {
    id: 'data-classification',
    title: 'Data Classification and Handling Policy',
    aim:
      'The classifications information is held under, what each permits by way of storage, transmission and sharing, how ' +
      'long it is kept, and how it is disposed of when the retention ends.',
    ownerRole: 'security lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC6.5', 'SOC2.CC6.7', 'SOC2.C1.1', 'SOC2.C1.2'],
    enforcedBy: ['lib/publishable.js', 'lib/evidence.js'],
    owes:
      'The two halves exist and are not joined by a document: lib/publishable.js is a closed vocabulary of what may leave ' +
      'the Mac, and lib/evidence.js states a retention and a disposal per class of record. Neither says which classification ' +
      "an organisation's data is under in the first place, and C1.1 is tested from that end.",
    adoption: 'owed',
  },
  {
    id: 'acceptable-use',
    title: 'Acceptable Use Policy',
    aim:
      'What people may do with the organisation\'s systems, accounts and data on the devices they use, what they may not ' +
      'install or move onto removable media, and what happens when the rule is broken.',
    ownerRole: 'people lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC6.7', 'SOC2.CC6.8'],
    enforcedBy: [],
    owes:
      'Nothing here constrains what runs on an endpoint or what is copied off one, and CC6.8 is normally answered with a ' +
      'managed-device control this organisation would have to state that it has. An acceptable-use policy that is only ' +
      'acknowledged and never enforced is still worth having, but it is worth saying which of the two it is.',
    adoption: 'owed',
  },
  {
    id: 'secure-development',
    title: 'Secure Development Policy',
    aim:
      'How software is designed, reviewed, tested and released securely: what a review has to cover, how a dependency is ' +
      'admitted and kept current, and how a vulnerability found in one is triaged and fixed.',
    ownerRole: 'engineering lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC7.1', 'SOC2.CC8.1'],
    enforcedBy: ['lib/vulnscan.js', 'lib/endorse.js'],
    owes:
      'lib/vulnscan.js files a bead per advisory precisely so that first-seen and remediation dates exist without a parallel ' +
      'store, which is most of CC7.1 already operating. The remediation windows it is measured against are not stated ' +
      'anywhere, and a window nobody agreed cannot be missed.',
    adoption: 'owed',
  },
  {
    id: 'encryption',
    title: 'Encryption and Key Management Policy',
    aim:
      'What has to be encrypted at rest and in transit, to what standard, and how the keys are generated, stored, rotated ' +
      'and destroyed — the half that is normally missing.',
    ownerRole: 'security lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC6.1', 'SOC2.CC6.7'],
    enforcedBy: [],
    owes:
      'Encryption in this system is whatever the platforms underneath it do by default, which may well be adequate and is ' +
      'not a stated position. Key management is the part fieldwork asks about and there is no answer at all: no key ' +
      'inventory, no rotation period, nothing recording who could decrypt what.',
    adoption: 'owed',
  },
  {
    id: 'logging-and-monitoring',
    title: 'Logging and Monitoring Policy',
    aim:
      'What is logged, where it goes, how long it is kept, what is watched for, and what a person is expected to do when ' +
      'something is detected.',
    ownerRole: 'operations lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC2.1', 'SOC2.CC7.2'],
    enforcedBy: ['lib/agentlog.js', 'lib/agentarchive.js', 'lib/findings.js'],
    owes:
      'Agent runs are logged, archived against a retention and made legible, and lib/findings.js treats a silent instance ' +
      'as a finding rather than as good news — which is a genuine detection control. What is absent is the security half: ' +
      'no authentication, infrastructure or network telemetry from inside the boundary reaches anything that watches it.',
    adoption: 'owed',
  },
  {
    id: 'physical-security',
    title: 'Physical and Environmental Security Policy',
    aim:
      'Who may enter the places equipment and information are kept, how visitors and media are handled, what the ' +
      'environmental protections are, and how an asset is sanitised before it leaves.',
    ownerRole: 'operations lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC6.4', 'SOC2.CC6.5', 'SOC2.A1.2'],
    enforcedBy: [],
    owes:
      'Almost all of it will be answered by a hosting provider and inherited rather than performed, which is a legitimate ' +
      'answer that still has to be written down and supported by that provider\'s own report. The part that is not ' +
      'inherited is offices and laptops, and nothing states either.',
    adoption: 'owed',
  },
  {
    id: 'hr-security',
    title: 'Human Resources Security Policy',
    aim:
      'Screening before access is granted, the terms people accept, the training they are given and evidenced against, and ' +
      'what happens to accounts and equipment when somebody leaves.',
    ownerRole: 'people lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC1.4', 'SOC2.CC6.2'],
    enforcedBy: [],
    owes:
      'CC1.4 is tested by asking for training records for named people on named dates, and there are none. bc-eqn1.16 asks ' +
      'the narrower version of the same question — who is competent to approve an AI impact assessment, and what were they ' +
      'told — and the general answer this policy needs would settle it.',
    adoption: 'owed',
  },
  {
    id: 'code-of-conduct',
    title: 'Code of Conduct',
    aim:
      'The standard of behaviour everyone is held to, acknowledged rather than published, with a route for raising a ' +
      'concern that does not go through the person the concern is about.',
    ownerRole: 'people lead',
    reviewMonths: 12,
    criteria: ['SOC2.CC1.1', 'SOC2.CC1.5', 'SOC2.CC2.2'],
    enforcedBy: [],
    owes:
      'CC1.1 is tested by asking for the acknowledgements, so the document alone is not the deliverable — a record of who ' +
      'accepted it and when is. CC2.2 needs a reporting channel that bypasses the ordinary line, and in an organisation ' +
      'this size that is a decision about who receives it, not a tool.',
    adoption: 'owed',
  },
]);

/* ---------------------------------------------------------- what must hold */

const text = (v) => String(v ?? '').trim();
const prose = (v) => typeof v === 'string' && v.trim().length >= 40;
const named = (v) => typeof v === 'string' && v.trim().length >= 2;

/**
 * The six fields adoption fills in, and which an owed policy must not have.
 *
 * Both directions are enforced. An adopted policy missing an approver is the obvious
 * failure; an owed policy carrying an approval date is the dangerous one, because it is
 * the shape a register takes when somebody fills in what a document *would* say.
 */
export const ADOPTION_FIELDS = Object.freeze(['path', 'owner', 'approvedBy', 'approvedOn', 'version', 'reviewedOn']);

/**
 * Everything wrong with one policy, as sentences.
 *
 * Takes an entry rather than reading {@link POLICIES}, for the reason `lib/documents.js`
 * and `lib/evidence.js` both give: a rule that only ever runs against a register which
 * passes is a rule nobody has seen fail. `test/policies.mjs` runs these against entries
 * broken one field at a time.
 */
export function entryProblems(p) {
  const problems = [];
  const at = `POLICIES[${text(p?.id) || '?'}]`;

  if (!/^[a-z][a-z0-9-]*$/.test(text(p?.id))) problems.push(`${at}: id must be kebab-case`);
  if (!named(p?.title)) problems.push(`${at}: \`title\` must be the name the policy is asked for by`);
  if (!prose(p?.aim)) problems.push(`${at}: \`aim\` must say what the policy has to state, in a sentence`);
  if (!ROLES.includes(text(p?.ownerRole))) {
    problems.push(`${at}: \`ownerRole\` must be one of ${ROLES.join(', ')} — an owner spelled two ways is two owners`);
  }

  if (!Number.isInteger(p?.reviewMonths) || p.reviewMonths < 1 || p.reviewMonths > MAX_REVIEW_MONTHS) {
    problems.push(
      `${at}: \`reviewMonths\` must be a whole number of months between 1 and ${MAX_REVIEW_MONTHS} — ` +
        'a cadence is decided when the policy is written, not when the review is missed'
    );
  }

  if (!Array.isArray(p?.criteria) || p.criteria.length === 0) {
    problems.push(`${at}: \`criteria\` must name at least one criterion — a policy answering nothing is a document, not a control`);
  } else {
    for (const id of p.criteria) {
      if (!categoryOf(id)) problems.push(`${at}: \`${text(id)}\` is not the shape a SOC 2 criterion id has`);
      else if (!isElected(id)) {
        problems.push(
          `${at}: \`${text(id)}\` is in the ${categoryOf(id)} category, which this report does not elect (bc-4r10.4) — ` +
            'either elect it in ELECTED or stop claiming it'
        );
      }
    }
    if (new Set(p.criteria.map(text)).size !== p.criteria.length) problems.push(`${at}: \`criteria\` names the same criterion twice`);
  }

  if (!Array.isArray(p?.enforcedBy)) {
    problems.push(`${at}: \`enforcedBy\` must be a list of files, empty if nothing here enforces it — an absent list reads as "not applicable"`);
  }

  if (!ADOPTION.includes(text(p?.adoption))) problems.push(`${at}: \`adoption\` must be one of ${ADOPTION.join(', ')}`);

  if (text(p?.adoption) === 'owed') {
    if (!prose(p?.owes)) problems.push(`${at}: \`owes\` must say what has to happen before this can be adopted, in a sentence`);
    for (const field of ADOPTION_FIELDS) {
      if (p?.[field] != null) {
        problems.push(`${at}: \`${field}\` is set on a policy that is still owed — an approval nobody gave cannot be recorded`);
      }
    }
  }

  if (text(p?.adoption) === 'adopted') {
    if (!named(p?.path)) problems.push(`${at}: \`path\` must name the file the approved policy lives in`);
    if (!named(p?.owner)) problems.push(`${at}: \`owner\` must name the person accountable for it, not the role`);
    if (!named(p?.approvedBy)) problems.push(`${at}: \`approvedBy\` must name whoever approved it`);
    if (!named(p?.version)) problems.push(`${at}: \`version\` must say which version this is`);

    const approved = parseDate(p?.approvedOn);
    const reviewed = parseDate(p?.reviewedOn);
    if (approved === null) problems.push(`${at}: \`approvedOn\` must be a real date, as YYYY-MM-DD`);
    if (reviewed === null) problems.push(`${at}: \`reviewedOn\` must be a real date, as YYYY-MM-DD`);
    if (approved !== null && reviewed !== null && reviewed < approved) {
      problems.push(`${at}: reviewed ${p.reviewedOn}, before it was approved on ${p.approvedOn} — one of the two dates is wrong`);
    }
  }

  return problems;
}

/**
 * Everything wrong with the set as a set, without touching the disk or the clock.
 *
 * Thrown at import, below, the way `lib/servicescope.js` and `lib/boundary.js` throw
 * theirs: a register that could ship malformed is one that answers "nothing is unclaimed"
 * on the machine reporting what is unclaimed. Dates and files are deliberately *not* here
 * — an overdue review must fail a check rather than crash every process that imports this,
 * which is the same line `lib/documents.js` draws.
 */
export function registerProblems(register = POLICIES) {
  if (!Array.isArray(register)) return ['the policy set is a list of policies'];

  const problems = [];
  const seen = new Set();
  for (const p of register) {
    problems.push(...entryProblems(p));
    if (seen.has(text(p?.id))) problems.push(`POLICIES[${text(p?.id)}]: two policies with the same id`);
    seen.add(text(p?.id));
  }
  return problems;
}

/* -------------------------------------------------------------- the reads */

/** Every criterion any policy claims, deduplicated and sorted. */
export function claimed(register = POLICIES) {
  const ids = new Set();
  for (const p of register) for (const id of p.criteria || []) ids.add(text(id));
  return [...ids].sort();
}

/** Which policies are the documented answer for this criterion. */
export const policiesFor = (id, register = POLICIES) =>
  register.filter((p) => (p.criteria || []).some((c) => text(c) === text(id)));

/**
 * The policy set measured against the real corpus.
 *
 * `criteria` is every SOC 2 id the corpus holds — `byFramework('SOC2')` from
 * `lib/controls.js`, passed in rather than imported, because this file is a leaf and its
 * neighbour is not in every release. `unclaimed` is the list that has to be empty and
 * `unknown` is the one that catches a criterion invented here or renamed there.
 */
export function coverage(criteria, register = POLICIES) {
  const all = [...(criteria || [])].map(text).filter((id) => categoryOf(id));
  const elected = all.filter(isElected);
  const exempt = all.filter((id) => !isElected(id));
  const claims = claimed(register);
  return {
    elected,
    exempt,
    claimed: claims,
    unclaimed: elected.filter((id) => !claims.includes(id)),
    unknown: claims.filter((id) => !all.includes(id)),
  };
}

/**
 * The other frameworks this policy serves, read off the corpus rather than written here.
 *
 * `satisfiedBy` is `lib/controls.js`'s, passed in: for a criterion, the Annex A controls
 * that crosswalk to it. So a policy claiming `SOC2.CC6.1` is documented information for
 * whichever 27001 and 42001 controls point at CC6.1, and stays so when the corpus changes
 * — which a second mapping typed out here would not.
 */
export function alsoServes(policy, satisfiedBy) {
  const ids = new Set();
  for (const id of policy?.criteria || []) for (const other of satisfiedBy(text(id)) || []) ids.add(text(other));
  return [...ids].sort();
}

/**
 * What this policy is right now: `owed`, or how its review date stands.
 *
 * `now` is a parameter rather than a call to the clock, for `lib/documents.js`'s reason:
 * a state that cannot be pointed at a date is a state nobody has seen change.
 */
export function stateOf(entry, now = new Date()) {
  if (text(entry?.adoption) !== 'adopted') return { state: 'owed', due: null, days: null };
  const { due, days, state } = reviewStatus(entry, now);
  return { state: state ?? 'owed', due, days };
}

/** The policies nothing here enforces and nobody has written — the readiness gap, in order. */
export const gaps = (register = POLICIES) =>
  register.filter((p) => text(p.adoption) === 'owed' && (p.enforcedBy || []).length === 0);

/* ------------------------------------------------------------- the check */

/**
 * Everything wrong with the set in this checkout, split into what fails and what warns.
 *
 * Returned rather than thrown so one run names every problem — reviews come due in
 * batches, and the day somebody sits down to do one they should be told about all of
 * them. `criteria` is optional: hand it the corpus and the coverage rules run, leave it
 * out and everything else still does, which is what lets `test/policies.mjs` keep working
 * in a release where `lib/controls.js` has not landed.
 */
export function setProblems(root, now = new Date(), { register = POLICIES, criteria = null } = {}) {
  const problems = [...registerProblems(register)];
  const warnings = [];

  for (const p of register) {
    const at = `POLICIES[${text(p?.id) || '?'}]`;

    for (const file of p.enforcedBy || []) {
      if (!fs.existsSync(path.join(root, file))) {
        problems.push(
          `${at}: \`enforcedBy\` names ${file}, which is not in the repo — either it was renamed, in which case say so ` +
            'here, or the enforcement it claimed is gone and the policy is owed more than it says'
        );
      }
    }

    if (text(p.adoption) === 'adopted' && named(p.path) && !fs.existsSync(path.join(root, p.path))) {
      problems.push(`${at}: ${p.path} is not in the repo — an approved policy nobody can read is not a policy`);
    }

    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    for (const field of ['approvedOn', 'reviewedOn']) {
      const t = parseDate(p?.[field]);
      if (t !== null && t > today) problems.push(`${at}: \`${field}\` is ${p[field]}, which has not happened yet`);
    }

    const { state, due, days } = stateOf(p, now);
    if (state === 'overdue') {
      problems.push(
        `${at}: review was due ${due}, ${-days} day${days === -1 ? '' : 's'} ago. Read it, change what is no longer ` +
          `true, bump \`version\`, then move \`reviewedOn\` — in that order. ${p.owner} owns it.`
      );
    }
    if (state === 'approaching') {
      warnings.push(`${at}: review due ${due}, in ${days} day${days === 1 ? '' : 's'} — ${p.owner} owns it.`);
    }
  }

  if (criteria) {
    const { unclaimed, unknown } = coverage(criteria, register);
    for (const id of unknown) {
      problems.push(`POLICIES: a policy claims ${id}, which the control corpus does not mint — a policy naming a criterion that does not exist covers nothing`);
    }
    for (const id of unclaimed) {
      problems.push(
        `POLICIES: no policy claims ${id}. Every elected criterion is somebody's documented answer, and a criterion in ` +
          'none of them is the drift an auditor finds first — the set reads as complete and one criterion is in no document'
      );
    }
  }

  return { problems, warnings };
}

/** The set in one paragraph, for a README, a report or a card. */
export function summarise(register = POLICIES, now = new Date()) {
  const states = register.map((p) => stateOf(p, now).state);
  const adopted = states.filter((s) => s !== 'owed').length;
  const overdue = states.filter((s) => s === 'overdue').length;
  const enforced = register.filter((p) => (p.enforcedBy || []).length > 0).length;
  return (
    `${register.length} policies, ${adopted} adopted and ${register.length - adopted} owed` +
    `${overdue ? `, ${overdue} of them past their review date` : ''}. ` +
    `${enforced} have something in this repository already enforcing them, and ${gaps(register).length} have neither ` +
    `a document nor an enforcement. They are the documented answer for ${claimed(register).length} elected criteria.`
  );
}

const BROKEN = registerProblems();
if (BROKEN.length) throw new Error(`policy set: ${BROKEN.join('; ')}`);
