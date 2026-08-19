/**
 * A cleanup that runs when the process is *signalled* — lib/teardown.js, bc-5isv.
 *
 * The claim being tested is one sentence and it is the whole first half of that bead: a
 * headless Chrome does not survive the run that started it, **including when the run is
 * interrupted**. Every check in this repo already tore its Chrome down in a `finally`,
 * and that is exactly what was true on the day fifteen orphaned Chromes and 15 GB of
 * abandoned profiles were counted on this Mac — because a `finally` does not run on a
 * signal, and a signal is how a check dies when something has gone wrong.
 *
 * So the assertions are all about the ending nobody writes a test for. Three of them, in
 * increasing weight:
 *
 * 1. **The mechanism**: a child that registers `onExit` and is then `SIGTERM`ed runs it,
 *    and dies of the signal it was sent rather than of an exit code that hides which one
 *    it was. The second half matters because listening for a signal *disables* Node's
 *    default action for it — a handler that forgot to re-raise would leave a process
 *    calmly ignoring `SIGTERM`, which is worse than the leak.
 * 2. **Exactly once**: a run that tears down normally and is then signalled does not tear
 *    down twice. The second `rmSync` of a path already gone is harmless; the second
 *    `kill` of a recycled pid is not.
 * 3. **The real thing**: `launchChrome` from scripts/helpers/chrome.mjs, in a child that
 *    is killed mid-check. Afterwards there is no Chrome on that profile and no profile.
 *    Skipped, loudly, on a machine with no Chrome — `npm run checks` is where Chrome is
 *    assumed, not `npm test`.
 *
 * Every process this starts is its own child on its own scratch profile, and every one is
 * waited on. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CHROME } from '../scripts/helpers/chrome.mjs';
import { listChromes } from '../lib/strays.js';
import { cleanupTmp } from './helpers/tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-teardown-'));

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write a child script into the scratch tree and hand back its path. */
function script(name, body) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body);
  return p;
}

/** Wait for `{ code, signal }`, so an assertion about how a child died is a real one. */
const ended = (proc) => new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));

/** Poll until `fn()` or the deadline — a signalled child's last writes are not instant. */
async function until(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

/* -------------------------------------------------------------- the mechanism */

await check('a teardown registered with onExit runs when the process is SIGTERMed', async () => {
  const marker = path.join(tmp, 'terminated.marker');
  const child = spawn(
    process.execPath,
    [
      script(
        'sigterm-child.mjs',
        `import fs from 'node:fs';
         import { onExit } from '${path.join(ROOT, 'lib', 'teardown.js')}';
         onExit(() => fs.writeFileSync(${JSON.stringify(marker)}, 'ran'));
         console.log('armed');
         setInterval(() => {}, 1000);`
      ),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  await new Promise((r) => child.stdout.once('data', r));
  child.kill('SIGTERM');
  const how = await ended(child);
  assert.equal(fs.existsSync(marker), true, 'the finally-shaped arm never ran');
  // And it died of the signal, not of an exit code that loses which one it was — the
  // handler has to re-raise, because listening for a signal disables the default action.
  assert.equal(how.signal, 'SIGTERM', `died as ${JSON.stringify(how)}`);
});

await check('and when it is Ctrl-C — SIGINT and SIGHUP are the same abandonment', async () => {
  for (const sig of ['SIGINT', 'SIGHUP']) {
    const marker = path.join(tmp, `${sig}.marker`);
    const child = spawn(
      process.execPath,
      [
        script(
          `${sig}-child.mjs`,
          `import fs from 'node:fs';
           import { onExit } from '${path.join(ROOT, 'lib', 'teardown.js')}';
           onExit(() => fs.writeFileSync(${JSON.stringify(marker)}, 'ran'));
           console.log('armed');
           setInterval(() => {}, 1000);`
        ),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise((r) => child.stdout.once('data', r));
    child.kill(sig);
    const how = await ended(child);
    assert.equal(fs.existsSync(marker), true, `${sig}: the teardown never ran`);
    assert.equal(how.signal, sig, `${sig}: died as ${JSON.stringify(how)}`);
  }
});

await check('an uncaught throw is covered too — the other ending a finally would have caught', async () => {
  const marker = path.join(tmp, 'threw.marker');
  const child = spawn(
    process.execPath,
    [
      script(
        'throw-child.mjs',
        `import fs from 'node:fs';
         import { onExit } from '${path.join(ROOT, 'lib', 'teardown.js')}';
         onExit(() => fs.writeFileSync(${JSON.stringify(marker)}, 'ran'));
         throw new Error('the check failed');`
      ),
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );
  const how = await ended(child);
  assert.notEqual(how.code, 0, 'the throw should still be a failure');
  assert.equal(fs.existsSync(marker), true);
});

await check('exactly once — a normal teardown followed by a signal does not run it twice', async () => {
  const counter = path.join(tmp, 'twice.count');
  const child = spawn(
    process.execPath,
    [
      script(
        'once-child.mjs',
        `import fs from 'node:fs';
         import { onExit } from '${path.join(ROOT, 'lib', 'teardown.js')}';
         const bump = () => fs.appendFileSync(${JSON.stringify(counter)}, 'x');
         const off = onExit(bump);
         // The ordinary path: the check finished, its finally ran, it said so.
         off();
         bump();
         console.log('done');
         setInterval(() => {}, 1000);`
      ),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  await new Promise((r) => child.stdout.once('data', r));
  child.kill('SIGTERM');
  await ended(child);
  assert.equal(fs.readFileSync(counter, 'utf8'), 'x', 'the exit handler ran on top of the finally');
});

/* ------------------------------------------------------------- the real thing */

const haveChrome = fs.existsSync(CHROME);

await check('a check killed mid-run leaves no headless Chrome and no profile behind', async () => {
  if (!haveChrome) {
    // Loud rather than silent: a skip nobody can see is a check that quietly stopped
    // covering the thing it was written for.
    console.log(`       SKIPPED — no Chrome at ${CHROME}; npm run checks is where Chrome is assumed`);
    return;
  }
  const portFile = path.join(tmp, 'launched.json');
  const child = spawn(
    process.execPath,
    [
      script(
        'chrome-child.mjs',
        `import fs from 'node:fs';
         import { launchChrome } from '${path.join(ROOT, 'scripts', 'helpers', 'chrome.mjs')}';
         const { port, profile } = await launchChrome('beadcause-teardowncheck-');
         fs.writeFileSync(${JSON.stringify(portFile)}, JSON.stringify({ port, profile }));
         console.log('up');
         // Whatever the check would have done next. It never gets there.
         setInterval(() => {}, 1000);`
      ),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  await new Promise((r) => child.stdout.once('data', r));
  const { profile } = JSON.parse(fs.readFileSync(portFile, 'utf8'));
  assert.equal(fs.existsSync(profile), true, 'the profile should exist while the check is running');
  // The control: without the guard, this is the moment everything is lost.
  const before = (await listChromes()).filter((c) => c.profile === profile);
  assert.ok(before.length, 'no Chrome was actually running on that profile — the test proves nothing');

  child.kill('SIGTERM');
  await ended(child);

  assert.ok(await until(async () => !fs.existsSync(profile)), `the profile survived the signal: ${profile}`);
  assert.ok(
    await until(async () => (await listChromes()).every((c) => c.profile !== profile)),
    'a headless Chrome outlived the run that started it'
  );
});

/* -------------------------------------------------------------------- the end */

// Nothing above should have left a Chrome on this scratch tree, and if the assertions
// above are wrong about that, this is the arm that keeps the failure from becoming
// another entry in the pile the bead is about.
if (haveChrome) {
  for (const c of await listChromes()) {
    if (!c.profile.startsWith(tmp)) continue;
    try {
      execFileSync('/bin/kill', ['-9', String(c.pid)]);
    } catch {
      /* already gone */
    }
  }
}
await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
