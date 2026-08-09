#!/usr/bin/env node
import { loadConfig, CONFIG_PATH, OBSERVING } from '../lib/config.js';
import { createApp, startPoller, listen } from '../lib/server.js';
import { advocatedWorkspaces, workerLimit } from '../lib/advocate.js';
import { attachTerminalSocket } from '../lib/termsocket.js';
import { flush } from '../lib/commonrepo.js';
import { restoreTerminals, shutdownTerminals, startTerminalReaper, terminalsEnabled } from '../lib/terminal.js';

const cfg = loadConfig();
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
const servers = listen(cfg, app.handler);
const poller = startPoller(cfg, app);
// The in-app terminal rides the same servers, on the HTTP upgrade path. Awaited
// because `ws` is imported dynamically — an install that hasn't run `npm install`
// since this landed loses the terminal and keeps everything else.
await attachTerminalSocket(cfg, servers);
// Terminals that were running when the last daemon went away. Nothing is spawned
// here — they come back as offers to resume, and the first attach is what starts a
// process. Before the reaper, so a restore is subject to the same idle clock.
if (terminalsEnabled(cfg)) restoreTerminals(cfg);
const reaper = terminalsEnabled(cfg) ? startTerminalReaper(cfg) : null;

console.log(`[beadcause] config      ${CONFIG_PATH}`);
console.log(`[beadcause] workspaces  ${cfg.workspaces.map((w) => w.name).join(', ')}`);
// First thing in the log, and unmissable, because the mistake it guards against is
// believing you are in it when you are not — and the evidence of *that* arrives
// thirty seconds later as two Claude windows you did not ask for.
if (OBSERVING) {
  console.log('[beadcause] ─────────────────────────────────────────────────────');
  console.log('[beadcause] OBSERVING — this instance watches and never acts.');
  console.log('[beadcause]   no sessions · no proposals · no worktree sweeps');
  console.log('[beadcause]   no session logs · no reply agents · no ntfy push');
  console.log('[beadcause]   the terminal, the bead console and answering still work');
  console.log('[beadcause] ─────────────────────────────────────────────────────');
}
// Say it at startup, in the log launchd keeps: an advocate opens Claude sessions
// on this Mac without being asked, so which repos have one — and how many windows
// each may open — is the first thing anyone reading this log wants to know.
const advocated = advocatedWorkspaces(cfg).map((w) => `${w.name}\u00d7${workerLimit(cfg, w.name).limit}`);
console.log(
  `[beadcause] advocates   ${
    advocated.length
      ? `${advocated.join(', ')} ${OBSERVING ? '(observing — they survey, they open nothing)' : `(max ${cfg.advocates?.globalMaxWorkers ?? 3} sessions in total)`}`
      : '(none — advocates.workspaces is empty)'
  }`
);
console.log(`[beadcause] ntfy topic  ${cfg.ntfy.enabled ? cfg.ntfy.topic : '(disabled)'}`);
console.log(`[beadcause] phone URL   ${cfg.baseUrl}/?t=${cfg.token}`);

const shutdown = () => {
  clearInterval(poller);
  if (reaper) clearInterval(reaper);
  // A pty that outlived the daemon has nothing left to relay it anywhere, and it
  // holds a Claude session open against the tracker. Outliving a *socket* is the
  // point; outliving the process that owns the registry is just a leak.
  shutdownTerminals();
  servers.forEach((s) => s.close());
  // State written in the last couple of seconds has a snapshot scheduled and not
  // yet taken, and the most interesting write in a log is usually the last one
  // before the process went away. Bounded: a git that hangs must not be able to
  // stop the daemon exiting, so the snapshot gets two seconds and no more.
  Promise.race([flush(), new Promise((r) => setTimeout(r, 2000))]).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
