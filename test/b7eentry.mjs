#!/usr/bin/env node
//
// b7e-entry — the next free CHANGE_LOG.md entry number, across every branch, and what it
// costs (bc-dgx7.61).
//
//   npm test
//   node test/b7eentry.mjs
//
// Real git repos, really branched — the same reason test/siblings.mjs gives: the whole
// assertion is about what `git for-each-ref` and `git cat-file` actually report against
// a tree with real divergent branches, and a stub would only prove the parser can read
// strings this file wrote.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-entry');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eentry-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { entryHeadings, ledgerCounts, everyBranch, scanChangeLog } = await import(path.join(ROOT, 'lib', 'changelog.js'));

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

const entry = (num, date, decision, status = 'PENDING PROPAGATION') =>
  `\n## Entry ${num} — ${date}\n\n**Type:** WORLD DECISION\n**Status:** ${status}\n**Decision:** ${decision}\n**Priority:** COSMETIC\n\n**Chapters affected:**\n- [ ] Book 1, Ch. 1 — placeholder\n`;

const REPO = path.join(tmp, 'repo');
fs.mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 'test@localhost');
git(REPO, 'config', 'user.name', 'test');

// As the tree stood 2026-08-17, per the bead: entries run up to 104 on main, and two
// branches (worktree-a and worktree-b) each independently claim 096 for an unrelated
// decision, and main itself carries the un-suffixed Entry 078 collision dv-3rn.3 found.
const BASE_LOG =
  '# CHANGE_LOG\n' +
  entry('078', '2026-07-22', 'Megafauna as a primary awe engine for Books 1-2, sloth-clade continuity fix.') +
  entry('078', '2026-07-22', 'Metallurgy consolidation, transmutation reframe, retire memory-copper.') +
  entry('103', '2026-08-15', 'Lyrian is Annu per the ratified species map.', 'PARTIALLY PROPAGATED') +
  entry('104', '2026-08-16', 'Book 4 decomposed into 33 chapters and 12 interludes.', '[PROPAGATED]');
fs.writeFileSync(path.join(REPO, 'CHANGE_LOG.md'), BASE_LOG);
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'base');

function branch(name, from = 'main') {
  git(REPO, 'checkout', '-q', '-b', name, from);
  return {
    append(text) {
      fs.appendFileSync(path.join(REPO, 'CHANGE_LOG.md'), text);
      return this;
    },
    commit(msg = 'work') {
      git(REPO, 'add', '-A');
      git(REPO, 'commit', '-qm', msg);
      return this;
    },
  };
}
branch('worktree-a').append(entry('096', '2026-08-01', 'Achuri POV renamed Muchi across Book 1.')).commit();
git(REPO, 'checkout', '-q', 'main');
branch('worktree-b').append(entry('096', '2026-08-02', 'Denisovan stature revised down per the anthropology pass.')).commit();
git(REPO, 'checkout', '-q', 'main');
// A branch that touches nothing — inherits 103/104 unchanged, must not itself register
// as a collision with main just for existing.
branch('worktree-quiet');
git(REPO, 'checkout', '-q', 'main');

/* --------------------------------------------------------------------- cases */

await check('entryHeadings finds every "## Entry NNN" heading, never the template line', () => {
  const headings = entryHeadings('## Entry Format\n\n```\n## Entry [NNN] — [DATE]\n```\n\n## Entry 007 — 2026-01-01\n');
  assert.equal(headings.length, 1);
  assert.equal(headings[0].digits, '007');
});

await check('entryHeadings keeps a letter suffix as part of the entry\'s identity', () => {
  const headings = entryHeadings('## Entry 078 — d\n\n**Decision:** a\n## Entry 078b — d\n\n**Decision:** b\n');
  assert.deepEqual(
    headings.map((h) => `${h.digits}${h.suffix}`),
    ['078', '078b']
  );
});

await check('ledgerCounts matches check_g0_canon_lock.py\'s own derivation', () => {
  const counts = ledgerCounts(BASE_LOG);
  assert.equal(counts.entries, 4); // two 078s, 103, 104
  assert.equal(counts.pendingPropagation, 2); // both 078s default to PENDING PROPAGATION
  assert.equal(counts.partially, 1); // 103's own PARTIALLY PROPAGATED status
});

await check('everyBranch sees every local branch, folds no origin copy that does not exist yet', async () => {
  const names = await everyBranch(REPO);
  assert.ok(names.some((b) => b.name === 'main'));
  assert.ok(names.some((b) => b.name === 'worktree-a'));
  assert.ok(!names.some((b) => b.name.includes('HEAD')));
});

await check('scanChangeLog: next free is one past the highest number on any branch', async () => {
  const result = await scanChangeLog(REPO);
  assert.equal(result.nextFree, 105);
});

await check('scanChangeLog: both Entry 096s are named as a duplicate, one branch each', async () => {
  const result = await scanChangeLog(REPO);
  const dup = result.duplicates.find((d) => d.entry === '096');
  assert.ok(dup, 'Entry 096 is reported as a duplicate');
  assert.equal(dup.variants.length, 2);
  const branches = dup.variants.flatMap((v) => v.branches).sort();
  assert.deepEqual(branches, ['worktree-a', 'worktree-b']);
});

await check('scanChangeLog: the un-suffixed Entry 078 collision on main is named', async () => {
  const result = await scanChangeLog(REPO);
  const dup = result.duplicates.find((d) => d.entry === '078');
  assert.ok(dup, 'Entry 078 is reported as a duplicate');
  assert.equal(dup.variants.length, 2);
  // Every branch cut from main carries both — the collision is main's own, inherited.
  for (const v of dup.variants) assert.ok(v.branches.includes('main'));
});

await check('scanChangeLog: a branch that never touched the file inherits main\'s own collisions and nothing more', async () => {
  const result = await scanChangeLog(REPO);
  // main's Entry 078 collision predates the branch, so worktree-quiet's unedited copy
  // legitimately carries both variants too — that is the branch reporting the truth
  // about its own file, not a new collision of its own making.
  const seventyEight = result.duplicates.find((d) => d.entry === '078');
  for (const v of seventyEight.variants) assert.ok(v.branches.includes('worktree-quiet'));
  // Entry 096 exists on neither main nor worktree-quiet — it must not appear there.
  const ninetySix = result.duplicates.find((d) => d.entry === '096');
  for (const v of ninetySix.variants) assert.ok(!v.branches.includes('worktree-quiet'));
});

await check('scanChangeLog: entries 103/104, present on every branch unchanged, are not duplicates', async () => {
  const result = await scanChangeLog(REPO);
  assert.ok(!result.duplicates.some((d) => d.entry === '103'));
  assert.ok(!result.duplicates.some((d) => d.entry === '104'));
});

await check('scanChangeLog: a reworded Decision on an unmerged branch is the same entry, not a second one', async () => {
  branch('worktree-wording');
  const text = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  fs.writeFileSync(
    path.join(REPO, 'CHANGE_LOG.md'),
    text.replace(
      'Book 4 decomposed into 33 chapters and 12 interludes.',
      'Book 4 decomposed into 33 chapters and twelve interludes.' // a wording fix, same decision
    )
  );
  git(REPO, 'commit', '-qam', 'reword 104');
  git(REPO, 'checkout', '-q', 'main');

  const result = await scanChangeLog(REPO);
  assert.ok(!result.duplicates.some((d) => d.entry === '104'), 'a reword is not a second decision');
});

await check('scanChangeLog: a remote-only branch (never checked out locally) is still scanned', async () => {
  const remote = path.join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', remote);
  git(REPO, 'remote', 'add', 'origin', remote);
  git(REPO, 'push', '-q', 'origin', 'main');
  branch('worktree-remote-only').append(entry('200', '2026-08-24', 'A decision only ever pushed, never fetched back locally.')).commit();
  git(REPO, 'push', '-q', 'origin', 'worktree-remote-only');
  git(REPO, 'checkout', '-q', 'main');
  git(REPO, 'branch', '-D', 'worktree-remote-only');
  git(REPO, 'fetch', '-q', 'origin');

  const names = (await everyBranch(REPO)).map((b) => b.name);
  assert.ok(!names.includes('worktree-remote-only'), 'the local branch is really gone');
  assert.ok(names.includes('origin/worktree-remote-only'), 'its origin copy is still seen');

  const result = await scanChangeLog(REPO);
  assert.equal(result.nextFree, 201); // 200 is now the highest number anywhere
});

await check('scanChangeLog: base defaults to origin/main once one exists, matching pickBase', async () => {
  const result = await scanChangeLog(REPO);
  assert.equal(result.base, 'origin/main');
});

await check('scanChangeLog: ledger and delta are computed from the base only, not every branch', async () => {
  const result = await scanChangeLog(REPO, { base: 'main' });
  // main's own file: two 078s, 103, 104 (unchanged by any branch's edits) = 4 entries.
  assert.equal(result.ledger.entries, 4);
  assert.equal(result.delta.entries, result.ledger.entries + 1);
  assert.equal(result.delta.pendingPropagation, result.ledger.pendingPropagation + 1);
  assert.equal(result.delta.partially, result.ledger.partially);
});

await check('scanChangeLog never writes to the file it scans', async () => {
  const before = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  const beforeStatus = git(REPO, 'status', '--short');
  await scanChangeLog(REPO);
  await scanChangeLog(REPO, { base: 'origin/main' });
  const after = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  assert.equal(after, before);
  assert.equal(git(REPO, 'status', '--short'), beforeStatus);
});

/* --------------------------------------------------------------------- CLI */

await check('CLI: --dir drives it directly, and prints the next free number', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /next free entry: 201/);
  assert.match(run.stdout, /Entry 096/);
});

await check('CLI: --json is valid JSON matching the lib result shape', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.nextFree, 201);
  assert.ok(Array.isArray(parsed.duplicates));
  assert.ok(parsed.duplicates.some((d) => d.entry === '096'));
});

await check('CLI: --check exits 1 when anything collides, 0 on a clean tree', () => {
  const dirty = spawnSync(process.execPath, [BIN, '--dir', REPO, '--check'], { encoding: 'utf8' });
  assert.equal(dirty.status, 1);

  const clean = path.join(tmp, 'clean-repo');
  fs.mkdirSync(clean, { recursive: true });
  git(clean, 'init', '-q', '-b', 'main');
  git(clean, 'config', 'user.email', 'test@localhost');
  git(clean, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(clean, 'CHANGE_LOG.md'), entry('001', '2026-01-01', 'Only one entry, nothing to collide with.'));
  git(clean, 'add', '-A');
  git(clean, 'commit', '-qm', 'base');
  const run = spawnSync(process.execPath, [BIN, '--dir', clean, '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

await check('CLI: never writes to CHANGE_LOG.md even when run through the binary', () => {
  const before = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  spawnSync(process.execPath, [BIN, '--dir', REPO, '--check'], { encoding: 'utf8' });
  spawnSync(process.execPath, [BIN, '--dir', REPO, '--json'], { encoding: 'utf8' });
  assert.equal(fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8'), before);
});

await check('CLI: an unknown workspace name exits 4, names the known ones', () => {
  const run = spawnSync(process.execPath, [BIN, '-w', 'totally-bogus-workspace-name-zzz'], { encoding: 'utf8' });
  assert.equal(run.status, 4);
  assert.match(run.stderr, /no workspace called totally-bogus-workspace-name-zzz/);
});

await check('CLI: -w resolves through cfg.sessionDirs, not a workspace\'s own .beads dir', () => {
  const wsDir = path.join(tmp, 'demo-ws', '.beads');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
    JSON.stringify({ workspaces: [{ name: 'demo', dir: wsDir }], sessionDirs: { demo: REPO } }, null, 2)
  );
  const run = spawnSync(process.execPath, [BIN, '-w', 'demo', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.nextFree, 201); // the REPO fixture's own answer
  fs.rmSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'));
});

await check('CLI: --help prints usage and exits 0 without touching git', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /usage: b7e-entry/);
});

/* -------------------------------------------------------------------- report */

cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} b7e-entry checks passed`);
process.exit(failures ? 1 : 0);
