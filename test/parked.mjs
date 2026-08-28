#!/usr/bin/env node
/**
 * A window that is waiting on you closes, and your answer brings it back.
 *
 *     npm test
 *     node test/parked.mjs
 *
 * **The failure.** Thirteen idle Claude windows on one Mac with nothing on any advocate's
 * slot list — four merge-queue conflict resolvers, a MergeAdvocate, three P0 advocates,
 * two hand-run sessions — every one of them finished talking and waiting on Adam, and none
 * of them distinguishable from a session still working without opening it and reading it.
 * lib/reap.js could not touch any of them: it starts from a worker row, and four of the
 * eight doors in lib/session.js open windows no worker row has ever tracked.
 *
 * **What is being pinned, and the one property everything else serves.** A window may be
 * closed *only once its conversation is written down*, because `claude --resume <id>` is
 * the only thing that makes closing it something other than destroying an hour of an
 * agent's work. So the assertions below are mostly about ordering and about refusing:
 *
 * 1. **A record that cannot be resumed is not a park.** `parkable` is the gate in front of
 *    the close, and every field it insists on is one whose absence makes `--resume` fail
 *    silently later — an id that is not an id, or a directory, without which the transcript
 *    cannot be found at all.
 * 2. **The decision to close is made about an identity, not a name or a pid.** A window is
 *    matched to its register row by session id; a busy one is never closed; an idle one is
 *    given minutes, not seconds, because here the ending is inferred from silence rather
 *    than proved by a closed bead.
 * 3. **An unknown status waits.** Every unrecognised input in this feature has to fail
 *    towards *leave the window open*, which is the state that existed before it.
 * 4. **The command line says which of the two flags it is.** `--session-id` on the first
 *    turn and `--resume` after are not interchangeable, and getting it backwards is an
 *    error `claude` reports by exiting instantly — an iTerm window that opens and dies.
 * 5. **The reaper's guard 2 prefers the id over the name**, and still falls back to the
 *    name for every worker adopted from before ids were minted.
 * 6. **A junk state file reads as "nothing is parked"** — the cheap failure, not the
 *    confident wrong one, exactly as every other field in state.json does.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Not `fs.rmSync(tmp)`. This suite calls `saveState`, every save calls `snapshot`, and
// `snapshot` schedules a `git init` in CONFIG_DIR two seconds later — which under test is
// the scratch directory this teardown is walking. That race is bc-5uy8 and it fails the
// whole run from the last line of a suite whose every check passed.
import { cleanupTmp } from './helpers/tmp.mjs';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-parked-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { loadState, saveState, STATE_PATH } = await import(LIB('config.js'));
const {
  PARK_DEFAULTS,
  PARK_MAX,
  PARK_TTL_MS,
  beadKey,
  countResume,
  dropOpen,
  dropPark,
  openList,
  parkDecision,
  parkable,
  parkedAt,
  parkedList,
  prKey,
  prunePark,
  recordPark,
  registerOpen,
} = await import(LIB('parked.js'));
const { continuityFlag, sessionCommand } = await import(LIB('session.js'));
const { decide } = await import(LIB('reap.js'));
const { mainOf, resumePrompt, interruptedPrompt } = await import(LIB('resume.js'));

console.log('\na window waiting on you, parked and resumed\n');

const NOW = new Date('2026-08-16T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const UUID = '5784698b-c018-4596-868c-7435979e40c8';
const REC = {
  sessionId: UUID,
  dir: '/Users/a/dev/beadcause/.claude/worktrees/park-resume-2uj5',
  workspace: 'beadcause',
  bead: 'bc-2uj4.5',
  kind: 'worker',
  title: '▶ bc-2uj4.5 park and resume',
  waitingOn: 'it asked you a question',
};

/* ----------------------------------------------- 1. the gate in front of the close */

check('a complete record is parkable', () => {
  assert.equal(parkable(REC), true);
});

check('no session id is not parkable — there would be nothing to resume', () => {
  assert.equal(parkable({ ...REC, sessionId: '' }), false);
  assert.equal(parkable({ ...REC, sessionId: 'not a session id' }), false);
  // The shape matters because this value ends up as the argument to `--resume`.
  assert.equal(parkable({ ...REC, sessionId: '../../etc/passwd' }), false);
});

check('no directory is not parkable — the worktree is not in the transcript', () => {
  // `--resume` finds the conversation from anywhere (measured), so the directory is not
  // how it is located. It is the branch, the uncommitted edits and the files every path
  // in that agent's context points at — none of which the transcript carries.
  assert.equal(parkable({ ...REC, dir: '' }), false);
});

check('no workspace is not parkable — every reader of the store is scoped to one', () => {
  assert.equal(parkable({ ...REC, workspace: '' }), false);
});

check('a record with no bead is still parkable — a resolver has a pull request instead', () => {
  assert.equal(parkable({ ...REC, bead: null, pr: '342' }), true);
});

/* ---------------------------------------------------------- 2. the record round-trips */

check('parking writes down the conversation, the directory and the sentence', () => {
  const p = recordPark({}, beadKey('beadcause', 'bc-2uj4.5'), REC, NOW);
  const back = parkedAt(p, 'beadcause/bc-2uj4.5');
  assert.equal(back.sessionId, UUID);
  assert.equal(back.dir, REC.dir);
  assert.equal(back.bead, 'bc-2uj4.5');
  assert.equal(back.waitingOn, 'it asked you a question');
  assert.equal(back.at, NOW.toISOString());
  assert.equal(back.resumes, 0);
});

check('a half-written record reads as nothing parked, not as a resume that will fail', () => {
  assert.equal(parkedAt({ 'beadcause/x': { sessionId: UUID } }, 'beadcause/x'), null);
  assert.equal(parkedAt({}, 'beadcause/x'), null);
  assert.equal(parkedAt(null, 'beadcause/x'), null);
});

check('parking the same key again overwrites — the newer transcript is the true one', () => {
  const second = '11111111-2222-3333-4444-555555555555';
  let p = recordPark({}, 'beadcause/bc-1', REC, NOW);
  p = recordPark(p, 'beadcause/bc-1', { ...REC, sessionId: second }, NOW);
  assert.equal(parkedAt(p, 'beadcause/bc-1').sessionId, second);
});

check('the trip count survives the overwrite — it counts trips, not parks', () => {
  let p = recordPark({}, 'beadcause/bc-1', REC, NOW);
  p = countResume(p, 'beadcause/bc-1');
  p = recordPark(p, 'beadcause/bc-1', REC, NOW);
  assert.equal(parkedAt(p, 'beadcause/bc-1').resumes, 1);
});

/**
 * And it survives the case that actually happens — bc-y7l2m.
 *
 * The overwrite above is the easy half and it was never the real path: a resume *drops*
 * the record, so by the time the resumed window parks again there is no prior to carry
 * anything, and every second trip was being written down as the first. The count rides on
 * the worker in between and comes back through `rec.resumes`. Without that, `maxResumes`
 * never binds and the same window reopens forever.
 */
check('and it survives the drop, because the caller carries it back', () => {
  let p = recordPark({}, 'beadcause/bc-1', REC, NOW);
  p = dropPark(countResume(p, 'beadcause/bc-1'), 'beadcause/bc-1');
  assert.deepEqual(p, {}, 'the record really is gone — two dispatches must not both find one');
  p = recordPark(p, 'beadcause/bc-1', { ...REC, resumes: 1 }, NOW);
  assert.equal(parkedAt(p, 'beadcause/bc-1').resumes, 1, 'the trip the dropped record knew about');
});

check('a caller that knows nothing about trips does not reset the count', () => {
  let p = recordPark({}, 'beadcause/bc-1', { ...REC, resumes: 3 }, NOW);
  p = recordPark(p, 'beadcause/bc-1', REC, NOW);
  assert.equal(parkedAt(p, 'beadcause/bc-1').resumes, 3, 'whichever side knows more is the one telling the truth');
});

/**
 * Which ending parked it, kept as a field because it decides what the resumed agent is
 * told: `resumePrompt` opens with "Adam answered" and `interruptedPrompt` opens with
 * "nothing was answered". Getting that wrong sends an agent looking for a decision nobody
 * made, which is the one failure here it cannot detect for itself.
 */
check('the ending is recorded, so the resume knows which turn to write', () => {
  const p = recordPark({}, 'beadcause/bc-1', { ...REC, ending: 'gone' }, NOW);
  assert.equal(parkedAt(p, 'beadcause/bc-1').ending, 'gone');
});

check('a record from before endings were kept reads as null, never as gone', () => {
  const p = recordPark({}, 'beadcause/bc-1', REC, NOW);
  assert.equal(parkedAt(p, 'beadcause/bc-1').ending, null, 'and null takes the answering turn, which is what those were');
});

/**
 * bc-xl7n.147. `interruptedPrompt` covers two endings now — `gone` (a window closed by
 * hand, killed, or lost with its terminal) and `idle` (the sweep closed a quiet one on
 * purpose) — and only the opening line differs, because only it makes a claim about *why*
 * the window is not there. Everything below it (do not start over, reclaim, main has
 * moved) is true of both.
 */
check('the opening line is honest about which of the two endings this was', () => {
  const gone = interruptedPrompt({ owner: 'Adam', bead: 'bc-2uj4.5', parkedAt: ago(3600e3) });
  assert.match(gone, /Your window disappeared/);
  assert.doesNotMatch(gone, /went quiet/i);

  const idle = interruptedPrompt({ owner: 'Adam', bead: 'bc-2uj4.5', parkedAt: ago(3600e3), reason: 'idle' });
  assert.match(idle, /went quiet/i);
  assert.doesNotMatch(idle, /disappeared/, 'nothing disappeared — the daemon closed it on purpose');

  // And what does not change between them: neither ending has anything waiting on Adam.
  for (const text of [gone, idle]) {
    assert.match(text, /Nothing was answered/i);
    assert.doesNotMatch(text, /answered\.\*\*/, 'never the turn that delivers an answer');
    assert.match(text, /bd update bc-2uj4\.5 --claim/, 'the claim was forced off either way');
    assert.match(text, /Do not start over/);
  }
});

check('`reason` defaults to `gone`, for every call site written before `idle` existed', () => {
  const text = interruptedPrompt({ owner: 'Adam', bead: 'bc-2uj4.5' });
  assert.match(text, /Your window disappeared/);
});

check('dropping is what happens after the window is open, and it is complete', () => {
  const p = recordPark({}, 'beadcause/bc-1', REC, NOW);
  assert.deepEqual(dropPark(p, 'beadcause/bc-1'), {});
});

check('the keys say where a row came from', () => {
  assert.equal(beadKey('beadcause', 'bc-2uj4.5'), 'beadcause/bc-2uj4.5');
  assert.equal(prKey('beadcause', 342), 'beadcause/pr-342');
});

/* -------------------------------------------------- 3. deciding to close a window */

const live = (over) => ({ pid: 4242, sessionId: UUID, status: 'idle', at: ago(60 * 60 * 1000), ...over });

check('no live session with this id — the window is already gone, so drop it', () => {
  assert.equal(parkDecision(REC, null, { now: NOW }).act, 'drop');
});

check('busy is never closed, however long it has been busy', () => {
  const d = parkDecision(REC, live({ status: 'busy', at: ago(9 * 60 * 60 * 1000) }), { now: NOW });
  assert.equal(d.act, 'wait');
});

check('idle but only briefly waits — a gap between turns looks like the end of one', () => {
  const d = parkDecision(REC, live({ at: ago(4 * 60 * 1000) }), { idleMinutes: 10, now: NOW });
  assert.equal(d.act, 'wait');
  assert.match(d.why, /4m of 10m/);
});

check('idle for long enough parks', () => {
  const d = parkDecision(REC, live({ at: ago(45 * 60 * 1000) }), { idleMinutes: 10, now: NOW });
  assert.equal(d.act, 'park');
  assert.match(d.why, /waiting on you/);
});

check('an unrecognised status waits while it is fresh — the safe direction is leaving it open', () => {
  const fresh = ago(5 * 60 * 1000);
  assert.equal(parkDecision(REC, live({ status: 'compacting', at: fresh }), { now: NOW }).act, 'wait');
  assert.equal(parkDecision(REC, live({ status: '', at: fresh }), { now: NOW }).act, 'wait');
});

check('an unrecognised status that has not moved in hours is stale, and parks', () => {
  // The hole this closes: `wait` used to be the answer forever, and a Claude Code record
  // only moves when its session moves. One was measured at four days in `shell`, holding a
  // worktree lock, invisible to every sweep on the Mac at once.
  const d = parkDecision(REC, live({ status: 'shell', at: ago(4 * 24 * 60 * 60 * 1000) }), {
    stuckMinutes: 60,
    now: NOW,
  });
  assert.equal(d.act, 'park');
  assert.match(d.why, /"shell"/);
});

check('busy is exempt from the stale rule, however long it has stood', () => {
  // The one status that means an agent is mid-sentence keeps its unconditional wait.
  const d = parkDecision(REC, live({ status: 'busy', at: ago(4 * 24 * 60 * 60 * 1000) }), {
    stuckMinutes: 60,
    now: NOW,
  });
  assert.equal(d.act, 'wait');
});

check('a session that never said when it went quiet waits', () => {
  assert.equal(parkDecision(REC, live({ at: 'not a date' }), { now: NOW }).act, 'wait');
});

check('a record that could not be parked is dropped rather than closed', () => {
  // The ordering property, stated as a test: nothing that cannot be written down may be
  // signalled. `drop` forgets the row; it never reaches the closing list.
  assert.equal(parkDecision({ ...REC, sessionId: '' }, live(), { now: NOW }).act, 'drop');
});

check('the grace is minutes and the default says so', () => {
  assert.equal(PARK_DEFAULTS.parkIdleMinutes, 10);
});

/* ------------------------------------------------------ 4. the register of open windows */

check('a window is registered by session id, which is the identity nothing else has', () => {
  const o = registerOpen({}, { ...REC, kind: 'merge-advocate' }, NOW);
  assert.deepEqual(Object.keys(o), [UUID]);
  assert.equal(openList(o, 'beadcause').length, 1);
  assert.equal(openList(o, 'sophab').length, 0);
});

check('an unregisterable window is not registered at all', () => {
  assert.deepEqual(registerOpen({}, { ...REC, sessionId: '' }, NOW), {});
});

check('dropping a registration is complete', () => {
  const o = registerOpen({}, REC, NOW);
  assert.deepEqual(dropOpen(o, UUID), {});
});

/* -------------------------------------------------------------- 5. the command line */

check('the first turn mints an id, and a resume names one', () => {
  assert.equal(continuityFlag(UUID), ` --session-id '${UUID}'`);
  assert.equal(continuityFlag(UUID, true), ` --resume '${UUID}'`);
});

check('no id at all puts neither flag on the line', () => {
  assert.equal(continuityFlag(null), '');
  assert.equal(continuityFlag(''), '');
});

check('the flag goes on the command, and the prompt still comes last behind --', () => {
  const cmd = sessionCommand(
    { tools: [], allowedTools: [], model: null },
    { dir: '/tmp/x', promptFile: '/tmp/p.md', sessionId: UUID }
  );
  assert.match(cmd, new RegExp(`--session-id '${UUID}'`));
  // `--` ends option parsing, which is what stops a brief beginning with a dash being
  // read as a flag and what terminates the variadic options before it. See `promptArgs`.
  assert.match(cmd, /-- "\$P"/);
  assert.equal(cmd.indexOf('--session-id') < cmd.indexOf('-- "$P"'), true);
});

check('a resumed command carries --resume and not --session-id', () => {
  const cmd = sessionCommand(
    { tools: [], allowedTools: [], model: null },
    { dir: '/tmp/x', promptFile: '/tmp/p.md', sessionId: UUID, resume: true }
  );
  assert.match(cmd, /--resume/);
  assert.equal(/--session-id/.test(cmd), false);
});

/* ------------------------------------------------------ 6. the reaper's identity guard */

const entry = (over) => ({ id: 'bc-2uj4.5', title: 't', pid: 4242, at: ago(10 * 60 * 1000), sentAt: null, ...over });

check('guard 2 is an identity check when the entry carries a session id', () => {
  const d = decide(entry({ sessionId: UUID }), { pid: 4242, sessionId: UUID, name: 'anything at all', status: 'idle' });
  assert.equal(d.act, 'term');
});

check('a pid now running a different conversation is dropped, whatever it calls itself', () => {
  const d = decide(entry({ sessionId: UUID }), {
    pid: 4242,
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'beadcause - bc-2uj4.5 something',
    status: 'idle',
  });
  assert.equal(d.act, 'drop');
});

check('a worker from before ids were minted still falls back to the name check', () => {
  const named = { pid: 4242, sessionId: '', name: 'beadcause - bc-2uj4.5 park and resume', status: 'idle' };
  assert.equal(decide(entry({ sessionId: null }), named).act, 'term');
  assert.equal(decide(entry({ sessionId: null }), { ...named, name: 'something else entirely' }).act, 'drop');
});

/* ------------------------------------------------------------------- 7. housekeeping */

check('the attic path is read off the path, because the directory may not be there', () => {
  assert.equal(mainOf('/Users/a/dev/bc/.claude/worktrees/thing-4e7'), '/Users/a/dev/bc');
  assert.equal(mainOf('/Users/a/dev/bc/.claude/worktrees-retired/thing-4e7'), '/Users/a/dev/bc');
  assert.equal(mainOf('/Users/a/dev/bc'), null);
});

check('a resumed agent is told who answered and what they said, and is not re-briefed', () => {
  const text = resumePrompt({ owner: 'Adam', bead: 'bc-2uj4.5', answer: 'Do it the second way.', parkedAt: ago(3600e3) });
  assert.match(text, /Adam answered/);
  assert.match(text, /> Do it the second way\./);
  assert.match(text, /bc-2uj4\.5/);
  // The whole point of resuming rather than re-briefing: the brief is already in context.
  assert.match(text, /do not need them repeated/);
  // And the one thing that genuinely changed underneath it: `commission` takes the
  // `human` label off and reopens the bead **unassigned**, which is what put it back in
  // the queue. A resumed session that does not re-claim is a bead a second window can be
  // opened on top of — the failure bc-2uj4 exists to end.
  assert.match(text, /bd update bc-2uj4\.5 --claim/);
});

check('old parks are pruned, and the newest survive the cap', () => {
  const old = recordPark({}, 'beadcause/old', REC, new Date(NOW.getTime() - PARK_TTL_MS - 1000));
  assert.deepEqual(prunePark(old, NOW), {});
  let many = {};
  for (let i = 0; i < PARK_MAX + 20; i++) {
    many = recordPark(many, `beadcause/bc-${i}`, REC, new Date(NOW.getTime() - i * 1000));
  }
  const pruned = prunePark(many, NOW);
  assert.equal(Object.keys(pruned).length, PARK_MAX);
  assert.equal(Boolean(pruned['beadcause/bc-0']), true);
});

check('listing is newest first and scoped to one workspace', () => {
  let p = recordPark({}, 'beadcause/a', REC, new Date(NOW.getTime() - 60000));
  p = recordPark(p, 'beadcause/b', REC, NOW);
  p = recordPark(p, 'sophab/c', { ...REC, workspace: 'sophab' }, NOW);
  const rows = parkedList(p, 'beadcause');
  assert.deepEqual(rows.map((r) => r.key), ['beadcause/b', 'beadcause/a']);
});

/* --------------------------------------------------------- 8. the state file itself */

check('state.json defaults both stores to empty', () => {
  const s = loadState();
  assert.deepEqual(s.parked, {});
  assert.deepEqual(s.opened, {});
});

check('a park survives a round trip through the state file', () => {
  saveState({ parked: recordPark({}, 'beadcause/bc-2uj4.5', REC, NOW) });
  assert.equal(loadState().parked['beadcause/bc-2uj4.5'].sessionId, UUID);
});

check('a junk field reads as nothing parked — a window left open, never one closed blind', () => {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ parked: 'nonsense', opened: ['also nonsense'] }));
  const s = loadState();
  assert.deepEqual(s.parked, {});
  assert.deepEqual(s.opened, {});
});

await cleanupTmp(tmp);
console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
