#!/usr/bin/env node
/**
 * An epic whose children have all closed, at the moment the last one does.
 *
 *     npm test
 *     node test/finishedepic.mjs
 *
 * bc-xl7n.74. `batchesFor` (lib/advocate.js) skips an epic with fewer ready children than
 * `minBatchBeads`, and zero is always fewer — so an epic whose children have all closed
 * falls through to ordinary dispatch, and a worker window opens on a bead with no diff
 * left to deliver. bc-xl7n.8 is the worked example: 3/3 children closed, and the advocate
 * opened a worker on it anyway.
 *
 * The interesting assertion here, as in test/superseded.mjs, is across the *event*: the
 * tests below close an epic's last child with the same `bd close` that would land it, and
 * only then ask what the sweep, the queue and a live advocate tick think.
 *
 * No iTerm and no real tracker. `bd` is a stub binary that logs its argv and implements
 * `ready`, `list --parent`, `list --label` and `close` the way bd does. The advocate's
 * launcher is a stub that records rather than launches, and one test runs the advocate
 * with the sweep turned off to show the failure this fixes really would fire without it.
 *
 * ## And the second question — bc-jvt0.5
 *
 * The half below `the epic that was worked as one job` is about the other way an epic
 * finishes: bc-jvt0.4 let an advocate decide a childless epic does not want splitting and
 * dispatch it as itself, and nothing then closed it. `epicStaysOpen` leaves it open *and
 * claimed* over its own merge, so it is not in `bd ready` and the sweep above never sees
 * it; it has no children, so "every child closed" is not a fact anything could establish
 * about it. That half is keyed on the `whole-job` label and on git, and there is a **real
 * git repository** under `tmp/repo` for it — merged, unmerged, and an unstarted worktree
 * branch, which is the case that makes `landingMerge`'s second-parent rule necessary
 * rather than decorative.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-finishedepic-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const {
  alreadyAsked,
  finishedEpicComment,
  finishedEpicAsk,
  sweepFinishedEpics,
  describeFinishedEpics,
  sweepWholeEpics,
  describeWholeEpics,
  wholeEpicAsk,
  wholeEpicComment,
} = await import(LIB('finishedepic.js'));
const { toQuestion } = await import(LIB('decision.js'));
const { createAdvocates } = await import(LIB('advocate.js'));

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
const all = () => Object.values(w.issues);

if (args[0] === 'ready') {
  const off = many('--exclude-label');
  const rows = all()
    .filter((i) => i.status === 'open' && !i.assignee)
    .filter((i) => !(i.labels || []).some((l) => off.includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'list' && flag('--parent')) {
  const parent = flag('--parent');
  const rows = all().filter((i) => i.id.startsWith(parent + '.') && i.id.slice(parent.length + 1).indexOf('.') === -1);
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'list') {
  const off = many('--exclude-label');
  const on = many('--label');
  let rows = all().filter((i) => i.status !== 'closed');
  rows = rows.filter((i) => !(i.labels || []).some((l) => off.includes(l)));
  if (on.length) rows = rows.filter((i) => on.every((l) => (i.labels || []).includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'human' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(all().filter((i) => i.status !== 'closed' && (i.labels || []).includes('human'))));
  process.exit(0);
}
if (args[0] === 'status') {
  const open = all().filter((i) => i.status === 'open');
  process.stdout.write(JSON.stringify({ summary: { open_issues: open.length, ready_issues: open.filter((i) => !i.assignee).length, blocked_issues: 0, in_progress_issues: 0 } }));
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
  const open = all().filter((i) => i.id.startsWith(args[1] + '.') && i.status !== 'closed');
  if (open.length) die('Error: cannot close ' + args[1] + ': blocked by open issues');
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
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2020-01-01T00:00:00Z',
  ...extra,
});

/**
 * - `zz-done` — an epic, 2/2 children closed. The bc-xl7n.8 case.
 * - `zz-live` — an epic with one child still open. Must never be flagged.
 * - `zz-empty` — an epic with no children at all. A standing root, not a finished theme.
 * - `zz-asked` — already carries the fingerprint. Must not be asked twice.
 * - `zz-work` — ordinary work, the control.
 *
 * And the whole-job half — every one of these is an epic with no children, so the sweep
 * above skips the lot of them as "no children at all" and only the second question has
 * anything to say. Each id's *tag* is what names its branch in the git fixture below
 * (`ownsBranch`: `zz-one` owns `worktree-…-one`), which is how the second question finds
 * a branch a delivering worker only ever wrote into a comment.
 *
 * - `zz-one` — the case. Worked as one job, merged, still `in_progress` and assigned
 *   exactly as `epicStaysOpen` leaves it, which is why `bd ready` cannot see it.
 * - `zz-mid` — the same, with a branch that has real commits and has not merged. Being
 *   worked right now, and must never be flagged.
 * - `zz-cut` — a branch cut from `main` with nothing committed on it. An *ancestor* of the
 *   base and not a landing, which is the whole of `landingMerge`'s second-parent rule.
 * - `zz-two` — merged, and a child was filed under it afterwards and is open.
 * - `zz-plain` — merged, and no `whole-job` label: nobody ever decided this was one job.
 * - `zz-hold` — merged, labelled `whole-job` *and* `container`. A standing root.
 * - `zz-ask` — merged, and already carrying the other question's fingerprint.
 */
const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        comments: {},
        issues: {
          'zz-work': issue('zz-work'),
          'zz-done': issue('zz-done', { issue_type: 'epic', title: 'the finished theme' }),
          'zz-done.1': issue('zz-done.1', { status: 'closed' }),
          'zz-done.2': issue('zz-done.2', { status: 'closed' }),
          'zz-live': issue('zz-live', { issue_type: 'epic', title: 'the live theme' }),
          'zz-live.1': issue('zz-live.1', { status: 'closed' }),
          'zz-live.2': issue('zz-live.2'),
          'zz-empty': issue('zz-empty', { issue_type: 'epic', title: 'a standing root, nothing filed yet' }),
          'zz-one': issue('zz-one', {
            issue_type: 'epic',
            title: 'the epic that was its own job',
            labels: ['whole-job'],
            status: 'in_progress',
            assignee: 'adam',
          }),
          'zz-mid': issue('zz-mid', {
            issue_type: 'epic',
            title: 'one job, still being done',
            labels: ['whole-job'],
            status: 'in_progress',
            assignee: 'adam',
          }),
          'zz-cut': issue('zz-cut', { issue_type: 'epic', title: 'one job, worktree cut and nothing written', labels: ['whole-job'] }),
          'zz-two': issue('zz-two', { issue_type: 'epic', title: 'one job that grew a child', labels: ['whole-job'] }),
          'zz-two.1': issue('zz-two.1', { title: 'filed under it afterwards' }),
          'zz-plain': issue('zz-plain', { issue_type: 'epic', title: 'nobody decided this was one job' }),
          'zz-hold': issue('zz-hold', { issue_type: 'epic', title: 'a standing root', labels: ['whole-job', 'container'] }),
          'zz-ask': issue('zz-ask', {
            issue_type: 'epic',
            title: 'already carrying the other card',
            labels: ['whole-job'],
            notes: '<!-- beadcause:finishedepic -->\n## asked already',
          }),
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

console.log('\nan epic does not become a worker window when its last child closes\n');

/* --------------------------------------------------------------- the fingerprint */

await check('alreadyAsked reads the marker off notes, description or design, and nothing else', () => {
  assert.equal(alreadyAsked({ notes: '<!-- beadcause:finishedepic -->\nmore' }), true);
  assert.equal(alreadyAsked({ description: '<!-- beadcause:finishedepic -->' }), true);
  assert.equal(alreadyAsked({ design: '<!-- beadcause:finishedepic -->' }), true);
  assert.equal(alreadyAsked({ notes: 'nothing here' }), false);
  assert.equal(alreadyAsked({}), false);
  assert.equal(alreadyAsked(null), false);
});

/* --------------------------------------------------------------------- the sweep */

await check('the sweep flags the finished epic, and only the finished epic', async () => {
  reset();
  const result = await sweepFinishedEpics(bd, ws);
  assert.equal(result.ok, true);
  assert.deepEqual(result.flagged.map((f) => f.id), ['zz-done']);
  assert.equal(result.flagged[0].total, 2);
  assert.match(describeFinishedEpics(result), /zz-done \(2\/2 closed\)/);
});

await check('a live epic and an empty one are left alone, quietly', async () => {
  const live = world().issues['zz-live'];
  assert.equal(live.labels.includes('human'), false);
  assert.equal(world().issues['zz-empty'].labels.includes('human'), false);
});

await check('what it writes: the record on the thread, the ask in the notes, the inbox last', async () => {
  const done = beadOf('zz-done');
  assert.ok(done.labels.includes('human'), 'it is in the inbox');
  assert.match(done.notes, /Every child of zz-done is closed — is the epic finished\?/);
  assert.match(done.description, /what zz-done is for/, 'and the description it arrived with is untouched');
  assert.equal(world().comments['zz-done'].length, 1);
  assert.match(world().comments['zz-done'][0].text, /Every one of its 2 children is closed/);

  const order = bdCalls().filter((c) => c[1] === 'zz-done' || c[2] === 'zz-done').map((c) => `${c[0]} ${c[1]}`);
  assert.equal(
    order.indexOf('update zz-done') < order.indexOf('label add'),
    true,
    `the options are written before the card exists, got ${order.join(' | ')}`
  );
});

await check('and the card parses on a phone: two options, the close recommended', async () => {
  const q = toQuestion('demo', beadOf('zz-done'));
  assert.deepEqual(q.errors, [], `the decision block must parse — ${q.errors.join('; ')}`);
  assert.deepEqual(q.decision.options.map((o) => o.id), ['close', 'keep']);
  assert.equal(q.decision.options[0].closes, true);
  assert.equal(q.decision.options[0].recommended, true);
  assert.equal(q.decision.options[1].closes, false, 'keeping it open must not file the work as finished');
  assert.match(q.question, /Every child of zz-done is closed/);
});

await check('it does not ask twice — a bead in the inbox is out of bd ready and out of the sweep', async () => {
  clearCalls();
  const again = await sweepFinishedEpics(bd, ws);
  assert.deepEqual(again.flagged, []);
  assert.equal(world().comments['zz-done'].length, 1, 'no second comment on the thread');
});

await check('nor after a write that half-failed', async () => {
  reset();
  const halfway = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  halfway.addLabel = async () => {
    throw new Error('bd: database is locked');
  };
  const first = await sweepFinishedEpics(halfway, ws);
  assert.deepEqual(first.flagged, []);
  assert.match(first.skipped.find((s) => s.id === 'zz-done').why, /could not put it in the inbox/);
  assert.match(beadOf('zz-done').notes, /Every child of zz-done is closed/, 'but the notes carry it');
  assert.equal(beadOf('zz-done').labels.includes('human'), false);

  const second = await sweepFinishedEpics(bd, ws);
  assert.deepEqual(second.flagged, []);
  assert.equal(world().comments['zz-done'].length, 1, 'one comment across both attempts');
});

await check('a tracker that will not answer is a returned sentence, not a thrown tick', async () => {
  const broken = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  broken.ready = async () => {
    throw new Error('bd: database is locked\nand more');
  };
  const result = await sweepFinishedEpics(broken, ws);
  assert.equal(result.ok, false);
  assert.match(describeFinishedEpics(result), /finished-epic sweep skipped — could not read the ready queue/);
});

/* --------------------------------- the whole of it: one advocate tick across the close */

// A second name over the same fake tracker, so the second tick test starts with no
// worker state carried over from the first — `createAdvocates` persists what it opened
// under `advocates.json`, keyed by workspace name, and both tick tests otherwise share
// one `BEADCAUSE_CONFIG_DIR`.
const ws2 = { name: 'demo2', dir: wsDir };

const advocateCfg = (workspace, extra = {}) => ({
  workspaces: [workspace],
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
    askSuperseded: false,
    flagInMain: false,
    flagNotInMain: false,
    // High enough that every ready bead in the small worlds below gets a slot — the
    // point under test is *which* beads are ready, not the rationing.
    maxWorkers: 10,
    ...extra,
  },
});

await check('without the sweep, the bug: a worker window opens on the finished epic', async () => {
  reset();
  const opened = [];
  const advocates = createAdvocates(advocateCfg(ws, { flagFinishedEpics: false }), {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, bead) => {
      opened.push(bead.id);
      return { dir: tmp, mode: 'test', term: null };
    },
  });
  await advocates.control('demo', 'resume');
  await advocates.tick();
  assert.ok(opened.includes('zz-done'), `the sweep is off, so this is bc-xl7n.8's incident: ${opened.join(', ')}`);
});

await check('with the sweep on (the default), the advocate asks instead of opening a session', async () => {
  reset();
  const opened = [];
  const advocates = createAdvocates(advocateCfg(ws2), {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, bead) => {
      opened.push(bead.id);
      return { dir: tmp, mode: 'test', term: null };
    },
  });
  await advocates.control('demo2', 'resume');
  await advocates.tick();

  assert.equal(opened.includes('zz-done'), false, `no session on the finished epic, got ${opened.join(', ')}`);
  assert.ok(opened.includes('zz-work'), 'and the launcher was live — an ordinary bead was opened in the same tick');
  assert.ok(beadOf('zz-done').labels.includes('human'), 'the epic went to the inbox in the same tick');
  const card = advocates.snapshot().find((a) => a.workspace === 'demo2');
  assert.equal(card.finishedEpic.flagged, 1, 'and the sweep is on the advocate card, not only in the log');
});

/* ----------------------------------------------------- the real endpoint, one tap */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  host: '127.0.0.1',
  port: 0,
  baseUrl: '',
  token: 'finishedepic-token',
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

const asked = async () => {
  reset();
  await sweepFinishedEpics(bd, ws);
};

await check('tapping "close it" closes the epic — the tap is the close', async () => {
  await asked();
  const res = await post('/api/respond', {
    workspace: 'demo',
    id: 'zz-done',
    option: 'close',
    response: 'All 2 children are closed.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.closed, true);
  assert.equal(beadOf('zz-done').status, 'closed', 'no session, no worker deriving this again');
});

await check('tapping "keep it open" hands it back, out of the inbox, still unclosed', async () => {
  await asked();
  const res = await post('/api/respond', {
    workspace: 'demo',
    id: 'zz-done',
    option: 'keep',
    response: 'More belongs here.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.handedBack, true);
  const done = beadOf('zz-done');
  assert.equal(done.status, 'open', 'a commission does not close');
  assert.equal(done.labels.includes('human'), false, 'and it is out of the inbox');
});

/* ============================================ the epic that was worked as one job */

/**
 * A real git repository, because the second question's evidence is a real merge.
 *
 * The shape, and every branch here is named for the *tag* of the bead that owns it:
 *
 *   c1 ── c2 ──────────── m1 ── m2 ── m3 ── m4 (main, origin/main)
 *          │  ╲          ╱     ╱     ╱     ╱
 *          │   c3 ──────╱     ╱     ╱     ╱     worktree-onejob-one   (zz-one, landed)
 *          │   c4 ───────────╱     ╱     ╱      worktree-both-two     (zz-two, landed)
 *          │   c5 ─────────────────╱     ╱      worktree-plain-plain  (zz-plain, landed)
 *          │   c6 ───────────────────────╱      worktree-held-hold    (zz-hold, landed)
 *          │   c7                               worktree-inflight-mid (zz-mid, unmerged)
 *          └── worktree-fresh-cut               (zz-cut, no commits of its own)
 *
 * `worktree-fresh-cut` is the case worth naming twice: its tip is c2, which *is* an
 * ancestor of main, so a sweep that asked `merge-base --is-ancestor` and stopped there
 * would report a fresh worktree as finished work before a line had been written in it.
 * `landingMerge` asks the second question — is this tip a *later* parent of some merge —
 * and that is why this file borrows it rather than re-deriving it.
 */
const REPO = path.join(tmp, 'repo');
fs.mkdirSync(REPO, { recursive: true });

const git = (...args) =>
  execFileSync(
    'git',
    ['-C', REPO, '-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8' }
  ).trim();

const commitIn = (name, message) => {
  fs.writeFileSync(path.join(REPO, name), message);
  git('add', name);
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};

execFileSync('git', ['-C', REPO, '-c', 'init.defaultBranch=main', 'init', '-q'], { encoding: 'utf8' });
commitIn('one', 'c1');
const c2 = commitIn('two', 'c2');

// The unstarted worktree: a branch and nothing else.
git('branch', 'worktree-fresh-cut', c2);

// Being worked right now: real commits, nothing merged.
git('checkout', '-q', '-b', 'worktree-inflight-mid', c2);
commitIn('mid', 'c7 — still going');

for (const [branch, file] of [
  ['worktree-onejob-one', 'landed-one'],
  ['worktree-both-two', 'landed-two'],
  ['worktree-plain-plain', 'landed-plain'],
  ['worktree-held-hold', 'landed-hold'],
  ['worktree-asked-ask', 'landed-ask'],
]) {
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', branch);
  commitIn(file, `work on ${branch}`);
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', `Merge branch '${branch}'`, branch);
}
git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'main'));

const landingOf = (branch) => {
  const tip = git('rev-parse', branch);
  const merges = git('rev-list', '--merges', '--parents', '--ancestry-path', `${tip}..refs/remotes/origin/main`);
  const line = merges.split('\n').filter(Boolean).find((l) => l.split(/\s+/).slice(2).includes(tip));
  return line ? line.split(/\s+/)[0] : '';
};

const whole = (rows = null) => sweepWholeEpics(bd, ws, REPO, { rows });

await check('the second question flags the epic worked as one job, and only that one', async () => {
  reset();
  const result = await whole();
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.flagged.map((f) => f.id),
    ['zz-one'],
    'a claimed epic whose one job is in main — and nothing else'
  );
  assert.equal(result.flagged[0].branch, 'worktree-onejob-one');
  assert.equal(result.flagged[0].base, 'origin/main');
  assert.equal(result.flagged[0].commit, landingOf('worktree-onejob-one'), 'the merge that took it in, not the tip');
  assert.match(describeWholeEpics(result), /zz-one \(worktree-onejob-one in origin\/main\)/);
});

await check('and every near miss is left alone, with a reason', async () => {
  const pass = await whole();
  const why = (id) => (pass.skipped.find((s) => s.id === id) || {}).why || '';
  assert.equal(pass.flagged.length, 0, 'the one real case is already in the inbox from the check above');
  assert.match(why('zz-mid'), /nothing of its own has landed/, 'a branch being worked on right now');
  assert.match(why('zz-cut'), /nothing of its own has landed/, 'an ancestor of main is not a landing');
  assert.match(why('zz-two'), /1 bead filed under it since is still open/);
  assert.equal(why('zz-plain'), '', 'no whole-job label — never a candidate, not even a skip');
  assert.equal(why('zz-hold'), '', 'a container is never a candidate');
  assert.equal(why('zz-ask'), '', 'already carrying the other question — never a candidate');
  for (const id of ['zz-mid', 'zz-cut', 'zz-two', 'zz-plain', 'zz-hold', 'zz-ask']) {
    assert.equal(labelsOf(id).includes('human'), false, `${id} must not be in the inbox`);
  }
});

await check('what the second question writes, and what it leaves alone: the claim', async () => {
  const one = beadOf('zz-one');
  assert.ok(one.labels.includes('human'), 'it is in the inbox');
  assert.match(one.notes, /zz-one was worked as one job and .worktree-onejob-one. is in origin\/main/);
  assert.equal(world().comments['zz-one'].length, 1);
  assert.match(world().comments['zz-one'][0].text, /worked as one job, and `worktree-onejob-one` is already in `origin\/main`/);
  assert.equal(one.status, 'in_progress', 'the claim is untouched — the card is what moves this bead, not the sweep');

  const order = bdCalls()
    .filter((c) => c[1] === 'zz-one' || c[2] === 'zz-one')
    .map((c) => `${c[0]} ${c[1]}`);
  assert.equal(
    order.indexOf('update zz-one') < order.indexOf('label add'),
    true,
    `the options are written before the card exists, got ${order.join(' | ')}`
  );
});

await check('and its card parses on a phone: two options, the close recommended', async () => {
  const q = toQuestion('demo', beadOf('zz-one'));
  assert.deepEqual(q.errors, [], `the decision block must parse — ${q.errors.join('; ')}`);
  assert.deepEqual(
    q.decision.options.map((o) => o.id),
    ['close', 'keep']
  );
  assert.equal(q.decision.options[0].closes, true);
  assert.equal(q.decision.options[0].recommended, true, 'unlike lib/inmain.js, this one recommends — see the header');
  assert.equal(q.decision.options[1].closes, false, 'and "not finished" must not file the work as done');
  assert.match(q.question, /is the epic finished\?/);
});

await check('a branch name in a YAML scalar is quoted — the failure it prevents is silent', () => {
  const block = wholeEpicAsk('zz-one', 'worktree-onejob-one', { commit: 'abc12345', subject: 'a `subject` with *markup*' }, 'origin/main');
  assert.match(block, /^question: "/m, 'a plain scalar opening on a backtick is a parse error, not a string');
  assert.equal(block.includes('*markup*'), false, 'and the commit subject is stripped of what would reopen a fence');
  const q = toQuestion('demo', { id: 'zz-one', title: 't', notes: block });
  assert.deepEqual(q.errors, []);
});

await check('it does not ask twice, and the two questions never both land on one bead', async () => {
  clearCalls();
  const again = await whole();
  assert.deepEqual(again.flagged, []);
  assert.equal(world().comments['zz-one'].length, 1, 'no second comment on the thread');
  assert.equal(alreadyAsked(beadOf('zz-one')), true, 'and the P0 board reads it as asked, whichever question asked');
  assert.equal(alreadyAsked({ notes: wholeEpicComment('worktree-x-one', 'main', {}) }), false, 'the comment is not a fingerprint');
});

await check('nor after a whole-job write that half-failed', async () => {
  reset();
  const halfway = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  halfway.addLabel = async () => {
    throw new Error('bd: database is locked');
  };
  const first = await sweepWholeEpics(halfway, ws, REPO);
  assert.deepEqual(first.flagged, []);
  assert.match(first.skipped.find((s) => s.id === 'zz-one').why, /could not put it in the inbox/);
  assert.match(beadOf('zz-one').notes, /was worked as one job/, 'but the notes carry it');
  assert.equal(beadOf('zz-one').labels.includes('human'), false);

  const second = await whole();
  assert.deepEqual(second.flagged, []);
  assert.equal(world().comments['zz-one'].length, 1, 'one comment across both attempts');
});

await check('a tracker that will not answer the label query is a sentence, not a thrown tick', async () => {
  const broken = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  broken.listLabel = async () => {
    throw new Error('bd: database is locked\nand more');
  };
  const result = await sweepWholeEpics(broken, ws, REPO);
  assert.equal(result.ok, false);
  assert.match(describeWholeEpics(result), /whole-job epic sweep skipped — could not read the whole-job epics/);
});

await check('a checkout that is not a repository is the same — a sentence, and git is never asked twice', async () => {
  reset();
  const result = await sweepWholeEpics(bd, ws, path.join(tmp, 'no-such-checkout'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /neither origin\/main nor main is a ref/);
  assert.equal(beadOf('zz-one').labels.includes('human'), false);
});

await check('and a workspace where nothing was ever judged one job never opens the checkout at all', async () => {
  const result = await sweepWholeEpics(bd, ws, path.join(tmp, 'no-such-checkout'), { rows: [] });
  assert.equal(result.ok, true, 'no candidates is a clean sweep, not an unreadable checkout');
  assert.equal(result.reason, '');
  assert.deepEqual(result.flagged, []);
});

/* -------------------------- the whole of it: one advocate tick over a real checkout */

const ws3 = { name: 'demo3', dir: wsDir };

await check('the advocate asks in its ordinary tick, over the checkout mapped to the workspace', async () => {
  reset();
  const opened = [];
  const advocates = createAdvocates(
    { ...advocateCfg(ws3), sessionDirs: { demo3: REPO } },
    {
      bd,
      bus: { emit() {} },
      open: async (_cfg, _ws, bead) => {
        opened.push(bead.id);
        return { dir: tmp, mode: 'test', term: null };
      },
    }
  );
  await advocates.control('demo3', 'resume');
  await advocates.tick();

  assert.ok(beadOf('zz-one').labels.includes('human'), 'the finished whole-job epic went to the inbox in the same tick');
  assert.equal(opened.includes('zz-one'), false, `and no session on it, got ${opened.join(', ')}`);
  assert.equal(beadOf('zz-mid').labels.includes('human'), false, 'the one still being worked is untouched');
  const card = advocates.snapshot().find((a) => a.workspace === 'demo3');
  assert.equal(card.finishedEpic.flagged, 2, 'both questions count onto the one card — zz-done and zz-one');
  assert.match(card.finishedEpic.summary, /finished whole-job epic/);
});

/* ------------------------------- and the tap, on the endpoint that actually answers */

const askedWhole = async () => {
  reset();
  await whole();
};

await check('tapping "close it" closes the epic its own merge deliberately left open', async () => {
  await askedWhole();
  const res = await post('/api/respond', {
    workspace: 'demo',
    id: 'zz-one',
    option: 'close',
    response: 'Closed: zz-one was worked as one job.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.closed, true);
  assert.equal(beadOf('zz-one').status, 'closed');
});

await check('tapping "keep it open" hands it back unclaimed — which the delivery would not do', async () => {
  await askedWhole();
  const res = await post('/api/respond', {
    workspace: 'demo',
    id: 'zz-one',
    option: 'keep',
    response: 'The one job was a first step.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.handedBack, true);
  const one = beadOf('zz-one');
  assert.equal(one.status, 'open', 'a commission does not close');
  assert.equal(one.assignee || '', '', 'and the claim comes off, so bd ready can see it again');
  assert.equal(one.labels.includes('human'), false, 'and it is out of the inbox');
});

/* -------------------------------------------------------------------- the result */

console.log(`\n${ran - failures}/${ran} passed\n`);
for (const s of servers || []) s.close?.();
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
