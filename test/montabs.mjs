#!/usr/bin/env node
/**
 * The chip row on the advocates page — which of its three panes is up.
 *
 *     npm test
 *     node test/montabs.mjs
 *
 * It was two chips and a boolean in `public/mirror.js` until bc-d4d5 gave the page a
 * third pane, and the reason it is now a file of its own with a suite behind it is that
 * everything it decides is invisible from any one pane. Four things, and each of them
 * fails silently rather than loudly:
 *
 * 1. **Exactly one pane is showing.** A three-way swap written as "hide the other one"
 *    is a two-way swap that has grown a third chip: the pane that is going away has to
 *    be hidden by name, not by not being the arriving one. Get it wrong and the board
 *    draws *under* the roster on a page that still scrolls and still works.
 *
 * 2. **A hidden pane is told, so it can stand down.** Each of the three holds a parked
 *    `/api/poll`, and the board's wakes are a `gh` call per repo. The subscription is
 *    the whole mechanism that stops three of them running at once, so "everyone is told
 *    on every change, and once at boot" is the contract rather than an implementation
 *    detail — the panes have no other way to know.
 *
 * 3. **`presence` says which chip is up, and says *nothing* while the Mirror is.** That
 *    second half is what stops a mirror following the page it is drawn on, which is one
 *    of the two reasons the Mirror is a pane at all (bc-3xb, and test/mirrorpane.mjs
 *    holds the other end of it).
 *
 * 4. **Arriving by one of the board's own URLs selects the board.** `/prs`, `/pulls` and
 *    `/prs.html` are on the phone's home screen and in the notification a ship sends; if
 *    the stored chip won there, a notification about a pull request would open the
 *    advocates roster and look like a link that had quietly stopped working.
 *
 * The real file in a vm with a hand-made document, the way test/spacebar.mjs runs the
 * real picker: the chips and panes are recorded rather than rendered, because what is
 * being asserted is which attributes were set and in what order — a real DOM here would
 * be testing a parser.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = (f) => path.join(ROOT, 'public', f);

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  [32m✓[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${err.message}`);
  }
}

/* The three chips as monitor.html declares them, `data-view` and all. Written out here
   rather than parsed out of the HTML on purpose: this suite is about what the file does
   with a row, and test/mirrorpane.mjs is what holds the row itself to the empty
   `data-view` on the Mirror. */
const CHIPS = [
  { tab: 'advocates', pane: 'mon', view: 'sessions' },
  { tab: 'prs', pane: 'prs', view: 'prs' },
  { tab: 'mirror', pane: 'mirror', view: '' },
];

/**
 * The real file, in a room with the row, the three panes and a `localStorage`.
 *
 * Returns the handles every check below reads: what each pane's `hidden` is now, what
 * each chip's `aria-pressed` is, every presence report in order, and a `tap` that fires
 * the row's own delegated click the way a thumb would.
 */
function load({ pathname = '/monitor', stored = {}, presence = true, bar = 104, observer = true } = {}) {
  const reports = [];
  const panes = Object.fromEntries(CHIPS.map((c) => [c.pane, { id: c.pane, hidden: false }]));
  const chips = CHIPS.map((c) => ({
    dataset: { tab: c.tab, pane: c.pane, view: c.view },
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    // What `e.target.closest('[data-tab]')` resolves to when the chip itself is tapped.
    closest: () => null,
  }));

  let rowClick = null;
  const row = {
    querySelectorAll: () => chips,
    addEventListener(type, fn) {
      if (type === 'click') rowClick = fn;
    },
  };

  let ready = null;
  const store = new Map(Object.entries(stored));
  const window = { beadcause: presence ? { presence: { report: (r) => reports.push(r) } } : {} };

  /* The top bar the strip sticks under, and the two things the file needs to publish
     its height with: somewhere to put the number, and something that tells it the
     number moved. `bar: null` is a page with no bar at all — every page has one, but
     this file is loaded by whatever asks for it and must not throw on the day one
     does not. */
  let barH = bar;
  const vars = new Map();
  let observed = null;
  const topbar = bar === null ? null : { getBoundingClientRect: () => ({ height: barH }) };

  const ctx = vm.createContext({
    window,
    document: {
      getElementById: (id) => (id === 'mon-tabs' ? row : panes[id] || null),
      querySelector: (sel) => (sel === '.topbar' ? topbar : null),
      documentElement: { style: { setProperty: (k, v) => vars.set(k, v) } },
      addEventListener(type, fn) {
        if (type === 'DOMContentLoaded') ready = fn;
      },
    },
    location: { pathname },
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
    },
    setTimeout,
    ...(observer
      ? {
          ResizeObserver: class {
            constructor(fn) {
              this.fn = fn;
            }
            observe(el) {
              observed = { el, fire: this.fn };
            }
          },
        }
      : {}),
  });
  vm.runInContext(fs.readFileSync(PUBLIC('montabs.js'), 'utf8'), ctx, { filename: 'montabs.js' });

  const api = ctx.window.beadcause.monTabs;
  return {
    api,
    reports,
    store,
    /** The page has finished parsing — which is when the first chip goes up. */
    boot: () => ready(),
    /** A thumb on one of the chips, through the row's own delegated listener. */
    tap: (tab) => rowClick({ target: { closest: () => chips.find((c) => c.dataset.tab === tab) } }),
    /** Every custom property the file has put on the root element. */
    vars,
    /** Whether the bar is the thing being watched, and not something else. */
    watching: () => observed && observed.el === topbar,
    /** The bar changing height — the space picker's row arriving or going. */
    resize: (h) => {
      barH = h;
      observed.fire();
    },
    shown: () => CHIPS.filter((c) => !panes[c.pane].hidden).map((c) => c.tab),
    pressed: () => chips.filter((c) => c.attrs['aria-pressed'] === 'true').map((c) => c.dataset.tab),
  };
}

console.log('\nthe advocates page’s chip row\n');

/* ------------------------------------------------------------------ one at a time */

check('nothing is decided before the page has finished parsing', () => {
  const t = load();
  // Every pane's script registers between this file and DOMContentLoaded; a row that
  // painted at load would tell the first of them and none of the rest.
  assert.equal(t.api.active(), null, 'a chip is up before the page has parsed');
});

check('the boot puts exactly one pane up, and the first chip is the default', () => {
  const t = load();
  t.boot();
  assert.deepEqual(t.shown(), ['advocates']);
  assert.deepEqual(t.pressed(), ['advocates']);
});

check('and a tap swaps it — one showing, one pressed, every time', () => {
  const t = load();
  t.boot();
  t.tap('prs');
  assert.deepEqual(t.shown(), ['prs'], 'the board is not the only pane showing');
  assert.deepEqual(t.pressed(), ['prs']);
  t.tap('mirror');
  assert.deepEqual(t.shown(), ['mirror'], 'the pane going away was left up');
  assert.deepEqual(t.pressed(), ['mirror']);
  t.tap('advocates');
  assert.deepEqual(t.shown(), ['advocates']);
});

check('the chip that is up is remembered, and comes back next visit', () => {
  const t = load();
  t.boot();
  t.tap('prs');
  assert.equal(t.store.get('beadcause.mon.tab'), 'prs');
  const back = load({ stored: { 'beadcause.mon.tab': 'prs' } });
  back.boot();
  assert.deepEqual(back.shown(), ['prs']);
});

check('including one left on the Mirror before the row was three chips wide', () => {
  // The key it was stored under while mirror.js owned the swap. Read, never written —
  // the alternative is every such device silently landing on Advocates once.
  const t = load({ stored: { 'beadcause.mirror.tab': 'mirror' } });
  t.boot();
  assert.deepEqual(t.shown(), ['mirror']);
});

check('a stored chip that no longer exists falls back rather than showing nothing', () => {
  const t = load({ stored: { 'beadcause.mon.tab': 'sessions' } });
  t.boot();
  assert.deepEqual(t.shown(), ['advocates']);
});

/* --------------------------------------------------------------- the paths in */

check('arriving by the board’s own URLs puts the board up, whatever was stored', () => {
  for (const p of ['/prs', '/pulls', '/prs.html']) {
    const t = load({ pathname: p, stored: { 'beadcause.mon.tab': 'mirror' } });
    t.boot();
    assert.deepEqual(t.shown(), ['prs'], `${p} did not select the board`);
  }
});

check('and a trailing slash is the same URL', () => {
  const t = load({ pathname: '/prs/' });
  t.boot();
  assert.deepEqual(t.shown(), ['prs']);
});

/* ------------------------------------------------------------- who gets told */

check('every subscriber is told once at boot, and on every change after it', () => {
  const t = load();
  const seen = [];
  t.api.onChange((which, prev) => seen.push([which, prev]));
  assert.deepEqual(seen, [], 'told before the page had parsed');
  t.boot();
  t.tap('prs');
  t.tap('advocates');
  assert.deepEqual(seen, [
    ['advocates', null],
    ['prs', 'advocates'],
    ['advocates', 'prs'],
  ]);
});

check('a tap on the chip already up tells nobody — a repaint is not news', () => {
  const t = load();
  t.boot();
  const seen = [];
  t.api.onChange(() => seen.push(1));
  seen.length = 0;
  t.tap('advocates');
  assert.deepEqual(seen, []);
});

check('subscribing after the first paint is told immediately', () => {
  // Which is what makes load order between this file and its panes not a thing anybody
  // has to hold in their head.
  const t = load();
  t.boot();
  const seen = [];
  t.api.onChange((which, prev) => seen.push([which, prev]));
  assert.deepEqual(seen, [['advocates', null]]);
});

check('one pane throwing does not leave the other two believing they are still up', () => {
  const t = load();
  const seen = [];
  t.api.onChange(() => {
    throw new Error('this pane is broken');
  });
  t.api.onChange((which) => seen.push(which));
  t.boot();
  t.tap('mirror');
  assert.deepEqual(seen, ['advocates', 'mirror'], 'a thrower stopped the pane behind it');
});

/* ------------------------------------------------------------------- presence */

check('presence is told which chip is up — and nothing at all on the Mirror', () => {
  const t = load();
  t.boot();
  t.tap('prs');
  t.tap('mirror');
  // `.view` off each rather than the objects themselves: they were made inside the vm,
  // so a deep-equal against host literals fails on the realm rather than on the values.
  assert.deepEqual(
    t.reports.map((r) => r.view),
    ['sessions', 'prs', null]
  );
});

check('a page served without presence.js still swaps its panes', () => {
  const t = load({ presence: false });
  t.boot();
  t.tap('prs');
  assert.deepEqual(t.shown(), ['prs']);
});

/* ------------------------------- where the strip sticks, and why it no longer does
 *
 * `.mon-tabs` was sticky at `var(--topbar-h)` and this file published that number off a
 * `ResizeObserver` on `.topbar` (bc-ugd4). The height could not be written into the
 * stylesheet because it is not one number: the bar is 104px with the space picker's row
 * and 61px without it, and the picker takes itself away below two workspaces — on the
 * same build, the same page, mid-visit, from one payload to the next.
 *
 * bc-khoe.1 removed both halves, because there is nothing left to offset. Every page is
 * a viewport-height shell: `.topbar` and `.viewbar` are rows of a flex column, this
 * strip is the row under them, and the viewport does not scroll at all. The assertion is
 * the inverse of what it was — nothing here writes a variable — because a strip in flow
 * that offsets itself by the bar's height sits a whole bar too low, and a variable
 * nobody reads is dead code that reads as a fix. public/style.css's half of the same
 * claim is in test/css.mjs.
 */

check('nothing is published for the strip to stick at, because it is in flow', () => {
  const t = load({ bar: 104 });
  assert.equal(t.vars.size, 0, `montabs.js set ${[...t.vars.keys()].join(', ')}`);
  assert.ok(!t.watching(), 'the ResizeObserver is back — the strip is a row of the shell now');
});

check('and no observer was ever created to resize', () => {
  const t = load({ bar: 104 });
  // `resize` drives the fake observer this harness hands the script; with nothing
  // observing there is nothing to fire, which is the state being asserted.
  assert.throws(() => t.resize(61), /fire/);
  assert.equal(t.vars.size, 0);
});

check('a page with no top bar, and a browser with no ResizeObserver, still get their chips', () => {
  for (const room of [{ bar: null }, { observer: false }]) {
    const t = load(room);
    assert.equal(t.vars.size, 0);
    t.boot();
    t.tap('mirror');
    assert.deepEqual(t.shown(), ['mirror']);
  }
});

console.log(failures ? `\n[31m${failures} of ${ran} failed[0m\n` : `\n[32mall ${ran} checks passed[0m\n`);
process.exit(failures ? 1 : 0);
