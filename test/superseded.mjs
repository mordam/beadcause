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
  isSuperseded,
  assertNotSuperseded,
  supersedeAsk,
  sweepSuperseded,
  describeSuperseded,
  release,
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
  // it because the brief says so.
  const prompt = workPromptFor('demo', { id: 'zz-1', title: 'a bead' }, 1, null, 'Adam');
  assert.match(prompt, /bd label add zz-1 superseded-by:<the-original>/);
  assert.match(prompt, /bd dep add zz-1 <the-original>/);
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
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
