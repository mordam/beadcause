#!/usr/bin/env node
/**
 * The router files its own crashes too — the half of bc-p38c.4 that was left out.
 *
 *     npm test
 *     node test/routercrash.mjs
 *
 * bc-ega4. test/crash.mjs covers lib/crash.js exhaustively and covers `bin/router.js` not
 * at all, which was the honest state of the code: the backend was armed, and the process
 * holding port 4318 — the one launchd actually runs, the one whose death is the only death
 * a phone can see — was not. A backend that dies is replaced within seconds by the router
 * and never reaches anybody; the router dying *is* the outage. So the crash most worth a
 * bead was the crash with no bead, and this suite is about that one process rather than
 * about the module it now shares with the daemon.
 *
 * Which means it is deliberately end-to-end and not a unit test. Everything interesting
 * here is wiring — whether the handlers are armed at all, on which graph, and whether the
 * router's own teardown is exempt — and none of it can be asserted about a module in
 * isolation. So a real `bin/router.js` is spawned, in a sandbox, and really crashed.
 *
 * **The crash comes from outside the program.** `test/helpers/crashon.cjs` is preloaded
 * with `--require` and throws on SIGUSR2; the router has no idea it exists. The obvious
 * alternative — a `BEADCAUSE_TEST_CRASH` branch in the router — would put a seam in the
 * one file this repo works hardest to keep free of them, shipped to every user, to serve
 * one suite. test/outagepush.mjs refuses the same trade for the same reason.
 *
 * Three claims:
 *
 *   1. **An uncaught exception in the router becomes a P0 bug carrying the stack**, with
 *      the same labels and the same shape a backend crash gets — and the process still
 *      exits 1, because taking over from Node must not turn a crash into a router that
 *      keeps holding the port in a state it cannot vouch for.
 *   2. **On this checkout's own graph**, not `cfg.workspaces[0]`. The sandbox puts a decoy
 *      workspace first on purpose: the fallback is real, and a bead about beadcause landing
 *      on somebody's JIRA graph is the failure that would not look like one.
 *   3. **Nothing files during the router's own shutdown.** `launchctl kickstart` is a
 *      SIGTERM, and a teardown makes things in flight reject — without `beginShutdown()`
 *      every restart of the service would file a P0 about a router doing as it was told.
 *
 * Hermetic like test/slowstart.mjs and test/outagepush.mjs: a scratch config dir, an
 * ephemeral port, advocates and sessions off, and `bd` stubbed by the same fake tracker
 * test/crash.mjs uses. The stub writes each workspace's beads into a directory *inside the
 * sandbox* keyed by the `BEADS_DIR` it was called with — so which graph was chosen is
 * observable, and a wrong answer still cannot put a file anywhere near a real `~/beads`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ROUTER = path.join(ROOT, 'bin', 'router.js');
const BACKEND = path.join(ROOT, 'bin', 'beadcause.js');
const PRELOAD = path.join(HERE, 'helpers', 'crashon.cjs');
const TOKEN = 'test-token-not-a-secret';

/** The graph this checkout should file on, and the one it must not fall back to. */
const OWN = 'routercrash';
const DECOY = 'aaadecoy';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-routercrash-'));
process.env.BEADCAUSE_CONFIG_DIR = dir;
const { ERROR_LABEL, ERROR_PRIORITY, AT_PREFIX } = await import(path.join(ROOT, 'lib', 'errors.js'));

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

/* ------------------------------------------------------------------- the stub bd */

const STORES = path.join(dir, 'stores');
fs.mkdirSync(STORES, { recursive: true });
const STUB = path.join(dir, 'bd');

/**
 * test/crash.mjs's fake tracker, with one difference that is the whole of claim 2: the
 * beads go under `stores/<workspace>/` rather than into one directory, keyed off the
 * `BEADS_DIR` the real `bd` would have used. So the store that has a bead in it *is* the
 * answer to which graph the router chose — and every path it can write to is inside this
 * sandbox, including the wrong ones.
 */
fs.writeFileSync(
  STUB,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const DIR = path.join(${JSON.stringify(STORES)}, path.basename(path.dirname(process.env.BEADS_DIR || 'nowhere')));
fs.mkdirSync(DIR, { recursive: true });
const file = (id) => path.join(DIR, id + '.json');
const read = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
const write = (i) => fs.writeFileSync(file(i.id), JSON.stringify(i, null, 2));
const all = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => read(path.basename(f, '.json'))).filter(Boolean);
const one = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (args[0] === 'list') {
  const any = many('--label-any');
  const need = many('--label');
  let rows = all();
  if (!args.includes('--all')) rows = rows.filter((i) => i.status !== 'closed');
  if (need.length) rows = rows.filter((i) => need.every((l) => (i.labels || []).includes(l)));
  if (any.length) rows = rows.filter((i) => any.some((l) => (i.labels || []).includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'create') {
  let id = null;
  for (let n = 1; n < 500 && !id; n++) {
    try { fs.writeFileSync(file('zz-' + n), '{}', { flag: 'wx' }); id = 'zz-' + n; } catch { /* taken */ }
  }
  if (!id) die('out of ids');
  write({
    id,
    title: one('--title') || '',
    description: one('--description') || '',
    acceptance: one('--acceptance') || '',
    notes: one('--notes') || '',
    issue_type: one('--type') || 'task',
    priority: Number(one('--priority') ?? 2),
    status: 'open',
    labels: many('--label'),
    deps: many('--deps'),
    comment_count: 0,
    comments: [],
    created_by: one('--actor') || '',
  });
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = read(args[1]) || die('no issue ' + args[1]);
  issue.comments.push(args[2]);
  issue.comment_count = issue.comments.length;
  write(issue);
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'add') {
  const issue = read(args[2]) || die('no issue ' + args[2]);
  if (!issue.labels.includes(args[3])) issue.labels.push(args[3]);
  write(issue);
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/** Every bead the stub has written, by workspace name. */
const beadsIn = (workspace) => {
  const store = path.join(STORES, workspace);
  if (!fs.existsSync(store)) return [];
  return fs
    .readdirSync(store)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(store, f), 'utf8')))
    .filter((b) => b && b.id);
};
const storesWritten = () => (fs.existsSync(STORES) ? fs.readdirSync(STORES).filter((f) => beadsIn(f).length) : []);

/* ------------------------------------------------------------------- the sandbox */

const wsDir = (name) => path.join(dir, 'beads', name, '.beads');
for (const name of [OWN, DECOY]) fs.mkdirSync(wsDir(name), { recursive: true });

const port = await freePort();
fs.writeFileSync(
  path.join(dir, 'config.json'),
  JSON.stringify(
    {
      port,
      host: '127.0.0.1',
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      bdBin: STUB,
      actor: 'beadcause-test',
      // Two workspaces, and the decoy sorts first so it is what `cfg.workspaces[0]` would
      // hand back. `sessionDirs` is what makes the other one *this checkout's own*, which
      // is the rule `ownWorkspace` follows and the only reason the right one wins.
      workspaces: [
        { name: DECOY, dir: wsDir(DECOY) },
        { name: OWN, dir: wsDir(OWN) },
      ],
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

// An observing instance files nothing at all, by design (lib/crash.js) — so a stray
// BEADCAUSE_OBSERVE in the environment running `npm test` would turn this suite's first
// two claims green by silencing the thing they exist to check.
const env = { ...process.env, BEADCAUSE_CONFIG_DIR: dir };
delete env.BEADCAUSE_OBSERVE;
delete env.BEADCAUSE_READONLY;

/**
 * A router, crashed on command.
 *
 * `--require` is passed to node rather than set in NODE_OPTIONS on purpose: the router
 * spawns its backends with `process.execPath` and no `execArgv`, so an argv flag stops
 * here and an environment variable would have preloaded the crash-on-signal handler into
 * every backend as well.
 *
 * **The output goes to a file and not to a pipe, and that is not a convenience.** Node
 * writes to a pipe asynchronously and `process.exit()` does not drain them, so the last
 * few lines a dying process writes are lost — and every line this suite reads is written
 * in the moments before an explicit `exit(1)`. Writing to a file makes those writes
 * synchronous, which is the difference between asserting on the log and asserting on
 * whether the kernel got there first. The shutdown scenario failed exactly this way
 * before, and it failed by going *quiet*, which is the flake that reads as a real bug.
 */
function startRouter(label) {
  const logPath = path.join(dir, `${label}.log`);
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['--require', PRELOAD, ROUTER], {
    cwd: ROOT,
    env,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const text = () => {
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };
  return { label, child, exited, text, saw: (re) => re.test(text()) };
}

/** The tail of a router's log, for a failure message somebody has to read. */
const tail = (router, n = 8) => router.text().split('\n').filter(Boolean).slice(-n).join('\n');

async function waitForLine(router, re, ms, every = 100) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (router.saw(re)) return true;
    if (Date.now() >= deadline) break;
    await sleep(every);
  }
  throw new Error(`${router.label}: timed out waiting for ${re} — log so far:\n${router.text()}`);
}

/** Armed, and the arming said which graph on. */
const ARMED = new RegExp(`own crashes file on ${OWN}`);
/**
 * The first bring-up has finished, one way or the other.
 *
 * What is wanted here is a router with something to tear down, so that the shutdown the
 * scenario interrupts is the one a `launchctl kickstart` really interrupts — a backend to
 * stop as well as a port to close. Either outcome of the bring-up will do; what is being
 * waited for is the line after it.
 *
 * It used to carry the load of a second job as well: `bin/router.js` registered its
 * SIGTERM handler on the last line of the file, *after* `await bringUp(...)`, so a router
 * signalled before that point was killed by node's default disposition and never ran
 * `shutdown` at all — and the suite failed by going quiet, which reads as the exemption
 * being broken rather than as the test being early. That handler goes on immediately after
 * `listen()` now (bc-1wf9), so `ARMED` already implies it and this line no longer has to.
 */
const SUPERVISING = /serving build \S+ from pid \d+|nothing is being served yet/;

const running = [];
const cleanup = () => {
  for (const r of running) if (r.child.exitCode === null) r.child.kill('SIGKILL');
  // A router killed by its own crash handler does not stop its backends, so each scenario
  // leaves one behind. Its orphan guard would exit it inside a minute on its own; this is
  // the tidier minute. The pattern is this checkout's absolute path, so it can only ever
  // match a backend this suite started — the installed daemon runs from another one.
  try {
    execFileSync('pkill', ['-f', BACKEND], { stdio: 'ignore' });
  } catch {
    /* nothing to kill is the good case */
  }
  fs.rmSync(dir, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

/* ------------------------------------------------------------------- the scenarios */

try {
  console.log(`\n  router crash — :${port}, config in ${dir}\n`);

  // ------------------------------------------------ 1 & 2: a crash becomes a bead

  const crashed = startRouter('crash');
  running.push(crashed);
  // The one line that says the handlers are armed. Waiting on it rather than on a sleep is
  // what keeps this suite off the flaky list: everything after it is a claim about a router
  // that has already said it is ready to file.
  await waitForLine(crashed, ARMED, 60000);
  check(true, 'the router says out loud which graph its own crashes will land on');
  await waitForLine(crashed, SUPERVISING, 90000);

  crashed.child.kill('SIGUSR2');
  const exit = await Promise.race([crashed.exited, sleep(30000).then(() => null)]);

  check(exit !== null, 'the router exits rather than serving on from a state it cannot vouch for');
  check(exit?.code === 1, 'and exits 1, exactly as node would have without a handler', JSON.stringify(exit));
  check(
    crashed.saw(/uncaughtException — the daemon is going down/),
    'the stack still reaches the log first — the handler must not make the log worse',
    tail(crashed)
  );

  const filed = beadsIn(OWN);
  check(filed.length === 1, 'one bead, for one crash', `${filed.length} bead(s): ${filed.map((b) => b.title).join(' | ')}`);
  check(
    storesWritten().join(',') === OWN,
    'and on this checkout’s own graph, not the first one configured',
    `stores written: ${storesWritten().join(', ') || '(none)'}`
  );
  check(beadsIn(DECOY).length === 0, 'the decoy graph — what `cfg.workspaces[0]` would have been — is untouched');

  const bead = filed[0] || {};
  check(bead.issue_type === 'bug' && Number(bead.priority) === ERROR_PRIORITY, 'a P0 bug', `${bead.issue_type} P${bead.priority}`);
  check((bead.labels || []).includes(ERROR_LABEL), `labelled ${ERROR_LABEL}, like every other reported error`, String(bead.labels));
  check(
    (bead.labels || []).some((l) => l.startsWith(AT_PREFIX)),
    'and fingerprinted by source, so the second one comments instead of filing again',
    String(bead.labels)
  );
  check(
    /a deliberate crash, from test\/helpers\/crashon\.cjs/.test(bead.title || ''),
    'the title is the error, so the inbox says what happened without opening it',
    bead.title
  );
  check(/crashon\.cjs/.test(bead.description || ''), 'the stack is on the bead', String(bead.description).slice(0, 300));
  check(
    /the beadcause router — pid \d+ on :\d+/.test(bead.description || ''),
    'and it says this was the router and not a backend, with the port it was holding',
    String(bead.description).slice(0, 400)
  );

  // ------------------------------------------------ 3: not during its own shutdown

  const restarting = startRouter('shutdown');
  running.push(restarting);
  await waitForLine(restarting, ARMED, 60000);
  await waitForLine(restarting, SUPERVISING, 90000);

  const before = beadsIn(OWN).length;
  /**
   * Both signals back to back, and no retry — bc-1wf9. What was flaky here was the *gap*.
   *
   * A `launchctl kickstart -k` is exactly this: SIGTERM, and then whatever the teardown
   * breaks on its way down. So the crash has to land *during* the shutdown, and a shutdown
   * is far shorter than the 300ms it appears to give itself: that timer is `unref`ed, so
   * once the port is closed and the backends are stopped the loop drains and the router is
   * gone within a few milliseconds. This suite used to send the SIGTERM, wait up to 80ms
   * for the shutdown line, and only then send the SIGUSR2 — and under a full-tree run that
   * wait routinely lost. The crash landed on a router that had already gone: back came the
   * shutdown's own `0`, or a bare `SIGUSR2` when it caught the process mid-teardown with
   * that handler already restored to its default. Three attempts at the same race did not
   * make it likelier, and the log announced "signalled before it was listening", which was
   * the one thing it was not.
   *
   * Sent together there is no gap to lose, and both orderings agree on which arrives
   * first: the kernel delivers the lower-numbered pending signal first (SIGTERM is 15,
   * SIGUSR2 is 31), and libuv dispatches what it queued in the order it was posted. The
   * ordering is then *asserted* below rather than assumed — the shutdown line has to be in
   * the log ahead of the crash — so an inversion fails loudly here instead of quietly
   * filing a bead and failing the count two checks later.
   *
   * The other half of what made this deterministic is in `bin/router.js`: the SIGTERM
   * handler is registered on the line after `listen()` now, so the `ARMED` line above —
   * which the arming logs later still — is proof that a signal will be *handled* rather
   * than killing the process outright.
   */
  restarting.child.kill('SIGTERM');
  restarting.child.kill('SIGUSR2');
  const secondExit = await Promise.race([restarting.exited, sleep(30000).then(() => null)]);

  check(
    secondExit?.code === 1,
    'a router SIGTERMed and then broken on the way down still exits, by its own hand',
    `exit ${JSON.stringify(secondExit)} — a signal means it never ran shutdown at all, a 0 means the crash was too late\n${tail(
      restarting
    )}`
  );
  const shutdownLog = restarting.text();
  check(
    shutdownLog.indexOf('shutting down — stopping backends') >= 0 &&
      shutdownLog.indexOf('shutting down — stopping backends') < shutdownLog.indexOf('uncaughtException — the daemon is going down'),
    'and it was already shutting down when the crash arrived, which is the whole premise',
    tail(restarting)
  );
  check(
    restarting.saw(/not filed \(shutting-down\)/),
    'and refuses to file — for the stated reason, so this is not merely a crash that did not happen',
    `exit ${JSON.stringify(secondExit)}\n${tail(restarting)}`
  );
  check(
    beadsIn(OWN).length === before,
    'no bead: every restart of the service would otherwise file a P0 about a router doing as it was told',
    `${before} → ${beadsIn(OWN).length}`
  );
} catch (err) {
  bad('the run itself', err?.stack || String(err));
}

console.log(`\n  ${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
