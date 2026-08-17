#!/usr/bin/env node
/**
 * ＋ belongs to the view, not to the chrome.
 *
 *     npm test
 *     node test/composekind.mjs
 *
 * Home's ＋ was drawn once, at load, and left there: one button on all five kind
 * screens, starting a chat session on every one of them. bc-khoe.27.1 makes it a
 * function of the kind you are looking at — `My Epics`, `Chats` and `All Beads` have a
 * create, `Questions` and `PRs` are queues of things waiting on a word from you and
 * have nothing to create.
 *
 * Which kinds is public/inboxfilter.js's, and test/inboxkinds.mjs checks it there. What
 * is checked here is public/app.js's half, which is three things that have to move
 * together and are three separate lines of code:
 *
 * 1. **The button.** Hidden on the `.compose-wrap`, so the picker above it goes with
 *    it. `hidden` on its own loses to `display: flex`, which is why the stylesheet is
 *    read below as well — a button that is still on screen while `has-compose` is off
 *    is the worst of both: it covers the last card *and* nothing reserves room for it.
 *
 * 2. **`body.has-compose`.** It is what pads the foot of the scroller by the button's
 *    height and lifts the toast clear. It used to be added once and never removed,
 *    which on a kind with no ＋ is 76px of nothing under the last card — a list that
 *    reads as still loading. So it is asserted in *both* directions, and the direction
 *    that would have passed before this bead is the one that matters.
 *
 * 3. **The picker.** `#compose-pick` asks which repo to start in. It is opened by a
 *    button, and a change of kind is a change of what that button would create — so it
 *    must not survive one, including on the three kinds that keep ＋. That is the
 *    acceptance criterion whose failure is silent: a panel left over the list, anchored
 *    to a button that now means something else.
 *
 * public/app.js is one IIFE with nothing exported, so the declarations are sliced out
 * and run in a `vm` the way test/cardtap.mjs and test/jirarow.mjs do it. The document
 * is hand-made and tiny: this block touches four nodes and a class list, so a fake with
 * four nodes and a real `Set` behind the class list is the whole room. No browser, no
 * network, no `bd`.
 *
 * The fallback is asserted too, and it is deliberately the *generous* one: a page
 * served without inboxfilter.js — a phone running a cached document against a newer
 * script, which is a state this app is built to survive — draws ＋ rather than losing
 * the primary action to a missing file.
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
const HTML = read('public/index.html');

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
 * Lift one declaration out of public/app.js — the same two shapes test/cardtap.mjs
 * lifts, copied rather than shared because a helper module between two suites that read
 * one file by hand is a third thing to keep true.
 */
function lift(opener) {
  const at = APP.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  if (opener.startsWith('function')) {
    let depth = 0;
    for (let i = APP.indexOf('{', at); i < APP.length; i += 1) {
      if (APP[i] === '{') depth += 1;
      else if (APP[i] === '}') {
        depth -= 1;
        if (!depth) return APP.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener}`);
  }
  let depth = 0;
  for (let i = at; i < APP.length; i += 1) {
    const c = APP[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return APP.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${opener}`);
}

/* --------------------------------------------------------------- the room */

/** A class list with the real semantics of the one method under test. */
function classList() {
  const on = new Set();
  return {
    all: on,
    add: (c) => on.add(c),
    remove: (c) => on.delete(c),
    contains: (c) => on.has(c),
    toggle(c, force) {
      if (force === undefined) return on.has(c) ? (on.delete(c), false) : (on.add(c), true);
      if (force) on.add(c);
      else on.delete(c);
      return Boolean(force);
    },
  };
}

const node = (name) => ({
  name,
  hidden: false,
  attrs: {},
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  },
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  },
});

/**
 * Build the block, with a filter that answers whatever this check wants it to.
 *
 * `composes` is passed rather than the whole filter so a test can hand in `null` for
 * "inboxfilter.js never loaded" — which is a different room from "loaded and says no",
 * and the two are the reason the fallback exists.
 */
function room({ filter = true } = {}) {
  const els = {
    '#compose': node('compose'),
    '#compose-pick': node('compose-pick'),
    '.compose-wrap': node('compose-wrap'),
  };
  const listeners = [];
  const document = { body: { classList: classList() } };
  const window = { beadcause: {} };
  let says = true;
  if (filter) {
    window.beadcause.inboxFilter = {
      composes: () => says,
      onChange: (fn) => listeners.push(fn),
    };
  }
  const ctx = vm.createContext({
    window,
    document,
    $: (sel) => els[sel] || null,
  });
  vm.runInContext(
    [
      lift("const composeEl = $('#compose');"),
      lift("const composePickEl = $('#compose-pick');"),
      lift("const composeWrapEl = $('.compose-wrap');"),
      lift('function hideComposePick()'),
      lift('function paintCompose()'),
      'globalThis.paintCompose = paintCompose;',
    ].join('\n'),
    ctx
  );
  return {
    els,
    listeners,
    body: document.body.classList,
    /** Say which kind you are on, in the only terms this block asks about. */
    say(v) {
      says = v;
    },
    paint: () => ctx.paintCompose(),
  };
}

console.log('\n＋ is drawn on the kinds that have a create');

await check('a kind with a create draws it and pays for the space it takes', () => {
  const r = room();
  r.say(true);
  r.paint();
  assert.equal(r.els['.compose-wrap'].hidden, false, 'the button is not on screen');
  assert.ok(r.body.contains('has-compose'), 'nothing reserved room at the foot of the list');
});

await check('a kind with none draws no ＋ and reserves no room for one', () => {
  // The whole of the bead: `has-compose` used to be added once at load and left, so
  // this assertion is the one that could not have passed before it.
  const r = room();
  r.say(false);
  r.paint();
  assert.equal(r.els['.compose-wrap'].hidden, true, '＋ is still on screen');
  assert.ok(!r.body.contains('has-compose'), '76px of nothing at the foot of the list');
});

await check('it comes back — the button is not lost for the session by one tap', () => {
  const r = room();
  r.say(false);
  r.paint();
  r.say(true);
  r.paint();
  assert.equal(r.els['.compose-wrap'].hidden, false);
  assert.ok(r.body.contains('has-compose'));
});

await check('the wrapper is what hides, so the picker cannot outlive its button', () => {
  // Hiding `#compose` alone would leave `#compose-pick` — a panel over the list with
  // nothing anchoring it and nothing to shut it.
  const r = room();
  r.els['#compose-pick'].hidden = false;
  r.say(false);
  r.paint();
  assert.equal(r.els['.compose-wrap'].hidden, true, 'the wrapper stayed on screen');
  assert.equal(r.els['#compose-pick'].hidden, true, 'the picker survived its button');
});

await check('an open picker closes on a change of kind that keeps ＋', () => {
  // The acceptance criterion with the quiet failure. `All Beads` and `Chats` both have
  // a ＋ and it creates a different thing on each, so a picker opened under one must
  // not still be open under the other — the button is on screen either way, which is
  // exactly why nothing about the screen would say it was wrong.
  const r = room();
  r.say(true);
  r.els['#compose-pick'].hidden = false;
  r.els['#compose'].setAttribute('aria-expanded', 'true');
  r.paint();
  assert.equal(r.els['#compose-pick'].hidden, true, 'the picker survived the kind change');
  assert.equal(r.els['#compose'].getAttribute('aria-expanded'), 'false', 'aria still claims it is open');
  assert.equal(r.els['.compose-wrap'].hidden, false, 'and the button went with it');
});

await check('no inboxfilter.js at all still draws ＋ — the generous fallback', () => {
  // A cached document against a script that never loaded is a state this app survives
  // elsewhere; losing the primary action to it would be a worse failure than drawing
  // the button on a screen with nothing to create.
  const r = room({ filter: false });
  r.paint();
  assert.equal(r.els['.compose-wrap'].hidden, false);
  assert.ok(r.body.contains('has-compose'));
});

console.log('\nand the page wires it to the kind, once and then on every change');

await check('app.js follows the filter rather than painting once', () => {
  assert.match(
    APP,
    /inboxFilter\?\.onChange\?\.\(paintCompose\)/,
    'nothing repaints ＋ when the kind changes'
  );
  // The line this bead removes. A bare add would put the padding back on every kind
  // and no assertion above would see it, because the vm never runs the wiring block.
  assert.doesNotMatch(
    APP,
    /classList\.add\('has-compose'\)/,
    'has-compose is still added unconditionally at load'
  );
});

await check('and paints once at load, for the kind restored from disk', () => {
  // `?kind=` and the stored selection are both settled at the foot of inboxfilter.js,
  // which runs before app.js — so the first paint is not "the default", it is whatever
  // the phone came back to.
  const wiring = APP.slice(APP.indexOf('if (composeEl && composePickEl)'));
  const at = wiring.indexOf('paintCompose();');
  assert.notEqual(at, -1, 'nothing paints ＋ at load');
  assert.ok(at < wiring.indexOf('BeadcauseNative'), 'the load paint is outside the ＋ block');
});

await check('the stylesheet honours [hidden] on a flexed wrapper', () => {
  // The standing trap with this attribute: `display: flex` beats the UA rule, so
  // `hidden` on `.compose-wrap` does nothing at all without this line and the button
  // stays on screen with nothing reserving room for it.
  const rule = /\.compose-wrap\[hidden\]\s*\{[^}]*display:\s*none/;
  assert.match(CSS, rule, '.compose-wrap[hidden] is not hidden');
  assert.match(CSS, /\.compose-wrap\s*\{[^}]*display:\s*flex/, '.compose-wrap stopped being flexed — check the rule above is still needed');
});

await check('the picker is inside the wrapper, which is what makes hiding it enough', () => {
  const wrap = HTML.slice(HTML.indexOf('<div class="compose-wrap">'));
  const end = wrap.indexOf('</div>', wrap.indexOf('id="compose"'));
  const inside = wrap.slice(0, end);
  assert.ok(inside.includes('id="compose-pick"'), 'the picker is not inside .compose-wrap');
  assert.ok(inside.includes('id="compose"'), 'the button is not inside .compose-wrap');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m` : `\n\x1b[32mall ${ran} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
