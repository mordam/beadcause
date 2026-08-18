#!/usr/bin/env node
/**
 * The bead that is closed over a branch that never reached main — lib/notinmain.js.
 *
 *     npm test
 *     node test/notinmain.mjs
 *
 * bc-nib3.5 built a whole page, ran the suite green, and closed itself with a close
 * reason ending "not merged". Nothing anywhere raised it: a closed bead with a detailed
 * close reason is the least suspicious thing in the tracker, and the page was found
 * missing weeks later by a session sent to link to it. bc-5lcc and bc-0nq8 are two more
 * of the same. The sweep under test finds them; five things are worth asserting, in
 * descending order of what getting them wrong would cost:
 *
 * 1. **A deliberate squash is not reported as lost work.** A squash merge leaves no
 *    ancestry at all, so git alone says "never landed" about every one of them — for
 *    ever, since the answer never changes. A sweep that filed a card per squash would be
 *    unreadable within a day and the real findings would be lost in it. GitHub is the
 *    only witness, and this is why the sweep refuses to run without it.
 * 2. **Nothing is closed, reopened, merged or pushed.** The whole licence here is to
 *    file a finding. The fake tracker records a `close` and an `update` as readily as a
 *    comment, so an accidental reopen shows up as a failed assertion rather than as
 *    nothing at all.
 * 3. **It asks exactly once.** The card is a separate bead which gets answered and
 *    closed, so the card's own existence cannot be the guard; the guard is a mark in the
 *    *closed* bead's notes. The case that matters runs the sweep twice over the rows the
 *    first run wrote, which is the loop as it would actually happen — and a second card
 *    would be a question about work Adam has already decided about.
 * 4. **It matches a bead's own branch and not a branch it merely names.** bc-5lcc's
 *    description names another bead's branch, and a sweep matching on prose would accuse
 *    it of being closed over work that was never its own.
 * 5. **The card parses, with two real options, one of them a commission.** The block is
 *    hand-built YAML inside markdown, so it is read back through `toQuestion` — the same
 *    path the phone uses — rather than eyeballed. "Land it" must not close the bead it is
 *    an instruction to.
 *
 * The git repo is real and thrown away, `gh` is a fake shell script, and `bd` is an
 * object that records what it was asked to write. Nothing here reaches a tracker,
 * GitHub, iTerm or a repo of yours.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-notinmain-'));
process.on('exit', () => removeTreeSync(tmp));

// Before the first import that reaches lib/config.js, which fixes CONFIG_DIR at module
// load: nothing here may read or write the config directory this Mac actually runs from.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const REPO = path.join(tmp, 'repo');
const BIN = path.join(tmp, 'bin');
const PRS = path.join(tmp, 'prs.json');
for (const d of [REPO, BIN]) fs.mkdirSync(d, { recursive: true });

/* ------------------------------------------------------------------ harness */

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
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- the fake gh */

/**
 * A `gh` that honours `--head` and nothing else about pull requests.
 *
 * `--head` is the whole of what this sweep asks GitHub, and it is asked because it is
 * the only question that still has an answer once a merge has deleted the branch — the
 * ref is gone and `gh pr view <branch>` fails, while `headRefName` is kept on the pull
 * request for good.
 */
fs.writeFileSync(PRS, '[]');
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const arg = (f) => { const i = a.indexOf(f); return i === -1 ? null : a[i + 1]; };
if (a[0] === 'auth' && a[1] === 'status') process.exit(0);
if (a[0] === 'repo' && a[1] === 'view') { console.log('{"nameWithOwner":"mordam/widgets"}'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') {
  const rows = JSON.parse(fs.readFileSync(${JSON.stringify(PRS)}, 'utf8'));
  const head = arg('--head');
  console.log(JSON.stringify(head ? rows.filter((r) => r.headRefName === head) : rows));
  process.exit(0);
}
console.error('unexpected gh: ' + a.join(' '));
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
const setPrs = (rows) => fs.writeFileSync(PRS, JSON.stringify(rows));
const prRow = (over = {}) => ({
  number: 42,
  url: 'https://github.com/mordam/widgets/pull/42',
  title: 'a pull request',
  state: 'MERGED',
  headRefName: '',
  baseRefName: 'main',
  body: '',
  mergedAt: new Date().toISOString(),
  mergeCommit: { oid: 'abc1234def5678' },
  statusCheckRollup: [],
  ...over,
});

/* ---------------------------------------------------------------- the repo */
//
// One repo carrying every shape this has to tell apart, built with real merges because
// what is under test is a claim about git's own answers:
//
//   c1 ── c2 ───── M1 ── S1                         main
//          │     ╱       │
//          │   c3        c5  (squash-ddd: tree in, history not)
//          │ (landed-aaa)
//          ├── c4  (lost-bbb: never merged, no pull request — the one finding)
//          ├── c6  (open-eee: never merged, a pull request is open for it)
//          └── empty-ccc  (a branch at main, no commits of its own)

/**
 * Every commit in the fixture is three days old, and that is not decoration.
 *
 * The sweep will not call a branch stranded until its newest commit has stopped moving
 * for `GRACE_MS` — a delivery pushes its branch minutes before it opens its pull request,
 * and a sweep landing in that gap sees exactly what abandoned work looks like. So a repo
 * built with `git commit` at wall-clock now is a repo in which the sweep is *correctly*
 * silent about everything, and every assertion below it would pass vacuously. A branch
 * genuinely nobody landed has an old tip; the fixture has old tips. The one case that
 * wants a fresh one makes it explicitly.
 */
const OLD = new Date(Date.now() - 3 * 86400000).toISOString();

const git = (...args) =>
  execFileSync(
    'git',
    ['-C', REPO, '-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD } }
  ).trim();

const write = (name, text) => fs.writeFileSync(path.join(REPO, name), text);
const commit = (name, text, message, { at = OLD } = {}) => {
  write(name, text);
  git('add', name);
  execFileSync(
    'git',
    ['-C', REPO, '-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } }
  );
  return git('rev-parse', 'HEAD');
};

execFileSync('git', ['-C', REPO, '-c', 'init.defaultBranch=main', 'init', '-q'], { encoding: 'utf8' });
commit('one', '1', 'c1');
const c2 = git('rev-parse', 'HEAD');

git('checkout', '-q', '-b', 'worktree-landed-aaa', c2);
commit('three', '3', 'c3');
git('checkout', '-q', 'main');
git('merge', '-q', '--no-ff', '-m', "Merge branch 'worktree-landed-aaa'", 'worktree-landed-aaa');
const m1 = git('rev-parse', 'HEAD');

// The finding: one commit, never merged, and GitHub will have nothing for it.
git('checkout', '-q', '-b', 'worktree-lost-bbb', c2);
const c4 = commit('four', '4', 'bbb: the work nobody landed');

// Squash-merged. `--is-ancestor` is false forever and GitHub is the only witness.
git('checkout', '-q', '-b', 'worktree-squash-ddd', m1);
commit('five', '5', 'c5');
git('checkout', '-q', 'main');
git('merge', '-q', '--squash', 'worktree-squash-ddd');
git('commit', '-q', '-m', 'squashed worktree-squash-ddd');
const s1 = git('rev-parse', 'HEAD');

// Never merged, but somebody is already looking at it.
git('checkout', '-q', '-b', 'worktree-open-eee', c2);
commit('six', '6', 'eee: in review');

// An unstarted worktree: a branch on main's own tip and nothing of its own.
git('checkout', '-q', 'main');
git('branch', 'worktree-empty-ccc', s1);

// A second stranded branch, for the cap and the ordinary-case count.
git('checkout', '-q', '-b', 'worktree-alsolost-fff', c2);
commit('seven', '7', 'fff: also never landed');
git('checkout', '-q', 'main');

// A delivery in flight: pushed a minute ago, and the pull request is not open yet. This
// is the shape that filed a card eight minutes before #315 existed — bc-xl7n.63.
git('checkout', '-q', '-b', 'worktree-inflight-ggg', c2);
commit('eight', '8', 'ggg: just committed', { at: new Date(Date.now() - 60000).toISOString() });
git('checkout', '-q', 'main');

git('update-ref', 'refs/remotes/origin/main', s1);

const {
  sweepNotInMain,
  describeNotInMain,
  followNotInMain,
  describeFollowNotInMain,
  tagOf,
  ownsBranch,
  worktreeBranches,
  isCandidate,
  askMark,
  clearMark,
  alreadyAsked,
  cardSubject,
  strandedCard,
  strandedTitle,
  RECENT_DAYS,
  GRACE_MS,
} = await import(LIB('notinmain.js'));
const { toQuestion } = await import(LIB('decision.js'));

/* --------------------------------------------------------- the fake tracker */

/**
 * A tracker that answers and records, with one bead per row.
 *
 * `writes` is the assertion surface for claim 2: a `close` and an `update` are recorded
 * as readily as a comment, so a sweep that reopened something fails an assertion rather
 * than passing quietly. `appendNotes` mutates the row, which is how the idempotence case
 * runs the sweep twice over what the first run wrote.
 */
function fakeBd(beads, { createFails = false, closeFails = false } = {}) {
  const rows = beads.map((b) => ({
    status: 'closed',
    title: '',
    labels: [],
    closed_at: new Date().toISOString(),
    ...b,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const writes = [];
  let seq = 0;
  return {
    writes,
    rows,
    byId,
    async listStatus(_ws, status) {
      return rows.filter((r) => String(status).split(',').includes(r.status));
    },
    // `bd human list` filtered by status, which is what the real one is: a card that has
    // been closed is off the inbox, and the follow-up must never be handed one.
    async listHuman() {
      return [...byId.values()].filter((r) => r.status !== 'closed' && (r.labels || []).includes('human'));
    },
    async create(_ws, fields) {
      writes.push({ kind: 'create', id: fields.title, fields });
      if (createFails) throw new Error('bd refused the create');
      const id = `wg-card${(seq += 1)}`;
      byId.set(id, { id, status: 'open', ...fields });
      return id;
    },
    async comment(_ws, id, text) {
      writes.push({ kind: 'comment', id, text });
    },
    async appendNotes(_ws, id, text) {
      writes.push({ kind: 'notes', id, text });
      const row = byId.get(id);
      if (row) row.notes = `${row.notes || ''}\n${text}`;
    },
    async addLabel(_ws, id, label) {
      writes.push({ kind: 'label', id, label });
    },
    async close(_ws, id, reason) {
      writes.push({ kind: 'close', id, reason });
      if (closeFails) throw new Error('bd refused the close');
      const row = byId.get(id);
      if (row) row.status = 'closed';
    },
    async update(_ws, id, fields) {
      writes.push({ kind: 'update', id, fields });
    },
  };
}

const ws = (name) => ({ name, dir: path.join(tmp, 'beads', name, '.beads') });
const kinds = (bd) => bd.writes.map((w) => `${w.kind}:${w.id}`).join(' ');
const why = (result, id) => (result.skipped.find((s) => s.id === id)?.why || '').toLowerCase();
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

/* ------------------------------------------------- which branch is whose */

console.log('\nwhich branch a bead owns');

check('the tag is the id with its punctuation taken out', tagOf('bc-nib3.5') === 'nib35', tagOf('bc-nib3.5'));
check('and without the workspace prefix, which every branch would share', tagOf('bc-5lcc') === '5lcc', tagOf('bc-5lcc'));
check('a bead with no suffix owns nothing', tagOf('bc') === '' && ownsBranch('bc', 'worktree-x') === false);
check('the trailing tag is the match', ownsBranch('bc-5lcc', 'worktree-squash-proof-5lcc'));
check('and it is anchored on the dash, so bc-ab does not own bc-cab’s branch', ownsBranch('bc-ab', 'worktree-x-cab') === false);
check('a branch that merely contains the tag is not owned', ownsBranch('bc-5lcc', 'worktree-5lcc-notes-aaa') === false);

const branches = await worktreeBranches(REPO);
check(
  'every worktree branch in the checkout is listed once',
  ['worktree-landed-aaa', 'worktree-lost-bbb', 'worktree-squash-ddd', 'worktree-open-eee', 'worktree-empty-ccc'].every((b) =>
    branches.includes(b)
  ),
  branches.join(' ')
);
check('and nothing that is not one', branches.every((b) => b.startsWith('worktree-')), branches.join(' '));

console.log('\nwhich beads are looked at');

check('a closed bead inside the window is', isCandidate({ status: 'closed', closed_at: ago(1) }));
check('an open one is not — that is lib/inmain.js’s half', isCandidate({ status: 'open', closed_at: ago(1) }) === false);
check(
  `one closed more than ${RECENT_DAYS} days ago is not`,
  isCandidate({ status: 'closed', closed_at: ago(RECENT_DAYS + 1) }) === false
);
check(
  'one already in the inbox is not',
  isCandidate({ status: 'closed', closed_at: ago(1), labels: ['human'] }) === false
);
check(
  'and one nothing may open a session on is not',
  isCandidate({ status: 'closed', closed_at: ago(1), labels: ['unendorsed'] }) === false
);

/* ------------------------------------------------------------- the sweep */

console.log('\nthe sweep');

setPrs([]);
const one = fakeBd([
  { id: 'wg-bbb', title: 'the work nobody landed', close_reason: 'Built it. On worktree-lost-bbb, not merged.' },
]);
const first = await sweepNotInMain(one, ws('one'), REPO);

check('a closed bead whose own branch never landed is flagged', first.flagged.length === 1, JSON.stringify(first.flagged));
check('the finding names the branch and the count', first.flagged[0]?.branch === 'worktree-lost-bbb' && first.flagged[0]?.ahead === 1, JSON.stringify(first.flagged[0]));
check('and it is a bead of its own, because a card on a closed bead is never rendered', first.flagged[0]?.card === 'wg-card1', JSON.stringify(first.flagged[0]));
check(
  'the card is filed first, then the mark, then the comment',
  kinds(one) === 'create:worktree-lost-bbb never reached main — wg-bbb is closed over it notes:wg-bbb comment:wg-bbb',
  kinds(one)
);
check('nothing was closed, reopened or updated', !one.writes.some((w) => w.kind === 'close' || w.kind === 'update'), kinds(one));
check('the closed bead is still closed', one.rows[0].status === 'closed');
check(
  'the card is in the inbox and is not held out of every queue',
  JSON.stringify(one.writes[0].fields.labels) === '["human"]',
  JSON.stringify(one.writes[0].fields.labels)
);
check(
  'the card records where it came from',
  JSON.stringify(one.writes[0].fields.deps) === '["discovered-from:wg-bbb"]',
  JSON.stringify(one.writes[0].fields.deps)
);
check('the summary line says what it filed', /wg-bbb \(worktree-lost-bbb → wg-card1\)/.test(describeNotInMain(first)), describeNotInMain(first));

const second = await sweepNotInMain(one, ws('one'), REPO);
check('a second sweep over the same rows asks nothing again', second.flagged.length === 0, JSON.stringify(second.flagged));
check('and says why it did not', why(second, 'wg-bbb').includes('already carries the ask'), why(second, 'wg-bbb'));
check('the mark is the guard, and it is on the closed bead', alreadyAsked(one.rows[0], 'worktree-lost-bbb'));
check('the mark is keyed by branch', alreadyAsked(one.rows[0], 'worktree-other-zzz') === false);
check('the summary of a sweep that found nothing is empty', describeNotInMain(second) === '');

console.log('\nwhat it must say nothing about');

const landed = fakeBd([{ id: 'wg-aaa', title: 'landed', close_reason: 'done' }]);
const r2 = await sweepNotInMain(landed, ws('two'), REPO);
check('a branch that was merged in the ordinary way is silent', r2.flagged.length === 0, JSON.stringify(r2.flagged));
// One number, two jobs — see fact 2 in lib/notinmain.js. A merged branch has nothing the
// base does not, which is the same answer an unstarted worktree gives and is the reason
// there is no ancestry walk in this sweep.
check('and the reason is that the base already has all of it', why(r2, 'wg-aaa').includes('nothing on it'), why(r2, 'wg-aaa'));
check('with no gh call spent on it either', kinds(landed) === '', kinds(landed));

setPrs([prRow({ headRefName: 'worktree-squash-ddd', number: 7, state: 'MERGED' })]);
const squash = fakeBd([{ id: 'wg-ddd', title: 'squashed', close_reason: 'done' }]);
const r3 = await sweepNotInMain(squash, ws('three'), REPO);
check('a deliberate squash merge is not reported as lost work', r3.flagged.length === 0, JSON.stringify(r3.flagged));
check('and GitHub is what said so', why(r3, 'wg-ddd').includes('#7'), why(r3, 'wg-ddd'));
check('nothing was written about it at all', kinds(squash) === '', kinds(squash));

setPrs([prRow({ headRefName: 'worktree-open-eee', number: 8, state: 'OPEN', mergedAt: null, mergeCommit: null })]);
const inflight = fakeBd([{ id: 'wg-eee', title: 'in review', close_reason: 'done' }]);
const r4 = await sweepNotInMain(inflight, ws('four'), REPO);
check('a branch with an open pull request is not stranded work', r4.flagged.length === 0, JSON.stringify(r4.flagged));
check('and the reason is that somebody is looking', why(r4, 'wg-eee').includes('#8 is open'), why(r4, 'wg-eee'));

setPrs([]);
const empty = fakeBd([{ id: 'wg-ccc', title: 'never started', close_reason: 'done' }]);
const r5 = await sweepNotInMain(empty, ws('five'), REPO);
check('an unstarted worktree branch is not stranded work', r5.flagged.length === 0, JSON.stringify(r5.flagged));
check('and the reason is that there is nothing on it', why(r5, 'wg-ccc').includes('nothing on it'), why(r5, 'wg-ccc'));

const named = fakeBd([
  { id: 'wg-zzz', title: 'names somebody else’s branch', description: 'Reuse `worktree-lost-bbb`, which has the fixture.' },
]);
const r6 = await sweepNotInMain(named, ws('six'), REPO);
check(
  'a bead that merely names an unlanded branch is not accused of being closed over it',
  r6.flagged.length === 0 && kinds(named) === '',
  `${JSON.stringify(r6.flagged)} ${kinds(named)}`
);

const old = fakeBd([{ id: 'wg-bbb', title: 'old', closed_at: ago(RECENT_DAYS + 2), close_reason: 'done' }]);
const r7 = await sweepNotInMain(old, ws('seven'), REPO);
check('a bead closed long ago is left alone', r7.flagged.length === 0 && r7.checked === 0, JSON.stringify(r7));

const stillOpen = fakeBd([{ id: 'wg-bbb', title: 'open', status: 'open', close_reason: '' }]);
const r8 = await sweepNotInMain(stillOpen, ws('eight'), REPO);
check('an open bead is not this sweep’s business', r8.flagged.length === 0 && kinds(stillOpen) === '', kinds(stillOpen));

console.log('\nwhen something is not answering');

const broken = fakeBd([{ id: 'wg-bbb', title: 'lost', close_reason: 'done' }], { createFails: true });
const r9 = await sweepNotInMain(broken, ws('nine'), REPO);
check('a tracker that refuses the card leaves no mark, so it is asked again', !broken.writes.some((w) => w.kind === 'notes'), kinds(broken));
check('and it says so', why(r9, 'wg-bbb').includes('could not file the finding'), why(r9, 'wg-bbb'));

const capped = fakeBd([
  { id: 'wg-bbb', title: 'lost', close_reason: 'done' },
  { id: 'wg-fff', title: 'also lost', close_reason: 'done' },
]);
const r10 = await sweepNotInMain(capped, ws('ten'), REPO, { maxAsks: 1 });
check('the cap stops at one card', r10.flagged.length === 1, JSON.stringify(r10.flagged));
check('and counts what it did not look at rather than dropping it', r10.unasked === 1, JSON.stringify(r10));
check('which the summary says outright', /1 more branch was not asked about/.test(describeNotInMain(r10)), describeNotInMain(r10));

/* ------------------------------------------------- the delivery in flight */
//
// bc-xl7n.63. A card filed at 15:40:21Z said of a branch "GitHub has no pull request for
// it — not merged, not open, not refused"; #315 for that branch was opened at 15:48:35Z.
// Nothing was wrong with the reading — it was taken in the gap every delivery has between
// pushing its branch and opening its pull request, and the sweep runs on a tick, so it
// lands in that gap whenever somebody is delivering.

console.log('\na branch somebody is still delivering');

setPrs([]);
const flight = fakeBd([{ id: 'wg-ggg', title: 'in flight', close_reason: 'delivered on worktree-inflight-ggg' }]);
const r12 = await sweepNotInMain(flight, ws('twelve'), REPO);
check('a branch committed a minute ago is not called stranded work', r12.flagged.length === 0, JSON.stringify(r12.flagged));
check('nothing at all was written about it', kinds(flight) === '', kinds(flight));
check(
  'it is held rather than skipped, and the reason says what it looks like',
  r12.held.length === 1 && /delivery in flight/.test(r12.held[0].why),
  JSON.stringify(r12.held)
);
check(
  'no mark is written, so it is carded next sweep if it really was abandoned',
  alreadyAsked(flight.rows[0], 'worktree-inflight-ggg') === false
);
check('and the summary says so out loud rather than reporting nothing', /too freshly committed/.test(describeNotInMain(r12)), describeNotInMain(r12));

const later = await sweepNotInMain(flight, ws('twelve'), REPO, { now: Date.now() + GRACE_MS + 60000 });
check('once the grace is up the same branch is carded', later.flagged.length === 1, JSON.stringify(later.flagged));
check('and it is the branch that was held', later.flagged[0]?.branch === 'worktree-inflight-ggg', JSON.stringify(later.flagged[0]));

const flightPr = fakeBd([{ id: 'wg-ggg', title: 'in flight', close_reason: 'delivered on worktree-inflight-ggg' }]);
setPrs([prRow({ headRefName: 'worktree-inflight-ggg', number: 315, state: 'OPEN', mergedAt: null, mergeCommit: null })]);
const r13 = await sweepNotInMain(flightPr, ws('thirteen'), REPO, { now: Date.now() + GRACE_MS + 60000 });
check(
  'and if the pull request arrived during the grace, the card is never filed at all',
  r13.flagged.length === 0 && /#315 is open/.test(why(r13, 'wg-ggg')),
  why(r13, 'wg-ggg')
);

setPrs([]);
const old3 = fakeBd([{ id: 'wg-bbb', title: 'lost', close_reason: 'done' }]);
const r14 = await sweepNotInMain(old3, ws('fourteen'), REPO);
check('a branch whose tip has sat for three days is past the grace and is carded', r14.flagged.length === 1 && r14.held.length === 0, JSON.stringify(r14));

const noRepo = fakeBd([{ id: 'wg-bbb', title: 'lost' }]);
const r11 = await sweepNotInMain(noRepo, ws('eleven'), path.join(tmp, 'not-a-repo'));
check('a workspace with no checkout behind it is not an error', r11.ok === false && /not a git checkout/.test(r11.reason), JSON.stringify(r11));
check('and the sweep says nothing about it', describeNotInMain(r11).startsWith('not-in-main sweep skipped'), describeNotInMain(r11));

/* ---------------------------------------------------------- the follow-up */
//
// The grace is a guess about how long a session takes to open its pull request, so it
// cannot be the whole fix: a delivery whose gate runs three hours gets carded anyway. The
// other end is that the card's claim is re-asked on every sweep and the card is closed
// when it has stopped being true — which is also what stops this sweep and
// lib/sweepcard.js holding two open cards asking incompatible things about one branch,
// since the other one only ever files about a branch that *has* a pull request.

console.log('\nthe follow-up on a card already filed');

check('a card of this sweep’s is recognised by its own title', JSON.stringify(cardSubject(strandedTitle('wg-bbb', 'worktree-lost-bbb'))) === '{"branch":"worktree-lost-bbb","id":"wg-bbb"}', JSON.stringify(cardSubject(strandedTitle('wg-bbb', 'worktree-lost-bbb'))));
check('and any other bead in the inbox is not', cardSubject('worktree-lost-bbb needs a rebase') === null);
check('nor a bead written about one of these cards', cardSubject('re: worktree-lost-bbb never reached main — wg-bbb is closed over it') === null);

// File the card the way the sweep would, then let the world move under it.
setPrs([]);
const chased = fakeBd([{ id: 'wg-bbb', title: 'the work nobody landed', close_reason: 'On worktree-lost-bbb, not merged.' }]);
await sweepNotInMain(chased, ws('follow'), REPO);
const cardId = chased.writes[0] && 'wg-card1';
check('the card is in the inbox to begin with', (await chased.listHuman()).some((c) => c.id === cardId));

const stillLost = await followNotInMain(chased, ws('follow'), REPO);
check('a card whose claim is still true is left alone', stillLost.corrected.length === 0, JSON.stringify(stillLost.corrected));
check('and the card is still open', (await chased.listHuman()).some((c) => c.id === cardId));
check('the follow-up that changed nothing says nothing', describeFollowNotInMain(stillLost) === '');

setPrs([prRow({ headRefName: 'worktree-lost-bbb', number: 315, state: 'OPEN', mergedAt: null, mergeCommit: null })]);
const before = chased.writes.length;
const opened = await followNotInMain(chased, ws('follow'), REPO);
check('a pull request appearing afterwards closes the card', opened.corrected.length === 1, JSON.stringify(opened.corrected));
check('the card is off the inbox', !(await chased.listHuman()).some((c) => c.id === cardId));
const closeWrite = chased.writes.slice(before).find((w) => w.kind === 'close');
check('the close reason says the card was wrong and names the pull request', /#315/.test(closeWrite?.reason || '') && /Wrong when it was asked/.test(closeWrite?.reason || ''), closeWrite?.reason);
check('the closed bead’s thread is told, so it no longer points at a card asserting the opposite', chased.writes.slice(before).some((w) => w.kind === 'comment' && w.id === 'wg-bbb' && /#315/.test(w.text)), kinds(chased));
check('nothing was reopened, merged or pushed', !chased.writes.slice(before).some((w) => w.kind === 'update'), kinds(chased));
check('the closed bead is still closed', chased.rows[0].status === 'closed');
check('and the log line names the card, the branch and why', /wg-card1 \(worktree-lost-bbb — #315 is open for it\)/.test(describeFollowNotInMain(opened)), describeFollowNotInMain(opened));

// An OPEN pull request is somebody looking, not a settled question — so the fingerprint
// has to come off, or a delivery refused unmerged next week is stranded work no sweep
// will ever mention again.
check('an open pull request takes the ask back', opened.corrected[0]?.cleared === true, JSON.stringify(opened.corrected[0]));
check('which is a mark of its own on the closed bead', String(chased.rows[0].notes || '').includes(clearMark('worktree-lost-bbb')));
check('and the branch reads as unasked again', alreadyAsked(chased.rows[0], 'worktree-lost-bbb') === false);
setPrs([]);
const again = await sweepNotInMain(chased, ws('follow'), REPO);
check('so a sweep after the pull request is refused files a fresh card', again.flagged.length === 1, JSON.stringify(again.flagged));
check('and the new ask outranks the clear, so it is not filed a third time', alreadyAsked(chased.rows[0], 'worktree-lost-bbb'));

// A merge settles it for good, so the mark stays and the branch costs no further gh call.
setPrs([]);
const merged = fakeBd([{ id: 'wg-bbb', title: 'lost', close_reason: 'On worktree-lost-bbb, not merged.' }]);
await sweepNotInMain(merged, ws('merged'), REPO);
setPrs([prRow({ headRefName: 'worktree-lost-bbb', number: 7, state: 'MERGED' })]);
const wasMerged = await followNotInMain(merged, ws('merged'), REPO);
check('a card whose branch turned out to be merged is closed too', wasMerged.corrected.length === 1 && /merged as #7/.test(wasMerged.corrected[0].why), JSON.stringify(wasMerged.corrected));
check('and that one is settled, so the ask is not taken back', wasMerged.corrected[0]?.cleared === false && alreadyAsked(merged.rows[0], 'worktree-lost-bbb'));

// The other half of the card's claim can also stop being true on its own — a cherry-pick,
// or somebody merging it by hand.
setPrs([]);
const picked = fakeBd([{ id: 'wg-ccc', title: 'empty', close_reason: 'On worktree-empty-ccc.' }]);
picked.byId.set('wg-pick', {
  id: 'wg-pick',
  status: 'open',
  labels: ['human'],
  title: strandedTitle('wg-ccc', 'worktree-empty-ccc'),
});
const landed2 = await followNotInMain(picked, ws('picked'), REPO);
check(
  'a card about a branch the base has since taken in is closed, with no pull request anywhere',
  landed2.corrected.length === 1 && /holds all of it/.test(landed2.corrected[0].why),
  JSON.stringify(landed2.corrected)
);

// What it must not do.
setPrs([prRow({ headRefName: 'worktree-lost-bbb', number: 9, state: 'OPEN', mergedAt: null, mergeCommit: null })]);
const stubborn = fakeBd([{ id: 'wg-bbb', title: 'lost', close_reason: 'x' }], { closeFails: true });
stubborn.byId.set('wg-card9', { id: 'wg-card9', status: 'open', labels: ['human'], title: strandedTitle('wg-bbb', 'worktree-lost-bbb') });
const refused = await followNotInMain(stubborn, ws('stubborn'), REPO);
check('a tracker that refuses the close leaves the mark alone, so nothing is half-done', !stubborn.writes.some((w) => w.kind === 'notes'), kinds(stubborn));
check('and it says so', /could not close it/.test(refused.skipped[0]?.why || ''), JSON.stringify(refused.skipped));

const otherCards = fakeBd([{ id: 'wg-bbb', title: 'lost', close_reason: 'x' }]);
otherCards.byId.set('wg-else', { id: 'wg-else', status: 'open', labels: ['human'], title: 'Which of these two wins?' });
const untouched = await followNotInMain(otherCards, ws('other'), REPO);
check(
  'a card that is not one of these is never read, closed or counted',
  untouched.checked === 0 && untouched.corrected.length === 0 && kinds(otherCards) === '',
  `${JSON.stringify(untouched)} ${kinds(otherCards)}`
);

setPrs([prRow({ headRefName: 'worktree-lost-bbb', number: 9, state: 'MERGED' })]);
const many = fakeBd([{ id: 'wg-bbb', title: 'lost', close_reason: 'x' }]);
many.byId.set('wg-c1', { id: 'wg-c1', status: 'open', labels: ['human'], title: strandedTitle('wg-bbb', 'worktree-lost-bbb') });
many.byId.set('wg-c2', { id: 'wg-c2', status: 'open', labels: ['human'], title: strandedTitle('wg-bbb', 'worktree-alsolost-fff') });
const cappedFollow = await followNotInMain(many, ws('many'), REPO, { maxAsks: 1 });
check('the follow-up has a cap of its own', cappedFollow.corrected.length === 1 && cappedFollow.unasked === 1, JSON.stringify(cappedFollow));
check('and says what it did not get to, rather than reading as “all still true”', /1 more card was not re-asked/.test(describeFollowNotInMain(cappedFollow)), describeFollowNotInMain(cappedFollow));

const noGit = fakeBd([{ id: 'wg-bbb', title: 'lost' }]);
const followNoRepo = await followNotInMain(noGit, ws('nogit'), path.join(tmp, 'not-a-repo'));
check('a workspace with no checkout behind it is not an error here either', followNoRepo.ok === false && /not a git checkout/.test(followNoRepo.reason), JSON.stringify(followNoRepo));
check('and it says nothing', describeFollowNotInMain(followNoRepo).startsWith('not-in-main follow-up skipped'), describeFollowNotInMain(followNoRepo));

/* --------------------------------------------------------------- the card */

console.log('\nthe card');

const body = strandedCard(
  'wg-bbb',
  'worktree-lost-bbb',
  { ahead: 1, subject: 'bbb: the work nobody landed', tip: c4, askedAt: Date.parse('2026-08-14T15:40:21Z') },
  'origin/main'
);
const q = toQuestion(ws('one'), { id: 'wg-card1', title: 'x', description: body, labels: ['human'] });
check('the decision block parses', (q.errors || []).length === 0, JSON.stringify(q.errors));
check('with two options on it', (q.decision?.options || []).length === 2, JSON.stringify((q.decision?.options || []).map((o) => o.id)));
check('the question is answerable from a phone without scrolling to a file', /never reached origin\/main/.test(q.decision?.question || ''), q.decision?.question);
check(
  '“land it” is a commission and does not close the bead it is an instruction to',
  q.decision?.options?.find((o) => o.id === 'land-it')?.closes === false,
  JSON.stringify(q.decision?.options?.find((o) => o.id === 'land-it'))
);
check(
  '“let it go” closes it',
  q.decision?.options?.find((o) => o.id === 'let-it-go')?.closes !== false,
  JSON.stringify(q.decision?.options?.find((o) => o.id === 'let-it-go'))
);
check('nothing is recommended, because the fact says nothing about whether the work is wanted', !(q.decision?.options || []).some((o) => o.recommended), JSON.stringify(q.decision?.options));
check('the card carries the mark’s branch in the body it explains', body.includes('worktree-lost-bbb'));
check(
  'the reading is stamped, so a reader three days later knows the sentence has an age',
  body.includes('2026-08-14 15:40Z'),
  body.split('\n').slice(2, 5).join(' ')
);
check('in UTC and marked as such, because the card prose around it talks in ADT', /15:40Z/.test(body));
check('and the card says it is re-asked rather than leaving that to be discovered', /closes itself/.test(body));
check('and the mark itself is what the closed bead keeps', askMark('worktree-lost-bbb') === '<!-- beadcause:notinmain worktree-lost-bbb -->');

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
