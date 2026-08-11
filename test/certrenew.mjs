/**
 * The certificate renews itself, on the socket, without dropping anything — and gets
 * itself in the first place — and says so out loud when it cannot.
 *
 * This is the half of HTTPS that has no symptom until it is far too late. `tailscale
 * cert` writes a 90-day certificate and nothing outside beadcause renews the copy it
 * keeps, so a daemon that is simply left running stops answering the phone about three
 * months after it started, with an interstitial and no clue on screen. There is no way
 * to notice that by hand — you would have to not touch the Mac for a quarter and then
 * be surprised — so it is pinned here instead.
 *
 * Five things are checked, and the third is the one worth the length of this file:
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
 *   a no-op that starts no timer;
 * - **a listener that came up with no certificate at all** serves plain http, keeps
 *   asking, and adopts the first one that appears on the same socket it has been holding
 *   all along. That last one drives the exact sequence bc-ij1e was filed for: a first
 *   fetch that fails, and a second, a moment later, that works.
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

const { acquireOnce, ALARM_BELOW_DAYS, certificate, closeServer, daysLeftOf, isSecure, magicDnsName, renewOnce, startRenewal, tailnetServer } =
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
const { server, front } = tailnetServer(expiring, (req, res) => {
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
  const idle = tailnetServer(plenty, () => {}).server;
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
  const doomed = tailnetServer(expiring, () => {}).server;
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

/* ------------------------------------ a boot with no certificate at all — bc-ij1e */

/**
 * The bug this section exists for: `certificate()` was called once, by whichever process
 * owned the port, on the way into `listen()`. If that single fetch failed the router
 * built a plain-http listener — and `startRenewal` then filtered its servers for one
 * carrying a certificate, found none, and returned null. No timer, no second ask, plain
 * http and http URLs on the phone until a human restarted the service.
 *
 * It was a reachable minute rather than a theoretical one: the first `tailscale cert`
 * after a tailnet's HTTPS Certificates switch is turned on can fail because the new
 * permission has not reached Let's Encrypt yet, and the identical command a moment later
 * writes the pair. So that is exactly what is driven here — `refuse`, then `days=90` —
 * against a listener holding a real port, and what is checked is that the *same socket*
 * goes from serving plain http to terminating TLS with nothing rebound.
 */
fs.rmSync(CERT_FILE, { force: true });
fs.rmSync(KEY_FILE, { force: true });
setMode('refuse');

const provisionalRequests = [];
const provisional = tailnetServer(certificate(cfg, { quiet: true }), (req, res) => {
  provisionalRequests.push(req.url);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('plain');
});
await new Promise((resolve) => provisional.front.listen(0, '127.0.0.1', resolve));
const plainPort = provisional.front.address().port;

/** One plain-http request at the provisional listener, headline and body. */
const plainGet = (p) =>
  new Promise((resolve) => {
    const request = `GET ${p} HTTP/1.1\r\nHost: 100.96.105.106:${plainPort}\r\nConnection: close\r\n\r\n`;
    const socket = net.connect(plainPort, '127.0.0.1', () => socket.end(request));
    let body = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => (body += chunk));
    socket.on('close', () => resolve(body));
    socket.on('error', () => resolve(body));
  });

await check('a listener that could not get a certificate comes up plain, not dead', async () => {
  assert.equal(provisional.server.tlsMaterial, null, 'nothing is on the socket');
  assert.ok(provisional.plain, 'and there is a plain server answering for it');
  assert.equal(isSecure(provisional.server), true, 'the https server exists, waiting for a context');

  const answer = await plainGet('/api/health');
  assert.match(answer, /^HTTP\/1\.1 200 /, `plain http has to be served, not redirected — got: ${answer.split('\r\n')[0]}`);
  assert.match(answer, /\bplain\b/, `the handler has to be wired to it — got: ${answer}`);
});

await check('and a client that guesses https gets nothing rather than a bad certificate', async () => {
  const attempt = await new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port: plainPort, rejectUnauthorized: false, servername: NAME }, () =>
      resolve({ connected: true })
    );
    socket.on('error', (err) => resolve({ connected: false, code: err.code }));
  });
  assert.equal(attempt.connected, false, 'there is no certificate to present, and no honest way to pretend');
});

await check('it keeps asking, and says so where a phone can hear it', async () => {
  const pushed = [];
  const shouted = [];
  const timer = startRenewal(cfg, [provisional.server, provisional.plain], {
    notify: (state) => {
      pushed.push(state);
      return Promise.resolve();
    },
    // The two clocks collapsed onto one another, so `maxGap` is a single tick and every
    // tick asks. Six hours and a minute are pinned by CHECK_EVERY_MS/ACQUIRE_EVERY_MS.
    everyMs: 60,
    acquireEveryMs: 60,
    log: () => {},
    warn: (m) => shouted.push(m),
  });
  assert.ok(timer, 'a listener with no certificate has something to do — this returned null before bc-ij1e');
  forgetCalls();
  // Left running on purpose: the second half of this check is that the *same* loop
  // notices the certificate when it finally appears.
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(calls().length >= 2, `it has to ask more than once — asked ${calls().length} times`);
  assert.equal(provisional.server.tlsMaterial, null, 'and a tailnet that refuses leaves the socket exactly as it was');
  assert.equal(pushed.length, 1, `one push for one problem — got ${pushed.length}`);
  assert.equal(pushed[0].state, 'absent');
  // The reason, from tailscale, and not a paraphrase — this is what lands on the phone.
  assert.match(pushed[0].detail, /does not support getting TLS certs/, `got: ${pushed[0].detail}`);
  assert.ok(
    shouted.some((m) => /STILL NO CERTIFICATE/.test(m)),
    `and the log has to say it in words you would notice — got: ${shouted.join(' | ')}`
  );

  // The second fetch: the same command, a moment later, working.
  setMode('days=90');
  const adopted = await new Promise((resolve) => {
    const bail = setTimeout(() => resolve(false), 8000);
    const poll = setInterval(() => {
      if (!provisional.server.tlsMaterial) return;
      clearInterval(poll);
      clearTimeout(bail);
      resolve(true);
    }, 20);
    poll.unref();
  });
  clearInterval(timer);
  assert.ok(adopted, 'a certificate that appears has to be adopted without a restart');
});

await check('the certificate lands on the socket the port was already bound to', async () => {
  assert.equal(provisional.front.address().port, plainPort, 'the net.Server in front held the port the whole way through');
  assert.ok(provisional.front.listening);

  const material = provisional.server.tlsMaterial;
  assert.equal(material.name, NAME);
  assert.equal(material.cert.toString(), fs.readFileSync(CERT_FILE).toString(), 'and it is the one on disk');

  const spoke = await new Promise((resolve) => {
    const req = https.request(
      { host: '127.0.0.1', port: plainPort, path: '/api/health', rejectUnauthorized: false, headers: { host: NAME } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, out }));
      }
    );
    req.on('error', (err) => resolve({ error: err.code }));
    req.end();
  });
  assert.equal(spoke.status, 200, `https has to work now — ${spoke.error || ''}`);
  assert.equal(spoke.out, 'plain', 'and reach the same handler');
});

await check('and plain http on that port now redirects, where a moment ago it was served', async () => {
  const answer = await plainGet('/?t=sekrit');
  assert.match(answer, /^HTTP\/1\.1 307 /, `got: ${answer.split('\r\n')[0]}`);
  assert.match(answer, new RegExp(`Location: https://${NAME}:${plainPort}/\\?t=sekrit\r\n`), `got: ${answer}`);
});

await check('once adopted, the loop is a renewal loop and stops shelling out', async () => {
  forgetCalls();
  const result = renewOnce(cfg, [provisional.server], { log: () => {}, warn: () => {} });
  assert.equal(result.state, 'fresh', `90 days is nothing to do — got ${result.state}`);
  assert.deepEqual(calls(), [], 'and nothing to ask tailscale about');
  // The one thing acquisition must not do twice: a socket that already has a certificate
  // is not waiting for one.
  assert.equal(acquireOnce(cfg, [provisional.server], { log: () => {}, warn: () => {} }).state, 'off');
});

await check('tls.enabled false waits for nothing — plain http is the answer, not a state to fix', () => {
  const off = { tls: { enabled: false, name: NAME } };
  const waiting = tailnetServer(null, () => {});
  assert.equal(acquireOnce(off, [waiting.server], { log: () => {}, warn: () => {} }).state, 'off');
  assert.equal(startRenewal(off, [waiting.server], { notify: () => {} }), null);
  closeServer(waiting.server);
});

closeServer(provisional.server);
closeServer(server);
done();
