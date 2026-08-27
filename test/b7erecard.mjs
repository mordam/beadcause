#!/usr/bin/env node
//
// b7e-recard — retire the answered decision block and put the next question where the
// card will read it (bc-dgx7.27). The session audit found three sessions — bc-khoe.33,
// bc-xl7n.77.1, bc-1kwl.29 — each opening on a bead Adam had already answered and each
// building the same transaction from scratch: archive the spent block, write the next
// question, cut the stale one out of the other fields, then verify through toQuestion.
//
//   npm test
//   node test/b7erecard.mjs
//
// Driven as a real subprocess against a stub `bd` — the shape test/b7efield.mjs uses —
// but a *stateful* one: `update` and `comment` mutate the world on disk, so the command's
// own readback is a real readback and the assertions below are made against what a second
// `bd show` would return, not against what the command claimed it wrote.
//
// The two properties this suite exists to pin are the two the sessions it replaces got
// wrong by hand:
//
//   - **exactly one block, in the field toQuestion reads first.** A block appended to
//     `notes` behind a spent one in `design` renders nothing, silently — that is the
//     whole bug (see [[a-spent-decision-block-in-design-outranks-a-new-one-in-notes]]).
//   - **nothing else moves.** The prose of every field comes back byte for byte, and a
//     `<!-- beadcause:... -->` marker is never dropped, because dropping one permanently
//     prevents a sweep re-asking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';
import { toQuestion, stripDecisionBlocks } from '../lib/decision.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-recard');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7erecard-'));
process.on('exit', () => removeTreeSync(tmp));

/* ---------------------------------------------------------------------- the stub bd */

const FAKE_BD = path.join(tmp, 'bd');
const CALLS = path.join(tmp, 'calls.jsonl');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.BEADS_DIR;
const world = path.join(dir, 'world.json');
const raw = process.argv.slice(2);
// Every spawn goes through Bd.run, which appends --actor; strip it the way bd itself
// would so the argv below is the argv the command actually composed.
const args = [];
for (let i = 0; i < raw.length; i += 1) {
  if (raw[i] === '--actor') { i += 1; continue; }
  args.push(raw[i]);
}
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, dir }) + '\\n');
const read = () => JSON.parse(fs.readFileSync(world, 'utf8'));
const write = (w) => fs.writeFileSync(world, JSON.stringify(w, null, 2));
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const verb = args[0];
const rest = args.slice(1);

if (verb === 'show') {
  const w = read();
  const ids = rest.filter((a) => a !== '--json');
  const rows = [];
  for (const id of ids) {
    const issue = w.issues[id];
    if (!issue) die('Error fetching ' + id + ': no issue found matching "' + id + '"');
    rows.push({ ...issue });
  }
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}

if (verb === 'comment') {
  const w = read();
  const [id, text] = rest;
  if (!w.issues[id]) die('no issue found matching "' + id + '"');
  (w.comments[id] = w.comments[id] || []).push(text);
  write(w);
  process.exit(0);
}

if (verb === 'update') {
  const w = read();
  const id = rest[0];
  if (!w.issues[id]) die('no issue found matching "' + id + '"');
  const FIELD = { '--description': 'description', '--design': 'design', '--notes': 'notes' };
  for (let i = 1; i < rest.length; i += 1) {
    const f = FIELD[rest[i]];
    if (!f) die('stub bd: unexpected update flag "' + rest[i] + '"');
    // The sabotage switch: the write is accepted and reported successful, and nothing
    // changes. That is what a readback gate is for, and the only way to drive it.
    if (!w.refuseWrites) w.issues[id][f] = rest[i + 1];
    i += 1;
  }
  write(w);
  process.exit(0);
}

// Bd.comment's relateMentions hangs two dep reads and up to three dep writes off every
// comment, and swallows every failure of them. Answered as an empty graph so the log
// below stays legible; the command never asks for an edge itself.
if (verb === 'dep') { process.stdout.write('[]'); process.exit(0); }

die('stub bd: unexpected verb "' + verb + '"');
`,
  { mode: 0o755 }
);

/* ------------------------------------------------------------------------- the world */

const SPENT = ['```decision', 'question: Does bc-khoe come out in two?', 'options:', '  - id: split', '    label: Split it', '    response: "Split it in two."', '    recommended: true', '  - id: keep', '    label: Leave it', '    response: "Leave bc-khoe as one epic."', '```'].join('\n');

const SHADOWED = ['```decision', 'question: Has this branch already landed?', 'options:', '  - id: land', '    label: Land it', '    response: "Land it."', '    recommended: true', '```'].join('\n');

const NEXT = [
  'Both sub-epics are out and the children are re-parented. What is left is the epic itself.',
  '',
  '```decision',
  'question: Close bc-khoe now its children have moved?',
  'options:',
  '  - id: close',
  '    label: Close it',
  '    hint: Nothing else is coming from this epic',
  '    response: "Close bc-khoe — its children have all moved out."',
  '    recommended: true',
  '  - id: hold',
  '    label: Leave it open',
  '    hint: Keeps a home for anything else that turns up',
  '    response: "Leave bc-khoe open for now."',
  '  - id: later',
  '    label: Not yet — ask again when the two sub-epics close',
  '    hint: Sets the card aside until its gate clears',
  '    response: "Not yet — ask me again when both sub-epics have closed."',
  '    defers: true',
  '```',
].join('\n');

const MARKER = '<!-- beadcause:superseded -->';
const DESC_PROSE = 'What this bead is, as filed.\n\nA second paragraph nobody is asking about.';
const DESIGN_PROSE = 'Design notes above the block.';
const NOTES_PROSE = `${MARKER}\n\nA supersede sweep raised a card here on 2026-08-22.`;

const issue = (id, over = {}) => ({
  id,
  title: 'A bead with a spent question on it',
  description: DESC_PROSE,
  design: `${DESIGN_PROSE}\n\n${SPENT}`,
  notes: `${NOTES_PROSE}\n\n${SHADOWED}`,
  status: 'open',
  issue_type: 'task',
  priority: 1,
  assignee: '',
  owner: '',
  labels: ['human'],
  acceptance_criteria: '',
  parent: null,
  dependencies: [],
  ...over,
});

const WORLD = () => ({
  refuseWrites: false,
  comments: {},
  issues: {
    // The shape all three sessions hit: a spent block in `design`, a shadowed one in
    // `notes` behind it, and a description carrying nothing but prose.
    'rc-spent': issue('rc-spent'),
    // No block anywhere — an ordinary bead being asked its first question.
    'rc-blank': issue('rc-blank', { design: DESIGN_PROSE, notes: NOTES_PROSE }),
    // The block in `description`, which is where the notinmain sweep files one.
    'rc-desc': issue('rc-desc', {
      description: `${DESC_PROSE}\n\n${SPENT}`,
      design: DESIGN_PROSE,
      notes: NOTES_PROSE,
    }),
    // A sweep's own card, drawn rather than shadowed: the only block on the bead is in
    // `notes`, beside the marker that stops the sweep ever raising it again.
    'rc-sweep': issue('rc-sweep', {
      description: DESC_PROSE,
      design: DESIGN_PROSE,
      notes: `${NOTES_PROSE}\n\n${SHADOWED}`,
    }),
  },
});

let wsSeq = 0;
/** A workspace of its own per check, so one test's writes cannot be another's premise. */
function freshWs() {
  wsSeq += 1;
  const name = `recard-ws-${wsSeq}`;
  const dir = path.join(tmp, 'beads', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(WORLD(), null, 2));
  const configDir = path.join(tmp, 'config', name);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name, dir }] }, null, 2)
  );
  return { name, dir, configDir };
}

const worldOf = (ws) => JSON.parse(fs.readFileSync(path.join(ws.dir, 'world.json'), 'utf8'));

/* --------------------------------------------------------------------------- run */

const UNRELATED_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7erecard-elsewhere-'));

function run(ws, args, { stdin = NEXT } = {}) {
  const res = spawnSync(process.execPath, [BIN, '-w', ws.name, ...args], {
    encoding: 'utf8',
    cwd: UNRELATED_CWD,
    input: stdin,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: ws.configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** The same, with no workspace flag — for the argv refusals that must not reach a config. */
function runBare(args, { stdin = NEXT, configDir = null } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: UNRELATED_CWD,
    input: stdin,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir || path.join(tmp, 'config') },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const callCount = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const verbsCalled = () =>
  fs.existsSync(CALLS)
    ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args[0])
    : [];

/* ------------------------------------------------------------------------ harness */

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 12).join('\n       ')}`);
  }
};

console.log('\nb7e-recard\n');

/* ------------------------------------------------------------------- the cutter */

// `stripDecisionBlocks` is the one thing this command added to lib/decision.js, and its
// only consumer is here — so this is where it is pinned.

check('the cutter takes every block, not just the first, and keeps them verbatim', () => {
  const src = 'above\n\n```decision\nquestion: one\n```\n\nmiddle\n\n~~~decision\nquestion: two\n~~~\n\nbelow';
  const { body, blocks } = stripDecisionBlocks(src);
  assert.equal(blocks.length, 2, 'a shadowed second block must not survive the cut');
  assert.equal(blocks[0].text, '```decision\nquestion: one\n```');
  // The fence style is part of "verbatim": a copy rebuilt from parseDecision's `raw`
  // would come back with backticks whatever the author wrote.
  assert.equal(blocks[1].text, '~~~decision\nquestion: two\n~~~');
  assert.equal(body, 'above\n\nmiddle\n\nbelow', 'one blank line at each seam, and nothing else moved');
});

check('the cutter touches only the seam — blank runs elsewhere in the prose stay', () => {
  const src = 'one\n\n\n\ntwo\n\n```decision\nquestion: q\n```';
  assert.equal(stripDecisionBlocks(src).body, 'one\n\n\n\ntwo');
});

check('a body with no block comes back as itself, trimmed', () => {
  assert.deepEqual(stripDecisionBlocks('  just prose  ').blocks, []);
  assert.equal(stripDecisionBlocks('  just prose  ').body, 'just prose');
  assert.equal(stripDecisionBlocks('').body, '');
  assert.equal(stripDecisionBlocks(null).body, '');
});

check('a field that was nothing but a block comes back empty', () => {
  const { body, blocks } = stripDecisionBlocks('```decision\nquestion: q\n```');
  assert.equal(body, '');
  assert.equal(blocks.length, 1);
});

/* ------------------------------------------------------ refusals, before any spawn */

check('--help prints usage and exits 0, without ever calling bd', () => {
  const before = callCount();
  const { status, stdout } = runBare(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-recard/);
  assert.equal(callCount(), before, 'help must not spawn bd');
});

check('missing -w/-b is refused with exit 2 before any bd spawn', () => {
  const before = callCount();
  const { status, stderr } = runBare(['-b', 'rc-spent']);
  assert.equal(status, 2);
  assert.match(stderr, /-w\/--workspace and -b\/--bead are both required/);
  assert.equal(callCount(), before);
});

check('an unrecognised flag is refused, naming itself', () => {
  const { status, stderr } = runBare(['-w', 'x', '-b', 'y', '--clobber']);
  assert.equal(status, 2);
  assert.match(stderr, /unrecognised argument: --clobber/);
});

check('--field outside description|design|notes is refused', () => {
  const { status, stderr } = runBare(['-w', 'x', '-b', 'y', '--field', 'acceptance']);
  assert.equal(status, 2);
  assert.match(stderr, /--field must be one of description, design, notes/);
});

// The acceptance criterion in as many words: "a malformed new block writes nothing at
// all". Each of these is checked for a zero-spawn run, not merely a non-zero exit —
// "nothing at all" includes the read.
check('text with no decision block at all writes nothing and spawns nothing', () => {
  const ws = freshWs();
  const before = callCount();
  const { status, stderr } = run(ws, ['-b', 'rc-spent'], { stdin: 'just some prose about the bead' });
  assert.equal(status, 2);
  assert.match(stderr, /carries no `decision` block/);
  assert.equal(callCount(), before);
});

check('a block that is not the last thing in the body writes nothing', () => {
  const ws = freshWs();
  const before = callCount();
  const { status, stderr } = run(ws, ['-b', 'rc-spent'], { stdin: `${SPENT}\n\nand then some more prose` });
  assert.equal(status, 2);
  assert.match(stderr, /not the last thing in the body/);
  assert.equal(callCount(), before);
});

check('options with nothing recommended writes nothing', () => {
  const ws = freshWs();
  const before = callCount();
  const noStar = SPENT.replace('    recommended: true\n', '');
  const { status, stderr } = run(ws, ['-b', 'rc-spent'], { stdin: noStar });
  assert.equal(status, 2);
  assert.match(stderr, /recommended: true/);
  assert.equal(callCount(), before);
});

check('a block that is not valid YAML writes nothing', () => {
  const ws = freshWs();
  const before = callCount();
  const bad = '```decision\nquestion: one\n  hint: superseded-by: already keeps it out\n```';
  const { status, stderr } = run(ws, ['-b', 'rc-spent'], { stdin: bad });
  assert.equal(status, 2);
  assert.match(stderr, /not valid YAML/);
  assert.equal(callCount(), before);
});

// Two blocks in one hand-in is caught by the same rule as everything else after the ask:
// the second block is text below the first. Pinned here because the alternative reading —
// "it took the last one" — is the silent version of the very bug this command exists for.
check('two blocks in the incoming text is refused, as text after the ask', () => {
  const ws = freshWs();
  const before = callCount();
  const { status, stderr } = run(ws, ['-b', 'rc-spent'], { stdin: `${SPENT}\n\n${NEXT}` });
  assert.equal(status, 2);
  assert.match(stderr, /not the last thing in the body/);
  assert.equal(callCount(), before);
});

check('empty stdin is refused', () => {
  const ws = freshWs();
  const { status, stderr } = run(ws, ['-b', 'rc-spent'], { stdin: '   \n' });
  assert.equal(status, 2);
  assert.match(stderr, /empty/);
});

check('an unconfigured workspace is refused, listing the ones that exist', () => {
  const ws = freshWs();
  const res = spawnSync(process.execPath, [BIN, '-w', 'nowhere', '-b', 'rc-spent'], {
    encoding: 'utf8',
    cwd: UNRELATED_CWD,
    input: NEXT,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: ws.configDir },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /no such workspace "nowhere"/);
  assert.match(res.stderr, new RegExp(`workspaces: ${ws.name}`));
});

check('a bead that does not exist is refused with exit 2', () => {
  const ws = freshWs();
  const { status, stderr } = run(ws, ['-b', 'rc-nope']);
  assert.equal(status, 2);
  assert.match(stderr, /could not read rc-nope|has no bead rc-nope/);
});

/* ------------------------------------------------------------------- the whole job */

check('the spent block is retired, the next question lands in description, one block survives', () => {
  const ws = freshWs();
  const { status, stdout, stderr } = run(ws, ['-b', 'rc-spent', '--reason', 'split-30, answered 2026-08-22']);
  assert.equal(status, 0, `exit ${status}: ${stderr}`);

  const live = worldOf(ws).issues['rc-spent'];
  const blocks = ['description', 'design', 'notes'].flatMap((f) => stripDecisionBlocks(live[f]).blocks);
  assert.equal(blocks.length, 1, 'exactly one block must be left on the bead');

  // And it is in the field toQuestion reads first, asking what was handed in — checked
  // through toQuestion itself rather than by looking at the field, because "which block
  // renders" is the only question this command exists to answer.
  assert.equal(stripDecisionBlocks(live.description).blocks.length, 1);
  const q = toQuestion(ws.name, live);
  assert.equal(q.question, 'Close bc-khoe now its children have moved?');
  assert.deepEqual(
    (q.decision.options || []).map((o) => [o.id, o.recommended, o.closes, o.defers]),
    [
      ['close', true, true, false],
      ['hold', false, true, false],
      ['later', false, false, true],
    ]
  );
  assert.deepEqual(q.errors, []);
  assert.match(stdout, /readback: one block, in description/);
});

check('the prose of every field comes back byte for byte, and the banner names the reason', () => {
  const ws = freshWs();
  const { status } = run(ws, ['-b', 'rc-spent', '--reason', 'split-30, answered 2026-08-22']);
  assert.equal(status, 0);
  const live = worldOf(ws).issues['rc-spent'];

  // The two fields that were only cut keep their prose exactly.
  assert.equal(live.design, DESIGN_PROSE);
  assert.equal(live.notes, NOTES_PROSE);

  // The target field is its old prose, then the banner, then the new text, and nothing
  // else — so the original description survives as its own leading bytes.
  assert.ok(live.description.startsWith(`${DESC_PROSE}\n\n`), live.description.slice(0, 120));
  assert.ok(live.description.endsWith(NEXT), 'the new text is last, so decisionTail still holds');
  const banner = live.description.slice(DESC_PROSE.length, live.description.length - NEXT.length).trim();
  assert.match(banner, /answered and retired \d{4}-\d{2}-\d{2} — split-30, answered 2026-08-22/);
  assert.match(banner, /kept verbatim in a comment/);
});

check('both retired blocks are archived verbatim in one comment', () => {
  const ws = freshWs();
  run(ws, ['-b', 'rc-spent']);
  const comments = worldOf(ws).comments['rc-spent'] || [];
  assert.equal(comments.length, 1, 'one comment, not one per block');
  assert.ok(comments[0].includes(SPENT), 'the spent block, byte for byte');
  assert.ok(comments[0].includes(SHADOWED), 'the shadowed one too — cutting it must not lose it');
  assert.match(comments[0], /the one the card was drawing/);
  assert.match(comments[0], /shadowed, never drawn/);
});

check('the shadowed block and the marker that makes cutting it final are both named', () => {
  const ws = freshWs();
  const { stdout } = run(ws, ['-b', 'rc-spent']);
  assert.match(stdout, /a shadowed block in notes is being cut/);
  assert.match(stdout, /beadcause:superseded/);
  // And the marker itself is still on the bead — it is what stops the sweep asking twice.
  assert.ok(worldOf(ws).issues['rc-spent'].notes.includes(MARKER));
});

// The other half of the same notice, and the one the real tracker actually turns up: the
// block being retired IS what the card was drawing, and it is a sweep's, beside the
// marker that means retiring it settles the question for good. Not shadowed, still final.
check('retiring a drawn block beside a marker says so, without calling it shadowed', () => {
  const ws = freshWs();
  const { status, stdout } = run(ws, ['-b', 'rc-sweep']);
  assert.equal(status, 0);
  assert.match(stdout, /notes carries beadcause:superseded, so nothing will raise this question again/);
  assert.doesNotMatch(stdout, /shadowed/);
  assert.ok(worldOf(ws).issues['rc-sweep'].notes.includes(MARKER), 'and the marker itself stays');
  assert.equal(worldOf(ws).issues['rc-sweep'].notes, NOTES_PROSE);
});

check('--no-keep retires without archiving', () => {
  const ws = freshWs();
  const { status, stdout } = run(ws, ['-b', 'rc-spent', '--no-keep']);
  assert.equal(status, 0);
  assert.deepEqual(worldOf(ws).comments['rc-spent'], undefined);
  assert.doesNotMatch(stdout, /archive \d+ retired block/);
  // …and the banner no longer claims a copy exists.
  assert.doesNotMatch(worldOf(ws).issues['rc-spent'].description, /kept verbatim in a comment/);
});

check('--dry-run prints the plan and the resulting card, and writes nothing', () => {
  const ws = freshWs();
  const before = JSON.stringify(worldOf(ws));
  const verbsBefore = verbsCalled().length;
  const { status, stdout } = run(ws, ['-b', 'rc-spent', '--dry-run']);
  assert.equal(status, 0);
  assert.match(stdout, /would write:/);
  assert.match(stdout, /1\. .*comment/);
  assert.match(stdout, /the card this would leave:/);
  assert.match(stdout, /Close bc-khoe now its children have moved\?/);
  assert.match(stdout, /nothing was written/);
  assert.equal(JSON.stringify(worldOf(ws)), before, 'the world must be untouched');
  const since = verbsCalled().slice(verbsBefore);
  assert.deepEqual([...new Set(since)], ['show'], `dry-run may only read; it ran ${since.join(', ')}`);
});

check('the numbered writes name each field and its size change', () => {
  const ws = freshWs();
  const { stdout } = run(ws, ['-b', 'rc-spent']);
  assert.match(stdout, /1\. .*comment.*archive 2 retired blocks/);
  assert.match(stdout, /2\. .*description.*the new block, after the prose/);
  assert.match(stdout, /3\. .*design.*1 competing block cut, prose left/);
  assert.match(stdout, /4\. .*notes.*1 competing block cut, prose left/);
  assert.match(stdout, /\d+ → \d+ bytes/);
});

check('--field design puts the block there and leaves description prose alone', () => {
  const ws = freshWs();
  const { status, stdout } = run(ws, ['-b', 'rc-spent', '--field', 'design']);
  assert.equal(status, 0);
  const live = worldOf(ws).issues['rc-spent'];
  assert.equal(live.description, DESC_PROSE, 'description had no block and gains none');
  assert.equal(stripDecisionBlocks(live.design).blocks.length, 1);
  assert.equal(stripDecisionBlocks(live.notes).blocks.length, 0);
  assert.equal(toQuestion(ws.name, live).question, 'Close bc-khoe now its children have moved?');
  assert.match(stdout, /readback: one block, in design/);
});

check('a bead carrying no block at all gets the question with no banner and no comment', () => {
  const ws = freshWs();
  const { status, stdout } = run(ws, ['-b', 'rc-blank']);
  assert.equal(status, 0);
  const live = worldOf(ws).issues['rc-blank'];
  assert.equal(live.description, `${DESC_PROSE}\n\n${NEXT}`);
  assert.equal(live.design, DESIGN_PROSE, 'a field with no block is not written at all');
  assert.equal(live.notes, NOTES_PROSE);
  assert.equal(worldOf(ws).comments['rc-blank'], undefined, 'nothing was retired, so nothing is archived');
  assert.match(stdout, /retiring: nothing/);
});

check('a block already in description is replaced in place, not appended beside', () => {
  const ws = freshWs();
  const { status } = run(ws, ['-b', 'rc-desc']);
  assert.equal(status, 0);
  const live = worldOf(ws).issues['rc-desc'];
  assert.equal(stripDecisionBlocks(live.description).blocks.length, 1);
  assert.ok(live.description.startsWith(DESC_PROSE), 'the prose above the old block stays put');
  assert.ok(!live.description.includes('Does bc-khoe come out in two?'), 'the old question is gone from the bead');
  assert.ok((worldOf(ws).comments['rc-desc'] || [])[0].includes(SPENT), 'and kept in the comment');
});

check('-f reads the same block from a file as stdin does', () => {
  const ws = freshWs();
  const f = path.join(tmp, 'next.md');
  fs.writeFileSync(f, `${NEXT}\n`);
  const { status } = run(ws, ['-b', 'rc-spent', '-f', f], { stdin: 'this must be ignored' });
  assert.equal(status, 0);
  assert.equal(toQuestion(ws.name, worldOf(ws).issues['rc-spent']).question, 'Close bc-khoe now its children have moved?');
});

check('-f naming a file that is not there is refused before any bd spawn', () => {
  const ws = freshWs();
  const before = callCount();
  const { status, stderr } = run(ws, ['-b', 'rc-spent', '-f', path.join(tmp, 'nope.md')]);
  assert.equal(status, 2);
  assert.match(stderr, /could not read/);
  assert.equal(callCount(), before);
});

check('running it twice is idempotent — the second run retires the block the first wrote', () => {
  const ws = freshWs();
  assert.equal(run(ws, ['-b', 'rc-spent']).status, 0);
  const { status } = run(ws, ['-b', 'rc-spent']);
  assert.equal(status, 0);
  const live = worldOf(ws).issues['rc-spent'];
  assert.equal(stripDecisionBlocks(live.description).blocks.length, 1, 'still one block, not two');
  assert.equal((worldOf(ws).comments['rc-spent'] || []).length, 2);
  // The banner is not allowed to stack: the second run cut the first block, and the
  // paragraph above it went with the prose — so exactly one banner is on the bead.
  assert.equal(live.description.match(/answered and retired/g).length, 1);
});

// `decisionTail` does not require a `question:`, and `toQuestion` renders the bead's
// title in its place — so the readback has to expect the title, not the empty string,
// or every block written without one would report a disagreement that is not there.
check('a block with no question: takes the bead title, and the readback agrees', () => {
  const ws = freshWs();
  const noQuestion = ['```decision', 'options:', '  - id: go', '    label: Go', '    response: "Go."', '    recommended: true', '```'].join('\n');
  const { status, stdout } = run(ws, ['-b', 'rc-spent'], { stdin: noQuestion });
  assert.equal(status, 0, stdout);
  assert.match(stdout, /readback: one block/);
  assert.equal(toQuestion(ws.name, worldOf(ws).issues['rc-spent']).question, 'A bead with a spent question on it');
});

/* -------------------------------------------------------------- the readback gate */

check('a write that silently does not land is caught by the readback, exit 1', () => {
  const ws = freshWs();
  const w = worldOf(ws);
  w.refuseWrites = true;
  fs.writeFileSync(path.join(ws.dir, 'world.json'), JSON.stringify(w, null, 2));
  const { status, stdout } = run(ws, ['-b', 'rc-spent']);
  assert.equal(status, 1, 'the writes went out and the card is not what was handed in');
  assert.match(stdout, /the readback disagrees/);
  assert.match(stdout, /2 decision blocks are on the bead, not 1/);
});

console.log('');
if (failures) {
  console.log(`b7e-recard: ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('b7e-recard: all checks passed\n');
