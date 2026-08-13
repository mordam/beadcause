#!/usr/bin/env node
/**
 * The launcher opens on what is still live, and says what it is not showing you.
 *
 *     npm test
 *     node test/dismissed.mjs
 *
 * Closing a chat session is soft: the ✕ stamps `closedAt`, the transcript stays, the id
 * keeps working, and saying anything to it brings it back. So the launcher listed the
 * closed ones too — sorted under the live ones, which is the right order and no help at
 * all after a fortnight, because every one of them is a row you already dealt with and
 * they never stop arriving. Dismissed now means hidden: the list is the live ones, and a
 * toggle beside the repo tabs gives the rest back.
 *
 * Four things about that are worth pinning, and none of them is visible from reading
 * one function:
 *
 * 1. **An empty list must say which kind of empty it is.** A repo whose conversations
 *    have all been dismissed is the exact screen this change can break: the rows leave,
 *    and the launcher reads as a repo you have never talked to — or, worse, as data
 *    loss. So the emptiness names the dismissed ones and points at the control that
 *    shows them, and that is asserted rather than assumed.
 *
 * 2. **The counts on the tabs have to mean the rows underneath them.** They counted
 *    every conversation, closed included. Left alone, a tab would say 3 over a list of
 *    nothing — the same broken screen as above, one line higher up.
 *
 * 3. **The toggle is scoped to the selected tab**, both its count and what it reveals.
 *    It is drawn from the same filtered rows the list was drawn from, so the two cannot
 *    drift; that is the property, not the arithmetic.
 *
 * 4. **Where the answer is kept.** `sessionStorage`, deliberately: tapping a dismissed
 *    row is a navigation, and coming back must not re-hide the list you were reading —
 *    while opening the app tomorrow has to start on the live ones again, or the ✕ buys
 *    you nothing. A `localStorage` write here would be a default quietly undone for
 *    good by one tap a month ago. And a browser that refuses storage (private mode, a
 *    WebView with it denied) must still draw a working launcher rather than throw.
 *
 * The real `public/console.js` runs in a vm against a hand-made document, the way
 * test/spacebar.mjs runs the real picker: a rewrite of the logic as a test-only module
 * could pass this while the phone shipped something else. What a vm cannot see is
 * whether the elements the page asks for exist at all — its document answers every
 * selector — so that half is a static read of `public/console.html`, and
 * `scripts/launcher-check.mjs` presses the real button in a real Chrome.
 *
 * No server, no `bd`, no network: the payload is handed to a stub `fetch`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

const CONSOLE_JS = read('console.js');
const CONSOLE_HTML = read('console.html');

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
    console.log(`      ${String(err.message).split('\n').slice(0, 3).join('\n      ')}`);
  }
}

/* ------------------------------------------------------------------ fixture */

const at = (n) => new Date(Date.UTC(2026, 7, 1, 10, n)).toISOString();

const conv = (id, workspace, title, closedAt = null) => ({
  id,
  agent: 'console',
  workspace,
  title,
  seed: null,
  status: 'idle',
  closedAt,
  beadCount: 0,
  created: [],
  createdAt: at(0),
  updatedAt: at(9),
});

/* Every shape a repo tab can be in, in four repos: some of each, nothing but dismissed
   ones (the tab that goes empty, and the whole reason for the empty state below),
   nothing dismissed at all, and a repo never talked to. */
const CONSOLES = [
  conv('a1', 'alpha', 'Still going'),
  conv('a2', 'alpha', 'Dealt with', at(3)),
  conv('a3', 'alpha', 'Also dealt with', at(4)),
  conv('b1', 'beta', 'The only one beta ever had', at(5)),
  conv('g1', 'gamma', 'Nothing finished here'),
];
const WORKSPACES = ['alpha', 'beta', 'gamma', 'delta'];

/* -------------------------------------------------------------------- the page */

/**
 * Enough document for `public/console.js` to boot on and draw its launcher.
 *
 * Every selector answers, which is the one thing to keep in mind reading these: a
 * missing `<button>` would not fail here. That is what the static half below is for.
 */
function load({ session = new Map(), storage = 'ok' } = {}) {
  const nodes = new Map();
  const el = (id) => {
    if (nodes.has(id)) return nodes.get(id);
    const node = {
      id,
      hidden: false,
      disabled: false,
      innerHTML: '',
      textContent: '',
      value: '',
      dataset: {},
      attrs: {},
      events: {},
      classes: new Set(),
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      addEventListener(type, fn) {
        (this.events[type] ||= []).push(fn);
      },
      fire(type, ev = {}) {
        for (const fn of this.events[type] || []) fn(ev);
      },
      focus() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: {
        add: (n) => node.classes.add(n),
        remove: (n) => node.classes.delete(n),
        contains: (n) => node.classes.has(n),
        toggle: (n, on) => (on ? node.classes.add(n) : node.classes.delete(n)),
      },
    };
    nodes.set(id, node);
    return node;
  };

  const map = (store, denied = false) => ({
    getItem: (k) => {
      if (denied) throw new Error('storage is disabled');
      return store.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (denied) throw new Error('storage is disabled');
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
  });

  const local = new Map([['beadcause.token', 'tok']]);

  /* The space picker, as much of it as this page uses: the filter, whether a repo is in
     it, and the notification when it moves. Same contract as public/spacebar.js. */
  let filter = { space: 'all', workspace: 'all' };
  const listeners = [];
  const space = {
    get filter() {
      return filter;
    },
    matches: (ws) => filter.workspace === 'all' || ws === filter.workspace,
    label: () => 'everywhere',
    spaceOf: () => 'all',
    set(next) {
      const before = JSON.stringify(filter);
      filter = { space: next.space || 'all', workspace: next.workspace || 'all' };
      if (JSON.stringify(filter) !== before) for (const fn of listeners) fn();
    },
    onChange(fn) {
      listeners.push(fn);
    },
  };

  const window = {
    beadcause: {
      space,
      // Created at module scope, before anything is drawn, so it has to be here.
      // `repaint` is the console asking a queue to draw itself again when its chat
      // comes to the front — unreachable from the launcher, and cheaper to answer here
      // than to leave as a TypeError for whoever first writes a test that opens one.
      sendQueue: { create: () => ({ attach() {}, say() {}, sync() {}, repaint() {} }) },
    },
  };

  const ctx = vm.createContext({
    window,
    document: {
      body: { classList: { add() {}, remove() {} } },
      querySelector: (sel) => (sel.startsWith('#') ? el(sel.slice(1)) : null),
      querySelectorAll: () => [],
      addEventListener() {},
      get activeElement() {
        return null;
      },
    },
    addEventListener() {},
    location: { search: '', pathname: '/console', href: '/console' },
    // Both, because the page writes the address on every switch between conversations
    // now and only the boot one replaces. Nothing here reads it back.
    history: { replaceState() {}, pushState() {} },
    localStorage: map(local),
    sessionStorage: map(session, storage === 'denied'),
    URLSearchParams,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ consoles: CONSOLES, workspaces: WORKSPACES }),
    }),
    console,
  });

  vm.runInContext(CONSOLE_JS, ctx, { filename: 'console.js' });

  const ready = async () => {
    // showLauncher() is a fetch away; a couple of turns of the loop is all it takes.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };

  return { el, session, local, space, ready, nodes };
}

/* What the launcher drew, read back off the HTML it wrote. */
const rowsIn = (html) =>
  [...html.matchAll(/<div class="console-row([^"]*)">([\s\S]*?)(?=<div class="console-row|$)/g)].map((m) => ({
    classes: m[1].trim(),
    dismissed: /class="pill[^"]*">dismissed</.test(m[2]),
    closable: /data-close="/.test(m[2]),
    title: (m[2].match(/class="work-title">([^<]*)</) || [, ''])[1],
    href: (m[2].match(/href="([^"]*)"/) || [, ''])[1],
  }));

const listed = (h) => rowsIn(h.el('recent').innerHTML);
const tabText = (h) => (h.el('ws-row').innerHTML.match(/>([^<]+)<\/button>/g) || []).map((s) => s.slice(1, -9));
const toggle = (h) => h.el('ws-dismissed');
const emptyNote = (h) => (h.el('recent').innerHTML.match(/class="empty">([\s\S]*?)<\/div>/) || [, ''])[1].replace(/<[^>]+>/g, '');

/** Tap a repo tab, the way the delegated listener on the row receives it. */
const tapTab = (h, ws) => h.el('ws-row').fire('click', { target: { closest: () => ({ dataset: { ws } }) } });

const opened = async (opts) => {
  const h = load(opts);
  await h.ready();
  return h;
};

console.log('\ndismissed conversations, and the toggle that gives them back\n');

/* --------------------------------------------------- 1. the default is the live ones */

/** Every live conversation, in every repo — what the All tab opens on. */
const LIVE = ['Still going', 'Nothing finished here'];

await check('the launcher opens on the live conversations alone', async () => {
  const h = await opened();
  assert.deepEqual(listed(h).map((r) => r.title), LIVE);
});

await check('and the dismissed ones are hidden, not merely sorted underneath', async () => {
  const h = await opened();
  assert.equal(listed(h).some((r) => r.dismissed), false, 'a dismissed row is still on the list');
});

await check('the ✕ is on the live row and not on a dismissed one', async () => {
  const h = await opened();
  tapTab(h, 'alpha');
  assert.deepEqual(listed(h).map((r) => r.closable), [true]);
  toggle(h).fire('click');
  assert.deepEqual(
    listed(h).map((r) => [r.title, r.closable]),
    [['Still going', true], ['Dealt with', false], ['Also dealt with', false]]
  );
});

/* ------------------------------------------------------- 2. the toggle, and its count */

await check('the toggle says how many are being kept back, under this tab', async () => {
  const h = await opened();
  assert.equal(toggle(h).hidden, false, 'no toggle over three dismissed conversations');
  // Three across the whole space: two in alpha and one in beta.
  assert.match(toggle(h).innerHTML, /Dismissed/);
  assert.match(toggle(h).innerHTML, /class="chip-count">3</);
  assert.equal(toggle(h).getAttribute('aria-pressed'), 'false');
  assert.match(toggle(h).getAttribute('aria-label'), /^Show 3 dismissed conversations$/);
});

await check('tapping it lists them, each marked and each still openable', async () => {
  const h = await opened();
  tapTab(h, 'alpha');
  toggle(h).fire('click');
  const rows = listed(h);
  assert.deepEqual(rows.map((r) => r.title), ['Still going', 'Dealt with', 'Also dealt with']);
  assert.deepEqual(rows.map((r) => r.dismissed), [false, true, true]);
  // Reopening is saying something to it, so the way in is the row itself.
  assert.deepEqual(rows.map((r) => r.href), ['/console?id=a1', '/console?id=a2', '/console?id=a3']);
  assert.equal(toggle(h).getAttribute('aria-pressed'), 'true');
  assert.match(toggle(h).getAttribute('aria-label'), /^Hide 2 dismissed/);
});

await check('and tapping it again puts them away', async () => {
  const h = await opened();
  toggle(h).fire('click');
  toggle(h).fire('click');
  assert.deepEqual(listed(h).map((r) => r.title), LIVE);
});

/* ------------------------------------------- 3. the counts on the tabs mean the rows */

await check('a tab counts the rows it would show, not the ones it is hiding', async () => {
  const h = await opened();
  assert.deepEqual(tabText(h), ['All 2', 'alpha 1', 'beta', 'gamma 1', 'delta']);
  toggle(h).fire('click');
  assert.deepEqual(tabText(h), ['All 5', 'alpha 3', 'beta 1', 'gamma 1', 'delta']);
});

/* --------------------------------------------------- 4. all of it is scoped to the tab */

await check('the count is of the selected repo, not of the Mac', async () => {
  const h = await opened();
  tapTab(h, 'beta');
  assert.match(toggle(h).innerHTML, /class="chip-count">1</);
  toggle(h).fire('click');
  assert.deepEqual(listed(h).map((r) => r.title), ['The only one beta ever had']);
});

await check('a repo with none of them draws no toggle at all', async () => {
  const h = await opened();
  tapTab(h, 'gamma');
  assert.equal(toggle(h).hidden, true, 'a toggle over nothing to reveal');
  assert.deepEqual(listed(h).map((r) => r.title), ['Nothing finished here']);
  // And it comes back on a tab that has some, still saying what it was asked to say.
  tapTab(h, 'alpha');
  assert.equal(toggle(h).hidden, false);
});

/* ------------------------------------- 5. an empty tab says which kind of empty it is */

await check('a repo whose conversations are all dismissed does not read as an empty one', async () => {
  const h = await opened();
  tapTab(h, 'beta');
  assert.deepEqual(listed(h), []);
  const note = emptyNote(h);
  assert.match(note, /Nothing open in beta/);
  assert.match(note, /dismissed/i, `the empty state says nothing about them: ${note}`);
  assert.doesNotMatch(note, /No conversations yet|Nothing in beta yet/, `reads as never-used: ${note}`);
  // And the way out of it is on the screen, with a count on it.
  assert.equal(toggle(h).hidden, false);
});

await check('a repo with genuinely nothing still says so, and still names ＋', async () => {
  const h = await opened();
  tapTab(h, 'delta');
  assert.deepEqual(listed(h), []);
  assert.match(emptyNote(h), /Nothing in delta yet/);
  assert.match(emptyNote(h), /＋/);
  assert.doesNotMatch(emptyNote(h), /dismissed/i, 'it offers to reveal what does not exist');
  assert.equal(toggle(h).hidden, true);
});

/* --------------------------------------------------------- 6. where the answer is kept */

await check('the choice is kept for the tab, so coming back from a row keeps it', async () => {
  const h = await opened();
  toggle(h).fire('click');
  assert.equal(h.session.get('beadcause.console.dismissed'), '1');
  // The same tab, one navigation later.
  const back = await opened({ session: h.session });
  tapTab(back, 'alpha');
  assert.deepEqual(listed(back).map((r) => r.title), ['Still going', 'Dealt with', 'Also dealt with']);
  assert.equal(toggle(back).getAttribute('aria-pressed'), 'true');
});

await check('and not beyond it: a fresh tab opens on the live ones again', async () => {
  const h = await opened();
  toggle(h).fire('click');
  assert.equal(h.local.has('beadcause.console.dismissed'), false, 'it reached localStorage');
  const fresh = await opened();
  assert.deepEqual(listed(fresh).map((r) => r.title), LIVE);
});

await check('a browser that refuses storage still draws, and the toggle still works', async () => {
  const h = await opened({ storage: 'denied' });
  assert.deepEqual(listed(h).map((r) => r.title), LIVE);
  toggle(h).fire('click');
  assert.equal(listed(h).length, CONSOLES.length, 'the toggle died with the storage');
});

/* --------------------------------------- 7. what the vm cannot see: is the button there */

await check('every element console.js reaches for is in console.html', async () => {
  // The ids the page writes into its own innerHTML are its own; everything else has to
  // be in the document it ships with, or `$()` hands back null in a real browser.
  const own = new Set([...CONSOLE_JS.matchAll(/\bid="([a-z-]+)"/g)].map((m) => m[1]));
  const asked = new Set([...CONSOLE_JS.matchAll(/\$\('#([a-z-]+)'\)/g)].map((m) => m[1]));
  const missing = [...asked].filter((id) => !own.has(id) && !CONSOLE_HTML.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `console.html has no ${missing.join(', ')}`);
});

await check('the toggle is beside the tabs, not inside the tablist', async () => {
  assert.match(CONSOLE_HTML, /id="ws-dismissed"/);
  const row = CONSOLE_HTML.indexOf('id="ws-row"');
  const rowEnd = CONSOLE_HTML.indexOf('</div>', row);
  const btn = CONSOLE_HTML.indexOf('id="ws-dismissed"');
  assert.ok(btn > rowEnd, 'a button that is not a tab must not be a child of role="tablist"');
  // And it has to be able to hide: `.chip` sets a display, which beats the UA sheet.
  assert.match(read('style.css'), /\.show-dismissed\[hidden\]\s*\{[^}]*display:\s*none/);
});

console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
