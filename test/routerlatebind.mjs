#!/usr/bin/env node
/**
 * bin/router.js does not spin when the interface list claims a tailnet address the
 * kernel still refuses to bind — bc-68ou.12.
 *
 *     npm test
 *     node test/routerlatebind.mjs
 *
 * ## What went wrong
 *
 * `deferTailnet`'s late-bind attempt re-armed itself synchronously on failure —
 * `onError: (err) => { if (err.code === 'EADDRNOTAVAIL') deferTailnet(); }` — and
 * `watchForAddress` in lib/tailnet.js fires *immediately*, via `setImmediate`, for an
 * address the interface list already claims. So the moment `os.networkInterfaces()`
 * lists an address the kernel still refuses to bind — a real if brief state while an
 * address is being added or removed — the two chased each other as fast as the event
 * loop would go: defer, fire, fail, defer, with a warn line per pass, until the two
 * agreed again. This is the process that was found holding port 4318.
 *
 * lib/server.js had the identical shape and was fixed in bc-b4fs.1 — test/latebind.mjs
 * covers it — by waiting one watch interval (`WATCH_EVERY_MS`) before re-arming.
 * bin/router.js gets the same fix here, plus the second half the bead asked for
 * together: the late servers used to join the array `shutdown` closes and
 * `startRenewal` reads *before* the bind was known to have succeeded, so a flapping
 * address left a dead socket in that array on every failed attempt.
 *
 * ## How this is proven without adding a real address to the machine
 *
 * `bin/router.js` cannot be imported the way test/latebind.mjs imports `lib/server.js`
 * — it holds a real port and runs its startup as a side effect of module load — so,
 * like test/routercrash.mjs, a real one is spawned. `test/helpers/staged.cjs` is
 * preloaded with `--require` and fakes `os.networkInterfaces()` from *outside* the
 * process, via a flag file this suite writes and removes; the actual bind is never
 * faked, so `EADDRNOTAVAIL` on it is real throughout. `10.255.255.254` (RFC 5735) is on
 * no interface anywhere this runs, so the initial deferral needs no fakery at all, and
 * staging it afterwards reproduces exactly "the interface list claims it, the kernel
 * refuses it" without ever touching a real interface — the one thing test/latebind.mjs
 * says no suite may do.
 *
 * What is asserted is the externally observable half of the fix: the gap between two
 * retries is roughly a watch interval, not a spin. The other half — that a failed
 * late-bind does not leave a dead socket in the array `shutdown` closes — is not
 * observable from outside a spawned process without adding a status field for it; it
 * is proved instead by the code now being the same shape lib/server.js's is, which
 * test/latebind.mjs already exercises directly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/net.mjs';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ROUTER = path.join(ROOT, 'bin', 'router.js');
const BACKEND = path.join(ROOT, 'bin', 'beadcause.js');
const STAGE_PRELOAD = path.join(HERE, 'helpers', 'staged.cjs');
const TOKEN = 'test-token-not-a-secret';

/** RFC 5735 says nothing lives here, and nothing on this Mac does. Checked below. */
const ABSENT = '10.255.255.254';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-routerlatebind-'));
const stageFile = path.join(dir, 'staged-address');

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- the sandbox */
// A stub `bd` that never has to do anything: `armCrashHandlers` constructs a `Bd`
// around it but only calls it if the router actually crashes, which nothing here does.
const STUB = path.join(dir, 'bd');
fs.writeFileSync(STUB, `#!/usr/bin/env node\nprocess.stdout.write('[]');\n`, { mode: 0o755 });

const OWN = 'own';
const wsDir = path.join(dir, 'beads', OWN, '.beads');
fs.mkdirSync(wsDir, { recursive: true });

const port = await freePort();
fs.writeFileSync(
  path.join(dir, 'config.json'),
  JSON.stringify(
    {
      port,
      host: ABSENT,
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      bdBin: STUB,
      actor: 'beadcause-test',
      tls: { enabled: false },
      workspaces: [{ name: OWN, dir: wsDir }],
      sessionDirs: { [OWN]: ROOT },
      openSessions: false,
      autoDispatch: false,
      claudeSessions: false,
      pollSeconds: 3600,
      ntfy: { enabled: false },
      advocates: { enabled: false, workspaces: [] },
    },
    null,
    2
  )
);

const env = { ...process.env, BEADCAUSE_CONFIG_DIR: dir, BEADCAUSE_TEST_STAGE_FILE: stageFile };
delete env.BEADCAUSE_OBSERVE;
delete env.BEADCAUSE_READONLY;

/**
 * A router, with `os.networkInterfaces()` faked out from underneath it.
 *
 * The log goes to a file rather than a pipe for the same reason test/routercrash.mjs's
 * does: Node writes to a pipe asynchronously, and the lines this suite counts have to
 * be there the instant they are written, not whenever the pipe happens to drain.
 */
function startRouter() {
  const logPath = path.join(dir, 'router.log');
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['--require', STAGE_PRELOAD, ROUTER], {
    cwd: ROOT,
    env,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const text = () => {
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };
  const count = (needle) => text().split(needle).length - 1;
  return { child, text, count };
}

async function until(fn, what, ms = 20000, every = 50) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (fn()) return;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const router = startRouter();
const running = [router];
const cleanup = () => {
  for (const r of running) if (r.child.exitCode === null) r.child.kill('SIGKILL');
  try {
    fs.rmSync(stageFile, { force: true });
  } catch {
    /* already gone */
  }
  // The router killed above does not stop the backend it spawned; the pattern is this
  // checkout's own absolute path, so it can only ever match a backend this suite started.
  try {
    execFileSync('pkill', ['-f', BACKEND], { stdio: 'ignore' });
  } catch {
    /* nothing to kill is the good case */
  }
  removeTreeSync(dir);
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  console.log(`\n  router late-bind — :${port}, config in ${dir}\n`);

  check(
    !Object.values(os.networkInterfaces()).flat().some((a) => a?.address === ABSENT),
    'the address this suite calls absent really is absent from this Mac'
  );

  // ---------------------------------------------------------- the address is not here
  await until(() => router.count('EADDRNOTAVAIL') >= 1, 'the first bind of the absent tailnet address to fail');
  await until(() => router.count(`tailnet ${ABSENT}`) >= 1, 'the initial deferral to be logged');
  check(true, 'a tailnet address on no interface is deferred rather than lost, with no fakery needed');
  check(router.count('restart to bind it') === 0, 'and it no longer tells you to restart — that promise was bc-b4fs.1');

  // -------------------------------------- the interface list claims it, kernel refuses it
  fs.writeFileSync(stageFile, ABSENT);

  await until(() => router.count('binding it without a restart') >= 1, 'the watcher to notice the staged address');
  const firstNotice = Date.now();
  await until(() => router.count('binding it without a restart') >= 2, 'a second attempt after the first fails', 15000);
  const gapMs = Date.now() - firstNotice;

  check(
    gapMs >= 3000,
    `two retries land roughly a watch interval apart, not back to back (saw ${gapMs}ms between them)`,
    router.text().split('\n').filter(Boolean).slice(-15).join('\n')
  );

  const before = router.count('binding it without a restart');
  await sleep(500);
  const after = router.count('binding it without a restart');
  check(
    after - before <= 1,
    `half a second of a disagreeing interface list produces at most one more attempt — a hot loop would produce many (saw ${
      after - before
    })`,
    router.text().split('\n').filter(Boolean).slice(-15).join('\n')
  );

  fs.rmSync(stageFile, { force: true });
  await sleep(200);
  const quiet = router.count('binding it without a restart');
  await sleep(500);
  check(
    router.count('binding it without a restart') === quiet,
    'and once the interface list agrees with the kernel again, nothing keeps retrying'
  );
} catch (err) {
  bad('the run itself', err?.stack || String(err));
}

console.log(`\n  ${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
