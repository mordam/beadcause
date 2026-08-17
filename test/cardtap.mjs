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
 * Five things are pinned here, and none of them is visible by reading one function:
 *
 * 1. **The "Show details" button is gone**, from every kind of card and in both states —
 *    asserted on the real `cardTopHtml`. The act belongs to the article now, and a source
 *    read counts `data-act="toggle"` across the whole file and insists on **one** line:
 *    edit mode anchors a tapped control by grepping this source, and one act has always
 *    meant one line, which is why the renderers interpolate `shutCardAct` instead of
 *    typing it.
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
 * 5. **The title is the one focusable way in (bc-rfnr.9.8).** Taking the article's own
 *    role away from the button left a shut card with nothing Tab could reach, since
 *    `role="button" tabindex="0"` on the article would be invalid ARIA over the six
 *    interactive descendants a shut proposal card carries. Both renderers now draw
 *    `<p class="q">` as a real `<button class="q">`, unconditionally — shut, it carries
 *    `shutCardAct` and its own `data-key`; open, `tabindex="-1"` takes it out of the tab
 *    order rather than swapping the tag, because a `<p>`-when-open, `<button>`-when-shut
 *    split is one more literal `class="q"` than `editmode.js`'s chain-narrowing anchor
 *    can place — see the note on `shutCardAct` in public/app.js. The button is written
 *    inline in each renderer for the same reason, not behind a shared helper, and that
 *    is why the exactly-one-line count in (1) still holds: nothing types the attribute
 *    itself, both call the one function that does.
 *
 * public/app.js is one IIFE with nothing exported, so the declarations are sliced out
 * and run in a `vm` the way test/jirarow.mjs and test/modelcard.mjs do it. The
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
 * absence of a button — with one exception, and the exception is the rule: `shutCardAct`
 * supplies part of that literal, so it is lifted rather than stubbed. Anything an
 * assertion depends on the *return value* of has to be named in the lift list; the Proxy
 * is only for the helpers whose output this file drops on the floor.
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
    lift(APP, 'const shutCardAct = ('),
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

check('no <button> spells the act out literally — only `shutCardAct` interpolates it', () => {
  // A second emitter typing `data-act="toggle"` directly onto a button would be the old
  // "Show details" control grown back somewhere else in the file. The title button
  // (bc-rfnr.9.8) is allowed to carry the act at runtime, but only by calling the same
  // function the article does — see the next section.
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

check('the act is written in exactly one place, which edit mode depends on', () => {
  // public/editmode.js anchors a tapped element by grepping this file for the markup
  // that produced it, with the comments blanked; a `data-act` is its strongest key
  // because one act has always meant one line. Both card renderers, and now the title
  // button too, interpolate `shutCardAct` rather than typing the attribute, and this is
  // why. Caught in review by scripts/editmode-check.mjs, which said `2 sites via
  // data-act="toggle"`.
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sites = code.match(/data-act="toggle"/g) || [];
  assert.equal(sites.length, 1, `${sites.length} lines of source produce this one control`);
  assert.match(APP, /const shutCardAct = \(open\) =>/, 'the one place it is written moved');
});

check('the list handler asks the guard before it acts on a card', () => {
  // The whole containment story is this one line: `closest('[data-act]')` resolving to
  // the article means nothing nearer claimed the tap, and that is when the guard runs.
  const at = APP.indexOf("listEl.addEventListener('click'");
  assert.notEqual(at, -1, 'the list click handler moved');
  const head = APP.slice(at, at + 600);
  assert.match(head, /classList\.contains\('card'\)\s*&&\s*!cardBodyOpens\(ev, btn\)/);
});

/* --------------------------------------------------- 5. the title is the way in, keyboard */

console.log('\nthe title is a real button, shut and open alike\n');

check('a shut question card`s title is a focusable button carrying the act and the key', () => {
  const html = draw('cardHtml', question());
  const btn = html.match(/<button type="button" class="q"[^>]*>[^<]*<\/button>/);
  assert.ok(btn, 'no <button class="q"> in the shut card');
  assert.match(btn[0], /data-act="toggle"/, 'the title would not open the card');
  assert.match(btn[0], /data-key="beadcause\/bc-aaa1"/, 'a tap on it would carry no key');
  assert.doesNotMatch(btn[0], /tabindex="-1"/, 'shut, it should be a normal tab stop');
  assert.match(btn[0], />Should the card be the control\?</, 'drew the tracker title, not source text');
});

check('open, the same title carries no act and drops out of the tab order', () => {
  // Still the same `<button>` — a `<p>`-when-open, `<button>`-when-shut split would be a
  // second literal `class="q"` an editmode anchor could no longer place by chain. What
  // changes is only that it has nothing left to do: `↑ Collapse` is the way out of an
  // open sheet, and `tabindex="-1"` keeps a control with no act off Tab without lying
  // about which element drew the heading.
  const html = draw('cardHtml', question(), { open: true });
  const btn = html.match(/<button type="button" class="q"[^>]*>[^<]*<\/button>/);
  assert.ok(btn, 'no <button class="q"> in the open card');
  assert.doesNotMatch(btn[0], /data-act="toggle"/, 'a tap on the brief would collapse the sheet');
  assert.match(btn[0], /tabindex="-1"/, 'a dead tab stop was left in the way');
  assert.match(btn[0], />Should the card be the control\?</);
});

check('a shut agent card`s title answers to the act too', () => {
  const html = draw('agentCardHtml', agentBead());
  const btn = html.match(/<button type="button" class="q"[^>]*>[^<]*<\/button>/);
  assert.ok(btn, 'no <button class="q"> in the shut agent card');
  assert.match(btn[0], /data-act="toggle"/);
  assert.match(btn[0], /data-key="beadcause\/bc-bbb2"/);
  assert.doesNotMatch(btn[0], /tabindex="-1"/);
  assert.match(btn[0], />Every card expands when you tap it</, 'the title, not the question');
});

check('open, the agent card`s title carries no act either', () => {
  const html = draw('agentCardHtml', agentBead(), { open: true });
  const btn = html.match(/<button type="button" class="q"[^>]*>[^<]*<\/button>/);
  assert.ok(btn);
  assert.doesNotMatch(btn[0], /data-act="toggle"/);
  assert.match(btn[0], /tabindex="-1"/);
});

check('the button is reset to read as the heading it replaces, not as browser chrome', () => {
  assert.match(CSS, /button\.q\s*\{[^}]*background:\s*none/, 'default button chrome left on the title');
  assert.match(CSS, /button\.q\s*\{[^}]*border:\s*none/, 'a border drawn around a heading');
  assert.match(CSS, /button\.q\s*\{[^}]*width:\s*100%/, 'not full width, so long titles would wrap oddly');
  assert.match(CSS, /button\.q\s*\{[^}]*font:\s*inherit/, 'the platform`s own button font, not the card`s');
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
