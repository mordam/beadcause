#!/usr/bin/env node
/**
 * The card is the control: tapping a shut card opens it, and "Show details" is gone.
 *
 *     npm test
 *     node test/cardtap.mjs
 *
 * bc-rfnr.9.3. Every collapsed card in the inbox used to carry a "Show details" button
 * hard left in its top bar — a control saying *this card can be opened* beside a card
 * that can be opened, on the one screen where vertical space is the scarce thing. It is
 * gone, and the card itself is the target: the article carries `data-act="toggle"` while
 * it is shut, so the list's existing delegated handler resolves a tap anywhere on the
 * body to the branch the button used to reach.
 *
 * That is a cheap change to make and an easy one to get wrong in exactly one direction,
 * which is what this file is mostly about. **A card contains things.** A link out to the
 * graph, a proposal's ✓, the box you are typing an answer into, the session log you are
 * dragging sideways, the bead id you are trying to select and copy — every one of those
 * is a tap that must do its own job and *not* also open the card underneath it. Getting
 * that wrong does not look like a bug on the screen where it happens: the control does
 * fire, and the card opening over it reads as the app being keen.
 *
 * Four things are pinned here, and none of them is visible by reading one function:
 *
 * 1. **The button is gone, from every kind of card and in both states.** Asserted on the
 *    real `cardTopHtml`, plus a source read that no `<button>` anywhere in public/app.js
 *    carries `data-act="toggle"` — the act belongs to the article now, and a second
 *    emitter of it would be the old control growing back somewhere else.
 * 2. **A shut card carries the act and an open one does not.** Both card renderers, run
 *    for real. The open half matters as much: an open question card is a full-screen
 *    sheet whose way out is `↑ Collapse`, and an article that still answered to `toggle`
 *    would close the sheet under the first tap on a paragraph of the brief.
 * 3. **The top bar disappears rather than emptying.** With reading gone, a shut card that
 *    is not a proposal has nothing to put there — and an empty `.card-top` is not
 *    invisible: it is 12px of padding, and it drags `.card-head`'s own top padding down
 *    to 6 through the `+` rule beside it.
 * 4. **The guard, case by case.** `cardBodyOpens` is driven directly over a fake tap: a
 *    link, a button, the four form elements, a `<pre>`, a contenteditable, a live text
 *    selection, and the two negatives that make the assertions mean something — a plain
 *    paragraph opens the card, and so does a link that is *not inside* this card.
 *
 * public/app.js is one IIFE with nothing exported, so the four declarations are sliced
 * out and run in a `vm` the way test/jirarow.mjs and test/modelcard.mjs do it. The
 * difference here is the context: the card renderers call a dozen sibling helpers this
 * file has no opinion about, so unknown globals are served by a Proxy that hands back a
 * stub returning the empty string. That is deliberate — see the note on `ctx` below. No
 * browser, no network, no `bd`.
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
const CSS = read('public/style.css');

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  [32m✓[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  [31m✗[0m ${name}\n    ${err.message}`);
  }
}

/**
 * Lift one declaration out of public/app.js — copied from test/jirarow.mjs, which
 * explains the two shapes. The file is one IIFE with nothing exported.
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

/* ------------------------------------------------------- the vm and its context */

/**
 * The stub floor.
 *
 * `cardHtml` calls something like fifteen sibling helpers — the meta chips, the address
 * panel, the proposal rows, the answer box — and this file has an opinion about none of
 * them. The obvious lift list (name every callee and slice it too) is what
 * [[lift-one-function-out-of-app-js-into-a-vm]] warns about: it makes *this* suite go red
 * the day somebody unrelated adds a sixteenth call, in a file two sessions are editing.
 *
 * So unknown globals resolve through a Proxy to a function returning `''`. What that
 * costs is real and worth naming: a genuine typo inside a lifted function would be
 * stubbed rather than thrown. It is affordable because everything asserted below is in
 * the *literal* of the two articles and of the top bar — the attribute, the classes, the
 * absence of a button — and none of it comes back from a helper.
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
  state: null, // replaced per case
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
    lift(APP, 'function cardTopHtml(q)'),
    lift(APP, 'function agentCardHtml(q)'),
    lift(APP, 'function cardHtml(q)'),
    lift(APP, 'const CARD_BODY_KEEPS_TAP'),
    lift(APP, 'function cardBodyOpens(ev, card)'),
  ].join('\n'),
  ctx
);

/** Put the page state a renderer reads in place, and draw. */
const draw = (fn, q, { open = false, bulk = '' } = {}) => {
  real.state = { open: new Set(open ? [q.key] : []), menu: null, logs: new Set() };
  real.propBulkHtml = () => bulk;
  return vm.runInContext(`${fn}(Q)`, Object.assign(ctx, { Q: q }));
};

/** A `human` bead as the inbox holds one — only the fields these two renderers read. */
const question = () => ({
  key: 'beadcause/bc-aaa1',
  workspace: 'beadcause',
  id: 'bc-aaa1',
  title: 'Every card expands when you tap it',
  question: 'Should the card be the control?',
  sections: [],
  decision: { options: [] },
  createdAt: '2026-08-14T00:00:00Z',
});

/** A bead nobody is asking about — the read-only card, which expands inline. */
const agentBead = () => ({
  ...question(),
  key: 'beadcause/bc-bbb2',
  id: 'bc-bbb2',
  agent: true,
  status: 'in_progress',
  since: '2026-08-14T00:00:00Z',
});

/** The opening tag of the article, which is where every assertion below lives. */
const tag = (html) => html.slice(0, html.indexOf('>') + 1);

/* --------------------------------------------- 1. the button is gone, everywhere */

console.log('\n"Show details" is gone\n');

check('a shut card that is not a proposal has no top bar at all', () => {
  assert.equal(draw('cardTopHtml', question()), '');
});

check('a shut proposal keeps its bulk pair, and gains no reading control', () => {
  const bar = draw('cardTopHtml', question(), { bulk: '<div class="prop-bulk">two</div>' });
  assert.match(bar, /class="card-top"/, 'the bar is not drawn for the bulk pair');
  assert.match(bar, /prop-bulk/);
  assert.doesNotMatch(bar, /data-act="toggle"/, 'a reading control came back into the bar');
  assert.doesNotMatch(bar, /Show details|Resume your answer|Write an answer/);
});

check('an open card keeps the ⋮ and the way out, and grows no "Hide details"', () => {
  const bar = draw('cardTopHtml', question(), { open: true });
  assert.match(bar, /data-act="menu"/, 'the kebab went with the details button');
  assert.match(bar, /data-act="collapse"/, 'the way out went with the details button');
  assert.doesNotMatch(bar, /data-act="toggle"/);
});

check('no <button> anywhere in the app answers to `toggle` any more', () => {
  // The act belongs to the article now. A second emitter of it on a button would be the
  // old control grown back somewhere else in the file, drawn beside the card it opens.
  const buttons = APP.match(/<button[^>]*data-act="toggle"/g) || [];
  assert.deepEqual(buttons, [], `still emitted by ${buttons.length} button(s)`);
});

/* -------------------------------------------- 2. shut carries the act, open does not */

console.log('\nthe card is the control, and only while it is shut\n');

check('a shut question card is its own toggle', () => {
  const t = tag(draw('cardHtml', question()));
  assert.match(t, /data-act="toggle"/, 'the body of a shut card reaches no handler');
  assert.match(t, /data-key="beadcause\/bc-aaa1"/, 'the tap would carry no key');
});

check('an open question card is not — collapse is the only way out of the sheet', () => {
  const t = tag(draw('cardHtml', question(), { open: true }));
  assert.match(t, /class="card open/, 'the fixture did not actually open it');
  assert.doesNotMatch(t, /data-act="toggle"/, 'a tap on the brief would collapse the sheet');
});

check('a shut agent card is its own toggle too', () => {
  const t = tag(draw('agentCardHtml', agentBead()));
  assert.match(t, /data-act="toggle"/);
  assert.match(t, /data-key="beadcause\/bc-bbb2"/);
});

check('an open agent card is not, though it never wears .open', () => {
  // This card expands *inline*, so `state.open` is the only thing that knows it is
  // open — a guard written against the class would have been silently wrong here.
  const t = tag(draw('agentCardHtml', agentBead(), { open: true }));
  assert.doesNotMatch(t, /class="[^"]*\bopen\b/, 'it started wearing .open');
  assert.doesNotMatch(t, /data-act="toggle"/);
});

check('a shut pull request and a shut ticket answer to their own act', () => {
  // Both were already whole-row buttons; what is new is the article carrying the act as
  // well, so the note under the row and the padding beside it stop being dead ground.
  assert.match(APP, /class="card pr-card"[^`]*data-act="pr-open"/, 'the pr card lost it');
  assert.match(APP, /class="card jira-card" data-key="\$\{esc\(row\.key\)\}" data-act="jira-open"/);
});

check('the list handler asks the guard before it acts on a card', () => {
  // The whole containment story is this one line: `closest('[data-act]')` resolving to
  // the article means nothing nearer claimed the tap, and that is when the guard runs.
  const at = APP.indexOf("listEl.addEventListener('click'");
  assert.notEqual(at, -1, 'the list click handler moved');
  const head = APP.slice(at, at + 600);
  assert.match(head, /classList\.contains\('card'\)\s*&&\s*!cardBodyOpens\(ev, btn\)/);
});

/* ------------------------------------------------------------- 3. and 4. the guard */

console.log('\nwhat a tap on a card must not swallow\n');

/**
 * A fake tap. Each node declares which selectors it answers to, `closest` walks up
 * through them, and `contains` is honest about ancestry — that is the whole of what
 * `cardBodyOpens` touches, so there is nothing else to fake.
 */
function node(sels, parent = null) {
  const self = {
    sels,
    parent,
    closest(query) {
      const want = query.split(',').map((s) => s.trim());
      for (let n = self; n; n = n.parent) if (n.sels.some((s) => want.includes(s))) return n;
      return null;
    },
    contains(other) {
      for (let n = other; n; n = n.parent) if (n === self) return true;
      return false;
    },
  };
  return self;
}

/** Tap `target`, inside `card`, with `selected` currently highlighted on the page. */
const taps = (target, card, selected = '') => {
  real.window = { getSelection: () => selected };
  return vm.runInContext('cardBodyOpens(EV, CARD)', Object.assign(ctx, { EV: { target }, CARD: card }));
};

const keeps = vm.runInContext('CARD_BODY_KEEPS_TAP', ctx);

check('the guard list names every kind of thing a card holds that has no data-act', () => {
  for (const sel of ['a[href]', 'button', 'input', 'textarea', 'select', 'label', 'pre', '[contenteditable]']) {
    assert.ok(keeps.includes(sel), `${sel} is not guarded`);
  }
});

check('a tap on the body of a card opens it', () => {
  const card = node(['.card']);
  assert.equal(taps(node(['p'], card), card), true);
});

for (const [what, sel] of [
  ['the Graph → link on an agent card', 'a[href]'],
  ['a control drawn without a data-act', 'button'],
  ['a checkbox', 'input'],
  ['the answer box', 'textarea'],
  ['a picker', 'select'],
  ['the words beside a checkbox', 'label'],
  ['the session log, which is dragged sideways', 'pre'],
  ['something being typed into in place', '[contenteditable]'],
]) {
  check(`${what} (${sel}) does its own job and nothing else`, () => {
    const card = node(['.card']);
    const inner = node([sel], card);
    assert.equal(taps(node(['span'], inner), card), false);
  });
}

check('text you have selected in a card is not a tap on the card', () => {
  // Selecting the bead id to copy it ends in a click. A card that expanded under every
  // attempt to copy the one line worth copying is the trap this bead names by name.
  const card = node(['.card']);
  assert.equal(taps(node(['p'], card), card, 'bc-aaa1'), false);
});

check('and whitespace left over from an earlier selection is not a selection', () => {
  const card = node(['.card']);
  assert.equal(taps(node(['p'], card), card, '  \n '), true);
});

check('a link that is not inside this card does not hold its tap back', () => {
  // `contains` is why the guard is not a bare closest(): a tap that resolved to this
  // card, through a link belonging to something else, is still a tap on this card.
  const card = node(['.card']);
  const elsewhere = node(['a[href]']);
  const target = node(['span'], elsewhere);
  target.parent = elsewhere;
  assert.equal(taps(target, card), true);
});

/* ------------------------------------------------------------------ the stylesheet */

console.log('\nsaying so, on a screen with no hover\n');

check('a shut card is drawn as something you can press', () => {
  assert.match(CSS, /\.card\[data-act\]\s*\{[^}]*cursor:\s*pointer/, 'no pointer on a tappable card');
  assert.match(CSS, /\.card\[data-act\]:active/, 'nothing says the card went down under the finger');
});

check('and the press tint stays off the card when a control on it is pressed', () => {
  assert.match(CSS, /\.card\[data-act\]:active:not\(:has\(/);
});

check('nothing forbids selecting text in a card', () => {
  // The acceptance criterion on this bead. A `user-select: none` would have made the
  // selection guard above untestable and the bead id uncopyable in the same stroke.
  const block = CSS.match(/(^|\n)\.card[^{\n]*\{[^}]*\}/g) || [];
  for (const b of block) assert.doesNotMatch(b, /user-select:\s*none/, b.trim());
});

console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall good — ${ran} checks\n`);
process.exit(failures ? 1 : 0);
