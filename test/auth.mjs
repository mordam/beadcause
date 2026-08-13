#!/usr/bin/env node
/**
 * Two credentials, and the proof that neither one depends on the other.
 *
 *     npm test
 *     node test/auth.mjs
 *
 * The shared token was the only way in, and Google sign-in is now beside it — see
 * lib/auth.js. Almost everything that talks to this daemon cannot sign into anything:
 * an ntfy action button POSTs an answer straight from the notification shade,
 * lib/notify.js calls back with the token, the Android app is Kotlin, scripts/shot.mjs
 * drives a headless Chrome, and bin/router.js proxies every request over loopback. So
 * the interesting failure is not "sign-in does not work" — it is **sign-in quietly
 * becoming load-bearing for a caller that has no browser**, which would show up as a
 * phone that stops answering questions at three in the morning.
 *
 * So this file asserts both halves in both configurations, deliberately:
 *
 *   - with sign-in OFF, everything is byte-for-byte what it was: the token authorises,
 *     and a page with no credential at all is still served (the app's own token dialog
 *     is what handles that, and it is not this file's business)
 *   - with sign-in ON, the token *still* authorises with no cookie in sight, and a
 *     browser navigation with no credential gets the login page instead
 *
 * The sign-in dance is driven end to end, with Google's token endpoint stubbed at
 * `globalThis.fetch`: authorize → callback → session cookie → an API call carrying only
 * that cookie → sign out → refused. A refused address takes the same path and is
 * checked for what it must NOT come back with.
 *
 * `/api/agents` is the guarded route throughout because it reads config and nothing
 * else — no `bd`, no network, no disk. What is being tested is the gate, not the route.
 *
 * The last section is about where the client secret is allowed to live, which is a
 * security property rather than a behaviour and therefore the kind that rots quietly.
 * `config.json` is committed to the repo in `~/.config/beadcause` after every write, so
 * a secret in a field there is in a history no rotation can reach; the field is gone, and
 * what these assertions hold is that it stays gone, that a config which still has one is
 * drained rather than broken, and that a `clientSecretFile` pointed somewhere that repo
 * would commit is said out loud. The commit that would carry it is refused in
 * `test/commonrepo.mjs`, which is the other half of the same guarantee.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort, freePort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-auth-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// Fixed, so the key file is not a variable in any of this and a failure is never a
// race between two processes making one. lib/auth.js prefers the env var over the file.
process.env.BEADCAUSE_SESSION_KEY = 'test-session-key-not-a-secret';
delete process.env.BEADCAUSE_GOOGLE_CLIENT_SECRET;

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
const is = (name, got, want) => (got === want ? ok(name) : bad(name, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));

/* ------------------------------------------------------------------ the units */

const auth = await import(LIB('auth.js'));

console.log('\nlib/auth.js — configuration');

// The secret comes from a file, because as of bc-m6m there is nowhere else for it to
// come from but this and the env var: `config.json` is committed to the repo in
// `~/.config/beadcause` after every write, so a field there is a secret in a history
// rather than a secret on a disk. Written outside the config directory on purpose, so
// that clearing `clientSecretFile` falls through to a default path which does not exist
// — which is what "no secret" has to mean now.
const SECRET_FILE = path.join(tmp, 'client-secret.key');
fs.writeFileSync(SECRET_FILE, 'shh\n', { mode: 0o600 });

const FULL = {
  port: 4318,
  auth: {
    google: {
      enabled: true,
      clientId: 'cid.apps.googleusercontent.com',
      clientSecretFile: SECRET_FILE,
      allowed: ['Adam@Example.com'],
      redirectUri: 'https://mac.tailnet.ts.net:4318/auth/google/callback',
      sessionDays: 30,
    },
  },
};
const without = (field) => ({ ...FULL, auth: { google: { ...FULL.auth.google, [field]: field === 'allowed' ? [] : null } } });

is('configured → on', Boolean(auth.googleAuth(FULL)), true);
is('the secret is read out of the file', auth.googleAuth(FULL)?.clientSecret, 'shh');
is('no clientId → off', auth.googleAuth(without('clientId')), null);
is('no secret file → off', auth.googleAuth(without('clientSecretFile')), null);
is('empty allowlist → off', auth.googleAuth(without('allowed')), null);
is('enabled:false → off', auth.googleAuth({ ...FULL, auth: { google: { ...FULL.auth.google, enabled: false } } }), null);
is('nothing configured at all → off, and no complaint', auth.googleProblem({ port: 4318 }), null);
is('half configured → off, with a reason', Boolean(auth.googleProblem(without('clientSecretFile'))), true);
// The field this bead took away. It is not read — but it is not ignored either, or a
// config that still has one would silently stop signing anybody in; see the absorb
// section below for where it goes instead.
is(
  'a clientSecret in the config is NOT a configured secret',
  auth.googleAuth({ ...FULL, auth: { google: { ...FULL.auth.google, clientSecretFile: null, clientSecret: 'shh' } } }),
  null
);
// The refusal that matters most: a plain-http callback cannot work (Google rejects it,
// and a Secure cookie is dropped over http), so it must read as off rather than as a
// login screen nobody can get past.
// `tls.enabled: false` keeps this hermetic: without it, asking for the certificate name
// shells out to `tailscale status --json` on whatever machine is running the suite. The
// answer would be the same — there is no certificate in this test's config directory —
// but it would be the same for a reason that varies by machine.
is(
  'no certificate and no explicit redirectUri → off',
  auth.googleAuth({
    port: 4318,
    tls: { enabled: false },
    auth: { google: { enabled: true, clientId: 'x', clientSecretFile: SECRET_FILE, allowed: ['a@b.c'] } },
  }),
  null
);

/* --------------------------------------------- where the secret is allowed to live */

console.log('\nlib/auth.js — keeping the secret out of the committed config');

// The migration, and the reason this bead exists: a config written by the version that
// had a `clientSecret` field, or hand-edited by somebody following the README that
// suggested one, is drained into a file the snapshotter refuses — and the field is gone
// afterwards, because a config that still has it is a config that will be committed
// with it.
{
  const dir = fs.mkdtempSync(path.join(tmp, 'absorb-'));
  const cfg = { auth: { google: { clientId: 'cid', clientSecretFile: path.join(dir, 'moved.key'), clientSecret: 'GOCSPX-from-the-config' } } };
  const moved = auth.absorbClientSecret(cfg);
  is('the field is taken out of the config', 'clientSecret' in cfg.auth.google, false);
  is('and it says it moved it', moved?.moved, true);
  is('the secret is in the file now', fs.readFileSync(path.join(dir, 'moved.key'), 'utf8').trim(), 'GOCSPX-from-the-config');
  is('at 0600, like the session key', fs.statSync(path.join(dir, 'moved.key')).mode & 0o777, 0o600);
  is('and sign-in reads it from there', auth.clientSecret(cfg.auth.google), 'GOCSPX-from-the-config');
}
{
  // A file that already has one wins. Overwriting it would sign every browser out of a
  // working install to honour a copy somebody forgot to delete.
  const dir = fs.mkdtempSync(path.join(tmp, 'absorb-'));
  const file = path.join(dir, 'kept.key');
  fs.writeFileSync(file, 'the-one-in-use\n', { mode: 0o600 });
  const cfg = { auth: { google: { clientSecretFile: file, clientSecret: 'the-stale-copy' } } };
  const moved = auth.absorbClientSecret(cfg);
  is('the file is left alone', fs.readFileSync(file, 'utf8').trim(), 'the-one-in-use');
  is('the config field still goes', 'clientSecret' in cfg.auth.google, false);
  is('and it says so rather than claiming a move', moved?.moved, false);
}
is('nothing to absorb → nothing said', auth.absorbClientSecret({ auth: { google: { clientId: 'cid' } } }), null);
is('no auth block at all → nothing said', auth.absorbClientSecret({}), null);
{
  // An empty field is not a secret, but it is an advertisement for the place one should
  // not go, so it leaves too.
  const cfg = { auth: { google: { clientSecret: null } } };
  auth.absorbClientSecret(cfg);
  is('an empty clientSecret field is dropped as well', 'clientSecret' in cfg.auth.google, false);
}

// The one hole the default cannot close: a `clientSecretFile` pointed at a name inside
// the config repo that its denylist does not match. Not refused — that would turn a
// working sign-in off over a filename — so this warning is the only tell there is.
is('the default file is safe by name, so nothing is said', auth.secretFileWarning({ auth: { google: {} } }), null);
is(
  'a secret file in the config repo that the denylist does not cover is called out',
  Boolean(
    auth.secretFileWarning({
      auth: { google: { clientSecretFile: path.join(process.env.BEADCAUSE_CONFIG_DIR, 'google-secret.txt') } },
    })
  ),
  true
);
is(
  'and one named so that it does is not',
  auth.secretFileWarning({
    auth: { google: { clientSecretFile: path.join(process.env.BEADCAUSE_CONFIG_DIR, 'google.secret') } },
  }),
  null
);
is('a file outside that directory is your business, not ours', auth.secretFileWarning(FULL), null);

console.log('\nlib/auth.js — the allowlist');
const A = auth.googleAuth(FULL);
is('an allowed address, whatever its case', auth.allowed(A, 'adam@example.com'), true);
is('the same address as configured', auth.allowed(A, 'Adam@Example.com'), true);
is('anybody else', auth.allowed(A, 'someone@example.com'), false);
is('an empty address', auth.allowed(A, ''), false);

console.log('\nlib/auth.js — signing');
const KEY = 'a-key';
const now = 1_700_000_000_000;
const good = auth.sign({ email: 'a@b.c', exp: Math.floor(now / 1000) + 60 }, KEY);
is('a signed value verifies', auth.verify(good, KEY, now)?.email, 'a@b.c');
is('a different key does not', auth.verify(good, 'other-key', now), null);
is('a tampered payload does not', auth.verify(`${auth.sign({ email: 'evil@b.c', exp: 9e9 }, 'other-key').split('.')[0]}.${good.split('.')[1]}`, KEY, now), null);
is('an expired one does not', auth.verify(auth.sign({ exp: Math.floor(now / 1000) - 1 }, KEY), KEY, now), null);
is('junk does not', auth.verify('nonsense', KEY, now), null);
is('nothing does not', auth.verify('', KEY, now), null);

console.log('\nlib/auth.js — the cookie');
const httpsCookie = auth.sessionCookie(A, { sub: '1', email: 'adam@example.com' }, KEY, now);
is('httpOnly', /HttpOnly/.test(httpsCookie), true);
is('SameSite=Lax', /SameSite=Lax/.test(httpsCookie), true);
// Off the configured redirect URI, never off `req.socket.encrypted` — TLS terminates in
// bin/router.js, which proxies to the backend over plain loopback.
is('Secure, because the redirect URI is https', /; Secure/.test(httpsCookie), true);
const loopbackAuth = auth.googleAuth({ ...FULL, auth: { google: { ...FULL.auth.google, redirectUri: 'http://127.0.0.1:4318/auth/google/callback' } } });
is('not Secure when what is served is plain http', /; Secure/.test(auth.sessionCookie(loopbackAuth, { sub: '1', email: 'a@b.c' }, KEY, now)), false);
is('a cleared cookie expires immediately', /Max-Age=0/.test(auth.clearCookie(auth.SESSION_COOKIE, { secure: true })), true);

console.log('\nlib/auth.js — where a signed-in browser may be sent');
is('a path on this server', auth.safeNext('/prs?refresh=1'), '/prs?refresh=1');
is('another origin', auth.safeNext('https://evil.example/'), '/');
is('a protocol-relative URL', auth.safeNext('//evil.example/'), '/');
is('a header injection', auth.safeNext('/x\r\nSet-Cookie: a=b'), '/');
is('nothing', auth.safeNext(''), '/');

console.log('\nlib/auth.js — the identity Google returns');
const idToken = (claims) =>
  [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature-not-checked-see-claimsOf',
  ].join('.');
const CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: FULL.auth.google.clientId,
  sub: '1234',
  email: 'Adam@Example.com',
  email_verified: true,
  exp: Math.floor(now / 1000) + 300,
  nonce: 'the-nonce',
};
const claimOpts = { clientId: FULL.auth.google.clientId, nonce: 'the-nonce', now };
is('a good token', auth.claimsOf(idToken(CLAIMS), claimOpts).claims?.email, 'adam@example.com');
is('another issuer', Boolean(auth.claimsOf(idToken({ ...CLAIMS, iss: 'https://evil.example' }), claimOpts).error), true);
is('another client', Boolean(auth.claimsOf(idToken({ ...CLAIMS, aud: 'someone-else' }), claimOpts).error), true);
is('an expired token', Boolean(auth.claimsOf(idToken({ ...CLAIMS, exp: Math.floor(now / 1000) - 1 }), claimOpts).error), true);
is('a replayed nonce', Boolean(auth.claimsOf(idToken({ ...CLAIMS, nonce: 'someone-elses' }), claimOpts).error), true);
// The hole the allowlist would otherwise have: anybody can put any address on a Google
// account they have not proved they own.
is('an unverified address', Boolean(auth.claimsOf(idToken({ ...CLAIMS, email_verified: false }), claimOpts).error), true);
is('no token at all', Boolean(auth.claimsOf('', claimOpts).error), true);

/* ------------------------------------------------------------------ the server */

const { createApp, listen } = await import(LIB('server.js'));

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const BASE_CFG = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'the-shared-token',
  actor: 'beadcause-test',
  workspaces: [{ name: 'demo', dir: ws }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
  agents: [],
  defaultAgent: 'answerer',
};

/** One request, with the headers you name and nothing implied. */
const call = (port, pathname, { method = 'GET', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

const up = async (port) => {
  for (let i = 0; i < 200; i += 1) {
    try {
      await call(port, '/api/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`nothing came up on ${port}`);
};

/** `name=value` out of a Set-Cookie list, ignoring the attributes. */
function cookieValue(setCookie, name) {
  for (const line of [].concat(setCookie || [])) {
    const [pair] = String(line).split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1);
  }
  return null;
}
const attrs = (setCookie, name) =>
  [].concat(setCookie || []).find((line) => String(line).startsWith(`${name}=`)) || '';

/* ------------------------------------------------- with sign-in off: unchanged */

console.log('\nthe server with Google sign-in off — nothing may have changed');

const offCfg = { ...BASE_CFG, port: 0 };
const offApp = createApp(offCfg);
const offServers = listen(offCfg, offApp.handler);
const offPort = await boundPort(offServers);

{
  const r = await call(offPort, '/api/agents', { headers: { 'x-beadcause-token': offCfg.token } });
  is('the token authorises', r.status, 200);
}
is('no token is refused', (await call(offPort, '/api/agents')).status, 401);
is('/api/health needs nothing, as before', (await call(offPort, '/api/health')).status, 200);
{
  // The important one. With sign-in off there is no login page to send anybody to, and
  // the app's own token dialog is what asks — a redirect here would break every install
  // that has never configured Google, which is all of them.
  const r = await call(offPort, '/');
  is('a page with no credential is still served', r.status, 200);
  is('and it is the app, not a login screen', /app\.js/.test(r.body), true);
}
is('there is no sign-in route to reach', (await call(offPort, '/auth/google')).status, 404);
{
  const who = JSON.parse((await call(offPort, '/auth/whoami')).body);
  is('whoami says Google is off', who.google, false);
  is('whoami says nobody is signed in', who.signedIn, false);
}

/* -------------------------------------------------- with sign-in on: both ways */

console.log('\nthe server with Google sign-in on — the token still gets in');

const onPort = await freePort();
const onCfg = {
  ...BASE_CFG,
  port: onPort,
  auth: {
    google: {
      enabled: true,
      clientId: 'cid.apps.googleusercontent.com',
      clientSecretFile: SECRET_FILE,
      allowed: ['adam@example.com'],
      // Explicit, and http on purpose: it keeps `tailscale cert` out of this test and
      // lets the cookie be settable over loopback. The Secure flag is asserted against
      // an https configuration in the unit section above.
      redirectUri: `http://127.0.0.1:${onPort}/auth/google/callback`,
      sessionDays: 30,
    },
  },
};
const onApp = createApp(onCfg);
const onServers = listen(onCfg, onApp.handler);
await up(onPort);

{
  // Every non-browser caller, in one assertion: a header, no cookie, no browser.
  const r = await call(onPort, '/api/agents', { headers: { 'x-beadcause-token': onCfg.token } });
  is('the token authorises the API with no cookie at all', r.status, 200);
}
is('`?t=` authorises the API too — an ntfy action button', (await call(onPort, `/api/agents?t=${onCfg.token}`)).status, 200);
is('a wrong token is still refused', (await call(onPort, '/api/agents', { headers: { 'x-beadcause-token': 'nope' } })).status, 401);
is('/api/health is still open', (await call(onPort, '/api/health')).status, 200);

console.log('\nthe server with Google sign-in on — a browser is sent to sign in');

{
  const r = await call(onPort, '/');
  is('a page with no credential redirects', r.status, 302);
  is('to the login screen', r.headers.location, '/login?next=%2F');
}
{
  const r = await call(onPort, '/prs?refresh=1');
  is('and it remembers where you were going', r.headers.location, '/login?next=%2Fprs%3Frefresh%3D1');
}
{
  const r = await call(onPort, '/login');
  is('the login screen itself is never gated', r.status, 200);
  is('and it is the login page', /login\.js/.test(r.body), true);
}
{
  // Assets stay open on purpose: they hold nothing, and gating the service worker or
  // the stylesheet breaks an installed PWA in ways that look nothing like "sign in".
  is('the stylesheet is still served', (await call(onPort, '/style.css')).status, 200);
  is('the service worker is still served', (await call(onPort, '/sw.js')).status, 200);
}

console.log('\nthe server with Google sign-in on — a `?t=` link still opens the page');

let pair = null;
{
  // What a notification click is: `https://…/?t=<token>#<bead>`. It must open the card,
  // and it must leave the browser able to navigate afterwards — a token lives in
  // localStorage and rides on no navigation at all.
  const r = await call(onPort, `/?t=${onCfg.token}`);
  is('the page is served', r.status, 200);
  is('and it is the app', /app\.js/.test(r.body), true);
  pair = cookieValue(r.headers['set-cookie'], 'beadcause_pair');
  is('the browser is paired for its next navigation', Boolean(pair), true);
  is('and that cookie is httpOnly', /HttpOnly/.test(attrs(r.headers['set-cookie'], 'beadcause_pair')), true);
}
is('a paired browser can navigate', (await call(onPort, '/prs', { headers: { cookie: `beadcause_pair=${pair}` } })).status, 200);
// The line that keeps the pairing cookie from being a second credential: it opens
// documents, which contain nothing, and never data.
is('but the pairing cookie does not authorise the API', (await call(onPort, '/api/agents', { headers: { cookie: `beadcause_pair=${pair}` } })).status, 401);

/* ------------------------------------------------------------- the whole dance */

console.log('\nsigning in with Google, end to end');

// Google's token endpoint, stubbed. The test's own requests go through node:http, so
// nothing here intercepts them.
const realFetch = globalThis.fetch;
let googleWill = { ok: true, claims: null };
let sawForm = null;
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://oauth2.googleapis.com/token')) return realFetch(url, opts);
  sawForm = new URLSearchParams(String(opts.body || ''));
  if (!googleWill.ok) return { ok: false, status: 400, json: async () => ({ error_description: 'invalid_grant' }) };
  return { ok: true, status: 200, json: async () => ({ id_token: idToken(googleWill.claims) }) };
};

/** Start a sign-in and come back with the state and the flight cookie. */
async function begin(next = '/') {
  const r = await call(onPort, `/auth/google?next=${encodeURIComponent(next)}`);
  const to = new URL(r.headers.location);
  return {
    status: r.status,
    to,
    state: to.searchParams.get('state'),
    flight: cookieValue(r.headers['set-cookie'], 'beadcause_signin'),
  };
}

{
  const b = await begin('/prs');
  is('the browser is sent to Google', b.to.origin + b.to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  is('as this client', b.to.searchParams.get('client_id'), onCfg.auth.google.clientId);
  is('asking only who you are', b.to.searchParams.get('scope'), 'openid email');
  is('with PKCE', b.to.searchParams.get('code_challenge_method'), 'S256');
  is('and a state to come back with', Boolean(b.state), true);
  is('remembered in a cookie, not in this process', Boolean(b.flight), true);
}

let session = null;
{
  const b = await begin('/prs');
  googleWill = { ok: true, claims: { ...CLAIMS, nonce: b.state, exp: Math.floor(Date.now() / 1000) + 300 } };
  const r = await call(onPort, `/auth/google/callback?code=the-code&state=${encodeURIComponent(b.state)}`, {
    headers: { cookie: `beadcause_signin=${b.flight}` },
  });
  is('the callback sends you on', r.status, 302);
  is('to where you were going', r.headers.location, '/prs');
  is('the code was exchanged with the secret', sawForm.get('client_secret'), 'shh');
  is('and the PKCE verifier', Boolean(sawForm.get('code_verifier')), true);
  session = cookieValue(r.headers['set-cookie'], 'beadcause_session');
  is('a session comes back', Boolean(session), true);
  is('httpOnly', /HttpOnly/.test(attrs(r.headers['set-cookie'], 'beadcause_session')), true);
  is('SameSite=Lax', /SameSite=Lax/.test(attrs(r.headers['set-cookie'], 'beadcause_session')), true);
  is('and the sign-in cookie is spent', /Max-Age=0/.test(attrs(r.headers['set-cookie'], 'beadcause_signin')), true);
}

{
  const r = await call(onPort, '/api/agents', { headers: { cookie: `beadcause_session=${session}` } });
  is('the session authorises the API, with no token anywhere', r.status, 200);
}
is('and a page', (await call(onPort, '/', { headers: { cookie: `beadcause_session=${session}` } })).status, 200);
{
  const who = JSON.parse((await call(onPort, '/auth/whoami', { headers: { cookie: `beadcause_session=${session}` } })).body);
  is('whoami knows who you are', who.email, 'adam@example.com');
  is('and says Google is on', who.google, true);
}
is('a forged session is refused', (await call(onPort, '/api/agents', { headers: { cookie: 'beadcause_session=made.up' } })).status, 401);

console.log('\nsigning in with Google — the refusals');

{
  const b = await begin('/');
  googleWill = { ok: true, claims: { ...CLAIMS, email: 'stranger@example.com', nonce: b.state, exp: Math.floor(Date.now() / 1000) + 300 } };
  const r = await call(onPort, `/auth/google/callback?code=c&state=${encodeURIComponent(b.state)}`, {
    headers: { cookie: `beadcause_signin=${b.flight}` },
  });
  is('an address off the allowlist is turned away', r.headers.location, '/login?error=notallowed');
  is('with no session', cookieValue(r.headers['set-cookie'], 'beadcause_session'), null);
  // The address is in the daemon log and not on the screen: echoing it back is how a
  // login page becomes a way to find out whether an account exists.
  is('and nothing about the address in the reply', /stranger/.test(JSON.stringify(r.headers) + r.body), false);
}
{
  const b = await begin('/');
  const r = await call(onPort, `/auth/google/callback?code=c&state=${encodeURIComponent(b.state)}`);
  is('a callback with no sign-in in flight is refused', r.headers.location, '/login?error=expired');
}
{
  const b = await begin('/');
  const r = await call(onPort, '/auth/google/callback?code=c&state=someone-elses-state', {
    headers: { cookie: `beadcause_signin=${b.flight}` },
  });
  is('a state that does not match the cookie is refused', r.headers.location, '/login?error=state');
}
{
  const b = await begin('/');
  googleWill = { ok: false };
  const r = await call(onPort, `/auth/google/callback?code=c&state=${encodeURIComponent(b.state)}`, {
    headers: { cookie: `beadcause_signin=${b.flight}` },
  });
  is('Google refusing the exchange is a page, not a stack trace', r.headers.location, '/login?error=exchange');
}
{
  const r = await call(onPort, '/auth/google/callback?error=access_denied');
  is('cancelling at Google comes back as cancelled', r.headers.location, '/login?error=cancelled');
}

console.log('\nsigning out');
{
  const r = await call(onPort, '/auth/signout', { method: 'POST', headers: { cookie: `beadcause_session=${session}` } });
  is('the session cookie is cleared', /Max-Age=0/.test(attrs(r.headers['set-cookie'], 'beadcause_session')), true);
  // The browser then holds nothing, which is what a cleared cookie means on the wire.
  is('and a browser holding nothing is refused', (await call(onPort, '/api/agents', { headers: { cookie: 'beadcause_session=' } })).status, 401);
  is('the token is untouched by any of this', (await call(onPort, '/api/agents', { headers: { 'x-beadcause-token': onCfg.token } })).status, 200);
}

/* ---------------------------------------------------------------------- done */

globalThis.fetch = realFetch;
const { closeServer } = await import(LIB('tls.js'));
for (const s of [...offServers, ...onServers]) closeServer(s);
await cleanupTmp(tmp);

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
