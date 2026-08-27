#!/usr/bin/env node
//
// b7e-deliverbase — which ref a workspace actually delivers into, before anyone reads a
// file (bc-dgx7.58).
//
//   npm test
//   node test/b7edeliverbase.mjs
//
// Real `git init`/`clone`/`commit` throughout, same argument test/b7ebase.mjs makes for
// the tool it is built beside: the whole point is what `git fetch`, `git rev-list` and
// `git ls-tree` actually report against a real remote-tracking ref, and a fake
// filesystem would only prove the parser can read strings this file wrote. A config
// fixture (`workspaces`, `pr.basePerWorkspace`) stands in for `~/.config/beadcause` via
// `BEADCAUSE_CONFIG_DIR`, and each workspace's checkout is a real clone with its `.beads`
// directory as a sibling — the same directory shape `resolveSessionDir` (lib/session.js)
// resolves in production, and the reason this asserts against that resolver rather than
// against `cwd`: `beadcause-memory notes a-checkout-dir-is-not-a-workspaces-dir` is the
// incident a hand-rolled `ws.dir` match caused for an earlier b7e-* command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-deliverbase');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- fixtures */

/** git with an identity of its own, so this never depends on the machine's. */
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7edeliverbase-'));
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
const HOME = path.join(tmp, 'home');
fs.mkdirSync(HOME, { recursive: true });

/** A one-commit repo on `main`, ready to be cloned as an `origin`. */
function makeOrigin(name, files = { 'shared.txt': 'one\n' }) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** A real `git clone` of `origin`, as `<tmp>/<name>` — the workspace's checkout. */
function cloneWork(origin, name) {
  const dir = path.join(tmp, name);
  git(tmp, 'clone', '-q', origin, dir);
  // A sibling `.beads`, matching what `resolveSessionDir` expects a plain workspace's
  // tracker to be — the parent of `workspace.dir` is the checkout it resolves to.
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
  return dir;
}

function commitFile(dir, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

function removePath(dir, rel, message) {
  git(dir, 'rm', '-rq', rel);
  git(dir, 'commit', '-q', '-m', message);
}

/** Writes a config naming exactly the workspaces given, plus whatever `pr` block. */
function writeConfig(workspaces, pr = { enabled: true, base: 'main' }) {
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ workspaces, pr }, null, 2));
}

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/* ==================================================================== 1. equal */

console.log('\na checkout sitting exactly on the base is reported equal, exit 0\n');

{
  const origin = makeOrigin('origin1');
  const work = cloneWork(origin, 'work1');
  const ws = { name: 'w1', dir: path.join(work, '.beads') };
  writeConfig([ws]);

  const r = run(['-w', 'w1']);
  check('exits 0', r.status === 0, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('names the workspace and the base', /w1 delivers into origin\/main/.test(r.stdout), r.stdout);
  check('says "main" is equal to it', /"main" is equal to it/.test(r.stdout), r.stdout);

  const j = run(['-w', 'w1', '--json']);
  const parsed = JSON.parse(j.stdout);
  check('json: state equal, 0/0', parsed.state === 'equal' && parsed.ahead === 0 && parsed.behind === 0, JSON.stringify(parsed));
  check('json: dir is the real checkout, not the .beads dir', parsed.dir === work, JSON.stringify(parsed));
}

/* ================================================================== 2. ancestor (behind) */

console.log('\nthe base moving on with the checkout untouched is "ancestor", behind, exit 1\n');

{
  const origin = makeOrigin('origin2');
  const work = cloneWork(origin, 'work2');
  const ws = { name: 'w2', dir: path.join(work, '.beads') };
  writeConfig([ws]);
  commitFile(origin, 'added.txt', 'b\n', 'add b');

  const r = run(['-w', 'w2']);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check(
    'says the checkout is an ancestor, behind by 1',
    /"main" is an ancestor of it — behind by 1 commit/.test(r.stdout),
    r.stdout
  );
}

/* =============================================================== 3. ancestor (ahead) */

console.log('\na checkout with its own unpushed commit is "ancestor", ahead, exit 1\n');

{
  const origin = makeOrigin('origin3');
  const work = cloneWork(origin, 'work3');
  const ws = { name: 'w3', dir: path.join(work, '.beads') };
  writeConfig([ws]);
  commitFile(work, 'local-only.txt', 'z\n', 'a commit only the checkout has');

  const r = run(['-w', 'w3']);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('says it is an ancestor of the checkout, ahead by 1', /it is an ancestor of "main" — ahead by 1 commit/.test(r.stdout), r.stdout);
}

/* ==================================================================== 4. diverged */

console.log('\nboth sides moving is diverged, with real ahead/behind counts, exit 1\n');

{
  const origin = makeOrigin('origin4');
  const work = cloneWork(origin, 'work4');
  const ws = { name: 'w4', dir: path.join(work, '.beads') };
  writeConfig([ws]);
  commitFile(work, 'branch-only.txt', 'x\n', 'checkout-only commit');
  commitFile(origin, 'base-only-1.txt', 'y\n', 'base commit one');
  commitFile(origin, 'base-only-2.txt', 'y2\n', 'base commit two');

  const r = run(['-w', 'w4']);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('says diverged — 1 ahead, 2 behind', /"main" has diverged from it — 1 ahead, 2 behind/.test(r.stdout), r.stdout);

  const j = run(['-w', 'w4', '--json']);
  const parsed = JSON.parse(j.stdout);
  check('json: state diverged, 1/2', parsed.state === 'diverged' && parsed.ahead === 1 && parsed.behind === 2, JSON.stringify(parsed));
}

/* ============================================================ 5. missing-here glob */

console.log('\na top-level path the base carries and the checkout does not is called out loudly\n');

{
  const origin = makeOrigin('origin5', { 'shared.txt': 'one\n', 'scripts/check_saga_audit.py': 'print(1)\n', 'scripts/studio_status.py': 'print(2)\n' });
  const work = cloneWork(origin, 'work5');
  const ws = { name: 'w5', dir: path.join(work, '.beads') };
  writeConfig([ws]);
  // The checkout's own branch never had `scripts/` at all — exactly the shape the bead
  // describes: a checkout parked somewhere that lacks a whole directory the base has.
  removePath(work, 'scripts', 'this checkout never carries scripts/');

  const r = run(['-w', 'w5']);
  check('exits 1 (the removal is a commit of its own — checkout is ahead)', r.status === 1, `status ${r.status}\n${r.stdout}`);
  check('names scripts/ as present-at-base and absent-here, with a count', /scripts\/ \(2 files\)/.test(r.stdout), r.stdout);
  check('never lists shared.txt — it exists on both sides', !/^  shared\.txt/m.test(r.stdout), r.stdout);

  const j = run(['-w', 'w5', '--json']);
  const parsed = JSON.parse(j.stdout);
  check(
    'json: missingHere is exactly [{path:"scripts",files:2,isDir:true}]',
    JSON.stringify(parsed.missingHere) === JSON.stringify([{ path: 'scripts', files: 2, isDir: true }]),
    JSON.stringify(parsed.missingHere)
  );
}

/* ==================================================== 6. a bare root file, not a dir */

console.log('\na bare root file missing at the checkout prints without a trailing slash\n');

{
  const origin = makeOrigin('origin6', { 'shared.txt': 'one\n', 'ONLY_AT_BASE.md': 'x\n' });
  const work = cloneWork(origin, 'work6');
  const ws = { name: 'w6', dir: path.join(work, '.beads') };
  writeConfig([ws]);
  removePath(work, 'ONLY_AT_BASE.md', 'the checkout never carries this file');

  const r = run(['-w', 'w6']);
  check('lists the bare file with no trailing slash', /^  ONLY_AT_BASE\.md \(1 file\)$/m.test(r.stdout), r.stdout);

  const j = run(['-w', 'w6', '--json']);
  const parsed = JSON.parse(j.stdout);
  check('json: isDir is false for a bare file', parsed.missingHere[0]?.isDir === false, JSON.stringify(parsed.missingHere));
}

/* =============================================================== 7. --show */

console.log('\n--show cats the file as it exists at the base, even where the checkout lacks it\n');

{
  const origin = makeOrigin('origin7', { 'shared.txt': 'one\n', 'scripts/only_at_base.py': 'print("base")\n' });
  const work = cloneWork(origin, 'work7');
  const ws = { name: 'w7', dir: path.join(work, '.beads') };
  writeConfig([ws]);
  removePath(work, 'scripts', 'the checkout never had this at all');

  const noLocalFile = !fs.existsSync(path.join(work, 'scripts', 'only_at_base.py'));
  check('sanity: the file really is absent from the checkout on disk', noLocalFile);

  const r = run(['-w', 'w7', '--show', 'scripts/only_at_base.py']);
  check('exits 0', r.status === 0, `status ${r.status}\n${r.stderr}`);
  check('prints the file content from the base', r.stdout === 'print("base")\n', JSON.stringify(r.stdout));

  const missing = run(['-w', 'w7', '--show', 'nope/nothing.txt']);
  check('exits 2 for a path that is not at the base either', missing.status === 2, `status ${missing.status}\n${missing.stderr}`);
  check('says the path does not exist at the base', /does not exist at origin\/main/.test(missing.stderr), missing.stderr);
}

/* ============================================== 8. pr.basePerWorkspace override */

console.log('\na workspace with its own base in pr.basePerWorkspace delivers into that, not pr.base\n');

{
  const origin = makeOrigin('origin8a');
  git(origin, 'checkout', '-q', '-b', 'launch');
  commitFile(origin, 'launch-only.txt', 'l\n', 'launch-only commit');
  git(origin, 'checkout', '-q', 'main');

  const work = cloneWork(origin, 'work8');
  git(work, 'fetch', '-q', 'origin', 'launch');
  const ws = { name: 'w8', dir: path.join(work, '.beads') };
  writeConfig([ws], { enabled: true, base: 'main', basePerWorkspace: { w8: 'launch' } });

  const r = run(['-w', 'w8']);
  check('exits 0', r.status === 0 || r.status === 1, `status ${r.status}\n${r.stderr}`);
  check('delivers into origin/launch, not origin/main', /w8 delivers into origin\/launch/.test(r.stdout), r.stdout);
}

/* ===================================================================== 9. refusals */

console.log('\nbad usage and unresolvable state refuse with exit 2, never a guess\n');

{
  const noWs = run([]);
  check('exits 2 with no -w', noWs.status === 2, `status ${noWs.status}\n${noWs.stderr}`);
  check('says -w is required', /-w\/--workspace is required/.test(noWs.stderr), noWs.stderr);

  fs.mkdirSync(path.join(tmp, 'onlyone', '.beads'), { recursive: true });
  writeConfig([{ name: 'onlyone', dir: path.join(tmp, 'onlyone', '.beads') }]);
  const unknown = run(['-w', 'nope-not-configured']);
  check('exits 2 for an unknown workspace', unknown.status === 2, `status ${unknown.status}\n${unknown.stderr}`);
  check('names the workspaces that do exist', /configured workspaces: onlyone/.test(unknown.stderr), unknown.stderr);

  const origin = makeOrigin('origin9');
  const work = cloneWork(origin, 'work9');
  const ws = { name: 'w9', dir: path.join(work, '.beads') };
  writeConfig([ws], { enabled: false });
  const disabled = run(['-w', 'w9']);
  check('exits 2 when pr.enabled is false', disabled.status === 2, `status ${disabled.status}\n${disabled.stderr}`);
  check('says delivery is disabled, not a guessed base', /pr\.enabled: false/.test(disabled.stderr), disabled.stderr);

  // A configured base that names no origin/<base> and no local <base> anywhere — the
  // checkout is real, but the branch it is told to deliver into was never fetched and
  // never existed locally either.
  const origin2 = makeOrigin('origin9b');
  const work2 = cloneWork(origin2, 'work9b');
  const ws2 = { name: 'w9b', dir: path.join(work2, '.beads') };
  writeConfig([ws2], { enabled: true, base: 'ghost-branch-nobody-made' });
  const ghost = run(['-w', 'w9b']);
  check('exits 2 when the configured base exists nowhere', ghost.status === 2, `status ${ghost.status}\n${ghost.stderr}`);
  check('says why', /has neither origin\/ghost-branch-nobody-made nor a local ghost-branch-nobody-made/.test(ghost.stderr), ghost.stderr);
}

/* ==================================================================== 10. --help */

console.log('\n--help says how to call it\n');

{
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  check('exits 0', r.status === 0, `status ${r.status}`);
  check('prints usage', /b7e-deliverbase -w <workspace>/.test(r.stdout), r.stdout);
}

/* ---------------------------------------------------------------- verdict */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
