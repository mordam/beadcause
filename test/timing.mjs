#!/usr/bin/env node
/**
 * Per-request timing: the attribution, and the two things it must not get wrong.
 *
 *     npm test
 *     node test/timing.mjs
 *
 * lib/timing.js exists so that "the app feels slow" can be answered with a route name
 * and a number. Two of its claims are the kind that look right in every manual check and
 * are wrong under load, so they are checked here against a real server rather than
 * argued:
 *
 * 1. **Two requests in flight do not charge each other's subprocesses.** The context is
 *    an `AsyncLocalStorage` entered with `enterWith`, which is the one shape in that API
 *    with a real footgun — set the store on the wrong async resource and every figure is
 *    plausible and none is true. So a `bd`-spawning route and a route that spawns nothing
 *    are fired *together*, and the one that spawns nothing has to come back warm with a
 *    subprocess count of zero. That is the assertion the whole file exists for.
 * 2. **A streamed response is still timed.** Static files and `/api/asset` never return
 *    through the handler — they hand a read stream to the socket — so a `try`/`finally`
 *    around the dispatch would have missed every page load in the app. The close is
 *    hung off `finish`/`close` on the response instead, and this checks that a real
 *    static GET lands in the table.
 *
 * The rest is unit work over the module with no server at all: warm against cold, the
 * long-poll exclusion (a parked `/api/poll` must never reach the slow log or the
 * over-budget list — it would outweigh a hundred real requests), the slow-log threshold,
 * and the route-table ceiling that stops a 404 scan from growing the map without bound.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-timing-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const timing = await import(LIB('timing.js'));

/**
 * A child process that started `ago` ms ago and has just this moment finished.
 *
 * `spend` takes the *interval* rather than a duration, because the whole subprocess
 * question here is about overlap — so a fabricated child has to be fabricated as an
 * interval too. Several of these in a row all end now, which is exactly the shape a
 * fanned-out sweep has.
 */
const child = (kind, ago) => timing.spend(kind, process.hrtime.bigint() - BigInt(Math.round(ago * 1e6)));

/* ------------------------------------------------------------ warm, cold, and where */

console.log('\nwhat a request is charged for\n');

timing.reset();
timing.configure({ slowMs: 0 });

/**
 * Subprocess time with no request in scope, and it has to be checked **first**.
 *
 * `begin` uses `enterWith`, which sets the store for the remainder of the async resource
 * it was called on — for an HTTP request that is exactly the wanted scope, and in a
 * linear script it is the whole rest of the file. So there is no way back to "no request
 * in scope" once one has begun here, and a background check written further down would
 * be charging the last record instead and passing for the wrong reason.
 */
{
  child('bd', 1200);
  const snap = timing.snapshot();
  check(() => assert.equal(snap.routes.length, 0), 'a poll-cycle sweep invents no route');
  check(() => assert.ok(Math.abs(snap.background.ms - 1200) < 15, `${snap.background.ms}ms`), "and lands in `background` — the daemon's own load");
  check(() => assert.equal(snap.background.byKind.bd.calls, 1), 'broken out by which binary it was');
  timing.reset();
}

{
  const rec = timing.begin('GET /api/nothing');
  timing.end(rec, 200);
  const snap = timing.snapshot();
  const row = snap.routes.find((r) => r.route === 'GET /api/nothing');
  check(() => assert.ok(row, `no row for it in ${snap.routes.map((r) => r.route).join(', ')}`), 'a request with no subprocess is recorded');
  check(() => assert.ok(row.warm && !row.cold, 'it landed cold'), 'and counted as warm, because nothing was spawned for it');
}

/**
 * Three children, all still running when the last one finished — which is what a sweep of
 * nine workspaces looks like, and the shape that made the first version of this module
 * report an "ours" of minus four seconds on a real request.
 */
{
  const rec = timing.begin('GET /api/spawns');
  // The request started before its children did, which is the only order that can
  // happen for real — a child whose interval predates the record is clamped, deliberately.
  rec.t0 -= 500_000_000n;
  child('bd', 400);
  child('bd', 100);
  child('gh', 250);
  timing.end(rec, 200);
  const row = timing.snapshot().routes.find((r) => r.route === 'GET /api/spawns');
  check(() => assert.ok(row.cold && !row.warm, 'it landed warm'), 'a request that spawned something is counted as cold');
  check(() => assert.equal(row.cold.calls, 3), 'with the number of child processes it paid for');
  check(
    () => assert.ok(Math.abs(row.cold.childWorkMs - 750) < 20, `${row.cold.childWorkMs}ms`),
    'the child work summed is what the request cost the machine'
  );
  check(
    () => assert.ok(Math.abs(row.cold.subMs - 400) < 20, `${row.cold.subMs}ms`),
    'while the subprocess share counts the overlap once — three parallel children, one wait'
  );
  check(() => assert.ok(row.cold.subShare <= 1, `subShare ${row.cold.subShare}`), 'so the share can never exceed the request');
  check(() => assert.ok(row.cold.oursMs >= 0, `oursMs ${row.cold.oursMs}`), 'and our own half can never come out negative');
  check(() => assert.ok(Math.abs(row.cold.fanout - 1.9) < 0.3, `fanout ${row.cold.fanout}`), 'the ratio between the two is the fan-out');
  check(
    () => assert.deepEqual(Object.keys(row.cold.statuses), ['200']),
    'and the status it answered with, so a table of fast 500s cannot read as health'
  );
}

/**
 * The derivation is a default, not a rule. A stale-while-revalidate hit answers out of
 * memory *and* spawns a refresh behind it — filed as `cold` it would make the fastest
 * kind of request there is look like the slowest, and make the cache the epic is about
 * look like it had done nothing at all.
 */
{
  timing.reset();
  const rec = timing.begin('GET /api/swr');
  rec.t0 -= 1_000_000_000n;
  child('bd', 900);
  timing.cache('warm');
  timing.end(rec, 200);
  const row = timing.snapshot().routes.find((r) => r.route === 'GET /api/swr');
  check(() => assert.ok(row.warm && !row.cold), 'a route that says it was warm is believed over the derivation');
  check(() => assert.ok(Math.abs(row.warm.subMs - 900) < 20, `${row.warm.subMs}ms`), 'and its background refresh is still counted');
}

/* ---------------------------------------------------------------- the slow log */

console.log('\nthe slow log\n');

{
  timing.reset();
  const lines = [];
  timing.configure({ slowMs: 500, write: (l) => lines.push(l) });

  const fast = timing.begin('GET /api/fast');
  timing.end(fast, 200);
  check(() => assert.deepEqual(lines, []), 'a request inside the threshold says nothing');

  const slow = timing.begin('GET /api/slow');
  slow.t0 -= 1_500_000_000n; // started 1.5s ago, without a real 1.5s wait
  child('bd', 800);
  timing.end(slow, 200);
  check(() => assert.equal(lines.length, 1), 'one past it logs exactly one line');
  check(() => assert.match(lines[0] || '', /GET \/api\/slow/), 'naming the route');
  check(() => assert.match(lines[0] || '', /800ms of it waiting on 1 child/), 'and where the time went, which is the point of the line');
  check(() => assert.match(lines[0] || '', /bd 800ms of work/), 'naming the binary that took it');
  check(() => assert.match(lines[0] || '', /ours 7\d\dms/), 'and our own share, so a slow handler is not read as a slow tracker');

  /**
   * `/api/poll` parks for twenty-five seconds because that is what a long-poll is. A
   * line about it every twenty-five seconds forever is a log nobody reads, and a parked
   * poll in the over-budget list is a budget nobody believes.
   */
  const parked = timing.begin('GET /api/poll');
  parked.t0 -= 25_000_000_000n;
  timing.end(parked, 200);
  check(() => assert.equal(lines.length, 1), 'a long-poll that parked for 25s logs nothing');
  const snap = timing.snapshot();
  check(() => assert.ok(snap.routes.find((r) => r.route === 'GET /api/poll')?.parked), 'it is still measured, and flagged as parked');
  check(() => assert.ok(!snap.overBudget.includes('GET /api/poll')), 'and it is not counted against the budget');
  check(() => assert.ok(snap.overBudget.includes('GET /api/slow')), 'while the route that really missed the budget is named');

  timing.configure({ slowMs: 0, write: (l) => lines.push(l) });
  const alsoSlow = timing.begin('GET /api/slow');
  alsoSlow.t0 -= 5_000_000_000n;
  child('bd', 4900);
  timing.end(alsoSlow, 200);
  check(() => assert.equal(lines.length, 1), 'slowRequestMs 0 turns the log off');
  check(
    () => assert.equal(timing.snapshot().routes.find((r) => r.route === 'GET /api/slow').cold.n, 2),
    'and changes nothing about the counting, which is never off'
  );
}

/* --------------------------------------------------------- ending twice, and the ceiling */

console.log('\nthe things that would quietly corrupt the numbers\n');

{
  timing.reset();
  timing.configure({ slowMs: 0 });
  const rec = timing.begin('GET /api/once');
  timing.end(rec, 200);
  timing.end(rec, 200);
  check(
    () => assert.equal(timing.snapshot().routes.find((r) => r.route === 'GET /api/once').warm.n, 1),
    "`finish` and `close` both firing counts one request, not two"
  );
}

{
  timing.reset();
  for (let i = 0; i < 460; i += 1) timing.end(timing.begin(`GET /api/${i}`), 404);
  const snap = timing.snapshot();
  check(() => assert.ok(snap.routes.length <= 401, `the table grew to ${snap.routes.length}`), 'a scan of paths that do not exist cannot grow the table without bound');
  check(() => assert.ok(snap.overflow > 0), 'and it says how many it folded away, rather than looking complete');
  check(() => assert.ok(snap.routes.some((r) => r.route === 'other')), 'under one `other` key');
}

/* ------------------------------------------------------------------- Server-Timing */

{
  timing.reset();
  const rec = timing.begin('GET /api/hdr');
  rec.t0 -= 200_000_000n;
  child('bd', 120);
  const h = timing.header(rec);
  check(() => assert.match(h, /^total;dur=2\d\d\.\d/), `the header leads with the total — got ${h}`);
  check(() => assert.match(h, /bd;dur=120\.0/), 'then each binary it waited on');
  check(() => assert.match(h, /cache;desc=cold/), 'and whether it was warm or cold');
  timing.end(rec, 200);
}

/* ------------------------------------------------------------- against a real server */

console.log('\nagainst the real server\n');

const ws = path.join(tmp, 'ws');
const ws2 = path.join(tmp, 'ws2');
for (const dir of [ws, ws2]) fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });

/**
 * A `bd` that is slow on purpose, so "was this route's time really spent in a child
 * process" is a question the figures can answer rather than a rounding argument.
 */
const FAKE = path.join(tmp, 'bd');
fs.writeFileSync(FAKE, "#!/usr/bin/env node\nsetTimeout(() => process.stdout.write('[]'), 150);\n", { mode: 0o755 });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'timing-token',
  actor: 'beadcause-test',
  bdBin: FAKE,
  // Two, not one, and that is the point: `/api/questions` sweeps them concurrently, so
  // the summed child time runs past the request's own duration. One workspace could never
  // catch the accounting bug that made `ours` negative on a real nine-workspace install.
  workspaces: [
    { name: 'demo', dir: ws },
    { name: 'demo2', dir: ws2 },
  ],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  slowRequestMs: 0,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const get = (pathname) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { 'x-beadcause-token': cfg.token } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      }
    );
    req.on('error', reject);
    req.end();
  });

/** Whatever `fn` returns once it returns something, or null after `ms`. No clock in a pass condition. */
const until = async (fn, ms = 2000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 10));
  }
};

timing.reset();

const health = await get('/api/health');
check(() => assert.equal(health.status, 200), 'a request goes through');
check(
  () => assert.match(String(health.headers['server-timing'] || ''), /total;dur=/),
  `every response carries Server-Timing — got ${health.headers['server-timing']}`
);

/**
 * The assertion this file exists for. Both at once: one route that sweeps `bd` across the
 * workspace and one that touches nothing. If the request context leaked, the cheap one
 * comes back cold with somebody else's child process on its bill — and every figure in
 * the table would be plausible and wrong.
 */
const [swept, cheap] = await Promise.all([get('/api/questions'), get('/api/health')]);
check(() => assert.equal(swept.status, 200), 'a bd-sweeping route answers');
check(() => assert.equal(cheap.status, 200), 'and so does a cheap one fired beside it');

const snap = timing.snapshot();
const rowFor = (route) => snap.routes.find((r) => r.route === route);

const questions = rowFor('GET /api/questions');
check(() => assert.ok(questions?.cold, `no cold row: ${JSON.stringify(questions)}`), '/api/questions is recorded cold — it paid for a sweep');
check(() => assert.ok(questions.cold.calls >= 1, `calls: ${questions.cold.calls}`), 'with the bd calls it made');
check(
  () => assert.ok(questions.cold.subShare > 0.4, `subShare ${questions.cold.subShare}`),
  'and most of its time attributed to the subprocess rather than to us'
);
/**
 * The regression that the first real measurement found: two workspaces swept at once
 * report more child time than the request took, so a share computed off the *sum* comes
 * out over 1 and "ours" comes out negative. The union is what makes both honest.
 */
check(
  () => assert.ok(questions.cold.childWorkMs >= questions.cold.subMs, `${questions.cold.childWorkMs} < ${questions.cold.subMs}`),
  'the summed child work is at least the wall time waited — a fan-out cannot be under it'
);
check(() => assert.ok(questions.cold.subShare <= 1, `subShare ${questions.cold.subShare}`), 'the share stays inside the request');
check(() => assert.ok(questions.cold.oursMs >= 0, `oursMs ${questions.cold.oursMs}`), 'and our own half is never negative');

const healthRow = rowFor('GET /api/health');
check(() => assert.ok(healthRow?.warm, `no warm row: ${JSON.stringify(healthRow)}`), '/api/health is recorded warm');
check(
  () => assert.equal(healthRow.warm.calls, 0, `it was charged ${healthRow.warm.calls} child processes`),
  'and is charged nothing at all for the sweep running beside it'
);
check(() => assert.ok(!healthRow.cold, 'it has a cold bucket'), 'so it never appears as a cold route');

/**
 * The path that a `try`/`finally` would have missed entirely — and it is most of a page
 * load. A static file is handed to the socket as a read stream; the handler returns long
 * before the response ends.
 *
 * Waited for rather than read straight away, and the reason is a fact about the
 * measurement worth knowing: the record closes on the response's own `finish`, which for
 * a piped stream can land a tick *after* the client has all the bytes. A row that is
 * absent the instant a client is satisfied is not a missing row.
 */
const page = await get('/index.html');
const staticRow = await until(() => timing.snapshot().routes.find((r) => r.route === 'GET /index.html'));
check(() => assert.ok(page.status === 200 || page.status === 302, `got ${page.status}`), 'a static file is served');
check(() => assert.ok(staticRow, 'no row for the static GET'), 'and a streamed response is timed too — the handler never returns through the dispatch');

const view = await get('/api/timings');
check(() => assert.equal(view.status, 200), 'GET /api/timings answers');
const payload = JSON.parse(view.body || '{}');
check(() => assert.ok(Array.isArray(payload.routes) && payload.routes.length >= 3), 'with a row per route');
check(() => assert.equal(payload.budgetMs, 1000), 'and the budget the routes are judged against');
check(
  () =>
    assert.ok(
      payload.routes.some((r) => r.route === 'GET /api/questions' && r.cold?.subShare > 0),
      'the sweep is not in the payload'
    ),
  'and it is the same figures, over HTTP, which is where the phone reads them'
);

/* ---------------------------------------------------------------------- done */

for (const s of servers) s.close();
await cleanupTmp(tmp);

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
