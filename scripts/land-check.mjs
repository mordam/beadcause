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
function deliver(name, { checks = 'green', refuseMerge = null, extra = [], worktree = false } = {}) {
  const created = bd(['create', '--title', name, '--description', 'Work for a land-check run.', '--type', 'task', '--json']);
  const bead = JSON.parse(created.slice(created.indexOf('{'), created.lastIndexOf('}') + 1));
  const id = bead.id || bead.issue?.id;

  const branch = `bead/${id}-work`;
  let at = REPO;
  if (worktree) {
    at = path.join(tmp, `worktree-${id}`);
    git(['worktree', 'add', '--quiet', '-b', branch, at, 'main']);
  } else {
    git(['checkout', '-q', 'main']);
    git(['checkout', '-qb', branch]);
  }
  fs.writeFileSync(path.join(at, `${id}.txt`), `work for ${id}\n`);
  git(['add', '-A'], at);
  git(['commit', '-qm', `${id}: the work`], at);

  fs.writeFileSync(GH_LOG, '');
  world({ checks, refuseMerge });

  // spawnSync rather than the execFileSync above, for one reason: this is the only
  // call whose *stderr* is an assertion. execFileSync inherits the child's stderr
  // unless it throws, so a deliver run that exits 0 with a refusal on stderr — which
  // is exactly scenario 2 — would print the sentence to the terminal and hand the
  // harness an empty string to test.
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

/* ------------------------------------------------------- 1. it lands its own work */

console.log('\ngreen checks: it merges its own pull request');

const landed = deliver('lands cleanly');
check('deliver.js exits 0', landed.code === 0, `exit ${landed.code} — ${landed.stderr}`);
check('and says what it did, with the number and the merge commit', /^landed #7 https:\/\/\S+ la11ded1/.test(landed.stdout), landed.stdout);
check('it pushed the branch to origin for real', run('git', ['branch', '--list', landed.branch], { cwd: ORIGIN }).includes(landed.branch));
check('it opened a pull request', landed.log.some((c) => c[0] === 'pr' && c[1] === 'create'));
check('and merged it', landed.merges.length === 1, JSON.stringify(landed.log.map((c) => c.slice(0, 2))));
// `--squash` because that is what this harness's config asks for, not because it is the
// default — scenario 6 below is the one that pins the default and the override.
check('with the configured method', landed.merges[0]?.includes('--squash'), JSON.stringify(landed.merges[0]));
check(
  'and never --delete-branch, which gh cannot do from the worktree that branch is checked out in',
  !landed.merges[0]?.includes('--delete-branch'),
  JSON.stringify(landed.merges[0])
);
check('the work bead is closed', landed.issue.status === 'closed', landed.issue.status);
check('with a reason naming what it landed as', /^Landed as #7 as la11ded1/.test(landed.issue.close_reason || ''), landed.issue.close_reason);
check('and a comment on the bead recording the merge', (landed.issue.comment_count ?? 0) >= 1, String(landed.issue.comment_count));
check('no delivery question was filed — there is nothing to ask', bdJson(['list', '--label', 'pr-delivery', '--json']).length === 0);

/* ------------------------------------------------------- 2. GitHub refuses the merge */

console.log('\nGitHub refuses: the old question, with its sentence on it');

const refused = deliver('cannot merge', { refuseMerge: 'Pull request is not mergeable: the base branch policy prohibits the merge.' });
check('deliver.js still exits 0 — handing it over is a good ending', refused.code === 0, `exit ${refused.code} — ${refused.stderr}`);
check('it prints a question id and the PR url instead of `landed`', /^lc-\S+ https:\/\/\S+\/pull\/7$/.test(refused.stdout), refused.stdout);
check('it did try to merge', refused.merges.length === 1);
check('the work bead is still open — nothing merged, so nothing is finished', refused.issue.status !== 'closed', refused.issue.status);
const question = bdJson(['list', '--label', 'pr-delivery', '--json']).find((q) => q.id === refused.stdout.split(' ')[0]);
check('a delivery question exists, labelled for the inbox', !!question && (question.labels || []).includes('human'), JSON.stringify(question?.labels));
check(
  "and carries GitHub's own refusal, so the card says why rather than that it failed",
  /base branch policy prohibits/.test(question?.description || ''),
  (question?.description || '').split('\n')[0]
);
check('the work bead is parked behind it', (refused.issue.dependency_count ?? 0) >= 1, String(refused.issue.dependency_count));
check('and the refusal is on the pull request too, where the diff is', refused.log.some((c) => c[0] === 'pr' && c[1] === 'comment'));
check('the stderr says it plainly, for whoever reads the session log', /not merged —/.test(refused.stderr), refused.stderr);

/* ------------------------------------------------------------ 3. a red check stops it */

console.log('\na red check: it does not merge, and it does not decide');

const red = deliver('red build', { checks: 'red' });
check('deliver.js exits 0', red.code === 0, `exit ${red.code} — ${red.stderr}`);
check('it filed the question', /^lc-\S+ /.test(red.stdout), red.stdout);
check('and never asked gh to merge at all', red.merges.length === 0, JSON.stringify(red.log.map((c) => c.slice(0, 2))));
check('the bead is open', red.issue.status !== 'closed');
const redQ = bdJson(['list', '--label', 'pr-delivery', '--json']).find((q) => q.id === red.stdout.split(' ')[0]);
check('the card names the check that stopped it', /1 check failing \(build\)/.test(redQ?.description || ''), (redQ?.description || '').split('\n')[0]);
check(
  'and says the flake call is Adam’s, because that is the one judgement a worker should not make',
  /that is your call to make/.test(redQ?.description || '')
);

/* ---------------------------------------------------------------- 4. --review asks */

console.log('\n--review: it could have merged, and chose not to');

const asked = deliver('wants review', { extra: ['--review'] });
check('deliver.js exits 0', asked.code === 0, `exit ${asked.code} — ${asked.stderr}`);
check('it filed the question', /^lc-\S+ /.test(asked.stdout), asked.stdout);
check('and asked gh to merge nothing', asked.merges.length === 0, JSON.stringify(asked.log.map((c) => c.slice(0, 2))));
check(
  'and never waited for the checks either — there was nothing to wait for',
  asked.numberViews === 1 && landed.numberViews > 1,
  `--review read the PR ${asked.numberViews}×, the landing one ${landed.numberViews}×`
);
const askedQ = bdJson(['list', '--label', 'pr-delivery', '--json']).find((q) => q.id === asked.stdout.split(' ')[0]);
check('the card says the worker chose this, so green checks do not read as a bug', /deliberately did not/.test(askedQ?.description || ''), (askedQ?.description || '').split('\n')[0]);
check('and nothing on it claims a refusal', !/could not/.test(askedQ?.description || ''));
check('the bead is open', asked.issue.status !== 'closed');

/* --------------------------------------------------------------- 5. and the owed note */

console.log('\n--owed: what is still outstanding after the merge');

const owed = deliver('owes a deploy', { extra: ['--owed', 'deploy, rebuild'] });
check('it landed', /^landed #7/.test(owed.stdout), owed.stdout);
check('and the close reason carries what is still owed', /still owed: deploy, rebuild/.test(owed.issue.close_reason || ''), owed.issue.close_reason);

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

const dflt = deliver('takes the default method');
check('with nothing in the config it still lands', /^landed #7/.test(dflt.stdout), dflt.stdout);
check(
  'and merges with a merge commit, which keeps the branch an ancestor of main',
  dflt.merges[0]?.includes('--merge'),
  JSON.stringify(dflt.merges[0])
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
check('it landed', /^landed #7/.test(migrated.stdout), migrated.stdout);
check('with a merge commit, not the squash the config still said', migrated.merges[0]?.includes('--merge'), JSON.stringify(migrated.merges[0]));
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
check('--method on the command line wins over the config', forced.merges[0]?.includes('--rebase'), JSON.stringify(forced.merges[0]));

/* ------------------------------------- 7. and this Mac's own main follows the merge */

console.log('\nthe main checkout: it ends up at what GitHub now has');

// The merge is at GitHub, so `origin/main` has the commit the instant it lands and this
// laptop's `main` does not — until something fetches. Nothing reliably did: the next
// deploy, a merge from the board, or a person. In between, every `git worktree add`
// here branched from before the delivery, and the session in that worktree paid for it
// with a downmerge of work it had never heard of.
// On `main` and clean, which is what the main checkout looks like on this Mac while
// sessions work in worktrees beside it. The scenarios above leave it on the last branch
// they made, and that would take the other path through `landLocally` — the one for a
// checkout that is *not* on the base — which is not the case worth pinning here.
git(['checkout', '-q', 'main']);
const beforeFF = git(['rev-parse', 'main']);
const followed = deliver('the laptop follows', { worktree: true });
check('it landed', /^landed #7/.test(followed.stdout), followed.stdout);
check(
  "the main checkout's main is now exactly origin/main",
  git(['rev-parse', 'main']) === run('git', ['--git-dir', ORIGIN, 'rev-parse', 'main']).trim(),
  `${git(['rev-parse', 'main'])} vs ${run('git', ['--git-dir', ORIGIN, 'rev-parse', 'main']).trim()}`
);
check('  — which is a move, not the place it already was', git(['rev-parse', 'main']) !== beforeFF);
check('  — and it is still on main, not on the worker’s branch', git(['rev-parse', '--abbrev-ref', 'HEAD']) === 'main');
check('  — the session log says what it did to the checkout', /fast-forwarded main/.test(followed.stderr), followed.stderr);
// Whitespace-flattened, because `bd comments` wraps to the terminal and a sentence
// that happens to break across two lines is not a sentence that is missing.
const flat = (s) => String(s).replace(/\s+/g, ' ');
check(
  '  — and so does the bead, which outlives the window',
  /This Mac's checkout: fast-forwarded main/.test(flat(bd(['comments', followed.id]))),
  flat(bd(['comments', followed.id])).slice(-160)
);

// And the refusal, end to end. The unit test in test/prboard.mjs pins `landLocally`'s
// behaviour; this pins that a *delivery* inherits it, because a worker fast-forwarding
// over Adam's open files at three in the morning is the one way this change could do
// real damage.
fs.writeFileSync(path.join(REPO, 'README.md'), '# land check\n\nadam is mid-edit\n');
const dirtyMain = git(['rev-parse', 'main']);
const heldOff = deliver('the laptop is busy', { worktree: true });
check('a delivery still lands over a dirty main checkout', /^landed #7/.test(heldOff.stdout), heldOff.stdout);
check('  — but main is left exactly where it was', git(['rev-parse', 'main']) === dirtyMain);
check(
  '  — with the uncommitted edit untouched',
  fs.readFileSync(path.join(REPO, 'README.md'), 'utf8') === '# land check\n\nadam is mid-edit\n'
);
check(
  '  — and the reason on the bead, where someone will see it',
  /uncommitted work/.test(flat(bd(['comments', heldOff.id]))),
  flat(bd(['comments', heldOff.id])).slice(-160)
);
git(['checkout', '--quiet', '--', 'README.md']);

/* ------------------------------------------------------------------ verdict */

console.log('');
if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`kept ${tmp}\n`);
if (failures) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall checks passed\x1b[0m');
