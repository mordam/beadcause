#!/usr/bin/env node
/**
 * The release queue — what merged and is not running yet.
 *
 *     npm test
 *     node test/release.mjs
 *
 * `test/prship.mjs` proves Ship on one row. This is the queue *behind* that button: the
 * set of merges one deploy would make live, the number drawn over it, and the bead filed
 * per merge so "still owed: deploy" survives the notification that said it.
 *
 * Six failures are worth the file, and five of them are the same failure wearing
 * different hats — **saying something is shipped when nobody knows**:
 *
 * 1. **A flood on first sight.** The board carries three weeks of merged pull requests.
 *    A daemon meeting a repo for the first time — a new install, a new workspace, this
 *    feature's own first run — must file a watermark and *nothing else*, or the tracker
 *    gets a dozen beads for work that shipped a fortnight ago. Asserted first because it
 *    is the one that would have been noticed by Adam rather than by a test.
 * 2. **A duplicate.** Two ticks, one merge, one bead. Proved twice over: once through
 *    the ledger, and once with the ledger deleted underneath it, because the ledger is
 *    a watermark and not a lock — what actually stops a second bead is reading the
 *    tracker for a marker.
 * 3. **A close on evidence that is not evidence.** `unconfirmed` is the *ordinary*
 *    ending of a deploy that restarts the daemon asking for it, and it means the command
 *    ran with nobody left to say what happened. A queue that drained on it would be
 *    inventing the fact it exists to report. Same for `lost`, and same for a deploy that
 *    started *before* the merge landed.
 * 4. **A merge counted before it can be shipped.** A deploy fast-forwards to
 *    `origin/main`; a merge this Mac has not seen there yet could not be picked up by
 *    one, so it is not in the queue however merged GitHub says it is.
 * 5. **A bead nothing could ever close.** A repo with no declared deploy and no visible
 *    build has no event that would settle one, so none is filed there.
 * 6. **Shipping an empty queue.** Pressing Ship on a repo where everything merged is
 *    already live would, on this Mac, restart the daemon you are holding for nothing.
 *
 * The last third of the file is the endpoint, over real HTTP, against a real `createApp`
 * with a real git repo, a fake `gh` and a "deploy" that writes a file. Nothing here
 * restarts anything, opens a window, reaches the network, or touches a tracker of yours.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-release-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// both the deploy journal and this file's ledger live under it.
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
const check = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for `fn` to stop throwing, or give up. A deploy is another process. */
async function until(fn, { ms = 8000, every = 40 } = {}) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (Date.now() > deadline) throw last;
      await sleep(every);
    }
  }
}

const {
  LEDGER_PATH,
  SHIP_LABEL,
  decorateBoard,
  loadLedger,
  markerOf,
  owedFor,
  releaseFor,
  shipMarker,
  shipReason,
  shippedState,
  sweepReleases,
} = await import(LIB('release.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));

const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

/** A board row, in the shape lib/prboard.js hands out. Merged and not live by default. */
const row = (over = {}) => ({
  number: 1,
  title: 'zz-work: something small',
  url: 'https://github.com/acme/demo/pull/1',
  base: 'main',
  branch: 'worktree-something-work',
  author: 'someone',
  state: 'MERGED',
  merged: true,
  pushed: true,
  local: true,
  deployed: null,
  deployTracked: false,
  deployDeclared: true,
  mergeCommit: 'a'.repeat(40),
  mergedAt: ago(60),
  ...over,
});

const card = (over = {}) => ({
  workspace: 'demo',
  repo: 'acme/demo',
  base: 'main',
  error: null,
  deployTracked: false,
  deployDeclared: true,
  deployHint: 'runs `writer`',
  prs: [row()],
  ...over,
});

const deploy = (over = {}) => ({ id: 'd-1', workspace: 'demo', status: 'ok', startedAt: ago(10), ...over });

/* ================================================================ what is shipped */

console.log('\nthe release queue — what counts as shipped\n');

await check(
  () => assert.equal(shippedState(row({ deployed: true }), []), true),
  'in the build that is running is shipped, whatever the journal says'
);
await check(
  () => assert.equal(shippedState(row(), [deploy()]), true),
  'a deploy that exited 0 after the merge landed is shipped'
);
await check(
  () => assert.equal(shippedState(row(), []), false),
  'merged, pushed, and no deploy since: not shipped'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ startedAt: ago(90) })]), false),
  'a deploy that started before the merge landed ships nothing'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ status: 'unconfirmed' })]), false),
  '`unconfirmed` never counts — the command ran and nobody outlived it to say what happened'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ status: 'lost' })]), false),
  '`lost` never counts either'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ status: 'failed' })]), false),
  'and neither does a deploy that failed'
);
await check(
  () => assert.equal(shippedState(row({ pushed: null }), [deploy()]), null),
  'a merge this Mac has not seen on origin is null, not false — no deploy could pick it up'
);
await check(
  () => assert.equal(shippedState(row({ merged: false, state: 'OPEN' }), [deploy()]), null),
  'an open pull request is not in the queue at all'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ workspace: 'other' })].filter((d) => d.workspace === 'demo')), false),
  "another repo's deploy is not this one's — the caller groups by workspace"
);

/* ------------------------------------------------------------------- the queue */

console.log('\nthe queue, and the number on the button\n');

const busy = card({
  prs: [
    row({ number: 4, mergedAt: ago(5) }),
    row({ number: 3, mergedAt: ago(30) }),
    row({ number: 2, mergedAt: ago(120), deployed: true }),
    row({ number: 9, state: 'OPEN', merged: false, mergedAt: null }),
  ],
});

await check(() => assert.deepEqual(owedFor(busy, []).map((p) => p.number), [4, 3]), 'the queue is the merges that are not live, newest first');
await check(() => assert.equal(releaseFor(busy, []).count, 2), 'and the count is what the button wears');
await check(() => assert.equal(releaseFor(busy, []).can, 'deploy'), 'a declared repo can ship its queue in one press');
await check(
  () => assert.equal(releaseFor(card({ deployDeclared: false }), []).can, 'session'),
  'a repo that declared nothing says so instead of offering a batch it cannot do'
);
await check(
  () => assert.equal(releaseFor(busy, [], { demo: { handled: { 4: { bead: 'zz-abc' } } } }).prs[0].bead, 'zz-abc'),
  'a queued merge carries the ship bead filed for it'
);
await check(() => assert.equal(releaseFor(busy, [], {}).prs[0].bead, null), 'and null where none was filed, which is ordinary');
await check(
  () => assert.match(shipReason(releaseFor(busy, [])), /#4, #3/),
  'the deploy record says which merges it carried'
);

/* ------------------------------------------------------------- decorating a board */

const original = { repos: [busy, card({ workspace: 'bare', deployDeclared: false, prs: [row({ number: 7 })] })], counts: { open: 1 } };
const frozen = JSON.stringify(original);
const decorated = decorateBoard(original, {}, []);

await check(() => assert.equal(decorated.counts.ship, 3), 'the board carries the total, which is what the tab badge reads');
await check(() => assert.equal(decorated.counts.open, 1), 'and keeps the counts it already had');
await check(() => assert.equal(JSON.stringify(original), frozen), 'and never writes into the cached board it was handed');
await check(() => assert.equal(decorated.repos[0].release.count, 2), 'every card gets its own queue');

/* ------------------------------------------------------------------- the marker */

await check(() => assert.deepEqual(markerOf(`x\n${shipMarker('acme/demo', 12)}\ny`), { repo: 'acme/demo', number: 12 }), 'a ship bead names its pull request');
await check(() => assert.equal(markerOf('nothing here'), null), 'and prose that names none reads as none');
await check(() => assert.equal(markerOf('shipped: acme/demo#12'), null), 'a near-miss is not a marker');

/* ============================================================== filing the beads */

console.log('\nthe bead per merge\n');

/** A tracker that records what it was asked to do, and answers from what it has. */
function tracker(rows = []) {
  const t = {
    beads: [...rows],
    created: [],
    closed: [],
    n: 0,
    listLabel: async (ws, label) => t.beads.filter((b) => (b.labels || []).includes(label) && b.workspace === ws.name),
    create: async (ws, spec) => {
      t.n += 1;
      const id = `zz-${t.n}`;
      t.created.push({ ws: ws.name, id, spec });
      t.beads.push({ id, workspace: ws.name, description: spec.body, labels: spec.labels, status: 'open' });
      return id;
    },
    close: async (ws, id, reason) => {
      t.closed.push({ ws: ws.name, id, reason });
      t.beads = t.beads.filter((b) => b.id !== id);
    },
  };
  return t;
}

const CFG = {
  workspaces: [{ name: 'demo', dir: path.join(tmp, 'beads-demo') }, { name: 'bare', dir: path.join(tmp, 'beads-bare') }],
  release: { beads: true },
};

const forget = () => fs.rmSync(LEDGER_PATH, { force: true });

/* 1. First sight files nothing, however much has merged. */
forget();
{
  const bd = tracker();
  const board = { repos: [card({ prs: [row({ number: 1 }), row({ number: 2 }), row({ number: 3 })] })] };
  const out = await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'the first sight of a repo files nothing — three weeks of history is not news');
  await check(() => assert.equal(out.watermarked[0]?.merged, 3), 'it says how much it decided not to file for');
  await check(() => assert.ok(loadLedger().demo.since), 'and writes the watermark that makes that decision once');
}

/* 2. A merge after the watermark gets exactly one bead, and only one. */
{
  const bd = tracker();
  const fresh = row({ number: 4, mergedAt: new Date().toISOString() });
  const board = { repos: [card({ prs: [row({ number: 1 }), fresh] })] };

  const first = await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 1), 'a merge after the watermark is filed');
  await check(() => assert.equal(first.filed[0]?.number, 4), 'and it is the new one, not the one that predates it');

  const spec = bd.created[0].spec;
  await check(() => assert.ok(spec.labels.includes(SHIP_LABEL)), `the bead carries \`${SHIP_LABEL}\`, which is how it is found again`);
  await check(
    () => assert.ok(spec.labels.includes(UNENDORSED)),
    'and `unendorsed`, so nothing opens a session on it — shipping is a tap, not a session'
  );
  await check(() => assert.ok(!spec.labels.includes('human')), 'and not `human`: it is a chore, not a question with options');
  await check(() => assert.deepEqual(markerOf(spec.body), { repo: 'acme/demo', number: 4 }), 'its body names the pull request it is about');
  await check(() => assert.match(spec.title, /#4/), 'and so does its title');

  await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 1), 'a second tick over the same board files nothing more');

  // The ledger is a watermark, not a lock. What actually stops a duplicate is the
  // marker on the bead, and this is the only way to prove the two are independent.
  const saved = fs.readFileSync(LEDGER_PATH, 'utf8');
  const ledger = JSON.parse(saved);
  delete ledger.demo.handled['4'];
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger));
  await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 1), 'and neither does one with the ledger entry torn out from under it');
  fs.writeFileSync(LEDGER_PATH, saved);

  /* 3. It closes itself when the merge is live — and on nothing weaker. */
  const bead = bd.created[0].id;
  await sweepReleases(bd, CFG, { repos: [card({ prs: [fresh] })] }, { deploys: [deploy({ status: 'unconfirmed', startedAt: new Date().toISOString() })] });
  await check(() => assert.equal(bd.closed.length, 0), 'an `unconfirmed` deploy closes nothing');

  const shipped = { repos: [card({ prs: [row({ number: 4, mergedAt: fresh.mergedAt, deployed: true })] })] };
  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(() => assert.equal(bd.closed[0]?.id, bead), 'and being in the running build closes it');
  await check(() => assert.match(bd.closed[0]?.reason || '', /#4/), 'with a reason that says which merge went live');
  await check(() => assert.ok(loadLedger().demo.handled['4']?.shippedAt), 'the ledger records that it settled');

  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 1), 'and a settled merge is never filed again');
}

/* 4. A merge that has not reached origin is not the queue's business. */
forget();
{
  const bd = tracker();
  const unpushed = row({ number: 5, pushed: null, mergedAt: new Date().toISOString() });
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  await sweepReleases(bd, CFG, { repos: [card({ prs: [unpushed] })] }, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'a merge this Mac has not seen on origin files nothing — no deploy could ship it');
}

/* 5. No declared deploy, no visible build: nothing here could ever close a bead. */
forget();
{
  const bd = tracker();
  const bare = card({ workspace: 'bare', deployDeclared: false, deployTracked: false, prs: [row({ number: 6, mergedAt: new Date().toISOString() })] });
  await sweepReleases(bd, CFG, { repos: [bare] }, { deploys: [] });
  await sweepReleases(bd, CFG, { repos: [bare] }, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'a repo whose ship beadcause could never see files none');
  await check(() => assert.equal(loadLedger().bare, undefined), 'and gets no watermark either — there is nothing to watermark');
}

/* 6. The two ways the sweep is switched off, and the one way it refuses itself. */
forget();
{
  const bd = tracker();
  const board = { repos: [card({ prs: [row({ number: 7, mergedAt: new Date().toISOString() })] })] };
  const off = await sweepReleases(bd, { ...CFG, release: { beads: false } }, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), '`release.beads: false` files nothing and writes no ledger');
  await check(() => assert.match(off.skipped[0] || '', /filing is off/), 'and says why');

  fs.writeFileSync(LEDGER_PATH, '{ this is not json');
  const broken = await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'an unreadable ledger files nothing at all');
  await check(
    () => assert.match(broken.error || '', /cannot be read/),
    'because a lost watermark would file every old merge again — so it says so and stops'
  );
  forget();
}

/* 7. A tracker that will not answer is a tick that did nothing, not a duplicate. */
{
  const bd = tracker();
  const board = { repos: [card({ prs: [row({ number: 8, mergedAt: new Date().toISOString() })] })] };
  await sweepReleases(bd, CFG, board, { deploys: [] });
  bd.listLabel = async () => {
    throw new Error('database is busy');
  };
  const busySweep = await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'a workspace mid-write files nothing this tick');
  await check(() => assert.match(busySweep.skipped[0] || '', /could not read its ship beads/), 'and says which one, rather than throwing');
}

/* ================================================================== the endpoint */

console.log('\nshipping the queue, over HTTP\n');

forget();
fs.rmSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'deploys'), { recursive: true, force: true });

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e' },
  }).trim();

/** `demo` declares a deploy; `bare` is every repo that has declared nothing. */
const repos = {};
for (const name of ['demo', 'bare']) {
  const origin = path.join(tmp, `${name}.git`);
  const dir = path.join(tmp, name);
  git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(tmp, 'clone', '--quiet', origin, dir);
  git(dir, 'config', 'user.email', 't@e');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '--quiet', '-m', 'one');
  git(dir, 'push', '--quiet', '-u', 'origin', 'main');
  repos[name] = { dir, origin, head: git(dir, 'rev-parse', 'HEAD') };
}

const GH_STATE = path.join(tmp, 'gh-state.json');
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(GH_STATE)}, 'utf8'));
const args = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (args[0] === 'auth' && args[1] === 'status') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/' + require('node:path').basename(process.cwd()) }));
if (args[0] === 'pr' && args[1] === 'list') out(JSON.stringify(state[require('node:path').basename(process.cwd())] || []));
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const rawPR = (over = {}) => ({
  number: 1,
  url: 'https://github.com/acme/demo/pull/1',
  title: 'zz-work: something small',
  state: 'MERGED',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'worktree-something-work',
  baseRefName: 'main',
  additions: 4,
  deletions: 1,
  changedFiles: 1,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: ago(60),
  mergeCommit: { oid: repos.demo.head },
  body: '',
  author: { login: 'someone' },
  createdAt: ago(180),
  updatedAt: ago(60),
  ...over,
});

fs.writeFileSync(
  GH_STATE,
  JSON.stringify({
    demo: [rawPR(), rawPR({ number: 2, title: 'zz-work: and another' })],
    bare: [rawPR({ number: 3, mergeCommit: { oid: repos.bare.head }, title: 'zz-work: the same, elsewhere' })],
  })
);

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'list') { process.stdout.write(JSON.stringify([{ id: 'zz-a1b' }])); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/** Restarts nothing; leaves a file behind so "it ran" is a fact on disk. */
const DEPLOYED = path.join(tmp, 'deployed.txt');
fs.writeFileSync(
  path.join(BIN, 'writer'),
  `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(DEPLOYED)}, 'ran\\n');
`,
  { mode: 0o755 }
);

const beadsDir = (name) => {
  const d = path.join(tmp, 'beads', name, '.beads');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const { createApp, listen } = await import(LIB('server.js'));
const { listDeploys } = await import(LIB('deploy.js'));

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'release-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [
    { name: 'demo', dir: beadsDir('demo') },
    { name: 'bare', dir: beadsDir('bare') },
  ],
  sessionDirs: { demo: repos.demo.dir, bare: repos.bare.dir },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
  pr: { base: 'main' },
  release: { beads: false, seconds: 3600 },
  deploys: { demo: { command: [path.join(BIN, 'writer')], dir: repos.demo.dir, pull: false, graceMs: 0, restarts: false } },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);
cfg.port = port;

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

const post = (p, body) => request('POST', p, body);
const get = (p) => request('GET', p);

const board = await get('/api/prs?refresh=1');
const cardOf = (name) => (board.json.repos || []).find((r) => r.workspace === name);

await check(() => assert.equal(board.status, 200), 'the board loads');
await check(() => assert.equal(cardOf('demo')?.release?.count, 2), 'and every card carries its own queue');
await check(() => assert.equal(board.json.counts?.ship, 3), 'and the board carries the total the tab badge reads');
await check(() => assert.match(cardOf('demo')?.release?.hint || '', /writer/), 'the queue names the command the button will run');
await check(() => assert.equal(cardOf('bare')?.release?.can, 'session'), 'a repo that declared nothing cannot batch, and says so');

const refused = await post('/api/release/ship', { workspace: 'bare' });
await check(() => assert.equal(refused.status, 409), 'and refuses to ship its queue in one press');
await check(() => assert.match(refused.json.error || '', /no deploy/), `naming the reason — "${refused.json.error}"`);
await check(() => assert.equal(fs.existsSync(DEPLOYED), false), 'nothing has been deployed yet');

const shipped = await post('/api/release/ship', { workspace: 'demo' });
await check(() => assert.equal(shipped.status, 200), 'a repo that declared one ships the whole queue');
await check(() => assert.equal(shipped.json.release?.count, 2), 'and says how many merges it carried');
await check(() => assert.match(shipped.json.deploy?.reason || '', /#1/), 'the deploy record names them, for whoever reads it later');

const second = await post('/api/release/ship', { workspace: 'demo' });
await check(() => assert.equal(second.status, 409), 'a second press while it is running is refused');

await until(() => {
  const rec = listDeploys({ limit: 10 }).find((r) => r.id === shipped.json.deploy.id);
  assert.equal(rec?.status, 'ok');
});
await check(() => assert.equal(fs.readFileSync(DEPLOYED, 'utf8').trim(), 'ran'), 'the deploy ran exactly once for the whole queue');

const after = await get('/api/prs?refresh=1');
await check(
  () => assert.equal((after.json.repos || []).find((r) => r.workspace === 'demo')?.release?.count, 0),
  'and the queue is empty afterwards — one deploy shipped both'
);
const empty = await post('/api/release/ship', { workspace: 'demo' });
await check(() => assert.equal(empty.status, 409), 'so pressing Ship again refuses rather than restarting the daemon for nothing');
await check(() => assert.match(empty.json.error || '', /already live/), `saying why — "${empty.json.error}"`);

for (const s of servers) s.close(s.front ? () => s.front.close() : undefined);
app.close?.();

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} passed\x1b[0m`}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
