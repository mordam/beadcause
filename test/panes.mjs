#!/usr/bin/env node
/**
 * One document, one pane per view, and the pill row that shows and hides them.
 *
 *     npm test
 *     node test/panes.mjs
 *
 * bc-khoe.30.3. Tapping a view pill used to load a document — History was `/history`, the
 * advocate console was `/monitor` — and every one of those taps threw away the list, the
 * open card and the scroll position to rebuild a screen that was mostly the same screen.
 * `public/index.html` is the shell now: one `[data-pane]` container per view, all but one
 * hidden, with `public/panes.js` deciding which from the URL hash and `public/viewbar.js`
 * drawing a control rather than a link for any view this document can already show.
 *
 * Five things are worth a suite, and none of them is visible by reading one function.
 *
 * 1. **Hiding has to be `display: none`.** `visibility: hidden` and an offscreen transform
 *    leave the element in layout, and three panes in a viewport-height flex column would
 *    divide the slack three ways whether or not two of them are painted — bc-7utr's bug
 *    back again wearing a third mechanism. That is a claim about the stylesheet and about
 *    the `hidden` attribute beating `display: flex`, so it is read off disk.
 *
 * 2. **Scroll position has to survive a switch.** It is the thing this epic is buying, and
 *    it is the thing `display: none` takes away: a hidden element has no scrollport, so its
 *    `scrollTop` reads 0 and comes back 0. panes.js carries the number by hand and this
 *    drives the real file to prove it.
 *
 * 3. **A pane whose builder has not landed cannot be shown.** The shell shipped with
 *    History and Advocates as empty containers marked `data-pending`; Config is the one in
 *    that state today (bc-khoe.50 put the view in the grammar so the row could light its
 *    pill, bc-khoe.60 fills the container). Until it does its pill must still be the
 *    `<a href>` it has always been. Get that wrong and a pill leads to a blank screen on an
 *    app that deploys itself the moment a branch merges.
 *
 * 4. **A hash can change without the view changing** (bc-k7lrc). `#deluvia.briefs?b=one`
 *    to `?b=two` is the same pane, so `show` returns early on it — rightly — and until
 *    `sync` read the second half of the address too, the one URL change a view could never
 *    be told about was a change to its own. That is what makes a repo view deep-linkable
 *    to the thing it is showing rather than only to itself, and the failure is silent: the
 *    back button walks and the pane goes on drawing what it drew.
 *
 * 5. **The row is on twelve pages and only one has panes.** Every other page must draw
 *    exactly what it drew before, which means `window.beadcause.panes` being absent has to
 *    be an ordinary answer rather than a `TypeError`. The last section runs the row with no
 *    panes at all and asserts every pill is the link it was.
 *
 * The files run in a `node:vm` with a hand-made document, the way test/filterpills.mjs and
 * test/inboxkinds.mjs run theirs. `viewbar.js` builds its row with `innerHTML`, so the fake
 * element stores the string and the assertions read it — which is the honest shape here:
 * what is being checked is the markup the row emits, and parsing it back into elements
 * would only add a parser to disagree with the browser.
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
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

const HTML = read('public/index.html');
const CSS = read('public/style.css');
const SW = read('public/sw.js');
const VIEWBAR = read('public/viewbar.js');

/** The three view ids, read from the grammar rather than repeated here. */
const VIEW_IDS = [...read('public/hashroute.js').matchAll(/id: '([a-z]+)',\s*hash:/g)].map((m) => m[1]);

/* ================================================================ a document */

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Just enough of an element for the two files under test: attributes, children, scroll. */
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.scrollTop = 0;
    this.innerHTML = '';
  }
  get classList() {
    return { contains: (c) => this.classes().includes(c) };
  }
  classes() {
    return String(this.className || '').split(/\s+/).filter(Boolean);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  after(node) {
    const at = this.parent.children.indexOf(this);
    node.parent = this.parent;
    this.parent.children.splice(at + 1, 0, node);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  fire(type, ev) {
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }
  walk() {
    return this.children.flatMap((c) => [c, ...c.walk()]);
  }
  matches(sel) {
    const attr = sel.match(/^\[([-\w]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const got = this.attrs[attr[1]];
      return attr[2] == null ? got != null : got === attr[2];
    }
    if (sel.startsWith('.')) return this.classes().includes(sel.slice(1));
    return this.tag === sel;
  }
  querySelectorAll(sel) {
    return this.walk().filter((el) => el.matches(sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

/** `<div class="pane" data-pane="…" [data-pending="…"]>` with an optional scroller in it. */
function pane(id, { pending = null, scroller = true } = {}) {
  const el = new El('div');
  el.className = 'pane';
  el.setAttribute('data-pane', id);
  if (pending) el.setAttribute('data-pending', pending);
  if (scroller) {
    const s = new El('main');
    s.className = 'list pagescroll';
    el.append(s);
  }
  return el;
}

/**
 * A context with the grammar loaded and a body of panes, ready for panes.js and viewbar.js.
 *
 * `hash` and `pathname` are the whole of the input those two files take: everything else
 * they know, they read out of the document below them.
 */
function boot(panes, { hash = '', pathname = '/' } = {}) {
  const body = new El('body');
  const topbar = new El('header');
  topbar.className = 'topbar';
  body.append(topbar, ...panes);

  const location = { pathname, search: '', hash };
  const listeners = new Map();
  /** Every `history.pushState`/`replaceState` call `route.go` made, in order. */
  const historyCalls = [];
  const setFromUrl = (url) => {
    location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '';
  };
  const ctx = {
    location,
    history: {
      pushState(_s, _t, url) {
        historyCalls.push('push');
        setFromUrl(url);
      },
      replaceState(_s, _t, url) {
        historyCalls.push('replace');
        setFromUrl(url);
      },
    },
    document: {
      body,
      createElement: (tag) => new El(tag),
      querySelector: (sel) => (body.matches(sel) ? body : body.querySelector(sel)),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/hashroute.js'), ctx, { filename: 'hashroute.js' });

  /** Set the hash the way a back button or a deep link does, and let the page hear it. */
  const navigate = (next) => {
    location.hash = next;
    for (const fn of listeners.get('hashchange') || []) fn();
  };
  const run = (file) => vm.runInContext(read(`public/${file}`), ctx, { filename: file });
  return { ctx, body, topbar, navigate, run, historyCalls, panes: () => ctx.window.beadcause.panes };
}

/** Every pill the row emitted, as `{ id, tag, href, pane, kind, current }`. */
function pills(nav) {
  return [...nav.innerHTML.matchAll(/<(\w+) class="viewpill" data-pill="([a-z]+)"([^>]*)>/g)].map((m) => ({
    tag: m[1],
    id: m[2],
    href: /href="([^"]*)"/.exec(m[3])?.[1] ?? null,
    pane: /data-pane="([^"]*)"/.exec(m[3])?.[1] ?? null,
    kind: /data-kind="([^"]*)"/.exec(m[3])?.[1] ?? null,
    current: m[3].includes('aria-current="page"'),
  }));
}
const pill = (nav, id) => pills(nav).find((p) => p.id === id);

/* ======================================================== the markup on disk */

console.log('\nthe shell, as written');

await check('index.html holds a pane for every view the grammar knows', () => {
  assert.deepEqual(VIEW_IDS, ['epics', 'history', 'advocates', 'releases', 'config'], 'the view list moved');
  for (const id of VIEW_IDS) {
    assert.ok(
      new RegExp(`<div class="pane" data-pane="${id}"`).test(HTML),
      `no pane for ${id} — a view with no container is a pill with nowhere to go`
    );
  }
});

await check('exactly one of them is shown, and it is Home', () => {
  const declared = [...HTML.matchAll(/<div class="pane" data-pane="([a-z]+)"([^>]*)>/g)];
  assert.equal(declared.length, VIEW_IDS.length, 'a pane is missing or drawn twice');
  const shown = declared.filter((m) => !m[2].includes('hidden')).map((m) => m[1]);
  assert.deepEqual(shown, ['epics'], 'more than one pane starts visible, or the wrong one does');
});

await check('the one that is not built yet names the bead that builds it', () => {
  // Empty today: every view the grammar knows has a live pane, Config having been the
  // last (bc-khoe.60). A view named here that has since gone live is a line to delete,
  // not a failure to route around — this is the entry Config left when it did. A view
  // *missing* from here whose container is still empty is a pill leading to a blank
  // screen, which is the whole thing `data-pending` exists to stop — which is what the
  // count below is for, and it is why this check stays even with nothing to name.
  for (const [view, bead] of []) {
    const m = new RegExp(`data-pane="${view}" data-pending="([^"]+)"`).exec(HTML);
    assert.ok(m, `${view} is either live or unmarked — if it is live, drop it from this list`);
    assert.equal(m[1], bead, `${view} names ${m[1]} rather than the bead that fills it`);
  }
  assert.equal(
    (HTML.match(/data-pending=/g) || []).length,
    0,
    'a container is pending that is not named above — an unnamed one is a pill with nowhere to go'
  );
});

await check('and every other container is built', () => {
  // Each came off that list as its bead filled its container: History with bc-khoe.30.5,
  // Releases with bc-khoe.30.14, Advocates with bc-khoe.4 and Config with bc-khoe.60,
  // which was the last of the five the grammar came to know.
  for (const [view, bead] of [
    ['history', 'bc-khoe.30.5'],
    ['advocates', 'bc-khoe.4'],
    ['releases', 'bc-khoe.30.14'],
    ['config', 'bc-khoe.60'],
  ]) {
    assert.ok(
      !new RegExp(`data-pane="${view}"[^>]*data-pending`).test(HTML),
      `${view} is pending again — it was filled by ${bead}`
    );
  }
});

await check('and the live ones hold their own contents', () => {
  const open = HTML.indexOf('<div class="pane" data-pane="history"');
  const close = HTML.indexOf('<div class="pane" data-pane="advocates"');
  assert.ok(open > 0 && close > open, 'the panes are not where this suite thinks they are');
  const inside = HTML.slice(open, close);
  // The ledger's own two elements, and the id that is deliberately *not* `history`: the
  // hash naming this view is `#history`, and an element of that id in this document is a
  // fragment target the browser scrolls into view — undoing the scroll position panes.js
  // had just restored.
  for (const mark of ['id="hist-filters"', 'id="hist-list"', 'class="work pagescroll"']) {
    assert.ok(inside.includes(mark), `${mark} is not in the History pane`);
  }
  assert.ok(!inside.includes('id="history"'), 'the ledger container is a fragment target again');
  assert.ok(/<script src="\/history\.js">/.test(HTML), 'nothing loads the file that fills it');
});

await check('and the advocate console holds its chip row and all three sections — bc-khoe.4', () => {
  const open = HTML.indexOf('<div class="pane" data-pane="advocates"');
  const close = HTML.indexOf('<div class="pane" data-pane="releases"');
  assert.ok(open > 0 && close > open, 'the panes are not where this suite thinks they are');
  const inside = HTML.slice(open, close);
  // The row and the three sections it swaps, which is the whole of monitor.html below its
  // top bar. The row stays a row (bc-khoe.30.6): the Mirror follows another device and
  // drops its own, so it cannot be a pill, and a chip row that dissolves to one chip is a
  // worse shape than the row it replaced.
  for (const mark of ['id="mon-tabs"', 'id="mon"', 'id="prs"', 'id="mirror"', 'id="mirror-dot"']) {
    assert.ok(inside.includes(mark), `${mark} is not in the Advocates pane`);
  }
  assert.equal((inside.match(/data-tab="/g) || []).length, 3, 'the chip row is not three chips');
  // `⦿ observing` and the roster's tally came down out of the top bar with the sections
  // they belong to — the shell's bar belongs to every view, and these are facts about one.
  // The name is free because the Releases pane gave it up for exactly this (bc-khoe.30.14).
  for (const mark of ['id="observing"', 'id="tally"', 'class="mon-meta"']) {
    assert.ok(inside.includes(mark), `${mark} is not in the Advocates pane`);
  }
  // The gear that page carries is not one of them: accountbar.js draws a standing Admin
  // row in the mark's menu on every page since bc-khoe.5, so a second one hoisted out of
  // here would be the same row drawn twice.
  assert.ok(!inside.includes('id="gear"'), 'the console brought its own Admin door into a shell that has one');
  // `#advocates` is the hash that names this view, so an element of that id in this
  // document would be a fragment target — the trap `hist-list` and `rel-list` are named
  // for. Nothing in this pane is called that, and nothing had to be renamed: the row and
  // the sections were `mon-tabs`, `mon`, `prs` and `mirror` already.
  assert.ok(!inside.includes('id="advocates"'), 'the console container is a fragment target');
  for (const file of ['montabs', 'monitor', 'prs', 'mirror']) {
    assert.ok(HTML.includes(`<script src="/${file}.js">`), `nothing loads /${file}.js`);
  }
  // montabs.js is the pane's one registration with the stager, and the three sections each
  // register on it as they load — so the order is a blank pane rather than a style point.
  for (const file of ['monitor', 'prs', 'mirror']) {
    assert.ok(
      HTML.indexOf('<script src="/montabs.js">') < HTML.indexOf(`<script src="/${file}.js">`),
      `${file}.js loads before montabs.js and would find no row to register on`
    );
  }
  // prs.js takes the row, the lamps and the status ladder off prcard.js at module scope.
  assert.ok(
    HTML.indexOf('<script src="/prcard.js">') < HTML.indexOf('<script src="/prs.js">'),
    'prs.js loads before prcard.js and would throw before it drew'
  );
});

await check('and so does the release board — filled by bc-khoe.30.14', () => {
  const open = HTML.indexOf('<div class="pane" data-pane="releases"');
  assert.ok(open > 0, 'the Releases pane is not where this suite thinks it is');
  const close = HTML.indexOf('<div class="pane" data-pane="config"', open);
  assert.ok(close > open, 'Config is not the pane after Releases any more — pick a new end marker');
  const inside = HTML.slice(open, close);
  // Same fragment-target rule as the ledger above, and a second id that had to move for a
  // duller reason: monitor.html carries an `id="observing"` and folds into this document
  // under bc-khoe.4, so the bare name would collide the moment it did.
  for (const mark of ['id="rel-list"', 'id="rel-observing"', 'class="work pagescroll"']) {
    assert.ok(inside.includes(mark), `${mark} is not in the Releases pane`);
  }
  assert.ok(!inside.includes('id="releases"'), 'the release board container is a fragment target again');
  assert.ok(!inside.includes('id="observing"'), 'the observing chip took a name bc-khoe.4 also wants');
  assert.ok(/<script src="\/releases\.js">/.test(HTML), 'nothing loads the file that fills it');
  // It takes `esc`, `plural`, `ago` and `graphUrl` off prcard.js at module scope, so the
  // order is a throw rather than a style point.
  assert.ok(
    HTML.indexOf('<script src="/prcard.js">') < HTML.indexOf('<script src="/releases.js">'),
    'releases.js loads before prcard.js and would throw before it drew'
  );
});

await check('and so does the space’s settings — filled by bc-khoe.60', () => {
  const open = HTML.indexOf('<div class="pane" data-pane="config"');
  assert.ok(open > 0, 'the Config pane is not where this suite thinks it is');
  const close = HTML.indexOf('<div id="toast"', open);
  assert.ok(close > open, 'the Config pane is not the last one any more — pick a new end marker');
  const inside = HTML.slice(open, close);
  // No fragment-target trap here — the hash naming this view is `#config` and nothing in
  // this pane was ever called `config` — but the observing chip has the same collision
  // Releases' did: monitor.html carries an `id="observing"` and folds into this document
  // under bc-khoe.4, so the bare name is taken.
  for (const mark of ['id="space"', 'id="cfg-observing"', 'class="work pagescroll"']) {
    assert.ok(inside.includes(mark), `${mark} is not in the Config pane`);
  }
  assert.ok(!inside.includes('id="observing"'), 'the observing chip took a name bc-khoe.4 also wants');
  assert.ok(/<script src="\/config\.js">/.test(HTML), 'nothing loads the file that fills it');
});

await check('Home’s pane holds everything that belongs to Home, and nothing that does not', () => {
  const open = HTML.indexOf('<div class="pane" data-pane="epics">');
  const close = HTML.indexOf('<div class="pane" data-pane="history"');
  assert.ok(open > 0 && close > open, 'the panes are not where this suite thinks they are');
  const inside = HTML.slice(open, close);
  // The list and its filter, and the fixed things that float over them: a ＋ left
  // outside the pane would go on hovering over the History pane with nothing behind it.
  // The ✏️ used to be one of them and is parked (bc-p49x.12) — asserted absent from the
  // whole document by test/editmode.mjs, so there is nothing here to place.
  for (const mark of ['id="filters"', 'id="list"', 'id="scrollpos"', 'class="compose-wrap"']) {
    assert.ok(inside.includes(mark), `${mark} is outside Home’s pane`);
  }
  // The app talking, rather than this view: both outlive a pane switch.
  for (const mark of ['id="toast"', 'id="setup"']) {
    assert.ok(!inside.includes(mark), `${mark} is inside Home’s pane and would vanish with it`);
  }
});

await check('and it still marks the one element that scrolls', () => {
  // test/shell.mjs asserts every page marks a `.pagescroll`; what it cannot see is that the
  // mark has to be *inside* the pane, or the pane is a flex column with nothing to give its
  // slack to.
  const open = HTML.indexOf('<div class="pane" data-pane="epics">');
  const close = HTML.indexOf('<div class="pane" data-pane="history"');
  assert.match(HTML.slice(open, close), /class="list pagescroll"/);
});

await check('panes.js is loaded after the grammar and before the row', () => {
  const at = (f) => HTML.indexOf(`<script src="/${f}">`);
  assert.notEqual(at('panes.js'), -1, 'index.html does not load panes.js at all');
  assert.ok(at('hashroute.js') < at('panes.js'), 'panes.js runs before the grammar it asks');
  assert.ok(at('panes.js') < at('viewbar.js'), 'the row is drawn before it can ask about panes');
});

await check('and no other page loads it — the row asks, it does not require', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  const loaders = pages.filter((f) => read(`public/${f}`).includes('<script src="/panes.js">'));
  assert.deepEqual(loaders, ['index.html'], `${loaders.join(', ')} load panes.js`);
});

await check('the row reaches for panes with ?. and for the grammar flat', () => {
  // The asymmetry is the whole reason a v81 phone survives this branch: a page with no
  // grammar is broken and should say so, a page with no panes is eleven pages out of
  // twelve.
  assert.ok(/window\.beadcause\?\.panes/.test(VIEWBAR), 'viewbar.js requires panes to exist');
  assert.ok(/const route = window\.beadcause\.route;/.test(VIEWBAR), 'the grammar stopped being required');
});

console.log('\nhiding has to take the pane out of layout');

await check('.pane takes the slack the scroller used to', () => {
  const rule = /\n\.pane \{([^}]*)\}/.exec(CSS);
  assert.ok(rule, 'no top-level .pane rule in public/style.css');
  for (const decl of [/flex:\s*1/, /min-height:\s*0/, /display:\s*flex/, /flex-direction:\s*column/]) {
    assert.match(rule[1], decl, `.pane is missing ${decl}`);
  }
});

await check('and a hidden one is display: none, which is the only hiding that works here', () => {
  assert.match(CSS, /\.pane\[hidden\]\s*\{\s*display:\s*none;?\s*\}/, 'the UA’s [hidden] loses to display: flex');
  const rule = /\n\.pane \{([^}]*)\}/.exec(CSS)[1];
  assert.ok(!/visibility|transform|position:\s*absolute/.test(rule), 'a pane is hidden by something that keeps its layout');
});

await check('the service worker precaches it, and the version moved', () => {
  assert.ok(SW.includes("'/panes.js',"), 'a boot-time file of the shell is left to the network');
  const notes = fs.readdirSync(path.join(ROOT, 'docs/sw-cache')).map((f) => Number(/v(\d+)\.md/.exec(f)?.[1] || 0));
  const cache = Number(/const CACHE = 'beadcause-v(\d+)'/.exec(SW)[1]);
  assert.equal(cache, Math.max(...notes), 'const CACHE and docs/sw-cache/ disagree — the silent merge');
});

/* ================================================== panes.js, actually running */

console.log('\nwhich pane is up');

/** A shell with a container still waiting on the bead that fills it — synthetic now
    rather than a photograph: every real container is built as of bc-khoe.60, so nothing
    on disk is pending any more for this fixture to mirror. It reuses the Config view id
    anyway, because `known()` in panes.js only picks up a `[data-pane]` whose id is one
    the grammar already has — a made-up id would be skipped rather than marked pending —
    and the bead named on it is left as the last real one to prove the string is read,
    not to claim Config is still waiting on it. */
const withPending = () => [
  pane('epics'),
  pane('history'),
  pane('advocates'),
  pane('releases'),
  pane('config', { pending: 'bc-khoe.60', scroller: false }),
];

/** The shell once every container is filled — all five, since bc-khoe.60 landed the
    last of them. The pill assertions below are about what filling one changes at the
    row, so they want the finished shape. */
const whenBuilt = () => [pane('epics'), pane('history'), pane('advocates'), pane('releases'), pane('config')];

await check('with no hash, Home is the pane and the others are hidden', () => {
  const b = boot(whenBuilt());
  b.run('panes.js');
  assert.equal(b.panes().showing(), 'epics');
  assert.deepEqual(b.body.querySelectorAll('[data-pane]').map((el) => el.hidden), [false, true, true, true, true]);
});

await check('a view hash lands on that pane, with no document asked for', () => {
  const b = boot(whenBuilt(), { hash: '#history' });
  b.run('panes.js');
  assert.equal(b.panes().showing(), 'history');
  assert.deepEqual(b.body.querySelectorAll('[data-pane]').map((el) => el.hidden), [true, false, true, true, true]);
});

await check('a card hash is Home, from any pane — a question lives there', () => {
  const b = boot(whenBuilt(), { hash: '#beadcause%2Fbc-khoe' });
  b.run('panes.js');
  assert.equal(b.panes().showing(), 'epics');
});

await check('a hash nobody minted is Home too, and shows no blank pane', () => {
  const b = boot(whenBuilt(), { hash: '#wat' });
  b.run('panes.js');
  assert.equal(b.panes().showing(), 'epics');
});

await check('the back button walks the panes', () => {
  const b = boot(whenBuilt());
  b.run('panes.js');
  b.navigate('#advocates');
  assert.equal(b.panes().showing(), 'advocates');
  b.navigate('#history');
  assert.equal(b.panes().showing(), 'history');
  b.navigate('');
  assert.equal(b.panes().showing(), 'epics');
});

await check('a pending pane is never shown, and its hash falls to Home', () => {
  // Both pending at once, which is what this rule is about and which the shell has not
  // shown for real since bc-khoe.4 landed — nothing on disk is pending any more, so this
  // fixture is built by hand rather than drawn from `withPending`. These two are the
  // pair the shell shipped with, and they carry the beads the markup carried:
  // bc-khoe.4 rather than bc-khoe.30.6, because the attribute names the bead whose merge
  // deletes the container, and that is the fold rather than the ruling.
  const b = boot(
    [pane('epics'), pane('history', { pending: 'bc-khoe.30.5', scroller: false }), pane('advocates', { pending: 'bc-khoe.4', scroller: false })],
    { hash: '#history' }
  );
  b.run('panes.js');
  assert.equal(b.panes().showing(), 'epics', 'an empty container was put on screen');
  assert.equal(b.panes().has('history'), false);
  assert.deepEqual({ ...b.panes().pending() }, { history: 'bc-khoe.30.5', advocates: 'bc-khoe.4' });
});

await check('a pill sharing a pane’s id cannot displace it in the map — bc-khoe.30.11', () => {
  // A view pill's own `data-pane` is name-for-name the view id it switches to — the exact
  // thing this map is keyed by — so an unscoped `[data-pane]` scan would let whichever
  // element the query visits last win the id, real pane or not. The pill row is drawn
  // after the panes today, so a scan that trusted script order would happen to be fine;
  // this decoy is placed last on purpose, the one position an order-trusting scan would
  // get wrong, to prove the fix does not lean on that order at all.
  const history = pane('history');
  history.hidden = true; // what the real markup starts with — see index.html
  const decoy = new El('button');
  decoy.className = 'viewpill';
  decoy.setAttribute('data-pane', 'history');
  decoy.hidden = true;
  const b = boot([pane('epics'), history, pane('advocates'), pane('releases'), pane('config'), decoy], {
    hash: '#history',
  });
  b.run('panes.js');
  assert.equal(history.hidden, false, 'the decoy pill won the id in the map and the real pane stayed hidden');
  assert.equal(decoy.hidden, true, 'panes.js touched an element that carries the attribute but is not a pane');
});

await check('go() writes the hash and switches — including Home, which fires no hashchange', () => {
  // `route.go('')` clears Home's hash with pushState so the URL stays the one the phone's
  // home screen holds, and pushState does not fire `hashchange`. A row that only wrote the
  // URL would leave the Home pill dead from every other pane.
  const b = boot(whenBuilt());
  b.run('panes.js');
  b.panes().go('history');
  assert.equal(b.ctx.location.hash, '#history');
  assert.equal(b.panes().showing(), 'history');
  b.panes().go('epics');
  assert.equal(b.ctx.location.hash, '', 'a bare # was left hanging on the URL');
  assert.equal(b.panes().showing(), 'epics', 'the Home pill is dead from every other pane');
});

await check('moving to Home from another pane pushes, so back walks it (bc-khoe.30.9)', () => {
  const b = boot(whenBuilt());
  b.run('panes.js');
  b.panes().go('history');
  b.panes().go('epics');
  assert.deepEqual(
    b.historyCalls,
    ['push'],
    'Home was not reached with pushState — the entry for History would be gone and back would leave the app'
  );
});

await check('onShow says which pane arrived, once per move', () => {
  const b = boot(whenBuilt());
  b.run('panes.js');
  const seen = [];
  b.panes().onShow((id) => seen.push(id));
  b.panes().go('history');
  b.panes().go('history');
  b.panes().go('epics');
  assert.deepEqual(seen, ['history', 'epics'], 'a switch to the pane already up repainted anyway');
});

/* ============================ the second half of the address (bc-k7lrc) */

console.log('\nthe query on the pane that is up');

/**
 * A shell with a repo view adopted into it — the only kind of view that has no container
 * in `index.html`, and the caller this half of the address was built for.
 *
 * The order is the one public/viewhost.js is required to use and the reason it is
 * required: `route.add` first, because `adopt` refuses an id the grammar does not know.
 */
function withBriefs(opts) {
  const b = boot(whenBuilt(), opts);
  b.run('panes.js');
  b.ctx.window.beadcause.route.add({ id: 'deluvia.briefs', paths: ['/v/deluvia/briefs'] });
  const el = pane('deluvia.briefs');
  b.body.append(el);
  b.panes().adopt('deluvia.briefs', el);
  return b;
}

await check('a query-only move is reported, though the pane never changes', () => {
  // The bug this exists to fix. `show` returns early when the view has not moved — rightly,
  // since nothing is hidden and no scroll position goes anywhere — so before this the one
  // URL change a view could never hear about was a change to its own address. The back
  // button walked between two briefs and the pane went on drawing the first one.
  const b = withBriefs({ hash: '#deluvia.briefs?b=one' });
  const seen = [];
  b.panes().onQuery((view, q) => seen.push(`${view}|${q}`));
  assert.equal(b.panes().showing(), 'deluvia.briefs');
  assert.equal(b.panes().query(), 'b=one', 'the deep link’s own query was dropped on the way in');
  b.navigate('#deluvia.briefs?b=two');
  assert.equal(b.panes().showing(), 'deluvia.briefs', 'a query change moved the pane');
  assert.deepEqual(seen, ['deluvia.briefs|b=two']);
});

await check('leaving the view drops its query, and coming back hands it over again', () => {
  const b = withBriefs({ hash: '#deluvia.briefs?b=one' });
  const seen = [];
  b.panes().onQuery((view, q) => seen.push(`${view}|${q}`));
  b.navigate('#history');
  b.navigate('#deluvia.briefs?b=one');
  assert.deepEqual(seen, ['history|', 'deluvia.briefs|b=one'], 'the pane came back drawing whatever it was last told');
});

await check('a query hung on a pane this document cannot show falls with the view', () => {
  // `show` answers a hash naming a pending or unbuilt pane with Home. A query that was
  // written for the view that lost is not Home's, and handing it over would be the ledger's
  // filters arriving on the inbox.
  const b = boot(withPending(), { hash: '#config?section=notify' });
  b.run('panes.js');
  assert.equal(b.panes().showing(), 'epics');
  assert.equal(b.panes().query(), '', 'a pending pane’s query was handed to Home');
});

await check('setQuery writes without leaving, and does not tell the writer what it just did', () => {
  const b = withBriefs({ hash: '#deluvia.briefs' });
  const seen = [];
  b.panes().onQuery((view, q) => seen.push(`${view}|${q}`));
  assert.equal(b.panes().setQuery('deluvia.briefs', 'b=one'), true);
  assert.equal(b.ctx.location.hash, '#deluvia.briefs?b=one');
  assert.equal(b.panes().showing(), 'deluvia.briefs', 'writing a query switched panes');
  assert.equal(b.panes().query(), 'b=one');
  assert.deepEqual(seen, [], 'the view was told about its own write — `onQuery` means somebody else moved you');
  assert.equal(b.panes().setQuery('deluvia.briefs', 'b=one'), false, 'a write of what is already there');
});

await check('a narrowing replaces and a place pushes', () => {
  // `replaceState` by default: a filter chip is not somewhere you go back *to*, and a
  // panel of them would fill the back stack with steps between you and the screen you
  // arrived from. `push` is for the narrowing that really is a place — tapping into one
  // brief out of a list is somewhere the back button is expected to leave.
  const b = withBriefs({ hash: '#deluvia.briefs' });
  b.panes().setQuery('deluvia.briefs', 'b=one');
  assert.deepEqual(b.historyCalls, ['replace'], 'the default left a step in the back stack');

  // The push goes through `route.go`, which writes a non-empty hash by *assigning*
  // `location.hash` — that is what pushes an entry, in a browser and by definition. So the
  // proof that it pushed is that it did not call `replaceState`, and the fake `location`
  // here records the same thing a browser's address bar would show.
  const seen = [];
  b.panes().onQuery((view, q) => seen.push(`${view}|${q}`));
  b.panes().setQuery('deluvia.briefs', 'b=two', { push: true });
  assert.deepEqual(b.historyCalls, ['replace'], 'a push was written with replaceState — the back stack lost the step');
  assert.equal(b.ctx.location.hash, '#deluvia.briefs?b=two');
  assert.equal(b.panes().query(), 'b=two');

  // And the `hashchange` that assignment causes in a real browser arrives to find nothing
  // it has not already been told, so the writer is not called back about its own push
  // either. Without `currentQuery` being brought up to date inside `setQuery`, this is the
  // line that would fire.
  b.navigate('#deluvia.briefs?b=two');
  assert.deepEqual(seen, [], 'the push’s own hashchange was reported back to the view that pushed');
});

await check('a pane that is not on screen may not write the address', () => {
  // The refusal both of the older `address` objects make for themselves — the staged boot
  // builds a pane while Home is showing, and a repo view's `build` runs whenever its
  // generator lands. A view writing from behind a pane nobody is looking at would move the
  // address out from under the view that owns it. A repo view's script is in somebody
  // else's checkout, so the refusal has to be made for it rather than documented at it.
  const b = withBriefs({ hash: '#history' });
  assert.equal(b.panes().showing(), 'history');
  assert.equal(b.panes().setQuery('deluvia.briefs', 'b=one'), false);
  assert.equal(b.ctx.location.hash, '#history', 'a hidden pane wrote the address');
});

await check('go() carries a query, and Home still refuses to hold one', () => {
  const b = withBriefs();
  b.panes().go('deluvia.briefs', 'b=one');
  assert.equal(b.ctx.location.hash, '#deluvia.briefs?b=one');
  assert.equal(b.panes().showing(), 'deluvia.briefs');
  // Home is the empty hash, so there is no name for a query to hang off — and `/?…` is the
  // address the phone's home screen holds. `hashFor` answers the bare hash rather than
  // refusing, so the pill still works.
  b.panes().go('epics', 'b=one');
  assert.equal(b.ctx.location.hash, '');
  assert.equal(b.panes().showing(), 'epics');
});

console.log('\nwhere you were, when you come back');

await check('a pane’s scroll position survives a switch away and back', () => {
  // The thing this epic is buying, and the thing `display: none` takes away: a hidden
  // element has no scrollport, so `scrollTop` reads 0 and comes back 0. panes.js carries
  // the number across by hand — this is the check that it does.
  const b = boot(whenBuilt());
  b.run('panes.js');
  const list = b.body.querySelector('[data-pane="epics"]').querySelector('.pagescroll');
  list.scrollTop = 1840;
  b.panes().go('history');
  list.scrollTop = 0; // what the browser does to a scroller with no layout box
  b.panes().go('epics');
  assert.equal(list.scrollTop, 1840, 'you came back to the top of a list you were halfway down');
});

await check('and each pane keeps its own, not the last one’s', () => {
  const b = boot(whenBuilt());
  b.run('panes.js');
  const at = (id) => b.body.querySelector(`[data-pane="${id}"]`).querySelector('.pagescroll');
  at('epics').scrollTop = 600;
  b.panes().go('history');
  at('history').scrollTop = 120;
  b.panes().go('epics');
  assert.equal(at('epics').scrollTop, 600);
  b.panes().go('history');
  assert.equal(at('history').scrollTop, 120);
});

/* ============================================== the row over the panes */

console.log('\nthe pill row, over a document that has panes');

/** Boot the shell and draw the row on it. */
function row(panes, opts) {
  const b = boot(panes, opts);
  b.run('panes.js');
  b.run('viewbar.js');
  return { ...b, nav: b.body.querySelector('.viewbar') };
}

await check('a pill whose container is still pending is a link to the document it is', () => {
  const { nav } = row(withPending());
  assert.equal(pill(nav, 'config').tag, 'a');
  assert.equal(pill(nav, 'config').href, '/config');
  // And the other three are not, because bc-khoe.30.5, bc-khoe.4 and bc-khoe.30.14 filled
  // theirs. This is the whole of what filling a container changes at the row: nothing in
  // viewbar.js moved for any of them, and the `href` in `PILLS` stays — eleven pages that
  // have no panes still draw this row and still need the link.
  for (const id of ['history', 'advocates', 'releases']) {
    assert.equal(pill(nav, id).tag, 'button', `${id} still loads a document this page has open`);
    assert.equal(pill(nav, id).pane, id);
    assert.equal(pill(nav, id).href, null);
  }
});

await check('once a pane is built, its pill stops being a link', () => {
  const { nav } = row(whenBuilt());
  const p = pill(nav, 'history');
  assert.equal(p.tag, 'button', 'a pill still loads a document the app already has open');
  assert.equal(p.href, null);
  assert.equal(p.pane, 'history');
});

await check('and no pill anywhere on the shell is an <a> to a view it can show', () => {
  const { nav } = row(whenBuilt());
  for (const p of pills(nav)) {
    if (p.tag !== 'a') continue;
    assert.ok(!VIEW_IDS.includes(p.id), `${p.id} is a link to a pane of this very document`);
  }
});

await check('the lit pill follows the pane, not the address', () => {
  const { nav, panes } = row(whenBuilt());
  assert.equal(pills(nav).find((p) => p.current).id, 'epics');
  panes().go('advocates');
  assert.equal(pills(nav).find((p) => p.current).id, 'advocates');
  assert.equal(pill(nav, 'advocates').tag, 'span', 'the pill you are on is still a control');
  panes().go('epics');
  assert.equal(pills(nav).find((p) => p.current).id, 'epics');
});

await check('a kind pill tapped from another pane switches to Home and narrows, in one tap', () => {
  const { nav, panes } = row(whenBuilt());
  panes().go('history');
  const p = pill(nav, 'pr');
  assert.equal(p.tag, 'button', 'PRs went back to being a document load from the History pane');
  assert.equal(p.pane, 'epics');
  assert.equal(p.kind, 'pr');
});

await check('and on Home it carries the narrowing alone — the pane is already right', () => {
  const { nav } = row(whenBuilt());
  const p = pill(nav, 'pr');
  assert.equal(p.tag, 'button');
  assert.equal(p.pane, null, 'a tap on Home rewrites a hash that is already right');
  assert.equal(p.kind, 'pr');
});

await check('the tap goes to the pane first and the filter second', () => {
  const { nav, ctx, panes } = row(whenBuilt());
  panes().go('history');
  const order = [];
  ctx.window.beadcause.inboxFilter = { pick: (k) => order.push(`kind:${k}`) };
  panes().onShow((id) => order.push(`pane:${id}`));
  const btn = { dataset: { pane: 'epics', kind: 'pr' } };
  nav.fire('click', { target: { closest: () => btn }, preventDefault() {} });
  assert.deepEqual(order, ['pane:epics', 'kind:pr'], 'the filter narrowed a list nobody was looking at');
  assert.equal(panes().showing(), 'epics');
});

await check('a narrowing chosen while another pane is up is waiting when Home comes back', () => {
  const { nav, ctx, panes } = row(whenBuilt());
  panes().go('history');
  // The inbox goes on repainting behind a hidden pane, and `paint` pushes the selection at
  // the row every time. Refusing it outright — which is what "a no-op off Home" used to
  // mean — leaves the row lighting last week's answer on the way back.
  ctx.window.beadcause.views.mark('bead');
  assert.equal(pills(nav).find((p) => p.current).id, 'history', 'the row lit a Home pill while History was up');
  panes().go('epics');
  assert.equal(pills(nav).find((p) => p.current).id, 'bead');
});

/* ================================================ the eleven pages without panes */

console.log('\nthe eleven pages that have no panes');

await check('with no panes at all, every pill is the link it always was', () => {
  // /flow, /requirements, /endorse, /admin, /console — and, until bc-khoe.30.5 and .30.6,
  // /history and /monitor themselves. viewbar.js is the same file on all of them.
  const b = boot([], { pathname: '/flow' });
  b.run('viewbar.js');
  const nav = b.body.querySelector('.viewbar');
  assert.equal(b.ctx.window.beadcause.panes, undefined, 'this page somehow has panes');
  for (const p of pills(nav)) {
    assert.equal(p.tag, 'a', `${p.id} is a control on a page with nothing to control`);
    assert.ok(p.href, `${p.id} has no href and nowhere to go`);
  }
  assert.equal(pills(nav).filter((p) => p.current).length, 0, '/flow lit a pill it is not on');
});

await check('and on a page that is a view, that view’s pill is current', () => {
  const b = boot([], { pathname: '/work.html' });
  b.run('viewbar.js');
  const nav = b.body.querySelector('.viewbar');
  assert.equal(pills(nav).find((p) => p.current).id, 'advocates');
});

await check('on Home as a whole document, the kind pills still act and History still links', () => {
  const b = boot([], { pathname: '/' });
  b.run('viewbar.js');
  const nav = b.body.querySelector('.viewbar');
  assert.equal(pill(nav, 'pr').tag, 'button');
  assert.equal(pill(nav, 'pr').kind, 'pr');
  assert.equal(pill(nav, 'pr').pane, null);
  assert.equal(pill(nav, 'history').tag, 'a');
  assert.equal(pills(nav).find((p) => p.current).id, 'epics');
});

console.log(failures ? `\n${failures} of ${ran} failed` : `\nall ${ran} good`);
process.exit(failures ? 1 : 0);
