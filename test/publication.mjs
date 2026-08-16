#!/usr/bin/env node
//
// Publishing the chain — `lib/publication.js` and `lib/witness.js`.
//
//   npm test                         (runs it alongside the other suites)
//   node test/publication.mjs        (on its own)
//
// bc-3muu.3. Three claims, and the middle one is the reason the other two are worth
// having:
//
//  1. **The local chain is append-only and says so twice.** Git's answer — linear, intact,
//     one root — and the payload's answer, every record naming the digest of the one
//     before it. They are asserted separately because they fail separately, and the suite
//     deliberately shows a chain that passes the first and fails against a head somebody
//     else was holding.
//  2. **Divergence is detected in both directions and they are not the same event.** A
//     local chain running past the published head is an ordinary offline laptop. A
//     published head running past the local chain, or disagreeing at a sequence number
//     both sides hold, is a finding — and the verdicts are checked one at a time, because
//     a comparison that only ever reports "different" tells nobody which way to look.
//  3. **The service cannot author a claim no daemon made.** Asserted structurally rather
//     than promised: `lib/witness.js` is read, and the repo fails if it ever imports one
//     of the three functions in `lib/publishable.js` that mint a record. A far end that
//     cannot construct one can only store, refuse and attest.
//
// Everything runs against a throwaway `BEADCAUSE_CONFIG_DIR` and an in-process ledger.
// Nothing here touches the real ~/.config/beadcause, and nothing goes near a network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-publication-'));
process.env.BEADCAUSE_CONFIG_DIR = tmp;

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const { PUBLICATION_REF, append, chain, localHead, publish, recordChainHead, verifyChain } = await import(
  '../lib/publication.js'
);
const { EMPTY_LEDGER, compare, ledgerHead, ledgerProblems, receiptProblems, witness, witnessProblems } = await import(
  '../lib/witness.js'
);
const { recordDigest } = await import('../lib/publishable.js');
const { blankComments, claimed, verifyRef } = await import('../lib/evidence.js');

const git = (...args) => execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' }).trim();
const refCommits = () => {
  try {
    return Number(
      execFileSync('git', ['-C', tmp, 'rev-list', '--count', PUBLICATION_REF], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    );
  } catch {
    return 0;
  }
};

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

const INSTANCE = 'inst-0a1b2c3d4e5f';
const SHA = (n) => String(n).padStart(40, 'a');
const CHAIN_HEAD = (n) => ({ ref: 'refs/beadcause/sessions/bc-3muu.3', head: SHA(n), length: n + 1, linear: true, intact: true });
const AT = (n) => `2026-08-15T${String(10 + n).padStart(2, '0')}:00:00Z`;

/** The service, in process: a ledger, a head to ask and a deliver to send to. */
function service(ledger = EMPTY_LEDGER, { clock = (n) => `2026-08-15T${String(10 + n).padStart(2, '0')}:30:00Z` } = {}) {
  let held = ledger;
  let tick = 0;
  return {
    get ledger() {
      return held;
    },
    head: async () => ledgerHead(held),
    deliver: async (rec) => {
      const out = witness(held, rec, { at: clock(tick++) });
      held = out.ledger;
      return out.receipt;
    },
  };
}

console.log('publication — an append-only local chain, a witness that cannot author, and divergence both ways\n');

/* -------------------------------------------- 1. the local chain, and append-only */

await check('a fresh install has no chain, and reading one is not an error', async () => {
  assert.deepEqual(await chain(), [], 'nothing published');
  assert.equal(await localHead(), null, 'and so no head to compare against');
  const v = await verifyChain();
  assert.equal(v.present, false, 'the ref does not exist');
  assert.equal(v.sound, false, 'an absent chain is not a sound one — whether that matters is bc-3muu.4');
});

await check('appending derives the link rather than accepting one', async () => {
  const first = await append('enrolment', { fingerprint: recordDigest({ hello: 'world' }), org: 'climative' }, { instance: INSTANCE, at: AT(0) });
  assert.equal(first.record.seq, 0);
  assert.equal(first.record.prev, null, 'the first record has no predecessor');

  const second = await append('chain-head', CHAIN_HEAD(1), { at: AT(1) });
  assert.equal(second.record.seq, 1, 'seq is computed from the tip, not passed in');
  assert.equal(second.record.prev, first.digest, 'and prev is the digest of the record before it');
  assert.equal(second.record.instance, INSTANCE, 'the chain says whose it is');
});

await check('the first record names its instance, and the rest may not re-state it', async () => {
  await assert.rejects(() => append('chain-head', CHAIN_HEAD(2), { instance: 'inst-somebodyelse', at: AT(2) }), /belongs to inst-0a1b2c3d4e5f/);
  const rec = await append('transition', { ref: 'refs/beadcause/election', commit: SHA(3), bead: 'bc-3muu.3' }, { at: AT(2) });
  assert.equal(rec.record.seq, 2);
});

await check('nothing that is not in the published vocabulary can be appended', async () => {
  await assert.rejects(() => append('criterion', { control: 'SOC2.CC7.2', state: 'met', evidence: recordDigest('x'), summary: 'it went fine' }, { at: AT(3) }), /content/);
  await assert.rejects(() => append('gossip', {}, { at: AT(3) }), /is not a kind of record/);
});

await check('the chain reads back exactly as it was written, oldest first', async () => {
  const records = await chain();
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.seq), [0, 1, 2]);
  assert.deepEqual(records.map((r) => r.kind), ['enrolment', 'chain-head', 'transition']);
  const head = await localHead();
  assert.equal(head.seq, 2);
  assert.equal(head.digest, recordDigest(records[2]), 'the head is the digest of the tip record');
});

await check('git and the payload both say the chain holds, and they are separate answers', async () => {
  const v = await verifyChain();
  assert.equal(v.linear, true, 'no commit has two parents');
  assert.equal(v.intact, true, 'every parent is in the walk, back to one root');
  assert.deepEqual([...v.links], [], 'and every record names the digest of the one before it');
  assert.equal(v.records, 3);
  assert.equal(v.length, refCommits(), 'one commit per record, and no commit without one');
  assert.equal(v.sound, true);
});

await check('the commit subjects are readable with `git log` alone, and carry the digest', async () => {
  const log = git('log', '--format=%s', PUBLICATION_REF).split('\n');
  assert.deepEqual(log, ['publish transition #2', 'publish chain-head #1', 'publish enrolment #0']);
  const body = git('log', '-1', '--format=%B', PUBLICATION_REF).split('\n').filter(Boolean);
  assert.deepEqual(body.length, 3, 'a subject and two lines, and the payload is in the tree');
  assert.match(body[1], /^instance inst-0a1b2c3d4e5f$/);
  assert.match(body[2], /^digest sha256:[0-9a-f]{64}$/, 'a reader can check the record against the message');
});

/* --------------------------------------------------- 2. publishing, and offline */

await check('publishing sends the whole queue in order and comes back witnessed', async () => {
  const svc = service();
  const out = await publish(svc);
  assert.equal(out.verdict, 'published');
  assert.equal(out.sent, 3);
  assert.equal(out.pending, 0);
  assert.equal(out.divergent, false);
  assert.deepEqual(out.receipts.map((r) => r.seq), [0, 1, 2]);
  assert.deepEqual([...ledgerProblems(svc.ledger)], [], "and the service's own copy links up");
  assert.equal(ledgerHead(svc.ledger).digest, (await localHead()).digest, 'both sides agree at the head');
});

await check('publishing again sends nothing, because it asks rather than remembers', async () => {
  const svc = service();
  await publish(svc);
  const again = await publish(svc);
  assert.equal(again.verdict, 'agreed');
  assert.equal(again.sent, 0);
  assert.equal(svc.ledger.records.length, 3, 'no duplicate rows on the far end');
});

await check('a record appended after a publication is the only thing the next one sends', async () => {
  const svc = service();
  await publish(svc);
  await append('criterion', { control: 'SOC2.CC7.2', state: 'unverified', evidence: recordDigest('nothing yet') }, { at: AT(4) });
  const out = await publish(svc);
  assert.equal(out.verdict, 'published');
  assert.equal(out.sent, 1, 'the tail, and not the chain');
  assert.equal(ledgerHead(svc.ledger).seq, 3);
});

await check('an unreachable service is not a failure and does not throw', async () => {
  const out = await publish({ head: async () => { throw new Error('ENETDOWN'); }, deliver: async () => assert.fail('nothing should be sent') });
  assert.equal(out.verdict, 'offline');
  assert.equal(out.divergent, false, 'offline is ordinary — an unpublished period is bc-3muu.4, not a finding here');
  assert.equal(out.pending, 4, 'and the queue is still there');
});

await check('a service that goes away mid-run reports what landed and what is still queued', async () => {
  const svc = service();
  let sent = 0;
  const out = await publish({
    head: svc.head,
    deliver: async (rec) => {
      if (sent++ === 2) throw new Error('connection reset');
      return svc.deliver(rec);
    },
  });
  assert.equal(out.verdict, 'offline');
  assert.equal(out.divergent, false);
  assert.equal(out.sent, 2);
  assert.equal(out.pending, 2, 'nothing is claimed for the two that did not go');
});

await check('a receipt for another record stops the run and is a finding, not a retry', async () => {
  const svc = service();
  const out = await publish({
    head: svc.head,
    deliver: async (rec) => ({ ...(await svc.deliver(rec)), seq: rec.seq + 99 }),
  });
  assert.equal(out.verdict, 'unreceipted');
  assert.equal(out.divergent, true);
  assert.match(out.why, /acknowledged seq 0 with something else/);
});

await check('and a receipt is checked against the record in hand, field by field', async () => {
  const [rec] = await chain();
  const good = { instance: rec.instance, seq: rec.seq, record: recordDigest(rec), received: AT(5) };
  assert.deepEqual(receiptProblems(good, rec), []);
  assert.match(receiptProblems({ ...good, record: recordDigest('else') }, rec)[0], /digests to/);
  assert.match(receiptProblems({ ...good, received: 'yesterday' }, rec)[0], /received/);
  assert.match(receiptProblems({ ...good, instance: 'inst-other' }, rec)[0], /names instance/);
  assert.deepEqual(receiptProblems(null, rec), ['not a receipt']);
});

/* ------------------------------------------- 3. the service cannot author a claim */

await check('lib/witness.js imports no way to mint a record, and that is what the claim reduces to', () => {
  const src = blankComments(fs.readFileSync(path.join(ROOT, 'lib/witness.js'), 'utf8'));
  const imports = [...src.matchAll(/import\s+([^;]*?)\s+from\s+'([^']+)'/g)];
  assert.deepEqual(imports.map((m) => m[2]), ['./publishable.js'], 'a leaf: the vocabulary and nothing else');
  const names = imports[0][1]
    .replace(/[{}]/g, '')
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  for (const minter of ['record', 'next', 'genesis']) {
    assert.ok(!names.includes(minter), `lib/witness.js imports \`${minter}\` — the witness can now author, which is the whole thing it may not do`);
  }
  assert.ok(!/(?<![A-Za-z0-9_$.])genesis\s*\(/.test(src), 'and does not call one by another name');
});

await check('lib/publication.js does import them, because the instance is the author', () => {
  const src = blankComments(fs.readFileSync(path.join(ROOT, 'lib/publication.js'), 'utf8'));
  assert.match(src, /import \{[^}]*genesis[^}]*\} from '\.\/publishable\.js'/, 'the daemon mints, and only the daemon');
});

await check('the witness refuses a record that does not link onto what it holds', async () => {
  const records = await chain();
  let held = EMPTY_LEDGER;
  for (const rec of records.slice(0, 2)) held = witness(held, rec, { at: AT(6) }).ledger;

  const forged = { ...records[3], prev: recordDigest('something else') };
  assert.match(witnessProblems(held, forged)[0], /have not been published yet/, 'a jump in seq is refused before the link is looked at');

  const wrongLink = { ...records[2], prev: recordDigest('a record nobody made') };
  assert.match(witnessProblems(held, wrongLink)[0], /names .* as its predecessor/);
  assert.throws(() => witness(held, wrongLink), /cannot be witnessed/);
});

await check('a sequence number is used once — re-using one is a rewrite and is refused', async () => {
  const records = await chain();
  let held = EMPTY_LEDGER;
  for (const rec of records) held = witness(held, rec, { at: AT(6) }).ledger;
  const rewritten = { ...records[1], at: AT(7) };
  assert.match(witnessProblems(held, rewritten)[0], /already holds a different record at seq 1/);
});

await check('a replay is idempotent and re-issues the original receipt, not a fresh one', async () => {
  const records = await chain();
  const first = witness(EMPTY_LEDGER, records[0], { at: AT(6) });
  const again = witness(first.ledger, records[0], { at: AT(9) });
  assert.equal(again.replay, true);
  assert.equal(again.receipt.received, AT(6), 'sending an old record again does not manufacture a fresh attestation for it');
  assert.equal(again.ledger, first.ledger, 'and nothing is stored twice');
});

await check('the first thing a ledger is told is the first record of the chain', async () => {
  const records = await chain();
  assert.match(witnessProblems(EMPTY_LEDGER, records[2])[0], /still queued on the instance/);
  assert.deepEqual(witnessProblems(EMPTY_LEDGER, records[0]), []);
});

await check('and a record that is not a publishable record is refused as one', () => {
  assert.match(witnessProblems(EMPTY_LEDGER, { kind: 'criterion', notes: 'trust me' })[0], /this is not one/);
  assert.match(witnessProblems(EMPTY_LEDGER, null)[0], /not a record/);
});

/* -------------------------------------------------- 4. divergence, in both directions */

await check('a local chain past the published head is ordinary, and names the tail', async () => {
  const records = await chain();
  const cmp = compare(records, { instance: INSTANCE, seq: 1, at: AT(1), digest: recordDigest(records[1]) });
  assert.equal(cmp.verdict, 'ahead');
  assert.equal(cmp.divergent, false);
  assert.deepEqual(cmp.unpublished.map((r) => r.seq), [2, 3]);
});

await check('a published head past the local chain is a finding, and says which way to look', async () => {
  const records = await chain();
  const cmp = compare(records, { instance: INSTANCE, seq: 9, at: AT(9), digest: recordDigest('whatever') });
  assert.equal(cmp.verdict, 'behind');
  assert.equal(cmp.divergent, true);
  assert.match(cmp.why, /either the local chain lost records or the service holds records nothing here published/);
  assert.deepEqual([...cmp.unpublished], [], 'and nothing is published onto a service that already disagrees');
});

await check('two different records at the same seq is a fork, whichever side moved', async () => {
  const records = await chain();
  const cmp = compare(records, { instance: INSTANCE, seq: 2, at: AT(2), digest: recordDigest('a record this instance never made') });
  assert.equal(cmp.verdict, 'forked');
  assert.equal(cmp.divergent, true);
});

await check('every other way the two can disagree has its own verdict', async () => {
  const records = await chain();
  const head = { instance: INSTANCE, seq: 0, at: AT(0), digest: recordDigest(records[0]) };

  assert.equal(compare([], null).verdict, 'nothing');
  assert.equal(compare(records, null).verdict, 'unwitnessed');
  assert.equal(compare(records, null).divergent, false);
  assert.equal(compare([], head).verdict, 'orphan');
  assert.equal(compare(records, { ...head, instance: 'inst-anotherinstall' }).verdict, 'foreign');
  assert.equal(compare(records, { seq: 'two' }).verdict, 'unreadable');
  assert.equal(compare(records.slice(2), head).verdict, 'truncated');

  const tampered = [records[0], { ...records[1], at: AT(8) }, records[2]];
  assert.equal(compare(tampered, head).verdict, 'broken', 'a local chain that does not hold together is answered before anything is compared');

  // Each of these is a finding rather than a state to publish through, and each is
  // asserted against the comparison that reaches it — a table of verdicts that all say
  // `divergent: true` proves nothing about which comparison sets which.
  const findings = [
    ['orphan', compare([], head)],
    ['foreign', compare(records, { ...head, instance: 'inst-anotherinstall' })],
    ['unreadable', compare(records, { seq: 'two' })],
    ['truncated', compare(records.slice(2), head)],
    ['broken', compare(tampered, head)],
  ];
  for (const [verdict, cmp] of findings) {
    assert.equal(cmp.verdict, verdict);
    assert.equal(cmp.divergent, true, `${verdict} is a finding`);
    assert.ok(cmp.why.length > 20, `${verdict} says what it saw`);
    assert.deepEqual([...cmp.unpublished], [], `${verdict} publishes nothing on top of the disagreement`);
  }
});

await check('an intact chain can still be the wrong chain, which is why the head is published', async () => {
  // The demonstration the whole epic rests on. Rewind the ref to seq 1, append a
  // *different* record at seq 2, and ask git what it thinks. Git is satisfied: one root,
  // no merges, every parent present. It is a chain — it is not the chain the service was
  // told about, and nothing local can tell the difference.
  const svc = service();
  await publish(svc);
  const published = ledgerHead(svc.ledger);

  const rewindTo = git('rev-list', PUBLICATION_REF).split('\n')[2];
  git('update-ref', PUBLICATION_REF, rewindTo);
  await append('criterion', { control: 'SOC2.CC7.2', state: 'met', evidence: recordDigest('a different story') }, { at: AT(2) });

  const v = await verifyChain();
  assert.equal(v.linear, true, 'a rewritten history is perfectly linear');
  assert.equal(v.intact, true, 'and perfectly intact');
  assert.deepEqual([...v.links], [], 'and its digests link up, because they were recomputed');
  assert.equal(v.sound, true, 'so every local check passes, and every local check is the wrong question');

  const out = await publish({ head: svc.head, deliver: async () => assert.fail('nothing is published onto a divergence') });
  assert.equal(out.divergent, true, 'and the head somebody else was holding is what catches it');
  assert.ok(['forked', 'behind'].includes(out.verdict), `verdict was ${out.verdict}`);
  assert.equal(out.remote.digest, published.digest, 'the service still holds what it was told');
});

/* ------------------------------------------- 5. the bridge from an evidence ref */

await check('an evidence ref is published as what the verifier saw, and no more', async () => {
  const tip = git('rev-list', '-1', PUBLICATION_REF);
  git('update-ref', 'refs/beadcause/anotherchain', tip);

  const { record } = await recordChainHead(tmp, 'refs/beadcause/anotherchain', { at: AT(10) });
  const seen = await verifyRef(tmp, 'refs/beadcause/anotherchain');
  assert.equal(record.kind, 'chain-head');
  assert.equal(record.ref, 'refs/beadcause/anotherchain');
  assert.equal(record.head, seen.head);
  assert.equal(record.length, seen.length);
  assert.equal(record.linear, true);
  assert.equal(record.intact, true);
  assert.equal(record.why, undefined, 'the verifier reports prose and prose does not cross');
  assert.equal(record.anchored, undefined, 'and a projection is not a pass-through');
});

await check('a ref with no commits is refused rather than published as a head of nothing', async () => {
  await assert.rejects(() => recordChainHead(tmp, 'refs/beadcause/neverexisted'), /no commits/);
});

/* ------------------------------------------------------------ 6. the register */

await check('the register claims lib/publication.js, so its retention is stated somewhere', () => {
  assert.equal(claimed().get('lib/publication.js'), 'REGISTER[publication-chain]');
  assert.equal(claimed().get('lib/witness.js'), undefined, 'and the witness persists nothing here, so it claims nothing');
});

await cleanupTmp(tmp);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
