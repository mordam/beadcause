#!/usr/bin/env node
/**
 * **Per-space PR policy** — who merges their own work, and who has to be approved first.
 *
 *     npm test
 *     node test/approval.mjs
 *
 * Whether a worker merges its own pull request used to be one global switch,
 * `pr.autoMerge`, and it was the same answer for every repo in every space. That is
 * wrong at both edges: a personal side project wants its work landed without being
 * asked at three in the morning, and anything with other people on it wants eyes on
 * the diff before it is in `main`. Spaces are already the unit for that kind of
 * policy, so both answers now resolve through `prPolicyFor` in lib/spaces.js.
 *
 * Four things are worth a test, and only the first is arithmetic:
 *
 * 1. **The resolution itself**, in both directions. A space must be able to turn
 *    auto-merge *on* where the global says off as well as off where it says on —
 *    that is the whole difference between this and `autoDispatchAllowed`, whose
 *    global `false` is a safety veto no space may argue with. A setup that can only
 *    subtract cannot express "off everywhere except the side project".
 * 2. **A green, unapproved pull request in a require-approval space must not merge.**
 *    The assertion that matters is negative and it is the point of the feature:
 *    `gh pr merge` must not appear in the call log at all. Checks green, branch
 *    clean, and it stops anyway.
 * 3. **The card has to say *which* of those it is waiting on.** A card that says
 *    "auto-merge is off" over a green PR in a space where auto-merge is emphatically
 *    on sends you hunting for a switch that is already set the way you want it. So
 *    the approval opening is asserted to be its own sentence, and to name the review.
 * 4. **The two readers must agree.** `bin/deliver.js` decides whether to merge and
 *    `lib/session.js` writes the brief promising what that command will do; a brief
 *    promising a merge to a session whose delivery then files a question is how you
 *    get a window reporting work as landed over a bead that says otherwise. Both go
 *    through the one helper, and this pins that they answer the same for one space.
 *
 * Real git against a real bare remote, because the push and the "is there anything
 * ahead" test are real. `gh` and `bd` are fakes on `PATH` and in the config, keyed off
 * JSON world files with a call log each — nothing here reaches the network, a real
 * tracker, or anyone's phone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DELIVER = path.join(HERE, '..', 'bin', 'deliver.js');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-approval-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

/* ------------------------------------------------ the helper, on its own first */

const { prPolicyFor } = await import(path.join(HERE, '..', 'lib', 'spaces.js'));

const SPACES = (over) => ({ spaces: [{ name: 'Work', workspaces: ['demo'], ...over }] });

console.log('\nresolving the two answers per space\n');

check(
  'with no spaces at all it is the global, and the global default is to land its own work',
  prPolicyFor({}, 'demo').autoMerge === true && prPolicyFor({}, 'demo').requireApproval === false
);
check(
  'a workspace in no space still gets the global',
  prPolicyFor({ ...SPACES({}), pr: { autoMerge: false } }, 'unassigned').autoMerge === false
);
check(
  'a space can turn it off where the global says on',
  prPolicyFor(SPACES({ autoMerge: false }), 'demo').autoMerge === false
);
check(
  'and on where the global says off — the direction an exclude list cannot express',
  prPolicyFor({ ...SPACES({ autoMerge: true }), pr: { autoMerge: false } }, 'demo').autoMerge === true
);
check(
  'a space that says nothing inherits, whichever way the global points',
  prPolicyFor({ ...SPACES({}), pr: { autoMerge: false } }, 'demo').autoMerge === false &&
    prPolicyFor({ ...SPACES({}), pr: { autoMerge: true } }, 'demo').autoMerge === true
);
check(
  'requireApproval resolves the same way, from the same two places',
  prPolicyFor({ pr: { requireApproval: true } }, 'demo').requireApproval === true &&
    prPolicyFor(SPACES({ requireApproval: true }), 'demo').requireApproval === true &&
    prPolicyFor({ ...SPACES({ requireApproval: false }), pr: { requireApproval: true } }, 'demo').requireApproval === false
);
check(
  'a non-boolean on the space is not an answer, so it inherits rather than guessing',
  prPolicyFor({ ...SPACES({ autoMerge: 'false' }), pr: { autoMerge: true } }, 'demo').autoMerge === true,
  JSON.stringify(prPolicyFor({ ...SPACES({ autoMerge: 'false' }) }, 'demo'))
);

/* --------------------------------------------------------------- the fake bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const WORLD = ${JSON.stringify(WORLD)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const all = (name) => args.map((a, i) => (a === name ? args[i + 1] : null)).filter(Boolean);
const die = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const hydrate = (issue) => ({
  ...issue,
  dependencies: (issue.dependencies || []).map((d) => ({ ...d, status: (w.issues[d.id] || {}).status || 'closed' })),
});

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([hydrate(issue)]));
  process.exit(0);
}
if (args[0] === 'list') {
  const label = flag('--label');
  const rows = Object.values(w.issues)
    .filter((i) => (label ? (i.labels || []).includes(label) : true))
    .filter((i) => i.status !== 'closed')
    .map(hydrate);
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'create') {
  const id = 'zz-' + (w.seq = (w.seq || 0) + 1);
  w.issues[id] = {
    id,
    title: flag('--title') || '',
    description: flag('--description') || '',
    labels: all('--label'),
    status: 'open',
    issue_type: flag('--type') || 'task',
    dependencies: [],
  };
  save();
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'close') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  const open = (issue.dependencies || [])
    .filter((d) => d.dependency_type === 'blocks')
    .filter((d) => ((w.issues[d.id] || {}).status || 'closed') !== 'closed')
    .map((d) => d.id);
  if (open.length) die('cannot close ' + issue.id + ': blocked by open issues [' + open.join(' ') + ']');
  issue.status = 'closed';
  issue.close_reason = flag('--reason') || '';
  save();
  process.stdout.write('closed\\n');
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (issue.comments = issue.comments || []).push(args[2]);
  save();
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'add') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.dependencies = issue.dependencies || [];
  if (!issue.dependencies.some((d) => d.id === args[3])) issue.dependencies.push({ id: args[3], dependency_type: 'blocks' });
  save();
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'remove') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.dependencies = (issue.dependencies || []).filter((d) => d.id !== args[3]);
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/* --------------------------------------------------------------- the fake gh */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const GH_STATE = path.join(tmp, 'gh.json');
const GH_LOG = path.join(tmp, 'gh-calls.log');

/**
 * One pull request per branch, plus the one knob this suite turns: `review`, which is
 * stamped onto every PR the moment it is viewed. That is deliberately not a property of
 * the PR record — an approval arrives *after* the PR exists, and the whole question here
 * is what the worker does with the answer it reads back at merge time.
 */
fs.writeFileSync(GH_STATE, JSON.stringify({ next: 40, review: null, prs: {} }));
const ghState = () => JSON.parse(fs.readFileSync(GH_STATE, 'utf8'));
const setReview = (review) => {
  const s = ghState();
  s.review = review;
  fs.writeFileSync(GH_STATE, JSON.stringify(s, null, 2));
};

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const STATE = ${JSON.stringify(GH_STATE)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + '\\n');
const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = () => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const out = (t) => { process.stdout.write(t); process.exit(0); };
const fail = (t) => { process.stderr.write(t + '\\n'); process.exit(1); };
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const find = (ref) => Object.values(s.prs).find((p) => p.headRefName === ref || String(p.number) === String(ref));

if (args[0] === 'auth') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/widgets' }));
if (args[0] === 'pr') {
  if (args[1] === 'create') {
    const head = flag('--head');
    const number = s.next++;
    s.prs[head] = {
      number,
      title: flag('--title') || '',
      url: 'https://github.com/acme/widgets/pull/' + number,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headRefName: head,
      baseRefName: flag('--base') || 'main',
      additions: 3,
      deletions: 1,
      changedFiles: 1,
      // Green, in every scenario in this file. The approval gate has to be the only
      // thing that can stop a merge here, or a passing assertion proves nothing.
      statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }],
      reviewDecision: null,
      mergedAt: null,
      mergeCommit: null,
    };
    save();
    out(s.prs[head].url + '\\n');
  }
  const pr = find(args[2]);
  if (args[1] === 'view') {
    if (!pr) fail('no pull requests found for branch ' + args[2]);
    out(JSON.stringify({ ...pr, reviewDecision: s.review }));
  }
  if (args[1] === 'comment') out('commented\\n');
  if (args[1] === 'merge') {
    if (!pr) fail('no pull request found');
    pr.state = 'MERGED';
    pr.mergedAt = '2026-08-10T12:00:00Z';
    pr.mergeCommit = { oid: 'aa11bb22cc33dd44' };
    save();
    out('Merged pull request #' + pr.number + '\\n');
  }
}
fail('unknown gh invocation: ' + args.join(' '));
`,
  { mode: 0o755 }
);

/* ------------------------------------------------------------------- the repo */

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

const origin = path.join(tmp, 'origin.git');
const repo = path.join(tmp, 'repo');
git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
git(tmp, 'clone', '--quiet', origin, repo);
git(repo, 'config', 'user.email', 't@e');
git(repo, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
git(repo, 'add', 'file.txt');
git(repo, 'commit', '--quiet', '-m', 'one');
git(repo, 'push', '--quiet', '-u', 'origin', 'main');

/** A fresh branch with one commit on it — one scenario, one pull request. */
const branchOff = (name) => {
  git(repo, 'checkout', '--quiet', 'main');
  git(repo, 'checkout', '--quiet', '-b', name);
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', name);
};

/* ----------------------------------------------------------------- the config */

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });

const writeConfig = (over = {}) =>
  fs.writeFileSync(
    path.join(CONFIG_DIR, 'config.json'),
    JSON.stringify({
      port: 4318,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:4318',
      token: 'approval-token',
      actor: 'beadcause-test',
      bdBin: FAKE_BD,
      workspaces: [{ name: 'demo', dir: wsDir }],
      sessionDirs: { demo: repo },
      openSessions: false,
      claudeSessions: false,
      ntfy: { enabled: false },
      advocates: { enabled: false, workspaces: [] },
      ...over,
    })
  );

/** Run a delivery the way a worker session ends. The exit code is data, never a throw. */
function deliver(bead) {
  const res = execFileSync(process.execPath, [DELIVER, '-w', 'demo', '-b', bead, '--dir', repo, '--tests', 'npm test — green'], {
    cwd: repo,
    encoding: 'utf8',
    input: 'What changed and why.',
    env: {
      ...process.env,
      BEADCAUSE_CONFIG_DIR: CONFIG_DIR,
      PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
    },
  });
  return res.trim().split('\n').filter(Boolean).pop() || '';
}

const reset = (bead) => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify({
      seq: 200,
      issues: {
        [bead]: { id: bead, title: 'The work', description: '', labels: [], status: 'in_progress', issue_type: 'task', dependencies: [] },
      },
    })
  );
  fs.writeFileSync(BD_LOG, '');
  fs.writeFileSync(GH_LOG, '');
};

const ghCalls = () =>
  fs
    .readFileSync(GH_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const merged = () => ghCalls().some((c) => c[0] === 'pr' && c[1] === 'merge');
const cardOf = (id) => world().issues[id]?.description || '';

/* -------------------------------- green and unapproved, in a space that asks */

console.log('\ngreen checks, no approving review, in a space that requires one\n');

{
  writeConfig({
    pr: { base: 'main', mergeMethod: 'merge', autoMerge: true, mergeWaitMs: 1000 },
    spaces: [{ name: 'Work', workspaces: ['demo'], requireApproval: true }],
  });
  reset('zz-a');
  setReview(null);
  branchOff('work-a');

  const last = deliver('zz-a');
  const card = last.split(' ')[0];

  check('it does not merge — the assertion the whole feature is', !merged(), ghCalls().map((c) => c.join(' ')).join(' | '));
  check('it hands over instead, printing a question id rather than `landed`', /^zz-/.test(card) && !/^landed/.test(last), last);
  check('the work bead is still open, because nothing has landed', world().issues['zz-a'].status !== 'closed');
  check(
    'and it is parked behind the card, so the advocate does not open a second session on it',
    (world().issues['zz-a'].dependencies || []).some((d) => d.id === card)
  );
  check(
    'the card says it is waiting on an approving review',
    /waiting on an approving review/.test(cardOf(card)),
    cardOf(card).split('\n')[0]
  );
  check(
    'and never that auto-merge is off, which is a fact about a switch that is on',
    !/Nothing is merged until you say so/.test(cardOf(card)),
    cardOf(card).split('\n')[0]
  );
  check(
    'nor that it tried to merge and could not — it never asked',
    !/tried to merge/.test(cardOf(card)),
    cardOf(card).split('\n')[0]
  );
  check('it still offers the same three answers', /id: merge/.test(cardOf(card)) && /id: changes/.test(cardOf(card)) && /id: decline/.test(cardOf(card)));
  check(
    'the bead says which of the two it is waiting on, so the thread is not a mystery either',
    (world().issues['zz-a'].comments || []).some((c) => /approving review/.test(c)),
    JSON.stringify(world().issues['zz-a'].comments)
  );
  check(
    'and so does the pull request, where whoever opens the diff is standing',
    ghCalls().some((c) => c[0] === 'pr' && c[1] === 'comment' && /approving review/.test(c.join(' '))),
    ghCalls().filter((c) => c[1] === 'comment').map((c) => c.join(' ')).join(' | ')
  );
}

/* ------------------------------------------- the same space, once it is approved */

console.log('\nthe same space, with the approval on it\n');

{
  reset('zz-b');
  setReview('APPROVED');
  branchOff('work-b');

  const last = deliver('zz-b');

  check('an approved pull request merges itself, exactly as it would with no policy at all', merged());
  check('and says so', /^landed #\d+/.test(last), last);
  check('the bead closes, because the merge is what made it true', world().issues['zz-b'].status === 'closed');
  check('and no card is filed at all', !Object.values(world().issues).some((i) => (i.labels || []).includes('pr-delivery')));
}

/* ---------------------------- CHANGES_REQUESTED is not an approval, and says so */

console.log('\nchanges requested is not an approval\n');

{
  reset('zz-c');
  setReview('CHANGES_REQUESTED');
  branchOff('work-c');

  const last = deliver('zz-c');
  check('a review asking for changes stops the merge as firmly as no review at all', !merged());
  check('and the card is the same one, because it is the same thing missing', /waiting on an approving review/.test(cardOf(last.split(' ')[0])));
}

/* ------------------------------- a space that switches auto-merge off on its own */

console.log('\na space that turns auto-merge off while the global leaves it on\n');

{
  writeConfig({
    pr: { base: 'main', mergeMethod: 'merge', autoMerge: true, mergeWaitMs: 1000 },
    spaces: [{ name: 'Work', workspaces: ['demo'], autoMerge: false }],
  });
  reset('zz-d');
  setReview('APPROVED');
  branchOff('work-d');

  const last = deliver('zz-d');
  const card = last.split(' ')[0];

  check('the space wins over a global that says merge it', !merged());
  check(
    'and the card is the original ask-first sentence, not the approval one',
    /Nothing is merged until you say so/.test(cardOf(card)) && !/waiting on an approving review/.test(cardOf(card)),
    cardOf(card).split('\n')[0]
  );
}

/* ------------------------- and one that switches it on where the global says off */

console.log('\nand a space that turns it on where the global says off\n');

{
  writeConfig({
    pr: { base: 'main', mergeMethod: 'merge', autoMerge: false, mergeWaitMs: 1000 },
    spaces: [{ name: 'Personal', workspaces: ['demo'], autoMerge: true }],
  });
  reset('zz-e');
  setReview(null);
  branchOff('work-e');

  const last = deliver('zz-e');
  check('a space may add as well as subtract — the setup an exclude list cannot express', merged(), last);
  check('and it lands', /^landed #\d+/.test(last), last);
}

/* ----------------------------- the brief and the command reading the same answer */

console.log('\nthe brief and the command, reading one answer\n');

{
  process.env.BEADCAUSE_CONFIG_DIR = CONFIG_DIR;
  process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
  const { prMode, workPromptFor } = await import(path.join(HERE, '..', 'lib', 'session.js'));

  const cfg = {
    pr: { base: 'main', mergeMethod: 'merge', autoMerge: true },
    spaces: [
      { name: 'Work', workspaces: ['demo'], requireApproval: true },
      { name: 'Solo', workspaces: ['solo'] },
    ],
  };
  const bead = { id: 'zz-brief', title: 'A thing' };

  const work = await prMode(cfg, repo, 'demo');
  const solo = await prMode(cfg, repo, 'solo');

  check('the brief reads the same helper the delivery does', work.requireApproval === true && solo.requireApproval === false);
  check(
    'a session in the require-approval space is told the card is the ordinary ending there',
    /waits for an approving review/.test(workPromptFor('demo', bead, 1, work, 'Adam')),
    (workPromptFor('demo', bead, 1, work, 'Adam').match(/.*approving review.*/) || [])[0]
  );
  check(
    'and that an unapproved pull request is one of the reasons it will not merge',
    /nobody has approved it yet/.test(workPromptFor('demo', bead, 1, work, 'Adam'))
  );
  check(
    'a session anywhere else gets exactly the brief it got before, with no mention of approval',
    !/approv/i.test(workPromptFor('solo', bead, 1, solo, 'Adam'))
  );
  check(
    'and both still land their own work, since requiring a review is not switching auto-merge off',
    work.autoMerge === true && solo.autoMerge === true
  );
  check(
    'a space that switches auto-merge off cannot also be asking for an approval — there is nothing left to gate',
    (await prMode({ ...cfg, spaces: [{ name: 'Work', workspaces: ['demo'], autoMerge: false, requireApproval: true }] }, repo, 'demo'))
      .requireApproval === false
  );

  /* -------------------------------------------- and what happens after the merge */

  // Per repo rather than per space, which is the level `autoShipPerWorkspace` exists for
  // — and the point of checking it here is that the brief reads the *same resolver* the
  // release queue does, so a session is never told its merge ships itself in a repo where
  // it does not.
  const ships = await prMode({ ...cfg, autoShipPerWorkspace: { demo: true } }, repo, 'demo');
  check('the brief knows whether the merge ships itself, per repo', ships.autoShip === true && work.autoShip === false);
  check(
    'and says so, so a session does not declare a deploy owed that nobody has to run',
    /merge ships itself here/.test(workPromptFor('demo', bead, 1, ships, 'Adam')) &&
      /drop the flag rather than declaring a deploy/.test(workPromptFor('demo', bead, 1, ships, 'Adam'))
  );
  check(
    'a repo that waits for Ship gets exactly the brief it got before',
    !/ships itself/.test(workPromptFor('demo', bead, 1, work, 'Adam'))
  );
  check(
    'and a repo whose workers do not merge at all is never told its merge ships — there is no merge to ship',
    (
      await prMode(
        { ...cfg, autoShipPerWorkspace: { demo: true }, autoMergePerWorkspace: { demo: false } },
        repo,
        'demo'
      )
    ).autoShip === false
  );
}

await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
