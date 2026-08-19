#!/usr/bin/env node
/**
 * A handle per chat you have open, and All on the left that cannot be closed.
 *
 *     npm test
 *     node test/chattabs.mjs
 *
 * `/console` holds several conversations at once (bc-dmt) and the only surface you
 * could switch from was the launcher list — so going from one chat to another meant
 * coming back out to a list of *every* conversation in the repo, finding the row again,
 * and tapping it, on a list that reorders itself as turns land. The strip is the short
 * list: the ones you personally opened, in the order you opened them.
 *
 * Five things about it are worth pinning, and none of them is visible from reading one
 * function:
 *
 * 1. **The ✕ on a handle is not the ✕ on a row.** They are two characters apart on the
 *    same screen and they mean opposite things: the row's is a soft close that stamps
 *    `closedAt` on the server, the handle's is a strip that touches nothing. If the
 *    handle ever POSTs, a gesture meaning "I have enough tabs open" starts dismissing
 *    conversations — so what is asserted here is the *absence* of the request.
 * 2. **All cannot be closed and always goes back.** It is the way out of a conversation;
 *    a strip you can strand yourself in is worse than no strip at all.
 * 3. **The handles survive the app being closed**, which is what makes them tabs rather
 *    than a session's scratch state — and they are scoped by repo, so switching the
 *    picker shows that repo's. With one exception, which is the interesting half: the
 *    chat *in front* keeps its handle whatever the filter says, or the strip loses the
 *    tab that is selected on it.
 * 4. **Only `{id, ws}` reaches the disk.** That began as a privacy rule — `public/warm.js`
 *    was `sessionStorage` so bead text did not sit on the phone overnight, and a chat
 *    title is bead text — and it survives that layer going durable (bc-1kwl.14) on its
 *    second reason: a stored title is a title that can be *wrong*, and a strip drawing
 *    last week's name for a renamed chat is worse than one drawing the repo. A handle
 *    restored tomorrow draws its repo until the list comes back.
 * 5. **A handle says what its chat is doing** — the spark for a running turn, the bead
 *    count for a proposal nobody has read — because the whole point of holding four
 *    open is not having to visit them to find out.
 *
 * The real `public/console.js` runs in a vm against a hand-made document, the way
 * test/dismissed.mjs runs the same page's launcher: a rewrite of the logic as a
 * test-only module could pass this while the phone shipped something else. What a vm
 * cannot see is layout, or whether the elements exist at all — its document answers
 * every selector — so that half is a static read of `public/console.html` plus
 * `scripts/tabs-check.mjs`, which presses the real handles in a real Chrome.
 *
 * No server, no `bd`, no network: every payload is handed to a stub `fetch`.
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
const STYLE_CSS = read('style.css');

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

/* ------------------------------------------------------------------ fixture */

const at = (n) => new Date(Date.UTC(2026, 7, 1, 10, n)).toISOString();

/** Every shape a handle can be in: idle, mid-turn, holding a proposal, in another repo. */
const CHATS = {
  a1: { workspace: 'alpha', title: 'The installer never checks for iTerm2', status: 'idle', beadCount: 0 },
  a2: { workspace: 'alpha', title: 'Something still running', status: 'thinking', beadCount: 0 },
  b1: { workspace: 'beta', title: 'Over in the other repo', status: 'idle', beadCount: 3 },
};
const WORKSPACES = ['alpha', 'beta'];

const row = (id) => ({
  id,
  agent: 'console',
  workspace: CHATS[id].workspace,
  title: CHATS[id].title,
  seed: null,
  status: CHATS[id].status,
  closedAt: null,
  messageCount: 1,
  beadCount: CHATS[id].beadCount,
  created: [],
  createdAt: at(0),
  updatedAt: at(9),
});

const transcript = (id) => ({
  ...row(id),
  seq: 1,
  error: null,
  draft: CHATS[id].beadCount
    ? { beads: Array.from({ length: CHATS[id].beadCount }, (_, i) => ({ ref: `r${i}`, title: `Bead ${i}`, type: 'task', priority: 2 })) }
    : null,
  messages: [{ role: 'user', text: `Said in ${id}`, at: at(0) }],
});

/* -------------------------------------------------------------------- the page */

/**
 * Enough document for `public/console.js` to boot on, open a chat, and draw its strip.
 *
 * Every selector answers, which is the thing to keep in mind reading these: a missing
 * `<nav>` would not fail here. That is what the static half at the bottom is for.
 */
function load({ local = new Map(), search = '', storage = 'ok', workspace = 'all' } = {}) {
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
      style: {},
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

  local.set('beadcause.token', 'tok');

  /* The space picker, as much of it as this page uses. Same contract as spacebar.js. */
  let filter = { space: 'all', workspace };
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
      sendQueue: { create: () => ({ attach() {}, say() {}, sync() {}, repaint() {} }) },
    },
    // Only reached by an assistant message, and this fixture says nothing back — but a
    // ReferenceError here would read as the strip being broken.
    marked: { parse: (s) => s },
    DOMPurify: { sanitize: (s) => s },
  };

  /** Every request the page made, so "did the ✕ POST" is answerable. */
  const calls = [];
  const url = { search };

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
    location: { get search() { return url.search; }, pathname: '/console', href: '/console' },
    history: {
      replaceState(_a, _b, href) {
        url.search = href.includes('?') ? href.slice(href.indexOf('?')) : '';
      },
      pushState(_a, _b, href) {
        url.search = href.includes('?') ? href.slice(href.indexOf('?')) : '';
      },
    },
    localStorage: map(local),
    sessionStorage: map(new Map(), storage === 'denied'),
    URLSearchParams,
    URL,
    setTimeout,
    clearTimeout,
    // The transcript poll builds one, and it is inside the try that would otherwise
    // swallow the failure and retry for the length of the run.
    AbortController,
    // `adopt` takes its own copy of a server draft, so a chat carrying a proposal
    // cannot be loaded without this — and the failure reads as "not found".
    structuredClone,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    fetch: async (p, opts = {}) => {
      calls.push(`${opts.method || 'GET'} ${p}`);
      const answer = (body) => ({ ok: true, status: 200, json: async () => body });
      if (p.startsWith('/api/consoles')) return answer({ consoles: Object.keys(CHATS).map(row), workspaces: WORKSPACES });
      // Never answered: this fixture never changes, and a resolved poll would spin the
      // loop for the length of the run.
      if (p.startsWith('/api/console/poll')) return new Promise(() => {});
      if (p.startsWith('/api/console?id=')) {
        const id = new URLSearchParams(p.slice(p.indexOf('?'))).get('id');
        return CHATS[id] ? answer(transcript(id)) : { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      }
      return answer({});
    },
    console,
  });

  vm.runInContext(CONSOLE_JS, ctx, { filename: 'console.js' });

  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };

  return { el, local, space, settle, calls, url };
}

/* ------------------------------------------------- reading the strip back off its HTML */

/** The handles, in order, as the strip wrote them. */
const handles = (h) =>
  h
    .el('chat-tabs')
    .innerHTML.split('<span class="chat-tab')
    .slice(1)
    .map((chunk) => ({ classes: chunk.slice(0, chunk.indexOf('>')), body: chunk }))
    .map((t) => ({
      all: t.classes.includes('chat-tab-all'),
      id: (t.body.match(/data-tab="([^"]*)"/) || [, ''])[1],
      name: (t.body.match(/class="tab-name">([^<]*)</) || [, 'All'])[1],
      selected: /aria-selected="true"/.test(t.body),
      closable: /data-untab="/.test(t.body),
      spark: /class="spark"/.test(t.body),
      beads: (t.body.match(/class="tab-beads">🧾(\d+)</) || [, ''])[1],
    }));

const stripUp = (h) => !h.el('chat-tabs').hidden;
const stored = (h) => JSON.parse(h.local.get('beadcause.console.tabs') || 'null');

/** A click on the strip, delivered to both of its delegated listeners the way a DOM does. */
function tapStrip(h, { tab, untab } = {}) {
  const ev = {
    button: 0,
    defaultPrevented: false,
    preventDefault() {
      ev.defaultPrevented = true;
    },
    // Both listeners sit on `#chat-tabs` itself, so this stops neither of them — which
    // is exactly the trap this mirrors rather than papers over.
    stopPropagation() {},
    target: {
      closest: (sel) => {
        if (sel === '[data-untab]') return untab == null ? null : { dataset: { untab } };
        // The ✕ is a sibling of the link, not a child, so a tap on it never finds one.
        if (sel === '[data-tab]') return untab != null || tab == null ? null : { dataset: { tab } };
        return null;
      },
    },
  };
  h.el('chat-tabs').fire('click', ev);
}

const tapRow = (h, id) =>
  h.el('recent').fire('click', {
    button: 0,
    defaultPrevented: false,
    preventDefault() {},
    target: { closest: (sel) => (sel === 'a.work-row[data-id]' ? { dataset: { id } } : null) },
  });

const opened = async (opts) => {
  const h = load(opts);
  await h.settle();
  return h;
};

console.log('\na handle per open chat, and the All that cannot be closed\n');

/* ------------------------------------------------- 1. nothing open, nothing on screen */

await check('the launcher opens with no strip at all — All on its own says nothing', async () => {
  const h = await opened();
  assert.equal(stripUp(h), false, 'a row holding one permanent tab is 40px of a phone spent on nothing');
});

/* ------------------------------------------------------- 2. opening one adds a handle */

await check('opening a chat from the list adds its handle and brings it to the front', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  assert.equal(stripUp(h), true);
  const t = handles(h);
  assert.deepEqual(t.map((x) => x.name), ['All', CHATS.a1.title]);
  assert.equal(t[0].all, true);
  assert.equal(t[1].selected, true, 'the chat that was opened is not the selected handle');
  assert.equal(t[0].selected, false);
});

await check('All carries no ✕, and every other handle does', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  const t = handles(h);
  assert.equal(t[0].closable, false, 'the way out of a conversation can be closed');
  assert.equal(t[1].closable, true);
});

await check('a second chat gets a second handle, and the first stays on the strip', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  tapStrip(h, { tab: '' });
  await h.settle();
  tapRow(h, 'b1');
  await h.settle();
  const t = handles(h);
  assert.deepEqual(t.map((x) => x.id), ['', 'a1', 'b1']);
  assert.deepEqual(t.map((x) => x.selected), [false, false, true]);
});

await check('tapping All goes back to the list without closing anything', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  tapStrip(h, { tab: '' });
  await h.settle();
  assert.equal(h.el('launcher').hidden, false, 'All did not come back out to the list');
  const t = handles(h);
  assert.equal(t[0].selected, true);
  assert.deepEqual(t.map((x) => x.id), ['', 'a1'], 'leaving a chat took its handle with it');
});

await check('and a handle switches straight back, without fetching the transcript twice', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  tapStrip(h, { tab: '' });
  await h.settle();
  const before = h.calls.filter((c) => c.includes('/api/console?id=a1')).length;
  tapStrip(h, { tab: 'a1' });
  await h.settle();
  assert.equal(handles(h)[1].selected, true);
  assert.equal(h.calls.filter((c) => c.includes('/api/console?id=a1')).length, before, 'the switch went to the network');
});

/* ---------------------------------------- 3. the ✕ on a handle is not the ✕ on a row */

await check('the ✕ on a handle takes the handle off and asks the server for nothing', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  tapStrip(h, { tab: '' });
  await h.settle();
  tapRow(h, 'b1');
  await h.settle();
  const before = h.calls.length;
  tapStrip(h, { untab: 'a1' });
  await h.settle();
  assert.deepEqual(handles(h).map((x) => x.id), ['', 'b1']);
  assert.deepEqual(
    h.calls.slice(before).filter((c) => c.includes('/close')),
    [],
    'closing a tab dismissed the conversation — those are opposite gestures'
  );
});

await check('the chat is still in the list, exactly as it was, and reopening re-adds the handle', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  tapStrip(h, { untab: 'a1' });
  await h.settle();
  assert.match(h.el('recent').innerHTML, /The installer never checks/, 'the row left the list with the tab');
  tapRow(h, 'a1');
  await h.settle();
  assert.deepEqual(handles(h).map((x) => x.id), ['', 'a1']);
});

await check('closing the handle in front falls to its neighbour, not out to the list', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  tapStrip(h, { tab: '' });
  await h.settle();
  tapRow(h, 'b1');
  await h.settle();
  tapStrip(h, { untab: 'b1' });
  await h.settle();
  const t = handles(h);
  assert.deepEqual(t.map((x) => x.id), ['', 'a1']);
  assert.equal(t[1].selected, true, 'closing the last handle should land on the one beside it');
  assert.equal(h.el('launcher').hidden, true);
});

await check('closing the only handle there is lands on All', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  tapStrip(h, { untab: 'a1' });
  await h.settle();
  assert.equal(h.el('launcher').hidden, false);
  assert.equal(stripUp(h), false, 'the strip is back to All alone, which is no strip');
});

/* ------------------------------------------------------- 4. they survive the app closing */

await check('the handles are written to localStorage, as ids and repos and nothing else', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  tapStrip(h, { tab: '' });
  await h.settle();
  tapRow(h, 'b1');
  await h.settle();
  assert.deepEqual(stored(h), [
    { id: 'a1', ws: 'alpha' },
    { id: 'b1', ws: 'beta' },
  ]);
  const raw = h.local.get('beadcause.console.tabs');
  assert.ok(!raw.includes('installer'), 'a chat title reached the disk — a stored title is one that can go stale');
});

await check('and a second visit opens with them back, in the order they were opened', async () => {
  const local = new Map();
  const first = await opened({ local });
  tapRow(first, 'b1');
  await first.settle();
  first.el('recent').innerHTML = '';
  const again = await opened({ local });
  const t = handles(again);
  assert.deepEqual(t.map((x) => x.id), ['', 'b1']);
  assert.equal(t[0].selected, true, 'a reload of the launcher should still be on All');
  assert.equal(t[1].name, CHATS.b1.title, 'the restored handle never learned its title from the list');
});

await check('a handle restored before any list has come back draws its repo, not an id', async () => {
  const local = new Map([['beadcause.console.tabs', JSON.stringify([{ id: 'b1', ws: 'beta' }])]]);
  const h = load({ local });
  // Deliberately not settled: this is the first paint, before `/api/consoles` answers.
  const t = handles(h);
  assert.deepEqual(t.map((x) => x.name), ['All', 'beta']);
});

await check('a handle stored by something else, or by nothing, is not a broken page', async () => {
  for (const junk of ['nonsense', '{}', '[1,2,3]', '[{"nope":1}]']) {
    const h = await opened({ local: new Map([['beadcause.console.tabs', junk]]) });
    // All is drawn whether or not the strip is on screen; what must not survive is a
    // handle made out of nothing.
    assert.deepEqual(handles(h).map((x) => x.id), [''], `${junk} drew handles`);
    assert.equal(stripUp(h), false, `${junk} put the strip up`);
  }
});

await check('a browser that refuses storage still opens chats and still draws the strip', async () => {
  const h = await opened({ storage: 'denied' });
  tapRow(h, 'a1');
  await h.settle();
  assert.deepEqual(handles(h).map((x) => x.id), ['', 'a1']);
});

/* --------------------------------------------------------------- 5. scoped by repo */

await check('the strip shows the selected repo, and the picker moving changes it', async () => {
  const h = await opened();
  tapRow(h, 'a1');
  await h.settle();
  tapStrip(h, { tab: '' });
  await h.settle();
  tapRow(h, 'b1');
  await h.settle();
  tapStrip(h, { tab: '' });
  await h.settle();
  assert.deepEqual(handles(h).map((x) => x.id), ['', 'a1', 'b1'], 'All in the picker means both repos');
  h.space.set({ space: 'all', workspace: 'alpha' });
  assert.deepEqual(handles(h).map((x) => x.id), ['', 'a1'], 'beta`s handle is still on an alpha strip');
  h.space.set({ space: 'all', workspace: 'beta' });
  assert.deepEqual(handles(h).map((x) => x.id), ['', 'b1']);
});

await check('but the chat in front keeps its handle whatever the filter says', async () => {
  const h = await opened();
  tapRow(h, 'b1');
  await h.settle();
  h.space.set({ space: 'all', workspace: 'alpha' });
  const t = handles(h);
  assert.deepEqual(t.map((x) => x.id), ['', 'b1'], 'the filter took away the tab that is selected');
  assert.equal(t[1].selected, true);
});

await check('a handle opened by id alone learns its repo and keeps it', async () => {
  const local = new Map();
  const h = load({ local, search: '?id=b1' });
  await h.settle();
  assert.deepEqual(
    stored(h),
    [{ id: 'b1', ws: 'beta' }],
    `the repo of a chat opened from a link was never learned: ${JSON.stringify(stored(h))}`
  );
});

/* -------------------------------------------------- 6. a handle says what its chat is doing */

await check('a chat mid-turn in the background shows its spark on the handle', async () => {
  const h = await opened();
  tapRow(h, 'a2');
  await h.settle();
  tapStrip(h, { tab: '' });
  await h.settle();
  tapRow(h, 'a1');
  await h.settle();
  const t = handles(h);
  assert.equal(t.find((x) => x.id === 'a2').spark, true, 'a running turn behind you is invisible');
  assert.equal(t.find((x) => x.id === 'a1').spark, false);
});

await check('a chat holding a proposal shows how many beads are in it', async () => {
  const h = await opened();
  tapRow(h, 'b1');
  await h.settle();
  assert.equal(handles(h).find((x) => x.id === 'b1').beads, '3');
});

await check('the background is asked after as soon as a restored handle exists, not only a loaded one', async () => {
  // One chat in front and one handle that has never been fetched: the count that used
  // to gate this feed was of loaded chats, which is nought behind.
  const local = new Map([['beadcause.console.tabs', JSON.stringify([{ id: 'a2', ws: 'alpha' }])]]);
  const h = load({ local, search: '?id=a1' });
  await h.settle();
  assert.ok(
    h.calls.some((c) => c.includes('/api/consoles')),
    'nothing asked what the other handle is doing'
  );
  assert.equal(handles(h).find((x) => x.id === 'a2').spark, true);
});

/* ------------------------------------- 7. what the vm cannot see: is any of it in the page */

await check('the strip is in console.html, outside the launcher, and can hide', async () => {
  assert.match(CONSOLE_HTML, /id="chat-tabs"/);
  const strip = CONSOLE_HTML.indexOf('id="chat-tabs"');
  const launcher = CONSOLE_HTML.indexOf('id="launcher"');
  const thread = CONSOLE_HTML.indexOf('id="thread"');
  assert.ok(strip > 0 && strip < launcher, 'the strip is inside or below the launcher, so it is gone over a conversation');
  assert.ok(launcher < thread, 'the fixture for this assertion has moved');
  // `.chat-tabs` sets a display, which beats the UA sheet's `[hidden] { display: none }`.
  assert.match(STYLE_CSS, /\.chat-tabs\[hidden\]\s*\{[^}]*display:\s*none/);
});

await check('every element console.js reaches for is in console.html', async () => {
  const own = new Set([...CONSOLE_JS.matchAll(/\bid="([a-z-]+)"/g)].map((m) => m[1]));
  const asked = new Set([...CONSOLE_JS.matchAll(/\$\('#([a-z-]+)'\)/g)].map((m) => m[1]));
  const missing = [...asked].filter((id) => !own.has(id) && !CONSOLE_HTML.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `console.html has no ${missing.join(', ')}`);
});

await check('the ✕ is a sibling of the handle, not a child of it', async () => {
  // The whole reason a tap on it cannot also switch: `closest('[data-tab]')` from the
  // button walks past the link. On `#recent` the button is inside the row's own `<a>`
  // and only a `defaultPrevented` guard keeps one tap from doing both.
  const face = CONSOLE_JS.indexOf('class="chat-tab-face"');
  const closes = CONSOLE_JS.indexOf('data-untab=');
  const faceEnd = CONSOLE_JS.indexOf('</a>', face);
  assert.ok(face > 0 && closes > faceEnd, 'the ✕ moved inside the link — one tap now closes and opens');
});

console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
