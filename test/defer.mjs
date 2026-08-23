#!/usr/bin/env node
/**
 * *Not yet* — an option that answers without closing and without commissioning.
 *
 *     npm test
 *     node test/defer.mjs
 *
 * There are two kinds of non-closing answer and for a while `closes: false` was the
 * only way to write either of them. One is a **commission** — "build both as written"
 * — which hands the bead to an agent, and test/commission.mjs is the suite for it. The
 * other is a **deferral**: *not yet, leave this on the list*, which hands the bead to
 * nobody and leaves the card exactly where it was.
 *
 * bc-7qo.10 offered the second one and got the first. Its third option read
 *
 *     - id: park
 *       label: Not yet — leave it blocked
 *       hint: Keeps this card on the list.
 *       closes: false
 *
 * so the tap routed through `Bd.commission`, which takes the `human` label off. The
 * card fell out of the inbox into `bd ready`, and the next advocate tick opened an
 * unattended worker window on the question that had just been put off. The hint said
 * "keeps this card on the list" and the machinery did the opposite of it.
 *
 * So an option may carry `defers: true`, and what that has to buy is five things, none
 * of which is implied by any of the others:
 *
 *   1. the answer is **on the thread**, exactly as any other answer would be;
 *   2. the bead is **not closed**;
 *   3. it is **still in the inbox** — the `human` label stays, which is the same write
 *      that keeps it *out* of an advocate's `bd ready --exclude-label human`, so no
 *      worker window can open on it;
 *   4. it is open and **unclaimed**, because a card carrying an assignee is a worker
 *      window having touched it and there is nothing there to preserve;
 *   5. the thread says **deferred**, not "handed back" — the reader is an agent
 *      deciding whether it has just been given work, and that sentence is the whole of
 *      what it has to go on.
 *
 * And the three claims a regression breaks first, which is why all four endings are
 * driven against **one card**: an ordinary option still closes, a commissioning option
 * still hands back and still leaves the inbox, and a *typed* answer on a card that
 * offers a deferral still closes rather than coming back "pick an option". That last
 * one is the tax this change was meant to remove and not to move: `anyCommission` in
 * lib/server.js excludes a deferral on purpose, because nothing is at risk of being
 * dropped by closing on a sentence when no option would have started work.
 *
 * The real `bd` is never run: `cfg.bdBin` points at a fake that records every
 * invocation, so each claim is checked against the argv bd would have been given.
 * Same shape as test/commission.mjs, which proves the other two endings.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-defer-'));
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

/* ------------------------------------------------------- the parse, on its own */

const { parseDecision, optionById, toQuestion } = await import(LIB('decision.js'));

/**
 * One card with all three endings on it, which is the shape an agent actually writes:
 * a verdict, a build order, and a way to say not yet.
 *
 * `park-yes` is the spelling tolerance — YAML's core schema reads `yes` as the string
 * "yes", and an agent writing it means this. `park-contradiction` is the block
 * disagreeing with itself: `defers` wins over `closes: true`, because it is the more
 * specific statement and the only one of the two that can be wrong in the direction
 * that loses the card.
 */
const BLOCK = `Which of these, then?

\`\`\`decision
question: Decide it, order it, or leave it on the list?
options:
  - id: settle
    label: The shape is right — write it down and stop
    response: "The shape is right. Record it; no code yet."
  - id: build
    label: Build both as written
    response: "Build both, as written."
    closes: false
  - id: park
    label: Not yet — leave it on the list
    hint: Keeps this card on the list.
    response: "Not yet. Leave this on the list."
    defers: true
  - id: park-yes
    label: Also not yet
    response: "Also not yet."
    defers: yes
  - id: park-contradiction
    label: Not yet, said twice over
    response: "Not yet, said twice over."
    closes: true
    defers: true
\`\`\`
`;

const parsed = parseDecision(BLOCK);
const opt = (id) => parsed.decision.options.find((o) => o.id === id);

check(() => assert.equal(opt('park').defers, true), '`defers: true` is read off the option that carries it');
check(
  () => assert.equal(opt('park').closes, false),
  'and a deferral does not close — every surface that already reads `closes === false` keeps working'
);
check(
  () => assert.equal(opt('park-yes').defers, true),
  'and `yes` means the same as `true`, because YAML says it is a string'
);
check(
  () => assert.equal(opt('park-contradiction').defers, true) || assert.equal(opt('park-contradiction').closes, false),
  '`defers: true` beside `closes: true` defers — the specific statement wins over the general one'
);
check(
  () => assert.equal(opt('build').defers, false),
  'a commission is NOT a deferral, which is the distinction the whole change is about'
);
check(() => assert.equal(opt('settle').defers, false), 'and an ordinary option defers nothing');
check(
  () => assert.equal(parseDecision('```decision\noptions:\n  - Ship it\n```').decision.options[0].defers, false),
  'a bare-string option does not defer — there is nowhere to say otherwise'
);
check(
  () => assert.equal(parseDecision('```decision\noptions:\n  - id: x\n    label: X\n    defers: maybe\n```').decision.options[0].defers, false),
  'and a spelling nobody reads falls back to an ordinary option rather than inventing an ending'
);

const q = toQuestion('demo', { id: 'zz-1', title: 'T', description: BLOCK });
check(() => assert.equal(optionById(q, 'park')?.defers, true), 'optionById hands back the deferral with its flag intact');

/* -------------------------------------------------------------- the fake bd */

const CALLS = path.join(tmp, 'calls.log');
const FAKE = path.join(tmp, 'bd');

// The block lives in the description, which is where `bd show` hands it back — the
// server re-reads it rather than trusting the id the phone sent, so the fixture has to
// be the bead itself and not a card. zz-parkonly is the control for the typed-answer
// rule: a card whose only non-closing option is a deferral, which must still close on
// a sentence.
const PARK_ONLY = `Leave it or settle it?

\`\`\`decision
question: Settle it now, or leave it on the list?
options:
  - id: settle
    label: Settle it
    response: "Settled."
  - id: park
    label: Not yet
    response: "Not yet."
    defers: true
\`\`\`
`;

fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const DESC = ${JSON.stringify(BLOCK)};
const PARK_ONLY = ${JSON.stringify(PARK_ONLY)};
const bead = (id) => ({
  id, issue_type: 'task', status: 'open', title: 'Decide, order or defer', comment_count: 0,
  priority: 1, labels: ['human'],
  description: id === 'zz-parkonly' ? PARK_ONLY : DESC,
  dependencies: [],
});
if (args[0] === 'show') { process.stdout.write(JSON.stringify([bead(args[1])])); process.exit(0); }
if (args[0] === 'human' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([bead('zz-1'), bead('zz-2')]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const calls = () =>
  fs.existsSync(CALLS)
    ? fs
        .readFileSync(CALLS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
/** Everything bd was told to *write*. `show`/`comments`/`list` are reads. */
const writes = () => calls().filter((a) => ['comment', 'close', 'update', 'create', 'label'].includes(a[0]));
const reset = () => fs.writeFileSync(CALLS, '');

/* ----------------------------------------------------------------- the app */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'defer-token',
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

console.log('\ndeferring options\n');

/* ----------------------------------------------------------------- a deferral */

reset();
const parked = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-1',
  response: 'Not yet. Leave this on the list.',
  option: 'park',
});
const parkedWrites = writes();

check(() => assert.equal(parked.status, 200, JSON.stringify(parked.json)), 'answering a deferring option succeeds');
check(() => assert.equal(parked.json.closed, false), 'and reports that nothing was closed');
check(
  () => assert.equal(parked.json.deferred, true),
  'saying outright that it was deferred — the fourth outcome, and the one no client had seen'
);
check(
  () => assert.equal(parked.json.handedBack, false),
  'and NOT a hand-back: nothing was handed to anybody, which is the whole difference'
);
check(
  () => assert.equal(parked.json.needsChoice, false),
  'nor a choice still owed — a choice was made, and the card being there must not read as the tap having missed'
);
check(
  () => assert.ok(!parkedWrites.some((a) => a[0] === 'close'), `bd was told to: ${JSON.stringify(parkedWrites)}`),
  'the bead is NOT closed'
);
check(
  () => assert.equal(parkedWrites[0]?.[0], 'comment'),
  'the answer goes on the thread first, so nothing after it can lose the answer'
);
check(
  () => assert.match(String(parkedWrites[0]?.[2] || ''), /^Not yet\. Leave this on the list\./),
  'verbatim, the sentence the option wrote'
);
check(
  () => assert.match(String(parkedWrites[0]?.[2] || ''), /defers the question/),
  'with a line saying it was deferred, for the agent that reads the thread deciding whether it has work'
);
check(
  () => assert.doesNotMatch(String(parkedWrites[0]?.[2] || ''), /handed back/),
  'and NOT the hand-back sentence — that is the one bc-7qo.10 collected'
);
check(
  () =>
    assert.ok(
      !parkedWrites.some((a) => a[0] === 'label' && a[1] === 'remove' && a[3] === 'human'),
      `bd was told to: ${JSON.stringify(parkedWrites)}`
    ),
  'the `human` label STAYS — which is both "still in the inbox" and "out of every advocate queue"'
);
check(() => {
  const update = parkedWrites.find((a) => a[0] === 'update');
  assert.ok(update, `no update in ${JSON.stringify(parkedWrites)}`);
  assert.ok(update.includes('--status') && update[update.indexOf('--status') + 1] === 'open', `status: ${update}`);
  assert.ok(update.includes('--assignee') && update[update.indexOf('--assignee') + 1] === '', `assignee: ${update}`);
}, 'and it is left open with the claim dropped — a card carrying an agent is a worker window having touched it');

/* -------------------------------------------------------------- a commission */

// The same card, so a regression that turned every non-closing option into a deferral
// fails here rather than passing everything above.
reset();
const handed = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-1',
  response: 'Build both, as written.',
  option: 'build',
});
const handedWrites = writes();

check(() => assert.equal(handed.json.handedBack, true), 'a commissioning option on the same card still hands back');
check(() => assert.equal(handed.json.deferred, false), 'and does not claim a deferral');
check(
  () =>
    assert.ok(
      handedWrites.some((a) => a[0] === 'label' && a[1] === 'remove' && a[3] === 'human'),
      `bd was told to: ${JSON.stringify(handedWrites)}`
    ),
  'and it still leaves the inbox — the `human` label comes off, exactly as it always did'
);

/* ---------------------------------------------------------- an ordinary option */

reset();
const closed = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-1',
  response: 'The shape is right. Record it; no code yet.',
  option: 'settle',
});

check(() => assert.equal(closed.json.closed, true), 'an ordinary option on the same card still closes');
check(() => assert.equal(closed.json.deferred, false), 'and claims neither of the other two endings');
check(() => assert.equal(closed.json.handedBack, false), 'neither of them');
check(
  () =>
    assert.deepEqual(
      writes().map((a) => a[0]),
      ['comment', 'close'],
      `bd was told to: ${JSON.stringify(writes())}`
    ),
  'comment then close, and no label or status write anywhere near it'
);

/* ------------------------------------- a typed answer, where the tax used to move to */

/**
 * The claim this change is most likely to break by accident.
 *
 * `anyCommission` in lib/server.js makes a *typed* answer on a card where a button
 * would have started work "not an answer yet" — bc-wy06 typed "Ship it" and lost the
 * commission. A deferral is `closes: false` too, so counting it there would have made
 * every typed answer on every card offering "not yet" come back *pick an option* — the
 * same tax this bead removes, moved one step along. It does not: nothing is at risk of
 * being dropped by closing on a sentence when no option would have started work.
 */
reset();
const typedParkOnly = await call('/api/respond', {
  workspace: 'demo',
  id: 'zz-parkonly',
  response: 'Yes, go ahead.',
});
check(
  () =>
    assert.deepEqual(
      writes().map((a) => a[0]),
      ['comment', 'close'],
      `bd was told to: ${JSON.stringify(writes())}`
    ),
  'a typed answer on a card whose only non-closing option is a deferral closes, as it always did'
);
check(() => assert.equal(typedParkOnly.json.needsChoice, false), 'and is not sent back for a choice');
check(() => assert.equal(typedParkOnly.json.deferred, false), 'and a sentence is never read as a deferral');

/**
 * The other half of that, and the reason the two have to be asserted together: a card
 * carrying a *real* commission beside a deferral is still ambiguous on a sentence.
 */
reset();
const typedMixed = await call('/api/respond', { workspace: 'demo', id: 'zz-1', response: 'Do it however you like.' });
check(() => assert.equal(typedMixed.json.needsChoice, true), 'a commission option beside a deferral still needs a choice');
check(
  () =>
    assert.deepEqual(
      writes().map((a) => a[0]),
      ['comment'],
      `bd was told to: ${JSON.stringify(writes())}`
    ),
  'and writes the words and nothing else'
);

for (const s of servers || []) s.close?.();
await cleanupTmp(tmp);

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
