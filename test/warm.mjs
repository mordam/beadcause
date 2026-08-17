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
 * 1. **The store hands back what went in, and nothing else.** A cache that returns half
 *    a payload, or one written by a build that stored a different shape, is a screen
 *    showing something that is not true — and it looks exactly like a screen showing
 *    something that is. Every failure has to read as a miss, because a miss is the case
 *    every caller already handles. Age is deliberately *not* one of those failures any
 *    more (bc-1kwl.14): the store is `localStorage`, it survives the app closing, and
 *    nothing in it expires — which is the whole of why a reopen is a `/api/poll?since=`
 *    catch-up rather than a cold `bd` sweep per workspace.
 *
 * 2. **A quota or a private window must not take the app with it.** `localStorage`
 *    throws on write in more browsers than it does not, and the file's whole promise is
 *    that a page which cannot warm is merely as fast as it was yesterday. With nothing
 *    expiring, the bound is the only thing keeping the store finite — so the ordering it
 *    evicts in is asserted here in the direction that matters: **a full store may never
 *    give up the inbox**, which is the one entry a reopen is for.
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
 * `localStorage`, the way test/queue.mjs runs the real send queue: a rewrite of the
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
import { cleanupTmp } from './helpers/tmp.mjs';

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
 * itself off and a `localStorage` to keep things in.
 *
 * The storage is a Map with the browser's own quirks put back — `getItem` answers null
 * rather than undefined for a miss, `key(i)` is how the file enumerates — plus a switch
 * to make writing throw, which is the case the whole no-op path exists for.
 */
function load({ quota = Infinity, brokenStorage = false, deafRemove = false } = {}) {
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
    // `deafRemove` is the storage that will not let go of anything — Safari under a
    // full disk. Eviction then frees nothing, and the write loop has to end anyway.
    removeItem: (k) => void (deafRemove ? null : bag.delete(k)),
  };
  const window = { beadcause: {} };
  const ctx = vm.createContext({
    window,
    localStorage: storage,
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

await check('age alone is never a miss — a week later the list is still painted, and still knows its seq', () => {
  const { warm } = load();
  warm.write('/api/questions?scope=human', { questions: [{ key: 'beadcause/bc-1' }] }, 41);
  // A week is well past the fifteen minutes this used to expire at, and past any
  // plausible "away from the app" too. It is the reopen this bead is about.
  const week = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const hit = warm.read('/api/questions?scope=human', { now: week });
  assert.equal(hit.seq, 41, 'without the kept seq a reopen has nothing to catch up from and sweeps cold');
  assert.deepEqual(plain(hit.data), { questions: [{ key: 'beadcause/bc-1' }] });
});

await check('the store is localStorage — which is what survives the app being closed', () => {
  // Asserted against the file rather than through it: the vm room hands it whatever
  // globals the room has, so a warm.js that quietly went back to sessionStorage would
  // pass every behavioural check above by being handed the same fake either way.
  const src = read('public/warm.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /localStorage\.setItem/, 'a sessionStorage store dies with the app, which is the bug');
  assert.doesNotMatch(src, /\bsessionStorage\b/);
});

await check('an entry from a build that stored a different shape is a miss, and is dropped', () => {
  const { warm, bag } = load();
  bag.set('beadcause.warm:/api/work', JSON.stringify({ v: warm.STORE_V - 1, at: Date.now(), seq: 3, data: { old: true } }));
  assert.equal(warm.read('/api/work'), null, 'a durable entry outlives the build that wrote it — that is the point of the stamp');
  assert.equal(bag.size, 0, 'it will never match again, so it must not keep the quota');
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

await check('a full quota gives up one entry at a time rather than throwing the lot away', () => {
  const { warm, bag } = load({ quota: 2 });
  warm.write('/api/work', { workspaces: [] });
  warm.write('/api/admin', { scopes: [] });
  assert.equal(bag.size, 2);
  assert.equal(warm.write('/api/prs', { repos: [] }), true, 'room is made, not refused');
  assert.equal(bag.size, 2, 'exactly one was given up for exactly one');
  assert.ok(warm.read('/api/prs'), 'the write that made the room is the one that is held');
});

await check('the oldest entry is the one given up — the one nothing has restamped', () => {
  const { warm } = load({ quota: 2 });
  warm.write('/api/prs', { repos: [] });
  warm.write('/api/admin', { scopes: [] });
  // `refresh` restamps `at` for no request at all, which is exactly how a maintained
  // entry says it is still being followed. The board is left alone, so it is the oldest.
  warm.refresh('/api/admin', (d) => d);
  warm.write('/api/consoles', { consoles: [] });
  assert.equal(warm.read('/api/prs'), null, 'the entry nothing is maintaining is the one to lose');
  assert.ok(warm.read('/api/admin'));
  assert.ok(warm.read('/api/consoles'));
});

await check('a full store gives up the inbox last, whatever its age', () => {
  const { warm } = load({ quota: 2 });
  // Written first, so it is the *oldest* entry in the store — which is exactly what the
  // background warm does from any other page (`VIEWS` puts the inbox at the front), and
  // is why plain oldest-first would evict the one payload a reopen needs.
  warm.write('/api/questions?scope=human', { questions: [{ key: 'beadcause/bc-1' }] }, 41);
  warm.write('/api/admin', { scopes: [] });
  warm.write('/api/prs', { repos: [] });
  const kept = warm.read('/api/questions?scope=human');
  assert.ok(kept, 'the inbox is the app front door and the only view whose cold path is a bd sweep per workspace');
  assert.equal(kept.seq, 41);
  assert.equal(warm.read('/api/admin'), null, 'something else went instead');
});

await check('and it gives up the inbox at the widened scope last too, which is the same screen', () => {
  const { warm } = load({ quota: 2 });
  // `VIEWS` names `?scope=human`, which is what a notification opens. A device left on
  // `both` holds the same screen under a different key, and protecting only the default
  // would leave exactly that device paying the cold sweep this is all about.
  warm.write('/api/questions?scope=both', { questions: [{ key: 'beadcause/bc-1' }] }, 12);
  warm.write('/api/consoles', { consoles: [] });
  warm.write('/api/prs', { repos: [] });
  assert.ok(warm.read('/api/questions?scope=both'));
  assert.equal(warm.read('/api/consoles'), null);
});

await check('one oversized payload fails alone — it does not empty the store on the way down', () => {
  const { warm } = load();
  warm.write('/api/questions?scope=human', { questions: [{ key: 'beadcause/bc-1' }] }, 41);
  warm.write('/api/admin', { scopes: [] });
  const huge = { repos: ['x'.repeat(warm.BUDGET_BYTES + 1)] };
  assert.equal(warm.write('/api/prs', huge), false);
  assert.ok(warm.read('/api/questions?scope=human'), 'last week’s board must not take the inbox you are opening');
  assert.ok(warm.read('/api/admin'));
});

await check('the budget is honoured before the browser complains, not only after', () => {
  const { warm } = load();
  // Two payloads that fit individually and not together: no `setItem` ever throws here,
  // so the only thing that can bound this store is the file's own accounting.
  const big = (n) => ({ blob: 'x'.repeat(Math.floor(warm.BUDGET_BYTES * 0.6)), n });
  warm.write('/api/prs', big(1));
  warm.write('/api/unendorsed', big(2));
  assert.equal(warm.read('/api/prs'), null, 'nothing expires any more, so the budget is the whole bound');
  assert.ok(warm.read('/api/unendorsed'));
});

await check('a storage that will not let go of anything gives up rather than spinning', () => {
  // Eviction frees nothing here, so the only thing between this and an endless loop on
  // the front of a page load is the write's own bound. A spinning app is a great deal
  // worse than a cold one, and this is the shape that would produce one.
  const { warm } = load({ quota: 2, deafRemove: true });
  warm.write('/api/work', { workspaces: [] });
  warm.write('/api/admin', { scopes: [] });
  assert.equal(warm.write('/api/prs', { repos: [] }), false);
});

await check('a write that cannot be held drops the stale entry it was replacing', () => {
  const { warm } = load();
  warm.write('/api/prs', { repos: ['old'] });
  assert.equal(warm.write('/api/prs', { repos: ['x'.repeat(warm.BUDGET_BYTES + 1)] }), false);
  assert.equal(warm.read('/api/prs'), null, 'the payload it was superseding is not the one to paint');
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
  // `@requests`, `@empty` against `workspace/id`. One `@` is what keeps the two
  // namespaces apart, so it is asserted rather than left to a comment.
  const app = read('public/app.js');
  for (const key of ['@requests', '@empty']) {
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
  // Pills first, in the row's own order, and `/api/prs` at the head of them since
  // bc-khoe.2: PRs is the third pill where Advocates is the seventh, and this is a
  // sequential loop, so a view's place in the queue is how long it stays cold.
  // `/api/queues` comes after `/api/work` because Releases is the pill after Advocates
  // and rides the board's sweep. /admin, the queue and the chat session come last
  // because none of the three is a pill.
  assert.deepEqual(t.asked, ['/api/prs', '/api/work', '/api/queues', '/api/unendorsed', '/api/admin', '/api/consoles']);
});

await check('a path two views share is fetched once, not twice', async () => {
  const { warm } = load();
  const t = tracker();
  // From the PR board, both /api/work (advocates and admin) and the inbox sweep
  // (inbox and advocates) are wanted by more than one view.
  warm.prewarm({ here: 'prs', api: t.api, delay: 0 });
  await tick(20);
  assert.deepEqual(t.asked, [
    '/api/questions?scope=human',
    '/api/work',
    '/api/queues',
    '/api/unendorsed',
    '/api/admin',
    '/api/consoles',
  ]);
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

/**
 * Push a held entry's clock back. What a close and a reopen the next morning is: the
 * payload is still on the disk and nothing about it is inside the background warm's
 * floor any more.
 */
function age(bag, path, ms) {
  const key = `beadcause.warm:${path}`;
  const entry = JSON.parse(bag.get(key));
  entry.at -= ms;
  bag.set(key, JSON.stringify(entry));
}

await check('a held board and a held queue are left alone whatever their age — a reopen is not a `gh` sweep', async () => {
  const { warm, bag } = load();
  // Everything a durable store comes back from a close still holding, aged an hour past
  // the floor. This *is* the reopen: `prewarm` runs once per document, and a reopen is a
  // new document, so before bc-1kwl.15 it went and fetched all five of these again.
  const payload = { workspaces: [], scopes: [], consoles: [], beads: [], repos: [] };
  for (const p of ['/api/work', '/api/admin', '/api/consoles', '/api/unendorsed', '/api/prs', '/api/queues']) {
    warm.write(p, payload);
    age(bag, p, 60 * 60 * 1000);
  }
  const t = tracker();
  warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  await tick(20);
  // The two the app has already decided are never worth a background re-ask: `gh` once
  // per repo, and a `bd list` per workspace with a `bd show` per row. Both were being
  // spent on every single app open, to replace a payload already on the disk.
  assert.ok(!t.asked.includes('/api/prs'), 'a `gh` call per repo, for a board already held');
  assert.ok(!t.asked.includes('/api/unendorsed'), 'a `bd` sweep and a `bd show` per row, for a queue already held');
  // And the third, added with the Releases view (bc-khoe.7): it rides the board's sweep,
  // so on a reopen that has just skipped `/api/prs` it is the request that would pay for
  // one instead — the same bill, moved rather than avoided.
  assert.ok(!t.asked.includes('/api/queues'), 'the board sweep again, wearing the queues path');
  // And nothing else changed: the one `bd` sweep a tab is actually drawn from, and the
  // two in-memory reads, are still refreshed. Held is not the same as current for those,
  // and this is what stops Advocates arriving an hour old.
  assert.deepEqual(t.asked, ['/api/work', '/api/admin', '/api/consoles']);
});

await check('and one that is not held is still fetched — a new device, or one that evicted the board', async () => {
  const { warm } = load();
  const t = tracker();
  warm.prewarm({ here: 'inbox', api: t.api, delay: 0 });
  await tick(20);
  // The boundary of the rule above. `holdOnly` is "do not *replace* one", never "do not
  // fill one" — the first run on a phone, and the run after the byte budget gave the
  // board up, are exactly when this loop is the only thing that can warm those pages.
  assert.ok(t.asked.includes('/api/prs'), 'the board is never filled at all');
  assert.ok(t.asked.includes('/api/unendorsed'), 'the queue is never filled at all');
});

await check('the paths the background warm will not replace are the ones the inbox will not re-ask for', () => {
  const { warm } = load();
  const holdOnly = plain(warm.VIEWS).filter((v) => v.holdOnly).flatMap((v) => plain(v.paths));
  // Sorted, because the order of `VIEWS` is the order the background warm walks it in and
  // belongs to whoever is arranging the pill row — bc-khoe.1 moved the board up past the
  // two pages that are not pills and this read the old order out of a literal. Which two
  // paths are too expensive to re-ask for is the claim here; where they sit in the queue
  // is not.
  assert.deepEqual(holdOnly.slice().sort(), ['/api/prs', '/api/queues', '/api/unendorsed']);
  // `MAINTAINED` in public/app.js decides the same question for the other warmer, and
  // where both of them know a path the two answers have to agree. A path one of them
  // refuses to re-ask while the other sweeps it on every reopen is the expensive half of
  // that decision still being paid, by a route nobody is looking at — which is the whole
  // of what bc-1kwl.15 found.
  const refetchFalse = [...read('public/app.js').matchAll(/path: '([^']+)',[\s\S]{0,2000}?refetch: (true|false),/g)]
    .filter((m) => m[2] === 'false')
    .map((m) => m[1]);
  // A subset rather than an equality, and the gap is named rather than tolerated: the
  // inbox holds no `/api/queues` at all — it draws no queue and the delta stream carries
  // nothing that would let it maintain one — so there is no counterpart there to agree
  // with. It is `holdOnly` here for a reason of its own: `/api/queues` rides the board's
  // 25-second sweep, so on a reopen that has just skipped a held `/api/prs` it would be
  // the request that pays for the `gh`-per-repo call instead (bc-khoe.7). Anything else
  // appearing in this gap is the disagreement above, and must be added to both.
  assert.deepEqual(
    holdOnly.filter((p) => !refetchFalse.includes(p)),
    ['/api/queues'],
    'the two warmers disagree about which paths are too expensive to re-ask for'
  );
  assert.deepEqual(
    refetchFalse.filter((p) => !holdOnly.includes(p)),
    [],
    'the inbox refuses to re-ask for a path the background warm replaces on every reopen'
  );
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
  assert.equal(t.asked.length, 6, 'a tab switch is a new document, and that is what re-warms');
});

await check('a screen that has gone dark stops it — a phone in a pocket warms nothing', async () => {
  const bag = new Map();
  // Same room as `load`, with a document that says the page is hidden.
  const ctx = vm.createContext({
    window: { beadcause: {} },
    localStorage: {
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

/* ------------------------------------------- 4b. keeping an entry warm, for free */

/* `prewarm` fills a path once per document and the TTL then drops it, which is fine for
   a page you pass through and wrong for the inbox — the page you sit on for hours. That
   left the Advocates tab cold for all but the first fifteen minutes with nothing able to
   put it back, because `prewarmed` never goes false again (bc-xxzz). `refresh` is the way
   back that costs no request: the delta stream carries the advocate roster on every wake,
   so folding it in is both an update and a new timestamp. */

await check('a held payload can be brought up to date, and comes back with the update in it', () => {
  const { warm } = load();
  warm.write('/api/work', { workspaces: [{ name: 'demo' }], advocates: [{ workspace: 'demo', paused: false }] }, 11);
  const ok = warm.refresh('/api/work', (work) => ({ ...work, advocates: [{ workspace: 'demo', paused: true }] }));
  assert.equal(ok, true);
  const hit = warm.read('/api/work');
  assert.deepEqual(plain(hit.data.advocates), [{ workspace: 'demo', paused: true }]);
  assert.deepEqual(plain(hit.data.workspaces), [{ name: 'demo' }], 'the rest of the payload is untouched');
  assert.equal(hit.seq, 11, "the entry's own sequence is kept when none is given");
});

await check('and its clock is reset, which is what the re-ask floor and the eviction order read', () => {
  const { warm, bag } = load();
  warm.write('/api/work', { workspaces: [] });
  // Aged by rewriting the stamp the file wrote — well past the fifteen minutes this used
  // to expire at, and past the re-ask floor either way.
  const key = 'beadcause.warm:/api/work';
  const aged = JSON.parse(bag.get(key));
  aged.at = Date.now() - 20 * 60 * 1000;
  bag.set(key, JSON.stringify(aged));
  assert.equal(warm.fresh('/api/work'), false, 'outside the floor, so the background warm would go and ask');
  assert.ok(warm.refresh('/api/work', (w) => w), 'still readable, so still maintainable');
  assert.equal(warm.fresh('/api/work'), true, 'and the wake put it back, for no request at all');
});

await check('a sequence can be handed in with the update', () => {
  const { warm } = load();
  warm.write('/api/work', { workspaces: [] }, 3);
  warm.refresh('/api/work', (w) => w, 9);
  assert.equal(warm.read('/api/work').seq, 9);
});

await check('nothing held is a miss, not a write — the caller has to go and fetch', () => {
  const { warm, bag } = load();
  assert.equal(warm.refresh('/api/work', () => ({ workspaces: [] })), false);
  assert.equal(bag.size, 0, 'refresh must never invent an entry out of a mutate');
});

await check('a shape the caller cannot maintain is a miss too, and the old entry goes', () => {
  const { warm } = load();
  // The case this guards: a payload from a daemon that predates the fields being folded
  // in. Half-patching it would put a payload on screen that no version ever served.
  warm.write('/api/work', { fromAnOlderDaemon: true });
  assert.equal(warm.refresh('/api/work', (work) => (Array.isArray(work.workspaces) ? work : null)), false);
});

await check('a mutate that throws is a miss, not an exception out of the poll handler', () => {
  const { warm } = load();
  warm.write('/api/work', { workspaces: [] });
  assert.equal(
    warm.refresh('/api/work', () => {
      throw new Error('nope');
    }),
    false
  );
});

await check('a screen dark for a week is renewed rather than thrown away — the log is what decides', () => {
  const { warm, bag } = load();
  warm.write('/api/work', { workspaces: [] }, 7);
  const key = 'beadcause.warm:/api/work';
  const aged = JSON.parse(bag.get(key));
  aged.at = Date.now() - 7 * 24 * 60 * 60 * 1000;
  bag.set(key, JSON.stringify(aged));
  // This used to be false: an entry past fifteen minutes was gone and the caller had to
  // re-fetch. That is the whole cost bc-1kwl.14 removed — a phone in a pocket overnight
  // is not a reason to sweep `bd` across seven workspaces, only the log is.
  assert.equal(warm.refresh('/api/work', (w) => w), true);
  const back = warm.read('/api/work');
  assert.ok(back.age < 1000, 'and it is restamped, which is what the eviction order reads');
  assert.equal(back.seq, 7, 'the log position survives the restamp, or the catch-up has nowhere to start');
});

/* -------------------------------------------------------------- the wiring */

await check('every standing page loads the file, or that page is the one cold tab', () => {
  for (const page of ['index.html', 'console.html', 'monitor.html', 'admin.html', 'endorse.html']) {
    assert.ok(read(`public/${page}`).includes('/warm.js'), `${page} does not load warm.js`);
  }
});

await check('and it is loaded before the page script that asks it for a list', () => {
  for (const [page, script] of [
    ['index.html', '/app.js'],
    ['console.html', '/console.js'],
    ['monitor.html', '/monitor.js'],
    // The board is a pane on that same page now (bc-d4d5), and it reads the warm layer
    // for its own payload — so it is the second script on the page here rather than a
    // page of its own, exactly as mirror.js is in test/stream.mjs.
    ['monitor.html', '/prs.js'],
    ['admin.html', '/admin.js'],
    ['endorse.html', '/endorse.js'],
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

await check('every pill the row draws is warmed — and three views are deliberately not pills', () => {
  const { warm } = load();
  const ids = [...read('public/viewbar.js').matchAll(/^\s*\{?\s*id: '([a-z]+)'/gm)].map((m) => m[1]);
  // Keyed off a pill rather than off a count: this navigation has changed size four
  // times, and a count here fails as "unreadable" every time it legitimately does again.
  // Home is `epics` since bc-khoe.2 — the P0 board is what an unnarrowed Home *is*.
  assert.ok(ids.includes('epics'), `could not read the pill list out of viewbar.js: ${ids.join(', ')}`);

  /**
   * Which warm view each pill's first frame comes off.
   *
   * **This stopped being an identity in bc-khoe.2** and the map is the whole of what
   * changed here. The row used to be one pill per page, so a pill id and a view id were
   * the same word; six of the eight pills are now the inbox's *kinds*, and four of those
   * six are Home under a different narrowing — one page, one payload, one warm entry.
   * `PRs` is the exception among them and it is not an exception to the rule: tapping it
   * is the first thing on Home that wants a board at all (`loadBoard` in public/app.js),
   * so its first frame comes off `/api/prs` exactly as the board page's does. Releases
   * (bc-khoe.7) is the one pill added since, and it is an identity again for the ordinary
   * reason the old ones were: a page of its own, with a payload of its own.
   *
   * The check the map serves is unchanged: a pill whose payload nothing warms is a view
   * that stays cold, which is invisible until you are on a phone wondering why one is
   * slower than the others.
   */
  const VIEW_OF = {
    epics: 'inbox',
    question: 'inbox',
    session: 'inbox',
    bead: 'inbox',
    pr: 'prs',
    history: 'history',
    advocates: 'advocates',
    releases: 'releases',
  };
  const views = plain(warm.VIEWS).map((v) => v.id);
  for (const pill of ids) {
    const view = VIEW_OF[pill];
    assert.ok(view, `${pill} is a pill this check has never heard of — say which payload warms it`);
    assert.ok(views.includes(view), `${pill} warms through '${view}', which is not a view — it stays cold`);
  }

  // The other direction is not an equality, and all three exceptions are deliberate. The
  // endorsement queue has never been on the navigation (bc-j0zl, "never a sixth tab") and
  // bc-khoe.2 folded it into the Questions pill rather than giving it one; /admin lost its
  // place in bc-khoe.1, being the screen you least want to hit by accident, and bc-khoe.5
  // puts it in the gear menu; the chat session has had none since bc-l8jp.5, because it
  // is created from ＋ and listed as a row in Home. All three are standing pages somebody
  // arrives at in one tap, so all three are still warmed. These are the *only* views
  // allowed to have no pill; anything else here would be a payload warmed for a page
  // nobody can get to.
  const reached = new Set(ids.map((p) => VIEW_OF[p]));
  assert.deepEqual(views.filter((v) => !reached.has(v)), ['endorse', 'admin', 'console']);

  // And the pills' own order still follows the row, so the warm fills them in the order a
  // thumb reaches them — read through the map, and with the repeats dropped, because four
  // pills share one entry and a list cannot hold it four times.
  const wanted = [...new Set(ids.map((p) => VIEW_OF[p]))];
  assert.deepEqual(views.filter((v) => reached.has(v)), wanted);

  // Every pill before every page that is not one (bc-xxzz). The background warm is
  // sequential, so this list's order is the order things become warm in, and a view a
  // thumb can reach in one tap must not wait on one it cannot. bc-khoe.1 is what moved
  // `/api/prs` and `/api/unendorsed` — the two most expensive entries here — up past
  // /admin and the chat session, because the row made both of them one tap away.
  const lastPill = views.reduce((n, v, i) => (reached.has(v) ? i : n), -1);
  const firstOther = views.findIndex((v) => !reached.has(v));
  assert.ok(
    firstOther === -1 || firstOther > lastPill,
    `${views[firstOther]} is warmed before a pill is — the pills come first, and this list is the warm order`
  );
  // A view may warm nothing, and exactly one does. `paths: []` satisfies the loop above
  // without prefetching a byte, so it is the obvious way to *silence* this check rather
  // than answer it — and the answer is only defensible for History, whose boot request
  // carries the space picker's current selection and is therefore not a constant this
  // file could hold. Any other pathless view is a tab that stays cold behind an entry
  // claiming it does not, which is worse than the missing entry this check was written
  // to catch.
  const empty = plain(warm.VIEWS).filter((v) => !plain(v.paths).length).map((v) => v.id);
  assert.deepEqual(empty, ['history'], `a view that warms nothing has to be a decision: ${empty.join(', ')}`);
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
  // The loop itself moved to public/stream.js in bc-rk2o, so the assertion moved with
  // it: what this file cares about is that the inbox is on the log rather than that the
  // request is written here. test/stream.mjs holds the other four views to the same.
  assert.ok(/window\.beadcause\??\.stream\??\.follow\??\.?\(/.test(app), 'the inbox no longer mounts the shared stream');
  assert.ok(/\/api\/poll\?/.test(read('public/stream.js')), 'the long poll is gone from stream.js');
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
  // no badges on the tabs, or a filter it does not obey — and nothing would say so.
  const missing = Object.keys(questions.body)
    .filter((k) => k !== 'scope' && k !== 'seq')
    .filter((k) => !(k in cold.body));
  assert.deepEqual(missing, [], `the poll is missing ${missing.join(', ')}`);
  assert.deepEqual(cold.body.filter, questions.body.filter);
  assert.deepEqual(cold.body.summary, questions.body.summary);
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
await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} ok\n`);
process.exit(failures ? 1 : 0);
