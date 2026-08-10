import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
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
 * Renewing is not this file's job. It obtains a certificate at startup, and reuses the
 * cached one while it has more than a month left; a daemon that has been up since
 * before the expiry still needs waking, and that is bc-ft4.
 */

/** The floor. Not configurable: a knob here is a knob for putting TLS 1.0 back. */
export const MIN_VERSION = 'TLSv1.2';

/** Below this many days left, ask `tailscale cert` for a fresh one at startup. */
const OBTAIN_BELOW_DAYS = 31;

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
 * Where the pair for `name` lives — in one place, so the cheap check below and the
 * fetch above can never look at different files and disagree about what we hold.
 */
const certFiles = (name) => ({
  certFile: path.join(tlsDir(), `${name}.crt`),
  keyFile: path.join(tlsDir(), `${name}.key`),
});

/** Days until this certificate file expires, or null if it cannot be read as one. */
function daysLeft(file) {
  try {
    const cert = new X509Certificate(fs.readFileSync(file));
    const until = cert.validToDate ? cert.validToDate.getTime() : Date.parse(cert.validTo);
    return Number.isFinite(until) ? (until - Date.now()) / 86400000 : null;
  } catch {
    return null;
  }
}

/**
 * `tailscale cert` into our own directory.
 *
 * Note it can fail while still exiting 0 — an account without the feature prints a
 * 500 to stderr and returns success — so the files, not the exit code, are the test
 * of whether this worked.
 */
function obtain(name, certFile, keyFile, say, warn) {
  const bin = tailscaleBin();
  if (!bin) {
    warn('no tailscale CLI found — cannot fetch a certificate');
    return false;
  }
  let output = '';
  try {
    fs.mkdirSync(tlsDir(), { recursive: true, mode: 0o700 });
    // Generous: this is a Let's Encrypt round trip on a cold cache.
    output = execFileSync(bin, ['cert', '--cert-file', certFile, '--key-file', keyFile, name], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    output = `${err.stderr || ''}${err.stdout || ''}` || err.message;
  }
  const left = daysLeft(certFile);
  if (left !== null && left > 0 && fs.existsSync(keyFile)) {
    say(`certificate for ${name} — ${Math.round(left)} days left`);
    return true;
  }
  const detail = String(output).trim().split('\n').filter(Boolean).pop() || 'no certificate was written';
  warn(`\`tailscale cert ${name}\` did not produce a certificate — ${detail}`);
  warn('enable HTTPS Certificates for the tailnet: https://login.tailscale.com/admin/dns');
  return false;
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
  if ((!usable || left < OBTAIN_BELOW_DAYS) && !obtain(name, certFile, keyFile, say, warn) && !usable) {
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
 */
export function secureServer(material, handler) {
  const server = https.createServer(serverOptions(material), handler);

  const front = net.createServer((socket) => {
    socket.setTimeout(SNIFF_TIMEOUT_MS, () => socket.destroy());
    socket.once('error', () => socket.destroy());
    socket.once('data', (first) => {
      // Handed on from here: whichever side takes the socket owns its timeouts.
      socket.setTimeout(0);
      if (first[0] !== TLS_HANDSHAKE_BYTE) return redirectToHttps(socket, first, material.name);
      socket.pause();
      socket.unshift(first);
      server.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });

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
