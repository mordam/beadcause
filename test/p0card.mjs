#!/usr/bin/env node
/**
 * A P0 card summarises in a grid cell and opens its tree over the whole tab.
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
 * 5. **A bead that is itself a question is marked, at three heights.** `pending` is the
 *    whole reason to open a tree, and since bc-rfnr.9.7 took the flat list away the tree
 *    is the only place a question is drawn — so the pill on the row is not enough on its
 *    own. The collapsed card counts them and the section heading counts them for the whole
 *    board, because a question four levels down a tree that is folded shut by default is
 *    not findable, and the status filter is not allowed to exclude one at all.
 *
 * 6. **Tracker text cannot write markup into the board.** A bead title is text out of
 *    `bd`; the escaped form is asserted present, not merely the raw tag absent.
 *
 * 7. **The section no longer folds** (bc-khoe.28, undoing bc-eevn), and the way that rots
 *    is a half-removal. My Epics is the board and nothing else now, so a control that put
 *    the board away would leave the view blank — and `beadcause.p0shut` persisted it, so
 *    one tap would have left it blank for good. Three ends are asserted gone rather than
 *    one, because any of them left behind reads as live: the `data-act` on the heading,
 *    the `aria-expanded` that made it a disclosure, and the state and its `localStorage`
 *    key. What stays is the heading and both of its counts — how many epics, and how many
 *    beads under them are asking you something — which is the only place a question four
 *    levels down a tree nobody has opened is counted at all.
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
 * 9. **The cards are a grid and the tree takes the tab** (bc-grut), which is three claims
 *    a renderer test can hold and one it cannot. It can hold that the collapsed card is
 *    worth scanning — how far along, and whether any of it is asking *you* — and that
 *    those numbers do not move when the status filter does, which is the whole reason the
 *    filter went into the tab with the tree it narrows. It can hold that the tab is drawn
 *    over the grid rather than inside it, which is what ends bc-rfnr.9.9 by construction:
 *    an expansion that inserts nothing above the inbox list has no height for
 *    `capturePlace` to hold still and no scroll to jump. And it can hold that at most one
 *    is open, because a second fixed layer stacks on the first with nothing saying which
 *    epic you are reading. What it cannot hold is the three-column layout itself — that is
 *    `.p0-cards`, asserted as a rule below and measured for real by
 *    `node scripts/p0grid-check.mjs` in a headless browser at three widths.
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
 * One P0 with a tree six deep — the shape `rootCard` in lib/server.js sends, and the shape
 * test/p0tree.mjs proves it sends. Depths 1..5 on purpose: 4 and 5 are the two that a
 * cap has to flatten and 3 is the last one that still steps.
 */
const CARD = {
  key: 'beadcause/bc-rfnr',
  workspace: 'beadcause',
  id: 'bc-rfnr',
  title: 'The inbox is an epic board',
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
function board(roots, open = [], status = 'live') {
  const state = {
    rootboard: { owned: true, roots, under: {} },
    p0open: new Set(open),
    p0status: status,
    space: 'all',
    workspace: 'all',
    spaces: [],
    p0opening: new Map(),
    // bc-s8mc: the picker is shut in this suite. See the lift below.
    // Empty, always, in this suite: what a row expands *into* is test/p0bead.mjs's
    // (bc-rfnr.9.4). It is here because `p0RowHtml` asks whether its bead is open before
    // it draws the caret, and a board rendered without it throws rather than failing.
    p0beadopen: new Set(),
  };
  // `byKey` answers "does the inbox payload have a row for this key" and is what
  // `p0DoneHtml` gates the close offer on (bc-r2b5.2). Null here: no card in this suite is
  // finished, so the only thing it decides is that nothing draws a close.
  const context = vm.createContext({ String, Number, Math, JSON, Date, encodeURIComponent, state, byKey: () => null });
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
      // bc-grut's collapsed summary: the counts a card carries when its tree is not on
      // the screen, and the bar that draws them.
      lift(APP, 'function p0Progress(card)'),
      lift(APP, 'function p0ProgressHtml(card)'),
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
      // bc-r2b5.2's four states. `p0Control` derives them once through `p0AdvState` so the
      // card, the tab and the advocate sheet cannot disagree about which one an epic is in;
      // `relTime` comes with them because "last looked 3h ago" is the half of an idle card
      // that makes idle readable, and `p0DoneHtml` because a finished epic offers the close
      // from the acts row rather than leaving it to be found in the inbox.
      lift(APP, 'function relTime(iso)'),
      lift(APP, 'function p0AdvState(c)'),
      lift(APP, 'function p0AdvWhen(s)'),
      lift(APP, 'function p0AdvLine(s)'),
      lift(APP, 'function p0DoneHtml(c)'),
      lift(APP, 'function p0AdvOpenHtml(c, s)'),
      lift(APP, 'function p0Control(c)'),
      // bc-grut: the section is three renderers now — a grid cell, the tab a tap opens,
      // and the head both of them share so their counts cannot disagree.
      lift(APP, 'const p0AsksHtml = '),
      lift(APP, 'function p0FaceHtml(c, asks, tail'),
      lift(APP, 'function p0ActsHtml(c, more'),
      lift(APP, 'function p0CardHtml(c)'),
      lift(APP, 'function p0FullHtml(c)'),
      // bc-rfnr.9.7's two: which cards the scope filters leave, and how many beads under
      // them are asking you something. The section calls both — the first for its own
      // list and the second for the count on the heading — so a board rendered without
      // them is a `ReferenceError` rather than a missing pill.
      lift(APP, 'const p0AsksN = ('),
      lift(APP, 'function p0Cards(list)'),
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

check('summarises: id, the counts, the title, and how far along it is', () => {
  const html = board([CARD]);
  assert.match(html, /bc-rfnr/);
  assert.match(html, /4 open/);
  assert.match(html, /1 in flight/);
  assert.match(html, /The inbox is an epic board/);
  // How far along, which is the number the open count cannot give you: "4 open" says
  // nothing about whether the epic is four of five or four of sixty. bc-grut.
  assert.match(html, /1 of 5 done/);
  assert.match(html, /<span class="p0-bar-fill" style="width:20%">/);
});

check('and says how much of it is waiting on *you*, which is what a grid is scanned for', () => {
  // One `pending` row in this tree. It is the only field on a card that means the epic
  // is stopped on the person reading the board, so it is a pill rather than a number in
  // a line of numbers — and at zero it is not drawn at all, because a pill saying none
  // is a pill you learn to ignore.
  assert.match(board([CARD]), /<span class="pill p0-asks">1 asks you<\/span>/);
  assert.ok(!board([OTHER]).includes('p0-asks'), 'a card with nothing pending drew the pill anyway');
  const two = { ...CARD, tree: CARD.tree.map((r) => ({ ...r, pending: true })) };
  assert.match(board([two]), /5 ask you/);
});

check('the counts on the card and the counts in the tab are drawn once, so they cannot drift', () => {
  // One renderer for the head line — a grid cell saying "4 open" over a tab saying five
  // is two answers to one question arriving from one object.
  const open = board([CARD], ['beadcause/bc-rfnr']);
  assert.equal((open.match(/class="p0-head"/g) || []).length, 2, 'the card and its tab are not both drawn');
  assert.equal((open.match(/>4 open</g) || []).length, 2);
  // On the pill rather than on the words, because since bc-rfnr.9.7 there is a third
  // reader of the same number: the fold heading says it too (`.p0-kind-asks`), so that it
  // still says how many are waiting once the board is shut. That one is a count of the
  // whole board and is checked on its own below; this pair is the card and its tab.
  assert.equal((open.match(/class="pill p0-asks">1 asks you/g) || []).length, 2);
});

check('an epic with nothing under it says so instead of drawing a bar at zero', () => {
  // A full-width empty track over an epic nobody has broken down yet is a claim that
  // nothing has landed, where the truth is that nothing has been written down.
  const bare = board([{ ...CARD, tree: [], open: 0 }]);
  assert.match(bare, /Nothing filed under it yet/);
  assert.ok(!bare.includes('p0-bar'), 'an epic with no tree drew a progress bar');
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
  // And it announces what it opens. Since bc-grut the tap is not a disclosure — it goes
  // to a layer over the whole tab — so `aria-haspopup` is what a screen reader needs to
  // say so before the sheet arrives. `aria-expanded` stays beside it: the card does have
  // an open and a shut state, and dropping it leaves the control silent about which.
  assert.match(html, /data-p0="beadcause\/bc-rfnr" aria-haspopup="dialog" aria-expanded="false"/);
  assert.match(
    board([CARD], ['beadcause/bc-rfnr']),
    /data-p0="beadcause\/bc-rfnr" aria-haspopup="dialog" aria-expanded="true" aria-controls="p0full-/
  );
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

console.log('\nthe tab a tap opens');

check('the tree opens as a layer over the tab, not as a block between the board and the list', () => {
  // bc-grut, and the half of it that no assertion about the rows can see: the expansion
  // used to be a sibling of the card, inside the board, which is what made bc-rfnr.9.9's
  // scroll jump possible at all — six hundred pixels inserted above the inbox list.
  const html = board([CARD], ['beadcause/bc-rfnr']);
  const at = html.indexOf('class="p0-full"');
  assert.notEqual(at, -1, 'the open epic did not draw its tab');
  assert.ok(at > html.indexOf('class="p0-cards"'), 'the tab is drawn inside the grid rather than over it');
  assert.ok(html.indexOf('class="p0-tree"') > at, 'the tree is drawn outside the tab');
  // A dialog, with the way back inside it and nothing else offered as one.
  assert.match(html, /role="dialog" aria-modal="true" aria-label="bc-rfnr — The inbox is an epic board"/);
  assert.match(html, /<button type="button" class="p0-back" data-act="p0-close">/);
  assert.ok(!html.includes('data-act="p0-close"><span aria-hidden="true">✕'), 'the way back is a cross');
});

check('and the collapsed card behind it keeps its own controls', () => {
  // The card is still a card while the tab is over it: the advocate button is bc-rfnr.2's
  // one control on the board and a tab that stole it would leave the board a list of
  // titles. Both faces carry it, and both reach the same bead.
  const html = board([CARD], ['beadcause/bc-rfnr']);
  assert.equal((html.match(/data-act="advocate" data-ws="beadcause" data-bead="bc-rfnr"/g) || []).length, 2);
  assert.equal((html.match(/class="p0-graph"/g) || []).length, 2);
  assert.match(html, /class="p0-acts p0-full-acts"/);
});

check('every descendant is drawn, at every depth, in the order the server sent', () => {
  // `all` rather than the default, so this stays a claim about the *renderer* — the fifth
  // row is closed, and what the default filter does with it is bc-rfnr.9.6's section below.
  const html = board([CARD], ['beadcause/bc-rfnr'], 'all');
  const at = CARD.tree.map((r) => html.indexOf(`>${r.id}<`));
  for (const [i, n] of at.entries()) assert.notEqual(n, -1, `${CARD.tree[i].id} is missing from the tree`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'the tree is not in pre-order');
  assert.match(html, /Which way should the caret point\?/);
  assert.match(html, /aria-expanded="true"/);
});

check('the indent steps once per level and then stops', () => {
  const html = board([CARD], ['beadcause/bc-rfnr'], 'all');
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

check('AND THE COLLAPSED CARD CARRIES THE COUNT — bc-rfnr.9.7, four levels up', () => {
  // The question in this fixture is at depth 3 of a tree that is folded shut by default.
  // With the flat list gone, a board that made you open every card to find out whether
  // anything was waiting would have moved the inbox somewhere you cannot see it.
  const shutTree = board([CARD, OTHER], []);
  assert.ok(!shutTree.includes('p0-tree'), 'the fixture opened a tree — this is the folded claim');
  assert.match(shutTree, /<span class="pill p0-asks">1 asks you<\/span>/);
  assert.match(shutTree, /class="p0-card asks"/);
  // And the epic with nothing waiting under it is not marked, which is what makes the
  // mark worth scanning for.
  const other = shutTree.slice(shutTree.indexOf('bc-p49x'));
  assert.ok(!other.includes('p0-asks'), 'an epic nobody is asking about was marked anyway');
  assert.ok(!other.includes('p0-card asks'));
});

check('and so does the section heading, which is the only count for a tree nobody has opened', () => {
  const head = board([CARD, OTHER]);
  assert.match(head, /class="p0-kind-asks">1 asks you</);
  assert.match(head, /class="p0-kind-n">2</, 'the heading lost the count of epics');
  // Plural, because "1 ask you" is the sort of thing that ships.
  const two = { ...OTHER, tree: OTHER.tree.map((r) => ({ ...r, pending: true })) };
  assert.match(board([CARD, two]), /class="p0-kind-asks">2 ask you</);
  // And nothing at all where nothing is waiting — an empty marker is a mark you stop
  // seeing.
  assert.ok(!board([OTHER]).includes('p0-kind-asks'));
});

check('a status that is not `open` is named, and `open` is not restated sixty times', () => {
  const html = board([CARD], ['beadcause/bc-rfnr'], 'all');
  assert.match(html, /class="pill st-in_progress">claimed/);
  assert.match(html, /class="pill st-closed">closed/);
  assert.equal((html.match(/st-open/g) || []).length, 0, 'every open row carries a pill saying open');
});

check('closed work recedes rather than disappearing where it is drawn', () => {
  const html = board([CARD], ['beadcause/bc-rfnr'], 'all');
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
  assert.equal((html.match(/data-p0="[^"]+" aria-haspopup="dialog" aria-expanded="true"/g) || []).length, 1);
});

check('and a state holding two draws one tab, because two would stack invisibly', () => {
  // The tab is a fixed layer over the whole page. Two of them is the second one on top
  // of the first with nothing on either saying which epic you are reading — so the
  // renderer takes the first it finds and the handler is what keeps the set to one.
  const html = board([CARD, OTHER], ['beadcause/bc-rfnr', 'beadcause/bc-p49x']);
  assert.equal((html.match(/class="p0-full"/g) || []).length, 1);
  const at = APP.indexOf("if (act === 'p0' || act === 'p0-close') {");
  assert.notEqual(at, -1, 'the P0 tap handler no longer takes the back button too');
  assert.match(APP.slice(at, at + 900), /state\.p0open\.clear\(\)/);
});

check('and the toggle writes state rather than poking the DOM', () => {
  // The one thing a rendered string cannot show: that the *tap* leaves no state anywhere
  // but the set. A branch that added a class to the card, or set `hidden` on the tree,
  // would pass every assertion above and fold up at the next poll.
  const at = APP.indexOf("if (act === 'p0' || act === 'p0-close') {");
  assert.notEqual(at, -1, 'the P0 tap handler is gone');
  const branch = APP.slice(at, at + 900);
  const body = branch.slice(0, branch.indexOf('\n    }'));
  assert.match(body, /state\.p0open\.(add|clear)/);
  assert.match(body, /render\(true\)/);
  assert.ok(!/classList|\.hidden|innerHTML/.test(body), 'the tap is reaching into the DOM');
  // The one DOM read it does make, and it is *after* the repaint rather than instead of
  // one: opening the tab leaves the keyboard on a button behind a full-screen layer and
  // closing it leaves the keyboard on a button that no longer exists, so focus is moved
  // to the layer's way out and handed back to the card it came from. bc-grut.
  assert.match(body, /\.p0-full \.p0-back/);
  assert.match(body, /\.p0-tap/);
  assert.ok(body.indexOf('render(true)') < body.indexOf('querySelector'), 'focus is moved before the repaint');
});

check('Escape is a way out of the tab, and never dismisses two things at once', () => {
  // The back button is reachable by Tab; a reader who opened the tab with a pointer has
  // no key that does anything without this. Behind the menus and only when neither was
  // open, because a menu drawn over the tab is the nearer of the two.
  const at = APP.indexOf("if (ev.key !== 'Escape') return;");
  assert.notEqual(at, -1, 'the Escape handler is gone');
  const body = APP.slice(at, at + 1200);
  assert.match(body, /const hadMenu = Boolean\(state\.agentMenu \|\| state\.menu\)/);
  assert.match(body, /if \(!hadMenu && state\.p0open\.size\)/);
  assert.match(body, /state\.p0open\.clear\(\)/);
});

check('where you had scrolled inside the tab survives the poll that rebuilds it', () => {
  // The tab is its own scroller and is not a `.card`, so `capturePlace`'s anchor cannot
  // see it — and it lives inside the one reconcile chunk that any moved count on the
  // board replaces whole. Without this, a 25-second poll drops you back at the top of a
  // sixty-row tree. bc-grut.
  assert.match(APP, /p0Top: listEl\.querySelector\('\.p0-full-body'\)\?\.scrollTop \|\| 0/);
  const at = APP.indexOf('function restorePlace(place)');
  assert.notEqual(at, -1, 'restorePlace is gone');
  const fn = APP.slice(at, at + 1400);
  assert.match(fn, /p0body\.scrollTop = place\.p0Top/);
  // Before the early return for a board with no inbox card under it to anchor on, which
  // is exactly the screen a P0 tab is most often over.
  assert.ok(fn.indexOf('place.p0Top') < fn.indexOf('if (!place.key) return;'), 'the tab is restored after the early return');
});

check('the board is still one reconcile chunk, which is why the set has to exist', () => {
  assert.match(APP, /chunks\.push\(\{ key: '@p0', html: roots \}\)/);
});

console.log('\nthe section no longer folds');

check('the heading says what the section is, and is not a control', () => {
  const html = board([CARD, OTHER]);
  assert.match(html, /<h2 class="p0-kind">/);
  assert.match(html, /Epics assigned to you/);
  // The old name, gone from the screen and from what a screen reader announces for the
  // region — both, because half a rename is a section that reads one way and is called
  // another.
  assert.ok(!html.includes('Your P0s'), 'the board still calls itself Your P0s');
  assert.match(html, /aria-label="Epics assigned to you"/);
});

check('there is nothing on the board that puts the board away — bc-khoe.28', () => {
  // The fold went with the list it revealed. My Epics is the board and nothing else, so a
  // control that hid the board would leave the view blank; persisted in `localStorage`, as
  // `beadcause.p0shut` was, it would have left it blank for good. All three ends of it are
  // asserted gone, because any one left behind is a dead branch that reads as live.
  const html = board([CARD, OTHER]);
  assert.ok(!html.includes('p0-fold'), 'the board is still drawing a fold control');
  // The heading alone — every card on the board is a disclosure of its own and keeps its
  // `aria-expanded`, so a search over the whole section would never fail.
  const head = html.slice(html.indexOf('<h2 class="p0-kind">'), html.indexOf('</h2>'));
  assert.ok(head, 'the section has no heading at all');
  assert.ok(!head.includes('aria-expanded'), 'the heading is still a disclosure');
  assert.ok(!head.includes('<button'), 'the heading is still a button');
  // Both ends of the state, and by shape rather than by token: the comment above
  // `p0SectionHtml` names the key it used to write, and a bare search would find that and
  // read the removal as incomplete.
  assert.ok(!/state\.p0shut/.test(APP), 'public/app.js still carries the fold state');
  assert.ok(!/(get|set)Item\('beadcause\.p0shut'/.test(APP), 'the fold is still persisted');
});

check('and the cards, the picker and the open tab are always drawn with it', () => {
  // What the fold used to take away. There is no state left that can hide any of them, so
  // this is the claim that replaces "shut, the cards are gone": the board is one thing.
  const html = board([CARD, OTHER], ['beadcause/bc-rfnr']);
  assert.ok(html.includes('p0-card'), 'the board drew no cards');
  assert.ok(html.includes('The inbox is an epic board'), 'the board drew no titles');
  assert.ok(html.includes('p0-tree'), 'the open epic lost its tree');
  assert.match(html, /class="p0-kind-n">2</);
});

check('the list under the board is the render’s business, not the board’s', () => {
  // `underOwnedRoots` removes your epics' descendants from the inbox, and it reads the
  // board *data*. Which view is up is `render`'s decision (`boardHere`/`listHere`,
  // bc-khoe.28) and must not reach in here: a filter that knew which pill was lit would
  // mean the rows on Questions depended on where you had been, not on what is waiting.
  const at = APP.indexOf('function underOwnedRoots(rows)');
  assert.notEqual(at, -1, 'underOwnedRoots is gone');
  const fn = APP.slice(at, APP.indexOf('\n  }', at));
  assert.ok(!/boardHere|listHere|inboxFilter/.test(fn), 'the inbox filter is reading which view is up');
});

console.log('\none status filter, in the tab with the tree it narrows');

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

check('THE FILTER CANNOT HIDE A QUESTION — bc-rfnr.9.7', () => {
  // `Closed` is one tap, and before this it took every open question in the tracker off
  // the screen with it: the tree is the only place a question is drawn now, so a filter
  // that could exclude one is a filter that loses it. The row is still drawn as itself.
  const html = board([CARD], ['beadcause/bc-rfnr'], 'closed');
  assert.match(html, />bc-rfnr\.9\.2\.1</, 'the closed filter took the pending bead away');
  assert.match(html, /asks you/);
  // Its ancestors come with it, for the reason every kept row's do — a row indented under
  // whatever happened to precede it reads as a different bead's child.
  assert.match(html, />bc-rfnr\.9</);
  assert.match(html, />bc-rfnr\.9\.2</);
  // And it is genuinely the filter that is on: the pending row is kept *on its own*
  // where every other open bead in this tree is kept only as scaffolding.
  assert.ok(!/\bvia\b/.test(rowClass(html, 'bc-rfnr.9.2.1')), 'the question is drawn as context');
  assert.match(rowClass(html, 'bc-rfnr.9.2.1.1'), /\bvia\b/, 'the closed filter stopped filtering');
  assert.match(rowClass(html, 'bc-rfnr.9'), /\bvia\b/);
});

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
    const html = board([MIX], ['beadcause/bc-mix'], stored);
    assert.ok(html.includes('bc-mix.1.1'), `a stored \`${stored}\` drew an empty tree`);
    assert.equal(chips(html).find((c) => c.on)?.id, 'live', `a stored \`${stored}\` pressed the wrong chip`);
  }
  assert.match(APP, /p0status: localStorage\.getItem\('beadcause\.p0status'\) \|\| 'live'/);
});

check('one control, at the top of the tab and above the tree it narrows', () => {
  // It sat above the cards while the trees were on the board (bc-rfnr.9.6). The trees
  // are in the tab now, so the board is exactly the place its effect cannot be seen —
  // and a control over things that are not on screen is one you set and cannot read.
  const html = board([MIX], ['beadcause/bc-mix']);
  assert.equal(chips(html).length, 3, 'the open epic is not drawing exactly one filter');
  const at = html.indexOf('p0-status');
  assert.ok(at > html.indexOf('class="p0-full"'), 'the filter is drawn outside the tab');
  assert.ok(at < html.indexOf('class="p0-tree"'), 'the filter is drawn below the tree it narrows');
  // And nothing is left on the board itself, on a screen with nothing open.
  assert.equal(chips(board([CARD, MIX])).length, 0, 'the board is still drawing a filter');
});

check('the pick is one pick, and whichever epic you open next obeys it', () => {
  // Still `state.p0status`, still persisted, still asked once — what moved is only where
  // you reach it. So it cannot be per-card by accident: opening either epic under the
  // same stored pick gives the same answer.
  assert.ok(
    board([CARD, MIX], ['beadcause/bc-rfnr'], 'closed').includes('bc-rfnr.9.2.1.1.1'),
    'the first epic ignored the stored pick'
  );
  assert.ok(
    board([CARD, MIX], ['beadcause/bc-mix'], 'closed').includes('bc-mix.2.1'),
    'the second epic ignored the stored pick'
  );
});

check('selecting closed shows closed descendants with their ancestors intact', () => {
  const html = board([CARD], ['beadcause/bc-rfnr'], 'closed');
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
  const html = board([CARD], ['beadcause/bc-rfnr'], 'closed');
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
  const closed = board([MIX], ['beadcause/bc-mix'], 'closed');
  assert.ok(closed.includes('>bc-mix.2<'), 'an open parent was dropped and its closed child orphaned');
  assert.ok(closed.includes('>bc-mix.2.1<'));
  // And nothing that neither matched nor holds anything up comes along for the ride.
  assert.ok(!closed.includes('>bc-mix.3<'), 'a blocked leaf is drawn under the closed filter');
});

check('every chip says what it would leave you with, counted over the epic in front of you', () => {
  const html = board([MIX, LANDED], ['beadcause/bc-mix']);
  const by = Object.fromEntries(chips(html).map((c) => [c.id, c.count]));
  // `MIX` alone — five beads, two of them closed. Counted across the board it would be
  // seven and four, and "Closed 4" over a tree with two closed rows in it is the count
  // doing the one thing it exists to prevent: sending you to a screen it promised had
  // something on it. bc-grut.
  assert.equal(by.all, 5);
  assert.equal(by.closed, 2);
  assert.equal(by.live, 3);
  assert.ok(!chips(html).some((c) => c.count === 7), "the chips are counting the board rather than the epic");
  // Counted on what matched, not on what is drawn — the ancestors kept for context are
  // scaffolding, and counting them would put "3" over a tree with two closed rows.
  assert.equal(by.closed, MIX.tree.filter((r) => r.status === 'closed').length);
});

check('the summary on the board does not move when the filter does', () => {
  // The line under the title used to be counted through the filter — "Tap for 3 of the 5
  // beads under it". With the control in the tab that would be a card whose numbers moved
  // because of something not on the screen, on a grid where nothing else moved at all. So
  // the collapsed card counts the whole tree and the filter cannot reach it. bc-grut.
  for (const pick of ['live', 'all', 'closed']) {
    assert.match(board([MIX], [], pick), /2 of 5 done/, `the card moved under \`${pick}\``);
  }
  // And an epic the filter empties still says so — inside the tab, where the control is,
  // rather than "nothing filed under it yet", which is the tracker's fact and not the
  // control's and is a different sentence to a reader deciding whether to break it down.
  const empty = board([LANDED], ['beadcause/bc-done']);
  assert.match(empty, /Nothing under bc-done matches the filter/);
  assert.ok(!empty.includes('Nothing filed under it yet'), 'a filtered-out tree reads as an epic nobody has broken down');
});

check('the pick is page state, persisted — so it survives a repaint and a reload', () => {
  const once = board([CARD, MIX], ['beadcause/bc-mix'], 'closed');
  const twice = board([CARD, MIX], ['beadcause/bc-mix'], 'closed');
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
  // `underOwnedRoots` is what the inbox is narrowed by. A bead you filtered out of a tree is
  // still a question you are being asked, and a status filter that reached the list would
  // hide it with nothing on screen to say where it went.
  const at = APP.indexOf('function underOwnedRoots(rows)');
  assert.notEqual(at, -1, 'underOwnedRoots is gone');
  assert.ok(!APP.slice(at, APP.indexOf('\n  }', at)).includes('p0status'), 'the inbox filter is reading the board filter');
});

check('the filter is in the tab, so a board with nothing open draws no chips', () => {
  // The chips moved into the tab with the tree they narrow (bc-grut), which is the whole
  // of why a collapsed board has none: a control over things that are not on screen is a
  // control you set and cannot see the effect of. Until bc-khoe.28 this was asserted
  // through the fold, which is one of the two ways to have no tab open; it is now the
  // only one.
  const shut = board([CARD, MIX]);
  assert.equal(chips(shut).length, 0, 'a board with no epic open is still drawing its filter');
  assert.ok(!shut.includes('p0-full'), 'a board with no epic open is still drawing a tab over it');
  assert.match(shut, /class="p0-kind-n">2</);
  assert.ok(board([CARD, MIX], ['beadcause/bc-mix']).includes('p0-full'), 'opening an epic lost its tab');
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
  const context = vm.createContext({ String, Number, Math, JSON, Date, encodeURIComponent, byKey: () => null, state: { rootboard: { owned: false, roots: [CARD] }, p0open: new Set(), space: 'all', workspace: 'all', spaces: [], p0opening: new Map() } });
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
      // bc-grut's collapsed summary: the counts a card carries when its tree is not on
      // the screen, and the bar that draws them.
      lift(APP, 'function p0Progress(card)'),
      lift(APP, 'function p0ProgressHtml(card)'),
      lift(APP, 'function p0RowHtml(card, row)'),
      lift(APP, 'function p0TreeHtml(card)'),
      // bc-d6yk's three-state control, which the acts row now calls rather than writing
      // a launch button by hand — and the local "just launched" note it reads.
      lift(APP, 'function openingHere(key)'),
      // bc-r2b5.2's four states. `p0Control` derives them once through `p0AdvState` so the
      // card, the tab and the advocate sheet cannot disagree about which one an epic is in;
      // `relTime` comes with them because "last looked 3h ago" is the half of an idle card
      // that makes idle readable, and `p0DoneHtml` because a finished epic offers the close
      // from the acts row rather than leaving it to be found in the inbox.
      lift(APP, 'function relTime(iso)'),
      lift(APP, 'function p0AdvState(c)'),
      lift(APP, 'function p0AdvWhen(s)'),
      lift(APP, 'function p0AdvLine(s)'),
      lift(APP, 'function p0DoneHtml(c)'),
      lift(APP, 'function p0AdvOpenHtml(c, s)'),
      lift(APP, 'function p0Control(c)'),
      lift(APP, 'const p0AsksHtml = '),
      lift(APP, 'function p0FaceHtml(c, asks, tail'),
      lift(APP, 'function p0ActsHtml(c, more'),
      lift(APP, 'function p0CardHtml(c)'),
      lift(APP, 'function p0FullHtml(c)'),
      lift(APP, 'const p0AsksN = ('),
      lift(APP, 'function p0Cards(list)'),
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

check('the cards are a grid that may be narrower than a bead title', () => {
  // bc-grut. `minmax(0, 1fr)` rather than `1fr` is the line this rests on: a grid track's
  // automatic minimum is its content, and a bead title is one unbroken 60-character
  // string often enough that plain `1fr` lets a column bid wider than its share and
  // pushes the third card off the row.
  const at = CSS.indexOf('.p0-cards { display: grid;');
  assert.notEqual(at, -1, 'public/style.css has no .p0-cards grid');
  assert.match(CSS.slice(at, CSS.indexOf('}', at)), /grid-template-columns: minmax\(0, 1fr\)/);
  // One across, two, then three — the acceptance of the bead, as three declarations.
  assert.match(CSS, /@media \(min-width: 640px\) \{ \.p0-cards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \} \}/);
  assert.match(CSS, /@media \(min-width: 960px\) \{ \.p0-cards \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
  // And the controls line up across a row rather than following each card's own last
  // line, which is what `margin-top: auto` in a stretched grid item buys.
  const acts = CSS.slice(CSS.indexOf('.p0-acts {'), CSS.indexOf('}', CSS.indexOf('.p0-acts {')));
  assert.match(acts, /margin-top: auto/);
  // And the other half of `minmax(0, 1fr)`, without which it buys nothing on the one title
  // that matters: the track keeps its share and the *text* runs out of it instead, so the
  // page grows a horizontal scrollbar and every card on the board pays for one bead title
  // with a path or a branch name in it.
  const title = CSS.slice(CSS.indexOf('.p0-title {'), CSS.indexOf('}', CSS.indexOf('.p0-title {')));
  assert.match(title, /overflow-wrap: anywhere/);
});

check('the tab is a fixed layer with its own scroller, at every height', () => {
  const at = CSS.indexOf('.p0-full {');
  assert.notEqual(at, -1, 'public/style.css has no .p0-full');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  // Fixed against the viewport, so it does not matter that it is drawn inside the board's
  // chunk inside `#list` — which it has to be, since every handler on this page is
  // delegated from that element.
  assert.match(rule, /position: fixed/);
  assert.match(rule, /inset: 0/);
  assert.match(rule, /z-index: 40/);
  // Opaque. This is a place you went, not a dialog over a place you were, and the inbox
  // showing through under a sixty-row tree is the cramped read bc-grut is about.
  assert.match(rule, /background: var\(--bg\)/);
  // The body scrolls, not the layer — and reaching the end of a tree stops rather than
  // starting to scroll the list behind it.
  const body = CSS.slice(CSS.indexOf('.p0-full-body {'), CSS.indexOf('}', CSS.indexOf('.p0-full-body {')));
  assert.match(body, /flex: 1 1 0/);
  assert.match(body, /min-height: 0/);
  assert.match(body, /overscroll-behavior: contain/);
  // And the acts row takes back the `auto` margin that is for a grid cell — in a flex
  // column already the height of the screen it would push the row off the bottom.
  const acts = CSS.slice(CSS.indexOf('.p0-full-acts {'), CSS.indexOf('}', CSS.indexOf('.p0-full-acts {')));
  assert.match(acts, /margin: 0/);
  assert.match(acts, /flex: none/);
});

check('the progress bar has a visible empty track, so nothing landed is not nothing drawn', () => {
  const at = CSS.indexOf('.p0-bar {');
  assert.notEqual(at, -1, 'public/style.css has no .p0-bar');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(rule, /background: var\(--line\)/);
  assert.match(rule, /overflow: hidden/);
  assert.match(CSS, /\.p0-bar-fill \{[^}]*background: var\(--accent\)/);
});

check('the heading is a label rather than a target, and the count sits at the far end', () => {
  const at = CSS.indexOf('.p0-kind {');
  assert.notEqual(at, -1, 'public/style.css has no .p0-kind');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(rule, /width: 100%/);
  // The thumb-sized height and the pointer went with the fold (bc-khoe.28). A line with
  // `cursor: pointer` and 44px of tappable space that does nothing when you press it is
  // worse than a plain heading, because the phone says it is a control.
  assert.ok(!/min-height: var\(--tap\)/.test(rule), 'the heading is still sized as a tap target');
  assert.ok(!/cursor: pointer/.test(rule), 'the heading still says it can be pressed');
  const n = CSS.slice(CSS.indexOf('.p0-kind-n {'), CSS.indexOf('}', CSS.indexOf('.p0-kind-n {')));
  assert.match(n, /margin-left: auto/);
});

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall good\x1b[0m (${ran})`}\n`);
process.exit(failures ? 1 : 0);
