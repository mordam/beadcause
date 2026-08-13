/**
 * A bead whose files another session is already editing gets no window — if it said so.
 *
 * bc-mp8c. lib/claims.js has answered "is anyone on this file?" since bc-q5c2, and the
 * only thing that ever asked was scripts/claim-guard.sh at `PreToolUse` — after a session
 * had been opened, briefed and pointed at the tree, where the refusal costs a wasted tool
 * call by design. `withoutClaimedFiles` in lib/advocate.js asks the same map at dispatch,
 * where standing down costs nothing, and lib/beadfiles.js is the half that works out which
 * files a bead would touch in the first place.
 *
 * Six claims:
 *
 *   - **no window** over a bead whose *declared* files somebody is holding — and a
 *     declaration may be a glob, since bc-42ow's field is a file *or glob* surface and a
 *     pattern that matched nothing here would be worse than no field at all;
 *   - **and a window anyway** when the surface was only guessed out of the bead's prose,
 *     because a guess must not withhold work — bc-hrno, and `withoutTwins`' rule that
 *     evidence which is a resemblance errs toward doing the work twice;
 *   - **but said out loud either way**, on the card, because the third rule at the top of
 *     lib/advocate.js is that every cap is loud and a queue that shrinks in silence reads
 *     exactly like an advocate that has decided there is nothing to do;
 *   - **`holdGuessedFiles` is the gate**, and turning it on holds the guess too;
 *   - **only a real claim holds** — a session that was *told* about a file and has not come
 *     back is not on it, a claim in another checkout is not about this bead, and a path
 *     that is not on disk is not a file;
 *   - **and nothing has to be released.** The hold is recomputed from the register every
 *     survey, so a claim that goes away brings the bead back on the next tick with no
 *     timer, no cleanup and no state of its own.
 *
 *     node test/claimqueue.mjs
 *
 * Built on test/prqueue.mjs's harness: `open` is injected, so a tick that would have
 * opened an iTerm window pushes a bead id onto an array instead. No iTerm, no `bd`, no
 * `gh`, no agent, and nothing written outside a temp directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-claimqueue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
const OTHER = path.join(tmp, 'projects', 'beta');
// The worktree a claim is held from. It has to exist on disk: lib/claims.js prunes a
// record whose tree has gone, which is its second liveness signal and the decisive one.
const TREE = path.join(tmp, 'worktrees', 'alpha-abc');
for (const d of [SESSIONS, path.join(REPO, 'lib'), OTHER, TREE]) fs.mkdirSync(d, { recursive: true });
// Two real files, because a guessed path is kept only where it names something that is
// actually there — that check is the whole difference between a guess and a noun.
fs.writeFileSync(path.join(REPO, 'lib', 'advocate.js'), '// a file\n');
fs.writeFileSync(path.join(REPO, 'lib', 'claims.js'), '// another\n');

const { createAdvocates } = await import(LIB('advocate.js'));
const claims = await import(LIB('claims.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, over = {}) => ({
  id,
  title: `do the thing for ${id}`,
  priority: 2,
  issue_type: 'task',
  created_at: OLD,
  ...over,
});

/** Somebody else's session, with its hands on a file, right now. */
function holding(file, { session = 'other-session', repo = REPO, branch = 'worktree-something-else' } = {}) {
  const out = claims.claim(session, { repo, file, dir: TREE, branch, label: 'alpha' });
  assert.equal(out.decision, 'held', `the fixture itself must hold ${file}`);
  return out;
}

/**
 * One tick, over a tracker that says what the case needs it to.
 *
 * The register is process-lifetime state by design (lib/claims.js), so each case clears
 * it and states its own claims — the same slate-per-case discipline the config dir gets.
 */
async function tick({ ready = [], overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });

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
  return { opened, advocates, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

const heldIds = (card) => (card.heldByClaim || []).map((h) => h.id);
const busyIds = (card) => (card.filesBusy || []).map((h) => h.id);

/* ------------------------------------------------------------------- harness */

let failures = 0;
async function test(name, fn) {
  claims.reset();
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('claim register, read at dispatch (bc-mp8c)');

/* --------------------------------------------------------- a declared surface */

await test('a bead that declares a file another session holds gets no window', async () => {
  holding('lib/advocate.js');
  const { opened, card } = await tick({
    ready: [bead('bc-1', { surface: ['lib/advocate.js'] })],
  });
  assert.deepEqual(opened, [], 'the window must not open over a file somebody has in hand');
  assert.deepEqual(heldIds(card), ['bc-1']);
  assert.match(card.heldByClaim[0].why, /lib\/advocate\.js/, card.heldByClaim[0].why);
  assert.match(
    card.heldByClaim[0].why,
    /worktree-something-else/,
    'the worktree holding it has to be named, or the hold is a number nobody can check'
  );
  assert.match(card.heldByClaim[0].why, /declares/, 'and the sentence says how we know the bead wants it');
  assert.deepEqual(card.heldByClaim[0].files, ['lib/advocate.js']);
  assert.equal(card.heldByClaim[0].source, 'declared');
  assert.deepEqual(busyIds(card), [], 'a hold is not also a near miss');
  assert.match(card.note, /whose files another session is editing/, card.note);
});

await test('a declared surface nobody is holding dispatches', async () => {
  holding('lib/claims.js');
  const { opened, card } = await tick({
    ready: [bead('bc-1', { surface: ['lib/advocate.js'] })],
  });
  assert.deepEqual(opened, ['bc-1']);
  assert.deepEqual(heldIds(card), []);
});

await test('a surface declared as a string, not an array, is still a surface', async () => {
  holding('lib/advocate.js');
  const { opened, card } = await tick({ ready: [bead('bc-1', { surface: 'lib/advocate.js lib/claims.js' })] });
  assert.deepEqual(opened, []);
  assert.deepEqual(heldIds(card), ['bc-1']);
});

await test('a declared surface may be a glob, and a glob that matches holds', async () => {
  holding('lib/claims.js');
  const { opened, card } = await tick({ ready: [bead('bc-1', { surface: ['lib/*.js'] })] });
  assert.deepEqual(opened, [], 'bc-42ow declares a file *or glob* surface — a pattern that matched nothing would be worse than no field at all');
  assert.deepEqual(heldIds(card), ['bc-1']);
  assert.match(card.heldByClaim[0].why, /lib\/claims\.js/, 'and the sentence names the file, not the pattern');
});

await test('a glob is anchored: lib/*.js does not reach into a subdirectory', async () => {
  fs.mkdirSync(path.join(REPO, 'lib', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'lib', 'sub', 'deep.js'), '// deep\n');
  holding('lib/sub/deep.js');
  const one = await tick({ ready: [bead('bc-1', { surface: ['lib/*.js'] })] });
  assert.deepEqual(one.opened, ['bc-1'], '`*` stops at a slash');
  const two = await tick({ ready: [bead('bc-1', { surface: ['lib/**'] })] });
  assert.deepEqual(two.opened, [], 'and `**` does not');
});

/* ------------------------------------------------------------ a guessed one */

await test('a surface guessed from the bead text does NOT withhold the work', async () => {
  holding('lib/advocate.js');
  const { opened, card } = await tick({
    ready: [bead('bc-1', { description: 'The filter chain in lib/advocate.js is where this belongs.' })],
  });
  assert.deepEqual(opened, ['bc-1'], 'a guess may not hold work back — bc-hrno');
  assert.deepEqual(heldIds(card), [], 'and it must not be reported as a hold');
  assert.deepEqual(busyIds(card), ['bc-1'], 'but the collision is on the card all the same');
  assert.match(card.filesBusy[0].why, /lib\/advocate\.js/, card.filesBusy[0].why);
  assert.match(card.filesBusy[0].why, /text names/, "and it says the surface was this daemon's reading");
});

await test('holdGuessedFiles is the gate: turn it on and the guess holds too', async () => {
  holding('lib/advocate.js');
  const { opened, card } = await tick({
    ready: [bead('bc-1', { description: 'Touches lib/advocate.js and nothing else.' })],
    overrides: { holdGuessedFiles: true },
  });
  assert.deepEqual(opened, []);
  assert.deepEqual(heldIds(card), ['bc-1']);
  assert.equal(card.heldByClaim[0].source, 'guessed');
  assert.deepEqual(busyIds(card), []);
});

await test('a path in the text that is not on disk is not a file', async () => {
  holding('lib/nowhere.js');
  const { opened, card } = await tick({
    ready: [bead('bc-1', { description: 'Rewrite lib/nowhere.js from scratch.' })],
    overrides: { holdGuessedFiles: true },
  });
  assert.deepEqual(opened, ['bc-1'], 'the existence check is what makes a guess worth anything');
  assert.deepEqual(heldIds(card), []);
  assert.deepEqual(busyIds(card), []);
});

/* ------------------------------------------------- only a real claim may hold */

await test('a session that was told about a file, and did not come back, holds nothing', async () => {
  holding('lib/advocate.js', { session: 'first' });
  // The second session is refused once and recorded as `told` — it is not on the file.
  const told = claims.claim('second', { repo: REPO, file: 'lib/advocate.js', dir: TREE, branch: 'second-tree' });
  assert.equal(told.decision, 'conflict', 'the fixture must produce a told record, not a held one');
  claims.release('first');
  const { opened, card } = await tick({
    ready: [bead('bc-1', { surface: ['lib/advocate.js'] })],
    overrides: { holdGuessedFiles: true },
  });
  assert.deepEqual(opened, ['bc-1'], 'a warning is not the thing it warned about');
  assert.deepEqual(heldIds(card), []);
});

await test('a claim in another checkout is not about this bead', async () => {
  holding('lib/advocate.js', { repo: OTHER });
  const { opened, card } = await tick({ ready: [bead('bc-1', { surface: ['lib/advocate.js'] })] });
  assert.deepEqual(opened, ['bc-1']);
  assert.deepEqual(heldIds(card), []);
});

await test('a claim on a file the bead never names holds nothing', async () => {
  holding('lib/claims.js');
  const { opened, card } = await tick({
    ready: [bead('bc-1', { description: 'All of it happens in lib/advocate.js.' })],
    overrides: { holdGuessedFiles: true },
  });
  assert.deepEqual(opened, ['bc-1']);
  assert.deepEqual(heldIds(card), []);
});

await test('holdClaimedFiles: false takes the whole filter out', async () => {
  holding('lib/advocate.js');
  const { opened, card } = await tick({
    ready: [bead('bc-1', { surface: ['lib/advocate.js'] })],
    overrides: { holdClaimedFiles: false },
  });
  assert.deepEqual(opened, ['bc-1']);
  assert.deepEqual(heldIds(card), []);
  assert.deepEqual(busyIds(card), []);
});

/* ------------------------------------------------------- and nothing to release */

await test('the claim going away brings the bead back, with nothing to release', async () => {
  holding('lib/advocate.js', { session: 'other-session' });
  const first = await tick({ ready: [bead('bc-1', { surface: ['lib/advocate.js'] })] });
  assert.deepEqual(first.opened, [], 'held while the claim stands');

  // The three ways a claim ends — the session saying so, the TTL, and the tree going —
  // all come to the same thing here: the register no longer reports it, and the hold is
  // recomputed from the register rather than remembered.
  assert.equal(claims.release('other-session'), 1);
  const second = await tick({ ready: [bead('bc-1', { surface: ['lib/advocate.js'] })] });
  assert.deepEqual(second.opened, ['bc-1'], 'and dispatched the moment it does not');
  assert.deepEqual(heldIds(second.card), []);
});

await test('a claim whose worktree has gone was already not a claim', async () => {
  const gone = path.join(tmp, 'worktrees', 'alpha-gone');
  fs.mkdirSync(gone, { recursive: true });
  claims.claim('ghost', { repo: REPO, file: 'lib/advocate.js', dir: gone, branch: 'worktree-gone' });
  fs.rmSync(gone, { recursive: true, force: true });
  const { opened, card } = await tick({ ready: [bead('bc-1', { surface: ['lib/advocate.js'] })] });
  assert.deepEqual(opened, ['bc-1'], 'a tree that is no longer on disk holds nothing — lib/claims.js prunes it');
  assert.deepEqual(heldIds(card), []);
});

/* ---------------------------------------------------------------------- done */

cleanupTmp(tmp);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
