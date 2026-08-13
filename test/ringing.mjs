#!/usr/bin/env node
//
// Asking before clearing the unread notifications a filter change excludes.
//
//   npm test                     (runs it alongside the rest)
//   node test/ringing.mjs
//
// The feature is small and every way it can go wrong is a way of being *dishonest*,
// which is why it has a suite rather than a comment:
//
// 1. **A dismissal must not look like an answer.** The bead stays open, stays
//    unanswered, stays in the inbox — all that goes is the row in the phone's shade.
//    So it emits its own event type, `dismissed`, and `bd` is never called at all.
//    Reusing `answered` would tell every client a decision had been made.
// 2. **Declining has to be remembered.** A prompt that comes back on the next poll is
//    worse than no prompt, and "remembered" is per bead and only while that bead is
//    excluded — widening the filter forgets it, so narrowing again asks afresh.
// 3. **Nothing may be offered that cannot be delivered.** An ntfy notification already
//    on the phone cannot be recalled; only the Android shell's own tray can be
//    cleared, and only while that shell is in use. With no shade the ask must be
//    silent rather than a button that reports success and does nothing.
// 4. **Beads inside the filter are never touched**, and a filter change with nothing
//    excluded and unread says nothing at all.
//
// The HTTP half runs the real endpoints against the real state file, because the two
// halves that can silently disagree — what the payload says is waiting, and what the
// POST actually clears — are exactly the ones a unit test of either would miss.
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
const {
  SHADE_TTL_MS,
  dismissAsk,
  drop,
  excludedRinging,
  pruneDeclined,
  rangFor,
  retain,
  shadeReachable,
} = await import(LIB('ringing.js'));

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

console.log('unread notifications a filter change excludes');

/* ------------------------------------------------------- is there a shade at all */

const NOW = new Date('2026-08-10T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

check(() => {
  assert.equal(shadeReachable(null, NOW), false, 'never seen');
  assert.equal(shadeReachable('', NOW), false, 'empty');
  assert.equal(shadeReachable('not a date', NOW), false, 'junk');
  assert.equal(shadeReachable(ago(60_000), NOW), true, 'a minute ago');
  assert.equal(shadeReachable(ago(SHADE_TTL_MS - 1000), NOW), true, 'just inside the window');
  assert.equal(shadeReachable(ago(SHADE_TTL_MS + 1000), NOW), false, 'past it');
}, 'a shade is real only when a client that owns one has polled inside the window');

check(() => {
  // A clock set backwards since the value was written. Believing it is the safe
  // direction: the failure to avoid is a prompt that can never appear again.
  assert.equal(shadeReachable(new Date(NOW.getTime() + 5 * 60_000).toISOString(), NOW), true);
}, 'a timestamp from the future is a wrong clock, not an expired shade');

/* --------------------------------------------------- what the filter has excluded */

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
const keysOf = (list) => list.map((e) => e.key).sort();

check(() => {
  assert.deepEqual(keysOf(excludedRinging(cfg, RINGING, { space: 'all', workspace: 'all' })), []);
}, 'with no filter nothing is excluded, so there is nothing to offer');

check(() => {
  assert.deepEqual(keysOf(excludedRinging(cfg, RINGING, { space: 'Work', workspace: 'all' })), [
    'beta/b-1',
    'gamma/g-1',
  ]);
}, 'a space filter excludes the beads outside it — and only those');

check(() => {
  // gamma is in no configured space, so it answers to the synthetic "Other" group,
  // exactly as the inbox's own spaceOf does. If these disagreed the phone would be
  // asked about a bead it is showing you.
  assert.deepEqual(keysOf(excludedRinging(cfg, RINGING, { space: 'Other', workspace: 'all' })), [
    'alpha/a-1',
    'beta/b-1',
  ]);
}, 'a bead in no space answers to "Other", the same as it does in the list');

check(() => {
  assert.deepEqual(keysOf(excludedRinging(cfg, RINGING, { space: 'all', workspace: 'beta' })), [
    'alpha/a-1',
    'gamma/g-1',
  ]);
}, 'a workspace filter excludes by workspace');

check(() => {
  // beta/b-req is a foundation request and is excluded by every one of the filters
  // above — and never appears in any of them, because the inbox draws that channel
  // outside every filter. You have not decided to stop thinking about it.
  const everywhere = [
    { space: 'Work', workspace: 'all' },
    { space: 'Other', workspace: 'all' },
    { space: 'all', workspace: 'beta' },
    { space: 'all', workspace: 'alpha' },
  ];
  for (const f of everywhere) {
    assert.ok(!keysOf(excludedRinging(cfg, RINGING, f)).includes('beta/b-req'), `not offered under ${JSON.stringify(f)}`);
  }
}, 'a foundation request is never offered — its channel is not filtered in the first place');

/* --------------------------------------------------------------- the ask itself */

const ask = (over, extra = {}) =>
  dismissAsk({ cfg, ringing: RINGING, filter: over, shadeSeen: ago(60_000), now: NOW, ...extra });

check(() => {
  const a = ask({ space: 'Work', workspace: 'all' });
  assert.equal(a.count, 2, 'count');
  assert.deepEqual([...a.keys].sort(), ['beta/b-1', 'gamma/g-1'], 'keys');
}, 'narrowing while unread notifications exist for excluded beads asks, with a count');

check(() => {
  assert.equal(ask({ space: 'all', workspace: 'all' }), null);
}, 'a filter change with nothing excluded prompts nothing');

check(() => {
  assert.equal(ask({ space: 'Work', workspace: 'all' }, { ringing: {} }), null);
}, 'and neither does one where nothing was ringing');

check(() => {
  assert.equal(ask({ space: 'Work', workspace: 'all' }, { shadeSeen: null }), null);
  assert.equal(ask({ space: 'Work', workspace: 'all' }, { shadeSeen: ago(SHADE_TTL_MS + 1) }), null);
}, 'with no shade to clear the prompt is silent rather than a button that lies');

check(() => {
  const declined = ['beta/b-1', 'gamma/g-1'];
  assert.equal(ask({ space: 'Work', workspace: 'all' }, { declined }), null);
}, 'declining the whole set stops the ask — this is the re-prompt that must not happen');

check(() => {
  // Declined one of two. The other is still a fresh question and must still be asked,
  // and about *itself* only — re-offering the declined one would be the re-ask again.
  const a = ask({ space: 'Work', workspace: 'all' }, { declined: ['beta/b-1'] });
  assert.equal(a.count, 1);
  assert.deepEqual(a.keys, ['gamma/g-1']);
}, 'a bead excluded after a decline is asked about on its own');

/* --------------------------------------- declining is forgotten when it stops being */

check(() => {
  const excludedUnderWork = excludedRinging(cfg, RINGING, { space: 'Work', workspace: 'all' });
  assert.deepEqual(pruneDeclined(['beta/b-1', 'gamma/g-1'], excludedUnderWork).sort(), ['beta/b-1', 'gamma/g-1']);
  // Widened back to everything: nothing is excluded, so nothing is declined, so
  // narrowing again is a fresh question rather than an inherited silence.
  assert.deepEqual(pruneDeclined(['beta/b-1', 'gamma/g-1'], excludedRinging(cfg, RINGING, { space: 'all', workspace: 'all' })), []);
}, 'a decline lasts exactly as long as the exclusion that prompted it');

check(() => {
  assert.deepEqual(pruneDeclined(['x/1', 'x/1'], [{ key: 'x/1' }]), ['x/1']);
  assert.deepEqual(pruneDeclined(null, null), []);
}, 'pruning deduplicates and survives an empty file');

/* ----------------------------------------------------------------- bookkeeping */

check(() => {
  const r = rangFor({ workspace: 'alpha', id: 'a-9', foundation: true }, NOW);
  assert.deepEqual(r, { workspace: 'alpha', id: 'a-9', foundation: true, at: NOW.toISOString() });
  assert.equal(rangFor({ workspace: 'alpha', id: 'a-9' }, NOW).foundation, false, 'defaults to not a request');
}, 'a record carries what the prompt and the event both need, and nothing else');

check(() => {
  assert.deepEqual(Object.keys(retain(RINGING, ['alpha/a-1'])), ['alpha/a-1']);
  assert.deepEqual(Object.keys(retain(RINGING, new Set())), []);
  assert.deepEqual(Object.keys(drop(RINGING, ['alpha/a-1', 'beta/b-1'])).sort(), ['beta/b-req', 'gamma/g-1']);
}, 'retain keeps what is still in the inbox, drop forgets what has been cleared');

/* ------------------------------------------------------------------ state.json */

fs.rmSync(STATE_PATH, { force: true });
check(() => {
  const s = loadState();
  assert.deepEqual(s.ringing, {}, 'ringing');
  assert.deepEqual(s.ringingDeclined, [], 'ringingDeclined');
  assert.equal(s.shadeSeen, null, 'shadeSeen');
}, 'a fresh install reads as nothing ringing');

fs.writeFileSync(STATE_PATH, JSON.stringify({ ringing: [1, 2], ringingDeclined: 'beta/b-1', shadeSeen: 42 }));
check(() => {
  const s = loadState();
  // Wrong shapes must read as "nothing is ringing", never as "everything is": the
  // cheap failure is a prompt that never appears, and the expensive one is a prompt
  // offering to clear beads it knows nothing about.
  assert.deepEqual(s.ringing, {});
  assert.deepEqual(s.ringingDeclined, []);
  assert.equal(s.shadeSeen, null);
}, 'and so does a file with every field the wrong shape');

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

/** The three beads ringing, with no shade recorded yet. */
const seed = (extra = {}) =>
  saveState({
    filter: { space: 'all', workspace: 'all' },
    ringing: { ...RINGING },
    ringingDeclined: [],
    shadeSeen: null,
    ...extra,
  });

const narrow = (space) => call('/api/filter', { method: 'POST', body: JSON.stringify({ space, workspace: 'all' }) });

seed();
const noShade = await narrow('Work');
check(() => {
  assert.equal(noShade.status, 200);
  assert.equal(noShade.body.dismissAsk, null);
}, 'POST /api/filter says nothing when no client has ever owned a shade');

// The Android watcher's poll, and the only thing that records one. `wait=0` so the
// request does not park for 25 seconds.
await call('/api/poll?shade=1&wait=0');
check(() => {
  assert.ok(loadState().shadeSeen, 'shadeSeen was written');
}, 'a poll that says it owns a shade records one');

seed({ shadeSeen: loadState().shadeSeen });
const narrowed = await narrow('Work');
check(() => {
  assert.equal(narrowed.body.dismissAsk?.count, 2);
  assert.deepEqual([...narrowed.body.dismissAsk.keys].sort(), ['beta/b-1', 'gamma/g-1']);
}, 'and then narrowing the filter asks, on the response to the tap that narrowed it');

const listed = await call('/api/questions');
check(() => {
  assert.equal(listed.body.dismissAsk?.count, 2);
}, 'the inbox payload carries the same ask, so the phone can be asked about a change made elsewhere');

/* the decline */

const left = await call('/api/notifications/dismiss', {
  method: 'POST',
  body: JSON.stringify({ confirm: false, keys: narrowed.body.dismissAsk.keys }),
});
check(() => {
  assert.equal(left.body.left, 2, 'reported');
  assert.equal(left.body.cleared, 0, 'nothing cleared');
  const s = loadState();
  assert.deepEqual([...s.ringingDeclined].sort(), ['beta/b-1', 'gamma/g-1'], 'recorded');
  // The whole point: the notifications are still there, untouched.
  assert.deepEqual(Object.keys(s.ringing).sort(), Object.keys(RINGING).sort(), 'still ringing');
}, 'declining leaves every notification exactly as it was');

const again = await call('/api/questions');
check(() => {
  assert.equal(again.body.dismissAsk, null);
}, 'and the next poll does not re-prompt for the same set');

/* the confirm */

seed({ shadeSeen: loadState().shadeSeen });
const offered = (await narrow('Work')).body.dismissAsk;
// Everything the bus emits from here on, so the events under test cannot be confused
// with the ones the narrowing above may have caused.
const from = app.bus.seq;
const cleared = await call('/api/notifications/dismiss', {
  method: 'POST',
  body: JSON.stringify({ confirm: true, keys: offered.keys }),
});
const seen = (app.bus.since(from) || []).filter((e) => e.type === 'dismissed');
check(() => {
  assert.equal(cleared.body.cleared, 2);
  assert.deepEqual(
    seen.map((e) => e.key).sort(),
    ['beta/b-1', 'gamma/g-1'],
    `one dismissed event each (saw ${JSON.stringify(seen)})`
  );
  assert.ok(
    seen.every((e) => e.workspace && e.id && e.reason === 'filtered'),
    'each names its bead and why'
  );
}, 'confirming emits a dismissed event per bead — its own type, not answered');

check(() => {
  const s = loadState();
  // Cleared from the shade, and out of the bookkeeping with it.
  assert.deepEqual(Object.keys(s.ringing).sort(), ['alpha/a-1', 'beta/b-req'], 'only the untouched ones remain');
  assert.deepEqual(s.ringingDeclined, [], 'nothing left to have declined');
  // And the ask is spent.
  assert.equal(s.filter.space, 'Work', 'the filter itself is unchanged by any of this');
}, 'and the beads it cleared stop being something to ask about');

check(() => {
  // The acceptance criterion this exists to prove: nothing about the tracker moved.
  // `bd` is never called on this path at all — there is no workspace configured on
  // this server, so a call would have thrown — and alpha/a-1, which is inside the
  // filter, still has its notification.
  assert.ok(loadState().ringing['alpha/a-1'], 'a bead inside the filter is never touched');
}, 'notifications for beads still inside the filter are left alone');

const spent = await call('/api/questions');
check(() => {
  assert.equal(spent.body.dismissAsk, null);
}, 'with the excluded ones cleared there is nothing left to ask');

/* a stale keys list */

seed({ shadeSeen: loadState().shadeSeen, filter: { space: 'Work', workspace: 'all' } });
const stale = await call('/api/notifications/dismiss', {
  method: 'POST',
  body: JSON.stringify({ confirm: true, keys: ['alpha/a-1', 'beta/b-req', 'nope/x-1'] }),
});
check(() => {
  assert.equal(stale.body.cleared, 0, 'nothing was cleared');
  assert.deepEqual(Object.keys(loadState().ringing).sort(), Object.keys(RINGING).sort(), 'nothing moved');
}, 'a key that is not currently being asked about cannot be cleared by asking for it');

/* ------------------------------------------- and the poller, which is what records it */
//
// Everything above is worthless if nothing ever writes `ringing`, and that write is
// one line in the middle of the push path — the easiest thing here to lose in a merge
// and the hardest to notice, because losing it makes the prompt simply never appear.
// So this runs the real poller and asks what it wrote down.

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
saveState({ notified: [], commentCounts: {}, ringing: {}, ringingDeclined: [], filter: { space: 'Work', workspace: 'all' } });

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
}, 'a bead that actually rang is written down, so the filter can offer to clear it later');

check(() => {
  // It arrived quietly — nothing lit up for it — so there is no notification to
  // clear and recording one would have the prompt offering to clear silence.
  assert.equal(loadState().ringing['beta/b-new'], undefined);
}, 'a bead the filter kept quiet is not recorded — it never made a noise to clear');

servers.forEach((s) => s.close());
await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
