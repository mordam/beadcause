#!/usr/bin/env node
/**
 * What each of the two ways out of a card is allowed to write.
 *
 *     npm test
 *     node test/closepaths.mjs
 *
 * They are not the same act, and the whole history here is of them being treated as
 * one:
 *
 *   - **Answering** closes the bead, so it has to ask bd's gate first — a bead
 *     blocked by open dependencies, or an epic with open children, cannot be
 *     closed, and finding that out *after* the comment is what put the same answer
 *     on five beads two and three times over.
 *   - **Dismissing closes nothing.** It used to, which was both a promise bd would
 *     refuse and the wrong intent: "I am not dealing with this now" is not "this is
 *     decided", and the card you most want gone — an epic with thirty open children
 *     — is the one bd will least let you close. So it writes your note if you typed
 *     one, writes *nothing at all* if you did not, and never touches the status.
 *
 * `test/closegate.mjs` proves `Bd.closeGate` answers correctly. This proves the
 * endpoints do the right thing with the answer, which is a different claim and the
 * one that kept breaking — the gate was correct the whole time `/api/dismiss` was
 * not calling it, and the browser check could not see that either, because its
 * fixture supplies the response itself.
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
/** The same, for an assertion that has to sweep the inbox to make it. */
const checkAsync = async (fn, name) => {
  try {
    await fn();
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
    id: args[1], issue_type: 'task', status: 'open', title: 'Gated', comment_count: 0,
    dependencies: [{ id: 'zz-9', status: 'open', title: 'Still open', dependency_type: 'blocks' }],
  }]));
  process.exit(0);
}
// The inbox itself. Two questions, so "the dismissed one leaves" can be told apart
// from "the sweep returned nothing".
if (args[0] === 'human' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([
    { id: 'zz-1', title: 'The gated one', status: 'open', priority: 1, issue_type: 'task', labels: ['human'], description: '' },
    { id: 'zz-2', title: 'An ordinary one', status: 'open', priority: 2, issue_type: 'task', labels: ['human'], description: '' },
  ]));
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

// The bead you most want off the screen is the one bd will least let you close. It
// succeeds anyway now, because it is not a close.
reset();
const binned = await call('/api/dismiss', { workspace: 'demo', id: 'zz-1' });
check(() => assert.equal(binned.status, 200), 'dismissing a gated bead succeeds — it is not a close');
check(() => assert.equal(binned.json.closed, false), 'and says so: nothing was closed');
check(
  // The fixture is a blocked bead; `closegate.mjs` covers the epic wording. What is
  // asserted here is that the condition reaches the phone at all — the toast says
  // when the card comes back, and a dismissal that could not say would read as gone.
  () => assert.match(String(binned.json.until || ''), /blocked by zz-9/),
  'naming what it is waiting on, so the toast can say when it comes back'
);
check(
  () => assert.deepEqual(writes(), [], `bd was told to: ${JSON.stringify(writes())}`),
  'a wordless dismissal writes NOTHING to bd — no comment, and above all no close'
);

// The note is the one mark a dismissal leaves, and it is a comment, never a close.
reset();
const withNote = await call('/api/dismiss', { workspace: 'demo', id: 'zz-1', reason: 'Not until the children land' });
check(() => assert.equal(withNote.status, 200), 'a dismissal carrying a note succeeds too');
check(
  () => assert.deepEqual(writes().map((a) => a[0]), ['comment'], `bd was told to: ${JSON.stringify(writes())}`),
  'and writes the note as a comment — one write, and it is not a close'
);
check(
  () => assert.equal(writes()[0][2], 'Not until the children land'),
  'verbatim, with no "Dismissed via Beadcause" wrapper around it'
);

/* -------------------------------------------------- and the card actually goes */

const seen = async () => (await app.allQuestions()).map((r) => r.id);

await checkAsync(async () => {
  const ids = await seen();
  assert.ok(!ids.includes('zz-1'), `still in the inbox: ${ids.join(',')}`);
  assert.ok(ids.includes('zz-2'), `took the wrong one out: ${ids.join(',')}`);
}, 'the dismissed card leaves the inbox, and only that one');

// The gate it was waiting on clears — every child closed — and it comes back. This
// is the whole promise: setting aside is not losing, and a card that never returned
// would be the silent loss this app exists to prevent.
fs.writeFileSync(
  FAKE,
  fs.readFileSync(FAKE, 'utf8').replace(
    "dependencies: [{ id: 'zz-9', status: 'open', title: 'Still open', dependency_type: 'blocks' }],",
    'dependencies: [],'
  ),
  { mode: 0o755 }
);
await checkAsync(async () => {
  const ids = await seen();
  assert.ok(ids.includes('zz-1'), `did not come back: ${ids.join(',')}`);
}, 'and comes back when what it was waiting on clears');

for (const s of servers || []) s.close?.();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
