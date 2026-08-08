#!/usr/bin/env node
import { loadConfig, CONFIG_PATH } from '../lib/config.js';
import { createApp, startPoller, listen } from '../lib/server.js';
import { advocatedWorkspaces, workerLimit } from '../lib/advocate.js';
import { buildStamp } from '../lib/build.js';

const cfg = loadConfig();

/**
 * This process may be the one the phone talks to, or the understudy.
 *
 * `--port` puts it on an internal loopback port behind bin/router.js, and
 * `--standby` starts it **without its poller**. That second flag is the whole
 * safety property: two live pollers would both see a new question and both push
 * it, so exactly one process is ever active, and the router promotes the new one
 * only after the old one has stood down. See bin/router.js for the sequence.
 *
 * With neither flag this is the plain unsupervised server it always was, on the real
 * port, polling — which is what `npm run start:bare` gives you.
 */
const flagValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const internalPort = Number(flagValue('--port') || 0) || null;
const startStandby = process.argv.includes('--standby');

const setupUrl = `${cfg.baseUrl}/?t=${cfg.token}`;

if (process.argv.includes('--url')) {
  console.log(setupUrl);
  process.exit(0);
}

/**
 * Both of the URLs that have to get from this Mac onto a phone, as codes you can
 * point a camera at. Typing a tailnet IP, a port and a path on a phone keyboard is
 * the worst part of every reinstall, and there is a fresh APK after every build.
 *
 * The APK code only appears when there is an APK to install — offering a QR for a
 * 404 wastes the one scan somebody makes while standing there holding the phone.
 */
if (process.argv.includes('--qr')) {
  const qr = (await import('qrcode-terminal')).default;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const show = (label, url) =>
    new Promise((resolve) => {
      console.log(`\n${label}\n`);
      qr.generate(url, { small: true }, (art) => {
        console.log(art);
        console.log(`  ${url}\n`);
        resolve();
      });
    });

  await show('Pair the app — scan, then Share > Add to Home Screen:', setupUrl);

  const apk = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'beadcause.apk');
  try {
    const stat = fs.statSync(apk);
    const mb = (stat.size / 1024 / 1024).toFixed(0);
    // Local time, not toISOString(): a build made at 09:04 reported as 12:04 reads
    // like yesterday's APK, which is exactly the doubt this line exists to remove.
    const p2 = (n) => String(n).padStart(2, '0');
    const m = stat.mtime;
    const built = `${m.getFullYear()}-${p2(m.getMonth() + 1)}-${p2(m.getDate())} ${p2(m.getHours())}:${p2(m.getMinutes())}`;
    await show(`Install the Android app — ${mb}MB, built ${built}:`, `${cfg.baseUrl}/beadcause.apk`);
  } catch {
    console.log('  (no APK published yet — npm run android)\n');
  }
  process.exit(0);
}

if (!cfg.workspaces.length) {
  console.error('[beadcause] no beads workspaces found under ~/beads — nothing to serve.');
  process.exit(1);
}

const app = createApp(cfg);

const startedAt = new Date().toISOString();
const build = buildStamp();
let role = startStandby ? 'standby' : 'active';
let poller = startStandby ? null : startPoller(cfg, app);
// What draining waits on. A long poll parks for up to 55 seconds, and killing the
// process out from under one is the difference between a seamless swap and the
// phone deciding it is offline.
let inflight = 0;

/**
 * The control plane, wrapped around the app rather than added to lib/server.js.
 *
 * Keeping it here means the swap machinery touches no file another session is
 * likely to be editing, and these calls can never collide with a real route: the
 * paths are under `/internal/`, refused off loopback, and still need the token.
 */
const control = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const addr = req.socket.remoteAddress;
  const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const supplied = req.headers['x-beadcause-token'] || url.searchParams.get('t');
  if (!local || supplied !== cfg.token) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end('{"error":"internal"}');
  }

  // Any authenticated control call is proof a router is still watching. See the
  // orphan guard below for why that matters.
  lastContact = Date.now();

  const reply = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  switch (url.pathname) {
    case '/internal/state':
      // `inflight - 1` excludes this very request, which is counted like any other.
      return reply({ role, build, startedAt, pid: process.pid, inflight: inflight - 1 });
    case '/internal/activate':
      if (!poller) poller = startPoller(cfg, app);
      if (role !== 'active') console.log('[beadcause] promoted to active — polling');
      role = 'active';
      return reply({ ok: true, role });
    case '/internal/standby':
      if (poller) clearInterval(poller);
      poller = null;
      if (role !== 'standby') console.log('[beadcause] stood down — poller stopped');
      role = 'standby';
      return reply({ ok: true, role });
    default:
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"no such control"}');
  }
};

const handler = (req, res) => {
  inflight++;
  res.on('close', () => inflight--);
  if (req.url.startsWith('/internal/')) return control(req, res);
  return app.handler(req, res);
};

const servers = listen(
  // Behind the router this binds loopback only. The tailnet reaches the router; an
  // internal backend that also bound the tailnet IP would be answerable directly,
  // skipping every cutover guarantee the router exists to provide.
  internalPort ? { ...cfg, port: internalPort, host: '127.0.0.1' } : cfg,
  handler
);

/**
 * The orphan guard: an active backend nobody is steering shuts itself down.
 *
 * If the router is SIGKILLed — crash, `kill -9`, a botched launchctl bootout — its
 * children are not killed with it. A stranded backend still holds a poller, and the
 * replacement router starts a fresh one, which is exactly the double-notify this
 * design exists to prevent. The router touches `/internal/state` every few seconds,
 * so silence for a minute means there is no longer anyone to serve.
 *
 * Only armed behind a router: an unsupervised server has no control plane and must
 * stay up forever.
 */
const ORPHAN_MS = 60000;
let lastContact = Date.now();
if (internalPort) {
  setInterval(() => {
    if (Date.now() - lastContact < ORPHAN_MS) return;
    console.error(`[beadcause] no router contact in ${ORPHAN_MS / 1000}s — exiting rather than polling unsupervised`);
    process.exit(0);
  }, 5000).unref();
}

console.log(`[beadcause] config      ${CONFIG_PATH}`);
console.log(`[beadcause] workspaces  ${cfg.workspaces.map((w) => w.name).join(', ')}`);
// Say it at startup, in the log launchd keeps: an advocate opens Claude sessions
// on this Mac without being asked, so which repos have one — and how many windows
// each may open — is the first thing anyone reading this log wants to know.
const advocated = advocatedWorkspaces(cfg).map((w) => `${w.name}\u00d7${workerLimit(cfg, w.name).limit}`);
console.log(
  `[beadcause] advocates   ${
    advocated.length ? `${advocated.join(', ')} (max ${cfg.advocates?.globalMaxWorkers ?? 3} sessions in total)` : '(none — advocates.workspaces is empty)'
  }`
);
console.log(`[beadcause] ntfy topic  ${cfg.ntfy.enabled ? cfg.ntfy.topic : '(disabled)'}`);
console.log(`[beadcause] phone URL   ${cfg.baseUrl}/?t=${cfg.token}`);
console.log(`[beadcause] build       ${build} (${role}${internalPort ? `, internal :${internalPort}` : ', standalone'})`);

const shutdown = () => {
  if (poller) clearInterval(poller);
  servers.forEach((s) => s.close());
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
