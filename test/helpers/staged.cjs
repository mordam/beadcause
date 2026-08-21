/**
 * Fakes `os.networkInterfaces()` for one process, so `addressIsHere()` in lib/tailnet.js
 * can be made to see an address that is not really on this Mac — the same seam
 * test/latebind.mjs uses on `lib/server.js`'s in-process `listen()`, here for a
 * `bin/router.js` that has to be spawned instead.
 *
 * Preloaded with `--require`, and controlled from outside the process it is loaded
 * into: `BEADCAUSE_TEST_STAGE_FILE` names a file this reads on every call, so the test
 * flips the fake on and off by writing or removing it rather than by reaching into a
 * process it cannot import. Absent (or unset), this is the real `os.networkInterfaces`.
 *
 * What it never does is bind the address for real — that stays the kernel's answer, so
 * a router asked to bind an address that genuinely is not here still fails with a real
 * `EADDRNOTAVAIL`. This is exactly what makes "the interface list claims it, the kernel
 * refuses it" reproducible without ever adding a real address to the machine running
 * the suite.
 */
const os = require('os');
const fs = require('fs');

const real = os.networkInterfaces.bind(os);
const FLAG = process.env.BEADCAUSE_TEST_STAGE_FILE;

os.networkInterfaces = () => {
  if (!FLAG) return real();
  let staged;
  try {
    staged = fs.readFileSync(FLAG, 'utf8').trim();
  } catch {
    return real();
  }
  if (!staged) return real();
  return { staged: [{ family: staged.includes(':') ? 'IPv6' : 'IPv4', address: staged }] };
};
