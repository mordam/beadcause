/**
 * The certificate renews itself, on the socket, without dropping anything — and says so
 * out loud when it cannot.
 *
 * This is the half of HTTPS that has no symptom until it is far too late. `tailscale
 * cert` writes a 90-day certificate and nothing outside beadcause renews the copy it
 * keeps, so a daemon that is simply left running stops answering the phone about three
 * months after it started, with an interstitial and no clue on screen. There is no way
 * to notice that by hand — you would have to not touch the Mac for a quarter and then
 * be surprised — so it is pinned here instead.
 *
 * Four things are checked, and the third is the one worth the length of this file:
 *
 * - a certificate with months left costs nothing: no `tailscale`, no exec, no I/O
 *   beyond a date comparison;
 * - a renewal that fails leaves the working certificate on the socket, is logged as an
 *   alarm rather than a note, pushes **once** rather than every check, and carries the
 *   actual reason from `tailscale` so the notification is actionable from a phone;
 * - a renewal that succeeds swaps the live sockets: the port is never rebound, an HTTPS
 *   request works immediately, **a WebSocket opened before the swap is still open and
 *   still carrying messages after it**, and the TLS 1.2 floor survives — a
 *   `setSecureContext` given a bare key pair would quietly hand the version bounds back
 *   to whatever Node's default is that year;
 * - behind the router — a loopback-only listener with no TLS at all — the whole thing is
 *   a no-op that starts no timer.
 *
 * Nothing here touches the tailnet or Let's Encrypt. `BEADCAUSE_TAILSCALE` points at a
 * shell script that answers `status --json` and mints self-signed certificates with
 * `openssl`, which is enough for every question above: whether a *phone* trusts what
 * comes back is a fact about Tailscale's certificate authority and not about this code.
 *
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-certrenew-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');

const NAME = 'test-mac.beadcause-test.ts.net';
const TLS_DIR = path.join(tmp, 'config', 'tls');
const CERT_FILE = path.join(TLS_DIR, `${NAME}.crt`);
const KEY_FILE = path.join(TLS_DIR, `${NAME}.key`);
const cfg = { tls: { enabled: true, name: NAME } };

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}
function skip(name) {
  console.log(`  skip ${name}`);
}
const done = (code) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
  process.exit(code ?? (failures ? 1 : 0));
};

/* -------------------------------------------------- a tailscale that is not one */

const CONTROL = path.join(tmp, 'control');
const CALLS = `${CONTROL}.calls`;
process.env.BEADCAUSE_FAKE_TAILSCALE_CONTROL = CONTROL;

/**
 * Stand up a fake `tailscale` and point lib/config.js at it.
 *
 * A script rather than a stubbed function, so what runs in the test is the real
 * `obtain()` — the same `execFileSync`, the same "the files, not the exit code, decide
 * whether this worked" rule. Its `refuse` mode reproduces the one failure this whole
 * feature exists for, exactly as it happens: a tailnet without *HTTPS Certificates*
 * prints a 500 to stderr and **exits 0**.
 */
const FAKE = path.join(tmp, 'tailscale');
fs.writeFileSync(
  FAKE,
  `#!/bin/sh
control="$BEADCAUSE_FAKE_TAILSCALE_CONTROL"
echo "$@" >> "$control.calls"
if [ "$1" = "status" ]; then echo '{"Self":{"DNSName":"${NAME}."}}'; exit 0; fi
if [ "$1" != "cert" ]; then echo "fake tailscale: unknown subcommand $1" >&2; exit 1; fi
shift
cert=""; key=""; name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cert-file) cert="$2"; shift 2 ;;
    --key-file) key="$2"; shift 2 ;;
    *) name="$1"; shift ;;
  esac
done
mode=$(cat "$control")
if [ "$mode" = "refuse" ]; then
  echo 'error: 500 Internal Server Error: your Tailscale account does not support getting TLS certs' >&2
  exit 0
fi
days=\${mode#days=}
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$key" -out "$cert" -days "$days" -subj "/CN=$name" 2>/dev/null
echo "wrote $cert"
`,
  { mode: 0o755 }
);
process.env.BEADCAUSE_TAILSCALE = FAKE;

const setMode = (mode) => fs.writeFileSync(CONTROL, mode);
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : []);
const forgetCalls = () => fs.rmSync(CALLS, { force: true });

/** A certificate for NAME valid for `days`, written wherever asked. */
function mint(days, certFile, keyFile) {
  fs.mkdirSync(path.dirname(certFile), { recursive: true });
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', String(days), '-subj', `/CN=${NAME}`],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 }
  );
  return {
    name: NAME,
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
    certFile,
    keyFile,
  };
}

console.log('renewing the tailnet certificate');

const { ALARM_BELOW_DAYS, certificate, closeServer, daysLeftOf, isSecure, magicDnsName, renewOnce, secureServer, startRenewal } =
  await import(LIB('tls.js'));

// The certificate the listener comes up with: inside the last month, so every renewal
// path below is live, and `tailscale` has a reason to be asked.
let expiring;
try {
  setMode('days=90');
  expiring = mint(5, CERT_FILE, KEY_FILE);
} catch (err) {
  // Said loudly rather than passing quietly: a green suite that checked nothing about
  // certificate renewal is worse than a red one.
  console.log(`  SKIP everything — no usable \`openssl\` to make a test certificate (${err.message.split('\n')[0]})`);
  done(0);
}

/* ------------------------------------------------------ the live listener */

const requests = [];
const { server, front } = secureServer(expiring, (req, res) => {
  requests.push(req.url);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
const port = front.address().port;

const serverRefusals = [];
server.on('tlsClientError', (err) => serverRefusals.push(err.code));

/** Speak TLS and report what happened, including which certificate came back. */
const dial = (opts = {}) =>
  new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: NAME, ...opts }, () => {
      const peer = socket.getPeerCertificate();
      const protocol = socket.getProtocol();
      socket.destroy();
      resolve({ connected: true, protocol, validTo: peer?.valid_to, fingerprint: peer?.fingerprint256 });
    });
    socket.on('error', (err) => resolve({ connected: false, code: err.code, message: err.message.split('\n')[0] }));
  });

/** One HTTPS request, to prove the port is still serving and not merely still bound. */
const get = (p) =>
  new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: p, rejectUnauthorized: false, headers: { host: NAME } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, out }));
    });
    req.on('error', reject);
    req.end();
  });

/** A raw byte-for-byte request, for the plain-http-on-the-TLS-port redirect. */
const raw = (payload) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(payload));
    let body = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => (body += chunk));
    socket.on('close', () => resolve(body));
    socket.on('error', () => resolve(body));
  });

const fingerprintOf = (pem) => new X509Certificate(pem).fingerprint256;

/* --------------------------------------------------------- nothing due yet */

await check('the override is what makes the MagicDNS name knowable without a tailnet', () => {
  assert.equal(magicDnsName(), NAME);
});

await check('months left costs nothing — no tailscale, no fetch, no reload', () => {
  const plenty = mint(90, path.join(tmp, 'plenty.crt'), path.join(tmp, 'plenty.key'));
  const idle = secureServer(plenty, () => {}).server;
  forgetCalls();
  const result = renewOnce(cfg, [idle], { log: () => {}, warn: () => {} });
  assert.equal(result.state, 'fresh');
  assert.ok(result.daysLeft > 85, `expected ~90 days, got ${result.daysLeft}`);
  assert.deepEqual(calls(), [], 'a check with nothing due must not shell out to tailscale');
  assert.equal(idle.tlsMaterial, plenty, 'and must not touch the material on the socket');
});

/* ------------------------------------------------- a renewal that cannot happen */

await check('a tailnet that will not issue keeps the working certificate on the socket', async () => {
  setMode('refuse');
  forgetCalls();
  const before = await dial();
  const said = [];
  const result = renewOnce(cfg, [server], { log: (m) => said.push(m), warn: (m) => said.push(m) });

  assert.equal(result.state, 'stale');
  assert.ok(result.daysLeft < ALARM_BELOW_DAYS, `${result.daysLeft} days should be inside the alarm window`);
  // The reason, from tailscale, and not a paraphrase — this is what lands on the phone.
  assert.match(result.detail, /does not support getting TLS certs/, `got: ${result.detail}`);
  assert.equal(calls().length, 1, 'it must actually have asked');

  const after = await dial();
  assert.ok(after.connected, `the listener must still be serving — ${after.code}`);
  assert.equal(after.fingerprint, before.fingerprint, 'a failed renewal must not disturb the certificate that works');
  assert.equal(server.tlsMaterial.cert.toString(), expiring.cert.toString());
});

await check('a certificate that has gone missing entirely is `lost`, not a crash', () => {
  const stashed = { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  fs.rmSync(CERT_FILE);
  fs.rmSync(KEY_FILE);
  try {
    const result = renewOnce(cfg, [server], { log: () => {}, warn: () => {} });
    assert.equal(result.state, 'lost');
    assert.match(result.detail, /no certificate/);
    // Still serving: an expiring certificate on the socket beats no socket at all.
    assert.equal(server.tlsMaterial.cert.toString(), expiring.cert.toString());
  } finally {
    fs.writeFileSync(CERT_FILE, stashed.cert);
    fs.writeFileSync(KEY_FILE, stashed.key);
  }
});

await check('the alarm is loud, is pushed, and is pushed once rather than every check', async () => {
  setMode('refuse');
  const pushed = [];
  const shouted = [];
  // Not the listening server: `startRenewal` reads the certificate off the socket, and
  // this one has to still be the expiring one when the successful renewal is tested
  // below. Every other thing it does is identical.
  const doomed = secureServer(expiring, () => {}).server;
  const timer = startRenewal(cfg, [doomed], {
    notify: (state) => {
      pushed.push(state);
      return Promise.resolve();
    },
    everyMs: 40,
    log: () => {},
    warn: (m) => shouted.push(m),
  });
  assert.ok(timer, 'a TLS listener has something to renew');
  try {
    await new Promise((r) => setTimeout(r, 260));
  } finally {
    clearInterval(timer);
  }

  assert.equal(pushed.length, 1, `one push for one problem, not one per check — got ${pushed.length}`);
  assert.ok(pushed[0].daysLeft < ALARM_BELOW_DAYS);
  assert.ok(
    shouted.some((m) => /CERTIFICATE NOT RENEWING/.test(m)),
    `the log has to say it in words you would notice — got: ${shouted.join(' | ')}`
  );
  assert.ok(
    shouted.some((m) => /tailscale cert /.test(m) && /login\.tailscale\.com/.test(m)),
    'and has to carry the command that fixes it'
  );
});

/* ------------------------------------------------ a renewal that does happen */

let ws = null;
try {
  ws = await import('ws');
} catch {
  /* not installed — the daemon survives that too, and so does this */
}

let live = null;
if (ws) {
  // Opened *before* the renewal and deliberately never touched by it: this is the
  // acceptance criterion that a reload must not drop live WebSocket connections.
  const wss = new ws.WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', (m) => socket.send(`echo:${m}`)));
  live = new ws.default(`wss://127.0.0.1:${port}/ws/test`, { rejectUnauthorized: false });
  await new Promise((resolve, reject) => {
    live.once('open', resolve);
    live.once('error', reject);
  });
}

await check('a fresh certificate is swapped onto the live sockets', async () => {
  const before = await dial();
  setMode('days=90');
  forgetCalls();
  const said = [];
  const result = renewOnce(cfg, [server], { log: (m) => said.push(m), warn: (m) => said.push(m) });

  assert.equal(result.state, 'renewed', `got ${result.state}: ${result.detail}`);
  assert.ok(result.daysLeft > 85, `expected ~90 days, got ${result.daysLeft}`);
  assert.equal(calls().length, 1);
  assert.ok(
    said.some((m) => /without a restart/.test(m)),
    `got: ${said.join(' | ')}`
  );

  const after = await dial();
  assert.ok(after.connected, `still serving — ${after.code}`);
  assert.notEqual(after.fingerprint, before.fingerprint, 'the new handshake must present the new certificate');
  assert.equal(after.fingerprint, fingerprintOf(fs.readFileSync(CERT_FILE)), 'and it must be the one on disk');
  assert.equal(server.tlsMaterial.cert.toString(), fs.readFileSync(CERT_FILE).toString());
});

await check('the port was never rebound, and answers immediately', async () => {
  assert.equal(front.address().port, port, 'the net.Server in front holds the port through a swap');
  assert.ok(front.listening, 'and is still listening');
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.out, 'ok');
  assert.ok(requests.includes('/api/health'), 'the handler is still wired to the same server object');
});

if (!ws) {
  skip('a WebSocket open across the swap stays open — the `ws` package is not installed');
} else {
  await check('a WebSocket open across the swap stays open and keeps carrying messages', async () => {
    assert.equal(live.readyState, 1, 'the socket opened before the renewal must still be OPEN');
    const echoed = await new Promise((resolve, reject) => {
      const bail = setTimeout(() => reject(new Error('no answer within 4s — the swap dropped the connection')), 4000);
      live.once('message', (m) => {
        clearTimeout(bail);
        resolve(String(m));
      });
      live.send('still here');
    });
    assert.equal(echoed, 'echo:still here');
    live.close();
  });
}

await check('the TLS 1.2 floor survives the swap', async () => {
  // `@SECLEVEL=0` is what makes this a test of the server: Node's own client refuses to
  // offer TLS 1.1 at the default security level, and a client-side refusal would pass
  // this with the floor gone.
  //
  // Honest about its reach: `setSecureContext` given a bare key pair instead of
  // `serverOptions` would still pass here, because Node's *own* default minimum has
  // been TLS 1.2 since v12. What this pins is that a swap cannot end up somewhere below
  // the floor — the day that default moves, or somebody passes a context built by hand
  // with `minVersion: 'TLSv1'` in it, this is what notices.
  serverRefusals.length = 0;
  const old = await dial({ ciphers: 'DEFAULT:@SECLEVEL=0', minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1' });
  assert.equal(old.connected, false, `TLS 1.1 must not connect after a renewal — got ${old.protocol}`);
  assert.deepEqual(serverRefusals, ['ERR_SSL_UNSUPPORTED_PROTOCOL'], 'and the refusal must come from us');

  const modern = await dial({ minVersion: 'TLSv1.2' });
  assert.ok(modern.connected, `TLS 1.2+ must still connect — ${modern.code}`);
});

await check('plain http on the TLS port still redirects, to the renewed certificate’s name', async () => {
  const answer = await raw(`GET /?t=sekrit HTTP/1.1\r\nHost: 100.96.105.106:${port}\r\n\r\n`);
  assert.match(answer, /^HTTP\/1\.1 307 /, `got: ${answer.split('\r\n')[0]}`);
  assert.match(answer, new RegExp(`Location: https://${NAME}:${port}/\\?t=sekrit\r\n`), `got: ${answer}`);
});

await check('the renewed certificate is what a restart would have picked up too', () => {
  const material = certificate(cfg, { quiet: true });
  assert.ok(material, 'a valid certificate on disk is a startup that gets HTTPS');
  assert.ok(daysLeftOf(material.cert) > 85);
  assert.equal(material.asked, null, 'and with 90 days left it asks tailscale for nothing');
});

/* --------------------------------------------------- nothing to renew is normal */

await check('a plain http listener starts no renewal at all', () => {
  const plain = { close() {} };
  assert.equal(isSecure(plain), false);
  assert.equal(startRenewal(cfg, [plain], { notify: () => {} }), null, 'behind the router there is no certificate here to keep');
  assert.equal(renewOnce(cfg, [plain], { log: () => {}, warn: () => {} }).state, 'off');
  assert.equal(startRenewal(cfg, [], { notify: () => {} }), null);
});

await check('tls.enabled false renews nothing even with a certificate sitting there', () => {
  const result = renewOnce({ tls: { enabled: false, name: NAME } }, [server], { log: () => {}, warn: () => {} });
  // `off` is the honest answer: the certificate on this socket is months from expiry,
  // and a switched-off configuration is not a renewal that failed.
  assert.ok(['off', 'fresh'].includes(result.state), `got ${result.state}`);
});

closeServer(server);
done();
