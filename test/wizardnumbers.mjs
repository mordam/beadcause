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
// grepping-this-repos-own-source-must-blank-comments); `blankJs` in test/helpers/blank.mjs
// is the scanner, copied from public/editmode.js because it lives inside an IIFE there and
// so cannot be imported. It was a private function here until bc-ygwa wanted it too. The header
// you are reading is itself the hazard: it writes `bold('7. Push notifications')` in
// prose, and were this file ever scanned by its own rule, an unblanked read would count it.
// Measured while writing this, by pasting two such comments into configure.js: the blanked
// scan stayed green and an unblanked one read `1..12, 12, 13, 14, 99` — a duplicate and a
// phantom, both invented entirely out of prose. So the blanking is load-bearing rather than
// tidiness, and a future edit that drops it will fail this file on comments alone.
//
// WHAT THIS DOES NOT CLAIM. It says nothing about whether a question is numbered *at all* —
// `bold(...)` also draws things that are not headings ("Saved"), so a heading added with no
// number leaves 1..N intact and passes here.
//
// bc-fq5a.1: IT NOW ALSO CATCHES THE PROSE, mechanically. Five comments inside configure.js
// name a question by number ("already handled in question 3"), so does the doc comment on
// candidateRoot in lib/reposcan.js, and so does a sentence in README.md — and none of that was
// gated before this bead: a renumber silently redirects every one of them, and a comment naming
// the wrong question is worse than no comment. The check below reads every `question N` in
// scripts/, lib/ and README.md — the OPPOSITE of the blanking above for the code: these
// references live *inside* comments, so extractComments (helpers/blank.mjs) keeps only the
// comments and blanks the code around them, rather than the other way round — and asserts
// N is a question the wizard actually has. That is the mechanical half only — it proves the
// number still exists, not that the prose still describes the right question, which is what the
// memory note adding-a-question-to-the-configure-wizard is for and still needs a human for. The
// ordinal phrasing ("the last question of the wizard") is not checked by number — there is no
// number to check — but it is protected already: if sign-in stopped being the last question, the
// "sign-in is the last question" check above already goes red.
//
// ONE SECTION OF README.md IS DELIBERATELY OUT OF SCAN: "Two branches that renumber the wizard
// merge clean", which documents the incident this whole file exists for. It quotes a "phantom
// question 99" that an unblanked scan once invented, as an illustration — not a live claim — and
// scanning that quote as if it named a real question is exactly the failure this file exists to
// avoid one level up: prose that quotes a number for illustration is not a reference to check,
// same family as grepping-this-repos-own-source-must-blank-comments. It is excluded by heading,
// not by line number, so it survives the README growing around it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankJs, extractComments } from './helpers/blank.mjs';

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

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

console.log('configure wizard question numbers\n');

const CONFIGURE = path.join(ROOT, 'scripts', 'configure.js');
const raw = fs.readFileSync(CONFIGURE, 'utf8');
const src = blankJs(raw);
const README = path.join(ROOT, 'README.md');

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

function walkFiles(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const QUESTION_REF = /\bquestion\s+(\d+)\b/gi;

check('every "question N" reference in scripts/, lib/ and README.md names a question the wizard has', () => {
  const validNums = new Set(questions.map((q) => q.num));
  const refs = [];

  // Code first — and the OPPOSITE of blankJs's usual treatment: every reference this check
  // looks for lives inside a comment ("// already handled in question 3"), so blanking
  // comments the way every other static read in this file does would erase the very thing
  // being searched for. extractComments keeps only the comments and blanks the code, strings
  // and template literals around them instead — see its doc comment in helpers/blank.mjs.
  for (const dir of ['scripts', 'lib']) {
    for (const file of walkFiles(path.join(ROOT, dir), ['.js', '.mjs'])) {
      const rel = path.relative(ROOT, file);
      const text = extractComments(fs.readFileSync(file, 'utf8'));
      for (const m of text.matchAll(QUESTION_REF)) {
        refs.push({ where: `${rel}:${lineOf(text, m.index)}`, num: Number(m[1]) });
      }
    }
  }

  // README.md is prose, not code — its comments (there are none, in the JS sense) need no
  // blanking — but one section is excluded by heading: it documents the incident this file
  // exists for and quotes a "phantom question 99" as an illustration of what an unblanked scan
  // once invented. Scanning that quote as a live claim would be the same mistake one level up.
  const readmeRaw = fs.readFileSync(README, 'utf8');
  const HISTORY_HEADING = '### Two branches that renumber the wizard merge clean';
  const historyAt = readmeRaw.indexOf(HISTORY_HEADING);
  assert.ok(
    historyAt >= 0,
    'README.md no longer has the "Two branches that renumber the wizard merge clean" section — ' +
      'this exclusion needs rewriting with it, or removing if the section is genuinely gone.'
  );
  const nextHeadingAt = readmeRaw.indexOf('\n### ', historyAt + HISTORY_HEADING.length);
  const historyEnd = nextHeadingAt >= 0 ? nextHeadingAt : readmeRaw.length;
  const readmeScanned =
    readmeRaw.slice(0, historyAt) +
    readmeRaw.slice(historyAt, historyEnd).replace(/[^\n]/g, ' ') +
    readmeRaw.slice(historyEnd);
  for (const m of readmeScanned.matchAll(QUESTION_REF)) {
    refs.push({ where: `README.md:${lineOf(readmeScanned, m.index)}`, num: Number(m[1]) });
  }

  // The parse, first — vacuously true over an empty list, same reason as the check above.
  assert.ok(
    refs.length >= 5,
    `only ${refs.length} "question N" reference(s) found across scripts/, lib/ and README.md — the ` +
      'scan is wrong, not the file: scripts/configure.js alone has had at least five since 2026-08-17.'
  );

  const bad = refs.filter((r) => !validNums.has(r.num));
  assert.deepEqual(
    bad.map(
      (r) =>
        `${r.where}  names question ${r.num}, which the wizard does not have ` +
        `(it has ${questions.length}: 1..${questions.length})`
    ),
    [],
    'a prose reference names a question number the wizard does not have — the shape a renumber-down\n' +
      'produces ("question 15 of 14"). This is the mechanical half only: it proves the number still\n' +
      'exists, not that the prose still describes the right question — a renumber that leaves the\n' +
      'number in range but moves what it means still needs a human to check it:\n' +
      bad.map((r) => r.where).join('\n')
  );
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
