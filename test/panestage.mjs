#!/usr/bin/env node
/**
 * Every pane built at boot, staged — and one poll behind all of them.
 *
 *     npm test
 *     node test/panestage.mjs
 *
 * bc-khoe.30.4. public/panes.js made the app one document with a container per view and a
 * hash that says which is up; it builds nothing. public/panestage.js is what fills them,
 * and the whole of it is timing and arithmetic that no screenshot can show.
 *
 * Five things are worth a suite, and every one of them fails silently:
 *
 * 1. **The landed-on pane is built first, in the boot's own turn.** A home-screen shortcut
 *    to `/#history` must not spend its first frames building an inbox nobody asked for, and
 *    a plain `/` must be no slower than it was before any of this existed. Both are the same
 *    assertion from two hashes.
 *
 * 2. **The rest are built after the first paint, and before the first tap.** A pane built on
 *    the tap that shows it is the document load this epic removed, wearing a new mechanism.
 *
 * 3. **One pane's builder throwing is one pane.** The others are the rest of the app. And it
 *    is not retried on every subsequent show, or a broken pane becomes a broken app the
 *    third time you switch to it.
 *
 * 4. **The `want` is the union of the panes', and it is `presence` until something needs
 *    more.** `want=presence` is what makes a park free: without it the daemon sweeps `bd` to
 *    build an inbox the parked page throws away. Getting this wrong is invisible on the
 *    phone and shows up as the whole Mac being busier.
 *
 * 5. **One socket, whichever mount is holding it.** The standby exists because the inbox's
 *    own poll is off in every scope but `human`; it must stand down the instant an ordinary
 *    mount starts and come back when it ends, and it must refuse to start beside one.
 *
 * The real files run in a `node:vm` against a hand-made document, the way test/panes.mjs and
 * test/stream.mjs run theirs — a reimplementation of the staging here could pass while the
 * phone shipped something else. The wiring half is read as text, because a missing `<script>`
 * tag is markup and no unit test sees one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
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
    console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

/* ================================================================== a document */

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Just enough of an element for panes.js: attributes, children, `hidden`, `scrollTop`. */
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.scrollTop = 0;
  }
  get classList() {
    return { contains: (c) => String(this.className).split(/\s+/).includes(c) };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n);
  }
  walk() {
    return this.children.flatMap((c) => [c, ...c.walk()]);
  }
  matches(sel) {
    const attr = sel.match(/^\[([-\w]+)\]$/);
    if (attr) return this.attrs[attr[1]] != null;
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    return this.tag === sel;
  }
  querySelectorAll(sel) {
    return this.walk().filter((el) => el.matches(sel));
  }
}

function pane(id, { pending = null } = {}) {
  const el = new El('div');
  el.className = 'pane';
  el.setAttribute('data-pane', id);
  if (pending) el.setAttribute('data-pending', pending);
  return el;
}

/** Let every resolved promise and every zero-delay timer run. */
const settle = (n = 5) => new Promise((r) => setTimeout(r, n));

/**
 * The four real files in one room, with the document still parsing.
 *
 * `readyState: 'loading'` is the honest starting point and the whole reason this harness
 * can see the staging at all: it is what makes the stager wait for `DOMContentLoaded`, so
 * the test decides when every pane script has had its say — which is exactly what the
 * browser decides on the page, where the scripts are one block at the foot of the body.
 */
function boot({ hash = '', panes = ['epics', 'history', 'advocates'] } = {}) {
  /*
    Where a builder's throw ends up. The file rethrows it out of a timer so it reaches the
    window handler in public/report.js — which is the whole point, a pane that silently did
    not build being a blank screen with no account of why — and this is that handler: an
    uncaught throw here would take the suite down instead of being the thing under test.
  */
  const thrown = [];
  const body = new El('body');
  body.append(...panes.map((p) => (typeof p === 'string' ? pane(p) : p)));

  const location = { pathname: '/', search: '', hash };
  const winListeners = new Map();
  const docListeners = new Map();
  const frames = [];
  const asked = [];
  /** Requests in flight, so a test says when the daemon answers — and so an abort lands. */
  const parked = [];
  /** What the files complained about. Collected rather than printed: a contained failure
   *  is the thing under test, and a suite that shouts one is a suite nobody reads. */
  const complaints = [];

  const ctx = {
    location,
    history: { replaceState() {} },
    document: {
      body,
      readyState: 'loading',
      hidden: false,
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push(fn);
      },
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    // Held rather than run, so the test says when the first paint happened.
    requestAnimationFrame: (fn) => frames.push(fn),
    setTimeout: (fn, ms) =>
      setTimeout(() => {
        try {
          fn();
        } catch (err) {
          thrown.push(err);
        }
      }, ms),
    clearTimeout,
    AbortController,
    URLSearchParams,
    Promise,
    JSON,
    Number,
    Boolean,
    String,
    Object,
    Array,
    Set,
    Map,
    Math,
    Error,
    console: { ...console, error: (...a) => complaints.push(a.map(String).join(' ')) },
    localStorage: { getItem: () => 'tok' },
    // Parks until `deliver`, which is what a real long poll does — and honours the abort,
    // which is half of what is under test here: a standby that is stood down has to let
    // go of the socket rather than wait its park out.
    fetch(url, opts = {}) {
      asked.push(url);
      return new Promise((resolve, reject) => {
        const entry = { resolve };
        parked.push(entry);
        opts.signal?.addEventListener?.('abort', () => {
          // Out of the list as well as rejected — `inflight()` is how this suite counts
          // sockets, and a request the client let go of is not one.
          const at = parked.indexOf(entry);
          if (at !== -1) parked.splice(at, 1);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['hashroute.js', 'stream.js', 'panes.js', 'panestage.js']) {
    vm.runInContext(read(`public/${f}`), ctx, { filename: f });
  }

  return {
    ctx,
    asked,
    thrown,
    complaints,
    stage: () => ctx.window.beadcause.stage,
    panes: () => ctx.window.beadcause.panes,
    stream: () => ctx.window.beadcause.stream,
    /** Every pane script has loaded — what the browser says by firing DOMContentLoaded. */
    parsed() {
      ctx.document.readyState = 'interactive';
      for (const fn of docListeners.get('DOMContentLoaded') || []) fn();
    },
    /** The first paint happened. */
    paint() {
      const queued = frames.splice(0);
      for (const fn of queued) fn();
    },
    /** How many requests are in flight right now. One park per page, or the file failed. */
    inflight: () => parked.length,
    /** The daemon answering the oldest request in flight. */
    deliver(payload) {
      parked.shift()?.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    },
    /** The back button, or a deep link arriving. */
    navigate(next) {
      location.hash = next;
      for (const fn of winListeners.get('hashchange') || []) fn();
    },
  };
}

/**
 * A view's own poll — the inbox's, in the app: parks, and lets go when it is aborted.
 *
 * Honouring the abort is not decoration. A stop that leaves the loop parked leaves
 * `following` true forever, and the arbitration this suite is about hangs off exactly that
 * flag going false.
 */
const viewApi = (asked = []) => (url, opts = {}) =>
  new Promise((_, reject) => {
    asked.push(url);
    opts.signal?.addEventListener?.('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    );
  });

/** A spec that records when it was built and what it was woken with. */
function recorder(log, id, extra = {}) {
  return {
    build: () => log.push(id),
    ...extra,
  };
}

/* ============================================================== the staged boot */

console.log('\nthe staged boot');

await check('the landed-on pane is built in the boot’s own turn, and nothing else is', async () => {
  const b = boot({ hash: '#history' });
  const log = [];
  for (const id of ['epics', 'history', 'advocates']) b.stage().register(id, recorder(log, id));
  b.parsed();
  assert.deepEqual(log, ['history'], 'the boot built something other than the view it landed on');
});

await check('a bare / lands on Home, which is what every notification link is', async () => {
  const b = boot({ hash: '' });
  const log = [];
  for (const id of ['epics', 'history']) b.stage().register(id, recorder(log, id));
  b.parsed();
  assert.deepEqual(log, ['epics']);
});

await check('a card hash is Home too — the deep link opens a bead, not a view', async () => {
  const b = boot({ hash: '#beadcause%2Fbc-khoe.30.4' });
  const log = [];
  for (const id of ['epics', 'history']) b.stage().register(id, recorder(log, id));
  b.parsed();
  assert.deepEqual(log, ['epics']);
});

await check('the rest are built after the first paint, and not before it', async () => {
  const b = boot({ hash: '#history' });
  const log = [];
  for (const id of ['epics', 'history', 'advocates']) b.stage().register(id, recorder(log, id));
  b.parsed();
  await settle();
  assert.deepEqual(log, ['history'], 'a pane was built before the frame it was deferred to');
  b.paint();
  await settle();
  assert.deepEqual(log.slice(0).sort(), ['advocates', 'epics', 'history']);
  assert.equal(log[0], 'history', 'the landed-on pane stopped being first');
});

await check('a pane registered after the boot builds at once rather than never', async () => {
  const b = boot({ hash: '' });
  const log = [];
  b.stage().register('epics', recorder(log, 'epics'));
  b.parsed();
  b.paint();
  await settle();
  b.stage().register('history', recorder(log, 'history'));
  assert.deepEqual(log, ['epics', 'history']);
});

await check('a tap that beats the staged pass builds the pane it showed', async () => {
  const b = boot({ hash: '' });
  const log = [];
  for (const id of ['epics', 'history']) b.stage().register(id, recorder(log, id));
  b.parsed();
  // The frame is still out; the thumb is not.
  b.navigate('#history');
  assert.deepEqual(log, ['epics', 'history'], 'the shown pane was left empty');
  b.paint();
  await settle();
  assert.deepEqual(log, ['epics', 'history'], 'the staged pass built it a second time');
});

await check('a builder that throws takes its own pane down and nothing else', async () => {
  const b = boot({ hash: '' });
  const log = [];
  b.stage().register('epics', {
    build() {
      log.push('epics');
      throw new Error('boom');
    },
  });
  b.stage().register('history', recorder(log, 'history'));
  b.parsed();
  b.paint();
  await settle();
  assert.deepEqual(log, ['epics', 'history'], 'a throw stopped the staged pass');
  assert.deepEqual(
    b.thrown.map((e) => e.message),
    ['boom'],
    'the failure was swallowed rather than left for public/report.js to file'
  );
  assert.deepEqual([...b.stage().built()], ['history'], 'a pane that threw is counted as built');
  b.navigate('#history');
  b.navigate('');
  assert.deepEqual(log, ['epics', 'history'], 'the broken builder was run again on a show');
});

await check('a view with no pane is refused, so its script builds itself', async () => {
  const b = boot({ hash: '', panes: ['epics', pane('history', { pending: 'bc-khoe.30.5' })] });
  assert.equal(b.stage().register('history', { build() {} }), false, 'a pending container was taken');
  assert.equal(b.stage().register('nosuch', { build() {} }), false);
  assert.equal(b.stage().register('epics', { build() {} }), true);
  assert.equal(b.stage().register('epics', {}), false, 'a spec with no builder was taken');
});

/* ================================================================== the one poll */

console.log('\none poll behind all of them');

await check('no pane wants a wake, so nothing is mounted at all', async () => {
  const b = boot({ hash: '' });
  const log = [];
  for (const id of ['epics', 'history']) b.stage().register(id, recorder(log, id));
  b.parsed();
  b.paint();
  await settle();
  assert.deepEqual(b.asked, [], 'a poll went up for panes that never asked to be told');
  assert.equal(b.stage().standing(), false);
});

await check('a pane with a wake puts one presence poll up, and only one', async () => {
  const b = boot({ hash: '' });
  const log = [];
  b.stage().register('epics', recorder(log, 'epics'));
  b.stage().register('history', recorder(log, 'history', { wake: () => {} }));
  b.stage().register('advocates', recorder(log, 'advocates', { wake: () => {} }));
  b.parsed();
  b.paint();
  await settle();
  assert.equal(b.asked.length, 1, `${b.asked.length} requests for one page`);
  assert.match(b.asked[0], /want=presence/, 'the free park was not asked for');
  assert.equal(b.stage().want(), 'presence');
});

await check('one pane wanting the questions widens the one request for all of them', async () => {
  const b = boot({ hash: '' });
  b.stage().register('epics', { build() {}, wake: () => {}, want: 'questions' });
  b.stage().register('history', { build() {}, wake: () => {} });
  b.parsed();
  b.paint();
  await settle();
  assert.equal(b.stage().want(), null, 'the union stayed narrow with a pane asking for more');
  assert.equal(b.asked.length, 1, 'the widening opened a second socket instead of moving the one');
  assert.ok(!/want=/.test(b.asked[0]), 'a full want must send no want parameter at all');
});

await check('an answered poll reaches every built pane, and a thrower does not stop the next', async () => {
  const woke = [];
  const b = boot({ hash: '' });
  b.stage().register('epics', { build() {} });
  b.stage().register('history', {
    build() {},
    wake() {
      woke.push('history');
      throw new Error('boom');
    },
  });
  b.stage().register('advocates', { build() {}, wake: (w) => woke.push(w) });
  b.parsed();
  b.paint();
  await settle();
  b.deliver({ seq: 4, events: [{ type: 'merged' }], questions: [] });
  await settle();
  assert.deepEqual(woke[0], 'history');
  assert.equal(woke.length, 2, 'a throwing pane swallowed the fan-out');
  assert.equal(b.complaints.length, 1, 'the pane that threw on a wake was not reported');
  assert.match(b.complaints[0], /\[stage\] history/);
  assert.deepEqual([...woke[1].events], [{ type: 'merged' }]);
  assert.equal(woke[1].data.seq, 4, 'the payload did not ride the wake');
  assert.equal(woke[1].resync, false);
});

await check('a union that widens after the mount re-parks the one poll rather than adding a second', async () => {
  const b = boot({ hash: '#history' });
  b.stage().register('epics', { build() {}, wake: () => {}, want: 'questions' });
  b.stage().register('history', { build() {}, wake: () => {} });
  b.parsed();
  await settle();
  assert.equal(b.stage().want(), 'presence', 'the pane that landed asked for more than it needs');
  assert.match(b.asked[0], /want=presence/);
  b.paint();
  await settle();
  assert.equal(b.stage().want(), null);
  assert.equal(b.asked.length, 2, 'the widening did not re-park');
  assert.ok(!/want=/.test(b.asked[1]), 'the re-park did not carry the wider want');
  assert.equal(b.inflight(), 1, 'the widening left the narrower request parked beside the new one');
});

/* =============================================================== one socket only */

console.log('\none socket, whichever mount holds it');

await check('an ordinary mount starting stands the standby down', async () => {
  const b = boot({ hash: '' });
  b.stage().register('epics', { build() {} });
  b.stage().register('history', { build() {}, wake: () => {} });
  b.parsed();
  b.paint();
  await settle();
  assert.equal(b.stage().standing(), true, 'the standby never went up');

  const asked = [];
  const view = b.stream().follow({ api: viewApi(asked), cold: true });
  view.start();
  await settle();
  assert.equal(asked.length, 1, 'the view’s own poll did not go out');
  assert.equal(b.stage().standing(), false, 'two parked sockets behind one page');
});

await check('a standby refuses to start beside an ordinary mount', async () => {
  const b = boot({ hash: '' });
  b.stage().register('history', { build() {}, wake: () => {} });
  b.parsed();
  b.paint();
  await settle();
  const view = b.stream().follow({ api: viewApi(), cold: true });
  view.start();
  await settle();
  // Whatever asks — a visibility handler, the freshness banner's Retry now.
  b.stream().wake();
  await settle();
  assert.equal(b.stage().standing(), false, 'a start from elsewhere put a second socket up');
});

await check('the standby comes back when the view’s poll ends', async () => {
  const b = boot({ hash: '' });
  b.stage().register('history', { build() {}, wake: () => {} });
  b.parsed();
  b.paint();
  await settle();
  const view = b.stream().follow({ api: viewApi(), cold: true, retryMs: 0 });
  view.start();
  await settle();
  assert.equal(b.stage().standing(), false);
  // The inbox leaving `human` scope is exactly this: the loop ends and nothing replaces it.
  view.stop();
  await settle();
  assert.equal(b.stage().standing(), true, 'the panes were left with no poll at all');
});

/* ===================================================================== the wiring */

console.log('\nthe wiring, as written');

const HTML = read('public/index.html');
const SW = read('public/sw.js');
const APP = read('public/app.js');

await check('index.html loads it after the panes and before every pane’s own script', async () => {
  const at = (f) => HTML.indexOf(`src="/${f}"`);
  assert.notEqual(at('panestage.js'), -1, 'index.html does not load panestage.js at all');
  assert.ok(at('panes.js') < at('panestage.js'), 'the stager runs before the panes it builds into');
  assert.ok(at('stream.js') < at('panestage.js'), 'the stager runs before the stream it listens on');
  assert.ok(at('panestage.js') < at('app.js'), 'Home’s script registers with a stager that is not there yet');
});

await check('it is the shell’s file and no other page loads it', async () => {
  const loaders = fs
    .readdirSync(path.join(ROOT, 'public'))
    .filter((f) => f.endsWith('.html'))
    .filter((f) => read(`public/${f}`).includes('src="/panestage.js"'));
  assert.deepEqual(loaders, ['index.html'], `${loaders.join(', ')} load panestage.js`);
});

await check('a boot-time file of the shell is precached rather than left to the network', async () => {
  assert.ok(SW.includes("'/panestage.js',"), 'panestage.js is not in SHELL');
  const cache = Number(/const CACHE = 'beadcause-v(\d+)'/.exec(SW)[1]);
  const notes = fs
    .readdirSync(path.join(ROOT, 'docs/sw-cache'))
    .map((f) => Number(/^v(\d+)\.md$/.exec(f)?.[1]))
    .filter(Number.isFinite);
  assert.equal(cache, Math.max(...notes), 'const CACHE and docs/sw-cache/ disagree — the silent merge');
});

await check('Home offers itself to the stager and builds itself when there is none', async () => {
  assert.match(
    APP,
    /if \(!window\.beadcause\?\.stage\?\.register\?\.\('epics', \{ build: buildHome \}\)\) buildHome\(\);/,
    'app.js no longer falls back to building itself — a v83 cache would boot to a blank Home'
  );
  assert.ok(!/wake:/.test(APP.slice(APP.indexOf('function buildHome'))), 'Home took a wake as well as its own poll');
});

console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
