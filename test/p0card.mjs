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
 * 8. **One status filter over every tree at once** (bc-rfnr.9.6), and the half of it that
 *    fails silently is the ancestors. The rows are flat with an indent drawn off `depth`,
 *    so dropping a parent while keeping its child does not leave a gap — it leaves the
 *    child indented under whatever row happened to precede it, reading as a different
 *    bead's child, which no assertion about "is the closed bead drawn" would catch. Both
 *    directions are checked (a closed parent with an open child, an open parent with a
 *    closed one), along with the default being not-closed, the pick surviving a repaint,
 *    the chips' counts, and the two different sentences an empty tree can have.
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
 * faithful stand-in for the poll repaint that the feature has to survive. `status` is
 * `state.p0status` the same way: what the chips write, and the only thing the filter is.
 */
function board(p0s, open = [], shut = false, status = 'live') {
  const state = {
    p0board: { owned: true, p0s, under: {} },
    p0open: new Set(open),
    p0shut: shut,
    p0status: status,
    space: 'all',
    workspace: 'all',
    spaces: [],
    p0opening: new Map(),
    // bc-s8mc: the picker is shut in this suite. See the lift below.
    p0picker: false,
    // Empty, always, in this suite: what a row expands *into* is test/p0bead.mjs's
    // (bc-rfnr.9.4). It is here because `p0RowHtml` asks whether its bead is open before
    // it draws the caret, and a board rendered without it throws rather than failing.
    p0beadopen: new Set(),
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
      // bc-rfnr.9.6's filter: the table of options, the one in force, the narrowing
      // itself, and the chips. All four, because the section calls the chips and the tree
      // calls the narrowing — lifting half of it would leave a `ReferenceError` that reads
      // as the renderer being broken.
      lift(APP, 'const P0_STATUS_FILTERS = '),
      lift(APP, 'function p0StatusFilter()'),
      lift(APP, 'function p0Visible(rows)'),
      lift(APP, 'function p0StatusHtml(cards)'),
      lift(APP, 'function p0HintText(on, shown, total)'),
      lift(APP, 'const p0RowKey = ('),
      lift(APP, 'const p0Step = ('),
      lift(APP, 'function p0RowHtml(card, row)'),
      // bc-rfnr.9.4's expansion, which every row now offers and no row opens here —
      // `p0beadopen` is empty above, so this returns '' on all of them. Lifted because
      // `p0TreeHtml` calls it per row and would otherwise throw; what it *draws* is
      // test/p0bead.mjs's, which lifts the whole chain underneath it.
      lift(APP, 'function p0BeadHtml(card, row)'),
      lift(APP, 'function p0TreeHtml(card)'),
      // bc-d6yk's three-state control, which the acts row now calls rather than writing
      // a launch button by hand — and the local "just launched" note it reads.
      lift(APP, 'function openingHere(key)'),
      lift(APP, 'function p0Control(c)'),
      // bc-s8mc's picker, at the foot of the section — lifted because `p0SectionHtml`
      // calls it on every render and would otherwise throw. `state.p0picker` is false
      // here, so what it draws in this suite is the closed offer and nothing else;
      // what it draws open is test/p0start.mjs's.
      lift(APP, 'function p0PickerHtml(rows)'),
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
  // The total, which is the number the open count cannot give you: 4 of 5 left. Both
  // numbers since bc-rfnr.9.6, because the default filter puts a wedge between them —
  // the fifth bead is closed, so the tap opens four of the five that are filed.
  assert.match(html, /Tap for 4 of the 5 beads under it/);
  // And with nothing filtered out they are one number again.
  assert.match(board([CARD], [], false, 'all'), /Tap for all 5 beads under it/);
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
  // `all` rather than the default, so this stays a claim about the *renderer* — the fifth
  // row is closed, and what the default filter does with it is bc-rfnr.9.6's section below.
  const html = board([CARD], ['beadcause/bc-rfnr'], false, 'all');
  const at = CARD.tree.map((r) => html.indexOf(`>${r.id}<`));
  for (const [i, n] of at.entries()) assert.notEqual(n, -1, `${CARD.tree[i].id} is missing from the tree`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'the tree is not in pre-order');
  assert.match(html, /Which way should the caret point\?/);
  assert.match(html, /aria-expanded="true"/);
});

check('the indent steps once per level and then stops', () => {
  const html = board([CARD], ['beadcause/bc-rfnr'], false, 'all');
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
  const html = board([CARD], ['beadcause/bc-rfnr'], false, 'all');
  assert.match(html, /class="pill st-in_progress">claimed/);
  assert.match(html, /class="pill st-closed">closed/);
  assert.equal((html.match(/st-open/g) || []).length, 0, 'every open row carries a pill saying open');
});

check('closed work recedes rather than disappearing where it is drawn', () => {
  const html = board([CARD], ['beadcause/bc-rfnr'], false, 'all');
  assert.match(html, /class="p0-row done"/);
  assert.match(html, /A fifth, already landed/);
});

check('each row is a disclosure of its own bead — no tap does nothing', () => {
  // It was a link out to the graph until bc-rfnr.9.4, which turned it into the control
  // that opens the bead's own details in place. The graph is still reachable and is
  // drawn *inside* the expansion, on the bead you tapped — see test/p0bead.mjs.
  const html = board([CARD], ['beadcause/bc-rfnr']);
  assert.match(
    html,
    /<button type="button" class="p0-row"[^>]*data-act="p0-bead" data-p0bead="beadcause\/bc-rfnr\.9"/
  );
  assert.match(html, /data-ws="beadcause" data-bead="bc-rfnr\.9\.2"/);
  // Shut, so the caret points the way the card's does and nothing claims to control a
  // block that is not on the page.
  assert.ok(!html.includes('aria-controls="p0bead-'), 'a shut row is claiming to control an expansion');
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

console.log('\none status filter over the whole board');

/**
 * A tree with the two awkward shapes in it, which `CARD` does not have.
 *
 * `bc-mix.1` is **closed with an open child**, and `bc-mix.2` is **open with a closed
 * child** — one for each direction the filter can exclude a parent while keeping what is
 * under it. `bc-mix.3` is blocked, because "not closed" has to mean all three of open,
 * in progress and blocked rather than open alone.
 */
const MIX = {
  key: 'beadcause/bc-mix',
  workspace: 'beadcause',
  id: 'bc-mix',
  title: 'A tree with both awkward shapes in it',
  status: 'open',
  open: 3,
  inFlight: 0,
  waitingOn: null,
  tree: [
    { id: 'bc-mix.1', title: 'Landed, with work still under it', status: 'closed', parent: 'bc-mix', depth: 1, key: 'beadcause/bc-mix.1', pending: false },
    { id: 'bc-mix.1.1', title: 'Still going, under a landed parent', status: 'open', parent: 'bc-mix.1', depth: 2, key: 'beadcause/bc-mix.1.1', pending: false },
    { id: 'bc-mix.2', title: 'Open, with something delivered under it', status: 'open', parent: 'bc-mix', depth: 1, key: 'beadcause/bc-mix.2', pending: false },
    { id: 'bc-mix.2.1', title: 'Delivered', status: 'closed', parent: 'bc-mix.2', depth: 2, key: 'beadcause/bc-mix.2.1', pending: false },
    { id: 'bc-mix.3', title: 'Waiting on somebody', status: 'blocked', parent: 'bc-mix', depth: 1, key: 'beadcause/bc-mix.3', pending: false },
  ],
};

/** An epic where everything has landed — the card the filter can empty. */
const LANDED = {
  key: 'beadcause/bc-done',
  workspace: 'beadcause',
  id: 'bc-done',
  title: 'All of it shipped',
  status: 'open',
  open: 0,
  inFlight: 0,
  tree: [
    { id: 'bc-done.1', title: 'One', status: 'closed', parent: 'bc-done', depth: 1, key: 'beadcause/bc-done.1', pending: false },
    { id: 'bc-done.2', title: 'Two', status: 'closed', parent: 'bc-done', depth: 2, key: 'beadcause/bc-done.2', pending: false },
  ],
};

/** The opener a row is drawn with — a `<button>` since bc-rfnr.9.4, an `<a>` before it. */
const ROW_OPEN = '<button type="button" class="';

/**
 * The class list on one row, by bead id — the row's own and not its neighbour's.
 *
 * Taken from the row's own opener immediately before the id rather than out of a window
 * of the surrounding string, which is what a first draft of this did: the marks are three
 * classes on one element and the row above is only a few hundred characters away, so a
 * slice wide enough to hold the row is wide enough to hold the one before it and every
 * assertion about a class passes for the wrong reason.
 */
function rowClass(html, id) {
  const at = html.indexOf(`>${id}<`);
  assert.notEqual(at, -1, `no row for ${id}`);
  const open = html.lastIndexOf(ROW_OPEN, at);
  assert.notEqual(open, -1, `the row for ${id} is not drawn with ${ROW_OPEN}`);
  return html.slice(open + ROW_OPEN.length, html.indexOf('"', open + ROW_OPEN.length));
}

/** Every chip on the filter, as `{label, on, count}` — the control read off the board. */
function chips(html) {
  const out = [];
  const re = /data-act="p0-status" data-status="([^"]+)" aria-pressed="(true|false)">([^<]*)<span class="chip-count">(\d+)</g;
  let hit;
  while ((hit = re.exec(html))) out.push({ id: hit[1], on: hit[2] === 'true', label: hit[3], count: Number(hit[4]) });
  return out;
}

check('defaults to not-closed — open, in progress and blocked all show, closed does not', () => {
  const html = board([MIX], ['beadcause/bc-mix']);
  assert.ok(html.includes('bc-mix.1.1'), 'an open bead is missing from the default tree');
  assert.ok(html.includes('bc-mix.3'), 'a blocked bead is missing from the default tree');
  assert.ok(!html.includes('bc-mix.2.1<'), 'a closed bead is drawn under the default filter');
  // And in progress, from the other fixture — three statuses, one meaning.
  assert.ok(board([CARD], ['beadcause/bc-rfnr']).includes('bc-rfnr.9.2<'), 'a claimed bead is hidden by default');
  assert.deepEqual(
    chips(html).map((c) => [c.id, c.on]),
    [['live', true], ['all', false], ['closed', false]]
  );
});

check('the default survives a page that has never stored one, and an id it does not know', () => {
  // An absent key and a value from some other version both read as the default rather
  // than as a board with no chip pressed and an empty tree under it.
  for (const stored of [undefined, '', 'archived']) {
    const html = board([MIX], ['beadcause/bc-mix'], false, stored);
    assert.ok(html.includes('bc-mix.1.1'), `a stored \`${stored}\` drew an empty tree`);
    assert.equal(chips(html).find((c) => c.on)?.id, 'live', `a stored \`${stored}\` pressed the wrong chip`);
  }
  assert.match(APP, /p0status: localStorage\.getItem\('beadcause\.p0status'\) \|\| 'live'/);
});

check('one control, above the board — not one per card', () => {
  const html = board([CARD, MIX], ['beadcause/bc-rfnr', 'beadcause/bc-mix']);
  assert.equal(chips(html).length, 3, 'the board is not drawing exactly one filter');
  // Above the cards, and below the heading that folds them: the order on the page is what
  // makes it read as one control over the lot rather than as part of the first card.
  const at = html.indexOf('p0-status');
  assert.ok(at !== -1 && at < html.indexOf('p0-card'), 'the filter is drawn inside or after the cards');
  assert.ok(html.indexOf('p0-kind') < at, 'the filter is drawn above the section heading');
  // And it narrows every tree at once, not the one it happens to sit nearest.
  const closed = board([CARD, MIX], ['beadcause/bc-rfnr', 'beadcause/bc-mix'], false, 'closed');
  assert.ok(closed.includes('bc-rfnr.9.2.1.1.1'), 'the first card ignored the filter');
  assert.ok(closed.includes('bc-mix.2.1'), 'the second card ignored the filter');
});

check('selecting closed shows closed descendants with their ancestors intact', () => {
  const html = board([CARD], ['beadcause/bc-rfnr'], false, 'closed');
  // The one closed bead in this tree is five deep. Every ancestor between it and the card
  // is drawn — without them the row indents under whatever preceded it, which is a
  // different bead's child.
  for (const id of ['bc-rfnr.9', 'bc-rfnr.9.2', 'bc-rfnr.9.2.1', 'bc-rfnr.9.2.1.1', 'bc-rfnr.9.2.1.1.1']) {
    assert.ok(html.includes(`>${id}<`), `${id} is missing, so the closed leaf lost its place`);
  }
  // Still pre-order, and still at their own indents — the tree is the tree.
  const at = ['bc-rfnr.9', 'bc-rfnr.9.2', 'bc-rfnr.9.2.1'].map((id) => html.indexOf(`>${id}<`));
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  assert.equal(indentOf(html, 'bc-rfnr.9'), 0);
  assert.equal(indentOf(html, 'bc-rfnr.9.2.1'), 2);
});

check('a row kept only for its children says so, and still opens its own bead', () => {
  const html = board([CARD], ['beadcause/bc-rfnr'], false, 'closed');
  assert.equal(rowClass(html, 'bc-rfnr.9'), 'p0-row via', 'an ancestor kept for its child is not marked');
  const row = html.slice(html.lastIndexOf(ROW_OPEN, html.indexOf('>bc-rfnr.9<')), html.indexOf('>bc-rfnr.9<'));
  // Held up for its child and still a tap of its own. Since bc-rfnr.9.4 that tap expands
  // the bead in place rather than leaving for the graph, so what says the row is still
  // reachable is its own `p0-bead` act and not an `href` — the way through to the graph
  // moved inside the expansion. A context row that lost its act would be scaffolding you
  // cannot open, which is the same dead row this check was written to prevent.
  assert.match(row, /data-act="p0-bead" data-p0bead="beadcause\/bc-rfnr\.9"/);
  assert.match(row, /data-ws="beadcause" data-bead="bc-rfnr\.9"/);
  // The bead that actually matched is not marked — otherwise the mark says nothing.
  assert.equal(rowClass(html, 'bc-rfnr.9.2.1.1.1'), 'p0-row done');
});

check('both directions of an excluded parent are held up', () => {
  // Closed parent, open child, under the default filter.
  const live = board([MIX], ['beadcause/bc-mix']);
  assert.ok(live.includes('>bc-mix.1<'), 'a closed parent was dropped and its open child orphaned');
  assert.match(live.slice(live.indexOf('>bc-mix.1<') - 500, live.indexOf('>bc-mix.1<')), /p0-row done via|p0-row via/);
  assert.ok(live.includes('>bc-mix.1.1<'));
  // Open parent, closed child, the other way round.
  const closed = board([MIX], ['beadcause/bc-mix'], false, 'closed');
  assert.ok(closed.includes('>bc-mix.2<'), 'an open parent was dropped and its closed child orphaned');
  assert.ok(closed.includes('>bc-mix.2.1<'));
  // And nothing that neither matched nor holds anything up comes along for the ride.
  assert.ok(!closed.includes('>bc-mix.3<'), 'a blocked leaf is drawn under the closed filter');
});

check('every chip says what it would leave you with, counted over the board', () => {
  const html = board([MIX, LANDED], ['beadcause/bc-mix']);
  const by = Object.fromEntries(chips(html).map((c) => [c.id, c.count]));
  // Seven beads over the two cards: three closed on `MIX` and `LANDED`'s two, four live.
  assert.equal(by.all, 7);
  assert.equal(by.closed, 4);
  assert.equal(by.live, 3);
  // Counted on what matched, not on what is drawn — the ancestors kept for context are
  // scaffolding, and counting them would put "4" over a tree with three closed rows.
  assert.equal(by.closed, MIX.tree.concat(LANDED.tree).filter((r) => r.status === 'closed').length);
});

check('the hint under the title promises what the tap will actually open', () => {
  assert.match(board([MIX]), /Tap for 3 of the 5 beads under it/);
  assert.match(board([MIX], [], false, 'all'), /Tap for all 5 beads under it/);
  // An epic the filter empties says that, rather than "nothing filed under it yet" — the
  // one is the control's doing and the other is the tracker's, and they are not the same
  // sentence to a reader deciding whether to break the epic down.
  const empty = board([LANDED]);
  assert.match(empty, /Nothing under it matches the filter/);
  assert.ok(!empty.includes('Nothing filed under it yet'), 'a filtered-out tree reads as an epic nobody has broken down');
  assert.match(board([LANDED], ['beadcause/bc-done']), /Nothing under bc-done matches the filter/);
});

check('the pick is page state, persisted — so it survives a repaint and a reload', () => {
  const once = board([CARD, MIX], ['beadcause/bc-mix'], false, 'closed');
  const twice = board([CARD, MIX], ['beadcause/bc-mix'], false, 'closed');
  assert.equal(once, twice, 'the same state drew two different boards');
  assert.ok(once.includes('bc-mix.2.1'), 'the repaint lost the filter');
  // The board is one reconcile chunk replaced whole every 25 seconds, so a filter applied
  // by hiding nodes would come undone under your thumb. The tap writes state and storage
  // and nothing else.
  const at = APP.indexOf("if (act === 'p0-status') {");
  assert.notEqual(at, -1, 'the status filter handler is gone');
  const branch = APP.slice(at, at + 700);
  const body = branch.slice(0, branch.indexOf('\n    }'));
  assert.match(body, /state\.p0status = pick/);
  assert.match(body, /localStorage\.setItem\('beadcause\.p0status', pick\)/);
  assert.match(body, /render\(true\)/);
  assert.ok(!/classList|\.hidden|innerHTML|querySelector/.test(body), 'the filter is reaching into the DOM');
  // An option this page does not know is ignored rather than stored — a written unknown
  // would leave the phone with no chip pressed until it was tapped again.
  assert.match(body, /P0_STATUS_FILTERS\.some/);
});

check('it narrows the trees and nothing else — the list below is untouched', () => {
  // `underOwnedP0s` is what the inbox is narrowed by. A bead you filtered out of a tree is
  // still a question you are being asked, and a status filter that reached the list would
  // hide it with nothing on screen to say where it went.
  const at = APP.indexOf('function underOwnedP0s(rows)');
  assert.notEqual(at, -1, 'underOwnedP0s is gone');
  assert.ok(!APP.slice(at, APP.indexOf('\n  }', at)).includes('p0status'), 'the inbox filter is reading the board filter');
});

check('the fold takes the filter with it', () => {
  // A control over things that are not on screen is one you set and cannot see the effect
  // of — and it is the cards it filters, so it goes where they go.
  const html = board([CARD, MIX], [], true);
  assert.equal(chips(html).length, 0, 'a shut board is still drawing its filter');
  assert.match(html, /class="p0-kind-n">2</);
});

check('a context row is dashed rather than dimmed again, so a closed one stays readable', () => {
  const at = CSS.indexOf('.p0-row.via {');
  assert.notEqual(at, -1, 'public/style.css has no .p0-row.via');
  assert.match(CSS.slice(at, CSS.indexOf('}', at)), /border-left-style: dashed/);
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
  const context = vm.createContext({ String, Number, Math, JSON, Date, encodeURIComponent, state: { p0board: { owned: false, p0s: [CARD] }, p0open: new Set(), space: 'all', workspace: 'all', spaces: [], p0opening: new Map(), p0picker: false } });
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'const cardId = ('),
      lift(APP, 'const spaceForWorkspace = ('),
      lift(APP, 'const STATUS_LABEL = '),
      lift(APP, 'function graphUrl(q)'),
      lift(APP, 'const P0_INDENT_CAP = '),
      lift(APP, 'const P0_SECTION_LABEL = '),
      // bc-rfnr.9.6's filter: the table of options, the one in force, the narrowing
      // itself, and the chips. All four, because the section calls the chips and the tree
      // calls the narrowing — lifting half of it would leave a `ReferenceError` that reads
      // as the renderer being broken.
      lift(APP, 'const P0_STATUS_FILTERS = '),
      lift(APP, 'function p0StatusFilter()'),
      lift(APP, 'function p0Visible(rows)'),
      lift(APP, 'function p0StatusHtml(cards)'),
      lift(APP, 'function p0HintText(on, shown, total)'),
      lift(APP, 'function p0RowHtml(card, row)'),
      lift(APP, 'function p0TreeHtml(card)'),
      // bc-d6yk's three-state control, which the acts row now calls rather than writing
      // a launch button by hand — and the local "just launched" note it reads.
      lift(APP, 'function openingHere(key)'),
      lift(APP, 'function p0Control(c)'),
      // bc-s8mc's picker, at the foot of the section — lifted because `p0SectionHtml`
      // calls it on every render and would otherwise throw. `state.p0picker` is false
      // here, so what it draws in this suite is the closed offer and nothing else;
      // what it draws open is test/p0start.mjs's.
      lift(APP, 'function p0PickerHtml(rows)'),
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
