#!/usr/bin/env node
/**
 * An option answers from the shut card — and 💬 Discuss is the way to the box.
 *
 *     npm test
 *     node test/optionanswer.mjs
 *
 * bc-5ldc. Tapping a choice on a collapsed question card used to open the card and
 * write the option's words into the answer box, so the commonest thing anyone does
 * with a multiple-choice question — pick one, say nothing — cost an expand, a scroll
 * past the brief and a tap on a different button at the bottom of a full-screen
 * sheet. Now the shut card's buttons *are* the answer: arm, tap again, gone. What
 * that would otherwise take away is the qualified answer, so the third button under
 * the choices opens the card, and inside it an option tap fills the box exactly as it
 * always has.
 *
 * The whole design is therefore "the same button, two behaviours, decided by which
 * state the card is in", and that is precisely the shape a later refactor flattens
 * back into one. Five things are pinned here:
 *
 * 1. **The third button exists, is not a choice, and is drawn only while shut.** It
 *    carries `data-discuss` rather than a reserved option id — a card whose agent
 *    happened to write an option called `discuss` must not gain a second one — and it
 *    has no `data-opt`, which is what keeps it out of paintArmed()'s and
 *    paintPicked()'s loops. On an open card it is gone: you are already there.
 * 2. **The armed button says what the second tap does, and says which bead.** A hot
 *    button in a list of eight that reads "Yes" is an offer to answer *something*.
 *    `optionLabel` is asserted on both endings, because an option marked
 *    `closes: false` hands the bead back as work instead of finishing it and that is
 *    not a difference to discover from the toast afterwards.
 * 3. **A card redrawn under a hot button comes back hot.** The poll rebuilds this
 *    list every 25 seconds; `cardHtml` reads `state.armed` for the same reason
 *    paintArmed() exists.
 * 4. **The two painters agree with the render, and neither one blanks the third
 *    button.** paintPicked() writes `label.textContent` from `dataset.label`, and the
 *    Discuss button has none — the guard is one `continue`, and losing it empties the
 *    button rather than throwing.
 * 5. **The handler branches in the right order, and only the shut-and-empty case
 *    writes.** A source read, because the branch lives inside the list's one delegated
 *    click listener and cannot be lifted: the discuss branch returns before any
 *    option is looked up, the sending branch is guarded on *both* `state.open` and an
 *    empty draft — a card with half a sentence on it opens rather than answering over
 *    the words — and what it sends is the option's own response with its id.
 *
 * public/app.js is one IIFE with nothing exported, so the declarations are sliced out
 * and run in a `vm` the way test/cardtap.mjs does it, unknown globals stubbed through
 * a Proxy. No browser, no network, no `bd`.
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
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`);
  }
}

/** Lift one declaration out of public/app.js — copied from test/cardtap.mjs. */
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
 * The stub floor, exactly as test/cardtap.mjs explains it: `cardHtml` calls a dozen
 * sibling helpers this file has no opinion about, so unknown globals resolve through a
 * Proxy to a function returning `''`. Everything asserted below is either in the
 * literal of the article or the return value of something named in the lift list.
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
  CSS: { escape: (s) => s },
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
    lift(APP, 'const optionLabel = ('),
    lift(APP, 'function cardHtml(q)'),
    lift(APP, 'function paintPicked(key)'),
    lift(APP, 'function paintArmed()'),
  ].join('\n'),
  ctx
);

/** A `human` bead with two choices on it — one of them a commission. */
const question = (over = {}) => ({
  key: 'beadcause/bc-aaa1',
  workspace: 'beadcause',
  id: 'bc-aaa1',
  title: 'Which way round should the fee go?',
  question: 'Should the fee come off the gross or the net?',
  sections: [],
  decision: {
    options: [
      { id: 'gross', label: 'Gross — the full charge', response: 'Gross, please.', recommended: true },
      { id: 'net', label: 'Net — after the processor', response: 'Net, after the processor.' },
      { id: 'both', label: 'Build both and measure', response: 'Build both.', closes: false },
    ],
  },
  createdAt: '2026-08-15T00:00:00Z',
  ...over,
});

/** Put the page state the renderer reads in place, and draw. */
const draw = (q, { open = false, armed = null, draft = '' } = {}) => {
  real.state = { open: new Set(open ? [q.key] : []), menu: null, logs: new Set(), armed };
  real.getDraft = () => draft;
  real.pickedOption = () => null;
  real.propBulkHtml = () => '';
  return vm.runInContext('cardHtml(Q)', Object.assign(ctx, { Q: q }));
};

/** Everything between `<div class="options">` and the tag that closes it. */
const optionsBlock = (html) => {
  const at = html.indexOf('<div class="options">');
  assert.notEqual(at, -1, 'the card drew no options block at all');
  return html.slice(at, html.indexOf('</div>', at));
};

/* ----------------------------------------- 1. the third button, and where it is not */

console.log('\n💬 Discuss — the way to the box, drawn only where it leads somewhere\n');

check('a shut card with choices grows a third button that opens it', () => {
  const block = optionsBlock(draw(question()));
  assert.match(block, /class="option discuss"/, 'there is no third button');
  assert.match(block, /data-discuss="1"/, 'the handler cannot tell it from a choice');
  assert.match(block, /💬 Discuss/);
});

check('it is not a choice — no option id, so no write can be made out of it', () => {
  const btn = optionsBlock(draw(question())).match(/<button class="option discuss"[^>]*>/)[0];
  assert.doesNotMatch(btn, /data-opt=/, 'it carries an option id and could be resolved as one');
  assert.doesNotMatch(btn, /data-label=/, 'it looks like a choice to the painters');
  assert.match(btn, /data-key="beadcause\/bc-aaa1"/, 'the tap would carry no key');
});

check('it comes last, under the choices it is the alternative to', () => {
  const block = optionsBlock(draw(question()));
  assert.ok(block.indexOf('data-opt="both"') < block.indexOf('option discuss'), 'it is drawn above a choice');
});

check('an open card has no Discuss button — you are already in the discussion', () => {
  const html = draw(question(), { open: true });
  assert.doesNotMatch(html, /option discuss/, 'a button offering to open an open card');
  assert.match(html, /data-opt="gross"/, 'the fixture lost the choices as well');
});

check('a card with no choices grows no options block, and so no Discuss either', () => {
  const html = draw(question({ decision: { options: [] } }));
  assert.doesNotMatch(html, /class="options"/);
  assert.doesNotMatch(html, /option discuss/);
});

/* ---------------------------------------------------- 2. what an armed button says */

console.log('\nthe armed label says what the second tap does, and to which bead\n');

const label = (o, armed) =>
  vm.runInContext('optionLabel(Q, O, A)', Object.assign(ctx, { Q: question(), O: o, A: armed }));

check('unarmed it is the agent’s own words and nothing else', () => {
  assert.equal(label({ id: 'net', label: 'Net — after the processor' }, false), 'Net — after the processor');
});

check('armed it names the tap and the bead', () => {
  const said = label({ id: 'net', label: 'Net' }, true);
  assert.match(said, /tap again/i, `"${said}"`);
  assert.match(said, /answers/i, `"${said}"`);
  assert.ok(said.includes('bc-aaa1'), `"${said}" does not say which bead`);
});

check('and a commission says so rather than claiming to answer and close', () => {
  const said = label({ id: 'both', label: 'Build both', closes: false }, true);
  assert.match(said, /commissions/i, `"${said}"`);
  assert.ok(said.includes('bc-aaa1'), `"${said}" does not say which bead`);
});

/* ------------------------------------------- 3. a redraw under a hot button */

console.log('\nthe poll redraws the list every 25 seconds — the arm has to survive it\n');

check('a card rebuilt while a choice is armed comes back armed, saying the same thing', () => {
  const block = optionsBlock(draw(question(), { armed: 'beadcause/bc-aaa1|opt-net' }));
  const btn = block.match(/<button class="option[^"]*"[^>]*data-opt="net"[\s\S]*?<\/button>/)[0];
  assert.match(btn, /class="option confirm"/, 'it came back cold under a live arm');
  assert.match(btn, /Tap again — answers bc-aaa1/, 'it came back reading like an unarmed choice');
});

check('and its siblings do not — one arm at a time, on the card as on the screen', () => {
  const block = optionsBlock(draw(question(), { armed: 'beadcause/bc-aaa1|opt-net' }));
  const gross = block.match(/<button class="option[^"]*"[^>]*data-opt="gross"[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(gross, /confirm/, 'two buttons offering to answer the same bead');
  assert.match(gross, /Gross — the full charge/);
});

check('an arm belonging to another card leaves this one alone', () => {
  const block = optionsBlock(draw(question(), { armed: 'beadcause/bc-zzz9|opt-net' }));
  assert.doesNotMatch(block, /confirm/, 'one card armed another card’s button');
});

check('and an open card is never hot, whatever the arm still says', () => {
  // A card can be opened out from under a live arm by something that is not the
  // option handler — a notification, a deep link — and on an open card the next tap
  // fills the box. A button still offering to answer would be promising a write that
  // is not going to happen.
  const block = optionsBlock(draw(question(), { open: true, armed: 'beadcause/bc-aaa1|opt-net' }));
  assert.doesNotMatch(block, /confirm/, 'an open card offered to answer on the next tap');
  assert.doesNotMatch(block, /Tap again/, 'an open card promised a write it will not make');
});

/* ------------------------------------------------------------- 4. the two painters */

console.log('\npainted in place, without going through render()\n');

/**
 * The least DOM these two touch: a card holding its buttons, each with a `.label`
 * child and the dataset the painters read. `querySelectorAll` answers the two
 * selectors they actually use, which is the whole surface being faked.
 */
function fakeList(q, { armed = null } = {}) {
  const button = (classes, dataset, text) => ({
    dataset,
    classes: new Set(classes),
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    label: { textContent: text },
  });
  const buttons = (q.decision.options || []).map((o) =>
    button(['option'], { key: q.key, opt: o.id, label: o.label }, o.label)
  );
  const discuss = button(['option', 'discuss'], { key: q.key, discuss: '1' }, '💬 Discuss');
  for (const b of [...buttons, discuss]) {
    b.classList = {
      toggle: (name, on) => (on ? b.classes.add(name) : b.classes.delete(name)),
      contains: (name) => b.classes.has(name),
    };
    b.querySelector = (sel) => (sel === '.label' ? b.label : null);
  }
  const all = [...buttons, discuss];
  const card = {
    querySelectorAll: (sel) => (sel === '.option' ? all : sel === '.option[data-opt]' ? buttons : []),
    querySelector: () => null,
  };
  return {
    buttons,
    discuss,
    listEl: {
      querySelectorAll: (sel) => (sel === '.option[data-opt]' ? buttons : []),
      querySelector: () => card,
    },
  };
}

/** Run one painter against that DOM. */
const paint = (fn, q, { armed = null, key = q.key, open = false } = {}) => {
  const dom = fakeList(q, { armed });
  real.state = { open: new Set(open ? [q.key] : []), armed, picked: new Map(), logs: new Set() };
  real.listEl = dom.listEl;
  real.byKey = () => q;
  real.getDraft = () => '';
  real.pickedOption = () => null;
  real.isFrozen = () => false;
  real.dismissLabel = () => '';
  real.propBulkLabel = () => '';
  real.jiraCancelLabel = () => '';
  vm.runInContext(`${fn}(${JSON.stringify(key)})`, ctx);
  return dom;
};

check('paintArmed lights the armed choice and words it, and cools the rest', () => {
  const q = question();
  const dom = paint('paintArmed', q, { armed: `${q.key}|opt-net` });
  const net = dom.buttons.find((b) => b.dataset.opt === 'net');
  const gross = dom.buttons.find((b) => b.dataset.opt === 'gross');
  assert.ok(net.classes.has('confirm'), 'the armed button was not lit');
  assert.match(net.label.textContent, /Tap again — answers bc-aaa1/);
  assert.ok(!gross.classes.has('confirm'), 'a sibling stayed lit');
  assert.equal(gross.label.textContent, 'Gross — the full charge');
});

check('an arm stolen by something else takes every option button back down', () => {
  const q = question();
  const dom = paint('paintArmed', q, { armed: `${q.key}|dismiss` });
  for (const b of dom.buttons) {
    assert.ok(!b.classes.has('confirm'), `${b.dataset.opt} still offers to answer`);
    assert.equal(b.label.textContent, b.dataset.label);
  }
});

check('paintArmed lights nothing on an open card, where the tap fills the box', () => {
  const q = question();
  const dom = paint('paintArmed', q, { armed: `${q.key}|opt-net`, open: true });
  const net = dom.buttons.find((b) => b.dataset.opt === 'net');
  assert.ok(!net.classes.has('confirm'), 'an open card was lit as if the next tap would send');
  assert.equal(net.label.textContent, 'Net — after the processor');
});

check('paintPicked leaves the third button alone rather than blanking it', () => {
  const q = question();
  const dom = paint('paintPicked', q);
  assert.equal(dom.discuss.label.textContent, '💬 Discuss', 'the Discuss button lost its words');
  assert.equal(dom.discuss.attrs['aria-pressed'], undefined, 'it was given a pressed state it cannot be in');
});

check('paintPicked does not talk an armed button back down to the option’s own words', () => {
  const q = question();
  const dom = paint('paintPicked', q, { armed: `${q.key}|opt-net` });
  const net = dom.buttons.find((b) => b.dataset.opt === 'net');
  assert.match(net.label.textContent, /Tap again/, 'a repaint disarmed the label under a live arm');
});

/* --------------------------------------------------- 5. the handler, read in source */

console.log('\nthe handler: which branch takes the tap, and which one writes\n');

/** The `option` branch of the list's delegated click listener, comments and all. */
const branch = (() => {
  const at = APP.indexOf("if (act === 'option') {");
  assert.notEqual(at, -1, 'the option branch moved or was renamed');
  const end = APP.indexOf("if (act === 'suggest') {", at);
  assert.notEqual(end, -1, 'the suggest branch that used to follow it is gone');
  return APP.slice(at, end);
})();

check('the discuss branch returns before any option is looked up', () => {
  const discussAt = branch.indexOf('btn.dataset.discuss');
  const lookupAt = branch.indexOf('opts.find(');
  assert.notEqual(discussAt, -1, 'the third button reaches no branch of its own');
  assert.ok(discussAt < lookupAt, 'a choice is resolved before the Discuss button is ruled out');
  const head = branch.slice(discussAt, lookupAt);
  assert.match(head, /expand\(key\)/, 'the Discuss button does not open the card');
  assert.doesNotMatch(head, /submit\(/, 'the Discuss button can reach a write');
});

check('the sending branch is guarded on both the state and the draft', () => {
  assert.match(
    branch,
    /if \(!state\.open\.has\(key\) && !getDraft\(key\)\.trim\(\)\) \{/,
    'a shut card holding half a sentence could be answered over it'
  );
});

check('it arms first, under a token naming the option, and lets the arm expire', () => {
  assert.match(branch, /const token = `\$\{key\}\|opt-\$\{opt\.id\}`/, 'the arm is not per-option');
  assert.match(branch, /if \(state\.armed !== token\) \{[\s\S]*?return;/, 'the first tap does not stop at arming');
  assert.match(branch, /\}, 6000\)/, 'the arm never expires, or not on the six seconds everything else uses');
});

check('the second tap sends the option’s own words, with its id', () => {
  assert.match(
    branch,
    /submit\(key, opt\.response, \{ close: true, option: opt\.id \}\)/,
    'the shut-card answer is not the open card’s write'
  );
});

check('and keeps them first, because the tracker can still refuse the close', () => {
  // The gate is asked when a card opens and never on the list poll, so a shut card
  // cannot know. A 409 hands the card back open with the note on it — and with an
  // empty box, unless the words went into the draft before they went on the wire.
  const sendAt = branch.indexOf('submit(key, opt.response');
  const draftAt = branch.indexOf('setDraft(key, opt.response)');
  const pickAt = branch.indexOf('state.picked.set(key, opt.id)');
  assert.ok(draftAt !== -1 && draftAt < sendAt, 'a refused answer would come back to an empty box');
  assert.ok(pickAt !== -1 && pickAt < sendAt, 'a refused answer would come back with nothing lit');
});

check('and the open card still fills the box and writes nothing', () => {
  const boxAt = branch.indexOf("[data-role=\"answer\"]");
  assert.notEqual(boxAt, -1, 'the box-filling half is gone');
  const tail = branch.slice(boxAt);
  assert.match(tail, /state\.picked\.set\(key, opt\.id\)/, 'the pick is no longer remembered');
  assert.match(tail, /setDraft\(key, box\.value\)/, 'the words are no longer kept');
  assert.doesNotMatch(tail, /submit\(/, 'a tap on an open card sends without you');
});

/* ------------------------------------------------------------------- 6. the styling */

console.log('\nand it has to look like what it is\n');

check('an armed choice wears the amber every other second-tap control wears', () => {
  assert.match(CSS, /\.option\.confirm[^{]*\{[^}]*var\(--warn\)/, '.option.confirm has no rule');
});

check('the armed fill beats `picked`, which is a claim about a box that is not there', () => {
  assert.match(CSS, /\.option\.picked\.confirm/, 'a picked-then-armed button would stay mint');
});

check('the Discuss button is drawn quieter than the choices', () => {
  const at = CSS.indexOf('.option.discuss {');
  assert.notEqual(at, -1, '.option.discuss has no rule');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(rule, /background: transparent/, 'it is filled like a choice');
});

console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
