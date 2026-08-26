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

/**
 * The same, awaited — for a check whose body has to let a write resolve.
 *
 * `check()` calls its function and does not wait for it, which for an `async` body means
 * the ✓ is printed before the assertions have run and a failure arrives later as an
 * unhandled rejection. The suite does still fail — Node exits non-zero on one — but it
 * fails at the first one, after a screen of ticks, and names none of them. The checks
 * below all turn on the ordering of a write against a poll, so they are the ones that
 * cannot afford that.
 */
async function acheck(name, fn) {
  ran += 1;
  try {
    await fn();
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
function load({ token = 'tok', fetch = async () => ({ ok: false }), clock = null } = {}) {
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
  /* The span the bar actually draws its label in. The `<select>` over it is invisible and
     carries the whole names; this is where the cut-down one lands. See `.spacepick` in
     public/style.css. */
  const shown = el('space-shown');
  const bar = {
    className: '',
    hidden: true,
    innerHTML: '',
    classes: new Set(),
    querySelector: (sel) => (sel === '#space-pick' ? select : sel === '#space-shown' ? shown : null),
    classList: {
      toggle(name, on) {
        if (on) bar.classes.add(name);
        else bar.classes.delete(name);
      },
    },
  };
  /* The picker goes after `.brand` rather than at the end of the bar (bc-khoe.5) — they
     share a row now and /monitor keeps a tally in the actions beyond it. Both landing
     places record into the same list, because what a check here can say is *that* it was
     hung on the bar; where on the bar is geometry, and `scripts/topbar-check.mjs` is what
     measures that. */
  const topbar = {
    appended: [],
    append(node) {
      this.appended.push(node);
    },
    querySelector: (sel) => (sel === '.brand' ? brand : null),
  };
  const brand = {
    parentNode: topbar,
    after(node) {
      topbar.appended.push(node);
    },
  };

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
    /* The room's clock. The picker holds the value a tap replaced for a bounded while
       (`PENDING_MS`), and a bound is not testable against a real one without sleeping
       for it — so a check that cares hands in its own `now`. Everything else gets the
       host's `Date`, which is what the vm's own realm would have given it anyway. */
    Date: clock ? { now: clock } : Date,
  });
  vm.runInContext(fs.readFileSync(PUBLIC('spacebar.js'), 'utf8'), ctx, { filename: 'spacebar.js' });
  // `win` so a check can hang something else off `beadcause` after the file has loaded —
  // which is how edit mode reaches this file, and the order the page loads them in.
  return { space: ctx.window.beadcause.space, win: ctx.window, bar, select, shown, topbar };
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

/*
  bc-qid8b. The strays were drawn twice.

  `summarise()` emits a row literally named "Other" for the strays it found beads in, so
  the payload's `spaces` carries one — and `paint()` looped that array *and* called
  `strays()`, pushing an `<optgroup label="Other">` from each. `stray` has a question in
  the fixture above, which is exactly the condition that put it in both: the synthetic row
  listed it because it had a bead, and `strays()` returns it because `spaceOf` answers
  "Other" for any repo no configured space names.

  Asserted by counting rather than by looking for a string, because both spellings were
  the same string — a check for the label's presence passed throughout the bug.
*/
check('the strays are one group and one row each, not two of both', () => {
  const { select } = fresh();
  const groups = select.innerHTML.match(/<optgroup label="Other">/g) || [];
  assert.equal(groups.length, 1, `${groups.length} "Other" groups`);
  const rows = select.innerHTML.match(/value="ws:stray"/g) || [];
  assert.equal(rows.length, 1, `stray has ${rows.length} rows`);
});

/*
  The `— all` row is the one a filter pinned to `space:Other` is selected in, and it has
  to survive the group being drawn from `strays()` instead of from the payload — a
  `<select>` whose value matches no option shows its first, which here says "All spaces"
  over a list narrowed to the strays.
*/
check('"Other — all" stays selectable, even with no stray left to list', () => {
  const { space, select } = fresh();
  assert.ok(select.innerHTML.includes('value="space:Other"'));

  space.set({ space: 'Other', workspace: 'all' }, { post: false });
  // Every configured repo now belongs to a space, so `strays()` is empty — the pin is
  // all that is holding the group open.
  space.adopt({ spaces: SPACES, workspaces: ['beadcause', 'sophab', 'climative'] });
  // The `selected` attribute rather than `select.value`, which `paint()` also writes
  // (bc-ka5y.32): what is being asserted here is that the *row* is still in the list, and
  // a value assignment would say so even if the row it names had gone.
  assert.match(select.innerHTML, /<option value="space:Other" selected>/, 'the pinned row went away');
});

/*
  bc-ka5y.32. The label kept the old space after a pick, until a refresh.

  There are four readings of one selection — the span the bar draws, `select.value`,
  `select.title`, and whatever the page under the bar filtered itself to — and
  `select.value` was the only one no line of code wrote. It rode along inside the markup
  as a `selected` attribute, behind a guard that skips the rebuild when the rows come out
  identical to the ones last written. And the control is not only written to: a browser
  moves its value on the pick itself, and again on a form restore after a back
  navigation. So a value that moved without a `change` reaching this file was never put
  back by anything — not by the next payload, and not even by one that rebuilt every row,
  because identical rows are exactly the case the guard skips.

  What a `node:vm` can hold of that is the assignment: this `<select>` is an object whose
  `value` is whatever was last written to it, so a paint that fails to write it leaves the
  wrong string sitting there, which is the failure. What it *cannot* hold is the browser's
  half — a real `<select>` whose value matches no option shows its first row, which is why
  `scripts/space-check.mjs` asserts the whole of it in a real one, on a real pick.
*/
check('every paint says the selection to the control, not only to the markup', () => {
  const { space, select } = fresh();
  space.set({ space: 'Personal', workspace: 'beadcause' }, { post: false });
  assert.equal(select.value, 'ws:beadcause');

  // Moved with no `change` behind it — what the browser does on the pick, and what a form
  // restore does after a back navigation. Nothing has been told, so nothing has corrected
  // it yet.
  select.value = 'ws:sophab';
  // A payload with nothing in it about the selection, and nothing that moves a row: the
  // paint most likely to decide it has nothing to do.
  space.adopt({ spaces: SPACES, workspaces: NAMES });
  assert.equal(select.value, 'ws:beadcause', 'the paint left the control holding the wrong repo');
});

/*
  And the other way the four can part: the filter outlives the config it was picked under
  — it sits in `state.json` across restarts and reconfigurations — so a space renamed in
  the config file, or a repo retired from /admin, leaves the picker pinned to a name the
  next payload does not carry. With no row holding it a real `<select>` shows its first,
  and the bar reads "All spaces" over a list still narrowed to what the label names.

  bc-qid8b drew the `Other — all` row for exactly this reason. "Other" was never the only
  name the list can lose, so the row is drawn for whatever the pin is.
*/
check('a pin the config no longer offers keeps a row rather than falling off the list', () => {
  const { space, select } = fresh();
  space.set({ space: 'Personal', workspace: 'sophab' }, { post: false });
  assert.ok(select.innerHTML.includes('value="ws:sophab"'));

  // The payload a retire produces: the same spaces, one repo fewer.
  space.adopt({ workspaces: ['beadcause', 'climative', 'stray'] });
  assert.match(select.innerHTML, /<option value="ws:sophab" selected>/, 'the pin has no row to be held in');
  assert.equal(select.value, 'ws:sophab');
  // Said rather than pretended: `matches()` and the server's `matchesFilter` are both
  // still answering for the pin, so a row reading plainly `sophab` would be a second lie.
  assert.match(select.innerHTML, /sophab — gone/);
});

check('and a space renamed under the pin is the same case', () => {
  const { space, select } = fresh();
  space.set({ space: 'Personal', workspace: 'all' }, { post: false });
  space.adopt({ spaces: [{ name: 'Personnel', workspaces: ['beadcause', 'sophab'] }] });
  assert.match(select.innerHTML, /<option value="space:Personal" selected>/);
  assert.equal(select.value, 'space:Personal');
});

check('and nothing extra is drawn while the pin is a row the list really has', () => {
  // The guard has to be silent in the ordinary case, or every screen grows a group.
  const { select } = fresh();
  assert.ok(!select.innerHTML.includes('gone'), select.innerHTML);
  assert.ok(!select.innerHTML.includes('No longer configured'), select.innerHTML);
});

/* --------------------------------------------- the face, and the list behind it */

/*
  The picker shares the top row with the mark since bc-khoe.5, so what it *draws* is a
  cut-down label while the dropdown keeps every whole name. Twelve characters through,
  nine and an ellipsis past that. The rule is asserted here and the geometry it buys is
  measured in `scripts/topbar-check.mjs`, which fails the repo for a second row.
*/
check('a name of twelve characters or fewer is drawn whole', () => {
  const h = fresh();
  h.select.value = 'ws:beadcause';
  h.select.events.change();
  assert.equal(h.shown.textContent, 'beadcause');
});

check('and a longer one is cut to nine and an ellipsis, so the bar cannot widen', () => {
  const h = load();
  h.space.adopt({
    spaces: [{ name: 'Work', workspaces: ['climative-platform'] }],
    workspaces: ['climative-platform', 'beadcause'],
    filter: { space: 'Work', workspace: 'climative-platform' },
  });
  assert.equal(h.shown.textContent, 'climative…');
  // Ten drawn characters, not eighteen. The number is the whole point of the rule.
  assert.ok(h.shown.textContent.length <= 12, h.shown.textContent);
});

check('the twelfth character is in and the thirteenth is not — the boundary, both sides', () => {
  const at = (name) => {
    const h = load();
    h.space.adopt({ spaces: [{ name: 'S', workspaces: [name] }], workspaces: [name, 'other'], filter: { space: 'S', workspace: name } });
    return h.shown.textContent;
  };
  assert.equal(at('abcdefghijkl'), 'abcdefghijkl');
  assert.equal(at('abcdefghijklm'), 'abcdefghi…');
});

check('but the dropdown itself is untouched — a whole name per row', () => {
  const h = load();
  h.space.adopt({
    spaces: [{ name: 'Work', workspaces: ['climative-platform'] }],
    workspaces: ['climative-platform', 'beadcause'],
    filter: { space: 'Work', workspace: 'climative-platform' },
  });
  // The list is the one place the whole name is the point: it is what you are choosing
  // *from*, and two repos sharing their first nine characters would be one row twice.
  assert.ok(h.select.innerHTML.includes('>climative-platform<'), h.select.innerHTML);
  assert.ok(!h.select.innerHTML.includes('…'), `a row was cut too: ${h.select.innerHTML}`);
});

check('shortLabel() is what the bar draws and label() is still the whole thing', () => {
  const h = load();
  h.space.adopt({
    spaces: [{ name: 'Work', workspaces: ['climative-platform'] }],
    workspaces: ['climative-platform', 'beadcause'],
    filter: { space: 'Work', workspace: 'climative-platform' },
  });
  // Four pages write `label()` into a sentence — "Nothing in climative-platform." — and a
  // sentence with an ellipsis in the middle of it is the cut leaking out of the chrome.
  assert.equal(h.space.label(), 'climative-platform');
  assert.equal(h.space.shortLabel(), 'climative…');
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

check('one repo is a choice now, because the last row adds another', () => {
  // It used to hide here: one repo and one space is nothing to pick between, and a
  // control with a single option is furniture. ＋ Add a bead-space changed that, and it
  // changed it exactly where it matters — an install with one tracker, or with none, is
  // the one that needs the button, and hiding the bar there left the only way to add a
  // tracker on the Mac the app exists so you would not have to sit at.
  const h = load();
  h.space.adopt({ spaces: [], workspaces: ['only'], filter: { space: 'all', workspace: 'all' } });
  assert.equal(h.bar.hidden, false);
  assert.ok(h.select.innerHTML.includes('Add a bead-space'), `no add row: ${h.select.innerHTML}`);
});

check('but nothing draws before the first payload lands', () => {
  // The other half of the rule that is still true: a bar drawn from no data at all is a
  // control that says "All spaces" over a list nobody has fetched yet.
  const h = load();
  assert.equal(h.bar.hidden, true);
});

check('the add row is the last one, outside every group, and never selected', () => {
  // Outside the optgroups so it reads as an action rather than as a repo in the last
  // group — and unselected whatever the filter is, because it is not a place to be.
  const h = fresh();
  const html = h.select.innerHTML;
  const add = html.indexOf('Add a bead-space');
  assert.ok(add > 0, `no add row: ${html}`);
  assert.ok(add > html.lastIndexOf('</optgroup>'), 'the add row is inside a group');
  assert.ok(!/<option value="add:beadspace" selected/.test(html), 'the add row draws as selected');
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

await acheck('a pick writes both halves to /api/filter', async () => {
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

await acheck('while that write is out, writing() is true — a poll must not undo the tap', async () => {
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

await acheck('and a payload assembled before it lands does not snap the picker back', async () => {
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

/*
 * The other ordering, which is what bc-5k22 was filed for.
 *
 * `writing()` covers a payload that lands *during* the POST. A poll issued before the tap
 * and answered after the write resolved lands with `writing()` already false, carrying the
 * filter the tap replaced — and adopting that is the pick that applies and then reverts on
 * its own, with the bar visibly snapping back. Every check below tap-then-settles first, so
 * the guard above is provably not the one doing the work.
 */
const tapped = async ({ ok = true, clock = null } = {}) => {
  const h = load({ clock, fetch: async () => ({ ok, json: async () => ({ ok: true, filter: {} }) }) });
  h.space.adopt({ spaces: SPACES, workspaces: NAMES, filter: { space: 'all', workspace: 'all' } });
  h.select.value = 'ws:beadcause';
  h.select.events.change();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.space.writing(), false, 'the write has answered — this is the gap the counter cannot see');
  return h;
};

const ALL_FILTER = { space: 'all', workspace: 'all' };
const PICKED = { space: 'Personal', workspace: 'beadcause' };

await acheck('a poll that was already out when you tapped does not snap the picker back', async () => {
  const h = await tapped();
  h.space.adopt({ filter: { ...ALL_FILTER } });
  assert.deepEqual(plain(h.space.filter), PICKED);
});

await acheck('and the page that mirrored that payload is handed back what is really selected', async () => {
  const h = await tapped();
  const seen = [];
  h.space.onChange((d) => seen.push({ source: d.source, filter: plain(d.filter) }));
  h.space.adopt({ filter: { ...ALL_FILTER } });
  // public/app.js keeps `state.space` for a dozen readers and writes it from the same
  // payload before handing it here — so a silent drop would leave the bar right and the
  // list under it filtered to the repo the tap replaced.
  assert.deepEqual(seen, [{ source: 'hold', filter: PICKED }], 'the drop corrects the mirror');
});

await acheck('a genuine change from the other device inside that window still arrives', async () => {
  const h = await tapped();
  h.space.adopt({ filter: { space: 'Personal', workspace: 'sophab' } });
  assert.deepEqual(plain(h.space.filter), { space: 'Personal', workspace: 'sophab' });
});

await acheck('and once the server has echoed our own value back, the hold is over', async () => {
  const h = await tapped();
  h.space.adopt({ filter: { ...PICKED } }); // the first payload assembled after our POST
  // Which makes this one a real switch back on the laptop rather than an older poll.
  h.space.adopt({ filter: { ...ALL_FILTER } });
  assert.deepEqual(plain(h.space.filter), ALL_FILTER);
});

await acheck('picking twice holds what the second tap chose, not what the first did', async () => {
  const h = await tapped();
  h.select.value = 'ws:sophab';
  h.select.events.change();
  await new Promise((r) => setTimeout(r, 10));
  // The poll that was out when the second tap happened carries the first tap's value.
  h.space.adopt({ filter: { ...PICKED } });
  assert.deepEqual(plain(h.space.filter), { space: 'Personal', workspace: 'sophab' });
});

await acheck('the hold is bounded, so nothing can silence the other device for ever', async () => {
  let now = 1_700_000_000_000;
  const h = await tapped({ clock: () => now });
  now += 29_000;
  h.space.adopt({ filter: { ...ALL_FILTER } });
  assert.deepEqual(plain(h.space.filter), PICKED, 'inside the bound it is still refused');
  now += 2_000;
  h.space.adopt({ filter: { ...ALL_FILTER } });
  assert.deepEqual(plain(h.space.filter), ALL_FILTER, 'past it the stored value wins again');
});

await acheck('a write that never landed gives the stored value straight back', async () => {
  // The documented cost of a failed write is the persistence and not the filtering — the
  // next poll puts the stored value back — so a hold outliving the write it belongs to
  // would be this file quietly changing that.
  const h = await tapped({ ok: false });
  h.space.adopt({ filter: { ...ALL_FILTER } });
  assert.deepEqual(plain(h.space.filter), ALL_FILTER);
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
  // On a word boundary, not a substring. The window is 1200 characters of source rather
  // than the function, so it reaches whatever is written next to it — and what is written
  // next to it now is the account chip's publish, which names `/api/accounts`. "accounts"
  // contains "counts", and a substring test read that as the inbox having put the numbers
  // back. The field this is about is `counts`, and only that.
  assert.ok(!/\bcounts\b/.test(publish), 'publishSpaces sends counts');
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
  // Read as a number and compared, rather than matched against a hand-rolled
  // alternation of the digits that were plausible when this was written. The four
  // suites that did it the other way (this one, spacedetails, warm, termdoor) all
  // spelled a two-digit range and so stopped matching the moment the cache reached
  // v100 — reporting "CACHE was not bumped" about a version three higher than the one
  // they were asking for. Every other suite here already captures `(\d+)`.
  const version = Number(sw.match(/const CACHE = 'beadcause-v(\d+)'/)?.[1]);
  assert.ok(version > 21, `CACHE was not bumped past v21 — it reads v${version}`);
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
