#!/usr/bin/env node
import { loadConfig, CONFIG_PATH } from '../lib/config.js';
import { createApp, startPoller, listen } from '../lib/server.js';

const cfg = loadConfig();
const setupUrl = `${cfg.baseUrl}/?t=${cfg.token}`;

if (process.argv.includes('--url')) {
  console.log(setupUrl);
  process.exit(0);
}

// Pairing a device means getting a 60-character URL onto a phone. Scan it.
if (process.argv.includes('--qr')) {
  const qr = (await import('qrcode-terminal')).default;
  console.log('\nScan with the phone camera, then Share > Add to Home Screen:\n');
  qr.generate(setupUrl, { small: true }, (art) => console.log(art));
  console.log(`  ${setupUrl}\n`);
  process.exit(0);
}

if (!cfg.workspaces.length) {
  console.error('[beadcause] no beads workspaces found under ~/beads — nothing to serve.');
  process.exit(1);
}

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const poller = startPoller(cfg, app);

console.log(`[beadcause] config      ${CONFIG_PATH}`);
console.log(`[beadcause] workspaces  ${cfg.workspaces.map((w) => w.name).join(', ')}`);
console.log(`[beadcause] ntfy topic  ${cfg.ntfy.enabled ? cfg.ntfy.topic : '(disabled)'}`);
console.log(`[beadcause] phone URL   ${cfg.baseUrl}/?t=${cfg.token}`);

const shutdown = () => {
  clearInterval(poller);
  servers.forEach((s) => s.close());
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
