#!/usr/bin/env node
/**
 * The kinds Home carries, the pill row they are drawn as, and the panel they left.
 *
 *     npm test
 *     node test/inboxkinds.mjs
 *
 * Home carries several different jobs at one address — a plain question, an advocate's
 * proposal, a worker's merge, a pull request, a JIRA ticket assigned to you, a bead held
 * for endorsement, and (under `Both` and `Agent`) the live beads nobody is asking you
 * about — and public/inboxfilter.js is the one place that knows which is which. Since
 * bc-khoe.2 there are **six** kinds rather than ten and they are **pills** rather than
 * chips inside a collapsed panel; public/viewbar.js draws the row. Six things about all
 * that are worth a suite, and none is visible by reading one function:
 *
 * 1. **The kinds have to partition the list.** `KINDS` is a table of predicates, and
 *    two of them being true of one row means a bead counted twice in the counts and
 *    shown by a filter that is not about it; none of them being true means a bead that
 *    no filter can show and that an unnarrowed Home still hides, which is the worst
 *    outcome this app has — a question you were notified about and cannot find. So every
 *    fixture is asserted to match **exactly one**, in both directions. The amalgamation
 *    is what makes this the check that matters most here: ten predicates became four,
 *    and every one of the six rewritten exclusions is a chance to drop a row on the
 *    floor or draw it twice.
 *
 * 2. **The row and the table have to be the same six.** viewbar.js is loaded on twelve
 *    pages and this file on one, so the row cannot read the table and carries a copy of
 *    the ids and labels. A checked copy is not a second place that knows; an unchecked
 *    one is, and this suite is the check.
 *
 * 3. **A selection must not survive a scope that cannot produce it.** `All Beads` picked
 *    under `Agent` and then a switch to `Human` is an empty screen whose cause is a pill
 *    that is no longer on the row. `survey()` drops it.
 *
 * 4. **A repaint must not rebuild the chips.** The inbox repaints every 25 seconds. On
 *    a laptop the panel is open because a pointer is *over* it, and swapping the button
 *    out from under that pointer is a control that flickers shut while you use it. The
 *    check holds a chip node across a paint and asserts it is the same node.
 *
 * 5. **Hover and touch are one state machine, not a `:hover` rule.** A tap counts as a
 *    hover on a phone, so a CSS-only panel opens on the tap, stays open over the list,
 *    and closes on whatever you tap next — which is a card. Both devices are driven
 *    here through the real file.
 *
 * 6. **The two sub-filters must not narrow the list invisibly, and only one of them
 *    narrows by default.** Pull requests are shown `unmerged` unless you ask for more,
 *    which is a filter nobody set — so the summary line has to say so, and a status
 *    chosen and then left behind when you widen the pill back has to keep saying so.
 *    Bead status is the opposite and is asserted to be: nothing chosen is every rung,
 *    and the line stays quiet about a group that is not narrowing anything.
 *
 * 7. **Three of the six have a ＋ and two do not (bc-khoe.27.1).** `compose` is a flag
 *    per kind, and `composes()` answers it for whichever pill is lit. The failure it
 *    guards is a create on a screen with nothing to create — Questions and PRs are
 *    queues of things waiting on a word from you — and the failure on the other side is
 *    a kind that quietly loses the app's primary action. Both directions are asserted
 *    by name rather than by count, because a table edited to agree with a count is a
 *    table nothing checked. public/app.js's half is test/composekind.mjs.
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
function load({ hover = false, store = new Map(), card = true, search = '' } = {}) {
  const doc = makeDoc();
  /* The row's half of the seam, as a spy. inboxfilter.js pushes the lit pill out through
     `window.beadcause.views.mark` rather than the row pulling it, so this is where a
     wrong answer shows up — and it is optional chaining on that side, which means a
     missing spy would pass silently. Recording every call is what stops that. */
  const marks = [];
  const window = {
    matchMedia: (q) => ({ matches: q.includes('hover: hover') ? hover : false }),
    /* `?kind=` from a pill tapped on another page. `location` is not otherwise in this
       room, which is why the file parses the query by hand rather than with
       `URLSearchParams` — see the comment on `arrived`. */
    location: { search, pathname: '/' },
    beadcause: { views: { mark: (id) => marks.push(id) } },
  };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  /* A page group no pill names is a filter the page believes it has drawn and has not,
     and inboxfilter.js says so out loud rather than dropping it silently. There is no
     console in this room otherwise, so without this the warning would be a
     ReferenceError inside the file under test — and the check on it would pass for the
     wrong reason. */
  const warns = [];
  const console = { warn: (...a) => warns.push(a.join(' ')), log: () => {}, error: () => {} };
  const ctx = vm.createContext({ window, document: doc, localStorage, setTimeout, clearTimeout, console });
  if (card) vm.runInContext(read('public/prcard.js'), ctx, { filename: 'prcard.js' });
  // The panel itself, which inboxfilter.js mounts rather than draws — index.html loads
  // it first for the same reason. The real one, not a stub: every check below about
  // hover, pinning and the summary line is a check on *that* file, reached through this
  // one, and a stub would be the second implementation the split exists to prevent.
  vm.runInContext(read('public/filtermenu.js'), ctx, { filename: 'filtermenu.js' });
  vm.runInContext(read('public/inboxfilter.js'), ctx, { filename: 'inboxfilter.js' });
  const host = doc.createElement('nav');
  host.replaceChildren = El.prototype.replaceChildren.bind(host);
  return { filter: ctx.window.beadcause.inboxFilter, doc, host, store, marks, warns };
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
  // A chat session, which with the pull request above is one of the two rows here that
  // are not beads at all — no id in any tracker, nothing to answer. See `chatRows` in
  // public/app.js.
  session: { key: 'chat/abc', workspace: 'w', session: { id: 'abc', title: 'New beads' } },
  // A JIRA ticket, the third of those and the only one that is not even a thing this
  // app holds — it comes off JIRA. Shaped as bc-0i27.2's poller holds one: key,
  // summary, status, updated, url, assignee, and no description body. See `jiraRows`
  // in public/app.js.
  jira: {
    key: 'jira:w/TECH-1204',
    workspace: 'w',
    jira: {
      key: 'TECH-1204',
      summary: 'The meter reads zero after a reconnect',
      status: 'In Progress',
      updated: '2026-08-11T09:00:00Z',
      url: 'https://example.atlassian.net/browse/TECH-1204',
      assignee: 'adam.morgan@climative.ai',
    },
  },
  // Held for endorsement: an agent row like the three below it in every way except the
  // one that decides what may happen to it. `held` is not a status — bd has no such
  // state — it is `awaitingEndorsement` computed server-side in `agentBeads`, which is
  // why the fixture carries an ordinary `open` beside it. That pairing is the whole
  // hazard this kind introduces: without `!q.held` on the three agent predicates, this
  // row is an endorsement *and* an unclaimed bead, and the check below is what says so.
  endorsement: { key: 'w/e1', workspace: 'w', agent: true, status: 'open', held: true },
  claimed: { key: 'w/a1', workspace: 'w', agent: true, status: 'in_progress' },
  blocked: { key: 'w/a2', workspace: 'w', agent: true, status: 'blocked' },
  unclaimed: { key: 'w/a3', workspace: 'w', agent: true, status: 'open' },
};

/**
 * Which of the six each fixture above now lands on.
 *
 * The fixtures keep the names of the *shapes* — a proposal is still a proposal on the
 * wire — because what bc-khoe.2 changed is which pill draws them, not what the poller
 * sends. This map is the amalgamation stated once, and every partition check below reads
 * it rather than repeating a literal: `proposal`, `jira` and `endorsement` under
 * Questions is the bead's own acceptance criterion, in one place, checkable at a glance.
 */
const WANT = {
  question: 'question',
  proposal: 'question',
  jira: 'question',
  endorsement: 'question',
  delivery: 'pr',
  pr: 'pr',
  session: 'session',
  claimed: 'bead',
  blocked: 'bead',
  unclaimed: 'bead',
};

/** The row, in the order it is drawn. Two of the six are places, not slices. */
const PILLS = ['epics', 'question', 'pr', 'session', 'history', 'bead'];
/** The four with a predicate — the ones a selection can name. */
const SLICES = ['question', 'pr', 'session', 'bead'];
/** The two with none: Home unnarrowed, and a page of its own. */
const PLACES = ['epics', 'history'];
/* Which of the six have a ＋, and which have none — bc-khoe.27.1. Not derived from
   PLACES or SLICES, and it cuts across both: `My Epics` is a place with a create and
   `Questions` is a slice without one. History is a page of its own and never had a ＋,
   so it is in neither list for a reason that has nothing to do with the other five. */
const COMPOSE = ['epics', 'session', 'bead'];
const NO_COMPOSE = ['question', 'pr', 'history'];
/* On neither side, so every scope can hold one: a pull request comes off `gh`, a chat
   session off no sweep at all, and a question can come off either sweep — the human one
   asks it and the agent one returns the beads held for endorsement that fold into it.
   `bead` is the only kind left with a side. public/app.js `kindsForScope` is the other
   half. */
const ANY_KINDS = ['epics', 'question', 'pr', 'session', 'history'];
const AGENT_KINDS = [...ANY_KINDS, 'bead'];
/** A pull request on a given rung, as the row app.js synthesises from the board. */
const prOn = (stage) => ({ key: `pr:w#${stage}`, workspace: 'w', pr: { number: 1, stage } });

/* ------------------------------------------------------------------- model */

console.log('\nthe kinds partition the inbox');

const { filter: model } = load();

await check('six kinds, drawn, named, and each either a slice or a place', () => {
  assert.deepEqual(list(model.KINDS).map((k) => k.id), PILLS, 'the row is not six kinds in order');
  for (const k of list(model.KINDS)) {
    assert.ok(k.label, `${k.id} has no label`);
    assert.ok(k.note, `${k.id} has no note — the pill would have no accessible name`);
    assert.ok(k.icon, `${k.id} has no icon`);
    assert.ok(['question', 'agent', 'any'].includes(k.side), `${k.id} has no side`);
    // A place has no predicate and a slice has one. Anything else is a row that is half
    // a filter: selectable and matching nothing, or drawn and unreachable.
    if (PLACES.includes(k.id)) assert.equal(k.test, undefined, `${k.id} is a place with a predicate`);
    else assert.equal(typeof k.test, 'function', `${k.id} is a slice with no predicate`);
  }
});

await check('every row matches exactly one kind, and it is the amalgamated one', () => {
  // The bead's acceptance, checked directly: a bead held for endorsement, a JIRA ticket
  // and a proposal all land under Questions, and nothing lands twice or nowhere.
  for (const [name, row] of Object.entries(ROWS)) {
    const hits = list(model.KINDS.filter((k) => k.test?.(row))).map((k) => k.id);
    assert.deepEqual(hits, [WANT[name]], `${name} matched ${hits.join(', ') || 'nothing'}`);
    assert.equal(model.kindOf(row), WANT[name]);
  }
});

await check('the folds are the folds, by name', () => {
  // Stated a second way on purpose. The loop above would still pass if `WANT` were
  // edited to agree with a table that had quietly lost a fold, and the folds are the
  // whole of what bc-khoe.2 is.
  assert.equal(model.kindOf(ROWS.proposal), 'question', 'a proposal is not a question');
  assert.equal(model.kindOf(ROWS.jira), 'question', 'a JIRA ticket is not a question');
  assert.equal(model.kindOf(ROWS.endorsement), 'question', 'a held bead is not a question');
  assert.equal(model.kindOf(ROWS.delivery), 'pr', 'a merge is not a pull request');
  for (const st of ['claimed', 'blocked', 'unclaimed']) {
    assert.equal(model.kindOf(ROWS[st]), 'bead', `${st} is not a bead`);
  }
});

await check('a place is drawn but can never be selected', () => {
  // The failure this is about is a screen with nothing on it: a place has no predicate,
  // so a selection naming one would match no row at all and Home would come up empty
  // with a lit pill above it and nothing to read as the reason.
  const { filter } = load();
  for (const id of PLACES) {
    filter.set([id]);
    assert.deepEqual(list(filter.selected()), [], `${id} was selectable`);
    assert.ok(filter.matches(ROWS.question), `${id} emptied the list`);
  }
});

await check('three of the six carry a ＋ and three carry none, by name', () => {
  // The table, read directly. `composes()` below is the same fact reached through the
  // lit pill, and the two are stated apart on purpose: one of them is what public/app.js
  // asks, and the other is the row it would be asking about.
  for (const k of list(model.KINDS)) {
    const want = COMPOSE.includes(k.id);
    assert.equal(Boolean(k.compose), want, `${k.id} ${want ? 'lost' : 'grew'} its ＋`);
  }
  assert.deepEqual(
    list(model.KINDS.filter((k) => k.compose)).map((k) => k.id),
    COMPOSE,
    'the kinds with a create are not the three'
  );
  assert.deepEqual(
    list(model.KINDS.filter((k) => !k.compose)).map((k) => k.id),
    NO_COMPOSE,
    'the kinds with no create are not the three'
  );
  // Stated a third way, because the loop above would still pass if a seventh kind
  // arrived carrying a flag nobody thought about: the two lists are the whole row.
  assert.deepEqual([...COMPOSE, ...NO_COMPOSE].sort(), [...PILLS].sort());
});

await check('＋ follows the lit pill, and the two queues have none', () => {
  const { filter } = load();
  // Nothing selected is `My Epics`, which is where you land and which has one.
  assert.equal(filter.current(), 'epics');
  assert.equal(filter.composes(), true, 'the default screen lost ＋');
  for (const id of SLICES) {
    filter.set([id]);
    assert.equal(filter.current(), id, `${id} is not the lit pill after selecting it`);
    assert.equal(filter.composes(), COMPOSE.includes(id), `＋ is wrong on ${id}`);
  }
  // And back: a create that does not come back when you widen is a button you lose for
  // the rest of the session by having tapped Questions once.
  filter.set([]);
  assert.equal(filter.composes(), true, '＋ did not come back on My Epics');
});

await check('and the flag says what ＋ creates, not only that there is one', () => {
  // bc-khoe.27.3. While every ＋ started a chat, `compose` could be a bare `true`; the
  // moment `All Beads` files a bead instead, the branch has to be written down, and it
  // is written down *here* rather than as a switch over kind ids in public/app.js — a
  // second file that knows what the six kinds are is the thing this table exists to
  // prevent. So the value is the answer, and `composes()` is `Boolean` over it.
  const WHAT = { epics: 'chat', session: 'chat', bead: 'bead' };
  for (const k of list(model.KINDS)) {
    assert.equal(k.compose || '', WHAT[k.id] || '', `${k.id} creates the wrong thing`);
  }
  const { filter } = load();
  // Reached through the lit pill, which is what public/app.js actually asks.
  assert.equal(filter.creates(), 'chat', 'the screen you land on stopped starting a chat');
  for (const id of SLICES) {
    filter.set([id]);
    assert.equal(filter.creates(), WHAT[id] || '', `＋ creates the wrong thing on ${id}`);
    // The pair has to stay one fact: a kind that creates something has a button, and a
    // kind with a button creates something. Two reads that could disagree would be a
    // ＋ drawn over nothing, or a create with no way to reach it.
    assert.equal(filter.composes(), Boolean(filter.creates()), `＋ and its create disagree on ${id}`);
  }
});

await check('a place clears the selection, and ＋ comes back with it', () => {
  // `History` is the second place and it is the one that is not Home. Tapping it here
  // clears the selection rather than selecting anything (see the check above), so the
  // kind you are left on is `epics` — and `epics` has a ＋ whatever `history` does.
  const { filter } = load();
  filter.set(['question']);
  assert.equal(filter.composes(), false);
  filter.pick('history');
  assert.equal(filter.current(), 'epics', 'a place did not leave Home unnarrowed');
  assert.equal(filter.composes(), true, '＋ did not come back');
});

await check('a scope that drops the selected kind hands ＋ back with the pill', () => {
  // The path no tap goes down: `All Beads` is agent-only, so switching to `Human`
  // drops it and the lit pill falls back to `My Epics`. A ＋ painted from a stored
  // answer rather than from `current()` would be stale here — and `All Beads` and
  // `My Epics` both having one is what would hide it, so the assertion is the
  // *question*, asked twice, not the button being visible both times.
  const { filter } = load();
  filter.survey({ kinds: AGENT_KINDS });
  filter.set(['bead']);
  assert.equal(filter.current(), 'bead');
  assert.equal(filter.composes(), true);
  filter.survey({ kinds: ANY_KINDS });
  assert.deepEqual(list(filter.selected()), [], 'the agent-only kind survived the scope');
  assert.equal(filter.current(), 'epics');
  assert.equal(filter.composes(), true);
});

await check('an agent row with a status nobody has heard of is still exactly one kind', () => {
  // bd could grow a state tomorrow. Whatever it is, the row has to land somewhere —
  // a row no chip can show is a row `All` cannot show either.
  const odd = { key: 'w/a9', workspace: 'w', agent: true, status: 'wat' };
  const hits = list(model.KINDS.filter((k) => k.test?.(odd))).map((k) => k.id);
  assert.deepEqual(hits, ['bead']);
  // And on a rung of the status group, or it would be a bead that group hides on every
  // setting including the default — which is the same "cannot be found" failure one
  // level down.
  const sub = list(model.KINDS).find((k) => k.id === 'bead').sub;
  assert.equal(sub.of(odd), 'unclaimed', 'a state bd grew overnight is on no rung');
});

await check('a held bead is a question whatever its status says', () => {
  // The three agent kinds split on `status`, and `held` is orthogonal to all three: a
  // bead can be held and claimed, held and blocked, or held and open. Every one of them
  // is a decision waiting on you before it is a report about work, so every one lands
  // under Questions — and none of them lands on two. This is the check that fails if
  // `!q.held` is dropped from the `bead` predicate below it in the table.
  for (const status of ['open', 'in_progress', 'blocked', 'wat']) {
    const row = { key: `w/h-${status}`, workspace: 'w', agent: true, status, held: true };
    const hits = list(model.KINDS.filter((k) => k.test?.(row))).map((k) => k.id);
    assert.deepEqual(hits, ['question'], `held+${status} matched ${hits.join(', ') || 'nothing'}`);
  }
});

await check('a bead that is not held is a bead, not a question', () => {
  // The other direction, and the one a partition needs stated: `held` absent and `held`
  // false both have to leave a live bead where it was, or the fold would have quietly
  // emptied the agent side of Home into the Questions pill.
  for (const held of [undefined, false]) {
    const row = { key: 'w/n1', workspace: 'w', agent: true, status: 'open', held };
    const hits = list(model.KINDS.filter((k) => k.test?.(row))).map((k) => k.id);
    assert.deepEqual(hits, ['bead'], `held=${held} matched ${hits.join(', ') || 'nothing'}`);
  }
});

await check('a human-side row carrying held is still exactly one kind', () => {
  // `held` is a field only `agentBeads` writes, so a human-side row cannot have one.
  // Both halves land on Questions now, which makes this weaker than it was — it is kept
  // because the predicate still asks `q.agent` before it asks `q.held`, and the day
  // anything splits the two again this is the check that has to be reasoned about.
  const row = { key: 'w/q9', workspace: 'w', title: 'a question', held: true };
  const hits = list(model.KINDS.filter((k) => k.test?.(row))).map((k) => k.id);
  assert.deepEqual(hits, ['question'], `matched ${hits.join(', ') || 'nothing'}`);
});

await check('a delivery that is also a proposal is still one kind, not two', () => {
  // Nothing writes this today. If something ever did, counting it twice would be the
  // silent failure; landing on one pill is the loud one. It lands on Questions, which is
  // `isPr`'s one piece of precedence: an advocate asking to create beads is a thing
  // asking you something before it is a branch waiting on a merge.
  const both = { key: 'w/x', workspace: 'w', proposal: { beads: [] }, delivery: { number: 1 } };
  const hits = list(model.KINDS.filter((k) => k.test?.(both))).map((k) => k.id);
  assert.deepEqual(hits, ['question'], `matched ${hits.join(', ') || 'nothing'}`);
});

await check('no combination of the payload’s own fields falls through the table', () => {
  // The partition over the cross-product rather than over the fixtures. Ten predicates
  // became four and every fold widened one of them, so the interesting rows are no
  // longer the ones the poller writes — they are the ones two folds could both claim.
  const FLAGS = [
    ['pr', { pr: { number: 1, stage: 'review' } }],
    ['delivery', { delivery: { number: 1 } }],
    ['proposal', { proposal: { beads: [] } }],
    ['session', { session: { id: 'a' } }],
    ['jira', { jira: { key: 'T-1' } }],
    ['agent', { agent: true, status: 'open' }],
    ['held', { held: true }],
  ];
  for (let mask = 0; mask < 1 << FLAGS.length; mask += 1) {
    const row = { key: 'w/x', workspace: 'w' };
    const names = [];
    FLAGS.forEach(([name, fields], i) => {
      if (mask & (1 << i)) {
        Object.assign(row, fields);
        names.push(name);
      }
    });
    const hits = list(model.KINDS.filter((k) => k.test?.(row))).map((k) => k.id);
    assert.equal(hits.length, 1, `{${names.join(',')}} matched ${hits.join(', ') || 'nothing'}`);
  }
});

console.log('\nwhat the filter shows');

await check('nothing selected shows everything — that is the default and the fallback', () => {
  const { filter } = load();
  assert.deepEqual(list(filter.selected()), []);
  for (const row of Object.values(ROWS)) assert.ok(filter.matches(row));
});

await check('one kind selected shows that kind and nothing else', () => {
  const { filter } = load();
  filter.set(['pr']);
  assert.deepEqual(list(filter.selected()), ['pr']);
  assert.ok(filter.matches(ROWS.pr));
  // The fold, from the filtering side rather than the partition side: a delivery bead
  // is in the list under PRs, and the two rows the Merges chip used to sit between are
  // not.
  assert.ok(filter.matches(ROWS.delivery), 'a merge is not in the list under PRs');
  assert.ok(!filter.matches(ROWS.question));
  assert.ok(!filter.matches(ROWS.proposal));
});

await check('the Questions pill carries all four of the things waiting on you', () => {
  const { filter } = load();
  filter.set(['question']);
  for (const name of ['question', 'proposal', 'jira', 'endorsement']) {
    assert.ok(filter.matches(ROWS[name]), `${name} is not under Questions`);
  }
  assert.ok(!filter.matches(ROWS.pr));
  assert.ok(!filter.matches(ROWS.unclaimed));
});

await check('two kinds selected show both', () => {
  // Nothing in the row can produce this — a pill row is a navigation and lights one —
  // but `revealPr` in public/app.js widens the selection to show a card you arrived at
  // from a notification, so more than one selected is a state the app reaches.
  const { filter } = load();
  filter.set(['pr', 'question']);
  assert.ok(filter.matches(ROWS.pr));
  assert.ok(filter.matches(ROWS.proposal));
  assert.ok(!filter.matches(ROWS.unclaimed));
});

await check('an unknown kind id is dropped rather than hiding the whole list', () => {
  const { filter } = load();
  filter.set(['nonsense']);
  assert.deepEqual(list(filter.selected()), []);
  assert.ok(filter.matches(ROWS.question), 'a junk selection emptied the inbox');
});

await check('the selection survives a reload, because it is a preference', () => {
  const store = new Map();
  load({ store }).filter.set(['question']);
  const again = load({ store });
  assert.deepEqual(list(again.filter.selected()), ['question']);
});

await check('a kind the tracker has since forgotten does not come back off disk', () => {
  // Four of the ten ids this key can hold were retired by bc-khoe.2, so every phone in
  // the house has one of them written down. `delivery` here is not a hypothetical.
  const store = new Map([['beadcause.kinds', JSON.stringify(['pr', 'delivery'])]]);
  assert.deepEqual(list(load({ store }).filter.selected()), ['pr']);
});

await check('a phone that stored a retired kind comes back to an unnarrowed Home', () => {
  // The other half of the same upgrade, and the one that would be a bug report rather
  // than a shrug: the whole selection was `endorsement`, that id is gone, and dropping
  // it has to leave the list wide rather than empty.
  const store = new Map([['beadcause.kinds', JSON.stringify(['endorsement'])]]);
  const { filter } = load({ store });
  assert.deepEqual(list(filter.selected()), []);
  assert.equal(filter.current(), 'epics');
  assert.ok(filter.matches(ROWS.endorsement), 'a retired selection hid the list it named');
});

await check('unreadable storage reads as "no filter", never as "hide everything"', () => {
  const store = new Map([['beadcause.kinds', 'not json']]);
  const { filter } = load({ store });
  assert.deepEqual(list(filter.selected()), []);
  assert.ok(filter.matches(ROWS.question));
});

console.log('\nthe scope decides which kinds exist');

await check('a scope that cannot fetch a kind does not offer it', () => {
  // One kind has a side now: `bead`. Everything else is reachable under either scope —
  // Questions because the human sweep asks them and the agent sweep returns the held
  // beads folded into them, the rest because no sweep fetches them at all.
  const { filter } = load();
  filter.survey({ kinds: ANY_KINDS });
  assert.deepEqual(list(filter.usable()), ANY_KINDS);
  filter.survey({ kinds: AGENT_KINDS });
  assert.deepEqual(list(filter.usable()), AGENT_KINDS);
});

await check('switching scope drops a selection the new scope cannot produce', () => {
  const { filter } = load();
  filter.survey({ kinds: AGENT_KINDS });
  filter.set(['bead']);
  filter.survey({ kinds: ANY_KINDS });
  assert.deepEqual(list(filter.selected()), [], 'All Beads survived a switch to the human scope');
  assert.ok(filter.matches(ROWS.question), 'the human list came up empty for no visible reason');
  assert.equal(filter.current(), 'epics', 'the row is lit on a pill the scope no longer draws');
});

await check('a selection the new scope keeps is kept', () => {
  const { filter } = load();
  filter.survey({ kinds: ANY_KINDS });
  filter.set(['pr']);
  filter.survey({ kinds: AGENT_KINDS });
  assert.deepEqual(list(filter.selected()), ['pr']);
});

/* ------------------------------------------- a pill the scope cannot produce */

/*
  The other half of the same fact, and the bug bc-khoe.25 is: dropping is right when the
  *scope* has just had the last word and wrong when the *pill* is having it.

  `All Beads` is drawn on every scope, because public/viewbar.js draws the row on twelve
  pages and knows nothing about a scope. Under the default `Human` it was the one pill on
  it that could not be selected at all — `set` dropped it, `current()` fell back and the
  row lit `My Epics` — so the most-tapped scope had a dead control on it and nothing said
  why. Asking for the beads is asking for the sweep that fetches them, so the tap widens.

  The seam has three ends and the checks below cover each: the filter decides a pill is
  unreachable and asks, public/app.js answers with a scope, and the selection has to
  survive the survey that answer produces. What no vm can reach is the three of them
  agreeing across a real tap — `scripts/viewbar-check.mjs` drives that in a Chrome.
*/

/** What public/app.js's `onWiden` does, with the scopes as the two kind lists. */
const widener = (filter, seen) => (id) => {
  seen.push(id);
  // `chooseScope` surveys before it paints, so by the time `pick` reaches `set` the
  // kinds are already the wide ones. Getting that order wrong here would pass a check
  // the phone fails, which is why it is stated rather than assumed.
  filter.survey({ kinds: AGENT_KINDS });
  return true;
};

await check('a pill this scope cannot produce asks for a scope that can', () => {
  const { filter, marks } = load();
  filter.survey({ kinds: ANY_KINDS });
  const asked = [];
  filter.onWiden(widener(filter, asked));
  filter.pick('bead');
  assert.deepEqual(asked, ['bead'], 'All Beads was dropped rather than asking for the sweep behind it');
  assert.deepEqual(list(filter.selected()), ['bead'], 'the selection did not survive the widening');
  assert.equal(filter.current(), 'bead', 'the row lit My Epics — which is the bug');
  assert.equal(marks.at(-1), 'bead', 'and the row was never told');
});

await check('a tap that widened does not tell the page twice', () => {
  // The widening already emptied the list, drew the wait and went back to `bd`. A
  // listener firing on top of that is a repaint with nothing in hand — an empty list
  // over "Asking bd…", which is the one screen this tap has least right to draw.
  const { filter } = load();
  filter.survey({ kinds: ANY_KINDS });
  filter.onWiden(widener(filter, []));
  const told = [];
  filter.onChange(() => told.push(list(filter.selected())));
  filter.pick('bead');
  assert.deepEqual(told, [], 'the page repainted an empty list over the refetch');
  filter.pick('pr');
  assert.deepEqual(told, [['pr']], 'an ordinary tap stopped telling the page anything');
});

await check('a pill it can produce leaves the scope alone', () => {
  const { filter } = load();
  filter.survey({ kinds: ANY_KINDS });
  const asked = [];
  filter.onWiden(widener(filter, asked));
  filter.pick('pr');
  assert.deepEqual(asked, [], 'an ordinary tap moved the scope');
  assert.deepEqual(list(filter.selected()), ['pr']);
});

await check('and My Epics still clears the selection rather than widening anything', () => {
  // A place has no predicate, so there is nothing for a scope to fail to fetch — and
  // widening on the way to an unnarrowed Home would be a tap that changed a preference
  // for no reason at all.
  const { filter } = load();
  filter.survey({ kinds: ANY_KINDS });
  const asked = [];
  filter.onWiden(widener(filter, asked));
  filter.pick('bead');
  filter.pick('epics');
  assert.deepEqual(asked, ['bead'], 'My Epics asked for a scope');
  assert.deepEqual(list(filter.selected()), []);
  assert.equal(filter.current(), 'epics');
});

await check('a page with no answer is left as it was, not broken', () => {
  // `onWiden` is optional: eleven of the twelve pages the row is on have no scope at
  // all. The tap is then the drop it always was, which is a pill that does nothing —
  // never a throw inside a click handler.
  const { filter } = load();
  filter.survey({ kinds: ANY_KINDS });
  filter.pick('bead');
  assert.deepEqual(list(filter.selected()), []);
  assert.equal(filter.current(), 'epics');
});

await check('?kind= names the slice a pill on another page asked for', () => {
  // The same request arriving by URL instead of by tap. app.js reads this *before* it
  // mounts anything, because the first survey is what would drop the selection and
  // there is no second event to widen on — see `bootScope`.
  assert.equal(load({ search: '?kind=bead' }).filter.asked(), 'bead');
  assert.equal(load({ search: '?workspace=w&kind=pr' }).filter.asked(), 'pr');
  assert.equal(load({ search: '?kind=epics' }).filter.asked(), null, 'a place is not a slice to reach');
  assert.equal(load({ search: '?kind=endorsement' }).filter.asked(), null, 'a kind folded away months ago');
  assert.equal(load({ search: '' }).filter.asked(), null);
  assert.equal(load({ search: '?kind=%zz' }).filter.asked(), null, 'a malformed query is no instruction');
});

/*
  public/app.js's end of it, in a room with the real `KINDS`. The file is one IIFE with
  nothing exported, so the two declarations are sliced out — the shape test/cardpending.mjs
  uses. A restatement of `kindsForScope` here could not fail while the phone shipped
  something else, and `kindsForScope` is the function whose answer *was* the bug.
*/
const APP = read('public/app.js');

/** One `const … ;` out of public/app.js, brace- and paren-matched. */
function lift(name) {
  const at = APP.indexOf(name);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${name}\``);
  let depth = 0;
  for (let i = at; i < APP.length; i += 1) {
    const c = APP[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return APP.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${name}`);
}

/** `kindsForScope` and `scopeFor`, run against the table above on one of the three scopes. */
function seam(scope) {
  const ctx = vm.createContext({
    state: { scope },
    window: { beadcause: { inboxFilter: { KINDS: list(model.KINDS) } } },
  });
  // The completion value, because a `const` at the top of a script lands in the global
  // *lexical* environment and never on the context object.
  const out = vm.runInContext(
    `${lift('const kindsForScope =')}
${lift('const scopeFor =')}
({ kinds: kindsForScope(), scopeFor });`,
    ctx,
    { filename: 'app.js' }
  );
  return { kinds: list(out.kinds), scopeFor: out.scopeFor };
}

await check('the human scope really cannot produce the beads — which is why the pill was dead', () => {
  const human = seam('human');
  assert.ok(!human.kinds.includes('bead'), 'the human sweep fetches beads now, and this whole seam is moot');
  assert.equal(human.scopeFor('bead'), 'both', 'All Beads asks for no scope, so the tap widens nothing');
});

await check('Both is what it asks for, never Agent — widening must not take the questions away', () => {
  assert.equal(seam('human').scopeFor('bead'), 'both');
  for (const scope of ['both', 'agent']) {
    assert.ok(seam(scope).kinds.includes('bead'), `${scope} cannot produce beads`);
    assert.equal(seam(scope).scopeFor('bead'), null, `${scope} widens to reach a kind it already has`);
  }
});

await check('a kind with no side never asks for anything, on any of the three', () => {
  // The guard the bead asks for: a future `side` on one of these strands its pill the
  // same way, and the answer is already here — `scopeFor` is asked about every kind.
  for (const scope of ['human', 'both', 'agent']) {
    const { kinds, scopeFor } = seam(scope);
    for (const k of list(model.KINDS)) {
      if (k.side !== 'any') continue;
      assert.ok(kinds.includes(k.id), `${k.id} is unreachable under ${scope}`);
      assert.equal(scopeFor(k.id), null, `${k.id} wanted a wider scope on ${scope}`);
    }
  }
  assert.equal(seam('human').scopeFor(null), null, 'nothing asked for is something to widen');
});

await check('app.js answers the widening, and settles an arrival before the first survey', () => {
  const boot = APP.slice(APP.indexOf('function bootScope()'));
  const body = boot.slice(0, boot.indexOf('\n  }'));
  assert.ok(body.includes('inboxFilter?.asked?.()'), 'the boot never reads what ?kind= asked for');
  assert.ok(body.indexOf('scopeFor') < body.indexOf('mountFilters()'), 'the survey runs before the scope is settled');
  const mount = APP.slice(APP.indexOf('function mountFilters()'));
  const mbody = mount.slice(0, mount.indexOf('\n  }'));
  assert.ok(mbody.includes('onWiden'), 'nothing answers the widening, so the pill is dead again');
  assert.ok(mbody.indexOf('onWiden') < mbody.indexOf('survey({ kinds'), 'registered after the survey it exists for');
});

/* ------------------------------------------------------------------ chrome */

/**
 * Mount the control with a page group of its own.
 *
 * The bead search is the stand-in, **and it wears the real group's id** — which was a
 * detail until bc-khoe.3 and is load-bearing now: `KINDS` names the groups each pill can
 * use, by id, so a page group with a made-up id is one no pill would ever offer and the
 * panel would draw nothing at all. It was the scope until that bead, on the argument
 * that any page group would do; it will not do any more.
 *
 * What it is *not* is a typeahead. What these checks are about is the panel's handling
 * of a page's own group — the chips, the summary line, the accessible names — and a
 * typeahead draws an input instead of chips, so the fixture keeps the real id and the
 * chip shape. test/beadsearch.mjs is where the box's own behaviour is pinned, and
 * test/filterpills.mjs is where the scope went.
 */
function mounted({ hover = false, store = new Map(), kinds = ANY_KINDS, counts } = {}) {
  const { filter, doc, host, marks, warns } = load({ hover, store });
  const picked = { id: '' };
  const cleared = { n: 0 };
  const changes = [];
  const group = {
    id: 'bead',
    legend: 'Bead',
    all: 'Any bead',
    options: () =>
      [
        ['bc-one', 'bc-one'],
        ['bc-two', 'bc-two'],
      ].map(([id, label]) => ({ id, label, note: `${label} and the work under it`, on: picked.id === id })),
    pick: (id) => {
      picked.id = id;
    },
    /* The page's own half of the drop rule (bc-khoe.3): the selection lives here, so all
       inboxfilter.js can do is ask. Counted as well as done, because "it was already
       empty" and "nobody asked" look identical from the outside. */
    clear: () => {
      picked.id = '';
      cleared.n += 1;
    },
  };
  filter.mount(host, { groups: [group], onChange: (ids) => changes.push(ids) });
  filter.survey({ kinds, counts: counts || { question: 3, session: 1 } });
  const root = host.children[0];
  const summary = root.children[0];
  const panel = root.children[1];
  const box = (groupId) => panel.children.find((b) => b.dataset.group === groupId);
  const chips = (groupId) => box(groupId).children[1].children;
  const chip = (groupId, id) => chips(groupId).find((c) => c.dataset.chip === id);
  return { filter, doc, host, root, summary, panel, box, chips, chip, picked, cleared, changes, marks, warns };
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
  // Just the scope. The kinds were the other half of this line until bc-khoe.2 and are
  // the lit pill now — a line that also named them would be the app saying the same
  // thing twice, in two rows of chrome, one of which you have to open.
  const { summary } = mounted();
  assert.equal(summary.children[0].textContent, 'Any bead');
});

await check('the selected kind does not make the line bold', () => {
  // Deliberate, and the reverse of what this control did while the kinds were in it. A
  // narrowing has to be admitted to somewhere on screen; the pill row is where, and it
  // is on screen without being reached for. A line that went bold for every pill but
  // the leftmost would be bold nearly always — a signal that has stopped signalling.
  const { filter, summary, root } = mounted();
  filter.set(['question']);
  assert.equal(summary.children[0].textContent, 'Any bead');
  assert.ok(!root.classes().includes('narrowed'), 'the panel claims a narrowing it does not own');
});

await check('a chip per group the panel still owns, and no kinds among them', () => {
  const { panel, chips } = mounted();
  const groups = panel.children.map((b) => b.dataset.group);
  assert.ok(!groups.includes('kind'), 'the kinds are still chips in the panel');
  // `bead` here is the fixture's stand-in for app.js's search box — see `mounted`. What
  // the check is about is that the page's group leads and the control's own two follow
  // it. Every box exists at mount, whichever pill is lit; which of them is *offered* is
  // the pill's business and is checked further down.
  assert.deepEqual(groups, ['bead', 'status', 'beadstatus'], `the panel holds ${groups.join(', ')}`);
  // No count on a page group's chips here: the real box has none either, and a wrong
  // number beside the sub-filters' real ones is worse than none.
  assert.equal(chips('bead')[0].children.length, 1);
});

await check('every chip carries an accessible name — one word is not self-explanatory', () => {
  const { filter, chips } = mounted({ kinds: AGENT_KINDS });
  filter.set(['bead']);
  for (const c of [...chips('bead'), ...chips('beadstatus')]) {
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

await check('a pill tells the page, the way the chip it replaced did', () => {
  // The chips were how a kind changed and the page heard about it on the same channel a
  // scope tap uses. The pill is that now, and `onChange` has to keep firing — public/app.js
  // hangs `render(true)` and `loadBoard()` off it, and a pill that moved the filter
  // without waking those two is a lit pill over the list it was supposed to replace.
  const { filter, changes } = mounted();
  filter.pick('pr');
  assert.deepEqual(list(filter.selected()), ['pr']);
  assert.deepEqual(list(changes.at(-1)), ['pr'], 'the page was never told the pill moved');
  filter.pick('epics');
  assert.deepEqual(list(filter.selected()), [], 'My Epics did not go back to an unnarrowed Home');
  assert.deepEqual(list(changes.at(-1)), []);
});

await check('a page group is a single choice, and on touch it closes the panel it just changed', () => {
  const { summary, panel, chip, picked } = mounted({ hover: false });
  summary.fire('click');
  chip('bead', 'bc-two').fire('click');
  assert.equal(picked.id, 'bc-two');
  assert.equal(panel.hidden, true);
});

await check('on a laptop the same pick leaves it open — closing would fight the mouse', () => {
  const { root, panel, chip, picked } = mounted({ hover: true });
  root.fire('pointerenter', { pointerType: 'mouse' });
  chip('bead', 'bc-one').fire('click');
  assert.equal(picked.id, 'bc-one');
  assert.equal(panel.hidden, false);
});

/* ------------------------------------------------------- the status sub-filter */

console.log('\nthe first sub-filter: which pull requests');

const PR_KINDS = ANY_KINDS;

await check('the default is unmerged, which is not the same as everything', () => {
  const { filter } = load();
  assert.ok(filter.matches(prOn('review')), 'a pull request in review was hidden by default');
  for (const stage of ['merged', 'pushed', 'deployed', 'live', 'closed']) {
    assert.ok(!filter.matches(prOn(stage)), `a ${stage} pull request was in the list nobody asked for`);
  }
});

await check('it applies under My Epics too — it is what Home is, not what you tapped', () => {
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
  // on the line at rest — and it is the only thing on it that is, which is why the line
  // says `unmerged` beside a scope rather than beside a kind.
  assert.equal(summary.children[0].textContent, 'Any bead · unmerged');
  filter.set(['pr']);
  assert.equal(summary.children[0].textContent, 'Any bead · unmerged');
  filter.setSub('pr', ['live', 'deployed']);
  assert.equal(summary.children[0].textContent, 'Any bead · Deployed, Live');
  assert.ok(root.classes().includes('narrowed'));
});

await check('a status left behind when you widen back is still on the line', () => {
  const { filter, summary, box } = mounted({ kinds: PR_KINDS, counts: { pr: 4 } });
  filter.set(['pr']);
  filter.setSub('pr', ['live']);
  filter.set([]);
  assert.equal(box('status').hidden, true, 'the chips stayed after the pill was widened');
  assert.equal(
    summary.children[0].textContent,
    'Any bead · Live',
    'the list is narrowed to one rung and the control does not admit it'
  );
});

await check('on a screen with no pull requests at all, it says nothing about them', () => {
  const { summary } = mounted({ kinds: PR_KINDS, counts: { question: 3 } });
  assert.equal(summary.children[0].textContent, 'Any bead');
});

await check('a scope that cannot hold PRs hides the sub-filter with the pill', () => {
  // `side: 'any'` means this does not happen in the app — no scope excludes a pull
  // request. It is asserted anyway: the box is built at mount, when every kind is still
  // usable, and a box nothing hides is a control that outlives its own pill.
  const { box } = mounted({ kinds: ['epics', 'question'] });
  assert.equal(box('status').hidden, true);
});

await check('the empty state can name the status as well as the kind', () => {
  const { filter } = mounted({ kinds: PR_KINDS });
  filter.set(['pr']);
  assert.equal(filter.label(), 'prs (unmerged)');
  filter.setSub('pr', ['live']);
  assert.equal(filter.label(), 'prs (live)');
});

/* ------------------------------------------------- the bead status sub-filter */

console.log('\nthe second sub-filter: which beads, and why its default is the other way');

await check('nothing chosen is every rung, which is not what the PR group means', () => {
  // The whole reason `inSub` has two behaviours. A group with a `fallback` narrows with
  // nothing chosen; a group without one does not. Getting this backwards is an All Beads
  // pill that shows nothing at all, which reads as a broken sweep rather than a filter.
  const { filter } = load();
  filter.set(['bead']);
  for (const st of ['claimed', 'blocked', 'unclaimed']) {
    assert.ok(filter.matches(ROWS[st]), `${st} was hidden by a filter nobody set`);
  }
});

await check('picking a rung shows that rung and nothing else', () => {
  const { filter } = load();
  filter.set(['bead']);
  filter.setSub('bead', ['blocked']);
  assert.ok(filter.matches(ROWS.blocked));
  assert.ok(!filter.matches(ROWS.claimed));
  assert.ok(!filter.matches(ROWS.unclaimed));
  // And back: clearing it goes to every rung rather than to none of them.
  filter.setSub('bead', []);
  assert.ok(filter.matches(ROWS.claimed));
});

await check('two rungs show both', () => {
  const { filter } = load();
  filter.set(['bead']);
  filter.setSub('bead', ['claimed', 'blocked']);
  assert.ok(filter.matches(ROWS.claimed));
  assert.ok(filter.matches(ROWS.blocked));
  assert.ok(!filter.matches(ROWS.unclaimed));
});

await check('the three rungs are what the three retired pills were', () => {
  const { filter } = load();
  const sub = list(filter.KINDS).find((k) => k.id === 'bead').sub;
  assert.deepEqual(list(sub.options()).map((o) => o.id), ['claimed', 'blocked', 'unclaimed']);
  for (const o of list(sub.options())) assert.ok(o.label && o.note, `${o.id} has no label or note`);
  assert.equal(sub.of(ROWS.claimed), 'claimed');
  assert.equal(sub.of(ROWS.blocked), 'blocked');
  assert.equal(sub.of(ROWS.unclaimed), 'unclaimed');
});

await check('its chips appear only once All Beads is selected', () => {
  const { filter, box, chips } = mounted({ kinds: AGENT_KINDS, counts: { bead: 5 } });
  assert.equal(box('beadstatus').hidden, true, 'the rungs are offered under every pill');
  filter.set(['bead']);
  assert.equal(box('beadstatus').hidden, false);
  assert.deepEqual(chips('beadstatus').map((c) => c.dataset.chip), ['claimed', 'blocked', 'unclaimed']);
});

await check('the line stays quiet about a group that is not narrowing anything', () => {
  // The other half of the two-defaults argument, on the summary line rather than in the
  // predicate. PR status says `unmerged` over a screen with pull requests on it because
  // that *is* a narrowing; bead status says nothing until you choose, because it is not.
  const { filter, summary } = mounted({ kinds: AGENT_KINDS, counts: { bead: 5 } });
  assert.equal(summary.children[0].textContent, 'Any bead');
  filter.set(['bead']);
  assert.equal(summary.children[0].textContent, 'Any bead · any status');
  filter.setSub('bead', ['blocked']);
  assert.equal(summary.children[0].textContent, 'Any bead · Blocked');
  // And once chosen it keeps saying so after the pill widens, exactly as PR status does.
  filter.set([]);
  assert.equal(summary.children[0].textContent, 'Any bead · Blocked');
});

/* ------------------------------------------- the panel is a function of the pill */

console.log('\nwhat the panel offers is whatever the lit pill can use');

await check('every pill says which of the panel’s groups it can use', () => {
  // The table is the declaration, so a kind added without one is a pill under which the
  // panel would quietly offer nothing at all — which is indistinguishable, on screen,
  // from a pill that genuinely has no second axis.
  const known = new Set(['bead']);
  for (const k of list(model.KINDS)) if (k.sub) known.add(k.sub.id);
  for (const k of list(model.KINDS)) {
    assert.ok(Array.isArray(k.filters), `${k.id} does not say what the panel may offer under it`);
    for (const id of list(k.filters)) assert.ok(known.has(id), `${k.id} names a group nothing draws: ${id}`);
    // A pill's own second axis has to be among them, or its chips could never open.
    if (k.sub) assert.ok(list(k.filters).includes(k.sub.id), `${k.id} does not offer its own sub-filter`);
  }
});

await check('the bead search is offered under every pill whose rows are beads', () => {
  const { filter, box } = mounted({ kinds: AGENT_KINDS });
  assert.equal(box('bead').hidden, false, 'My Epics');
  for (const id of ['question', 'pr', 'bead']) {
    filter.set([id]);
    assert.equal(box('bead').hidden, false, id);
  }
});

await check('Chats can use none of them, so the panel takes itself off the row', () => {
  // A chat is in no tracker: it is under no bead and it has no status. What would be
  // left is a summary line that opens an empty box, which is worse chrome than no line.
  const { filter, root, box } = mounted();
  assert.equal(root.hidden, false);
  filter.set(['session']);
  assert.equal(box('bead').hidden, true, 'the search is offered over a list it can only empty');
  assert.equal(root.hidden, true, 'a line that opens an empty panel');
  filter.set([]);
  assert.equal(root.hidden, false, 'widening back left the control gone');
});

await check('the panel stays while a group is only off screen, not gone', () => {
  // The other side of the same rule, and the one it would be easy to break: under
  // `My Epics` neither sub-filter's chips are offered, and the control must not vanish
  // because of it — the search is still there and the standing `unmerged` default is
  // still on the line.
  const { root, summary } = mounted({ kinds: PR_KINDS, counts: { pr: 4 } });
  assert.equal(root.hidden, false);
  assert.equal(summary.children[0].textContent, 'Any bead · unmerged');
});

await check('a status the newly-lit pill cannot reach is dropped, not left narrowing it', () => {
  const { filter } = mounted({ kinds: PR_KINDS, counts: { pr: 4 } });
  filter.set(['pr']);
  filter.setSub('pr', ['live']);
  filter.set(['question']);
  assert.deepEqual(list(filter.selectedSub('pr')), [], 'a pull-request rung outlived a list with no pull requests in it');
  // `matches` is no use here — the kind filter hides every pull request under Questions
  // whatever the status says, which is exactly why the leftover was invisible. `inSub`
  // is the sub-filter on its own, and it is back to the standing default.
  assert.ok(filter.inSub(prOn('review')), 'the standing default did not come back with it');
  assert.ok(!filter.inSub(prOn('live')), 'the dropped rung is still the one being shown');
});

await check('and the line stops naming it, because there is nothing here for it to narrow', () => {
  // `counts` is taken *before* the kind filter — that is what makes a pill's number the
  // list it would open — so four pull requests are still counted under `Questions` and
  // none of them is on screen. Saying `unmerged` there is this control's own failure in
  // the mirror: a filter named on the line that is not filtering anything.
  const { filter, summary } = mounted({ kinds: PR_KINDS, counts: { pr: 4 } });
  assert.equal(summary.children[0].textContent, 'Any bead · unmerged');
  filter.set(['question']);
  assert.equal(summary.children[0].textContent, 'Any bead');
});

await check('a status the new pill *can* reach is kept, and still confessed', () => {
  // The distinction the whole rule turns on. `My Epics` holds every kind, so a rung
  // chosen under `PRs` goes on hiding merged pull requests there — it is dormant under
  // `Questions` and biting under `My Epics`, and only the first of those is dropped.
  const { filter, summary } = mounted({ kinds: PR_KINDS, counts: { pr: 4 } });
  filter.set(['pr']);
  filter.setSub('pr', ['live']);
  filter.set([]);
  assert.deepEqual(list(filter.selectedSub('pr')), ['live']);
  assert.equal(summary.children[0].textContent, 'Any bead · Live');
});

await check('bead status goes exactly the same way', () => {
  const { filter } = mounted({ kinds: AGENT_KINDS, counts: { bead: 5 } });
  filter.set(['bead']);
  filter.setSub('bead', ['blocked']);
  filter.set(['pr']);
  assert.deepEqual(list(filter.selectedSub('bead')), [], 'a rung of All Beads survived the PRs pill');
  filter.set([]);
  assert.ok(filter.matches({ key: 'w/a2', workspace: 'w', agent: true, status: 'in_progress' }));
});

await check('the page is asked to clear its own group, never cleared behind its back', () => {
  const { filter, chip, picked, cleared } = mounted();
  chip('bead', 'bc-one').fire('click');
  assert.equal(picked.id, 'bc-one');
  const before = cleared.n;
  filter.set(['session']);
  assert.equal(cleared.n, before + 1, 'the panel dropped a page group without asking the page');
  assert.equal(picked.id, '');
});

await check('a page group with no clear of its own keeps what it had, rather than throwing', () => {
  // `clear` is optional on purpose: a page that cannot drop its own selection must not
  // be able to stop a pill being tapped.
  const { filter, host } = load();
  filter.mount(host, {
    groups: [{ id: 'bead', legend: 'Bead', all: 'Any bead', options: () => [{ id: 'x', label: 'x', on: true }], pick: () => {} }],
  });
  filter.survey({ kinds: ANY_KINDS });
  filter.set(['session']);
  assert.deepEqual(list(filter.selected()), ['session']);
});

await check('a group no pill names is loud, and never offered', () => {
  // A filter the page believes it has drawn and has not. Silent, it is a control that
  // renders nowhere; loud, it is a one-line fix in KINDS.
  const { filter, host, warns } = load();
  filter.mount(host, {
    groups: [{ id: 'nonsense', legend: 'Nonsense', options: () => [{ id: 'x', label: 'x', on: false }], pick: () => {} }],
  });
  filter.survey({ kinds: ANY_KINDS });
  assert.ok(
    warns.some((w) => w.includes('nonsense')),
    `nothing was said about a group no pill can use: ${warns.join(' | ')}`
  );
  const panel = host.children[0].children[1];
  assert.equal(panel.children.find((b) => b.dataset.group === 'nonsense').hidden, true);
});

await check('app.js hands the panel a group it can clear', () => {
  // The other end of the same seam, and the half a vm cannot reach: the bead box's
  // selection lives in app.js's `state.bead`, so the rule above is only real if that
  // file answers the call.
  const src = read('public/app.js');
  assert.ok(/function clearBeads\(/.test(src), 'app.js has no way to drop its own bead picks');
  assert.ok(/clear: \(\) => clearBeads\(\)/.test(src), 'the bead group the panel is handed cannot be cleared');
});

console.log('\nthe 25-second repaint');

await check('a repaint moves the pressed state without replacing the chip under the pointer', () => {
  const { filter, chip } = mounted({ kinds: PR_KINDS, counts: { pr: 4 } });
  filter.set(['pr']);
  const before = chip('status', 'live');
  filter.setSub('pr', ['live']);
  filter.survey({ counts: { pr: 9 }, sub: { status: { review: 2, live: 4 } } });
  filter.paint();
  assert.equal(chip('status', 'live'), before, 'the chips were rebuilt under the pointer');
  assert.equal(before.getAttribute('aria-pressed'), 'true');
  assert.equal(before.children[1].textContent, '4', 'the count went stale');
});

await check('a scope change hides the box whose kind the new scope cannot produce', () => {
  // What this used to assert — that the kind chips are rebuilt when the scope changes —
  // has no chips left to be about. What survives is the half that matters: a group whose
  // parent pill the scope cannot draw is a control with nothing behind it, and `hidden`
  // is what takes it off the panel rather than leaving it there doing nothing.
  const { filter, box } = mounted({ kinds: AGENT_KINDS, counts: { bead: 3 } });
  filter.set(['bead']);
  assert.equal(box('beadstatus').hidden, false);
  filter.survey({ kinds: ANY_KINDS, counts: {} });
  assert.equal(box('beadstatus').hidden, true, 'the rungs outlived the pill they narrow');
});

console.log('\nthe pill row');

const VIEWBAR = read('public/viewbar.js');

/** The row's own list, lifted out of the file rather than repeated here. */
const rowPills = () => {
  const src = VIEWBAR.slice(VIEWBAR.indexOf('const PILLS = ['));
  return [...src.slice(0, src.indexOf('\n  ];')).matchAll(/\bid: '([a-z]+)'/g)].map((m) => m[1]);
};

await check('the row draws the six kinds, in the table’s order', () => {
  // The copy, checked. viewbar.js is loaded on twelve pages and inboxfilter.js on one,
  // so the row cannot read the table at paint time — which makes this the only thing
  // standing between "one place that knows" and two lists that drift.
  const drawn = rowPills();
  assert.deepEqual(drawn.slice(0, PILLS.length), PILLS, `the row draws ${drawn.join(', ')}`);
});

await check('and every kind’s label is the same word in both files', () => {
  for (const k of list(model.KINDS)) {
    const at = VIEWBAR.indexOf(`id: '${k.id}', kind: '${k.id}'`);
    assert.notEqual(at, -1, `${k.id} is in the table and not on the row`);
    const row = VIEWBAR.slice(at, VIEWBAR.indexOf('\n', at));
    assert.ok(row.includes(`label: '${k.label}'`), `${k.id} is "${k.label}" here and something else on the row`);
    assert.ok(row.includes(`icon: '${k.icon}'`), `${k.id} has a different icon on the row`);
  }
});

await check('only History leaves Home, and it is the one with an href', () => {
  // Five of the six are Home under a different narrowing, so five of the six must not
  // carry an href — a link to the page you are on is a full document load to change
  // which rows of a list already in hand get drawn.
  for (const k of list(model.KINDS)) {
    const at = VIEWBAR.indexOf(`id: '${k.id}', kind: '${k.id}'`);
    const row = VIEWBAR.slice(at, VIEWBAR.indexOf('\n', at));
    if (k.id === 'history') assert.ok(row.includes("href: '/history'"), 'History is not a link');
    else assert.ok(!row.includes('href:'), `${k.id} navigates away from Home`);
  }
});

await check('and the table does not know where any of them goes', () => {
  // The half the copy deliberately does *not* duplicate. What a kind is belongs here;
  // where its pill points belongs to the row, because it is a fact about the row — and
  // a URL written down in two files is the drift the check above exists to catch, made
  // unnecessary rather than caught.
  for (const k of list(model.KINDS)) assert.equal(k.href, undefined, `${k.id} carries an href`);
});

await check('nothing is lit but My Epics until something says otherwise', () => {
  const { filter } = load();
  assert.equal(filter.current(), 'epics');
});

await check('the lit pill follows the selection, and is pushed at the row', () => {
  const { filter, marks } = load();
  filter.pick('pr');
  assert.equal(filter.current(), 'pr');
  assert.equal(marks.at(-1), 'pr', 'the row was never told which pill to light');
  filter.pick('epics');
  assert.equal(filter.current(), 'epics');
  assert.equal(marks.at(-1), 'epics');
});

await check('a pill is exclusive, unlike the chips it replaced', () => {
  // Two chips pressed was a legitimate state and two pills lit is not: a row of
  // navigation with two destinations lit is not a navigation.
  const { filter } = load();
  filter.pick('pr');
  filter.pick('question');
  assert.deepEqual(list(filter.selected()), ['question']);
});

await check('more than one selected still lights exactly one, the leftmost', () => {
  // `revealPr` in public/app.js widens the selection rather than replacing it, so this
  // state is reachable without a pill being tapped. Lighting the leftmost is the only
  // answer that does not depend on the order the selections arrived in.
  const { filter } = load();
  filter.set(['bead', 'question']);
  assert.equal(filter.current(), 'question');
});

await check('?kind= from a pill tapped on another page arrives narrowed', () => {
  const { filter } = load({ search: '?kind=pr' });
  assert.deepEqual(list(filter.selected()), ['pr']);
  assert.equal(filter.current(), 'pr');
});

await check('and it outranks what is on disk, which is the whole point of the link', () => {
  const store = new Map([['beadcause.kinds', JSON.stringify(['question'])]]);
  const { filter } = load({ store, search: '?workspace=w&kind=session' });
  assert.deepEqual(list(filter.selected()), ['session'], 'the link landed on the last thing looked at');
});

await check('?kind=epics is an unnarrowed Home, not a selection of nothing-matches', () => {
  const store = new Map([['beadcause.kinds', JSON.stringify(['pr'])]]);
  const { filter } = load({ store, search: '?kind=epics' });
  assert.deepEqual(list(filter.selected()), []);
  assert.equal(filter.current(), 'epics');
  assert.ok(filter.matches(ROWS.question), 'My Epics arrived at an empty screen');
});

await check('a malformed query does not take the whole control down with it', () => {
  // This is parsed at the top level of the file, so an uncaught throw here means no
  // `window.beadcause.inboxFilter` at all — the inbox loses its filter, its counts and
  // its empty state over a stray `%` in a URL somebody pasted.
  const { filter } = load({ search: '?kind=%zz' });
  assert.ok(filter, 'the file threw at load over a malformed query');
  assert.deepEqual(list(filter.selected()), []);
});

await check('a ?kind= naming a retired id leaves the selection alone', () => {
  // A phone's home screen holds links this app wrote months ago. "No instruction" and
  // "clear it" are different answers and a stale link deserves the first.
  const store = new Map([['beadcause.kinds', JSON.stringify(['pr'])]]);
  const { filter } = load({ store, search: '?kind=endorsement' });
  assert.deepEqual(list(filter.selected()), ['pr']);
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
  // The tags rather than the first mention of each path — index.html names both files
  // in its prose, and prose order is not load order. See the same note in
  // test/editmode.mjs, which this question was copied from and which failed on it.
  const mine = html.indexOf('<script src="/inboxfilter.js">');
  const app = html.indexOf('<script src="/app.js">');
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
  // `inBoard`, not `inRepo`: bc-rfnr.2 put the epic board's descendant filter between the
  // two, and the kind filter is deliberately last so the chips count what you can
  // actually get to. What this check is about is that `inKind` still narrows the list
  // rather than only colouring the chips — whichever variable it is handed.
  assert.ok(/inBoard\.filter\(inKind\)/.test(app), 'the list is not filtered by kind');
  // The epic board still narrows it — bc-rfnr.2 — but bc-0xil put one thing ahead of it:
  // a bead picked in the search box *replaces* the board's narrowing rather than
  // stacking on it, because half the beads worth searching for are under somebody
  // else's P0 or under none, and stacked they would answer an explicit search with an
  // empty list. So what this asserts is the branch, not the bare call.
  assert.ok(
    /const inBoard = beadPicked\(\) \? inBead\(inRepo\) : underOwnedRoots\(inRepo\)/.test(app),
    'the epic board no longer narrows the list'
  );
  assert.ok(app.includes('surveyKinds('), 'the chips are never told what is on screen');
});

await check('nothing beside the list counts it a second time', () => {
  // There used to be two: a `· N` per repo on the space picker and an **N waiting**
  // pill in the top bar, both counted off the render that drew the list so they could
  // follow a kind-filter tap that fetches nothing. bc-ka5y.1 deleted both — a picker
  // saying 5 above a list showing 1 is the two halves of one screen disagreeing about
  // the same beads, and the cheapest way to never disagree is to say nothing.
  const app = read('public/app.js');
  // The call, rather than the word: app.js's edit-mode freeze paragraph names
  // `publishCounts()` in prose, explaining what its removal cost.
  assert.ok(!/^\s*publishCounts\(/m.test(app), 'the space picker is being sent counts again');
  assert.ok(!app.includes("$('#waiting')"), 'the "N waiting" pill is back in the top bar');
  // And `paintSummary`, which was the same mistake on the other bar: the proposals count
  // hung off the Advocates tab through `beadcause.tabBadge`. bc-khoe.1 deleted the bottom
  // bar it was drawn on, and the pill row that replaced it carries no counts at all — a
  // badge is only ever live on the one page whose poll happens to fetch it.
  assert.ok(!app.includes('function paintSummary'), 'paintSummary is back, counting the list into the chrome');
  assert.ok(!app.includes('window.beadcause?.tabBadge'), 'something is hanging a count off the navigation again');
});

await check('the panel says [hidden] twice, because display:flex beats the UA rule', () => {
  // Without this the panel is open from the moment the page loads, on every phone.
  assert.ok(read('public/style.css').includes('.filter-panel[hidden] { display: none; }'));
});

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} checks passed\x1b[0m`}\n`);
process.exit(failures ? 1 : 0);
