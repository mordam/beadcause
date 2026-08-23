#!/usr/bin/env node
//
// b7e-orient — one call for the bead, its family, its thread and what earlier runs
// left (bc-zjab.9). A session audit found nine sessions each hand-assembling the same
// four questions in a different order and paying for it: nine of twelve went looking
// for a repo CLAUDE.md that does not exist, and five never asked for a prior debrief.
//
//   npm test
//   node test/b7eorient.mjs
//
// Driven as a real subprocess against a stub `bd`, for the reason test/b7ews.mjs gives:
// the flags reaching `bd` are the thing under test. The stub answers `show` (with and
// without `--include-comments`), `comments` and `export` from one JSON world per
// workspace directory, exactly the three verbs this command spawns.
//
// The debrief store is real, not stubbed: tier 4 lives in git refs beside the code
// checkout (lib/sessionlog.js), so the fixture is a throwaway git repo with
// `refs/beadcause/sessions/<bead>` written by plain git plumbing — the same shape
// `archiveSession` leaves, with `memory.md` as the one file in the tree. `sessionDirs`
// in the fixture config points `resolveSessionDir` (lib/session.js) straight at it,
// which is also what proves this command never mistakes `ws.dir` — the *tracker's*
// directory — for the git checkout a `CLAUDE.md` or a debrief would live in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-orient');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eorient-'));
process.on('exit', () => removeTreeSync(tmp));

/* -------------------------------------------------------------- the code checkout */

const REPO = path.join(tmp, 'repo');
fs.mkdirSync(REPO, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@localhost');
git('config', 'user.name', 'test');
git('commit', '-q', '--allow-empty', '-m', 'root');

/** A session's debrief, written the way `archiveSession` leaves one: one commit, one
 * `memory.md` blob, no parent — on `refs/beadcause/sessions/<bead>`. */
function writeDebrief(bead, text) {
  const blob = execFileSync('git', ['-C', REPO, 'hash-object', '-w', '--stdin'], { input: text, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['-C', REPO, 'mktree'], { input: `100644 blob ${blob}\tmemory.md\n`, encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['-C', REPO, 'commit-tree', tree, '-m', 'debrief'], { encoding: 'utf8' }).trim();
  git('update-ref', `refs/beadcause/sessions/${bead}`, commit);
}

writeDebrief('or-plan.9', 'worker · 2026-01-01T00:00:00Z\n\nThe primary bead\'s own prior run left this note.');
writeDebrief('or-epic.1', 'worker · 2026-01-02T00:00:00Z\n\nA sibling under the same parent left this note.');
writeDebrief('zz-999', 'worker · 2026-01-03T00:00:00Z\n\nAn unrelated bead — must never show up here.');

/* ---------------------------------------------------------------------- the stub bd */

const FAKE_BD = path.join(tmp, 'bd');
const CALLS = path.join(tmp, 'calls.jsonl');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.BEADS_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, dir }) + '\\n');
const world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const verb = args[0];
const rest = args.slice(1);
const ids = [];
const flags = new Set();
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i];
  if (a === '--json' || a === '--include-comments') { flags.add(a); continue; }
  if (a === '--actor') { i += 1; continue; }
  ids.push(a);
}
if (verb === 'show') {
  const rows = [];
  for (const id of ids) {
    const issue = world.issues[id];
    if (!issue) die('Error fetching ' + id + ': no issue found matching "' + id + '"');
    const row = { ...issue };
    if (flags.has('--include-comments')) row.comments = world.comments[id] || [];
    rows.push(row);
  }
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (verb === 'comments') {
  process.stdout.write(JSON.stringify(world.comments[ids[0]] || []));
  process.exit(0);
}
if (verb === 'export') {
  const lines = Object.values(world.issues).map((i) => JSON.stringify(i));
  process.stdout.write(lines.join('\\n') + '\\n');
  process.exit(0);
}
die('stub bd: unexpected verb "' + verb + '"');
`,
  { mode: 0o755 }
);

/* ------------------------------------------------------------------- the world */

const dep = (from, to, type) => ({ issue_id: from, depends_on_id: to, type });

const issue = (id, over = {}) => ({
  id,
  title: '',
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  assignee: '',
  owner: '',
  labels: [],
  acceptance_criteria: '',
  parent: null,
  dependencies: [],
  ...over,
});

const PLAN_TEXT = `Plan for or-plan.

<!-- beadcause:plan -->
\`\`\`json
${JSON.stringify(
  {
    epic: 'or-plan',
    groups: [
      {
        name: 'orient-group',
        beads: ['or-plan.9'],
        prs: [{ repo: 'orient-ws', title: 'Ship b7e-orient' }],
        prompt: 'Do the one thing this group is for.\nA second line of the prompt.',
      },
    ],
  },
  null,
  2
)}
\`\`\`
<!-- /beadcause:plan -->`;

const WORLD = {
  issues: {
    'or-plan.9': issue('or-plan.9', {
      title: 'The primary bead under test',
      status: 'in_progress',
      priority: 1,
      assignee: 'carol@example.com',
      labels: ['agent-filed'],
      acceptance_criteria: 'It works.',
      parent: 'or-epic',
      dependencies: [dep('or-plan.9', 'or-epic', 'parent-child')],
    }),
    'or-epic': issue('or-epic', { title: 'The tracker parent (carries no matching plan)', issue_type: 'epic', status: 'open' }),
    'or-epic.1': issue('or-epic.1', {
      title: 'A closed sibling',
      status: 'closed',
      assignee: 'alice@example.com',
      parent: 'or-epic',
      dependencies: [dep('or-epic.1', 'or-epic', 'parent-child')],
    }),
    'or-epic.2': issue('or-epic.2', {
      title: 'An open sibling',
      status: 'open',
      parent: 'or-epic',
      dependencies: [dep('or-epic.2', 'or-epic', 'parent-child')],
    }),
    'or-plan': issue('or-plan', { title: 'The dotted-prefix ancestor that actually carries the plan', issue_type: 'epic', status: 'open' }),
    'or-root': issue('or-root', { title: 'A root bead with no parent at all' }),
  },
  comments: {
    'or-plan.9': [{ id: 1, issue_id: 'or-plan.9', author: 'carol@example.com', text: 'A comment on the thread.', created_at: '2026-01-01T00:00:00Z' }],
    'or-epic': [],
    'or-plan': [{ id: 2, issue_id: 'or-plan', author: 'carol@example.com', text: PLAN_TEXT, created_at: '2026-01-01T00:00:00Z' }],
  },
};

const dirFor = (name) => {
  const dir = path.join(tmp, 'beads', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(WORLD, null, 2));
  return dir;
};
const WS = { name: 'orient-ws', dir: dirFor('orient-ws') };

const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify(
    {
      bdBin: FAKE_BD,
      actor: 'beadcause-test',
      workspaces: [WS],
      sessionDirs: { 'orient-ws': REPO },
    },
    null,
    2
  )
);

/* ------------------------------------------------------------------------- run */

const UNRELATED_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eorient-elsewhere-'));

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: UNRELATED_CWD,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const callCount = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).length : 0);

/* --------------------------------------------------------------------- harness */

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

console.log('\nb7e-orient\n');

check('--help prints usage and exits 0, without ever calling bd', () => {
  const before = callCount();
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-orient/);
  assert.equal(callCount(), before, 'help must not spawn bd');
});

check('a missing -w is refused before anything is resolved', () => {
  const before = callCount();
  const { status, stderr } = run(['-b', 'or-plan.9']);
  assert.notEqual(status, 0);
  assert.match(stderr, /-w\/--workspace is required/);
  assert.equal(callCount(), before);
});

check('a missing -b is refused before anything is resolved', () => {
  const before = callCount();
  const { status, stderr } = run(['-w', 'orient-ws']);
  assert.notEqual(status, 0);
  assert.match(stderr, /-b\/--bead is required/);
  assert.equal(callCount(), before);
});

check('an unconfigured workspace name is refused, naming the ones that exist', () => {
  const before = callCount();
  const { status, stderr } = run(['-w', 'nope', '-b', 'or-plan.9']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no workspace named "nope"/);
  assert.match(stderr, /orient-ws/);
  assert.equal(callCount(), before);
});

check('a bead that does not exist is a clean refusal, not a crash', () => {
  const { status, stderr } = run(['-w', 'orient-ws', '-b', 'zz-nope']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no bead zz-nope/);
});

check('the CLAUDE.md line names the checkout, not the tracker directory, and says which', () => {
  const { status, stdout } = run(['-w', 'orient-ws', '-b', 'or-plan.9']);
  assert.equal(status, 0);
  assert.match(stdout, /has NO CLAUDE\.md/);
  assert.match(stdout, new RegExp(REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(stdout, /beads[/\\]orient-ws/, 'must never name the tracker dir as the checkout');
});

check('once a CLAUDE.md exists in the checkout, the line says so — and prints first', () => {
  fs.writeFileSync(path.join(REPO, 'CLAUDE.md'), '# rules\n');
  try {
    const { status, stdout } = run(['-w', 'orient-ws', '-b', 'or-plan.9']);
    assert.equal(status, 0);
    const lines = stdout.split('\n').filter(Boolean);
    assert.match(lines[1] ?? lines[0], /HAS a CLAUDE\.md/);
  } finally {
    fs.rmSync(path.join(REPO, 'CLAUDE.md'));
  }
});

check('the bead section carries status, priority, assignee, labels and acceptance', () => {
  const { stdout } = run(['-w', 'orient-ws', '-b', 'or-plan.9']);
  assert.match(stdout, /status: in_progress/);
  assert.match(stdout, /priority: 1/);
  assert.match(stdout, /assignee: carol@example\.com/);
  assert.match(stdout, /agent-filed/);
  assert.match(stdout, /It works\./);
});

check('the thread is printed', () => {
  const { stdout } = run(['-w', 'orient-ws', '-b', 'or-plan.9']);
  assert.match(stdout, /Thread \(1 comment\)/);
  assert.match(stdout, /A comment on the thread\./);
});

check('the family lists the true tracker parent and both siblings, with status and holder', () => {
  const { stdout } = run(['-w', 'orient-ws', '-b', 'or-plan.9']);
  assert.match(stdout, /parent or-epic/);
  assert.match(stdout, /or-epic\.1\s+\[closed\s*,\s*alice@example\.com\]/);
  assert.match(stdout, /or-epic\.2\s+\[open\s*,\s*unassigned\]/);
  assert.doesNotMatch(stdout, /or-plan\.9\s+\[/, 'the bead itself must not appear in its own sibling list');
});

check('the plan group is found on the dotted-prefix ancestor, not the tracker parent — this is the bc-zjab.9 case', () => {
  const { stdout } = run(['-w', 'orient-ws', '-b', 'or-plan.9']);
  assert.match(stdout, /or-plan's plan names this bead in group "orient-group"/);
  assert.match(stdout, /orient-ws — Ship b7e-orient/);
  assert.match(stdout, /Do the one thing this group is for\./);
});

check('the debriefs section shows this bead\'s own report and its sibling\'s, and not the unrelated bead\'s', () => {
  const { stdout } = run(['-w', 'orient-ws', '-b', 'or-plan.9']);
  assert.match(stdout, /own prior run left this note/);
  assert.match(stdout, /sibling under the same parent left this note/);
  assert.doesNotMatch(stdout, /must never show up here/);
});

check('a bead with no tracker parent gets no family, no plan, and the debrief caveat rather than a false "nothing"', () => {
  const { status, stdout } = run(['-w', 'orient-ws', '-b', 'or-root']);
  assert.equal(status, 0);
  assert.match(stdout, /no tracker parent/);
  assert.match(stdout, /no tracker parent and no dotted id prefix/);
  assert.match(stdout, /only ITS OWN prior runs are covered here/);
});

check('--json carries the same facts in a machine-readable shape', () => {
  const { status, stdout } = run(['-w', 'orient-ws', '-b', 'or-plan.9', '--json']);
  assert.equal(status, 0);
  const d = JSON.parse(stdout);
  assert.equal(d.bead.id, 'or-plan.9');
  assert.equal(d.family.parent, 'or-epic');
  assert.deepEqual(
    d.family.siblings.map((s) => s.id).sort(),
    ['or-epic.1', 'or-epic.2']
  );
  assert.equal(d.plan.epic, 'or-plan');
  assert.equal(d.plan.group.name, 'orient-group');
  assert.ok(d.debriefs.family.includes('or-plan.9'));
  assert.ok(d.debriefs.family.includes('or-epic.1'));
  assert.ok(!d.debriefs.family.includes('zz-999'));
});

check('one bd spawn per question — show, export and comments, not one per sibling', () => {
  fs.writeFileSync(CALLS, '');
  run(['-w', 'orient-ws', '-b', 'or-plan.9']);
  const calls = fs
    .readFileSync(CALLS, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).args[0]);
  // show (bead), export (family), comments (parent, empty), comments (dotted prefix,
  // which is where the plan actually is) — four spawns, none of them per-sibling.
  assert.deepEqual(calls, ['show', 'export', 'comments', 'comments']);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
