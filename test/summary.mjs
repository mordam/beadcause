/**
 * The two counts /api/questions carries for the inbox's chrome.
 *
 * "Agents running" and "advocate proposals waiting", as badges on the tabs that answer
 * them. Both come off the poll every client already makes — which is the only reason
 * they are on this endpoint and not on /api/work. So the things worth being sure about
 * are not the arithmetic; they are the three ways this could be quietly wrong:
 *
 * 1. **It costs a `bd` call.** The poll runs every thirty seconds on a phone, and
 *    /api/work is three `bd` calls per workspace. A stub `bd` here logs every
 *    invocation, so a sweep added by accident fails the test rather than showing up
 *    as a slower inbox months later.
 * 2. **The count means different things in different scopes.** The `agent` scope
 *    runs no `human` sweep at all, and a badge that empties when you switch tabs
 *    reads as "answered", not as "not fetched".
 * 3. **The response stopped being additive.** The installed Android build and a
 *    cached service worker both read this endpoint and have never heard of the new
 *    field; every field they did read has to still be there, unchanged.
 *
 * **There was a third count, `questions`, and it is gone** — the number behind the top
 * bar's **N waiting** pill, which bc-ka5y.1 deleted along with the pill. Its absence is
 * asserted below rather than left to the diff: nothing draws it, and a served count
 * nobody draws is one that quietly goes wrong.
 *
 * Nothing here touches the network beyond loopback, spawns an agent, or writes
 * outside a temp directory. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-summary-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load,
// and the point of a test directory is that it is set before it is read.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { createApp, listen } = await import(LIB('server.js'));
const { proposalBody, proposalTitle } = await import(LIB('proposal.js'));

/* ------------------------------------------------------------------ fixtures */

const WS = ['alpha', 'beta'].map((name) => {
  const dir = path.join(tmp, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return { name, dir };
});

const CALLS = path.join(tmp, 'bd-calls.log');

/** One bead as `bd list --json` hands it over. */
const bead = (id, title, { body = '', labels = ['human'] } = {}) => ({
  id,
  title,
  description: body,
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels,
  created_at: '2026-08-08T10:00:00Z',
  updated_at: '2026-08-08T10:00:00Z',
});

/** A real advocate ask, written by the code that writes the real ones. */
function proposal(id, workspace, title) {
  const beads = [{ title, type: 'task', priority: 2, description: 'Something worth doing.', deps: [], labels: [] }];
  return bead(id, proposalTitle(workspace, beads), {
    body: proposalBody(workspace, beads),
    labels: ['human', 'advocate-proposal'],
  });
}

const ROWS = {
  [WS[0].dir]: {
    human: [
      bead('a-1', 'An ordinary question', { body: '```decision\nquestion: Which way?\noptions:\n  - id: y\n    label: Yes\n```' }),
      proposal('a-2', 'alpha', 'File the thing'),
      // A second ask in the same repo. `propose()` files one at a time, so this can
      // only arrive by hand — and one advocate waiting is still the true answer.
      proposal('a-3', 'alpha', 'File the other thing'),
    ],
    agent: [bead('a-9', 'Some work nobody is asking about', { labels: [] })],
  },
  [WS[1].dir]: {
    human: [
      proposal('b-1', 'beta', 'File something in beta'),
      // The other channel. It arrives on the same `bd human list` and is split out
      // of it — and it has a badge of its own on the ⚖️ in the bar, which is why
      // the waiting count must not also claim it.
      bead('b-2', 'An agent asking to be different', { labels: ['human', 'foundation'] }),
    ],
    agent: [],
  },
};

/**
 * A `bd` that answers from the fixture and records that it was asked.
 *
 * `.cjs` deliberately: it is spawned by absolute path from a temp directory, and the
 * extension is the only thing that settles how node parses it.
 */
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const rows = ${JSON.stringify(ROWS)};
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ dir: process.env.BEADS_DIR, args }) + '\\n');
const set = rows[process.env.BEADS_DIR] || {};
let out = [];
if (args[0] === 'human' && args[1] === 'list') out = set.human || [];
// The foundation channel: no agent is asking to be different in this fixture.
else if (args[0] === 'list' && args.includes('--label')) out = [];
else if (args[0] === 'list') out = set.agent || [];
console.log(JSON.stringify(out));
`,
  { mode: 0o755 }
);

/** Records outlive their process, so only the pid separates running from ran. */
const SESSIONS = path.join(tmp, 'sessions');
fs.mkdirSync(SESSIONS, { recursive: true });

const deadPid = (() => {
  for (let pid = 99990; pid > 1024; pid--) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not find a pid that is not running');
})();

for (const [pid, name] of [
  [process.pid, 'Beadcause - the test itself'],
  [process.ppid, 'Beadcause - whatever ran it'],
  [deadPid, 'Beadcause - finished on Tuesday'],
]) {
  fs.writeFileSync(
    path.join(SESSIONS, `${pid}.json`),
    JSON.stringify({ pid, sessionId: `s-${pid}`, name, cwd: tmp, status: 'idle', startedAt: Date.now() })
  );
}

// Port 0, never a number typed here: a dozen sessions run this suite at once and a
// fixed port makes the loser of that race exit 1 on an EADDRINUSE that reads like a
// regression. `createApp` never looks at cfg.port — only `listen` does — so the
// server is started here and the port read back off it. See test/helpers/net.mjs.
const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'test-token',
  bdBin: BD,
  actor: 'beadcause-test',
  workspaces: WS,
  spaces: [],
  claudeSessionsDir: SESSIONS,
  advocates: { enabled: false, workspaces: [] },
  openSessions: false,
  agents: [],
  ntfy: {},
};

const servers = listen(cfg, createApp(cfg).handler);
const PORT = await boundPort(servers);

const get = async (query = '') => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/questions${query}`, {
    headers: { 'x-beadcause-token': cfg.token },
  });
  assert.equal(res.status, 200, `GET /api/questions${query} should be 200`);
  return res.json();
};

const calls = () =>
  fs
    .readFileSync(CALLS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

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
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

/* --------------------------------------------------------------------- cases */

console.log('questions summary');

try {
  const human = await get();

  await check('counts the live sessions, and only the live ones', () => {
    assert.ok(human.summary, 'the response must carry a summary object');
    assert.equal(human.summary.sessions, 2, 'the record whose process is gone must not be counted');
  });

  await check('counts advocates waiting, not proposals waiting', () => {
    const asks = human.questions.filter((q) => q.proposal);
    assert.equal(asks.length, 3, 'the fixture should have three proposal-shaped beads');
    assert.equal(human.summary.proposals, 2, 'two repos are waiting on an answer, not three beads');
  });

  await check('does not count the beads asking you something — nothing draws that', () => {
    assert.ok(!('questions' in human.summary), `the N waiting count is back: ${JSON.stringify(human.summary)}`);
    // The list is still there, and it is what the number used to restate.
    assert.equal(human.questions.length, 4, 'four questions are waiting — the foundation bead is not one');
  });

  await check('adds no bd call to the poll', () => {
    const before = calls();
    assert.equal(before.length, WS.length, `the sweep is one call per workspace, got ${before.length}`);
    assert.ok(
      before.every((c) => c.args[0] === 'human' && c.args[1] === 'list'),
      `only the human sweep should have run, got ${JSON.stringify(before.map((c) => c.args.slice(0, 2)))}`
    );
  });

  await check('an older client sees exactly what it always did', () => {
    for (const field of ['questions', 'requests', 'workspaces', 'spaces', 'scope']) {
      assert.ok(field in human, `${field} must still be served`);
    }
    assert.equal(human.scope, 'human');
    assert.deepEqual(human.workspaces, ['alpha', 'beta']);
    assert.equal(human.questions.length, 4, 'every human bead should still be in the list');
    assert.equal(human.requests.length, 1, 'the foundation bead belongs to the other channel');
    // The summary is its own object rather than fields spread across the top level,
    // so a client reading the response by key cannot collide with it.
    assert.equal(typeof human.summary, 'object');
  });

  await check('the counts survive a scope that sweeps no questions', async () => {
    const agent = await get('?scope=agent');
    assert.ok(
      agent.questions.every((q) => !q.proposal),
      'this scope runs no human sweep, so nothing in it can be an ask — that is the point'
    );
    assert.equal(agent.summary.proposals, 2, 'the badge must not empty out when you switch tabs');
    assert.equal(agent.summary.sessions, 2, 'sessions come off the filesystem, so every scope has them');
  });

  await check('an unknown scope still gets the summary', async () => {
    const old = await get('?scope=nonsense');
    assert.equal(old.scope, 'human', 'an unrecognised scope falls back rather than failing');
    assert.equal(old.summary.proposals, 2);
  });
} finally {
  for (const s of servers) s.close();
  await cleanupTmp(tmp);
}

console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
