#!/usr/bin/env node
/**
 * `b7e-ruled` — has Adam already decided this? Every ruling on a topic, newest first.
 * lib/ruled.js and bin/b7e-ruled.
 *
 *   npm test
 *   node test/ruled.mjs
 *
 * bc-dgx7.102's own corpus is the shape this replays: a closed `decision`-typed bead
 * whose ruling is the comment `respond()` wrote right before closing (the `dv-afr.7`
 * shape — "he closed at 22:32 today"), a still-open `human`-labelled packet (a question
 * not yet put to Adam, so it must never be reported as a ruling), a CHANGE_LOG.md entry
 * whose `Type` names a decision (the `dv-52r.2` shape — the Kazran spear-points ruling
 * that lived in reference prose, here standing in as a `WORLD DECISION` entry), and a
 * CHANGE_LOG entry whose `Type` is `STRUCTURAL CHANGE` that must never surface even when
 * its words match, because it records work done rather than a ruling made.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-ruled');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eruled-'));
process.on('exit', () => removeTreeSync(tmp));

/* ---------------------------------------------------------------------- fake bd */

const WORLD = {
  issues: {
    // A ruling: closed via respond(), the ruling text is the comment it wrote.
    'dv-dtvt': {
      id: 'dv-dtvt',
      title: 'What is the working chapter word count for Book 3?',
      status: 'closed',
      issue_type: 'decision',
      priority: 2,
      labels: [],
      close_reason: 'Answered via Beadcause',
      description: 'Two chapters are running long against the stated Book 3 target.',
      design: '',
      notes: '',
      acceptance_criteria: '',
      updated_at: '2026-08-24T22:32:00Z',
      closed_at: '2026-08-24T22:32:00Z',
      comments: [
        {
          author: 'beadcause (neadamthal@gmail.com)',
          text: '~7,600 is the working chapter length for Book 3 — update the target rather than trimming.',
          created_at: '2026-08-24T22:32:00Z',
        },
      ],
    },
    // A question already rejected once — must not resurface as though unasked, and
    // must not be confused with dv-dtvt when the topic differs.
    'dv-wordbudget': {
      id: 'dv-wordbudget',
      title: 'Cut the whole-book word budget to fit one printed volume?',
      status: 'closed',
      issue_type: 'decision',
      priority: 2,
      labels: [],
      close_reason: 'Answered via Beadcause',
      description: 'A candidate finding proposed trimming the whole-book budget.',
      design: '',
      notes: '',
      acceptance_criteria: '',
      updated_at: '2026-08-24T21:00:00Z',
      closed_at: '2026-08-24T21:00:00Z',
      comments: [{ author: 'beadcause (neadamthal@gmail.com)', text: 'No — keep the two-volume split.', created_at: '2026-08-24T21:00:00Z' }],
    },
    // Still open, human-labelled — a packet already on Adam's tap, not yet a ruling.
    'dv-61ja': {
      id: 'dv-61ja',
      title: 'Chapter pacing gate — how strict should the word-count check be?',
      status: 'open',
      issue_type: 'task',
      priority: 2,
      labels: ['human'],
      close_reason: null,
      description: 'Chapter word count checks keep flagging chapters nobody has ruled on.',
      design: '',
      notes: '',
      acceptance_criteria: '',
      updated_at: '2026-08-23T09:00:00Z',
      created_at: '2026-08-20T09:00:00Z',
      comments: [],
    },
    // Nothing to do with any of the above topics, so it must never appear in results.
    'dv-unrelated': {
      id: 'dv-unrelated',
      title: 'Sven the expansionist — surface arrival staging',
      status: 'closed',
      issue_type: 'decision',
      priority: 2,
      labels: [],
      close_reason: 'Answered via Beadcause',
      description: 'Unrelated ruling about a different character entirely.',
      design: '',
      notes: '',
      acceptance_criteria: '',
      updated_at: '2026-08-22T09:00:00Z',
      closed_at: '2026-08-22T09:00:00Z',
      comments: [{ author: 'beadcause (neadamthal@gmail.com)', text: 'Sven arrives after the impact, not before.', created_at: '2026-08-22T09:00:00Z' }],
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
  const { comments, ...rest } = issue;
  process.stdout.write(JSON.stringify([rest]));
  process.exit(0);
}
if (verb === 'comments') {
  const id = args[1];
  const issue = world.issues[id];
  if (!issue) die('Error fetching ' + id + ': no issue found matching "' + id + '"');
  process.stdout.write(JSON.stringify(issue.comments || []));
  process.exit(0);
}
if (verb === 'list') {
  const typeAt = args.indexOf('--type');
  const type = typeAt > -1 ? args[typeAt + 1] : null;
  const labelAt = args.indexOf('--label-any');
  const labelAny = labelAt > -1 ? args[labelAt + 1].split(',') : null;
  let rows = Object.values(world.issues);
  if (type) rows = rows.filter((r) => r.issue_type === type);
  if (labelAny) rows = rows.filter((r) => (r.labels || []).some((l) => labelAny.includes(l)));
  rows = rows.map(({ comments, ...rest }) => rest);
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
die('stub bd: unexpected verb "' + verb + '"');
`,
  { mode: 0o755 }
);

/* ------------------------------------------------------------------- fixture repo */

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const REPO = path.join(tmp, 'repo');
fs.mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 'test@localhost');
git(REPO, 'config', 'user.name', 'test');

const CHANGE_LOG = `# CHANGE_LOG

## Entry 168 — 2026-08-25

**Type:** WORLD DECISION
**Status:** [PROPAGATED]
**Decision:** Kazran metalwork stays elite war gear — bronze spear points for the Kazran
Orve kit specifically, stone for the Alban Orve kit. Korgath Iron-Voice is covered by the
same ruling.
**Priority:** STRUCTURAL

**Chapters affected:**
- [ ] Book 2, Ch. 7 — Kazran-POV weapon depiction

## Entry 167 — 2026-08-24

**Type:** STRUCTURAL CHANGE
**Status:** [PROPAGATED]
**Decision:** Kazran spear points regenerated at the corrected model-sheet proportions —
execution only, no new canon.
**Priority:** COSMETIC

**Chapters affected:**
- [ ] none — asset only
`;
fs.writeFileSync(path.join(REPO, 'CHANGE_LOG.md'), CHANGE_LOG);
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'base');

/* -------------------------------------------------------------------- config */

function configDirWith() {
  const dir = fs.mkdtempSync(path.join(tmp, 'config-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'ruled-ws', dir: path.join(tmp, 'tracker') }] }, null, 2)
  );
  return dir;
}
fs.mkdirSync(path.join(tmp, 'tracker'), { recursive: true });
const CONFIG_DIR = configDirWith();

function run(args, { configDir = CONFIG_DIR } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
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

console.log('\nb7e-ruled\n');

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-ruled/);
});

check('a missing -w is refused', () => {
  const { status, stderr } = run(['some topic']);
  assert.notEqual(status, 0);
  assert.match(stderr, /-w\/--workspace is required/);
});

check('no topic and no -b is refused', () => {
  const { status, stderr } = run(['-w', 'ruled-ws']);
  assert.notEqual(status, 0);
  assert.match(stderr, /a topic.*or -b\/--bead is required/);
});

check('acceptance: a topic with a closed ruling returns the ruling comment and its timestamp', () => {
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', REPO, 'chapter word count']);
  assert.equal(status, 0);
  assert.match(stdout, /dv-dtvt — ruled \(2026-08-24T22:32:00Z\)/);
  assert.match(stdout, /~7,600 is the working chapter length for Book 3 — update the target rather than trimming\./);
});

check('the ruling is the whole answer — an unrelated closed decision never appears', () => {
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', REPO, 'chapter word count']);
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /dv-unrelated/);
  assert.doesNotMatch(stdout, /dv-wordbudget/);
});

check('acceptance: a topic ruled only in CHANGE_LOG returns the WORLD DECISION entry, not the STRUCTURAL CHANGE one', () => {
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', REPO, 'Kazran spear points']);
  assert.equal(status, 0);
  assert.match(stdout, /Entry 168.*CHANGE_LOG \(2026-08-25\)/);
  assert.match(stdout, /type: WORLD DECISION/);
  assert.match(stdout, /bronze spear points for the Kazran/);
  assert.doesNotMatch(stdout, /Entry 167/);
});

check('acceptance: a topic with no ruling returns nothing and exits 0', () => {
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', REPO, 'a topic nobody has ever ruled on']);
  assert.equal(status, 0);
  assert.match(stdout, /no ruling found on this topic\./);
});

check('a still-open human-labelled packet reads as open, not as a ruling', () => {
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', REPO, 'chapter pacing gate word count']);
  assert.equal(status, 0);
  assert.match(stdout, /dv-61ja — open, awaiting Adam/);
});

check('-b derives the topic from that bead\'s own title', () => {
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', REPO, '-b', 'dv-61ja']);
  assert.equal(status, 0);
  assert.match(stdout, /dv-61ja — open, awaiting Adam/);
});

check('an unknown bead given to -b is refused', () => {
  const { status, stderr } = run(['-w', 'ruled-ws', '-b', 'dv-nope']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no bead dv-nope/);
});

check('--since excludes a ruling before that date', () => {
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', REPO, '--since', '2026-08-26', 'Kazran spear points']);
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /Entry 168/);
});

check('--since keeps a ruling at or after that date', () => {
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', REPO, '--since', '2026-08-25', 'Kazran spear points']);
  assert.equal(status, 0);
  assert.match(stdout, /Entry 168/);
});

check('--json emits parseable, structurally complete output, newest first', () => {
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', REPO, '--json', 'chapter word count']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.topic, 'chapter word count');
  assert.equal(parsed.changeLogScanned, true);
  const ids = parsed.results.map((r) => r.id);
  assert.ok(ids.includes('dv-dtvt'));
  // newest first
  const at = parsed.results.map((r) => r.at).filter(Boolean);
  const sorted = [...at].sort().reverse();
  assert.deepEqual(at, sorted);
});

check('an unrecognised --dir with no git repo at all is not fatal — bead rulings still print', () => {
  const emptyDir = fs.mkdtempSync(path.join(tmp, 'nogit-'));
  const { status, stdout } = run(['-w', 'ruled-ws', '--dir', emptyDir, 'chapter word count']);
  assert.equal(status, 0);
  assert.match(stdout, /dv-dtvt/);
});

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
