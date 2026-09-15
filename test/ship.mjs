#!/usr/bin/env node
/**
 * **Ship it, and Merge it** — neither deploys, and neither merges, any more (bc-xl7n.135).
 *
 *     npm test
 *     node test/ship.mjs
 *
 * `test/delivery.mjs` proves `SHIP:` is a distinct word and that the card offers it only
 * where there is a deploy. This used to prove what happened when it was answered: a real
 * merge, immediately, and — for `SHIP:` — a deploy started once the answer was durably
 * written, guarded against the SIGKILL a beadcause deploy sends itself mid-request. That
 * guard is retired rather than moved: `resolveDeliveryFor` no longer merges anything, so
 * there is no merge for a deploy to race, and this file's job changed with it.
 *
 * Three failures are worth it now:
 *
 * 1. **Either tap merging, or deploying, on its own.** The bug this repo actually hit
 *    (bc-xl7n.135): `pr.merge` straight through, no queue, no record. Both taps have to
 *    reach neither `gh pr merge` nor a declared deploy — ever, whatever the workspace.
 * 2. **`SHIP:`'s note claiming a deploy that has not run.** The whole reason `SHIP:` is a
 *    separate word from `MERGE:` is that it promises more; a promise it cannot keep from
 *    this tap any more has to say so, in a workspace with a declared deploy and in one
 *    without.
 * 3. **Free text doing either.** The consent model is `startsWith` on a marker and
 *    nothing else, checked at the endpoint rather than at the parser: an ordinary
 *    comment on a delivery card must reach neither `gh` nor the queue.
 *
 * A real `POST /api/respond` through a real `createApp`, with `bd` and `gh` as fakes.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-ship-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load,
// and lib/deploy.js keeps its journal under it.
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

/* ------------------------------------------------------------------- fake bd */

const CALLS = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * The delivery question, exactly as `beadcause-deliver` files it — built by the real
 * lib/delivery.js so the fixture cannot drift away from what the server parses.
 */
const { deliveryBody } = await import(LIB('delivery.js'));
const DELIVERY = {
  workspace: 'demo',
  bead: 'zz-work',
  repo: 'acme/widgets',
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  branch: 'bead/zz-work',
  base: 'main',
  method: 'squash',
  summary: 'Something small.',
};
// A distinct bead and branch, not only a distinct repo — the fake `bd` below shares one
// `w.issues` for both fixture workspaces (a real `bd.listLive` is scoped by workspace
// directory and could never see the other one), so a fixture that reused `zz-work` here
// would let `admitPlan`'s bead match cross a boundary nothing in production has.
const DELIVERY_BARE = {
  ...DELIVERY,
  workspace: 'bare',
  bead: 'bb-work',
  repo: 'acme/other',
  url: 'https://github.com/acme/other/pull/7',
  branch: 'bead/bb-work',
};
const SHIPPABLE = deliveryBody(DELIVERY, { ship: 'runs `writer` · restarts beadcause' });
const PLAIN = deliveryBody(DELIVERY_BARE);

const WORLD = path.join(tmp, 'world.json');
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const writeWorld = (w) => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const WORLD = ${JSON.stringify(WORLD)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
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
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (issue.comments = issue.comments || []).push(args[2]);
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const calls = () =>
  fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const resetCalls = () => fs.writeFileSync(CALLS, '');

/* ------------------------------------------------------------------- fake gh */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const GH_LOG = path.join(tmp, 'gh-calls.log');

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + '\\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
const fail = (s) => { process.stderr.write(s + '\\n'); process.exit(1); };
if (args[0] === 'auth') out('Logged in to github.com\\n');
if (args[0] === 'pr' && (args[1] === 'close' || args[1] === 'comment')) out('done\\n');
fail('unknown gh invocation: ' + args.join(' '));
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const ghCalls = () =>
  fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const resetGh = () => fs.writeFileSync(GH_LOG, '');

/* ----------------------------------------------------------------- the config */

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });
const bareDir = path.join(tmp, 'bare');
fs.mkdirSync(path.join(bareDir, '.beads'), { recursive: true });

const base = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'ship-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [
    { name: 'demo', dir: wsDir },
    { name: 'bare', dir: bareDir },
  ],
  sessionDirs: { demo: wsDir, bare: bareDir },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
  // Only `demo` declares a deploy. `bare` is every repo that declares nothing, which is
  // most of them, and is what the second case's other half is about. Neither script is
  // ever run any more — nothing here starts a deploy — but the declaration still has to
  // change what the note says.
  deploys: {
    demo: { command: [path.join(BIN, 'writer')], dir: wsDir, pull: false, graceMs: 0, restarts: false },
  },
};

const { createApp, listen } = await import(LIB('server.js'));
const { listDeploys } = await import(LIB('deploy.js'));

const cfg = { ...base, port: 0 };
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const call = (pathname, body) =>
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

const reset = () => {
  resetCalls();
  resetGh();
  writeWorld({
    issues: {
      'zz-pr': {
        id: 'zz-pr',
        title: 'Merge #7?',
        description: SHIPPABLE,
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
        dependencies: [{ id: 'zz-pr', dependency_type: 'blocks' }],
      },
      'bb-pr': {
        id: 'bb-pr',
        title: 'Merge #7?',
        description: PLAIN,
        notes: '',
        labels: ['human', 'pr-delivery'],
        assignee: '',
        status: 'open',
        issue_type: 'task',
        dependencies: [],
        comments: [],
      },
      'bb-work': {
        id: 'bb-work',
        title: 'The other work',
        description: '',
        notes: '',
        labels: [],
        assignee: '',
        status: 'in_progress',
        issue_type: 'task',
        dependencies: [{ id: 'bb-pr', dependency_type: 'blocks' }],
      },
    },
    next: 0,
  });
  for (const rec of listDeploys({ limit: 200 })) {
    for (const suffix of ['.json', '.announced', '.log']) {
      try {
        fs.unlinkSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'deploys', `${rec.id}${suffix}`));
      } catch {
        /* already gone */
      }
    }
  }
};

console.log('\nneither taps deploys, and neither merges\n');

/* ------------------------------------------------------------ merge only */

reset();
const merged = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-pr',
  response: 'MERGE: squash and merge #7, then close zz-work.',
});

await check(() => assert.equal(merged.status, 200), 'MERGE: is answered');
await check(
  () => assert.ok(!ghCalls().some((a) => a[0] === 'pr' && a[1] === 'merge'), JSON.stringify(ghCalls())),
  'and the pull request is not merged');
await check(() => assert.equal(merged.json.delivery.action, 'queue'), 'the answer says it was queued');
await check(
  () => assert.ok(calls().some((a) => a[0] === 'close' && a[1] === 'zz-pr'), JSON.stringify(calls())),
  'the delivery card closes, answered — the ordinary way any question does');
await check(
  () => assert.equal(world().issues['zz-work'].status, 'in_progress'),
  'the work bead stays open — the merge has not happened');
await check(async () => {
  await sleep(200);
  assert.deepEqual(listDeploys(), []);
}, 'and NOTHING is deployed — a queued merge is not a landed one');

/* ----------------------------------------------------------------- ship it */

reset();
const shipped = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-pr',
  response: 'SHIP: squash and merge #7, then deploy demo.',
});

await check(() => assert.equal(shipped.status, 200), 'SHIP: is answered');
await check(
  () => assert.ok(!ghCalls().some((a) => a[0] === 'pr' && a[1] === 'merge'), JSON.stringify(ghCalls())),
  'it does not merge either — the deploy it promises has nothing to deploy yet');
await check(() => assert.equal(shipped.json.delivery.action, 'queue'), 'the answer says it was queued, not shipped');
await check(async () => {
  await sleep(200);
  assert.deepEqual(listDeploys(), []);
  assert.equal(shipped.json.deploy, null);
}, 'and nothing is deployed — there is no landed merge for a deploy to be about');
await check(() => {
  const answer = calls().find((a) => a[0] === 'comment' && a[1] === 'zz-pr');
  assert.ok(answer, JSON.stringify(calls()));
  assert.match(answer.join(' '), /no automatic ship declared/, answer.join(' '));
  assert.match(answer.join(' '), /deploy it from the PR board/, answer.join(' '));
}, 'the card says what happens once it lands, rather than implying it has already shipped');

/* --------------------------------------------------------- and once it auto-ships */

{
  reset();
  const shippy = { ...cfg, autoShipPerWorkspace: { demo: true } };
  const app2 = createApp(shippy);
  const servers2 = listen({ ...shippy, port: 0 }, app2.handler);
  const port2 = await boundPort(servers2);
  const call2 = (body) =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: port2,
          path: '/api/respond',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-beadcause-token': cfg.token },
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
  const res = await call2({ workspace: 'demo', id: 'zz-pr', response: 'SHIP: squash and merge #7, then deploy demo.' });
  await check(() => assert.equal(res.status, 200), 'still answered');
  await check(async () => {
    await sleep(200);
    assert.deepEqual(listDeploys(), []);
  }, 'still nothing deployed by this request');
  await check(() => {
    const answer = calls().find((a) => a[0] === 'comment' && a[1] === 'zz-pr');
    assert.ok(answer, JSON.stringify(calls()));
    assert.match(answer.join(' '), /deploys itself once a merge lands/, answer.join(' '));
  }, 'and the card says the workspace deploys itself instead');
  for (const s of servers2) s.close?.();
  if (servers2[0]?.front) servers2[0].front.close?.();
}

/* ------------------------------------------------- a repo with nothing declared */

reset();
const bare = await call('/api/respond', {
  workspace: 'bare',
  id: 'bb-pr',
  response: 'SHIP: squash and merge #7, then deploy bare.',
});

await check(() => assert.equal(bare.status, 200), 'ship in a repo with no deploy is not an error');
await check(
  () => assert.ok(!ghCalls().some((a) => a[0] === 'pr' && a[1] === 'merge'), JSON.stringify(ghCalls())),
  'it still does not merge — queuing needs no declared deploy to work');
await check(async () => {
  await sleep(200);
  assert.deepEqual(listDeploys(), []);
  assert.equal(bare.json.deploy, null);
}, 'and nothing is deployed');
await check(() => {
  const answer = calls().find((a) => a[0] === 'comment' && a[1] === 'bb-pr');
  assert.ok(answer, JSON.stringify(calls()));
  assert.match(answer.join(' '), /no automatic ship declared/, answer.join(' '));
}, 'and the answer on the bead says so, rather than implying it will ship itself');

/* ------------------------------------------------------------------ free text */

reset();
const comment = await call('/api/respond', { workspace: 'demo', id: 'zz-pr', response: 'looks good, ship it' });

await check(() => assert.equal(comment.status, 200), 'an ordinary comment on a delivery card is accepted');
await check(
  () => assert.ok(!ghCalls().some((a) => a[0] === 'pr' && a[1] === 'merge'), JSON.stringify(ghCalls())),
  'and merges nothing, even saying the words');
await check(
  () => assert.ok(!calls().some((a) => a[0] === 'create'), JSON.stringify(calls())),
  'and queues nothing either — consent is the marker and nothing else');
await check(async () => {
  await sleep(200);
  assert.deepEqual(listDeploys(), []);
}, 'and deploys nothing either');

/* -------------------------------------------------------------------- verdict */

for (const s of servers) s.close();
app.stop?.();
try {
  execFileSync('rm', ['-rf', tmp]);
} catch {
  /* a temp directory is not worth failing over */
}

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m${ran}/${ran} passed\x1b[0m`);
process.exit(0);
