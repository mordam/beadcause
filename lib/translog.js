/**
 * A public transparency log — the other half of the anchor, and the half nobody can
 * rewrite quietly.
 *
 * An RFC 3161 token is one signature from one authority: offline-verifiable forever, and
 * worth exactly as much as that authority. A transparency log is the opposite trade. It
 * is an append-only Merkle tree, published, witnessed and gossiped, whose operator cannot
 * remove an entry without producing a tree that fails a *consistency* proof against a
 * tree head somebody else already wrote down. So one is a promise from a named party you
 * can check with no network; the other is a structure that catches the party breaking its
 * promise. They fail differently, which is why bc-3muu.10 keeps both.
 *
 * **The arithmetic is the point, and it is small.** RFC 6962 hashes a leaf as
 * `SHA-256(0x00 ‖ entry)` and an interior node as `SHA-256(0x01 ‖ left ‖ right)`, and the
 * two prefixes are not decoration: without them a leaf's bytes could be crafted to look
 * like an interior node, and a tree in which a leaf can pretend to be a subtree is a tree
 * where an inclusion proof proves nothing. Given those, an inclusion proof is a list of
 * sibling hashes that recomputes the root, and it is checkable by anybody in twenty lines
 * with no access to the log at all.
 *
 * **An inclusion proof alone is only half a check, and this is the mistake worth naming.**
 * It proves an entry is in *a* tree with *that* root. It says nothing about whether that
 * root is the log's real root, and nothing about whether the log kept its promise — a log
 * that quietly rebuilt itself yesterday can produce a perfectly valid inclusion proof
 * against its new tree. What closes that is the pair below it: the root must come from a
 * *signed* checkpoint, so the operator is on the record for it; and a checkpoint held
 * later must be provably consistent with the one held earlier, which is what makes a
 * silent rewrite impossible rather than merely rude.
 *
 * **Nothing here talks to a log.** These are the checks; fetching a proof, and deciding
 * which logs and which keys an install trusts, belongs with the transport in bc-3muu.3 —
 * and keeping the verifier network-free is what lets the suite run the real algorithm
 * against real trees it builds itself, rather than against a recording of one.
 *
 * **The checkpoint is the `note` format** Go's sum database and sigstore both use: origin,
 * size, base64 root, any further lines, a blank line, then one or more signature lines.
 * The signed bytes are everything up to and *including* the blank line, verbatim — which
 * is why `parseCheckpoint` hands back `body` as a string sliced out of the input rather
 * than reassembling it from the fields it decoded. Re-encoding before verifying is how a
 * verifier ends up right about a document nobody signed.
 *
 * A leaf: node:crypto and nothing else.
 */
import crypto from 'node:crypto';

/** `SHA-256(0x00 ‖ entry)` — the prefix that stops a leaf impersonating a subtree. */
export function leafHash(entry) {
  const bytes = Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), 'utf8');
  return crypto.createHash('sha256').update(Buffer.from([0x00])).update(bytes).digest();
}

/** `SHA-256(0x01 ‖ left ‖ right)` — an interior node. */
export function nodeHash(left, right) {
  return crypto.createHash('sha256').update(Buffer.from([0x01])).update(left).update(right).digest();
}

/** The Merkle tree head over a list of entries — what a checkpoint publishes. */
export function rootOf(entries) {
  let level = entries.map((e) => (Buffer.isBuffer(e) && e.length === 32 ? e : leafHash(e)));
  if (!level.length) return crypto.createHash('sha256').digest();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
    // An odd node is promoted, never paired with a copy of itself. Duplicating it makes
    // two different lists of entries produce the same root, which is CVE-2012-2459 and
    // is the one implementation mistake that makes a whole log meaningless.
    if (level.length % 2) next.push(level[level.length - 1]);
    level = next;
  }
  return level[0];
}

/* --------------------------------------------------------------- proof shapes */

// Written over the binary string rather than with `<<`/`>>`, which silently truncate to
// 32 bits: a log with more than two billion entries is not hypothetical, and a bit
// operator that wraps there would make the proof shape wrong in exactly the case nobody
// has a fixture for.
const bitLength = (n) => (n <= 0 ? 0 : n.toString(2).length);
const onesCount = (n) => (n <= 0 ? 0 : [...n.toString(2)].filter((c) => c === '1').length);
const trailingZeros = (n) => (n <= 0 ? 0 : n.toString(2).length - n.toString(2).replace(/0+$/, '').length);

/**
 * How a proof of index `i` in a tree of `size` splits — inner nodes, then border nodes.
 *
 * The first `inner` hashes are siblings inside the perfect subtree the leaf sits in, and
 * they combine left or right depending on the bits of the index. The remaining `border`
 * hashes are the roots of the complete subtrees to the *left*, which always combine on
 * the left. Getting the split wrong is how a verifier accepts a proof for a different
 * leaf that happens to be the same length, so it is computed rather than inferred.
 */
function decompose(index, size) {
  const inner = bitLength(Number(BigInt(index) ^ BigInt(size - 1)));
  return { inner, border: onesCount(Math.floor(index / 2 ** inner)) };
}

const chainInner = (seed, proof, index) =>
  proof.reduce((acc, h, i) => (Math.floor(index / 2 ** i) % 2 === 0 ? nodeHash(acc, h) : nodeHash(h, acc)), seed);

const chainInnerRight = (seed, proof, index) =>
  proof.reduce((acc, h, i) => (Math.floor(index / 2 ** i) % 2 === 1 ? nodeHash(h, acc) : acc), seed);

const chainBorderRight = (seed, proof) => proof.reduce((acc, h) => nodeHash(h, acc), seed);

const asHash = (h) => {
  const b = Buffer.isBuffer(h) ? h : Buffer.from(String(h), 'base64');
  return b.length === 32 ? b : null;
};

/**
 * Everything wrong with an inclusion proof, as sentences — empty when the entry is in the
 * tree whose root was given.
 *
 * The proof length is checked against the shape the index and size imply, before any
 * hashing: a proof of the wrong length cannot be a proof of anything, and a verifier that
 * hashes whatever it is handed until it runs out is one that can be fed a shorter path to
 * a root it was not asked about.
 */
export function verifyInclusion({ index, size, leaf, proof = [], root } = {}) {
  const problems = [];
  if (!Number.isSafeInteger(index) || index < 0) problems.push(`${index} is not a leaf index`);
  if (!Number.isSafeInteger(size) || size <= 0) problems.push(`${size} is not a tree size`);
  const leafBytes = asHash(leaf);
  const rootBytes = asHash(root);
  if (!leafBytes) problems.push('the leaf hash is not 32 bytes, so it is not a SHA-256 leaf');
  if (!rootBytes) problems.push('the root hash is not 32 bytes, so it is not a Merkle root');
  if (problems.length) return problems;
  if (index >= size) return [`leaf ${index} cannot be in a tree of ${size}, which numbers its leaves 0 to ${size - 1}`];

  const hashes = proof.map(asHash);
  if (hashes.some((h) => !h)) return ['a hash in the proof is not 32 bytes'];
  const { inner, border } = decompose(index, size);
  if (hashes.length !== inner + border) {
    return [`the proof has ${hashes.length} hash(es) and a path to leaf ${index} of a tree of ${size} has ${inner + border}`];
  }

  const computed = chainBorderRight(chainInner(leafBytes, hashes.slice(0, inner), index), hashes.slice(inner));
  if (!computed.equals(rootBytes)) {
    return [
      `the proof rebuilds the root as ${computed.toString('base64')}, and the checkpoint says ${rootBytes.toString('base64')} — ` +
        'so either this entry is not in that tree, or the tree is not the one that was signed',
    ];
  }
  return [];
}

/**
 * Everything wrong with a consistency proof between two tree heads.
 *
 * This is the check that makes the log's promise enforceable rather than decorative. An
 * inclusion proof against today's root is satisfied by a log that threw yesterday away and
 * built a new tree; a consistency proof from the checkpoint you held in March to the one
 * you hold now is not, because no such proof exists unless every leaf in the old tree is
 * still in the new one, in the same order, unaltered.
 */
export function verifyConsistency({ size, root, next: nextSize, nextRoot, proof = [] } = {}) {
  const hashes = proof.map(asHash);
  if (hashes.some((h) => !h)) return ['a hash in the proof is not 32 bytes'];
  const older = asHash(root);
  const newer = asHash(nextRoot);
  if (!older || !newer) return ['a tree head is not 32 bytes, so it is not a Merkle root'];
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(nextSize) || size < 0 || nextSize < 0) return ['a tree size is not a whole number'];
  if (nextSize < size) return [`a log of ${size} entries cannot shrink to ${nextSize}, and a log that shrank is not append-only`];
  if (size === nextSize) {
    if (hashes.length) return ['two identical sizes need no proof, and a proof between them proves nothing'];
    return older.equals(newer) ? [] : [`the log is still ${size} entries and its head changed, so entries were rewritten in place`];
  }
  if (size === 0) return hashes.length ? ['an empty tree is consistent with everything, and needs no proof'] : [];
  if (!hashes.length) return ['no proof was given, and consistency between two different sizes is never free'];

  const shift = trailingZeros(size);
  const { inner: innerAll, border } = decompose(size - 1, nextSize);
  const inner = innerAll - shift;

  const wholeSubtree = size === 2 ** shift;
  const seed = wholeSubtree ? older : hashes[0];
  const start = wholeSubtree ? 0 : 1;
  if (hashes.length !== start + inner + border) {
    return [`the proof has ${hashes.length} hash(es) and one from ${size} to ${nextSize} entries has ${start + inner + border}`];
  }
  const rest = hashes.slice(start);
  const mask = Math.floor((size - 1) / 2 ** shift);

  const rebuiltOld = chainBorderRight(chainInnerRight(seed, rest.slice(0, inner), mask), rest.slice(inner));
  if (!rebuiltOld.equals(older)) {
    return [`the proof does not rebuild the head at ${size} entries, so the earlier tree it describes is not the one that was signed`];
  }
  const rebuiltNew = chainBorderRight(chainInner(seed, rest.slice(0, inner), mask), rest.slice(inner));
  if (!rebuiltNew.equals(newer)) {
    return [`the proof does not rebuild the head at ${nextSize} entries — the log at ${size} entries is not a prefix of the log now`];
  }
  return [];
}

/* ----------------------------------------------------------------- checkpoints */

const DASH = '— ';

/**
 * A signed note, split into the bytes that were signed and the signatures over them.
 *
 * `body` is sliced out of the input and is what a signature covers — everything up to and
 * including the blank line. Rebuilding it from `origin`, `size` and `root` would verify a
 * document this parser invented, and would quietly drop any extra line a log added.
 */
export function parseCheckpoint(text) {
  const s = String(text ?? '');
  const split = s.indexOf('\n\n');
  if (split < 0) throw new Error('a checkpoint has a blank line between what is signed and the signatures over it');
  const body = s.slice(0, split + 2);
  const lines = s.slice(0, split).split('\n');
  if (lines.length < 3) throw new Error('a checkpoint states an origin, a size and a root hash');
  const size = Number(lines[1]);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`"${lines[1]}" is not a tree size`);
  const root = Buffer.from(lines[2], 'base64');
  if (root.length !== 32) throw new Error('the root hash on the checkpoint is not 32 bytes');

  const signatures = [];
  for (const line of s.slice(split + 2).split('\n')) {
    if (!line.trim()) continue;
    if (!line.startsWith(DASH)) throw new Error(`"${line.slice(0, 24)}…" is not a signature line`);
    const [name, encoded] = line.slice(DASH.length).split(' ');
    const blob = Buffer.from(encoded || '', 'base64');
    if (blob.length < 5) throw new Error(`the signature from ${name} is too short to be one`);
    signatures.push({ name, keyHint: blob.subarray(0, 4).toString('hex'), signature: blob.subarray(4) });
  }
  if (!signatures.length) throw new Error('an unsigned checkpoint is a claim nobody made');

  return { origin: lines[0], size, root, extra: lines.slice(3), body, signatures };
}

/**
 * Everything wrong with a checkpoint, given the keys an install trusts.
 *
 * `keys` maps a signer name to a public key. There is deliberately no default and no
 * fetch: a checkpoint verified against whatever key the checkpoint itself points at is a
 * checkpoint verified against nothing, and the receipt is supposed to mean the same thing
 * to an auditor holding only the files.
 */
export function verifyCheckpoint(text, { keys = {}, origin = null } = {}) {
  let note;
  try {
    note = parseCheckpoint(text);
  } catch (err) {
    return { ok: false, problems: [err.message] };
  }
  const problems = [];
  if (origin && note.origin !== origin) problems.push(`the checkpoint is from ${note.origin}, and this anchor is against ${origin}`);

  const signed = [];
  for (const sig of note.signatures) {
    const key = keys[sig.name];
    if (!key) continue;
    const type = key.asymmetricKeyType;
    let ok = false;
    try {
      ok = crypto.verify(type === 'ed25519' ? null : 'sha256', Buffer.from(note.body, 'utf8'), key, sig.signature);
    } catch {
      ok = false;
    }
    if (ok) signed.push(sig.name);
    else problems.push(`the signature attributed to ${sig.name} does not verify against the key held for it`);
  }
  if (!signed.length && !problems.length) {
    problems.push(`the checkpoint is signed by ${note.signatures.map((s) => s.name).join(', ')}, and no key is held for any of them`);
  }

  return { ok: problems.length === 0 && signed.length > 0, problems, origin: note.origin, size: note.size, root: note.root, signedBy: signed };
}
