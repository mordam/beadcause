#!/usr/bin/env node
/**
 * The warm layer — the app loaded once, kept, and refreshed by deltas.
 *
 *     npm test
 *     node test/warm.mjs
 *
 * Five standing views, five documents. Tapping a tab used to be a navigation that
 * threw the page away and re-fetched everything the next one needed before it could
 * draw a row — on the two heaviest views, a `bd` sweep across seven workspaces, paid
 * on every tap. `public/warm.js` keeps what each view booted from and paints it in the
 * first frame; `/api/poll` — which parks until the daemon's sequence moves and only
 * then sweeps — is what keeps the inbox current instead of a 25-second timer.
 *
 * Everything here fails silently if it breaks, which is why it is a suite:
 *
 * 1. **The store hands back what went in, and nothing else.** A cache that returns a
 *    payload from before the TTL, or half of one, or one written by a version that
 *    stored a different shape, is a screen showing something that is not true — and it
 *    looks exactly like a screen showing something that is. Every failure has to read
 *    as a miss, because a miss is the case every caller already handles.
 *
 * 2. **A quota or a private window must not take the app with it.** `sessionStorage`
 *    throws on write in more browsers than it does not, and the file's whole promise is
 *    that a page which cannot warm is merely as fast as it was yesterday.
 *
 * 3. **The reconciler keeps what did not change.** `plan()` is the decision half of
 *    the repaint, and getting it wrong is invisible in the direction that matters: a
 *    card wrongly kept is a card that has silently stopped updating. It is checked in
 *    both directions, including the one that must bail — a repeated key.
 *
 * 4. **The background warm cannot become a sweep per page load.** It skips the view it
 *    is on, dedupes the paths two views share, skips anything fetched inside the floor,
 *    and runs once per document. Each of those is one line, and losing any of them
 *    costs the Mac several `bd` sweeps a minute for tabs nobody tapped.
 *
 * 5. **`/api/poll` and `/api/questions` answer with the same screen.** They did not
 *    used to — the poll carried the rows and the spaces and none of the filter, the
 *    counts or the notification prompt — which is exactly why the inbox re-fetched the
 *    whole list rather than adopting the poll it had already been handed. If they drift
 *    apart again, the poll-driven refresh silently draws a slightly different inbox from
 *    the one a reload gives you. Checked as a set comparison, not by reading two files.
 *
 * 6. **A poll with nothing to say costs no `bd` at all.** The saving is not that the
 *    sweep is faster, it is that the quiet case does not sweep — so it is asserted as
 *    *no calls to `bd`*, against a `bd` that records every invocation.
 *
 * The client half runs the real `public/warm.js` in a vm with a hand-made
 * `sessionStorage`, the way test/queue.mjs runs the real send queue: a rewrite of the
 * logic as a test-only module could pass this while the phone shipped something else.
 * `paint()` itself is a named skip at the end — it is a dozen lines of `insertBefore`
 * over what `plan` returns, and testing it here would mean shipping a DOM.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-warm-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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
function skip(name, why) {
  console.log(`  \x1b[90m·\x1b[0m ${name} — ${why}`);
}

/* Everything the file hands back was built by the vm realm's own `Object`, so a strict
   deep-equal against a host literal fails on the prototype alone. Copied across before
   comparing — the values are what is being checked. */
const plain = (o) => JSON.parse(JSON.stringify(o));

console.log('\nwarm layer');

/* ============================================================== the client half */

/**
 * The real file, in a room with the two things it touches at load: a `window` to hang
 * itself off and a `sessionStorage` to keep things in.
 *
 * The storage is a Map with the browser's own quirks put back — `getItem` answers null
 * rather than undefined for a miss, `key(i)` is how the file enumerates — plus a switch
 * to make writing throw, which is the case the whole no-op path exists for.
 */
function load({ quota = Infinity, brokenStorage = false } = {}) {
  const bag = new Map();
  const storage = {
    get length() {
      return bag.size;
    },
    key: (i) => [...bag.keys()][i] ?? null,
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem(k, v) {
      if (brokenStorage) throw new Error('SecurityError');
      if (bag.size >= quota && !bag.has(k)) throw new Error('QuotaExceededError');
      bag.set(k, String(v));
    },
    removeItem: (k) => void bag.delete(k),
  };
  const window = { beadcause: {} };
  const ctx = vm.createContext({
    window,
    sessionStorage: storage,
    document: { hidden: false },
    setTimeout,
    clearTimeout,
    JSON,
    Date,
    Number,
    Boolean,
    Array,
    Set,
    Map,
    WeakMap,
  });
  vm.runInContext(read('public/warm.js'), ctx, { filename: 'warm.js' });
  return { warm: ctx.window.beadcause.warm, bag };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- 1. the store */

await check('a payload comes back exactly as it went in, with the sequence it was true at', () => {
  const { warm } = load();
  warm.write('/api/questions?scope=human', { questions: [{ key: 'beadcause/bc-1' }] }, 41);
  const hit = warm.read('/api/questions?scope=human');
  assert.deepEqual(plain(hit.data), { questions: [{ key: 'beadcause/bc-1' }] });
  assert.equal(hit.seq, 41, 'the sequence is what lets the refresh be a poll rather than a sweep');
});

await check('a path never written reads as a miss, not as an empty payload', () => {
  const { warm } = load();
  assert.equal(warm.read('/api/work'), null);
});

await check('past its TTL it is a miss — and it is dropped rather than left taking up room', () => {
  const { warm, bag } = load();
  warm.write('/api/work', { workspaces: [] });
  // Reading with a `now` far enough into the future is the same entry, aged.
  assert.equal(warm.read('/api/work', { now: Date.now() + warm.TTL_MS + 1 }), null);
  assert.equal(bag.size, 0, 'an entry that can never be useful again must not keep its quota');
});

await check('an entry from the future is a miss too — a clock that went backwards is not a cache', () => {
  const { warm } = load();
  warm.write('/api/work', { workspaces: [] });
  assert.equal(warm.read('/api/work', { now: Date.now() - 60_000 }), null);
});

await check('a half-written or foreign entry reads as a miss and is dropped', () => {
  const { warm, bag } = load();
  bag.set('beadcause.warm:/api/work', '{not json');
  assert.equal(warm.read('/api/work'), null);
  assert.equal(bag.size, 0);
  // The shape check as well as the parse: a version that stored a bare payload rather
  // than `{at, seq, data}` would otherwise come back with `undefined` for everything.
  bag.set('beadcause.warm:/api/work', JSON.stringify({ workspaces: [] }));
  assert.equal(warm.read('/api/work'), null);
});

await check('forget() clears what we hold and leaves everything else in the storage alone', () => {
  const { warm, bag } = load();
  bag.set('beadcause.token', 'not ours');
  warm.write('/api/work', { workspaces: [] });
  warm.write('/api/admin', { scopes: [] });
  assert.equal(warm.keys().length, 2);
  warm.forget();
  assert.deepEqual([...bag.keys()], ['beadcause.token'], 'only our own prefix may be swept');
});

await check('fresh() is the floor the background warm reads, not the TTL', () => {
  const { warm } = load();
  warm.write('/api/prs', { repos: [] });
  assert.equal(warm.fresh('/api/prs'), true);
  assert.equal(warm.fresh('/api/prs', warm.PREWARM_FLOOR_MS, Date.now() + warm.PREWARM_FLOOR_MS + 1), false);
  assert.equal(warm.fresh('/api/consoles'), false, 'never fetched is never fresh');
});

/* ------------------------------------------------ 2. a storage that will not have it */

await check('a browser that refuses the storage says so, and every call is a safe no-op', () => {
  const { warm } = load({ brokenStorage: true });
  assert.equal(warm.available, false);
  assert.equal(warm.write('/api/work', { workspaces: [] }), false);
  assert.equal(warm.read('/api/work'), null);
  assert.deepEqual(plain(warm.keys()), []);
  warm.forget(); // must not throw
});

await check('a full quota throws the lot away rather than failing every write forever', () => {
  const { warm, bag } = load({ quota: 2 });
  warm.write('/api/work', { workspaces: [] });
  warm.write('/api/admin', { scopes: [] });
  assert.equal(bag.size, 2);
  assert.equal(warm.write('/api/prs', { repos: [] }), false);
  assert.equal(bag.size, 0, 'the entries we hold are the reason there is no room');
});

await check('something un-JSONable is refused without clearing anything', () => {
  const { warm, bag } = load();
  warm.write('/api/work', { workspaces: [] });
  const circular = {};
  circular.self = circular;
  assert.equal(warm.write('/api/admin', circular), false);
  assert.equal(bag.size, 1, 'one bad payload is not a reason to drop a good one');
});

/* --------------------------------------------------------- 3. the keyed repaint */

const chunk = (key, html) => ({ key, html });

await check('a list that did not change is kept in full — nothing is touched', () => {
  const { warm } = load();
  const list = [chunk('a', '<article>1</article>'), chunk('b', '<article>2</article>')];
  const step = warm.plan(list, list);
  assert.deepEqual(
    plain(step.ops).map((o) => o.action),
    ['keep', 'keep']
  );
  assert.deepEqual(plain(step.removed), []);
});

await check('one card changed replaces exactly that one', () => {
  const { warm } = load();
  const before = [chunk('a', '<article>1</article>'), chunk('b', '<article>2</article>')];
  const after = [chunk('a', '<article>1</article>'), chunk('b', '<article>2 answered</article>')];
  assert.deepEqual(
    plain(warm.plan(before, after)).ops.map((o) => `${o.key}:${o.action}`),
    ['a:keep', 'b:replace']
  );
});

await check('a new bead inserts and a closed one is removed, and neither disturbs the rest', () => {
  const { warm } = load();
  const before = [chunk('a', '<i>1</i>'), chunk('b', '<i>2</i>')];
  const after = [chunk('a', '<i>1</i>'), chunk('c', '<i>3</i>')];
  const step = plain(warm.plan(before, after));
  assert.deepEqual(
    step.ops.map((o) => `${o.key}:${o.action}`),
    ['a:keep', 'c:insert']
  );
  assert.deepEqual(step.removed, ['b']);
});

await check('a reorder is two keeps, not two rebuilds — sinking an answered card must be free', () => {
  const { warm } = load();
  const before = [chunk('a', '<i>1</i>'), chunk('b', '<i>2</i>')];
  const after = [chunk('b', '<i>2</i>'), chunk('a', '<i>1</i>')];
  const step = plain(warm.plan(before, after));
  assert.deepEqual(
    step.ops.map((o) => o.action),
    ['keep', 'keep']
  );
  assert.deepEqual(step.removed, []);
});

await check('a node this file did not paint is replaced, never kept', () => {
  // `html: undefined` is what the reconciler sees after a raw rebuild — a node whose
  // contents it has no record of. Treating that as a match is how a card would freeze.
  const { warm } = load();
  const step = plain(warm.plan([{ key: 'a', html: undefined }], [chunk('a', '<i>1</i>')]));
  assert.deepEqual(step.ops[0].action, 'replace');
});

await check('a repeated key bails to a whole-list rebuild rather than guessing', () => {
  const { warm } = load();
  const step = warm.plan([], [chunk('a', '<i>1</i>'), chunk('a', '<i>2</i>')]);
  assert.equal(step.ops, null, 'two chunks claiming one identity cannot both be placed');
  assert.match(String(step.bail), /duplicate/);
});

await check('the panes that are not beads have keys a bead can never collide with', () => {
  // `@shade`, `@requests`, `@empty` against `workspace/id`. One `@` is what keeps the
  // two namespaces apart, so it is asserted rather than left to a comment.
  const app = read('public/app.js');
  for (const key of ['@shade', '@requests', '@empty']) {
    assert.ok(app.includes(`key: '${key}'`), `${key} is no longer the key the inbox uses`);
  }
});

/* ------------------------------------------------------ 4. the background warm */

/** A recording `api`, so what the warm asked for is a list rather than a guess. */
function tracker({ fail = [] } = {}) {
  const asked = [];
  return {
    asked,
    api: async (path) => {
      asked.push(path);
      if (fail.includes(path)) throw new Error('nope');
      return { path, seq: 7 };
    },
  };
}

await check('it warms the other views and never the one it is on', async () => {
  const { warm } = load();
  const t = tracker();
  warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  await tick(20);
  assert.ok(!t.asked.includes('/api/questions?scope=human'), 'the inbox does not warm its own payload');
  assert.deepEqual(t.asked, ['/api/consoles', '/api/prs', '/api/work', '/api/admin']);
});

await check('a path two views share is fetched once, not twice', async () => {
  const { warm } = load();
  const t = tracker();
  // From the PR board, both /api/work (advocates and admin) and the inbox sweep
  // (inbox and advocates) are wanted by more than one view.
  warm.prewarm({ here: 'prs', api: t.api, delay: 0 });
  await tick(20);
  assert.deepEqual(t.asked, ['/api/questions?scope=human', '/api/consoles', '/api/work', '/api/admin']);
  assert.equal(new Set(t.asked).size, t.asked.length, 'a `bd` sweep must not be paid for twice');
});

await check('what is already fresh is left alone', async () => {
  const { warm } = load();
  warm.write('/api/work', { workspaces: [] });
  const t = tracker();
  warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  await tick(20);
  assert.ok(!t.asked.includes('/api/work'), 'fetched inside the floor is not fetched again');
});

await check('what it fetched is kept, with the sequence off the payload', async () => {
  const { warm } = load();
  const t = tracker();
  warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  await tick(20);
  assert.equal(warm.read('/api/prs').seq, 7);
});

await check('one path failing leaves the rest of them warm', async () => {
  const { warm } = load();
  const t = tracker({ fail: ['/api/consoles'] });
  warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  await tick(20);
  assert.equal(warm.read('/api/consoles'), null);
  assert.ok(warm.read('/api/admin'), 'one cold tab, not four');
});

await check('it runs once per document — a page open all afternoon does not re-sweep on a timer', async () => {
  const { warm } = load();
  const t = tracker();
  warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  await tick(20);
  warm.forget();
  warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  await tick(20);
  assert.equal(t.asked.length, 4, 'a tab switch is a new document, and that is what re-warms');
});

await check('a screen that has gone dark stops it — a phone in a pocket warms nothing', async () => {
  const bag = new Map();
  // Same room as `load`, with a document that says the page is hidden.
  const ctx = vm.createContext({
    window: { beadcause: {} },
    sessionStorage: {
      get length() {
        return bag.size;
      },
      key: (i) => [...bag.keys()][i] ?? null,
      getItem: (k) => (bag.has(k) ? bag.get(k) : null),
      setItem: (k, v) => void bag.set(k, String(v)),
      removeItem: (k) => void bag.delete(k),
    },
    document: { hidden: true },
    setTimeout,
    clearTimeout,
    JSON,
    Date,
    Number,
    Boolean,
    Array,
    Set,
    Map,
    WeakMap,
  });
  vm.runInContext(read('public/warm.js'), ctx, { filename: 'warm.js' });
  const t = tracker();
  ctx.window.beadcause.warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  await tick(20);
  assert.deepEqual(t.asked, []);
});

/* -------------------------------------------------------------- the wiring */

await check('every standing page loads the file, or that page is the one cold tab', () => {
  for (const page of ['index.html', 'console.html', 'prs.html', 'monitor.html', 'admin.html']) {
    assert.ok(read(`public/${page}`).includes('/warm.js'), `${page} does not load warm.js`);
  }
});

await check('and it is loaded before the page script that asks it for a list', () => {
  for (const [page, script] of [
    ['index.html', '/app.js'],
    ['console.html', '/console.js'],
    ['prs.html', '/prs.js'],
    ['monitor.html', '/monitor.js'],
    ['admin.html', '/admin.js'],
  ]) {
    const html = read(`public/${page}`);
    assert.ok(html.indexOf('/warm.js') < html.indexOf(script), `${page} loads ${script} first`);
  }
});

await check('the service worker ships it, or a cached page has no warm layer', () => {
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/warm.js'"), 'not in SHELL');
  // The version is what makes the new file and the pages that need it arrive together.
  assert.ok(/const CACHE = 'beadcause-v(2[3-9]|[3-9]\d)'/.test(sw), 'CACHE was not bumped past v22');
});

await check('VIEWS names every tab the bar draws — a view missed here is a tab left cold', () => {
  const { warm } = load();
  // The tab entries are written both inline and across several lines, so the match
  // has to reach over whatever sits between the id and the href it belongs to.
  const ids = [...read('public/tabbar.js').matchAll(/\bid: '([a-z]+)',[\s\S]{0,80}?href:/g)].map((m) => m[1]);
  assert.ok(ids.length >= 4, 'could not read the tab list out of tabbar.js');
  const views = plain(warm.VIEWS).map((v) => v.id);
  // Every tab has a view, in the bar's order — that is the invariant, and it is the
  // one that fails as "one tab is slower than the others" if a tab is added and
  // forgotten here.
  assert.deepEqual(
    views.filter((id) => ids.includes(id)),
    ids,
    'warm.js and tabbar.js disagree about what the views are'
  );
  // The other direction is not equality any more, and deliberately: bc-l8jp.5 took
  // the Chat tab off the bar without taking the page away, so `console` is a standing
  // view with no tab. Named rather than waved through, because an id that turns up
  // here and is not on this list is the mistake the equality used to catch — a view
  // being warmed for a page that no longer exists.
  assert.deepEqual(
    views.filter((id) => !ids.includes(id)),
    ['console'],
    'a warmed view with no tab behind it, and not the one we know about'
  );
});

await check('the inbox draws its list through the reconciler, not through innerHTML', () => {
  const app = read('public/app.js');
  assert.ok(app.includes('paintList(chunks)'), 'render() no longer paints keyed chunks');
  // The fallback assignment inside paintList is the only one allowed to remain: it is
  // what a phone holding a service worker from before warm.js existed still runs.
  const assignments = [...app.matchAll(/listEl\.innerHTML =/g)].length;
  assert.equal(assignments, 1, `${assignments} whole-list rebuilds left in app.js`);
});

await check('the inbox follows the event log rather than sweeping on a 25-second clock', () => {
  const app = read('public/app.js');
  assert.ok(/\/api\/poll\?since=\$\{at\}/.test(app), 'the long poll is gone from app.js');
  // The timer is still here and must be: it is what a wide scope and an old daemon
  // fall back to. What must not come back is `load` being the only thing on it.
  assert.ok(app.includes('POLL_MS[state.scope]'), 'the fallback timer is gone');
});

skip('paint() against a real DOM', 'a dozen lines of insertBefore over plan(); a DOM here would test a parser');

/* ============================================================== the server half */

const { createApp, listen } = await import(path.join(ROOT, 'lib', 'server.js'));

const WS = path.join(tmp, 'beads', 'beadcause', '.beads');
fs.mkdirSync(WS, { recursive: true });
const CALLS = path.join(tmp, 'bd-calls.log');

/**
 * A `bd` that answers nothing and records that it was asked.
 *
 * `.cjs` deliberately: it is spawned by absolute path from a temp directory, and the
 * extension is the only thing that settles how node parses it.
 */
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(CALLS)}, process.argv.slice(2).join(' ') + '\\n');
console.log('[]');
`,
  { mode: 0o755 }
);
const bdCalls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean) : []);

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'warm-test-token',
  actor: 'beadcause-test',
  bdBin: BD,
  workspaces: [{ name: 'beadcause', dir: WS }],
  spaces: [{ name: 'Personal', workspaces: ['beadcause'] }],
  // An hour, so the background poller cannot sweep in the middle of the quiet-poll
  // check and make a `bd` call this suite would blame on the endpoint.
  pollSeconds: 3600,
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  terminal: false,
  agents: [],
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const servers = listen(cfg, createApp(cfg).handler);
const PORT = await boundPort(servers);
const get = async (p) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'x-beadcause-token': cfg.token } });
  return { status: res.status, body: await res.json() };
};

const questions = await get('/api/questions?scope=human');

await check('/api/questions says where in the event log its list was true', () => {
  assert.equal(questions.status, 200);
  assert.equal(typeof questions.body.seq, 'number', 'without this the inbox cannot start a long poll');
});

const cold = await get('/api/poll');

await check('/api/poll answers with the same screen /api/questions does', () => {
  // The whole reason the inbox can refresh itself from the poll. A field on one and
  // not the other is a refresh that draws a subtly different inbox from a reload —
  // no counts on the chrome, or a filter it does not obey — and nothing would say so.
  const missing = Object.keys(questions.body)
    .filter((k) => k !== 'scope' && k !== 'seq')
    .filter((k) => !(k in cold.body));
  assert.deepEqual(missing, [], `the poll is missing ${missing.join(', ')}`);
  assert.deepEqual(cold.body.filter, questions.body.filter);
  assert.deepEqual(cold.body.summary, questions.body.summary);
  assert.ok('dismissAsk' in cold.body, 'the notification prompt has to survive a poll-driven refresh');
});

await check('and both build it from one function, so they cannot drift apart quietly', () => {
  const server = read('lib/server.js');
  assert.equal([...server.matchAll(/function inboxPayload\(/g)].length, 1);
  assert.ok([...server.matchAll(/inboxPayload\(/g)].length >= 4, 'one of the two endpoints stopped using it');
});

const before = bdCalls().length;
const quiet = await get(`/api/poll?since=${cold.body.seq}&wait=0`);

await check('a poll with nothing to say costs no `bd` at all — the whole saving', () => {
  assert.equal(quiet.status, 200);
  assert.equal(quiet.body.questions, null, 'null is "nothing moved"; [] would mean "the inbox is empty"');
  assert.equal(quiet.body.resync, false);
  assert.equal(
    bdCalls().length,
    before,
    `the quiet poll swept the tracker: ${bdCalls().slice(before).join(' | ')}`
  );
});

await check('a sequence from the future is a resync carrying the whole screen, not a wait forever', () => {
  // The daemon restarted and the counter went back to zero. The phone's `since` is now
  // ahead of the log, and without this it parks on a sequence that can never arrive.
  return get(`/api/poll?since=999999&wait=0`).then((res) => {
    assert.equal(res.body.resync, true);
    assert.ok(Array.isArray(res.body.questions));
    assert.ok('filter' in res.body && 'summary' in res.body, 'a resync has to be a complete screen');
  });
});

/* ------------------------------------------------------------------------- done */

for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${ran - failures}/${ran} ok\n`);
process.exit(failures ? 1 : 0);
