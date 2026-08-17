#!/usr/bin/env node
/**
 * The filters that are not behind anything, and the scope that is the first of them.
 *
 *     npm test
 *     node test/filterpills.mjs
 *
 * `Human / Both / Agent` decides which sweep runs — so it decides whether Home holds the
 * questions, the live beads nobody is asking you about, or both. It is the most
 * consequential control on the page and it spent its life as the `Show` group inside a
 * collapsing panel, which is a control nobody can see and therefore one nobody remembers
 * is set: the empty screens this epic is about are mostly a scope somebody set last week.
 * bc-khoe.24 brings it out onto the chrome as a segmented switch, drawn by
 * public/filterpills.js.
 *
 * Five things are worth a suite and none of them is visible by reading one function:
 *
 * 1. **The armed scope has to be legible without opening anything.** Which is a claim
 *    about a row of chips with one pressed, and about where that row is: the check drives
 *    the real file and asserts the chips exist the moment it is mounted, with no open,
 *    no hover and no tap first.
 *
 * 2. **A tap has to reach `chooseScope`.** The switch moved container; what it does must
 *    not have moved with it — the refetch, the dropped selections and the stored
 *    preference are all on the far side of the group's own `pick`, which is why the check
 *    is that `pick` is called with the id and that the armed chip follows.
 *
 * 3. **A repaint must not rebuild the row.** The inbox repaints every 25 seconds. A row
 *    rebuilt on that clock drops the focus ring off a chip somebody is tabbing through
 *    and swaps a chip out from under a pointer on the way to it — the same failure
 *    test/inboxkinds.mjs pins for the panel, and the same discipline answers it.
 *
 * 4. **The group descriptor has to be the one filtermenu.js takes.** bc-khoe.26 moves the
 *    rest of the panel out onto this row, and a group that had to be rewritten to move
 *    would make the two containers drift into meaning different things by `on` and `all`.
 *    So the check mounts the *same object shape* the panel is given, and the two shapes
 *    the row deliberately refuses — a `text` group — are asserted to be refused loudly
 *    rather than drawn wrong.
 *
 * 5. **The wiring on disk.** A control this file draws perfectly and no page loads is a
 *    control nobody has. index.html, app.js, sw.js and the stylesheet are all read.
 *
 * The file runs in a vm with a hand-made document, the way test/inboxkinds.mjs runs the
 * inbox's filter: it builds its DOM with createElement and holds the nodes it made, so
 * there is no innerHTML to parse and no selector engine to fake.
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

/** Just enough of an element: children, attributes, classes, text and listeners. */
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
  }
  classes() {
    return String(this.className || '').split(/\s+/).filter(Boolean);
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
  prepend(...nodes) {
    for (const n of nodes) n.parent = this;
    this.children = [...nodes, ...this.children];
  }
  replaceChildren(...nodes) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
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
}

function makeDoc() {
  const doc = { createElement: (tag) => new El(tag) };
  return doc;
}

/**
 * The real file, in a room with a document in it.
 *
 * `warned` catches the one thing this row says out loud: a group it will not draw. It is
 * a spy rather than a swallow because the whole point of refusing a text group is that
 * somebody hears about it — a silent refusal is a filter the page believes it drew.
 */
function load() {
  const doc = makeDoc();
  const warned = [];
  const window = {};
  const ctx = vm.createContext({
    window,
    document: doc,
    console: { ...console, warn: (m) => warned.push(String(m)) },
  });
  vm.runInContext(read('public/filterpills.js'), ctx, { filename: 'filterpills.js' });
  const host = new El('nav');
  host.hidden = true;
  return { pills: ctx.window.beadcause.filterPills, doc, host, warned };
}

/** The scope group as public/app.js writes it — the same three chips, same notes. */
function scopeGroup(state) {
  const CHIPS = [
    ['human', 'Human', 'Beads labelled human — the ones asking you something. This is the inbox.'],
    ['both', 'Both', 'Questions first, then every bead that is open, claimed or blocked.'],
    ['agent', 'Agent', 'Only what the agents are on: every live bead that is not a question.'],
  ];
  return {
    id: 'scope',
    legend: 'Show',
    all: 'Everything',
    options: () => CHIPS.map(([id, label, note]) => ({ id, label, note, on: state.scope === id })),
    pick: (id) => {
      state.picked.push(id);
      state.scope = id;
    },
  };
}

/** Mount the switch, the way public/app.js does. */
function mounted(extra = {}) {
  const room = load();
  const state = { scope: 'human', picked: [], ...extra };
  const group = scopeGroup(state);
  const root = room.pills.mount(room.host, { groups: [group] });
  const row = root?.children[0];
  const chip = (id) => row.children.find((c) => c.dataset.chip === id);
  return { ...room, state, group, root, row, chip };
}

const pressed = (row) => row.children.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.chip);

/* ------------------------------------------------------------- on the chrome */

console.log('\nthe switch, without opening anything');

await check('three chips, drawn the moment it is mounted', () => {
  const { row } = mounted();
  assert.deepEqual(row.children.map((c) => c.dataset.chip), ['human', 'both', 'agent']);
  assert.deepEqual(row.children.map((c) => c.textContent), ['Human', 'Both', 'Agent']);
  // Nothing was opened, hovered or tapped to get here. That is the bead.
  assert.equal(row.hidden, false);
});

await check('the armed one says so, and it is the only one', () => {
  const { row } = mounted();
  assert.deepEqual(pressed(row), ['human']);
});

await check('the row unhides the nav it is drawn in', () => {
  // `#filters` is `hidden` in the markup so a page that loads neither control has no
  // empty band of padding above the list. Either control mounting is enough to earn it.
  const { host } = mounted();
  assert.equal(host.hidden, false);
});

await check('it is a segmented switch, not a menu — the class the stylesheet bands', () => {
  const { root, row } = mounted();
  assert.ok(root.classes().includes('filterpills'), `root is ${root.className}`);
  assert.deepEqual(row.classes(), ['chip-row', 'scopes']);
  assert.equal(row.getAttribute('role'), 'group');
  // The legend was a line of its own inside the panel. Out here it is the accessible
  // name and nothing visible — see the header of public/filterpills.js.
  assert.equal(row.getAttribute('aria-label'), 'Show');
  assert.equal(row.textContent.includes('Show'), false, 'the legend is drawn as chrome');
});

await check('every chip carries a note — one word is not self-explanatory', () => {
  const { row } = mounted();
  for (const c of row.children) {
    assert.ok(c.title, `${c.dataset.chip} has no hover title`);
    assert.ok(c.getAttribute('aria-label')?.includes('—'), `${c.dataset.chip} has no note`);
    assert.ok(['true', 'false'].includes(c.getAttribute('aria-pressed')), `${c.dataset.chip} is not a toggle`);
  }
});

await check('it goes in front of a panel already in the nav', () => {
  // public/filtermenu.js mounts with `replaceChildren`, so the pills are mounted second
  // and prepend themselves. The scope decides what the panel behind it is even
  // filtering, so it leads — and getting this backwards is silent, because both
  // controls draw perfectly either way round.
  const room = load();
  const panel = room.doc.createElement('div');
  panel.className = 'filter-menu';
  room.host.replaceChildren(panel);
  room.pills.mount(room.host, { groups: [scopeGroup({ scope: 'both', picked: [] })] });
  assert.deepEqual(room.host.children.map((c) => c.className), ['filterpills', 'filter-menu']);
});

/* ------------------------------------------------------------------ the tap */

console.log('\ntapping it');

await check('a tap reaches the group, with the id it was drawn from', () => {
  const { chip, state } = mounted();
  chip('agent').fire('click');
  assert.deepEqual(state.picked, ['agent']);
});

await check('and the armed chip follows without anything else repainting', () => {
  const { row, chip } = mounted();
  chip('both').fire('click');
  assert.deepEqual(pressed(row), ['both']);
});

await check('tapping the armed one is still a tap — the group decides, not the row', () => {
  // `chooseScope` is what makes already-there a no-op, and it is the only place that
  // rule can live: the row cannot know that re-arming costs a refetch.
  const { chip, state } = mounted();
  chip('human').fire('click');
  assert.deepEqual(state.picked, ['human']);
});

await check('the scope survives a group that repaints from underneath the tap', () => {
  // `chooseScope` calls back into `paintScope`, which paints this row — so the handler
  // paints a row that has already been painted. Doing it twice must not double a chip.
  const room = load();
  const state = { scope: 'human', picked: [] };
  const group = scopeGroup(state);
  const inner = group.pick;
  group.pick = (id) => {
    inner(id);
    room.pills.paint();
  };
  const root = room.pills.mount(room.host, { groups: [group] });
  const row = root.children[0];
  row.children.find((c) => c.dataset.chip === 'agent').fire('click');
  assert.equal(row.children.length, 3);
  assert.deepEqual(pressed(row), ['agent']);
});

/* --------------------------------------------------------------- the repaint */

console.log('\nthe 25-second repaint');

await check('a repaint moves the pressed state without replacing the chip under the pointer', () => {
  const { pills, row, state } = mounted();
  const before = row.children[1];
  state.scope = 'both';
  pills.paint();
  assert.equal(row.children[1], before, 'the row was rebuilt on a repaint');
  assert.deepEqual(pressed(row), ['both']);
});

await check('a group whose options actually changed is rebuilt, once', () => {
  const room = load();
  let ids = ['human', 'both'];
  const group = {
    id: 'scope',
    legend: 'Show',
    options: () => ids.map((id) => ({ id, label: id, on: id === 'human' })),
    pick: () => {},
  };
  const row = room.pills.mount(room.host, { groups: [group] }).children[0];
  assert.equal(row.children.length, 2);
  ids = ['human', 'both', 'agent'];
  room.pills.paint();
  assert.deepEqual(row.children.map((c) => c.dataset.chip), ['human', 'both', 'agent']);
  const held = row.children[2];
  room.pills.paint();
  assert.equal(row.children[2], held, 'an unchanged set of ids rebuilt anyway');
});

await check('a group can take itself off the row, and come back', () => {
  // Nothing uses this today — the scope has no scope in which it is dead. bc-khoe.26
  // does: a PR status pill over My Epics is a control that does nothing.
  const room = load();
  let usable = true;
  const group = {
    id: 'scope',
    legend: 'Show',
    hidden: () => !usable,
    options: () => [{ id: 'human', label: 'Human', on: true }],
    pick: () => {},
  };
  const row = room.pills.mount(room.host, { groups: [group] }).children[0];
  assert.equal(row.hidden, false);
  usable = false;
  room.pills.paint();
  assert.equal(row.hidden, true);
  usable = true;
  room.pills.paint();
  assert.equal(row.hidden, false);
});

await check('armed() answers what is on screen', () => {
  const { pills, chip } = mounted();
  assert.equal(pills.armed('scope'), 'human');
  chip('agent').fire('click');
  assert.equal(pills.armed('scope'), 'agent');
  assert.equal(pills.armed('nobody'), '');
});

/* ------------------------------------------------------- the group descriptor */

console.log('\nthe same group the panel takes');

await check('a text group is refused, and says so', () => {
  // The bead search. It needs a dropdown under it, which is a panel's shape — drawing
  // half of it out here would be a filter the page believes it has and has not.
  const room = load();
  const root = room.pills.mount(room.host, {
    groups: [{ id: 'bead', legend: 'Bead', text: true, options: () => [], pick: () => {} }],
  });
  assert.equal(root, null, 'a text group was drawn as chips');
  assert.equal(room.warned.length, 1, `warnings: ${room.warned.join(' / ')}`);
  assert.match(room.warned[0], /bead/);
});

await check('a group missing its two verbs is dropped rather than thrown over', () => {
  const room = load();
  assert.equal(room.pills.mount(room.host, { groups: [{ id: 'half' }, null] }), null);
  assert.equal(room.host.children.length, 0);
  assert.equal(room.host.hidden, true, 'an empty row unhid the nav anyway');
});

await check('no host, no groups, no row — and no throw either', () => {
  const room = load();
  assert.equal(room.pills.mount(null, { groups: [] }), null);
  assert.equal(room.pills.mount(room.host, {}), null);
  room.pills.paint();
});

await check('two groups are two rows, in the order they were handed over', () => {
  // bc-khoe.26's shape, pinned before it is needed: the row is a list of groups, not a
  // rule about the one in it.
  const room = load();
  const g = (id) => ({ id, legend: id, options: () => [{ id: 'a', label: 'A', on: true }], pick: () => {} });
  const root = room.pills.mount(room.host, { groups: [g('scope'), g('status')] });
  assert.deepEqual(root.children.map((c) => c.dataset.group), ['scope', 'status']);
  assert.deepEqual(root.children.map((c) => c.className), ['chip-row scopes', 'chip-row statuss']);
});

/* --------------------------------------------------------------- the wiring */

console.log('\nthe page has to actually load it');

await check('index.html loads it, after the panel and before app.js', () => {
  const html = read('public/index.html');
  const mine = html.indexOf('<script src="/filterpills.js">');
  assert.ok(mine > 0, 'index.html does not load /filterpills.js');
  assert.ok(mine > html.indexOf('<script src="/filtermenu.js">'), 'the pills load before the panel they sit in front of');
  assert.ok(mine < html.indexOf('<script src="/app.js">'), 'app.js runs before the file it mounts');
});

await check('app.js hands it the scope, and the panel no longer gets it', () => {
  const app = read('public/app.js');
  assert.match(app, /filterPills\?\.mount\?\.\(filtersEl, \{ groups: \[scopeGroup\] \}\)/, 'the scope is not on the row');
  assert.doesNotMatch(app, /groups: \[scopeGroup, beadGroup\]/, 'the scope is still a group inside the panel');
  assert.match(app, /f\?\.mount\(filtersEl, \{\n\s*groups: \[beadGroup\],/, 'the panel is not down to the bead box');
});

await check('and a scope tap still repaints both controls', () => {
  // The panel's summary line is drawn from the groups it has, and losing the scope did
  // not lose the line — it still has to keep up with a tap that clears the list.
  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('function paintScope()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /filterPills\?\.paint\?\.\(\)/);
  assert.match(body, /inboxFilter\?\.paint\?\.\(\)/);
});

await check('chooseScope is untouched — the switch moved, what it does did not', () => {
  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('function chooseScope(next)'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /if \(!SCOPES\.includes\(next\) \|\| next === state\.scope\) return;/, 'already-there is no longer a no-op');
  assert.match(body, /localStorage\.setItem\('beadcause\.scope'/, 'the scope no longer survives a reload');
  assert.match(body, /surveyKinds\(\[\]\)/, 'a selection the new scope cannot produce is no longer dropped');
  assert.match(body, /load\(\);/, 'the tap no longer refetches');
});

await check('the scope is still this device’s preference, and nothing else can read it', () => {
  // The acceptance the bead is most easily broken on: changing scope must not change
  // what rings the phone. The push path is the daemon's (`quietReasonFor` in
  // lib/spaces.js), and it cannot read a key that exists in one browser file.
  const readers = ['lib', 'bin', 'public']
    .flatMap((dir) =>
      fs
        .readdirSync(path.join(ROOT, dir))
        .filter((f) => f.endsWith('.js'))
        .filter((f) => read(`${dir}/${f}`).includes('beadcause.scope'))
        .map((f) => `${dir}/${f}`)
    );
  assert.deepEqual(readers, ['public/app.js'], `readers of the stored scope: ${readers.join(', ')}`);
});

await check('the service worker ships it, on a version a cached phone will notice', () => {
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/filterpills.js'"), 'not in SHELL');
  const version = /const CACHE = 'beadcause-v(\d+)'/.exec(sw)?.[1];
  assert.ok(version, 'no cache version at all');
  assert.ok(
    fs.existsSync(path.join(ROOT, 'docs/sw-cache', `v${version}.md`)),
    `docs/sw-cache/v${version}.md does not exist — the bump has no argument`
  );
  assert.ok(Number(version) >= 75, `v${version} predates the pill, so a cached page has no tag for it`);
});

await check('the stylesheet draws the row, and does not clip the panel beside it', () => {
  const css = read('public/style.css');
  assert.match(css, /\.filterpills \{/, 'the row has no rule');
  // The trap worth pinning: `.filters` holds an absolutely positioned panel, and a
  // scroll container on either axis makes the other one `auto` too — so an `overflow`
  // here would clip the panel to the height of the line it hangs off.
  const block = css.slice(css.indexOf('\n.filters {'));
  assert.doesNotMatch(block.slice(0, block.indexOf('}')), /overflow/, '.filters became a scroll container');
  assert.match(css, /\.chip-row\.scopes \{[^}]*flex-wrap: nowrap/, 'the switch can break across two lines');
  // The one thing the move broke, and it only shows in a browser: the panel is 260px
  // wide and positioned against a `.filter-menu` the switch has pushed to x=240 on a
  // 360px phone, so left-anchored it runs off the side of the screen. Measured before
  // and after in a headless Chrome at 360×640 — 240..500 against a 360px viewport, and
  // 84..344 with this rule.
  assert.match(css, /#filters \.filter-panel \{[^}]*right: 0/, 'the open panel hangs off the right of a phone');
});

await check('the README says the scope is a control you can see — it is this repo’s spec', () => {
  const readme = read('README.md');
  assert.match(readme, /filterpills\.js/, 'the file is not in the README');
});

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
