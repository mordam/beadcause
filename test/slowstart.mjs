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
 *   - **A real router**, driven into the slow path on purpose. `healthTimeoutMs: 250` is
 *     a window no node process can start inside, so the first attempts *must* time out —
 *     which is the honest way to reproduce a busy machine without needing one. Then the
 *     test does nothing at all: no file is touched, no command is run, nobody is told.
 *     If the router comes back on its own, the claim is true.
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
import { removeTreeSync } from './helpers/tmp.mjs';

import {
  DEFER_CEILING_MS,
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

async function waitFor(label, fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const got = await fn();
      if (got) return got;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-slow-'));
const stubBd = path.join(dir, 'bd');
fs.writeFileSync(stubBd, '#!/bin/sh\necho "[]"\n', { mode: 0o755 });

const port = await freePort();
fs.writeFileSync(
  path.join(dir, 'config.json'),
  JSON.stringify(
    {
      port,
      host: '127.0.0.1',
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      bdBin: stubBd,
      actor: 'beadcause-test',
      // The whole experiment. No node process imports this app and binds a port in a
      // quarter of a second, so the first attempts are guaranteed to run out of time —
      // which is exactly what a loaded Mac did to a twenty-second window.
      healthTimeoutMs: 250,
      openSessions: false,
      autoDispatch: false,
      claudeSessions: false,
      pollSeconds: 3600,
      ntfy: { enabled: false },
      advocates: { enabled: false, workspaces: [] },
    },
    null,
    2
  )
);

const env = { ...process.env, BEADCAUSE_CONFIG_DIR: dir };
const routerLog = [];
const router = spawn(process.execPath, [path.join(ROOT, 'bin', 'router.js')], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [router.stdout, router.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split('\n')) if (line.trim()) routerLog.push(line);
  });
}

/**
 * Stop the router and wait until it is genuinely gone.
 *
 * `kill()` only delivers the signal. The router answers it by stopping its backend and
 * closing its servers — both of which are still writing under `dir` while it does — and
 * only exits 300ms later. A removal fired in that window walks a directory something else
 * is still using, and `rmdir` on a directory that gained a file since it was read is
 * ENOTEMPTY: bc-t69u, printed as an uncaught stack from the exit handler below, after all
 * 36 checks had passed. `force: true` never covered it — `force` is about a path that is
 * *not* there, and this is a path that is more there than it was a moment ago.
 *
 * There is no `quiesce()` for a spawned process; waiting for its `exit` is the same idea.
 * It has to happen here rather than in the exit handler, because an exit handler is the
 * one place in a process that cannot wait for anything.
 */
const stopRouter = (graceMs = 5000) =>
  new Promise((resolve) => {
    if (router.exitCode !== null || router.signalCode !== null) return resolve();
    const timer = setTimeout(() => router.kill('SIGKILL'), graceMs);
    router.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    router.kill('SIGTERM');
  });

const cleanup = () => {
  // `killed` only says a signal was sent, so it reads true for a router that is ignoring
  // one. What decides whether there is still a process here is whether it has exited.
  if (router.exitCode === null && router.signalCode === null) router.kill('SIGKILL');
  // `removeTreeSync`, not a bare `rmSync` — see test/helpers/tmp.mjs. A throw in an exit
  // handler is an uncaught exception on the way out, and it cannot even change an exit
  // code that is already set: the run stays green while printing a stack that reads red.
  removeTreeSync(dir);
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  console.log(`\n  slow start — router on :${port}, 250ms first window, config in ${dir}\n`);

  // ------------------------------------------------ it fails, and says why honestly

  const stalled = await waitFor(
    'the router to run out of patience with a starting backend',
    async () => {
      const res = await get(port, `/internal/router/state?t=${TOKEN}`);
      const snap = JSON.parse(res.body);
      return snap.deferred ? snap : null;
    },
    45000
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
  const recovered = await waitFor(
    'the router to bring a backend up on its own',
    async () => {
      const res = await get(port, '/api/health');
      return res.status === 200 ? res : null;
    },
    120000
  );
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

} catch (err) {
  bad('the run itself', err.stack || err.message);
}

// On both paths, not just the one that got this far: a run that threw left a router
// behind too, and that one has a backend still coming up under `dir`. Before the summary
// as well, so anything the shutdown says is in the log if the log is about to be printed.
await stopRouter();

if (failures) {
  console.log('\n--- router log ---');
  for (const line of routerLog) console.log(`  ${line}`);
}
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
