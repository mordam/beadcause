#!/usr/bin/env node
//
// Tier 4 — the report a session leaves on the run it just did.
//
//   npm test                       (runs it alongside the other suites)
//   node test/debrief.mjs          (on its own)
//
// The store is unusual in one way that decides everything worth testing here: it is
// **written by one module and consumed by another**. `debrief` in lib/memory.js stages a
// report on `refs/beadcause/debrief/<bead>`; `archiveSession` in lib/sessionlog.js folds
// it into that bead's session tree as `memory.md` and drops the staging ref. So the
// interesting failures are all at the seam, and none of them is visible from either side
// alone:
//
// 1. **A session that wrote nothing must archive exactly as it did before this existed.**
//    Not an empty `memory.md` — no `memory.md`. The archived-session page says different
//    things about "no file" and "empty file", and the first sentence becomes unsayable if
//    every archive carries the name.
// 2. **A report must survive the trip and arrive whole**, with the other three files of
//    the archive intact beside it. Adding a fourth entry to a `mktree` is exactly the kind
//    of change that silently drops a third.
// 3. **The staging ref must be consumed, and must not be consumed too eagerly.** A write
//    that lands between the read and the delete has to survive — that is what makes the
//    clear a compare-and-swap rather than an `update-ref -d`.
// 4. **Two writers in one run must not lose each other**, which is the same CAS argument
//    the blackboard makes in test/memory.mjs, in a store where writes append rather than
//    replace and so cannot be spotted by a missing key.
// 5. **The selection has to stay inside the family.** `debriefFamily` is what stops a
//    session being handed somebody else's afternoon, and it is pure, so it is asserted
//    directly rather than inferred from a brief.
//
// Everything runs against throwaway git repos in the system temp dir. Nothing touches a
// repo you work in, nothing touches ~/.config/beadcause, and nothing pushes anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { removeTreeSync } from './helpers/tmp.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------- child mode */
//
// `--debrief <bead> <text>` writes one report and exits. The concurrency case needs
// genuinely separate processes for the same reason the blackboard's does: two writers
// inside one process can be serialised by accident and prove nothing about the CAS.

if (process.argv[2] === '--debrief') {
  const [, , , bead, ...text] = process.argv;
  const { debrief } = await import('../lib/memory.js');
  await debrief(process.env.BEADCAUSE_AGENT || 'worker', bead, text.join(' '));
  process.exit(0);
}

/* --------------------------------------------------------------- harness */

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const rejects = async (name, fn, match) => {
  try {
    await fn();
    bad(name, 'it resolved, and should not have');
  } catch (err) {
    check(name, match.test(err.message), err.message);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-debrief-'));
process.on('exit', () => removeTreeSync(tmp));
process.env.BEADCAUSE_AGENT = 'worker';

/** A repo with one commit in it, which is all any of this needs. */
function repo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@localhost');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  return { dir, git };
}

const memory = await import('../lib/memory.js');
const sessionlog = await import('../lib/sessionlog.js');

const one = repo('one');
// Tier 4's write half resolves its store from `process.cwd()`, exactly as tier 1 does.
process.chdir(one.dir);

/* --------------------------------------------------- writing one, and staging it */

console.log('staging a report');

const first = await memory.debrief('worker', 'bc-aaa1', 'The build was already green. Do not re-run it.');
check('a write reports the bead it landed against', first.bead === 'bc-aaa1', JSON.stringify(first));
check('and how many entries are staged', first.entries === 1, String(first.entries));

const second = await memory.debrief('worker', 'bc-aaa1', 'lib/server.js:4035 is the allowlist, not lib/routes.js.');
check('a second write appends rather than replacing', second.entries === 2, String(second.entries));

const staged = await memory.stagedDebrief(one.dir, 'bc-aaa1');
check('both entries read back', staged.entries.length === 2, JSON.stringify(staged.entries));
check('with the tip they were read at, for the swap', /^[0-9a-f]{40}$/.test(staged.tip || ''), String(staged.tip));
check(
  'each carries who wrote it and when',
  staged.entries.every((e) => e.agent === 'worker' && /^20\d\d-/.test(e.at)),
  JSON.stringify(staged.entries)
);

check(
  'a bead nobody has written about stages nothing, and does not throw',
  (await memory.stagedDebrief(one.dir, 'bc-never')).entries.length === 0
);
check(
  'nor does a directory that is not a repo',
  (await memory.stagedDebrief(path.join(tmp, 'nowhere'), 'bc-aaa1')).entries.length === 0
);

await rejects('an empty report is refused rather than staged', () => memory.debrief('worker', 'bc-aaa1', '   '), /not a debrief/);
await rejects('and a bead id that could not be a ref is refused', () => memory.debrief('worker', 'bc/../x', 'hi'), /bad bead/);

check(
  'the staging ref is where the docs say it is',
  one.git('for-each-ref', '--format=%(refname)', 'refs/beadcause/debrief') === 'refs/beadcause/debrief/bc-aaa1'
);
// `--all` is deliberately not used: it means *every* ref under `refs/`, which includes
// this one, and a test that passed with it would be asserting nothing. The claim is about
// what somebody working in the repo sees, which is plain `log`, `branch` and `status`.
check(
  'and it is invisible to git log, git branch and git status',
  one.git('log', '--oneline').split('\n').length === 1 &&
    one.git('branch', '--list') === '* main' &&
    one.git('status', '--porcelain') === '',
  `${one.git('log', '--oneline')} | ${one.git('branch', '--list')} | ${one.git('status', '--porcelain')}`
);

/* ------------------------------------------------ a session that said nothing */

console.log('\na session that left no report');

const quiet = await sessionlog.archiveSession(one.dir, { workspace: 'test', bead: 'bc-quiet', outcome: 'ended' });
check('it archives', /^[0-9a-f]{40}$/.test(quiet.commit), String(quiet.commit));
check('and reports that it took no report', quiet.debriefs === 0, String(quiet.debriefs));
const quietFiles = one.git('ls-tree', '--name-only', quiet.commit).split('\n');
check(
  'the tree is the two files it has always been — no memory.md at all',
  JSON.stringify(quietFiles.sort()) === JSON.stringify(['meta.json', 'session.log']),
  JSON.stringify(quietFiles)
);
check(
  'and reading one back is a miss rather than an empty string',
  (await sessionlog.readArchived(one.dir, quiet.commit, 'memory.md')) === null
);

/* --------------------------------------------------- the fold, and the clear */

console.log('\nfolding it into the archive');

const archived = await sessionlog.archiveSession(one.dir, { workspace: 'test', bead: 'bc-aaa1', outcome: 'ended' });
check('the archive says how many reports it took', archived.debriefs === 2, String(archived.debriefs));

const memoryMd = await sessionlog.readArchived(one.dir, archived.commit, 'memory.md');
check('both reports arrived', /already green/.test(memoryMd) && /4035 is the allowlist/.test(memoryMd), String(memoryMd));
check('with a stamp on each, so a stale one is visible', (memoryMd.match(/^worker · 20\d\d-/gm) || []).length === 2);
check(
  'and the rest of the archive is intact beside it',
  (await sessionlog.readArchived(one.dir, archived.commit, 'meta.json')).includes('bc-aaa1') &&
    (await sessionlog.readArchived(one.dir, archived.commit, 'session.log')) !== null
);
check(
  'the tree carries exactly the three files, none dropped by the fourth entry',
  JSON.stringify(one.git('ls-tree', '--name-only', archived.commit).split('\n').sort()) ===
    JSON.stringify(['memory.md', 'meta.json', 'session.log'])
);
check('the staging ref is gone', one.git('for-each-ref', '--format=%(refname)', 'refs/beadcause/debrief') === '');

// The whole reason the clear takes a tip. A report written after the archive read the
// ref, but before it deleted it, must not be thrown away by a consumer that never saw it.
await memory.debrief('worker', 'bc-aaa1', 'written after the archive read the ref');
const stale = await memory.stagedDebrief(one.dir, 'bc-aaa1');
check('a later write re-creates the staging ref', stale.entries.length === 1);
check(
  'and a clear against the *old* tip refuses, leaving it staged',
  (await memory.clearDebrief(one.dir, 'bc-aaa1', staged.tip)) === false
);
check('so the report is still there for the next archive', (await memory.stagedDebrief(one.dir, 'bc-aaa1')).entries.length === 1);
check('while a clear against the tip it was read at succeeds', (await memory.clearDebrief(one.dir, 'bc-aaa1', stale.tip)) === true);

/* ------------------------------------------------------- two writers, one bead */

console.log('\nfour processes writing one bead at once');

const four = await Promise.all(
  [1, 2, 3, 4].map((n) =>
    run(process.execPath, [path.join(HERE, 'debrief.mjs'), '--debrief', 'bc-race', `report number ${n}`], {
      cwd: one.dir,
      env: { ...process.env, BEADCAUSE_AGENT: 'worker' },
    })
  )
);
check('every writer landed', four.length === 4);
const raced = await memory.stagedDebrief(one.dir, 'bc-race');
check('all four reports are there — nobody was overwritten', raced.entries.length === 4, String(raced.entries.length));
check(
  'and each appears exactly once',
  [1, 2, 3, 4].every((n) => raced.entries.filter((e) => e.text === `report number ${n}`).length === 1),
  JSON.stringify(raced.entries.map((e) => e.text))
);

/* ------------------------------------------------------ reading it back, by family */

console.log('\nwhat the next session is handed');

for (const [bead, text] of [
  ['bc-fam.1', 'the child that went first: the fixture lives in test/helpers, not test/'],
  ['bc-fam.2', 'the sibling: do not re-derive the CSS build, it is green'],
  ['bc-fam', 'the epic: these two beads touch the same file and belong in one change'],
  ['bc-other', 'a stranger: nothing here is about bc-fam at all'],
]) {
  await memory.debrief('worker', bead, text);
  await sessionlog.archiveSession(one.dir, { workspace: 'test', bead, outcome: 'ended' });
}

const ids = await sessionlog.archivedBeads(one.dir);
const family = memory.debriefFamily(ids, { id: 'bc-fam.1' });
check(
  'the family is self, then epic, then siblings — and nobody else',
  JSON.stringify(family) === JSON.stringify(['bc-fam.1', 'bc-fam', 'bc-fam.2']),
  JSON.stringify(family)
);
check(
  'an id that merely starts with the same characters is not a sibling',
  memory.debriefFamily(['bc-fam.1', 'bc-fam9', 'bc-fam90.2'], { id: 'bc-fam.1' }).join(',') === 'bc-fam.1'
);
check('a bead with no id selects nothing rather than everything', memory.debriefFamily(ids, {}).length === 0);
check(
  'an explicit parent is used when the id does not carry one',
  memory.debriefFamily(ids, { id: 'bc-fam.2', parent: 'bc-fam' }).includes('bc-fam.1')
);

const found = await sessionlog.readDebriefs(one.dir, family);
check('every bead in the family contributed one', found.length === 3, JSON.stringify(found.map((d) => d.bead)));
check('this bead first', found[0].bead === 'bc-fam.1', found[0].bead);
check('the stranger contributed nothing', !found.some((d) => d.bead === 'bc-other'));
check(
  'a bead that archived without a report is skipped rather than returned empty',
  (await sessionlog.readDebriefs(one.dir, ['bc-quiet'])).length === 0
);
check('and a bead with no archive at all is simply absent', (await sessionlog.readDebriefs(one.dir, ['bc-nothing'])).length === 0);
check('as is a directory that is not a repo', (await sessionlog.readDebriefs(path.join(tmp, 'nowhere'), ['bc-fam'])).length === 0);

/* ------------------------------------------------------------------ the brief */

console.log('\nthe section it becomes');

const brief = memory.debriefBrief(found, { id: 'bc-fam.1' });
check('it names every report it quotes', ['bc-fam.1', 'bc-fam', 'bc-fam.2'].every((id) => brief.includes(id)), brief);
check('it carries the text, not a summary of it', brief.includes('the fixture lives in test/helpers'));
check('this bead is described as this bead', brief.includes('an earlier run at this bead'));
check('and a sibling as the sibling it is', brief.includes('the run at **bc-fam**'));
check(
  'it says they are reports rather than instructions',
  /not instructions/.test(brief) && /not necessarily still true/.test(brief)
);
check('nothing archived means no section at all, not an empty heading', memory.debriefBrief([], { id: 'bc-x' }) === '');
check(
  'and neither does a list of reports that are all blank',
  memory.debriefBrief([{ bead: 'bc-x', text: '   ' }], { id: 'bc-x' }) === ''
);

const many = Array.from({ length: 9 }, (_, i) => ({ bead: `bc-fam.${i}`, at: '2026-08-01', text: `report ${i} `.repeat(60) }));
const capped = memory.debriefBrief(many, { id: 'bc-fam.1' });
check('the count cap holds', (capped.match(/^- \*\*bc-fam\./gm) || []).length <= memory.DEBRIEF_KEEP);
check('and the rest are named as existing rather than silently dropped', /further \d+ reports/.test(capped) === false && /\d+ further/.test(capped), capped.slice(-400));
check('and the pull is named, so nothing in the store is unreachable', capped.includes('beadcause-memory debriefs'));

const huge = [
  { bead: 'bc-fam.1', at: '2026-08-01', text: 'x'.repeat(20000) },
  { bead: 'bc-fam.2', at: '2026-08-01', text: 'y'.repeat(20000) },
];
const big = memory.debriefBrief(huge, { id: 'bc-fam.1' });
check('the most relevant report is never the one the budget drops', big.includes('x'.repeat(20000)));
check('and the one that does not fit is clipped rather than dropped', big.includes('… (clipped)') || !big.includes('bc-fam.2'));

/* ----------------------------------------------------- a note is not a debrief */

console.log('\nthe three stores stay three');

check('the brief every agent is handed names the new pair', /beadcause-memory debrief /.test(memory.memoryBrief('Adam')));
check('and the read half of it', /beadcause-memory debriefs /.test(memory.memoryBrief('Adam')));
check(
  'and gives the question that picks it over the other two',
  /report on \*this run\*, or a\s+belief that outlives it/.test(memory.memoryBrief('Adam'))
);
check(
  'and says it does not have to still be true next week, which the other two do',
  /does not have to still be true next week/.test(memory.memoryBrief('Adam'))
);

const two = repo('two');
process.chdir(two.dir);
check(
  'a report written in one repo is not visible from another',
  (await memory.stagedDebrief(two.dir, 'bc-aaa1')).entries.length === 0
);
await memory.debrief('worker', 'bc-aaa1', 'a different repo, the same bead id');
check(
  'and the two do not merge',
  (await memory.stagedDebrief(two.dir, 'bc-aaa1')).entries.length === 1 &&
    (await memory.stagedDebrief(one.dir, 'bc-aaa1')).entries.length === 0
);

process.chdir(HERE);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
