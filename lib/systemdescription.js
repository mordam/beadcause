/**
 * The system description, generated — Section 3 of a SOC 2 report, read off the records
 * rather than typed into a document.
 *
 * A SOC 2 report has a management-written description of the system, and it must meet the
 * description criteria in **DC section 200**: the services provided, the principal service
 * commitments and system requirements, the components — infrastructure, software, people,
 * procedures, data — the relevant aspects of the control environment, risk assessment,
 * monitoring and communication, the applicable trust services criteria and the controls
 * meeting them, the complementary user entity controls, the subservice organisations and
 * the method applied to each, the criteria that are not relevant and why, and the changes
 * and incidents in the period.
 *
 * Written by hand it drifts from reality within a quarter, and the drift is exactly what
 * an auditor tests: the description says four environments and there are six, it names a
 * processor that was replaced in March, it lists a policy nobody approved. Generated from
 * the boundary record and the control corpus it is true by construction, and **the diff
 * between two periods' descriptions is itself a reviewable artefact** — which is the
 * second reason this file exists and the reason nothing below stamps the moment it ran.
 *
 * ## Nothing here writes a sentence about Climative that is not in a record
 *
 * That is the whole discipline, and it is what makes the output worth reading. Every
 * section is computed from one of three registers this release already ships:
 *
 * - `lib/boundary.js` — what is inside, what is carved out, who the user entities are,
 *   and, crucially, the **census** saying how complete each of those lists is.
 * - `lib/controls.js` — the criteria themselves, their definitions, and the crosswalk to
 *   the ISO/IEC 27001 and 42001 controls that are the same implementation under another
 *   name.
 * - `lib/policies.js` — Climative's controlled document set (`HELD_BY` says whose), each
 *   entry naming the criteria it is the documented answer for and what already enforces
 *   it. That is the procedures component, and it is where the control-environment section
 *   gets its substance instead of a paragraph.
 *
 * This is the file where the three meet, which is why the joining lives here: each of them
 * is a leaf that deliberately does not import its neighbours, and `lib/policies.js` takes
 * the corpus as a *parameter* for exactly that reason. A description is the artefact that
 * needs all three at once, so it is the one place that may hold all three.
 *
 * ## A section that cannot be written says so, and that is the point of the states
 *
 * The tempting shape is a template with blanks, and a blank in a description reads as an
 * assertion that there is nothing to say. So every section carries a state, computed and
 * never declared:
 *
 * - `generated` — derived in full, and the record it came from claims to be complete.
 * - `partial` — derived, but something admits it is incomplete: a partial census, an
 *   elected criterion no policy claims, a policy nobody has approved.
 * - `unavailable` — nothing in this release can derive it, and `heldElsewhere` names the
 *   kind of source that holds the answer.
 *
 * There is no fourth, and there is deliberately no way to hand-write a section in. The day
 * the commitments section can be generated is the day something *records* the service
 * commitments; until then a description that prints them as owed is a truer document than
 * one with a paragraph somebody drafted from memory. `writable` — no section unavailable —
 * is what a readiness review gates on, and today it is false.
 *
 * Three sections have no source in this release at all, and they get a seam rather than a
 * permanent red: see {@link SUPPLIABLE}. A caller may hand in a *record* for them, held to
 * the same bar as everything else — every entry names where the fact is written down — and
 * the seam is deliberately not reachable from the command line, because a flag would make
 * a hand-written section one step away.
 *
 * ## What it refuses to reach for, which is the sharper half
 *
 * Beadcause carries an incident register (`lib/incident.js`), an access register
 * (`lib/access.js`), a supplier register and a change sample. Wiring any of them into the
 * sections below would be the one mistake `lib/boundary.js` was written to make
 * impossible: **beadcause is carved out of this boundary**, so an incident in the daemon
 * is not an incident in the described system, and a daemon crash does not belong in a
 * report about home-energy assessments. Out of the boundary is not out of the audit — an
 * auditor testing CC8.1 still wants records out of beadcause — but the *description* is
 * about what a user entity reaches, and those registers describe something a user entity
 * has never heard of. `lib/servicescope.js` is excluded for the same reason and more
 * sharply: it is the control daemon's own controls, and a control over the tooling is not
 * a control in the description.
 *
 * The one exception is `lib/policies.js`, and it is an exception because of `HELD_BY`: the
 * policy set is Climative's, not beadcause's. A policy is an organisational document, and
 * the organisation is the service organisation.
 *
 * ## The election is a presumption until something records one
 *
 * Which trust services categories are in scope is an open decision (bc-4r10.4, bc-yfgo).
 * `describe` takes the elected criteria as an argument and the caller that has a real
 * election passes it. With none, it falls back to the categories `lib/policies.js` is
 * already written against — imported rather than restated, so the two can never disagree
 * — and marks the criteria section `presumed`. A presumption said out loud is a different
 * artefact from a default nobody noticed.
 *
 * ## What it does not cite, on purpose
 *
 * Each description criterion in DC section 200 carries a sub-letter. They are not written
 * below, because the letters are not knowable from here and a wrong citation in a document
 * an auditor reads is worse than no citation at all. Sections are named by what they are,
 * and the standard is cited as a whole.
 *
 * A leaf, like the three registers it joins: no state read, none written, no clock except
 * the one a caller passes for a policy review date. `sectionProblems` runs at import and
 * throws — a description generator that could ship with a section nobody generates is one
 * that emits a document with a heading and nothing under it.
 */
import { boundaryProblems, carvedOut, cuecs, gaps as boundaryGaps, inside, subservice, userEntities } from './boundary.js';
import { byFramework, control, frameworkOf, isControl, satisfiedBy } from './controls.js';
import { ELECTED, policiesFor, POLICIES, stateOf } from './policies.js';

const text = (v) => String(v ?? '').trim();

/* ------------------------------------------------------------ the vocabulary */

/**
 * What a section's content is worth, computed from what it was derived from.
 *
 * See the header. `unavailable` is not an error state — three of the fourteen sections are
 * unavailable in this release, and that is the honest description of a programme whose
 * commitments, changes and incidents nothing has recorded yet. It becomes an error only
 * where something signs.
 */
export const STATES = Object.freeze(['generated', 'partial', 'unavailable']);

/**
 * How a period is stated: a date for a Type I report, a range for a Type II.
 *
 * Both are here because the choice is open (bc-j0o3) and because they change what the
 * management assertion may claim — an `as-of` description asserts suitable design at a
 * date and cannot assert operating effectiveness over anything.
 */
export const PERIOD_KINDS = Object.freeze(['as-of', 'over']);

/**
 * The five components DC section 200 asks a description to enumerate, and the boundary
 * kinds each is drawn from.
 *
 * The mapping is stated once rather than inferred at each use, because the two vocabularies
 * are genuinely different shapes: the boundary records what a thing *is* to an auditor
 * walking the estate, and the description criteria ask for five headings a reader expects.
 *
 * `egress` sits under infrastructure because a destination in-scope traffic leaves for is
 * part of the network the system runs on; the data crossing it is described under data,
 * and a destination that processes data on the organisation's behalf is also a subservice
 * organisation, which is a separate section and a separate decision. `procedures` is drawn
 * from no boundary kind at all — it is the policy set, which is why the list is empty
 * rather than absent.
 */
export const COMPONENT_KINDS = Object.freeze({
  infrastructure: Object.freeze(['host', 'egress']),
  software: Object.freeze(['repo']),
  people: Object.freeze(['role']),
  procedures: Object.freeze([]),
  data: Object.freeze(['datastore']),
});

/**
 * The sections of a system description, closed.
 *
 * `must` is what the description criteria require of the section, in one sentence, and it
 * is printed in the document above the content so a reader can see what was asked for and
 * what arrived. `heldElsewhere` is only on the sections nothing here derives: it names the
 * *kind* of source that holds the answer, which is a property of the description criterion
 * rather than a fact about anybody's estate, and it is what turns an empty section into an
 * errand somebody can run.
 */
export const SECTIONS = Object.freeze([
  {
    id: 'services',
    title: 'The services provided',
    must: 'What the system does, for whom, and where its boundary runs.',
    heldElsewhere: null,
  },
  {
    id: 'commitments',
    title: 'Principal service commitments and system requirements',
    must:
      'What the service organisation has committed to its user entities — availability, confidentiality, ' +
      'processing and privacy commitments — and the system requirements those commitments impose.',
    heldElsewhere:
      'the contracts, service level agreements, privacy notices and published commitments the service ' +
      'organisation has made to its user entities. Nothing in this release records a commitment, and a ' +
      'commitment inferred from a control is a promise nobody made.',
  },
  {
    id: 'infrastructure',
    title: 'Components — infrastructure',
    must: 'The physical and virtual estate the system runs on.',
    heldElsewhere: null,
  },
  {
    id: 'software',
    title: 'Components — software',
    must: 'The programs and repositories that make up the system.',
    heldElsewhere: null,
  },
  {
    id: 'people',
    title: 'Components — people',
    must: 'The roles that operate, develop, support and govern the system, human and non-human.',
    heldElsewhere: null,
  },
  {
    id: 'procedures',
    title: 'Components — procedures',
    must: 'The automated and manual procedures the system is operated by, and the documents stating them.',
    heldElsewhere: null,
  },
  {
    id: 'data',
    title: 'Components — data',
    must: 'What the system holds and processes, and where it rests.',
    heldElsewhere: null,
  },
  {
    id: 'environment',
    title: 'Control environment, risk assessment, monitoring, and information and communication',
    must:
      'The aspects of the four components of internal control that are relevant to the services, which ' +
      'the common criteria CC1 to CC5 are the restatement of.',
    heldElsewhere: null,
  },
  {
    id: 'criteria',
    title: 'The applicable trust services criteria and the related controls',
    must: 'Each criterion in scope, and the controls the service organisation operates to meet it.',
    heldElsewhere: null,
  },
  {
    id: 'excluded',
    title: 'Criteria that are not relevant, and why',
    must: 'Every criterion the corpus mints that is not in scope, with the reason it is not.',
    heldElsewhere: null,
  },
  {
    id: 'subservice',
    title: 'Subservice organisations, and the method applied to each',
    must:
      'Every organisation whose controls the system depends on, whether it is carved out or included, and ' +
      'for a carve-out the controls that organisation is expected to operate.',
    heldElsewhere: null,
  },
  {
    id: 'cuecs',
    title: 'Complementary user entity controls',
    must: 'What each user entity must operate for the controls described here to meet the criteria.',
    heldElsewhere: null,
  },
  {
    id: 'changes',
    title: 'Significant changes during the period',
    must: 'Changes to the system in the period that a user entity would need to know about.',
    heldElsewhere:
      'the change record of the repositories and infrastructure inside the boundary. Beadcause holds change ' +
      'evidence for the repositories it orchestrates, which is a superset and a different set: until the ' +
      'in-scope repositories are enumerated (bc-j8pz) nothing can say which of those changes were changes ' +
      'to this system.',
  },
  {
    id: 'incidents',
    title: 'Incidents during the period',
    must:
      'Identified incidents in the period that were the result of a control not being suitably designed or ' +
      'not operating, or that otherwise resulted in a commitment or requirement not being met.',
    heldElsewhere:
      "the in-scope system's own incident record. Beadcause carries an incident register, and it is the " +
      'register of a component this boundary carves out — a daemon crash is not an incident in the described ' +
      'system, and reporting one here would put development tooling into a report about the service.',
  },
]);

/** The section ids, in document order. */
export const SECTION_IDS = Object.freeze(SECTIONS.map((s) => s.id));

/**
 * The three sections nothing in this release derives, and the seam by which they arrive.
 *
 * Without this they are dead by construction: `--strict` would be permanently red and
 * `assertionProblems` permanently non-empty, whatever anybody recorded, and a gate nobody
 * can ever pass is a gate somebody eventually deletes. `lib/boundary.js` makes the same
 * argument about its CUEC gap, and reaches the same conclusion — gate on what is closable.
 *
 * So a caller may **supply a record** for one of these, and only these. It is not a
 * loophole for prose: an entry needs a `statement` and a `source` naming where the fact is
 * recorded — the contract, the change record, the incident log — and {@link
 * suppliedProblems} refuses one without. That is the same bar the rest of the document is
 * held to, applied to a register that has not been built yet.
 *
 * **Deliberately not exposed on the command line.** The seam is for the module that lands
 * a commitments register, not for a person with a JSON file: a flag would make a
 * hand-written section reachable in one step, which is the thing this whole file refuses.
 */
export const SUPPLIABLE = Object.freeze(['commitments', 'changes', 'incidents']);

/** What a supplied section records as its source. Not a module, because there is not one yet. */
const SUPPLIED_FROM = 'a record supplied by the caller';

/** The shortest a supplied statement or source may be, so a word is not a record. */
const SUPPLIED_MIN = 12;

/**
 * Everything wrong with a supplied record, as sentences.
 *
 * `source` is the field that matters. A commitment with no contract behind it, a change
 * with no change record and an incident with no incident record are all the same failure:
 * a sentence in an auditor's document that nothing else in the world corroborates.
 */
export function suppliedProblems(id, entries) {
  if (!SUPPLIABLE.includes(text(id))) return [`"${text(id)}" is not a section anything may supply — the rest are generated`];
  if (!Array.isArray(entries)) return [`supplied ${text(id)}: a list of entries is required, even an empty one`];
  const problems = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    const where = `supplied ${text(id)} ${text(e?.id) || `#${i}`}`;
    if (!text(e?.id)) problems.push(`${where}: an entry needs an id`);
    else if (seen.has(text(e.id))) problems.push(`${where}: supplied twice`);
    seen.add(text(e?.id));
    if (!text(e?.label)) problems.push(`${where}: needs a label a person can read`);
    if (text(e?.statement).length < SUPPLIED_MIN) problems.push(`${where}: needs a \`statement\` — what is being recorded, in a sentence`);
    if (text(e?.source).length < SUPPLIED_MIN) {
      problems.push(
        `${where}: needs a \`source\` naming where this is recorded — a ${text(id) === 'commitments' ? 'commitment' : 'fact'} ` +
          'nothing else corroborates is one this document invented'
      );
    }
  });
  return problems;
}

/**
 * Said once rather than left to be inferred from the absence of a `sign` function.
 *
 * A management assertion is a signed statement by a named person who is accountable for
 * it. Nothing below signs one, `assertion` always hands back `signed: false`, and there is
 * no argument that makes it true. A generator that could emit a signed assertion is a
 * generator that can forge one.
 */
export const SIGNING_IS_A_HUMAN_ACT = true;

/**
 * What management asserts when it signs, and what each assertion depends on.
 *
 * These are the three statements a SOC 2 assertion makes, and they are here rather than in
 * a template because two of them are conditional: operating effectiveness can only be
 * asserted over a period, so a Type I description must not carry it, and that is a rule
 * rather than a formatting choice.
 */
export const ASSERTIONS = Object.freeze([
  Object.freeze({
    id: 'description',
    kind: 'always',
    says: 'The description presents the system as it was designed and implemented, in accordance with the description criteria.',
  }),
  Object.freeze({
    id: 'design',
    kind: 'always',
    says: 'The controls stated in the description were suitably designed to provide reasonable assurance that the service commitments and system requirements would be achieved, if operated as described.',
  }),
  Object.freeze({
    id: 'operation',
    kind: 'over',
    says: 'The controls stated in the description operated effectively throughout the period.',
  }),
]);

/* ------------------------------------------------------------------ the period */

/** Everything wrong with a stated period, as sentences. Empty means it is well-shaped. */
export function periodProblems(period) {
  if (period === null || period === undefined) return ['a period is required — a description describes a system at a date or over a range'];
  if (typeof period !== 'object') return ['a period is an object, not a string'];
  const kind = text(period.kind);
  if (!PERIOD_KINDS.includes(kind)) {
    return [`period kind "${kind}" is not one of ${PERIOD_KINDS.join(', ')} — a date for a Type I report, a range for a Type II`];
  }
  const problems = [];
  const day = (v, name) => {
    const s = text(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      problems.push(`period ${name}: "${s}" is not a date — YYYY-MM-DD, so two descriptions can be compared`);
      return null;
    }
    return s;
  };
  if (kind === 'as-of') {
    day(period.asOf, 'asOf');
    if (period.from || period.to) problems.push('an as-of period has a single date and no range — a range is a Type II period, and it says something else');
  } else {
    const from = day(period.from, 'from');
    const to = day(period.to, 'to');
    if (from && to && from >= to) problems.push(`period: ${from} is not before ${to} — a period runs forwards`);
    if (period.asOf) problems.push('a period over a range has no `asOf` — the two forms assert different things and a record carrying both asserts neither');
  }
  return problems;
}

/** A period as a person reads it, or `null` when there is none. */
export function periodLabel(period) {
  if (periodProblems(period).length) return null;
  return period.kind === 'as-of' ? `as of ${text(period.asOf)}` : `${text(period.from)} to ${text(period.to)}`;
}

/* ------------------------------------------------------- the elected criteria */

/** Every SOC 2 criterion the corpus mints in these categories, in corpus order. */
export function criteriaFor(categories) {
  const wanted = (Array.isArray(categories) ? categories : []).map(text);
  return byFramework('SOC2')
    .filter((r) => wanted.includes(r.group))
    .map((r) => r.id);
}

/**
 * Split what a caller says is elected into what a description can use, and say the rest.
 *
 * Three outputs and none of them is silent: `elected` is the SOC 2 criteria the sections
 * below are scoped by, `elsewhere` is the 27001 and 42001 controls an election may also
 * hold — legitimate, and not trust services criteria, so they do not appear in the report's
 * section — and `dropped` is an id the corpus does not mint at all, which is the one that
 * has to be said out loud. `lib/beadreqs.js` hands back the same shape for the same reason.
 */
export function electedCriteria(criteria) {
  const elected = [];
  const elsewhere = [];
  const dropped = [];
  for (const raw of Array.isArray(criteria) ? criteria : []) {
    const id = text(raw);
    if (!id || elected.includes(id) || elsewhere.includes(id) || dropped.includes(id)) continue;
    if (!isControl(id)) dropped.push(id);
    else if (frameworkOf(id) === 'SOC2') elected.push(id);
    else elsewhere.push(id);
  }
  return { elected, elsewhere, dropped };
}

/* --------------------------------------------------------------- the sections */

/**
 * The state a section's content earns: complete, admits a hole, or was never derivable.
 *
 * An empty section with no hole is `generated` rather than `partial`, and that is the
 * census argument arriving one layer up: emptiness is only a claim because a census said
 * so, and where a census says otherwise it has already produced a hole. A rule that made
 * every empty section partial would make the two indistinguishable again.
 */
function stateOfSection(holes, derivable = true) {
  if (!derivable) return 'unavailable';
  return holes.length ? 'partial' : 'generated';
}

/** The census entry for a boundary kind, or an empty one. */
const censusOf = (record, kind) => record?.census?.[kind] || {};

/** A component, flattened to what a description prints. */
const componentEntry = (c) => ({
  id: text(c.id),
  kind: text(c.kind),
  label: text(c.label),
  disposition: text(c.disposition),
  why: text(c.why),
  bearsOn: text(c.bearsOn) || null,
});

/** One of the five component sections, from the boundary kinds it is drawn from. */
function componentSection(record, id) {
  const kinds = COMPONENT_KINDS[id];
  const entries = [];
  const holes = [];
  for (const kind of kinds) {
    for (const c of inside(record, kind)) entries.push(componentEntry(c));
    const census = censusOf(record, kind);
    if (census.state === 'partial') {
      holes.push({
        of: kind,
        held: text(census.held),
        why: text(census.note) || `the ${kind} list inside the boundary is partial`,
      });
    }
  }
  const carved = kinds.flatMap((kind) => carvedOut(record, kind)).map(componentEntry);
  return {
    entries,
    holes,
    carved,
    state: stateOfSection(holes),
    from: ['lib/boundary.js'],
  };
}

/** The procedures component: the controlled document set, which is the organisation's. */
function proceduresSection(record, { now, register }) {
  const entries = register.map((p) => {
    const { state, due } = stateOf(p, now);
    return {
      id: text(p.id),
      title: text(p.title),
      aim: text(p.aim),
      ownerRole: text(p.ownerRole),
      adoption: text(p.adoption),
      state,
      due: due || null,
      criteria: [...(p.criteria || [])],
      enforcedBy: [...(p.enforcedBy || [])],
      owes: text(p.owes) || null,
    };
  });
  const owed = entries.filter((e) => e.adoption !== 'adopted');
  const overdue = entries.filter((e) => e.state === 'overdue');
  const holes = [];
  if (owed.length) {
    holes.push({
      of: 'policy',
      held: 'the service organisation, which has to write and approve them',
      why:
        `${owed.length} of ${entries.length} policies are owed: the procedure is enforced by something in this ` +
        'release or by nothing at all, and no approved document states it. A description that printed them as ' +
        'procedures would describe documents that do not exist.',
    });
  }
  if (overdue.length) {
    holes.push({
      of: 'policy review',
      held: 'the owner of each document',
      why: `${overdue.length} approved polic${overdue.length === 1 ? 'y is' : 'ies are'} past the review date, which is the exception written up most often.`,
    });
  }
  return { entries, holes, carved: [], state: stateOfSection(holes), from: ['lib/policies.js'] };
}

/** One criterion, with everything the corpus and the policy set know about it. */
function criterionEntry(id, register) {
  const record = control(id);
  const documented = policiesFor(id, register);
  return {
    id,
    title: record?.title || null,
    definition: record?.definition || null,
    group: record?.group || null,
    groupName: record?.groupName || null,
    documentedBy: documented.map((p) => ({ id: text(p.id), title: text(p.title), adoption: text(p.adoption) })),
    enforcedBy: [...new Set(documented.flatMap((p) => p.enforcedBy || []))].sort(),
    alsoSatisfies: satisfiedBy(id),
  };
}

/**
 * A criteria section: a list of criteria, and what claims to meet each.
 *
 * Two sections use it — the elected criteria, and the CC1 to CC5 restatement of the four
 * components of internal control — because they are the same computation asked about
 * different lists, and writing it twice is how the two come to disagree about what
 * "documented" means. `noun` is what the holes call them, which is the only real
 * difference: one list is elected and the other is required of every SOC 2 report.
 */
function criteriaSection(ids, register, noun = 'elected criterion') {
  const entries = ids.map((id) => criterionEntry(id, register));
  const holes = [];
  const unclaimed = entries.filter((e) => !e.documentedBy.length);
  const undocumented = entries.filter((e) => e.documentedBy.length && !e.documentedBy.some((p) => p.adoption === 'adopted'));
  if (unclaimed.length) {
    holes.push({
      of: noun,
      held: 'the policy set, which has to grow to cover them',
      why:
        `${unclaimed.length} of ${entries.length} have no policy claiming to be the documented answer: ` +
        `${unclaimed.map((e) => e.id).join(', ')}. A criterion in no document is the drift an auditor finds first, ` +
        'because the set reads as complete.',
    });
  }
  if (undocumented.length) {
    holes.push({
      of: 'control',
      held: 'the service organisation, which has to approve the documents',
      why:
        `${undocumented.length} of ${entries.length} are claimed only by policies that are owed, so the control stated ` +
        'against them is an intention rather than an operating control.',
    });
  }
  return { entries, holes, carved: [], state: stateOfSection(holes), from: ['lib/controls.js', 'lib/policies.js'] };
}

/**
 * The criteria the control-environment section is the description of, read off the corpus.
 *
 * CC1 to CC5 are the TSC's restatement of four of the five COSO components — control
 * environment, risk assessment, information and communication, monitoring — which is
 * exactly what the description criteria ask this section to cover. Computed from the
 * corpus rather than listed here, so a corpus that grows a CC3.5 grows this too.
 *
 * They are here whether or not they are elected, because they are in every SOC 2 report:
 * the common criteria are not a category anybody chooses.
 */
export const ENVIRONMENT_CRITERIA = Object.freeze(
  byFramework('SOC2')
    .filter((r) => /^CC[1-5]\./.test(r.local))
    .map((r) => r.id)
);

/** Every criterion the corpus mints that is not elected — the disclosure, with the hole in it. */
function excludedSection(elected) {
  const entries = byFramework('SOC2')
    .filter((r) => !elected.includes(r.id))
    .map((r) => ({ id: r.id, title: r.title, group: r.group, groupName: r.groupName }));
  const holes = entries.length
    ? [
        {
          of: 'reason',
          held: 'the election, which has to record why a category was not elected',
          why:
            `${entries.length} criteria are outside the scope of this description and nothing records why. The list is ` +
            'exact and the reasons are owed — the description criteria ask for the reason, not the count.',
        },
      ]
    : [];
  return { entries, holes, carved: [], state: stateOfSection(holes), from: ['lib/controls.js'] };
}

/**
 * A section that arrives from a caller's record, or, with none, one that says so.
 *
 * The absence is the ordinary case and it is not an error — see {@link SUPPLIABLE}.
 */
function suppliedSection(id, supplied) {
  const entries = (supplied || {})[id];
  if (!Array.isArray(entries) || !entries.length) return { entries: [], holes: [], carved: [], state: 'unavailable', from: [] };
  return {
    entries: entries.map((e) => ({ id: text(e.id), label: text(e.label), statement: text(e.statement), source: text(e.source) })),
    holes: [],
    carved: [],
    state: 'generated',
    from: [SUPPLIED_FROM],
  };
}

/** The generators, by section id. Checked against SECTION_IDS at import. */
const GENERATORS = {
  services: (record) => {
    const census = censusOf(record, 'user-entity');
    const holes =
      census.state === 'partial'
        ? [{ of: 'user entity', held: text(census.held), why: text(census.note) || 'the user entity list is partial' }]
        : [];
    return {
      entries: userEntities(record).map((e) => ({ id: text(e.id), label: text(e.label), why: text(e.why), source: text(e.source) || null })),
      holes,
      carved: [],
      state: stateOfSection(holes),
      from: ['lib/boundary.js'],
    };
  },
  commitments: (record, { supplied }) => suppliedSection('commitments', supplied),
  infrastructure: (record) => componentSection(record, 'infrastructure'),
  software: (record) => componentSection(record, 'software'),
  people: (record) => componentSection(record, 'people'),
  procedures: (record, opts) => proceduresSection(record, opts),
  data: (record) => componentSection(record, 'data'),
  environment: (record, { register }) => criteriaSection(ENVIRONMENT_CRITERIA, register, 'criterion this section must describe'),
  criteria: (record, { elected, register }) => criteriaSection(elected, register),
  excluded: (record, { elected }) => excludedSection(elected),
  subservice: (record) => {
    const entries = subservice(record).map((s) => ({
      id: text(s.id),
      label: text(s.label),
      method: text(s.method),
      provides: text(s.provides),
      cuecs: [...(s.cuecs || [])],
    }));
    const census = censusOf(record, 'subservice');
    const holes =
      census.state === 'partial'
        ? [{ of: 'subservice organisation', held: text(census.held), why: text(census.note) || 'the subservice list is partial' }]
        : [];
    return { entries, holes, carved: [], state: stateOfSection(holes), from: ['lib/boundary.js'] };
  },
  cuecs: (record) => {
    const entries = cuecs(record).map((c) => ({ control: text(c.control), from: text(c.from), label: text(c.label) }));
    const holes = boundaryGaps(record)
      .filter((g) => g.kind === 'cuec')
      .map((g) => ({ of: 'complementary control', held: text(g.held), why: text(g.why) }));
    return { entries, holes, carved: [], state: stateOfSection(holes), from: ['lib/boundary.js'] };
  },
  changes: (record, { supplied }) => suppliedSection('changes', supplied),
  incidents: (record, { supplied }) => suppliedSection('incidents', supplied),
};

/**
 * Everything wrong with the section table, as sentences.
 *
 * Thrown at import below. A section with no generator emits a heading with nothing under
 * it, and a generator with no section emits nothing at all while looking maintained — the
 * two halves have to be the same set, and the moment to find out is `npm test` importing
 * this file rather than the first person to run the report.
 */
export function sectionProblems(sections = SECTIONS, generators = GENERATORS) {
  const problems = [];
  const ids = new Set();
  for (const s of sections) {
    const id = text(s?.id);
    if (!id) problems.push('a section needs an id');
    if (ids.has(id)) problems.push(`section ${id}: declared twice`);
    ids.add(id);
    if (!text(s?.title)) problems.push(`section ${id}: needs a title`);
    if (!text(s?.must)) problems.push(`section ${id}: needs a \`must\` — what the description criteria ask of it`);
    if (typeof generators[id] !== 'function') problems.push(`section ${id}: nothing generates it, so it would print as a heading with nothing under it`);
  }
  for (const id of Object.keys(generators)) {
    if (!ids.has(id)) problems.push(`a generator for "${id}", which is not a section — it would never run`);
  }
  for (const [id, kinds] of Object.entries(COMPONENT_KINDS)) {
    if (!ids.has(id)) problems.push(`COMPONENT_KINDS names "${id}", which is not a section`);
    if (!Array.isArray(kinds)) problems.push(`COMPONENT_KINDS.${id} must be a list of boundary kinds, even an empty one`);
  }
  return problems;
}

/* -------------------------------------------------------------- the description */

/**
 * The system description for one boundary record.
 *
 * Throws on a record `lib/boundary.js` refuses, and that is deliberate rather than
 * defensive: every other reader in this layer answers empty on junk because an absent
 * boundary is an ordinary state, but a *description* is the artefact an auditor reads, and
 * generating one from a record that does not validate is exactly how a document that looks
 * finished gets produced. There is no half-description worth having.
 *
 * `criteria` is what the install has elected. With none, the categories `lib/policies.js`
 * is written against stand in and the result says `presumed`.
 */
export function describe(record, { criteria = null, period = null, now = new Date(), register = POLICIES, supplied = null } = {}) {
  const broken = boundaryProblems(record);
  if (broken.length) {
    throw new Error(`lib/systemdescription.js: cannot describe a system whose boundary does not validate —\n  ${broken.join('\n  ')}`);
  }
  const badly = Object.keys(supplied || {}).flatMap((id) => suppliedProblems(id, supplied[id]));
  if (badly.length) {
    throw new Error(`lib/systemdescription.js: a supplied record does not validate —\n  ${badly.join('\n  ')}`);
  }

  const presumed = !Array.isArray(criteria);
  const chosen = electedCriteria(presumed ? criteriaFor(ELECTED) : criteria);
  const opts = { elected: chosen.elected, register, now, supplied };

  const sections = SECTIONS.map((s) => {
    const generated = GENERATORS[s.id](record, opts);
    return Object.freeze({
      id: s.id,
      title: s.title,
      must: s.must,
      state: generated.state,
      from: Object.freeze([...generated.from]),
      heldElsewhere: generated.state === 'unavailable' ? s.heldElsewhere : null,
      entries: Object.freeze(generated.entries),
      carved: Object.freeze(generated.carved || []),
      holes: Object.freeze(generated.holes),
    });
  });

  const states = Object.fromEntries(STATES.map((s) => [s, sections.filter((x) => x.state === s).length]));
  return Object.freeze({
    organisation: text(record.organisation),
    serviceOrganisation: text(record.serviceOrganisation),
    system: text(record.system),
    statement: text(record.statement),
    decidedBy: text(record.decidedBy),
    period: period && !periodProblems(period).length ? Object.freeze({ ...period }) : null,
    criteria: Object.freeze({ ...chosen, presumed }),
    sections: Object.freeze(sections),
    states: Object.freeze(states),
    writable: states.unavailable === 0,
  });
}

/** One section of a generated description, or `null`. */
export const section = (description, id) => (description?.sections || []).find((s) => s.id === text(id)) || null;

/** The sections nothing in this release can write, with where the answer is held. */
export const unwritable = (description) => (description?.sections || []).filter((s) => s.state === 'unavailable');

/** Every hole any section admits to, flattened, which is what a readiness review works through. */
export const holes = (description) =>
  (description?.sections || []).flatMap((s) => s.holes.map((h) => ({ section: s.id, ...h })));

/**
 * Everything wrong with a generated description, as sentences.
 *
 * Not a re-run of the boundary's validation — `describe` already refused a record that
 * failed that. This is about the document: a section missing, a state that is not one, a
 * section that says nothing derives it and does not say where the answer lives.
 */
export function descriptionProblems(description) {
  if (!description || typeof description !== 'object') return ['a generated description is required'];
  const problems = [];
  const ids = (description.sections || []).map((s) => s.id);
  for (const id of SECTION_IDS) if (!ids.includes(id)) problems.push(`the description is missing its ${id} section`);
  for (const s of description.sections || []) {
    if (!STATES.includes(s.state)) problems.push(`section ${s.id}: state "${text(s.state)}" is not one of ${STATES.join(', ')}`);
    if (s.state === 'unavailable' && !text(s.heldElsewhere)) {
      problems.push(
        `section ${s.id}: nothing derives it and it does not say where the answer is held — an empty section with no ` +
          'errand attached reads as "there is nothing to say"'
      );
    }
    if (s.state !== 'unavailable' && !s.from.length) {
      problems.push(`section ${s.id}: content with nothing recorded as its source is content somebody wrote by hand`);
    }
  }
  for (const id of description.criteria?.dropped || []) {
    problems.push(`elected criterion ${id} is not in the control corpus — a criterion nobody minted covers nothing`);
  }
  return problems;
}

/* ------------------------------------------------------------- the assertion */

/**
 * The management assertion, as a draft — never as a signed statement.
 *
 * `signed` is `false` and there is no way to make it true from here; see
 * {@link SIGNING_IS_A_HUMAN_ACT}. A signatory may be named because naming who is *going*
 * to sign is a useful part of a draft and is not a signature.
 *
 * The operating-effectiveness assertion appears only over a period, because it cannot be
 * made about a date. That is the whole difference between a Type I and a Type II report,
 * and putting it in a template that quietly keeps it would be the drafting error that
 * matters most.
 */
export function assertion(description, { signatory = null, title = null } = {}) {
  const period = description?.period || null;
  const kind = text(period?.kind);
  const says = ASSERTIONS.filter((a) => a.kind === 'always' || a.kind === kind);
  return Object.freeze({
    serviceOrganisation: text(description?.serviceOrganisation),
    system: text(description?.system),
    period: period ? Object.freeze({ ...period }) : null,
    periodLabel: periodLabel(period),
    signatory: signatory ? Object.freeze({ name: text(signatory), title: text(title) || null }) : null,
    signed: false,
    says: Object.freeze(says.map((a) => Object.freeze({ id: a.id, says: a.says }))),
    problems: Object.freeze(assertionProblems(description, { signatory })),
  });
}

/**
 * Why this assertion may not be signed yet, as sentences. Empty means a person may sign it.
 *
 * Every one of these is a thing that would make the signed statement false rather than
 * untidy, which is the bar: a signatory asserting that a description meets the description
 * criteria, when six of its sections say nothing derives them, is asserting something that
 * is not true.
 */
export function assertionProblems(description, { signatory = null } = {}) {
  const problems = [];
  if (!description || typeof description !== 'object') return ['a generated description is required before anything can be asserted about it'];
  problems.push(...periodProblems(description.period).map((p) => `period: ${p}`));
  if (!text(signatory)) {
    problems.push('nobody is named to sign it — an assertion is a statement by a person who is accountable for it, and an unsigned one asserts nothing');
  }
  const missing = unwritable(description);
  if (missing.length) {
    problems.push(
      `${missing.length} section${missing.length === 1 ? '' : 's'} cannot be written from any record in this release ` +
        `(${missing.map((s) => s.id).join(', ')}) — the first thing management asserts is that the description meets the ` +
        'description criteria, and a description with a section nobody can write does not'
    );
  }
  if (description.criteria?.presumed) {
    problems.push(
      'the criteria in scope are presumed from the policy set rather than elected — an assertion about controls meeting ' +
        'criteria has to name criteria somebody chose'
    );
  }
  const open = holes(description);
  if (open.length) {
    problems.push(
      `the record admits to ${open.length} hole${open.length === 1 ? '' : 's'} across ` +
        `${new Set(open.map((h) => h.section)).size} section${new Set(open.map((h) => h.section)).size === 1 ? '' : 's'} — a ` +
        'description may be signed with known gaps stated, but not with gaps nobody has read; work through `holes()` first'
    );
  }
  return problems;
}

/* --------------------------------------------------------------- the rendering */

/** The description in one line, for a log, a card or a check. */
export function summarise(description) {
  const s = description?.states || {};
  const open = holes(description).length;
  return (
    `${text(description?.serviceOrganisation)} · ${text(description?.system)}` +
    `${description?.period ? ` · ${periodLabel(description.period)}` : ' · no period stated'} · ` +
    `${description?.criteria?.elected?.length || 0} criteria${description?.criteria?.presumed ? ' (presumed)' : ''} · ` +
    `${s.generated || 0} generated, ${s.partial || 0} partial, ${s.unavailable || 0} unavailable · ` +
    `${open} hole${open === 1 ? '' : 's'}`
  );
}

const md = (s) => String(s ?? '');

/** One section as markdown. Every line of it comes from a record; none of it is prose. */
function renderSection(s, index) {
  const out = [`## ${index}. ${s.title}`, '', `*${s.must}*`, ''];
  if (s.state === 'unavailable') {
    out.push(`**Not yet derivable.** This section is held in ${s.heldElsewhere}`, '');
    return out;
  }
  out.push(`*Generated from ${s.from.join(', ')}.*`, '');

  if (!s.entries.length) out.push('_Nothing recorded._');
  for (const e of s.entries) {
    if (SUPPLIABLE.includes(s.id)) out.push(`- **${md(e.label)}** — ${md(e.statement)} (recorded in ${md(e.source)})`);
    else if (s.id === 'services') out.push(`- **${md(e.label)}** — ${md(e.why)}${e.source ? ` (recorded from ${md(e.source)})` : ''}`);
    else if (s.id === 'procedures') {
      out.push(
        `- **${md(e.title)}** — ${md(e.aim)}`,
        `  Owner: ${md(e.ownerRole)}. State: **${md(e.state)}**${e.due ? `, review due ${md(e.due)}` : ''}.` +
          `${e.enforcedBy.length ? ` Already enforced by ${e.enforcedBy.join(', ')}.` : ' Nothing here enforces it.'}` +
          `${e.owes ? ` Owes: ${md(e.owes)}` : ''}`
      );
    } else if (s.id === 'criteria' || s.id === 'environment') {
      out.push(
        `- **${md(e.id)} — ${md(e.title)}**`,
        `  ${md(e.definition)}`,
        `  Documented by: ${e.documentedBy.length ? e.documentedBy.map((p) => `${md(p.title)} (${md(p.adoption)})`).join('; ') : '_no policy claims it_'}.` +
          `${e.enforcedBy.length ? ` Enforced by ${e.enforcedBy.join(', ')}.` : ''}` +
          `${e.alsoSatisfies.length ? ` Also satisfied by ${e.alsoSatisfies.join(', ')}.` : ''}`
      );
    } else if (s.id === 'excluded') out.push(`- ${md(e.id)} — ${md(e.title)} (${md(e.groupName)})`);
    else if (s.id === 'subservice') {
      out.push(`- **${md(e.label)}** — ${md(e.method)}. ${md(e.provides)}`);
      for (const c of e.cuecs) out.push(`  - CUEC: ${md(c)}`);
    } else if (s.id === 'cuecs') out.push(`- ${md(e.control)} (from ${md(e.label)})`);
    else out.push(`- **${md(e.label)}** (${md(e.kind)}) — ${md(e.why)}`);
  }
  out.push('');

  if (s.carved.length) {
    out.push('**Carved out of the description**, and named so the omission is a decision rather than a blank:', '');
    for (const c of s.carved) {
      out.push(`- **${md(c.label)}** (${md(c.kind)}) — ${md(c.why)}${c.bearsOn ? ` Bears on: ${md(c.bearsOn)}` : ''}`);
    }
    out.push('');
  }

  if (s.holes.length) {
    out.push('**What this section does not yet know:**', '');
    for (const h of s.holes) out.push(`- *${md(h.of)}* — ${md(h.why)}${h.held ? ` Held in ${md(h.held)}.` : ''}`);
    out.push('');
  }
  return out;
}

/**
 * The description as markdown.
 *
 * **Nothing here stamps the moment it ran**, and that is the second half of the argument
 * for generating it at all: the value of a generated description is that the diff between
 * two of them is reviewable, and a generation timestamp in the body makes every diff
 * non-empty. The period is in it, because that is a fact about the report; the minute
 * somebody typed the command is not.
 */
export function render(description) {
  const out = [
    `# ${md(description.serviceOrganisation)} — description of the ${md(description.system)} system`,
    '',
    md(description.statement),
    '',
    `**Period:** ${description.period ? periodLabel(description.period) : '_not stated_'}  `,
    `**Criteria in scope:** ${description.criteria.elected.length}${description.criteria.presumed ? ' (presumed from the policy set — no election is recorded)' : ''}  `,
    `**Boundary decided on:** ${md(description.decidedBy)}`,
    '',
    'Generated from the boundary record, the control corpus and the policy set. No section of this document is ' +
      'hand-written, and a section nothing can derive says so rather than being left blank.',
    '',
  ];
  if (!description.writable) {
    out.push(
      `> **This description is not yet complete.** ${unwritable(description).length} of ${description.sections.length} ` +
        'sections cannot be derived from any record in this release. They are marked below, with where the answer is held.',
      ''
    );
  }
  description.sections.forEach((s, i) => out.push(...renderSection(s, i + 1)));
  out.push('---', '', summarise(description), '');
  return out.join('\n');
}

/** The management assertion draft as markdown, with what stops it being signed on it. */
export function renderAssertion(a) {
  const out = [
    `# Management assertion — ${md(a.serviceOrganisation)} (DRAFT, UNSIGNED)`,
    '',
    `Regarding the description of the ${md(a.system)} system ${a.periodLabel || '_over a period nobody has stated_'}.`,
    '',
    'We assert that:',
    '',
  ];
  a.says.forEach((s, i) => out.push(`${i + 1}. ${md(s.says)}`));
  out.push('', `**Signed:** ${a.signatory ? `${md(a.signatory.name)}${a.signatory.title ? `, ${md(a.signatory.title)}` : ''} — _pending signature_` : '_nobody is named to sign this_'}`, '');
  if (a.problems.length) {
    out.push('> **This draft may not be signed yet.** A generator produces the draft; a named person signs it, and only once:', '');
    for (const p of a.problems) out.push(`> - ${md(p)}`);
    out.push('');
  }
  return out.join('\n');
}

const BROKEN = sectionProblems();
if (BROKEN.length) {
  throw new Error(`lib/systemdescription.js: the section table is broken —\n  ${BROKEN.join('\n  ')}`);
}
