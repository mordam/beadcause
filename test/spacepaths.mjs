#!/usr/bin/env node
/**
 * A scope in the address — `/bdcoz/<space>/<workspace>` (bc-xnj67).
 *
 *     npm test
 *     node test/spacepaths.mjs
 *
 * The space you are in used to be one value on the server, shared by every device, and
 * nothing about the URL said which it was. Now the path can say it:
 *
 *     /bdcoz/personal/deluvia#deluvia.briefs?b=README
 *     \____ path: the scope ____/\____ hash: the view ____/
 *
 * Four things are worth a suite here, and the first two are the ones that bite silently.
 *
 * 1. **Two files define the same word, twice each.** `SCOPE_ROOT` is in lib/spaces.js and
 *    again in public/hashroute.js; the space-name slug is `spaceSlug` in lib/spaces.js and
 *    `slugOf` in public/spacebar.js. Neither pair can be a shared module — one side runs
 *    in the daemon off an import and the other in a browser off `window` — so this suite
 *    is what stops them drifting, the way test/pagealias.mjs holds `VIEW_HOPS` against
 *    `serveStatic`. A drift here does not throw: it makes `/bdcoz/personal/...` resolve on
 *    one side and not the other, which reads as "the link does not work sometimes".
 *
 * 2. **A scoped page must not write the stored filter.** The `{space, workspace}`
 *    selection is what `quietReasonFor` reads to decide whether the phone rings, so a path
 *    that wrote it would be a link that silences repos on every device its owner has. The
 *    picker on a scoped page moves the *address* instead. That is a claim about a `fetch`
 *    that must not happen, which no amount of reading proves — so spacebar.js is driven
 *    here with a fetch that fails the test if it is called.
 *
 * 3. **The address wins over every payload, not just the first.** The stored filter moving
 *    on another device sends a new one down the poll each time, and adopting it is exactly
 *    the cross-device argument a scoped page opts out of.
 *
 * 4. **An unscoped page is untouched.** `/` behaves precisely as it did, including
 *    adopting and posting, or this change has cost more than it bought.
 *
 * Run in a `node:vm` with a hand-made document, the way test/panes.mjs runs its files.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { SCOPE_ROOT, spaceSlug, spaceBySlug } from '../lib/spaces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
};

/** public/hashroute.js in a room of its own. It touches nothing at load. */
const loadRoute = () => {
  const window = {};
  const ctx = vm.createContext({ window, decodeURIComponent, encodeURIComponent });
  vm.runInContext(read('public/hashroute.js'), ctx, { filename: 'hashroute.js' });
  return ctx.window.beadcause.route;
};
const route = loadRoute();

/* ============================================ 1. the definitions said twice */

console.log('\nthe words that are defined in two files');

check('SCOPE_ROOT is the same word in the daemon and in the browser', () => {
  assert.equal(SCOPE_ROOT, 'bdcoz');
  assert.equal(route.SCOPE_ROOT, SCOPE_ROOT, 'lib/spaces.js and public/hashroute.js disagree about the first segment');
});

check('and the daemon builds the address the browser parses', () => {
  // The two ends of one round trip: lib/server.js writes this shape into the `/v/…` hop,
  // public/hashroute.js is what reads it back off the address bar.
  assert.deepEqual({ ...route.scopeOfPath(`/${SCOPE_ROOT}/personal/deluvia`) }, { space: 'personal', workspace: 'deluvia' });
  assert.equal(route.pathForScope('personal', 'deluvia'), `/${SCOPE_ROOT}/personal/deluvia`);
});

check('the space slug is the same function in lib/spaces.js and public/spacebar.js', () => {
  // Lifted out of the file rather than imported, because spacebar.js is an IIFE that
  // needs a document. The point is that the *definition* matches; a copy that has been
  // edited on one side is what this catches.
  const src = read('public/spacebar.js');
  const at = src.indexOf('const slugOf = (name) =>');
  assert.ok(at !== -1, 'public/spacebar.js no longer defines slugOf — has it moved?');
  const body = src.slice(at, src.indexOf(';', src.indexOf(".replace(/^-+|-+$/g, '')", at)));
  const slugOf = vm.runInNewContext(`(${body.replace('const slugOf = ', '')})`);
  for (const name of ['Personal', 'Climative', ' Odd  Name ', 'Ab-C', '', null, 'Ünïcode', '2026 Q3']) {
    assert.equal(slugOf(name), spaceSlug(name), `the two slug functions disagree about ${JSON.stringify(name)}`);
  }
});

/* ==================================================== 2. what an address means */

console.log('\nwhat a scoped address means');

check('a space, a space and a workspace, or nothing at all', () => {
  assert.deepEqual({ ...route.scopeOfPath('/bdcoz/personal/deluvia') }, { space: 'personal', workspace: 'deluvia' });
  assert.deepEqual({ ...route.scopeOfPath('/bdcoz/personal') }, { space: 'personal', workspace: '' });
  assert.deepEqual({ ...route.scopeOfPath('/bdcoz/personal/') }, { space: 'personal', workspace: '' });
});

check('an unscoped address says nothing rather than saying "everything"', () => {
  // `null` and `{space:'', workspace:''}` are different instructions — "leave the stored
  // filter alone" and "show the whole space" — and both would arrive as the latter if this
  // answered an empty scope.
  for (const p of ['/', '/index.html', '/history', '/monitor', '/bdcoz', '/bdcozzy/x', '', null, undefined]) {
    assert.equal(route.scopeOfPath(p), null, `${JSON.stringify(p)} was read as a scope`);
  }
});

check('a third segment is refused, not truncated', () => {
  // `/bdcoz/personal/deluvia/briefs` is somebody carrying the view in the path — the shape
  // this deliberately did not take. Answering with the scope alone would silently drop the
  // half they meant most.
  assert.equal(route.scopeOfPath('/bdcoz/personal/deluvia/briefs'), null);
  assert.equal(route.scopeOfPath('/bdcoz/a/b/c/d'), null);
});

check('a hand-edited address does not throw out of boot', () => {
  // `decodeURIComponent('%')` throws, and this runs on load in every page that has chrome.
  assert.doesNotThrow(() => route.scopeOfPath('/bdcoz/%/deluvia'));
  assert.deepEqual({ ...route.scopeOfPath('/bdcoz/%') }, { space: '%', workspace: '' });
  assert.deepEqual({ ...route.scopeOfPath('/bdcoz/Personal/Deluvia') }, { space: 'personal', workspace: 'deluvia' });
});

check('pathForScope refuses a workspace with no space', () => {
  assert.equal(route.pathForScope('', 'deluvia'), '/', 'a three-segment form with an empty middle is not an address');
  assert.equal(route.pathForScope('personal', ''), '/bdcoz/personal');
  assert.equal(route.pathForScope('', ''), '/');
});

check('the hash grammar is untouched by any of this', () => {
  // The whole argument for this shape: the view stays in the hash, so nothing about
  // bc-khoe.30.2 or bc-k7lrc moves. A card is still a card and a view still carries its
  // own query.
  assert.equal(route.parse('#history?status=closed').view, 'history');
  assert.equal(route.parse('#history?status=closed').query, 'status=closed');
  assert.equal(route.parse(route.hashForCard('beadcause/bc-x')).kind, 'card');
  assert.equal(route.queryFor('history', '#history?status=closed'), 'status=closed');
});

/* ============================================== the config half of the lookup */

console.log('\nresolving a slug against the configured spaces');

const CFG = {
  spaces: [
    { name: 'Personal', workspaces: ['beadcause', 'deluvia', 'sophab'] },
    { name: 'Climative', workspaces: ['architecture'] },
  ],
};

check('a slug finds its space, whatever case the name is written in', () => {
  assert.equal(spaceBySlug(CFG, 'personal')?.name, 'Personal');
  assert.equal(spaceBySlug(CFG, 'Personal')?.name, 'Personal');
  assert.equal(spaceBySlug(CFG, 'climative')?.name, 'Climative');
});

check('and a slug naming nothing is null rather than a filter nothing satisfies', () => {
  assert.equal(spaceBySlug(CFG, 'nope'), null);
  assert.equal(spaceBySlug(CFG, ''), null);
  assert.equal(spaceBySlug({}, 'personal'), null);
});

/* ===================================================== 3+4. spacebar, running */

console.log('\nthe bar, over a scoped page and an unscoped one');

/** Just enough of an element for spacebar.js, which builds its row with innerHTML. */
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.innerHTML = '';
    this.value = '';
    this.listeners = new Map();
  }
  get classList() {
    return { contains: (c) => this.className.split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  append(...n) {
    for (const x of n) {
      x.parent = this;
      this.children.push(x);
    }
  }
  appendChild(n) {
    this.append(n);
    return n;
  }
  insertBefore(n) {
    this.append(n);
    return n;
  }
  remove() {}
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t).push(fn);
  }
  fire(t, ev) {
    for (const fn of this.listeners.get(t) || []) fn(ev);
  }
  walk() {
    return this.children.flatMap((c) => [c, ...c.walk()]);
  }
  matches(sel) {
    if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
    return this.tag === sel;
  }
  querySelectorAll(sel) {
    return this.walk().filter((el) => el.matches(sel));
  }
  /**
   * By class or tag, off the real children — and by **id**, off a stub.
   *
   * The bar builds its control by assigning a template string to `innerHTML` and then
   * reaching back into it for `#space-pick` and `#space-shown`. This element stores
   * `innerHTML` as a string rather than parsing it (the same shape test/panes.mjs uses,
   * and for the same reason: parsing it back would add a parser to disagree with the
   * browser), so those two are handed a stub that remembers what was done to it. Which is
   * all these checks need — what is under test is the selection, not the markup.
   */
  querySelector(sel) {
    if (sel.startsWith('#')) {
      this.stubs = this.stubs || new Map();
      if (!this.stubs.has(sel)) this.stubs.set(sel, new El('stub'));
      return this.stubs.get(sel);
    }
    return this.querySelectorAll(sel)[0] || null;
  }
  closest() {
    return null;
  }
}

/**
 * spacebar.js over one page, with the grammar under it and a fetch that records.
 *
 * `fetch` is the assertion in disguise: on a scoped page nothing may reach `/api/filter`,
 * so every call is recorded and the checks read the list. `/api/spaces` is answered,
 * because the bar asks for it from the top of the file.
 */
function bar({ pathname = '/', hash = '', search = '' } = {}) {
  const body = new El('body');
  const topbar = new El('header');
  topbar.className = 'topbar';
  body.append(topbar);
  const location = { pathname, hash, search };
  const posts = [];
  const replaced = [];
  const ctx = {
    location,
    history: {
      replaceState: (_s, _t, url) => {
        replaced.push(String(url));
        const u = String(url);
        location.pathname = u.split(/[?#]/)[0];
      },
      pushState: (_s, _t, url) => replaced.push(`push:${url}`),
    },
    document: {
      body,
      head: new El('head'),
      readyState: 'complete',
      createElement: (tag) => new El(tag),
      getElementById: () => null,
      querySelector: (sel) => (body.matches(sel) ? body : body.querySelector(sel)),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      addEventListener() {},
    },
    console,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
    addEventListener() {},
    fetch: async (url, opts) => {
      posts.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/hashroute.js'), ctx, { filename: 'hashroute.js' });
  vm.runInContext(read('public/spacebar.js'), ctx, { filename: 'spacebar.js' });
  return { ctx, posts, replaced, location, space: () => ctx.window.beadcause.space };
}

/** The payload the bar adopts — the spaces, the workspaces and the stored selection. */
const payload = (filter) => ({
  spaces: CFG.spaces.map((s) => ({ ...s })),
  workspaces: ['beadcause', 'deluvia', 'sophab', 'architecture'],
  filter,
});

check('an unscoped page adopts the stored filter, exactly as before', () => {
  const b = bar();
  b.space().adopt(payload({ space: 'Personal', workspace: 'deluvia' }));
  assert.deepEqual({ ...b.space().filter }, { space: 'Personal', workspace: 'deluvia' });
  assert.equal(b.space().matches('deluvia'), true);
  assert.equal(b.space().matches('sophab'), false);
  assert.deepEqual(b.replaced, [], 'an unscoped page rewrote its own address');
});

check('a scoped page answers to its address instead', () => {
  const b = bar({ pathname: '/bdcoz/climative/architecture' });
  b.space().adopt(payload({ space: 'Personal', workspace: 'deluvia' }));
  assert.deepEqual({ ...b.space().filter }, { space: 'Climative', workspace: 'architecture' });
  assert.equal(b.space().matches('architecture'), true);
  assert.equal(b.space().matches('deluvia'), false, 'the stored filter won over the address');
});

check('a space with no workspace scopes to the whole space', () => {
  const b = bar({ pathname: '/bdcoz/personal' });
  b.space().adopt(payload({ space: 'Climative', workspace: 'architecture' }));
  assert.deepEqual({ ...b.space().filter }, { space: 'Personal', workspace: 'all' });
  assert.equal(b.space().matches('deluvia'), true);
  assert.equal(b.space().matches('sophab'), true);
  assert.equal(b.space().matches('architecture'), false);
});

check('the address keeps winning, payload after payload', () => {
  // Not a boot-time seed. The stored filter moving on another device sends a new one down
  // the poll every time, and adopting it is the cross-device argument a scoped page exists
  // to opt out of.
  const b = bar({ pathname: '/bdcoz/climative/architecture' });
  b.space().adopt(payload({ space: 'Personal', workspace: 'deluvia' }));
  b.space().adopt(payload({ space: 'Personal', workspace: 'sophab' }));
  b.space().adopt(payload({ space: 'all', workspace: 'all' }));
  assert.deepEqual({ ...b.space().filter }, { space: 'Climative', workspace: 'architecture' });
});

check('a scope naming nothing falls back to the stored filter', () => {
  // A typo, or a space renamed since somebody saved the link. It should show you the app
  // you already had, not a filter nothing can satisfy.
  const b = bar({ pathname: '/bdcoz/nosuchspace/deluvia' });
  b.space().adopt(payload({ space: 'Personal', workspace: 'deluvia' }));
  assert.deepEqual({ ...b.space().filter }, { space: 'Personal', workspace: 'deluvia' });
});

check('a workspace outside its space drops to the space, which is the wider half', () => {
  const b = bar({ pathname: '/bdcoz/climative/deluvia' });
  b.space().adopt(payload({ space: 'all', workspace: 'all' }));
  assert.deepEqual({ ...b.space().filter }, { space: 'Climative', workspace: 'all' });
});

check('picking on a scoped page moves the address and posts NOTHING', () => {
  // The one that matters. `{space, workspace}` is what `quietReasonFor` reads to decide
  // whether the phone rings, so a link that wrote it would silence repos on every device.
  const b = bar({ pathname: '/bdcoz/personal/deluvia', hash: '#deluvia.briefs?b=README' });
  b.space().adopt(payload({ space: 'all', workspace: 'all' }));
  b.posts.length = 0;
  b.space().set({ space: 'Personal', workspace: 'sophab' });
  assert.deepEqual(
    b.posts.filter((p) => p.url.includes('/api/filter')),
    [],
    'a scoped page wrote the stored filter — this is the link that silences your phone'
  );
  assert.deepEqual(b.replaced, ['/bdcoz/personal/sophab#deluvia.briefs?b=README']);
  assert.deepEqual({ ...b.space().filter }, { space: 'Personal', workspace: 'sophab' });
});

check('and the view it is on rides across the move untouched', () => {
  const b = bar({ pathname: '/bdcoz/personal/deluvia', hash: '#history?status=closed', search: '?t=abc' });
  b.space().adopt(payload({ space: 'all', workspace: 'all' }));
  b.space().set({ space: 'Climative', workspace: 'architecture' });
  assert.deepEqual(b.replaced, ['/bdcoz/climative/architecture?t=abc#history?status=closed']);
});

check('picking on an unscoped page still posts, and moves no address', () => {
  const b = bar();
  b.space().adopt(payload({ space: 'all', workspace: 'all' }));
  b.posts.length = 0;
  b.space().set({ space: 'Personal', workspace: 'deluvia' });
  const wrote = b.posts.filter((p) => p.url.includes('/api/filter'));
  assert.equal(wrote.length, 1, 'the unscoped picker stopped writing the stored filter');
  assert.deepEqual(wrote[0].body, { space: 'Personal', workspace: 'deluvia' });
  assert.deepEqual(b.replaced, []);
});

/* ============================================================== the wiring */

console.log('\nthe wiring, as written');

check('the daemon serves the shell for a scoped address', () => {
  // A rewrite, where a view alias needs a 302: that one has to put a *fragment* on the
  // address bar and only a redirect can. A scope is already in the path that was asked
  // for, so the honest answer is the document.
  const src = read('lib/server.js');
  assert.match(
    src,
    /if \(urlPath === `\/\$\{SCOPE_ROOT\}` \|\| urlPath\.startsWith\(`\/\$\{SCOPE_ROOT\}\/`\)\) urlPath = '\/index\.html';/,
    'lib/server.js no longer rewrites a scoped address to the shell'
  );
  // Before `rel`, or the sign-in gate never sees a `.html` and a scoped address is served
  // to anybody who asks.
  assert.ok(
    src.indexOf('urlPath = \'/index.html\';') < src.indexOf("const rel = urlPath === '/' ? 'index.html'"),
    'the rewrite landed after `rel` — the sign-in gate no longer covers a scoped address'
  );
});

check('and the service worker gives a scope no hop of its own', () => {
  // It needs none: `caches.match('/')` already answers with the shell at the address that
  // was asked for. A redirect here would be the worker rewriting an address that arrived
  // correct.
  const sw = read('public/sw.js');
  const table = sw.slice(sw.indexOf('const VIEW_HOPS = {'), sw.indexOf('};', sw.indexOf('const VIEW_HOPS = {')));
  assert.ok(!table.includes(SCOPE_ROOT), 'a scoped address was given a row in VIEW_HOPS');
});

console.log(
  failures ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`
);
process.exit(failures ? 1 : 0);
