#!/usr/bin/env node
/**
 * **One pull request, full screen** — what the view is drawn from, and the two acts the
 * board never had.
 *
 *     npm test
 *     node test/prfull.mjs
 *
 * A PR row used to be a link out to GitHub and a link to the board. bc-l8jp.7 made it a
 * screen where the merge decision is actually made, which needed three things on the
 * daemon's side, and every one of them can be wrong in a way no screenshot would show:
 *
 * 1. **`GET /api/pr/detail` has to be three sources and say which is which.** The board's
 *    row for the lamps and the rung (25-second sweep), `gh` *now* for the description, the
 *    datetimes and the mergeability the buttons are drawn from, and the session archive for
 *    who wrote it. A view that recomputed the stage would be the second implementation
 *    lib/prstage.js exists to prevent; one that took the description from the sweep would
 *    be reading a field lib/prboard.js deliberately strips.
 * 2. **`POST /api/pr/close` closes at GitHub and touches no bead.** The reason box's words
 *    go on the pull request; the beads the row *matched* are left exactly as they are,
 *    because reopening one is what puts an unattended session on it and those matches come
 *    from a branch name or a sentence in a body. Refused outright on a merged pull request:
 *    closing it now cannot un-merge it.
 * 3. **`POST /api/pr/conflicts` opens a session, and only for a real conflict.** It is the
 *    only path here that starts something unattended, so it refuses a pull request GitHub
 *    does not report as conflicting, refuses a settled one, and refuses an observer.
 *
 * And the attribution itself (lib/prauthor.js), against a real session archive written into
 * a real repo's refs: a branch match is the answer, a session on the bead that worked a
 * *different* branch is reported as exactly that, and a pull request with nothing archived
 * gets the GitHub login and is labelled as one.
 *
 * A real git repo with a real `origin` — the lamps are ancestry questions — a fake `gh`, a
 * fake `bd`, and a fake `osascript` so "open a session" is an assertion about a launch
 * rather than a window on somebody's screen.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-prfull-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------- the repo */

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

const origin = path.join(tmp, 'widgets.git');
const repo = path.join(tmp, 'widgets');
git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
git(tmp, 'clone', '--quiet', origin, repo);
git(repo, 'config', 'user.email', 't@e');
git(repo, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
git(repo, 'add', 'file.txt');
git(repo, 'commit', '--quiet', '-m', 'one');
git(repo, 'push', '--quiet', '-u', 'origin', 'main');

/* ------------------------------------------------------- a real session archive */

/*
 * `archiveSession` writes `refs/beadcause/sessions/<bead>` with meta.json inside it, which
 * is the only record on this Mac of which session produced which branch. Two entries on one
 * bead, on two different branches, because that is the case the attribution has to tell
 * apart: the newest session is not necessarily the one that opened the pull request.
 */
const { archiveSession } = await import(LIB('sessionlog.js'));

await archiveSession(repo, {
  workspace: 'demo',
  bead: 'zz-work',
  sessionId: '11111111-2222-3333-4444-555555555555',
  startedAt: '2026-08-10T09:00:00Z',
  endedAt: '2026-08-10T10:00:00Z',
  outcome: 'done',
  logLines: ['first attempt'],
  title: 'the work',
});
// Faked afterwards: `archiveSession` reads the branch off the worktree the session ran in,
// and there is no such worktree here. The field is what the attribution matches on, so it
// is written directly — which is also the only way to stage two entries on two branches.
const stampBranch = (bead, branch, sessionId) => {
  const ref = `refs/beadcause/sessions/${bead}`;
  const meta = JSON.parse(git(repo, 'cat-file', '-p', `${ref}:meta.json`));
  meta.branch = branch;
  if (sessionId) meta.sessionId = sessionId;
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
stampBranch('zz-work', 'bead/zz-work-first');
// The second session on the same bead, on the branch the pull request is actually for.
await archiveSession(repo, {
  workspace: 'demo',
  bead: 'zz-work',
  sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  startedAt: '2026-08-10T11:00:00Z',
  endedAt: '2026-08-10T12:00:00Z',
  outcome: 'done',
  logLines: ['second attempt'],
  title: 'the work',
});
stampBranch('zz-work', 'bead/zz-work', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

/* ---------------------------------------------------------------- the fake gh */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const PR_STATE = path.join(tmp, 'prs.json');
const GH_LOG = path.join(tmp, 'gh-calls.log');
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

const BODY = 'What changed and why.\n\n- one thing\n- another\n';

/**
 * Four pull requests, one per case:
 *
 * #7  open, mergeable, on the branch the archive knows      — the ordinary full view
 * #8  open, CONFLICTING                                     — the conflict path
 * #9  merged                                                — close must refuse it
 * #10 open, no bead anywhere                                — attribution falls back
 */
const rawPR = (over = {}) => ({
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  title: 'zz-work: something small',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'bead/zz-work',
  baseRefName: 'main',
  additions: 4,
  deletions: 1,
  changedFiles: 1,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: null,
  mergeCommit: null,
  body: BODY,
  author: { login: 'someone' },
  createdAt: iso(2),
  updatedAt: iso(1),
  ...over,
});

const resetPRs = () =>
  fs.writeFileSync(
    PR_STATE,
    JSON.stringify([
      rawPR(),
      rawPR({
        number: 8,
        url: 'https://github.com/acme/widgets/pull/8',
        title: 'zz-work: the conflicting one',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
      }),
      rawPR({
        number: 9,
        url: 'https://github.com/acme/widgets/pull/9',
        title: 'zz-work: already in',
        state: 'MERGED',
        mergedAt: iso(1),
        mergeCommit: { oid: git(repo, 'rev-parse', 'HEAD') },
      }),
      rawPR({
        number: 10,
        url: 'https://github.com/acme/widgets/pull/10',
        title: 'opened by hand',
        headRefName: 'somebody/patch-1',
        body: 'no bead here',
      }),
    ])
  );
resetPRs();

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const STATE = ${JSON.stringify(PR_STATE)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + '\\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = (all) => fs.writeFileSync(STATE, JSON.stringify(all));
if (args[0] === 'auth' && args[1] === 'status') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/widgets' }));
if (args[0] === 'pr' && args[1] === 'list') out(JSON.stringify(load()));
if (args[0] === 'pr' && args[1] === 'view') {
  const n = Number(args[2]);
  const pr = load().find((p) => p.number === n);
  if (!pr) { process.stderr.write('no pull requests found for ' + args[2] + '\\n'); process.exit(1); }
  out(JSON.stringify(pr));
}
if (args[0] === 'pr' && args[1] === 'close') {
  const n = Number(args[2]);
  const all = load();
  const pr = all.find((p) => p.number === n);
  pr.state = 'CLOSED';
  save(all);
  out('Closed pull request #' + n + '\\n');
}
if (args[0] === 'pr' && args[1] === 'comment') out('https://github.com/acme/widgets/pull/' + args[2] + '#issuecomment-1\\n');
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);

/* ---------------------------------------------------------------- the fake bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('node:fs');
const WORLD = ${JSON.stringify(WORLD)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const live = (i) => i.status !== 'closed';
if (args[0] === 'list') {
  const label = flag('--label');
  let rows = Object.values(w.issues);
  if (label) rows = rows.filter((i) => (i.labels || []).includes(label));
  if (flag('--limit') === '1') rows = rows.slice(0, 1);
  process.stdout.write(JSON.stringify(rows.filter(live)));
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (issue.comments = issue.comments || []).push(args[2]);
  save();
  process.exit(0);
}
if (args[0] === 'close' || args[0] === 'reopen' || args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (args[0] === 'close') { issue.status = 'closed'; issue.close_reason = flag('--reason') || ''; }
  if (args[0] === 'reopen') issue.status = 'open';
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'zz-work': {
            id: 'zz-work',
            title: 'The work',
            description: '',
            labels: [],
            status: 'in_progress',
            issue_type: 'task',
            dependencies: [],
            comments: [],
          },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(BD_LOG, '');
  // The gh log too, or "nothing reached gh" is a claim about every block that ran before
  // this one — which is how a refusal that works reads as a refusal that doesn't.
  fs.writeFileSync(GH_LOG, '');
  resetPRs();
};
reset();

/* ------------------------------------------------------------------ the daemon */

const beads = path.join(tmp, 'beads', 'demo', '.beads');
fs.mkdirSync(beads, { recursive: true });

const base = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'prfull-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [{ name: 'demo', dir: beads }],
  sessionDirs: { demo: repo },
  // Off, and it is a claim rather than a convenience — the same one test/prship.mjs makes:
  // **nothing here opens a window.** `/api/pr/conflicts` checks the pull request *before*
  // it checks this, so the two refusals that are about the PR still answer 409 and only the
  // path that would really launch iTerm becomes a 403. The brief that path would carry is
  // asserted directly, off `conflictPromptFor`, which is why it is exported.
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
  pr: { base: 'main', mergeMethod: 'merge' },
};

process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const { createApp, listen } = await import(LIB('server.js'));
const { forgetBoard } = await import(LIB('prboard.js'));
const { authorOf } = await import(LIB('prauthor.js'));
const { conflictPromptFor } = await import(LIB('session.js'));
const pr = await import(LIB('pr.js'));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});
const cfg = { ...base, port };
const app = createApp(cfg);
const servers = listen(cfg, app.handler);

const request = (method, pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
          'x-beadcause-token': cfg.token,
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const get = (pathname) => request('GET', pathname);
const post = (pathname, body) => request('POST', pathname, body);

for (let i = 0; i < 100; i += 1) {
  try {
    await post('/api/nothing', {});
    break;
  } catch {
    await sleep(20);
  }
}

/* ------------------------------------------------------------- what it is drawn from */

console.log('\none pull request, full screen\n');

{
  const res = await get('/api/pr/detail?workspace=demo&number=7');
  const { row, pr: live, agent } = res.json;
  check('the detail is served', res.status === 200, JSON.stringify(res.json).slice(0, 200));

  // The description: the one field the board strips from every row on purpose. If this
  // ever came back empty the view would draw "no description" over a pull request that
  // has one, which is indistinguishable from a PR nobody wrote anything about.
  check('the description comes from gh, not from the board', live?.body === BODY, JSON.stringify(live?.body));
  check('and the board row still does not carry one', row?.body === undefined, JSON.stringify(row?.body));

  // The datetimes. `updatedAt` is on the board's row already; `createdAt` is not what the
  // view needs it for, and neither is on `pr.view`'s field set.
  check('the datetimes are there', Boolean(live?.createdAt && live?.updatedAt), JSON.stringify(live));

  // The rung and the lamps come from the sweep, computed once in lib/prstage.js. A view
  // that derived its own would be the disagreement that file exists to prevent.
  check('the rung is the board’s, not recomputed here', row?.stage === 'review', row?.stage);
  check('and so are the lamps', row?.merged === false && row?.pushed === false, JSON.stringify(row));
  check('the beads are named', (row?.beads || []).some((b) => b.id === 'zz-work'), JSON.stringify(row?.beads));

  // Mergeability is what the buttons are drawn from, so it has to be GitHub's answer now.
  check('mergeability is read fresh', live?.mergeable === 'MERGEABLE', live?.mergeable);
}

/* ------------------------------------------------------------------- who wrote it */

{
  const res = await get('/api/pr/detail?workspace=demo&number=7');
  const agent = res.json.agent;
  check(
    'the authoring agent is the archived session for *this* branch',
    agent?.kind === 'session' && agent.matched === true && agent.sessionId === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    JSON.stringify(agent)
  );
  check('and it says which bead it was on', agent?.bead === 'zz-work', JSON.stringify(agent));
}

{
  // The case that makes the branch match worth doing rather than "the newest session on
  // the bead": a bead worked twice, where the pull request is for the *first* branch.
  const one = await authorOf(repo, {
    author: 'someone',
    branch: 'bead/zz-work-first',
    beads: [{ id: 'zz-work' }],
  });
  check(
    'a bead worked twice attributes to the branch, not to the last session',
    one.matched === true && one.sessionId === '11111111-2222-3333-4444-555555555555',
    JSON.stringify(one)
  );

  // A branch nothing archived worked. It must not silently borrow the newest session's
  // identity: the mismatch is the fact worth reporting.
  const off = await authorOf(repo, {
    author: 'someone',
    branch: 'bead/never-existed',
    beads: [{ id: 'zz-work' }],
  });
  check(
    'a branch nothing archived says so rather than borrowing a session',
    off.kind === 'session' && off.matched === false && off.branch !== 'bead/never-existed',
    JSON.stringify(off)
  );
}

{
  // A pull request opened by hand: no bead, so nothing to look under. The login is all
  // there is, and it is labelled as a GitHub account rather than dressed up as an agent —
  // which is the whole reason this is not read off the PR body's boilerplate.
  const res = await get('/api/pr/detail?workspace=demo&number=10');
  const agent = res.json.agent;
  check('a hand-opened pull request falls back to the GitHub login', agent?.kind === 'github', JSON.stringify(agent));
  check('and says so, rather than claiming an agent', agent?.login === 'someone' && agent?.matched === false, JSON.stringify(agent));
}

/* ---------------------------------------------------------------------- closing it */

{
  reset();
  forgetBoard();
  const res = await post('/api/pr/close', { workspace: 'demo', number: 7, reason: 'the approach is wrong' });
  check('close is taken', res.status === 200, JSON.stringify(res.json));
  check('and GitHub really closed it', JSON.parse(fs.readFileSync(PR_STATE, 'utf8'))[0].state === 'CLOSED');

  // The reason box's words, verbatim, on the pull request — the only thing that will
  // explain the closed tab to whoever opens it in six weeks.
  const closed = fs
    .readFileSync(GH_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((c) => c[0] === 'pr' && c[1] === 'close');
  check('the reason goes on the pull request', closed?.join(' ').includes('the approach is wrong'), JSON.stringify(closed));
  check('and the branch is kept', !closed?.includes('--delete-branch'), JSON.stringify(closed));

  // The half that is a design decision rather than an omission: no bead moves. Reopening
  // one is what puts an unattended session on it, and `row.beads` is a *match* — from a
  // branch name or a claim in a body — not the block a worker wrote.
  check('the work bead is left exactly as it was', world().issues['zz-work'].status === 'in_progress', world().issues['zz-work'].status);
  check(
    'nothing was written to the tracker at all',
    !bdCalls().some((c) => ['close', 'reopen', 'comment', 'update'].includes(c[0])),
    bdCalls().map((c) => c.join(' ')).join(' | ')
  );
  check('and the response names the beads it did not touch', (res.json.beads || []).includes('zz-work'), JSON.stringify(res.json));
}

{
  reset();
  forgetBoard();
  // Closing something already merged cannot un-merge it, so it is refused here rather
  // than passed to `gh`, which would happily close the branch's tab and say nothing.
  const res = await post('/api/pr/close', { workspace: 'demo', number: 9 });
  check('a merged pull request refuses to be closed', res.status === 409, `HTTP ${res.status}`);
  check('and says why', /already merged/.test(res.json.error || ''), res.json.error);
  check('with nothing sent to gh', !fs.readFileSync(GH_LOG, 'utf8').includes('"close"'), 'a close reached gh');
}

/* ------------------------------------------------------------------ the conflict path */

{
  reset();
  forgetBoard();
  // A conflicting pull request gets all the way to the launch — and stops there, because
  // this daemon has windows switched off. That is the fork being asserted rather than
  // inferred: the two refusals below are 409s about the pull request, and this is the one
  // request that reached the thing that would have opened iTerm.
  const res = await post('/api/pr/conflicts', { workspace: 'demo', number: 8 });
  check('a conflicting pull request reaches the launch', res.status === 403, `HTTP ${res.status} ${JSON.stringify(res.json)}`);
  check('and stops there, because windows are off here', /openSessions/.test(res.json.error || ''), res.json.error);

  // What the session would be asked to do. The four things it must say are the four an
  // unattended session gets wrong when a brief is vague: which way the merge goes, where to
  // stand, that the repo's own gate runs afterwards, and that it stops at a push.
  const brief = conflictPromptFor(
    'demo',
    { number: 8, title: 'the conflicting one', repo: 'acme/widgets', branch: 'bead/zz-work', base: 'main', beads: [{ id: 'zz-work' }] },
    'Adam'
  );
  check('the brief names the branch and the base', /bead\/zz-work/.test(brief) && /origin\/main/.test(brief), brief.slice(0, 300));
  check('and the bead it carries', /zz-work/.test(brief), brief.slice(0, 300));
  check('it says the branch is what is behind, not main', /branch is what is behind/.test(brief), brief.slice(0, 400));
  check('it sends the session to a worktree rather than the shared checkout', /git worktree list/.test(brief), brief.slice(0, 700));
  check('it runs the repo’s own gate afterwards', /CLAUDE\.md/.test(brief), brief);
  check('and it stops at a push — the merge stays a tap', /Push the branch\. Then stop\./.test(brief), brief.slice(-500));
  check('nothing in it merges into the base', !/merge .*into \\?`main/.test(brief.replace(/branch is what is behind[^\n]*\n/, '')), brief);
}

{
  reset();
  forgetBoard();
  // The refusal that matters most: a session opened for a conflict that is not there is a
  // window somebody has to go and close.
  const res = await post('/api/pr/conflicts', { workspace: 'demo', number: 7 });
  check('a mergeable pull request opens nothing', res.status === 409, `HTTP ${res.status}`);
  check('and says GitHub does not report a conflict', /does not report/.test(res.json.error || ''), res.json.error);
}

{
  reset();
  forgetBoard();
  const res = await post('/api/pr/conflicts', { workspace: 'demo', number: 9 });
  check('a merged one opens nothing either', res.status === 409, `HTTP ${res.status}`);
  check('and says there is no conflict left', /no conflict left/.test(res.json.error || ''), res.json.error);
}

{
  // The one refusal that is about who is asking rather than about the pull request. An
  // observer shares these checkouts and must not open an unattended session in a repo it
  // is only visiting — the same rule `/api/pr/ship` and `/api/session` keep. `OBSERVING` is
  // read once at import from the environment, so this is the one claim here that has to be
  // made against the source rather than over the wire.
  const src = fs.readFileSync(LIB('server.js'), 'utf8');
  const at = src.indexOf("p === '/api/pr/conflicts'");
  const block = src.slice(at, at + 1200);
  check('an observer is refused before anything is read', /if \(OBSERVING\) return json\(res, 403/.test(block), block.slice(0, 200));
}

/* --------------------------------------------------------------------- and the seam */

{
  // The reason `/api/pr/detail` exists at all rather than the board carrying descriptions:
  // `viewDetail` asks for the list's field set, which is the only one with `body` in it.
  const one = await pr.viewDetail(repo, 7);
  check('viewDetail folds on the four fields view() leaves off', one.body === BODY && one.author === 'someone', JSON.stringify(one).slice(0, 200));
  const narrow = await pr.view(repo, 7);
  check('and view() still does not carry them', narrow.body === undefined && narrow.author === undefined, JSON.stringify(narrow).slice(0, 200));
}

for (const s of servers || []) s.close?.();
app.stop?.();

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
