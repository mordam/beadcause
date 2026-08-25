#!/usr/bin/env node
/**
 * The History tab's filter bar — status, priority, provenance and an id substring.
 *
 *     npm test
 *     node test/historyfilter.mjs
 *
 * `test/historyapi.mjs` checks that the endpoint honours these four and refuses a word
 * it does not know; `test/history.mjs` checks the list they narrow. What is here is the
 * bar itself, and it is the half where the interesting failures are, because the filters
 * live in the **hash's own query** and nowhere else (`#history?status=closed`, decision 5
 * in public/hashroute.js):
 *
 * 1. **A chip has to reach the daemon, not the rows on screen.** The list is paged and
 *    the filtering happens in the daemon over a swept cache (lib/history.js), so a
 *    filter re-applied here over the forty rows already fetched would be a second,
 *    quietly different `matches` — narrowing correctly on page one and hiding everything
 *    a wider filter should have *added*. Every check below reads the request.
 *
 * 2. **The URL is the state, so a reload is the same screen.** That is the whole reason
 *    a narrowed ledger can be a home screen shortcut, and it is what bc-nib3.7 turns
 *    `/closed` into. A filter kept anywhere else — a variable, localStorage — is a link
 *    that opens a different list for whoever you sent it to.
 *
 * 3. **A word the tracker does not use is refused out loud.** `/api/history` 400s and
 *    names it, deliberately, because dropping the parameter would show an unnarrowed
 *    list under chips claiming otherwise. The pane has to draw that sentence *and* leave
 *    a way out that is not the address bar — which is why an unrecognised value becomes
 *    a chip of its own, pressed.
 *
 * 4. **Clearing has to be free.** The acceptance criterion says the full list comes back
 *    without a page reload, which means no `location.reload`, no navigation, and a
 *    request with none of the four parameters on it.
 *
 * Both real files run in a vm with a hand-made document, the real public/hashroute.js for
 * the hash grammar, and a stand-in for public/panes.js — public/filtermenu.js for the
 * panel and public/history.js for what the chips mean — the way test/inboxkinds.mjs
 * drives the inbox's half. A rewrite of either as a test-only module could not fail
 * while the phone shipped something else.
 *
 * Every check below runs against the shell, because that is the only document
 * public/history.js draws into any more (bc-khoe.30.15 took the `/history` page and its
 * `location.search` grammar out). `staged: true` opts a check into the other half of the
 * shell's behaviour — nothing drawn until `build()` is called by hand — for the handful
 * of checks that are actually about the staged boot rather than about a filter.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { STATUSES, PROVENANCES } from '../lib/history.js';

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

console.log('\nthe history filter bar\n');

/* ================================================================== a document */

/** Just enough of an element for a file that keeps every node it makes. As in
 *  test/inboxkinds.mjs — no parser, no selector engine. */
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.text = '';
    const self = this;
    this.classList = {
      add: (c) => self.setClasses([...self.classes(), c]),
      remove: (c) => self.setClasses(self.classes().filter((x) => x !== c)),
      contains: (c) => self.classes().includes(c),
      toggle: (c, on) => (on ? self.classList.add(c) : self.classList.remove(c)),
    };
  }
  classes() {
    return String(this.className || '')
      .split(/\s+/)
      .filter(Boolean);
  }
  setClasses(list) {
    this.className = [...new Set(list)].join(' ');
  }
  set textContent(v) {
    this.children = [];
    this.text = String(v);
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  contains(node) {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  fire(type, ev = {}) {
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }
  focus() {
    if (this.doc) this.doc.activeElement = this;
  }
  all(cls, out = []) {
    for (const c of this.children) {
      if (c.classes().includes(cls)) out.push(c);
      c.all(cls, out);
    }
    return out;
  }
}

/* ================================================================== the harness */

/** One turn of the macrotask queue drains every microtask behind it. */
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const iso = (h) => new Date(Date.UTC(2026, 0, 1) + h * 3600e3).toISOString();
const ALL = { space: 'all', workspace: 'all' };

/** A ledger row, shaped the way lib/history.js `toRow` shapes one. */
const row = (i, extra = {}) => ({
  id: `bc-${String(i).padStart(3, '0')}`,
  workspace: 'beadcause',
  title: `row ${i}`,
  type: 'task',
  status: 'closed',
  priority: 2,
  updated: iso(100 - i),
  created: iso(0),
  closeReason: null,
  labels: [],
  createdBy: 'x',
  provenance: 'human',
  hasSession: false,
  ...extra,
});

/**
 * Both real files, in a room with a document, an address bar and a `fetch` — the shell,
 * which is the only document either ever runs in any more (bc-khoe.30.15).
 *
 * `respond` is handed the parsed request — the four filter parameters among them — and
 * answers with a payload, or with `{ status, error }` for a refusal. `hash` is the
 * address the pane is opened at, which is the whole of what a reload or a shared link
 * amounts to here.
 *
 * `staged` opts into the other half of the shell's behaviour: with it, nothing is built
 * until `build()` is called by hand, the way public/panestage.js would; without it (the
 * default), history.js finds no stager and builds itself immediately, the way it always
 * has and the way most of the checks below want it to, so they can go straight from
 * `load()` to asking what the pane drew.
 */
function load({ hash = '#history', respond, hover = false, staged = false } = {}) {
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
  out.querySelector = (sel) => (sel === '#hist-more' && /id="hist-more"/.test(out.innerHTML) ? button : null);
  const appRefresh = mk();

  const doc = {
    activeElement: null,
    listeners: new Map(),
    createElement(tag) {
      const el = new El(tag);
      el.doc = doc;
      return el;
    },
    addEventListener(type, fn) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push(fn);
    },
    fire(type, ev = {}) {
      for (const fn of doc.listeners.get(type) || []) fn(ev);
    },
  };

  const host = doc.createElement('nav');
  // `hist-list` rather than `history` since bc-khoe.30.5: the hash that names this view is
  // `#history`, and an element of that id would be a fragment target. `refresh` is the
  // app's one ⟳, shared with every other view — the pane's own `hist-refresh` went with
  // the page it belonged to (bc-khoe.30.15).
  doc.getElementById = (id) =>
    id === 'refresh' ? appRefresh : id === 'hist-list' ? out : id === 'hist-filters' ? host : null;

  const location = { pathname: '/', search: '', hash };
  /** Every address the pane has written, so a check can see that it wrote one at all. */
  const written = [];
  const history = {
    replaceState: (_s, _t, url) => {
      written.push(String(url));
      const raw = String(url);
      const hashAt = raw.indexOf('#');
      const head = hashAt === -1 ? raw : raw.slice(0, hashAt);
      location.hash = hashAt === -1 ? '' : raw.slice(hashAt);
      const at = head.indexOf('?');
      location.search = at === -1 ? '' : head.slice(at);
    },
  };

  const listeners = [];
  const space = {
    filter: ALL,
    label: () => 'everything',
    onChange: (fn) => listeners.push(fn),
  };

  const calls = [];
  const fetchStub = async (url, opts) => {
    const q = new URL(url, 'http://x').searchParams;
    const call = {
      workspace: q.get('workspace'),
      space: q.get('space'),
      status: q.get('status'),
      priority: q.get('priority'),
      provenance: q.get('provenance'),
      id: q.get('id'),
      offset: Number(q.get('offset')),
      limit: Number(q.get('limit')),
      refresh: q.get('refresh') === '1',
      token: opts && opts.headers && opts.headers['x-beadcause-token'],
    };
    calls.push(call);
    const body = await respond(call);
    if (body && body.status) {
      return { ok: false, status: body.status, json: async () => ({ error: body.error }) };
    }
    return { ok: true, status: 200, json: async () => body };
  };

  const window = {
    beadcause: { space },
    matchMedia: (q) => ({ matches: q.includes('hover: hover') ? hover : false }),
  };
  const ctx = vm.createContext({
    window,
    document: doc,
    localStorage: { getItem: (k) => (k === 'beadcause.token' ? 'tok' : null) },
    fetch: fetchStub,
    location,
    history,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    URL,
    Object,
    JSON,
    Date,
    Number,
    Array,
    Boolean,
    String,
    Set,
    RegExp,
    Promise,
    console,
  });
  /*
    The real grammar out of public/hashroute.js, and a stand-in for public/panes.js that
    has only the three questions history.js actually asks of it. `staged` is a stand-in
    for the stager as well — it hands `build` back so a check can decide when this view
    goes up, which is the whole point of the staged boot; without it, `register` is not
    offered at all and history.js takes the fallback path it always has.
  */
  const shown = [];
  let showing = 'history';
  let spec = null;
  vm.runInContext(read('public/hashroute.js'), ctx, { filename: 'hashroute.js' });
  const route = window.beadcause.route;
  window.beadcause.panes = {
    has: (v) => route.VIEWS.some((one) => one.id === v),
    showing: () => showing,
    onShow: (fn) => shown.push(fn),
    go(v) {
      showing = v;
      location.hash = route.hashFor(v);
      for (const fn of shown) fn(v);
    },
  };
  window.beadcause.stream = { moved: (events) => (events || []).some((e) => e && e.type !== 'presence') };
  if (staged) {
    window.beadcause.stage = {
      register(view, s2) {
        spec = { view, ...s2 };
        return true;
      },
    };
  }

  vm.runInContext(read('public/filtermenu.js'), ctx, { filename: 'filtermenu.js' });
  vm.runInContext(read('public/history.js'), ctx, { filename: 'history.js' });

  return {
    out,
    host,
    doc,
    calls,
    location,
    written,
    appRefresh,
    button,
    /** What this view handed the stager, or null when it built itself unasked. */
    spec: () => spec,
    /** Build the pane, the way public/panestage.js would. Only meaningful when `staged`. */
    build: () => spec.build(),
    /** Hand it an answered poll, the way public/panestage.js fans one out. */
    wake: (events) => spec.wake({ data: null, events, resync: false }),
    /** Move to another pane, or back to this one, the way a pill tap does. */
    go: (v) => window.beadcause.panes.go(v),
  };
}

/* The row, by shape rather than by selector — `.filter-menu` holds one `.filter-one` per
   group since bc-khoe.26, and each of those is its pill, the note drawn in the pill's
   place where a view cannot offer it, and the panel the pill opens. */
const root = (h) => h.host.children[0];
const one = (h, id) => root(h).children.find((b) => b.dataset.group === id);
const pillOf = (h, id) => one(h, id).children[0];
/** `Legend: value` where the group is narrowing, and the bare legend where it is not. */
const says = (h, id) => {
  const value = pillOf(h, id).children[1].textContent;
  const legend = pillOf(h, id).children[0].textContent;
  // The legend carries its own colon when there is a value — see `paintGroup`.
  return value ? `${legend} ${value}` : legend;
};
const panel = (h, id) => one(h, id).children[2];
const groupBox = (h, id) => panel(h, id).children[0];
const chipsOf = (h, id) => groupBox(h, id).children[0].children;
const chipIn = (h, gid, cid) => chipsOf(h, gid).find((c) => c.dataset.chip === cid);
const pressed = (h, gid) => chipsOf(h, gid).filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.chip);
/* By class rather than by position: bc-0xil put the input inside a wrapper so that a
   typeahead's pills and dropdown could be its siblings, and a helper that counts
   children would break every time the box grows a neighbour it does not care about. */
const idBox = (h) => groupBox(h, 'beadid').all('filter-text')[0];

/** A ledger the daemon would answer with, filtered the way lib/history.js filters. */
const ledgerOf = (rows) => async (call) => {
  const wantStatus = call.status ? call.status.split(',') : null;
  const wantPriority = call.priority ? call.priority.split(',').map((p) => Number(p.replace(/^[pP]/, ''))) : null;
  const kept = rows.filter(
    (r) =>
      (!wantStatus || wantStatus.includes(r.status)) &&
      (!wantPriority || wantPriority.includes(r.priority)) &&
      (!call.provenance || r.provenance === call.provenance) &&
      (!call.id || r.id.toLowerCase().includes(call.id.toLowerCase()))
  );
  const page = kept.slice(call.offset, call.offset + call.limit);
  return {
    workspace: '',
    space: 'all',
    query: {},
    rows: page,
    total: kept.length,
    limit: call.limit,
    offset: call.offset,
    more: call.offset + page.length < kept.length,
    errors: [],
  };
};

const ROWS = [
  row(1, { status: 'open', priority: 0, provenance: 'agent' }),
  row(2, { status: 'closed', priority: 2, provenance: 'human' }),
  row(3, { status: 'in_progress', priority: 1, provenance: 'agent' }),
  row(4, { status: 'closed', priority: 0, provenance: 'human' }),
];
const idsOn = (h) => [...h.out.innerHTML.matchAll(/<span class="pill id">([^<]+)<\/span>/g)].map((m) => m[1]);
const last = (h) => h.calls[h.calls.length - 1];

/* ================================================ 1. a chip is a request, not a re-filter */

console.log('each filter narrows the list, at the daemon');

await check('a status chip is sent, and the list is what came back', async () => {
  const h = load({ respond: ledgerOf(ROWS) });
  await settle();
  assert.equal(last(h).status, null, 'a filter was sent before one was chosen');
  assert.deepEqual(idsOn(h), ['bc-001', 'bc-002', 'bc-003', 'bc-004']);

  chipIn(h, 'status', 'closed').fire('click');
  await settle();
  assert.equal(last(h).status, 'closed');
  assert.deepEqual(idsOn(h), ['bc-002', 'bc-004'], 'the rows are not the ones the daemon answered with');
});

await check('a priority chip is sent as P0, which is what parseQuery takes P for', async () => {
  const h = load({ respond: ledgerOf(ROWS) });
  await settle();
  chipIn(h, 'priority', 'P0').fire('click');
  await settle();
  assert.equal(last(h).priority, 'P0');
  assert.deepEqual(idsOn(h), ['bc-001', 'bc-004']);
});

await check('provenance is one choice, and tapping it again clears it', async () => {
  const h = load({ respond: ledgerOf(ROWS) });
  await settle();
  chipIn(h, 'provenance', 'agent').fire('click');
  await settle();
  assert.equal(last(h).provenance, 'agent');
  assert.deepEqual(idsOn(h), ['bc-001', 'bc-003']);

  chipIn(h, 'provenance', 'human').fire('click');
  await settle();
  assert.equal(last(h).provenance, 'human', 'a second choice did not replace the first');
  assert.deepEqual(pressed(h, 'provenance'), ['human'], 'two provenances are pressed at once');

  chipIn(h, 'provenance', 'human').fire('click');
  await settle();
  assert.equal(last(h).provenance, null, 'tapping the pressed chip did not clear it');
});

await check('the id box narrows on the id, a beat after you stop typing', async () => {
  const h = load({ respond: ledgerOf(ROWS) });
  await settle();
  const before = h.calls.length;
  const box = idBox(h);
  for (const text of ['b', 'bc', 'bc-0', 'bc-00', 'bc-003']) {
    box.value = text;
    box.fire('input');
  }
  assert.equal(h.calls.length, before, 'a request went out mid-word — five keystrokes is five sweeps');
  await sleep(400);
  await settle();
  assert.equal(h.calls.length, before + 1, `five keystrokes became ${h.calls.length - before} requests`);
  assert.equal(last(h).id, 'bc-003');
  assert.deepEqual(idsOn(h), ['bc-003']);
});

await check('all four combine, ANDed, in one request', async () => {
  const h = load({ respond: ledgerOf(ROWS) });
  await settle();
  chipIn(h, 'status', 'closed').fire('click');
  await settle();
  chipIn(h, 'priority', 'P0').fire('click');
  await settle();
  chipIn(h, 'provenance', 'human').fire('click');
  await settle();
  const box = idBox(h);
  box.value = 'bc-00';
  box.fire('input');
  await sleep(400);
  await settle();
  assert.deepEqual(
    { status: last(h).status, priority: last(h).priority, provenance: last(h).provenance, id: last(h).id },
    { status: 'closed', priority: 'P0', provenance: 'human', id: 'bc-00' }
  );
  assert.deepEqual(idsOn(h), ['bc-004']);
});

await check('two chips in one group are a comma list, not two requests', async () => {
  const h = load({ respond: ledgerOf(ROWS) });
  await settle();
  chipIn(h, 'status', 'closed').fire('click');
  await settle();
  chipIn(h, 'status', 'open').fire('click');
  await settle();
  assert.equal(last(h).status, 'closed,open');
  assert.deepEqual(idsOn(h), ['bc-001', 'bc-002', 'bc-004']);
});

/* ============================================================ 2. the URL is the state */

console.log('\nthe filters are in the URL, and the URL is where they come from');

await check('a chip writes the address bar', async () => {
  const h = load({ respond: ledgerOf(ROWS) });
  await settle();
  chipIn(h, 'status', 'closed').fire('click');
  await settle();
  assert.equal(h.location.hash, '#history?status=closed');
});

await check('a reload at that address asks the narrowed question first, not second', async () => {
  const h = load({ hash: '#history?status=closed&priority=P0', respond: ledgerOf(ROWS) });
  await settle();
  // The *first* call, not an eventual one: a pane that fetched everything and then
  // narrowed would flash a screenful of the wrong beads at a link's recipient.
  assert.equal(h.calls[0].status, 'closed');
  assert.equal(h.calls[0].priority, 'P0');
  assert.equal(h.calls.length, 1, 'the pane asked twice for one address');
  assert.deepEqual(idsOn(h), ['bc-004']);
});

await check('and the chips it draws say the same thing', async () => {
  const h = load({ hash: '#history?status=closed,open&provenance=agent&id=bc-0', respond: ledgerOf(ROWS) });
  await settle();
  assert.deepEqual(pressed(h, 'status').sort(), ['closed', 'open']);
  assert.deepEqual(pressed(h, 'provenance'), ['agent']);
  assert.equal(idBox(h).value, 'bc-0');
});

await check('priority is taken as 1, p1 or P1 and written back as P1', async () => {
  const h = load({ hash: '#history?priority=1,p3', respond: ledgerOf(ROWS) });
  await settle();
  assert.equal(h.calls[0].priority, 'P1,P3', 'the endpoint takes P1 — the chips display it, so the URL says it');
  assert.deepEqual(pressed(h, 'priority').sort(), ['P1', 'P3']);
});

await check('each pill names its own narrowing, without anything being opened', async () => {
  // What one comma-joined line used to say, said by the controls themselves (bc-khoe.26).
  // It is strictly more than the line could: `Closed` on the status pill says *which*
  // control is narrowing the ledger, where `Closed · All priorities · nib3` left you to
  // work out which of the four to reach for.
  const h = load({ hash: '#history?status=closed&id=nib3', respond: ledgerOf(ROWS) });
  await settle();
  assert.equal(says(h, 'status'), 'Status: Closed');
  assert.equal(says(h, 'beadid'), 'Bead id: nib3');
  assert.ok(pillOf(h, 'status').classes().includes('on'), 'nothing marks the narrowed pill as narrowed');
  // And a group nobody has touched is its legend and nothing else. `All priorities` on a
  // pill would be a control announcing a filter that is not filtering, which is the same
  // noise the one line made — one pill at a time.
  assert.equal(says(h, 'priority'), 'Priority');
  assert.ok(!pillOf(h, 'priority').classes().includes('on'));
});

await check('the token is not carried into the hash — it stays in the query string', async () => {
  // `?t=` is picked up into localStorage by spacebar.js and lives in front of the `#`,
  // never in it (`/?t=x#history?status=…`) — this pane's address writer only ever
  // touches the hash, so a token sitting in `location.search` cannot leak into it.
  const h = load({ hash: '#history?status=closed', respond: ledgerOf(ROWS) });
  h.location.search = '?t=secret';
  await settle();
  chipIn(h, 'status', 'open').fire('click');
  await settle();
  assert.equal(h.location.search, '?t=secret', 'the token moved even though nothing here touches location.search');
  assert.ok(!h.location.hash.includes('secret'), `the token ended up in the hash: ${h.location.hash}`);
});

await check('a parameter this pane knows nothing about is left alone', async () => {
  // Off in `location.search` rather than the hash, which is the only slot this pane's
  // address writer ever touches — so a parameter it does not recognise is untouched by
  // construction, not merely preserved by an explicit keep-list the way the page's writer
  // once needed one.
  const h = load({ respond: ledgerOf(ROWS) });
  h.location.search = '?ws=beadcause';
  await settle();
  chipIn(h, 'status', 'open').fire('click');
  await settle();
  assert.match(h.location.search, /ws=beadcause/);
  assert.match(h.location.hash, /status=open/);
});

await check('nothing navigates — a filter is replaceState, never a reload', async () => {
  const h = load({ respond: ledgerOf(ROWS) });
  await settle();
  chipIn(h, 'status', 'open').fire('click');
  await settle();
  // `location.reload` and `location.assign` are absent from the realm entirely, so a
  // pane that reached for either would have thrown by now. This is the positive half:
  // it did write the address, by the one means that does not reload.
  assert.ok(h.written.length >= 1, 'the address bar never moved, so a reload would lose the filter');
  assert.ok(
    h.written.every((u) => u.includes('#history')),
    `wrote an address with no view named on it: ${h.written.join(', ')}`
  );
});

/* ================================================================ 3. clearing it all */

console.log('\nclearing every filter brings the whole list back');

await check('the last chip off is a bare address and an unfiltered request', async () => {
  const h = load({ hash: '#history?status=closed&priority=P0&provenance=human&id=bc', respond: ledgerOf(ROWS) });
  await settle();
  assert.deepEqual(idsOn(h), ['bc-004']);

  chipIn(h, 'status', 'closed').fire('click');
  await settle();
  chipIn(h, 'priority', 'P0').fire('click');
  await settle();
  chipIn(h, 'provenance', 'human').fire('click');
  await settle();
  const box = idBox(h);
  box.value = '';
  box.fire('input');
  await sleep(400);
  await settle();

  assert.equal(h.location.hash, '#history', `the address kept a filter: ${h.location.hash}`);
  assert.deepEqual(
    { status: last(h).status, priority: last(h).priority, provenance: last(h).provenance, id: last(h).id },
    { status: null, priority: null, provenance: null, id: null }
  );
  assert.deepEqual(idsOn(h), ['bc-001', 'bc-002', 'bc-003', 'bc-004']);
  assert.ok(!root(h).classes().includes('narrowed'), 'the line still says the list is narrowed');
});

await check('the count line says "match" while it is narrowed, and stops when it is not', async () => {
  // `total` is what the filters matched, not what the space holds — so "142 beads in
  // beadcause" under a status chip would be the one number on screen not about it.
  const h = load({ hash: '#history?status=closed', respond: ledgerOf(ROWS) });
  await settle();
  assert.match(h.out.innerHTML, /2 beads match in everything/);
  chipIn(h, 'status', 'closed').fire('click');
  await settle();
  assert.match(h.out.innerHTML, /4 beads in everything/);
  assert.ok(!/match/.test(h.out.innerHTML), 'an unnarrowed list still calls its total a match count');
});

await check('narrowed to nothing says so, rather than "nothing here yet"', async () => {
  const h = load({ hash: '#history?id=nothing-like-this', respond: ledgerOf(ROWS) });
  await settle();
  assert.match(h.out.innerHTML, /matches/, 'an empty narrowed list blamed the tracker for the filter');
  assert.ok(!/ever had/.test(h.out.innerHTML), 'it claimed the space has no history at all');
});

/* ========================================================== 4. a word it will not take */

console.log('\na filter the daemon refuses');

const refuse = (why) => async () => ({ status: 400, error: why });

await check("the daemon's sentence is drawn, naming the word", async () => {
  const h = load({ hash: '#history?status=close', respond: refuse('not a status: close — one of open, in_progress, blocked, deferred, closed') });
  await settle();
  assert.match(h.out.innerHTML, /not a status: close/);
  assert.match(h.out.innerHTML, /one of open, in_progress/, 'the half that says what it could have been was dropped');
});

await check('and it is not drawn as a repo that fell over', async () => {
  const h = load({ hash: '#history?status=close', respond: refuse('not a status: close') });
  await settle();
  assert.ok(!/Could not read/.test(h.out.innerHTML), 'a word you typed was blamed on the repo');
  assert.ok(!/yet\./.test(h.out.innerHTML), 'a refusal was drawn as an empty ledger');
});

await check('the offending word is a chip you can tap off', async () => {
  let refusing = true;
  const h = load({
    hash: '#history?status=close',
    respond: async (call) => (refusing ? { status: 400, error: 'not a status: close' } : ledgerOf(ROWS)(call)),
  });
  await settle();
  const stray = chipIn(h, 'status', 'close');
  assert.ok(stray, 'no chip for the value in the URL — the only way out is the address bar');
  assert.equal(stray.getAttribute('aria-pressed'), 'true', 'the value is applied but the chip says otherwise');

  refusing = false;
  stray.fire('click');
  await settle();
  assert.equal(h.location.hash, '#history', 'tapping it off left the word in the address');
  assert.deepEqual(idsOn(h), ['bc-001', 'bc-002', 'bc-003', 'bc-004']);
});

await check('correcting the filter clears the refusal', async () => {
  let refusing = true;
  const h = load({
    hash: '#history?status=close',
    respond: async (call) => (refusing ? { status: 400, error: 'not a status: close' } : ledgerOf(ROWS)(call)),
  });
  await settle();
  assert.match(h.out.innerHTML, /refused/);
  refusing = false;
  chipIn(h, 'status', 'closed').fire('click');
  await settle();
  assert.ok(!/refused/.test(h.out.innerHTML), 'the pane is still complaining about a filter that is gone');
});

/* ================================================================ 5. the two vocabularies */

console.log('\nthe chips and the daemon name the same things');

/* ============================================== 3b. the staged half of the pane's life */

/*
  Every check above already runs against the shell — public/history.html and its
  `location.search` grammar are gone (bc-khoe.30.15) — but with `staged` left off, so
  history.js finds no stager and builds itself immediately, the way it always has. These
  checks turn `staged: true` on instead, for the behaviour that only exists because
  public/panestage.js is real: nothing drawn until `build()` is asked for, a pane built
  once rather than refetched by arriving at it, and the address moving to and from the
  hash as the pane is shown and hidden — `route.go('')` keeps `search` alone on purpose,
  which is where `?t=` lives, so nothing here could touch it either way.
*/

console.log('\nthe staged half of the pane’s life');

await check('nothing at all happens until the stager builds it', async () => {
  const h = load({ staged: true, hash: '#history?status=closed', respond: ledgerOf(ROWS) });
  await settle();
  assert.ok(h.spec(), 'it did not offer itself to the stager');
  assert.equal(h.spec().view, 'history');
  assert.deepEqual(h.calls, [], 'it asked for the ledger while Home was the pane on screen');
  assert.equal(h.host.children.length, 0, 'it drew a filter bar into a pane nobody had asked for');
});

await check('and the hash it landed on narrows the very first request', async () => {
  const h = load({ staged: true, hash: '#history?status=closed&priority=P0', respond: ledgerOf(ROWS) });
  h.build();
  await settle();
  assert.equal(h.calls.length, 1, 'a cold pane asked twice');
  assert.equal(h.calls[0].status, 'closed');
  assert.equal(h.calls[0].priority, 'P0');
  // The whole point of reading the address before drawing: a link to `#history?status=
  // closed` must not be a screenful of open beads that then rearranges itself.
  assert.deepEqual(idsOn(h), ['bc-004']);
  assert.deepEqual(pressed(h, 'status'), ['closed']);
});

await check('a chip writes the hash, and leaves the query string alone', async () => {
  const h = load({ staged: true, hash: '#history', respond: ledgerOf(ROWS) });
  h.build();
  await settle();
  chipIn(h, 'status', 'open').fire('click');
  await settle();
  assert.equal(h.location.hash, '#history?status=open', `the hash says ${h.location.hash}`);
  assert.equal(h.location.search, '', `the filter went into the query string: ${h.location.search}`);
  assert.equal(last(h).status, 'open');
  // Still replaceState, for the reason it always was: a chip is not a place you go back to.
  assert.ok(h.written.length >= 1, 'the address never moved');
});

await check('leaving the pane and coming back keeps the filters, and puts them back on the address', async () => {
  const h = load({ staged: true, hash: '#history?status=closed', respond: ledgerOf(ROWS) });
  h.build();
  await settle();
  const asked = h.calls.length;

  h.go('epics');
  // A pill tap writes the bare hash for the view it is going to, so Home's address must
  // carry nothing of this pane's — that is the whole reason the slot moved.
  assert.equal(h.location.hash, '');
  assert.equal(h.location.search, '');

  h.go('history');
  assert.equal(h.location.hash, '#history?status=closed', 'the filters did not go back on the address');
  assert.deepEqual(pressed(h, 'status'), ['closed'], 'the chips forgot what they were showing');
  assert.deepEqual(idsOn(h), ['bc-002', 'bc-004'], 'the rows were thrown away by a switch');
  await settle();
  assert.equal(h.calls.length, asked, 'coming back to a pane nothing had happened to re-read it anyway');
});

await check('something moving is re-read the next time you look, with the rows left up meanwhile', async () => {
  const h = load({ staged: true, hash: '#history', respond: ledgerOf(ROWS) });
  h.build();
  await settle();
  const asked = h.calls.length;

  h.go('epics');
  h.wake([{ type: 'created' }]);
  h.go('history');
  // Synchronously, before anything has been fetched: the list you left is still there.
  // A pane that blanked itself to "Reading the ledger…" on every return would be the
  // document load this epic exists to remove, wearing a different mechanism.
  assert.deepEqual(idsOn(h), ['bc-001', 'bc-002', 'bc-003', 'bc-004']);

  await settle();
  assert.equal(h.calls.length, asked + 1, 'the ledger was not re-read after something moved');
  assert.equal(last(h).offset, 0, 'it asked for the next page rather than for the list again');
  assert.deepEqual(idsOn(h), ['bc-001', 'bc-002', 'bc-003', 'bc-004'], 'the swap lost rows');

  // Once, not once per look: the flag is spent by the read.
  h.go('epics');
  h.go('history');
  await settle();
  assert.equal(h.calls.length, asked + 1, 'it re-reads on every switch, which is the fetch it saved');
});

await check('and presence alone is not something moving', async () => {
  const h = load({ staged: true, hash: '#history', respond: ledgerOf(ROWS) });
  h.build();
  await settle();
  const asked = h.calls.length;
  h.go('epics');
  // A thumb on a phone somewhere. It wakes the poll on purpose and it has not changed a
  // bead, so a pane that re-read for it would have built a timer out of somebody scrolling.
  h.wake([{ type: 'presence' }]);
  h.go('history');
  await settle();
  assert.equal(h.calls.length, asked, 'a presence event cost a sweep');
});

await check('the app\u2019s one \u27f3 is spent by the pane that is up, and by no other', async () => {
  const h = load({ staged: true, hash: '#history', respond: ledgerOf(ROWS) });
  h.build();
  await settle();
  const asked = h.calls.length;

  h.go('epics');
  h.appRefresh.events.click({});
  await settle();
  assert.equal(h.calls.length, asked, 'the ledger swept `bd` for a press meant for the inbox');

  h.go('history');
  await settle();
  h.appRefresh.events.click({});
  await settle();
  assert.equal(h.calls.length, asked + 1, 'it did nothing on the pane it was pressed on');
  assert.equal(last(h).refresh, true, 'the press that means "I do not believe this" was answered from the cache');
});

await check('every status the endpoint takes has a chip, and no chip is invented', () => {
  const js = read('public/history.js');
  const block = js.match(/const STATUS_CHIPS = \[([\s\S]*?)\n {2}\];/);
  assert.ok(block, 'STATUS_CHIPS is not where this check looks for it');
  const ids = [...block[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...STATUSES], 'the chips and lib/history.js STATUSES have drifted');
});

await check('and the same for provenance, which is the label rather than the byline', () => {
  const js = read('public/history.js');
  const block = js.match(/const PROVENANCE_CHIPS = \[([\s\S]*?)\n {2}\];/);
  assert.ok(block, 'PROVENANCE_CHIPS is not where this check looks for it');
  const ids = [...block[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...PROVENANCES]);
  assert.match(block[1], /label, not the byline/i, 'the chip does not say which of the two fields it means');
});

await check('every chip carries a note, because a one-word chip has no accessible name', () => {
  const js = read('public/history.js');
  for (const name of ['STATUS_CHIPS', 'PRIORITY_CHIPS', 'PROVENANCE_CHIPS']) {
    const block = js.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n {2}\\];`));
    const chips = [...block[1].matchAll(/\{ id: '([^']+)'[^}]*\}/g)].map((m) => m[0]);
    for (const c of chips) assert.match(c, /note: '/, `${name}: ${c} has no note`);
  }
});

/* ==================================================================== 6. static reads */

console.log('\nthe shell has to actually load it');

await check('index.html has the host, and loads filtermenu.js before history.js', () => {
  // public/history.html is gone (bc-khoe.30.15) — the only document this bar mounts into
  // any more is the shell's.
  const html = read('public/index.html');
  assert.match(html, /id="hist-filters"/, 'no host element: the control would have nowhere to mount');
  const order = [...html.matchAll(/<script src="\/([a-z]+)\.js"><\/script>/g)].map((m) => m[1]);
  assert.ok(order.includes('filtermenu'), 'the shell does not load the panel at all');
  assert.ok(
    order.indexOf('filtermenu') < order.indexOf('history'),
    'history.js runs before filtermenu.js, so it mounts a control that does not exist yet'
  );
});

await check('and before the other file that mounts it', () => {
  const html = read('public/index.html');
  const order = [...html.matchAll(/<script src="\/([a-z]+)\.js"><\/script>/g)].map((m) => m[1]);
  assert.ok(
    order.indexOf('filtermenu') !== -1 && order.indexOf('filtermenu') < order.indexOf('inboxfilter'),
    'inboxfilter.js would reach for window.beadcause.filterMenu and find nothing'
  );
});

await check('the service worker ships it, on a version a cached phone will notice', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /'\/filtermenu\.js'/, 'a cached inbox would have no filter control on it at all');
  const version = sw.match(/const CACHE = 'beadcause-v(\d+)'/);
  assert.ok(Number(version[1]) >= 51, `the shell gained a file on v${version[1]} — see docs/sw-cache/`);
});

await check('the stylesheet has the id box and the refusal line', () => {
  const css = read('public/style.css');
  assert.match(css, /\.filter-text\s*\{/, 'the id input would draw as the platform default inside a dark panel');
  assert.match(css, /\.hist-refused\s*\{/, 'the refusal would draw as ordinary body text');
  assert.match(css, /font-size: 16px/, 'a smaller font in the panel zooms iOS in on focus and moves the panel out from under it');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
