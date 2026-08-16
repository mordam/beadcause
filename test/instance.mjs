#!/usr/bin/env node
//
// Which install a published record came from — `lib/instance.js`.
//
//   npm test
//   node test/instance.mjs
//
// bc-3muu.2: a daemon proves which install it is, once. Three things are asserted here
// and each of them is a way the epic goes quietly wrong rather than loudly:
//
//   1. THE OBSERVER. A second instance is booted by copying a real config directory, so
//      it holds the private key by construction and possession proves nothing. The copy
//      is made for real — files on disk, a second path — and asked to publish. It must be
//      refused for a reason that names the copy, and refused again with the flag off,
//      because the README is emphatic that the way `BEADCAUSE_OBSERVE` fails is you
//      believing you set it. A guard that is only the flag is only the failure mode.
//   2. ONCE. Enrolling an already-enrolled directory hands back what is there. The way one
//      install quietly becomes two is a boot path that mints whenever it cannot find, and
//      that failure looks like a fresh healthy instance in every list there is.
//   3. WHAT CROSSES. The enrolment record is checked field by field against what
//      lib/publishable.js mints, and the placement digest is checked to be absent from it.
//      A path is content, and the field you regret is already on somebody's disk.
//
// The private key's filename is checked against the *real* denylist in lib/commonrepo.js
// rather than against a copy of it here. The config directory is a git repository and
// everything in it that is not refused by path is committed, so `instance.key` earning
// that refusal is the only thing keeping an install's identity out of its own history —
// and a rename to `instance-private.json` would be a one-line diff that reads like tidying
// up. A second, weaker copy of the denylist in this file would agree with the rename.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ID_HEX,
  ID_PREFIX,
  IDENTITY_FILE,
  KEY_FILE,
  adopt,
  enrol,
  enrolmentProblems,
  enrolmentRecord,
  fingerprintOf,
  idFromFingerprint,
  idOf,
  identityPath,
  identityProblems,
  keyPath,
  load,
  machineIdentity,
  newIdentity,
  placeOf,
  placementOf,
  publishProblems,
  reenrol,
  save,
  sign,
  verifySignature,
} from '../lib/instance.js';
import { ENVELOPE, FIELDS, problemsWith, recordDigest } from '../lib/publishable.js';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-instance-'));
const dirIn = (name) => path.join(tmp, name);
const at = '2026-08-15T17:48:35Z';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real directory with a real identity in it — the only fixture this suite needs. */
function enrolled(name, org = 'climative') {
  const dir = dirIn(name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, ...enrol(dir, { org, at }) };
}

/** Copy a directory's files to a new path, the way a second instance is actually booted. */
function copyTo(from, name) {
  const to = dirIn(name);
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
  return to;
}

/* -------------------------------------------------------------- the identity */

await check('the id is the key — cut from its fingerprint, and the same key is the same install', () => {
  const one = newIdentity({ org: 'climative', place: placeFor('/a'), at });
  assert.match(one.id, new RegExp(`^${ID_PREFIX}[0-9a-f]{${ID_HEX}}$`));
  assert.equal(one.id, idOf(one.publicKey));
  assert.equal(one.id, idFromFingerprint(one.fingerprint));
  assert.equal(fingerprintOf(one.publicKey), one.fingerprint);
  // Two installs are two ids. Nothing about the machine is in the key, so a second
  // identity minted in the same second at the same place is still a different install.
  const two = newIdentity({ org: 'climative', place: placeFor('/a'), at });
  assert.notEqual(one.id, two.id);
});

await check('the fingerprint is over the key rather than over the text it was written in', () => {
  const { publicKey } = newIdentity({ place: placeFor('/a') });
  // The same key, re-wrapped: PEM is text with line breaks in it, and a fingerprint that
  // moved when a file was re-written would one day call one key two.
  const rewrapped = `${publicKey.trim()}\n\n`;
  assert.equal(fingerprintOf(rewrapped), fingerprintOf(publicKey));
});

await check('a doctored identity file is refused before any of it reaches a record', () => {
  const good = newIdentity({ org: 'climative', place: placeFor('/a'), at });
  assert.deepEqual(identityProblems(good), []);

  const other = newIdentity({ place: placeFor('/b') });
  const stolen = { ...good, id: other.id };
  assert.ok(identityProblems(stolen).some((p) => p.includes('is not the id this public key mints')), identityProblems(stolen).join('; '));

  const swapped = { ...good, fingerprint: other.fingerprint };
  assert.ok(identityProblems(swapped).some((p) => p.includes('digests to')), identityProblems(swapped).join('; '));

  for (const [field, why] of [
    ['id', 'id must be'],
    ['fingerprint', 'fingerprint must be'],
    ['publicKey', 'publicKey must be'],
    ['placement', 'placement must be'],
  ]) {
    const broken = { ...good, [field]: 'nonsense' };
    assert.ok(identityProblems(broken).some((p) => p.startsWith(why)), `${field}: ${identityProblems(broken).join('; ')}`);
  }
  assert.deepEqual(identityProblems(null), ['not an identity']);
  assert.deepEqual(identityProblems([good]), ['not an identity']);
});

/* --------------------------------------------------------------- what crosses */

await check('an enrolment record carries a fingerprint and a tenant, and nothing about where it is', () => {
  const identity = newIdentity({ org: 'climative', place: placeFor('/a'), at });
  const rec = enrolmentRecord(identity, { at });

  assert.deepEqual(problemsWith(rec), []);
  assert.deepEqual(
    Object.keys(rec).sort(),
    ['kind', ...Object.keys(ENVELOPE), ...Object.keys(FIELDS.enrolment)].sort(),
    'an enrolment is exactly the envelope plus the two fields the table mints'
  );
  assert.equal(rec.instance, identity.id);
  assert.equal(rec.fingerprint, identity.fingerprint);
  assert.equal(rec.seq, 0);
  assert.equal(rec.prev, null);

  // The placement digest is a local self-check over a path, and a path is content.
  const published = JSON.stringify(rec);
  assert.ok(!published.includes(identity.placement), 'the placement digest crossed');
  assert.ok(!published.includes(identity.privateKey.slice(40, 80)), 'the private key crossed');
  assert.ok(!published.includes('publicKey'), 'the key itself crossed — the fingerprint is what is published');
});

await check('the tenant is the one organisation rule, not a second weaker copy of it', () => {
  const identity = newIdentity({ place: placeFor('/a'), at });
  assert.throws(() => enrolmentRecord(identity, { at }), /an organisation id is required/);

  // `default` is a real refusal that lives in lib/organisation.js and nowhere here — the
  // word a single-tenant install writes when it has a column to fill, and a tenant with
  // history and no owner the day there is a second. A local copy of the rule would not
  // have it, which is the point of not having a local copy.
  assert.throws(() => enrolmentRecord({ ...identity, org: 'default' }, { at }), /reserved/);
  assert.throws(() => enrolmentRecord({ ...identity, org: 'Climative' }, { at }), /not the shape an organisation id has/);

  const live = { ...newIdentity({ org: 'climative', place: placeFor('/a'), at }) };
  assert.ok(publishProblems({ ...live, org: 'default' }, { place: placeFor('/a') }).some((p) => p.includes('cannot be filed under an organisation')));
});

/* ------------------------------------------------------ proving it is the one */

await check('an enrolment is checkable by the service with the record and the key and nothing else', () => {
  const identity = newIdentity({ org: 'climative', place: placeFor('/a'), at });
  const rec = enrolmentRecord(identity, { at });
  const signature = sign(identity, rec);

  assert.deepEqual(enrolmentProblems(rec, identity.publicKey, signature), []);

  // Somebody else's key over a record that names this fingerprint.
  const other = newIdentity({ org: 'climative', place: placeFor('/b'), at });
  const wrongKey = enrolmentProblems(rec, other.publicKey, signature);
  assert.ok(wrongKey.some((p) => p.includes('key presented digests to')), wrongKey.join('; '));

  // This key, but the record claims an id it does not mint.
  const claimed = { ...rec, instance: other.id };
  const wrongId = enrolmentProblems(claimed, identity.publicKey, sign(identity, claimed));
  assert.ok(wrongId.some((p) => p.includes('is not the id this key mints')), wrongId.join('; '));

  // A signature over a different record, replayed onto this one.
  const elsewhere = enrolmentRecord(identity, { at: '2026-08-15T17:48:36Z' });
  const replayed = enrolmentProblems(rec, identity.publicKey, sign(identity, elsewhere));
  assert.ok(replayed.some((p) => p.includes('the signature is not this key over this record')), replayed.join('; '));

  for (const bad of [undefined, '', 'not base64 at all!!', signature.slice(0, -4)]) {
    assert.ok(enrolmentProblems(rec, identity.publicKey, bad).length, `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(enrolmentProblems(null, identity.publicKey, signature), ['not a record']);
  assert.ok(enrolmentProblems({ ...rec, kind: 'transition' }, identity.publicKey, signature)[0].includes('transition'));
});

await check('the service admits an enrolment through the same funnel it was built with', () => {
  const identity = newIdentity({ org: 'climative', place: placeFor('/a'), at });
  const rec = enrolmentRecord(identity, { at });

  // A signed record carrying content is still content. Checking the signature first and
  // storing the object is authenticating the sender of a payload rather than refusing it,
  // so the boundary is asked on the way in as well as on the way out.
  const smuggled = { ...rec, notes: 'the whole bead, pasted in' };
  const problems = enrolmentProblems(smuggled, identity.publicKey, sign(identity, smuggled));
  assert.ok(problems.some((p) => p.includes('notes is content')), problems.join('; '));
});

await check('a signature follows the record rather than the bytes it was written in', () => {
  const identity = newIdentity({ org: 'climative', place: placeFor('/a'), at });
  const rec = enrolmentRecord(identity, { at });
  const signature = sign(identity, rec);

  // Key order is not part of the claim: the digest is canonical, so a re-ordered copy of
  // the same record verifies. A record with a field changed does not.
  const reordered = Object.fromEntries(Object.entries(rec).reverse());
  assert.equal(recordDigest(reordered), recordDigest(rec));
  assert.ok(verifySignature(reordered, signature, identity.publicKey));
  assert.ok(!verifySignature({ ...rec, org: 'someone-else' }, signature, identity.publicKey));

  const keyless = { ...identity, privateKey: '' };
  assert.throws(() => sign(keyless, rec), /holds no private key/);
});

/* ------------------------------------------------------------- the observer */

await check('a copy of a config directory cannot publish as the install it was copied from', () => {
  const live = enrolled('live');
  assert.equal(live.enrolled, true);
  assert.ok(live.record, 'enrolling produced the record that says this install exists');

  // Booted the way the README says to boot one: the whole directory, somewhere else.
  const copy = copyTo(live.dir, 'observer');
  const copied = load(copy);
  assert.equal(copied.id, live.identity.id, 'the copy holds the key, which is exactly the problem');
  assert.equal(copied.privateKey, live.identity.privateKey);

  const problems = publishProblems(copied, { place: placeOf(copy), observing: false });
  assert.ok(
    problems.some((p) => p.includes(`this is a copy of ${live.identity.id}'s configuration`)),
    `the copy was allowed to publish: ${problems.join('; ') || 'no problems at all'}`
  );

  // And the original, in its own directory, is fine — a guard that refuses everything is
  // not a guard.
  assert.deepEqual(publishProblems(load(live.dir), { place: placeOf(live.dir) }), []);
});

await check('the flag refuses too, in the place where the placement check would pass', () => {
  const live = enrolled('flagged');
  const problems = publishProblems(load(live.dir), { place: placeOf(live.dir), observing: true });
  assert.ok(problems.some((p) => p.startsWith('observing —')), problems.join('; '));
});

await check('a copy back over the original path is caught by when the directory came to exist', async () => {
  const live = enrolled('reborn');
  const before = placeOf(live.dir);
  const stash = copyTo(live.dir, 'reborn-stash');

  fs.rmSync(live.dir, { recursive: true, force: true });
  await sleep(20);
  fs.mkdirSync(live.dir, { recursive: true });
  for (const f of fs.readdirSync(stash)) fs.copyFileSync(path.join(stash, f), path.join(live.dir, f));

  const after = placeOf(live.dir);
  assert.equal(after.directory, before.directory, 'the same path, which is the whole point');
  if (!before.born || !after.born) {
    // A filesystem that reports no birth time degrades the guard to path and account, and
    // saying so is better than an assertion that passes for the wrong reason.
    console.log('      (this filesystem reports no birth time — the guard here is path and account only)');
    return;
  }
  assert.notEqual(placementOf(after), placementOf(before));
  const problems = publishProblems(load(live.dir), { place: after });
  assert.ok(problems.some((p) => p.includes('is a copy of')), problems.join('; '));
});

await check('an identity with nowhere to be checked against is refused rather than trusted', () => {
  const live = enrolled('unplaced');
  const problems = publishProblems(load(live.dir), {});
  assert.ok(problems.some((p) => p.includes('nothing said where this is running')), problems.join('; '));
});

await check('a directory whose key was left behind says so instead of pretending', () => {
  const live = enrolled('keyless');
  const copy = copyTo(live.dir, 'keyless-copy');
  fs.rmSync(keyPath(copy));
  const loaded = load(copy);
  assert.equal(loaded.privateKey, undefined);
  assert.ok(publishProblems(loaded, { place: placeOf(copy) }).some((p) => p.includes('has no private key here')));
});

/* -------------------------------------------------------------------- once */

await check('enrolling twice is enrolling once — the second call hands back what is there', () => {
  const live = enrolled('twice');
  const again = enrol(live.dir, { org: 'climative', at });
  assert.equal(again.enrolled, false);
  assert.equal(again.record, null, 'a second enrolment record would be a second install');
  assert.equal(again.identity.id, live.identity.id);
  assert.equal(again.identity.privateKey, live.identity.privateKey);
});

await check('the identity survives a restart, and nothing in it comes from the checkout', () => {
  const live = enrolled('restart');
  const reloaded = load(live.dir);
  assert.equal(reloaded.id, live.identity.id);
  assert.equal(reloaded.fingerprint, live.identity.fingerprint);
  assert.equal(reloaded.enrolledAt, at);
  assert.deepEqual(identityProblems(reloaded), []);

  // A reinstall replaces the checkout and leaves the config directory alone, so the thing
  // that must be true is that no part of the identity was derived from this repository.
  const stored = JSON.stringify(reloaded);
  assert.ok(!stored.includes(process.cwd()), 'the identity names the checkout it was minted in');
});

await check('enrolling in a copied directory refuses and names the two ways out', () => {
  const live = enrolled('branch');
  const copy = copyTo(live.dir, 'branch-copy');
  assert.throws(() => enrol(copy, { org: 'climative', at }), /this is a copy of it/);
  assert.throws(() => enrol(copy, { org: 'climative', at }), /Adopt it if the install moved, or re-enrol/);
});

await check('an observer enrols nothing, because an enrolment is a claim that an install exists', () => {
  const dir = dirIn('observer-fresh');
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => enrol(dir, { org: 'climative', at, observing: true }), /observing —/);
  assert.equal(fs.existsSync(identityPath(dir)), false, 'an observer left an identity behind');
});

await check('enrolment needs an organisation, and a directory holding rubbish is not silently replaced', () => {
  const dir = dirIn('rubbish');
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => enrol(dir, { at }), /names the organisation/);
  // Nothing on disk: an identity whose enrolment record was never built is an install that
  // exists locally and was never announced, and the retry would hand it straight back.
  assert.equal(fs.existsSync(identityPath(dir)), false, 'a refused enrolment left an identity behind');

  fs.writeFileSync(identityPath(dir), JSON.stringify({ id: 'i-nope' }));
  assert.throws(() => enrol(dir, { org: 'climative', at }), /holds something that is not an identity/);
  assert.equal(load(dirIn('nothing-here')), null);
});

/* ------------------------------------------------------ moving, and losing it */

await check('adopting a moved install keeps the id and the chain, and has to be asked for outright', () => {
  const live = enrolled('moved');
  const copy = copyTo(live.dir, 'moved-to');
  const loaded = load(copy);
  const there = placeOf(copy);

  assert.throws(() => adopt(loaded, there, {}), /has to be asked for outright/);
  assert.throws(() => adopt(loaded, there, { deliberate: true, observing: true }), /observing —/);

  const taken = adopt(loaded, there, { deliberate: true, at });
  assert.equal(taken.id, live.identity.id, 'adopting is keeping the identity, not minting one');
  assert.equal(taken.privateKey, live.identity.privateKey);
  assert.deepEqual(taken.moves, [{ at, from: live.identity.placement }]);
  assert.deepEqual(publishProblems(taken, { place: there }), []);

  // Adopting where it already is changes nothing, so a retry cannot pile up moves.
  assert.equal(adopt(taken, there, { deliberate: true, at }), taken);
});

await check('a lost config directory mints a new install rather than re-minting the old one', () => {
  const live = enrolled('lost');
  const fresh = reenrol(live.identity, { org: 'climative', place: placeOf(live.dir), at });

  assert.notEqual(fresh.id, live.identity.id, 'an install that can re-mint its own past id is one anybody can mint');
  assert.equal(fresh.copiedFrom, live.identity.id, 'what it replaced is worth knowing locally');
  assert.equal(fresh.org, 'climative');

  const rec = enrolmentRecord(fresh, { at });
  assert.equal(rec.seq, 0, 'a new install starts its own chain');
  assert.ok(!JSON.stringify(rec).includes(live.identity.id), 'a claim about a chain it cannot sign for');

  // With nothing to replace, re-enrolling is simply enrolling.
  assert.equal(reenrol(null, { org: 'climative', place: placeOf(live.dir), at }).copiedFrom, undefined);
});

/* -------------------------------------------------------------- on the disk */

await check('the private key is written where the config repo refuses to commit it', async () => {
  // Pointed at scratch before lib/config.js is evaluated: it reads the environment once,
  // at import, and this suite must not touch the real config directory to ask a question
  // about a filename.
  process.env.BEADCAUSE_CONFIG_DIR = dirIn('as-config');
  const { protectedPath } = await import('../lib/commonrepo.js');

  assert.equal(protectedPath(KEY_FILE), true, `${KEY_FILE} would be committed to the config repo`);
  assert.equal(protectedPath(IDENTITY_FILE), false, 'the public half is meant to have a history');

  const live = enrolled('ondisk');
  const written = JSON.parse(fs.readFileSync(identityPath(live.dir), 'utf8'));
  assert.equal(written.privateKey, undefined, 'the private key was written into the committed file');
  assert.equal(written.id, live.identity.id);
  assert.ok(fs.readFileSync(keyPath(live.dir), 'utf8').includes('PRIVATE'));
  assert.equal(fs.statSync(keyPath(live.dir)).mode & 0o777, 0o600);
});

await check('saving refuses an identity that does not hang together', () => {
  const dir = dirIn('refused');
  const good = newIdentity({ org: 'climative', place: placeFor('/a'), at });
  assert.throws(() => save(dir, { ...good, id: 'i-0000' }), /cannot be saved/);
  assert.equal(fs.existsSync(dir), false, 'a refused save still made the directory');
});

await check('placement is a digest of three facts and a machine is not a hostname', () => {
  const one = { born: 1, directory: '/a', machine: 'm' };
  assert.equal(placementOf(one), placementOf({ ...one }));
  for (const differs of [{ born: 2 }, { directory: '/b' }, { machine: 'n' }]) {
    assert.notEqual(placementOf({ ...one, ...differs }), placementOf(one), JSON.stringify(differs));
  }
  // An unreported birth time is 0 rather than the epoch, and both are the same answer
  // only because 0 *is* what "unknown" is written as.
  assert.equal(placementOf({ directory: '/a', machine: 'm' }), placementOf({ ...one, born: 0 }));
  assert.throws(() => placementOf({ machine: 'm' }), /needs the directory/);

  // The hostname is deliberately not in it: a laptop renamed by a network it joined must
  // not stop being able to publish.
  const renamed = { ...os, hostname: () => 'somewhere-else' };
  assert.equal(machineIdentity(renamed), machineIdentity(os));
  assert.notEqual(machineIdentity({ ...os, homedir: () => '/Users/nobody' }), machineIdentity(os));
});

/** A placement for a path that does not have to exist — the pure half, used above. */
function placeFor(directory) {
  return { born: 1, directory, machine: 'test-machine' };
}

await cleanupTmp(tmp, { quiesceFirst: false });

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
