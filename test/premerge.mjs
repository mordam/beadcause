#!/usr/bin/env node
//
// b7e-premerge — will this branch and a sibling editing the same file actually merge
// (bc-dgx7.52).
//
//   npm test
//   node test/premerge.mjs
//
// Real git repos, really merged with `git merge-tree --write-tree` — the same reason
// test/siblings.mjs and test/regions.mjs give: the whole assertion is about what git
// actually reports for two branches that touch the same lines, and a stub would only
// prove the parser can read strings this file wrote.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-premerge');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-premerge-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { premergeAgainst, resolveRef, currentRef, ownChangedFiles, discoverCounterparties, materializeTree } = await import(
  path.join(ROOT, 'lib', 'premerge.js')
);

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

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A fresh repo, `main` at one commit with `README.md` five lines ending `ANCHOR`. */
function freshRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@localhost');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'line1\nline2\nline3\nANCHOR\nline5\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A snapshot of every tracked+untracked file's bytes, to prove a call touched nothing. */
function snapshot(dir) {
  const status = git(dir, 'status', '--porcelain');
  const files = git(dir, 'ls-files').split('\n').filter(Boolean);
  const bytes = {};
  for (const f of files) bytes[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return { status, bytes, branch: git(dir, 'branch', '--show-current') };
}
function assertUntouched(before, dir, label) {
  const after = snapshot(dir);
  assert.deepEqual(after, before, `${label}: caller's worktree changed`);
}

/* --------------------------------------------------------------------- cases */

await check('lib: two branches conflicting at the same anchor are reported, with the hunk range', async () => {
  const dir = freshRepo('conflict');
  git(dir, 'checkout', '-qb', 'branchA');
  fs.writeFileSync(path.join(dir, 'README.md'), 'line1\nline2\nline3\nANCHOR\nfromA\nline5\n');
  git(dir, 'commit', '-qam', 'A adds fromA');
  git(dir, 'checkout', '-qb', 'branchB', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'line1\nline2\nline3\nANCHOR\nfromB\nline5\n');
  git(dir, 'commit', '-qam', 'B adds fromB');
  git(dir, 'checkout', '-q', 'branchA');

  const before = snapshot(dir);
  const block = await premergeAgainst(dir, 'branchA', 'branchB');
  assertUntouched(before, dir, 'conflicted premerge');

  assert.equal(block.ok, true);
  assert.equal(block.clean, false);
  assert.equal(block.conflicts.length, 1);
  assert.equal(block.conflicts[0].file, 'README.md');
  assert.ok(block.conflicts[0].hunks, 'a textual conflict has hunks');
  assert.match(block.conflicts[0].hunks[0].range, /^5–9$/);
});

await check('lib: two branches adding separate files merge clean', async () => {
  const dir = freshRepo('clean');
  git(dir, 'checkout', '-qb', 'branchC');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'C adds c.txt');
  git(dir, 'checkout', '-qb', 'branchD', 'main');
  fs.writeFileSync(path.join(dir, 'd.txt'), 'd\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'D adds d.txt');
  git(dir, 'checkout', '-q', 'branchC');

  const before = snapshot(dir);
  const block = await premergeAgainst(dir, 'branchC', 'branchD');
  assertUntouched(before, dir, 'clean premerge');

  assert.equal(block.ok, true);
  assert.equal(block.clean, true);
  assert.ok(/^[0-9a-f]{40}$/.test(block.treeOid));
});

await check('lib: a ref that cannot be resolved at all is an error block, not a thrown exception', async () => {
  const dir = freshRepo('badref');
  const before = snapshot(dir);
  const block = await premergeAgainst(dir, 'main', 'not-a-real-branch');
  assertUntouched(before, dir, 'unresolvable ref');
  assert.equal(block.ok, false);
  assert.match(block.error, /not.*merge|unknown|not.*resolve/i);
});

await check('lib: a delete/modify conflict is still named, even with no textual markers', async () => {
  const dir = freshRepo('deletemod');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'add a.txt');
  git(dir, 'checkout', '-qb', 'branchE');
  fs.rmSync(path.join(dir, 'a.txt'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'E deletes a.txt');
  git(dir, 'checkout', '-qb', 'branchF', 'main');
  fs.appendFileSync(path.join(dir, 'a.txt'), 'changed\n');
  git(dir, 'commit', '-qam', 'F modifies a.txt');
  git(dir, 'checkout', '-q', 'branchE');

  const block = await premergeAgainst(dir, 'branchE', 'branchF');
  assert.equal(block.clean, false);
  assert.equal(block.conflicts.length, 1);
  assert.equal(block.conflicts[0].file, 'a.txt');
  assert.equal(block.conflicts[0].hunks, null, 'no markers — a structural conflict');
  assert.ok(block.messages.some((m) => /modify\/delete/.test(m)));
});

/* -------------------------------------------------------------------- --tree */

await check('--tree materialises the merged content under os.tmpdir(), node_modules symlinked in', async () => {
  const dir = freshRepo('tree1');
  // Untracked, on purpose: node_modules must never be *committed* into the merge-tree —
  // this proves the tool borrows it from the caller's checkout rather than expecting git
  // to have carried it along.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'ignore node_modules');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'marker.txt'), 'from the source checkout\n');
  git(dir, 'checkout', '-qb', 'branchG');
  fs.writeFileSync(path.join(dir, 'g.txt'), 'g\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'G adds g.txt');
  git(dir, 'checkout', '-qb', 'branchH', 'main');
  fs.writeFileSync(path.join(dir, 'h.txt'), 'h\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'H adds h.txt');
  git(dir, 'checkout', '-q', 'branchG');

  const block = await premergeAgainst(dir, 'branchG', 'branchH', { tree: true });
  assert.ok(block.treeDir.startsWith(fs.realpathSync(os.tmpdir())));
  assert.equal(fs.readFileSync(path.join(block.treeDir, 'g.txt'), 'utf8'), 'g\n');
  assert.equal(fs.readFileSync(path.join(block.treeDir, 'h.txt'), 'utf8'), 'h\n');
  assert.ok(fs.lstatSync(path.join(block.treeDir, 'node_modules')).isSymbolicLink());
  assert.equal(
    fs.readFileSync(path.join(block.treeDir, 'node_modules', 'marker.txt'), 'utf8'),
    'from the source checkout\n'
  );

  // A trivial suite actually runs green in the materialised tree, unmodified.
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(
    path.join(dir, 'test', 'tiny.mjs'),
    "import assert from 'node:assert/strict';\nassert.equal(1 + 1, 2);\nconsole.log('  ok   arithmetic');\nprocess.exit(0);\n"
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'add a tiny suite');
  const block2 = await premergeAgainst(dir, 'branchG', 'branchH', { tree: true });
  const run = spawnSync(process.execPath, [path.join(block2.treeDir, 'test', 'tiny.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ok\s+arithmetic/);
});

await check('--tree for the same pair replaces rather than accumulates', async () => {
  const dir = freshRepo('tree2');
  git(dir, 'checkout', '-qb', 'branchI');
  fs.writeFileSync(path.join(dir, 'i.txt'), 'i\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'I adds i.txt');
  git(dir, 'checkout', '-qb', 'branchJ', 'main');
  fs.writeFileSync(path.join(dir, 'j.txt'), 'j\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'J adds j.txt');
  git(dir, 'checkout', '-q', 'branchI');

  const first = await premergeAgainst(dir, 'branchI', 'branchJ', { tree: true });
  fs.writeFileSync(path.join(first.treeDir, 'LEFTOVER'), 'should not survive\n');
  const second = await premergeAgainst(dir, 'branchI', 'branchJ', { tree: true });
  assert.equal(second.treeDir, first.treeDir, 'same pair, same directory');
  assert.equal(fs.existsSync(path.join(second.treeDir, 'LEFTOVER')), false, 'replaced, not merged with the old contents');
});

/* ---------------------------------------------------------------- resolveRef */

await check('resolveRef turns a worktree path into its branch name', async () => {
  const dir = freshRepo('resolveref');
  const wtDir = path.join(tmp, 'resolveref-wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'branchK', wtDir, 'main');
  assert.equal(await resolveRef(dir, wtDir), 'branchK');
});

await check('resolveRef passes through a plain branch name unchanged', async () => {
  const dir = freshRepo('resolveref2');
  assert.equal(await resolveRef(dir, 'main'), 'main');
});

/* --------------------------------------------------------------- currentRef */

await check('currentRef names the checked-out branch', async () => {
  const dir = freshRepo('currentref');
  git(dir, 'checkout', '-qb', 'branchL');
  assert.equal(await currentRef(dir), 'branchL');
});

await check('currentRef falls back to a short sha when detached', async () => {
  const dir = freshRepo('currentref2');
  git(dir, 'checkout', '-q', '--detach', 'main');
  const ref = await currentRef(dir);
  assert.notEqual(ref, 'HEAD');
  assert.ok(/^[0-9a-f]{4,}$/.test(ref));
});

/* ---------------------------------------------------------------- ownChangedFiles */

await check('ownChangedFiles names what this branch has changed since main, committed and uncommitted', async () => {
  const dir = freshRepo('ownfiles');
  git(dir, 'checkout', '-qb', 'branchM');
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'committed change');
  fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'y\n');
  const files = await ownChangedFiles(dir);
  assert.ok(files.includes('committed.txt'));
  assert.ok(files.includes('uncommitted.txt'));
});

/* ---------------------------------------------------------- discoverCounterparties */

await check('discoverCounterparties finds a sibling worktree touching the same file', async () => {
  const dir = freshRepo('discover');
  const wtDir = path.join(tmp, 'discover-wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'branchN', wtDir, 'main');
  fs.writeFileSync(path.join(wtDir, 'README.md'), 'line1\nline2\nline3\nANCHOR\nfromN\nline5\n');
  git(wtDir, 'commit', '-qam', 'N touches README.md');
  const branches = await discoverCounterparties(dir, ['README.md']);
  assert.ok(branches.includes('branchN'));
});

/* --------------------------------------------------------------------- CLI */

await check('CLI: reports a conflict and exits 1', async () => {
  const dir = freshRepo('cliconflict');
  git(dir, 'checkout', '-qb', 'branchO');
  fs.writeFileSync(path.join(dir, 'README.md'), 'line1\nline2\nline3\nANCHOR\nfromO\nline5\n');
  git(dir, 'commit', '-qam', 'O adds fromO');
  git(dir, 'checkout', '-qb', 'branchP', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'line1\nline2\nline3\nANCHOR\nfromP\nline5\n');
  git(dir, 'commit', '-qam', 'P adds fromP');
  git(dir, 'checkout', '-q', 'branchO');

  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--against', 'branchP'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /branchP/);
  assert.match(run.stdout, /README\.md/);
});

await check('CLI: reports clean and exits 0 for two branches touching separate files', async () => {
  const dir = freshRepo('cliclean');
  git(dir, 'checkout', '-qb', 'branchQ');
  fs.writeFileSync(path.join(dir, 'q.txt'), 'q\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'Q adds q.txt');
  git(dir, 'checkout', '-qb', 'branchR', 'main');
  fs.writeFileSync(path.join(dir, 'r.txt'), 'r\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'R adds r.txt');
  git(dir, 'checkout', '-q', 'branchQ');

  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--against', 'branchR'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /branchR/);
  assert.match(run.stdout, /clean/);
});

await check('CLI: --json prints one parseable object per counterparty', async () => {
  const dir = freshRepo('clijson');
  git(dir, 'checkout', '-qb', 'branchS');
  fs.writeFileSync(path.join(dir, 's.txt'), 's\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'S adds s.txt');
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--against', 'main', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const rows = run.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].branch, 'main');
  assert.equal(rows[0].clean, true);
});

await check('CLI: no --against and nothing changed since main is nothing to report, exit 0', async () => {
  const dir = freshRepo('clinothing');
  const run = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '');
});

await check('CLI: --bead and --against together is a usage error, exit 2', async () => {
  const dir = freshRepo('clibothflags');
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--bead', 'bc-1', '--against', 'main'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /two ways of choosing/);
});

await check('CLI: an unrecognised flag refuses rather than silently ignoring it', async () => {
  const dir = freshRepo('cliunrecognised');
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--nope'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unrecognised flag/);
});

await check('CLI: a ref that cannot be resolved reports and exits 1', async () => {
  const dir = freshRepo('clibadref');
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--against', 'nowhere-branch'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /could not resolve/);
});

/* ---------------------------------------------------------------- --bead mode */

await check('CLI: --bead reads the files off a fake tracker and finds the same collision', async () => {
  const dir = freshRepo('clibead');
  const wtDir = path.join(tmp, 'clibead-wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'branchT', wtDir, 'main');
  fs.writeFileSync(path.join(wtDir, 'README.md'), 'line1\nline2\nline3\nANCHOR\nfromT\nline5\n');
  git(wtDir, 'commit', '-qam', 'T touches README.md');

  const fakeBd = path.join(tmp, 'bd-premerge');
  fs.writeFileSync(
    fakeBd,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'show') {
  process.stdout.write(JSON.stringify([{ id: args[1], description: '\`\`\`beadfiles\\nREADME.md\\n\`\`\`' }]));
  process.exit(0);
}
process.stdout.write('[]');
`,
    { mode: 0o755 }
  );
  const wsDir = path.join(tmp, 'bead-ws-premerge', '.beads');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
    JSON.stringify({ bdBin: fakeBd, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }] }, null, 2)
  );

  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--bead', 'bc-fake', '-w', 'demo', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); // dir's own HEAD (main) never touched README.md — a clean merge
  assert.match(run.stdout, /branchT/);
  fs.rmSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'));
});

/* -------------------------------------------------------------------- report */

cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} premerge checks passed`);
process.exit(failures ? 1 : 0);
