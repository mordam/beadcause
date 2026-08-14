#!/usr/bin/env node
/**
 * The hold on an unendorsed bead — the safety half of "a worker files the bead itself".
 *
 *     npm test
 *     node test/endorse.mjs
 *
 * A worker that finds work mid-task will soon file the bead itself, marked `unendorsed`
 * (bc-3zo9.2). Everything about that is safe or unsafe depending on this file: if an
 * agent-filed bead can be picked up, the work is done before anyone has read the title,
 * endorsement is a formality performed afterwards, and revoking it means nothing.
 *
 * The hold is two layers and they fail differently, so they are tested differently:
 *
 * 1. **The filter.** `Bd.ready` and the advocate's survey must not return a held bead,
 *    and no count that says how much work is waiting may include one. This one fails
 *    *silently* — a queue that quietly contains a bead nobody endorsed looks exactly
 *    like a queue that doesn't — so it is checked against a real `bd` binary's argv as
 *    well as against its output.
 * 2. **The refusal.** `openWorkSession` asks the tracker itself and refuses, which is
 *    the actual guarantee: it is the only door into an unattended session, so a held
 *    bead handed straight to it by any other route still cannot be worked. Tested by
 *    handing it one directly, which is the case the filter can never cover.
 *
 * And the one exception: tapping "work on this" from the phone (`POST /api/session`)
 * **endorses the bead and then opens it**, because you are present and choosing. A
 * refusal there would send you to another screen to press a button and come back.
 *
 * No iTerm and no real tracker. The `bd` here is a stub binary that logs its argv, so
 * the flags are asserted as they are actually passed; the launcher is only ever asked
 * to do the thing it refuses to do, so nothing in this file can open a window. The one
 * session endpoint that *would* is aimed at a missing directory, so it fails after the
 * endorsement and before AppleScript — which is also the assertion that the endorsement
 * goes first.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-endorse-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED, QUEUE_EXCLUDED, isHeld, assertEndorsed, endorse } = await import(LIB('endorse.js'));
const { openWorkSession } = await import(LIB('session.js'));
const { collectWork } = await import(LIB('work.js'));
const { createAdvocates } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, and a `bd` that reads it.
 *
 * `ready` is implemented the way bd implements it — open, unclaimed, and honouring
 * `--exclude-label` / `--label` — because the filter under test *is* those flags. A
 * stub that ignored them would pass whatever the code did.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
const all = () => Object.values(w.issues);
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (args[0] === 'ready') {
  const off = many('--exclude-label');
  const need = many('--label');
  const rows = all()
    .filter((i) => i.status === 'open' && !i.assignee)
    .filter((i) => !(i.labels || []).some((l) => off.includes(l)))
    .filter((i) => need.every((l) => (i.labels || []).includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'list') {
  const off = many('--exclude-label');
  const need = many('--label');
  const rows = all()
    .filter((i) => i.status !== 'closed')
    .filter((i) => !(i.labels || []).some((l) => off.includes(l)))
    .filter((i) => need.every((l) => (i.labels || []).includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'status' || args[0] === 'stats') {
  const open = all().filter((i) => i.status === 'open');
  process.stdout.write(JSON.stringify({
    summary: {
      open_issues: open.length,
      // The number this test exists for: bd counts a held bead as ready, because
      // being held is a label and bd has never heard of it.
      ready_issues: open.filter((i) => !i.assignee).length,
      blocked_issues: 0,
      in_progress_issues: all().filter((i) => i.status === 'in_progress').length,
    },
  }));
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'remove') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  if (!(issue.labels || []).includes(args[3])) die('no label ' + args[3] + ' on ' + args[2]);
  issue.labels = issue.labels.filter((l) => l !== args[3]);
  save();
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const clearCalls = () => fs.rmSync(BD_LOG, { force: true });

const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  ...extra,
});

/** Four beads: ordinary work, a question, one held for endorsement, one already claimed. */
const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'zz-work': issue('zz-work'),
          'zz-ask': issue('zz-ask', { labels: ['human'] }),
          'zz-held': issue('zz-held', { labels: ['worker', UNENDORSED] }),
          'zz-busy': issue('zz-busy', { status: 'in_progress', assignee: 'someone' }),
        },
      },
      null,
      2
    )
  );
};
reset();

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const ws = { name: 'demo', dir: wsDir };
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
const labelsOf = (id) => JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues[id].labels;

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
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

console.log('\nnothing may open a session on an unendorsed bead\n');

/* ------------------------------------------------------------ the marker itself */

await check('the marker has one spelling, and it is the one the queue excludes', () => {
  assert.equal(UNENDORSED, 'unendorsed');
  // `ship` joined the two since lib/shipbead.js: a merged pull request waiting for a
  // deploy is not claimable work by anything reading this list, and it used to be kept
  // out by carrying the marker above — which one press of "Endorse all" removes.
  assert.deepEqual(QUEUE_EXCLUDED, ['human', UNENDORSED, 'ship'], 'what an advocate may not queue');
  assert.equal(isHeld({ labels: ['worker', 'unendorsed'] }), true);
  assert.equal(isHeld({ labels: ['unendorsed '] }), true, 'a stray space is not a second label');
  assert.equal(isHeld({ labels: ['endorsed', 'unendorsedish'] }), false, 'and it is not a prefix match');
  assert.equal(isHeld({}), false);
  assert.equal(isHeld(null), false);
});

/* ------------------------------------------------------- layer 1: out of the queue */

await check('bd ready never returns a held bead, and says so on the command line', async () => {
  clearCalls();
  const rows = await bd.ready(ws, { excludeLabels: QUEUE_EXCLUDED });
  assert.deepEqual(rows.map((r) => r.id), ['zz-work'], 'the question and the held bead are both out');
  const call = bdCalls().find((c) => c[0] === 'ready');
  const off = call.filter((a, i) => call[i - 1] === '--exclude-label');
  assert.deepEqual(
    off.sort(),
    ['human', 'ship', UNENDORSED],
    `every excluded label is passed to bd, got ${call.join(' ')}`
  );
  assert.ok(call.includes('--limit') && call[call.indexOf('--limit') + 1] === '0', 'and no page limit');
});

await check('a caller that asks only for questions to be excluded still gets no held bead', async () => {
  // The hole this closes: one stale call site passing `{ excludeLabel: 'human' }` would
  // otherwise put every held bead back into an advocate's queue.
  const rows = await bd.ready(ws, { excludeLabel: 'human' });
  assert.deepEqual(rows.map((r) => r.id), ['zz-work']);
  const rowsByDefault = await bd.ready(ws);
  assert.deepEqual(rowsByDefault.map((r) => r.id), ['zz-work'], 'and neither does one that asks for nothing');
});

await check('and the rows are filtered here too, against a bd that ignored the flag', async () => {
  // A `bd` that returns everything whatever it is asked. The queue must still be right:
  // the rows carry their labels, so this costs nothing and cannot be talked past.
  const deaf = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  deaf.json = async () => [issue('zz-work'), issue('zz-held', { labels: [UNENDORSED] }), issue('zz-ask', { labels: ['human'] })];
  const rows = await deaf.ready(ws, { excludeLabels: QUEUE_EXCLUDED });
  assert.deepEqual(rows.map((r) => r.id), ['zz-work']);
});

await check('readyHeld is the other side of the same fact — only the held ones', async () => {
  const rows = await bd.readyHeld(ws);
  assert.deepEqual(rows.map((r) => r.id), ['zz-held']);
});

await check("the advocate's queue and its ready count leave held beads out", async () => {
  const cfg = {
    workspaces: [ws],
    spaces: [],
    claudeSessions: false,
    advocates: { enabled: true, workspaces: ['*'], propose: false },
  };
  const advocates = createAdvocates(cfg, { bd, bus: { emit() {} } });
  // **Paused before it ticks, and this is not incidental.** `tick` surveys first and
  // only then decides what to open, so a paused advocate builds exactly the queue under
  // test — and an unpaused one in a suite would open a real iTerm window on a bead in a
  // temp directory. It reports `paused · N ready`, so the count is still on the card.
  await advocates.control('demo', 'pause');
  await advocates.tick();
  const card = advocates.snapshot().find((a) => a.workspace === 'demo');
  assert.equal(card.queue, 1, `one bead for the advocate, got ${card.queue}`);
  assert.match(card.note || '', /\b1 ready\b/, 'and "N ready" on the card is that same number');
});

await check('the monitor counts a held bead as held, not as ready', async () => {
  const rows = await collectWork(bd, [ws], {}, []);
  const c = rows[0].counts;
  assert.equal(c.held, 1, 'reported in its own right, so the gap is explained');
  assert.equal(c.ready, 2, `zz-work and zz-ask are ready; zz-held is not. Got ${c.ready}`);
  assert.equal(c.open, 3);
});

await check('a bd too old for `ready --label` costs the held count, not the whole row', async () => {
  const old = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  old.readyHeld = async () => {
    throw new Error('unknown flag: --label');
  };
  const rows = await collectWork(old, [ws], {}, []);
  assert.equal(rows[0].error, undefined, 'the workspace still reports');
  assert.equal(rows[0].counts.held, 0);
  assert.equal(rows[0].counts.ready, 3, 'and ready falls back to what the tracker said');
});

/* --------------------------------------------------- layer 2: refused at launch */

await check('the gate refuses a held bead and passes an endorsed one', async () => {
  await assert.rejects(
    () => assertEndorsed(bd, ws, 'zz-held'),
    (err) => err.status === 409 && err.unendorsed === true && /unendorsed/.test(err.message),
    'handed the id alone, with nothing but the tracker to go on'
  );
  const passed = await assertEndorsed(bd, ws, 'zz-work');
  assert.equal(passed.id, 'zz-work', 'and it hands back the row it read');
});

await check('a row claiming to be endorsed does not get it past the tracker', async () => {
  // The whole point of this layer: it does not trust what it was handed.
  await assert.rejects(
    () => assertEndorsed(bd, ws, { id: 'zz-held', title: 'bead zz-held', labels: [] }),
    (err) => err.unendorsed === true
  );
});

await check('and it refuses what it cannot check', async () => {
  await assert.rejects(
    () => assertEndorsed(null, ws, 'zz-work'),
    (err) => err.unendorsed === true && /could not ask the tracker|nothing here could ask/.test(err.message),
    '"I could not check" and "it is fine" are not the same answer'
  );
  await assert.rejects(
    () => assertEndorsed(bd, ws, 'zz-nope'),
    (err) => err.unendorsed === true || /no issue found/.test(err.message),
    'a bead that is not there cannot be vouched for'
  );
});

await check('openWorkSession refuses a held bead handed straight to it', async () => {
  // sessionDirs is deliberately real here: a refusal that only happened because the
  // directory was missing would prove nothing about endorsement.
  const cfg = { sessionDirs: { demo: tmp }, openSessions: true };
  await assert.rejects(
    () => openWorkSession(cfg, ws, { id: 'zz-held', title: 'bead zz-held' }, { bd }),
    (err) => err.status === 409 && err.unendorsed === true,
    'this is the guarantee — the filter above is only what keeps it from being reached'
  );
});

await check('and refuses when it was given no way to check', async () => {
  const cfg = { sessionDirs: { demo: tmp }, openSessions: true };
  await assert.rejects(
    () => openWorkSession(cfg, ws, { id: 'zz-work', title: 'ordinary work' }, {}),
    (err) => err.unendorsed === true,
    'no bd, no launch — a caller that forgot it must not get an unchecked session'
  );
});

/* ------------------------------------------------------- the endorsement itself */

await check('endorsing takes the marker off, and is a no-op on a bead that never had it', async () => {
  reset();
  assert.deepEqual(await endorse(bd, ws, 'zz-work'), { endorsed: false, id: 'zz-work' });
  clearCalls();
  assert.deepEqual(await endorse(bd, ws, 'zz-held'), { endorsed: true, id: 'zz-held' });
  assert.deepEqual(labelsOf('zz-held'), ['worker'], 'and only that label — `worker` says an agent filed it');
  assert.ok(
    bdCalls().some((c) => c[0] === 'label' && c[1] === 'remove' && c[2] === 'zz-held' && c[3] === UNENDORSED),
    'through bd, so the change is in the tracker rather than in memory'
  );
  assert.deepEqual(await endorse(bd, ws, 'zz-held'), { endorsed: false, id: 'zz-held' }, 'idempotent');
});

await check('a row already in hand is not read twice', async () => {
  reset();
  clearCalls();
  const row = JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues['zz-held'];
  await endorse(bd, ws, row);
  assert.equal(bdCalls().filter((c) => c[0] === 'show').length, 0, 'the caller had it — asking again is a wasted read');
});

await check('an endorsed bead is then workable — both layers agree', async () => {
  // The pair that matters: it is in the queue *and* the gate lets it through. Testing
  // either alone would miss an endorsement that only half worked.
  const rows = await bd.ready(ws, { excludeLabels: QUEUE_EXCLUDED });
  assert.deepEqual(rows.map((r) => r.id).sort(), ['zz-held', 'zz-work']);
  assert.equal((await assertEndorsed(bd, ws, 'zz-held')).id, 'zz-held');
});

/* ------------------------------------- the exception: you, tapping "work on this" */

/**
 * The real endpoint, over a real socket, with the stub `bd` behind it.
 *
 * `sessionDirs.demo` points at a directory that does not exist, so `openSession`
 * throws before any AppleScript — which is what keeps this suite from opening an iTerm
 * window, and is also the sharpest available assertion that the endorsement happens
 * *first*: the tap endorsed the bead even though the window never came up.
 */
const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  host: '127.0.0.1',
  port: 0,
  baseUrl: '',
  token: 'endorse-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [ws],
  sessionDirs: { demo: path.join(tmp, 'no-such-checkout') },
  openSessions: true,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);
// createApp and listen hold this object, so the two fields that could only be
// filled in once the kernel had chosen are filled in here, before the first call.
cfg.port = port;
cfg.baseUrl = `http://127.0.0.1:${port}`;

const post = (pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-beadcause-token': cfg.token,
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

await check('tapping "work on this" endorses the bead rather than refusing it', async () => {
  reset();
  const res = await post('/api/session', { workspace: 'demo', id: 'zz-held' });
  // The window cannot come up here — `sessionDirs.demo` is deliberately missing — so what
  // is asserted is the pair: nothing refused this for want of endorsement, and the marker
  // came off anyway. That second half is the ordering: the endorsement is what you asked
  // for by tapping, and it stands whether or not iTerm then cooperated.
  assert.doesNotMatch(
    String(res.json.error || ''),
    new RegExp(UNENDORSED),
    `a tap must never be refused for want of endorsement — ${JSON.stringify(res.json)}`
  );
  assert.deepEqual(labelsOf('zz-held'), ['worker'], 'the marker is off, and the `worker` label it arrived with is not');
});

await check('and an ordinary bead is endorsed by nobody, because it never needed it', async () => {
  reset();
  clearCalls();
  await post('/api/session', { workspace: 'demo', id: 'zz-work' });
  assert.equal(
    bdCalls().filter((c) => c[0] === 'label').length,
    0,
    'no write on the common path — every question in the inbox goes through here'
  );
});

/* -------------------------------------------------------------------- the result */

console.log(`\n${ran - failures}/${ran} passed\n`);
for (const s of servers || []) s.close?.();
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
