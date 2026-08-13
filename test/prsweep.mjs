#!/usr/bin/env node
/**
 * **The sweep after a merge** — which open pull requests conflict now, and which of
 * them are ours to touch.
 *
 *     npm test
 *     node test/prsweep.mjs
 *
 * lib/prsweep.js is the trigger the rest of bc-9d37 was written around: `mergeability`
 * already waits out GitHub's UNKNOWN window, lib/resolvers.js already caps and queues
 * resolvers, `conflictPromptFor` is already the brief. What had no test until now is the
 * decision in between, and it has four ways to be wrong that no screenshot would show:
 *
 * 1. **Reading `mergeable` off a row finds nothing.** For a few seconds after a merge
 *    lands, GitHub answers `UNKNOWN` for every other open pull request in the repo while
 *    it recomputes merge bases. A sweep that believed the first read would report a
 *    clean board, reliably, every time — indistinguishable from a feature that does not
 *    work. So #14 here answers UNKNOWN once and CONFLICTING after, and it must be swept.
 * 2. **Merging `main` into a teammate's branch is not ours to do.** Forty Climative
 *    repos share one tracker and other engineers have branches open in all of them. #12
 *    conflicts exactly as loudly as #11 does and must be left alone, red chip and all.
 * 3. **The tracker is single-writer and loses lock races.** A `bd` that answers `[]`
 *    for a bead a worker opened this morning must not be enough to decide the branch
 *    belongs to a stranger — #16's bead does not resolve, and the session archive in
 *    `refs/beadcause/sessions/` is what claims it.
 * 4. **A sweep can open two windows nobody asked for.** So it refuses an observer daemon
 *    and `openSessions: false` outright, and it refuses them *before* it reads anything
 *    at all — asserted here by the `gh` log being empty rather than by the sentence.
 *
 * A real git repo with real session archives, because the ownership test is a git
 * question; a fake `gh`, so the UNKNOWN window can be staged; a stub `bd`; and the real
 * `resolveFor` from lib/resolvers.js with a **launch spy** in place of
 * `openConflictSession`, so the cap, the queue and the lock are the real ones and
 * nothing in this suite can open an iTerm window.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

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

/* ------------------------------------------------------ the observer child, first */

/*
 * `OBSERVING` resolves once, at module load, so one process can only ever test one
 * value of it — the same reason test/observe.mjs runs its cases in children. This file
 * re-runs itself with the flag on for exactly one case, and that case needs no repo, no
 * `gh` and no tracker: the whole claim is that a sweep on an observer reads *nothing*.
 */
if (process.argv[2] === 'observing') {
  const { sweepConflicts } = await import(LIB('prsweep.js'));
  const { OBSERVING, OBSERVING_NOTE } = await import(LIB('config.js'));
  if (!OBSERVING) {
    console.error('the observer child ran without the flag set');
    process.exit(1);
  }
  let reads = 0;
  const res = await sweepConflicts(
    { json: async () => [], show: async () => null },
    { openSessions: true },
    {
      ws: { name: 'demo' },
      unit: { key: 'demo' },
      dir: os.tmpdir(),
      after: 1,
      list: async () => {
        reads += 1;
        return [];
      },
      open: () => {
        throw new Error('an observer opened a window');
      },
    }
  );
  if (res.refused !== OBSERVING_NOTE) {
    console.error(`expected the observing refusal, got ${JSON.stringify(res.refused)}`);
    process.exit(1);
  }
  if (reads !== 0) {
    console.error('an observer asked GitHub about the repo before refusing');
    process.exit(1);
  }
  process.exit(0);
}

/* -------------------------------------------------------------------- the repo */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-prsweep-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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

const repo = path.join(tmp, 'widgets');
git(tmp, 'init', '--quiet', '--initial-branch=main', repo);
git(repo, 'config', 'user.email', 't@e');
git(repo, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
git(repo, 'add', 'file.txt');
git(repo, 'commit', '--quiet', '-m', 'one');

/* ------------------------------------------------------- a real session archive */

/*
 * The archive is the half of the ownership test that git answers rather than `bd`, and
 * it is only reachable when the tracker will *not* confirm a bead — so the one written
 * here is for `zz-arch`, a bead the stub tracker below deliberately does not know.
 * `archiveSession` reads the branch off the worktree the session ran in and there is no
 * such worktree here, so the field the match is made on is written directly afterwards,
 * exactly as test/prfull.mjs does it.
 */
const { archiveSession } = await import(LIB('sessionlog.js'));

const stampBranch = (bead, branch) => {
  const ref = `refs/beadcause/sessions/${bead}`;
  const meta = JSON.parse(git(repo, 'cat-file', '-p', `${ref}:meta.json`));
  meta.branch = branch;
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    input: JSON.stringify(meta, null, 2) + '\n',
    encoding: 'utf8',
  }).trim();
  const log = git(repo, 'cat-file', '-p', `${ref}:session.log`).trim();
  const logBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    input: log + '\n',
    encoding: 'utf8',
  }).trim();
  const tree = execFileSync('git', ['mktree'], {
    cwd: repo,
    input: `100644 blob ${blob}\tmeta.json\n100644 blob ${logBlob}\tsession.log\n`,
    encoding: 'utf8',
  }).trim();
  const parent = git(repo, 'rev-parse', ref);
  const commit = git(repo, 'commit-tree', tree, '-p', parent, '-m', `${bead} on ${branch}`);
  git(repo, 'update-ref', ref, commit);
};

await archiveSession(repo, {
  workspace: 'demo',
  bead: 'zz-arch',
  sessionId: '11111111-2222-3333-4444-555555555555',
  startedAt: '2026-08-12T09:00:00Z',
  endedAt: '2026-08-12T10:00:00Z',
  outcome: 'done',
  logLines: ['the session that opened it'],
  title: 'archived only',
});
stampBranch('zz-arch', 'worktree-lonely-arch');

/* ---------------------------------------------------------------- the fake gh */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const PR_STATE = path.join(tmp, 'prs.json');
const GH_LOG = path.join(tmp, 'gh-calls.log');
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

const rawPR = (over = {}) => ({
  number: 11,
  url: 'https://github.com/acme/widgets/pull/11',
  title: 'zz-work: the conflicting one',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  headRefName: 'worktree-thing-work',
  baseRefName: 'main',
  additions: 4,
  deletions: 1,
  changedFiles: 1,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: null,
  mergeCommit: null,
  body: 'What changed and why.\n',
  author: { login: 'someone' },
  createdAt: iso(2),
  updatedAt: iso(1),
  ...over,
});

/**
 * The fixture the acceptance criterion asks for, plus the three cases it does not.
 *
 * #10 merged — the one whose merge set the sweep off; it is `after`, and it must not be
 *     swept even though `gh pr list --state open` still hands it back for a moment
 * #11 CONFLICTING, carries `zz-work`                      → ours, and handed over
 * #12 CONFLICTING, no bead and no archive                 → a human's, left alone
 * #13 MERGEABLE, carries `zz-work`                        → nothing to do
 * #14 UNKNOWN on the first read, CONFLICTING after        → ours, and handed over
 * #15 CONFLICTING draft, carries `zz-work`                → skipped
 * #16 CONFLICTING, bead the tracker will not confirm, archived on its branch → ours
 * #17 CONFLICTING, based on `release-2`                   → a merge into main is not its business
 *
 * `mergeable` on the row is deliberately *wrong* nowhere here: the point is that the
 * sweep never reads it. #14 proves that by making the row's value the one that would
 * make the sweep find nothing.
 */
const resetPRs = () =>
  fs.writeFileSync(
    PR_STATE,
    JSON.stringify({
      /** How many times `gh pr view` has been asked about each number — #14's clock. */
      views: {},
      prs: [
        rawPR({
          number: 10,
          url: 'https://github.com/acme/widgets/pull/10',
          title: 'zz-work: the one that landed',
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          headRefName: 'worktree-landed-work',
        }),
        rawPR(),
        rawPR({
          number: 12,
          url: 'https://github.com/acme/widgets/pull/12',
          title: 'teammate work',
          headRefName: 'feature/teammate',
          body: 'no bead here\n',
          author: { login: 'someone-else' },
        }),
        rawPR({
          number: 13,
          url: 'https://github.com/acme/widgets/pull/13',
          title: 'zz-work: still fits',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          headRefName: 'worktree-fits-work',
        }),
        rawPR({
          number: 14,
          url: 'https://github.com/acme/widgets/pull/14',
          title: 'zz-work: the slow one',
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'UNKNOWN',
          headRefName: 'worktree-slow-work',
        }),
        rawPR({
          number: 15,
          url: 'https://github.com/acme/widgets/pull/15',
          title: 'zz-work: still being written',
          isDraft: true,
          headRefName: 'worktree-draft-work',
        }),
        rawPR({
          number: 16,
          url: 'https://github.com/acme/widgets/pull/16',
          title: 'the one only git knows about',
          headRefName: 'worktree-lonely-arch',
          body: 'nothing claims a bead here\n',
        }),
        rawPR({
          number: 17,
          url: 'https://github.com/acme/widgets/pull/17',
          title: 'zz-work: stacked elsewhere',
          headRefName: 'worktree-stacked-work',
          baseRefName: 'release-2',
        }),
      ],
    })
  );
resetPRs();

/*
 * #14 is the whole reason `mergeability` exists: it answers UNKNOWN the first time it is
 * asked and CONFLICTING every time after, which is what GitHub does for a few seconds
 * after any merge lands. A sweep that read the list once and believed it finds nothing.
 */
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const STATE = ${JSON.stringify(PR_STATE)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + '\\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = (w) => fs.writeFileSync(STATE, JSON.stringify(w));
if (args[0] === 'auth' && args[1] === 'status') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/widgets' }));
if (args[0] === 'pr' && args[1] === 'list') out(JSON.stringify(load().prs));
if (args[0] === 'pr' && args[1] === 'view') {
  const n = Number(args[2]);
  const w = load();
  const pr = w.prs.find((p) => p.number === n);
  if (!pr) { process.stderr.write('no pull requests found for ' + args[2] + '\\n'); process.exit(1); }
  const seen = (w.views[n] || 0) + 1;
  w.views[n] = seen;
  save(w);
  if (n === 14 && seen > 1) out(JSON.stringify({ ...pr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
  out(JSON.stringify(pr));
}
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const ghCalls = () =>
  fs.existsSync(GH_LOG)
    ? fs
        .readFileSync(GH_LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/* --------------------------------------------------------------- the stub bd */

/*
 * `beadsFor` and `prefixFor` are the only two things the sweep asks a tracker, so the
 * stub is those two and nothing else. `zz-arch` is deliberately absent: it is the bead
 * #16 names, and the point of #16 is that git answers when `bd` will not.
 */
const BEADS = new Map([['zz-work', 'The work']]);
let bdShows = 0;
const bd = {
  json: async (_ws, args) => (args[0] === 'list' ? [{ id: 'zz-work' }] : []),
  show: async (_ws, id) => {
    bdShows += 1;
    return BEADS.has(id) ? { id, title: BEADS.get(id), status: 'in_progress' } : null;
  },
};

/* ------------------------------------------------------------------ the harness */

const { sweepConflicts } = await import(LIB('prsweep.js'));
const { forgetPrefixes } = await import(LIB('beadref.js'));
const resolvers = await import(LIB('resolvers.js'));
const { conflictPromptFor } = await import(LIB('session.js'));
const pr = await import(LIB('pr.js'));

const ws = { name: 'demo' };
const unit = { key: 'demo', workspace: 'demo', repo: null };
const cfg = { openSessions: true, owner: { name: 'Adam' }, workspaces: [ws] };

/** Every launch the sweep asked for, without ever reaching iTerm. */
let launches = [];
const spy = (_cfg, _ws, row, opts) => {
  launches.push({ row, opts });
  return { dir: opts.dir, mode: 'test', term: null };
};

/**
 * `mergeability` with the real logic and a test's patience.
 *
 * The default polls every three seconds to a thirty-second deadline, which is right for
 * GitHub and absurd for a suite. Only the two numbers change — the loop, the `UNKNOWN`
 * guard and the `unresolved` ending are the shipped ones.
 */
const quick = (dir, number, opts = {}) => pr.mergeability(dir, number, { intervalMs: 20, timeoutMs: 400, ...opts });

const sweep = (over = {}) =>
  sweepConflicts(bd, over.cfg || cfg, {
    ws,
    unit,
    dir: repo,
    after: 10,
    base: 'main',
    mergeability: quick,
    open: spy,
    ...over,
  });

const reset = () => {
  resolvers.reset();
  forgetPrefixes();
  pr.forgetAvailability();
  launches = [];
  bdShows = 0;
  resetPRs();
  fs.writeFileSync(GH_LOG, '');
};

const numbers = (rows) => rows.map((r) => r.number).sort((a, b) => a - b);

/* ------------------------------------------------------------------- the sweep */

{
  reset();
  const out = await sweep();

  // The acceptance criterion, in one line: exactly the conflicting one with a bead and
  // the one that was UNKNOWN on the first read reach the resolver launcher.
  check('exactly the two conflicting pull requests of ours are handed over', String(numbers(out.handed)) === '11,14', JSON.stringify(out.handed));
  check('and the launcher was asked for exactly those two', String(launches.map((l) => l.row.number).sort()) === '11,14', JSON.stringify(launches.map((l) => l.row.number)));

  // #14 is the whole shape of the wait. Its row said UNKNOWN; nothing in the result may.
  check('the one GitHub had not worked out yet is swept anyway', out.handed.some((r) => r.number === 14), JSON.stringify(out.handed));
  check('and it took more than one read of it to find out', ghCalls().filter((c) => c[0] === 'pr' && c[1] === 'view' && c[2] === '14').length > 1, JSON.stringify(ghCalls().filter((c) => c[1] === 'view')));

  // The refusal that is about somebody else's work rather than about this Mac.
  check('a conflicting pull request with no bead and no archive is left alone', numbers(out.theirs).includes(12), JSON.stringify(out.theirs));
  check('and nothing was launched for it', !launches.some((l) => l.row.number === 12), JSON.stringify(launches.map((l) => l.row.number)));
  check('with a reason that says why, not just that', /no bead named and no session archived/.test(out.theirs.find((r) => r.number === 12)?.why || ''), JSON.stringify(out.theirs));

  check('a pull request that still merges is left alone', String(numbers(out.mergeable)) === '13', JSON.stringify(out.mergeable));
  check('the merge that caused the sweep is not swept', !numbers(out.handed).includes(10) && !numbers(out.theirs).includes(10), JSON.stringify(out));
  check('a draft is skipped rather than resolved', String(numbers(out.drafts)) === '15', JSON.stringify(out.drafts));
  // A merge into `main` says nothing about a branch based on `release-2`, and a resolver
  // sent to it would merge the wrong base in. Asserted as an absence *and* as a count, so
  // a filter that dropped every row would not pass this by accident.
  const accounted = numbers(out.handed.concat(out.queued, out.reused, out.theirs, out.mergeable, out.drafts, out.unresolved, out.failed, out.trouble));
  check('every open pull request the sweep looked at is accounted for', out.open === 8 && out.checked === 6 && accounted.length === 6, JSON.stringify({ open: out.open, checked: out.checked, accounted }));
  check('and a pull request based on another branch was not one of them', !accounted.includes(17) && !accounted.includes(10), JSON.stringify(accounted));

  // The ownership half git answers. #16's bead is one the tracker denies outright, and
  // the archive under `refs/beadcause/sessions/zz-arch` names its branch.
  check('a bead the tracker will not confirm is still ours if a session archived the branch', out.handed.some((r) => r.number === 16) || out.queued.some((r) => r.number === 16), JSON.stringify({ handed: out.handed, queued: out.queued }));

  // Two live at a time — lib/resolvers.js's cap, applied by the real `resolveFor`. Three
  // of ours conflict, so the third waits for a window rather than being refused.
  check('the third conflicting one waits for a window rather than being refused', out.queued.length === 1, JSON.stringify(out.queued));
  check('and it is told its place in the line', out.queued[0]?.place === 1, JSON.stringify(out.queued));
  check('so exactly two windows were opened', launches.length === 2, JSON.stringify(launches.map((l) => l.row.number)));

  check('the sweep names the repo it swept', out.repo === 'acme/widgets', String(out.repo));
  check('and the merge it swept after', out.after === 10, String(out.after));
}

/* ------------------------------------------------- what the opened session is told */

{
  reset();
  await sweep();
  const first = launches[0];
  check('the launch is given the checkout to work in', first?.opts.dir === repo, String(first?.opts.dir));
  check('and the number of the merge that caused it', first?.opts.sweptAfter === 10, String(first?.opts.sweptAfter));
  check('the row it is given carries the bead, so the brief can name it', (first?.row.beads || []).some((b) => b.id === 'zz-work'), JSON.stringify(first?.row.beads));
  check('and the repo slug rather than the workspace name', first?.row.repo === 'acme/widgets', String(first?.row.repo));

  // The brief itself belongs to test/prfull.mjs. What is asserted here is only that what
  // the sweep hands over produces the *swept* reason rather than the press — a session
  // told Adam pressed a button when nobody did reasons the rest of its job out to match.
  const brief = conflictPromptFor('demo', first.row, 'Adam', { sweptAfter: first.opts.sweptAfter });
  check('the brief a swept session gets does not claim anybody pressed anything', !/pressed \*\*Resolve conflicts\*\*/.test(brief), brief.slice(0, 300));
  check('it names the merge that caused the sweep', /#10 merged into/.test(brief), brief.slice(0, 400));
  check('and the branch it is actually about', new RegExp(first.row.branch).test(brief), brief.slice(0, 400));
}

/* ------------------------------------------------ a session already on a pull request */

{
  reset();
  // A resolver is already up on #11 — the state lib/resolvers.js keeps in memory after a
  // tap on *Resolve conflicts*. The sweep must speak to it rather than open a second
  // window, which is bc-utyr: two sessions merging the same base in one worktree.
  resolvers.remember('demo', 11, { branch: 'worktree-thing-work', dir: repo, term: 'w1:t1:s1' });
  const said = [];
  const out = await sweep({ say: async (term, text) => (said.push({ term, text }), 'ok') });
  check('a pull request that already has a session gets no second window', !launches.some((l) => l.row.number === 11), JSON.stringify(launches.map((l) => l.row.number)));
  check('it is told instead', said.length === 1 && said[0].term === 'w1:t1:s1', JSON.stringify(said));
  check('and the sweep reports it as reused rather than opened', numbers(out.reused).includes(11), JSON.stringify(out.reused));
}

/* ------------------------------------------------------ GitHub that will not answer */

{
  reset();
  // `UNKNOWN` is the absence of GitHub having said anything, and it is not a conflict.
  // Staged by asking about a pull request whose answer never changes.
  const out = await sweep({
    mergeability: async (dir, number) => ({ pr: { number, state: 'OPEN', mergeable: 'UNKNOWN' }, waited: 400, unresolved: true }),
  });
  check('a pull request GitHub would not answer about is not called a conflict', out.conflicting.length === 0, JSON.stringify(out.conflicting));
  check('it is reported as unresolved', out.unresolved.length > 0, JSON.stringify(out.unresolved));
  check('and no window is opened on a guess', launches.length === 0, JSON.stringify(launches.map((l) => l.row.number)));
}

/* ---------------------------------------------------------------- the two refusals */

{
  reset();
  const out = await sweep({ cfg: { ...cfg, openSessions: false } });
  check('a daemon with windows off sweeps nothing', /openSessions/.test(out.refused || ''), String(out.refused));
  check('and asks GitHub nothing at all before refusing', ghCalls().length === 0, JSON.stringify(ghCalls()));
  check('so nothing is launched', launches.length === 0, JSON.stringify(launches));
}

{
  // The observer half, in a child, because `OBSERVING` is decided at module load.
  let observed = true;
  let why = '';
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'observing'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, BEADCAUSE_OBSERVE: '1' },
    });
  } catch (err) {
    observed = false;
    why = String(err.stderr || err.message).trim();
  }
  check('an observer daemon refuses the sweep and reads nothing', observed, why);
}

/* -------------------------------------------------------------- gh that is not there */

{
  reset();
  // A sweep is called by a merge that has already succeeded. Turning that merge into an
  // error because `gh` blinked would be the sweep doing more damage than the conflicts.
  let out;
  let threw = null;
  try {
    out = await sweep({
      list: async () => {
        throw new Error('gh: could not connect to github.com\nand a second line nobody needs');
      },
    });
  } catch (err) {
    threw = err;
  }
  check('a sweep that cannot reach GitHub does not throw at its caller', !threw, String(threw));
  check('it reports the failure instead', /could not connect/.test(out?.error || ''), JSON.stringify(out?.error));
  check('on one line', !String(out?.error).includes('\n'), JSON.stringify(out?.error));
}

/* ------------------------------------------------------------------------ ending */

await cleanupTmp(tmp);
console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
