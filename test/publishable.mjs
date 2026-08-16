#!/usr/bin/env node
//
// The service holds hashes, chain heads and metadata — never content. `lib/publishable.js`.
//
//   npm test
//   node test/publishable.mjs
//
// bc-3muu.1: the central service is the anchor a local evidence chain cannot be for
// itself — a rewritten history is perfectly intact, so only a head recorded somewhere
// the rewrite cannot reach can tell you it is not the history that was there in March.
// That is worth building. What makes it worth *hosting* is the boundary this suite is
// about: the moment a head can leave the Mac, everything else could leave with it, and
// a payload is easy to widen and impossible to narrow.
//
// Four separable jobs here, and the second is the one that would otherwise never be
// exercised:
//
//   1. Nothing carrying content can be published — under its own name, under an
//      innocent one, or as a paragraph in a field that is allowed to exist. The
//      allowlist is the guarantee and the denylist is the error message; both are
//      checked, because a suite that only tests the denylist is testing the decoration.
//   2. The rule that keeps the *table* honest is proved against a deliberately bad
//      table. `tableProblems` runs over `FIELDS` at import and the real table passes,
//      which tells you nothing about whether it could ever fail — so it is pointed at
//      a table minting `notes`, at one claiming a type that is not a shape, and at one
//      colliding with the envelope.
//   3. A continuity claim is provable from what the service holds and nothing else. A
//      record edited, removed, reordered or attributed to another instance breaks a
//      link that arithmetic finds, with no repository and no content in hand.
//   4. There is no free-text shape, and there is deliberately no way to add one. Every
//      type in the closed set is shown to reject an ordinary English sentence.
import assert from 'node:assert/strict';

import {
  CONTENT_FIELDS,
  CRITERION_STATES,
  ENVELOPE,
  FIELDS,
  KINDS,
  MAX_STRING,
  TYPES,
  chainHeadFields,
  digest,
  genesis,
  head,
  linkProblems,
  next,
  now,
  problemsWith,
  record,
  recordDigest,
  tableProblems,
} from '../lib/publishable.js';

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

console.log('what may be published\n');

const SHA = 'e48897577a8d08ad560608e7551bd02f43d98110';
const INSTANCE = 'air-2f1c9b';
const AT = '2026-08-15T17:48:35.000Z';

const enrolment = () => genesis(INSTANCE, 'enrolment', { fingerprint: digest('a public key'), org: 'climative' }, { at: AT });
const chainHead = (prev, at = '2026-08-15T18:00:00.000Z') =>
  next(prev, 'chain-head', chainHeadFields({ ref: 'refs/notes/beadcause', head: SHA, length: 7863, linear: true, intact: true, why: null }), { at });

/* ------------------------------------------------------------------ the table */

check('the published vocabulary is sound', () => {
  assert.deepEqual(tableProblems(FIELDS), []);
});

check('every kind mints at least one field, and the kinds are the table', () => {
  assert.ok(KINDS.length >= 4, `only ${KINDS.length} kinds — that is not this system`);
  for (const kind of KINDS) assert.ok(Object.keys(FIELDS[kind]).length > 0, `${kind} carries nothing`);
  assert.deepEqual(KINDS, Object.keys(FIELDS));
});

check('no field the table mints is a content field', () => {
  const names = [...Object.keys(ENVELOPE), ...KINDS.flatMap((k) => Object.keys(FIELDS[k]))];
  for (const name of names) {
    assert.ok(!CONTENT_FIELDS.includes(name), `the table mints ${name}, which is content`);
  }
});

check('a table minting a content field fails, rather than being caught in review', () => {
  const problems = tableProblems({ criterion: { control: 'control', notes: 'token' } });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /criterion\.notes is content/);
});

check('a table claiming a type that is not a shape fails', () => {
  const problems = tableProblems({ thing: { blob: 'freetext' } });
  assert.match(problems.join('\n'), /claims the type "freetext"/);
});

check('a table colliding with the envelope fails', () => {
  const problems = tableProblems({ thing: { seq: 'count' } });
  assert.match(problems.join('\n'), /collides with the envelope/);
});

check('an empty table fails rather than publishing nothing quietly', () => {
  assert.match(tableProblems({}).join('\n'), /mints no kinds/);
});

/* -------------------------------------------------------- there is no free text */

check('no shape in the closed set accepts an English sentence', () => {
  const sentence = 'Adam asked whether the deploy should wait for the settle window.';
  for (const [name, type] of Object.entries(TYPES)) {
    assert.equal(type.ok(sentence), false, `the type "${name}" accepts prose, which makes it a content field`);
  }
});

check('no shape accepts a paragraph, a newline, or a blob', () => {
  const paragraph = 'x'.repeat(MAX_STRING * 3);
  for (const [name, type] of Object.entries(TYPES)) {
    assert.equal(type.ok(paragraph), false, `the type "${name}" accepts ${paragraph.length} characters`);
    assert.equal(type.ok('one\ntwo'), false, `the type "${name}" accepts a value spanning lines`);
    assert.equal(type.ok({ text: 'hello' }), false, `the type "${name}" accepts a structure`);
  }
});

check('a criterion state is one of three, and unverified is its own answer', () => {
  assert.deepEqual([...CRITERION_STATES].sort(), ['met', 'unmet', 'unverified']);
  assert.equal(TYPES.state.ok('unverified'), true);
  assert.equal(TYPES.state.ok('probably'), false);
});

/* ----------------------------------------------------------------- the boundary */

check('no record carrying content of any named kind can be built', () => {
  for (const name of CONTENT_FIELDS) {
    const rec = { ...enrolment(), [name]: 'anything at all' };
    const problems = problemsWith(rec);
    assert.equal(problems.length, 1, `${name}: ${problems.join(', ')}`);
    assert.match(problems[0], new RegExp(`^${name} is content`), `${name} was not refused as content`);
  }
});

check('bead text, prompt content, file contents and a screenshot are each refused', () => {
  const payloads = {
    text: 'The boundary that decides whether this service is defensible.',
    prompt: 'You are working bead bc-3muu.1.',
    contents: 'export function digest(value) {',
    screenshot: 'data:image/png;base64,iVBORw0KGgo=',
  };
  for (const [name, value] of Object.entries(payloads)) {
    assert.throws(
      () => record('enrolment', { instance: INSTANCE, seq: 0, at: AT, prev: null }, { fingerprint: digest('k'), org: 'climative', [name]: value }),
      new RegExp(`${name} is content`),
      `${name} was accepted`,
    );
  }
});

check('a field nobody minted is refused whatever it is called', () => {
  const problems = problemsWith({ ...enrolment(), musings: 'a rename of notes' });
  assert.deepEqual(problems, ['musings is not a field the service holds — the vocabulary is closed']);
});

check('the vocabulary does not admit the prototype chain', () => {
  // `'constructor' in FIELDS` is true of every plain object, so a membership test
  // written with `in` mints three kinds and half a dozen fields nobody wrote down.
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const problems = problemsWith({ ...enrolment(), [name]: 'a whole paragraph of bead text' });
    assert.ok(problems.length >= 1, `${name} was admitted as a field`);
  }
  for (const kind of ['constructor', 'toString', 'valueOf']) {
    assert.match(problemsWith({ ...enrolment(), kind }).join('\n'), /is not a kind of record/, `${kind} was admitted as a kind`);
  }
});

check('content cannot be smuggled under a name that is allowed', () => {
  const sentence = { ...chainHead(enrolment()), ref: 'refs/notes/the question Adam asked about the deploy' };
  assert.match(problemsWith(sentence).join('\n'), /ref must be a ref path/);

  const long = { ...chainHead(enrolment()), ref: 'refs/' + 'a'.repeat(MAX_STRING) };
  assert.match(problemsWith(long).join('\n'), new RegExp(`ref is ${MAX_STRING + 5} characters`));

  const prose = { ...enrolment(), org: 'the workspace Adam shares with the rest of the team' };
  assert.match(problemsWith(prose).join('\n'), /org must be an opaque identifier/);
});

check('a value that spans lines, runs long, or is a structure is refused', () => {
  const base = enrolment();
  assert.match(problemsWith({ ...base, org: 'one\ntwo' }).join('\n'), /org must be|spans lines/);
  assert.match(problemsWith({ ...base, org: { name: 'climative' } }).join('\n'), /is a structure/);
  assert.match(problemsWith({ ...base, org: 'x'.repeat(MAX_STRING + 1) }).join('\n'), /characters|opaque identifier/);
});

check('a record of a kind the service does not hold is refused, and says which it holds', () => {
  const problems = problemsWith({ ...enrolment(), kind: 'session' });
  assert.equal(problems.length, 1);
  for (const kind of KINDS) assert.match(problems[0], new RegExp(kind));
});

check('a record missing its envelope is refused field by field', () => {
  const problems = problemsWith({ kind: 'enrolment', fingerprint: digest('k'), org: 'climative' });
  for (const name of Object.keys(ENVELOPE)) {
    assert.match(problems.join('\n'), new RegExp(`^${name} is missing`, 'm'), `${name} was not missed`);
  }
});

check('a kind missing one of its own fields is refused', () => {
  const rec = { ...enrolment() };
  delete rec.org;
  assert.deepEqual(problemsWith(rec), ['enrolment is missing org']);
});

check('what is not a record at all says so', () => {
  for (const v of [null, undefined, 'a string', 42, ['a', 'list']]) assert.deepEqual(problemsWith(v), ['not a record']);
});

check('nothing published is longer than the limit, on a real record', () => {
  for (const rec of [enrolment(), chainHead(enrolment())]) {
    for (const [name, value] of Object.entries(rec)) {
      if (typeof value !== 'string') continue;
      assert.ok(value.length <= MAX_STRING, `${name} is ${value.length} characters`);
    }
  }
});

/* --------------------------------------------------------------------- hashing */

check('a digest is stable across property order', () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
});

check('a digest changes when anything does', () => {
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
  assert.notEqual(digest('the record'), digest('the record '));
});

check('bytes and structure are separate domains', () => {
  assert.notEqual(digest(Buffer.from('"hello"')), digest('hello'));
});

check('a digest discloses nothing and is the shape the table accepts', () => {
  const d = digest('the entire text of a bead');
  assert.equal(TYPES.digest.ok(d), true);
  assert.ok(!d.includes('bead'), 'the digest carries the thing it stands for');
  assert.equal(d.length, 'sha256:'.length + 64);
});

check('digesting nothing is a bug rather than a value', () => {
  assert.throws(() => digest(undefined), /nothing to digest/);
});

/* ------------------------------------------------------------------- the chain */

check('a chain is built rather than asserted, and its links are derived', () => {
  const a = enrolment();
  const b = chainHead(a);
  assert.equal(a.seq, 0);
  assert.equal(a.prev, null);
  assert.equal(b.seq, 1);
  assert.equal(b.prev, recordDigest(a));
  assert.deepEqual(linkProblems([a, b]), []);
});

check('a record is frozen once built', () => {
  const a = enrolment();
  assert.throws(() => {
    a.org = 'somewhere else';
  }, TypeError);
});

check('the first record cannot name a predecessor, and a later one must', () => {
  assert.match(problemsWith({ ...enrolment(), prev: digest('x') }).join('\n'), /the first record of a chain has no predecessor/);
  assert.match(problemsWith({ ...chainHead(enrolment()), prev: null }).join('\n'), /must name the one before it/);
});

check('next() refuses to start a chain, and genesis() refuses to continue one', () => {
  assert.throws(() => next(null, 'chain-head', {}), /genesis/);
  const a = enrolment();
  assert.throws(() => next({ ...a, org: 'a sentence that is not a token' }, 'chain-head', {}), /previous record is not publishable/);
});

check('an edited record breaks the link that follows it', () => {
  const a = enrolment();
  const b = chainHead(a);
  const forged = { ...a, at: '2026-08-15T17:48:36.000Z' };
  const problems = linkProblems([forged, b]);
  assert.match(problems.join('\n'), /names sha256:.* as its predecessor/);
});

check('a record removed from the middle is found twice over', () => {
  const a = enrolment();
  const b = chainHead(a);
  const c = next(b, 'criterion', { control: 'SOC2.CC7.2', state: 'met', evidence: digest('an evidence record') }, { at: '2026-08-15T19:00:00.000Z' });
  const problems = linkProblems([a, c]);
  assert.match(problems.join('\n'), /seq jumps from 0 to 2 — 1 record\(s\) are not here/);
  assert.match(problems.join('\n'), /as its predecessor/);
});

check('a chain belongs to one instance', () => {
  const a = enrolment();
  const b = { ...chainHead(a), instance: 'another-mac' };
  assert.match(linkProblems([a, b]).join('\n'), /a chain belongs to one instance/);
});

check('a chain that runs backwards says so', () => {
  const a = enrolment();
  const b = chainHead(a, '2026-08-15T17:00:00.000Z');
  assert.match(linkProblems([a, b]).join('\n'), /is stamped before/);
});

check('a record that is not publishable is not a link either', () => {
  const problems = linkProblems([{ kind: 'enrolment' }]);
  assert.match(problems.join('\n'), /record 0 is not publishable/);
});

check('no records is no claim', () => {
  assert.deepEqual(linkProblems([]), ['no records, so nothing is claimed']);
  assert.deepEqual(linkProblems(null), ['no records, so nothing is claimed']);
  assert.equal(head([]), null);
});

check('the head of a chain is what a later claim is checked against', () => {
  const a = enrolment();
  const b = chainHead(a);
  assert.deepEqual(head([a, b]), { instance: INSTANCE, seq: 1, at: b.at, digest: recordDigest(b) });
});

/* ------------------------------------------------------- the bridge to evidence */

check('a verified ref crosses as five fields and nothing else', () => {
  const verify = { ref: 'refs/notes/beadcause', head: SHA, length: 7863, linear: true, intact: true, anchored: null, why: 'no such ref' };
  const fields = chainHeadFields(verify);
  assert.deepEqual(Object.keys(fields).sort(), Object.keys(FIELDS['chain-head']).sort());
  assert.ok(!('why' in fields), 'prose crossed the boundary');
  assert.ok(!('anchored' in fields), 'a field nobody minted crossed the boundary');
});

check('a ref that did not verify crosses as false rather than as undefined', () => {
  const fields = chainHeadFields({ ref: 'refs/notes/beadcause', head: SHA, length: 0, linear: false, intact: false });
  assert.equal(fields.linear, false);
  assert.equal(fields.intact, false);
});

check('an instant is written the one way `at` accepts', () => {
  assert.equal(TYPES.at.ok(now(new Date(Date.parse(AT)))), true);
  assert.equal(TYPES.at.ok('2026-08-15 17:48:35'), false, 'a local-time stamp is not a fact');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
