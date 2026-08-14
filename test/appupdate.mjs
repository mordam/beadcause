#!/usr/bin/env node
/**
 * The app keeping itself in step with the deploy that just landed — public/update.js.
 *
 *     npm test
 *     node test/appupdate.mjs
 *
 * bc-jznr. The daemon says what a deploy did (lib/update.js, and test/update.mjs over it);
 * this is the half that decides what to do about it, and four of its rules are the kind
 * that fail silently — the app goes on looking fine while doing the wrong thing, on a
 * phone, days later:
 *
 * 1. **The boot read never reloads.** `/api/update` reports the *last* deploy that changed
 *    anything, so a page that reloaded on that answer would come back up, ask, be told
 *    about the same deploy and reload again — a loop, on every device, fastest on the one
 *    that just got the fix. Only a live event reloads.
 * 2. **A reload waits for a caret.** Every answer in this app is typed into a box that
 *    keeps a draft per keystroke; a reload that lands mid-sentence is the one cost this
 *    feature must not impose. Deferred, and taken when the box is left.
 * 3. **An APK is offered only when it is genuinely newer**, and never on a version nothing
 *    can compare — no sidecar, or a shell too old to say what it is. Offering a downgrade
 *    is a button that cannot work; offering the build already running is a download loop.
 * 4. **Installing is asked for, and armed.** The download happens on its own because it
 *    costs nothing anybody notices; the install restarts the app, so it never happens
 *    without a tap on a button that says so.
 *
 * The real file runs in a vm against a stub DOM — shaped to exactly what it reaches for
 * and no more — the way test/stream.mjs runs the real stream. A reimplementation of these
 * rules here could pass while the phone shipped something else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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
    console.log(`      ${String(err.message).split('\n').slice(0, 5).join('\n      ')}`);
  }
}

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ a stub DOM */

/**
 * Enough of an element for what public/update.js actually does to one.
 *
 * Deliberately not a DOM: the file creates two elements, puts one in the top bar and one
 * on the body, sets `innerHTML` on the second and then finds two buttons inside it by
 * `data-act`. That last move is the only thing here that needs parsing at all, and it is
 * done with a regex over markup the file itself writes — as much fidelity as this needs
 * and no more. Anything the file starts doing that this cannot express should fail here
 * loudly, rather than a stub quietly growing into a browser.
 */
function makeDom() {
  const byId = new Map();

  const node = (tag = 'div') => {
    const self = {
      tagName: tag.toUpperCase(),
      children: [],
      kids: [],
      listeners: new Map(),
      dataset: {},
      isContentEditable: false,
      textContent: '',
      title: '',
      disabled: false,
      className: '',
      parent: null,
      classList: {
        set: new Set(),
        add(c) {
          this.set.add(c);
        },
        remove(c) {
          this.set.delete(c);
        },
        toggle(c, on) {
          if (on) this.set.add(c);
          else this.set.delete(c);
        },
        contains(c) {
          return this.set.has(c);
        },
      },
      addEventListener(type, fn) {
        if (!self.listeners.has(type)) self.listeners.set(type, []);
        self.listeners.get(type).push(fn);
      },
      fire(type, ev = {}) {
        for (const fn of self.listeners.get(type) || []) fn(ev);
      },
      appendChild(child) {
        self.children.push(child);
        child.parent = self;
        if (child.id) byId.set(child.id, child);
        return child;
      },
      prepend(child) {
        self.children.unshift(child);
        child.parent = self;
        if (child.id) byId.set(child.id, child);
        return child;
      },
      remove() {
        if (self.parent) self.parent.children = self.parent.children.filter((c) => c !== self);
        if (self.id) byId.delete(self.id);
        self.parent = null;
      },
      querySelector(sel) {
        const m = /\[data-act="([^"]+)"\]/.exec(sel);
        return m ? self.kids.find((k) => k.dataset.act === m[1]) || null : null;
      },
    };
    let id = '';
    Object.defineProperty(self, 'id', {
      get: () => id,
      set(v) {
        id = v;
        if (self.parent) byId.set(v, self);
      },
    });
    let html = '';
    Object.defineProperty(self, 'innerHTML', {
      get: () => html,
      set(v) {
        html = String(v);
        // Every `data-act="…"` in what was just written becomes a child that can be found
        // and clicked. See the note above.
        self.kids = [...html.matchAll(/data-act="([^"]+)"/g)].map((m) => {
          const kid = node('button');
          kid.dataset.act = m[1];
          return kid;
        });
      },
    });
    return self;
  };

  const host = node('div'); // the top bar's `.sheet-actions`
  const body = node('body');
  const document = {
    readyState: 'complete',
    activeElement: null,
    hidden: false,
    listeners: new Map(),
    body,
    createElement: (tag) => node(tag),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => (sel.startsWith('.topbar') ? host : null),
    addEventListener(type, fn) {
      if (!document.listeners.has(type)) document.listeners.set(type, []);
      document.listeners.get(type).push(fn);
    },
    fire(type, ev = {}) {
      for (const fn of document.listeners.get(type) || []) fn(ev);
    },
  };
  return { document, host, body, node };
}

/**
 * The real file, in a room with the globals it touches.
 *
 * `shell` is the Android bridge — absent for the browser cases, which is most of the
 * app's life — and every call it records is a claim about what the phone was told to do.
 */
function mount({ shell = null, apk = null, deploy = null, store = new Map([['beadcause.token', 'tok']]) } = {}) {
  const dom = makeDom();
  const calls = { fetched: [], reloads: 0, swUpdates: 0 };
  let heard = null;
  const window = { beadcause: { stream: { listen: (fn) => (heard = fn) } } };
  window.getSelection = () => null;
  // Where the bridge actually lives. The file reads `window.BeadcauseNative`, which is
  // what the WebView injects — a bare global in this context would be a different object
  // and every native branch would silently be dead.
  window.BeadcauseNative = shell;

  let handOver = null;
  const navigator = {
    serviceWorker: {
      getRegistration: async () => ({
        update: async () => {
          calls.swUpdates += 1;
        },
      }),
      addEventListener: (type, fn) => {
        if (type === 'controllerchange') handOver = fn;
      },
    },
  };

  const ctx = vm.createContext({
    window,
    document: dom.document,
    navigator,
    location: {
      reload: () => {
        calls.reloads += 1;
      },
    },
    // Real enough to remember, because "one reload per deploy id" is remembering — and
    // it survives the mount, which is what a second mount below stands in for.
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    fetch: async (url) => {
      calls.fetched.push(url);
      return { ok: true, json: async () => ({ apk, deploy }) };
    },
    setTimeout,
    clearTimeout,
    JSON,
    Promise,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    console,
    BeadcauseNative: shell,
  });
  vm.runInContext(read('public/update.js'), ctx, { filename: 'update.js' });

  return {
    window,
    calls,
    document: dom.document,
    host: dom.host,
    /** Deliver what the page's own poll would have handed the listener. */
    emit: (events) => heard?.(events),
    /** What the shell would have pushed in — `Updater.report` on the Kotlin side. */
    fromShell: (state) => window.beadcause.update.native(JSON.stringify(state)),
    store,
    button: () => dom.document.getElementById('app-update'),
    ask: () => dom.document.getElementById('app-update-ask'),
    /** The service worker handing over, which is what a reload waits on. */
    handOver: () => handOver?.(),
    listening: () => typeof heard === 'function',
  };
}

/** A shell that records what it was asked to do. */
function fakeShell({ version = 100, state = { phase: 'idle' } } = {}) {
  const calls = { downloads: 0, installs: 0 };
  return {
    calls,
    bridge: {
      updateVersion: () => version,
      updateState: () => JSON.stringify(state),
      downloadUpdate: () => {
        calls.downloads += 1;
      },
      installUpdate: () => {
        calls.installs += 1;
      },
    },
  };
}

/** Take a reload all the way through: the worker hands over, then the page goes. */
async function finishReload(m) {
  await settle();
  m.handOver();
  await settle();
}

console.log('\nthe app updating itself');

/* ------------------------------------------------------------------- reloading */

await check('it listens on the page’s own poll rather than opening one', async () => {
  const m = mount();
  await settle();
  assert.equal(m.listening(), true);
});

await check('the boot read catches the deploy whose event the restart ate', async () => {
  // The case the whole guard exists for: the daemon was killed by its own deploy, so the
  // parked poll broke and the settle event was emitted to nobody.
  const m = mount({ deploy: { id: 'd1', web: true, apk: false, at: new Date(Date.now() + 60000).toISOString() } });
  await settle();
  assert.deepEqual(m.calls.fetched, ['/api/update']);
  await finishReload(m);
  assert.equal(m.calls.reloads, 1);
});

await check('…and the page that comes back does not reload again', async () => {
  const store = new Map([['beadcause.token', 'tok']]);
  const deploy = { id: 'd1', web: true, apk: false, at: new Date(Date.now() + 60000).toISOString() };
  const first = mount({ deploy, store });
  await finishReload(first);
  assert.equal(first.calls.reloads, 1);
  // The same device, the same deploy, a page that has just come back up.
  const again = mount({ deploy, store });
  await finishReload(again);
  assert.equal(again.calls.reloads, 0, 'reloaded twice for one deploy — that is the loop');
});

await check('a deploy this page is younger than is left alone', async () => {
  const m = mount({ deploy: { id: 'd0', web: true, at: new Date(Date.now() - 60000).toISOString() } });
  await finishReload(m);
  assert.equal(m.calls.reloads, 0, 'reloaded a page that already had the new files');
});

await check('and one with no usable stamp is left alone too', async () => {
  const m = mount({ deploy: { id: 'd0b', web: true, at: null } });
  await finishReload(m);
  assert.equal(m.calls.reloads, 0);
});

await check('an event and the boot read behind it are one reload, not two', async () => {
  const store = new Map([['beadcause.token', 'tok']]);
  const deploy = { id: 'd1c', web: true, at: new Date(Date.now() + 60000).toISOString() };
  const m = mount({ deploy, store });
  await settle();
  m.emit([{ type: 'deploy', id: 'd1c', status: 'unconfirmed', web: true, apk: false }]);
  await finishReload(m);
  assert.equal(m.calls.reloads, 1);
  const again = mount({ deploy, store });
  await finishReload(again);
  assert.equal(again.calls.reloads, 0);
});

await check('a live deploy that moved public/ reloads, through the service worker', async () => {
  const m = mount();
  await settle();
  m.emit([{ type: 'deploy', id: 'd2', status: 'unconfirmed', web: true, apk: false }]);
  await finishReload(m);
  assert.equal(m.calls.swUpdates, 1, 'reloaded without updating the worker — the cache would answer');
  assert.equal(m.calls.reloads, 1);
});

await check('one that did not leaves the page alone', async () => {
  const m = mount();
  await settle();
  m.emit([{ type: 'deploy', id: 'd3', status: 'ok', web: false, apk: false }]);
  await finishReload(m);
  assert.equal(m.calls.reloads, 0);
});

await check('and neither does anything else on the log', async () => {
  const m = mount();
  await settle();
  m.emit([{ type: 'advocate' }, { type: 'merged' }, { type: 'presence' }]);
  await finishReload(m);
  assert.equal(m.calls.reloads, 0);
});

await check('a deploy from a daemon that predates this asks instead of guessing', async () => {
  const m = mount();
  await settle();
  m.calls.fetched.length = 0;
  m.emit([{ type: 'deploy', id: 'd4', status: 'ok' }]);
  await finishReload(m);
  assert.deepEqual(m.calls.fetched, ['/api/update']);
  assert.equal(m.calls.reloads, 0, 'reloaded on an event that never said the page had moved');
});

await check('a caret in a box defers the reload', async () => {
  const m = mount();
  await settle();
  m.document.activeElement = { tagName: 'TEXTAREA' };
  m.emit([{ type: 'deploy', id: 'd5', status: 'ok', web: true }]);
  await finishReload(m);
  assert.equal(m.calls.reloads, 0, 'reloaded out from under something being typed');
});

await check('…and leaving the box takes it', async () => {
  const m = mount();
  await settle();
  m.document.activeElement = { tagName: 'TEXTAREA' };
  m.emit([{ type: 'deploy', id: 'd6', status: 'ok', web: true }]);
  await settle();
  m.document.activeElement = null;
  m.document.fire('focusout');
  await settle(300);
  m.handOver();
  await settle();
  assert.equal(m.calls.reloads, 1);
});

/* ----------------------------------------------------------------------- the APK */

await check('a browser is never offered an APK', async () => {
  const m = mount({ apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  assert.equal(m.button(), null);
});

await check('a shell behind the published build is told to fetch it', async () => {
  const shell = fakeShell({ version: 400 });
  const m = mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500', size: 10 } });
  await settle();
  assert.equal(shell.calls.downloads, 1);
});

await check('one already on it is not', async () => {
  const shell = fakeShell({ version: 500 });
  const m = mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  assert.equal(shell.calls.downloads, 0);
  assert.equal(m.button(), null);
});

await check('and neither is one ahead of it', async () => {
  const shell = fakeShell({ version: 600 });
  mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  assert.equal(shell.calls.downloads, 0);
});

await check('a published APK nothing can put a version on is left alone', async () => {
  const shell = fakeShell({ version: 400 });
  mount({ shell: shell.bridge, apk: { versionCode: null, versionName: '', size: 10 } });
  await settle();
  assert.equal(shell.calls.downloads, 0, 'downloaded a build it could not compare');
});

await check('a shell too old to say which build it is offers nothing', async () => {
  const shell = fakeShell({ version: 400 });
  delete shell.bridge.updateVersion;
  mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  assert.equal(shell.calls.downloads, 0);
});

await check('a rebuilt APK on a live event goes and asks again', async () => {
  const shell = fakeShell({ version: 400 });
  const m = mount({ shell: shell.bridge, apk: { versionCode: 400, versionName: '1.0.400' } });
  await settle();
  assert.equal(shell.calls.downloads, 0);
  m.calls.fetched.length = 0;
  m.emit([{ type: 'deploy', id: 'd7', status: 'ok', web: false, apk: true }]);
  await settle();
  assert.deepEqual(m.calls.fetched, ['/api/update']);
});

/* -------------------------------------------------------------------- the asking */

await check('a download that has landed puts up a button and asks once', async () => {
  const shell = fakeShell({ version: 400 });
  const m = mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  m.fromShell({ phase: 'downloading', versionName: '1.0.500' });
  assert.equal(m.button(), null, 'offered an install before the bytes were there');
  m.fromShell({ phase: 'ready', versionName: '1.0.500' });
  assert.ok(m.button(), 'no way to install what was downloaded');
  assert.equal(m.button().textContent, 'Update app');
  assert.ok(m.ask(), 'the download landed and nobody was told');
  assert.match(m.ask().innerHTML, /1\.0\.500/);
});

await check('Later drops the ask and keeps the button', async () => {
  const shell = fakeShell({ version: 400 });
  const m = mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  m.fromShell({ phase: 'ready', versionName: '1.0.500' });
  m.ask().querySelector('[data-act="later"]').fire('click');
  assert.equal(m.ask(), null);
  assert.ok(m.button(), 'Later took the only way back to it');
});

await check('the top-bar button arms before it installs', async () => {
  const shell = fakeShell({ version: 400 });
  const m = mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  m.fromShell({ phase: 'ready', versionName: '1.0.500' });
  m.button().fire('click');
  assert.equal(shell.calls.installs, 0, 'one tap restarted the app');
  assert.match(m.button().textContent, /sure\?/);
  m.button().fire('click');
  assert.equal(shell.calls.installs, 1);
});

await check('the ask installs on the tap it was read with', async () => {
  const shell = fakeShell({ version: 400 });
  const m = mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  m.fromShell({ phase: 'ready', versionName: '1.0.500' });
  m.ask().querySelector('[data-act="install"]').fire('click');
  assert.equal(shell.calls.installs, 1, 'a sentence that was just read asked for a second tap');
});

await check('a page that loads over a finished download picks it up', async () => {
  const shell = fakeShell({ version: 400, state: { phase: 'ready', versionName: '1.0.500' } });
  const m = mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  assert.ok(m.button(), 'the reload after the deploy lost the download it had already made');
});

await check('and the button goes when the install has been applied', async () => {
  const shell = fakeShell({ version: 400, state: { phase: 'ready', versionName: '1.0.500' } });
  const m = mount({ shell: shell.bridge, apk: { versionCode: 500, versionName: '1.0.500' } });
  await settle();
  m.fromShell({ phase: 'idle' });
  assert.equal(m.button(), null);
  assert.equal(m.ask(), null);
});

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
