/**
 * Which lines each side changed — against real git, because the derivation is the claim.
 *
 * lib/regions.js exists so a claim refusal can tell apart the two collisions that read
 * identically without it: two sessions rewriting one function, and two sessions at
 * opposite ends of a long file. Only the first is a conflict, and a warning that shouts
 * equally at both is one you learn to skip (bc-zedm).
 *
 *     node test/regions.mjs
 *
 * Every case here builds a real repository with real worktrees and really edits them.
 * There is no faking git for this: the whole assertion is about what `merge-base` and
 * `diff --unified=0` actually report, and a stub would only prove that the parser can
 * read strings this file wrote. What is worth asserting:
 *
 *   - **disjoint edits do not read as a conflict** — the case that makes the message
 *     worth having, and the one a coarse warning gets wrong;
 *   - **overlapping edits do**, including when they overlap only through git's three
 *     lines of merge context rather than on a shared line;
 *   - **uncommitted work counts** — a session mid-edit has its changes in the working
 *     tree, and a reading that saw only commits would call a busy session idle;
 *   - **a file neither branch's base has** is total, not empty;
 *   - **it fails open** — no git, no repo, no answer, and the refusal falls back to the
 *     wording it had before any of this existed. A hung guard in front of every edit on
 *     this Mac is a worse failure than a thin warning.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-regions-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { regionsForClaim, regionsForCollision, overlaps, render } = await import(
  path.join(HERE, '..', 'lib', 'regions.js')
);
const { refusalFor } = await import(path.join(HERE, '..', 'lib', 'claims.js'));

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
const line = (n) => `  const line${n} = ${n};`;

fs.mkdirSync(path.join(REPO, 'lib'), { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 'test@localhost');
git(REPO, 'config', 'user.name', 'test');

/** Forty numbered lines, so an assertion can name a region and mean it. */
const BASE = Array.from({ length: 40 }, (_, i) => line(i + 1)).join('\n') + '\n';
fs.writeFileSync(path.join(REPO, FILE), BASE);
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'base');

/**
 * A worktree, and the claim record that would have been made from it.
 *
 * `dir` and `branch` are exactly what `scripts/claim-guard.sh` posts, so the fixture is
 * the shape the daemon really sees rather than one convenient for the test.
 */
function tree(name) {
  const dir = path.join(tmp, name);
  git(REPO, 'worktree', 'add', '-q', '-b', `wt-${name}`, dir, 'main');
  return {
    dir,
    session: name,
    branch: `wt-${name}`,
    file: FILE,
    /** Rewrite a run of lines in place, so the hunk lands where the case says it does. */
    edit(from, to, text = 'CHANGED') {
      const lines = fs.readFileSync(path.join(dir, FILE), 'utf8').split('\n');
      for (let n = from; n <= to; n += 1) lines[n - 1] = `  const line${n} = '${text}';`;
      fs.writeFileSync(path.join(dir, FILE), lines.join('\n'));
      return this;
    },
    commit(msg = 'work') {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', msg);
      return this;
    },
    write(rel, body) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
      return this;
    },
  };
}

/** What `claim()` hands `refusalFor` on a refusal, without needing the register itself. */
const conflict = (mine, holders, file = FILE) => ({
  decision: 'conflict',
  record: { ...mine, file },
  holders: holders.map((h) => ({ ...h, file })),
  sameTree: holders.some((h) => h.dir === mine.dir),
});

/* --------------------------------------------------------------------- cases */

const a = tree('alpha');
const b = tree('bravo');

await check('opposite ends of one file are different regions, not a conflict', async () => {
  a.edit(4, 6).commit();
  b.edit(30, 32).commit();

  const out = conflict(b, [a]);
  const r = await regionsForClaim(out);
  assert.ok(r, 'a reading was possible');
  assert.equal(r.overlap, false, 'lines 4–6 and 30–32 do not collide');

  const reason = refusalFor(FILE, out, r);
  assert.match(reason, /4–6/, 'the holder’s lines are named');
  assert.match(reason, /30–32/, 'and so are yours');
  assert.match(reason, /merge them cleanly/, 'and the verdict is the honest one');
  assert.doesNotMatch(reason, /conflict at downmerge/, 'which is the whole point of the change');
});

await check('the same lines are a conflict, and it says so', async () => {
  const c = tree('charlie').edit(4, 6, 'OTHER').commit();

  const out = conflict(c, [a]);
  const r = await regionsForClaim(out);
  assert.equal(r.overlap, true);

  const reason = refusalFor(FILE, out, r);
  assert.match(reason, /same region of the merge base/);
  assert.match(reason, /conflict at downmerge, not a maybe/);
  assert.doesNotMatch(reason, /merge them cleanly/);
});

await check('near-misses inside git’s own context window still collide', async () => {
  // Lines 4–6 against lines 8–9: no shared line, two apart. Git merges with three lines
  // of context either side, so these two hunks *do* conflict — a comparison that only
  // looked for a shared line would promise a clean merge and be wrong.
  const d = tree('delta').edit(8, 9).commit();

  const r = await regionsForClaim(conflict(d, [a]));
  assert.equal(r.overlap, true, 'two lines apart is inside the three-line context');
});

await check('uncommitted work counts — a session mid-edit is not idle', async () => {
  const e = tree('echo').edit(20, 21); // deliberately not committed
  const r = await regionsForClaim(conflict(e, [a]));

  assert.ok(r.holders[0].mine.now.length, 'the working tree is read, not just the branch');
  assert.match(refusalFor(FILE, conflict(e, [a]), r), /20–21/);
});

await check('a file neither base has is total, not empty', async () => {
  const f = tree('foxtrot').write('lib/brand-new.js', 'export const x = 1;\n');
  const g = tree('golf').write('lib/brand-new.js', 'export const y = 2;\n');

  const out = conflict(g, [f], 'lib/brand-new.js');
  const r = await regionsForClaim(out);
  assert.equal(r.overlap, true, 'two sessions creating one file collide on every line of it');
  assert.match(refusalFor('lib/brand-new.js', out, r), /does not exist in the merge base/);
});

await check('a path that exists in neither tree is not "you are both creating it"', async () => {
  // A Write that was refused never created its file, so the claim names a path the holder
  // does not have. Untracked and absent are not the same fact, and only the first is a
  // collision — the other is a claim on a file nobody has written yet.
  const j = tree('juliett');
  const k = tree('kilo');
  const out = conflict(k, [j], 'lib/never-written.js');
  const r = await regionsForClaim(out);

  assert.equal(r.overlap, false, 'nothing on either side is not a collision');
  assert.doesNotMatch(refusalFor('lib/never-written.js', out, r), /both creating it/);
});

await check('more holders than the message can carry says how many it left', async () => {
  const crowd = ['lima', 'mike', 'november', 'oscar'].map((n, i) => tree(n).edit(2 + i * 6, 3 + i * 6).commit());
  const p = tree('papa').edit(38, 39).commit();

  const out = conflict(p, crowd);
  const r = await regionsForClaim(out);
  assert.equal(r.holders.length, 3, 'capped');
  assert.equal(r.unread, 1, 'and the cap is a number, not a silence');
  assert.match(refusalFor(FILE, out, r), /1 further holder is on it, unread/);
});

await check('before your first edit there is nothing of yours to compare', async () => {
  const h = tree('hotel'); // has touched nothing
  const out = conflict(h, [a]);
  const r = await regionsForClaim(out);

  assert.equal(r.overlap, false);
  const reason = refusalFor(FILE, out, r);
  assert.match(reason, /4–6/, 'where they are is still worth knowing');
  assert.match(reason, /not changed this file yet/);
  assert.doesNotMatch(reason, /do not touch/, 'no claim is made about a merge with one side empty');
});

await check('two sessions in one checkout are told where that checkout is dirty', async () => {
  const i = tree('india').edit(12, 14);
  const shared = { ...i, session: 'other-session-same-tree' };

  const out = conflict(i, [shared]);
  assert.equal(out.sameTree, true);
  const r = await regionsForClaim(out);
  assert.equal(r.sameTree, true);

  const reason = refusalFor(FILE, out, r);
  assert.match(reason, /12–14/);
  assert.match(reason, /bc-utyr/, 'and it is still the hard stop it was');
  assert.doesNotMatch(reason, /Repeat the edit/);
});

await check('a collision can be read without anybody claiming anything', async () => {
  const r = await regionsForCollision({ file: FILE, sessions: [a, b], sameTree: false });
  assert.equal(r.overlap, false, 'the same reading, from GET /api/claims');
  assert.equal(await regionsForCollision({ file: FILE, sessions: [a] }), null, 'one session is not a collision');
});

/* ---------------------------------------------------------------- failing open */

await check('a directory git cannot answer for yields no regions, not an error', async () => {
  const nowhere = { dir: path.join(tmp, 'not-a-repo'), session: 'x', branch: '', file: FILE };
  fs.mkdirSync(nowhere.dir, { recursive: true });
  assert.equal(await regionsForClaim(conflict(nowhere, [a])), null);
});

await check('a claim with no worktree on it yields no regions', async () => {
  assert.equal(await regionsForClaim(conflict({ session: 'x', file: FILE }, [a])), null);
  assert.equal(await regionsForClaim({ decision: 'held', record: a, holders: [] }), null, 'nor does a clean claim');
});

await check('and the refusal without regions is exactly the one it always was', () => {
  const reason = refusalFor(FILE, conflict(b, [a]), null);
  assert.match(reason, /one of you will resolve it at downmerge/);
  assert.match(reason, /Repeat the edit to claim it anyway/);
});

/* ------------------------------------------------------------------ unit bits */

await check('ranges are rendered as a person reads them', () => {
  assert.equal(render([{ from: 5, to: 5 }]), '5');
  assert.equal(render([{ from: 5, to: 9 }]), '5–9');
  assert.equal(render([{ from: 5, to: 5, insert: true }]), 'after 5', 'an insertion is between lines, not on one');
  assert.equal(render([]), '');
  const many = Array.from({ length: 9 }, (_, i) => ({ from: i + 1, to: i + 1 }));
  assert.match(render(many), /\+3 more$/, 'a long list is capped, and says that it was');
});

await check('overlap is padded by git’s context and by nothing else', () => {
  const at = (from, to) => [{ from, to }];
  assert.equal(overlaps(at(10, 12), at(11, 11)), true, 'contained');
  assert.equal(overlaps(at(10, 12), at(18, 20)), true, 'three lines of context each way still meet');
  assert.equal(overlaps(at(10, 12), at(19, 20)), false, 'and one line further apart is genuinely clear');
  assert.equal(overlaps([], at(10, 12)), false, 'nothing collides with nothing');
});

/* -------------------------------------------------------------------- report */

cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} regions checks passed`);
process.exit(failures ? 1 : 0);
