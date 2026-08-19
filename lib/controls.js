/**
 * The control corpus — SOC 2, ISO/IEC 27001, 42001, 23894, 42005 and 5338 in one closed
 * vocabulary.
 *
 * lib/requirements.js proves the shape and states the argument: a closed set is what lets
 * an id that does not resolve be **refused at the door** rather than stored and believed.
 * An advocate asked to name a control before the vocabulary exists will invent one, and a
 * fabricated `ISO42001.A.6.2.9` sitting beside the real `ISO42001.A.6.2.8` is two nodes in
 * the graph forever with nothing to tell them apart.
 *
 * This file is that discipline applied to compliance controls. What it is *not* is three
 * files. The tempting shape — `lib/soc2.js`, `lib/iso27001.js`, `lib/iso42001.js` — is how
 * the same control gets implemented three times and evidenced three times, because nothing
 * in it can say that SOC 2's CC6.1, 27001's A.8.3 and half a dozen 42001 controls are one
 * implementation with three names. So there is one corpus, and a record carries:
 *
 * - a **framework** — the standard the id belongs to, from a closed set of six;
 * - an **id within it** — `CC6.1`, `A.8.3`, `A.6.2.8`, `Clause8.3`;
 * - a **kind** — what auditing it even means, from a closed set of four;
 * - **crosswalk edges** to its counterparts elsewhere.
 *
 * ## Why the framework is in the id, not beside it
 *
 * `A.5.2` is *Information security roles and responsibilities* in 27001 and *AI system
 * impact assessment process* in 42001. Two standards, same local id, entirely different
 * control. A corpus that stored the framework as a field next to a bare `A.5.2` would have
 * one key for two things and would resolve whichever it read last — the same silent
 * failure lib/edits.js argues about with matching an epic by its title. So the id *is*
 * `ISO27001.A.5.2` and `ISO42001.A.5.2`, the framework token is the first segment, and
 * there is no way to write one down without saying which standard you meant.
 *
 * That is also what makes the corpus extend rather than fork, and it has now been extended
 * three times over: ISO/IEC 23894 risk-process ids, 42005 impact-assessment ids and 5338
 * life-cycle-process ids are three more tokens in {@link FRAMEWORKS} and three more tables
 * below — not three more modules with their own idea of what a control is, exactly as the
 * Climative requirements corpus carries `EN`, `AS` and `CDP` in one set.
 *
 * ## The crosswalk runs one way, and it is on the control
 *
 * Edges are declared on **controls, pointing at criteria** — never criteria at criteria.
 * A SOC 2 criterion is satisfied by N controls and one control satisfies M criteria across
 * frameworks, so the fan-out lives where the implementation lives. Written the other way
 * the corpus would have to keep a criterion's list in sync every time a control was added,
 * and the list would be wrong first and noticed last.
 *
 * The inverse is *computed*, not stored: {@link satisfiedBy} inverts the declared edges at
 * build time. So there is exactly one place an edge can be written and exactly one place it
 * can be wrong, and {@link corpus}'s build refuses a crosswalk target that does not
 * resolve — closed in both directions, not just on the way in.
 *
 * ## One standard, two kinds of thing — and the kind is on the record
 *
 * ISO/IEC 42001 asks for two entirely different things and they are audited two entirely
 * different ways. Its **management-system clauses 4 to 10** are audited *by record*: there
 * is a scope statement or there is not, a management review happened or it did not, and
 * what an auditor asks for is the document. Its **Annex A controls** are audited *by
 * evidence of the control operating*, over a period, on a sample. The same word for both is
 * how a programme comes to hold a filing cabinet and call it a control set.
 *
 * So `kind` is on the record and not on the framework — `'criterion'`, `'control'`,
 * `'clause'`, `'process'` — and a framework declares which kinds it may hold. `ISO42001`
 * holds two, and `ISO42001.Clause8.3` and `ISO42001.A.6.2.8` are both real ids in it.
 * {@link byKind} is what a gate asks when it wants every clause regardless of standard,
 * which is a question no id shape can answer on its own.
 *
 * The group keys keep them apart without a second field: an Annex A group is `6`, a clause
 * group is `Clause6`. `A.6.2.8` is *AI system life cycle* and `Clause6.2` is *Planning*, and
 * a groups map keyed on the bare number would have shown one name for both.
 *
 * ## A certifiable standard is cited by number, a guidance standard by name
 *
 * `ISO42001.Clause8.3` quotes the numbering of 42001, because that numbering is load-bearing
 * outside this repo: a certificate, a Statement of Applicability and an audit finding all
 * point at a clause *number*, and an id that did not match would be wrong in the one place
 * it is read by somebody who is not us.
 *
 * ISO/IEC 23894, 42005 and 5338 are **guidance**. Nobody is certified against them, nothing
 * anybody signs cites their numbering, and their value here is the *subject matter* — the
 * risk-process step, the impact-assessment topic, the life-cycle process. So their ids name
 * that subject instead: `ISO23894.Process.RiskIdentification`, `ISO42005.Impacts.Groups`,
 * `ISO5338.Technical.ContinuousValidation`. `certifiable: false` on the framework is what
 * says so, and a report that treats a guidance token as a conformance claim has a field to
 * check rather than a convention to remember.
 *
 * The same flag is load-bearing on the crosswalk: **a guidance record may not point at a
 * criterion**, and {@link corpus}'s build refuses one that does. `ISO5338.Technical.Verification`
 * reaches `SOC2.CC8.1` through `ISO42001.A.6.2.4`, in two hops, because the direct edge
 * would put a document nobody is audited against into the answer to *what satisfies this
 * criterion*. Guidance elaborates a requirement; a control satisfies a criterion; one hop,
 * one meaning, and the transitive answer is still there for anybody who wants it.
 *
 * This is the paraphrase rule below applied to the id rather than to the text. Minting
 * `ISO42005.Clause6.4.3` would be asserting a numbering nobody in this repo can check, and
 * a clause number that turns out to be somebody else's clause is the same failure as an
 * invented control — plausible, unfalsifiable from inside, and wrong exactly where an
 * auditor looks. Naming the subject cannot be wrong that way.
 *
 * ## Twelve criteria that nothing claims, on purpose
 *
 * {@link unclaimed}`('SOC2')` is not empty and is not meant to become empty. Twelve of the
 * 61 criteria have no inbound edge — `PI1.4`, `PI1.5` and ten privacy criteria. Output
 * delivery, stored-record integrity, consent mechanics, data-subject access and disclosure
 * records are ISO/IEC 27701 territory. That standard is not in this corpus, and a criterion
 * is better shown unclaimed than mapped to the nearest 27001 control that sounds similar.
 *
 * It was fifteen until the 42001 clauses landed. `CC1.2`, `CC3.3` and `CC5.2` — board
 * oversight, fraud risk and technology general controls — are not Annex A controls in either
 * ISO standard and never will be; they are management-system clause matter, and they are
 * claimed now by clause 5.1, clause 6.1.2 and clause 6.1.3 respectively rather than by
 * anything stretched to reach them.
 *
 * Inventing an edge to make a matrix look full is the one failure this file exists to
 * prevent, so the gap is pinned as an exact list in test/controls.mjs — where it fails
 * loudly the day a legitimate answer changes it, rather than drifting quietly.
 *
 * ## The text is a paraphrase, and the standard is the authority
 *
 * Every `definition` here is plain language for *what conformity looks like in this
 * system* — derived, for the SOC 2 side, from the 2022 revised points of focus rather than
 * invented, and for the ISO side from the control's stated purpose. None of it is the
 * normative text, none of it is quoted, and an auditor reads the standard. What the corpus
 * is for is joining a bead to a control and a control to its counterparts; it is not a copy
 * of three copyrighted documents and must never grow into one.
 *
 * ## This one ships with beadcause
 *
 * Unlike the requirements corpus it does not ride in another repo. The standard does not
 * change per install, so an absent corpus here is not a state to degrade into — it is a
 * broken build. There is no loader, no cache invalidation and no `corpusDir`: the tables
 * are below, {@link corpus} builds the indexes once, and every caller gets the same frozen
 * object.
 */

/**
 * What auditing a record even means, closed.
 *
 * - `criterion` — a SOC 2 trust services criterion, met by whatever controls the service
 *   organisation says meet it, and tested by the auditor against those.
 * - `control` — an Annex A control, audited by evidence that it *operated* over a period.
 * - `clause` — a management-system requirement, audited by the record it demands: the
 *   scope statement, the review minutes, the risk treatment plan.
 * - `process` — a life-cycle or risk process from a guidance standard, audited by nobody,
 *   because nothing certifies against guidance. It is here to be *cited*, not claimed.
 */
export const KINDS = ['criterion', 'control', 'clause', 'process'];

/**
 * The frameworks, closed.
 *
 * `token` is the first segment of every id in that framework and the only spelling
 * accepted. `groups` names the clause groupings each standard organises its controls
 * into — used for the category on a record, and for the headings any report over the
 * corpus wants without re-deriving them from the id shape.
 *
 * `kinds` is the closed set of record kinds the framework may hold, and it is a list
 * because ISO/IEC 42001 holds two: Annex A controls *and* management-system clauses, which
 * are audited in ways that have nothing to do with each other. `certifiable` says whether
 * anybody can be certified against the standard at all — false for the three guidance
 * documents, which is also why their ids name a subject instead of quoting a clause number.
 */
export const FRAMEWORKS = {
  SOC2: {
    token: 'SOC2',
    name: 'AICPA Trust Services Criteria',
    edition: 'TSC 2017 (with the 2022 revised points of focus)',
    kinds: ['criterion'],
    certifiable: true,
    groups: {
      CC: 'Common criteria (security)',
      A: 'Availability',
      C: 'Confidentiality',
      PI: 'Processing integrity',
      P: 'Privacy',
    },
  },
  ISO27001: {
    token: 'ISO27001',
    name: 'ISO/IEC 27001 Annex A',
    edition: '27001:2022',
    kinds: ['control'],
    certifiable: true,
    groups: {
      5: 'Organizational controls',
      6: 'People controls',
      7: 'Physical controls',
      8: 'Technological controls',
    },
  },
  ISO42001: {
    token: 'ISO42001',
    name: 'ISO/IEC 42001 — management-system clauses and Annex A',
    edition: '42001:2023',
    kinds: ['control', 'clause'],
    certifiable: true,
    // Annex A groups are the bare number; clause groups carry the word. `6` is the Annex A
    // life-cycle group and `Clause6` is Planning — two different things that would have
    // collided into one entry if the clause ids had been grouped by their number alone.
    groups: {
      2: 'Policies related to AI',
      3: 'Internal organization',
      4: 'Resources for AI systems',
      5: 'Assessing impacts of AI systems',
      6: 'AI system life cycle',
      7: 'Data for AI systems',
      8: 'Information for interested parties',
      9: 'Use of AI systems',
      10: 'Third-party and customer relationships',
      Clause4: 'Context of the organization',
      Clause5: 'Leadership',
      Clause6: 'Planning',
      Clause7: 'Support',
      Clause8: 'Operation',
      Clause9: 'Performance evaluation',
      Clause10: 'Improvement',
    },
  },
  ISO23894: {
    token: 'ISO23894',
    name: 'ISO/IEC 23894 — guidance on AI risk management',
    edition: '23894:2023',
    kinds: ['process'],
    certifiable: false,
    groups: {
      Principle: 'Principles of risk management',
      Framework: 'Risk management framework',
      Process: 'Risk management process',
    },
  },
  ISO42005: {
    token: 'ISO42005',
    name: 'ISO/IEC 42005 — AI system impact assessment',
    edition: '42005:2025',
    kinds: ['process'],
    certifiable: false,
    groups: {
      Process: 'Running the assessment',
      Scope: 'What the assessment describes',
      Impacts: 'What the assessment assesses',
      Documentation: 'What the assessment leaves behind',
    },
  },
  ISO5338: {
    token: 'ISO5338',
    name: 'ISO/IEC 5338 — AI system life cycle processes',
    edition: '5338:2023',
    kinds: ['process'],
    certifiable: false,
    groups: {
      Agreement: 'Agreement processes',
      Organizational: 'Organizational project-enabling processes',
      TechnicalManagement: 'Technical management processes',
      Technical: 'Technical processes',
    },
  },
};

/** The tokens, in the order a report should show them. */
export const FRAMEWORK_TOKENS = Object.keys(FRAMEWORKS);

/**
 * AICPA Trust Services Criteria, 2017, with the 2022 revised points of focus.
 *
 * `[id, title, what conformity looks like]`. CC1-CC5 are the COSO principles as the TSC
 * restates them; CC6-CC9 are the security criteria proper; A1, C1, PI1 and P1-P8 are the
 * additional categories, present in a report only if the service organisation elects them.
 * All 61 are here rather than only the security set, because which categories are in scope
 * is a decision (bc-4r10.4 owns it) and a corpus holding only the elected ones could not
 * represent the decision to elect one more.
 */
const SOC2_TSC = [
  // CC1 — Control environment (COSO principles 1-5).
  ['CC1.1', 'Commitment to integrity and ethical values', 'Conduct is set from the top and written down: a code of conduct people acknowledge, behaviour evaluated against it, and deviations addressed rather than noted.'],
  ['CC1.2', 'Board independence and oversight', 'A governing body independent of management oversees the development and performance of internal control, with the expertise to challenge it.'],
  ['CC1.3', 'Structures, reporting lines, authority and responsibility', 'Management establishes the structures and reporting lines, and assigns the authority and responsibility, needed to pursue the objectives.'],
  ['CC1.4', 'Commitment to competence', 'People are recruited, developed and retained against a stated competence requirement, and training is evidenced rather than assumed.'],
  ['CC1.5', 'Accountability for internal control', 'Individuals are held accountable for their internal-control responsibilities, through objectives, evaluation and consequence.'],
  // CC2 — Communication and information (COSO 13-15).
  ['CC2.1', 'Relevant, quality information', 'Information used to run and evaluate internal control is identified, captured and maintained at a quality that supports the decision it feeds.'],
  ['CC2.2', 'Internal communication', 'Objectives and internal-control responsibilities are communicated internally, and there is a channel for reporting a concern that bypasses the ordinary line.'],
  ['CC2.3', 'External communication', 'Matters affecting internal control are communicated to external parties — users, customers, regulators — including the commitments made and the incidents that touch them.'],
  // CC3 — Risk assessment (COSO 6-9).
  ['CC3.1', 'Objectives specified', 'Objectives are stated with enough clarity that the risks to them can be identified and assessed against something.'],
  ['CC3.2', 'Risks identified and analysed', 'Risks to the objectives are identified across the entity, analysed for likelihood and impact, and a basis for managing each is decided.'],
  ['CC3.3', 'Fraud risk considered', 'The potential for fraud — misappropriation, misreporting, override of controls — is considered explicitly when assessing risk.'],
  ['CC3.4', 'Significant change identified and assessed', 'Changes that could significantly affect internal control are identified and assessed before they take effect, not after.'],
  // CC4 — Monitoring activities (COSO 16-17).
  ['CC4.1', 'Ongoing and separate evaluations', 'Evaluations are selected, developed and performed to establish whether the components of internal control are present and functioning.'],
  ['CC4.2', 'Deficiencies evaluated and communicated', 'Deficiencies are evaluated and communicated to those responsible for corrective action, including senior management where the deficiency warrants it.'],
  // CC5 — Control activities (COSO 10-12).
  ['CC5.1', 'Control activities selected and developed', 'Control activities are selected and developed to mitigate the assessed risks to an acceptable level.'],
  ['CC5.2', 'Technology general controls', 'General control activities over technology are selected and developed to support the achievement of the objectives.'],
  ['CC5.3', 'Policies and procedures deployed', 'Control activities are deployed through policies that state what is expected and procedures that put the policy into action.'],
  // CC6 — Logical and physical access.
  ['CC6.1', 'Logical access security', 'Logical access to infrastructure, software and data is restricted by identified and authenticated identity, protecting the assets an inventory names, with cryptography where the asset warrants it.'],
  ['CC6.2', 'Registration and authorization of users', 'A credential exists only after the access it grants is authorised, and it is removed when the entitlement ends.'],
  ['CC6.3', 'Access by role, least privilege and segregation of duties', 'Access is granted, modified and removed on the basis of roles and responsibilities, least privilege, and segregation of incompatible duties, and is reviewed periodically.'],
  ['CC6.4', 'Physical access restricted', 'Physical access to facilities and to protected information assets is restricted to authorised personnel.'],
  ['CC6.5', 'Disposal of data and physical assets', 'Data and the physical media holding it are rendered unreadable before the asset leaves the boundary or is retired.'],
  ['CC6.6', 'Boundary protection', 'The boundary against threats from outside it is defined and protected, and access across it is restricted to what is authorised.'],
  ['CC6.7', 'Restricted transmission, movement and removal', 'Information moving in transit, onto removable media, or off-premises is restricted to authorised users and protected while it moves.'],
  ['CC6.8', 'Unauthorized or malicious software', 'The introduction of unauthorised or malicious software is prevented, or detected when prevention fails.'],
  // CC7 — System operations.
  ['CC7.1', 'Configuration and vulnerability detection', 'A configuration baseline exists, changes against it are detected, and newly introduced or newly disclosed vulnerabilities are found before an incident finds them.'],
  ['CC7.2', 'Monitoring for anomalies', 'Components are monitored for anomalies indicative of malicious acts, natural disasters and errors, against a defined idea of normal.'],
  ['CC7.3', 'Evaluation of security events', 'Security events are evaluated to determine whether they are incidents, and the determination is recorded.'],
  ['CC7.4', 'Incident response', 'Identified incidents are responded to through a defined programme — contained, remediated, communicated and closed.'],
  ['CC7.5', 'Recovery from incidents', 'Activities are identified, developed and implemented to recover from identified incidents, and what was learned changes something.'],
  // CC8 — Change management.
  ['CC8.1', 'Change management', 'Changes to infrastructure, data, software and procedures are authorised, designed, developed, configured, documented, tested, approved and implemented to meet the objectives.'],
  // CC9 — Risk mitigation.
  ['CC9.1', 'Business disruption risk mitigation', 'Risk mitigation activities are identified, selected and developed for the risks arising from potential business disruptions.'],
  ['CC9.2', 'Vendor and business partner risk', 'Vendors and business partners are assessed and managed for the risks they carry into the system, with commitments in the agreement and performance reviewed against it.'],
  // A1 — Availability.
  ['A1.1', 'Capacity management', 'Current processing capacity and use are maintained and evaluated against demand so that capacity is managed before it is exceeded.'],
  ['A1.2', 'Environmental protections, backup and recovery infrastructure', 'Environmental protections, software, data backup processes and recovery infrastructure are authorised, designed, implemented, operated and maintained to meet the availability objectives.'],
  ['A1.3', 'Recovery plan testing', 'Recovery plan procedures are tested to establish that they work, and the test result changes the plan where it did not.'],
  // C1 — Confidentiality.
  ['C1.1', 'Confidential information identified and maintained', 'Information designated confidential is identified as such and protected accordingly for as long as it is held.'],
  ['C1.2', 'Confidential information disposed of', 'Confidential information is disposed of when it reaches the end of its retention, to meet the confidentiality objectives.'],
  // PI1 — Processing integrity.
  ['PI1.1', 'Information about processing objectives', 'Information about the system, its processing and its outputs is made available to those who need it to carry out their responsibilities.'],
  ['PI1.2', 'Inputs complete and accurate', 'System inputs are complete and accurate, and the process that accepts them says so rather than assuming it.'],
  ['PI1.3', 'Processing complete, accurate and timely', 'Processing is complete, valid, accurate, timely and authorised, to meet the processing-integrity objectives.'],
  ['PI1.4', 'Outputs complete, accurate and timely', 'Outputs are complete, accurate and delivered when and to whom they were meant to be.'],
  ['PI1.5', 'Stored inputs and outputs', 'Inputs and outputs are stored completely, accurately and in a way that keeps them so.'],
  // P1-P8 — Privacy.
  ['P1.1', 'Notice about privacy practices', 'Notice is given about the privacy practices that apply, including what is collected and why, and it is available before or at collection.'],
  ['P2.1', 'Consent and choice', 'The choices available regarding personal information are communicated, and consent is obtained where required, before the information is used that way.'],
  ['P3.1', 'Collection consistent with objectives', 'Personal information is collected consistent with the objectives stated in the notice, and no more.'],
  ['P3.2', 'Explicit consent for sensitive information', 'Explicit consent is obtained for sensitive personal information, and the consent is documented.'],
  ['P4.1', 'Use consistent with objectives', 'Personal information is used only for the purposes stated in the notice and consented to.'],
  ['P4.2', 'Retention', 'Personal information is retained for no longer than the stated retention requires, and the requirement is written down.'],
  ['P4.3', 'Disposal', 'Personal information is disposed of securely once retention ends, including from backups and derived stores.'],
  ['P5.1', 'Access for data subjects', 'Data subjects are granted access to their personal information for review and, where appropriate, correction.'],
  ['P5.2', 'Correction and amendment', 'Corrections, amendments and deletions requested by a data subject are made, and the parties given the information are told.'],
  ['P6.1', 'Disclosure only with consent', 'Personal information is disclosed to third parties only for the purposes stated in the notice and with the consent of the data subject.'],
  ['P6.2', 'Record of authorized disclosures', 'A record of authorised disclosures is created and retained, complete and accurate.'],
  ['P6.3', 'Record of unauthorized disclosures', 'A record of detected unauthorised disclosures is created and retained.'],
  ['P6.4', 'Third-party compliance with commitments', 'Third parties given personal information commit to the same privacy commitments, and their compliance is assessed.'],
  ['P6.5', 'Notification of third-party unauthorized disclosure', 'A third party undertakes to notify of an actual or suspected unauthorised disclosure, and such notifications are acted on.'],
  ['P6.6', 'Breach notification', 'Affected data subjects, regulators and others are notified of a breach of personal information within the time the commitment or the law requires.'],
  ['P6.7', 'Accounting of disclosures', 'An accounting of the personal information held and the disclosures made is provided to a data subject on request.'],
  ['P7.1', 'Accuracy and completeness', 'Personal information is accurate and complete for the purposes it is used for, and stale information is corrected or removed.'],
  ['P8.1', 'Privacy complaints and monitoring', 'A process exists to receive, address, resolve and communicate a privacy complaint, and compliance with the privacy commitments is monitored.'],
];

/**
 * ISO/IEC 27001:2022 Annex A — 93 controls in four themes.
 *
 * `[id, title, what conformity looks like, crosswalk]`. The crosswalk is the fourth column
 * and it points at SOC 2 criteria: this is the control side of the edge, which is the only
 * side it is ever written on.
 *
 * The count is pinned in test/controls.mjs at 37 + 8 + 14 + 34. That is not decoration —
 * the 2022 revision consolidated 114 controls into 93, and a corpus that quietly held 114
 * would be validating ids against a withdrawn edition while every report over it looked
 * fine.
 */
const ISO27001_ANNEX_A = [
  // A.5 — Organizational controls (37).
  ['A.5.1', 'Policies for information security', 'A set of information security policies is defined, approved, published and reviewed at planned intervals.', ['SOC2.CC1.1', 'SOC2.CC5.3']],
  ['A.5.2', 'Information security roles and responsibilities', 'Security roles and responsibilities are defined and allocated to named people, not to a team in general.', ['SOC2.CC1.3', 'SOC2.CC1.5']],
  ['A.5.3', 'Segregation of duties', 'Conflicting duties and areas of responsibility are separated so that no single actor can complete a sensitive act unchecked.', ['SOC2.CC5.1', 'SOC2.CC6.3']],
  ['A.5.4', 'Management responsibilities', 'Management requires everyone to apply security in the way the policies and procedures state.', ['SOC2.CC1.1', 'SOC2.CC1.5']],
  ['A.5.5', 'Contact with authorities', 'Contact with the relevant authorities is established and maintained before it is needed.', ['SOC2.CC2.3', 'SOC2.CC7.4']],
  ['A.5.6', 'Contact with special interest groups', 'Contact with special interest groups, forums and professional associations is maintained as a source of what is coming.', ['SOC2.CC2.3', 'SOC2.CC7.1']],
  ['A.5.7', 'Threat intelligence', 'Information about threats is collected and analysed to produce something acted on rather than filed.', ['SOC2.CC3.2', 'SOC2.CC7.1']],
  ['A.5.8', 'Information security in project management', 'Security is integrated into project management, so a new project inherits the requirements rather than rediscovering them.', ['SOC2.CC3.4', 'SOC2.CC8.1']],
  ['A.5.9', 'Inventory of information and other associated assets', 'An inventory of information and associated assets exists, with an owner for each.', ['SOC2.CC6.1', 'SOC2.CC3.2']],
  ['A.5.10', 'Acceptable use of information and other associated assets', 'Rules for the acceptable use and handling of information and assets are identified, documented and implemented.', ['SOC2.CC5.3', 'SOC2.CC6.1']],
  ['A.5.11', 'Return of assets', 'Personnel and other interested parties return the assets they hold when their employment or agreement ends.', ['SOC2.CC6.5']],
  ['A.5.12', 'Classification of information', 'Information is classified by confidentiality, integrity, availability and the requirements of interested parties.', ['SOC2.C1.1', 'SOC2.CC6.1']],
  ['A.5.13', 'Labelling of information', 'Information is labelled according to its classification, so a handling rule can be applied without asking.', ['SOC2.C1.1']],
  ['A.5.14', 'Information transfer', 'Rules and agreements govern the transfer of information within the organisation and to any external party.', ['SOC2.CC6.7']],
  ['A.5.15', 'Access control', 'Rules for physical and logical access are established and implemented on the basis of business and security requirements.', ['SOC2.CC6.1', 'SOC2.CC6.3']],
  ['A.5.16', 'Identity management', 'The full life cycle of an identity is managed — created on authorisation, changed on change, removed on departure.', ['SOC2.CC6.2']],
  ['A.5.17', 'Authentication information', 'Allocation and management of authentication information is controlled, including how a secret is issued and how it is replaced.', ['SOC2.CC6.1']],
  ['A.5.18', 'Access rights', 'Access rights are provisioned, reviewed, modified and removed in line with the access control policy.', ['SOC2.CC6.2', 'SOC2.CC6.3']],
  ['A.5.19', 'Information security in supplier relationships', 'The risks a supplier relationship carries are identified and managed as part of the relationship.', ['SOC2.CC9.2']],
  ['A.5.20', 'Addressing information security within supplier agreements', 'Security requirements are established and agreed with each supplier in the agreement itself.', ['SOC2.CC9.2']],
  ['A.5.21', 'Managing information security in the ICT supply chain', 'Processes manage the security risks of the ICT products and services supply chain, not only the direct supplier.', ['SOC2.CC9.2']],
  ['A.5.22', 'Monitoring, review and change management of supplier services', 'Supplier service delivery is monitored, reviewed and changed under control rather than drifting.', ['SOC2.CC9.2', 'SOC2.CC4.1']],
  ['A.5.23', 'Information security for use of cloud services', 'Acquisition, use, management and exit of cloud services follow the security requirements.', ['SOC2.CC9.2', 'SOC2.CC6.1']],
  ['A.5.24', 'Incident management planning and preparation', 'Incident management is planned and prepared for by defining processes, roles and responsibilities in advance.', ['SOC2.CC7.4']],
  ['A.5.25', 'Assessment and decision on information security events', 'Security events are assessed and a decision recorded on whether each is a security incident.', ['SOC2.CC7.3']],
  ['A.5.26', 'Response to information security incidents', 'Incidents are responded to according to the documented procedures.', ['SOC2.CC7.4']],
  ['A.5.27', 'Learning from information security incidents', 'What an incident taught is used to strengthen the controls, and the change is traceable to the incident.', ['SOC2.CC7.5', 'SOC2.CC4.2']],
  ['A.5.28', 'Collection of evidence', 'Procedures exist for the identification, collection, acquisition and preservation of evidence about an incident.', ['SOC2.CC7.3']],
  ['A.5.29', 'Information security during disruption', 'Security is maintained at the level required during a disruption, not suspended to get service back.', ['SOC2.CC9.1', 'SOC2.A1.2']],
  ['A.5.30', 'ICT readiness for business continuity', 'ICT readiness is planned, implemented, maintained and tested against the continuity objectives.', ['SOC2.A1.2', 'SOC2.A1.3']],
  ['A.5.31', 'Legal, statutory, regulatory and contractual requirements', 'The legal, statutory, regulatory and contractual requirements are identified, documented and kept current.', ['SOC2.CC2.3', 'SOC2.P8.1']],
  ['A.5.32', 'Intellectual property rights', 'Procedures protect intellectual property rights, including the licensing of what the system depends on.', ['SOC2.CC1.1']],
  ['A.5.33', 'Protection of records', 'Records are protected from loss, destruction, falsification, unauthorised access and unauthorised release.', ['SOC2.C1.1', 'SOC2.P4.2']],
  ['A.5.34', 'Privacy and protection of PII', 'Requirements for privacy and the protection of personally identifiable information are identified and met.', ['SOC2.P1.1', 'SOC2.P4.1']],
  ['A.5.35', 'Independent review of information security', 'The approach to managing security is reviewed independently at planned intervals and when something significant changes.', ['SOC2.CC4.1']],
  ['A.5.36', 'Compliance with policies, rules and standards', 'Compliance with the security policy and standards is regularly reviewed, and non-compliance is dealt with.', ['SOC2.CC4.1', 'SOC2.CC5.3']],
  ['A.5.37', 'Documented operating procedures', 'Operating procedures for information processing facilities are documented and available to those who need them.', ['SOC2.CC5.3']],
  // A.6 — People controls (8).
  ['A.6.1', 'Screening', 'Background verification of candidates is carried out before employment, in proportion to what the role will reach.', ['SOC2.CC1.4']],
  ['A.6.2', 'Terms and conditions of employment', 'The employment agreement states the security responsibilities of the person and of the organisation.', ['SOC2.CC1.4', 'SOC2.CC1.5']],
  ['A.6.3', 'Information security awareness, education and training', 'Personnel receive awareness, education and training appropriate to their role, and it is refreshed.', ['SOC2.CC1.4', 'SOC2.CC2.2']],
  ['A.6.4', 'Disciplinary process', 'A disciplinary process is formalised and communicated, so a violation has a stated consequence.', ['SOC2.CC1.5']],
  ['A.6.5', 'Responsibilities after termination or change of employment', 'Security responsibilities that remain after a departure or a role change are defined, enforced and communicated.', ['SOC2.CC6.2']],
  ['A.6.6', 'Confidentiality or non-disclosure agreements', 'Confidentiality agreements reflecting the needs of the organisation are identified, documented, reviewed and signed.', ['SOC2.C1.1', 'SOC2.CC1.4']],
  ['A.6.7', 'Remote working', 'Security measures are implemented for working from anywhere other than the organisation premises.', ['SOC2.CC6.6', 'SOC2.CC6.7']],
  ['A.6.8', 'Information security event reporting', 'A mechanism exists for anyone to report an observed or suspected security event in a timely way.', ['SOC2.CC2.2', 'SOC2.CC7.3']],
  // A.7 — Physical controls (14).
  ['A.7.1', 'Physical security perimeters', 'Security perimeters are defined and used to protect areas holding information and associated assets.', ['SOC2.CC6.4']],
  ['A.7.2', 'Physical entry', 'Secure areas are protected by entry controls and access points appropriate to what is inside.', ['SOC2.CC6.4']],
  ['A.7.3', 'Securing offices, rooms and facilities', 'Physical security for offices, rooms and facilities is designed and implemented.', ['SOC2.CC6.4']],
  ['A.7.4', 'Physical security monitoring', 'Premises are monitored continuously for unauthorised physical access.', ['SOC2.CC6.4', 'SOC2.CC7.2']],
  ['A.7.5', 'Protecting against physical and environmental threats', 'Protection is designed and implemented against physical and environmental threats, natural and human.', ['SOC2.A1.2']],
  ['A.7.6', 'Working in secure areas', 'Security measures for working in a secure area are designed and implemented.', ['SOC2.CC6.4']],
  ['A.7.7', 'Clear desk and clear screen', 'Clear desk and clear screen rules are defined and enforced for papers, media and unattended screens.', ['SOC2.CC6.4', 'SOC2.C1.1']],
  ['A.7.8', 'Equipment siting and protection', 'Equipment is sited securely and protected from what its location exposes it to.', ['SOC2.A1.2']],
  ['A.7.9', 'Security of assets off-premises', 'Assets off the premises are protected in proportion to what they hold and where they go.', ['SOC2.CC6.4', 'SOC2.CC6.7']],
  ['A.7.10', 'Storage media', 'Storage media are managed through their life cycle — acquisition, use, transportation and disposal.', ['SOC2.CC6.7', 'SOC2.CC6.5']],
  ['A.7.11', 'Supporting utilities', 'Information processing facilities are protected from power failures and other disruptions of supporting utilities.', ['SOC2.A1.2']],
  ['A.7.12', 'Cabling security', 'Cables carrying power, data or supporting information services are protected from interception and damage.', ['SOC2.A1.2']],
  ['A.7.13', 'Equipment maintenance', 'Equipment is maintained correctly to ensure the availability, integrity and confidentiality of what it holds.', ['SOC2.A1.2']],
  ['A.7.14', 'Secure disposal or re-use of equipment', 'Equipment holding storage media is verified to have had its data removed before disposal or re-use.', ['SOC2.CC6.5', 'SOC2.C1.2']],
  // A.8 — Technological controls (34).
  ['A.8.1', 'User end point devices', 'Information on user end point devices is protected, including devices the organisation does not own.', ['SOC2.CC6.1', 'SOC2.CC6.8']],
  ['A.8.2', 'Privileged access rights', 'The allocation and use of privileged access rights is restricted and managed as a distinct thing.', ['SOC2.CC6.3']],
  ['A.8.3', 'Information access restriction', 'Access to information and other associated assets is restricted in accordance with the access control policy.', ['SOC2.CC6.1', 'SOC2.CC6.3']],
  ['A.8.4', 'Access to source code', 'Read and write access to source code, development tools and libraries is appropriately managed.', ['SOC2.CC6.1', 'SOC2.CC8.1']],
  ['A.8.5', 'Secure authentication', 'Secure authentication technologies and procedures are implemented, based on the access restrictions and the policy.', ['SOC2.CC6.1']],
  ['A.8.6', 'Capacity management', 'The use of resources is monitored and adjusted against current and expected capacity requirements.', ['SOC2.A1.1']],
  ['A.8.7', 'Protection against malware', 'Protection against malware is implemented and supported by the user awareness that makes it work.', ['SOC2.CC6.8']],
  ['A.8.8', 'Management of technical vulnerabilities', 'Technical vulnerabilities in systems in use are obtained, the exposure evaluated, and measures taken.', ['SOC2.CC7.1']],
  ['A.8.9', 'Configuration management', 'Configurations, including security configurations, are established, documented, implemented, monitored and reviewed.', ['SOC2.CC7.1', 'SOC2.CC8.1']],
  ['A.8.10', 'Information deletion', 'Information stored in systems, devices or any other storage media is deleted when it is no longer required.', ['SOC2.CC6.5', 'SOC2.P4.3']],
  ['A.8.11', 'Data masking', 'Data masking is used in line with the access control policy and the applicable legislation.', ['SOC2.C1.1', 'SOC2.P4.1']],
  ['A.8.12', 'Data leakage prevention', 'Data leakage prevention measures are applied to systems, networks and devices that process sensitive information.', ['SOC2.CC6.7', 'SOC2.C1.1']],
  ['A.8.13', 'Information backup', 'Backup copies of information, software and systems are maintained and regularly tested against the agreed policy.', ['SOC2.A1.2']],
  ['A.8.14', 'Redundancy of information processing facilities', 'Information processing facilities are implemented with the redundancy the availability requirements demand.', ['SOC2.A1.2']],
  ['A.8.15', 'Logging', 'Logs recording activities, exceptions, faults and other relevant events are produced, stored, protected and analysed.', ['SOC2.CC7.2']],
  ['A.8.16', 'Monitoring activities', 'Networks, systems and applications are monitored for anomalous behaviour, and appropriate actions taken.', ['SOC2.CC7.2']],
  ['A.8.17', 'Clock synchronization', 'The clocks of information processing systems are synchronised to approved time sources, so a log can be correlated.', ['SOC2.CC7.2']],
  ['A.8.18', 'Use of privileged utility programs', 'Utility programs capable of overriding system and application controls are restricted and tightly controlled.', ['SOC2.CC6.3', 'SOC2.CC6.8']],
  ['A.8.19', 'Installation of software on operational systems', 'Procedures and measures securely manage the installation of software on operational systems.', ['SOC2.CC6.8', 'SOC2.CC8.1']],
  ['A.8.20', 'Networks security', 'Networks and network devices are secured, managed and controlled to protect the information travelling over them.', ['SOC2.CC6.6']],
  ['A.8.21', 'Security of network services', 'Security mechanisms, service levels and requirements of network services are identified, implemented and monitored.', ['SOC2.CC6.6']],
  ['A.8.22', 'Segregation of networks', 'Groups of information services, users and systems are segregated in the organisation networks.', ['SOC2.CC6.6']],
  ['A.8.23', 'Web filtering', 'Access to external websites is managed to reduce exposure to malicious content.', ['SOC2.CC6.8']],
  ['A.8.24', 'Use of cryptography', 'Rules for the effective use of cryptography, including key management, are defined and implemented.', ['SOC2.CC6.1', 'SOC2.CC6.7']],
  ['A.8.25', 'Secure development life cycle', 'Rules for the secure development of software and systems are established and applied.', ['SOC2.CC8.1']],
  ['A.8.26', 'Application security requirements', 'Security requirements are identified, specified and approved when developing or acquiring an application.', ['SOC2.CC8.1', 'SOC2.PI1.2']],
  ['A.8.27', 'Secure system architecture and engineering principles', 'Principles for engineering secure systems are established, documented, maintained and applied.', ['SOC2.CC8.1', 'SOC2.CC6.1']],
  ['A.8.28', 'Secure coding', 'Secure coding principles are applied to software development.', ['SOC2.CC8.1']],
  ['A.8.29', 'Security testing in development and acceptance', 'Security testing processes are defined and implemented in the development life cycle.', ['SOC2.CC8.1', 'SOC2.CC7.1']],
  ['A.8.30', 'Outsourced development', 'Outsourced system development is directed, monitored and reviewed to the same requirements as work done inside.', ['SOC2.CC8.1', 'SOC2.CC9.2']],
  ['A.8.31', 'Separation of development, test and production environments', 'Development, test and production environments are separated and secured.', ['SOC2.CC8.1']],
  ['A.8.32', 'Change management', 'Changes to information processing facilities and information systems are subject to change management procedures.', ['SOC2.CC8.1']],
  ['A.8.33', 'Test information', 'Test information is appropriately selected, protected and managed, so production data does not leak into a test.', ['SOC2.CC8.1', 'SOC2.C1.1']],
  ['A.8.34', 'Protection of information systems during audit testing', 'Audit tests and other assurance activities on operational systems are planned and agreed between tester and management.', ['SOC2.CC4.1']],
];

/**
 * ISO/IEC 42001:2023 Annex A — 38 controls in nine groups.
 *
 * `[id, title, what conformity looks like, crosswalk]`, and this is the framework whose
 * edges are worth the most: a 42001 control routinely lands on a SOC 2 criterion *and* a
 * 27001 control, which is the whole claim of the epic — one implementation, three names.
 * `ISO42001.A.6.2.8` (event logs) is `ISO27001.A.8.15` is `SOC2.CC7.2`, and any programme
 * that does not know that will evidence it three times.
 *
 * Note the local ids collide with 27001 on purpose and harmlessly: `A.5.2` here is the AI
 * system impact assessment process, and `ISO27001.A.5.2` is roles and responsibilities.
 * The framework token in the id is what keeps them apart — see the file header.
 *
 * The management-system clauses 4-10 are a different kind of thing and are in their own
 * table below, under the same token. They are the *other* half of what 42001 asks for, and
 * conflating the two is the mistake this file separates `kind` to prevent.
 */
const ISO42001_ANNEX_A = [
  // A.2 — Policies related to AI (3).
  ['A.2.2', 'AI policy', 'An AI policy is documented and approved by management, and it says what the organisation will and will not do with AI.', ['SOC2.CC5.3', 'ISO27001.A.5.1']],
  ['A.2.3', 'Alignment with other organizational policies', 'The AI policy is aligned with the other policies it touches rather than contradicting them.', ['SOC2.CC5.3', 'ISO27001.A.5.1']],
  ['A.2.4', 'Review of the AI policy', 'The AI policy is reviewed at planned intervals or when something material changes.', ['SOC2.CC4.1', 'ISO27001.A.5.1']],
  // A.3 — Internal organization (2).
  ['A.3.2', 'AI roles and responsibilities', 'Roles and responsibilities for AI are defined and allocated to named people.', ['SOC2.CC1.3', 'SOC2.CC1.5', 'ISO27001.A.5.2']],
  ['A.3.3', 'Reporting of concerns', 'A route exists for reporting a concern about an AI system, and it reaches someone who can act.', ['SOC2.CC2.2', 'ISO27001.A.6.8']],
  // A.4 — Resources for AI systems (5).
  ['A.4.2', 'Resource documentation', 'The resources an AI system depends on are identified and documented, so what the system rests on is knowable.', ['SOC2.CC6.1', 'ISO27001.A.5.9']],
  ['A.4.3', 'Data resources', 'The data resources used by the AI system are documented, including what they are for and where they came from.', ['SOC2.PI1.2', 'ISO27001.A.5.9']],
  ['A.4.4', 'Tooling resources', 'The tools used to develop and run the AI system are documented and their effect on the system understood.', ['SOC2.CC6.1', 'ISO27001.A.5.9']],
  ['A.4.5', 'System and computing resources', 'The computing resources the AI system needs are determined and provided, and their sufficiency is reviewed.', ['SOC2.A1.1', 'ISO27001.A.8.6']],
  ['A.4.6', 'Human resources', 'The competences the AI system needs from the people running it are determined, provided and evidenced.', ['SOC2.CC1.4', 'ISO27001.A.6.3']],
  // A.5 — Assessing impacts of AI systems (4).
  ['A.5.2', 'AI system impact assessment process', 'A process exists for assessing the impact of an AI system, and it is applied before the system is deployed.', ['SOC2.CC3.1', 'SOC2.CC3.2']],
  ['A.5.3', 'Documentation of AI system impact assessments', 'Impact assessments are documented and retained, so the assessment can be reviewed rather than recalled.', ['SOC2.CC3.2', 'SOC2.CC4.2']],
  ['A.5.4', 'Impact on individuals or groups of individuals', 'The impact of the AI system on individuals and on identifiable groups is assessed, including who is affected without asking to be.', ['SOC2.CC3.2', 'SOC2.P1.1']],
  ['A.5.5', 'Societal impacts of AI systems', 'The broader societal impacts of the AI system are assessed and recorded.', ['SOC2.CC3.2']],
  // A.6 — AI system life cycle (9).
  ['A.6.1.2', 'Objectives for responsible development', 'Objectives for the responsible development of AI systems are stated, so a design decision has something to be measured against.', ['SOC2.CC3.1']],
  ['A.6.1.3', 'Processes for responsible design and development', 'Processes for the responsible design and development of AI systems are defined and followed.', ['SOC2.CC5.1', 'SOC2.CC8.1', 'ISO27001.A.8.25']],
  ['A.6.2.2', 'AI system requirements and specification', 'The requirements the AI system must meet are specified, including the ones that come from the impact assessment.', ['SOC2.PI1.1', 'ISO27001.A.8.26']],
  ['A.6.2.3', 'Documentation of AI system design and development', 'The design and development of the AI system are documented to the level that lets someone else understand what was built.', ['SOC2.CC8.1', 'ISO27001.A.8.27']],
  ['A.6.2.4', 'AI system verification and validation', 'The AI system is verified and validated against its requirements before it is relied on, and the result is recorded.', ['SOC2.PI1.3', 'ISO27001.A.8.29']],
  ['A.6.2.5', 'AI system deployment', 'Deployment follows a defined process with the checks and approvals the requirements call for.', ['SOC2.CC8.1', 'ISO27001.A.8.32']],
  ['A.6.2.6', 'AI system operation and monitoring', 'The AI system is monitored in operation against what it was validated to do, and drift from it is detected.', ['SOC2.CC7.2', 'ISO27001.A.8.16']],
  ['A.6.2.7', 'AI system technical documentation', 'Technical documentation of the AI system is produced and kept current for those who need it.', ['SOC2.CC2.1', 'ISO27001.A.5.37']],
  ['A.6.2.8', 'AI system recording of event logs', 'The AI system records event logs sufficient to reconstruct what it did and why.', ['SOC2.CC7.2', 'ISO27001.A.8.15']],
  // A.7 — Data for AI systems (5).
  ['A.7.2', 'Data for development and enhancement', 'The data used to develop and enhance the AI system is defined, and its suitability for that use is established.', ['SOC2.PI1.2', 'ISO27001.A.8.33']],
  ['A.7.3', 'Acquisition of data', 'Data is acquired under a process that establishes the right to use it for the purpose it will be used for.', ['SOC2.PI1.2', 'SOC2.P3.1']],
  ['A.7.4', 'Quality of data for AI systems', 'The quality the data must have for the AI system is defined and checked, not assumed from its source.', ['SOC2.PI1.2', 'SOC2.P7.1']],
  ['A.7.5', 'Data provenance', 'The provenance of the data is recorded and traceable, so a question about an output can be traced to an input.', ['SOC2.PI1.2', 'SOC2.P3.1']],
  ['A.7.6', 'Data preparation', 'Data preparation is defined and documented, so the transformation between raw data and what the system saw is known.', ['SOC2.PI1.3']],
  // A.8 — Information for interested parties (4).
  ['A.8.2', 'System documentation and information for users', 'Users are given the information they need to use the AI system as intended, including its limits.', ['SOC2.CC2.3', 'SOC2.PI1.1']],
  ['A.8.3', 'External reporting', 'A means exists for external interested parties to report and to receive a response.', ['SOC2.CC2.3']],
  ['A.8.4', 'Communication of incidents', 'Incidents involving the AI system are communicated to those affected within the time the commitments require.', ['SOC2.CC7.4', 'SOC2.P6.6', 'ISO27001.A.5.26']],
  ['A.8.5', 'Information for interested parties', 'Interested parties are given the information about the AI system they are entitled to.', ['SOC2.CC2.3']],
  // A.9 — Use of AI systems (3).
  ['A.9.2', 'Processes for responsible use', 'Processes for the responsible use of AI systems are defined and applied by those who use them.', ['SOC2.CC5.1', 'ISO27001.A.5.10']],
  ['A.9.3', 'Objectives for responsible use', 'Objectives for the responsible use of the AI system are stated and known to its users.', ['SOC2.CC3.1']],
  ['A.9.4', 'Intended use of the AI system', 'The intended use of the AI system is defined, and use outside it is out of bounds rather than undiscussed.', ['SOC2.CC5.3', 'ISO27001.A.5.10']],
  // A.10 — Third-party and customer relationships (3).
  ['A.10.2', 'Allocating responsibilities', 'Responsibilities are allocated between the organisation, its partners, suppliers, customers and third parties.', ['SOC2.CC9.2', 'ISO27001.A.5.19']],
  ['A.10.3', 'Suppliers', 'Suppliers to the AI system are managed against the requirements the organisation itself is held to.', ['SOC2.CC9.2', 'ISO27001.A.5.20']],
  ['A.10.4', 'Customers', 'Customer obligations and expectations regarding the AI system are understood and met.', ['SOC2.CC2.3', 'SOC2.CC9.2']],
];

/**
 * ISO/IEC 42001:2023 clauses 4 to 10 — the management system itself, 32 requirements.
 *
 * `[id, title, what conformity looks like, crosswalk]`, ids shaped `Clause8.3`. These are
 * the requirements a certificate is actually issued against: Annex A is a reference set you
 * select *from*, and clause 6.1.3 is the requirement that you select from it and say why.
 * A programme holding Annex A alone has the controls and none of the system that decides
 * which of them apply.
 *
 * Minted at the level the requirement sits at, which is not always the level the clause
 * numbering stops at — `Clause6.1.2` rather than `Clause6.1`, because 6.1 says nothing on
 * its own that 6.1.1 to 6.1.4 do not say better, and an id that resolves to a heading is an
 * id nobody can evidence.
 *
 * These are also what closes three of the fifteen SOC 2 gaps. `CC1.2` (board oversight) is
 * clause 5.1 and the management review, `CC3.3` (fraud risk) is the risk assessment clause
 * that has to consider misuse, and `CC5.2` (technology general controls) is clause 6.1.3
 * selecting controls and 8.1 operating them. None of the three is reachable from Annex A,
 * which is exactly why the gap list named them.
 */
const ISO42001_CLAUSES = [
  // Clause 4 — Context of the organization (4).
  ['Clause4.1', 'Understanding the organization and its context', 'The external and internal issues bearing on the AI management system are determined, including which role the organisation plays for each AI system it touches — developer, provider or user.', ['SOC2.CC3.1', 'SOC2.CC3.2']],
  ['Clause4.2', 'Understanding the needs and expectations of interested parties', 'The interested parties relevant to the AI management system are identified, along with what each of them requires of it.', ['SOC2.CC2.3', 'ISO42001.A.8.5']],
  ['Clause4.3', 'Determining the scope of the AI management system', 'The boundaries and applicability of the AI management system are determined against those issues and requirements, and the scope is kept as documented information.', ['SOC2.CC3.1']],
  ['Clause4.4', 'AI management system', 'The AI management system is established, implemented, maintained and continually improved as a set of interacting processes, rather than assembled as a folder of documents before an audit.', ['SOC2.CC5.3']],
  // Clause 5 — Leadership (3).
  ['Clause5.1', 'Leadership and commitment', 'Top management demonstrates leadership by making the AI policy and objectives compatible with the direction of the organisation, providing the resources, and holding the system to account for its results.', ['SOC2.CC1.2', 'SOC2.CC1.5']],
  ['Clause5.2', 'AI policy', 'An AI policy is established that suits the purpose of the organisation, frames the AI objectives, and commits to satisfying the applicable requirements and to continual improvement.', ['SOC2.CC5.3', 'ISO42001.A.2.2']],
  ['Clause5.3', 'Roles, responsibilities and authorities', 'Top management assigns and communicates the responsibilities and authorities the AI management system needs, including who reports on its performance and to whom.', ['SOC2.CC1.2', 'SOC2.CC1.3', 'ISO42001.A.3.2']],
  // Clause 6 — Planning (6).
  ['Clause6.1.1', 'Actions to address risks and opportunities', 'The issues and requirements from clause 4 are turned into determined risks and opportunities, into planned actions, and into a stated way of evaluating whether those actions worked.', ['SOC2.CC3.2']],
  ['Clause6.1.2', 'AI risk assessment', 'A defined process establishes and maintains AI risk criteria, identifies risks, analyses them and evaluates them against those criteria — including the risk of misuse and of the controls being overridden — and is repeatable enough to give consistent results.', ['SOC2.CC3.2', 'SOC2.CC3.3']],
  ['Clause6.1.3', 'AI risk treatment', 'Treatment options are selected for the assessed risks, the controls needed to implement them are determined and compared against Annex A, and a Statement of Applicability records what was included, what was excluded and why.', ['SOC2.CC5.1', 'SOC2.CC5.2']],
  ['Clause6.1.4', 'AI system impact assessment', 'A process determines the potential consequences of the AI system for individuals, for groups of individuals and for societies, and it is applied to each AI system in scope.', ['SOC2.CC3.2', 'ISO42001.A.5.2']],
  ['Clause6.2', 'AI objectives and planning to achieve them', 'AI objectives are established at the relevant functions and levels, measurable where practicable, with what will be done, by whom, by when, and how the result will be evaluated.', ['SOC2.CC3.1']],
  ['Clause6.3', 'Planning of changes', 'Changes to the AI management system are planned rather than merely made, so a change arrives carrying its purpose and its consequences.', ['SOC2.CC3.4', 'SOC2.CC8.1']],
  // Clause 7 — Support (7).
  ['Clause7.1', 'Resources', 'The resources needed to establish, implement, maintain and continually improve the AI management system are determined and provided.', ['SOC2.CC1.3', 'ISO42001.A.4.2']],
  ['Clause7.2', 'Competence', 'The competence needed by the people whose work affects AI performance is determined and provided, and where action was taken to acquire it, the effectiveness of that action is evaluated.', ['SOC2.CC1.4', 'ISO27001.A.6.3']],
  ['Clause7.3', 'Awareness', 'People doing work under the control of the organisation are aware of the AI policy, of how they contribute to the system, and of what failing to conform would mean.', ['SOC2.CC2.2', 'ISO27001.A.6.3']],
  ['Clause7.4', 'Communication', 'What to communicate about the AI management system, when, to whom and by whom is determined rather than left to whoever happens to notice.', ['SOC2.CC2.2', 'SOC2.CC2.3']],
  ['Clause7.5.1', 'Documented information', 'The AI management system includes the documented information this document requires, plus whatever else the organisation determines is necessary for the system to be effective.', ['SOC2.CC2.1']],
  ['Clause7.5.2', 'Creating and updating documented information', 'Documented information is identified, described and formatted appropriately, and reviewed for suitability and adequacy before it is approved.', ['SOC2.CC2.1', 'ISO27001.A.5.37']],
  ['Clause7.5.3', 'Control of documented information', 'Documented information is available where it is needed and protected where it matters, with distribution, access, retrieval, retention and disposal controlled.', ['SOC2.CC2.1', 'ISO27001.A.5.33']],
  // Clause 8 — Operation (4).
  ['Clause8.1', 'Operational planning and control', 'The processes needed to meet the requirements and carry out the planned actions are planned, implemented and controlled, with criteria stated for them and evidence kept that they were followed.', ['SOC2.CC5.2', 'SOC2.CC5.3']],
  ['Clause8.2', 'AI risk assessment', 'The AI risk assessment is performed at planned intervals and whenever a significant change is proposed or occurs, and its results are retained.', ['SOC2.CC3.2', 'SOC2.CC3.4']],
  ['Clause8.3', 'AI risk treatment', 'The AI risk treatment plan is implemented, and what implementing it produced is retained as documented information rather than asserted afterwards.', ['SOC2.CC5.1', 'SOC2.CC9.1']],
  ['Clause8.4', 'AI system impact assessment', 'Impact assessments are performed at planned intervals and whenever a change makes the previous one out of date, and their results are retained.', ['SOC2.CC3.2', 'ISO42001.A.5.3']],
  // Clause 9 — Performance evaluation (6).
  ['Clause9.1', 'Monitoring, measurement, analysis and evaluation', 'What needs monitoring and measuring is determined, along with the methods, when it happens and who evaluates the results, and the results are retained as evidence.', ['SOC2.CC4.1', 'SOC2.CC7.2']],
  ['Clause9.2.1', 'Internal audit', 'Internal audits establish at planned intervals whether the AI management system conforms to the requirements of the organisation and of this document, and whether it is effectively implemented.', ['SOC2.CC4.1', 'ISO27001.A.5.35']],
  ['Clause9.2.2', 'Internal audit programme', 'An audit programme is planned, established, implemented and maintained, with frequency, methods, responsibilities and reporting defined, and auditors selected so that nobody audits their own work.', ['SOC2.CC4.1', 'SOC2.CC1.2']],
  ['Clause9.3.1', 'Management review', 'Top management reviews the AI management system at planned intervals to establish that it remains suitable, adequate and effective.', ['SOC2.CC1.2', 'SOC2.CC4.1']],
  ['Clause9.3.2', 'Management review inputs', 'The review takes in the status of previous actions, changes in the issues and expectations, the performance of the system, and the results of risk assessment, risk treatment and impact assessment.', ['SOC2.CC1.2', 'SOC2.CC4.2']],
  ['Clause9.3.3', 'Management review results', 'The review produces decisions on continual improvement and on any change the system needs, and those results are retained as documented information.', ['SOC2.CC4.1', 'SOC2.CC4.2']],
  // Clause 10 — Improvement (2).
  ['Clause10.1', 'Continual improvement', 'The suitability, adequacy and effectiveness of the AI management system are continually improved — a state to be evidenced over time, not an intention to be stated once.', ['SOC2.CC4.2', 'SOC2.CC7.5']],
  ['Clause10.2', 'Nonconformity and corrective action', 'A nonconformity is reacted to, its causes are evaluated so that it does not recur, corrective action is taken, its effectiveness is reviewed, and the whole of that is retained as documented information.', ['SOC2.CC4.2', 'SOC2.CC7.4']],
];

/**
 * ISO/IEC 23894:2023 — guidance on AI risk management, 22 named processes.
 *
 * The standard follows ISO 31000: principles, framework, process. That is what is named
 * here, and the crosswalk is where the value is — 42001 clause 6.1.2 says *have* a risk
 * assessment process and 23894 says what a defensible one contains, so
 * {@link satisfiedBy}`('ISO42001.Clause6.1.2')` answers with the steps rather than with a
 * restatement of the requirement.
 *
 * Named rather than numbered, for the reason in the file header: nobody is certified to
 * 23894, so no signed document points at a clause number in it.
 */
const ISO23894_RISK = [
  // Principles (8).
  ['Principle.Integrated', 'Risk management is integrated', 'AI risk management is part of how the organisation is run, rather than an activity conducted beside it and reported on separately.', ['ISO42001.Clause4.4']],
  ['Principle.Structured', 'Structured and comprehensive', 'A structured and comprehensive approach gives results that are consistent and comparable, instead of a different answer depending on who ran it.', ['ISO42001.Clause6.1.2']],
  ['Principle.Customized', 'Customized to the context', 'The framework and the process are proportionate to the organisation, its context and the AI systems actually being run.', ['ISO42001.Clause4.1']],
  ['Principle.Inclusive', 'Inclusive of interested parties', 'Interested parties are involved in a way that lets their knowledge, views and perceptions actually be taken into account.', ['ISO42001.Clause4.2']],
  ['Principle.Dynamic', 'Dynamic as the context changes', 'Risks appear, change and disappear as the context changes, and the process anticipates and responds to that instead of snapshotting once a year.', ['ISO42001.Clause8.2']],
  ['Principle.BestAvailableInformation', 'Uses the best available information', 'Risk decisions rest on the best information available, with its limitations and its uncertainty made explicit rather than assumed away.', ['ISO42001.Clause7.5.1']],
  ['Principle.HumanAndCulturalFactors', 'Human and cultural factors', 'Human behaviour and culture influence AI risk at every level and are considered as part of it, not treated as noise around a technical assessment.', ['ISO42001.A.5.4']],
  ['Principle.ContinualImprovement', 'Continual improvement', 'The risk management approach itself is improved through learning and experience, and not only the risks it found.', ['ISO42001.Clause10.1']],
  // Framework (6).
  ['Framework.LeadershipAndCommitment', 'Leadership and commitment', 'Top management is accountable for managing AI risk and demonstrates it through the mandate the framework is given and the resources behind it.', ['ISO42001.Clause5.1']],
  ['Framework.Integration', 'Integration into the organization', 'Risk management is integrated into the governance, structure and processes of the organisation rather than run as a parallel exercise.', ['ISO42001.Clause4.4']],
  ['Framework.Design', 'Design of the framework', 'Designing the framework means understanding the context, articulating commitment, assigning roles and authorities, allocating resources and establishing communication.', ['ISO42001.Clause6.1.1']],
  ['Framework.Implementation', 'Implementation of the framework', 'The framework is implemented through a plan that states what is done, by whom, when, and how the decisions in it get made.', ['ISO42001.Clause6.2']],
  ['Framework.Evaluation', 'Evaluation of the framework', 'The framework is periodically measured against its purpose and its plans, to establish whether it remains suitable.', ['ISO42001.Clause9.1']],
  ['Framework.Improvement', 'Improvement of the framework', 'The framework is continually adapted and improved as the organisation and the AI systems it runs change.', ['ISO42001.Clause10.1']],
  // Process (8).
  ['Process.CommunicationAndConsultation', 'Communication and consultation', 'Communication and consultation with interested parties happen at every stage of the process, so that risk is never assessed only from inside.', ['ISO42001.Clause7.4']],
  ['Process.ScopeContextCriteria', 'Scope, context and criteria', 'The scope, the external and internal context and the risk criteria are defined before any risk is identified against them.', ['ISO42001.Clause6.1.2']],
  ['Process.RiskIdentification', 'Risk identification', 'Risks to and from the AI system are found, recognised and described — including risks to individuals and to society, and not only risks to the organisation.', ['ISO42001.Clause6.1.2']],
  ['Process.RiskAnalysis', 'Risk analysis', 'The nature of each risk, its sources, its consequences and their likelihood are understood, with the uncertainty in that understanding stated.', ['ISO42001.Clause6.1.2']],
  ['Process.RiskEvaluation', 'Risk evaluation', 'The result of the analysis is compared with the risk criteria, to decide whether the risk is acceptable and what happens next.', ['ISO42001.Clause6.1.2']],
  ['Process.RiskTreatment', 'Risk treatment', 'Treatment options are selected and implemented, and the residual risk left after them is decided on and accepted by somebody rather than ignored.', ['ISO42001.Clause6.1.3']],
  ['Process.MonitoringAndReview', 'Monitoring and review', 'Risks, controls and the process itself are monitored and reviewed on a stated cadence and whenever something changes.', ['ISO42001.Clause9.1']],
  ['Process.RecordingAndReporting', 'Recording and reporting', 'The process and its outcomes are recorded and reported, which is what makes a risk decision reviewable a year later by somebody who was not there.', ['ISO42001.Clause7.5.3']],
];

/**
 * ISO/IEC 42005:2025 — AI system impact assessment, 16 named topics.
 *
 * 42001 asks for an impact assessment in clause 6.1.4, requires it performed in 8.4 and
 * controls it in `A.5.2` to `A.5.5`; none of those says what has to be *in* one. This is
 * that, indexed by subject: how the assessment is run, what it describes, what it assesses
 * and what it leaves behind.
 *
 * Named rather than numbered — see the file header. The four groups are beadcause reading
 * the standard, not a quotation of its structure, and they are here so a report can group
 * sixteen entries into something a person can hold.
 */
const ISO42005_IMPACT = [
  // Running the assessment (5).
  ['Process.Threshold', 'When an assessment is required', 'Which AI systems need an impact assessment at all is decided by stated criteria, rather than argued case by case each time.', ['ISO42001.Clause6.1.4']],
  ['Process.Timing', 'When in the life cycle it happens', 'The assessment is performed early enough that its findings can still change the system, and not as a record made after deployment.', ['ISO42001.Clause8.4', 'ISO42001.A.5.2']],
  ['Process.Responsibilities', 'Who performs, reviews and approves', 'Who performs an impact assessment, who reviews it and who approves it are assigned, and the assessor is not the only person who reads it.', ['ISO42001.Clause5.3']],
  ['Process.Reassessment', 'What triggers a fresh assessment', 'A change to the system, to its data or to its deployment context triggers a fresh assessment, rather than an annotation on the old one.', ['ISO42001.Clause8.4']],
  ['Process.IntoRiskManagement', 'Feeding the risk process', 'What the impact assessment found feeds the risk assessment and the treatment plan, instead of being filed alongside them.', ['ISO42001.Clause6.1.2', 'ISO42001.A.5.2']],
  // What the assessment describes (4).
  ['Scope.IntendedUse', 'Intended use and purpose', 'The intended use of the AI system and the purpose it was built for are described precisely enough that use outside them is recognisable as such.', ['ISO42001.A.9.4']],
  ['Scope.ForeseeableMisuse', 'Reasonably foreseeable misuse', 'Reasonably foreseeable misuse and unintended use are described alongside the intended use, because only one of the three gets designed for by default.', ['ISO42001.A.5.4']],
  ['Scope.DeploymentContext', 'Deployment context', 'Where and to whom the AI system is deployed is described, including the geography, the sector and the population it will act on.', ['ISO42001.A.5.4']],
  ['Scope.DataAndModel', 'Data and models relied on', 'The data and the models the system depends on are described to the level that lets an observed impact be traced back to a choice about them.', ['ISO42001.A.7.5']],
  // What the assessment assesses (4).
  ['Impacts.Individuals', 'Impacts on individuals', 'The potential consequences for individuals are assessed, including for those who are subject to the system without ever having chosen to be.', ['ISO42001.A.5.4']],
  ['Impacts.Groups', 'Impacts on groups of individuals', 'The potential consequences for identifiable groups are assessed, including differential effects that a whole-population average would hide.', ['ISO42001.A.5.4']],
  ['Impacts.Society', 'Societal impacts', 'The broader consequences for society are assessed and recorded, rather than treated as outside the boundary of the system.', ['ISO42001.A.5.5']],
  ['Impacts.Benefits', 'Benefits, recorded alongside the harms', 'The benefits the AI system is expected to produce are recorded next to the harms, because a treatment decision that sees only one of them is not a decision.', ['ISO42001.A.5.3']],
  // What the assessment leaves behind (3).
  ['Documentation.Record', 'The assessment as a record', 'Each impact assessment is documented and retained, carrying what was assessed, by whom, when, and on what basis it concluded what it did.', ['ISO42001.A.5.3']],
  ['Documentation.Approval', 'Approval of the assessment', 'The assessment carries an approval by somebody with the authority to accept what it found and the consequences of proceeding.', ['ISO42001.Clause5.3']],
  ['Documentation.Availability', 'Availability to interested parties', 'The assessment, or as much of it as is appropriate, is made available to the interested parties who are entitled to see it.', ['ISO42001.A.8.5']],
];

/**
 * ISO/IEC 5338:2023 — AI system life cycle processes, 31 named processes.
 *
 * 5338 takes the ISO/IEC/IEEE 12207 and 15288 process framework and says what each process
 * means when the system learns. Four groups, and the one entry that is not in 15288 is
 * `Technical.ContinuousValidation` — the AI-specific one, and the reason this standard
 * exists at all: a deterministic system that passed validation stays passed, and a learned
 * one can stop being valid without a single line of it changing.
 *
 * Named rather than numbered — see the file header.
 */
const ISO5338_LIFECYCLE = [
  // Agreement processes (2).
  ['Agreement.Acquisition', 'Acquisition', 'Obtaining an AI system, component or service from a supplier under terms that state what it must do and how that will be established.', ['ISO42001.A.10.3']],
  ['Agreement.Supply', 'Supply', 'Providing an AI system, component or service to an acquirer against agreed requirements, including what is said about its limits.', ['ISO42001.A.10.4']],
  // Organizational project-enabling processes (6).
  ['Organizational.LifeCycleModelManagement', 'Life cycle model management', 'Defining and maintaining the life cycle models, policies and procedures the organisation uses for the AI systems it builds.', ['ISO42001.A.6.1.3']],
  ['Organizational.InfrastructureManagement', 'Infrastructure management', 'Providing and maintaining the infrastructure an AI project needs, including the compute a training or serving workload actually requires.', ['ISO42001.A.4.5']],
  ['Organizational.PortfolioManagement', 'Portfolio management', 'Starting, sustaining and stopping AI projects against the objectives, so that a project which stopped earning its place is stopped.', ['ISO42001.Clause6.2']],
  ['Organizational.HumanResourceManagement', 'Human resource management', 'Providing the people with the skills an AI project needs, and keeping those skills current as the systems change.', ['ISO42001.A.4.6']],
  ['Organizational.QualityManagement', 'Quality management', 'Establishing what quality means for the organisation and its AI systems, and the policies that hold it there.', ['ISO42001.Clause9.1']],
  ['Organizational.KnowledgeManagement', 'Knowledge management', 'Capturing and making reusable the knowledge, assets and lessons an AI project produces, including the ones that came out of a failure.', ['ISO42001.A.6.2.7']],
  // Technical management processes (8).
  ['TechnicalManagement.ProjectPlanning', 'Project planning', 'Producing and maintaining the plans for an AI project — what will be built, by whom, against what schedule and to what definition of done.', ['ISO42001.A.6.1.3']],
  ['TechnicalManagement.ProjectAssessmentAndControl', 'Project assessment and control', 'Assessing whether the project is proceeding as planned, and taking control action when it is not.', ['ISO42001.Clause9.1']],
  ['TechnicalManagement.DecisionManagement', 'Decision management', 'Framing and recording the decisions an AI project makes, so that a later question about why can be answered with something other than recollection.', ['ISO42001.A.6.2.3']],
  ['TechnicalManagement.RiskManagement', 'Risk management', 'Identifying, analysing, treating and monitoring risk continuously through the life cycle of the AI system rather than at its gates.', ['ISO42001.Clause8.2']],
  ['TechnicalManagement.ConfigurationManagement', 'Configuration management', 'Managing the items that make up the AI system — code, data, models and configuration — so that a given version can be reconstructed.', ['ISO27001.A.8.9']],
  ['TechnicalManagement.InformationManagement', 'Information management', 'Generating, obtaining, maintaining and distributing the information the project needs, to the people entitled to it.', ['ISO42001.Clause7.5.3']],
  ['TechnicalManagement.Measurement', 'Measurement', 'Collecting and analysing the measures that say whether the AI system is doing what it was meant to do, in operation and not only in test.', ['ISO42001.Clause9.1']],
  ['TechnicalManagement.QualityAssurance', 'Quality assurance', 'Assuring that the processes and their outputs meet the quality requirements, independently of the people who produced them.', ['ISO42001.Clause9.2.1']],
  // Technical processes (15).
  ['Technical.BusinessOrMissionAnalysis', 'Business or mission analysis', 'Establishing the problem the AI system is meant to solve, and whether an AI system is the right answer to it at all.', ['ISO42001.A.6.1.2']],
  ['Technical.StakeholderNeedsAndRequirements', 'Stakeholder needs and requirements definition', 'Turning what stakeholders need into stated requirements, including the requirements the impact assessment produced.', ['ISO42001.A.6.2.2']],
  ['Technical.SystemRequirementsDefinition', 'System requirements definition', 'Transforming stakeholder requirements into a technical statement of what the AI system must do and how well it must do it.', ['ISO42001.A.6.2.2']],
  ['Technical.ArchitectureDefinition', 'Architecture definition', 'Generating the architecture of the AI system, and the rationale that says why it is that one.', ['ISO42001.A.6.2.3', 'ISO27001.A.8.27']],
  ['Technical.DesignDefinition', 'Design definition', 'Providing design detail sufficient to implement the AI system, including the data and model choices that determine how it behaves.', ['ISO42001.A.6.2.3']],
  ['Technical.SystemAnalysis', 'System analysis', 'Analysing the AI system to support a decision, including the trade-offs a model choice forces between accuracy, cost and explainability.', ['ISO42001.A.6.2.3']],
  ['Technical.Implementation', 'Implementation', 'Realising the AI system, which for a learned component includes acquiring and preparing the data and training the model.', ['ISO42001.A.7.6']],
  ['Technical.Integration', 'Integration', 'Assembling the AI system from its components so that the whole behaves as specified, which a learned component makes harder rather than easier.', ['ISO42001.A.6.2.4']],
  ['Technical.Verification', 'Verification', 'Establishing that the AI system meets its specified requirements, and recording what was established rather than that it was.', ['ISO42001.A.6.2.4', 'ISO27001.A.8.29']],
  ['Technical.Transition', 'Transition', 'Establishing the AI system in its operating environment, with the checks and approvals deployment requires.', ['ISO42001.A.6.2.5']],
  ['Technical.Validation', 'Validation', 'Establishing that the AI system fulfils its intended use in its intended environment, which is a different question from whether it met its specification.', ['ISO42001.A.6.2.4']],
  ['Technical.ContinuousValidation', 'Continuous validation', 'Revalidating the AI system while it is in operation, because a learned system can stop being valid without anything about it having changed.', ['ISO42001.A.6.2.6']],
  ['Technical.Operation', 'Operation', 'Running the AI system to deliver its service, with the monitoring that its validation quietly assumed would be there.', ['ISO42001.A.6.2.6']],
  ['Technical.Maintenance', 'Maintenance', 'Sustaining the AI system, including retraining it — and treating a retrain as the change to production that it is.', ['ISO42001.A.6.2.6']],
  ['Technical.Disposal', 'Disposal', 'Ending the existence of the AI system and of what it held, including the models and the derived stores that outlive the obvious ones.', ['ISO27001.A.8.10']],
];

/**
 * The tables, in the order a report should walk them.
 *
 * A list rather than a map keyed by token, because a framework may contribute more than one
 * table: `ISO42001` has an Annex A table and a clause table, and they hold different
 * {@link KINDS}. The kind is declared here, once per table, rather than repeated on every
 * row where a single wrong one would be invisible.
 */
const TABLES = [
  { framework: 'SOC2', kind: 'criterion', rows: SOC2_TSC },
  { framework: 'ISO27001', kind: 'control', rows: ISO27001_ANNEX_A },
  { framework: 'ISO42001', kind: 'control', rows: ISO42001_ANNEX_A },
  { framework: 'ISO42001', kind: 'clause', rows: ISO42001_CLAUSES },
  { framework: 'ISO23894', kind: 'process', rows: ISO23894_RISK },
  { framework: 'ISO42005', kind: 'process', rows: ISO42005_IMPACT },
  { framework: 'ISO5338', kind: 'process', rows: ISO5338_LIFECYCLE },
];

/**
 * The local id shapes, one per framework, and a corpus is refused if an id does not match.
 *
 * This is not belt and braces over a hand-written table. It is what makes {@link controlsIn}
 * safe to run over arbitrary prose: the regexp says "this looks like a control id" and the
 * corpus says whether it is, and the first half is only worth anything if every id in the
 * corpus actually has the shape being matched.
 */
const LOCAL_RE = {
  SOC2: /^(CC|PI|[ACP])(\d+)\.(\d+)$/,
  ISO27001: /^A\.(\d+)\.(\d+)$/,
  // Two shapes under one token, and the group capture differs between them: `A.6.2.8` is
  // group `6` and `Clause6.1.2` is group `Clause6`. See the note on FRAMEWORKS.ISO42001.
  ISO42001: /^(?:A\.(\d+)(?:\.\d+)+|(Clause\d+)\.\d+(?:\.\d+)*)$/,
  // The three guidance standards: `Group.Subject`, both halves upper-camel. Named rather
  // than numbered, which is the file-header rule and not a shortcut.
  ISO23894: /^([A-Z][A-Za-z]*)\.[A-Z][A-Za-z]*$/,
  ISO42005: /^([A-Z][A-Za-z]*)\.[A-Z][A-Za-z]*$/,
  ISO5338: /^([A-Z][A-Za-z]*)\.[A-Z][A-Za-z]*$/,
};

/**
 * A control id anywhere in prose, by shape alone. Validated against the corpus after.
 *
 * Built from {@link FRAMEWORK_TOKENS} rather than written out, because a token added to the
 * frameworks and forgotten here would make every id in it invisible to
 * {@link controlsIn} — a silent half-failure, where the corpus resolves the id but nothing
 * ever finds it written down. Longest token first, so that alternation can never match a
 * prefix of a longer token and stop there.
 */
const ID_RE = new RegExp(
  `\\b(?:${[...FRAMEWORK_TOKENS].sort((a, b) => b.length - a.length).join('|')})\\.[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*\\b`,
  'g'
);

/** Which group a local id belongs to — the first capture that matched, per framework. */
function groupOf(token, local) {
  const hit = LOCAL_RE[token].exec(local);
  return hit ? hit.slice(1).find((g) => g !== undefined) ?? null : null;
}

/**
 * The corpus, built once.
 *
 * Built eagerly at module load rather than lazily on first call, because every failure this
 * function can have — a duplicate id, a crosswalk edge pointing at nothing, an edge declared
 * on a criterion — is a bug in the tables above, and the moment to find it is `npm test`
 * importing the file, not the first advocate that happens to ask about a control. There is
 * nothing to invalidate: the standard does not change while the process is running.
 *
 * **The returned object is shared and must be treated as read-only** — the same rule
 * lib/requirements.js makes for its cached corpus, and for the same reason: it is handed to
 * every caller in the process, so writing into it changes what all of them see and nothing
 * would say why. Records are frozen; a caller that needs one with something extra on it
 * builds a new object around it.
 */
function build() {
  const ids = new Map();
  const rowsByFramework = new Map(FRAMEWORK_TOKENS.map((t) => [t, []]));
  const rowsByKind = new Map(KINDS.map((k) => [k, []]));

  for (const table of TABLES) {
    const token = table.framework;
    const framework = FRAMEWORKS[token];
    if (!framework) throw new Error(`control corpus: a table claims framework ${token}, which is not one`);
    if (!KINDS.includes(table.kind)) throw new Error(`control corpus: ${token} table declares kind "${table.kind}", which is not a kind`);
    if (!framework.kinds.includes(table.kind)) throw new Error(`control corpus: ${token} does not hold ${table.kind} records`);
    for (const [local, title, definition, crosswalk = []] of table.rows) {
      if (!LOCAL_RE[token].test(local)) throw new Error(`control corpus: ${token} id "${local}" is not the shape ${token} ids have`);
      const id = `${token}.${local}`;
      if (ids.has(id)) throw new Error(`control corpus: ${id} is defined twice`);
      // Edges live on everything else, pointing at criteria. A criterion that declared one
      // would be the corpus keeping the same fact in two places, which is how they disagree.
      if (table.kind === 'criterion' && crosswalk.length) {
        throw new Error(`control corpus: ${id} is a criterion and may not declare a crosswalk — the edge belongs on the control`);
      }
      const group = groupOf(token, local);
      const record = Object.freeze({
        id,
        framework: token,
        local,
        title,
        definition,
        kind: table.kind,
        group,
        groupName: framework.groups[group] || null,
        crosswalk: Object.freeze([...crosswalk]),
      });
      ids.set(id, record);
      rowsByFramework.get(token).push(record);
      rowsByKind.get(table.kind).push(record);
    }
  }
  const byFramework = new Map([...rowsByFramework].map(([t, rows]) => [t, Object.freeze(rows)]));
  const byKind = new Map([...rowsByKind].map(([k, rows]) => [k, Object.freeze(rows)]));

  // Second pass, because an edge may point forward — 42001 reaches 27001, and 27001 is
  // built first only by the order of FRAMEWORK_TOKENS, which is not a guarantee worth
  // depending on. Closed in both directions: a target that does not resolve is a refusal.
  const inbound = new Map();
  let edges = 0;
  for (const record of ids.values()) {
    for (const target of record.crosswalk) {
      if (!ids.has(target)) throw new Error(`control corpus: ${record.id} crosswalks to ${target}, which is not in the corpus`);
      if (target === record.id) throw new Error(`control corpus: ${record.id} crosswalks to itself`);
      // A guidance standard reaches a criterion through the control that implements it,
      // never directly. `satisfiedBy` on a criterion is read as "what could be evidenced as
      // satisfying this", and nothing in 23894, 42005 or 5338 can be: nobody certifies
      // against them. One hop, one meaning — and the transitive answer is still there.
      if (!FRAMEWORKS[record.framework].certifiable && ids.get(target).kind === 'criterion') {
        throw new Error(`control corpus: ${record.id} is guidance and may not claim the criterion ${target} — point it at the control that implements it`);
      }
      if (!inbound.has(target)) inbound.set(target, []);
      inbound.get(target).push(record.id);
      edges += 1;
    }
  }
  for (const [target, list] of inbound) inbound.set(target, Object.freeze(list.sort()));

  return Object.freeze({ ids, byFramework, byKind, inbound, tokens: FRAMEWORK_TOKENS, kinds: KINDS, size: ids.size, edges });
}

const CORPUS = build();

/** The whole corpus — `{ ids, byFramework, byKind, inbound, tokens, kinds, size, edges }`, read-only. */
export const corpus = () => CORPUS;

/** Is this a control anybody has standardised? The one question everything else asks. */
export const isControl = (id) => CORPUS.ids.has(String(id || '').trim());

/** One control record, or null. */
export const control = (id) => CORPUS.ids.get(String(id || '').trim()) || null;

/** Every record in one framework, in corpus order. `[]` for a token nobody minted. */
export const byFramework = (token) => CORPUS.byFramework.get(String(token || '').trim()) || [];

/**
 * Every record of one kind, across every framework, in corpus order.
 *
 * The question a gate asks and no id shape can answer: *every clause*, regardless of which
 * standard wrote it down. `byKind('clause')` is the management system; `byKind('control')`
 * is what an operating-effectiveness test samples from; `byKind('process')` is guidance and
 * is never a conformance claim. `[]` for a kind nobody minted.
 */
export const byKind = (kind) => CORPUS.byKind.get(String(kind || '').trim()) || [];

/** The framework token an id belongs to, or null — without asking whether the id resolves. */
export const frameworkOf = (id) => {
  const token = String(id || '').trim().split('.')[0];
  return FRAMEWORKS[token] ? token : null;
};

/** What this control claims to satisfy elsewhere. Declared, and only on a control. */
export const crosswalk = (id) => control(id)?.crosswalk || [];

/**
 * What claims to satisfy this one — the inverse, computed at build time.
 *
 * This is the answer a SOC 2 criterion needs and cannot state itself: CC6.1 is satisfied by
 * `ISO27001.A.5.15`, `A.5.17`, `A.8.1`, `A.8.3`, `A.8.5`, `A.8.24`, `A.8.27` and the 42001
 * resource controls, and every one of those is one implementation rather than seven.
 */
export const satisfiedBy = (id) => CORPUS.inbound.get(String(id || '').trim()) || [];

/**
 * The ids in one framework that nothing crosswalks to.
 *
 * For SOC 2 this is the gap list, and it is meant to be non-empty — twelve of the 61, all of
 * them ISO/IEC 27701 territory, for the reason the file header sets out. A gap assessment
 * (bc-4r10.4) starts here rather than from a matrix that was made to look full.
 *
 * For the ISO frameworks it answers a different question and is *expected* to be large: a
 * control is unclaimed there simply because of which way the edges run. Almost nothing
 * crosswalks *into* 27001, and what crosswalks into 42001 is the 42001 clauses and the three
 * guidance standards reaching at the controls they elaborate. Ask {@link crosswalk} instead
 * for those.
 */
export const unclaimed = (token) => byFramework(token).filter((r) => !CORPUS.inbound.has(r.id)).map((r) => r.id);

/**
 * The control ids written in a piece of prose.
 *
 * Two steps, the same two lib/requirements.js uses for a requirement id: the regexp says
 * "this looks like one", the corpus says whether it is. Without the second step this finds
 * `SOC2.CC6.9` in a sentence somebody guessed at, and a guess with a bead behind it is
 * indistinguishable from a fact a month later.
 */
export function controlsIn(text) {
  const out = [];
  const seen = new Set();
  for (const hit of String(text || '').matchAll(ID_RE)) {
    const id = hit[0];
    if (seen.has(id)) continue;
    seen.add(id);
    if (isControl(id)) out.push(id);
  }
  return out;
}

/**
 * Split a list of written-down ids into the ones that resolve and the ones that do not.
 *
 * `{ ids, dropped }`, deliberately the same shape lib/beadreqs.js hands back for
 * requirements, because the caller does the same thing with it: store `ids`, and **say
 * `dropped` out loud**. Dropped silently, an advocate writes the same invented control every
 * run and from outside that is indistinguishable from the feature not working.
 */
export function keepControls(list) {
  const ids = [];
  const dropped = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw || '').trim();
    if (!id || ids.includes(id) || dropped.includes(id)) continue;
    if (isControl(id)) ids.push(id);
    else dropped.push(id);
  }
  return { ids, dropped };
}
