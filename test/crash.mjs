#!/usr/bin/env node
/**
 * The daemon's own crash becomes a bead, and filing it can never become the next crash.
 *
 *     npm test
 *     node test/crash.mjs
 *
 * bc-p38c.4. The easy direction — an uncaught exception appears as a P0 with its stack —
 * is one assertion. Everything that can go *wrong* is at the edges, and this file is
 * mostly those:
 *
 * 1. **An uncaught exception** → an open P0 bug carrying the stack, and the process still
 *    exits, because taking over from Node must not quietly turn a crash into a daemon that
 *    keeps serving from a state it cannot vouch for.
 * 2. **A second one** → a comment, not a second bead. The acceptance criterion.
 * 3. **A failure while filing** → no loop. Four ways in: the tracker refusing the create,
 *    an error thrown *out of* the filing path, the same fingerprint arriving while it is
 *    being filed, and the same error arriving forever (the cap).
 * 4. **Shutdown** → nothing files at all, because the router SIGTERMs a backend on every
 *    hot swap and a teardown makes things in flight reject.
 * 5. **A swallowed sweep failure** → filed only when the error is a bug by construction. A
 *    bd lock timeout stays a log line; a `TypeError` becomes a bead.
 * 6. **One bug, two reporters** → a daemon crash in `lib/foo.js:41` and a browser report
 *    from the same line land on the *same* bead. That is the design goal of routing the
 *    daemon through `intake` rather than giving it its own filing, so it is asserted
 *    rather than assumed.
 * 7. **An observer files nothing** — in a child process, because `OBSERVING` is read from
 *    the environment once, at module load.
 *
 * The `bd` is the stub binary test/apperrors.mjs established: a directory of one JSON file
 * per bead, implementing `--label-any`, `--all` and the status filter the way bd does,
 * because the lookup under test *is* those flags. Nothing here reaches a real tracker, and
 * nothing here really exits — `installCrashHandlers` takes the exit as an argument for
 * exactly that reason.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-crash-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const { FILED_LABEL } = await import(LIB('filing.js'));
const { intake, ERROR_LABEL, ERROR_PRIORITY, AT_PREFIX } = await import(LIB('errors.js'));
const {
  installCrashHandlers,
  reportCrash,
  reportSweepFailure,
  beginShutdown,
  isShuttingDown,
  resetCrashState,
  crashStats,
  toReport,
  isBug,
  fromFilingPath,
  PER_ERROR_CAP,
} = await import(LIB('crash.js'));

/* ------------------------------------------------------------------- the stub bd */

const BEADS = path.join(tmp, 'beads');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const DIR = ${JSON.stringify(BEADS)};
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
  if (fs.existsSync(path.join(DIR, '..', 'fail-create'))) die('the tracker said no');
  const slowFile = path.join(DIR, '..', 'slow-create');
  if (fs.existsSync(slowFile)) {
    // A synchronous sleep, because this is a real \`bd\` as far as the code under test is
    // concerned and a real one blocks. A wedged tracker is what the timeout is for — and
    // it dies rather than landing the bead afterwards, so a straggler cannot write into
    // whichever scenario happens to be running by then. It can, and it did.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(slowFile, 'utf8')) || 0);
    die('the tracker never came back');
  }
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

const bdCalls = () =>
  fs.existsSync(BD_LOG)
    ? fs
        .readFileSync(BD_LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const issues = () =>
  fs
    .readdirSync(BEADS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(BEADS, f), 'utf8')))
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
const FAIL_FLAG = path.join(tmp, 'fail-create');
const SLOW_FLAG = path.join(tmp, 'slow-create');

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const ws = { name: 'demo', dir: wsDir };
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
const cfg = { workspaces: [ws], actor: 'beadcause-test' };

/**
 * A fresh process, as far as anything under test can tell — and a fresh *tracker*, which
 * matters more than it looks: the dedupe under test reads the tracker, so a bead left over
 * from the previous scenario would silently turn a "created" into a "commented".
 */
let exits = [];
let uninstall = null;
const arm = ({ failCreate = false, slowCreate = 0, timeoutMs = 0, where = 'the beadcause daemon — active, build test' } = {}) => {
  if (uninstall) uninstall();
  fs.rmSync(BEADS, { recursive: true, force: true });
  fs.mkdirSync(BEADS, { recursive: true });
  fs.rmSync(FAIL_FLAG, { force: true });
  if (failCreate) fs.writeFileSync(FAIL_FLAG, '1');
  fs.rmSync(SLOW_FLAG, { force: true });
  if (slowCreate) fs.writeFileSync(SLOW_FLAG, String(slowCreate));
  fs.rmSync(BD_LOG, { force: true });
  resetCrashState();
  exits = [];
  uninstall = installCrashHandlers(cfg, {
    bd,
    workspace: ws,
    where,
    timeoutMs,
    exit: (code) => exits.push(code),
  });
};

/** An Error whose stack says it came from somewhere real, rather than from this test. */
const thrownAt = (message, file, line, name = 'TypeError') => {
  const err = new Error(message);
  err.name = name;
  err.stack = `${name}: ${message}\n    at tick (/Users/adammorgan/neadamthal.projects/beadcause/${file}:${line}:11)\n    at Timeout._onTimeout (node:internal/timers:583:17)`;
  return err;
};

/**
 * Fire the real handler the way Node fires it, and wait for the filing it starts.
 *
 * `fatal` is deliberately not awaitable — Node hands an uncaught exception to a
 * synchronous listener — so the test waits on the injected exit instead, which is the last
 * thing that path does. A poll rather than a hook, because inventing a hook for the test
 * would mean the thing under test is not the thing that ships.
 */
const crashAndSettle = async (value, event = 'uncaughtException') => {
  const before = exits.length;
  process.emit(event, value);
  for (let i = 0; i < 400 && exits.length === before; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(exits.length > before, `the ${event} handler never reached its exit`);
};

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 12).join('\n       ')}`);
  }
}

console.log('\nthe daemon files its own crashes, and filing them never loops\n');

/* -------------------------------------------------------------- the report shape */

await check('an Error becomes a report whose fingerprint is the throw site', () => {
  const report = toReport(thrownAt('x is not a function', 'lib/advocate.js', 412), {
    kind: 'uncaughtException',
    where: 'the beadcause daemon',
  });
  assert.equal(report.message, 'x is not a function');
  assert.match(report.stack, /lib\/advocate\.js:412/);
  assert.equal(report.kind, 'uncaughtException');
  assert.equal(report.url, 'the beadcause daemon');
  assert.match(report.userAgent, /^node v/);
  assert.ok(report.at, 'a report always carries when it happened');
  assert.equal(report.source, undefined, 'source is left to frameFromStack, so both sides parse alike');
});

await check('a non-Error rejection gets no stack, rather than this file’s', () => {
  for (const value of [undefined, null, 42, { code: 'ENOENT' }, ['a']]) {
    const report = toReport(value, { kind: 'unhandledRejection' });
    assert.equal(report.stack, '', `${JSON.stringify(value ?? String(value))} must not borrow a stack`);
    assert.ok(
      !report.message.includes('crash.js'),
      `a non-Error rejection must not be filed against lib/crash.js — got ${report.message}`
    );
    assert.ok(report.message.length > 0, 'and it still has to say something');
  }
  // A string rejection is the one that carries real information, so it is kept verbatim.
  assert.equal(toReport('the pipe closed').message, 'the pipe closed');
});

await check('an error out of the filing path is recognised by its stack', () => {
  assert.equal(fromFilingPath('Error: x\n    at f (/repo/lib/errors.js:44:1)'), true);
  assert.equal(fromFilingPath('Error: x\n    at f (/repo/lib/filing.js:44:1)'), true);
  assert.equal(fromFilingPath('Error: x\n    at f (/repo/lib/crash.js:44:1)'), true);
  assert.equal(fromFilingPath('Error: x\n    at f (/repo/lib/advocate.js:44:1)'), false);
  assert.equal(fromFilingPath(''), false, 'nothing to go on is not proof it came from us');
});

await check('only errors that are bugs by construction clear the sweep bar', () => {
  assert.equal(isBug(new TypeError('x is not a function')), true);
  assert.equal(isBug(new ReferenceError('y is not defined')), true);
  assert.equal(isBug(new RangeError('Maximum call stack size exceeded')), true);
  assert.equal(isBug(Object.assign(new Error('nope'), { code: 'ERR_ASSERTION' })), true);
  assert.equal(isBug(new Error('spawn bd ENOENT')), false, 'bd not installed is not a beadcause bug');
  assert.equal(isBug(new Error('bd exited 1: database is locked')), false);
  assert.equal(isBug(new SyntaxError('Unexpected token }')), false, 'a sweep parsing somebody else’s output');
  assert.equal(isBug(null), false);
  assert.equal(isBug('a string'), false);
});

/* ------------------------------------------------- the acceptance criteria, in order */

await check('an uncaught exception becomes an open P0 bug carrying its stack', async () => {
  arm();
  await crashAndSettle(thrownAt("Cannot read properties of undefined (reading 'queue')", 'lib/advocate.js', 1042));

  const all = issues();
  assert.equal(all.length, 1, `one bead, got ${all.length}`);
  const [b] = all;
  assert.equal(b.priority, ERROR_PRIORITY, 'a crash is P0 — the floor is lowered for this path alone');
  assert.equal(b.priority, 0);
  assert.equal(b.issue_type, 'bug');
  assert.equal(b.status, 'open');
  assert.ok(b.labels.includes(ERROR_LABEL), `labelled ${ERROR_LABEL}, got ${b.labels.join(', ')}`);
  assert.ok(
    b.labels.some((l) => l.startsWith(AT_PREFIX)),
    'and fingerprinted on the throw site, so the next one can find it'
  );
  assert.ok(b.labels.includes(FILED_LABEL), 'the provenance stamp stays on — bd list --label agent-filed is the audit');
  assert.ok(!b.labels.includes(UNENDORSED), 'a crash is not a judgement waiting on a tap');
  assert.match(b.description, /lib\/advocate\.js:1042/, 'the stack is on the bead');
  assert.match(b.description, /uncaughtException/, 'and which side of the app noticed it');
  assert.match(b.description, /the beadcause daemon/, 'and which process');
  assert.match(b.title, /reading 'queue'/, 'the title leads with the symptom');
});

await check('the daemon still exits 1 — taking over from Node must not swallow the crash', async () => {
  arm();
  await crashAndSettle(thrownAt('boom', 'lib/server.js', 12));
  assert.deepEqual(exits, [1], 'exactly one exit, with Node’s own code for an uncaught exception');
});

await check('an unhandled rejection is treated exactly the same', async () => {
  arm();
  await crashAndSettle(thrownAt('the poll fell over', 'lib/server.js', 5100), 'unhandledRejection');
  const all = issues();
  assert.equal(all.length, 1);
  assert.match(all[0].description, /unhandledRejection/);
  assert.deepEqual(exits, [1], 'since Node 15 its default is an uncaught exception, so exiting is no new severity');
});

await check('a second occurrence comments, and files no second bead', async () => {
  arm();
  const err = () => thrownAt('advocate tick fell over', 'lib/advocate.js', 1042);
  await crashAndSettle(err());
  await crashAndSettle(err());

  const all = issues();
  assert.equal(all.length, 1, `still one bead, got ${all.length}: ${all.map((b) => b.id).join(', ')}`);
  assert.equal(all[0].comments.length, 1, `one comment for the second occurrence, got ${all[0].comments.length}`);
  assert.match(all[0].comments[0], /lib\/advocate\.js:1042/, 'the comment says where it happened again');
  assert.equal(bdCalls().filter((c) => c[0] === 'create').length, 1, 'and only one create was ever attempted');
});

/* --------------------------------------------------- a failure while filing must not loop */

await check('the tracker refusing the create does not become a second report', async () => {
  arm({ failCreate: true });
  await crashAndSettle(thrownAt('boom', 'lib/server.js', 99));

  assert.equal(issues().length, 0, 'nothing was filed, which is the point of the fixture');
  assert.equal(bdCalls().filter((c) => c[0] === 'create').length, 1, 'and it was attempted once, not in a loop');
  assert.deepEqual(exits, [1], 'the daemon still went down — filing is not allowed to hold it up forever');
  assert.equal(crashStats().filing, 0, 'and nothing is left in flight');
});

await check('a process that cannot afford ten seconds files on its own clock instead', async () => {
  // bc-ega4. `FILE_TIMEOUT_MS` bounds a dying *backend*, which costs nothing — the router
  // replaces it. bin/router.js is holding port 4318 while it waits, so it arms itself with
  // half of it, and an option nothing honoured would look identical from the outside: the
  // filing would land, the suite would pass, and the router would sit on the port for ten
  // seconds the day a `bd` wedged. So the clock is asserted, not the constant.
  arm({ slowCreate: 400, timeoutMs: 60 });
  const started = Date.now();
  const out = await reportCrash(thrownAt('slow tracker', 'lib/server.js', 12));
  const took = Date.now() - started;

  assert.equal(out.filed, false, 'it gave up rather than waiting the tracker out');
  assert.equal(out.why, 'filing-failed');
  assert.match(String(out.detail), /longer than 60ms/, `gave up on the wrong clock: ${out.detail}`);
  assert.ok(took < 350, `waited ${took}ms — the timeout was not the one this process asked for`);
  assert.equal(crashStats().filing, 0, 'and nothing is left in flight to block the next report');
  // Outlive the wedged `bd` before handing the fixture to the next scenario, so that what
  // it did after we stopped waiting is asserted here rather than discovered somewhere else.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(issues().length, 0, 'and the tracker it gave up on left nothing behind');
});

await check('with no timeout asked for, it is still the ten seconds every other caller gets', async () => {
  arm();
  await crashAndSettle(thrownAt('ordinary', 'lib/server.js', 13));
  assert.equal(issues().length, 1, 'the default path is unchanged — the option is an override, not a requirement');
});

await check('an error thrown out of the filing path is never filed', async () => {
  arm();
  const out = await reportCrash(thrownAt('bd created the bead but returned no id', 'lib/errors.js', 388, 'Error'));
  assert.equal(out.filed, false);
  assert.equal(out.why, 'from-the-filing-path');
  assert.equal(bdCalls().length, 0, 'the filer’s own failure never reaches the filer');
});

await check('the same fingerprint arriving while it is being filed is refused once', async () => {
  arm();
  const err = () => thrownAt('same bug, twice at once', 'lib/work.js', 7);
  const [first, second] = await Promise.all([reportCrash(err()), reportCrash(err())]);
  assert.equal(first.filed, true, 'the first files');
  assert.equal(second.filed, false);
  assert.equal(second.why, 'already-filing');
  assert.equal(issues().length, 1);
});

await check('a different error arriving at the same moment is NOT refused', async () => {
  arm();
  const [a, b] = await Promise.all([
    reportCrash(thrownAt('one thing broke', 'lib/a.js', 1)),
    reportCrash(thrownAt('a different thing broke', 'lib/b.js', 2)),
  ]);
  assert.equal(a.filed, true);
  assert.equal(b.filed, true, 'two sweeps failing in one tick is not recursion — a global flag would have lost this');
  assert.equal(issues().length, 2);
});

await check('the same error forever stops at the cap', async () => {
  arm();
  const err = () => thrownAt('this happens on every tick', 'lib/release.js', 88);
  const outcomes = [];
  for (let i = 0; i < PER_ERROR_CAP + 3; i++) outcomes.push(await reportCrash(err()));

  assert.equal(outcomes.filter((o) => o.filed).length, PER_ERROR_CAP, `${PER_ERROR_CAP} filed, then no more`);
  assert.deepEqual(
    outcomes.slice(PER_ERROR_CAP).map((o) => o.why),
    ['per-error-cap', 'per-error-cap', 'per-error-cap'],
    'and it says which guard stopped it'
  );
  assert.equal(issues().length, 1, 'still one bead');
  // One comment rather than `PER_ERROR_CAP - 1` of them: the first repeat is written and
  // opens a coalescing window, and the occurrences inside it are counted rather than
  // commented (bc-5f9b, lib/errors.js). This cap is the guard in front of that one, and
  // it is the reason a *daemon* in a loop was never the worst case here.
  assert.equal(issues()[0].comments.length, 1, 'with a bounded number of occurrence comments');
  assert.deepEqual(
    outcomes.slice(0, PER_ERROR_CAP).map((o) => o.action),
    ['created', 'commented', ...Array(PER_ERROR_CAP - 2).fill('coalesced')],
    'one bead, one comment, and a count for the rest'
  );
});

/* ------------------------------------------------------------------- shutdown */

await check('nothing files once the daemon has begun going down', async () => {
  arm();
  assert.equal(isShuttingDown(), false);
  beginShutdown();
  assert.equal(isShuttingDown(), true);

  const out = await reportCrash(thrownAt('server closed under an in-flight poll', 'lib/tls.js', 40));
  assert.equal(out.filed, false);
  assert.equal(out.why, 'shutting-down');
  assert.equal(bdCalls().length, 0, 'the router SIGTERMs a backend on every hot swap — this must file on none of them');

  const sweep = await reportSweepFailure('the advocate tick', new TypeError('torn down mid-tick'));
  assert.equal(sweep.filed, false);
  assert.equal(sweep.why, 'shutting-down');
  resetCrashState();
});

await check('a crash during shutdown still exits, and still says so in the log', async () => {
  arm();
  beginShutdown();
  await crashAndSettle(thrownAt('boom on the way out', 'lib/terminal.js', 3));
  assert.deepEqual(exits, [1], 'not filing is not the same as not handling');
  assert.equal(issues().length, 0);
  resetCrashState();
});

/* --------------------------------------- the sweeps the daemon already swallowed */

await check('a swallowed sweep failure that is a bug becomes a bead naming the sweep', async () => {
  arm();
  const out = await reportSweepFailure('the advocate tick', thrownAt('a.queue is not iterable', 'lib/advocate.js', 1930));
  assert.equal(out.filed, true);
  assert.equal(out.action, 'created');
  const [b] = issues();
  assert.equal(b.priority, 0);
  assert.match(b.description, /daemon sweep — the advocate tick/, 'the bead says which sweep, so it can be found again');
  assert.match(b.description, /lib\/advocate\.js:1930/);
});

await check('a swallowed sweep failure that is operational stays a log line', async () => {
  arm();
  for (const err of [new Error('bd exited 1: database is locked'), new Error('spawn gh ENOENT')]) {
    const out = await reportSweepFailure('the release sweep', err);
    assert.equal(out.filed, false, `${err.message} must not be a P0`);
    assert.equal(out.why, 'not-a-bug');
  }
  assert.equal(bdCalls().length, 0, 'and the tracker was never asked');
  assert.equal(issues().length, 0);
});

/* ------------------------------------------------- one bug, whichever side noticed it */

await check('a daemon crash and a browser report from the same line are one bead', async () => {
  arm();
  // The daemon notices it first, from an absolute path inside a worktree.
  const err = new TypeError("Cannot read properties of null (reading 'title')");
  err.stack =
    "TypeError: Cannot read properties of null (reading 'title')\n" +
    '    at render (/Users/adammorgan/neadamthal.projects/beadcause/.claude/worktrees/x-1/lib/graph.js:41:19)';
  const first = await reportCrash(err, { kind: 'uncaughtException' });
  assert.equal(first.action, 'created');

  // Then the phone hits the same bug, spelling the same file the way a browser spells it.
  const second = await intake(bd, ws, {
    message: "Cannot read properties of null (reading 'title')",
    source: 'https://mac.tail1234.ts.net:4318/lib/graph.js?v=27',
    line: 41,
    url: 'https://mac.tail1234.ts.net:4318/#bc-p38c',
    kind: 'error',
  });

  assert.equal(second.action, 'commented', 'a browser report of the same bug must not file a second bead');
  assert.equal(second.id, first.id, `both landed on ${first.id}`);
  assert.equal(issues().length, 1, 'one bug, one bead, two reporters');
});

/* ---------------------------------------------------------------- observer mode */

await check('an observer instance files nothing, because every autonomous act is off', () => {
  // A child process, because OBSERVING is read from the environment once, at module load.
  const script = `
    const { reportCrash, installCrashHandlers } = await import(${JSON.stringify(LIB('crash.js'))});
    installCrashHandlers({}, {
      bd: { json: async () => { throw new Error('an observer must never reach bd'); } },
      workspace: { name: 'demo' },
    });
    const out = await reportCrash(new TypeError('boom'));
    process.stdout.write(JSON.stringify({ filed: out.filed, why: out.why }));
  `;
  const raw = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    env: { ...process.env, BEADCAUSE_OBSERVE: '1', BEADCAUSE_CONFIG_DIR: path.join(tmp, 'observer-config') },
  });
  assert.deepEqual(JSON.parse(raw), { filed: false, why: 'observing' });
});

/* ------------------------------------------------------------------ and the wiring */

await check('bin/beadcause.js arms the handlers and disarms them on the way down', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'bin', 'beadcause.js'), 'utf8');
  assert.match(src, /installCrashHandlers\(cfg, \{/, 'the daemon installs them');
  assert.match(src, /workspace: ownWs/, 'onto the graph of this checkout, not cfg.workspaces[0]');
  assert.ok(
    /const shutdown = \(\) => \{[\s\S]{0,600}?beginShutdown\(\)/.test(src),
    'and shutdown() calls beginShutdown() before it closes anything'
  );
  // The install has to be able to see `role` and `build`, or `where` throws on every crash.
  assert.ok(
    src.indexOf('let role =') < src.indexOf('installCrashHandlers('),
    'and it is armed after the process identity it names on the bead'
  );
  // …and before the first things in this file that can throw, or their crashes are unfiled.
  assert.ok(
    src.indexOf('installCrashHandlers(') < src.indexOf('startPoller(cfg, app)'),
    'and before the poller and the Slack socket start'
  );
});

await check('bin/router.js arms them too — after the port is held, and never at import time', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'bin', 'router.js'), 'utf8');
  assert.match(src, /installCrashHandlers\(cfg, \{/, 'the router installs them');
  assert.ok(
    /const shutdown = \(\) => \{[\s\S]{0,600}?crash\?\.beginShutdown\(\)/.test(src),
    'and shutdown() says so before it closes anything — a kickstart is a SIGTERM'
  );
  // The whole of bc-ega4's risk, and the only part of it a diff can undo by accident.
  // A *static* import of lib/crash.js or lib/deploy.js would put five to thirteen modules
  // of app in front of the one process that must always be able to bind 4318 — lib/deploy.js
  // reaches lib/session.js, which reaches most of the roster and the foundations.
  // Loading them after listen() means the worst a broken module can do is cost the beads.
  const statics = [...src.matchAll(/^import[\s\S]*?from '(\.\.\/lib\/[a-z]+\.js)';$/gm)].map((m) => m[1]);
  for (const forbidden of ['../lib/crash.js', '../lib/deploy.js', '../lib/bd.js']) {
    assert.ok(!statics.includes(forbidden), `${forbidden} must be imported lazily, not at the top of bin/router.js`);
  }
  assert.ok(
    src.indexOf('const servers = listen();') < src.indexOf('await armCrashHandlers();'),
    'and armed after listen(), so a failure to arm can never cost the port'
  );
});

await check('every swallowed failure in the poll cycle reports', () => {
  const src = fs.readFileSync(LIB('server.js'), 'utf8');
  const named = [...src.matchAll(/sweepFailed\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    named.sort(),
    [
      // Sorted, and a capital letter sorts before every lower-case one — lib/jirapoll.js.
      // Its `sweep` records each JIRA failure against the workspace it belongs to and
      // returns rather than throwing, so what reaches this catch is the cycle's own
      // bookkeeping: the same bar `the tracker sync` below is held to.
      'the JIRA poll',
      // lib/adoptsweep.js. It lands every refusal and every rejected write in its answer
      // rather than throwing, so what reaches this catch is the cycle's own bookkeeping.
      'the adoption sweep',
      'the advocate tick',
      // The beat's own guard. Everything inside the cycle already catches; what reaches
      // this one is the cycle's bookkeeping failing, which is a bug by construction —
      // and an unhandled rejection out of a `setInterval` callback would take the
      // daemon with it.
      // lib/mergesweep.js. Same bar again: `sweepMerged` takes its records before it
      // acts on them and lands every sweep's failure in an outcome, so a rejection out
      // of it is the drain's own bookkeeping rather than a `gh` that blinked.
      'the conflict sweep',
      'the cycle',
      'the deploy sweep',
      'the owed-close sweep',
      'the poll',
      'the release sweep',
      'the reply push',
      // lib/sync.js. `syncOnce` swallows every tracker failure into an outcome of its
      // own, so anything reaching this catch is a bug by construction — which is
      // precisely the bar `reportSweepFailure` sets.
      'the tracker sync',
    ],
    `every catch in the cycle reports, got ${named.join(', ')}`
  );
  // A `return console.error(...)` would have made the poll's report unreachable.
  assert.ok(!/return console\.error\('\[beadcause\] poll failed/.test(src), 'the poll failure is reported, then returns');
});

if (uninstall) uninstall();
await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
