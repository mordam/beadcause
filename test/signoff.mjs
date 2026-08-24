#!/usr/bin/env node
//
// `b7e-signoff` — end a delivered run: the pull request, the debrief and the rename,
// in one call.
//
//   npm test
//   node test/signoff.mjs
//
// `bc-dgx7.44`: five sessions each ended a delivered run the same four steps, no two
// the same way — see `lib/signoff.js`'s own header for the roster and the two traps
// (`deliver.js` refusing to run from the main checkout; a shell resolving a backtick
// in prose meant as an argv token) that kept costing them time.
//
// Three parts. The first two need no subprocess and no fabricated tracker at all —
// `lib/signoff.js`'s exports are plain functions over plain data, and the sequencer
// is tested with fakes that only count their own calls. The third drives the real
// `bin/b7e-signoff` against a fabricated repo (a real bare origin, a real `git
// worktree add` under `.claude/worktrees/`, matching `bin/deliver.js`'s own
// requirements) and a fabricated tracker (`bd` and `gh` as executable fakes on
// `PATH`, in the shape `test/approval.mjs` already proved out for `bin/deliver.js`
// itself), plus a fake `~/.claude/rename-session.sh` this suite points `--rename-script`
// at rather than the real one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-signoff');

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${String(detail).split('\n').slice(0, 8).join('\n      ')}`);
};
const check = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ============================================================= part 1: pure functions */

console.log('\nlib/signoff.js — pure functions\n');

const { chooseWorktree, queuedTitle, fallbackTitle, markerLine, parseDeliverOutcome, ownedMarkerFor, runSteps } = await import(
  '../lib/signoff.js'
);

const wt = (p, branch) => ({ path: p, branch, locked: false, detached: false });

await check('a unique branch owning the bead tag is chosen', () => {
  const entries = [wt('/main/.claude/worktrees/other-9k', 'worktree-other-9k'), wt('/main/.claude/worktrees/mine-dgx744', 'worktree-mine-dgx744')];
  const r = chooseWorktree(entries, 'bc-dgx7.44', { main: '/main' });
  assert.equal(r.dir, '/main/.claude/worktrees/mine-dgx744');
  assert.equal(r.matched, 'unique');
});

await check('an epic and its child never collide — bc-nib3 does not own bc-nib3.5\'s branch, and the reverse', () => {
  const entries = [wt('/main/.claude/worktrees/child', 'worktree-child-nib35')];
  assert.throws(() => chooseWorktree(entries, 'bc-nib3', { main: '/main' }), /no live worktree claims bc-nib3 /);
  const entries2 = [wt('/main/.claude/worktrees/parent', 'worktree-parent-nib3')];
  assert.throws(() => chooseWorktree(entries2, 'bc-nib3.5', { main: '/main' }), /no live worktree claims bc-nib3\.5 /);
});

await check('zero matches names the pattern it looked for, not deliver.js\'s own refusal', () => {
  assert.throws(
    () => chooseWorktree([], 'bc-dgx7.44', { main: '/main' }),
    /no live worktree claims bc-dgx7\.44 — looked under \/main\/\.claude\/worktrees for a branch ending "-dgx744"/
  );
});

await check('more than one match is ambiguous, and names both, when cwd does not resolve it', () => {
  const entries = [wt('/main/.claude/worktrees/a', 'worktree-a-dgx744'), wt('/main/.claude/worktrees/b', 'worktree-b-dgx744')];
  assert.throws(() => chooseWorktree(entries, 'bc-dgx7.44', { main: '/main' }), /2 live worktrees claim bc-dgx7\.44/);
});

await check('cwd picks among several candidates rather than refusing', () => {
  const entries = [wt('/main/.claude/worktrees/a', 'worktree-a-dgx744'), wt('/main/.claude/worktrees/b', 'worktree-b-dgx744')];
  const r = chooseWorktree(entries, 'bc-dgx7.44', { main: '/main', cwd: '/main/.claude/worktrees/b' });
  assert.equal(r.dir, '/main/.claude/worktrees/b');
  assert.equal(r.matched, 'cwd');
});

await check('queuedTitle prepends QUEUED- and nothing else', () => {
  assert.equal(queuedTitle('Beadcause - bc-dgx7.44 signoff'), 'QUEUED-Beadcause - bc-dgx7.44 signoff');
});
await check('queuedTitle is idempotent over an already-finished name, case-insensitively', () => {
  assert.equal(queuedTitle('QUEUED-Beadcause - x'), null);
  assert.equal(queuedTitle('queued-beadcause - x'), null);
  assert.equal(queuedTitle('DONE-Beadcause - x'), null);
  assert.equal(queuedTitle('  '), null);
  assert.equal(queuedTitle(''), null);
});

await check('fallbackTitle is the bead\'s own title, untruncated', () => {
  const long = 'b7e-signoff — End a delivered run — the pull request, the debrief and the rename, in one call';
  assert.equal(fallbackTitle('bc-dgx7.44', long), `QUEUED-Beadcause - bc-dgx7.44 ${long}`);
  assert.equal(fallbackTitle('bc-dgx7.44', ''), 'QUEUED-Beadcause - bc-dgx7.44');
});

await check('markerLine names what is owed, or says CLOSED', () => {
  assert.equal(markerLine([]), '** BEAD WORK DONE ** CAN BE CLOSED **');
  assert.equal(markerLine(['DEPLOYED', 'REBUILT']), '** BEAD WORK DONE ** CAN BE DEPLOYED, REBUILT **');
  assert.equal(markerLine(['  ', 'REVIEWED', '']), '** BEAD WORK DONE ** CAN BE REVIEWED **');
});

await check('parseDeliverOutcome reads all three of deliver.js\'s own endings', () => {
  assert.deepEqual(parseDeliverOutcome('beadcause-deliver: closed …\nqueued #587 https://x/pull/587 cl-abc\n'), {
    outcome: 'queued',
    pr: '#587',
    url: 'https://x/pull/587',
    mergeBead: 'cl-abc',
    line: 'queued #587 https://x/pull/587 cl-abc',
  });
  assert.deepEqual(parseDeliverOutcome('landed #42 https://x/pull/42 a1b2c3d4\n'), {
    outcome: 'landed',
    pr: '#42',
    url: 'https://x/pull/42',
    sha: 'a1b2c3d4',
    line: 'landed #42 https://x/pull/42 a1b2c3d4',
  });
  assert.equal(parseDeliverOutcome('landed #42 https://x/pull/42\n').sha, '');
  assert.deepEqual(parseDeliverOutcome('cl-xyz https://x/pull/9\n'), {
    outcome: 'asked',
    questionId: 'cl-xyz',
    url: 'https://x/pull/9',
    line: 'cl-xyz https://x/pull/9',
  });
});

await check('ownedMarkerFor leaves a merge alone', () => {
  assert.deepEqual(ownedMarkerFor('queued', ['DEPLOYED']), { owed: ['DEPLOYED'], overridden: false });
  assert.deepEqual(ownedMarkerFor('landed', []), { owed: [], overridden: false });
});
await check('ownedMarkerFor overrides a question card to REVIEWED — nothing after a merge can be owed by work that has not merged', () => {
  assert.deepEqual(ownedMarkerFor('asked', []), { owed: ['REVIEWED'], overridden: true });
  assert.deepEqual(ownedMarkerFor('asked', ['DEPLOYED']), { owed: ['REVIEWED'], overridden: true });
  assert.deepEqual(ownedMarkerFor('asked', ['REVIEWED']), { owed: ['REVIEWED'], overridden: false });
});

/* ================================================================ part 2: the sequencer */

console.log('\nlib/signoff.js#runSteps — stops without touching what comes after\n');

await check('every step runs, in order, when nothing throws', async () => {
  const seen = [];
  const { results, failedAt } = await runSteps([
    { name: 'a', run: async () => (seen.push('a'), 1) },
    { name: 'b', run: async () => (seen.push('b'), 2) },
    { name: 'c', run: async () => (seen.push('c'), 3) },
  ]);
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(failedAt, null);
  assert.deepEqual(
    results.map((r) => [r.name, r.ok, r.value]),
    [
      ['a', true, 1],
      ['b', true, 2],
      ['c', true, 3],
    ]
  );
});

await check('a step that throws stops the sequence — the later ones are never called at all', async () => {
  let cCalls = 0;
  const { results, failedAt } = await runSteps([
    { name: 'deliver', run: async () => 'ok' },
    { name: 'debrief', run: async () => { throw new Error('the tracker refused it'); } },
    { name: 'rename', run: async () => { cCalls += 1; return 'never'; } },
    { name: 'marker', run: async () => { cCalls += 1; return 'never'; } },
  ]);
  assert.equal(failedAt, 'debrief');
  assert.equal(cCalls, 0, 'rename and marker must never run once debrief has thrown');
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /the tracker refused it/);
});

/* ======================================================== part 3: the real CLI, fabricated */

console.log('\nbin/b7e-signoff — the real CLI, against a fabricated repo and tracker\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-signoff-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

/* --------------------------------------------------------------------- the fake bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const WORLD = ${JSON.stringify(WORLD)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const die = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const hydrate = (issue) => ({ ...issue, dependencies: (issue.dependencies || []).map((d) => ({ ...d, status: (w.issues[d.id] || {}).status || 'closed' })) });

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([hydrate(issue)]));
  process.exit(0);
}
if (args[0] === 'list') {
  const label = flag('--label');
  const rows = Object.values(w.issues).filter((i) => (label ? (i.labels || []).includes(label) : true)).filter((i) => i.status !== 'closed').map(hydrate);
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'create') {
  const id = 'zz-' + (w.seq = (w.seq || 0) + 1);
  w.issues[id] = { id, title: flag('--title') || '', description: flag('--description') || '', labels: [], status: 'open', issue_type: flag('--type') || 'task', dependencies: [] };
  save();
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'close') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  issue.status = 'closed';
  issue.close_reason = flag('--reason') || '';
  save();
  process.stdout.write('closed\\n');
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (issue.comments = issue.comments || []).push(args[2]);
  save();
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'add') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.dependencies = issue.dependencies || [];
  if (!issue.dependencies.some((d) => d.id === args[3])) issue.dependencies.push({ id: args[3], dependency_type: 'blocks' });
  save();
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'remove') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.dependencies = (issue.dependencies || []).filter((d) => d.id !== args[3]);
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/* --------------------------------------------------------------------- the fake gh */

const GH_BIN = path.join(tmp, 'ghbin');
fs.mkdirSync(GH_BIN, { recursive: true });
const GH_STATE = path.join(tmp, 'gh.json');
const GH_LOG = path.join(tmp, 'gh-calls.log');
fs.writeFileSync(GH_STATE, JSON.stringify({ next: 40, prs: {} }));
const ghCalls = () =>
  fs
    .readFileSync(GH_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

fs.writeFileSync(
  path.join(GH_BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const STATE = ${JSON.stringify(GH_STATE)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + '\\n');
const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = () => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const out = (t) => { process.stdout.write(t); process.exit(0); };
const fail = (t) => { process.stderr.write(t + '\\n'); process.exit(1); };
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const find = (ref) => Object.values(s.prs).find((p) => p.headRefName === ref || String(p.number) === String(ref));

if (args[0] === 'auth') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/widgets' }));
if (args[0] === 'pr') {
  if (args[1] === 'create') {
    const head = flag('--head');
    const number = s.next++;
    s.prs[head] = {
      number, title: flag('--title') || '', url: 'https://github.com/acme/widgets/pull/' + number,
      state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefName: head,
      baseRefName: flag('--base') || 'main', additions: 3, deletions: 1, changedFiles: 1,
      statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }], reviewDecision: null, mergedAt: null, mergeCommit: null,
    };
    save();
    out(s.prs[head].url + '\\n');
  }
  const pr = find(args[2]);
  if (args[1] === 'view') { if (!pr) fail('no pull requests found for branch ' + args[2]); out(JSON.stringify(pr)); }
  if (args[1] === 'comment') out('commented\\n');
}
if (args[0] === 'label' || args[0] === 'issue') out('[]');
fail('unknown gh invocation: ' + args.join(' '));
`,
  { mode: 0o755 }
);

/* ------------------------------------------------------------------- the real repo */

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e' },
  }).trim();

const origin = path.join(tmp, 'origin.git');
const main = path.join(tmp, 'main');
git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
git(tmp, 'clone', '--quiet', origin, main);
git(main, 'config', 'user.email', 't@e');
git(main, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(main, 'file.txt'), 'one\n');
git(main, 'add', 'file.txt');
git(main, 'commit', '--quiet', '-m', 'one');
git(main, 'push', '--quiet', '-u', 'origin', 'main');

const { tagOf } = await import('../lib/notinmain.js');

/** A real `git worktree add` under `.claude/worktrees/`, with one commit ahead of main. */
function makeWorktree(beadId, slug) {
  const tag = tagOf(beadId);
  const branch = `worktree-${slug}-${tag}`;
  const dir = path.join(main, '.claude', 'worktrees', `${slug}-${tag}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(main, 'worktree', 'add', '-q', '-b', branch, dir, 'main');
  fs.writeFileSync(path.join(dir, `${slug}.txt`), `${slug}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', slug);
  return { dir, branch };
}

/* -------------------------------------------------------------------- fake renames */

function fakeRenameScript(name, { title = null } = {}) {
  const script = path.join(tmp, name);
  const state = path.join(tmp, `${name}.state.json`);
  if (title) fs.writeFileSync(state, JSON.stringify({ title }));
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('fs');
const STATE = ${JSON.stringify(state)};
const args = process.argv.slice(2);
let state;
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { state = null; }
if (args[0] === '--show') {
  if (!state) { process.stderr.write('rename-session: could not locate this session\\n'); process.exit(1); }
  process.stdout.write('sid123\\n  title:      ' + state.title + '\\n  from:       custom-title\\n  transcript: /tmp/x.jsonl\\n');
  process.exit(0);
}
state = { title: args[0] };
fs.writeFileSync(STATE, JSON.stringify(state));
process.stdout.write('renamed: ' + args[0] + '  (sessions/123.json, /resume)\\n');
process.exit(0);
`,
    { mode: 0o755 }
  );
  return { script, readState: () => JSON.parse(fs.readFileSync(state, 'utf8')) };
}

function brokenRenameScript(name) {
  const script = path.join(tmp, name);
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
process.stderr.write('rename-session: this window is gone\\n');
process.exit(1);
`,
    { mode: 0o755 }
  );
  return script;
}

/* ------------------------------------------------------------------------- config */

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({
    port: 4318,
    host: '127.0.0.1',
    baseUrl: 'http://127.0.0.1:4318',
    token: 'signoff-test',
    actor: 'beadcause-test',
    bdBin: FAKE_BD,
    workspaces: [{ name: 'demo', dir: wsDir }],
    openSessions: false,
    claudeSessions: false,
    ntfy: { enabled: false },
    advocates: { enabled: false, workspaces: [] },
  })
);

const resetLogs = () => {
  fs.writeFileSync(BD_LOG, '');
  fs.writeFileSync(GH_LOG, '');
};
const seedBead = (id, title) => {
  const w = fs.existsSync(WORLD) ? world() : { seq: 100, issues: {} };
  w.issues[id] = { id, title, description: '', labels: [], status: 'in_progress', issue_type: 'task', dependencies: [] };
  fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
};

const { stagedDebrief } = await import('../lib/memory.js');

/** Write text to a file with plain fs — never through a shell, which is the whole point. */
const writeField = (name, text) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
};

/** Run the real CLI. `cwd` defaults to the main checkout, so resolution is exercised. */
function signoff(args, { cwd = main } = {}) {
  const res = spawnSync(process.execPath, [BIN, '-w', 'demo', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BEADCAUSE_CONFIG_DIR: CONFIG_DIR, PATH: `${GH_BIN}${path.delimiter}${process.env.PATH}` },
  });
  if (res.error) throw res.error;
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
}

const lines = (out) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/* --------------------------------------------------------- scenario A: happy path */

seedBead('demo-7.3', 'The work');
seedBead('demo-8.4', 'The work');
seedBead('demo-9.9', 'No worktree for this one');
seedBead('demo-11.2', 'The work');

await check('resolves the bead\'s own worktree from the main checkout, delivers, debriefs, renames and marks', async () => {
  const { branch } = makeWorktree('demo-7.3', 'happy');
  resetLogs();
  const rename = fakeRenameScript('rename-a', { title: 'Beadcause - demo-7.3 doing work' });

  const TRICKY = ['Ran `git checkout foo` and $(echo hi) then kept going.', 'EOF', 'More `backticks`, $(rm -rf /nope), and a heredocish line.'].join(
    '\n'
  );
  const summary = writeField('summary-a.md', 'What changed and why — automated test summary.\n');
  const debriefFile = writeField('debrief-a.md', TRICKY);

  const { status, out, err } = signoff([
    '-b',
    'demo-7.3',
    '--summary',
    summary,
    '--debrief',
    debriefFile,
    '--marker',
    'DEPLOYED',
    '--rename-script',
    rename.script,
  ]);

  assert.equal(status, 0, err);
  const ls = lines(out);
  assert.equal(ls.length, 4, `expected 4 output lines, got:\n${out}`);
  assert.match(ls[0], /^queued #\d+ https:\/\/\S+ zz-\d+$/);
  assert.match(ls[1], /^debriefed demo-7\.3 \(\d+ this run\) in \S+ — \d+ bytes$/);
  assert.equal(ls[2], 'renamed QUEUED-Beadcause - demo-7.3 doing work');
  assert.equal(ls[3], '** BEAD WORK DONE ** CAN BE DEPLOYED **');

  // delivered against the WORKTREE's branch, never against main
  const calls = ghCalls();
  const created = calls.find((c) => c[0] === 'pr' && c[1] === 'create');
  assert.ok(created, 'gh pr create was never called');
  const head = created[created.indexOf('--head') + 1];
  assert.equal(head, branch);
  assert.ok(!err.includes('refusing to open a PR from main into main'));

  // the debrief landed byte-identical, backticks and heredoc terminator included
  const staged = await stagedDebrief(main, 'demo-7.3');
  assert.equal(staged.entries.length, 1);
  assert.equal(staged.entries[0].text, TRICKY.trim());

  // the rename actually wrote QUEUED- in front, and nothing else
  assert.equal(rename.readState().title, 'QUEUED-Beadcause - demo-7.3 doing work');
});

/* -------------------------------------------------- scenario C: no worktree at all */

await check('no live worktree claims the bead — refuses before deliver.js ever runs, names the pattern', () => {
  resetLogs();
  const rename = fakeRenameScript('rename-c', { title: 'Beadcause - demo-9.9' });
  const summary = writeField('summary-c.md', 'irrelevant — never reached\n');
  const debriefFile = writeField('debrief-c.md', 'irrelevant — never reached\n');

  const { status, err } = signoff([
    '-b',
    'demo-9.9',
    '--summary',
    summary,
    '--debrief',
    debriefFile,
    '--rename-script',
    rename.script,
  ]);

  assert.equal(status, 5);
  assert.match(err, /no live worktree claims demo-9\.9 — looked under .*\.claude\/worktrees for a branch ending "-99"/);
  assert.ok(!err.includes('refusing to open a PR from main into main'), 'deliver.js\'s own refusal must never fire here');
  assert.equal(ghCalls().filter((c) => c[0] === 'pr' && c[1] === 'create').length, 0, 'deliver.js must never have been reached at all');
});

/* --------------------------------------------- scenario D: a mid-sequence failure */

await check('a mid-sequence failure (rename) leaves the marker step undone, and names which step stopped it', async () => {
  makeWorktree('demo-8.4', 'mid');
  resetLogs();
  const broken = brokenRenameScript('rename-d');
  const summary = writeField('summary-d.md', 'What changed and why.\n');
  const debriefFile = writeField('debrief-d.md', 'A clean report, no shell hazards in this one.\n');

  const { status, out, err } = signoff([
    '-b',
    'demo-8.4',
    '--summary',
    summary,
    '--debrief',
    debriefFile,
    '--rename-script',
    broken,
  ]);

  assert.equal(status, 6);
  assert.match(err, /rename failed/);
  const ls = lines(out);
  // deliver and debrief both ran and printed their lines...
  assert.ok(ls.some((l) => /^queued #\d+/.test(l)), `deliver's own line missing:\n${out}`);
  assert.ok(ls.some((l) => l.startsWith('debriefed demo-8.4')), `debrief's own line missing:\n${out}`);
  // ...but the marker — the step after the one that failed — never printed at all.
  assert.ok(!out.includes('BEAD WORK DONE'), `the marker must not print once rename has failed:\n${out}`);

  // and the debrief really did land — a re-run resumes rather than losing it
  const staged = await stagedDebrief(main, 'demo-8.4');
  assert.equal(staged.entries.length, 1);
});

/* -------------------------------------------- scenario E: a question card, not a merge */

await check('a --review delivery ends in a question card, and the marker is forced to REVIEWED even if asked for something else', async () => {
  makeWorktree('demo-11.2', 'asked');
  resetLogs();
  const rename = fakeRenameScript('rename-e', { title: 'Beadcause - demo-11.2 doing work' });
  const summary = writeField('summary-e.md', 'What changed and why.\n');
  const debriefFile = writeField('debrief-e.md', 'A clean report.\n');

  const { status, out, err } = signoff([
    '-b',
    'demo-11.2',
    '--summary',
    summary,
    '--debrief',
    debriefFile,
    '--review',
    '--marker',
    'DEPLOYED',
    '--rename-script',
    rename.script,
  ]);

  assert.equal(status, 0, err);
  const ls = lines(out);
  assert.match(ls[0], /^zz-\d+ https:\/\/\S+$/, 'a question card ending has no leading "queued"/"landed"');
  assert.match(err, /did not merge — the marker says REVIEWED, not "DEPLOYED"/);
  assert.equal(ls[ls.length - 1], '** BEAD WORK DONE ** CAN BE REVIEWED **');
});

/* --------------------------------------------------------------------- --dry runs nothing */

await check('--dry prints the plan and touches nothing', () => {
  resetLogs();
  const { status, out } = signoff(['-b', 'demo-7.3', '--dry']);
  assert.equal(status, 0);
  assert.match(out, /--dry — demo-7\.3 in demo/);
  assert.match(out, /1\. deliver/);
  assert.match(out, /2\. debrief/);
  assert.match(out, /3\. rename/);
  assert.match(out, /4\. marker/);
  assert.equal(ghCalls().length, 0, '--dry must not touch gh at all');
  assert.equal(fs.readFileSync(BD_LOG, 'utf8').includes('"create"'), false, '--dry must not create anything on the tracker');
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
