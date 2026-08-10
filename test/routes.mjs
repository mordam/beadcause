#!/usr/bin/env node
/**
 * The routing table, and the one screen that proved it needed checking.
 *
 *     npm test
 *     node test/routes.mjs
 *
 * bc-dwqh: `GET /api/foundation` was registered twice in `lib/server.js` — the
 * foundation *channel* near the top of the handler, and one *agent* by id nine
 * hundred lines below it, at the same brace depth in the same straight-line
 * `if`-chain. The first returned; the second was dead code. So the Foundations
 * agent-detail screen fetched `{requests, workspaces}`, read `data.agent` as
 * `undefined`, and threw on `a.title` — after `#list` had been hidden, which is why it
 * showed as the list vanishing with nothing replacing it. Four tabs, the amend flow,
 * the per-agent chat and the activity list were all behind that one call.
 *
 * The suite was green throughout, and that is the part worth fixing properly. The only
 * thing exercising that screen was `scripts/queue-check.mjs`, which drives the real
 * `public/foundations.js` against a *fake* server — and the fake answered
 * `/api/foundation` with `{agent}`, the payload the client wants. The fake was right
 * about the contract and the real server was wrong about it, which is the one
 * arrangement where a passing suite means nothing at all.
 *
 * So this file does the two things that could not both be true afterwards:
 *
 * 1. **It hits `createApp`.** Every assertion here is against the real handler over a
 *    real socket. No fake can make this pass.
 * 2. **It holds the fakes to the real table.** Every literal `/api/…` path any
 *    `scripts/*-check.mjs` answers has to be a path the real server registers. A fake
 *    inventing an endpoint is how the first bug hid, and now it is a failure here
 *    rather than a screen that goes blank in your hand.
 *
 * Plus the boot-time guard itself: `assertRoutes` throws on a duplicate
 * `(method, path)`, and `routeTable` really does see the routes it is asked about —
 * a scanner that silently matched nothing would make the guard vacuous and green.
 *
 * No `bd`, no advocates, no poller, no network beyond loopback, nothing written
 * outside a temp directory. `agentDetail` reads amendment history out of a git ref
 * and falls back to the release baseline when there is no repo, which a temp
 * directory is — so the agent this asserts on is the shipped definition.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-routes-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { createApp, listen, routeTable, assertRoutes } = await import(LIB('server.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

/* ----------------------------------------------------------------- the app */

const ws = path.join(tmp, 'demo');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

/**
 * A `bd` that answers nothing, from a fixture rather than from the machine.
 *
 * The channel route sweeps `bd` per workspace, and without this it shells out to
 * whatever `bd` this laptop happens to have — a real issue graph, real latency, and a
 * different answer on every machine. `.cjs` because it is spawned by absolute path
 * from a temp directory, and the extension is what settles how node parses it.
 */
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(BD, '#!/usr/bin/env node\nconsole.log("[]");\n', { mode: 0o755 });

const cfg = {
  port,
  host: '127.0.0.1',
  baseUrl: `http://127.0.0.1:${port}`,
  token: 'routes-token',
  bdBin: BD,
  actor: 'beadcause-test',
  workspaces: [{ name: 'demo', dir: path.join(ws, '.beads') }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  agents: [],
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

// This call is itself a check: createApp runs assertRoutes, so a duplicate route in
// lib/server.js fails the suite here, before a single request is made.
const app = createApp(cfg);
const servers = listen(cfg, app.handler);

const get = async (p) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'x-beadcause-token': cfg.token } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

for (let i = 0; i < 100; i += 1) {
  try {
    await get('/api/status');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* --------------------------------------------------------------------- cases */

console.log('\nroutes\n');

/**
 * Exactly what `loadAgent()` in public/foundations.js does, against the real server.
 *
 * The field list is not decoration: `renderDetail` reads `title` before anything
 * else, `renderFoundation` reads `amended` and `protectedFields`, `renderHistory`
 * reads `amendmentHistory` and `renderActivity` reads `activity` and `runs`. All four
 * tabs are drawn from this one response, so all four are asserted from it.
 */
await check('GET /api/foundation/agent returns one agent, with what all four tabs read', async () => {
  const { status, body } = await get('/api/foundation/agent?id=advocate&workspace=demo');
  assert.equal(status, 200);
  assert.equal(body.workspace, 'demo');
  assert.ok(body.agent, 'no agent in the response — this is the bc-dwqh failure exactly');
  assert.equal(body.agent.id, 'advocate');
  assert.equal(typeof body.agent.title, 'string', 'renderDetail throws on a missing title');
  assert.ok(Array.isArray(body.agent.protectedFields), 'renderFoundation draws the locked rows from this');
  assert.ok(Array.isArray(body.agent.amendableFields));
  assert.ok(Array.isArray(body.agent.amended));
  assert.ok(Array.isArray(body.agent.amendmentHistory), 'the History tab');
  assert.ok(Array.isArray(body.agent.activity), 'the Activity tab');
  assert.ok(Array.isArray(body.agent.runs), 'the Activity tab');
});

// Unnamed resolves to the first configured workspace, which is how the screen opens
// before you have picked one — and is a path through agentTarget the named case skips.
await check('GET /api/foundation/agent works without a workspace', async () => {
  const { status, body } = await get('/api/foundation/agent?id=advocate');
  assert.equal(status, 200);
  assert.equal(body.workspace, 'demo');
  assert.equal(body.agent.id, 'advocate');
});

await check('an agent that does not exist is a 404, not a blank screen', async () => {
  const { status, body } = await get('/api/foundation/agent?id=nonesuch');
  assert.equal(status, 404);
  assert.match(String(body.error), /no such agent/);
});

/**
 * The channel keeps its own name. It is the older route of the two — it is in the
 * README, it is what a badge or a watch face polls, and it is the one a `curl` line
 * written months ago still uses — so the *narrower* route is the one that moved.
 */
await check('GET /api/foundation is still the channel, and only the channel', async () => {
  const { status, body } = await get('/api/foundation');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.requests), 'the channel returns requests');
  assert.deepEqual(body.workspaces, ['demo']);
  assert.equal(body.agent, undefined, 'the agent detail must not be back on this path');
});

/* ------------------------------------------------------- the boot-time guard */

await check('routeTable sees both foundation routes, so the guard is not vacuous', () => {
  const table = routeTable(app.handler);
  assert.ok(table.includes('GET /api/foundation'), 'the channel is not in the table');
  assert.ok(table.includes('GET /api/foundation/agent'), 'the agent detail is not in the table');
  // A sanity floor rather than an exact count: this file should not need editing every
  // time a route is added, but a scanner that fell to a handful has stopped working.
  assert.ok(table.length > 30, `only ${table.length} routes found — the scanner has stopped matching`);
});

await check('the real handler registers nothing twice', () => {
  const table = routeTable(app.handler);
  const dupes = table.filter((r, i) => table.indexOf(r) !== i);
  assert.deepEqual([...new Set(dupes)], []);
  assertRoutes(app.handler);
});

await check('assertRoutes throws on a duplicate, and names it', () => {
  // The bug as it was written: same path, same method, far apart, both reachable-looking.
  const doubled = async (req, res) => {
    const p = req.url;
    if (p === '/api/foundation' && req.method === 'GET') return res.end('channel');
    if (p === '/api/other' && req.method === 'POST') return res.end('other');
    if (p === '/api/foundation' && req.method === 'GET') return res.end('agent');
  };
  assert.throws(() => assertRoutes(doubled), /GET \/api\/foundation/);
});

await check('the same path under two methods is fine', () => {
  const fine = async (req, res) => {
    const p = req.url;
    if (p === '/api/presence' && req.method === 'GET') return res.end('read');
    if (p === '/api/presence' && req.method === 'POST') return res.end('write');
    if (req.method === 'DELETE' && p === '/api/presence') return res.end('gone');
  };
  assert.deepEqual(assertRoutes(fine).sort(), [
    'DELETE /api/presence',
    'GET /api/presence',
    'POST /api/presence',
  ]);
});

/* ------------------------------------------------- the fakes, held to the real */

/**
 * No fake may answer a path the real server does not have.
 *
 * This is the check that would have caught bc-dwqh on the day it was written. Nineteen
 * `scripts/*-check.mjs` files drive the real client bundles against hand-written stub
 * servers, which is the only practical way to exercise a page in a headless browser —
 * but a stub is a second, unversioned opinion about the API, and when it drifts it
 * drifts *towards* whatever makes the client work. Path existence is the cheapest
 * property that catches that, and it needs no cooperation from the fakes.
 */
await check('every path the fake servers answer is a path the real server registers', () => {
  const real = new Set(routeTable(app.handler).map((r) => r.split(' ')[1]));
  const missing = [];
  const dir = path.join(ROOT, 'scripts');
  const fakes = fs.readdirSync(dir).filter((f) => f.endsWith('-check.mjs'));
  assert.ok(fakes.length > 5, `only ${fakes.length} check scripts found — the glob has stopped working`);
  for (const f of fakes) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/p === '(\/api\/[^']*)'/g)) {
      if (!real.has(m[1])) missing.push(`scripts/${f} answers ${m[1]}, which the real server does not register`);
    }
  }
  assert.deepEqual(missing, []);
});

/* ------------------------------------------------------------------- teardown */

for (const s of servers || []) s.close?.();
app.advocates?.stop?.();

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
