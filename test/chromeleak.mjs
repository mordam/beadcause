#!/usr/bin/env node
/**
 * A killed session may not leave a headless Chrome behind.
 *
 *     npm test
 *     node test/chromeleak.mjs
 *
 * Both launchers clean up on every path through their own code, and neither could do
 * anything about the path that skips their code entirely: the node process being killed.
 * A Claude Code session that is closed, or reaped by lib/reap.js, or stopped mid-turn,
 * takes a SIGTERM; Chrome is a plain child, so nothing signals it, and it is reparented
 * to pid 1 and runs until the machine reboots.
 *
 * **The cost is not a stray background process, which is why this suite exists at all.**
 * macOS LaunchServices counts a `--headless` instance as a running `com.google.Chrome`,
 * so once one is orphaned, opening Chrome.app only *activates* the headless one: no
 * window, Cmd-Q apparently ignored, and force quitting the frontmost leaves the rest. On
 * 2026-08-18 five of them — profiles named `beadcause-measure-*`, the oldest from the
 * previous evening — made it impossible to open a browser on this Mac at all (bc-1eru).
 *
 * So this measures the real thing rather than the wiring: a child node process is put
 * into `launchChrome`, killed with a signal, and the tree it left behind is inspected by
 * pid. Chrome itself is never launched — `npm test` does not have Chrome as a dependency
 * and test/chromeport.mjs already argues that it should not become one. A stand-in that
 * writes down its own pid and then sleeps is enough, because the thing under test is
 * whether *something spawned* is killed, and Chrome's own behaviour is not in question.
 *
 * **The SIGKILL case is the control, and it is expected to leak.** SIGKILL cannot be
 * caught by anything, so a run that reports the stand-in gone after one would be
 * reporting on a detector that cannot tell alive from dead — and would then pass just as
 * happily with the trap deleted. It is the same argument test/chromeport.mjs makes with
 * its `OLD`/`NEW` controls, done against a live process instead of a string.
 *
 * **The mechanism under test is `lib/teardown.js`.** bc-1eru and bc-5isv reached the same
 * missing arm from opposite ends — a killed session here, a signalled check there — and
 * `onExit`/`killAndRemoveSync` is the one registry both settled on, so this suite points
 * at it rather than at a second copy. What it adds over test/teardown.mjs is that it needs
 * no Chrome: a stand-in binary means the pid-level measurement runs inside `npm test`
 * rather than only where a browser is assumed. The static scan at the bottom is the other
 * half — a third launcher written by copying one of these two is caught by the audit, not
 * by somebody noticing their browser will not open.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { onExit, armed } from '../lib/teardown.js';
import { launchChrome } from '../scripts/helpers/chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TMP = fs.realpathSync(os.tmpdir());

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log('\nheadless chrome outliving its session\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Signal 0 asks the kernel whether a pid exists without touching it. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
};

/**
 * Make sure one stand-in and its directory are gone, whatever happened above.
 *
 * `kill` returns as soon as the signal is queued, not once the process is off the table,
 * so death is waited for rather than asserted on the next line — the difference is a
 * flake that only shows up on a loaded machine.
 */
async function reap(pid, profile) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  const dead = await until(() => !alive(pid), 5000);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  return Boolean(dead) && !fs.existsSync(profile);
}

/* --------------------------------------------------------------- the fixtures */

const rig = fs.mkdtempSync(path.join(TMP, 'beadcause-leakrig-'));

/**
 * The stand-in for Chrome: record the pid, in the profile Chrome was pointed at, and
 * then never exit.
 *
 * It deliberately never writes `DevToolsActivePort`, so `launchChrome` stays inside its
 * launch wait for the whole test. That is the worst moment for the process to be killed
 * — the browser is running and no caller has a `close()` for it yet — which is exactly
 * the window the old code could not cover.
 */
const FAKE = path.join(rig, 'fake-chrome');
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require('node:fs');
const flag = process.argv.find((a) => a.startsWith('--user-data-dir='));
fs.writeFileSync(flag.slice('--user-data-dir='.length) + '/fake.pid', String(process.pid));
setInterval(() => {}, 1000);
`,
);
fs.chmodSync(FAKE, 0o755);

const CHILD = path.join(rig, 'child.mjs');
fs.writeFileSync(
  CHILD,
  `import { launchChrome } from ${JSON.stringify(path.join(ROOT, 'scripts', 'helpers', 'chrome.mjs'))};
await launchChrome('beadcause-leaktest-', { chrome: ${JSON.stringify(FAKE)}, timeoutMs: 120000 });
`,
);

/** Start a child mid-launch and wait until its stand-in browser has said which pid it is. */
async function startVictim() {
  const child = spawn(process.execPath, [CHILD], { stdio: 'ignore' });
  const found = await until(() => {
    for (const d of fs.readdirSync(TMP).filter((f) => f.startsWith('beadcause-leaktest-'))) {
      const pidFile = path.join(TMP, d, 'fake.pid');
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (pid && alive(pid)) return { profile: path.join(TMP, d), pid };
      } catch {
        /* not written yet, or another run's directory */
      }
    }
    return null;
  }, 20_000);
  return { child, ...(found || {}) };
}

/* ------------------------------------------------------- SIGTERM: the real case */

{
  const { child, profile, pid } = await startVictim();
  if (!pid) {
    bad('the fixture reaches a running browser', 'no beadcause-leaktest-*/fake.pid appeared in 20s');
    try {
      child.kill('SIGKILL');
    } catch {
      /* never started */
    }
  } else {
    child.kill('SIGTERM');
    const dead = await until(() => !alive(pid), 10_000);
    if (dead) ok('a SIGTERMed session kills the browser it launched');
    else bad('a SIGTERMed session kills the browser it launched', `pid ${pid} is still running`);

    const swept = await until(() => !fs.existsSync(profile), 10_000);
    if (swept) ok('and takes the throwaway profile with it');
    else bad('and takes the throwaway profile with it', profile);

    // A failing run of this suite is a run in which the leak is real, and a leak
    // detector that leaves its own subjects running is no better than the bug.
    await reap(pid, profile);

    const code = await until(() => (child.exitCode != null || child.signalCode ? child : null), 5000);
    // The point of re-raising: a process that would have died of the signal still does,
    // and still reports it. A trap that swallowed SIGTERM would show `exitCode: 0` here,
    // and every supervisor above it — `npm run checks`, a CI runner, lib/reap.js — would
    // read the session as having finished cleanly.
    if (code && child.signalCode === 'SIGTERM') ok('and still dies of the signal, not quietly of nothing');
    else bad('and still dies of the signal, not quietly of nothing', `signal ${child.signalCode}, code ${child.exitCode}`);
  }
}

/* ------------------------------------------- SIGKILL: the control, expected to leak */

{
  const { child, profile, pid } = await startVictim();
  if (!pid) {
    bad('control: the fixture reaches a running browser', 'no fake.pid appeared in 20s');
    try {
      child.kill('SIGKILL');
    } catch {
      /* never started */
    }
  } else {
    child.kill('SIGKILL');
    await until(() => child.signalCode || child.exitCode != null, 5000);
    // Give it as long as the real case was given to die, so this is a statement about
    // SIGKILL and not about being asked too soon.
    await sleep(1500);
    if (alive(pid)) ok('control: SIGKILL cannot be trapped, and does leak one');
    else bad('control: SIGKILL cannot be trapped, and does leak one', 'the stand-in died anyway, so this suite proves nothing');

    // Which this suite then has to clean up itself, having just made one on purpose.
    const cleaned = await reap(pid, profile);
    if (cleaned) ok('control: and the leak it made on purpose is cleaned up');
    else bad('control: and the leak it made on purpose is cleaned up', `pid ${pid} / ${profile}`);
  }
}

/* ------------------------------------------------ the registry lets go afterwards */

// A daemon serving `browse` launches one browser per request and never exits. If the
// launcher registered a teardown and did not untrack it, that process would hold a
// closure over every browser it had ever opened and, at exit, signal a list of pids the
// kernel has long since handed to something else.
{
  const before = armed();
  const untrack = onExit(() => {});
  const during = armed();
  untrack();
  if (during === before + 1 && armed() === before) ok('a registered teardown can be taken off again');
  else bad('a registered teardown can be taken off again', `${before} → ${during} → ${armed()}`);
}

{
  // The same, through the launcher: a launch that fails must leave nothing registered.
  const before = armed();
  try {
    await launchChrome('beadcause-leakreg-', { chrome: path.join(TMP, 'no-such-chrome-binary'), timeoutMs: 3000 });
  } catch {
    /* expected: there is no such binary */
  }
  if (armed() === before) ok('a failed launch leaves nothing registered');
  else bad('a failed launch leaves nothing registered', `${before} → ${armed()}`);
}

/* ------------------------------------- and every launcher is wired to the registry */

// Two files spawn Chrome today and a third would be written by copying one of them. The
// port rule in test/chromeport.mjs is enforced across the whole of scripts/ for exactly
// that reason; this is the same statement for the other half of the launch.
const codeOf = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

const sources = [];
for (const dir of [path.join(ROOT, 'lib'), path.join(ROOT, 'scripts'), path.join(ROOT, 'scripts', 'helpers')]) {
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js') || f.endsWith('.mjs')) sources.push(path.join(dir, f));
  }
}

// Naming the flag is not the same as launching one: lib/strays.js matches on
// `--headless=new` in order to *find* the Chromes nobody tore down, and has no child of
// its own to register. So the subject is a file that both names the flag and spawns
// something — which is what copying either launcher gives you, and what the ROGUE control
// below is.
const unhooked = [];
for (const full of sources) {
  const code = codeOf(fs.readFileSync(full, 'utf8'));
  if (!/--headless/.test(code) || !/\bspawn\(/.test(code)) continue;
  if (!/onExit/.test(code)) unhooked.push(path.relative(ROOT, full));
}
if (!unhooked.length) ok('every file that spawns a browser registers an exit teardown');
else bad('every file that spawns a browser registers an exit teardown', unhooked.join(', '));

// And the control for that scan, because an audit that cannot fire reports the same
// clean tree as one with nothing to find.
const ROGUE = "spawn(CHROME, ['--headless=new', '--user-data-dir=' + profile]);";
if (/--headless/.test(codeOf(ROGUE)) && /\bspawn\(/.test(codeOf(ROGUE)) && !/onExit/.test(codeOf(ROGUE)))
  ok('control: a launcher with no teardown is caught');
else bad('control: a launcher with no teardown is caught', 'the scan cannot fire');

/* -------------------------------------------------------------------- verdict */

fs.rmSync(rig, { recursive: true, force: true });

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran}\x1b[0m assertions passed\n`);
process.exit(failures ? 1 : 0);
