#!/usr/bin/env node
/**
 * The workspace-wide graph, on the shared cache layer — one key per workspace.
 *
 *     npm test
 *     node test/graphcache.mjs
 *
 * bc-1kwl.12. `GET /api/graph` with no `id` was the single worst request in the app —
 * 120.1s at the tail — because `bd graph --all --html` plus a `bd list --status` ran
 * uncached on every load of the graph page. lib/cache.js's key convention says the fix
 * has to be a key spelled by code, never by anything a request carries (lib/cache.js:
 * 69-72); the `id`-less form is exactly that, one key per workspace, which is what
 * `workspaceGraph` puts on the layer. The per-bead form (`?id=`) is deliberately not
 * covered here — it stayed off the layer, and bc-1kwl.12's notes carry why.
 *
 * Four claims:
 *
 * 1. **The key is `graph:<workspace>`** — the convention every other caller on the
 *    layer already spells its keys with.
 * 2. **A cold read spawns both `bd` calls once**, and a read inside the window spawns
 *    neither — the whole of what a cache is for.
 * 3. **Two readers arriving together on a cold key single-flight to one sweep**, the
 *    same property lib/cache.js's own suite asserts generically, checked again here
 *    against the real producer this bead wires in.
 * 4. **`warmGraphs` is cold-only** — it fills a workspace's key once and never again
 *    while anything is kept, the same shape `warmBoard` and `endorsequeue.warm` already
 *    have a suite for (test/warmcycle.mjs).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-graphcache-'));
// Before the first import of anything under lib/: CONFIG_DIR resolves once, at load.
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
const check = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\nthe workspace-wide graph, on the shared cache layer\n');

const cache = await import(LIB('cache.js'));
const { graphKey, workspaceGraph, warmGraphs, GRAPH_FRESH_MS } = await import(LIB('graph.js'));

const WS = { name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') };
const OTHER = { name: 'beta', dir: path.join(tmp, 'beta', '.beads') };

/** A `bd` that counts what it was asked, and answers with an empty-but-parseable graph. */
const countingBd = () => {
  const calls = { graphHtml: 0, listStatus: 0 };
  return {
    calls,
    graphHtml: async (ws, id) => {
      calls.graphHtml += 1;
      assert.equal(id, null, 'the workspace-wide form must ask bd for no particular bead');
      return `<script>const nodes = [];\nconst links = [];</script>`;
    },
    listStatus: async () => {
      calls.listStatus += 1;
      return [];
    },
  };
};

check('the key is spelled graph:<workspace>, the layer\'s own convention', () => {
  assert.equal(graphKey('alpha'), 'graph:alpha');
  assert.equal(graphKey('sophab'), 'graph:sophab');
});

await check('a cold read spawns both bd calls once, and the value is the pair', async () => {
  cache.clear();
  const bd = countingBd();
  const got = await workspaceGraph(bd, WS);
  assert.equal(bd.calls.graphHtml, 1);
  assert.equal(bd.calls.listStatus, 1);
  assert.deepEqual(got.value.rows, []);
  assert.ok(got.value.html.includes('const nodes'));
  assert.equal(got.stale, false, 'a value just produced is not stale');
});

await check('a read inside the window is served from memory — no bd call at all', async () => {
  cache.clear();
  const bd = countingBd();
  await workspaceGraph(bd, WS);
  const before = { ...bd.calls };
  for (let i = 0; i < 5; i += 1) await workspaceGraph(bd, WS);
  assert.deepEqual(bd.calls, before, 'a warm read must not spawn bd');
});

await check('two readers on a cold key single-flight to one sweep', async () => {
  cache.clear();
  const bd = countingBd();
  const [a, b] = await Promise.all([workspaceGraph(bd, WS), workspaceGraph(bd, WS)]);
  assert.equal(bd.calls.graphHtml, 1, 'two concurrent cold reads must cause one bd graph call');
  assert.equal(bd.calls.listStatus, 1);
  assert.deepEqual(a.value, b.value);
});

await check('the key is per workspace — one workspace\'s read never fills another\'s', async () => {
  cache.clear();
  const bd = countingBd();
  await workspaceGraph(bd, WS);
  assert.equal(cache.peek(graphKey(WS.name)) !== null, true);
  assert.equal(cache.peek(graphKey(OTHER.name)), null);
});

await check('refresh:true pays for a fresh sweep even inside the window', async () => {
  cache.clear();
  const bd = countingBd();
  await workspaceGraph(bd, WS);
  await workspaceGraph(bd, WS, { refresh: true });
  assert.equal(bd.calls.graphHtml, 2, 'refresh must not be served from memory');
});

await check('the window is 60 seconds — Bd.graph\'s own long-standing precedent for this shape of call', () => {
  assert.equal(GRAPH_FRESH_MS, 60_000);
});

/* --------------------------------------------------------- warmGraphs, cold-only */

await check('warmGraphs fills a cold workspace and reports it filled', async () => {
  cache.clear();
  const bd = countingBd();
  const filled = await warmGraphs(bd, [WS]);
  assert.deepEqual(filled, ['alpha']);
  assert.equal(bd.calls.graphHtml, 1);
});

await check('and never sweeps again while anything is kept — the shape warmBoard and warmQueue share', async () => {
  cache.clear();
  const bd = countingBd();
  await warmGraphs(bd, [WS]);
  const after = bd.calls.graphHtml;
  for (let i = 0; i < 5; i += 1) {
    const filled = await warmGraphs(bd, [WS]);
    assert.deepEqual(filled, [], `beat ${i + 2} re-swept a filled key`);
  }
  assert.equal(bd.calls.graphHtml, after, 'a warmed key must cost no further bd call');
});

await check('warmGraphs only fills the workspaces that are actually cold', async () => {
  cache.clear();
  const bd = countingBd();
  await workspaceGraph(bd, WS); // alpha is already warm
  const before = bd.calls.graphHtml;
  const filled = await warmGraphs(bd, [WS, OTHER]);
  assert.deepEqual(filled, ['beta'], 'only the cold workspace should have been swept');
  assert.equal(bd.calls.graphHtml, before + 1);
});

await check('and fills again once the key is dropped — a graph nobody looked at while stale', async () => {
  cache.clear();
  const bd = countingBd();
  await warmGraphs(bd, [WS]);
  cache.drop(graphKey(WS.name));
  const filled = await warmGraphs(bd, [WS]);
  assert.deepEqual(filled, ['alpha']);
});

console.log(`\n${ran - failures}/${ran} passed`);
cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
