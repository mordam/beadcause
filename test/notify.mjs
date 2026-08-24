#!/usr/bin/env node
/**
 * An ntfy action button has to carry which option was tapped, not just its sentence.
 *
 *     npm test
 *     node test/notify.mjs
 *
 * bc-7qo.20. `lib/notify.js` builds each ntfy action button as a POST to
 * `/api/respond`. Until this bead the body carried `{ workspace, id, response }` and
 * no `option` field — so `answerShape` in lib/server.js had nothing to look up,
 * `picked` came back null, and the answer took the ordinary closing path whatever the
 * option actually said about itself. A `closes: false` commission closed anyway; a
 * `defers: true` "not yet" (bc-7qo.11) lost the card outright, which is the one thing
 * it exists to prevent — a lock-screen tap doing the opposite of what its own label
 * said.
 *
 * lib/slack.js already sent the right shape — `{ response: option.response, option:
 * option.id }` — so that is the reference this suite checks the ntfy bodies against,
 * and the fix is the same field added in both of `lib/notify.js`'s two builders:
 * `pushQuestion` and `pushFoundationRequest`. There is no test/notify*.mjs or
 * test/ntfy*.mjs before this file, which is why the gap survived three separate
 * filings (bc-7qo.20 itself, and its duplicate bc-0nnt).
 *
 * Two groups of checks:
 *
 *   1. **The body itself carries the id**, for both builders — caught with `fetch`
 *      stubbed, the same technique test/datastores.mjs already uses to inspect a
 *      published payload without a real ntfy server.
 *   2. **The body actually works**, driven through a real `/api/respond` exactly as
 *      the acceptance criteria asks: the JSON built by `pushQuestion` for a `closes:
 *      false` option is POSTed for real and must commission rather than close; the
 *      JSON for a `defers: true` option must defer — bead open, `human` label still
 *      on — rather than close. Same fake-`bd`-plus-real-server harness as
 *      test/defer.mjs and test/commission.mjs, so each claim is checked against the
 *      argv bd would have been given rather than against a mock's say-so.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-notify-'));
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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const { toQuestion } = await import(LIB('decision.js'));
const notify = await import(LIB('notify.js'));

/* -------------------------------------------------------- the fixture bead */

// Three options, the same three endings test/defer.mjs and test/commission.mjs pin
// separately: an ordinary close, a commission (`closes: false`), and a deferral
// (`defers: true`). One card, so a regression that fixes one ending and not the
// others fails here rather than passing everything else.
const DESC = `Which of these, then?

\`\`\`decision
question: Decide it, order it, or leave it on the list?
options:
  - id: settle
    label: The shape is right
    response: "The shape is right. Record it; no code yet."
  - id: build
    label: Build both as written
    response: "Build both, as written."
    closes: false
  - id: park
    label: Not yet
    response: "Not yet. Leave this on the list."
    defers: true
\`\`\`
`;

const bead = { id: 'zz-1', title: 'Decide, order or defer', description: DESC, priority: 1, labels: ['human'] };
const q = toQuestion('demo', bead);
check(() => assert.equal(q.decision.options.length, 3), 'the fixture parses to three options');

/* --------------------------------------------------- the published body, captured */

/** Run a pusher with `fetch` stubbed, and hand back what it would have published. */
async function published(fn) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent.length, 1, 'expected exactly one publish');
  return sent[0];
}

const ntfyCfg = {
  baseUrl: 'http://beadcause.example.ts.net:9000',
  token: 'notify-token-zzz',
  ntfy: { enabled: true, topic: 'topic-zzz', server: 'http://ntfy.invalid', actionButtons: true, detail: 'full', minimalWorkspaces: [] },
};

console.log('\nthe published body carries an option id\n');

const questionBody = await published(() => notify.pushQuestion(ntfyCfg, q));
check(() => assert.equal(questionBody.actions.length, 3), 'pushQuestion builds one action per option');
for (const [i, id] of ['settle', 'build', 'park'].entries()) {
  check(() => {
    const parsed = JSON.parse(questionBody.actions[i].body);
    assert.equal(parsed.option, id, `action ${i} body: ${questionBody.actions[i].body}`);
    assert.equal(parsed.response, q.decision.options[i].response);
  }, `pushQuestion action ${i} (${id}) carries option: '${id}' alongside response`);
}

const foundationQ = { ...q, foundation: true, amendment: { agent: 'worker', scope: 'Change the model tier' } };
const foundationBody = await published(() => notify.pushFoundationRequest(ntfyCfg, foundationQ));
check(() => assert.equal(foundationBody.actions.length, 3), 'pushFoundationRequest builds one action per option too');
for (const [i, id] of ['settle', 'build', 'park'].entries()) {
  check(() => {
    const parsed = JSON.parse(foundationBody.actions[i].body);
    assert.equal(parsed.option, id, `action ${i} body: ${foundationBody.actions[i].body}`);
  }, `pushFoundationRequest action ${i} (${id}) carries option: '${id}' too — the second, easy-to-miss builder`);
}

/* ------------------------------------------------- the body, driven for real */

const CALLS = path.join(tmp, 'calls.log');
const FAKE = path.join(tmp, 'bd');

fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const DESC = ${JSON.stringify(DESC)};
const bead = (id) => ({
  id, issue_type: 'task', status: 'open', title: 'Decide, order or defer', comment_count: 0,
  priority: 1, labels: ['human'], description: DESC, dependencies: [],
});
if (args[0] === 'show') { process.stdout.write(JSON.stringify([bead(args[1])])); process.exit(0); }
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const calls = () =>
  fs.existsSync(CALLS)
    ? fs
        .readFileSync(CALLS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const writes = () => calls().filter((a) => ['comment', 'close', 'update', 'create', 'label'].includes(a[0]));
const reset = () => fs.writeFileSync(CALLS, '');

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'notify-server-token',
  actor: 'beadcause-test',
  bdBin: FAKE,
  workspaces: [{ name: 'demo', dir: ws }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

// Build the notification exactly as the daemon would, against `cfg.baseUrl` and
// `cfg.token` for *this* running server — so the button's own POST target and
// x-beadcause-token header are the ones this suite can actually drive.
const liveCfg = {
  baseUrl: `http://127.0.0.1:${port}`,
  token: cfg.token,
  ntfy: { enabled: true, topic: 't', server: 'http://ntfy.invalid', actionButtons: true, detail: 'full', minimalWorkspaces: [] },
};
const liveBody = await published(() => notify.pushQuestion(liveCfg, q));
const actionFor = (id) => liveBody.actions[['settle', 'build', 'park'].indexOf(id)];

/** POST an action button's own body to its own url, exactly as ntfy's http action would. */
const tap = (action) =>
  new Promise((resolve, reject) => {
    const payload = action.body;
    const url = new URL(action.url);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { ...action.headers, 'content-length': Buffer.byteLength(payload) },
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

console.log('\nthe notification body, tapped for real, through /api/respond\n');

/* ------------------------------------------------------- commission, from a tap */

reset();
const handed = await tap(actionFor('build'));
const handedWrites = writes();
check(() => assert.equal(handed.status, 200, JSON.stringify(handed.json)), 'the build button reaches /api/respond and answers');
check(() => assert.equal(handed.json.handedBack, true), 'a `closes: false` option tapped from the notification hands back');
check(() => assert.equal(handed.json.closed, false), 'and does NOT close — the exact loss bc-7qo.20 exists to fix');
check(
  () => assert.ok(!handedWrites.some((a) => a[0] === 'close'), `bd was told to: ${JSON.stringify(handedWrites)}`),
  'and bd is never told to close it'
);
check(
  () => assert.ok(handedWrites.some((a) => a[0] === 'label' && a[1] === 'remove' && a[3] === 'human'), `bd was told to: ${JSON.stringify(handedWrites)}`),
  'and it still leaves the inbox — the `human` label comes off, exactly as an in-app commission does'
);

/* --------------------------------------------------------- deferral, from a tap */

reset();
const parked = await tap(actionFor('park'));
const parkedWrites = writes();
check(() => assert.equal(parked.status, 200, JSON.stringify(parked.json)), 'the park button reaches /api/respond and answers');
check(() => assert.equal(parked.json.deferred, true), 'a `defers: true` option tapped from the notification defers');
check(() => assert.equal(parked.json.closed, false), 'and does NOT close — bc-7qo.11 is worthless from a lock screen without this');
check(
  () => assert.ok(!parkedWrites.some((a) => a[0] === 'close'), `bd was told to: ${JSON.stringify(parkedWrites)}`),
  'and bd is never told to close it'
);
check(
  () =>
    assert.ok(
      !parkedWrites.some((a) => a[0] === 'label' && a[1] === 'remove' && a[3] === 'human'),
      `bd was told to: ${JSON.stringify(parkedWrites)}`
    ),
  'and the `human` label STAYS — the card is still in the inbox, exactly as the acceptance criteria asks'
);

/* --------------------------------------------------------- an ordinary tap still closes */

reset();
const closed = await tap(actionFor('settle'));
check(() => assert.equal(closed.json.closed, true), 'an ordinary option tapped from the notification still closes');
check(
  () =>
    assert.deepEqual(
      writes().map((a) => a[0]),
      ['comment', 'close'],
      `bd was told to: ${JSON.stringify(writes())}`
    ),
  'comment then close, exactly as an in-app answer does'
);

for (const s of servers || []) s.close?.();
await cleanupTmp(tmp);

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
