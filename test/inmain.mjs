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
 * 4. **The card it writes parses, with two real options.** The block is hand-built YAML
 *    inside markdown, so it is read back through `toQuestion` — the same path the phone
 *    uses — rather than eyeballed.
 *
 * The git repo is real and thrown away; `bd` is an object that records what it was asked
 * to write. Nothing here reaches a tracker, GitHub, iTerm or a repo of yours.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-inmain-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

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
  isCandidate,
  landingMerge,
  askMark,
  alreadyAsked,
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
function fakeBd(beads) {
  const rows = beads.map((b) => ({ status: 'open', title: '', labels: [], ...b }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const writes = [];
  return {
    writes,
    rows,
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
  const bd = fakeBd([{ id: 'wg-new', description: 'Working in `worktree-empty-ccc` on the stepper.' }]);
  const result = await sweepInMain(bd, ws('two'), REPO);
  check('a bead naming an unstarted worktree branch is left completely alone', bd.writes.length === 0, kinds(bd));
  check('and the reason says nothing ever merged it in', /nothing merged it in/.test(why(result, 'wg-new')), JSON.stringify(result.skipped));
}

{
  const bd = fakeBd([{ id: 'wg-live', description: 'Ship `worktree-live-bbb`.' }]);
  const result = await sweepInMain(bd, ws('three'), REPO);
  check('a bead whose branch has not landed is left alone', bd.writes.length === 0 && result.flagged.length === 0, kinds(bd));
  check('and quietly — an unmerged branch is not news', result.skipped.every((s) => s.quiet), JSON.stringify(result.skipped));
}

{
  const bd = fakeBd([{ id: 'wg-squash', description: 'Ship `worktree-squash-ddd`.' }]);
  await sweepInMain(bd, ws('four'), REPO);
  check('a squash-merged branch produces no comment, so it cannot produce a loop of them', bd.writes.length === 0, kinds(bd));
}

{
  const bd = fakeBd([{ id: 'wg-remote', description: 'Land `worktree-remote-eee`, whose local ref is long gone.' }]);
  const result = await sweepInMain(bd, ws('five'), REPO);
  check("a branch that survives only as origin's is still read", result.flagged.length === 1, JSON.stringify(result));
}

{
  const bd = fakeBd([{ id: 'wg-ghost', description: 'Land `worktree-ghost-zzz`.' }]);
  const result = await sweepInMain(bd, ws('six'), REPO);
  check('a branch with no ref anywhere is reported, not guessed at', bd.writes.length === 0 && /no local or origin ref/.test(why(result, 'wg-ghost')), JSON.stringify(result.skipped));
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

/* ---------------------------------------------------- and through the tick */
//
// The whole bead, in the terms it was filed in: no session is opened on work already in
// main. Checked against a spy rather than against iTerm, which is also what makes it
// safe — an assertion that no window opened is worthless if the way it fails is by
// opening one. The control case runs the same tick with the sweep off, because "no
// session opened" passes for a dozen uninteresting reasons and only one of them is this.

console.log('\nthe advocate tick');

const { createAdvocates } = await import(LIB('advocate.js'));

async function tickWith(bd, { flagInMain: on = true } = {}) {
  const workspace = { name: 'widgets', dir: path.join(tmp, 'beads', 'widgets', '.beads') };
  const opened = [];
  const cfg = {
    workspaces: [workspace],
    spaces: [],
    claudeSessions: false,
    sessionDirs: { widgets: REPO },
    pr: { enabled: true, base: 'main' },
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

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
