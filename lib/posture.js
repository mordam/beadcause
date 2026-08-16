/**
 * What a deployment can actually back up — observed, published, and refused when it cannot.
 *
 * bc-3muu.9 puts the control daemon on the customer's own hardware, and that one decision
 * moves the whole failure mode. While we hosted it, correct configuration was ours to
 * guarantee and a misconfiguration was ours to notice. Hosted by somebody else, a
 * deployment with append-only enforced nowhere but in the application, with anchoring
 * never configured, with a retention shorter than the window it is meant to support, or
 * running a build nobody can identify, produces evidence that **looks exactly like good
 * evidence** and is worth nothing — and nobody finds out until an auditor pulls the
 * thread, by which time the period is over and cannot be re-observed.
 *
 * **Documentation cannot fix this and neither can a checklist.** A runbook is read once,
 * on the day of the install, by somebody who is not the person who still runs the box
 * three years later. So the deployment says what it is, continuously, in the record
 * itself: a `posture` record on the same chain as everything else, published with the
 * chain heads it is supposed to make meaningful.
 *
 * **Every field is observed here and none of it can be stated.** There is no
 * `posture.json`, no config key and no argument that says "we are append-only, trust us"
 * — the functions below go and look, and where they cannot look they write `unknown`
 * rather than an optimistic default. That is the difference between an attestation and a
 * self-assessment: a deployment that could assert its own posture would have exactly the
 * same failure mode as the runbook, one layer down and harder to see. It is also why
 * `observe` takes the places to look as arguments and holds no paths of its own.
 *
 * **The refusal is the point, and it is the same rule bc-3muu.4 applies to being
 * offline.** A posture that cannot back a claim does not produce a smaller claim, a
 * warning, or a compliant-with-exceptions: the interval it covers reports `unverified`.
 * Unverified is not the same as failed — `CRITERION_STATES` keeps those three apart for
 * this reason — and it never blocks anybody's work. A daemon whose anchoring was never
 * configured goes on dispatching sessions, writing chains and publishing records exactly
 * as before. What it stops doing is claiming a period it cannot show.
 *
 * **A posture change renders rather than resolves.** `report` walks the run of records
 * and cuts it into the intervals each posture covers, so a quarter in which anchoring was
 * off for five weeks reads as five weeks during which anchoring was off — a scope note an
 * auditor can price — instead of quietly reading as a clean quarter, which is what a
 * posture held as current state rather than as history would have produced. This is the
 * continuity report, and it is the first one: everything else about the service is still
 * bc-3muu.2, .3 and .10.
 *
 * **And it answers to somebody who has no access to us.** `report` takes published
 * records and nothing else — no repository, no content, no network, no beadcause install
 * — so an auditor holding an export can run `beadcause-attest verify` against it and get
 * the same verdict the daemon would give, computed from the same function. A verifier
 * only we can run is a verifier the audit has to take our word for, which is the word it
 * was supposed to replace.
 *
 * Today, honestly, almost every deployment reads `unverified`: nothing anchors yet
 * (bc-3muu.10), and a git ref in a directory the operator owns is enforced by the
 * application and not by the store. That is the correct output and not a bug to tune
 * away. The number that must not happen is a deployment reporting `verified` because
 * nobody looked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REGISTER } from './evidence.js';
import { git, ok } from './gitref.js';
import { FIELDS, TYPES, genesis, linkProblems, next, now } from './publishable.js';

/** The names a posture carries, taken from the published table so the two cannot drift. */
export const POSTURE_FIELDS = Object.freeze(Object.keys(FIELDS.posture));

/**
 * The shortest retention a deployment may hold and still back a claim, in months.
 *
 * Deliberately a second copy of the number in lib/evidence.js rather than an import of
 * `RETENTION_FLOOR_MONTHS`, and that is the one duplication in this file worth keeping.
 * The floor over there is what the register is *allowed to state*; this is what an
 * auditor's report *requires*. Importing it would mean a deployment could lower the bar
 * it is measured against by editing the file that declares the bar — which is precisely
 * the shape of self-assessment this module exists to refuse. If they ever disagree, the
 * disagreement is the finding.
 */
export const OBSERVATION_MONTHS = 24;

/**
 * How stale a successful anchor may be before it stops witnessing anything, in hours.
 *
 * A day plus slack, because an anchor is only evidence of the head it saw: an anchor from
 * March cannot tell you anything about a rewrite in June, and a deployment that anchored
 * once at install and never again has the *configuration* without the property. The slack
 * is there so a machine that was asleep overnight does not produce a finding out of an
 * ordinary weekend.
 */
export const MAX_ANCHOR_AGE_HOURS = 26;

/** The two things a report can say about an interval. There is no third. */
export const VERDICTS = Object.freeze(['verified', 'unverified']);

/** A posture nothing is known about — what an install with nowhere to look observes. */
export const NOTHING_KNOWN = Object.freeze({
  storage: 'unknown',
  anchoring: false,
  anchored: 'never',
  retention: 0,
  build: 'unknown',
  provenance: 'unknown',
});

const HOUR = 3600 * 1000;
const format = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const instant = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);
const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/* --------------------------------------------------------------- observing */

/**
 * How append-only is enforced where the records are kept — by looking, not by asking.
 *
 * The question an auditor asks is "who could delete a row", and on a directory the answer
 * is decided by whether the process that writes it could also rewrite it. Three
 * observations, and each maps to a different answer rather than to a warning:
 *
 * - the store is not writable by whoever is running this, so the enforcement is in the
 *   store rather than in a promise — `storage`;
 * - the store is writable and is a git object store, so lib/gitref.js's compare-and-swap
 *   refuses a rewrite and the operator underneath it does not — `application`;
 * - the store is writable and is not a git object store, so nothing refuses anything —
 *   `none`;
 * - and there is nowhere to look, which is `unknown` and is not the same answer.
 *
 * Note what this means today and does not pretend otherwise: a common repo under the
 * operator's home directory is `application`, every time, on every Mac. That is the true
 * answer, and the reason `verified` is currently unreachable without a store somebody
 * else administers — which is bc-3muu.3's half of the epic, not a threshold to relax.
 */
export function observeStorage(dir) {
  if (!dir) return 'unknown';
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return 'unknown';
  }
  if (!st.isDirectory()) return 'unknown';
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return 'storage';
  }
  const gitish =
    fs.existsSync(path.join(dir, '.git')) ||
    (fs.existsSync(path.join(dir, 'HEAD')) && fs.existsSync(path.join(dir, 'objects')));
  return gitish ? 'application' : 'none';
}

/**
 * Which build is running, and whether the tree it is running from is that build.
 *
 * Two answers rather than one, because they fail apart. A deployment can know its commit
 * perfectly well and be running a working tree with three uncommitted edits in it, which
 * is a build whose provenance does not match what it reports — the failure the bead names
 * — and it is invisible to anything that only records a version string. `mismatched` is
 * therefore a real state and not a synonym for `unknown`: somebody changed the code under
 * the daemon, and that is worth saying out loud rather than rounding to "could not tell".
 */
export async function observeBuild(cwd) {
  if (!cwd) return { build: 'unknown', provenance: 'unknown' };
  const head = (await ok(git(cwd, ['rev-parse', 'HEAD'])))?.trim();
  if (!head || !SHA_RE.test(head)) return { build: 'unknown', provenance: 'unknown' };
  const dirty = await ok(git(cwd, ['status', '--porcelain']));
  if (dirty === null) return { build: head, provenance: 'unknown' };
  return { build: head, provenance: dirty.trim() ? 'mismatched' : 'matched' };
}

/**
 * The shortest retention any sampled evidence class states, in months.
 *
 * Sampled classes only, because retention is a question about what an auditor can still
 * draw a sample from: a class nobody samples can be short-lived without weakening a
 * claim. `permanent` beats every number, so a register of nothing but permanent classes
 * observes as `permanent` — and a register with no sampled classes at all observes as 0,
 * which is refused below rather than treated as unlimited. Nothing kept is not the same
 * as everything kept, and a fold that starts at infinity gets that backwards.
 */
export function observeRetention(register = REGISTER) {
  const months = [];
  let anyPermanent = false;
  for (const e of register || []) {
    if (!e?.sampled) continue;
    if (e.retention === 'permanent') anyPermanent = true;
    else if (Number.isSafeInteger(e.retention) && e.retention >= 0) months.push(e.retention);
  }
  if (months.length) return Math.min(...months);
  return anyPermanent ? 'permanent' : 0;
}

/**
 * This deployment's posture, as it is rather than as anybody says it is.
 *
 * Every argument is a *place to look* and none of them is a value to record. `cwd` is the
 * checkout the daemon runs from; `store` is the directory the evidence records live in;
 * `witness` is how a successful anchor is learned about, and passing one is what makes
 * anchoring *configured* — a deployment with no witness has not configured anchoring, and
 * a witness that answers null has configured it and never had it succeed. Those are two
 * different postures and collapsing them would hide the install that was set up and never
 * worked.
 *
 * The paths are arguments rather than constants for the same reason lib/evidence.js keeps
 * its register a leaf: this has to be runnable against a deployment that is not this one,
 * from a check, from a CLI, and eventually from the service.
 */
export async function observe({ cwd = null, store = null, witness = null, register = REGISTER } = {}) {
  const { build, provenance } = await observeBuild(cwd);
  let anchored = 'never';
  if (typeof witness === 'function') {
    // Checked against the published shape rather than against `Date.parse`, which accepts
    // things the record does not — and a witness whose answer is unreadable stays at
    // `never`, because the conservative direction is the one that refuses a claim. A
    // stamp nobody can parse is not evidence that anything was witnessed.
    const seen = await ok(Promise.resolve().then(() => witness()));
    if (TYPES.since.ok(seen?.at)) anchored = seen.at;
  }
  return {
    storage: observeStorage(store),
    anchoring: typeof witness === 'function',
    anchored,
    retention: observeRetention(register),
    build,
    provenance,
  };
}

/* ---------------------------------------------------------------- refusing */

/**
 * Everything wrong with a posture *as a posture* — the shape, before the judgement.
 *
 * Pointed at an object rather than reading anything itself, so a check can hand it a
 * deliberately broken posture and watch each rule fire. The same discipline
 * `entryProblems` and `tableProblems` keep, and for the same reason: a rule that only
 * ever runs against a value which passes is a rule nobody has seen work.
 */
export function postureProblems(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['not a posture'];
  const problems = [];
  for (const name of POSTURE_FIELDS) {
    if (!Object.hasOwn(p, name)) problems.push(`${name} is missing — a posture states every field or it states nothing`);
    // Typed here and not only at `attest`, because `unbacked` reads these values to write
    // sentences and a value outside the vocabulary would come back as prose about the
    // wrong thing — "enforced by the application" for a `storage` of `banana`. A
    // judgement about a value nobody minted is worse than a refusal to judge.
    else if (!TYPES[FIELDS.posture[name]].ok(p[name])) problems.push(`${name} must be ${TYPES[FIELDS.posture[name]].why}`);
  }
  for (const name of Object.keys(p)) {
    if (!POSTURE_FIELDS.includes(name)) problems.push(`${name} is not part of a posture — the vocabulary is the published one`);
  }
  return problems;
}

/**
 * Why this posture cannot back a claim, as sentences. Empty means it can.
 *
 * Every sentence names the thing an auditor would otherwise have to ask about, because
 * this text is what ends up in a report somebody reads a year later and "posture check
 * failed" is not a finding anybody can act on. `at` is the moment the judgement is made,
 * which is the posture record's own instant when this is walked over history — judging a
 * March posture against today's clock would call every closed interval stale.
 */
export function unbacked(p, { at = new Date().toISOString() } = {}) {
  const shape = postureProblems(p);
  if (shape.length) return shape;

  const why = [];
  if (p.storage !== 'storage') {
    why.push(
      p.storage === 'unknown'
        ? 'the deployment could not establish how its records are stored, so it cannot say who could delete one'
        : p.storage === 'none'
          ? 'nothing enforces append-only where the records are kept — they can be edited in place'
          : 'append-only is enforced by the application and not by the store, so an administrator can rewrite the record'
    );
  }
  if (!p.anchoring) why.push('anchoring is not configured, so no head is witnessed anywhere the local operator does not administer');
  else if (p.anchored === 'never') why.push('anchoring is configured and has never succeeded, so nothing has been witnessed yet');
  else {
    const age = (instant(at) - instant(p.anchored)) / HOUR;
    if (Number.isFinite(age) && age > MAX_ANCHOR_AGE_HOURS) {
      why.push(`the last successful anchor was ${Math.round(age)} hours before this, and an anchor witnesses only the head it saw`);
    }
  }
  if (p.retention !== 'permanent') {
    const months = Number.isSafeInteger(p.retention) ? p.retention : 0;
    if (months < OBSERVATION_MONTHS) {
      why.push(`evidence is kept ${months} month(s), and a report relied on for a twelve-month window needs ${OBSERVATION_MONTHS}`);
    }
  }
  if (p.build === 'unknown') why.push('the deployment cannot say which build it is running');
  else if (p.provenance === 'mismatched') why.push('the running tree is not the build it reports, so what produced the record is not what is on the record');
  else if (p.provenance !== 'matched') why.push('the deployment could not establish whether it is running the build it reports');
  return why;
}

/** `verified` only when there is nothing left to say against it. */
export function verdictOf(p, opts = {}) {
  return unbacked(p, opts).length ? 'unverified' : 'verified';
}

/* -------------------------------------------------------------- publishing */

/**
 * A posture as a record on the chain — the first one, or the next one.
 *
 * Goes through `genesis`/`next` in lib/publishable.js rather than assembling anything,
 * which is what keeps "the service never holds content" a property of one function: a
 * posture is not a special case with its own envelope, it is a kind, and it links to the
 * record before it exactly as every other kind does. A posture that travelled some other
 * way would be a posture that could be left out of the interval where it was bad.
 */
export function attest(previous, posture, { instance = null, at = now() } = {}) {
  const problems = postureProblems(posture);
  if (problems.length) throw new Error(`this posture cannot be attested:\n  - ${problems.join('\n  - ')}`);
  const fields = {};
  for (const name of POSTURE_FIELDS) fields[name] = posture[name];
  return previous ? next(previous, 'posture', fields, { at }) : genesis(instance, 'posture', fields, { at });
}

/** The posture back out of a published record — the inverse of what `attest` put in. */
export function postureOf(rec) {
  if (rec?.kind !== 'posture') return null;
  const p = {};
  for (const name of POSTURE_FIELDS) p[name] = rec[name];
  return p;
}

/* ------------------------------------------------- the continuity report */

/**
 * The run of records cut into the intervals each posture covers.
 *
 * A posture holds until the next one replaces it, so the segment a record opens ends
 * where the following posture record begins — `until` is null on the last one, which is
 * still in force. Each segment carries its own verdict, judged at the moment it was
 * observed rather than against the clock of whoever is reading, and the fields that
 * changed from the segment before it. That last part is what makes a posture change
 * *render*: an interval in which anchoring went off and came back is two segments with a
 * named difference between them, not an average.
 */
export function segments(records) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r?.kind === 'posture');
  const out = [];
  list.forEach((rec, i) => {
    const posture = postureOf(rec);
    const previous = i ? postureOf(list[i - 1]) : null;
    const changed = previous ? POSTURE_FIELDS.filter((f) => previous[f] !== posture[f]) : [];
    out.push({
      from: rec.at,
      until: i + 1 < list.length ? list[i + 1].at : null,
      seq: rec.seq,
      posture,
      changed,
      why: unbacked(posture, { at: rec.at }),
      verdict: verdictOf(posture, { at: rec.at }),
    });
  });
  return out;
}

const overlaps = (seg, from, to) => {
  const a = instant(seg.from);
  const b = seg.until === null ? Infinity : instant(seg.until);
  return a < to && b > from;
};

/**
 * Whether an interval may be claimed, and everything an auditor would ask if it may not.
 *
 * Computed from published records and nothing else — no repository, no content, no
 * network and no beadcause install — because a verifier only the vendor can run is a
 * verifier the audit has to take the vendor's word for. `beadcause-attest verify` is a
 * few lines of argument parsing over this function; the service, when it exists, will
 * call the same one.
 *
 * Four separate ways an interval fails, and they are reported separately because they are
 * fixed by different people:
 *
 * - the chain does not link, so the records are not one unbroken run (lib/publishable.js
 *   proves that half, from digests alone);
 * - part of the interval is covered by no posture at all, which is the silence
 *   bc-3muu.5 turns into a finding rather than an absence;
 * - a posture covering it could not back a claim, and each such segment says why;
 * - a chain head was published inside an interval no posture can back, which is the
 *   acceptance in one line: a head published under an unverifiable posture is a number,
 *   not a witness.
 *
 * `from` and `to` default to the span the records themselves cover, so the cheap call —
 * hand it everything and ask — answers about the whole run.
 */
export function report(records, { from = null, to = null } = {}) {
  const list = Array.isArray(records) ? records : [];
  const segs = segments(list);
  const stamps = list.map((r) => instant(r?.at)).filter(Number.isFinite);
  const start = from === null ? (stamps.length ? Math.min(...stamps) : NaN) : instant(from);
  const end = to === null ? (stamps.length ? Math.max(...stamps) : NaN) : instant(to);

  const why = [];
  // There is deliberately no way to hand the link verdict in ready-made. An option that
  // let a caller supply "the chain is fine" would be the one hole through which a report
  // could be made to say `verified` about records nobody checked, and a verifier with a
  // parameter that turns off the checking is not a verifier.
  for (const p of linkProblems(list)) why.push(`the chain does not link: ${p}`);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    why.push('there is no interval to report on');
    return { from, to, verdict: 'unverified', why, segments: segs, covering: [], uncovered: [], heads: [] };
  }

  const covering = segs.filter((s) => overlaps(s, start, end));
  if (!covering.length) why.push('no posture covers this interval, so nothing about the deployment is attested for it');

  // Gaps, in the order they occur: before the first posture, and between any two whose
  // ends do not meet. A posture record cannot say anything about the time before it was
  // taken, so the run-up to the first one is a gap like any other.
  const uncovered = [];
  let cursor = start;
  for (const s of covering) {
    const a = instant(s.from);
    if (a > cursor) uncovered.push({ from: new Date(cursor).toISOString(), until: new Date(a).toISOString() });
    const b = s.until === null ? Infinity : instant(s.until);
    if (b > cursor) cursor = b;
  }
  if (cursor < end) uncovered.push({ from: new Date(cursor).toISOString(), until: new Date(end).toISOString() });
  for (const gap of uncovered) why.push(`nothing attests the deployment's posture from ${gap.from} to ${gap.until}`);

  for (const s of covering) {
    for (const p of s.why) why.push(`from ${s.from}, ${p}`);
  }

  const heads = [];
  for (const rec of list) {
    if (rec?.kind !== 'chain-head') continue;
    const t = instant(rec.at);
    if (!Number.isFinite(t) || t < start || t > end) continue;
    const seg = covering.find((s) => instant(s.from) <= t && (s.until === null || instant(s.until) > t));
    if (!seg || seg.verdict !== 'verified') heads.push({ at: rec.at, ref: rec.ref, head: rec.head, backed: false });
  }
  for (const h of heads) why.push(`the head published at ${h.at} is not backed by a posture that could support a claim`);

  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    verdict: why.length ? 'unverified' : 'verified',
    why,
    segments: segs,
    covering,
    uncovered,
    heads,
  };
}

/**
 * The report as lines somebody reads.
 *
 * The verdict first and the reasons under it, because the one thing a reader must not be
 * able to do is skim a wall of detail and come away with the impression of compliance. A
 * posture change is rendered as the fields that changed rather than as a second full
 * posture, so five weeks of anchoring being off is one visible line rather than a diff
 * the reader has to do themselves.
 */
export function render(rep) {
  const lines = [];
  lines.push(`${rep.verdict.toUpperCase()} — ${rep.from} to ${rep.to}`);
  lines.push('');
  for (const s of rep.covering) {
    const span = s.until === null ? `${s.from} onwards` : `${s.from} to ${s.until}`;
    lines.push(`  ${s.verdict === 'verified' ? '✓' : '✗'} ${span}`);
    if (s.changed.length) lines.push(`      changed: ${s.changed.map((f) => `${f}=${format(s.posture[f])}`).join(', ')}`);
    else lines.push(`      ${POSTURE_FIELDS.map((f) => `${f}=${format(s.posture[f])}`).join(', ')}`);
    for (const p of s.why) lines.push(`      · ${p}`);
  }
  if (!rep.covering.length) lines.push('  (no posture covers this interval)');
  const structural = rep.why.filter((p) => !p.startsWith('from '));
  if (structural.length) {
    lines.push('');
    for (const p of structural) lines.push(`  · ${p}`);
  }
  return lines;
}
