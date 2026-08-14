#!/usr/bin/env node
//
// The record of what is still making a noise on the phone.
//
//   npm test                     (runs it alongside the rest)
//   node test/ringing.mjs
//
// `ringing` is one map in state.json — keyed `workspace/id`, one entry per bead whose
// notification this daemon actually caused and has not cancelled. It is small, and it
// has a suite rather than a comment because the write that fills it is one line in the
// middle of the push path: the easiest thing here to lose in a merge and the hardest
// to notice, because losing it makes a row sit in the phone's tray after the bead has
// been answered.
//
// Two rules, and both are about not claiming more than is true:
//
// 1. **Only a bead that actually rang is recorded.** A bead the filter kept quiet made
//    no noise, so there is nothing to cancel, and a record for it would have the
//    daemon cancelling silence.
// 2. **A wrong shape on disk reads as "nothing is ringing"**, never as "everything
//    is" — the cheap failure is a row left on the phone, the expensive one is a
//    cancel aimed at a bead this daemon knows nothing about.
//
// **There used to be a third thing here, and its absence is now asserted.** Narrowing
// the filter drew a pane on the inbox counting the unread notifications the new filter
// excluded, with *Clear them* and *Leave them*; bc-ka5y.1 deleted the whole feature.
// So `/api/filter` must carry no `dismissAsk`, `/api/questions` must carry none, and
// `/api/notifications/dismiss` must not answer at all — the checks at the bottom are
// there to stop any of the three coming back by accident.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-ringing-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { loadState, saveState, STATE_PATH } = await import(LIB('config.js'));
const { drop, rangFor, retain } = await import(LIB('ringing.js'));

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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('what is still ringing on the phone');

const NOW = new Date('2026-08-10T12:00:00Z');

const cfg = {
  spaces: [
    { name: 'Work', workspaces: ['alpha'] },
    { name: 'Personal', workspaces: ['beta'] },
  ],
};

const rang = (workspace, id, extra = {}) => [`${workspace}/${id}`, { workspace, id, foundation: false, ...extra }];
const RINGING = Object.fromEntries([
  rang('alpha', 'a-1'),
  rang('beta', 'b-1'),
  rang('gamma', 'g-1'),
  rang('beta', 'b-req', { foundation: true }),
]);

/* ----------------------------------------------------------------- bookkeeping */

check(() => {
  const r = rangFor({ workspace: 'alpha', id: 'a-9', foundation: true }, NOW);
  assert.deepEqual(r, { workspace: 'alpha', id: 'a-9', foundation: true, at: NOW.toISOString() });
  assert.equal(rangFor({ workspace: 'alpha', id: 'a-9' }, NOW).foundation, false, 'defaults to not a request');
}, 'a record carries what the event needs, and nothing else');

check(() => {
  assert.deepEqual(Object.keys(retain(RINGING, ['alpha/a-1'])), ['alpha/a-1']);
  assert.deepEqual(Object.keys(retain(RINGING, new Set())), []);
  assert.deepEqual(Object.keys(drop(RINGING, ['alpha/a-1', 'beta/b-1'])).sort(), ['beta/b-req', 'gamma/g-1']);
}, 'retain keeps what is still in the inbox, drop forgets what has been cancelled');

/* ------------------------------------------------------------------ state.json */

fs.rmSync(STATE_PATH, { force: true });
check(() => {
  assert.deepEqual(loadState().ringing, {}, 'ringing');
}, 'a fresh install reads as nothing ringing');

fs.writeFileSync(STATE_PATH, JSON.stringify({ ringing: [1, 2] }));
check(() => {
  // A wrong shape must read as "nothing is ringing", never as "everything is".
  assert.deepEqual(loadState().ringing, {});
}, 'and so does a file with the field the wrong shape');

/* ------------------------------------------------ the endpoints, against a real server */

const { createApp, listen } = await import(LIB('server.js'));

const serverCfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'ringing-test-token',
  actor: 'beadcause-test',
  workspaces: [],
  spaces: cfg.spaces,
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(serverCfg);
const servers = listen(serverCfg, app.handler);
const port = await boundPort(servers);

const call = (pathname, opts = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': serverCfg.token },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

/** Everything ringing, with the filter wide open. */
const seed = (extra = {}) =>
  saveState({
    filter: { space: 'all', workspace: 'all' },
    ringing: { ...RINGING },
    ...extra,
  });

const narrow = (space) => call('/api/filter', { method: 'POST', body: JSON.stringify({ space, workspace: 'all' }) });

seed();
const narrowed = await narrow('Work');
check(() => {
  assert.equal(narrowed.status, 200);
  assert.equal(narrowed.body.filter.space, 'Work', 'the filter itself is stored');
  assert.ok(!('dismissAsk' in narrowed.body), `no ask is offered (got ${JSON.stringify(narrowed.body)})`);
}, 'narrowing the filter says nothing about the notifications it now excludes');

check(() => {
  // The whole of the accepted consequence: they stay unread, silently, and nothing
  // has touched them.
  assert.deepEqual(Object.keys(loadState().ringing).sort(), Object.keys(RINGING).sort());
}, 'and leaves every one of them exactly where it was');

const listed = await call('/api/questions');
check(() => {
  assert.ok(!('dismissAsk' in listed.body), 'the inbox payload carries no prompt either');
}, 'the inbox payload has no notification prompt in it');

const gone = await call('/api/notifications/dismiss', {
  method: 'POST',
  body: JSON.stringify({ confirm: true, keys: ['beta/b-1'] }),
});
check(() => {
  assert.equal(gone.status, 404, `the route is gone (status ${gone.status})`);
  assert.deepEqual(Object.keys(loadState().ringing).sort(), Object.keys(RINGING).sort(), 'nothing moved');
}, 'and no endpoint answers one — /api/notifications/dismiss is gone');

/* ------------------------------------------- and the poller, which is what records it */
//
// Everything above is worthless if nothing ever writes `ringing`, and that write is
// one line in the middle of the push path — the easiest thing here to lose in a merge
// and the hardest to notice. So this runs the real poller and asks what it wrote down.

const { startPoller } = await import(LIB('server.js'));
const { createEventBus } = await import(LIB('events.js'));

const q = (workspace, space, id, extra = {}) => ({
  key: `${workspace}/${id}`,
  workspace,
  space,
  id,
  title: `${id} in ${workspace}`,
  question: `${id} in ${workspace}`,
  priority: 2,
  ...extra,
});

// Filtered to Work, which holds alpha and not beta — so a fresh bead in alpha rings
// and one in beta stays quiet, and only the first should be recorded.
saveState({ notified: [], commentCounts: {}, ringing: {}, filter: { space: 'Work', workspace: 'all' } });

let inbox = [];
const pollCfg = {
  baseUrl: 'http://127.0.0.1',
  token: serverCfg.token,
  actor: 'beadcause-test',
  workspaces: [{ name: 'alpha' }, { name: 'beta' }],
  spaces: cfg.spaces,
  pollSeconds: 5,
  autoDispatch: false,
  ntfy: { enabled: false },
};
const bus = createEventBus();
const timer = startPoller(pollCfg, {
  bus,
  hooks: {},
  bd: { comments: async () => [], removeLabel: async () => {} },
  allQuestions: async () => inbox,
});

const settled = async (fn, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

// The first cycle is the baseline sweep and pushes nothing by design.
await settled(() => bus.seq > 0 || loadState().notified.length > 0);
inbox = [q('alpha', 'Work', 'a-new'), q('beta', 'Personal', 'b-new')];
const rangUp = await settled(() => Boolean(loadState().ringing['alpha/a-new']));
clearInterval(timer);

check(() => {
  assert.ok(rangUp, `the in-filter bead was recorded (ringing: ${JSON.stringify(loadState().ringing)})`);
  const r = loadState().ringing['alpha/a-new'];
  assert.equal(r.workspace, 'alpha');
  assert.equal(r.id, 'a-new');
}, 'a bead that actually rang is written down, so its row can be cancelled later');

check(() => {
  // It arrived quietly — nothing lit up for it — so there is no notification to
  // cancel, and recording one would have the daemon cancelling silence.
  assert.equal(loadState().ringing['beta/b-new'], undefined);
}, 'a bead the filter kept quiet is not recorded — it never made a noise to cancel');

servers.forEach((s) => s.close());
await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
