#!/usr/bin/env node
/**
 * The History tab — the ledger for the selected space, most recently touched first.
 *
 *     npm test
 *     node test/history.mjs
 *
 * `test/historyapi.mjs` is the other half of this and checks the endpoint: the sweep,
 * the sort, the paging, the filters, the `errors[]` row for a repo whose `bd` fell over.
 * What is here is the page, and the page's whole job is to turn the space picker into
 * one request and what comes back into a list you can scan. So the checks are about the
 * three things that can go wrong in that translation, none of which is visible by
 * reading one function:
 *
 * 1. **The picker's three states have to become the endpoint's three.** One repo is
 *    `workspace=`, a space is `space=`, everything is neither — and the picker fills the
 *    *space* half in whenever you pick a workspace, so `{space: 'Personal', workspace:
 *    'beadcause'}` means one repo and sending both parameters would be asking the server
 *    to guess which we meant. Getting this wrong shows a plausible list of the wrong
 *    beads, which is the failure mode nobody reports because it looks like data.
 *
 * 2. **A repo whose `bd` fell over is a `200`.** It comes back with a row in `errors[]`
 *    and the other repos' rows still present — not a failed request — so a page reading
 *    `res.ok` alone draws it as a repo with nothing in it, and under a space of several
 *    repos that is one of them silently vanishing out of a merged list. It is the worst
 *    failure this page has, because it is indistinguishable from the truth.
 *
 * 3. **Waiting and empty look identical, and are not.** The uncached sweep is about a
 *    second for 500 beads on an idle Mac and was measured at 28 seconds on one under an
 *    ordinary afternoon's load here, while `{rows: [], total: 0}` is a perfectly good
 *    answer for a repo nobody has filed anything in. Both are a blank list.
 *
 * The client half runs the real `public/history.js` in a vm with a hand-made document,
 * the way test/spacebar.mjs runs the real picker — a rewrite of the logic as a test-only
 * module could not fail while the phone shipped something else.
 *
 * And the static half at the foot is the other side of that: a stub document answering
 * every selector cannot notice an element missing from the HTML, so every id the script
 * reaches for is also checked against the document that has to contain it.
 *
 * Worth knowing if you are changing this page: it used to do the merge itself, one
 * request per repo with a k-way merge over a buffer each, because the endpoint was
 * described as taking one workspace. It does not — `ledgerWorkspaces` in lib/server.js
 * resolves all three picker states — and the second implementation went away. If you are
 * about to add one back, that is the history.
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

/** One turn of the macrotask queue drains every microtask behind it. */
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const iso = (h) => new Date(Date.UTC(2026, 0, 1) + h * 3600e3).toISOString();

const ALL = { space: 'all', workspace: 'all' };

/**
 * The real file, in a room with the four things it touches: the list element, the pulse
 * dot, the ⟳ button, and the space picker it registers itself on.
 *
 * `out` keeps `innerHTML` as the string it was handed — which is what every check below
 * reads — and answers `querySelector('#hist-more')` only when that string actually
 * contains the button. A stub that always answered could not notice the button was never
 * drawn, which is half of what this suite is for.
 *
 * `IntersectionObserver` is deliberately absent from the realm, so the page falls back to
 * the button being the only way to ask for more. That is the accessible path anyway, and
 * it makes "how many pages were fetched" something the test decides rather than the
 * layout.
 */
function load({ token = 'tok', filter = ALL, respond } = {}) {
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

  const store = new Map();
  if (token) store.set('beadcause.token', token);

  const listeners = [];
  const space = {
    filter,
    label() {
      if (this.filter.workspace !== 'all') return this.filter.workspace;
      if (this.filter.space !== 'all') return this.filter.space;
      return 'everything';
    },
    onChange: (fn) => listeners.push(fn),
  };

  const calls = [];
  const fetchStub = async (url, opts) => {
    const q = new URL(url, 'http://x').searchParams;
    const call = {
      // Present as `null` rather than absent, so a test can assert a parameter was NOT
      // sent — which is the whole of case 1 for `All spaces`.
      workspace: q.get('workspace'),
      space: q.get('space'),
      offset: Number(q.get('offset')),
      limit: Number(q.get('limit')),
      refresh: q.get('refresh') === '1',
      token: opts && opts.headers && opts.headers['x-beadcause-token'],
    };
    calls.push(call);
    const body = await respond(call);
    if (body && body.status) return { ok: false, status: body.status };
    // `x-beadcause-kept` is how the daemon says how old the answer is (lib/cache.js), and
    // a `respond` that says nothing about it stands for a daemon that sent no header —
    // which is a real case (an older build) and must draw as *unknown*, not as fresh.
    const headers = { get: (name) => (String(name).toLowerCase() === 'x-beadcause-kept' ? body.kept || null : null) };
    return { ok: true, status: 200, headers, json: async () => body };
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
    Object,
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
    /** Move the picker, the way spacebar.js announces it. */
    pick(next) {
      space.filter = next;
      for (const fn of listeners) fn({ source: 'pick' });
    },
    /** The picker re-announcing what it already said — which it does on load and after
     *  every write of its own. */
    reannounce() {
      for (const fn of listeners) fn({ source: 'load' });
    },
  };
}

/** The bead ids drawn, in the order they are drawn. */
const idsOf = (h) => [...h.out.innerHTML.matchAll(/<span class="pill id">([^<]+)<\/span>/g)].map((m) => m[1]);

/** A ledger of `n` beads, paged the way lib/history.js pages it. */
const ledger = (n, extra = {}) => async (call) => {
  const all = Array.from({ length: n }, (_, i) => ({
    id: `de-${String(i).padStart(3, '0')}`,
    workspace: i % 2 ? 'other' : 'demo',
    title: `row ${i}`,
    type: 'task',
    status: 'closed',
    priority: 2,
    updated: iso(n - i),
    created: iso(0),
    closeReason: `Landed as #${i}`,
    hasSession: false,
    createdBy: 'x',
    provenance: 'human',
    labels: [],
    ...extra,
  }));
  const rows = all.slice(call.offset, call.offset + call.limit);
  return {
    workspace: call.workspace || '',
    space: call.space || 'all',
    rows,
    total: n,
    limit: call.limit,
    offset: call.offset,
    more: call.offset + rows.length < n,
    errors: [],
  };
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

/* ================================ 1. the picker's three states, as three requests */

await check('All spaces sends neither parameter — the endpoint default, not a magic value', async () => {
  const h = load({ filter: ALL, respond: ledger(3) });
  await settle();
  assert.equal(h.calls[0].workspace, null, 'sent a workspace for a selection that is every repo');
  assert.equal(h.calls[0].space, null, 'sent a space for a selection that is every space');
});

await check('a space sends space=, and only that', async () => {
  const h = load({ filter: { space: 'Personal', workspace: 'all' }, respond: ledger(3) });
  await settle();
  assert.equal(h.calls[0].space, 'Personal');
  assert.equal(h.calls[0].workspace, null);
});

await check('a repo sends workspace= and NOT the space the picker filled in beside it', async () => {
  // `filterOf` in spacebar.js always fills the space half in when a repo is picked, so
  // this is the shape that actually arrives — and sending both would be asking the
  // server which of the two we meant.
  const h = load({ filter: { space: 'Personal', workspace: 'beadcause' }, respond: ledger(3) });
  await settle();
  assert.equal(h.calls[0].workspace, 'beadcause');
  assert.equal(h.calls[0].space, null, 'sent a whole space alongside the one repo that was picked');
});

await check('the synthetic Other group is a space like any other', async () => {
  // `ledgerWorkspaces` maps it to the repos in no configured space. Nothing here is
  // special-cased for it, which is the point: a special case is how the two halves of
  // this would start to differ.
  const h = load({ filter: { space: 'Other', workspace: 'all' }, respond: ledger(3) });
  await settle();
  assert.equal(h.calls[0].space, 'Other');
});

await check('moving the picker throws the list away and asks again', async () => {
  const h = load({ filter: ALL, respond: ledger(3) });
  await settle();
  h.pick({ space: 'all', workspace: 'beadcause' });
  await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].workspace, 'beadcause');
  assert.equal(h.calls[1].offset, 0, 'kept an offset counted into a different selection');
});

await check('but the picker re-announcing the same selection does not', async () => {
  const h = load({ filter: ALL, respond: ledger(3) });
  await settle();
  h.reannounce();
  await settle();
  assert.equal(h.calls.length, 1, 'refetched the whole ledger for an announcement that changed nothing');
});

/* ================================================================== 2. the paging */

await check('the first page is one request, and it is a page rather than everything', async () => {
  const h = load({ respond: ledger(200) });
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(idsOf(h).length, h.calls[0].limit);
});

await check('Load more advances the offset by what actually arrived', async () => {
  const h = load({ respond: ledger(200) });
  await settle();
  const first = h.calls[0].limit;
  h.button.events.click();
  await settle();
  assert.equal(h.calls[1].offset, first, `asked from ${h.calls[1].offset} after ${first} rows`);
  assert.equal(idsOf(h).length, first * 2);
});

await check('every bead appears exactly once across the whole list', async () => {
  const h = await whole({ respond: ledger(200) });
  const ids = idsOf(h);
  assert.equal(ids.length, 200, `expected all 200 beads, got ${ids.length}`);
  assert.equal(new Set(ids).size, 200, 'a bead is drawn twice');
});

await check('and in the order the server sent them, newest first', async () => {
  const h = await whole({ respond: ledger(200) });
  const stamps = [...h.out.innerHTML.matchAll(/<time datetime="([^"]+)"/g)].map((m) => Date.parse(m[1]));
  const wrong = stamps.findIndex((t, i) => i > 0 && t > stamps[i - 1]);
  assert.equal(wrong, -1, `row ${wrong} is newer than the one above it`);
});

await check('the list ends, and says so instead of offering a button', async () => {
  const h = await whole({ respond: ledger(200) });
  assert.match(h.out.innerHTML, /That is all of it/);
});

await check('a `more: true` over an empty page ends the list instead of looping forever', async () => {
  let n = 0;
  const h = load({
    respond: async (call) => {
      n += 1;
      // A hang is what the bug would look like, so it is turned into an assertion: past
      // a handful of calls the fixture refuses, and the count below fails rather than
      // the suite never returning.
      if (n > 6) return { status: 500 };
      return { workspace: call.workspace || '', rows: [], total: 0, more: true, errors: [] };
    },
  });
  await settle();
  assert.equal(n, 1, `asked ${n} times for a page the server had already emptied`);
  assert.match(h.out.innerHTML, /Nothing in/);
});

await check('a page belonging to the selection you just left never lands in the list', async () => {
  let release = null;
  const held = new Promise((r) => {
    release = r;
  });
  const row = (id, ws) => ({
    id, workspace: ws, title: id, type: 'task', status: 'open', priority: 2,
    updated: iso(3), closeReason: null, hasSession: false,
  });
  const h = load({
    filter: { space: 'all', workspace: 'slow' },
    respond: async (call) => {
      if (call.workspace === 'slow') {
        await held;
        return { workspace: 'slow', rows: [row('slow-1', 'slow')], total: 1, more: false, errors: [] };
      }
      return { workspace: call.workspace, rows: [row('fast-1', 'fast')], total: 1, more: false, errors: [] };
    },
  });
  await settle(3);
  h.pick({ space: 'all', workspace: 'fast' });
  await settle();
  release();
  await settle();
  assert.deepEqual(idsOf(h), ['fast-1'], 'the abandoned selection’s row arrived anyway');
});

/* ============================================ 3. the row, and what it links to */

const ONE = (row) => async (call) => ({
  workspace: call.workspace || '',
  rows: call.offset
    ? []
    : [
        {
          id: 'de-1', workspace: 'demo', title: 'A bead', type: 'task', status: 'closed',
          priority: 1, updated: iso(4), closeReason: 'Landed as #9 as abc1234', hasSession: false, ...row,
        },
      ],
  total: 1,
  more: false,
  errors: [],
});

await check('a row links to the bead detail sheet, deep-linked open', async () => {
  const h = load({ respond: ONE({}) });
  await settle();
  assert.match(h.out.innerHTML, /href="\/graph\?ws=demo&amp;id=de-1&amp;open=1"/);
});

await check('the row is a real link, so drawer.js can hold the sheet over the list', async () => {
  const h = load({ respond: ONE({}) });
  await settle();
  assert.match(h.out.innerHTML, /<a class="hist-row/);
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

await check('the repo is named on each row unless the selection is one repo', async () => {
  const one = load({ filter: { space: 'all', workspace: 'demo' }, respond: ONE({}) });
  await settle();
  assert.doesNotMatch(one.out.innerHTML, /hist-ws/, 'the same repo on every row of a single-repo list is noise');

  const many = load({ filter: ALL, respond: ONE({}) });
  await settle();
  assert.match(many.out.innerHTML, /hist-ws/, 'no way to tell which repo a row came from');
});

await check('the token rides on the request', async () => {
  const h = load({ respond: ONE({}) });
  await settle();
  assert.equal(h.calls[0].token, 'tok');
});

await check('an unpaired device is told so, and asks for nothing', async () => {
  const h = load({ token: '', respond: async () => ({ rows: [] }) });
  await settle();
  assert.match(h.out.innerHTML, /not paired/);
  assert.equal(h.calls.length, 0, 'fetched the ledger with no token');
});

/* ====================================== 4. a repo that fell over, inside a 200 */

await check('a 200 carrying an errors[] row is a failure, not an empty repo', async () => {
  const h = load({
    respond: async (call) => ({
      workspace: call.workspace || '', rows: [], total: 0, more: false,
      errors: [{ workspace: 'demo', error: 'bd exited 1' }],
    }),
  });
  await settle();
  assert.match(h.out.innerHTML, /Could not read demo \(bd exited 1\)/);
  assert.doesNotMatch(h.out.innerHTML, /Nothing in/, 'a repo that could not be read was drawn as a repo with nothing in it');
});

await check('and the repos that did answer still draw around it', async () => {
  const h = load({
    respond: async (call) => ({
      workspace: '', total: 1, more: false,
      rows: [{ id: 'ot-1', workspace: 'other', title: 'still here', type: 'task', status: 'open', priority: 2, updated: iso(2), closeReason: null, hasSession: false }],
      errors: [{ workspace: 'demo', error: 'bd exited 1' }],
    }),
  });
  await settle();
  assert.match(h.out.innerHTML, /Could not read demo/);
  assert.match(h.out.innerHTML, /still here/);
});

await check('a repo that recovers on ⟳ stops being warned about', async () => {
  let broken = true;
  const h = load({
    respond: async (call) => {
      const errors = broken ? [{ workspace: 'demo', error: 'bd exited 1' }] : [];
      broken = false;
      return { workspace: call.workspace || '', rows: [], total: 0, more: false, errors };
    },
  });
  await settle();
  assert.match(h.out.innerHTML, /Could not read demo/);
  h.refresh.events.click();
  await settle();
  assert.doesNotMatch(h.out.innerHTML, /Could not read/, 'the warning outlived the failure it was about');
});

/* ============================== 4b. the mark that says you are looking at a kept answer */

/**
 * bc-1kwl.2.3. The daemon serves a ten-second-old ledger immediately and sweeps behind
 * the response, so "these rows are current" stopped being something this page could
 * assume — and a page that quietly draws an old list while claiming nothing is the
 * failure the whole staleness marker exists to prevent. `kept` in these fixtures is the
 * `x-beadcause-kept` header the stub hands back; see lib/cache.js for the format.
 */
await check('a kept answer is marked, quietly, on the count line', async () => {
  const h = load({
    filter: { space: 'all', workspace: 'demo' },
    respond: async (call) => ({ ...(await ledger(3)(call)), kept: 'stale; age=41; refreshing' }),
  });
  await settle();
  assert.match(h.out.innerHTML, /as of 41s ago, refreshing/);
  assert.match(h.out.innerHTML, /class="hist-kept"/, 'and in the muted style, not as a warning');
  assert.doesNotMatch(h.out.innerHTML, /Reading…|spinner/, 'the rows are there — nothing may cover them to say so');
});

await check('a fresh answer is not marked at all', async () => {
  const h = load({
    filter: { space: 'all', workspace: 'demo' },
    respond: async (call) => ({ ...(await ledger(3)(call)), kept: 'fresh; age=2' }),
  });
  await settle();
  assert.doesNotMatch(h.out.innerHTML, /as of /);
});

await check('and a daemon that says nothing about it is not accused of holding rows back', async () => {
  const h = load({ filter: { space: 'all', workspace: 'demo' }, respond: ledger(3) });
  await settle();
  assert.doesNotMatch(h.out.innerHTML, /as of /);
});

await check('the mark goes on the repaint that brings fresh rows', async () => {
  let first = true;
  const h = load({
    filter: { space: 'all', workspace: 'demo' },
    respond: async (call) => {
      const kept = first ? 'stale; age=12; refreshing' : 'fresh; age=0';
      first = false;
      return { ...(await ledger(3)(call)), kept };
    },
  });
  await settle();
  assert.match(h.out.innerHTML, /as of 12s ago/);
  h.refresh.events.click();
  await settle();
  assert.doesNotMatch(h.out.innerHTML, /as of /, 'the mark outlived the staleness it was about');
});

/**
 * The state a person actually needs telling about: the rows are old, `bd` has started
 * refusing, and nothing is going to replace them until it stops. Distinguished from a
 * repo that could not be read at all, because that repo's rows are *not* on the screen
 * and this one's are — saying "everything below is the rest of the selection" over a
 * list that is largely the failed repo's own rows would be untrue as well as alarming.
 */
await check('a repo being drawn over a failed refresh is told apart from one that would not answer', async () => {
  const h = load({
    filter: { space: 'all', workspace: 'demo' },
    respond: async (call) => ({
      ...(await ledger(3)(call)),
      kept: 'stale; age=95; refreshing',
      errors: [{ workspace: 'demo', error: 'dolt: database is locked', stale: true }],
    }),
  });
  await settle();
  assert.match(h.out.innerHTML, /showing the last good read/);
  assert.match(h.out.innerHTML, /as of 95s ago/);
  // The count survives it: every row of that repo is on the screen and counted, which is
  // exactly what a count being "the whole truth" means. A repo that could not be read at
  // all is the case that suppresses it, and that one still does — the check below.
  assert.match(h.out.innerHTML, /beads in demo/);
  assert.doesNotMatch(h.out.innerHTML, /Could not read/, 'its rows are on the screen — it was read, just not recently');
});

await check('while a repo that really would not answer still says so', async () => {
  const h = load({
    respond: async (call) => ({
      workspace: call.workspace || '', rows: [], total: 0, more: false,
      errors: [{ workspace: 'demo', error: 'bd exited 1' }],
    }),
  });
  await settle();
  assert.match(h.out.innerHTML, /Could not read demo/);
  assert.doesNotMatch(h.out.innerHTML, /last good read/);
});

await check('a daemon with no ledger endpoint is an empty state, not a broken page', async () => {
  const h = load({ respond: async () => ({ status: 404 }) });
  await settle();
  assert.match(h.out.innerHTML, /no ledger here/);
});

await check('a failed second page keeps the first — it is not a reason to lose the list', async () => {
  let n = 0;
  const h = load({
    respond: async (call) => {
      n += 1;
      if (n > 1) return { status: 500 };
      return ledger(200)(call);
    },
  });
  await settle();
  const before = idsOf(h).length;
  h.button.events.click();
  await settle();
  assert.equal(idsOf(h).length, before, 'threw the rows away over a failed next page');
  assert.match(h.out.innerHTML, /Could not read/);
});

await check('a count is only drawn when it is the whole truth', async () => {
  const whole_ = load({ filter: { space: 'all', workspace: 'demo' }, respond: ledger(42) });
  await settle();
  assert.match(whole_.out.innerHTML, /42 beads in demo/);

  const partial = load({
    respond: async (call) => ({ ...(await ledger(42)(call)), errors: [{ workspace: 'other', error: 'bd exited 1' }] }),
  });
  await settle();
  assert.doesNotMatch(partial.out.innerHTML, /beads in /, 'a total counted over the repos that answered, drawn as the whole');
});

/* ============================================= 5. waiting is not the same as empty */

await check('a first read that has not landed says so, rather than "nothing here"', async () => {
  let release = null;
  const held = new Promise((r) => {
    release = r;
  });
  const h = load({
    respond: async (call) => {
      await held;
      return { workspace: call.workspace || '', rows: [], total: 0, more: false, errors: [] };
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
  // `Bd.listAll` is allowed 120s for exactly this, so a client-side abort under it would
  // make the tab look broken on precisely the busy afternoons it is opened to catch up.
  assert.doesNotMatch(read('public/history.js'), /AbortController|AbortSignal|signal:/);
});

await check('⟳ asks the daemon to sweep again rather than re-reading its cache', async () => {
  const h = load({ respond: ledger(200) });
  await settle();
  assert.ok(!h.calls.some((c) => c.refresh), 'a plain visit forced a re-sweep');
  h.refresh.events.click();
  await settle();
  assert.ok(h.calls.some((c) => c.refresh), '⟳ was answered out of the cache it is doubting');
});

await check('but a long scroll does not — one re-sweep per press, not per page', async () => {
  const h = load({ respond: ledger(200) });
  await settle();
  h.refresh.events.click();
  await settle();
  for (let i = 0; i < 4 && h.out.querySelector('#hist-more'); i += 1) {
    h.button.events.click();
    await settle();
  }
  const forced = h.calls.filter((c) => c.refresh).length;
  assert.equal(forced, 1, `${forced} full sweeps for one press — the scroll is meant to be free`);
});

/* =============================================================== 6. static reads */

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
  assert.ok(Number(version[1]) >= 34, `the bar and the page it points at must arrive together — v${version[1]} predates the tab`);
});

await check('the daemon serves /history', () => {
  assert.match(read('lib/server.js'), /urlPath === '\/history'\) urlPath = '\/history\.html'/);
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
