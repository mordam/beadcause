#!/usr/bin/env node
//
// Enforcement is scoped by what was elected — `lib/election.js`.
//
//   npm test                       (runs it alongside the other suites)
//   node test/election.mjs         (on its own)
//
// bc-3muu.6. beadcause records unconditionally and enforces only inside a scope, and the
// scope is a declared boundary plus a set of elected criteria. The claim being defended
// here is a negative one — *an install that elected nothing sees nothing* — and a
// negative claim is the kind that decays silently, because nothing about a green suite
// tells you the code would ever have said otherwise.
//
// So this suite is in three parts, and the middle one is the one that had to be argued
// for rather than written:
//
//  1. **The empty election answers nothing to every question a gate can ask**, and it
//     answers it identically before anything has happened and after a withdraw. Those
//     are two different code paths — an absent ref and a state whose lists are empty —
//     and a promise that only holds on a virgin machine is not the promise.
//  2. **There is no switch anywhere.** A default election would satisfy part 1 on the day
//     it was written and stop satisfying it the moment somebody added a convenient
//     `enabled` key, so the source itself is read: `lib/election.js` may not touch
//     `process.env` and may not import the config. That is the difference between a
//     scoping rule and a switch, and it is the whole reason the bead exists — a switch
//     is the thing that can be quietly flipped, and a scope has nothing to flip.
//  3. **Every change is a commit, including the one that stops enforcement.** Withdrawing
//     returns a gate to the fresh install *and leaves the record standing*, so a quarter
//     nobody was in scope for reads as a gap somebody recorded rather than as a quiet
//     quarter. Both halves are asserted together, because either one alone is a design
//     somebody could have shipped by accident.
//
// Everything runs against a throwaway `BEADCAUSE_CONFIG_DIR`. Nothing here touches the
// real ~/.config/beadcause, and nothing pushes anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-election-'));
process.env.BEADCAUSE_CONFIG_DIR = tmp;

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const {
  ACTIONS,
  ELECTION_REF,
  FRAMEWORKS,
  NOTHING,
  boundaryProblems,
  criterionProblems,
  current,
  declare,
  elect,
  elected,
  enforcing,
  history,
  inScope,
  revoke,
  scope,
  withdraw,
} = await import('../lib/election.js');
const { blankComments, claimed, verifyRef } = await import('../lib/evidence.js');
const { ensureRepo } = await import('../lib/commonrepo.js');

const git = (...args) => execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' }).trim();
/** Commits on the ref, and 0 before it exists — git says so on stderr, which is not news. */
const refCommits = () => {
  try {
    return Number(
      execFileSync('git', ['-C', tmp, 'rev-list', '--count', ELECTION_REF], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    );
  } catch {
    return 0;
  }
};

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

const BOUNDARY = {
  name: 'Climative',
  description: 'The beadcause daemon, the repos it works in, and the Macs it runs on.',
};

/** Every question a gate can ask, answered. Used to compare two "nothing" states. */
const answers = (election, ids) => ({
  boundary: election.boundary,
  criteria: [...election.criteria],
  enforcing: enforcing(election),
  elected: ids.map((id) => elected(election, id)),
  scope: [...scope(election)],
  inScope: ids.map((id) => inScope(election, id)),
});

const PROBES = ['SOC2.CC8.1', 'ISO27001.A.8.32', 'ISO42001.A.6.2.2', 'SOC2.CC1.1'];

console.log('election — what is in scope, and what an install that elected nothing sees\n');

/* ------------------------------------------ 1. an install that elected nothing */

await check('a fresh install has elected nothing, and every predicate agrees', async () => {
  const e = await current();
  assert.equal(e.boundary, null, 'no boundary is declared');
  assert.deepEqual([...e.criteria], [], 'nothing is elected');
  assert.deepEqual([...e.transitions], [], 'nothing has transitioned');
  assert.equal(enforcing(e), false);
  assert.deepEqual([...scope(e)], []);
  for (const id of PROBES) {
    assert.equal(elected(e, id), false, `${id} is not elected`);
    assert.equal(inScope(e, id), null, `${id} is out of scope, and the answer is null rather than a verdict`);
  }
});

await check('`null` and not `false` is what a gate gets, so it can tell "no opinion" from "no"', async () => {
  const e = await current();
  // The distinction is the whole of "sees nothing": a gate handed `false` has been told
  // something and will, sooner or later, say so on a screen. A gate handed `null` has
  // been told nothing and returns early, which is the install beadcause has always been.
  assert.equal(inScope(e, 'SOC2.CC8.1'), null);
  assert.notEqual(inScope(e, 'SOC2.CC8.1'), false);
});

await check('the empty election is empty, and is what an absent ref reads back as', async () => {
  assert.equal(refCommits(), 0, 'nothing has been written to the ref');
  assert.equal(NOTHING.boundary, null);
  assert.deepEqual([...NOTHING.criteria], []);
  assert.deepEqual(answers(await current(), PROBES), answers(NOTHING, PROBES));
});

await check('an unreadable election is nothing rather than something', async () => {
  // Deliberately corrupt the stored state on a scratch ref, then read it through the same
  // parse. The safe direction is not obvious enough to leave to chance: a state nobody
  // can read must enforce *nothing*, never the last thing anyone remembers it saying.
  const cwd = await ensureRepo();
  assert.equal(cwd, tmp, 'the scratch config dir is what the module writes to');
  const blob = execFileSync('git', ['-C', tmp, 'hash-object', '-w', '--stdin'], {
    encoding: 'utf8',
    input: '{ this is not json',
  }).trim();
  const tree = execFileSync('git', ['-C', tmp, 'mktree'], {
    encoding: 'utf8',
    input: `100644 blob ${blob}\telection.json\n`,
  }).trim();
  const commit = git('commit-tree', tree, '-m', 'corrupt');
  git('update-ref', ELECTION_REF, commit);

  const e = await current();
  assert.deepEqual(answers(e, PROBES), answers(NOTHING, PROBES), 'junk reads as nothing elected');

  git('update-ref', '-d', ELECTION_REF);
  assert.equal(refCommits(), 0, 'and the scratch commit is gone again');
});

/* ------------------------------------------------- 2. there is no switch anywhere */

await check('lib/election.js reads no environment variable', () => {
  const src = blankComments(fs.readFileSync(path.join(ROOT, 'lib/election.js'), 'utf8'));
  const hits = src
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /process\.env/.test(line));
  assert.deepEqual(
    hits.map(([n, l]) => `lib/election.js:${n}: ${l.trim()}`),
    [],
    'an environment variable that changes what is in scope is a switch, and a switch can be flipped for one run'
  );
});

await check('lib/election.js does not read the config', () => {
  const src = blankComments(fs.readFileSync(path.join(ROOT, 'lib/election.js'), 'utf8'));
  assert.equal(/from\s+'\.\/config\.js'/.test(src), false, 'no import of lib/config.js');
  assert.equal(/CONFIG_DIR/.test(src), false, 'nothing here resolves a config path of its own');
  // lib/owner.js is imported and does read config.json — for the owner's *name*, which is
  // attribution on a transition and not an input to any predicate. The check below is the
  // one that makes that distinction hold rather than merely stating it.
});

await check('the predicates are functions of the election and of nothing else', () => {
  const e = { boundary: BOUNDARY, criteria: ['SOC2.CC8.1'], transitions: [] };
  const before = answers(e, PROBES);
  const junk = {
    BEADCAUSE_COMPLIANCE: '1',
    BEADCAUSE_ENFORCE: 'all',
    BEADCAUSE_ELECTION: 'SOC2.CC1.1',
  };
  for (const [k, v] of Object.entries(junk)) process.env[k] = v;
  try {
    assert.deepEqual(answers(e, PROBES), before, 'no environment variable moves the answer');
  } finally {
    for (const k of Object.keys(junk)) delete process.env[k];
  }
});

await check('the shipped config has no key that could turn any of this on', () => {
  // Read as text rather than called: `defaults()` is not exported, and it shells out to
  // tailscale, git and ~/beads — see the note in lib/config.js. The claim here is about
  // what is *written* in the shipped file anyway, which is what reading it asserts.
  const src = blankComments(fs.readFileSync(path.join(ROOT, 'lib/config.js'), 'utf8'));
  const KEY = /^[ \t]*(election|elected|boundary|criteria|criterion|compliance|enforce[A-Za-z]*)\s*:/gm;
  const keys = [...src.matchAll(KEY)].map((m) => m[1]);
  assert.deepEqual(keys, [], `config.json would carry ${keys.join(', ')} — a key is a switch, and a switch can be set`);
});

/* ---------------------------------------------------- 3. electing, as transitions */

await check('nothing can be elected before a boundary is declared', async () => {
  await assert.rejects(() => elect('SOC2.CC8.1', { justification: 'trying it on' }), /boundary/);
  assert.equal(refCommits(), 0, 'and the refusal wrote nothing');
});

await check('a criterion id has to carry its framework, and junk is refused', async () => {
  assert.deepEqual(criterionProblems('SOC2.CC8.1'), []);
  assert.deepEqual(criterionProblems('ISO27001.A.8.32'), []);
  assert.equal(criterionProblems('CC8.1').length, 1, 'a bare local id names two different controls');
  assert.equal(criterionProblems('A.5.2').length, 1, 'ISO27001.A.5.2 and ISO42001.A.5.2 are not the same control');
  assert.equal(criterionProblems('').length, 1);
  assert.equal(criterionProblems('SOC2.').length, 1);
  assert.equal(criterionProblems('NIST.AC-1').length, 1, 'a framework the corpus does not mint');
  assert.deepEqual([...FRAMEWORKS].sort(), ['ISO27001', 'ISO42001', 'SOC2']);
});

await check('a boundary has to say who it is and what is inside it', () => {
  assert.deepEqual(boundaryProblems(BOUNDARY), []);
  assert.equal(boundaryProblems({ name: 'Climative' }).length, 1, 'a name with no scope statement');
  assert.equal(boundaryProblems({ description: BOUNDARY.description }).length, 1, 'a scope statement with no one in it');
  assert.equal(boundaryProblems({ name: 'x', description: 'too short' }).length, 1);
});

await check('declaring the boundary is a commit, and only that', async () => {
  const { election, commit } = await declare(BOUNDARY, { bead: 'bc-3muu.6', justification: 'the first election' });
  assert.ok(commit, 'a commit sha came back');
  assert.equal(refCommits(), 1);
  assert.equal(election.boundary.name, 'Climative');
  assert.deepEqual([...election.criteria], [], 'declaring a boundary elects nothing into it');
  assert.equal(enforcing(election), false, 'and a boundary with nothing elected fires no gate');
  assert.equal(inScope(election, 'SOC2.CC8.1'), null);
});

await check('electing is a commit, and the criterion is then in scope', async () => {
  const { election, commit } = await elect(['SOC2.CC8.1', 'ISO27001.A.8.32'], {
    bead: 'bc-3muu.6',
    justification: 'change management is the criterion the gate already enforces',
  });
  assert.ok(commit);
  assert.equal(refCommits(), 2);
  assert.equal(enforcing(election), true);
  assert.deepEqual([...scope(election)], ['ISO27001.A.8.32', 'SOC2.CC8.1']);

  const v = inScope(election, 'SOC2.CC8.1');
  assert.ok(v, 'the gate gets a verdict');
  assert.equal(v.criterion, 'SOC2.CC8.1');
  assert.equal(v.boundary.name, 'Climative');
  assert.ok(v.since, 'and when it came into scope — a refusal owes "since when"');
});

await check('what was not elected stays out of scope, next to what was', async () => {
  const e = await current();
  assert.equal(elected(e, 'SOC2.CC8.1'), true);
  assert.equal(elected(e, 'SOC2.CC1.1'), false, 'the same framework, and not elected');
  assert.equal(inScope(e, 'SOC2.CC1.1'), null);
  assert.equal(inScope(e, 'ISO42001.A.6.2.2'), null, 'a framework nothing has been elected from');
  // The local ids collide across frameworks and the scope must not.
  assert.equal(elected(e, 'ISO27001.A.8.32'), true);
  assert.equal(elected(e, 'ISO42001.A.8.32'), false);
  assert.equal(elected(e, 'A.8.32'), false, 'a bare local id is not an election');
});

await check('electing what is already elected is not a transition', async () => {
  const before = refCommits();
  const { commit, election } = await elect('SOC2.CC8.1', { justification: 'again' });
  assert.equal(commit, null, 'a no-op is a line an auditor would have to read and rule out');
  assert.equal(refCommits(), before);
  assert.deepEqual([...election.criteria], ['ISO27001.A.8.32', 'SOC2.CC8.1']);
});

await check('revoking narrows the scope and leaves the rest of it alone', async () => {
  const { election, commit } = await revoke('ISO27001.A.8.32', { justification: 'covered by the SOC 2 criterion' });
  assert.ok(commit);
  assert.deepEqual([...election.criteria], ['SOC2.CC8.1']);
  assert.equal(enforcing(election), true, 'still in scope for what is left');
  assert.equal(inScope(election, 'ISO27001.A.8.32'), null);
  assert.ok(inScope(election, 'SOC2.CC8.1'));
});

await check('two writers cannot silently lose each other', async () => {
  const settled = await Promise.allSettled([
    elect('SOC2.CC7.2', { justification: 'monitoring' }),
    elect('SOC2.CC6.1', { justification: 'logical access' }),
  ]);
  const e = await current();
  for (const [i, r] of settled.entries()) {
    if (r.status !== 'fulfilled') continue;
    const id = ['SOC2.CC7.2', 'SOC2.CC6.1'][i];
    assert.equal(elected(e, id), true, `${id} was reported elected and is elected`);
  }
  assert.ok(
    settled.some((r) => r.status === 'fulfilled'),
    'at least one of the two landed'
  );
});

/* ------------------------------------------- withdrawing, and what it does not undo */

await check('withdrawing without a justification is refused', async () => {
  await assert.rejects(() => withdraw({ justification: 'no' }), /justification/);
  await assert.rejects(() => withdraw({}), /justification/);
});

await check('withdrawing returns a gate to exactly the fresh install', async () => {
  const before = await current();
  assert.equal(enforcing(before), true, 'something was in scope first, or this proves nothing');

  const { election } = await withdraw({
    bead: 'bc-3muu.6',
    justification: 'the attestation was not pursued this year; the scope statement is withdrawn until it is',
  });
  assert.deepEqual(answers(election, PROBES), answers(NOTHING, PROBES), 'byte for byte the empty election');
  assert.deepEqual(answers(await current(), PROBES), answers(NOTHING, PROBES), 'and it reads back that way too');
});

await check('and does not erase the record of having been in scope', async () => {
  const e = await current();
  const actions = e.transitions.map((t) => t.action);
  assert.deepEqual(actions.filter((a) => !ACTIONS.includes(a)), [], 'every transition names one of the four actions');
  assert.ok(actions.includes('declare') && actions.includes('elect') && actions.includes('withdraw'));

  const out = e.transitions.at(-1);
  assert.equal(out.action, 'withdraw');
  assert.ok(out.justification.length >= 20, 'the reason is on the record, not in somebody\'s head');
  assert.deepEqual(out.criteria, ['SOC2.CC6.1', 'SOC2.CC7.2', 'SOC2.CC8.1'].filter((c) => out.criteria.includes(c)));
  assert.equal(out.boundary.name, 'Climative', 'what was withdrawn is named, not just that something was');
});

await check('the history is the chain, and the justifications are in it', async () => {
  const log = await history({ limit: 50 });
  assert.ok(log.length >= 4, `${log.length} commits`);
  assert.match(log.at(0).subject, /^withdraw: Climative \(bc-3muu\.6\)$/);
  assert.match(log.at(0).message, /the attestation was not pursued/);
  assert.match(log.at(-1).subject, /^declare boundary: Climative/);
  const elects = log.filter((c) => c.subject.startsWith('elect '));
  assert.ok(elects.length >= 1, 'the elections are readable by `git log` alone');
});

await check('the election ref is a chain, verified the way the register claims it', async () => {
  const v = await verifyRef(tmp, ELECTION_REF);
  assert.equal(v.linear, true, 'no commit has two parents');
  assert.equal(v.intact, true, 'every parent is in the walk, back to one root');
  assert.equal(v.length, refCommits());
});

await check('the register claims lib/election.js, so its retention is stated somewhere', () => {
  assert.equal(claimed().get('lib/election.js'), 'REGISTER[election-history]');
});

await cleanupTmp(tmp);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
