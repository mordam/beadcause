/**
 * The instance's half of the publication protocol — an append-only local chain, and a
 * publisher that sends whatever the far end has not witnessed yet.
 *
 * Three files, one mechanism, and they split where the trust does. lib/publishable.js is
 * what may leave the Mac: a closed vocabulary of hashes and metadata, and the only place a
 * record can be minted. lib/witness.js is what the far end may do with one: store it,
 * refuse it, attest to having been told it, and compare two histories. This file is the
 * instance: it keeps the chain, and it publishes.
 *
 * **The local chain is the record; the service corroborates it.** That is the whole
 * arrangement and it is why nothing here waits on a network. A record is appended locally
 * and is a fact the moment it is committed; publication is a separate act that may happen
 * seconds later or after a week on a plane. A daemon with no route to the service keeps
 * working indefinitely — what it cannot do is *claim* the period it never published, and
 * refusing that claim is `claimProblems` in lib/continuity.js.
 *
 * **Append-only is stated twice, and the second one is the one that matters.** The chain
 * is commits on `refs/beadcause/publications` in the common repo, so `verifyRef` in
 * lib/evidence.js can say it is linear and intact — the same shape `refs/beadcause/foundations`
 * uses for what an agent is permitted to be. But an intact chain is only evidence that
 * *something* is a chain: a history rewritten wholesale is perfectly linear and perfectly
 * intact. So every record also names the digest of the record before it, inside the payload
 * that is published, and `linkProblems` walks those digests. Rewriting the ref is a git
 * operation; rewriting the ref *and* keeping the published digests consistent with a head
 * the service already holds is not an operation at all. `verifyChain` asks both questions
 * and reports them separately, because they fail separately.
 *
 * **Publishing continuously rather than on a schedule is a Type II decision, not a
 * performance one.** A window is only as good as its densest gap; a daily push means every
 * day is a day of unwitnessed history, and no amount of care afterwards recovers it. So
 * `publish` is written to be called often and to be cheap when there is nothing to do — it
 * asks the service where it got to, sends the tail in order, and stops at the first thing
 * it cannot account for.
 *
 * **It asks rather than remembers, and that is deliberate.** Keeping a local high-water
 * mark would be one number to be wrong, and it would be wrong in the direction that hurts:
 * an instance that thinks it published up to seq 40 skips 40 forever if the service never
 * had it. The service is the authority on what the service received, so every publication
 * begins by asking — which also means every publication is a divergence check, run
 * continuously, instead of a thing somebody remembers to do quarterly.
 *
 * **Fail open for work is kept by `publishQuietly` rather than promised in this note.** It
 * is the door a daemon path calls: an outcome for every way a transport can fail, including
 * the one a `try` does not cover — a connection that is accepted and then silent, which
 * hangs a tick as completely as a crash and more quietly. The other half of the rule, that
 * an unpublished period is refused a claim rather than rendering as a clean window, is
 * lib/continuity.js, and it is deliberately not in this file: the report is asked for at
 * both ends and anything the far end needs cannot import a config directory.
 *
 * **A head is published under a posture, or it is a number with a timestamp on it.** That
 * is bc-3muu.12's half and it lives here because this is where records are appended. The
 * chain head is what an anchor witnesses, and an auditor holding an anchored head from a
 * deployment that attested nothing can say the head existed by then and nothing whatever
 * about whether the thing that produced it could have rewritten the store underneath.
 * `recordAttestedHead` writes the posture and the head together, in that order and at one
 * instant, and `recordPosture` writes a posture only when the chain has stopped stating
 * what this deployment can back up — which is a question about the judgement rather than
 * about the six fields, because an anchor that quietly goes stale changes neither.
 *
 * Transport is not here. `publish` takes `head` and `deliver` as functions, so the same
 * loop drives an HTTP client, a queue, or a test's in-process ledger, and there is no code
 * path in the daemon that a service outage can throw through. What the far end actually
 * is, and where it runs, is bc-3muu.9; how an instance comes to have a token at all is
 * bc-3muu.2. Neither is decided here, and both are reachable without touching this file.
 */
import { ensureRepo } from './commonrepo.js';
import { verifyRef } from './evidence.js';
import { commitToRef, git, gitInput, ok, refTip, writeTree } from './gitref.js';
import { POSTURE_FIELDS, observe, postureOf, postureProblems, verdictOf } from './posture.js';
import { chainHeadFields, genesis, head as chainHead, linkProblems, next, now, recordDigest } from './publishable.js';
import { compare, receiptProblems } from './witness.js';

/** Where the chain lives. Outside `refs/heads/*`, so no checkout ever sees it. */
export const PUBLICATION_REF = 'refs/beadcause/publications';

/** One record per commit, under this name. The commit *is* the append. */
const RECORD_FILE = 'record.json';

/**
 * Records out of a list of commits, in the order asked for.
 *
 * `cat-file --batch` rather than one read per commit: a chain is walked whole every time
 * it is verified, and a per-commit read makes that cost grow with the history it is
 * supposed to make cheap to keep. Two git calls for any length of chain.
 *
 * A commit whose record cannot be read is skipped, and that is the honest handling rather
 * than the lazy one: what cannot be read is not held, and the hole it leaves surfaces as a
 * jump in `seq` the next time `linkProblems` walks the chain — which is exactly what a
 * deletion is, and exactly how it should read.
 */
async function readRecords(cwd, shas) {
  if (!shas.length) return [];
  const out = await gitInput(cwd, ['cat-file', '--batch'], shas.map((s) => `${s}:${RECORD_FILE}`).join('\n') + '\n');
  const lines = out.split('\n');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    // `<oid> blob <size>` and then the blob. Every record is written as one line of JSON,
    // which is what makes a line-oriented read of a byte-oriented format correct here —
    // lib/publishable.js refuses a string that spans lines, so there is no second line.
    if (!/^[0-9a-f]{40,64} blob \d+$/.test(lines[i])) continue;
    try {
      records.push(Object.freeze(JSON.parse(lines[++i])));
    } catch {
      /* not a record any more; see the note above */
    }
  }
  return records;
}

/**
 * The whole chain, oldest first, and `[]` for an install that has never published.
 *
 * No limit, on purpose. A count or a walk that quietly stops at fifty is how a chain of
 * two hundred reports as fifty and a verification passes over the part nobody looked at —
 * the same argument `refCount` in lib/gitref.js makes for not answering a count by reading
 * a capped log.
 */
export async function chain() {
  let cwd;
  try {
    cwd = await ensureRepo();
  } catch {
    // A machine with no common repo has published nothing, which is a true answer and the
    // one that keeps a read off the critical path. It is not the same as a *sound* chain —
    // `verifyChain` says so — and nothing downstream may treat it as one.
    return [];
  }
  const shas = await ok(git(cwd, ['rev-list', '--reverse', PUBLICATION_REF]));
  return readRecords(cwd, String(shas || '').split('\n').filter(Boolean));
}

/** The record at the tip, as the head a comparison is made against, or null. */
export async function localHead() {
  const cwd = await ensureRepo();
  const tip = await refTip(cwd, PUBLICATION_REF);
  if (!tip) return null;
  const [rec] = await readRecords(cwd, [tip]);
  return rec ? chainHead([rec]) : null;
}

/**
 * Append a record to the chain — the only way anything is ever published.
 *
 * The link is derived rather than accepted: `next` in lib/publishable.js takes the previous
 * record and computes `seq` and `prev` from it, so a caller cannot compute its own link and
 * cannot compute it wrong. All this adds is the storage and the compare-and-swap, and the
 * swap is not a formality — two writers appending at once is the failure the whole shape
 * exists to survive, and losing one of them silently is how a chain acquires a gap that
 * reads later as a deletion.
 *
 * `instance` is required for the first record and refused for the rest: after that the
 * chain says whose it is, and letting a caller re-state it is inviting the day the two
 * disagree.
 */
export async function append(kind, fields = {}, { instance = null, at = undefined } = {}) {
  const cwd = await ensureRepo();
  const tip = await refTip(cwd, PUBLICATION_REF);
  const last = tip ? (await readRecords(cwd, [tip]))[0] ?? null : null;

  if (last && instance && instance !== last.instance)
    throw new Error(`this chain belongs to ${last.instance}, and the append names ${instance}`);
  if (!last && !instance) throw new Error('the first record of a chain names the instance publishing it');

  const rec = last ? next(last, kind, fields, { at }) : genesis(instance, kind, fields, { at });
  const digest = recordDigest(rec);
  const tree = await writeTree(cwd, [[RECORD_FILE, Buffer.from(JSON.stringify(rec) + '\n')]]);
  const { commit } = await commitToRef(
    cwd,
    PUBLICATION_REF,
    tree,
    // Readable with `git log` alone, and it carries the digest rather than the payload:
    // the subject line of an evidence commit is read far more often than its tree, and a
    // digest is the one thing a reader can check the record against.
    [`publish ${kind} #${rec.seq}`, '', `instance ${rec.instance}`, `digest ${digest}`].join('\n'),
    { expect: tip }
  );
  return { record: rec, digest, commit };
}

/**
 * Append the state of an evidence ref — the bridge from lib/evidence.js to the chain.
 *
 * The one caller `verifyRef` was always waiting for. It reports `anchored` as null for
 * every caller today because nothing records a head to check against, and this is where
 * the head starts being recorded: the ref, its tip, its length and the two soundness
 * answers, published as they were seen.
 *
 * `chainHeadFields` does the narrowing, and it is a projection rather than a pass-through
 * for a reason worth restating here — `why` in the verifier's result is prose, prose does
 * not cross, and a widening of the verifier must not become a widening of what leaves the
 * Mac by nobody doing anything.
 *
 * A ref with no commits is refused rather than published as a head of nothing. Whether an
 * *absent* chain is worth reporting is a real question and it is bc-3muu.5's; what it is
 * not is a chain-head record, and answering it with one would put a claim on the record
 * that nothing on this Mac stands behind.
 */
export async function recordChainHead(cwd, ref, { at } = {}) {
  const verify = await verifyRef(cwd, ref);
  if (!verify.head) throw new Error(`${ref} has no commits in ${cwd}, so there is no head to publish`);
  return append('chain-head', chainHeadFields(verify), { at });
}

/* --------------------------------------------------- the posture behind it */

/**
 * The posture the chain currently states, with the record that stated it, or null.
 *
 * "In force" is the last `posture` record and not a stored current state, because that is
 * the rule `segments` in lib/posture.js reads a chain by: a posture holds until another
 * replaces it. Keeping a second copy of it anywhere would be a number to be wrong, and it
 * would be wrong in the direction that hurts — an install that believes it already
 * attested skips the attestation forever.
 *
 * Null on a chain that has never stated one, and that is not the same answer as a chain
 * stating that it knows nothing. An install that has attested nothing has attested
 * nothing: the run-up to a first posture renders as an interval nothing attests rather
 * than as a clean one, which is `report`'s job and not this one's.
 *
 * The whole chain is walked, for the reason `chain` gives for not capping itself: a read
 * that quietly stops at fifty is how a posture set at record sixty stops being in force
 * without anybody changing it.
 */
export async function postureInForce() {
  const records = await chain();
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.kind === 'posture') return { record: records[i], posture: postureOf(records[i]) };
  }
  return null;
}

/**
 * Whether the chain has stopped saying what this deployment can back up.
 *
 * Two ways it stops, and a field comparison alone catches only the first. Something
 * observed differently — anchoring turned off, the store moved, somebody edited the tree
 * under the daemon — is the obvious one. The other is that nothing changed and time
 * passed: `unbacked` judges a posture at the instant its own record was written, so a
 * deployment that anchored once in January and never again holds a posture whose six
 * fields are identical all year, and that single January record renders the whole year as
 * the January it was true for.
 *
 * So the question asked is the judgement rather than the fields, which subsumes both — a
 * changed field that changes nothing about what can be backed still restates, because the
 * record is what an auditor reads and a store that moved is worth reading.
 */
const restating = ({ record, posture: inForce }, posture, at) =>
  POSTURE_FIELDS.some((f) => inForce[f] !== posture[f]) ||
  verdictOf(inForce, { at: record.at }) !== verdictOf(posture, { at });

/**
 * Observe this deployment's posture and append it, when the chain has stopped stating it.
 *
 * The crossing above appends exactly once. The moment the fresh record is on the chain the
 * posture in force is judged at its own new instant, the two agree again, and a daemon
 * publishing hourly goes back to appending nothing — which is what keeps "publish the
 * posture with every head" from meaning a chain that is mostly postures.
 *
 * **Every argument is a place to look, and there is deliberately no parameter that states
 * a posture value.** `test/publication.mjs` reads this signature and fails the repo if one
 * appears, which is the rule `test/posture.mjs` keeps over `observe`, kept a second time
 * at the door into the chain: an observer that cannot be told what to say is worth nothing
 * if the funnel in front of the record can be.
 *
 * An unchanged posture comes back with `changed: false` and the record still in force, and
 * writes nothing. Nothing about that is a failure — it is the ordinary answer.
 */
export async function recordPosture({ cwd = null, store = null, witness = null, register, instance = null, at = now() } = {}) {
  const posture = await observe({ cwd, store, witness, register });

  // Unreachable through `observe`, which is exactly why it is here rather than trusted
  // away: this is the last thing between a later widening of the observer and a malformed
  // record on a chain that has no way to take one back off. `attest` in lib/posture.js
  // keeps the same guard over the same projection, and the two are not merged because
  // that one mints a record and this one has to go through `append` — the compare-and-swap
  // is the reason there is exactly one way anything reaches this ref.
  const problems = postureProblems(posture);
  if (problems.length) throw new Error(`this posture cannot be attested:\n  - ${problems.join('\n  - ')}`);

  const inForce = await postureInForce();
  if (inForce && !restating(inForce, posture, at)) {
    return { changed: false, posture, record: inForce.record, digest: null, commit: null };
  }

  const fields = {};
  for (const name of POSTURE_FIELDS) fields[name] = posture[name];
  return { changed: true, posture, ...(await append('posture', fields, { instance, at })) };
}

/**
 * A head published under a posture the chain states — the two together, in that order.
 *
 * bc-3muu.12's acceptance in one function. A `chain-head` is what gets anchored, and an
 * anchored head whose deployment attested nothing is a number with a timestamp on it: an
 * auditor holding it can say the head existed by then and nothing at all about whether the
 * thing that produced it could have rewritten the store underneath. `report` in
 * lib/posture.js already refuses such a head — it comes back in `heads` as unbacked — and
 * this is the writer that stops one being published by accident in the first place.
 *
 * **The order is the point and it is not cosmetic.** A posture record cannot say anything
 * about the time before it was taken, so a head published first sits in the run-up gap and
 * is unbacked no matter what follows it. Posture, then head.
 *
 * **One instant for both**, materialised here rather than defaulted twice, because a
 * segment covers `from <= t` and two reads of the clock either side of a git commit are
 * not the same number. A head a millisecond ahead of the posture attesting it would report
 * as uncovered, which is a true statement about an arrangement nobody meant to make.
 *
 * `cwd` and `deployment.cwd` are different directories and both are named for what they
 * are: the first is the repository holding the evidence ref being published, the second is
 * the checkout the daemon is running from, which is the only one that can answer whether
 * the code running is the code it reports. On this Mac they are usually not the same, and
 * on a deployment publishing somebody else's ref they never are.
 */
export async function recordAttestedHead(cwd, ref, { deployment = {}, instance = null, at = now() } = {}) {
  const posture = await recordPosture({ ...deployment, instance, at });
  const head = await recordChainHead(cwd, ref, { at });
  return { posture, head };
}

/**
 * Whether the chain holds together — asked twice, because it can fail twice.
 *
 * `linear` and `intact` are git's answer: no commit has two parents, and every parent named
 * is in the walk back to a single root. `links` is the payload's answer: every record names
 * the digest of the one before it, and the sequence numbers run without a gap. The two
 * catch different things — a grafted history fails the first, a record swapped in place
 * fails the second — and reporting them as one boolean would let either hide behind the
 * other.
 *
 * `records` against `length` is the third question and the cheapest: a commit on this ref
 * that carries no readable record is a commit somebody made by hand.
 *
 * An absent chain is `present: false` and not sound, which is not a finding by itself — an
 * install that has published nothing has published nothing. Whether *that* is acceptable
 * for a period somebody wants to claim is bc-3muu.4.
 */
export async function verifyChain({ anchor = null } = {}) {
  const cwd = await ensureRepo();
  const ref = await verifyRef(cwd, PUBLICATION_REF, { anchor });
  const records = await chain();
  const links = records.length ? linkProblems(records) : [];
  return Object.freeze({
    ...ref,
    present: Boolean(ref.head),
    records: records.length,
    links: Object.freeze(links),
    sound: Boolean(ref.head) && ref.linear && ref.intact && !links.length && ref.length === records.length,
  });
}

/** A publication attempt that got nowhere, in the shape a successful one comes back in. */
const outcome = (verdict, why, extra = {}) =>
  Object.freeze({ verdict, divergent: false, why, sent: 0, receipts: Object.freeze([]), pending: 0, ...extra });

/**
 * Send everything the service has not witnessed, in order, and report what happened.
 *
 * The sequence is the argument. Ask where the far end got to; compare that against the
 * local chain; publish only if the two agree about everything they both hold. A daemon that
 * publishes onto a service it already disagrees with buries the disagreement under records
 * that link onto it, and the discrepancy the whole arrangement exists to surface becomes a
 * discrepancy in the middle of a chain nobody re-walks.
 *
 * **Unreachable is not a failure and does not throw.** `offline` comes back with whatever
 * was sent before the connection went, and `pending` says how much is still queued. Work
 * never blocks on the service, so neither does this — the caller logs it and gets on with
 * the day.
 *
 * **A receipt is checked against the record in hand.** A service that acknowledges a
 * different record is not a service having a bad day, it is the far end attesting to
 * something this instance did not send, and filing that as proof is how a gap ends up
 * inside a period somebody later claims to have covered. It stops the run and comes back
 * as divergent.
 */
export async function publish({ head, deliver } = {}) {
  if (typeof head !== 'function' || typeof deliver !== 'function')
    throw new Error('publish needs a `head` to ask and a `deliver` to send with — transport is the caller\'s');

  const records = await chain();

  let remote;
  try {
    remote = await head();
  } catch (err) {
    return outcome('offline', `the service could not be asked where it got to: ${err.message}`, { pending: records.length });
  }

  const cmp = compare(records, remote);
  if (cmp.divergent) return Object.freeze({ ...cmp, sent: 0, receipts: Object.freeze([]), pending: 0 });

  const receipts = [];
  for (const rec of cmp.unpublished) {
    let receipt;
    try {
      receipt = await deliver(rec);
    } catch (err) {
      return Object.freeze({
        ...cmp,
        verdict: 'offline',
        why: `${receipts.length} of ${cmp.unpublished.length} record(s) published, then the service went away: ${err.message}`,
        sent: receipts.length,
        receipts: Object.freeze(receipts),
        pending: cmp.unpublished.length - receipts.length,
      });
    }
    const problems = receiptProblems(receipt, rec);
    if (problems.length)
      return Object.freeze({
        ...cmp,
        verdict: 'unreceipted',
        divergent: true,
        why: `the service acknowledged seq ${rec.seq} with something else: ${problems[0]}`,
        sent: receipts.length,
        receipts: Object.freeze(receipts),
        pending: cmp.unpublished.length - receipts.length,
      });
    receipts.push(receipt);
  }

  return Object.freeze({
    ...cmp,
    verdict: receipts.length ? 'published' : cmp.verdict,
    why: receipts.length ? `${receipts.length} record(s) published, up to seq ${receipts[receipts.length - 1].seq}` : cmp.why,
    sent: receipts.length,
    receipts: Object.freeze(receipts),
    pending: 0,
  });
}

/**
 * How long the service gets to answer before the attempt is abandoned as offline.
 *
 * Thirty seconds, and it exists because "unreachable does not throw" is only half of what
 * work never blocking on the service requires. A connection that is refused comes back in
 * milliseconds; a connection that is *accepted* and then answers nothing hangs for as long
 * as the operating system's keepalive lets it, which on a laptop that changed networks can
 * be minutes. A daemon tick awaiting that has blocked on the service just as completely as
 * one that crashed on it, and the failure is worse for being invisible.
 */
export const PUBLISH_DEADLINE_MS = 30_000;

/** A transport call with a deadline on it — resolved, or abandoned as the service's silence. */
function deadlined(fn, deadlineMs, what) {
  return async (...args) => {
    let timer;
    try {
      return await Promise.race([
        fn(...args),
        new Promise((_, reject) => {
          // Not `unref`ed, deliberately. An unreferenced deadline is one node will not
          // wait for, so a transport that hangs forever would let the process fall out of
          // the event loop with the attempt neither answered nor abandoned — the deadline
          // must be the thing keeping it alive. `clearTimeout` in the `finally` is what
          // stops it outliving an answer that did arrive.
          timer = setTimeout(() => reject(new Error(`${what} did not answer within ${deadlineMs}ms`)), deadlineMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Publish if it is possible to, and never let the attempt matter to the caller.
 *
 * The door a daemon path may call, and the reason it exists rather than being a `try` at
 * every call site: **fail open for work**. Everything beadcause does — sessions opening,
 * merges landing, questions arriving — happens whether or not a service is reachable, and a
 * publication that can throw, reject or hang is a publication that eventually stops one of
 * them. `publish` already declines to throw for the failures it can name; this declines to
 * throw for the ones it cannot, and puts a deadline on the two calls that reach a network.
 *
 * The deadline is here rather than in the transport on purpose, even though transport is
 * emphatically the caller's. A timeout is a policy about *work*, not about HTTP: it says
 * how long the day may be held up by a server, and a policy every caller has to remember
 * to apply is a policy one of them will not. `publish` stays transport-agnostic; this is
 * where the promise that work does not block is actually kept.
 *
 * Everything comes back as an outcome, including a transport that was never given and a
 * chain that could not be read. Nothing is retried and nothing is queued in memory — the
 * queue is the chain on disk, it is durable, and the next call sends whatever is still
 * unwitnessed. **What this never does is make an outage look clean**: `pending` says how
 * much is unpublished, and a period that stayed unpublished is refused a claim by
 * `claimProblems` in lib/continuity.js rather than quietly passing.
 */
export async function publishQuietly({ head, deliver, deadlineMs = PUBLISH_DEADLINE_MS } = {}) {
  if (typeof head !== 'function' || typeof deliver !== 'function')
    return outcome('offline', 'no transport was given, so nothing could be published — work carries on regardless');

  try {
    return await publish({
      head: deadlined(head, deadlineMs, 'the service'),
      deliver: deadlined(deliver, deadlineMs, 'the service'),
    });
  } catch (err) {
    // Reached only by something `publish` does not already answer for — a common repo that
    // vanished mid-run, a git that is not there. Still not the caller's problem: the chain
    // is on disk, the next attempt reads it again, and work is not waiting on either.
    return outcome('offline', `publication could not be attempted at all: ${err.message}`);
  }
}
