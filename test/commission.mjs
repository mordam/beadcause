#!/usr/bin/env node
/**
 * An option that commissions work does not close the bead.
 *
 *     npm test
 *     node test/commission.mjs
 *
 * Answering closes the bead, because a question that has been answered is finished.
 * That is true of a conclusion and wrong of an **instruction**: three of bc-goo.2's
 * four options were build orders ("Build both as written", "Build the API only"), so
 * the close was the mechanism's rather than the decision's. The work was filed as
 * done in the same breath as being ordered, a session had to reopen the bead by hand
 * to do what it had just been told to do, and the reopen is what put the card back in
 * the inbox and collected the same answer an hour later.
 *
 * So an option may carry `closes: false`, and what that has to buy is four things at
 * once — none of which is implied by any of the others:
 *
 *   1. the answer is **on the thread**, exactly as an ordinary answer would be;
 *   2. the bead is **not closed**;
 *   3. it is **out of the inbox** — the `human` label comes off, which is the same
 *      write that puts it in front of an advocate;
 *   4. it is **claimable** — open and unassigned, or `bd ready` skips it and the
 *      hand-back is a quieter version of the failure it replaces.
 *
 * And the fifth claim, which is the one a regression would break first: **an
 * ordinary option still closes.** A feature that turned every answer into a
 * hand-back would pass the first four and be far worse than what it replaced.
 *
 * The real `bd` is never run: `cfg.bdBin` points at a fake that records every
 * invocation, so each of the claims above is checked against the argv bd would have
 * been given. Same shape as test/closepaths.mjs, which proves the other two endings.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-commission-'));
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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checkAsync = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ------------------------------------------------------- the parse, on its own */

const { parseDecision, optionById, toQuestion } = await import(LIB('decision.js'));

const BLOCK = `Which of these, then?

\`\`\`decision
question: Build it, or just decide the shape?
options:
  - id: build-both
    label: Build both as written
    response: "Build both, as written."
    closes: false
  - id: shape-only
    label: The shape is right — write it down and stop
    response: "The shape is right. Record it; no code yet."
  - id: neither
    label: Neither
    closes: "no"
\`\`\`
`;

const parsed = parseDecision(BLOCK);
check(
  () => assert.equal(parsed.decision.options.find((o) => o.id === 'build-both').closes, false),
  '`closes: false` is read off the option that carries it'
);
check(
  () => assert.equal(parsed.decision.options.find((o) => o.id === 'shape-only').closes, true),
  'and every other option closes, because that is what an answer has always done'
);
check(
  // YAML's core schema reads `no` as the string "no", not a boolean. An agent that
  // writes it means the same thing, and reading it as truthy would leave the bead
  // closed with nothing on screen to say the hand-back never happened.
  () => assert.equal(parsed.decision.options.find((o) => o.id === 'neither').closes, false),
  'and `no` means the same as `false`, because YAML says it is a string'
);
check(() => assert.equal(parseDecision('```decision\noptions:\n  - Ship it\n```').decision.options[0].closes, true),
  'a bare-string option closes — there is nowhere to say otherwise');

const q = toQuestion('demo', { id: 'zz-1', title: 'T', description: BLOCK });
check(() => assert.equal(optionById(q, 'build-both')?.id, 'build-both'), 'optionById finds the option by its id');
check(() => assert.equal(optionById(q, 'no-such-option'), null), 'and answers null for an id the bead does not carry');
check(() => assert.equal(optionById(q, ''), null), 'and for no id at all — a typed answer names no option');

/* -------------------------------------------------------------- the fake bd */

const CALLS = path.join(tmp, 'calls.log');
const FAKE = path.join(tmp, 'bd');
const write = (body) => fs.writeFileSync(FAKE, body, { mode: 0o755 });

// The block lives in the description, which is where `bd show` hands it back — the
// server re-reads it rather than trusting the id the phone sent, so the fixture has
// to be the bead itself and not a card.
const BLOCK_JSON = JSON.stringify(BLOCK);
write(`#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const DESC = ${BLOCK_JSON};
const bead = (id) => ({
  id, issue_type: 'task', status: 'open', title: 'Build it or not', comment_count: 0,
  priority: 1, labels: ['human'], description: DESC, dependencies: [],
});
if (args[0] === 'show') { process.stdout.write(JSON.stringify([bead(args[1])])); process.exit(0); }
if (args[0] === 'human' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([bead('zz-1'), bead('zz-2')]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
`);

const calls = () =>
  fs.existsSync(CALLS)
    ? fs
        .readFileSync(CALLS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const reset = () => fs.writeFileSync(CALLS, '');
/** Everything bd was told to *write*. `show`/`comments`/`list` are reads. */
const writes = () => calls().filter((a) => ['comment', 'close', 'update', 'create', 'label'].includes(a[0]));

/* ----------------------------------------------------------------- the app */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'commission-token',
  actor: 'beadcause-test',
  bdBin: FAKE,
  workspaces: [{ name: 'demo', dir: ws }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const call = (pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-beadcause-token': cfg.token,
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
    req.write(payload);
    req.end();
  });

console.log('\ncommissioning options\n');

/* ------------------------------------------------------------- a commission */

reset();
const handed = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-1',
  response: 'Build both, as written.',
  option: 'build-both',
});
const handedWrites = writes();

check(() => assert.equal(handed.status, 200), 'answering a commissioning option succeeds');
check(() => assert.equal(handed.json.closed, false), 'and reports that nothing was closed');
check(() => assert.equal(handed.json.handedBack, true), 'saying outright that the work was handed back');
check(
  () => assert.ok(!handedWrites.some((a) => a[0] === 'close'), `bd was told to: ${JSON.stringify(handedWrites)}`),
  'the bead is NOT closed — this is the whole of it'
);
check(
  () => assert.equal(handedWrites[0]?.[0], 'comment'),
  'the answer goes on the thread first, so nothing after it can lose the answer'
);
check(
  () => assert.match(String(handedWrites[0]?.[2] || ''), /^Build both, as written\./),
  'verbatim, the sentence the option wrote'
);
check(
  () => assert.match(String(handedWrites[0]?.[2] || ''), /Left open and handed back/),
  'with a line saying what happened to the bead, for the agent that reads the thread'
);
check(
  () =>
    assert.ok(
      handedWrites.some((a) => a[0] === 'label' && a[1] === 'remove' && a[3] === 'human'),
      `bd was told to: ${JSON.stringify(handedWrites)}`
    ),
  'the `human` label comes off — which is both "out of the inbox" and "into bd ready"'
);
check(() => {
  const update = handedWrites.find((a) => a[0] === 'update');
  assert.ok(update, `no update in ${JSON.stringify(handedWrites)}`);
  assert.ok(update.includes('--status') && update[update.indexOf('--status') + 1] === 'open', `status: ${update}`);
  assert.ok(update.includes('--assignee') && update[update.indexOf('--assignee') + 1] === '', `assignee: ${update}`);
}, 'and it is left open with the claim dropped, or `bd ready` would skip it');

await checkAsync(async () => {
  const ids = (await app.allQuestions()).map((r) => r.id);
  // The fake still labels every bead `human` — the point here is that the card left
  // the *inbox* by the same write, which is what `label remove` above proves. What
  // this asserts is the weaker and still necessary thing: answering did not take the
  // wrong bead out, and the sweep still works after a hand-back.
  assert.ok(ids.includes('zz-2'), `lost the other question: ${ids.join(',')}`);
}, 'and the rest of the inbox is untouched');

/* -------------------------------------------------------- an ordinary option */

reset();
const closed = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-1',
  response: 'The shape is right. Record it; no code yet.',
  option: 'shape-only',
});
const closedWrites = writes();

check(() => assert.equal(closed.status, 200), 'an ordinary option still answers');
check(() => assert.equal(closed.json.closed, true), 'and still reports a close');
check(() => assert.equal(closed.json.handedBack, false), 'and does not claim a hand-back');
check(
  () => assert.deepEqual(closedWrites.map((a) => a[0]), ['comment', 'close'], `bd was told to: ${JSON.stringify(closedWrites)}`),
  'comment then close, exactly as before — and no label or status write anywhere near it'
);
check(
  () => assert.equal(closedWrites[1]?.[3], 'Answered via Beadcause'),
  'with the close reason it has always had'
);

/* ------------------------------------------------- and the client cannot lie */

// The `closes` flag is the bead's, not the caller's. A client that could name its
// own would be able to leave any question open — and one running against a card a
// poll out of date would close a commission the agent has since marked otherwise.
reset();
const typed = await call('/api/respond', { workspace: 'demo', id: 'zz-1', response: 'Do it however you like.' });
check(
  () => assert.deepEqual(writes().map((a) => a[0]), ['comment', 'close'], `bd was told to: ${JSON.stringify(writes())}`),
  'a typed answer names no option, so it closes'
);

reset();
const bogus = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-1',
  response: 'Whatever you think.',
  option: 'not-an-option-on-this-bead',
});
check(() => assert.equal(bogus.json.closed, true), 'an option id the bead does not carry falls back to closing');
check(
  () => assert.deepEqual(writes().map((a) => a[0]), ['comment', 'close'], `bd was told to: ${JSON.stringify(writes())}`),
  'and it is an ordinary answer, not a refusal — the answer must not be lost over a stale card'
);

for (const s of servers || []) s.close?.();
await cleanupTmp(tmp);

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
