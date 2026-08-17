#!/usr/bin/env node
//
// What each agent is *given*, classified — and every way that classification can rot.
//
//   npm test
//   node test/grants.mjs
//
// lib/foundation.js says what each agent is allowed to do. Until lib/grants.js there was
// nothing anywhere saying what any of it **means** — whether `Bash(bd label add:*)` is a
// read of the tracker or a write to it, whether `Bash(npm run:*)` is a build or an
// arbitrary shell. The judgement lived in prose in the comments beside each array, which
// is the right place to argue it and the wrong place to check it: prose does not fail
// when somebody adds a line.
//
// So lib/grants.js is a second opinion that can *disagree* with a foundation, and this
// suite is what makes the disagreement cost something. Two halves, and the second is the
// one worth reading:
//
// 1. **The live rosters agree with it.** `grantProblems(AGENTS, baseline)` is empty. That
//    is the assertion that goes red when somebody widens an allowlist, and it goes red in
//    `npm test` rather than in an opt-in suite because a guard that runs only when
//    somebody remembers to run it is a guard against nothing — the same argument
//    lib/checkaudit.js makes for the browser checks.
//
// 2. **Each rule is proved to bite, against a made-up roster.** A guard nobody has ever
//    seen fail is a guard nobody knows the shape of, and "it returned an empty array" is
//    equally true of a function that always returns an empty array. `grantProblems` takes
//    the roster and the baseline reader as arguments precisely so this half can exist,
//    and every check below is a two-word diff somebody could plausibly make: one more
//    pattern in an array, one more agent in a `granted` list, a `writes: false` agent
//    acquiring a tracker verb.
//
// The deny-by-default direction is the whole design and it shows up in both halves. An
// *unclassified* grant is a failure rather than a pass, and an unrecognised tool call is a
// write rather than a read — so a capability added to `claude`, or a verb added to `bd`,
// is forbidden from the moment it exists until somebody allows it deliberately. The
// alternative default, everything-is-fine-until-named, is only ever as good as the
// imagination of whoever last thought about it.
//
// The live half of the same module — `isWriteCall` over the tool calls a real briefed
// agent made — is `evals/`, which costs real model tokens and is opt-in. This file is the
// free half, and it is the one that keeps holding while nobody is looking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const { GRANTS, WRITES_FALSE_EXCEPTIONS, grantProblems, grantCommand, classifyCommand, isWriteCall, writeCalls } =
  await import(path.join(ROOT, 'lib', 'grants.js'));
const foundation = await import(path.join(ROOT, 'lib', 'foundation.js'));
const { discover, TAGS } = await import(path.join(ROOT, 'evals', 'run.mjs'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/** A minimal roster: `grantProblems` only ever reads `allowedTools` and `writes`. */
const roster = (agents) => [Object.keys(agents), (a) => agents[a]];

/**
 * The problems a *synthetic* roster can meaningfully raise.
 *
 * `grantProblems` has a second half that sweeps the other way — an entry in lib/grants.js
 * naming a capability nobody holds is stale — and that half is a statement about the
 * **whole** roster. Run against a two-agent fixture it says every one of the other forty
 * grants is stale, which is true of the fixture and says nothing about the code. So the
 * fixtures below assert on the forward half only; the stale half has its own check, run
 * the only way it means anything.
 */
const forward = (problems) => problems.filter((p) => !/the entry is stale/.test(p));

console.log('granted capabilities, classified\n');

/* ------------------------------------------------------- the rosters that ship */

check('every grant in every shipped foundation is classified, and no write has spread', () => {
  const problems = grantProblems(foundation.AGENTS, foundation.baseline);
  assert.deepEqual(
    problems,
    [],
    `${problems.length} grant(s) disagree with lib/grants.js:\n` + problems.map((p) => `    · ${p}`).join('\n')
  );
});

check('and the roster it was checked against is the real one, not an empty list', () => {
  assert.ok(foundation.AGENTS.length >= 5, `only ${foundation.AGENTS.length} agents — the check above would pass over nothing`);
  const granted = new Set(foundation.AGENTS.flatMap((a) => foundation.baseline(a).allowedTools || []));
  assert.ok(granted.size >= 20, `only ${granted.size} distinct grants across the roster`);
});

/* --------------------------------------------------- and now: does it ever bite */

check('an unclassified grant is a failure, not a pass', () => {
  const [agents, of] = roster({ nobody: { writes: false, allowedTools: ['Bash(bd nuke:*)'] } });
  const problems = grantProblems(agents, of);
  assert.ok(
    problems.some((p) => /bd nuke/.test(p) && /does not classify/.test(p)),
    `expected the unclassified grant to be named; got:\n${problems.join('\n') || '(nothing at all)'}`
  );
});

check('a write spreading to an agent lib/grants.js does not name is a failure', () => {
  // `Bash(git push:*)` is classified, and granted to the merge queue alone. This is the
  // quiet change the `granted` list exists for: not a new capability, an existing one
  // moved one array to the left, in a diff that reads as tidying.
  const [agents, of] = roster({
    'merge-advocate': { writes: true, allowedTools: ['Bash(git push:*)'] },
    advocate: { writes: true, allowedTools: ['Bash(git push:*)'] },
  });
  const problems = grantProblems(agents, of);
  assert.ok(
    problems.some((p) => /^advocate grants Bash\(git push:\*\)/.test(p) && /widening a write is a decision/.test(p)),
    `expected the spread to be named; got:\n${problems.join('\n') || '(nothing at all)'}`
  );
  assert.ok(!problems.some((p) => /^merge-advocate/.test(p)), 'the agent that may hold it must not be flagged');
});

check('a writes:false agent holding a tracker write is a failure unless the exception says why', () => {
  const [agents, of] = roster({ 'epic-advocate': { writes: false, allowedTools: ['Bash(bd create:*)'] } });
  const problems = grantProblems(agents, of);
  assert.ok(
    problems.some((p) => /writes: false/.test(p) && /bd create/.test(p)),
    `expected the phone's read-only pill to be defended; got:\n${problems.join('\n') || '(nothing at all)'}`
  );
});

check('and the one exception that does exist is honoured rather than special-cased away', () => {
  const [agents, of] = roster({ advocate: { writes: false, allowedTools: ['Bash(bd label add:*)'] } });
  assert.deepEqual(forward(grantProblems(agents, of)), []);
  assert.ok(
    (WRITES_FALSE_EXCEPTIONS.advocate?.['Bash(bd label add:*)'] || '').length > 20,
    'the exception exists with no argument beside it, which is the thing it was supposed to prevent'
  );
});

check('an unbounded allowlist on an agent claiming writes:false is a failure', () => {
  // `allowedTools: null` is every capability there is. The worker holds it legitimately —
  // a person is in the loop approving each call — and a *read-only* agent acquiring it is
  // the single widest change anybody could make here, and the one that looks smallest.
  const [agents, of] = roster({ console: { writes: false, allowedTools: null } });
  const problems = grantProblems(agents, of);
  assert.ok(
    problems.some((p) => /allowedTools is unset/.test(p)),
    `expected an unbounded read-only agent to be named; got:\n${problems.join('\n') || '(nothing at all)'}`
  );
  assert.deepEqual(forward(grantProblems(...roster({ worker: { writes: true, allowedTools: null } }))), []);
});

check('a stale entry — classified here, granted nowhere — is a failure too', () => {
  const [agents, of] = roster({ console: { writes: false, allowedTools: ['Read'] } });
  const problems = grantProblems(agents, of);
  assert.ok(
    problems.some((p) => /the entry is stale/.test(p)),
    'a classification naming a capability nobody holds reads as a decision and is really a line nobody deleted'
  );
});

check('a write classified with no reason worth reading is a failure', () => {
  // Not reachable through GRANTS itself — this is the shape of the entry somebody adds in
  // a hurry, and the assertion is that `kind: 'write'` alone buys nothing.
  const thin = Object.entries(GRANTS).filter(([, e]) => e.kind === 'write' && (!e.why || e.why.length < 20));
  assert.deepEqual(thin.map(([k]) => k), [], 'a write entry that says only "this is a write" adds nothing a reader could not see');
});

/* ------------------------------------------- what a tool call is, at eval time */

check('the argument scope is stripped before a pattern is classified', () => {
  assert.equal(grantCommand('Bash(bd show:*)'), 'bd show');
  assert.equal(grantCommand('Bash(node scripts/shot.mjs:*)'), 'node scripts/shot.mjs');
  assert.equal(grantCommand('Read'), null);
});

check('a longer read verb wins over a shorter one that is its prefix', () => {
  // `bd comment` is a string prefix of `bd comments` and the two are opposite things: one
  // is the answer written onto a bead, the other is the list of answers already there. A
  // string prefix match would classify the write as the read, which fails open.
  assert.equal(classifyCommand('bd comments bc-x'), 'read');
  assert.equal(classifyCommand('bd comment bc-x "hello"'), 'write');
  assert.equal(classifyCommand('bd label list'), 'read');
  assert.equal(classifyCommand('bd label add bc-x human'), 'write');
});

check('an unrecognised command is a write, and so is every compound containing one', () => {
  assert.equal(classifyCommand('ls -la'), 'write');
  assert.equal(classifyCommand('bd show bc-x && rm -rf /tmp/x'), 'write');
  assert.equal(classifyCommand('bd show bc-x | grep title'), 'write');
  assert.equal(classifyCommand('bd show bc-x; bd list'), 'read');
  assert.equal(classifyCommand(''), 'write');
});

check('leading environment assignments and exec do not hide the verb', () => {
  assert.equal(classifyCommand('BEADS_DIR=/tmp bd show bc-x'), 'read');
  assert.equal(classifyCommand('exec bd list'), 'read');
  assert.equal(classifyCommand('FOO=1 rm -rf /'), 'write');
});

check('memory is its own class — neither a read nor folded into one', () => {
  assert.equal(classifyCommand('beadcause-memory recall'), 'memory');
  assert.equal(classifyCommand('beadcause-memory remember k v'), 'memory');
  assert.equal(isWriteCall({ name: 'Bash', input: { command: 'beadcause-memory remember k v' } }), null);
});

check('a tool name nothing knows about is a write — this is the deny-by-default', () => {
  // The assertion the whole eval directory rests on. A capability added to the CLI is
  // forbidden in every read-only eval on the day it ships, not on the day somebody
  // remembers to list it.
  assert.ok(isWriteCall({ name: 'ComputerUse', input: {} }));
  assert.ok(isWriteCall({ name: 'NotebookEdit', input: {} }));
  assert.ok(isWriteCall({ name: '', input: {} }));
  assert.equal(isWriteCall({ name: 'Read', input: { file_path: '/x' } }), null);
  assert.equal(isWriteCall({ name: 'Grep', input: {} }), null);
});

check('writeCalls reports every offender in order, with a reason a reader can act on', () => {
  const calls = [
    { name: 'Read', input: { file_path: '/x' } },
    { name: 'Bash', input: { command: 'bd show bc-x' } },
    { name: 'Bash', input: { command: 'bd close bc-x' } },
    { name: 'Edit', input: {} },
  ];
  const writes = writeCalls(calls);
  assert.equal(writes.length, 2);
  assert.match(writes[0].why, /bd close bc-x/);
  assert.match(writes[1].why, /not on the read-only tool list/);
});

/* ------------------------------------------------- the eval half is discoverable */

check('the evals directory exists and is outside npm test', () => {
  const found = discover();
  assert.ok(found.length, 'evals/ discovered nothing');
  assert.ok(TAGS.includes('free') && TAGS.includes('fast') && TAGS.includes('slow'));
  // The gate must never spend money. scripts/test.mjs discovers `test/*.mjs` only, so
  // this is really an assertion about the two directories staying apart — the failure it
  // guards against is somebody moving an eval into test/ for the convenience of it.
  const inTest = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /eval/i.test(f));
  assert.deepEqual(inTest, [], `${inTest.join(', ')} is in test/, which runs in the gate and must not cost money`);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
