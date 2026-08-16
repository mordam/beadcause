/**
 * Which organisation a published record belongs to — carried from the first line.
 *
 * Adam's wording when the central service was settled was deliberate: Climative is the
 * **first** service organisation. Not the only one, and not "the" one. A schema written
 * while there is one organisation does not usually *say* there is one organisation — it
 * simply never asks — and the day there is a second, the fix is a migration over the one
 * table that must never lose history. A chain re-keyed is a chain rewritten, and a
 * rewritten chain is exactly the thing the service exists to make visible.
 *
 * So the tenant is on the record, from the first commit, while there is still only one
 * of them and it costs nothing.
 *
 * **The closed set is the shape, not the membership — and that is the half people get
 * backwards.** lib/requirements.js and lib/controls.js are closed because their members
 * are knowable: there are 192 controls and a 193rd arrives as a table row somebody
 * writes. The register of organisations is the opposite and openly so, because "how many
 * are there" is the question this file refuses to answer in advance. What is closed here
 * is the *shape* — what an id may be, where it sits in a key, which records carry it —
 * and closing the shape is what makes the membership free to grow.
 *
 * **Why the org is on every record rather than derived from the instance.** The obvious
 * design records it once, at enrolment, and resolves a record's tenant by joining through
 * `instance`. It is smaller and it is wrong, for a reason that only shows up years later:
 * a derived field has no history. An instance moved between organisations — an
 * acquisition, a contractor's Mac handed back, an enrolment amended because the first one
 * was a typo — silently changes the tenant of every record that instance *ever* published,
 * including the ones an auditor sampled last March. Nothing is corrupted and nothing
 * fails; the answer to a question about the past just quietly becomes a different answer.
 * Twelve bytes per record buys a fact instead of a join, and `tenancyProblems` is what
 * refuses the join.
 *
 * **Why the id sits first in a key, and why that is not cosmetic.** `scope` puts the
 * organisation at the front of every storage key and every route, so a tenant boundary is
 * a string comparison rather than a parse. A credential scoped to `climative/` is
 * checkable by prefix, by anything, without knowing the shape of what follows — and a
 * boundary that needs a parser is a boundary with a bug in it eventually. It is also what
 * makes the acceptance criterion true rather than hoped-for: a second organisation
 * enrolling *adds* keys under a prefix nothing else uses, so no existing key is read,
 * rewritten or moved. That is the difference between enrolling and migrating.
 *
 * **Why an id is not a name.** `label` is what a human reads and it may change at will —
 * companies rebrand, and one did between two sentences of this epic being written. `id`
 * is opaque, lowercase, and permanent, because every record that ever named it still
 * names it. Keying history on a mutable string means a rename is a rewrite, which puts a
 * marketing decision on the critical path of the audit trail.
 *
 * **Why a withdrawn organisation keeps its id forever.** `RESERVED` refuses the words a
 * single-tenant install reaches for when it has to write *something* — `default`,
 * `local`, `all` — because each of them becomes a real tenant with real history and no
 * owner the day a second one arrives, and unpicking that is the migration this file
 * exists to prevent. `registryProblems` refuses reissue for the same reason one step
 * later: hand `climative` to a different organisation and every historical record is
 * ambiguous *while still validating perfectly*, which is the worst class of wrong.
 *
 * A leaf, like lib/publishable.js and lib/evidence.js and for the same reason: nothing is
 * imported, so a check, a service, a daemon and a migration script can each hold it
 * without one of them dragging in a config directory or a git repository. It reads no
 * state and writes none — which organisation *this* install belongs to is enrolment's
 * question (bc-3muu.2), the protocol that carries these is bc-3muu.3's, and what an
 * organisation elected is lib/election.js. All this owns is the shape they agree on.
 */

/** The shortest and longest an organisation id may be. Long enough to be readable. */
export const ORG_MIN = 3;
export const ORG_MAX = 32;

/**
 * The longest a display label may be — bounded and single-line for the reason
 * lib/publishable.js bounds every string: a field generous enough to hold a paragraph
 * is a field that will hold a paragraph.
 */
export const LABEL_MAX = 80;

/**
 * An organisation id: lowercase, opaque, permanent.
 *
 * Letters first, then letters, digits and single dashes. No underscores, no dots, no
 * uppercase — because this string is a key prefix, a route segment and a directory name
 * on somebody's filesystem, and the intersection of what all three treat identically is
 * smaller than any one of them.
 */
const ORG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A key part: no separators, no traversal, and nothing that needs escaping anywhere. */
const PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A route parameter, as a template writes it. */
const PARAM_RE = /^:[a-z][A-Za-z0-9]*$/;

/**
 * Ids that may never be minted.
 *
 * Every one of these is a word an install writes when it has one organisation and a
 * column that has to be filled. They read as absence and behave as presence: `default`
 * accumulates chains, sessions and criterion states exactly like a tenant, and the day a
 * real second organisation enrols there is no way to say which of `default`'s records
 * belonged to whom. Refusing them at mint time costs one sentence; discovering them at
 * migration time costs the history.
 *
 * `beadcause` is here for a different reason — the service's own records are not a
 * tenant's, and a namespace that can be confused with one invites exactly the leak the
 * prefix boundary exists to prevent.
 */
export const RESERVED = Object.freeze([
  'admin',
  'all',
  'any',
  'beadcause',
  'default',
  'global',
  'local',
  'main',
  'none',
  'org',
  'organisation',
  'organization',
  'own',
  'root',
  'self',
  'service',
  'shared',
  'system',
  'tenant',
]);

/**
 * What an organisation can be.
 *
 * Two, and neither of them is deleted. An organisation that stops publishing is
 * `withdrawn` and its records stay exactly where they are, still naming it — the same
 * argument lib/election.js makes about withdrawing an election: the promise is that
 * nothing further is claimed, not that the period never happened.
 */
export const STATUSES = Object.freeze(['active', 'withdrawn']);

/** What separates the organisation from everything under it, in a key and in a route. */
export const SEPARATOR = '/';

/** The name of the field that carries the tenant. One spelling, checked in one place. */
export const ORG_FIELD = 'org';

/**
 * Route templates that legitimately carry no organisation, and why.
 *
 * Not a waiver list — the other half of the same inventory, in the shape
 * `NOT_EVIDENCE` has in lib/evidence.js. Every entry has to say why the route can be
 * answered without knowing whose data it is, and each of these can: two of them return
 * nothing about anybody, and the third is the request that *establishes* which
 * organisation the caller belongs to, so requiring the answer in the question would be
 * circular. Anything added here is a sentence somebody has to defend, which is the point.
 */
export const UNTENANTED = Object.freeze({
  '/health': 'liveness only — it answers whether the process is up and nothing about who uses it',
  '/version': 'the running release, which is the same fact for every organisation',
  '/enrol': 'the request that establishes which organisation the caller belongs to, so it cannot be asked to already know',
});

const isString = (v) => typeof v === 'string';

/* --------------------------------------------------------------- the id itself */

/**
 * Everything wrong with an organisation id, as sentences. Empty means it is usable.
 *
 * Shape and reservation only. Whether the id names an organisation that exists is the
 * register's question and it is asked somewhere with the register in front of it; a
 * second, weaker membership list here would be the failure lib/election.js declines to
 * make with the control corpus.
 */
export function orgProblems(id) {
  if (!isString(id)) return ['an organisation id is required, as a string'];
  const s = id.trim();
  if (!s) return ['an organisation id is required'];
  if (s !== id) return [`"${id}" has whitespace around it — an id is the whole string or it is a different id`];

  const problems = [];
  if (s.length < ORG_MIN) problems.push(`"${s}" is shorter than ${ORG_MIN} characters`);
  if (s.length > ORG_MAX) problems.push(`"${s}" is longer than ${ORG_MAX} characters`);
  if (!ORG_RE.test(s)) {
    problems.push(
      `"${s}" is not the shape an organisation id has — lowercase letters, digits and single dashes, ` +
        'starting with a letter, as `climative`'
    );
  }
  if (RESERVED.includes(s)) {
    problems.push(
      `"${s}" is reserved — it is the word an install writes when it has one organisation and a column to fill, ` +
        'and it becomes a tenant with real history and no owner the day there is a second'
    );
  }
  return problems;
}

/** Everything wrong with a display label, as sentences. */
export function labelProblems(label) {
  if (!isString(label)) return ['a label is required, as a string'];
  const s = label.trim();
  if (!s) return ['a label is required — what a human calls this organisation'];
  const problems = [];
  if (s.length > LABEL_MAX) problems.push(`a label is at most ${LABEL_MAX} characters`);
  if (/[\r\n\t]/.test(s)) problems.push('a label is one line — it is a name, not a description');
  return problems;
}

/* ------------------------------------------------------------------ the record */

/**
 * Everything wrong with an organisation's register entry, as sentences.
 *
 * `enrolledAt` is required and is UTC, because "since when" is the question every
 * continuity claim over this organisation eventually reduces to, and a local timestamp
 * is not a fact — the same rule lib/publishable.js applies to every instant it holds.
 */
export function recordProblems(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return ['not an organisation record'];

  const problems = [];
  problems.push(...orgProblems(rec.id));
  problems.push(...labelProblems(rec.label));

  if (!STATUSES.includes(rec.status)) {
    problems.push(`status must be one of ${STATUSES.join(', ')} — an organisation is never removed, only withdrawn`);
  }
  if (!isString(rec.enrolledAt) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(rec.enrolledAt)) {
    problems.push('enrolledAt must be a UTC instant, such as 2026-08-15T17:48:35Z');
  }

  const known = new Set(['id', 'label', 'status', 'enrolledAt']);
  for (const name of Object.keys(rec)) {
    if (!known.has(name)) problems.push(`"${name}" is not part of an organisation record`);
  }
  return problems;
}

/**
 * Everything wrong with a register of them, as sentences.
 *
 * The two rules a single entry cannot see, and the first is the one that matters. An id
 * is never reissued — not to a withdrawn organisation's successor, not to an
 * organisation with the same name that arrived later. Reissue does not corrupt anything
 * and does not fail anything: every old record still validates, still links, still
 * verifies, and now silently means someone else. Duplicate *labels* are refused a step
 * more gently and for a human reason — two rows a person cannot tell apart is how the
 * wrong one gets picked in the surface that offers a list.
 */
export function registryProblems(records) {
  if (!Array.isArray(records)) return ['a register is a list of organisation records'];

  const problems = [];
  const byId = new Map();
  const labels = new Map();

  for (const [i, rec] of records.entries()) {
    const own = recordProblems(rec);
    for (const p of own) problems.push(`entry ${i}: ${p}`);
    if (own.length) continue;

    if (byId.has(rec.id)) {
      problems.push(
        `"${rec.id}" is registered twice — an id is never reissued, because every record that ever ` +
          'named it still names it and a reissued id makes the whole of that history ambiguous while it still validates'
      );
    } else byId.set(rec.id, rec);

    const key = rec.label.trim().toLowerCase();
    if (labels.has(key)) {
      problems.push(`"${rec.label}" is the label of both ${labels.get(key)} and ${rec.id} — nobody picking from a list can tell them apart`);
    } else labels.set(key, rec.id);
  }
  return problems;
}

/* ------------------------------------------------------------------- the prefix */

/**
 * The key a thing lives under, organisation first.
 *
 * The one funnel. Every storage key, every ref name and every path under the service is
 * built here, so "is this scoped" is a question with one answer and one place to be
 * wrong — the shape lib/publishable.js's `FIELDS` has, for the same reason.
 *
 * Throws rather than returning problems, and deliberately: a caller that cannot name the
 * organisation a key belongs to must not get a key. Silently returning an unscoped one
 * is how a single-tenant path gets written by a caller that meant well.
 */
export function scope(org, ...parts) {
  const bad = orgProblems(org);
  if (bad.length) throw new TypeError(`cannot scope a key: ${bad.join('; ')}`);
  if (!parts.length) throw new TypeError('a scoped key needs something under the organisation');

  for (const part of parts) {
    if (!isString(part) || !PART_RE.test(part)) {
      throw new TypeError(`"${part}" is not a usable key part — letters, digits, dots, dashes and underscores`);
    }
    if (part === '.' || part === '..' || part.includes('..')) {
      throw new TypeError(`"${part}" could climb out of the organisation it is scoped to`);
    }
  }
  return [org, ...parts].join(SEPARATOR);
}

/**
 * The organisation and the rest, back out of a key — or `null` if it is not one.
 *
 * `null` rather than a throw, because the caller here is usually reading somebody else's
 * key and "this is not a scoped key" is an answer it has to be able to act on. `scope`
 * is the strict direction; this is the tolerant one.
 *
 * **Shape alone cannot tell a scoped key from an unscoped one, and pretending otherwise
 * is worse than saying so.** `chains/evidence` parses perfectly as an organisation called
 * `chains` — `chains` is a legal id and nothing in the string says it was not meant as
 * one. So the honest answer without a register is "this is *shaped* like a scoped key",
 * which is all this returns by default. Pass `known` — any iterable of registered ids —
 * and the question becomes decidable, which is the form worth using anywhere a wrong
 * answer would cross a tenant boundary. Membership is the register's to answer, exactly
 * as it is in `orgProblems`; this is where the register gets handed in.
 */
export function unscope(key, known = null) {
  if (!isString(key) || !key) return null;
  const [org, ...parts] = key.split(SEPARATOR);
  if (orgProblems(org).length || !parts.length) return null;
  if (parts.some((p) => !PART_RE.test(p) || p.includes('..'))) return null;
  if (known && !new Set(known).has(org)) return null;
  return { org, parts };
}

/**
 * Everything wrong with a storage key, as sentences. Empty means it is scoped.
 *
 * Takes the same optional register as `unscope`, and the two answers differ in a way a
 * caller should choose deliberately: without it this passes any key whose first segment
 * could be an organisation, with it only keys whose first segment *is* one.
 */
export function scopeProblems(key, known = null) {
  if (!isString(key) || !key.trim()) return ['a key is required'];
  if (unscope(key, known)) return [];
  const [head] = key.split(SEPARATOR);
  const why = orgProblems(head);
  const unknown = known && !why.length && !new Set(known).has(head);
  return [
    `"${key}" is not scoped to a registered organisation — every key begins with one, so a tenant boundary ` +
      `is a prefix comparison rather than a parse${unknown ? ` ("${head}" is not registered)` : why.length ? ` (${why[0]})` : ''}`,
  ];
}

/**
 * Everything wrong with a route template, as sentences.
 *
 * Two rules and one register. The organisation must be named, and it must be named
 * *before* any other parameter — a route that identifies a chain and only then says whose
 * it is has already fetched somebody's row by the time it checks, which is the shape
 * every cross-tenant read in the world has had. And a route that carries no organisation
 * at all must be one of the three in `UNTENANTED`, each with the sentence saying why.
 *
 * The register is a parameter so a check can point this at a deliberately contradictory
 * one — the same reason `entryProblems` in lib/evidence.js takes an entry rather than
 * reading the real table.
 */
export function routeProblems(template, untenanted = UNTENANTED) {
  if (!isString(template) || !template.startsWith(SEPARATOR)) {
    return ['a route template is a path beginning with /'];
  }
  const segments = template.split(SEPARATOR).slice(1);
  if (segments.some((s) => !s)) return [`"${template}" has an empty segment`];

  const marker = `:${ORG_FIELD}`;
  const at = segments.indexOf(marker);
  if (at === -1) {
    if (template in untenanted) return [];
    return [
      `"${template}" names no organisation — every route under the service carries a ${marker} segment, or ` +
        'says in UNTENANTED why it can be answered without knowing whose data it is',
    ];
  }

  const problems = [];
  if (template in untenanted) {
    problems.push(`"${template}" both carries ${marker} and claims in UNTENANTED that it needs no organisation`);
  }
  const earlier = segments.slice(0, at).find((s) => PARAM_RE.test(s));
  if (earlier) {
    problems.push(
      `"${template}" resolves ${earlier} before it knows the organisation — the tenant is established first, ` +
        'or the row has already been fetched by the time anybody checks whose it was'
    );
  }
  if (segments.indexOf(marker, at + 1) !== -1) problems.push(`"${template}" names ${marker} twice`);
  return problems;
}

/* ------------------------------------------------------------------ the records */

/**
 * Everything wrong with a published-record vocabulary, as sentences.
 *
 * Pointed at a vocabulary rather than reading one, so a check can point it at a
 * deliberately single-tenant table — a rule only ever run against a table that passes is
 * a rule nobody has seen fire, which is the lesson `entryProblems` in lib/evidence.js and
 * `tableProblems` in lib/publishable.js both landed on.
 *
 * The failure it exists to name is not a missing field. It is the *plausible* design:
 * `org` on the enrolment record, everything else joined to it through the instance. That
 * table passes every other check in the repo, and the first sentence below is the only
 * thing in beadcause that will ever say it is wrong.
 */
export function tenancyProblems(vocabulary) {
  if (!vocabulary || typeof vocabulary !== 'object') return ['not a record vocabulary'];

  const envelope = vocabulary.envelope && typeof vocabulary.envelope === 'object' ? vocabulary.envelope : {};
  const fields = vocabulary.fields && typeof vocabulary.fields === 'object' ? vocabulary.fields : {};
  const kinds = Object.keys(fields);

  const problems = [];
  if (!kinds.length) problems.push('the vocabulary mints no kinds at all');

  const carriers = kinds.filter((k) => fields[k] && typeof fields[k] === 'object' && ORG_FIELD in fields[k]);

  if (!(ORG_FIELD in envelope)) {
    if (carriers.length) {
      problems.push(
        `${carriers.join(', ')} carries ${ORG_FIELD} and the envelope does not, so every other record's tenant is ` +
          'a join rather than a fact — and a joined tenant has no history, so amending one enrolment silently ' +
          'changes whose every past record was'
      );
    } else {
      problems.push(
        `the envelope carries no ${ORG_FIELD}, so no published record says which organisation it belongs to — ` +
          'and adding one later is a migration over the chains, which is the one table that may not be rewritten'
      );
    }
  } else {
    for (const kind of carriers) {
      problems.push(`${kind}.${ORG_FIELD} collides with the envelope field of the same name — the tenant has one home`);
    }
  }
  return problems;
}

/**
 * A record with its organisation on it. The only way one gets there.
 *
 * Refuses to overwrite a different organisation rather than quietly re-tenanting the
 * record: a stamp that silently wins is how a record ends up filed under whichever
 * organisation happened to be handling it, which is a cross-tenant write that leaves no
 * trace of having been one. Re-stamping with the same id is a no-op and is allowed,
 * because a caller stamping twice is careful rather than wrong.
 */
export function stamp(org, rec) {
  const bad = orgProblems(org);
  if (bad.length) throw new TypeError(`cannot stamp a record: ${bad.join('; ')}`);
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new TypeError('cannot stamp what is not a record');
  const held = rec[ORG_FIELD];
  if (held === org) return { ...rec };
  if (held !== undefined) {
    // `null` is refused alongside a real id rather than treated as absence: a record that
    // says its tenant is nothing is making a claim, and quietly overwriting a claim is the
    // cross-tenant write this refuses when the claim happens to name somebody.
    const whose = isString(held) ? `"${held}"` : `${JSON.stringify(held)}, which is not an organisation`;
    throw new TypeError(`this record already carries ${ORG_FIELD} ${whose} — it is not ${org}'s to re-file`);
  }
  return { ...rec, [ORG_FIELD]: org };
}

/** Whether a record belongs to an organisation. Absent is not a match, and never was. */
export function belongsTo(org, rec) {
  return !orgProblems(org).length && !!rec && typeof rec === 'object' && rec[ORG_FIELD] === org;
}

/**
 * Records grouped by the organisation they name, plus the ones that name none.
 *
 * `untenanted` is a returned list rather than a thrown error because this is what you
 * reach for while *finding* them — in a migration, in a check, in the answer to "is
 * anything in here from before the field existed". A grouping that refused to group
 * would be no use at the only moment it is needed.
 */
export function partition(records) {
  const byOrg = new Map();
  const untenanted = [];
  for (const rec of Array.isArray(records) ? records : []) {
    const org = rec && typeof rec === 'object' ? rec[ORG_FIELD] : undefined;
    if (!isString(org) || orgProblems(org).length) {
      untenanted.push(rec);
      continue;
    }
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org).push(rec);
  }
  return { byOrg, untenanted };
}

/**
 * The records in a set that are not this organisation's — the leak, listed.
 *
 * Includes the untenanted ones, on purpose. A record that names no organisation is not
 * safely nobody's: it is a record whose tenant is unknown, and handing it to a caller who
 * asked for one organisation's data is the same disclosure as handing over another
 * organisation's. Unknown fails closed here, which is the direction the epic's
 * "unverified is not compliant" rule points in.
 */
export function foreign(org, records) {
  return (Array.isArray(records) ? records : []).filter((rec) => !belongsTo(org, rec));
}
