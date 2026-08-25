#!/usr/bin/env node
/**
 * The bead whose branch is already in main — lib/inmain.js.
 *
 *     npm test
 *     node test/inmain.mjs
 *
 * bc-u5f asked for a branch to be landed that had already landed, inside somebody else's
 * batch merge. It stayed open, stayed in `bd ready`, and an unattended session spent its
 * whole turn proving the work was there. The sweep under test finds that case and asks
 * about it; four things are worth asserting, in descending order of what getting them
 * wrong would cost:
 *
 * 1. **An unstarted worktree branch must not be flagged.** A fresh worktree branches from
 *    main, so its tip *is* a main commit, so `merge-base --is-ancestor` says yes — and a
 *    bead filed by a session mid-task would be told its work had landed before it had
 *    written a line. This is the one way this feature could do real harm, and it is why
 *    ancestry alone is not the test. The repo below builds that branch for real.
 * 2. **Nothing is ever closed.** Not by any path, not on any input: the whole licence
 *    this sweep has is to ask. Every case asserts against the writes it made, and the
 *    fake tracker records a `close` as readily as a comment — so an accidental one shows
 *    up as a failed assertion rather than as nothing at all.
 * 3. **It asks exactly once.** The label an answer takes back off cannot be the guard, so
 *    the guard is a mark in the notes; the case that matters runs the sweep twice over
 *    the rows the first run wrote, which is the loop as it would actually happen.
 * 4. **The card it writes parses, and offers what it is entitled to offer.** The block is
 *    hand-built YAML inside markdown, so it is read back through `toQuestion` — the same
 *    path the phone uses — rather than eyeballed. On a leaf that is two real options; on
 *    an epic, over a live descendant at any depth, or where the shape of the tracker could
 *    not be read, `close-it` is gone and only the commission is left (bc-xl7n.52). An
 *    advocate's triage note names its children's branches, and every one of those used to
 *    type an offer to close the P0 that commissioned the survey.
 * 5. **That card can still be answered.** bd refuses a close over an open child and the
 *    phone withdraws the answer button when it knows the refusal is coming — so a card
 *    whose only option is a commission has to be the one shape the gate leaves alone, or
 *    the fix above trades a close nobody could press for a card nobody could answer.
 *    `allCommissions` is lifted out of public/app.js and run in a `vm` for that.
 *
 * The git repo is real and thrown away; `bd` is an object that records what it was asked
 * to write. Nothing here reaches a tracker, GitHub, iTerm or a repo of yours.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-inmain-'));
process.on('exit', () => removeTreeSync(tmp));

// Before the first import that reaches lib/config.js, which fixes CONFIG_DIR at module
// load: the advocate state file must land in the temp directory and not in the one this
// Mac actually runs from.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const REPO = path.join(tmp, 'repo');
fs.mkdirSync(REPO, { recursive: true });

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

/* ---------------------------------------------------------------- the repo */
//
// One repo carrying every shape this has to tell apart. Built with real merges rather
// than fixtures, because the thing under test is a claim about git's own answers:
//
//   c1 ── c2 ─────────── M1 ── S1 ── M2            main
//          │      ╱       │     │     ╱
//          │    c3        │    c5    c6
//          │  (landed-aaa)│ (squash)  (remote-eee, ref only on origin)
//          │              └── c4 (live-bbb, never merged)
//          └── empty-ccc  (branch at c2, no commits of its own)
//
// `empty-ccc` is case 1 above: its tip is c2, which is an ancestor of main — and no merge
// between c2 and main holds c2 as anything but a *first* parent, because c2 is a commit on
// main's own line rather than something main took in. A branch main took in is a later
// parent, and that difference is the whole guard.

const git = (...args) =>
  execFileSync(
    'git',
    ['-C', REPO, '-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8' }
  ).trim();

const write = (name, text) => fs.writeFileSync(path.join(REPO, name), text);
const commit = (name, text, message) => {
  write(name, text);
  git('add', name);
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};

execFileSync('git', ['-C', REPO, '-c', 'init.defaultBranch=main', 'init', '-q'], { encoding: 'utf8' });
const c1 = commit('one', '1', 'c1');
const c2 = commit('two', '2', 'c2');

// The unstarted worktree: a branch and nothing else.
git('branch', 'worktree-empty-ccc', c2);

git('checkout', '-q', '-b', 'worktree-landed-aaa', c2);
const c3 = commit('three', '3', 'c3');
git('checkout', '-q', 'main');
git('merge', '-q', '--no-ff', '-m', "Merge branch 'worktree-landed-aaa'", 'worktree-landed-aaa');
const m1 = git('rev-parse', 'HEAD');

// Never merged.
git('checkout', '-q', '-b', 'worktree-live-bbb', m1);
commit('four', '4', 'c4');

// Squash-merged: the tree lands, the history does not, and `--is-ancestor` is false
// forever. lib/landed.js reads this case out of GitHub; this one must say nothing.
git('checkout', '-q', '-b', 'worktree-squash-ddd', m1);
commit('five', '5', 'c5');
git('checkout', '-q', 'main');
git('merge', '-q', '--squash', 'worktree-squash-ddd');
git('commit', '-q', '-m', 'squashed worktree-squash-ddd');
const s1 = git('rev-parse', 'HEAD');

// Merged, and its ref exists only on origin — the branch was pruned locally afterwards,
// which is the ordinary end of a worktree.
git('checkout', '-q', '-b', 'tmp-remote', s1);
const c6 = commit('six', '6', 'c6');
git('checkout', '-q', 'main');
git('merge', '-q', '--no-ff', '-m', "Merge branch 'worktree-remote-eee'", 'tmp-remote');
const m2 = git('rev-parse', 'HEAD');
git('branch', '-q', '-D', 'tmp-remote');
git('update-ref', 'refs/remotes/origin/worktree-remote-eee', c6);

// A branch sitting exactly on the base tip: a fast-forward and a worktree cut from the
// current main are the same thing from here, so neither is claimed.
git('branch', 'worktree-tip-fff', m2);

const setOrigin = (sha) => git('update-ref', 'refs/remotes/origin/main', sha);
setOrigin(m2);

const {
  sweepInMain,
  describeInMain,
  branchNamesIn,
  ownedBranchNamesIn,
  isCandidate,
  landingMerge,
  askMark,
  alreadyAsked,
  familyOf,
  liveUnder,
  closeOffer,
} = await import(LIB('inmain.js'));

/* --------------------------------------------------------- the fake tracker */

/**
 * A tracker that answers and records, with one bead per row.
 *
 * `writes` is the assertion surface: a `close` is recorded as readily as a comment, so
 * claim 2 above — that nothing is ever closed — is checked against what the sweep tried
 * to do rather than against what happened to work. The row is mutated by `appendNotes`
 * and `addLabel` so a second sweep over the same object sees what the first one wrote,
 * which is how the idempotence case is run.
 */
function fakeBd(beads, { graph = true } = {}) {
  const rows = beads.map((b) => ({ status: 'open', title: '', labels: [], ...b }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const writes = [];
  return {
    writes,
    rows,
    /**
     * The `bd export` shape, built from the same rows — a fixture's `parent` is the whole
     * of it. Closed rows are in here and out of `listAgent`, which is the real difference
     * between the two reads and the one that decides whether a close may be offered.
     *
     * `{ graph: false }` drops the method entirely rather than answering empty, because
     * that is what a caller with its own stub looks like and the sweep has to survive it.
     */
    ...(graph
      ? {
          async graph() {
            return {
              parents: new Map(rows.filter((r) => r.parent).map((r) => [r.id, r.parent])),
              beads: new Map(rows.map((r) => [r.id, r])),
            };
          },
        }
      : {}),
    async listAgent() {
      return rows.filter((r) => r.status !== 'closed' && !(r.labels || []).includes('human'));
    },
    async show(_ws, id) {
      return byId.get(id) || null;
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
      const row = byId.get(id);
      if (row && !row.labels.includes(label)) row.labels.push(label);
    },
    async close(_ws, id, reason) {
      writes.push({ kind: 'close', id, reason });
    },
    async update(_ws, id, fields) {
      writes.push({ kind: 'update', id, fields });
    },
    async ready() {
      return rows
        .filter((r) => r.status === 'open' && !(r.labels || []).includes('human'))
        .map((r) => ({ id: r.id, title: r.title, priority: 1, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }));
    },
    async json(_ws, args) {
      if (args[0] === 'list') return [{ id: 'wg-1' }];
      return [];
    },
    async comments() {
      return [];
    },
    async listLabel() {
      return [];
    },
    async closeGate() {
      return null;
    },
  };
}

const ws = (name) => ({ name, dir: path.join(tmp, 'beads', name, '.beads') });
const kinds = (bd) => bd.writes.map((w) => `${w.kind}:${w.id}`).join(' ');
const why = (result, id) => (result.skipped.find((s) => s.id === id)?.why || '').toLowerCase();

/* ------------------------------------------------------------ reading beads */

console.log('\nwhich branch a bead names');

check(
  'a branch in the description is found, punctuation and backticks and all',
  branchNamesIn({ description: 'land `worktree-sessions-accordion-log-5f7`, then stop.' })[0] ===
    'worktree-sessions-accordion-log-5f7',
  JSON.stringify(branchNamesIn({ description: 'land `worktree-sessions-accordion-log-5f7`, then stop.' }))
);
check(
  'a bead naming two branches is asked about both, once each',
  JSON.stringify(
    branchNamesIn({ title: 'worktree-a-1 and worktree-b-2', description: 'worktree-a-1 again' })
  ) === JSON.stringify(['worktree-a-1', 'worktree-b-2'])
);
check(
  'prose that is not a branch name is not a branch name',
  branchNamesIn({ description: 'the worktree is retired; a worktree- prefix alone means nothing' }).length === 0,
  JSON.stringify(branchNamesIn({ description: 'the worktree is retired; a worktree- prefix alone means nothing' }))
);
check('a bead with no text names nothing', branchNamesIn({}).length === 0);

console.log('\nwhose branch it plausibly is (bc-xl7n.67)');

check(
  'a branch ending in another bead\'s tag is not this bead\'s, wherever it was found',
  ownedBranchNamesIn({ id: 'bc-xl7n', notes: 'Left `worktree-inmain-noclose-xl7n52` alone — it is alive.' }).length === 0,
  JSON.stringify(ownedBranchNamesIn({ id: 'bc-xl7n', notes: 'Left `worktree-inmain-noclose-xl7n52` alone — it is alive.' }))
);
check(
  'a branch ending in this bead\'s own tag is kept',
  JSON.stringify(ownedBranchNamesIn({ id: 'bc-xl7n.52', notes: 'Delivered as `worktree-inmain-noclose-xl7n52`.' })) ===
    JSON.stringify(['worktree-inmain-noclose-xl7n52'])
);
check(
  'field-blind, same as branchNamesIn underneath it — title, description or notes',
  ownedBranchNamesIn({ id: 'bc-xl7n.52', title: 'worktree-inmain-noclose-xl7n52' }).length === 1 &&
    ownedBranchNamesIn({ id: 'bc-xl7n.52', description: 'worktree-inmain-noclose-xl7n52' }).length === 1
);
check(
  'a triage note naming a dozen children\'s branches keeps none of them for the parent',
  ownedBranchNamesIn({
    id: 'bc-xl7n',
    notes: 'worktree-a-xl7n1, worktree-b-xl7n2 and worktree-c-xl7n3 are all still open.',
  }).length === 0
);
check('a bead with no id owns nothing', ownedBranchNamesIn({ description: 'worktree-a-1' }).length === 0);

check('an open bead is a candidate', isCandidate({ status: 'open' }));
check(
  'a bead a session is sitting in is not — the flag would arrive mid-turn',
  !isCandidate({ status: 'in_progress' })
);
check('a closed one is not', !isCandidate({ status: 'closed' }));
check('one already in the inbox is not', !isCandidate({ status: 'open', labels: ['human'] }));
check(
  'and one held for endorsement is not — no session can be opened on it anyway',
  !isCandidate({ status: 'open', labels: ['unendorsed'] })
);

/**
 * bc-7qo.8 — and the one exclusion that is not about this bead at all.
 *
 * Flagging applies `human`, and `human` is what `bd.listAgent` excludes: the merge
 * queue's only read of the tracker. So a card offered here on a merge-bead does not
 * merely ask a meaningless question, it takes that pull request out of the queue's sight
 * silently and for ever. The branch such a bead names is its own, and landing it is the
 * thing the bead exists to do.
 */
check(
  'a merge-bead is not a candidate — flagging one takes its pull request out of the queue',
  !isCandidate({ status: 'open', labels: ['merge-queue'] })
);
check(
  'even when it names a branch, which every merge-bead does',
  !isCandidate({
    status: 'open',
    labels: ['merge-queue', 'for:someone@example.com'],
    description: 'brings main into worktree-a-branch-9fx and merges it',
  })
);
check(
  'while an ordinary bead naming the same branch still is',
  isCandidate({ status: 'open', labels: [], description: 'brings main into worktree-a-branch-9fx and merges it' })
);

/* ------------------------------------------------------- may it offer a close */
//
// bc-xl7n.52. `close-it` is offered only where closing could not strand anything, and
// "anything" is the whole subtree rather than bd's own open-child gate: that one asks for
// children, so a bead whose children are all closed over a live grandchild passes it.

console.log('\nwhether the card may offer a close');

/** A tracker shape: `id: parent` for the edges, `id: status` for the rows. */
const shapeOf = (edges, states) =>
  familyOf({
    parents: new Map(Object.entries(edges)),
    beads: new Map(Object.entries(states).map(([id, row]) => [id, typeof row === 'string' ? { status: row } : row])),
  });

{
  const family = shapeOf(
    { 'wg-a.1': 'wg-a', 'wg-a.1.1': 'wg-a.1', 'wg-a.2': 'wg-a' },
    { 'wg-a': 'open', 'wg-a.1': 'closed', 'wg-a.1.1': 'open', 'wg-a.2': 'closed' }
  );

  check('a leaf with nothing under it may be closed from a card', closeOffer({ id: 'wg-a.2' }, family).close === true, JSON.stringify(closeOffer({ id: 'wg-a.2' }, family)));
  check(
    'a bead whose only live descendant is a GRANDchild may not — bd’s own gate would let that through',
    closeOffer({ id: 'wg-a' }, family).close === false && liveUnder(family, 'wg-a').join() === 'wg-a.1.1',
    JSON.stringify(closeOffer({ id: 'wg-a' }, family))
  );
  check(
    'and the reason names the beads, because a count is a dead end on a phone',
    /wg-a\.1\.1/.test(closeOffer({ id: 'wg-a' }, family).why),
    closeOffer({ id: 'wg-a' }, family).why
  );
  check(
    'a closed descendant is not a live one',
    liveUnder(shapeOf({ 'wg-b.1': 'wg-b' }, { 'wg-b': 'open', 'wg-b.1': 'closed' }), 'wg-b').length === 0
  );
  check(
    'an epic never gets the offer, even with nothing under it at all — a standing root is about to have children',
    closeOffer({ id: 'wg-a.2', issue_type: 'epic' }, family).close === false,
    JSON.stringify(closeOffer({ id: 'wg-a.2', issue_type: 'epic' }, family))
  );
  check(
    'and the epicness is taken off the index when the row does not carry it',
    closeOffer({ id: 'wg-e' }, shapeOf({}, { 'wg-e': { status: 'open', issue_type: 'epic' } })).close === false
  );
}

check(
  'a tracker whose shape could not be read withholds the offer — "I cannot tell" is not "nothing is under it"',
  closeOffer({ id: 'wg-a' }, familyOf(null)).close === false && closeOffer({ id: 'wg-a' }, familyOf(null)).why.includes('could not be read')
);
check(
  'and so does one that came back carrying an error, however many rows it has',
  closeOffer({ id: 'wg-a' }, familyOf({ parents: new Map(), beads: new Map([['wg-a', { status: 'open' }]]), error: 'bd export timed out' })).close === false
);
check(
  'a cycle bd cannot express does not hang the walk',
  liveUnder(shapeOf({ 'wg-c': 'wg-d', 'wg-d': 'wg-c' }, { 'wg-c': 'open', 'wg-d': 'open' }), 'wg-c').join() === 'wg-d'
);

/* --------------------------------------------------------- the git question */

console.log('\nwhat counts as already in main');

{
  const landed = await landingMerge(REPO, c3, 'refs/remotes/origin/main');
  check('a branch merged with a merge commit is in, and the commit is named', landed.landed === true && landed.commit === m1, JSON.stringify(landed));
  check('and the landing commit’s subject travels with it', /worktree-landed-aaa/.test(landed.subject || ''), landed.subject);
}
{
  const empty = await landingMerge(REPO, c2, 'refs/remotes/origin/main');
  check(
    'a branch with no commits of its own is NOT in, though it is an ancestor',
    empty.landed === false && /nothing merged it in/.test(empty.why),
    JSON.stringify(empty)
  );
}
{
  const unmerged = await landingMerge(REPO, git('rev-parse', 'worktree-live-bbb'), 'refs/remotes/origin/main');
  check('an unmerged branch is not in', unmerged.landed === false && /not an ancestor/.test(unmerged.why), JSON.stringify(unmerged));
}
{
  const squashed = await landingMerge(REPO, git('rev-parse', 'worktree-squash-ddd'), 'refs/remotes/origin/main');
  check(
    'a squash-merged branch is not in either — no history, so nothing to claim',
    squashed.landed === false && /not an ancestor/.test(squashed.why),
    JSON.stringify(squashed)
  );
}
{
  const tip = await landingMerge(REPO, m2, 'refs/remotes/origin/main');
  check(
    'a branch sitting on the base tip is not claimed — a fast-forward looks like an unstarted one',
    tip.landed === false && /nothing merged it in/.test(tip.why),
    JSON.stringify(tip)
  );
}
{
  const nothing = await landingMerge(REPO, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'refs/remotes/origin/main');
  check(
    'a sha git has never heard of is "cannot tell", not "no"',
    nothing.landed === false && nothing.unknown === true,
    JSON.stringify(nothing)
  );
}

/* ----------------------------------------------------------------- the sweep */

console.log('\nthe sweep');

{
  const bd = fakeBd([{ id: 'wg-aaa', title: 'land the accordion log', description: 'Land `worktree-landed-aaa` and stop.' }]);
  const result = await sweepInMain(bd, ws('one'), REPO);

  check('a bead whose branch is in main is flagged', result.flagged.length === 1 && result.flagged[0].id === 'wg-aaa', JSON.stringify(result));
  check('the flag names the commit that landed it', result.flagged[0]?.commit === m1, JSON.stringify(result.flagged));
  check('nothing was closed', !bd.writes.some((w) => w.kind === 'close'), kinds(bd));
  check(
    'it wrote a comment, then the ask, then the label — in that order',
    kinds(bd) === 'comment:wg-aaa notes:wg-aaa label:wg-aaa',
    kinds(bd)
  );
  check('the label is `human`, which is what takes it out of bd ready', bd.writes.at(-1)?.label === 'human', kinds(bd));
  check('the bead now carries the ask mark for that branch', alreadyAsked(bd.rows[0], 'worktree-landed-aaa'), bd.rows[0].notes);
  check('the summary line says what it did', /wg-aaa \(worktree-landed-aaa\)/.test(describeInMain(result)), describeInMain(result));

  // Claim 3, run as the loop would actually happen: the same rows, carrying what the
  // first sweep wrote. The `human` label is taken off by hand first, because that is what
  // answering "keep it open" does — and a guard that read the label would re-ask here.
  bd.rows[0].labels = [];
  bd.writes.length = 0;
  const second = await sweepInMain(bd, ws('one'), REPO);
  check('a second sweep writes nothing at all', bd.writes.length === 0, kinds(bd));
  check(
    'and says why it left it alone',
    second.flagged.length === 0 && /already carries the ask/.test(why(second, 'wg-aaa')),
    JSON.stringify(second.skipped)
  );
}

{
  // Claim 1, through the whole sweep rather than just the git call: a session that filed
  // a bead naming the worktree it is working in must not be told the work has landed.
  // The id's tag is `ccc`, matching the branch, so ownership is not what this is testing.
  const bd = fakeBd([{ id: 'wg-ccc', description: 'Working in `worktree-empty-ccc` on the stepper.' }]);
  const result = await sweepInMain(bd, ws('two'), REPO);
  check('a bead naming an unstarted worktree branch is left completely alone', bd.writes.length === 0, kinds(bd));
  check('and the reason says nothing ever merged it in', /nothing merged it in/.test(why(result, 'wg-ccc')), JSON.stringify(result.skipped));
}

{
  const bd = fakeBd([{ id: 'wg-bbb', description: 'Ship `worktree-live-bbb`.' }]);
  const result = await sweepInMain(bd, ws('three'), REPO);
  check('a bead whose branch has not landed is left alone', bd.writes.length === 0 && result.flagged.length === 0, kinds(bd));
  check('and quietly — an unmerged branch is not news', result.skipped.every((s) => s.quiet), JSON.stringify(result.skipped));
}

{
  const bd = fakeBd([{ id: 'wg-ddd', description: 'Ship `worktree-squash-ddd`.' }]);
  await sweepInMain(bd, ws('four'), REPO);
  check('a squash-merged branch produces no comment, so it cannot produce a loop of them', bd.writes.length === 0, kinds(bd));
}

{
  const bd = fakeBd([{ id: 'wg-eee', description: 'Land `worktree-remote-eee`, whose local ref is long gone.' }]);
  const result = await sweepInMain(bd, ws('five'), REPO);
  check("a branch that survives only as origin's is still read", result.flagged.length === 1, JSON.stringify(result));
}

{
  const bd = fakeBd([{ id: 'wg-zzz', description: 'Land `worktree-ghost-zzz`.' }]);
  const result = await sweepInMain(bd, ws('six'), REPO);
  check('a branch with no ref anywhere is reported, not guessed at', bd.writes.length === 0 && /no local or origin ref/.test(why(result, 'wg-zzz')), JSON.stringify(result.skipped));
}

{
  // The base is `origin/main` and not this laptop's `main`: a dozen sessions land through
  // GitHub and pull at their own pace, so local main routinely carries what nobody else
  // has. Proved by moving origin/main *behind* the merge — local main still has it.
  setOrigin(c2);
  const bd = fakeBd([{ id: 'wg-aaa', description: 'Land `worktree-landed-aaa`.' }]);
  const result = await sweepInMain(bd, ws('seven'), REPO);
  check(
    'a branch in local main but not in origin/main is not claimed to be in main',
    bd.writes.length === 0 && result.flagged.length === 0,
    kinds(bd)
  );
  setOrigin(m2);
  const after = await sweepInMain(fakeBd([{ id: 'wg-aaa', description: 'Land `worktree-landed-aaa`.' }]), ws('eight'), REPO);
  check('and is claimed the moment origin/main has it', after.flagged.length === 1, JSON.stringify(after));
}

{
  const bd = fakeBd([{ id: 'wg-x', status: 'in_progress', description: 'Land `worktree-landed-aaa`.' }]);
  await sweepInMain(bd, ws('nine'), REPO);
  check('a bead a session is working is never flagged, landed branch or not', bd.writes.length === 0, kinds(bd));
}

{
  const bd = fakeBd([{ id: 'wg-none', description: 'Nothing about any branch at all.' }]);
  const result = await sweepInMain(bd, ws('ten'), REPO);
  check('a bead naming no branch costs no git at all', result.checked === 0 && bd.writes.length === 0, JSON.stringify(result));
}

{
  const result = await sweepInMain(fakeBd([]), ws('eleven'), path.join(tmp, 'not-a-repo'));
  check('a workspace with no checkout behind it is a reason, not a throw', result.ok === false && /not a git checkout/.test(result.reason), JSON.stringify(result));
}

/* ------------------------------------------------------------ the card itself */

console.log('\nthe card it writes');

const { toQuestion } = await import(LIB('decision.js'));

{
  const bd = fakeBd([{ id: 'wg-aaa', title: 'land the accordion log', description: 'Land `worktree-landed-aaa`.' }]);
  await sweepInMain(bd, ws('twelve'), REPO);
  const row = bd.rows[0];
  const q = toQuestion('widgets', { id: row.id, title: row.title, description: row.description, notes: row.notes, status: 'open' });

  check('the block parses — no YAML errors on the way to the phone', q.errors.length === 0, JSON.stringify(q.errors));
  check('two options, and both of them real', q.decision?.options?.length === 2, JSON.stringify(q.decision?.options));
  check('one of them closes the bead', q.decision?.options?.some((o) => o.id === 'close-it' && o.closes === true), JSON.stringify(q.decision?.options));
  check(
    'and the other does not — it hands the bead back instead',
    q.decision?.options?.some((o) => o.id === 'keep-open' && o.closes === false),
    JSON.stringify(q.decision?.options)
  );
  check(
    'neither is recommended: the sweep cannot tell, and the card should not pretend to',
    q.decision?.options?.every((o) => !o.recommended),
    JSON.stringify(q.decision?.options)
  );
  check('the question names the branch and the bead', /worktree-landed-aaa/.test(q.question) && /wg-aaa/.test(q.question), q.question);
  check(
    'the body says outright that nothing has been closed',
    q.sections.some((s) => /nothing has been closed/i.test(s.markdown)),
    JSON.stringify(q.sections.map((s) => s.field))
  );
  // The mark has to be *in* the body — it is the guard — and has to be invisible on the
  // card. An HTML comment is both, which is why lib/superseded.js writes its one the same
  // way; a bare `beadcause:inmain wt-x` line would be a machine token on a phone screen.
  check(
    'the mark rides as an HTML comment, so it guards without showing',
    /<!--\s*beadcause:inmain worktree-landed-aaa\s*-->/.test(q.sections.map((s) => s.markdown).join('\n')),
    q.sections.map((s) => s.markdown).join('\n').slice(0, 200)
  );
  check('and the mark is what alreadyAsked looks for', row.notes.includes(askMark('worktree-landed-aaa')));
}

/* ------------------------------------------ and the card it must not write */
//
// bc-xl7n.52, end to end and in the terms it was filed in: an advocate's triage note
// names the branches of the children it surveyed, and the P0 that commissioned the
// survey used to acquire one offer to close *itself* per branch named. bc-xl7n.67 goes
// further: that survey note must not write a card at all, because the branch it names
// was never this bead's to be asked about.

console.log('\nthe card on a bead that holds a subtree');

/** The bead as the advocate left it: a P0 whose notes name a child's branch. */
const surveyNote = 'Left `worktree-landed-aaa` alone — a session is sitting in it and it is alive.';

{
  // bc-xl7n.67: `worktree-landed-aaa` is `wg-aaa`'s branch, not `wg-root`'s — the advocate
  // only mentioned it while surveying a child. The whole point of the fix is that this
  // bead now acquires no card at all, not a card with the close offer trimmed off it.
  const bd = fakeBd([
    { id: 'wg-root', issue_type: 'epic', title: 'the unsorted backlog', notes: surveyNote },
    { id: 'wg-root.1', parent: 'wg-root', status: 'open', title: 'a child nobody has finished' },
  ]);
  const result = await sweepInMain(bd, ws('thirteen'), REPO);
  check(
    'a triage note naming a branch that is not this bead\'s writes nothing at all',
    bd.writes.length === 0 && result.flagged.length === 0 && result.checked === 0,
    kinds(bd)
  );
}

{
  // The other half of the same fix: a bead naming its *own* landed branch — tag matching
  // — still gets the card, epic or not, and the epic exclusion from bc-xl7n.52 is still
  // live on it. `wg-aaa`'s tag is `aaa`, which is what `worktree-landed-aaa` ends in.
  const bd = fakeBd([{ id: 'wg-aaa', issue_type: 'epic', title: 'the unsorted backlog', notes: surveyNote }]);
  const result = await sweepInMain(bd, ws('thirteen-b'), REPO);
  const row = bd.rows[0];
  const q = toQuestion('widgets', { id: row.id, title: row.title, notes: row.notes, status: 'open' });

  check('an epic naming its own landed branch is still asked about it', result.flagged.length === 1 && bd.writes.some((w) => w.kind === 'comment'), kinds(bd));
  check('the block still parses', q.errors.length === 0, JSON.stringify(q.errors));
  check(
    'but there is no close-it on it — the epic exclusion is untouched',
    !(q.decision?.options || []).some((o) => o.id === 'close-it'),
    JSON.stringify(q.decision?.options)
  );
  check(
    'one option is left and it hands the bead back rather than finishing it',
    q.decision?.options?.length === 1 && q.decision.options[0].id === 'keep-open' && q.decision.options[0].closes === false,
    JSON.stringify(q.decision?.options)
  );
  check('and still nothing was closed', !bd.writes.some((w) => w.kind === 'close'), kinds(bd));
  check(
    'the sweep reports which kind of card it wrote, for the log',
    result.flagged[0]?.close === false && /epic/.test(result.flagged[0]?.why || ''),
    JSON.stringify(result.flagged)
  );
}

{
  // The half of the acceptance criterion that is not about epics at all: a bead naming
  // its own branch in its *notes* — a delivering session recording where it landed —
  // must still be flagged. Ownership is field-blind, same as `branchNamesIn` underneath.
  const bd = fakeBd([{ id: 'wg-aaa', title: 'land the accordion log', notes: 'Delivered as `worktree-landed-aaa`.' }]);
  const result = await sweepInMain(bd, ws('thirteen-c'), REPO);
  check(
    'a bead naming its own branch in its notes is still asked, not just in its description',
    result.flagged.length === 1 && result.flagged[0].id === 'wg-aaa',
    JSON.stringify(result)
  );
}

{
  // Not an epic, and no children — but a live grandchild under a closed child, which is
  // exactly the shape bd's own open-child gate lets through. `wg-aaa`'s tag matches
  // `worktree-landed-aaa`, which is what makes this the bead's own branch.
  const bd = fakeBd([
    { id: 'wg-aaa', title: 'a task with a subtree', description: 'Land `worktree-landed-aaa`.' },
    { id: 'wg-aaa.1', parent: 'wg-aaa', status: 'closed' },
    { id: 'wg-aaa.1.1', parent: 'wg-aaa.1', status: 'open' },
  ]);
  const result = await sweepInMain(bd, ws('fourteen'), REPO);
  const q = toQuestion('widgets', { id: 'wg-aaa', title: '', notes: bd.rows[0].notes, status: 'open' });
  check(
    'a live grandchild under a closed child takes the close offer away too',
    result.flagged[0]?.close === false && !(q.decision?.options || []).some((o) => o.id === 'close-it'),
    JSON.stringify(q.decision?.options)
  );
  check('and the card names the bead that is still open', /wg-aaa\.1\.1/.test(q.sections.map((x) => x.markdown).join('\n')), result.flagged[0]?.why);
}

{
  const bd = fakeBd([{ id: 'wg-aaa', title: 'a leaf', description: 'Land `worktree-landed-aaa`.' }]);
  const result = await sweepInMain(bd, ws('fifteen'), REPO);
  const q = toQuestion('widgets', { id: 'wg-aaa', title: '', notes: bd.rows[0].notes, status: 'open' });
  check(
    'a leaf keeps both options — the feature still works for the case it was built for',
    result.flagged[0]?.close === true && (q.decision?.options || []).some((o) => o.id === 'close-it'),
    JSON.stringify(q.decision?.options)
  );
}

{
  // A `bd` with no `graph` at all: a caller's own stub, or a tracker that would not
  // answer. The sweep must not throw, and must not guess in the permissive direction.
  const bd = fakeBd([{ id: 'wg-aaa', title: 'a leaf', description: 'Land `worktree-landed-aaa`.' }], { graph: false });
  const result = await sweepInMain(bd, ws('sixteen'), REPO);
  const q = toQuestion('widgets', { id: 'wg-aaa', title: '', notes: bd.rows[0].notes, status: 'open' });
  check(
    'a tracker that cannot say what is under a bead still gets a card, without the close',
    result.flagged.length === 1 && result.flagged[0].close === false && !(q.decision?.options || []).some((o) => o.id === 'close-it'),
    JSON.stringify(result.flagged)
  );
}

/* ------------------------------------------ and the card stays answerable */
//
// Claim 5. bd refuses a close over an open child (`Bd.gateFor`), and the phone withdraws
// the answer button when it knows that refusal is coming — so the beads this withholds
// the offer from are precisely the beads whose cards are gated. A card whose every option
// is a commission has to be the shape that gate leaves alone, or the fix above swaps a
// close nobody could press for a card nobody could answer.
//
// public/app.js is one IIFE with nothing exported, so the declarations are sliced out and
// run in a `vm`, unknown globals stubbed through a Proxy — test/optionanswer.mjs's method.

console.log('\nthe card stays answerable on a gated bead');

{
  const APP = fs.readFileSync(path.join(HERE, '..', 'public', 'app.js'), 'utf8');

  /** Lift one declaration out of public/app.js — copied from test/optionanswer.mjs. */
  const lift = (src, opener) => {
    const at = src.indexOf(opener);
    if (at === -1) throw new Error(`public/app.js no longer declares \`${opener}\``);
    if (opener.startsWith('function')) {
      let depth = 0;
      for (let i = src.indexOf('{', at); i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
          depth -= 1;
          if (!depth) return src.slice(at, i + 1);
        }
      }
      throw new Error(`unbalanced braces after ${opener}`);
    }
    let depth = 0;
    for (let i = at; i < src.length; i += 1) {
      const c = src[i];
      if (c === '{' || c === '(' || c === '[') depth += 1;
      else if (c === '}' || c === ')' || c === ']') depth -= 1;
      else if (c === ';' && depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`no statement end after ${opener}`);
  };

  const STUB = () => '';
  const real = {
    String,
    JSON,
    Object,
    Boolean,
    Array,
    Set,
    Map,
    CSS: { escape: (x) => x },
    state: { prDecline: new Set(), picked: new Map() },
  };
  const ctx = vm.createContext(new Proxy(real, { has: () => true, get: (t, k) => (k in t ? t[k] : STUB) }));
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'const allCommissions = ('),
      lift(APP, 'function answerLabel(chosen, q)'),
      lift(APP, 'function pickedOption(q)'),
      lift(APP, 'function freeformHtml(q)'),
    ].join('\n'),
    ctx
  );
  const draw = (q) => vm.runInContext('freeformHtml', ctx)(q);
  const opt = (id, closes) => ({ id, label: id, response: id, closes });
  // What `/api/bead` puts on a card it knows bd will refuse to close.
  const gate = { kind: 'epic', blockers: [{ id: 'wg-root.1', title: '' }], reason: 'an epic with 1 open child issue' };

  const both = { key: 'k1', id: 'wg-leaf', gate, decision: { options: [opt('close-it', true), opt('keep-open', false)] } };
  check(
    'a card that still offers a close draws no answer button on a gated bead — unchanged',
    !draw(both).includes('data-act="answer"'),
    draw(both).slice(0, 200)
  );

  const commission = { key: 'k2', id: 'wg-root', gate, decision: { options: [opt('keep-open', false)] } };
  check(
    'a card whose every option commissions keeps its button, because no refusal is coming',
    draw(commission).includes('data-act="answer"'),
    draw(commission).slice(0, 300)
  );
  check(
    'and the button says what the press will do, with nothing picked',
    draw(commission).includes('Answer &amp; commission'),
    draw(commission).slice(0, 400)
  );

  const bare = { key: 'k3', id: 'wg-bare', gate, decision: { options: [] } };
  check(
    'a card with no options at all is still gated — a typed answer there closes',
    !draw(bare).includes('data-act="answer"'),
    draw(bare).slice(0, 200)
  );

  const ungated = { key: 'k4', id: 'wg-open', decision: { options: [opt('close-it', true), opt('keep-open', false)] } };
  check('and an ungated card is untouched by any of it', draw(ungated).includes('data-act="answer"'), draw(ungated).slice(0, 200));

  // bc-7qo.11. A deferral (`defers: true`) is `closes: false` too, and the server skips
  // the gate for it for the same reason — so a gated card whose every choice defers has
  // no refusal coming, and withdrawing the button would leave a card nobody can put off.
  // The label is the other half and pulls the other way: with nothing picked it describes
  // a *typed* answer, and a typed answer there closes, because a deferral starts no work
  // for a sentence to lose. One predicate cannot serve both, which is the whole subtlety —
  // and narrowing the gate predicate to serve the label is exactly the regression that
  // reached a pull request before this assertion existed.
  const park = { id: 'later', label: 'Not yet', response: 'Not yet.', closes: false, defers: true };
  const defersOnly = { key: 'k5', id: 'wg-park', gate, decision: { options: [park] } };
  check(
    'a gated card whose only choice defers keeps its button — nothing there was going to close',
    draw(defersOnly).includes('data-act="answer"'),
    draw(defersOnly).slice(0, 300)
  );
  check(
    'and with nothing picked it promises a close, not a commission — that is what a sentence does there',
    draw(defersOnly).includes('Answer &amp; close'),
    draw(defersOnly).slice(0, 400)
  );

  // The mixed shape, which is the likelier one in practice and the one the narrowed
  // predicate broke hardest: lib/inmain.js already writes a commission onto a bead with a
  // live subtree, and those are exactly the beads bd gates. Add a "not yet" beside it and
  // the card must keep its button — under the narrowed predicate it lost it.
  const mixed = { key: 'k6', id: 'wg-mixed', gate, decision: { options: [opt('keep-open', false), park] } };
  check(
    'and a gated card offering a commission beside a deferral keeps its button too',
    draw(mixed).includes('data-act="answer"'),
    draw(mixed).slice(0, 300)
  );
}

/* ---------------------------------------------------- and through the tick */
//
// The whole bead, in the terms it was filed in: no session is opened on work already in
// main. Checked against a spy rather than against iTerm, which is also what makes it
// safe — an assertion that no window opened is worthless if the way it fails is by
// opening one. The control case runs the same tick with the sweep off, because "no
// session opened" passes for a dozen uninteresting reasons and only one of them is this.

console.log('\nthe advocate tick');

const { createAdvocates } = await import(LIB('advocate.js'));

async function tickWith(bd, { flagInMain: on = true, pr = { enabled: true, base: 'main' } } = {}) {
  const workspace = { name: 'widgets', dir: path.join(tmp, 'beads', 'widgets', '.beads') };
  const opened = [];
  const cfg = {
    workspaces: [workspace],
    spaces: [],
    claudeSessions: false,
    sessionDirs: { widgets: REPO },
    pr,
    advocates: {
      enabled: true,
      workspaces: ['*'],
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Off: each is another feature with its own suite, and all three would otherwise
      // run real git, real `gh` or a real agent against a temp directory on every case.
      tidyWorktrees: false,
      propose: false,
      respectQuietHours: false,
      sessionLog: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: on,
    },
  };
  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, bead) => {
      opened.push(bead.id);
      return { dir: REPO, mode: 'test', term: null };
    },
  });
  await advocates.tick();
  return { opened, advocates };
}

{
  const bd = fakeBd([{ id: 'wg-aaa', title: 'land the accordion log', description: 'Land `worktree-landed-aaa`.' }]);
  const { opened } = await tickWith(bd);
  check('the tick flags the bead whose branch is already in main', bd.writes.some((w) => w.kind === 'label' && w.label === 'human'), kinds(bd));
  check('and opens no session on it', opened.length === 0, `opened: ${opened.join(', ')}`);
  check('and still closes nothing', !bd.writes.some((w) => w.kind === 'close'), kinds(bd));
}

{
  const bd = fakeBd([{ id: 'wg-aaa', title: 'land the accordion log', description: 'Land `worktree-landed-aaa`.' }]);
  const { opened } = await tickWith(bd, { flagInMain: false });
  check('with the sweep off, that same tick does open one', opened.includes('wg-aaa'), `opened: ${opened.join(', ')}`);
  check('and the bead is untouched', bd.writes.length === 0, kinds(bd));
}

// bc-ka5y.15.17: `flagInMain`'s call to `sweepInMain` passed `configuredBase(cfg,
// a.workspace)` — the workspace *object*, not its name — so `pr.basePerWorkspace` always
// missed and every sweep silently fell back to `pr.base`. `pr.base` here is deliberately
// broken, so only a correctly-threaded `a.name` lookup into `basePerWorkspace` can find
// the real `main` ref and let the sweep run at all; the buggy code would have `pickBase`
// fail against `bogus-global-base` and the sweep would flag nothing.
{
  const bd = fakeBd([{ id: 'wg-aaa', title: 'land the accordion log', description: 'Land `worktree-landed-aaa`.' }]);
  const { opened, advocates } = await tickWith(bd, {
    pr: { enabled: true, base: 'bogus-global-base', basePerWorkspace: { widgets: 'main' } },
  });
  check(
    'a workspace-specific pr.base override still flags a branch already in main',
    bd.writes.some((w) => w.kind === 'label' && w.label === 'human'),
    kinds(bd)
  );
  check(
    'and opens no session on it — the override base, not the broken global default, reached the sweep',
    opened.length === 0,
    `opened: ${opened.join(', ')}`
  );
  const inMain = advocates.snapshot().find((s) => s.workspace === 'widgets')?.inMain;
  check(
    'and the sweep did not skip with the broken global base as its reason',
    !String(inMain?.summary || '').includes('bogus-global-base'),
    JSON.stringify(inMain)
  );
}

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
