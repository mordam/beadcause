#!/usr/bin/env node
/**
 * Point, retype, describe — and the change list all three land in.
 *
 *     npm test
 *     node test/editchanges.mjs
 *
 * bc-p49x.1 made the screen a thing you can point at; this is what pointing at it does.
 * The mode's own suite is test/editmode.mjs and it stops at the anchor — everything here
 * is downstream of one, and four things are worth a suite of their own.
 *
 * 1. **Three meanings out of one press, and the wrong one is expensive.** A phone has a
 *    single gesture surface, so tap/hold/hold-and-drag are told apart by time and then by
 *    movement. The failure that matters is not a missed gesture: it is a *scroll* read as
 *    a drag, which makes this list unusable in the mode with no message saying why. So
 *    the scroll case is checked as carefully as the three that do something.
 *
 * 2. **Nothing may look like it saved.** Every visual a gesture leaves is a state of the
 *    conversation and not of the app, and the whole epic falls over if one of them reads
 *    as a change that took effect — a person who believes the drag moved something will
 *    reopen the app, find it where it was, and conclude the save failed. A drop snaps
 *    back before the note box even opens, and leaving the mode puts every retyped word
 *    back where the app had it.
 *
 * 3. **A gesture with nothing said about it is not an edit.** The drag exists so you can
 *    see what you are talking about; the note is what an agent acts on. A pass full of
 *    "something about this card" is worse than an empty one, so an empty note is refused
 *    at the box and a cancelled one records nothing at all.
 *
 * 4. **The list is reviewable, and dropping an entry has to undo it.** Removing a retype
 *    from the list while its words are still on the screen would leave the screen saying
 *    something the pass no longer holds.
 *
 * The real public/editmode.js runs in a vm against a hand-made document, the way
 * test/editmode.mjs runs it — with the parts the gestures need that the mode did not:
 * capture listeners on the document, a clock the test moves by hand, `elementFromPoint`,
 * and elements with a `style`. What is deliberately NOT here is whether a real thumb on
 * a real phone produces this sequence of events at all; that needs a browser and it is
 * scripts/editgesture-check.mjs.
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
/** Awaited, unlike the sibling suites': half the cases here need the module's source
 *  read before a gesture can be anchored, and a rejected body would otherwise be an
 *  unhandled promise rather than a failure. */
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

console.log('\nedit mode — the three gestures and the change list');

/* ================================================================ a fake document */

/** `.cls`, `#id`, `tag`, `[attr]`, `[attr="value"]` — the shapes this module asks for. */
function matches(el, sel) {
  for (const one of String(sel).split(',')) {
    const s = one.trim();
    if (!s) continue;
    if (s.startsWith('.') && el.classList.contains(s.slice(1))) return true;
    if (s.startsWith('#') && el.id === s.slice(1)) return true;
    if (s.startsWith('[')) {
      const [, name, value] = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/) || [];
      if (!name) continue;
      const got = el.getAttribute(name);
      if (got !== null && got !== undefined && (value === undefined || got === value)) return true;
    } else if (/^[a-z]+$/i.test(s) && el.tagName === s.toUpperCase()) return true;
  }
  return false;
}

function makeEl(tag, attrs = {}, kids = [], text = '') {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    children: kids,
    own: text,
    parentElement: null,
    dataset: {},
    style: {},
    isConnected: true,
    id: attrs.id || '',
    className: attrs.class || '',
    // The rect a drop is measured against. Handed in per element, because the layout
    // this mode reads is the browser's and a fake one is the test's business.
    rect: attrs.__rect || null,
    events: {},
    focused: false,
    value: '',
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    setAttribute: (k, v) => {
      el.attrs[k] = v;
      if (k === 'id') el.id = v;
    },
    removeAttribute: (k) => {
      delete el.attrs[k];
    },
    getBoundingClientRect: () => el.rect || { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
    addEventListener: (type, fn) => {
      (el.events[type] = el.events[type] || []).push(fn);
    },
    fire: (type, ev = {}) => {
      for (const fn of el.events[type] || []) fn({ target: el, ...ev });
    },
    focus: () => {
      el.focused = true;
    },
    blur: () => {
      el.focused = false;
      el.fire('blur');
    },
    matches: (sel) => matches(el, sel),
    contains: (node) => {
      for (let n = node; n; n = n.parentElement) if (n === el) return true;
      return false;
    },
    closest: (sel) => {
      for (let n = el; n; n = n.parentElement) if (n.nodeType === 1 && matches(n, sel)) return n;
      return null;
    },
    remove() {
      const at = el.parentElement?.children.indexOf(el);
      if (at !== undefined && at !== -1) el.parentElement.children.splice(at, 1);
      el.parentElement = null;
      el.isConnected = false;
    },
    appendChild(node) {
      node.parentElement = el;
      node.isConnected = true;
      el.children.push(node);
      return node;
    },
    querySelector(sel) {
      const walk = (node) => {
        for (const kid of node.children) {
          if (matches(kid, sel)) return kid;
          const deep = walk(kid);
          if (deep) return deep;
        }
        return null;
      };
      return walk(el);
    },
    get textContent() {
      return el.own + el.children.map((k) => k.textContent).join('');
    },
    set textContent(v) {
      el.own = String(v);
      el.children = [];
    },
    // Parsed only as far as finding the elements the module then goes looking for; the
    // markup itself is asserted as a string, which is what a person reads on the screen.
    set innerHTML(html) {
      el.html = html;
      el.children = [];
      for (const m of String(html).matchAll(/<(\w+)[^>]*?class="([^"]*)"([^>]*?)>([^<]*)(?=<|$)/g)) {
        const a = { class: m[2] };
        for (const one of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) a[one[1]] = one[2];
        if (/\bdisabled\b/.test(m[3])) a.disabled = 'disabled';
        if (/\bhidden\b/.test(m[3])) a.hidden = 'hidden';
        el.appendChild(makeEl(m[1], a, [], m[4]));
      }
    },
    get innerHTML() {
      return el.html || '';
    },
    classList: {
      add: (n) => {
        const set = new Set(String(el.className).split(/\s+/).filter(Boolean));
        set.add(n);
        el.className = [...set].join(' ');
        el.attrs.class = el.className;
      },
      remove: (n) => {
        const set = new Set(String(el.className).split(/\s+/).filter(Boolean));
        set.delete(n);
        el.className = [...set].join(' ');
        el.attrs.class = el.className;
      },
      toggle: (n, on) => (on ? el.classList.add(n) : el.classList.remove(n)),
      contains: (n) => String(el.className).split(/\s+/).includes(n),
    },
  };
  for (const kid of kids) kid.parentElement = el;
  if (attrs['data-key']) el.dataset.key = attrs['data-key'];
  return el;
}

/**
 * The page the gestures happen on.
 *
 * A card with a title in it drawn by a fixture "source" file, so an anchor resolves the
 * way it does against the real app: the chrome text is written once and is retypable, the
 * bead's title is what the payload is drawing and is not.
 */
const SOURCE = [
  'function drawCard(q) {',
  '  return `<div class="card" data-key="${q.key}">',
  '    <p class="q">${q.title}</p>',
  '    <button class="card-act" data-act="open">Show details</button>',
  '  </div>`;',
  '}',
].join('\n');

function page() {
  const title = makeEl('p', { class: 'q', __rect: { top: 100, bottom: 130, left: 0, right: 300, width: 300, height: 30 } }, [], 'A bead nobody wrote in source');
  const act = makeEl('button', { class: 'card-act', 'data-act': 'open', __rect: { top: 140, bottom: 180, left: 0, right: 300, width: 300, height: 40 } }, [], 'Show details');
  const card = makeEl(
    'div',
    { class: 'card', 'data-key': 'k1', __rect: { top: 90, bottom: 200, left: 0, right: 300, width: 300, height: 110 } },
    [title, act]
  );
  const kid = makeEl('p', { class: 'q', __rect: { top: 240, bottom: 270, left: 0, right: 300, width: 300, height: 30 } }, [], 'Another bead');
  const other = makeEl('div', { class: 'card', 'data-key': 'k2', __rect: { top: 220, bottom: 330, left: 0, right: 300, width: 300, height: 110 } }, [kid]);
  // The ✏️, because after the mode ends it is the only thing on the screen that can say
  // the pass is still there. See `sayButton`.
  const button = makeEl('button', { id: 'editmode' });
  const body = makeEl('body', {}, [card, other, button]);
  return { body, card, title, act, other, kid, button };
}

/**
 * Load the real module with a clock, capture listeners and a hit test the test drives.
 *
 * `post` is the daemon, for the Save half: called with the parsed body, it answers with
 * whatever `/api/edits` would have. Left out, a POST is a fetch to a URL the fixture does
 * not serve — which is a legitimate case in its own right and the one a phone on a dead
 * link hits.
 */
function load(dom = page(), { data = [], post = null } = {}) {
  const timers = new Map();
  let nextTimer = 1;
  let hit = () => null;
  const docEvents = {};
  const posted = [];
  const win = {
    beadcause: {},
    location: { pathname: '/' },
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, opts = {}) => {
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        posted.push({ url, body, headers: opts.headers || {} });
        if (!post) throw new Error('nothing is listening');
        const reply = await post(body, posted.length);
        return { ok: reply.status === undefined ? true : reply.status < 400, status: reply.status ?? 200, json: async () => reply.data };
      }
      const files = { '/': '<body></body>', '/app.js': SOURCE };
      const text = files[url];
      return text === undefined ? { ok: false } : { ok: true, text: async () => text };
    },
  };
  const document = {
    body: dom.body,
    scripts: [makeEl('script', { src: '/app.js' })],
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => (id === 'editmode' ? dom.button : null),
    addEventListener: (type, fn) => {
      (docEvents[type] = docEvents[type] || []).push(fn);
    },
    elementFromPoint: (x, y) => hit(x, y),
  };
  win.document = document;
  const ctx = vm.createContext({ window: win, document, Promise, JSON, Math, Map, Array, String, Boolean });
  vm.runInContext(read('public/editmode.js'), ctx, { filename: 'editmode.js' });
  const edit = ctx.window.beadcause.editMode;
  edit.provideText(() => data);
  const fire = (type, ev) => {
    for (const fn of docEvents[type] || []) fn(ev);
  };
  /** Run every timer that is due, in the order they were set. */
  const clock = () => {
    for (const [id, t] of [...timers]) {
      if (t.ran) continue;
      timers.delete(id);
      t.fn();
    }
  };
  const banner = () => dom.body.children.find((k) => k.className === 'editbar');
  const noteBox = () => dom.body.children.find((k) => k.className === 'editnote');
  const list = () => dom.body.children.find((k) => k.className === 'editlist');
  return {
    edit,
    ...dom,
    fire,
    clock,
    banner,
    noteBox,
    list,
    timers,
    docEvents,
    posted,
    setHit: (fn) => {
      hit = fn;
    },
  };
}

/** The three gestures, as a test performs them. */
const down = (h, el, x = 10, y = 110) => h.fire('pointerdown', { target: el, clientX: x, clientY: y });
const move = (h, el, x, y) => h.fire('pointermove', { target: el, clientX: x, clientY: y, preventDefault() {} });
const up = (h, el, x = 10, y = 110) => h.fire('pointerup', { target: el, clientX: x, clientY: y });
const hold = (h) => h.clock();

/** Type into the open note box and add it. */
function addNote(h, words) {
  const box = h.noteBox();
  const field = box.querySelector('[class="editnote-box"]');
  field.value = words;
  field.fire('input');
  box.querySelector('[data-act="edit-note-add"]').fire('click');
}

async function ready(h) {
  h.edit.on();
  await h.edit.ready();
  return h;
}

/* ======================================================== 1. one press, three ways */

const tap = await ready(load());
await check('a tap on text this app wrote makes it editable in place', () => {
  down(tap, tap.act);
  up(tap, tap.act);
  assert.equal(tap.act.getAttribute('contenteditable'), 'true', 'the text was not opened for retyping');
  assert.equal(tap.act.classList.contains('editretype'), true, 'nothing on screen says it is being retyped');
});

await check('and typing over it records the old string and the new one', () => {
  tap.act.own = 'Show the detail';
  tap.act.blur();
  const [one, ...rest] = tap.edit.changes();
  assert.equal(rest.length, 0, 'more than one change for one retype');
  assert.equal(one.kind, 'retype');
  assert.equal(one.from, 'Show details');
  assert.equal(one.to, 'Show the detail');
  // The anchor is the element as it was *before* the retype — an anchor carrying the new
  // words would name a line of source that does not say them.
  assert.equal(one.anchor.text.value, 'Show details');
  assert.equal(tap.act.getAttribute('contenteditable'), null, 'left editable after the edit');
});

await check('a retype that changes nothing is not an edit', async () => {
  const h = await ready(load());
  down(h, h.act);
  up(h, h.act);
  h.act.blur();
  assert.equal(h.edit.changes().length, 0);
});

await check('a tap on tracker text is refused, and says why in the banner', async () => {
  const h = await ready(load(page(), { data: ['A bead nobody wrote in source'] }));
  down(h, h.title);
  up(h, h.title);
  assert.equal(h.title.getAttribute('contenteditable'), null, 'a bead title was opened for retyping');
  assert.equal(h.edit.changes().length, 0);
  const said = h.banner().querySelector('[class="editbar-say"]').textContent;
  assert.match(said, /tracker/i, `the banner said "${said}"`);
});

await check('a tap on the box around the text asks for the text instead', async () => {
  const h = await ready(load());
  down(h, h.card);
  up(h, h.card);
  assert.equal(h.card.getAttribute('contenteditable'), null, 'a whole card was made editable');
  assert.match(h.banner().querySelector('[class="editbar-say"]').textContent, /the words themselves/i);
});

await check('a hold with no movement asks what it should do instead', async () => {
  const h = await ready(load());
  down(h, h.act);
  hold(h);
  assert.equal(h.act.classList.contains('editpick'), true, 'the element was not picked up');
  up(h, h.act);
  const box = h.noteBox();
  assert.ok(box, 'no note box after a hold');
  assert.match(box.innerHTML, /What should this do instead/);
  assert.equal(h.act.classList.contains('editpick'), false, 'left picked up after the note was asked for');
});

await check('and the sentence, with the element it is about, is the whole of that edit', async () => {
  const h = await ready(load());
  down(h, h.act);
  hold(h);
  up(h, h.act);
  addNote(h, 'this should say how many, not just that there are some');
  const [one] = h.edit.changes();
  assert.equal(one.kind, 'describe');
  assert.equal(one.note, 'this should say how many, not just that there are some');
  assert.equal(one.anchor.selector, 'div.card > button.card-act');
  assert.equal(one.from, undefined, 'a description carried a string it never had');
});

await check('a hold and a drag records a relationship, not a position', async () => {
  const h = await ready(load());
  h.setHit(() => h.other);
  down(h, h.act, 10, 150);
  hold(h);
  move(h, h.act, 10, 225);
  up(h, h.act, 10, 225);
  addNote(h, 'this belongs with the other one');
  const [one] = h.edit.changes();
  assert.equal(one.kind, 'point');
  assert.equal(one.where.rel, 'above', `dropped ${one.where.rel}`);
  assert.equal(one.where.target.selector, 'div.card');
  // Nothing in the record is a pixel. Nobody downstream could act on one: this app's
  // layout is a stylesheet and a template, and "100px down" is not a change to either.
  assert.equal(/\b\d+px\b/.test(JSON.stringify(one)), false, `${JSON.stringify(one.where)}`);
});

await check('a drop that leaves the card it came from says so', async () => {
  const h = await ready(load());
  h.setHit(() => h.other);
  down(h, h.act, 10, 150);
  hold(h);
  move(h, h.act, 10, 250);
  up(h, h.act, 10, 250);
  assert.match(h.noteBox().innerHTML, /out of/, 'the drop did not say it had left its card');
  assert.match(h.edit.relationAt(h.act, 10, 250).said, /^“Show details” out of “/);
});

await check('a drop on nothing at all is honest about it rather than guessing', async () => {
  const h = await ready(load());
  h.setHit(() => null);
  const where = h.edit.relationAt(h.act, 10, 700);
  assert.equal(where.rel, 'nowhere');
  assert.equal(where.target, null);
  assert.match(where.said, /nothing anchored/);
});

await check('a drop inside a container that holds things is inside it, not above it', async () => {
  const h = await ready(load());
  const where = h.edit.relationAt(h.act, 10, 260);
  h.setHit(() => h.other);
  assert.equal(h.edit.relationAt(h.act, 10, 275).rel, 'inside', JSON.stringify(where));
});

{
  const h = await ready(load());
  down(h, h.act);
  up(h, h.act);
  h.act.own = 'Half a thought';
  h.act.fire('keydown', { key: 'Escape' });
  await check('Escape abandons a retype, and the app keeps its own words', () => {
    assert.equal(h.act.textContent, 'Show details');
    assert.equal(h.edit.changes().length, 0);
    assert.equal(h.act.getAttribute('contenteditable'), null);
  });
}

{
  const h = await ready(load());
  down(h, h.act);
  up(h, h.act);
  h.act.own = 'Show one';
  h.act.fire('keydown', { key: 'Enter', preventDefault() {} });
  await check('and the keyboard`s own return key is what commits one', () => {
    // The only way out of an edit that does not mean something else: in this mode every
    // tap elsewhere is another gesture.
    assert.equal(h.edit.changes().length, 1);
    assert.equal(h.edit.changes()[0].to, 'Show one');
  });
}

/* ============================================== 2. the scroll this must not swallow */

await check('a thumb that moves before the hold fires is a scroll, and is left alone', async () => {
  const h = await ready(load());
  down(h, h.act, 10, 150);
  move(h, h.act, 12, 90);
  hold(h);
  up(h, h.act, 12, 90);
  assert.equal(h.noteBox(), undefined, 'a scroll opened the note box');
  assert.equal(h.act.getAttribute('contenteditable'), null, 'a scroll made something editable');
  assert.equal(h.act.classList.contains('editpick'), false, 'a scroll picked an element up');
  assert.equal(h.edit.changes().length, 0);
});

await check('and the scroll is only refused once a drag is genuinely under way', async () => {
  const h = await ready(load());
  let refused = 0;
  const touch = () => h.fire('touchmove', { target: h.act, preventDefault: () => (refused += 1) });
  down(h, h.act, 10, 150);
  touch();
  assert.equal(refused, 0, 'the list stopped scrolling before anything had been picked up');
  hold(h);
  touch();
  assert.equal(refused, 1, 'the page kept scrolling under a drag');
});

await check('an interrupted gesture puts the element down rather than stranding it', async () => {
  const h = await ready(load());
  down(h, h.act);
  hold(h);
  move(h, h.act, 40, 200);
  h.fire('pointercancel', { target: h.act });
  assert.equal(h.act.classList.contains('editpick'), false);
  assert.equal(h.act.style.transform, '', 'the element was left where the finger left it');
});

await check('the app`s own click never fires in the mode, and the mode`s own controls still do', async () => {
  const h = await ready(load());
  let stopped = 0;
  h.fire('click', { target: h.act, preventDefault() {}, stopPropagation: () => (stopped += 1) });
  assert.equal(stopped, 1, 'a tap in edit mode reached the card underneath');
  h.fire('click', { target: h.banner(), preventDefault() {}, stopPropagation: () => (stopped += 1) });
  assert.equal(stopped, 1, 'the banner`s own buttons were swallowed too');
});

await check('nothing is intercepted at all when the mode is off', async () => {
  const h = await ready(load());
  h.edit.off();
  let stopped = 0;
  h.fire('click', { target: h.act, preventDefault() {}, stopPropagation: () => (stopped += 1) });
  down(h, h.act);
  hold(h);
  up(h, h.act);
  assert.equal(stopped, 0, 'the app was still swallowing clicks after the mode ended');
  assert.equal(h.noteBox(), undefined);
  assert.equal(h.edit.changes().length, 0);
});

/* ================================================ 3. nothing may look like it saved */

await check('the dropped element is back where it was before the note is even asked for', async () => {
  const h = await ready(load());
  h.setHit(() => h.other);
  down(h, h.act, 10, 150);
  hold(h);
  move(h, h.act, 10, 250);
  assert.equal(h.act.style.transform, 'translate(0px, 100px)', 'the drag did not follow the thumb');
  up(h, h.act, 10, 250);
  assert.equal(h.act.style.transform, '', 'the element stayed where it was dropped');
  assert.equal(h.act.classList.contains('editdrag'), false);
  assert.match(h.noteBox().innerHTML, /snapped back/, 'the box does not say the screen is unchanged');
});

await check('and leaving the mode puts a retyped word back, keeping the record of it', async () => {
  const h = await ready(load());
  down(h, h.act);
  up(h, h.act);
  h.act.own = 'Show me';
  h.act.blur();
  assert.equal(h.act.textContent, 'Show me');
  assert.equal(h.act.classList.contains('editretyped'), true, 'a retyped word is not marked as unsaved');
  h.edit.off();
  assert.equal(h.act.textContent, 'Show details', 'the app was left saying what was typed over it');
  assert.equal(h.act.classList.contains('editretyped'), false);
  assert.equal(h.edit.changes().length, 1, 'leaving the mode threw the pass away');
  assert.equal(h.edit.changes()[0].to, 'Show me');
});

await check('the change list says outright that none of it has changed the app', async () => {
  const h = await ready(load());
  h.edit.showChanges(true);
  assert.match(h.list().innerHTML, /Nothing here has changed the app/);
});

/* ======================================= 4. a gesture with nothing said is not an edit */

await check('Add is refused while the box is empty', async () => {
  const h = await ready(load());
  down(h, h.act);
  hold(h);
  up(h, h.act);
  const box = h.noteBox();
  const add = box.querySelector('[data-act="edit-note-add"]');
  assert.equal(add.getAttribute('disabled'), 'disabled', 'a note with nothing in it could be filed');
  add.fire('click');
  assert.equal(h.edit.changes().length, 0, 'an empty note was filed anyway');
  const field = box.querySelector('[class="editnote-box"]');
  field.value = 'x';
  field.fire('input');
  assert.equal(add.getAttribute('disabled'), null, 'a note with words in it stayed refused');
});

await check('a point with no note is dropped, and takes its element back with it', async () => {
  const h = await ready(load());
  h.setHit(() => h.other);
  down(h, h.act, 10, 150);
  hold(h);
  move(h, h.act, 10, 250);
  up(h, h.act, 10, 250);
  h.noteBox().querySelector('[data-act="edit-note-cancel"]').fire('click');
  assert.equal(h.noteBox(), undefined, 'the note box stayed open');
  assert.equal(h.edit.changes().length, 0, 'a gesture with nothing said about it was filed');
  assert.equal(h.act.classList.contains('editsaid'), false);
  assert.equal(h.act.style.transform, '');
});

/* ================================================================= 5. the change list */

const pass = await ready(load());
await check('all three gestures land in one list, in the order they were made', () => {
  // A description...
  down(pass, pass.act);
  hold(pass);
  up(pass, pass.act);
  addNote(pass, 'first');
  // ...then a retype...
  down(pass, pass.act);
  up(pass, pass.act);
  pass.act.own = 'Show them';
  pass.act.blur();
  // ...then a point.
  pass.setHit(() => pass.other);
  down(pass, pass.title, 10, 110);
  hold(pass);
  move(pass, pass.title, 10, 250);
  up(pass, pass.title, 10, 250);
  addNote(pass, 'third');
  assert.equal(pass.edit.changes().map((c) => c.kind).join(','), 'describe,retype,point');
});

await check('the banner carries the count, and the list shows every one with a way out', () => {
  const chip = pass.banner().querySelector('[data-act="edit-list"]');
  assert.equal(chip.textContent, '3');
  assert.equal(chip.getAttribute('hidden'), null, 'the count stayed hidden over three changes');
  chip.fire('click');
  const html = pass.list().innerHTML;
  assert.match(html, /3 changes/);
  for (const c of pass.edit.changes()) assert.match(html, new RegExp(`data-drop="${c.id}"`), `no way to drop ${c.id}`);
  assert.match(html, /first/, 'the words of a description are not in the list');
});

await check('an entry can be dropped before saving, and dropping it undoes what it did', () => {
  const retype = pass.edit.changes().find((c) => c.kind === 'retype');
  assert.equal(pass.act.textContent, 'Show them');
  const rows = pass.list();
  // Through the ✕ on the row, which is how a thumb does it: one delegated listener on a
  // panel whose rows are rebuilt under it every time the list changes.
  rows.fire('click', { target: { closest: (sel) => (sel === '[data-drop]' ? { getAttribute: () => retype.id } : null) } });
  assert.equal(
    pass.edit.changes().map((c) => c.kind).join(','),
    'describe,point',
    'the entry is still in the list'
  );
  assert.equal(pass.act.textContent, 'Show details', 'the screen still says what the dropped entry asked for');
  assert.match(pass.list().innerHTML, /2 changes/);
});

await check('and the count goes with it, down to hidden at nothing left', () => {
  for (const c of pass.edit.changes()) pass.edit.dropChange(c.id);
  const chip = pass.banner().querySelector('[data-act="edit-list"]');
  assert.equal(chip.textContent, '0');
  assert.equal(chip.getAttribute('hidden'), 'hidden', 'an empty pass still offers a count');
  assert.match(pass.list().innerHTML, /Nothing yet/);
});

await check('the pass is told to whoever asked, every time it changes', async () => {
  const h = await ready(load());
  const seen = [];
  h.edit.onChanges((list) => seen.push(list.length));
  down(h, h.act);
  hold(h);
  up(h, h.act);
  addNote(h, 'something');
  const id = h.edit.changes()[0].id;
  h.edit.dropChange(id);
  assert.equal(seen.join(','), '1,0');
});

await check('the pass is JSON, and outlives the elements it describes', async () => {
  const h = await ready(load());
  down(h, h.act);
  hold(h);
  up(h, h.act);
  addNote(h, 'something');
  const list = h.edit.changes();
  // The record has to survive the page being thrown away — the mode's exit rebuilds the
  // whole list — so it may hold no reference into the document at all.
  assert.equal(JSON.stringify(list), JSON.stringify(JSON.parse(JSON.stringify(list))));
  h.act.remove();
  assert.equal(h.edit.changes()[0].anchor.selector, 'div.card > button.card-act');
});

await check('a copy of the pass is a copy — nobody outside can edit the list by holding it', async () => {
  const h = await ready(load());
  down(h, h.act);
  hold(h);
  up(h, h.act);
  addNote(h, 'something');
  h.edit.changes()[0].note = 'not what was said';
  assert.equal(h.edit.changes()[0].note, 'something');
});

await check('clearChanges is what Save takes: the list empty and the screen back', async () => {
  const h = await ready(load());
  down(h, h.act);
  up(h, h.act);
  h.act.own = 'Show me';
  h.act.blur();
  assert.equal(h.edit.changes().length, 1);
  h.edit.clearChanges();
  assert.equal(h.edit.changes().length, 0);
  assert.equal(h.act.textContent, 'Show details', 'the screen kept an edit that is no longer in the pass');
});

{
  const h = await ready(load());
  down(h, h.act);
  hold(h);
  up(h, h.act);
  addNote(h, 'something');
  await check('the marks this mode leaves are never part of an anchor', () => {
    // An element that has been pointed at is carrying this file's own classes. A second
    // anchor on it must not name one: `class="card-act editsaid"` appears nowhere in the
    // source that drew the element, so it would take the anchor from one site to none —
    // and put a class the app never wrote into the record an agent reads.
    assert.equal(h.act.classList.contains('editsaid'), true, 'the element is not marked at all');
    const anchor = h.edit.anchorFor(h.act);
    assert.equal(anchor.classes.includes('editsaid'), false, `classes: ${JSON.stringify(anchor.classes)}`);
    assert.equal(anchor.selector, 'div.card > button.card-act');
    assert.equal(anchor.source.found, 1, `${anchor.source.found} sites via ${anchor.source.query}`);
  });
}

{
  const h = await ready(load());
  down(h, h.act);
  hold(h);
  up(h, h.act);
  addNote(h, 'something');
  h.edit.off();
  await check('after the mode ends, the way back in says the pass is still there', () => {
    // The whole screen is back the way the app has it, which is the truth and is also
    // exactly what a save that failed would look like. The count on the ✏️ is the only
    // thing that tells those two apart once the banner has gone.
    assert.equal(h.button.getAttribute('data-changes'), '1');
    assert.match(h.button.getAttribute('aria-label'), /1 unsaved change/);
    h.edit.clearChanges();
    assert.equal(h.button.getAttribute('data-changes'), null, 'a count with nothing behind it');
    assert.equal(h.button.getAttribute('aria-label'), 'Edit this screen');
  });
}

/* ==================================================================== 6. the Save */

/**
 * The one write in the file, and every way it can go wrong without saying so.
 *
 * The change list is the only copy of what was said — the page it describes is gone the
 * moment the tab is, and none of it was ever written down anywhere else. So the whole of
 * this section is about which entries leave the list and when: an entry may only go
 * against an id the daemon has confirmed, and everything else stays to be saved again.
 * Filing something twice costs a duplicate bead somebody closes in a second; losing it
 * costs the thought.
 */

/** A pass of two edits — a retype and a describe — made the way a thumb makes them. */
async function twoEdits(opts = {}) {
  const h = await ready(load(page(), opts));
  down(h, h.act);
  up(h, h.act);
  h.act.own = 'Show me';
  h.act.blur();
  down(h, h.title);
  hold(h);
  up(h, h.title);
  addNote(h, 'this should say who is waiting');
  return h;
}

const filedReply = (body) => ({
  data: {
    ok: true,
    workspace: 'beadcause',
    root: { id: 'zz-1', made: false, from: 'label' },
    session: { id: 'zz-2', title: 'Edit pass on the inbox — 2 changes' },
    filed: body.changes.map((c, i) => ({ changeId: c.id, id: `zz-${i + 3}`, title: c.said })),
  },
});

await check('Save posts the whole pass once, and the list empties against what came back', async () => {
  const h = await twoEdits({ post: filedReply });
  h.edit.showChanges(true);
  // The rows are rebuilt on every change, so the panel takes the press and works out
  // what was under the thumb — the same delegation the ✕ on a row goes through.
  assert.match(h.list().innerHTML, /data-act="edit-save"/, 'there is no Save to press');
  h.list().fire('click', { target: { closest: (sel) => (sel === '[data-act="edit-save"]' ? {} : null) } });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(h.posted.length, 1, `${h.posted.length} posts for one press`);
  assert.equal(h.posted[0].url, '/api/edits');
  assert.equal(h.posted[0].body.changes.length, 2);
  assert.equal(h.edit.changes().length, 0, 'the pass survived being filed');
});

await check('and what it posts is the record, not the sentence — anchor, line and all', async () => {
  const h = await twoEdits({ post: filedReply, data: ['A bead nobody wrote in source'] });
  await h.edit.save();
  const [retype, describe] = h.posted[0].body.changes;
  assert.equal(retype.kind, 'retype');
  assert.equal(retype.from, 'Show details');
  assert.equal(retype.to, 'Show me');
  assert.equal(retype.anchor.source.sites[0].line, 4, `line ${retype.anchor.source.sites[0].line}`);
  assert.equal(describe.note, 'this should say who is waiting');
  assert.equal(describe.anchor.text.from, 'data', 'the anchor lost which side of the line it was on');
  assert.equal(h.posted[0].body.page, '/');
});

await check('the screen goes back as each filed edit leaves the list', async () => {
  // A retyped word still on the screen after its bead exists is the app claiming an edit
  // that has not been made — the same lie the mode spends the rest of its time avoiding.
  const h = await twoEdits({ post: filedReply });
  assert.equal(h.act.textContent, 'Show me');
  await h.edit.save();
  assert.equal(h.act.textContent, 'Show details', 'the screen kept an edit that is now a bead');
  assert.equal(h.title.classList.contains('editsaid'), false);
});

await check('a daemon that refuses keeps the pass, and says so rather than going quiet', async () => {
  const h = await twoEdits({ post: () => ({ status: 502, data: { error: 'the tracker said no' } }) });
  const out = await h.edit.save();
  assert.equal(out.ok, false);
  assert.equal(h.edit.changes().length, 2, 'the pass was lost to a failed save');
  h.edit.showChanges(true);
  assert.match(h.list().innerHTML, /Nothing was filed: the tracker said no/);
  assert.match(h.list().innerHTML, /still here/);
});

await check('a dead link is the same answer — nothing filed, nothing lost', async () => {
  const h = await twoEdits(); // no daemon at all
  const out = await h.edit.save();
  assert.equal(out.ok, false);
  assert.equal(h.edit.changes().length, 2);
});

await check('a half-filed pass drops exactly what landed and keeps the rest', async () => {
  // The failure that matters: two beads exist and one does not. Dropping all three would
  // lose an edit; keeping all three files two of them a second time.
  const h = await twoEdits({
    post: (body) => ({
      status: 502,
      data: { error: 'filed 1 of 2: the tracker said no', filed: [{ changeId: body.changes[0].id, id: 'zz-3' }] },
    }),
  });
  const out = await h.edit.save();
  assert.equal(out.ok, false);
  assert.equal(h.edit.changes().length, 1, `${h.edit.changes().length} left`);
  assert.equal(h.edit.changes()[0].kind, 'describe', 'the wrong entry was kept');
  h.edit.showChanges(true);
  assert.match(h.list().innerHTML, /Filed 1, then stopped/);
});

await check('a second press while one is in flight files nothing twice', async () => {
  // Two passes, each a whole session bead with the same edits under it, is what a double
  // tap on a phone would otherwise buy.
  let release = null;
  const h = await twoEdits({ post: (body) => new Promise((res) => (release = () => res(filedReply(body)))) });
  const first = h.edit.save();
  assert.equal(h.edit.saving(), true);
  assert.equal(await h.edit.save(), null, 'a second Save went out under the first');
  release();
  await first;
  assert.equal(h.posted.length, 1);
});

await check('and Save is offered only when there is something to save', async () => {
  const h = await ready(load(page(), { post: filedReply }));
  h.edit.showChanges(true);
  const btn = () => h.list().querySelector('[data-act="edit-save"]');
  assert.equal(btn().getAttribute('disabled'), 'disabled', 'Save is live over an empty pass');
  assert.equal(await h.edit.save(), null);
  assert.equal(h.posted.length, 0);
});

await check('the foot says nothing is real yet, and afterwards says what was filed', async () => {
  const h = await twoEdits({ post: filedReply });
  h.edit.showChanges(true);
  assert.match(h.list().innerHTML, /Nothing here has changed the app yet/);
  await h.edit.save();
  assert.match(h.list().innerHTML, /Filed as zz-2/);
  assert.match(h.list().innerHTML, /under zz-1/);
});

await check('where in the app it was said is stamped per edit, not per pass', async () => {
  // The inbox is four filters deep and a pass can cross them. An agent acting on the
  // second edit needs the screen the second edit was said on.
  const h = await ready(load(page(), { post: filedReply }));
  let showing = 'what is waiting on you';
  h.edit.provideContext(() => ({ view: 'the inbox', showing }));
  down(h, h.act);
  hold(h);
  up(h, h.act);
  addNote(h, 'first');
  showing = 'both';
  down(h, h.title);
  hold(h);
  up(h, h.title);
  addNote(h, 'second');
  const [one, two] = h.edit.changes();
  assert.equal(one.context.showing, 'what is waiting on you');
  assert.equal(two.context.showing, 'both');
  await h.edit.save();
  assert.equal(h.posted[0].body.view, 'the inbox', 'the pass does not say which surface it was');
});

await check('a page that provides no context at all still files', async () => {
  const h = await twoEdits({ post: filedReply });
  assert.equal(h.edit.changes()[0].context, null);
  assert.equal((await h.edit.save()).ok, true);
});

/* ============================================================ 7. what the page needs */

const CSS = read('public/style.css');
const MODULE = read('public/editmode.js');

await check('every class the gestures put on an element is drawn by the stylesheet', () => {
  // A state of the conversation nobody can see is one nobody knows they are in — a
  // picked-up element that looks exactly like a resting one is the whole gesture
  // vocabulary invisible.
  for (const cls of ['editpick', 'editdrag', 'editretype', 'editretyped', 'editsaid', 'editnote', 'editlist', 'editlist-save', 'editbar-count']) {
    assert.match(CSS, new RegExp(`\\.${cls}[\\s,{:]`), `no rule for .${cls}`);
  }
  assert.match(CSS, /\.editmode\[data-changes\]/, 'the ✏️ has no badge to carry the pass on');
});

await check('and the note box and the list sit above the banner, not under it', () => {
  // The banner is z-index 45 and an open card is 40. A question raised by a gesture and
  // drawn underneath either is a question nobody can answer.
  const zOf = (cls) => Number((CSS.match(new RegExp(`\\.${cls}\\s*\\{[^}]*z-index:\\s*(\\d+)`)) || [])[1]);
  assert.ok(zOf('editnote') > 45, `.editnote is at ${zOf('editnote')}`);
  assert.ok(zOf('editlist') > 45, `.editlist is at ${zOf('editlist')}`);
  assert.ok(zOf('editnote') >= zOf('editlist'), 'the note box is under the list it came from');
});

await check('there is one write in this file, and only a press reaches it', () => {
  // The line that matters when this file grows: a *gesture* that wrote to the tracker as
  // it was made would file half a pass, with no review and no way back. So there is
  // exactly one URL in here, it is Save's, and nothing else posts anywhere.
  const code = MODULE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/\/api\/(file|bead|ask|propose)/.test(code), false, 'edit mode is filing beads by itself');
  assert.deepEqual([...code.matchAll(/'\/api\/[\w/-]+'/g)].map((m) => m[0]), ["'/api/edits'"]);
  assert.deepEqual([...code.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1]), ['POST']);
});

console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall ${ran} good\n`);
process.exit(failures ? 1 : 0);
