#!/usr/bin/env node
/**
 * The inbox's bead search box — the matching, the typeahead, and what a pick narrows to.
 *
 *     npm test
 *     node test/beadsearch.mjs
 *
 * bc-0xil. A text box beside the filter picker: type, get a list of matching bead ids,
 * click one and it becomes a pill with an X that narrows the inbox to that bead and the
 * work under it. Three halves, and each has a failure the other two cannot catch:
 *
 * 1. **The ranking is the feature.** A search box over 938 beads that offers them in
 *    export order is a box you stop using. `lib/beadsearch.js` is four tiers deep and the
 *    order — exact id, then id-from-the-start, then id-anywhere, then title — is the
 *    whole of what makes typing `0xil` land on `bc-0xil` rather than on the six beads
 *    whose titles mention it.
 *
 * 2. **The dropdown must survive the 25-second poll.** The inbox repaints wholesale, and
 *    a control that rebuilt its input would take a half-typed id with it. The chrome
 *    already refuses to write over a focused field; a typeahead needs the *opposite*
 *    exception as well, because picking a suggestion empties the box while the caret is
 *    still in it. Both directions are checked here.
 *
 * 3. **The pill must not lie in either direction.** A pick narrows the list, so the pill
 *    has to name it and read as narrowed — that is the standing risk of a filter you have
 *    to open. And a half-typed query narrows *nothing*, so the same pill must not claim
 *    it does. (It was one summary line over every group until bc-khoe.26; it is this
 *    group's own pill now, which is what lets it say `bc-rfnr` rather than a share of a
 *    comma-joined digest.)
 *
 * The chrome runs in a vm with a hand-made document, the way test/inboxkinds.mjs and
 * test/historyfilter.mjs drive the same file: a stub of the panel could not fail while
 * the phone shipped something else. The group handed to it here is a fake — this suite is
 * about public/filtermenu.js's half of the contract, and public/app.js's half is checked
 * against its source at the foot, the way the wiring checks in test/inboxkinds.mjs are.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { searchBeads, SEARCH_LIMIT } from '../lib/beadsearch.js';

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

/* --------------------------------------------------------------- the matching */

/** A workspace's worth of beads, shaped as `Bd.graph` holds them. */
const BEADS = [
  { id: 'bc-0xil', title: 'Inbox bead-search box', status: 'open', workspace: 'beadcause' },
  { id: 'bc-0xil.1', title: 'The typeahead itself', status: 'open', workspace: 'beadcause' },
  { id: 'bc-0xil.2', title: 'The pill and its X', status: 'closed', workspace: 'beadcause' },
  { id: 'bc-0xil.10', title: 'The tenth child', status: 'open', workspace: 'beadcause' },
  { id: 'bc-rfnr', title: 'The epic board', status: 'open', workspace: 'beadcause' },
  { id: 'sp-9a2', title: 'A hero opening that mentions 0xil in prose', status: 'open', workspace: 'sophab' },
  { id: 'bc-qid9', title: 'What a picked bead filters to', status: 'open', workspace: 'beadcause' },
];

const ids = (rows) => rows.map((r) => r.id);

console.log('\nwhat a typed fragment matches');

await check('an empty box asks nothing — a dropdown over an untouched field is noise', () => {
  assert.deepEqual(searchBeads(BEADS, ''), []);
  assert.deepEqual(searchBeads(BEADS, '   '), []);
});

await check('a whole id comes first, ahead of its own children', () => {
  // The sharpest case for the tiers: `bc-0xil` is a prefix of three other ids, and
  // ordering by anything but "exact first" buries the bead you named under its subtree.
  assert.equal(ids(searchBeads(BEADS, 'bc-0xil'))[0], 'bc-0xil');
});

await check('children follow their parent, and the tenth is not filed between the first and the second', () => {
  // bd's own ids are `.1` … `.10` and a plain string sort puts `.10` after `.1`. The
  // comparator is lib/ancestry.js's, so the dropdown and every tree on the phone agree.
  assert.deepEqual(ids(searchBeads(BEADS, 'bc-0xil')), ['bc-0xil', 'bc-0xil.1', 'bc-0xil.10', 'bc-0xil.2']);
});

await check('the prefix is optional — a bead named without it does not sort under its own children', () => {
  // Found against the real tracker: `rfnr` merely "appears in" `bc-rfnr` exactly as it
  // appears in `bc-rfnr.9.2`, so the closed parent — the bead you named — landed tenth,
  // below nine open descendants. Nobody types `bc-` when every bead on screen has it.
  const hits = ids(searchBeads(BEADS, '0xil'));
  assert.equal(hits[0], 'bc-0xil');
  assert.equal(ids(searchBeads(BEADS, 'qid9'))[0], 'bc-qid9');
});

await check('an id fragment beats a title that happens to contain it', () => {
  // `0xil` without the prefix is how an id gets pasted out of a branch name. The bead
  // whose *title* says `0xil` is a real match and is offered — under the four ids.
  const hits = ids(searchBeads(BEADS, '0xil'));
  assert.deepEqual(hits.slice(0, 4), ['bc-0xil', 'bc-0xil.1', 'bc-0xil.10', 'bc-0xil.2']);
  assert.equal(hits[4], 'sp-9a2', 'the title match was dropped rather than ranked below');
});

await check('titles match at all — bc-s557, answered in the direction the dropdown draws', () => {
  // The box shows the title beside every id, so a box that displayed a title and then
  // refused to match it would read as broken. If that answer ever comes back the other
  // way, this check is the one that has to change, and it is one line in tierOf.
  assert.deepEqual(ids(searchBeads(BEADS, 'picked bead')), ['bc-qid9']);
});

await check('open beads sort above closed ones inside a tier, and closed ones are still offered', () => {
  // Half the reason to reach for a bead is to read what happened to it. `.2` is closed
  // and is last of the children rather than absent.
  const hits = searchBeads(BEADS, 'bc-0xil');
  assert.equal(hits.at(-1).id, 'bc-0xil.2');
  assert.equal(hits.at(-1).status, 'closed');
});

await check('every hit carries the key the inbox is keyed by, not just an id', () => {
  // Two trackers can hold the same id, and the client keys every row `workspace/id` —
  // a suggestion without one could be drawn but not picked.
  for (const hit of searchBeads(BEADS, '0xil')) assert.equal(hit.key, `${hit.workspace}/${hit.id}`);
  assert.equal(searchBeads(BEADS, 'hero')[0].key, 'sophab/sp-9a2');
});

await check('the list is capped, and the cap is the one the route uses', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `bc-x${i}`, title: 'x', status: 'open', workspace: 'w' }));
  assert.equal(searchBeads(many, 'bc-x').length, SEARCH_LIMIT);
  assert.equal(searchBeads(many, 'bc-x', { limit: 3 }).length, 3);
});

await check('case does not matter in either direction', () => {
  assert.deepEqual(ids(searchBeads(BEADS, 'BC-QID9')), ['bc-qid9']);
  assert.deepEqual(ids(searchBeads([{ id: 'BC-UP', title: 'T', status: 'open', workspace: 'w' }], 'bc-up')), ['BC-UP']);
});

await check('a bead with no id is skipped rather than offered as a blank row', () => {
  assert.deepEqual(searchBeads([{ id: '', title: 'nameless', status: 'open', workspace: 'w' }], 'nameless'), []);
});

/* --------------------------------------------------------------- a document */

/** Just enough of an element — the same shape test/inboxkinds.mjs drives the panel with. */
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
    return String(this.className || '').split(/\s+/).filter(Boolean);
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
    for (const fn of this.listeners.get(type) || []) fn({ preventDefault() {}, ...ev });
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

function makeDoc() {
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
  return doc;
}

/**
 * The real public/filtermenu.js, mounted over a fake bead group.
 *
 * The group is a stand-in for public/app.js's — this suite is about the chrome's half of
 * the contract, which is the half that is shared with the History tab and that no test of
 * app.js would exercise on its own. The page's half is checked against its source below.
 */
function mountBox({ hover = false, warm = true } = {}) {
  const doc = makeDoc();
  const window = { matchMedia: (q) => ({ matches: q.includes('hover: hover') ? hover : false }) };
  const ctx = vm.createContext({ window, document: doc, setTimeout, clearTimeout });
  vm.runInContext(read('public/filtermenu.js'), ctx, { filename: 'filtermenu.js' });

  /** What the page would hold: a query, what came back for it, and the picks. */
  const state = { query: '', suggestions: [], picks: [], note: 'No bead matches that.' };
  const calls = { picked: [], unpicked: [] };
  const group = {
    id: 'bead',
    legend: 'Bead',
    text: true,
    all: 'Any bead',
    placeholder: 'bc-0xil',
    value: () => state.query,
    set: (v) => {
      state.query = v;
      // What the page's debounced fetch would eventually put there — synchronously here,
      // because the chrome cannot tell the difference and the wait is not its decision.
      state.suggestions = searchBeads(BEADS, v).map((b) => ({ id: b.key, label: b.id, note: b.title }));
    },
    suggestions: () => state.suggestions,
    note: () => (warm ? state.note : 'Still reading the trackers — try again in a moment.'),
    picks: () => state.picks.map((p) => ({ id: p.key, label: p.id, note: p.title })),
    pick: (key) => {
      calls.picked.push(key);
      const hit = searchBeads(BEADS, state.query).find((b) => b.key === key);
      if (hit) state.picks = [...state.picks, hit];
      state.query = '';
      state.suggestions = [];
    },
    unpick: (key) => {
      calls.unpicked.push(key);
      state.picks = state.picks.filter((p) => p.key !== key);
    },
  };

  const host = doc.createElement('nav');
  host.replaceChildren = El.prototype.replaceChildren.bind(host);
  const chrome = ctx.window.beadcause.filterMenu.mount(host, { groups: () => [group] });
  const root = host.children[0];
  const box = root.all('filter-group').find((b) => b.dataset.group === 'bead');
  return {
    doc,
    state,
    calls,
    chrome,
    root,
    box,
    input: () => box.all('filter-text')[0],
    list: () => box.all('suggest')[0],
    rows: () => box.all('suggest-row'),
    note: () => box.all('suggest-note-line')[0],
    pills: () => box.all('pill'),
    /** What the pill says after its legend — `''` while the group is not narrowing. */
    summary: () => root.all('sel')[0].textContent,
    /** And whether the pill looks narrowed, which since bc-khoe.26 is per control. */
    narrowed: () => root.all('filter-summary')[0].classList.contains('on'),
    /** Type, the way a person does: the field carries the text, then the event fires. */
    type(text) {
      const el = box.all('filter-text')[0];
      el.value = text;
      el.fire('input');
    },
  };
}

console.log('\nthe typeahead');

await check('an empty box draws no list at all', () => {
  const h = mountBox();
  assert.ok(h.list(), 'the list element was never built');
  assert.equal(h.list().hidden, true);
  assert.equal(h.rows().length, 0);
});

await check('typing drops the matches down, best first, id and title on each row', () => {
  const h = mountBox();
  h.type('0xil');
  assert.equal(h.list().hidden, false);
  assert.deepEqual(h.rows().map((r) => r.all('suggest-id')[0].textContent), [
    'bc-0xil',
    'bc-0xil.1',
    'bc-0xil.10',
    'bc-0xil.2',
    'sp-9a2',
  ]);
  // The title beside the id, because an id on its own is not recognisable.
  assert.equal(h.rows()[0].all('suggest-note')[0].textContent, 'Inbox bead-search box');
});

await check('the box is a whole combobox to a screen reader, not half of one', () => {
  // `role="combobox"` that never says whether it is open, or what is in it, is worse
  // than an ordinary search field — it promises a list and then describes nothing.
  const h = mountBox();
  const input = h.input();
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-controls'), h.list().id);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  h.type('bc-0xil');
  assert.equal(h.input().getAttribute('aria-expanded'), 'true');
  h.input().fire('keydown', { key: 'ArrowDown' });
  assert.equal(h.input().getAttribute('aria-activedescendant'), h.rows()[0].id);
});

await check('the list narrows as you type more', () => {
  const h = mountBox();
  h.type('bc-0xil');
  assert.equal(h.rows().length, 4);
  h.type('bc-0xil.1');
  assert.deepEqual(h.rows().map((r) => r.dataset.suggest), ['beadcause/bc-0xil.1', 'beadcause/bc-0xil.10']);
});

await check('clicking a suggestion picks it, empties the box, and closes the list', () => {
  const h = mountBox();
  h.type('bc-0xil');
  h.rows()[0].fire('click');
  assert.deepEqual(h.calls.picked, ['beadcause/bc-0xil']);
  // Emptied even though the caret is in the field — the one write the never-write-while-
  // focused rule has to let through, or the word you just turned into a pill sits under it.
  assert.equal(h.input().value, '');
  assert.equal(h.list().hidden, true);
});

await check('the panel stays open on a pick, on a phone as well as a laptop', () => {
  // Not routed through `pick()`, which closes a single-choice group on a touchscreen. The
  // next thing you may want is a second bead, and the box is inside the panel.
  for (const hover of [true, false]) {
    const h = mountBox({ hover });
    // By group id since bc-khoe.26 — one pill's panel at a time, so "open" is which.
    h.chrome.setOpen('bead');
    h.type('bc-rfnr');
    h.rows()[0].fire('click');
    assert.equal(h.chrome.isOpen(), 'bead', `the panel shut on a pick (hover: ${hover})`);
  }
});

await check('a pointerdown on a suggestion picks it too — a tap must not lose to the close handler', () => {
  // The document-level close in filtermenu.js runs on pointerdown. A suggestion that only
  // listened for `click` would be unpressable on a phone if that handler ever widened.
  const h = mountBox();
  h.type('bc-rfnr');
  h.rows()[0].fire('pointerdown');
  assert.deepEqual(h.calls.picked, ['beadcause/bc-rfnr']);
});

await check('the pick becomes a pill with an X, and the X takes it back off', () => {
  const h = mountBox();
  h.type('bc-rfnr');
  h.rows()[0].fire('click');
  assert.equal(h.pills().length, 1);
  assert.equal(h.pills()[0].all('pill-label')[0].textContent, 'bc-rfnr');
  const x = h.pills()[0].all('pill-x')[0];
  // The glyph reads as nothing to a screen reader, so the name has to carry both.
  assert.equal(x.getAttribute('aria-label'), 'Remove bc-rfnr');
  x.fire('click');
  assert.deepEqual(h.calls.unpicked, ['beadcause/bc-rfnr']);
  assert.equal(h.pills().length, 0);
});

await check('several beads can be picked, and each keeps its own X', () => {
  // bc-gwsi: a pill with its own X only makes sense if a second pick adds one.
  const h = mountBox();
  h.type('bc-rfnr');
  h.rows()[0].fire('click');
  h.type('bc-qid9');
  h.rows()[0].fire('click');
  assert.deepEqual(h.pills().map((p) => p.dataset.pick), ['beadcause/bc-rfnr', 'beadcause/bc-qid9']);
  h.pills()[0].all('pill-x')[0].fire('click');
  assert.deepEqual(h.pills().map((p) => p.dataset.pick), ['beadcause/bc-qid9']);
});

await check('an empty result says so in the page’s own words, not in an empty box', () => {
  const h = mountBox();
  h.type('zzzz');
  assert.equal(h.rows().length, 0);
  assert.equal(h.list().hidden, false);
  assert.equal(h.note().textContent, 'No bead matches that.');
});

await check('a daemon that has not read the trackers says *that*, not "no such bead"', () => {
  // The whole reason `note()` belongs to the page: a cold daemon telling you a bead you
  // filed a minute ago does not exist is the failure this line exists to prevent.
  const h = mountBox({ warm: false });
  h.type('zzzz');
  assert.match(h.note().textContent, /Still reading/);
});

console.log('\narrows, Enter, and the caret');

await check('ArrowDown highlights, and Enter takes the highlighted one', () => {
  const h = mountBox();
  h.type('bc-0xil');
  h.input().fire('keydown', { key: 'ArrowDown' });
  h.input().fire('keydown', { key: 'ArrowDown' });
  assert.deepEqual(h.rows().map((r) => r.getAttribute('aria-selected')), ['false', 'true', 'false', 'false']);
  h.input().fire('keydown', { key: 'Enter' });
  assert.deepEqual(h.calls.picked, ['beadcause/bc-0xil.1']);
});

await check('Enter with nothing highlighted takes the first, because the list is ordered', () => {
  const h = mountBox();
  h.type('bc-0xil');
  h.input().fire('keydown', { key: 'Enter' });
  assert.deepEqual(h.calls.picked, ['beadcause/bc-0xil']);
});

await check('arrowing back up off the top returns to the word you typed rather than wrapping', () => {
  const h = mountBox();
  h.type('bc-0xil');
  h.input().fire('keydown', { key: 'ArrowDown' });
  h.input().fire('keydown', { key: 'ArrowUp' });
  assert.deepEqual(h.rows().map((r) => r.getAttribute('aria-selected')), ['false', 'false', 'false', 'false']);
});

await check('one more letter drops the highlight — Enter must not pick whatever moved into that slot', () => {
  const h = mountBox();
  h.type('bc-0xil');
  h.input().fire('keydown', { key: 'ArrowDown' });
  h.input().fire('keydown', { key: 'ArrowDown' });
  h.type('bc-0xil.1');
  assert.deepEqual(h.rows().map((r) => r.getAttribute('aria-selected')), ['false', 'false']);
});

await check('Enter over an empty result does nothing at all', () => {
  const h = mountBox();
  h.type('zzzz');
  h.input().fire('keydown', { key: 'Enter' });
  assert.deepEqual(h.calls.picked, []);
});

console.log('\nthe 25-second repaint');

await check('a repaint leaves a half-typed id in the box', () => {
  // The inbox repaints wholesale every 25 seconds. This is the hazard the whole
  // never-write-while-focused rule exists for, from the typeahead's side.
  const h = mountBox();
  const input = h.input();
  input.focus();
  input.value = 'bc-0x';
  input.fire('input');
  // The page's state moves under it — a poll landing, another tab's filter arriving.
  h.state.query = 'something else';
  h.chrome.paint();
  assert.equal(h.input().value, 'bc-0x');
  assert.equal(h.input(), input, 'the input was replaced — the caret would be gone');
});

await check('a repaint does not rebuild the dropdown under the pointer', () => {
  const h = mountBox();
  h.type('bc-0xil');
  const first = h.rows()[0];
  h.chrome.paint();
  assert.equal(h.rows()[0], first, 'the row was replaced mid-hover');
});

await check('a repaint does not rebuild the pills either', () => {
  const h = mountBox();
  h.type('bc-rfnr');
  h.rows()[0].fire('click');
  const pill = h.pills()[0];
  h.chrome.paint();
  assert.equal(h.pills()[0], pill);
});

console.log('\nthe pill at rest');

await check('with nothing picked the pill is its legend and says nothing else', () => {
  // `Any bead` was on the line while the line was a digest of four groups and every one
  // of them had to contribute a word or the line read as the whole filter. A pill is one
  // group, so a pill saying `Any bead` would be two words of chrome for a control that
  // is not narrowing anything (bc-khoe.26).
  const h = mountBox();
  assert.equal(h.summary(), '');
  assert.equal(h.narrowed(), false);
});

await check('a half-typed query is not a narrowing and the pill must not claim it is', () => {
  const h = mountBox();
  h.type('bc-0xil');
  assert.equal(h.summary(), '', 'the pill announced a filter that is not applied');
  assert.equal(h.narrowed(), false);
});

await check('a picked bead is named on the pill, and the control reads as narrowed', () => {
  // The standing risk of a filter behind a control is forgetting it is set — and this
  // one hides most of the screen.
  const h = mountBox();
  h.type('bc-rfnr');
  h.rows()[0].fire('click');
  assert.match(h.summary(), /bc-rfnr/);
  assert.equal(h.narrowed(), true);
});

await check('two picks are named, three are counted', () => {
  const h = mountBox();
  for (const q of ['bc-rfnr', 'bc-qid9']) {
    h.type(q);
    h.rows()[0].fire('click');
  }
  assert.equal(h.summary(), 'bc-rfnr, bc-qid9');
  h.type('bc-0xil');
  h.rows()[0].fire('click');
  assert.equal(h.summary(), '3 bead');
});

await check('taking the last pick off puts the pill back to its legend and un-narrows it', () => {
  const h = mountBox();
  h.type('bc-rfnr');
  h.rows()[0].fire('click');
  h.pills()[0].all('pill-x')[0].fire('click');
  assert.equal(h.summary(), '');
  assert.equal(h.narrowed(), false);
});

console.log('\nthe History tab’s plain text group is untouched');

await check('a text group with no suggestions and no picks is still one input and nothing else', () => {
  // public/history.js's id box. Generalising the text group must not have grown it a
  // dropdown it never asks for or a pill row it cannot fill.
  const doc = makeDoc();
  const window = { matchMedia: () => ({ matches: false }) };
  const ctx = vm.createContext({ window, document: doc, setTimeout, clearTimeout });
  vm.runInContext(read('public/filtermenu.js'), ctx, { filename: 'filtermenu.js' });
  let value = '';
  const host = doc.createElement('nav');
  host.replaceChildren = El.prototype.replaceChildren.bind(host);
  ctx.window.beadcause.filterMenu.mount(host, {
    groups: () => [{ id: 'beadid', legend: 'Bead id', text: true, all: 'Any id', value: () => value, set: (v) => (value = v) }],
  });
  const root = host.children[0];
  assert.equal(root.all('filter-text').length, 1);
  assert.equal(root.all('suggest').length, 0, 'the ledger box grew a dropdown');
  assert.equal(root.all('pill-row').length, 0, 'the ledger box grew a pill row');
  // And its pill still shows the query, because for that box the query *is* the filter —
  // the two behaviours are opposite and both are correct.
  const input = root.all('filter-text')[0];
  input.value = 'bc-nib3';
  input.fire('input');
  assert.equal(root.all('sel')[0].textContent, 'bc-nib3');
  assert.equal(root.all('filter-summary')[0].classList.contains('on'), true);
});

/* ------------------------------------------------------------------ the wiring */

console.log('\nthe page and the daemon');

await check('app.js hands the box over as the page’s own group, and asks for nothing else', () => {
  // It was `[scopeGroup, beadGroup]` until bc-khoe.24 took the scope out onto the chrome
  // (public/filterpills.js). The box stayed and became a pill of its own in bc-khoe.26: a
  // typeahead with a dropdown under it is the one group that genuinely wants a panel
  // behind its pill rather than chips drawn flat.
  const app = read('public/app.js');
  assert.match(app, /groups: \[beadGroup\]/, 'the box is not among the filter pills');
  // And the page no longer answers "is the list narrowed" for a line that no longer
  // exists: the pill says its own picks, which names the control doing it.
  assert.ok(!/narrowed: \(\) =>/.test(app), 'app.js still answers for a summary line there is none of');
});

await check('a picked bead replaces the epic board’s narrowing rather than stacking on it', () => {
  // Stacked, a search for a bead under somebody else's P0 — most of them — would answer
  // with an empty list and a pill on screen naming the bead it was hiding.
  //
  // Two lines rather than one since bc-khoe.29, and `beadPicked()` leads both: the pills'
  // narrowing (`assignedToMe`) is what a pick replaces, and the board's own de-duplication
  // is skipped outright when one is picked, so neither can quietly re-narrow a list you
  // asked for by name.
  const app = read('public/app.js');
  assert.match(app, /const forPills = beadPicked\(\) \? inBead\(inRepo\) : assignedToMe\(inRepo\)/);
  assert.match(app, /const inBoard = beadPicked\(\) \|\| !boardHere \? forPills : underOwnedRoots\(inRepo\)/);
});

await check('the empty state names the bead rather than sending you after the wrong control', () => {
  const app = read('public/app.js');
  assert.match(app, /beadPicked\(\) \? beadNudge\(\)/, 'an emptied list would blame the kind filter');
});

await check('the daemon answers both halves — the search and the tree', () => {
  const server = read('lib/server.js');
  assert.match(server, /p === '\/api\/beads' && req\.method === 'GET'/);
  assert.match(server, /p === '\/api\/bead\/tree' && req\.method === 'GET'/);
});

await check('the search never spawns a bd export on the request path', () => {
  // This is the one route in the app that can be asked once per keystroke. `wait: true`
  // here was measured at 7.3 seconds across the nine workspaces configured on this Mac.
  const server = read('lib/server.js');
  const route = server.slice(server.indexOf("p === '/api/beads' &&"), server.indexOf("p === '/api/bead/tree' &&"));
  assert.match(route, /bd\.graph\(ws, \{ wait: false \}\)/, 'the typeahead can block on an export');
  assert.match(route, /warming/, 'a cold daemon would report "no such bead" for every bead there is');
});

await check('the tree is descendants only, so a discovered-from trail cannot drag the backlog in', () => {
  const server = read('lib/server.js');
  const route = server.slice(server.indexOf("p === '/api/bead/tree' &&"));
  assert.match(route.slice(0, 900), /treeUnder\(childrenFrom\(parents\), beads, id\)/);
});

await check('the service worker ships the changed files on a version a cached phone will notice', () => {
  const sw = read('public/sw.js');
  const version = Number(sw.match(/const CACHE = 'beadcause-v(\d+)'/)?.[1]);
  assert.ok(version >= 57, `CACHE is still v${version} — a cached filtermenu.js would draw no box`);
  assert.ok(sw.includes("'/filtermenu.js'"), 'the file the box lives in is not in SHELL');
});

await check('the stylesheet draws the pills and the dropdown', () => {
  const css = read('public/style.css');
  for (const rule of ['.filter-typeahead', '.pill-row', '.pill-x', '.suggest', '.suggest-row']) {
    assert.ok(css.includes(`${rule} `) || css.includes(`${rule},`) || css.includes(`${rule}{`), `${rule} has no rule`);
  }
});

await check('the README says what the box does — it is this repo’s spec', () => {
  const readme = read('README.md');
  assert.match(readme, /### Finding one bead/, 'the box is undocumented');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
