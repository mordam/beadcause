#!/usr/bin/env node
/**
 * **Merging on the PR board** — and the inbox card it spends.
 *
 *     npm test
 *     node test/boardmerge.mjs
 *
 * `test/mergeclose.mjs` proves the merge that *answers* a card: a tap on "Merge #7?"
 * in the inbox merges the pull request and closes the work bead. This is the same
 * merge from the other screen. /prs is a board of every repo's pull requests, and its
 * Merge button goes straight to `gh` — so a delivery that could not merge itself, and
 * therefore filed a card, was merged there and left the card sitting in the inbox: an
 * open `human` bead asking whether to merge something that is already in `main`.
 *
 * Answering it afterwards was harmless — `pr.merge` reports `alreadyMerged` and the
 * respond path carries on — but it is a question already answered, in the one list
 * whose whole premise is that everything in it needs you.
 *
 * Four failures are worth the file:
 *
 * 1. **The card surviving the merge.** The bug itself. A merge on /prs has to leave
 *    the inbox with nothing in it about #N, and it has to close the work bead behind
 *    the card too — a card closed over a work bead still `in_progress` just moves the
 *    stale row from one screen to another.
 * 2. **Closing a card that is still a real question.** The dangerous direction, and
 *    invisible unless it is asserted: merging #7 must not touch a card about #8, a
 *    card in another repo, or an ordinary question that is not a delivery at all.
 *    `cardsForDelivery` is deliberately called here *without* a bead, because matching
 *    on the work bead — which is right for a re-delivery — would close the card for a
 *    second, still-open pull request against the same bead.
 * 3. **An answer nobody typed.** The card is *closed*, with a reason naming where the
 *    merge happened. Nothing may write `MERGE:` into the thread under Adam's name: he
 *    merged a pull request, which is a fact, and the card is spent because of that
 *    fact rather than because it was answered.
 * 4. **A refused close swallowed.** Same discipline as every other merge here — the
 *    pull request is already merged at GitHub, no bead refusing to close can make that
 *    untrue, so the endpoint still answers 200 and what is owed goes to lib/owed.js.
 *
 * A real git repo with a real `origin` (the board's lamps are ancestry questions), a
 * fake `gh`, and a fake `bd` that enforces bd's own rule about closing a bead with an
 * open blocker — which is the rule the whole card/work-bead dance exists for.
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

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

/** The two pull requests: #7 is the one being merged, #8 is the one that must survive. */
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

const resetPRs = () =>
  fs.writeFileSync(
    PR_STATE,
    JSON.stringify([rawPR(), rawPR({ number: 8, url: 'https://github.com/acme/widgets/pull/8', title: 'zz-other: later' })])
  );
resetPRs();

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const STATE = ${JSON.stringify(PR_STATE)};
const args = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
if (args[0] === 'auth' && args[1] === 'status') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/widgets' }));
if (args[0] === 'pr' && args[1] === 'list') out(JSON.stringify(load()));
if (args[0] === 'pr' && args[1] === 'view') {
  const n = Number(args[2]);
  const pr = load().find((p) => p.number === n);
  if (!pr) { process.stderr.write('no pull requests found for ' + args[2] + '\\n'); process.exit(1); }
  out(JSON.stringify(pr));
}
if (args[0] === 'pr' && args[1] === 'merge') {
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
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const live = (i) => i.status !== 'closed';
const hydrate = (i) => ({ ...i, dependencies: (i.dependencies || []).map((d) => ({ ...d, status: (w.issues[d.id] || {}).status || 'closed' })) });

if (args[0] === 'list') {
  const label = flag('--label');
  let rows = Object.values(w.issues);
  if (label) rows = rows.filter((i) => (i.labels || []).includes(label));
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
if (args[0] === 'dep' && args[1] === 'remove') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  const before = (issue.dependencies || []).length;
  issue.dependencies = (issue.dependencies || []).filter((d) => d.id !== args[3]);
  if (issue.dependencies.length === before) die('no dependency ' + args[3] + ' on ' + args[2]);
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
  labels: ['human', 'pr-delivery'],
  status: 'open',
  issue_type: 'task',
  dependencies: [],
  comments: [],
});

/**
 * The tracker as a delivery that could not merge leaves it — plus every card that
 * must survive the merge.
 *
 * `sibling` is a second card on the *same* pull request, which bc-8fyu made rarer and
 * did not make impossible. `blocker` is an unrelated open bead the work bead waits on,
 * which is the one thing here that can genuinely refuse a close.
 */
const reset = ({ sibling = false, blocker = false } = {}) => {
  fs.rmSync(MERGE_SWEEPS_PATH, { force: true });
  const issues = {
    'zz-pr': cardIssue('zz-pr', delivery()),
    // Case 2: a different pull request, in the same repo, for a different bead.
    'zz-pr8': cardIssue('zz-pr8', delivery({ bead: 'zz-other', number: 8, url: 'https://github.com/acme/widgets/pull/8' })),
    // Case 2: #7, but somewhere else entirely.
    'zz-elsewhere': cardIssue('zz-elsewhere', delivery({ repo: 'acme/other', url: 'https://github.com/acme/other/pull/7' })),
    // Case 2: not a delivery at all.
    'zz-plain': {
      id: 'zz-plain',
      title: 'Which of these two?',
      description: 'An ordinary question.',
      labels: ['human'],
      status: 'open',
      issue_type: 'task',
      dependencies: [],
      comments: [],
    },
    'zz-work': {
      id: 'zz-work',
      title: 'The work',
      description: '',
      labels: [],
      status: 'in_progress',
      issue_type: 'task',
      dependencies: [{ id: 'zz-pr', dependency_type: 'blocks' }],
      comments: [],
    },
  };
  if (sibling) {
    issues['zz-sib'] = cardIssue('zz-sib', delivery());
    issues['zz-work'].dependencies.push({ id: 'zz-sib', dependency_type: 'blocks' });
  }
  if (blocker) {
    issues['zz-dep'] = {
      id: 'zz-dep',
      title: 'Something else entirely',
      description: '',
      labels: [],
      status: 'open',
      issue_type: 'task',
      dependencies: [],
      comments: [],
    };
    issues['zz-work'].dependencies.push({ id: 'zz-dep', dependency_type: 'blocks' });
  }
  writeWorld({ issues });
  fs.writeFileSync(BD_LOG, '');
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

/* ------------------------------------------------- the merge that spends a card */

console.log('\nmerging on the PR board\n');

{
  reset();
  const res = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('the merge is taken', res.status === 200, JSON.stringify(res.json));
  check('and the pull request really merged', JSON.parse(fs.readFileSync(PR_STATE, 'utf8'))[0].state === 'MERGED');

  // bc-9d37.4. #8 is still open against the same base and is now measured against a base
  // it has never seen. Recorded rather than swept here — the sweep opens resolver windows
  // and the registry that caps them is the daemon's, reached from the poll cycle — so
  // this endpoint answers when the merge is done and not when a window has opened.
  const asked = readSweepRequests();
  check('the conflict sweep is asked for', Object.keys(asked).length === 1, JSON.stringify(asked));
  check('naming the repo and the merge that set it off', asked.demo?.key === 'demo' && asked.demo?.number === 7, JSON.stringify(asked.demo));

  check('the card for that pull request is closed', world().issues['zz-pr'].status === 'closed', world().issues['zz-pr'].status);
  check(
    'and its close reason says where the merge happened',
    /Merged #7 .*from the PR board/.test(world().issues['zz-pr'].close_reason || ''),
    world().issues['zz-pr'].close_reason
  );
  check(
    'the thread says the same, so a reader of the bead is not left guessing',
    (world().issues['zz-pr'].comments || []).some((c) => /from the PR board/.test(c)),
    JSON.stringify(world().issues['zz-pr'].comments)
  );

  // Case 3. `MERGE:` is the marker the phone sends and the one thing that means
  // consent; nothing on this path may write it on Adam's behalf.
  const wrote = (world().issues['zz-pr'].comments || []).join('\n');
  check('nothing answered the card on his behalf', !/MERGE:/.test(wrote), wrote);
  check(
    'and no `respond` was called on it',
    !bdCalls().some((c) => c[0] === 'respond'),
    bdCalls().map((c) => c.join(' ')).join(' | ')
  );

  // Case 1's second half: a closed card over an open work bead is the same stale row
  // on a different screen.
  check(
    'the card’s own edge is dropped, because it is what blocks the work bead',
    bdCalls().some((c) => c.slice(0, 4).join(' ') === 'dep remove zz-work zz-pr'),
    bdCalls().map((c) => c.join(' ')).join(' | ')
  );
  check('the work bead closes with it', world().issues['zz-work'].status === 'closed', world().issues['zz-work'].status);
  check(
    'and its close reason names the pull request',
    /Merged #7/.test(world().issues['zz-work'].close_reason || ''),
    world().issues['zz-work'].close_reason
  );
  check('nothing is left owing', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));

  // Case 2, every direction at once.
  check('a card about another pull request is untouched', world().issues['zz-pr8'].status === 'open', world().issues['zz-pr8'].status);
  check(
    'the same number in another repo is untouched',
    world().issues['zz-elsewhere'].status === 'open',
    world().issues['zz-elsewhere'].status
  );
  check('and a question that is not a delivery is untouched', world().issues['zz-plain'].status === 'open', world().issues['zz-plain'].status);

  // What the board tells the phone it did, which is what the toast on /prs reads.
  const closed = (res.json.cards || []).filter((c) => c.closed);
  check('the response says which card it retired', closed.map((c) => c.id).join(',') === 'zz-pr', JSON.stringify(res.json.cards));
  check('and that the work bead went with it', closed[0]?.work?.closed === true, JSON.stringify(res.json.cards));
}

/* ------------------------------- merging again, over a card that is already gone */

{
  // The other half of the same screen: /prs will happily offer Merge on a row it
  // drew a minute ago, and pressing it on an already-merged pull request must be an
  // ordinary success rather than an error over work that is in `main`.
  const res = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('merging an already-merged pull request is still a 200', res.status === 200, JSON.stringify(res.json));
  check('it says so', res.json.alreadyMerged === true, JSON.stringify(res.json));
  check('and there is no card left to retire', (res.json.cards || []).length === 0, JSON.stringify(res.json.cards));
}

/* --------------------------------------------- two cards on one pull request */

console.log('\nwhen more than one card is open on it\n');

{
  // bc-8fyu made this rare rather than impossible: a re-delivery nobody answered used
  // to file a second card against the same pull request. The board is better placed
  // than the inbox here — a tap answers the one card under your thumb, and a merge is
  // about the pull request, so it spends *every* card asking about it. Which means the
  // work bead's first close is refused (the second card is still open and blocking it)
  // and the second goes through, without anything having to be answered twice.
  reset({ sibling: true });
  const res = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('the merge is taken', res.status === 200, JSON.stringify(res.json));
  check('both cards are closed', world().issues['zz-pr'].status === 'closed' && world().issues['zz-sib'].status === 'closed');
  check('and the work bead closes once the last one is gone', world().issues['zz-work'].status === 'closed', world().issues['zz-work'].status);
  check(
    'the response reports both, and which one carried the work bead',
    (res.json.cards || []).length === 2 && (res.json.cards || []).filter((c) => c.work?.closed).length === 1,
    JSON.stringify(res.json.cards)
  );
  // The first card's close was refused and written down; the second one's went
  // through. A ledger still owing a bead that is closed would be swept away as
  // `already` eventually, and "eventually" is not a reason to write something untrue.
  check('and nothing is left owing a bead that closed', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));
}

/* ------------------------------------------- a work bead bd refuses to close yet */

console.log('\nwhen the work bead cannot close\n');

{
  // Case 4. Not another card this time — an ordinary open dependency, which nothing
  // here has any business dropping. The merge stands, the card goes, and the close is
  // owed rather than claimed: a card saying it closed a bead that is open is how
  // bc-ec6 ended up with two answers over one unfinished bead.
  reset({ blocker: true });
  const res = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('the merge is still taken — it already happened at GitHub', res.status === 200, JSON.stringify(res.json));
  check('the card is closed', world().issues['zz-pr'].status === 'closed', world().issues['zz-pr'].status);
  check(
    'the work bead is not, because something unrelated still blocks it',
    world().issues['zz-work'].status !== 'closed',
    world().issues['zz-work'].status
  );
  check(
    'and the response does not claim a close that was refused',
    (res.json.cards || [])[0]?.work?.closed === false,
    JSON.stringify(res.json.cards)
  );
  check(
    'the blocker is named, rather than the refusal being swallowed',
    /zz-dep/.test((res.json.cards || [])[0]?.work?.why || ''),
    JSON.stringify(res.json.cards)
  );

  const owed = readOwed();
  check('the close is written down for the retry', Boolean(owed['demo/zz-work']), JSON.stringify(owed));
  check('with the reason it will carry when it goes through', /#7/.test(owed['demo/zz-work']?.reason || ''), owed['demo/zz-work']?.reason);
}

/* ----------------------------------------------- a repo with nothing in the inbox */

{
  // The ordinary case, and the one that must cost nothing: a pull request nobody
  // filed a card for. Merging it writes to the tracker not at all.
  reset();
  const w = world();
  delete w.issues['zz-pr'];
  w.issues['zz-work'].dependencies = [];
  writeWorld(w);
  fs.writeFileSync(BD_LOG, '');

  const res = await post('/api/pr/merge', { workspace: 'demo', number: 7 });
  check('a merge with no card behind it is a plain merge', res.status === 200, JSON.stringify(res.json));
  check('nothing is retired', (res.json.cards || []).length === 0, JSON.stringify(res.json.cards));
  check(
    'and nothing is closed or commented on',
    !bdCalls().some((c) => ['close', 'comment', 'dep'].includes(c[0])),
    bdCalls().map((c) => c.join(' ')).join(' | ')
  );
  check('the work bead is left exactly as it was', world().issues['zz-work'].status === 'in_progress', world().issues['zz-work'].status);
}

for (const s of servers) s.close?.();
if (servers[0]?.front) servers[0].front.close?.();
await cleanupTmp(tmp);
console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall ${ran} passed\n`);
process.exit(failures ? 1 : 0);
