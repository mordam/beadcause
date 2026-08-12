#!/usr/bin/env node
/**
 * **Delivering twice with nobody at the phone** — one card, one dependency, one truth.
 *
 *     npm test
 *     node test/redeliver.mjs
 *
 * `bin/deliver.js` files a merge card whenever it cannot land the work itself, and
 * parks the work bead behind that card so the advocate does not open a second session
 * onto a pull request that already exists. Both halves are right. What neither of them
 * survived was the *second* delivery of the same branch.
 *
 * bc-ec6 was delivered three times in twenty minutes. Three cards, each with its own
 * dependency on the same work bead, two of them open at once — so the inbox carried an
 * identical question twice and it was answered twice, a minute apart. Both answers said
 * "Merged #25 — closed bc-ec6". Neither could have: each card was a blocker on that
 * bead's close, and nothing retried a close that had been refused. bc-ec6 sat
 * `in_progress` over a merged pull request, its thread claiming twice that it had not.
 *
 * Three failures are worth this file, and the second is the one that would come back
 * silently:
 *
 * 1. **Two open cards for one pull request.** The whole bug. A re-delivery has to close
 *    the card it is replacing before it files its own, or the inbox carries the same
 *    question twice with no way to tell which one matters.
 * 2. **A card belonging to some other pull request being closed with it.** The
 *    correction to (1) is a `bd close` driven by a match, and a match that is too broad
 *    silently swallows an unrelated question — a far worse failure than the one it
 *    fixes, and invisible until somebody misses a merge. So a second delivery card, on
 *    a second pull request, sits in the workspace throughout and must come out
 *    untouched.
 * 3. **A merge that leaves its own card open behind it.** "Merge #25?" over an already
 *    merged #25 is a question with no answer left in it — and it is a blocker on the
 *    work bead, so leaving it open is what stops the delivery closing the bead it just
 *    landed.
 * 4. **A delivery of a branch somebody already merged on github.com.** The same shape
 *    from the other end: there is nothing to push and nothing to open, because the work
 *    is in `main` already. This used to die at the `no commits` guard with `exit 2`, so
 *    the one command a worker is given to land work with could not close the bead over
 *    work that had landed — and the bead stayed open for the advocate to hand out again.
 *
 * The last one has a second claim under it that matters more than it looks: the branch
 * must **not** be pushed on that path. A card merge deletes the remote branch, and a
 * `git push --set-upstream` afterwards would recreate, from this laptop, a branch GitHub
 * deleted on purpose.
 *
 * Real git, real branches, a real `origin`. `gh` and `bd` are fakes, because what is
 * being asserted is which calls this makes and what the tracker looks like afterwards —
 * and neither may touch a real repo or a real workspace. Nothing here reaches the
 * network.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-redeliver-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

/* --------------------------------------------------------------- the fake bd */

/**
 * A tracker in a JSON file: issues, labels, dependencies, and bd's own refusal.
 *
 * The close gate is implemented rather than stubbed, because it is the rule the whole
 * bug turns on — bd will not close an issue with an open blocker, and a fake that
 * closed anything would prove nothing at all. Its refusal is worded as bd words it,
 * since that sentence ends up on a bead.
 */
const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const writeWorld = (w) => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));

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
  if (open.length) die('cannot close ' + issue.id + ': blocked by open issues [' + open.join(' ') + '] (use --force to override)');
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
  const before = (issue.dependencies || []).length;
  issue.dependencies = (issue.dependencies || []).filter((d) => d.id !== args[3]);
  if (issue.dependencies.length === before) die('no such dependency');
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

/** One pull request per branch, keyed by branch name — which is how `gh pr view` finds it. */
const ghState = () => JSON.parse(fs.readFileSync(GH_STATE, 'utf8'));
fs.writeFileSync(GH_STATE, JSON.stringify({ next: 25, prs: {} }));

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
// Which repo this checkout is, which \`bin/deliver.js\` now asks before it pushes: a
// checkout no account can see on GitHub has nowhere to open a pull request, and finding
// that out from a failed \`gh pr create\` names the remote rather than the repo.
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
      statusCheckRollup: [],
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
    out(JSON.stringify(pr));
  }
  if (args[1] === 'comment') out('commented\\n');
  if (args[1] === 'merge') {
    if (!pr) fail('no pull request found');
    pr.state = 'MERGED';
    pr.mergedAt = '2026-08-10T12:00:00Z';
    pr.mergeCommit = { oid: 'c5004cceabcdef01' };
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
git(repo, 'checkout', '--quiet', '-b', 'work');
const commit = (text) => {
  fs.appendFileSync(path.join(repo, 'file.txt'), `${text}\n`);
  git(repo, 'add', 'file.txt');
  git(repo, 'commit', '--quiet', '-m', text);
};
commit('two');

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
      token: 'redeliver-token',
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

/** Run a delivery the way a worker session ends. Never throws — the exit code is data. */
function deliver(extra = []) {
  const res = execFileSync(
    process.execPath,
    [DELIVER, '-w', 'demo', '-b', 'zz-work', '--dir', repo, '--tests', 'npm test — green', ...extra],
    {
      cwd: repo,
      encoding: 'utf8',
      input: 'What changed and why.',
      env: {
        ...process.env,
        BEADCAUSE_CONFIG_DIR: CONFIG_DIR,
        PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
      },
    }
  );
  // The last line is the delivery's own answer — `<question> <url>`, or `landed #n …`.
  // Anything above it is another module's chatter on the way past.
  return res.trim().split('\n').filter(Boolean).pop() || '';
}

/**
 * The tracker before each scenario: the work bead, and a card for a *different* pull
 * request that must survive everything done here.
 */
const reset = () => {
  writeWorld({
    seq: 100,
    issues: {
      'zz-work': { id: 'zz-work', title: 'The work', description: '', labels: [], status: 'in_progress', issue_type: 'task', dependencies: [] },
      'zz-other': {
        id: 'zz-other',
        title: 'Merge #99? something else',
        description: ['```beadpr', 'workspace: demo', 'bead: zz-elsewhere', 'repo: acme/widgets', 'number: 99', 'url: https://github.com/acme/widgets/pull/99', 'branch: other', 'base: main', 'method: merge', '```'].join('\n'),
        labels: ['human', 'pr-delivery'],
        status: 'open',
        issue_type: 'task',
        dependencies: [],
      },
    },
  });
  fs.writeFileSync(BD_LOG, '');
  fs.writeFileSync(GH_LOG, '');
};

const openCards = () =>
  Object.values(world().issues).filter((i) => (i.labels || []).includes('pr-delivery') && i.status !== 'closed');
const blockers = (id) =>
  (world().issues[id].dependencies || []).filter((d) => (world().issues[d.id] || {}).status !== 'closed');

console.log('\nre-delivering the same branch\n');

/* ------------------------------------------- two deliveries, nobody in between */

{
  // `autoMerge: false` is the shape the bug was found in and the simplest way to reach
  // the fallback twice: every delivery is a question, so two deliveries are two cards.
  writeConfig({ pr: { autoMerge: false, base: 'main', mergeMethod: 'merge' } });
  reset();

  const first = deliver();
  const firstCard = first.split(' ')[0];
  commit('three');
  const second = deliver();
  const secondCard = second.split(' ')[0];

  check('each delivery files its own card', firstCard !== secondCard, `${firstCard} vs ${secondCard}`);
  check(
    'and only the newer one is open',
    openCards().map((c) => c.id).sort().join(',') === [secondCard, 'zz-other'].sort().join(','),
    openCards().map((c) => c.id).join(',')
  );
  check(
    'the one it replaced says so',
    /[Ss]uperseded/.test(world().issues[firstCard].close_reason || ''),
    world().issues[firstCard].close_reason
  );
  check(
    'a card for another pull request is left alone',
    world().issues['zz-other'].status === 'open',
    world().issues['zz-other'].status
  );
  check(
    'the work bead is blocked by exactly one thing',
    blockers('zz-work').length === 1 && blockers('zz-work')[0].id === secondCard,
    JSON.stringify(blockers('zz-work'))
  );
  check(
    'and carries no dead edge to the card that was replaced',
    !(world().issues['zz-work'].dependencies || []).some((d) => d.id === firstCard),
    JSON.stringify(world().issues['zz-work'].dependencies)
  );
  check(
    'the thread says which card replaced which',
    (world().issues['zz-work'].comments || []).some((c) => c.includes(firstCard) && c.includes(secondCard)),
    JSON.stringify(world().issues['zz-work'].comments)
  );
}

/* --------------------------------------- and then the worker merges it after all */

{
  // The same branch again, this time with the merge allowed. The card from the
  // delivery before it is a question about a pull request that has just merged — and,
  // until this was fixed, the blocker that stopped the work bead closing.
  writeConfig({ pr: { autoMerge: true, base: 'main', mergeMethod: 'merge' } });
  commit('four');
  const out = deliver();

  check('it reports a merge, not a question', out.startsWith('landed #'), out);
  check(
    'the card left over from the earlier delivery is closed',
    openCards().map((c) => c.id).join(',') === 'zz-other',
    openCards().map((c) => c.id).join(',')
  );
  check('the work bead closed with the merge', world().issues['zz-work'].status === 'closed', world().issues['zz-work'].status);
  check(
    'and its close reason names the pull request',
    /#25/.test(world().issues['zz-work'].close_reason || ''),
    world().issues['zz-work'].close_reason
  );
  check(
    'nothing is owed once the close went through',
    !fs.existsSync(path.join(CONFIG_DIR, 'owed-closes.json')) ||
      Object.keys(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'owed-closes.json'), 'utf8'))).length === 0,
    fs.existsSync(path.join(CONFIG_DIR, 'owed-closes.json')) ? fs.readFileSync(path.join(CONFIG_DIR, 'owed-closes.json'), 'utf8') : ''
  );
}

/* ------------------------------------- a close refused is a close written down */

{
  // The one case the sweep exists for: something *else* blocks the work bead, so the
  // merge lands and the close cannot. It must be reported as refused and recorded for
  // the daemon to retry — never reported as done.
  writeConfig({ pr: { autoMerge: true, base: 'main', mergeMethod: 'merge' } });
  reset();
  const w = world();
  w.issues['zz-blocker'] = { id: 'zz-blocker', title: 'Something else', description: '', labels: [], status: 'open', issue_type: 'task', dependencies: [] };
  w.issues['zz-work'].dependencies = [{ id: 'zz-blocker', dependency_type: 'blocks' }];
  writeWorld(w);
  fs.rmSync(path.join(CONFIG_DIR, 'owed-closes.json'), { force: true });

  git(repo, 'checkout', '--quiet', '-b', 'work-two');
  commit('five');
  const out = deliver();

  check('it still lands', out.startsWith('landed #'), out);
  check('the work bead stays open, because bd said no', world().issues['zz-work'].status !== 'closed', world().issues['zz-work'].status);
  check(
    'and the bead is told so in bd’s own words',
    (world().issues['zz-work'].comments || []).some((c) => /did \*\*not\*\* close/.test(c) && /blocked by open issues/.test(c)),
    JSON.stringify(world().issues['zz-work'].comments)
  );
  const owed = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'owed-closes.json'), 'utf8'));
  check('the close is written down to be retried', Boolean(owed['demo/zz-work']), JSON.stringify(owed));
  check(
    'with the reason it should carry when it finally goes through',
    /#26/.test(owed['demo/zz-work']?.reason || ''),
    owed['demo/zz-work']?.reason
  );
}

/* --------------------------- a branch somebody already merged on github.com */

{
  // The trap from the other end. The pull request merged on GitHub rather than from a
  // card, so nothing here closed the bead; the advocate handed it out again; and the
  // session it handed it to is told to end with this command. There is nothing to push
  // and nothing to open — and until this was fixed, that was `exit 2` and a bead left
  // open for attempt 3.
  writeConfig({ pr: { autoMerge: true, base: 'main', mergeMethod: 'merge' } });
  reset();
  fs.rmSync(path.join(CONFIG_DIR, 'owed-closes.json'), { force: true });

  git(repo, 'checkout', '--quiet', '-b', 'work-landed');
  commit('six');
  git(repo, 'push', '--quiet', '-u', 'origin', 'work-landed');

  // Merged on GitHub: `origin/main` carries the work, and the pull request says MERGED.
  // Nothing in beadcause was involved, which is the whole point of the case.
  git(repo, 'checkout', '--quiet', 'main');
  git(repo, 'merge', '--quiet', '--no-ff', '-m', 'Merge pull request #77', 'work-landed');
  git(repo, 'push', '--quiet', 'origin', 'main');
  git(repo, 'checkout', '--quiet', 'work-landed');
  const landedSha = git(repo, 'rev-parse', 'HEAD');

  const s = ghState();
  s.prs['work-landed'] = {
    number: 77,
    title: 'zz-work: the work',
    url: 'https://github.com/acme/widgets/pull/77',
    state: 'MERGED',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: 'work-landed',
    baseRefName: 'main',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    statusCheckRollup: [],
    reviewDecision: null,
    mergedAt: '2026-08-10T12:00:00Z',
    mergeCommit: { oid: landedSha },
  };
  fs.writeFileSync(GH_STATE, JSON.stringify(s, null, 2));

  const before = git(repo, 'rev-parse', 'origin/work-landed');
  const out = deliver();
  const bead = world().issues['zz-work'];

  check('a branch already merged on GitHub reports a landing, not a failure', out.startsWith('landed #77'), out);
  check('the work bead is closed', bead.status === 'closed', bead.status);
  check('and its close reason says where the merge happened', /on GitHub/.test(bead.close_reason || ''), bead.close_reason);
  check(
    'the bead is told the merge was not a beadcause session’s',
    (bead.comments || []).some((c) => /merged into `main` on GitHub rather than from a delivery card/.test(c)),
    JSON.stringify(bead.comments)
  );
  check('no new card is filed over merged work', openCards().map((c) => c.id).join(',') === 'zz-other', openCards().map((c) => c.id).join(','));
  check(
    'and nothing was pushed to the branch on the way past',
    git(repo, 'rev-parse', 'origin/work-landed') === before,
    `${before} → ${git(repo, 'rev-parse', 'origin/work-landed')}`
  );
  const calls = fs.readFileSync(GH_LOG, 'utf8');
  check('no pull request was opened', !/"create"/.test(calls), calls.split('\n').filter(Boolean).join(' | '));
  check('and nothing was asked to merge', !/"merge"/.test(calls), calls.split('\n').filter(Boolean).join(' | '));
}

await cleanupTmp(tmp);
console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall ${ran} passed\n`);
process.exit(failures ? 1 : 0);
