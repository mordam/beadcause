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
import { spawnSync } from 'node:child_process';
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

/**
 * The bodies the fake serves from `bd show`, so a card that needs a block in its
 * description can have one. Built from the real parsers' own writers further down, so
 * a fixture cannot drift away from what the server parses.
 */
const BODIES = path.join(tmp, 'bodies.json');
const SEQ = path.join(tmp, 'seq');
fs.writeFileSync(BODIES, '{}');

fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, env: process.env.BEADS_ACTOR || null }) + '\\n');
const bodies = JSON.parse(fs.readFileSync(${JSON.stringify(BODIES)}, 'utf8'));
const bead = (id) => ({
  id, issue_type: 'task', status: 'open', title: 'An ordinary question', comment_count: 2,
  priority: 1, labels: ['human'], description: bodies[id] || 'Which way?', dependencies: [],
});
if (args[0] === 'show') { process.stdout.write(JSON.stringify([bead(args[1])])); process.exit(0); }
if (args[0] === 'human' && args[1] === 'list') { process.stdout.write(JSON.stringify([bead('zz-1')])); process.exit(0); }
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
// A create has to come back with an id or the handler reports a 502 and writes
// nothing — which would pass a test asserting only that nothing went wrong.
if (args[0] === 'create') {
  let n = 0;
  try { n = Number(fs.readFileSync(${JSON.stringify(SEQ)}, 'utf8')) || 0; } catch {}
  n += 1;
  fs.writeFileSync(${JSON.stringify(SEQ)}, String(n));
  process.stdout.write(JSON.stringify({ id: 'zz-new' + n }));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/** Give an id a description for the length of one case. */
const bodyFor = (map) => fs.writeFileSync(BODIES, JSON.stringify(map));

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

/**
 * The `--actor` on every call bd was given, write or not — including the ones the
 * `writes` filter deliberately leaves out, `dep` among them. What the bookkeeping
 * assertions need: proving a call was *not* attributed means finding it first.
 */
const actorsForAny = (verb, sub = null) =>
  calls()
    .filter((c) => c.args[0] === verb && (sub === null || c.args[1] === sub))
    .map((c) => {
      const at = c.args.lastIndexOf('--actor');
      return at === -1 ? null : c.args[at + 1];
    });

/* ------------------------------------------------------------------ fake gh */

/**
 * Enough `gh` for a pull request's verdict to be given: the auth probe lib/pr.js
 * starts with, the view behind it, and the three acts. It writes nothing anywhere —
 * what is being asserted here is what reached *bd*, not what reached GitHub.
 */
const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const PR_STATE = path.join(tmp, 'pr.json');
fs.writeFileSync(
  PR_STATE,
  JSON.stringify({
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
  })
);
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
    pr.mergeCommit = { oid: 'abcdef0123456789' };
    fs.writeFileSync(${JSON.stringify(PR_STATE)}, JSON.stringify(pr));
    out('Merged pull request #7\\n');
  }
  if (args[1] === 'close' || args[1] === 'comment') out('done\\n');
}
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

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
  // A checkout for the workspace, which a delivery needs before it will act on a pull
  // request at all, and which the console resolves its working directory from.
  sessionDirs: { demo: ws },
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

/* ---------------------------------------------------------- filing the beads */

/**
 * The category bc-vq21 left open, and the reason it was left open was wrong.
 *
 * The worry was that `--actor` would set a created bead's `owner` — which is read as
 * *whose queue this is*, by `bd ready` and by the agents list — and quietly move new
 * work out of the advocate's reach. It does not. `--actor` writes `created_by`, a
 * byline, and `owner` comes from the git identity of the directory bd runs in. The
 * real-bd case at the bottom of this file is what proves that; these assert that the
 * paths pass an actor at all.
 */
console.log('\nfiling beads — the byline on a create\n');

reset();
{
  const r = await post(onPort, '/api/ask', { workspace: 'demo', title: 'Look at this', body: 'From the share sheet.' }, COOKIE);
  check(() => assert.equal(r.status, 200), 'the share target files a question from a signed-in browser');
  check(() => assert.deepEqual(actorsFor('create'), [SIGNED_IN]), 'and it is filed under the address that filed it');
  check(() => assert.deepEqual(envFor('create'), [SIGNED_IN]), 'BEADS_ACTOR agreeing, as everywhere else');
}

reset();
{
  const r = await post(onPort, '/api/ask', { workspace: 'demo', title: 'From the shade' }, TOKEN);
  check(() => assert.equal(r.status, 200), 'and over the token, which is how the Android share target arrives');
  check(() => assert.deepEqual(actorsFor('create'), [DAEMON]), 'filed as beadcause, exactly as before');
}

reset();
{
  // The console: a conversation about what to file, then one button that files it.
  // Unseeded, so nothing spawns — `sendTurn` is only reached by a seeded console.
  const opened = await post(onPort, '/api/console', { workspace: 'demo' }, COOKIE);
  check(() => assert.equal(opened.status, 200), 'a chat session opens');
  const draft = {
    beads: [
      { ref: 'a', title: 'The first one', description: 'Because.', type: 'task', priority: 2 },
      { ref: 'b', title: 'The second one', description: 'And this.', type: 'task', priority: 2, dependsOn: ['a'] },
    ],
  };
  await post(onPort, '/api/console/draft', { id: opened.json.id, draft }, COOKIE);
  reset();
  const made = await post(onPort, '/api/console/create', { id: opened.json.id, draft }, COOKIE);
  check(() => assert.equal(made.status, 200), 'and the button files what was on screen');
  check(
    () => assert.deepEqual(actorsFor('create'), [SIGNED_IN, SIGNED_IN]),
    'every bead it files carries the address that pressed it'
  );
  check(
    // Wiring two beads together is not a sentence anybody said. Same rule that left
    // the `human-replied` label alone.
    () => assert.deepEqual(actorsForAny('dep', 'add'), [DAEMON]),
    'the `bd dep add` between them stays the daemon’s — that is plumbing, not a byline'
  );
}

reset();
{
  // An advocate's proposal: the agent wrote the words, the approval made the beads.
  const { APPROVE_MARKER } = await import(LIB('proposal.js'));
  bodyFor({
    'zz-prop': [
      'The advocate would like to file these.',
      '',
      '```beadproposal',
      'workspace: demo',
      'beads:',
      '  - title: Cache-bust site.js',
      '    type: task',
      '    priority: 2',
      '    description: |',
      '      No ?v= on the script tag.',
      '    acceptance: A deploy changes the URL.',
      '    rationale: Found while reading the template.',
      '```',
    ].join('\n'),
  });
  const r = await post(onPort, '/api/respond', { workspace: 'demo', id: 'zz-prop', response: `${APPROVE_MARKER} yes` }, COOKIE);
  check(() => assert.equal(r.status, 200), 'approving a proposal creates what it proposed');
  check(
    () => assert.deepEqual(actorsFor('create'), [SIGNED_IN]),
    'and the bead records who approved it — the `advocate` label still says who proposed it'
  );
  check(
    () => assert.deepEqual(actorsFor('comment'), [SIGNED_IN]),
    'the answer on the proposal is yours too, as it already was'
  );
  bodyFor({});
}

/* -------------------------------------------------- the verdict on a pull request */

/**
 * The other category left open: the notes a delivery leaves on the *work* bead.
 *
 * The wrapper around each is the daemon's, but the direction inside it is verbatim
 * what you typed, and "who asked for changes" is the first thing the next session
 * wants to know. The reopen beside them is not attributed — putting a bead back in
 * the queue is bookkeeping, and that line has not moved.
 */
console.log('\na pull request’s verdict\n');

const { deliveryBody, CHANGES_MARKER, DECLINE_MARKER, MERGE_MARKER } = await import(LIB('delivery.js'));
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

reset();
{
  bodyFor({ 'zz-pr': deliveryBody(DELIVERY) });
  const r = await post(
    onPort,
    '/api/respond',
    { workspace: 'demo', id: 'zz-pr', response: `${CHANGES_MARKER} the second helper is doing two things` },
    COOKIE
  );
  check(() => assert.equal(r.status, 200), 'asking for changes from a signed-in browser works');
  check(
    // Two comments: the note on the work bead, and the answer on the question. Both
    // yours, and the first is the one this bead was about.
    () => assert.deepEqual(actorsFor('comment'), [SIGNED_IN, SIGNED_IN]),
    'the note on the work bead is yours — a next session can see who asked'
  );
  check(
    () => assert.deepEqual(actorsForAny('update'), [DAEMON]),
    'the reopen-and-unclaim beside it is not — returning a bead to the queue is bookkeeping'
  );
}

reset();
{
  bodyFor({ 'zz-pr': deliveryBody(DELIVERY) });
  const r = await post(
    onPort,
    '/api/respond',
    { workspace: 'demo', id: 'zz-pr', response: `${DECLINE_MARKER} start from the router instead` },
    TOKEN
  );
  check(() => assert.equal(r.status, 200), 'and declining over the token still lands');
  check(
    () => assert.deepEqual(actorsFor('comment'), [DAEMON, DAEMON]),
    'written as beadcause — the token names nobody, here as anywhere else'
  );
}

reset();
{
  bodyFor({ 'zz-pr': deliveryBody(DELIVERY) });
  const r = await post(onPort, '/api/respond', { workspace: 'demo', id: 'zz-pr', response: `${MERGE_MARKER} in it goes` }, COOKIE);
  check(() => assert.equal(r.status, 200), 'merging from a signed-in browser works');
  check(
    // One tap closes two beads: the question because it was answered, and the work
    // because it landed. Two names across them would read as two people.
    () => assert.deepEqual(actorsFor('close'), [SIGNED_IN, SIGNED_IN]),
    'both closes are yours — the work bead and the question are one act'
  );
  bodyFor({});
}

/* ------------------------------------------------- against the real bd binary */

/**
 * The claim the whole create decision rests on, asked of the thing that decides it.
 *
 * Every assertion above is about the argv beadcause produces. This one is about what
 * `bd` does with it, and no fake can answer it honestly: that `--actor` on a create
 * writes `created_by` and leaves `owner` alone, so an attributed bead is in the same
 * queue as an unattributed one and `bd ready` still hands it to the advocate. If that
 * were false, every create above would be quietly filing work where nothing would
 * pick it up — which is exactly what bc-5l8s was afraid of.
 *
 * Skipped, loudly, where `bd` is not installed. A machine without the tracker cannot
 * answer the question, and failing there would say something untrue about the code.
 */
console.log('\nwhat bd actually does with --actor on a create\n');

const bdOnPath = (() => {
  const r = spawnSync('bd', ['version'], { encoding: 'utf8' });
  return !r.error;
})();

if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what it does with --actor cannot be asked here');
} else {
  const real = path.join(tmp, 'realws');
  fs.mkdirSync(path.join(real, '.beads'), { recursive: true });
  // Spawned directly, never through a shell: `~/.zshenv` rewrites BEADS_DIR from the
  // shell's cwd, so a shell here would resolve to somebody's actual tracker. This is
  // the same reason lib/bd.js uses execFile — see the note at the top of it.
  const env = { ...process.env, BEADS_DIR: path.join(real, '.beads') };
  const bdRun = (args) => spawnSync('bd', args, { env, cwd: real, encoding: 'utf8', timeout: 60000 });

  const init = bdRun(['init', '--skip-agents', '--prefix', 'at']);
  if (init.status !== 0) {
    bad('a temp workspace can be made to ask in', (init.stderr || init.stdout || '').split('\n')[0]);
  } else {
    const { Bd } = await import(LIB('bd.js'));
    const realBd = new Bd({ bin: 'bd', actor: DAEMON });
    const realWs = { name: 'real', dir: path.join(real, '.beads') };

    // The two creates beadcause now makes: one from a signed-in browser, one from a
    // token caller. Everything else about them is identical.
    const mine = await realBd.create(realWs, { title: 'Filed from a phone', labels: [], priority: 2 }, { actor: SIGNED_IN });
    const theirs = await realBd.create(realWs, { title: 'Filed by the daemon', labels: [], priority: 2 });

    const rows = (await realBd.json(realWs, ['list', '--limit', '0'])) || [];
    const row = (id) => rows.find((r) => r.id === id) || {};

    check(() => assert.ok(mine && theirs), 'both creates come back with an id');
    check(
      () => assert.equal(row(mine).created_by, SIGNED_IN),
      '`--actor` lands in created_by — which is a byline, and is the whole point'
    );
    check(() => assert.equal(row(theirs).created_by, DAEMON), 'and the daemon’s create still says beadcause');
    check(
      // The assertion bc-5l8s turned on. If `owner` moved with the actor, an attributed
      // bead would belong to a different queue than the one that asked for it.
      () => assert.equal(row(mine).owner, row(theirs).owner),
      'and `owner` is identical across the two — the flag does not touch it'
    );

    const ready = await realBd.ready(realWs, { excludeLabel: 'human' });
    check(
      () => assert.ok(ready.some((r) => r.id === mine)),
      'an attributed create still reaches the advocate: `bd ready` offers it'
    );
    check(
      () => assert.equal(ready.some((r) => r.id === mine), ready.some((r) => r.id === theirs)),
      'and offers it on exactly the same terms as an unattributed one'
    );
  }
}

for (const s of [...(onServers || []), ...(offServers || [])]) s.close?.();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
