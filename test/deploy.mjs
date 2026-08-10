/**
 * Deploying a repo — with real git, real detached processes, and nothing restarted.
 *
 * The failures worth a test here are not "does it run a command". They are the five
 * ways a deploy can lie:
 *
 * 1. **It guessed.** A repo with no declaration must have no deploy, and a declaration
 *    that is present and malformed must refuse rather than improvise. The specific
 *    thing being kept out is a shell: `command` is argv, and a string has to be an
 *    error and not a `sh -c`.
 * 2. **It merged over somebody.** Six sessions edit these checkouts. A dirty tree has
 *    to stop the whole deploy *before* anything is built or restarted — proved here by
 *    the deploy command's marker file never appearing.
 * 3. **It waited.** `startDeploy` cannot await the deploy, because on this repo the
 *    deploy kills the caller. So it has to come back long before the command finishes,
 *    and the assertion is a clock.
 * 4. **Silence read as success.** A runner that vanishes must settle to `lost`, and a
 *    runner killed at the deploy step of a restart must settle to `unconfirmed` — never
 *    to `ok`, and never left `deploying` forever. Both are simulated with dead pids,
 *    because the real version of this test would restart the daemon running it.
 * 5. **It said so twice, or never.** The announcement is a marker on disk precisely so
 *    it survives the daemon being replaced by the deploy it is reporting on.
 *
 * No launchctl, no fly, no network. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-deploy-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const {
  deployFor,
  deployable,
  deployHint,
  startDeploy,
  listDeploys,
  showDeploy,
  runningFor,
  sweepDeploys,
  unannounced,
  markAnnounced,
  DEPLOY_DIR,
} = await import(LIB('deploy.js'));

/* ------------------------------------------------------------------ fixtures */

const git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // `git clone` of the empty bare repo warns on stderr; it is expected and it is not
    // this suite's job to print it.
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });

/**
 * An origin and a checkout of it, so the fast-forward under test is a real one.
 *
 * A fake `git` would prove nothing here: the interesting behaviours — refusing a dirty
 * tree, refusing a non-fast-forward, working out which paths a merge moved — are all
 * git's answers, and the point is that this file asks for them correctly.
 */
function repo(name) {
  const origin = path.join(tmp, `${name}.git`);
  const work = path.join(tmp, `${name}-seed`);
  const checkout = path.join(tmp, name);
  git(tmp, ['init', '--bare', '--initial-branch=main', origin]);
  git(tmp, ['clone', '--quiet', origin, work]);
  fs.writeFileSync(path.join(work, 'README.md'), 'one\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'first']);
  git(work, ['push', '--quiet', 'origin', 'main']);
  git(tmp, ['clone', '--quiet', origin, checkout]);
  return { origin, work, checkout };
}

/** Move `origin/main` on, so the checkout has something to fast-forward to. */
function advance(r, files, message = 'more') {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(r.work, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  git(r.work, ['add', '-A']);
  git(r.work, ['commit', '--quiet', '-m', message]);
  git(r.work, ['push', '--quiet', 'origin', 'main']);
}

/** A node one-liner as argv. Never a shell — that is the thing being kept out. */
const node = (code) => [process.execPath, '-e', code];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a runner to reach a settled status, or say what it was stuck on. */
async function settled(id, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const rec = showDeploy(id);
    if (rec && !['queued', 'pulling', 'building', 'deploying'].includes(rec.status)) return rec;
    await sleep(100);
  }
  const rec = showDeploy(id);
  throw new Error(`deploy ${id} never settled (stuck at ${rec?.status}: ${JSON.stringify(rec?.steps?.slice(-1))})`);
}

/** A pid that certainly belongs to nobody: one we started and reaped ourselves. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((r) => child.on('exit', r));
  // A moment for the kernel to be done with it, so `kill(pid, 0)` is honest.
  await sleep(50);
  return pid;
}

const config = (deploys, dirs) => ({
  workspaces: Object.keys(dirs).map((name) => ({ name, dir: path.join(tmp, 'beads', name, '.beads') })),
  sessionDirs: dirs,
  pr: { base: 'main' },
  deploys,
});

/* --------------------------------------------------------------------- harness */

let ran = 0;
let failures = 0;
async function check(what, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${what}`);
  } catch (err) {
    failures += 1;
    console.error(`  \x1b[31m✗\x1b[0m ${what}\n    ${err.message}`);
  }
}

/* ---------------------------------------------------------------- declarations */

console.log('\ndeclarations');

await check('a workspace with no entry has no deploy, and that is not an error', () => {
  const cfg = config({}, { demo: tmp });
  assert.equal(deployFor(cfg, 'demo'), null);
  assert.deepEqual(deployable(cfg), []);
});

await check('a shell string where argv belongs is refused, not run', () => {
  const cfg = config({ demo: { command: 'launchctl kickstart -k gui/501/x' } }, { demo: tmp });
  assert.throws(() => deployFor(cfg, 'demo'), /argv, not a shell line/);
});

await check('an empty command is refused too', () => {
  assert.throws(() => deployFor(config({ demo: { command: [] } }, { demo: tmp }), 'demo'), /non-empty array/);
});

await check('a broken declaration does not take the other repos off the list', () => {
  const cfg = config({ demo: { command: 'nope' }, other: { command: ['true'] } }, { demo: tmp, other: tmp });
  assert.deepEqual(deployable(cfg), ['other']);
});

await check('the placeholders that exist expand, and the ones that do not are left alone', () => {
  const cfg = config({ demo: { command: ['launchctl', 'kickstart', '-k', 'gui/{uid}/m4m.x', '{dir}', '{base}', '{nope}'] } }, { demo: tmp });
  const plan = deployFor(cfg, 'demo');
  assert.deepEqual(plan.command.slice(3), [`gui/${os.userInfo().uid}/m4m.x`, tmp, 'main', '{nope}']);
});

await check('the directory comes from sessionDirs when the declaration names none', () => {
  const r = repo('dirs');
  const plan = deployFor(config({ demo: { command: ['true'] } }, { demo: r.checkout }), 'demo');
  assert.equal(plan.dir, path.resolve(r.checkout));
});

await check('and the declaration wins when it names one', () => {
  const r = repo('dirs2');
  const plan = deployFor(config({ demo: { command: ['true'], dir: r.checkout } }, { demo: tmp }), 'demo');
  assert.equal(plan.dir, path.resolve(r.checkout));
});

/* ------------------------------------------------------------------- the hint */

// What the Ship button on a delivery card says it will do. The failure worth a test is
// a hint that reads the same for every repo: `fly deploy` and a launchd SIGKILL of the
// daemon you are holding are not the same offer, and the button is where that is said.

await check('a repo with no deploy has no hint, which is what stops the button being drawn', () => {
  assert.equal(deployHint(null), '');
  assert.equal(deployHint(deployFor(config({}, { demo: tmp }), 'demo')), '');
});

await check('the hint names the command, every rebuild, and the restart', () => {
  const cfg = config(
    {
      demo: {
        command: ['launchctl', 'kickstart', '-k', 'gui/{uid}/m4m.demo'],
        restarts: true,
        rebuild: [{ label: 'apk', when: ['android'], command: ['true'] }],
      },
    },
    { demo: tmp }
  );
  assert.equal(deployHint(deployFor(cfg, 'demo')), 'runs `launchctl` · rebuilds apk · restarts beadcause');
});

await check('a repo that does not restart beadcause does not claim to', () => {
  const cfg = config({ demo: { command: ['fly', 'deploy'] } }, { demo: tmp });
  assert.equal(deployHint(deployFor(cfg, 'demo')), 'runs `fly`');
});

/* ---------------------------------------------------------------- a real deploy */

console.log('\na deploy that works');

const green = repo('green');
const marker = path.join(tmp, 'green-deployed');

await check('the checkout is fast-forwarded and the command runs against the merged tree', async () => {
  advance(green, { 'lib/thing.js': 'export const x = 1;\n' });
  const cfg = config(
    {
      green: {
        command: node(`require('fs').writeFileSync(${JSON.stringify(marker)}, require('fs').readFileSync('lib/thing.js','utf8'))`),
        graceMs: 0,
      },
    },
    { green: green.checkout }
  );
  const rec = await settled(startDeploy(cfg, 'green', { bead: 'bc-3ie', reason: 'test' }).id);
  assert.equal(rec.status, 'ok', rec.error || '');
  assert.notEqual(rec.from, rec.to);
  assert.deepEqual(rec.changed, ['lib/thing.js']);
  // The marker holds the *new* file's contents, which is the whole point: the command
  // ran after the fast-forward, not before it.
  assert.equal(fs.readFileSync(marker, 'utf8'), 'export const x = 1;\n');
  assert.equal(rec.bead, 'bc-3ie');
});

await check('every step it ran is on the record, with its exit code', () => {
  const rec = listDeploys()[0];
  assert.ok(rec.steps.length >= 4, `only ${rec.steps.length} steps recorded`);
  assert.deepEqual(new Set(rec.steps.map((s) => s.code)), new Set([0]));
  assert.equal(rec.steps.at(-1).name, 'deploy');
});

/* ------------------------------------------------------------------- rebuilding */

console.log('\nrebuilding what moved');

const built = path.join(tmp, 'apk-built');

async function rebuildRun(name, changedFile) {
  const r = repo(name);
  advance(r, { [changedFile]: 'moved\n' });
  const cfg = config(
    {
      [name]: {
        command: node('0'),
        graceMs: 0,
        rebuild: [{ label: 'apk', when: ['android'], command: node(`require('fs').writeFileSync(${JSON.stringify(built)}, '${name}')`) }],
      },
    },
    { [name]: r.checkout }
  );
  return settled(startDeploy(cfg, name, {}).id);
}

await check('a rebuild whose paths did not move does not run', async () => {
  fs.rmSync(built, { force: true });
  const rec = await rebuildRun('nomove', 'lib/other.js');
  assert.equal(rec.status, 'ok', rec.error || '');
  assert.equal(fs.existsSync(built), false, 'the APK was rebuilt for a change that never touched android/');
  assert.equal(rec.steps.some((s) => s.name === 'apk'), false);
});

await check('and one whose paths did move, does', async () => {
  const rec = await rebuildRun('moved', 'android/app/build.gradle');
  assert.equal(rec.status, 'ok', rec.error || '');
  assert.equal(fs.readFileSync(built, 'utf8'), 'moved');
  assert.equal(rec.steps.some((s) => s.name === 'apk'), true);
});

await check('a rebuild that fails stops the deploy before anything is restarted', async () => {
  const r = repo('badbuild');
  advance(r, { 'android/x': 'y\n' });
  const never = path.join(tmp, 'badbuild-deployed');
  const cfg = config(
    {
      badbuild: {
        command: node(`require('fs').writeFileSync(${JSON.stringify(never)}, 'x')`),
        graceMs: 0,
        rebuild: [{ label: 'apk', when: ['android'], command: node('process.exit(3)') }],
      },
    },
    { badbuild: r.checkout }
  );
  const rec = await settled(startDeploy(cfg, 'badbuild', {}).id);
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /apk failed \(exit 3\)/);
  assert.equal(fs.existsSync(never), false, 'the deploy ran after its rebuild had failed');
});

/* ---------------------------------------------------------------- refusing to act */

console.log('\nwhat it refuses to do');

await check('uncommitted work in the checkout stops the deploy dead', async () => {
  const r = repo('dirty');
  advance(r, { 'lib/a.js': 'a\n' });
  fs.writeFileSync(path.join(r.checkout, 'README.md'), 'edited by a session, not committed\n');
  const never = path.join(tmp, 'dirty-deployed');
  const cfg = config({ dirty: { command: node(`require('fs').writeFileSync(${JSON.stringify(never)}, 'x')`), graceMs: 0 } }, { dirty: r.checkout });
  const rec = await settled(startDeploy(cfg, 'dirty', {}).id);
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /uncommitted work/);
  assert.equal(fs.existsSync(never), false, 'it deployed over somebody’s work');
  // And it left the edit exactly where it was.
  assert.match(fs.readFileSync(path.join(r.checkout, 'README.md'), 'utf8'), /not committed/);
});

await check('a checkout that has diverged is not merged, it is reported', async () => {
  const r = repo('diverged');
  advance(r, { 'lib/a.js': 'origin\n' });
  fs.writeFileSync(path.join(r.checkout, 'lib.js'), 'local only\n');
  git(r.checkout, ['add', '-A']);
  git(r.checkout, ['commit', '--quiet', '-m', 'local']);
  const cfg = config({ diverged: { command: node('0'), graceMs: 0 } }, { diverged: r.checkout });
  const rec = await settled(startDeploy(cfg, 'diverged', {}).id);
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /cannot fast-forward/);
});

await check('a deploy command that exits non-zero is a failure, whatever it printed', async () => {
  const r = repo('badcmd');
  const cfg = config({ badcmd: { command: node('console.log("Deploy successful!"); process.exit(1)'), graceMs: 0, pull: false } }, { badcmd: r.checkout });
  const rec = await settled(startDeploy(cfg, 'badcmd', {}).id);
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /exit 1/);
  assert.match(rec.steps.at(-1).output, /Deploy successful/);
});

await check('a command that is not there fails rather than counting as done', async () => {
  const r = repo('missing');
  const cfg = config({ missing: { command: ['/nonexistent/deploy-me'], graceMs: 0, pull: false } }, { missing: r.checkout });
  const rec = await settled(startDeploy(cfg, 'missing', {}).id);
  assert.equal(rec.status, 'failed');
  assert.equal(rec.steps.at(-1).code, 127);
});

await check('two deploys of one repo at once are refused', async () => {
  const r = repo('busy');
  const cfg = config({ busy: { command: node('setTimeout(()=>{}, 4000)'), graceMs: 0, pull: false } }, { busy: r.checkout });
  const first = startDeploy(cfg, 'busy', {});
  assert.throws(() => startDeploy(cfg, 'busy', {}), /already running/);
  assert.equal(runningFor('busy').id, first.id);
  await settled(first.id);
  assert.equal(runningFor('busy'), null);
});

/* ------------------------------------------------------------ it does not wait */

console.log('\nit does not wait for the deploy');

await check('startDeploy returns while the command is still running', async () => {
  const r = repo('slow');
  const cfg = config({ slow: { command: node('setTimeout(()=>{}, 3000)'), graceMs: 0, pull: false } }, { slow: r.checkout });
  const t0 = Date.now();
  const rec = startDeploy(cfg, 'slow', {});
  const took = Date.now() - t0;
  assert.ok(took < 1500, `startDeploy took ${took}ms — it is waiting for something`);
  // And the record is already on disk, so a caller killed a moment later still left a
  // trace of what it asked for.
  assert.equal(showDeploy(rec.id).id, rec.id);
  await settled(rec.id, 20000);
});

/* --------------------------------------------------------- silence is not success */

console.log('\nsilence is never success');

await check('a runner killed at the deploy step of a restart settles to unconfirmed', async () => {
  const id = 'd-fake-restart';
  fs.writeFileSync(
    path.join(DEPLOY_DIR, `${id}.json`),
    JSON.stringify({ id, workspace: 'beadcause', status: 'deploying', restarts: true, pid: await deadPid(), requestedAt: new Date().toISOString(), steps: [] })
  );
  const settledNow = sweepDeploys().find((r) => r.id === id);
  assert.equal(settledNow.status, 'unconfirmed');
  assert.match(settledNow.error, /did not outlive it/);
});

await check('a runner that vanished anywhere else settles to lost', async () => {
  const id = 'd-fake-lost';
  fs.writeFileSync(
    path.join(DEPLOY_DIR, `${id}.json`),
    JSON.stringify({ id, workspace: 'x', status: 'building', restarts: false, pid: await deadPid(), requestedAt: new Date().toISOString(), steps: [] })
  );
  assert.equal(sweepDeploys().find((r) => r.id === id).status, 'lost');
});

await check('a record that never got a pid is given a grace, then called lost', () => {
  const young = 'd-fake-young';
  const old = 'd-fake-old';
  const rec = (id, at) => ({ id, workspace: 'x', status: 'queued', restarts: false, pid: null, requestedAt: at, steps: [] });
  fs.writeFileSync(path.join(DEPLOY_DIR, `${young}.json`), JSON.stringify(rec(young, new Date().toISOString())));
  fs.writeFileSync(path.join(DEPLOY_DIR, `${old}.json`), JSON.stringify(rec(old, new Date(Date.now() - 120000).toISOString())));
  const out = sweepDeploys();
  assert.equal(out.find((r) => r.id === young), undefined, 'a deploy was called lost before its runner had time to exec');
  assert.equal(out.find((r) => r.id === old).status, 'lost');
  assert.match(showDeploy(old).error, /never started/);
});

await check('sweeping again does not re-settle what is already settled', async () => {
  assert.deepEqual(sweepDeploys(), []);
});

await check('an unreadable record is left out rather than read as anything', () => {
  fs.writeFileSync(path.join(DEPLOY_DIR, 'd-corrupt.json'), '{ not json');
  assert.equal(listDeploys().some((r) => r.id === 'd-corrupt'), false);
  assert.equal(showDeploy('d-corrupt'), null);
  // And it is not something to announce either — there is nothing true to say about it.
  assert.equal(unannounced().some((r) => r.id === 'd-corrupt'), false);
});

/* -------------------------------------------------------------- announcing once */

console.log('\nannouncing, once');

await check('a settled deploy is announceable exactly once', () => {
  const pending = unannounced();
  assert.ok(pending.length, 'nothing to announce, after all those deploys');
  for (const rec of pending) markAnnounced(rec.id);
  assert.deepEqual(unannounced(), []);
});

await check('a deploy still running is not announced', async () => {
  const r = repo('inflight');
  const cfg = config({ inflight: { command: node('setTimeout(()=>{}, 2500)'), graceMs: 0, pull: false } }, { inflight: r.checkout });
  const rec = startDeploy(cfg, 'inflight', {});
  assert.equal(unannounced().some((x) => x.id === rec.id), false);
  await settled(rec.id, 20000);
  assert.equal(unannounced().some((x) => x.id === rec.id), true);
});

/* --------------------------------------------------------------------- exit */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
