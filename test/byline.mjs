#!/usr/bin/env node
/**
 * Whose beadcause wrote this — the byline, and the reply test it must not break.
 *
 *     npm test
 *     node test/byline.mjs
 *
 * bc-lx3k. Every write beadcause makes went onto the tracker as the literal string
 * `beadcause`: `cfg.actor` is that string, `Bd.run` appends it as `--actor` to every
 * command, and `bin/ask.js`, `bin/propose.js` and `bin/deliver.js` each exported it as
 * `BEADS_ACTOR`. On one Mac that is a byline. On the six sharing a tracker under bc-y3qk
 * it is the *same* byline, so `created_by` on every bead and `author` on every comment
 * named nobody, and no amount of reading the graph afterwards could recover which
 * engineer had filed what.
 *
 * Four things are worth a suite, and only the first is visible by reading one function:
 *
 * 1. **The byline names this Mac's person once it has one, and is unchanged before.**
 *    `bylineFor` cannot produce a suffix without a handle, so the one-Mac install is not
 *    quietly relying on a default — see `writtenByDaemon`'s counterpart below.
 * 2. **It is derived in the `Bd` constructor, not at the call sites.** Four places build
 *    a `Bd` and three CLIs build their own argv; a fifth that passed `cfg.actor`
 *    straight through would file anonymously and nothing would say so. So this drives
 *    the real `Bd` against a fake `bd` binary and reads the argv back.
 * 3. **A per-call actor is a person and is never wrapped.** A signed-in browser's
 *    address goes on the bead as itself; wrapping it would attribute Adam's own tap to
 *    a daemon.
 * 4. **The reply test still tells an agent from a daemon.** This is the one that could
 *    fail silently and badly. `checkReplies` used to ask `c.author !== cfg.actor`; a
 *    byline that no longer equals `cfg.actor` makes the daemon's own comments read as
 *    agent replies, and the phone gets buzzed about its own bookkeeping. The last
 *    section drives the **real poller** — the real `startPoller`, real bus, real ntfy
 *    client pointed at a server that writes down what it was sent — over three comments
 *    that differ only in their author: this Mac's byline, another Mac's byline, and an
 *    agent. Exactly one of them may ring.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-byline-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { BYLINE_BASE, bylineFor, bylineBase, bylineHandle, writtenByDaemon } = await import(LIB('byline.js'));

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
};
const acheck = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
};

console.log('the byline — whose beadcause wrote this');

/* ------------------------------------------------------------------ the string */

check('an install that has not said who it is writes the bare base, exactly as before', () => {
  assert.equal(bylineFor({ actor: 'beadcause' }), 'beadcause');
  assert.equal(bylineFor({ actor: 'beadcause', me: null }), 'beadcause');
  assert.equal(bylineFor({ actor: 'beadcause', me: [] }), 'beadcause');
  // No config at all is the same answer rather than an exception: `bylineFor` is called
  // on the way to a bd spawn, and throwing there would take out the write.
  assert.equal(bylineFor(undefined), BYLINE_BASE);
  assert.equal(bylineFor({}), BYLINE_BASE);
});

check('with `me` set it names the person, base first', () => {
  assert.equal(bylineFor({ actor: 'beadcause', me: 'carol@example.com' }), 'beadcause (carol@example.com)');
  assert.equal(bylineFor({ actor: 'beadcause', me: ['carol@example.com'] }), 'beadcause (carol@example.com)');
});

check('only the first handle — two addresses are one person, not two authors', () => {
  assert.equal(
    bylineFor({ actor: 'beadcause', me: ['carol@example.com', 'carol@work.example'] }),
    'beadcause (carol@example.com)'
  );
});

check('`me: everyone` is a word about beads, not a name anybody has', () => {
  // Same guard `meHandles` applies for the addressee: a machine calling itself
  // "everyone" would otherwise sign every bead in the graph "beadcause (everyone)".
  assert.equal(bylineFor({ actor: 'beadcause', me: 'everyone' }), 'beadcause');
  assert.equal(bylineFor({ actor: 'beadcause', me: ['  ', 'carol@example.com'] }), 'beadcause (carol@example.com)');
});

check('a handle with a parenthesis in it cannot produce a byline that will not parse', () => {
  // Nothing that is really an address has one; a hand-written `me` might, and a byline
  // `bylineBase` cannot take apart is one `writtenByDaemon` says no to — which is the
  // daemon buzzing the phone about its own comments.
  const cfg = { actor: 'beadcause', me: 'carol (the other one)@example.com' };
  assert.equal(bylineFor(cfg), 'beadcause (carol the other one@example.com)');
  assert.equal(writtenByDaemon(bylineFor(cfg), cfg), true);
});

check('an install that renamed its actor keeps the name it chose and gains the suffix', () => {
  assert.equal(bylineFor({ actor: 'ourbot', me: 'carol@example.com' }), 'ourbot (carol@example.com)');
  assert.equal(bylineFor({ actor: '   ', me: 'carol@example.com' }), 'beadcause (carol@example.com)');
});

check('and it comes back apart again', () => {
  assert.equal(bylineBase('beadcause (carol@example.com)'), 'beadcause');
  assert.equal(bylineHandle('beadcause (carol@example.com)'), 'carol@example.com');
  // A person's address is left exactly as it came rather than mangled into a base.
  assert.equal(bylineBase('carol@example.com'), 'carol@example.com');
  assert.equal(bylineHandle('carol@example.com'), null);
  assert.equal(bylineBase(null), '');
});

/* ------------------------------------------------- who counts as the daemon talking */

check("this Mac's own byline is the daemon, in either form", () => {
  const cfg = { actor: 'beadcause', me: 'carol@example.com' };
  assert.equal(writtenByDaemon('beadcause (carol@example.com)', cfg), true);
  // The bare base too: every bead and comment written before `me` was ever set carries
  // it, and a thread from last week must not start reading as an agent replying.
  assert.equal(writtenByDaemon('beadcause', cfg), true);
});

check("and so is another engineer's — a second daemon relaying a tap is not an answer", () => {
  const cfg = { actor: 'beadcause', me: 'carol@example.com' };
  assert.equal(writtenByDaemon('beadcause (bob@example.com)', cfg), true);
  // Which the old `author !== cfg.actor` test could not have said: on one Mac there was
  // no second daemon to have an opinion about.
});

check('an agent and a person are not', () => {
  const cfg = { actor: 'beadcause', me: 'carol@example.com' };
  // How an agent's own `bd comment` is attributed: the shell's BEADS_ACTOR, an address.
  assert.equal(writtenByDaemon('neadamthal@gmail.com', cfg), false);
  // How a dispatched chat agent is told to attribute itself (`--actor <agent-id>`).
  assert.equal(writtenByDaemon('critic', cfg), false);
  // A signed-in browser, which is a person speaking.
  assert.equal(writtenByDaemon('carol@example.com', cfg), false);
  assert.equal(writtenByDaemon('', cfg), false);
  assert.equal(writtenByDaemon(null, cfg), false);
});

check('a renamed actor is recognised alongside the default, not instead of it', () => {
  const cfg = { actor: 'ourbot', me: 'carol@example.com' };
  assert.equal(writtenByDaemon('ourbot (carol@example.com)', cfg), true);
  // The other five machines ship with the stock base whatever this one calls itself.
  assert.equal(writtenByDaemon('beadcause (bob@example.com)', cfg), true);
  assert.equal(writtenByDaemon('someone@example.com', cfg), false);
});

/* -------------------------------------------- what actually reaches the bd command */

const CALLS = path.join(tmp, 'calls.log');
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, env: process.env.BEADS_ACTOR || null }) + '\\n');
if (args[0] === 'create') { process.stdout.write(JSON.stringify({ id: 'zz-1' })); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);
const calls = () =>
  fs.existsSync(CALLS)
    ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const reset = () => fs.writeFileSync(CALLS, '');
/** The `--actor` bd was given on the last call, and the `BEADS_ACTOR` beside it. */
const lastActor = () => {
  const c = calls()[calls().length - 1];
  const at = c.args.lastIndexOf('--actor');
  return { flag: at === -1 ? null : c.args[at + 1], env: c.env };
};

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const WS = { name: 'demo', dir: wsDir };

const { Bd } = await import(LIB('bd.js'));

await acheck('`new Bd` derives the byline itself, so no call site can file anonymously', async () => {
  reset();
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause', me: 'carol@example.com' });
  await bd.comment(WS, 'zz-1', 'a note');
  assert.deepEqual(lastActor(), { flag: 'beadcause (carol@example.com)', env: 'beadcause (carol@example.com)' });
  // Both, because a workspace `config.yaml` pinning an actor beats the environment
  // variable and only the flag beats that — see the note in `Bd.run`.
});

await acheck('and with `me` unset it is the bare string every install has always written', async () => {
  reset();
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause' });
  await bd.comment(WS, 'zz-1', 'a note');
  assert.deepEqual(lastActor(), { flag: 'beadcause', env: 'beadcause' });
});

await acheck('a per-call actor is a person and is never wrapped in a byline', async () => {
  reset();
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause', me: 'carol@example.com' });
  await bd.comment(WS, 'zz-1', 'I decided this', { actor: 'adam@example.com' });
  assert.deepEqual(lastActor(), { flag: 'adam@example.com', env: 'adam@example.com' });
});

/* ------------------------------------------------- and through bin/ask.js, end to end */

const configure = (extra) =>
  fs.writeFileSync(
    path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
    JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause', workspaces: [{ name: 'demo', dir: wsDir }], ...extra }, null, 2)
  );

/** `bin/ask.js`, run the way the brief tells a worker to run it: body on stdin. */
const ask = () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ask.js'), '-w', 'demo', '-t', 'Gross or net?'], {
    input: 'Which of these two did you mean?\n',
    encoding: 'utf8',
    // HOME into the temp tree so discoverWorkspaces finds no ~/beads to reconcile.
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  assert.equal(res.status, 0, `ask.js exited ${res.status}: ${res.stderr}`);
};

check('a question filed by a session says whose Mac filed it — flag and env agree', () => {
  configure({ me: 'carol@example.com' });
  reset();
  ask();
  const create = calls().find((c) => c.args[0] === 'create');
  assert.ok(create, 'ask.js created a bead');
  const at = create.args.lastIndexOf('--actor');
  assert.notEqual(at, -1, 'the create carries --actor, which is what beats a pinned workspace actor');
  assert.equal(create.args[at + 1], 'beadcause (carol@example.com)');
  assert.equal(create.env, 'beadcause (carol@example.com)');
});

check('and on a one-Mac install it files exactly what it filed before', () => {
  configure({});
  reset();
  ask();
  const create = calls().find((c) => c.args[0] === 'create');
  const at = create.args.lastIndexOf('--actor');
  assert.equal(create.args[at + 1], 'beadcause');
  assert.equal(create.env, 'beadcause');
});

/* --------------------------------- and the two copies of the rule under public/ */
//
// Nothing under public/ imports from lib/, so `bylineBase` is restated in public/app.js
// (which decides whether a comment bubble is one this app sent) and public/graph.js
// (which paints the `.from-agent` stripe on the bead sheet). A restated rule that drifts
// is worse than no rule: a byline would read as an agent on the screen and as beadcause
// everywhere else. So the copies are lifted out and run against the original, rather
// than grepped for — a check that only matched the text would pass on a copy that had
// been edited into disagreeing.

const lift = (file, name) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const at = src.indexOf(`const ${name} = (author) => {`);
  assert.notEqual(at, -1, `${file} defines ${name}`);
  const end = src.indexOf('\n  };', at);
  assert.notEqual(end, -1, `${file}'s ${name} ends where this expects`);
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(at, end + 5)}\nreturn ${name};`)();
};

check('public/app.js and public/graph.js still agree with lib/byline.js', () => {
  const copies = [lift('public/app.js', 'bylineBase'), lift('public/graph.js', 'bylineBase')];
  const cases = [
    'beadcause',
    'beadcause (carol@example.com)',
    'beadcause (bob@example.com)',
    'neadamthal@gmail.com',
    'critic',
    '',
    null,
  ];
  for (const copy of copies) {
    for (const c of cases) assert.equal(copy(c), bylineBase(c), `bylineBase(${JSON.stringify(c)})`);
    // The thing each copy is actually used for: a daemon comment is beadcause however
    // it is signed, and nothing else is.
    assert.equal(copy('beadcause (carol@example.com)') === 'beadcause', true);
    assert.equal(copy('neadamthal@gmail.com') === 'beadcause', false);
  }
});

/* -------------------------------------------- the reply test, against the real poller */
//
// The unit tests above prove the decision. This proves the wiring, and it is the half
// that can only fail two ways — a phone buzzed by its own daemon, or an agent's answer
// that never arrives — neither of which is visible by reading `writtenByDaemon`.

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

const { loadState, saveState } = await import(LIB('config.js'));
saveState({ notified: [], commentCounts: {}, filter: { space: 'all', workspace: 'all' } });

const q = (id) => ({
  key: `demo/${id}`,
  workspace: 'demo',
  space: null,
  id,
  title: `${id}`,
  question: `${id}`,
  priority: 2,
  awaitingAgent: true,
});

// Three watched threads, identical but for who says the second thing on each.
const AUTHORS = {
  'x-mine': 'beadcause (carol@example.com)',
  'x-theirs': 'beadcause (bob@example.com)',
  'x-agent': 'neadamthal@gmail.com',
};
const inbox = Object.keys(AUTHORS).map(q);
let turn = 1;

const pollCfg = {
  baseUrl: 'http://127.0.0.1',
  token: 'byline-test-token',
  actor: 'beadcause',
  me: 'carol@example.com',
  workspaces: [{ name: 'demo' }],
  spaces: [],
  pollSeconds: 5,
  autoDispatch: false,
  ntfy: { enabled: true, topic: 'byline-test', server: `http://127.0.0.1:${ntfyPort}`, actionButtons: false },
};

const bus = createEventBus();
const pollApp = {
  bus,
  hooks: {},
  bd: {
    // The first sweep baselines one comment per thread; the second adds the one whose
    // author is the whole test.
    comments: async (_ws, id) =>
      turn === 1
        ? [{ author: AUTHORS[id], text: 'the question' }]
        : [
            { author: AUTHORS[id], text: 'the question' },
            { author: AUTHORS[id], text: 'the second thing' },
          ],
    removeLabel: async () => {},
  },
  allQuestions: async () => inbox,
};

const timer = startPoller(pollCfg, pollApp);

const settled = async (fn, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
// The baseline sweep pushes nothing by design; wait for it to have counted.
await settled(() => Object.keys(loadState().commentCounts || {}).length === inbox.length);
turn = 2;

const events = () => bus.since(0) || [];
const found = (key) => events().find((e) => e.type === 'reply' && e.key === key);
const sawAgent = await settled(() => found('demo/x-agent'));
// Slack after the event so "nothing was pushed" is a fact rather than a race: the three
// threads are read in one sweep, so by the time the agent's reply has landed the other
// two have had their chance.
await new Promise((r) => setTimeout(r, 400));
clearInterval(timer);
ntfy.close();

check("an agent's reply still reaches the phone — the load-bearing half", () => {
  assert.ok(sawAgent, `the reply event arrived (saw ${events().map((e) => `${e.type}:${e.key}`).join(', ')})`);
  assert.equal(found('demo/x-agent').author, 'neadamthal@gmail.com');
  assert.ok(
    sent.some((p) => JSON.stringify(p).includes('x-agent')),
    `and it was pushed (sent: ${JSON.stringify(sent)})`
  );
});

check("this daemon's own comment is not an agent talking back", () => {
  assert.equal(found('demo/x-mine'), undefined, 'no reply event');
  assert.ok(!sent.some((p) => JSON.stringify(p).includes('x-mine')), 'and no push');
});

check("nor is another engineer's daemon relaying their tap", () => {
  assert.equal(found('demo/x-theirs'), undefined, 'no reply event');
  assert.ok(!sent.some((p) => JSON.stringify(p).includes('x-theirs')), 'and no push');
});

/* ------------------------------------------------------------------------ the end */

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
