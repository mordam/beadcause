#!/usr/bin/env node
//
// An RFC 3161 timestamp is a receipt or it is nothing. `lib/timestamp.js`, `lib/der.js`.
//
//   npm test
//   node test/timestamp.mjs
//
// bc-3muu.10: the anchor is the thin slice of the compliance record that is genuinely
// third-party, and half of it is a signature from a named authority that verifies offline,
// forever, with no service that has to still exist. That property is worth exactly as much
// as the verifier, so this suite is mostly about tokens that are *nearly* right.
//
// Four jobs, and the third is the one a suite usually skips:
//
//   1. Only a hash leaves. The request is rebuilt byte for byte from what it is supposed
//      to contain, because "the digest is in there" is not the claim — "nothing else is"
//      is, and only byte equality says that.
//   2. A good token verifies, against a certificate authority minted in the suite. There
//      is no network here and no fixture captured from a public authority: a fixture
//      cannot be made subtly wrong on demand, and being made subtly wrong is the whole
//      exercise. See `test/helpers/tsa.mjs`.
//   3. Every refusal is watched firing, one at a time — a token for another digest, a
//      lifted signature, attributes that do not cover the content, a signer with no
//      timestamping authority, a signer chaining to somebody else, a stamp from outside
//      the certificate's own validity, SHA-1, a replayed nonce. Each of those reads as a
//      valid token to a verifier missing that one check.
//   4. The decoder is strict, and strictness is a security property rather than
//      pedantry: BER's several spellings of the same value are several byte strings, and
//      a signature covers bytes.
//
// The policy assertion worth reading twice is that a token *outlives* its certificate.
// Checking a receipt against today's clock would expire the entire archive on a date
// nobody chose, which is the opposite of what an archive is for.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { bool, integer, nul, octet, oid, parse, seq, tlv } from '../lib/der.js';
import { OID, parseRequest, parseResponse, parseToken, requestFor, verifyToken } from '../lib/timestamp.js';
import { authority, response, token } from './helpers/tsa.mjs';

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

const HEX = crypto.createHash('sha256').update('a chain head').digest('hex');
const DIGEST = `sha256:${HEX}`;
const said = (result, text) => assert.ok(result.problems.some((p) => p.includes(text)), `expected a refusal mentioning "${text}", got: ${result.problems.join(' | ') || '(none)'}`);

console.log('rfc 3161 timestamps\n');

/* ------------------------------------------------------ only a hash leaves */

check('the request is the digest and the four fields around it, byte for byte', () => {
  const nonce = Buffer.from('0102030405060708', 'hex');
  const { bytes } = requestFor(DIGEST, { nonce });
  const expected = seq(
    integer(1),
    seq(seq(oid(OID.sha256), nul()), octet(Buffer.from(HEX, 'hex'))),
    integer(nonce),
    bool(true)
  );
  // Byte equality rather than "the digest is in there": the claim being checked is that
  // nothing else is, and no assertion about a field's presence can say that.
  assert.equal(bytes.toString('hex'), expected.toString('hex'));
});

check('a request without a nonce is 56 bytes, and there is nowhere in it to put a sentence', () => {
  const { bytes } = requestFor(DIGEST, { nonce: null, certReq: false });
  assert.equal(bytes.length, 56);
  const req = parseRequest(bytes);
  assert.equal(req.elements, 2, 'a version and an imprint, and no third thing');
  assert.equal(req.digest, HEX);
});

check('what the request says it carries is what it carries', () => {
  const req = parseRequest(requestFor(DIGEST, { nonce: Buffer.from('ff', 'hex') }).bytes);
  assert.deepEqual({ ...req }, { version: 1, algorithm: 'sha256', digest: HEX, nonce: 'ff', certReq: true, policy: null, elements: 4 });
});

check('a digest that is not one is refused before anything is built', () => {
  assert.throws(() => requestFor('sha256:not-a-digest'), /not a sha256 digest/);
  assert.throws(() => requestFor(HEX.slice(0, 40)), /not a sha256 digest/);
});

/* ------------------------------------------------------------- a real token */

const tsa = authority();
const good = token({ tsa, digest: HEX });

check('a token from an authority this trusts verifies, and says what it witnessed', () => {
  const v = verifyToken(good, { digest: DIGEST, ca: tsa.ca });
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.digest, DIGEST);
  assert.equal(v.authority, 'CN=Beadcause Test TSA');
  assert.ok(Date.parse(v.at) > 0, 'and the time it read off its own clock');
});

check('the token is read without re-encoding it — the content is the bytes that arrived', () => {
  const parsed = parseToken(good);
  assert.equal(parsed.eContentType, OID.tstInfo);
  const inside = parse(parsed.eContent);
  assert.equal(inside.end, parsed.eContent.length, 'the encapsulated content is exactly one TSTInfo');
});

check('a token outlives the certificate that signed it, which is the point of one', () => {
  const expired = authority({ notBefore: new Date('2020-01-01T00:00:00Z'), notAfter: new Date('2021-01-01T00:00:00Z') });
  const then = token({ tsa: expired, digest: HEX, genTime: new Date('2020-06-01T00:00:00Z') });
  const v = verifyToken(then, { digest: DIGEST, ca: expired.ca });
  assert.deepEqual(v.problems, [], 'the authority was authorised when it stamped, and that is the question');
  assert.equal(v.at, '2020-06-01T00:00:00Z');
});

check('a stamp from outside the certificate it was signed under is refused', () => {
  const narrow = authority({ notBefore: new Date('2020-01-01T00:00:00Z'), notAfter: new Date('2021-01-01T00:00:00Z') });
  said(verifyToken(token({ tsa: narrow, digest: HEX, genTime: new Date('2019-06-01T00:00:00Z') }), { digest: DIGEST, ca: narrow.ca }), 'before its certificate was valid');
  said(verifyToken(token({ tsa: narrow, digest: HEX, genTime: new Date('2022-06-01T00:00:00Z') }), { digest: DIGEST, ca: narrow.ca }), 'after its certificate had expired');
});

/* --------------------------------------------------------------- refusals */

check('a token for another digest is refused, however well signed', () => {
  const other = token({ tsa, digest: crypto.createHash('sha256').update('something else').digest('hex') });
  said(verifyToken(other, { digest: DIGEST, ca: tsa.ca }), 'is a receipt for');
});

check('a signature lifted from another key does not become this one', () => {
  const stranger = authority();
  const forged = token({ tsa, digest: HEX, signWith: stranger.signer.key.privateKey });
  said(verifyToken(forged, { digest: DIGEST, ca: tsa.ca }), 'signs it');
});

check('a signer that chains to somebody else is not this authority', () => {
  const stranger = authority();
  said(verifyToken(good, { digest: DIGEST, ca: stranger.ca }), 'does not chain to the certificate this trusts');
});

check('"signed by an authority" with no authority named means only "signed"', () => {
  said(verifyToken(good, { digest: DIGEST }), 'no trusted certificate was supplied');
});

check('a signer whose certificate never claimed timestamping is refused', () => {
  const untrusted = authority({ eku: [] });
  said(verifyToken(token({ tsa: untrusted, digest: HEX }), { digest: DIGEST, ca: untrusted.ca }), 'timestamping extended key usage');
});

check('a token with no signed attributes is refused rather than accepted as simpler', () => {
  said(verifyToken(token({ tsa, digest: HEX, signedAttrs: false }), { digest: DIGEST, ca: tsa.ca }), 'no signed attributes');
});

check('signed attributes that do not cover the content are the lifted-signature attack', () => {
  const wrong = token({ tsa, digest: HEX, messageDigest: crypto.createHash('sha256').update('a different TSTInfo').digest() });
  said(verifyToken(wrong, { digest: DIGEST, ca: tsa.ca }), 'not the digest of the content it is attached to');
});

check('a signed contentType that is not a TSTInfo is refused', () => {
  said(verifyToken(token({ tsa, digest: HEX, contentType: '1.2.840.113549.1.7.1' }), { digest: DIGEST, ca: tsa.ca }), 'a timestamp signs a TSTInfo');
});

check('SHA-1 is refused by name, because a digest two documents can share is not a receipt', () => {
  const weak = token({ tsa, digest: crypto.createHash('sha1').update('x').digest('hex').padEnd(40, '0'), imprintAlgorithm: OID.sha1 });
  said(verifyToken(weak, { ca: tsa.ca }), 'SHA-1');
});

check('a token that answers somebody else’s request is caught by the nonce', () => {
  const mine = Buffer.from('cafebabe', 'hex');
  const theirs = Buffer.from('deadbeef', 'hex');
  said(verifyToken(token({ tsa, digest: HEX, nonce: theirs }), { digest: DIGEST, ca: tsa.ca, nonce: mine }), 'it answers somebody else');
});

check('a token carrying no certificate, with none supplied, verifies against nothing', () => {
  said(verifyToken(token({ tsa, digest: HEX, certs: [] }), { digest: DIGEST, ca: tsa.ca }), 'nothing to verify it against');
});

check('the certificate can be supplied separately when the token does not carry one', () => {
  const bare = token({ tsa, digest: HEX, certs: [] });
  const v = verifyToken(bare, { digest: DIGEST, ca: tsa.ca, signer: tsa.signer.x509 });
  assert.deepEqual(v.problems, []);
});

check('a refusal from the authority is read as a refusal rather than as a token', () => {
  const resp = parseResponse(response({ status: 2, text: 'the policy does not permit this' }));
  assert.equal(resp.granted, false);
  assert.equal(resp.token, null);
  assert.equal(resp.statusText, 'the policy does not permit this');
  const granted = parseResponse(response({ tokenBytes: good }));
  assert.equal(granted.granted, true);
  assert.deepEqual(verifyToken(granted.token, { digest: DIGEST, ca: tsa.ca }).problems, []);
});

/* ------------------------------------------------------- a strict decoder */

check('an indefinite length is BER and is refused', () => {
  assert.throws(() => parse(Buffer.from([0x30, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00])), /indefinite length/);
});

check('a length written the long way when the short way would do is a second spelling', () => {
  assert.throws(() => parse(Buffer.from([0x30, 0x81, 0x03, 0x02, 0x01, 0x01])), /fits in the short form/);
  assert.throws(() => parse(Buffer.from([0x30, 0x82, 0x00, 0x03, 0x02, 0x01, 0x01])), /padded with a leading zero/);
});

check('bytes after the outermost element are a second document behind the first', () => {
  const doc = seq(integer(1));
  assert.throws(() => parse(Buffer.concat([doc, Buffer.from([0x05, 0x00])])), /after the outermost element/);
});

check('an element that runs past its parent is refused', () => {
  assert.throws(() => parse(Buffer.from([0x30, 0x03, 0x02, 0x05, 0x01])), /past the end|past its parent/);
});

check('a padded integer is refused, for the same reason a padded length is', () => {
  const padded = tlv(0x30, tlv(0x02, Buffer.from([0x00, 0x01])));
  assert.throws(() => parseToken(padded), /.+/);
  assert.equal(integer(Buffer.from([0x00, 0x00, 0x7f])).toString('hex'), '02017f', 'and the writer never produces one');
});

check('a token that is not a signedData is refused before anything is checked', () => {
  const notCms = seq(oid('1.2.840.113549.1.7.1'), tlv(0xa0, seq(integer(1))));
  said(verifyToken(notCms, { digest: DIGEST, ca: tsa.ca }), 'could not be read');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
