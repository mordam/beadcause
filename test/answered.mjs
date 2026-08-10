#!/usr/bin/env node
/**
 * A question that has already been answered, arriving again.
 *
 *     npm test
 *     node test/answered.mjs
 *
 * **The failure.** Answering closes the bead, so a card can only be in the inbox a
 * second time because something reopened it — and the commonest reopen is the one
 * the answer itself asked for: an option that says *go and build it* is a
 * commission, the session that picks the work up reopens the bead, and a reopened
 * bead still labelled `human` walks back in as a card rebuilt from the tracker. Same
 * question, same four options, no trace of what you chose an hour ago. beadcause's
 * bc-goo.2 was answered identically at 13:33 and again at 14:35 on 2026-08-09
 * exactly this way, and nothing in the log said the second card was the first one
 * coming back.
 *
 * **The shape being pinned, which is a choice and not the only one.** The bead
 * allowed either "it does not come back" or "it comes back showing the answer", and
 * this is the second. Refusing the second arrival trades a duplicated answer for a
 * lost question, and beadcause cannot tell a pointless reopen from a bead that has
 * genuinely come back with something new to ask. So five things are asserted, and
 * every one of them is something a reasonable refactor breaks:
 *
 * 1. **Answering records what was said** — and the record survives the bead leaving
 *    the inbox, which is the one thing that distinguishes it from `ringing` and
 *    `dismissed`. Pruning it against the live sweep, as those two are pruned, would
 *    throw the record away moments before the reopen that needs it.
 * 2. **The next arrival carries it**, on the list payload and on the detail fetch —
 *    both, because the open card merges one over the other and the banner must not
 *    blink out when it does.
 * 3. **A first arrival carries nothing.** A card that claims you answered something
 *    you did not is worse than the duplicate it is trying to prevent.
 * 4. **Answering again keeps counting.** "You have answered this twice already" is
 *    the sentence that stops the third one.
 * 5. **A junk state file reads as "never answered"** — same direction as every other
 *    field in state.json: the cheap failure, not the confident wrong one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-answered-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { loadState, saveState, STATE_PATH } = await import(LIB('config.js'));
const { ANSWER_MAX, ANSWER_TTL_MS, answeredAgo, answeredBefore, pruneAnswered, recordAnswer } = await import(
  LIB('answered.js')
);

console.log('\na question you have already answered\n');

/* ------------------------------------------------------------- the record itself */

const NOW = new Date('2026-08-10T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

check('answering writes down when, and what was said', () => {
  const a = recordAnswer({}, 'bc/bc-goo.2', 'Build both as written.', NOW);
  assert.deepEqual(a['bc/bc-goo.2'], {
    at: NOW.toISOString(),
    response: 'Build both as written.',
    count: 1,
  });
});

check('answering the same bead again counts up rather than starting over', () => {
  const once = recordAnswer({}, 'bc/x', 'first', NOW);
  const twice = recordAnswer(once, 'bc/x', 'second', NOW);
  assert.equal(twice['bc/x'].count, 2, 'count');
  // The latest answer is the one standing; the older ones are on the bead's thread,
  // which is where a full history belongs.
  assert.equal(twice['bc/x'].response, 'second', 'text');
});

check('other beads are untouched, and the input is not mutated', () => {
  const before = { 'bc/a': { at: ago(1000), response: 'a', count: 1 } };
  const after = recordAnswer(before, 'bc/b', 'b', NOW);
  assert.equal(after['bc/a'].response, 'a');
  assert.equal(before['bc/b'], undefined, 'the caller’s object is not written through');
});

check('a very long answer is trimmed rather than stored whole', () => {
  const a = recordAnswer({}, 'bc/x', 'y'.repeat(2000), NOW);
  assert.ok(a['bc/x'].response.length < 500, `kept ${a['bc/x'].response.length} chars`);
  assert.ok(a['bc/x'].response.endsWith('…'), 'and says it was cut');
});

check('an unknown bead has nothing to say — this is the ordinary case', () => {
  assert.equal(answeredBefore({}, 'bc/never'), null);
  assert.equal(answeredBefore(null, 'bc/never'), null);
});

check('and neither does a record of the wrong shape', () => {
  // The failure to keep out: a card asserting you said something you did not.
  assert.equal(answeredBefore({ 'bc/x': 'not an object' }, 'bc/x'), null);
  assert.equal(answeredBefore({ 'bc/x': {} }, 'bc/x'), null);
  assert.equal(answeredBefore({ 'bc/x': null }, 'bc/x'), null);
});

check('a record with no count still reads as answered once', () => {
  assert.deepEqual(answeredBefore({ 'bc/x': { at: NOW.toISOString(), response: 'hi' } }, 'bc/x'), {
    at: NOW.toISOString(),
    response: 'hi',
    count: 1,
  });
});

/* -------------------------------------------------------------------- pruning */

check('an answer older than the window is forgotten', () => {
  const kept = pruneAnswered(
    {
      fresh: { at: ago(60_000), response: 'f', count: 1 },
      stale: { at: ago(ANSWER_TTL_MS + 60_000), response: 's', count: 1 },
    },
    NOW
  );
  assert.deepEqual(Object.keys(kept), ['fresh']);
});

check('and one from an hour ago is not — this is the reopen the feature is for', () => {
  const kept = pruneAnswered({ x: { at: ago(60 * 60_000), response: 'x', count: 1 } }, NOW);
  assert.deepEqual(Object.keys(kept), ['x']);
});

check('a record with an unreadable date is kept, not silently dropped', () => {
  // It is still true that you answered, and the date is the smaller half of what the
  // card says.
  const kept = pruneAnswered({ x: { at: 'not a date', response: 'x' } }, NOW);
  assert.deepEqual(Object.keys(kept), ['x']);
});

check('the cap bounds the file, keeping the newest', () => {
  const many = {};
  for (let i = 0; i < ANSWER_MAX + 40; i += 1) many[`bc/${i}`] = { at: ago(i * 1000), response: `${i}`, count: 1 };
  const kept = pruneAnswered(many, NOW);
  assert.equal(Object.keys(kept).length, ANSWER_MAX, 'size');
  assert.ok(kept['bc/0'], 'the newest survived');
  assert.ok(!kept[`bc/${ANSWER_MAX + 39}`], 'the oldest did not');
});

/* ---------------------------------------------------------------------- wording */

check('how long ago is said coarsely, because that is the distinction being drawn', () => {
  assert.equal(answeredAgo(ago(30_000), NOW), 'just now');
  assert.equal(answeredAgo(ago(20 * 60_000), NOW), '20 minutes ago');
  assert.equal(answeredAgo(ago(62 * 60_000), NOW), 'an hour ago');
  assert.equal(answeredAgo(ago(5 * 60 * 60_000), NOW), '5 hours ago');
  assert.equal(answeredAgo(ago(26 * 60 * 60_000), NOW), 'yesterday');
  assert.equal(answeredAgo(ago(4 * 24 * 60 * 60_000), NOW), '4 days ago');
});

check('an unparseable date says nothing at all rather than "NaN ago"', () => {
  assert.equal(answeredAgo(null, NOW), '');
  assert.equal(answeredAgo('whenever', NOW), '');
});

/* ------------------------------------------------------------------- state.json */

fs.rmSync(STATE_PATH, { force: true });
check('a fresh install has answered nothing', () => {
  assert.deepEqual(loadState().answered, {});
});

fs.writeFileSync(STATE_PATH, JSON.stringify({ answered: ['bc/x'] }));
check('and a file with the field the wrong shape reads the same way', () => {
  assert.deepEqual(loadState().answered, {});
});

fs.rmSync(STATE_PATH, { force: true });
saveState({ answered: recordAnswer({}, 'bc/x', 'said it', NOW) });
check('a record survives a round trip through the file', () => {
  assert.equal(answeredBefore(loadState().answered, 'bc/x')?.response, 'said it');
});

/* ------------------------------------------ the whole loop, against a real server */

/**
 * A `bd` that answers from disk and records its argv.
 *
 * The bead it serves is the shape this is about: open, labelled `human`, no
 * blockers — so answering it closes it, and the close is what takes it out of the
 * inbox. `BD_ANSWERED` is the switch the reopen is staged with: while it is unset the
 * bead is in `human list`, and the test flips it to model the answer closing the bead
 * and then flips it back to model a session reopening it.
 */
const WS = { name: 'bc', dir: path.join(tmp, 'ws') };
fs.mkdirSync(path.join(WS.dir, '.beads'), { recursive: true });
const BIN = path.join(tmp, 'bd');
const LOG = path.join(tmp, 'calls.log');
fs.writeFileSync(
  BIN,
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BD_FAKE_LOG, JSON.stringify(args) + '\\n');
const bead = {
  id: 'bc-goo.2',
  issue_type: 'task',
  status: 'open',
  title: 'Tier 2 — an agent-facing memory API',
  priority: 2,
  labels: ['human'],
  comment_count: 1,
  dependencies: [],
  description: '\\n\`\`\`decision\\nquestion: Build it, or stop here?\\noptions:\\n  - id: build\\n    label: Build both as written\\n\`\`\`\\n',
};
if (args[0] === 'human' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(process.env.BD_CLOSED ? [] : [bead]));
  process.exit(0);
}
if (args[0] === 'show') { process.stdout.write(JSON.stringify([bead])); process.exit(0); }
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
process.exit(0);
`,
  { mode: 0o755 }
);
process.env.BD_FAKE_LOG = LOG;
fs.writeFileSync(LOG, '');
const calls = () =>
  fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const cfg = {
  port,
  host: '127.0.0.1',
  baseUrl: `http://127.0.0.1:${port}`,
  token: 'answered-test-token',
  actor: 'beadcause',
  bdBin: BIN,
  workspaces: [WS],
  spaces: [],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  terminal: false,
  pollSeconds: 3600,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const call = async (pathname, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: opts.method || 'GET',
    headers: { 'x-beadcause-token': cfg.token, 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

try {
  saveState({ answered: {} });

  const first = await call('/api/questions');
  check('a question nobody has answered yet arrives with nothing attached', () => {
    const q = first.body.questions.find((r) => r.id === 'bc-goo.2');
    assert.ok(q, `the bead is in the inbox (saw ${JSON.stringify(first.body.questions.map((r) => r.id))})`);
    assert.equal(q.answeredBefore, null);
  });

  const answered = await call('/api/respond', {
    method: 'POST',
    body: { workspace: WS.name, id: 'bc-goo.2', response: 'Build both as written — the common repo and remember/recall.' },
  });
  check('answering is accepted and closes the bead', () => {
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.closed, true);
    const args = calls();
    assert.ok(
      args.some((a) => a[0] === 'comment') && args.some((a) => a[0] === 'close'),
      `comment then close (saw ${JSON.stringify(args.map((a) => a[0]))})`
    );
  });

  check('and the answer is written down where the next arrival can find it', () => {
    const rec = answeredBefore(loadState().answered, 'bc/bc-goo.2');
    assert.ok(rec, 'a record exists');
    assert.match(rec.response, /^Build both as written/);
    assert.equal(rec.count, 1);
  });

  // The bead is closed now, so it is out of the sweep entirely. This is the moment
  // that would destroy the record if it were pruned against the live inbox the way
  // `ringing` and `dismissed` are.
  process.env.BD_CLOSED = '1';
  const empty = await call('/api/questions');
  check('the answered bead has left the inbox', () => {
    assert.deepEqual(empty.body.questions, []);
  });
  check('and its record is still there — the sweep must not prune it', () => {
    assert.ok(answeredBefore(loadState().answered, 'bc/bc-goo.2'), 'still recorded');
  });

  // A session reopens it to build what the answer commissioned, and the bead is back
  // in `human list` — a card rebuilt from the tracker, indistinguishable from the
  // first one. This is the arrival the whole file is about.
  delete process.env.BD_CLOSED;
  const again = await call('/api/questions');
  check('when it comes back, the card carries the answer already given', () => {
    const q = again.body.questions.find((r) => r.id === 'bc-goo.2');
    assert.ok(q, 'it is back in the inbox');
    assert.ok(q.answeredBefore, 'and it says so');
    assert.match(q.answeredBefore.response, /^Build both as written/);
    assert.ok(q.answeredBefore.at, 'with when');
  });

  const detail = await call(`/api/question?workspace=${WS.name}&id=bc-goo.2`);
  check('the detail fetch carries it too, so opening the card does not lose it', () => {
    assert.ok(detail.body.answeredBefore, JSON.stringify(detail.body.answeredBefore));
    assert.match(detail.body.answeredBefore.response, /^Build both as written/);
  });

  await call('/api/respond', {
    method: 'POST',
    body: { workspace: WS.name, id: 'bc-goo.2', response: 'Build both as written — the common repo and remember/recall.' },
  });
  const third = await call('/api/questions');
  check('answering it a second time keeps counting, which is what stops a third', () => {
    const q = third.body.questions.find((r) => r.id === 'bc-goo.2');
    assert.equal(q.answeredBefore.count, 2, JSON.stringify(q.answeredBefore));
  });

  check('a bead nobody has answered is still clean after all of that', () => {
    assert.equal(answeredBefore(loadState().answered, 'bc/bc-other'), null);
  });
} finally {
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
