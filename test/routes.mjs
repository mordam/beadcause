#!/usr/bin/env node
/**
 * No two handlers on one method and path — and the three foundation routes prove it.
 *
 *     npm test
 *     node test/routes.mjs
 *
 * `lib/server.js` dispatches with a flat `if (p === … && req.method === …)` chain, and
 * a chain has a property a route table does not: registering the same pair twice is
 * legal, silent, and first-one-wins. `GET /api/foundation` was registered twice — the
 * foundation *channel* at the top of the chain, one agent's foundation six hundred
 * lines below it — so the second never ran once. Every open of the agents detail screen
 * got `{requests, workspaces}` where it wanted `{agent}`, set `state.agent` to
 * undefined, and threw in `renderDetail()` on `a.title`. It threw *after* `#list` was
 * hidden, so the symptom was the agents list vanishing and nothing replacing it: four
 * tabs, the amend flow and the per-agent chat, all behind one shadowed handler.
 *
 * Two checks, and they are deliberately different in kind, because the bug needed both
 * to survive:
 *
 * 1. **The chain has no duplicate pair.** A static read of the source, not a request —
 *    the point is to catch the *next* collision, in a route this file has never heard
 *    of, on the day it is written. A duplicate is only ever a mistake: the handler
 *    that loses is dead code, and dead code that looks live is what cost this one.
 *
 * 2. **The real server answers all three foundation paths with the right shape.** The
 *    reason a green suite meant nothing here is that the only check on this screen was
 *    `scripts/queue-check.mjs`, which drives a browser against a *fake* server — and
 *    the fake answered `/api/foundation` with the agent payload, because it was written
 *    from the contract the client wanted. It was right about the contract and the real
 *    server was wrong about it, which is the one arrangement where the fake proves the
 *    opposite of what it looks like it proves. So these three go to `createApp`.
 *
 * No `bd`, no tracker, no workspace with anything in it: agent foundations come off
 * `lib/foundation.js` and the scratch directory below, and the channel needs a `bd`
 * only to have something to report, which an empty answer covers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-routes-'));
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

console.log('\nthe route chain\n');

/* ------------------------------------------------------- one pair, one handler */

/**
 * Every `(method, path)` the chain dispatches on, in source order.
 *
 * Matched off the source rather than by instrumenting the handler because the thing
 * being checked is what is *written*, and a shadowed branch is by definition one no
 * request can reach — a runtime probe would see the winner and report health. Both
 * orders are matched: `p === x && req.method === y` is the house style, and the
 * reverse reads identically to anyone adding a route.
 */
const SRC = fs.readFileSync(LIB('server.js'), 'utf8');
const pairs = [];
const forward = /if \(\s*p === '([^']+)'\s*&&\s*req\.method === '([A-Z]+)'/g;
const backward = /if \(\s*req\.method === '([A-Z]+)'\s*&&\s*p === '([^']+)'/g;
for (const m of SRC.matchAll(forward)) pairs.push({ path: m[1], method: m[2], at: m.index });
for (const m of SRC.matchAll(backward)) pairs.push({ path: m[2], method: m[1], at: m.index });

const lineOf = (index) => SRC.slice(0, index).split('\n').length;
const seen = new Map();
const dupes = [];
for (const r of pairs) {
  const key = `${r.method} ${r.path}`;
  if (seen.has(key)) dupes.push(`${key} — lib/server.js:${lineOf(seen.get(key))} and :${lineOf(r.at)}`);
  else seen.set(key, r.at);
}

// A floor, so a regex that silently stops matching cannot pass as "no duplicates".
// The chain had 56 method+path handlers when this was written; it only grows.
check(() => assert.ok(pairs.length >= 50, `only found ${pairs.length} handlers — has the dispatch style changed?`), `the chain is readable — ${pairs.length} handlers found`);
check(
  () => assert.deepEqual(dupes, [], `\n      ${dupes.join('\n      ')}`),
  'and no (method, path) is registered twice, so no handler is shadowed'
);

/* ------------------------------------------------- the README knows what it serves */

/**
 * Every `/api` path the server answers is in the README's API table, and every one in
 * the table is answered.
 *
 * Both directions, because both had gone wrong and they fail differently. Seventeen of
 * the forty-nine paths were missing — not a sloppy row here and there but *whole
 * surfaces*: `/api/admin`, `/api/prs` and the rest of the PR board, `/api/foundations`,
 * `/api/filter`. And the table carried a row for `GET /api/advocates`, which had no
 * caller in the repo at all; the row was the only evidence it should exist, which is
 * precisely how a route with nothing behind it stays convincing enough not to delete.
 *
 * A documentation check earns its place in a suite only when the drift is invisible
 * otherwise, and this one was: nothing about serving an undocumented route feels wrong
 * from inside the server, and nothing about documenting an unserved one feels wrong from
 * inside the README.
 */
const README = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8');
/**
 * `(method, path)` on both sides, not path alone.
 *
 * Path granularity looks like it works and quietly does not: `/api/presence` answers
 * GET, POST and DELETE, so deleting the GET row leaves the path still "documented" by
 * its two siblings and the check passes over a hole. The duplicate scan above is already
 * per pair, and these two claims should not disagree about what a route is.
 *
 * Table rows only — `| GET | \`/api/x\` | … |` — rather than every mention of a path in
 * 4,800 lines of prose. A route argued about in a paragraph is not a documented one.
 */
const documented = new Set();
for (const m of README.matchAll(/^\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*`(\/api\/[a-z/-]+)`/gim)) {
  documented.add(`${m[1].toUpperCase()} ${m[2]}`);
}
const served = new Set(pairs.map((r) => `${r.method} ${r.path}`));
// `/api/health` is in the table and answered before the token check, above the chain
// these pairs come from — so it is served, just not by a line this scan can see.
served.add('GET /api/health');

const undocumented = [...served].filter((r) => !documented.has(r)).sort();
const phantom = [...documented].filter((r) => !served.has(r)).sort();

check(
  () => assert.ok(documented.size >= 40, `only ${documented.size} rows matched — has the API table moved or changed shape?`),
  `the README's API table is readable — ${documented.size} routes in it`
);
check(
  () => assert.deepEqual(undocumented, [], `served but undocumented: ${undocumented.join(', ')}`),
  'every /api path the server answers is in it'
);
check(
  () => assert.deepEqual(phantom, [], `documented but not served: ${phantom.join(', ')}`),
  'and every route in it is one the server answers'
);

/* ------------------------------------------------------------------- the app */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

// A bd that answers everything with an empty list. The channel's shape is the claim
// here, not its contents — an agent's foundation does not come from bd at all.
const FAKE = path.join(tmp, 'bd');
fs.writeFileSync(FAKE, "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'routes-token',
  actor: 'beadcause-test',
  bdBin: FAKE,
  workspaces: [{ name: 'demo', dir: ws }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

// foundation.js first: it and agents.js import each other, and agents.js is not the
// end of that cycle that can be pulled in cold.
await import(LIB('foundation.js'));
const { createApp, listen, routeTable, assertRoutes } = await import(LIB('server.js'));

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
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.end();
  });

console.log('\nthe three foundation paths, against the real server\n');

/* ------------------------------------------------- the channel keeps the bare path */

const channel = await get('/api/foundation');
check(() => assert.equal(channel.status, 200), 'GET /api/foundation answers 200');
check(
  () => assert.ok(Array.isArray(channel.json.requests), `got ${JSON.stringify(channel.json).slice(0, 120)}`),
  'and it is the requests channel — the caller that wants the channel without the inbox'
);

/* --------------------------------------------------------- the list, and one agent */

const list = await get('/api/foundations?workspace=demo');
check(() => assert.equal(list.status, 200), 'GET /api/foundations answers 200');
check(() => assert.ok(list.json.agents?.length, `got ${JSON.stringify(list.json).slice(0, 120)}`), 'with every agent kind on it');

const first = list.json.agents?.[0]?.id;
const one = await get(`/api/foundation/agent?id=${encodeURIComponent(first || 'console')}&workspace=demo`);
check(() => assert.equal(one.status, 200), `GET /api/foundation/agent?id=${first} answers 200`);
// The assertion the whole file exists for. `agent` being present is what
// public/foundations.js reads into `state.agent`, and `agent.title` is the first thing
// renderDetail() touches — the exact line that threw while this route was shadowed.
check(
  () => assert.ok(one.json.agent?.title, `no agent.title in ${JSON.stringify(one.json).slice(0, 120)}`),
  'and returns that agent, with the title renderDetail() reads first'
);
check(() => assert.equal(one.json.workspace, 'demo'), 'and the workspace it resolved the foundation in');

const nonsense = await get('/api/foundation/agent?id=../etc/passwd&workspace=demo');
check(() => assert.equal(nonsense.status, 404), 'an id that is not an agent kind is a 404, not a file read');

/* ------------------------------------------------------- and the same check at boot */

/**
 * The duplicate scan again, this time inside `createApp`.
 *
 * The static scan at the top of this file catches a duplicate the day someone runs the
 * suite. `assertRoutes` catches one the moment a process starts, which is not the same
 * day: this repo hot-swaps a fresh backend under the port a few seconds after `lib/`
 * settles, and code arrives there by merge and by cherry-pick as well as by the branch
 * that ran `npm test`. A duplicate that gets past the suite would otherwise reach a
 * running daemon and do exactly what bc-dwqh did — answer 200 with the wrong body,
 * which reads as healthy from every direction.
 *
 * Three claims, and the middle one is the one that rots. `routeTable` reads the
 * handler's own source; this file reads `lib/server.js` off disk. They are two regexes
 * over the same text, so they should see the same routes — and if the one at boot ever
 * stops matching, it degrades into a silent no-op that passes forever. Nothing at
 * runtime can tell the difference. This can.
 */
console.log('\nand the same check at boot\n');

const booted = routeTable(app.handler).sort();
const scanned = [...new Set(pairs.map((r) => `${r.method} ${r.path}`))].sort();

check(
  () => assert.ok(booted.length >= 50, `routeTable saw only ${booted.length} routes — has the dispatch style changed?`),
  `createApp's own scan reads the chain — ${booted.length} routes found`
);
check(
  () => assert.deepEqual(booted, scanned, 'the boot scan and the file scan disagree about what is registered'),
  'and sees exactly what a read of lib/server.js sees'
);

// The handler is a string to `routeTable`, so a function whose body says it twice is a
// faithful duplicate — no second copy of server.js, and no way for this to pass by
// accident on a chain that happens to be clean.
const twice = (req, res, p) => {
  if (p === '/api/twice' && req.method === 'GET') return res;
  if (p === '/api/twice' && req.method === 'GET') return res;
  return null;
};
check(() => {
  assert.throws(() => assertRoutes(twice), /registered twice/);
  const err = (() => {
    try {
      assertRoutes(twice);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.match(err.message, /GET \/api\/twice/, `the error does not name the route: ${err.message}`);
}, 'a duplicated pair refuses to start, and the error names the route');

check(
  () => assert.deepEqual(assertRoutes(app.handler).sort(), scanned),
  'while the real chain starts, which is what createApp just did'
);

/* ---------------------------------------------------------------------- done */

for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
