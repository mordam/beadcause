#!/usr/bin/env node
/**
 * The thing that owns port 4318, so the thing that answers it can be replaced.
 *
 * The failure: server code is read once, at startup. Edit `lib/` and the daemon
 * carries on running whatever it loaded hours ago, serving today's `public/` files
 * against yesterday's routes — which is how `/sessions` came to 404 on a page that
 * was, on disk, entirely correct. The fix everyone reaches for is "remember to
 * restart", and forgetting is the whole bug.
 *
 * So: a router on the real port supervises a backend on an internal loopback port,
 * watches the files that only take effect at startup, and when they move it brings a
 * second backend up beside the first, health-checks it, hands over, and drains the
 * old one. The phone sees one continuous server.
 *
 * Everything the phone asks for comes through here, and that is two paths and not one:
 * ordinary requests, and the HTTP upgrade the terminal rides. The second was missing
 * for a while and cost the terminal a 404 in the only configuration launchd runs — see
 * `onUpgrade`, and the README section it points at.
 *
 * Why a router at all, rather than two processes sharing the port: `reusePort` is
 * ENOTSUP on macOS under Node 22, so two processes cannot hold 4318 between them.
 * One has to own it, and it has to be the one that never needs replacing — which
 * means it must stay small and depend on almost nothing. It imports `lib/config.js`
 * and `lib/build.js`, both leaves, and nothing else from the app. A syntax error
 * anywhere in `lib/server.js` costs you a swap, not the port.
 *
 * The one thing it cannot do is replace itself: giving up the socket to exec a new
 * router is the outage this exists to avoid. A change to its own source is reported
 * loudly and waits for `launchctl kickstart -k gui/$(id -u)/m4m.beadcause`.
 *
 *   node bin/router.js            supervise (this is what launchd runs)
 *   node bin/router.js --swap     force a swap now, even if nothing changed
 *   node bin/router.js --status   what is running, and on what build
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, reconcileBaseUrl } from '../lib/config.js';
import { buildStamp, routerStamp } from '../lib/build.js';
import { hotSwapProblem } from '../lib/service.js';
import { certificate, closeServer, secureServer, startRenewal, MIN_VERSION } from '../lib/tls.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'bin', 'beadcause.js');

const cfg = loadConfig();

/** How often disk is compared against what the active backend is running. */
const WATCH_MS = 3000;
/**
 * Ticks a new stamp must survive before it is acted on. A downmerge or an
 * `npm install` writes many files over several seconds, and every intermediate
 * state is a stamp nobody should be swapped onto.
 */
const SETTLE_TICKS = 1;
/** Long enough for a child to import the app, read config and bind. */
const HEALTH_TIMEOUT_MS = 20000;
/** A parked long poll runs 55s. Anything still open past this is not coming back. */
const DRAIN_MS = 60000;
/** Between SIGTERM and SIGKILL for a drained backend. */
const KILL_GRACE_MS = 5000;
/** Keeps each backend's orphan guard fed, and notices a wedged one. */
const HEARTBEAT_MS = 10000;

const log = (msg) => console.log(`[router] ${msg}`);
const warn = (msg) => console.error(`[router] ${msg}`);

// ------------------------------------------------------------ talking to a backend

/** An unused loopback port, straight from the kernel. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Call a loopback JSON endpoint with a deadline. Rejects on anything but 200. */
function localJson(port, pathname, { method = 'GET', timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'x-beadcause-token': cfg.token } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`${pathname} → ${res.statusCode} ${body.slice(0, 120)}`));
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`${pathname} → unparseable: ${err.message}`));
          }
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`${pathname} timed out after ${timeout}ms`)));
    req.on('error', reject);
    req.end();
  });
}

// ------------------------------------------------------------------- the backends

/**
 * Every backend this router has spawned.
 *
 * `active` takes new requests. Anything in `retiring` is finishing the requests it
 * already had, and will be killed once it has none — or once DRAIN_MS says it never
 * will. Nothing else is ever routed to.
 */
let active = null;
const retiring = new Set();

let shuttingDown = false;
let swapping = false;
/**
 * A build that failed to come up. Never retried until the files move again — the
 * alternative is respawning a process with a syntax error every three seconds.
 */
let poisoned = null;
let candidate = null;
let candidateTicks = 0;
/** Backs off a backend that dies immediately, so a crash loop stays legible. */
let crashBackoffMs = 0;

/**
 * Start a backend on a fresh internal port, in standby, and wait for it to answer.
 *
 * Always standby, even the very first one: "healthy, then activate" is one code
 * path, and it is the only ordering in which a poller cannot start inside a process
 * that then fails to bind.
 */
async function spawnBackend() {
  const port = await freePort();
  const child = spawn(process.execPath, [BACKEND, '--port', String(port), '--standby'], {
    cwd: ROOT,
    // Inherited, so a backend's own logging lands in the same launchd log file as
    // the router's. Two log files for one service is a bad trade.
    stdio: 'inherit',
    env: process.env,
  });

  const be = {
    port,
    child,
    pid: child.pid,
    build: null,
    startedAt: Date.now(),
    role: 'starting',
    reaping: null,
    inflight: 0,
    // Client sockets that have been upgraded through this backend — terminals, in
    // practice. Counted in `inflight` like any request, but unlike a request they
    // never end on their own, so `retire` has to say something to them.
    upgrades: new Set(),
  };
  child.on('exit', (code, signal) => onBackendExit(be, code, signal));

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`backend on :${port} exited before it was healthy`);
    try {
      const state = await localJson(port, '/internal/state', { timeout: 2000 });
      be.build = state.build;
      be.role = state.role;
      be.reaping = state.reaping;
      return be;
    } catch (err) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`backend on :${port} never became healthy — ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** SIGTERM, then SIGKILL if it is still there. */
function stop(be) {
  retiring.delete(be);
  if (be.child.exitCode !== null || be.child.signalCode) return;
  be.child.kill('SIGTERM');
  setTimeout(() => {
    if (be.child.exitCode === null && !be.child.signalCode) {
      warn(`backend pid ${be.pid} ignored SIGTERM — killing`);
      be.child.kill('SIGKILL');
    }
  }, KILL_GRACE_MS).unref();
}

/**
 * Ask a superseded backend to let go of its terminal sockets.
 *
 * **What a swap does to an attached terminal, decided.** The pty is a child of the
 * backend, so it cannot outlive one — there is no version of this where the terminal
 * survives a swap, only versions where it ends well or badly. Left alone, an attached
 * socket keeps `inflight` above zero for the whole of DRAIN_MS: a phone spends a
 * minute typing into a process that is already condemned, then loses it mid-keystroke
 * with 1006, which is indistinguishable from a tunnel. So the outgoing backend is
 * asked to close them itself, with a real close frame carrying 1012 (Service
 * Restart); the phone reconnects within a second onto the *new* backend, where the
 * record has come back `resumable`, and `claude --resume` puts the conversation back.
 *
 * Only asked when this router has actually proxied an upgrade to it: on the swap that
 * lands this change the outgoing backend has no such control path, and a 404 warning
 * about a socket nobody had open would be noise. Failure is survivable either way —
 * the drain falls back to DRAIN_MS and then SIGTERM, exactly as it did before.
 */
function release(be) {
  if (!be.upgrades.size) return;
  const n = be.upgrades.size;
  localJson(be.port, '/internal/release', { method: 'POST' })
    .then((r) => log(`pid ${be.pid} released ${r?.closed ?? n} terminal socket(s) — the phone reconnects onto the new backend`))
    .catch((err) => warn(`pid ${be.pid} would not release its ${n} terminal socket(s) (${err.message}) — draining them out`));
}

/**
 * Let a superseded backend finish what it already had, then end it.
 *
 * It is in standby by this point, so it polls nothing and notifies nobody; all it
 * still owns is a handful of open sockets, one of which may be a phone parked on a
 * 55-second long poll. Killing it under that is the difference between a seamless
 * swap and the phone deciding it is offline.
 */
function retire(be) {
  be.role = 'draining';
  retiring.add(be);
  release(be);
  const started = Date.now();
  const timer = setInterval(() => {
    const drained = be.inflight === 0;
    const expired = Date.now() - started > DRAIN_MS;
    if (!drained && !expired) return;
    clearInterval(timer);
    const stubborn = expired && !drained ? ` — ${be.inflight} request(s) still open after ${DRAIN_MS / 1000}s` : '';
    log(`retired pid ${be.pid} (build ${be.build})${stubborn}`);
    stop(be);
  }, 500);
  timer.unref();
}

/**
 * A backend went away on its own: a crash, an OOM, or its own orphan guard.
 *
 * Only the active one is worth reacting to — a draining backend exiting is the
 * whole point of draining.
 */
function onBackendExit(be, code, signal) {
  retiring.delete(be);
  if (shuttingDown || be !== active) return;

  const lived = Date.now() - be.startedAt;
  warn(`active backend pid ${be.pid} exited (${signal || `code ${code}`}) after ${Math.round(lived / 1000)}s — replacing it`);
  active = null;
  // Anything that dies inside ten seconds is failing at startup, not at runtime.
  // Backing off keeps a crash loop readable instead of a wall of noise.
  crashBackoffMs = lived < 10000 ? Math.min((crashBackoffMs || 500) * 2, 30000) : 0;
  setTimeout(() => {
    // A build already declared poison is exactly the build to try again here: with
    // no backend at all nothing is being served, and a 502 that might recover beats
    // a 503 that certainly will not.
    poisoned = null;
    bringUp('replacing a backend that exited').catch((err) => warn(`replacement failed — ${err.message}`));
  }, crashBackoffMs).unref();
}

/** Spawn, health-check, hand over. The only place `active` is ever assigned. */
async function bringUp(reason) {
  if (swapping) throw new Error('a swap is already in flight');
  swapping = true;
  const attempted = buildStamp();
  try {
    const next = await spawnBackend();

    // Stand the old one down BEFORE promoting the new one. Two live pollers would
    // both see a new question and both push it, and a duplicate notification on a
    // phone is the one failure this design must never produce. The gap between the
    // two calls is a few milliseconds in which nothing polls, which costs nothing:
    // the next tick picks up whatever appeared.
    if (active) {
      try {
        const down = await localJson(active.port, '/internal/standby', { method: 'POST' });
        if (down && 'reaping' in down) active.reaping = down.reaping;
      } catch (err) {
        // Unreachable means it is not polling either, which is all we needed.
        warn(`old backend pid ${active.pid} would not stand down (${err.message}) — continuing`);
      }
    }

    // Take the role and the reaper flag from the promotion's own reply rather than
    // waiting up to WATCH_MS for the next poll to notice. `--status` and the swap
    // test both read this immediately after a swap, and a stale `reaping: false`
    // there reads as "nobody is sweeping terminals" when one just started.
    const promoted = await localJson(next.port, '/internal/activate', { method: 'POST' });
    next.role = promoted?.role ?? 'active';
    if (promoted && 'reaping' in promoted) next.reaping = promoted.reaping;

    const previous = active;
    active = next;
    poisoned = null;
    crashBackoffMs = 0;
    log(`serving build ${next.build} from pid ${next.pid} on :${next.port} — ${reason}`);
    if (previous) retire(previous);
    return next;
  } catch (err) {
    // Remember the build we tried, not the one on disk now: if the files moved
    // again while we were failing, that newer build deserves its own attempt.
    poisoned = attempted;
    warn(`could not bring up build ${attempted} — ${err.message}`);
    if (active) warn(`still serving build ${active.build} from pid ${active.pid}`);
    throw err;
  } finally {
    swapping = false;
  }
}

// ------------------------------------------------------------------ watching disk

/**
 * Compare disk against what is actually running, and swap when they part.
 *
 * The comparison is against the *backend's* stamp, taken inside the backend at its
 * own startup — not against one the router took when it spawned it. That is the
 * difference between "the files changed since I last looked" and "this process is
 * running something other than what is on disk", and only the second one is the bug.
 */
function watchDisk() {
  setInterval(() => {
    if (shuttingDown || swapping || !active) return;

    const disk = buildStamp();
    if (disk === active.build) {
      candidate = null;
      candidateTicks = 0;
      return;
    }
    if (disk === poisoned) return;

    if (disk !== candidate) {
      candidate = disk;
      candidateTicks = 0;
      return;
    }
    if (++candidateTicks < SETTLE_TICKS) return;

    candidate = null;
    candidateTicks = 0;
    bringUp(`disk moved ${active.build} → ${disk}`).catch(() => {});
  }, WATCH_MS).unref();
}

/**
 * The router's own source, watched separately and only ever reported.
 *
 * See the note at the top: replacing itself means giving up the port, which is the
 * outage this exists to avoid. Said once, not every three seconds.
 */
function watchSelf() {
  let told = false;
  setInterval(() => {
    if (told || routerStamp() === routerBuildAtStart) return;
    told = true;
    warn("the router's own source changed — it cannot replace itself while holding the port.");
    warn(`restart it: launchctl kickstart -k gui/${process.getuid()}/m4m.beadcause`);
  }, WATCH_MS).unref();
}

/** Keeps every backend's orphan guard fed, and notices one that has stopped answering. */
function heartbeat() {
  setInterval(() => {
    if (shuttingDown) return;
    for (const be of [active, ...retiring].filter(Boolean)) {
      localJson(be.port, '/internal/state', { timeout: 4000 })
        .then((state) => {
          be.role = state.role;
          be.build = state.build;
          be.reaping = state.reaping;
        })
        .catch((err) => {
          if (be === active) warn(`active backend pid ${be.pid} is not answering — ${err.message}`);
        });
    }
  }, HEARTBEAT_MS).unref();
}

// -------------------------------------------------------------------- the proxy

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardable(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

/**
 * The same headers, with the two hop-by-hop ones an upgrade cannot do without.
 *
 * `connection` and `upgrade` are hop-by-hop precisely because they describe *this*
 * hop, and a proxy that means to open the next hop as a tunnel has to state them
 * again rather than pass them through. Stripping them is what made the terminal 404:
 * `GET /ws/terminal` arrived at the backend as an ordinary request, missed the
 * `upgrade` listener entirely, and was answered by the app's own 404.
 *
 * `sec-websocket-*` is not hop-by-hop and was never dropped — including the
 * subprotocol, which is where the token travels. See lib/termsocket.js.
 */
function upgradeHeaders(req) {
  return { ...forwardable(req.headers), connection: 'Upgrade', upgrade: req.headers.upgrade };
}

/**
 * A fresh loopback socket per proxied request, deliberately.
 *
 * Pooling them would save a handshake that costs nothing over loopback, and buy a
 * race in exchange: Node closes an idle keep-alive connection after five seconds,
 * and a pooled socket picked at the same instant the backend is closing it comes
 * back as ECONNRESET — a 502 on the phone, arriving from a server that is perfectly
 * healthy. One phone's traffic is not worth defending that.
 */
const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });

function json(res, code, obj) {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const isLocal = (req) => {
  const a = req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

function describe(be) {
  if (!be) return null;
  return {
    pid: be.pid,
    port: be.port,
    build: be.build,
    role: be.role,
    // Whether this backend is sweeping terminals. Exactly one should be, ever.
    reaping: be.reaping,
    inflight: be.inflight,
    // Of which this many are upgraded sockets — terminals. Reported separately
    // because they are the part of `inflight` that will not fall on its own.
    upgrades: be.upgrades.size,
    upSeconds: Math.round((Date.now() - be.startedAt) / 1000),
  };
}

function snapshot() {
  const disk = buildStamp();
  return {
    router: {
      pid: process.pid,
      port: cfg.port,
      build: routerBuildAtStart,
      sourceChanged: routerStamp() !== routerBuildAtStart,
    },
    disk,
    stale: Boolean(active && active.build !== disk),
    swapping,
    poisoned,
    active: describe(active),
    retiring: [...retiring].map(describe),
  };
}

/**
 * The router's own control plane, on the real port but loopback-and-token only.
 *
 * Note what is NOT here: any way to reach a *backend's* `/internal/`. A backend
 * accepts control calls from loopback, and every proxied request reaches it from
 * loopback because the router is what connects — so forwarding those would hand
 * anyone on the tailnet holding the token the ability to stop the poller.
 */
async function control(req, res, url) {
  if (!isLocal(req) || (req.headers['x-beadcause-token'] || url.searchParams.get('t')) !== cfg.token) {
    return json(res, 403, { error: 'internal' });
  }

  if (url.pathname === '/internal/router/state') return json(res, 200, snapshot());

  if (url.pathname === '/internal/router/swap') {
    try {
      const next = await bringUp('asked for by hand');
      return json(res, 200, { ok: true, active: describe(next) });
    } catch (err) {
      // 200 with ok:false: the router is fine, the build was not, and --swap wants
      // to print the reason rather than an HTTP status.
      return json(res, 200, { ok: false, error: err.message, active: describe(active) });
    }
  }

  return json(res, 404, { error: 'no such control' });
}

const handler = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/internal/')) return control(req, res, url);

  if (!active) return json(res, 503, { error: 'no backend is running — check the log' });

  const target = active;
  target.inflight++;
  let counted = true;
  const done = () => {
    if (!counted) return;
    counted = false;
    target.inflight--;
  };
  res.on('close', done);

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: req.url,
      headers: forwardable(req.headers),
      agent,
    },
    (up) => {
      // Which process actually answered, on every response. `curl -sI` against the
      // real port is then enough to tell a stale daemon from a fresh one, which is
      // the question that started all of this.
      res.writeHead(up.statusCode, {
        ...forwardable(up.headers),
        'x-beadcause-build': target.build || 'unknown',
        'x-beadcause-pid': String(target.pid),
      });
      up.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    done();
    warn(`proxy to pid ${target.pid} failed — ${err.message}`);
    json(res, 502, { error: 'backend unreachable' });
  });
  // No timeout, on purpose: /api/poll parks for up to 55 seconds by design, and a
  // proxy that gave up at 30 would turn the phone's normal idle state into an error.
  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
};

/**
 * Refuse an upgrade before there is a socket to speak WebSocket on.
 *
 * Plain HTTP, for the reason lib/termsocket.js gives about its own refusals: a
 * browser reports a failed handshake with a status far more usefully than it reports
 * a socket that opens and closes with a code, and 1006 is also what a phone going
 * through a tunnel produces.
 */
function denyUpgrade(socket, code, message) {
  if (!socket.destroyed) socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** An HTTP message head, rebuilt from a parsed response. */
function headOf(res) {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage || ''}`.trimEnd()];
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) for (const one of v) lines.push(`${k}: ${one}`);
    else lines.push(`${k}: ${v}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * The other half of the proxy: an HTTP upgrade, tunnelled to the active backend.
 *
 * With an `upgrade` listener, Node routes an upgrade request here and never to
 * `handler`. Without one it does the opposite — the request goes to `handler` like any
 * other — which is why the symptom was a *404* rather than a dead socket: the router
 * proxied `GET /ws/terminal` as an ordinary request, with `upgrade` and `connection`
 * stripped as hop-by-hop, so the backend's own upgrade listener never saw it and
 * `app.handler` answered the only thing it could. Both halves are the bug: a listener
 * that forwarded `forwardable(req.headers)` would produce the same 404 one hop later.
 *
 * The response is one of two things and both are relayed rather than interpreted.
 * A 101 becomes two pipes and nothing else — the router never looks at a WebSocket
 * frame, so nothing here can be confused by one, and the token subprotocol is checked
 * by the backend exactly as it is under `npm run start:bare`. Anything else is the
 * backend refusing the upgrade (401 for a bad token, 404 for a path that is not the
 * terminal), and it is written out verbatim, because a proxy that turned a 401 into a
 * dropped socket would cost the client the one useful sentence in the exchange.
 */
const onUpgrade = (req, socket, head) => {
  socket.on('error', () => socket.destroy());

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return denyUpgrade(socket, 400, 'Bad Request');
  }
  // The control plane is request/response only, and a backend's `/internal/` is not
  // reachable through here by design — see `control`. An upgrade must not be the
  // hole in either.
  if (url.pathname.startsWith('/internal/')) return denyUpgrade(socket, 404, 'Not Found');
  if (!active) return denyUpgrade(socket, 503, 'Service Unavailable');

  const target = active;
  target.inflight++;
  target.upgrades.add(socket);
  let counted = true;
  /** The loopback half, once there is one. Held so the client going away can end it. */
  let tunnel = null;
  const done = () => {
    if (!counted) return;
    counted = false;
    target.inflight--;
    target.upgrades.delete(socket);
  };
  const upstream = http.request({
    host: '127.0.0.1',
    port: target.port,
    method: req.method,
    path: req.url,
    headers: upgradeHeaders(req),
    // Not the shared agent: an upgraded socket is taken out of HTTP entirely, and
    // handing it back to a pool that expects to manage it is how a tunnel ends up
    // reused for a request.
    agent: false,
  });

  // One close handler for the client end, and it ends everything. The client can go
  // away *during* the handshake — a phone that locks mid-connect — and the loopback
  // request left behind would keep the backend's own WebSocket alive with nobody on
  // the other side of it, which is a socket the drain would then wait on forever.
  socket.on('close', () => {
    done();
    upstream.destroy();
    tunnel?.destroy();
  });

  upstream.on('upgrade', (up, upSocket, upHead) => {
    tunnel = upSocket;
    upSocket.on('error', () => upSocket.destroy());
    socket.write(headOf(up));
    // Bytes each side had already sent past its own head. The backend's `ws` writes
    // its first frames immediately after the 101, so `upHead` is routinely non-empty
    // and dropping it would eat the `hello` message the terminal page waits for.
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    socket.pipe(upSocket);
    upSocket.pipe(socket);
    // The backend going away ends the client too — which is what turns a released
    // socket, or a killed backend, into a reconnect rather than a page waiting on a
    // tunnel with nothing behind it. The other direction is the close handler above.
    upSocket.on('close', () => socket.destroy());
  });

  // The backend answered rather than upgrading — its own refusal, relayed intact.
  upstream.on('response', (up) => {
    socket.write(headOf(up));
    up.on('data', (chunk) => socket.write(chunk));
    up.on('end', () => socket.end());
    up.on('error', () => socket.destroy());
  });

  upstream.on('error', (err) => {
    warn(`upgrade to pid ${target.pid} failed — ${err.message}`);
    denyUpgrade(socket, 502, 'Bad Gateway');
  });

  req.on('error', () => upstream.destroy());
  // A WebSocket handshake is a GET with no body, and `head` — anything the client
  // sent past its own request head — is written to the tunnel above rather than into
  // this request, where it would arrive before the 101 as a body nobody asked for.
  upstream.end();
};

// ----------------------------------------------------------------------- listening

/**
 * Bind loopback and the tailnet address — the same pair `lib/server.js` binds, and
 * deliberately re-implemented here rather than imported. The router has to be able
 * to come up when `lib/server.js` is broken; that is most of the point of it.
 *
 * **TLS terminates here in the installed configuration**, because here is what owns
 * the port: the backends behind this bind loopback only, so a certificate on their
 * sockets would guard the one hop that never leaves the machine and leave the phone on
 * plain http. lib/tls.js is a leaf — node builtins and lib/config.js — which keeps the
 * rule this file lives by: it depends on almost nothing, so almost nothing can stop it
 * coming up. The proxy hop to the backend stays plain `http://127.0.0.1`.
 */
function listen() {
  const hosts = ['127.0.0.1'];
  if (cfg.host && cfg.host !== '127.0.0.1') hosts.push(cfg.host);

  const material = hosts.length > 1 ? certificate(cfg) : null;

  let bound = 0;
  let failed = 0;
  return hosts.map((host) => {
    const secure = Boolean(material) && host !== '127.0.0.1';
    const { server, front } = secure ? secureServer(material, handler) : { server: http.createServer(handler), front: null };
    // The terminal rides the upgrade path, and a server with no `upgrade` listener
    // quietly treats one as an ordinary request — which is how the terminal came to
    // 404. In the installed configuration this is the only listener there is: the
    // backends bind loopback, so the one lib/termsocket.js attaches to *their* servers
    // can never be reached from the tailnet.
    server.on('upgrade', onUpgrade);
    // The front owns the port when there is one: it binds, it fails, it closes.
    const listener = front || server;
    listener.on('error', (err) => {
      warn(`listen ${host}:${cfg.port} — ${err.message}`);
      if (++failed === hosts.length && bound === 0) {
        warn('no address could be bound — exiting');
        process.exit(1);
      }
    });
    listener.listen(cfg.port, host, () => {
      bound++;
      if (secure) log(`listening on https://${material.name}:${cfg.port} (${host}, ${MIN_VERSION} floor)`);
      else log(`listening on http://${host}:${cfg.port}`);
    });
    // The request-serving server, not the front — that is what carries the certificate
    // a renewal has to replace, and it knows the front as `.front` for closing. Both
    // are the same object when there is no TLS.
    return server;
  });
}

/**
 * A certificate warning that reaches the phone, without the router importing the app.
 *
 * lib/notify.js is not a leaf — spaces, foundation, the answered ledger — and this file
 * holds the port, so it imports leaves only and nothing that could stop it starting.
 * Loading it lazily, at most once a day, in a path that already has its log line
 * written, keeps both halves: the push happens, and a broken lib/ still cannot cost you
 * port 4318.
 */
const notifyCertificate = async (state) => {
  const { pushCertificate } = await import('../lib/notify.js');
  return pushCertificate(cfg, state);
};

// ---------------------------------------------------------------- the CLI modes

/**
 * Ask the running router something, and exit if there isn't one.
 *
 * "No router answering" used to be the whole message, and it is the least useful
 * half of the answer: something *was* answering on 4318 for three days — the plain
 * server, which has no control plane — and a bare connection refused reads as "the
 * daemon is down" rather than "the daemon is the wrong program". So a failure asks
 * the installed LaunchAgent what it runs, and reports that instead when it is the
 * reason. `npm run swap:status` is the line install.sh prints on its way out, so this
 * is where somebody following the installer's own advice ends up.
 */
async function askRunningRouter(pathname, method) {
  try {
    // Generous: --swap waits out a whole spawn and health check.
    return await localJson(cfg.port, pathname, { method, timeout: 45000 });
  } catch (err) {
    console.error(`no router answering on 127.0.0.1:${cfg.port} — ${err.message}`);
    const problem = hotSwapProblem({ root: ROOT });
    if (problem) {
      console.error('');
      for (const line of problem.lines) console.error(`  ${line}`);
    }
    return process.exit(1);
  }
}

if (process.argv.includes('--status')) {
  const s = await askRunningRouter('/internal/router/state', 'GET');
  const line = (be) =>
    be
      ? `pid ${be.pid} :${be.port} build ${be.build} ${be.role} inflight ${be.inflight}${
          be.upgrades ? ` (${be.upgrades} terminal socket${be.upgrades === 1 ? '' : 's'})` : ''
        } up ${be.upSeconds}s`
      : '(none)';
  console.log(`router   pid ${s.router.pid} on :${s.router.port}${s.router.sourceChanged ? '  ⚠ source changed — restart it' : ''}`);
  console.log(`active   ${line(s.active)}`);
  for (const be of s.retiring) console.log(`draining ${line(be)}`);
  console.log(`disk     ${s.disk}${s.stale ? '  ⚠ STALE — a swap is due' : '  (matches what is running)'}`);
  if (s.poisoned) console.log(`poisoned ${s.poisoned} — this build failed to start; not retried until the files change`);
  process.exit(0);
}

if (process.argv.includes('--swap')) {
  const s = await askRunningRouter('/internal/router/swap', 'POST');
  if (s.ok) console.log(`swapped — now serving build ${s.active.build} from pid ${s.active.pid}`);
  else console.error(`swap failed — ${s.error}`);
  process.exit(s.ok ? 0 : 1);
}

// ------------------------------------------------------------------- supervise

const routerBuildAtStart = routerStamp();

const servers = listen();
// In the installed configuration this process is what terminates TLS, so it is also
// what may have just fetched the first certificate — and therefore what has to move
// `baseUrl` onto the name. Its backends bind loopback and deliberately do not. Before
// the renewal loop, because this is about the certificate `listen()` has already got
// and that one is about the next one.
reconcileBaseUrl(cfg, { persist: true });
// The router is what holds the certificate on the real port, so the router is what has
// to keep it alive — a 90-day certificate outlives no restart this process ever gets.
startRenewal(cfg, servers, { notify: notifyCertificate, log, warn });
log(`supervising ${BACKEND}`);
await bringUp('first start').catch((err) => {
  // Keep the port. A router that exited here would be restarted by launchd into the
  // same failure with nothing listening in between; holding the socket and answering
  // 503 at least says what is wrong, and the next edit gets retried.
  warn(`nothing is being served yet — ${err.message}`);
});
watchDisk();
watchSelf();
heartbeat();

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down — stopping backends');
  for (const be of [active, ...retiring].filter(Boolean)) stop(be);
  // `closeServer`, because `listen()` now hands back the request server: on the tailnet
  // address the port is held by the `net.Server` in front of it, and closing the HTTPS
  // server alone would leave 4318 bound by a process on its way out.
  servers.forEach(closeServer);
  // Give SIGTERM a moment to land on the children before the router's own exit
  // orphans them. Their own guard would catch it a minute later; this is tidier.
  setTimeout(() => process.exit(0), 300).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
