#!/usr/bin/env node
/**
 * A stopped Tailscale is not a healthy daemon, and the log has to say so.
 *
 *     npm test
 *     node test/tailnet.mjs
 *
 * ## What went wrong
 *
 * `cfg.host` is this Mac's Tailscale address. Both bind loops — `listen` in
 * lib/server.js and `listen` in bin/router.js — bind loopback *and* that address, and
 * exit only when **every** address failed:
 *
 *     if (++failed === hosts.length && bound === 0) process.exit(PORT_TAKEN_EXIT)
 *
 * With Tailscale stopped, the address is on no interface, the bind fails with
 * `EADDRNOTAVAIL`, loopback binds anyway — and so `bound` is 1 and the daemon carries
 * on. `--status` reported the build active. `curl http://127.0.0.1:4318/` returned 200.
 * The phone got nothing, and the only evidence anywhere was one line in a launchd log.
 *
 * ## What is asserted here
 *
 * The classifier, and the watcher — not the bind loops, which need a port and a
 * certificate and are covered by the suites that already start daemons. The value of
 * the classifier is that it tells the *reasons* apart, because they have different
 * cures and the startup line names them: `stopped` is something to start, `moved` is
 * something to rewrite, `starting` is nothing at all and must not read as a failure,
 * and `no-cli` is a machine that is loopback-only on purpose.
 *
 * `BEADCAUSE_TAILSCALE` points `tailscaleBin` at a script this test writes, which is
 * how the `stopped` / `moved` / `starting` branches are reachable without stopping the
 * Tailscale of whoever is running the suite. That variable is lib/config.js's own test
 * seam — test/certrenew.mjs uses it the same way.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tailnet-'));

let ran = 0;
let failures = 0;
const ok = (what) => {
  ran++;
  console.log(`  \x1b[32m✓\x1b[0m ${what}`);
};
const bad = (what, detail) => {
  ran++;
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${what}\n      ${detail}`);
};
const check = (what, fn) => {
  try {
    fn();
    ok(what);
  } catch (err) {
    bad(what, err.message);
  }
};

/** A fake `tailscale` whose `ip -4` prints whatever is wanted, or fails like a stopped one. */
function fakeTailscale(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Load the module fresh, so `tailscaleBin` re-reads the environment. */
async function load() {
  return import(`../lib/tailnet.js?${Math.random()}`);
}

try {
  // ------------------------------------------------------------------ the interfaces
  {
    delete process.env.BEADCAUSE_TAILSCALE;
    const { localAddresses, addressIsHere, tailnetState } = await load();

    check('loopback is among this machine\'s addresses', () => {
      assert.ok(localAddresses().includes('127.0.0.1'), `got ${JSON.stringify(localAddresses())}`);
    });
    check('an unset host is trivially bindable — there is nothing to check', () => {
      assert.equal(addressIsHere(null), true);
      assert.equal(addressIsHere('127.0.0.1'), true);
    });
    check('a host that is on no interface is not here', () => {
      // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — reserved for documentation, so it is
      // never a real address on a real machine, including a CI runner's.
      assert.equal(addressIsHere('192.0.2.77'), false);
    });
    check('no configured tailnet address reads as `loopback`, not as a failure', () => {
      const state = tailnetState('127.0.0.1');
      assert.equal(state.reason, 'loopback');
      assert.equal(state.ok, true);
    });
  }

  // ----------------------------------------------------------------- no tailscale CLI
  {
    // A path that does not exist: `tailscaleBin` returns null for a named binary that is
    // absent rather than falling back to the candidate list, which is what makes this
    // branch reachable on a machine that does have Tailscale installed.
    process.env.BEADCAUSE_TAILSCALE = path.join(tmp, 'no-such-tailscale');
    const { tailnetState, describeTailnet } = await load();
    const state = tailnetState('192.0.2.77');

    check('no `tailscale` at all is `no-cli` — an install that is loopback-only on purpose', () => {
      assert.equal(state.reason, 'no-cli');
      assert.equal(state.ok, false);
    });
    check('and the line says the phone cannot reach it', () => {
      assert.match(describeTailnet(state), /cannot reach it/);
    });
  }

  // ------------------------------------------------------------------------- stopped
  {
    // Silent, unlike the real one, which says "Tailscale is stopped." on stderr — the
    // suite's output is not the place to reproduce that faithfully.
    process.env.BEADCAUSE_TAILSCALE = fakeTailscale('stopped', 'exit 1');
    const { tailnetState, describeTailnet } = await load();
    const state = tailnetState('192.0.2.77');

    check('a CLI with no address to give is `stopped` — the one that cost the morning', () => {
      assert.equal(state.reason, 'stopped');
      assert.equal(state.ok, false);
    });
    check('the line names the cure, because a log that only says EADDRNOTAVAIL does not', () => {
      const line = describeTailnet(state);
      assert.match(line, /tailscale up/, `no cure in: ${line}`);
      assert.match(line, /cannot reach this daemon/, `no consequence in: ${line}`);
    });
    check('and it promises the bind happens without a restart', () => {
      assert.match(describeTailnet(state), /no restart/);
    });
  }

  // ------------------------------------------------------------------------ starting
  {
    // Tailscale knows this machine by the very address that is not up yet: the ordinary
    // few seconds after login, when launchd has already started the daemon.
    process.env.BEADCAUSE_TAILSCALE = fakeTailscale('starting', 'echo 192.0.2.77');
    const { tailnetState, describeTailnet } = await load();
    const state = tailnetState('192.0.2.77');

    check('an address Tailscale claims but has not raised yet is `starting`', () => {
      assert.equal(state.reason, 'starting');
    });
    check('and it does NOT read as a failure — this is what stops it crying wolf at every boot', () => {
      const line = describeTailnet(state);
      assert.doesNotMatch(line, /NOT on this Mac/, `reads as broken: ${line}`);
      assert.match(line, /as soon as it appears/);
    });
  }

  // --------------------------------------------------------------------------- moved
  {
    process.env.BEADCAUSE_TAILSCALE = fakeTailscale('moved', 'echo 192.0.2.99');
    const { tailnetState, describeTailnet } = await load();
    const state = tailnetState('192.0.2.77');

    check('a tailnet that gives this Mac a different address is `moved`, not `stopped`', () => {
      assert.equal(state.reason, 'moved');
      assert.equal(state.ip, '192.0.2.99');
    });
    check('and the cure is the config, not `tailscale up` — the distinction is the point', () => {
      const line = describeTailnet(state);
      assert.match(line, /192\.0\.2\.99/, `does not say what the address is now: ${line}`);
      assert.doesNotMatch(line, /tailscale up/, `sends you to start something already running: ${line}`);
    });
  }

  // ------------------------------------------------------------------------- watcher
  {
    delete process.env.BEADCAUSE_TAILSCALE;
    const { watchForAddress } = await load();

    await new Promise((resolve, reject) => {
      let fired = 0;
      const timer = setTimeout(() => reject(new Error('the watcher never fired for an address that is here')), 2000);
      watchForAddress('127.0.0.1', () => {
        fired++;
        clearTimeout(timer);
        // A tick later, to catch a watcher that kept its interval running.
        setTimeout(() => {
          if (fired === 1) ok('an address that is already here fires the watcher once, and asynchronously');
          else bad('the watcher fires once', `fired ${fired} times`);
          resolve();
        }, 60);
      }, { intervalMs: 20 });
    }).catch((err) => bad('an address that is already here fires the watcher', err.message));

    await new Promise((resolve) => {
      let fired = false;
      const stop = watchForAddress('192.0.2.77', () => {
        fired = true;
      }, { intervalMs: 10 });
      setTimeout(() => {
        stop();
        if (!fired) ok('an address that is not here does not fire it');
        else bad('an address that is not here does not fire it', 'it fired');
        resolve();
      }, 80);
    });

    check('the watcher hands back a stop function, and stopping twice is not an error', () => {
      const stop = watchForAddress('192.0.2.77', () => {}, { intervalMs: 10 });
      stop();
      stop();
    });
  }
} finally {
  delete process.env.BEADCAUSE_TAILSCALE;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
