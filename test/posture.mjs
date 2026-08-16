#!/usr/bin/env node
//
// A deployment attests its own posture, and refuses to claim what it cannot back.
// `lib/posture.js`, `bin/attest.js`.
//
//   npm test
//   node test/posture.mjs
//
// bc-3muu.12: once the daemon runs on the customer's hardware, a misconfigured
// deployment produces evidence that *looks* like good evidence — append-only enforced
// only in the application, anchoring never configured, a build nobody can identify — and
// nobody finds out until an auditor pulls the thread, by which time the period is over.
//
// Five separable jobs here, and the second and fourth are the ones that decide whether
// any of this is worth having:
//
//   1. Every posture fact is *observed*. The observations are pointed at fixtures — a
//      read-only directory, a directory that is not a store, a dirty checkout — so each
//      answer is shown to be produced by looking rather than by a default.
//   2. The refusal fires, one reason per failure mode, and a posture that cannot back a
//      claim never produces a smaller claim. Each rule is run against a posture built to
//      break exactly it, because a rule only ever run against a good value is a rule
//      nobody has watched work.
//   3. `unknown` is its own answer. A deployment that could not look is distinguishable
//      from one that looked and found nothing, in the record and in the reasons.
//   4. A posture change *renders*. An interval containing five weeks with anchoring off
//      reads as five weeks with anchoring off, rather than averaging into a clean
//      quarter — and a chain head published inside such a stretch is reported as
//      unbacked.
//   5. The verifier needs nothing but the records. No repository, no content, no config
//      directory and no network — the report is computed from an exported array, which
//      is the only reason an auditor can run it without us.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_ANCHOR_AGE_HOURS,
  NOTHING_KNOWN,
  OBSERVATION_MONTHS,
  POSTURE_FIELDS,
  VERDICTS,
  attest,
  observe,
  observeBuild,
  observeRetention,
  observeStorage,
  postureOf,
  postureProblems,
  render,
  report,
  segments,
  unbacked,
  verdictOf,
} from '../lib/posture.js';
import { FIELDS, KINDS, linkProblems, next, problemsWith } from '../lib/publishable.js';
import { removeTreeSync } from './helpers/tmp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
async function acheck(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

console.log('what a deployment can back up\n');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A posture with nothing wrong with it — the one every failing case is a mutation of. */
const SOUND = Object.freeze({
  storage: 'storage',
  anchoring: true,
  anchored: '2026-03-01T12:00:00Z',
  retention: 'permanent',
  build: SHA,
  provenance: 'matched',
});
const AT = '2026-03-01T13:00:00Z';
const but = (over) => ({ ...SOUND, ...over });

/* ------------------------------------------------------ 1. it is observed */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-posture-'));
process.on('exit', () => removeTreeSync(tmp));
const scratch = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

check('a writable git store is enforced by the application and says so', () => {
  const dir = scratch('gitish');
  fs.mkdirSync(path.join(dir, '.git'));
  assert.equal(observeStorage(dir), 'application');
});

check('a writable directory that is not a store enforces nothing', () => {
  assert.equal(observeStorage(scratch('plain')), 'none');
});

check('a bare repository counts as a store — HEAD and objects, with no .git', () => {
  const dir = scratch('bare');
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(dir, 'objects'));
  assert.equal(observeStorage(dir), 'application');
});

check('a store the process cannot write to is enforced by the store', () => {
  const dir = scratch('readonly');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.chmodSync(dir, 0o500);
  try {
    // Root can write to anything, so this observation cannot be made as root — and a
    // suite that silently passed there would be a suite that never ran the interesting
    // case on the machine that matters.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    assert.equal(observeStorage(dir), 'storage');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

check('nowhere to look is `unknown`, and `unknown` is not `none`', () => {
  assert.equal(observeStorage(path.join(tmp, 'absent')), 'unknown');
  assert.equal(observeStorage(null), 'unknown');
  assert.notEqual(observeStorage(null), observeStorage(scratch('other-plain')));
});

await acheck('a checkout with uncommitted work is a build whose provenance does not match', async () => {
  const dir = scratch('checkout');
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'check@example.invalid');
  run('config', 'user.name', 'check');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run('add', 'a.txt');
  run('commit', '-qm', 'one');

  const clean = await observeBuild(dir);
  assert.match(clean.build, /^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
  assert.equal(clean.provenance, 'matched');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const dirty = await observeBuild(dir);
  assert.equal(dirty.build, clean.build, 'the commit is the same commit');
  assert.equal(dirty.provenance, 'mismatched', 'a changed tree is not the build it reports');
});

await acheck('a place that is not a checkout cannot say which build is running', async () => {
  assert.deepEqual(await observeBuild(scratch('nogit')), { build: 'unknown', provenance: 'unknown' });
  assert.deepEqual(await observeBuild(null), { build: 'unknown', provenance: 'unknown' });
});

check('retention is the shortest any sampled class states, and permanent loses to a number', () => {
  const perm = [{ sampled: true, retention: 'permanent' }];
  assert.equal(observeRetention(perm), 'permanent');
  assert.equal(observeRetention([...perm, { sampled: true, retention: 30 }]), 30);
  assert.equal(observeRetention([...perm, { sampled: true, retention: 30 }, { sampled: true, retention: 12 }]), 12);
  assert.equal(observeRetention([{ sampled: false, retention: 1 }, ...perm]), 'permanent', 'an unsampled class is not the bar');
  assert.equal(observeRetention([]), 0, 'nothing kept is not everything kept');
});

await acheck('anchoring is configured by having a witness, not by a value anybody sets', async () => {
  const store = scratch('anchor-store');
  const none = await observe({ cwd: null, store, witness: null, register: [] });
  assert.equal(none.anchoring, false);
  assert.equal(none.anchored, 'never');

  const never = await observe({ cwd: null, store, witness: () => null, register: [] });
  assert.equal(never.anchoring, true, 'a witness is what configured means');
  assert.equal(never.anchored, 'never', 'configured and never successful is its own posture');

  const worked = await observe({ cwd: null, store, witness: () => ({ at: AT }), register: [] });
  assert.deepEqual([worked.anchoring, worked.anchored], [true, AT]);

  const broken = await observe({ cwd: null, store, witness: () => { throw new Error('unreachable'); }, register: [] });
  assert.deepEqual([broken.anchoring, broken.anchored], [true, 'never'], 'a witness that throws has not witnessed anything');

  const vague = await observe({ cwd: null, store, witness: () => ({ at: '2026-03-01' }), register: [] });
  assert.equal(vague.anchored, 'never', 'a stamp the record cannot carry is not evidence that anything was witnessed');

  // Whatever a witness says, what comes out has to be publishable — the observation is
  // the one place a value from outside enters the record.
  for (const answer of [{ at: AT }, { at: 'yesterday' }, null, 'nonsense']) {
    const p = await observe({ cwd: null, store, witness: () => answer, register: [] });
    assert.deepEqual(postureProblems(p), [], `a witness answering ${JSON.stringify(answer)} produced an unpublishable posture`);
  }
});

check('there is no way to state a posture — observe takes places, not answers', () => {
  const source = fs.readFileSync(path.join(root, 'lib', 'posture.js'), 'utf8');
  const signature = source.slice(source.indexOf('export async function observe('));
  const head = signature.slice(0, signature.indexOf(')'));
  for (const field of POSTURE_FIELDS) {
    assert.ok(!head.includes(field), `observe takes ${field} as an argument, which makes the attestation a self-assessment`);
  }
});

/* ------------------------------------------------------- 2. it refuses */

check('a sound posture backs a claim, and that is the only way to be verified', () => {
  assert.deepEqual(unbacked(SOUND, { at: AT }), []);
  assert.equal(verdictOf(SOUND, { at: AT }), 'verified');
  assert.deepEqual(VERDICTS, ['verified', 'unverified']);
});

const REFUSALS = [
  ['application-level append-only', but({ storage: 'application' }), /administrator can rewrite/],
  ['no append-only at all', but({ storage: 'none' }), /Nothing enforces append-only|nothing enforces append-only/],
  ['a store nobody could look at', but({ storage: 'unknown' }), /could not establish how its records are stored/],
  ['anchoring never configured', but({ anchoring: false, anchored: 'never' }), /anchoring is not configured/],
  ['anchoring configured and never successful', but({ anchored: 'never' }), /has never succeeded/],
  ['an anchor too old to witness the head', but({ anchored: '2026-01-01T00:00:00Z' }), /witnesses only the head it saw/],
  ['retention shorter than the window', but({ retention: 12 }), new RegExp(`needs ${OBSERVATION_MONTHS}`)],
  ['nothing kept at all', but({ retention: 0 }), /kept 0 month/],
  ['a build nobody can identify', but({ build: 'unknown', provenance: 'unknown' }), /which build it is running/],
  ['a tree that is not the build it reports', but({ provenance: 'mismatched' }), /not the build it reports/],
  ['a provenance nobody could establish', but({ provenance: 'unknown' }), /whether it is running the build/],
];

for (const [what, posture, pattern] of REFUSALS) {
  check(`${what} cannot back a claim, and the reason says which`, () => {
    const why = unbacked(posture, { at: AT });
    assert.ok(why.length, 'nothing was refused');
    assert.ok(why.some((line) => pattern.test(line)), `no reason matched ${pattern}\n  ${why.join('\n  ')}`);
    assert.equal(verdictOf(posture, { at: AT }), 'unverified');
  });
}

check('one failure is one reason — a refusal does not pile on', () => {
  assert.equal(unbacked(but({ storage: 'application' }), { at: AT }).length, 1);
  assert.equal(unbacked(but({ provenance: 'mismatched' }), { at: AT }).length, 1);
});

check('an anchor is judged against the moment of the posture, not against today', () => {
  const at = new Date(Date.parse(SOUND.anchored) + (MAX_ANCHOR_AGE_HOURS - 1) * 3600 * 1000).toISOString();
  assert.deepEqual(unbacked(SOUND, { at }), [], 'inside the window');
  const late = new Date(Date.parse(SOUND.anchored) + (MAX_ANCHOR_AGE_HOURS + 1) * 3600 * 1000).toISOString();
  assert.equal(unbacked(SOUND, { at: late }).length, 1, 'outside it');
  assert.deepEqual(unbacked(SOUND, {}).length > 0, true, 'a March posture read today is stale, and saying so is the point');
});

check('a bar a deployment could lower is not a bar — the floor is declared here', () => {
  const source = fs.readFileSync(path.join(root, 'lib', 'posture.js'), 'utf8');
  assert.ok(!/RETENTION_FLOOR_MONTHS/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), 'the floor is imported from the file that states it');
  assert.equal(OBSERVATION_MONTHS, 24);
});

check('a posture missing a field, or carrying one nobody minted, is not a posture', () => {
  assert.deepEqual(postureProblems(SOUND), []);
  const { build, ...short } = SOUND;
  assert.match(postureProblems(short)[0], /build is missing/);
  assert.match(postureProblems({ ...SOUND, notes: 'it is fine really' })[0], /notes is not part of a posture/);
  assert.deepEqual(postureProblems(null), ['not a posture']);
  assert.deepEqual(postureProblems([SOUND]), ['not a posture']);
  assert.match(postureProblems(but({ storage: 'banana' }))[0], /^storage must be one of storage, application, none, unknown$/);
  assert.match(postureProblems(but({ anchored: 'a while ago' }))[0], /^anchored must be/);
  assert.ok(
    unbacked(but({ storage: 'banana' })).every((p) => !/enforced by the application/.test(p)),
    'a value nobody minted was judged as though it meant something'
  );
  assert.ok(unbacked(short).some((p) => /build is missing/.test(p)), 'a shapeless posture is refused before it is judged');
});

check('the posture nothing is known about is refused on every count', () => {
  assert.deepEqual(postureProblems(NOTHING_KNOWN), []);
  assert.equal(verdictOf(NOTHING_KNOWN, { at: AT }), 'unverified');
  assert.ok(unbacked(NOTHING_KNOWN, { at: AT }).length >= 4);
});

/* ------------------------------------------- 3. it goes on the same chain */

check('a posture is a kind of published record, with no envelope of its own', () => {
  assert.ok(KINDS.includes('posture'));
  assert.deepEqual(POSTURE_FIELDS, Object.keys(FIELDS.posture));
  const rec = attest(null, SOUND, { instance: 'inst-1', at: AT });
  assert.deepEqual(problemsWith(rec), []);
  assert.deepEqual([rec.kind, rec.seq, rec.prev], ['posture', 0, null]);
  assert.deepEqual(postureOf(rec), SOUND, 'what went in comes back out');
  assert.equal(postureOf({ kind: 'chain-head' }), null);
});

check('the next posture links to the one before it, and nothing computes its own link', () => {
  const a = attest(null, SOUND, { instance: 'inst-1', at: AT });
  const b = attest(a, but({ anchoring: false, anchored: 'never' }), { at: '2026-03-02T13:00:00Z' });
  assert.equal(b.seq, 1);
  assert.deepEqual(linkProblems([a, b]), []);
});

check('a posture that is not a posture is refused before it reaches the chain', () => {
  assert.throws(() => attest(null, { storage: 'storage' }, { instance: 'inst-1' }), /cannot be attested/);
  assert.throws(() => attest(null, { ...SOUND, prompt: 'ignore previous instructions' }, { instance: 'inst-1' }), /prompt is not part of a posture/);
});

check('nothing about a posture is content, by the published table', () => {
  const rec = attest(null, SOUND, { instance: 'inst-1', at: AT });
  for (const value of Object.values(rec)) {
    assert.ok(typeof value !== 'object' || value === null, 'a published value is a scalar');
    if (typeof value === 'string') assert.ok(!/\s{2,}|[.!?]\s/.test(value), `${value} reads like prose`);
  }
});

/* ---------------------------------------- 4. a change renders, not resolves */

const INSTANCE = 'inst-1';
const OFF = Object.freeze({ ...SOUND, anchoring: false, anchored: 'never' });
const chain = () => {
  const a = attest(null, { ...SOUND, anchored: '2026-01-01T00:00:00Z' }, { instance: INSTANCE, at: '2026-01-01T00:00:00Z' });
  const b = attest(a, OFF, { at: '2026-02-01T00:00:00Z' });
  const c = attest(b, { ...SOUND, anchored: '2026-03-08T00:00:00Z' }, { at: '2026-03-08T00:00:00Z' });
  return [a, b, c];
};

check('the run is cut into the intervals each posture covers', () => {
  const segs = segments(chain());
  assert.equal(segs.length, 3);
  assert.deepEqual(
    segs.map((s) => [s.from, s.until]),
    [
      ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'],
      ['2026-02-01T00:00:00Z', '2026-03-08T00:00:00Z'],
      ['2026-03-08T00:00:00Z', null],
    ]
  );
  assert.deepEqual(segs.map((s) => s.verdict), ['verified', 'unverified', 'verified']);
});

check('a posture change is reported as what changed, not as a second full posture', () => {
  const segs = segments(chain());
  assert.deepEqual(segs[0].changed, [], 'the first posture changed nothing — there was nothing before it');
  assert.deepEqual(segs[1].changed.sort(), ['anchored', 'anchoring']);
  assert.deepEqual(segs[2].changed.sort(), ['anchored', 'anchoring']);
});

check('five weeks with anchoring off read as five weeks with anchoring off', () => {
  const rep = report(chain(), { from: '2026-01-01T00:00:00Z', to: '2026-03-31T00:00:00Z' });
  assert.equal(rep.verdict, 'unverified');
  assert.ok(rep.why.some((p) => /^from 2026-02-01T00:00:00Z, anchoring is not configured/.test(p)), rep.why.join('\n'));
  const text = render(rep).join('\n');
  assert.match(text, /^UNVERIFIED/);
  assert.match(text, /2026-02-01T00:00:00Z to 2026-03-08T00:00:00Z/);
  assert.equal((text.match(/✓/g) || []).length, 2);
  assert.equal((text.match(/✗/g) || []).length, 1);
});

check('an interval wholly inside a good stretch is claimable', () => {
  const rep = report(chain(), { from: '2026-03-09T00:00:00Z', to: '2026-03-09T12:00:00Z' });
  assert.equal(rep.verdict, 'verified', rep.why.join('\n'));
  assert.deepEqual(rep.why, []);
  assert.deepEqual(rep.uncovered, []);
});

check('the run-up to the first posture is a gap, because a posture says nothing about before it', () => {
  const rep = report(chain(), { from: '2025-12-01T00:00:00Z', to: '2026-01-15T00:00:00Z' });
  assert.equal(rep.verdict, 'unverified');
  assert.deepEqual(rep.uncovered, [{ from: '2025-12-01T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z' }]);
  assert.ok(rep.why.some((p) => /nothing attests the deployment's posture from 2025-12-01/.test(p)));
});

check('no records at all is unverified, and never an empty verified', () => {
  const rep = report([]);
  assert.equal(rep.verdict, 'unverified');
  assert.ok(rep.why.length);
  assert.match(render(rep).join('\n'), /no posture covers this interval/);
});

// A head on the same chain as the postures, built with `next` for the same reason the
// daemon will: a fixture that assembles a record literally is a fixture that can carry a
// link no real publisher could produce, and the report would then be tested against
// something that cannot happen.
const HEAD = Object.freeze({ ref: 'refs/notes/beadcause', head: OTHER, length: 12, linear: true, intact: true });

check('a head published under a posture that cannot back it is reported as unbacked', () => {
  const a = attest(null, { ...SOUND, anchored: '2026-01-01T00:00:00Z' }, { instance: INSTANCE, at: '2026-01-01T00:00:00Z' });
  const b = attest(a, OFF, { at: '2026-02-01T00:00:00Z' });
  const h = next(b, 'chain-head', HEAD, { at: '2026-02-15T00:00:00Z' });
  const c = attest(h, { ...SOUND, anchored: '2026-03-08T00:00:00Z' }, { at: '2026-03-08T00:00:00Z' });
  const rep = report([a, b, h, c], { from: '2026-01-01T00:00:00Z', to: '2026-03-31T00:00:00Z' });
  assert.ok(!rep.why.some((p) => /does not link/.test(p)), 'the fixture is a real chain');
  assert.equal(rep.heads.length, 1);
  assert.equal(rep.heads[0].head, OTHER);
  assert.ok(rep.why.some((p) => /head published at 2026-02-15T00:00:00Z is not backed/.test(p)));
});

check('the same head inside a verified stretch is not a finding', () => {
  const [a, b, c] = chain();
  const h = next(c, 'chain-head', HEAD, { at: '2026-03-09T00:00:00Z' });
  const rep = report([a, b, c, h], { from: '2026-03-09T00:00:00Z', to: '2026-03-10T00:00:00Z' });
  assert.deepEqual(rep.heads, []);
  assert.equal(rep.verdict, 'verified', rep.why.join('\n'));
});

check('there is no way to tell the report the chain is fine', () => {
  const source = fs.readFileSync(path.join(root, 'lib', 'posture.js'), 'utf8');
  const signature = source.slice(source.indexOf('export function report('));
  assert.ok(!/links/.test(signature.slice(0, signature.indexOf(')'))), 'report takes the link verdict as an argument');
});

check('a posture edited after the fact breaks the link the record after it names', () => {
  // The tamper has to be in the middle, and that is the property rather than an
  // awkwardness of the fixture: a record's own `prev` still names its predecessor
  // correctly after somebody edits it, so what catches the edit is the *next* record's
  // digest of it. Editing the tip is invisible here, and catching that needs an anchor —
  // which is bc-3muu.10, and is the whole reason `anchoring` is a posture field.
  const [a, b, c] = chain();
  const forged = { ...b, anchoring: true, anchored: '2026-02-01T00:00:00Z' };
  const rep = report([a, forged, c], { from: '2026-01-01T00:00:00Z', to: '2026-03-31T00:00:00Z' });
  assert.equal(rep.verdict, 'unverified');
  assert.ok(rep.why.some((p) => /^the chain does not link/.test(p)), rep.why.join('\n'));
});

/* ------------------------------------------- 5. somebody else can run it */

check('the report is computed from the records and nothing else', () => {
  const records = JSON.parse(JSON.stringify(chain()));
  const rep = report(records, { from: '2026-01-01T00:00:00Z', to: '2026-03-31T00:00:00Z' });
  assert.equal(rep.verdict, 'unverified');
  assert.equal(rep.covering.length, 3);
  const source = fs.readFileSync(path.join(root, 'lib', 'posture.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['fetch(', 'http', 'loadConfig', 'CONFIG_DIR']) {
    assert.ok(!source.includes(forbidden), `lib/posture.js reaches for ${forbidden}, and a verifier an auditor runs may not`);
  }
});

await acheck('beadcause-attest verify reads an export and exits on the verdict', async () => {
  const file = path.join(tmp, 'export.json');
  fs.writeFileSync(file, JSON.stringify(chain(), null, 2));
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync('node', [path.join(root, 'bin', 'attest.js'), ...args], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };

  const bad = run(['verify', file, '--from', '2026-01-01T00:00:00Z', '--to', '2026-03-31T00:00:00Z']);
  assert.equal(bad.code, 2, `expected the claimable-or-not exit code\n${bad.out}`);
  assert.match(bad.out, /^UNVERIFIED/);

  const good = run(['verify', file, '--from', '2026-03-09T00:00:00Z', '--to', '2026-03-10T00:00:00Z']);
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /^VERIFIED/);

  // One record per line as well as an array: an export is written by whoever exports it,
  // and a verifier that only reads its own output is one an auditor cannot use.
  const lines = path.join(tmp, 'export.ndjson');
  fs.writeFileSync(lines, chain().map((r) => JSON.stringify(r)).join('\n'));
  const nd = run(['verify', lines, '--from', '2026-03-09T00:00:00Z', '--to', '2026-03-10T00:00:00Z']);
  assert.equal(nd.code, 0, nd.out);

  const junk = path.join(tmp, 'junk.json');
  fs.writeFileSync(junk, 'this is not an export');
  assert.equal(run(['verify', junk]).code, 1, 'a file that is not an export is an error, not a verdict');
});

await acheck('beadcause-attest posture looks at this install and does not create anything', async () => {
  const store = path.join(tmp, 'never-made');
  const out = execFileSync('node', [path.join(root, 'bin', 'attest.js'), 'posture', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, BEADCAUSE_CONFIG_DIR: store },
    stdio: 'pipe',
  });
  const seen = JSON.parse(out);
  assert.deepEqual(Object.keys(seen.posture).sort(), [...POSTURE_FIELDS].sort());
  assert.equal(seen.posture.storage, 'unknown', 'a directory that is not there is unknown, not assumed');
  assert.equal(seen.verdict, 'unverified');
  assert.ok(seen.why.length);
  assert.equal(fs.existsSync(store), false, 'attesting created the thing it was attesting about');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
