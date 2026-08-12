#!/usr/bin/env node
/**
 * No suite tears down its own `BEADCAUSE_CONFIG_DIR` tree with a bare `fs.rmSync`.
 *
 *     npm test
 *     node test/tmpadoption.mjs
 *
 * `test/helpers/tmp.mjs` fixed a race that `test/dedupe.mjs` was losing — a write of
 * `advocates.json` schedules a commit 2000ms out, the commit runs `git init` in
 * `CONFIG_DIR`, and under test `CONFIG_DIR` *is* the scratch directory the last line
 * removes, so `git init` lays down `.git/hooks/*.sample` into a tree `rmSync` is already
 * walking. The README argues all of it under "A teardown must not be able to fail a run".
 *
 * The helper was the easy half. The hard half is that it fixed **one** suite: adoption sat
 * at two files while sixty-odd others kept the line that loses, and each of them could end
 * the gate on its own — `scripts/test.mjs` stops at the first non-zero exit, so a scratch
 * directory nobody was asserting anything about takes the remaining suites down with it,
 * with a green run either side. That is how bc-5uy8 became bc-3qsw, bc-r87b, bc-t69u,
 * bc-94c6, bc-qjsx, bc-mc4q and bc-b495: the same two lines, refiled seven times, because
 * nothing anywhere could see that the other suites still had them.
 *
 * So this is the check that makes the sweep stay swept. A fix applied by hand to sixty-
 * eight files is undone by the sixty-ninth, and the sixty-ninth is written by whoever adds
 * a suite next month with a copy of the file beside it — which is exactly how every suite
 * got the line in the first place. Without something that fails, the next report of this
 * bug is a new bead id and a fresh diagnosis of a bug already diagnosed twice.
 *
 * ## What counts as a violation
 *
 * A suite is in scope when it names `BEADCAUSE_CONFIG_DIR` at all — its own env or a
 * child's, since a child process schedules the same commit into the same tree and the
 * parent's `rmSync` races it just the same. Within those, the flagged line is a
 * **recursive** `fs.rmSync` of the identifier that `CONFIG_DIR` is built from.
 *
 * Deliberately not flagged:
 *
 * - Removing a single file, or a subdirectory that is not the config tree. `fs.rmSync(BD_LOG,
 *   { force: true })` cannot raise ENOTEMPTY, and a fake-bin or spy directory holds no git
 *   repo. Flagging those would make working lines look broken.
 * - A suite that never removes its scratch root. Fifteen of them leak the directory
 *   instead, which by the README's own standard is a few kilobytes `os.tmpdir()` clears
 *   rather than a regression — and no removal is no race.
 *
 * The helper this points people at has three doors, and which one a site needs is decided
 * by whether it can await: `await cleanupTmp(dir)` for an ordinary teardown, and
 * `removeTreeSync(dir)` where the removal is inside `process.on('exit', …)` or the
 * synchronous `done(code)` before `process.exit` — thirteen of the suites swept were that
 * shape. `quiesce()` and `removeTree()` separately for a teardown that runs between cases
 * rather than at the end, which is what `test/epicqueue.mjs` needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
  if (detail) console.log(`      ${detail}`);
};

/**
 * The identifier holding the tree that contains `CONFIG_DIR`.
 *
 * Both spellings, because a suite that drives a child process writes it as a property of
 * an env object rather than an assignment to `process.env`, and the race is identical.
 * One hop is resolved for `BEADCAUSE_CONFIG_DIR = CONFIG_DIR` where `CONFIG_DIR` is
 * itself `path.join(tmp, 'config')` — the tree at risk is `tmp`, not the join.
 */
export function configRoot(src) {
  let m = src.match(/BEADCAUSE_CONFIG_DIR\s*[:=]\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*,/);
  if (m) return m[1];
  m = src.match(/BEADCAUSE_CONFIG_DIR\s*[:=]\s*([A-Za-z_$][\w$]*)\s*[;,\s}]/);
  if (!m) return null;
  const name = m[1];
  const hop = src.match(
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*path\\.join\\(\\s*([A-Za-z_$][\\w$]*)\\s*,`)
  );
  return hop ? hop[1] : name;
}

/**
 * Lines that recursively remove `root` with a bare `fs.rmSync`.
 *
 * Comment lines are skipped, and the reason is not fastidiousness: the files that explain
 * this bug quote the losing line verbatim — `test/helpers/tmp.mjs` and the header above
 * both do — so a scan that did not skip them would fail the repo for its own
 * documentation, and the obvious way to quieten it would be to delete the explanation.
 */
export function bareRemovals(src, root) {
  const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rm = new RegExp(`fs\\.rmSync\\(\\s*${esc}\\s*,\\s*\\{[^}]*recursive:\\s*true[^}]*\\}\\s*\\)`);
  const hits = [];
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    if (rm.test(line)) hits.push({ line: i + 1, text: t });
  });
  return hits;
}

const suites = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs') && f !== 'tmpadoption.mjs')
  .sort();

const offenders = [];
let inScope = 0;
for (const f of suites) {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');
  if (!/BEADCAUSE_CONFIG_DIR/.test(src)) continue;
  inScope += 1;
  const root = configRoot(src);
  if (!root) continue;
  for (const hit of bareRemovals(src, root)) offenders.push({ f, root, ...hit });
}

console.log('\nteardown of a scratch config dir goes through test/helpers/tmp.mjs\n');

if (!offenders.length) {
  ok(`none of the ${inScope} suites naming BEADCAUSE_CONFIG_DIR removes its scratch root with a bare fs.rmSync`);
} else {
  bad(
    `${offenders.length} bare removal(s) of a scratch config dir`,
    'each can end the whole run from its own teardown after every check has passed'
  );
  for (const o of offenders) {
    console.log(`      test/${o.f}:${o.line}  (root: ${o.root})`);
    console.log(`        ${o.text}`);
  }
  console.log(
    '\n      Use test/helpers/tmp.mjs: `await cleanupTmp(dir)`, or `removeTreeSync(dir)`\n' +
      '      where the teardown cannot await (an `exit` handler, or `done(code)` before\n' +
      '      `process.exit`). See "A teardown must not be able to fail a run" in README.md.'
  );
}

// The check is only worth its runtime if it would actually catch the thing coming back,
// and the way a scan like this rots is by quietly matching nothing at all — a changed
// spelling, a renamed variable, and it passes an empty set forever. So: the pattern still
// recognises the exact line sixty-eight suites carried, and it still leaves alone the two
// shapes that are not the bug.
const SPECIMEN = [
  "const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-x-'));",
  "process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');",
  'fs.rmSync(tmp, { recursive: true, force: true });',
].join('\n');

const root = configRoot(SPECIMEN);
if (root === 'tmp') ok('the config root is still found in the shape every suite uses');
else bad('the config root is still found', `got ${JSON.stringify(root)}, expected "tmp"`);

if (bareRemovals(SPECIMEN, 'tmp').length === 1) ok('the bare removal is still recognised');
else bad('the bare removal is still recognised', 'the specimen line matched nothing — the pattern has rotted');

const CHILD_ENV = "const env = { ...process.env, BEADCAUSE_CONFIG_DIR: dir };";
if (configRoot(CHILD_ENV) === 'dir') ok("a child's env object is in scope too, not just process.env");
else bad("a child's env object is in scope", `got ${JSON.stringify(configRoot(CHILD_ENV))}`);

const HOP = ["const CONFIG_DIR = path.join(tmp, 'config');", 'process.env.BEADCAUSE_CONFIG_DIR = CONFIG_DIR;'].join('\n');
if (configRoot(HOP) === 'tmp') ok('an indirected CONFIG_DIR resolves to the tree that is actually removed');
else bad('an indirected CONFIG_DIR resolves', `got ${JSON.stringify(configRoot(HOP))}, expected "tmp"`);

const INNOCENT = [
  "process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');",
  'fs.rmSync(BD_LOG, { force: true });',
  'fs.rmSync(fakebin, { recursive: true, force: true });',
  'await cleanupTmp(tmp);',
].join('\n');
if (bareRemovals(INNOCENT, 'tmp').length === 0) ok('a single file, another scratch dir and the fixed form are all left alone');
else bad('the innocent shapes are left alone', `flagged: ${JSON.stringify(bareRemovals(INNOCENT, 'tmp'))}`);

// The first run of this check failed on test/tmpteardown.mjs, whose header quotes the
// losing line to explain it. Documentation is not a call site.
const QUOTED = ' * was still writing, and `fs.rmSync(tmp, { recursive: true, force: true })` walked it';
if (bareRemovals(QUOTED, 'tmp').length === 0) ok('a comment quoting the losing line is documentation, not a call site');
else bad('a quotation is not a call site', 'the header of the file explaining this bug would fail the repo');

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
