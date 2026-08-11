import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
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
 *
 * **And *getting* the first one is this file's job for the same reason.** It used to be
 * fetched exactly once, on the way into `listen()`, by whichever process owns the port —
 * so one bad minute bought plain http until a human restarted the service. That minute
 * is reachable rather than theoretical: the first `tailscale cert` after a tailnet's
 * **HTTPS Certificates** switch is turned on can fail with `CreateOrder: 404 ...
 * Certificate not found`, because the new permission has not reached Let's Encrypt yet,
 * and the identical command a moment later writes the pair. The same gap covered the
 * ordinary case of turning the switch on under a running daemon: the certificate becomes
 * obtainable and the daemon is the last to know.
 *
 * So a listener that comes up without one comes up **provisional** — plain HTTP behind
 * the same `net.Server` front that TLS would sit behind — and `acquireOnce` keeps asking.
 * The moment a certificate arrives it goes onto that same socket through the same
 * `setSecureContext` a renewal uses: nothing is rebound, nothing open is dropped, and
 * the port is never let go of. That last part is not a nicety. bin/router.js will not
 * replace *itself* while holding the port, and a certificate is a much smaller reason
 * than new code is.
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
 * How often a listener that has **no** certificate looks for one.
 *
 * A minute, which is a different question asked on a different clock. Renewal is about a
 * date three months away; this is about a window measured in minutes — the gap between
 * a tailnet's HTTPS switch being turned on and Let's Encrypt agreeing, or between
 * somebody pressing the switch on the admin screen (which fetches into
 * `~/.config/beadcause/tls/` from a *backend* process) and the process that owns the
 * port noticing.
 *
 * Most of these ticks cost two file reads and nothing else: `acquireOnce` is only asked
 * to shell out on the backing-off schedule in `startRenewal`, or when a certificate has
 * already appeared on disk and there is nothing to fetch. Which is what makes a minute
 * affordable — `tailscale cert` at this cadence would be a Let's Encrypt round trip a
 * minute, and its failed-validation limits are per hour.
 */
export const ACQUIRE_EVERY_MS = 60 * 1000;

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
 *
 * `onWarn` takes the warnings instead of the console, for the one caller that needs the
 * *reason* rather than a log line: a null return says only "no certificate", and
 * `acquireOnce` has to put "your Tailscale account does not support getting TLS certs"
 * on a notification. The first warning is always the specific one.
 *
 * **An expired certificate is still returned, and that is a decision rather than an
 * oversight** — bc-jv86. Holding a pair for this name is one question and whether the
 * calendar has gone past it is another, so `held` decides what goes on the socket and
 * `fresh` decides only how loudly we ask for a replacement. Returning null once the
 * date has passed would mean a boot after expiry silently binds plain http on a port
 * a running daemon serves over TLS — the same machine, the same config, answering two
 * different ways depending on whether anyone happened to reboot — and it would drop an
 * origin to http without anybody choosing that. Expired is loud and broken on purpose:
 * an interstitial is a page you can read and act on, and a quiet downgrade turns off
 * the microphone, the service worker and every other secure-context feature with
 * nothing on screen to say why. The daily priority-5 push is what fixes this, not a
 * fallback that makes the outage comfortable enough to live with.
 */
export function certificate(cfg = {}, { quiet = false, onWarn = null } = {}) {
  if (!tlsEnabled(cfg)) return null;
  const say = quiet ? () => {} : (msg) => console.log(`[beadcause] tls         ${msg}`);
  const warn = onWarn || (quiet ? () => {} : (msg) => console.error(`[beadcause] tls         ${msg}`));

  const name = cfg.tls?.name || magicDnsName();
  if (!name) {
    warn('no MagicDNS name — `tailscale status` did not answer; serving plain http');
    return null;
  }

  const { certFile, keyFile } = certFiles(name);

  const left = daysLeft(certFile);
  // Two different questions, and keeping them apart is the whole of the paragraph
  // above: `held` is whether there is a readable pair for this name at all, `fresh` is
  // whether the calendar still agrees with it.
  const held = left !== null && fs.existsSync(keyFile);
  const fresh = held && left > 0;
  // `asked` is null when the calendar said there was no reason to — which is the
  // difference between "we did not need a new certificate" and "we needed one and
  // this is what happened", and the renewal loop's alarm turns on the second.
  const asked = !fresh || left < OBTAIN_BELOW_DAYS ? obtain(name, certFile, keyFile, say, warn) : null;
  if (asked && !asked.ok && !held) {
    warn('serving plain http — see README, "HTTPS on the tailnet name"');
    return null;
  }
  if (asked && !asked.ok && !fresh) {
    warn(
      `the certificate for ${name} EXPIRED ${Math.abs(Math.round(left * 10) / 10)} days ago and could not be ` +
        `replaced — serving it anyway, so every phone gets a certificate warning until this is fixed`
    );
    warn(`fix it by hand: tailscale cert ${name}   (needs HTTPS Certificates: ${TAILNET_HTTPS_URL})`);
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
 *
 * **Which is why the date is not part of it** — bc-jv86. It used to require a day left,
 * and that quietly broke the one property this function exists for: past the expiry
 * date `certificate()` still puts the pair on the socket and the front still 307s plain
 * http to the name, while this answered null and `publicBaseUrl` went back to
 * `http://100.x.y.z:4318` — an address the daemon bounces straight back to the https
 * name. The first `loadConfig()` after expiry then *persisted* that, so the priority-5
 * "certificate has EXPIRED" push — whose tap target is `cfg.baseUrl` — opened the one
 * URL that cannot be served. Holding the pair is the question; expiry is an alarm, and
 * `certificateState().expired` is where a screen reads it.
 */
export function certificateName(cfg = {}) {
  if (!tlsEnabled(cfg)) return null;
  const name = cfg.tls?.name || magicDnsName();
  if (!name) return null;
  const { certFile, keyFile } = certFiles(name);
  const left = daysLeft(certFile);
  return left !== null && fs.existsSync(keyFile) ? name : null;
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
 *
 * `have` is "there is a pair on disk for this name", *not* "the calendar still likes
 * it" — the same question `certificateName` asks, for the same reason (bc-jv86): it is
 * what decides what goes on the socket and what URL a phone is handed, and those two
 * must not disagree. `expired` is the calendar, split out so a screen says
 * **expired** rather than "-3 days left".
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
    // The calendar has gone past it: still served, still handed out, and an outage.
    expired: false,
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

  state.have = true;
  state.expired = left <= 0;
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

/**
 * The hosts the Android app is still allowed to reach over plain http.
 *
 * The same three names as `Address.LOOPBACK` and `network_security_config.xml` in the
 * APK, and `test/pairhost.mjs` fails the build if the lists ever stop matching. They
 * are here so the Mac can tell the difference between the http URL a phone will refuse
 * and the http URL an emulator pairs with every day.
 */
export const APP_CLEARTEXT_HOSTS = ['localhost', '127.0.0.1', '10.0.2.2'];

/**
 * What to say on the Mac about a URL the Android app is going to refuse — or null when
 * there is nothing to say.
 *
 * `publicBaseUrl` falls back to `http://<tailscale-ip>:4318` whenever there is no
 * certificate on disk, and that is the right answer: the PWA works perfectly well over
 * http on the tailnet, and an https link to a port serving plain HTTP would be a TLS
 * parse error with nothing on screen. What changed is the other end. As of bc-14s the
 * APK has cleartext off in `network_security_config.xml` and `Address.reach` refuses to
 * send the token anywhere but `https://<host>.<tailnet>.ts.net`, so that same link is
 * one the app cannot pair with at all.
 *
 * The app says so clearly when it happens — `pair_no_certificate` names the address and
 * points at the tailnet DNS page. But the person reading it is holding the phone and the
 * fix is on the Mac they have just walked away from, so the Mac is the better place to
 * say it: it knows at the moment it prints the code, and the walk has not happened yet.
 *
 * **Judged on the URL, not on the certificate**, because they are not the same question.
 * A `baseUrl` set by hand — a reverse proxy, a real domain — is left alone by the daemon
 * and is perfectly pairable with no `tailscale cert` anywhere in sight, and warning
 * about it would be the kind of warning that teaches people to skip warnings.
 *
 * Loopback is exempt for the same reason: it is http forever (see `publicBaseUrl`), it is
 * the one address the APK still permits cleartext to, and it is how an emulator reaches
 * the Mac it runs on.
 */
export function cleartextWarning(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (APP_CLEARTEXT_HOSTS.includes(parsed.hostname)) return null;
  return [
    'the Android app will refuse this link — it is plain http, and the app only sends its token to ' +
      'https://<host>.<tailnet>.ts.net. A browser on the tailnet is fine with it.',
    `turn HTTPS Certificates on for the tailnet (${TAILNET_HTTPS_URL}), then run this again — the ` +
      'daemon picks a certificate up within a minute of it being available.',
  ];
}

/**
 * What `https.createServer` is given, in one place so the test can pin the floor.
 *
 * Tolerates being handed nothing, because `tailnetServer` builds a server for a
 * certificate it does not have yet: the floor is set from the start and the key pair
 * arrives later, through `setSecureContext`, built by this same function.
 */
export const serverOptions = (material = {}) => ({
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
function redirectToHttps(socket, first, name) {
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
 * Give a socket to a server that was never `listen()`ed, peeked bytes and all.
 *
 * The pause/unshift/resume dance is the standard one: the socket has to be out of
 * flowing mode before the bytes are put back, or the server misses them.
 */
function handOff(server, socket, first) {
  socket.pause();
  socket.unshift(first);
  server.emit('connection', socket);
  process.nextTick(() => socket.resume());
}

/**
 * The listener for the tailnet address: TLS when there is a certificate, plain HTTP
 * when there is not, and able to become the first without giving up the port.
 *
 * `server` is the `https.Server` — the thing that has the request handler and emits
 * `upgrade`, so it is what a WebSocket attaches to — and `front` is the `net.Server`
 * that actually owns the port. Every connection is peeked at for one byte: a TLS
 * handshake is pushed back and handed to the HTTPS server untouched, plain HTTP gets
 * the redirect above. One byte is enough and no framing is involved, because a TLS
 * record's first byte is its content type and 0x16 (handshake) is not a character any
 * HTTP method begins with.
 *
 * **`material` may be null, and that is the interesting case.** A daemon that could not
 * fetch a certificate still has to answer the port, and what it answered before any of
 * this existed is plain HTTP — so it gets a third handle, `plain`: an `http.Server` the
 * front routes to while `server.tlsMaterial` is empty. `server` is built anyway, with
 * the TLS 1.2 floor and no key pair, precisely so that adopting a certificate later is
 * `setSecureContext` on an object that already exists — the same call `renewOnce` makes,
 * on a socket that was never rebound. A caller therefore attaches its `upgrade` handler
 * to *both* and hands both back from `listen()`; whichever one the front is routing to
 * is fully wired.
 *
 * The front reads `server.tlsMaterial` on every connection rather than closing over it,
 * which is what makes both handovers live: the plain-to-TLS one above, and a renewal
 * that arrives under a new MagicDNS name sending clients to the name that has the new
 * certificate rather than the one that had the old.
 *
 * `front` is hung on both servers as `.front`, so a caller shutting either of them down
 * closes the thing that actually owns the port — see `closeServer`.
 */
export function tailnetServer(material, handler) {
  const server = https.createServer(serverOptions(material || {}), handler);
  server.tlsMaterial = material || null;
  // Only when there is nothing to terminate TLS with. With a certificate in hand this
  // would be a second copy of the app wired to a socket nothing can ever reach.
  const plain = material ? null : http.createServer(handler);

  const front = net.createServer((socket) => {
    socket.setTimeout(SNIFF_TIMEOUT_MS, () => socket.destroy());
    socket.once('error', () => socket.destroy());
    socket.once('data', (first) => {
      // Handed on from here: whichever side takes the socket owns its timeouts.
      socket.setTimeout(0);
      const held = server.tlsMaterial;
      if (first[0] === TLS_HANDSHAKE_BYTE) {
        // A handshake with nothing behind it — reachable only in the window before a
        // certificate is adopted, from a client that guessed https. There is nothing
        // truthful to answer it with, so say nothing.
        if (!held) return socket.destroy();
        return handOff(server, socket, first);
      }
      // Plain HTTP: upgraded to the name that has the certificate once there is one,
      // and simply served until then. The last case cannot happen — a listener built
      // with a certificate never loses it, so `plain` being absent and `held` being
      // empty are mutually exclusive — but this runs in a socket callback, where a throw
      // is a dead daemon rather than a failed request.
      if (held) return redirectToHttps(socket, first, held.name);
      return plain ? handOff(plain, socket, first) : socket.destroy();
    });
  });

  server.front = front;
  if (plain) plain.front = front;
  return { server, front, plain };
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
 * The same number said the way a person would, and never as "-3.2 days left": once the
 * date has gone past, how long ago is the only part of it that is news. A log line that
 * reports a negative is a log line nobody reads as an outage.
 */
const daysPhrase = (n) =>
  n === null || n === undefined
    ? 'an unreadable expiry'
    : n <= 0
      ? `EXPIRED ${Math.abs(roundDays(n))} days ago`
      : `${roundDays(n)} days left`;

/**
 * Note on the live sockets that the renewal loop just looked.
 *
 * Stamped on the server objects rather than kept in a closure because the socket is
 * where every other TLS fact is read from: bin/router.js reads `tlsMaterial` off the
 * same object to answer "what is actually being served", and a timestamp held anywhere
 * else would be a second source that can disagree with it — including after
 * `setSecureContext` has swapped the material underneath.
 */
const stampChecked = (servers) => {
  const at = new Date().toISOString();
  for (const server of servers) server.tlsCheckedAt = at;
};

/**
 * One pass of "is the certificate on the socket still good, and if not, replace it".
 *
 * Split out from the timer because a loop you can only observe by waiting six hours is
 * a loop nobody tests. It takes the servers `listen()` returned, and answers with what
 * it found rather than with a boolean:
 *
 *   - `off`      nothing here terminates TLS — a loopback-only listener, a backend
 *                behind the router, or `tls.enabled: false`. Not a problem. A provisional
 *                listener that has no certificate *yet* is `off` here too: there is
 *                nothing to renew, and `acquireOnce` is what it is waiting for.
 *   - `fresh`    more than a month left. Nothing was asked of `tailscale`, on purpose:
 *                a check that shells out is a check you cannot afford to run often.
 *   - `renewed`  a different certificate came back and is now on the live sockets.
 *   - `stale`    we asked and got the one we already had. Ordinary at 30 days —
 *                Tailscale renews at two thirds of the lifetime and not before — and an
 *                alarm inside `ALARM_BELOW_DAYS`, where it means the renewal that
 *                should have happened has not. Past the date it is still this state,
 *                with a negative `daysLeft`: the expired pair is both what is on the
 *                socket and what came back, which is the loud answer bc-jv86 chose over
 *                quietly dropping the origin to plain http.
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
 * One pass of "is there a certificate yet, and if there is, start serving it".
 *
 * The other half of `renewOnce`, and the half that was missing. A boot that could not
 * fetch a certificate came up plain and nothing ever asked again — `startRenewal`
 * filtered its servers for a certificate to keep alive, found none, and returned null —
 * so a single failed fetch cost plain http until somebody restarted the service by hand.
 * This is what asks again, and what adopts the answer.
 *
 * Takes the same servers `listen()` returned, and answers with what it found:
 *
 *   - `off`       nothing here is waiting for one: no provisional listener, or
 *                 `tls.enabled: false`. The normal answer everywhere but the one place.
 *   - `absent`    it asked, and there is still no certificate. Carries what `tailscale`
 *                 said, because "could not get a certificate" is not actionable from a
 *                 phone and "your Tailscale account does not support getting TLS certs"
 *                 is. Serving plain http is unchanged — which is why this is a state and
 *                 not an error.
 *   - `acquired`  one came back, and the port is serving it from the next handshake on.
 *
 * The adoption is `setSecureContext` — deliberately the same swap `renewOnce` does,
 * which is what makes it free: the `net.Server` in front never let go of the port, every
 * open request is still being served, every WebSocket already upgraded keeps its socket,
 * and `serverOptions` is what gets passed so the TLS 1.2 floor arrives with the key pair
 * rather than being whatever Node's default is that year.
 *
 * What it does *not* do is move `cfg.baseUrl` onto the new name. That belongs to the
 * caller, for the reason `notify` does: this file is a leaf and `reconcileBaseUrl` is
 * not. See the `onAcquired` hook on `startRenewal`.
 */
export function acquireOnce(cfg, servers, { log = console.log, warn = console.error } = {}) {
  const waiting = (servers || []).filter(isSecure).filter((s) => !s.tlsMaterial);
  if (!waiting.length || !tlsEnabled(cfg)) return { state: 'off' };

  // Collected rather than printed: `certificate()` speaks in the voice of a daemon
  // starting up — "serving plain http — see README" — and this is a daemon that has been
  // up for six hours. The words are the same, the voice is this loop's to choose.
  const said = [];
  const next = certificate(cfg, { quiet: true, onWarn: (msg) => said.push(msg) });
  if (!next) {
    return {
      state: 'absent',
      // Best effort, and null when Tailscale has not named this machine — which is
      // itself one of the reasons there is no certificate. `react` says it differently
      // rather than printing `tailscale cert null`.
      name: cfg.tls?.name || magicDnsName(),
      daysLeft: null,
      detail: said[0] || 'no certificate could be obtained',
      reason: certFailureReason(said[0]),
    };
  }

  for (const server of waiting) {
    server.setSecureContext(serverOptions(next));
    server.tlsMaterial = next;
  }
  const left = roundDays(daysLeftOf(next.cert));
  // An expired one is adopted too, and says so. The alternative is worse in both
  // directions: plain http on a port whose URL says https, and a socket that behaves
  // differently from the one a restart would build. See `certificate()`.
  log(`adopted a certificate for ${next.name} without a restart — ${daysPhrase(left)}; https from the next connection`);
  return { state: 'acquired', name: next.name, daysLeft: left, detail: `plain http until now — ${daysPhrase(left)}` };
}

/**
 * Keep the certificate on the socket alive — and get one at all, when the listener came
 * up without.
 *
 * Returns the interval so a shutdown can clear it, or null when there is nothing to
 * renew and nothing to wait for — which is the normal answer for every backend behind
 * the router and every test, and is why this is safe to call unconditionally.
 *
 * **Two clocks, one timer.** Which one it runs on is decided by what is on the socket
 * when this is called. A listener with a certificate is on `everyMs` — six hours, because
 * a check that shells out is a check you cannot afford to run often. A provisional one is
 * on `acquireEveryMs` — a minute, because the window it exists for is the couple of
 * minutes after a tailnet's HTTPS switch is turned on — and the *asks* back off from
 * there, doubling to at most one `everyMs` apart, so a machine that will never have a
 * certificate is not asking Let's Encrypt about it once a minute for a year. Between
 * asks each tick still checks the cheap way, off the two files, which is what catches a
 * certificate somebody else has just written: pressing "turn HTTPS on" fetches it in a
 * *backend* process, and this is the process that owns the port. Once one is adopted the
 * renewal clock takes over, from that moment rather than from boot.
 *
 * `onAcquired` is called after the socket has become TLS, and is where `reconcileBaseUrl`
 * belongs: the phone should be handed `https://<name>` from then on, and this file cannot
 * import the thing that decides that.
 *
 * `notify` is how a failure leaves the machine. It is a callback rather than an import
 * because both callers of this are files that must be able to start when the rest of
 * the app cannot: bin/router.js owns the port and imports only leaves, and lib/tls.js
 * is one of those leaves. So the push lives with the caller, is awaited loosely, and
 * cannot take the listener down when ntfy is unreachable — the log line has already
 * happened by then either way.
 *
 * The alarm fires on `lost` always, on `stale` inside `ALARM_BELOW_DAYS`, and on
 * `absent`; it re-arms the moment the state changes, so a renewal — or an acquisition —
 * that finally works is reported as well.
 */
export function startRenewal(
  cfg,
  servers,
  { notify = null, everyMs = CHECK_EVERY_MS, acquireEveryMs = ACQUIRE_EVERY_MS, onAcquired = null, log, warn } = {}
) {
  const say = log || ((msg) => console.log(`[beadcause] tls         ${msg}`));
  const shout = warn || ((msg) => console.error(`[beadcause] tls         ${msg}`));

  const secure = (servers || []).filter(isSecure);
  if (!secure.length) return null;
  const held = () => secure.find((s) => s.tlsMaterial)?.tlsMaterial || null;
  const current = held();
  // A TLS-shaped listener with nothing on it: `tailnetServer` was given no certificate,
  // so this is serving plain http and what it needs is a first certificate rather than a
  // replacement. See `acquireOnce`.
  const acquiring = !current;
  if (acquiring && !tlsEnabled(cfg)) return null;

  let lastAlarm = 0;
  let lastState = null;

  const alarming = (result) =>
    result.state === 'lost' || result.state === 'absent' || (result.state === 'stale' && (result.daysLeft ?? 0) < ALARM_BELOW_DAYS);

  // `absent` is said once per problem rather than daily. A tailnet that cannot issue
  // certificates at all is a *supported* configuration — this file keeps the daemon up on
  // plain http on purpose — so "there is still no certificate" is news the first time and
  // spam every day after. A renewal that is failing is the opposite: an outage with a date
  // on it, which is worth repeating until it is fixed.
  const oncePerProblem = (result) => result.state === 'absent';

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
    if (result.state === 'absent') shout(`STILL NO CERTIFICATE — serving plain http on the tailnet address: ${result.detail}`);
    else shout(`CERTIFICATE NOT RENEWING — ${result.name} ${when(result.daysLeft)}: ${result.detail}`);
    if (result.name) shout(`fix it by hand: tailscale cert ${result.name}   (needs HTTPS Certificates: ${TAILNET_HTTPS_URL})`);
    else shout(`fix it by hand: check \`tailscale status\` — Tailscale has not named this machine, so there is nothing to certify`);
    if (!notify) return;
    if (!changed && (oncePerProblem(result) || Date.now() - lastAlarm < NAG_EVERY_MS)) return;
    lastAlarm = Date.now();
    // Loosely: the push is the second-best channel here and the log line is already
    // written. A rejected fetch must not become an unhandled rejection in a daemon.
    Promise.resolve()
      .then(() => notify(result))
      .catch((err) => shout(`could not push the certificate warning — ${err.message}`));
  };

  const cadence = (ms) =>
    ms >= 3600000
      ? `${Math.round(ms / 3600000)}h`
      : ms >= 60000
        ? `${Math.round(ms / 60000)}m`
        : // Down to milliseconds, because a suite driving this on a 40ms clock reads its
          // own log lines and "checked every 0s" is the sort of thing that gets debugged.
          ms >= 1000
          ? `${Math.round(ms / 1000)}s`
          : `${ms}ms`;

  if (acquiring) {
    say(
      `no certificate — serving plain http on the tailnet address and looking every ${cadence(acquireEveryMs)}, ` +
        `asking \`tailscale cert\` on a schedule that backs off to ${cadence(everyMs)}`
    );
  } else {
    // Startup is a check too, and the cheap kind: whatever `certificate()` did on the way
    // to binding this socket is already reflected in the days left on it, so this reads
    // the calendar and alarms without asking `tailscale` anything a second time.
    const atStart = daysLeftOf(current.cert);
    say(`certificate for ${current.name} — ${daysPhrase(atStart)}, checked every ${cadence(everyMs)}`);
    if (atStart !== null && atStart < ALARM_BELOW_DAYS) {
      react({
        state: 'stale',
        name: current.name,
        daysLeft: roundDays(atStart),
        detail:
          atStart <= 0
            ? 'already past its date at startup and the startup fetch could not replace it — every phone gets a certificate warning'
            : 'still this close to expiry after the startup fetch',
      });
    }
  }

  // The backing-off ask schedule, counted in ticks rather than milliseconds so there is
  // one interval to clear and one clock to reason about. Asks land on ticks 1, 3, 7, 15,
  // 31 … and then every `maxGap`, which is one `everyMs` apart.
  let ticks = 0;
  let gap = 1;
  let nextAsk = 1;
  const maxGap = Math.max(1, Math.round(everyMs / acquireEveryMs));
  let lastRenewal = 0;

  stampChecked(secure);

  const timer = setInterval(() => {
    try {
      // The tick itself is the thing worth reporting, before any of the branches below
      // decide there is nothing to do: "checked 4h ago" on a six-hour clock is a loop
      // that is alive, and a stamp that only moved when a certificate was *fetched*
      // would sit at boot time for a month and read as a loop that had died.
      stampChecked(secure);
      if (!held()) {
        ticks += 1;
        // Between asks, the two files are still worth reading: a certificate fetched by
        // the admin switch — in another process — is adopted within a tick rather than
        // waiting out the backoff. `certificateState` is the cheap question by design.
        if (ticks < nextAsk && !certificateState(cfg).have) return;
        const result = acquireOnce(cfg, servers, { log: say, warn: shout });
        // Any attempt that did not end in a certificate pushes the next one further out —
        // whether it was the schedule or the cheap check that triggered it. Otherwise a
        // pair on disk that cannot be *read* would be retried, and shouted about, every
        // minute for as long as the daemon runs.
        if (result.state !== 'acquired') {
          gap = Math.min(gap * 2, maxGap);
          nextAsk = ticks + gap;
        }
        // A certificate adopted now has months left; the renewal clock starts here rather
        // than immediately re-asking about it.
        lastRenewal = Date.now();
        react(result);
        if (result.state === 'acquired' && onAcquired) {
          try {
            onAcquired(result);
          } catch (err) {
            shout(`the certificate is on the socket, but the follow-up failed — ${err.message}`);
          }
        }
        return;
      }
      // Acquisition's fast interval is still the one firing; renewal keeps its own clock.
      if (acquiring && Date.now() - lastRenewal < everyMs) return;
      lastRenewal = Date.now();
      react(renewOnce(cfg, servers, { log: say, warn: shout }));
    } catch (err) {
      // Nothing about a certificate is worth a crash: the socket is still serving
      // whatever it was serving a moment ago.
      shout(`certificate check failed — ${err.message}`);
    }
  }, acquiring ? acquireEveryMs : everyMs);
  // The listener is what keeps this process alive; a timer that could do it alone would
  // outlive the thing it exists to serve.
  timer.unref();
  return timer;
}

/* ------------------------------------------------------------------- the readout */

/** How long ago, in the coarsest unit that still says something. */
const ago = (at) => {
  const then = Date.parse(at || '');
  if (!Number.isFinite(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 90) return `${secs}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
};

/**
 * The certificate on the socket, in one line, with the alarm window marked.
 *
 * This is the readout half of everything above, and it exists because none of it had a
 * screen. The loop logs to launchd's file, which is on a Mac nobody is sitting at, and
 * pushes to ntfy at the point where it is already going wrong — so "is my certificate
 * fine?" could only be answered by opening a log or waiting for the alarm. Meanwhile
 * `bin/router.js --status` is the command that is *already* run to ask what the daemon
 * is doing, and it said nothing about TLS at all.
 *
 * Takes the `certificate` field off the router's snapshot rather than reading the disk,
 * because the socket is the fact: `renewOnce` and `acquireOnce` swap material under a
 * live listener, so what is in `~/.config/beadcause/tls` and what a handshake would
 * actually present are two different questions. `certificateState` answers the first for
 * the admin screen; this answers the second.
 *
 * Three shapes of "no number", kept apart on purpose:
 *
 * - `undefined` — the router that answered is older than the field. That is "could not
 *   say", and must not read as "no certificate": the router cannot hot-swap itself, so
 *   a change to its source is live only after a `launchctl kickstart`, and the status
 *   line already says `source changed` when that is pending.
 * - `null` — nothing is on the socket. Plain HTTP, which is the normal state of a
 *   tailnet without HTTPS Certificates and of a provisional listener still waiting for
 *   its first certificate — not a fault, and `acquireOnce` is what it is waiting for.
 * - a certificate with `daysLeft: null` — bytes that will not parse. That is an alarm
 *   and not a shrug: an unreadable expiry is not "fine for another 89 days".
 *
 * The thresholds are the constants the loop itself uses, so a line that reads "fine"
 * and a push that says EXPIRING can never be working from different numbers.
 *
 * Returns `{text, alarming, known}` rather than a printed string: `alarming` is the bit
 * a caller with somewhere louder to put it — a colour, an exit status, a card — needs,
 * and re-deriving it by matching on the sentence is how the two drift apart.
 */
export function certificateLine(certificate) {
  if (certificate === undefined) {
    return { known: false, alarming: false, text: 'not reported — the router answering predates this field; restart it to see' };
  }
  if (certificate === null) return { known: true, alarming: false, text: 'none — serving plain HTTP (TLS off, or no certificate yet)' };

  const name = certificate.name || '(unnamed)';
  const days = certificate.daysLeft ?? null;
  const checked = ago(certificate.checkedAt);
  const since = checked ? `  (checked ${checked})` : '';
  const byHand = `tailscale cert ${name}   (needs HTTPS Certificates: ${TAILNET_HTTPS_URL})`;

  if (days === null) {
    return {
      known: true,
      alarming: true,
      text: `${name} — an unreadable expiry${since}  ⚠ UNREADABLE — assume it is not renewing: ${byHand}`,
    };
  }
  if (days <= 0) {
    return {
      known: true,
      alarming: true,
      text: `${name} — EXPIRED ${Math.abs(roundDays(days))} days ago${since}  ⚠ the phone gets an interstitial, not the app: ${byHand}`,
    };
  }
  const left = `${roundDays(days)} days left`;
  if (days < ALARM_BELOW_DAYS) {
    return {
      known: true,
      alarming: true,
      text: `${name} — ${left}${since}  ⚠ EXPIRING — the renewal that should have happened has not: ${byHand}`,
    };
  }
  // Inside the fetch window is the ordinary state for a third of a certificate's life,
  // and it is said out loud so that a number lower than yesterday's does not read as a
  // problem — and so that a number stuck here for weeks does.
  if (days < OBTAIN_BELOW_DAYS) {
    return {
      known: true,
      alarming: false,
      text: `${name} — ${left}${since}  (inside the window; the loop is asking tailscale for the next one)`,
    };
  }
  return { known: true, alarming: false, text: `${name} — ${left}${since}` };
}
