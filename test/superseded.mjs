#!/usr/bin/env node
/**
 * A duplicate parked behind its original, at the moment the original lands.
 *
 *     npm test
 *     node test/superseded.mjs
 *
 * The failure this suite is the fix for is a *timing* failure, and the timing is the
 * whole of it. A worker finds two beads describing the same job; closing one is not a
 * worker's call, so it parks the duplicate behind the original and writes "close this as
 * superseded when the original lands" in a comment. Every step of that is correct. Then
 * the original lands — and closing the blocker makes the duplicate `bd ready`, the
 * advocate picks it up, and an unattended session opens on a bead whose own comments say
 * not to work it. bc-e1kv, behind bc-0nea, behind #33.
 *
 * So the interesting assertion here is never "a marked bead is not ready". It is what
 * happens **across the close**: the tests below build the pair, close the original with
 * the same `bd close` that landed #33, and only then ask every layer what it thinks.
 *
 *   1. **The filter.** `Bd.ready` and the advocate's survey must not return the
 *      duplicate the instant it becomes ready. This half is weaker than endorsement's
 *      twin — the marker carries the original's id, so there is no fixed string for
 *      `--exclude-label` and the filter is a row check and nothing else — which is
 *      exactly why the next one matters more here than it does there.
 *   2. **The refusal.** `openWorkSession` asks the tracker itself. Tested by handing it
 *      the bead directly, which is the case a filter can never cover.
 *   3. **The question.** The sweep puts the duplicate in the inbox as a card whose one
 *      tap is the close — checked by parsing the card the way a phone would, because a
 *      card with no options is a question nobody can answer from a notification shade.
 *   4. **The way back.** Answering "not the same job" hands the bead over *and* takes
 *      the marker off, through the real `/api/respond`. A commission that left the
 *      marker on would be a button that did not do what it said.
 *
 * No iTerm and no real tracker. `bd` is a stub binary that logs its argv and implements
 * `ready` the way bd does — blockers included, since "ready" is the event under test.
 * The advocate's launcher is a stub that records rather than launches, and the one test
 * that lets an advocate run unpaused proves the launcher was live by watching it open a
 * session on an ordinary bead in the same tick.
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
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-superseded-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const {
  SUPERSEDE_PREFIX,
  supersedeLabel,
  supersededBy,
  parseSupersedeTarget,
  isSuperseded,
  assertNotSuperseded,
  supersedeAsk,
  sweepSuperseded,
  describeSuperseded,
  release,
  mark,
  edgeFor,
  HOLDING_EDGE,
  RELATED_EDGE,
} = await import(LIB('superseded.js'));
const { openWorkSession, workPromptFor } = await import(LIB('session.js'));
const { toQuestion } = await import(LIB('decision.js'));
const { createAdvocates } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, and a `bd` that reads it.
 *
 * `ready` honours **blockers** as well as `--exclude-label`, and that is what makes this
 * stub worth having: the bug is a bead becoming ready when its blocker closes, so a stub
 * that ignored `blockedBy` would have nothing to demonstrate. Blocker status is resolved
 * at read time from the world rather than copied onto the row, so `bd close` on the
 * original is the only write the tests have to make.
 */
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
// What \`bd show --json\` puts in \`dependencies\`, built from the world so a closed
// blocker is closed everywhere at once.
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
if (args[0] === 'list') {
  const off = many('--exclude-label');
  const parent = flag('--parent');
  let rows = all().filter((i) => i.status !== 'closed');
  if (parent) rows = all().filter((i) => i.id.startsWith(parent + '.'));
  rows = rows.filter((i) => !(i.labels || []).some((l) => off.includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'human' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(all().filter((i) => i.status !== 'closed' && (i.labels || []).includes('human'))));
  process.exit(0);
}
if (args[0] === 'status') {
  const open = all().filter((i) => i.status === 'open');
  process.stdout.write(JSON.stringify({ summary: { open_issues: open.length, ready_issues: open.filter((i) => !i.assignee && !blocked(i)).length, blocked_issues: open.filter(blocked).length, in_progress_issues: 0 } }));
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
  // bd's own gate, because a card that closes a bead has to be closing a closable one.
  if (blocked(row(issue))) die('Error: cannot close ' + args[1] + ': blocked by open issues');
  issue.status = 'closed';
  issue.close_reason = flag('--reason') || '';
  save();
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (args.includes('--append-notes')) issue.notes = [issue.notes, flag('--append-notes')].filter(Boolean).join('\\n');
  if (args.includes('--status')) issue.status = flag('--status');
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
  // Old enough that `settleSeconds` is never the reason a session did not open.
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2020-01-01T00:00:00Z',
  ...extra,
});

/**
 * The pair, twice over, plus the two beads that make the negatives readable.
 *
 * - `zz-dup` behind `zz-orig` — the bc-e1kv case, and every test that matters.
 * - `zz-live` behind `zz-open` — a marked bead whose original has *not* closed. It must
 *   be asked nothing: the marker is doing its job and the question is not due.
 * - `zz-ghost` marked after a bead the tracker does not have. It must be held and left
 *   held, because "mid-write" and "gone" look identical from here.
 * - `zz-work` — ordinary work, the control. Every assertion that something is missing
 *   is worth nothing without a bead that is present.
 */
const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        comments: {},
        issues: {
          'zz-work': issue('zz-work'),
          'zz-orig': issue('zz-orig', { title: 'the original' }),
          'zz-dup': issue('zz-dup', { title: 'the duplicate', blockedBy: ['zz-orig'], labels: [supersedeLabel('zz-orig')] }),
          'zz-open': issue('zz-open'),
          'zz-live': issue('zz-live', { blockedBy: ['zz-open'], labels: [supersedeLabel('zz-open')] }),
          'zz-ghost': issue('zz-ghost', { labels: [supersedeLabel('zz-nope')] }),
        },
      },
      null,
      2
    )
  );
};
reset();

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const ws = { name: 'demo', dir: wsDir };
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const beadOf = (id) => world().issues[id];
const labelsOf = (id) => beadOf(id).labels;
const landOriginal = () => bd.close(ws, 'zz-orig', 'Landed as #33 as abc1234');

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

console.log('\na duplicate does not become work when its original lands\n');

/* ------------------------------------------------------------ the marker itself */

await check('the marker is a prefix and an id, and an id that does not parse is not one', () => {
  assert.equal(SUPERSEDE_PREFIX, 'superseded-by:');
  assert.equal(supersedeLabel('bc-0nea'), 'superseded-by:bc-0nea');
  assert.equal(supersededBy({ labels: ['worker', 'superseded-by:bc-0nea'] }), 'bc-0nea');
  assert.equal(supersededBy({ labels: [' superseded-by:bc-3zo9.2 '] }), 'bc-3zo9.2', 'a subtask is a bead like any other');
  assert.equal(
    supersededBy({ labels: ['superseded-by:the one about the router'] }),
    '',
    'free text behind the prefix is not a marker — it would hold a bead nothing could ever ask about'
  );
  assert.equal(supersededBy({ labels: ['superseded'] }), '', 'and the bare word is not a prefix match');
  assert.equal(isSuperseded({ labels: [] }), false);
  assert.equal(isSuperseded(null), false);
});

/* --------------------------------- the other shape a target may take (bc-xl7n.71) */

await check('a bare id means "here" — every marker written before this kept its meaning', () => {
  assert.deepEqual(parseSupersedeTarget('bc-0nea'), { workspace: '', id: 'bc-0nea' });
  assert.deepEqual(parseSupersedeTarget(' bc-3zo9.2 '), { workspace: '', id: 'bc-3zo9.2' }, 'a subtask, and it is trimmed');
});

await check('workspace/id is accepted only when the workspace is on the whitelist', () => {
  const known = ['beadcause', 'deluvia'];
  assert.deepEqual(parseSupersedeTarget('beadcause/bc-jznr', known), { workspace: 'beadcause', id: 'bc-jznr' });
  const unknown = parseSupersedeTarget('sophab/sp-40x', known);
  assert.equal(unknown.workspace, '');
  assert.match(unknown.reason, /sophab is not a workspace/);
  // Not a pattern check that happens to pass without a list — omitting the list refuses
  // a qualified target outright, exactly as an unknown name would.
  const noList = parseSupersedeTarget('beadcause/bc-jznr');
  assert.match(noList.reason, /beadcause is not a workspace/);
});

await check('neither shape at all is the same refusal a bare non-id always got', () => {
  const junk = parseSupersedeTarget('the one about the router', ['beadcause']);
  assert.match(junk.reason, /is not a bead id/);
});

await check('supersededBy hands the qualified string straight back — parseSupersedeTarget splits it, not this', () => {
  assert.equal(supersededBy({ labels: ['superseded-by:beadcause/bc-jznr'] }), 'beadcause/bc-jznr');
});

/* ----------------------------------------- layer 1: across the close, out of the queue */

await check('while the original is open the duplicate is blocked — nothing is being tested yet', async () => {
  reset();
  const rows = await bd.ready(ws);
  assert.equal(rows.find((r) => r.id === 'zz-dup'), undefined, 'bd itself keeps it out; the marker has not been asked');
});

await check('**the moment the original closes**, bd calls the duplicate ready and Bd.ready does not', async () => {
  reset();
  await landOriginal();
  // What bd thinks, unfiltered — this is the queue the advocate used to be handed, and
  // asserting it is what makes the next line mean something.
  const raw = await bd.json(ws, ['ready', '--limit', '0']);
  assert.ok(
    raw.some((r) => r.id === 'zz-dup'),
    'the whole bug: closing the blocker makes the duplicate ready as far as the tracker is concerned'
  );
  const rows = await bd.ready(ws);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['zz-open', 'zz-work'], 'and it is out of ours');
});

await check('a bd that ignored every flag would still not get it into the queue', async () => {
  // The filter has to be the row check, because the marker carries an id: there is no
  // fixed string to hand `--exclude-label`, so a stub tracker cannot be trusted to help.
  const deaf = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  deaf.json = async () => [issue('zz-work'), issue('zz-dup', { labels: [supersedeLabel('zz-orig')] })];
  const rows = await deaf.ready(ws);
  assert.deepEqual(rows.map((r) => r.id), ['zz-work']);
});

await check('readySuperseded is the other side of the same fact, and skips what is already asked', async () => {
  reset();
  await landOriginal();
  const rows = await bd.readySuperseded(ws);
  // zz-live is still blocked and zz-ghost is not; both are marked, and only the ready
  // ones are the sweep's business.
  assert.deepEqual(rows.map((r) => r.id).sort(), ['zz-dup', 'zz-ghost']);
  const call = bdCalls().reverse().find((c) => c[0] === 'ready');
  assert.ok(call.includes('--exclude-label') && call.includes('human'), `the inbox is excluded on the command line, got ${call.join(' ')}`);
});

await check("the advocate's queue and the head of it never name the duplicate", async () => {
  reset();
  await landOriginal();
  const cfg = {
    workspaces: [ws],
    spaces: [],
    claudeSessions: false,
    pr: { enabled: false },
    // The sweep off, so this test asserts the queue and writes nothing to the tracker.
    advocates: { enabled: true, workspaces: ['*'], propose: false, tidyWorktrees: false, askSuperseded: false },
  };
  const advocates = createAdvocates(cfg, { bd, bus: { emit() {} } });
  await advocates.control('demo', 'pause');
  await advocates.tick();
  const card = advocates.snapshot().find((a) => a.workspace === 'demo');
  // zz-work and zz-open, and neither zz-dup nor zz-ghost: the two marked beads that bd
  // itself would have handed over are the whole of the difference.
  assert.equal(card.queue, 2, `only the unmarked beads are work, got ${card.queue}`);
  assert.match(card.note || '', /\b2 ready\b/, 'and "N ready" on the card is that same number');
});

/* --------------------------------------------------- layer 2: refused at launch */

await check('the gate refuses a marked bead and passes an unmarked one', () => {
  assert.throws(
    () => assertNotSuperseded({ id: 'zz-dup', labels: [supersedeLabel('zz-orig')] }),
    (err) => err.status === 409 && err.superseded === true && /zz-orig/.test(err.message)
  );
  assert.equal(assertNotSuperseded({ id: 'zz-work', labels: [] }).id, 'zz-work');
});

await check('openWorkSession refuses the duplicate handed straight to it', async () => {
  reset();
  await landOriginal();
  // sessionDirs is deliberately real: a refusal that only happened because the directory
  // was missing would prove nothing about the marker.
  const cfg = { sessionDirs: { demo: tmp }, openSessions: true };
  await assert.rejects(
    () => openWorkSession(cfg, ws, { id: 'zz-dup', title: 'the duplicate' }, { bd }),
    (err) => err.status === 409 && err.superseded === true,
    'this is the guarantee — the filter above is only what keeps it from being reached'
  );
});

await check('and it reads the marker off the tracker, not off the row it was handed', async () => {
  const cfg = { sessionDirs: { demo: tmp }, openSessions: true };
  await assert.rejects(
    () => openWorkSession(cfg, ws, { id: 'zz-dup', title: 'the duplicate', labels: [] }, { bd }),
    (err) => err.superseded === true,
    'a caller-supplied row proves nothing about a bead'
  );
});

/* ------------------------------------------------- layer 3: it arrives as a question */

await check('the sweep asks about the duplicate, and about nothing else', async () => {
  reset();
  await landOriginal();
  const result = await sweepSuperseded(bd, ws);
  assert.equal(result.ok, true);
  assert.deepEqual(result.asked.map((a) => a.id), ['zz-dup']);
  assert.equal(result.asked[0].original, 'zz-orig');
  assert.match(describeSuperseded(result), /zz-dup \(superseded by zz-orig\)/);

  // zz-live's original is still open, so it is not skipped-with-a-reason — it is simply
  // not due, and a log line every ten minutes about a bead behaving correctly is noise.
  assert.equal(result.skipped.find((s) => s.id === 'zz-live'), undefined);
  assert.equal(beadOf('zz-live').labels.includes('human'), false);

  // zz-ghost names a bead the tracker does not have. Held, and said out loud, because a
  // bead this cannot ask about is a bead nothing will ever ask about again.
  const ghost = result.skipped.find((s) => s.id === 'zz-ghost');
  assert.ok(ghost, `zz-ghost must be reported, got ${JSON.stringify(result.skipped)}`);
  assert.match(ghost.why, /zz-nope/);
  assert.equal(beadOf('zz-ghost').labels.includes('human'), false, 'and no card claiming its original is gone');
});

await check('what it writes: the record on the thread, the ask in the notes, the inbox last', async () => {
  const dup = beadOf('zz-dup');
  assert.ok(dup.labels.includes('human'), 'it is in the inbox');
  assert.ok(dup.labels.includes(supersedeLabel('zz-orig')), 'and still marked — answering is what takes that off');
  assert.match(dup.notes, /Close zz-dup as superseded by zz-orig\?/, 'the ask went into the notes');
  assert.match(dup.description, /what zz-dup is for/, 'and the description it arrived with is untouched');
  assert.equal(world().comments['zz-dup'].length, 1, 'one comment, saying the original closed');
  assert.match(world().comments['zz-dup'][0].text, /zz-orig has closed/);

  const order = bdCalls().filter((c) => c[1] === 'zz-dup' || c[2] === 'zz-dup').map((c) => `${c[0]} ${c[1]}`);
  assert.equal(
    order.indexOf('update zz-dup') < order.indexOf('label add'),
    true,
    `the options are written before the card exists, got ${order.join(' | ')}`
  );
});

await check('and the card parses on a phone: two options, one of which does not close', async () => {
  // Read exactly as lib/server.js reads it. A card whose block did not parse would be a
  // question with an empty answer box, which is the failure this suite is meant to end.
  const q = toQuestion('demo', beadOf('zz-dup'));
  assert.deepEqual(q.errors, [], `the decision block must parse — ${q.errors.join('; ')}`);
  assert.deepEqual(q.decision.options.map((o) => o.id), ['close', 'keep']);
  assert.equal(q.decision.options[0].closes, true);
  assert.equal(q.decision.options[0].recommended, true, 'the close is the recommendation, because it usually is');
  assert.equal(q.decision.options[1].closes, false, 'keeping it must not file the work as finished');
  assert.match(q.question, /Close zz-dup as superseded by zz-orig\?/);
  assert.match(q.sections.map((s) => s.markdown).join('\n'), /zz-orig is closed/);
});

await check('it does not ask twice — a bead in the inbox is out of the sweep', async () => {
  clearCalls();
  const again = await sweepSuperseded(bd, ws);
  assert.deepEqual(again.asked, []);
  assert.equal(world().comments['zz-dup'].length, 1, 'and no second comment on the thread');
});

await check('nor after a write that half-failed', async () => {
  // The one gap `--exclude-label human` cannot cover: the notes were written and the
  // label was not. Without the fingerprint in the notes this asks again every ten
  // minutes, for ever.
  reset();
  await landOriginal();
  const halfway = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  halfway.addLabel = async () => {
    throw new Error('bd: database is locked');
  };
  const first = await sweepSuperseded(halfway, ws);
  assert.deepEqual(first.asked, [], 'the ask did not complete');
  assert.match(first.skipped.find((s) => s.id === 'zz-dup').why, /could not put it in the inbox/);
  assert.match(beadOf('zz-dup').notes, /Close zz-dup as superseded/, 'but the notes carry it');
  assert.equal(beadOf('zz-dup').labels.includes('human'), false);

  const second = await sweepSuperseded(bd, ws);
  assert.deepEqual(second.asked, [], 'and the retry recognises its own work');
  assert.match(second.skipped.find((s) => s.id === 'zz-dup').why, /already carries the ask/);
  assert.equal(world().comments['zz-dup'].length, 1, 'one comment across both attempts');
});

await check('a tracker that will not answer is a returned sentence, not a thrown tick', async () => {
  const broken = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  broken.readySuperseded = async () => {
    throw new Error('bd: database is locked\nand more');
  };
  const result = await sweepSuperseded(broken, ws);
  assert.equal(result.ok, false);
  assert.match(describeSuperseded(result), /superseded sweep skipped — could not read the ready queue/);
  assert.deepEqual(result.asked, []);
});

/* --------------------------------- the whole of it: one advocate tick across the close */

await check('the advocate asks about the duplicate instead of opening a session on it', async () => {
  reset();
  await landOriginal();
  const opened = [];
  const cfg = {
    workspaces: [ws],
    spaces: [],
    claudeSessions: false,
    pr: { enabled: false },
    advocates: {
      enabled: true,
      workspaces: ['*'],
      propose: false,
      tidyWorktrees: false,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
    },
  };
  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, bead) => {
      opened.push(bead.id);
      return { dir: tmp, mode: 'test', term: null };
    },
  });
  // Deliberately *not* paused — and resumed explicitly, because the pause an earlier
  // test set is in `advocates.json` and survives a fresh `createAdvocates`. An advocate
  // that opens nothing because it was told to open nothing proves nothing at all, so the
  // launcher is live and the ordinary beads are the control that shows it.
  await advocates.control('demo', 'resume');
  await advocates.tick();

  assert.equal(opened.includes('zz-dup'), false, `no session on the duplicate, got ${opened.join(', ')}`);
  assert.ok(opened.length, 'and the launcher was live — an ordinary bead was opened in the same tick');
  assert.ok(beadOf('zz-dup').labels.includes('human'), 'the duplicate went to the inbox in the same tick');
  const card = advocates.snapshot().find((a) => a.workspace === 'demo');
  assert.equal(card.superseded.asked, 1, 'and the sweep is on the advocate card, not only in the log');
});

/* ------------------------------------------ layer 4: the answer that hands it back */

await check('the brief tells a worker to mark a duplicate rather than write it in a comment', () => {
  // The other half of the fix, and the half that decides whether any of the above is
  // ever reached: nothing sets this marker but a worker, and a worker only knows to set
  // it because the brief says so. Since bc-28ef it is one command rather than two lines
  // typed by hand, because two of the three writes had a wrong version that reads as
  // success — see the `mark` section below.
  const prompt = workPromptFor('demo', { id: 'zz-1', title: 'a bead' }, 1, null, 'Adam');
  assert.match(prompt, /bin\/supersede\.js -w demo -b zz-1 --original <the-original>/);
  assert.match(prompt, /superseded-by:<the-original>/);
  assert.doesNotMatch(prompt, /bd dep add zz-1 <the-original>/, 'and not the by-hand version it replaced');
});

await check('release takes the marker off, and is a no-op on a bead that never had one', async () => {
  reset();
  assert.deepEqual(await release(bd, ws, 'zz-work'), { released: false, id: 'zz-work' });
  const out = await release(bd, ws, 'zz-dup');
  assert.equal(out.released, true);
  assert.equal(out.supersededBy, 'zz-orig');
  assert.deepEqual(labelsOf('zz-dup'), [], 'and only that label');
  assert.deepEqual(await release(bd, ws, 'zz-dup'), { released: false, id: 'zz-dup' }, 'idempotent');
});

/* ------------------------------------------ putting the marker on: `mark` (bc-28ef) */

/**
 * A synchronous `bd`, the shape bin/supersede.js hands `mark` — argv in, stdout out,
 * throw on refusal. Small on purpose: the writes under test are three, and a fake that
 * modelled the whole tracker would be asserting its own behaviour rather than `mark`'s.
 *
 * `refuse` is how the two failures that matter are staged: bd turning down a `blocks`
 * edge across the epic boundary, and bd turning down any edge at all on a pair that
 * already has one.
 */
function syncBd({ refuse = {} } = {}) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv.join(' '));
    for (const [match, message] of Object.entries(refuse)) {
      if (argv.join(' ').includes(match)) {
        throw Object.assign(new Error('Command failed: bd'), { stderr: message });
      }
    }
    return '';
  };
  run.calls = calls;
  return run;
}

const taskRow = (id, extra = {}) => ({ id, status: 'open', issue_type: 'task', labels: [], ...extra });
const epicRow = (id, extra = {}) => ({ id, status: 'open', issue_type: 'epic', labels: [], ...extra });

await check('edgeFor is the whole rule: an epic gets a see-also, everything else gets the hold', () => {
  assert.equal(edgeFor('task'), HOLDING_EDGE);
  assert.equal(edgeFor('bug'), HOLDING_EDGE);
  assert.equal(edgeFor(''), HOLDING_EDGE, 'an unreadable type is guessed as a task, as questionType does');
  assert.equal(edgeFor('EPIC'), RELATED_EDGE);
  assert.equal(edgeFor('epic'), RELATED_EDGE);
});

await check('an ordinary original: the label, the blocking edge, and nothing else', () => {
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'zz-b', { dupRow: taskRow('zz-a'), originalRow: taskRow('zz-b') });
  assert.equal(out.marked, true);
  assert.equal(out.held, true, 'a blocking edge really does hold it out of bd ready');
  assert.equal(out.edge, HOLDING_EDGE);
  assert.deepEqual(bdx.calls, ['label add zz-a superseded-by:zz-b', 'dep add zz-a zz-b']);
  assert.deepEqual(out.notes, []);
});

await check('an epic original: the edge bd refuses is never attempted, and the swap is said out loud', () => {
  // The bug. `bd dep add <task> <epic>` is refused, so what used to happen was a label
  // and no edge at all — the relationship recorded nowhere the graph could see it.
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'zz-e', { dupRow: taskRow('zz-a'), originalRow: epicRow('zz-e') });
  assert.equal(out.marked, true);
  assert.equal(out.edge, RELATED_EDGE);
  assert.deepEqual(bdx.calls, ['label add zz-a superseded-by:zz-e', 'dep relate zz-a zz-e']);
  assert.equal(out.held, false, 'and it does not claim a hold it has not got');
  assert.match(out.notes.join(' '), /epic/);
  assert.match(out.notes.join(' '), /out of every queue by the marker/);
});

await check('a workspace-qualified original: no edge attempted at all — no graph spans two trackers', () => {
  // bc-xl7n.71. Unlike the epic case above, `bd` is never even asked — there is no `dep`
  // call to refuse, because the two beads are not in the same tracker.
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'beadcause/bc-jznr', {
    dupRow: taskRow('zz-a'),
    originalRow: taskRow('bc-jznr'),
    knownWorkspaces: ['beadcause'],
  });
  assert.equal(out.marked, true);
  assert.equal(out.edge, '', 'no edge type at all — not even an attempt');
  assert.equal(out.held, false);
  assert.deepEqual(bdx.calls, ['label add zz-a superseded-by:beadcause/bc-jznr'], 'no dep call of any kind');
  assert.match(out.notes.join(' '), /different tracker/);
  assert.match(out.notes.join(' '), /out of every queue by the marker rather than by the graph/);
});

await check('an unknown workspace in --original refuses before writing anything', () => {
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'sophab/sp-40x', {
    dupRow: taskRow('zz-a'),
    originalRow: taskRow('sp-40x'),
    knownWorkspaces: ['beadcause', 'deluvia'],
  });
  assert.equal(out.marked, false);
  assert.match(out.refused, /sophab is not a workspace/);
  assert.deepEqual(bdx.calls, [], 'nothing was written');
});

await check('a claimed bead is put back to open, because bd ready is open rows only', () => {
  // The write nobody remembers. A worker reaches this having claimed its own bead, and a
  // marked bead left in_progress is invisible to readySuperseded forever: held, with
  // nobody ever asked. The order matters as much as the write — the label first, so a
  // failure after it leaves the bead held rather than released and unmarked.
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'zz-b', {
    dupRow: taskRow('zz-a', { status: 'in_progress' }),
    originalRow: taskRow('zz-b'),
  });
  assert.equal(out.reopened, true);
  assert.deepEqual(bdx.calls, ['label add zz-a superseded-by:zz-b', 'update zz-a --status=open', 'dep add zz-a zz-b']);
});

await check('it never writes the `human` label, which is the write that would kill the card', () => {
  const bdx = syncBd();
  mark(bdx, 'zz-a', 'zz-e', { dupRow: taskRow('zz-a', { status: 'in_progress' }), originalRow: epicRow('zz-e') });
  assert.equal(
    bdx.calls.some((c) => /label add \S+ human/.test(c)),
    false,
    'readySuperseded excludes the inbox by that label — adding it by hand prevents the card for good'
  );
});

await check('a pair that already has an edge keeps it: provenance is not traded for a link', () => {
  const bdx = syncBd({ refuse: { 'dep add': 'Error: dependency zz-a -> zz-b already exists with type "discovered-from"' } });
  const out = mark(bdx, 'zz-a', 'zz-b', { dupRow: taskRow('zz-a'), originalRow: taskRow('zz-b') });
  assert.equal(out.marked, true, 'the half that holds it landed');
  assert.equal(out.held, false, 'and it says the hold did not');
  assert.match(out.notes.join(' '), /already have an edge/);
});

await check('an edge bd refuses for any other reason is reported, and the marker still stands', () => {
  const bdx = syncBd({ refuse: { 'dep add': 'Error: cycle detected' } });
  const out = mark(bdx, 'zz-a', 'zz-b', { dupRow: taskRow('zz-a'), originalRow: taskRow('zz-b') });
  assert.equal(out.marked, true);
  assert.match(out.notes.join(' '), /cycle detected/);
  assert.match(out.notes.join(' '), /which is the half that holds it/);
});

await check('a label bd refuses writes nothing else at all', () => {
  // The inverse of the order above: if the guarantee did not land, releasing the bead
  // back to `open` would hand it to the next advocate tick as ordinary work.
  const bdx = syncBd({ refuse: { 'label add': 'Error: no issue found matching "zz-a"' } });
  const out = mark(bdx, 'zz-a', 'zz-b', {
    dupRow: taskRow('zz-a', { status: 'in_progress' }),
    originalRow: taskRow('zz-b'),
  });
  assert.equal(out.marked, false);
  assert.match(out.refused, /could not label zz-a/);
  assert.deepEqual(bdx.calls, ['label add zz-a superseded-by:zz-b']);
});

await check('everything it refuses, it refuses before writing anything', () => {
  const cases = [
    ['a missing original', { dupRow: taskRow('zz-a'), originalRow: null }, /no bead zz-b here/],
    ['a missing duplicate', { dupRow: null, originalRow: taskRow('zz-b') }, /no bead zz-a here/],
    ['a duplicate already closed', { dupRow: taskRow('zz-a', { status: 'closed' }), originalRow: taskRow('zz-b') }, /already closed/],
    [
      'a duplicate already marked after something else',
      { dupRow: taskRow('zz-a', { labels: [supersedeLabel('zz-c')] }), originalRow: taskRow('zz-b') },
      /already carries superseded-by:zz-c/,
    ],
  ];
  for (const [name, rows, why] of cases) {
    const bdx = syncBd();
    const out = mark(bdx, 'zz-a', 'zz-b', rows);
    assert.equal(out.marked, false, name);
    assert.match(out.refused, why, name);
    assert.deepEqual(bdx.calls, [], `${name}: and nothing was written`);
  }

  const self = syncBd();
  assert.match(mark(self, 'zz-a', 'zz-a', { dupRow: taskRow('zz-a'), originalRow: taskRow('zz-a') }).refused, /itself/);
  const junk = syncBd();
  assert.match(
    mark(junk, 'zz-a', 'the one about the router', { dupRow: taskRow('zz-a'), originalRow: taskRow('zz-b') }).refused,
    /is not a bead id/
  );
  assert.deepEqual([...self.calls, ...junk.calls], []);
});

await check('marking the same pair twice is a no-op rather than a second label', () => {
  const bdx = syncBd();
  const out = mark(bdx, 'zz-a', 'zz-b', {
    dupRow: taskRow('zz-a', { labels: [supersedeLabel('zz-b')] }),
    originalRow: taskRow('zz-b'),
  });
  assert.equal(out.marked, true);
  assert.equal(out.alreadyMarked, true, 'and says so, because nothing else it returns means anything on a re-run');
  assert.deepEqual(bdx.calls, []);
  assert.match(out.notes.join(' '), /already marked/);
});

await check('and a bead marked with no holding edge is still asked about at the right moment', async () => {
  // The consequence of the epic case, and the reason it is survivable: the sweep reads
  // the original's status rather than trusting the queue, so a duplicate that is ready
  // the whole time is swept over in silence until the original actually closes. Without
  // this the fix above would trade a missing edge for a card raised weeks early.
  fs.writeFileSync(
    WORLD,
    JSON.stringify({
      comments: {},
      issues: {
        'zz-epic': issue('zz-epic', { issue_type: 'epic', title: 'the epic that adopted it' }),
        // No blockedBy at all — bd would have refused the edge, which is the whole bug.
        'zz-adopted': issue('zz-adopted', { labels: [supersedeLabel('zz-epic')] }),
      },
    })
  );
  assert.ok(
    (await bd.readySuperseded(ws)).some((r) => r.id === 'zz-adopted'),
    'it is in the sweep list from the moment it is marked, which is what the missing edge costs'
  );
  assert.deepEqual((await sweepSuperseded(bd, ws)).asked, [], 'and it is asked nothing while the epic is open');

  await bd.close(ws, 'zz-epic', 'Merged #999');
  assert.deepEqual(
    (await sweepSuperseded(bd, ws)).asked.map((a) => a.id),
    ['zz-adopted'],
    'and asked the moment it closes, exactly as a blocked one would be'
  );
  reset();
});

/* ------------------------------------------------ cross-workspace sweep (bc-xl7n.71) */

await check('sweepSuperseded reads a qualified original from its own workspace, not the one being swept', async () => {
  // zz-cross lives in `ws` ("demo"); its original is named `other/zz-remote` — a
  // workspace `ws`'s own tracker has never heard of. `workspaces` is what lets the
  // sweep resolve `other` to a `{ name, dir }` and read its status from there.
  fs.writeFileSync(
    WORLD,
    JSON.stringify({
      comments: {},
      issues: {
        'zz-remote': issue('zz-remote', { title: 'the original, in another tracker' }),
        'zz-cross': issue('zz-cross', { labels: [supersedeLabel('other/zz-remote')] }),
      },
    })
  );
  const otherDir = path.join(tmp, 'other-ws', '.beads');
  fs.mkdirSync(otherDir, { recursive: true });
  const other = { name: 'other', dir: otherDir };

  assert.ok(
    (await bd.readySuperseded(ws)).some((r) => r.id === 'zz-cross'),
    'it is in the sweep list — the row check parses a qualified label same as a bare one'
  );
  assert.deepEqual(
    (await sweepSuperseded(bd, ws, { workspaces: [ws, other] })).asked,
    [],
    'and asked nothing while the original is open'
  );

  await bd.close(other, 'zz-remote', 'Landed elsewhere');
  const result = await sweepSuperseded(bd, ws, { workspaces: [ws, other] });
  assert.deepEqual(result.asked.map((a) => a.id), ['zz-cross'], 'asked the moment the ORIGINAL tracker shows it closed');
  reset();
});

await check('a workspace named on the label but not in `workspaces` is skipped and logged, not thrown', async () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify({
      comments: {},
      issues: { 'zz-nowhere': issue('zz-nowhere', { labels: [supersedeLabel('nosuchws/zz-1')] }) },
    })
  );
  const result = await sweepSuperseded(bd, ws, { workspaces: [ws] });
  assert.deepEqual(result.asked, []);
  const skip = result.skipped.find((s) => s.id === 'zz-nowhere');
  assert.ok(skip, `skipped: ${JSON.stringify(result.skipped)}`);
  assert.match(skip.why, /nosuchws is not a workspace/);
  reset();
});

await check('omitting `workspaces` altogether leaves a qualified marker unreadable, not crashed', async () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify({
      comments: {},
      issues: { 'zz-nowhere': issue('zz-nowhere', { labels: [supersedeLabel('other/zz-remote')] }) },
    })
  );
  const result = await sweepSuperseded(bd, ws);
  assert.deepEqual(result.asked, []);
  assert.ok(result.skipped.find((s) => s.id === 'zz-nowhere'));
  reset();
});

/* ----------------------------------- the real endpoint, over a real socket, one tap */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  host: '127.0.0.1',
  port: 0,
  baseUrl: '',
  token: 'superseded-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [ws],
  sessionDirs: { demo: path.join(tmp, 'no-such-checkout') },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);
// createApp and listen hold this object, so the two fields that could only be
// filled in once the kernel had chosen are filled in here, before the first call.
cfg.port = port;
cfg.baseUrl = `http://127.0.0.1:${port}`;

const post = (pathname, body) =>
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

/** The bead as the sweep leaves it: in the inbox, marked, carrying its two options. */
const asked = async () => {
  reset();
  await landOriginal();
  await sweepSuperseded(bd, ws);
};

await check('tapping "close it" closes the duplicate — the tap is the close', async () => {
  await asked();
  const res = await post('/api/respond', {
    workspace: 'demo',
    id: 'zz-dup',
    option: 'close',
    response: 'Superseded by zz-orig, which is closed.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.closed, true);
  assert.equal(beadOf('zz-dup').status, 'closed', 'no session, no second window, no worker deriving this again');
});

await check('tapping "not the same job" hands it back AND takes the marker off', async () => {
  await asked();
  const res = await post('/api/respond', {
    workspace: 'demo',
    id: 'zz-dup',
    option: 'keep',
    response: 'Not a duplicate after all.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.handedBack, true);
  const dup = beadOf('zz-dup');
  assert.equal(dup.status, 'open', 'a commission does not close');
  assert.equal(dup.labels.includes('human'), false, 'and it is out of the inbox');
  assert.equal(
    isSuperseded(dup),
    false,
    'the marker is gone — a handover that left it on would be a button that did not do what it said'
  );
});

await check('and the bead it handed back really is workable again — both layers agree', async () => {
  // The pair that matters: it is in the queue *and* the gate lets it through. Checking
  // either alone would miss a handover that only half worked.
  //
  // The gate rather than `openWorkSession`, deliberately: that function ends in
  // AppleScript, and a suite that asserted it *succeeds* would open a real iTerm window
  // on a temp directory. Every other test here can call it because every other test
  // expects it to refuse before it gets that far.
  const rows = await bd.ready(ws);
  assert.ok(rows.some((r) => r.id === 'zz-dup'), 'in the queue');
  assert.equal(assertNotSuperseded(await bd.show(ws, 'zz-dup')).id, 'zz-dup', 'and past the gate');
});

await check('an ordinary answer costs no label read at all', async () => {
  reset();
  clearCalls();
  await post('/api/respond', { workspace: 'demo', id: 'zz-work', response: 'done' });
  assert.equal(
    bdCalls().filter((c) => c[0] === 'label').length,
    0,
    'every question in the inbox goes through here — the common path must stay free'
  );
});

/* -------------------------------------------------------------------- the result */

console.log(`\n${ran - failures}/${ran} passed\n`);
for (const s of servers || []) s.close?.();
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
