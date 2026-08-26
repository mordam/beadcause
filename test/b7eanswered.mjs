#!/usr/bin/env node
/**
 * `b7e-answered` — was this bead's question answered, and which bead in the family
 * actually carries the answer? lib/beadanswer.js and bin/b7e-answered.
 *
 *     npm test
 *     node test/b7eanswered.mjs
 *
 * bc-dgx7.84's own acceptance criteria are the cases this replays, against a fake `bd`
 * and a `state.json` carrying beadcause's own `answered` record:
 *
 * 1. A bead **answered on itself** — a `decision` block, closed with the reason
 *    `respond()` actually writes.
 * 2. The **bc-jjdar.1 shape**: the bead itself carries no `decision` block (plain
 *    work, nothing to answer) but its parent does, and the parent is answered —
 *    `--family` has to find it there.
 * 3. The **bc-mwhkg.1 shape**: neither the bead nor its parent carries a `decision`
 *    block at all — the verdict is "not answered anywhere", not a guess at either end.
 * 4. A bead nobody has answered yet — a `decision` block, still open, no record.
 * 5. A **deferred** answer — no writes on the bead at all (still open, still
 *    `human`-labelled), the *only* trace is the `state.json` record. This is the
 *    case lib/answered.js exists for and the one nothing else can see.
 * 6. A **commissioned** answer — open, `human` label removed, `state.json` record
 *    present.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-answered');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eanswered-'));
process.on('exit', () => removeTreeSync(tmp));

/* ---------------------------------------------------------------------- fake bd */

const decisionBlock = (question, options) =>
  [
    '```decision',
    `question: ${question}`,
    'options:',
    ...options.flatMap((o) => [
      `  - id: ${o.id}`,
      `    label: ${o.label}`,
      `    response: "${o.response}"`,
      ...(o.recommended ? ['    recommended: true'] : []),
      ...(o.defers ? ['    defers: true'] : []),
      ...(o.closes === false ? ['    closes: false'] : []),
    ]),
    '```',
  ].join('\n');

const WORLD = {
  issues: {
    // 1. Answered on itself — respond() closed it with its own reason.
    'ws-self': {
      id: 'ws-self',
      title: 'Charge the platform fee on gross or net?',
      status: 'closed',
      issue_type: 'task',
      priority: 2,
      parent: null,
      labels: [],
      close_reason: 'Answered via Beadcause',
      description: decisionBlock('Gross or net?', [
        { id: 'gross', label: 'Gross', response: 'Gross — fee on the full charge amount.', recommended: true },
        { id: 'net', label: 'Net', response: 'Net — fee after refunds.' },
      ]),
      design: '',
      notes: '',
      comments: [{ author: 'beadcause (neadamthal@gmail.com)', text: 'Gross — fee on the full charge amount.', created_at: '2026-08-20T10:00:00Z' }],
    },
    // 2. The bc-jjdar.1 shape: plain work, no decision block, no comments.
    'ws-child': {
      id: 'ws-child',
      title: 'Error dedupe serialises on both fingerprints but matches on either',
      status: 'open',
      issue_type: 'bug',
      priority: 2,
      parent: 'ws-parent',
      labels: [],
      close_reason: null,
      description: 'windowKey is a conjunction, findByFingerprint is an OR — they disagree.',
      design: '',
      notes: '',
      comments: [],
    },
    // ...and its parent, which does carry the question and was answered.
    'ws-parent': {
      id: 'ws-parent',
      title: 'Two beads for one crash, 27ms apart — what do we do with the root bead?',
      status: 'open',
      issue_type: 'bug',
      priority: 1,
      parent: null,
      labels: ['human-replied'],
      close_reason: null,
      description: decisionBlock('Close the root once both children land, or now?', [
        { id: 'later', label: 'Leave it open until both children land', response: 'Leave it open as the root; close it once both children have landed.', recommended: true },
        { id: 'now', label: 'Close it now' },
      ]),
      design: '',
      notes: '',
      comments: [{ author: 'beadcause (neadamthal@gmail.com)', text: 'Leave it open as the root; close it once both children have landed.', created_at: '2026-08-25T13:06:23Z' }],
    },
    // 3. The bc-mwhkg.1 shape: nothing on the bead OR its parent.
    'ws-mwhkg1': {
      id: 'ws-mwhkg1',
      title: 'Work discovered from an app-error is homed under a P0 that closes early',
      status: 'open',
      issue_type: 'task',
      priority: 2,
      parent: 'ws-mwhkg',
      labels: [],
      close_reason: null,
      description: 'Plain work — no question here.',
      design: '',
      notes: '',
      comments: [],
    },
    'ws-mwhkg': {
      id: 'ws-mwhkg',
      title: 'Uncaught ReferenceError — viewhost.js:427',
      status: 'open',
      issue_type: 'bug',
      priority: 0,
      parent: null,
      labels: [],
      close_reason: null,
      description: 'Plain crash report — no decision block either.',
      design: '',
      notes: '',
      comments: [],
    },
    // 4. A question nobody has answered.
    'ws-open': {
      id: 'ws-open',
      title: 'Which base image for the worker?',
      status: 'open',
      issue_type: 'task',
      priority: 2,
      parent: null,
      labels: ['human'],
      close_reason: null,
      description: decisionBlock('Which base image?', [
        { id: 'slim', label: 'slim', response: 'The slim image.', recommended: true },
        { id: 'full', label: 'full', response: 'The full image.' },
      ]),
      design: '',
      notes: '',
      comments: [],
    },
    // 5. Deferred — nothing on the bead at all; only state.json knows.
    'ws-deferred': {
      id: 'ws-deferred',
      title: 'Split the platform fee epic now or after Q3?',
      status: 'open',
      issue_type: 'task',
      priority: 2,
      parent: null,
      labels: ['human'],
      close_reason: null,
      description: decisionBlock('Split now or later?', [
        { id: 'now', label: 'Now', response: 'Split it now.' },
        { id: 'later', label: 'Not yet', response: 'Not yet — ask again once Q3 planning starts.', defers: true },
      ]),
      design: '',
      notes: '',
      comments: [],
    },
    // 7. bc-dgx7.95: closed as a ruling, no state.json record — the comment is the only
    // trace of what was chosen, and it matches the 'gross' option verbatim.
    'ws-self-nostate': {
      id: 'ws-self-nostate',
      title: 'Charge the platform fee on gross or net, answered by hand?',
      status: 'closed',
      issue_type: 'task',
      priority: 2,
      parent: null,
      labels: [],
      close_reason: 'Answered via Beadcause',
      description: decisionBlock('Gross or net?', [
        { id: 'gross', label: 'Gross', response: 'Gross — fee on the full charge amount.', recommended: true },
        { id: 'net', label: 'Net', response: 'Net — fee after refunds.' },
      ]),
      design: '',
      notes: '',
      comments: [{ author: 'beadcause (neadamthal@gmail.com)', text: 'Gross — fee on the full charge amount.', created_at: '2026-07-01T10:00:00Z' }],
    },
    // 8. bc-dgx7.95: closed as a ruling, no state.json record, AND no comment at all —
    // the gap this bead exists to name rather than mask as an empty "(closed)".
    'ws-unrecorded': {
      id: 'ws-unrecorded',
      title: 'Split the fee epic — closed as a ruling with nothing on the thread',
      status: 'closed',
      issue_type: 'task',
      priority: 2,
      parent: null,
      labels: [],
      close_reason: 'Answered via Beadcause',
      description: decisionBlock('Split now or later?', [
        { id: 'now', label: 'Now', response: 'Split it now.', recommended: true },
        { id: 'later', label: 'Not yet', response: 'Not yet.' },
      ]),
      design: '',
      notes: '',
      comments: [],
    },
    // 6. Commissioned — open, `human` label gone, state.json has the record.
    'ws-commissioned': {
      id: 'ws-commissioned',
      title: 'Build both as written, or just the API?',
      status: 'open',
      issue_type: 'task',
      priority: 2,
      parent: null,
      labels: [],
      close_reason: null,
      description: decisionBlock('Build both, or just the API?', [
        { id: 'both', label: 'Both', response: 'Build both as written.', closes: false },
        { id: 'api', label: 'API only', response: 'Just the API.', closes: false },
      ]),
      design: '',
      notes: '',
      comments: [{ author: 'beadcause (neadamthal@gmail.com)', text: 'Build both as written.', created_at: '2026-08-24T09:00:00Z' }],
    },
  },
};

const FAKE_BD = path.join(tmp, 'bd');
const CALLS = path.join(tmp, 'calls.jsonl');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const world = ${JSON.stringify(WORLD)};
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const verb = args[0];
if (verb === 'show') {
  const id = args[1];
  const issue = world.issues[id];
  if (!issue) die('Error fetching ' + id + ': no issue found matching "' + id + '"');
  const includeComments = args.includes('--include-comments');
  const { comments, ...rest } = issue;
  const out = includeComments ? { ...rest, comments: comments || [] } : rest;
  process.stdout.write(JSON.stringify([out]));
  process.exit(0);
}
die('stub bd: unexpected verb "' + verb + '"');
`,
  { mode: 0o755 }
);

/* -------------------------------------------------------------------- config */

function configDirWith(answered) {
  const dir = fs.mkdtempSync(path.join(tmp, 'config-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'answered-ws', dir: path.join(tmp, 'tracker') }] }, null, 2)
  );
  if (answered) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ answered }, null, 2));
  return dir;
}
fs.mkdirSync(path.join(tmp, 'tracker'), { recursive: true });

const STATE_ANSWERED = {
  'answered-ws/ws-deferred': { at: '2026-08-25T12:00:00Z', response: 'Not yet — ask again once Q3 planning starts.', count: 1 },
  'answered-ws/ws-commissioned': { at: '2026-08-24T09:00:00Z', response: 'Build both as written.', count: 1 },
};
const CONFIG_DIR = configDirWith(STATE_ANSWERED);
const CONFIG_DIR_NO_STATE = configDirWith(null);

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function run(args, { configDir = CONFIG_DIR } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: stripAnsi(res.stdout || ''), stderr: stripAnsi(res.stderr || '') };
}

/* ------------------------------------------------------------------- harness */

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 10).join('\n       ')}`);
  }
};

console.log('\nb7e-answered\n');

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-answered/);
});

check('a missing -w is refused', () => {
  const { status, stderr } = run(['-b', 'ws-self']);
  assert.notEqual(status, 0);
  assert.match(stderr, /-w\/--workspace is required/);
});

check('an unknown bead is refused', () => {
  const { status, stderr } = run(['-w', 'answered-ws', '-b', 'ws-nope']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no bead ws-nope/);
});

check('acceptance: answered on itself', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-self']);
  assert.equal(status, 0);
  assert.match(stdout, /ws-self.*answered/s);
  assert.match(stdout, /\(closed\)/);
  assert.match(stdout, /verdict: answered — on ws-self\./);
});

check('acceptance (bc-jjdar.1 shape): the bead itself is plain work, the answer is on its parent', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-child', '--family']);
  assert.equal(status, 0);
  assert.match(stdout, /ws-child — not a question/);
  assert.match(stdout, /ws-parent.*answered/s);
  assert.match(stdout, /verdict: answered — on ws-parent \(an ancestor, not the bead itself\)\./);
});

check('without --family, the parent is never consulted and the child reads as plain work', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-child']);
  assert.equal(status, 0);
  assert.match(stdout, /ws-child — not a question/);
  assert.match(stdout, /verdict: not answered/);
  assert.doesNotMatch(stdout, /ws-parent/);
});

check('acceptance (bc-mwhkg.1 shape): nothing answered anywhere in the chain, despite the brief', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-mwhkg1', '--family']);
  assert.equal(status, 0);
  assert.match(stdout, /ws-mwhkg1 — not a question/);
  assert.match(stdout, /ws-mwhkg — not a question/);
  assert.match(stdout, /verdict: not answered — nothing in the chain checked \(ws-mwhkg1, ws-mwhkg\) carries an answer\./);
});

check('acceptance: a question nobody has answered', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-open']);
  assert.equal(status, 0);
  assert.match(stdout, /ws-open — unanswered/);
  assert.match(stdout, /verdict: not answered/);
});

check('a deferred answer is invisible without state.json, and correct with it', () => {
  const bare = run(['-w', 'answered-ws', '-b', 'ws-deferred'], { configDir: CONFIG_DIR_NO_STATE });
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /ws-deferred — unanswered/);

  const withState = run(['-w', 'answered-ws', '-b', 'ws-deferred']);
  assert.equal(withState.status, 0);
  assert.match(withState.stdout, /ws-deferred — answered \(deferred\)/);
  assert.match(withState.stdout, /chose: Not yet \[later\]/);
  assert.match(withState.stdout, /beadcause recorded an answer/);
});

check('a commissioned answer reads as commissioned, not closed', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-commissioned']);
  assert.equal(status, 0);
  assert.match(stdout, /ws-commissioned — answered \(commissioned\)/);
  assert.match(stdout, /chose: Both \[both\]/);
});

check('--json emits parseable, structurally complete output', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-child', '--family', '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.bead, 'ws-child');
  assert.equal(parsed.family, true);
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0].id, 'ws-child');
  assert.equal(parsed.results[0].state, 'not-a-question');
  assert.equal(parsed.results[1].id, 'ws-parent');
  assert.equal(parsed.results[1].state, 'answered');
  assert.equal(parsed.carrier.id, 'ws-parent');
});

console.log('\nbc-dgx7.95: the ruling itself, from the tracker\n');

check('acceptance: a ruling recorded only as a comment (no state.json) is resolved from the thread', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-self-nostate'], { configDir: CONFIG_DIR_NO_STATE });
  assert.equal(status, 0);
  assert.match(stdout, /ws-self-nostate — answered \(closed\)/);
  assert.match(stdout, /chose: Gross \[gross\]/);
  assert.match(stdout, /a comment carries the ruling.*Gross — fee on the full charge amount\./);
  assert.match(stdout, /» Gross \[gross\] \(recommended, chosen\)/);
  assert.match(stdout, /^\s+Net \[net\]$/m);
});

check('a ruling with no comment on the thread reads as answered-but-unrecorded, not an empty ruling', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-unrecorded'], { configDir: CONFIG_DIR_NO_STATE });
  assert.equal(status, 0);
  assert.match(stdout, /ws-unrecorded — answered \(answered-but-unrecorded\)/);
  assert.doesNotMatch(stdout, /chose:/);
  assert.match(stdout, /no comment recording what was chosen/);
});

check('--json carries the resolved option and the verbatim comment', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-self-nostate', '--json'], { configDir: CONFIG_DIR_NO_STATE });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  const r = parsed.results[0];
  assert.equal(r.chosenOption.id, 'gross');
  assert.equal(r.answerComment.text, 'Gross — fee on the full charge amount.');
  assert.equal(r.answerComment.at, '2026-07-01T10:00:00Z');
});

check('acceptance: several beads in one invocation, including one that does not exist', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-self', '-b', 'ws-open,ws-nope']);
  assert.equal(status, 0);
  assert.match(stdout, /b7e-answered 3 beads/);
  assert.match(stdout, /ws-self — answered \(closed\)/);
  assert.match(stdout, /ws-open — unanswered/);
  assert.match(stdout, /ws-nope — .*no issue found matching/);
  assert.match(stdout, /1\/2 answered, 1 not found/);
});

check('multi-bead --json is one row per requested id, including the not-found one', () => {
  const { status, stdout } = run(['-w', 'answered-ws', '-b', 'ws-self,ws-nope', '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.beads, ['ws-self', 'ws-nope']);
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0].bead, 'ws-self');
  assert.equal(parsed.results[0].carrier.id, 'ws-self');
  assert.equal(parsed.results[1].notFound, true);
});

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
