#!/usr/bin/env node
/**
 * **The delivery card's Merge tap queues rather than merges** (bc-xl7n.135) — and **the
 * close a queue's own merge owes**, answered on the phone, refused by bd, kept until it
 * can.
 *
 *     npm test
 *     node test/mergeclose.mjs
 *
 * Tapping **Merge** on a delivery card used to be `pr.merge` straight through — no
 * downmerge, no baseline comparison, no one-at-a-time, and no record anywhere that Adam
 * had decided anything. bc-xl7n.135 measured what that cost: this exact tap merged a
 * four-day-red branch past a check its own branch had broken and turned `main` red for
 * the whole repo. So it no longer merges — it admits the pull request to the merge queue,
 * the same decision `admitPlan` makes for `beadcause-merge` and the PR board's own button
 * (bc-02ldo). The **first three sections** below are that: what the tap now does instead
 * of merging, and to which bead.
 *
 * The **last two sections** are the failure this file was originally written for, and it
 * still happens — just one step later, on the merge the *queue* makes rather than the one
 * this tap used to. `bin/deliver.js` parks the work bead behind the merge-bead, and bd
 * refuses to close an issue with an open blocker — so a work bead with a second open
 * blocker beside the one that just merged is refused, has to be written down, and retried
 * once the gate clears. bc-ec6 was answered twice, on two cards a re-delivery had filed,
 * and the bead was open the whole time. `lib/owed.js`'s retry is what those sections drive
 * directly, seeded by hand — what it is a claim about is the tracker, not the clock, and
 * not the tap that put a bead there.
 *
 * The delivery card and the queue entry it becomes are real code paths — a real
 * `POST /api/respond` through `createApp`, with `bd` and `gh` as fakes.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

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

const { cardsForDelivery, deliveryBody } = await import(LIB('delivery.js'));
const { Bd } = await import(LIB('bd.js'));
const { readOwed, oweClose, sweepOwed, OWED_PATH } = await import(LIB('owed.js'));
const { isClaimGuard } = await import(LIB('bd.js'));
const { readSweepRequests, MERGE_SWEEPS_PATH } = await import(LIB('mergesweep.js'));
const { MERGE_ASSIGNEE, MERGE_LABEL, queueState, withQueueBlock, mergeBeadBody } = await import(LIB('mergebead.js'));

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
  const found = cardsForDelivery(rows, { repo: 'acme/widgets', number: 7 }).map((c) => c.id);
  check('the card for this pull request is found', found.includes('zz-1'), found.join(','));
  check('another number is not this one', !found.includes('zz-2'), found.join(','));
  check('the same number in another repo is not this one', !found.includes('zz-3'), found.join(','));
  check('a card already closed is not open', !found.includes('zz-4'), found.join(','));
  check('a question that is not a delivery at all is left out', !found.includes('zz-5'), found.join(','));
  check('and it carries the work bead the card names', cardsForDelivery(rows, { repo: 'acme/widgets', number: 7 })[0]?.bead === 'zz-work');
}

{
  // A repo this delivery could not name — `pr.slugFor` answers null in a checkout with
  // no GitHub remote — falls back to the number, which is the older behaviour.
  const found = cardsForDelivery([card('zz-1')], { repo: '', number: 7 }).map((c) => c.id);
  check('an unknown repo still matches on the number', found.join(',') === 'zz-1', found.join(','));
  check('and a number that is not a number matches nothing', cardsForDelivery([card('zz-1')], { number: 0 }).length === 0);
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
const flags = (n) => args.map((a, i) => (a === n ? args[i + 1] : null)).filter((v) => v !== null);
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const hydrate = (i) => ({ ...i, dependencies: (i.dependencies || []).map((d) => ({ ...d, status: (w.issues[d.id] || {}).status || 'closed' })) });

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([hydrate(issue)]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
// \`bd.listLive\` — every issue, hydrated the same way \`show\` is. Not for
// \`--parent\` reads (bd's own children lookup, used elsewhere in the answer path):
// those fall through to the catch-all below, unanswered, exactly as before this file
// started driving \`admitDeliveryToQueue\`.
if (args[0] === 'list' && !args.includes('--parent')) {
  process.stdout.write(JSON.stringify(Object.values(w.issues).map(hydrate)));
  process.exit(0);
}
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
  const add = flags('--add-label');
  const drop = flags('--remove-label');
  if (add.length || drop.length) {
    issue.labels = [...(issue.labels || []).filter((l) => !drop.includes(l)), ...add.filter((l) => !(issue.labels || []).includes(l))];
  }
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
if (args[0] === 'close') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  const forced = args.includes('--force') || args.includes('-f');
  const open = (issue.dependencies || [])
    .filter((d) => d.dependency_type === 'blocks')
    .filter((d) => ((w.issues[d.id] || {}).status || 'closed') !== 'closed')
    .map((d) => d.id);
  if (open.length && !forced) die('cannot close ' + issue.id + ': blocked by open issues [' + open.join(' ') + '] (use --force to override)');
  // bd 1.2.1's claim guard, quoted from the real binary (bc-9d37.13). It is here rather
  // than in the assertions because it is the *binary's* behaviour, and the point of the
  // cases below is that beadcause's own code copes with it. --force lifts it, which was
  // measured against bd 1.2.1 rather than read out of --help, where it is undocumented.
  const assignee = issue.assignee || '';
  const actor = flag('--actor') || '';
  if (assignee && actor && assignee !== actor && !forced) {
    die('cannot close ' + issue.id + ': assignee is "' + assignee + '", actor is "' + actor + '"; reclaim or use --force to override');
  }
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
const GH_LOG = path.join(tmp, 'gh-calls.log');
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
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + '\\n');
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

const ghCalls = () =>
  fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const merges = () => ghCalls().filter((c) => c[0] === 'pr' && c[1] === 'merge');

/* ------------------------------------------------------------------ the daemon */

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });

const SESSIONS = path.join(tmp, 'claude', 'sessions');
const PROJECTS = path.join(tmp, 'claude', 'projects', '-demo-widgets');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });

/** The window a worker left behind: idle, named `QUEUED-`, waiting to hear it landed. */
const queuedWindow = () => {
  fs.writeFileSync(
    path.join(SESSIONS, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: 'sess-mergeclose',
      name: 'QUEUED-Demo - zz-work the work',
      cwd: '/demo/widgets',
      status: 'idle',
      statusUpdatedAt: Date.now(),
    })
  );
  fs.writeFileSync(path.join(PROJECTS, 'sess-mergeclose.jsonl'), '{"type":"user"}\n');
};
const windowName = () => JSON.parse(fs.readFileSync(path.join(SESSIONS, `${process.pid}.json`), 'utf8')).name;

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
  // A scratch `~/.claude` rather than `claudeSessions: false`, because one of the things
  // the tap owes is a rename of the window that delivered this — lib/retitle.js. Pointed
  // at the tmp tree so it can never reach a real window on this Mac.
  claudeSessionsDir: SESSIONS,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));

const cfg = { ...cfgBase, port: 0 };
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

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

/**
 * The tracker as a delivery leaves it: a card and a work bead parked behind it.
 *
 * `sibling` is a second delivery card on the *same* pull request — bc-8fyu made this
 * rare rather than impossible. `already` is the queue's own bead for this pull request,
 * raised or handed back once already (`isMergeBead`, lib/mergebead.js) — the case where
 * this tap is recording an approval on something rather than moving anything.
 */
const reset = ({ sibling = false, already = false } = {}) => {
  fs.rmSync(MERGE_SWEEPS_PATH, { force: true });
  const workDeps = [{ id: 'zz-pr', dependency_type: 'blocks' }];
  const issues = {
    'zz-pr': {
      id: 'zz-pr',
      title: 'Merge #7?',
      description: deliveryBody(DELIVERY),
      notes: '',
      labels: ['human', 'pr-delivery'],
      assignee: '',
      status: 'open',
      issue_type: 'task',
      dependencies: [],
      comments: [],
    },
    'zz-work': {
      id: 'zz-work',
      title: 'The work',
      description: '',
      notes: '',
      labels: [],
      assignee: '',
      status: 'in_progress',
      issue_type: 'task',
      dependencies: workDeps,
    },
  };
  if (sibling) {
    issues['zz-sib'] = {
      id: 'zz-sib',
      title: 'Merge #7?',
      description: deliveryBody(DELIVERY),
      notes: '',
      labels: ['human', 'pr-delivery'],
      assignee: '',
      status: 'open',
      issue_type: 'task',
      dependencies: [],
      comments: [],
    };
    workDeps.push({ id: 'zz-sib', dependency_type: 'blocks' });
  }
  if (already) {
    issues['zz-merge'] = {
      id: 'zz-merge',
      title: 'Merge #7 — zz-work: something small',
      // Carrying the `beadpr` block is what makes this findable at all — `beadsAbout`
      // matches on that, not on the label or the title.
      description: mergeBeadBody(DELIVERY, {}),
      notes: withQueueBlock('', { attempts: 1, approved: false, approvedBy: '', approvedAt: '', at: '', baseline: [] }),
      labels: [MERGE_LABEL],
      assignee: MERGE_ASSIGNEE,
      status: 'open',
      issue_type: 'task',
      dependencies: [],
      comments: [],
    };
    workDeps.push({ id: 'zz-merge', dependency_type: 'blocks' });
  }
  writeWorld({ issues, next: 0 });
  fs.writeFileSync(BD_LOG, '');
  fs.writeFileSync(GH_LOG, '');
  fs.writeFileSync(PR_STATE, JSON.stringify(rawPR()));
  fs.rmSync(OWED_PATH, { force: true });
};

const MERGE = 'MERGE: merge #7, then close zz-work.';
const SHIP = 'SHIP: merge #7, then deploy demo.';

// The window a worker left behind — created once, checked throughout, because none of
// the taps below land a merge and so none of them has any business renaming it.
queuedWindow();

console.log('\nqueuing from the phone\n');

/* --------------------------------------------------- the ordinary single card */

{
  reset();
  const res = await post('/api/respond', { workspace: 'demo', id: 'zz-pr', response: MERGE });
  check('the answer is taken', res.status === 200, JSON.stringify(res.json));

  // The bug this file was rewritten for: nothing merged, and nothing tried to.
  check('nothing was merged at GitHub', merges().length === 0, JSON.stringify(merges()));
  check('the pull request is still open', JSON.parse(fs.readFileSync(PR_STATE, 'utf8')).state === 'OPEN');

  // The card itself is answered and closed exactly as any other question is — nothing
  // about the outer `/api/respond` machinery changes, because nothing here relabels
  // *this* bead (see `admitDeliveryToQueue`'s own docblock for why).
  check('the card closes, answered', world().issues['zz-pr'].status === 'closed', world().issues['zz-pr'].status);
  check(
    'and the close comment says where it went',
    (world().issues['zz-pr'].comments || []).some((c) => /merge queue as zz-q/.test(c)),
    JSON.stringify(world().issues['zz-pr'].comments)
  );

  // A fresh bead carries the approval — the same one a worker files when nothing in the
  // tracker is about a pull request yet.
  const filed = Object.values(world().issues).find((i) => i.id.startsWith('zz-q'));
  check('a queue entry was filed', Boolean(filed), JSON.stringify(Object.keys(world().issues)));
  check('carrying the queue label', (filed?.labels || []).includes(MERGE_LABEL), JSON.stringify(filed?.labels));
  check('and the queue assignee', filed?.assignee === MERGE_ASSIGNEE, filed?.assignee);
  const state = queueState(filed || {});
  check('the approval is recorded in the queue block', state.approved === true, JSON.stringify(state));
  check('with who gave it', Boolean(state.approvedBy), JSON.stringify(state));
  check('the attempt budget is unspent', state.attempts === 0, JSON.stringify(state));

  // The work bead is not closed, and not the same bead it was — it is parked behind the
  // queue entry now, not only the (now-closed, and therefore harmless) delivery card.
  check('the work bead is not closed', world().issues['zz-work'].status === 'in_progress', world().issues['zz-work'].status);
  check(
    'and it is parked behind the queue entry',
    (world().issues['zz-work'].dependencies || []).some((d) => d.id === filed.id),
    JSON.stringify(world().issues['zz-work'].dependencies)
  );

  // The three things this tap used to do afterwards. All three belong to the merge, and
  // the merge has not happened — lib/mergequeue.js's own `finish` does all three the
  // moment it lands one.
  check('no conflict sweep is asked for', Object.keys(readSweepRequests()).length === 0, JSON.stringify(readSweepRequests()));
  check('the window is not renamed — nothing has landed yet', windowName() === 'QUEUED-Demo - zz-work the work', windowName());
  check('nothing is left owing', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));

  // The pull request is told, so the record is where the diff is.
  check(
    'and the pull request carries a comment naming the approval',
    ghCalls().some((c) => c[0] === 'pr' && c[1] === 'comment'),
    ghCalls().map((c) => c.join(' ')).join(' | ')
  );
}

/* ------------------------------------------ the sibling card, which is the bug */

{
  reset({ sibling: true });
  const res = await post('/api/respond', { workspace: 'demo', id: 'zz-pr', response: MERGE });
  check('the answer is taken', res.status === 200, JSON.stringify(res.json));
  check('nothing was merged', merges().length === 0, JSON.stringify(merges()));

  // `zz-pr` is excluded from what `admitPlan` is asked about (it is about to close, a
  // few lines below, as an ordinary answered question) — so the sibling becomes the
  // queue entry, not a third bead filed beside it.
  check('the card closes', world().issues['zz-pr'].status === 'closed', world().issues['zz-pr'].status);
  check('no fresh bead was filed', !Object.keys(world().issues).some((id) => id.startsWith('zz-q')), JSON.stringify(Object.keys(world().issues)));
  const sib = world().issues['zz-sib'];
  check('the sibling becomes the queue entry instead', (sib.labels || []).includes(MERGE_LABEL), JSON.stringify(sib.labels));
  check('and it is not closed — nothing has merged yet', sib.status === 'open', sib.status);
  check('the work bead stays open too', world().issues['zz-work'].status === 'in_progress', world().issues['zz-work'].status);
  check(
    'and is parked behind the sibling now, as well as the closed card',
    (world().issues['zz-work'].dependencies || []).some((d) => d.id === 'zz-sib'),
    JSON.stringify(world().issues['zz-work'].dependencies)
  );
}

/* --------------------------------------------- when it is already on the queue */

{
  // The queue had already raised this pull request as a card once, or it is mid-attempt
  // right now — either way, something in the tracker already carries the queue's label
  // for it. The approval is recorded there; nothing is relabelled a second time.
  reset({ already: true });
  const res = await post('/api/respond', { workspace: 'demo', id: 'zz-pr', response: MERGE });
  check('the answer is taken', res.status === 200, JSON.stringify(res.json));
  check('nothing was merged', merges().length === 0, JSON.stringify(merges()));
  check('the card closes', world().issues['zz-pr'].status === 'closed', world().issues['zz-pr'].status);
  check('no fresh bead was filed', !Object.keys(world().issues).some((id) => id.startsWith('zz-q')), JSON.stringify(Object.keys(world().issues)));
  check('the existing queue entry still carries the label', (world().issues['zz-merge'].labels || []).includes(MERGE_LABEL));
  check('and it is still assigned to the queue', world().issues['zz-merge'].assignee === MERGE_ASSIGNEE);
  check('with the approval now recorded on it', queueState(world().issues['zz-merge']).approved === true, world().issues['zz-merge'].notes);
}

/* ------------------------------------------------------------------- shipping it */

{
  // Ship used to merge and deploy in one request. The merge is unattended now, so there
  // is nothing left to deploy here — the note says what happens instead, and it never
  // claims a deploy this request did not start.
  reset();
  const res = await post('/api/respond', { workspace: 'demo', id: 'zz-pr', response: SHIP });
  check('the answer is taken', res.status === 200, JSON.stringify(res.json));
  check('nothing was merged', merges().length === 0, JSON.stringify(merges()));
  check(
    'and the card says this workspace has no automatic ship declared',
    /no automatic ship declared/.test((world().issues['zz-pr'].comments || []).join('\n')),
    JSON.stringify(world().issues['zz-pr'].comments)
  );
}

{
  // The same tap, in a workspace that ships itself once a merge lands — the note says so
  // instead, and still starts no deploy of its own.
  reset();
  const shippy = { ...cfg, autoShipPerWorkspace: { demo: true } };
  const app2 = createApp(shippy);
  const servers2 = listen({ ...shippy, port: 0 }, app2.handler);
  const port2 = await boundPort(servers2);
  const res = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ workspace: 'demo', id: 'zz-pr', response: SHIP });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port2,
        path: '/api/respond',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-beadcause-token': cfg.token },
      },
      (r) => {
        let out = '';
        r.setEncoding('utf8');
        r.on('data', (c) => (out += c));
        r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  check('the answer is taken', res.status === 200, JSON.stringify(res.json));
  check('nothing was merged', merges().length === 0, JSON.stringify(merges()));
  check(
    'and the card says the workspace deploys itself',
    /deploys itself once a merge lands/.test((world().issues['zz-pr'].comments || []).join('\n')),
    JSON.stringify(world().issues['zz-pr'].comments)
  );
  for (const s of servers2) s.close?.();
  if (servers2[0]?.front) servers2[0].front.close?.();
}

{
  // The epic-safety backstop (bc-arj0.3), kept and moved here: an epic's own theme
  // finishing is not the same fact as a pull request landing, and nothing here says it
  // is any more — resolveDeliveryFor no longer touches the work bead at all, so the
  // HTTP-level version of this test that used to be above went with it. What survives is
  // the retry's own rule, seeded directly, exactly as `lib/mergequeue.js`'s own `finish`
  // relies on it now (test/mergequeue.mjs covers that path end to end).
  //
  // A record written before this rule existed — or by anything that owes a close
  // without asking. The retry has nothing in hand but the stored sentence, so it is the
  // sentence the gate is asked about.
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  reset();
  const w = world();
  w.issues['zz-work'].issue_type = 'epic';
  w.issues['zz-work'].dependencies = [];
  writeWorld(w);
  oweClose({ workspace: 'demo', id: 'zz-work', reason: 'Merged #7 as c5004cce into main on GitHub', why: 'blocked by zz-sib' });

  const swept = await sweepOwed(bd, cfg.workspaces);
  check('the retry refuses a merge-reason close on an epic', swept[0]?.status === 'refused', JSON.stringify(swept));
  check('the epic is still open after it', world().issues['zz-work'].status !== 'closed', world().issues['zz-work'].status);
  check('and the record is dropped rather than retried forever', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));
}

{
  // The same epic, owed a close somebody decided on. Nothing here holds an epic open
  // against a reason that is *about the theme* — that is what closing an epic is for.
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  reset();
  const w = world();
  w.issues['zz-work'].issue_type = 'epic';
  w.issues['zz-work'].dependencies = [];
  writeWorld(w);
  oweClose({ workspace: 'demo', id: 'zz-work', reason: 'The theme is finished — every piece of it shipped.', why: 'the lock' });

  const swept = await sweepOwed(bd, cfg.workspaces);
  check('an epic owed a close on its theme still closes', swept[0]?.status === 'closed', JSON.stringify(swept));
  check('and it really is closed', world().issues['zz-work'].status === 'closed', world().issues['zz-work'].status);
  fs.rmSync(OWED_PATH, { force: true });
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

/* -------------------------------------------- bc-9d37.13: the 1.2.1 claim guard */

console.log('\na delivery closing the bead its own worker claimed\n');

{
  // The bug, in the state every delivered bead is actually in: the worker claimed it, so
  // the assignee is a git identity, and everything beadcause runs carries the `beadcause
  // (…)` byline. bd 1.2.1 refuses that close. Before the fix this was `failed`, kept, and
  // retried with the identical command every poll cycle forever — three real records were
  // stuck in exactly that loop when this was filed.
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause (neadamthal@gmail.com)' });
  reset();
  const w = world();
  w.issues['zz-work'].assignee = 'neadamthal@gmail.com';
  w.issues['zz-work'].dependencies = [];
  writeWorld(w);
  oweClose({ workspace: 'demo', id: 'zz-work', reason: 'Merged #7 as c5004cce into main', why: 'the claim guard' });

  const swept = await sweepOwed(bd, cfg.workspaces);
  check('the retry closes it over the claim guard', swept[0]?.status === 'closed', JSON.stringify(swept));
  check('and it really is closed', world().issues['zz-work'].status === 'closed', world().issues['zz-work'].status);
  // The whole reason --force was chosen over reclaim-then-close: the tracker keeps saying
  // who did the work. `bd update --assignee <actor>` would also have cleared the refusal,
  // and would have overwritten this with the daemon's byline on every delivered bead.
  check('the worker keeps the credit', world().issues['zz-work'].assignee === 'neadamthal@gmail.com', String(world().issues['zz-work'].assignee));
  check('and nothing is left owing it', Object.keys(readOwed()).length === 0, JSON.stringify(readOwed()));
}

{
  // The half that must NOT be forced. `--force` lifts the blocker refusal too, so a close
  // that was refused for a *live blocker* has to stay refused — otherwise this fix would
  // quietly close gated beads, which is a much worse bug than the one it repairs.
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause (neadamthal@gmail.com)' });
  reset();
  const w = world();
  w.issues['zz-work'].assignee = 'neadamthal@gmail.com';
  writeWorld(w);
  oweClose({ workspace: 'demo', id: 'zz-work', reason: 'Merged #7', why: 'blocked by zz-pr' });

  const swept = await sweepOwed(bd, cfg.workspaces);
  check('a blocked bead is still blocked, claim guard or not', swept[0]?.status === 'blocked', JSON.stringify(swept));
  check('it is not closed', world().issues['zz-work'].status !== 'closed', world().issues['zz-work'].status);
  check('and the record is kept, because that one really does clear on its own', Object.keys(readOwed()).length === 1, JSON.stringify(readOwed()));
  fs.rmSync(OWED_PATH, { force: true });
}

{
  // An assignee that matches the actor was never the problem, and must not start paying
  // for one: the plain close still goes through on the first attempt, with no --force
  // anywhere near it. Asserted on the calls rather than on the outcome, because both
  // paths end with a closed bead and only one of them steps over a guard.
  const bd = new Bd({ bin: FAKE_BD, actor: 'neadamthal@gmail.com' });
  reset();
  const w = world();
  w.issues['zz-work'].assignee = 'neadamthal@gmail.com';
  w.issues['zz-work'].dependencies = [];
  writeWorld(w);
  fs.writeFileSync(BD_LOG, '');
  oweClose({ workspace: 'demo', id: 'zz-work', reason: 'Merged #7', why: 'the lock' });

  const swept = await sweepOwed(bd, cfg.workspaces);
  const calls = fs.readFileSync(BD_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('a matching assignee closes on the first try', swept[0]?.status === 'closed', JSON.stringify(swept));
  check('and nothing was forced', !calls.some((c) => c.includes('--force')), JSON.stringify(calls.filter((c) => c[0] === 'close')));
  fs.rmSync(OWED_PATH, { force: true });
}

{
  // isClaimGuard is what decides whether --force is reached for at all, so it is worth
  // asserting directly against the three refusals bd 1.2.1 actually emits — two of which
  // also end in "use --force to override" and must not match.
  check('the claim guard is recognised', isClaimGuard(new Error('cannot close bc-x: assignee is "a", actor is "b"; reclaim or use --force to override')));
  check('a blocked close is not', !isClaimGuard(new Error('cannot close blocked issue: cg-0yq is blocked by [cg-aed] (use --force to override)')));
  check('nor is an open child', !isClaimGuard(new Error('cannot close cg-pvg: 1 open child issue(s); close children first or use --force to override')));
  check('and it reads stderr, not only the message', isClaimGuard({ message: 'Command failed', stderr: 'cannot close bc-x: assignee is "a", actor is "b"; reclaim' }));
  check('nothing at all is not a claim guard', !isClaimGuard(null) && !isClaimGuard(undefined));
}

await cleanupTmp(tmp);

console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall ${ran} passed\n`);
process.exit(failures ? 1 : 0);
