#!/usr/bin/env node
/**
 * **The PR board's Merge button, which queues rather than merges** — bc-02ldo.
 *
 *     npm test
 *     node test/boardmerge.mjs
 *
 * This file used to prove the opposite. `POST /api/pr/merge` called `gh pr merge`, and
 * everything asserted here was about what a merge leaves behind: the local base
 * fast-forwarded, the conflict sweep asked for, the inbox's own "Merge #N?" card retired
 * behind it. What none of it noticed is that the merge itself went round the merge queue —
 * no downmerge, no baseline comparison, no one-at-a-time, and **no record in the tracker
 * that anybody had decided anything**.
 *
 * deluvia is the evidence. Three pull requests merged on one afternoon: #53 and #54 went
 * through `/merge` and each left a merge-bead closed with the commit it landed as; #55 was
 * merged from this button and the graph holds nothing about it. Its approval exists
 * nowhere. Meanwhile the merge skill names this endpoint, by path, as the thing agents
 * must not do — so the app was performing the act its own documentation calls a mistake.
 *
 * Adam ruled that the app should match the skill, and took the cost out loud: the button
 * stops being instant, because the queue's "is anything waiting" read is cached and the
 * merge lands a minute or two later.
 *
 * Five failures are worth the file:
 *
 * 1. **Merging anyway.** The bug itself, and the cheapest thing here to assert: after the
 *    tap, `gh pr merge` must not have run and the pull request must still be open.
 * 2. **A card that stays a question.** A delivery card asking "Merge #7?" is not closed
 *    beside the queue entry — it *becomes* the queue entry, relabelled and re-armed, so
 *    the inbox loses the question the moment the decision is made and the work bead stays
 *    parked behind the same bead it always was.
 * 3. **Queuing something that is not this pull request.** The dangerous direction, and
 *    invisible unless asserted: admitting #7 must not touch a card about #8, a card in
 *    another repo, or an ordinary question that is not a delivery at all. This is why the
 *    endpoint decides on the *number* and never on the bead — the board infers a bead from
 *    a branch name, and an inference that picked the card for a second open pull request
 *    against the same bead would queue the wrong branch.
 * 4. **Claiming a move nothing made.** A pull request already on the queue is *approved*,
 *    not re-queued: `queued` comes back false, nothing is relabelled, and the approval is
 *    still recorded so a space that asks for one is satisfied.
 * 5. **Swallowing the pile.** Two open beads about one pull request is a work bead that
 *    cannot close. `beadcause-merge` prints them to stderr; a phone has no stderr, so they
 *    ride back in the reply.
 *
 * A real git repo with a real `origin` (the board's lamps are ancestry questions), a fake
 * `gh` that logs every invocation, and a fake `bd` that can be read back afterwards.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-boardmerge-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load,
// and lib/owed.js keeps its ledger under it.
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

const { deliveryBody } = await import(LIB('delivery.js'));
const { readOwed, OWED_PATH } = await import(LIB('owed.js'));
const { readSweepRequests, MERGE_SWEEPS_PATH } = await import(LIB('mergesweep.js'));
const { MERGE_ASSIGNEE, MERGE_LABEL, queueState } = await import(LIB('mergebead.js'));

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
const HEAD = git(repo, 'rev-parse', 'HEAD');

/* ---------------------------------------------------------------- the fake gh */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const PR_STATE = path.join(tmp, 'prs.json');
const GH_LOG = path.join(tmp, 'gh-calls.log');

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

/** The two pull requests: #7 is the one being queued, #8 is the one that must be left alone. */
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
  body: '',
  author: { login: 'someone' },
  createdAt: iso(2),
  updatedAt: iso(1),
  ...over,
});

const resetPRs = (over = {}) =>
  fs.writeFileSync(
    PR_STATE,
    JSON.stringify([rawPR(over), rawPR({ number: 8, url: 'https://github.com/acme/widgets/pull/8', title: 'zz-other: later' })])
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
if (args[0] === 'auth' && args[1] === 'status') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/widgets' }));
if (args[0] === 'pr' && args[1] === 'list') out(JSON.stringify(load()));
if (args[0] === 'pr' && args[1] === 'comment') out('https://github.com/acme/widgets/pull/' + args[2] + '#issuecomment-1\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  const n = Number(args[2]);
  const pr = load().find((p) => p.number === n);
  if (!pr) { process.stderr.write('no pull requests found for ' + args[2] + '\\n'); process.exit(1); }
  out(JSON.stringify(pr));
}
if (args[0] === 'pr' && args[1] === 'merge') {
  // Deliberately still works. The point of this suite is that nothing reaches it.
  const n = Number(args[2]);
  const all = load();
  const pr = all.find((p) => p.number === n);
  pr.state = 'MERGED';
  pr.mergedAt = new Date().toISOString();
  pr.mergeCommit = { oid: ${JSON.stringify(HEAD)} };
  fs.writeFileSync(STATE, JSON.stringify(all));
  out('Merged pull request #' + n + '\\n');
}
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const ghCalls = () =>
  fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const merges = () => ghCalls().filter((c) => c[0] === 'pr' && c[1] === 'merge');

/* ---------------------------------------------------------------- the fake bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const writeWorld = (w) => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));

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
const flags = (n) => args.map((a, i) => (a === n ? args[i + 1] : null)).filter((v) => v !== null);
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const live = (i) => i.status !== 'closed';
const hydrate = (i) => ({ ...i, dependencies: (i.dependencies || []).map((d) => ({ ...d, status: (w.issues[d.id] || {}).status || 'closed' })) });

if (args[0] === 'list') {
  const label = flag('--label');
  let rows = Object.values(w.issues);
  if (label) rows = rows.filter((i) => (i.labels || []).includes(label));
  const parent = flag('--parent');
  if (parent) rows = rows.filter((i) => i.parent === parent);
  // \`--limit 1\` with no label is \`prefixFor\` asking what ids look like here.
  if (flag('--limit') === '1') rows = rows.slice(0, 1);
  process.stdout.write(JSON.stringify(rows.filter(live).map(hydrate)));
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([hydrate(issue)]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
if (args[0] === 'create') {
  w.next = (w.next || 0) + 1;
  const id = 'zz-q' + w.next;
  w.issues[id] = {
    id,
    title: flag('--title') || '',
    description: flag('--description') || '',
    notes: flag('--notes') || '',
    labels: flags('--label'),
    assignee: '',
    status: 'open',
    issue_type: flag('--type') || 'task',
    priority: Number(flag('--priority') || 2),
    dependencies: [],
    comments: [],
  };
  save();
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  const assignee = args.find((a) => a.startsWith('--assignee='));
  if (assignee) issue.assignee = assignee.slice('--assignee='.length);
  if (flag('--description') !== null) issue.description = flag('--description');
  if (flag('--notes') !== null) issue.notes = flag('--notes');
  if (flag('--title') !== null) issue.title = flag('--title');
  const add = flags('--add-label');
  const drop = flags('--remove-label');
  issue.labels = [...(issue.labels || []).filter((l) => !drop.includes(l)), ...add.filter((l) => !(issue.labels || []).includes(l))];
  save();
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
  (issue.dependencies = issue.dependencies || []).push({ id: args[3], dependency_type: 'blocks' });
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

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

/* ------------------------------------------------------------------- the world */

const delivery = (over = {}) => ({
  workspace: 'demo',
  bead: 'zz-work',
  repo: 'acme/widgets',
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  branch: 'bead/zz-work',
  base: 'main',
  method: 'merge',
  summary: 'Something small.',
  ...over,
});

const cardIssue = (id, d) => ({
  id,
  title: `Merge #${d.number}?`,
  description: deliveryBody(d),
  notes: '',
  assignee: '',
  labels: ['human', 'pr-delivery'],
  status: 'open',
  issue_type: 'task',
  dependencies: [],
  comments: [],
});

/**
 * The tracker as a delivery that could not merge leaves it — plus every bead that must
 * survive being nowhere near this pull request.
 *
 * `sibling` is a second card on the *same* pull request, which bc-8fyu made rarer and did
 * not make impossible: one becomes the queue entry and the other has to be *named*, since
 * two open beads about one pull request is a work bead that cannot close.
 */
const reset = ({ sibling = false, card = true } = {}) => {
  fs.rmSync(MERGE_SWEEPS_PATH, { force: true });
  const issues = {
    'zz-work': {
      id: 'zz-work',
      title: 'The work',
      description: '',
      notes: '',
      assignee: '',
      labels: [],
      status: 'in_progress',
      issue_type: 'task',
      dependencies: [],
      comments: [],
    },
    // Case 3: a different pull request, in the same repo, for a different bead.
    'zz-pr8': cardIssue('zz-pr8', delivery({ bead: 'zz-other', number: 8, url: 'https://github.com/acme/widgets/pull/8' })),
    // Case 3: #7, but somewhere else entirely.
    'zz-elsewhere': cardIssue('zz-elsewhere', delivery({ repo: 'acme/other', url: 'https://github.com/acme/other/pull/7' })),
    // Case 3: not a delivery at all.
    'zz-plain': {
      id: 'zz-plain',
      title: 'Which of these two?',
      description: 'An ordinary question.',
      notes: '',
      assignee: '',
      labels: ['human'],
      status: 'open',
      issue_type: 'task',
      dependencies: [],
      comments: [],
    },
  };
  if (card) {
    issues['zz-pr'] = cardIssue('zz-pr', delivery());
    issues['zz-work'].dependencies.push({ id: 'zz-pr', dependency_type: 'blocks' });
  }
  if (sibling) {
    issues['zz-sib'] = cardIssue('zz-sib', delivery());
    issues['zz-work'].dependencies.push({ id: 'zz-sib', dependency_type: 'blocks' });
  }
  writeWorld({ issues, next: 0 });
  fs.writeFileSync(BD_LOG, '');
  fs.writeFileSync(GH_LOG, '');
  fs.rmSync(OWED_PATH, { force: true });
  resetPRs();
};

/* ------------------------------------------------------------------ the daemon */

const beads = path.join(tmp, 'beads', 'demo', '.beads');
fs.mkdirSync(beads, { recursive: true });

const base = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'boardmerge-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [{ name: 'demo', dir: beads }],
  sessionDirs: { demo: repo },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
  pr: { base: 'main', mergeMethod: 'merge' },
};

const { createApp, listen } = await import(LIB('server.js'));

const cfg = { ...base, port: 0 };
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

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

const post = (pathname, body) => request('POST', pathname, body);

/* ------------------------------------------- the card that becomes a queue entry */

console.log('\nqueuing from the PR board\n');

{
  reset();
  const res = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('the tap is taken', res.status === 200, JSON.stringify(res.json));
  check('and it says it queued rather than merged', res.json.queued === true && res.json.action === 'admit', JSON.stringify(res.json));
  check('naming the bead the queue will act on', res.json.id === 'zz-pr', JSON.stringify(res.json));

  // Case 1, and the whole of the bead. Nothing merged, and nothing tried to.
  check('nothing was merged at GitHub', merges().length === 0, JSON.stringify(merges()));
  check('the pull request is still open', JSON.parse(fs.readFileSync(PR_STATE, 'utf8'))[0].state === 'OPEN');

  // Case 2. The card *is* the queue entry now — the inbox loses the question, and the
  // work bead is still parked behind the very same bead it was parked behind before.
  const entry = world().issues['zz-pr'];
  check('the card carries the queue label', (entry.labels || []).includes(MERGE_LABEL), JSON.stringify(entry.labels));
  check(
    'and no longer sits in the inbox as a question',
    !(entry.labels || []).includes('human') && !(entry.labels || []).includes('pr-delivery'),
    JSON.stringify(entry.labels)
  );
  check('it is assigned to the queue, which is what queueFor selects on', entry.assignee === MERGE_ASSIGNEE, entry.assignee);
  check('the card is not closed — nothing has merged yet', entry.status === 'open', entry.status);
  check('nor is the work bead', world().issues['zz-work'].status === 'in_progress', world().issues['zz-work'].status);
  check(
    'and it is still parked behind the same bead',
    (world().issues['zz-work'].dependencies || []).some((d) => d.id === 'zz-pr'),
    JSON.stringify(world().issues['zz-work'].dependencies)
  );

  // The approval, which is the one thing the queue cannot work out for itself — and the
  // reason it goes in `notes` rather than on a label is that `gateVerdict` reads it there,
  // GitHub having refused to let the author of a branch approve it.
  const state = queueState(entry);
  check('the approval is recorded in the queue block', state.approved === true, JSON.stringify(state));
  check('with who gave it', Boolean(state.approvedBy), JSON.stringify(state));
  check('and the attempt budget is reset, so a bead handed back is not handed straight back', state.attempts === 0 && !state.refused);

  check(
    'the thread says what happened and who said it could land',
    (entry.comments || []).some((c) => /approved this/.test(c)),
    JSON.stringify(entry.comments)
  );
  check(
    'and the pull request is told too, so the record is where the diff is',
    ghCalls().some((c) => c[0] === 'pr' && c[1] === 'comment'),
    ghCalls().map((c) => c.join(' ')).join(' | ')
  );

  // The three things this endpoint used to do afterwards. All of them belong to the
  // merge, and the merge has not happened — doing any of them here would be describing
  // something that is not true yet.
  check('no conflict sweep is asked for', Object.keys(readSweepRequests()).length === 0, JSON.stringify(readSweepRequests()));
  check('nothing is left owing', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));
  check(
    'nothing was closed',
    !bdCalls().some((c) => c[0] === 'close'),
    bdCalls().map((c) => c.join(' ')).join(' | ')
  );

  // Case 3, every direction at once.
  check('a card about another pull request is untouched', world().issues['zz-pr8'].status === 'open' && !(world().issues['zz-pr8'].labels || []).includes(MERGE_LABEL));
  check(
    'the same number in another repo is untouched',
    world().issues['zz-elsewhere'].status === 'open' && !(world().issues['zz-elsewhere'].labels || []).includes(MERGE_LABEL)
  );
  check('and a question that is not a delivery is untouched', world().issues['zz-plain'].status === 'open');
  check('nothing else was named as also open about it', (res.json.others || []).length === 0, JSON.stringify(res.json.others));
  // Read out of the card's own `beadpr` block, which is the session's word about what it
  // delivered — not the board's inference from a branch name.
  check('and the reply names the work bead the merge will close', res.json.bead === 'zz-work', JSON.stringify(res.json));
}

/* --------------------------------------------------- tapping it a second time */

console.log('\nwhen it is already on the queue\n');

{
  // Case 4. The lag is the whole reason this case exists: the queue's "is anything
  // waiting" read is cached, so a minute passes in which the board still draws the row as
  // open and a second tap is the natural thing to do. It must not re-arm anything, and it
  // must not report a move that nothing made.
  fs.writeFileSync(BD_LOG, '');
  const res = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('it is still a 200', res.status === 200, JSON.stringify(res.json));
  check('but it says the approval was recorded, not that anything moved', res.json.queued === false && res.json.action === 'approve', JSON.stringify(res.json));
  check('on the same bead', res.json.id === 'zz-pr', JSON.stringify(res.json));
  check('nothing was merged', merges().length === 0, JSON.stringify(merges()));
  check(
    'and no label was moved a second time',
    !bdCalls().some((c) => c.includes('--add-label') || c.includes('--remove-label')),
    bdCalls().map((c) => c.join(' ')).join(' | ')
  );
  check('the approval is still on the bead', queueState(world().issues['zz-pr']).approved === true);
}

/* ------------------------------------------ a pull request nothing is open about */

console.log('\nwhen nothing in the tracker is about it\n');

{
  // Adam opened the pull request himself, or its card was closed. There is nothing to
  // re-arm, so a queue entry is filed — the same bead `beadcause-deliver` files, built
  // from what GitHub says because there was no session to say it.
  reset({ card: false });
  const res = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('the tap is taken', res.status === 200, JSON.stringify(res.json));
  check('and a queue entry is filed', res.json.queued === true && res.json.action === 'file', JSON.stringify(res.json));
  check('nothing was merged', merges().length === 0, JSON.stringify(merges()));

  const filed = world().issues[res.json.id];
  check('the filed bead exists', Boolean(filed), JSON.stringify(Object.keys(world().issues)));
  check('carrying the queue label', (filed?.labels || []).includes(MERGE_LABEL), JSON.stringify(filed?.labels));
  check('and the queue assignee', filed?.assignee === MERGE_ASSIGNEE, filed?.assignee);
  check('with the approval on it', queueState(filed || {}).approved === true, filed?.notes);
  check('and a block naming the pull request it is about', /number:\s*7/.test(filed?.description || ''), (filed?.description || '').slice(0, 200));

  // The board resolves a bead from the pull request's own title and branch, and this is
  // the one place that inference is used — where by construction nothing open is about
  // this pull request, so it cannot pick the wrong card. It is what makes the merge close
  // the work rather than only its own entry.
  check('the work bead the board resolved is named on it', res.json.bead === 'zz-work', JSON.stringify(res.json));
  check(
    'and the work bead is parked behind the queue entry',
    (world().issues['zz-work'].dependencies || []).some((d) => d.id === res.json.id),
    JSON.stringify(world().issues['zz-work'].dependencies)
  );
  check('the work bead is not closed', world().issues['zz-work'].status === 'in_progress', world().issues['zz-work'].status);
}

/* ------------------------------------------- two open beads on one pull request */

console.log('\nwhen more than one bead is open about it\n');

{
  // Case 5. One of them becomes the queue entry; the other is a blocker on the work bead
  // that nobody is looking at. `beadcause-merge` prints it to stderr — the phone gets it
  // in the reply, because the alternative is a work bead that silently cannot close.
  reset({ sibling: true });
  const res = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('the tap is taken', res.status === 200, JSON.stringify(res.json));
  check('one of them becomes the queue entry', (world().issues[res.json.id].labels || []).includes(MERGE_LABEL));
  const other = res.json.id === 'zz-pr' ? 'zz-sib' : 'zz-pr';
  check('the other is named in the reply', (res.json.others || []).includes(other), JSON.stringify(res.json.others));
  check('and is left exactly as it was, rather than quietly closed', world().issues[other].status === 'open', world().issues[other].status);
}

/* ------------------------------------------------------- what it refuses outright */

console.log('\nwhat it will not queue\n');

{
  reset();
  // A merged pull request is not an error. "It is already in" is the outcome the tap
  // wanted, arrived at without it, and a 409 over work that is in `main` would send
  // somebody to GitHub to find out that nothing is wrong.
  resetPRs({ state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: HEAD } });
  const merged = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('an already-merged pull request is a plain 200', merged.status === 200, JSON.stringify(merged.json));
  check('saying so, and queuing nothing', merged.json.alreadyMerged === true && merged.json.queued === false, JSON.stringify(merged.json));
  check('and the card is left alone', world().issues['zz-pr'].status === 'open' && !(world().issues['zz-pr'].labels || []).includes(MERGE_LABEL));

  // A draft is refused *here*, with the sentence, rather than by the queue an hour later.
  reset();
  resetPRs({ isDraft: true });
  const draft = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('a draft is refused', draft.status === 409, JSON.stringify(draft.json));
  check('with a sentence saying why', /draft/.test(draft.json.error || ''), JSON.stringify(draft.json));
  check('and nothing was written to the tracker', !(world().issues['zz-pr'].labels || []).includes(MERGE_LABEL), JSON.stringify(world().issues['zz-pr'].labels));

  reset();
  resetPRs({ state: 'CLOSED' });
  const closed = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('a closed pull request that never merged is refused', closed.status === 409, JSON.stringify(closed.json));
  check('with a sentence saying why', /closed/.test(closed.json.error || ''), JSON.stringify(closed.json));
}

for (const s of servers) s.close?.();
if (servers[0]?.front) servers[0].front.close?.();
await cleanupTmp(tmp);
console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall ${ran} passed\n`);
process.exit(failures ? 1 : 0);
