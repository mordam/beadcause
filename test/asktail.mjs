#!/usr/bin/env node
/**
 * A question ends with its options, and one of them is recommended.
 *
 *     npm test
 *     node test/asktail.mjs
 *
 * The `decision` block has been in lib/decision.js since the beginning and **no brief
 * ever mentioned it**. What the worker brief actually said was "if there are only a few
 * possible answers, list them", which asks for prose — and prose is what lib/suggest.js
 * exists to salvage, by guessing options out of sentences nobody wrote to be parsed. A
 * guessed option is not a weaker written one, it is a different thing: the card fills the
 * answer box with it instead of sending it, precisely because nobody stands behind it. So
 * the ordinary question reaching Adam's phone was the salvaged version of a question that
 * was never written as one, with no options he could tap and nothing saying which way the
 * agent that had just spent an hour in the files would go.
 *
 * This file locks the four claims that fix costs nothing if they hold and everything if
 * any one of them quietly stops:
 *
 *   1. **`decisionTail` knows the three ways a body is not a question yet** — no block,
 *      a block that is not last, and options nobody recommended. The middle one is the
 *      easiest to lose: "has a block" is a one-line check and "ends with one" is not, and
 *      the difference is whether context arrives before the ask or after it.
 *   2. **The template we hand agents actually parses**, and demonstrates the
 *      recommendation rather than describing it. A template that parsed to nothing would
 *      teach every session to write something the phone renders as free text, and the
 *      only symptom would be a card with no buttons — indistinguishable from an agent
 *      that never bothered.
 *   3. **Both briefs carry it.** The worker's ask and the epic planner's ask are separate
 *      strings, and the planner's is the one that gets forgotten, because an epic that
 *      cannot be planned is rarer than a bead that cannot be finished.
 *   4. **`bin/ask.js` refuses a body without it, before the create.** The rule stated in a
 *      prompt is a rule some fraction of sessions read past; the refusal is what makes
 *      "always" true. It has to be *before* the create, or the refusal costs a bead on
 *      somebody's phone rather than one retry — and it has to name the fix, or a session
 *      told only "rejected" drops the question, which is the outcome the brief spends a
 *      paragraph arguing against.
 *
 * And the fifth, which is the one an over-eager gate would break: **a question that is a
 * fact rather than a choice still gets asked.** "What is the staging password" has no
 * options, and a block invented to satisfy a check would offer two made-up answers to a
 * question with one real one. `--no-options` is that door, and it staying open is as much
 * of the feature as the refusal is.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-asktail-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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

const { askTemplate, decisionTail, parseDecision } = await import(path.join(ROOT, 'lib', 'decision.js'));

/* --------------------------------------------------- the check, on its own */

const GOOD = ['Some context about why this is hard.', '', askTemplate(), ''].join('\n');

check(() => assert.equal(decisionTail(GOOD).ok, true), 'prose, then the block, then nothing — that is a question');

check(() => {
  const t = decisionTail('Which of these two did you mean?\n');
  assert.equal(t.ok, false);
  assert.match(t.reason, /no `decision` block/);
}, 'prose alone is refused, and the reason says the phone gets no options');

check(() => {
  const t = decisionTail(`${GOOD}\nOne more thing I forgot to mention.\n`);
  assert.equal(t.ok, false);
  assert.match(t.reason, /not the last thing/);
}, 'a block with prose after it is refused — context after the ask is context read too late');

check(() => {
  const noStar = GOOD.replace('    recommended: true\n', '');
  assert.equal(decisionTail(noStar).ok, false);
  assert.match(decisionTail(noStar).reason, /recommended/);
}, 'options with nothing recommended are refused — the comparison is the agent’s to do');

check(() => {
  const t = decisionTail('```decision\nquestion: What is the staging password?\n```\n');
  assert.equal(t.ok, true);
}, 'a block with no options at all passes — free-text questions are real questions');

check(() => {
  const t = decisionTail('```decision\nquestion: [unclosed\n```\n');
  assert.equal(t.ok, false);
  assert.match(t.reason, /YAML/);
}, 'and a block that does not parse is refused as itself, not as a missing block');

/* ------------------------------------------- the template we hand agents */

check(() => {
  const { decision } = parseDecision(askTemplate());
  assert.ok(decision, 'the template parsed to a decision');
  assert.equal(decision.options.length, 2);
  assert.equal(decision.options.filter((o) => o.recommended).length, 1);
}, 'the template parses, and it demonstrates the recommendation rather than describing it');

check(() => {
  assert.equal(decisionTail(askTemplate()).ok, true);
  assert.match(askTemplate('    '), /^ {4}```decision/);
}, 'it passes its own check, and it indents to sit inside a heredoc');

/* ------------------------------------------------------------ the briefs */

const { workPromptFor, planPromptFor } = await import(path.join(ROOT, 'lib', 'session.js'));
const worker = workPromptFor('demo', { id: 'zz-1', title: 'A bead a session cannot finish' }, 1, null, 'Adam');
const planner = planPromptFor('demo', { id: 'zz-e', title: 'An epic nobody can plan yet' }, [], 'Adam');

check(() => {
  assert.match(worker, /```decision/);
  assert.match(worker, /recommended: true/);
}, 'the worker brief hands the block over rather than describing options in prose');

check(
  () => assert.match(worker, /One question per bead/),
  'and it says one question per bead — one answer box cannot answer two asks'
);

check(() => {
  assert.match(planner, /```decision/);
  assert.match(planner, /recommended: true/);
}, 'the epic planner’s ask carries it too — the brief that is easiest to forget');

check(() => {
  assert.match(worker, /--no-options/);
  assert.match(planner, /--no-options/);
}, 'and both name the way out for a question that is a fact rather than a choice');

/* -------------------------------------------------- bin/ask.js, end to end */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(WORLD, JSON.stringify({ issues: {} }, null, 2));
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const one = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
if (args[0] === 'create') {
  const id = 'zz-n' + (Object.keys(w.issues).length + 1);
  w.issues[id] = { id, title: one('--title', ''), description: one('--description', '') };
  fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }] }, null, 2)
);

/** `bin/ask.js`, run the way the brief tells a worker to run it: body on stdin. */
const ask = (args, input) => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ask.js'), '-w', 'demo', '-t', 'Gross or net?', ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, stderr: res.stderr || '', stdout: (res.stdout || '').trim() };
};
const beads = () => Object.keys(JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues);

check(() => {
  const res = ask([], 'Which of these two did you mean?\n');
  assert.equal(res.status, 1);
  assert.deepEqual(beads(), [], 'nothing was filed');
}, 'a prose-only body is refused, and no bead exists afterwards — the refusal is before the create');

check(() => {
  const res = ask([], 'Which of these two did you mean?\n');
  assert.match(res.stderr, /```decision/);
  assert.match(res.stderr, /--no-options/);
}, 'and the refusal prints the block to paste and the one legitimate way past it');

check(() => {
  const res = ask([], GOOD);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(beads().length, 1);
}, 'a body written the way the brief says files exactly as it always did');

check(() => {
  const res = ask(['--no-options'], 'What is the staging database password?\n');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(beads().length, 2);
}, 'and a fact rather than a choice still gets asked — the door the gate must not close');

await cleanupTmp(tmp);

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
