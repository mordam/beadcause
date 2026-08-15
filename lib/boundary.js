/**
 * The system boundary, as data — what is inside it, what is carved out, and who the
 * report is written for.
 *
 * A SOC 2 report is not about an organisation. It is about a **system** — infrastructure,
 * software, people, procedures and data — inside a stated boundary, described to named
 * **user entities**. Everything downstream is scoped by it: which criteria are worth
 * electing, which controls are tested, which population a sample is drawn from. An
 * argued boundary is the cheapest lever in the whole programme, and it is the one most
 * often written as a paragraph in a document that nothing can read.
 *
 * So it is a record here, and lib/election.js's `declare` takes its projection rather
 * than a paragraph somebody typed. `declaration` below is that projection, which is what
 * stops the scope statement an auditor reads and the boundary a gate cites from ever
 * being two different claims maintained by two different people.
 *
 * **The subject was decided, not assumed** (bc-228x). Climative's Energy Navigator /
 * Insights platform is the system, Climative is the service organisation, and beadcause
 * — the thing you are reading — sits *outside* that boundary. Adam's words: "beadcause
 * is not part of that boundary. and yes we'll be using Climative as our first service
 * organization." Both halves of that sentence are load-bearing and both are recorded
 * below: the carve-out, and *first*.
 *
 * **Outside the boundary is not outside the audit, and conflating the two is the mistake
 * this file exists to make impossible.** Beadcause opens the agent sessions that change
 * the repositories the in-scope system is built from, which puts it in the change-
 * management path whether or not it is part of what is described to a user entity. The
 * distinction is between what is *described* and what is *tested*: a carve-out is a
 * statement about the system description, and it carries no implication at all about
 * whether an auditor testing CC8.1 will want records out of the carved-out thing. So a
 * carved-out component may name what it still `bearsOn`, and beadcause names change
 * management. A carve-out with nothing recorded against it is the shape of an omission
 * wearing a decision's clothes.
 *
 * **A census is a field, because the alternative is a blank that reads as an answer.**
 * This is the design decision worth arguing with. Almost nothing about Energy Navigator's
 * internals is knowable from this repository — the repositories, hosts, data stores and
 * egress destinations inside the boundary are enumerated in the Climative architecture
 * repository and the `cl-` tracker, not here. The two tempting shapes are both wrong: an
 * empty list reads as "there are none", and omitting the field reads as "not applicable".
 * Neither is true, and both validate perfectly. So every kind of thing a boundary can
 * contain carries a `census` — `enumerated` or `partial` — and a `partial` one must name
 * where the authoritative enumeration is `held`. An empty subservice list under a partial
 * census says *nobody has surveyed the processors yet*, which is a finding somebody can
 * act on; the same empty list with no census says *there are none*, which is false and
 * unfalsifiable at the same time. `gaps` is what turns those into sentences.
 *
 * **The carve-outs are enumerated even though the inside is not, and that asymmetry is
 * real rather than convenient.** Carving something out is a decision, and this repository
 * can make it in full: everything beadcause is, is knowable from here. Enumerating what
 * is *inside* is a survey of somebody else's estate. So a census answers for the inside
 * list only — `CARVE_OUTS_ARE_ENUMERATED` says that in one place rather than leaving it
 * to be inferred from a field that does not exist.
 *
 * **Multi-tenant from the first line, for lib/organisation.js's reason.** `BOUNDARIES` is
 * a map keyed by organisation id and not a constant, while there is exactly one entry and
 * it costs nothing. A boundary written as a singleton is a boundary that becomes a
 * migration the day a second service organisation enrols, and that migration is over the
 * one record whose entire value is that it has not changed silently.
 *
 * A leaf, like lib/publishable.js and lib/evidence.js: the register ships compiled into
 * the release, reads no state and writes none. `registryProblems` runs at import and
 * throws, the way lib/controls.js refuses a corpus with a duplicate id — a boundary you
 * could ship broken is a boundary that answers "nothing is carved out" on the machine
 * that is enforcing against it.
 */
import { orgProblems } from './organisation.js';

/**
 * The kinds of thing a boundary contains.
 *
 * The first four are the estate — what an auditor walks. `role` is both human and
 * non-human, deliberately one kind rather than two: an agent that can open a pull request
 * against an in-scope repository and an engineer who can are the same question asked of a
 * control, and splitting them is how the non-human half ends up unenumerated.
 */
export const KINDS = Object.freeze(['repo', 'host', 'datastore', 'egress', 'role']);

/**
 * What a component's presence in the record means. There are two, and there is no third.
 *
 * `unknown` is deliberately absent. A thing nobody has decided about is not a component
 * with a state — it is a thing not yet in the list, and the census is what says so.
 * Giving a component an `unknown` disposition makes the census redundant and then wrong,
 * because a survey that is complete except for the undecided ones reads as complete.
 */
export const DISPOSITIONS = Object.freeze(['inside', 'carved-out']);

/**
 * What a subservice organisation's controls do to this report.
 *
 * `carve-out` leaves them out of the description and shifts the reliance onto the user
 * entity, which is why a carve-out here owes at least one CUEC. `inclusive` drags the
 * subservice organisation's own controls into the test population, which is a far larger
 * promise and is why it is never the quiet default.
 */
export const METHODS = Object.freeze(['carve-out', 'inclusive']);

/** How complete the *inside* list is for a kind. See the header. */
export const CENSUS = Object.freeze(['enumerated', 'partial']);

/** Everything that gets a census: every kind, plus the two lists beside them. */
export const CENSUS_KINDS = Object.freeze([...KINDS, 'subservice', 'user-entity']);

/**
 * Said once, out loud, rather than inferred from the absence of a field.
 *
 * A census is about the inside list. Carve-outs are decisions this repository can make in
 * full, so the carve-out list in a record is complete by construction and `boundaryProblems`
 * holds it to that: every carved-out component must carry a reason.
 */
export const CARVE_OUTS_ARE_ENUMERATED = true;

/** The shortest a `why` may be — long enough that a word is not an argument. */
const WHY_MIN = 20;

/** The shortest a scope statement may be. It is the first thing an auditor reads. */
const STATEMENT_MIN = 60;

/** A component or entity id: the same alphabet lib/organisation.js allows, for keys. */
const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/* --------------------------------------------------------------- the register */

/**
 * Climative — the first service organisation, and today the only one.
 *
 * Everything inside the boundary is held elsewhere and the record says so per kind rather
 * than by being short. Everything carved out is here in full, because carving out is a
 * decision made in this repository about things this repository knows.
 */
const CLIMATIVE = {
  organisation: 'climative',
  system: 'Energy Navigator / Insights',
  serviceOrganisation: 'Climative',
  first: true,
  decidedBy: 'bc-228x',
  statement:
    'The Energy Navigator and Insights platform operated by Climative — the services its user ' +
    'entities reach, the data they submit and the reporting they receive. The tooling Climative ' +
    'builds it with is outside the boundary and named as carved out below.',

  /**
   * Every component the record has an opinion about.
   *
   * All of them are carve-outs today, and that is the honest state rather than an
   * oversight: see the census. The six agent roles are enumerated individually because
   * "what non-human identity can change an in-scope repository" is a question an auditor
   * asks per identity, and a single row saying "beadcause agents" answers it for none of
   * them.
   */
  components: [
    {
      id: 'beadcause',
      kind: 'repo',
      label: 'the management system itself',
      disposition: 'carved-out',
      why:
        'Development-side tooling. It is not reached by a user entity, holds none of their data, and ' +
        'is not part of what the report describes. It is carved out of the description, not excused ' +
        'from the audit.',
      bearsOn:
        'Change management. Beadcause opens the agent sessions that change the repositories the ' +
        'in-scope system is built from, so an auditor testing SOC 2 CC8.1 or ISO/IEC 27001 A.8.32 ' +
        'will want records out of it.',
    },
    {
      id: 'beadcause-host',
      kind: 'host',
      label: 'the Mac the beadcause daemon and its agent sessions run on',
      disposition: 'carved-out',
      why:
        'A development workstation running the carved-out tooling. It serves no user entity traffic ' +
        'and stores no user entity data; what it holds is beadcause state and checkouts of ' +
        'repositories whose authoritative copies are elsewhere.',
      bearsOn:
        'Logical access. It holds the git and tracker identities every agent acts under, so who can ' +
        'reach it is a question about the change-management path.',
    },
    ...[
      ['console', 'the chat session', 'proposes beads for a person to approve, and files nothing on its own'],
      ['dispatch', 'the comment answerer', 'answers a question bead from the phone'],
      ['advocate', 'the repo advocate', 'surveys a repository and proposes what is worth doing next'],
      ['epic-advocate', 'the P0 advocate', 'plans one owned P0, files its children and carries them to release'],
      ['worker', 'the work session', 'does the work in a terminal, on a branch, and delivers a pull request'],
      ['merge-advocate', 'the merge queue', "merges other agents' pull requests and closes the work bead"],
    ].map(([id, title, does]) => ({
      id: `agent-${id}`,
      kind: 'role',
      label: `beadcause agent, ${title}`,
      disposition: 'carved-out',
      why:
        `A non-human identity inside the carved-out tooling: it ${does}. It has no credential for the ` +
        'in-scope system and no route to a user entity, and acts only under the identity of the person ' +
        'whose machine it runs on.',
      bearsOn:
        'Change management and logical access — it is an actor in the path by which in-scope code ' +
        'changes, and it is one of the identities a change is attributable to.',
    })),
  ],

  /**
   * Who the report is written for.
   *
   * Recorded from bc-228x and nowhere else, which is why `source` is on each of them: a
   * user entity that appeared without a decision behind it is the field most likely to be
   * quietly wrong, and the one hardest to notice.
   */
  userEntities: [
    {
      id: 'nyserda',
      label: 'NYSERDA',
      why:
        'Named by Adam as a user entity of the Energy Navigator / Insights platform when the subject ' +
        'of the engagement was settled.',
      source: 'bc-228x',
    },
    {
      id: 'td',
      label: 'TD',
      why:
        'Named by Adam as a user entity of the Energy Navigator / Insights platform when the subject ' +
        'of the engagement was settled.',
      source: 'bc-228x',
    },
  ],

  /** Nobody has surveyed these yet. The census below is what says so. */
  subservice: [],

  /**
   * How complete each list is, and where the rest of it lives.
   *
   * Six of the seven are `partial` and that is the finding this record exists to make
   * legible. `held` is not decoration — it is the address somebody goes to in order to
   * close the gap, and a partial census without one is a shrug with a schema.
   */
  census: {
    repo: {
      state: 'partial',
      held: 'github.com/Climative/architecture, and the cl- tracker inside it',
      note:
        'Roughly forty service repositories share the Climative tracker. Which of them build the ' +
        'in-scope system, and which are internal tooling like this one, is a survey nobody has done.',
    },
    host: {
      state: 'partial',
      held: 'github.com/Climative/architecture',
      note: 'The hosting estate for Energy Navigator / Insights has not been enumerated here.',
    },
    datastore: {
      state: 'partial',
      held: 'github.com/Climative/architecture',
      note:
        'Where user entity data rests, and under whose keys, is the enumeration a Confidentiality or ' +
        'Privacy election would be scoped by. It is not written down here.',
    },
    egress: {
      state: 'partial',
      held: 'github.com/Climative/architecture',
      note:
        'Every destination in-scope traffic leaves for. bc-eqn1.9 builds the supplier register for ' +
        "beadcause's own egress; the in-scope system's is a separate survey.",
    },
    role: {
      state: 'partial',
      held: 'Climative, as an organisation chart the tracker does not hold',
      note:
        'The six carved-out agent roles are enumerated in full because this repository mints them. ' +
        'The human roles inside the boundary — who operates, who deploys, who supports — are not ' +
        'knowable from here.',
    },
    subservice: {
      state: 'partial',
      held: 'github.com/Climative/architecture',
      note:
        'The empty list above means unsurveyed, not none. A platform of this shape has hosting and ' +
        'third-party processing behind it, and each one owes a carve-out or inclusive decision.',
    },
    'user-entity': {
      state: 'enumerated',
      note: 'NYSERDA and TD, recorded from bc-228x when the subject of the engagement was settled.',
    },
  },
};

/**
 * Every boundary this release ships, by organisation id.
 *
 * One entry. Written as a map anyway — see the header, and lib/organisation.js's for the
 * longer version of the same argument.
 */
export const BOUNDARIES = Object.freeze({ climative: CLIMATIVE });

/* ------------------------------------------------------------------ validating */

const text = (v) => String(v ?? '').trim();

/** Everything wrong with one component, as sentences. */
function componentProblems(c, where) {
  const problems = [];
  const id = text(c?.id);
  if (!id) problems.push(`${where}: a component needs an id`);
  else if (!ID_RE.test(id)) problems.push(`${where}: "${id}" is not the shape of a component id — lowercase, dashed`);
  if (!KINDS.includes(c?.kind)) {
    problems.push(`${where}: kind "${text(c?.kind)}" is not one of ${KINDS.join(', ')}`);
  }
  if (!DISPOSITIONS.includes(c?.disposition)) {
    problems.push(
      `${where}: disposition "${text(c?.disposition)}" is not one of ${DISPOSITIONS.join(', ')} — ` +
        'a component nobody has decided about belongs out of the list, with the census saying so'
    );
  }
  if (!text(c?.label)) problems.push(`${where}: a component needs a label a person can read`);
  if (text(c?.why).length < WHY_MIN) {
    problems.push(
      `${where}: needs a \`why\` of at least ${WHY_MIN} characters — ` +
        (c?.disposition === 'carved-out'
          ? 'a carve-out with no reason is an omission wearing a decision\'s clothes'
          : 'why something is inside the boundary is the sentence the scope argument is made of')
    );
  }
  return problems;
}

/** Everything wrong with one subservice organisation, as sentences. */
function subserviceProblems(s, where) {
  const problems = [];
  const id = text(s?.id);
  if (!id) problems.push(`${where}: a subservice organisation needs an id`);
  else if (!ID_RE.test(id)) problems.push(`${where}: "${id}" is not the shape of an id — lowercase, dashed`);
  if (!text(s?.label)) problems.push(`${where}: a subservice organisation needs a label`);
  if (!METHODS.includes(s?.method)) {
    problems.push(
      `${where}: method "${text(s?.method)}" is not one of ${METHODS.join(', ')} — ` +
        'the two do different things to the test population and neither is a default'
    );
  }
  if (text(s?.provides).length < WHY_MIN) {
    problems.push(`${where}: needs \`provides\` — what this organisation does for the system, in a sentence`);
  }
  if (s?.method === 'carve-out' && !(Array.isArray(s?.cuecs) && s.cuecs.filter((c) => text(c)).length)) {
    problems.push(
      `${where}: a carve-out shifts reliance onto the user entity, so it owes at least one CUEC — ` +
        'a carve-out with nothing on the other side is a control that vanished between two documents'
    );
  }
  return problems;
}

/** Everything wrong with one user entity, as sentences. */
function entityProblems(e, where) {
  const problems = [];
  const id = text(e?.id);
  if (!id) problems.push(`${where}: a user entity needs an id`);
  else if (!ID_RE.test(id)) problems.push(`${where}: "${id}" is not the shape of an id — lowercase, dashed`);
  if (!text(e?.label)) problems.push(`${where}: a user entity needs a label — the name the report is addressed to`);
  if (text(e?.why).length < WHY_MIN) problems.push(`${where}: needs a \`why\` — how this entity uses the system`);
  return problems;
}

/**
 * Everything wrong with a boundary record, as sentences. Empty means it is well-shaped.
 *
 * Shape and internal consistency only. It cannot know whether a repository named inside
 * the boundary really is inside it — nothing can, from here — which is exactly why the
 * census is mandatory: the one thing this can check is whether the record admits what it
 * does not know.
 */
export function boundaryProblems(record) {
  const problems = [];
  if (!record || typeof record !== 'object') return ['a boundary record is required'];

  problems.push(...orgProblems(record.organisation).map((p) => `organisation: ${p}`));
  if (!text(record.system)) problems.push('a boundary needs a `system` — the thing being described');
  if (!text(record.serviceOrganisation)) {
    problems.push('a boundary needs a `serviceOrganisation` — who is being held to this');
  }
  if (text(record.statement).length < STATEMENT_MIN) {
    problems.push(
      `a boundary needs a \`statement\` of at least ${STATEMENT_MIN} characters saying what is inside ` +
        'it — the scope statement is the first thing an auditor reads and the last thing anyone writes'
    );
  }
  if (!text(record.decidedBy)) {
    problems.push(
      'a boundary needs `decidedBy` — the bead the subject was settled on. A boundary with no ' +
        'decision behind it is one nobody can argue with later'
    );
  }

  const components = Array.isArray(record.components) ? record.components : [];
  if (!Array.isArray(record.components)) problems.push('`components` must be a list, even an empty one');
  const seen = new Set();
  components.forEach((c, i) => {
    problems.push(...componentProblems(c, `component ${text(c?.id) || `#${i}`}`));
    const key = `${c?.kind}/${text(c?.id)}`;
    if (seen.has(key)) problems.push(`component ${text(c?.id)}: declared twice as a ${c?.kind}`);
    seen.add(key);
  });

  const entities = Array.isArray(record.userEntities) ? record.userEntities : [];
  if (!Array.isArray(record.userEntities)) problems.push('`userEntities` must be a list, even an empty one');
  const entitySeen = new Set();
  entities.forEach((e, i) => {
    problems.push(...entityProblems(e, `user entity ${text(e?.id) || `#${i}`}`));
    if (entitySeen.has(text(e?.id))) problems.push(`user entity ${text(e?.id)}: named twice`);
    entitySeen.add(text(e?.id));
  });

  const subs = Array.isArray(record.subservice) ? record.subservice : [];
  if (!Array.isArray(record.subservice)) problems.push('`subservice` must be a list, even an empty one');
  const subSeen = new Set();
  subs.forEach((s, i) => {
    problems.push(...subserviceProblems(s, `subservice ${text(s?.id) || `#${i}`}`));
    if (subSeen.has(text(s?.id))) problems.push(`subservice ${text(s?.id)}: named twice`);
    subSeen.add(text(s?.id));
  });

  problems.push(...censusProblems(record));
  return problems;
}

/**
 * Everything wrong with the census, as sentences.
 *
 * Split out because it is the half people will be tempted to relax, and having it under
 * its own name makes that argument happen in a code review rather than in a diff.
 */
export function censusProblems(record) {
  const problems = [];
  const census = record?.census;
  if (!census || typeof census !== 'object') {
    return [
      'a boundary needs a `census` — how complete each list is. Without one an empty list reads as ' +
        '"there are none" and an absent field reads as "not applicable", and both validate perfectly',
    ];
  }
  for (const kind of CENSUS_KINDS) {
    const entry = census[kind];
    if (!entry) {
      problems.push(`census: nothing recorded for ${kind} — an unstated census is the blank this field exists to stop`);
      continue;
    }
    if (!CENSUS.includes(entry.state)) {
      problems.push(`census ${kind}: state "${text(entry.state)}" is not one of ${CENSUS.join(', ')}`);
    }
    if (entry.state === 'partial' && !text(entry.held)) {
      problems.push(
        `census ${kind}: a partial census must say where the rest is \`held\` — otherwise it is a shrug ` +
          'with a schema, and nobody knows where to go to close it'
      );
    }
    if (entry.state === 'enumerated' && text(entry.held)) {
      problems.push(
        `census ${kind}: enumerated and \`held\` elsewhere cannot both be true — if the list here is ` +
          'complete, there is no elsewhere; if there is, it is partial'
      );
    }
  }
  for (const kind of Object.keys(census)) {
    if (!CENSUS_KINDS.includes(kind)) problems.push(`census: "${kind}" is not something a boundary has a census of`);
  }
  return problems;
}

/**
 * Everything wrong with the shipped register, as sentences.
 *
 * Called at import below and thrown on. The key and the record's own `organisation` must
 * agree, because a map that can disagree with its values is a map where a lookup and a
 * read of the result answer different questions.
 */
export function registryProblems(boundaries = BOUNDARIES) {
  const problems = [];
  const firsts = [];
  for (const [key, record] of Object.entries(boundaries)) {
    problems.push(...boundaryProblems(record).map((p) => `${key}: ${p}`));
    if (record?.organisation !== key) {
      problems.push(`${key}: keyed as "${key}" but the record says "${text(record?.organisation)}"`);
    }
    if (record?.first) firsts.push(key);
  }
  if (firsts.length > 1) {
    problems.push(`more than one organisation claims to be the first: ${firsts.join(', ')}`);
  }
  return problems;
}

/* -------------------------------------------------------------------- reading */

/** Every organisation with a boundary in this release. */
export const organisations = () => Object.keys(BOUNDARIES).sort();

/**
 * The boundary for an organisation, or `null`.
 *
 * `null` and not a throw: an install belonging to an organisation with no boundary
 * recorded is an ordinary state — it is every install except one — and it must read as
 * "nothing is claimed here" rather than as a crash.
 */
export const boundaryFor = (org) => BOUNDARIES[text(org)] || null;

/** The one boundary, when a release ships exactly one. `null` when it does not. */
export const only = () => (organisations().length === 1 ? BOUNDARIES[organisations()[0]] : null);

/** Components, narrowed by kind and disposition. Both filters optional. */
export function components(record, { kind = null, disposition = null } = {}) {
  const all = Array.isArray(record?.components) ? record.components : [];
  return all.filter((c) => (!kind || c.kind === kind) && (!disposition || c.disposition === disposition));
}

/** What is inside the boundary, optionally of one kind. */
export const inside = (record, kind = null) => components(record, { kind, disposition: 'inside' });

/** What is carved out, optionally of one kind. */
export const carvedOut = (record, kind = null) => components(record, { kind, disposition: 'carved-out' });

/** The named user entities the report is written for. */
export const userEntities = (record) => (Array.isArray(record?.userEntities) ? record.userEntities : []);

/** The subservice organisations, with their carve-out or inclusive decision. */
export const subservice = (record) => (Array.isArray(record?.subservice) ? record.subservice : []);

/**
 * Every complementary user entity control the carve-outs generate, with what generated it.
 *
 * A CUEC is the other end of a carve-out: the control the user entity has to operate
 * because this report does not cover it. Flattening them into one list is the artefact —
 * it is what a user entity is actually handed, and reading it out of a per-subservice
 * structure by hand is how one goes missing.
 */
export function cuecs(record) {
  return subservice(record)
    .filter((s) => s.method === 'carve-out')
    .flatMap((s) => (Array.isArray(s.cuecs) ? s.cuecs : []).map((control) => ({ control, from: s.id, label: s.label })));
}

/** What the record itself says it does not know, as sentences somebody can act on. */
export function gaps(record) {
  const found = [];
  const census = record?.census || {};
  for (const kind of CENSUS_KINDS) {
    const entry = census[kind];
    if (entry?.state !== 'partial') continue;
    const count = kind === 'subservice' ? subservice(record).length : kind === 'user-entity' ? userEntities(record).length : inside(record, kind).length;
    found.push({
      kind,
      held: text(entry.held),
      recorded: count,
      why: text(entry.note) || `the ${kind} list is partial`,
    });
  }
  // Gated on the subservice census rather than raised whenever the CUEC list is empty,
  // because every gap here has to be closable by somebody: the only thing that produces a
  // CUEC in this record is a subservice carve-out, and validation already refuses one of
  // those without a CUEC. An ungated version stays red on a record whose processors really
  // are enumerated and really are none, which would make `--strict` permanently useless.
  const named = userEntities(record);
  if (named.length && !cuecs(record).length && census.subservice?.state === 'partial') {
    found.push({
      kind: 'cuec',
      held: text(census.subservice.held),
      recorded: 0,
      why:
        `${named.map((e) => e.label).join(' and ')} ` +
        `${named.length === 1 ? 'is named as a user entity' : 'are named as user entities'}, ` +
        'and no complementary control has been written for them. The processors are unsurveyed, ' +
        'so the carve-outs that would produce that list have not been decided yet — and a report with ' +
        'user entities and no CUEC list has told them nothing they have to do.',
    });
  }
  return found;
}

/**
 * The boundary as lib/election.js's `declare` wants it.
 *
 * The projection is the whole point: the scope statement a gate cites is computed from
 * this record rather than typed beside it, so the two can never drift. Deliberately a
 * one-way function — the declaration is a summary, and reconstructing a boundary from a
 * summary is how a census gets lost.
 */
export function declaration(record) {
  const carved = carvedOut(record).length;
  const entities = userEntities(record)
    .map((e) => e.label)
    .join(', ');
  return {
    name: text(record?.serviceOrganisation),
    description:
      `${text(record?.system)}. ${text(record?.statement)}` +
      (entities ? ` User entities: ${entities}.` : '') +
      (carved ? ` ${carved} component${carved === 1 ? '' : 's'} carved out.` : ''),
  };
}

/**
 * One line, for a log or a check.
 *
 * The gap count is in it on purpose. A summary that reads "2 inside, 8 carved out" and
 * stops is the summary that lets six partial censuses go unnoticed for a quarter.
 */
export function summarise(record) {
  const g = gaps(record).length;
  return (
    `${text(record?.serviceOrganisation)} · ${text(record?.system)} · ` +
    `${inside(record).length} inside, ${carvedOut(record).length} carved out, ` +
    `${userEntities(record).length} user entit${userEntities(record).length === 1 ? 'y' : 'ies'}, ` +
    `${subservice(record).length} subservice · ${g} gap${g === 1 ? '' : 's'}`
  );
}

const shipped = registryProblems();
if (shipped.length) {
  throw new Error(`lib/boundary.js: the shipped boundary register is broken —\n  ${shipped.join('\n  ')}`);
}
