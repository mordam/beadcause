#!/usr/bin/env node
/**
 * lib/prboard.js — how far each pull request actually got.
 *
 *     npm test
 *     node test/prboard.mjs
 *
 * The board's whole value is that its four lamps are *true*, so this test is built
 * around the ways they could quietly stop being — and around the ladder they add up to,
 * which is `stageOf` in lib/prstage.js and is now the one place a status is decided:
 *
 * 1. **A null drawn as a no.** Every ancestry question here has three answers, and the
 *    third one — this Mac has never fetched that commit, this repo has no deploy the
 *    daemon can see — must never collapse into `false`. That is the one failure that
 *    would make the screen actively lie: "not pushed" when the truth is "nobody
 *    looked". So the assertions check for `null` identically, not for falsiness.
 * 2. **Live drifting to mean "newest".** It means *the commit this process booted from*
 *    and nothing after it. A merge that landed while the daemon was running must not read
 *    as live, and that is asserted against a boot commit deliberately set two commits
 *    behind the tip. `Deployed` is the weaker claim beside it — a deploy of this repo that
 *    ran after the merge — and the two are asserted apart, because collapsing them is how
 *    "a deploy ran" would come to be drawn as "this is what is running".
 * 3. **`landLocally` touching a checkout with edited work in it.** Adam edits inside
 *    these repos while sessions run. A fast-forward over uncommitted work, triggered
 *    from a phone in another room, is the most destructive thing this file could do —
 *    so the test dirties the tree and asserts that nothing moved. Untracked residue is
 *    the deliberate exception (bc-45g8) and is asserted from both sides: a `.DS_Store`
 *    does *not* stop the fast-forward, and an untracked file the incoming commit would
 *    have written does — because git refuses it, which is the second lock that makes
 *    the exception safe rather than a hole in the first one.
 *
 * Real git, in a temp directory, with a real `origin` it can fetch from — the ancestry
 * plumbing is the thing under test, and a fake git would only prove the fake works.
 * `gh` is stubbed, `bd` is an object, and nothing here touches the network, GitHub, a
 * bead, or any repo of yours.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------ the world */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-prboard-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const BIN = path.join(tmp, 'bin');
const ORIGIN = path.join(tmp, 'origin.git');
const REPO = path.join(tmp, 'repo');
const BEADS = path.join(tmp, 'beads', 'widgets', '.beads');
for (const d of [BIN, BEADS]) fs.mkdirSync(d, { recursive: true });

const STATE = path.join(tmp, 'gh-state.json');
const LOG = path.join(tmp, 'gh-calls.log');

// Extensionless, so node runs it as CommonJS whatever this package's "type" says.
// It answers `pr list` from a JSON file, which is the only gh call the board makes
// that pr.js's own test does not already cover.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.GH_FAKE_STATE, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(state.log, JSON.stringify({ args: args, cwd: process.cwd() }) + '\\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
const fail = (m) => { process.stderr.write(m + '\\nUsage: gh <command>\\n'); process.exit(1); };

if (args[0] === 'auth' && args[1] === 'status') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') {
  if (!state.repo) fail('none of the git remotes point to a known GitHub host');
  out(JSON.stringify(state.repo));
}
if (args[0] === 'pr' && args[1] === 'list') {
  if (state.listError) fail(state.listError);
  out(JSON.stringify(state.prs || []));
}
fail('unknown gh invocation: ' + args.join(' '));
`;
fs.writeFileSync(path.join(BIN, 'gh'), FAKE_GH, { mode: 0o755 });
process.env.GH_FAKE_STATE = STATE;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

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

/* A real repo with a real remote: three commits pushed, one held back. */
git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', ORIGIN);
git(tmp, 'clone', '--quiet', ORIGIN, REPO);
git(REPO, 'config', 'user.email', 't@e');
git(REPO, 'config', 'user.name', 'test');

const commit = (text) => {
  fs.appendFileSync(path.join(REPO, 'file.txt'), `${text}\n`);
  git(REPO, 'add', 'file.txt');
  git(REPO, 'commit', '--quiet', '-m', text);
  return git(REPO, 'rev-parse', 'HEAD');
};

const c1 = commit('one');
const c2 = commit('two');
const c3 = commit('three');
git(REPO, 'push', '--quiet', '-u', 'origin', 'main');
// Held back on purpose: on this Mac's `main`, not on `origin/main`. That is the state
// a merge commit is in when GitHub has it and this checkout has not fetched — and the
// only way to prove `pushed` is computed against origin rather than against local.
const held = commit('four, not pushed');

// Forty hex characters git has never seen. The board must answer `null` for it, not no.
const UNKNOWN = 'de1e7ed'.padEnd(40, '0');

const REPO_REAL = fs.realpathSync(REPO);

/* The daemon is "running" c2 — two commits behind the tip, which is exactly the
   situation the deployed lamp exists for: main moved after this process started. */
const BOOT = { dir: REPO_REAL, common: REPO_REAL, commit: c2, short: c2.slice(0, 7), at: new Date().toISOString() };

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

const rawPR = (over = {}) => ({
  number: 1,
  url: 'https://github.com/acme/widgets/pull/1',
  title: 'a pull request',
  state: 'MERGED',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'worktree-something-abc',
  baseRefName: 'main',
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: iso(1),
  mergeCommit: null,
  body: '',
  author: { login: 'someone' },
  createdAt: iso(2),
  updatedAt: iso(1),
  ...over,
});

const world = (prs, over = {}) =>
  fs.writeFileSync(
    STATE,
    JSON.stringify({ log: LOG, repo: { nameWithOwner: 'acme/widgets' }, prs, ...over }, null, 2)
  );

/* -------------------------------------------------------------------- fake bd */

/** Every bead the fake tracker has. Anything else resolves to null, as bd does. */
const BEADS_IN = {
  'zz-a1b': { id: 'zz-a1b', title: 'the first bead', status: 'closed' },
  'zz-jin': { id: 'zz-jin', title: 'the branch-tag bead', status: 'open' },
};
let shows = [];
const bd = {
  json: async (_ws, args) => (args[0] === 'list' ? [{ id: 'zz-a1b' }] : []),
  show: async (_ws, id) => {
    shows.push(id);
    return BEADS_IN[id] || null;
  },
};

const cfg = {
  workspaces: [{ name: 'widgets', dir: BEADS }],
  sessionDirs: { widgets: REPO },
  pr: { base: 'main' },
};

const { collectBoard, forgetBoard, landLocally, landParent, runningBuild } = await import(path.join(ROOT, 'lib', 'prboard.js'));
const prlib = await import(path.join(ROOT, 'lib', 'pr.js'));

/* `deploys: []` on purpose. Two rungs of the ladder are answers about the deploy journal,
   and the journal is a real directory under ~/.config — a suite that read it would be
   asserting against whatever this Mac happened to have shipped this morning. The rung that
   needs a record gets one, explicitly, further down. */
const sweep = async () => {
  forgetBoard();
  prlib.forgetAvailability();
  const board = await collectBoard(bd, cfg, { force: true, boot: BOOT, deploys: [] });
  return board;
};
const byNumber = (board, n) => board.repos[0].prs.find((p) => p.number === n);

/* ------------------------------------------------------------------ the lamps */

console.log('\nhow far each pull request got');

world([
  rawPR({ number: 1, mergeCommit: { oid: c1 }, title: 'zz-a1b: the shipped one' }),
  rawPR({ number: 2, mergeCommit: { oid: c3 }, title: 'merged after the daemon started' }),
  rawPR({ number: 3, mergeCommit: { oid: UNKNOWN }, title: 'merged somewhere this Mac has not fetched' }),
  rawPR({ number: 4, mergeCommit: { oid: held }, title: 'on this laptop, not on origin' }),
  rawPR({ number: 5, state: 'OPEN', mergedAt: null, title: 'still open', headRefName: 'worktree-thing-jin' }),
  rawPR({ number: 6, state: 'CLOSED', mergedAt: null, title: 'abandoned', updatedAt: iso(1) }),
]);

let board = await sweep();
const repo = board.repos[0];

check('the repo is named from gh, not guessed', repo.repo === 'acme/widgets', JSON.stringify(repo.repo));
check('and the sweep found every pull request', repo.prs.length === 6, `${repo.prs.length}`);

const shipped = byNumber(board, 1);
check('merged, on origin, and in the running build reads as live', shipped.stage === 'live', shipped.stage);
check('  — with every lamp true', shipped.merged && shipped.pushed === true && shipped.deployed === true);
check('  — and nothing left to say about it', shipped.note === '', shipped.note);

const owed = byNumber(board, 2);
check('a merge that landed after the daemon booted is NOT deployed', owed.deployed === false, String(owed.deployed));
check('  — it is pushed, which is a different word', owed.stage === 'pushed' && owed.pushed === true, owed.stage);
check('  — and the note says what to do about it', /Ship it/.test(owed.note), owed.note);

const unseen = byNumber(board, 3);
check('a commit this Mac has never seen is null, not false', unseen.pushed === null, String(unseen.pushed));
check('  — and its deployed is null too, for the same reason', unseen.deployed === null, String(unseen.deployed));
check('  — it falls back to merged rather than claiming a stage', unseen.stage === 'merged', unseen.stage);
check('  — and says nobody has looked', /fetch/.test(unseen.note), unseen.note);

const local = byNumber(board, 4);
check('pushed is computed against origin, not against local main', local.pushed === false, String(local.pushed));
check('  — so a commit only this laptop has is merged, not pushed', local.stage === 'merged', local.stage);

const open = byNumber(board, 5);
check(
  'a pull request still open is on the first rung, with no lamps lit',
  open.stage === 'review' && !open.merged && !open.pushed && !open.deployed,
  open.stage
);

const closed = byNumber(board, 6);
check('a closed one says so rather than reading as work owed', closed.stage === 'closed', closed.stage);
check('  — in a sentence', /without merging/.test(closed.note), closed.note);

check('deploy is tracked, because the daemon boots from this repo', repo.deployTracked === true);
check(
  'what is owed counts merged work and not decisions in review',
  board.counts.owed === 3 && board.counts.review === 1,
  JSON.stringify(board.counts)
);
check(
  'and the ones you can act on sort to the top',
  board.repos[0].prs[0].stage === 'review',
  board.repos[0].prs.map((p) => p.stage).join(',')
);

/* --------------------------------------------------- the rung a deploy record buys */

console.log('\nbetween pushed and live: a deploy that ran');

/* #2 merged *after* the daemon booted, so it can never read as `live` on this board — and
   a deploy of this repo that started after the merge and ended `ok` did carry it, which is
   a different word for a different fact. The record is the shape lib/deploy.js writes. */
board = await collectBoard(bd, cfg, {
  force: true,
  boot: BOOT,
  deploys: [
    { id: 'dep-1', workspace: 'widgets', status: 'ok', startedAt: new Date().toISOString() },
    // Another repo's, and a failed one of ours: neither may move a rung.
    { id: 'dep-2', workspace: 'gadgets', status: 'ok', startedAt: new Date().toISOString() },
    { id: 'dep-3', workspace: 'widgets', status: 'failed', startedAt: new Date().toISOString() },
  ],
});
const carried = byNumber(board, 2);
check('a merge an ok deploy has carried reads as deployed, not pushed', carried.stage === 'deployed', carried.stage);
check('  — with the Deployed lamp lit off the journal', carried.shipped === true, String(carried.shipped));
check('  — and Live still dark, because this process is older than the merge', carried.deployed === false);
check(
  '  — so the note is about what cannot be seen rather than about shipping it',
  /not visible from here/.test(carried.note),
  carried.note
);
check(
  'a deploy of another repo, and a failed one of this repo, move nothing',
  (await collectBoard(bd, cfg, {
    force: true,
    boot: BOOT,
    deploys: [
      { id: 'dep-4', workspace: 'gadgets', status: 'ok', startedAt: new Date().toISOString() },
      { id: 'dep-5', workspace: 'widgets', status: 'failed', startedAt: new Date().toISOString() },
    ],
  })).repos[0].prs.find((p) => p.number === 2).stage === 'pushed'
);
/* Every rung, across the two sweeps rather than in one — and the reason is the ladder
   working: with that `ok` record on the journal the only `pushed` row is `deployed`
   instead, which is exactly the promotion under test. `pushed` is what the same board
   says with an empty journal. */
const rungs = new Set([
  ...board.repos[0].prs.map((p) => p.stage),
  ...(await sweep()).repos[0].prs.map((p) => p.stage),
]);
check(
  'and every rung of the ladder is reachable in a real flow',
  ['review', 'merged', 'pushed', 'deployed', 'live', 'closed'].every((id) => rungs.has(id)),
  [...rungs].join(',')
);

/* ------------------------------------------------------------- untracked deploy */

console.log('\nwhen the daemon does not run the repo it is looking at');

board = await collectBoard(bd, cfg, {
  force: true,
  boot: { ...BOOT, common: path.join(tmp, 'somewhere-else') },
  deploys: [],
});
const elsewhere = board.repos[0].prs.find((p) => p.number === 1);
check('deployed is null — unknown, not no', elsewhere.deployed === null, String(elsewhere.deployed));
check('  — the card says the deploy is not visible from here', board.repos[0].deployTracked === false);
check('  — and the row says it in words', /no deploy/.test(elsewhere.note), elsewhere.note);
check(
  'a daemon with no boot commit at all does not crash the board',
  (await collectBoard(bd, cfg, { force: true, boot: null, deploys: [] })).repos[0].prs.length === 6
);

/* ------------------------------------------------------------- beads on a row */

console.log('\nwhich bead a pull request is for');

shows = [];
board = await sweep();
check(
  'a bead named in the title is linked',
  byNumber(board, 1).beads.map((b) => b.id).join() === 'zz-a1b',
  JSON.stringify(byNumber(board, 1).beads)
);
check(
  'a branch ending in a bead-shaped tag is linked too',
  byNumber(board, 5).beads.map((b) => b.id).join() === 'zz-jin',
  JSON.stringify(byNumber(board, 5).beads)
);
check('a pull request naming no bead gets none', byNumber(board, 2).beads.length === 0);
check(
  'candidates are verified against the tracker, never trusted',
  !shows.some((id) => BEADS_IN[id] === undefined && byNumber(board, 5).beads.some((b) => b.id === id))
);

/* The row that made the tiers necessary: a delivery whose body signs off with the
   beads it did *not* touch. All of them exist, so the tracker cannot tell them
   apart — only where they were written can. */
world([
  rawPR({
    number: 1,
    title: 'zz-a1b: the one it is for',
    mergeCommit: { oid: c1 },
    body: 'Left undone: nothing was done about zz-jin, which this unblocks.\n',
  }),
  rawPR({
    number: 2,
    title: 'a hand-opened one that names no bead anywhere but the body',
    headRefName: 'some-branch',
    mergeCommit: { oid: c1 },
    body: 'Fixes zz-jin.\n',
  }),
  rawPR({
    number: 3,
    title: 'a delivery whose block declares it',
    headRefName: 'some-branch',
    mergeCommit: { oid: c1 },
    body: '```beadpr\nworkspace: widgets\nbead: zz-jin\nnumber: 3\n```\nand zz-a1b is only mentioned here.\n',
  }),
  rawPR({
    number: 4,
    title: 'one that names no bead of its own at all',
    headRefName: 'some-branch',
    mergeCommit: { oid: c1 },
    body: '## Left undone\n\nNothing was done about zz-jin, which this unblocks.\n',
  }),
]);
board = await sweep();
check(
  'a bead merely mentioned in the body loses to one named in the title',
  byNumber(board, 1).beads.map((b) => b.id).join() === 'zz-a1b',
  JSON.stringify(byNumber(board, 1).beads.map((b) => b.id))
);
check(
  '  — but the body is still read when nothing stronger names one',
  byNumber(board, 2).beads.map((b) => b.id).join() === 'zz-jin',
  JSON.stringify(byNumber(board, 2).beads.map((b) => b.id))
);
check(
  "  — and a beadpr block's own `bead:` beats a mention too",
  byNumber(board, 3).beads.map((b) => b.id).join() === 'zz-jin',
  JSON.stringify(byNumber(board, 3).beads.map((b) => b.id))
);
check(
  '  — a bead the body only mentions in passing links nothing at all',
  byNumber(board, 4).beads.length === 0,
  JSON.stringify(byNumber(board, 4).beads.map((b) => b.id))
);

shows = [];
world([
  rawPR({ number: 1, title: 'zz-a1b: one', mergeCommit: { oid: c1 } }),
  rawPR({ number: 2, title: 'zz-a1b: two, same bead', mergeCommit: { oid: c1 } }),
  rawPR({ number: 3, title: 'zz-a1b: three, same bead again', mergeCommit: { oid: c1 } }),
]);
board = await sweep();
check(
  'the same bead across three rows is asked for once',
  shows.filter((id) => id === 'zz-a1b').length === 1,
  shows.join(',')
);

/* ------------------------------------------------------------------- the window */

console.log('\nwhat stays on the board');

world([
  rawPR({ number: 1, state: 'OPEN', mergedAt: null, updatedAt: iso(400), title: 'old but open' }),
  rawPR({ number: 2, mergeCommit: { oid: c1 }, mergedAt: iso(400), updatedAt: iso(400), title: 'long since shipped' }),
]);
board = await sweep();
check('an open pull request is never aged out, however old', Boolean(byNumber(board, 1)));
check('a settled one older than the window is', !byNumber(board, 2));

/* --------------------------------------------------------------- degrading well */

console.log('\nwhen something is not there');

world([], { repo: null });
board = await sweep();
check('a checkout with no GitHub remote is a sentence, not an error', board.repos[0].error === null);
check('  — and it says why there is nothing to show', /No GitHub remote/.test(board.repos[0].note), board.repos[0].note);

world([], { listError: 'HTTP 503: unavailable' });
board = await sweep();
check('a gh that cannot answer puts the reason on the card', /503/.test(board.repos[0].error || ''), board.repos[0].error);
check('  — rather than taking the board down', Array.isArray(board.repos) && board.repos.length === 1);

/* ------------------------------------------------------------------- landing it */

console.log('\nbringing local main up to what GitHub has');

world([]);
// origin moves the way a merge moves it: someone else's commit, pushed to the bare repo.
const other = path.join(tmp, 'other');
git(tmp, 'clone', '--quiet', ORIGIN, other);
git(other, 'config', 'user.email', 't@e');
git(other, 'config', 'user.name', 'test');
fs.appendFileSync(path.join(other, 'file.txt'), 'merged elsewhere\n');
git(other, 'add', 'file.txt');
git(other, 'commit', '--quiet', '-m', 'merged elsewhere');
git(other, 'push', '--quiet', 'origin', 'main');

// Put our checkout back where a fast-forward is possible, then dirty it.
git(REPO, 'reset', '--hard', '--quiet', c3);
fs.writeFileSync(path.join(REPO, 'file.txt'), 'adam is mid-edit\n');

const refused = await landLocally(REPO, 'main');
check('it fetched', refused.fetched === true, JSON.stringify(refused));
check('a checkout with uncommitted work is not fast-forwarded', refused.advanced === false);
check('  — and the note names what stopped it', /uncommitted/.test(refused.note), refused.note);
check(
  '  — the working tree is exactly as it was',
  fs.readFileSync(path.join(REPO, 'file.txt'), 'utf8') === 'adam is mid-edit\n'
);

git(REPO, 'checkout', '--quiet', '--', 'file.txt');
const landed = await landLocally(REPO, 'main');
check('a clean checkout on main is fast-forwarded', landed.advanced === true, JSON.stringify(landed));
check('  — and now has what origin has', git(REPO, 'rev-parse', 'main') === git(REPO, 'rev-parse', 'origin/main'));

git(REPO, 'checkout', '--quiet', '-b', 'a-side-branch');
git(other, 'commit', '--quiet', '--allow-empty', '-m', 'another');
git(other, 'push', '--quiet', 'origin', 'main');
const offBranch = await landLocally(REPO, 'main');
check(
  'main is still moved up when it is not the branch you are on',
  offBranch.advanced === true && git(REPO, 'rev-parse', 'main') === git(REPO, 'rev-parse', 'origin/main'),
  JSON.stringify(offBranch)
);

/* ------------------------------------------------- landing it from a worktree */

console.log('\nand from inside a worktree, which is where a worker delivers from');

// The shape every unattended delivery has: the main checkout sitting on `main`, the
// session in `.claude/worktrees/<name>` on a branch of its own, and `origin/main` a
// commit ahead of both because GitHub has just merged something.
git(REPO, 'checkout', '--quiet', 'main');
const WT = path.join(tmp, 'worktree');
git(REPO, 'worktree', 'add', '--quiet', '-b', 'worker-branch', WT, 'main');
git(other, 'commit', '--quiet', '--allow-empty', '-m', 'the worker’s own merge');
git(other, 'push', '--quiet', 'origin', 'main');

const fromWorktree = await landParent(WT, 'main');
check('a delivery in a worktree moves the main checkout, not the worktree', fromWorktree.advanced === true, JSON.stringify(fromWorktree));
check(
  '  — and it names the checkout it moved, which is not the one it was given',
  fs.realpathSync(fromWorktree.dir) === fs.realpathSync(REPO) && fromWorktree.dir !== WT,
  `${fromWorktree.dir} vs ${REPO}`
);
check('  — main now has what origin has', git(REPO, 'rev-parse', 'main') === git(REPO, 'rev-parse', 'origin/main'));
check('  — the worktree is still on its own branch', git(WT, 'rev-parse', '--abbrev-ref', 'HEAD') === 'worker-branch');

// The refusal is the whole reason this goes through landLocally rather than running
// two git commands of its own: a worker at three in the morning must be no more
// willing to fast-forward over open files than the button on the phone is.
git(other, 'commit', '--quiet', '--allow-empty', '-m', 'and another');
git(other, 'push', '--quiet', 'origin', 'main');
fs.writeFileSync(path.join(REPO, 'file.txt'), 'adam is mid-edit again\n');
const heldOff = await landParent(WT, 'main');
check('a main checkout with uncommitted work in it is left alone', heldOff.advanced === false, JSON.stringify(heldOff));
check('  — and the note says why, so the bead can carry it', /uncommitted/.test(heldOff.note), heldOff.note);
check(
  '  — and it names the path, so nobody has to work out whose mess it is',
  /file\.txt/.test(heldOff.note),
  heldOff.note
);
check(
  '  — with the edit untouched',
  fs.readFileSync(path.join(REPO, 'file.txt'), 'utf8') === 'adam is mid-edit again\n'
);

// The boundary, and the half of bc-45g8 that is a promise rather than a relaxation:
// residue *beside* an open file changes nothing. It is one edited path that stops this,
// not a majority of them.
fs.writeFileSync(path.join(REPO, '.DS_Store'), 'finder\n');
const mixed = await landParent(WT, 'main');
check('one edited file still stops it however much untracked residue sits beside it', mixed.advanced === false, JSON.stringify(mixed));
check('  — and the note names the edited one', /file\.txt/.test(mixed.note), mixed.note);
fs.rmSync(path.join(REPO, '.DS_Store'), { force: true });
git(REPO, 'checkout', '--quiet', '--', 'file.txt');

// bc-s7fs found this and bc-45g8 decided it: residue a tool left behind is not an edit
// at all, and it used to hold the fast-forward exactly as hard as one — which is how a
// single `.beads/` stopped every delivery in this repo for a day and 114 commits. The
// checkout is shared, so the cost was never one session's. Untracked-only dirt is now
// stepped past, and the tree is asserted to still have the residue in it afterwards:
// stepping past is not tidying up after anybody.
fs.mkdirSync(path.join(REPO, '.beads'), { recursive: true });
fs.writeFileSync(path.join(REPO, '.beads', 'metadata.json'), '{}\n');
const strayOnly = await landParent(WT, 'main');
check('a stray untracked directory does not hold the fast-forward', strayOnly.advanced === true, JSON.stringify(strayOnly));
check('  — main has what origin has', git(REPO, 'rev-parse', 'main') === git(REPO, 'rev-parse', 'origin/main'));
check('  — the note says it stepped past residue rather than finding none', /untracked/.test(strayOnly.note), strayOnly.note);
check('  — and names it', /\.beads/.test(strayOnly.note), strayOnly.note);
check(
  '  — with the residue still there, because this is a fast-forward and not a tidy-up',
  fs.existsSync(path.join(REPO, '.beads', 'metadata.json'))
);
fs.rmSync(path.join(REPO, '.beads'), { recursive: true, force: true });

// The second lock, and the reason relaxing the first one is safe: git will not clobber
// an untracked file that an incoming commit writes. So the one case where residue could
// have cost something is refused by git rather than by the guard — and reported, with
// the paths, rather than swallowed as "already up to date".
fs.writeFileSync(path.join(other, 'newthing.txt'), 'the version that merged\n');
git(other, 'add', 'newthing.txt');
git(other, 'commit', '--quiet', '-m', 'a commit that adds a file');
git(other, 'push', '--quiet', 'origin', 'main');
fs.writeFileSync(path.join(REPO, 'newthing.txt'), 'the version nobody committed\n');
const wasAt = git(REPO, 'rev-parse', 'main');
const clobber = await landParent(WT, 'main');
check('git itself refuses when the incoming commit would write over untracked work', clobber.advanced === false, JSON.stringify(clobber));
check('  — the note carries git’s reason', /untracked/.test(clobber.note), clobber.note);
check('  — and names the file, which is the thing to move out of the way', /newthing\.txt/.test(clobber.note), clobber.note);
check(
  '  — the untracked file is exactly as it was',
  fs.readFileSync(path.join(REPO, 'newthing.txt'), 'utf8') === 'the version nobody committed\n'
);
check('  — and main did not move', git(REPO, 'rev-parse', 'main') === wasAt);
fs.rmSync(path.join(REPO, 'newthing.txt'), { force: true });

git(REPO, 'worktree', 'remove', '--force', WT);

/* ------------------------------------------------------------------ the build */

console.log('\nwhat is running');

const build = await runningBuild();
check(
  'the daemon reports the commit it booted from, or nothing at all',
  build === null || (typeof build.commit === 'string' && build.commit.length === 40),
  JSON.stringify(build)
);

console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
