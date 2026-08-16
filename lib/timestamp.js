/**
 * RFC 3161 — a named authority signs that this hash existed by this time.
 *
 * One half of the anchor in bc-3muu.10, and the half that needs nobody to still be
 * running. A timestamp token is a signature over *the hash you sent and the time the
 * authority read off its own clock*, and it verifies with the token and a certificate in
 * hand: no network, no service that has to still exist, no account with anybody. That is
 * a strange and valuable property for a compliance record, because the thing an auditor
 * is checking in 2031 is a claim made in 2026 by a company that may not be there.
 *
 * **What it can and cannot say.** It cannot say a history is correct, and it does not
 * look at one. It says a 32-byte digest was in existence at a moment, witnessed by a
 * party with no stake in the answer — and *that* is what turns `intact` into evidence.
 * A rewritten evidence chain is perfectly intact; what it cannot be is timestamped, six
 * months ago, by a CA, at the digest the old head had. The rewrite is detected by
 * arithmetic on receipts rather than by trusting anybody's copy.
 *
 * **Nothing but the hash is sent, and the request is a small enough structure to see it.**
 * A `TimeStampReq` carries a version, an algorithm identifier, the digest, an optional
 * nonce and a boolean. There is no field a caller could put a bead id in even carelessly,
 * which is why the boundary in lib/publishable.js survives all the way out to a third
 * party rather than stopping at the service: what leaves the Mac here is 32 bytes with no
 * structure in them at all. `parseRequest` exists so a suite can assert that, on the
 * actual bytes, rather than on a promise in a comment.
 *
 * **The nonce is the only reason to keep a request around.** It is a random number echoed
 * back in the token, and checking the echo is what tells you the authority answered *your*
 * request rather than replaying an earlier one at you. It is optional and worth sending;
 * verification without it is still sound, because a replayed token still binds a real
 * digest to a real time — the digest just may not be the one you asked about today.
 *
 * **Verification is the part with teeth, and it is deliberately paranoid.** The failure
 * modes here are not exotic: a token for a *different* digest reads exactly like a valid
 * one if nobody compares the imprint; signed attributes that are hashed but not compared
 * to the content let a signature be lifted onto another document; and a signer certificate
 * that chains nowhere in particular makes "signed by a CA" mean "signed". So `verifyToken`
 * checks the imprint against the digest it was given, checks the `messageDigest` attribute
 * against the encapsulated content, verifies the signature over the re-tagged `SET OF`
 * attributes as CMS specifies, requires the signer to carry the timestamping extended key
 * usage, and requires it to chain to the certificate the caller trusts. Every one of those
 * has its own refusal sentence, because "invalid" tells an operator nothing.
 *
 * **A token outlives the certificate that signed it, which is the whole point of one.**
 * So the validity check is that the signer was authorised *at `genTime`* — not that it
 * still is today. Checking against the current clock would mean every receipt in the
 * archive silently turning invalid on a date nobody chose, which is the exact opposite of
 * what an archive is for.
 *
 * A leaf: node:crypto and lib/der.js, and nothing that reads a config directory — a
 * check, a daemon and a service can all import it.
 */
import crypto from 'node:crypto';

import { TAG, bool, integer, integerOf, nul, oid, oidOf, octet, parse, seq, serialOf, timeOf } from './der.js';

/* ------------------------------------------------------------ what the OIDs are */

export const OID = Object.freeze({
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  sha1: '1.3.14.3.2.26',
});

/**
 * Digest algorithms a token may use, and the one thing missing from the list.
 *
 * SHA-1 is absent on purpose and is refused by name rather than by falling off the end of
 * a lookup. A collision against SHA-1 is a way to have an authority timestamp a digest
 * that two different documents both produce, which is precisely the property the anchor
 * is bought for — so a token that used it is not a weaker receipt, it is not a receipt.
 */
const DIGESTS = Object.freeze({
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
});

/** Signature algorithms, as `crypto.verify` names them. `null` means the key decides. */
const SIGNATURES = Object.freeze({
  '1.2.840.113549.1.1.1': { name: 'RSA', digestFromToken: true },
  '1.2.840.113549.1.1.11': { name: 'RSA with SHA-256', digest: 'sha256' },
  '1.2.840.113549.1.1.12': { name: 'RSA with SHA-384', digest: 'sha384' },
  '1.2.840.113549.1.1.13': { name: 'RSA with SHA-512', digest: 'sha512' },
  '1.2.840.10045.4.3.2': { name: 'ECDSA with SHA-256', digest: 'sha256' },
  '1.2.840.10045.4.3.3': { name: 'ECDSA with SHA-384', digest: 'sha384' },
  '1.3.101.112': { name: 'Ed25519', digest: null },
});

/** What a `PKIStatusInfo` status means, so a refusal can be quoted rather than numbered. */
export const STATUS = Object.freeze([
  'granted',
  'granted, with modifications',
  'rejected',
  'waiting',
  'revocation warning',
  'revocation notification',
]);

/* --------------------------------------------------------------- the request */

/** The 32 bytes of a `sha256:<hex>` digest, a bare hex string, or a buffer. */
export function hashBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  const s = String(value ?? '');
  const hex = s.startsWith('sha256:') ? s.slice(7) : s;
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError(`not a sha256 digest: ${s}`);
  return Buffer.from(hex, 'hex');
}

/**
 * A timestamp request for one digest — the whole of what leaves the machine.
 *
 * `certReq` asks the authority to return its certificate chain inside the token, and it
 * defaults to true because a receipt you cannot verify without separately obtaining a
 * certificate is a receipt with a dependency on somebody still publishing it.
 */
export function requestFor(digest, { nonce = crypto.randomBytes(16), certReq = true, policy = null } = {}) {
  const parts = [integer(1), seq(seq(oid(OID.sha256), nul()), octet(hashBytes(digest)))];
  if (policy) parts.push(oid(policy));
  if (nonce) parts.push(integer(Buffer.from(nonce)));
  if (certReq) parts.push(bool(true));
  return { bytes: seq(...parts), nonce: nonce ? Buffer.from(nonce) : null };
}

/**
 * A request read back — so a suite can prove on the bytes that only a hash is in there.
 *
 * Returns the fields *and* how many elements the request actually had, because the claim
 * being checked is not "the digest is present" but "nothing else is".
 */
export function parseRequest(der) {
  const node = parse(der);
  if (node.tag !== TAG.SEQUENCE) throw new Error('a timestamp request is a sequence');
  const [version, imprint, ...rest] = node.children;
  const algorithm = oidOf(imprint.children[0].children[0]);
  const out = {
    version: Number(integerOf(version)),
    algorithm: DIGESTS[algorithm] || algorithm,
    digest: imprint.children[1].value.toString('hex'),
    nonce: null,
    certReq: false,
    policy: null,
    elements: node.children.length,
  };
  for (const el of rest) {
    if (el.tag === TAG.OID) out.policy = oidOf(el);
    else if (el.tag === TAG.INTEGER) out.nonce = integerOf(el).toString(16);
    else if (el.tag === TAG.BOOLEAN) out.certReq = el.value[0] !== 0;
  }
  return out;
}

/** A `TimeStampResp` split into its verdict and, if there is one, its token. */
export function parseResponse(der) {
  const node = parse(der);
  const info = node.children[0];
  const status = Number(integerOf(info.children[0]));
  const text = (info.children.find((c) => c.tag === TAG.SEQUENCE)?.children || [])
    .map((c) => c.value.toString('utf8'))
    .join('; ');
  const token = node.children[1] || null;
  return {
    status,
    statusText: text || STATUS[status] || `status ${status}`,
    granted: status === 0 || status === 1,
    token: token ? Buffer.from(token.bytes) : null,
  };
}

/* ------------------------------------------------------------- the token itself */

/** Every attribute in a `SET OF Attribute`, by OID, as the elements of its value set. */
function attributes(node) {
  const map = new Map();
  for (const attr of node.children || []) {
    const id = oidOf(attr.children[0]);
    if (map.has(id)) throw new Error(`the attribute ${id} appears twice, and a signed set with two answers has none`);
    map.set(id, attr.children[1].children || []);
  }
  return map;
}

/**
 * A token pulled apart, with the byte ranges a verifier needs kept intact.
 *
 * `eContent` and `signedAttrs` are subarrays of what was handed in, never re-encodings:
 * a signature covers bytes, and hashing a decoder's idea of the same structure is how a
 * verifier ends up right about a document nobody sent.
 */
export function parseToken(der) {
  const content = parse(der);
  const type = oidOf(content.children[0]);
  if (type !== OID.signedData) throw new Error(`a timestamp token wraps signedData, and this wraps ${type}`);
  const signed = content.children[1].children[0];

  const encap = signed.children[2];
  const eContentType = oidOf(encap.children[0]);
  // `eContent` is `[0] EXPLICIT OCTET STRING`, so the bytes that are hashed and signed are
  // the *contents* of the octet string — two unwraps, not one. Digesting the wrapper
  // instead is a mistake that verifies perfectly against tokens you minted yourself and
  // against nobody else's.
  const eContentOctet = encap.children[1]?.children?.[0] || null;
  const eContent = eContentOctet ? eContentOctet.value : null;

  // `certificates` is `[0] IMPLICIT`, so it is the only 0xa0 at this level — `crls` is
  // `[1]`. Anything in there that is not a plain certificate (an attribute certificate,
  // say) is skipped rather than refused: it is not what signs a timestamp.
  const certs = [];
  for (const el of signed.children) {
    if (el.tag !== 0xa0) continue;
    for (const c of el.children || []) if (c.tag === TAG.SEQUENCE) certs.push(new crypto.X509Certificate(Buffer.from(c.bytes)));
  }

  const signerInfos = signed.children[signed.children.length - 1];
  if (signerInfos.tag !== TAG.SET) throw new Error('a signed document ends in its set of signer infos');
  if (signerInfos.children.length !== 1) throw new Error(`${signerInfos.children.length} signers on one token, and a timestamp has exactly one`);
  const si = signerInfos.children[0];

  const sid = si.children[1];
  const signerSerial = sid.tag === TAG.SEQUENCE ? serialOf(sid.children[1]) : null;
  const digestAlgorithm = oidOf(si.children[2].children[0]);
  const signedAttrsNode = si.children.find((c) => c.tag === 0xa0) || null;
  const after = si.children.slice(si.children.indexOf(signedAttrsNode) + 1);
  const sigAlgNode = (signedAttrsNode ? after : si.children.slice(3)).find((c) => c.tag === TAG.SEQUENCE);
  const signature = si.children.filter((c) => c.tag === TAG.OCTET_STRING).pop();

  return {
    eContentType,
    eContent,
    tst: eContent ? tstInfoOf(parse(eContent)) : null,
    certs,
    signerSerial,
    digestAlgorithm,
    signedAttrs: signedAttrsNode,
    signatureAlgorithm: oidOf(sigAlgNode.children[0]),
    signature: signature ? Buffer.from(signature.value) : null,
  };
}

/** `TSTInfo` — what the authority actually asserts. */
function tstInfoOf(node) {
  const [version, policy, imprint, serial, genTime, ...rest] = node.children;
  const out = {
    version: Number(integerOf(version)),
    policy: oidOf(policy),
    algorithm: oidOf(imprint.children[0].children[0]),
    digest: imprint.children[1].value.toString('hex'),
    serial: serialOf(serial),
    genTime: timeOf(genTime),
    accuracy: null,
    ordering: false,
    nonce: null,
    tsa: null,
  };
  for (const el of rest) {
    if (el.tag === TAG.SEQUENCE) {
      const seconds = el.children[0] && el.children[0].tag === TAG.INTEGER ? Number(integerOf(el.children[0])) : 0;
      out.accuracy = { seconds };
    } else if (el.tag === TAG.BOOLEAN) out.ordering = el.value[0] !== 0;
    else if (el.tag === TAG.INTEGER) out.nonce = integerOf(el).toString(16);
    else if (el.tag === 0xa0) out.tsa = el.bytes.toString('hex');
  }
  return out;
}

/* ------------------------------------------------------------------ verifying */

/** The bytes a CMS signature actually covers: the signed attributes, re-tagged `SET OF`. */
function signedBytes(token) {
  if (!token.signedAttrs) return token.eContent;
  return Buffer.concat([Buffer.from([TAG.SET]), Buffer.from(token.signedAttrs.bytes.subarray(1))]);
}

/**
 * Everything wrong with a timestamp token, as sentences — empty when it is a receipt.
 *
 * `ca` is the certificate the caller has decided to trust. There is no ambient trust store
 * here and there should not be: an anchor whose validity depends on whatever certificates
 * happen to be installed on the machine doing the checking is an anchor that means
 * something different on every machine, and the point of the receipt is that it means the
 * same thing to an auditor with nothing but the files.
 */
export function verifyToken(der, { digest, ca, signer = null, nonce = null } = {}) {
  const problems = [];
  let token;
  try {
    token = parseToken(der);
  } catch (err) {
    return { ok: false, problems: [`the token could not be read: ${err.message}`] };
  }

  const tst = token.tst;
  if (token.eContentType !== OID.tstInfo) problems.push(`the signed content is ${token.eContentType}, and a timestamp signs a TSTInfo`);
  if (!tst) return { ok: false, problems: [...problems, 'the token carries no TSTInfo, so it asserts nothing'] };

  const hash = DIGESTS[tst.algorithm];
  if (!hash) {
    problems.push(
      tst.algorithm === OID.sha1
        ? 'the imprint is SHA-1, and a digest two documents can share is not a receipt for either'
        : `the imprint uses ${tst.algorithm}, which is not a digest this accepts`
    );
  }
  if (digest !== undefined && digest !== null) {
    const want = hashBytes(digest).toString('hex');
    if (tst.digest !== want) problems.push(`the token is a receipt for ${tst.digest.slice(0, 16)}…, and the head digests to ${want.slice(0, 16)}…`);
  }
  if (nonce) {
    const want = BigInt(`0x${Buffer.from(nonce).toString('hex')}`).toString(16);
    if (tst.nonce !== want) problems.push(`the token echoes nonce ${tst.nonce}, and this request sent ${want} — it answers somebody else's question`);
  }

  if (token.signedAttrs) {
    let attrs;
    try {
      attrs = attributes(token.signedAttrs);
    } catch (err) {
      return { ok: false, problems: [...problems, err.message] };
    }
    const md = attrs.get(OID.messageDigest)?.[0];
    const ct = attrs.get(OID.contentType)?.[0];
    if (!md) problems.push('the signed attributes carry no messageDigest, so the signature does not cover the content');
    else {
      const alg = DIGESTS[token.digestAlgorithm] || 'sha256';
      const actual = crypto.createHash(alg).update(token.eContent).digest();
      if (!md.value.equals(actual)) problems.push('the signed messageDigest is not the digest of the content it is attached to');
    }
    if (!ct) problems.push('the signed attributes carry no contentType');
    else if (oidOf(ct) !== OID.tstInfo) problems.push(`the signed contentType is ${oidOf(ct)}, and a timestamp signs a TSTInfo`);
  } else {
    problems.push('the token has no signed attributes, and RFC 3161 requires them');
  }

  const alg = SIGNATURES[token.signatureAlgorithm];
  if (!alg) problems.push(`the signature algorithm ${token.signatureAlgorithm} is not one this verifies`);

  const candidates = signer ? [signer] : token.certs;
  if (!candidates.length) problems.push('the token carries no certificate and none was supplied, so there is nothing to verify it against');

  let signerCert = null;
  const data = signedBytes(token);
  if (alg && data) {
    const hashName = alg.digestFromToken ? DIGESTS[token.digestAlgorithm] || 'sha256' : alg.digest;
    for (const cert of candidates) {
      let ok = false;
      try {
        ok = crypto.verify(hashName, data, cert.publicKey, token.signature);
      } catch {
        ok = false;
      }
      if (ok) {
        signerCert = cert;
        break;
      }
    }
    if (!signerCert) problems.push(`no certificate on the token signs it — the ${alg.name} signature verifies against none of the ${candidates.length} offered`);
  }

  if (signerCert) {
    const usages = signerCert.keyUsage || [];
    if (!usages.includes(OID.timeStamping)) {
      problems.push('the signing certificate does not carry the timestamping extended key usage, so the authority never said this key was for timestamps');
    }
    if (!ca) problems.push('no trusted certificate was supplied, so "signed by an authority" means only "signed"');
    else {
      // `a.checkIssued(b)` asks whether *a* was issued by b, not the other way round. Read
      // the wrong way it is a check that always fails, which looks exactly like a chain
      // that does not verify — and the fix for that is not the fix for this.
      const issued = safely(() => signerCert.checkIssued(ca));
      const verifies = safely(() => signerCert.verify(ca.publicKey));
      if (!(issued && verifies)) problems.push(`the signing certificate (${signerCert.subject.replace(/\n/g, ', ')}) does not chain to the certificate this trusts`);
    }
    const from = Date.parse(signerCert.validFrom);
    const to = Date.parse(signerCert.validTo);
    const at = Date.parse(tst.genTime);
    // Not `Date.now()`: a token is *supposed* to outlive its certificate. Checking against
    // today would expire the whole archive on a date nobody chose.
    if (Number.isFinite(from) && at < from) problems.push(`the token is stamped ${tst.genTime}, before its certificate was valid`);
    if (Number.isFinite(to) && at > to) problems.push(`the token is stamped ${tst.genTime}, after its certificate had expired`);
  }

  return {
    ok: problems.length === 0,
    problems,
    at: tst.genTime,
    serial: tst.serial,
    policy: tst.policy,
    accuracy: tst.accuracy,
    digest: `sha256:${tst.digest}`,
    authority: signerCert ? signerCert.subject.replace(/\n/g, ', ') : null,
  };
}

const safely = (fn) => {
  try {
    return fn() === true;
  } catch {
    return false;
  }
};
