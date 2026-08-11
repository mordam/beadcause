#!/usr/bin/env node
/**
 * Talking about an unendorsed bead — and the bead being exactly as unendorsed afterwards.
 *
 *     npm test
 *     node test/discuss.mjs
 *
 * test/verdicts.mjs proves the four ways out of the hold. This is the fifth thing you can
 * do to a held bead, and it is the only one that is *not* a way out: you ask a question,
 * an agent answers on the thread, and the bead is still waiting on you at the end of it.
 * Which means the whole of what can go wrong here is the conversation quietly deciding
 * something — a marker dropped, a bead closed, a replacement filed — and none of those
 * would look like a failure from the phone. They would look like the queue working.
 *
 * What is asserted, and why each is here rather than assumed:
 *
 * 1. **The marker survives, and so does everything else on the bead.** A comment is the
 *    only write. If a discussion could endorse by accident, "endorse it" would be a
 *    formality performed after an hour of unattended agent had already gone on it.
 * 2. **The agent could not resolve it even if it tried.** The prohibition in the prompt
 *    is the courtesy; the allowlist is the guard. `bd label`, `bd update`, `bd close`,
 *    `bd create` and `bd delete` are not on `DEFAULT_TOOL_LIST` — asserted here rather
 *    than trusted, because that list is one glob away from including all five (bc-1f99,
 *    bc-ec6) and this feature is the one that would make the hole load-bearing.
 * 3. **A bead endorsed since the queue was drawn is refused, before anything is written.**
 *    The same 409 revoke and ask-for-changes give, for the same stale-list reason: a
 *    question typed at work that has already been approved reads as if it had not been.
 * 4. **One bead at a time.** Every verdict takes a list because "endorse these five" is a
 *    real morning; one question typed at six beads is a question about none of them.
 * 5. **The row says the thread exists.** The acceptance criterion that is easiest to
 *    quietly not do: the queue is cached for a few seconds, so a bead you have just asked
 *    about must not come back from `/api/unendorsed` still reading as untouched.
 * 6. **Who said what.** A comment's author is a bare string — `bd comment --actor` — so
 *    an agent's reply is only distinguishable from yours by the roster, and an agent you
 *    have since deleted must keep its own name rather than being relabelled the default.
 *
 * No real tracker and no agent: `bd` is a stub binary over a JSON file, and the config
 * has `autoDispatch: false`, which is the one arrangement where the route's dispatch half
 * can be exercised without spawning a model — it reports that nobody was sent, and the
 * comment still lands. That is also a real state (a shared workspace, an observer
 * instance), and the route's answer is asserted to say so rather than to claim an agent
 * is coming.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-discuss-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const { FILED_LABEL } = await import(LIB('filing.js'));
// lib/foundation.js FIRST, and this is not a style choice: it and lib/agents.js are a
// cycle — foundation reads `DEFAULT_TOOL_LIST` at module scope and agents imports `mark`
// back — so whichever of the two is evaluated first decides whether the pair loads at
// all. Reach agents.js first and it dies on `Cannot access 'DEFAULT_TOOL_LIST' before
// initialization`, which is a real thing `node -e "import('./lib/agents.js')"` does today
// and has nothing to do with this feature. Every suite that touches the roster already
// opens this way (test/browse.mjs, test/lookup.mjs, test/agentchats.mjs); saying why here
// because the next person to add one will not guess it from the failure.
await import(LIB('foundation.js'));
const { DEFAULT_TOOL_LIST, BUILTIN_AGENTS, roster } = await import(LIB('agents.js'));
const { say, toBubble, threadOf, DISCUSS_MAX } = await import(LIB('discuss.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, and a `bd` that reads and writes it.
 *
 * `list` carries `comment_count`, because that field is the whole of assertion 5: the
 * queue draws its 💬 off the list row it already has rather than a call per bead, and a
 * stub that omitted it would let a broken count pass as an empty thread.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
const one = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const withCount = (i) => ({ ...i, comment_count: (i.comments || []).length });

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([withCount(issue)]));
  process.exit(0);
}
if (args[0] === 'list') {
  const label = one('--label');
  const rows = Object.values(w.issues)
    .filter((i) => i.status !== 'closed')
    .filter((i) => !label || (i.labels || []).includes(label));
  process.stdout.write(JSON.stringify(rows.map(withCount)));
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  issue.comments = issue.comments || [];
  issue.comments.push({
    id: 'c' + (issue.comments.length + 1),
    text: args[2],
    author: one('--actor') || 'beadcause',
    created_at: new Date(1754900000000 + issue.comments.length * 60000).toISOString(),
  });
  save();
  process.exit(0);
}
if (args[0] === 'comments') {
  const issue = w.issues[args[1]];
  process.stdout.write(JSON.stringify((issue && issue.comments) || []));
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'remove') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.labels = (issue.labels || []).filter((l) => l !== args[3]);
  save();
  process.exit(0);
}
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
  description: 'as the agent filed it',
  acceptance_criteria: 'the way bd names it',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  created_at: '2026-08-11T02:00:00.000Z',
  labels: [],
  comments: [],
  dependencies: [],
  ...extra,
});

/** Two beads an agent filed, and one ordinary piece of work nobody has to endorse. */
const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'zz-one': issue('zz-one', { labels: [UNENDORSED, FILED_LABEL] }),
          'zz-two': issue('zz-two', { labels: [UNENDORSED, FILED_LABEL] }),
          'zz-work': issue('zz-work', { labels: ['api'] }),
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
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues;
const beadAt = (id) => world()[id];

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

console.log('\ntalking about an unendorsed bead, without deciding on it\n');

/* --------------------------------------------------------------- the conversation */

await check('a question lands on the thread and the bead is untouched but for that', async () => {
  reset();
  clearCalls();
  const out = await say(bd, ws, 'zz-one', { text: 'Is this not already bc-9frx?', actor: 'adam@example.com' });
  assert.equal(out.title, 'bead zz-one');

  const bead = beadAt('zz-one');
  assert.match(bead.comments.at(-1).text, /bc-9frx/);
  assert.equal(bead.comments.at(-1).author, 'adam@example.com', 'written as you — this is a sentence a person said');
  assert.deepEqual(bead.labels.sort(), [FILED_LABEL, UNENDORSED].sort(), 'the hold survives the conversation');
  assert.equal(bead.status, 'open');

  const writes = bdCalls().filter((c) => c[0] !== 'show' && c[0] !== 'comments' && c[0] !== 'list');
  assert.deepEqual(writes.map((c) => c[0]), ['comment'], `the only write is the comment: ${JSON.stringify(writes)}`);
});

await check('and a second question is a second comment, not a second anything else', async () => {
  await say(bd, ws, 'zz-one', { text: 'What would it actually touch?' });
  assert.equal(beadAt('zz-one').comments.length, 2);
  assert.ok(beadAt('zz-one').labels.includes(UNENDORSED), 'however long the thread runs');
});

await check('a bead endorsed since the queue was drawn is refused, before anything is written', async () => {
  reset();
  await bd.removeLabel(ws, 'zz-one', UNENDORSED);
  clearCalls();
  await assert.rejects(
    () => say(bd, ws, 'zz-one', { text: 'too late' }),
    (err) => err.status === 409 && err.unendorsed === true,
    'a question typed at work already approved reads as if it had not been'
  );
  assert.equal((beadAt('zz-one').comments || []).length, 0, 'and nothing is written on the way to the refusal');
  assert.equal(bdCalls().filter((c) => c[0] === 'comment').length, 0);
});

await check('a bead that is not held at all is the same refusal', async () => {
  reset();
  await assert.rejects(() => say(bd, ws, 'zz-work', { text: 'hello' }), (err) => err.status === 409);
  assert.equal((beadAt('zz-work').comments || []).length, 0);
});

await check('an id that is gone is a 404, and an empty question is a 400', async () => {
  reset();
  await assert.rejects(() => say(bd, ws, 'zz-gone', { text: 'anyone there' }), (err) => err.status === 404);
  await assert.rejects(() => say(bd, ws, 'zz-one', { text: '   ' }), (err) => err.status === 400);
  assert.equal((beadAt('zz-one').comments || []).length, 0);
});

await check('a very long question is bounded rather than refused', async () => {
  reset();
  await say(bd, ws, 'zz-one', { text: 'x'.repeat(DISCUSS_MAX + 500) });
  assert.equal(beadAt('zz-one').comments.at(-1).text.length, DISCUSS_MAX);
});

/* ------------------------------------------------------- who is on the other end */

/**
 * The roster as the daemon hands it in — the four built-ins plus one of yours.
 *
 * A list rather than the config it came from, because lib/discuss.js takes a list: an
 * `import` of lib/agents.js from that file is early enough in lib/server.js's import
 * order to reach agents.js before lib/foundation.js and kill the daemon at boot on the
 * cycle described above. bc-u4na is the cycle itself.
 */
const ROSTER = roster({
  agents: [{ id: 'pricing-hawk', name: 'Pricing hawk', emoji: '🦅', description: 'ten words at least, for the length check' }],
});

await check('a comment from a roster agent is drawn as that agent', () => {
  const bubble = toBubble(ROSTER, { author: 'critic', text: 'here is the case against', created_at: 'now' });
  assert.equal(bubble.agent.name, BUILTIN_AGENTS.find((a) => a.id === 'critic').name);
  assert.equal(bubble.agent.emoji, '🧨');
  assert.equal(bubble.text, 'here is the case against');
});

await check('a comment from you is not an agent, and a deleted agent keeps its own name', () => {
  assert.equal(toBubble(ROSTER, { author: 'adam@example.com', text: 'hi' }).agent, null);
  assert.equal(toBubble(ROSTER, { author: 'beadcause', text: 'hi' }).agent, null);
  assert.equal(
    toBubble(ROSTER, { author: 'some-agent-i-deleted', text: 'hi' }).agent,
    null,
    'never relabelled as the default agent — the conversation happened, whatever the config says now'
  );
  assert.equal(toBubble(ROSTER, { author: 'pricing-hawk', text: 'hi' }).agent.emoji, '🦅', 'and a custom one is itself');
});

await check('the thread comes back oldest first, as bd gives it', async () => {
  reset();
  await say(bd, ws, 'zz-one', { text: 'first', actor: 'adam@example.com' });
  await bd.comment(ws, 'zz-one', 'second', { actor: 'answerer' });
  const thread = await threadOf(bd, ROSTER, ws, 'zz-one');
  assert.deepEqual(thread.map((c) => c.text), ['first', 'second']);
  assert.equal(thread[0].agent, null);
  assert.equal(thread[1].agent.id, 'answerer');
  assert.ok(thread[1].at, 'a bubble without a time cannot say how old the answer is');
});

/* -------------------------------------------------- what the agent cannot reach for */

await check('nothing a reply agent may run can resolve the bead', () => {
  const tools = DEFAULT_TOOL_LIST.join(' ');
  for (const verb of ['label', 'update', 'close', 'create', 'delete']) {
    assert.ok(
      !new RegExp(`Bash\\(bd ${verb}`).test(tools),
      `\`bd ${verb}\` would let a thread decide the thing the thread exists to avoid deciding: ${tools}`
    );
  }
  assert.ok(!/Bash\(bd \*/.test(tools), 'and the glob one level up carries all five at once');
});

await check('the dispatch prompt tells it so as well, when the bead is held', () => {
  const src = fs.readFileSync(LIB('dispatch.js'), 'utf8');
  assert.match(src, /held = false/, 'dispatchReply takes the flag');
  assert.match(src, /heldNote/, 'and there is a paragraph for it');
  assert.match(src, /not endorsed, and this conversation is not what endorses it/);
});

/* -------------------------------------------------------------- over the wire */

const { createApp, listen } = await import(LIB('server.js'));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const cfg = {
  host: '127.0.0.1',
  port,
  baseUrl: `http://127.0.0.1:${port}`,
  token: 'discuss-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [ws],
  sessionDirs: { demo: path.join(tmp, 'no-such-checkout') },
  openSessions: false,
  // The one arrangement where the route's dispatch half runs without spawning a model.
  // It is also a real state — a shared workspace, an observer instance — and the answer
  // has to say so rather than claim somebody is coming.
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);

const request = (method, pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'x-beadcause-token': cfg.token,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
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
    if (payload) req.write(payload);
    req.end();
  });

const post = (pathname, body) => request('POST', pathname, body);
const get = (pathname) => request('GET', pathname);

for (let i = 0; i < 100; i += 1) {
  try {
    await post('/api/nothing', {});
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}

await check('POST /api/bead/discuss — the comment lands, the marker stays, the thread comes back', async () => {
  reset();
  const res = await post('/api/bead/discuss', { workspace: 'demo', id: 'zz-one', text: 'Which file would this touch?' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ok, true);
  assert.equal(res.json.held, true, 'the row must be able to redraw as still-held without asking again');
  assert.deepEqual(res.json.thread.map((c) => c.text), ['Which file would this touch?']);
  assert.ok(beadAt('zz-one').labels.includes(UNENDORSED), 'talking about it is not deciding on it');
  assert.equal(beadAt('zz-one').status, 'open');
});

await check('and it says plainly when no agent was sent, rather than leaving you waiting', async () => {
  reset();
  const res = await post('/api/bead/discuss', { workspace: 'demo', id: 'zz-one', text: 'anyone there?' });
  assert.equal(res.json.dispatched, false, 'auto-dispatch is off in this config');
  assert.match(String(res.json.reason), /auto-dispatch is off/, 'a silent thread is the failure dispatch exists to fix');
  assert.ok(res.json.agent?.id, 'and it still names who would have answered');
});

await check('an empty question is refused and nothing is written', async () => {
  reset();
  const res = await post('/api/bead/discuss', { workspace: 'demo', id: 'zz-one', text: '   ' });
  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.equal((beadAt('zz-one').comments || []).length, 0);
});

await check('a discussion is with one bead — a question typed at two is refused', async () => {
  reset();
  const res = await post('/api/bead/discuss', { workspace: 'demo', ids: ['zz-one', 'zz-two'], text: 'both of you' });
  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.equal((beadAt('zz-one').comments || []).length, 0);
  assert.equal((beadAt('zz-two').comments || []).length, 0);
});

await check('a bead endorsed on the laptop is a 409 over the wire too', async () => {
  reset();
  await post('/api/bead/endorse', { workspace: 'demo', id: 'zz-one' });
  const res = await post('/api/bead/discuss', { workspace: 'demo', id: 'zz-one', text: 'wait' });
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.equal((beadAt('zz-one').comments || []).length, 0);
});

await check('GET /api/bead/thread — the thread, and whether anyone is still writing', async () => {
  reset();
  await post('/api/bead/discuss', { workspace: 'demo', id: 'zz-two', text: 'is this a tangent?' });
  await bd.comment(ws, 'zz-two', 'It is not — here is why.', { actor: 'researcher' });
  const res = await get('/api/bead/thread?workspace=demo&id=zz-two');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json.thread.map((c) => c.text), ['is this a tangent?', 'It is not — here is why.']);
  assert.equal(res.json.thread[1].agent.name, 'Researcher', 'the phone draws the chip, so the name is resolved here');
  assert.equal(res.json.running, false, 'nothing is in flight, so the page stops polling');
});

await check('and it refuses something that is not a bead id', async () => {
  const res = await get('/api/bead/thread?workspace=demo&id=../../etc');
  assert.equal(res.status, 400, JSON.stringify(res.json));
});

await check('the queue row says the thread exists, cache and all', async () => {
  reset();
  // Prime the cache first: this is the whole failure being tested. The sweep is held for
  // a few seconds, so a discussion that did not drop it would come back as a row still
  // reading "nobody has looked at this".
  const before = await get('/api/unendorsed');
  assert.equal(before.json.beads.find((b) => b.id === 'zz-one').commentCount, 0);

  await post('/api/bead/discuss', { workspace: 'demo', id: 'zz-one', text: 'one question' });

  const after = await get('/api/unendorsed');
  const row = after.json.beads.find((b) => b.id === 'zz-one');
  assert.equal(row.commentCount, 1, 'a bead under discussion must never read as untouched');
  assert.ok(row.held, 'and it is still waiting on a verdict');
});

await check('the page draws that count, and offers the way in', () => {
  const page = fs.readFileSync(path.join(HERE, '..', 'public', 'endorse.js'), 'utf8');
  assert.match(page, /b\.commentCount \?/, 'the folded row counts the thread');
  assert.match(page, /data-act="talk"/, 'and the unfolded row is how you start one');
  assert.match(page, /\/api\/bead\/discuss/);
  assert.match(page, /\/api\/bead\/thread/);
});

/* ----------------------------------------------------------------------- done */

for (const s of servers) s.close();
app.bus?.close?.();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
