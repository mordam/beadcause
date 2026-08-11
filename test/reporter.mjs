#!/usr/bin/env node
/**
 * The browser's error reporter — what it files, and the six things it must not.
 *
 *     npm test
 *     node test/reporter.mjs
 *
 * `POST /api/error` and its dedupe are covered by test/apperrors.mjs; this is the other
 * end of the wire. It loads the real `public/report.js` in a vm with a hand-made
 * `window`, the way test/dictate.mjs and test/queue.mjs load the real modules they cover,
 * so a rewrite of the logic as a test-only copy cannot pass this while the phone ships
 * something else.
 *
 * The acceptance criteria first, directly: an uncaught exception, a rejected promise and
 * a failed fetch each arrive at the endpoint; the toast still appears when the report
 * cannot be sent; and no token reaches the body of a report.
 *
 * Then the false positives, which are the whole reason this file is long. Every one of
 * these is a **P0 bead** filed on a page that was working perfectly, and a tracker that
 * files those has been made useless by the feature meant to help it:
 *
 * 1. **A fetch abandoned on navigation.** A tap on the tab bar rejects every request in
 *    flight — one "Failed to fetch" per open poll, from a page whose only crime was
 *    being left.
 * 2. **An `AbortError`.** The long poll being torn down on purpose.
 * 3. **A 4xx.** The daemon declining on purpose: a 409 close gate, a 403 for a feature
 *    switched off in the config, a 401 that means sign in again.
 * 4. **The report's own request.** A report that reports the failure of reporting is a
 *    loop with no floor.
 * 5. **A refusal.** `toast(msg, 'refused')` is red because the app declined what you
 *    typed. "Give it a name" is not a bug.
 * 6. **A loop.** A render that throws on every frame, capped rather than uncapped.
 *
 * The last two checks are static reads of the pages, because the wiring is not something
 * a stub can see: that every page loads the file at all, and that each of the four copied
 * `toast` functions reports *after* it has drawn — a report before the DOM writes could
 * take the toast down with it, which is the one thing the reporter is not allowed to do.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { fingerprint, titleFor } from '../lib/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = (f) => path.join(ROOT, 'public', f);
const SOURCE = fs.readFileSync(PUBLIC('report.js'), 'utf8');

/** The token on the URL and in storage. If either reaches a bead, that is bc-sqab again. */
const TOKEN = 'sekrit-daemon-token-9f2c';

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
/**
 * One check. `await`ed at every call site, and that is not a style choice: half of these
 * drive the fetch wrapper, which is asynchronous, and a `check` that only *started* an
 * async body would report a pass for a promise nobody looked at.
 */
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

/**
 * The real file, in a room with nothing in it.
 *
 * `fetch` is a stub that records what it was called with and answers whatever the test
 * queued — the reporter binds it at load as `nativeFetch`, so this is both the transport
 * the reports leave by *and* the function the wrapper wraps. One stub is deliberately
 * both: it is the only way to prove the report's own request does not go back through
 * the wrapper.
 */
function load({ pathname = '/', respond = null, throwOnFetch = false } = {}) {
  const listeners = new Map();
  const calls = [];
  const window = {
    location: {
      // Everything sensitive about a page URL, all in one: the daemon token, and a
      // deep-link id that would file a bead per bead you opened.
      href: `http://127.0.0.1:4317${pathname}?t=${TOKEN}&id=bc-4f2#frag`,
      pathname,
      origin: 'http://127.0.0.1:4317',
    },
    navigator: { userAgent: 'test-agent/1' },
    localStorage: {
      getItem: (k) => (k === 'beadcause.token' ? TOKEN : null),
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    fetch: (input, init) => {
      calls.push({ input, init });
      if (throwOnFetch) throw new Error('fetch itself is broken');
      return respond ? respond(input, init) : Promise.resolve({ status: 200, ok: true });
    },
  };
  const ctx = vm.createContext({ window, URL, setTimeout, clearTimeout, console });
  vm.runInContext(SOURCE, ctx, { filename: 'report.js' });
  const fire = (type, event) => {
    const fn = listeners.get(type);
    assert.ok(fn, `nothing listens for ${type}`);
    return fn(event);
  };
  /** Only the reports. The wrapper's own traffic is in `calls` beside them. */
  const reports = () =>
    calls
      .filter((c) => c.input === '/api/error')
      .map((c) => ({ headers: c.init.headers, body: JSON.parse(c.init.body), init: c.init }));
  return { window, ctx, calls, reports, fire, report: ctx.window.beadcause.report };
}

/** An Error made in this realm — which is not the vm's, and that is the point. */
const err = (message, stack) => Object.assign(new Error(message), stack ? { stack } : {});

/* -------------------------------------------------- the acceptance criteria */

await check('an uncaught exception arrives at the endpoint', () => {
  const app = load();
  app.fire('error', {
    message: 'Cannot read properties of undefined (reading id)',
    filename: 'http://127.0.0.1:4317/app.js?v=32',
    lineno: 3315,
    colno: 9,
    error: err('Cannot read properties of undefined (reading id)', 'TypeError: x\n    at render (http://127.0.0.1:4317/app.js:3315:9)'),
  });
  const [r] = app.reports();
  assert.ok(r, 'nothing was posted');
  assert.equal(r.body.kind, 'error');
  assert.match(r.body.message, /Cannot read properties/);
  assert.equal(r.body.source, 'http://127.0.0.1:4317/app.js?v=32');
  assert.equal(r.body.line, 3315);
  assert.equal(r.body.column, 9);
  assert.match(r.body.stack, /at render/);
  assert.match(r.body.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(r.body.userAgent, 'test-agent/1');
});

await check('a rejected promise arrives at the endpoint', () => {
  const app = load();
  app.fire('unhandledrejection', { reason: err('bd is locked', 'Error: bd is locked\n    at sweep (http://127.0.0.1:4317/app.js:900:3)') });
  const [r] = app.reports();
  assert.ok(r, 'nothing was posted');
  assert.equal(r.body.kind, 'rejection');
  assert.match(r.body.message, /unhandled rejection — bd is locked/);
  assert.match(r.body.stack, /at sweep/);
});

await check('a rejection of something that is not an Error still says what it was', () => {
  const app = load();
  app.fire('unhandledrejection', { reason: { status: 500, why: 'no' } });
  const [r] = app.reports();
  assert.ok(r, 'nothing was posted');
  assert.match(r.body.message, /"status":500/);
});

await check('a failed fetch arrives at the endpoint, named by its path', async () => {
  const app = load({ respond: () => Promise.reject(err('Failed to fetch')) });
  await app.window.fetch('/api/questions?scope=human&t=' + TOKEN).then(
    () => assert.fail('the wrapper swallowed the rejection'),
    () => {}
  );
  const [r] = app.reports();
  assert.ok(r, 'nothing was posted');
  assert.equal(r.body.kind, 'fetch');
  // The path, never the query: `?id=bc-4f2` would file a bead per bead you opened, and
  // the query is also the one place the token rides.
  assert.equal(r.body.message, 'GET /api/questions failed — Failed to fetch');
  assert.equal(r.body.source, '/api/questions');
});

await check('a 500 is reported and the response still reaches the caller', async () => {
  const app = load({ respond: () => Promise.resolve({ status: 500, ok: false }) });
  const res = await app.window.fetch('/api/answer', { method: 'post' });
  assert.equal(res.status, 500, 'the wrapper must be transparent');
  const [r] = app.reports();
  assert.ok(r, 'nothing was posted');
  assert.equal(r.body.message, 'POST /api/answer failed — HTTP 500');
});

await check('the toast still happens when the report cannot be sent', () => {
  // Every shape of broken transport at once: `fetch` throwing where it should reject.
  // Reporting a toast must come back false rather than throwing into the toast function,
  // which has already drawn and has no catch.
  const app = load({ throwOnFetch: true });
  assert.equal(app.report.toast('could not save that'), true, 'a broken transport must not look like a refused report');
  const worse = load({ respond: () => Promise.reject(err('nope')) });
  assert.doesNotThrow(() => worse.report.toast('could not save that'));
  assert.doesNotThrow(() => worse.fire('error', { message: 'boom' }));
});

await check('no token reaches the body of a report', () => {
  const app = load({ pathname: '/console' });
  app.fire('error', {
    // Both leaks in one: a message quoting a URL, and a stack frame inside the document,
    // which is the one frame that carries the page's own query string.
    message: `GET http://127.0.0.1:4317/api/bead?id=bc-4f2&t=${TOKEN} failed`,
    filename: `http://127.0.0.1:4317/console?t=${TOKEN}`,
    lineno: 12,
    error: err('x', `Error: x\n    at onclick (http://127.0.0.1:4317/console?t=${TOKEN}:12:5)`),
  });
  const [r] = app.reports();
  assert.ok(r, 'nothing was posted');
  const body = JSON.stringify(r.body);
  assert.ok(!body.includes(TOKEN), `the token is in the report: ${body}`);
  assert.match(body, /REDACTED/);
  // The page is its path and nothing else — not `location.href`, which is a credential.
  assert.equal(r.body.url, '/console');
  assert.ok(!body.includes('#frag'), 'the fragment travelled with the report');
  // The token still goes as a header. That is how the daemon knows the report is yours;
  // what must never happen is it going in the body, which is what becomes a bead.
  assert.equal(r.headers['x-beadcause-token'], TOKEN);
});

/* ------------------------------------------------------- the false positives */

await check('a fetch abandoned by a navigation is not reported', async () => {
  const app = load({ respond: () => Promise.reject(err('Failed to fetch')) });
  app.fire('pagehide', {});
  await app.window.fetch('/api/poll').catch(() => {});
  assert.deepEqual(app.reports(), [], 'a tab tap filed a bead');
  // And nothing else gets through either, for as long as the page is leaving.
  app.fire('error', { message: 'boom on the way out' });
  assert.deepEqual(app.reports(), []);
});

await check('an aborted fetch is not reported', async () => {
  const app = load({ respond: () => Promise.reject(Object.assign(err('The operation was aborted'), { name: 'AbortError' })) });
  await app.window.fetch('/api/poll').catch(() => {});
  assert.deepEqual(app.reports(), [], 'tearing down the long poll filed a bead');
});

await check('an aborted fetch is not reported when the error forgot to say so', async () => {
  const controller = { aborted: true };
  const app = load({ respond: () => Promise.reject(err('Failed to fetch')) });
  await app.window.fetch('/api/poll', { signal: controller }).catch(() => {});
  assert.deepEqual(app.reports(), []);
});

await check('a 4xx is not reported', async () => {
  for (const status of [400, 401, 403, 404, 409, 428]) {
    const app = load({ respond: () => Promise.resolve({ status, ok: false }) });
    await app.window.fetch('/api/answer', { method: 'POST' });
    assert.deepEqual(app.reports(), [], `HTTP ${status} filed a bead`);
  }
});

await check('the report request does not go back through the wrapper', async () => {
  // The endpoint answering 500 is the case that would loop: the wrapper would see a 5xx,
  // report it, see that report fail, and so on with nothing to stop it.
  const app = load({ respond: () => Promise.resolve({ status: 500, ok: false }) });
  app.fire('error', { message: 'the first error' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.reports().length, 1, 'the reporter reported its own reporting');
});

await check('a cross-origin fetch is not reported', async () => {
  const app = load({ respond: () => Promise.reject(err('Failed to fetch')) });
  await app.window.fetch('https://api.github.com/repos/x/y').catch(() => {});
  assert.deepEqual(app.reports(), [], "somebody else's URL reached a bead");
});

await check('the same error twice in a row is reported once', () => {
  const app = load();
  app.fire('error', { message: 'the same boom', filename: '/app.js', lineno: 7 });
  app.fire('error', { message: 'the same boom', filename: '/app.js', lineno: 7 });
  app.fire('error', { message: 'the same boom', filename: '/app.js', lineno: 7 });
  assert.equal(app.reports().length, 1);
});

await check('a loop that throws every frame is capped', () => {
  const app = load();
  assert.equal(app.report.capacity(), 8, 'the cap moved — this suite and README say 8');
  for (let i = 0; i < 40; i += 1) {
    app.fire('error', { message: `a distinct failure ${String.fromCharCode(97 + (i % 26))}${i}`, filename: '/app.js', lineno: i });
  }
  assert.equal(app.reports().length, 8, 'the per-minute ceiling did not hold');
  assert.equal(app.report.capacity(), 0);
});

await check('a toast repeating a fetch failure is not a second bead', async () => {
  const app = load({ respond: (input) => (input === '/api/error' ? Promise.resolve({ status: 200, ok: true }) : Promise.reject(err('Failed to fetch'))) });
  await app.window.fetch('/api/questions').catch(() => {});
  assert.equal(app.reports().length, 1);
  // What `api()` does next: throws, and the caller toasts the error's own message.
  app.report.toast('Failed to fetch');
  assert.equal(app.reports().length, 1, 'one incident became two beads');
});

/* -------------------------------------------------------------------- toasts */

await check('a toast reports from the line that decided to show it, not from the toast', () => {
  const app = load();
  // Both dialects, because the phone is the reporter this exists for and the phone runs
  // Safari. If the filter misses, the fingerprint lands on the toast function itself —
  // the same line for every failure on the page — and collapses every red toast on the
  // inbox into one bead.
  app.report.toast('could not save: bd is locked');
  const [r] = app.reports();
  assert.ok(r, 'nothing was posted');
  assert.equal(r.body.kind, 'toast');
  assert.equal(r.body.message, 'could not save: bd is locked');
  if (r.body.stack) {
    assert.ok(!/report\.js/.test(r.body.stack), `report.js is still in the stack:\n${r.body.stack}`);
    assert.ok(!/\bat (?:Object\.)?(?:toast|fromToast)\b/.test(r.body.stack), 'the toast frame is still on top');
  }
});

await check('the frame filter drops both stack dialects', () => {
  // The filter itself, against real stacks from both engines, since a vm stack has
  // neither shape. This is the regex the check above cannot reach.
  const v8 = [
    'Error: report',
    '    at fromToast (http://127.0.0.1:4317/report.js:300:20)',
    '    at toast (http://127.0.0.1:4317/app.js:3823:41)',
    '    at submit (http://127.0.0.1:4317/app.js:4234:9)',
  ].join('\n');
  const webkit = ['fromToast@http://127.0.0.1:4317/report.js:300:20', 'toast@http://127.0.0.1:4317/app.js:3823:41', 'submit@http://127.0.0.1:4317/app.js:4234:9'].join('\n');
  const filter = (raw) =>
    String(raw)
      .split('\n')
      .filter((line) => {
        if (/^\s*[A-Za-z]*Error\b/.test(line)) return false;
        if (/\breport\.js\b/.test(line)) return false;
        if (/^\s*at\s+(?:Object\.)?(?:toast|fromToast)\b/.test(line)) return false;
        if (/^\s*(?:toast|fromToast)@/.test(line)) return false;
        return true;
      })
      .join('\n')
      .trim();
  // Kept honest against the real thing: the predicate above is copied out of report.js,
  // so a change there that this does not see is a change this asserts about nothing.
  const live = SOURCE.slice(SOURCE.indexOf('function callerStack()'));
  for (const rule of ['\\breport\\.js\\b', '(?:toast|fromToast)@']) {
    assert.ok(live.includes(rule), `callerStack no longer filters on ${rule} — update this check`);
  }
  // `.trim()` takes the indent off the first surviving frame, which is why this is not
  // the line as V8 wrote it. The daemon's frameFromStack anchors on the tail, not the
  // indent, so the trim costs nothing (lib/errors.js).
  assert.equal(filter(v8), 'at submit (http://127.0.0.1:4317/app.js:4234:9)');
  assert.equal(filter(webkit), 'submit@http://127.0.0.1:4317/app.js:4234:9');
});

/* ------------------------------------------------------ the seam to the daemon */

/**
 * What the daemon makes of exactly what the reporter sends.
 *
 * The two halves landed as two beads a day apart, and the payload between them is a bare
 * JSON object with no schema anywhere — so the failure to guard against is not either
 * half being wrong, it is them drifting apart while both stay green. This runs the real
 * `fingerprint` and `titleFor` from lib/errors.js over the real bodies the real reporter
 * built above, which is the only place the two shapes meet.
 *
 * The fingerprint is what matters, not the title: it is what decides between a new P0 and
 * a comment on the one that already covers it. A payload the fingerprinter cannot read
 * comes out with an empty `at`, every report falls back to the message key, and two bugs
 * that happen to say "Failed to fetch" become one bead. Nothing would look wrong.
 */
await check('the daemon can fingerprint every payload the reporter builds', () => {
  const app = load();
  app.fire('error', {
    message: 'Cannot read properties of undefined (reading id)',
    filename: 'http://127.0.0.1:4317/app.js?v=32',
    lineno: 3315,
    colno: 9,
  });
  app.fire('unhandledrejection', {
    reason: err('bd is locked', 'Error: bd is locked\n    at sweep (http://127.0.0.1:4317/console.js:900:3)'),
  });
  const [exception, rejection] = app.reports().map((r) => r.body);

  // An exception knows its own file and line, because the browser hands both over.
  const one = fingerprint(exception);
  assert.equal(one.at, 'app.js:3315');
  assert.ok(one.atLabel && one.msgLabel, 'both keys are needed for the either-label lookup');
  assert.match(titleFor(exception, one), /^Cannot read properties.*— app\.js:3315$/);

  // A rejection carries only a stack, and the daemon reads the frame out of it. This is
  // the payload that would silently lose its primary key if the reporter ever stopped
  // sending a stack, or sent a filtered one with no frames left.
  const two = fingerprint(rejection);
  assert.equal(two.at, 'console.js:900');

  // And a fetch failure names the endpoint, from `source` rather than from any frame:
  // "Failed to fetch" thrown inside api() has a stack that points at api(), the same
  // line for every endpoint in the app.
  const fetchReport = { message: 'GET /api/questions failed — Failed to fetch', source: '/api/questions' };
  assert.equal(fingerprint(fetchReport).at, 'api/questions');
});

/* --------------------------------------------------------- the wiring, on disk */

const PAGES = fs
  .readdirSync(path.join(ROOT, 'public'))
  .filter((f) => f.endsWith('.html'))
  .sort();

await check('every page loads the reporter, ahead of every other script', () => {
  assert.ok(PAGES.length >= 12, `only found ${PAGES.length} pages`);
  for (const page of PAGES) {
    const html = fs.readFileSync(PUBLIC(page), 'utf8');
    const mine = html.indexOf('<script src="/report.js">');
    assert.ok(mine > 0, `${page} does not load /report.js — its errors are still lost`);
    const first = html.indexOf('<script');
    assert.equal(mine, first, `${page} loads something before /report.js, which cannot catch what loaded first`);
  }
});

/** The four copies of `toast`, which is the whole of why the reporter is one file. */
const TOASTERS = ['app.js', 'console.js', 'foundations.js', 'term.js'];

await check('each of the four toasts reports, and reports last', () => {
  for (const file of TOASTERS) {
    const src = fs.readFileSync(PUBLIC(file), 'utf8');
    const call = src.indexOf('window.beadcause?.report?.toast?.(msg)');
    assert.ok(call > 0, `${file}'s toast does not report — a red toast there is still lost`);
    // After the toast is on screen. A report built before the DOM writes could, if this
    // file is ever wrong about never throwing, take the toast down with it.
    const shown = src.indexOf('hidden = false');
    assert.ok(shown > 0 && shown < call, `${file} reports before it draws the toast`);
    assert.ok(src.includes('bad === true'), `${file} reports every red toast, including a refusal`);
  }
});

await check('no refusal is filed as a failure', () => {
  // `toast('some literal', true)` is the shape of a validation message — "Give it a
  // name", "Write something first" — and `true` files it as a P0 bug. Those pass
  // `'refused'`, which is red and files nothing.
  const literal = /\btoast\(\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*,\s*true\s*\)/g;
  for (const file of TOASTERS) {
    const src = fs.readFileSync(PUBLIC(file), 'utf8');
    const hits = src.match(literal) || [];
    assert.deepEqual(hits, [], `${file}: a fixed message filed as a failure — ${hits.join(', ')}`);
  }
});

await check('a refusal is still red', () => {
  // `classList.toggle('bad', …)` has to see a boolean, or a third state that is truthy
  // would be relying on the DOM's coercion to stay red.
  for (const file of TOASTERS) {
    const src = fs.readFileSync(PUBLIC(file), 'utf8');
    assert.match(src, /classList\.toggle\('bad', Boolean\(bad\)\)/, `${file} does not coerce bad`);
  }
});

/* ------------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
