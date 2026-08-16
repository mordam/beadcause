#!/usr/bin/env node
/**
 * **The attic stops being heavy, and stops being told to install.**
 *
 *     npm test
 *     node test/nodemodules.mjs
 *
 * bc-2v7k bounded how *full* `.claude/worktrees-retired/` gets — entries expire after two
 * days — and that left the other half of the same number untouched. Of the 1.2 GB in the
 * attic that filed it, 650 MB was four directories out of 122: `merge-sessions-advocates-4d2`,
 * `tab-bar-4nq`, `proposal-record-91k` and `in-app-terminal-49g`, 160–167 MB each against
 * ~6 MB for a normal entry. The whole difference was a real installed `node_modules` where
 * every other worktree had a symlink to the main checkout's, and each of the four had
 * `node_modules/.package-lock.json` in it, so each was a plain `npm install` run inside the
 * worktree. Expiry alone would never have caught them: none was old enough, and a repeat
 * puts 650 MB back however fast the sweep runs.
 *
 * So there are two halves here and they are tested together, because either one alone
 * leaves the bug:
 *
 * 1. **`slimAttic`** drops a real `node_modules` from a retired worktree — with only the
 *    gates about interrupting somebody, since nothing it removes is work: `npm install`
 *    puts it back from a committed lock file. Four failures are worth the file: dropping
 *    the *symlink* (which would take the main checkout's tree away through it), dropping a
 *    tree somebody is using, waiting for the age line that would never come, and losing
 *    the `.note` stamp that decides the entry's age when it appends its own line to it.
 * 2. **`scripts/vendor.js`** stops telling a worktree to run `npm install`. It is the
 *    first thing run in a fresh worktree and the only thing there to say anything, and
 *    "missing marked/lib/marked.umd.js — run npm install", seven times, is the likeliest
 *    reason those four exist.
 *
 * A third half arrived with bc-oqu7, and it is the same shape one more time. With the
 * dependency trees and the gradle output gone, `public/vendor` *was* the attic: 4.2 MB of
 * every ~6 MB entry, the same seven files 123 times, ~500 MB of 636. It is the one thing
 * `slimAttic` refuses to drop — an entry without it is not resumable in one command — so
 * `scripts/vendor.js` borrows it instead, symlinking the seven at the main checkout the
 * way `node_modules` already is. What the checks below care about is everything that
 * could make that a worse trade than copying: a link that does not survive retirement, a
 * link where the *directory* should be (which `.gitignore`'s trailing slash turns into a
 * refused delivery), a dangling link into a main checkout that never built its own, and a
 * worktree made before this that keeps its copies forever because `symlinkSync` will not
 * overwrite.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { slimAttic, describeSlim } from '../lib/tidy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-nodemodules-'));

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
const check = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@e',
    },
  }).trim();

/* ------------------------------------------------------------------- the repo */

const main = path.join(tmp, 'repo');
fs.mkdirSync(main, { recursive: true });
git(main, 'init', '--quiet', '--initial-branch=main', '.');
git(main, 'config', 'user.email', 't@e');
git(main, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(main, 'file.txt'), 'one\n');
fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n');
git(main, 'add', '-A');
git(main, 'commit', '--quiet', '-m', 'one');
// The tree every worktree is supposed to borrow rather than copy.
fs.mkdirSync(path.join(main, 'node_modules', 'marked'), { recursive: true });
fs.writeFileSync(path.join(main, 'node_modules', 'marked', 'index.js'), 'x'.repeat(4096));

const RETIRED = path.join(main, '.claude', 'worktrees-retired');
fs.mkdirSync(RETIRED, { recursive: true });

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

/**
 * The ten-minute quiet gate is about not pulling a tree out from under something that is
 * running, so every fixture that is *not* testing that gate has to look untouched. Files
 * a test just wrote are the opposite of that.
 */
function quiet(dir, minutes = 60, depth = 0) {
  const when = new Date(Date.now() - minutes * 60000);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) quiet(p, minutes, depth + 1);
    try {
      fs.utimesSync(p, when, when);
    } catch {
      /* a symlink on some platforms; not what the walk reads anyway */
    }
  }
  fs.utimesSync(dir, when, when);
}

/**
 * A retired worktree carrying `deps`: `'real'` for its own installed tree, `'link'` for
 * the borrowed symlink every worktree is meant to have, `'none'` for neither.
 */
function retire(name, { deps = 'real', age = 5, bytes = 8192, gradle = false } = {}) {
  const branch = `worktree-${name}`;
  const live = path.join(main, '.claude', 'worktrees', name);
  git(main, 'worktree', 'add', '--quiet', '-b', branch, live, 'main');
  const dest = path.join(RETIRED, name);
  git(main, 'worktree', 'move', live, dest);
  if (gradle) {
    // What `npm run android` leaves behind — ignored, rebuilt, and 15 MB a time.
    fs.mkdirSync(path.join(dest, 'android', 'app', 'build', 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'android', 'app', 'build', 'outputs', 'app.apk'), 'x'.repeat(bytes));
    fs.mkdirSync(path.join(dest, 'android', 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'android', 'app', 'src', 'Main.kt'), 'fun main() {}\n');
  }
  if (deps === 'real') {
    fs.mkdirSync(path.join(dest, 'node_modules', 'marked'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'node_modules', 'marked', 'index.js'), 'x'.repeat(bytes));
    // What every one of the four real ones had, and the fingerprint of `npm install`.
    fs.writeFileSync(path.join(dest, 'node_modules', '.package-lock.json'), '{}\n');
  } else if (deps === 'link') {
    fs.symlinkSync(path.join('..', '..', '..', 'node_modules'), path.join(dest, 'node_modules'));
  }
  fs.writeFileSync(path.join(RETIRED, `${name}.note`), `${daysAgo(age)}  retired by test\n`);
  quiet(dest);
  return { name, branch, dest, mods: path.join(dest, 'node_modules') };
}

/* ----------------------------------------------------------------- slimAttic */

console.log('\nnode_modules in the attic');

const fat = retire('fat-one', { bytes: 20000 });
const young = retire('fat-and-young', { age: 0.1, bytes: 12000 });
const borrowed = retire('borrowed-one', { deps: 'link' });
const bare = retire('nothing-installed', { deps: 'none' });
const built = retire('built-an-apk', { deps: 'link', gradle: true, bytes: 30000 });
const locked = retire('locked-one');
const occupied = retire('someone-in-it');
const busy = retire('still-running');
git(main, 'worktree', 'lock', locked.dest);
// Only this one looks alive: a file written now, which is what a suite mid-run leaves.
fs.writeFileSync(path.join(busy.dest, 'file.txt'), 'edited just now\n');

const sessions = [{ pid: 4242, cwd: occupied.dest }];

const dry = await slimAttic(main, { sessions, dryRun: true });
await check(async () => {
  assert.ok(
    dry.slimmed.some((s) => s.name === fat.name),
    `dry run should have named it: ${JSON.stringify(dry.slimmed.map((s) => s.name))}`
  );
  assert.ok(fs.existsSync(fat.mods), 'a dry run must not remove anything');
  assert.ok(dry.bytes > 20000, `it should still weigh it: ${dry.bytes}`);
}, 'a dry run says what it would drop and drops nothing');

const slim = await slimAttic(main, { sessions });
const why = (name) => slim.kept.find((k) => k.name === name)?.why || '';

await check(async () => {
  assert.ok(!fs.existsSync(fat.mods), 'node_modules should be gone');
  assert.ok(fs.existsSync(path.join(fat.dest, 'file.txt')), 'and nothing else with it');
  const row = slim.slimmed.find((s) => s.name === fat.name);
  assert.ok(row, `it should be reported: ${JSON.stringify(slim.slimmed)}`);
  assert.ok(row.bytes > 20000, `with what it freed: ${row.bytes}`);
}, 'a retired worktree with its own installed tree gives it up');

await check(async () => {
  assert.ok(!fs.existsSync(young.mods), `kept it: ${why(young.name)}`);
}, 'age is not one of the gates — a young entry is slimmed too, or 650 MB waits two days');

await check(async () => {
  const st = fs.lstatSync(borrowed.mods);
  assert.ok(st.isSymbolicLink(), 'the symlink itself must survive');
  assert.ok(fs.existsSync(path.join(main, 'node_modules', 'marked', 'index.js')), 'and what it points at');
  assert.ok(!slim.slimmed.some((s) => s.name === borrowed.name), 'and it is not worth a row');
}, 'a borrowed node_modules is left alone — following it would empty the main checkout');

await check(async () => {
  assert.ok(!slim.slimmed.some((s) => s.name === bare.name), 'nothing to drop');
  assert.ok(!slim.kept.some((k) => k.name === bare.name), 'and nothing to say about it');
}, 'an entry with no node_modules at all is silent, not a row');

await check(async () => {
  assert.ok(!fs.existsSync(path.join(built.dest, 'android', 'app', 'build')), 'the gradle output should be gone');
  assert.ok(fs.existsSync(path.join(built.dest, 'android', 'app', 'src', 'Main.kt')), 'and the source it was built from left');
  const row = slim.slimmed.find((s) => s.name === built.name);
  assert.ok(row, `it should be reported: ${JSON.stringify(slim.slimmed)}`);
  assert.deepEqual(row.dropped, [path.join('android', 'app', 'build')], `by path: ${JSON.stringify(row.dropped)}`);
}, 'an APK build is dropped too — it is what kept the rest of the attic over the line');

await check(async () => {
  // `public/vendor/` is 4 MB, every browser check needs it, and rebuilding it needs the
  // dependency tree that has just gone. It is the line this list stops at, on purpose.
  const wanted = path.join(built.dest, 'public', 'vendor');
  fs.mkdirSync(wanted, { recursive: true });
  fs.writeFileSync(path.join(wanted, 'marked.js'), 'x'.repeat(50000));
  quiet(built.dest);
  const after = await slimAttic(main, { sessions });
  assert.ok(fs.existsSync(path.join(wanted, 'marked.js')), 'public/vendor is not build output this drops');
  assert.ok(!after.slimmed.some((s) => s.name === built.name), 'and nothing else is left there to drop');
}, 'public/vendor survives — heavy is not the test, rebuilt-anyway is');

for (const [entry, want] of [
  [locked, /locked/],
  [occupied, /pid 4242/],
  [busy, /minute\(s\) ago/],
]) {
  await check(async () => {
    assert.ok(fs.existsSync(entry.mods), 'the tree should still be there');
    assert.match(why(entry.name), want, `reason was: ${why(entry.name) || '(none)'}`);
  }, `${entry.name} keeps its tree, and is named with the reason`);
}

await check(async () => {
  const note = fs.readFileSync(path.join(RETIRED, `${fat.name}.note`), 'utf8').split('\n').filter(Boolean);
  // Line one is what `retiredAt` parses, and the whole expiry rests on it: append, never
  // rewrite. An entry whose stamp moved to today would be immortal in a two-day attic.
  const stamp = Date.parse(note[0].split(/\s+/)[0]);
  assert.ok(Number.isFinite(stamp), `line one must still parse as a stamp: ${note[0]}`);
  assert.ok(Date.now() - stamp > 4 * 86400000, `stamp moved: ${note[0]}`);
  assert.match(note[1], /node_modules dropped/, note[1]);
  assert.match(note[1], /npm install/, 'and how to get it back');
}, 'the .note keeps its original stamp and gains a line saying what went');

await check(async () => {
  const line = describeSlim(slim);
  assert.match(line, /slimmed /, line);
  assert.match(line, /freed \d+ MB/, line);
  assert.match(line, new RegExp(busy.name), `the blocked ones are named: ${line}`);
  assert.ok(!new RegExp(locked.name).test(line), `locked is the normal case and not worth the width: ${line}`);
}, 'the one-liner carries what went, what it freed, and what would not let go');

await check(async () => {
  const again = await slimAttic(main, { sessions });
  assert.deepEqual(
    again.slimmed.map((s) => s.name),
    [],
    'a second pass has nothing to do'
  );
  assert.equal(again.bytes, 0);
}, 'a slimmed attic is a no-op the next time round');

await check(async () => {
  // A stray directory is somebody having moved things by hand. `expireRetired` will not
  // remove one and this will not reach into one either — same rule, same reason.
  const stray = path.join(RETIRED, 'not-a-worktree');
  fs.mkdirSync(path.join(stray, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(stray, 'node_modules', 'big.js'), 'x'.repeat(30000));
  quiet(stray);
  const after = await slimAttic(main, { sessions });
  assert.ok(fs.existsSync(path.join(stray, 'node_modules')), 'an unregistered directory is not this sweep to touch');
  assert.ok(!after.slimmed.some((s) => s.name === 'not-a-worktree'), 'nor to claim it slimmed');
}, 'an unregistered directory in the attic is left completely alone');

await check(async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-nomods-none-'));
  git(empty, 'init', '--quiet', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(empty, 'f'), 'x\n');
  git(empty, 'add', '-A');
  git(empty, 'commit', '--quiet', '-m', 'one');
  const none = await slimAttic(empty);
  assert.deepEqual(none.slimmed, []);
  assert.deepEqual(none.kept, []);
  assert.equal(none.bytes, 0);
  fs.rmSync(empty, { recursive: true, force: true });
}, 'a repo with no attic at all is a no-op, not a crash');

/* ------------------------------------------------------- and where they come from */

console.log('\nwhat a fresh worktree is told');

/**
 * What the real `scripts/vendor.js` prints from a given root, stdout and stderr together
 * — the advice is a warning, and asserting on stdout alone would pass whatever it said.
 *
 * It decides where it is from its own file location, so the only honest way to ask what a
 * worktree sees is to run the shipped file from a worktree-shaped path. A copy, not an
 * import: importing it would run it here, against this checkout, which is the one place
 * whose answer is not in question.
 */
function vendorSays(root, { deps = 'none' } = {}) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts', 'vendor.js'), path.join(root, 'scripts', 'vendor.js'));
  if (deps === 'real') fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  if (deps === 'link') fs.symlinkSync(path.join('..', '..', '..', 'node_modules'), path.join(root, 'node_modules'));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'vendor.js')], { encoding: 'utf8' });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

/** The seven names `scripts/vendor.js` writes, read out of the file rather than restated. */
const BUNDLES = [...fs.readFileSync(path.join(REPO, 'scripts', 'vendor.js'), 'utf8').matchAll(/^ {2}\['[^']+', '([^']+)'\],$/gm)].map(
  (m) => m[1]
);

/** A main checkout whose `public/vendor` is already built — the thing a worktree borrows. */
function mainWithVendor(main) {
  fs.mkdirSync(path.join(main, 'public', 'vendor'), { recursive: true });
  for (const name of BUNDLES) fs.writeFileSync(path.join(main, 'public', 'vendor', name), `/* ${name} */\n`);
  return main;
}

await check(async () => {
  const said = vendorSays(path.join(tmp, 'fresh', '.claude', 'worktrees', 'brand-new-9k2'));
  assert.match(said, /ln -s \.\.\/\.\.\/\.\.\/node_modules node_modules/, said);
  assert.ok(!/run npm install/.test(said), `a worktree must not be told to install: ${said}`);
}, 'a fresh worktree is told to borrow the tree, not to install one');

await check(async () => {
  const said = vendorSays(path.join(tmp, 'installed', '.claude', 'worktrees', 'did-install-4d2'), { deps: 'real' });
  assert.match(said, /its own node_modules/, said);
  assert.match(said, /rm -rf node_modules && ln -s/, `with the way out of it: ${said}`);
}, 'a worktree that installed its own tree is told so, once, where somebody will see it');

await check(async () => {
  fs.mkdirSync(path.join(tmp, 'borrowing', 'node_modules'), { recursive: true });
  const said = vendorSays(path.join(tmp, 'borrowing', '.claude', 'worktrees', 'well-behaved-x1'), { deps: 'link' });
  assert.ok(!/ln -s/.test(said), `nothing to fix, nothing to say: ${said}`);
}, 'a worktree that already borrows is not nagged');

await check(async () => {
  const said = vendorSays(path.join(tmp, 'plain-checkout'));
  assert.match(said, /run npm install/, `the main checkout still gets the right advice: ${said}`);
  assert.ok(!/ln -s/.test(said), `and not the worktree one: ${said}`);
}, 'the main checkout is still told to run npm install, which is true there');

/* ----------------------------------------------- and what it stops copying (bc-oqu7) */

console.log('\nwhat a worktree borrows instead of copying');

/**
 * The other 500 MB. Once the dependency trees and the gradle output were gone,
 * `public/vendor` *was* the attic — 4.2 MB of every ~6 MB entry, the same seven files
 * 123 times — and it is the one thing `slimAttic` will not drop, because an entry
 * without it stops being resumable in one command. So it is borrowed instead.
 */
await check(async () => {
  const main = mainWithVendor(path.join(tmp, 'borrows'));
  const wt = path.join(main, '.claude', 'worktrees', 'borrowing-vendor-7a');
  const said = vendorSays(wt);
  assert.match(said, /7\/7 browser bundles/, said);
  const dir = path.join(wt, 'public', 'vendor');
  for (const name of BUNDLES) {
    assert.ok(fs.lstatSync(path.join(dir, name)).isSymbolicLink(), `${name} is a copy, not a link`);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), `/* ${name} */\n`, `${name} does not resolve`);
  }
}, 'a worktree links the seven at the main checkout rather than copying them');

await check(async () => {
  const main = mainWithVendor(path.join(tmp, 'no-deps'));
  const wt = path.join(main, '.claude', 'worktrees', 'never-installed-2c');
  const said = vendorSays(wt);
  // The whole of what a genuinely fresh worktree used to get was seven of these.
  assert.ok(!/missing /.test(said), `a worktree with no tree yet still needs no install: ${said}`);
  assert.match(said, /7\/7 browser bundles/, said);
}, 'and gets them before it has a dependency tree at all, which it could not before');

await check(async () => {
  const main = mainWithVendor(path.join(tmp, 'retire'));
  const wt = path.join(main, '.claude', 'worktrees', 'about-to-retire-5f');
  vendorSays(wt);
  // Retirement is a move, and `.claude/worktrees-retired/<name>` is the same depth as
  // `.claude/worktrees/<name>` — which is the whole reason the link is relative.
  const retired = path.join(main, '.claude', 'worktrees-retired', 'about-to-retire-5f');
  fs.mkdirSync(path.dirname(retired), { recursive: true });
  fs.renameSync(wt, retired);
  const one = path.join(retired, 'public', 'vendor', BUNDLES[0]);
  assert.ok(fs.lstatSync(one).isSymbolicLink(), 'retirement turned the link into something else');
  assert.equal(fs.readFileSync(one, 'utf8'), `/* ${BUNDLES[0]} */\n`, 'the link does not survive retirement');
}, 'the link still resolves once the worktree has been retired');

await check(async () => {
  const main = path.join(tmp, 'unbuilt-main');
  const wt = path.join(main, '.claude', 'worktrees', 'nothing-to-borrow-8d');
  fs.mkdirSync(path.join(wt, 'node_modules', 'marked', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules', 'marked', 'lib', 'marked.umd.js'), '/* real */\n');
  vendorSays(wt);
  const one = path.join(wt, 'public', 'vendor', 'marked.js');
  assert.ok(!fs.lstatSync(one).isSymbolicLink(), 'linked at a main checkout that has no vendor directory');
  assert.equal(fs.readFileSync(one, 'utf8'), '/* real */\n');
}, 'a main checkout that has not built its own vendor is copied from, not linked at');

await check(async () => {
  const main = mainWithVendor(path.join(tmp, 'was-a-copy'));
  const wt = path.join(main, '.claude', 'worktrees', 'upgrading-3b');
  // What every worktree made before bc-oqu7 has sitting there. `symlinkSync` refuses to
  // overwrite, so a second run has to remove first or the upgrade never happens.
  fs.mkdirSync(path.join(wt, 'public', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'public', 'vendor', BUNDLES[0]), 'stale copy\n');
  vendorSays(wt);
  const one = path.join(wt, 'public', 'vendor', BUNDLES[0]);
  assert.ok(fs.lstatSync(one).isSymbolicLink(), 'an existing copy was left in place');
  assert.equal(fs.readFileSync(one, 'utf8'), `/* ${BUNDLES[0]} */\n`);
}, 'a worktree that already carries copies is upgraded to links in place');

await check(async () => {
  const main = mainWithVendor(path.join(tmp, 'ignored'));
  const wt = path.join(main, '.claude', 'worktrees', 'git-status-1a');
  vendorSays(wt);
  // Seven links inside a real directory are ignored fine; a link where the directory
  // itself should be reads as `?? public/vendor` in git status AND breaks something else —
  // git refuses to resolve any path *underneath* a symlinked directory at all
  // ('fatal: pathspec ... is beyond a symbolic link'), which is what test/gitignoreresidue.mjs
  // hits (bc-0i27.25). bin/deliver.js also refuses the delivery over the git-status half,
  // after the suite has already passed.
  assert.ok(fs.lstatSync(path.join(wt, 'public', 'vendor')).isDirectory(), 'public/vendor itself must be a real directory');
}, 'the directory itself is never the link — a symlinked public/vendor breaks paths underneath it');

/* --------------------------------------------------------------------- report */

console.log(`\n${failures ? '\x1b[31m✗' : '\x1b[32m✓'} node_modules: ${ran - failures}/${ran} passed\x1b[0m\n`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* a locked worktree can hold a handle; the tmpdir is the OS's problem now */
}
process.exit(failures ? 1 : 0);
