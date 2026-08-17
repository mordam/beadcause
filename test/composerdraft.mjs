#!/usr/bin/env node
/**
 * What is half-typed in the console composer outlives the page.
 *
 *     npm test
 *     node test/composerdraft.mjs
 *
 * Words that were *sent* and failed have been safe since `public/sendqueue.js`: they
 * sit above the composer, they can be tapped back into the box, and the strip says so.
 * Words that never left the box had none of that — they lived in the textarea and in
 * `chat.say`, and both die with the page. A reload, a crash, a backgrounded tab the
 * phone evicts, a client that re-mounts on a retry: each of them took the paragraph you
 * were half-way through, silently. That asymmetry is bc-bk2g.
 *
 * Six things are pinned here, and none of them is visible from reading one function:
 *
 * 1. **A keystroke reaches the disk**, rather than a save scheduled for later — the
 *    next thing that happens to this page may be that it stops existing.
 * 2. **The draft comes back in the chat it was typed in.** The map is keyed by chat id
 *    for exactly one reason: two conversations must never restore into each other.
 * 3. **Sending spends it.** A draft that survived a delivery would restore beside the
 *    message it had already sent, which is worse than losing it.
 * 4. **The restore re-runs `autoGrow`**, or a four-line draft comes back as a one-line
 *    box you have to click into to find the rest of.
 * 5. **A fortnight-old draft is not a draft.** It is dropped on the next read, which
 *    is also what keeps the map from becoming a hoard.
 * 6. **Storage being denied is not a crash.** Private mode and a WebView with it
 *    switched off both throw from `getItem`, and the composer still has to work.
 *
 * The real `public/console.js` runs in a `vm` against a hand-made document, the way
 * test/chattabs.mjs runs the same page's tab strip: a rewrite of the logic as a
 * test-only module could pass this while the phone shipped something else. A "reload"
 * is a second boot of the same file over the same `localStorage` map, which is exactly
 * what it is in the browser.
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

const SAYS = 'beadcause.console.says';
const at = (n) => new Date(Date.UTC(2026, 7, 1, 10, n)).toISOString();

const CHATS = {
  a1: { workspace: 'alpha', title: 'The installer never checks for iTerm2' },
  a2: { workspace: 'alpha', title: 'Something else entirely' },
};

const row = (id) => ({
  id,
  agent: 'console',
  workspace: CHATS[id].workspace,
  title: CHATS[id].title,
  seed: null,
  status: 'idle',
  closedAt: null,
  messageCount: 1,
  beadCount: 0,
  created: [],
  createdAt: at(0),
  updatedAt: at(9),
});

const transcript = (id) => ({
  ...row(id),
  seq: 1,
  error: null,
  draft: null,
  messages: [{ role: 'user', text: `Said in ${id}`, at: at(0) }],
});

/* -------------------------------------------------------------------- the page */

/**
 * Enough document for `public/console.js` to boot on and open a chat.
 *
 * Every selector answers, so a missing element would not fail here — that half is
 * test/chattabs.mjs's static read, which already asserts every `$('#x')` in this file
 * is in `console.html`.
 *
 * `local` is handed in rather than made here: a reload is a second `load()` over the
 * same map, which is the only way to test the thing this suite is about.
 */
function load({ local = new Map(), search = '', denied = false } = {}) {
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
      // A textarea's natural height, so `autoGrow` has something real to compute from
      // and "did the restore grow the box" is answerable rather than `NaNpx`.
      get scrollHeight() {
        return 24 * String(this.value || '').split('\n').length;
      },
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
      setSelectionRange() {},
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

  /**
   * `denied` refuses the *writes* only, which is the shape the browsers actually
   * take: a quota-exceeded Safari and a WebView with storage switched off both throw
   * from `setItem` while reads keep answering. Refusing the reads too would say
   * nothing about this feature — `bootToken` takes the token from here and the page
   * never gets as far as a composer.
   */
  const map = (store, off = false) => ({
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      if (off) throw new Error('storage is disabled');
      store.set(k, String(v));
    },
    removeItem: (k) => {
      if (off) throw new Error('storage is disabled');
      store.delete(k);
    },
  });

  local.set('beadcause.token', 'tok');

  /* The space picker, as much of it as this page uses. Same contract as spacebar.js. */
  let filter = { space: 'all', workspace: 'all' };
  const space = {
    get filter() {
      return filter;
    },
    matches: () => true,
    label: () => 'everywhere',
    spaceOf: () => 'all',
    set(next) {
      filter = { space: next.space || 'all', workspace: next.workspace || 'all' };
    },
    onChange() {},
  };

  /** What each chat's queue was attached with, so the pull-back-out path is reachable. */
  const attached = new Map();
  let made = 0;

  const window = {
    beadcause: {
      space,
      sendQueue: {
        create: () => {
          const mine = `q${++made}`;
          return {
            attach(opts) {
              attached.set(mine, opts);
              attached.set('last', opts);
            },
            say() {},
            sync() {},
            repaint() {},
          };
        },
      },
    },
    marked: { parse: (s) => s },
    DOMPurify: { sanitize: (s) => s },
  };

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
    localStorage: map(local, denied),
    sessionStorage: map(new Map()),
    URLSearchParams,
    URL,
    setTimeout,
    clearTimeout,
    AbortController,
    structuredClone,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    fetch: async (p, opts = {}) => {
      const answer = (body) => ({ ok: true, status: 200, json: async () => body });
      if (p.startsWith('/api/consoles')) return answer({ consoles: Object.keys(CHATS).map(row), workspaces: ['alpha'] });
      // Never answered: a resolved poll would spin the loop for the length of the run.
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

  return { el, local, settle, attached, url };
}

const opened = async (opts) => {
  const h = load(opts);
  await h.settle();
  return h;
};

/** Type into the composer the way a thumb does: the value moves, then `input` fires. */
function type(h, text) {
  h.el('say').value = text;
  h.el('say').fire('input');
}

const sendIt = (h) => h.el('composer').fire('submit', { preventDefault() {} });

const saysOnDisk = (h) => JSON.parse(h.local.get(SAYS) || 'null');

const tapRow = (h, id) =>
  h.el('recent').fire('click', {
    button: 0,
    defaultPrevented: false,
    preventDefault() {},
    target: { closest: (sel) => (sel === 'a.work-row[data-id]' ? { dataset: { id } } : null) },
  });

console.log('\nan unsent composer draft survives the page going away\n');

/* --------------------------------------------------- 1. typed, then the page is gone */

await check('a keystroke is on the disk before anything else happens', async () => {
  const h = await opened({ search: '?id=a1' });
  type(h, 'the long considered paragraph');
  const held = saysOnDisk(h);
  assert.equal(held?.a1?.text, 'the long considered paragraph', 'nothing reached localStorage on the keystroke');
  assert.ok(Number(held.a1.at) > 0, 'no stamp, so nothing can ever be pruned');
});

await check('reloading into the same chat puts the words back in the box', async () => {
  const first = await opened({ search: '?id=a1' });
  type(first, 'half a thought about the installer');

  // The page going away and coming back: same disk, same address, a fresh everything else.
  const back = await opened({ local: first.local, search: '?id=a1' });
  assert.equal(back.el('say').value, 'half a thought about the installer');
});

await check('the restore grows the box to the height of what came back', async () => {
  const first = await opened({ search: '?id=a1' });
  type(first, 'one\ntwo\nthree\nfour');

  const back = await opened({ local: first.local, search: '?id=a1' });
  // Four lines at the fixture's 24px each. A restore that skipped autoGrow leaves the
  // height untouched, which on a phone is a one-line box hiding three lines of writing.
  assert.equal(back.el('say').style.height, '96px', 'the box came back the wrong height');
});

/* ------------------------------------------------------- 2. one draft per conversation */

await check('two chats keep their own drafts, and neither restores into the other', async () => {
  const h = await opened({ search: '?id=a1' });
  type(h, 'meant for a1');
  tapRow(h, 'a2');
  await h.settle();
  // Switching drew the other chat's composer, which is empty — this is the assertion
  // that a single shared draft would fail loudly rather than quietly.
  assert.equal(h.el('say').value, '', 'a1 draft leaked into a2');
  type(h, 'meant for a2');

  assert.deepEqual(
    Object.fromEntries(Object.entries(saysOnDisk(h)).map(([k, v]) => [k, v.text])),
    { a1: 'meant for a1', a2: 'meant for a2' }
  );

  const back = await opened({ local: h.local, search: '?id=a2' });
  assert.equal(back.el('say').value, 'meant for a2');
  const other = await opened({ local: h.local, search: '?id=a1' });
  assert.equal(other.el('say').value, 'meant for a1');
});

await check('switching back to a chat draws the draft it was left holding', async () => {
  const h = await opened({ search: '?id=a1' });
  type(h, 'left mid-sentence');
  tapRow(h, 'a2');
  await h.settle();
  tapRow(h, 'a1');
  await h.settle();
  assert.equal(h.el('say').value, 'left mid-sentence');
});

/* ------------------------------------------------------------------ 3. sending spends it */

await check('sending clears the stored draft, and a reload brings nothing back', async () => {
  const h = await opened({ search: '?id=a1' });
  type(h, 'this one actually goes');
  sendIt(h);
  assert.equal(h.el('say').value, '', 'the box was not cleared');
  assert.equal(h.local.get(SAYS) ?? null, null, 'a delivered message is still on the disk');

  const back = await opened({ local: h.local, search: '?id=a1' });
  assert.equal(back.el('say').value, '', 'a message that was sent came back as a draft');
});

await check('one chat sending does not spend another chat’s draft', async () => {
  const h = await opened({ search: '?id=a1' });
  type(h, 'still being written');
  tapRow(h, 'a2');
  await h.settle();
  type(h, 'ready to go');
  sendIt(h);
  assert.deepEqual(Object.keys(saysOnDisk(h) || {}), ['a1']);
});

/* ---------------------------------------------- 4. the paths that are not a keystroke */

await check('a queued message pulled back into the box is kept too', async () => {
  const h = await opened({ search: '?id=a1' });
  const opts = h.attached.get('last');
  assert.ok(opts?.onRestore, 'the queue was attached without an onRestore, so this path is unwired');
  // What sendqueue.js does on the way out of `take`: the value is set by hand and then
  // the caller is told. No `input` event is fired, which is the whole trap.
  h.el('say').value = 'taken back out to fix a word';
  opts.onRestore(h.el('say'));
  assert.equal(saysOnDisk(h)?.a1?.text, 'taken back out to fix a word');
});

/* -------------------------------------------------------------- 5. it is not a hoard */

await check('a fortnight-old draft is dropped rather than restored', async () => {
  const stale = new Map([
    [SAYS, JSON.stringify({ a1: { text: 'typed a fortnight ago', at: Date.now() - 15 * 24 * 60 * 60 * 1000 } })],
  ]);
  const h = await opened({ local: stale, search: '?id=a1' });
  assert.equal(h.el('say').value, '', 'a stale draft came back as a surprise');
});

await check('a fresh draft on the same disk survives the sweep the stale one does not', async () => {
  const mixed = new Map([
    [
      SAYS,
      JSON.stringify({
        a1: { text: 'yesterday', at: Date.now() - 24 * 60 * 60 * 1000 },
        a2: { text: 'last month', at: Date.now() - 40 * 24 * 60 * 60 * 1000 },
      }),
    ],
  ]);
  const h = await opened({ local: mixed, search: '?id=a1' });
  assert.equal(h.el('say').value, 'yesterday');
  // The next write is what actually rewrites the map, and it must not carry the stale
  // entry forward — a prune that only hides is a prune that never finishes.
  type(h, 'yesterday, continued');
  assert.deepEqual(Object.keys(saysOnDisk(h)), ['a1']);
});

await check('a map written by something else, or garbage, is ignored rather than fatal', async () => {
  for (const junk of ['not json at all', '[]', 'null', '{"a1":"a bare string"}']) {
    const h = await opened({ local: new Map([[SAYS, junk]]), search: '?id=a1' });
    assert.equal(h.el('say').value, '', `${junk} was read as a draft`);
    type(h, 'typed over it');
    assert.equal(saysOnDisk(h)?.a1?.text, 'typed over it', `${junk} blocked the next write`);
  }
});

/* ------------------------------------------------------------- 6. storage switched off */

await check('storage denied is a composer that forgets, not a page that breaks', async () => {
  const h = await opened({ search: '?id=a1', denied: true });
  type(h, 'private mode, and still typing');
  assert.equal(h.el('say').value, 'private mode, and still typing', 'the keystroke threw out of the listener');
  sendIt(h);
  assert.equal(h.el('say').value, '', 'sending threw where storage was refused');
  assert.equal(h.local.get(SAYS) ?? null, null, 'a refused write left something behind anyway');
});

/* --------------------------------- 7. what the vm cannot see: which storage this is in */

await check('the draft is in localStorage, not the sessionStorage warm.js uses', async () => {
  // sessionStorage is scoped to the tab, and a lost tab is the case this exists for —
  // so this is the one line that would silently undo the whole feature.
  const decl = CONSOLE_JS.match(/const SAY_KEY = '([^']+)'/);
  assert.ok(decl, 'SAY_KEY has been renamed; this suite is reading for the wrong thing');
  assert.equal(decl[1], SAYS);
  const body = CONSOLE_JS.slice(CONSOLE_JS.indexOf('function readSays'), CONSOLE_JS.indexOf('const state = {'));
  assert.ok(body.includes('localStorage.getItem(SAY_KEY)'), 'the read moved off localStorage');
  assert.ok(!body.includes('sessionStorage'), 'the draft store reached for sessionStorage');
});

console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
