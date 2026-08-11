import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { protectedPath } from './commonrepo.js';
import { certificateName } from './tls.js';

/**
 * A second credential for the one caller that has a face: a browser.
 *
 * Until now there was exactly one credential — a shared token in `config.json`, sent
 * as `x-beadcause-token` or `?t=`. It works, and it is the wrong shape for a person:
 * it carries no identity, so nothing in a log can say *who* answered a question; it
 * cannot be revoked for one device, because there is only one of it; and a QR code
 * photographed over somebody's shoulder is a permanent grant to everything on this
 * Mac, including a terminal.
 *
 * So: Google sign-in, **beside** the token and never instead of it. That word is the
 * whole design, and it is a constraint rather than a nicety — most of what talks to
 * this daemon cannot perform a redirect dance at all:
 *
 *   - an ntfy action button POSTs an answer straight from the notification shade
 *   - lib/notify.js calls this server back with the token to cancel a push
 *   - the Android app calls `/api/*` from Kotlin, with no browser anywhere
 *   - scripts/shot.mjs drives a headless Chrome that has never signed into anything
 *   - bin/router.js proxies every request to a backend over loopback
 *
 * Every one of those keeps working untouched, because the token check in
 * lib/server.js is still the *first* thing asked and still sufficient on its own. This
 * file only adds a second way to pass, for the caller that can hold a cookie.
 *
 * **Nothing here is on unless it is configured, and "configured" is strict.** No
 * client id, no secret, or an empty allowlist means `googleAuth()` returns null and
 * every path in this file is dead code — the daemon behaves exactly as it did before
 * it existed. That is what makes the two credentials independent rather than
 * entangled, and test/auth.mjs asserts it in both directions.
 *
 * **It also refuses to switch on without HTTPS**, which is not caution but arithmetic:
 * Google will not accept a plain-http redirect URI, and a `Secure` cookie is silently
 * dropped by the browser over plain http. Half-configured, sign-in would therefore
 * fail with an empty screen and no reason on it. So sign-in requires a certificate
 * name (lib/tls.js) or an explicit `redirectUri`, and without one the token stays the
 * only credential and the reason is logged once at startup.
 *
 * **The session is a signed cookie, not a row in a table.** An HMAC over
 * `{sub, email, exp}` with a key in `~/.config/beadcause/session.key`, which means no
 * session store to keep, nothing to migrate, and nothing left behind by a restart —
 * the daemon is replaced by bin/router.js several times an hour, and a store in memory
 * would sign everybody out on every swap. What that costs is per-session revocation:
 * signing out ends the browser you are holding, and deleting the key file ends every
 * session everywhere. That is the honest trade and it is written on the README.
 *
 * **Both credentials are named so that repo cannot commit them, and that is the design
 * rather than a convention.** `~/.config/beadcause` is a git repo (lib/commonrepo.js)
 * which snapshots `config.json` after every write, so anything in that file is in a
 * history a rotation cannot reach back into. `session.key` and, by default,
 * `google-client-secret.key` are both matched by `*.key`, which is ignored there *and*
 * on that snapshotter's `FORBIDDEN` list — two rules, so editing the ignore file is not
 * enough to get one in. The `clientSecret` config field that shipped with sign-in is
 * gone: `absorbClientSecret` empties any that survives into the file, `clientSecret()`
 * no longer looks at it, and a secret written into any staged file is refused by the
 * commit itself. That was bc-m6m.
 */

/** The session. Read on every request that has no token. */
export const SESSION_COOKIE = 'beadcause_session';

/**
 * The in-flight sign-in: the CSRF nonce, the PKCE verifier and where you were going.
 *
 * A cookie rather than a map in memory, for the reason the session is one — the
 * process that starts a sign-in is frequently not the process that finishes it, since
 * a swap can land in the two seconds you spend on Google's account chooser. A map
 * would turn that into "sign-in failed, try again" with no explanation.
 */
export const FLIGHT_COOKIE = 'beadcause_signin';

/**
 * "This browser holds the pairing token" — and nothing more than that.
 *
 * Without it, turning sign-in on would break the token in a browser. The page gate
 * (lib/server.js) can only see credentials that ride on the request, and a token lives
 * in `localStorage`: it is on every `fetch`, and on no navigation at all. So a phone
 * paired by QR code would load `/?t=…` perfectly and then bounce to the login screen
 * the moment it tapped the tab bar — the token still working the whole time, for every
 * API call, invisibly.
 *
 * So a valid `?t=` on a page request leaves this behind, and the gate takes it as
 * proof the browser has been paired. It is **deliberately not accepted for `/api/*`**:
 * documents here contain no data — every one of them is an empty shell that fetches
 * behind the same gate as before — so what this cookie can unlock is a page, never a
 * bead. The real credential is still asked for on every request that carries data.
 */
export const PAIR_COOKIE = 'beadcause_pair';

/** Long enough for Google's account chooser and a 2FA prompt; short enough to be a one-shot. */
const FLIGHT_SECONDS = 600;

/** How long a paired browser stays paired without seeing a `?t=` again. */
const PAIR_DAYS = 30;

/** How long a session lasts when the config does not say. */
const DEFAULT_SESSION_DAYS = 30;

/**
 * Only what is needed to know which address you are. `profile` would add a name and a
 * photo, and nothing here shows either — an unused scope is a consent screen asking
 * for something it does not need.
 */
export const SCOPE = 'openid email';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/** Where the callback lands. Registered in the Google client, so it is a constant. */
export const CALLBACK_PATH = '/auth/google/callback';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Compared as digests, so a wrong length costs the same as a wrong byte.
 *
 * `crypto.timingSafeEqual` throws on mismatched lengths, which would otherwise make
 * "how long is the secret" the one thing a caller could always learn.
 */
export function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const bh = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/* --------------------------------------------------------------- configuration */

const secretFromFile = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

/**
 * Where the secret is read from when the config does not name a file.
 *
 * `.key`, and the extension is the entire reason for the name. `~/.config/beadcause` is
 * a git repo (lib/commonrepo.js) and `*.key` is both ignored there *and* on that file's
 * `FORBIDDEN` list — so the default place to keep the client secret is protected by the
 * same two rules that keep the Android signing key and the tailnet private key out of
 * that history, and it is protected by construction rather than by anybody choosing
 * well. `session.key` beside it is named on the same reasoning.
 */
const DEFAULT_SECRET_FILE = 'google-client-secret.key';

/** The file the secret is read from — yours if you named one, ours if you did not. */
export const clientSecretFile = (google = {}) =>
  google.clientSecretFile || path.join(CONFIG_DIR, DEFAULT_SECRET_FILE);

/**
 * What is actually sitting in the secret file, as distinct from `clientSecret()`.
 *
 * The difference is the env var, and it matters to exactly one caller: setup, which has
 * to say "there is already one here, press Enter to keep it" about the *file* — the only
 * copy the daemon will ever read. `BEADCAUSE_GOOGLE_CLIENT_SECRET` in the shell you are
 * configuring from is not that: the daemon runs under launchd and never sees it.
 */
export const clientSecretInFile = (google = {}) => secretFromFile(clientSecretFile(google));

/**
 * Put a secret where the daemon reads it from, at 0600.
 *
 * `chmod` after the write and not only the `mode` on it, because `mode` applies when a
 * file is *created* — re-running setup over a secret file that somebody made 0644 by hand
 * would otherwise leave it 0644 and say nothing.
 *
 * Never throws: this runs inside a setup script that has already asked eight questions,
 * and a stack trace at that point loses the other seven answers.
 */
export function writeClientSecret(secret, google = {}) {
  const file = clientSecretFile(google);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${String(secret ?? '').trim()}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { file };
  } catch (err) {
    return { file, error: `could not write ${file} — ${err.message}` };
  }
}

/**
 * The client secret: the env var, or a file. There is no third place any more.
 *
 * There used to be — a `clientSecret` field in `config.json`, documented as convenient
 * and worst — and taking it away is what bc-m6m was for. It was not merely a bad habit:
 * that file is committed to the common repo after every write, by design, so a secret
 * put there was not "on disk in the clear", it was *in a history* that a rotation cannot
 * reach back into. The env var leaves no copy at all; the file has a name the same repo
 * already refuses.
 *
 * A field left in the config from before is not read and not ignored either — see
 * `absorbClientSecret`, which empties it into the file on the next load.
 */
export function clientSecret(google = {}) {
  return process.env.BEADCAUSE_GOOGLE_CLIENT_SECRET?.trim() || secretFromFile(clientSecretFile(google)) || null;
}

/**
 * Take a `clientSecret` out of the config and put it where it belongs. Called by
 * `loadConfig`, so every process that reads the config heals it on the way past.
 *
 * The field is gone from `defaults()`, which settles fresh installs, and settles nothing
 * at all for the two configs that can have one: written by a version that had it, or
 * hand-edited by somebody following a README that told them to. Refusing to read it
 * would turn their sign-in off with no explanation on the screen it broke; reading it
 * would keep the secret in the committed file forever. So it is treated as an inbox —
 * drained into the secret file, at 0600, and deleted from the config, which the caller
 * then writes back.
 *
 * The write happens *before* the delete for the obvious reason. If the file cannot be
 * written the field stays exactly where it was, to be tried again on the next load, and
 * nothing is lost: the commit guard in lib/commonrepo.js is what stops the secret
 * reaching the history in the meantime, and it does not depend on this working.
 *
 * Returns null when there was nothing to do — the normal case, asked on every load.
 */
export function absorbClientSecret(cfg = {}) {
  const google = cfg.auth?.google;
  if (!google || !('clientSecret' in google)) return null;
  const file = clientSecretFile(google);
  const stray = typeof google.clientSecret === 'string' ? google.clientSecret.trim() : '';

  // An empty or null field is not a secret, but it is still an advertisement for the
  // place a secret should not go, so it leaves too.
  if (!stray) {
    delete google.clientSecret;
    return { file, removed: true, moved: false, note: 'dropped the empty clientSecret field from the config' };
  }
  // A file that already has one wins: it is the place this now reads from, and quietly
  // overwriting it would sign everybody out of a working install to honour a stale copy.
  const existing = secretFromFile(file);
  if (existing) {
    delete google.clientSecret;
    return {
      file,
      removed: true,
      moved: false,
      note:
        existing === stray
          ? `the clientSecret field was a duplicate of ${file} and has been removed from the config`
          : `left ${file} alone and removed a DIFFERENT clientSecret from the config — if sign-in stops working, that file is the one being read`,
    };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${stray}\n`, { mode: 0o600 });
  } catch (err) {
    return { file, removed: false, moved: false, error: `could not move the client secret to ${file} — ${err.message}` };
  }
  delete google.clientSecret;
  return { file, removed: true, moved: true, note: `moved the client secret out of the config and into ${file}` };
}

/**
 * A secret file that sits in the common repo without being on its denylist.
 *
 * The one hole left after the default file was named `.key` and the config field was
 * taken away: `clientSecretFile` is yours to point anywhere, and pointing it at
 * `~/.config/beadcause/google-secret.txt` puts the secret in a file that directory
 * commits and no rule refuses. Not refused here, because refusing would turn a working
 * sign-in off over a filename; said out loud instead, once, wherever this is logged.
 *
 * A path outside that directory is not this function's business — that is the whole
 * point of being allowed to choose one.
 */
export function secretFileWarning(cfg = {}) {
  const google = cfg.auth?.google;
  if (!google) return null;
  const file = clientSecretFile(google);
  const rel = path.relative(CONFIG_DIR, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (protectedPath(rel)) return null;
  return `${file} is inside the config repo and not on its denylist, so the secret in it WILL be committed — give it a name ending .key or .secret, or move it out of ${CONFIG_DIR}`;
}

/** Every address allowed in, lowercased, with the empties dropped. */
export function allowlist(google = {}) {
  return (Array.isArray(google.allowed) ? google.allowed : [])
    .map((a) => String(a || '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Where Google is told to come back to — and therefore whether sign-in can work.
 *
 * Off the certificate's MagicDNS name rather than `cfg.baseUrl`, because the redirect
 * URI has to match the one registered in the Google client *byte for byte*, and
 * `baseUrl` is reconciled at runtime: it is the tailnet IP over http before a
 * certificate arrives and the name over https afterwards. A URI that changes shape
 * when a certificate lands is a sign-in that breaks on the day TLS starts working.
 */
export function redirectUri(cfg = {}) {
  const explicit = cfg.auth?.google?.redirectUri;
  if (explicit) return explicit;
  const name = certificateName(cfg);
  if (!name) return null;
  const port = cfg.port || 4318;
  return `https://${name}${port === 443 ? '' : `:${port}`}${CALLBACK_PATH}`;
}

/**
 * The whole Google configuration, or null when sign-in is off.
 *
 * One function, asked everywhere, so there is exactly one answer to "is sign-in on"
 * and no route can end up half-guarded. Null is the normal state for an install that
 * has never configured it.
 */
export function googleAuth(cfg = {}) {
  const google = cfg.auth?.google;
  if (!google || google.enabled === false) return null;
  // Cheapest first, and the ordering is not style: `redirectUri` falls through to
  // `certificateName` → `magicDnsName`, which **shells out to `tailscale`**. This
  // function is asked on a timer by every backend and on every terminal upgrade, so an
  // install that has not configured sign-in — which is all of them by default — must
  // return here without spawning a subprocess.
  const clientId = google.clientId?.trim();
  if (!clientId) return null;
  const secret = clientSecret(google);
  if (!secret) return null;
  const allowed = allowlist(google);
  if (!allowed.length) return null;
  const uri = redirectUri(cfg);
  if (!uri) return null;
  return {
    clientId,
    clientSecret: secret,
    allowed,
    redirectUri: uri,
    sessionDays: Number(google.sessionDays) > 0 ? Number(google.sessionDays) : DEFAULT_SESSION_DAYS,
  };
}

/**
 * Why sign-in is off, in one line, for the log at startup.
 *
 * Separate from `googleAuth` because the answer to "is it on" must stay a boolean that
 * no caller can accidentally treat as configured. Null when there is nothing to say —
 * an install that has not asked for sign-in is not misconfigured.
 */
export function googleProblem(cfg = {}) {
  const google = cfg.auth?.google;
  if (!google || google.enabled === false) return null;
  const wants = Boolean(google.clientId?.trim() || clientSecret(google) || allowlist(google).length);
  if (!wants) return null;
  if (!google.clientId?.trim()) return 'no clientId';
  if (!clientSecret(google)) {
    return `no client secret — put it in ${clientSecretFile(google)}, or in BEADCAUSE_GOOGLE_CLIENT_SECRET`;
  }
  if (!allowlist(google).length) return 'the allowlist is empty — nobody could sign in';
  if (!redirectUri(cfg)) return 'no HTTPS certificate yet, and no explicit redirectUri — Google refuses a plain-http callback';
  return null;
}

/**
 * Sign-in in one line, for a person rather than a log: on, off, or nearly.
 *
 * The third state is the one worth having a function for. `googleAuth` answers a
 * boolean and must keep answering a boolean — no caller may treat "nearly" as
 * configured — but a *person* reading `npm run configure` needs the distinction, because
 * "off" and "off because the allowlist is empty" call for completely different next
 * actions and the failure this reports is famously quiet: one line at startup, in the
 * log nobody is watching, in front of the inbox that would have explained it.
 *
 * `on` is the boolean, so a caller cannot read the sentence and guess.
 */
export function signinStatus(cfg = {}) {
  if (googleAuth(cfg)) {
    return { on: true, text: `on for ${allowlist(cfg.auth?.google).join(', ')}` };
  }
  const problem = googleProblem(cfg);
  return { on: false, text: problem ? `NOT on — ${problem}` : 'off' };
}

/** Is this address allowed in? Case-insensitive, because addresses are. */
export const allowed = (auth, email) => auth.allowed.includes(String(email || '').trim().toLowerCase());

/* ------------------------------------------------------------------ the key */

const keyFile = () => path.join(CONFIG_DIR, 'session.key');

/**
 * The HMAC key, made once and kept at 0600.
 *
 * Generated rather than configured: nobody should have to invent one, and a key
 * somebody chose is a key somebody can guess. Rotating it — deleting the file — signs
 * every browser out, which is the only global revocation this design has.
 */
export function sessionKey() {
  if (process.env.BEADCAUSE_SESSION_KEY) return process.env.BEADCAUSE_SESSION_KEY;
  const file = keyFile();
  try {
    const have = fs.readFileSync(file, 'utf8').trim();
    if (have) return have;
  } catch {
    /* not made yet */
  }
  const made = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // wx so two backends racing at startup cannot each write a different key and
  // invalidate the other's cookies; the loser re-reads what the winner wrote.
  try {
    fs.writeFileSync(file, `${made}\n`, { mode: 0o600, flag: 'wx' });
    return made;
  } catch {
    return fs.readFileSync(file, 'utf8').trim();
  }
}

/* ------------------------------------------------------- signing and cookies */

/** `<payload>.<mac>`, both base64url. Not a JWT: nothing else reads it, so nothing needs a header. */
export function sign(payload, key = sessionKey()) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * The payload, or null for anything at all wrong with it.
 *
 * One return value for a bad signature, a mangled cookie and an expired session,
 * because every one of them means the same thing to the caller — this request has no
 * session — and a caller that could tell them apart would be tempted to treat one of
 * them as nearly fine.
 */
export function verify(value, key = sessionKey(), now = Date.now()) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', key).update(body).digest('base64url');
  if (!safeEqual(mac, want)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) return null;
  return payload;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Is `Secure` right for this deployment?
 *
 * Decided from the configured redirect URI, **never** from `req.socket.encrypted`.
 * TLS terminates in bin/router.js, which proxies to a backend over plain loopback, so
 * the socket this code sees is unencrypted in exactly the installed configuration
 * where the flag matters most. The redirect URI is the honest answer to "is this
 * served over https", because Google refuses to accept it otherwise.
 */
export const secureCookies = (auth) => String(auth?.redirectUri || '').startsWith('https://');

/**
 * `SameSite=Lax`, and it has to be: `None` would need `Secure` on loopback too and
 * would let any site's request carry the session, while `Strict` drops the cookie on
 * the top-level GET Google redirects you back with — so the callback would arrive
 * without the flight cookie and sign-in would fail on the last hop.
 */
export function cookie(name, value, { maxAge, secure }) {
  const bits = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) bits.push('Secure');
  bits.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (maxAge <= 0) bits.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return bits.join('; ');
}

export const clearCookie = (name, { secure }) => cookie(name, '', { maxAge: 0, secure });

/** The verified session on this request, or null. */
export function sessionOf(req, key = sessionKey(), now = Date.now()) {
  const raw = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
  if (!raw) return null;
  return verify(raw, key, now);
}

/** What a browser gets when the allowlist said yes. */
export function sessionCookie(auth, claims, key = sessionKey(), now = Date.now()) {
  const seconds = auth.sessionDays * 86400;
  const value = sign(
    { sub: claims.sub, email: claims.email, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + seconds },
    key
  );
  return cookie(SESSION_COOKIE, value, { maxAge: seconds, secure: secureCookies(auth) });
}

/** Stamped on a browser that has just proved it holds the token. See PAIR_COOKIE. */
export function pairCookie(auth, key = sessionKey(), now = Date.now()) {
  const seconds = PAIR_DAYS * 86400;
  const value = sign({ pair: true, exp: Math.floor(now / 1000) + seconds }, key);
  return cookie(PAIR_COOKIE, value, { maxAge: seconds, secure: secureCookies(auth) });
}

/** Has this browser been paired with the token? Pages only — never `/api/*`. */
export function paired(req, key = sessionKey(), now = Date.now()) {
  const raw = parseCookies(req.headers?.cookie)[PAIR_COOKIE];
  return Boolean(raw && verify(raw, key, now)?.pair === true);
}

/* --------------------------------------------------------------- the dance */

/**
 * Somewhere on this server, or `/`.
 *
 * A redirect target that came out of a query string is an open redirect waiting to
 * happen, and this one is followed by a browser that has *just* proved who it is —
 * the most valuable moment to send somebody at a page that is not ours. So: one
 * leading slash and no second one (`//evil.example` is a protocol-relative URL, and
 * a browser follows it off this host), and nothing else survives.
 */
export function safeNext(next) {
  const s = String(next || '');
  if (!s.startsWith('/') || s.startsWith('//')) return '/';
  if (/[\r\n]/.test(s)) return '/';
  return s;
}

/**
 * Start a sign-in: the URL to send the browser to, and the cookie that remembers it.
 *
 * PKCE even though this is a confidential client with a secret. It costs six lines and
 * it means a `code` intercepted between Google and this daemon — a proxy, a log, a
 * browser extension, the address bar of a shared screen — is not enough on its own.
 */
export function beginSignIn(auth, { next = '/', now = Date.now() } = {}) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const flight = sign(
    { nonce, verifier, next: safeNext(next), exp: Math.floor(now / 1000) + FLIGHT_SECONDS },
    sessionKey()
  );
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', auth.clientId);
  url.searchParams.set('redirect_uri', auth.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', nonce);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Always offer the chooser. Without it a Mac signed into a work account picks that
  // one silently and the refusal reads as "you are not allowed" rather than "wrong
  // account" — which is the same screen for two very different problems.
  url.searchParams.set('prompt', 'select_account');
  return {
    url: url.toString(),
    cookie: cookie(FLIGHT_COOKIE, flight, { maxAge: FLIGHT_SECONDS, secure: secureCookies(auth) }),
    nonce,
  };
}

/**
 * The claims inside an `id_token`, without verifying its signature.
 *
 * Deliberate, and only safe because of where this one came from: a direct TLS call
 * from this process to Google's token endpoint, with the client secret, in response to
 * a code this process issued. There is no third party in that exchange to forge
 * anything, which is exactly the case Google's own documentation says verification can
 * be skipped in. An `id_token` arriving any *other* way — from a client, in a header —
 * must never be trusted here, and none is.
 *
 * What is still checked is everything that does not need a key: the issuer, that the
 * token was minted for this client, that it has not expired, that the nonce is the one
 * we sent, and that Google says the address is verified. An unverified address is the
 * hole the allowlist would otherwise have: anybody can claim any `email` on a Google
 * account they have not proved they own.
 */
export function claimsOf(idToken, { clientId, nonce, now = Date.now() } = {}) {
  const part = String(idToken || '').split('.')[1];
  if (!part) return { error: 'no id_token' };
  let claims;
  try {
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return { error: 'unreadable id_token' };
  }
  if (!ISSUERS.has(claims.iss)) return { error: `unexpected issuer ${claims.iss}` };
  if (claims.aud !== clientId) return { error: 'id_token was not minted for this client' };
  if (!(Number(claims.exp) * 1000 > now)) return { error: 'id_token has expired' };
  if (nonce && !safeEqual(claims.nonce, nonce)) return { error: 'nonce did not match' };
  if (claims.email_verified !== true && claims.email_verified !== 'true') return { error: 'Google has not verified that address' };
  if (!claims.email) return { error: 'no email in id_token' };
  return { claims: { sub: claims.sub, email: String(claims.email).toLowerCase() } };
}

/**
 * Swap the code for tokens. Anything that is not a 200 comes back as `{ error }`.
 *
 * Never throws, because every failure here is a page a person is looking at: Google
 * being down, a clock skew, a secret rotated in the console and not here. A stack
 * trace on that page tells them nothing they can act on.
 */
export async function exchange(auth, { code, verifier, fetchImpl = fetch } = {}) {
  const body = new URLSearchParams({
    code,
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    redirect_uri: auth.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  let res;
  try {
    res = await fetchImpl(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    return { error: `could not reach Google — ${err.message}` };
  }
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    /* leave it empty; the status is the story */
  }
  if (!res.ok) return { error: payload.error_description || payload.error || `Google returned ${res.status}` };
  if (!payload.id_token) return { error: 'Google returned no id_token' };
  return { idToken: payload.id_token };
}
