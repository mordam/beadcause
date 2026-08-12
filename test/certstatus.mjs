/**
 * The certificate is on a screen, and the alarm window is marked on it.
 *
 * The renewal loop had no readout. It logs to launchd's file — on a Mac nobody is
 * sitting at — and pushes to ntfy at the point where the certificate is nearly gone, so
 * "is my certificate fine?" could only be answered by opening a log or waiting for the
 * alarm. `npm run swap:status` is the command that is already run to ask what the daemon
 * is doing, and it reported the router, the backend and the build and nothing about TLS.
 *
 * Two halves are pinned here, and the second is the one that would rot:
 *
 * - `certificateLine` — the sentence, across every shape the field arrives in. The three
 *   kinds of "no number" have to stay distinct: a router too old to carry the field is
 *   *could not say*, `null` is *serving plain HTTP*, and a certificate whose bytes will
 *   not parse is an alarm. Collapsing any pair of those is a status line that lies in
 *   the reassuring direction.
 * - the printer — `bin/router.js --status` is spawned for real against a stub control
 *   plane, because a formatter nothing calls is worth nothing. The stub is what makes a
 *   certificate inside the alarm window testable at all: on this machine the real
 *   socket's certificate is whatever `tailscale cert` last got, which is by definition
 *   the case that is *not* interesting.
 *
 * Nothing here talks to a tailnet, parses a real certificate, or starts a router: the
 * snapshot is a fixture, which is the whole reason the days-left arithmetic can be
 * checked at 9 days, at 0 and at -2 without waiting three months for any of them.
 *
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-certstatus-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { ALARM_BELOW_DAYS, certificateLine } = await import(LIB('tls.js'));

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
const done = (code) => {
  removeTreeSync(tmp);
  console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
  process.exit(code ?? (failures ? 1 : 0));
};

console.log('the certificate, on a screen');

const NAME = 'test-mac.beadcause-test.ts.net';

/* --------------------------------------------------------------- the sentence */

await check('a certificate with months left is its name and its number, and nothing louder', () => {
  const line = certificateLine({ name: NAME, daysLeft: 61.4 });
  assert.match(line.text, new RegExp(NAME));
  assert.match(line.text, /61\.4 days left/);
  assert.equal(line.alarming, false);
  assert.equal(line.known, true);
  assert.ok(!line.text.includes('⚠'), `nothing to warn about, but: ${line.text}`);
});

await check('inside the alarm window it is marked, not merely printed', () => {
  const line = certificateLine({ name: NAME, daysLeft: ALARM_BELOW_DAYS - 5 });
  assert.equal(line.alarming, true);
  assert.match(line.text, /⚠/);
  assert.match(line.text, /EXPIRING/);
  // And says what to do about it: a warning you have to go and research is one that
  // waits until the weekend.
  assert.match(line.text, new RegExp(`tailscale cert ${NAME}`));
  assert.match(line.text, /login\.tailscale\.com/);
});

await check('the day either side of the threshold falls the right way', () => {
  assert.equal(certificateLine({ name: NAME, daysLeft: ALARM_BELOW_DAYS - 0.1 }).alarming, true);
  assert.equal(certificateLine({ name: NAME, daysLeft: ALARM_BELOW_DAYS }).alarming, false);
  assert.equal(certificateLine({ name: NAME, daysLeft: ALARM_BELOW_DAYS + 1 }).alarming, false);
});

await check('a certificate that has gone says how long ago, not "expires in -2 days"', () => {
  const line = certificateLine({ name: NAME, daysLeft: -2.5 });
  assert.equal(line.alarming, true);
  assert.match(line.text, /EXPIRED 2\.5 days ago/);
  assert.ok(!/-2\.5/.test(line.text), `no negative days: ${line.text}`);
  // Zero is the same side of the line as gone: a certificate expiring today is not fine.
  assert.equal(certificateLine({ name: NAME, daysLeft: 0 }).alarming, true);
});

await check('the renewal window is said out loud, so a falling number does not read as a fault', () => {
  const line = certificateLine({ name: NAME, daysLeft: 22 });
  assert.equal(line.alarming, false);
  assert.match(line.text, /22 days left/);
  assert.match(line.text, /asking tailscale/);
});

await check('an unreadable expiry is an alarm, not a shrug', () => {
  const line = certificateLine({ name: NAME, daysLeft: null });
  assert.equal(line.alarming, true);
  assert.match(line.text, /UNREADABLE/);
  assert.match(line.text, /⚠/);
  // Not "0 days left", and not silence: bytes that will not parse are not "fine for
  // another 89 days" either.
  assert.ok(!/days left/.test(line.text), `no invented number: ${line.text}`);
});

await check('plain HTTP is reported as plain HTTP, and is not an alarm', () => {
  const line = certificateLine(null);
  assert.equal(line.alarming, false);
  assert.equal(line.known, true);
  assert.match(line.text, /plain HTTP/);
  assert.ok(!line.text.includes('⚠'), `a tailnet without HTTPS certificates is not a fault: ${line.text}`);
});

await check('a router too old to carry the field says so, rather than "no certificate"', () => {
  const line = certificateLine(undefined);
  assert.equal(line.known, false);
  assert.equal(line.alarming, false);
  assert.match(line.text, /not reported/);
  assert.match(line.text, /restart/);
  // The distinction that matters: this must not be readable as the plain-HTTP answer.
  assert.ok(!/plain HTTP/.test(line.text), `could not say ≠ no certificate: ${line.text}`);
});

await check('when the loop last looked is carried through, and only when it is known', () => {
  const recent = certificateLine({ name: NAME, daysLeft: 61, checkedAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString() });
  assert.match(recent.text, /checked 4h ago/);
  const minutes = certificateLine({ name: NAME, daysLeft: 61, checkedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString() });
  assert.match(minutes.text, /checked 12m ago/);
  // An old router carries no timestamp, and a made-up "checked just now" would be the
  // one part of this line that cannot be checked by looking at the certificate.
  assert.ok(!/checked/.test(certificateLine({ name: NAME, daysLeft: 61 }).text));
  assert.ok(!/checked/.test(certificateLine({ name: NAME, daysLeft: 61, checkedAt: null }).text));
});

/* ---------------------------------------------------- and the printer calls it */

/** A router state the printer will accept, with `certificate` swapped per case. */
const snapshotWith = (certificate, port) => {
  const snap = {
    router: { pid: 4242, port, build: 'r-1', sourceChanged: false },
    disk: 'b-1',
    stale: false,
    swapping: false,
    poisoned: null,
    deferred: null,
    serving: true,
    outage: null,
    retryAt: 0,
    slowness: 0,
    active: { pid: 4243, port: port + 1, build: 'b-1', role: 'primary', reaping: true, inflight: 0, upgrades: 0, upSeconds: 90 },
    retiring: [],
  };
  // Absent rather than null when the case is "a router older than the field": the
  // printer's third answer exists precisely because `undefined` survives JSON by
  // vanishing, and a test that sent `null` would never reach it.
  if (certificate !== undefined) snap.certificate = certificate;
  return snap;
};

/**
 * Run the real `--status` against a stub control plane and hand back what it printed.
 *
 * The stub answers `/internal/router/state` and nothing else, which is all this CLI
 * path asks for — so no backend is spawned, no port 4318 is touched, and the case under
 * test is a fixture rather than whatever this Mac's certificate happens to be today.
 */
async function statusAgainst(certificate) {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/internal/router/state')) {
      res.writeHead(404).end('{}');
      return;
    }
    seenToken = req.headers['x-beadcause-token'] || null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snapshotWith(certificate, port)));
  });
  let seenToken = null;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, token: 'stub-token', tls: { enabled: false } }));

  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'router.js'), '--status'], {
        env: { ...process.env, BEADCAUSE_CONFIG_DIR: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr, token: seenToken }));
    });
    return out;
  } finally {
    server.close();
  }
}

await check('`--status` prints the certificate line, and reaches the control plane to get it', async () => {
  const out = await statusAgainst({ name: NAME, daysLeft: 61.4, checkedAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString() });
  assert.equal(out.code, 0, `exit ${out.code}: ${out.stderr}`);
  const cert = out.stdout.split('\n').find((l) => l.startsWith('cert '));
  assert.ok(cert, `no cert line in:\n${out.stdout}`);
  assert.match(cert, new RegExp(NAME));
  assert.match(cert, /61\.4 days left/);
  assert.match(cert, /checked 5h ago/);
  // The line is beside the build, not instead of it.
  assert.match(out.stdout, /^disk {5}b-1/m);
  assert.equal(out.token, 'stub-token');
});

await check('`--status` marks a certificate inside the alarm window', async () => {
  const out = await statusAgainst({ name: NAME, daysLeft: 9.1 });
  assert.equal(out.code, 0, `exit ${out.code}: ${out.stderr}`);
  const cert = out.stdout.split('\n').find((l) => l.startsWith('cert '));
  assert.ok(cert, `no cert line in:\n${out.stdout}`);
  assert.match(cert, /9\.1 days left/);
  assert.match(cert, /⚠ EXPIRING/);
  assert.match(cert, new RegExp(`tailscale cert ${NAME}`));
});

await check('`--status` on a plain-HTTP router, and on one older than the field', async () => {
  const plain = await statusAgainst(null);
  assert.equal(plain.code, 0, `exit ${plain.code}: ${plain.stderr}`);
  assert.match(plain.stdout, /^cert {5}none — serving plain HTTP/m);

  const old = await statusAgainst(undefined);
  assert.equal(old.code, 0, `exit ${old.code}: ${old.stderr}`);
  assert.match(old.stdout, /^cert {5}not reported/m);
});

done();
