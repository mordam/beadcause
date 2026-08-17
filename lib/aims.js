/**
 * The AI management system, on paper — the organisation, the policy, the scope, the
 * parties and the roles.
 *
 * Everything else this programme builds is a record *of* something, and the something
 * has to already say what it is. An evidence register records that a control operated;
 * a control operates against a policy; a policy is issued by an organisation with a
 * name, under a scope with an edge, by somebody who is accountable. Beadcause had the
 * records first and the paper not at all, which is the ordinary order for software and
 * exactly backwards for an audit: an auditor opening at the evidence register asks what
 * it is evidence *for*, and until this file existed the honest answer was "a management
 * system nobody had written down".
 *
 * So this is the paper, held as data rather than as a PDF, for one reason that is worth
 * stating before anything else.
 *
 * ## Why the policy is a data structure and not a document
 *
 * The answer chosen for this whole programme is **enforce-then-record**, and it makes a
 * demand of the policy that a normal AI policy does not survive. `bc-eqn1.8` turns
 * clauses from here into refusals in `lib/endorse.js`, `lib/filing.js`,
 * `lib/mergequeue.js` and `lib/delivery.js`. A gate cannot refuse something for
 * violating "we are committed to the responsible use of artificial intelligence". It can
 * refuse something for violating "no session opens on a bead nobody endorsed", because
 * that names a condition a function can evaluate.
 *
 * Every clause below therefore carries a `testable` sentence and an enforcement state,
 * and the state is one of three:
 *
 * - **`enforced`** — something in this repo refuses the non-conformant case today, and
 *   `by` names the files that do it. `enforcementProblems` fails the repo if one of
 *   those files is not there any more, because a policy citing a gate that has been
 *   deleted is worse than a policy with no gate at all: it reads as covered.
 * - **`planned`** — the clause is real, the gate is not written yet, and `bead` names the
 *   bead that writes it. This is the state that must not be allowed to rot quietly, so a
 *   planned clause must name a bead and say in `note` what holds the line meanwhile.
 * - **`organisational`** — no gate can test it, and the document says so in those words.
 *   A commitment about whether a person *understood* what they approved is not
 *   mechanically checkable and never will be; writing it as though it were is the exact
 *   dishonesty an auditor is trained to find. An organisational clause carries no
 *   `testable` sentence at all, and `clauseProblems` refuses one that pretends to.
 *
 * That third state is the one that makes the other two mean something. A policy in which
 * every clause claims enforcement is a policy nobody checked.
 *
 * ## Why the documents are README sections and the ids are here
 *
 * The four controlled documents — the AI policy, the Clause 4.3 scope statement, the
 * interested-parties register and the roles table — are sections of `README.md`, and
 * `lib/documents.js` controls them by heading in the same register that already controls
 * the specification, the supplier register and the evidence register. That is where a
 * person reads them, and a policy nobody reads is not a control.
 *
 * The obvious failure of splitting a document from its machine-readable form is drift:
 * a clause added here that the policy never mentions, or a clause struck from the policy
 * that a gate still enforces. `documentProblems` pins the two together — each document
 * declares the ids it must contain, and the section has to contain every one of them
 * verbatim. It is the same shape as `lib/documents.js` pinning a heading: cheap, exact,
 * and it fails on the edit that caused it rather than a year later.
 *
 * ## What this file is deliberately not
 *
 * It is **not** an ownership vocabulary. `lib/owner.js` answers whose install this is and
 * `lib/ownership.js` answers whose bead this is; neither is an AIMS role and neither is
 * touched here. `NOT_AIMS_ROLES` says so by name so that the next person to look for a
 * roles table does not find three of them. A role below is an accountability under Clause
 * 5.3 — who answers for the management system, who owns an AI system, who may approve an
 * impact assessment — and the two modules above can later be *checked against* it,
 * which is only possible while they are separate things.
 *
 * It is also **not** signed. `SIGNATURE` says `draft`, names the signatory, and carries
 * the line they sign on. A session can draft a policy in an evening; it cannot commit an
 * organisation to one, and a system that claimed a signature nobody gave would be
 * producing exactly the artefact this programme exists to make impossible. The register
 * in `lib/documents.js` carries the same fact as `awaitingApproval`, so the repo says it
 * once a month in a warning rather than never.
 *
 * A leaf, like `lib/documents.js` and `lib/evidence.js`: it reads the repo root it is
 * handed and imports two siblings that are themselves pure data. No config directory, no
 * refs, no clock of its own — so a check, a service and a script can each hold it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REGISTER as CONTROLLED } from './documents.js';
import { REGISTER as SUPPLIERS } from './suppliers.js';

/* --------------------------------------------------------- the organisation */

/**
 * The legal entity the certificate is issued to, exactly as it should appear.
 *
 * Decided by Adam on `bc-jlpj`, which existed because this is the one fact in the whole
 * of `bc-eqn1.1` a session could not decide: the entity named in the scope statement is
 * the one an accredited body audits and the one printed on the certificate, and changing
 * it later is not a text edit.
 *
 * The `gap` is the house pattern from `lib/suppliers.js` and it is here for the same
 * reason: what the repo can state, it states; what it cannot, it names a bead for rather
 * than guessing. A jurisdiction invented to fill a field reads exactly like a jurisdiction
 * somebody checked.
 */
export const ORGANISATION = Object.freeze({
  legalName: 'Adam Morgan, trading as Neadamthal',
  form: 'sole trader',
  decidedBy: 'bc-jlpj',
  decidedOn: '2026-08-16',
  says:
    'Beadcause is operated by one person on their own machines, and the sole trader is the honest description of ' +
    'that rather than a placeholder for a company that does not exist. An accredited body will certify a sole ' +
    'trader; what it will not certify is an entity whose relationship to the person doing the work is unclear.',
  gap: Object.freeze({
    bead: 'bc-n043',
    says:
      'The jurisdiction the business name is registered in, the registration number and the registered address ' +
      'are not recorded here. The name is settled; the registration behind it has not been transcribed.',
  }),
});

/**
 * Top management, under Clause 5.1, and the commitment they are committing to.
 *
 * One person holds every role below, and the concentration is recorded rather than
 * disguised. A roles table listing five roles and one name is a finding an auditor raises
 * and the organisation answers; a roles table that invents four more people is fraud.
 */
export const TOP_MANAGEMENT = Object.freeze({
  name: 'Adam Morgan',
  role: 'Top management',
  appointedBy: 'The organisation itself — a sole trader is its own top management, and there is no board to appoint one.',
  commitment:
    'The AI management system is established, resourced and reviewed by the person who operates it; the AI policy ' +
    'below is the standing instruction to every agent this system runs, and where a commitment in it can be enforced ' +
    'by a gate it is enforced by a gate rather than described. Where it cannot, the policy says so in the document.',
  decidedBy: 'bc-jlpj',
});

/**
 * The signature the policy does not yet carry.
 *
 * A draft that says it is a draft is an ordinary artefact an auditor works with. A policy
 * marked approved on a date nobody approved anything is a fabricated record, and it is
 * the precise shape of finding this programme exists to make impossible — so this stays
 * `draft` until a person changes it, and nothing here can change it on their behalf.
 */
export const SIGNATURE = Object.freeze({
  state: 'draft',
  signatory: 'Adam Morgan',
  signingAs: 'Top management',
  signedOn: null,
  bead: 'bc-nft5',
  line: 'Signed ____________________  Adam Morgan, for Adam Morgan trading as Neadamthal, as top management.  Date __________',
});

/** Whether the policy carries a signature. False, on purpose, until a person signs it. */
export const signed = () => SIGNATURE.state === 'signed' && SIGNATURE.signedOn !== null;

/* --------------------------------------------------------------- the policy */

/** What an enforcement claim may be. Nothing outside this is a state. */
export const ENFORCEMENT = Object.freeze(['enforced', 'planned', 'organisational']);

/**
 * The AI policy — Clause 5.2, and the document the enforcement gates read.
 *
 * Ordered by how early in a piece of work the clause bites: an unendorsed bead is refused
 * before a window opens, an unregistered egress is refused before a branch lands, and the
 * organisational commitment is the one nothing can refuse at all.
 */
export const POLICY = Object.freeze({
  id: 'ai-policy',
  title: 'Beadcause AI policy',
  version: '0.1.0-draft',
  issuedBy: TOP_MANAGEMENT.name,
  purpose:
    'Beadcause runs autonomous agent sessions that read, write and merge code on machines and in repositories that ' +
    'belong to people. This policy states what those agents may and may not do, in terms specific enough that the ' +
    'system itself can refuse the things it forbids.',
  clauses: Object.freeze([
    Object.freeze({
      id: 'AIP-1',
      commitment: 'No unattended agent session opens on work a person has not endorsed.',
      testable:
        'A bead carrying the `unendorsed` label is refused by the endorsement hold before any window is opened, ' +
        'and the refusal is written on the bead rather than shown as a window that quietly does not appear.',
      state: 'enforced',
      by: Object.freeze(['lib/endorse.js', 'lib/advocate.js']),
      bead: null,
      note:
        'Two layers on purpose: the marker is filtered out of every queue, and `assertEndorsed` refuses a held bead ' +
        'handed straight to the launcher. The filter is what makes the refusal rare; the refusal is what makes it true.',
    }),
    Object.freeze({
      id: 'AIP-2',
      commitment: 'No agent widens what an agent is permitted to do.',
      testable:
        'An amendment to a protected field of an agent foundation — its identity, its protocol owner, what it may ' +
        'write and which repository it owns — is refused whoever asks, and the refusal is recorded with its reason.',
      state: 'enforced',
      by: Object.freeze(['lib/foundation.js']),
      bead: 'bc-eqn1.6',
      note:
        'The refusal exists today. What bc-eqn1.6 adds is the second half: an amendment that widens an agent, even ' +
        'in an amendable field, will additionally require a current impact assessment covering the widened form.',
    }),
    Object.freeze({
      id: 'AIP-3',
      commitment: 'Nothing leaves this machine to a third party the supplier register does not name.',
      testable:
        'A sweep of `lib/` and `bin/` for outbound hosts and for the commands actually executed fails the repo on ' +
        'one no supplier entry claims, so a new integration cannot ship without its entry.',
      state: 'enforced',
      by: Object.freeze(['lib/suppliers.js']),
      bead: null,
      note:
        'The clause that catches the largest egress in the system is the command half rather than the host half: ' +
        'every agent is a subprocess, and a sweep for URLs alone reports a clean tree while prompts leave the Mac.',
    }),
    Object.freeze({
      id: 'AIP-4',
      commitment: 'Every standing claim this system makes about itself has an owner and a date it goes stale.',
      testable:
        'Every controlled document carries an owner, a version, an approval and a review period, and the repo fails ' +
        'when one is past its review date — warning for a month first, and naming the owner in the failure.',
      state: 'enforced',
      by: Object.freeze(['lib/documents.js']),
      bead: null,
      note:
        'This is the clause that will one day turn the build red with no diff behind it. That is the control ' +
        'operating. The fix is a review, and moving the date without one is the single way to make the register lie.',
    }),
    Object.freeze({
      id: 'AIP-5',
      commitment: 'Nothing is kept without saying for how long, and nothing is deleted without saying who could.',
      testable:
        'Every module that writes durable state is claimed by an evidence class stating its retention, its disposal ' +
        'and who can alter it, or is exempted by name with a reason; an unclaimed writer fails the repo.',
      state: 'enforced',
      by: Object.freeze(['lib/evidence.js']),
      bead: null,
      note:
        'The enforcement runs in the direction that catches a new writer. A claim naming a file that no longer ' +
        'writes anything is caught by the same check as a stale entry.',
    }),
    Object.freeze({
      id: 'AIP-6',
      commitment: 'No AI system in this register operates without a current impact assessment.',
      testable:
        'Opening a session on an agent kind whose impact assessment is missing or expired is refused, and ' +
        'registering a new agent kind without one is refused, with the refusal kept as evidence.',
      state: 'planned',
      by: Object.freeze(['lib/foundation.js', 'lib/dispatch.js']),
      bead: 'bc-eqn1.6',
      note:
        'Until the gate lands, what holds the line is that the set of agent kinds is closed and changing it is a ' +
        'commit to a chained ref — visible, but not refused. Nobody should read that as equivalent.',
    }),
    Object.freeze({
      id: 'AIP-7',
      commitment: 'No change reaches a default branch without naming what it was for.',
      testable:
        'A merge carrying no bead, and no control or requirement claim of any kind, is refused by the queue rather ' +
        'than landed with an empty record.',
      state: 'planned',
      by: Object.freeze(['lib/mergequeue.js', 'lib/delivery.js']),
      bead: 'bc-eqn1.8',
      note:
        'Every merge today already carries a bead, because the only path to one is a delivery that parks the work ' +
        'bead behind a merge bead. What is missing is the refusal of the case that does not.',
    }),
    Object.freeze({
      id: 'AIP-8',
      commitment: 'A change to which model an agent runs on is not invisible.',
      testable:
        'A change to the model tier an agent kind runs on does not land unless the system card recording what that ' +
        'agent is changes in the same diff.',
      state: 'planned',
      by: Object.freeze(['lib/modelcard.js', 'lib/mergequeue.js']),
      bead: 'bc-eqn1.8',
      note:
        'The model an agent actually ran on is already recorded per session. What is not yet refused is a change to ' +
        'what it will run on next time, made without the card that describes the system moving with it.',
    }),
    Object.freeze({
      id: 'AIP-9',
      commitment: 'The process that writes a change is never the process that merges it.',
      testable:
        'A worker session pushes a branch and opens a pull request, and stops; the merge is performed by a separate ' +
        'process in the daemon that can see every open branch at once.',
      state: 'planned',
      by: Object.freeze(['lib/mergequeue.js', 'lib/mergeadvocate.js']),
      bead: 'bc-eqn1.8',
      note:
        'This is how the system is arranged today and it is stated in every worker brief, but it is a convention ' +
        'rather than a refusal: nothing physically stops a session merging its own branch. Saying so is the point.',
    }),
    Object.freeze({
      id: 'AIP-10',
      commitment: 'Whoever approves an AI system impact assessment understands what they are approving.',
      testable: null,
      state: 'organisational',
      by: Object.freeze([]),
      bead: 'bc-eqn1.16',
      note:
        'Nothing can test this and this policy will not pretend otherwise. What bc-eqn1.16 makes checkable is the ' +
        'record that a competence review happened and when — which is a different and much weaker claim, and the ' +
        'difference between the two is exactly what an organisational clause is for.',
    }),
  ]),
});

/** One clause by id, or `null`. The seam every gate that cites a clause goes through. */
export const clause = (id) => POLICY.clauses.find((c) => c.id === String(id)) || null;

/** The clauses in a given enforcement state — `enforced()` is what a gate audit reads. */
export const clausesInState = (state) => POLICY.clauses.filter((c) => c.state === state);

/* ---------------------------------------------------------------- the scope */

/**
 * The Clause 4.3 scope statement, with its exclusions and what each one costs.
 *
 * Scope is the first document an auditor reads and the exclusions are the half they read
 * twice, because an exclusion with no reason is a boundary drawn where the evidence ran
 * out. Every entry in `excluded` therefore carries both a `why` and a `residual` — what
 * is still true about the risk once the thing is outside the boundary — which is the same
 * discipline `lib/boundary.js` applies to a carve-out owing a complementary control.
 */
export const SCOPE = Object.freeze({
  id: 'aims-scope',
  statement:
    'The design, development, operation and provision of Beadcause: the decision inbox and the daemon behind it, ' +
    'the autonomous agent sessions it opens against repositories on machines the organisation operates, the tracker ' +
    'those sessions read and write, and the compliance layer that evidences all of it.',
  included: Object.freeze([
    Object.freeze({
      name: 'The daemon and its surfaces',
      what: 'The server, the phone inbox, the terminal and the chat session — everything a person touches to direct the system.',
    }),
    Object.freeze({
      name: 'The agent sessions',
      what:
        'Every agent kind the system can open: the advocate that decides what is ready, the worker that does it, the ' +
        'epic planner, the chat session, the resolver and the merge advocate. Each is an AI system in its own right.',
    }),
    Object.freeze({
      name: 'The repositories on this Mac',
      what: 'The checkouts and worktrees an agent reads, writes and merges into, and the trackers beside them.',
    }),
    Object.freeze({
      name: 'The compliance layer itself',
      what:
        'The control corpus, the registers, the enforcement gates and the evidence they write. It is inside the ' +
        'boundary of the audits it serves, and being outside it would make the evidence worth nothing.',
    }),
    Object.freeze({
      name: 'The machine the daemon runs on',
      what: 'The Mac itself, its account security and its local storage — every record this system keeps begins there.',
    }),
  ]),
  excluded: Object.freeze([
    Object.freeze({
      name: 'The model and its training',
      why:
        'The organisation does not develop, train, fine-tune or host a model. Every agent is a subprocess of a ' +
        'supplier’s tool, and the model’s behaviour is a property of that supplier’s system rather than this one.',
      residual:
        'The model is the largest single risk in the system and being out of scope does not make it out of the ' +
        'audit: it is carried as a supplier with the shortest review period in the register, and every clause about ' +
        'what an agent may do is a control over the model’s effects rather than over the model.',
    }),
    Object.freeze({
      name: 'Repositories this organisation does not own',
      why:
        'An agent may open a pull request into a repository whose owner runs their own review, their own branch ' +
        'protection and their own management system. This AIMS cannot claim controls it does not operate.',
      residual:
        'A complementary control: the repository owner reviews and merges. The system’s obligation is that every ' +
        'change is attributable to a bead and a session, which is what makes their review possible.',
    }),
    Object.freeze({
      name: 'The third parties in the supplier register',
      why:
        'What GitHub, Atlassian, Slack, ntfy, Google and Tailscale do internally is theirs. The organisation ' +
        'operates none of it and can evidence none of it.',
      residual:
        'What is sent to each, why, and under what terms is in scope and is the supplier register’s whole subject. ' +
        'The terms in force are the register’s stated gap rather than a claim.',
    }),
    Object.freeze({
      name: 'Installs that have elected nothing',
      why:
        'Beadcause runs on machines with no architecture checkout, no corpus and no interest in an attestation. ' +
        'Enforcement is scoped to what an install has elected, so those installs run no gates at all.',
      residual:
        'The design and development of the software is in scope for every install, because it is one artefact. What ' +
        'is out of scope is the operation of a management system on an install that never declared one — and the ' +
        'election history is a chained record, so which is which is answerable for any past date.',
    }),
  ]),
  reviewedWith: 'Any change to what an agent may do, and at least annually.',
});

/* ------------------------------------------------------- context and parties */

/**
 * Clause 4.1 — the issues that decide what this management system has to be.
 *
 * Kept as sentences rather than a matrix because each one is a reason for something below
 * it, and a matrix cell is not a reason.
 */
export const CONTEXT = Object.freeze({
  internal: Object.freeze([
    'One person operates the system, owns every role in it, and approves their own work. There is no segregation of duties and no amount of process will create one.',
    'Most of the code is written by the system’s own agents, so the thing being audited and the thing doing the auditing are the same artefact.',
    'The specification, the tracker and the product are one repository, which makes evidence cheap and makes a mistake in the record indistinguishable from a mistake in the code.',
    'Attention is the scarce resource, not compute: a control that asks the operator a question they do not have time to answer is a control that gets routed around.',
  ]),
  external: Object.freeze([
    'The system depends on a single model supplier whose terms, retention and capabilities can change without notice and without a version number.',
    'Agents write into repositories other people own, so the consequences of a defect land on somebody who never ran this software.',
    'An autonomous merge can reach a deployed service, which means a failure has an audience beyond the operator.',
    'The audience for the certificate is a customer or an accredited body who will read the evidence rather than the intentions.',
  ]),
});

/**
 * Clause 4.2 — the parties, what they need, and how the system answers it.
 *
 * Suppliers are interested parties too and are deliberately **not** listed here: they are
 * enumerated once, in `lib/suppliers.js`, and `parties()` folds them in. A register that
 * re-derived them would be a second list of the same seven organisations, drifting from
 * the one the egress sweep actually enforces.
 */
export const PARTIES = Object.freeze([
  Object.freeze({
    id: 'operator',
    party: 'The operator',
    needs: Object.freeze([
      'to know what every agent is doing right now, and to be able to stop it',
      'to be asked rather than guessed at when a decision is theirs',
      'not to be asked about anything the system could have decided itself',
    ]),
    how: 'The inbox, the session windows and the terminal; the endorsement hold; the decision card that turns a question into two taps on a phone.',
  }),
  Object.freeze({
    id: 'repo-owners',
    party: 'Owners of repositories agents write into',
    needs: Object.freeze([
      'every change attributable to a bead, a session and a model',
      'nothing merged that they could not have reviewed',
      'a way to tell an agent’s work from a person’s',
    ]),
    how: 'A branch and a pull request per bead; the session archive against the bead; the byline that says which agent wrote it and what it ran on.',
  }),
  Object.freeze({
    id: 'reviewers',
    party: 'Reviewers of a pull request an agent opened',
    needs: Object.freeze([
      'to know an agent wrote it, which one, and what it was asked to do',
      'a description that is true of the diff rather than of the intention',
    ]),
    how: 'The delivery writes the brief, the tests run and the risks into the pull request body, and the diffstat is carried beside it so the two can be compared.',
  }),
  Object.freeze({
    id: 'data-subjects',
    party: 'People named in a bead, a commit or a file an agent reads',
    needs: Object.freeze([
      'their name, their words and their email address not to be sent somewhere nobody recorded',
      'a way to find out where it went',
    ]),
    how: 'The supplier register states what is sent to each third party; the publishable vocabulary decides what may leave the Mac at all; the evidence register states how long each record is kept.',
  }),
  Object.freeze({
    id: 'service-users',
    party: 'Users of a service an autonomous merge deployed',
    needs: Object.freeze([
      'a bad deploy to be visible and revertible',
      'not to be the first to notice',
    ]),
    how: 'A merge deploys through a settle window and the ship bead closes on the evidence that it went out; a poisoned build is refused rather than served.',
  }),
  Object.freeze({
    id: 'auditor',
    party: 'An auditor or certification body',
    needs: Object.freeze([
      'evidence that a control operated across a window, not a description of it',
      'to be able to sample a change and follow it to its record',
      'a scope with an edge and exclusions with reasons',
    ]),
    how: 'The evidence register, the control corpus, the refusals kept as records, and this document set.',
  }),
  Object.freeze({
    id: 'successors',
    party: 'Whoever maintains or acquires the system next',
    needs: Object.freeze([
      'the reason a thing was built the way it was, not only what it does',
      'a document set that is current rather than one that was current once',
    ]),
    how: 'The specification argues for everything it documents, and every standing document carries an owner and a review date that fails the build when it passes.',
  }),
]);

/**
 * Every interested party — the ones written above, plus one per supplier.
 *
 * Folded rather than merged: a supplier-derived party keeps the supplier’s id so the two
 * registers can never disagree about how many there are.
 */
export function parties(register = PARTIES, suppliers = SUPPLIERS) {
  const derived = suppliers.map((s) =>
    Object.freeze({
      id: s.id,
      party: s.name,
      needs: Object.freeze(['their terms honoured by what is sent to them', 'to be named before anything is sent at all']),
      how: 'The supplier register states what is sent and why, and the egress sweep fails the repo on a supplier it does not name.',
      fromSupplier: true,
    })
  );
  return [...register, ...derived];
}

/* ---------------------------------------------------------------- the roles */

/** What there is to approve. An approval kind no role may give is a decision nothing can make. */
export const APPROVALS = Object.freeze([
  'ai-policy',
  'aims-scope',
  'impact-assessment',
  'controlled-document',
  'supplier',
  'agent-protocol-amendment',
  'incident-closure',
]);

/**
 * Clause 5.3 and Annex A.3 — who is accountable for what, and who may approve what.
 *
 * Five roles and one holder. The concentration is the first thing an auditor will raise
 * and `CONCENTRATION` below is the answer, written before they ask: it is a fact about an
 * organisation of one, it is recorded rather than disguised, and it names what would have
 * to change the day a second person arrives.
 */
export const ROLES = Object.freeze([
  Object.freeze({
    id: 'top-management',
    title: 'Top management',
    holder: 'Adam Morgan',
    accountableFor:
      'The AI management system as a whole: that it exists, that it is resourced, and that it is reviewed. Issues the AI policy and owns the scope statement.',
    mayApprove: Object.freeze(['ai-policy', 'aims-scope', 'agent-protocol-amendment', 'incident-closure']),
  }),
  Object.freeze({
    id: 'aims-manager',
    title: 'AIMS manager',
    holder: 'Adam Morgan',
    accountableFor:
      'Operating the management system day to day: keeping the registers current, clearing the reviews the repo fails on, and running the internal audit programme.',
    mayApprove: Object.freeze(['controlled-document', 'supplier']),
  }),
  Object.freeze({
    id: 'system-owner',
    title: 'AI system owner',
    holder: 'Adam Morgan',
    accountableFor:
      'Each AI system in the register — one per agent kind. Answerable for what that agent does, what it may write, and the model tier it runs on.',
    mayApprove: Object.freeze(['agent-protocol-amendment']),
  }),
  Object.freeze({
    id: 'impact-approver',
    title: 'Impact assessment approver',
    holder: 'Adam Morgan',
    accountableFor:
      'Deciding whether an AI system impact assessment is adequate, and whether a widened agent may proceed on the strength of it.',
    mayApprove: Object.freeze(['impact-assessment']),
  }),
  Object.freeze({
    id: 'incident-owner',
    title: 'Incident owner',
    holder: 'Adam Morgan',
    accountableFor:
      'An incident from the moment it is raised to the moment its corrective action is shown to have worked, including the review that follows it.',
    mayApprove: Object.freeze(['incident-closure']),
  }),
]);

/** The answer to the question the roles table provokes, written before it is asked. */
export const CONCENTRATION = Object.freeze({
  holders: 1,
  roles: ROLES.length,
  says:
    'Every role above is held by the same person, because the organisation is one person. There is no segregation ' +
    'of duties: the operator writes the policy, approves it, owns the systems it governs and closes the incidents ' +
    'they cause. What compensates is that the approvals which matter are enforced by code rather than by the ' +
    'approver’s memory, and that every refusal, election and amendment is an append-only record the operator ' +
    'cannot quietly rewrite. What would change with a second person is which roles move first: the impact ' +
    'assessment approver and the incident owner, in that order, because those are the two approvals where an ' +
    'independent reader is worth most.',
});

/**
 * The two ownership vocabularies that are not AIMS roles, named so nobody merges them.
 *
 * Both are load-bearing and neither is an accountability: one answers whose install this
 * is, the other whose bead this is. Keeping them apart is what makes it possible to later
 * *check* a bead's owner against the roles table, which is impossible while they are the
 * same list.
 */
export const NOT_AIMS_ROLES = Object.freeze([
  Object.freeze({
    path: 'lib/owner.js',
    why: 'Whose install this is — an installation fact used to attribute a record, not an accountability for the management system.',
  }),
  Object.freeze({
    path: 'lib/ownership.js',
    why: 'Whose bead this is — the assignment of a piece of work, which changes hourly and means nothing about who answers for an AI system.',
  }),
]);

/** Whether a role may give an approval of this kind. */
export function mayApprove(roleId, kind) {
  const role = ROLES.find((r) => r.id === String(roleId));
  return Boolean(role && role.mayApprove.includes(String(kind)));
}

/** Every role that may give this kind of approval. */
export const approvers = (kind) => ROLES.filter((r) => r.mayApprove.includes(String(kind)));

/* ------------------------------------------------------------ the documents */

const clausePins = POLICY.clauses.map((c) => c.id);
const scopePins = [...SCOPE.included, ...SCOPE.excluded].map((s) => s.name);
const partyPins = PARTIES.map((p) => p.party);
const rolePins = ROLES.map((r) => r.title);

/**
 * The four controlled documents, where each one lives, and what it must contain.
 *
 * `heading` is the README heading line verbatim, which is the same handle `lib/documents.js`
 * uses and for the same reason — rename it and the check says so by name. `pins` is the
 * anti-drift half: a clause added here that the policy never states, or a role struck from
 * the table that the code still honours, fails on the diff that caused it.
 */
export const DOCUMENTS = Object.freeze([
  Object.freeze({
    id: 'ai-policy',
    title: 'The AI policy',
    path: 'README.md',
    heading: '#### The AI policy',
    clause: 'ISO/IEC 42001 Clause 5.2 — the AI policy, issued by top management.',
    pins: Object.freeze(clausePins),
  }),
  Object.freeze({
    id: 'aims-scope',
    title: 'Scope of the AI management system',
    path: 'README.md',
    heading: '#### Scope of the AI management system',
    clause: 'ISO/IEC 42001 Clause 4.3 — the scope of the management system, with its exclusions stated.',
    pins: Object.freeze(scopePins),
  }),
  Object.freeze({
    id: 'interested-parties',
    title: 'Interested parties and what they need',
    path: 'README.md',
    heading: '#### Interested parties and what they need',
    clause: 'ISO/IEC 42001 Clauses 4.1 and 4.2 — context, interested parties and their requirements.',
    pins: Object.freeze(partyPins),
  }),
  Object.freeze({
    id: 'aims-roles',
    title: 'Roles, and who may approve what',
    path: 'README.md',
    heading: '#### Roles, and who may approve what',
    clause: 'ISO/IEC 42001 Clause 5.3 and Annex A.3 — roles, responsibilities and authorities.',
    pins: Object.freeze(rolePins),
  }),
]);

/* ------------------------------------------------------------ what must hold */

const prose = (v) => typeof v === 'string' && v.trim().length >= 40;
const named = (v) => typeof v === 'string' && v.trim().length >= 2;
const list = (v) => Array.isArray(v);

/**
 * Everything wrong with one policy clause, as sentences.
 *
 * Takes a clause rather than reading `POLICY`, for the reason `lib/evidence.js` gives for
 * the same split: rules that only ever run against a register which passes are rules
 * nobody has seen fail. `test/aims.mjs` runs these against deliberately broken clauses.
 *
 * The three state rules are the ones with weight. Everything else is stopping a
 * commitment from being answered with a slogan.
 */
export function clauseProblems(c) {
  const problems = [];
  const at = `POLICY[${c?.id || '?'}]`;

  if (!/^AIP-\d+$/.test(String(c?.id || ''))) problems.push(`${at}: id must be AIP-<n>`);
  if (!prose(c?.commitment)) problems.push(`${at}: \`commitment\` must state what the organisation commits to, in a sentence`);
  if (!prose(c?.note)) problems.push(`${at}: \`note\` must say what holds this line today, in a sentence`);
  if (!ENFORCEMENT.includes(c?.state)) {
    problems.push(`${at}: \`state\` must be one of ${ENFORCEMENT.join(', ')} — ${JSON.stringify(c?.state ?? null)} is not`);
    return problems;
  }
  if (!Array.isArray(c?.by)) {
    problems.push(`${at}: \`by\` must be a list of the files that enforce it, empty if none do`);
    return problems;
  }

  if (c.state === 'enforced') {
    if (!prose(c?.testable)) {
      problems.push(`${at}: an enforced clause must carry a \`testable\` sentence naming the condition something evaluates`);
    }
    if (c.by.length === 0) problems.push(`${at}: an enforced clause must name in \`by\` what does the refusing`);
  }

  if (c.state === 'planned') {
    if (!prose(c?.testable)) {
      problems.push(`${at}: a planned clause must carry the \`testable\` sentence the gate will be written against`);
    }
    if (!named(c?.bead)) {
      problems.push(`${at}: a planned clause must name the \`bead\` that writes the gate — a plan with no bead is an aspiration`);
    }
  }

  if (c.state === 'organisational') {
    if (c.testable !== null) {
      problems.push(
        `${at}: an organisational clause must have \`testable: null\` — if a condition can be written, the clause is not organisational`
      );
    }
    if (c.by.length > 0) problems.push(`${at}: an organisational clause enforces nothing, so \`by\` must be empty`);
  }

  return problems;
}

/** Everything wrong with the policy as a whole — the clauses, plus what only the set can be wrong about. */
export function policyProblems(policy = POLICY) {
  const problems = [];
  if (!named(policy?.version)) problems.push('POLICY: `version` must say which version this is');
  if (!prose(policy?.purpose)) problems.push('POLICY: `purpose` must say what the policy is for, in a sentence');

  const seen = new Set();
  for (const c of policy?.clauses || []) {
    problems.push(...clauseProblems(c));
    if (seen.has(c?.id)) problems.push(`POLICY[${c?.id}]: two clauses with the same id`);
    seen.add(c?.id);
  }

  if (!(policy?.clauses || []).some((c) => c.state === 'enforced')) {
    problems.push('POLICY: not one clause is enforced — a policy of aspirations is the thing this file exists to refuse');
  }
  return problems;
}

/** Everything wrong with the scope statement. Exclusions carry the weight; inclusions are a list. */
export function scopeProblems(scope = SCOPE) {
  const problems = [];
  if (!prose(scope?.statement)) problems.push('SCOPE: `statement` must state what the management system covers');
  if (!(scope?.included || []).length) problems.push('SCOPE: `included` must name what is inside the boundary');
  if (!(scope?.excluded || []).length) {
    problems.push('SCOPE: `excluded` must name what is outside it — a scope with no exclusions has not been thought about');
  }

  for (const inc of scope?.included || []) {
    if (!named(inc?.name)) problems.push('SCOPE.included: every entry needs a `name` short enough to appear in the document');
    if (!prose(inc?.what)) problems.push(`SCOPE.included[${inc?.name || '?'}]: \`what\` must say what is inside, in a sentence`);
  }

  for (const exc of scope?.excluded || []) {
    const at = `SCOPE.excluded[${exc?.name || '?'}]`;
    if (!named(exc?.name)) problems.push('SCOPE.excluded: every entry needs a `name` short enough to appear in the document');
    if (!prose(exc?.why)) problems.push(`${at}: \`why\` must say why it is outside the boundary — an exclusion with no reason is a gap`);
    if (!prose(exc?.residual)) {
      problems.push(`${at}: \`residual\` must say what is still true about the risk once it is outside — out of scope is not out of the audit`);
    }
  }
  return problems;
}

/** Everything wrong with the interested-parties register, including a party that belongs to the supplier one. */
export function partyProblems(register = PARTIES, suppliers = SUPPLIERS) {
  const problems = [];
  const supplierIds = new Set(suppliers.map((s) => s.id));
  const seen = new Set();

  for (const p of register) {
    const at = `PARTIES[${p?.id || '?'}]`;
    if (!/^[a-z][a-z0-9-]*$/.test(String(p?.id || ''))) problems.push(`${at}: id must be kebab-case`);
    if (!named(p?.party)) problems.push(`${at}: \`party\` must name them as the document names them`);
    if (!list(p?.needs) || !p.needs.length) problems.push(`${at}: \`needs\` must say what they need from the system`);
    if (!prose(p?.how)) problems.push(`${at}: \`how\` must say how the system answers it, in a sentence`);
    if (supplierIds.has(p?.id)) {
      problems.push(`${at}: ${p.id} is already in the supplier register, so this register would carry a second copy of it`);
    }
    if (seen.has(p?.id)) problems.push(`${at}: two parties with the same id`);
    seen.add(p?.id);
  }

  if (!register.length) problems.push('PARTIES: the register is empty — Clause 4.2 is not satisfied by an empty list');
  return problems;
}

/** Everything wrong with the roles table, including an approval nobody may give. */
export function roleProblems(roles = ROLES, approvals = APPROVALS) {
  const problems = [];
  const seen = new Set();

  for (const r of roles) {
    const at = `ROLES[${r?.id || '?'}]`;
    if (!/^[a-z][a-z0-9-]*$/.test(String(r?.id || ''))) problems.push(`${at}: id must be kebab-case`);
    if (!named(r?.title)) problems.push(`${at}: \`title\` must name the role as the document names it`);
    if (!named(r?.holder)) problems.push(`${at}: \`holder\` must name a person — a role nobody holds is not assigned`);
    if (!prose(r?.accountableFor)) problems.push(`${at}: \`accountableFor\` must say what they answer for, in a sentence`);
    if (!Array.isArray(r?.mayApprove)) {
      problems.push(`${at}: \`mayApprove\` must be a list, empty if the role approves nothing`);
    } else {
      for (const kind of r.mayApprove) {
        if (!approvals.includes(kind)) problems.push(`${at}: \`${kind}\` is not one of the approvals in APPROVALS`);
      }
    }
    if (seen.has(r?.id)) problems.push(`${at}: two roles with the same id`);
    seen.add(r?.id);
  }

  for (const kind of approvals) {
    if (!roles.some((r) => Array.isArray(r?.mayApprove) && r.mayApprove.includes(kind))) {
      problems.push(`APPROVALS: nobody may approve \`${kind}\` — an approval no role can give is a decision that cannot be made`);
    }
  }
  return problems;
}

/**
 * Every file a clause claims enforces it, and every module named as not being a role,
 * still being in the repo.
 *
 * This is the check that keeps the policy from reading as covered while the gate it cites
 * has been deleted or renamed. It runs in the direction that catches a rename: a file
 * named here that is not there fails. The other direction — a gate that exists and no
 * clause claims — is not knowable from a path and is left to the review date.
 */
export function enforcementProblems(root, policy = POLICY, notRoles = NOT_AIMS_ROLES) {
  const problems = [];
  const missing = (rel) => !fs.existsSync(path.join(root, rel));

  for (const c of policy?.clauses || []) {
    for (const rel of c?.by || []) {
      if (missing(rel)) {
        problems.push(
          `POLICY[${c.id}]: names ${rel} as what enforces it, and ${rel} is not in the repo — ` +
            'either the gate moved, in which case say so here, or the clause is claiming an enforcement that is gone'
        );
      }
    }
  }

  for (const n of notRoles) {
    if (missing(n?.path)) {
      problems.push(`NOT_AIMS_ROLES: ${n?.path} is not in the repo, so this exemption is about a file that no longer exists`);
    }
  }
  return problems;
}

/**
 * The body of one section of a markdown file, by its heading line.
 *
 * From the heading to the next heading of the same level or higher, which is what makes a
 * `####` document end at the next `####` rather than swallowing the rest of the file.
 * Returns `null` when the heading is not there, so a caller can tell a missing document
 * from an empty one.
 */
export function sectionOf(source, heading) {
  const want = String(heading).trim();
  const level = (want.match(/^#+/) || [''])[0].length;
  const lines = String(source).split('\n');
  const start = lines.findIndex((line) => line.trim() === want);
  if (start === -1) return null;

  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const hashes = (lines[i].match(/^(#+)\s/) || [null, ''])[1].length;
    if (hashes > 0 && hashes <= level) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/**
 * Every document that is not where it says it is, or does not say what the code says it says.
 *
 * The second half is the one worth having. A clause added to `POLICY` and never written
 * into the policy document is a gate enforcing something the policy does not state, which
 * is unenforceable in every sense that matters; a clause struck from the document while
 * the gate stays is worse. Pinning by id rather than by sentence is deliberate — a
 * sentence gets rewrapped by an editor and an id does not.
 */
export function documentProblems(root, documents = DOCUMENTS) {
  const problems = [];
  for (const d of documents) {
    const at = `DOCUMENTS[${d.id}]`;
    let source = null;
    try {
      source = fs.readFileSync(path.join(root, d.path), 'utf8');
    } catch {
      problems.push(`${at}: ${d.path} is not in the repo, so this document does not exist`);
      continue;
    }

    const body = sectionOf(source, d.heading);
    if (body === null) {
      problems.push(
        `${at}: ${d.path} has no heading \`${d.heading}\` — either it was renamed, in which case say so here, or the document is gone`
      );
      continue;
    }

    for (const pin of d.pins) {
      if (!body.includes(pin)) {
        problems.push(`${at}: the document does not mention \`${pin}\`, which the code says it states`);
      }
    }
  }
  return problems;
}

/**
 * Every document above being controlled by `lib/documents.js`, by the same heading.
 *
 * The loop that makes the pair honest: this file says four documents exist, that file
 * says who owns each and when it goes stale, and a document declared here but controlled
 * nowhere is a document with no owner and no review date — which is the condition the
 * whole of `bc-eqn1.11` was built to end.
 */
export function controlProblems(documents = DOCUMENTS, controlled = CONTROLLED) {
  const problems = [];
  for (const d of documents) {
    const entry = controlled.find((e) => e.path === d.path && e.section === d.heading);
    if (!entry) {
      problems.push(
        `DOCUMENTS[${d.id}]: no entry in lib/documents.js controls ${d.path} — ${d.heading}, ` +
          'so this document has no owner, no version and no review date'
      );
    }
  }
  return problems;
}

/**
 * Everything wrong with the AIMS on paper, in one call, split into what fails and what warns.
 *
 * Returned rather than thrown so one run names every problem, and warnings are separate
 * for one case only: the policy is unsigned. That is a true and known state rather than a
 * defect — a session drafted it and only a person can sign it — so it warns every time
 * anybody looks, and never fails a build that a person cannot fix from a terminal.
 */
export function problems(root, { policy = POLICY, scope = SCOPE, roles = ROLES, register = PARTIES } = {}) {
  const found = [
    ...policyProblems(policy),
    ...scopeProblems(scope),
    ...partyProblems(register),
    ...roleProblems(roles),
    ...enforcementProblems(root, policy),
    ...documentProblems(root),
    ...controlProblems(),
  ];

  const warnings = [];
  if (!signed()) {
    warnings.push(
      `POLICY: version ${policy.version} is a draft awaiting ${SIGNATURE.signatory}'s signature as ${SIGNATURE.signingAs} ` +
        `— ${SIGNATURE.bead}. It is a draft in the register too, and it stays one until a person signs it.`
    );
  }
  if (ORGANISATION.gap) {
    warnings.push(`ORGANISATION: ${ORGANISATION.gap.says} — ${ORGANISATION.gap.bead}.`);
  }
  return { problems: found, warnings };
}
