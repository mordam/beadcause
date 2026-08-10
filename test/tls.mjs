/**
 * The protocol floor, and the three things that must survive being put behind TLS.
 *
 * The floor is the part that cannot be checked by hand once and believed afterwards:
 * "TLS 1.2 minimum" is one option on one object, it has no visible effect until
 * something old dials in, and nothing in the app would notice it being dropped. So it
 * is pinned here as a real handshake — a client that offers TLS 1.1 is *refused by the
 * server*, with the alert to prove which side said no, and 1.2 and 1.3 both connect and
 * get an answer.
 *
 * The other three are the seams the sniffing front sits on:
 *
 * - an HTTPS request served intact, which is the whole handover — the front peeks at
 *   one byte, pushes it back, and hands the socket to the HTTPS server;
 * - a plain http request on the TLS port answered with a 307 to the certificate's
 *   name, path and query kept, because every URL already in a notification, a QR and
 *   an installed PWA is `http://100.x.y.z:4318/...` and none of them may break;
 * - the terminal WebSocket over `wss`, still authenticated by the token subprotocol
 *   and still refusing a bad one before the socket exists.
 *
 * Nothing here touches the tailnet. The certificate is self-signed by `openssl` into a
 * temp directory, which is enough for every question above: whether a phone *trusts*
 * the certificate is a fact about Let's Encrypt and `tailscale cert`, not about this
 * code, and no test on this machine can answer it.
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
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-tls-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');

const { MIN_VERSION, certificate, closeServer, isSecure, secureServer, serverOptions } = await import(LIB('tls.js'));

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
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
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

/* ------------------------------------------------------------------ fixtures */

/** A throwaway certificate. Self-signed: nothing here is asking anyone to trust it. */
function selfSigned() {
  const certFile = path.join(tmp, 'c.pem');
  const keyFile = path.join(tmp, 'k.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=localhost'],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 }
  );
  return { name: 'test-mac.tailscale-test.ts.net', cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

console.log('https on the tailnet name');

let material;
try {
  material = selfSigned();
} catch (err) {
  // Said loudly rather than silently passing: on a machine with no `openssl` the floor
  // is unverified, and a green suite that checked nothing is worse than a red one.
  console.log(`  SKIP everything — no usable \`openssl\` to make a test certificate (${err.message.split('\n')[0]})`);
  done(0);
}

const requests = [];
const { server, front } = secureServer(material, (req, res) => {
  requests.push(req.url);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
server.front = front;
await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
const port = front.address().port;

/** Every refusal the server itself issued, so a failed handshake can be attributed. */
const serverRefusals = [];
server.on('tlsClientError', (err) => serverRefusals.push(err.code));

/** Speak TLS at a given version and say what happened. */
const dial = (opts) =>
  new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...opts }, () => {
      const protocol = socket.getProtocol();
      socket.destroy();
      resolve({ connected: true, protocol });
    });
    socket.on('error', (err) => resolve({ connected: false, code: err.code, message: err.message.split('\n')[0] }));
  });

/** A raw request, byte for byte, and whatever comes back. */
const raw = (payload) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(payload));
    let body = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => (body += chunk));
    socket.on('close', () => resolve(body));
    socket.on('error', () => resolve(body));
  });

/* --------------------------------------------------------------------- cases */

await check('the floor is TLS 1.2, on the options the server is built from', () => {
  assert.equal(MIN_VERSION, 'TLSv1.2');
  assert.equal(serverOptions(material).minVersion, 'TLSv1.2');
  assert.equal(serverOptions(material).cert, material.cert);
});

// `@SECLEVEL=0` is what makes this a test of the *server*. Node's own client refuses to
// offer TLS 1.1 at the default security level, and a client-side refusal would pass
// this test with the floor removed.
const OLD = { ciphers: 'DEFAULT:@SECLEVEL=0' };

await check('a client offering only TLS 1.1 is refused the handshake, by us', async () => {
  serverRefusals.length = 0;
  const r = await dial({ ...OLD, minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1' });
  assert.equal(r.connected, false, `TLS 1.1 must not connect — got ${r.protocol}`);
  assert.equal(r.code, 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', `expected a protocol-version alert, got ${r.code}: ${r.message}`);
  assert.deepEqual(serverRefusals, ['ERR_SSL_UNSUPPORTED_PROTOCOL'], 'the refusal has to come from the server, not the client');
});

await check('and TLS 1.0 the same way', async () => {
  const r = await dial({ ...OLD, minVersion: 'TLSv1', maxVersion: 'TLSv1' });
  assert.equal(r.connected, false, `TLS 1.0 must not connect — got ${r.protocol}`);
  assert.equal(r.code, 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', `got ${r.code}: ${r.message}`);
});

await check('TLS 1.2 and 1.3 both connect', async () => {
  const twelve = await dial({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
  assert.ok(twelve.connected, `TLS 1.2 must connect — ${twelve.code}: ${twelve.message}`);
  assert.equal(twelve.protocol, 'TLSv1.2');

  const thirteen = await dial({ minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  assert.ok(thirteen.connected, `TLS 1.3 must connect — ${thirteen.code}: ${thirteen.message}`);
  assert.equal(thirteen.protocol, 'TLSv1.3');
});

await check('a request over https reaches the handler and is answered', async () => {
  const body = await new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: '/api/health', rejectUnauthorized: false, headers: { host: material.name } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, out }));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(body.status, 200);
  assert.equal(body.out, 'ok');
  assert.ok(requests.includes('/api/health'), 'the sniffing front must hand the socket over with its bytes intact');
});

await check('plain http on the TLS port is redirected to the name that has the certificate', async () => {
  const answer = await raw(`GET /?t=sekrit HTTP/1.1\r\nHost: 100.96.105.106:${port}\r\n\r\n`);
  assert.match(answer, /^HTTP\/1\.1 307 /, `got: ${answer.split('\r\n')[0]}`);
  // The certificate's name, not the Host header's — the address is exactly what cannot
  // be served over TLS. And the token survives, or a pairing link is a re-pair.
  assert.match(answer, new RegExp(`Location: https://${material.name}:${port}/\\?t=sekrit\r\n`), `got: ${answer}`);
});

await check('a POST is redirected too, method-preserving', async () => {
  const answer = await raw(`POST /api/respond HTTP/1.1\r\nHost: x:${port}\r\nContent-Length: 0\r\n\r\n`);
  assert.match(answer, /^HTTP\/1\.1 307 /, `got: ${answer.split('\r\n')[0]}`);
  assert.match(answer, new RegExp(`Location: https://${material.name}:${port}/api/respond\r\n`));
});

await check('anything that is neither TLS nor HTTP gets nothing at all', async () => {
  const answer = await raw('HELO there\r\n\r\n');
  assert.equal(answer, '', `a port scan should be told nothing — got: ${answer}`);
});

/* ------------------------------------------------------- the terminal, over wss */

let ws = null;
try {
  ws = (await import('ws')).default;
} catch {
  /* not installed — the daemon survives that too, and so does this */
}

if (!ws) {
  skip('the terminal WebSocket over wss — the `ws` package is not installed');
} else {
  const { attachTerminalSocket } = await import(LIB('termsocket.js'));
  const cfg = { terminal: true, token: 'the-shared-token', host: '127.0.0.1', port };
  const wss = await attachTerminalSocket(cfg, [server]);

  /** Connect, and report how it ended rather than whether it opened. */
  const dialWs = (protocols) =>
    new Promise((resolve) => {
      const socket = new ws(`wss://127.0.0.1:${port}/ws/terminal?id=no-such-terminal`, protocols, { rejectUnauthorized: false });
      socket.on('close', (code, reason) => resolve({ closed: code, reason: String(reason) }));
      socket.on('error', (err) => resolve({ error: err.message }));
    });

  await check('wss with the token subprotocol gets through to the terminal registry', async () => {
    assert.ok(wss, 'the socket server must have attached');
    const r = await dialWs(['beadcause.term.v1', 'tok.the-shared-token']);
    // 1008 is the refusal that happens *after* the upgrade: the handshake succeeded,
    // the token was accepted, and the id was the only thing wrong. Which is exactly
    // what proves TLS changed nothing about the handshake.
    assert.equal(r.closed, 1008, `expected the policy close for an unknown id — got ${JSON.stringify(r)}`);
    assert.match(r.reason, /no such terminal/);
  });

  await check('and a wrong token is still refused before a socket exists', async () => {
    const r = await dialWs(['beadcause.term.v1', 'tok.wrong']);
    assert.ok(r.error, `expected a failed handshake — got ${JSON.stringify(r)}`);
    assert.match(r.error, /401/, `expected the 401 to reach the client — got ${r.error}`);
  });

  wss.close();
}

/* --------------------------------------------------- the rules around the switch */

await check('tls.enabled false asks tailscale for nothing and returns nothing', () => {
  assert.equal(certificate({ tls: { enabled: false } }), null);
});

await check('an unreachable name is a plain-http daemon, not a dead one', () => {
  // `tls.name` is honoured, so this needs no tailnet: the name is real enough to try
  // and there is no certificate for it in the temp config directory.
  assert.equal(certificate({ tls: { enabled: true, name: 'nobody.example.ts.net' } }, { quiet: true }), null);
});

await check('loopback is never TLS, even when a certificate is available', async () => {
  const { listen } = await import(LIB('server.js'));
  const servers = listen({ port: 0, host: '127.0.0.1' }, (req, res) => res.end('ok'));
  try {
    assert.equal(servers.length, 1, 'one address, because host is loopback');
    assert.equal(isSecure(servers[0]), false, 'the control plane, npm run monitor and the router hop all speak plain http here');
  } finally {
    servers.forEach(closeServer);
  }
});

// The one thing on the bead that no test on this machine can answer: whether a phone
// walks up to the real MagicDNS name and gets no interstitial. That is a fact about
// `tailscale cert`, Let's Encrypt and the tailnet's own HTTPS setting — not about any
// code here — and faking it with a trust store the test controls would prove nothing.
skip('the real certificate, and a phone trusting it without an interstitial');

closeServer(server);
done();
