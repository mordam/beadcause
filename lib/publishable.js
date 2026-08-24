/**
 * What a daemon may publish to the central service — and what it may never.
 *
 * The service exists because a local record cannot anchor itself. `verifyRef` in
 * lib/evidence.js reports three things about an evidence chain and only the third,
 * `anchored`, can catch a deliberate rewrite: a forged history is *perfectly* intact,
 * so intactness proves that what you are holding is a chain and not that it is the
 * chain that was there in March. Catching that needs a head somebody wrote down
 * beforehand, somewhere the rewrite cannot reach — and beadcause administers every
 * "somewhere" it has. A head sitting in a service the local operator does not run is
 * the missing half, and it is the whole reason the service is worth building.
 *
 * **The moment a head can leave the Mac, the question becomes what else leaves with
 * it**, and that question has to be answered before anything is built rather than
 * after, because a payload is easy to widen and impossible to narrow: the field you
 * regret is already on somebody's disk. So this file is the answer, and it is a
 * closed vocabulary rather than a filter. The service holds instance identity,
 * transition commits, chain heads, control ids claimed, criterion states, timestamps
 * and a hash of each evidence record. It does not hold the record.
 *
 * **The precedent is already shipped and already argued.** A workspace shared with
 * other people gets a contentless push; a `minimal` space gets a nudge you tap through
 * to the tailnet rather than the question text. lib/spaces.js makes that argument for
 * the reason that applies here in a harder form — the content is the part you cannot
 * take back once it has left, and a relay you do not administer is exactly where it
 * would be leaving to.
 *
 * **Three things follow, and the third is the one that decides whether the service is
 * hostable at all.** A hash proves a record existed at a time without disclosing it,
 * which is all a continuity claim ever needed. The service never becomes a central pile
 * of every user's source code and conversations, which is what makes running it
 * survivable rather than a breach waiting for a date. And the service's own audit stays
 * tractable: it holds no customer data of consequence, so the confidentiality criteria
 * over it are cheap instead of being the hardest part of the programme — which matters
 * more than it sounds, because this service will hold the evidence for the audits it is
 * itself inside.
 *
 * **An allowlist is the guarantee; the denylist below is only an error message — and a
 * tripwire.** `CONTENT_FIELDS` cannot be what enforces the boundary, because a filter
 * over field names is defeated by naming the field something else, and a rule that can
 * be defeated by a rename is a rule that will be. What enforces it is `FIELDS`: a
 * record carrying a key the table does not mint is refused, whatever the key is called.
 * The denylist earns its place twice over anyway. It makes the refusal say *why* rather
 * than "unknown field", which is the difference between a caller fixing its payload and
 * a caller adding a table row. And `tableProblems` runs it over the table itself at
 * import, so the day somebody widens the vocabulary to `notes` or `description` the
 * build breaks in every suite at once, instead of the widening arriving as a
 * one-line diff that reads like an improvement.
 *
 * **An allowlisted name is not a licence for a paragraph.** Every value is typed and
 * every string is bounded and single-line, because the way content actually escapes a
 * schema is not a field called `body` — it is a paragraph in a field called `ref`.
 * There are no free-text types here and there is deliberately no way to add one:
 * `TYPES` is a closed set of shapes, each of which a human sentence fails.
 *
 * **Continuity is provable from what is held, which is the other half of the bargain.**
 * Every record names the digest of the one before it, so an unbroken run of publications
 * is demonstrable by walking digests — no content, no repository, nothing but what the
 * service already has. `linkProblems` is that walk. What it deliberately does not answer
 * is whether a *period* is covered: an instance that published nothing for a fortnight
 * has a perfectly linked chain across the gap, and refusing to let it claim the fortnight
 * is bc-3muu.4's half of the rule. Linked is not the same as continuous, and conflating
 * them here would let the weaker fact be quoted as the stronger one.
 *
 * The vocabulary is small on purpose and it is expected to grow: bc-3muu.2 owns what an
 * instance token *is*, bc-3muu.3 owns the protocol that carries these, bc-3muu.6 owns
 * which of them an install even produces. Growing it is a row in `FIELDS` and a shape in
 * `TYPES`, and that is the point — one table, one funnel, one place to be wrong.
 *
 * A leaf, like lib/evidence.js and for the same reason: node:crypto and nothing else, so
 * a check, a service and a daemon can all import it without one of them dragging in a
 * config directory.
 */
import crypto from 'node:crypto';

/** The digest algorithm, in the prefix every hash carries so it can be changed later. */
export const DIGEST_ALGORITHM = 'sha256';

/**
 * The longest a published string may be.
 *
 * Not a performance number. It is short enough that no sentence anybody would want to
 * read survives it, which is the property being bought — a limit generous enough to
 * hold a paragraph is a limit that holds a paragraph.
 */
export const MAX_STRING = 200;

/**
 * Field names that are refused outright, wherever they appear.
 *
 * Redundant against the allowlist by construction, and kept for the two jobs in the
 * note at the top: a refusal that says *content* rather than *unknown*, and a build
 * that breaks the moment one of these is minted as a real field.
 */
export const CONTENT_FIELDS = Object.freeze([
  'answer',
  'body',
  'brief',
  'comment',
  'content',
  'contents',
  'description',
  'diff',
  'file',
  'image',
  'log',
  'message',
  'notes',
  'output',
  'patch',
  'payload',
  'prompt',
  'question',
  'screenshot',
  'source',
  'summary',
  'text',
  'title',
  'transcript',
]);

/** A bead id — `bc-3muu` and `bc-3muu.1` both. Same shape lib/evidence.js pins. */
const BEAD_RE = /^[a-z]{2}-[a-z0-9]+(\.\d+)*$/;

/** A digest as this file writes them. The prefix is part of the value, not decoration. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** A git object name, sha-1 or sha-256, lowercase and whole. */
const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** A ref path. Identifiers and separators only — no spaces, and no `..` to escape with. */
const REF_RE = /^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

/** An opaque short identifier: an instance token, an organisation token. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * A control id, as a *shape* rather than as a vocabulary.
 *
 * The corpus is the authority on which ids exist, and inventing a second, weaker list
 * of them here is precisely the failure lib/evidence.js refuses to make with `serves` —
 * three separately-built control sets is the thing the programme is written against.
 * All this refuses is a value that is not an id at all.
 */
const CONTROL_RE = /^[A-Z][A-Z0-9]{1,11}\.[A-Za-z0-9][A-Za-z0-9.]{0,23}$/;

/** An instant, UTC, to the millisecond or the second. Local time is not a fact. */
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * What a criterion can be said to be.
 *
 * Three rather than two, and the third is the one the epic turns on: `unverified` is
 * not the same claim as `unmet`, because "unverified is not compliant" only means
 * anything if an instance that cannot show its work is distinguishable from one that
 * showed it and failed. Rounding those together loses the distinction at the exact
 * point it is being relied on.
 */
export const CRITERION_STATES = Object.freeze(['met', 'unmet', 'unverified']);

/**
 * How append-only is actually enforced where the records are kept.
 *
 * The distinction the whole posture turns on. `application` means the *code* refuses to
 * rewrite — lib/gitref.js's compare-and-swap — while the operator who runs the code can
 * still `git reset` the ref underneath it, which is a promise rather than a property.
 * `storage` means the store itself refuses, so the promise does not depend on the
 * promiser. `unknown` is its own answer and not a synonym for `none`: a deployment that
 * could not look is in a different position from one that looked and found nothing.
 */
export const STORAGE_ENFORCEMENT = Object.freeze(['storage', 'application', 'none', 'unknown']);

/** Whether the code that is running is the code the deployment says it is running. */
export const PROVENANCE = Object.freeze(['matched', 'mismatched', 'unknown']);

/**
 * The shapes a published value may have.
 *
 * A closed set, and there is no `text`. Each entry says what it accepts, and the `why`
 * is what a caller is told when its value does not — a validator whose message is
 * "invalid" makes the caller guess, and a caller that guesses widens something.
 *
 * **Four shapes admit a named word beside their values — `never`, `unknown`,
 * `permanent`, `none` — and that is deliberately not the same thing as an optional
 * field.** An optional field means two things at once, not sent or sent as nothing, and
 * the note on `FIELDS` refuses them for exactly that reason. These are *values*: "it has
 * never happened", "this deployment could not establish it", "it is kept forever", "this
 * transition named no bead" are each a single fact an auditor can act on, and each is the
 * fact that would otherwise be smuggled in as an absent key. Writing `unknown` down is
 * the whole of bc-3muu.12 — a deployment that cannot see something says so, and the
 * interval it covers stops being claimable rather than quietly reading as fine. `bead`'s
 * `none` is bc-3muu.21's turn of the same argument: `setManagement` in lib/management.js
 * takes a bead and defaults it to null, on purpose — a manual `on`/`off` at a terminal is
 * not always done for a piece of work — and a transition typed without one is not an
 * error, it is a fact about how the layer was turned on. `none` is the sentinel it
 * publishes as, rather than a hole `lib/publishsweep.js` had to count and never close.
 */
export const TYPES = Object.freeze({
  digest: { why: 'a sha256 digest, written `sha256:<64 hex>`', ok: (v) => typeof v === 'string' && DIGEST_RE.test(v) },
  sha: { why: 'a whole lowercase git object name', ok: (v) => typeof v === 'string' && SHA_RE.test(v) },
  ref: { why: 'a ref path under refs/, identifiers only', ok: (v) => typeof v === 'string' && REF_RE.test(v) && !v.includes('..') },
  token: { why: 'an opaque identifier, 64 characters or fewer', ok: (v) => typeof v === 'string' && TOKEN_RE.test(v) },
  bead: { why: 'a bead id such as bc-3muu.1, or "none"', ok: (v) => v === 'none' || (typeof v === 'string' && BEAD_RE.test(v)) },
  control: { why: 'a control id such as SOC2.CC7.2', ok: (v) => typeof v === 'string' && CONTROL_RE.test(v) },
  state: { why: `one of ${CRITERION_STATES.join(', ')}`, ok: (v) => CRITERION_STATES.includes(v) },
  count: { why: 'a non-negative whole number', ok: (v) => Number.isSafeInteger(v) && v >= 0 },
  flag: { why: 'true or false', ok: (v) => v === true || v === false },
  at: { why: 'a UTC instant, such as 2026-08-15T17:48:35Z', ok: (v) => typeof v === 'string' && AT_RE.test(v) && Number.isFinite(Date.parse(v)) },
  enforcement: { why: `one of ${STORAGE_ENFORCEMENT.join(', ')}`, ok: (v) => STORAGE_ENFORCEMENT.includes(v) },
  provenance: { why: `one of ${PROVENANCE.join(', ')}`, ok: (v) => PROVENANCE.includes(v) },
  since: { why: 'a UTC instant, or "never"', ok: (v) => v === 'never' || (typeof v === 'string' && AT_RE.test(v) && Number.isFinite(Date.parse(v))) },
  origin: { why: 'a whole lowercase git object name, or "unknown"', ok: (v) => v === 'unknown' || (typeof v === 'string' && SHA_RE.test(v)) },
  retention: { why: 'a whole number of months kept, or "permanent"', ok: (v) => v === 'permanent' || (Number.isSafeInteger(v) && v >= 0) },
});

/**
 * The envelope every published record carries, whatever its kind.
 *
 * `prev` is the digest of the record before it and is the only field that may be null,
 * at `seq` 0 and nowhere else — see `envelopeLinkProblem`. `instance` is an opaque
 * token here on purpose: what an instance token actually *is*, and how a daemon comes
 * to hold one, is bc-3muu.2's question, and all this needs of it is that it be bounded
 * and mean nothing to anybody who has not enrolled.
 */
export const ENVELOPE = Object.freeze({
  instance: 'token',
  seq: 'count',
  at: 'at',
  prev: 'digest',
});

/**
 * Every kind of record, and every field it carries.
 *
 * All fields are required. An optional field is a field whose absence means two things
 * — not sent, or sent as nothing — and a record whose meaning depends on which is a
 * record an auditor cannot read. A kind that needs a field only sometimes is two kinds.
 *
 * `evidence` on a criterion is the whole boundary in one field: it is the digest of the
 * record that backs the claim, so the claim is checkable against a record produced later
 * and the record itself never leaves the Mac.
 *
 * `transition.bead` is `'none'` when the on/off it records named no bead at all — the
 * `bead` type's sentinel, not an absence. Requiring one there instead would refuse the
 * ordinary case of a manual `on`/`off` typed with no ticket behind it, and it would still
 * do nothing for the transitions already on `refs/beadcause/management` before this
 * field could carry the word: those cannot retroactively acquire a bead either way. See
 * `TYPES.bead` and `lib/publishsweep.js`'s `transitionsOwed`.
 *
 * `posture` is the kind that says how much any of the others is worth. Every field on it
 * is *observed* by lib/posture.js rather than stated, and none of it is content by any
 * reading — how a store enforces append-only, whether an anchor exists, how long records
 * are kept and which commit is running are facts about the deployment, not about the
 * work. It is here rather than in a separate channel because a posture that travels some
 * other way is a posture that can be omitted for the interval where it was bad.
 */
export const FIELDS = Object.freeze({
  enrolment: Object.freeze({ fingerprint: 'digest', org: 'token' }),
  'chain-head': Object.freeze({ ref: 'ref', head: 'sha', length: 'count', linear: 'flag', intact: 'flag' }),
  transition: Object.freeze({ ref: 'ref', commit: 'sha', bead: 'bead' }),
  criterion: Object.freeze({ control: 'control', state: 'state', evidence: 'digest' }),
  posture: Object.freeze({
    storage: 'enforcement',
    anchoring: 'flag',
    anchored: 'since',
    retention: 'retention',
    build: 'origin',
    provenance: 'provenance',
  }),
});

/** The kinds, in the order the table declares them. */
export const KINDS = Object.freeze(Object.keys(FIELDS));

/* ------------------------------------------------------------------- hashing */

/**
 * A stable text for any JSON value — object keys sorted, so two encodings of the same
 * record cannot digest differently and a chain cannot break because a writer changed
 * its property order.
 */
function canonical(v) {
  if (v === undefined) throw new TypeError('nothing to digest');
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(',')}}`;
}

/**
 * The hash that stands in for a thing, so its existence can be proved without it.
 *
 * Domain-separated between bytes and structure, because a file whose contents happen to
 * serialise like a record should not be able to collide with that record — the two are
 * different claims and a digest that cannot tell them apart is a digest that can be made
 * to say the wrong one.
 */
export function digest(value) {
  const h = crypto.createHash(DIGEST_ALGORITHM);
  if (Buffer.isBuffer(value)) h.update('bytes:').update(value);
  else h.update('json:').update(canonical(value), 'utf8');
  return `${DIGEST_ALGORITHM}:${h.digest('hex')}`;
}

/** The digest of a record — what the next record in the chain names as its `prev`. */
export function recordDigest(rec) {
  return digest(rec);
}

/* ---------------------------------------------------------------- validation */

const isContentName = (k) => CONTENT_FIELDS.includes(String(k).toLowerCase());

/**
 * Whether the *table* is sound — pointed at a table, so it can be pointed at a bad one.
 *
 * A rule that is only ever run against a table which passes is a rule nobody has seen
 * fire; lib/evidence.js learned that with `entryProblems` and this is the same shape.
 * `build` runs it over the real `FIELDS` at import, so a bad table is a failing import
 * in every suite rather than a surprise at the first publication.
 */
export function tableProblems(fields = FIELDS) {
  const problems = [];
  const kinds = Object.keys(fields || {});
  if (!kinds.length) problems.push('the table mints no kinds at all');
  for (const kind of kinds) {
    if (!TOKEN_RE.test(kind)) problems.push(`kind "${kind}" is not a usable name`);
    const row = fields[kind];
    if (!row || typeof row !== 'object') {
      problems.push(`kind "${kind}" has no fields`);
      continue;
    }
    for (const [name, type] of Object.entries(row)) {
      if (isContentName(name)) problems.push(`${kind}.${name} is content — the service never holds it`);
      if (Object.hasOwn(ENVELOPE, name)) problems.push(`${kind}.${name} collides with the envelope field of the same name`);
      if (!Object.hasOwn(TYPES, type)) problems.push(`${kind}.${name} claims the type "${type}", which is not a shape`);
    }
  }
  for (const [name, type] of Object.entries(ENVELOPE)) {
    if (isContentName(name)) problems.push(`envelope.${name} is content — the service never holds it`);
    if (!Object.hasOwn(TYPES, type)) problems.push(`envelope.${name} claims the type "${type}", which is not a shape`);
  }
  return problems;
}

/**
 * `prev` is null at seq 0, a digest after it, and never the other way round.
 *
 * Asked only once `seq` and `prev` are each individually well-formed, because a record
 * missing its envelope has one problem rather than two and reporting the second reads
 * as a second thing to fix.
 */
function envelopeLinkProblem(rec) {
  if (!TYPES.count.ok(rec.seq)) return null;
  if (!(rec.prev === null || TYPES.digest.ok(rec.prev))) return null;
  if (rec.seq === 0) return rec.prev === null ? null : 'the first record of a chain has no predecessor, so prev must be null';
  if (rec.prev === null) return `seq ${rec.seq} is not the first record, so prev must name the one before it`;
  return null;
}

/**
 * Everything wrong with a record, as sentences — empty when it may be published.
 *
 * The order matters to whoever reads the output: what the record is, then what it is
 * missing, then what it carries that it may not. The last group is the boundary, and it
 * is the one written to be unambiguous in a log somebody reads a year later.
 */
export function problemsWith(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return ['not a record'];

  const problems = [];
  const kind = rec.kind;
  // `Object.hasOwn` rather than `in`, here and below: `'constructor' in FIELDS` is true
  // of every plain object, and a closed vocabulary that admits the prototype chain is
  // not closed. The names it would let through are exactly the ones nobody would test.
  if (typeof kind !== 'string' || !Object.hasOwn(FIELDS, kind)) {
    return [`"${kind}" is not a kind of record the service holds — one of ${KINDS.join(', ')}`];
  }

  const allowed = { kind: null, ...ENVELOPE, ...FIELDS[kind] };

  for (const [name, type] of Object.entries(ENVELOPE)) {
    if (!Object.hasOwn(rec, name)) problems.push(`${name} is missing — every record carries the envelope`);
    else if (!(name === 'prev' && rec[name] === null) && !TYPES[type].ok(rec[name])) {
      problems.push(`${name} must be ${TYPES[type].why}`);
    }
  }
  for (const [name, type] of Object.entries(FIELDS[kind])) {
    if (!Object.hasOwn(rec, name)) problems.push(`${kind} is missing ${name}`);
    else if (!TYPES[type].ok(rec[name])) problems.push(`${kind}.${name} must be ${TYPES[type].why}`);
  }

  for (const name of Object.keys(rec)) {
    if (Object.hasOwn(allowed, name)) continue;
    if (isContentName(name)) problems.push(`${name} is content, and the service holds hashes and metadata rather than content`);
    else problems.push(`${name} is not a field the service holds — the vocabulary is closed`);
  }

  for (const [name, value] of Object.entries(rec)) {
    if (typeof value === 'string' && value.length > MAX_STRING) problems.push(`${name} is ${value.length} characters, and nothing published is longer than ${MAX_STRING}`);
    else if (typeof value === 'string' && /[\r\n]/.test(value)) problems.push(`${name} spans lines, and nothing published does`);
    else if (value !== null && typeof value === 'object') problems.push(`${name} is a structure, and every published value is a single scalar`);
  }

  const link = envelopeLinkProblem(rec);
  if (link) problems.push(link);

  return problems;
}

/**
 * Build a record, or refuse to.
 *
 * The one funnel. Nothing should assemble a payload by hand and hand it to a request:
 * a route that takes an object off the wire and stores it has no boundary at all, and a
 * publisher that builds one literally has a boundary that holds until the next person
 * adds a field. Both ends call this — the daemon to make a record, the service to admit
 * one — which is what makes "no route accepts content" a property of one function
 * rather than a promise repeated in several.
 */
export function record(kind, envelope = {}, fields = {}) {
  const rec = { kind, ...envelope, ...fields };
  const problems = problemsWith(rec);
  if (problems.length) throw new Error(`this cannot be published:\n  - ${problems.join('\n  - ')}`);
  return Object.freeze(rec);
}

/**
 * The next record in a chain, given the one before it.
 *
 * Deriving `seq` and `prev` rather than asking for them is the whole reason the chain
 * can be trusted: a caller that computes its own link is a caller that can compute it
 * wrong, once, silently, and be found out by an auditor rather than by a test.
 */
export function next(previous, kind, fields = {}, { at } = {}) {
  if (previous === null) throw new Error('the first record of a chain is built with genesis(), not next()');
  const problems = problemsWith(previous);
  if (problems.length) throw new Error(`the previous record is not publishable:\n  - ${problems.join('\n  - ')}`);
  return record(kind, { instance: previous.instance, seq: previous.seq + 1, at: at || now(), prev: recordDigest(previous) }, fields);
}

/** The first record an instance publishes: seq 0, and nothing before it. */
export function genesis(instance, kind, fields = {}, { at } = {}) {
  return record(kind, { instance, seq: 0, at: at || now(), prev: null }, fields);
}

/** An instant in the one form `at` accepts. */
export function now(d = new Date()) {
  return d.toISOString();
}

/**
 * Whether a run of records is one unbroken chain — the continuity claim, proved from
 * what the service holds and nothing else.
 *
 * No repository, no content, no trust in the publisher: each record names the digest of
 * the one before it, so a record removed from the middle, edited anywhere, or attributed
 * to another instance breaks a link that arithmetic can find. Time is checked as well,
 * because a chain that runs backwards is either a clock nobody noticed or a story
 * somebody told, and both are worth a sentence in the output.
 *
 * What this does *not* say is that the instance was up throughout — see the note at the
 * top of the file. Linked is not continuous.
 */
export function linkProblems(records) {
  const problems = [];
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return ['no records, so nothing is claimed'];

  list.forEach((rec, i) => {
    const bad = problemsWith(rec);
    if (bad.length) problems.push(`record ${i} is not publishable: ${bad[0]}`);
  });
  if (problems.length) return problems;

  const instance = list[0].instance;
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    if (rec.instance !== instance) problems.push(`record ${i} was published by ${rec.instance}, and a chain belongs to one instance`);
    if (i === 0) continue;
    const before = list[i - 1];
    if (rec.seq !== before.seq + 1) problems.push(`seq jumps from ${before.seq} to ${rec.seq} — ${rec.seq - before.seq - 1} record(s) are not here`);
    const expected = recordDigest(before);
    if (rec.prev !== expected) problems.push(`record ${i} names ${rec.prev} as its predecessor, and record ${i - 1} digests to ${expected}`);
    if (Date.parse(rec.at) < Date.parse(before.at)) problems.push(`record ${i} is stamped before record ${i - 1}`);
  }
  return problems;
}

/** The head of a verified chain of records — what a later claim is checked against. */
export function head(records) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return null;
  const last = list[list.length - 1];
  return { instance: last.instance, seq: last.seq, at: last.at, digest: recordDigest(last) };
}

/**
 * A `chain-head` record's fields, from what `verifyRef` in lib/evidence.js returns.
 *
 * The bridge, and it is deliberately a projection rather than a pass-through: what the
 * verifier returns is a superset, it grows as that file grows, and the difference between
 * "publish the four fields the table mints" and "publish the result" is the difference
 * between a boundary and a hope. `why` in particular is prose, and prose does not cross.
 */
export function chainHeadFields(verify) {
  return {
    ref: verify?.ref,
    head: verify?.head,
    length: verify?.length,
    linear: verify?.linear === true,
    intact: verify?.intact === true,
  };
}

/* The table is checked once, here, so a bad one is a failing import everywhere. */
function build() {
  const problems = tableProblems(FIELDS);
  if (problems.length) throw new Error(`the published vocabulary is not sound:\n  - ${problems.join('\n  - ')}`);
}
build();
