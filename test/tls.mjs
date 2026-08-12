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
 *   and still refusing a bad one before the socket exists — and named in the boot log
 *   by the scheme the phone will actually dial, which under the router is not the one
 *   the process doing the printing can see on its own sockets.
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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-tls-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');

const {
  APP_CLEARTEXT_HOSTS,
  MIN_VERSION,
  certificate,
  certificateName,
  cleartextWarning,
  closeServer,
  isSecure,
  publicBaseUrl,
  tailnetServer,
  serverOptions,
} = await import(LIB('tls.js'));
const { reconcileBaseUrl } = await import(LIB('config.js'));

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

/**
 * A throwaway certificate that is genuinely past its date, for the one question no
 * `-days` can ask: `-days` will not go backwards, so the two dates are given outright.
 * `-not_before`/`-not_after` arrived in OpenSSL 3.5 and are absent from LibreSSL, so
 * this returns null there and the checks that need it skip out loud.
 */
const stamp = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z');
function expiredPair(agoDays) {
  const certFile = path.join(tmp, 'old-c.pem');
  const keyFile = path.join(tmp, 'old-k.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile, '-out', certFile,
        '-not_before', stamp(-(agoDays + 90) * 86400000),
        '-not_after', stamp(-agoDays * 86400000),
        '-subj', '/CN=localhost',
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 }
    );
  } catch {
    return null;
  }
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

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
const { server, front } = tailnetServer(material, (req, res) => {
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

  /* ------------------------------------------- and the URL the boot log names it by */

  /**
   * What `[beadcause] terminal` says, for a given config and set of listeners.
   *
   * Servers stood in for rather than bound: all `attachTerminalSocket` asks of one is
   * `on('upgrade')`, and whether it terminates TLS — which is `setSecureContext`
   * being there, exactly as `isSecure` decides it. A real pair of ports would prove
   * nothing more and would have to be closed.
   */
  const announced = async (c, srv) => {
    const said = [];
    const was = console.log;
    console.log = (...a) => said.push(a.join(' '));
    let attached = null;
    try {
      attached = await attachTerminalSocket(c, srv);
    } finally {
      console.log = was;
    }
    attached?.close();
    return said.find((line) => line.includes('] terminal')) || '';
  };
  const loopbackOnly = [{ on() {} }];
  const terminatesTls = [{ on() {}, setSecureContext() {} }];

  await check('the boot log names the terminal with the scheme the phone will dial', async () => {
    // The configuration launchd actually runs, and the one that was wrong: TLS is
    // terminated in bin/router.js, which owns the tailnet port, and the backend that
    // prints this line binds loopback only. So `isSecure` is false in the process
    // doing the printing while `baseUrl` is the https name — and the scheme has to
    // come off the origin, or the line names a `ws://` that cannot connect.
    const line = await announced(
      { terminal: true, token: 'x', host: '127.0.0.1', port: 4318, baseUrl: 'https://m4.tail0.ts.net:4318' },
      loopbackOnly,
    );
    assert.match(line, /wss:\/\/m4\.tail0\.ts\.net:4318\/ws\/terminal$/, `got: ${line}`);
  });

  await check('and still says ws:// for a loopback server on an http baseUrl', async () => {
    const line = await announced(
      { terminal: true, token: 'x', host: '127.0.0.1', port: 4318, baseUrl: 'http://100.96.105.106:4318' },
      loopbackOnly,
    );
    assert.match(line, /ws:\/\/100\.96\.105\.106:4318\/ws\/terminal$/, `got: ${line}`);
    assert.doesNotMatch(line, /wss:/, `got: ${line}`);
  });

  await check('with no baseUrl at all the bound listener is the only evidence there is', async () => {
    // Every test that attaches a socket to a bare server, including the two above this
    // section — there is no origin to go off, so the listener answers for itself, and
    // the address it prints has to carry the same scheme.
    const cfgless = { terminal: true, token: 'x', host: '127.0.0.1', port: 4318 };
    assert.match(await announced(cfgless, loopbackOnly), /ws:\/\/127\.0\.0\.1:4318\/ws\/terminal$/);
    assert.match(await announced(cfgless, terminatesTls), /wss:\/\/127\.0\.0\.1:4318\/ws\/terminal$/);
  });
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

/* ------------------------------------------- the URL the phone is actually given */

/**
 * `baseUrl` follows the certificate, and only the certificate.
 *
 * The failure this pins is silent and total: an `https://` link generated on a machine
 * whose tailnet has no **HTTPS Certificates** would reach a port serving plain HTTP,
 * and a TLS parse error is not a page anyone can read. Nothing in the app would notice
 * — the daemon comes up, the log says http, and only the phone finds out. So the rule
 * is that holding a servable pair on disk is the *only* thing that produces an https
 * URL, and every way of not holding one lands back on the address that works.
 *
 * The other half is that a `baseUrl` you set yourself is yours. `reconcileBaseUrl`
 * runs on every `loadConfig()`, in every CLI, so an over-eager match would overwrite a
 * reverse proxy or a real domain on the next `beadcause-ask` and never mention it.
 */
const NAME = material.name;
const CFG = { port: 4318, tls: { enabled: true, name: NAME } };
const tlsCache = path.join(tmp, 'config', 'tls');
/** The Tailscale address, or loopback where there is no tailnet — either is fine. */
const PLAIN = /^http:\/\/(?:100\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.0\.0\.1):4318$/;

/** Put the pair `certificateName` looks for on disk, or take it away. */
function plant({ cert = null, key = null } = {}) {
  fs.mkdirSync(tlsCache, { recursive: true });
  for (const [file, bytes] of [
    [`${NAME}.crt`, cert],
    [`${NAME}.key`, key],
  ]) {
    const at = path.join(tlsCache, file);
    if (bytes) fs.writeFileSync(at, bytes);
    else fs.rmSync(at, { force: true });
  }
}

/** `reconcileBaseUrl` narrates on stderr; a passing test should not. */
function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = real;
  }
}

await check('with no certificate the URL is the address over plain http, not a broken https one', () => {
  plant({});
  assert.equal(certificateName(CFG), null);
  assert.match(publicBaseUrl(CFG), PLAIN);
});

await check('half a pair is not a certificate', () => {
  plant({ cert: material.cert });
  assert.equal(certificateName(CFG), null, 'a fetch interrupted between the two files must not read as success');
  assert.match(publicBaseUrl(CFG), PLAIN);
});

await check('a cached pair moves the URL onto the name it is for, on the configured port', () => {
  plant(material);
  assert.equal(certificateName(CFG), NAME);
  assert.equal(publicBaseUrl(CFG), `https://${NAME}:4318`);
  assert.equal(publicBaseUrl({ ...CFG, port: 4444 }), `https://${NAME}:4444`);
});

// bc-jv86: past the expiry date the socket still carries the certificate and the front
// still 307s plain http to the name — so the URL has to keep saying the same thing. It
// did not: `certificateName` wanted a day left, `publicBaseUrl` fell back to
// `http://100.x.y.z:4318`, `reconcileBaseUrl` persisted that on the next `loadConfig()`,
// and the priority-5 "certificate has EXPIRED" push — whose tap target is `cfg.baseUrl`
// — then opened the one URL the running daemon bounces straight back to https. The
// certificate being expired is an outage with an alarm on it, not a reason for the two
// halves of the daemon to describe themselves differently.
const expired = expiredPair(3);
if (!expired) {
  skip('an expired certificate still names the URL it is served on — this openssl cannot mint one');
} else {
  await check('an expired certificate still names the URL it is served on', () => {
    plant(expired);
    assert.equal(certificateName(CFG), NAME, 'the socket keeps serving it, so the URL must keep pointing at it');
    assert.equal(publicBaseUrl(CFG), `https://${NAME}:4318`);
  });

  await check('and the saved baseUrl is not quietly downgraded to http when the date passes', () => {
    plant(expired);
    const cfg = { ...CFG, baseUrl: `https://${NAME}:4318` };
    quietly(() => reconcileBaseUrl(cfg));
    assert.equal(cfg.baseUrl, `https://${NAME}:4318`, 'the EXPIRED push taps this URL — it must be one the daemon serves');
  });
}

await check('and tls.enabled false is never an https URL, certificate or no certificate', () => {
  plant(material);
  assert.equal(certificateName({ ...CFG, tls: { enabled: false, name: NAME } }), null);
  assert.match(publicBaseUrl({ ...CFG, tls: { enabled: false, name: NAME } }), PLAIN);
});

await check('a saved address is moved across — including one that is no longer this machine', () => {
  plant(material);
  for (const was of ['http://100.96.105.106:4318', 'http://100.70.1.2:4318', 'http://127.0.0.1:4318']) {
    const cfg = { ...CFG, baseUrl: was };
    quietly(() => reconcileBaseUrl(cfg));
    assert.equal(cfg.baseUrl, `https://${NAME}:4318`, `${was} should have moved`);
  }
});

await check('and moved back the moment the certificate is gone', () => {
  plant({});
  const cfg = { ...CFG, baseUrl: `https://${NAME}:4318` };
  quietly(() => reconcileBaseUrl(cfg));
  assert.match(cfg.baseUrl, PLAIN, 'an https URL with nothing to serve it is the one thing worse than the address');
});

await check('a baseUrl you set yourself is never touched', () => {
  plant(material);
  // A real domain, a LAN address, a tunnel, a proxy on 443 — none of these came out of
  // this repo, and every one of them is a deliberate answer to "how do I reach it".
  for (const mine of ['https://beads.example.com', 'http://192.168.1.10:4318', 'https://beads.example.com:8443', 'http://mac.local:4318']) {
    const cfg = { ...CFG, baseUrl: mine };
    quietly(() => reconcileBaseUrl(cfg));
    assert.equal(cfg.baseUrl, mine, `${mine} is not ours to rewrite`);
  }
});

await check('reconciling persists nothing unless it is asked to', () => {
  plant(material);
  const written = path.join(tmp, 'config', 'config.json');
  fs.rmSync(written, { force: true });
  const cfg = { ...CFG, baseUrl: 'http://100.96.105.106:4318' };
  quietly(() => reconcileBaseUrl(cfg));
  assert.equal(fs.existsSync(written), false, 'a CLI that only wanted to print a URL must not rewrite the config');
});

/* ------------------------------------- what the Mac says about the link it prints */

// bc-affn. The http fallback above is right for a browser and unusable by the APK — it
// has had cleartext off since bc-14s — so the moment a link is printed is the moment to
// say so, while the person is still standing at the Mac that can fix it.

await check('an http link is called out as one the Android app will refuse', () => {
  const said = cleartextWarning('http://100.96.105.106:4318');
  assert.ok(said, 'the address the QR falls back to is exactly the one the app cannot pair with');
  const all = said.join(' ');
  assert.match(all, /Android app will refuse/i, 'it has to name what refuses it');
  assert.match(all, /login\.tailscale\.com\/admin\/dns/, 'and where the fix is, which is not on this Mac');
});

await check('and an https link says nothing at all', () => {
  // Silence is the load-bearing half: a line printed on every run is a line nobody reads
  // on the run that matters.
  for (const url of [`https://${NAME}:4318`, 'https://beads.example.com', 'https://beads.example.com:8443']) {
    assert.equal(cleartextWarning(url), null, `${url} is pairable and must be silent`);
  }
});

await check('nor does loopback, which the app still permits and an emulator lives on', () => {
  for (const host of APP_CLEARTEXT_HOSTS) {
    assert.equal(cleartextWarning(`http://${host}:4318`), null, `${host} is in the APK's cleartext exceptions`);
  }
});

await check('an http address that is not the tailnet is warned about too', () => {
  // A LAN address or a bare hostname set by hand: the app refuses those for the same
  // reason and with the same sentence, so the rule is the scheme rather than the shape.
  for (const url of ['http://192.168.1.10:4318', 'http://mac.local:4318', 'http://beads.example.com']) {
    assert.ok(cleartextWarning(url), `${url} is cleartext and the app will not send its token to it`);
  }
});

await check('and a URL that is not a URL is not a warning', () => {
  for (const junk of ['', null, undefined, 'not a url', '100.96.105.106:4318']) {
    assert.equal(cleartextWarning(junk), null, `${JSON.stringify(junk)} must not throw or invent a warning`);
  }
});

/** `bin/beadcause.js <flag>` against a config of our own, as a real process. */
function cli(flag, baseUrl) {
  const dir = fs.mkdtempSync(path.join(tmp, 'cli-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ baseUrl, token: 'tok' }));
  const run = spawnSync(process.execPath, [path.join(HERE, '..', 'bin', 'beadcause.js'), flag], {
    encoding: 'utf8',
    env: { ...process.env, BEADCAUSE_CONFIG_DIR: dir },
  });
  return { out: run.stdout, err: run.stderr, code: run.status };
}

await check('`--url` keeps the warning off stdout, because scripts pipe that', () => {
  // The acceptance criterion, as the thing it protects: `beadcause --url` is read into
  // shell variables, and a sentence in there is an address nothing can dial.
  const r = cli('--url', 'http://192.168.1.10:4318');
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'http://192.168.1.10:4318/?t=tok', 'stdout is the URL and nothing else');
  assert.match(r.err, /Android app will refuse/, 'and the warning still gets said, on stderr');
});

await check('and says nothing on either stream when the link is already https', () => {
  const r = cli('--url', 'https://beads.example.com');
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'https://beads.example.com/?t=tok');
  assert.equal(r.err.trim(), '', 'a pairable link is not worth a word');
});

await check('`--qr` still prints its code, with the warning last on stderr', () => {
  const r = cli('--qr', 'http://192.168.1.10:4318');
  assert.equal(r.code, 0);
  assert.match(r.out, /Pair the app/, 'the QR itself is untouched');
  assert.match(r.out, /http:\/\/192\.168\.1\.10:4318\/\?t=tok/);
  assert.match(r.err, /login\.tailscale\.com\/admin\/dns/);
});

// The one thing on the bead that no test on this machine can answer: whether a phone
// walks up to the real MagicDNS name and gets no interstitial. That is a fact about
// `tailscale cert`, Let's Encrypt and the tailnet's own HTTPS setting — not about any
// code here — and faking it with a trust store the test controls would prove nothing.
skip('the real certificate, and a phone trusting it without an interstitial');

closeServer(server);
done();
