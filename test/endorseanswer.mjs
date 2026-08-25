#!/usr/bin/env node
/**
 * *"…and endorse bc-xl7n.121"* — the endorsement gesture, reached from the inbox.
 *
 *     npm test
 *     node test/endorseanswer.mjs
 *
 * Endorsing is one gesture wherever Adam is — `/api/bead/endorse` is the door, the
 * `/endorse` page and `bin/endorse.js` both post to it, and `POST /api/session` is *"the
 * one door that endorses rather than refuses"* because you tapping **work on this** is
 * you present and choosing. The inbox was the surface that gesture never reached, and it
 * cost three days twice over:
 *
 * - **2026-08-22**, answering bc-xl7n.124 by typing *"bc-xl7n.121 endorsed so the class
 *   stops recurring."*
 * - **2026-08-25**, answering bc-ogicx.13 by **tapping** its own option: *"Run the
 *   update-branch on PR 703, and endorse bc-xl7n.121 so the stale-check hold gets a
 *   producer instead of a manual nudge each time."*
 *
 * Both were recorded as prose, both cards closed, and both times `unendorsed` stayed
 * exactly where it was — while bc-xl7n.121, the class fix for ten pull requests held by
 * the stale-check gate, sat one label away from dispatch.
 *
 * Both sentences are fixtures below, verbatim, because a reading that gets a synthetic
 * sentence right and the real one wrong is the failure this suite exists to prevent.
 *
 * Three things are checked and the middle one is the one that goes wrong quietly:
 *
 * 1. **The reading**, in lib/endorseanswer.js, which is pure and needs no server: the
 *    verb, the ids it reaches forwards and backwards, what a negation in front of it
 *    takes off the table, and — the one that matters most — what it refuses to reach.
 *    `endorse bc-a and close bc-b` endorses one bead, and `update-branch` is not a bead
 *    at all, which is why ids are found by workspace prefix rather than by shape.
 * 2. **That the answer performs it**, over HTTP, against a fake `bd` whose argv is on
 *    disk — so "the marker came off" is `['label','remove',…]` having been run and not
 *    an assumption. Both real sentences, and both endings: the typed one and the tapped
 *    one, the second of which closed its card.
 * 3. **That an endorsement `bd` refuses does not close the card.** bc-xl7n.76.3's
 *    acceptance criterion is that such an answer is *"never recorded as settled with the
 *    marker still on"*, so a named bead that does not exist leaves the question open in
 *    the inbox with the reason on the thread, rather than closing over an instruction
 *    nobody carried out.
 *
 * The real `bd` is never run. Same shape as test/defer.mjs and test/commission.mjs,
 * which prove the other endings of this handler.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-endorseanswer-'));
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

/* ------------------------------------------------------------ the reading, alone */

const { endorsementsIn, endorsementNote, endorsementResult, ENDORSE_CAP } = await import(LIB('endorseanswer.js'));

/** Every fixture here is answered about the `bc` workspace, as both incidents were. */
const read = (text) => endorsementsIn(text, { prefix: 'bc' });

console.log('\nwhat an answer says about endorsing');

/** The two sentences that were actually written, verbatim. */
const TYPED = 'bc-xl7n.121 endorsed so the class stops recurring.';
const TAPPED =
  'Run the update-branch on PR 703, and endorse bc-xl7n.121 so the stale-check hold gets a producer instead of a manual nudge each time.';

check(
  () => assert.deepEqual(read(TYPED).endorse, ['bc-xl7n.121']),
  'the id sits *before* the verb in the sentence Adam actually typed, and is still reached'
);
check(
  () => assert.deepEqual(read(TAPPED).endorse, ['bc-xl7n.121']),
  'and after it in the option he tapped a fortnight later'
);
check(
  () => assert.deepEqual(read(TAPPED).declined, []),
  'with nothing in the tapped sentence read as a refusal — "instead of a manual nudge" is not one'
);
check(
  () => assert.deepEqual(read('Run the update-branch on PR 703.').endorse, []),
  '`update-branch` is not a bead — which is why ids are found by the workspace prefix and never by shape'
);

check(
  () => assert.deepEqual(read('endorse bc-aaa1 and bc-bbb2 so both can move').endorse, ['bc-aaa1', 'bc-bbb2']),
  'a list joined by `and` is one instruction'
);
check(
  () => assert.deepEqual(read('endorse bc-aaa1, bc-bbb2').endorse, ['bc-aaa1', 'bc-bbb2']),
  'and so is one joined by a comma'
);
check(
  () => assert.deepEqual(read('endorse both bc-aaa1 and bc-bbb2').endorse, ['bc-aaa1', 'bc-bbb2']),
  'with a word like `both` allowed to sit between the verb and the first id'
);
check(
  () => assert.deepEqual(read('endorse bc-aaa1 and close bc-bbb2').endorse, ['bc-aaa1']),
  'but a second verb ends the list — `endorse bc-a and close bc-b` endorses exactly one bead'
);
check(
  () => assert.deepEqual(read('endorse bc-aaa1. bc-bbb2 is separate.').endorse, ['bc-aaa1']),
  'and so does the end of the sentence, dotted bead ids notwithstanding'
);
check(
  () => assert.deepEqual(read('bc-aaa1 is fine. bc-bbb2 endorsed.').endorse, ['bc-bbb2']),
  'which walking backwards has to respect too, or the previous sentence joins in'
);
check(
  () => assert.deepEqual(read('Endorse **bc-xl7n.121**, it unblocks ten PRs.').endorse, ['bc-xl7n.121']),
  'markdown around the id is stripped — a phone answer is written, not typed into a form'
);

console.log('\nand what it refuses to read as one');

check(() => assert.deepEqual(read('Do not endorse bc-aaa1.').endorse, []), '"do not endorse" endorses nothing');
check(
  () => assert.deepEqual(read('Do not endorse bc-aaa1.').declined, ['bc-aaa1']),
  'and says so — "I read this and did nothing" going unsaid is the whole of this bug'
);
check(() => assert.deepEqual(read("don't endorse bc-aaa1").endorse, []), 'nor does the contracted form');
check(() => assert.deepEqual(read('without endorsing bc-aaa1').declined, ['bc-aaa1']), 'nor "without endorsing"');
check(
  () => assert.deepEqual(read('rather than endorsing bc-aaa1, close it').declined, ['bc-aaa1']),
  'nor "rather than endorsing"'
);
check(
  () => assert.deepEqual(read('I would rather endorse bc-aaa1').endorse, ['bc-aaa1']),
  'but a bare `rather` is not a refusal — only the two-word forms are'
);
check(
  () => assert.deepEqual(read('endorse bc-aaa1 — it is not blocked').endorse, ['bc-aaa1']),
  'and a `not` *after* the verb negates nothing: the window is the few words in front of it'
);
check(
  () => assert.deepEqual(read('Do not do that. Endorse bc-aaa1.').endorse, ['bc-aaa1']),
  'stopped at the end of the previous sentence, or an unrelated refusal two clauses back would swallow it'
);
check(() => assert.deepEqual(read('Ship it').endorse, []), 'a sentence naming no bead names no bead');
check(
  () => assert.deepEqual(read('endorse sp-4q4b').endorse, []),
  'and an id under another workspace prefix is not this workspace to endorse in'
);
check(
  () => assert.deepEqual(read('update-branch on PR 703, endorse it').endorse, []),
  '"endorse it" names nothing — this reads ids, and never guesses at a pronoun'
);

const MANY = `endorse ${Array.from({ length: ENDORSE_CAP + 2 }, (_, i) => `bc-aa${String(i).padStart(2, '0')}`).join(', ')}`;
check(() => assert.equal(read(MANY).endorse.length, ENDORSE_CAP), `at most ${ENDORSE_CAP} beads come off one answer`);
check(() => assert.equal(read(MANY).dropped.length, 2), 'and the rest are reported rather than dropped in silence');

console.log('\nand the line it puts on the thread');

check(
  () =>
    assert.match(
      endorsementNote(read(TYPED), { ok: [{ id: 'bc-xl7n.121', endorsed: true }], failed: [] }),
      /^Endorsed: bc-xl7n\.121\.$/
    ),
  'an endorsement that landed says so, naming the bead'
);
check(
  () =>
    assert.match(
      endorsementNote(read(TYPED), { ok: [{ id: 'bc-xl7n.121', endorsed: false }], failed: [] }),
      /Already endorsed/
    ),
  'one that had already happened says that instead of claiming a write it did not make'
);
check(
  () =>
    assert.match(
      endorsementNote(read(TYPED), { ok: [], failed: [{ id: 'bc-xl7n.121', error: 'no such bead: bc-xl7n.121' }] }),
      /Could not endorse bc-xl7n\.121 — no such bead/
    ),
  'and a refusal carries bd’s own reason'
);
check(() => assert.equal(endorsementResult({ endorse: [], declined: [], dropped: [] }, null), null), 'an answer that named nothing reports nothing');

/* -------------------------------------------------------------- the fake bd */

const CALLS = path.join(tmp, 'calls.log');
const FAKE = path.join(tmp, 'bd');

/**
 * One card with two options, both of which say to endorse the same other bead.
 *
 * `settle` is the shape of the bc-ogicx.13 option that started this: an ordinary
 * closing verdict whose response text is nevertheless an instruction. `gone` names a
 * bead the tracker does not have, which is the refusal half of the acceptance criterion.
 */
const BLOCK = `Which way?

\`\`\`decision
question: Take the branch update, or leave it?
options:
  - id: settle
    label: Update the branch
    response: "Run the update-branch on PR 703, and endorse bc-xl7n.121 so the stale-check hold gets a producer instead of a manual nudge each time."
  - id: gone
    label: Endorse the one that no longer exists
    response: "Endorse bc-nope1 as well."
\`\`\`
`;

fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const DESC = ${JSON.stringify(BLOCK)};
// The label state is on disk so a 'label remove' is visible to the 'show' after it —
// otherwise every endorsement would look idempotent and 'the marker came off' could not
// be told from 'it was never on'.
const HELD = ${JSON.stringify(path.join(tmp, 'held.json'))};
const held = () => { try { return JSON.parse(fs.readFileSync(HELD, 'utf8')); } catch { return { 'bc-xl7n.121': true }; } };
const card = (id) => ({
  id, issue_type: 'task', status: 'open', title: 'Which way?', comment_count: 0,
  priority: 1, labels: ['human'], description: DESC, dependencies: [],
});
const target = (id) => ({
  id, issue_type: 'bug', status: 'open', title: 'A pull request held for stale checks', comment_count: 0,
  priority: 1, labels: held()[id] ? ['unendorsed'] : [], description: 'held', dependencies: [],
});
if (args[0] === 'show') {
  const id = args[1];
  if (id === 'bc-nope1') { process.stderr.write('no issues found matching bc-nope1'); process.exit(1); }
  process.stdout.write(JSON.stringify([id.startsWith('bc-card') ? card(id) : target(id)]));
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'remove') {
  const state = held();
  delete state[args[2]];
  fs.writeFileSync(HELD, JSON.stringify(state));
  process.stdout.write('ok');
  process.exit(0);
}
if (args[0] === 'human' && args[1] === 'list') { process.stdout.write(JSON.stringify([card('bc-card1')])); process.exit(0); }
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
const reset = () => {
  fs.writeFileSync(CALLS, '');
  fs.rmSync(path.join(tmp, 'held.json'), { force: true });
};
/** Did bd get told to take the marker off this bead? */
const marked = (id) => calls().some((a) => a[0] === 'label' && a[1] === 'remove' && a[2] === id && a[3] === 'unendorsed');
const closed = (id) => calls().some((a) => a[0] === 'close' && a.includes(id));

/* ----------------------------------------------------------------- the app */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'endorse-answer-token',
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

/* -------------------------------------------------- the option Adam actually tapped */

console.log('\nanswering a card with an instruction to endorse another bead');

reset();
const tapped = await call('/api/respond', {
  workspace: 'demo',
  id: 'bc-card1',
  response: 'Run the update-branch on PR 703, and endorse bc-xl7n.121 so the stale-check hold gets a producer instead of a manual nudge each time.',
  option: 'settle',
});

check(() => assert.equal(tapped.status, 200, JSON.stringify(tapped.json)), 'the answer is accepted');
check(
  () => assert.ok(marked('bc-xl7n.121'), JSON.stringify(calls())),
  'and the bead the answer NAMES has its `unendorsed` label removed — the acceptance criterion, and what happened neither time'
);
check(() => assert.deepEqual(tapped.json.endorsement?.endorsed, ['bc-xl7n.121']), 'the reply says which bead moved');
check(() => assert.equal(tapped.json.closed, true), 'and the card still closes, because this option settles the question');
check(() => assert.ok(closed('bc-card1'), JSON.stringify(calls())), 'against bd, not just in the reply');
check(() => {
  const comment = calls().find((a) => a[0] === 'comment' && a.some((x) => /Endorsed: bc-xl7n\.121/.test(String(x))));
  assert.ok(comment, JSON.stringify(calls().filter((a) => a[0] === 'comment')));
}, 'and the thread carries what was endorsed, beside the answer itself');

/* ---------------------------------------------------------- the sentence he typed */

reset();
const typed = await call('/api/respond', {
  workspace: 'demo',
  id: 'bc-card1',
  response: 'bc-xl7n.121 endorsed so the class stops recurring.',
});

check(
  () => assert.ok(marked('bc-xl7n.121'), JSON.stringify(calls())),
  'a *typed* answer endorses too — the id is a name, not an inference about what a sentence meant'
);
check(
  () => assert.equal(typed.json.closed, true),
  'and it closes: an endorsement is not a commission, so the "pick an option" tax does not apply'
);

/* ------------------------------------------------------ the second tap, idempotent */

const again = await call('/api/respond', {
  workspace: 'demo',
  id: 'bc-card1',
  response: 'bc-xl7n.121 endorsed so the class stops recurring.',
});
check(
  () => assert.deepEqual(again.json.endorsement?.already, ['bc-xl7n.121']),
  'answering twice reports "already endorsed" rather than claiming a second write'
);
check(() => assert.deepEqual(again.json.endorsement?.endorsed, []), 'with nothing said to have moved');

/* ------------------------------------------- an endorsement bd will not perform */

console.log('\nand one bd refuses');

reset();
const stuck = await call('/api/respond', {
  workspace: 'demo',
  id: 'bc-card1',
  response: 'Endorse bc-nope1 as well.',
  option: 'gone',
});

check(() => assert.equal(stuck.status, 200, JSON.stringify(stuck.json)), 'the request is not an error — the answer is real');
check(
  () => assert.equal(stuck.json.closed, false),
  'but the card does NOT close: an answer naming an endorsement that did not happen is never recorded as settled'
);
check(() => assert.ok(!closed('bc-card1'), JSON.stringify(calls())), 'and bd is never asked to close it');
check(
  () => assert.equal(stuck.json.handedBack, false),
  'nor is it handed back — nothing was given to an agent, the question is still yours'
);
check(() => assert.equal(stuck.json.endorsement?.failed?.[0]?.id, 'bc-nope1'), 'the reply names the bead that could not be endorsed');
check(() => {
  const said = calls().find((a) => a[0] === 'comment' && a.some((x) => /Could not endorse bc-nope1/.test(String(x))));
  assert.ok(said, JSON.stringify(calls().filter((a) => a[0] === 'comment')));
}, 'and so does the thread, with bd’s reason on it — refused in a way that says so');
check(() => {
  const labels = calls().filter((a) => a[0] === 'label');
  assert.deepEqual(labels, [], JSON.stringify(labels));
}, 'and nothing about this bead moved — no label write at all, the way an ambiguous answer leaves it');

/* -------------------------------------------- the answer that says nothing about it */

console.log('\nand the ordinary answer, which is nearly all of them');

reset();
const plain = await call('/api/respond', {
  workspace: 'demo',
  id: 'bc-card1',
  response: 'Yes, that reading is right.',
});
check(() => assert.equal(plain.json.endorsement, null), 'reports no endorsement at all');
check(() => assert.equal(plain.json.closed, true), 'and closes exactly as it always did');
check(
  () => assert.ok(!calls().some((a) => a[0] === 'label')),
  'having asked bd for no label write — the reading runs in process, before any spawn'
);

console.log('');
for (const s of servers) s.close();
cleanupTmp(tmp);
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall good\x1b[0m (${ran} checks)`);
