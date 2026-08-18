#!/usr/bin/env node
/**
 * **The one law** — no agent closes a gate, and no agent closes a bead waiting to be
 * approved.
 *
 *     npm test
 *     node test/onelaw.mjs
 *
 * deluvia's docs/STUDIO_CHARTER.md §2 has said this since it was written, and nothing read
 * it. A gate bead came up ready like anything else, an advocate opened an unattended window
 * on it, and the session ran its ordinary ending — which closes the bead the window was
 * opened for. Delivering dv-b5d on 2026-08-10 closed the epic over six open children, four
 * of them gates, and deluvia's `scripts/studio_status.py` then reported G0 closed and
 * G1/G4 unblocked on a lie. Decided as bc-bmry.2 / dv-vry / dv-8o5: the brief states the
 * law and the code refuses the close, so a brief that drifts cannot reopen the hole.
 *
 * Three failures are worth a file, and the middle one is the expensive one:
 *
 * 1. **Missing a door.** A merge reaches `main` four ways and closes the work bead from
 *    four different places (lib/server.js's tap, lib/mergequeue.js, lib/landed.js's sweep,
 *    bin/deliver.js's own merge) plus lib/owed.js's retry minutes later. A rule wired to
 *    three of them looks broken exactly when Adam happens to merge that way, which is the
 *    hardest kind of report to act on.
 * 2. **Refusing a close Adam asked for.** *The tap is the close* is the other half of the
 *    law, and the phone asks `Bd.gateFor` with no reason before it draws the close button.
 *    A blanket refusal would take that button away and leave a gate nothing on this machine
 *    could ever close — a silent failure, because the card would simply render without it.
 *    So the no-reason case and the `gate:G0` case each get their own assertion.
 * 3. **Retrying forever.** A refusal that is terminal must be dropped from
 *    `owed-closes.json` rather than retried every thirty seconds for the life of the
 *    machine; nothing about waiting turns a merge into an approval.
 *
 * No `bd` binary is run and no window is opened: `Bd.run` is a stub, the merge queue gets
 * the fake tracker test/mergequeue.mjs already uses, and the brief is a pure function.
 * bin/deliver.js is a separate process that cannot be imported, so it is read rather than
 * driven — the same backstop test/land.mjs keeps for the same file.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-onelaw-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { GATE_LABEL, NEEDS_APPROVAL, approvalHold, approvalRefusal, approvalStop } = await import(LIB('approval.js'));
const { Bd } = await import(LIB('bd.js'));
const { oweClose, readOwed, sweepOwed } = await import(LIB('owed.js'));
const { sweepMergeQueue } = await import(LIB('mergequeue.js'));
const { MERGE_LABEL, MERGE_ASSIGNEE, mergeBeadBody } = await import(LIB('mergebead.js'));
const { workPromptFor } = await import(LIB('session.js'));

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

console.log('\nthe one law: no agent closes a gate\n');

/* --------------------------------------------------------------- the predicate */

await check('the bare `gate` label is held, and so is `needs-approval`', () => {
  assert.equal(approvalHold({ labels: ['deluvia-studio', GATE_LABEL] }), GATE_LABEL);
  assert.equal(approvalHold({ labels: [NEEDS_APPROVAL] }), NEEDS_APPROVAL);
});

await check('`gate:G0` is NOT held — it counts towards a gate, it is not one', () => {
  // The distinction the bead was filed with, and the one a `startsWith` would destroy.
  // Every deliverable under a gate carries this, so holding it would stop the whole
  // ladder rather than protecting it.
  assert.equal(approvalHold({ labels: ['gate:G0'] }), '');
  assert.equal(approvalHold({ labels: ['gates', 'gateway', 'needs-approval-soon'] }), '');
});

await check('a bead with no labels at all is not held, and neither is undefined', () => {
  assert.equal(approvalHold({ labels: [] }), '');
  assert.equal(approvalHold({}), '');
  assert.equal(approvalHold(null), '');
});

await check('the refusal names the label and says what to do instead', () => {
  assert.match(approvalRefusal(GATE_LABEL), /`gate`/);
  assert.match(approvalRefusal(GATE_LABEL), /--review/);
  assert.match(approvalRefusal(NEEDS_APPROVAL), /`needs-approval`/);
  assert.match(approvalRefusal(NEEDS_APPROVAL), /--review/);
  // Two different sentences, because they send a reader to two different documents.
  assert.notEqual(approvalRefusal(GATE_LABEL), approvalRefusal(NEEDS_APPROVAL));
});

await check('and it is a rule about the close reason: no merge, no refusal', () => {
  assert.equal(approvalStop({ labels: [GATE_LABEL] }, false), '');
  assert.notEqual(approvalStop({ labels: [GATE_LABEL] }, true), '');
});

/* ------------------------------------------------------------------ the gate */

const WS = { name: 'demo', dir: '/nowhere' };

/** A `Bd` whose `run` answers from a script rather than spawning anything. */
function fakeBd(replies) {
  const bd = new Bd({ bin: '/nonexistent/bd', actor: 'beadcause' });
  bd.calls = [];
  bd.run = async (workspace, args) => {
    bd.calls.push(args.join(' '));
    const reply = replies[args[0]];
    if (reply instanceof Error) throw reply;
    return JSON.stringify(reply ?? []);
  };
  return bd;
}

const issue = (over = {}) => ({
  id: 'dv-1',
  issue_type: 'task',
  status: 'open',
  title: 'G0 canon lock',
  labels: [],
  dependencies: null,
  ...over,
});

const MERGED = 'Landed as #35';

await check('a gate bead is refused a close that carries a merge reason', async () => {
  const bd = fakeBd({ show: [issue({ labels: [GATE_LABEL] })] });
  const gate = await bd.closeGate(WS, 'dv-1', { reason: MERGED });
  assert.equal(gate?.kind, 'approval', JSON.stringify(gate));
  assert.match(gate.reason, /does not close on a merge/);
});

await check('and so is a `needs-approval` bead', async () => {
  const bd = fakeBd({ show: [issue({ labels: [NEEDS_APPROVAL] })] });
  const gate = await bd.closeGate(WS, 'dv-1', { reason: 'Merged #35 as 72789c0b into main on GitHub' });
  assert.equal(gate?.kind, 'approval', JSON.stringify(gate));
});

await check('THE TAP IS STILL THE CLOSE — no reason, no refusal', async () => {
  // The failure this file exists to prevent as much as the other. `/api/questions/:id`
  // asks the gate with no reason to decide whether to draw the close button; a gate that
  // refused here would leave a gate bead nothing on this machine could ever close, and
  // the card would simply render without a button and say nothing.
  const bd = fakeBd({ show: [issue({ labels: [GATE_LABEL] })], list: [] });
  assert.equal(await bd.closeGate(WS, 'dv-1'), null);
  assert.equal(await bd.closeGate(WS, 'dv-1', { reason: 'G0 is met — every blocker in G0_CANON_LOCK.md is cleared' }), null);
});

await check('a `gate:G0` deliverable closes on its merge like anything else', async () => {
  const bd = fakeBd({ show: [issue({ labels: ['gate:G0'] })], list: [] });
  assert.equal(await bd.closeGate(WS, 'dv-1', { reason: MERGED }), null);
});

await check('an ordinary bead is untouched by this', async () => {
  const bd = fakeBd({ show: [issue()], list: [] });
  assert.equal(await bd.closeGate(WS, 'dv-1', { reason: MERGED }), null);
});

await check('the refusal costs no extra `bd` call — it answers off the row it was handed', async () => {
  // Checked before the children branch, which is a `bd list --parent` per gated bead.
  const bd = fakeBd({ show: [issue({ labels: [GATE_LABEL] })] });
  await bd.closeGate(WS, 'dv-1', { reason: MERGED });
  assert.equal(bd.calls.length, 1, bd.calls.join(' | '));
});

await check("an open blocker still outranks it, because that one is bd's own refusal", async () => {
  const bd = fakeBd({
    show: [issue({ labels: [GATE_LABEL], dependencies: [{ id: 'dv-2', status: 'open', dependency_type: 'blocks', title: '' }] })],
  });
  const gate = await bd.closeGate(WS, 'dv-1', { reason: MERGED });
  assert.equal(gate?.kind, 'blocked', JSON.stringify(gate));
});

/* ------------------------------------------------------- the retry, minutes later */

await check('lib/owed.js DROPS an approval refusal rather than retrying it for ever', async () => {
  // The one path that could walk around the rule: it runs with nothing in hand but the
  // stored sentence, and `owed-closes.json` may already hold a record written by a
  // beadcause that had no such rule.
  oweClose({ workspace: 'demo', id: 'dv-1', reason: MERGED, why: 'the tracker was busy' });
  const bd = {
    show: async () => issue({ labels: [GATE_LABEL] }),
    gateFor: async () => ({ kind: 'approval', blockers: [], reason: approvalRefusal(GATE_LABEL) }),
    close: async () => assert.fail('it closed a gate bead on a retry'),
  };
  const out = await sweepOwed(bd, [WS]);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'refused', JSON.stringify(out[0]));
  assert.equal(Object.keys(readOwed()).length, 0, 'the record survived, so it will be retried every thirty seconds');
});

/* ----------------------------------------------------------------- the merge queue */

const SPEC = {
  workspace: 'demo',
  bead: 'dv-1',
  repo: 'acme/widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  branch: 'work-a',
  base: 'main',
  method: 'merge',
};

const mergeBead = () => ({
  id: 'dv-merge',
  title: 'Merge #42 — dv-1',
  status: 'open',
  labels: [MERGE_LABEL],
  assignee: MERGE_ASSIGNEE,
  description: mergeBeadBody(SPEC),
  notes: '',
});

function queueBd(workRow) {
  const calls = { closes: [], comments: [] };
  return {
    calls,
    listAgent: async () => [mergeBead()],
    show: async (ws, id) => (id === 'dv-1' ? workRow : null),
    close: async (ws, id, reason) => calls.closes.push({ id, reason }),
    comment: async (ws, id, text) => calls.comments.push({ id, text }),
    update: async () => {},
  };
}

const fakePr = () => ({
  view: async () => ({ state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', checks: { failed: [], failing: 0, pending: 0, total: 3, state: 'passing' }, reviewDecision: null, mergedAt: null }),
  baseChecks: async () => ({ failed: [] }),
  updateBranch: async () => ({ updated: true, reason: '' }),
  merge: async () => ({ mergeCommit: 'abcdef1234' }),
});

const runQueue = (bd) =>
  sweepMergeQueue(bd, { name: 'demo' }, { resolve: async () => ({ unit: { key: 'demo/widgets' }, dir: '/tmp/widgets', reason: '' }), prApi: fakePr() });

await check('THE MERGE QUEUE MERGES AND LEAVES THE GATE OPEN', async () => {
  const bd = queueBd({ id: 'dv-1', issue_type: 'task', labels: [GATE_LABEL] });
  const out = await runQueue(bd);
  assert.deepEqual(out.merged, ['dv-merge'], 'the merge itself must still happen');
  // The merge bead closes — it is the queue's own bookkeeping and nobody's gate.
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['dv-merge'], JSON.stringify(bd.calls.closes));
  const said = bd.calls.comments.filter((c) => c.id === 'dv-1');
  assert.equal(said.length, 1, JSON.stringify(bd.calls.comments));
  assert.match(said[0].text, /stays \*\*open\*\*/);
  assert.match(said[0].text, /does not close on a merge/);
});

await check('and the same for a `needs-approval` bead', async () => {
  const bd = queueBd({ id: 'dv-1', issue_type: 'task', labels: [NEEDS_APPROVAL] });
  await runQueue(bd);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['dv-merge']);
});

await check('an ordinary work bead still closes, so this is not a blanket hold', async () => {
  const bd = queueBd({ id: 'dv-1', issue_type: 'task', labels: ['gate:G0'] });
  await runQueue(bd);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['dv-merge', 'dv-1'], JSON.stringify(bd.calls.closes));
});

/* ------------------------------------------------------------------ the brief */

const briefFor = (labels) =>
  workPromptFor(
    'deluvia',
    { id: 'dv-1', title: 'G0 canon lock', labels },
    1,
    { base: 'main', deliver: 'beadcause-deliver', land: 'beadcause-deliver', autoMerge: true },
    'Adam'
  );

await check('the brief states the law to a session opened on a gate', () => {
  const brief = briefFor([GATE_LABEL]);
  assert.match(brief, /no agent closes a gate/);
  assert.match(brief, /--review/);
  // The half a refused session most needs: what it is about to see is the work
  // finishing, not a delivery that failed.
  assert.match(brief, /this bead stays open/i);
  assert.match(brief, /nothing to retry/);
  // And the distinction, so it does not read `gate:G0` as the same thing.
  assert.match(brief, /gate:G0/);
});

await check('and to a session opened on a bead waiting to be approved', () => {
  const brief = briefFor([NEEDS_APPROVAL]);
  assert.match(brief, /needs-approval/);
  assert.match(brief, /waiting to be approved/);
});

await check('and says nothing at all to an ordinary session', () => {
  // A paragraph drawn on every brief is one every worker learns to skip.
  const brief = briefFor(['gate:G0', 'deluvia-studio']);
  assert.doesNotMatch(brief, /no agent closes a gate/);
  assert.equal(briefFor(undefined).includes('no agent closes a gate'), false, 'a row with no labels must not throw or draw it');
});

/* ------------------------------------------------- the door that cannot be imported */

await check('bin/deliver.js asks the same rule about its own close', () => {
  // A separate process shelling out to `bd` synchronously: it cannot be imported and it
  // merges before it closes, so this is a read rather than a drive. The end-to-end drive
  // of the real binary is scripts/land-check.mjs (test/landcheck.mjs).
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'deliver.js'), 'utf8');
  assert.match(src, /from '\.\.\/lib\/approval\.js'/, 'deliver.js no longer imports the rule');
  assert.match(src, /approvalStop\(bead, isMergeReason\(closeReason\)\)/, 'the close branch no longer asks it');
});

console.log(`\n${ran - failures}/${ran} ok\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
