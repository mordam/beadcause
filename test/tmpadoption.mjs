#!/usr/bin/env node
/**
 * No suite removes its `BEADCAUSE_CONFIG_DIR` tree with a bare `fs.rmSync` — at the end,
 * or between cases.
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
 * ## The half this used to miss: the removal that is not a teardown
 *
 * bc-9d37.9. `test/leasequeue.mjs` went red on a full gate run with the same ENOTEMPTY —
 * *after* all twenty of its own checks had printed ok — and this check had nothing to say
 * about it, because the losing line was not in a teardown at all:
 *
 *     function reset() {
 *       const dir = process.env.BEADCAUSE_CONFIG_DIR;
 *       for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
 *     }
 *
 * `check()` calls that before **every** case, so it races `git init` twenty times a run
 * rather than once, and it is worse than the teardown form rather than better: the scan
 * below was looking for the scratch *root*, and this removes the config directory's
 * contents one entry at a time — `.git` among them. Ten suites carried it. It only bites
 * once a suite runs longer than the 2000ms debounce, so each of them was one added case
 * away from an intermittent red, which is exactly the shape this file exists to stop
 * being rediscovered.
 *
 * So there are two scans, with two different fixes. The root form wants `cleanupTmp` or
 * `removeTreeSync`; the per-case form wants `await quiesce()` once, then `await
 * removeTree(...)` per entry.
 *
 * ## What counts as a violation
 *
 * A suite is in scope when it names `BEADCAUSE_CONFIG_DIR` at all — its own env or a
 * child's, since a child process schedules the same commit into the same tree and the
 * parent's `rmSync` races it just the same. Within those, two flagged lines: a
 * **recursive** `fs.rmSync` of the identifier that `CONFIG_DIR` is built from, and a
 * **recursive** `fs.rmSync` of the config directory itself or of a child of it whose name
 * the scan cannot see.
 *
 * Deliberately not flagged:
 *
 * - Removing a single file, or a subdirectory that is not the config tree. `fs.rmSync(BD_LOG,
 *   { force: true })` cannot raise ENOTEMPTY, and a fake-bin or spy directory holds no git
 *   repo. Flagging those would make working lines look broken.
 * - **A named child of the config directory.** `fs.rmSync(path.join(CONFIG_DIR, 'tls'),
 *   { recursive: true })` is `test/signinsetup.mjs` throwing away a certificate directory;
 *   the commit lands in `.git`, and a literal that is not `.git` is not it. A child named
 *   by a *variable* is flagged, because the variable is the one out of `readdirSync` and
 *   `.git` is one of the things it comes back with.
 * - **The fixed form itself, explicitly.** `await removeTree(path.join(dir, f))` is what
 *   the ten suites were moved to, and a guard that went red on the fix would teach the
 *   next session to stop reading it — so there is a check below asserting the quiesced
 *   shape passes, not merely an absence of one asserting it fails.
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

/**
 * Every identifier in the suite that holds `CONFIG_DIR` itself, rather than the tree above it.
 *
 * Two spellings and they are the two halves of the same thing: a suite either reads the
 * variable back out of the environment (`const dir = process.env.BEADCAUSE_CONFIG_DIR`)
 * or puts one in (`BEADCAUSE_CONFIG_DIR: dir`, `= CONFIG_DIR`). `root` is subtracted
 * because a suite whose `CONFIG_DIR` *is* its scratch root is `bareRemovals`' business
 * and reporting the same line twice under two different fixes helps nobody.
 */
export function configDirNames(src, root) {
  const names = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.BEADCAUSE_CONFIG_DIR\b/g))
    names.add(m[1]);
  for (const m of src.matchAll(/BEADCAUSE_CONFIG_DIR\s*[:=]\s*([A-Za-z_$][\w$]*)\s*[;,\s}]/g)) names.add(m[1]);
  names.delete(root);
  return names;
}

/** `fs.rmSync(<target>, { …options… })` on one line. Lazy, so `path.join(dir, f)` survives its comma. */
const RM_CALL = /fs\.rmSync\(\s*(.*?)\s*,\s*\{([^}]*)\}\s*\)/;

/**
 * Whether a removal target is the config tree, or a part of it the scan cannot name.
 *
 * The bare identifier is the config directory. `path.join(<it>, x)` is a child, and which
 * children matter is the whole judgement: `.git` is where the scheduled commit lands, a
 * literal that is not `.git` is a directory somebody chose deliberately, and anything that
 * is not a literal came out of `readdirSync` and therefore includes `.git`.
 */
export function removesConfigTree(target, names) {
  const bare = target.match(/^([A-Za-z_$][\w$]*)$/);
  if (bare) return names.has(bare[1]);
  const join = target.match(/^path\.join\(\s*([A-Za-z_$][\w$]*)\s*,\s*(.+)\)$/);
  if (!join || !names.has(join[1])) return false;
  const literal = join[2].trim().match(/^'([^']*)'$|^"([^"]*)"$/);
  if (!literal) return true;
  return (literal[1] ?? literal[2]).startsWith('.git');
}

/**
 * Lines that recursively remove the config tree with a bare `fs.rmSync`, wherever they sit.
 *
 * Comments are skipped for the same reason `bareRemovals` skips them: the files that
 * explain this bug quote the losing line, including the header above.
 */
export function configTreeRemovals(src, names) {
  const hits = [];
  if (!names.size) return hits;
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    const m = RM_CALL.exec(line);
    if (!m || !/recursive:\s*true/.test(m[2])) return;
    if (removesConfigTree(m[1], names)) hits.push({ line: i + 1, text: t });
  });
  return hits;
}

const suites = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs') && f !== 'tmpadoption.mjs')
  .sort();

const offenders = [];
const perCase = [];
let inScope = 0;
for (const f of suites) {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');
  if (!/BEADCAUSE_CONFIG_DIR/.test(src)) continue;
  inScope += 1;
  const root = configRoot(src);
  if (root) for (const hit of bareRemovals(src, root)) offenders.push({ f, root, ...hit });
  const names = configDirNames(src, root);
  for (const hit of configTreeRemovals(src, names)) perCase.push({ f, names: [...names].join(', '), ...hit });
}

console.log('\nremoving a scratch config dir goes through test/helpers/tmp.mjs\n');

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

// The half a teardown-shaped scan cannot see. Reported separately because the fix is a
// different one: there is no root to hand `cleanupTmp`, only a quiesce owed before the
// removals and a tolerant removal for each of them.
if (!perCase.length) {
  ok('and none of them empties CONFIG_DIR between cases with one either');
} else {
  bad(
    `${perCase.length} bare removal(s) of the config tree away from a teardown`,
    'a reset between cases races the same git init, once per case rather than once per run'
  );
  for (const p of perCase) {
    console.log(`      test/${p.f}:${p.line}  (config dir: ${p.names})`);
    console.log(`        ${p.text}`);
  }
  console.log(
    '\n      Use test/helpers/tmp.mjs: `await quiesce()` once, then `await removeTree(…)`\n' +
      '      for each entry — test/leasequeue.mjs and test/epicqueue.mjs are the shape.\n' +
      '      See "A teardown must not be able to fail a run" in README.md.'
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

/*
 * The second scan gets the same treatment, and needs it more: it is the one whose whole
 * job is to recognise a line ten suites no longer contain, so nothing else in the repo
 * would notice it rotting to an empty set.
 */
const RESET = [
  "process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');",
  'const dir = process.env.BEADCAUSE_CONFIG_DIR;',
  'for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });',
].join('\n');

const resetNames = configDirNames(RESET, configRoot(RESET));
if (resetNames.has('dir') && !resetNames.has('tmp'))
  ok('the identifier holding CONFIG_DIR is found, and is not confused with the tree above it');
else bad('the CONFIG_DIR identifier is found', `got ${JSON.stringify([...resetNames])}, expected just "dir"`);

if (configTreeRemovals(RESET, resetNames).length === 1) ok('the per-case reset every advocate-queue suite carried is recognised');
else bad('the per-case reset is recognised', 'the specimen line matched nothing — the pattern has rotted');

/*
 * And the fix passes *explicitly*. A guard that only ever says no teaches people to stop
 * reading it; this one is asked, on the exact shape the ten suites were moved to, whether
 * it is happy — so a future edit that widened the matcher into the fix would say so here
 * rather than in ten unrelated suites.
 */
const QUIESCED = [
  'const dir = process.env.BEADCAUSE_CONFIG_DIR;',
  'await quiesce();',
  'for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));',
].join('\n');
if (configTreeRemovals(QUIESCED, new Set(['dir'])).length === 0) ok('and the quiesced form the suites were moved to passes');
else bad('the quiesced form passes', 'the fix for this bug would fail the check that exists to require it');

/*
 * The line between a child of the config dir that matters and one that does not. Named
 * literals are somebody's deliberate scratch subdirectory (test/signinsetup.mjs throws
 * away `config/tls`); a variable child came out of `readdirSync` and includes `.git`.
 */
const NAMED_CHILD = "fs.rmSync(path.join(CONFIG_DIR, 'tls'), { recursive: true, force: true });";
if (configTreeRemovals(NAMED_CHILD, new Set(['CONFIG_DIR'])).length === 0)
  ok('a named subdirectory of the config dir is left alone — the commit lands in .git, not there');
else bad('a named subdirectory is left alone', 'a working line in test/signinsetup.mjs would fail the repo');

const GIT_CHILD = "fs.rmSync(path.join(CONFIG_DIR, '.git'), { recursive: true, force: true });";
if (configTreeRemovals(GIT_CHILD, new Set(['CONFIG_DIR'])).length === 1)
  ok('but removing .git by name is the same race, spelled out');
else bad('removing .git by name is flagged', 'the one named child that is the repo went unflagged');

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
