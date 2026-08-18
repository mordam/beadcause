#!/usr/bin/env node
/**
 * `npm run start:bare` binds the tailnet address when it turns up — it no longer waits
 * to be restarted.
 *
 *     npm test
 *     node test/latebind.mjs
 *
 * ## What went wrong
 *
 * bc-b4fs: launchd starts the daemon at login, Tailscale has not finished connecting,
 * `cfg.host` is on no interface, the bind fails with `EADDRNOTAVAIL` — and because
 * loopback bound, the process carried on. `--status` said healthy, `curl` on loopback
 * said 200, and the phone got nothing until somebody noticed by hand.
 *
 * bin/router.js was given the cure and `listen()` in lib/server.js was given only the
 * diagnosis: it logged which of the four states it was in and told you to restart. That
 * is the installed configuration covered and the unsupervised one left where it was,
 * which is bc-b4fs.1 and what this suite is about.
 *
 * ## What is asserted here, and what is staged
 *
 * The deferral is real: `10.255.255.254` is on no interface of any machine that runs
 * this, so the first bind fails for the same reason a stopped Tailscale makes it fail,
 * with no fakery at all. What cannot be real is the *arrival* — no test may add an
 * address to the machine it is running on — so two seams stand in for it, and they are
 * kept apart on purpose:
 *
 *   - **the address appearing** is `os.networkInterfaces`, which is the one thing
 *     `addressIsHere` in lib/tailnet.js consults. Patching it is what makes the watcher
 *     fire, and it is the same seam test/tailnet.mjs uses on the classifier.
 *   - **the address binding** is `cfg.host`, rewritten to `::1` — a real address, on a
 *     real interface, that `listen()` treats as a tailnet address because the only
 *     thing that makes an address "the tailnet one" here is that it is not
 *     `127.0.0.1`. So the socket that comes up late is a socket that genuinely came up.
 *
 * Everything between those two — the watcher, the second `bindHost`, the array the
 * sockets join, the `onLateBind` hook and what happens when it throws — is the real
 * code running for real.
 *
 * The other half of the bead is `attachUpgrade` in lib/termsocket.js, and the bead
 * asked the question this suite answers: what `attachTerminalSocket` does when it is
 * handed a second server. It builds a **second `WebSocketServer`** — a second client
 * set, which `releaseSockets` cannot reach, so a phone on the late address would be cut
 * off as a 1006 mid-keystroke on the next swap instead of a close frame it can act on.
 * Hence one `wss` wired onto both, and the contrast is pinned below.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-latebind-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const say = console.log.bind(console);

let ran = 0;
let failures = 0;
const check = async (what, fn) => {
  ran++;
  try {
    await fn();
    say(`  \x1b[32m✓\x1b[0m ${what}`);
  } catch (err) {
    failures++;
    say(`  \x1b[31m✗\x1b[0m ${what}\n      ${err.message}`);
  }
};

/**
 * Everything the daemon says, kept rather than printed — these paths are deliberately
 * chatty (the whole bead is that the log was too quiet) and the lines are the evidence.
 */
const said = [];
console.log = (...a) => said.push(a.join(' '));
console.error = (...a) => said.push(a.join(' '));
const heard = (needle) => said.filter((l) => l.includes(needle)).length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `fn` is true, or give up — a failed wait must read as a failed assertion. */
const until = async (fn, what, ms = 4000) => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}\n      log:\n        ${said.join('\n        ')}`);
};

const { listen } = await import(LIB('server.js'));
const { closeServer } = await import(LIB('tls.js'));
const { attachTerminalSocket, attachUpgrade, releaseSockets } = await import(LIB('termsocket.js'));
const { addressIsHere } = await import(LIB('tailnet.js'));

/** RFC 5735 says nothing lives here, and nothing on this Mac does. Checked, not assumed. */
const ABSENT = '10.255.255.254';
/** A real address that is not `127.0.0.1`, which is the whole of what makes one "tailnet". */
const LATE = '::1';

const realInterfaces = os.networkInterfaces;
const pretendItArrived = () => {
  os.networkInterfaces = () => ({ staged: [{ family: 'IPv4', address: ABSENT }] });
};
const pretendItIsGone = () => {
  os.networkInterfaces = realInterfaces;
};

const opened = [];
const hello = (req, res) => res.end('ok');

/**
 * Start a daemon whose tailnet address is not here, and wait until it has said so.
 *
 * `watchEveryMs` is 20 rather than the five seconds a real daemon waits — that option
 * exists for this, and lib/server.js says so where it takes it.
 */
async function daemonWithNoTailnet(onLateBind) {
  pretendItIsGone();
  const cfg = { host: ABSENT, port: 0, token: 'tok', tls: { enabled: false } };
  const servers = listen(cfg, hello, { onLateBind, watchEveryMs: 20 });
  opened.push(servers);
  await until(() => servers.length === 1, 'the address that could not be bound to be dropped');
  return { cfg, servers };
}

try {
  await check('the address this suite calls absent really is absent', () => {
    assert.equal(addressIsHere(ABSENT), false);
  });

  // ------------------------------------------------------------------ the deferral
  {
    const late = [];
    const { servers } = await daemonWithNoTailnet((l) => late.push(l));

    await check('loopback is bound and serving — a stopped Tailscale is not a dead daemon', () => {
      assert.equal(servers.length, 1);
      assert.equal(servers[0].address().address, '127.0.0.1');
    });

    await check('the log names the cause, not just EADDRNOTAVAIL', () => {
      assert.ok(heard('EADDRNOTAVAIL') >= 1, 'the bind failure itself');
      assert.ok(heard(`tailnet     ${ABSENT}`) >= 1, `a tailnet line about ${ABSENT}`);
    });

    await check('and it no longer tells you to restart — that promise was the bead', () => {
      assert.equal(heard('restart to bind it'), 0);
    });

    await check('the server that never bound is not left in the array the daemon reads', () => {
      // `ownTls` answers `/api/tls` off this array and `startRenewal` filters it, so a
      // dead socket in it is https reported on a port nothing can connect to.
      assert.equal(servers.length, 1);
    });

    await check('nothing is re-armed while there is nothing to re-arm', () => {
      assert.equal(late.length, 0);
    });
  }

  // ------------------------------------------- the address the kernel still refuses
  {
    const late = [];
    const { servers } = await daemonWithNoTailnet((l) => late.push(l));
    const failures0 = heard('EADDRNOTAVAIL');

    pretendItArrived();
    await until(() => heard('binding it without a restart') >= 1, 'the watcher to notice');
    await until(() => heard('EADDRNOTAVAIL') > failures0, 'the second bind to fail too');
    pretendItIsGone();

    await check('an address the interface list claims but the kernel refuses is deferred again', () => {
      assert.ok(heard('EADDRNOTAVAIL') > failures0);
    });

    await check('and it leaves no dead socket behind and re-arms nothing', () => {
      // The pair from the failed attempt is closed and dropped, not pushed. Otherwise an
      // address that flaps grows this array once per flap, and the renewal loop is
      // rebuilt around a socket that never came up.
      assert.equal(servers.length, 1);
      assert.equal(late.length, 0);
    });

    await check('the retry waits an interval rather than spinning', async () => {
      // With the interface list and the kernel disagreeing, an immediate re-arm is a hot
      // loop: defer, fire, fail, defer, as fast as the event loop will go. The gap is
      // what makes it a retry. 20ms here, five seconds in a real daemon.
      const before = heard('binding it without a restart');
      pretendItArrived();
      await sleep(120);
      pretendItIsGone();
      const tries = heard('binding it without a restart') - before;
      assert.ok(tries >= 1, 'it did retry');
      assert.ok(tries < 20, `it retried ${tries} times in 120ms — that is a spin, not a retry`);
    });
  }

  // ------------------------------------------------------------ the address arrives
  {
    const late = [];
    const { cfg, servers } = await daemonWithNoTailnet((l) => late.push(l));

    cfg.host = LATE;
    pretendItArrived();
    await until(() => late.length === 1, 'the late bind');
    pretendItIsGone();

    await check('the address is bound without a restart', () => {
      assert.equal(servers.length, 2);
      assert.ok(servers[1].address(), 'the late server is listening');
    });

    await check('the late sockets join the array the daemon closes and renews', () => {
      // Not a copy of it: `shutdown` closes this array and `startRenewal` filters it, so
      // a late socket that arrived anywhere else is one nothing will ever renew or close.
      assert.deepEqual(late[0], [servers[1]]);
    });

    await check('and the hook is handed exactly the servers that came up', () => {
      assert.equal(late[0].length, 1);
      assert.equal(late[0][0], servers[1]);
    });
  }

  // ------------------------------------------------- a caller whose re-arming throws
  {
    const { cfg, servers } = await daemonWithNoTailnet(() => {
      throw new Error('startRenewal fell over');
    });

    cfg.host = LATE;
    pretendItArrived();
    await until(() => servers.length === 2, 'the late bind');
    pretendItIsGone();

    await check('a hook that throws does not take down a daemon that is now serving', () => {
      assert.ok(servers[1].address(), 'the late server is still listening');
      assert.ok(heard('re-arming the daemon around it failed') >= 1, 'and it says so');
    });
  }

  // ------------------------------------------------------------- the terminal socket
  {
    const cfg = { host: '127.0.0.1', port: 0, token: 'tok' };
    const first = http.createServer(hello);
    const second = http.createServer(hello);
    await new Promise((r) => first.listen(0, '127.0.0.1', r));
    await new Promise((r) => second.listen(0, '127.0.0.1', r));
    const port = second.address().port;

    const wss = await attachTerminalSocket(cfg, [first]);

    /** Dial `/ws/terminal` and report how the handshake ended, whichever way it did. */
    const dial = async (token) => {
      const { WebSocket } = await import('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=nosuchterminal`, [
        'beadcause.term.v1',
        `tok.${token}`,
      ]);
      return new Promise((resolve) => {
        ws.on('close', (code) => resolve({ closed: code }));
        ws.on('error', (err) => resolve({ error: err.message }));
      });
    };

    await check('a server nothing attached to answers no upgrade at all', async () => {
      const out = await dial('tok');
      assert.ok(out.error, `expected the handshake to fail, got ${JSON.stringify(out)}`);
      assert.equal(out.closed, undefined);
    });

    await check('attachUpgrade wires the same socket server onto a server bound later', async () => {
      assert.equal(attachUpgrade(cfg, wss, [second]), 1);
      const out = await dial('tok');
      // 1008 is `no such terminal`, which only the real handshake produces — it is sent
      // *after* the upgrade, by the `wss` that handled it. Reaching it at all is the
      // proof that the late server is served by a WebSocketServer.
      assert.equal(out.closed, 1008, `expected 1008 from the late server, got ${JSON.stringify(out)}`);
    });

    await check('and the credentials on it are the same ones, not a second door', async () => {
      const out = await dial('wrong');
      // Refused before a WebSocket exists, so this arrives as a failed handshake rather
      // than as a close code — see `deny`.
      assert.ok(out.error, `expected the bad token to be refused, got ${JSON.stringify(out)}`);
    });

    await check('calling attachTerminalSocket again would be a second client set — which is the trap', async () => {
      const other = await attachTerminalSocket(cfg, [second]);
      assert.notEqual(other, wss);
      assert.equal(other.clients.size, 0);
      // `releaseSockets` is handed one handle by bin/beadcause.js, so anything attached
      // through a second one is invisible to `/internal/release` — a phone cut off as a
      // 1006 mid-keystroke on the next swap rather than given a close frame it can act on.
      assert.equal(releaseSockets(other), 0);
      other.close();
    });

    await check('terminals switched off is nothing to attach, not a crash', () => {
      assert.equal(attachUpgrade(cfg, null, [second]), 0);
      assert.equal(releaseSockets(null), 0);
    });

    wss.close();
    first.close();
    second.close();
  }
} finally {
  pretendItIsGone();
  for (const servers of opened) servers.forEach(closeServer);
  console.log = say;
  console.error = say;
  await cleanupTmp(tmp);
}

say(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
