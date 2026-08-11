import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import https from 'node:https';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
// Circular, and safe for the reason lib/config.js documents about its own two: every
// name here is reached from inside a function, never while either module is being
// evaluated. lib/config.js imports `publicBaseUrl` back out of this file, because the
// URL a phone is given is a fact about whether there is a certificate — which is this
// file's question, not config's.
import { CONFIG_DIR, tailscaleBin, tailscaleIp } from './config.js';

/**
 * HTTPS on the tailnet address, with a certificate the phone already trusts.
 *
 * The wire was never in the clear: WireGuard encrypts everything between the phone
 * and this Mac, so this is not closing a sniffing hole. What it buys is three things
 * the tailnet cannot give us. Browsers gate an entire class of features behind a
 * *secure context* — the microphone, service workers on anything but loopback,
 * clipboard, WebAuthn — and `http://100.x.y.z` is not one. Google will not accept a
 * non-HTTPS redirect URI, so sign-in is impossible without it. And a tailnet ACL that
 * is one day wrong should cost an eavesdropper a TLS handshake rather than the whole
 * conversation.
 *
 * **Terminated here, not by `tailscale serve`.** Fronting the daemon with Tailscale's
 * own proxy would be less code and would get the same certificate, but the protocol
 * floor would then be Tailscale's to choose and ours to discover. An explicit
 * `minVersion` is only enforceable where the socket is created, which is here — and
 * being explicit is the point of the exercise.
 *
 * **The name, not the address.** No certificate authority will sign `100.96.105.106`,
 * so HTTPS means serving the MagicDNS name — `<host>.<tailnet>.ts.net` — and
 * `tailscale cert` is what gets one for it (Let's Encrypt, fetched through
 * Tailscale). It needs **HTTPS Certificates** enabled for the tailnet at
 * <https://login.tailscale.com/admin/dns>; without that it fails with "your Tailscale
 * account does not support getting TLS certs" and there is nothing this code can do
 * about it.
 *
 * **Which is why nothing here throws.** A daemon that refused to boot because a
 * certificate was unavailable would take the inbox down over a feature nobody had
 * asked for yet: no cert means `certificate()` returns null, the reason is logged
 * once, and the listener stays plain HTTP exactly as before.
 *
 * **Loopback stays plain HTTP, deliberately.** `127.0.0.1` is already a secure
 * context in every browser, so it gains nothing; and it is where the control plane
 * lives — `bin/router.js --status`, `/internal/*`, `npm run monitor`, the router's own
 * proxy hop to its backend — all of which speak `http://127.0.0.1:<port>`. TLS there
 * would be a certificate for a name that does not resolve, guarding traffic that never
 * leaves the machine, and it would break every one of those callers on the way.
 *
 * **Renewal is this file's job too, and it is not optional.** A `tailscale cert`
 * certificate lasts 90 days and nothing outside this process renews the copy in
 * `~/.config/beadcause/tls/` — unlike `tailscale serve`, which would have owned that
 * for us. So the default outcome of obtaining one at startup and never looking again
 * is that a daemon which has been up for three months stops answering, on a phone,
 * with an interstitial and no clue as to why. `startRenewal` is the answer: it compares
 * the certificate on the live socket against the calendar every few hours, re-asks
 * `tailscale cert` when it is inside the last month, and swaps the result onto the
 * running sockets with `setSecureContext` — which changes nothing about the port or any
 * connection already open, because it only decides how the *next* handshake goes.
 *
 * And when it cannot: it says so somewhere that reaches the phone. A renewal that
 * quietly fails for six weeks is the same outage as never having tried, arriving on the
 * same day — so `notify` is a push, the alarm repeats daily while the problem lasts,
 * and it gets louder as the expiry gets closer.
 */

/** The floor. Not configurable: a knob here is a knob for putting TLS 1.0 back. */
export const MIN_VERSION = 'TLSv1.2';

/** Below this many days left, ask `tailscale cert` for a fresh one. */
const OBTAIN_BELOW_DAYS = 31;

/**
 * How often the certificate on the socket is compared against the calendar.
 *
 * Six hours, which is absurdly often for a date three months away and exactly right
 * for the two cases that matter: a Mac that sleeps more than it runs may only be up
 * for a couple of hours a day, and Tailscale's own renewal becomes due at a moment
 * this process has no way to be told about. Each check that finds nothing due costs a
 * `readFile` and a date comparison — see `renewOnce`, which refuses to shell out until
 * the calendar says there is a reason to.
 */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Below this many days left, a certificate we asked to replace and could not is an
 * alarm rather than a log line.
 *
 * Two weeks, because Tailscale renews a 90-day certificate once it is two thirds
 * through — around 30 days left — so anything still inside a fortnight means the
 * renewal that should already have happened has not, twice over. That is a fortnight
 * of daily notifications before the phone sees a warning page, which is the amount of
 * warning a thing like this is worth.
 */
export const ALARM_BELOW_DAYS = 14;

/**
 * At most one push per this long while the same problem lasts.
 *
 * Held in memory, so a restart nags again immediately. That is the right bias: the
 * process that knew it had already complained is gone, and being told twice about a
 * certificate that is about to strand the phone costs less than not being told.
 */
export const NAG_EVERY_MS = 24 * 60 * 60 * 1000;

/** A connection that has not said anything by now is a held file descriptor. */
const SNIFF_TIMEOUT_MS = 20000;

/** First byte of a TLS ClientHello — a handshake record. No HTTP method starts with it. */
const TLS_HANDSHAKE_BYTE = 0x16;

/** Resolved per call, not at import: tests set BEADCAUSE_CONFIG_DIR. */
const tlsDir = () => path.join(CONFIG_DIR, 'tls');

/** Absent config means on — a config written before this existed still gets HTTPS. */
export const tlsEnabled = (cfg) => cfg?.tls?.enabled !== false;

/** Whether a server from `listen()` is the TLS one, without importing `tls` to ask. */
export const isSecure = (server) => typeof server?.setSecureContext === 'function';

/**
 * This machine's MagicDNS name, without the trailing dot.
 *
 * From `tailscale status --json` rather than `os.hostname()`: the two differ the
 * moment a name is taken (`mac-1`), and the certificate is only valid for the one
 * Tailscale knows.
 */
export function magicDnsName() {
  const bin = tailscaleBin();
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 5000 });
    const name = String(JSON.parse(out)?.Self?.DNSName || '').replace(/\.$/, '');
    return /^[a-z0-9.-]+\.ts\.net$/i.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Where the pair for `name` lives — in one place, so the cheap check below, the fetch
 * and the renewal loop can never look at different files and disagree about what we
 * hold.
 */
const certFiles = (name) => ({
  certFile: path.join(tlsDir(), `${name}.crt`),
  keyFile: path.join(tlsDir(), `${name}.key`),
});

/**
 * Days until this certificate expires, or null if the bytes are not a certificate.
 *
 * Takes the PEM rather than a path because the renewal loop asks about the certificate
 * on the *socket*, which is a buffer that was read once at startup — and the whole
 * question it is asking is whether that differs from what is on disk now.
 */
export function daysLeftOf(pem) {
  try {
    const cert = new X509Certificate(pem);
    const until = cert.validToDate ? cert.validToDate.getTime() : Date.parse(cert.validTo);
    return Number.isFinite(until) ? (until - Date.now()) / 86400000 : null;
  } catch {
    return null;
  }
}

/** The file's bytes, or null. A certificate that is not there yet is not an error. */
function readIfPresent(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Days until this certificate file expires, or null if it cannot be read as one. */
function daysLeft(file) {
  try {
    return daysLeftOf(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/**
 * The one page that decides whether any of this can work, said in one place.
 *
 * It is a setting on a website, on a tailnet rather than on this machine, and no
 * amount of code here substitutes for it — so every surface that has to send somebody
 * there sends them to the same URL: the log lines below, the renewal alarm, and the
 * button on the admin screen.
 */
export const TAILNET_HTTPS_URL = 'https://login.tailscale.com/admin/dns';

/**
 * Which kind of "no certificate" this is, from what `tailscale` said about it.
 *
 * The distinction the whole admin control turns on. `tailnet-https-off` is the one
 * failure that is nobody's bug and cannot be retried into working: HTTPS Certificates
 * are disabled for the tailnet, `tailscale cert` refuses, and the fix is two taps on a
 * web page this app can only link to. Everything else is either a broken install
 * (`no-tailscale`), a machine Tailscale has not named yet (`no-name`), or something
 * unclassified that is worth showing verbatim rather than paraphrasing.
 *
 * Matched on the sentence rather than an exit code because there is no exit code: the
 * command returns 0 on this failure, which is the whole reason `obtain` reads the
 * files instead of the status.
 */
export function certFailureReason(detail) {
  const said = String(detail || '');
  if (/no tailscale CLI/i.test(said)) return 'no-tailscale';
  // Two sentences only, and deliberately not a wider net: an ACME rate limit or a DNS
  // hiccup misreported as "the tailnet setting is off" would send somebody to a web
  // page to turn on something that is already on, and leave them with no other lead.
  if (/does not support getting TLS certs/i.test(said)) return 'tailnet-https-off';
  if (/HTTPS[- ]?(?:Certificates?)?\s*(?:are|is)?\s*(?:not enabled|disabled)/i.test(said)) return 'tailnet-https-off';
  if (/no MagicDNS name|status.{0,20}did not answer/i.test(said)) return 'no-name';
  return 'unknown';
}

/** The arguments, in one place, so the sync and async runs can never drift apart. */
const certArgs = (name, certFile, keyFile) => ['cert', '--cert-file', certFile, '--key-file', keyFile, name];

/** Generous: this is a Let's Encrypt round trip on a cold cache. */
const CERT_TIMEOUT_MS = 120000;

/**
 * What a finished `tailscale cert` actually achieved — read off the files, not the
 * exit status.
 *
 * Shared by both ways of running it, because the interesting half of this command is
 * how it fails: an account without the feature prints a 500 to stderr and **exits 0**,
 * so the certificate on disk is the only honest test of whether it worked.
 *
 * Returns `{ok, changed, detail, reason}`. `changed` is the field the renewal loop
 * cares about — a `cert` that leaves the previous certificate exactly where it was has
 * produced a usable file (`ok`) and got us no further (`!changed`). `detail` is what
 * goes on a notification, because "could not renew the certificate" is not something
 * anybody can act on from a phone and "your Tailscale account does not support getting
 * TLS certs" is.
 */
function certOutcome(name, certFile, keyFile, before, output, say, warn) {
  const said = String(output).trim().split('\n').filter(Boolean).pop() || '';
  const after = readIfPresent(certFile);
  const changed = Boolean(after) && !(before && before.equals(after));

  const left = daysLeft(certFile);
  if (left !== null && left > 0 && fs.existsSync(keyFile)) {
    if (changed) {
      say(`certificate for ${name} — ${Math.round(left)} days left`);
      return { ok: true, changed: true, detail: `${Math.round(left)} days left`, reason: null };
    }
    // A usable certificate, and not a new one. Ordinary a month out — Tailscale renews
    // at two thirds of the lifetime and returns the cached certificate before then —
    // and the whole story a week out, which is why what it said is kept either way.
    return {
      ok: true,
      changed: false,
      detail: said || 'tailscale returned the certificate we already had',
      reason: null,
    };
  }
  const detail = said || 'no certificate was written';
  warn(`\`tailscale cert ${name}\` did not produce a certificate — ${detail}`);
  warn(`enable HTTPS Certificates for the tailnet: ${TAILNET_HTTPS_URL}`);
  return { ok: false, changed: false, detail, reason: certFailureReason(detail) };
}

/**
 * `tailscale cert` into our own directory.
 *
 * `spawnSync` rather than `execFileSync` because on a zero exit `execFileSync` hands
 * back stdout and throws stderr away, which is where the 500 above lives. The one
 * sentence that explains why a machine has no certificate was the one sentence being
 * dropped.
 *
 * Synchronous, and that is right for both of its callers — a daemon deciding what to
 * bind before it binds anything, and a renewal that runs twice a day in a process with
 * nothing else to do at that instant. It is *not* right for a button, which is what
 * `obtainCertificate` below exists for: two minutes of blocked event loop is two
 * minutes of every request, every WebSocket and every terminal frozen.
 */
function obtain(name, certFile, keyFile, say, warn) {
  const bin = tailscaleBin();
  if (!bin) {
    const detail = 'no tailscale CLI found — cannot fetch a certificate';
    warn(detail);
    return { ok: false, changed: false, detail, reason: 'no-tailscale' };
  }
  const before = readIfPresent(certFile);
  let output = '';
  try {
    fs.mkdirSync(tlsDir(), { recursive: true, mode: 0o700 });
    const run = spawnSync(bin, certArgs(name, certFile, keyFile), {
      encoding: 'utf8',
      timeout: CERT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    output = `${run.stderr || ''}${run.stdout || ''}` || run.error?.message || '';
  } catch (err) {
    output = err.message;
  }
  return certOutcome(name, certFile, keyFile, before, output, say, warn);
}

/**
 * The same fetch, asked for by a person, without stopping the daemon while it happens.
 *
 * Pressing "turn HTTPS on" is the one path where this is asked for *now*, by somebody
 * watching a screen, in a process that is at that moment serving their phone — so it
 * spawns rather than spawnSyncs, and the reply is written when Let's Encrypt has
 * answered rather than a hundred and twenty seconds of frozen event loop later.
 *
 * Everything else about it is `obtain`: the same arguments, the same timeout, the same
 * reading of the files rather than the exit code, and the same `{ok, changed, detail,
 * reason}` — with `name` added, because the caller here has not already resolved it.
 * A machine with no MagicDNS name fails as a `reason` rather than an exception; that is
 * a state the screen has to draw, not an error it has to catch.
 */
export async function obtainCertificate(cfg = {}, { log, warn } = {}) {
  const say = log || ((msg) => console.log(`[beadcause] tls         ${msg}`));
  const shout = warn || ((msg) => console.error(`[beadcause] tls         ${msg}`));

  const name = cfg.tls?.name || magicDnsName();
  if (!name) {
    const detail = 'no MagicDNS name — `tailscale status` did not answer';
    shout(detail);
    return { ok: false, changed: false, detail, reason: 'no-name', name: null };
  }
  const bin = tailscaleBin();
  if (!bin) {
    const detail = 'no tailscale CLI found — cannot fetch a certificate';
    shout(detail);
    return { ok: false, changed: false, detail, reason: 'no-tailscale', name };
  }

  const { certFile, keyFile } = certFiles(name);
  const before = readIfPresent(certFile);
  let output = '';
  try {
    fs.mkdirSync(tlsDir(), { recursive: true, mode: 0o700 });
    output = await new Promise((resolve) => {
      const run = spawn(bin, certArgs(name, certFile, keyFile), { stdio: ['ignore', 'pipe', 'pipe'] });
      let said = '';
      const timer = setTimeout(() => run.kill('SIGKILL'), CERT_TIMEOUT_MS);
      timer.unref?.();
      run.stdout.setEncoding('utf8');
      run.stderr.setEncoding('utf8');
      run.stdout.on('data', (c) => (said += c));
      run.stderr.on('data', (c) => (said += c));
      run.on('error', (err) => {
        clearTimeout(timer);
        resolve(said || err.message);
      });
      run.on('close', () => {
        clearTimeout(timer);
        resolve(said);
      });
    });
  } catch (err) {
    output = err.message;
  }
  return { ...certOutcome(name, certFile, keyFile, before, output, say, shout), name };
}

/**
 * Certificate and key for this machine's tailnet name, or null with the reason said
 * out loud.
 *
 * `quiet` is for callers that only want to know whether HTTPS is possible — nothing
 * in here should be able to log the same warning twice per boot.
 */
export function certificate(cfg = {}, { quiet = false } = {}) {
  if (!tlsEnabled(cfg)) return null;
  const say = quiet ? () => {} : (msg) => console.log(`[beadcause] tls         ${msg}`);
  const warn = quiet ? () => {} : (msg) => console.error(`[beadcause] tls         ${msg}`);

  const name = cfg.tls?.name || magicDnsName();
  if (!name) {
    warn('no MagicDNS name — `tailscale status` did not answer; serving plain http');
    return null;
  }

  const { certFile, keyFile } = certFiles(name);

  const left = daysLeft(certFile);
  const usable = left !== null && left > 0 && fs.existsSync(keyFile);
  // `asked` is null when the calendar said there was no reason to — which is the
  // difference between "we did not need a new certificate" and "we needed one and
  // this is what happened", and the renewal loop's alarm turns on the second.
  const asked = !usable || left < OBTAIN_BELOW_DAYS ? obtain(name, certFile, keyFile, say, warn) : null;
  if (asked && !asked.ok && !usable) {
    warn('serving plain http — see README, "HTTPS on the tailnet name"');
    return null;
  }

  try {
    return {
      name,
      cert: fs.readFileSync(certFile),
      key: fs.readFileSync(keyFile),
      certFile,
      keyFile,
      daysLeft: daysLeft(certFile),
      // What the last ask for a fresh one did, or null if none was made.
      asked,
    };
  } catch (err) {
    warn(`cannot read the certificate at ${certFile} — ${err.message}; serving plain http`);
    return null;
  }
}

/**
 * The name we already hold a servable certificate for, or null — **without asking
 * `tailscale cert` for one**.
 *
 * `certificate()` fetches when the cache is thin, which is right for a daemon coming
 * up once and wrong for everything else: `loadConfig()` runs in `beadcause-ask`,
 * `beadcause-propose`, every `--url` in a shell script and every `npm run qr`, and
 * none of those may block on a Let's Encrypt round trip to find out what to print.
 * So this reads the two files and nothing more.
 *
 * It is deliberately the *same* question `listen()` will answer a moment later, asked
 * the cheap way — the daemon's `certificate()` reuses this cache — which is what lets
 * a URL built here be the URL actually served.
 */
export function certificateName(cfg = {}) {
  if (!tlsEnabled(cfg)) return null;
  const name = cfg.tls?.name || magicDnsName();
  if (!name) return null;
  const { certFile, keyFile } = certFiles(name);
  const left = daysLeft(certFile);
  return left !== null && left > 0 && fs.existsSync(keyFile) ? name : null;
}

/**
 * The MagicDNS name, remembered for a few minutes.
 *
 * `magicDnsName()` shells out to `tailscale status --json`, which is the right price
 * for a daemon deciding what to bind once at startup and the wrong one for a screen
 * that asks every ten seconds while somebody is looking at it. The name changes when
 * the machine is renamed in the admin console and at no other time, so a stale answer
 * costs at most one refresh — and every path that is about to *act* on the name
 * (`certificate`, `obtainCertificate`) still resolves it fresh, on purpose.
 */
const NAME_TTL_MS = 5 * 60 * 1000;
let nameMemo = { at: 0, name: null };

function rememberedName() {
  const now = Date.now();
  if (nameMemo.name && now - nameMemo.at < NAME_TTL_MS) return nameMemo.name;
  const name = magicDnsName();
  // A failed lookup is not cached: `tailscale status` not answering is usually
  // Tailscale still starting, and five minutes of "no name" on the screen after it
  // has is exactly the sort of stale that gets read as broken.
  if (name) nameMemo = { at: now, name };
  return name;
}

/** Forget the memo above — after anything that could have changed the answer. */
export function forgetMagicDnsName() {
  nameMemo = { at: 0, name: null };
}

/**
 * Everything a screen needs to say about TLS, off the disk, in one object.
 *
 * Deliberately the *cheap* question — the same one `certificateName` asks, plus the
 * numbers — because it is the one behind a poll: two file reads, a certificate parse
 * and a memoised name. Nothing here asks `tailscale` for a certificate, so drawing the
 * admin screen can never block on a Let's Encrypt round trip.
 *
 * `enabled` is the setting, `have` is the fact, and keeping them apart is the point:
 * HTTPS wanted with no certificate is the normal state of a tailnet that has not
 * turned HTTPS Certificates on, and it is exactly the state the screen has to explain
 * rather than report as an error.
 */
export function certificateState(cfg = {}) {
  const enabled = tlsEnabled(cfg);
  const name = cfg.tls?.name || rememberedName();
  const state = {
    enabled,
    name: name || null,
    have: false,
    daysLeft: null,
    expiresAt: null,
    certFile: null,
    // What the calendar makes of the number, in the renewal loop's own thresholds, so
    // the screen and the push can never disagree about what "fine" means.
    alarming: false,
    renewing: false,
    tailnetHttpsUrl: TAILNET_HTTPS_URL,
  };
  if (!name) return state;

  const { certFile, keyFile } = certFiles(name);
  state.certFile = certFile;
  const left = daysLeft(certFile);
  if (left === null || !fs.existsSync(keyFile)) return state;

  state.have = left > 0;
  state.daysLeft = Math.round(left * 10) / 10;
  state.expiresAt = new Date(Date.now() + left * 86400000).toISOString();
  state.alarming = left < ALARM_BELOW_DAYS;
  state.renewing = left < OBTAIN_BELOW_DAYS;
  return state;
}

/**
 * The URL to put on a phone: the certificate's name over https, or the Tailscale IP
 * over plain http when there is no certificate.
 *
 * **Gated on holding one, not on wanting one**, and that is the whole design. An
 * `https://` link to a port serving plain HTTP is not a slow path or a warning — it is
 * a TLS parse error with nothing on screen, and it would be generated on exactly the
 * machines that cannot fix it: a tailnet without **HTTPS Certificates** enabled, where
 * `tailscale cert` refuses and lib/tls.js keeps the daemon up on http on purpose. The
 * fallback is therefore not a fallback so much as the honest answer to "what is this
 * daemon actually serving".
 *
 * The reverse gap — a certificate obtained after this was asked — closes itself: the
 * daemon calls `reconcileBaseUrl` again once `listen()` has fetched one, and until it
 * does, the http URL still works because the TLS front 307s it to the name.
 *
 * Loopback is the last resort and stays http forever: it is already a secure context,
 * it is where the control plane lives, and no authority signs `127.0.0.1` either.
 */
export function publicBaseUrl(cfg = {}) {
  const port = cfg.port || 4318;
  const name = certificateName(cfg);
  if (name) return `https://${name}:${port}`;
  return `http://${tailscaleIp() || '127.0.0.1'}:${port}`;
}

/** What `https.createServer` is given, in one place so the test can pin the floor. */
export const serverOptions = (material) => ({
  key: material.key,
  cert: material.cert,
  minVersion: MIN_VERSION,
});

/**
 * Answer a plain HTTP request that arrived on the TLS port with a redirect to the
 * name that has the certificate.
 *
 * Without this, turning HTTPS on is a flag day: every saved bookmark, every installed
 * PWA, every ntfy notification already sent and every QR already scanned points at
 * `http://100.x.y.z:4318`, and the answer to all of them becomes a TLS parse error
 * with nothing on screen to explain it. A 307 keeps them all working — and keeps the
 * `?t=<token>` on a pairing link, which is the difference between following the
 * redirect and being asked to pair again.
 *
 * 307 rather than 301: temporary, so a browser does not cache the upgrade past
 * somebody setting `tls.enabled: false`, and method-preserving, so a POST from the
 * Android app is re-sent as a POST rather than silently becoming a GET.
 *
 * The path comes out of the request line we already sniffed, and cannot contain
 * CR, LF or a space — the line was split on CRLF and the path matched as one
 * non-whitespace run — so there is nothing here to inject a header with.
 */
function redirectToHttps(socket, first, nameNow) {
  const name = nameNow();
  const line = first.toString('latin1', 0, Math.min(first.length, 4096)).split('\r\n', 1)[0];
  const request = /^[A-Z]{3,10} (\/[^\s]*) HTTP\/1\.[01]$/.exec(line);
  // Not TLS and not HTTP/1 either: a port scan, or a client speaking something we
  // have nothing to say to. Say nothing.
  if (!request) return socket.destroy();
  const target = `https://${name}:${socket.localPort}${request[1]}`;
  socket.end(
    `HTTP/1.1 307 Temporary Redirect\r\n` +
      `Location: ${target}\r\n` +
      `Content-Length: 0\r\n` +
      `Connection: close\r\n\r\n`
  );
}

/**
 * An HTTPS server, and the plain-HTTP nose that sits in front of it.
 *
 * Returns both: `server` is the `https.Server` — the thing that has the request
 * handler and emits `upgrade`, so it is what the WebSocket attaches to — and `front`
 * is the `net.Server` that actually owns the port. Every connection is peeked at for
 * one byte: a TLS handshake is pushed back and handed to the HTTPS server untouched,
 * anything else gets the redirect above.
 *
 * One byte is enough and no framing is involved, because a TLS record's first byte is
 * its content type and 0x16 (handshake) is not a character any HTTP method begins
 * with. The pause/unshift/resume dance is the standard one: the socket has to be out
 * of flowing mode before the bytes are put back, or the HTTPS server misses them.
 *
 * Both handles are hung on the HTTPS server as well — `.front`, so a caller can close
 * the thing that actually owns the port, and `.tlsMaterial`, so `renewOnce` can see
 * what is being served and replace it. The redirect reads the name back through
 * `.tlsMaterial` on each request rather than closing over it, so a renewal that arrives
 * under a new MagicDNS name sends clients to the name that has the new certificate
 * rather than the one that had the old.
 */
export function secureServer(material, handler) {
  const server = https.createServer(serverOptions(material), handler);
  server.tlsMaterial = material;

  const front = net.createServer((socket) => {
    socket.setTimeout(SNIFF_TIMEOUT_MS, () => socket.destroy());
    socket.once('error', () => socket.destroy());
    socket.once('data', (first) => {
      // Handed on from here: whichever side takes the socket owns its timeouts.
      socket.setTimeout(0);
      if (first[0] !== TLS_HANDSHAKE_BYTE) return redirectToHttps(socket, first, () => server.tlsMaterial.name);
      socket.pause();
      socket.unshift(first);
      server.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });

  server.front = front;
  return { server, front };
}

/**
 * Stop a server from `listen()`, and the nose in front of it if it has one.
 *
 * The HTTPS server behind a front was never `listen()`ed itself, so closing it alone
 * would leave the port open and closing it is not an error either — `close()` on a
 * server that was never listening reports through its callback rather than throwing.
 */
export function closeServer(server) {
  server?.front?.close();
  server?.close();
}

/* ------------------------------------------------------------------- renewal */

/** Days left, rounded the way a person would say it, from whichever side of zero. */
const roundDays = (n) => (n === null ? null : Math.round(n * 10) / 10);

/**
 * One pass of "is the certificate on the socket still good, and if not, replace it".
 *
 * Split out from the timer because a loop you can only observe by waiting six hours is
 * a loop nobody tests. It takes the servers `listen()` returned, and answers with what
 * it found rather than with a boolean:
 *
 *   - `off`      nothing here terminates TLS — a loopback-only listener, a backend
 *                behind the router, or `tls.enabled: false`. Not a problem.
 *   - `fresh`    more than a month left. Nothing was asked of `tailscale`, on purpose:
 *                a check that shells out is a check you cannot afford to run often.
 *   - `renewed`  a different certificate came back and is now on the live sockets.
 *   - `stale`    we asked and got the one we already had. Ordinary at 30 days —
 *                Tailscale renews at two thirds of the lifetime and not before — and an
 *                alarm inside `ALARM_BELOW_DAYS`, where it means the renewal that
 *                should have happened has not.
 *   - `lost`     there is no readable certificate for this name at all any more. The
 *                old one stays on the socket, because a live expiring certificate beats
 *                tearing the listener down, and this is as loud as anything gets.
 *
 * The swap is `setSecureContext`, which is the entire reason this can be done without a
 * restart: it replaces the context new handshakes are built from and touches nothing
 * else — the `net.Server` in front still owns the port, every open request is still
 * being served, and every WebSocket already upgraded keeps its socket. `serverOptions`
 * is what gets passed, not a bare key pair, so the TLS 1.2 floor survives the swap
 * rather than reverting to whatever Node's default happens to be that year.
 */
export function renewOnce(cfg, servers, { log = console.log, warn = console.error } = {}) {
  const secure = (servers || []).filter(isSecure);
  const current = secure.find((s) => s.tlsMaterial)?.tlsMaterial;
  if (!secure.length || !current) return { state: 'off' };

  const name = current.name;
  const left = daysLeftOf(current.cert);
  // A certificate whose bytes will not parse is not "fine for another 89 days".
  if (left !== null && left >= OBTAIN_BELOW_DAYS) return { state: 'fresh', name, daysLeft: roundDays(left) };

  // Quiet, and then said again here: `certificate()` speaks in the voice of a daemon
  // starting up — "serving plain http" — and none of that is true of a renewal, where
  // the socket keeps the certificate it has. This is the caller's story to tell.
  const next = certificate(cfg, { quiet: true });
  if (!next) {
    warn(`renewal for ${name} found no usable certificate — still serving one with ${roundDays(left)} days left`);
    return { state: 'lost', name, daysLeft: roundDays(left), detail: 'no certificate could be read or obtained' };
  }

  if (next.cert.equals(current.cert)) {
    return {
      state: 'stale',
      name: next.name,
      daysLeft: roundDays(daysLeftOf(next.cert)),
      detail: next.asked?.detail || 'nothing new came back',
    };
  }

  for (const server of secure) {
    server.setSecureContext(serverOptions(next));
    server.tlsMaterial = next;
  }
  const now = roundDays(daysLeftOf(next.cert));
  log(`renewed the certificate for ${next.name} without a restart — ${now} days left`);
  return { state: 'renewed', name: next.name, daysLeft: now, detail: `was ${roundDays(left)} days, now ${now}` };
}

/**
 * Keep the certificate on the socket alive, and shout when that stops working.
 *
 * Returns the interval so a shutdown can clear it, or null when there is nothing to
 * renew — which is the normal answer for every backend behind the router and every
 * test, and is why this is safe to call unconditionally.
 *
 * `notify` is how a failure leaves the machine. It is a callback rather than an import
 * because both callers of this are files that must be able to start when the rest of
 * the app cannot: bin/router.js owns the port and imports only leaves, and lib/tls.js
 * is one of those leaves. So the push lives with the caller, is awaited loosely, and
 * cannot take the listener down when ntfy is unreachable — the log line has already
 * happened by then either way.
 *
 * The alarm fires on `lost` always, and on `stale` inside `ALARM_BELOW_DAYS`; it
 * repeats no more than daily while the same state lasts, and re-arms the moment the
 * state changes, so a renewal that finally works is reported as well.
 */
export function startRenewal(cfg, servers, { notify = null, everyMs = CHECK_EVERY_MS, log, warn } = {}) {
  const say = log || ((msg) => console.log(`[beadcause] tls         ${msg}`));
  const shout = warn || ((msg) => console.error(`[beadcause] tls         ${msg}`));

  const secure = (servers || []).filter(isSecure);
  const current = secure.find((s) => s.tlsMaterial)?.tlsMaterial;
  if (!secure.length || !current) return null;

  let lastAlarm = 0;
  let lastState = null;

  const alarming = (result) => result.state === 'lost' || (result.state === 'stale' && (result.daysLeft ?? 0) < ALARM_BELOW_DAYS);

  // Said the way a person would, and never as "expires in -2 days": by the time the
  // date has gone past, how long ago is the only part of it that is news.
  const when = (d) =>
    d === null || d === undefined ? 'has an unreadable expiry' : d <= 0 ? `EXPIRED ${Math.abs(d)} days ago` : `expires in ${d} days`;

  const react = (result) => {
    const changed = result.state !== lastState;
    lastState = result.state;
    if (!alarming(result)) {
      // A problem that has gone away re-arms the alarm, so the next one is immediate.
      if (changed) lastAlarm = 0;
      return;
    }
    shout(`CERTIFICATE NOT RENEWING — ${result.name} ${when(result.daysLeft)}: ${result.detail}`);
    shout(`fix it by hand: tailscale cert ${result.name}   (needs HTTPS Certificates: ${TAILNET_HTTPS_URL})`);
    if (!notify) return;
    if (!changed && Date.now() - lastAlarm < NAG_EVERY_MS) return;
    lastAlarm = Date.now();
    // Loosely: the push is the second-best channel here and the log line is already
    // written. A rejected fetch must not become an unhandled rejection in a daemon.
    Promise.resolve()
      .then(() => notify(result))
      .catch((err) => shout(`could not push the certificate warning — ${err.message}`));
  };

  // Startup is a check too, and the cheap kind: whatever `certificate()` did on the way
  // to binding this socket is already reflected in the days left on it, so this reads
  // the calendar and alarms without asking `tailscale` anything a second time.
  const atStart = daysLeftOf(current.cert);
  const cadence = everyMs >= 3600000 ? `${Math.round(everyMs / 3600000)}h` : `${Math.round(everyMs / 60000)}m`;
  say(`certificate for ${current.name} — ${roundDays(atStart)} days left, checked every ${cadence}`);
  if (atStart !== null && atStart < ALARM_BELOW_DAYS) {
    react({
      state: 'stale',
      name: current.name,
      daysLeft: roundDays(atStart),
      detail: 'still this close to expiry after the startup fetch',
    });
  }

  const timer = setInterval(() => {
    try {
      react(renewOnce(cfg, servers, { log: say, warn: shout }));
    } catch (err) {
      // Nothing in a renewal is worth a crash: the certificate on the socket is still
      // the one that was working a moment ago.
      shout(`renewal check failed — ${err.message}`);
    }
  }, everyMs);
  // The listener is what keeps this process alive; a timer that could do it alone would
  // outlive the thing it exists to serve.
  timer.unref();
  return timer;
}
