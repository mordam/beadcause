#!/usr/bin/env node
/**
 * The staleness banner — "what you are looking at is out of date", and when it is not.
 *
 *     npm test
 *     node test/freshness.mjs
 *
 * Five failures are worth a suite, and every one of them is silent by construction —
 * which is the whole problem this feature exists for. A banner that is wrong shows
 * nothing, and a screen showing nothing looks exactly like a screen that is fine.
 *
 * 1. **It must not cry wolf.** It draws over one lost minute and stays quiet through a
 *    deploy's two-second swap, a poll that answers with no events, and a phone that was
 *    in a pocket for an hour. A warning that appears on every unlock is a warning nobody
 *    reads, and then the real one is invisible too.
 *
 * 2. **A poll that answers nothing is a daemon that is alive.** The stream repaints
 *    nothing when no events land, so "the view has not changed" and "the daemon is gone"
 *    are the same picture from inside a render. `stream.js` stamps the arrival rather
 *    than the repaint, and that line is asserted against the real file.
 *
 * 3. **The two silences are different sentences.** Unreachable is ours to measure;
 *    up-but-not-sweeping is only visible because `sweptAt` rides on the payload. The
 *    first outranks the second — quoting a stale sweep age to explain staleness is
 *    quoting a number that is itself out of date.
 *
 * 4. **Retry has to reach something.** The button exists to shortcut a backoff of up to
 *    a minute; a button that does nothing in the one moment the app is broken is worse
 *    than no button. The fallback ladder is asserted: the stream, then the page's ⟳,
 *    then a reload.
 *
 * 5. **Every page with a bar has to load the file**, and the service worker's shell has
 *    to carry it. A page cached without it goes quiet about being offline precisely when
 *    it is offline.
 *
 * The client half runs the real `public/freshness.js` in a vm with a hand-made document,
 * the way test/spacebar.mjs runs the real picker — a rewrite of the logic here could pass
 * while the phone shipped something else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = (f) => path.join(ROOT, 'public', f);
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
    console.log(`      ${err.message}`);
  }
};

console.log('freshness');

/* ------------------------------------------------------------------ the harness */

/**
 * The real file, in a document made of the four things it touches.
 *
 * Time is injected rather than waited for: the thresholds are ninety seconds and eight,
 * and a suite that slept through them would take three minutes to say what a moved clock
 * says instantly. `now` is the only thing the file reads the real clock for.
 */
function mount() {
  const nodes = [];
  const make = () => {
    const node = {
      className: '',
      hidden: false,
      innerHTML: '',
      textContent: '',
      title: '',
      attrs: {},
      events: {},
      children: {},
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      addEventListener(type, fn) {
        this.events[type] = fn;
      },
      insertAdjacentElement(_where, el) {
        nodes.push(el);
      },
      querySelector(sel) {
        return (this.children[sel] ||= make());
      },
    };
    return node;
  };

  const bar = make();
  const doc = {
    hidden: false,
    events: {},
    querySelector: (sel) => (sel === '.topbar' ? bar : null),
    createElement: () => make(),
    addEventListener(type, fn) {
      this.events[type] = fn;
    },
  };

  let now = 1_000_000;
  const timers = [];
  const window = { beadcause: {} };
  const ctx = vm.createContext({
    window,
    document: doc,
    location: { reload: () => (window.__reloaded = true) },
    setInterval: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    Date: new Proxy(Date, { apply: () => new Date(now), construct: (T, args) => (args.length ? new T(...args) : new Date(now)) }),
    Number,
    Math,
    Boolean,
    JSON,
  });
  // `Date.now()` has to move with the fake clock too, and a Proxy over the constructor
  // does not cover a static. Patched in the context rather than shadowed, so the file's
  // `new Date(iso).getTime()` on a real ISO string still parses.
  vm.runInContext('Date.now = () => __now();', Object.assign(ctx, { __now: () => now }));
  vm.runInContext(read('public/freshness.js'), ctx, { filename: 'freshness.js' });

  const banner = nodes[0];
  return {
    fresh: ctx.window.beadcause.fresh,
    win: ctx.window,
    banner,
    doc,
    tick: () => timers.forEach((fn) => fn()),
    advance: (ms) => {
      now += ms;
    },
    at: () => now,
    text: () => banner.children['#stale-what']?.textContent ?? '',
    shown: () => banner.hidden === false,
    press: () => banner.children['#stale-retry']?.events?.click?.({}),
  };
}

/* --------------------------------------------------------------------- quiet */

check('a page that has just loaded says nothing', () => {
  const m = mount();
  m.tick();
  assert.equal(m.shown(), false);
});

check('and nothing through a swap, a slow minute, or a poll that carried no events', () => {
  const m = mount();
  m.advance(60_000);
  m.tick();
  assert.equal(m.shown(), false, 'a minute of quiet is not stale — the poll parks for 25s');
  // The stream stamps on the *answer*, not on a repaint. A payload with no events at all
  // is the commonest answer there is, and it is proof of life.
  m.fresh.heard({ seq: 4, events: [] });
  m.advance(80_000);
  m.tick();
  assert.equal(m.shown(), false);
});

/* -------------------------------------------------------------- the first silence */

check('past the threshold it says so, and says how long', () => {
  const m = mount();
  m.advance(95_000);
  m.tick();
  assert.equal(m.shown(), true);
  assert.match(m.text(), /out of date/i);
  assert.match(m.text(), /2m|95s|1m/, `said "${m.text()}"`);
});

check('and it says whether anything is still trying', () => {
  const m = mount();
  m.advance(95_000);
  m.fresh.trying(true);
  assert.match(m.text(), /retrying/i);
});

check('one answer clears it, whatever the answer was', () => {
  const m = mount();
  m.advance(95_000);
  m.tick();
  assert.equal(m.shown(), true);
  m.fresh.heard({});
  assert.equal(m.shown(), false, 'the daemon spoke');
  assert.ok(m.fresh.age() < 1000);
});

/* ------------------------------------------------------------ the pocket */

check('an hour in a pocket is not a stale app', () => {
  const m = mount();
  m.doc.hidden = true;
  m.advance(3_600_000);
  // Coming back is the stream restarting; the clock starts from here, not from an hour
  // ago, and the grace window is the room for its first answer to land.
  m.doc.hidden = false;
  m.doc.events.visibilitychange();
  m.tick();
  assert.equal(m.shown(), false, 'the banner must not be the first thing an unlock draws');
});

check('but a wake that hears nothing still says so, once the grace is over', () => {
  const m = mount();
  m.doc.hidden = true;
  m.advance(3_600_000);
  m.doc.hidden = false;
  m.doc.events.visibilitychange();
  m.advance(95_000);
  m.tick();
  assert.equal(m.shown(), true);
});

/* ------------------------------------------------------------ the second silence */

check('a daemon that answers but has not swept is a different sentence', () => {
  const m = mount();
  m.fresh.heard({ sweptAt: new Date(m.at() - 20 * 60_000).toISOString(), sweepEverySeconds: 30 });
  m.tick();
  assert.equal(m.shown(), true);
  assert.match(m.text(), /has not read the tracker/i);
  assert.doesNotMatch(m.text(), /nothing from the daemon/i);
});

check('a sweep that is merely a cycle or two late is not worth a banner', () => {
  const m = mount();
  m.fresh.heard({ sweptAt: new Date(m.at() - 60_000).toISOString(), sweepEverySeconds: 30 });
  m.tick();
  assert.equal(m.shown(), false);
});

check('and a daemon that has never swept is starting up, not broken', () => {
  const m = mount();
  m.fresh.heard({ sweptAt: null, sweepEverySeconds: 30 });
  m.tick();
  assert.equal(m.shown(), false);
});

check('our own silence outranks its sweep age', () => {
  const m = mount();
  m.fresh.heard({ sweptAt: new Date(m.at() - 20 * 60_000).toISOString(), sweepEverySeconds: 30 });
  m.advance(95_000);
  m.tick();
  assert.match(m.text(), /nothing from the daemon/i, 'a stale sweep age cannot explain a silence');
});

/* ------------------------------------------------------------------ retry */

check('Retry now wakes the stream when there is one', () => {
  const m = mount();
  let woke = 0;
  m.win.beadcause.stream = { wake: () => (woke += 1) };
  m.advance(95_000);
  m.tick();
  m.press();
  assert.equal(woke, 1);
  assert.ok(!m.win.__reloaded, 'and does not reload over the top of it');
});

check('and falls back to a reload when the page has neither a stream nor a ⟳', () => {
  const m = mount();
  m.advance(95_000);
  m.tick();
  m.press();
  assert.equal(m.win.__reloaded, true, 'the button must never be one that does nothing');
});

/* ------------------------------------------------------------------ the wiring */

check('the stream stamps every answer, not every repaint', () => {
  const src = read('public/stream.js');
  const at = src.indexOf('window.beadcause?.fresh?.heard?.(data)');
  assert.ok(at > 0, 'stream.js no longer reports that it heard anything');
  // Above the `told` test, which is what decides whether the loop keeps following: a
  // stamp below it would skip exactly the daemon that answers without a sequence.
  assert.ok(at < src.indexOf('const told ='), 'the stamp has moved below the sequence test');
  assert.ok(src.includes('window.beadcause?.fresh?.trying?.(true)'), 'a backoff no longer says it is retrying');
  assert.ok(/wake\s*\(\)/.test(src) && src.includes('mounted.add'), 'nothing can wake a parked stream any more');
});

check('every page with a top bar loads it', () => {
  const pages = fs
    .readdirSync(path.join(ROOT, 'public'))
    .filter((f) => f.endsWith('.html'))
    .filter((f) => read(`public/${f}`).includes('class="topbar"'));
  assert.ok(pages.length >= 8, `only found ${pages.length} pages with a bar`);
  const missing = pages.filter((f) => !read(`public/${f}`).includes('/freshness.js'));
  assert.deepEqual(missing, []);
});

check('and the service worker caches it, because offline is what it is for', () => {
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/freshness.js'"), 'not in SHELL');
});

check('the daemon puts its own sweep age on the payload', () => {
  const server = read('lib/server.js');
  assert.ok(/sweptAt = new Date\(\)\.toISOString\(\)/.test(server), 'nothing stamps the sweep');
  assert.ok(/^\s+sweptAt,$/m.test(server), 'the inbox payload does not carry it');
  assert.ok(server.includes('sweepEverySeconds'), 'and nothing says how often it meant to sweep');
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `${ran} passed`}`);
process.exit(failures ? 1 : 0);
