#!/usr/bin/env node
/**
 * Every endpoint that closes a bead asks the gate first — and writes nothing if
 * bd would refuse.
 *
 *     npm test
 *     node test/closepaths.mjs
 *
 * `test/closegate.mjs` proves `Bd.closeGate` answers correctly. This proves the
 * endpoints actually *ask* it, which is a different claim and the one that broke.
 *
 * The answer path was fixed first. `/api/dismiss` arrived in the same merge window,
 * did the same two writes in the same order — comment, then close — and asked
 * nothing, so it shipped with the identical bug: dv-gr6 collected three
 * "Dismissed via Beadcause" comments, one per attempt, because the comment landed
 * and the close threw and the card came back looking untouched.
 *
 * A per-endpoint assertion is the only shape that catches that. The gate being
 * *correct* said nothing about a caller that never called it, and neither did the
 * browser check — that one drives the phone against a fixture which supplies the
 * 409 itself, so it passes whether or not the real server would send one.
 *
 * The real `bd` is never run: `cfg.bdBin` points at a fake that records every
 * invocation, so "wrote nothing" is checked against the argv it would have used
 * rather than against a tracker.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-closepaths-'));
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

/* -------------------------------------------------------------- the fake bd */

// Every call is appended to this file, one argv per line. `show` answers with an
// issue carrying one still-open `blocks` dependency, which is the sophab case
// (sp-hz3.5) and exactly what bd refuses to close.
const CALLS = path.join(tmp, 'calls.log');
const FAKE = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
if (args[0] === 'show') {
  process.stdout.write(JSON.stringify([{
    id: args[1], issue_type: 'task', status: 'open', title: 'Gated',
    dependencies: [{ id: 'zz-9', status: 'open', title: 'Still open', dependency_type: 'blocks' }],
  }]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
// A close here would be the bug: bd refuses this one, loudly.
if (args[0] === 'close') {
  process.stderr.write('cannot close ' + args[1] + ': blocked by open issues [zz-9] (use --force to override)');
  process.exit(1);
}
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
const reset = () => fs.writeFileSync(CALLS, '');
/** Did bd get told to write anything? `show`/`comments` are reads. */
const writes = () => calls().filter((a) => ['comment', 'close', 'update', 'create', 'label'].includes(a[0]));

/* ----------------------------------------------------------------- the app */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'closepaths-token',
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

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const app = createApp({ ...cfg, port });
const servers = listen({ ...cfg, port }, app.handler);

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

for (let i = 0; i < 100; i += 1) {
  try {
    await call('/api/nothing', {});
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}

console.log('\nclose paths\n');

/* ------------------------------------------------------------------ answer */

reset();
const answered = await call('/api/respond', { workspace: 'demo', id: 'zz-1', response: 'Do your best' });
check(() => assert.equal(answered.status, 409), '/api/respond refuses a bead bd will not close');
check(() => assert.ok(answered.json.gate, `no gate in ${JSON.stringify(answered.json)}`), 'and says which gate');
check(
  () => assert.deepEqual(answered.json.gate.blockers.map((b) => b.id), ['zz-9']),
  'naming the bead in the way'
);
check(
  () => assert.deepEqual(writes(), [], `bd was told to: ${JSON.stringify(writes())}`),
  'having written nothing — no comment, and no close either'
);

/* ----------------------------------------------------------------- dismiss */

// The regression. This endpoint did the same two writes and asked nothing.
reset();
const binned = await call('/api/dismiss', { workspace: 'demo', id: 'zz-1' });
check(() => assert.equal(binned.status, 409), '/api/dismiss refuses it too');
check(() => assert.ok(binned.json.gate, `no gate in ${JSON.stringify(binned.json)}`), 'and says which gate');
check(
  () => assert.deepEqual(writes(), [], `bd was told to: ${JSON.stringify(writes())}`),
  'having written nothing — the three duplicate dismissals came from here'
);
check(
  () => assert.equal(binned.json.canComment, false),
  'a wordless dismissal offers no comment to save'
);

reset();
const withNote = await call('/api/dismiss', { workspace: 'demo', id: 'zz-1', reason: 'Not doing this' });
check(() => assert.equal(withNote.status, 409), 'a dismissal carrying a note is refused the same way');
check(() => assert.equal(withNote.json.canComment, true), 'but that one is worth offering to save');
check(
  () => assert.deepEqual(writes(), [], `bd was told to: ${JSON.stringify(writes())}`),
  'and it is still not written until you ask for it'
);

/* ------------------------------------------------------- and it is not blanket */

// The gate must be a gate, not a wall: with nothing blocking it, the same call goes
// through to bd. The fake still fails the close, so this asserts on what bd was
// ASKED to do rather than on the status — reaching `close` at all is the point.
fs.writeFileSync(
  FAKE,
  fs.readFileSync(FAKE, 'utf8').replace(
    "dependencies: [{ id: 'zz-9', status: 'open', title: 'Still open', dependency_type: 'blocks' }],",
    'dependencies: [],'
  ),
  { mode: 0o755 }
);
reset();
await call('/api/dismiss', { workspace: 'demo', id: 'zz-2' });
check(
  () => assert.ok(calls().some((a) => a[0] === 'close'), `bd was told to: ${JSON.stringify(calls())}`),
  'an unblocked bead still reaches the close — the gate is not a wall'
);

for (const s of servers || []) s.close?.();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
