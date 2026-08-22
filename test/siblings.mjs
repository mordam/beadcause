#!/usr/bin/env node
//
// b7e-siblings — which live worktrees are already changing the files a bead is about
// (bc-bmry.11).
//
//   npm test
//   node test/siblings.mjs
//
// Real worktrees, really edited — the same reason test/regions.mjs gives, and the same
// repo fixture shape (a `main` branch, one file with numbered lines): the whole assertion
// is about what `git worktree list`, `git diff` and `git log` actually report, and a stub
// would only prove the parser can read strings this file wrote.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-siblings');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-siblings-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { siblingsFor } = await import(path.join(ROOT, 'lib', 'siblings.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/* ---------------------------------------------------------------------- repo */

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const REPO = path.join(tmp, 'repo');
const FILE = 'lib/thing.js';
const OTHER = 'lib/other.js';
const line = (n) => `  const line${n} = ${n};`;

fs.mkdirSync(path.join(REPO, 'lib'), { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 'test@localhost');
git(REPO, 'config', 'user.name', 'test');

const BASE = Array.from({ length: 40 }, (_, i) => line(i + 1)).join('\n') + '\n';
fs.writeFileSync(path.join(REPO, FILE), BASE);
fs.writeFileSync(path.join(REPO, OTHER), BASE);
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'base');

/** A worktree, cut fresh from `main` and named `wt-<name>`. */
function tree(name) {
  const dir = path.join(tmp, name);
  git(REPO, 'worktree', 'add', '-q', '-b', `wt-${name}`, dir, 'main');
  return {
    dir,
    branch: `wt-${name}`,
    edit(file, from, to, text = 'CHANGED') {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      for (let n = from; n <= to; n += 1) lines[n - 1] = `  const line${n} = '${text}';`;
      fs.writeFileSync(path.join(dir, file), lines.join('\n'));
      return this;
    },
    commit(msg = 'work') {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', msg);
      return this;
    },
  };
}

/* --------------------------------------------------------------------- cases */

await check('a worktree that has touched the file is reported, with its ranges', async () => {
  const a = tree('alpha').edit(FILE, 4, 6).commit();
  const rows = await siblingsFor(REPO, [FILE]);
  const row = rows.find((r) => r.branch === a.branch);
  assert.ok(row, 'alpha is in the list');
  assert.equal(row.files.length, 1);
  assert.equal(row.files[0].file, FILE);
  assert.match(row.files[0].ranges, /4–6/);
  assert.equal(row.state, 'live');
});

await check('a worktree that has not touched the file is not reported', async () => {
  tree('bravo'); // exists, never edits the file
  const rows = await siblingsFor(REPO, [FILE]);
  assert.equal(
    rows.some((r) => r.branch === 'wt-bravo'),
    false
  );
});

await check('only the files actually touched appear on a row, not every file asked about', async () => {
  tree('charlie').edit(FILE, 10, 11).commit();
  const rows = await siblingsFor(REPO, [FILE, OTHER]);
  const row = rows.find((r) => r.branch === 'wt-charlie');
  assert.equal(row.files.length, 1, 'OTHER was never touched, so it is not on the row');
  assert.equal(row.files[0].file, FILE);
});

await check('uncommitted work counts — a session mid-edit is not idle', async () => {
  const d = tree('delta').edit(FILE, 20, 21); // deliberately not committed
  const rows = await siblingsFor(REPO, [FILE]);
  const row = rows.find((r) => r.branch === d.branch);
  assert.ok(row, 'uncommitted changes still show up');
  assert.match(row.files[0].ranges, /20–21/);
});

await check('the worktree you are asking from is never its own sibling', async () => {
  const e = tree('echo').edit(FILE, 1, 2).commit();
  const rows = await siblingsFor(e.dir, [FILE]);
  assert.equal(
    rows.some((r) => r.branch === e.branch),
    false,
    'asking from inside a worktree excludes that worktree itself'
  );
});

await check('the main checkout is never reported, even with a dirty working tree', async () => {
  const before = fs.readFileSync(path.join(REPO, FILE), 'utf8');
  fs.writeFileSync(path.join(REPO, FILE), before.replace('line1 = 1', "line1 = 'DIRTY'"));
  try {
    const rows = await siblingsFor(REPO, [FILE]);
    assert.equal(
      rows.some((r) => r.branch === 'main'),
      false
    );
  } finally {
    fs.writeFileSync(path.join(REPO, FILE), before);
  }
});

await check('commits ahead of main are named, filtered to ones touching the asked files', async () => {
  const f = tree('foxtrot');
  f.edit(OTHER, 1, 1).commit('touches other.js only'); // should not count
  f.edit(FILE, 30, 31).commit('touches thing.js');
  const rows = await siblingsFor(REPO, [FILE]);
  const row = rows.find((r) => r.branch === f.branch);
  assert.equal(row.commits.length, 1, 'only the commit that actually touched FILE is named');
  assert.match(row.commits[0].subject, /touches thing\.js/);
});

await check('more commits than the cap says how many were left out', async () => {
  const g = tree('golf');
  for (let i = 0; i < 7; i += 1) g.edit(FILE, 35, 35, `v${i}`).commit(`rev ${i}`);
  const rows = await siblingsFor(REPO, [FILE]);
  const row = rows.find((r) => r.branch === g.branch);
  assert.equal(row.commits.length, 5, 'capped');
  assert.equal(row.commitsOverflow, 2, 'and the cap says what it dropped, not silence');
});

await check('a pruned worktree — directory gone, branch not — is still found, and labelled', async () => {
  const h = tree('hotel').edit(FILE, 15, 16).commit();
  fs.rmSync(h.dir, { recursive: true, force: true }); // `rm -rf`, not `git worktree remove`
  const rows = await siblingsFor(REPO, [FILE]);
  const row = rows.find((r) => r.branch === h.branch);
  assert.ok(row, 'the branch still answers even though the directory is gone');
  assert.equal(row.state, 'pruned');
  assert.match(row.files[0].ranges, /15–16/);
});

await check('a locked worktree with no live session in it is locked but not lockLive', async () => {
  const i = tree('india').edit(FILE, 8, 9).commit();
  git(REPO, 'worktree', 'lock', i.dir, '--reason', 'resolver pid 999999');
  const rows = await siblingsFor(REPO, [FILE], { cfg: { claudeSessionsDir: path.join(tmp, 'no-sessions-here') } });
  const row = rows.find((r) => r.branch === i.branch);
  assert.equal(row.locked, true);
  assert.equal(row.lockLive, false);
  assert.equal(row.session, null);
  assert.equal(row.bead, null);
});

await check('a live session in the worktree resolves its bead, pid and status', async () => {
  const j = tree('juliett').edit(FILE, 2, 3).commit();
  const sessionsDir = path.join(tmp, 'sessions-juliett');
  fs.mkdirSync(sessionsDir, { recursive: true });
  // This process's own pid, which is the only one a test can be sure is alive — liveness
  // is checked with signal 0, so a made-up number is filtered out before this ever sees it.
  fs.writeFileSync(
    path.join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Beadcause - bc-bmry.11 b7e-siblings', cwd: j.dir, status: 'busy' })
  );
  const rows = await siblingsFor(REPO, [FILE], { cfg: { claudeSessionsDir: sessionsDir } });
  const row = rows.find((r) => r.branch === j.branch);
  assert.equal(row.bead, 'bc-bmry.11');
  assert.equal(row.session.pid, process.pid);
  assert.equal(row.session.status, 'busy');
});

await check('no files asked about is nothing to answer, not an error', async () => {
  assert.deepEqual(await siblingsFor(REPO, []), []);
  assert.deepEqual(await siblingsFor(REPO, [null, '', '  ']), []);
});

await check('a directory git cannot answer for yields no rows, not a crash', async () => {
  const nowhere = path.join(tmp, 'not-a-repo-at-all');
  fs.mkdirSync(nowhere, { recursive: true });
  assert.deepEqual(await siblingsFor(nowhere, [FILE]), []);
});

/* --------------------------------------------------------------------- CLI */

await check('CLI: prints branch, ranges, and exits 0 for a real collision', async () => {
  const k = tree('kilo').edit(FILE, 12, 13).commit();
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, FILE], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, new RegExp(k.branch));
  assert.match(run.stdout, /12–13/);
});

await check('CLI: --json prints one parseable object per row', async () => {
  const l = tree('lima').edit(FILE, 17, 17).commit();
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--json', FILE], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  const rows = run.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line_) => JSON.parse(line_));
  assert.ok(rows.some((r) => r.branch === l.branch));
});

await check('CLI: a path nothing holds prints nothing and exits 0', async () => {
  fs.writeFileSync(path.join(REPO, 'lib/untouched.js'), 'export const z = 1;\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-qm', 'add untouched');
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, 'lib/untouched.js'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), '');
});

await check('CLI: neither --bead nor a path is a usage error, exit 2', async () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /nothing to check/);
});

await check('CLI: --bead and a path together is a usage error, exit 2', async () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--bead', 'bc-1', FILE], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /two ways of saying the same thing/);
});

await check('CLI: an unrecognised flag refuses rather than silently ignoring it', async () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--nope', FILE], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unrecognised flag/);
});

/* ---------------------------------------------------------------- --bead mode */

await check('CLI: --bead reads the files off a fake tracker and finds the same collision', async () => {
  const m = tree('mike').edit(FILE, 25, 26).commit();

  const fakeBd = path.join(tmp, 'bd');
  fs.writeFileSync(
    fakeBd,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'show') {
  process.stdout.write(JSON.stringify([{ id: args[1], description: '\`\`\`beadfiles\\n${FILE}\\n\`\`\`' }]));
  process.exit(0);
}
process.stdout.write('[]');
`,
    { mode: 0o755 }
  );

  const wsDir = path.join(tmp, 'bead-ws', '.beads');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
    JSON.stringify({ bdBin: fakeBd, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }] }, null, 2)
  );

  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--bead', 'bc-fake', '-w', 'demo'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(m.branch));
  fs.rmSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'));
});

await check('CLI: --bead against a workspace with no such id exits 4', async () => {
  const fakeBd = path.join(tmp, 'bd-empty');
  fs.writeFileSync(fakeBd, `#!/usr/bin/env node\nprocess.stdout.write('[]');\n`, { mode: 0o755 });
  const wsDir = path.join(tmp, 'bead-ws-empty', '.beads');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
    JSON.stringify({ bdBin: fakeBd, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }] }, null, 2)
  );
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--bead', 'bc-nope', '-w', 'demo'], { encoding: 'utf8' });
  assert.equal(run.status, 4);
  assert.match(run.stderr, /has no bead bc-nope/);
  fs.rmSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'));
});

/* -------------------------------------------------------------------- report */

cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} siblings checks passed`);
process.exit(failures ? 1 : 0);
