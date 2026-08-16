#!/usr/bin/env node
//
// A chain head anchored where nobody involved can rewrite it. `lib/anchor.js`.
//
//   npm test
//   node test/anchor.mjs
//
// bc-3muu.10. The central service gives a second holder of the record, which is
// corroboration; it is not independence, because the same operator writes and administers
// both copies. What cannot be argued with is a third party who has no stake: the anchor is
// the thin slice that is genuinely outside, and this suite is the four claims it makes.
//
//   1. Nothing but a hash ever leaves. What is submitted is the digest of the `chain-head`
//      record from lib/publishable.js and nothing beside it, so the boundary argued there
//      survives out to a party there is no agreement with at all.
//   2. The receipt is kept with the head it covers, as a shape rather than a promise. An
//      anchor carrying one of the two receipts is refused — not accepted as a weaker
//      anchor, because a half-anchored head that renders as anchored is worse than a gap.
//   3. Either receipt alone is sufficient, and that is asserted by taking the other one
//      away: verified with no trusted certificate at all, the log proof still stands; with
//      no log key at all, the token still stands. An auditor holding one of the two and
//      nothing else can still catch the rewrite.
//   4. A rewrite of history preceding an anchor is detectable — end to end, against a real
//      repository, with a real ref that really gets rewritten. That is the criterion, and
//      the last check here is the only place in the repo where the receipts and
//      `verifyRef`'s `anchored` are put together.
//
// And the coverage half, which is the criterion people forget: a missed anchor has to
// render as an unanchored interval rather than as silence, because silence is
// indistinguishable from a period nobody asked about.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  DEFAULT_INTERVAL_HOURS,
  anchorProblems,
  coverage,
  describeCoverage,
  rewriteProblems,
  subjectOf,
  submission,
  verifyAnchor,
  withAnchor,
} from '../lib/anchor.js';
import { verifyRef } from '../lib/evidence.js';
import { chainHeadFields, genesis, recordDigest } from '../lib/publishable.js';
import { parseRequest } from '../lib/timestamp.js';
import { authority, token } from './helpers/tsa.mjs';
import { checkpoint, log, logKey } from './helpers/translog.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-anchor-'));
const repo = path.join(tmp, 'repo');
const said = (problems, text) => assert.ok(problems.some((p) => p.includes(text)), `expected a refusal mentioning "${text}", got: ${problems.join(' | ') || '(none)'}`);

const tsa = authority({ notBefore: new Date('2020-01-01T00:00:00Z'), notAfter: new Date('2036-01-01T00:00:00Z') });
const key = logKey();
const KEYS = { 'beadcause.test': key.publicKey };
const HEAD = 'a'.repeat(40);
const RECORD = genesis('instance-token', 'chain-head', chainHeadFields({ ref: 'refs/notes/beadcause', head: HEAD, length: 42, linear: true, intact: true }), { at: '2026-08-01T00:00:00Z' });

/** An anchor over a record, with both receipts and every knob a check needs to spoil one. */
function anchorFor(record, { head = HEAD, at = new Date(), tokenDigest = null, entry = null, index = 1, ref = 'refs/notes/beadcause' } = {}) {
  const sub = submission(record);
  const entries = ['somebody else', entry || sub.entry, 'somebody later'];
  const l = log(entries);
  return {
    ref,
    head,
    record: sub.digest,
    at: new Date(at).toISOString().replace(/\.\d+Z$/, 'Z'),
    timestamp: {
      token: token({ tsa, digest: tokenDigest || sub.digest.slice(7), nonce: sub.nonce, genTime: new Date(at) }).toString('base64'),
      nonce: sub.nonce.toString('hex'),
    },
    inclusion: { origin: 'beadcause.test/log', checkpoint: checkpoint({ size: l.size, root: l.root, key }), index, size: l.size, hashes: l.inclusion(index) },
  };
}

console.log('anchoring a chain head\n');

/* -------------------------------------------------- nothing but a hash leaves */

await check('what is submitted is the digest of the published record, and nothing beside it', () => {
  const sub = submission(RECORD);
  assert.equal(sub.digest, recordDigest(RECORD));
  assert.equal(sub.entry.toString('utf8'), sub.digest, 'the log entry is the digest as text — no structure for a field to hide in');
  const req = parseRequest(sub.timestampRequest);
  assert.equal(req.digest, sub.digest.slice(7));
  assert.equal(req.elements, 4, 'version, imprint, nonce, certReq — and no fifth thing');
});

await check('a third party learns a number, and could not say what it is about', () => {
  const sub = submission(RECORD);
  const wire = Buffer.concat([sub.timestampRequest, sub.entry]).toString('latin1');
  for (const leak of ['refs/', 'instance-token', 'chain-head', 'bc-', RECORD.head]) {
    assert.ok(!wire.includes(leak), `"${leak}" left the machine`);
  }
});

await check('two records that differ anywhere are anchored as different numbers', () => {
  const other = genesis('instance-token', 'chain-head', chainHeadFields({ ref: 'refs/notes/beadcause', head: 'b'.repeat(40), length: 42, linear: true, intact: true }), { at: '2026-08-01T00:00:00Z' });
  assert.notEqual(subjectOf(RECORD).record, subjectOf(other).record);
});

/* ------------------------------------------- the receipt is kept with the head */

await check('an anchor carries both receipts, and one is refused rather than accepted as weaker', () => {
  const whole = anchorFor(RECORD);
  assert.deepEqual(anchorProblems(whole), []);
  said(anchorProblems({ ...whole, timestamp: undefined }), 'an anchor carries both or it is not an anchor');
  said(anchorProblems({ ...whole, inclusion: undefined }), 'an anchor carries both or it is not an anchor');
  said(anchorProblems({ ...whole, timestamp: {} }), 'nothing to verify offline');
  said(anchorProblems({ ...whole, inclusion: { ...whole.inclusion, checkpoint: 'no blank line here' } }), 'a number nobody stands behind');
});

await check('an anchor that names no head, no ref or no time is not one', () => {
  const whole = anchorFor(RECORD);
  said(anchorProblems({ ...whole, head: 'nonsense' }), 'head must be the whole object name');
  said(anchorProblems({ ...whole, ref: 'not a ref' }), 'ref must name the chain');
  said(anchorProblems({ ...whole, at: 'yesterday' }), 'at must be a UTC instant');
  said(anchorProblems({ ...whole, record: 'sha256:short' }), 'record must be the digest');
  assert.deepEqual(anchorProblems(null), ['not an anchor']);
});

/* ------------------------------------------------------- both, and either alone */

await check('an anchor with both receipts verifies, and says so twice', () => {
  const v = verifyAnchor(anchorFor(RECORD), { ca: tsa.ca, keys: KEYS, origin: 'beadcause.test/log' });
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.independent, 2, 'two receipts that stood up on their own');
  assert.equal(v.timestamp.authority, 'CN=Beadcause Test TSA');
  assert.deepEqual(v.inclusion.signedBy, ['beadcause.test']);
});

await check('the log proof stands alone, with no certificate authority in the world', () => {
  const v = verifyAnchor(anchorFor(RECORD), { keys: KEYS });
  assert.equal(v.inclusion.ok, true, 'a public log needs nobody’s CA');
  assert.equal(v.timestamp.ok, false);
  assert.equal(v.independent, 1);
  assert.equal(v.ok, false, 'and `ok` stays strict, because degrading to one silently is how a pair becomes a single point of failure');
});

await check('the token stands alone, with no log key and no network', () => {
  const v = verifyAnchor(anchorFor(RECORD), { ca: tsa.ca });
  assert.equal(v.timestamp.ok, true, 'offline, forever, from the token and a certificate');
  assert.equal(v.inclusion.ok, false);
  assert.equal(v.independent, 1);
});

await check('two valid receipts for two different numbers are two receipts and no anchor', () => {
  const elsewhere = crypto.createHash('sha256').update('another head entirely').digest('hex');
  const v = verifyAnchor(anchorFor(RECORD, { tokenDigest: elsewhere }), { ca: tsa.ca, keys: KEYS });
  said(v.problems, 'timestamp: the token is a receipt for');
  assert.equal(v.inclusion.ok, true, 'the log proof is perfectly good, and about the right digest — which is why the token is checked against it too');
});

await check('a log entry for another head is caught even when the checkpoint is genuine', () => {
  const v = verifyAnchor(anchorFor(RECORD, { entry: Buffer.from('sha256:' + 'f'.repeat(64), 'utf8') }), { ca: tsa.ca, keys: KEYS });
  said(v.problems, 'log: the proof rebuilds the root as');
  assert.equal(v.timestamp.ok, true);
});

await check('a proof against a tree the checkpoint did not sign is refused', () => {
  const a = anchorFor(RECORD);
  const v = verifyAnchor({ ...a, inclusion: { ...a.inclusion, size: a.inclusion.size + 1 } }, { ca: tsa.ca, keys: KEYS });
  said(v.problems, 'and the checkpoint signs one of');
});

await check('an anchor whose shape is wrong is not verified at all, rather than half-verified', () => {
  const v = verifyAnchor({ ...anchorFor(RECORD), head: 'nonsense' }, { ca: tsa.ca, keys: KEYS });
  assert.equal(v.ok, false);
  assert.equal(v.timestamp, null);
  assert.equal(v.independent, 0);
});

/* ------------------------------------------------------------------ coverage */

await check('a missed anchor renders as an unanchored interval rather than as silence', () => {
  const cov = coverage(
    [
      { at: '2026-08-01T00:00:00Z', head: HEAD },
      { at: '2026-08-02T00:00:00Z', head: HEAD },
      { at: '2026-08-06T00:00:00Z', head: HEAD },
    ],
    { from: '2026-08-01T00:00:00Z', to: '2026-08-07T00:00:00Z' }
  );
  assert.equal(cov.intervalHours, DEFAULT_INTERVAL_HOURS, 'the interval is stated rather than implied');
  assert.equal(cov.covered, false);
  const gaps = cov.spans.filter((s) => !s.anchored);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, '2026-08-03T12:00:00.000Z');
  assert.equal(gaps[0].to, '2026-08-06T00:00:00.000Z');
  assert.equal(cov.unanchoredHours, 60);
  assert.ok(describeCoverage(cov).some((l) => l.includes('UNANCHORED')), 'and it is in the prose too');
});

await check('an unbroken run is covered, and the spans meet end to end', () => {
  const at = (d) => `2026-08-0${d}T00:00:00Z`;
  const cov = coverage([1, 2, 3, 4].map((d) => ({ at: at(d), head: HEAD })), { from: at(1), to: at(4) });
  assert.equal(cov.covered, true);
  assert.equal(cov.unanchoredHours, 0);
  assert.equal(cov.spans.length, 3);
  assert.ok(describeCoverage(cov).some((l) => l.includes('Every interval in the window is witnessed')));
});

await check('a window with no anchors in it is the whole window unanchored', () => {
  const cov = coverage([], { from: '2026-08-01T00:00:00Z', to: '2026-08-03T00:00:00Z' });
  assert.equal(cov.anchors, 0);
  assert.equal(cov.unanchoredHours, 48);
  said(cov.spans.map((s) => s.why), 'nothing was anchored in this window');
});

await check('a run that stopped is unanchored from the tolerance on, not from the last anchor', () => {
  const cov = coverage([{ at: '2026-08-01T00:00:00Z', head: HEAD }], { from: '2026-08-01T00:00:00Z', to: '2026-08-05T00:00:00Z' });
  assert.equal(cov.spans[0].anchored, true);
  assert.equal(cov.spans[0].hours, 36, '24h plus the stated tolerance');
  assert.equal(cov.spans[1].anchored, false);
  said(cov.spans.map((s) => s.why || ''), 'nothing has been anchored since');
});

/* --------------------------------------------- the rewrite, end to end */

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
function writeRef(ref, messages) {
  let parent = null;
  const shas = [];
  for (const message of messages) {
    const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: message, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['-C', repo, 'mktree'], { input: `100644 blob ${blob}\trecord\n`, encoding: 'utf8' }).trim();
    const args = ['commit-tree', tree, '-m', message];
    if (parent) args.push('-p', parent);
    parent = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
    }).trim();
    shas.push(parent);
  }
  git('update-ref', ref, parent);
  return shas;
}

fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['-C', repo, 'init', '-q', '--initial-branch=main']);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'beadcause@localhost']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'beadcause']);

await check('a rewrite of history before an anchor is detectable, from the receipts alone', async () => {
  // The criterion, end to end and in one place. Everything else in this file is a part of
  // it; this is the part that is worth reading if you only read one.
  const REF = 'refs/beadcause/anchored-example';
  writeRef(REF, ['one', 'two', 'three']);

  // In March: verify the chain, publish the head, anchor the record, keep the receipts.
  const march = await verifyRef(repo, REF);
  const record = genesis('instance-token', 'chain-head', chainHeadFields(march), { at: '2026-03-01T00:00:00Z' });
  const anchor = anchorFor(record, { head: march.head, ref: REF, at: '2026-03-01T00:01:00Z' });
  assert.equal(verifyAnchor(anchor, { ca: tsa.ca, keys: KEYS }).ok, true);

  // In August: nothing has changed, and the anchor says so.
  const before = await verifyRef(repo, REF, withAnchor(anchor));
  assert.equal(before.anchored, true);
  assert.deepEqual(rewriteProblems(anchor, before), []);

  // Somebody rewrites the middle of the chain. The result is *perfectly* intact — every
  // parent resolves, one root, no merges — which is exactly why intactness was never
  // enough and why this bead exists.
  writeRef(REF, ['one', 'two, but different', 'three']);
  const after = await verifyRef(repo, REF, withAnchor(anchor));
  assert.equal(after.intact, true, 'a forged history is intact, which is the whole problem');
  assert.equal(after.linear, true);
  assert.equal(after.anchored, false);
  said(rewriteProblems(anchor, after), 'history before that point has been rewritten');

  // And the receipts still stand on their own, which is what makes the accusation stick:
  // the head named in them was witnessed by two parties with no stake in the answer.
  const still = verifyAnchor(anchor, { ca: tsa.ca, keys: KEYS });
  assert.equal(still.independent, 2);
  assert.equal(still.timestamp.digest, recordDigest(record));
});

await check('a verification that was never asked the question says so rather than passing', () => {
  const anchor = anchorFor(RECORD);
  said(rewriteProblems(anchor, { ref: anchor.ref, anchored: null, linear: true }), 'the one question the anchor answers was not asked');
  said(rewriteProblems(anchor, { ref: 'refs/notes/somewhere-else', anchored: true, linear: true }), 'the verification is of');
  said(rewriteProblems(anchor, { ref: anchor.ref, anchored: true, linear: false }), 'two histories were joined');
});

await cleanupTmp(tmp);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
