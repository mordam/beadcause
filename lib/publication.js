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
 * refusing that claim is bc-3muu.4's half rather than this one's.
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
 * Transport is not here. `publish` takes `head` and `deliver` as functions, so the same
 * loop drives an HTTP client, a queue, or a test's in-process ledger, and there is no code
 * path in the daemon that a service outage can throw through. What the far end actually
 * is, and where it runs, is bc-3muu.9; how an instance comes to have a token at all is
 * bc-3muu.2. Neither is decided here, and both are reachable without touching this file.
 */
import { ensureRepo } from './commonrepo.js';
import { verifyRef } from './evidence.js';
import { commitToRef, git, gitInput, ok, refTip, writeTree } from './gitref.js';
import { chainHeadFields, genesis, head as chainHead, linkProblems, next, recordDigest } from './publishable.js';
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
