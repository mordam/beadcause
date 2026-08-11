#!/usr/bin/env node
/**
 * **The close a merge owes** — answered on the phone, refused by bd, kept until it can.
 *
 *     npm test
 *     node test/mergeclose.mjs
 *
 * Tapping **Merge** on a delivery card does two things: it merges the pull request,
 * and it closes the work bead, because the merge is what makes the work finished. The
 * second one had never worked. `bin/deliver.js` parks the work bead behind the card —
 * so the advocate does not open a second session onto work already in a pull request —
 * and bd refuses to close an issue with an open blocker. The card doing the blocking is
 * the card being answered, and it does not close until after the merge has run. So the
 * close was refused *every time*, and the refusal was a `console.error` under a note
 * that said "Merged #25 — closed bc-ec6".
 *
 * bc-ec6 was answered twice, on two cards a re-delivery had filed, and both answers
 * carried that sentence. The bead was open the whole time.
 *
 * Four failures are worth this file:
 *
 * 1. **A card claiming a close that was refused.** The one that costs hours later: the
 *    thread says the work is finished and the tracker says it is not, and there is
 *    nothing on either to say which is true.
 * 2. **The merge not closing the work bead at all.** The ordinary case has to work
 *    without any retry: drop the answered card's own edge, then close.
 * 3. **A retry that never comes.** A close bd genuinely refuses — a second card, an
 *    unrelated blocker — has to be written down and tried again when the gate clears,
 *    or the bead sits open over merged work forever.
 * 4. **A retry that closes the wrong thing.** The sweep runs unattended on every poll.
 *    A record whose bead is still blocked, already closed, or gone has to end quietly
 *    and correctly, and only a genuinely clear gate may lead to a `bd close`.
 *
 * The delivery card, the merge and the work bead are real code paths — a real
 * `POST /api/respond` through `createApp`, with `bd` and `gh` as fakes. The sweep is
 * driven directly, because what it is a claim about is the tracker, not the clock.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-mergeclose-'));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { cardsForRequest, deliveryBody } = await import(LIB('delivery.js'));
const { Bd } = await import(LIB('bd.js'));
const { readOwed, oweClose, sweepOwed, OWED_PATH } = await import(LIB('owed.js'));

/* ------------------------------------------------------------ which card is which */

console.log('\nfinding the cards already open on a pull request\n');

const card = (id, over = {}) => ({
  id,
  status: 'open',
  title: `Merge #${over.number ?? 7}?`,
  description: deliveryBody({
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
  }),
});

{
  const rows = [
    card('zz-1'),
    card('zz-2', { number: 8, url: 'https://github.com/acme/widgets/pull/8' }),
    card('zz-3', { repo: 'acme/other', url: 'https://github.com/acme/other/pull/7' }),
    { ...card('zz-4'), status: 'closed' },
    { id: 'zz-5', status: 'open', title: 'An ordinary question', description: 'Which of these two?' },
  ];
  const found = cardsForRequest(rows, { repo: 'acme/widgets', number: 7 }).map((c) => c.id);
  check('the card for this pull request is found', found.includes('zz-1'), found.join(','));
  check('another number is not this one', !found.includes('zz-2'), found.join(','));
  check('the same number in another repo is not this one', !found.includes('zz-3'), found.join(','));
  check('a card already closed is not open', !found.includes('zz-4'), found.join(','));
  check('a question that is not a delivery at all is left out', !found.includes('zz-5'), found.join(','));
  check('and it carries the work bead the card names', cardsForRequest(rows, { repo: 'acme/widgets', number: 7 })[0]?.bead === 'zz-work');
}

{
  // A repo this delivery could not name — `pr.slugFor` answers null in a checkout with
  // no GitHub remote — falls back to the number, which is the older behaviour.
  const found = cardsForRequest([card('zz-1')], { repo: '', number: 7 }).map((c) => c.id);
  check('an unknown repo still matches on the number', found.join(',') === 'zz-1', found.join(','));
  check('and a number that is not a number matches nothing', cardsForRequest([card('zz-1')], { number: 0 }).length === 0);
}

/* ---------------------------------------------------------------- the fake bd */

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
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const hydrate = (i) => ({ ...i, dependencies: (i.dependencies || []).map((d) => ({ ...d, status: (w.issues[d.id] || {}).status || 'closed' })) });

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

/* ---------------------------------------------------------------- the fake gh */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const PR_STATE = path.join(tmp, 'pr.json');
const rawPR = () => ({
  number: 7,
  title: 'Something small',
  url: 'https://github.com/acme/widgets/pull/7',
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
});
fs.writeFileSync(PR_STATE, JSON.stringify(rawPR()));

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (args[0] === 'auth') out('Logged in to github.com\\n');
if (args[0] === 'pr') {
  const pr = JSON.parse(fs.readFileSync(${JSON.stringify(PR_STATE)}, 'utf8'));
  if (args[1] === 'view') out(JSON.stringify(pr));
  if (args[1] === 'merge') {
    pr.state = 'MERGED';
    pr.mergedAt = '2026-08-10T12:00:00Z';
    pr.mergeCommit = { oid: 'c5004cceabcdef01' };
    fs.writeFileSync(${JSON.stringify(PR_STATE)}, JSON.stringify(pr));
    out('Merged pull request #7\\n');
  }
  if (args[1] === 'comment' || args[1] === 'close') out('done\\n');
}
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

/* ------------------------------------------------------------------ the daemon */

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });

const cfgBase = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'mergeclose-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [{ name: 'demo', dir: wsDir }],
  sessionDirs: { demo: wsDir },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});
const cfg = { ...cfgBase, port };
const app = createApp(cfg);
const servers = listen(cfg, app.handler);

const post = (pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });

for (let i = 0; i < 100; i += 1) {
  try {
    await post('/api/nothing', {});
    break;
  } catch {
    await sleep(20);
  }
}

const DELIVERY = {
  workspace: 'demo',
  bead: 'zz-work',
  repo: 'acme/widgets',
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  branch: 'bead/zz-work',
  base: 'main',
  method: 'merge',
  summary: 'Something small.',
};

/** The tracker as a delivery leaves it: a card, a work bead, and the edge between them. */
const reset = ({ sibling = false } = {}) => {
  const issues = {
    'zz-pr': {
      id: 'zz-pr',
      title: 'Merge #7?',
      description: deliveryBody(DELIVERY),
      labels: ['human', 'pr-delivery'],
      status: 'open',
      issue_type: 'task',
      dependencies: [],
      comment_count: 0,
    },
    'zz-work': {
      id: 'zz-work',
      title: 'The work',
      description: '',
      labels: [],
      status: 'in_progress',
      issue_type: 'task',
      dependencies: [{ id: 'zz-pr', dependency_type: 'blocks' }],
    },
  };
  if (sibling) {
    issues['zz-sib'] = {
      id: 'zz-sib',
      title: 'Merge #7?',
      description: deliveryBody(DELIVERY),
      labels: ['human', 'pr-delivery'],
      status: 'open',
      issue_type: 'task',
      dependencies: [],
      comment_count: 0,
    };
    issues['zz-work'].dependencies.push({ id: 'zz-sib', dependency_type: 'blocks' });
  }
  writeWorld({ issues });
  fs.writeFileSync(BD_LOG, '');
  fs.writeFileSync(PR_STATE, JSON.stringify(rawPR()));
  fs.rmSync(OWED_PATH, { force: true });
};

const MERGE = 'MERGE: merge #7, then close zz-work.';

console.log('\nmerging from the phone\n');

/* --------------------------------------------------- the ordinary single card */

{
  reset();
  const res = await post('/api/respond', { workspace: 'demo', id: 'zz-pr', response: MERGE });
  check('the answer is taken', res.status === 200, JSON.stringify(res.json));
  check(
    'the card’s own edge is dropped, because it is being answered',
    bdCalls().some((c) => c.slice(0, 4).join(' ') === 'dep remove zz-work zz-pr'),
    bdCalls().map((c) => c.join(' ')).join(' | ')
  );
  check('the work bead closes with the merge', world().issues['zz-work'].status === 'closed', world().issues['zz-work'].status);
  check(
    'and the close reason names the pull request',
    /#7/.test(world().issues['zz-work'].close_reason || ''),
    world().issues['zz-work'].close_reason
  );
  check(
    'the thread says it closed it',
    (world().issues['zz-pr'].comments || []).some((c) => /closed zz-work/.test(c)),
    JSON.stringify(world().issues['zz-pr'].comments)
  );
  check('nothing is left owing', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));
}

/* ------------------------------------------ the sibling card, which is the bug */

{
  reset({ sibling: true });
  const res = await post('/api/respond', { workspace: 'demo', id: 'zz-pr', response: MERGE });
  check('the answer is still taken — the merge happened', res.status === 200, JSON.stringify(res.json));
  check('and the pull request really merged', JSON.parse(fs.readFileSync(PR_STATE, 'utf8')).state === 'MERGED');
  check('the work bead is still open, because bd refused', world().issues['zz-work'].status !== 'closed', world().issues['zz-work'].status);

  const answer = (world().issues['zz-pr'].comments || []).join('\n');
  check('the card does not claim a close that did not happen', !/— closed zz-work/.test(answer), answer);
  check('it says which bead is still open', /zz-work is still open/.test(answer), answer);
  check('and names what is holding it', /zz-sib/.test(answer), answer);

  const owed = readOwed();
  check('the close is written down', Boolean(owed['demo/zz-work']), JSON.stringify(owed));
  check('with the reason it will carry when it goes through', /#7/.test(owed['demo/zz-work']?.reason || ''), owed['demo/zz-work']?.reason);

  /* ------------------------------------------------------------- and the retry */

  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  let swept = await sweepOwed(bd, cfg.workspaces);
  check('while the sibling is open, the sweep leaves it alone', swept[0]?.status === 'blocked', JSON.stringify(swept));
  check('and keeps the record', Boolean(readOwed()['demo/zz-work']), JSON.stringify(readOwed()));

  // The sibling is answered a minute later, which is exactly what happened to bc-ec6.
  const w = world();
  w.issues['zz-sib'].status = 'closed';
  writeWorld(w);

  swept = await sweepOwed(bd, cfg.workspaces);
  check('once its last blocker closes, the retry closes it', swept[0]?.status === 'closed', JSON.stringify(swept));
  check('the work bead is finally closed', world().issues['zz-work'].status === 'closed', world().issues['zz-work'].status);
  check(
    'with the reason written down at the merge, not a generic one',
    /Merged #7 as c5004cce/.test(world().issues['zz-work'].close_reason || ''),
    world().issues['zz-work'].close_reason
  );
  check('and the record is gone', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));
}

/* ------------------------------------------------- what the sweep must not do */

console.log('\nthe retry, unattended\n');

{
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

  reset();
  const w = world();
  w.issues['zz-work'].status = 'closed';
  w.issues['zz-work'].dependencies = [];
  writeWorld(w);
  oweClose({ workspace: 'demo', id: 'zz-work', reason: 'Merged #7', why: 'blocked by zz-sib' });
  const swept = await sweepOwed(bd, cfg.workspaces);
  check('a bead somebody else closed is forgotten, not closed again', swept[0]?.status === 'already', JSON.stringify(swept));
  check('and the record goes with it', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));
}

{
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  oweClose({ workspace: 'demo', id: 'zz-vanished', reason: 'Merged #7' });
  const swept = await sweepOwed(bd, cfg.workspaces);
  check('a bead bd has never heard of is dropped', swept[0]?.status === 'gone', JSON.stringify(swept));
  check('and nothing is left owing it', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));
}

{
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  oweClose({ workspace: 'nowhere', id: 'qq-1', reason: 'Merged #7' });
  const swept = await sweepOwed(bd, cfg.workspaces);
  check('a workspace this daemon does not serve is skipped, not acted on', swept.length === 0, JSON.stringify(swept));
  check('and its record is kept for the daemon that does', Boolean(readOwed()['nowhere/qq-1']), JSON.stringify(readOwed()));
  fs.rmSync(OWED_PATH, { force: true });
}

{
  oweClose({ workspace: 'demo', id: 'zz-work', reason: 'first', why: 'one' });
  oweClose({ workspace: 'demo', id: 'zz-work', reason: 'second', why: 'two' });
  const owed = readOwed();
  check('owing the same bead twice updates rather than duplicates', Object.keys(owed).length === 1, JSON.stringify(owed));
  check('and the newer reason wins', owed['demo/zz-work'].reason === 'second', JSON.stringify(owed));
  fs.rmSync(OWED_PATH, { force: true });
}

{
  fs.writeFileSync(OWED_PATH, '{ this is not json');
  check('an unreadable ledger reads as nothing owed', Object.keys(readOwed()).length === 0);
  fs.rmSync(OWED_PATH, { force: true });
}

for (const s of servers) s.close?.();
if (servers[0]?.front) servers[0].front.close?.();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall ${ran} passed\n`);
process.exit(failures ? 1 : 0);
