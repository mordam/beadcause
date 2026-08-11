/**
 * Observer mode — the tests for the one flag whose failure is invisible.
 *
 * Every other switch in beadcause fails loudly: turn off the terminal and the
 * terminal is gone. This one fails by *doing what it always did* — you believe you
 * set it, and thirty seconds later there are two Claude windows open on repos you
 * were not working in. So it gets a test, in a repo that otherwise has none.
 *
 *     npm test
 *
 * `OBSERVING` resolves once, at module load, which is what makes it cheap to ask
 * about everywhere. It also means one process can only ever test one value of it —
 * hence the child processes. The parent sets no expectations about its own env, so
 * this passes whether or not you happen to be running it inside an observer shell.
 *
 * Nothing here touches the network, spawns an agent, or writes outside a temp
 * directory. Where the honest test would be dangerous — "with the flag off, does an
 * advocate really open a window?" — it is deliberately not run, and said so below.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

/* --------------------------------------------------------------- the harness */

const CASES = new Map();
const test = (name, fn) => CASES.set(name, fn);

/** Run one named case in a child, with a clean env plus whatever it needs. */
function child(name, env) {
  return execFileSync(process.execPath, [fileURLToPath(import.meta.url), name], {
    encoding: 'utf8',
    // Built from scratch rather than inherited: a `BEADCAUSE_OBSERVE` already in
    // the shell must not be able to decide the result of a test about it.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

/* ------------------------------------------------------------------ the cases */

test('flag:reads', async () => {
  const probe = `import {OBSERVING} from ${JSON.stringify(LIB('config.js'))}; console.log(OBSERVING);`;
  const read = (env) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    }).trim() === 'true';

  for (const [env, want, what] of [
    [{}, false, 'unset'],
    [{ BEADCAUSE_OBSERVE: '1' }, true, 'BEADCAUSE_OBSERVE=1'],
    [{ BEADCAUSE_OBSERVE: 'yes' }, true, 'any non-empty value'],
    // The second spelling is not a nicety: getting this name wrong is the exact
    // failure the flag exists to prevent, and it would fail by opening windows.
    [{ BEADCAUSE_READONLY: '1' }, true, 'the READONLY spelling'],
    [{ BEADCAUSE_OBSERVE: '' }, false, 'empty means unset'],
    [{ BEADCAUSE_OBSERVE: '0' }, false, '0 means off'],
    [{ BEADCAUSE_OBSERVE: 'false' }, false, 'false means off'],
  ]) {
    assert.equal(read(env), want, `${what} should be ${want}`);
  }
});

test('observing:withholds', async () => {
  const { OBSERVING } = await import(LIB('config.js'));
  const { dispatchReply } = await import(LIB('dispatch.js'));
  const { pushQuestion, pushReply } = await import(LIB('notify.js'));
  const { postQuestion, settleQuestion } = await import(LIB('slack.js'));
  assert.equal(OBSERVING, true, 'this case must run with the flag on');

  // Both subsystems fully ON in the config, so a pass can only come from the flag.
  const cfg = {
    autoDispatch: true,
    autoDispatchExclude: [],
    spaces: [],
    agents: [],
    defaultAgent: 'answerer',
    baseUrl: 'http://127.0.0.1:4372',
    token: 'x',
    ntfy: { enabled: true, topic: 'never-hit', detail: 'full', actionButtons: true },
    // The other delivery surface, and the reason it is here rather than only in
    // test/slack.mjs: an observer is booted from a *copy* of a live config, so its Slack
    // block names the live instance's channel and its state file may name the live
    // instance's posted messages. Two questions in the channel whose buttons answer via
    // two different ports is a worse room than no second instance at all.
    slack: { enabled: true, channel: 'C-NEVER-HIT', apiBase: 'http://127.0.0.1:1/never', botTokenFile: null, buttons: true },
  };
  const q = { key: 'w/x-1', workspace: 'w', id: 'x-1', question: 'x', decision: { options: [] } };

  // Awaited: dispatchReply became async when foundations landed, and an un-awaited
  // promise has no `.dispatched` — it would pass this test by being undefined.
  const d = await dispatchReply(cfg, { name: 'w', dir: '/nonexistent/.beads' }, 'x-1', 'x');
  assert.equal(d.dispatched, false, 'no reply agent may be dispatched');
  assert.match(d.reason, /observing/, `the refusal should name the mode, got: ${d.reason}`);

  // A push that was not skipped would have to reach ntfy.sh to find that out, so
  // `skipped` is the whole assertion.
  assert.equal((await pushQuestion(cfg, q)).skipped, true, 'no question push');
  assert.equal((await pushReply(cfg, q, { author: 'a', text: 't' })).skipped, true, 'no reply push');

  // Same shape of assertion for Slack, and the reason word is the point: `observing` can
  // only come from the gate above the one that reads the token, so this is also the
  // check that an observer touches neither credential. `apiBase` points at a port
  // nothing is listening on, so a post that was not skipped would fail rather than pass.
  assert.equal((await postQuestion(cfg, q)).skipped, 'observing', 'no question posted to Slack');
  assert.equal((await settleQuestion(cfg, q.key)).skipped, 'observing', 'and no message of the live instance rewritten');
});

test('observing:advocate-launches-nothing', async () => {
  const { createAdvocates } = await import(LIB('advocate.js'));
  const workspace = { name: 'w', dir: path.join(os.tmpdir(), 'nonexistent-.beads') };
  const cfg = {
    workspaces: [workspace],
    spaces: [],
    claudeSessions: false,
    // Armed: an advocate allowed to work, with sweeping and logging on. This is the
    // config that opened two windows for real.
    advocates: { enabled: true, workspaces: ['*'], settleSeconds: 0, launchCooldownSeconds: 0 },
  };
  // Two ready beads, old enough to be past `settleSeconds` on any reading of it.
  const ready = [
    { id: 'x-1', title: 'one', priority: 1, created_at: '2020-01-01T00:00:00Z' },
    { id: 'x-2', title: 'two', priority: 2, created_at: '2020-01-01T00:00:00Z' },
  ];
  const bd = { ready: async () => ready, listLabel: async () => [], show: async () => null };

  const advocates = createAdvocates(cfg, { bd, bus: { emit() {} } });
  await advocates.tick();

  const [a] = advocates.snapshot();
  assert.equal(a.queue, 2, 'it must still survey — the queue is the thing you booted it to see');
  assert.equal(a.workers.length, 0, 'it must not have opened a session');
  assert.equal(a.lastLaunchAt, null, 'nothing may have been launched');
  assert.match(a.note, /observing/, `the card should say why, got: ${a.note}`);

  // The mirror image of this — flag off, assert a window DOES open — is the one
  // test not written. It would open a real Claude session in a real repo, which is
  // the incident this whole flag exists because of. The negative control below
  // proves the guards are conditional; that is as close as it is worth getting.
});

test('observing:says-so-on-the-wire', async () => {
  // The badge is only as good as the field behind it, and the field is the only way
  // an instance with no advocates configured says anything at all in the UI.
  const { createApp, listen } = await import(LIB('server.js'));
  // Port 0, not a number typed here: a dozen sessions run this suite at once and the
  // loser of a race for a fixed port exits 1 on an EADDRINUSE that reads like a
  // regression in the flag under test. See test/helpers/net.mjs.
  const cfg = {
    port: 0,
    host: '127.0.0.1',
    token: 'test-token',
    workspaces: [],
    // One space, so the write below has something real to be refused about — a 404
    // would prove nothing about the guard.
    spaces: [{ name: 'Work', workspaces: [] }],
    claudeSessions: false,
    advocates: { enabled: true, workspaces: [] },
    ntfy: {},
  };
  const app = createApp(cfg);
  const servers = listen(cfg, app.handler);
  const port = await boundPort(servers);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/work`, { headers: { 'x-beadcause-token': cfg.token } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).observing, true, '/api/work must say which daemon this is');

    const poll = await fetch(`http://127.0.0.1:${port}/api/poll`, { headers: { 'x-beadcause-token': cfg.token } });
    assert.equal((await poll.json()).observing, true, '/api/poll must say it too — the TUI reads only this one');

    // And the space settings are read-only here, for the reason POST /api/admin is:
    // this instance's `cfg` came off the *real* daemon's config file, so a write from
    // its console would change what the other process does at its next restart while
    // doing nothing at all about what it is doing now.
    const read = await fetch(`http://127.0.0.1:${port}/api/space?space=Work`, {
      headers: { 'x-beadcause-token': cfg.token },
    });
    assert.equal(read.status, 200, 'reading a space is fine — the console is still worth looking at');

    const wrote = await fetch(`http://127.0.0.1:${port}/api/space`, {
      method: 'POST',
      headers: { 'x-beadcause-token': cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify({ space: 'Work', settings: { muted: true } }),
    });
    assert.equal(wrote.status, 403, 'an observer must not write another daemon`s config');
    assert.ok(!cfg.spaces[0].muted, 'and must not have changed the object in memory either');

    // Publishing to Confluence is further out than either of those: a page on a wiki
    // other people read, which no restart takes back. Refused before the config is
    // even consulted, which is what this asserts — there is no `confluence` block in
    // the cfg above, so a 403 here can only be the observer guard.
    const published = await fetch(`http://127.0.0.1:${port}/api/confluence`, {
      method: 'POST',
      headers: { 'x-beadcause-token': cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify({ p: '/tmp/anything.md', spaceKey: 'ENG', title: 'x' }),
    });
    assert.equal(published.status, 403, 'an observer must not publish to a wiki');
    assert.match((await published.json()).error, /observing/, 'and it must say why');
  } finally {
    for (const s of servers) s.close();
  }
});

test('off:acts-normally', async () => {
  const { OBSERVING } = await import(LIB('config.js'));
  const { dispatchReply } = await import(LIB('dispatch.js'));
  const { pushQuestion } = await import(LIB('notify.js'));
  assert.equal(OBSERVING, false, 'this case must run with the flag off');

  // Refused one check further down, so nothing is spawned.
  const d = await dispatchReply(
    { autoDispatch: false, spaces: [], agents: [], defaultAgent: 'answerer' },
    { name: 'w', dir: '/nonexistent/.beads' },
    'x-1',
    'x'
  );
  assert.doesNotMatch(d.reason, /observing/, 'with the flag off the reason must be an ordinary one');
  assert.match(d.reason, /auto-dispatch is off/, `got: ${d.reason}`);

  // Aimed at a closed port on loopback: getting as far as the socket is the
  // assertion, and connection-refused is how that arrives.
  const cfg = {
    baseUrl: 'http://127.0.0.1:4372',
    token: 'x',
    spaces: [],
    ntfy: { enabled: true, topic: 't', server: 'http://127.0.0.1:1', detail: 'minimal', actionButtons: false },
  };
  const q = { key: 'w/x-1', workspace: 'w', id: 'x-1', question: 'x', decision: { options: [] } };
  await assert.rejects(
    () => pushQuestion(cfg, q).then((r) => assert.notEqual(r?.skipped, true, 'must not be skipped')),
    'the push should have been attempted, not skipped'
  );

  // The badge's negative, and the one that matters most: on the LIVE instance the
  // field must be false, so a console can never paint "observing" over a daemon
  // that is in fact opening windows. No advocates are configured here, so this
  // server has nothing it could launch even in principle.
  const { createApp, listen } = await import(LIB('server.js'));
  // Port 0, for the same reason the case above uses one.
  const scfg = {
    port: 0,
    host: '127.0.0.1',
    token: 'test-token',
    workspaces: [],
    spaces: [],
    claudeSessions: false,
    openSessions: false,
    advocates: { enabled: true, workspaces: [] },
    ntfy: {},
  };
  const servers = listen(scfg, createApp(scfg).handler);
  const port = await boundPort(servers);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/work`, { headers: { 'x-beadcause-token': scfg.token } });
    assert.equal((await r.json()).observing, false, 'a live instance must say so plainly, not by omission');
  } finally {
    for (const s of servers) s.close();
  }
});

/* ------------------------------------------------------------------- running */

const only = process.argv[2];
if (only) {
  // A child: run the one case, let a throw be the exit code.
  await CASES.get(only)();
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-test-'));
  const plan = [
    ['flag:reads', {}],
    ['observing:withholds', { BEADCAUSE_OBSERVE: '1' }],
    ['observing:advocate-launches-nothing', { BEADCAUSE_OBSERVE: '1', BEADCAUSE_CONFIG_DIR: tmp }],
    ['observing:says-so-on-the-wire', { BEADCAUSE_OBSERVE: '1', BEADCAUSE_CONFIG_DIR: tmp }],
    ['off:acts-normally', {}],
  ];
  let failed = 0;
  for (const [name, env] of plan) {
    try {
      child(name, env);
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${name}\n${(err.stderr || err.message).toString().trim()}\n`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} of ${plan.length} failed` : `\n${plan.length} passed`);
  process.exit(failed ? 1 : 0);
}
