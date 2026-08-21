#!/usr/bin/env node
//
// The daemon's compliance publication sweep — `lib/publishsweep.js`.
//
//   npm test                          (runs it alongside the other suites)
//   node test/publishsweep.mjs        (on its own)
//
// bc-keqy is the bead that says every module bc-3muu landed is a leaf nobody calls, so
// this suite is written around the four things its acceptance asks for and one static
// check that keeps the first of them honest:
//
// 1. **Off creates nothing, and that is asserted rather than assumed.** A sweep on an
//    install with the management system off must leave a config directory with no git
//    repo, no identity, no key and no ref — the same strict half test/management.mjs
//    pins for the reads, kept here for the writer.
// 2. **On, the chain exists and grows without anybody running a command.** One sweep
//    produces an enrolment, a posture and a head per governed ref that has commits, and
//    the whole thing verifies: `linkProblems` walks the digests and `verifyChain` asks
//    git and the payload separately.
// 3. **Each head is preceded by the posture in force.** Not by inspection of the order in
//    the array — that is bc-3muu.12's own suite — but by the answer an auditor gets from
//    `report` in lib/posture.js: a posture covers the whole interval, no stretch of it is
//    attested by nothing, and every head sits inside a segment rather than in the run-up
//    before the first posture. What that report still says is `unverified`, because this
//    laptop anchors nothing — and the pinned assertion is that the reason is the
//    *posture's verdict* rather than a missing posture. Those two produce the same
//    `backed: false` and are a correct install and a broken one respectively.
// 4. **A service that is unreachable or hung leaves the tick untouched.** Four
//    transports — one that throws, one that rejects, one that answers rubbish, and one
//    that accepts the connection and then never speaks — and after each of them the
//    sweep has returned an outcome and the records are still on disk.
//
// And the static check: `lib/publication.js` may not be a top-level import of
// lib/publishsweep.js. The moment it is, an install that has never enabled the layer
// parses the module that opens a store, and claim 1 stops being structural.
//
// Everything runs against a temp BEADCAUSE_CONFIG_DIR and a temp checkout. Nothing here
// touches the real ~/.config/beadcause, no network is reached, and nothing is pushed.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

/* --------------------------------------------------------------- harness */

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-publishsweep-'));
const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-publishsweep-repo-'));
process.env.BEADCAUSE_CONFIG_DIR = store;
// `removeTreeSync` and the exit handler, not a bare `rmSync` on the last line: the writer
// here is `git init` inside both directories, and a teardown that walks the tree while git
// is still laying down `.git/hooks/*` gets ENOTEMPTY after every check has passed. See
// test/helpers/tmp.mjs, and test/management.mjs which hit it first.
process.on('exit', () => {
  removeTreeSync(store);
  removeTreeSync(checkout);
});

const gitIn = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// A checkout with one commit and one chained evidence ref on it, so the sweep has
// something real to publish a head of without reading the repository this suite runs in.
gitIn(checkout, 'init', '--initial-branch=main', '-q');
gitIn(checkout, 'config', 'user.email', 'test@example.com');
gitIn(checkout, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(checkout, 'a.txt'), 'one\n');
gitIn(checkout, 'add', '-A');
gitIn(checkout, 'commit', '-qm', 'one');

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const sweeper = await import('../lib/publishsweep.js');
const management = await import('../lib/management.js');
const evidence = await import('../lib/evidence.js');
const gitref = await import('../lib/gitref.js');

/** Put a commit on a ref in a directory, the way the module that owns it would. */
async function bump(cwd, ref, text) {
  const tree = await gitref.writeTree(cwd, [['x.json', Buffer.from(`${text}\n`)]]);
  const tip = await gitref.refTip(cwd, ref);
  return await gitref.commitToRef(cwd, ref, tree, `bump ${ref}`, { expect: tip });
}

/* -------------------------------------------------- 1. off creates nothing */

console.log('an install with the management system off');

{
  const p = sweeper.createPublisher({ store, checkout, observing: false });
  const out = await p.sweep({ force: true });
  check('the sweep answers rather than throwing', out.verdict === 'off', JSON.stringify(out));
  check('and says why in a sentence', /off/.test(out.why), out.why);
  check('nothing was appended', out.appended.length === 0, JSON.stringify(out.appended));

  const left = fs.readdirSync(store);
  check('it created no git repo under the config directory', !fs.existsSync(path.join(store, '.git')), left.join(' '));
  check('no identity', !fs.existsSync(path.join(store, 'instance.json')), left.join(' '));
  check('no private key', !fs.existsSync(path.join(store, 'instance.key')), left.join(' '));
  check('and nothing at all, in fact', left.length === 0, left.join(' '));
}

console.log('\nand the reason that is structural rather than a promise');

{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'publishsweep.js'), 'utf8');
  const imports = src.match(/^import .*$/gm) || [];
  const forbidden = ['publication.js', 'posture.js', 'instance.js', 'commonrepo.js'];
  for (const name of forbidden) {
    check(
      `lib/${name} is not a top-level import — an off install never parses it`,
      !imports.some((line) => line.includes(name)),
      imports.filter((l) => l.includes(name)).join(' | ')
    );
  }
  // And the other half: the two it genuinely needs are reached through `import()` inside
  // the loader, so the module graph is what keeps the promise rather than a comment.
  for (const name of ['publication.js', 'instance.js']) {
    check(`  and lib/${name} is reached through a dynamic import instead`, src.includes(`import('./${name}')`));
  }
}

/* ------------------------------------------------------ the pieces, alone */

console.log('\nthe cadence, asked of values rather than of a store');

{
  const now = Date.parse('2026-08-21T12:00:00Z');
  const head = (at, sha) => ({ kind: 'chain-head', ref: 'refs/beadcause/election', head: sha, at });

  check('a ref with no commits is never due', sweeper.headDue(null, null, { at: now }).due === false);
  check('a ref never published is due', sweeper.headDue(null, 'a'.repeat(40), { at: now }).due === true);
  const moved = sweeper.headDue(head('2026-08-21T11:59:00Z', 'a'.repeat(40)), 'b'.repeat(40), { at: now });
  check('a tip that moved is due immediately', moved.due === true && /moved from/.test(moved.why), moved.why);
  const fresh = sweeper.headDue(head('2026-08-21T11:00:00Z', 'a'.repeat(40)), 'a'.repeat(40), { at: now });
  check('an unchanged tip published an hour ago is not', fresh.due === false, fresh.why);
  const stale = sweeper.headDue(head('2026-08-19T11:00:00Z', 'a'.repeat(40)), 'a'.repeat(40), { at: now });
  check('an unchanged tip older than the anchoring interval is', stale.due === true && /unchanged/.test(stale.why), stale.why);
  check(
    'and the interval is anchor.js\'s, so the two numbers cannot disagree',
    sweeper.HEAD_EVERY_MS === (await import('../lib/anchor.js')).DEFAULT_INTERVAL_HOURS * 3600 * 1000
  );
  const unreadable = sweeper.headDue(head('not a date', 'a'.repeat(40)), 'a'.repeat(40), { at: now });
  check('a head with an unreadable stamp is republished rather than trusted', unreadable.due === true, unreadable.why);
}

console.log('\nwhich transitions are owed, and which cannot be carried');

{
  const ts = [
    { seq: 1, bead: 'bc-7r4l' },
    { seq: 2, bead: null },
    { seq: 3, bead: 'bc-keqy' },
  ];
  const commits = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
  const first = sweeper.transitionsOwed(ts, commits, new Set());
  check('the two with a bead are owed', first.owed.length === 2 && first.owed[0].bead === 'bc-7r4l', JSON.stringify(first.owed));
  check(
    'and the one with none is named rather than dropped',
    first.skipped.length === 1 && /names no bead/.test(first.skipped[0]),
    JSON.stringify(first.skipped)
  );
  const again = sweeper.transitionsOwed(ts, commits, new Set([commits[0], commits[2]]));
  check('a transition already on the chain is not owed twice', again.owed.length === 0, JSON.stringify(again.owed));
  const short = sweeper.transitionsOwed(ts, commits.slice(0, 1), new Set());
  check(
    'a payload with more transitions than commits is reported, not published',
    short.owed.length === 1 && short.skipped.length === 2 && short.skipped.some((s) => /disagree/.test(s)),
    JSON.stringify(short)
  );
}

console.log('\nwhich organisation this install publishes as');

{
  check('a release shipping one organisation belongs to it', sweeper.organisationOf(['acme']).org === 'acme');
  const two = sweeper.organisationOf(['acme', 'globex']);
  check('a release shipping two refuses rather than guessing', two.org === null && /nothing says which one/.test(two.problem), two.problem);
  const none = sweeper.organisationOf([]);
  check('and a release shipping none says so', none.org === null && /no organisation register/.test(none.problem), none.problem);
  check(
    'this release ships exactly one, so a live install can enrol',
    sweeper.organisationOf().org === (await import('../lib/boundary.js')).organisations()[0]
  );
}

/* ------------------------------------------------- 2 and 3. on, it grows */

console.log('\nturning the management system on');

await management.enable({ reason: 'the publication sweep suite needs a window to publish in', by: 'test', bead: 'bc-keqy' });
check('the layer is on', (await management.isOn()) === true);

console.log('\nthe first sweep of an install that has never published');

let identity;
{
  const p = sweeper.createPublisher({ store, checkout, observing: false });
  const out = await p.sweep({ force: true });
  check('it appended rather than failing', out.verdict === 'appended', JSON.stringify(out));
  check('it enrolled on the way', out.enrolled === true, JSON.stringify(out));
  check('an identity is on disk', fs.existsSync(path.join(store, 'instance.json')));
  check(
    'with the private half in a file the common repo refuses to commit',
    fs.existsSync(path.join(store, 'instance.key')) && fs.readFileSync(path.join(store, '.gitignore'), 'utf8').includes('key')
  );
  identity = JSON.parse(fs.readFileSync(path.join(store, 'instance.json'), 'utf8'));
  check('and no private key in the committed half', !JSON.stringify(identity).includes('PRIVATE'), Object.keys(identity).join(' '));

  const pub = await import('../lib/publication.js');
  const chain = await pub.chain();
  check('the chain exists', chain.length > 0, String(chain.length));
  check('its first record is the enrolment', chain[0].kind === 'enrolment' && chain[0].seq === 0, JSON.stringify(chain[0]));
  check('naming the fingerprint and the organisation and nothing else',
    chain[0].fingerprint === identity.fingerprint && typeof chain[0].org === 'string' && !('placement' in chain[0]),
    JSON.stringify(chain[0]));
  check('every record is this instance\'s', chain.every((r) => r.instance === identity.id), identity.id);

  const kinds = chain.map((r) => r.kind);
  check('a posture was attested', kinds.includes('posture'), kinds.join(' '));
  check('and it comes before the first head', kinds.indexOf('posture') < kinds.indexOf('chain-head'), kinds.join(' '));
  check('the management transition is on the chain', kinds.includes('transition'), kinds.join(' '));

  const publishable = await import('../lib/publishable.js');
  const links = publishable.linkProblems(chain);
  check('and the whole chain links', links.length === 0, links.join(' | '));

  const verified = await pub.verifyChain();
  check('git says it is linear and intact', verified.linear && verified.intact, JSON.stringify(verified));
  check('and the payload agrees', verified.sound, JSON.stringify(verified));

  // Claim 3, asked the way an auditor asks it. A zero-width window covers nothing —
  // `overlaps` in report() is `a < to && b > from` — so the interval has to have width or
  // every head in it comes back unbacked and the pairing looks broken when it is not.
  const posture = await import('../lib/posture.js');
  const rep = posture.report(chain, { from: chain[0].at, to: new Date(Date.now() + 60_000).toISOString() });
  check('a posture covers the whole interval the chain runs over', rep.covering.length > 0, String(rep.covering.length));
  check('with no stretch of it attested by nothing', rep.uncovered.length === 0, JSON.stringify(rep.uncovered));
  const segAt = (t) => rep.covering.find((s) => Date.parse(s.from) <= t && (s.until === null || Date.parse(s.until) > t));
  const headRecords = chain.filter((r) => r.kind === 'chain-head');
  check('and every head sits inside a segment rather than in the run-up before the first posture',
    headRecords.every((r) => Boolean(segAt(Date.parse(r.at)))),
    JSON.stringify(headRecords.filter((r) => !segAt(Date.parse(r.at))).map((r) => r.at)));

  // And the state this laptop is actually in, pinned rather than papered over. Every head
  // still comes back `backed: false`, because `report` lists only the ones that are not —
  // and the reason is the posture's verdict, not its absence: nothing anchors this chain
  // anywhere the local operator does not administer, so it is `unverified` and says which of
  // the reasons it was. Surfacing that where somebody looks is bc-9hm1. What must never read
  // as the reason is "no posture covers this interval", which is what a head published
  // before its posture produces.
  check('the report is unverified, which is the honest answer for an install with no anchoring',
    rep.verdict === 'unverified', rep.verdict);
  check('and it says so because of the posture rather than because of a gap',
    rep.why.some((w) => /anchoring is not configured/.test(w)) && !rep.why.some((w) => /no posture covers/.test(w)),
    rep.why.join(' | '));

  const heads = headRecords.map((r) => r.ref);
  check('the ref that had commits got a head', heads.includes('refs/beadcause/management'), heads.join(' '));
  check('and the chain never publishes a head of itself', !heads.includes('refs/beadcause/publications'), heads.join(' '));
}

console.log('\nthe second sweep, one second later');

{
  const p = sweeper.createPublisher({ store, checkout, observing: false });
  const pub = await import('../lib/publication.js');
  const before = (await pub.chain()).length;
  const out = await p.sweep({ force: true });
  const after = (await pub.chain()).length;
  check('appends nothing — the cadence is not "every tick"', after === before, `${before} -> ${after}`);
  check('and says so rather than reporting a failure', out.verdict === 'quiet', JSON.stringify(out));
  check('a sweep that is not due yet does not even ask whether the layer is on',
    (await p.sweep({ cfg: { publication: { seconds: 3600 } } })).why === 'not due yet');
}

console.log('\na governed ref that moved');

{
  await bump(store, 'refs/beadcause/memory', 'a memory written by an agent');
  const p = sweeper.createPublisher({ store, checkout, observing: false });
  const pub = await import('../lib/publication.js');
  const out = await p.sweep({ force: true });
  const chain = await pub.chain();
  const mem = chain.filter((r) => r.kind === 'chain-head' && r.ref === 'refs/beadcause/memory');
  check('is published on the first sweep after it moved', mem.length === 1, JSON.stringify(out.appended));
  check('and the sweep says which ref and why', out.appended.some((a) => /refs\/beadcause\/memory/.test(a)), out.appended.join(' | '));

  await bump(store, 'refs/beadcause/memory', 'and another');
  await p.sweep({ force: true });
  const mem2 = (await pub.chain()).filter((r) => r.kind === 'chain-head' && r.ref === 'refs/beadcause/memory');
  check('a second move is a second head, naming the new tip', mem2.length === 2 && mem2[1].head !== mem2[0].head, JSON.stringify(mem2.map((r) => r.head)));
  check('and the posture was not restated for it — nothing about the deployment changed',
    (await pub.chain()).filter((r) => r.kind === 'posture').length === 1,
    JSON.stringify((await pub.chain()).filter((r) => r.kind === 'posture').length));
}

console.log('\na transition with no bead behind it');

{
  // Two transitions in the same millisecond would make the derived timeline ambiguous, and
  // a real one never is — the same wait test/management.mjs takes.
  await new Promise((r) => setTimeout(r, 5));
  await management.disable({ reason: 'the window closes, and nobody said which bead asked' });
  const p = sweeper.createPublisher({ store, checkout, observing: false });
  const out = await p.sweep({ force: true });
  check('the layer being off means the sweep does nothing at all', out.verdict === 'off', JSON.stringify(out));

  await new Promise((r) => setTimeout(r, 5));
  await management.enable({ reason: 'and it opens again, this time with a bead', by: 'test', bead: 'bc-keqy' });
  const back = await p.sweep({ force: true });
  const pub = await import('../lib/publication.js');
  const transitions = (await pub.chain()).filter((r) => r.kind === 'transition');
  check('the two transitions with a bead are published', transitions.length === 2, JSON.stringify(transitions.map((r) => r.bead)));
  check(
    'and the one without is named in the outcome rather than lost',
    back.skipped.some((s) => /names no bead/.test(s)),
    JSON.stringify(back.skipped)
  );
}

/* --------------------------------------- 4. the service cannot hurt a tick */

console.log('\nfour ways a service can fail, and none of them reaches the caller');

{
  const pub = await import('../lib/publication.js');
  const before = (await pub.chain()).length;
  await bump(store, 'refs/beadcause/election', 'something to have pending');

  const transports = [
    ['a transport that throws on the way out', { head: () => { throw new Error('DNS'); }, deliver: async () => ({}) }],
    ['a transport that rejects', { head: async () => { throw new Error('ECONNREFUSED'); }, deliver: async () => ({}) }],
    ['a service that acknowledges something else', { head: async () => ({ instance: null, seq: -1, at: null, digest: null }), deliver: async () => ({ seq: 999 }) }],
    ['a connection accepted and then silent', { head: () => new Promise(() => {}), deliver: () => new Promise(() => {}) }],
  ];

  for (const [name, transport] of transports) {
    const p = sweeper.createPublisher({ store, checkout, observing: false, transport, deadlineMs: 60 });
    let out;
    const began = Date.now();
    try {
      out = await p.sweep({ force: true });
    } catch (err) {
      bad(`${name} — the sweep threw`, err.message);
      continue;
    }
    check(`${name}: the sweep came back with an outcome`, typeof out?.verdict === 'string', JSON.stringify(out));
    check(`${name}: and did not hang the tick`, Date.now() - began < 5_000, `${Date.now() - began}ms`);
  }

  const chain = await pub.chain();
  check('and the records are still on disk after all four', chain.length > before, `${before} -> ${chain.length}`);
  const links = (await import('../lib/publishable.js')).linkProblems(chain);
  check('with the chain still linking', links.length === 0, links.join(' | '));
}

console.log('\nan install that is only watching');

{
  const observer = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-publishsweep-obs-'));
  process.on('exit', () => removeTreeSync(observer));
  fs.copyFileSync(path.join(store, 'instance.json'), path.join(observer, 'instance.json'));
  fs.copyFileSync(path.join(store, 'instance.key'), path.join(observer, 'instance.key'));
  const p = sweeper.createPublisher({ store: observer, checkout, observing: true });
  const out = await p.sweep({ force: true });
  check('a copied configuration is refused as an observer', out.verdict === 'observing', JSON.stringify(out));
  check('and the refusal says which of the two it was', /observ|copy/.test(out.why), out.why);
  check('nothing was appended to anything', out.appended.length === 0, JSON.stringify(out.appended));

  // And the brace behind the belt: a copy that did NOT set the flag is still refused, on
  // placement alone, which is the failure lib/instance.js says the flag actually has.
  const q = sweeper.createPublisher({ store: observer, checkout, observing: false });
  const unflagged = await q.sweep({ force: true });
  check('a copy that never set the flag is refused on placement', unflagged.verdict === 'unenrolled', JSON.stringify(unflagged));
  check('and told which of the two answers it wants', /Adopt it|enrol this directory/.test(unflagged.why), unflagged.why);
}

/* ------------------------------------------------------------- the crosswalk */

console.log('\nthe table of refs, crosswalked against the evidence register');

{
  const chained = new Map(evidence.REGISTER.filter((e) => e.integrity === 'chained').map((e) => [e.id, e]));
  for (const entry of sweeper.PUBLISHED_REFS) {
    const cls = chained.get(entry.id);
    check(`${entry.id} is a chained evidence class`, Boolean(cls), 'not in the register, or not chained');
    if (cls) {
      check(`  and ${cls.id} names ${entry.ref}`, cls.where.some((w) => w.includes(entry.ref)), cls.where.join(' ; '));
    }
    check(`  ${entry.id} says where it lives`, entry.where === 'store' || entry.where === 'checkout', entry.where);
    check(`  and why its head is worth publishing`, typeof entry.why === 'string' && entry.why.length > 20, entry.why);
  }

  // The other half of the same inventory. Every chained class living at one fixed ref is
  // either published or has a sentence saying why not — a class that is in neither is a
  // record nobody publishes and nobody decided not to.
  const published = new Set(sweeper.PUBLISHED_REFS.map((e) => e.id));
  for (const cls of chained.values()) {
    if (published.has(cls.id)) continue;
    const fixed = cls.where.some((w) => /refs\/[a-z/]+( |$)/.test(w) && !w.includes('<'));
    if (!fixed) continue;
    check(
      `${cls.id} is chained and not published, and says why`,
      typeof sweeper.NOT_PUBLISHED[cls.id] === 'string' && sweeper.NOT_PUBLISHED[cls.id].length > 40,
      sweeper.NOT_PUBLISHED[cls.id] || 'no sentence in NOT_PUBLISHED'
    );
  }
  check('the table is frozen', Object.isFrozen(sweeper.PUBLISHED_REFS) && sweeper.PUBLISHED_REFS.every(Object.isFrozen));
  check('and so is the list of what it leaves out', Object.isFrozen(sweeper.NOT_PUBLISHED));
}

console.log('\nthe cadence setting, and the one that deliberately does not exist');

{
  check('an hour by default', sweeper.publishEveryMs(null) === 3600_000);
  check('settable', sweeper.publishEveryMs({ publication: { seconds: 300 } }) === 300_000);
  check('with a floor of a minute', sweeper.publishEveryMs({ publication: { seconds: 1 } }) === 60_000);
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'publishsweep.js'), 'utf8');
  check(
    'and no enabled key — a settings file must not be able to open a gap in the record',
    !/publication\?\.enabled|publication\.enabled\b(?!.*deliberately)/.test(src.replace(/^\s*\*.*$/gm, '')),
    'an enabled key appeared in the code'
  );
}

/* ------------------------------------------------------------------ verdict */

assert.ok(Object.isFrozen(sweeper.VERDICTS), 'the verdict vocabulary must be frozen');
for (const w of ['off', 'quiet', 'appended', 'published', 'offline', 'unenrolled', 'observing', 'divergent', 'failed'])
  assert.ok(Object.hasOwn(sweeper.VERDICTS, w), `the verdict vocabulary lost ${w}`);
assert.equal(sweeper.VERDICTS.offline, false, 'an unreachable service is the ordinary condition, not a finding');
assert.equal(sweeper.VERDICTS.divergent, true, 'a divergence is somebody\'s problem and must read as one');
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
