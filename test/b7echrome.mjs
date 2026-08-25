#!/usr/bin/env node
/**
 * The Chrome sweep a *human or agent* runs — `bin/b7e-chrome` over `lib/strays.js`.
 *
 *     npm test
 *     node test/b7echrome.mjs
 *
 * `test/strays.mjs` already covers the guards this is built on — the profile-not-the-name
 * match, the age floor, "the sweep does not match itself", the kill-then-remove order —
 * against an injected `ps` and a scratch `root`. This file covers the layer above it: the
 * argv, the exit codes, and whether the report a person reads actually says what
 * happened. Those are separate claims for the reason `test/atticcli.mjs` gives for the
 * same split between `lib/attic.js` and `bin/attic.js`.
 *
 * **This never touches the real machine's process table.** `lib/strays.js`'s own guard 2
 * (profile-not-name) already means nothing on this Mac outside a `beadcause-` directory
 * in `$TMPDIR` can ever match — but this repo runs upward of thirty concurrent worktrees,
 * and some of them run real, legitimate browser checks. A CLI test that reaped against the
 * real `$TMPDIR` would be exactly the incident this bead exists over, aimed at a stranger.
 * So every case here spawns `bin/b7e-chrome` with `TMPDIR` pointed at a sandbox this run
 * made: `tmpRoot()` in lib/strays.js is `os.tmpdir()` realpathed, and `os.tmpdir()` reads
 * `$TMPDIR` at the moment it is called — so the child process sees only what this file put
 * there, and every Chrome anywhere else on the machine is outside `root` and invisible to
 * it, the same guarantee `ownedBy` gives the unit tests.
 *
 * And it never launches the real Chrome, for the reason test/chromeprofile.mjs and
 * test/chromeleak.mjs both give: a stand-in is a node script named so its own basename
 * matches guard 2 ("chrom" in the executable), pointed at a `--user-data-dir` under the
 * sandbox root, that does nothing but wait — and node's own default SIGTERM handling is
 * all it needs to die on the signal this CLI sends.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PREFIX } from '../lib/strays.js';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'bin', 'b7e-chrome');

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7echrometest-'));

/* -------------------------------------------------------------- the stand-in */

/**
 * A node script whose own basename carries "chrom" — the one thing that makes a real
 * `ps` line pass guard 2 in `lib/strays.js` — and that otherwise does nothing at all.
 * No SIGTERM handler is registered, so node's own default action (terminate) is what
 * `--reap` is actually exercising; a stubborn-child escalation path is already covered
 * by test/strays.mjs's injected-`ps` cases and is not this file's job to re-derive.
 */
function writeStandIn() {
  const p = path.join(tmp, 'fake-chrome');
  fs.writeFileSync(p, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
  fs.chmodSync(p, 0o755);
  return p;
}

const STANDIN = writeStandIn();

/**
 * The same stand-in, except that it ignores `SIGTERM` — so the only thing that ends it is
 * the `SIGKILL` `killAll` escalates to, and `killAll` returns on the line after sending
 * that one. This is the only way to exercise what the CLI does in the moment right after
 * the escalation, which is where both halves of its report are decided.
 */
function writeStubbornStandIn() {
  const p = path.join(tmp, 'stubborn-chrome');
  fs.writeFileSync(p, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n");
  fs.chmodSync(p, 0o755);
  return p;
}

/** Wait out the window in which a killed child of this run is still a reapable zombie. */
async function goneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(25);
  }
  return false;
}

/** Real, live PID — no ps involved — for `kill(pid, 0)`-style liveness assertions. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn the stand-in on a fresh profile under `sandboxRoot`, and wait for the real `ps`
 * table (via a plain `listChromes` import) to actually see it — spawning is not
 * synchronous with the process table gaining a row, and every case below depends on it
 * being there before the CLI is asked to look.
 *
 * `under` puts the profile somewhere other than directly under the root, which is what
 * `scripts/checks.mjs` actually produces: one `beadcause-checkrun-XXXXXX` per run, a
 * `TMPDIR` per check inside it, and the profile inside that. Every Chrome nested that way
 * shares one `owns`, and `owns` is the unit removed — so the two cases that matter most
 * here cannot be built without it.
 */
async function startStandIn(sandboxRoot, { under = sandboxRoot, name = `${PREFIX}b7echrometest-`, exe = STANDIN } = {}) {
  const profile = fs.mkdtempSync(path.join(under, name));
  const proc = spawn(
    exe,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
    { stdio: 'ignore' },
  );
  const { listChromes } = await import('../lib/strays.js');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = await listChromes({ root: sandboxRoot });
    if (found.some((c) => c.pid === proc.pid)) break;
    await sleep(25);
  }
  return { pid: proc.pid, profile };
}

/** `bin/b7e-chrome`, spawned for real, with `TMPDIR` pointed at a sandbox of our own. */
function cli(args, sandboxRoot) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: sandboxRoot },
    });
    return { code: 0, out, err: '' };
  } catch (err) {
    return { code: err.status, out: String(err.stdout || ''), err: String(err.stderr || '') };
  }
}

/** Kill anything this run started that a case did not already reap, so nothing outlives it. */
async function reapAll(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

const started = [];

/* ------------------------------------------------------------------ argv, alone */

console.log('argv and the exit codes, before anything is spawned');

await check('--help says how to call it and exits 0', () => {
  const r = cli(['--help'], tmp);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: b7e-chrome/);
});

await check('an unknown argument is exit 2', () => {
  assert.equal(cli(['--wat'], tmp).code, 2);
});

await check('--older-than without --reap is refused, not silently ignored', () => {
  const r = cli(['--older-than', '5'], tmp);
  assert.equal(r.code, 2);
  assert.match(r.err, /only means something alongside --reap/);
});

await check('a non-numeric or negative --older-than is exit 2', () => {
  assert.equal(cli(['--reap', '--older-than', 'soon'], tmp).code, 2);
  assert.equal(cli(['--reap', '--older-than', '-1'], tmp).code, 2);
});

await check('an --older-than given no value is refused, and reaps nothing', async () => {
  // `Number('')` is 0, and a 0 here means "every Chrome at every age". Both spellings of
  // "no value" have to land on the refusal rather than on that, and the proof is a live
  // stand-in seconds old still being alive afterwards — the exit code alone would not
  // distinguish "refused" from "refused after killing something".
  const root = fs.mkdtempSync(path.join(tmp, 'root-novalue-'));
  const { pid, profile } = await startStandIn(root);
  started.push(pid);

  for (const args of [['--reap', '--older-than='], ['--reap', '--older-than']]) {
    const r = cli(args, root);
    assert.equal(r.code, 2, `${args.join(' ')} → ${r.out}`);
    assert.match(r.err, /--older-than must be a number of minutes/, r.err);
    assert.ok(alive(pid), `${args.join(' ')} must not have reaped anything`);
    assert.ok(fs.existsSync(profile), `${args.join(' ')} must not have removed a profile`);
  }

  // And a trailing `--older-than` must still trip the requires---reap check, rather than
  // being an `undefined` that both guards skip.
  assert.equal(cli(['--older-than'], root).code, 2);

  await reapAll([pid]);
  fs.rmSync(profile, { recursive: true, force: true });
});

await check('a settled sandbox lists and reaps nothing, and exits 0 either way', () => {
  const empty = fs.mkdtempSync(path.join(tmp, 'root-empty-'));
  const list = cli([], empty);
  assert.equal(list.code, 0);
  assert.equal(list.out, '');
  const reap = cli(['--reap', '--older-than', '0'], empty);
  assert.equal(reap.code, 0);
  assert.equal(reap.out, '');
});

/* -------------------------------------------------------------------- listing */

console.log('\nlisting — real process, real ps, a sandbox root');

await check('a live stand-in is listed by pid, tagged by its profile, at any age', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'root-list-'));
  const { pid, profile } = await startStandIn(root);
  started.push(pid);
  const r = cli([], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^${pid}\\s`, 'm'), r.out);
  assert.match(r.out, new RegExp(path.basename(profile)), r.out);
  assert.match(r.out, /profile on disk/, r.out);
  await reapAll([pid]);
  fs.rmSync(profile, { recursive: true, force: true });
});

/* --------------------------------------------------------------- the age floor */

console.log('\n--reap, and the floor it will not go under by default');

await check('a freshly-started stand-in survives a bare --reap — it is nowhere near an hour old', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'root-floor-'));
  const { pid, profile } = await startStandIn(root);
  started.push(pid);
  const r = cli(['--reap'], root);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '', 'the age floor is the whole safety margin, and it applied here');
  assert.ok(alive(pid), 'a young Chrome must not be signalled by a bare --reap');
  assert.ok(fs.existsSync(profile), 'nor its profile removed');
  await reapAll([pid]);
  fs.rmSync(profile, { recursive: true, force: true });
});

/* ----------------------------------------------------------- --older-than past it */

console.log('\n--older-than, the one way past the floor');

await check('--older-than 0 reaps a stand-in seconds old, and removes its profile', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'root-reap-'));
  const { pid, profile } = await startStandIn(root);
  started.push(pid);

  const r = cli(['--reap', '--older-than', '0'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^${pid}\\s.*reaped`, 'm'), r.out);

  const dead = await (async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!alive(pid)) return true;
      await sleep(25);
    }
    return false;
  })();
  assert.ok(dead, 'the stand-in must actually be gone, not merely reported gone');
  assert.equal(fs.existsSync(profile), false, "and its profile must go with it — that is what 'ends it' means");
});

await check('a second call afterwards finds nothing — the settled state', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'root-second-'));
  const { pid, profile } = await startStandIn(root);
  started.push(pid);
  cli(['--reap', '--older-than', '0'], root);
  await sleep(100);
  const r = cli([], root);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '', r.out);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});

/* ------------------------------------------- guard 3, over a shared run directory */

console.log('\nthe directory a live Chrome is still on, whatever else was under it');

await check('reaping the old Chrome in a run directory leaves the young one and its run intact', async () => {
  // The shape scripts/checks.mjs makes and test/strays.mjs pins: one run directory, a
  // per-check TMPDIR inside it, a profile inside that. Both Chromes therefore have the
  // *same* `owns` — and `owns` is what gets removed — so a reap that decides by pid alone
  // deletes the live check's profile, and the run directory around it, out from under it.
  // This is the likeliest use of --older-than there is: an agent ending the Chrome its own
  // check just leaked while the rest of the run is still going.
  const root = fs.mkdtempSync(path.join(tmp, 'root-shared-'));
  const run = fs.mkdtempSync(path.join(root, `${PREFIX}checkrun-`));
  const oldScratch = fs.mkdtempSync(path.join(run, 'old-check-'));
  const youngScratch = fs.mkdtempSync(path.join(run, 'young-check-'));

  const older = await startStandIn(root, { under: oldScratch, name: `${PREFIX}old-` });
  started.push(older.pid);
  // Real processes, so the age gap has to be a real one. `etime` counts whole seconds and
  // --older-than below is 3s, which leaves this either side of it by a clear margin.
  await sleep(5000);
  const younger = await startStandIn(root, { under: youngScratch, name: `${PREFIX}young-` });
  started.push(younger.pid);

  const r = cli(['--reap', '--older-than', '0.05'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^${older.pid}\\s.*reaped`, 'm'), r.out);
  assert.doesNotMatch(r.out, new RegExp(`^${younger.pid}\\s`, 'm'), 'the young one was never a target');

  assert.ok(alive(younger.pid), 'the young Chrome must not have been signalled');
  assert.ok(fs.existsSync(younger.profile), 'and its profile must still be there');
  assert.ok(fs.existsSync(run), 'nor may the run directory around it be removed');

  await reapAll([older.pid, younger.pid]);
});

/* -------------------------------------------------- what the tag column names */

await check('a nested profile is tagged by the check that made it, not only by the run', async () => {
  // `owns` is the run, and every check of one run shares it — so a column that prints only
  // `basename(owns)` says the same word about all of them. The bead asks for "the prefix and
  // therefore which check left it", and that is the profile's own name.
  const root = fs.mkdtempSync(path.join(tmp, 'root-tag-'));
  const run = fs.mkdtempSync(path.join(root, `${PREFIX}checkrun-`));
  const scratch = fs.mkdtempSync(path.join(run, 'space-check-'));
  const { pid, profile } = await startStandIn(root, { under: scratch, name: `${PREFIX}space-` });
  started.push(pid);

  const r = cli([], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(path.basename(profile)), r.out);
  assert.match(r.out, new RegExp(path.basename(run)), r.out);

  await reapAll([pid]);
  fs.rmSync(run, { recursive: true, force: true });
});

/* --------------------------------------- reporting the one that needed a SIGKILL */

await check('a Chrome that only SIGKILL could end is reported reaped, and its profile goes', async () => {
  // `killAll` waits out its grace, sends the SIGKILL and returns immediately — so the
  // confirming read of the process table happens in the moment a just-killed process can
  // still hold a `ps` row. Reading it there costs twice, and both costs are visible from
  // outside: the line says it refused a signal it did not refuse, and its profile is held
  // back from the removal pass and left on disk. The timing is a race and this does not
  // pretend to force it — pre-fix it fails often and not always. What it pins either way
  // is the outcome, which with the settle in place does not depend on the timing at all.
  const root = fs.mkdtempSync(path.join(tmp, 'root-stubborn-'));
  const { pid, profile } = await startStandIn(root, { exe: writeStubbornStandIn() });
  started.push(pid);

  const r = cli(['--reap', '--older-than', '0'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^${pid}\\s.*reaped`, 'm'), r.out);
  assert.doesNotMatch(r.out, /refused the signal/, r.out);
  assert.equal(fs.existsSync(profile), false, 'the profile of something that did go must go with it');
  // Polled, not asserted flat: this run spawned the stand-in, so between the SIGKILL
  // landing and this process reaping the child it is a zombie, and `kill(pid, 0)` says yes
  // to a zombie. That is a fact about who its parent is and not about the CLI.
  assert.ok(await goneWithin(pid, 3000), 'and it really did go — the SIGKILL landed');

  await reapAll([pid]);
});

/* -------------------------------------------------------------------- the end */

await reapAll(started);
await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
