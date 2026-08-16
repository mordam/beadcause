#!/usr/bin/env node
//
// A transparency log's proofs, checked against real trees. `lib/translog.js`.
//
//   npm test
//   node test/translog.mjs
//
// bc-3muu.10: the other half of the anchor. An RFC 3161 token is one signature from one
// authority; an inclusion proof is a position in a public append-only structure whose
// operator cannot quietly remove an entry. They fail differently, which is why both are
// kept — and this suite is about the arithmetic that makes the second one worth anything.
//
// The shape of the whole suite is a cross-check rather than a fixture. `test/helpers/
// translog.mjs` implements the *recursive* definitions from RFC 6962 §2.1 — the ones
// written for a reader — and `lib/translog.js` verifies with the iterative decomposition
// production logs use. Every tree size from 1 to 40, every leaf in each, and every earlier
// size for consistency: two independent implementations agreeing across ~1600 cases is
// evidence, where a helper that mirrored the verifier's own arithmetic would agree with it
// about the bugs too.
//
// Three things beyond the sweep, and the second is the one people leave out:
//
//   1. A proof of the wrong shape is refused before any hashing, because a verifier that
//      hashes whatever it is handed until it runs out can be fed a shorter path to a root
//      it was not asked about.
//   2. Consistency is what makes the log's promise enforceable. An inclusion proof against
//      today's root is perfectly satisfied by a log that threw yesterday away; only a
//      consistency proof to a head somebody wrote down earlier catches that.
//   3. An odd node is promoted, never duplicated. Pairing it with a copy of itself makes
//      two different lists of entries produce the same root — CVE-2012-2459 — and it is
//      the one implementation mistake that makes a whole log meaningless.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { leafHash, nodeHash, parseCheckpoint, rootOf, verifyCheckpoint, verifyConsistency, verifyInclusion } from '../lib/translog.js';
import { checkpoint, log, logKey } from './helpers/translog.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

const entries = (n) => Array.from({ length: n }, (_, i) => `entry ${i}`);
const said = (problems, text) => assert.ok(problems.some((p) => p.includes(text)), `expected a refusal mentioning "${text}", got: ${problems.join(' | ') || '(none)'}`);

console.log('transparency log proofs\n');

/* ------------------------------------------------------------- the hashing */

check('a leaf and a node are hashed with the prefixes that keep them apart', () => {
  assert.equal(leafHash(Buffer.alloc(0)).toString('hex'), crypto.createHash('sha256').update(Buffer.from([0x00])).digest('hex'));
  const l = leafHash('a');
  const r = leafHash('b');
  assert.equal(nodeHash(l, r).toString('hex'), crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), l, r])).digest('hex'));
  // Without the prefixes a leaf's bytes could be crafted to look like an interior node,
  // and a tree where a leaf can pretend to be a subtree proves nothing about either.
  assert.notEqual(leafHash(Buffer.concat([l, r])).toString('hex'), nodeHash(l, r).toString('hex'));
});

check('an odd node is promoted rather than paired with a copy of itself', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(leafHash);
  assert.equal(rootOf(['a', 'b', 'c']).toString('hex'), nodeHash(nodeHash(a, b), c).toString('hex'));
  assert.notEqual(rootOf(['a', 'b', 'c']).toString('hex'), nodeHash(nodeHash(a, b), nodeHash(c, c)).toString('hex'), 'CVE-2012-2459');
});

/* ------------------------------------------------------------- the sweep */

check('every proof for every leaf of every tree up to 40 entries verifies', () => {
  let checked = 0;
  for (let n = 1; n <= 40; n++) {
    const list = entries(n);
    const l = log(list);
    assert.equal(rootOf(list).toString('hex'), l.root.toString('hex'), `the two definitions of MTH disagree at ${n}`);
    for (let i = 0; i < n; i++) {
      const problems = verifyInclusion({ index: i, size: n, leaf: leafHash(list[i]), proof: l.inclusion(i), root: l.root });
      assert.deepEqual(problems, [], `leaf ${i} of ${n}`);
      checked++;
    }
    for (let m = 1; m <= n; m++) {
      const problems = verifyConsistency({ size: m, root: l.at(m), next: n, nextRoot: l.root, proof: l.consistency(m) });
      assert.deepEqual(problems, [], `${m} → ${n}`);
      checked++;
    }
  }
  assert.ok(checked > 1500, `only ${checked} cases`);
});

/* ---------------------------------------------------------------- refusals */

const eleven = log(entries(11));

check('a proof of the wrong length is refused before a single hash is computed', () => {
  const leaf = leafHash('entry 4');
  said(verifyInclusion({ index: 4, size: 11, leaf, proof: eleven.inclusion(4).slice(1), root: eleven.root }), 'and a path to leaf 4 of a tree of 11 has 4');
  said(verifyInclusion({ index: 4, size: 11, leaf, proof: [...eleven.inclusion(4), eleven.root.toString('base64')], root: eleven.root }), 'hash(es) and a path');
});

check('a tampered sibling rebuilds a different root, and the sentence says which', () => {
  const proof = eleven.inclusion(4);
  proof[0] = Buffer.alloc(32).toString('base64');
  said(verifyInclusion({ index: 4, size: 11, leaf: leafHash('entry 4'), proof, root: eleven.root }), 'either this entry is not in that tree');
});

check('a proof for the wrong leaf is refused even when it is the right shape', () => {
  said(verifyInclusion({ index: 4, size: 11, leaf: leafHash('entry 5'), proof: eleven.inclusion(4), root: eleven.root }), 'rebuilds the root as');
});

check('a leaf outside the tree is refused rather than hashed anyway', () => {
  said(verifyInclusion({ index: 11, size: 11, leaf: leafHash('x'), proof: [], root: eleven.root }), 'cannot be in a tree of 11');
});

check('a hash that is not 32 bytes is not a hash', () => {
  said(verifyInclusion({ index: 0, size: 2, leaf: 'AAAA', proof: [], root: eleven.root }), 'not 32 bytes');
});

/* ------------------------------------------------------------ consistency */

check('a rewritten log fails consistency against a head recorded earlier', () => {
  // The whole argument for the second receipt. The rewritten log can produce a perfectly
  // valid inclusion proof for any entry it still holds — what it cannot produce is a proof
  // that the tree somebody wrote down in March is a prefix of the tree it has now.
  const before = log(entries(11));
  const list = entries(11);
  list[5] = 'FORGED';
  const after = log(list);
  const forgedEntry = verifyInclusion({ index: 5, size: 11, leaf: leafHash('FORGED'), proof: after.inclusion(5), root: after.root });
  assert.deepEqual(forgedEntry, [], 'the forged entry is perfectly included in the forged tree, which is the problem');
  said(verifyConsistency({ size: 8, root: before.at(8), next: 11, nextRoot: after.root, proof: after.consistency(8) }), 'is not a prefix of the log now');
});

check('a log that shrank is not append-only, and says so', () => {
  said(verifyConsistency({ size: 11, root: eleven.root, next: 4, nextRoot: eleven.at(4), proof: [] }), 'a log that shrank is not append-only');
});

check('the same size with a different head means entries were rewritten in place', () => {
  said(verifyConsistency({ size: 11, root: eleven.root, next: 11, nextRoot: eleven.at(10), proof: [] }), 'entries were rewritten in place');
  assert.deepEqual(verifyConsistency({ size: 11, root: eleven.root, next: 11, nextRoot: eleven.root, proof: [] }), []);
});

check('consistency between two different sizes is never free', () => {
  said(verifyConsistency({ size: 4, root: eleven.at(4), next: 11, nextRoot: eleven.root, proof: [] }), 'never free');
  said(verifyConsistency({ size: 4, root: eleven.at(4), next: 11, nextRoot: eleven.root, proof: eleven.consistency(4).slice(1) }), 'and one from 4 to 11 entries has');
});

check('an empty tree is consistent with everything and needs no proof', () => {
  assert.deepEqual(verifyConsistency({ size: 0, root: Buffer.alloc(32), next: 11, nextRoot: eleven.root, proof: [] }), []);
});

/* ------------------------------------------------------------ checkpoints */

const key = logKey();
const note = checkpoint({ size: eleven.size, root: eleven.root, key });

check('a signed checkpoint verifies against the key an install holds for it', () => {
  const v = verifyCheckpoint(note, { keys: { 'beadcause.test': key.publicKey }, origin: 'beadcause.test/log' });
  assert.deepEqual(v.problems, []);
  assert.equal(v.size, 11);
  assert.deepEqual(v.signedBy, ['beadcause.test']);
  assert.equal(v.root.toString('hex'), eleven.root.toString('hex'));
});

check('the signature covers the body as it arrived, extra lines and all', () => {
  const extra = checkpoint({ size: eleven.size, root: eleven.root, key, extra: ['a line this parser knows nothing about'] });
  const parsed = parseCheckpoint(extra);
  assert.deepEqual(parsed.extra, ['a line this parser knows nothing about']);
  assert.deepEqual(verifyCheckpoint(extra, { keys: { 'beadcause.test': key.publicKey } }).problems, [], 'a line it does not understand is still a line it signed');
  assert.ok(parsed.body.endsWith('\n\n'), 'the blank line is part of what was signed');
});

check('a checkpoint changed by one digit no longer verifies', () => {
  said(verifyCheckpoint(note.replace('\n11\n', '\n12\n'), { keys: { 'beadcause.test': key.publicKey } }).problems, 'does not verify against the key held for it');
});

check('a checkpoint signed by somebody this install does not know is not evidence', () => {
  said(verifyCheckpoint(note, { keys: {} }).problems, 'no key is held for any of them');
  said(verifyCheckpoint(note, { keys: { 'beadcause.test': logKey().publicKey } }).problems, 'does not verify');
});

check('a checkpoint from another log is refused when the anchor names one', () => {
  said(verifyCheckpoint(note, { keys: { 'beadcause.test': key.publicKey }, origin: 'somebody.else/log' }).problems, 'and this anchor is against');
});

check('an unsigned checkpoint is a claim nobody made', () => {
  assert.throws(() => parseCheckpoint(`beadcause.test/log\n11\n${eleven.root.toString('base64')}\n\n`), /unsigned checkpoint/);
  assert.throws(() => parseCheckpoint('beadcause.test/log\n11\nAAAA\n'), /blank line/);
  assert.throws(() => parseCheckpoint(`beadcause.test/log\nnot-a-number\n${eleven.root.toString('base64')}\n\n— x AAAAAAAA\n`), /not a tree size/);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
