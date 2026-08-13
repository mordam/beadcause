#!/usr/bin/env node
/**
 * **Ship it** — the answer that merges *and* deploys, end to end through the daemon.
 *
 *     npm test
 *     node test/ship.mjs
 *
 * `test/delivery.mjs` proves `SHIP:` is a distinct word and that the card offers it
 * only where there is a deploy. This proves what happens when it is answered, which is
 * a different claim and the one with teeth: a real `POST /api/respond`, a real
 * `createApp`, a fake `bd` and a fake `gh`, and a declared deploy whose command is a
 * script that writes a file. Nothing here restarts anything.
 *
 * Four failures are worth the file, and the first is the one this whole shape exists
 * for.
 *
 * 1. **The deploy running before the answer is written.** A beadcause deploy SIGKILLs
 *    beadcause, mid-request. If it starts before `bd respond` has closed the question,
 *    the process can die between the merge and the answer — leaving a merged pull
 *    request behind an open question that says nothing happened. So the deploy command
 *    here copies the fake `bd`'s call log at the moment it runs, and the assertion is
 *    that the answer was already in it. A clock could not prove this; the log can.
 * 2. **Merge quietly widening into ship.** `MERGE:` must deploy nothing at all, ever,
 *    and the assertion is the absence of a record — the only way that regression is
 *    ever visible, since a merge that also deployed still looks like a merge.
 * 3. **Free text doing either.** The consent model is `startsWith` on a marker and
 *    nothing else, and this checks it at the endpoint rather than at the parser: an
 *    ordinary comment on a delivery card must reach neither `gh` nor a deploy.
 * 4. **A missing declaration eating the merge.** Ship in a repo with no `deploys`
 *    entry has to merge anyway and say why nothing deployed. Refusing the merge over a
 *    config entry would be the worst possible reading of "ship it" — the merge is the
 *    half that was asked for by both buttons.
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

/** Wait for `fn` to stop throwing, or give up. Deploys are another process. */
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
const SHIPPABLE = deliveryBody(DELIVERY, { ship: 'runs `writer` · restarts beadcause' });
const PLAIN = deliveryBody({ ...DELIVERY, workspace: 'bare' });

const QUESTIONS = path.join(tmp, 'questions.json');
fs.writeFileSync(QUESTIONS, JSON.stringify({ 'zz-pr': SHIPPABLE, 'bb-pr': PLAIN }));

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const bodies = JSON.parse(fs.readFileSync(${JSON.stringify(QUESTIONS)}, 'utf8'));
if (args[0] === 'show') {
  const id = args[1];
  process.stdout.write(JSON.stringify([{
    id, issue_type: 'task', status: 'open', title: 'Merge #7?', comment_count: 0,
    labels: ['human', 'pr-delivery'], dependencies: [],
    description: bodies[id] || '',
  }]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const calls = () =>
  fs.existsSync(CALLS)
    ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const resetCalls = () => fs.writeFileSync(CALLS, '');

/* ------------------------------------------------------------------- fake gh */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const GH_LOG = path.join(tmp, 'gh-calls.log');
const PR_STATE = path.join(tmp, 'pr.json');

const rawPR = () => ({
  number: 7,
  title: 'Something small',
  url: 'https://github.com/acme/widgets/pull/7',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
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
const resetPR = () => fs.writeFileSync(PR_STATE, JSON.stringify(rawPR()));
resetPR();

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + '\\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
const fail = (s) => { process.stderr.write(s + '\\n'); process.exit(1); };
if (args[0] === 'auth') out('Logged in to github.com\\n');
if (args[0] === 'pr') {
  const pr = JSON.parse(fs.readFileSync(${JSON.stringify(PR_STATE)}, 'utf8'));
  if (args[1] === 'view') out(JSON.stringify(pr));
  if (args[1] === 'merge') {
    pr.state = 'MERGED';
    pr.mergedAt = '2026-08-10T12:00:00Z';
    pr.mergeCommit = { oid: 'abcdef0123456789' };
    fs.writeFileSync(${JSON.stringify(PR_STATE)}, JSON.stringify(pr));
    out('Merged pull request #7\\n');
  }
  if (args[1] === 'close' || args[1] === 'comment') out('done\\n');
}
fail('unknown gh invocation: ' + args.join(' '));
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const ghCalls = () =>
  fs.existsSync(GH_LOG)
    ? fs.readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const resetGh = () => fs.writeFileSync(GH_LOG, '');

/* ------------------------------------------------------- the "deploy" command */

/**
 * The deploy, which restarts nothing and proves the ordering instead.
 *
 * It copies the fake `bd`'s call log the instant it runs. That file is the evidence
 * for the claim this whole test exists to make: by the time the deploy started, the
 * answer had already been written and the question already closed — so a deploy that
 * kills the daemon a moment later cannot lose either of them.
 */
const DEPLOYED = path.join(tmp, 'deployed.json');
const WRITER = path.join(BIN, 'writer');
fs.writeFileSync(
  WRITER,
  `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(DEPLOYED)}, fs.existsSync(${JSON.stringify(CALLS)}) ? fs.readFileSync(${JSON.stringify(CALLS)}, 'utf8') : '');
`,
  { mode: 0o755 }
);

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
  // Only `demo` can be deployed. `bare` is every repo that declares nothing, which is
  // most of them, and is what the fourth case is about.
  deploys: {
    demo: { command: [WRITER], dir: wsDir, pull: false, graceMs: 0, restarts: false },
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
  resetPR();
  try {
    fs.unlinkSync(DEPLOYED);
  } catch {
    /* first run */
  }
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

console.log('\nship it\n');

/* ------------------------------------------------------------ merge only */

reset();
const merged = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-pr',
  response: 'MERGE: squash and merge #7, then close zz-work.',
});

await check(() => assert.equal(merged.status, 200), 'MERGE: is answered');
await check(
  () => assert.ok(ghCalls().some((a) => a[0] === 'pr' && a[1] === 'merge'), JSON.stringify(ghCalls())),
  'and the pull request is merged');
await check(() => assert.equal(merged.json.delivery.action, 'merge'), 'and the answer says it was a merge');
await check(
  () => assert.ok(calls().some((a) => a[0] === 'close' && a[1] === 'zz-work'), JSON.stringify(calls())),
  'and the work bead is closed with it');
// The whole of case 2: the absence of a record is the only visible form of this bug.
await check(async () => {
  await sleep(200);
  assert.deepEqual(listDeploys(), []);
  assert.equal(merged.json.deploy, null);
}, 'and NOTHING is deployed — merge never widens into ship');

/* ----------------------------------------------------------------- ship it */

reset();
const shipped = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-pr',
  response: 'SHIP: squash and merge #7, then deploy demo.',
});

await check(() => assert.equal(shipped.status, 200), 'SHIP: is answered');
await check(
  () => assert.ok(ghCalls().some((a) => a[0] === 'pr' && a[1] === 'merge'), JSON.stringify(ghCalls())),
  'and it merges exactly the same pull request merge does');
await check(() => assert.equal(shipped.json.delivery.action, 'ship'), 'and the answer says it was a ship');
await check(
  () => assert.ok(calls().some((a) => a[0] === 'close' && a[1] === 'zz-work'), JSON.stringify(calls())),
  'the work bead still closes on the merge');
await check(
  () => assert.ok(shipped.json.deploy?.id, JSON.stringify(shipped.json.deploy)),
  'and a deploy comes back on the response, written down before the reply left');
await check(
  () => assert.equal(shipped.json.deploy.workspace, 'demo'),
  'for the workspace the question was in');

const record = await until(() => {
  const rec = listDeploys()[0];
  assert.ok(rec && rec.status === 'ok', `still ${rec ? rec.status : 'absent'}`);
  return rec;
});
await check(() => assert.equal(record.status, 'ok'), 'the runner outlives the request and settles the deploy');
await check(() => assert.equal(record.bead, 'zz-work'), 'the record names the bead that was shipped');
await check(() => assert.match(record.reason, /#7/), 'and the pull request it came from');

// Case 1, the reason this file is an HTTP test rather than a unit test.
const sawWhenDeploying = JSON.parse(`[${fs.readFileSync(DEPLOYED, 'utf8').trim().split('\n').join(',')}]`);
await check(
  () =>
    assert.ok(
      sawWhenDeploying.some((a) => a[0] === 'close' && a[1] === 'zz-work'),
      JSON.stringify(sawWhenDeploying)
    ),
  'by the time the deploy ran, the work bead was already closed');
await check(
  () =>
    assert.ok(
      sawWhenDeploying.some((a) => (a[0] === 'comment' || a[0] === 'close' || a[0] === 'update') && a[1] === 'zz-pr'),
      JSON.stringify(sawWhenDeploying)
    ),
  'and the question was already answered — nothing durable is riding on this process surviving');

/* ------------------------------------------------- a repo with nothing declared */

reset();
const bare = await call('/api/respond', {
  workspace: 'bare',
  id: 'bb-pr',
  response: 'SHIP: squash and merge #7, then deploy bare.',
});

await check(() => assert.equal(bare.status, 200), 'ship in a repo with no deploy is not an error');
await check(
  () => assert.ok(ghCalls().some((a) => a[0] === 'pr' && a[1] === 'merge'), JSON.stringify(ghCalls())),
  'the merge still happens — it is the half both buttons asked for');
await check(async () => {
  await sleep(200);
  assert.deepEqual(listDeploys(), []);
  assert.equal(bare.json.deploy, null);
}, 'and nothing is deployed');
await check(() => {
  const answer = calls().find((a) => (a[0] === 'comment' || a[0] === 'close') && a[1] === 'bb-pr');
  assert.ok(answer, JSON.stringify(calls()));
  assert.match(answer.join(' '), /Not deployed/, answer.join(' '));
  assert.match(answer.join(' '), /no deploy is declared for bare/, answer.join(' '));
}, 'and the answer on the bead says why, rather than implying it shipped');

/* ------------------------------------------------------------------ free text */

reset();
const comment = await call('/api/respond', { workspace: 'demo', id: 'zz-pr', response: 'looks good, ship it' });

await check(() => assert.equal(comment.status, 200), 'an ordinary comment on a delivery card is accepted');
await check(
  () => assert.ok(!ghCalls().some((a) => a[0] === 'pr' && a[1] === 'merge'), JSON.stringify(ghCalls())),
  'and merges nothing, even saying the words');
await check(async () => {
  await sleep(200);
  assert.deepEqual(listDeploys(), []);
}, 'and deploys nothing either — consent is the marker and nothing else');

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
