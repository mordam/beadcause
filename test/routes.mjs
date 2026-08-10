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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const { createApp, listen } = await import(LIB('server.js'));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const app = createApp({ ...cfg, port });
const servers = listen({ ...cfg, port }, app.handler);

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

for (let i = 0; i < 100; i += 1) {
  try {
    await get('/api/health');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}

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

/* ---------------------------------------------------------------------- done */

for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
