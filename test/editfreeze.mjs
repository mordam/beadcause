#!/usr/bin/env node
/**
 * The freeze covers every writer of the screen, not just the poll.
 *
 *     npm test
 *     node test/editfreeze.mjs
 *
 * Edit mode (public/editmode.js) holds the inbox still so that a tap can point at an
 * element instead of acting on it. The premise is worth nothing if the element is gone by
 * the time the tap is handled — which is the same root cause as bc-nh19 — so the mode's
 * one real obligation is that *nothing* repaints while it is on.
 *
 * bc-p49x.1 gated the two entry points the poll goes through, `render()` and
 * `paintList()`, and scripts/editmode-check.mjs proves a whole poll cycle passes with the
 * DOM untouched. bc-p49x.5 found three more writers that the poll is not:
 *
 *   1. **Six arm timers.** Merge, ship, dismiss, a proposal's two bulk buttons and a JIRA
 *      cancel each set a six-second `setTimeout` that disarms and repaints in place. Arm
 *      one, enter the mode within those six seconds, and the card under your thumb is
 *      rewritten — `paintPrCard` `replaceWith`s it outright.
 *   2. **The log tail**, written straight into the open `<pre>` on a two-second clock.
 *   3. **The space picker**, handed a fresh payload by `publishSpaces` on every poll.
 *
 * (3) is behaviour and is checked as behaviour, in test/spacebar.mjs, which runs the real
 * public/spacebar.js in a vm. (1) and (2) live inside public/app.js, which is one 7000-line
 * IIFE that needs a whole document to run, so what is asserted here is what a refactor
 * breaks silently — see test/quietcard.mjs and test/sweepfail.mjs for the same bargain.
 *
 * **Read as code, never as prose.** Every file in this repo argues in comments that name
 * the identifiers, so a slice-and-grep over a block is routinely satisfied by the
 * paragraph above the line it is guarding (bc-0i27.3). So the assertions here are on the
 * *first statement* of a function with comment lines dropped — an exact string, in a known
 * position — rather than on whether a name appears somewhere in a region.
 *
 * The last check is the one worth having in a year: it slices every `state.armedTimer`
 * handler in the file and refuses any that repaints through a function not on the gated
 * list. A seventh armed control added next spring cannot quietly reintroduce the bug.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

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
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/* ------------------------------------------------------------------- slicing */

/**
 * The body of the one thing in the file that starts with `header`, by brace matching.
 *
 * Brace counting is sound over these functions and unsound in general — a `{` inside a
 * string or a regex would throw it off. It does not fail quietly: an unbalanced slice runs
 * off the end of the file and the check that reads it goes red naming the header. Same
 * technique as test/jirarow.mjs, and the same caveat.
 */
function braceBody(src, from, what) {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`\`${what}\` never closes`);
}

function bodyAfter(src, header) {
  const at = src.indexOf(header);
  assert.notEqual(at, -1, `public/app.js no longer contains \`${header}\``);
  assert.equal(src.indexOf(header, at + 1), -1, `\`${header}\` appears more than once — slice is ambiguous`);
  return braceBody(src, at + header.length - 1, header);
}

/**
 * The lines of a body that are code.
 *
 * Comment lines are dropped by how they *start*, not by a global comment strip: a regex
 * that eats `//` to end of line eats half the URLs in the file, and one that eats `/* … *\/`
 * pairs eats them out of template literals too. Every prose comment in this codebase is on
 * a line of its own, which is what makes the cheap test the safe one.
 */
const codeLines = (body) =>
  body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));

const firstStatement = (header) => codeLines(bodyAfter(APP, header))[0];

/* --------------------------------------------------------------------- checks */

console.log('\nthe edit-mode freeze');

/* -------------------------------------------------- what the freeze is asked with */

check('the freeze is one question, asked of edit mode, defined once', () => {
  const lines = codeLines(APP).filter((l) => l.startsWith('const isFrozen'));
  assert.equal(lines.length, 1, `isFrozen is defined ${lines.length} times`);
  assert.match(lines[0], /window\.beadcause\?\.editMode\?\.frozen\?\.\(\)/);
});

/* --------------------------------------------- bc-p49x.1: the poll's two entry points */

check('render() defers before it looks at `force` — a forced repaint is the case, not the exception', () => {
  const body = codeLines(bodyAfter(APP, 'function render(force = false) {'));
  assert.equal(body[0], 'if (isFrozen()) {', `render() opens with: ${body[0]}`);
  assert.equal(body[1], 'pendingRender = true;');
  // Before the isAnswering() test, or a forced repaint would walk straight past it.
  assert.ok(body.indexOf('if (!force && isAnswering()) {') > 0, 'the answering gate has gone');
  assert.ok(body.indexOf('if (isFrozen()) {') < body.indexOf('if (!force && isAnswering()) {'));
});

check('paintList() defers too, so the offline panel cannot replace a frozen list', () => {
  assert.equal(firstStatement('function paintList(chunks) {'), 'if (isFrozen()) return;');
});

/* ------------------------------------------- bc-p49x.5, 1: the four in-place painters */

// Between them these are every repaint in public/app.js that is not a render(): the
// expiry of all six arm timers, and every act on a pull request that redraws its card
// mid-flight. Each gate is the FIRST statement, so nothing — not a querySelector, not a
// draft read-back — happens under a frozen screen.
for (const [what, header] of [
  ['paintPrCard', 'function paintPrCard(key) {'],
  ['paintPr', 'function paintPr(key) {'],
  ['paintPicks', 'function paintPicks(key) {'],
  ['paintArmed', 'function paintArmed() {'],
]) {
  check(`${what}() holds its repaint while the screen is frozen, before anything else`, () => {
    assert.equal(firstStatement(header), 'if (isFrozen()) return;', `${what}() opens with something else`);
  });
}

check('every arm timer repaints through one of those, so a seventh cannot reintroduce the bug', () => {
  // Gated painters, plus the two that touch no DOM at all.
  const GATED = new Set(['disarm', 'clearTimeout', 'render', 'paintPrCard', 'paintPr', 'paintPicks', 'paintArmed']);
  const ARM = 'state.armedTimer = setTimeout(';
  const handlers = [];
  for (let at = APP.indexOf(ARM); at !== -1; at = APP.indexOf(ARM, at + 1)) {
    handlers.push(braceBody(APP, at + ARM.length, ARM));
  }
  assert.ok(handlers.length >= 6, `expected the six armed controls, sliced ${handlers.length}`);
  const loose = [];
  for (const body of handlers) {
    for (const line of codeLines(body)) {
      for (const [, name] of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (!GATED.has(name)) loose.push(`${name}() in \`${line}\``);
      }
    }
  }
  assert.deepEqual(loose, [], `an arm timer repaints through something ungated: ${loose.join('; ')}`);
});

/* --------------------------------------------------------- bc-p49x.5, 2: the log tail */

check('the log tail holds the write to the <pre> — and only the write', () => {
  const body = codeLines(bodyAfter(APP, 'async function pollLogs(only = null) {'));
  const state = body.indexOf('state.logText.set(key, text);');
  const gate = body.indexOf('if (isFrozen()) continue;');
  const write = body.findIndex((l) => l.startsWith('const pre = listEl.querySelector('));
  assert.ok(state !== -1, 'pollLogs no longer keeps the text in state');
  assert.ok(gate !== -1, 'pollLogs writes to the DOM with no frozen gate at all');
  assert.ok(write !== -1, 'pollLogs no longer looks the <pre> up');
  // The order is the whole of it. Gated before the read and the mode would need a refetch
  // to catch up; gated after the write and there is nothing left to hold.
  assert.ok(state < gate, 'the gate is above the state write — the log would go stale, not late');
  assert.ok(gate < write, 'the gate is below the DOM write — it holds nothing');
  // `continue`, not `return`: one open pane being held must not stop the others being read.
  assert.ok(!body.includes('if (isFrozen()) return;'), 'a return here would stop reading the other panes');
});

/* ---------------------------------------------------- bc-p49x.5, 3: the picker, in situ */

check('the picker asks for itself, in public/spacebar.js — it is on six pages, not one', () => {
  const bar = fs.readFileSync(path.join(ROOT, 'public', 'spacebar.js'), 'utf8');
  const body = codeLines(bodyAfter(bar, 'function paint() {'));
  // bc-ka5y.33: only the *rows* wait for the thaw — rebuilding them is the one write that
  // moves an option out from under a thumb. The title and the control's own value name
  // nothing that is not already true, so they write on every paint whether or not the
  // mode is frozen; a pick made mid-freeze used to leave them stale until the thaw, under
  // a banner promising the screen was held still.
  //
  // There was a third, `shownEl.textContent`, and bc-ka5y.34 deleted the span it wrote to
  // — the picker is the `<select>` itself now, so what the bar reads *is* the control's
  // own value and there is no second string to keep in step. The pair below is what the
  // split still has to protect, and test/spacebar.mjs asserts the same two behaviourally.
  assert.equal(body[0], 'const frozen = window.beadcause?.editMode?.frozen?.();', `paint() opens with: ${body[0]}`);
  const ifFrozen = body.indexOf('if (frozen) {');
  const thawCall = body.indexOf('thawFirst();');
  const rowsWrite = body.indexOf('sel.innerHTML = html;');
  const valueWrite = body.indexOf('if (sel.value !== now) sel.value = now;');
  const titleWrite = body.indexOf('if (sel.title !== label()) sel.title = label();');
  assert.ok(ifFrozen !== -1, 'paint() no longer branches on frozen at all');
  assert.ok(thawCall > ifFrozen, 'the frozen branch no longer registers the thaw catch-up');
  assert.ok(rowsWrite > ifFrozen, 'the rows rebuild is not gated behind the frozen branch');
  for (const [name, at] of [['sel.value', valueWrite], ['sel.title', titleWrite]]) {
    assert.ok(at !== -1, `paint() no longer writes ${name} at all`);
    assert.ok(at > rowsWrite, `${name} is written before the rows guard, not unconditionally after it`);
  }
  // And the catch-up is that file's own, which it was not when this landed: the last line
  // of app.js's render() was `publishCounts()`, a `space.adopt()` that ended in `paint()`,
  // so the repaint that thawed the list repainted the bar with it. bc-ka5y.1 deleted the
  // picker's counts and that call with them, so `thawFirst()` registers a one-shot
  // `editMode.onChange` from inside the freeze instead. Asserted here rather than left to
  // spacebar.js's own suite because *this* is the file that says the bar catches up.
  assert.ok(/function thawFirst\(\) \{/.test(bar), 'spacebar.js has no thaw repaint at all');
  const thaw = codeLines(bodyAfter(bar, 'function thawFirst() {'));
  assert.ok(
    thaw.some((l) => l.includes('mode.onChange(')),
    `thawFirst() never registers a listener: ${thaw.join(' | ')}`
  );
  assert.ok(
    thaw.some((l) => l.includes('if (!mode.frozen?.()) paint();')),
    'the thaw listener does not repaint on the way out'
  );
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
