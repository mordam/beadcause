#!/usr/bin/env node
import { loadConfig, reconcileBaseUrl, CONFIG_PATH, OBSERVING } from '../lib/config.js';
import { createApp, startPoller, listen } from '../lib/server.js';
import { advocatedWorkspaces, workerLimit } from '../lib/advocate.js';
import { buildStamp } from '../lib/build.js';
import { hotSwapProblem, problemBanner } from '../lib/service.js';
import { attachTerminalSocket } from '../lib/termsocket.js';
import { closeServer, startRenewal } from '../lib/tls.js';
import { pushCertificate } from '../lib/notify.js';
import { flush } from '../lib/commonrepo.js';
import { restoreTerminals, shutdownTerminals, startTerminalReaper, terminalsEnabled } from '../lib/terminal.js';

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
      // `reaping` is reported because the invariant it stands for — exactly one
      // process sweeping terminals — has a 30-minute idle window before it can be
      // observed going wrong, which is far too long for any test to wait out.
      return reply({ role, build, startedAt, pid: process.pid, inflight: inflight - 1, reaping: reaper !== null });
    case '/internal/activate':
      if (!poller) poller = startPoller(cfg, app);
      // Restored again, having already been restored at startup. A standby can sit
      // idle for a long time before it is promoted, and everything the outgoing
      // backend did to a terminal in that window happened after this process read
      // the directory — so promoting without a re-read serves a list from before
      // the swap. Idempotent: restoreTerminals() skips any id already in memory.
      //
      // What that skip also means, and the reason this is not a full refresh: a
      // terminal this process restored as resumable and which has since *ended*
      // keeps its stale in-memory state, because the id is already known. Fixing
      // that needs reconciliation rather than a second restore.
      if (terminalsEnabled(cfg)) restoreTerminals(cfg);
      if (!reaper && terminalsEnabled(cfg)) reaper = startTerminalReaper(cfg);
      if (role !== 'active') console.log('[beadcause] promoted to active — polling');
      role = 'active';
      return reply({ ok: true, role, reaping: reaper !== null });
    case '/internal/standby':
      if (poller) clearInterval(poller);
      poller = null;
      if (reaper) clearInterval(reaper);
      reaper = null;
      if (role !== 'standby') console.log('[beadcause] stood down — poller stopped');
      role = 'standby';
      return reply({ ok: true, role, reaping: reaper !== null });
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

// `listen()` is the one place a certificate can *appear* — it is what calls
// `tailscale cert` — so the URL is asked again now that it has. Only when we own the
// real port: a backend behind the router binds loopback, never fetches anything, and
// must not be the process that decides what the phone is told. Persisted, because the
// next `npm run qr` is a different process and reads this off disk.
if (!internalPort) reconcileBaseUrl(cfg, { persist: true });

// The in-app terminal rides the same servers, on the HTTP upgrade path. Awaited
// because `ws` is imported dynamically — an install that hasn't run `npm install`
// since this landed loses the terminal and keeps everything else.
await attachTerminalSocket(cfg, servers);
/**
 * Keep the tailnet certificate alive under `npm run start:bare`.
 *
 * A no-op in the installed configuration and by design: behind the router this process
 * binds loopback only, so nothing here terminates TLS and `startRenewal` returns null.
 * The router runs its own — it is the one holding the certificate on the port.
 */
const certRenewal = startRenewal(cfg, servers, { notify: (state) => pushCertificate(cfg, state) });
// Terminals that were running when the last daemon went away. Nothing is spawned
// here — they come back as offers to resume, and the first attach is what starts a
// process. Before the reaper, so a restore is subject to the same idle clock.
if (terminalsEnabled(cfg)) restoreTerminals(cfg);
/**
 * The reaper is the active backend's alone — a standby must never run it.
 *
 * It is not a timer that merely thinks: `reapTerminals` calls `closeTerminal` on any
 * terminal past the idle window with no clients attached, and `closeTerminal` on a
 * `resumable` one writes `status: 'exited'` to the record on disk. A standby has
 * restored those same records and sees zero clients on every one of them forever,
 * because the router sends it no traffic — so left running, its reaper would mark
 * the *active* process's live terminals as ended, in a file they both write.
 *
 * Started on promotion and stopped on stand-down, so exactly one process is ever
 * sweeping, the same way exactly one is ever polling.
 */
let reaper = !startStandby && terminalsEnabled(cfg) ? startTerminalReaper(cfg) : null;

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
// First thing in the log, and unmissable, because the mistake it guards against is
// believing you are in it when you are not — and the evidence of *that* arrives
// thirty seconds later as two Claude windows you did not ask for.
if (OBSERVING) {
  console.log('[beadcause] ─────────────────────────────────────────────────────');
  console.log('[beadcause] OBSERVING — this instance watches and never acts.');
  console.log('[beadcause]   no sessions · no proposals · no worktree sweeps');
  console.log('[beadcause]   no session logs · no reply agents · no ntfy push');
  console.log('[beadcause]   the terminal, the chat session and answering still work');
  console.log('[beadcause] ─────────────────────────────────────────────────────');
}
// Say it at startup, in the log launchd keeps: an advocate opens Claude sessions
// on this Mac without being asked, so which repos have one — and how many windows
// each may open — is the first thing anyone reading this log wants to know.
const advocated = advocatedWorkspaces(cfg).map((w) => `${w.name}\u00d7${workerLimit(cfg, w.name).limit}`);
console.log(
  `[beadcause] advocates   ${
    advocated.length
      ? `${advocated.join(', ')} ${OBSERVING ? '(observing — they survey, they open nothing)' : `(max ${cfg.advocates?.globalMaxWorkers ?? 10} sessions in total)`}`
      : '(none — advocates.workspaces is empty)'
  }`
);
console.log(`[beadcause] ntfy topic  ${cfg.ntfy.enabled ? cfg.ntfy.topic : '(disabled)'}`);
console.log(`[beadcause] phone URL   ${cfg.baseUrl}/?t=${cfg.token}`);
console.log(`[beadcause] build       ${build} (${role}${internalPort ? `, internal :${internalPort}` : ', standalone'})`);

/**
 * Say it, at startup, when launchd is running this file instead of the router.
 *
 * Only when launchd started us — `process.ppid === 1`, which is how a LaunchAgent's
 * child arrives and how nothing a person types does. `npm run start:bare` is a
 * deliberate choice and gets no lecture; a router-spawned backend has `--port` and is
 * excluded before we look at anything.
 *
 * Last in the startup block on purpose. This is the line that was missing for three
 * days: every other line above was correct, the README described a hot-swap, and the
 * process printing them was the plain server launchd had been restarting all along.
 */
if (!internalPort && process.ppid === 1) {
  const problem = hotSwapProblem({ loadedProgram: process.argv[1] });
  if (problem) for (const line of problemBanner(problem)) console.error(line);
}

const shutdown = () => {
  // Guarded, not bare: a standby has no poller to clear.
  if (poller) clearInterval(poller);
  if (reaper) clearInterval(reaper);
  if (certRenewal) clearInterval(certRenewal);
  // A pty that outlived the daemon has nothing left to relay it anywhere, and it
  // holds a Claude session open against the tracker. Outliving a *socket* is the
  // point; outliving the process that owns the registry is just a leak.
  shutdownTerminals();
  // `closeServer` rather than `close()`: a TLS listener is a net.Server in front of an
  // https.Server, and it is the front that holds the port.
  servers.forEach(closeServer);
  // State written in the last couple of seconds has a snapshot scheduled and not
  // yet taken, and the most interesting write in a log is usually the last one
  // before the process went away. Bounded: a git that hangs must not be able to
  // stop the daemon exiting, so the snapshot gets two seconds and no more.
  Promise.race([flush(), new Promise((r) => setTimeout(r, 2000))]).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
