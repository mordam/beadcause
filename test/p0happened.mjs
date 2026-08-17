#!/usr/bin/env node
/**
 * Every bead on the board links to its pull requests and its session.
 *
 *     npm test
 *     node test/p0happened.mjs
 *
 * bc-rfnr.9.5. An expanded bead has drawn everything `bd` holds about it since
 * bc-rfnr.9.4 — the pills, the edges, the prose, the thread. What it has never drawn is
 * the half that is *about* the bead and lives somewhere else: the pull requests that
 * name it, and the window that worked it. Until bc-rfnr.9.7 there was one screen that
 * connected the two — a pull request row in the flat list under the board, carrying the
 * beads it names — and that row now follows its bead off the list. This is the same trail
 * walked from the other end.
 *
 * Six things, and five of them are ways to draw a control that does nothing:
 *
 * 1. **The pull requests are the board's own rows, reversed.** `/api/prs` already
 *    resolves `beads[]` per row on the daemon (lib/beadref.js), so this is an index this
 *    page has rather than a sweep it runs. Asserted by handing the renderer a board and
 *    no fetch at all.
 *
 * 2. **A bead with neither says so and offers nothing to tap.** The acceptance criterion,
 *    and the one that matters: most beads in this tracker have never had a pull request
 *    or a session, so the common case is the empty one. Asserted on the markup carrying
 *    no anchor and no button anywhere in the block — not merely on the sentence being
 *    present, because a sentence *beside* a dead link is the failure.
 *
 * 3. **"We have not looked" is not "there is nothing".** The board is a `gh` sweep behind
 *    its own minute and the archive is a `git log` that lands after the bead does, so
 *    both halves have a third state. Reported as "reading", never as an absence — a board
 *    the page never fetched must not be able to say a delivery does not exist.
 *
 * 4. **A closed pull request is not offered as a button.** `expand` can only open a row
 *    `prRows` produced and `prRows` drops `stage: closed`, so the obvious spelling gives a
 *    declined delivery a button whose only outcome is nothing happening. It gets the link
 *    out to GitHub instead, which is where a closed pull request actually is.
 *
 * 5. **A live session and an archived one are different addresses.** A running window is
 *    reachable only by pid; a finished one only by bead. Drawing one where the other
 *    belongs is a 404 either way round, and a bead can honestly have both.
 *
 * 6. **The reverse index matches ids and not prefixes.** Every parent id in this tracker
 *    is a prefix of its children's, so a pull request for `bc-rfnr.9.5` must not appear on
 *    `bc-rfnr.9` — which is the same failure `namesBead` exists to prevent one layer down.
 *
 * And one thing about cost: an open bead is a *reader of the board*, so the sweep the
 * kind filter would have suppressed has to run anyway or the section never resolves.
 *
 * No browser, no daemon, no network. The renderers return strings, so they are sliced out
 * of public/app.js and run in a `node:vm` — test/p0bead.mjs's harness, with its lift.
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

/** test/p0bead.mjs's lifter, verbatim — parameters walked as parentheses, body after. */
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
 * The card, with a live session on one of its rows and none on the others — the shape
 * `rootCard` sends since this bead. `session` is `advocateSession`'s answer per row.
 */
const CARD = {
  key: 'beadcause/bc-rfnr',
  workspace: 'beadcause',
  id: 'bc-rfnr',
  title: 'The inbox is an epic board',
  tree: [
    {
      id: 'bc-rfnr.9',
      title: 'A P0 card is the board',
      status: 'open',
      depth: 1,
      key: 'beadcause/bc-rfnr.9',
      pending: false,
      session: null,
    },
    {
      id: 'bc-rfnr.9.5',
      title: 'Every bead links to its pull requests',
      status: 'in_progress',
      depth: 2,
      key: 'beadcause/bc-rfnr.9.5',
      pending: false,
      session: { pid: 4415, name: 'Beadcause - bc-rfnr.9.5 what happened', status: 'busy', at: null, opening: false },
    },
    {
      id: 'bc-rfnr.9.7',
      title: 'Remove the list below the board',
      status: 'closed',
      depth: 2,
      key: 'beadcause/bc-rfnr.9.7',
      pending: false,
      session: null,
    },
    // The ordinary bead, and the one most of this suite is about: nothing has ever
    // happened to it. Most beads in this tracker are this one.
    {
      id: 'bc-rfnr.9.9',
      title: 'The board jumps when a bead opens',
      status: 'open',
      depth: 2,
      key: 'beadcause/bc-rfnr.9.9',
      pending: false,
      session: null,
    },
  ],
};

/** One `/api/prs` payload: two repos, four pull requests, three rungs and a declined one. */
const BOARD = {
  repos: [
    {
      key: 'beadcause',
      prs: [
        {
          key: 'beadcause#386',
          number: 386,
          title: 'Remove the list below the board',
          url: 'https://github.com/mordam/beadcause/pull/386',
          stage: 'live',
          workspace: 'beadcause',
          repoName: 'beadcause',
          beads: [{ id: 'bc-rfnr.9.7', title: 'Remove the list', status: 'closed' }],
        },
        {
          key: 'beadcause#391',
          number: 391,
          title: 'The <b>index</b> read backwards',
          url: 'https://github.com/mordam/beadcause/pull/391',
          stage: 'review',
          workspace: 'beadcause',
          repoName: 'beadcause',
          beads: [{ id: 'bc-rfnr.9.5', title: 'Every bead links', status: 'in_progress' }],
        },
        {
          key: 'beadcause#300',
          number: 300,
          title: 'An approach that was declined',
          url: 'https://github.com/mordam/beadcause/pull/300',
          stage: 'closed',
          workspace: 'beadcause',
          repoName: 'beadcause',
          beads: [{ id: 'bc-rfnr.9.5', title: 'Every bead links', status: 'in_progress' }],
        },
      ],
    },
    {
      key: 'climative/athena',
      prs: [
        {
          key: 'climative/athena#1',
          number: 1,
          title: 'Something else entirely',
          url: 'https://github.com/Climative/athena/pull/1',
          stage: 'merged',
          workspace: 'climative',
          repoName: 'climative/athena',
          beads: [{ id: 'cl-abcd', title: 'Elsewhere', status: 'open' }],
        },
      ],
    },
  ],
};

/** The renderers, over a page state you hand them. */
function page({ board = BOARD, arc = new Map(), beadopen = [], cards = [CARD] } = {}) {
  const state = {
    rootboard: { owned: true, roots: cards, under: {} },
    p0open: new Set(['beadcause/bc-rfnr']),
    p0beadopen: new Set(beadopen),
    p0beadarc: arc,
    board,
  };
  const context = vm.createContext({
    String,
    Number,
    Array,
    Boolean,
    JSON,
    Set,
    Map,
    Date,
    encodeURIComponent,
    state,
    // public/prcard.js's rung pill. Stubbed rather than lifted — it lives in another file
    // and test/prstage.mjs is what keeps its words honest; what this suite asserts is
    // that the row asks for it and survives its absence.
    window: { beadcause: { prCard: { stageHtml: (p) => `<span class="pill pr-stage">${p.stage}</span>` } } },
  });
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'function relTime(iso)'),
      lift(APP, 'function p0PrsFor(id)'),
      lift(APP, 'function p0PrRowHtml(p)'),
      lift(APP, 'function p0SessionRowsHtml(workspace, id, row, arc)'),
      lift(APP, 'function p0HappenedHtml(card, b)'),
      'null;',
    ].join('\n\n'),
    context
  );
  return {
    context,
    /** The block, for one bead of the card's tree. */
    html: (id, bead = {}) =>
      vm.runInContext('p0HappenedHtml', context)(cards[0], { workspace: 'beadcause', id, ...bead }),
  };
}

/** Everything in a fragment that a thumb can land on. */
const tappable = (html) => (html.match(/<a\b|<button\b/g) || []).length;

/* ------------------------------------------------------------------ the checks */

console.log('\nthe pull requests, off the board this page already has');

check('a bead lists every pull request that names it, newest first', () => {
  const html = page().html('bc-rfnr.9.5');
  const order = [...html.matchAll(/#(\d+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ['391', '300'], 'the two pull requests for this bead, newest number first');
  assert.ok(!html.includes('#386'), 'a pull request for a different bead was drawn on this one');
  assert.ok(!html.includes('/athena/pull/1'), 'a pull request from another repo entirely was drawn on this bead');
});

check('and it matches the id, not a prefix of it', () => {
  // bc-rfnr.9 is the parent of bc-rfnr.9.5 and bc-rfnr.9.7, and its id is a prefix of
  // both. A reverse index built on `startsWith` puts two of its children's deliveries on
  // it — which reads exactly like the epic having shipped.
  const arc = new Map([['beadcause/bc-rfnr.9', { sessions: [] }]]);
  const html = page({ arc }).html('bc-rfnr.9');
  assert.ok(!html.includes('#391'), 'a child’s pull request was drawn on its parent');
  assert.ok(!html.includes('#386'), 'a child’s pull request was drawn on its parent');
  assert.ok(html.includes('No pull request names bc-rfnr.9,'), html.slice(0, 300));
});

check('an open one is a button into the card this app already has', () => {
  const html = page().html('bc-rfnr.9.5');
  assert.match(html, /<button[^>]*data-act="p0-pr"[^>]*data-key="pr:beadcause#391"/, html.slice(0, 400));
});

check('and a declined one is a link to GitHub, never a button that opens nothing', () => {
  // `prRows` drops `stage: closed`, so `expand('pr:beadcause#300')` would find no row
  // and the tap would do nothing at all. The failure is invisible until somebody taps it.
  const html = page().html('bc-rfnr.9.5');
  assert.ok(!html.includes('data-key="pr:beadcause#300"'), 'a closed pull request was offered as a button');
  assert.match(html, /<a[^>]*href="https:\/\/github\.com\/mordam\/beadcause\/pull\/300"/, html.slice(0, 800));
});

check('a title out of GitHub cannot write markup into the board', () => {
  const html = page().html('bc-rfnr.9.5');
  assert.ok(html.includes('&lt;b&gt;index&lt;/b&gt;'), 'the escaped form is not there');
  assert.ok(!html.includes('<b>index</b>'), 'a pull request title wrote a tag into the page');
});

console.log('\nthe session — live now, archived, or neither');

check('a live session is its pid, because that is the only address one has', () => {
  const html = page().html('bc-rfnr.9.5');
  assert.match(html, /href="\/session\?pid=4415"/, html.slice(0, 900));
  assert.ok(html.includes('A session is on it now'));
});

check('an archived one is the bead, because a finished window has no pid', () => {
  const arc = new Map([
    ['beadcause/bc-rfnr.9.7', { sessions: [{ commit: 'abc1234', at: '2026-08-17T12:00:00.000Z' }] }],
  ]);
  const html = page({ arc }).html('bc-rfnr.9.7');
  assert.match(html, /href="\/bead-session\?workspace=beadcause&amp;id=bc-rfnr\.9\.7"/, html.slice(0, 900));
  assert.ok(html.includes('1 session archived'));
});

check('and a bead with both gets both — they are two different destinations', () => {
  const arc = new Map([
    [
      'beadcause/bc-rfnr.9.5',
      { sessions: [{ commit: 'a1', at: '2026-08-17T12:00:00.000Z' }, { commit: 'a2', at: '2026-08-16T12:00:00.000Z' }] },
    ],
  ]);
  const html = page({ arc }).html('bc-rfnr.9.5');
  assert.ok(html.includes('/session?pid=4415'), 'the live window went missing behind the archive');
  assert.ok(html.includes('/bead-session?workspace=beadcause'), 'the archive went missing behind the live window');
  assert.ok(html.includes('2 sessions archived'));
});

check('while the archive is still being read the row is not tappable', () => {
  // A row that is a link and then stops being one loses the tap of somebody who reached
  // for it as it resolved. Quiet-then-tappable cannot lose anything, so the flicker is
  // allowed in one direction only. public/graph.js's sheet made the same call.
  const html = page().html('bc-rfnr.9.9');
  assert.ok(html.includes('looking for what it left'), html.slice(0, 400));
  assert.equal(tappable(html), 0, 'something was tappable before we knew whether there was anything to tap');
});

check('a check that failed offers the link anyway — the two errors are not symmetrical', () => {
  // Saying "no session" over a bead that has one hides the page for good, because nothing
  // would ever suggest looking again. Offering one over a bead that has none costs a tap
  // onto a page whose whole design is saying plainly what is not there.
  const arc = new Map([['beadcause/bc-rfnr.9.7', { failed: true, sessions: [] }]]);
  const html = page({ arc }).html('bc-rfnr.9.7');
  assert.ok(html.includes('/bead-session?workspace=beadcause'), html.slice(0, 400));
  assert.ok(!html.includes('No session archived'), 'a failed check claimed nothing had run');
});

console.log('\nnothing to say, and not knowing yet');

check('a bead with neither says so, and offers nothing to tap', () => {
  const arc = new Map([['beadcause/bc-rfnr.9.9', { sessions: [] }]]);
  const html = page({ arc }).html('bc-rfnr.9.9');
  assert.ok(html.includes('No pull request names bc-rfnr.9.9, and no session has run on it.'), html.slice(0, 400));
  assert.equal(tappable(html), 0, 'a bead nothing happened to still offered a way into an empty pane');
});

check('and a board this page has not got is "reading", never "there is none"', () => {
  // The kind filter can exclude pull requests, and the first sweep takes a `gh` call per
  // repo. Either way the honest answer is that we have not looked — a board that was
  // never fetched must not be able to say a delivery does not exist.
  const arc = new Map([['beadcause/bc-rfnr.9.9', { sessions: [] }]]);
  const html = page({ board: null, arc }).html('bc-rfnr.9.9');
  assert.ok(html.includes('Reading the pull request board…'), html.slice(0, 400));
  assert.ok(!html.includes('No pull request names'), 'the board claimed something it never looked at');
});

check('an archive that has not landed does not make the pull requests wait', () => {
  // Two sources, two clocks: the board is in hand from the poll and the archive is a
  // `git log` fired on the tap. Chaining them would hide a delivery behind a file read.
  const html = page().html('bc-rfnr.9.5');
  assert.ok(html.includes('#391'), 'the pull request waited on the archive');
  assert.ok(html.includes('looking for what it left'), 'the archive is supposed to be unresolved here');
});

console.log('\nwhat it costs, and what it looks like');

check('an open bead makes the board wanted, whatever the kind filter says', () => {
  // Without this the section never resolves on a filter that excludes pull requests: it
  // would sit on "reading the pull request board" for as long as the bead is open, which
  // is worse than the sweep it was avoiding. One open bead is a deliberate tap.
  const ctx = vm.createContext({ state: { p0beadopen: new Set() }, window: {}, Array, Boolean, String, Number });
  vm.runInContext([lift(APP, 'const prsWanted = ('), lift(APP, 'const boardWanted = ('), 'null;'].join('\n'), ctx);
  const wanted = () => vm.runInContext('boardWanted()', ctx);
  ctx.window.beadcause = { inboxFilter: { selected: () => ['bead'] } };
  assert.equal(wanted(), false, 'a filter with no pull requests in it still swept the board');
  ctx.state.p0beadopen.add('beadcause/bc-rfnr.9.5');
  assert.equal(wanted(), true, 'an open bead could not get the board it draws from');
  ctx.state.p0beadopen.clear();
  ctx.window.beadcause = { inboxFilter: { selected: () => [] } };
  assert.equal(wanted(), true, 'the list itself stopped being a reader of the board');
});

check('the two states that are not controls are not elements you can focus', () => {
  // `is-checking` and `is-none` render as `<div>`, not as a disabled `<a>`: an anchor with
  // no href is still in the tab order on some browsers, and this bead is precisely about
  // not offering a way into an empty pane.
  const arc = new Map([['beadcause/bc-rfnr.9.9', { sessions: [] }]]);
  const looking = page().html('bc-rfnr.9.9');
  const none = page({ arc, board: null }).html('bc-rfnr.9.9');
  assert.match(looking, /<div class="p0-hap-row is-checking"/);
  assert.match(none, /<div class="p0-hap-row is-none"/);
  assert.match(CSS, /div\.p0-hap-row\s*\{[^}]*cursor:\s*default/, 'the stylesheet still dresses them as controls');
});

check('the stylesheet lays the rows out as a column, not as a wrapping row', () => {
  // Three things per row and the third wraps. Laid out the way `.p0-rel` is, the rungs
  // and the titles interleave and you cannot tell which belongs to which.
  assert.match(CSS, /\.p0-hap\s*\{[^}]*flex-direction:\s*column/);
  assert.match(CSS, /\.p0-hap-title\s*\{[^}]*flex:\s*1 1 100%/);
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
