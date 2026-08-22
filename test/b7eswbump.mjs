#!/usr/bin/env node
//
// b7e-swbump — which number a sw-cache bump takes, the note that argues for it, and the
// renumber a downmerge's add/add conflict asks for (bc-khoe.44).
//
//   npm test
//   node test/b7eswbump.mjs
//
// Real git throughout, in scratch repos with a real `origin` remote — the whole subject
// is what `origin/main` claims versus what this working directory happens to hold, and a
// fake filesystem would only agree with whatever the code under test assumed that
// distinction to be. Modelled on test/b7eworktree.mjs, which makes the same argument for
// its own sibling tool.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-swbump');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- fixtures */

/** git with an identity of its own, so this never depends on the machine's. */
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
const gitTry = (cwd, ...args) => {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (err) {
    return { ok: false, out: err.stdout || err.message };
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eswbump-'));

/** A minimal but real `public/sw.js`: one `const CACHE` line, one `SHELL` block. */
const sw = (version) =>
  ["const CACHE = 'beadcause-v" + version + "';", 'const SHELL = [', "  '/',", "  '/console.js',", "  '/sendqueue.js',", '];', ''].join('\n');

/** `docs/sw-cache/vNN.md` — genuinely argues, so it clears test/swcache.mjs's own length floor if ever pointed here. */
const note = (n, summary) =>
  [`# v${n} — ${summary}`, '', `This is the note for v${n}, written the same shape every real note in docs/sw-cache/ is: `, 'a heading, and an argument long enough to audit a month later rather than a bare name of the change.', ''].join('\n');

/** notes v1..vN, none of them a stub. */
function seedNotes(dir, upTo) {
  fs.mkdirSync(path.join(dir, 'docs', 'sw-cache'), { recursive: true });
  for (let n = 1; n <= upTo; n++) fs.writeFileSync(path.join(dir, 'docs', 'sw-cache', `v${n}.md`), note(n, `change number ${n}`));
}

function writeSw(dir, version) {
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public', 'sw.js'), sw(version));
}

function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

/** A bare-ish upstream at `beadcause-vN`, with notes v1..vN, on `main`. */
function makeUpstream(name, version) {
  const dir = path.join(tmp, `${name}-upstream`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeSw(dir, version);
  seedNotes(dir, version);
  // A baseline for both halves of the bc-dmt shape, so a branch that touches them is a
  // real *modification* — lib/swbump.js only calls a pair "coupled" between two files
  // that already existed; two files added together are never a mixed pair.
  fs.writeFileSync(path.join(dir, 'public', 'console.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'public', 'sendqueue.js'), '// nothing about repaint yet\n');
  commitAll(dir, 'init');
  return dir;
}

/** A local clone, with `origin/main` populated the normal way. */
function cloneLocal(upstream, name) {
  const dir = path.join(tmp, name);
  git(tmp, 'clone', '-q', upstream, dir);
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  return dir;
}

const run = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

/** The core invariants test/swcache.mjs itself checks, replayed here since that suite is pinned to this repo's own docs/sw-cache/, not a scratch one. */
function assertSwcacheInvariants(dir, label) {
  const swSrc = fs.readFileSync(path.join(dir, 'public', 'sw.js'), 'utf8');
  const declared = Number(swSrc.match(/beadcause-v(\d+)/)[1]);
  const entries = fs.readdirSync(path.join(dir, 'docs', 'sw-cache')).filter((f) => /^v\d+\.md$/.test(f));
  const numbers = entries.map((f) => Number(f.slice(1, -3))).sort((a, b) => a - b);
  check(`${label}: no gap or repeat in the notes`, (() => {
    for (let n = numbers[0]; n < numbers[numbers.length - 1]; n++) if (!numbers.includes(n)) return false;
    return new Set(numbers).size === numbers.length;
  })(), numbers.join(','));
  check(`${label}: const is the highest note`, declared === numbers[numbers.length - 1], `const v${declared}, highest v${numbers[numbers.length - 1]}`);
  const mislabelled = entries.filter((f) => {
    const first = fs.readFileSync(path.join(dir, 'docs', 'sw-cache', f), 'utf8').split('\n')[0];
    const m = first.match(/^# v(\d+) — \S/);
    return !m || Number(m[1]) !== Number(f.slice(1, -3));
  });
  check(`${label}: every note heads itself`, mislabelled.length === 0, mislabelled.join(', '));
}

/* ==================================================================== 1. no bump owed */

console.log('\nno bump owed: says so, writes nothing\n');
{
  const up = makeUpstream('none', 3);
  const local = cloneLocal(up, 'none-local');
  fs.writeFileSync(path.join(local, 'README.md'), 'unrelated edit\n');

  const before = fs.readdirSync(path.join(local, 'docs', 'sw-cache')).sort();
  const r = run(local);
  check('exits 0', r.status === 0, r.stderr);
  check('says no bump owed', /no bump owed/.test(r.stdout), r.stdout);
  check('writes no new note', fs.readdirSync(path.join(local, 'docs', 'sw-cache')).sort().join(',') === before.join(','));
  check('leaves public/sw.js untouched', fs.readFileSync(path.join(local, 'public', 'sw.js'), 'utf8') === sw(3));
}

/* ==================================================================== 2. advisory only */

console.log('\nadvisory only: two shell files moved, no coupling — reported, not bumped\n');
{
  const up = makeUpstream('advisory', 3);
  const local = cloneLocal(up, 'advisory-local');
  fs.writeFileSync(path.join(local, 'public', 'console.js'), 'const a = 2;\n');
  fs.writeFileSync(path.join(local, 'public', 'sendqueue.js'), '// still nothing about repaint\n');

  const r = run(local);
  check('exits 0', r.status === 0, r.stderr);
  check('names it an advisory, judgement left to the reader', /advisory only/.test(r.stdout), r.stdout);
  check('writes no new note', fs.readdirSync(path.join(local, 'docs', 'sw-cache')).length === 3);
  check('leaves public/sw.js untouched', fs.readFileSync(path.join(local, 'public', 'sw.js'), 'utf8') === sw(3));
}

/* ==================================================================== 3. --check */

console.log('\n--check: reports the verdict, writes nothing\n');
{
  const up = makeUpstream('check', 5);
  const local = cloneLocal(up, 'check-local');
  fs.writeFileSync(path.join(local, 'public', 'sendqueue.js'), 'repaint: announce,\n');
  fs.writeFileSync(path.join(local, 'public', 'console.js'), 'chat.queue.repaint();\n');

  const r = run(local, ['--check']);
  check('exits 0', r.status === 0, r.stderr);
  check('says a bump is owed', /bump is owed/.test(r.stdout), r.stdout);
  check('writes no new note', fs.readdirSync(path.join(local, 'docs', 'sw-cache')).length === 5);
  check('leaves public/sw.js untouched', fs.readFileSync(path.join(local, 'public', 'sw.js'), 'utf8') === sw(5));
}

/* ============================================== 4. a real coupling: prints, writes, bumps */

console.log('\na branch that pairs two shell files: takes the number, writes the note, bumps the const\n');
{
  const up = makeUpstream('bump', 76);
  const local = cloneLocal(up, 'bump-local');
  // The bc-dmt shape, verbatim: a member gained in one shell file, called from another.
  fs.writeFileSync(path.join(local, 'public', 'sendqueue.js'), 'repaint: announce,\n');
  fs.writeFileSync(path.join(local, 'public', 'console.js'), 'chat.queue.repaint();\n');

  const r = run(local);
  check('exits 0', r.status === 0, r.stderr);
  check('names the pair', /calls \.repaint\(\), which .*sendqueue\.js only gained on this branch/.test(r.stdout), r.stdout);
  check('took v77', /took v77/.test(r.stdout), r.stdout);
  check('wrote docs/sw-cache/v77.md', fs.existsSync(path.join(local, 'docs', 'sw-cache', 'v77.md')));
  check('bumped the const', fs.readFileSync(path.join(local, 'public', 'sw.js'), 'utf8') === sw(77));

  const noteBody = fs.readFileSync(path.join(local, 'docs', 'sw-cache', 'v77.md'), 'utf8');
  check('heading is v77 with an em dash', /^# v77 — /.test(noteBody), noteBody.split('\n')[0]);
  check('argues for itself rather than only naming the change', noteBody.split('\n').slice(2).join(' ').trim().length >= 200, `${noteBody.length} chars total`);
  check('names the files that changed', /public\/console\.js/.test(noteBody) && /public\/sendqueue\.js/.test(noteBody), noteBody);

  assertSwcacheInvariants(local, 'after a real bump');

  console.log('\nrunning it again on the now-bumped branch says so and writes nothing further\n');
  const r2 = run(local);
  check('exits 0', r2.status === 0, r2.stderr);
  check('reports already bumped', /already bumped/.test(r2.stdout), r2.stdout);
  check('does not write a second note', fs.readdirSync(path.join(local, 'docs', 'sw-cache')).length === 77);
}

/* ============================== 5. a sibling worktree's unmerged note is not evidence ============================== */

console.log("\na stray local note (a sibling worktree's, say) does not move the number off origin/main's\n");
{
  const up = makeUpstream('sibling', 40);
  const local = cloneLocal(up, 'sibling-local');
  // Simulate what bc-ka5y.15.3 actually saw: v41.md already sitting in this checkout,
  // uncommitted, as if a sibling worktree's unmerged claim had leaked in. It never can
  // in reality — worktrees are separate directories — but the number must come out the
  // same whether or not this file happens to exist locally, and this is the cheapest way
  // to prove that rather than merely asserting it.
  fs.writeFileSync(path.join(local, 'docs', 'sw-cache', 'v41.md'), note(41, 'a sibling worktree\'s unmerged claim'));
  fs.writeFileSync(path.join(local, 'public', 'sendqueue.js'), 'repaint: announce,\n');
  fs.writeFileSync(path.join(local, 'public', 'console.js'), 'chat.queue.repaint();\n');

  const r = run(local);
  check('exits 0', r.status === 0, r.stderr);
  check("takes origin/main's highest + 1 (v41), not v42 past the stray file", /took v41/.test(r.stdout), r.stdout);
  check('the stray v41.md is overwritten by the real bump, not skipped past', fs.readFileSync(path.join(local, 'docs', 'sw-cache', 'v41.md'), 'utf8') !== note(41, "a sibling worktree's unmerged claim"));
  check('bumped the const to v41, not v42', fs.readFileSync(path.join(local, 'public', 'sw.js'), 'utf8') === sw(41));
}

/* ==================================================================== 6. --against */

console.log('\n--against compares against a named ref instead of origin/main\n');
{
  const up = makeUpstream('against', 10);
  const local = cloneLocal(up, 'against-local');
  git(local, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(local, 'public', 'sendqueue.js'), 'repaint: announce,\n');
  fs.writeFileSync(path.join(local, 'public', 'console.js'), 'chat.queue.repaint();\n');
  commitAll(local, 'feature work');
  git(local, 'checkout', '-q', '-b', 'downstream');
  fs.writeFileSync(path.join(local, 'README.md'), 'more\n');

  const r = run(local, ['--against', 'feature']);
  check('exits 0', r.status === 0, r.stderr);
  check('no bump owed against feature — the coupling is already behind it', /no bump owed/.test(r.stdout), r.stdout);

  const r2 = run(local, ['--against', 'main']);
  check('exits 0 against main too', r2.status === 0, r2.stderr);
  check('the coupling shows up against main, since feature has not landed there', /took v11/.test(r2.stdout), r2.stdout);
}

check('bad --against ref is refused, exit 2', (() => {
  const up = makeUpstream('badref', 3);
  const local = cloneLocal(up, 'badref-local');
  const r = run(local, ['--against', 'not-a-real-ref']);
  return r.status === 2;
})());

/* ==================================================================== 7. --renumber */

console.log('\n--renumber: keeps theirs, moves ours, retargets the const, leaves no gap\n');
{
  const up = makeUpstream('renumber', 3);
  const local = cloneLocal(up, 'renumber-local');

  // This branch claims v4 first.
  fs.writeFileSync(path.join(local, 'docs', 'sw-cache', 'v4.md'), note(4, "this branch's own change"));
  fs.writeFileSync(path.join(local, 'public', 'sw.js'), sw(4));
  commitAll(local, 'this branch bumps to v4');

  // Meanwhile origin/main lands its own, unrelated v4 — same const string, different note.
  fs.writeFileSync(path.join(up, 'docs', 'sw-cache', 'v4.md'), note(4, "main's own, different change"));
  fs.writeFileSync(path.join(up, 'public', 'sw.js'), sw(4));
  commitAll(up, 'main bumps to v4 first');

  git(local, 'fetch', '-q', 'origin');
  const merge = gitTry(local, 'merge', '--no-edit', 'origin/main');
  check('the merge conflicts (an add/add on the note)', !merge.ok, merge.out);

  const status = git(local, 'status', '--porcelain');
  check('git reports it as an unresolved AA on docs/sw-cache/v4.md', /^AA docs\/sw-cache\/v4\.md$/m.test(status), status);
  check('public/sw.js merged clean and silent (identical const string on both sides)', !/^(AA|UU) public\/sw\.js$/m.test(status), status);

  const r = run(local, ['--renumber']);
  check('exits 0', r.status === 0, r.stderr);

  check("kept main's v4.md at v4", fs.readFileSync(path.join(local, 'docs', 'sw-cache', 'v4.md'), 'utf8') === note(4, "main's own, different change"));
  check('moved this branch\'s note to v5.md', fs.existsSync(path.join(local, 'docs', 'sw-cache', 'v5.md')));
  const moved = fs.readFileSync(path.join(local, 'docs', 'sw-cache', 'v5.md'), 'utf8');
  check('the moved note is headed v5', /^# v5 — this branch's own change$/m.test(moved), moved.split('\n')[0]);
  check('the moved note carries a ## The number section', /## The number/.test(moved), moved);
  check('const CACHE retargeted to v5, the new highest', fs.readFileSync(path.join(local, 'public', 'sw.js'), 'utf8') === sw(5));
  check('leaves no gap', (() => {
    const numbers = fs
      .readdirSync(path.join(local, 'docs', 'sw-cache'))
      .filter((f) => /^v\d+\.md$/.test(f))
      .map((f) => Number(f.slice(1, -3)))
      .sort((a, b) => a - b);
    return JSON.stringify(numbers) === JSON.stringify([1, 2, 3, 4, 5]);
  })());

  const statusAfter = git(local, 'status', '--porcelain');
  check('all three resolved paths are staged, none left as AA/UU', !/^(AA|UU)/m.test(statusAfter), statusAfter);

  assertSwcacheInvariants(local, 'after --renumber');

  console.log('\nrunning --renumber again, with nothing left to resolve, refuses rather than guessing\n');
  const r2 = run(local, ['--renumber']);
  check('exits 1', r2.status === 1, r2.stdout);
  check('says there is nothing to resolve', /no unresolved add\/add/.test(r2.stderr), r2.stderr);
}

/* ==================================================================== */

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
