#!/usr/bin/env node
/**
 * The router's handover trail — bc-khoe.8.
 *
 *     npm test
 *     node test/handover.mjs
 *
 * Three rungs of the release ladder — *deployed to green*, *green verification* and
 * *swapping to blue* — had nothing behind them until this file's subject existed, and the
 * failure mode of the fix is not "the times are wrong". It is that a time appears under a
 * rung nobody observed, which reads on a screen exactly like a verification that passed.
 * So what is asserted here is mostly about *absence*:
 *
 * 1. **An unreadable trail is no trail.** Absent, truncated, an array where an object was
 *    expected, a row with no stamp: every one of them answers `[]`, because a file we
 *    cannot read is not evidence that anything swapped.
 * 2. **The earliest claim on a deploy wins.** The router attributes a handover to the
 *    newest unsettled restarting deploy, which over-claims in one window — a hand-run swap
 *    twenty minutes after a release names that release too. The reader takes the earliest,
 *    so the loose claim cannot displace the real time.
 * 3. **A moment nobody recorded is left out**, rather than borrowing the handover's own
 *    stamp, so a rung with no observation stays `untracked` rather than being ticked with a
 *    time that is not its own.
 * 4. **The ring is shorter than the journal it points into**, which is the rule that keeps
 *    the file small and is the one a later change would quietly break.
 *
 * The attribution itself — which deploy record a handover belongs to — is asserted against
 * a real journal directory written by lib/deploy.js's own writer, because the whole
 * mechanism turns on `unconfirmed` counting and `failed` not.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupTmp } from './helpers/tmp.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-handover-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { HANDOVER_PATH, KEEP_HANDOVERS, handoverFor, listHandovers, observedRungs, recordHandover } = await import(
  '../lib/handover.js'
);
const { DEPLOY_DIR, restartingDeploy } = await import('../lib/deploy.js');
const { NOT_EVIDENCE } = await import('../lib/evidence.js');

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

// One base for the whole suite, so `iso(1)` in an assertion is the same string it was in
// the write two lines above it. A helper reading the clock each time is off by the
// milliseconds between them, which is a flake that only shows on a slow machine.
const NOW = Date.now();
const iso = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();
const wipe = () => {
  try {
    fs.unlinkSync(HANDOVER_PATH);
  } catch {
    /* not there, which is the state we wanted */
  }
};
const write = (text) => fs.writeFileSync(HANDOVER_PATH, text);

/* ------------------------------------------------------------------- the record */

console.log('\nthe record — one write per handover, newest first\n');

check('a handover is written down with all three of its moments', () => {
  wipe();
  const at = iso(1);
  recordHandover({ at, spawnedAt: iso(2), healthyAt: iso(1.5), build: 'abc123', pid: 4242, port: 51999, reason: 'lib/ moved' });
  const [rec, ...rest] = listHandovers();
  assert.equal(rest.length, 0);
  assert.equal(rec.at, at);
  assert.equal(rec.build, 'abc123');
  assert.equal(rec.pid, 4242);
  assert.equal(rec.port, 51999);
  assert.equal(rec.reason, 'lib/ moved');
  // The ordinary case, and not a gap: a swap the router did because `lib/` moved belongs
  // to no deploy at all.
  assert.equal(rec.deploy, null);
});

check('the newest is first, so a reader wanting the last one need not count', () => {
  wipe();
  recordHandover({ at: iso(9) });
  recordHandover({ at: iso(5) });
  recordHandover({ at: iso(1) });
  assert.deepEqual(
    listHandovers().map((h) => h.at),
    [iso(1), iso(5), iso(9)]
  );
});

check('the ring is shorter than the deploy journal it points into', () => {
  // The rule, not the number: a handover whose deploy record has aged out of the journal
  // cannot be attributed to anything, so keeping more of them than there are records to
  // join them to is keeping rows nobody can read.
  assert.ok(KEEP_HANDOVERS < 40, `${KEEP_HANDOVERS} handovers against 40 deploy records`);
  wipe();
  for (let i = KEEP_HANDOVERS + 5; i > 0; i -= 1) recordHandover({ at: iso(i) });
  const kept = listHandovers();
  assert.equal(kept.length, KEEP_HANDOVERS);
  // And it is the *oldest* that go: the newest handover is the one a release still on the
  // board went out through.
  assert.equal(kept[0].at, iso(1));
});

check('a write that cannot land is not a swap that failed', () => {
  wipe();
  // The contract bin/router.js relies on: best-effort, never throwing. A directory where
  // the file should be is the cheapest way to make the write fail for real.
  fs.mkdirSync(HANDOVER_PATH, { recursive: true });
  assert.equal(recordHandover({ at: iso(1) }), null);
  assert.deepEqual(listHandovers(), []);
  fs.rmSync(HANDOVER_PATH, { recursive: true, force: true });
});

/* -------------------------------------------------------------------- the reads */

console.log('\nreading it — every unreadable shape answers the same way\n');

check('no file at all is no handover, not an error', () => {
  wipe();
  assert.deepEqual(listHandovers(), []);
});

check('every garbled shape reads as no handover', () => {
  for (const text of ['', '{', 'null', '[]', '"a string"', '{"handovers":null}', '{"handovers":{"at":"x"}}', '17']) {
    write(text);
    assert.deepEqual(listHandovers(), [], `for ${JSON.stringify(text)}`);
  }
});

check('a row with no stamp is dropped, and its neighbours are not', () => {
  // A record with no `at` cannot be placed against a deploy or drawn under a rung, and
  // taking the whole file down over one bad row would lose the good ones beside it.
  write(JSON.stringify({ handovers: [{ pid: 1 }, { at: iso(3), pid: 2 }, null, { at: '', pid: 3 }] }));
  assert.deepEqual(
    listHandovers().map((h) => h.pid),
    [2]
  );
});

check('a bare array is read too, because that is the shape a hand-written one takes', () => {
  write(JSON.stringify([{ at: iso(2), pid: 7 }]));
  assert.equal(listHandovers()[0]?.pid, 7);
});

/* ------------------------------------------------------------- the attribution */

console.log('\nattribution — which release a handover carried\n');

check('a handover names its deploy, and nothing else claims it', () => {
  const trail = [
    { at: iso(1), deploy: 'd-two' },
    { at: iso(20), deploy: 'd-one' },
    { at: iso(30), deploy: null },
  ];
  assert.equal(handoverFor('d-one', trail).at, iso(20));
  assert.equal(handoverFor('d-two', trail).at, iso(1));
  assert.equal(handoverFor('d-nobody', trail), null);
  // A release with no deploy record cannot have a handover attributed to it, and asking
  // must not hand back the swap that happened to be nearest.
  assert.equal(handoverFor(null, trail), null);
  assert.equal(handoverFor(undefined, trail), null);
});

check('the earliest claim on a deploy wins, so a later loose one cannot displace it', () => {
  // The window the router over-claims in: an `unconfirmed` record from twenty minutes ago
  // is still the newest restarting deploy when somebody runs `npm run swap` by hand, so
  // that swap's handover names it too. The real one is the earlier of the two.
  const trail = [
    { at: iso(1), deploy: 'd-one', pid: 999 },
    { at: iso(21), deploy: 'd-one', pid: 111 },
  ];
  assert.equal(handoverFor('d-one', trail).pid, 111);
});

check('the three moments map onto the three rungs, in order', () => {
  const rec = { at: iso(1), spawnedAt: iso(3), healthyAt: iso(2) };
  assert.deepEqual(observedRungs(rec), { green: iso(3), verifying: iso(2), swapping: iso(1) });
});

check('a moment nobody recorded is left out rather than given a borrowed time', () => {
  // The rung then stays `untracked`, which is the honest state. Filling it with the
  // handover's own stamp would draw a health check at the moment of the swap it preceded.
  assert.deepEqual(observedRungs({ at: iso(1) }), { swapping: iso(1) });
  assert.deepEqual(observedRungs({ at: iso(1), spawnedAt: iso(2) }), { green: iso(2), swapping: iso(1) });
  assert.deepEqual(observedRungs(null), {});
});

/* ------------------------------------------------ which deploy the router picks */

console.log('\nthe journal read the router makes at the handover\n');

/** A deploy record on disk, exactly where lib/deploy.js keeps them. */
const journal = (recs) => {
  fs.rmSync(DEPLOY_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  for (const rec of recs) fs.writeFileSync(path.join(DEPLOY_DIR, `${rec.id}.json`), JSON.stringify(rec));
};
const record = ({ id = 'x', ...over } = {}) => ({
  key: 'beadcause',
  workspace: 'beadcause',
  restarts: true,
  status: 'deploying',
  requestedAt: iso(3),
  startedAt: iso(3),
  ...over,
  id: `d-${id}`,
});

check('a deploy still in flight is the one a handover belongs to', () => {
  journal([record({ id: 'a', status: 'building' })]);
  assert.equal(restartingDeploy()?.id, 'd-a');
});

check('and so is the `unconfirmed` ending, which is what a beadcause deploy looks like', () => {
  // launchd takes the runner along with the daemon, so by the time the new router hands
  // over the record may already have been swept to `unconfirmed`. Refusing that would mean
  // the one deploy shape this repo actually uses never got a handover.
  journal([record({ id: 'b', status: 'unconfirmed', finishedAt: iso(2) })]);
  assert.equal(restartingDeploy()?.id, 'd-b');
});

check('a deploy that never made anything live is not attributed a handover', () => {
  for (const status of ['failed', 'lost', 'ok']) {
    journal([record({ id: 'c', status })]);
    // `ok` is excluded too, and for a different reason from the other two: a deploy that
    // recorded its own clean ending had a runner that outlived it, so it did not restart
    // this daemon and the swap in front of us is not its.
    assert.equal(restartingDeploy(), null, `for ${status}`);
  }
});

check('a deploy of something that does not restart beadcause is never attributed one', () => {
  journal([record({ id: 'd', restarts: false })]);
  assert.equal(restartingDeploy(), null);
});

check('a deploy too old to have caused this handover is refused', () => {
  journal([record({ id: 'e', startedAt: iso(600), requestedAt: iso(600) })]);
  assert.equal(restartingDeploy(), null);
  // And the window is a parameter, so the rule is testable rather than a constant nobody
  // can reach: inside it, the same record answers.
  assert.equal(restartingDeploy({ windowMs: 24 * 3600 * 1000 })?.id, 'd-e');
});

check('a record with a stamp in the future is refused, like every other clock we do not trust', () => {
  journal([record({ id: 'f', startedAt: iso(-60), requestedAt: iso(-60) })]);
  assert.equal(restartingDeploy(), null);
});

check('a runner killed before it started is still the deploy that restarted us', () => {
  // `queued` with no `startedAt`: the kickstart landed before the runner got as far as
  // stamping one, and the only clock that record has is when it was asked for.
  journal([record({ id: 'g', status: 'queued', startedAt: null, requestedAt: iso(2) })]);
  assert.equal(restartingDeploy()?.id, 'd-g');
});

check('the newest candidate answers, so the deploy in flight beats the one before it', () => {
  journal([
    record({ id: 'old', status: 'unconfirmed', startedAt: iso(15), requestedAt: iso(15) }),
    record({ id: 'new', status: 'deploying', startedAt: iso(1), requestedAt: iso(1) }),
  ]);
  assert.equal(restartingDeploy()?.id, 'd-new');
});

/* --------------------------------------------------------------- the paperwork */

console.log('\nthe paperwork a state file owes\n');

check('the trail is claimed by the evidence register', () => {
  // test/evidence.mjs fails the repo for a lib/ module that touches CONFIG_DIR and appears
  // in neither list; this asserts which list, because the argument is the point. What
  // shipped is `deployment-record`, and this is one process's observation of the swap.
  const entry = NOT_EVIDENCE.find((e) => e.file === 'lib/handover.js');
  assert.ok(entry, 'lib/handover.js is in neither REGISTER nor NOT_EVIDENCE');
  assert.ok(entry.why.length > 100, 'the exemption costs a reason');
});

check('and it is churn the common repo does not keep', () => {
  // The whole-file rewrite is why: a commit per swap would be the same twenty rows written
  // twenty times over. test/memory.mjs proves the rule reaches a real repo; this proves
  // the rule is still written down where topUpIgnore can find it.
  const src = fs.readFileSync(new URL('../lib/commonrepo.js', import.meta.url), 'utf8');
  assert.match(src, /^handovers\.json$/m);
});

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
