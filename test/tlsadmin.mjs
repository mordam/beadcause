/**
 * HTTPS as a switch on the admin screen — the promises the screen makes.
 *
 * The arithmetic here is trivial and none of it is what would break. What would break
 * is a promise:
 *
 * 1. **The intent survives the failure.** `tailscale cert` exits 0 and writes nothing
 *    when the tailnet has HTTPS Certificates off. If a failed fetch rolled
 *    `tls.enabled` back, then turning that setting on afterwards would leave HTTPS off
 *    for ever and nothing would say so — the whole point of the control is that you
 *    press it once and the daemon picks the certificate up when it can.
 * 2. **The sign-out is announced before it happens.** Enabling moves the origin, the
 *    token lives in localStorage, and localStorage is per origin — so `originWillChange`
 *    has to be true *before* the press, and the pairing link afterwards has to be on
 *    the new origin. A pairing link on the old one would be a button that signs you
 *    out and hands you the door you are already locked out of.
 * 3. **A `baseUrl` you set yourself is never moved, and never warned about.** A reverse
 *    proxy or a real domain in front of this daemon does not care what the tailnet
 *    address is doing, and a sign-out warning that cries wolf is one nobody reads on
 *    the day it is true.
 * 4. **"Restart to serve it" is asserted only when something can actually say.** The
 *    setting on disk and the certificate say what a listener *would* bind; only the
 *    process holding the port knows what it *did*. With no answer from it the screen
 *    must say nothing rather than guess.
 * 5. **The failure is classified, not paraphrased.** "Your Tailscale account does not
 *    support getting TLS certs" is a two-tap fix on a web page; an ACME rate limit is
 *    not, and sending somebody to that page for it would leave them with no other lead.
 * 6. **Turning it off keeps the certificate.** Deleting it would make an accidental
 *    press cost a Let's Encrypt round trip to undo.
 *
 * Nothing here talks to a tailnet: `setTls` takes its `obtain` as a parameter, so every
 * outcome of `tailscale cert` — including the one that exits 0 having written nothing —
 * is a fixture rather than an account somebody has to own. The certificate is
 * self-signed by `openssl` into a temp directory, which is all `certificateState` reads.
 *
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);
const PAGE = path.join(HERE, '..', 'public', 'admin.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-tlsadmin-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { certificateState, certFailureReason } = await import(LIB('tls.js'));
const { setTls, tlsView, wouldServe, pairing } = await import(LIB('tlsswitch.js'));
const { qrSvg } = await import(LIB('qr.js'));

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

console.log('https from the admin screen');

/* ------------------------------------------------------------------ fixtures */

const NAME = 'test-mac.tailscale-test.ts.net';
const CONFIG_PATH = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json');
const tlsCache = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'tls');

function selfSigned(days) {
  const certFile = path.join(tmp, `c${days}.pem`);
  const keyFile = path.join(tmp, `k${days}.pem`);
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', String(days), '-subj', '/CN=test'],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 }
  );
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

/**
 * One that is genuinely past its date. `-days` will not go backwards, so the dates are
 * given outright; `-not_before`/`-not_after` arrived in OpenSSL 3.5 and are absent from
 * LibreSSL, so this returns null there and the check that needs it skips out loud.
 */
const stamp = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z');
function selfSignedExpired(agoDays) {
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
        '-subj', '/CN=test',
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 }
    );
  } catch {
    return null;
  }
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

/** A healthy certificate, and one inside the renewal loop's alarm window. */
let material;
let expiring;
try {
  material = selfSigned(40);
  expiring = selfSigned(5);
} catch (err) {
  // Loudly, rather than a green suite that checked nothing.
  console.log(`  SKIP everything — no usable \`openssl\` to make a test certificate (${err.message.split('\n')[0]})`);
  done(0);
}

/** Put the pair `certificateState` looks for on disk, or take it away. */
function plant({ have = true, pair = material } = {}) {
  fs.mkdirSync(tlsCache, { recursive: true });
  for (const [file, bytes] of [
    [`${NAME}.crt`, pair.cert],
    [`${NAME}.key`, pair.key],
  ]) {
    const at = path.join(tlsCache, file);
    if (have) fs.writeFileSync(at, bytes);
    else fs.rmSync(at, { force: true });
  }
}

/** A config as `loadConfig` would have left it, with the name pinned so no `tailscale` is asked. */
const config = ({ enabled = false, baseUrl = 'http://100.96.105.106:4318' } = {}) => ({
  port: 4318,
  host: '100.96.105.106',
  token: 'tok-en',
  baseUrl,
  tls: { enabled, name: NAME },
});

/** What `tailscale cert` did, without a tailnet: it wrote the pair, or it refused. */
const obtainOk = async () => {
  plant({ have: true });
  return { ok: true, changed: true, detail: '40 days left', reason: null, name: NAME };
};
const obtainRefused = async () => ({
  ok: false,
  changed: false,
  detail: 'your Tailscale account does not support getting TLS certs',
  reason: 'tailnet-https-off',
  name: NAME,
});

/** `reconcileBaseUrl` narrates on stderr; a passing test should not. */
async function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = real;
  }
}

const stored = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

/* ------------------------------------------------- the card, as the page draws it */

/**
 * Run the real `public/admin.js` against a hand-made `/api/tls` body and hand back the
 * HTML it put in the HTTPS card.
 *
 * The real file rather than a copy of `certPhrase`, for the reason test/dictate.mjs and
 * test/spacebar.mjs do the same: a rewrite of the wording in a test would go on passing
 * for as long as the phone shipped something else. A vm rather than a headless browser
 * because there is nothing here a browser would add — no layout, no events, one string —
 * and a Chrome per suite collides with every other session's on the CDP port.
 *
 * Everything the page touches at load is stubbed to record instead of render, and the
 * other three fetches it makes (`/auth/whoami`, `/api/admin`, `/api/work`) are answered
 * with a shape that makes it draw nothing: this asks about one card.
 */
const ADMIN_JS = fs.readFileSync(PAGE, 'utf8');

async function drawTlsCard(over = {}) {
  const view = {
    enabled: true,
    name: NAME,
    have: true,
    daysLeft: 61,
    expired: false,
    alarming: false,
    renewing: false,
    wouldServe: `https://${NAME}:4318`,
    ifFlipped: 'http://100.96.105.106:4318',
    originWillChange: true,
    restartNeeded: false,
    restartCommand: 'launchctl kickstart -k gui/501/m4m.beadcause',
    tailnetHttpsUrl: 'https://login.tailscale.com/admin/dns',
    serving: { tls: true, name: NAME, daysLeft: 61, checkedAt: null },
    ...over,
  };

  const node = (id) => ({
    id,
    hidden: false,
    innerHTML: '',
    textContent: '',
    href: '',
    disabled: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    // Null from every selector, which is what forces a full repaint rather than one of
    // the partial paths — the settled card ends up in `innerHTML` as a string.
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    addEventListener() {},
    append() {},
  });
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, node(id));
    return nodes.get(id);
  };

  const fetchStub = async (url) => {
    const body =
      url === '/api/tls'
        ? view
        : url === '/auth/whoami'
          ? { signedIn: false }
          : // /api/admin and /api/work: enough shape to render nothing and throw nothing.
            { scopes: [], observing: false };
    return { ok: true, status: 200, json: async () => body };
  };

  const window = { beadcause: {} };
  const ctx = vm.createContext({
    window,
    document: { getElementById: byId, createElement: () => node('made') },
    localStorage: { getItem: () => 'tok-en', setItem() {} },
    location: { search: '', pathname: '/admin', hash: '', assign() {} },
    history: { replaceState() {} },
    navigator: { userAgent: 'node' },
    URLSearchParams,
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {} },
  });
  vm.runInContext(ADMIN_JS, ctx);
  // The page's loads are not awaited by it; drain the microtask queue rather than
  // sleeping, so this is bounded and not a timer racing a loaded laptop.
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  return byId('tls').innerHTML;
}

/* ------------------------------------------------------- what the screen reads */

await check('with no certificate on disk, HTTPS wanted is not HTTPS had', () => {
  plant({ have: false });
  const state = certificateState(config({ enabled: true }));
  assert.equal(state.enabled, true, 'the setting is what it says');
  assert.equal(state.have, false, 'and it is not evidence of a certificate');
  assert.equal(state.daysLeft, null);
});

await check('with one on disk it reports the name and the days left', () => {
  plant({ have: true });
  const state = certificateState(config({ enabled: true }));
  assert.equal(state.have, true);
  assert.equal(state.name, NAME);
  assert.ok(state.daysLeft > 38 && state.daysLeft <= 40, `expected ~40 days, got ${state.daysLeft}`);
  assert.equal(state.alarming, false, '40 days is not an alarm');
});

await check('a certificate this close to expiry is marked, not merely printed', () => {
  // The renewal loop re-fetches below 31 days and alarms below 14. The screen reads the
  // same two numbers, so it cannot call "fine" something the phone is being pushed about.
  plant({ have: true, pair: expiring });
  const state = certificateState(config({ enabled: true }));
  assert.equal(state.have, true, 'five days left is still a certificate');
  assert.equal(state.renewing, true);
  assert.equal(state.alarming, true);
  plant({ have: true });
  assert.equal(certificateState(config({ enabled: true })).alarming, false, 'and forty days is not');
});

// bc-jv86: `have` is "there is a pair on disk for this name", not "the calendar still
// likes it", because it is what decides both what goes on the socket and what URL a
// phone is handed — and those two must not disagree. Past the date the daemon keeps
// serving it on purpose, so the screen has to say *expired* rather than either "no
// certificate" (there is one, and it is what every browser is refusing) or "-3 days
// left" (a number nobody reads as an outage).
const dead = selfSignedExpired(3);
if (!dead) {
  skip('an expired certificate is still a certificate, and is marked as expired — this openssl cannot mint one');
} else {
  await check('an expired certificate is still a certificate, and is marked as expired', () => {
    plant({ have: true, pair: dead });
    const state = certificateState(config({ enabled: true }));
    assert.equal(state.have, true, 'it is on disk and it is on the socket — "no certificate yet" would be a lie');
    assert.equal(state.expired, true, 'and this is the field that says so');
    assert.ok(state.daysLeft <= 0, `got ${state.daysLeft}`);
    assert.equal(state.alarming, true);

    const view = tlsView(config({ enabled: true }));
    assert.equal(view.wouldServe, `https://${NAME}:4318`, 'a restart serves the same expired certificate — not plain http');
    assert.equal(view.expired, true, 'and the card is told, so it can say so instead of counting negative days');
  });
}

await check('the switch says what it will cost before it is pressed', () => {
  plant({ have: true });
  const view = tlsView(config({ enabled: false }));
  assert.equal(view.wouldServe, 'http://100.96.105.106:4318');
  assert.equal(view.ifFlipped, `https://${NAME}:4318`);
  assert.equal(view.originWillChange, true, 'this is the sign-out warning — it must be true here');
});

await check('and says nothing of the sort about a baseUrl you set yourself', () => {
  plant({ have: true });
  const view = tlsView(config({ enabled: false, baseUrl: 'https://beads.example.com' }));
  assert.equal(view.wouldServe, 'https://beads.example.com');
  assert.equal(view.ifFlipped, 'https://beads.example.com');
  assert.equal(view.originWillChange, false, 'a reverse proxy does not move because the tailnet address did');
});

await check('"restart to serve it" is not asserted when nothing could say', () => {
  plant({ have: true });
  assert.equal(tlsView(config({ enabled: true }), { live: null }).restartNeeded, null);
});

await check('and is asserted when the socket disagrees with the setting', () => {
  plant({ have: true });
  const on = config({ enabled: true });
  assert.equal(tlsView(on, { live: { tls: false, name: null } }).restartNeeded, true);
  assert.equal(tlsView(on, { live: { tls: true, name: NAME } }).restartNeeded, false);
  // A machine renamed under a running listener: the certificate on the socket is for a
  // name nothing hands out any more.
  assert.equal(tlsView(on, { live: { tls: true, name: 'old-name.ts.net' } }).restartNeeded, true);
  // And the other direction — turned off, still serving.
  assert.equal(tlsView(config({ enabled: false }), { live: { tls: true, name: NAME } }).restartNeeded, true);
});

/* ------------------------------------------------- when the loop last looked */

await check('the socket says when the renewal loop last looked, and the view carries it', () => {
  plant({ have: true });
  const at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const view = tlsView(config({ enabled: true }), { live: { tls: true, name: NAME, daysLeft: 61, checkedAt: at } });
  assert.equal(view.serving.checkedAt, at, '/api/tls drops it and the card can never say it');
});

await check('and says null rather than a guess when whatever answered did not carry it', () => {
  plant({ have: true });
  // A router that predates the field. It cannot hot-swap itself, so this is the ordinary
  // answer between a deploy and a `launchctl kickstart` — not a fault, and not something
  // to fill in from the fact that there was *something* to draw.
  const old = tlsView(config({ enabled: true }), { live: { tls: true, name: NAME, daysLeft: 61 } });
  assert.equal(old.serving.checkedAt, null);
  // Nothing could say at all: no socket fact of any kind, including this one.
  assert.equal(tlsView(config({ enabled: true }), { live: null }).serving, null);
});

/* The card itself, drawn by the real public/admin.js — because the field reaching
   `/api/tls` and the sentence on the screen are two different claims, and the bead this
   comes from was filed precisely because the first was true and the second was not. */

await check('the HTTPS card says it, in the same words the terminal uses', async () => {
  const at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const html = await drawTlsCard({ serving: { tls: true, name: NAME, daysLeft: 61, checkedAt: at } });
  assert.match(html, /checked 3h ago/, `the card never said it — got:\n${html.slice(0, 400)}`);
  assert.match(html, /61 days left, checked 3h ago\./);
});

await check('an expired certificate says it too — a dead loop is why it got there', async () => {
  const at = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const html = await drawTlsCard({
    have: true,
    expired: true,
    daysLeft: -3,
    serving: { tls: true, name: NAME, daysLeft: -3, checkedAt: at },
  });
  assert.match(html, /EXPIRED 3 days ago, checked 40m ago\./);
});

await check('and the card says nothing at all when nothing reported it', async () => {
  const older = await drawTlsCard({ serving: { tls: true, name: NAME, daysLeft: 61, checkedAt: null } });
  assert.ok(!/checked/.test(older), `a router too old to carry it must not be guessed at — got:\n${older.slice(0, 400)}`);
  const silent = await drawTlsCard({ serving: null });
  assert.ok(!/checked/.test(silent));
  // The sentence is otherwise untouched, so this is silence and not a card that failed
  // to draw.
  assert.match(silent, /61 days left\./);
});

/* -------------------------------------------------------------- pressing it */

await check('turning it on writes the setting to config.json — no hand-edit', async () => {
  plant({ have: false });
  const cfg = config({ enabled: false });
  await quietly(() => setTls(cfg, { enabled: true, obtain: obtainOk, log: () => {}, warn: () => {} }));
  assert.equal(stored().tls.enabled, true, 'it is on disk, not only in this process');
  assert.equal(cfg.tls.enabled, true);
});

await check('and moves the URL a phone is handed onto the name', async () => {
  plant({ have: false });
  const cfg = config({ enabled: false });
  const { did, view } = await quietly(() =>
    setTls(cfg, { enabled: true, obtain: obtainOk, log: () => {}, warn: () => {} })
  );
  assert.equal(did.from, 'http://100.96.105.106:4318');
  assert.equal(did.to, `https://${NAME}:4318`);
  assert.equal(did.originMoved, true);
  assert.equal(cfg.baseUrl, `https://${NAME}:4318`, 'and it is persisted, so `npm run qr` prints the same one');
  assert.equal(stored().baseUrl, `https://${NAME}:4318`);
  assert.equal(view.have, true);
});

await check('the pairing link is on the NEW origin, and carries the token', async () => {
  plant({ have: false });
  const cfg = config({ enabled: false });
  const { view } = await quietly(() => setTls(cfg, { enabled: true, obtain: obtainOk, log: () => {}, warn: () => {} }));
  assert.equal(view.pairing.url, `https://${NAME}:4318/?t=tok-en`);
  assert.equal(view.pairing.origin, `https://${NAME}:4318`);
  assert.match(view.pairing.qr, /^<svg /, 'and a code for the devices that cannot be handed a link');
  assert.match(view.pairing.qr, /viewBox="0 0 \d+ \d+"/);
});

await check('a refusal from Tailscale leaves the intent recorded, and says which refusal it was', async () => {
  plant({ have: false });
  const cfg = config({ enabled: false });
  const { did, view } = await quietly(() =>
    setTls(cfg, { enabled: true, obtain: obtainRefused, log: () => {}, warn: () => {} })
  );
  assert.equal(did.asked.ok, false);
  assert.equal(did.asked.reason, 'tailnet-https-off', 'the one failure with a two-tap fix on a web page');
  assert.equal(stored().tls.enabled, true, 'so the next restart after that setting is turned on gets a certificate');
  assert.equal(view.have, false);
  assert.equal(view.wouldServe, 'http://100.96.105.106:4318', 'and no https URL is handed out without a certificate');
  assert.equal(view.tailnetHttpsUrl, 'https://login.tailscale.com/admin/dns');
});

await check('turning it off asks Tailscale for nothing and keeps the certificate', async () => {
  plant({ have: true });
  const cfg = config({ enabled: true, baseUrl: `https://${NAME}:4318` });
  let asked = 0;
  const { did, view } = await quietly(() =>
    setTls(cfg, {
      enabled: false,
      obtain: async () => {
        asked += 1;
        return { ok: true, changed: false, detail: '', reason: null, name: NAME };
      },
      log: () => {},
      warn: () => {},
    })
  );
  assert.equal(asked, 0, 'nothing to fetch when nothing is being served');
  assert.equal(did.asked, null);
  assert.equal(stored().tls.enabled, false);
  assert.equal(did.originMoved, true);
  assert.equal(cfg.baseUrl, 'http://100.96.105.106:4318');
  assert.ok(fs.existsSync(path.join(tlsCache, `${NAME}.crt`)), 'the certificate stays — coming back must be instant');
  assert.equal(view.have, true, 'and is still reported, because it is still there');
});

await check('pressing it again while it is already on is the retry', async () => {
  plant({ have: false });
  const cfg = config({ enabled: true });
  let asked = 0;
  const { did } = await quietly(() =>
    setTls(cfg, {
      enabled: true,
      obtain: async () => {
        asked += 1;
        return obtainOk();
      },
      log: () => {},
      warn: () => {},
    })
  );
  assert.equal(asked, 1, 'the whole point after turning HTTPS Certificates on for the tailnet');
  assert.equal(did.was, true, 'and the screen can tell it was a retry rather than a first press');
  assert.equal(did.now, true);
});

/* ------------------------------------------------------- reading the failure */

await check('the sentence that means "the tailnet setting is off" is recognised', () => {
  assert.equal(
    certFailureReason('2026/08/10 500 Internal Server Error: your Tailscale account does not support getting TLS certs'),
    'tailnet-https-off'
  );
  assert.equal(certFailureReason('HTTPS Certificates are disabled for this tailnet'), 'tailnet-https-off');
});

await check('and nothing else is, so nobody is sent to that page for a different problem', () => {
  assert.equal(certFailureReason('acme: rate limit exceeded, try again in 3h'), 'unknown');
  assert.equal(certFailureReason('500 Internal Server Error: invalid domain "nope.ts.net"'), 'unknown');
  assert.equal(certFailureReason('no tailscale CLI found — cannot fetch a certificate'), 'no-tailscale');
  assert.equal(certFailureReason('no MagicDNS name — `tailscale status` did not answer'), 'no-name');
});

/* --------------------------------------------------------------------- the QR */

await check('the code is a different code for a different URL', () => {
  const a = qrSvg('https://a.example.ts.net:4318/?t=one');
  const b = qrSvg('https://b.example.ts.net:4318/?t=two');
  assert.notEqual(a, b);
  assert.match(a, /fill="#ffffff"/, 'dark on light, whatever the page theme is');
  assert.doesNotMatch(a, /t=one/, 'and the token is not left in an aria-label for a screen reader to keep');
});

await check('an empty URL is refused rather than encoded', () => {
  assert.throws(() => qrSvg(''), /nothing to encode/);
});

await check('and the modules are where the renderer `npm run qr` uses puts them', async () => {
  // The one property of this drawing that would fail silently. Both come from the same
  // encoder, so this is not a test of the encoding — it is a test of *orientation*: x
  // and y transposed is a QR mirrored along its diagonal, which is a code that will not
  // scan, and nothing on a screen looks any different. `npm run qr` has printed the
  // pairing code from this matrix since the first week, so it is the reference.
  const { default: QRCode } = await import('qrcode-terminal/vendor/QRCode/index.js');
  const url = `https://${NAME}:4318/?t=tok-en`;
  // Error correction M, matching lib/qr.js's default, so the two matrices are of the
  // same code rather than merely of the same string.
  const code = new QRCode(-1, 0);
  code.addData(url);
  code.make();
  const n = code.getModuleCount();

  const theirs = Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => (code.modules[row][col] ? '#' : '.')).join('')
  );
  const mine = Array.from({ length: n }, () => Array(n).fill('.'));
  for (const m of qrSvg(url, { quiet: 0 }).matchAll(/M(\d+) (\d+)h1v1h-1z/g)) mine[Number(m[2])][Number(m[1])] = '#';

  const transposed = theirs.map((_, col) => theirs.map((r) => r[col]).join(''));
  assert.notDeepEqual(theirs, transposed, 'a symmetric code would make this check prove nothing');
  assert.deepEqual(
    mine.map((r) => r.join('')),
    theirs
  );
});

await check('pairing() and wouldServe() agree about the origin', () => {
  plant({ have: true });
  const cfg = config({ enabled: true, baseUrl: `https://${NAME}:4318` });
  const url = wouldServe(cfg, certificateState(cfg));
  assert.equal(pairing(cfg, url).origin, `https://${NAME}:4318`);
});

done();
