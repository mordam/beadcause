#!/usr/bin/env node
/**
 * The tap is answered before the fetch is — the half of it a browser is not needed for.
 *
 *     npm test
 *     node test/cardpending.mjs
 *
 * bc-jair. Tapping a shut card runs `expand()`, which awaits `/api/question` or
 * `/api/bead` and only *then* opens it. Until the answer landed the tap had nothing at
 * all to show for itself, and a tap with nothing to show for itself is one people make
 * again — on a question card, two taps racing to open the same brief. `.card.opening` is
 * the mark that fills that gap: put on inside the tap's own handler by `paintOpening()`,
 * taken off by the repaint that opens the card.
 *
 * `scripts/pending-check.mjs` is where the timing is proved, because only a browser can
 * say whether a class was on before a frame was painted. What is pinned *here* is
 * everything that would still be wrong on a machine with no Chrome:
 *
 * 1. **Both renderers draw it, and only for the card that is opening.** The class is
 *    interpolated rather than only written by hand onto a node, which is what makes it
 *    survive a poll landing mid-fetch — the reconcile is free to replace the node
 *    `paintOpening()` wrote on. Written in exactly one place in the file, for the reason
 *    `shutCardAct` is: two literals are two things to keep in step.
 * 2. **`paintOpening()` is a sweep, not a toggle.** A second tap can land on another card
 *    while the first fetch is still in the air, and two cards both claiming to be opening
 *    is worse than the inert tap this replaced. Driven for real against a hand-made list.
 * 3. **The mark is cleared where it has to be.** `expand()` clears it *before* it opens
 *    the card — that ordering is the whole of why an already-cached card cannot flash,
 *    since nothing on that path awaits — and the tap clears it again in a `finally`, for
 *    the throw `expand()` does not swallow.
 * 4. **The style cannot move anything.** An outline and an offset, no border, no padding,
 *    no width: the draft edge above it is a shadow for the same reason. And reduced
 *    motion drops the pulse while keeping the ring, which is only true because the
 *    keyframes touch nothing but the colour.
 *
 * public/app.js is one IIFE with nothing exported, so the declarations are sliced out and
 * run in a `vm` the way test/cardtap.mjs does it, with the same Proxy stub floor for the
 * sibling helpers this file has no opinion about.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const APP = read('public/app.js');
const CSS_SRC = read('public/style.css');

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`);
  }
}

/**
 * Slice one declaration out of public/app.js — the shape test/cardtap.mjs uses, with
 * `async function` added to the brace-matched half. The file is one IIFE with nothing
 * exported, and there is no second copy of these functions to test instead.
 */
function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  if (/^(async )?function/.test(opener)) {
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

/* ------------------------------------------------------- the vm and its context */

/**
 * The stub floor, copied from test/cardtap.mjs and for its reasons: the card renderers
 * call something like fifteen sibling helpers this file has no opinion about, and naming
 * them all in a lift list makes this suite go red the day somebody unrelated adds a
 * sixteenth. Everything asserted below is in the article's own literal, or is the return
 * value of a function that *is* lifted.
 */
const STUB = () => '';
const real = {
  String,
  JSON,
  Date,
  Math,
  Object,
  Boolean,
  Array,
  Set,
  state: null, // replaced per case
  listEl: null, // replaced per case
  CSS: { escape: (s) => s },
  window: { getSelection: () => '' },
};
const ctx = vm.createContext(
  new Proxy(real, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : STUB),
  })
);
vm.runInContext(
  [
    lift(APP, 'const esc = ('),
    lift(APP, 'const shutCardAct = ('),
    lift(APP, 'const openingCardClass = ('),
    lift(APP, 'function cardTopHtml(q)'),
    lift(APP, 'function agentCardHtml(q)'),
    lift(APP, 'function cardHtml(q)'),
    lift(APP, 'function paintOpening()'),
  ].join('\n'),
  ctx
);

/** Put the page state a renderer reads in place, and draw. */
const draw = (fn, q, { open = false, opening = null } = {}) => {
  real.state = { open: new Set(open ? [q.key] : []), menu: null, logs: new Set(), opening };
  real.propBulkHtml = () => '';
  return vm.runInContext(`${fn}(Q)`, Object.assign(ctx, { Q: q }));
};

const question = () => ({
  key: 'beadcause/bc-aaa1',
  workspace: 'beadcause',
  id: 'bc-aaa1',
  title: 'A tapped card highlights on touch',
  question: 'Does the card say it heard you?',
  sections: [],
  decision: { options: [] },
  createdAt: '2026-08-15T00:00:00Z',
});

const agentBead = () => ({
  ...question(),
  key: 'beadcause/bc-bbb2',
  id: 'bc-bbb2',
  agent: true,
  status: 'in_progress',
  since: '2026-08-15T00:00:00Z',
});

/** The opening tag of the article, which is where every class assertion lives. */
const tag = (html) => html.slice(0, html.indexOf('>') + 1);

/* ------------------------------------- 1. both renderers draw it, for one card only */

console.log('\nthe mark is drawn, and only on the card that is opening\n');

check('a question card whose fetch is in the air wears the mark', () => {
  const t = tag(draw('cardHtml', question(), { opening: 'beadcause/bc-aaa1' }));
  assert.match(t, /class="card[^"]*\bopening\b/, 'the card says nothing about the wait');
});

check('and an agent bead, which is the other card that awaits before it opens', () => {
  const t = tag(draw('agentCardHtml', agentBead(), { opening: 'beadcause/bc-bbb2' }));
  assert.match(t, /class="card[^"]*\bopening\b/);
});

check('a card nobody tapped does not', () => {
  const t = tag(draw('cardHtml', question(), { opening: 'beadcause/bc-zzz9' }));
  assert.doesNotMatch(t, /\bopening\b/, 'every card in the list would be marked');
});

check('nor does anything when no fetch is in the air', () => {
  assert.doesNotMatch(tag(draw('cardHtml', question())), /\bopening\b/);
  assert.doesNotMatch(tag(draw('agentCardHtml', agentBead())), /\bopening\b/);
});

check('the card keeps everything else it was wearing', () => {
  // The mark is added to the class list, not swapped for it: a marked card is still a
  // shut card, and it still answers to the tap that would open it.
  const t = tag(draw('cardHtml', question(), { opening: 'beadcause/bc-aaa1' }));
  assert.match(t, /data-act="toggle"/, 'the marked card stopped being its own control');
  assert.match(t, /data-key="beadcause\/bc-aaa1"/);
});

check('one place in the file writes the class — both renderers call it', () => {
  // Same rule `shutCardAct` is under, and for a weaker version of the same reason: two
  // literals are two things to keep in step, and the card kind that gets forgotten is
  // always the one nobody was looking at.
  const sites = APP.match(/' opening'/g) || [];
  assert.equal(sites.length, 1, `the literal is written ${sites.length} times`);
  assert.match(
    lift(APP, 'const openingCardClass = ('),
    /state\.opening === q\.key/,
    'the one site no longer reads state.opening'
  );
});

/* --------------------------------------------- 2. paintOpening is a sweep, not a toggle */

console.log('\npaintOpening() puts it on one card and takes it off the rest\n');

/** A list of cards, close enough to the DOM for the two selectors paintOpening uses. */
function fakeList(keys, marked = []) {
  const cards = keys.map((key) => {
    const classes = new Set(['card', ...(marked.includes(key) ? ['opening'] : [])]);
    return {
      key,
      classes,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
    };
  });
  return {
    cards,
    marked: () => cards.filter((c) => c.classes.has('opening')).map((c) => c.key),
    querySelectorAll: (sel) => {
      assert.equal(sel, '.card.opening', `unexpected selector ${sel}`);
      return cards.filter((c) => c.classes.has('opening'));
    },
    querySelector: (sel) => {
      const want = /\.card\[data-key="(.*)"\]$/.exec(sel);
      assert.ok(want, `unexpected selector ${sel}`);
      return cards.find((c) => c.key === want[1]) || null;
    },
  };
}

const paint = (keys, opening, marked = []) => {
  const list = fakeList(keys, marked);
  real.listEl = list;
  real.state = { opening };
  vm.runInContext('paintOpening()', ctx);
  return list.marked();
};

check('it marks the card the fetch is for', () => {
  assert.deepEqual(paint(['a', 'b', 'c'], 'b'), ['b']);
});

check('a second tap moves the mark rather than adding one', () => {
  // The case this shape exists for: tapping `c` while `a`'s fetch is still going. Two
  // cards each saying they are opening is a page that has stopped meaning anything.
  assert.deepEqual(paint(['a', 'b', 'c'], 'c', ['a']), ['c']);
});

check('and nothing is marked once the fetch is done', () => {
  assert.deepEqual(paint(['a', 'b', 'c'], null, ['b']), []);
});

check('a card that has left the list on the poll is not an exception', () => {
  // `?.` on the lookup: the row can be gone by the time this runs — answered, filtered
  // out, or replaced by a reconcile — and a throw here would come out of a click handler.
  assert.deepEqual(paint(['a', 'b'], 'gone', ['a']), []);
});

/* ------------------------------------------- 3. the mark is cleared where it has to be */

console.log('\nand cleared in the two places that matter\n');

const EXPAND = lift(APP, 'async function expand(key, force = false)');
const TOGGLE = APP.slice(APP.indexOf("if (act === 'toggle') {"), APP.indexOf("if (act === 'collapse') {"));

check('expand() clears the mark before it opens the card', () => {
  // This ordering *is* the no-flash guarantee. On the cached path `expand()` never
  // awaits, so the set at the tap, this clear and the repaint all happen inside the one
  // event — and a browser cannot paint a frame in the middle of one. Clear it after the
  // repaint instead and the mark would be drawn onto the card that just opened.
  const clear = EXPAND.indexOf('state.opening = null');
  const open = EXPAND.indexOf('openOnly(key)');
  assert.notEqual(clear, -1, 'expand() no longer clears the mark at all');
  assert.notEqual(open, -1, 'expand() no longer opens the card');
  assert.ok(clear < open, 'the mark is cleared after the card is opened, which draws it on');
});

check('and only when the mark is its own', () => {
  // A second tap moves `state.opening` to another card. A blind clear here would strip
  // the mark from a card whose fetch is still in the air, on the landing of the *first*.
  assert.match(EXPAND, /if \(state\.opening === key\) state\.opening = null;/);
});

check('the tap marks the card before it awaits anything', () => {
  const mark = TOGGLE.indexOf('state.opening = key');
  const paintAt = TOGGLE.indexOf('paintOpening()');
  const wait = TOGGLE.indexOf('await expand(key)');
  assert.ok(mark !== -1 && paintAt !== -1 && wait !== -1, 'the toggle branch no longer marks the card');
  assert.ok(mark < wait && paintAt < wait, 'the mark is set after the fetch, which is the bug');
});

check('and clears it in a finally, for the throw expand() does not swallow', () => {
  assert.match(TOGGLE, /finally \{/, 'a throw would leave the card marked until a reload');
  const fin = TOGGLE.slice(TOGGLE.indexOf('finally {'));
  assert.match(fin, /state\.opening === key/, 'the finally clears a mark a later tap owns');
  assert.match(fin, /state\.opening = null/);
  assert.match(fin, /paintOpening\(\)/, 'state is cleared but the class stays on the node');
});

check('the mark starts life empty', () => {
  assert.match(APP, /^\s*opening: null,$/m, 'state.opening is not declared on the page state');
});

/* ------------------------------------------------ 4. the style cannot move anything */

console.log('\nthe ring, and what it is forbidden to do\n');

const rule = (sel) => {
  const at = CSS_SRC.indexOf(`${sel} {`);
  assert.notEqual(at, -1, `public/style.css has no \`${sel}\` rule`);
  return CSS_SRC.slice(at, CSS_SRC.indexOf('}', at) + 1);
};

check('the mark is an outline drawn inside the card', () => {
  const body = rule('.card.opening:not(.open)');
  assert.match(body, /outline:\s*2px solid var\(--accent\)/);
  assert.match(body, /outline-offset:\s*-2px/, 'the ring would sit outside the card and be clipped');
});

check('and declares nothing that could move a pixel', () => {
  // The whole complaint is a card that does not respond to a tap; a mark that responded
  // by nudging the words under the thumb would be a worse answer than none.
  const body = rule('.card.opening:not(.open)');
  const moves = /(^|[;{\s])(border|padding|margin|width|height|font-size|inset|top|left|transform)\s*:/;
  assert.doesNotMatch(body, moves, 'the mark changes the card box');
});

check('it is suppressed on an open card, like the two edges above it', () => {
  // `.card.open` is a fixed full-screen layer with no side edges — a ring round the whole
  // screen is not a mark, it is a border on the phone.
  assert.doesNotMatch(CSS_SRC, /^\.card\.opening \{/m, 'the mark is not guarded against .open');
});

check('the pulse touches nothing but the colour', () => {
  const at = CSS_SRC.indexOf('@keyframes card-opening');
  assert.notEqual(at, -1, 'the pulse is gone, or has been renamed out from under the rule');
  const body = CSS_SRC.slice(at, CSS_SRC.indexOf('}\n', CSS_SRC.indexOf('{', at)) + 1);
  const declared = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(declared)], ['outline-color'], `it also animates ${declared}`);
});

check('and it starts at the ring rather than fading up to it', () => {
  // The first frame after the tap has to be the whole mark, whatever the animation does
  // next — an animation with a `from` would spend the first 200ms of a slow fetch fading
  // in, which is exactly the window this feature exists for. It is also what lets reduced
  // motion be one line: switch the animation off, and what is left is that first frame.
  const at = CSS_SRC.indexOf('@keyframes card-opening');
  const body = CSS_SRC.slice(at, CSS_SRC.indexOf('}\n', CSS_SRC.indexOf('{', at)) + 1);
  assert.doesNotMatch(body, /(^|\s)(from|0%)\s*[,{]/, 'the ring fades in');
  assert.match(body, /50%\s*\{/);
});

check('reduced motion keeps the ring and drops the pulse', () => {
  const at = CSS_SRC.indexOf('.card.opening:not(.open) { animation: none; }');
  assert.notEqual(at, -1, 'nothing turns the pulse off for prefers-reduced-motion');
  const before = CSS_SRC.slice(0, at);
  assert.match(
    before.slice(before.lastIndexOf('@media')),
    /prefers-reduced-motion: reduce/,
    'the animation is switched off outside a reduced-motion query — for everybody'
  );
});

console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall good — ${ran} checks\n`);
process.exit(failures ? 1 : 0);
