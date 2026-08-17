#!/usr/bin/env node
/**
 * The kept-answer mark, on the two screens that used to throw it away.
 *
 *     npm test
 *     node test/keptmark.mjs
 *
 * bc-1kwl.3 put /api/prs and /api/unendorsed on lib/cache.js, and both have sent
 * `x-beadcause-kept: fresh|stale; age=<seconds>[; refreshing]` on every response since —
 * the convention bc-1kwl.2.3 decided and /api/history's own client reads (see
 * test/history.mjs). public/prs.js and public/endorse.js did not read it at all, so the
 * header was sent and thrown away.
 *
 * It matters most on the board: that sweep is `gh` per repo, ~74 seconds against a
 * 25-second cache window, so the *ordinary* state of an open /prs tab is now "you are
 * looking at a board that is a minute old and a fresh one is on its way" — only true if
 * the page says so, which is bc-1kwl.8's whole ask.
 *
 * Both run the real client file in a vm, the way test/history.mjs and test/deploystart.mjs
 * do — a reimplementation of `parseKept` as a test double could not fail while the phone
 * shipped something else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = (name) => path.join(ROOT, 'public', name);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
}

console.log('\nthe kept-answer mark, off the wire\n');

/** One turn of the macrotask queue drains every microtask behind it. */
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** A DOM node minimal enough for both pages: `innerHTML` is read back as a string,
 *  which is what every check below asserts against. */
function mkNode() {
  const el = {
    innerHTML: '',
    hidden: false,
    scrollTop: 0,
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null,
  };
  return el;
}

/* ==================================================================== 1. /prs board */

console.log('the PR board');

/**
 * The real public/prs.js (and its prcard.js dependency) in a vm, against a scripted
 * `fetch`. `respond` answers `/api/prs`; `/api/deploys` is always an empty journal,
 * because the deploy strip is not this suite's subject. No stream.js is loaded, so
 * `follow()` no-ops (it guards on `window.beadcause?.stream`) and nothing parks on
 * `/api/poll` — the same trick test/deploystart.mjs uses for its non-stream case.
 */
function board({ respond }) {
  const nodes = { prs: mkNode(), pulse: mkNode(), observing: mkNode(), refresh: mkNode() };
  const fetchStub = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/prs')) {
      const body = await respond();
      const headers = { get: (name) => (String(name).toLowerCase() === 'x-beadcause-kept' ? body.kept ?? null : null) };
      if (body.status) return { ok: false, status: body.status, headers, json: async () => ({}) };
      return { ok: true, status: 200, headers, json: async () => body };
    }
    if (u.startsWith('/api/deploys')) return { ok: true, status: 200, json: async () => ({ deploys: [], deployable: [] }) };
    throw new Error(`unscripted fetch: ${u}`);
  };
  const window = { beadcause: {} };
  const ctx = vm.createContext({
    window,
    document: { getElementById: (id) => nodes[id] || null, addEventListener() {}, hidden: false },
    localStorage: { getItem: () => 'test-token', setItem() {} },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    AbortController,
    fetch: fetchStub,
    CSS: { escape: (s) => s },
    JSON,
    console,
  });
  vm.runInContext(read('public/prcard.js'), ctx, { filename: 'prcard.js' });
  vm.runInContext(read('public/prs.js'), ctx, { filename: 'prs.js' });
  return {
    out: nodes.prs,
    /** The ⟳ button's own click handler — what a second, failing request looks like. */
    refresh: () => nodes.refresh.listeners.click?.(),
  };
}

/* A repo with nothing open or recently merged — the `rest` branch in `boardHtml`, and
   the ordinary shape of most repos on most boards. What is under test is the paragraph
   above it, not the cards. */
const oneQuietRepo = { key: 'beadcause', workspace: 'beadcause', repo: 'beadcause', prs: [], error: null };

await check('a fresh board says nothing about its age', async () => {
  const b = board({ respond: async () => ({ repos: [oneQuietRepo], observing: false, kept: 'fresh; age=2' }) });
  await settle();
  assert.ok(!/board-quiet">Showing the board as of/.test(b.out.innerHTML), `drew a mark over a fresh answer: ${b.out.innerHTML}`);
});

await check('a stale, refreshing board says how old it is and that a fresh one is coming', async () => {
  const b = board({ respond: async () => ({ repos: [oneQuietRepo], observing: false, kept: 'stale; age=41; refreshing' }) });
  await settle();
  assert.match(b.out.innerHTML, /Showing the board as of 41s ago, refreshing\./, `the daemon's own words did not land on screen: ${b.out.innerHTML}`);
  // Quiet, not a warning: `.board-foot.bad` is the tone the connectivity failure below
  // uses, and this is not that failure.
  assert.ok(!/board-foot bad board-quiet">Showing the board as of 41s/.test(b.out.innerHTML), 'the kept mark borrowed the failure tone');
});

await check('a stale board that is not refreshing just says the age', async () => {
  const b = board({ respond: async () => ({ repos: [oneQuietRepo], observing: false, kept: 'stale; age=5' }) });
  await settle();
  assert.match(b.out.innerHTML, /Showing the board as of 5s ago\./, b.out.innerHTML);
  assert.ok(!b.out.innerHTML.includes('refreshing'), 'said "refreshing" when the header did not claim one');
});

await check('an older daemon that sends no header at all is drawn as unknown, not as fresh', async () => {
  const b = board({ respond: async () => ({ repos: [oneQuietRepo], observing: false }) });
  await settle();
  assert.ok(!/Showing the board as of \d/.test(b.out.innerHTML), `a missing header was read as an age: ${b.out.innerHTML}`);
});

await check('a failed refetch keeps its own line, and the kept mark from before it stands down', async () => {
  let n = 0;
  const b = board({
    respond: async () => {
      n += 1;
      // First answer: a real, stale-and-refreshing board. Second: the daemon stops
      // answering — a live restart is exactly when this page tends to be open, and it
      // must not go on claiming the first answer's age once a request has failed.
      return n === 1
        ? { repos: [oneQuietRepo], observing: false, kept: 'stale; age=9; refreshing' }
        : { status: 503 };
    },
  });
  await settle();
  assert.match(b.out.innerHTML, /Showing the board as of 9s ago, refreshing\./, 'setup: the first, good answer did not draw its mark');
  b.refresh();
  await settle();
  assert.match(b.out.innerHTML, /the last refresh did not answer/, 'the failed refetch has no line of its own');
  assert.ok(!b.out.innerHTML.includes('9s ago, refreshing'), `the stale kept mark from before the failure is still on screen: ${b.out.innerHTML}`);
});

/* ==================================================================== 2. /endorse */

console.log('\nthe endorsement queue');

/**
 * The real public/endorse.js in a vm, against a scripted `/api/unendorsed`. No
 * stream.js, no warm.js — `followQueue()` and the warm reads both guard on
 * `window.beadcause?.…` and no-op, so nothing else is asked for.
 */
function queue({ respond }) {
  const nodes = { eq: mkNode(), pulse: mkNode(), 'eq-refresh': mkNode() };
  const fetchStub = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/unendorsed')) {
      const body = await respond();
      const headers = { get: (name) => (String(name).toLowerCase() === 'x-beadcause-kept' ? body.kept ?? null : null) };
      if (body.status) return { ok: false, status: body.status, headers, json: async () => ({}) };
      return { ok: true, status: 200, headers, json: async () => body };
    }
    throw new Error(`unscripted fetch: ${u}`);
  };
  const window = { beadcause: {}, location: { search: '', hash: '' } };
  const ctx = vm.createContext({
    window,
    document: { getElementById: (id) => nodes[id] || null },
    localStorage: { getItem: () => 'test-token', setItem() {} },
    location: { search: '', hash: '' },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    fetch: fetchStub,
    Set,
    JSON,
    console,
  });
  vm.runInContext(read('public/endorse.js'), ctx, { filename: 'endorse.js' });
  return { out: nodes.eq };
}

const oneBead = {
  key: 'beadcause/bc-9',
  workspace: 'beadcause',
  id: 'bc-9',
  title: 'A bead an agent found',
  type: 'task',
  priority: 2,
  status: 'open',
  createdAt: new Date().toISOString(),
  filed: true,
};

const dataOf = (kept) => ({
  beads: [oneBead],
  counts: { total: 1, shown: 1, byWorkspace: { beadcause: 1 } },
  errors: [],
  truncated: 0,
  at: new Date().toISOString(),
  kept,
});

await check('a fresh queue says nothing about its age', async () => {
  const q = queue({ respond: async () => dataOf('fresh; age=1') });
  await settle();
  assert.ok(!q.out.innerHTML.includes('hist-kept'), `drew a mark over a fresh answer: ${q.out.innerHTML}`);
});

await check('a stale, refreshing queue is marked on the count line, in the quiet style', async () => {
  const q = queue({ respond: async () => dataOf('stale; age=95; refreshing') });
  await settle();
  assert.match(q.out.innerHTML, /class="eq-count">1 bead waiting on you <span class="hist-kept">· as of 2m ago, refreshing<\/span><\/p>/, q.out.innerHTML);
});

await check('an older daemon with no header at all draws no mark', async () => {
  const q = queue({ respond: async () => dataOf(undefined) });
  await settle();
  assert.ok(!q.out.innerHTML.includes('hist-kept'), `a missing header was read as an age: ${q.out.innerHTML}`);
});

console.log(`\n${ran - failures}/${ran} ok\n`);
process.exit(failures ? 1 : 0);
