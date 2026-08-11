#!/usr/bin/env node
/**
 * The History tab — the ledger for the selected space, most recently touched first.
 *
 *     npm test
 *     node test/history.mjs
 *
 * The page is a list and a link, and neither of those is what can go wrong with it. What
 * can is the merge underneath, which is invisible on any screen small enough to check by
 * eye and wrong in a way that reads as correct:
 *
 * 1. **`/api/history` takes one workspace and the picker does not.** `All spaces` is
 *    every repo you have and a *space* is a group of them, so a space of three repos is
 *    three requests whose answers have to become one list. Concatenated they would show
 *    all of repo A and then all of repo B — each internally newest-first, and the whole
 *    thing wrong, with a bead from last March sitting above one from this morning. So
 *    the rows are merged by time, and that is checked here over a fixture built to
 *    interleave rather than by looking at a screenshot where two repos happen to agree.
 *
 * 2. **A repo whose buffer runs dry must be re-filled before the next comparison.** Its
 *    next page is older than everything it has already given us and can still be newer
 *    than what another repo is offering. Treating an empty buffer as "this repo is
 *    finished" drops a run of one repo out of the *middle* of the list — no error, no
 *    gap, just a fortnight that is not there — and the fixture below is shaped
 *    specifically so that a merge which skips the re-fill produces a visibly unsorted
 *    list. See `pump()` in public/history.js.
 *
 * 3. **`more` is the server's, and it is not trusted absolutely.** A `more: true` over a
 *    page with no rows in it is a server bug whose shape on this page would be an
 *    infinite fetch loop, so the client ends the repo on an empty page whatever it
 *    claims. That is checked by counting requests, which turns what would otherwise be a
 *    hung suite into a failed assertion.
 *
 * 4. **The picker can move mid-flight.** It is a dropdown; two taps in a second is
 *    normal. An in-flight response for the space you just left must not land in the list
 *    for the one you are on — checked by holding a response open across the change.
 *
 * 5. **A row with an archived session has to be distinguishable, and not by colour.**
 *    That is the acceptance criterion the tab bar's own check would refuse to accept a
 *    tint for, and it is one attribute away from being lost in a repaint.
 *
 * The client half runs the real `public/history.js` in a vm with a hand-made document,
 * the way test/spacebar.mjs runs the real picker — a rewrite of the merge as a test-only
 * module could not fail while the phone shipped something else.
 *
 * And the static half at the foot is the other side of that: a stub document answering
 * every selector cannot notice an element that is missing from the HTML, so every id the
 * script reaches for is also checked against the document that has to contain it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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

console.log('\nhistory tab\n');

/* ================================================================== the harness */

/** One turn of the macrotask queue drains every microtask behind it. Ten is far more
 *  than the page needs for a fixture this size, and a loop that had not settled by then
 *  is the bug rather than a slow test. */
const settle = async (n = 25) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const iso = (h) => new Date(Date.UTC(2026, 0, 1) + h * 3600e3).toISOString();

/**
 * The real file, in a room with the five things it touches: the list element, the pulse
 * dot, the ⟳ button, a `fetch`, and the space picker it registers itself on.
 *
 * `out` keeps `innerHTML` as the string it was handed — which is what every check below
 * reads — and answers `querySelector('#hist-more')` only when that string actually
 * contains the button. A stub that always answered would be a stub that cannot notice
 * the button was never drawn, which is half of what this suite is for.
 *
 * `setTimeout` is captured rather than scheduled. The page arms one 8-second backstop at
 * load, and a real timer here would hold the whole suite open for eight seconds after
 * the last assertion — so it is collected, and case 6 fires it by hand.
 */
function load({ token = 'tok', workspaces = ['demo'], respond } = {}) {
  const mk = () => {
    const el = {
      innerHTML: '',
      events: {},
      classes: new Set(),
      addEventListener(type, fn) {
        this.events[type] = fn;
      },
      classList: {
        toggle: (name, on) => (on ? el.classes.add(name) : el.classes.delete(name)),
      },
    };
    return el;
  };

  const button = mk();
  const out = mk();
  out.querySelector = (sel) =>
    sel === '#hist-more' && /id="hist-more"/.test(out.innerHTML) ? button : null;

  const pulse = mk();
  const refresh = mk();

  const timers = [];
  const store = new Map();
  if (token) store.set('beadcause.token', token);

  /** The picker, as much of it as this page asks for. */
  let inside = workspaces;
  const listeners = [];
  const space = {
    inside: () => inside,
    label: () => (inside.length === 1 ? inside[0] : 'everything'),
    onChange: (fn) => listeners.push(fn),
  };

  const calls = [];
  const fetchStub = async (url, opts) => {
    const q = new URL(url, 'http://x').searchParams;
    const call = {
      workspace: q.get('workspace'),
      offset: Number(q.get('offset')),
      limit: Number(q.get('limit')),
      refresh: q.get('refresh') === '1',
      token: opts && opts.headers && opts.headers['x-beadcause-token'],
    };
    calls.push(call);
    const body = await respond(call);
    if (body && body.status) return { ok: false, status: body.status };
    return { ok: true, status: 200, json: async () => body };
  };

  const window = { beadcause: { space } };
  const ctx = vm.createContext({
    window,
    document: {
      getElementById: (id) =>
        id === 'history' ? out : id === 'pulse' ? pulse : id === 'hist-refresh' ? refresh : null,
    },
    localStorage: { getItem: (k) => store.get(k) ?? null },
    fetch: fetchStub,
    URLSearchParams,
    URL,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    JSON,
    Date,
    Number,
    Array,
    Promise,
    console,
  });
  vm.runInContext(read('public/history.js'), ctx, { filename: 'history.js' });

  return {
    out,
    button,
    pulse,
    refresh,
    calls,
    timers,
    /** Move the picker, the way spacebar.js announces it. */
    pick(list) {
      inside = list;
      for (const fn of listeners) fn({ source: 'pick' });
    },
  };
}

/** The bead ids drawn, in the order they are drawn. */
const idsOf = (h) => [...h.out.innerHTML.matchAll(/<span class="pill id">([^<]+)<\/span>/g)].map((m) => m[1]);

/* ============================================================ 1 & 2. the merge */

/**
 * Two repos whose rows interleave, and — this is the part that matters — deeper than
 * one fetch, so that each repo's buffer runs dry several times over the course of the
 * list. `FETCH` is 60 in the page, so 200 rows a repo means the merge crosses a buffer
 * boundary three times, and a fetch of 20 would have proved nothing: both repos would
 * have arrived whole on the first request and the re-fill this suite exists to check
 * would never have been reached.
 *
 * `demo` holds the even hours and `other` the odd ones, so the correct answer is a
 * strict alternation for the whole length of the list — which makes any skipped re-fill
 * a visible run of one repo rather than a subtle mis-ordering somebody has to eyeball.
 */
const DEEP = 200;
const INTERLEAVED = (call) => {
  const all = Array.from({ length: DEEP }, (_, i) => ({
    id: `${call.workspace}-${String(i).padStart(2, '0')}`,
    workspace: call.workspace,
    title: `row ${i}`,
    type: 'task',
    status: 'closed',
    priority: 2,
    // demo gets the even hours and other the odd, counting down so each repo's own
    // page is newest-first exactly as the server promises.
    updated: iso(DEEP * 2 - i * 2 - (call.workspace === 'demo' ? 0 : 1)),
    closeReason: null,
    hasSession: false,
    createdBy: 'x',
  }));
  const rows = all.slice(call.offset, call.offset + call.limit);
  return { workspace: call.workspace, rows, total: all.length, more: call.offset + rows.length < all.length };
};

/** Load the page and press Load more until there is none. */
async function whole(opts) {
  const h = load(opts);
  await settle();
  for (let i = 0; i < 40 && h.out.querySelector('#hist-more'); i += 1) {
    h.button.events.click();
    await settle();
  }
  assert.ok(!h.out.querySelector('#hist-more'), 'the list never reached its end');
  return h;
}

await check('rows from several repos come out newest-first, not repo after repo', async () => {
  const h = await whole({ workspaces: ['demo', 'other'], respond: INTERLEAVED });
  const stamps = [...h.out.innerHTML.matchAll(/<time datetime="([^"]+)"/g)].map((m) => Date.parse(m[1]));
  assert.equal(stamps.length, DEEP * 2, `expected every row, got ${stamps.length}`);
  const wrong = stamps.findIndex((t, i) => i > 0 && t > stamps[i - 1]);
  assert.equal(wrong, -1, `row ${wrong} is newer than the one above it — the merge is not merging`);
});

await check('and they strictly alternate, which is the merge doing its one job', async () => {
  const h = await whole({ workspaces: ['demo', 'other'], respond: INTERLEAVED });
  const repos = idsOf(h).map((id) => id.split('-')[0]);
  const run = repos.findIndex((r, i) => i > 0 && r === repos[i - 1]);
  assert.equal(run, -1, `two rows in a row from the same repo at ${run}: ${repos.slice(Math.max(0, run - 3), run + 3).join(',')}`);
});

/**
 * The re-fill, isolated — and it needs a deliberately *lopsided* fixture, which is the
 * thing that was almost missed here.
 *
 * Under the interleaved fixture above both repos run out on the same row, so a merge
 * that never re-filled mid-page would still emit them in the right order: it would just
 * stop early and be rescued by the next press. That fixture cannot fail, whatever the
 * merge does. This one can. Every row of `recent` is newer than every row of `old`, so
 * after 60 rows — one `FETCH` — `recent`'s buffer is empty while `old` still holds 60
 * rows that are older than everything `recent` has left. A merge that reads an empty
 * buffer as an exhausted repo emits `old` at row 61 and buries a hundred and forty of
 * `recent`'s rows under it, in the middle of the list, with no gap and no error.
 */
const LOPSIDED = (call) => {
  const recent = call.workspace === 'recent';
  const all = Array.from({ length: DEEP }, (_, i) => ({
    id: `${call.workspace}-${String(i).padStart(3, '0')}`,
    workspace: call.workspace,
    title: `row ${i}`,
    type: 'task',
    status: 'open',
    priority: 2,
    // Two blocks that do not overlap at all: `recent` is hours 2000-1801, `old` is
    // 1000-801. Nothing in `old` may appear above anything in `recent`.
    updated: iso((recent ? 2000 : 1000) - i),
    closeReason: null,
    hasSession: false,
  }));
  const rows = all.slice(call.offset, call.offset + call.limit);
  return { workspace: call.workspace, rows, total: all.length, more: call.offset + rows.length < all.length };
};

await check('a repo whose buffer runs dry is re-filled before the next comparison', async () => {
  const h = await whole({ workspaces: ['recent', 'old'], respond: LOPSIDED });
  const repos = idsOf(h).map((id) => id.split('-')[0]);
  const firstOld = repos.indexOf('old');
  assert.equal(
    firstOld,
    DEEP,
    `an older repo's rows appear at ${firstOld}, above ${DEEP - firstOld} newer ones — the buffer was not re-filled`
  );
});

await check('every bead appears exactly once across the whole list', async () => {
  const h = await whole({ workspaces: ['demo', 'other'], respond: INTERLEAVED });
  const ids = idsOf(h);
  assert.equal(ids.length, DEEP * 2, `expected all ${DEEP * 2} beads, got ${ids.length}`);
  assert.equal(new Set(ids).size, DEEP * 2, 'a bead is drawn twice');
});

await check('the list ends, and says so instead of offering a button', async () => {
  const h = await whole({ workspaces: ['demo', 'other'], respond: INTERLEAVED });
  assert.match(h.out.innerHTML, /That is all of it/);
});

/* ================================================== 3. more over an empty page */

await check('a `more: true` over an empty page ends the repo instead of looping forever', async () => {
  let n = 0;
  const h = load({
    respond: async (call) => {
      n += 1;
      // A hang is what the bug would look like, so it is converted into an assertion:
      // past a handful of calls the fixture refuses, the source errors, and the count
      // below is what fails rather than the suite never returning.
      if (n > 6) return { status: 500 };
      return { workspace: call.workspace, rows: [], total: 0, more: true };
    },
  });
  await settle();
  assert.equal(n, 1, `asked ${n} times for a page the server had already emptied`);
  assert.match(h.out.innerHTML, /Nothing in/);
});

/* ================================================ 4. the picker moving mid-flight */

await check('a response for the space you just left never lands in the list', async () => {
  let release = null;
  const held = new Promise((r) => {
    release = r;
  });
  const h = load({
    workspaces: ['slow'],
    respond: async (call) => {
      if (call.workspace === 'slow') {
        await held;
        return {
          workspace: 'slow',
          rows: [{ id: 'slow-1', workspace: 'slow', title: 'from the old space', type: 'task', status: 'open', priority: 2, updated: iso(9), closeReason: null, hasSession: false }],
          total: 1,
          more: false,
        };
      }
      return {
        workspace: call.workspace,
        rows: [{ id: 'fast-1', workspace: call.workspace, title: 'from the new space', type: 'task', status: 'open', priority: 2, updated: iso(8), closeReason: null, hasSession: false }],
        total: 1,
        more: false,
      };
    },
  });
  await settle(3);
  h.pick(['fast']);
  await settle();
  release();
  await settle();
  const ids = idsOf(h);
  assert.deepEqual(ids, ['fast-1'], `the abandoned space's row arrived anyway: ${ids.join(',')}`);
});

/* ================================================ 5. the row, and what it links to */

const ONE = (row) => async (call) => ({
  workspace: call.workspace,
  rows: call.offset ? [] : [{ id: 'de-1', workspace: call.workspace, title: 'A bead', type: 'task', status: 'closed', priority: 1, updated: iso(4), closeReason: 'Landed as #9 as abc1234', hasSession: false, ...row }],
  total: 1,
  more: false,
});

await check('a row links to the bead detail sheet, deep-linked open', async () => {
  const h = load({ respond: ONE({}) });
  await settle();
  assert.match(h.out.innerHTML, /href="\/graph\?ws=demo&amp;id=de-1&amp;open=1"/);
});

await check('a bead with an archived session is marked, and not only by colour', async () => {
  const h = load({ respond: ONE({ hasSession: true }) });
  await settle();
  assert.match(h.out.innerHTML, /class="hist-row has-session/, 'no class on the row');
  assert.match(h.out.innerHTML, /aria-label="has an archived session"/, 'nothing for a reader that cannot see the rule');
});

await check('a bead without one carries neither', async () => {
  const h = load({ respond: ONE({ hasSession: false }) });
  await settle();
  assert.doesNotMatch(h.out.innerHTML, /has-session/);
  assert.doesNotMatch(h.out.innerHTML, /archived session/);
});

await check('the close reason is drawn — it is the best sentence in the record', async () => {
  const h = load({ respond: ONE({}) });
  await settle();
  assert.match(h.out.innerHTML, /Landed as #9 as abc1234/);
});

await check('the repo is named on every row only when more than one repo is in view', async () => {
  const one = load({ respond: ONE({}) });
  await settle();
  assert.doesNotMatch(one.out.innerHTML, /hist-ws/, 'a repo chip on every row of a single-repo list is noise');

  const two = load({ workspaces: ['demo', 'other'], respond: INTERLEAVED });
  await settle();
  assert.match(two.out.innerHTML, /hist-ws/, 'no way to tell which repo a row came from');
});

await check('the token rides on the request', async () => {
  const h = load({ respond: ONE({}) });
  await settle();
  assert.equal(h.calls[0].token, 'tok');
});

/* =========================================================== 6. what it says when */

await check('an unpaired device is told so, and asks for nothing', async () => {
  const h = load({ token: '', respond: async () => ({ rows: [] }) });
  await settle();
  assert.match(h.out.innerHTML, /not paired/);
  assert.equal(h.calls.length, 0, 'fetched the ledger with no token');
});

await check('a repo that will not answer drops out, and the rest of the space still draws', async () => {
  const h = load({
    workspaces: ['demo', 'broken'],
    respond: async (call) =>
      call.workspace === 'broken'
        ? { status: 500 }
        : { workspace: 'demo', rows: [{ id: 'de-1', workspace: 'demo', title: 'still here', type: 'task', status: 'open', priority: 2, updated: iso(3), closeReason: null, hasSession: false }], total: 1, more: false },
  });
  await settle();
  assert.match(h.out.innerHTML, /Could not read broken/, 'said nothing about the repo it could not read');
  assert.match(h.out.innerHTML, /still here/, 'threw away the repos that did answer');
});

await check('a daemon with no ledger endpoint is an empty state, not a broken page', async () => {
  const h = load({ respond: async () => ({ status: 404 }) });
  await settle();
  assert.match(h.out.innerHTML, /Could not read demo \(no ledger here\)/);
});

/**
 * The one that is not visible in the status code.
 *
 * A repo whose `bd` fell over comes back **200** with an empty `rows` and a row in
 * `errors[]` — not a failed request. A page that reads only `res.ok` draws that as a
 * repo with nothing in it, which under a space of several repos means one of them
 * silently vanishing from a merged list with nothing on screen to say so. That is the
 * worst failure this page has, because it is indistinguishable from the truth.
 */
await check('a 200 carrying an errors[] row is a failure, not an empty repo', async () => {
  const h = load({
    respond: async (call) => ({ workspace: call.workspace, rows: [], total: 0, more: false, errors: [{ workspace: 'demo', error: 'bd exited 1' }] }),
  });
  await settle();
  assert.match(h.out.innerHTML, /Could not read demo \(bd exited 1\)/);
  assert.doesNotMatch(h.out.innerHTML, /Nothing in/, 'a repo that could not be read was drawn as a repo with nothing in it');
});

await check('and the other repos in the space still draw around it', async () => {
  const h = load({
    workspaces: ['demo', 'other'],
    respond: async (call) =>
      call.workspace === 'demo'
        ? { workspace: 'demo', rows: [], total: 0, more: false, errors: [{ workspace: 'demo', error: 'bd exited 1' }] }
        : { workspace: 'other', rows: [{ id: 'ot-1', workspace: 'other', title: 'still here', type: 'task', status: 'open', priority: 2, updated: iso(2), closeReason: null, hasSession: false }], total: 1, more: false },
  });
  await settle();
  assert.match(h.out.innerHTML, /Could not read demo/);
  assert.match(h.out.innerHTML, /still here/);
});

/* ------------------------------------------------------------ the slow first read */

await check('a first read that has not landed says so, rather than "nothing here"', async () => {
  let release = null;
  const held = new Promise((r) => {
    release = r;
  });
  const h = load({
    respond: async (call) => {
      await held;
      return { workspace: call.workspace, rows: [], total: 0, more: false };
    },
  });
  await settle();
  // The sweep is measured in tens of seconds on a loaded Mac, and this is the whole of
  // that window: an empty ledger and one that has not arrived are the same blank card.
  assert.match(h.out.innerHTML, /Reading the ledger/);
  assert.doesNotMatch(h.out.innerHTML, /Nothing in/);
  release();
  await settle();
  assert.match(h.out.innerHTML, /Nothing in/, 'and once it lands, it says the other thing');
});

await check('nothing arms a timeout that could cut the first sweep off', () => {
  // `Bd.listAll` is allowed 120s for exactly this, so a client-side abort under it
  // would make the tab look broken on precisely the busy afternoons it is opened.
  assert.doesNotMatch(read('public/history.js'), /AbortController|AbortSignal|signal:/);
});

await check('⟳ asks the daemon to sweep again rather than re-reading its cache', async () => {
  const h = load({ respond: ONE({}) });
  await settle();
  assert.ok(!h.calls.some((c) => c.refresh), 'a plain visit forced a re-sweep');
  h.refresh.events.click();
  await settle();
  assert.ok(h.calls.some((c) => c.refresh), '⟳ was answered out of the cache it is doubting');
});

await check('but a long scroll does not — one re-sweep per press, not per page', async () => {
  const h = load({ workspaces: ['demo', 'other'], respond: INTERLEAVED });
  await settle();
  h.refresh.events.click();
  await settle();
  for (let i = 0; i < 4 && h.out.querySelector('#hist-more'); i += 1) {
    h.button.events.click();
    await settle();
  }
  const forced = h.calls.filter((c) => c.refresh).length;
  assert.equal(forced, 2, `${forced} full sweeps for one press — the scroll is meant to be free`);
});

await check('a count is only drawn when it is the whole truth', async () => {
  const whole = load({ respond: ONE({}) });
  await settle();
  assert.match(whole.out.innerHTML, /1 bead in demo/);

  // One repo of two unreadable: the sum would be a smaller number presented as the total.
  const partial = load({
    workspaces: ['demo', 'broken'],
    respond: async (call) => (call.workspace === 'broken' ? { status: 500 } : ONE({})(call)),
  });
  await settle();
  assert.doesNotMatch(partial.out.innerHTML, /bead in /);
});

await check('the picker never answering says so, rather than spinning forever', async () => {
  const h = load({ workspaces: [], respond: async () => ({ rows: [] }) });
  await settle();
  assert.match(h.out.innerHTML, /Reading the ledger/, 'gave up before the picker had a chance');
  const backstop = h.timers.find((t) => t.ms === 8000);
  assert.ok(backstop, 'no backstop armed at all');
  backstop.fn();
  assert.match(h.out.innerHTML, /Could not ask which repos exist/);
});

await check('⟳ reads it again even though the selection has not moved', async () => {
  const h = load({ respond: ONE({}) });
  await settle();
  const before = h.calls.length;
  h.refresh.events.click();
  await settle();
  assert.ok(h.calls.length > before, 'the refresh button did nothing');
});

/* =============================================================== 7. static reads */

const HTML = read('public/history.html');
const JS = read('public/history.js');

await check('every id the script reaches for is in the document', () => {
  const wanted = [...JS.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 3, `expected the script to name its elements, found ${wanted.length}`);
  const missing = wanted.filter((id) => !HTML.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `no element for: ${missing.join(', ')}`);
});

await check('the page loads the picker before its own script, and the drawer at all', () => {
  const order = [...HTML.matchAll(/<script src="\/([a-z]+)\.js"><\/script>/g)].map((m) => m[1]);
  assert.ok(order.includes('spacebar'), 'no space picker: the page would have nothing to be the ledger of');
  assert.ok(order.includes('tabbar'), 'no tab bar: a page you cannot leave');
  assert.ok(order.includes('drawer'), 'no drawer: a tap would cost your place in the list');
  assert.ok(
    order.indexOf('spacebar') < order.indexOf('history'),
    'history.js runs before spacebar.js, so it registers on a picker that does not exist yet'
  );
});

await check('the tab bar has a History tab pointing at the page', () => {
  const bar = read('public/tabbar.js');
  assert.match(bar, /id: 'history'/);
  assert.match(bar, /href: '\/history'/);
  assert.match(bar, /paths: \['\/history', '\/history\.html'\]/);
});

await check('the service worker precaches the page and moved its version', () => {
  const sw = read('public/sw.js');
  for (const p of ['/history', '/history.html', '/history.js']) {
    assert.ok(sw.includes(`'${p}'`), `${p} is not in the shell`);
  }
  const version = sw.match(/const CACHE = 'beadcause-v(\d+)'/);
  assert.ok(version, 'no cache version at all');
  assert.ok(Number(version[1]) >= 32, `the bar and the page it points at must arrive together — v${version[1]} predates the tab`);
});

await check('the daemon serves /history', () => {
  assert.match(read('lib/server.js'), /urlPath === '\/history'\) urlPath = '\/history\.html'/);
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
