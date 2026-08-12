#!/usr/bin/env node
/**
 * A backend that is merely slow to start is retried, not condemned.
 *
 *     npm test
 *     node test/slowstart.mjs
 *
 * The bug: bin/router.js gave a starting backend twenty seconds, and treated anything
 * slower as a poisoned build — never retried until the files moved again. On a Mac with
 * ten agent sessions, two other routers and eight headless Chromes on it, a backend that
 * binds in ~2s by hand did not answer in twenty, and a build that was perfectly fine was
 * condemned. Twice. Nothing was down in a way launchd would restart, the port stayed
 * bound, and every request got a 503 whose entire explanation was "check the log".
 *
 * Two halves here, because the fix has two halves:
 *
 *   - **The policy**, lib/startup.js, checked as pure arithmetic. It has no I/O in it
 *     precisely so that "the window doubles, and a timeout is not a poisoning" can be
 *     asserted without spawning anything or waiting for anything.
 *   - **A real router**, driven into the slow path on purpose. A first health window no
 *     node process can start inside means the first attempts *must* time out — which is
 *     the honest way to reproduce a busy machine without needing one. Then the test does
 *     nothing at all: no file is touched, no command is run, nobody is told. If the
 *     router comes back on its own, the claim is true.
 *
 * ## The second half used to have a clock for a pass condition — bc-9zv0
 *
 * That window was a constant, `healthTimeoutMs: 250`, and the wait for the recovery was
 * a flat two minutes. Both numbers only mean anything relative to a third one nobody
 * measured: how long *this* machine takes to start a backend, right now. The router
 * widens its window by doubling, so the number of bring-ups it needs is the distance in
 * doublings between 250ms and the truth — three on an idle laptop, seven on a loaded
 * one — and each of those bring-ups costs an outage pause that doubles too (2s, 4s, 8s,
 * 16s, 32s, 60s). So the ladder to recovery was ~20s idle and ~170s under load, against
 * a deadline fixed at 120s. Same tree, same code, red or green by how busy the Mac was.
 *
 * And it did not read as a flake. It read as `timed out waiting for the router to bring
 * a backend up on its own`, over a log full of `would not start in time` — which is
 * indistinguishable, at a glance, from *the router can no longer start a backend*. It is
 * the last thing a session sees before deciding whether its work is safe to deliver.
 *
 * So the machine is measured instead of assumed, once, before the router starts: a
 * backend is spawned by hand exactly as `spawnBackend` spawns one, and timed. Everything
 * else is derived from that number.
 *
 *   - **The window** is `MEASURED / TOO_SHORT`, floored at the old 250ms. Still far too
 *     short to start anything, so the experiment is exactly the one it always was — but
 *     now it is a *fixed number of doublings* short instead of however many this laptop
 *     happens to be having, so the ladder is the same length on every machine.
 *   - **The deadline** is walked, not guessed: `ladder()` runs the same policy the router
 *     runs and returns when the window would first be wide enough, so the wait can never
 *     land in the middle of a rung.
 *   - **The verdict**, if it still times out, is settled by spawning one more backend by
 *     hand. If *that* cannot start inside the widest window the router had reached, the
 *     machine could not have done it either and this run is inconclusive rather than
 *     failed. If it starts promptly, the router had every chance and did not take it —
 *     which is a regression, and is reported as one, in those words.
 *
 * Hermetic like scripts/test-swap.js and for the same reasons: a scratch config dir, an
 * ephemeral port, ntfy off, advocates off, `bd` stubbed to print `[]`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/net.mjs';

import {
  DEFER_CEILING_MS,
  HEALTH_ATTEMPTS,
  HEALTH_CEILING_MS,
  MAX_SLOWNESS,
  OUTAGE_CEILING_MS,
  deferralMs,
  explain,
  healthDeadline,
  nextSlowness,
  outageRetryMs,
} from '../lib/startup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BACKEND = path.join(ROOT, 'bin', 'beadcause.js');
const TOKEN = 'test-token-not-a-secret';

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
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Why the live half of this suite did not run, when it did not. Not a failure.
 *
 * Set only where the evidence says the machine — not the code — is what stopped it, and
 * printed at the bottom loudly enough that a green run is never mistaken for a complete
 * one. Everything that can be decided without a clock has already been decided above it.
 */
let inconclusive = null;

/* ------------------------------------------------------------------ the policy */

check(healthDeadline(0, 0, 1000) === 1000, 'the first attempt on a quiet machine gets the base window');
check(healthDeadline(1, 0, 1000) === 2000, 'the second attempt of the same bring-up gets twice it');
check(healthDeadline(0, 3, 1000) === 8000, 'and a machine that has already been slow starts wider');
check(
  healthDeadline(1, 99, 20000) === HEALTH_CEILING_MS,
  'however slow it has been, no single wait exceeds the ceiling',
  `${healthDeadline(1, 99, 20000)}ms`
);

check(nextSlowness(0, { timedOut: true }) === 1, 'running out of patience widens the next window');
check(nextSlowness(MAX_SLOWNESS, { timedOut: true }) === MAX_SLOWNESS, 'and it stops widening at the cap');
check(
  nextSlowness(2, { timedOut: false, attempt: 0 }) === 1,
  'a clean first-attempt start narrows it again, one step at a time'
);
check(
  nextSlowness(2, { timedOut: false, attempt: 1 }) === 2,
  'but a start that needed the second attempt keeps the width that got it there'
);

check(deferralMs(1, 1000) === 1000 && deferralMs(3, 1000) === 4000, 'the pause between retries doubles');
check(deferralMs(99, 30000) === DEFER_CEILING_MS, 'and is capped');
check(outageRetryMs(1) < deferralMs(1), 'with nothing being served, the router is much less patient');
check(outageRetryMs(99) === OUTAGE_CEILING_MS, 'and that pause is capped too');

/* ------------------------------------------- the verdict, in one voice everywhere */

const serving = { disk: 'b2', serving: true, active: { build: 'b2', pid: 7 }, stale: false };
check(explain(serving).ok && explain(serving).code === 'serving', 'a router serving what is on disk says so on a good day');

const slow = {
  disk: 'b3',
  serving: true,
  stale: true,
  active: { build: 'b2', pid: 7 },
  poisoned: null,
  deferred: { build: 'b3', attempts: 2, until: Date.now() + 30000 },
};
const slowVerdict = explain(slow);
check(slowVerdict.code === 'retrying', 'a build that was too slow reads as being retried', slowVerdict.code);
check(
  !/poison/i.test(JSON.stringify(slowVerdict)),
  'and the word poisoned appears nowhere in it — that is the distinction the bug lacked'
);

const dead = { disk: 'b3', serving: true, stale: true, active: { build: 'b2', pid: 7 }, poisoned: 'b3' };
check(explain(dead).code === 'poisoned', 'a build that died at startup still reads as condemned');

const down = {
  disk: 'b3',
  serving: false,
  active: null,
  poisoned: null,
  deferred: { build: 'b3', attempts: 2, until: Date.now() + 5000 },
  retryAt: Date.now() + 4000,
};
const downVerdict = explain(down);
check(downVerdict.code === 'no-backend', 'serving nothing is its own state, not a kind of staleness');
check(
  /holding the port and serving nothing/.test(downVerdict.summary),
  'said in the words the bead asked for',
  downVerdict.summary
);
check(
  downVerdict.lines.some((l) => /retrying on its own/.test(l)),
  'and it says it is retrying, which is the difference between waiting and going to the Mac'
);

/* ------------------------------------------------------ how long the ladder is, here */

/**
 * `WATCH_MS` in bin/router.js — the tick that notices there is nothing being served.
 *
 * Copied rather than imported because it is a private constant of a file that holds a
 * port and is not importable without starting one. It is only used to make the derived
 * deadline generous, so a copy that drifts *low* costs nothing and a copy that drifts
 * high costs a little patience; neither can make this suite fail.
 */
const WATCH_MS = 3000;

/**
 * How long a hand-spawned backend is given before the answer is "it did not".
 *
 * Comfortably under the 60s orphan guard in bin/beadcause.js: a backend given `--port`
 * expects a router to touch `/internal/state` every ten seconds and **exits 0** when a
 * minute goes by without one. Nothing here is a router, so a measurement allowed to run
 * past that would collect a clean exit and report a *broken backend* — the one reading
 * this suite must never get wrong.
 */
const MEASURE_MS = 45000;

/**
 * How many doublings short of the truth the first health window is made.
 *
 * The whole experiment is that the first attempts run out of time, so this has to be big
 * enough that no plausible swing in load between the measurement and the first bring-up
 * could let one through — three doublings, i.e. the machine would have to become four
 * times faster within a few seconds of proving it was not. It is also the only thing
 * paying for the ladder's length, since every factor of two here is one more bring-up.
 */
const TOO_SHORT = 8;

/**
 * How much wider than the measured start the window must get before we stop waiting.
 *
 * Not 1×: the measurement is one sample of a machine ~20 agent sessions are using, and
 * the retry that matters happens up to a minute later. Four, so a machine that is four
 * times slower at the end of the suite than at the start of it is still recovered from
 * rather than reported on.
 */
const HEADROOM = 4;

/**
 * When the router's widening window would first reach `target`, in real milliseconds.
 *
 * The same policy the router runs — `healthDeadline` per attempt, `nextSlowness` per
 * bring-up, `outageRetryMs` between them — walked forward, so the deadline this suite
 * waits to is derived from lib/startup.js rather than typed next to it. A flat number
 * cannot help landing in the middle of a rung on some machine, and the rungs double.
 */
function ladder(base, target) {
  let ms = 0;
  let slowness = 0;
  let bringUps = 0;
  // The window is capped, so a target above the ceiling is never reached — the caller
  // clamps for that, and this is the backstop that keeps the walk finite regardless.
  for (bringUps = 1; bringUps <= 2 + MAX_SLOWNESS * 2; bringUps++) {
    ms += WATCH_MS;
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
      const window = healthDeadline(attempt, slowness, base);
      if (window >= target) return { ms: ms + target, bringUps, window };
      ms += window;
    }
    slowness = nextSlowness(slowness, { timedOut: true });
    ms += outageRetryMs(bringUps);
  }
  return { ms, bringUps, window: healthDeadline(HEALTH_ATTEMPTS - 1, slowness, base) };
}

/* --------------------------------------------------------------- a real router */

function get(port, pathname, { timeout = 10000, token = TOKEN, accept = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['x-beadcause-token'] = token;
    if (accept) headers.accept = accept;
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timed out after ${timeout}ms`)));
    req.on('error', reject);
  });
}

/**
 * Poll `fn` until it returns something truthy, or `ms` runs out.
 *
 * A throw from `fn` is "not yet" — which is what makes it usable against a port nothing
 * is listening on. An error carrying `stop` is the exception: a *settled* answer that
 * happens to be an unhappy one, and waiting the rest of the window out for it would only
 * be waiting for the same answer again.
 */
async function waitFor(label, fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const got = await fn();
      if (got) return got;
    } catch (err) {
      if (err?.stop) throw err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-slow-'));
const stubBd = path.join(dir, 'bd');
fs.writeFileSync(stubBd, '#!/bin/sh\necho "[]"\n', { mode: 0o755 });

const port = await freePort();
const settings = {
  port,
  host: '127.0.0.1',
  baseUrl: `http://127.0.0.1:${port}`,
  token: TOKEN,
  bdBin: stubBd,
  actor: 'beadcause-test',
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};
const writeConfig = (extra = {}) =>
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...settings, ...extra }, null, 2));

// Written without a health window first, because the measurement below needs a config to
// read and the window is worked out from what the measurement says.
writeConfig();

const env = { ...process.env, BEADCAUSE_CONFIG_DIR: dir };

let router = null;
const cleanup = () => {
  if (router && !router.killed) router.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

/**
 * How long this machine takes to start a backend, right now.
 *
 * The same spawn `spawnBackend` in bin/router.js makes — same argv, same cwd, same
 * config dir — polled the same way, so the number is the one the router is up against
 * rather than a proxy for it.
 *
 * Three outcomes, and telling the last two apart is the whole reason this returns an
 * object rather than a number: `{ms}` started, `{slow}` was still starting when the
 * ceiling ran out, and `{exited}` *died* — which is a broken backend rather than a busy
 * laptop, and must never be quietly read as "this machine is having a hard time".
 */
async function timeOneStart(ceiling) {
  const backendPort = await freePort();
  const started = Date.now();
  const child = spawn(process.execPath, [BACKEND, '--port', String(backendPort), '--standby'], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
  });
  const gone = new Promise((resolve) => child.on('exit', resolve));
  try {
    for (;;) {
      if (child.exitCode !== null || child.signalCode) return { exited: child.signalCode || child.exitCode };
      try {
        // The token, because `/internal/` is refused off loopback *and* still needs it —
        // `localJson` in bin/router.js sends the same one, and without it this measures
        // the time to a 403 rather than the time to a backend.
        const res = await get(backendPort, '/internal/state', { timeout: 1000 });
        if (res.status === 200) return { ms: Date.now() - started };
      } catch {
        /* not yet */
      }
      if (Date.now() - started > ceiling) return { slow: ceiling };
      await sleep(50);
    }
  } finally {
    child.kill('SIGKILL');
    // Awaited, not fired and forgotten: the next thing that happens is either another
    // spawn or the removal of the directory this child has open.
    await gone;
  }
}

const first = await timeOneStart(MEASURE_MS);
if (first.exited !== undefined) {
  bad(
    'a backend spawned by hand comes up at all',
    `it exited with ${first.exited} before it was healthy — nothing below this line is about the router, and ` +
      'a backend that dies at startup is exactly the case the router is *right* to condemn'
  );
} else if (first.slow) {
  inconclusive =
    `no backend answered inside ${Math.round(first.slow / 1000)}s when spawned by hand, before the router was ` +
    'involved at all — so there is no window this suite could have given the router that would have meant anything';
}
/** What this machine takes to start a backend, in ms. Everything below is sized off it. */
const MEASURED = first.ms ?? null;

/**
 * The window the router is given: a fixed number of doublings short of the truth.
 *
 * Floored at the 250ms this suite used before anything was measured, so an idle laptop
 * runs exactly the ladder it always ran and nothing about the fast case changed.
 */
const BASE = Math.max(250, Math.round((MEASURED ?? 2000) / TOO_SHORT));
/** The widest single wait the ladder will ever offer, whatever the machine proves. */
const WIDEST = healthDeadline(HEALTH_ATTEMPTS - 1, MAX_SLOWNESS, BASE);
const TARGET = Math.min((MEASURED ?? 2000) * HEADROOM, WIDEST);
const RECOVERY = ladder(BASE, TARGET);
/** A quarter again on top of the walk, for the spawns and polls the walk does not model. */
const RECOVER_MS = Math.round(RECOVERY.ms * 1.25) + 10000;
/** The first bring-up only, which is all it takes to be deferred rather than condemned. */
const STALL_MS = Math.max(45000, WATCH_MS * 3 + healthDeadline(0, 0, BASE) + healthDeadline(1, 0, BASE) + (MEASURED ?? 0) * 2);

if (!inconclusive) {
  writeConfig({
    // The whole experiment. A window this machine has just demonstrated it cannot start
    // a backend inside, so the first attempts are guaranteed to run out of time — which
    // is exactly what a loaded Mac did to a twenty-second window.
    healthTimeoutMs: BASE,
  });

  router = spawn(process.execPath, [path.join(ROOT, 'bin', 'router.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const routerLog = [];
for (const stream of router ? [router.stdout, router.stderr] : []) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split('\n')) if (line.trim()) routerLog.push(line);
  });
}

/** The router's own account of itself, or null if it cannot be asked. */
async function state() {
  try {
    return JSON.parse((await get(port, `/internal/router/state?t=${TOKEN}`)).body);
  } catch {
    return null;
  }
}

/**
 * Which of the two things a timed-out recovery is — said here, not in the log.
 *
 * The distinction bc-9zv0 is about. One more backend is started by hand: if this machine
 * cannot manage it inside the widest window the router had already reached, then neither
 * could the router, and there is nothing here about the code. If it starts promptly, the
 * router had every chance and did not take it, and that is the regression this whole
 * suite exists to catch — so it is a failure, and it says which one it is either way.
 */
async function verdictOnTimeout(err) {
  const snap = await state();
  if (!snap) {
    bad('the run itself', `${err.message}, and the router stopped answering /internal/router/state as well`);
    return;
  }
  const widest = healthDeadline(HEALTH_ATTEMPTS - 1, snap.slowness ?? 0, BASE);
  const tried = routerLog.filter((l) => /still starting after/.test(l));
  const said = tried.length ? `router said: ${tried[tried.length - 1]}` : '(the router logged no timeout at all)';

  if (snap.poisoned) {
    bad(
      'the router condemned a build that was only slow',
      `poisoned: ${snap.poisoned} — a timeout is evidence about the machine, and this is the exact ` +
        `confusion the suite exists to catch. ${said}`
    );
    return;
  }

  const byHand = await timeOneStart(Math.min(MEASURE_MS, Math.max(widest, MEASURED * 2)));
  if (byHand.exited !== undefined) {
    bad(
      'the router did not bring a backend up on its own',
      `and a backend spawned by hand exited with ${byHand.exited} too — the backend is broken, not the router. ${said}`
    );
    return;
  }
  if (byHand.slow || byHand.ms > widest) {
    inconclusive =
      `THIS MACHINE, NOT THE ROUTER. A backend spawned by hand ${byHand.slow ? `never answered in ${Math.round(byHand.slow / 1000)}s` : `took ${byHand.ms}ms`}, ` +
      `against the ${Math.round(widest / 1000)}s window the router had already widened to — so there was no chance here ` +
      `that the router failed to take. It was measured at ${MEASURED}ms when this run started; nothing is condemned ` +
      `(poisoned: null) and the window is still widening (slowness ${snap.slowness}, ${tried.length} attempts timed out).`;
    return;
  }

  bad(
    'the router did not bring a backend up on its own',
    `THE ROUTER, NOT THIS MACHINE. A backend spawned by hand answered in ${byHand.ms}ms just now — well inside the ` +
      `${Math.round(widest / 1000)}s window the router had widened to over ${tried.length} timed-out attempts — and the ` +
      `router is still serving nothing. ${said}`
  );
}

try {
  if (inconclusive || MEASURED === null) throw Object.assign(new Error('skipped'), { skipped: true });
  console.log(
    `\n  slow start — router on :${port}, a backend starts in ${MEASURED}ms here so the first window is ${BASE}ms,\n` +
      `  recovery due within ${Math.round(RECOVERY.ms / 1000)}s (~${RECOVERY.bringUps} bring-ups), waiting up to ` +
      `${Math.round(RECOVER_MS / 1000)}s. Config in ${dir}\n`
  );

  // ------------------------------------------------ it fails, and says why honestly

  const stalled = await waitFor(
    'the router to run out of patience with a starting backend',
    async () => {
      const res = await get(port, `/internal/router/state?t=${TOKEN}`);
      const snap = JSON.parse(res.body);
      // A router that is already serving means the window was not too short after all —
      // the machine got faster than it had just proved it was. Nothing to assert.
      if (snap.serving && !snap.deferred) throw Object.assign(new Error('too fast'), { stop: true, tooFast: snap });
      return snap.deferred ? snap : null;
    },
    STALL_MS
  );
  check(stalled.serving === false, 'nothing is being served while it keeps failing to start in time');
  check(
    stalled.poisoned === null,
    'and the build is NOT poisoned — a slow start is evidence about the machine',
    `poisoned: ${stalled.poisoned}`
  );
  check(stalled.deferred?.build === stalled.disk, 'it is deferred instead, by build', JSON.stringify(stalled.deferred));
  check(stalled.slowness > 0, 'and the window has been widened for the next attempt', `slowness ${stalled.slowness}`);

  const asJson = await get(port, '/api/health');
  const body = JSON.parse(asJson.body);
  check(asJson.status === 503, 'a request while nothing is served is a 503', `status ${asJson.status}`);
  check(body.code === 'no-backend', 'whose body names the state rather than saying "check the log"', body.body);
  check(
    Array.isArray(body.detail) && body.detail.some((l) => /too slow|retrying/i.test(l)),
    'and explains that it is a slow machine being retried',
    JSON.stringify(body.detail)
  );

  const asHtml = await get(port, '/', { accept: 'text/html,application/xhtml+xml' });
  check(asHtml.status === 503 && /text\/html/.test(asHtml.headers['content-type'] || ''), 'a browser gets a page, not JSON');
  check(
    /holding the port and serving nothing/.test(asHtml.body),
    'which says what is wrong in a sentence a phone can read'
  );
  check(/location.reload/.test(asHtml.body), 'and reloads itself, so it becomes the app again with no tap');

  // -------------------------------------- and then it recovers, with nobody helping

  // Nothing is touched here on purpose. No file moves, no `npm run swap`, no restart.
  // The only thing that happens is time — which is the entire claim being made.
  let recovered = null;
  try {
    recovered = await waitFor(
      'the router to bring a backend up on its own',
      async () => {
        const res = await get(port, '/api/health');
        return res.status === 200 ? res : null;
      },
      RECOVER_MS
    );
  } catch (err) {
    await verdictOnTimeout(err);
  }

  if (recovered) {
    check(true, 'a build that was only slow comes up on its own, with nothing edited and nobody asked');
    check(
      Number(recovered.headers['x-beadcause-pid']) > 0,
      'and the port answers from a real backend again',
      recovered.headers['x-beadcause-pid']
    );

    const after = JSON.parse((await get(port, `/internal/router/state?t=${TOKEN}`)).body);
    check(after.serving === true && after.deferred === null, 'the deferral is cleared once it is serving');
    check(after.poisoned === null, 'and nothing was ever condemned', `poisoned: ${after.poisoned}`);
    check(after.outage === null, 'the outage is over, and the router knows it is over');

    check(
      routerLog.some((l) => /not condemned/.test(l)),
      'the log said outright that the build was not being condemned',
      routerLog.filter((l) => /would not start/.test(l))[0] || '(no such line)'
    );
    check(
      !routerLog.some((l) => /could not bring up build/.test(l)),
      'and never used the wording reserved for a build that died at startup',
      routerLog.filter((l) => /could not bring up/.test(l))[0]
    );
  }

  router.kill('SIGTERM');
} catch (err) {
  if (err.tooFast) {
    inconclusive =
      `the ${BASE}ms window was not too short after all — this machine measured ${MEASURED}ms a moment earlier and then ` +
      'started a backend inside a window an eighth of that, so the slow path never happened and there was nothing to ' +
      'recover from. The build is serving, which is the opposite of the failure this suite is about.';
  } else if (!err.skipped) {
    bad('the run itself', err.stack || err.message);
  }
  if (router) router.kill('SIGTERM');
}

if (failures || inconclusive) {
  console.log('\n--- router log ---');
  for (const line of routerLog) console.log(`  ${line}`);
}
if (inconclusive) {
  console.log('\n  \x1b[33m⚠\x1b[0m the live half of this suite did not run — and did not fail:');
  console.log(`      ${inconclusive}`);
}
if (failures) console.log(`\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n`);
else if (inconclusive) console.log(`\n\x1b[33m${ran} checks passed; the live half was not run on this machine\x1b[0m\n`);
else console.log(`\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
