#!/usr/bin/env node
/**
 * The service worker's own errors — that they are noticed, and that they arrive.
 *
 *     npm test
 *     node test/swreport.mjs
 *
 * public/sw.js was the one piece of the app with nothing watching it (bc-u3g4): it runs
 * in its own global, so public/report.js — the reporter on all seventeen pages — cannot see
 * a single thing that happens inside it. `caches.addAll(SHELL)` rejecting on install
 * leaves the whole shell uncached and says nothing, and the symptom is an app that is a
 * bit slow offline, for as long as that worker lives.
 *
 * Both halves are loaded here, the real files in a `vm` the way test/reporter.mjs loads
 * report.js, so a rewrite of either as a test-only copy cannot pass this:
 *
 * 1. **The worker end**, with a hand-made `self`, `caches` and `clients`. Install,
 *    activate, the fetch handler and a failed `cache.put` each relay; the offline path
 *    does not, because being in a tunnel is not a bug; and a worker with no page open
 *    drops the report rather than throwing inside the thing that was recording it.
 *    That offline path is also *what it answers with*, which is more than reporting and
 *    is here because this is where the harness for it already lived: a URL that carries
 *    its state in the query string is served the cached page rather than the index
 *    (bc-nib3.11), and the login screen is still neither stored nor served.
 * 2. **The page end**, with a hand-made `navigator.serviceWorker`, proving the relayed
 *    message becomes `POST /api/error` with everything a report costs still spent — and
 *    that `startMessages()` is called, without which the listener is registered, correct,
 *    and never fires.
 * 3. **The seam**, statically: the two files agree on the message type, the worker never
 *    posts to the endpoint itself, and two different worker failures fingerprint apart
 *    rather than commenting onto one another's bead.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { fingerprint } from '../lib/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = (f) => path.join(ROOT, 'public', f);
const SW_SOURCE = fs.readFileSync(PUBLIC('sw.js'), 'utf8');
const REPORT_SOURCE = fs.readFileSync(PUBLIC('report.js'), 'utf8');

/** The token in storage. If it ever reaches a report body, that is bc-sqab again. */
const TOKEN = 'sekrit-daemon-token-9f2c';

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

/** Let every queued microtask run. The relay is two `then`s deep and nothing awaits it. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

/** A promise's outcome, without a rejection taking the test down with it. */
const outcome = async (p) => {
  if (!p || typeof p.then !== 'function') return { missing: true };
  try {
    return { value: await p };
  } catch (err) {
    return { error: err };
  }
};

/**
 * The real public/sw.js, in a global with nothing in it but the four things a worker has.
 *
 * Every fake is a promise-returning stub the test can point at a failure, because every
 * failure this file is about is a rejected promise inside a browser API — there is no
 * other shape for "the cache said no".
 */
function loadWorker(opts = {}) {
  const listeners = new Map();
  const posted = [];
  const clients =
    opts.clients === undefined
      ? [{ id: 'w1', focused: true, postMessage: (m) => posted.push(m) }]
      : opts.clients.map((c) => ({ ...c, postMessage: (m) => posted.push({ ...m, to: c.id }) }));
  const cache = {
    addAll: opts.addAll || (() => Promise.resolve()),
    put: opts.put || (() => Promise.resolve()),
  };
  const self_ = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => (opts.matchAllRejects ? Promise.reject(new Error('no clients')) : Promise.resolve(clients)),
    },
  };
  const caches = {
    open: opts.open || (() => Promise.resolve(cache)),
    keys: opts.keys || (() => Promise.resolve([])),
    delete: () => Promise.resolve(true),
    match: opts.match || (() => Promise.resolve(undefined)),
  };
  const fetchStub =
    opts.fetch ||
    ((request) =>
      Promise.resolve({
        ok: true,
        status: 200,
        redirected: false,
        url: `http://127.0.0.1:4317${request.path || '/app.js'}`,
        clone: () => ({ body: 'copy' }),
      }));
  /* A worker has `Response`, and `fallback` reaches for its one static to answer a path
     that names a view (bc-khoe.30.7). Recorded rather than constructed, because what is
     worth asserting is the address it was handed — and `Response.redirect` demands an
     absolute one, which is the mistake this stub has to be able to catch. */
  const Response_ = {
    redirect: (url, status) => {
      if (!/^https?:\/\//.test(String(url))) throw new TypeError(`Failed to parse URL from ${url}`);
      return { redirected: true, status: status || 302, headers: { location: String(url) } };
    },
  };
  const ctx = vm.createContext({ self: self_, caches, fetch: fetchStub, URL, URLSearchParams, console, Response: Response_ });
  vm.runInContext(SW_SOURCE, ctx, { filename: 'sw.js' });

  const fire = (type, event) => {
    const fn = listeners.get(type);
    assert.ok(fn, `nothing in sw.js listens for ${type}`);
    return fn(event);
  };
  /** The install/activate shape: one promise, handed over and never awaited by anyone. */
  const lifecycle = (type) => {
    let held = null;
    fire(type, { waitUntil: (p) => { held = p; } });
    return held;
  };
  /** The fetch shape: a request in, whatever the handler decided to answer with out. */
  const request = (pathname, method = 'GET') => {
    let answer;
    fire('fetch', {
      request: { url: `http://127.0.0.1:4317${pathname}`, method, path: pathname },
      respondWith: (p) => { answer = p; },
    });
    return answer;
  };
  return { posted, fire, lifecycle, request, listeners };
}

/**
 * The real public/report.js, with a service worker to hear from.
 *
 * A trimmed copy of test/reporter.mjs's loader — that file owns the reporter's own
 * behaviour, and this one only needs the wire the worker's messages come in on.
 */
function loadPage({ respond = null } = {}) {
  const listeners = new Map();
  const swListeners = new Map();
  const calls = [];
  let started = 0;
  const window = {
    location: { href: `http://127.0.0.1:4317/?t=${TOKEN}`, pathname: '/', origin: 'http://127.0.0.1:4317' },
    navigator: {
      userAgent: 'test-agent/1',
      serviceWorker: {
        addEventListener: (type, fn) => swListeners.set(type, fn),
        startMessages: () => { started += 1; },
      },
    },
    localStorage: { getItem: (k) => (k === 'beadcause.token' ? TOKEN : null) },
    addEventListener: (type, fn) => listeners.set(type, fn),
    fetch: (input, init) => {
      calls.push({ input, init });
      return respond ? respond(input, init) : Promise.resolve({ status: 200, ok: true });
    },
  };
  const ctx = vm.createContext({ window, URL, setTimeout, clearTimeout, console });
  vm.runInContext(REPORT_SOURCE, ctx, { filename: 'report.js' });
  const reports = () =>
    calls
      .filter((c) => c.input === '/api/error')
      .map((c) => ({ headers: c.init.headers, body: JSON.parse(c.init.body) }));
  const fromWorker = (data) => {
    const fn = swListeners.get('message');
    assert.ok(fn, 'report.js does not listen to the service worker at all');
    return fn({ data });
  };
  return { reports, fromWorker, started: () => started, calls };
}

/* ------------------------------------------------ the acceptance criteria: install */

await check('a shell that will not cache is relayed to the page, and the install still fails', async () => {
  const boom = Object.assign(new Error("Failed to execute 'addAll' on 'Cache': Request failed"), {
    stack: "TypeError: Failed to execute 'addAll'\n    at http://127.0.0.1:4317/sw.js:262:8",
  });
  const sw = loadWorker({ addAll: () => Promise.reject(boom) });
  const held = sw.lifecycle('install');
  const out = await outcome(held);
  await settle();
  assert.ok(out.error, 'the install resolved — a half-empty cache would look installed');
  assert.equal(out.error.message, boom.message, 'it did not re-throw what actually went wrong');
  const [msg] = sw.posted;
  assert.ok(msg, 'nothing was relayed to the page');
  assert.equal(msg.type, 'beadcause:sw-error');
  assert.match(msg.message, /^service worker — install/);
  assert.match(msg.message, /Request failed/);
  assert.match(msg.stack, /sw\.js:262/, 'the stack is what gives the report a source at all');
});

await check('a healthy install relays nothing and still skips waiting', async () => {
  const sw = loadWorker();
  const out = await outcome(sw.lifecycle('install'));
  await settle();
  assert.ok(!out.error, `a working install failed: ${out.error?.message}`);
  assert.equal(sw.posted.length, 0, 'a working install reported something');
});

await check('an activate that cannot sweep the old caches is relayed, and re-thrown', async () => {
  const sw = loadWorker({ keys: () => Promise.reject(new Error('the cache index is unreadable')) });
  const out = await outcome(sw.lifecycle('activate'));
  await settle();
  assert.ok(out.error, 'activate swallowed it');
  assert.match(sw.posted[0]?.message || '', /^service worker — activate/);
});

/* -------------------------------------------------- the fetch handler, both ways */

await check('offline with the page in the cache is not a failure and reports nothing', async () => {
  const sw = loadWorker({
    fetch: () => Promise.reject(new Error('Failed to fetch')),
    match: () => Promise.resolve({ body: 'the cached page' }),
  });
  const out = await outcome(sw.request('/app.js'));
  await settle();
  assert.deepEqual(out.value, { body: 'the cached page' }, 'the cached copy did not come back');
  assert.equal(sw.posted.length, 0, 'a phone in a tunnel filed a bead');
});

await check('a cache that refuses to answer is relayed — that one is not the tunnel', async () => {
  const sw = loadWorker({
    fetch: () => Promise.reject(new Error('Failed to fetch')),
    match: () => Promise.reject(new Error('UnknownError: Database deleted by request of the user')),
  });
  const out = await outcome(sw.request('/app.js'));
  await settle();
  assert.ok(out.error, 'a cache that cannot answer must still be a network error to the page');
  assert.match(sw.posted[0]?.message || '', /the cache could not answer \/app\.js/);
});

await check('and the last resort is watched too, not only the first look', async () => {
  // The request misses cleanly — exactly, and then with its query string set aside — and
  // it is the index page, the fallback of the fallback, that the storage chokes on. An
  // easy one to leave uncovered by hanging the rejection handler off the first
  // `caches.match` alone. Keyed on the argument rather than on a call count, because
  // only the last resort asks for a path as a string.
  const sw = loadWorker({
    fetch: () => Promise.reject(new Error('Failed to fetch')),
    match: (req) =>
      typeof req === 'string'
        ? Promise.reject(new Error('UnknownError: Database deleted'))
        : Promise.resolve(undefined),
  });
  const out = await outcome(sw.request('/app.js'));
  await settle();
  assert.ok(out.error, 'it must still be a network error to the page');
  assert.match(sw.posted[0]?.message || '', /the cache could not answer \/app\.js/);
});

await check('nothing cached at all rejects with the path, rather than answering undefined', async () => {
  const sw = loadWorker({
    fetch: () => Promise.reject(new Error('Failed to fetch')),
    match: () => Promise.resolve(undefined),
  });
  const out = await outcome(sw.request('/history.js'));
  await settle();
  assert.ok(out.error, 'respondWith was handed undefined, which is a network error nobody can read');
  assert.match(out.error.message, /nothing cached for \/history\.js/);
  assert.equal(sw.posted.length, 0, 'an empty cache offline is not worth a bead per request');
});

/* ------------------------------------------- the offline answer to a narrowed URL */

/*
  bc-nib3.11. `Cache.match` keys on the whole URL and no path in SHELL carries a query
  string, so every URL in this app that holds its state in the query — the History tab's
  four filters, and every home-screen shortcut built on them — used to miss the cache
  outright and land the reader on the index page with nothing said. What follows is that
  answer, and the two things it must not disturb on the way past.
*/

/**
 * A cache holding exactly these paths, answering the way `Cache.match` answers.
 *
 * The whole URL is the key, and only `{ ignoreSearch: true }` will put
 * `/history?status=closed` onto a stored `/history` — which is the one behaviour every
 * check below turns on, so a stub that matched on pathname alone would pass them all
 * against a worker that had not changed at all.
 */
function cacheOf(paths) {
  const held = new Map(paths.map((p) => [p, { body: `cached ${p}` }]));
  const asked = [];
  const match = (req, opts) => {
    const url = new URL(typeof req === 'string' ? req : req.url, 'http://127.0.0.1:4317');
    const ignoreSearch = !!(opts && opts.ignoreSearch);
    asked.push({ path: url.pathname + url.search, ignoreSearch });
    const exact = held.get(url.pathname + url.search);
    if (exact) return Promise.resolve(exact);
    return Promise.resolve(ignoreSearch ? held.get(url.pathname) : undefined);
  };
  return { match, asked, held };
}

await check('a filtered ledger URL offline serves the cached ledger rather than the inbox', async () => {
  const cache = cacheOf(['/', '/history']);
  const sw = loadWorker({ fetch: () => Promise.reject(new Error('Failed to fetch')), match: cache.match });
  const out = await outcome(sw.request('/history?status=closed&priority=P0'));
  await settle();
  assert.deepEqual(out.value, { body: 'cached /history' }, 'the shortcut opened the index page instead of the ledger');
  assert.ok(!cache.asked.some((a) => a.path === '/'), 'it reached the last resort with the page it wanted in the cache');
  assert.equal(sw.posted.length, 0, 'a phone offline on a filtered URL filed a bead');
});

await check('the exact entry still wins over the one the query string was set aside for', async () => {
  // A cache can hold both, because anything fetched online is stored under the URL it
  // was asked for. The one that was asked for is the one to answer with; the widened
  // match is a fallback, not a replacement.
  const cache = cacheOf(['/', '/history', '/history?status=closed']);
  const sw = loadWorker({ fetch: () => Promise.reject(new Error('Failed to fetch')), match: cache.match });
  const out = await outcome(sw.request('/history?status=closed'));
  await settle();
  assert.deepEqual(out.value, { body: 'cached /history?status=closed' });
  assert.deepEqual(cache.asked, [{ path: '/history?status=closed', ignoreSearch: false }], 'it looked further than it needed to');
});

await check('a query string on a path nothing has cached still falls through to the index', async () => {
  const cache = cacheOf(['/']);
  const sw = loadWorker({ fetch: () => Promise.reject(new Error('Failed to fetch')), match: cache.match });
  const out = await outcome(sw.request('/nowhere?status=closed'));
  await settle();
  assert.deepEqual(out.value, { body: 'cached /' }, 'the offline navigation lost its last resort');
  assert.deepEqual(
    cache.asked.map((a) => `${a.path}${a.ignoreSearch ? ' (ignoreSearch)' : ''}`),
    ['/nowhere?status=closed', '/nowhere?status=closed (ignoreSearch)', '/'],
    'the three looks, in order'
  );
});

/* ------------------------------------------ the offline answer to a path that is a view */

/*
  bc-khoe.30.7. Every view is a pane of one document now, so `/history` is a **302** to
  `/#history` on the daemon rather than a page — and a 302 is the one response
  `Cache.put` refuses, so those paths had to leave `SHELL`. With no daemon to ask, that
  leaves the request missing the cache twice and falling to the index page below: the
  shell, served under the old path, with an empty hash. Home, whatever was tapped, on
  exactly the phone the aliases exist for.

  `VIEW_HOPS` is the worker's own copy of that table and `fallback` answers from it. The
  order matters as much as the answer, which is what the last two checks are about: it
  sits *below* both cache lookups, so a view whose pane has not landed yet — still a
  document, still precached under its own name — is answered with what was cached under
  it, and never reaches the table at all.
*/

await check('a view path offline hops to its pane rather than landing on the inbox', async () => {
  // The v96 cache: the shell, and no entry under /history at all, because it stopped
  // being a path this worker precaches when it stopped being a document.
  const cache = cacheOf(['/']);
  const sw = loadWorker({ fetch: () => Promise.reject(new Error('Failed to fetch')), match: cache.match });
  const out = await outcome(sw.request('/history'));
  await settle();
  assert.equal(out.value?.headers?.location, 'http://127.0.0.1:4317/#history', 'the shortcut opened Home');
  assert.equal(out.value?.status, 302);
  assert.equal(sw.posted.length, 0, 'answering a shortcut offline is not a failure worth a bead');
});

await check('and it carries the query across the way the daemon does — filters behind the hash, the token in front', async () => {
  const cache = cacheOf(['/']);
  const sw = loadWorker({ fetch: () => Promise.reject(new Error('Failed to fetch')), match: cache.match });

  // What the door decides for itself, on top of what arrived.
  const narrowed = await outcome(sw.request('/closed?priority=P0'));
  assert.equal(narrowed.value?.headers?.location, 'http://127.0.0.1:4317/#history?priority=P0&status=closed');

  // And the pairing token, which is the daemon's rather than the view's: swept behind a
  // `#` it would be a token no server can ever read, and the next navigation is a login
  // screen. Offline that costs nothing this second and everything on the way back.
  const paired = await outcome(sw.request('/closed?t=pair-me'));
  assert.equal(paired.value?.headers?.location, 'http://127.0.0.1:4317/?t=pair-me#history?status=closed');
  await settle();
  assert.equal(sw.posted.length, 0);
});

await check('a path still precached under its own name is answered from the cache, not hopped', async () => {
  // The self-gating half, and the reason the step is below the two lookups rather than
  // above them. A pre-v96 phone still holds `/history` as the document it was; a view
  // whose pane has not landed yet still holds its own page the same way. Either is a
  // better answer than a redirect to a pane that document cannot draw.
  const cache = cacheOf(['/', '/history']);
  const sw = loadWorker({ fetch: () => Promise.reject(new Error('Failed to fetch')), match: cache.match });
  const out = await outcome(sw.request('/history'));
  await settle();
  assert.deepEqual(out.value, { body: 'cached /history' }, 'a cached document was thrown away for a hop');
});

await check('and a path that names no view is untouched — it still falls to the index', async () => {
  // `/endorse` rather than `/monitor`, which was this fixture until bc-khoe.30.7 turned it
  // into a hop. The queue is a document and is meant to stay one — no pill points at it and
  // no container in index.html is waiting for it — so it is a stabler stand-in for "a path
  // the table says nothing about" than any address the epic is still moving.
  const cache = cacheOf(['/']);
  const sw = loadWorker({ fetch: () => Promise.reject(new Error('Failed to fetch')), match: cache.match });
  const out = await outcome(sw.request('/endorse'));
  await settle();
  assert.deepEqual(out.value, { body: 'cached /' }, 'the hop table has grown a path that names no view');
});

await check('the login page is still never served from cache — a next= param widens onto nothing', async () => {
  // The one thing dropping a query string could plausibly have broken. It does not:
  // there is no `/login` entry to widen onto, because `fetchAndStore` never stores one,
  // and the path in a `next=` parameter is a parameter rather than a path.
  const cache = cacheOf(['/', '/history']);
  const sw = loadWorker({ fetch: () => Promise.reject(new Error('Failed to fetch')), match: cache.match });
  const out = await outcome(sw.request('/login?next=/history?status=closed'));
  await settle();
  assert.deepEqual(out.value, { body: 'cached /' }, 'a credentialed page was served for a login request');
});

await check('and the other half of that: a login screen is never stored in the first place', async () => {
  const answer = (res) => (request) => Promise.resolve({ ok: true, status: 200, clone: () => ({ body: 'copy' }), ...res(request) });
  const stored = [];
  const put = (req) => {
    stored.push(typeof req === 'string' ? req : req.path);
    return Promise.resolve();
  };

  // A page asked for without a credential: 302 → /login, followed by `fetch`, so `ok` is
  // true and the body is the login screen under the path that was wanted.
  const redirected = loadWorker({ put, fetch: answer(() => ({ redirected: true, url: 'http://127.0.0.1:4317/login' })) });
  await outcome(redirected.request('/history'));
  await settle();
  assert.deepEqual(stored, [], 'a login screen was cached under the page that was asked for');

  // And the page asked for by name, which is not a redirect at all.
  const byName = loadWorker({ put, fetch: answer(() => ({ redirected: false, url: 'http://127.0.0.1:4317/login' })) });
  await outcome(byName.request('/login'));
  await settle();
  assert.deepEqual(stored, [], 'the login page was cached by name');

  // The control, without which the two above pass against a `put` that is never called.
  const ordinary = loadWorker({ put });
  await outcome(ordinary.request('/history'));
  await settle();
  assert.deepEqual(stored, ['/history'], 'an ordinary page is stored, so the two refusals above mean something');
});

await check('a response that cannot be stored is relayed — a full phone stops caching silently', async () => {
  const sw = loadWorker({
    put: () => Promise.reject(new Error('QuotaExceededError: Quota exceeded.')),
  });
  const out = await outcome(sw.request('/app.js'));
  await settle();
  assert.ok(!out.error, 'the page must still get its response');
  assert.match(sw.posted[0]?.message || '', /a response could not be stored/);
  assert.match(sw.posted[0]?.message || '', /Quota exceeded/);
});

/* ------------------------------------------------------- what it must not do */

await check('the same failure twice inside the cooldown is relayed once', async () => {
  const sw = loadWorker({ put: () => Promise.reject(new Error('QuotaExceededError: Quota exceeded.')) });
  await outcome(sw.request('/app.js'));
  await settle();
  await outcome(sw.request('/style.css'));
  await settle();
  assert.equal(sw.posted.length, 1, `a worker with a full cache posted ${sw.posted.length} times`);
});

await check('no page open drops the report instead of throwing inside the reporter', async () => {
  const sw = loadWorker({ clients: [], addAll: () => Promise.reject(new Error('Request failed')) });
  const out = await outcome(sw.lifecycle('install'));
  await settle();
  assert.ok(out.error, 'the install must still fail');
  assert.equal(sw.posted.length, 0);
});

await check('clients.matchAll rejecting is not an error raised by the error reporter', async () => {
  const sw = loadWorker({ matchAllRejects: true, addAll: () => Promise.reject(new Error('Request failed')) });
  const out = await outcome(sw.lifecycle('install'));
  await settle();
  assert.equal(out.error?.message, 'Request failed', 'the install failure was replaced by the relay failure');
});

await check('only one page is told, so one failure is not two reports', async () => {
  const sw = loadWorker({
    clients: [{ id: 'background' }, { id: 'onscreen', focused: true }],
    addAll: () => Promise.reject(new Error('Request failed')),
  });
  await outcome(sw.lifecycle('install'));
  await settle();
  assert.equal(sw.posted.length, 1, 'every open tab reported the same worker failure');
  assert.equal(sw.posted[0].to, 'onscreen', 'the background tab was told instead of the one on screen');
});

await check('the global handlers are the backstop for anything not wrapped above', async () => {
  const sw = loadWorker();
  sw.fire('error', { message: 'Script error.', error: Object.assign(new Error('boom'), { stack: 'at sw.js:9:1' }) });
  await settle();
  assert.match(sw.posted[0]?.message || '', /^service worker — uncaught: boom/);
  sw.fire('unhandledrejection', { reason: new Error('a promise nobody awaited') });
  await settle();
  assert.match(sw.posted[1]?.message || '', /^service worker — unhandled rejection: a promise nobody awaited/);
});

/* ------------------------------------------------- the page end, and the whole wire */

await check('a relayed failure becomes POST /api/error, with the token and no page URL', async () => {
  const page = loadPage();
  assert.equal(page.started(), 1, 'startMessages() was not called — the listener would never fire');
  page.fromWorker({
    type: 'beadcause:sw-error',
    message: "service worker — install — the shell could not be cached (46 paths): Failed to execute 'addAll'",
    stack: 'TypeError\n    at http://127.0.0.1:4317/sw.js:262:8',
  });
  const [r] = page.reports();
  assert.ok(r, 'nothing was posted to the endpoint');
  assert.equal(r.body.kind, 'sw');
  assert.match(r.body.message, /^service worker — install/);
  assert.equal(r.headers['x-beadcause-token'], TOKEN, 'the report went out without the credential the worker has not got');
  assert.ok(!JSON.stringify(r.body).includes(TOKEN), 'the token reached the body of a report');
  assert.match(r.body.stack, /sw\.js:262/);
});

await check('a message that is not a relayed failure is ignored', async () => {
  const page = loadPage();
  page.fromWorker({ type: 'something-else', message: 'hello' });
  page.fromWorker(null);
  page.fromWorker({ type: 'beadcause:sw-error' });
  assert.equal(page.reports().length, 0);
});

await check('the report still leaves when the page cannot reach the daemon', async () => {
  const page = loadPage({ respond: () => Promise.reject(new Error('Failed to fetch')) });
  page.fromWorker({ type: 'beadcause:sw-error', message: 'service worker — install: Request failed' });
  await settle();
  assert.equal(page.reports().length, 1, 'a report that cannot be delivered must still be attempted, and then dropped');
});

/* ------------------------------------------------------------------ the seam */

await check('both files name the same message type', () => {
  const inWorker = /const REPORT_MESSAGE = '([^']+)'/.exec(SW_SOURCE);
  const inPage = /const SW_MESSAGE = '([^']+)'/.exec(REPORT_SOURCE);
  assert.ok(inWorker && inPage, 'one of the two constants has been renamed away');
  assert.equal(inWorker[1], inPage[1], 'the worker relays under a name the page does not listen for');
});

await check('the worker never posts to the endpoint itself', () => {
  assert.ok(!/\/api\/error/.test(SW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')), 'sw.js reaches for the endpoint it has no token for');
});

await check('two different worker failures fingerprint apart', () => {
  const install = fingerprint({ message: 'service worker — install: Request failed', kind: 'sw' });
  const quota = fingerprint({ message: 'service worker — cache — a response could not be stored: Quota exceeded.', kind: 'sw' });
  assert.notEqual(install.msgLabel, quota.msgLabel);
  assert.equal(install.atLabel, '', 'a source-less report must not key on a source');
  assert.equal(
    fingerprint({ message: 'x', source: '/sw.js' }).atLabel,
    fingerprint({ message: 'y', source: '/sw.js' }).atLabel,
    'and this is why: a constant source would fold every worker failure onto one bead'
  );
});

console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
