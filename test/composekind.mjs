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
 * 3. **The picker.** `#compose-pick` asks which repo to start in, and since
 *    bc-khoe.27.2 `#compose-epics` offers the epics you could start. Either is opened by
 *    the same button, and a change of kind is a change of what that button would create —
 *    so neither must survive one, including on the kinds that keep ＋. That is the
 *    acceptance criterion whose failure is silent: a panel left over the list, anchored
 *    to a button that now means something else. Both are shut on every paint, whichever
 *    was open, because the one that is open belongs to the kind you just left.
 *
 * 4. **What the button says it does**, since bc-khoe.27.2 — its `aria-label`, and the
 *    `aria-controls` naming the panel this kind's tap opens. It is the only thing on this
 *    control that says what will happen, so a ＋ announcing "start a chat session" on the
 *    screen where it starts an epic is worse than an unlabelled one: a screen reader reads
 *    out the wrong promise rather than none.
 *
 * public/app.js is one IIFE with nothing exported, so the declarations are sliced out
 * and run in a `vm` the way test/cardtap.mjs and test/jirarow.mjs do it. The document
 * is hand-made and tiny: this block touches five nodes and a class list, so a fake with
 * five nodes and a real `Set` behind the class list is the whole room. No browser, no
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
    // bc-khoe.27.2's second panel. Hidden like the first, and hidden *with* the first:
    // the checks below are what make "either one" true rather than "the one this kind
    // uses", which is the shape that leaves a panel behind on a change of kind.
    '#compose-epics': node('compose-epics'),
    '.compose-wrap': node('compose-wrap'),
  };
  const listeners = [];
  const document = { body: { classList: classList() } };
  const window = { beadcause: {} };
  let says = true;
  let makes = 'chat';
  if (filter) {
    window.beadcause.inboxFilter = {
      composes: () => says,
      // The word for what ＋ makes here, off the same `compose` field. `paintCompose`
      // reads it for the label and the `aria-controls`; the click listener reads it to
      // decide which panel to open, and that half is public/app.js's own wiring rather
      // than anything this room drives.
      creates: () => makes,
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
      lift("const composeEpicsEl = $('#compose-epics');"),
      lift("const composeWrapEl = $('.compose-wrap');"),
      lift('function hideComposePick()'),
      lift('const COMPOSE_SAYS = '),
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
    /** And what ＋ would make there — `chat`, `epic`, or a word this file has never heard. */
    makes(v) {
      makes = v;
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

await check('AND SO DOES THE EPIC ONE — both panels shut, whichever was open', () => {
  // The bug this exists to stop is one-sided closing. `hideComposePick` shuts the panel
  // it was named after and, if it stopped there, the panel belonging to the kind you just
  // left would sit over the list anchored to a ＋ that now means something else — the same
  // failure as the check above, arriving through the panel that was added later.
  const r = room();
  r.makes('epic');
  r.els['#compose-epics'].hidden = false;
  r.els['#compose'].setAttribute('aria-expanded', 'true');
  r.makes('chat');
  r.paint();
  assert.equal(r.els['#compose-epics'].hidden, true, 'the epic picker survived the kind change');
  assert.equal(r.els['#compose-pick'].hidden, true, 'the repo picker was left open by the paint');
  assert.equal(r.els['#compose'].getAttribute('aria-expanded'), 'false', 'aria still claims it is open');
});

await check('THE BUTTON SAYS WHAT IT WOULD MAKE, and points at the panel that would open', () => {
  // The only thing on this control that says what a tap will do. Wrong is worse than
  // absent here: a screen reader reading "start a chat session" on the screen where ＋
  // starts an epic is a promise the app does not keep.
  const r = room();
  r.makes('epic');
  r.paint();
  assert.match(r.els['#compose'].getAttribute('aria-label'), /epic/i, '＋ still offers a chat on My Epics');
  assert.equal(r.els['#compose'].getAttribute('aria-controls'), 'compose-epics');
  r.makes('chat');
  r.paint();
  assert.match(r.els['#compose'].getAttribute('aria-label'), /chat/i, '＋ no longer offers a chat on Chats');
  assert.equal(r.els['#compose'].getAttribute('aria-controls'), 'compose-pick');
});

await check('and a word this file has never heard of falls back to the chat, not to nothing', () => {
  // bc-khoe.27.3 will add `bead` to the table before it adds a branch here, and the order
  // is not guaranteed on a phone holding one half of a deploy. An unlabelled ＋ or a
  // `null` `aria-controls` is a worse outcome than the create it has always made.
  const r = room();
  r.makes('bead');
  r.paint();
  assert.match(r.els['#compose'].getAttribute('aria-label'), /chat/i, 'an unknown create left ＋ saying nothing');
  assert.equal(r.els['#compose'].getAttribute('aria-controls'), 'compose-pick');
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

await check('the pickers are inside the wrapper, which is what makes hiding it enough', () => {
  const wrap = HTML.slice(HTML.indexOf('<div class="compose-wrap">'));
  const end = wrap.indexOf('</div>', wrap.indexOf('id="compose"'));
  const inside = wrap.slice(0, end);
  assert.ok(inside.includes('id="compose-pick"'), 'the picker is not inside .compose-wrap');
  assert.ok(inside.includes('id="compose-epics"'), 'the epic picker is not inside .compose-wrap');
  assert.ok(inside.includes('id="compose"'), 'the button is not inside .compose-wrap');
});

await check('one ＋, and the kind decides which create it is', () => {
  // Read off public/app.js rather than driven, because the click listener needs a real
  // event target and this room has no DOM to dispatch one into. What is worth pinning is
  // that the branch asks the kind table for the word instead of keeping a list of kind ids
  // here — a second file that knows what the six kinds are is a second file that can be
  // wrong about them, with nothing to say which.
  // Bounded to the block, unlike the slice in "paints once at load" above, which wants
  // the rest of the file so it can prove the load paint falls *before* the next landmark.
  // Open-ended here was true only while this wiring was the last thing in app.js:
  // bc-khoe.30.4 then appended `stage.register('epics', { build: buildHome })` after it,
  // and that `'epics'` is a *pane* id for the shell, not a kind id kept by this wiring.
  // Same idiom as test/p0card.mjs — the block closes at a two-space `}`.
  const from = APP.indexOf('if (composeEl && composePickEl)');
  assert.notEqual(from, -1, 'the compose wiring is gone');
  const wiring = APP.slice(from, APP.indexOf('\n  }', from));
  assert.ok(wiring.includes('paintCompose();'), 'the slice stopped short of the whole block');
  assert.match(wiring, /inboxFilter\?\.creates\?\.\(\) \|\| 'chat'\) === 'epic'/, '＋ does not branch on the kind');
  assert.match(wiring, /showEpicPick\(\);/, 'nothing opens the epic picker');
  assert.doesNotMatch(wiring, /'epics'/, "the wiring keeps its own copy of a kind's id");
  // And a second tap on ＋ is always "never mind", whichever panel is the open one.
  assert.match(wiring, /!composePickEl\.hidden \|\| !composeEpicsEl\?\.hidden/, 'the toggle only sees one panel');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m` : `\n\x1b[32mall ${ran} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
