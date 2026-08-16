#!/usr/bin/env node
//
// The agent log survives its own reset — `lib/agentarchive.js`.
//
//   npm test                          (runs it alongside the other suites)
//   node test/agentarchive.mjs        (on its own)
//
// bc-eqn1.7. `lib/agentlog.js` truncates the per-bead log at every dispatch, which is
// right for the pane a phone is tailing and destroys the record: what an agent did on a
// bead survived exactly until the next dispatch at that bead, so the run an incident is
// reconstructed from — always the one that was retried — was the one guaranteed to be
// gone. `lib/evidence.js` registered that as the `agent-run-logs` gap and named this bead.
//
// Five things are worth testing and the rest is plumbing:
//
// 1. **The acceptance criterion itself**, stated as the thing that used to fail: archive,
//    reset, run again, archive again — and the first run is still readable. Every other
//    check here is downstream of that one, so it is written as the run of events rather
//    than as an assertion about a function.
// 2. **The provenance is on the record.** Agent kind, foundation revision, model and
//    endorsement, because a run whose model nobody wrote down is not evidence of which
//    model was in use in March. And it must be *taken*, not derived — so the suite hands
//    in a model no derivation would produce and asserts it comes back.
// 3. **Alteration is detectable, both halves.** A tampered body against the sha256 in its
//    record, and a tampered record against the chain — the second demonstrated with
//    `verifyRef` and an anchor rather than asserted, because a rewritten history is
//    perfectly intact and only a head recorded beforehand can catch one.
// 4. **The retrieval is the one an auditor performs**: this bead's runs, and this day's
//    runs. Including the case that would answer the wrong question quietly — a bead whose
//    id is a prefix of another bead's.
// 5. **Disposal is a rule, and the rule is enforced *and recorded*.** A body past the
//    period is gone; a body inside it is not; the deletion is on the chain, because "there
//    is no run from March" and "the run from March was disposed of on 3 May under a
//    24-month rule" are the same absence and completely different answers.
//
// Everything runs against a temp BEADCAUSE_CONFIG_DIR and a temp git repo. Nothing here
// touches ~/.config/beadcause, this checkout's refs, or the network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/* --------------------------------------------------------------- harness */

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
};

const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-agentarchive-'));
process.env.BEADCAUSE_CONFIG_DIR = CONFIG;

const archive = await import('../lib/agentarchive.js');
const agentlog = await import('../lib/agentlog.js');
const { RETENTION_FLOOR_MONTHS, verifyRef } = await import('../lib/evidence.js');
const { ARCHIVE_REF, BODY_DIR, archiveAndReset, archiveRun, bodyPath, dispose, disposals, readBody, retentionMonths, runId, runs } =
  archive;

/** A git repo of its own, so the chain is never written into this checkout. */
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-agentarchive-repo-'));
execFileSync('git', ['-C', repo, 'init', '-q', '--initial-branch=main']);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'beadcause@localhost']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'beadcause']);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

/** Write a live log the way lib/dispatch.js would, then archive it the way it now does. */
const live = (key, ...lines) => agentlog.append(key, lines.join('\n'));
const keep = (key, meta = {}) => archiveAndReset(key, { cwd: repo, ...meta });

/* ------------------------------------------- 1. the criterion, as a run of events */

const KEY = 'beadcause/bc-eqn1.7';

await check('a run archived before the reset is still readable after two more runs', async () => {
  const first = await keep(KEY, { agent: 'dispatch', model: 'claude-opus-5', bead: 'bc-eqn1.7' });
  assert.equal(first.archived, false, 'the very first dispatch has nothing behind it to archive');

  // The run that used to be destroyed: it is the *previous* one that gets archived, so it
  // takes a second dispatch for the first run to reach the store at all.
  live(KEY, '● run one', '● done · 12s');
  const second = await keep(KEY, { agent: 'dispatch', model: 'claude-opus-5', bead: 'bc-eqn1.7' });
  assert.equal(second.archived, true, second.reason || '');
  assert.equal(second.chained, true, second.reason || '');
  // Still removed outright, not emptied — the pane's clean file is exactly what `reset`
  // was always for, and nothing about that changed. What changed is what happens first.
  assert.equal(fs.existsSync(agentlog.logPath(KEY)), false, 'the live log was not cleared');

  live(KEY, '● run two — the retry', '● failed');
  const third = await keep(KEY, { agent: 'dispatch', model: 'claude-opus-5', bead: 'bc-eqn1.7' });
  assert.equal(third.chained, true, third.reason || '');

  // The whole bead, in one line: run one is readable after run two replaced it.
  const body = readBody(second.id);
  assert.match(body, /● run one/);
  assert.match(readBody(third.id), /the retry/);
  assert.notEqual(second.id, third.id, 'two runs at one bead collided on a single id');
});

await check('two runs archived in the same millisecond do not overwrite each other', async () => {
  // Found by the check above rather than reasoned about: at second resolution the two
  // archives in that run collided and the second wrote over the first, which is an evidence
  // store losing a run silently — the bug being fixed here, wearing a different hat.
  const at = new Date('2026-08-15T19:30:12.345Z');
  const key = 'beadcause/bc-samems';
  live(key, '● the first of two');
  const one = await keep(key, { agent: 'dispatch', now: at });
  live(key, '● the second of two');
  const two = await keep(key, { agent: 'dispatch', now: at });

  assert.notEqual(one.id, two.id, 'two archives at one instant collided on a single id');
  assert.match(readBody(one.id), /the first of two/);
  assert.match(readBody(two.id), /the second of two/);
  // And the disambiguated one still carries a date, or the retention sweep would leave it
  // in place forever while reporting nothing wrong.
  assert.equal(archive.runIdDate(two.id)?.toISOString(), at.toISOString());
});

/* ------------------------------------------------------- 2. what the record says */

await check('the record carries agent kind, model, foundation revision and endorsement', async () => {
  live(KEY, '● something');
  await keep(KEY, { agent: 'dispatch' });
  live(KEY, '● the run whose provenance is under test');
  const out = await keep(KEY, {
    agent: 'dispatch',
    persona: 'the sceptic',
    // A model string nothing here could derive. If provenance were re-derived rather than
    // taken, this is the assertion that would fail, and it would fail for the right reason.
    model: 'a-model-no-derivation-would-invent',
    bead: 'bc-eqn1.7',
    workspace: 'beadcause',
    dir: repo,
    endorsed: true,
    endorsementNote: 'endorsed on the phone',
  });
  const r = out.record;
  assert.equal(r.agent, 'dispatch');
  assert.equal(r.persona, 'the sceptic');
  assert.equal(r.model, 'a-model-no-derivation-would-invent');
  assert.equal(r.workspace, 'beadcause');
  assert.equal(r.bead, 'bc-eqn1.7');
  assert.equal(r.endorsement.endorsed, true);
  assert.equal(r.foundation.ref, 'refs/beadcause/foundations');
  // Null in a repo with no amendment ever approved, which is most repos and is an answer
  // rather than a gap — what must not happen is the field being absent.
  assert.ok('revision' in r.foundation);
  assert.equal(r.retentionMonths, RETENTION_FLOOR_MONTHS);
});

await check('a survey is archived with no bead rather than with the word "advocate"', async () => {
  const key = 'beadcause/advocate';
  live(key, '● surveying beadcause');
  await keep(key, { agent: 'advocate', bead: null });
  live(key, '● surveying beadcause again');
  const out = await keep(key, { agent: 'advocate', bead: null, model: 'claude-sonnet-5' });
  assert.equal(out.record.bead, null, 'a bead field holding "advocate" is an id nothing can look up');
  assert.equal(out.record.agent, 'advocate');
  assert.equal(out.record.workspace, 'beadcause');
});

/* --------------------------------------------------- 3. alteration is detectable */

await check('an edited body no longer matches the digest in its record', async () => {
  live(KEY, '● the run somebody will edit');
  await keep(KEY, { agent: 'dispatch' });
  live(KEY, '● and the one after it');
  const out = await keep(KEY, { agent: 'dispatch' });

  const at = bodyPath(out.id);
  const before = crypto.createHash('sha256').update(fs.readFileSync(at)).digest('hex');
  assert.equal(before, out.record.sha256, 'the digest did not describe the body when it was written');

  fs.writeFileSync(at, '● the run somebody will edit\n● and an extra line nobody ran\n');
  const after = crypto.createHash('sha256').update(fs.readFileSync(at)).digest('hex');
  assert.notEqual(after, out.record.sha256, 'the body was altered and the digest did not notice');
});

await check('the chain reports itself linear and intact, and an anchor catches a rewrite', async () => {
  const anchor = git('rev-parse', ARCHIVE_REF);
  const v = await verifyRef(repo, ARCHIVE_REF, { anchor });
  assert.equal(v.linear, true);
  assert.equal(v.intact, true);
  assert.equal(v.anchored, true);
  assert.ok(v.length >= 4, `expected several records on the chain, got ${v.length}`);

  // A rewritten history is *perfectly* intact — that is the point of the anchor, and it is
  // the property the register's `alterableBy` sentence rests on.
  const tree = git('hash-object', '-t', 'tree', '-w', '--stdin');
  const forged = execFileSync('git', ['-C', repo, 'commit-tree', tree, '-m', 'agent run · forged · x · x'], {
    input: '',
    encoding: 'utf8',
  }).trim();
  git('update-ref', 'refs/beadcause/forged', forged);
  const after = await verifyRef(repo, 'refs/beadcause/forged', { anchor });
  assert.equal(after.intact, true, 'a forged chain is self-consistent — that is why the anchor exists');
  assert.equal(after.anchored, false, 'the anchor did not catch the rewrite');
});

/* ------------------------------------------------------------- 4. the retrieval */

await check('runs are retrievable by bead, and a prefix of another bead is not a match', async () => {
  // The trap: `beadcause/bc-eqn1.7` is a prefix of `beadcause/bc-eqn1.70`, so a substring
  // grep answers a question about one bead with another bead's runs and says nothing.
  const sibling = 'beadcause/bc-eqn1.70';
  live(sibling, '● a different bead entirely');
  await keep(sibling, { agent: 'dispatch', bead: 'bc-eqn1.70' });
  live(sibling, '● and its second run');
  await keep(sibling, { agent: 'dispatch', bead: 'bc-eqn1.70' });

  const mine = await runs({ cwd: repo, key: KEY });
  assert.ok(mine.length >= 3, `expected this bead's runs, got ${mine.length}`);
  assert.ok(
    mine.every((r) => r.key === KEY),
    `a prefix sibling leaked in: ${[...new Set(mine.map((r) => r.key))].join(', ')}`
  );

  const theirs = await runs({ cwd: repo, key: sibling });
  assert.equal(theirs.length, 2, 'the sibling should have exactly its own two archived runs');
  assert.ok(theirs.every((r) => r.key === sibling));
});

await check('runs are retrievable by date range, and the range excludes as well as includes', async () => {
  const all = await runs({ cwd: repo });
  assert.ok(all.length >= 5, `expected the whole chain, got ${all.length}`);
  assert.ok(
    all.every((r) => r.type === 'run'),
    'a disposal commit was returned as if it were a run'
  );

  const today = await runs({ cwd: repo, since: '1 hour ago' });
  assert.equal(today.length, all.length, 'everything written in this suite is inside the last hour');

  const ancient = await runs({ cwd: repo, since: '2000-01-01', until: '2000-01-02' });
  assert.deepEqual(ancient, [], 'a window with nothing in it must be empty rather than everything');
});

await check('a retrieved run says whether its body is still there', async () => {
  const [one] = await runs({ cwd: repo, key: KEY, limit: 1 });
  assert.ok(one, 'no run came back at all');
  assert.equal(one.present, true);
  assert.equal(typeof one.sha256, 'string');
  assert.equal(typeof one.archivedAt, 'string');
  assert.equal(typeof one.commit, 'string');
});

/* ------------------------------------------------ 5. retention, and its disposal */

await check('the retention period cannot be set below the floor, and can be set above it', () => {
  assert.equal(retentionMonths({}), RETENTION_FLOOR_MONTHS);
  assert.equal(retentionMonths({ agentLogRetentionMonths: 1 }), RETENTION_FLOOR_MONTHS, 'a shorter period was accepted');
  assert.equal(retentionMonths({ agentLogRetentionMonths: 0 }), RETENTION_FLOOR_MONTHS);
  assert.equal(retentionMonths({ agentLogRetentionMonths: 'soon' }), RETENTION_FLOOR_MONTHS);
  assert.equal(retentionMonths({ agentLogRetentionMonths: 84 }), 84, 'a longer period is an install saying so');
});

await check('a body past the period is disposed of, one inside it is kept, and the chain says so', async () => {
  // Two runs, dated by their ids rather than by an mtime: an mtime is the one thing about
  // a file anybody can change by accident, and a sweep keying on it disposes of the wrong
  // decade quietly.
  const old = runId('beadcause/bc-old', '2020-01-01T00:00:00.000Z');
  const recent = runId('beadcause/bc-recent', new Date().toISOString());
  fs.mkdirSync(BODY_DIR, { recursive: true });
  fs.writeFileSync(bodyPath(old), '● a run from 2020\n');
  fs.writeFileSync(bodyPath(recent), '● a run from today\n');
  // And one nobody can date, which must be left alone rather than guessed at.
  fs.writeFileSync(path.join(BODY_DIR, 'not-one-of-ours.log'), 'who put this here\n');

  const out = await dispose({ cwd: repo });
  assert.ok(out.disposed.includes(old), `the 2020 body survived a ${out.months}-month rule`);
  assert.ok(!out.disposed.includes(recent), 'a body inside the period was disposed of');
  assert.equal(fs.existsSync(bodyPath(old)), false);
  assert.equal(fs.existsSync(bodyPath(recent)), true);
  assert.equal(fs.existsSync(path.join(BODY_DIR, 'not-one-of-ours.log')), true, 'an undateable file was deleted');
  assert.equal(out.chained, true, out.reason || '');

  const [record] = await disposals({ cwd: repo });
  assert.ok(record, 'nothing on the chain records the disposal');
  assert.ok(record.disposed.includes(old));
  assert.equal(record.months, RETENTION_FLOOR_MONTHS);
  assert.match(record.rule, /kept 24 months/);
});

await check('a disposal leaves the record of the run, and the run reads as disposed rather than absent', async () => {
  // The whole argument for splitting the two stores: the body is gone and the record is
  // not, so an auditor asking about a run outside the window gets a date rather than a
  // silence. `present: false` is what says which.
  live('beadcause/bc-vanished', '● seeding a real record for it');
  await keep('beadcause/bc-vanished', { agent: 'dispatch', bead: 'bc-vanished' });
  live('beadcause/bc-vanished', '● and the run that replaces it');
  const out = await keep('beadcause/bc-vanished', { agent: 'dispatch', bead: 'bc-vanished' });

  fs.rmSync(bodyPath(out.id), { force: true });
  const [row] = await runs({ cwd: repo, key: 'beadcause/bc-vanished' });
  assert.equal(row.present, false, 'a disposed body must not read as present');
  assert.equal(typeof row.sha256, 'string', 'the digest of a disposed body is what remains provable');
  assert.equal(readBody(out.id), null);
});

await check('disposing of nothing writes nothing to the chain', async () => {
  const before = git('rev-parse', ARCHIVE_REF);
  const out = await dispose({ cwd: repo });
  assert.deepEqual(out.disposed, []);
  assert.equal(git('rev-parse', ARCHIVE_REF), before, 'an empty sweep appended a commit');
});

/* -------------------------------------------- the rule that keeps all of it true */

await check('lib/agentarchive.js is the only thing in lib/ that resets an agent log', () => {
  // The guarantee is an ordering — copy the body, chain it, then delete — and an ordering
  // has exactly one way to be broken: somebody calls the destructive half directly. That is
  // not hypothetical, it is what the two call sites did until this bead, so it is checked
  // rather than left in a comment. `bin/` is swept too: a script clearing a log is the same
  // run destroyed by a different door.
  const offenders = [];
  for (const dir of ['lib', 'bin']) {
    const at = path.join(ROOT, dir);
    for (const name of fs.readdirSync(at)) {
      if (!name.endsWith('.js')) continue;
      const file = `${dir}/${name}`;
      if (file === 'lib/agentarchive.js' || file === 'lib/agentlog.js') continue;
      const src = fs.readFileSync(path.join(at, name), 'utf8');
      // Comments here argue in prose that names the identifiers around them — including
      // the note in lib/dispatch.js saying not to do this — so the scan has to blank them
      // or it finds the warning and reports it as the offence.
      if (/agentlog\.reset\s*\(|\breset\s*\(\s*key\s*\)/.test(blank(src))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `${offenders.join(', ')} resets an agent log without archiving it first`);
});

/** Comments out, strings left alone — the same rule lib/evidence.js's scanner keeps. */
function blank(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/* ------------------------------------------------------------------ teardown */

await cleanupTmp(CONFIG);
fs.rmSync(repo, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
