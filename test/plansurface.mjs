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
const { formatPlan, validatePlan } = await import(LIB('plan.js'));

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

async function tick({ ready = [], overrides = {} } = {}) {
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
