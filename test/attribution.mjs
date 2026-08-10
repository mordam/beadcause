#!/usr/bin/env node
/**
 * Whose answer is it? — the half of sign-in that shows up in a log six months later.
 *
 *     npm test
 *     node test/attribution.mjs
 *
 * bc-lza gave a browser an identity: a Google session cookie, beside the shared token
 * and never instead of it (lib/auth.js). Nothing used it. Every answer, comment and
 * dismissal note went onto a bead as `beadcause`, so the thread could not say whether
 * it came from Adam signed in on his phone, from a token in an ntfy action button, or
 * from an agent — and "it has no identity attached" was one of the three reasons
 * sign-in was asked for in the first place.
 *
 * So the write paths take an actor now, and this file holds both halves of the deal:
 *
 *   - **a signed-in browser puts its address on the bead** — on the comment and on
 *     the close, which are one act and must not read as two people;
 *   - **a token caller is written exactly as it always was.** That is the load-bearing
 *     one. Almost nothing that talks to this daemon can hold a cookie: an ntfy action
 *     button POSTs from the notification shade, lib/notify.js calls back with the
 *     token, the Android app is Kotlin, `scripts/shot.mjs` drives a headless Chrome.
 *     A change that quietly made attribution *require* a session would show up as
 *     those callers writing beads under somebody else's name, or not at all.
 *
 * And the case that is easy to get backwards: **a request carrying both wins with the
 * session.** The phone is signed in *and* holds a pairing token in localStorage, which
 * it sends on every fetch — so token-first would mean the attribution never once
 * applied to the device it was built for.
 *
 * The sign-in dance itself is not re-driven here; `test/auth.mjs` does that end to end.
 * What a signed-in browser holds afterwards is a cookie signed with the session key, so
 * this file mints one directly and spends it, which is the same request the dance would
 * have produced.
 *
 * The real `bd` is never run: `cfg.bdBin` points at a fake that records the argv *and*
 * `BEADS_ACTOR` for every call, because attribution rides on both (see lib/bd.js — a
 * workspace `config.yaml` can beat the env var, which is why the flag exists at all).
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-attribution-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// Fixed, so the cookie this file signs is the cookie the server verifies and a failure
// here is never a race between two processes making a key file.
process.env.BEADCAUSE_SESSION_KEY = 'test-session-key-not-a-secret';
process.env.BEADCAUSE_GOOGLE_CLIENT_SECRET = 'test-client-secret-not-a-secret';

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

const SIGNED_IN = 'adam@example.com';
const DAEMON = 'beadcause-test';

/* -------------------------------------------------------------- the fake bd */

// One line per call: the argv, and the BEADS_ACTOR it was spawned with. Both, because
// `Bd.run` sets both and a change that updated only one would be a bead attributed
// correctly in every workspace except the ones that pin an actor in `config.yaml` —
// which is the failure the `--actor` flag was added for.
const CALLS = path.join(tmp, 'calls.log');
const FAKE = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, env: process.env.BEADS_ACTOR || null }) + '\\n');
const bead = (id) => ({
  id, issue_type: 'task', status: 'open', title: 'An ordinary question', comment_count: 2,
  priority: 1, labels: ['human'], description: 'Which way?', dependencies: [],
});
if (args[0] === 'show') { process.stdout.write(JSON.stringify([bead(args[1])])); process.exit(0); }
if (args[0] === 'human' && args[1] === 'list') { process.stdout.write(JSON.stringify([bead('zz-1')])); process.exit(0); }
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
const reset = () => fs.writeFileSync(CALLS, '');

/** Everything bd was told to *write*. `show`/`comments`/`human list` are reads. */
const writes = () => calls().filter((c) => ['comment', 'close', 'update', 'create', 'label'].includes(c.args[0]));

/** The `--actor` on each write of this kind, in order. */
const actorsFor = (verb) =>
  writes()
    .filter((c) => c.args[0] === verb)
    .map((c) => {
      const at = c.args.lastIndexOf('--actor');
      return at === -1 ? null : c.args[at + 1];
    });

/** And what BEADS_ACTOR said for the same calls, which must agree with the flag. */
const envFor = (verb) =>
  writes()
    .filter((c) => c.args[0] === verb)
    .map((c) => c.env);

/* ----------------------------------------------------------------- the app */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const BASE = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'attribution-token',
  actor: DAEMON,
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
const { sign } = await import(LIB('auth.js'));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Sign-in on, with an explicit http redirect URI so `tailscale cert` stays out of it. */
const onPort = await freePort();
const onCfg = {
  ...BASE,
  port: onPort,
  auth: {
    google: {
      enabled: true,
      clientId: 'cid.apps.googleusercontent.com',
      allowed: [SIGNED_IN],
      redirectUri: `http://127.0.0.1:${onPort}/auth/google/callback`,
      sessionDays: 30,
    },
  },
};
const onServers = listen(onCfg, createApp(onCfg).handler);

/** The same daemon with sign-in never configured — every install, by default. */
const offPort = await freePort();
const offCfg = { ...BASE, port: offPort };
const offServers = listen(offCfg, createApp(offCfg).handler);

const post = (port, pathname, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
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

const up = async (port) => {
  for (let i = 0; i < 100; i += 1) {
    try {
      await post(port, '/api/nothing', {});
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
};
await up(onPort);
await up(offPort);

/** What a browser holds after the dance in test/auth.mjs — nothing more than this. */
const sessionCookie = (email, { seconds = 3600 } = {}) =>
  `beadcause_session=${sign(
    { sub: 'sub-1', email, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + seconds },
    process.env.BEADCAUSE_SESSION_KEY
  )}`;

const TOKEN = { 'x-beadcause-token': BASE.token };
const COOKIE = { cookie: sessionCookie(SIGNED_IN) };

/* ------------------------------------------------------------------ answering */

console.log('\nanswering — the address on the bead\n');

reset();
{
  const r = await post(onPort, '/api/respond', { workspace: 'demo', id: 'zz-1', response: 'The second one.' }, COOKIE);
  check(() => assert.equal(r.status, 200), 'a signed-in browser can answer with no token at all');
  check(() => assert.deepEqual(actorsFor('comment'), [SIGNED_IN]), 'and the answer is written as the address that gave it');
  check(
    () => assert.deepEqual(actorsFor('close'), [SIGNED_IN]),
    'and so is the close — one act, and two names would read as two people'
  );
  check(
    () => assert.deepEqual(envFor('comment'), [SIGNED_IN]),
    'BEADS_ACTOR agrees with the flag, so a workspace pinning an actor cannot disagree'
  );
}

reset();
{
  const r = await post(onPort, '/api/respond', { workspace: 'demo', id: 'zz-1', response: 'The second one.' }, TOKEN);
  check(() => assert.equal(r.status, 200), 'the same answer over the shared token still lands');
  check(
    () => assert.deepEqual(actorsFor('comment'), [DAEMON]),
    'and is written exactly as it is today — the token has no identity to name'
  );
  check(() => assert.deepEqual(actorsFor('close'), [DAEMON]), 'close included');
}

reset();
{
  // The phone: signed in, and still sending the token it was paired with. Token-first
  // would mean this feature never applied to the one device it was built for.
  const r = await post(
    onPort,
    '/api/respond',
    { workspace: 'demo', id: 'zz-1', response: 'Both, then.' },
    { ...TOKEN, ...COOKIE }
  );
  check(() => assert.equal(r.status, 200), 'a request carrying both credentials is fine');
  check(() => assert.deepEqual(actorsFor('comment'), [SIGNED_IN]), 'and the session wins — a name beats an anonymous token');
}

/* ------------------------------------------------------------------ commenting */

console.log('\ncommenting and dismissing\n');

reset();
{
  const r = await post(onPort, '/api/comment', { workspace: 'demo', id: 'zz-1', text: 'What about the third?' }, COOKIE);
  check(() => assert.equal(r.status, 200), 'commenting from a signed-in browser works');
  check(() => assert.deepEqual(actorsFor('comment'), [SIGNED_IN]), 'and the comment carries the address');
  check(
    // The label is the daemon moving the bead between two queues, not anybody
    // speaking. Attribution is for what a person said.
    () => assert.deepEqual(actorsFor('label'), [DAEMON]),
    'the `human-replied` label stays the daemon’s — it is bookkeeping, not a sentence'
  );
}

reset();
{
  const r = await post(onPort, '/api/comment', { workspace: 'demo', id: 'zz-1', text: 'From the shade.' }, TOKEN);
  check(() => assert.equal(r.status, 200), 'and over the token');
  check(() => assert.deepEqual(actorsFor('comment'), [DAEMON]), 'written as beadcause, unchanged');
}

reset();
{
  const r = await post(
    onPort,
    '/api/dismiss',
    { workspace: 'demo', id: 'zz-1', reason: 'Not until the children land' },
    COOKIE
  );
  check(() => assert.equal(r.status, 200), 'dismissing with a note works');
  check(() => assert.deepEqual(actorsFor('comment'), [SIGNED_IN]), 'and the note is yours, not the daemon’s');
  check(() => assert.deepEqual(actorsFor('close'), []), 'and it is still not a close');
}

reset();
{
  const r = await post(offPort, '/api/dismiss', { workspace: 'demo', id: 'zz-1' }, TOKEN);
  check(() => assert.equal(r.status, 200), 'a wordless dismissal still writes nothing at all');
  check(() => assert.deepEqual(writes(), []), 'no comment, no close, and therefore nothing to attribute');
}

/* ----------------------------------------------------- when there is no identity */

console.log('\nno identity to attach — the default install\n');

reset();
{
  // Sign-in is not configured, which is every install until somebody configures it.
  // A cookie on the request is meaningless there, and must not become meaningful.
  const r = await post(
    offPort,
    '/api/respond',
    { workspace: 'demo', id: 'zz-1', response: 'Fine.' },
    { ...TOKEN, ...COOKIE }
  );
  check(() => assert.equal(r.status, 200), 'with sign-in off, a token answer lands as before');
  check(
    () => assert.deepEqual(actorsFor('comment'), [DAEMON]),
    'and a session cookie means nothing — sign-in off is the whole of it being off'
  );
}

reset();
{
  // An expired cookie is not a session (lib/auth.js returns null for every way a
  // cookie can be wrong), so the request falls back to the token and to `beadcause`
  // rather than half-attributing to a name nobody proved.
  const stale = { cookie: sessionCookie(SIGNED_IN, { seconds: -60 }) };
  const r = await post(onPort, '/api/respond', { workspace: 'demo', id: 'zz-1', response: 'Fine.' }, { ...TOKEN, ...stale });
  check(() => assert.equal(r.status, 200), 'an expired session plus a token still answers');
  check(() => assert.deepEqual(actorsFor('comment'), [DAEMON]), 'as beadcause — an expired cookie names nobody');
}

reset();
{
  // And an expired cookie with no token is not a credential either. This is the gate
  // rather than the attribution, but it is the assertion that would catch attribution
  // being read *before* the gate one day.
  const stale = { cookie: sessionCookie(SIGNED_IN, { seconds: -60 }) };
  const r = await post(onPort, '/api/respond', { workspace: 'demo', id: 'zz-1', response: 'Fine.' }, stale);
  check(() => assert.equal(r.status, 401), 'and on its own it does not get in');
  check(() => assert.deepEqual(writes(), []), 'having written nothing');
}

for (const s of [...(onServers || []), ...(offServers || [])]) s.close?.();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
