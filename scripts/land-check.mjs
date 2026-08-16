#!/usr/bin/env node
//
// Does a worker actually land its own work — and hand it over when it cannot?
//
//   node scripts/land-check.mjs [--keep]
//
// bin/deliver.js is the one place in beadcause where an agent merges code, so it is
// the one place worth running end to end rather than asserting about. Everything it
// touches is real here except GitHub: a real `git` against a real bare remote, a real
// `bd` against a scratch workspace, the real deliver.js, and a fake `gh` on PATH that
// records every invocation. Four scenarios, which are the four endings that exist:
//
//   1. green checks          → it merges, closes the bead, and says `landed #n`
//   2. GitHub refuses        → the old question, with GitHub's sentence on it
//   3. a red check           → the old question, naming the check, and NO merge attempt
//   4. --review              → the old question, no merge attempt, nothing red at all
//
// The assertions that matter most are the negative ones. `gh pr merge` must not appear
// in the log for 3 and 4, and the work bead must still be open in 2, 3 and 4 — a bug
// that closes a bead over work sitting in an unmerged pull request is invisible from
// every screen in the app, and it is the exact failure this whole channel was built to
// stop.
//
// The last scenario is about the *laptop* rather than the endings: a merge happens at
// GitHub, so this Mac's own `main` is a commit behind the moment one lands, and a
// delivery brings it up. It is the only scenario that runs from a real `git worktree`,
// because that is where a worker delivers from and the whole behaviour turns on it —
// and it asserts both halves, the fast-forward and the refusal to touch a main checkout
// with uncommitted work in it. The fake `gh` fast-forwards the bare origin's `main` to
// the branch on merge, which is the one thing about GitHub that has to be real for any
// of it to mean anything.
//
// Nothing here reaches the network, opens a window, or writes outside its temp
// directory: BEADCAUSE_CONFIG_DIR points at a scratch config whose ntfy is off, so no
// notification is sent to anyone's phone, and `--keep` leaves the lot for inspection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-land-check-'));
const BIN = path.join(tmp, 'bin');
const REPO = path.join(tmp, 'repo');
const ORIGIN = path.join(tmp, 'origin.git');
const WS = path.join(tmp, 'beads');
const BEADS_DIR = path.join(WS, '.beads');
const CONFIG_DIR = path.join(tmp, 'config');
const GH_LOG = path.join(tmp, 'gh.log');
const GH_STATE = path.join(tmp, 'gh-state.json');

const BD = process.env.BD_BIN || '/opt/homebrew/bin/bd';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
const git = (args, cwd = REPO) => run('git', args, { cwd }).trim();

/* ------------------------------------------------------------------ the world */

console.log(`\nbuilding a world in ${tmp}`);

fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });

// A fake gh: it answers the six calls deliver.js can make, and logs all of them. Its
// world is a JSON file the harness rewrites between scenarios, exactly as test/pr.mjs
// does — the merge outcome and the check state are the only things that vary.
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
const done = (s) => { process.stdout.write(s); process.exit(0); };
const fail = (s) => { process.stderr.write(s + '\\n'); process.exit(1); };
const [a, b, ...rest] = args;

if (a === 'auth') done('');
if (a === 'repo' && b === 'view') done(JSON.stringify({ nameWithOwner: 'mordam/landcheck' }));
if (a === 'pr' && b === 'view') {
  // A branch name finds nothing until the PR exists; a number always finds it.
  if (!/^\\d+$/.test(String(rest[0])) && !state.opened) fail('no pull requests found for branch "' + rest[0] + '"');
  done(JSON.stringify(state.pr));
}
if (a === 'pr' && b === 'create') {
  state.opened = true;
  // The head ref, so the merge below can do to the bare origin what GitHub's merge
  // does to it: put the branch's commits on main. Without that, origin/main never
  // moves in this harness and the fast-forward under test has nothing to fast-forward.
  const h = args.indexOf('--head');
  if (h > -1) state.head = args[h + 1];
  fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  done(state.pr.url + '\\n');
}
if (a === 'pr' && b === 'merge') {
  if (state.refuseMerge) fail(state.refuseMerge);
  // A fast-forward of the bare repo's main to the branch tip. Not a merge commit —
  // this fake has no worktree to merge in — but the only property anything downstream
  // cares about is that origin/main now contains the work, which it does.
  if (state.head && process.env.ORIGIN_DIR) {
    try {
      require('child_process').execFileSync('git', ['--git-dir', process.env.ORIGIN_DIR, 'update-ref', 'refs/heads/main', 'refs/heads/' + state.head]);
    } catch (e) { fail('the fake gh could not move origin/main: ' + e.message); }
  }
  state.pr.state = 'MERGED';
  state.pr.mergedAt = '2026-08-10T12:00:00Z';
  state.pr.mergeCommit = { oid: 'la11ded11111' };
  fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  done('Merged pull request #' + state.pr.number + '\\n');
}
if (a === 'pr' && b === 'comment') done('https://github.com/mordam/landcheck/pull/7#issuecomment-1\\n');
fail('unexpected gh invocation: ' + args.join(' '));
`,
  { mode: 0o755 }
);

const CHECKS = {
  green: [{ name: 'build', conclusion: 'SUCCESS' }],
  red: [{ name: 'build', conclusion: 'FAILURE' }],
  none: [],
};

/** Replace the fake's world. `checks` and `refuseMerge` are the whole of the variation. */
const world = ({ checks = 'green', refuseMerge = null } = {}) =>
  fs.writeFileSync(
    GH_STATE,
    JSON.stringify({
      opened: false,
      refuseMerge,
      pr: {
        number: 7,
        url: 'https://github.com/mordam/landcheck/pull/7',
        title: 'the work',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        headRefName: '',
        baseRefName: 'main',
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        statusCheckRollup: CHECKS[checks],
        reviewDecision: null,
        mergedAt: null,
        mergeCommit: null,
      },
    })
  );

// A repo with a real remote, so the push in deliver.js is a real push.
run('git', ['init', '--bare', '-b', 'main', ORIGIN]);
run('git', ['init', '-b', 'main', REPO]);
git(['config', 'user.email', 'landcheck@example.com']);
git(['config', 'user.name', 'Land Check']);
git(['remote', 'add', 'origin', ORIGIN]);
fs.writeFileSync(path.join(REPO, 'README.md'), '# land check\n');
git(['add', '-A']);
git(['commit', '-qm', 'first']);
git(['push', '-q', '-u', 'origin', 'main']);

// A scratch beads workspace. `bd init` from the workspace directory with --skip-agents,
// which is the one incantation that does not scatter AGENTS.md/CLAUDE.md into a repo.
try {
  run(BD, ['init', '--prefix', 'lc', '--role', 'maintainer', '--skip-agents', '--non-interactive'], {
    cwd: WS,
    env: { ...process.env, BEADS_DIR },
  });
} catch (err) {
  console.error(`\ncannot build a scratch beads workspace with ${BD} — ${String(err.message).split('\n')[0]}`);
  console.error('set BD_BIN if bd lives somewhere else.\n');
  process.exit(2);
}

fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify(
    {
      port: 4319,
      baseUrl: 'http://127.0.0.1:4319',
      bdBin: BD,
      actor: 'landcheck',
      owner: 'Adam',
      workspaces: [{ name: 'landcheck', dir: BEADS_DIR }],
      // Off, and this is the line that keeps a harness run out of a real pocket.
      ntfy: { enabled: false, topic: '', server: 'https://ntfy.sh' },
      pr: { enabled: true, base: 'main', mergeMethod: 'squash', autoMerge: true, mergeWaitMs: 2000 },
    },
    null,
    2
  )
);

// `squash` above is a deliberate choice, so it needs the receipt that says the one-time
// move of an *inherited* squash has already had its turn — otherwise the first
// `loadConfig` in scenario 1 would move this harness's config out from under it. Which
// is the whole semantics of that migration, and scenario 6 takes the flag away again to
// watch it fire.
fs.writeFileSync(path.join(CONFIG_DIR, 'state.json'), JSON.stringify({ squashDefaultMoved: true }, null, 2));

const env = {
  ...process.env,
  PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
  BEADCAUSE_CONFIG_DIR: CONFIG_DIR,
  GH_LOG,
  GH_STATE,
  ORIGIN_DIR: ORIGIN,
  BEADS_DIR,
};

const bd = (args) => run(BD, args, { cwd: WS, env });
const bdJson = (args) => {
  const out = bd(args);
  return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
};

/**
 * One scenario: a fresh bead, a fresh branch, a fresh gh world, one deliver run.
 *
 * `worktree` puts the delivery where a real one happens — `.claude/worktrees/<name>`
 * is a separate checkout with its own branch, and the main checkout stays on `main`
 * throughout. Everything about the local fast-forward depends on that difference, so
 * it cannot be asserted from a scenario that runs in the main checkout itself.
 */
function deliver(
  name,
  { checks = 'green', refuseMerge = null, extra = [], worktree = false, conflicted = false, type = 'task', body = 'Work for a land-check run.', existing = null } = {}
) {
  /**
   * `existing` re-delivers a bead that has already been through here once — the same
   * bead, the same branch, one more commit on it.
   *
   * A real re-delivery is the ordinary case after "request changes" and it is what
   * bc-ec6 was about: two deliveries of one bead with nobody at the phone in between.
   * Since bc-r941 the pile it would leave is a pile of *blockers* on the work bead, so
   * the scenario matters more than it did and needs a way to be set up at all.
   */
  const id = existing ? existing.id : (() => {
    const created = bd(['create', '--title', name, '--description', body, '--type', type, '--json']);
    const bead = JSON.parse(created.slice(created.indexOf('{'), created.lastIndexOf('}') + 1));
    return bead.id || bead.issue?.id;
  })();

  const branch = existing ? existing.branch : `bead/${id}-work`;
  let at = existing ? existing.at : REPO;
  if (existing) {
    // The bead was closed to `in_progress` by nothing here; what it needs is another
    // commit on the same branch, in the checkout it was delivered from.
    fs.writeFileSync(path.join(at, `${id}-again.txt`), `more work for ${id}\n`);
    git(['add', '-A'], at);
    git(['commit', '-qm', `${id}: more`, '--no-verify'], at);
    fs.writeFileSync(GH_LOG, '');
    world({ checks, refuseMerge });
    return finishDeliver(id, branch, at, extra);
  }
  if (worktree) {
    at = path.join(tmp, `worktree-${id}`);
    git(['worktree', 'add', '--quiet', '-b', branch, at, 'main']);
  } else {
    git(['checkout', '-q', 'main']);
    git(['checkout', '-qb', branch]);
  }
  fs.writeFileSync(path.join(at, `${id}.txt`), `work for ${id}\n`);
  // A commit that carries an unresolved merge, made exactly the way one really gets
  // made: `git add -A && git commit` with the markers still in the file, which git
  // accepts without a word. `--no-verify` because the harness repo may have the
  // pre-commit hook installed, and the point of this scenario is what happens to a
  // commit that got past it — a hook is skippable and deliver.js is not.
  if (conflicted) {
    fs.writeFileSync(
      path.join(at, `${id}.js`),
      `<<<<<<< HEAD\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> origin/main\n`
    );
  }
  git(['add', '-A'], at);
  git(['commit', '-qm', `${id}: the work`, '--no-verify'], at);

  fs.writeFileSync(GH_LOG, '');
  world({ checks, refuseMerge });
  return finishDeliver(id, branch, at, extra);
}

/** The run half, shared with the re-delivery path above. */
function finishDeliver(id, branch, at, extra) {
  // spawnSync rather than the execFileSync above, for one reason: this is the only
  // call whose *stderr* is an assertion. execFileSync inherits the child's stderr
  // unless it throws, so a deliver run that exits 0 with a refusal on stderr would
  // print the sentence to the terminal and hand the harness an empty string to test.
  const ran = spawnSync(
    'node',
    [path.join(ROOT, 'bin', 'deliver.js'), '-w', 'landcheck', '-b', id, '--tests', 'npm test — fine', ...extra],
    { cwd: at, env, input: 'What changed, and why.\n', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  const stdout = String(ran.stdout || '');
  const stderr = String(ran.stderr || '');
  const code = ran.status ?? 1;
  // The *last* line, not the whole of stdout: `loadConfig` prints a `[beadcause] adding
  // workspace …` notice the first time it discovers one, and that lands above the line
  // this command exists to print. Everything that reads this output — an agent, a log,
  // this harness — wants the answer, which is the last thing said.
  const said = stdout.trim().split('\n').filter(Boolean).pop() || '';

  const log = fs
    .readFileSync(GH_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const issue = bdJson(['show', id, '--json'])[0];
  return {
    id,
    branch,
    // Where it ran — the main checkout, or the worktree that stands in for a session's.
    at,
    stdout: said,
    // Everything it printed, for the one assertion that is about a line *above* the
    // answer: a config migration narrating itself on the way past.
    rawStdout: stdout,
    stderr: stderr.trim(),
    code,
    log,
    issue,
    merges: log.filter((c) => c[0] === 'pr' && c[1] === 'merge'),
    // `gh pr view <number>`, as opposed to `gh pr view <branch>`. Exactly one of these
    // is `create()` reading back the PR it just opened; anything beyond it is the wait
    // for the checks and the merge preflight. So the count is how you tell a delivery
    // that intended to merge from one that stopped at opening.
    numberViews: log.filter((c) => c[0] === 'pr' && c[1] === 'view' && /^\d+$/.test(String(c[2]))).length,
  };
}

/* ---------------------------------------------------- 1. it queues its own work */

console.log('\ngreen checks: it queues its own pull request and stops');

// bc-r941. This scenario used to be called "it merges its own pull request", and every
// assertion in it was about a merge. The merge moved to the daemon — see
// lib/mergequeue.js — and what is left here is the handover, which is the half that can
// silently not happen: a `bin/deliver.js` that still merged while a queue also merged
// would be two agents racing for one pull request, and both of them would look correct.
//
// So the negative assertions below are the point of the scenario rather than trimmings.
// `gh pr merge` never being called, and the work bead never closing, are what say the
// removal actually happened.
const queued = deliver('lands cleanly');
check('deliver.js exits 0', queued.code === 0, `exit ${queued.code} — ${queued.stderr}`);
check(
  'and says what it did — `queued`, with the pull request and the merge-bead',
  /^queued #7 https:\/\/\S+ lc-\S+$/.test(queued.stdout),
  queued.stdout
);
check('it pushed the branch to origin for real', run('git', ['branch', '--list', queued.branch], { cwd: ORIGIN }).includes(queued.branch));
check('it opened a pull request', queued.log.some((c) => c[0] === 'pr' && c[1] === 'create'));
check('AND NEVER ASKED GH TO MERGE ANYTHING', queued.merges.length === 0, JSON.stringify(queued.log.map((c) => c.slice(0, 2))));
check(
  'and never waited for the checks either — waiting is the queue\'s, on its own clock',
  queued.numberViews <= 1,
  `it read the pull request by number ${queued.numberViews}×`
);
check('THE WORK BEAD IS STILL OPEN — nothing has merged, so nothing is finished', queued.issue.status !== 'closed', queued.issue.status);

const mergeBead = bdJson(['list', '--label', 'merge-queue', '--json']).find((b) => b.id === queued.stdout.split(' ').pop());
check('a merge-bead was filed, carrying that label', !!mergeBead, JSON.stringify(bdJson(['list', '--label', 'merge-queue', '--json']).map((b) => b.id)));
check('assigned to the merge advocate, or nothing will ever pick it up', mergeBead?.assignee === 'merge-advocate', mergeBead?.assignee);
check('and NOT in the inbox — a queue entry is work for an agent, not a question', !(mergeBead?.labels || []).includes('human'), JSON.stringify(mergeBead?.labels));
check(
  'it carries the beadpr block the queue reads, naming the pull request and the work bead',
  /```beadpr/.test(mergeBead?.description || '') &&
    new RegExp(`bead: ${queued.id}`).test(mergeBead?.description || '') &&
    /number: 7/.test(mergeBead?.description || ''),
  (mergeBead?.description || '').split('\n').slice(-12).join(' | ')
);
// `squash` because that is what this harness's config asks for. Scenario 6 below is what
// pins the default and the override — and since bc-r941 the method is carried on the
// bead rather than passed to `gh`, because the thing that will pass it to `gh` runs
// later, in another process.
check('and the merge method the config asked for, so the queue merges the way this repo does', /method: squash/.test(mergeBead?.description || ''), (mergeBead?.description || '').match(/method: \S+/)?.[0]);
check(
  'THE WORK BEAD IS PARKED BEHIND IT — which is what stops a worker closing its own work',
  (queued.issue.dependency_count ?? 0) >= 1,
  String(queued.issue.dependency_count)
);
check('and a comment on the bead saying where it went', (queued.issue.comment_count ?? 0) >= 1, String(queued.issue.comment_count));
check('no delivery question was filed — nobody is being asked anything yet', bdJson(['list', '--label', 'pr-delivery', '--json']).length === 0);
check('and it said so on the pull request, where whoever opens the diff is standing', queued.log.some((c) => c[0] === 'pr' && c[1] === 'comment'));

// The sweep that used to be asked for here moved with the merge: a merge leaves every
// other open branch measured against a base it has never seen, and the thing that has
// merged is now the daemon. A delivery that merges nothing has nothing to sweep behind
// it, so the absence is asserted rather than left to be inferred — a stray record here
// would send a resolver window at branches nothing had disturbed.
check(
  'and asked for no conflict sweep, because it landed nothing to sweep behind',
  !fs.existsSync(path.join(CONFIG_DIR, 'merge-sweeps.json')) ||
    Object.keys(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'merge-sweeps.json'), 'utf8'))).length === 0,
  fs.existsSync(path.join(CONFIG_DIR, 'merge-sweeps.json')) ? fs.readFileSync(path.join(CONFIG_DIR, 'merge-sweeps.json'), 'utf8') : '(no file)'
);

/* --------------------------------------------- 1b. a re-delivery does not pile up */

console.log('\na second delivery of the same bead: one merge-bead, not two');

// `clearOpenCards` in bin/deliver.js exists because delivering twice left two identical
// cards in the inbox, each one a blocker on the work bead's close, and answering either
// was reported as having closed a bead that neither could close (bc-ec6). A merge-bead is
// a blocker *by construction*, so the same pile in this shape is strictly worse: the
// queue would merge the first and then find the second unmergeable for ever.
const again = deliver('lands cleanly', { existing: { id: queued.id, branch: queued.branch, at: queued.at } });
const openMerges = bdJson(['list', '--label', 'merge-queue', '--status', 'open', '--json']).filter((b) =>
  new RegExp(`bead: ${queued.id}\\b`).test(b.description || '')
);
check('the re-delivery exits 0', again.code === 0, `exit ${again.code} — ${again.stderr}`);
check('and exactly one merge-bead is open for that work', openMerges.length === 1, JSON.stringify(openMerges.map((b) => b.id)));
check('the newer one', openMerges[0]?.id === again.stdout.split(' ').pop(), `${openMerges[0]?.id} vs ${again.stdout}`);

/* --------------------------------------------------- 2. an epic is queued the same */

console.log('\nan epic: it queues like anything else — the carve-out is the queue\'s');

// bc-arj0.3 said an epic must not close on a branch that shares its name merging, and
// that rule has not moved — it has changed owner. Nothing closes anything here any more,
// so what this scenario can still pin is that an epic is *delivered* like any other bead
// and reaches the queue intact. The carve-out itself is asserted where it now lives, in
// `finish` in lib/mergequeue.js, by test/mergequeue.mjs.
const epic = deliver('an umbrella epic', { type: 'epic', body: 'The theme.\n\nAdopts: lc-nobody.\n' });
check('deliver.js exits 0', epic.code === 0, `exit ${epic.code} — ${epic.stderr}`);
check('and it queues, like everything else', /^queued #7 /.test(epic.stdout), epic.stdout);
check('the epic is still open, because nothing merged', epic.issue.status !== 'closed', epic.issue.status);
check('with no close reason on it', !epic.issue.close_reason, epic.issue.close_reason || '(none)');
const epicOwedFile = path.join(CONFIG_DIR, 'owed-closes.json');
const epicOwed = fs.existsSync(epicOwedFile) ? JSON.parse(fs.readFileSync(epicOwedFile, 'utf8')) : {};
check('and no close is owed for it either', !Object.keys(epicOwed).some((k) => k.endsWith(epic.id)), JSON.stringify(epicOwed));

/* ------------------------------------------ 3. auto-merge off is the other ending */

console.log('\nauto-merge off: the question card, exactly as it always was');

// The one ending that did not change. A space with auto-merge off was never a merge, so
// bc-r941 did nothing to it — and asserting that is worth as much as asserting what did
// change, because the easiest way to break this feature is to route every delivery
// through the queue and quietly lose the setting that says not to.
const cfgFileOff = path.join(CONFIG_DIR, 'config.json');
const savedOff = JSON.parse(fs.readFileSync(cfgFileOff, 'utf8'));
fs.writeFileSync(cfgFileOff, JSON.stringify({ ...savedOff, pr: { ...savedOff.pr, autoMerge: false } }, null, 2));
const handed = deliver('auto-merge is off here');
fs.writeFileSync(cfgFileOff, JSON.stringify(savedOff, null, 2));

check('deliver.js exits 0 — handing it over is a good ending', handed.code === 0, `exit ${handed.code} — ${handed.stderr}`);
check('it prints a question id and the PR url, not `queued`', /^lc-\S+ https:\/\/\S+\/pull\/7$/.test(handed.stdout), handed.stdout);
check('and asked gh to merge nothing', handed.merges.length === 0, JSON.stringify(handed.log.map((c) => c.slice(0, 2))));
const handedQ = bdJson(['list', '--label', 'pr-delivery', '--json']).find((q) => q.id === handed.stdout.split(' ')[0]);
check('a delivery question exists, labelled for the inbox', !!handedQ && (handedQ.labels || []).includes('human'), JSON.stringify(handedQ?.labels));
check('and no merge-bead was filed beside it', !bdJson(['list', '--label', 'merge-queue', '--status', 'open', '--json']).some((b) => new RegExp(`bead: ${handed.id}\\b`).test(b.description || '')));
check('the work bead is parked behind the card', (handed.issue.dependency_count ?? 0) >= 1, String(handed.issue.dependency_count));
check('and the work bead is open — nothing merged, so nothing is finished', handed.issue.status !== 'closed', handed.issue.status);

/* ---------------------------------------------------------------- 4. --review asks */

console.log('\n--review: it could have merged, and chose not to');

const asked = deliver('wants review', { extra: ['--review'] });
check('deliver.js exits 0', asked.code === 0, `exit ${asked.code} — ${asked.stderr}`);
check('it filed the question', /^lc-\S+ /.test(asked.stdout), asked.stdout);
check('and asked gh to merge nothing', asked.merges.length === 0, JSON.stringify(asked.log.map((c) => c.slice(0, 2))));
check(
  'and never waited for the checks either — there was nothing to wait for',
  asked.numberViews <= 1,
  `--review read the PR ${asked.numberViews}×`
);
const askedQ = bdJson(['list', '--label', 'pr-delivery', '--json']).find((q) => q.id === asked.stdout.split(' ')[0]);
check('the card says the worker chose this, so green checks do not read as a bug', /deliberately did not/.test(askedQ?.description || ''), (askedQ?.description || '').split('\n')[0]);
check('and nothing on it claims a refusal', !/could not/.test(askedQ?.description || ''));
check('the bead is open', asked.issue.status !== 'closed');

/* --------------------------------------------------------------- 5. and the owed note */

console.log('\n--owed: what is still outstanding after the merge');

const owed = deliver('owes a deploy', { extra: ['--owed', 'deploy, rebuild'] });
check('it queued', /^queued #7/.test(owed.stdout), owed.stdout);
// It used to end up in the close reason, because the delivery closed the bead. Nothing
// here closes anything now, so the note goes where it will still be read when the queue
// gets to it: the comment the delivery leaves on the work bead.
check(
  'and the note on the bead carries what is still owed after the merge',
  /Still owed after the merge: deploy, rebuild/.test(bd(['comments', owed.id])),
  String(bd(['comments', owed.id])).replace(/\s+/g, ' ').slice(-160)
);

/* ------------------------------------------------- 6. where the merge method comes from */

console.log('\nthe merge method: the config decides it, and its default is a merge commit');

// The assertion in scenario 1 — `--squash`, from a config that asks for it — is only
// meaningful because of the two below it. `pr.mergeMethod` used to reach lib/session.js,
// where it shapes the brief's sentence about this command, and reach nothing that merges:
// deliver.js held its own literal `squash`, so the setting changed the promise and never
// the act, and the two agreed only by coincidence.
//
// The default has to show through as a merge commit, and that is not a matter of taste.
// A squash merge writes a new commit with the branch's tree and none of its history, so
// the branch is never an ancestor of main — and the attic sweep re-checks exactly that
// before removing an aged worktree, keeping forever anything that fails it. A squash
// default meant every delivered worktree became a permanent attic resident.
const cfgFile = path.join(CONFIG_DIR, 'config.json');
const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const { mergeMethod: _asked, ...prNoMethod } = saved.pr;
fs.writeFileSync(cfgFile, JSON.stringify({ ...saved, pr: prNoMethod }, null, 2));

// Since bc-r941 the method is not passed to `gh` here — the process that will pass it to
// `gh` runs later, in the daemon — so what this asserts is the value written onto the
// merge-bead. That is the same setting travelling the same distance; it is read one hop
// further along, which is exactly the hop that used to be missing when `pr.mergeMethod`
// reached the brief and never the act.
const methodOf = (out) => {
  const id = out.stdout.split(' ').pop();
  const row = bdJson(['show', id, '--json'])[0];
  return (String(row?.description || '').match(/method: (\S+)/) || [])[1] || '';
};

const dflt = deliver('takes the default method');
check('with nothing in the config it still queues', /^queued #7/.test(dflt.stdout), dflt.stdout);
check(
  'and asks for a merge commit, which keeps the branch an ancestor of main',
  methodOf(dflt) === 'merge',
  methodOf(dflt)
);

// And the stored value that has to move for any of the above to matter on a machine
// that already has a config. Scenario 1 ran with `squash` *and* the receipt saying the
// move is spent, which is a deliberate choice being honoured. Take the receipt away and
// the same config is an inherited default: the next `loadConfig` moves it, once, writes
// the config back, and the merge that follows is a merge commit.
const stateFile = path.join(CONFIG_DIR, 'state.json');
fs.writeFileSync(cfgFile, JSON.stringify(saved, null, 2));
fs.writeFileSync(stateFile, JSON.stringify({}, null, 2));

const migrated = deliver('an inherited squash moves');
check('it queued', /^queued #7/.test(migrated.stdout), migrated.stdout);
check('with a merge commit, not the squash the config still said', methodOf(migrated) === 'merge', methodOf(migrated));
check(
  'the config on disk was rewritten, so the daemon and every CLI agree from now on',
  JSON.parse(fs.readFileSync(cfgFile, 'utf8')).pr.mergeMethod === 'merge',
  JSON.parse(fs.readFileSync(cfgFile, 'utf8')).pr.mergeMethod
);
check('and the move is recorded, so it happens once and not on every run', JSON.parse(fs.readFileSync(stateFile, 'utf8')).squashDefaultMoved === true);
check(
  'and only that value moved — the file was edited, not replaced with a dump of every default',
  Object.keys(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))).length === Object.keys(saved).length &&
    Object.keys(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).pr).length === Object.keys(saved.pr).length,
  Object.keys(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))).join(', ')
);
check('and it said so on stdout rather than moving a setting silently', /pr\.mergeMethod/.test(migrated.stderr + migrated.rawStdout), migrated.rawStdout.split('\n')[0]);

// `--method` is the per-delivery override, and it has to beat both of the above.
// `rebase` because it is neither the config's answer nor the built-in one, so a passing
// check cannot be either of them leaking through.
const forced = deliver('overrides the method', { extra: ['--method', 'rebase'] });
check('--method on the command line wins over the config', methodOf(forced) === 'rebase', methodOf(forced));

/* --------------------- 7. this Mac's own main — moved with the merge, see below */

// This scenario was the local fast-forward: the merge is at GitHub, so this laptop's
// `main` is a commit behind until something fetches, and until then every new worktree
// branches from before the delivery. It asserted three things end to end — that a
// delivery fast-forwards the main checkout, that it refuses to over a checkout with
// uncommitted work in it, and that it steps past untracked residue (bc-45g8).
//
// **It is not gone, it has changed owner.** `landParent` is unchanged and is still what
// does all three; what moved is who calls it, because a delivery no longer merges and a
// merge is the only thing that puts `main` behind. The call is now in the queue's
// `afterMerge` (lib/server.js), and that it is made is asserted in test/mergequeue.mjs.
// `landLocally`'s own behaviour — the refusal and the residue exception — is pinned by
// test/prboard.mjs, as its comment here always said.
//
// Deleting the scenario rather than re-pointing it is deliberate: driving it from here
// would mean this harness running a merge queue, and a harness that has to build the
// daemon to test a CLI is a harness nobody will keep true.

/* ------------------------------- 8. and it will not push an unresolved merge at all */

console.log('\na commit carrying conflict markers: nothing reaches origin, and nothing is asked');

// bc-d2y6, end to end. A resolver session committed a re-conflicted `public/console.js`
// and every screen showed a normal merge commit; the only symptom was `npm test` failing
// 38 suites in with `Unexpected token '<<'`. This is the scenario that says such a
// branch never gets past this command — and every assertion here is a negative one,
// because "it refused" is worth nothing unless nothing else happened either. A refusal
// that has already pushed the branch has published the broken file; one that has already
// filed a question has put an unmergeable pull request on Adam's phone.
const stillConflicted = deliver('carries an unresolved merge', { conflicted: true });
check('deliver.js refuses, loudly', stillConflicted.code === 6, `exit ${stillConflicted.code} — ${stillConflicted.stderr}`);
check('and names the file', new RegExp(`${stillConflicted.id}\\.js`).test(stillConflicted.stderr), stillConflicted.stderr.slice(0, 200));
check('and the marker it found', /<<<<<<< HEAD/.test(stillConflicted.stderr), stillConflicted.stderr.slice(0, 200));
check(
  'nothing was pushed — origin never heard of the branch',
  !run('git', ['branch', '--list', stillConflicted.branch], { cwd: ORIGIN }).includes(stillConflicted.branch)
);
check('no pull request was opened', !stillConflicted.log.some((c) => c[0] === 'pr' && c[1] === 'create'), JSON.stringify(stillConflicted.log.map((c) => c.slice(0, 2))));
check('and gh was never called at all', stillConflicted.log.length === 0, JSON.stringify(stillConflicted.log.map((c) => c.slice(0, 2))));
check('the bead is still open', stillConflicted.issue.status !== 'closed', stillConflicted.issue.status);
check('and no question was filed — this is the session’s to fix, not Adam’s', bdJson(['list', '--label', 'pr-delivery', '--status', 'open', '--json']).length === 0);
check('it says how to catch it a commit earlier', /--install-hook/.test(stillConflicted.stderr), stillConflicted.stderr.slice(-200));

// And the same branch with the merge actually resolved goes straight through, so the
// check above is about the markers rather than about anything else the scenario did.
const resolved = deliver('resolves it before delivering');
check('a resolved branch still queues normally', /^queued #7/.test(resolved.stdout), resolved.stdout || resolved.stderr);

/* ------------------------------------------------------------------ verdict */

console.log('');
if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`kept ${tmp}\n`);
if (failures) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall checks passed\x1b[0m');
