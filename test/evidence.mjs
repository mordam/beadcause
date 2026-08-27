#!/usr/bin/env node
//
// Nothing persists state here without saying how long it is kept — `lib/evidence.js`.
//
//   npm test
//   node test/evidence.mjs
//
// bc-4r10.7: a Type II report tests whether controls *operated throughout a period*, and
// the auditor answers that by sampling the period rather than looking at today. So an
// evidence source that is overwritten, rotated without retention, or reset between runs
// does not make the report untidy — it converts a working control into a testing
// exception, because the population the sample was meant to be drawn from is not there.
//
// The register in lib/evidence.js is the statement of what is kept and for how long.
// This is the half that keeps it true, and it does three separable jobs:
//
//   1. The register is well-formed, and — the part that matters — the rules that make it
//      cost something are proved against deliberately broken entries rather than only
//      run against the real one. A frozen register that passes tells you nothing about
//      whether the rule would ever fail; `entryProblems` exists to be pointed at junk.
//   2. The inventory matches the repo. Every module under lib/ and bin/ that touches
//      CONFIG_DIR or a refs/beadcause ref is claimed by an evidence class or carries a
//      sentence saying why what it writes is not evidence — and every claim still names
//      a file that exists and still writes something.
//   3. `verifyRef` demonstrates the chain rather than asserting it, against a real repo
//      with a real ref. Including the case that is the whole point: a rewritten history
//      is *intact*, and only an anchor recorded beforehand can tell you it is not the
//      history that was there before.
//
// The scanner is the part with a wrong answer available to it rather than noise: every
// file in this repo argues in prose that names the identifiers around it, so a scan that
// does not blank comments finds CONFIG_DIR in the paragraph explaining that a module
// deliberately does not touch one — and half a dozen modules mention CLAUDE_CONFIG_DIR
// while touching nothing of ours. Both are covered below.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  INTEGRITY,
  NOT_EVIDENCE,
  REGISTER,
  RETENTION_FLOOR_MONTHS,
  blankComments,
  claimed,
  coverageProblems,
  entryProblems,
  persistsState,
  registerProblems,
  stateModules,
  verifyRef,
} from '../lib/evidence.js';
import { ARCHIVE_REF } from '../lib/agentarchive.js';
import { KEEP as DEPLOY_KEEP } from '../lib/deploy.js';
import { KEEP_DAYS as RELEASE_KEEP_DAYS } from '../lib/release.js';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-evidence-'));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

console.log('evidence register\n');

/* ------------------------------------------------------------ the register */

await check('the register is well-formed', () => {
  const problems = registerProblems();
  assert.deepEqual(problems, [], `${problems.length} problem(s):\n${problems.join('\n')}`);
});

await check('the register is not empty, and the parse is of the real thing', () => {
  assert.ok(REGISTER.length >= 8, `only ${REGISTER.length} evidence classes — that is not this system`);
  assert.ok(NOT_EVIDENCE.length >= 8, `only ${NOT_EVIDENCE.length} exemptions`);
  assert.ok(Object.isFrozen(REGISTER), 'REGISTER must be frozen — a register something can edit at runtime is not a statement');
});

// A good entry, cloned and broken one field at a time below. Deliberately the safest
// shape there is — chained, sampled, permanent, no gap — so every failure produced from
// it is produced by the one field the case changed.
const GOOD = Object.freeze({
  id: 'a-class',
  what: 'A record of something happening, kept because somebody will ask about it later.',
  where: ['refs/beadcause/example'],
  writers: ['lib/evidence.js'],
  serves: ['change management — the example criterion'],
  sampled: true,
  retention: 'permanent',
  disposal: 'None, because removing the middle of a chain breaks every sha after it.',
  alterableBy: 'anyone with write access to the checkout, through the compare-and-swap.',
  integrity: 'chained',
  gap: null,
});

const broken = (patch) => entryProblems({ ...GOOD, ...patch });

await check('the reference entry passes, or every case below proves nothing', () => {
  assert.deepEqual(entryProblems(GOOD), []);
});

await check('a sampled class resting on the common repo is refused', () => {
  // The rule the whole register turns on. `history` means lib/commonrepo.js commits
  // after each write — which answers "what did this say before", not "was this
  // altered": the snapshot is best-effort, the repo has no remote, and it is written
  // by the same process that writes the file. Fine for recovery, not for a sample.
  const problems = broken({ integrity: 'history' });
  assert.ok(
    problems.some((p) => /sampled by an auditor and not chained/.test(p)),
    `expected a refusal, got:\n${problems.join('\n') || '(nothing)'}`
  );
  // …and naming the bead that will fix it is the way past it, not a second rule.
  assert.deepEqual(
    broken({ integrity: 'history', gap: { bead: 'bc-j3d5', says: 'the ledger is not chained yet, and here is what that costs.' } }),
    []
  );
});

await check('a class kept as evidence with nothing behind it is refused', () => {
  const problems = broken({ integrity: 'none', sampled: false, retention: RETENTION_FLOOR_MONTHS });
  assert.ok(
    problems.some((p) => /nothing behind it/.test(p)),
    `expected a refusal, got:\n${problems.join('\n') || '(nothing)'}`
  );
});

await check('a retention shorter than the floor cannot be stated', () => {
  // The floor is the observation window plus the report's useful life. A number under
  // it is disk convenience with a retention rule written beside it.
  for (const retention of [0, 6, 12, 23, '12', 24.5, null]) {
    const problems = broken({ retention });
    assert.ok(
      problems.some((p) => /`retention` must be/.test(p)),
      `retention ${JSON.stringify(retention)} was accepted`
    );
  }
  assert.deepEqual(broken({ retention: RETENTION_FLOOR_MONTHS }), []);
});

await check('every field that has to be a sentence has to be a sentence', () => {
  for (const field of ['what', 'disposal', 'alterableBy']) {
    for (const value of ['', 'yes', 'n/a', undefined]) {
      assert.ok(
        broken({ [field]: value }).some((p) => p.includes(`\`${field}\``)),
        `${field}: ${JSON.stringify(value)} was accepted, and a one-word answer is what the register exists instead of`
      );
    }
  }
  for (const field of ['where', 'writers', 'serves']) {
    assert.ok(broken({ [field]: [] }).some((p) => p.includes(`\`${field}\``)), `${field}: an empty list was accepted`);
  }
  assert.ok(broken({ sampled: 'yes' }).some((p) => p.includes('`sampled`')), 'sampled must be a boolean, not a truthy string');
  assert.ok(broken({ integrity: 'append-only' }).some((p) => p.includes('`integrity`')), `integrity is closed: ${INTEGRITY.join(', ')}`);
});

await check('a gap has to name a bead and say what is missing', () => {
  assert.ok(broken({ integrity: 'history', gap: { bead: 'soon', says: 'we will get to this at some point next quarter.' } }).some((p) => /gap.bead/.test(p)));
  assert.ok(broken({ integrity: 'history', gap: { bead: 'bc-j3d5', says: 'todo' } }).some((p) => /gap.says/.test(p)));
});

await check('the agent run log is registered, and bc-eqn1.7 closed its gap', () => {
  // This assertion used to pin the *gap* — `integrity: 'none'`, owned by bc-eqn1.7 —
  // because the register going on saying the log was destroyed after it had stopped being
  // is the failure mode of every compliance document. bc-eqn1.7 landed, so it pins the
  // other direction now, and for the same reason: an entry that quietly slid back to
  // unchained would be a claim nobody is making on purpose.
  const logs = REGISTER.find((e) => e.id === 'agent-run-logs');
  assert.ok(logs, 'the agent run log is not registered at all');
  assert.equal(logs.integrity, 'chained');
  assert.equal(logs.gap, null);
  assert.ok(logs.writers.includes('lib/agentlog.js'));
  assert.ok(logs.writers.includes('lib/agentarchive.js'));
  assert.ok(logs.where.some((w) => w.includes(ARCHIVE_REF)), 'the chain is not named in `where`');
});

await check('deployment-record\'s disposal prose names the numbers deploy.js and release.js actually prune to', () => {
  // bc-khoe.17: the register used to say "Neither is pruned today", which was false in
  // both halves — deploy.js's prune() has always kept only the last KEEP records, and
  // release.js's prune() has always dropped a settled entry after KEEP_DAYS. Rather than
  // pin the prose (which the next drift would silently outdate), pin it to the constants
  // the code actually uses, so a KEEP or KEEP_DAYS change that nobody brings back here
  // fails loudly instead of leaving the register internally consistent and externally
  // false again.
  const dep = REGISTER.find((e) => e.id === 'deployment-record');
  assert.ok(dep, 'deployment-record is not registered at all');
  assert.ok(
    dep.disposal.includes(String(DEPLOY_KEEP)),
    `disposal does not name deploy.js's current KEEP (${DEPLOY_KEEP}) — it drifted:\n${dep.disposal}`
  );
  assert.ok(
    dep.disposal.includes(String(RELEASE_KEEP_DAYS)),
    `disposal does not name release.js's current KEEP_DAYS (${RELEASE_KEEP_DAYS}) — it drifted:\n${dep.disposal}`
  );
  assert.ok(!/neither is pruned/i.test(dep.disposal), 'the disposal text still claims nothing is pruned, which prune() contradicts');
});

/* ------------------------------------------------------------ the inventory */

await check('every module that persists state is claimed by the register or exempted', () => {
  const problems = coverageProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.length} problem(s):\n${problems.join('\n')}`);
});

await check('the scan finds the modules we know write state', () => {
  // A sanity floor under the check above: a scanner that matched nothing would report
  // no problems and read exactly like a clean repo.
  const found = new Set(stateModules(ROOT));
  for (const known of ['lib/agentlog.js', 'lib/sessionlog.js', 'lib/commonrepo.js', 'lib/release.js', 'lib/memory.js']) {
    assert.ok(found.has(known), `${known} writes state and the scan missed it`);
  }
  assert.ok(found.size >= 25, `only ${found.size} modules found — the scan is wrong, not the repo`);
});

await check('an unclaimed writer fails, and a stale claim fails', async () => {
  const root = path.join(tmp, 'fake-repo');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'newthing.js'), "import { CONFIG_DIR } from './config.js';\nconst P = path.join(CONFIG_DIR, 'newthing.json');\n");
  fs.writeFileSync(path.join(root, 'lib', 'quiet.js'), 'export const two = 1 + 1;\n');

  const unclaimed = coverageProblems(root, new Map());
  assert.ok(
    unclaimed.some((p) => p.startsWith('lib/newthing.js persists state')),
    `a new writer went unnoticed:\n${unclaimed.join('\n') || '(nothing)'}`
  );

  const gone = coverageProblems(root, new Map([['lib/vanished.js', 'REGISTER[x]'], ['lib/newthing.js', 'REGISTER[x]']]));
  assert.ok(gone.some((p) => /names lib\/vanished.js, which does not exist/.test(p)), 'a claim on a deleted file passed');

  const stale = coverageProblems(root, new Map([['lib/quiet.js', 'NOT_EVIDENCE'], ['lib/newthing.js', 'REGISTER[x]']]));
  assert.ok(stale.some((p) => /lib\/quiet.js, which no longer touches/.test(p)), 'an exemption for a module that writes nothing passed');
});

/* -------------------------------------------------------------- the scanner */

await check('comments are blanked, strings are not, and offsets survive', () => {
  const src = [
    '// CONFIG_DIR is named here and nowhere else in this file.',
    '/* refs/beadcause/foundations, in a block comment. */',
    "const url = 'https://example.invalid/x'; // trailing",
    'const ref = `refs/beadcause/${kind}/${`${a}//${b}`}`;',
    'const q = "a // b";',
    // The one that fails quietly: without escape handling in code, the scanner lands on
    // the closing `\/` `/` of the regex, calls it a line comment, and blanks the rest of
    // the line — including a CONFIG_DIR that was sitting on it.
    "const re = /https?:\\/\\//; const p = path.join(CONFIG_DIR, 'x');",
  ].join('\n');
  const out = blankComments(src);
  assert.equal(out.length, src.length, 'blanking must preserve length so a hit keeps its line');
  assert.equal(out.split('\n').length, src.split('\n').length, 'newlines must survive');
  assert.ok(!/CONFIG_DIR/.test(out.split('\n')[0]), 'a line comment was not blanked');
  assert.ok(!/foundations/.test(out.split('\n')[1]), 'a block comment was not blanked');
  assert.ok(out.includes("'https://example.invalid/x'"), 'the // inside a string was taken for a comment');
  assert.ok(out.includes('`refs/beadcause/${kind}'), 'a nested template literal broke the scanner');
  assert.ok(out.includes('"a // b"'), 'the // inside a double-quoted string was taken for a comment');
  assert.ok(out.includes('CONFIG_DIR'), 'an escaped / in a regex literal swallowed the rest of its line');
  assert.equal(persistsState(src).configDir, true, 'the same line, through the real entry point');
});

await check('a module that only mentions CONFIG_DIR in prose does not count', () => {
  // The wrong answer that was actually available here: seven modules explain what
  // CLAUDE_CONFIG_DIR is for while writing nothing of ours, and several more mention
  // CONFIG_DIR in the paragraph saying they deliberately stay out of it.
  assert.equal(persistsState('// we never touch CONFIG_DIR from here.\nexport const x = 1;\n').configDir, false);
  assert.equal(persistsState('/**\n * refs/beadcause/sessions is written elsewhere.\n */\nexport const x = 1;\n').ref, false);
  assert.equal(persistsState("const d = process.env.CLAUDE_CONFIG_DIR || '';\n").configDir, false);
  assert.equal(persistsState("if (process.env.BEADCAUSE_CONFIG_DIR) reset();\n").configDir, false);
  assert.equal(persistsState("import { CONFIG_DIR } from './config.js';\n").configDir, true);
  assert.equal(persistsState("const R = 'refs/beadcause/thing';\n").ref, true);
});

await check('every claimed file is named once, by one list', () => {
  const claims = claimed();
  const writers = REGISTER.flatMap((e) => e.writers);
  const exempt = NOT_EVIDENCE.map((x) => x.file);
  const both = writers.filter((w) => exempt.includes(w));
  assert.deepEqual(both, [], `claimed as a writer and exempted at once: ${both.join(', ')}`);
  assert.equal(claims.size, new Set([...writers, ...exempt]).size, 'a file is claimed twice');
});

/* --------------------------------------------------------------- the chain */

const repo = path.join(tmp, 'chain');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function writeRef(ref, messages) {
  // The same four plumbing calls lib/gitref.js makes: no index, no checkout, no working
  // tree — so this is the shape being verified rather than a stand-in for it.
  let parent = null;
  const shas = [];
  for (const message of messages) {
    const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: message, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['-C', repo, 'mktree'], { input: `100644 blob ${blob}\trecord\n`, encoding: 'utf8' }).trim();
    const args = ['commit-tree', tree, '-m', message];
    if (parent) args.push('-p', parent);
    parent = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
    }).trim();
    shas.push(parent);
  }
  git('update-ref', ref, parent);
  return shas;
}

fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['-C', repo, 'init', '-q', '--initial-branch=main']);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'beadcause@localhost']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'beadcause']);

await check('a chained ref reports itself linear, intact and as long as it is', async () => {
  const shas = writeRef('refs/beadcause/example', ['one', 'two', 'three']);
  const v = await verifyRef(repo, 'refs/beadcause/example');
  assert.equal(v.length, 3);
  assert.equal(v.linear, true);
  assert.equal(v.intact, true);
  assert.equal(v.head, shas[2]);
  assert.equal(v.anchored, null, 'with no anchor passed the answer is "not asked", never "yes"');
});

await check('an anchor recorded earlier is what catches a rewrite', async () => {
  // The case the whole `chained` claim rests on, and the one that is easy to talk
  // yourself out of needing. A forged history is *perfectly* intact — every parent
  // resolves, one root, no merges — so intactness alone says only that what you are
  // holding is a chain, not that it is the chain that was there in January.
  const original = writeRef('refs/beadcause/rewritten', ['one', 'two', 'three']);
  const anchor = original[1];
  const before = await verifyRef(repo, 'refs/beadcause/rewritten', { anchor });
  assert.equal(before.anchored, true);

  writeRef('refs/beadcause/rewritten', ['one', 'two but different', 'three']);
  const after = await verifyRef(repo, 'refs/beadcause/rewritten', { anchor });
  assert.equal(after.intact, true, 'a rewritten history is intact, which is exactly the problem');
  assert.equal(after.linear, true);
  assert.equal(after.anchored, false, 'the anchor is the only thing that can see the rewrite — see bc-hzu4');
});

await check('a merge into an evidence ref is reported, and a truncated chain is not intact', async () => {
  const a = writeRef('refs/beadcause/branch-a', ['a1', 'a2']);
  const b = writeRef('refs/beadcause/branch-b', ['b1']);
  const tree = git('rev-parse', `${a[1]}^{tree}`);
  const merged = execFileSync('git', ['-C', repo, 'commit-tree', tree, '-m', 'merge', '-p', a[1], '-p', b[0]], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
  }).trim();
  git('update-ref', 'refs/beadcause/merged', merged);

  const v = await verifyRef(repo, 'refs/beadcause/merged');
  assert.equal(v.linear, false, 'two histories joined and neither is the record any more');
  assert.equal(v.intact, false, 'two roots is not one chain');
});

await check('a ref that is not there says so rather than passing', async () => {
  const v = await verifyRef(repo, 'refs/beadcause/never-written');
  assert.equal(v.head, null);
  assert.equal(v.intact, false);
  assert.equal(v.why, 'no such ref');
});

await cleanupTmp(tmp);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
