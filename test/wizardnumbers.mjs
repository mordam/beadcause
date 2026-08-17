#!/usr/bin/env node
//
// The `npm run configure` wizard numbers its questions 1..N — once each, in order.
//
//   npm test
//   node test/wizardnumbers.mjs
//
// bc-q6p4: scripts/configure.js writes those numbers as literal prose inside each
// heading — `bold('7. Push notifications')` — rather than deriving them from position.
// Scattered literals in a 766-line file are a *silent merge hazard*, and that is the
// specific thing this catches. Two branches that each insert a question in a different
// region of the file do not touch the same lines, so git merges them clean and produces
// a wizard that asks two questions with the same number.
//
// Not hypothetical. Resolving #264 on 2026-08-14: bc-x9u5 inserted a new question 1 and
// shifted every later number by one; bc-ynzs (#269) inserted Confluence before sign-in.
// Both merged without a conflict and the result printed two "12." and no "14.". The
// whole suite was 212/213 green over it, because nothing asserted the headings at all —
// test/team.mjs only reads question 3's default, and test/confluencesetup.mjs and
// test/signinsetup.mjs each pass a heading of their own in, so neither ever sees what
// configure.js actually hands those modules. It was caught by a human reading the merge,
// which is not a mechanism. This file is the mechanism.
//
// The same defect had already survived a whole worker session and its review before that
// merge, incidentally: bc-x9u5 shifted 11 to 12 and left sign-in on 12 as well. So the
// bar this has to clear is low and the thing it replaces is a grep somebody has to
// remember to run.
//
// BOTH SHAPES OR IT MISSES THE CASE THAT BIT. Eleven of the numbers are inline
// `bold('N. …')` calls; the last two are `heading: 'N. …'` strings passed *into*
// lib/confluencesetup.js and lib/signinsetup.js. Those two modules take the number from
// the caller deliberately — the comment at lib/signinsetup.js:77 says why: a question in
// another file that counts itself is a duplicate "N." the first time somebody inserts one
// back in configure.js. So the numbering has exactly one source, and a check that reads
// only the inline calls would have been green over the merge that started this.
//
// A TEXT ASSERTION RATHER THAN A DRIVEN WIZARD, deliberately. The numbering is a property
// of the file, and driving configure.js needs a real pty and one `expect` block per
// question (see the memory note configure-js-ask-and-how-to-drive-it) — far too expensive
// to run unconditionally, for an answer no better than this one. Reading the file costs
// milliseconds, so it is unconditional, which is the whole point: the failure mode here is
// nobody remembering to look.
//
// COMMENTS ARE BLANKED BEFORE THE SCAN. Every file in this repo argues in prose that
// quotes the code around it, so a static read that does not blank comments finds its own
// documentation and reports it as a site. It has bitten three times (see the memory note
// grepping-this-repos-own-source-must-blank-comments); `blankJs` below is the scanner from
// public/editmode.js, which is inside an IIFE there and so cannot be imported. The header
// you are reading is itself the hazard: it writes `bold('7. Push notifications')` in
// prose, and were this file ever scanned by its own rule, an unblanked read would count it.
// Measured while writing this, by pasting two such comments into configure.js: the blanked
// scan stayed green and an unblanked one read `1..12, 12, 13, 14, 99` — a duplicate and a
// phantom, both invented entirely out of prose. So the blanking is load-bearing rather than
// tidiness, and a future edit that drops it will fail this file on comments alone.
//
// WHAT THIS DOES NOT CLAIM. It says nothing about whether a question is numbered *at all* —
// `bold(...)` also draws things that are not headings ("Saved"), so a heading added with no
// number leaves 1..N intact and passes here. It says nothing about the comments inside
// configure.js that name a question by number, lib/reposcan.js's doc comment that names one, or
// the sentences in README.md that do; those are prose, and a renumber still owes them a
// `grep -rn 'question [0-9]'` and a look for the ordinals ("the last question of the wizard"),
// which is what the memory note adding-a-question-to-the-configure-wizard is for. What this
// does claim is the one thing a clean merge can break without anyone seeing it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/**
 * Blank every comment, preserving length so offsets still land where they came from.
 *
 * A character scanner, because a regex cannot tell a comment from a comment's spelling:
 * `//` inside a string is not a comment and `'` inside a comment does not open one, so
 * the two have to be tracked together. Template literals carry a stack because this repo
 * nests them. Regular expressions are the one construct it guesses at — `/` is division
 * or the start of a literal depending on what came before, which is not decidable without
 * parsing — and the cost of guessing wrong is a blanked tail of one line, which loses a
 * heading rather than inventing one. Lifted from `blankJs` in public/editmode.js, which
 * lives inside an IIFE and exports nothing.
 */
function blankJs(src) {
  const out = src.split('');
  const stack = [];
  let mode = 'code';
  let prev = '';
  let i = 0;
  const wipe = (n) => {
    for (let k = 0; k < n; k++) if (out[i + k] !== '\n') out[i + k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        mode = 'line';
        continue;
      }
      if (c === '/' && d === '*') {
        mode = 'block';
        continue;
      }
      if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]/.test(prev)) {
        mode = 'regex';
        i += 1;
        continue;
      }
      if (c === "'" || c === '"') {
        mode = c;
        i += 1;
        continue;
      }
      if (c === '`') {
        stack.push('tpl');
        mode = 'tpl';
        i += 1;
        continue;
      }
      // A `}` that closes a `${…}` hands the scanner back to the template around it.
      if (c === '}' && stack[stack.length - 1] === 'sub') {
        stack.pop();
        mode = 'tpl';
        i += 1;
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        prev = '';
        i += 1;
        continue;
      }
      wipe(1);
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') {
        wipe(2);
        mode = 'code';
        i += 2;
        continue;
      }
      wipe(1);
      i += 1;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (mode === 'tpl') {
      if (c === '`') {
        stack.pop();
        mode = 'code';
        i += 1;
        continue;
      }
      if (c === '$' && d === '{') {
        stack.push('sub');
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'regex') {
      if (c === '/' || c === '\n') mode = 'code';
      i += 1;
      continue;
    }
    // A single- or double-quoted string, named by the quote that opened it.
    if (c === mode) {
      mode = 'code';
      prev = c;
    }
    i += 1;
  }
  return out.join('');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

console.log('configure wizard question numbers\n');

const CONFIGURE = path.join(ROOT, 'scripts', 'configure.js');
const raw = fs.readFileSync(CONFIGURE, 'utf8');
const src = blankJs(raw);

// Both shapes, collected in document order — which is the order the wizard asks them in,
// since configure.js is a top-to-bottom script with no branching around a question.
//   inline:  console.log(bold('7. Push notifications'))
//   passed:  heading: '13. Publish and read Confluence pages?'
const questions = [];
const collect = (re, shape) => {
  for (const m of src.matchAll(re)) {
    const num = Number(m[2]);
    questions.push({ num, text: m[3].trim(), shape, at: m.index, line: lineOf(src, m.index) });
  }
};
// `(?:\\.|(?!\1)[^\\])*` rather than a fixed `[^'"`]*`: the heading is closed by *its own*
// quote, and a question whose text holds an apostrophe ("8. What's yours?") is a perfectly
// legal edit that a fixed class would fail to match. The cost of that would be an invisible
// question and a gap check reddening at something nobody broke — which is how a static read
// earns a reputation for crying wolf and stops being trusted.
const HEADING = String.raw`(['"\`])(\d+)\.\s*((?:\\.|(?!\1)[^\\])*)\1`;
collect(new RegExp(String.raw`\bbold\(\s*${HEADING}`, 'g'), 'inline');
collect(new RegExp(String.raw`\bheading:\s*${HEADING}`, 'g'), 'passed');
questions.sort((a, b) => a.at - b.at);

const where = (q) => `scripts/configure.js:${q.line}  ${q.num}. ${q.text}`;

// The parse itself, first. Every check below is vacuously true over an empty list, so a
// regex that quietly stops matching would turn this whole file green rather than red —
// which is the failure mode a static read has and a driven test does not.
check('the numbered headings are found at all, in both shapes', () => {
  assert.ok(
    questions.length >= 10,
    `only ${questions.length} numbered heading(s) found in scripts/configure.js — the parse is ` +
      'wrong, not the file. The wizard has had at least ten questions since 2026-08-14.'
  );
  for (const shape of ['inline', 'passed']) {
    assert.ok(
      questions.some((q) => q.shape === shape),
      `no ${shape} headings found. Both shapes exist by design — the inline bold('N. …') calls and ` +
        "the heading: 'N. …' strings handed to lib/confluencesetup.js and lib/signinsetup.js — and a " +
        'scan that sees only one of them is green over exactly the merge this file exists for.'
    );
  }
});

check('no question number is used twice', () => {
  const byNum = new Map();
  for (const q of questions) {
    if (!byNum.has(q.num)) byNum.set(q.num, []);
    byNum.get(q.num).push(q);
  }
  const dupes = [...byNum.values()].filter((qs) => qs.length > 1);
  assert.deepEqual(
    dupes.map((qs) => qs.map(where).join('\n           ')),
    [],
    `${dupes.length} number(s) used more than once. This is what a clean merge of two branches that\n` +
      'each inserted a question looks like — neither touched the other\'s lines, so git had nothing\n' +
      'to conflict over. Renumber from the insertion point down:\n           ' +
      dupes.map((qs) => qs.map(where).join('\n           ')).join('\n           ')
  );
});

check('the numbers run 1..N with no gap', () => {
  const nums = questions.map((q) => q.num).sort((a, b) => a - b);
  const expected = questions.map((_, i) => i + 1);
  assert.deepEqual(
    nums,
    expected,
    `the wizard asks ${questions.length} questions but numbers them ${nums.join(', ')}. A gap is the\n` +
      'other half of a duplicate: the merge that produced two "12." also produced no "14.".\n' +
      questions.map(where).join('\n')
  );
});

check('the numbers ascend in the order the questions are asked', () => {
  const out = questions
    .map((q, i) => ({ q, i }))
    .filter(({ q, i }) => i > 0 && q.num <= questions[i - 1].num)
    .map(({ q, i }) => `${where(q)}   (after ${where(questions[i - 1])})`);
  assert.deepEqual(
    out,
    [],
    'a question is numbered below the one before it, so the reader is counted down to and then\n' +
      'back up — which means a question was moved without its number, or renumbered without being\n' +
      'moved. This can fire on its own, over a set that is a perfectly good 1..N:\n' +
      out.join('\n')
  );
});

check('sign-in is the last question and Confluence the one before it', () => {
  // Both placements are argued for in source comments (scripts/configure.js, above each
  // call): they are the two questions that take a credential, so the two prompts with the
  // echo turned off are the last thing setup does rather than one being buried mid-wizard.
  // The README leans on it too — it calls sign-in "the last question in that script".
  // Inserting a question after either one is therefore a decision, not a tidy-up.
  const last = questions[questions.length - 1];
  const secondLast = questions[questions.length - 2];
  assert.ok(last && secondLast, 'fewer than two questions found — see the parse check above');
  assert.match(
    last.text,
    /sign in/i,
    `the last question is "${last.text}" (${where(last)}), not sign-in. Sign-in is last on purpose; ` +
      'if that has genuinely changed, the comment above askSignin in scripts/configure.js and the ' +
      'README sentence calling it the last question both have to change with it.'
  );
  assert.match(
    secondLast.text,
    /confluence/i,
    `the second-to-last question is "${secondLast.text}" (${where(secondLast)}), not Confluence. ` +
      'Confluence sits beside sign-in rather than beside Slack so both credential prompts are ' +
      'adjacent — see the comment above askConfluence in scripts/configure.js.'
  );
});

check('the last two numbers are the ones handed to the setup modules', () => {
  // The seam this is really about: configure.js owns the number, the module owns the block.
  // A `heading:` that stopped reaching askConfluence/askSignin would leave the count in
  // this file intact while the wizard printed the modules' unnumbered defaults instead.
  for (const [fn, want] of [
    ['askConfluence', /confluence/i],
    ['askSignin', /sign in/i],
  ]) {
    const at = src.indexOf(`await ${fn}(`);
    assert.ok(at >= 0, `scripts/configure.js no longer calls ${fn} — this check needs rewriting with it`);
    // A generous window rather than the matching brace: finding that needs a parser, and the
    // only thing overrunning could reach is the *next* call's heading, which is further away
    // than this one and so never wins the first match.
    const call = src.slice(at, at + 800);
    const m = call.match(new RegExp(String.raw`heading:\s*${HEADING}`));
    assert.ok(
      m,
      `${fn} is called without a numbered heading: (scripts/configure.js:${lineOf(src, at)}). It takes ` +
        'the number from here on purpose — lib/signinsetup.js:77 says why — so a call without one ' +
        'prints that module\'s unnumbered default and the wizard silently loses a number.'
    );
    assert.match(m[3], want, `${fn} is passed the heading "${m[3]}", which is not the question it asks`);
  }
});

check('neither setup module numbers its own heading', () => {
  // The invariant that makes one source of truth possible: if lib/signinsetup.js ever wrote
  // its own "14.", configure.js's count and the module's would drift apart in silence, and
  // this file would be reading only half of what the wizard prints.
  for (const rel of ['lib/confluencesetup.js', 'lib/signinsetup.js']) {
    const text = blankJs(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const m = text.match(new RegExp(String.raw`heading\s*=\s*${HEADING}`));
    assert.ok(
      !m,
      `${rel} numbers its own heading default ("${m?.[2]}. ${m?.[3]}"). The number belongs to the caller — ` +
        'scripts/configure.js is the only file that can count the questions, and a module that ' +
        'counts itself is a duplicate the first time a question is inserted back in the wizard.'
    );
  }
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
