#!/usr/bin/env node
/**
 * A P0 card summarises collapsed and shows its tree expanded.
 *
 *     npm test
 *     node test/p0card.mjs
 *
 * bc-rfnr.9.2. The server has carried each card's whole descendant tree since bc-rfnr.9.1
 * — flat, pre-order, a `depth` on every row — and this is the half that draws it. Six
 * things about that are worth a suite, and four of them fail quietly:
 *
 * 1. **What is open is page state, not DOM state.** The board is one reconcile chunk
 *    keyed `@p0` (`warm.paint` replaces it whole whenever any count on it moves), so an
 *    `open` attribute on a `<details>` or a `hidden` toggled on a node is gone at the
 *    next 25-second poll with the tree folding up under your thumb. `state.p0open` is
 *    the only record, and the renderer is a pure function of it — which is what makes a
 *    repaint redraw exactly what was open. Asserted by rendering twice from the same
 *    state and by reading the tap handler, because the failure is invisible in a single
 *    render: the tree is there both ways, and only the *second* one is wrong.
 *
 * 2. **The indent is capped.** This tracker nests six deep (bc-rfnr.9.2.1 is a great-
 *    grandchild), a phone is 360px wide and a bead title needs most of them. A step per
 *    level would have the sixth generation's titles off the right edge — and an element
 *    wider than the screen does not scroll under mobile emulation, it shrink-fits the
 *    whole page, so the failure lands on every other card too. The cap is checked at the
 *    two depths either side of it and at the depth beyond.
 *
 * 3. **A P0 with nothing under it expands to a sentence.** An epic nobody has broken
 *    down yet is the likeliest card on the board to be tapped, and a tap opening a blank
 *    gap reads as a tree that failed to arrive — a bug report about the poll, where the
 *    truth is that nothing has been filed.
 *
 * 4. **One card opens at a time only because one key was tapped.** The set is keyed by
 *    `workspace/id`; a renderer that fell back to a shared or missing key would open and
 *    close all four of the week's epics together, which reads as a fault in the tap.
 *
 * 5. **A bead that is itself a question is marked.** `pending` is the whole reason to
 *    open a tree, and bc-rfnr.9.7 removes the flat list that draws those questions today.
 *
 * 6. **Tracker text cannot write markup into the board.** A bead title is text out of
 *    `bd`; the escaped form is asserted present, not merely the raw tag absent.
 *
 * 7. **The section itself folds, and folding it must not lose anything** (bc-eevn). Three
 *    ways that goes wrong and none of them throws: the shut line drops the count, so a
 *    folded board is indistinguishable from a screen with no epics on it; the fold reaches
 *    into `state.p0open` and closes the tree you were reading; or it reaches the list
 *    underneath, and hiding a display quietly empties the inbox. The direction of the flag
 *    is checked too — it is stored shut-side-true so that every default there has ever
 *    been, including a state object written before the field existed, reads as open.
 *
 * No browser, no `bd`, no network. The renderers touch no DOM — they return a string —
 * so they are sliced out of public/app.js and run in a `node:vm` with the four helpers
 * they borrow. See test/jirarow.mjs, whose `lift` this is.
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
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const APP = read('public/app.js');
const CSS = read('public/style.css');

/**
 * One P0 with a tree six deep — the shape `p0Card` in lib/server.js sends, and the shape
 * test/p0tree.mjs proves it sends. Depths 1..5 on purpose: 4 and 5 are the two that a
 * cap has to flatten and 3 is the last one that still steps.
 */
const CARD = {
  key: 'beadcause/bc-rfnr',
  workspace: 'beadcause',
  id: 'bc-rfnr',
  title: 'The inbox is a P0 board',
  status: 'open',
  issue_type: 'epic',
  open: 4,
  inFlight: 1,
  waitingOn: null,
  tree: [
    { id: 'bc-rfnr.9', title: 'A P0 card is the board', status: 'open', parent: 'bc-rfnr', depth: 1, key: 'beadcause/bc-rfnr.9', pending: false },
    { id: 'bc-rfnr.9.2', title: 'The card summarises collapsed', status: 'in_progress', parent: 'bc-rfnr.9', depth: 2, key: 'beadcause/bc-rfnr.9.2', pending: false },
    { id: 'bc-rfnr.9.2.1', title: 'Which way should the caret point?', status: 'open', parent: 'bc-rfnr.9.2', depth: 3, key: 'beadcause/bc-rfnr.9.2.1', pending: true },
    { id: 'bc-rfnr.9.2.1.1', title: 'A fourth level, indented', status: 'open', parent: 'bc-rfnr.9.2.1', depth: 4, key: 'beadcause/bc-rfnr.9.2.1.1', pending: false },
    { id: 'bc-rfnr.9.2.1.1.1', title: 'A fifth, already landed', status: 'closed', parent: 'bc-rfnr.9.2.1.1', depth: 5, key: 'beadcause/bc-rfnr.9.2.1.1.1', pending: false },
  ],
};

/** A second P0, so "one card opens" is a claim about a board rather than about a card. */
const OTHER = {
  key: 'beadcause/bc-p49x',
  workspace: 'beadcause',
  id: 'bc-p49x',
  title: 'The app is the thing you point at',
  status: 'open',
  open: 1,
  inFlight: 0,
  waitingOn: 'the amendment queue',
  tree: [{ id: 'bc-p49x.4', title: 'A worker turns an edit bead into a branch', status: 'open', parent: 'bc-p49x', depth: 1, key: 'beadcause/bc-p49x.4', pending: false }],
};

/**
 * Lift one declaration out of public/app.js — test/jirarow.mjs's, unchanged.
 *
 * Two shapes: a `function` ends at its balanced closing brace, a `const` ends at the
 * first `;` outside every bracket. Nothing tracks strings, which is sound over these
 * declarations and unsound in general — and it does not fail quietly, because the slice
 * stops parsing and this suite goes red naming the line.
 */
function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  if (opener.startsWith('function')) {
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (!depth) return src.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener}`);
  }
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${opener}`);
}

/**
 * The board, drawn for real, out of a page state you hand it.
 *
 * `p0open` is a Set of card keys exactly as the page holds one, and rendering is the
 * whole of what the tap does — so calling this twice with the same `open` list is a
 * faithful stand-in for the poll repaint that the feature has to survive.
 */
function board(p0s, open = [], shut = false) {
  const state = {
    p0board: { owned: true, p0s, under: {} },
    p0open: new Set(open),
    p0shut: shut,
    space: 'all',
    workspace: 'all',
    spaces: [],
    p0opening: new Map(),
  };
  const context = vm.createContext({ String, Number, Math, JSON, Date, encodeURIComponent, state });
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'const cardId = ('),
      lift(APP, 'const spaceForWorkspace = ('),
      lift(APP, 'const STATUS_LABEL = '),
      lift(APP, 'function graphUrl(q)'),
      lift(APP, 'const P0_INDENT_CAP = '),
      lift(APP, 'const P0_SECTION_LABEL = '),
      lift(APP, 'function p0HintText(on, total)'),
      lift(APP, 'function p0RowHtml(card, row)'),
      lift(APP, 'function p0TreeHtml(card)'),
      // bc-d6yk's three-state control, which the acts row now calls rather than writing
      // a launch button by hand — and the local "just launched" note it reads.
      lift(APP, 'function openingHere(key)'),
      lift(APP, 'function p0Control(c)'),
      lift(APP, 'function p0SectionHtml()'),
      'p0SectionHtml();',
    ].join('\n'),
    context
  );
  return vm.runInContext('p0SectionHtml()', context);
}

/** The indent step written on a row, by bead id — `--d:<n>` off the inline style. */
function indentOf(html, id) {
  const at = html.indexOf(`>${id}<`);
  assert.notEqual(at, -1, `no row for ${id}`);
  const before = html.slice(0, at);
  const m = /--d:(\d+)/g;
  let last = null;
  let hit;
  while ((hit = m.exec(before))) last = hit[1];
  assert.notEqual(last, null, `no --d on the row for ${id}`);
  return Number(last);
}

console.log('\nthe collapsed card');

check('summarises: id, both counts, title, and how much is behind the tap', () => {
  const html = board([CARD]);
  assert.match(html, /bc-rfnr/);
  assert.match(html, /4 open/);
  assert.match(html, /1 in flight/);
  assert.match(html, /The inbox is a P0 board/);
  // The total, which is the number the open count cannot give you: 4 of 5 left.
  assert.match(html, /Tap for all 5 beads under it/);
});

check('draws no tree at all, and none of its beads', () => {
  const html = board([CARD]);
  assert.ok(!html.includes('p0-tree'), 'a collapsed card is carrying a tree');
  assert.ok(!html.includes('bc-rfnr.9.2.1'), 'a collapsed card is drawing its descendants');
  assert.match(html, /aria-expanded="false"/);
});

check('the tap target is a button, so Enter and a screen reader work', () => {
  const html = board([CARD]);
  assert.match(html, /<button type="button" class="p0-tap" data-act="p0" data-p0="beadcause\/bc-rfnr"/);
});

check('waitingOn is drawn when the advocate has written one, and nothing when not', () => {
  assert.ok(!board([CARD]).includes('p0-waiting'), 'a card with no sentence drew the line anyway');
  assert.match(board([OTHER]), /class="p0-waiting">the amendment queue/);
});

check('the graph is still one tap away, now that the summary is the control', () => {
  const html = board([CARD]);
  assert.match(html, /class="p0-graph" href="\/graph\?ws=beadcause&amp;id=bc-rfnr&amp;open=1"/);
  // And the advocate button is untouched — bc-rfnr.2's one control on the card.
  assert.match(html, /data-act="advocate" data-ws="beadcause" data-bead="bc-rfnr"/);
});

console.log('\nexpanded');

check('every descendant is drawn, at every depth, in the order the server sent', () => {
  const html = board([CARD], ['beadcause/bc-rfnr']);
  const at = CARD.tree.map((r) => html.indexOf(`>${r.id}<`));
  for (const [i, n] of at.entries()) assert.notEqual(n, -1, `${CARD.tree[i].id} is missing from the tree`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'the tree is not in pre-order');
  assert.match(html, /Which way should the caret point\?/);
  assert.match(html, /aria-expanded="true"/);
});

check('the indent steps once per level and then stops', () => {
  const html = board([CARD], ['beadcause/bc-rfnr']);
  assert.equal(indentOf(html, 'bc-rfnr.9'), 0, 'a direct child is indented');
  assert.equal(indentOf(html, 'bc-rfnr.9.2'), 1);
  assert.equal(indentOf(html, 'bc-rfnr.9.2.1'), 2);
  // The cap. A fourth level draws at the third's indent, and a fifth does not go further
  // — this tracker nests deeper than a 360px phone can afford to step.
  assert.equal(indentOf(html, 'bc-rfnr.9.2.1.1'), 3);
  assert.equal(indentOf(html, 'bc-rfnr.9.2.1.1.1'), 3);
});

check('a bead that is itself asking you something says so', () => {
  const html = board([CARD], ['beadcause/bc-rfnr']);
  const row = html.slice(html.indexOf('bc-rfnr.9.2.1<') - 400, html.indexOf('bc-rfnr.9.2.1<') + 400);
  assert.match(row, /p0-row[^"]* asks/);
  assert.match(row, /asks you/);
  // And a bead nobody is asking about does not.
  const quiet = html.slice(html.indexOf('bc-rfnr.9<') - 300, html.indexOf('bc-rfnr.9<') + 300);
  assert.ok(!quiet.includes('asks you'), 'a bead with no question drew the pill');
});

check('a status that is not `open` is named, and `open` is not restated sixty times', () => {
  const html = board([CARD], ['beadcause/bc-rfnr']);
  assert.match(html, /class="pill st-in_progress">claimed/);
  assert.match(html, /class="pill st-closed">closed/);
  assert.equal((html.match(/st-open/g) || []).length, 0, 'every open row carries a pill saying open');
});

check('closed work recedes rather than disappearing', () => {
  const html = board([CARD], ['beadcause/bc-rfnr']);
  assert.match(html, /class="p0-row done"/);
  assert.match(html, /A fifth, already landed/);
});

check('each row is a link to that bead in the graph — no tap does nothing', () => {
  const html = board([CARD], ['beadcause/bc-rfnr']);
  assert.match(html, /href="\/graph\?ws=beadcause&amp;id=bc-rfnr\.9\.2&amp;open=1"/);
});

console.log('\nwhat is open, and what survives a repaint');

check('the same state renders the same board — a repaint redraws what was open', () => {
  const once = board([CARD, OTHER], ['beadcause/bc-rfnr']);
  const twice = board([CARD, OTHER], ['beadcause/bc-rfnr']);
  assert.equal(once, twice);
  assert.ok(once.includes('p0-tree'), 'the repaint lost the tree');
});

check('only the card whose key was tapped is open', () => {
  const html = board([CARD, OTHER], ['beadcause/bc-p49x']);
  assert.ok(html.includes('bc-p49x.4'), 'the tapped card did not open');
  assert.ok(!html.includes('bc-rfnr.9.2'), 'the other card opened too');
  // Counted on the cards only. The section heading is a disclosure too since bc-eevn, and
  // an open board is a third `aria-expanded="true"` that says nothing about which card
  // was tapped — so this matches the attribute where it sits on a `data-p0` button.
  assert.equal((html.match(/data-p0="[^"]+" aria-expanded="true"/g) || []).length, 1);
});

check('and the toggle writes state rather than poking the DOM', () => {
  // The one thing a rendered string cannot show: that the *tap* leaves no state anywhere
  // but the set. A branch that added a class to the card, or set `hidden` on the tree,
  // would pass every assertion above and fold up at the next poll.
  const at = APP.indexOf("if (act === 'p0') {");
  assert.notEqual(at, -1, 'the P0 tap handler is gone');
  const branch = APP.slice(at, at + 700);
  const body = branch.slice(0, branch.indexOf('\n    }'));
  assert.match(body, /state\.p0open\.(add|delete)/);
  assert.match(body, /render\(true\)/);
  assert.ok(!/classList|\.hidden|innerHTML|querySelector/.test(body), 'the tap is reaching into the DOM');
});

check('the board is still one reconcile chunk, which is why the set has to exist', () => {
  assert.match(APP, /chunks\.push\(\{ key: '@p0', html: p0s \}\)/);
});

console.log('\nthe section folds away');

check('the heading is the control, and it says what the section is', () => {
  const html = board([CARD, OTHER]);
  assert.match(html, /<button type="button" class="p0-kind" data-act="p0-fold" aria-expanded="true"/);
  assert.match(html, /Epics assigned to you/);
  // The old name, gone from the screen and from what a screen reader announces for the
  // region — both, because half a rename is a section that reads one way and is called
  // another.
  assert.ok(!html.includes('Your P0s'), 'the board still calls itself Your P0s');
  assert.match(html, /aria-label="Epics assigned to you"/);
});

check('shut, the cards are gone and the count is not', () => {
  const html = board([CARD, OTHER], [], true);
  assert.ok(!html.includes('p0-card'), 'a shut board is still drawing its cards');
  assert.ok(!html.includes('The inbox is a P0 board'), 'a shut board is still drawing its titles');
  // How many epics are behind the fold. Without it, a folded board is indistinguishable
  // from a screen with no epics on it — which is the one thing this section exists to
  // never be (bc-rfnr.2).
  assert.match(html, /class="p0-kind-n">2</);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Epics assigned to you/);
});

check('the fold is display only — what was open inside it is still open when it comes back', () => {
  const shut = board([CARD, OTHER], ['beadcause/bc-rfnr'], true);
  assert.ok(!shut.includes('p0-tree'), 'a shut board is drawing a tree');
  const back = board([CARD, OTHER], ['beadcause/bc-rfnr'], false);
  assert.ok(back.includes('p0-tree'), 'unfolding the board lost the tree that was open');
  assert.equal(back, board([CARD, OTHER], ['beadcause/bc-rfnr']), 'shut defaults to open');
});

check('an absent `p0shut` is an open board, on every state object that predates the field', () => {
  // The direction of the flag is the whole safety argument: stored shut-side-true, every
  // default there has ever been — an older page, a missing localStorage key, a state
  // object built before bc-eevn — reads as the board showing.
  assert.ok(board([CARD], [], undefined).includes('p0-card'));
  assert.match(APP, /p0shut: localStorage\.getItem\('beadcause\.p0shut'\) === '1'/);
});

check('the tap writes the preference as well as the state, and pokes no DOM', () => {
  const at = APP.indexOf("if (act === 'p0-fold') {");
  assert.notEqual(at, -1, 'the fold handler is gone');
  const branch = APP.slice(at, at + 500);
  const body = branch.slice(0, branch.indexOf('\n    }'));
  assert.match(body, /state\.p0shut = !state\.p0shut/);
  // Persisted on the tap. The next thing that happens to this page is a poll, and there
  // is no later save — a reload before the write is the fold undoing itself.
  assert.match(body, /localStorage\.setItem\('beadcause\.p0shut'/);
  assert.match(body, /render\(true\)/);
  assert.ok(!/classList|\.hidden|innerHTML|querySelector/.test(body), 'the fold is reaching into the DOM');
  // And it leaves the cards' own open set alone: folding the board away is putting it
  // down, not closing the epic you were reading in it.
  assert.ok(!body.includes('p0open'), 'folding the board also closed the trees inside it');
});

check('folding changes nothing about the list underneath', () => {
  // `underOwnedP0s` is what narrows the inbox to your epics' descendants, and it reads
  // the board data rather than whether the board is on screen. A fold that narrowed the
  // list too would be a control that quietly empties the inbox.
  const at = APP.indexOf('function underOwnedP0s(rows)');
  assert.notEqual(at, -1, 'underOwnedP0s is gone');
  const fn = APP.slice(at, APP.indexOf('\n  }', at));
  assert.ok(!fn.includes('p0shut'), 'the inbox filter is reading whether the board is folded');
});

console.log('\nthe edges');

check('a P0 with nothing under it expands to a sentence, not a gap', () => {
  const bare = { ...CARD, tree: [], open: 0 };
  const shut = board([bare]);
  assert.match(shut, /Nothing filed under it yet/);
  const html = board([bare], ['beadcause/bc-rfnr']);
  assert.match(html, /class="p0-none">Nothing under this one yet/);
  assert.ok(!html.includes('class="p0-tree"'), 'an empty tree drew an empty container');
});

check('a card from a server that has never heard of trees still draws', () => {
  const old = { key: 'beadcause/bc-old', workspace: 'beadcause', id: 'bc-old', title: 'Before 9.1', open: 3, inFlight: 0 };
  const html = board([old], ['beadcause/bc-old']);
  assert.match(html, /Before 9\.1/);
  assert.match(html, /p0-none/);
});

check('a title out of the tracker cannot write markup into the board', () => {
  const nasty = {
    ...CARD,
    tree: [{ ...CARD.tree[0], title: '<img src=x onerror=alert(1)>' }],
  };
  const html = board([nasty], ['beadcause/bc-rfnr']);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes('<img'), 'a bead title wrote a tag into the inbox');
});

check('the three no-op cases are untouched: no `me`, no P0s, an old payload', () => {
  assert.equal(board([]), '');
  const context = vm.createContext({ String, Number, Math, JSON, Date, encodeURIComponent, state: { p0board: { owned: false, p0s: [CARD] }, p0open: new Set(), space: 'all', workspace: 'all', spaces: [], p0opening: new Map() } });
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'const cardId = ('),
      lift(APP, 'const spaceForWorkspace = ('),
      lift(APP, 'const STATUS_LABEL = '),
      lift(APP, 'function graphUrl(q)'),
      lift(APP, 'const P0_INDENT_CAP = '),
      lift(APP, 'const P0_SECTION_LABEL = '),
      lift(APP, 'function p0HintText(on, total)'),
      lift(APP, 'function p0RowHtml(card, row)'),
      lift(APP, 'function p0TreeHtml(card)'),
      // bc-d6yk's three-state control, which the acts row now calls rather than writing
      // a launch button by hand — and the local "just launched" note it reads.
      lift(APP, 'function openingHere(key)'),
      lift(APP, 'function p0Control(c)'),
      lift(APP, 'function p0SectionHtml()'),
    ].join('\n'),
    context
  );
  assert.equal(vm.runInContext('p0SectionHtml()', context), '');
});

console.log('\nthe stylesheet');

check('the indent is a margin off `--d`, so a deep row narrows instead of overflowing', () => {
  const at = CSS.indexOf('.p0-row {');
  assert.notEqual(at, -1, 'public/style.css has no .p0-row');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(rule, /margin-left: calc\(var\(--d, 0\) \* \d+px\)/);
  assert.match(rule, /min-height: 34px/);
});

check('the tap region is stripped back to text and keeps a phone-sized target', () => {
  const at = CSS.indexOf('.p0-tap {');
  assert.notEqual(at, -1, 'public/style.css has no .p0-tap');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(rule, /min-height: 44px/);
  assert.match(rule, /text-align: left/);
});

check('the heading is a real tap target, and the count sits at the far end', () => {
  const at = CSS.indexOf('.p0-kind {');
  assert.notEqual(at, -1, 'public/style.css has no .p0-kind');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  // Shut, this line is the only way back to the board — so it is a thumb target rather
  // than the 11px label it used to be, and it is the width of the section.
  assert.match(rule, /min-height: var\(--tap\)/);
  assert.match(rule, /width: 100%/);
  const n = CSS.slice(CSS.indexOf('.p0-kind-n {'), CSS.indexOf('}', CSS.indexOf('.p0-kind-n {')));
  assert.match(n, /margin-left: auto/);
  // The chevron the fold turns is the shared one, so it rotates off `aria-expanded`
  // rather than off a second rule that could drift from it.
  assert.match(CSS, /\[aria-expanded='true'\] > \.chev/);
});

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall good\x1b[0m (${ran})`}\n`);
process.exit(failures ? 1 : 0);
