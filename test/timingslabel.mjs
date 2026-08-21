#!/usr/bin/env node
/**
 * `npm run timings` must not call the over-budget list cold.
 *
 *     npm test
 *     node test/timingslabel.mjs
 *
 * `snapshot().overBudget` in lib/timing.js is filtered on `worstMs` — `max(cold p95,
 * warm p95)` — and deliberately so: a request past the budget is past the budget whether
 * or not it spawned a child. scripts/timings.mjs printed that list under the heading
 * `over budget — cold p95 past <N>ms`, and reddened a row in the table above it by a
 * rule of its own (`cold.p95Ms > budgetMs`) rather than by the list it was about to
 * print. Both were wrong in the same direction, and the case that shows it is real:
 * `GET /api/session-log` reads a transcript off disk, spawns nothing, is therefore
 * *warm* by the derivation, has no cold samples at all, and took 1.5s on the first live
 * run against the daemon. It was named in the list, called cold by the heading, and left
 * black in the table. bc-fg37.
 *
 * So this drives the real script against a real snapshot built by the real module — a
 * fake daemon serving `GET /api/timings` and nothing else, which is all a consumer of
 * that route can see anyway. Four claims:
 *
 *   1. the heading is true of every row the list can contain — it does not say `cold`;
 *   2. a route that is only ever warm and misses the budget is in the list;
 *   3. the table agrees with the list, which is what tying the highlight to
 *      `snap.overBudget` buys — the warm-only row is reddened too;
 *   4. and none of that reddens or lists a route that is inside the budget.
 *
 * The snapshot is built by importing lib/timing.js and recording fabricated requests
 * through it rather than by hand-writing JSON: a canned payload would keep passing the
 * day `overBudget` stopped meaning what the heading says.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const check = (fn, name) => {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
};

/* ------------------------------------------------------------ a scratch config */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-timingslabel-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
// `loadConfig()` reconciles the saved workspace list against `~/beads` every time, so the
// child gets `tmp` as its HOME as well — otherwise this suite depends on which
// workspaces the machine running it happens to have.
fs.mkdirSync(path.join(tmp, 'beads', 'beadcause', '.beads'), { recursive: true });
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({
    token: 'timingslabel-test-token',
    port: 4318,
    workspaces: [{ name: 'beadcause', dir: path.join(tmp, 'beads', 'beadcause', '.beads') }],
  })
);
process.env.BEADCAUSE_CONFIG_DIR = CONFIG_DIR;

/* --------------------------------------------------- a snapshot with all three cases */

const timing = await import(path.join(ROOT, 'lib', 'timing.js'));
timing.reset();
timing.configure({ slowMs: 0, write: () => {} }); // the slow log is a different suite's subject

// A child process that started `ago` ms ago and has just finished — `spend` takes the
// interval, not a duration, because the question it answers is about overlap.
const child = (kind, ago) => timing.spend(kind, process.hrtime.bigint() - BigInt(Math.round(ago * 1e6)));

// Cold and over: it spawned something, so it is cold by the derivation.
{
  const rec = timing.begin('GET /api/prs');
  rec.t0 -= 3_000_000_000n;
  child('bd', 2900);
  timing.end(rec, 200);
}

// Warm and over: no child at all, so warm — and no cold samples to filter on. The row
// this whole suite is about.
{
  const rec = timing.begin('GET /api/session-log');
  rec.t0 -= 1_500_000_000n;
  timing.end(rec, 200);
}

// Over budget, no child, and most of it with the loop busy: the starved row. Blocked
// for real rather than fabricated — `loopBusy` reads the loop's own counters, so a
// rewound `t0` has no busy loop behind it and the row would come out at 0.00 and prove
// nothing. `t0` is still rewound a little on top, to clear the budget without paying a
// second of wall clock for it.
{
  // The wait is what makes this work rather than a nicety: `eventLoopUtilization` answers
  // zeros until the loop has actually started, and a module body runs before it does — so
  // a block written at the top of this file would be invisible to the very measurement
  // this row exists to exercise, and the row would come out at 0.00 and prove nothing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const rec = timing.begin('GET /style.css');
  rec.t0 -= 300_000_000n;
  const until = Date.now() + 900;
  while (Date.now() < until);
  timing.end(rec, 200);
}

// Warm and inside the budget: the control, so "reddened" and "listed" mean something.
timing.end(timing.begin('GET /api/fast'), 200);

const snap = timing.snapshot();

check(
  () => assert.ok(!snap.routes.find((r) => r.route === 'GET /api/session-log')?.cold, 'it has cold samples'),
  'the warm-only route really has no cold half — otherwise this suite proves nothing'
);
check(() => assert.ok(snap.overBudget.includes('GET /api/session-log')), 'and the snapshot names it over budget anyway');
check(() => assert.deepEqual(snap.starved, ['GET /style.css']), 'and the starved row is the only one the snapshot calls starved');

/* ------------------------------------------------------------------ a fake daemon */

const daemon = http.createServer((req, res) => {
  if (!req.url.startsWith('/api/timings')) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snap));
});
await new Promise((resolve) => daemon.listen(0, '127.0.0.1', resolve));
// One listener, bound to port 0 on loopback — `helpers/net.mjs`'s `boundPort` is for the
// array `lib/server.js`'s `listen()` returns, and this is a bare `http.Server`.
const url = `http://127.0.0.1:${daemon.address().port}`;

// `spawn` and not `spawnSync`: the daemon the child is about to fetch from is in *this*
// process, and a synchronous spawn blocks the event loop that has to answer it — the
// suite hangs until something kills it, with two ticks printed and no third.
const run = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/timings.mjs'), '--url', url], {
    cwd: ROOT,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: CONFIG_DIR },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

daemon.close();

console.log('\nnpm run timings — the over-budget and starved blocks\n');

check(() => assert.equal(run.status, 0, run.stderr || `exit ${run.status}`), 'the script runs against the snapshot');

const out = run.stdout || '';
const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
const heading = plain.split('\n').find((l) => l.startsWith('over budget')) || '';
// The route name is padded to the column width before it is coloured, so the escape and
// the name are on the same line and adjacent.
const reddened = (route) => new RegExp(`\\x1b\\[31m${route.replace(/\//g, '\\/')} *\\x1b\\[0m`).test(out);

check(() => assert.ok(heading, `no over-budget block was printed at all:\n${plain}`), 'it prints the over-budget block');
check(() => {
  // Not "must not say cold" — it may say `cold or warm`, which is true. What it must not
  // do is attribute the list to one side of the cache, because the filter is the worse of
  // the two and a warm-only row can be in it.
  assert.doesNotMatch(heading, /cold p95/, `the heading still says it: ${heading}`);
  if (/cold/.test(heading)) {
    assert.match(heading, /warm/, `the heading names one temperature and not the other: ${heading}`);
  }
}, 'the heading does not attribute the list to the cold p95 — the list is the worse of the two');
check(() => assert.match(heading, /p95 past 1000ms/), 'it still says what the budget is');
check(
  () => assert.match(plain, /over budget[^\n]*\n(?:[^\n]*\n)*? {2}GET \/api\/session-log/),
  'the warm-only route that misses the budget is named in the list'
);
check(() => assert.match(plain, / {2}GET \/api\/prs/), 'and so is the cold one, which never stopped working');

/**
 * And the same rule for the second list. `starved` is the daemon's finding too, for the
 * same reason `overBudget` is — a consumer recomputing it can disagree with the daemon
 * about which routes it is naming, and that is the bug bc-fg37 was.
 */
check(
  () => assert.match(plain, /blocked behind the loop[^\n]*\n(?:[^\n]*\n)*? {2}GET \/style\.css/),
  'the route that was starved rather than slow gets a block of its own'
);
check(() => assert.match(plain, /GET \/style\.css[^\n]*% of its wall clock/), 'saying how much of it went behind a busy loop');
check(() => assert.doesNotMatch(plain, /blocked behind the loop[^\n]*\n(?:[^\n]*\n)*? {2}GET \/api\/prs/), 'and the route that spawned a child is not in it');
check(() => assert.match(plain, /route +loop +n +p50/), 'the table carries the loop column the block is read against');
check(
  () => assert.ok(reddened('GET /api/session-log'), `its row is not highlighted:\n${JSON.stringify(out)}`),
  'the table agrees with the list — the warm-only row is reddened too'
);
check(() => assert.ok(reddened('GET /api/prs')), 'as is the cold one');
check(() => assert.ok(!reddened('GET /api/fast')), 'a route inside the budget is left alone');
check(() => assert.ok(!/ {2}GET \/api\/fast/.test(plain.split('over budget')[1] || '')), 'and is not in the list');

await cleanupTmp(tmp);

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
