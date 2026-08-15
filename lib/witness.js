/**
 * The service's half of the publication protocol — it records what it was told, and it
 * has no way to say anything else.
 *
 * The central service exists because a local record cannot anchor itself: a rewritten
 * history is *perfectly* intact, so `verifyRef` in lib/evidence.js can tell you that what
 * you are holding is a chain and not that it is the chain that was there in March. A head
 * written down somewhere the rewrite cannot reach is the missing half, and lib/publishable.js
 * is what may be written down. This file is what the far end is allowed to do with it.
 *
 * **A witness is not an author, and that is a property of this file rather than a promise
 * about the service.** Nothing here can construct a record. The three functions in
 * lib/publishable.js that mint one — `record`, `next`, `genesis` — are deliberately not
 * imported, and `test/publication.mjs` reads this source and fails the repo if any of them
 * ever is. What is imported is the vocabulary and the arithmetic: `problemsWith` to refuse
 * a record that is not one, `recordDigest` to check that a record links onto what is
 * already held, `linkProblems` and `head` to say what the held chain is. So the service
 * can refuse, store and attest, and there is no code path by which it can originate — a
 * forged claim would have to be written into this file first, as a diff somebody signed
 * off on, rather than assembled at runtime from what it happens to hold.
 *
 * **That guarantee is structural, not cryptographic, and the difference matters.** An
 * operator with write access to the service's own storage can still put a row in it; what
 * they cannot do is make the local Mac agree, because the local chain is authoritative and
 * the remote one only corroborates. `compare` is where that arrangement pays: a record the
 * service holds and the daemon never made shows up as `behind` or `forked` the next time
 * anybody looks, from either end. Signing a record to its instance is bc-3muu.2's half and
 * strengthens this; it does not replace it, because a signature proves who wrote a record
 * and only a comparison proves that the two sides hold the same history.
 *
 * **Divergence is symmetric on purpose.** The interesting failure is not "the service is
 * missing something" — that is an ordinary offline daemon, and refusing to treat it as a
 * finding is bc-3muu.4's rule. The interesting failure is the service holding *more* than
 * the daemon can account for, or holding something *different* at a sequence number the
 * daemon has already used. Both are reported here as divergence, in the same shape, from
 * whichever side is asking.
 *
 * Pure, and a leaf but for lib/publishable.js: no config directory, no git, no clock but
 * the one a caller passes. The service is meant to be hostable somewhere that is not this
 * Mac, and a module that reaches for `~/.config/beadcause` on import cannot be.
 */
import { TYPES, head as chainHead, linkProblems, problemsWith, recordDigest } from './publishable.js';

/**
 * A witness that has been told nothing.
 *
 * `records` and `receipts` run in step — index *i* of one is the record, index *i* of the
 * other is what the service attested about it. Two arrays rather than one array of pairs
 * because everything that walks the chain walks records alone, and a shape that makes the
 * common read reach through a wrapper is a shape that gets copied wrong.
 */
export const EMPTY_LEDGER = Object.freeze({
  instance: null,
  records: Object.freeze([]),
  receipts: Object.freeze([]),
});

/**
 * What the service attests, and it is deliberately the smallest thing that is useful.
 *
 * Not "this claim is true" — the service has no way to know that and saying so would be
 * the authorship this whole file is written against. What it attests is *I was told this,
 * and this is when*: the instance, the sequence number, the digest of the record, and the
 * moment it arrived. `received` is the service's own clock rather than the record's `at`,
 * because the two differing is itself a fact worth holding — a record stamped an hour
 * before it was witnessed is an hour nobody was watching.
 */
function issue(rec, at) {
  return Object.freeze({ instance: rec.instance, seq: rec.seq, record: recordDigest(rec), received: at });
}

/** A ledger read defensively: anything that is not one reads as having been told nothing. */
function asLedger(ledger) {
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const receipts = Array.isArray(ledger?.receipts) ? ledger.receipts : [];
  return { instance: ledger?.instance ?? null, records, receipts };
}

/** The record the ledger holds at a sequence number, or null if that is not in its range. */
function at(records, seq) {
  if (!records.length) return null;
  const i = seq - records[0].seq;
  return i >= 0 && i < records.length ? records[i] : null;
}

/**
 * Everything wrong with admitting this record, as sentences — empty when it may be stored.
 *
 * Returned rather than thrown, and exported, because the service has to *answer* a refused
 * publication rather than crash on it: a daemon that is told "seq 41 is not the one after
 * 39" can fix its request, and a daemon that gets a 500 retries the same thing forever.
 * The same split lib/publishable.js makes between `problemsWith` and `record`.
 *
 * A replay — the exact record already held at that sequence number — is not a problem and
 * is not listed here. It is the ordinary shape of a daemon that sent something, lost the
 * answer and reconnected, and treating it as an error is how a retry becomes an outage.
 */
export function witnessProblems(ledger, rec) {
  const { instance, records } = asLedger(ledger);
  const problems = problemsWith(rec);
  if (problems.length) return problems.map((p) => `the service holds records, and this is not one: ${p}`);

  if (!records.length) {
    if (instance !== null && rec.instance !== instance)
      return [`this ledger belongs to ${instance}, and the record was published by ${rec.instance}`];
    if (rec.seq !== 0)
      return [
        `the first record a ledger is told is the first record of the chain, and this is seq ${rec.seq} — ` +
          'everything before it is still queued on the instance and has to arrive in order',
      ];
    return [];
  }

  if (rec.instance !== records[0].instance)
    return [`this ledger belongs to ${records[0].instance}, and the record was published by ${rec.instance}`];

  const last = records[records.length - 1];
  if (rec.seq <= last.seq) {
    const held = at(records, rec.seq);
    if (held && recordDigest(held) === recordDigest(rec)) return [];
    return [
      `the service already holds a different record at seq ${rec.seq} — ` +
        'a sequence number is used once, and re-using one is a rewrite rather than a publication',
    ];
  }
  if (rec.seq !== last.seq + 1)
    return [`seq jumps from ${last.seq} to ${rec.seq} — ${rec.seq - last.seq - 1} record(s) have not been published yet`];

  const expected = recordDigest(last);
  if (rec.prev !== expected)
    return [`the record names ${rec.prev} as its predecessor, and the service holds ${expected} at seq ${last.seq}`];

  return [];
}

/**
 * Admit a record, or refuse to — the only thing the service can be made to do.
 *
 * Returns a *new* ledger rather than mutating one, so a refusal cannot half-apply and a
 * caller holding the old ledger is holding exactly what the service held before the
 * request. `replay` is true when the record was already held: the ledger is unchanged and
 * the receipt is the original one, with its original `received` time, because re-issuing
 * it with today's clock would let a daemon manufacture a fresh attestation for an old
 * record by sending it again — the closest thing to authorship reachable from outside.
 */
export function witness(ledger, rec, { at: received = new Date().toISOString() } = {}) {
  const problems = witnessProblems(ledger, rec);
  if (problems.length) throw new Error(`this cannot be witnessed:\n  - ${problems.join('\n  - ')}`);
  if (!TYPES.at.ok(received)) throw new Error(`a receipt is stamped with ${TYPES.at.why}, and "${received}" is not one`);

  const { records, receipts } = asLedger(ledger);
  const held = at(records, rec.seq);
  if (held) return { ledger, receipt: receipts[rec.seq - records[0].seq] ?? issue(rec, received), replay: true };

  const receipt = issue(rec, received);
  return {
    ledger: Object.freeze({
      instance: rec.instance,
      records: Object.freeze([...records, Object.freeze({ ...rec })]),
      receipts: Object.freeze([...receipts, receipt]),
    }),
    receipt,
    replay: false,
  };
}

/** What the service says its head is — the one answer a daemon needs to compare against. */
export function ledgerHead(ledger) {
  return chainHead(asLedger(ledger).records);
}

/** Everything wrong with the ledger's own chain. The service's history is checkable too. */
export function ledgerProblems(ledger) {
  const { records } = asLedger(ledger);
  return records.length ? linkProblems(records) : [];
}

/**
 * Everything wrong with a receipt for this record, as sentences.
 *
 * The daemon's side of the bargain, and it is not ceremony: a receipt that names another
 * record is the service acknowledging something the daemon did not send, and a publisher
 * that files it as proof has published a gap it will later claim to have covered. Checked
 * against the record in hand rather than against the digest the receipt carries, because
 * the receipt is the untrusted half.
 */
export function receiptProblems(receipt, rec) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['not a receipt'];
  const problems = [];
  if (receipt.instance !== rec?.instance) problems.push(`the receipt names instance ${receipt.instance}, and the record is ${rec?.instance}`);
  if (receipt.seq !== rec?.seq) problems.push(`the receipt names seq ${receipt.seq}, and the record is seq ${rec?.seq}`);
  const digest = rec ? recordDigest(rec) : null;
  if (receipt.record !== digest) problems.push(`the receipt is for ${receipt.record}, and the record digests to ${digest}`);
  if (!TYPES.at.ok(receipt.received)) problems.push(`\`received\` must be ${TYPES.at.why}, so the attestation says when`);
  return problems;
}

/** A published head, read defensively — anything that is not one is not one. */
function asHead(remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return null;
  const ok =
    TYPES.token.ok(remote.instance) &&
    TYPES.count.ok(remote.seq) &&
    TYPES.at.ok(remote.at) &&
    TYPES.digest.ok(remote.digest);
  return ok ? Object.freeze({ instance: remote.instance, seq: remote.seq, at: remote.at, digest: remote.digest }) : null;
}

/** The verdicts `compare` can reach. Divergent ones are a finding; the rest are ordinary. */
export const VERDICTS = Object.freeze({
  nothing: false,
  unwitnessed: false,
  agreed: false,
  ahead: false,
  broken: true,
  unreadable: true,
  orphan: true,
  truncated: true,
  foreign: true,
  behind: true,
  forked: true,
});

const answer = (verdict, why, local, remote, unpublished = []) =>
  Object.freeze({
    verdict,
    divergent: VERDICTS[verdict] === true,
    why,
    local,
    remote,
    unpublished: Object.freeze(unpublished),
  });

/**
 * A local chain against a published head — the comparison the whole epic turns on.
 *
 * Both directions, and they are not the same event. A local chain that runs *past* the
 * published head is an instance with something still to send: ordinary, expected, and the
 * everyday state of a laptop that was shut. A published head that runs past the local
 * chain, or that disagrees with it at a sequence number both sides have, is one of two
 * things — a local history that was rewritten, or a service that authored something — and
 * neither side can tell which from its own copy. That is the arrangement working rather
 * than failing: the discrepancy is detected precisely because neither record is trusted to
 * check itself, and which one moved is a question for whoever holds both.
 *
 * `unpublished` is the tail to send, and it is only ever populated on a verdict that is not
 * divergent. Publishing onto a service that already disagrees would bury the disagreement
 * under records that link onto it, which is the one thing a divergence must not do.
 */
export function compare(records, remote) {
  const local = Array.isArray(records) ? records : [];
  const remoteHead = asHead(remote);
  const localHead = chainHead(local);

  if (local.length) {
    const broken = linkProblems(local);
    if (broken.length) return answer('broken', `the local chain does not hold together: ${broken[0]}`, localHead, remoteHead);
  }

  if (remote != null && !remoteHead)
    return answer('unreadable', 'the service answered with something that is not a published head', localHead, null);

  if (!local.length && !remoteHead) return answer('nothing', 'nothing has been published and nothing has been recorded', null, null);

  if (!local.length)
    return answer(
      'orphan',
      `the service holds a chain for ${remoteHead.instance} up to seq ${remoteHead.seq}, and there is no local chain at all`,
      null,
      remoteHead
    );

  if (!remoteHead)
    return answer('unwitnessed', `nothing has been published yet, and ${local.length} record(s) are waiting`, localHead, null, local);

  if (remoteHead.instance !== localHead.instance)
    return answer(
      'foreign',
      `the service answered for ${remoteHead.instance}, and this instance is ${localHead.instance}`,
      localHead,
      remoteHead
    );

  if (remoteHead.seq > localHead.seq)
    return answer(
      'behind',
      `the service holds up to seq ${remoteHead.seq} and this instance has only reached ${localHead.seq} — ` +
        'either the local chain lost records or the service holds records nothing here published',
      localHead,
      remoteHead
    );

  const mine = at(local, remoteHead.seq);
  if (!mine)
    return answer(
      'truncated',
      `the service holds seq ${remoteHead.seq} and the local chain now starts at seq ${local[0].seq}`,
      localHead,
      remoteHead
    );

  if (recordDigest(mine) !== remoteHead.digest)
    return answer(
      'forked',
      `both sides hold a record at seq ${remoteHead.seq} and they are not the same record`,
      localHead,
      remoteHead
    );

  if (remoteHead.seq === localHead.seq)
    return answer('agreed', `both sides agree at seq ${remoteHead.seq}`, localHead, remoteHead);

  const tail = local.slice(remoteHead.seq - local[0].seq + 1);
  return answer(
    'ahead',
    `the service is witness to seq ${remoteHead.seq}, and ${tail.length} record(s) have not been published`,
    localHead,
    remoteHead,
    tail
  );
}
