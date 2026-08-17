#!/usr/bin/env node
/**
 * The beads orbiting the brand dot — what turns them on, and the four things that must
 * not.
 *
 *     npm test
 *     node test/orbit.mjs
 *
 * The picture itself is a browser's problem and `scripts/orbit-check.mjs` is where it is
 * proved: that a bead really passes behind the dot and in front of it, in a Chrome, with
 * the real stylesheet. What is left over is everything a stub can answer, and all of it
 * is about *when* the ring is on screen rather than what it looks like.
 *
 * Both real files run in a vm with a hand-made `window` and `document`, the way
 * test/reporter.mjs and test/dictate.mjs load the modules they cover — a rewrite of this
 * logic as a test-only copy could not pass while the phone shipped something else.
 *
 * The four false positives, each of which would be a spinner that lies:
 *
 * 1. **The long poll.** public/stream.js parks on `/api/poll` for twenty-five seconds by
 *    design. Counted, every standing view in the app is permanently loading.
 * 2. **The presence heartbeat.** Somebody else's thumb on a timer, not this screen.
 * 3. **A request that was never slow.** Every cached view answers in single figures, and
 *    a ring that flashed for one frame of every tap is noise the eye reads as a glitch.
 * 4. **A count that went negative.** A settle counted twice leaves the number below zero
 *    for the life of the page, which is a ring that never stops.
 *
 * And the two wiring facts a stub cannot see, read off disk: every page with a brand dot
 * loads the file, and the old `.dot.busy` ring pulse is gone from the stylesheet while
 * `@keyframes pulse` — which the deploy lamp also uses — is not.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = (f) => path.join(ROOT, 'public', f);
const REPORT = fs.readFileSync(PUBLIC('report.js'), 'utf8');
const ORBIT = fs.readFileSync(PUBLIC('orbit.js'), 'utf8');
const CSS = fs.readFileSync(PUBLIC('style.css'), 'utf8');
/**
 * The stylesheet with its comments blanked, same length so nothing else shifts.
 *
 * Every structural assertion below reads this rather than the source, because the source
 * argues with itself in prose: the `.dot` block's own comment says why it must not carry
 * a `z-index`, and a check reading the raw text finds those two words inside it and calls
 * the rule broken. That is not hypothetical — it is what this file did first.
 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/* --------------------------------------------------------------------- harness */

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

/** Just enough element for two files that build spans and toggle a class on one. */
function makeEl(tag, className = '') {
  const el = {
    tagName: tag,
    className,
    children: [],
    attrs: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    setAttribute(k, v) {
      el.attrs[k] = v;
    },
    classList: {
      contains: (n) => el.className.split(/\s+/).includes(n),
      add(n) {
        if (!this.contains(n)) el.className = `${el.className} ${n}`.trim();
      },
      remove(n) {
        el.className = el.className.split(/\s+/).filter((c) => c && c !== n).join(' ');
      },
      toggle(n, on) {
        if (on) this.add(n);
        else this.remove(n);
      },
    },
    /** Only ever asked for `.orbit`, and only to decide whether this dot already has one. */
    querySelector(sel) {
      const want = sel.replace(/^\./, '');
      return el.children.find((c) => c.className.split(/\s+/).includes(want)) || null;
    },
    /** Every descendant matching a single class — enough to count beads and layers. */
    all(cls) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.className.split(/\s+/).includes(cls)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
  };
  return el;
}

/**
 * Both real files, in a room with two brand dots in it.
 *
 * Timers are ours, so "after 140ms" is an assertion rather than a sleep — a suite that
 * waited on the real clock for a debounce would be the slowest and flakiest file here.
 */
function load({ dots = 2 } = {}) {
  const found = Array.from({ length: dots }, () => makeEl('span', 'dot'));
  let now = 1_000_000;
  const timers = new Map();
  let nextTimer = 0;
  const responders = new Map();

  const document = {
    readyState: 'complete',
    querySelectorAll: (sel) => (sel === '.brand .dot' ? found : []),
    createElement: (tag) => makeEl(tag),
    addEventListener: () => {},
  };
  const window = {
    location: { href: 'http://127.0.0.1:4317/', pathname: '/', origin: 'http://127.0.0.1:4317' },
    navigator: { userAgent: 'test-agent/1' },
    localStorage: { getItem: () => null },
    addEventListener: () => {},
    document,
    /** Answers with whatever the test parked on that path, and never resolves otherwise. */
    fetch: (input) => {
      const p = String(input).split('?')[0];
      return new Promise((resolve, reject) => responders.set(p, { resolve, reject }));
    },
  };
  const ctx = vm.createContext({
    window,
    document,
    URL,
    console,
    Date: { now: () => now },
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + (ms || 0), fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(REPORT, ctx, { filename: 'report.js' });
  vm.runInContext(ORBIT, ctx, { filename: 'orbit.js' });

  /** Move the clock and run whatever came due, in order. */
  const tick = async (ms) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await Promise.resolve();
    }
    now = until;
    await Promise.resolve();
  };

  return {
    ctx,
    window,
    dots: found,
    requests: ctx.window.beadcause.requests,
    orbit: ctx.window.beadcause.orbit,
    answer: async (url, res = { status: 200, ok: true }) => {
      responders.get(url)?.resolve(res);
      responders.delete(url);
      await Promise.resolve();
      await Promise.resolve();
    },
    reject: async (url, err = new Error('Failed to fetch')) => {
      responders.get(url)?.reject(err);
      responders.delete(url);
      await Promise.resolve();
      await Promise.resolve();
    },
    tick,
    lit: () => found.map((d) => d.className),
  };
}

/* ------------------------------------------------------------------ the count */

console.log('\nwhat the page is waiting on');

await check('a request in flight is one, and settling it is none again', async () => {
  const app = load();
  const p = app.ctx.window.fetch('/api/questions');
  assert.equal(app.requests.inFlight(), 1);
  await app.answer('/api/questions');
  await p;
  assert.equal(app.requests.inFlight(), 0);
});

await check('a failed request settles too — a broken link is not a permanent spinner', async () => {
  const app = load();
  const p = app.ctx.window.fetch('/api/questions').catch(() => 'caught');
  assert.equal(app.requests.inFlight(), 1);
  await app.reject('/api/questions');
  assert.equal(await p, 'caught');
  assert.equal(app.requests.inFlight(), 0);
});

await check('the long poll is not a request this screen is waiting on', async () => {
  const app = load();
  app.ctx.window.fetch('/api/poll?since=4&wait=25');
  assert.equal(app.requests.inFlight(), 0, 'a parked poll reads as a permanent load');
});

await check('and neither is the presence heartbeat', async () => {
  const app = load();
  app.ctx.window.fetch('/api/presence');
  assert.equal(app.requests.inFlight(), 0);
});

await check('nor the reporter reporting', async () => {
  const app = load();
  app.ctx.window.fetch('/api/error', { method: 'POST', body: '{}' });
  assert.equal(app.requests.inFlight(), 0);
});

await check('a subscriber hears the number as it already stands', async () => {
  const app = load();
  app.ctx.window.fetch('/api/questions');
  const heard = [];
  app.requests.onChange((n) => heard.push(n));
  assert.deepEqual(heard, [1], 'a listener that mounted mid-load heard nothing until the next one');
});

await check('only the edges are published', async () => {
  const app = load();
  const heard = [];
  app.requests.onChange((n) => heard.push(n));
  app.ctx.window.fetch('/api/a');
  app.ctx.window.fetch('/api/b');
  app.ctx.window.fetch('/api/c');
  await app.answer('/api/a');
  await app.answer('/api/b');
  await app.answer('/api/c');
  assert.deepEqual(heard, [0, 1, 0], `every step woke a watcher: ${heard.join(',')}`);
});

await check('the wrapper is still transparent — same response, same rejection', async () => {
  const app = load();
  const res = { status: 200, ok: true, mine: true };
  const p = app.ctx.window.fetch('/api/questions');
  await app.answer('/api/questions', res);
  assert.equal(await p, res, 'the response object was replaced');
  const q = app.ctx.window.fetch('/api/other');
  const boom = new Error('Failed to fetch');
  const caught = q.then(() => null, (e) => e);
  await app.reject('/api/other', boom);
  assert.equal(await caught, boom, 'the rejection was replaced');
});

/* ------------------------------------------------------------------ the orbit */

console.log('\nwhen the orbit turns');

await check('two layers of seven beads, once, under every brand dot', async () => {
  const app = load({ dots: 3 });
  for (const dot of app.dots) {
    assert.equal(dot.all('orbit').length, 2, 'a near half and a far half');
    assert.equal(dot.all('orbit-bead').length, 14, 'seven beads in each');
    assert.equal(dot.all('orbit-string').length, 2, 'and the string they are on, per half');
  }
  const near = app.dots[0].all('orbit').find((l) => l.className.includes('near'));
  assert.deepEqual(
    near.children.filter((c) => c.className === 'orbit-bead').map((b) => b.style.props['--i']),
    ['0', '1', '2', '3', '4', '5', '6'],
    'each bead has to start a seventh of a turn further round'
  );
  assert.equal(near.attrs['aria-hidden'], 'true', 'seven empty spans read out on every page');
});

await check('nothing is on screen before anything is fetched', async () => {
  const app = load();
  assert.equal(app.orbit.running(), false);
  assert.deepEqual(app.lit(), ['dot', 'dot']);
});

await check('a request that answers quickly never shows a ring at all', async () => {
  const app = load();
  app.ctx.window.fetch('/api/questions');
  await app.tick(60);
  await app.answer('/api/questions');
  await app.tick(400);
  assert.equal(app.orbit.running(), false, 'a 60ms request drew a spinner');
});

await check('a slow one shows it, on every dot, after the debounce and not before', async () => {
  const app = load();
  app.ctx.window.fetch('/api/questions');
  await app.tick(100);
  assert.equal(app.orbit.running(), false, 'up before the debounce had run');
  await app.tick(60);
  assert.equal(app.orbit.running(), true);
  assert.deepEqual(app.lit(), ['dot loading', 'dot loading']);
});

await check('it says `loading`, never `busy` — the class ten page scripts toggle themselves', async () => {
  const app = load();
  app.dots[0].classList.add('busy');
  app.ctx.window.fetch('/api/questions');
  await app.tick(200);
  await app.answer('/api/questions');
  await app.tick(2000);
  assert.equal(app.orbit.running(), false);
  assert.equal(app.dots[0].className, 'dot busy', 'the page’s own reason was switched off with ours');
});

await check('once up it stays long enough to be read, however fast the answer then comes', async () => {
  const app = load();
  app.ctx.window.fetch('/api/questions');
  await app.tick(160);
  assert.equal(app.orbit.running(), true);
  await app.answer('/api/questions');
  await app.tick(100);
  assert.equal(app.orbit.running(), true, 'gone after a tenth of a revolution');
  await app.tick(600);
  assert.equal(app.orbit.running(), false);
});

await check('a second request starting mid-wind-down keeps it up', async () => {
  const app = load();
  app.ctx.window.fetch('/api/a');
  await app.tick(160);
  await app.answer('/api/a');
  app.ctx.window.fetch('/api/b');
  await app.tick(900);
  assert.equal(app.orbit.running(), true, 'the ring stopped while the app was still fetching');
});

await check('a page with no brand row draws nothing and throws nothing', async () => {
  const app = load({ dots: 0 });
  app.ctx.window.fetch('/api/questions');
  await app.tick(500);
  assert.equal(app.orbit.running(), false);
});

await check('a settle counted twice cannot take the count below zero', async () => {
  const app = load();
  const p = app.ctx.window.fetch('/api/questions');
  await app.answer('/api/questions');
  await p;
  await app.answer('/api/questions'); // nothing left to resolve; the guard is the point
  assert.equal(app.requests.inFlight(), 0);
  app.ctx.window.fetch('/api/other');
  assert.equal(app.requests.inFlight(), 1, 'the next request could not lift it off the floor');
});

/* ------------------------------------------------------------------- the wiring */

console.log('\nthe wiring, on disk');

const PAGES = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html')).sort();

await check('every page with a brand dot loads the orbit, and after the reporter', () => {
  let withDot = 0;
  for (const page of PAGES) {
    const html = fs.readFileSync(PUBLIC(page), 'utf8');
    if (!/<span class="dot"/.test(html)) {
      assert.ok(!html.includes('/orbit.js'), `${page} has no dot to draw an orbit on`);
      continue;
    }
    withDot += 1;
    const mine = html.indexOf('<script src="/orbit.js">');
    assert.ok(mine > 0, `${page} draws a brand dot and never loads /orbit.js`);
    const reporter = html.indexOf('<script src="/report.js">');
    assert.ok(reporter > 0 && reporter < mine, `${page} loads the orbit before the count it reads`);
  }
  assert.ok(withDot >= 14, `only ${withDot} pages carry a brand dot`);
});

await check('the ring pulse the dot used to do is gone', () => {
  assert.doesNotMatch(BARE, /^\.dot\.busy \{[^}]*animation:/m, 'the old outward pulse is still on the dot');
  assert.match(BARE, /\.dot\.busy \.orbit, \.dot\.loading \.orbit \{/, 'neither reason draws the orbit');
});

await check('but the keyframes it shared with the deploy lamp are not', () => {
  assert.match(BARE, /@keyframes pulse \{/, 'the live-deploy dot lost its animation with it');
  assert.match(BARE, /\.deploy\.live \.deploy-dot \{[^}]*animation: pulse/, 'nothing is left using it');
});

await check('the far half is behind the dot and the near half in front', () => {
  const far = BARE.match(/\.orbit\.far \{([^}]*)\}/);
  const near = BARE.match(/\.orbit\.near \{([^}]*)\}/);
  assert.ok(far && near, 'one of the two halves is gone');
  assert.match(far[1], /z-index: -1/);
  assert.match(near[1], /z-index: 1/);
  // Complementary clips: what one draws, the other does not. A pair that overlapped
  // would draw a crossing bead twice, and a pair with a gap would drop it.
  assert.match(far[1], /clip-path: inset\(0 0 50% 0\)/);
  assert.match(near[1], /clip-path: inset\(50% 0 0 0\)/);
});

await check('the dot is what the orbit hangs off, and it establishes no stacking context', () => {
  const dot = BARE.match(/\n\.dot \{([^}]*)\}/);
  assert.ok(dot, '.dot is not declared');
  assert.match(dot[1], /position: relative/, 'the layers have nothing to be absolute against');
  assert.doesNotMatch(dot[1], /z-index:/, 'a z-index here traps the far half in front of the dot');
});

await check('and it cannot swallow a tap meant for the app menu beside it', () => {
  assert.match(BARE, /\.orbit \{[^}]*pointer-events: none/s);
});

await check('under reduced motion the beads are placed and still', () => {
  const at = BARE.indexOf('@keyframes orbit-run');
  const rule = BARE.slice(at).match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.orbit-bead \{([^}]*)\}/);
  assert.ok(rule, 'nothing answers the preference');
  assert.match(rule[1], /animation-play-state: paused/);
  // `animation: none` would leave all seven piled on the centre of the dot, because the
  // keyframes are what place them.
  assert.doesNotMatch(rule[1], /animation: none/);
});

/* ------------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
