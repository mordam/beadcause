/**
 * DER — the encoding an RFC 3161 timestamp arrives in, read strictly and written plainly.
 *
 * A timestamp token from a certificate authority is a CMS structure and there is no way
 * to check one without decoding ASN.1. Node ships no decoder, this repo has no
 * dependency it would be willing to take for one, and a dependency is the wrong shape
 * anyway: the code that decides whether a receipt is genuine is code an auditor may
 * reasonably want to read end to end, and 200 lines of tags and lengths is readable in
 * an afternoon in a way that a general-purpose ASN.1 library is not.
 *
 * **Strict on the way in, and that is the whole design.** BER lets the same value be
 * written several ways — indefinite lengths, a length padded with leading zeros, an
 * integer with a redundant leading byte — and DER picks exactly one of each. A decoder
 * that accepts the others is not being generous; it is accepting two byte strings as the
 * same token, and a signature covers bytes. So every relaxation here is a way for
 * somebody to hand two different documents to two different verifiers and have both say
 * yes. This one refuses:
 *
 * - the indefinite length (`0x80`), which has no end and no place in DER;
 * - a long-form length that would have fitted in the short form, or that carries leading
 *   zero bytes, because either is a second spelling of a number already spelled;
 * - content that runs past the end of its parent, and trailing bytes after the outermost
 *   value, which is where a second document gets smuggled in behind the first;
 * - an INTEGER that is empty or padded, for the same reason a length is.
 *
 * **Offsets are kept, and that matters more than it looks.** Verifying CMS means hashing
 * and signing over *the exact bytes as they arrived* — the encapsulated content, the
 * signed attributes — never over a re-encoding of what they decoded to. `node.bytes` is
 * the whole element and `node.value` its content, both views into the original buffer,
 * so a verifier can always reach for the original rather than reconstruct it. Re-encoding
 * before verifying is the classic way to be right about a document nobody sent.
 *
 * The writer is the small half. It exists because a timestamp *request* has to be built,
 * and because a suite that cannot mint a token cannot prove the verifier refuses a bad
 * one — see `test/helpers/tsa.mjs`, which builds a certificate authority out of these
 * same primitives so the RFC 3161 checks run against something real and offline.
 *
 * A leaf: no imports at all. lib/timestamp.js is the only caller in the repo, and this
 * file knows nothing about timestamps.
 */

/* --------------------------------------------------------------------- tags */

export const TAG = Object.freeze({
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  PRINTABLE: 0x13,
  IA5: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
});

/** A context-specific tag: `[n]` constructed, or the primitive form for an implicit one. */
export const context = (n, constructed = true) => (constructed ? 0xa0 : 0x80) | n;

/* ------------------------------------------------------------------ writing */

/** A length in the one form DER allows for it. */
export function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Tag, length, value — the whole encoding, in one line. */
export function tlv(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), encodeLength(v.length), v]);
}

export const seq = (...items) => tlv(TAG.SEQUENCE, Buffer.concat(items.flat()));
export const set = (...items) => tlv(TAG.SET, Buffer.concat(items.flat()));
export const octet = (buf) => tlv(TAG.OCTET_STRING, buf);
export const nul = () => tlv(TAG.NULL, Buffer.alloc(0));
export const bool = (v) => tlv(TAG.BOOLEAN, Buffer.from([v ? 0xff : 0x00]));
export const utf8 = (s) => tlv(TAG.UTF8, Buffer.from(String(s), 'utf8'));
export const printable = (s) => tlv(TAG.PRINTABLE, Buffer.from(String(s), 'ascii'));
export const ia5 = (s) => tlv(TAG.IA5, Buffer.from(String(s), 'ascii'));

/** `[n] { … }` — an explicit context tag wrapping whole elements. */
export const explicit = (n, ...items) => tlv(0xa0 | n, Buffer.concat(items.flat()));

/** An INTEGER, minimally encoded, non-negative — the only kind anything here writes. */
export function integer(value) {
  let bytes;
  if (Buffer.isBuffer(value)) bytes = [...value];
  else {
    const n = BigInt(value);
    if (n < 0n) throw new RangeError('this writer encodes non-negative integers only');
    bytes = n === 0n ? [0] : [];
    for (let v = n; v > 0n; v /= 256n) bytes.unshift(Number(v % 256n));
  }
  while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80)) bytes.shift();
  if (bytes[0] & 0x80) bytes.unshift(0); // unsigned, so a high bit needs a leading zero
  return tlv(TAG.INTEGER, Buffer.from(bytes));
}

/** A BIT STRING with no unused bits, which is every bit string this repo writes. */
export const bitString = (buf) => tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([0]), buf]));

/** An OBJECT IDENTIFIER from its dotted form. */
export function oid(dotted) {
  const parts = String(dotted).split('.').map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isSafeInteger(p) || p < 0)) throw new RangeError(`not an object identifier: ${dotted}`);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part % 128];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v % 128) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

/** A GeneralizedTime, UTC and to the second — the form DER pins and X.509 uses. */
export function generalizedTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const s = d.toISOString().replace(/[-:T]/g, '').replace(/\.\d+/, '');
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(s, 'ascii'));
}

/**
 * A UTCTime — two-digit year, which is the form X.509 pins for any date before 2050 and
 * the only one some parsers will read in a certificate's validity. Nothing else in this
 * repo writes one; certificates are the exception, and they are the exception everywhere.
 */
export function utcTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (d.getUTCFullYear() >= 2050) return generalizedTime(d);
  const s = d.toISOString().slice(2).replace(/[-:T]/g, '').replace(/\.\d+/, '');
  return tlv(TAG.UTC_TIME, Buffer.from(s, 'ascii'));
}

/* ------------------------------------------------------------------ reading */

/**
 * One element, decoded — and every field but `children` is an offset into the buffer
 * you passed, so the caller can always get back to the bytes that actually arrived.
 */
function element(buf, pos, depth) {
  if (depth > 40) throw new Error('DER nested past any depth a certificate has');
  if (pos + 2 > buf.length) throw new Error(`truncated element at offset ${pos}`);
  const tag = buf[pos];
  if ((tag & 0x1f) === 0x1f) throw new Error(`multi-byte tag at offset ${pos}, which nothing here uses`);

  const first = buf[pos + 1];
  let length;
  let headerLen;
  if (first === 0x80) throw new Error(`indefinite length at offset ${pos}, which is BER and not DER`);
  if (first < 0x80) {
    length = first;
    headerLen = 2;
  } else {
    const n = first & 0x7f;
    if (n > 4) throw new Error(`length of ${n} bytes at offset ${pos}, which is longer than anything real`);
    if (pos + 2 + n > buf.length) throw new Error(`truncated length at offset ${pos}`);
    if (buf[pos + 2] === 0x00) throw new Error(`length padded with a leading zero at offset ${pos}, which is a second spelling of a number`);
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[pos + 2 + i];
    if (length < 0x80) throw new Error(`long-form length of ${length} at offset ${pos}, which fits in the short form`);
    headerLen = 2 + n;
  }

  const start = pos + headerLen;
  const end = start + length;
  if (end > buf.length) throw new Error(`element at offset ${pos} runs ${end - buf.length} byte(s) past the end`);

  const node = {
    tag,
    constructed: Boolean(tag & 0x20),
    start: pos,
    contentStart: start,
    end,
    bytes: buf.subarray(pos, end),
    value: buf.subarray(start, end),
    children: null,
  };
  if (node.constructed) {
    node.children = [];
    let p = start;
    while (p < end) {
      const child = element(buf, p, depth + 1);
      if (child.end > end) throw new Error(`a child at offset ${p} runs past its parent`);
      node.children.push(child);
      p = child.end;
    }
  }
  return node;
}

/** Decode one DER document. Trailing bytes are a refusal, not a remainder. */
export function parse(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const node = element(b, 0, 0);
  if (node.end !== b.length) throw new Error(`${b.length - node.end} byte(s) after the outermost element, which is a second document behind the first`);
  return node;
}

/** The nth child, refusing rather than returning undefined — a decoder that guesses lies. */
export function child(node, i) {
  const kids = node?.children;
  if (!kids || i >= kids.length) throw new Error(`expected at least ${i + 1} element(s) here, and there ${kids ? `are ${kids.length}` : 'is no sequence'}`);
  return kids[i];
}

/** The first child carrying this tag, or null. */
export const tagged = (node, tag) => (node?.children || []).find((c) => c.tag === tag) || null;

/** An OBJECT IDENTIFIER back in its dotted form. */
export function oidOf(node) {
  if (node?.tag !== TAG.OID) throw new Error('not an object identifier');
  const v = node.value;
  if (!v.length) throw new Error('an empty object identifier');
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  let acc = 0;
  for (let i = 1; i < v.length; i++) {
    if (acc === 0 && v[i] === 0x80) throw new Error('an object identifier arc padded with a leading zero');
    acc = acc * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) {
      parts.push(acc);
      acc = 0;
    }
  }
  if (acc !== 0) throw new Error('an object identifier that ends mid-arc');
  return parts.join('.');
}

/** An INTEGER as a BigInt, refusing the paddings DER already refused. */
export function integerOf(node) {
  if (node?.tag !== TAG.INTEGER) throw new Error('not an integer');
  const v = node.value;
  if (!v.length) throw new Error('an empty integer');
  if (v.length > 1 && ((v[0] === 0x00 && !(v[1] & 0x80)) || (v[0] === 0xff && v[1] & 0x80))) throw new Error('an integer padded with a redundant leading byte');
  let n = 0n;
  const negative = Boolean(v[0] & 0x80);
  for (const byte of v) n = n * 256n + BigInt(negative ? byte ^ 0xff : byte);
  return negative ? -(n + 1n) : n;
}

/** A serial number the way `crypto.X509Certificate` prints one: uppercase hex, unpadded. */
export function serialOf(node) {
  const hex = integerOf(node).toString(16).toUpperCase();
  return hex.length % 2 ? `0${hex}` : hex;
}

/**
 * A GeneralizedTime as an ISO instant.
 *
 * DER pins the form: UTC, seconds present, `Z`, and any fraction without trailing zeros.
 * Anything else is refused rather than guessed at, because a timestamp is the one field
 * in a receipt whose whole job is to be unambiguous, and a decoder that quietly reads a
 * local time as UTC has changed the fact it was checking.
 */
export function timeOf(node) {
  if (node?.tag !== TAG.GENERALIZED_TIME) throw new Error('not a generalized time');
  const s = node.value.toString('ascii');
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{1,3}\d*)?Z$/.exec(s);
  if (!m) throw new Error(`"${s}" is not a UTC generalized time, and a local time is not a fact`);
  const [, y, mo, d, h, mi, sec, frac] = m;
  const ms = frac ? Math.round(Number(frac) * 1000) : 0;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), ms);
  if (!Number.isFinite(t)) throw new Error(`"${s}" is not a date`);
  const iso = new Date(t).toISOString();
  return frac ? iso : iso.replace('.000', '');
}
