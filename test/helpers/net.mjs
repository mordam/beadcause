/**
 * Ports for suites that start a real server — and why no suite may pick its own.
 *
 * ~20 agent sessions run against this repo at once and every one of them runs
 * `npm test` before it delivers. A suite that binds a number somebody typed loses
 * that race the moment two runs overlap, and it does not lose it quietly:
 * `listen()` in lib/server.js calls `process.exit(1)` when nothing binds, because a
 * listener-less daemon whose poller still fires pushes is worse than a dead one.
 * That is right for the daemon and fatal for a suite — the run dies with exit 1 and
 * an EADDRINUSE that reads exactly like a real regression in whatever was under
 * test. bc-szkq is the bead for one of those: five full-suite runs on a merged
 * branch, four green and one exit 1, reproducing in none of the four runs after it.
 *
 * Two helpers, and the first one is the one to reach for.
 *
 * `boundPort(servers)` has no window at all. The server binds port 0, the kernel
 * picks a free port, and the port is read back off the listener that is already
 * holding it — so there is no interval in which another process could take it.
 *
 * `freePort()` opens a probe on port 0, reads the assigned port and closes it, which
 * leaves a real window between the close and the bind — tens of milliseconds when what
 * binds it is a child process that has to start first. It is only for configuration that
 * has to name the port *before* the server exists — an OAuth `redirectUri`, a `baseUrl` —
 * where the port has to be known first and there is nothing else to read it off. Since
 * bc-dw47 the number it hands back is *claimed* on the way out, so no other run of these
 * suites picks it during that window; `CLAIM_DIR` says how, and what it does not promise.
 *
 * In practice that is two shapes, and both of them are shapes where there is genuinely
 * no listener in this process to read anything off:
 *
 * - a `config.json` written for a *child* to read — `test/slowstart.mjs`,
 *   `test/outagepush.mjs`, `test/routercrash.mjs`, `scripts/test-swap.js` and
 *   `scripts/space-check.mjs` each spawn `bin/router.js` or `bin/beadcause.js`, so the
 *   number has to be on disk before the process that binds it exists;
 * - an OAuth `redirectUri`, which `lib/auth.js` reads back and compares — so it has to be
 *   the port the server ends up on, and it is written into the config that *makes* the
 *   server. `test/auth.mjs` and `test/attribution.mjs` are that case, and both of them
 *   use `boundPort` for their sign-in-*off* daemon in the same file, which is the
 *   distinction drawn as sharply as it can be drawn.
 *
 * A `baseUrl` on its own is not one of these: `createApp` and `listen` hold the config
 * object by reference, so a suite can bind on port 0 and fill `cfg.baseUrl` in on the
 * line after `await boundPort(servers)`, before it makes its first request. Most of the
 * suites here do exactly that.
 *
 * This file is under `test/helpers/` rather than `test/` on purpose:
 * `scripts/test.mjs` discovers suites with a non-recursive readdir of `test/`
 * filtered on `.mjs`, so a subdirectory is invisible to it. That is what keeps a
 * helper from being run as a suite — and it also means a *suite* put in here would
 * silently never run. Suites go in `test/`, flat, which is the whole point of
 * discovery; only things that are imported belong here.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * The port a server is actually listening on, read off the listener itself.
 *
 * Call `listen({ ...cfg, port: 0 }, handler)` and hand the result straight here:
 *
 *     const servers = listen({ ...cfg, port: 0 }, app.handler);
 *     const port = await boundPort(servers);
 *
 * Awaiting it is also the answer to the other thing suites used to work around —
 * `listen()` returns before the socket is up, so the old fixed-port suites raced
 * their first request against their own bind and retried in a loop. Once this
 * resolves, the socket is listening.
 *
 * Loopback-only, deliberately. `listen()` binds one listener per host, and with
 * port 0 each host would be given a *different* ephemeral port — so "the" port is
 * only a meaningful thing to ask for when there is one listener. Every suite is
 * `host: '127.0.0.1'`, and anything else is a mistake worth hearing about.
 */
export function boundPort(servers) {
  if (!Array.isArray(servers) || servers.length !== 1) {
    throw new Error(
      `boundPort expects one listener (host: '127.0.0.1'), got ${Array.isArray(servers) ? servers.length : typeof servers} — ` +
        'with port 0 each host binds a different port, so there is no single port to report'
    );
  }
  // A TLS listener hangs the net.Server that owns the port on the http server as
  // `.front`; a plain one is the listener itself. This is the same pair closeServer
  // knows about.
  const listener = servers[0].front || servers[0];
  return new Promise((resolve, reject) => {
    const done = () => {
      const address = listener.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error(`listener has no address to report (${JSON.stringify(address)})`));
    };
    if (listener.listening) done();
    else {
      listener.once('listening', done);
      listener.once('error', reject);
    }
  });
}

/**
 * Where a port handed out by `freePort` is claimed, so that no other run picks it too.
 *
 * One directory per machine, in `os.tmpdir()`, one empty-ish file per port named after
 * the number and containing the pid that took it. It is not a lock in any strong sense —
 * nothing waits on it and nothing is guaranteed by it — it is a note to the other ~20
 * `npm test` runs saying "this number is spoken for", which is all that was missing.
 */
export const CLAIM_DIR = path.join(os.tmpdir(), 'beadcause-ports');

/** Ports this process claimed, so exiting can put them back. */
const mine = new Set();

/**
 * A claim older than this is ignored however alive its pid looks.
 *
 * The pid check below is the real test, and this is the backstop for the one case it
 * gets wrong: pids are reused, so a claim left behind by a killed suite can be inherited
 * by an unrelated long-lived process and hold a port for as long as that process lives.
 * No suite here runs for two hours, so nothing legitimate is thrown away by this.
 */
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/** Whether the pid in a claim is still around to be using it. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is a process this user may not signal — which is to say, a process. Only
    // ESRCH is evidence that nothing is there.
    return err.code === 'EPERM';
  }
}

/**
 * Take `port` for this process, or report that somebody else has it.
 *
 * Exported for `test/ports.mjs`, which is the only caller that wants a particular
 * number: everything else goes through `freePort` and takes what it is given.
 */
export function claimPort(port) {
  const file = path.join(CLAIM_DIR, String(port));
  fs.mkdirSync(CLAIM_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `wx` is the whole mechanism: an exclusive create is one syscall, and two runs
      // asking at the same instant means one EEXIST and never two winners.
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      mine.add(port);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = true;
      try {
        const pid = Number(fs.readFileSync(file, 'utf8').trim());
        const age = Date.now() - fs.statSync(file).mtimeMs;
        stale = !alive(pid) || age > CLAIM_TTL_MS;
      } catch {
        // Unreadable or already gone. Either way there is nothing here to respect.
      }
      if (!stale) return false;
      // One reclaim, then round again — and if the second `wx` also loses, another run
      // reclaimed it first and it is theirs, not ours.
      try {
        fs.unlinkSync(file);
      } catch {
        /* somebody else got there first; the retry will find out */
      }
    }
  }
  return false;
}

/** Give back every port this process claimed. Registered on `exit` below. */
export function releasePorts() {
  for (const port of mine) {
    try {
      fs.unlinkSync(path.join(CLAIM_DIR, String(port)));
    } catch {
      /* already reclaimed, or the directory went with the tmpdir */
    }
  }
  mine.clear();
}

// Best effort, and the stale check above is what covers the rest: a suite killed with
// SIGKILL — which is how a hung one dies — runs no handler at all.
process.on('exit', releasePorts);

/**
 * Candidates asked of the kernel before giving up on finding an unclaimed one.
 *
 * Generous, because each is one bind of one socket, and the thing it is protecting
 * against is a whole suite dying. Reaching the end means every one of twenty ephemeral
 * ports was claimed by a live run, which has not happened and would say something is
 * wrong with the claims rather than with the ports.
 */
const CANDIDATES = 20;

/**
 * A port nothing is listening on, for configuration that must name one up front.
 *
 * Prefer `boundPort`. This closes the probe before returning it, so the port is free
 * rather than held — which is the point, and also the window. Use it only where the
 * number has to exist before the server does.
 *
 * **The window is not small when the binder is a child process** (bc-dw47). Between this
 * returning and `bin/router.js` or `bin/beadcause.js` binding what it was told, node has
 * to start, read a config and reach `listen` — tens of milliseconds, not one — and any of
 * the ~20 other runs on this laptop asking the kernel for a port in that time can be
 * given the same number. So the port is *claimed* before it is handed back: a file in
 * `CLAIM_DIR` that the other runs' `freePort` calls will not pick past. The kernel still
 * chooses the number, because it is the only thing that knows what is really free; the
 * claim only stops beadcause colliding with beadcause, which is the collision there is.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const probe = () =>
      new Promise((done, fail) => {
        const server = net.createServer();
        server.on('error', fail);
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          server.close(() => done(port));
        });
      });
    const round = () => {
      probe().then((port) => {
        // Claimed, or out of patience — and out of patience still hands back a real
        // free port, because the claim is an improvement on this helper and not a
        // precondition of it. Never fail where the old one would have succeeded.
        if (claimPort(port) || ++tries >= CANDIDATES) return resolve(port);
        round();
      }, reject);
    };
    round();
  });
}
