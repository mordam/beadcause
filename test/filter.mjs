/**
 * The inbox filter — the two chip rows — held on the server instead of in the tab.
 *
 * Picking a space and a workspace used to last exactly as long as the document did,
 * and the four views are four documents, so Inbox → Console → Inbox lost it. Moving
 * it to the server fixes that, and introduces three ways to be quietly wrong:
 *
 * 1. **A writer clobbered another writer.** state.json has several owners and each
 *    knows only its own keys: the poller saves `{ notified, commentCounts }` from
 *    four separate places, and a filter write can land between any two of them. A
 *    wholesale write from either side drops the other's key — silently, only under
 *    concurrency. The merge lives in `saveState` itself precisely so that one test
 *    covers all four call sites rather than three of them staying broken behind a
 *    green tick; the last case here is what keeps it that way.
 * 2. **A stale filter pinned the list empty.** The filter now outlives the config it
 *    was picked under, so a renamed space, a dropped workspace or a workspace that
 *    moved between spaces are all reachable states — and each one shows as an empty
 *    list with no chip pressed to explain it.
 * 3. **The response stopped being additive.** /api/questions is read by the installed
 *    Android build and by a service worker still serving last week's app.js. Every
 *    field they already read has to still be there.
 *
 * Nothing here touches the network beyond loopback or writes outside a temp
 * directory. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-filter-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { loadState, saveState, STATE_PATH } = await import(LIB('config.js'));
const { reconcileFilter, summarise } = await import(LIB('spaces.js'));
const { createApp, listen } = await import(LIB('server.js'));

/* ------------------------------------------------------------------ fixtures */

const WS = ['alpha', 'beta', 'gamma'].map((name) => {
  const dir = path.join(tmp, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return { name, dir };
});

const bead = (id, title) => ({
  id,
  title,
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: ['human'],
  created_at: '2026-08-09T10:00:00Z',
  updated_at: '2026-08-09T10:00:00Z',
});

const ROWS = {
  [WS[0].dir]: [bead('a-1', 'Something in alpha')],
  [WS[1].dir]: [bead('b-1', 'Something in beta')],
  // Assigned to no space, so it is what makes the synthetic "Other" group exist.
  [WS[2].dir]: [bead('g-1', 'Something nobody filed anywhere')],
};

const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const rows = ${JSON.stringify(ROWS)};
let out = [];
if (args[0] === 'human' && args[1] === 'list') out = rows[process.env.BEADS_DIR] || [];
console.log(JSON.stringify(out));
`,
  { mode: 0o755 }
);

const PORT = 4383;
const cfg = {
  port: PORT,
  host: '127.0.0.1',
  token: 'test-token',
  bdBin: BD,
  actor: 'beadcause-test',
  workspaces: WS,
  spaces: [
    { name: 'Work', workspaces: ['alpha'] },
    { name: 'Personal', workspaces: ['beta'] },
  ],
  claudeSessionsDir: path.join(tmp, 'sessions'),
  advocates: { enabled: false, workspaces: [] },
  openSessions: false,
  agents: [],
  ntfy: {},
};

const get = async (query = '') => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/questions${query}`, {
    headers: { 'x-beadcause-token': cfg.token },
  });
  assert.equal(res.status, 200, `GET /api/questions${query} should be 200`);
  return res.json();
};

const put = async (body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/filter`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, 'POST /api/filter should be 200');
  return res.json();
};

const onDisk = () => JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

/* ------------------------------------------------------------------- harness */

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
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

/* ------------------------------------------------------- the state file's shape */

console.log('inbox filter');

await check('an absent state file still hands back every key', () => {
  fs.rmSync(STATE_PATH, { force: true });
  assert.deepEqual(loadState(), { notified: [], commentCounts: {}, filter: null });
});

await check('a torn state file is the same as no state file', () => {
  fs.writeFileSync(STATE_PATH, '{"notified": ["bc-1", ');
  assert.deepEqual(loadState(), { notified: [], commentCounts: {}, filter: null });
  // Not a special case of "unparseable": a file that parses to something that is not
  // an object reaches the readers just as easily.
  fs.writeFileSync(STATE_PATH, '"nonsense"');
  assert.deepEqual(loadState(), { notified: [], commentCounts: {}, filter: null });
});

await check('a filter written between two polls survives the next one', () => {
  fs.rmSync(STATE_PATH, { force: true });
  // What the poller holds and saves — the literal shape all four of its call sites
  // in lib/server.js pass.
  saveState({ notified: ['alpha/a-1'], commentCounts: { 'alpha/a-1': 3 } });
  saveState({ filter: { space: 'Work', workspace: 'alpha' } });
  saveState({ notified: ['alpha/a-1', 'beta/b-1'], commentCounts: { 'alpha/a-1': 4 } });

  const state = loadState();
  assert.deepEqual(state.filter, { space: 'Work', workspace: 'alpha' }, 'the poll must not clobber the filter');
  assert.deepEqual(state.notified, ['alpha/a-1', 'beta/b-1'], 'and the poll must still own its own keys');
  assert.deepEqual(state.commentCounts, { 'alpha/a-1': 4 });
});

await check('and the filter write does not clobber the poll', () => {
  saveState({ filter: { space: 'Personal', workspace: 'beta' } });
  const state = loadState();
  assert.deepEqual(state.notified, ['alpha/a-1', 'beta/b-1']);
  assert.deepEqual(state.commentCounts, { 'alpha/a-1': 4 });
  assert.deepEqual(state.filter, { space: 'Personal', workspace: 'beta' });
});

await check('a key its owner rewrote is replaced, not merged into', () => {
  // The merge is one level deep on purpose. A caller handing over `commentCounts` is
  // saying *these are the counts now* — the poll drops answered questions by
  // rebuilding the object, and a deep merge would resurrect every one of them.
  saveState({ notified: [], commentCounts: {} });
  const state = loadState();
  assert.deepEqual(state.notified, []);
  assert.deepEqual(state.commentCounts, {});
  assert.deepEqual(state.filter, { space: 'Personal', workspace: 'beta' }, 'the other owner is still untouched');
});

await check('no source file carries an invisible control byte', () => {
  // Not really about the filter — it is here because writing this feature is what
  // introduced one. A NUL inside a template literal is legal JavaScript and runs
  // perfectly, and it turns the file binary: `grep` then finds *nothing* in it and
  // says nothing about why, which is a bad half-hour for the next person and a
  // silently wrong answer for an agent. Cheap to check, invisible in review.
  const roots = ['lib', 'public'];
  const bad = [];
  for (const root of roots) {
    const dir = path.join(HERE, '..', root);
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(js|mjs)$/.test(name)) continue;
      const buf = fs.readFileSync(path.join(dir, name));
      // Everything below space except tab, newline and carriage return.
      const at = buf.findIndex((b) => b < 32 && b !== 9 && b !== 10 && b !== 13);
      if (at >= 0) bad.push(`${root}/${name} byte ${at} = 0x${buf[at].toString(16)}`);
    }
  }
  assert.deepEqual(bad, [], `control bytes found: ${bad.join(', ')}`);
});

await check('nothing else writes state.json behind saveState', () => {
  // The merge above is the whole fix for four separate call sites, which only holds
  // while `saveState` is the only way in. A direct write would pass every test here
  // and clobber in production.
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'server.js'), 'utf8');
  assert.ok(!/writeJsonAtomic/.test(src), 'lib/server.js must reach state.json through saveState');
});

/* ---------------------------------------------------------- staleness, in the pure bit */

const SPACES = summarise(cfg, [{ workspace: 'alpha' }, { workspace: 'beta' }, { workspace: 'gamma' }]);
const NAMES = WS.map((w) => w.name);

await check('a filter naming things that exist is left alone', () => {
  assert.deepEqual(reconcileFilter(SPACES, NAMES, { space: 'Work', workspace: 'alpha' }), {
    space: 'Work',
    workspace: 'alpha',
  });
});

await check('nothing saved yet reads as everything', () => {
  assert.deepEqual(reconcileFilter(SPACES, NAMES, null), { space: 'all', workspace: 'all' });
  assert.deepEqual(reconcileFilter(SPACES, NAMES, { space: 42, workspace: [] }), { space: 'all', workspace: 'all' });
});

await check('a space that has gone falls back, and a live workspace is kept', () => {
  assert.deepEqual(reconcileFilter(SPACES, NAMES, { space: 'Renamed', workspace: 'beta' }), {
    space: 'all',
    workspace: 'beta',
  });
});

await check('a workspace that has gone falls back', () => {
  assert.deepEqual(reconcileFilter(SPACES, NAMES, { space: 'Work', workspace: 'deleted' }), {
    space: 'Work',
    workspace: 'all',
  });
});

await check('a workspace that has moved out of the filtered space falls back', () => {
  // Both halves name something real, and together they match nothing — the empty
  // list with two chips pressed and no explanation.
  assert.deepEqual(reconcileFilter(SPACES, NAMES, { space: 'Work', workspace: 'beta' }), {
    space: 'Work',
    workspace: 'all',
  });
});

await check('the synthetic "Other" group is a space you can stay filtered to', () => {
  // It is not in the config, so validating against `cfg.spaces` would drop it on
  // every reload — which is why this reconciles against `summarise()`'s output.
  assert.ok(
    SPACES.some((s) => s.name === 'Other'),
    'the fixture should produce an Other group'
  );
  assert.deepEqual(reconcileFilter(SPACES, NAMES, { space: 'Other', workspace: 'gamma' }), {
    space: 'Other',
    workspace: 'gamma',
  });
});

/* ------------------------------------------------------------------ over the wire */

fs.rmSync(STATE_PATH, { force: true });
const servers = listen(cfg, createApp(cfg).handler);
try {
  await check('the list arrives already carrying the chips it should be wearing', async () => {
    const data = await get();
    // On the same response as the rows on purpose: fetched separately it would land
    // after the first paint, and a flash of the unfiltered list is the complaint.
    assert.deepEqual(data.filter, { space: 'all', workspace: 'all' }, 'nothing picked yet is All / All');
  });

  await check('a picked filter comes back on the next fetch', async () => {
    const wrote = await put({ space: 'Work', workspace: 'alpha' });
    assert.deepEqual(wrote.filter, { space: 'Work', workspace: 'alpha' });
    const data = await get();
    assert.deepEqual(data.filter, { space: 'Work', workspace: 'alpha' }, 'a second device sees it on its next poll');
    assert.deepEqual(onDisk().filter, { space: 'Work', workspace: 'alpha' }, 'and it survives a restart');
  });

  await check('the write leaves the poller’s keys alone', async () => {
    saveState({ notified: ['alpha/a-1'], commentCounts: { 'alpha/a-1': 2 } });
    await put({ space: 'Personal', workspace: 'beta' });
    const state = onDisk();
    assert.deepEqual(state.notified, ['alpha/a-1'], 'a filter tap must not re-push every open question');
    assert.deepEqual(state.commentCounts, { 'alpha/a-1': 2 });
    assert.deepEqual(state.filter, { space: 'Personal', workspace: 'beta' });
  });

  await check('a filter naming a space that has since gone comes back as All', async () => {
    saveState({ filter: { space: 'Retired', workspace: 'nowhere' } });
    const data = await get();
    assert.deepEqual(data.filter, { space: 'all', workspace: 'all' }, 'stale must not read as "show nothing"');
  });

  await check('a junk body is coerced rather than stored or refused', async () => {
    const wrote = await put({ space: { nope: true }, workspace: 'x'.repeat(500) });
    assert.deepEqual(wrote.filter, { space: 'all', workspace: 'all' });
    assert.deepEqual(onDisk().filter, { space: 'all', workspace: 'all' });
  });

  await check('an older client sees exactly what it always did', async () => {
    const data = await get();
    for (const field of ['questions', 'requests', 'workspaces', 'spaces', 'summary', 'scope']) {
      assert.ok(field in data, `${field} must still be served`);
    }
    assert.deepEqual(data.workspaces, ['alpha', 'beta', 'gamma']);
    assert.equal(data.questions.length, 3, 'the filter is a client-side view — the server still sends every row');
    assert.equal(data.scope, 'human');
  });
} finally {
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
