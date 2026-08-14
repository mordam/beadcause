#!/usr/bin/env node
/**
 * The P0 advocate: a fifth agent kind, and the three P0s that must not get one.
 *
 *     npm test
 *     node test/epicadvocate.mjs
 *
 * bc-rfnr.3, and the half of bc-rfnr.4 that is a rule rather than a wiring. Two things
 * here are worth a suite and neither is visible by reading one function:
 *
 * 1. **A fifth kind has to be a whole kind.** `AGENTS` is what `POST /api/console` gates
 *    on, `MARKS` is what draws a conversation's pill, and lib/foundation.js says out loud
 *    that a fifth kind should *fail* the coverage check rather than quietly ship as a
 *    generic 🤖. So this asserts the entry exists, carries a role, carries a mark, and —
 *    the one that matters — that its allowlist grants the writes the repo advocate is
 *    deliberately refused, since that difference is the entire argument for it being a
 *    kind at all.
 * 2. **`wantsAdvocate` is a gate, and every no is a bead it would be wrong about.** An
 *    unowned P0 has nobody to report to. A closed one has nothing to plan and would be
 *    reopened by a planner's last act (lib/stillopen.js). And a crash is not an epic:
 *    lib/errors.js files every daemon crash at P0 by construction, so without this every
 *    stack trace would spin up a planning agent.
 *
 * The brief is asserted as a pure function, the way test/planbrief.mjs asserts the
 * planner's: what is under test is the text an unattended window is handed, and the two
 * sentences it must always contain are the two it is forbidden by.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-epicadv-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { EPIC_ADVOCATE, WAITING_OPEN, WAITING_CLOSE, waitingBlock, waitingOn, wantsAdvocate, isCrash, epicAdvocatePrompt } =
  await import(LIB('epicadvocate.js'));
const { AGENTS, baseline, mark } = await import(LIB('foundation.js'));
const { ERROR_LABEL } = await import(LIB('errors.js'));

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
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

console.log('\none advocate per owned P0\n');

const p0 = (extra = {}) => ({
  id: 'zz-p0',
  title: 'A P0 somebody owns',
  status: 'open',
  priority: 0,
  labels: ['owner:adam@example.com'],
  ...extra,
});

/* ------------------------------------------------------------------ the kind */

check('it is a fifth kind, not a mode — with a foundation and a mark of its own', () => {
  assert.ok(AGENTS.includes(EPIC_ADVOCATE), 'epic-advocate is not in AGENTS, so nothing can own a conversation as one');
  assert.equal(AGENTS.length, 5);
  const b = baseline(EPIC_ADVOCATE);
  assert.equal(b.id, EPIC_ADVOCATE);
  assert.ok(b.role && b.role.length > 200, 'a kind with no role is a mode with extra steps');
  const m = mark(EPIC_ADVOCATE);
  assert.ok(m?.name && m?.emoji, 'lib/foundation.js says a fifth kind must fail this rather than draw as 🤖');
  assert.notEqual(m.emoji, mark('advocate').emoji, 'the two advocates draw the same pill');
});

check('AND ITS PERMISSIONS ARE THE WHOLE ARGUMENT FOR IT BEING ONE', () => {
  const epic = baseline(EPIC_ADVOCATE);
  const repo = baseline('advocate');
  // The repo advocate may not invent work — that is its `writes: false`, and the review
  // step it protects. This one plans a P0 the user has already agreed to by owning it.
  assert.equal(repo.writes, false);
  assert.equal(epic.writes, true);
  assert.ok(epic.allowedTools.includes('Bash(bd create:*)'), 'it cannot file the children it exists to file');
  assert.ok(!repo.allowedTools.includes('Bash(bd create:*)'), 'the repo advocate has quietly gained create');
  // And since bc-goo.12 it is a tier 3 subject too — the experiment starved on the repo
  // advocate alone, whose runs are gated behind a cooldown and an unanswered proposal.
  assert.equal(epic.ownsRepo, true);
});

check('its brief and its protocol are owned by files that exist', () => {
  const b = baseline(EPIC_ADVOCATE);
  for (const f of [b.briefOwner, b.protocolOwner]) {
    assert.ok(fs.existsSync(path.join(HERE, '..', f)), `${f} does not exist, so the signpost points nowhere`);
  }
  assert.equal(b.briefOwner, 'lib/epicadvocate.js');
});

/* -------------------------------------------------------------- who gets one */

check('an owned, open P0 gets an advocate', () => {
  assert.equal(wantsAdvocate(p0()), true);
});

check('AN UNOWNED P0 DOES NOT — there is nobody for it to report to', () => {
  assert.equal(wantsAdvocate(p0({ labels: [] })), false);
  assert.equal(wantsAdvocate(p0({ labels: ['inbox'] })), false);
});

check('A CLOSED P0 DOES NOT — a planner’s last act is to reopen its epic', () => {
  assert.equal(wantsAdvocate(p0({ status: 'closed' })), false);
  assert.equal(wantsAdvocate(p0({ status: 'CLOSED' })), false);
  assert.equal(wantsAdvocate(p0({ status: 'in_progress' })), true, 'but in_progress is ordinary');
});

check('A CRASH P0 DOES NOT — a stack trace is not an epic (bc-rfnr.4)', () => {
  // lib/errors.js files every daemon crash at P0 by construction. Without this, six
  // crashes on a bad afternoon is six planning agents.
  const crash = p0({ labels: ['owner:adam@example.com', ERROR_LABEL] });
  assert.equal(isCrash(crash), true);
  assert.equal(wantsAdvocate(crash), false);
  // It is still a P0 and still owned — it leads the board and is dispatchable directly,
  // which is the point. Only the advocate is withheld.
  assert.equal(isCrash(p0()), false);
});

check('and nothing below P0 gets one, whoever owns it', () => {
  assert.equal(wantsAdvocate(p0({ priority: 1 })), false);
  assert.equal(wantsAdvocate(p0({ priority: 2 })), false);
  assert.equal(wantsAdvocate({}), false);
  assert.equal(wantsAdvocate(null), false);
});

/* --------------------------------------------------- what it writes down */

check('the waiting sentence survives a round trip, and an absent one is null', () => {
  const notes = `some provenance\n\n${waitingBlock('the merge queue in bc-rcrt')}\n\nmore`;
  assert.equal(waitingOn({ notes }), 'the merge queue in bc-rcrt');
  assert.equal(waitingOn({ notes: 'nothing marked here' }), null);
  assert.equal(waitingOn({}), null);
  assert.equal(waitingOn(null), null);
});

check('it is one line, bounded, and an empty one erases rather than writing a hollow block', () => {
  assert.equal(waitingBlock('  a   \n  b  '), `${WAITING_OPEN}\na b\n${WAITING_CLOSE}`);
  assert.equal(waitingBlock(''), '');
  assert.equal(waitingBlock(null), '');
  const long = waitingBlock('x'.repeat(500));
  assert.ok(long.length < 260, 'an unbounded sentence would push the card off the screen');
});

check('an unclosed block still reads, because half a sentence beats none', () => {
  assert.equal(waitingOn({ notes: `${WAITING_OPEN}\nwaiting on review` }), 'waiting on review');
});

/* ------------------------------------------------------------------ the brief */

check('the brief names the P0, its owner, and what it may not do', () => {
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(text, /zz-p0/);
  assert.match(text, /adam@example\.com/, 'the brief does not say who it is answerable to');
  assert.match(text, /may not endorse/i, 'nothing stops it agreeing to its own work');
  assert.match(text, /priority or the owner/i, 'nothing stops it promoting its own P0');
  assert.match(text, /--parent zz-p0/, 'a child filed anywhere else is a bead nothing will work');
});

check('with no children it is told to plan; with children it is told to take stock', () => {
  const fresh = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.match(fresh, /no children yet/);
  const kids = [
    { id: 'zz-p0.1', title: 'one', status: 'open', priority: 1 },
    { id: 'zz-p0.2', title: 'two', status: 'closed', priority: 1 },
  ];
  const going = epicAdvocatePrompt('beadcause', p0(), kids, null, 'Adam');
  assert.match(going, /1 of 2 children are still open/);
  assert.match(going, /zz-p0\.1/);
  assert.ok(!going.includes('zz-p0.2'), 'a closed child is listed as work still to do');
});

check('a long child list is cut rather than shipped whole', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `zz-p0.${i}`, title: 't', status: 'open', priority: 2 }));
  const text = epicAdvocatePrompt('beadcause', p0(), many, null, 'Adam');
  assert.match(text, /…and 20 more\./);
});

check('and it always says where to write down what it concluded', () => {
  // It is re-entrant. Anything it keeps only in the conversation is gone when the window
  // closes, and the next one starts from the bead.
  const text = epicAdvocatePrompt('beadcause', p0(), [], null, 'Adam');
  assert.ok(text.includes(WAITING_OPEN) && text.includes(WAITING_CLOSE));
  assert.match(text, /re-entrant/);
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
