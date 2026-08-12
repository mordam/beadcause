#!/usr/bin/env node
/**
 * A deploy that restarts the daemon files no error beads — and neither does the reconnect.
 *
 *     npm test
 *     node test/deployquiet.mjs
 *
 * bc-p38c.3. Pressing Ship SIGKILLs this daemon, every open page fails every fetch at
 * once, and without a quiet window each of those is a P0 in front of the advocate — four
 * screens' worth of beads for the single fact that you pressed a button. The counting is
 * the easy half to reason about and the *timing* is where this goes wrong, so three
 * layers are asserted here rather than one:
 *
 * 1. **`reportingQuiet` in lib/deploy.js** — the rule itself, against hand-written
 *    records, including the two states nobody guesses: a `deploying` record with no
 *    runner behind it (which is what a restart looks like from the process that came
 *    back, and *is* the storm), and one so old that going on trusting it would mean this
 *    Mac never reported an error again. And its *other* source, added by bc-kttd: the
 *    marker bin/router.js leaves on every handover, which is the only evidence a
 *    blue/green swap ever happened — `npm run swap` writes nothing into the journal, so
 *    without it the ship skill's own restart filed the exact storm this file is about.
 * 2. **`POST /api/error`** — the acceptance criterion, through the real route with a real
 *    stub tracker behind it: nothing is created while the window is open, and an error
 *    after it files normally. `bd create` is asserted to have been *unreached*, not
 *    merely to have produced no bead, because "the daemon quietly filed it and the
 *    response said no" is a passing test and a ruined tracker.
 * 3. **`public/report.js`** — in a `vm` with a hand-made `window`, the shape
 *    test/reporter.mjs established. It is handed the *real body the real route answered*
 *    rather than a fixture, because the payload between the two halves is a bare JSON
 *    object with no schema anywhere: a rename of `quiet.until` on either side would leave
 *    both halves green and the page reporting straight through the next deploy.
 *
 * The window in that last check is made short by *aging a real record* — a deploy that
 * settled a quarter of a second before the grace period runs out — so the resumption is
 * the code's own arithmetic and not a number this file made up.
 *
 * Nothing here spawns a deploy, touches the network beyond loopback, or writes outside a
 * temp directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-quiet-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { reportingQuiet, markRestart, REPORT_GRACE_MS, DEPLOY_DIR, RESTART_PATH } = await import(LIB('deploy.js'));
const { createApp, listen } = await import(LIB('server.js'));

/* ------------------------------------------------------------------- harness */

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
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

/* ------------------------------------------------------------------ the journal */

fs.mkdirSync(DEPLOY_DIR, { recursive: true });

/**
 * A pid that is not there.
 *
 * macOS caps pids at 99999, so nothing can be running under this — which matters because
 * `running()` reads a live pid as a deploy in flight, and a suite that accidentally named
 * a real process would be asserting the opposite of what it says.
 */
const DEAD_PID = 999999;

const ago = (ms) => new Date(Date.now() - ms).toISOString();

let seq = 0;
/** One record on disk, in the shape `startDeploy` writes and the runner then owns. */
function record(fields) {
  seq += 1;
  const rec = {
    id: `d-test-${seq}`,
    workspace: 'beadcause',
    dir: ROOT,
    base: 'main',
    restarts: true,
    requestedAt: ago(2000),
    status: 'deploying',
    steps: [],
    ...fields,
  };
  fs.writeFileSync(path.join(DEPLOY_DIR, `${rec.id}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

const clearJournal = () => {
  for (const name of fs.readdirSync(DEPLOY_DIR)) fs.rmSync(path.join(DEPLOY_DIR, name), { force: true });
  // The router's restart marker is the quiet window's *other* source and lives outside
  // the journal on purpose (bc-kttd), so clearing one without the other would leave
  // every check below asserting against whatever the previous one wrote.
  fs.rmSync(RESTART_PATH, { force: true });
};

/* ----------------------------------------------------------------- the rule */

console.log('when reporting is held off');

await check('an empty journal holds nothing off', () => {
  clearJournal();
  assert.equal(reportingQuiet(), null);
});

await check('a deploy in flight holds it off, and says which one', () => {
  clearJournal();
  // A live pid is what `running()` reads, so this process stands in for the runner.
  const rec = record({ pid: process.pid, status: 'building' });
  const quiet = reportingQuiet();
  assert.ok(quiet, 'a deploy is running and reporting was not held off');
  assert.equal(quiet.id, rec.id);
  assert.match(quiet.why, /in flight/);
  // A floor, not a promise: nobody knows when a running deploy ends, so the page is
  // hushed for one grace period and comes back to ask again.
  const until = Date.parse(quiet.until);
  assert.ok(until > Date.now(), 'the window is already over');
  assert.ok(until <= Date.now() + REPORT_GRACE_MS + 1000, `${quiet.until} is further off than one grace period`);
});

await check('a `deploying` record whose runner is gone holds it off — this is the storm', () => {
  clearJournal();
  // The normal ending of a restart: launchd took the runner along with the daemon, and
  // the process that came back is the one being asked to file the reconnect's errors.
  record({ pid: DEAD_PID, status: 'deploying' });
  const quiet = reportingQuiet();
  assert.ok(quiet, 'the reconnect after a restart was not held off');
  assert.match(quiet.why, /restarted this daemon/);
});

await check('a deploy that just finished still holds it off, for the reconnect', () => {
  clearJournal();
  record({ pid: DEAD_PID, status: 'unconfirmed', requestedAt: ago(60000), finishedAt: ago(1000) });
  const quiet = reportingQuiet();
  assert.ok(quiet, 'the pages reconnecting were not held off');
  assert.match(quiet.why, /finished 1s ago/);
  // The window ends a grace period after the deploy did, not after this question.
  assert.ok(Date.parse(quiet.until) <= Date.now() + REPORT_GRACE_MS - 500);
});

await check('a deploy that finished long enough ago holds nothing off', () => {
  clearJournal();
  record({ pid: DEAD_PID, status: 'ok', requestedAt: ago(600000), finishedAt: ago(REPORT_GRACE_MS + 5000) });
  assert.equal(reportingQuiet(), null, 'an error after the grace period must file');
});

await check('a stale `deploying` record does not silence this Mac forever', () => {
  clearJournal();
  // A runner that vanished and a sweep that never ran. Past the ceiling the honest
  // failure direction is to file again: a false P0 is a bead you close, and silence is
  // a bug nobody ever hears about.
  record({ pid: DEAD_PID, status: 'deploying', requestedAt: ago(21 * 60 * 1000) });
  assert.equal(reportingQuiet(), null);
});

await check("a deploy that does not restart beadcause holds nothing off", () => {
  clearJournal();
  // `fly deploy` for sophab takes nothing down that a phone was talking to, and it is
  // no reason to stop hearing that this app is broken.
  record({ workspace: 'sophab', restarts: false, pid: process.pid, status: 'deploying' });
  assert.equal(reportingQuiet(), null);
});

await check('the newest deploy is the one that answers', () => {
  clearJournal();
  record({ pid: DEAD_PID, status: 'ok', requestedAt: ago(600000), finishedAt: ago(590000) });
  const live = record({ pid: process.pid, status: 'deploying', requestedAt: ago(1000) });
  assert.equal(reportingQuiet()?.id, live.id);
});

/* ------------------------------------------------- a swap, which is no deploy */

console.log('\nand a blue/green swap, which writes no deploy record at all');

await check('a handover the router just made holds reporting off', () => {
  clearJournal();
  // What bin/router.js leaves on every `bringUp` — a hand-run `npm run swap`, and the
  // automatic one it does the moment lib/ moves. Nothing goes in the deploy journal.
  markRestart({ build: 'b12345', pid: DEAD_PID, reason: 'asked for by hand' });
  const quiet = reportingQuiet();
  assert.ok(quiet, 'the reconnect after a swap was not held off — this is bc-kttd');
  assert.equal(quiet.status, 'restarted');
  assert.equal(quiet.id, null, 'a swap is not a deploy and must not claim to be one');
  assert.match(quiet.why, /replaced/);
  assert.match(quiet.why, /b12345/, 'the build that took over is the useful half of the reason');
  assert.match(quiet.why, /asked for by hand/);
  const until = Date.parse(quiet.until);
  assert.ok(until > Date.now(), 'the window is already over');
  assert.ok(until <= Date.now() + REPORT_GRACE_MS + 1000, `${quiet.until} is further off than one grace period`);
});

await check('the window runs from the handover, not from the question', () => {
  clearJournal();
  // A swap has already happened by the time it is written down, unlike a deploy in
  // flight — so this is a real end and not a floor that is asked for again.
  markRestart({ build: 'b12345', at: ago(REPORT_GRACE_MS - 1500) });
  const quiet = reportingQuiet();
  assert.ok(quiet, 'a swap a second and a half ago was not held off');
  assert.ok(Date.parse(quiet.until) <= Date.now() + 2000, `${quiet.until} was measured from now`);
});

await check('a swap long enough ago holds nothing off', () => {
  clearJournal();
  markRestart({ build: 'b12345', at: ago(REPORT_GRACE_MS + 5000) });
  assert.equal(reportingQuiet(), null, 'an error after the grace period must file');
});

await check('a marker with no ceiling still expires: nothing cleans this file up', () => {
  clearJournal();
  // The point of a bare timestamp. Nobody sweeps this the way `sweepDeploys` settles a
  // record, so a swap from last Tuesday must go quiet on arithmetic alone.
  markRestart({ build: 'b12345', at: ago(9 * 86400000) });
  assert.equal(reportingQuiet(), null);
});

await check('a marker from the future is no restart', () => {
  clearJournal();
  // A clock stepped backwards, or a config directory copied off another machine. The
  // honest failure direction here is the one the stale-record ceiling chose: file.
  markRestart({ build: 'b12345', at: new Date(Date.now() + 3600000).toISOString() });
  assert.equal(reportingQuiet(), null);
});

await check('a garbled marker is no restart', () => {
  for (const junk of ['{"at":"soon"}', '{"at":null}', '{}', 'not json at all', '[]']) {
    clearJournal();
    fs.writeFileSync(RESTART_PATH, junk);
    assert.equal(reportingQuiet(), null, `${junk} hushed this Mac`);
  }
});

await check('the deploy journal answers ahead of the marker, because it can say which deploy', () => {
  clearJournal();
  const rec = record({ pid: DEAD_PID, status: 'deploying' });
  markRestart({ build: 'b12345', reason: 'the swap the deploy itself caused' });
  // A deploy that restarts this daemon produces both — the journal record and, when the
  // router brings the new build up, a marker. One answer, and the informative one.
  const quiet = reportingQuiet();
  assert.equal(quiet?.id, rec.id, 'the swap marker shadowed the deploy that caused it');
});

/* ------------------------------------------------------------- the endpoint */

console.log('\nwhat POST /api/error does about it');

/** A `bd` that answers from a directory of beads and logs every call it is handed. */
const BEADS = path.join(tmp, 'beads');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const BD = path.join(tmp, 'bd.cjs');
fs.mkdirSync(BEADS, { recursive: true });
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const DIR = ${JSON.stringify(BEADS)};
const read = (id) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8')); } catch { return null; } };
const all = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => read(path.basename(f, '.json'))).filter(Boolean);
const one = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
if (args[0] === 'list') {
  const any = many('--label-any');
  let rows = all();
  if (!args.includes('--all')) rows = rows.filter((i) => i.status !== 'closed');
  if (any.length) rows = rows.filter((i) => any.some((l) => (i.labels || []).includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'create') {
  let id = null;
  for (let n = 1; n < 500 && !id; n++) {
    try { fs.writeFileSync(path.join(DIR, 'zz-' + n + '.json'), '{}', { flag: 'wx' }); id = 'zz-' + n; } catch { /* taken */ }
  }
  fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify({
    id, title: one('--title') || '', status: 'open', labels: many('--label'), comment_count: 0,
  }, null, 2));
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const created = () => bdCalls().filter((c) => c[0] === 'create');
const beads = () => fs.readdirSync(BEADS).filter((f) => f.endsWith('.json'));
const resetTracker = () => {
  fs.rmSync(BEADS, { recursive: true, force: true });
  fs.mkdirSync(BEADS, { recursive: true });
  fs.rmSync(BD_LOG, { force: true });
};

const WS = { name: 'beadcause', dir: path.join(tmp, 'ws', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'test-token',
  bdBin: BD,
  actor: 'beadcause-test',
  workspaces: [WS],
  spaces: [],
  claudeSessionsDir: path.join(tmp, 'sessions'),
  advocates: { enabled: false, workspaces: [] },
  openSessions: false,
  agents: [],
  ntfy: {},
};
fs.mkdirSync(cfg.claudeSessionsDir, { recursive: true });

const servers = listen(cfg, createApp(cfg).handler);
const PORT = await boundPort(servers);

/** One report, exactly as public/report.js posts one. */
async function postReport(message, extra = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/error`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
    body: JSON.stringify({ kind: 'fetch', message, source: '/api/poll', url: '/', ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

await check('the acceptance criterion: a restart files no beads, from any page', async () => {
  clearJournal();
  resetTracker();
  record({ pid: DEAD_PID, status: 'deploying' });

  // Four screens, the reconnect after the daemon came back, every endpoint at once.
  const storm = await Promise.all(
    ['/api/poll', '/api/questions', '/api/prs', '/api/sessions'].flatMap((p) =>
      ['/', '/console', '/prs', '/monitor'].map((page) => postReport(`GET ${p} failed — Failed to fetch`, { url: page, source: p }))
    )
  );
  assert.equal(storm.length, 16);
  for (const { status, body } of storm) {
    assert.equal(status, 200, 'never a 5xx: this endpoint is called by error handling');
    assert.equal(body.ok, false);
    assert.match(body.reason, /deploy/);
    assert.ok(body.quiet?.until, 'the page was not told when it may report again');
  }
  // Unreached, not merely unproductive: a daemon that filed and then said it had not is
  // a passing test and a ruined tracker.
  assert.deepEqual(created(), [], `bd create was reached: ${JSON.stringify(created())}`);
  assert.deepEqual(beads(), []);
});

await check('an error after the grace period files normally', async () => {
  clearJournal();
  resetTracker();
  record({ pid: DEAD_PID, status: 'unconfirmed', requestedAt: ago(600000), finishedAt: ago(REPORT_GRACE_MS + 5000) });

  const { status, body } = await postReport('GET /api/poll failed — Failed to fetch');
  assert.equal(status, 200);
  assert.equal(body.ok, true, `the report was refused: ${JSON.stringify(body)}`);
  assert.equal(body.action, 'created');
  assert.equal(created().length, 1);
});

await check('bc-kttd’s acceptance: a hand-run swap files no beads either', async () => {
  clearJournal();
  resetTracker();
  // No deploy record anywhere — this is `npm run swap` at a terminal, which is what the
  // ship skill runs and what the router-poisoning path runs. Before bc-kttd every one of
  // these sixteen was a P0.
  markRestart({ build: 'b12345', pid: DEAD_PID, reason: 'asked for by hand' });

  const storm = await Promise.all(
    ['/api/poll', '/api/questions', '/api/prs', '/api/sessions'].flatMap((p) =>
      ['/', '/console', '/prs', '/monitor'].map((page) => postReport(`GET ${p} failed — HTTP 503`, { url: page, source: p }))
    )
  );
  assert.equal(storm.length, 16);
  for (const { status, body } of storm) {
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.match(body.reason, /replaced/);
    assert.ok(body.quiet?.until, 'the page was not told when it may report again');
  }
  assert.deepEqual(created(), [], `bd create was reached: ${JSON.stringify(created())}`);
  assert.deepEqual(beads(), []);
});

await check('and an error after that swap files normally', async () => {
  clearJournal();
  resetTracker();
  markRestart({ build: 'b12345', at: ago(REPORT_GRACE_MS + 5000) });

  const { status, body } = await postReport('GET /api/poll failed — HTTP 503');
  assert.equal(status, 200);
  assert.equal(body.ok, true, `the report was refused: ${JSON.stringify(body)}`);
  assert.equal(body.action, 'created');
  assert.equal(created().length, 1);
});

await check('a daemon with no deploy journal at all files normally', async () => {
  // A fresh Mac, or a config directory nobody has deployed from. `listDeploys` answering
  // `[]` for a missing directory is what makes this the same code path as every other.
  clearJournal();
  fs.rmSync(DEPLOY_DIR, { recursive: true, force: true });
  resetTracker();
  const { body } = await postReport('Cannot read properties of undefined (reading id)', { kind: 'error', source: '/app.js', line: 12 });
  assert.equal(body.ok, true, JSON.stringify(body));
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
});

/* --------------------------------------------------------------- the page */

console.log('\nwhat the page does with the answer');

const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'report.js'), 'utf8');

/**
 * The real reporter, in a room with nothing in it — test/reporter.mjs's harness, cut to
 * what this file needs. `respond` answers the report's own request, which is the whole
 * conversation under test here.
 */
function loadReporter(respond) {
  const listeners = new Map();
  const calls = [];
  const window = {
    location: { href: 'http://127.0.0.1:4317/', pathname: '/', origin: 'http://127.0.0.1:4317' },
    navigator: { userAgent: 'test-agent/1' },
    localStorage: { getItem: () => null },
    addEventListener: (type, fn) => listeners.set(type, fn),
    fetch: (input, init) => {
      calls.push({ input, init });
      return respond(input, init);
    },
  };
  const ctx = vm.createContext({ window, URL, setTimeout, clearTimeout, console });
  vm.runInContext(SOURCE, ctx, { filename: 'report.js' });
  return {
    fire: (type, event) => listeners.get(type)(event),
    reports: () => calls.filter((c) => c.input === '/api/error'),
    api: ctx.window.beadcause.report,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

await check('the daemon’s own answer makes the page stop reporting, and then resume', async () => {
  clearJournal();
  resetTracker();
  // A deploy that settled a second and a bit before the grace period runs out, so the
  // window the route hands over is short — and it is the code's arithmetic, not a number
  // this file invented.
  record({ pid: DEAD_PID, status: 'unconfirmed', requestedAt: ago(600000), finishedAt: ago(REPORT_GRACE_MS - 1200) });

  const refusal = (await postReport('GET /api/poll failed — Failed to fetch')).body;
  assert.equal(refusal.ok, false, 'the fixture is wrong: the route did not refuse');
  const until = Date.parse(refusal.quiet.until);
  assert.ok(until > Date.now() && until < Date.now() + 3000, `the window is ${until - Date.now()}ms wide`);

  const app = loadReporter(() => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(refusal) }));
  app.fire('error', { message: 'GET /api/poll failed — Failed to fetch', filename: '/app.js', lineno: 1 });
  assert.equal(app.reports().length, 1, 'the first report is what carries the question');
  await settle();
  assert.equal(app.api.quietUntil(), until, 'the page did not read the answer the daemon gave it');

  // Everything the reconnect throws at it, from here, costs nothing and goes nowhere.
  for (let i = 0; i < 12; i += 1) {
    app.fire('error', { message: `a distinct failure ${i}`, filename: '/app.js', lineno: 100 + i });
  }
  assert.equal(app.reports().length, 1, 'the page kept reporting through a deploy');
  // And the refusals did not spend the per-minute cap: the first real error after the
  // window must not find the page out of room. One was spent by the report above.
  assert.equal(app.api.capacity(), 7, 'a hushed report burned the cap');

  await new Promise((r) => setTimeout(r, Math.max(0, until - Date.now()) + 30));
  app.fire('error', { message: 'a real bug, after the deploy', filename: '/app.js', lineno: 42 });
  assert.equal(app.reports().length, 2, 'the page never started reporting again');
});

await check('an ordinary answer leaves the page reporting', async () => {
  // The `{ok: true}` case, and the shapes that carry no answer at all: a response with no
  // `json` (a keepalive beacon, an interposing proxy) and a body that is not JSON. None
  // of them may look like a deploy.
  for (const respond of [
    () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ ok: true, action: 'created', id: 'zz-1' }) }),
    () => Promise.resolve({ status: 200, ok: true }),
    () => Promise.resolve({ status: 200, ok: true, json: () => Promise.reject(new Error('not JSON')) }),
    () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ ok: false, reason: 'bd is locked' }) }),
  ]) {
    const app = loadReporter(respond);
    app.fire('error', { message: 'the first bug', filename: '/app.js', lineno: 1 });
    await settle();
    assert.equal(app.api.quietUntil(), 0, 'the page hushed itself over an ordinary answer');
    app.fire('error', { message: 'the second bug', filename: '/app.js', lineno: 2 });
    assert.equal(app.reports().length, 2);
  }
});

await check('a daemon cannot hush a page for a fortnight', async () => {
  // The `until` is a wall clock from another machine arriving over a wire, and the
  // failure it could cause is the worst one available: a page that has quietly stopped
  // reporting anything and looks exactly like a page with no errors.
  const forever = { ok: false, reason: 'a deploy', quiet: { until: new Date(Date.now() + 14 * 86400000).toISOString() } };
  const app = loadReporter(() => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(forever) }));
  app.fire('error', { message: 'the first bug', filename: '/app.js', lineno: 1 });
  await settle();
  const held = app.api.quietUntil() - Date.now();
  assert.ok(held > 0 && held <= 10 * 60 * 1000 + 100, `held for ${Math.round(held / 1000)}s`);
});

await check('a garbled window is no window', async () => {
  for (const quiet of [{ until: 'soon' }, { until: null }, {}, 'yes']) {
    const app = loadReporter(() => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ ok: false, quiet }) }));
    app.fire('error', { message: 'the first bug', filename: '/app.js', lineno: 1 });
    await settle();
    assert.equal(app.api.quietUntil(), 0, `${JSON.stringify(quiet)} hushed the page`);
  }
});

/* ------------------------------------------------------------------------ done */

for (const s of servers) (s.front || s).close();

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
