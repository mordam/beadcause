#!/usr/bin/env node
//
// The inbox filter, which lives on the server rather than in localStorage.
//
//   npm test                     (runs it alongside the rest)
//   node test/filter.mjs
//
// Two failures are worth having a suite for, and neither is visible by reading
// one function:
//
// 1. **The poll used to clobber it.** Four call sites in lib/server.js save
//    `{ notified, commentCounts }`, and saveState replaced the file wholesale, so
//    the very next sweep dropped any key a client had written. The filter is the
//    first field in state.json with two writers, so it is the first to notice.
//
// 2. **An unreadable state file must read as "no filter".** loadState's fallback
//    was `{ notified: [] }`, which returns `filter: undefined` — and a filter that
//    arrives empty rather than absent hides every bead in the inbox with nothing
//    on screen to say why.
//
// 3. **A saved filter outlives the config it was picked under.** A renamed space, a
//    dropped workspace, or a workspace moved between spaces all show the same way:
//    an empty list with no chip pressed to explain it. reconcileFilter is what the
//    server applies on the way out — and it matters beyond the chips, because the
//    push path reads state.json directly, with no client in the loop to correct it.
//
// The HTTP half proves the round trip the client actually uses: the filter is
// carried on the same payload as the questions, because a second fetch would paint
// the unfiltered list first and then snatch it away.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-filter-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { loadState, saveState, STATE_PATH } = await import(LIB('config.js'));

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

const writeRaw = (obj) => fs.writeFileSync(STATE_PATH, typeof obj === 'string' ? obj : JSON.stringify(obj));

console.log('inbox filter');

/* ------------------------------------------------------------ the defaults */

fs.rmSync(STATE_PATH, { force: true });
check(() => {
  assert.deepEqual(loadState().filter, { space: 'all', workspace: 'all' });
}, 'no state file at all reads as no filter, not an empty one');

writeRaw('{"notified": [');
check(() => {
  assert.deepEqual(loadState().filter, { space: 'all', workspace: 'all' });
}, 'and so does a half-written file');

writeRaw({ notified: [], filter: { space: 'personal' } });
check(() => {
  assert.deepEqual(loadState().filter, { space: 'personal', workspace: 'all' });
}, 'a filter missing one half keeps the half it has and defaults the other');

writeRaw({ notified: [], filter: 'personal' });
check(() => {
  assert.deepEqual(loadState().filter, { space: 'all', workspace: 'all' });
}, 'a filter of the wrong shape entirely falls back rather than throwing');

/* ------------------------------------------------- the clobber, both ways */

fs.rmSync(STATE_PATH, { force: true });
saveState({ notified: ['a-1'], commentCounts: { 'a-1': 2 } });
saveState({ filter: { space: 'personal', workspace: 'sophab' } });
check(() => {
  const s = loadState();
  assert.deepEqual(s.notified, ['a-1'], 'notified');
  assert.deepEqual(s.commentCounts, { 'a-1': 2 }, 'commentCounts');
  assert.deepEqual(s.filter, { space: 'personal', workspace: 'sophab' }, 'filter');
}, 'writing a filter keeps notified and commentCounts');

// The regression that matters: this is the exact literal all four poll call sites
// pass, and before saveState merged it wiped the filter on the next sweep.
saveState({ notified: ['a-1', 'a-2'], commentCounts: { 'a-1': 3 } });
check(() => {
  const s = loadState();
  assert.deepEqual(s.filter, { space: 'personal', workspace: 'sophab' }, 'filter survived the poll');
  assert.deepEqual(s.notified, ['a-1', 'a-2'], 'notified still updated');
}, 'and a poll write keeps the filter — the four saveState sites no longer clobber');

/* ----------------------------------------------------------- the round trip */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'filter-test-token',
  actor: 'beadcause-test',
  workspaces: [],
  openSessions: false,
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

const call = (pathname, opts = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

const posted = await call('/api/filter', { method: 'POST', body: JSON.stringify({ space: 'work', workspace: 'climative' }) });
check(() => {
  assert.equal(posted.status, 200);
  assert.deepEqual(JSON.parse(posted.body).filter, { space: 'work', workspace: 'climative' });
}, 'POST /api/filter stores a filter and echoes it back');

check(() => {
  assert.deepEqual(loadState().filter, { space: 'work', workspace: 'climative' });
}, 'and it survives to disk, so a restart comes back to it');

const listed = await call('/api/questions');
check(() => {
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.body).filter, { space: 'work', workspace: 'climative' });
}, 'the inbox payload carries it, so the first render is already filtered');

const blanked = await call('/api/filter', { method: 'POST', body: JSON.stringify({}) });
check(() => {
  assert.deepEqual(JSON.parse(blanked.body).filter, { space: 'all', workspace: 'all' });
  assert.deepEqual(loadState().filter, { space: 'all', workspace: 'all' });
}, 'an empty write clears back to All rather than storing undefined');

const oversized = await call('/api/filter', {
  method: 'POST',
  body: JSON.stringify({ space: 'x'.repeat(500), workspace: 'ok' }),
});
check(() => {
  // The poll rewrites state.json every thirty seconds, so an unbounded name from a
  // junk body is a cost paid on every tick forever. Coerced, not refused — the client
  // can only send a chip that was on its screen, so a 400 here would be noise.
  assert.equal(JSON.parse(oversized.body).filter.space, 'all');
  assert.equal(loadState().filter.space, 'all');
}, 'an absurdly long name is coerced rather than stored');

/* ------------------------------------------- staleness, against a real setup */

const { summarise, reconcileFilter } = await import(LIB('spaces.js'));

// Two configured spaces plus a workspace assigned to neither, which is what makes
// summarise() emit the synthetic "Other" group.
const spacesCfg = {
  spaces: [
    { name: 'Work', workspaces: ['alpha'] },
    { name: 'Personal', workspaces: ['beta'] },
  ],
};
const SPACES = summarise(spacesCfg, [{ workspace: 'alpha' }, { workspace: 'beta' }, { workspace: 'gamma' }]);
const NAMES = ['alpha', 'beta', 'gamma'];
const rf = (f) => reconcileFilter(SPACES, NAMES, f);

check(() => {
  assert.deepEqual(rf({ space: 'Work', workspace: 'alpha' }), { space: 'Work', workspace: 'alpha' });
}, 'a filter naming things that still exist is left alone');

check(() => {
  // The space is gone, but the workspace still names something real — that is a
  // filter you can read off the screen, so only the dead half falls back.
  assert.deepEqual(rf({ space: 'Renamed', workspace: 'beta' }), { space: 'all', workspace: 'beta' });
}, 'a space that has gone falls back on its own, keeping a live workspace');

check(() => {
  assert.deepEqual(rf({ space: 'Work', workspace: 'deleted' }), { space: 'Work', workspace: 'all' });
}, 'a workspace that has gone falls back');

check(() => {
  // Both halves name something real and together they match nothing. This is the
  // case the client-side reconciliation does not catch.
  assert.deepEqual(rf({ space: 'Work', workspace: 'beta' }), { space: 'Work', workspace: 'all' });
}, 'a workspace that has moved out of the filtered space falls back');

check(() => {
  assert.ok(SPACES.some((s) => s.name === 'Other'), 'the fixture should produce an Other group');
  // Not in cfg.spaces at all — validating against the config rather than summarise()
  // would silently drop this filter on every single load.
  assert.deepEqual(rf({ space: 'Other', workspace: 'gamma' }), { space: 'Other', workspace: 'gamma' });
}, 'the synthetic "Other" group is a space you can stay filtered to');

check(() => {
  assert.deepEqual(rf({ space: 'all', workspace: 'all' }), { space: 'all', workspace: 'all' });
  assert.deepEqual(rf(null), { space: 'all', workspace: 'all' });
  assert.deepEqual(rf({ space: 42, workspace: [] }), { space: 'all', workspace: 'all' });
}, 'nothing picked, and junk, both read as everything');

check(() => {
  // The distinction the whole guard turns on: no spaces configured is not the same
  // as every space having vanished. An install with no spaces set up never draws the
  // row, and resetting a saved value on that basis would be guessing.
  assert.deepEqual(reconcileFilter([], [], { space: 'work', workspace: 'climative' }), {
    space: 'work',
    workspace: 'climative',
  });
}, 'an unconfigured install is left alone rather than reset');

/* ------------------------------------------- the filter as an input to the push */

const { matchesFilter, quietReasonFor, describeFilter } = await import(LIB('spaces.js'));
// The filter-change prompt's own view of what the filter excludes, asserted at the end
// of the poller run: the push and the prompt have to agree about this channel.
const { excludedRinging } = await import(LIB('ringing.js'));

// One space muted, one not, and a workspace in neither — the three states a bead can
// be pushed from.
const pushCfg = {
  spaces: [
    { name: 'Work', workspaces: ['alpha'] },
    { name: 'Personal', workspaces: ['beta'], muted: true },
  ],
};
const bead = (workspace, space) => ({ key: `${workspace}/x-1`, workspace, space });

check(() => {
  assert.equal(matchesFilter({ space: 'all', workspace: 'all' }, bead('alpha', 'Work')), true);
  assert.equal(matchesFilter({ space: 'Work', workspace: 'all' }, bead('alpha', 'Work')), true);
  assert.equal(matchesFilter({ space: 'Work', workspace: 'all' }, bead('beta', 'Personal')), false);
  assert.equal(matchesFilter({ space: 'all', workspace: 'alpha' }, bead('beta', 'Personal')), false);
  assert.equal(matchesFilter({ space: 'Work', workspace: 'beta' }, bead('beta', 'Personal')), false);
}, 'a bead is in the filter only when both halves say so');

check(() => {
  // The same fallback the inbox's own spaceOf makes. If these two disagreed the phone
  // would go quiet for a bead it is showing you, which is the one outcome that reads
  // as a lost question rather than a quiet one.
  assert.equal(matchesFilter({ space: 'Other', workspace: 'all' }, bead('gamma', null)), true);
  assert.equal(matchesFilter({ space: 'Work', workspace: 'all' }, bead('gamma', null)), false);
}, 'a bead in no configured space answers to "Other", exactly as the list does');

check(() => {
  assert.equal(quietReasonFor(pushCfg, { space: 'all', workspace: 'all' }, bead('alpha', 'Work')), null);
  assert.equal(quietReasonFor(pushCfg, { space: 'Work', workspace: 'all' }, bead('beta', 'Personal')), 'filtered');
  assert.equal(quietReasonFor(pushCfg, { space: 'all', workspace: 'all' }, bead('beta', 'Personal')), 'muted');
  // Both at once. Quiet either way, and reported as the half you can see pressed on
  // the screen and undo in a tap.
  assert.equal(quietReasonFor(pushCfg, { space: 'Work', workspace: 'alpha' }, bead('beta', 'Personal')), 'filtered');
}, 'the two reasons stay distinguishable, and the filter is the one reported');

/* ------------------------------------ except the channel the filter does not reach */
//
// bc-8on. The inbox draws the foundation channel above the list and outside every
// filter on it, and the filter-change prompt leaves its notifications alone — so a
// push that honoured the filter here produced the one state the contract exists to
// prevent: a request visible on the screen and silent on the phone, with no widening
// left that would bring it back. The filter's two levels answer "which of my lives is
// this about", and an agent's definition is not in one of them.

const request = (workspace, space) => ({
  key: `${workspace}/x-2`,
  workspace,
  space,
  foundation: true,
  amendment: { agent: 'critic', scope: 'may run git log' },
});

check(() => {
  // The same bead in the same excluded workspace: a question is filtered, a request
  // is not. Nothing else about the two differs.
  assert.equal(quietReasonFor(pushCfg, { space: 'Work', workspace: 'all' }, bead('alpha2', null)), 'filtered');
  assert.equal(quietReasonFor(pushCfg, { space: 'Work', workspace: 'all' }, request('alpha2', null)), null);
  assert.equal(quietReasonFor(pushCfg, { space: 'Work', workspace: 'alpha' }, request('alpha2', null)), null);
}, 'a foundation request outside the filter still rings — the filter does not reach that channel');

check(() => {
  // The asymmetry is the decision, not an oversight: a mute is about whether anything
  // may reach you right now, which is true of a constitutional request too.
  assert.equal(quietReasonFor(pushCfg, { space: 'all', workspace: 'all' }, request('beta', 'Personal')), 'muted');
  // And a muted space wins even when the filter would also have excluded it, because
  // the filter no longer has an opinion about this channel at all.
  assert.equal(quietReasonFor(pushCfg, { space: 'Work', workspace: 'alpha' }, request('beta', 'Personal')), 'muted');
}, 'but a mute still quietens one — that half is about your evening, not about which life');

check(() => {
  // matchesFilter stays the plain two-level test. The exemption belongs to "may this
  // interrupt me", not to "is this bead in the filtered list" — and `excludedRinging`
  // in lib/ringing.js calls the plain one after dropping foundation rows itself.
  assert.equal(matchesFilter({ space: 'Work', workspace: 'all' }, request('beta', 'Personal')), false);
}, 'and matchesFilter is left alone — the exemption is about interruption, not membership');

check(() => {
  assert.equal(describeFilter({ space: 'Work', workspace: 'alpha' }), 'Work / alpha');
  assert.equal(describeFilter({ space: 'Work', workspace: 'all' }), 'Work');
  assert.equal(describeFilter({ space: 'all', workspace: 'all' }), 'all');
  assert.equal(describeFilter(null), 'all');
}, 'the log line says what the filter was set to');

/* ------------------------------------------ and the poller, end to end, for real */
//
// The unit tests above prove the decision. This proves the wiring, which is where
// this feature can only fail one of two ways — a phone that never rings again, or a
// filter that turns out to be a view after all — and neither is visible by reading
// the function that decides.
//
// Everything here is the real poller: the real `tick`, the real reconciliation, the
// real ntfy client, pointed at a server that writes down what it was sent.

const { startPoller } = await import(LIB('server.js'));
const { createEventBus } = await import(LIB('events.js'));

const sent = [];
const ntfy = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      sent.push(JSON.parse(body));
    } catch {
      sent.push({ unparseable: body });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
const ntfyPort = ntfy.address().port;

// Filtered to Work, which holds alpha and not beta. Written before the poller starts,
// exactly as a phone would have left it.
saveState({ notified: [], commentCounts: {}, filter: { space: 'Work', workspace: 'all' } });

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

// Present from the first tick, so the poller baselines their comment counts and a
// later comment reads as an agent replying rather than as backlog.
const replied = [
  q('alpha', 'Work', 'a-reply', { awaitingAgent: true }),
  q('beta', 'Personal', 'b-reply', { awaitingAgent: true }),
  // In the excluded workspace and in the other channel, so its reply proves the
  // exemption travels down the reply path off the same `q.foundation` — checkReplies
  // has no filter branch of its own, and must not grow one.
  q('beta', 'Personal', 'b-freply', {
    awaitingAgent: true,
    foundation: true,
    amendment: { agent: 'critic', scope: 'b-freply may run git log' },
  }),
];
let comments = 1;
let inbox = [...replied];

const pollCfg = {
  baseUrl: 'http://127.0.0.1',
  token: 'filter-test-token',
  actor: 'beadcause-test',
  workspaces: [{ name: 'alpha' }, { name: 'beta' }],
  spaces: [
    { name: 'Work', workspaces: ['alpha'] },
    { name: 'Personal', workspaces: ['beta'] },
  ],
  pollSeconds: 5,
  autoDispatch: false,
  ntfy: { enabled: true, topic: 'filter-test', server: `http://127.0.0.1:${ntfyPort}`, actionButtons: false },
};

const bus = createEventBus();
const pollApp = {
  bus,
  hooks: {},
  bd: {
    comments: async () =>
      Array.from({ length: comments }, (_, i) => ({ author: 'agent', text: `turn ${i + 1}` })),
    removeLabel: async () => {},
  },
  allQuestions: async () => inbox,
};

const timer = startPoller(pollCfg, pollApp);

// The first cycle is the baseline sweep — it pushes nothing by design. Wait for it to
// have read the comment counts before moving the fixture underneath it.
const settled = async (fn, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
await settled(() => bus.seq > 0 || sent.length > 0 || loadState().notified.length === replied.length);

// Now the thing to be notified about, or not: one fresh question in each workspace,
// a fresh foundation request in the excluded one, and a reply on each watched thread.
comments = 2;
inbox = [
  ...replied,
  q('alpha', 'Work', 'a-new'),
  q('beta', 'Personal', 'b-new'),
  q('beta', 'Personal', 'b-found', {
    foundation: true,
    amendment: { agent: 'critic', scope: 'b-found may run git log' },
  }),
];

const events = () => bus.since(0) || [];
const found = (type, key) => events().find((e) => e.type === type && e.key === key);
const gotAll = await settled(
  () =>
    found('question', 'alpha/a-new') &&
    found('question', 'beta/b-new') &&
    found('foundation-request', 'beta/b-found') &&
    found('reply', 'alpha/a-reply') &&
    found('reply', 'beta/b-reply') &&
    found('foundation-reply', 'beta/b-freply')
);
// A little slack after the last event, so a push that was going to happen has had its
// chance to. Asserting "nothing was sent" the instant the event lands would pass on a
// race rather than on the behaviour.
await new Promise((r) => setTimeout(r, 300));
clearInterval(timer);
ntfy.close();

check(() => {
  assert.ok(gotAll, `all six events arrived (saw ${events().map((e) => `${e.type}:${e.key}`).join(', ')})`);
}, 'every bead still emits its event — filtering quietens, it never drops');

check(() => {
  const e = found('question', 'beta/b-new');
  assert.equal(e.quiet, true, 'quiet');
  assert.equal(e.quietReason, 'filtered', 'quietReason');
  assert.ok(
    !sent.some((p) => JSON.stringify(p).includes('b-new')),
    `nothing was pushed for it (sent: ${JSON.stringify(sent)})`
  );
}, 'a fresh bead outside the filter arrives with no ntfy push at all');

check(() => {
  const e = found('question', 'alpha/a-new');
  assert.equal(e.quiet, false, 'quiet');
  assert.equal(e.quietReason, null, 'quietReason');
  assert.ok(sent.some((p) => String(p.title).includes('a-new')), 'it was pushed');
}, 'a fresh bead inside the filter notifies exactly as before');

check(() => {
  const e = found('reply', 'beta/b-reply');
  assert.equal(e.quiet, true, 'quiet');
  assert.equal(e.quietReason, 'filtered', 'quietReason');
  assert.ok(
    !sent.some((p) => JSON.stringify(p).includes('b-reply')),
    'no reply push either'
  );
}, 'a reply is as quiet as the bead it is on');

check(() => {
  const e = found('reply', 'alpha/a-reply');
  assert.equal(e.quiet, false, 'quiet');
  assert.ok(sent.some((p) => String(p.title).includes('a-reply')), 'the in-filter reply was pushed');
}, 'and a reply inside the filter still gets through');

check(() => {
  // bc-8on, end to end: the same workspace as `b-new`, under the same filter, and
  // this one rings. The push is `pushFoundationRequest`, so what lands is the ⚖️
  // title and the scope rather than the bead's own question.
  const e = found('foundation-request', 'beta/b-found');
  assert.equal(e.quiet, false, 'quiet');
  assert.equal(e.quietReason, null, 'quietReason');
  assert.ok(
    sent.some((p) => String(p.message).includes('b-found')),
    `it was pushed (sent: ${JSON.stringify(sent)})`
  );
}, 'a foundation request in a filtered-out workspace rings anyway');

check(() => {
  const e = found('foundation-reply', 'beta/b-freply');
  assert.equal(e.quiet, false, 'quiet');
  assert.equal(e.quietReason, null, 'quietReason');
  assert.ok(
    sent.some((p) => JSON.stringify(p).includes('b-freply')),
    `the reply was pushed too (sent: ${JSON.stringify(sent)})`
  );
}, 'and a reply on one is as loud as the request it is on');

check(() => {
  // The other half of the contract this change leans on: a request that rang is not
  // something narrowing the filter can offer to clear, because narrowing never hid
  // it. `rangFor` carries `foundation` for exactly this, and `excludedRinging` drops
  // it — so the record being written is the same record that gets skipped.
  const ringing = loadState().ringing || {};
  assert.equal(ringing['beta/b-found']?.foundation, true, 'the request is recorded as ringing, and as foundation');
  assert.ok(!ringing['beta/b-new'], 'the filtered-out question never rang, so it has no record');
  assert.deepEqual(
    excludedRinging(pollCfg, ringing, { space: 'Work', workspace: 'all' }).map((e) => e.key),
    [],
    'and the filter-change prompt has nothing to offer about it'
  );
}, 'the notification it made is not one the filter can later offer to clear');

/* ----------------------------------------------------- hygiene, cheap and blunt */

check(() => {
  // Not about the filter, and here because writing this feature is what produced one:
  // a NUL inside a template literal is legal JavaScript, runs perfectly, and turns the
  // file binary — grep then matches nothing in it and says nothing about why. A bad
  // half-hour for a person, and a silently wrong answer for an agent.
  const bad = [];
  for (const root of ['lib', 'public']) {
    const dir = path.join(HERE, '..', root);
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(js|mjs)$/.test(f)) continue;
      const buf = fs.readFileSync(path.join(dir, f));
      const at = buf.findIndex((b) => b < 32 && b !== 9 && b !== 10 && b !== 13);
      if (at >= 0) bad.push(`${root}/${f} byte ${at} = 0x${buf[at].toString(16)}`);
    }
  }
  assert.deepEqual(bad, [], `control bytes found: ${bad.join(', ')}`);
}, 'no source file carries an invisible control byte');

servers.forEach((s) => s.close());
await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
