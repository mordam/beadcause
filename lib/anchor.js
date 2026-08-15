/**
 * The anchor — a chain head written down somewhere nobody involved can rewrite it.
 *
 * bc-3muu builds a central service so a daemon's evidence chain has a second holder. That
 * is corroboration, and it is worth having, but it is not independence: beadcause writes
 * the daemon, beadcause writes the service, and the same operator administers both. An
 * auditor who wants to be difficult says "you could have rewritten both copies", and they
 * are right — nothing in a system you run end to end can answer that.
 *
 * **So this is the thin slice that is genuinely third-party, and the trick is that we do
 * not build it.** Independence is not a feature; it is the property of somebody else
 * holding the record. What is built here is the *client*: what we send (a hash, and
 * nothing else), what comes back (two receipts), and — the part that actually matters —
 * how either receipt is checked years later by somebody holding only the files.
 *
 * **Two tiers doing different jobs, and conflating them loses the argument.** The
 * control-daemon in bc-3muu.9 is continuous and high-resolution: every transition, seconds
 * after it happens. The anchor is rare and coarse: one head an interval, timestamped
 * outside our administration. It cannot say what happened *between* anchors and it is not
 * meant to. What it says is that everything before this point existed by then and has not
 * been rewritten since — which is exactly the claim no amount of first-party record
 * keeping can make.
 *
 * **Both receipts, every time, because they fail differently** — settled on the bead, and
 * it is the reason the pair is worth the extra hundred lines. lib/timestamp.js holds a
 * signature from a named authority: it verifies offline, forever, with no service that has
 * to still exist, and its weakness is that it is one party whose compromise takes its
 * assurance with it. lib/translog.js holds an inclusion proof against a signed, public,
 * append-only structure: its weakness is that checking it *well* means checking the log
 * stayed consistent, and its strength is that no single party can rewrite it unseen. An
 * auditor who distrusts one is unlikely to distrust the other for the same reason.
 *
 * **The receipt is kept with the head it covers, and that is a shape rather than a
 * promise.** A receipt separated from what it anchors proves nothing at all — it is a
 * signature over a number — so an anchor is one record carrying the ref, the head, the
 * digest, and both receipts, and `anchorProblems` refuses one that is missing either half.
 * There is nowhere in this file to put a receipt without the head.
 *
 * **Nothing but a hash ever leaves.** What is anchored is the digest of the `chain-head`
 * record from lib/publishable.js — so the boundary argued there survives out to a party we
 * have no agreement with at all: the third party learns a 32-byte number and the time it
 * saw it, and could not tell you which repository, which bead, or even which product it
 * came from. That is also why the anchor cannot double as a backup, which was asked and
 * settled: a hash is not a copy, and off-site recovery of the evidence is an availability
 * control over the service rather than a job for a witness.
 *
 * **And the point of all of it is one field.** `verifyRef` in lib/evidence.js returns
 * `linear`, `intact` and `anchored`, and only the third can catch a deliberate rewrite —
 * a forged history is *perfectly* intact. It has been null for every caller since it was
 * written, because nothing recorded a head to pass it. `withAnchor` is that head, and
 * `rewriteProblems` is the sentence an operator gets when the answer comes back false.
 *
 * A leaf over three other leaves — node:crypto by way of lib/publishable.js, lib/der.js,
 * lib/timestamp.js and lib/translog.js. No store and no transport: where anchors are
 * retained and what submits them belongs with bc-3muu.3, and this file is what those must
 * produce and check.
 */
import { TYPES, digest, recordDigest } from './publishable.js';
import { leafHash, verifyCheckpoint, verifyInclusion } from './translog.js';
import { hashBytes, requestFor, verifyToken } from './timestamp.js';

/**
 * How often a head is anchored, stated rather than implied.
 *
 * An interval nobody wrote down cannot be missed, which sounds like a convenience and is
 * actually the failure: without a stated period there is no such thing as a *late* anchor,
 * so a log that quietly stopped anchoring in April renders as an unbroken run of green.
 * Daily is the coarse tier on purpose — the continuous claim is the control-daemon's job,
 * and an hourly anchor costs a third party a request an hour to say something a daily one
 * already says.
 */
export const DEFAULT_INTERVAL_HOURS = 24;

/**
 * How late an anchor may be before the interval it should have covered is called
 * unanchored. Not generosity — a fixed, stated tolerance is what makes "missed" a fact
 * rather than an argument about clocks and cron drift.
 */
export const TOLERANCE = 1.5;

/* ------------------------------------------------------------ what is anchored */

/**
 * What actually gets submitted for a published head: one digest, and its own hash of it.
 *
 * Deliberately a projection of a `chain-head` record rather than of a repository state.
 * The record is the thing the service holds and the thing continuity is proved over, so
 * anchoring anything else would leave the two claims describing different objects — and a
 * receipt for an object nobody else holds is a receipt nobody can use.
 */
export function subjectOf(record) {
  const d = recordDigest(record);
  return { record: d, entry: Buffer.from(d, 'utf8'), leaf: leafHash(Buffer.from(d, 'utf8')) };
}

/**
 * The bytes that would leave the machine for one head — both submissions, in one place.
 *
 * A caller that assembles either request itself is a caller that can put something else in
 * it, so there is one funnel here as there is in lib/publishable.js. `entry` is the ASCII
 * digest and nothing else: the smallest thing that can be logged, with no structure in it
 * for a field to hide in.
 */
export function submission(record, options = {}) {
  const subject = subjectOf(record);
  const request = requestFor(subject.record, options);
  return { digest: subject.record, timestampRequest: request.bytes, nonce: request.nonce, entry: subject.entry, leaf: subject.leaf };
}

/* -------------------------------------------------------------- the record */

const b64 = (v) => typeof v === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0;

/**
 * Everything wrong with an anchor record, as sentences — empty when it is one.
 *
 * The rule with teeth is the pair: an anchor carrying one receipt is refused rather than
 * accepted as a weaker anchor, because a half-anchored head that renders as anchored is
 * worse than one that renders as a gap. Somebody would have to notice the difference
 * later, and nobody ever does.
 */
export function anchorProblems(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['not an anchor'];
  const problems = [];
  if (!TYPES.ref.ok(a.ref)) problems.push('ref must name the chain this anchors, as a ref path');
  if (!TYPES.sha.ok(a.head)) problems.push('head must be the whole object name the chain was at');
  if (!TYPES.digest.ok(a.record)) problems.push('record must be the digest of the published head record, written `sha256:<64 hex>`');
  if (!TYPES.at.ok(a.at)) problems.push('at must be a UTC instant');

  const ts = a.timestamp;
  if (!ts || typeof ts !== 'object') problems.push('there is no timestamp receipt, and an anchor carries both or it is not an anchor');
  else if (!b64(ts.token)) problems.push('the timestamp receipt carries no token, so there is nothing to verify offline');

  const inc = a.inclusion;
  if (!inc || typeof inc !== 'object') problems.push('there is no transparency-log receipt, and an anchor carries both or it is not an anchor');
  else {
    if (typeof inc.checkpoint !== 'string' || !inc.checkpoint.includes('\n\n')) problems.push('the log receipt carries no signed checkpoint, so its root is a number nobody stands behind');
    if (!Number.isSafeInteger(inc.index) || inc.index < 0) problems.push('the log receipt has no leaf index');
    if (!Number.isSafeInteger(inc.size) || inc.size <= 0) problems.push('the log receipt has no tree size');
    if (!Array.isArray(inc.hashes) || inc.hashes.some((h) => !b64(h))) problems.push('the inclusion proof is not a list of base64 hashes');
  }
  return problems;
}

/* ------------------------------------------------------------------ checking */

/**
 * Check an anchor, both ways, and report the two verdicts separately.
 *
 * Separately is the whole design. The claim being made is that a rewrite is detectable by
 * *either* receipt alone, and a verifier that returns one boolean over both cannot support
 * it: an operator holding a token and no network, or a proof and a defunct CA, needs to
 * know that what they hold is sufficient. So `timestamp` and `inclusion` each carry their
 * own verdict and their own sentences, `independent` counts how many stood up on their
 * own, and `ok` is the strict reading — both — because degrading to one silently is how a
 * pair becomes a single point of failure nobody announced.
 *
 * Both are also checked to be about *the same digest*. Two valid receipts for two
 * different numbers are two receipts and no anchor.
 */
export function verifyAnchor(anchor, { ca = null, keys = {}, origin = null, signer = null } = {}) {
  const shape = anchorProblems(anchor);
  if (shape.length) return { ok: false, problems: shape, timestamp: null, inclusion: null, independent: 0 };

  const token = verifyToken(Buffer.from(anchor.timestamp.token, 'base64'), {
    digest: anchor.record,
    ca,
    signer,
    nonce: anchor.timestamp.nonce ? Buffer.from(anchor.timestamp.nonce, 'hex') : null,
  });

  const note = verifyCheckpoint(anchor.inclusion.checkpoint, { keys, origin });
  const inclusionProblems = [...note.problems];
  if (note.root) {
    const entry = Buffer.from(anchor.record, 'utf8');
    inclusionProblems.push(
      ...verifyInclusion({
        index: anchor.inclusion.index,
        size: anchor.inclusion.size,
        leaf: leafHash(entry),
        proof: anchor.inclusion.hashes,
        root: note.root,
      })
    );
    if (note.size !== anchor.inclusion.size) {
      inclusionProblems.push(`the proof is against a tree of ${anchor.inclusion.size} and the checkpoint signs one of ${note.size}`);
    }
  }

  const inclusion = {
    ok: inclusionProblems.length === 0,
    problems: inclusionProblems,
    origin: note.origin || null,
    size: note.size ?? null,
    signedBy: note.signedBy || [],
  };

  const problems = [...token.problems.map((p) => `timestamp: ${p}`), ...inclusion.problems.map((p) => `log: ${p}`)];
  return {
    ok: token.ok && inclusion.ok,
    problems,
    timestamp: token,
    inclusion,
    independent: (token.ok ? 1 : 0) + (inclusion.ok ? 1 : 0),
    at: token.at || null,
  };
}

/**
 * The argument `verifyRef` has been waiting for since it was written.
 *
 * `verifyRef(cwd, ref, withAnchor(a))` is the whole bridge, and it is one line because the
 * missing half was never the check — it was the store. That is bc-hzu4, and this is what
 * finally has a head to hand it.
 */
export const withAnchor = (anchor) => ({ anchor: anchor?.head });

/**
 * What a rewrite looks like when it is caught, in the sentence an operator gets.
 *
 * `verify` is the result of `verifyRef` given `withAnchor`. The interesting answer is not
 * `intact` — a rewritten history is intact, which is the entire reason this bead exists —
 * but `anchored`: the head a third party signed in March is either still in the walk or it
 * is not, and if it is not then everything before March is a different history than the one
 * that was witnessed.
 */
export function rewriteProblems(anchor, verify) {
  const problems = [];
  if (!verify || typeof verify !== 'object') return ['there is no verification to read'];
  if (verify.ref !== anchor.ref) problems.push(`the anchor is over ${anchor.ref} and the verification is of ${verify.ref}`);
  if (verify.anchored === null || verify.anchored === undefined) {
    problems.push('the ref was verified without the anchor, so the one question the anchor answers was not asked — pass withAnchor(anchor)');
  } else if (verify.anchored === false) {
    problems.push(
      `the head witnessed at ${anchor.at} (${anchor.head.slice(0, 12)}) is no longer in ${anchor.ref}, ` +
        'so history before that point has been rewritten — and the receipts say when it was not'
    );
  }
  if (verify.linear === false) problems.push(`${anchor.ref} is no longer linear, so two histories were joined and neither is the record`);
  return problems;
}

/* ----------------------------------------------------------------- coverage */

const hours = (ms) => Math.round((ms / 3600000) * 10) / 10;

/**
 * What the anchors cover, and — the part that is the acceptance criterion — what they do
 * not.
 *
 * A missed anchor has to render as an unanchored interval rather than as silence, because
 * silence is indistinguishable from a period nobody asked about, and a period nobody asked
 * about is where a rewrite would go. So this returns spans across the whole window, every
 * one of them labelled, and the sum of the unanchored ones is a number that can be put in
 * front of an auditor before they ask for it.
 *
 * **Only anchors that verified belong in this list.** Passing one that did not is how a gap
 * gets papered over by a receipt that proves nothing — `verifyAnchor` first, filter, then
 * this.
 */
export function coverage(anchors, { from, to, intervalHours = DEFAULT_INTERVAL_HOURS, tolerance = TOLERANCE } = {}) {
  const window = { from: Date.parse(from), to: Date.parse(to) };
  const span = intervalHours * 3600000 * tolerance;
  const list = (Array.isArray(anchors) ? anchors : [])
    .filter((a) => TYPES.at.ok(a?.at))
    .map((a) => ({ at: Date.parse(a.at), head: a.head, record: a.record }))
    .filter((a) => a.at >= window.from && a.at <= window.to)
    .sort((x, y) => x.at - y.at);

  const spans = [];
  const gap = (start, end, why) => {
    if (end > start) spans.push({ from: new Date(start).toISOString(), to: new Date(end).toISOString(), anchored: false, hours: hours(end - start), why });
  };

  if (!list.length) {
    gap(window.from, window.to, `nothing was anchored in this window, and an anchor was due every ${intervalHours}h`);
    return { intervalHours, tolerance, anchors: 0, spans, unanchoredHours: hours(window.to - window.from), covered: false };
  }

  gap(window.from, list[0].at, `the window opens ${hours(list[0].at - window.from)}h before the first anchor, and nothing witnessed that period`);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const nextAt = i + 1 < list.length ? list[i + 1].at : null;
    const until = Math.min(nextAt === null ? a.at + span : nextAt, window.to);
    if (until > a.at) {
      spans.push({ from: new Date(a.at).toISOString(), to: new Date(until).toISOString(), anchored: true, hours: hours(until - a.at), head: a.head, why: null });
    }
    if (nextAt !== null && nextAt - a.at > span) {
      // The anchored span above already ran to `nextAt`; the gap is the part of it that
      // ran past the interval, and it is reported as its own span rather than folded in.
      spans.pop();
      spans.push({ from: new Date(a.at).toISOString(), to: new Date(a.at + span).toISOString(), anchored: true, hours: hours(span), head: a.head, why: null });
      gap(a.at + span, nextAt, `${hours(nextAt - a.at)}h between anchors, and one was due every ${intervalHours}h`);
    }
  }
  const last = list[list.length - 1].at;
  gap(Math.max(last + span, window.from), window.to, `nothing has been anchored since ${new Date(last).toISOString()}`);

  spans.sort((x, y) => Date.parse(x.from) - Date.parse(y.from));
  const unanchored = spans.filter((s) => !s.anchored).reduce((n, s) => n + (Date.parse(s.to) - Date.parse(s.from)), 0);
  return { intervalHours, tolerance, anchors: list.length, spans, unanchoredHours: hours(unanchored), covered: unanchored === 0 };
}

/** The coverage as sentences, for a card, a log line, or an auditor who asked. */
export function describeCoverage(cov) {
  const lines = [`Anchored every ${cov.intervalHours}h; ${cov.anchors} anchor(s) in the window.`];
  for (const s of cov.spans) {
    lines.push(s.anchored ? `  anchored  ${s.from} → ${s.to} (${s.hours}h) at ${String(s.head).slice(0, 12)}` : `  UNANCHORED ${s.from} → ${s.to} (${s.hours}h) — ${s.why}`);
  }
  lines.push(cov.covered ? 'Every interval in the window is witnessed.' : `${cov.unanchoredHours}h are witnessed by nobody outside this machine.`);
  return lines;
}

/** Re-exported so a caller anchoring a head never reaches for a second hashing function. */
export { digest, hashBytes };
