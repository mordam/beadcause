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
 * leaves a real (if small) window between the close and the bind. It is only for
 * configuration that has to name the port *before* the server exists — an OAuth
 * `redirectUri`, a `baseUrl` — where the port has to be known first and there is
 * nothing else to read it off.
 *
 * In practice that is two shapes, and both of them are shapes where there is genuinely
 * no listener in this process to read anything off:
 *
 * - a `config.json` written for a *child* to read — `test/slowstart.mjs`,
 *   `test/outagepush.mjs`, `scripts/test-swap.js` and `scripts/space-check.mjs` each
 *   spawn `bin/router.js` or `bin/beadcause.js`, so the number has to be on disk before
 *   the process that binds it exists;
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
import net from 'node:net';

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
 * A port nothing is listening on, for configuration that must name one up front.
 *
 * Prefer `boundPort`. This closes the probe before returning it, so the port is free
 * rather than held — which is the point, and also the window. Use it only where the
 * number has to exist before the server does.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
