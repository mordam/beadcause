#!/usr/bin/env node
/**
 * A bead in the tree expands in place to its full details.
 *
 *     npm test
 *     node test/p0bead.mjs
 *
 * bc-rfnr.9.4. The board has drawn every descendant of your epics since bc-rfnr.9.2, as
 * sixty rows carrying an id, a title, a status and a depth — and a tap on one of them
 * left the inbox for the graph. This is the half that opens the bead where it stands.
 * Seven things about that are worth a suite, and five of them fail quietly:
 *
 * 1. **It renders from bead data alone.** The app already had one full bead view — the
 *    inbox card — and it is built out of a *pending question*: parsed options, a box to
 *    answer in, a dismissal. Most beads under a P0 have never had a question and never
 *    will, so the card drawn over one would be a screen offering to answer something
 *    nobody asked. What a bead with no question does have is `bd show` and its thread,
 *    and that is what has to be enough. Asserted on a fixture carrying no `human` label,
 *    no decision block and no options at all.
 *
 * 2. **Children stay reachable while it is open** — the second half of the acceptance,
 *    and the one that is invisible in a screenshot of a leaf. The tree is flat and
 *    pre-order, so a bead's children are the rows *after* it: the expansion has to land
 *    between the row and its subtree rather than in place of it. Asserted on the
 *    document order of three things, because every other way of getting this wrong —
 *    replacing the rows, appending at the end of the tree, hiding the deeper ones —
 *    still leaves a page with all the beads on it.
 *
 * 3. **It survives the poll.** The board is one reconcile chunk keyed `@p0` and is
 *    replaced whole every 25 seconds, so an expansion held as a class on a node folds up
 *    under your thumb. `state.p0beadopen` is the only record; the renderer is a pure
 *    function of it, and the tap writes nothing else.
 *
 * 4. **Reading, refused and refreshing are three different screens.** A tap whose `bd`
 *    call has not landed says so — a blank expansion is indistinguishable from a tap
 *    that did nothing, which is a bug report about the tap. A tap that was refused says
 *    why. And a *refresh* over a bead already on screen draws neither: the text is still
 *    true, and taking it away to fetch a copy of the same text is the app losing your
 *    place for nothing.
 *
 * 5. **A close reason is drawn only while the bead is closed.** `bd` clears `closed_at`
 *    on a reopen and leaves `close_reason` sitting there, so the obvious spelling has a
 *    reopened bead carrying the reason it was closed last time as though it still
 *    applied — worse than drawing nothing at all. public/graph.js learned this once.
 *
 * 6. **The parent is not something the bead waits on.** `dependencies[]` carries the
 *    parent edge among the rest, which is why `dependency_count` cannot be printed as
 *    "waits on N" — a subtask waiting on nothing still counts the edge to its parent.
 *
 * 7. **Tracker text cannot write markup into the board.** A label, a title and a close
 *    reason are all text out of `bd`; the escaped form is asserted present, not merely
 *    the raw tag absent.
 *
 * 8. **And the one bead that *is* a question is answerable from here** (bc-rfnr.9.7).
 *    Point 1 above is still true and this is not a retraction of it: the expansion draws
 *    a bead, and what it grew is one control that opens the inbox card the app already
 *    has. Two ways that goes wrong quietly — a button offered over a bead the payload has
 *    no row for, which is `expand` returning early and a tap that does nothing; and the
 *    same button over a bead an *agent* has, which is "Answer it" promising a question
 *    nobody asked.
 *
 * No browser, no `bd`, no network. The renderers touch no DOM — they return a string —
 * so they are sliced out of public/app.js and run in a `node:vm`. `renderMarkdown` is
 * stubbed, as test/graphsheet.mjs stubs `md`: it needs `marked` and `DOMPurify` off the
 * window, and what it does with a paragraph is not this suite's claim.
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
 * Lift one declaration out of public/app.js — test/p0card.mjs's, with the parameter list
 * skipped.
 *
 * The difference matters for exactly one of the declarations below and it is silent:
 * `commentHtml(c, { shut = false, … } = {})` destructures its second argument, so the
 * first `{` after the name is a *parameter* and a lifter that starts balancing there
 * stops at the end of the parameter list with a fragment that parses. So the parameters
 * are walked as parentheses first, and the body is the brace after them.
 */
function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  if (opener.startsWith('function')) {
    let depth = 0;
    let i = src.indexOf('(', at);
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (!depth) break;
      }
    }
    depth = 0;
    for (let j = src.indexOf('{', i); j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') {
        depth -= 1;
        if (!depth) return src.slice(at, j + 1);
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

/* --------------------------------------------------------------- the fixtures */

/**
 * One epic with four descendants, three levels deep — the shape `rootCard` sends. Two of
 * them are siblings so that "the expansion goes between a bead and its children" is a
 * claim about order rather than about the end of a list.
 */
const CARD = {
  key: 'beadcause/bc-rfnr',
  workspace: 'beadcause',
  id: 'bc-rfnr',
  title: 'The inbox is a epic board',
  status: 'open',
  issue_type: 'epic',
  open: 4,
  inFlight: 0,
  waitingOn: null,
  tree: [
    { id: 'bc-rfnr.9', title: 'A P0 card is the board', status: 'open', parent: 'bc-rfnr', depth: 1, key: 'beadcause/bc-rfnr.9', pending: false },
    { id: 'bc-rfnr.9.2', title: 'The card summarises collapsed', status: 'closed', parent: 'bc-rfnr.9', depth: 2, key: 'beadcause/bc-rfnr.9.2', pending: false },
    { id: 'bc-rfnr.9.2.1', title: 'Which way should the caret point?', status: 'open', parent: 'bc-rfnr.9.2', depth: 3, key: 'beadcause/bc-rfnr.9.2.1', pending: true },
    { id: 'bc-rfnr.9.4', title: 'A bead expands in place', status: 'in_progress', parent: 'bc-rfnr.9', depth: 2, key: 'beadcause/bc-rfnr.9.4', pending: false },
  ],
};

/**
 * What `/api/bead` answers for a bead nobody is asking anything about — `bd show` plus
 * its thread, and not one field the inbox card's decision half would look for.
 */
const BEAD = {
  workspace: 'beadcause',
  id: 'bc-rfnr.9.2',
  title: 'The card summarises collapsed',
  status: 'closed',
  priority: 1,
  issue_type: 'feature',
  owner: 'neadamthal@gmail.com',
  labels: ['inbox', 'phone', 'owner:neadamthal@gmail.com', 'held:20260815T200152Z:neadamthal@gmail.com'],
  description: 'The card carries the counts collapsed and the whole tree expanded.',
  acceptance_criteria: 'Tapping a P0 opens its descendants at every depth.',
  notes: 'The indent is capped at three steps.',
  close_reason: 'Landed as #243 as e8315969 — still owed: CAN BE DEPLOYED',
  closed_at: '2026-08-14T12:00:00.000Z',
  dependent_count: 2,
  parent: 'bc-rfnr.9',
  dependencies: [
    { id: 'bc-rfnr.9', title: 'A P0 card is the board', status: 'open', dependency_type: 'parent-child' },
    { id: 'bc-rfnr.9.1', title: 'The server sends the tree', status: 'closed', dependency_type: 'blocks' },
    { id: 'bc-d6yk', title: 'The card says where its advocate is', status: 'closed', dependency_type: 'relates-to' },
  ],
  comments: [
    { id: 'c1', author: 'beadcause', text: 'Queued #243.', created_at: '2026-08-14T11:00:00.000Z' },
    { id: 'c2', author: 'worker (adam)', text: 'The pills wrapped onto a line of their own.', created_at: '2026-08-14T11:30:00.000Z' },
  ],
};

/** The board, drawn for real, out of a page state you hand it. */
function board({
  open = ['beadcause/bc-rfnr'],
  beadopen = [],
  detail = new Map(),
  cards = [CARD],
  // Which keys the inbox payload has a row for — what `byKey` answers. Empty is the
  // honest default for this suite's fixture: `BEAD` is a closed feature nobody is being
  // asked about, and the answer control is not offered over one. bc-rfnr.9.7.
  asked = [],
} = {}) {
  const state = {
    rootboard: { owned: true, roots: cards, under: {} },
    p0open: new Set(open),
    p0beadopen: new Set(beadopen),
    p0beaddetail: detail,
    // `all`, so bc-rfnr.9.6's status filter narrows nothing here. This suite is about what
    // a row expands *into*, and its fixture tree is deliberately a mix of open and closed
    // beads; under the board's own default those closed rows would simply be absent and
    // half of these checks would pass by drawing nothing. What the filter does is
    // test/p0card.mjs's, over a fixture built for it.
    p0status: 'all',
    space: 'all',
    workspace: 'all',
    spaces: [],
    p0opening: new Map(),
    // bc-s8mc: the picker is shut in this suite. See the lift below.
    p0picker: false,
    // What the thread's own collapse is remembered in. Empty, so every comment starts
    // in whatever state `openThreadIndexes` decided for it.
    thread: new Map(),
    // bc-rfnr.9.5's two sources. `board: null` and an empty archive map are what a page
    // that has just booted holds, so every bead in this suite draws the section in its
    // "still reading" state — which is what keeps these checks about the bead rather
    // than about what happened to it. test/p0happened.mjs is where that is asserted.
    board: null,
    p0beadarc: new Map(),
  };
  const context = vm.createContext({
    // public/prcard.js's rung pill, which `p0PrRowHtml` asks for and does without. Absent
    // here on purpose: this suite has no board, so no pull request row is ever drawn.
    window: {},
    String,
    Number,
    Math,
    JSON,
    Date,
    Set,
    Map,
    Array,
    encodeURIComponent,
    state,
    // Stubbed, and visibly so: what the renderer hands to markdown is asserted, what
    // markdown makes of it is not this file's business. See the header.
    renderMarkdown: (t) => `<md>${String(t)}</md>`,
    // The inbox row resolver, stubbed to a set of keys. The real one walks
    // `state.requests`, `state.questions`, `prRows()` and `ticketRowFor` — none of which
    // this suite has or wants; what `p0AnswerHtml` asks it is one question, "is there a
    // row here I could open", and `agent: true` is the second thing it looks at.
    byKey: (k) => {
      const hit = asked.find((r) => (typeof r === 'string' ? r : r.key) === k);
      return hit ? (typeof hit === 'string' ? { key: k } : hit) : null;
    },
  });
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'const cardId = ('),
      lift(APP, 'const spaceForWorkspace = ('),
      lift(APP, 'const STATUS_LABEL = '),
      lift(APP, 'function relTime(iso)'),
      lift(APP, 'function graphUrl(q)'),
      lift(APP, 'const FROM_BD = '),
      // The thread, whole, because the expansion draws the real one: a bead's comments
      // are half of what you open it for, and a stub would leave the claim untested.
      lift(APP, 'const bylineBase = ('),
      lift(APP, 'const fromMe = ('),
      lift(APP, 'const peek = ('),
      lift(APP, 'function openThreadIndexes(comments)'),
      lift(APP, 'const commentId = ('),
      lift(APP, 'const isShut = ('),
      lift(APP, 'function commentHtml(c,'),
      lift(APP, 'function threadHtml(q)'),
      lift(APP, 'const P0_INDENT_CAP = '),
      lift(APP, 'const P0_SECTION_LABEL = '),
      // bc-rfnr.9.6's filter, lifted whole because `p0TreeHtml` narrows through
      // `p0Visible` and `p0SectionHtml` draws the chips — half of it is a `ReferenceError`
      // that reads as this bead's expansion being broken.
      lift(APP, 'const P0_STATUS_FILTERS = '),
      lift(APP, 'function p0StatusFilter()'),
      lift(APP, 'function p0Visible(rows)'),
      lift(APP, 'function p0StatusHtml(cards)'),
      // bc-grut's collapsed summary, which `p0CardHtml` draws on every render.
      lift(APP, 'function p0Progress(card)'),
      lift(APP, 'function p0ProgressHtml(card)'),
      lift(APP, 'const p0RowKey = ('),
      lift(APP, 'const p0Step = ('),
      lift(APP, 'function p0RowHtml(card, row)'),
      lift(APP, 'const P0_RELATED_EDGES = '),
      lift(APP, 'function p0Relations(b)'),
      lift(APP, 'function p0RelGroupHtml(workspace, label, rows)'),
      lift(APP, 'function p0ClosedHtml(b)'),
      lift(APP, 'function p0BeadHtml(card, row)'),
      // bc-rfnr.9.7's way in to answering, and the section's two counters. `byKey` is a
      // stub in the context above rather than a lift: the real one reaches `prRows` and
      // `ticketRowFor` and half the payload with them, and what this suite is asserting
      // is that the control is offered for a row the inbox has and withheld for one it
      // does not.
      lift(APP, 'function p0AnswerHtml(workspace, b)'),
      // bc-rfnr.9.5's trail out of the tracker, which `p0BeadBodyHtml` now draws on
      // every bead — half of it missing is a `ReferenceError` that reads as the whole
      // expansion being broken.
      lift(APP, 'function p0PrsFor(id)'),
      lift(APP, 'function p0PrRowHtml(p)'),
      lift(APP, 'function p0SessionRowsHtml(workspace, id, row, arc)'),
      lift(APP, 'function p0HappenedHtml(card, b)'),
      lift(APP, 'function p0BeadBodyHtml(card, b)'),
      lift(APP, 'function p0TreeHtml(card)'),
      lift(APP, 'function openingHere(key)'),
      // bc-r2b5.2's four states, which `p0Control` derives through `p0AdvState`. `relTime`
      // is already lifted above for the archive rows and is what the idle line reads from.
      lift(APP, 'function p0AdvState(c)'),
      lift(APP, 'function p0AdvWhen(s)'),
      lift(APP, 'function p0AdvLine(s)'),
      lift(APP, 'function p0DoneHtml(c)'),
      lift(APP, 'function p0AdvOpenHtml(c, s)'),
      lift(APP, 'function p0Control(c)'),
      // bc-grut: the section is a grid cell, the tab a tap opens, and the head they share.
      lift(APP, 'const p0AsksHtml = '),
      lift(APP, 'function p0FaceHtml(c, asks, tail'),
      lift(APP, 'function p0ActsHtml(c, more'),
      lift(APP, 'function p0CardHtml(c)'),
      lift(APP, 'function p0FullHtml(c)'),
      // bc-rfnr.9.7's two, which the section reaches for once the flat list is gone.
      lift(APP, 'const p0AsksN = ('),
      lift(APP, 'function p0Cards(list)'),
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

/** The board with one bead open and its details already in hand. */
const opened = (bead = BEAD, id = 'bc-rfnr.9.2', asked = []) =>
  board({
    beadopen: [`beadcause/${id}`],
    detail: new Map([[`beadcause/${id}`, { loading: false, bead }]]),
    asked,
  });

console.log('\na bead with no question, in full');

check('the details are drawn from bead data alone — no question, no options, no answer box', () => {
  const html = opened();
  assert.match(html, /<md>The card carries the counts collapsed and the whole tree expanded\.<\/md>/);
  assert.match(html, /<div class="section-label">acceptance<\/div>/);
  assert.match(html, /<md>Tapping a P0 opens its descendants at every depth\.<\/md>/);
  assert.match(html, /<div class="section-label">notes<\/div>/);
  // Nothing from the card's decision half. Those are the four things that would say the
  // renderer had been built out of a pending question rather than out of a bead.
  for (const trace of ['freeform', 'data-act="answer"', 'data-act="dismiss"', 'option-btn']) {
    assert.ok(!html.includes(trace), `the expansion is drawing the question card's ${trace}`);
  }
});

check('what the row could not carry: priority, type, owner and every label', () => {
  const html = opened();
  const block = html.slice(html.indexOf('class="p0-bead"'));
  assert.match(block, /<span class="pill">P1<\/span>/);
  assert.match(block, /<span class="pill">feature<\/span>/);
  // The local part only — the domain is the same on every bead in the tracker.
  assert.match(block, /<span class="pill">neadamthal<\/span>/);
  assert.match(block, /<span class="pill lbl">inbox<\/span>/);
  // A lease is drawn as the tracker holds it. Shortened to the word `held` it would no
  // longer be the label, and this is the screen you come to for what a bead carries.
  assert.match(block, /held:20260815T200152Z:neadamthal@gmail\.com/);
  // And not the owner label, which is the pill above it at four times the width.
  assert.ok(!block.includes('owner:neadamthal'), 'the owner is drawn twice');
});

check('the thread is the real one, collapsed the way the card collapses it', () => {
  const html = opened();
  assert.match(html, /<div class="section-label">Thread<\/div>/);
  assert.match(html, /<md>Queued #243\.<\/md>/);
  // The agent's own stripe, off the byline and not off a flag — the same test
  // `.from-agent` has always been painted from.
  assert.match(html, /class="comment from-agent"[^>]*data-comment="beadcause\/bc-rfnr\.9\.2\|c2"/);
  // Keyed by the bead, so a comment you opened here and the same comment on the card
  // are one thing rather than two that disagree.
  assert.match(html, /data-comment="beadcause\/bc-rfnr\.9\.2\|c1"/);
});

check('the graph is still one tap away — on the bead you opened, not the card above it', () => {
  const html = opened();
  const block = html.slice(html.indexOf('class="p0-bead"'));
  assert.match(block, /class="p0-graph" href="\/graph\?ws=beadcause&amp;id=bc-rfnr\.9\.2&amp;open=1"/);
});

console.log('\nand a question is answerable from the bead it is on — bc-rfnr.9.7');

check('a bead the inbox has a row for offers the way in to answering it', () => {
  // The whole of bc-rfnr.9.7's second half. `expand(key)` is what the list's own toggle
  // calls, and `.card.open` is a full-screen sheet — so the tap does not need the row to
  // be on the screen underneath, only on the payload. What is asserted here is that the
  // control is offered and carries the key `expand` will be handed.
  const html = opened(BEAD, 'bc-rfnr.9.2', ['beadcause/bc-rfnr.9.2']);
  const block = html.slice(html.indexOf('class="p0-bead"'));
  assert.match(block, /<button type="button" class="p0-answer" data-act="p0-answer" data-key="beadcause\/bc-rfnr\.9\.2">/);
  // Before the graph, which is the order of how much the two are worth.
  assert.ok(
    block.indexOf('p0-answer') < block.indexOf('p0-graph'),
    'the way out to the graph is offered ahead of the way in to answering'
  );
});

check('and a bead with no row on the payload offers nothing rather than a dead button', () => {
  // `/api/questions?scope=agent` sweeps no questions at all, so a pending bead can be
  // marked in the tree with nothing for `expand` to open. A button that did nothing is
  // worse than no button — it reads as a tap that missed.
  assert.ok(!opened().includes('p0-answer'), 'a bead the inbox has never heard of was offered an answer box');
});

check('nor does a bead an agent has, which is not a question anybody asked', () => {
  const html = opened(BEAD, 'bc-rfnr.9.2', [{ key: 'beadcause/bc-rfnr.9.2', agent: true }]);
  assert.ok(!html.includes('p0-answer'), '"Answer it" was offered over a bead an agent is working');
});

check('the tap is `expand` and nothing else — the inbox card is not rebuilt in the tree', () => {
  const at = APP.indexOf("if (act === 'p0-answer') {");
  assert.notEqual(at, -1, 'the answer handler is gone');
  const branch = APP.slice(at, at + 900);
  const body = branch.slice(0, branch.indexOf('\n    }'));
  assert.match(body, /await expand\(btn\.dataset\.key\)/);
  // No place-holding around it: `.card.open` covers the page, so where the page happens
  // to be scrolled to underneath it is not something anybody can see.
  assert.ok(!body.includes('keepTheScreenStill'), 'the tap is holding a page it is about to cover');
  // And nothing that draws a second answer surface. The one write it gained since
  // bc-r2b5.2 is `state.p0adv = null`, which puts the *advocate* sheet away — that layer
  // is `z-index: 41` and `.card.open` is 40, so a close offered from inside it would open
  // the card underneath and read as a tap that did nothing.
  assert.match(body, /state\.p0adv = null;/, 'the answer opens under the advocate sheet');
  assert.ok(!/innerHTML|optionsHtml|cardHtml\(/.test(body), 'the tap is rebuilding the inbox card in the tree');
});

check('and the row it opens is kept in the list for exactly as long as the card is up', () => {
  // The seam that makes the sheet possible at all: `underOwnedRoots` removes every bead the
  // board draws, and would remove this one out from under `expand` a millisecond after it
  // ran. test/ownquestion.mjs drives the filter itself; this is the line existing.
  assert.match(APP, /if \(state\.open\?\.has\(q\.key\)\) return true;/);
});

console.log('\nthe children stay reachable');

check('the expansion lands between a bead and its children, and nothing else moves', () => {
  const html = opened();
  const row = html.indexOf('data-p0bead="beadcause/bc-rfnr.9.2"');
  const block = html.indexOf('id="p0bead-beadcause_bc-rfnr_9_2"');
  const kid = html.indexOf('data-p0bead="beadcause/bc-rfnr.9.2.1"');
  const sibling = html.indexOf('data-p0bead="beadcause/bc-rfnr.9.4"');
  assert.notEqual(block, -1, 'the expansion is not on the page');
  assert.ok(row < block, 'the expansion is drawn above its own row');
  assert.ok(block < kid, 'the expansion is drawn below the child it belongs above');
  assert.ok(kid < sibling, 'the tree is no longer in pre-order');
  // Every row that was there before is still there. The failure this rules out is the
  // one that looks fine on a leaf: an expansion that replaces the rows under it.
  for (const r of CARD.tree) assert.ok(html.includes(`data-p0bead="beadcause/${r.id}"`), `${r.id} left the tree`);
});

check('the child is still indented deeper than the bead that is open', () => {
  const html = opened();
  const step = (id) => {
    const at = html.indexOf(`data-p0bead="beadcause/${id}"`);
    assert.notEqual(at, -1, `no row for ${id}`);
    const m = /--d:(\d+)/.exec(html.slice(html.lastIndexOf('<button', at), at + 200));
    return Number(m[1]);
  };
  assert.equal(step('bc-rfnr.9.2'), 1);
  assert.equal(step('bc-rfnr.9.2.1'), 2, 'the open bead flattened its own child');
  // And the block itself sits at its row's step, so it reads as belonging to the row
  // above it rather than to the level below.
  const block = html.slice(html.indexOf('id="p0bead-beadcause_bc-rfnr_9_2"'));
  assert.match(block.slice(0, 120), /--d:1/);
});

check('two beads can be open at once — it is not an accordion', () => {
  const html = board({
    beadopen: ['beadcause/bc-rfnr.9.2', 'beadcause/bc-rfnr.9.4'],
    detail: new Map([['beadcause/bc-rfnr.9.2', { loading: false, bead: BEAD }]]),
  });
  assert.match(html, /id="p0bead-beadcause_bc-rfnr_9_2"/);
  assert.match(html, /id="p0bead-beadcause_bc-rfnr_9_4"/);
  // The reason it must not be one: an expanded bead keeps its children under it, and
  // an accordion would close the parent the moment you opened one of them.
  assert.equal((html.match(/class="p0-bead"/g) || []).length, 2);
});

check('a shut row claims nothing, and an open one names the block it controls', () => {
  const html = opened();
  const shut = html.slice(html.indexOf('data-p0bead="beadcause/bc-rfnr.9.4"') - 300);
  assert.match(shut, /data-p0bead="beadcause\/bc-rfnr\.9\.4"[^>]*aria-expanded="false"/);
  assert.match(html, /data-p0bead="beadcause\/bc-rfnr\.9\.2"[^>]*aria-expanded="true" aria-controls="p0bead-beadcause_bc-rfnr_9_2"/);
  assert.equal((html.match(/aria-controls="p0bead-/g) || []).length, 1);
});

console.log('\nreading, refused, refreshing');

check('a tap whose bd call has not landed says so rather than opening on a gap', () => {
  const html = board({ beadopen: ['beadcause/bc-rfnr.9.2'] });
  assert.match(html, /class="p0-bead-note">Reading bc-rfnr\.9\.2 from bd…<\/div>/);
});

check('a refusal is a sentence naming the bead, not a blank block', () => {
  const html = board({
    beadopen: ['beadcause/bc-rfnr.9.2'],
    detail: new Map([['beadcause/bc-rfnr.9.2', { loading: false, error: 'no such bead: bc-rfnr.9.2' }]]),
  });
  assert.match(html, /class="p0-bead-note bad">bc-rfnr\.9\.2 would not open — no such bead/);
});

check('a refresh over a bead already on screen keeps the text you were reading', () => {
  // The whole point of holding the previous copy: re-opening a bead paints instantly
  // and corrects itself a second later, rather than blanking what you had.
  const html = board({
    beadopen: ['beadcause/bc-rfnr.9.2'],
    detail: new Map([['beadcause/bc-rfnr.9.2', { loading: true, bead: BEAD }]]),
  });
  assert.match(html, /<md>The card carries the counts collapsed/);
  assert.ok(!html.includes('from bd…'), 'a refresh took the bead off the screen to fetch the same bead');
});

check('a failed refresh keeps the bead and does not shout over it', () => {
  const html = board({
    beadopen: ['beadcause/bc-rfnr.9.2'],
    detail: new Map([['beadcause/bc-rfnr.9.2', { loading: false, bead: BEAD, error: 'fetch failed' }]]),
  });
  assert.match(html, /<md>The card carries the counts collapsed/);
  assert.ok(!html.includes('would not open'), 'a daemon that went away blanked a bead you were reading');
});

console.log('\nhow it ended, and what it waits on');

check('a closed bead says why, and when', () => {
  const html = opened();
  assert.match(html, /class="p0-bead-closed"/);
  assert.match(html, /<md>Landed as #243 as e8315969 — still owed: CAN BE DEPLOYED<\/md>/);
  assert.match(html, /class="p0-bead-when">Closed /);
});

check('a reopened bead does not carry the reason it closed the last time', () => {
  // `bd` clears `closed_at` on a reopen and leaves `close_reason` where it was, so the
  // obvious spelling has an open bead explaining how it finished.
  const html = opened({ ...BEAD, status: 'open', closed_at: null }, 'bc-rfnr.9.2');
  assert.ok(!html.includes('p0-bead-closed'), 'a reopened bead is drawing its old close reason');
  assert.ok(!html.includes('still owed: CAN BE DEPLOYED'));
});

check('the parent is the parent — never something the bead is waiting on', () => {
  const html = opened();
  const rel = html.slice(html.indexOf('class="p0-rel"'), html.indexOf('<md>The card carries'));
  assert.match(rel, /Parent<\/span>[\s\S]*bc-rfnr\.9</);
  assert.match(rel, /Waits on<\/span>[\s\S]*bc-rfnr\.9\.1</);
  assert.match(rel, /Related<\/span>[\s\S]*bc-d6yk</);
  // The count bd sends is over every edge including the parent's, which is why the
  // rows are split rather than counted: a subtask waiting on nothing counts one.
  assert.ok(!rel.includes('waits on 3'), 'the edges were counted instead of split');
  const waits = rel.slice(rel.indexOf('Waits on'), rel.indexOf('Related'));
  assert.ok(!waits.includes('bc-rfnr.9<'), 'the parent is drawn as something the bead waits on');
});

check('a bead with no edges at all draws no headings', () => {
  const html = opened({ ...BEAD, dependencies: [], parent: null }, 'bc-rfnr.9.2');
  assert.ok(!html.includes('p0-rel-kind'), 'an edgeless bead drew an empty relations block');
});

console.log('\nwhat survives, and what cannot get in');

check('the same state renders the same board — an open bead survives a repaint', () => {
  const once = opened();
  const twice = opened();
  assert.equal(once, twice);
  assert.ok(once.includes('p0-bead'), 'the repaint lost the expansion');
});

check('the tap writes state and fetches — it pokes no DOM', () => {
  const at = APP.indexOf("if (act === 'p0-bead') {");
  assert.notEqual(at, -1, 'the row tap handler is gone');
  const body = APP.slice(at, APP.indexOf('\n    }\n', at));
  assert.match(body, /state\.p0beadopen\.(add|delete)/);
  assert.match(body, /keepTheScreenStill\(\(\) => render\(true\)\)/);
  assert.match(body, /loadBeadDetail\(/);
  assert.ok(!/classList|\.hidden|innerHTML|querySelector/.test(body), 'the tap is reaching into the DOM');
});

check('and it holds the page still, then stops the anchor putting it back', () => {
  // `capturePlace` anchors on the first card in the list, so an expansion opening above
  // that card scrolls the page down by its own height and the row you tapped leaves the
  // screen — measured 0 → 486 at 393×852. Holding the offset is exact rather than
  // approximate because nothing above the row changes height. scripts/p0bead-check.mjs
  // is what proves it in a browser; this is the shape of the fix.
  const at = APP.indexOf('function keepTheScreenStill(paint)');
  assert.notEqual(at, -1, 'keepTheScreenStill is gone');
  const fn = APP.slice(at, APP.indexOf('\n  }\n', at));
  assert.match(fn, /const was = docScroller\(\)\.scrollTop;/);
  assert.match(fn, /docScroller\(\)\.scrollTop = was;/);
  // Without this, `settlePlace` restores the anchor's answer on the next frame and on
  // every late image, and the correction lasts one frame.
  assert.match(fn, /releasePlace\(\);/);
});

check('the details are fetched on the tap and never on the poll', () => {
  // One `bd show` per deliberate tap is the bargain; one per open bead every 25 seconds
  // is a phone parked on the inbox spawning `bd` forever. Two callers and both are taps:
  // the row's own (bc-rfnr.9.4) and the advocate sheet's (bc-r2b5.2), which asks for the
  // *epic's* bead because the plan it draws lives on that thread. The count is the guard —
  // a third would be something asking on a timer.
  const calls = APP.split('loadBeadDetail(').length - 1;
  assert.equal(calls, 3, 'loadBeadDetail has a caller that is not a tap');
  const advAt = APP.indexOf("if (act === 'p0-adv' || act === 'p0-adv-close')");
  assert.notEqual(advAt, -1, 'the advocate sheet has no tap');
  assert.match(APP.slice(advAt, advAt + 900), /loadBeadDetail\(want, card\.workspace, card\.id\)/);
  const at = APP.indexOf('async function loadBeadDetail(');
  const fn = APP.slice(at, APP.indexOf('\n  }\n', at));
  assert.match(fn, /\/api\/bead\?workspace=/, 'the expansion is not reading /api/bead');
  assert.ok(!fn.includes('/api/question'), 'the expansion is asking for a decision block');
  // Unforced on the way back: this lands whenever bd finishes, which may be into the
  // middle of an answer somebody is typing. And through `keepTheScreenStill`, because
  // this is the moment a one-line "reading…" becomes six hundred pixels of bead.
  // `p0Drawn` since bc-r2b5.2 rather than `p0beadopen.has(key)` alone: the advocate sheet
  // asks for keys that are in no tree and can never be in that set — the epic's own, and
  // every child's archive — so the question it has to ask is "is anything drawn from this"
  // rather than "is this key a row".
  assert.match(fn, /if \(p0Drawn\(key\)\) keepTheScreenStill\(\(\) => render\(\)\);/);
  const drawn = APP.slice(APP.indexOf('const p0Drawn = (key) =>'));
  assert.match(drawn.slice(0, 200), /state\.p0beadopen\.has\(key\) \|\| Boolean\(state\.p0adv\)/);
});

check('a label, a title and a close reason out of the tracker cannot write markup', () => {
  const html = opened({
    ...BEAD,
    labels: ['<img src=x onerror=alert(1)>'],
    close_reason: 'closed <script>alert(1)</script>',
    dependencies: [{ id: 'bc-x', title: '<b>bold</b>', status: 'open', dependency_type: 'blocks' }],
  });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.ok(!html.includes('<img'), 'a label wrote a tag into the board');
  assert.ok(!html.includes('<b>bold'), 'a bead title wrote a tag into the board');
  // The close reason goes through the markdown renderer, which is where the app's
  // sanitiser lives — so what is asserted here is that it went through it at all.
  assert.match(html, /<md>closed <script>alert\(1\)<\/script><\/md>/);
});

console.log('\nthe stylesheet');

check('the row is a button and still keeps the tree edge and the indent', () => {
  const at = CSS.indexOf('button.p0-row {');
  assert.notEqual(at, -1, 'public/style.css has no button.p0-row');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(rule, /text-align: left/);
  assert.match(rule, /width: 100%/);
  // The three borders are cleared one side at a time on purpose: `.p0-row` sets the
  // LEFT one and a `border: 0` shorthand here would take the tree's own edge with it.
  assert.ok(!/border: 0/.test(rule), 'the reset cleared the row border, tree edge and all');
  assert.match(rule, /border-top: 0/);
  // Same for the margin, which is where the indent lives.
  assert.ok(!/margin: 0;/.test(rule), 'the reset cleared the margin the indent is written in');
});

check('the expansion is indented off the same `--d` its row is', () => {
  const at = CSS.indexOf('.p0-bead {');
  assert.notEqual(at, -1, 'public/style.css has no .p0-bead');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(rule, /margin-left: calc\(var\(--d, 0\) \* \d+px \+ \d+px\)/);
});

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32mall good\x1b[0m (${ran})\n`);
