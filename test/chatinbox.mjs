#!/usr/bin/env node
/**
 * Chat stopped being a tab. What has to be true afterwards.
 *
 *     npm test
 *     node test/chatinbox.mjs
 *
 * The Chat tab was two jobs at one address: the conversations you had already
 * started, and the only way to start another. Neither belonged on a bar of five
 * standing views — the first is an incoming thing like every other row of the inbox,
 * and the second is a *create*, which cannot mean the same thing on all five pages a
 * shared bar is drawn on. So (bc-l8jp.5) the list became rows in the inbox under a
 * filter category of its own, and starting one became ＋ on the inbox.
 *
 * Three things about that are worth a suite, and none of them is visible from reading
 * any one file:
 *
 * 1. **The conversations reach the inbox at all.** They ride `/api/questions`, the
 *    payload that page already waits for, and two properties of that field are load
 *    bearing: only the *open* ones (an inbox is not an archive), and each stamped with
 *    its space, because the inbox filters on `q.space` before anything else and a row
 *    without one answers to "Other" and vanishes the moment a space is picked.
 *
 * 2. **`/console` outlives its tab.** The id and the href are in stored conversation
 *    records and on people's home screens. Nothing in the app points at the path any
 *    more, which is exactly the condition under which an alias quietly rots — so both
 *    of its paths are asked for here, against the same running server, right after the
 *    bar is asserted not to hold it. test/pagepaths.mjs owns the general rule; this is
 *    the one path that just lost its only in-app link.
 *
 * 3. **The two ends of the create still agree.** ＋ is a different file from the
 *    launcher's ＋, and what makes it "the same place" is the pair of lines it copied:
 *    POST /api/console, then `/console?id=<id>`. A static read, because the failure
 *    mode is a plausible near-miss — navigating to `/console` and leaving you on the
 *    launcher, or minting an id some other way.
 *
 * No `bd` beyond a stub that answers with nothing, no network beyond loopback, and
 * nothing written outside a temp directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-chatinbox-'));
// Before lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

/* ---------------------------------------------------------------- fixtures */

const WS = ['alpha', 'beta'].map((name) => {
  const dir = path.join(tmp, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return { name, dir };
});

/** A `bd` with nothing in it — this suite is about the other half of the payload. */
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(BD, "#!/usr/bin/env node\nconsole.log('[]');\n", { mode: 0o755 });

/**
 * A conversation on disk, in the shape lib/console.js persists.
 *
 * Written as a file rather than through `createConsole`, because what is being tested
 * is what the *reader* does with what is already there — including a record written
 * before any of this existed, which is the one on `beta` below.
 */
const CONSOLES = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'consoles');
fs.mkdirSync(CONSOLES, { recursive: true });

const conversation = (id, over) => ({
  id,
  agent: 'console',
  workspace: 'alpha',
  dir: path.join(tmp, 'alpha'),
  seed: null,
  claudeSessionId: `00000000-0000-4000-8000-0000000000${id.slice(-2)}`,
  started: true,
  title: `Conversation ${id}`,
  status: 'idle',
  error: null,
  seq: 3,
  createdAt: '2026-08-09T08:00:00Z',
  updatedAt: '2026-08-09T08:30:00Z',
  messages: [{ role: 'user', text: 'hello' }],
  draft: null,
  draftDirty: false,
  created: [],
  costUsd: 0,
  ...over,
});

const OPEN = conversation('aaaaaa01');
const THINKING = conversation('aaaaaa02', { status: 'thinking', draft: { beads: [{ title: 'x' }] } });
const CLOSED = conversation('aaaaaa03', { closedAt: '2026-08-09T09:00:00Z' });
const UNSPACED = conversation('aaaaaa04', { workspace: 'beta', dir: path.join(tmp, 'beta') });

for (const c of [OPEN, THINKING, CLOSED, UNSPACED]) {
  fs.writeFileSync(path.join(CONSOLES, `${c.id}.json`), JSON.stringify(c));
}

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'chatinbox-token',
  bdBin: BD,
  actor: 'beadcause-test',
  workspaces: WS,
  // One space holding one of the two workspaces, so a stamped row and an unassigned
  // one are both in the answer. "Other" is the inbox's own name for the second, and it
  // derives that from a null rather than being told it.
  spaces: [{ name: 'Work', workspaces: ['alpha'] }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  agents: [],
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(path.join(ROOT, 'lib', 'server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const PORT = await boundPort(servers);

const get = async (p) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'x-beadcause-token': cfg.token } });
  return { status: res.status, body: await res.text() };
};
const getJson = async (p) => {
  const res = await get(p);
  assert.equal(res.status, 200, `GET ${p} should be 200, got ${res.status}`);
  return JSON.parse(res.body);
};

/* ------------------------------------------- the conversations reach the inbox */

console.log('\nthe conversations are rows in the inbox\n');

try {
  const payload = await getJson('/api/questions');

  await check('/api/questions carries them, on the poll the inbox already makes', () => {
    assert.ok(Array.isArray(payload.consoles), 'no `consoles` on the payload the inbox waits for');
    assert.deepEqual(
      payload.consoles.map((c) => c.id).sort(),
      [OPEN.id, THINKING.id, UNSPACED.id].sort()
    );
  });

  await check('a conversation you finished is not one of them — an inbox is not an archive', () => {
    assert.ok(!payload.consoles.some((c) => c.id === CLOSED.id), 'the closed one came back');
  });

  await check('each one is stamped with its space, because that is the first filter', () => {
    const byId = Object.fromEntries(payload.consoles.map((c) => [c.id, c]));
    assert.equal(byId[OPEN.id].space, 'Work');
    // Not a bug and not "Other" on the wire: `spaceOf` in public/app.js reads a null as
    // Other, exactly as `matchesFilter` does on the server. The two must agree, and
    // they agree by both reading the absence.
    assert.equal(byId[UNSPACED.id].space, null);
  });

  await check('the row says which conversation and what state, without opening it', () => {
    const byId = Object.fromEntries(payload.consoles.map((c) => [c.id, c]));
    for (const field of ['title', 'workspace', 'status', 'messageCount', 'beadCount', 'updatedAt']) {
      assert.ok(field in byId[THINKING.id], `${field} is missing — the row cannot say what it is`);
    }
    assert.equal(byId[THINKING.id].beadCount, 1, 'a proposal waiting to be read is the state that matters most');
    // The row draws a spark for `thinking`, and a spark that never stops is a lie the
    // inbox would tell every 25 seconds. lib/console.js settles that on the way out of
    // the file — whatever process was mid-turn belongs to a daemon that is gone — so
    // the status a cold read hands the inbox is never that one.
    assert.equal(byId[THINKING.id].status, 'idle', 'a conversation read off disk cannot still be mid-turn');
  });

  await check('an older client sees exactly the payload it always did', () => {
    for (const field of ['questions', 'requests', 'workspaces', 'spaces', 'summary', 'scope']) {
      assert.ok(field in payload, `${field} must still be served`);
    }
    assert.ok(
      !payload.questions.some((q) => q.session),
      'a conversation must never be folded into the questions — nothing there can answer one'
    );
  });

  await check('and every scope has them, because no bd sweep fetches a conversation', async () => {
    const agent = await getJson('/api/questions?scope=agent');
    assert.equal(agent.consoles.length, 3, 'the chats emptied out on a scope that has nothing to do with them');
  });

  /* ------------------------------------------------- /console outlives its tab */

  console.log('\nthe tab is gone and the page is not\n');

  await check('the bar holds no Chat tab', () => {
    const bar = read('public/tabbar.js');
    const ids = [...bar.matchAll(/^\s*\{\s*id: '([a-z]+)'/gm)].map((m) => m[1]);
    // That the table was read at all, keyed off a tab rather than off a count: the bar
    // has lost two tabs since this was written (bc-l8jp.6 took PRs a moment after this
    // took Chat) and a count here would fail as "the tab table is unreadable" every time
    // the bar legitimately changes size.
    assert.ok(ids.includes('inbox'), `expected the tab table, found: ${ids.join(', ') || 'nothing'}`);
    assert.ok(!ids.includes('console'), `the Chat tab is still in the bar: ${ids.join(', ')}`);
  });

  for (const p of ['/console', '/console.html']) {
    await check(`${p} still serves the chat session — a shortcut and a stored link both still work`, async () => {
      const res = await get(p);
      assert.equal(res.status, 200, `HTTP ${res.status}`);
      assert.match(res.body, /\/console\.js/, 'that is not the chat session');
    });
  }

  /* ----------------------------------------------------- ＋ starts one, in place */

  console.log('\n＋ starts one, and lands where /console?id= lands\n');

  const appjs = read('public/app.js');
  const html = read('public/index.html');

  await check('the inbox has a ＋, and it says what it does', () => {
    assert.match(html, /id="compose"/, 'no ＋ on the inbox');
    assert.match(html, /aria-label="Start a chat session[^"]*"/, '＋ has no accessible name');
  });

  await check('it creates through the endpoint that already creates them', () => {
    assert.match(appjs, /api\('\/api\/console',\s*\{\s*method: 'POST'/, '＋ does not POST /api/console');
  });

  await check('and lands on the conversation itself, not on the launcher', () => {
    assert.match(appjs, /location\.href = `\/console\?id=\$\{encodeURIComponent\(made\.id\)\}`/);
  });

  await check('a chat row in the list opens that same address', () => {
    assert.match(appjs, /href="\/console\?id=\$\{encodeURIComponent\(c\.id\)\}"/);
  });

  await check('the inbox reads the conversations off its own payload', () => {
    assert.match(appjs, /data\.consoles/, 'app.js never reads the field the server now sends');
    assert.match(appjs, /session: c/, 'the rows carry no `session`, so the kind filter cannot see them');
  });

  await check('the service worker still ships the page nothing links to any more', () => {
    assert.match(read('public/sw.js'), /'\/console\.js'/);
  });
} finally {
  for (const s of servers || []) s.close?.();
  app.stop?.();
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
