#!/usr/bin/env node
/**
 * The space picker — one repo at a time, in the top bar of every standing view.
 *
 *     npm test
 *     node test/spacebar.mjs
 *
 * The feature is small and its failure modes are not, because the thing it filters is
 * also the thing that decides whether your phone rings. Four of them are worth a suite,
 * and none is visible by reading one function:
 *
 * 1. **The client's `matches()` and the server's `matchesFilter()` must agree, exactly.**
 *    The server decides whether a bead may notify you; the picker decides whether you
 *    can see it. Those two disagreeing in the direction "rings but is not shown" is a
 *    question you were told about and cannot find — the one failure this whole app
 *    exists to prevent. So they are checked against each other over every combination
 *    of filter and workspace the fixture can make, rather than by two people reading two
 *    files and agreeing they look the same.
 *
 * 2. **A workspace selected must carry its space with it.** The push path tests the
 *    space half first, and a filter of `{space: 'all', workspace: 'beadcause'}` reads as
 *    wider than it is. The dropdown fills the space in from the workspace, and that has
 *    to keep happening — it is one line, and losing it is silent.
 *
 * 3. **`GET /api/spaces` must cost no `bd` call.** It is fetched by every page load; the whole
 *    reason it exists rather than the pages sweeping the tracker themselves is that
 *    `bd human list` across every workspace is a second per call. The check points the
 *    daemon at a `bd` that does not exist and asks anyway.
 *
 * 4. **Every page that has the bar has to load the file.** The bar builds itself from
 *    JS, so a page that forgets the `<script>` shows no picker at all and silently
 *    ignores the filter — which after this change is a page showing you six repos with
 *    no control on it to say so. The service worker's shell is the same failure, one
 *    week later.
 *
 * The client half runs the real `public/spacebar.js` in a vm with a hand-made document,
 * the way test/dictate.mjs runs the real dictation — a rewrite of the logic as a
 * test-only module could not pass this while the phone shipped something else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const PUBLIC = (f) => path.join(ROOT, 'public', f);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-spacebar-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

/* The picker runs in a vm, so everything it hands back was built by that realm's own
   `Object` and fails a strict deep-equal against a host literal on the prototype alone.
   Copied into this realm before comparing — the values are what is being checked. */
const plain = (o) => (Array.isArray(o) ? [...o] : { ...o });

console.log('\nspace picker');

/* ============================================================== the client half */

/**
 * The real file, in a room with the four things it touches at load: a `.topbar` to hang
 * itself off, a `<select>`, a count, and a `fetch`.
 *
 * The stubs record rather than render — `innerHTML` is kept as the string it was handed,
 * which is exactly what the checks below want to read. A real DOM here would be testing
 * a parser.
 */
function load({ token = 'tok', fetch = async () => ({ ok: false }) } = {}) {
  const el = (id) => ({
    id,
    hidden: false,
    innerHTML: '',
    textContent: '',
    title: '',
    value: '',
    attrs: {},
    events: {},
    classes: new Set(),
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(type, fn) {
      this.events[type] = fn;
    },
    classList: {
      toggle: (name, on) => {
        if (on) el.classes?.add?.(name);
      },
    },
  });

  const select = el('space-pick');
  const bar = {
    className: '',
    hidden: true,
    innerHTML: '',
    classes: new Set(),
    querySelector: (sel) => (sel === '#space-pick' ? select : null),
    classList: {
      toggle(name, on) {
        if (on) bar.classes.add(name);
        else bar.classes.delete(name);
      },
    },
  };
  const topbar = { appended: [], append(node) { this.appended.push(node); } };

  const store = new Map();
  if (token) store.set('beadcause.token', token);

  const window = { beadcause: {} };
  const ctx = vm.createContext({
    window,
    document: {
      querySelector: (sel) => (sel === '.topbar' ? topbar : null),
      createElement: () => bar,
    },
    location: { search: '' },
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
    },
    URLSearchParams,
    fetch,
    JSON,
  });
  vm.runInContext(fs.readFileSync(PUBLIC('spacebar.js'), 'utf8'), ctx, { filename: 'spacebar.js' });
  // `win` so a check can hang something else off `beadcause` after the file has loaded —
  // which is how edit mode reaches this file, and the order the page loads them in.
  return { space: ctx.window.beadcause.space, win: ctx.window, bar, select, topbar };
}

/* One space with two repos, one muted space with one, and a repo in neither — every
   shape a workspace can be in, in four names. */
const CFG = {
  spaces: [
    { name: 'Personal', workspaces: ['beadcause', 'sophab'] },
    { name: 'Climative', workspaces: ['climative'], muted: true },
  ],
};
const NAMES = ['beadcause', 'sophab', 'climative', 'stray'];
const { summarise, matchesFilter, spaceFor } = await import(LIB('spaces.js'));
const QUESTIONS = [
  { workspace: 'beadcause' },
  { workspace: 'beadcause' },
  { workspace: 'climative' },
  { workspace: 'stray' },
];
const SPACES = summarise(CFG, QUESTIONS);

const fresh = (opts) => {
  const h = load(opts);
  h.space.adopt({ spaces: SPACES, workspaces: NAMES, filter: { space: 'all', workspace: 'all' } });
  return h;
};

/* --------------------------------------- 1. the two halves of the same decision */

check('matches() agrees with the server`s matchesFilter for every filter and repo', () => {
  const { space } = fresh();
  // Every filter the dropdown can produce, plus the two-real-halves-that-match-nothing
  // case a stale filter can be in.
  const filters = [
    { space: 'all', workspace: 'all' },
    { space: 'Personal', workspace: 'all' },
    { space: 'Climative', workspace: 'all' },
    { space: 'Other', workspace: 'all' },
    { space: 'Personal', workspace: 'beadcause' },
    { space: 'Personal', workspace: 'climative' },
    { space: 'all', workspace: 'sophab' },
    { space: 'Other', workspace: 'stray' },
  ];
  const mismatched = [];
  for (const filter of filters) {
    // '' is a row that belongs to no repo at all — a session started outside every
    // workspace, which the advocate console draws under "Elsewhere".
    for (const ws of [...NAMES, '']) {
      space.set(filter, { post: false });
      const q = { workspace: ws, space: spaceFor(CFG, ws)?.name };
      const mine = space.matches(ws);
      const theirs = matchesFilter(filter, q);
      if (mine !== theirs) mismatched.push(`${filter.space}/${filter.workspace} × ${ws || '(none)'}: ${mine} vs ${theirs}`);
    }
  }
  assert.deepEqual(mismatched, [], `client and server disagree: ${mismatched.join('; ')}`);
});

/* ------------------------------------------- 2. a repo carries its space with it */

check('picking a repo fills in the space half, so the push path sees a narrow filter', () => {
  const { space, select } = fresh();
  select.value = 'ws:climative';
  select.events.change();
  assert.deepEqual(plain(space.filter), { space: 'Climative', workspace: 'climative' });
});

check('and a repo in no space answers to "Other", exactly as summarise() names it', () => {
  const { space, select } = fresh();
  select.value = 'ws:stray';
  select.events.change();
  assert.deepEqual(plain(space.filter), { space: 'Other', workspace: 'stray' });
});

check('a space picks the space and clears the repo', () => {
  const { space, select } = fresh();
  select.value = 'space:Personal';
  select.events.change();
  assert.deepEqual(plain(space.filter), { space: 'Personal', workspace: 'all' });
});

/* ------------------------------------------------------------- what it draws */

check('every configured repo is in the dropdown, quiet ones and empty ones included', () => {
  const { select } = fresh();
  for (const ws of NAMES) {
    assert.ok(select.innerHTML.includes(`value="ws:${ws}"`), `${ws} has no row`);
  }
  // sophab has nothing waiting in it and must still be reachable — the picker is how
  // you get to a quiet repo.
  assert.ok(select.innerHTML.includes('value="ws:sophab"'));
  // Grouped under the spaces, with the strays under the same synthetic name the server
  // uses for them.
  assert.ok(select.innerHTML.includes('<optgroup label="Personal">'));
  assert.ok(select.innerHTML.includes('<optgroup label="Climative 🔕">'));
  assert.ok(select.innerHTML.includes('<optgroup label="Other">'));
});

check('the picker draws no numbers — not on the bar, and not on a row', () => {
  // bc-ka5y.1 deleted every count this control had: the pill beside it, the `· N` tail
  // on a repo row, the total on a space, and the ⚠ that marked a sum taken over a sweep
  // with a hole in it. They were a second count of a list already on screen, and every
  // page drawing one had to keep them in step with what it was showing.
  const h = fresh();
  assert.equal(typeof h.space.waiting, 'undefined', 'waiting() is still exported');
  assert.ok(!h.bar.innerHTML.includes('space-count'), `the bar still has a count element: ${h.bar.innerHTML}`);
  assert.ok(!h.select.innerHTML.includes('·'), `a row still carries a number: ${h.select.innerHTML}`);
  assert.ok(!h.select.innerHTML.includes('⚠'), `a row still carries a ⚠: ${h.select.innerHTML}`);
});

check('and a page handing it counts and trouble anyway changes nothing it draws', () => {
  // Both fields were adoptable and are not any more. A page that has not been swept
  // yet — or a daemon still serving them — must be ignored rather than crash the paint.
  const h = fresh();
  const before = h.select.innerHTML;
  h.space.adopt({ counts: { beadcause: 9, climative: 4 }, trouble: [{ workspace: 'beadcause' }] });
  assert.equal(h.select.innerHTML, before, 'a number got back in through adopt()');
});

check('one repo is no choice at all, so the bar does not draw', () => {
  const h = load();
  h.space.adopt({ spaces: [], workspaces: ['only'], filter: { space: 'all', workspace: 'all' } });
  assert.equal(h.bar.hidden, true);
});

check('and it says on itself that it is narrowed', () => {
  const h = fresh();
  assert.equal(h.bar.classes.has('narrowed'), false);
  h.space.set({ space: 'Personal', workspace: 'beadcause' }, { post: false });
  assert.equal(h.bar.classes.has('narrowed'), true);
});

check('inside() is the repos a page may offer to start work in', () => {
  const h = fresh();
  assert.deepEqual(plain(h.space.inside()), NAMES, 'nothing picked: all of them');
  h.space.set({ space: 'Personal', workspace: 'all' }, { post: false });
  assert.deepEqual(plain(h.space.inside()), ['beadcause', 'sophab']);
  h.space.set({ space: 'Personal', workspace: 'sophab' }, { post: false });
  assert.deepEqual(plain(h.space.inside()), ['sophab']);
});

/* ------------------------------------------- 5. the bar, while the screen is frozen */

/*
  bc-p49x.5. Edit mode (public/editmode.js) is a state in which every tap points at an
  element rather than acting on it, and the premise only holds if the element is still
  there when the tap is handled. bc-p49x.1 stopped the inbox's list repainting; this bar
  sits above that list, on the same screen, and rebuilds its `<select>` from a payload
  the poll hands it — so a repo appearing replaces the very option a thumb was aiming at,
  under a banner promising the screen is held still.

  Checked here rather than by reading the gate as text because the half that is easy to
  lose is the second one: *only the paint* waits, and the paint that was skipped still
  has to happen. `state` takes the new repos while frozen, so leaving the mode needs no
  refetch — and this file registers a one-shot `editMode.onChange` from inside its own
  freeze to repaint on the way out.

  **That listener is bc-ka5y.1's, and it replaced something that used to be free.** The
  catch-up was structural while the inbox's `render()` ended in `publishCounts()`, which
  was a `space.adopt()`, which landed here — so the repaint that thawed the list repainted
  this bar in the same tick. Those counts are gone and so is that call, and nothing else
  reaches this file on a repaint, so the bar would have sat holding its pre-freeze options
  until the next poll's payload.
*/
const editStub = () => {
  const listeners = [];
  let frozen = true;
  return {
    // The shape public/editmode.js exports, narrowed to what this file asks of it.
    mode: { frozen: () => frozen, onChange: (fn) => listeners.push(fn) },
    thaw() {
      frozen = false;
      for (const fn of listeners) fn();
    },
    listeners,
  };
};

check('a poll that changes the repos does not rebuild the picker while the screen is frozen', () => {
  const h = fresh();
  const before = h.select.innerHTML;
  assert.ok(before.includes('value="ws:beadcause"'), 'the fixture drew a picker to freeze');
  const edit = editStub();
  h.win.beadcause.editMode = edit.mode;

  h.space.adopt({ workspaces: [...NAMES, 'newrepo'] });
  assert.equal(h.select.innerHTML, before, 'the options were rebuilt under a frozen screen');

  // But the payload was taken, which is what makes the catch-up free.
  assert.deepEqual(plain(h.space.inside()), [...NAMES, 'newrepo'], 'the new repo never reached state');
});

check('and the thaw itself draws everything the frozen polls carried', () => {
  const h = fresh();
  const edit = editStub();
  h.win.beadcause.editMode = edit.mode;
  h.space.adopt({ workspaces: [...NAMES, 'newrepo'] });
  assert.ok(!h.select.innerHTML.includes('value="ws:newrepo"'), 'it was drawn while frozen');

  // No refetch and no second payload: leaving the mode is the whole of the catch-up.
  edit.thaw();
  assert.ok(h.select.innerHTML.includes('value="ws:newrepo"'), 'the catch-up never came');
});

check('and it registers one listener however many polls land under the freeze', () => {
  const h = fresh();
  const edit = editStub();
  h.win.beadcause.editMode = edit.mode;
  for (let i = 0; i < 5; i += 1) h.space.adopt({ workspaces: [...NAMES, `r${i}`] });
  assert.equal(edit.listeners.length, 1, 'a listener per skipped paint is a leak on a long edit');
});

check('a page with no edit mode on it paints exactly as it always did', () => {
  const h = fresh();
  assert.equal(h.win.beadcause.editMode, undefined, 'this fixture is the five other pages');
  h.space.adopt({ workspaces: [...NAMES, 'newrepo'] });
  assert.ok(h.select.innerHTML.includes('value="ws:newrepo"'));
});

/* ------------------------------------------------------- the write, and the poll */

check('a pick writes both halves to /api/filter', async () => {
  const sent = [];
  const h = load({ fetch: async (url, opts) => (sent.push({ url, body: JSON.parse(opts.body) }), { ok: true, json: async () => ({ ok: true }) }) });
  h.space.adopt({ spaces: SPACES, workspaces: NAMES, filter: { space: 'all', workspace: 'all' } });
  h.select.value = 'ws:beadcause';
  h.select.events.change();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/filter');
  assert.deepEqual(sent[0].body, { space: 'Personal', workspace: 'beadcause' });
});

check('while that write is out, writing() is true — a poll must not undo the tap', async () => {
  let release;
  const h = load({ fetch: () => new Promise((r) => (release = () => r({ ok: true, json: async () => ({}) }))) });
  h.space.adopt({ spaces: SPACES, workspaces: NAMES, filter: { space: 'all', workspace: 'all' } });
  assert.equal(h.space.writing(), false);
  h.select.value = 'ws:beadcause';
  h.select.events.change();
  assert.equal(h.space.writing(), true);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.space.writing(), false);
});

check('and a payload assembled before it lands does not snap the picker back', async () => {
  let release;
  const h = load({ fetch: () => new Promise((r) => (release = () => r({ ok: true, json: async () => ({}) }))) });
  h.space.adopt({ spaces: SPACES, workspaces: NAMES, filter: { space: 'all', workspace: 'all' } });
  h.select.value = 'ws:beadcause';
  h.select.events.change();
  // The poll, arriving with the value the tap just replaced.
  h.space.adopt({ filter: { space: 'all', workspace: 'all' } });
  assert.deepEqual(plain(h.space.filter), { space: 'Personal', workspace: 'beadcause' });
  release();
  await new Promise((r) => setTimeout(r, 10));
});

check('a change made on the other device arrives through adopt and is announced once', () => {
  const h = fresh();
  const seen = [];
  h.space.onChange((d) => seen.push(d.source));
  h.space.adopt({ filter: { space: 'Personal', workspace: 'sophab' } });
  h.space.adopt({ filter: { space: 'Personal', workspace: 'sophab' } });
  assert.deepEqual(seen, ['adopt'], 'the repeat says nothing');
  assert.deepEqual(plain(h.space.filter), { space: 'Personal', workspace: 'sophab' });
});

/* ------------------------------- whose picture the bar is, now there are no numbers */

/**
 * A page publishes what it knows; our own `/api/spaces` fetch fills in the rest.
 *
 * The fetch is sent from the top of spacebar.js, before the page's own script runs — so
 * on the inbox, which warm-boots out of cache in the same tick, its reply lands *after*
 * the page has already published. It is adopted weakly for exactly that reason:
 * whatever the page said for itself wins, field by field.
 */
const late = (() => {
  let land = () => {};
  const h = load({
    fetch: (url) =>
      url === '/api/spaces'
        ? new Promise((resolve) => {
            land = () =>
              resolve({
                ok: true,
                json: async () => ({
                  spaces: SPACES,
                  workspaces: NAMES,
                  filter: { space: 'Climative', workspace: 'climative' },
                }),
              });
          })
        : Promise.resolve({ ok: false }),
  });
  return { h, land: () => land() };
})();
// The page, publishing its own filter in the same tick the fetch is still in flight.
late.h.space.adopt({
  spaces: SPACES,
  workspaces: NAMES,
  filter: { space: 'Personal', workspace: 'all' },
});
late.land();
await new Promise((r) => setTimeout(r, 20));

check('an /api/spaces reply landing after a page has published is ignored', () => {
  assert.deepEqual(plain(late.h.space.filter), { space: 'Personal', workspace: 'all' });
});

/* The other side of the same rule: a page that sweeps nothing — the PR board, the
   advocate console — has only this fetch, and must get all of it. */
const quiet = load({
  fetch: async () => ({
    ok: true,
    json: async () => ({
      spaces: SPACES,
      workspaces: NAMES,
      filter: { space: 'Personal', workspace: 'all' },
    }),
  }),
});
await new Promise((r) => setTimeout(r, 20));

check('but it is still the whole payload for a page that publishes nothing of its own', () => {
  assert.deepEqual(plain(quiet.space.filter), { space: 'Personal', workspace: 'all' });
  assert.ok(quiet.select.innerHTML.includes('value="ws:sophab"'), 'no repos: the bar cannot be used');
});

check('a settings write that refreshes the spaces leaves the selection alone', () => {
  // public/monitor.js adopts `{spaces}` alone after writing a space's flags, to move the
  // 🔕 without waiting for a poll.
  const h = fresh();
  h.space.set({ space: 'Personal', workspace: 'sophab' }, { post: false });
  h.space.adopt({ spaces: SPACES });
  assert.deepEqual(plain(h.space.filter), { space: 'Personal', workspace: 'sophab' });
});

check('and no page publishes counts to it any more', () => {
  // The publish path is what would put a number back, so it is asserted at the source
  // rather than only at the paint: `publishCounts` in the inbox and the per-workspace
  // tally the advocate console used to build are both gone.
  const app = read('public/app.js');
  // The definition and the call, rather than the word: the freeze paragraph in app.js
  // names `publishCounts()` in prose, explaining what its removal cost.
  assert.ok(!/function publishCounts/.test(app), 'the inbox still defines publishCounts');
  assert.ok(!/^\s*publishCounts\(/m.test(app), 'the inbox still calls publishCounts');
  const publish = app.slice(app.indexOf('function publishSpaces'), app.indexOf('function publishSpaces') + 1200);
  assert.ok(!publish.includes('counts'), 'publishSpaces sends counts');
  assert.ok(!read('public/monitor.js').includes('counts,'), 'the advocate console still publishes counts');
});

/* ================================================================ the wiring */

/* Which pages have the bar, and the one that deliberately does not: admin acts on every
   repo at once (see the header of public/admin.js), and a control it ignored would be a
   lie about what its buttons do. */
const PAGES = ['index.html', 'monitor.html', 'console.html', 'foundations.html'];

check('every page with a filterable list loads /spacebar.js', () => {
  const missing = PAGES.filter((p) => !read(`public/${p}`).includes('/spacebar.js'));
  assert.deepEqual(missing, []);
});

check('and each of their scripts actually asks the picker what to draw', () => {
  const missing = ['app.js', 'prs.js', 'monitor.js', 'console.js', 'foundations.js'].filter(
    (f) => !/beadcause\?\.space|beadcause\.space/.test(read(`public/${f}`))
  );
  assert.deepEqual(missing, []);
});

check('the admin page has none, on purpose', () => {
  assert.ok(!read('public/admin.html').includes('/spacebar.js'));
});

check('the service worker ships it in the shell, or a cached page has no picker', () => {
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/spacebar.js'"), 'not in SHELL');
  // The version is what makes the new file and the pages that need it arrive together.
  assert.ok(/const CACHE = 'beadcause-v(2[2-9]|[3-9]\d)'/.test(sw), 'CACHE was not bumped past v21');
});

check('the inbox no longer draws the two chip rows the picker replaced', () => {
  const app = read('public/app.js');
  assert.ok(!app.includes('data-space="'), 'space chips are still being drawn');
  assert.ok(!/data-ws="\$\{esc\(ws\)\}"/.test(app), 'workspace chips are still being drawn');
});

/* ============================================================== the server half */

const { createApp, listen } = await import(LIB('server.js'));
const { loadState, saveState } = await import(LIB('config.js'));

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'spacebar-test-token',
  actor: 'beadcause-test',
  // A configured workspace and a `bd` that cannot exist: if /api/spaces sweeps the
  // tracker, this is where it finds out.
  workspaces: [{ name: 'beadcause', dir: path.join(tmp, 'beads', 'beadcause', '.beads') }],
  bdBin: path.join(tmp, 'no-such-bd'),
  spaces: [
    { name: 'Personal', workspaces: ['beadcause', 'sophab'] },
    { name: 'Climative', workspaces: ['climative'], muted: true },
  ],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const call = (pathname, opts = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

const spaces = await call('/api/spaces');
check('/api/spaces answers with no `bd` on the machine at all', () => {
  assert.equal(spaces.status, 200);
  const d = JSON.parse(spaces.body);
  assert.deepEqual(d.workspaces, ['beadcause']);
  // Nothing is counted anywhere any more — the picker draws no numbers, so the payload
  // that feeds it carries none. See bc-ka5y.1.
  assert.ok(!('counts' in d), `counts is still served: ${spaces.body}`);
  assert.ok(!('waiting' in d), `waiting is still served: ${spaces.body}`);
});

check('and it names the configured spaces before any sweep has landed', () => {
  // The shape of the spaces is config, not tracker. Falling back to the cached summary
  // alone would put every repo under "Other" for the first few seconds of a restart.
  const d = JSON.parse(spaces.body);
  assert.deepEqual(
    d.spaces.map((s) => s.name),
    ['Personal', 'Climative']
  );
  assert.deepEqual(d.spaces[0].workspaces, ['beadcause', 'sophab']);
  assert.equal(d.spaces[1].muted, true, 'a muted space says so, so the picker can');
});

saveState({ filter: { space: 'Personal', workspace: 'beadcause' } });
const kept = await call('/api/spaces');
check('the stored filter rides along, so the first paint is already narrowed', () => {
  assert.deepEqual(JSON.parse(kept.body).filter, { space: 'Personal', workspace: 'beadcause' });
});

saveState({ filter: { space: 'Renamed', workspace: 'gone' } });
const stale = await call('/api/spaces');
check('a filter naming things nobody has any more is reconciled, not served', () => {
  // On a page with no list under it there is nothing at all to hint at why everything
  // vanished, so this matters more here than it does on the inbox.
  assert.deepEqual(JSON.parse(stale.body).filter, { space: 'all', workspace: 'all' });
});

const wrote = await call('/api/filter', {
  method: 'POST',
  body: JSON.stringify({ space: 'Personal', workspace: 'beadcause' }),
});
check('and the picker writes through the endpoint the chips always used', () => {
  assert.equal(wrote.status, 200);
  assert.deepEqual(loadState().filter, { space: 'Personal', workspace: 'beadcause' });
});

servers.forEach((s) => s.close());
await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
