#!/usr/bin/env node
/**
 * A workspace whose sweep threw — said on screen, instead of drawn as empty.
 *
 *     npm test
 *     node test/sweepfail.mjs
 *
 * The incident (bc-ksdc): the inbox showed "Nothing live", the picker showed a count,
 * nothing was tapped, and the questions came back on their own a poll later. One repo's
 * `bd human list` had lost a lock race — around twenty agent sessions share these
 * workspaces and embedded Dolt is single-writer — and the handling was a `catch` that
 * logged a line to the daemon's stdout and returned `[]`. Every count downstream is
 * arithmetic over the survivors, so the repo did not appear as broken. It appeared as
 * quiet, which is this app's one unforgivable failure mode wearing the empty state as a
 * costume.
 *
 * Four things are worth a suite here, and none of them is visible by reading one
 * function:
 *
 * 1. **The failure has to reach the payload.** Everything else is downstream of it. A
 *    `catch` that goes back to returning `[]` passes every other check in this repo,
 *    because an empty list is a *valid* list — that is exactly why this happened.
 * 2. **The last good rows have to stand in for the missing ones.** Stale rows are a
 *    smaller lie than none: the bead really is open and really is waiting, and only its
 *    age is wrong. A list that empties on a lock collision and refills a poll later is
 *    indistinguishable, from the outside, from having answered everything.
 * 3. **No confident zero.** The picker's numbers are sums over the rows that came back,
 *    so a repo that threw contributes nothing and vanishes into the arithmetic. The
 *    space row carries `unknown` so the control can say so.
 * 4. **A lock has to be retried before any of the above.** The right outcome for a lock
 *    collision is that nothing was ever wrong: the sweep waits and asks again. The
 *    visible half is for the failures a retry does not fix.
 *
 * The server half runs against a real `bd` — a fake binary that answers from disk and
 * fails on command, driven through `createApp` and a real HTTP request, because what
 * broke was the seam between the `catch` and the payload and a unit test of either side
 * would have been green throughout. The client half is a static read of public/app.js,
 * public/spacebar.js and public/style.css: the inbox needs its whole document to render,
 * so what is checked is what a refactor silently breaks — that the field is read at all,
 * that the pane is drawn outside the empty state, and that what it draws has a rule.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sweepfail-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n')[0]}`);
  }
};

console.log('a workspace whose sweep failed');

/* ------------------------------------------------------- the record, on its own */

const { createSweep, mergeTrouble, troubledNames } = await import(LIB('sweep.js'));

await check('a sweep that answered is not in trouble, and its rows are handed straight back', () => {
  const s = createSweep('questions');
  const rows = [{ key: 'alpha/a-1' }];
  assert.equal(s.ok('alpha', rows), rows);
  assert.deepEqual(s.trouble(), []);
});

await check('a sweep that threw hands back what that repo last said', () => {
  const s = createSweep('questions');
  const rows = [{ key: 'alpha/a-1' }, { key: 'alpha/a-2' }];
  s.ok('alpha', rows);
  assert.deepEqual(s.failed('alpha', new Error('nope')), rows);
});

await check('and a repo that has never answered holds nothing, which the row says', () => {
  const s = createSweep('questions');
  assert.deepEqual(s.failed('beta', new Error('nope')), []);
  assert.equal(s.trouble()[0].held, 0);
});

await check('the row names the workspace, the channel and the first line of the error', () => {
  const s = createSweep('beads');
  s.failed('alpha', new Error('the database would not open\nat Object.<anonymous>'));
  const [row] = s.trouble();
  assert.equal(row.workspace, 'alpha');
  assert.equal(row.channel, 'beads');
  assert.equal(row.error, 'the database would not open');
  assert.ok(row.at, 'stamped with when');
});

await check("bd's own `failed in <ws>:` prefix is dropped — the row already names the repo", () => {
  const s = createSweep('questions');
  s.failed('alpha', new Error('bd human list --json failed in alpha: dolt: database is locked'));
  assert.equal(s.trouble()[0].error, 'dolt: database is locked');
});

await check('answering again clears it — the screen must stop saying so the moment it is true', () => {
  const s = createSweep('questions');
  s.failed('alpha', new Error('nope'));
  assert.equal(s.trouble().length, 1);
  s.ok('alpha', []);
  assert.deepEqual(s.trouble(), []);
});

await check('a bead we answered ourselves is dropped from what is held', () => {
  // The one way holding rows could be worse than emptying them: answering a card while
  // its repo is unreadable closes the bead on disk, and a stand-in row would put the
  // card straight back on the next sweep.
  const s = createSweep('questions');
  s.ok('alpha', [{ id: 'a-1', key: 'alpha/a-1' }, { id: 'a-2', key: 'alpha/a-2' }]);
  s.forget('alpha', 'a-1');
  assert.deepEqual(
    s.failed('alpha', new Error('nope')).map((r) => r.id),
    ['a-2']
  );
});

await check('and forgetting from a repo that has never answered is a no-op, not a throw', () => {
  const s = createSweep('questions');
  s.forget('nobody', 'x-1');
  assert.deepEqual(s.failed('nobody', new Error('nope')), []);
});

await check('one repo failing three channels is one row, not three sentences on a phone', () => {
  const a = createSweep('questions');
  const b = createSweep('beads');
  const c = createSweep('foundation');
  a.failed('alpha', new Error('one'));
  b.failed('alpha', new Error('two'));
  c.failed('gamma', new Error('three'));
  const merged = mergeTrouble(a, b, c);
  assert.deepEqual(
    merged.map((t) => t.workspace),
    ['alpha', 'gamma']
  );
  assert.deepEqual(troubledNames(merged), ['alpha', 'gamma']);
});

/* ------------------------------------------------- the picker's rows, on their own */

const { summarise } = await import(LIB('spaces.js'));

const spaceCfg = {
  spaces: [
    { name: 'Work', workspaces: ['alpha', 'beta'] },
    { name: 'Personal', workspaces: ['gamma'] },
  ],
};
const q = (workspace, id) => ({ key: `${workspace}/${id}`, workspace, id });

await check('with every repo answering, no space claims to be unsure', () => {
  const rows = summarise(spaceCfg, [q('alpha', 'a-1')], []);
  assert.equal(rows.find((r) => r.name === 'Work').count, 1);
  assert.equal(rows.find((r) => r.name === 'Work').unknown, undefined);
  assert.equal(rows.find((r) => r.name === 'Personal').unknown, undefined);
});

await check('a space holding a repo that threw is unknown — and keeps the count it does have', () => {
  const rows = summarise(spaceCfg, [q('alpha', 'a-1')], ['beta']);
  const work = rows.find((r) => r.name === 'Work');
  assert.equal(work.unknown, true, 'Work holds beta');
  assert.equal(work.count, 1, 'still the best answer available');
  assert.equal(rows.find((r) => r.name === 'Personal').unknown, undefined, 'Personal holds neither');
});

await check('a repo in no space that threw still gets an Other row to be unsure in', () => {
  // The failure mode this guards: the stray group is built out of the questions that
  // arrived, and a repo that answered with none contributes nothing to build it from —
  // so without this the one repo nobody could read is the one repo with no row at all.
  const rows = summarise(spaceCfg, [], ['delta']);
  const other = rows.find((r) => r.name === 'Other');
  assert.ok(other, 'Other is drawn for it');
  assert.deepEqual(other.workspaces, ['delta']);
  assert.equal(other.unknown, true);
  assert.equal(other.count, 0);
});

/* ------------------------------------------ the whole loop, against a real server */

/**
 * A `bd` that answers from disk and fails on command.
 *
 * Which repo fails, and how, is a JSON file this test rewrites between requests —
 * because that is the shape of the thing: one workspace out of several, failing on one
 * sweep and not the next. `BEADS_DIR` is what the daemon passes per workspace and is
 * therefore the only thing the fake can identify itself by.
 *
 * `LOCK` is the message a Dolt collision produces, and the retry in lib/bd.js keys off
 * it. `PLAIN` is anything else — it fails on the first attempt, which is what keeps the
 * rest of this suite fast.
 */
const WS_NAMES = ['alpha', 'beta', 'gamma'];
const dirs = Object.fromEntries(
  WS_NAMES.map((name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
    return [name, dir];
  })
);
const PLAN = path.join(tmp, 'plan.json');
// One file per (workspace, kind), one byte appended per call, and the count is the
// file's size. A read-modify-write JSON counter looks obvious and is wrong here: the
// daemon sweeps every workspace with `Promise.all`, so three of these run at once and
// the last writer wins — which showed up as a fake `bd` crashing on a half-written
// file rather than as a wrong number, and read as a real sweep failure.
const COUNTS = path.join(tmp, 'counts');
fs.mkdirSync(COUNTS, { recursive: true });
// Setting the plan also zeroes the tally, so `after` counts calls made *under this
// plan*. Cumulative would have made every rule after the first one a no-op — silently,
// and in the direction that passes: the fake would answer instead of failing, and a
// check that a failure is reported would go green having produced no failure at all.
const plan = (next) => {
  fs.rmSync(COUNTS, { recursive: true, force: true });
  fs.mkdirSync(COUNTS, { recursive: true });
  fs.writeFileSync(PLAN, JSON.stringify(next));
};
const calls = (key) => {
  try {
    return fs.statSync(path.join(COUNTS, key)).size;
  } catch {
    return 0;
  }
};
plan({});

const BIN = path.join(tmp, 'bd');
fs.writeFileSync(
  BIN,
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const name = path.basename(process.env.BEADS_DIR || '');
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(PLAN)}, 'utf8'));
const kind = args[0] === 'human' ? 'human' : args[0] === 'list' ? 'list' : args[0];
const tally = path.join(${JSON.stringify(COUNTS)}, name + ':' + kind);
fs.appendFileSync(tally, 'x');
const seen = fs.statSync(tally).size;

const rule = plan[name];
// { fail: 'plain' | 'lock', after: <succeed once this many calls have been made> }
if (rule && (kind === 'human' || kind === 'list') && (!rule.after || seen <= rule.after)) {
  process.stderr.write(rule.fail === 'lock' ? 'dolt: database is locked by another process' : 'bd: no such workspace');
  process.exit(1);
}

const bead = (id, labels) => ({
  id,
  issue_type: 'task',
  status: 'open',
  title: id + ' in ' + name,
  priority: 2,
  labels,
  comment_count: 0,
  dependencies: [],
  description: 'Something to decide in ' + name + '.',
});

if (args[0] === 'human' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([bead(name.slice(0, 1) + '-q1', ['human'])]));
  process.exit(0);
}
if (args[0] === 'list') {
  process.stdout.write(JSON.stringify(args.includes('--label') ? [] : [bead(name.slice(0, 1) + '-w1', [])]));
  process.exit(0);
}
if (args[0] === 'show') { process.stdout.write(JSON.stringify([bead(args[1], ['human'])])); process.exit(0); }
process.stdout.write('[]');
process.exit(0);
`,
  { mode: 0o755 }
);

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'sweepfail-test-token',
  actor: 'beadcause-test',
  bdBin: BIN,
  workspaces: WS_NAMES.map((name) => ({ name, dir: dirs[name] })),
  spaces: [
    { name: 'Work', workspaces: ['alpha', 'beta'] },
    { name: 'Personal', workspaces: ['gamma'] },
  ],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  terminal: false,
  pollSeconds: 3600,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);
const call = async (pathname) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'x-beadcause-token': cfg.token },
  });
  return { status: res.status, body: await res.json() };
};

try {
  await check('with every repo answering, the payload carries no trouble at all', async () => {
    plan({});
    const { body } = await call('/api/questions?scope=human');
    assert.deepEqual(body.trouble, [], 'nothing to report');
    assert.equal(body.questions.length, 3, 'one question per repo');
  });

  await check('a repo that throws is named in the payload, with what bd said', async () => {
    plan({ beta: { fail: 'plain' } });
    const { body } = await call('/api/questions?scope=human');
    assert.equal(body.trouble.length, 1, 'exactly the one repo');
    const [row] = body.trouble;
    assert.equal(row.workspace, 'beta');
    assert.match(row.error, /no such workspace/, 'the reason, not just the fact');
    assert.equal(row.channel, 'questions');
  });

  await check('and its rows are held rather than replaced by none', async () => {
    // The criterion this whole bead turns on. beta answered on the sweep before this
    // one, so its question is still on the list — stale, and present.
    const { body } = await call('/api/questions?scope=human');
    assert.equal(body.questions.length, 3, 'still three, one of them held');
    assert.ok(
      body.questions.some((row) => row.workspace === 'beta'),
      "beta's question survived a sweep it could not answer"
    );
    assert.equal(body.trouble[0].held, 1, 'and the payload says how many are standing in');
  });

  await check('the space holding it stops reporting a confident count', async () => {
    const { body } = await call('/api/questions?scope=human');
    const work = body.spaces.find((s) => s.name === 'Work');
    assert.equal(work.unknown, true, 'Work holds beta');
    assert.equal(body.spaces.find((s) => s.name === 'Personal').unknown, undefined, 'Personal does not');
  });

  await check('the picker gets the same list on /api/spaces, where four pages read it', async () => {
    const { body } = await call('/api/spaces');
    assert.deepEqual(
      body.trouble.map((t) => t.workspace),
      ['beta']
    );
    assert.equal(body.spaces.find((s) => s.name === 'Work').unknown, true);
  });

  await check('the agent channel fails on its own clock, and says which read it was', async () => {
    plan({ gamma: { fail: 'plain' } });
    const { body } = await call('/api/questions?scope=both');
    const row = body.trouble.find((t) => t.workspace === 'gamma');
    assert.ok(row, 'gamma is named');
    // `both` sweeps questions and beads; gamma fails both, and one repo is one row.
    assert.equal(body.trouble.filter((t) => t.workspace === 'gamma').length, 1);
    assert.ok(['questions', 'beads'].includes(row.channel));
  });

  await check('a repo that answers again takes itself back off the screen', async () => {
    plan({});
    const { body } = await call('/api/questions?scope=human');
    assert.deepEqual(body.trouble, []);
    assert.equal(body.spaces.find((s) => s.name === 'Work').unknown, undefined);
  });

  await check('a lock is waited out rather than reported — the retry makes it never happen', async () => {
    // The other half of the acceptance criteria, and the better half: a transient
    // failure should not empty the list *or* put a banner on the phone. Two attempts
    // fail with the message Dolt produces, the third answers, and the payload is clean.
    plan({ alpha: { fail: 'lock', after: 2 } });
    const { body } = await call('/api/questions?scope=human');
    assert.deepEqual(body.trouble, [], 'nothing to report — it was asked again');
    assert.equal(body.questions.length, 3, 'and nothing dropped out of the list');
    assert.equal(calls('alpha:human'), 3, `two refusals and an answer, got ${calls('alpha:human')}`);
  });

  await check('a failure that is not a lock is not retried — it fails at once', async () => {
    plan({ beta: { fail: 'plain' } });
    const { body } = await call('/api/questions?scope=human');
    assert.equal(body.trouble.length, 1);
    assert.equal(calls('beta:human'), 1, `asked once, got ${calls('beta:human')}`);
  });
} finally {
  for (const s of servers) s.close?.();
}

/* --------------------------------------------------- and that the phone draws it */

const APP = read('public/app.js');
const BAR = read('public/spacebar.js');
const CSS = read('public/style.css');

await check('the inbox reads the field off the payload and keeps it', () => {
  assert.match(APP, /data\.trouble/, 'adopted from the payload');
  assert.match(APP, /state\.trouble/, 'held on the page');
});

await check('and draws it as a pane of its own, not as a sentence inside the empty state', () => {
  // The distinction the acceptance criterion is about: the list is usually *not* empty
  // when a repo fails, so a line that only appears under "Nothing live" is a line
  // nobody sees on the day it matters.
  assert.match(APP, /key: '@trouble'/, 'its own chunk in the list');
  const empty = APP.slice(APP.indexOf('function emptyHtml()'), APP.indexOf('function emptyHtml()') + 1400);
  assert.doesNotMatch(empty, /troubleHtml/, 'not folded into the empty state');
});

await check('the pane names the repo and prints the error', () => {
  const pane = APP.slice(APP.indexOf('function troubleHtml()'), APP.indexOf('function troubleHtml()') + 1200);
  assert.match(pane, /t\.workspace/, 'names the repo');
  assert.match(pane, /t\.error/, 'and says what went wrong');
});

await check('the picker will not draw a confident zero for a repo that did not answer', () => {
  assert.match(BAR, /data\.trouble/, 'adopted');
  assert.match(BAR, /const tail = \(n, unknown\)/, 'the count knows whether it is a fact');
  assert.match(BAR, /unknown \?/, 'and draws something else when it is not');
});

await check('what the pane draws has a rule, in both themes', () => {
  assert.match(CSS, /^\.trouble \{/m, 'the pane itself');
  assert.match(CSS, /--danger/, 'in a colour the page defines for both schemes');
});

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
