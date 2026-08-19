//
// A certificate authority, minted here, so the RFC 3161 checks run against something real
// and offline. `lib/timestamp.js`, `test/timestamp.mjs`, `test/anchor.mjs`.
//
// The alternative was a token captured from a public authority and committed as a fixture,
// and it is the worse one twice over: the suite would then test one authority's habits
// rather than the standard, and — the part that decides it — a fixture cannot be made
// *wrong* on demand. Half of what `verifyToken` is for is refusing tokens that are subtly
// bad, and a check that only ever sees a good one is a check nobody has watched fire. So
// everything below takes knobs: sign with the wrong key, omit the signed attributes, claim
// a digest the token does not carry, leave the timestamping usage off the certificate,
// stamp a time outside the certificate's validity.
//
// It is written on lib/der.js's writer, which exists for the timestamp *request* anyway.
// Node can parse an X.509 certificate and cannot mint one, so ~120 lines of TBSCertificate
// is the price of a suite that needs no network and no openssl on the path.
//
import crypto from 'node:crypto';

import { TAG, bitString, bool, explicit, generalizedTime, integer, nul, octet, oid, seq, set, tlv, utcTime, utf8 } from '../../lib/der.js';

const OID = {
  cn: '2.5.4.3',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  extendedKeyUsage: '2.5.29.37',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha1: '1.3.14.3.2.26',
  policy: '1.3.6.1.4.1.99999.1',
};

const name = (cn) => seq(set(seq(oid(OID.cn), utf8(cn))));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const algorithm = () => seq(oid(OID.ecdsaSha256));

/** An extension, with `critical` written only when it is true — as DER requires. */
const extension = (id, critical, value) => (critical ? seq(oid(id), bool(true), octet(value)) : seq(oid(id), octet(value)));

/** A P-256 key pair, which is what everything here signs with. */
export const keyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/**
 * One certificate — self-signed when no issuer is given, otherwise issued by one.
 *
 * `notBefore`/`notAfter` are knobs because "was this authority authorised at the moment it
 * says it stamped?" is a real check with a real failure, and the only way to exercise it is
 * to mint a certificate that was not.
 */
export function certificate({ cn, key, issuer = null, ca = false, eku = [], notBefore = new Date(Date.now() - 86400000), notAfter = new Date(Date.now() + 3650 * 86400000), serial = 1 } = {}) {
  const spki = key.publicKey.export({ type: 'spki', format: 'der' });
  const extensions = [];
  if (ca) extensions.push(extension(OID.basicConstraints, true, seq(bool(true))));
  if (eku.length) extensions.push(extension(OID.extendedKeyUsage, true, seq(...eku.map((e) => oid(e)))));

  const parts = [
    explicit(0, integer(2)), // v3
    integer(serial),
    algorithm(),
    name(issuer ? issuer.cn : cn),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(cn),
    spki,
  ];
  if (extensions.length) parts.push(explicit(3, seq(...extensions)));

  const tbs = seq(...parts);
  const signature = crypto.sign('sha256', tbs, issuer ? issuer.key.privateKey : key.privateKey);
  const der = seq(tbs, algorithm(), bitString(signature));
  return { der, x509: new crypto.X509Certificate(der), key, cn };
}

/**
 * A root and the timestamping certificate it issued — the pair a verifier is handed.
 *
 * `eku` defaults to the timestamping usage precisely so a test can take it away: a signer
 * whose certificate never said it was for timestamps is a signer whose authority nobody
 * granted, and the refusal for that is not the same as the refusal for a bad signature.
 */
export function authority({ root = 'Beadcause Test Timestamping Root', signer = 'Beadcause Test TSA', eku = [OID.timeStamping], notBefore, notAfter } = {}) {
  const rootKey = keyPair();
  const signerKey = keyPair();
  const rootCert = certificate({ cn: root, key: rootKey, ca: true, serial: 1 });
  const signerCert = certificate({ cn: signer, key: signerKey, issuer: { cn: root, key: rootKey }, eku, serial: 2, notBefore, notAfter });
  return { root: rootCert, signer: signerCert, ca: rootCert.x509, oids: OID };
}

/** `TSTInfo` — what the authority asserts, with every field a test may want to spoil. */
function tstInfo({ digest, genTime, serial = 42, nonce = null, imprintAlgorithm = OID.sha256, policy = OID.policy }) {
  const parts = [
    integer(1),
    oid(policy),
    seq(seq(oid(imprintAlgorithm), nul()), octet(Buffer.from(digest, 'hex'))),
    integer(serial),
    generalizedTime(genTime),
  ];
  if (nonce) parts.push(integer(Buffer.from(nonce)));
  return seq(...parts);
}

/**
 * A timestamp token over one digest.
 *
 * The signed attributes are sorted by their encoding before the SET is built, because DER
 * says a SET OF is sorted and a verifier is entitled to assume it — a helper that emits an
 * unsorted one would be testing the verifier against a document no authority would send.
 */
export function token({
  tsa,
  digest,
  genTime = new Date(),
  serial = 42,
  nonce = null,
  imprintAlgorithm = OID.sha256,
  signedAttrs = true,
  messageDigest = null,
  contentType = OID.tstInfo,
  signWith = null,
  certs = null,
} = {}) {
  const info = tstInfo({ digest, genTime, serial, nonce, imprintAlgorithm });
  const attrs = [
    seq(oid(OID.contentType), set(oid(contentType))),
    seq(oid(OID.messageDigest), set(octet(messageDigest || sha256(info)))),
  ].sort((a, b) => Buffer.compare(a, b));

  const key = signWith || tsa.signer.key.privateKey;
  const toSign = signedAttrs ? set(...attrs) : info;
  const signature = crypto.sign('sha256', toSign, key);
  const attrsImplicit = tlv(0xa0, Buffer.concat(attrs));

  const signerInfo = seq(
    integer(1),
    seq(name(tsa.root.cn), integer(2)),
    seq(oid(OID.sha256), nul()),
    ...(signedAttrs ? [attrsImplicit] : []),
    algorithm(),
    tlv(TAG.OCTET_STRING, signature)
  );

  const bundle = certs === null ? [tsa.signer.der] : certs;
  const signedData = seq(
    integer(3),
    set(seq(oid(OID.sha256), nul())),
    seq(oid(OID.tstInfo), explicit(0, octet(info))),
    ...(bundle.length ? [tlv(0xa0, Buffer.concat(bundle))] : []),
    set(signerInfo)
  );

  return seq(oid(OID.signedData), explicit(0, signedData));
}

/** A whole `TimeStampResp`, for the one test that reads a refusal rather than a token. */
export function response({ status = 0, text = null, tokenBytes = null } = {}) {
  const info = text ? seq(integer(status), seq(utf8(text))) : seq(integer(status));
  return seq(...[info, ...(tokenBytes ? [tokenBytes] : [])]);
}

export { OID as TSA_OID };
