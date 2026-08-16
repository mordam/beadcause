/**
 * Which install a published record came from — minted once, proved every time.
 *
 * lib/publishable.js settles *what* may leave the Mac and leaves one field opaque on
 * purpose: `instance` is a token there, and its docblock says outright that what an
 * instance token actually *is*, and how a daemon comes to hold one, is this file's
 * question. It is the load-bearing one. Every continuity claim the service holds is a
 * claim about an install, so a chain attributed to the wrong install is not a slightly
 * wrong record — it is a true-looking record of something that never happened.
 *
 * **An install is not an account, and that is the whole reason this is not the daemon
 * token.** One person runs several installs; a team runs dozens; worktrees and observer
 * instances share a Mac and share a tracker. The existing credentials all answer a
 * different question — the daemon token says *may this request act*, device pairing says
 * *is this phone allowed in*, Google sign-in says *which human is this*. None of them
 * says *which of the running daemons is speaking*, and none of them survives being
 * copied, because being copied is exactly what a bearer token is for.
 *
 * **So the identity is a keypair, and the id is the key.** `id` is the first half of the
 * digest of the public key, so the token and the key cannot drift apart and there is no
 * registry lookup to get wrong: an id is checkable against the key that minted it by
 * anybody holding both, with no state at all. Enrolment publishes the fingerprint, the
 * daemon keeps the private half, and every later publication is signed. That is what
 * "cannot be minted by whoever feels like it" means in practice — anybody may generate a
 * keypair and enrol as *themselves*, and nobody can speak as an install whose private key
 * they do not have.
 *
 * **The private key is in a file named `.key` for a reason that is not taste.** The
 * config directory is a git repository (lib/commonrepo.js) and everything in it that is
 * not on the denylist is committed on every change. That denylist refuses `*.key`, so the
 * suffix is what keeps an install's identity out of its own history — and out of a
 * snapshot somebody later hands to somebody else. The public half goes in
 * `instance.json`, which *is* committed, and that is the right way round: the enrolment
 * is a fact with a history worth keeping.
 *
 * **The hard case is the observer, and possession of the key cannot solve it.** A second
 * instance is booted by copying a real config directory — the README's own recipe — so
 * the copy holds the private key by construction. An observer that published continuity
 * for the daemon it was copied from would be the same failure the `BEADCAUSE_OBSERVE`
 * banner exists to prevent, with an auditor at the end of it, and the README is emphatic
 * that the way that flag fails is you believing you set it. A guard that is only the flag
 * is therefore a guard that is only the failure mode.
 *
 * **What the copy cannot bring with it is where it is.** `placementOf` digests the three
 * facts a copy changes and a restart does not: the absolute directory the identity was
 * loaded from, the account and platform it runs under, and the moment that directory came
 * into existence. The daemon recomputes it at every boot and compares. The documented
 * recipe — a copy at `/tmp/bc` — fails on the path; a copy back over the same path fails
 * on the birth time; a copy onto another person's Mac fails on the account. Placement is
 * the brace and the flag is the belt, and `publishProblems` asks for both.
 *
 * **Placement is never published.** It names a home directory, and a path is content in
 * every sense lib/publishable.js means it: nothing is gained by the service knowing where
 * on somebody's disk their config lives, and the field would be impossible to narrow
 * later. It is a local self-check, and the enrolment record carries only the key
 * fingerprint.
 *
 * **What placement cannot catch, and saying so is better than implying otherwise.** A
 * whole-machine clone reproduces all three facts, so two daemons would publish under one
 * id. That is not solved here and it is not solved by any local check, because both
 * copies are locally indistinguishable by construction. It is caught one layer up and
 * caught well: two writers on one chain fork the sequence, and `linkProblems` finds a
 * fork by arithmetic. A limit with a named catcher is a design; a limit with none is a
 * hole.
 *
 * **Stable across restarts, stable across reinstalls, and deliberately not stable across
 * a wiped machine.** A restart reloads the same two files. Reinstalling beadcause
 * replaces the checkout and never touches the config directory, so the identity is
 * untouched by construction — the one thing a reinstall must not do is mint a second
 * identity for one install, and it cannot, because nothing here derives an id from
 * anything in the repository. A *lost* config directory is the other way round: the
 * private key is gone, the old id is unspeakable, and `reenrol` mints a new one that
 * starts its own chain at seq 0. That is the correct answer rather than a shortcoming. An
 * install that could re-mint its own past identity from scratch is an install anybody
 * could mint, and the old instance falling silent is a finding somebody should see
 * (bc-3muu.5) rather than something to paper over.
 *
 * **A move is a question, and it is asked out loud.** A legitimately moved config
 * directory is locally indistinguishable from a copy of one, so `adopt` exists and
 * requires a caller to say `deliberate` — a human act, never a retry. It keeps the id, the
 * key and the chain, records what the placement was before, and refuses outright while
 * observing. Fail-closed on the ambiguous case with one named way through it beats a
 * heuristic that guesses right most of the time.
 *
 * Near-leaf: node:crypto, node:fs, node:os, node:path, lib/atomic.js for a write that
 * cannot be half-done, lib/publishable.js because the enrolment record goes through the one
 * funnel that decides what may be published, and lib/organisation.js because the tenant an
 * install enrols into is that file's rule and a second copy of it here is how two files
 * come to disagree. It names no config directory of its own — the directory is an argument,
 * so a check, an installer, a service and a daemon can each point it somewhere without one
 * of them dragging in the other's state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomic, writeJsonAtomic } from './atomic.js';
// The one organisation-id rule, borrowed rather than restated. lib/operator.js takes the
// same import for the reason lib/organisation.js's own header gives: a second, weaker copy
// of the rule is how two files quietly come to disagree about what a tenant is called.
import { orgProblems } from './organisation.js';
import { digest, genesis, now, problemsWith, recordDigest } from './publishable.js';

/** The public half — committed to the config repo, because enrolment is a fact with a history. */
export const IDENTITY_FILE = 'instance.json';

/**
 * The private half. The suffix is load-bearing: lib/commonrepo.js refuses `*.key` by
 * path, and that refusal is the only thing standing between this key and the config
 * repository's history. Renaming this to `instance-private.json` would commit it.
 */
export const KEY_FILE = 'instance.key';

/** What an id begins with, so a token is recognisable in a log without a lookup. */
export const ID_PREFIX = 'i-';

/**
 * How much of the fingerprint the id carries. 128 bits of a sha256 — short enough to read
 * in a log line, long enough that colliding with a particular install is not a strategy.
 */
export const ID_HEX = 32;

/** The shape of an id, so a caller can refuse one before doing anything with it. */
const ID_RE = new RegExp(`^${ID_PREFIX}[0-9a-f]{${ID_HEX}}$`);

/** A fingerprint as lib/publishable.js writes digests. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The key type, named in one place so the two generators cannot disagree. */
export const KEY_TYPE = 'ed25519';

/* --------------------------------------------------------------- the identity */

/**
 * The digest of a public key — what enrolment publishes, and what an id is cut from.
 *
 * Over the DER of the SPKI rather than the PEM, because PEM is text with line breaks and
 * a trailing newline in it, and a fingerprint that changes when a file is re-wrapped is a
 * fingerprint that will one day say two keys are different when they are the same.
 */
export function fingerprintOf(publicKey) {
  const der = keyObject(publicKey).export({ type: 'spki', format: 'der' });
  return digest(der);
}

/** The id a public key mints. Deterministic, so the same key is the same install forever. */
export function idOf(publicKey) {
  return idFromFingerprint(fingerprintOf(publicKey));
}

/** The same cut, for anybody holding the fingerprint and not the key. */
export function idFromFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !DIGEST_RE.test(fingerprint)) {
    throw new TypeError('a fingerprint is a sha256 digest, written `sha256:<64 hex>`');
  }
  return ID_PREFIX + fingerprint.slice('sha256:'.length, 'sha256:'.length + ID_HEX);
}

/** A key in whatever form a caller has it, as something node:crypto will sign with. */
function keyObject(key) {
  if (typeof key === 'object' && key !== null && typeof key.export === 'function') return key;
  if (typeof key !== 'string' || !key.includes('-----BEGIN')) throw new TypeError('not a PEM key');
  return key.includes('PRIVATE') ? crypto.createPrivateKey(key) : crypto.createPublicKey(key);
}

/**
 * The facts a copy of a config directory changes and a restart does not, as one digest.
 *
 * `directory` is the resolved absolute path, `machine` the account and platform, `born`
 * the millisecond the directory came into existence. None of the three is published —
 * `placementOf` is what makes it a digest rather than a record, so nothing downstream can
 * be tempted to send the path.
 */
export function placementOf({ directory, machine, born } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('placement needs the directory it is about');
  return digest({ born: Number.isFinite(born) ? Math.trunc(born) : 0, directory, machine: String(machine || '') });
}

/**
 * This account on this platform. Deliberately *not* the hostname: a laptop is renamed by
 * a network it joined, and an identity that stops being able to publish because of DHCP
 * is an identity nobody keeps. The home directory is what changes when the copy lands on
 * somebody else's Mac, and it does not change on a Tuesday.
 */
export function machineIdentity(from = os) {
  let user = '';
  try {
    user = from.userInfo().username;
  } catch {
    user = '';
  }
  return digest({ home: from.homedir(), platform: from.platform(), user });
}

/**
 * Where a directory is, as the three facts placement is cut from.
 *
 * `born` is 0 when the filesystem does not report a birth time rather than the epoch,
 * because "unknown" and "1970" digest differently and only one of them is honest. On a
 * filesystem that never reports one the guard degrades to path and account, which still
 * catches the documented observer recipe.
 */
export function placeOf(directory, from = os) {
  const resolved = realpath(directory);
  let born = 0;
  try {
    const st = fs.statSync(resolved);
    born = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : 0;
  } catch {
    born = 0;
  }
  return { born, directory: resolved, machine: machineIdentity(from) };
}

/** The path a copy would not share, resolved through symlinks so two names are one place. */
function realpath(directory) {
  try {
    return fs.realpathSync(path.resolve(directory));
  } catch {
    return path.resolve(directory);
  }
}

/**
 * Mint an identity. Nothing about the machine goes into the key — a key derived from the
 * hardware is a key that cannot be rotated and an id that cannot be retired.
 */
export function newIdentity({ org, place, at } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(KEY_TYPE);
  const fingerprint = fingerprintOf(publicKey);
  return {
    id: idFromFingerprint(fingerprint),
    fingerprint,
    org: org || '',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    placement: place ? placementOf(place) : '',
    enrolledAt: at || now(),
    moves: [],
  };
}

/**
 * Everything wrong with a stored identity, as sentences — empty when it may be used.
 *
 * The id-against-key check is the one worth having: a file whose `id` was edited to
 * somebody else's while keeping this key is refused here, before any of it reaches a
 * record, which is the difference between a boundary and a hope.
 */
export function identityProblems(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return ['not an identity'];
  const problems = [];

  if (typeof identity.id !== 'string' || !ID_RE.test(identity.id)) {
    problems.push(`id must be ${ID_PREFIX} followed by ${ID_HEX} hex characters`);
  }
  if (typeof identity.fingerprint !== 'string' || !DIGEST_RE.test(identity.fingerprint)) {
    problems.push('fingerprint must be a sha256 digest of the public key');
  }
  if (typeof identity.publicKey !== 'string' || !identity.publicKey.includes('-----BEGIN PUBLIC KEY-----')) {
    problems.push('publicKey must be a PEM public key');
  }
  if (typeof identity.placement !== 'string' || !DIGEST_RE.test(identity.placement)) {
    problems.push('placement must be a sha256 digest of where this identity lives');
  }
  if (problems.length) return problems;

  let minted;
  try {
    minted = fingerprintOf(identity.publicKey);
  } catch {
    return ['publicKey is not a key this can read'];
  }
  if (minted !== identity.fingerprint) {
    problems.push(`fingerprint says ${identity.fingerprint}, and this public key digests to ${minted}`);
  } else if (identity.id !== idFromFingerprint(minted)) {
    problems.push(`id ${identity.id} is not the id this public key mints, which is ${idFromFingerprint(minted)}`);
  }

  return problems;
}

/* ------------------------------------------------------------------ enrolment */

/**
 * The record an enrolment *is* — the first thing an instance ever publishes, at seq 0.
 *
 * Through `genesis` rather than assembled here, so the one funnel in lib/publishable.js
 * decides what may cross. Nothing about the placement, the path, the machine or the key
 * itself goes with it: a fingerprint and a tenant, which is all a witness needs to know
 * that this install exists and to recognise it again.
 */
export function enrolmentRecord(identity, { at } = {}) {
  const problems = [...identityProblems(identity), ...orgProblems(identity?.org)];
  if (problems.length) throw new Error(`this identity cannot enrol:\n  - ${problems.join('\n  - ')}`);
  return genesis(identity.id, 'enrolment', { fingerprint: identity.fingerprint, org: identity.org }, { at });
}

/**
 * What is wrong with an enrolment somebody presented — the service's side of the same
 * rule, checkable with the record and the key and no stored state whatever.
 *
 * The public key is presented rather than looked up on purpose: this is the moment the
 * service *learns* the key, so there is nothing to look it up in. What it can still do,
 * and does, is refuse a record that does not hang together — a fingerprint that is not
 * this key's, an id that is not that fingerprint's, a signature that is not over this
 * record. An enrolment that passes all three is one only the holder of the private key
 * could have produced.
 */
export function enrolmentProblems(rec, publicKey, signature) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return ['not a record'];
  if (rec.kind !== 'enrolment') return [`this is a ${rec.kind} record, and an enrolment is what is being checked`];

  // Through the one funnel first. A record carrying a field the table does not mint is
  // refused before anything here looks at it, so the boundary is asked on the way in as
  // well as on the way out — a route that checks the signature and stores the object has
  // authenticated the sender of the content rather than refused the content.
  const unpublishable = problemsWith(rec);
  if (unpublishable.length) return unpublishable;

  const problems = [];
  let minted;
  try {
    minted = fingerprintOf(publicKey);
  } catch {
    return ['the public key presented is not a key'];
  }
  if (rec.fingerprint !== minted) problems.push(`the record claims ${rec.fingerprint} and the key presented digests to ${minted}`);
  if (rec.instance !== idFromFingerprint(minted)) problems.push(`${rec.instance} is not the id this key mints, which is ${idFromFingerprint(minted)}`);
  if (rec.seq !== 0 || rec.prev !== null) problems.push('an enrolment is the first record of a chain, so seq is 0 and prev is null');
  if (!verifySignature(rec, signature, publicKey)) problems.push('the signature is not this key over this record');

  return problems;
}

/**
 * Sign a record with the instance's private key.
 *
 * Over the record's digest rather than over the bytes of some encoding of it, because the
 * digest is already canonical — key order cannot change it — and a signature over an
 * encoding is a signature that breaks when somebody reformats. Domain-separated so a
 * signature over a record can never be replayed as a signature over anything else.
 */
export function sign(identity, rec) {
  if (!identity || typeof identity.privateKey !== 'string' || !identity.privateKey.includes('PRIVATE')) {
    throw new Error('this identity holds no private key, so it can prove nothing');
  }
  return crypto.sign(null, signedBytes(rec), keyObject(identity.privateKey)).toString('base64');
}

/** Whether a signature is that key over that record. False for anything malformed, never a throw. */
export function verifySignature(rec, signature, publicKey) {
  if (typeof signature !== 'string' || !signature) return false;
  try {
    return crypto.verify(null, signedBytes(rec), keyObject(publicKey), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

const signedBytes = (rec) => Buffer.from(`beadcause-instance:${recordDigest(rec)}`, 'utf8');

/* ------------------------------------------------------------------- the guard */

/**
 * Whether this process may publish as this identity — the observer question, answered.
 *
 * Both halves are asked, because each catches what the other cannot. `observing` catches
 * the instance that told you what it was; placement catches the one that did not, which
 * is the failure the README says this flag actually has. Sentences rather than a boolean,
 * so the log says which of the two it was and a person can tell "I copied this" from "I
 * moved this".
 */
export function publishProblems(identity, { place, observing = false } = {}) {
  const problems = identityProblems(identity);
  if (problems.length) return problems;

  if (observing) problems.push('observing — this instance watches and never publishes as the install it was copied from');
  if (typeof identity.privateKey !== 'string' || !identity.privateKey.includes('PRIVATE')) {
    problems.push(`${identity.id} has no private key here, so nothing it published could be proved`);
  }
  for (const bad of orgProblems(identity.org)) problems.push(`${identity.id} cannot be filed under an organisation: ${bad}`);

  if (!place) {
    problems.push('nothing said where this is running, and an unplaced identity cannot be told from a copy');
  } else if (placementOf(place) !== identity.placement) {
    problems.push(
      `this is a copy of ${identity.id}'s configuration rather than ${identity.id} — it was enrolled somewhere ` +
        "else, and a copy that published would be claiming the original install's continuity. Adopt it " +
        'deliberately if the install really moved, or enrol this directory as an install of its own'
    );
  }

  return problems;
}

/**
 * Take an identity over after a genuine move — keeping the id, the key and the chain.
 *
 * `deliberate` is the whole mechanism. A moved directory and a copied one are locally
 * identical, so the only thing that can tell them apart is somebody saying which it was,
 * and this refuses to be that somebody. The previous placement is kept in `moves` because
 * the useful question a year later is not where it is but how many times it has been
 * somewhere else.
 */
export function adopt(identity, place, { deliberate = false, observing = false, at } = {}) {
  const problems = identityProblems(identity);
  if (problems.length) throw new Error(`this identity cannot be adopted:\n  - ${problems.join('\n  - ')}`);
  if (observing) throw new Error('observing — an observer never takes over the identity it was booted from');
  if (!deliberate) throw new Error(`adopting ${identity.id} says this install moved rather than was copied, so it has to be asked for outright`);
  const placement = placementOf(place);
  if (placement === identity.placement) return identity;
  return {
    ...identity,
    placement,
    moves: [...(Array.isArray(identity.moves) ? identity.moves : []), { at: at || now(), from: identity.placement }],
  };
}

/**
 * Mint a fresh identity in a directory that already holds one — the other answer to a
 * placement mismatch, and the right one when the copy really is a new install.
 *
 * The id it replaces is kept locally in `copiedFrom`. Nothing published names it: this
 * instance is new and its chain starts at 0, and asserting a relationship to a chain it
 * cannot sign for would be a claim rather than a note.
 */
export function reenrol(previous, { org, place, at } = {}) {
  const fresh = newIdentity({ org: org || previous?.org || '', place, at });
  return previous?.id ? { ...fresh, copiedFrom: previous.id } : fresh;
}

/* ---------------------------------------------------------------- persistence */

/** Where the two files sit, given the directory holding them. */
export const identityPath = (dir) => path.join(dir, IDENTITY_FILE);
export const keyPath = (dir) => path.join(dir, KEY_FILE);

/**
 * The identity in a directory, or null.
 *
 * Unreadable reads as absent, the way every other state file in this repository is read —
 * but a missing private key is *not* papered over. An identity with no key is a real state
 * (a copied directory whose key was left behind) and `publishProblems` has a sentence for
 * it; inventing one would turn a caught case into a crash somewhere later.
 */
export function load(dir) {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(identityPath(dir), 'utf8'));
  } catch {
    return null;
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  let privateKey = '';
  try {
    privateKey = fs.readFileSync(keyPath(dir), 'utf8');
  } catch {
    privateKey = '';
  }
  return privateKey ? { ...stored, privateKey } : { ...stored };
}

/**
 * Write an identity, private half separate, both atomically.
 *
 * The split is not tidiness. `instance.json` is committed to the config repo and
 * `instance.key` is refused by its denylist, so which of the two a field lives in decides
 * whether it ends up in a history somebody can hand over.
 */
export function save(dir, identity) {
  const problems = identityProblems(identity);
  if (problems.length) throw new Error(`this identity cannot be saved:\n  - ${problems.join('\n  - ')}`);
  fs.mkdirSync(dir, { recursive: true });
  const { privateKey, ...pub } = identity;
  if (privateKey) writeFileAtomic(keyPath(dir), privateKey, { mode: 0o600 });
  writeJsonAtomic(identityPath(dir), pub, { mode: 0o600 });
  return identity;
}

/**
 * Enrol this directory, once.
 *
 * "Once" is the title of the bead and it is the behaviour: an already-enrolled directory
 * hands back what it has rather than minting a second identity, because the way one
 * install quietly becomes two is a boot path that mints whenever it cannot find. A
 * directory holding somebody else's identity is refused outright and named as such — the
 * caller chooses `adopt` or `reenrol`, and neither is a default.
 */
export function enrol(dir, { org, place, at, observing = false } = {}) {
  const where = place || placeOf(dir);
  const existing = load(dir);

  if (existing) {
    const problems = identityProblems(existing);
    if (problems.length) throw new Error(`${identityPath(dir)} holds something that is not an identity:\n  - ${problems.join('\n  - ')}`);
    if (placementOf(where) !== existing.placement) {
      throw new Error(
        `${dir} holds ${existing.id}, which was enrolled somewhere else — this is a copy of it. ` +
          'Adopt it if the install moved, or re-enrol this directory as an install of its own'
      );
    }
    return { identity: existing, record: null, enrolled: false };
  }

  if (observing) throw new Error('observing — an observer enrols nothing, because an enrolment is a claim that an install exists');
  const bad = orgProblems(org);
  if (bad.length) throw new Error(`an enrolment names the organisation it is enrolling into:\n  - ${bad.join('\n  - ')}`);

  // The record is built before anything is written, and the order is the point: a
  // directory holding an identity whose enrolment record was never made is an install that
  // exists locally and was never announced, and the retry cannot fix it — it finds what is
  // there and hands it back, exactly as it is meant to.
  const identity = newIdentity({ org, place: where, at });
  const record = enrolmentRecord(identity, { at });
  save(dir, identity);
  return { identity, record, enrolled: true };
}
