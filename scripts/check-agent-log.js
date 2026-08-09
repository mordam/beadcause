#!/usr/bin/env node
/**
 * The one contract the phone's session-log pane rests on: `/api/agent-log`.
 *
 * This is not the test suite — there isn't one yet. It is the checks for the code
 * around the agent log, because the pane's whole behaviour (keep tailing, or stop
 * and leave the log readable) is decided by what this endpoint returns, and that
 * is not something you can see by looking at it.
 *
 * It runs against a throwaway `BEADCAUSE_CONFIG_DIR` on an ephemeral port, so it
 * never reads or writes the running daemon's config, status or logs — `npm run
 * check` is safe with beadcause up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-check-'));
// Set before lib/config.js is first imported — CONFIG_DIR is read at module load.
process.env.BEADCAUSE_CONFIG_DIR = tmp;

const { createApp } = await import(path.join(repo, 'lib/server.js'));
const agentlog = await import(path.join(repo, 'lib/agentlog.js'));
const activity = await import(path.join(repo, 'lib/activity.js'));

const cfg = {
  token: 'test-token',
  // Nothing here reaches bd; a binary that always fails makes sure of it.
  bdBin: '/bin/false',
  actor: 'checker',
  workspaces: [{ name: 'acme', dir: path.join(tmp, 'acme') }],
  assetRoots: [],
  autoDispatch: false,
};

const app = createApp(cfg);
const server = http.createServer(app.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const get = async (p) => {
  const res = await fetch(base + p, { headers: { 'x-beadcause-token': cfg.token } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
};

await check('health answers without a token', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).workspaces, ['acme']);
});

await check('agent-log rejects anything that is not a bead id', async () => {
  assert.equal((await get('/api/agent-log?workspace=acme&id=../etc/passwd')).status, 400);
});

await check('a bead nothing has run on is empty, and not running', async () => {
  const { status, body } = await get('/api/agent-log?workspace=acme&id=ac-abc');
  assert.equal(status, 200);
  assert.deepEqual(body.lines, []);
  // The pane says "no agent has run on it" off this, and stops asking.
  assert.equal(body.running, false);
});

await check('the tail is what the dispatcher appended', async () => {
  agentlog.reset('acme/ac-abc');
  agentlog.append('acme/ac-abc', '● dispatched in /tmp/acme');
  agentlog.append('acme/ac-abc', '  > Bash bd show ac-abc');
  const { body } = await get('/api/agent-log?workspace=acme&id=ac-abc');
  assert.deepEqual(body.lines, ['● dispatched in /tmp/acme', '  > Bash bd show ac-abc']);
});

await check('running follows the activity store, both ways', async () => {
  activity.setActivity('acme/ac-abc', { phase: 'thinking', detail: 'picking up your comment' });
  let { body } = await get('/api/agent-log?workspace=acme&id=ac-abc');
  assert.equal(body.running, true, 'an agent is thinking — the pane must keep polling');
  assert.equal(body.phase, 'thinking');

  // What dispatchReply does when the child exits cleanly.
  activity.clearActivity('acme/ac-abc');
  ({ body } = await get('/api/agent-log?workspace=acme&id=ac-abc'));
  assert.equal(body.running, false, 'the run is over — the pane must stop polling');
  assert.equal(body.lines.length, 2, 'and the log it left behind is still readable');

  // A failed run keeps its phase on purpose, so the failure stays on the card. It
  // must not leave the pane polling a file that will never change again.
  activity.setActivity('acme/ac-abc', { phase: 'blocked', detail: 'agent failed' });
  ({ body } = await get('/api/agent-log?workspace=acme&id=ac-abc'));
  assert.equal(body.running, false);
  activity.clearActivity('acme/ac-abc');
});

await check('stream-json events render as the lines a terminal would have shown', () => {
  const { renderEvent } = agentlog;
  assert.match(
    renderEvent({ type: 'system', subtype: 'init', session_id: '4f1c9a2bxx', model: 'opus', cwd: '/x' }),
    /● session 4f1c9a2b · opus · cwd \/x/
  );
  assert.equal(
    renderEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bd show ac-abc' } }] },
    }),
    '  > Bash bd show ac-abc'
  );
  assert.match(
    renderEvent({ type: 'result', is_error: false, duration_ms: 47000, total_cost_usd: 0.0231 }),
    /● done · 47s · \$0\.0231/
  );
  assert.equal(renderEvent({ type: 'something_new' }), null, 'unknown events draw nothing, not raw JSON');
});

await check('a byte-capped tail never returns half a line', () => {
  agentlog.reset('acme/ac-xyz');
  for (let i = 0; i < 50; i++) agentlog.append('acme/ac-xyz', `line ${i} ${'x'.repeat(100)}`);
  const lines = agentlog.tail('acme/ac-xyz', { maxBytes: 500 });
  assert.ok(lines.length > 0);
  for (const l of lines) assert.match(l, /^line \d+ x+$/, `half a line leaked through: ${l}`);
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
