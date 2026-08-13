#!/usr/bin/env node
/**
 * A JIRA ticket as a row in the inbox — its own kind, and never a question.
 *
 *     npm test
 *     node test/jirarow.mjs
 *
 * The tickets assigned to you arrive in the inbox as a section of their own (bc-0i27.3),
 * and the whole of what makes them one is a row in `KINDS` (public/inboxfilter.js) plus a
 * synthesised row in public/app.js. test/inboxkinds.mjs owns the table — that every row
 * matches exactly one kind, in both directions, with a JIRA ticket among the fixtures.
 * What is left over is this half, and four things about it are worth a suite:
 *
 * 1. **The word that keeps a ticket out of the questions.** The `question` kind's test is
 *    "none of the above", so it silently absorbs anything new: without `!q.jira` in it,
 *    every ticket draws under **Questions**, is counted in the Questions chip, and
 *    appears on a screen narrowed to *the beads asking you something*. That does not
 *    look broken — it looks like an inbox with more questions in it — and nothing else
 *    in the codebase would catch it. It is asserted here as well as through the table
 *    because it is the one line in this feature that fails silently.
 *
 * 2. **A ticket is not in `state.questions`.** Nearly everything reading that array is
 *    about beads: the waiting count, the space picker's per-repo numbers, `byKey`, the
 *    answer path. A ticket would be counted by all of them and answered by none, which
 *    is the reason the pull requests and the chat sessions are rows too. The check is a
 *    static read of the two places it could go wrong — where the payload is adopted, and
 *    what `publishView` hands the monitor.
 *
 * 3. **The row actually draws the ticket.** Not "the renderer mentions `t.key`" — the
 *    real function is sliced out of public/app.js and run over a fixture of the shape
 *    bc-0i27.2's poller holds (key, summary, status, updated, url, assignee), and its
 *    HTML is asserted. That is what makes this a guard rather than a spelling test, and
 *    it costs no browser: the function touches no DOM, only `esc` and `relTime`.
 *
 * 4. **A ticket obeys the space picker.** Quiet is per space (lib/spaces.js) and a
 *    workspace belongs to a space, so a ticket is as quiet as anything else in its
 *    space — but only if the row carries one. A row without a space collects under
 *    "Other" and vanishes the moment a space is picked, which is the same requirement
 *    the chat rows put on the server.
 *
 * No `bd`, no network, no browser. The client is read the way test/quietcard.mjs and
 * test/sweepfail.mjs read it, for the reason quietcard gives: the inbox's renderer needs
 * the whole document to run, so what is checked is what a refactor breaks silently.
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
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const APP = read('public/app.js');
const FILTER = read('public/inboxfilter.js');
const CSS = read('public/style.css');

/** One held ticket, exactly the shape bc-0i27.2 fixed: enough to draw with no second call. */
const TICKET = {
  key: 'TECH-1204',
  summary: 'The meter reads zero after a reconnect',
  status: 'In Progress',
  updated: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  url: 'https://example.atlassian.net/browse/TECH-1204',
  assignee: 'adam.morgan@climative.ai',
};

/**
 * Lift one declaration out of public/app.js.
 *
 * The file is one IIFE with nothing exported, so this is the only way to run a piece of
 * it without a document — and it is worth the twenty lines, because the alternative is
 * asserting that the source contains the string `t.status`, which passes just as happily
 * when the row draws it into a comment.
 *
 * Two shapes, because the three declarations it is asked for are two shapes: a
 * `function` ends at its balanced closing brace, and a `const` arrow ends at the first
 * `;` outside every bracket. Nothing here tracks strings, which is sound over these
 * three specifically — none of them holds a brace, a paren or a semicolon inside a
 * string or a regex — and unsound in general. It does not fail quietly if that changes:
 * the slice stops parsing and this suite goes red with a SyntaxError naming the line.
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
 * The row renderer, run for real, with the helpers it borrows from around it.
 *
 * Both halves under the row come along because the row *calls* them — what they draw is
 * test/jiraingest.mjs's and test/jiragate.mjs's business, and what is needed here is
 * only that lifting the row still produces a row. The three pieces of page state
 * `jiraActsHtml` reads are given their empty values: nothing armed, nothing in flight,
 * nothing said.
 */
function renderRow(row) {
  const context = vm.createContext({ Date, String, Math, JSON, Number, encodeURIComponent });
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'function relTime(iso)'),
      lift(APP, 'function graphUrl(q)'),
      // The second half of the row since bc-0i27.5 — what beadcause made of the ticket.
      // test/jiraingest.mjs owns what it says; it is lifted here because without it the
      // row does not render at all, and this suite is about the row.
      lift(APP, 'function jiraIngestHtml(row)'),
      // And the third since bc-0i27.7 — approve, discuss, cancel. Same reason again:
      // test/jiragate.mjs owns what it draws.
      lift(APP, 'const jiraCancelLabel = ('),
      lift(APP, 'function jiraActsHtml(row)'),
      lift(APP, 'function jiraRowHtml(row)'),
      'globalThis.out = jiraRowHtml(ROW);',
    ].join('\n'),
    Object.assign(context, { ROW: row, state: { armed: null }, jiraSaid: new Map(), jiraBusy: new Set() })
  );
  return context.out;
}

console.log('\na JIRA ticket is its own kind, not a question');

await check('the question predicate refuses a ticket, by name', () => {
  // The `test:` line and not the block around it. That block *argues* for `!q.jira` in
  // three lines of comment directly above the predicate, so a slice-and-grep is
  // satisfied by the prose alone — which is exactly the shape of check that passes on
  // the day somebody deletes the word it is guarding. Measured: dropping `!q.jira` from
  // the predicate leaves this file matching `/!q\.jira/` five times.
  const block = FILTER.slice(FILTER.indexOf("id: 'question'"), FILTER.indexOf("id: 'proposal'"));
  const [line] = block.split('\n').filter((l) => l.trim().startsWith('test:'));
  assert.ok(line, 'the question kind no longer has a predicate');
  assert.match(line, /!q\.jira/, 'the "none of the above" predicate would absorb every ticket');
});

await check('and the table has a row of its own for it, on neither side', () => {
  const row = FILTER.slice(FILTER.indexOf("id: 'jira'"), FILTER.indexOf("id: 'claimed'"));
  assert.match(row, /side: 'any'/, "a ticket comes off JIRA — no `bd` scope could have missed it");
  assert.match(row, /label: '[^']+'/, 'no chip label');
  assert.match(row, /note: '[^']+'/, 'no note — the chip would have no accessible name');
  assert.match(row, /test: \(q\) => Boolean\(q\.jira\)/, 'nothing tests for a ticket');
});

console.log('\nand it is a row, not a bead');

await check('the payload field is adopted, and into an array of its own', () => {
  assert.match(APP, /data\.tickets/, 'app.js never reads the field the poller sends');
  assert.match(APP, /state\.tickets = data\.tickets/, 'not held on the page');
  // The failure this is about: `state.questions` is read by the waiting count, the
  // picker's per-repo numbers, `byKey` and the answer path. A ticket in there would be
  // counted by all four and answerable by none. So every write to that array is
  // enumerated, and none of them may mention a ticket.
  const writes = [...APP.matchAll(/state\.questions\s*=\s*([^\n;]+)/g)].map((m) => m[1]);
  assert.ok(writes.length, 'nothing assigns state.questions any more — this check has gone stale');
  for (const w of writes) assert.doesNotMatch(w, /ticket/i, `a ticket is written into the beads: ${w}`);
});

await check('the rows are synthesised at render time, in their own namespace', () => {
  const rows = lift(APP, 'const jiraRows = ()');
  assert.match(rows, /state\.tickets/, 'built from something other than the payload field');
  assert.match(rows, /`jira:/, 'the key is not namespaced — it could collide with a bead');
  assert.match(APP, /\.\.\.jiraRows\(\)/, 'the rows never reach the list');
});

await check('a row carries the space, or the picker makes it disappear', () => {
  // Not cosmetic: `render()` filters on `spaceOf(q)` before anything else, and a row
  // with no space answers to "Other". This is also the whole of the acceptance
  // criterion about quiet hours — quiet is per space, so a ticket in a quiet space is
  // as quiet as its questions only because the row knows which space it is in.
  const rows = lift(APP, 'const jiraRows = ()');
  assert.match(rows, /space:/, 'no space on the row');
  assert.match(rows, /workspace:/, 'no workspace on the row');
});

await check('the monitor is not told a ticket is a question waiting on you', () => {
  // `publishView` is what the monitor draws as "N waiting", which is a claim about work
  // asking you something. A ticket nobody has decided about yet is not one.
  assert.match(APP, /publishView\(visible\.filter\(\(q\) => !q\.pr && !q\.session && !q\.jira\)\)/);
});

await check('and it is not sorted among the beads either', () => {
  assert.match(APP, /const beads = visible\.filter\(\(q\) => !q\.pr && !q\.session && !q\.jira\)/);
  assert.match(APP, /const tickets = visible\s*\n?\s*\.filter\(\(q\) => q\.jira\)/, 'no section of its own');
});

console.log('\nwhat the row draws');

const html = renderRow({ jira: TICKET, key: 'jira:athena/TECH-1204', workspace: 'athena', space: 'Work' });

await check('the key, the summary and the status — the three you read without opening it', () => {
  assert.match(html, /TECH-1204/, 'the ticket key');
  assert.match(html, /The meter reads zero after a reconnect/, 'the summary');
  assert.match(html, /In Progress/, 'the status');
  assert.match(html, /3h ago/, 'when it last moved');
});

await check('it is a card in the stack, keyed like one, and links out to the ticket', () => {
  assert.match(html, /class="card jira-card"/, 'not a card in the list');
  assert.match(html, /data-key="jira:athena\/TECH-1204"/, 'no key — the scroll anchor has a hole in it');
  // Until bc-0i27.6 puts the ticket view over the tab, the row has to go somewhere: a
  // row you cannot act on at all is only a notification.
  assert.match(html, /href="https:\/\/example\.atlassian\.net\/browse\/TECH-1204"/);
  assert.match(html, /rel="noopener noreferrer"/, 'a target=_blank without this is a tabnabbing hole');
});

await check('and which workspace it came off, because a key alone does not say', () => {
  assert.match(html, /athena/, 'the workspace is not on the row');
});

await check('a summary out of JIRA cannot write markup into the list', () => {
  const nasty = renderRow({
    jira: { ...TICKET, summary: '<img src=x onerror=alert(1)>', key: 'TECH-9<9' },
    key: 'jira:w/TECH-9',
    workspace: 'w',
  });
  assert.doesNotMatch(nasty, /<img/, 'the summary reached the DOM as markup');
  assert.match(nasty, /&lt;img/, 'not escaped at all');
  assert.match(nasty, /TECH-9&lt;9/, 'the key is not escaped either');
});

await check('a ticket with nothing but a key still draws a row rather than throwing', () => {
  // The poller holds what JIRA answered, and JIRA is entitled to answer with a ticket
  // that has no status yet. A row that throws takes the whole render with it.
  const bare = renderRow({ jira: { key: 'TECH-1' }, key: 'jira:w/TECH-1', workspace: 'w' });
  assert.match(bare, /TECH-1/);
  assert.doesNotMatch(bare, /undefined/, 'a missing field was drawn as the word');
});

console.log('\nand it has a rule');

await check('the row is styled, or it lays out as a block of undivided text', () => {
  assert.match(CSS, /\.jira-card \{/, 'no rule for the card');
  assert.match(CSS, /\.jira-card \.work-row \{/, 'the row inside it carries the layout');
});

console.log(
  failures ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m` : `\n\x1b[32mall ${ran} checks passed\x1b[0m`
);
process.exit(failures ? 1 : 0);
