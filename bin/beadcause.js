#!/usr/bin/env node
import { loadConfig, CONFIG_PATH } from '../lib/config.js';
import { createApp, startPoller, listen } from '../lib/server.js';
import { buildStamp } from '../lib/build.js';

const cfg = loadConfig();

/**
 * Blue/green: this process may be the one the phone talks to, or the understudy.
 *
 * `--port` puts it on an internal port behind bin/router.js, and `--standby` starts
 * it **without its poller**. That second flag is the whole safety property: two live
 * pollers would both see a new question and both push it, so exactly one process is
 * ever active, and the router promotes the new one only after the old one has stood
 * down. See bin/router.js for the sequence.
 */
const flagValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const internalPort = Number(flagValue('--port') || process.env.BEADCAUSE_PORT || 0) || null;
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
// What draining waits on: a long poll parks for up to 55 seconds, and killing the
// process under it is the difference between a seamless swap and the phone deciding
// it is offline.
let inflight = 0;

/**
 * The control plane, wrapped around the app rather than added to lib/server.js.
 *
 * Keeping it here means the swap machinery touches no file another session is likely
 * to be editing, and the router's calls can never collide with a real route: these
 * paths are under `/internal/`, refused off loopback, and still require the token.
 */
const handler = (req, res) => {
  inflight++;
  res.on('close', () => inflight--);

  if (req.url.startsWith('/internal/')) {
    const url = new URL(req.url, 'http://localhost');
    const local = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1';
    const authed = (req.headers['x-beadcause-token'] || url.searchParams.get('t')) === cfg.token;
    if (!local || !authed) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end('{"error":"internal"}');
    }
    if (url.pathname === '/internal/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ role, build, startedAt, inflight: inflight - 1, pid: process.pid }));
    }
    if (url.pathname === '/internal/activate') {
      if (!poller) poller = startPoller(cfg, app);
      role = 'active';
      console.log('[beadcause] promoted to active');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true,"role":"active"}');
    }
    if (url.pathname === '/internal/standby') {
      if (poller) clearInterval(poller);
      poller = null;
      role = 'standby';
      console.log('[beadcause] stood down — poller stopped');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true,"role":"standby"}');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"error":"no such control"}');
  }

  return app.handler(req, res);
};

const servers = listen(
  // Behind the router this binds loopback only: the tailnet reaches the router, and
  // an internal backend that also bound the tailnet IP would be answerable directly,
  // skipping every cutover guarantee the router exists to provide.
  internalPort ? { ...cfg, port: internalPort, host: '127.0.0.1' } : cfg,
  handler
);

console.log(`[beadcause] config      ${CONFIG_PATH}`);
console.log(`[beadcause] workspaces  ${cfg.workspaces.map((w) => w.name).join(', ')}`);
console.log(`[beadcause] ntfy topic  ${cfg.ntfy.enabled ? cfg.ntfy.topic : '(disabled)'}`);
console.log(`[beadcause] phone URL   ${cfg.baseUrl}/?t=${cfg.token}`);
console.log(`[beadcause] build       ${build} (${role}${internalPort ? `, internal :${internalPort}` : ''})`);

const shutdown = () => {
  if (poller) clearInterval(poller);
  servers.forEach((s) => s.close());
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
