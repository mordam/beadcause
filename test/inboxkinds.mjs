#!/usr/bin/env node
/**
 * The inbox's kind filter, and the collapsed control it lives in.
 *
 *     npm test
 *     node test/inboxkinds.mjs
 *
 * The inbox carries five different jobs at one address — a plain question, an
 * advocate's proposal, a worker's merge, a pull request, and (under `Both` and `Agent`)
 * the live beads nobody is asking you about — and public/inboxfilter.js is the one place
 * that knows which is which. Five things about it are worth a suite, and none is visible
 * by reading one function:
 *
 * 1. **The kinds have to partition the list.** `KINDS` is a table of predicates, and
 *    two of them being true of one row means a bead counted twice in the chip counts
 *    and shown by a filter that is not about it; none of them being true means a bead
 *    that no filter can show and that `All` still hides, which is the worst outcome
 *    this app has — a question you were notified about and cannot find. So every
 *    fixture is asserted to match **exactly one**, in both directions.
 *
 * 2. **A selection must not survive a scope that cannot produce it.** `Merges` picked
 *    under `Human` and then a switch to `Agent` is an empty screen whose cause is a
 *    word inside a panel you have to open to read. `survey()` drops it.
 *
 * 3. **A repaint must not rebuild the chips.** The inbox repaints every 25 seconds. On
 *    a laptop the panel is open because a pointer is *over* it, and swapping the button
 *    out from under that pointer is a control that flickers shut while you use it. The
 *    check holds a chip node across a paint and asserts it is the same node.
 *
 * 4. **Hover and touch are one state machine, not a `:hover` rule.** A tap counts as a
 *    hover on a phone, so a CSS-only panel opens on the tap, stays open over the list,
 *    and closes on whatever you tap next — which is a card. Both devices are driven
 *    here through the real file.
 *
 * 5. **The one sub-filter must not narrow the list invisibly.** Pull requests are shown
 *    `unmerged` unless you ask for more, which is a filter nobody set — so the summary
 *    line has to say so, and a status chosen and then left behind when you widen back to
 *    `All kinds` has to keep saying so. A list narrowed by something no longer on screen
 *    is the failure this whole control was built to avoid.
 *
 * The control runs in a vm with a hand-made document, the way test/dictate.mjs runs the
 * real dictation: a rewrite of the logic as a test-only module could not fail while the
 * phone shipped something else. It is a *small* document on purpose — the file builds
 * its DOM with createElement and holds the nodes it made, so there is no innerHTML to
 * parse and no selector engine to fake.
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
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

/* --------------------------------------------------------------- a document */

/**
 * Just enough of an element: children, attributes, classes, text and listeners.
 *
 * No parser and no query engine, because the file under test needs neither — it keeps
 * a handle on every node it creates. What it does need is real enough that a wrong
 * `contains()` or a missed `replaceChildren` would fail here rather than on a phone.
 */
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
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }
  focus() {
    if (this.doc) this.doc.activeElement = this;
  }
  /** Every descendant with this class, in document order. */
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
 * The real file, in a room with a document and a localStorage in it.
 *
 * public/prcard.js goes in first, because the PR status sub-filter reads its chips off the
 * status ladder there — the real one, not a stub, so a rung renamed in one file and not the
 * other fails here as well as in test/prstage.mjs. `card: false` leaves it out, which is
 * the phone holding one file from an older cache.
 */
function load({ hover = false, store = new Map(), card = true } = {}) {
  const doc = makeDoc();
  const window = {
    matchMedia: (q) => ({ matches: q.includes('hover: hover') ? hover : false }),
  };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const ctx = vm.createContext({ window, document: doc, localStorage, setTimeout, clearTimeout });
  if (card) vm.runInContext(read('public/prcard.js'), ctx, { filename: 'prcard.js' });
  vm.runInContext(read('public/inboxfilter.js'), ctx, { filename: 'inboxfilter.js' });
  const host = doc.createElement('nav');
  host.replaceChildren = El.prototype.replaceChildren.bind(host);
  return { filter: ctx.window.beadcause.inboxFilter, doc, host, store };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* An array the file made, copied into this realm. `assert.deepEqual` is strict about
   prototypes, and an array built inside a vm context has a different `Array` — without
   this every list comparison below fails for a reason that has nothing to do with the
   code under test. */
const list = (x) => Array.from(x ?? []);

/* ---------------------------------------------------------------- fixtures */

/** One row of every kind the inbox can hold, shaped the way the payload shapes them. */
const ROWS = {
  question: { key: 'w/q1', workspace: 'w', title: 'a question' },
  proposal: { key: 'w/p1', workspace: 'w', proposal: { beads: [{ title: 'x' }] } },
  delivery: { key: 'w/d1', workspace: 'w', delivery: { number: 7 } },
  pr: { key: 'pr:w#7', workspace: 'w', pr: { key: 'w#7', number: 7, stage: 'review' } },
  claimed: { key: 'w/a1', workspace: 'w', agent: true, status: 'in_progress' },
  blocked: { key: 'w/a2', workspace: 'w', agent: true, status: 'blocked' },
  unclaimed: { key: 'w/a3', workspace: 'w', agent: true, status: 'open' },
};

const QUESTION_KINDS = ['question', 'proposal', 'delivery'];
const AGENT_KINDS = ['claimed', 'blocked', 'unclaimed'];
/* On neither side: a pull request comes off `gh`, so every scope can hold one. */
const ANY_KINDS = ['pr'];
/** A pull request on a given rung, as the row app.js synthesises from the board. */
const prOn = (stage) => ({ key: `pr:w#${stage}`, workspace: 'w', pr: { number: 1, stage } });

/* ------------------------------------------------------------------- model */

console.log('\nthe kinds partition the inbox');

const { filter: model } = load();

await check('every kind in the table is drawn, named and testable', () => {
  assert.deepEqual(list(model.KINDS).map((k) => k.id), [...QUESTION_KINDS, ...ANY_KINDS, ...AGENT_KINDS]);
  for (const k of list(model.KINDS)) {
    assert.ok(k.label, `${k.id} has no label`);
    assert.ok(k.note, `${k.id} has no note — the chip would have no accessible name`);
    assert.ok(['question', 'agent', 'any'].includes(k.side), `${k.id} has no side`);
    assert.equal(typeof k.test, 'function');
  }
});

await check('every row matches exactly one kind, and it is the right one', () => {
  for (const [id, row] of Object.entries(ROWS)) {
    const hits = list(model.KINDS.filter((k) => k.test(row))).map((k) => k.id);
    assert.deepEqual(hits, [id], `${id} matched ${hits.join(', ') || 'nothing'}`);
    assert.equal(model.kindOf(row), id);
  }
});

await check('an agent row with a status nobody has heard of is still exactly one kind', () => {
  // bd could grow a state tomorrow. Whatever it is, the row has to land somewhere —
  // a row no chip can show is a row `All` cannot show either.
  const odd = { key: 'w/a9', workspace: 'w', agent: true, status: 'wat' };
  const hits = list(model.KINDS.filter((k) => k.test(odd))).map((k) => k.id);
  assert.deepEqual(hits, ['unclaimed']);
});

await check('a delivery that is also a proposal is still one kind, not two', () => {
  // Nothing writes this today. If something ever did, counting it twice would be the
  // silent failure; landing on one chip is the loud one.
  const both = { key: 'w/x', workspace: 'w', proposal: { beads: [] }, delivery: { number: 1 } };
  const hits = list(model.KINDS.filter((k) => k.test(both))).map((k) => k.id);
  assert.deepEqual(hits, ['proposal'], `matched ${hits.join(', ') || 'nothing'}`);
});

console.log('\nwhat the filter shows');

await check('nothing selected shows everything — that is the default and the fallback', () => {
  const { filter } = load();
  assert.deepEqual(list(filter.selected()), []);
  for (const row of Object.values(ROWS)) assert.ok(filter.matches(row));
});

await check('one kind selected shows that kind and nothing else', () => {
  const { filter } = load();
  filter.set(['delivery']);
  assert.deepEqual(list(filter.selected()), ['delivery']);
  assert.ok(filter.matches(ROWS.delivery));
  assert.ok(!filter.matches(ROWS.question));
  assert.ok(!filter.matches(ROWS.proposal));
});

await check('two kinds selected show both', () => {
  const { filter } = load();
  filter.set(['delivery', 'proposal']);
  assert.ok(filter.matches(ROWS.delivery));
  assert.ok(filter.matches(ROWS.proposal));
  assert.ok(!filter.matches(ROWS.question));
});

await check('an unknown kind id is dropped rather than hiding the whole list', () => {
  const { filter } = load();
  filter.set(['nonsense']);
  assert.deepEqual(list(filter.selected()), []);
  assert.ok(filter.matches(ROWS.question), 'a junk selection emptied the inbox');
});

await check('the selection survives a reload, because it is a preference', () => {
  const store = new Map();
  load({ store }).filter.set(['proposal']);
  const again = load({ store });
  assert.deepEqual(list(again.filter.selected()), ['proposal']);
});

await check('a kind the tracker has since forgotten does not come back off disk', () => {
  const store = new Map([['beadcause.kinds', JSON.stringify(['delivery', 'gone'])]]);
  assert.deepEqual(list(load({ store }).filter.selected()), ['delivery']);
});

await check('unreadable storage reads as "no filter", never as "hide everything"', () => {
  const store = new Map([['beadcause.kinds', 'not json']]);
  const { filter } = load({ store });
  assert.deepEqual(list(filter.selected()), []);
  assert.ok(filter.matches(ROWS.question));
});

console.log('\nthe scope decides which kinds exist');

await check('a scope that cannot fetch a kind does not offer it', () => {
  const { filter } = load();
  filter.survey({ kinds: QUESTION_KINDS });
  assert.deepEqual(list(filter.usable()), QUESTION_KINDS);
  filter.survey({ kinds: AGENT_KINDS });
  assert.deepEqual(list(filter.usable()), AGENT_KINDS);
});

await check('switching scope drops a selection the new scope cannot produce', () => {
  const { filter } = load();
  filter.survey({ kinds: QUESTION_KINDS });
  filter.set(['delivery']);
  filter.survey({ kinds: AGENT_KINDS });
  assert.deepEqual(list(filter.selected()), [], 'Merges survived a switch to the agent scope');
  assert.ok(filter.matches(ROWS.claimed), 'the agent list came up empty for no visible reason');
});

await check('a selection the new scope keeps is kept', () => {
  const { filter } = load();
  filter.survey({ kinds: QUESTION_KINDS });
  filter.set(['delivery']);
  filter.survey({ kinds: [...QUESTION_KINDS, ...AGENT_KINDS] });
  assert.deepEqual(list(filter.selected()), ['delivery']);
});

/* ------------------------------------------------------------------ chrome */

/** Mount the control with a scope group, the way public/app.js does. */
function mounted({ hover = false, store = new Map(), kinds = QUESTION_KINDS, counts } = {}) {
  const { filter, doc, host } = load({ hover, store });
  const scope = { id: 'human' };
  const changes = [];
  const group = {
    id: 'scope',
    legend: 'Show',
    all: 'Everything',
    options: () =>
      [
        ['human', 'Human'],
        ['both', 'Both'],
        ['agent', 'Agent'],
      ].map(([id, label]) => ({ id, label, note: `${label} beads`, on: scope.id === id })),
    pick: (id) => {
      scope.id = id;
    },
  };
  filter.mount(host, { groups: [group], onChange: (ids) => changes.push(ids) });
  filter.survey({ kinds, counts: counts || { question: 3, proposal: 1, delivery: 2 } });
  const root = host.children[0];
  const summary = root.children[0];
  const panel = root.children[1];
  const box = (groupId) => panel.children.find((b) => b.dataset.group === groupId);
  const chips = (groupId) => box(groupId).children[1].children;
  const chip = (groupId, id) => chips(groupId).find((c) => c.dataset.chip === id);
  return { filter, doc, host, root, summary, panel, box, chips, chip, scope, changes };
}

console.log('\nthe control at rest');

await check('one line, and the panel is shut', () => {
  const { host, root, summary, panel } = mounted();
  assert.equal(host.children.length, 1, 'the nav holds more than the one control');
  assert.ok(root.classes().includes('filter-menu'));
  assert.equal(panel.hidden, true, 'the panel is open before anyone reached for it');
  assert.equal(summary.getAttribute('aria-expanded'), 'false');
});

await check('the line says what is selected, in words', () => {
  const { summary } = mounted();
  assert.equal(summary.children[0].textContent, 'Human · All kinds');
});

await check('the line names the narrowing, and the control says it is narrowed', () => {
  const { filter, summary, root } = mounted();
  filter.set(['delivery']);
  assert.equal(summary.children[0].textContent, 'Human · Merges');
  assert.ok(root.classes().includes('narrowed'), 'nothing on screen says the list is filtered');
});

await check('three selections are counted rather than listed — a phone line is short', () => {
  const { filter, summary } = mounted();
  filter.set(QUESTION_KINDS);
  assert.equal(summary.children[0].textContent, 'Human · 3 kinds');
});

await check('a chip per kind the scope can hold, each with what picking it would leave', () => {
  const { chips, chip } = mounted();
  assert.deepEqual(
    chips('kind').map((c) => c.dataset.chip),
    QUESTION_KINDS
  );
  assert.equal(chip('kind', 'question').children[1].textContent, '3');
  assert.equal(chip('kind', 'delivery').children[1].textContent, '2');
  // The scope is a switch, not a count: there is no cheap number for a slice that has
  // not been fetched, and a wrong one beside a real one is worse than none.
  assert.equal(chips('scope')[0].children.length, 1);
});

await check('every chip carries an accessible name — one word is not self-explanatory', () => {
  const { chips } = mounted();
  for (const c of [...chips('kind'), ...chips('scope')]) {
    assert.ok(c.getAttribute('aria-label')?.includes('—'), `${c.dataset.chip} has no note`);
    assert.ok(c.title, `${c.dataset.chip} has no hover title`);
    assert.ok(['true', 'false'].includes(c.getAttribute('aria-pressed')), `${c.dataset.chip} is not a toggle`);
  }
});

console.log('\nopening it: hover, and the tap that stands in for hover');

await check('a pointer that can hover opens it, and leaving closes it', async () => {
  const { root, panel, summary } = mounted({ hover: true });
  root.fire('pointerenter', { pointerType: 'mouse' });
  assert.equal(panel.hidden, false);
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
  root.fire('pointerleave', { pointerType: 'mouse' });
  // Not immediately: cutting the corner of the panel on the way to a chip is a
  // pointerleave, and a control that shut on it would be unusable with a mouse.
  assert.equal(panel.hidden, false, 'it shut on the way to the chips');
  await sleep(230);
  assert.equal(panel.hidden, true);
});

await check('coming back inside the grace keeps it open', async () => {
  const { root, panel } = mounted({ hover: true });
  root.fire('pointerenter', { pointerType: 'mouse' });
  root.fire('pointerleave', { pointerType: 'mouse' });
  root.fire('pointerenter', { pointerType: 'mouse' });
  await sleep(230);
  assert.equal(panel.hidden, false, 'the grace timer fired after the pointer came back');
});

await check('a click pins it open, so the pointer can leave the panel', async () => {
  const { root, summary, panel } = mounted({ hover: true });
  root.fire('pointerenter', { pointerType: 'mouse' });
  summary.fire('click');
  root.fire('pointerleave', { pointerType: 'mouse' });
  await sleep(230);
  assert.equal(panel.hidden, false);
  summary.fire('click');
  assert.equal(panel.hidden, true, 'a second click did not put it away');
});

await check('a touchscreen ignores hover entirely and opens on the tap', () => {
  const { root, summary, panel } = mounted({ hover: false });
  // A phone reports a pointerenter on the tap. Acting on it is how a CSS :hover panel
  // ends up open over the list until you tap a card.
  root.fire('pointerenter', { pointerType: 'touch' });
  assert.equal(panel.hidden, true);
  summary.fire('click');
  assert.equal(panel.hidden, false);
  summary.fire('click');
  assert.equal(panel.hidden, true);
});

await check('tapping away closes it, before the tap reaches the card underneath', () => {
  const { doc, root, summary, panel } = mounted();
  summary.fire('click');
  const card = doc.createElement('article');
  doc.fire('pointerdown', { target: card });
  assert.equal(panel.hidden, true);
  // And a tap inside it does not: picking two kinds in a row has to be possible.
  summary.fire('click');
  doc.fire('pointerdown', { target: panel });
  assert.equal(panel.hidden, false);
});

await check('Escape closes it and puts the focus back on the line', () => {
  const { doc, summary, panel } = mounted();
  summary.fire('click');
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, summary);
});

console.log('\npicking');

await check('a kind chip toggles, tells the page, and leaves the panel open', () => {
  const { filter, summary, panel, chip, changes } = mounted();
  summary.fire('click');
  chip('kind', 'delivery').fire('click');
  assert.deepEqual(list(filter.selected()), ['delivery']);
  assert.deepEqual(list(changes.at(-1)), ['delivery']);
  assert.equal(chip('kind', 'delivery').getAttribute('aria-pressed'), 'true');
  assert.equal(panel.hidden, false, 'picking a second kind would need a second tap to reopen');
  chip('kind', 'delivery').fire('click');
  assert.deepEqual(list(filter.selected()), [], 'the last chip off did not go back to all kinds');
});

await check('the scope is a single choice, and on touch it closes the panel it just changed', () => {
  const { summary, panel, chip, scope } = mounted({ hover: false });
  summary.fire('click');
  chip('scope', 'both').fire('click');
  assert.equal(scope.id, 'both');
  assert.equal(panel.hidden, true);
});

await check('on a laptop the same pick leaves it open — closing would fight the mouse', () => {
  const { root, panel, chip, scope } = mounted({ hover: true });
  root.fire('pointerenter', { pointerType: 'mouse' });
  chip('scope', 'agent').fire('click');
  assert.equal(scope.id, 'agent');
  assert.equal(panel.hidden, false);
});

/* ------------------------------------------------------- the status sub-filter */

console.log('\nthe one sub-filter: which pull requests');

const PR_KINDS = [...QUESTION_KINDS, ...ANY_KINDS];

await check('the default is unmerged, which is not the same as everything', () => {
  const { filter } = load();
  assert.ok(filter.matches(prOn('review')), 'a pull request in review was hidden by default');
  for (const stage of ['merged', 'pushed', 'deployed', 'live', 'closed']) {
    assert.ok(!filter.matches(prOn(stage)), `a ${stage} pull request was in the list nobody asked for`);
  }
});

await check('it applies under All kinds too — it is what the inbox is, not what you tapped', () => {
  const { filter } = load();
  assert.deepEqual(list(filter.selected()), []);
  assert.ok(!filter.matches(prOn('live')));
});

await check('picking a status shows that rung and nothing else', () => {
  const { filter } = load();
  filter.setSub('pr', ['live']);
  assert.deepEqual(list(filter.selectedSub('pr')), ['live']);
  assert.ok(filter.matches(prOn('live')));
  assert.ok(!filter.matches(prOn('review')), 'the default came back over an explicit choice');
});

await check('two statuses show both, and clearing them goes back to unmerged', () => {
  const { filter } = load();
  filter.setSub('pr', ['merged', 'pushed']);
  assert.ok(filter.matches(prOn('merged')) && filter.matches(prOn('pushed')));
  filter.setSub('pr', []);
  assert.ok(filter.matches(prOn('review')) && !filter.matches(prOn('merged')));
});

await check('a rung the ladder does not offer is dropped, not obeyed', () => {
  const { filter } = load();
  // `closed` is real in lib/prstage.js and deliberately not offered here — app.js makes no
  // card for one — so asking for it must fall back to the default rather than empty the
  // list in a way nothing on screen explains.
  filter.setSub('pr', ['closed', 'nonsense']);
  assert.deepEqual(list(filter.selectedSub('pr')), []);
  assert.ok(filter.matches(prOn('review')));
});

await check('the status survives a reload, and the kinds selection does not carry it', () => {
  const store = new Map();
  load({ store }).filter.setSub('pr', ['deployed']);
  const again = load({ store });
  assert.deepEqual(list(again.filter.selectedSub('pr')), ['deployed']);
  assert.deepEqual(list(again.filter.selected()), [], 'a status choice selected a kind as well');
});

await check('a phone that has prcard.js from an older cache still shows the unmerged ones', () => {
  // No ladder to read chips off, so there are none — and the default is this file's own
  // word, not the table's, precisely so it survives that.
  const { filter } = load({ card: false });
  assert.ok(filter.matches(prOn('review')));
  assert.ok(!filter.matches(prOn('live')));
});

await check('the chips appear only once PRs is selected, and they are the ladder minus closed', () => {
  const { filter, box, chips } = mounted({ kinds: PR_KINDS });
  assert.equal(box('status').hidden, true, 'the status chips are offered before PRs is picked');
  filter.set(['pr']);
  assert.equal(box('status').hidden, false, 'selecting PRs did not reveal the sub-filter');
  assert.deepEqual(
    chips('status').map((c) => c.dataset.chip),
    ['review', 'merged', 'pushed', 'deployed', 'live']
  );
  filter.set([]);
  assert.equal(box('status').hidden, true, 'widening back left the chips on screen');
});

await check('a status chip carries how many pull requests are on that rung', () => {
  const { filter, chip } = mounted({ kinds: PR_KINDS });
  filter.set(['pr']);
  filter.survey({ counts: { pr: 2 }, sub: { status: { review: 2, merged: 30 } } });
  assert.equal(chip('status', 'review').children[1].textContent, '2');
  assert.equal(chip('status', 'merged').children[1].textContent, '30');
  assert.ok(chip('status', 'live').classes().includes('none'), 'a rung with nothing on it is not dimmed');
});

await check('tapping a status chip tells the page, and leaves the panel open', () => {
  const { filter, summary, panel, chip, changes } = mounted({ kinds: PR_KINDS });
  filter.set(['pr']);
  summary.fire('click');
  chip('status', 'live').fire('click');
  assert.deepEqual(list(filter.selectedSub('pr')), ['live']);
  assert.deepEqual(list(changes.at(-1)), ['pr'], 'the page was never told the list moved');
  assert.equal(panel.hidden, false, 'picking a second status would need a second tap');
});

await check('the line names the narrowing — including the one nobody set', () => {
  const { filter, summary, root } = mounted({ kinds: PR_KINDS, counts: { question: 3, pr: 4 } });
  // With pull requests on screen the standing `unmerged` default is a narrowing, so it is
  // on the line at rest.
  assert.equal(summary.children[0].textContent, 'Human · All kinds · unmerged');
  filter.set(['pr']);
  assert.equal(summary.children[0].textContent, 'Human · PRs · unmerged');
  filter.setSub('pr', ['live', 'deployed']);
  assert.equal(summary.children[0].textContent, 'Human · PRs · Deployed, Live');
  assert.ok(root.classes().includes('narrowed'));
});

await check('a status left behind when you widen back is still on the line', () => {
  const { filter, summary, box } = mounted({ kinds: PR_KINDS, counts: { pr: 4 } });
  filter.set(['pr']);
  filter.setSub('pr', ['live']);
  filter.set([]);
  assert.equal(box('status').hidden, true, 'the chips stayed after the kind was dropped');
  assert.equal(
    summary.children[0].textContent,
    'Human · All kinds · Live',
    'the list is narrowed to one rung and the control does not admit it'
  );
});

await check('on a screen with no pull requests at all, it says nothing about them', () => {
  const { summary } = mounted({ kinds: PR_KINDS, counts: { question: 3 } });
  assert.equal(summary.children[0].textContent, 'Human · All kinds');
});

await check('a scope that cannot hold PRs hides the sub-filter with the chip', () => {
  // `side: 'any'` means this does not happen in the app — no scope excludes a pull
  // request. It is asserted anyway: the box is built at mount, when every kind is still
  // usable, and a box nothing hides is a control that outlives its own chip.
  const { box } = mounted({ kinds: AGENT_KINDS });
  assert.equal(box('status').hidden, true);
});

await check('the empty state can name the status as well as the kind', () => {
  const { filter } = mounted({ kinds: PR_KINDS });
  filter.set(['pr']);
  assert.equal(filter.label(), 'prs (unmerged)');
  filter.setSub('pr', ['live']);
  assert.equal(filter.label(), 'prs (live)');
});

console.log('\nthe 25-second repaint');

await check('a repaint moves the pressed state without replacing the chip under the pointer', () => {
  const { filter, chip } = mounted();
  const before = chip('kind', 'delivery');
  filter.set(['delivery']);
  filter.survey({ counts: { question: 9, proposal: 0, delivery: 4 } });
  filter.paint();
  assert.equal(chip('kind', 'delivery'), before, 'the chips were rebuilt under the pointer');
  assert.equal(before.getAttribute('aria-pressed'), 'true');
  assert.equal(before.children[1].textContent, '4', 'the count went stale');
});

await check('a scope change *does* rebuild the row, because the chips are different ones', () => {
  const { filter, chips } = mounted();
  const before = chips('kind').map((c) => c.dataset.chip);
  assert.deepEqual(before, QUESTION_KINDS);
  filter.survey({ kinds: AGENT_KINDS, counts: { claimed: 1 } });
  assert.deepEqual(
    chips('kind').map((c) => c.dataset.chip),
    AGENT_KINDS
  );
});

await check('mounting twice is a no-op, not a second control in the nav', () => {
  const { filter, host } = mounted();
  filter.mount(host, { groups: [] });
  assert.equal(host.children.length, 1);
});

/* ----------------------------------------------------------------- wiring */

console.log('\nthe page has to actually load it');

await check('index.html loads it, and before app.js', () => {
  const html = read('public/index.html');
  const mine = html.indexOf('/inboxfilter.js');
  const app = html.indexOf('/app.js');
  assert.ok(mine > 0, 'the inbox does not load the filter at all');
  assert.ok(mine < app, 'app.js runs before the control it mounts');
});

await check('the service worker ships it, on a version a cached phone will notice', () => {
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/inboxfilter.js'"), 'not in SHELL');
  const version = Number(sw.match(/const CACHE = 'beadcause-v(\d+)'/)?.[1]);
  // A phone holding the old app.js beside the new file draws a panel nothing reads;
  // the new app.js without the file draws an inbox with no scope switch at all.
  assert.ok(version >= 23, `CACHE is still v${version} — the two cannot arrive together`);
});

await check('app.js filters the list through it, rather than only drawing it', () => {
  const app = read('public/app.js');
  assert.ok(app.includes('inboxFilter'), 'app.js never asks the control anything');
  assert.ok(/inRepo\.filter\(inKind\)/.test(app), 'the list is not filtered by kind');
  assert.ok(app.includes('surveyKinds('), 'the chips are never told what is on screen');
});

await check('the counts beside the list are counted over the same filter as the list', () => {
  // A picker saying 5 above a list showing 1 is the two halves of one screen
  // disagreeing about the same beads.
  const app = read('public/app.js');
  const publish = app.slice(app.indexOf('function publishSpaces'), app.indexOf('let pendingRender'));
  assert.ok(publish.includes('inKind(q)'), 'the space picker counts rows the list is hiding');
  const summary = app.slice(app.indexOf('function paintSummary'), app.indexOf('function paintArmed'));
  assert.ok(summary.includes('inKind(q)'), 'the "N waiting" count ignores the kind filter');
});

await check('the panel says [hidden] twice, because display:flex beats the UA rule', () => {
  // Without this the panel is open from the moment the page loads, on every phone.
  assert.ok(read('public/style.css').includes('.filter-panel[hidden] { display: none; }'));
});

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} checks passed\x1b[0m`}\n`);
process.exit(failures ? 1 : 0);
