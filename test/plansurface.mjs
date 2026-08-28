/**
 * Two windows are never sent at one file — refused in the plan, deferred in the tick.
 *
 * bc-42ow.3 and bc-42ow.4, and they are one suite because they are one mechanism asked at
 * two moments. `lib/beadfiles.js` learned to say whether two *surfaces* intersect — not
 * whether a path matches a pattern, which is what `occupiedBy` already asked, but whether
 * any path exists that two patterns would both match — and there is exactly one of that
 * test, which is the constraint the whole of bc-42ow rests on: a plan that computed overlap
 * differently from the dispatcher would be two mechanisms both believing they read one
 * field.
 *
 * The two moments differ in how strict they are allowed to be, and the difference is the
 * point rather than an inconsistency:
 *
 *   - **At plan time it is a refusal.** A plan is a decomposition somebody has just made,
 *     so two groups naming one file are not a risk, they are a bug in the plan, and the
 *     planner is the only party still holding the context to split them. `validatePlan`
 *     throws, naming the *earlier* group — the one they wrote first and are most likely to
 *     keep — and `formatPlan` prints the surface on the human-readable line, because the
 *     person reading the plan comment is the one who can see it was split along the wrong
 *     seam.
 *   - **At dispatch it is a one-tick deferral.** Two ready beads whose declared surfaces
 *     intersect are a collision no register can see, because neither window exists yet.
 *     Later defers to earlier, the loser comes up next tick, and nothing is released.
 *
 * And on both sides, **declaring nothing is legal and intersects nothing** — the P0's rule
 * that a missing surface must never withhold work, which is why every case below has a
 * mirror asserting that the bead or group with no `files:` sails through.
 *
 *     node test/plansurface.mjs
 *
 * The dispatch half is built on test/claimqueue.mjs's harness: `open` is injected, so a
 * tick that would have opened an iTerm window pushes a bead id onto an array instead. No
 * iTerm, no `bd`, no `gh`, no agent, and nothing written outside a temp directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp, quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-plansurface-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
for (const d of [SESSIONS, path.join(REPO, 'lib')]) fs.mkdirSync(d, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { overlap, collides } = await import(LIB('beadfiles.js'));
const { formatPlan, surfaceNotes, validatePlan } = await import(LIB('plan.js'));

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

/* ------------------------------------------------------- the one overlap test */

console.log('one overlap test, in lib/beadfiles.js (bc-42ow)');

await test('two surfaces naming one file meet, and the pair names it', () => {
  assert.deepEqual(
    overlap(['lib/plan.js', 'bin/plan.js'], ['lib/plan.js']),
    [{ a: 'lib/plan.js', b: 'lib/plan.js', path: 'lib/plan.js' }]
  );
});

await test('a glob on either side counts, and the sentence names the file before the pattern', () => {
  const hits = overlap(['lib/plan.js'], ['lib/**']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'lib/plan.js (covered by lib/**)');
  assert.ok(collides(['lib/**'], ['lib/plan.js']), 'and it is symmetric');
});

await test('two globs meet when some path would satisfy both, and not otherwise', () => {
  // Neither side is a literal, so this cannot be answered by matching one against the
  // other — `lib/pr*.js` and `lib/*e.js` share `lib/prse.js` and nothing else does.
  assert.ok(collides(['lib/pr*.js'], ['lib/*e.js']));
  assert.ok(!collides(['lib/a*.js'], ['bin/b*.js']));
  assert.ok(!collides(['lib/*.js'], ['lib/sub/thing.js']), '`*` does not cross a slash');
  assert.ok(collides(['lib/**'], ['lib/sub/thing.js']), 'and `**` does');
});

await test('a trailing slash is a directory, and the case of a path is not a second file', () => {
  assert.ok(collides(['lib/'], ['lib/plan.js']), '`lib/` means everything under lib/');
  assert.ok(collides(['lib/Plan.js'], ['./lib/plan.js']), 'one file on this filesystem, spelled twice');
});

await test('an empty surface intersects nothing at all', () => {
  assert.deepEqual(overlap([], ['lib/plan.js']), []);
  assert.deepEqual(overlap(['lib/plan.js'], []), []);
  assert.deepEqual(overlap(['# just a comment'], ['lib/plan.js']), []);
});

await test('a pathological pattern answers rather than hanging', () => {
  // The ordinary wildcard backtrack is exponential on this shape, and an entry is up to
  // MAX_LEN characters of whatever somebody typed into a bead. Memoised, so it is linear
  // in the product — a second here would be a hang in the daemon's survey.
  const started = Date.now();
  assert.ok(!collides([`lib/${'a*'.repeat(40)}b.js`], [`lib/${'a*'.repeat(40)}c.js`]));
  assert.ok(Date.now() - started < 1000, 'the surface comparison has to be bounded, not merely correct');
});

/* ------------------------------------------------------ plan time: a refusal */

console.log('a plan may not give the same file to two groups (bc-42ow.3)');

let nth = 0;
const group = (name, over = {}) => ({
  name,
  // A fresh id every time, because a bead in two groups is refused for its own reason and
  // would mask the one being tested here.
  beads: [`bc-e.${(nth += 1)}`],
  prs: [{ repo: 'beadcause', title: `PR for ${name}` }],
  prompt: `do ${name}`,
  ...over,
});

const plan = (...groups) => validatePlan({ groups }, { epic: 'bc-e' });

await test('two groups declaring one file are refused, and the earlier one is named', () => {
  assert.throws(
    () => plan(group('first', { files: ['lib/plan.js'] }), group('second', { files: ['lib/plan.js', 'bin/x.js'] })),
    (err) => {
      assert.match(err.message, /"second" and "first"/, err.message);
      assert.match(err.message, /lib\/plan\.js/, 'the file has to be named or the refusal is unactionable');
      assert.doesNotMatch(err.message, /bin\/x\.js/, 'and only the file they share');
      assert.match(err.message, /put them in one group/, 'with the fix in the same sentence');
      return true;
    }
  );
});

await test('a glob collides with the file it covers', () => {
  assert.throws(
    () => plan(group('first', { files: ['lib/'] }), group('second', { files: ['lib/plan.js'] })),
    /both expect to touch/
  );
});

await test('a group that declares nothing is legal and collides with nothing', () => {
  const ok = plan(group('first', { files: ['lib/plan.js'] }), group('second'), group('third'));
  assert.deepEqual(ok.groups.map((g) => g.files), [['lib/plan.js'], [], []]);
});

await test('two groups in two repos naming one path name two files', () => {
  const ok = validatePlan(
    {
      groups: [
        { ...group('first', { files: ['lib/plan.js'] }), prs: [{ repo: 'beadcause', title: 'a' }] },
        { ...group('second', { files: ['lib/plan.js'] }), prs: [{ repo: 'sophab', title: 'b' }] },
      ],
    },
    { epic: 'bc-e' }
  );
  assert.equal(ok.groups.length, 2, 'a checkout is what makes two `lib/plan.js` two files');
});

await test('`touches:`, `paths:` and `surface:` are the same field under other names', () => {
  for (const key of ['touches', 'paths', 'surface']) {
    assert.throws(
      () => plan(group('first', { [key]: ['lib/plan.js'] }), group('second', { files: ['lib/plan.js'] })),
      /both expect to touch/,
      `${key}: has to be read, or it is a declaration that never fires`
    );
  }
});

await test('a surface is normalised before it is compared, so one file is not two', () => {
  assert.throws(
    () => plan(group('first', { files: ['./lib/plan.js'] }), group('second', { files: ['lib//plan.js'] })),
    /both expect to touch/
  );
});

await test('the surface reaches the stored plan and the human-readable line', () => {
  const one = group('first', { files: ['lib/plan.js', 'bin/plan.js'] });
  const two = group('second');
  const body = formatPlan(plan(one, two));
  assert.match(body, new RegExp(`- \\*\\*first\\*\\* — ${one.beads[0]} · touches lib/plan\\.js, bin/plan\\.js`), body);
  assert.match(
    body,
    new RegExp(`- \\*\\*second\\*\\* — ${two.beads[0]}\n`),
    'and a group with no surface says nothing rather than "touches"'
  );
  assert.match(body, /"files": \[\n\s+"lib\/plan\.js"/, 'and it is in the JSON the next tick reads');
});

/* ---------------------------------------- plan time: what it will only *say* */

console.log('a plan that declared nothing is remarked on rather than refused (bc-zjab.1)');

// Real files, because a guessed path is kept only where one exists in the checkout the group
// would be worked in — the existence check is the whole reason a guess is worth printing.
for (const f of ['lib/plan.js', 'lib/server.js', 'lib/other.js']) {
  fs.mkdirSync(path.dirname(path.join(REPO, f)), { recursive: true });
  fs.writeFileSync(path.join(REPO, f), '// a file that is really there\n');
}
const DIRS = [{ name: 'beadcause', dir: REPO }];
const row = (id, description) => ({ id, title: `do ${id}`, description });
const notesFor = (spec, over = {}) =>
  surfaceNotes(validatePlan(spec, { epic: 'bc-e' }), { dirs: DIRS, ...over });

await test('a group with no `files:` says which check did not run for it', () => {
  const one = group('first');
  const notes = notesFor({ groups: [one] });
  assert.equal(notes.length, 1, notes.join('\n'));
  assert.match(notes[0], /^"first" declares no `files:`/, notes[0]);
  assert.match(notes[0], /no two groups are sent at one file did not run/, 'the check has to be named');
  assert.match(notes[0], /not the same as having passed it/, 'which is the whole of what was wrong');
});

await test('a group that declared its surface is not remarked on', () => {
  assert.deepEqual(notesFor({ groups: [group('first', { files: ['lib/plan.js'] })] }), []);
});

await test('two undeclared groups whose beads name one file say so, and nothing is refused', () => {
  const one = group('first');
  const two = group('second');
  const notes = notesFor(
    { groups: [one, two] },
    {
      beads: [
        row(one.beads[0], 'rewrite the header of lib/plan.js'),
        row(two.beads[0], 'the fix belongs in lib/plan.js as well'),
      ],
    }
  );
  // Two "declares no files:" lines and one overlap line — the plan itself came back validated,
  // which is what "not a refusal" means here.
  assert.equal(notes.length, 3, notes.join('\n'));
  const hit = notes.find((n) => n.includes('both look like they touch'));
  assert.match(hit, /^"second" and "first"/, 'the earlier group is named second, as in the refusal');
  assert.match(hit, /both look like they touch lib\/plan\.js/, hit);
  assert.match(hit, /neither declared a surface, so both were read off their beads' own text/, hit);
  assert.match(hit, /which makes this an observation and not a refusal/, hit);
});

await test('one declared side and one guessed side is said to be exactly that', () => {
  const one = group('first', { files: ['lib/server.js'] });
  const two = group('second');
  const hit = notesFor({ groups: [one, two] }, { beads: [row(two.beads[0], 'touch lib/server.js')] }).find((n) =>
    n.includes('both look like they touch')
  );
  assert.match(hit, /"first" declared that and "second" was read off its beads' own text/, hit);
});

await test('a bead that declares its own surface counts for the group that did not', () => {
  const one = group('first', { files: ['lib/server.js'] });
  const two = group('second');
  const hit = notesFor(
    { groups: [one, two] },
    { beads: [row(two.beads[0], ['what to do', '', '```beadfiles', 'lib/server.js', '```'].join('\n'))] }
  ).find((n) => n.includes('both look like they touch'));
  assert.ok(hit, 'a `beadfiles` block on the bead is a surface too — `surfaceOf` reads it first');
});

await test('a group that declared wins outright and its beads are not read', () => {
  // `first` declares lib/other.js and its bead's text names lib/plan.js. Declared is never
  // merged with the guess, here as in `surfaceOf`, so there is nothing for `second` to meet.
  const one = group('first', { files: ['lib/other.js'] });
  const two = group('second');
  const notes = notesFor(
    { groups: [one, two] },
    { beads: [row(one.beads[0], 'lib/plan.js'), row(two.beads[0], 'also lib/plan.js')] }
  );
  assert.deepEqual(notes.filter((n) => n.includes('both look like')), []);
});

await test('a path that is nowhere on disk is not a guess worth printing', () => {
  const one = group('first');
  const two = group('second');
  const beads = [row(one.beads[0], 'edit lib/nosuchfile.js'), row(two.beads[0], 'edit lib/nosuchfile.js too')];
  assert.deepEqual(notesFor({ groups: [one, two] }, { beads }).filter((n) => n.includes('both look like')), []);
  assert.deepEqual(
    notesFor({ groups: [one, two] }, { beads, dirs: [] }).filter((n) => n.includes('both look like')),
    [],
    'and with no checkout at all it goes quiet rather than throwing'
  );
});

await test('two groups in two checkouts naming one path still name two files', () => {
  const one = { ...group('first'), prs: [{ repo: 'beadcause', title: 'a' }] };
  const two = { ...group('second'), prs: [{ repo: 'sophab', title: 'b' }] };
  const notes = surfaceNotes(validatePlan({ groups: [one, two] }, { epic: 'bc-e' }), {
    dirs: [{ name: 'beadcause', dir: REPO }, { name: 'sophab', dir: REPO }],
    beads: [row(one.beads[0], 'lib/plan.js'), row(two.beads[0], 'lib/plan.js')],
  });
  assert.deepEqual(notes.filter((n) => n.includes('both look like')), []);
});

await test('rows it never got, and a plan it can read nothing about, are quiet not fatal', () => {
  const notes = surfaceNotes(validatePlan({ groups: [group('first'), group('second')] }, { epic: 'bc-e' }));
  assert.equal(notes.length, 2, 'both groups still say they declared nothing');
  assert.deepEqual(notes.filter((n) => n.includes('both look like')), []);
});

/* ------------------------------------------------- dispatch time: a deferral */

console.log('two beads with intersecting surfaces are not opened in one tick (bc-42ow.4)');

const OLD = '2020-01-01T00:00:00Z';
const withBlock = (...files) => ['what to do', '', '```beadfiles', ...files, '```'].join('\n');
const bead = (id, over = {}) => ({
  id,
  title: `do the thing for ${id}`,
  priority: 2,
  issue_type: 'task',
  created_at: OLD,
  ...over,
});

async function tick({ ready = [], attempts = {}, overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // `quiesce` + `removeTree` rather than a bare recursive `rmSync`: every write of
  // `advocates.json` schedules a common-repo commit 2000ms out whose `git init` lands in
  // `CONFIG_DIR`, and rmdir on a directory that gained a file since it was read is
  // ENOTEMPTY. test/tmpadoption.mjs fails the repo for the bare form.
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    sessionDirs: { alpha: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Everything with a suite of its own, which would otherwise run real git, a real
      // `gh` or a real agent against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      holdOpenPrs: false,
      sessionLog: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  // Written *before* the advocates are created, because `record()` restores `attempts`
  // verbatim out of this file — which is the only way to stage a bead at the cap without
  // running two ticks' worth of failed launches. Same seam test/givenup.mjs uses.
  if (Object.keys(attempts).length) {
    fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { attempts } }, null, 2));
  }

  const opened = [];
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => [],
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
  });
  await advocates.tick();
  return { opened, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

const deferredIds = (card) => (card.heldBySurface || []).map((h) => h.id);

await test('the second of two beads declaring one file waits for the next tick', async () => {
  const { opened, card } = await tick({
    ready: [
      bead('bc-1', { description: withBlock('lib/beadfiles.js') }),
      bead('bc-2', { description: withBlock('lib/beadfiles.js', 'lib/plan.js') }),
    ],
  });
  assert.deepEqual(opened, ['bc-1'], 'later defers to earlier — the queue order decides, not a new tiebreak');
  assert.deepEqual(deferredIds(card), ['bc-2']);
  const entry = card.heldBySurface[0];
  assert.equal(entry.other, 'bc-1', 'the bead it is behind is the only thing there is to go and look at');
  assert.match(entry.why, /bc-1/, entry.why);
  assert.match(entry.why, /lib\/beadfiles\.js/, 'and the file they share');
  assert.doesNotMatch(entry.why, /lib\/plan\.js/, 'and only the file they share');
  assert.match(entry.why, /next tick/, 'deferred, not blocked — there is nothing to release');
  assert.deepEqual(entry.files, ['lib/beadfiles.js']);
});

await test('two beads that declare different files both open', async () => {
  const { opened, card } = await tick({
    ready: [
      bead('bc-1', { description: withBlock('lib/beadfiles.js') }),
      bead('bc-2', { description: withBlock('lib/plan.js') }),
    ],
  });
  assert.deepEqual(opened, ['bc-1', 'bc-2']);
  assert.deepEqual(deferredIds(card), []);
});

await test('a bead that declares nothing is never deferred, and never defers anything', async () => {
  const { opened, card } = await tick({
    ready: [bead('bc-1'), bead('bc-2', { description: withBlock('lib/plan.js') }), bead('bc-3')],
  });
  assert.deepEqual(opened, ['bc-1', 'bc-2', 'bc-3'], 'a missing surface must never withhold work');
  assert.deepEqual(deferredIds(card), []);
});

await test('a surface guessed out of the prose may not defer anything', async () => {
  // Both beads name a real file in their text and neither declares one. That is exactly
  // what `holdGuessedFiles` is off for (bc-hrno) — and there is no flag that turns it on
  // here, because a hold with a guess at both ends has no evidence at either.
  fs.writeFileSync(path.join(REPO, 'lib', 'advocate.js'), '// a file\n');
  const { opened, card } = await tick({
    ready: [
      bead('bc-1', { description: 'rework lib/advocate.js a bit' }),
      bead('bc-2', { description: 'and lib/advocate.js again' }),
    ],
  });
  assert.deepEqual(opened, ['bc-1', 'bc-2']);
  assert.deepEqual(deferredIds(card), []);
});

await test('a deferred bead does not go on to defer a third', async () => {
  const { opened, card } = await tick({
    ready: [
      bead('bc-1', { description: withBlock('lib/plan.js') }),
      bead('bc-2', { description: withBlock('lib/plan.js', 'lib/zzz.js') }),
      bead('bc-3', { description: withBlock('lib/zzz.js') }),
    ],
  });
  assert.deepEqual(opened, ['bc-1', 'bc-3'], 'bc-2 never opened, so it holds nothing against bc-3');
  assert.deepEqual(deferredIds(card), ['bc-2']);
});

await test('the note says so on the line that says what opened', async () => {
  // Not on the "nothing ready" line every other hold is explained on, and it cannot be:
  // the winner of a collision is always kept, so a tick with a deferral is by construction
  // a tick that is opening a window.
  const { card } = await tick({
    ready: [
      bead('bc-1', { description: withBlock('lib/plan.js') }),
      bead('bc-2', { description: withBlock('lib/plan.js') }),
    ],
  });
  assert.equal(card.heldBySurface.length, 1);
  assert.match(card.note, /opening 1 session\(s\) · 1 deferred a tick behind the same files/, card.note);
});

/* ------------------------------- and a bead nothing will ever open reserves nothing */

console.log('\na bead at maxAttemptsPerBead reserves no file (bc-nc6o.15)');

await test('the bead behind one at the attempt cap opens, rather than waiting for ever', async () => {
  // The pinned check: a queue of two beads declaring the same file, the first at the cap.
  // Before the skip this tick opened nothing at all — the retired bead took `lib/plan.js`,
  // the live one was told it "waits for the next tick", and the next tick said the same
  // thing, because `2 < 2` is false for ever. Eighteen hours of it were measured on this
  // Mac before the bead was filed.
  const { opened, card } = await tick({
    ready: [
      bead('bc-1', { description: withBlock('lib/plan.js') }),
      bead('bc-2', { description: withBlock('lib/plan.js') }),
    ],
    attempts: { 'bc-1': 2 },
  });
  assert.deepEqual(opened, ['bc-2'], 'the live bead gets its window; the retired one was never going to get one');
  assert.deepEqual(deferredIds(card), [], 'and nothing is deferred behind a bead that cannot be opened');
  assert.deepEqual(
    (card.givenUp || []).map((g) => g.id),
    ['bc-1'],
    'the retired bead is still in the queue and still reported — by the one list whose job that is'
  );
  assert.doesNotMatch(card.note, /deferred a tick behind/, card.note);
});

await test('a bead at the cap is not held by a surface either, so it is never two pills', async () => {
  // The other direction, and the double count the ordering comment in `candidates` is
  // about: held-by-surface subtracts a bead from the queue, given-up counts one still in
  // it, so a bead in both is drawn twice and reported as neither thing it is.
  const { opened, card } = await tick({
    ready: [
      bead('bc-1', { description: withBlock('lib/plan.js') }),
      bead('bc-2', { description: withBlock('lib/plan.js') }),
    ],
    attempts: { 'bc-2': 2 },
  });
  assert.deepEqual(opened, ['bc-1'], 'the live bead is in front and opens on its own merits');
  assert.deepEqual(deferredIds(card), [], 'the retired one is not deferred — there is no tick it comes back on');
  assert.deepEqual(
    (card.givenUp || []).map((g) => g.id),
    ['bc-2'],
    'given up on, which is the whole and only truth about it'
  );
});

await test('two live beads are still held apart when a retired one declares the same file', async () => {
  // bc-42ow.4's rule is not being relaxed, only stopped from being spent on a bead nothing
  // will open: the retired bead in front takes nothing, and the two live ones behind it
  // still resolve against each other exactly as they would have with it absent.
  const { opened, card } = await tick({
    ready: [
      bead('bc-1', { description: withBlock('lib/plan.js') }),
      bead('bc-2', { description: withBlock('lib/plan.js') }),
      bead('bc-3', { description: withBlock('lib/plan.js') }),
    ],
    attempts: { 'bc-1': 2 },
  });
  assert.deepEqual(opened, ['bc-2'], 'the first live bead wins the file');
  assert.deepEqual(deferredIds(card), ['bc-3'], 'and the second live bead defers to it, as it always did');
  assert.equal(card.heldBySurface[0].other, 'bc-2', 'behind the bead that really is being opened, never behind bc-1');
  assert.match(card.heldBySurface[0].why, /next tick/, 'and now that sentence is true — bc-2 will have landed or claimed');
});

await test('holdCollidingSurfaces: false takes the whole filter out', async () => {
  const { opened, card } = await tick({
    ready: [
      bead('bc-1', { description: withBlock('lib/plan.js') }),
      bead('bc-2', { description: withBlock('lib/plan.js') }),
    ],
    overrides: { holdCollidingSurfaces: false },
  });
  assert.deepEqual(opened, ['bc-1', 'bc-2']);
  assert.deepEqual(deferredIds(card), []);
});

/* -------------------------------------------------------------------- ending */

await quiesce();
await cleanupTmp(tmp);
if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall good');
