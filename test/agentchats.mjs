#!/usr/bin/env node
/**
 * Telling an agent chat apart from a chat session, in the list that holds both.
 *
 *     npm test
 *     node test/agentchats.mjs
 *
 * `/api/consoles` is one list of conversation records, and two screens start them:
 * `/console` (the chat session — describe a thing, get a proposal) and
 * `/foundations` (a direct conversation with the Critic, the Researcher, whoever).
 * They are the same record type in the same workspace, so on the launcher an agent
 * chat used to be a row whose only tell was its title — and under the repo tabs it
 * lands beneath that repo's tab as if it had been started there.
 *
 * The mark has to come off the server, because the launcher only ever learns the
 * agent's *id*: the name and the emoji live in the roster, a custom agent's emoji is
 * whatever the config says, and a second fetch for the roster would paint every
 * agent chat as an ordinary chat session first and correct itself after.
 *
 * So: `withAgentNames` names them, and both routes that hand the list back use it —
 * reading it, and closing a row. The close path is the one that rots quietly: it
 * returns a fresh list which the phone renders directly, so an undecorated one there
 * would un-mark every agent chat on screen until the next reload.
 *
 * No `bd`, no advocates, no poller: the records are written straight into the config
 * dir, which is where the daemon keeps them.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-agentchats-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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
const is = (name, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(name) : bad(name, `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`));

/* ------------------------------------------------------------ the records */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const CONSOLE_DIR = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'consoles');
fs.mkdirSync(CONSOLE_DIR, { recursive: true });

const at = (n) => new Date(Date.UTC(2026, 7, 1, 10, n)).toISOString();

/** A conversation on disk, exactly as the daemon leaves one. */
const write = (id, extra = {}) => {
  const rec = {
    id,
    workspace: 'demo',
    dir: ws,
    seed: null,
    title: 'Something',
    status: 'idle',
    error: null,
    seq: 1,
    createdAt: at(0),
    updatedAt: at(1),
    messages: [{ role: 'user', text: 'Hello.', at: at(0) }],
    draft: null,
    created: [],
    ...extra,
  };
  fs.writeFileSync(path.join(CONSOLE_DIR, `${id}.json`), JSON.stringify(rec));
  return rec;
};

write('chatsession', { agent: 'console', title: 'What to file next' });
// The kinds are what `POST /api/console` actually accepts — the agents screen opens a
// chat with the advocate, the dispatcher or the work session, never with a persona.
write('advocatechat', { agent: 'advocate', title: 'Chat with the advocate' });
write('criticchat', { agent: 'critic', title: 'Chat with the critic' });
write('housechat', { agent: 'house-style', title: 'Chat with the house-style' });
write('ghostchat', { agent: 'deleted-one', title: 'Chat with the deleted-one' });
// Written before agent chats existed: no `agent` field at all, and every one of
// those is a chat session.
write('oldchat', { title: 'From before' });

/* -------------------------------------------------------- withAgentNames */

// foundation.js first: it and agents.js import each other, and agents.js is not the
// end of that cycle that can be pulled in cold.
const { AGENTS, mark } = await import(LIB('foundation.js'));
const { withAgentNames } = await import(LIB('agents.js'));

// One custom agent, because the emoji a custom agent draws with exists only here.
const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'agentchats-token',
  actor: 'beadcause-test',
  workspaces: [{ name: 'demo', dir: ws }],
  agents: [
    { id: 'house-style', name: 'House style', emoji: '🏠', description: 'x'.repeat(30) },
    // A persona whose id collides with an agent kind. It is a legal persona — the
    // rosters are separate namespaces — and it must not get to relabel the advocate's
    // conversations, which is why the kind is resolved first.
    { id: 'advocate', name: 'Devil’s advocate', emoji: '😈', description: 'x'.repeat(30) },
  ],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

console.log('\nnaming the agent on a conversation\n');

const named = withAgentNames(
  [
    { id: 'a', agent: 'console' },
    { id: 'b' },
    { id: 'c', agent: 'critic' },
    { id: 'd', agent: 'house-style' },
    { id: 'e', agent: 'deleted-one' },
    { id: 'f', agent: 'advocate' },
    { id: 'g', agent: 'dispatch' },
    { id: 'h', agent: 'worker' },
  ],
  cfg
);
const by = (id) => named.find((c) => c.id === id);

is('a chat session gets no agent name', [by('a').agentName, by('a').agentEmoji], [undefined, undefined]);
is('nor does a record from before agent chats existed', [by('b').agentName, by('b').agentEmoji], [undefined, undefined]);
is('a built-in agent gets its roster name and emoji', [by('c').agentName, by('c').agentEmoji], ['Critic', '🧨']);
is('a custom agent gets the emoji its config gave it', [by('d').agentName, by('d').agentEmoji], ['House style', '🏠']);
// agentFor would have called this one the Answerer — the conversation happened,
// whatever the roster says now.
is('an agent that no longer exists keeps its own id', [by('e').agentName, by('e').agentEmoji], ['deleted-one', '🤖']);

// The kinds. These are the only ids a conversation can actually be opened with, and
// every one of them used to land on the line above — named after its own id, drawn
// with the generic 🤖, because the roster they were being looked up in is the reply
// personas' (bc-rjes).
is('the advocate is named and drawn as itself', [by('f').agentName, by('f').agentEmoji], ['Advocate', '📣']);
is('and so is the dispatcher', [by('g').agentName, by('g').agentEmoji], ['Dispatcher', '📨']);
is('and the work session', [by('h').agentName, by('h').agentEmoji], ['Worker', '🛠️']);
// `cfg.agents` above holds a persona whose id is `advocate`. A persona cannot own one
// of these records, so the kind wins — otherwise a name chosen for a chip on the
// agents screen would silently relabel the advocate's conversations.
is('a persona sharing a kind’s id does not relabel it', by('f').agentName, 'Advocate');

// Every kind, not just the three that exist today: a fifth added to BASELINES with no
// mark would otherwise ship as another 🤖 and nothing would say so.
is(
  'every agent kind has a mark of its own',
  AGENTS.filter((a) => !mark(a)?.name || !mark(a)?.emoji),
  []
);

/* ------------------------------------------------------------------ routes */

const { createApp, listen } = await import(LIB('server.js'));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const app = createApp({ ...cfg, port });
const servers = listen({ ...cfg, port }, app.handler);

const call = (pathname, method = 'GET', payload) =>
  new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'x-beadcause-token': cfg.token,
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });

for (let i = 0; i < 100; i += 1) {
  try {
    await call('/api/consoles');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}

console.log('\nthe list the launcher draws\n');

const listed = await call('/api/consoles');
const rows = Object.fromEntries((listed.body.consoles || []).map((c) => [c.id, c]));
is('every conversation is still in the list', Object.keys(rows).sort(), [
  'advocatechat',
  'chatsession',
  'criticchat',
  'ghostchat',
  'housechat',
  'oldchat',
]);
is(
  'GET /api/consoles names the agent on an agent chat',
  [rows.criticchat?.agentName, rows.criticchat?.agentEmoji],
  ['Critic', '🧨']
);
// The row bc-rjes is about: the one kind of agent chat that actually happens, off the
// live route rather than off `withAgentNames` in isolation.
is(
  'and the advocate’s conversation carries the mark chosen for it',
  [rows.advocatechat?.agentName, rows.advocatechat?.agentEmoji],
  ['Advocate', '📣']
);
is(
  'and the custom one, from the config rather than the built-ins',
  [rows.housechat?.agentName, rows.housechat?.agentEmoji],
  ['House style', '🏠']
);
is(
  'a chat session is left unmarked — it is what the rest are told apart from',
  [rows.chatsession?.agent, rows.chatsession?.agentName],
  ['console', undefined]
);
is('and so is a record with no agent field at all', [rows.oldchat?.agent, rows.oldchat?.agentName], ['console', undefined]);

// The list the phone renders straight after closing a row. Same decoration, or every
// agent chat on screen loses its mark until the next reload.
const closed = await call('/api/console/close', 'POST', { id: 'criticchat' });
const afterClose = Object.fromEntries((closed.body.consoles || []).map((c) => [c.id, c]));
is(
  'closing a row hands back a list that is named the same way',
  [afterClose.criticchat?.agentName, afterClose.criticchat?.agentEmoji, afterClose.housechat?.agentName],
  ['Critic', '🧨', 'House style']
);
is('and the row it closed is closed', Boolean(afterClose.criticchat?.closedAt), true);

for (const s of servers || []) s.close?.();
app.stop?.();

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
