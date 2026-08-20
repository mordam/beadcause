#!/usr/bin/env node
/**
 * A bead blocked on one in a *different* tracker, at the moment the far one closes.
 *
 *     npm test
 *     node test/farblock.mjs
 *
 * bc-bmry.7. bc-bmry.6 named dv-265 as the thing it was waiting on, in prose — `bd dep
 * add` reads both ids from one `BEADS_DIR`, so there was no edge that could ever be
 * written, and the block existed only as a sentence in the description. `bd ready` had
 * no reason to think the bead was anything but ordinary work, so it sat in every queue
 * and the advocate opened an unattended window whose whole job was to read the
 * description and discover it was blocked.
 *
 * The shape under test mirrors test/superseded.mjs, because lib/farblock.js mirrors
 * lib/superseded.js — same two layers:
 *
 *   1. **The filter.** `Bd.ready` must not return a bead carrying the marker, and
 *      `Bd.readyFarBlocked` must return exactly the ones that do — the row check is a
 *      weaker mechanism than `--exclude-label` for the identical reason the supersede
 *      marker is: the far id is inside the label, so there is no fixed string to hand
 *      `--exclude-label`.
 *   2. **The refusal.** `openWorkSession` asks the tracker itself, tested by handing it
 *      the bead directly — the case the filter can never cover.
 *
 * And the one place the shape diverges: there is no question. `sweepFarBlocks` clears
 * the marker itself the moment the far bead closes, rather than raising a card — a
 * far bead closing is a fact, not a judgement, so nobody needs to be asked about it.
 *
 * No iTerm and no real tracker. `bd` is a stub binary that logs its argv and implements
 * `ready` the way bd does — blockers included — mirroring test/superseded.mjs's fixture.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-farblock-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const {
  BLOCK_PREFIX,
  blockLabel,
  parseBlockTarget,
  blockedByFar,
  isBlockedElsewhere,
  assertNotBlockedElsewhere,
  refusal,
  mark,
  sweepFarBlocks,
  describeFarBlocks,
} = await import(LIB('farblock.js'));
const { openWorkSession } = await import(LIB('session.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
const row = (i) => ({
  ...i,
  dependencies: (i.blockedBy || []).map((id) => ({ id, dependency_type: 'blocks', status: (w.issues[id] || {}).status || 'closed', title: (w.issues[id] || {}).title || '' })),
});
const all = () => Object.values(w.issues).map(row);
const blocked = (i) => (i.dependencies || []).some((d) => d.dependency_type === 'blocks' && d.status !== 'closed');

if (args[0] === 'ready') {
  const off = many('--exclude-label');
  const need = many('--label');
  const rows = all()
    .filter((i) => i.status === 'open' && !i.assignee)
    .filter((i) => !blocked(i))
    .filter((i) => !(i.labels || []).some((l) => off.includes(l)))
    .filter((i) => need.every((l) => (i.labels || []).includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([row(issue)]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write(JSON.stringify(w.comments[args[1]] || [])); process.exit(0); }
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (w.comments[args[1]] = w.comments[args[1]] || []).push({ text: args[2] });
  issue.comment_count = w.comments[args[1]].length;
  save();
  process.exit(0);
}
if (args[0] === 'close') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (blocked(row(issue))) die('Error: cannot close ' + args[1] + ': blocked by open issues');
  issue.status = 'closed';
  issue.close_reason = flag('--reason') || '';
  save();
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (args.includes('--status')) issue.status = flag('--status');
  if (args.includes('--status=open')) issue.status = 'open';
  if (args.includes('--assignee')) issue.assignee = flag('--assignee') || '';
  save();
  process.exit(0);
}
if (args[0] === 'label' && (args[1] === 'add' || args[1] === 'remove')) {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.labels = issue.labels || [];
  if (args[1] === 'add') { if (!issue.labels.includes(args[3])) issue.labels.push(args[3]); }
  else {
    if (!issue.labels.includes(args[3])) die('no label ' + args[3] + ' on ' + args[2]);
    issue.labels = issue.labels.filter((l) => l !== args[3]);
  }
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const clearCalls = () => fs.rmSync(BD_LOG, { force: true });

const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: `what ${id} is for`,
  notes: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  blockedBy: [],
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2020-01-01T00:00:00Z',
  ...extra,
});

/**
 * `zz-blocked` (in `ws`, "demo") names `other/zz-far` — a bead a second workspace
 * object points at, sharing this one fake tracker the way test/superseded.mjs's
 * cross-workspace fixtures do. `zz-live` is blocked on a far bead that never closes,
 * to prove the sweep leaves an ordinary block alone. `zz-work` is the control.
 */
const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        comments: {},
        issues: {
          'zz-work': issue('zz-work'),
          'zz-far': issue('zz-far', { title: 'the far bead' }),
          'zz-blocked': issue('zz-blocked', { title: 'waiting on another tracker', labels: [blockLabel('other', 'zz-far')] }),
          'zz-openfar': issue('zz-openfar'),
          'zz-live': issue('zz-live', { labels: [blockLabel('other', 'zz-openfar')] }),
          'zz-ghost': issue('zz-ghost', { labels: [blockLabel('other', 'zz-nope')] }),
        },
      },
      null,
      2
    )
  );
};
reset();

const wsDir = path.join(tmp, 'ws', '.beads');
const otherDir = path.join(tmp, 'other', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(otherDir, { recursive: true });
const ws = { name: 'demo', dir: wsDir };
const other = { name: 'other', dir: otherDir };
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const beadOf = (id) => world().issues[id];
const labelsOf = (id) => beadOf(id).labels;
const closeFar = () => bd.close(ws, 'zz-far', 'Landed in the other tracker');

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

console.log('\na cross-tracker block, cleared the moment the far bead closes\n');

/* ------------------------------------------------------------ the marker itself */

await check('the marker is a prefix and workspace/id — a bare id or free text is not one', () => {
  assert.equal(BLOCK_PREFIX, 'blocked-by:');
  assert.equal(blockLabel('deluvia', 'dv-265'), 'blocked-by:deluvia/dv-265');
  assert.equal(blockedByFar({ labels: ['worker', 'blocked-by:deluvia/dv-265'] }), 'deluvia/dv-265');
  assert.equal(blockedByFar({ labels: [' blocked-by:deluvia/dv-9ai.2 '] }), 'deluvia/dv-9ai.2', 'a subtask is a bead like any other');
  assert.equal(blockedByFar({ labels: ['blocked-by:dv-265'] }), '', 'a bare id is not the accepted shape — see the file header for why');
  assert.equal(
    blockedByFar({ labels: ['blocked-by:the charter amendment'] }),
    '',
    'free text behind the prefix is not a marker — it would hold a bead nothing could ever clear'
  );
  assert.equal(blockedByFar({ labels: ['blocked'] }), '', 'and the bare word is not a prefix match');
  assert.equal(isBlockedElsewhere({ labels: [] }), false);
  assert.equal(isBlockedElsewhere(null), false);
  assert.equal(isBlockedElsewhere({ labels: ['blocked-by:deluvia/dv-265'] }), true);
});

await check('parseBlockTarget accepts workspace/id only when the workspace is known', () => {
  const known = ['beadcause', 'deluvia'];
  assert.deepEqual(parseBlockTarget('deluvia/dv-265', known), { workspace: 'deluvia', id: 'dv-265' });
  assert.deepEqual(parseBlockTarget(' deluvia/dv-9ai.2 ', known), { workspace: 'deluvia', id: 'dv-9ai.2' }, 'trimmed, and a subtask');
  assert.match(parseBlockTarget('sophab/sp-40x', known).reason, /sophab is not a workspace/);
  assert.match(parseBlockTarget('dv-265', known).reason, /is not <workspace>\/<id>/, 'a bare id is refused, unlike the supersede marker');
  assert.match(parseBlockTarget('', known).reason, /is not <workspace>\/<id>/);
});

await check('refusal and assertNotBlockedElsewhere match the shape every other hold uses', () => {
  const err = refusal('zz-blocked', 'other/zz-far');
  assert.equal(err.status, 409);
  assert.equal(err.blockedElsewhere, true);
  assert.equal(err.blockedByFar, 'other/zz-far');
  assert.match(err.message, /other\/zz-far/);

  assert.throws(
    () => assertNotBlockedElsewhere({ id: 'zz-blocked', labels: [blockLabel('other', 'zz-far')] }),
    (e) => e.status === 409 && e.blockedElsewhere === true
  );
  assert.equal(assertNotBlockedElsewhere({ id: 'zz-work', labels: [] }).id, 'zz-work');
});

/* --------------------------------------------------------------- writing the marker */

function syncBd({ refuse = {} } = {}) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv.join(' '));
    for (const [match, message] of Object.entries(refuse)) {
      if (argv.join(' ').includes(match)) throw Object.assign(new Error('Command failed: bd'), { stderr: message });
    }
    return '';
  };
  run.calls = calls;
  return run;
}
const taskRow = (id, extra = {}) => ({ id, status: 'open', issue_type: 'task', labels: [], ...extra });

await check('mark writes the label and nothing else — there is no edge to even attempt', () => {
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'deluvia/dv-265', { row: taskRow('zz-a'), knownWorkspaces: ['deluvia'] });
  assert.equal(out.marked, true);
  assert.equal(out.held, true);
  assert.deepEqual(bdx.calls, ['label add zz-a blocked-by:deluvia/dv-265'], 'no dep call of any kind — no tracker spans both');
});

await check('an unknown workspace refuses before writing anything', () => {
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'sophab/sp-40x', { row: taskRow('zz-a'), knownWorkspaces: ['deluvia'] });
  assert.equal(out.marked, false);
  assert.match(out.refused, /sophab is not a workspace/);
  assert.deepEqual(bdx.calls, []);
});

await check('a bare id refuses before writing anything — this marker is cross-workspace only', () => {
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'dv-265', { row: taskRow('zz-a'), knownWorkspaces: ['deluvia'] });
  assert.equal(out.marked, false);
  assert.match(out.refused, /is not <workspace>\/<id>/);
  assert.deepEqual(bdx.calls, []);
});

await check('a claimed bead is put back to open, because bd ready is open rows only', () => {
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'deluvia/dv-265', { row: taskRow('zz-a', { status: 'in_progress' }), knownWorkspaces: ['deluvia'] });
  assert.equal(out.reopened, true);
  assert.deepEqual(bdx.calls, ['label add zz-a blocked-by:deluvia/dv-265', 'update zz-a --status=open']);
});

await check('marking the same pair twice is a no-op rather than a second label', () => {
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'deluvia/dv-265', {
    row: taskRow('zz-a', { labels: [blockLabel('deluvia', 'dv-265')] }),
    knownWorkspaces: ['deluvia'],
  });
  assert.equal(out.marked, true);
  assert.equal(out.alreadyMarked, true);
  assert.deepEqual(bdx.calls, []);
  assert.match(out.notes.join(' '), /already marked/);
});

await check('a bead already blocked on something else refuses rather than layering a second marker', () => {
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'deluvia/dv-999', {
    row: taskRow('zz-a', { labels: [blockLabel('deluvia', 'dv-265')] }),
    knownWorkspaces: ['deluvia'],
  });
  assert.equal(out.marked, false);
  assert.match(out.refused, /already carries blocked-by:deluvia\/dv-265/);
  assert.deepEqual(bdx.calls, []);
});

await check('everything else it refuses, it refuses before writing anything', () => {
  const cases = [
    ['a missing row', { row: null, knownWorkspaces: ['deluvia'] }, /no bead zz-a here/],
    ['a bead already closed', { row: taskRow('zz-a', { status: 'closed' }), knownWorkspaces: ['deluvia'] }, /already closed/],
  ];
  for (const [name, opts, why] of cases) {
    const bdx = syncBd();
    const out = mark(bdx, 'zz-a', 'deluvia/dv-265', opts);
    assert.equal(out.marked, false, name);
    assert.match(out.refused, why, name);
    assert.deepEqual(bdx.calls, [], `${name}: and nothing was written`);
  }
});

await check('a label bd refuses writes nothing else at all', () => {
  const bdx = syncBd({ refuse: { 'label add': 'Error: no issue found matching "zz-a"' } });
  const out = mark(bdx, 'zz-a', 'deluvia/dv-265', { row: taskRow('zz-a', { status: 'in_progress' }), knownWorkspaces: ['deluvia'] });
  assert.equal(out.marked, false);
  assert.match(out.refused, /could not label zz-a/);
  assert.deepEqual(bdx.calls, ['label add zz-a blocked-by:deluvia/dv-265']);
});

/* --------------------------------------------------------------- layer 1: the filter */

await check('Bd.ready excludes a blocked-by row, and Bd.readyFarBlocked returns exactly it', async () => {
  const readyIds = (await bd.ready(ws)).map((r) => r.id);
  assert.ok(!readyIds.includes('zz-blocked'), 'the marked bead never reaches the ordinary queue');
  assert.ok(!readyIds.includes('zz-live'), 'nor does one whose far bead is still open');
  assert.ok(readyIds.includes('zz-work'), 'the control is unaffected');

  const farBlockedIds = (await bd.readyFarBlocked(ws)).map((r) => r.id);
  assert.deepEqual(new Set(farBlockedIds), new Set(['zz-blocked', 'zz-live', 'zz-ghost']), 'every marked row, whatever its far bead says');
});

/* --------------------------------------------------- layer 2: refused at launch */

await check('openWorkSession refuses the blocked bead handed straight to it', async () => {
  reset();
  const cfg = { sessionDirs: { demo: tmp }, openSessions: true };
  await assert.rejects(
    () => openWorkSession(cfg, ws, { id: 'zz-blocked', title: 'waiting on another tracker' }, { bd }),
    (err) => err.status === 409 && err.blockedElsewhere === true,
    'this is the guarantee — the filter above is only what keeps it from being reached'
  );
});

await check('and it reads the marker off the tracker, not off the row it was handed', async () => {
  const cfg = { sessionDirs: { demo: tmp }, openSessions: true };
  await assert.rejects(
    () => openWorkSession(cfg, ws, { id: 'zz-blocked', title: 'waiting on another tracker', labels: [] }, { bd }),
    (err) => err.blockedElsewhere === true,
    'a caller-supplied row proves nothing about a bead'
  );
});

/* --------------------------------------------------------------------- the sweep */

await check('the sweep clears the marker the moment the far bead closes, and comments why', async () => {
  reset();
  clearCalls();
  await closeFar();
  const result = await sweepFarBlocks(bd, ws, { workspaces: [ws, other] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleared.map((c) => c.id), ['zz-blocked']);
  assert.equal(result.cleared[0].target, 'other/zz-far');
  assert.match(describeFarBlocks(result), /cleared 1 cross-tracker block — zz-blocked \(was blocked on other\/zz-far\)/);

  assert.equal(labelsOf('zz-blocked').includes(blockLabel('other', 'zz-far')), false, 'the marker is off');
  const comments = world().comments['zz-blocked'] || [];
  assert.ok(comments.some((c) => /other\/zz-far has closed/.test(c.text)), 'and the record says why it moved');

  // The label removal is the guarantee — it is what `Bd.ready`'s filter reads — so it
  // must land before the comment, the one write here that may fail harmlessly. (`dep`
  // calls may follow — `bd.comment`'s own mention-linking on the far id in the text —
  // and are not what this is checking.)
  const order = bdCalls()
    .filter((c) => c.includes('zz-blocked') && ['label', 'comment'].includes(c[0]))
    .map((c) => c[0]);
  assert.deepEqual(order, ['label', 'comment'], `write order: ${order.join(', ')}`);

  // zz-live's far bead is still open, so it is not cleared and not skipped-with-a-reason
  // — it is simply not due, and a log line every ten minutes about correct behaviour is noise.
  assert.equal(result.skipped.find((s) => s.id === 'zz-live'), undefined);
  assert.equal(labelsOf('zz-live').length, 1, 'left exactly as it was');

  // zz-ghost names a far bead nobody has — held, and the reason is logged rather than guessed.
  const ghost = result.skipped.find((s) => s.id === 'zz-ghost');
  assert.ok(ghost, `zz-ghost must be reported, got ${JSON.stringify(result.skipped)}`);
  assert.match(ghost.why, /zz-nope/);
  assert.equal(labelsOf('zz-ghost').length, 1, 'a bead that might just be a mid-write is never cleared on a guess');
});

await check('now that it is cleared, the bead is ordinary work again', async () => {
  const readyIds = (await bd.ready(ws)).map((r) => r.id);
  assert.ok(readyIds.includes('zz-blocked'), 'back in the queue with no tap from anyone');
});

await check('a target naming a workspace the sweep was not given is skipped, not guessed at', async () => {
  reset();
  clearCalls();
  await closeFar();
  const result = await sweepFarBlocks(bd, ws, { workspaces: [ws] }); // `other` omitted on purpose
  assert.equal(result.cleared.length, 0);
  assert.ok(result.skipped.some((s) => s.id === 'zz-blocked' && /other/.test(s.why)), 'the unreachable workspace is named in the skip');
  assert.equal(labelsOf('zz-blocked').includes(blockLabel('other', 'zz-far')), true, 'left held rather than cleared on an assumption');
});

await check('omitting workspaces altogether leaves every marker unreadable, not crashed', async () => {
  reset();
  const result = await sweepFarBlocks(bd, ws);
  assert.equal(result.ok, true);
  assert.equal(result.cleared.length, 0);
  assert.ok(result.checked > 0, 'it still walked the marked rows');
  assert.ok(result.skipped.every((s) => /is not a workspace this beadcause knows about/.test(s.why)));
});

reset();

console.log(`\n${ran - failures}/${ran} passed`);
cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
