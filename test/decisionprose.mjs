#!/usr/bin/env node
/**
 * An English sentence does not cost the whole decision block.
 *
 *     npm test
 *     node test/decisionprose.mjs
 *
 * dv-k4n.13 is a P2 question with three options and a recommendation, and for a day it
 * reached the phone as `⚠ notes: decision block is not valid YAML: Nested mappings are
 * not allowed in compact mappings at line 6, column 15` and nothing to tap. The block was
 * fine. One sentence in it said
 *
 *     response: … Render fetches the eight atlas assets from gdrive4t: at build …
 *
 * and `gdrive4t: ` is a colon-space in an unquoted plain scalar, which YAML reads as a
 * nested mapping inside a compact one. The parser is right and the outcome is absurd: a
 * decision Adam had to make was un-makeable because an agent wrote English.
 *
 * It had happened before — bc-xl7n.101's first draft lost its block to a
 * `superseded-by:` inside a `hint:` — and the answer that time was `annotateYamlError`
 * in `bin/b7e-card`, which makes the failure *legible*. Legible is not the same as
 * survived. `forgiveMarkdownLinks` had already settled the precedent for the other
 * obvious-and-invalid spelling (`- [Docs](https://x)`), so this is that door opened one
 * notch wider — and wider again the same afternoon, when dv-5i2.111 turned out to have
 * lost its four options to a different sentence, `question: 'Trinan' names both an
 * Askra population and an Oobin population…`: a quoted first word, parsed as the whole
 * value, with the rest of the question left over. Same failure, same cost, and the same
 * cause — an agent writing prose into a format that reads punctuation.
 *
 * What this file locks:
 *
 *   1. **The colon is forgiven on the prose keys**, in the real shape it arrived in —
 *      inside an option's `response`, with the rest of the block intact around it. And
 *      so is the quoted first word, in the shape dv-5i2.111 arrived in.
 *   2. **The forgiveness is a retry, never a first pass.** Every block that parses today
 *      has to parse to the same object tomorrow; a rewrite that fires unconditionally
 *      would start quoting values in documents that were never broken. The canary is a
 *      `hint` whose value is an ordinary word — untouched, because the retry never runs.
 *   3. **It does not eat the deliberate spellings**: an already-quoted value, a block
 *      scalar, a flow collection. Those are authors saying what they mean.
 *   4. **A genuinely broken block is still refused, with the original error.** The retry
 *      quoted lines nobody wrote, so its `at line N, column M` points into a document
 *      that does not exist — and `b7e-card` prints that line number back at the person
 *      who has to fix it.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let ran = 0;
const check = (fn, name) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message}`);
  }
};

const { parseDecision } = await import(path.join(ROOT, 'lib', 'decision.js'));

const block = (body) => ['Some context above the ask.', '', '```decision', body, '```', ''].join('\n');

/* ------------------------------------------------ the sentence that cost dv-k4n.13 */

const REAL = block(
  [
    'question: What does "my 4TB gdrive" mean for the atlas\'s 86 MB — which of these should get built?',
    'options:',
    '  - id: gdrive-serverside',
    '    label: Yes — Render pulls from gdrive4t at deploy time',
    '    hint: honors the gdrive answer; new infra — a headless rclone credential on Render',
    '    response: Build the server-side path — Render fetches the eight atlas assets from gdrive4t: at build or container start using a new non-interactive credential.',
    '  - id: lfs-pack',
    '    label: No — just buy the $5/mo GitHub LFS data pack instead',
    '    response: Buy the GitHub LFS data pack instead of using gdrive for this.',
    '    recommended: true',
  ].join('\n'),
);

check(() => {
  const r = parseDecision(REAL);
  assert.equal(r.error, undefined, `should have parsed — ${r.error}`);
  assert.equal(r.decision.options.length, 2);
  assert.deepEqual(
    r.decision.options.map((o) => o.id),
    ['gdrive-serverside', 'lfs-pack'],
  );
}, 'the block dv-k4n.13 actually carried parses, options and all');

check(() => {
  const r = parseDecision(REAL);
  assert.match(r.decision.options[0].response, /from gdrive4t: at build or container start/);
}, 'and the sentence survives with its colon — the value is quoted, not repaired');

check(() => {
  const r = parseDecision(REAL);
  assert.deepEqual(
    r.decision.options.map((o) => o.recommended),
    [false, true],
  );
  assert.match(r.decision.question, /which of these should get built/);
}, 'the recommendation and the question come through with it');

check(() => {
  const r = parseDecision(REAL);
  assert.match(r.body, /^Some context above the ask\.$/);
}, 'the prose around the block is still split off exactly as before');

/* ------------------------------------------ every key that carries a sentence */

for (const key of ['question', 'context']) {
  check(() => {
    const r = parseDecision(block([`${key}: Pick one — the real question is: which store?`, 'options:', '  - Yes', '  - No'].join('\n')));
    assert.equal(r.error, undefined, `${key} — ${r.error}`);
    assert.match(r.decision[key], /the real question is: which store\?/);
  }, `a colon in \`${key}\` is forgiven`);
}

for (const [key, read] of [
  ['label', (o) => o.label],
  ['hint', (o) => o.hint],
  ['response', (o) => o.response],
]) {
  check(() => {
    const lines = ['question: Which?', 'options:', '  - id: one'];
    if (key !== 'label') lines.push('    label: One');
    lines.push(`    ${key}: note: this one has a colon`);
    const r = parseDecision(block(lines.join('\n')));
    assert.equal(r.error, undefined, `${key} — ${r.error}`);
    assert.match(read(r.decision.options[0]), /note: this one has a colon/);
  }, `a colon in an option's \`${key}\` is forgiven`);
}

check(() => {
  const r = parseDecision(block(['question: Which?', 'options:', '  - id: one', '    label: Ship it', '    hint: ask the runbook, section 9:'].join('\n')));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.decision.options[0].hint, 'ask the runbook, section 9:');
}, 'a value that merely *ends* in a colon is forgiven too');

/* --------------------------------- the other spelling: a quoted first word */

check(() => {
  const r = parseDecision(
    block(["question: 'Trinan' names an Askra population and an Oobin population. Which one gets renamed?", 'options:', '  - Yes', '  - No'].join('\n')),
  );
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.decision.question, "'Trinan' names an Askra population and an Oobin population. Which one gets renamed?");
}, "a sentence opening with a quoted word — dv-5i2.111's whole block — is forgiven");

check(() => {
  const r = parseDecision(
    block(['question: Which?', 'options:', '  - id: one', '    label: One', '    hint: "double quoted" and then more sentence'].join('\n')),
  );
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.decision.options[0].hint, '"double quoted" and then more sentence');
}, 'and the double-quoted spelling of the same mistake, with the inner quotes kept');

/* ------------------------------------- what the retry must not touch */

check(() => {
  const r = parseDecision(
    block([
      'question: Which?',
      'options:',
      '  - id: one',
      '    label: One',
      '    response: "a multi-line quoted scalar',
      '      that closes on the next line"',
      '    hint: broken: elsewhere in the block',
    ].join('\n')),
  );
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.decision.options[0].response, 'a multi-line quoted scalar that closes on the next line');
  assert.equal(r.decision.options[0].hint, 'broken: elsewhere in the block');
}, 'an opening quote with no partner on its line is the start of a multi-line scalar, not a mistake to wrap');

check(() => {
  const r = parseDecision(
    block(['question: Which?', 'options:', '  - id: one', '    label: One', '    hint: "quoted" # with a trailing comment', '    response: colons: here'].join('\n')),
  );
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.decision.options[0].hint, 'quoted');
}, 'a quoted value followed only by a comment is complete — the comment is not trailing prose');


check(() => {
  const r = parseDecision(
    block(['question: Which?', 'options:', '  - id: one', '    label: One', '    hint: plain', '    closes: false'].join('\n')),
  );
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.decision.options[0].hint, 'plain');
  assert.equal(r.decision.options[0].closes, false);
}, 'a block that parses on the first pass is untouched — the retry never runs');

check(() => {
  const r = parseDecision(block(['question: Which?', 'options:', '  - id: one', '    label: One', '    response: "already: quoted"'].join('\n')));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.decision.options[0].response, 'already: quoted');
}, 'a value the author quoted themselves is left alone');

check(() => {
  const r = parseDecision(
    block(['question: Which?', 'options:', '  - id: one', '    label: One', '    response: |-', '      line one: with a colon', '      line two'].join('\n')),
  );
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.decision.options[0].response, 'line one: with a colon\nline two');
}, 'a block scalar keeps its newlines and its colons');

check(() => {
  const r = parseDecision(block(['question: Which?', 'links:', '  - [Docs](https://example.com/a:b)', 'options:', '  - Yes'].join('\n')));
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.decision.links[0], { label: 'Docs', url: 'https://example.com/a:b' });
}, 'a URL keeps its colon — and the markdown-link forgiveness still runs first');

/* ------------------------------------------------ still broken is still refused */

check(() => {
  const r = parseDecision(block(['question: Which?', 'options:', '  - id: one', '   label: One', '     hint: ragged'].join('\n')));
  assert.equal(r.decision, null);
  assert.match(r.error, /decision block is not valid YAML/);
}, 'a block broken some other way is still refused, not silently emptied');

check(() => {
  const broken = block(['question: Which?', 'options:', '  - id: one', '    label: One: two', '   hint: ragged indent below'].join('\n'));
  const r = parseDecision(broken);
  assert.equal(r.decision, null);
  const line = /at line (\d+)/.exec(r.error);
  assert.ok(line, `the error should still name a line — ${r.error}`);
  assert.ok(
    Number(line[1]) <= r.raw.split('\n').length,
    `line ${line[1]} must exist in the ${r.raw.split('\n').length}-line block the author wrote`,
  );
}, 'when the retry also fails, the reported error is the first one — the line numbers name the real source');

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
