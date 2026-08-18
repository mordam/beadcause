#!/usr/bin/env node
/**
 * A kind pill shows everything assigned to you — not just what hangs off a started epic.
 *
 *     npm test
 *     node test/assignedrows.mjs
 *
 * bc-khoe.29. bc-khoe.28 took the epic board off every view but My Epics, so Questions,
 * PRs, Chats and All Beads are the list and nothing else. They kept the narrowing the page
 * had while the board was over them — `rootboard.under`, which is "which started root of
 * yours draws this row in its tree" — and every one of that map's properties is wrong for
 * a screen the board is not on:
 *
 * - it is a **removal**: a row the board draws is taken *out* of the list, so the
 *   commonest row on the tracker (a question in an epic of yours you have started) is the
 *   one row the Questions pill could not show;
 * - it is keyed on **roots**, so a question on a bead of yours that is not an epic has
 *   never been in it;
 * - it is keyed on **started** roots (bc-6s96), so a question under an epic you have filed
 *   and not claimed left it — and it is not `unhomed` either, because a root above it is
 *   still a root, which is the gap those two maps disagree in on purpose.
 *
 * So the pills get their own rule and their own field: **`rootboard.assigned` — every bead
 * carrying your `owner:<handle>`, and everything under one, at any depth, whatever the
 * status of the bead above it.** Six properties, and the ones a refactor takes away
 * quietly are the last three:
 *
 * 1. **A question on a bead of yours that is not a root is drawn**, and one under a root
 *    of yours that has not been started, and one under a root of yours that has closed.
 *    All three are the acceptance criteria, asserted through the *real* `assignedToMe`
 *    lifted out of public/app.js over the *real* `/api/questions` payload.
 * 2. **Somebody else's is not.** This widens the narrowing; it does not remove it.
 * 3. **The board's own `under` is untouched** — same entries, same rule, still only
 *    started roots — because the board still means the epics you have started and the two
 *    maps are answering different questions off one export.
 * 4. **`assigned` is keyed by bead, not by row.** A pull request is keyed `pr:<repo>#<n>`
 *    and is judged by the beads it *names*, which mostly have no inbox row at all, so a
 *    per-row map could not answer for them — and this is the first rule under which a
 *    pull request over a bead of yours reaches the PRs pill, rather than every pull
 *    request naming any bead being dropped.
 * 5. **`unhomed` still wins.** bc-i7tw: a bead with no root above it anywhere is on no
 *    other screen in this app, and the question you filed from your own phone carries no
 *    owner label and no parent. Widening the rule must not quietly delete that fix.
 * 6. **An install that owns nothing is not narrowed at all**, and neither is a payload
 *    that predates the field — the same fail-open direction `isBoarded` takes, minus its
 *    `roots` test, because having started nothing is exactly when your questions still
 *    have to be reachable.
 *
 * The real `bd` is never run: `cfg.bdBin` is a fake answering `export` with JSONL and
 * `human list` with a JSON array, and failing `export` for one workspace so that "this
 * tracker could not be read" is staged beside a healthy one. No browser: the client half
 * is sliced out of public/app.js and run in a `node:vm`, the way test/ownquestion.mjs
 * does it, because neither filter touches the DOM.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-assignedrows-'));
// Before lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

/* ---------------------------------------------------------------- the tracker */

const ME = 'adam@example.com';
const THEM = 'bob@example.com';

const row = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  assignee: '',
  labels: [],
  dependencies: [],
  ...extra,
});
const parentEdge = (child, parent) => ({ issue_id: child, depends_on_id: parent, type: 'parent-child' });
const kid = (id, parent, extra = {}) => row(id, { dependencies: [parentEdge(id, parent)], ...extra });
const question = (id, parent, extra = {}) =>
  row(id, { labels: ['human'], dependencies: parent ? [parentEdge(id, parent)] : [], ...extra });
const epic = (id, extra = {}) => row(id, { priority: 0, issue_type: 'epic', ...extra });

/**
 * One graph, holding every shape the two filters disagree about.
 *
 * `zz-p0` is the board: a root of yours, started, and the only card drawn. Everything else
 * is a row the board cannot hold — and the point of the fixture is that the three in the
 * middle are *yours* and were on no screen at all before this bead.
 *
 * - `zz-p0.9` — under your started root. In `under`, so the board draws it and
 *   `underOwnedRoots` takes it back out of the list; assigned, so a kind pill shows it.
 * - `zz-later.1` — under a root of yours you have not started (bc-6s96). In neither map.
 * - `zz-mine.1` — under a *task* of yours, which is not a root and never will be, sitting
 *   in somebody else's epic: what "assigned to you" means when the tracker is shared.
 * - `zz-mine.2.1` — the same, one level deeper, because "at any depth" is a claim about
 *   the walk and not about the parent.
 * - `zz-solo` — the row's own bead carries your label. No ancestry involved at all.
 * - `zz-done.1` — under a root of yours that has closed. Assigned (status is not part of
 *   the question) and `unhomed` as well (a closed root is no root), so it is one of the
 *   two rows both filters agree on.
 * - `zz-theirs.1` — bob's, under bob's open epic. The control: this bead widens the
 *   narrowing, it does not switch it off.
 * - `zz-asked` — the share target's own bead, filed thirty seconds ago from this phone:
 *   no parent, no owner label, and drawn by `unhomed` alone (bc-i7tw).
 */
const EXPORT = [
  epic('zz-p0', { status: 'in_progress', title: 'A root of yours, started', labels: [`owner:${ME}`] }),
  question('zz-p0.9', 'zz-p0'),
  epic('zz-later', { title: 'A root of yours, filed and not started', labels: [`owner:${ME}`] }),
  question('zz-later.1', 'zz-later'),
  epic('zz-done', { status: 'closed', title: 'A root of yours that landed', labels: [`owner:${ME}`] }),
  question('zz-done.1', 'zz-done'),
  epic('zz-theirs', { title: 'Bob’s epic', labels: [`owner:${THEM}`] }),
  question('zz-theirs.1', 'zz-theirs'),
  // A task of yours inside bob's epic — not a root, never on the board, and the shape the
  // whole bead is about. Its children are yours by descent at two different depths.
  kid('zz-mine', 'zz-theirs', { title: 'A task of yours under Bob’s epic', labels: [`owner:${ME}`] }),
  question('zz-mine.1', 'zz-mine'),
  kid('zz-mine.2', 'zz-mine', { title: 'A task under the task' }),
  question('zz-mine.2.1', 'zz-mine.2'),
  // The row's own bead is the one carrying the label.
  question('zz-solo', 'zz-theirs', { labels: ['human', `owner:${ME}`], title: 'A question of your own' }),
  question('zz-asked', null, { title: 'Should the porch light go on a timer?' }),
]
  .map((r) => JSON.stringify(r))
  .join('\n');

/** `bd human list` — the rows the inbox is built from, in `bd`'s own shape. */
const humanRow = (id, title) => ({
  id,
  title,
  description: '',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: ['human'],
  created_at: '2026-08-18T08:00:00Z',
  updated_at: '2026-08-18T08:00:00Z',
});
const ASKING = ['zz-p0.9', 'zz-later.1', 'zz-done.1', 'zz-theirs.1', 'zz-mine.1', 'zz-mine.2.1', 'zz-solo', 'zz-asked'];
const HUMAN_ALPHA = ASKING.map((id) => humanRow(id, `bead ${id}`));
/** beta answers its questions and refuses its graph — see the fake below. */
const HUMAN_BETA = [humanRow('zz-beta-asked', 'What is for dinner?')];

/* ------------------------------------------------------------------ the fake bd */

const WS = ['alpha', 'beta'].map((name) => {
  const dir = path.join(tmp, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return { name, dir };
});

const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const ws = String(process.env.BEADS_DIR || '').includes('beta') ? 'beta' : 'alpha';
if (args[0] === 'export') {
  if (ws === 'beta') { process.stderr.write('bd: database is locked'); process.exit(1); }
  process.stdout.write(${JSON.stringify(EXPORT)}); process.exit(0);
}
if (args[0] === 'human' && args[1] === 'list') {
  process.stdout.write(ws === 'beta' ? ${JSON.stringify(JSON.stringify(HUMAN_BETA))} : ${JSON.stringify(JSON.stringify(HUMAN_ALPHA))});
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/* -------------------------------------------------------------------- the daemon */

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'assignedrows-token',
  bdBin: BD,
  actor: 'beadcause-test',
  me: ME,
  workspaces: WS,
  spaces: [],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  agents: [],
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(path.join(ROOT, 'lib', 'server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const PORT = await boundPort(servers);

const getJson = async (p) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'x-beadcause-token': cfg.token } });
  assert.equal(res.status, 200, `GET ${p} should be 200, got ${res.status}`);
  return res.json();
};

/**
 * The board is never built on the request path (`Bd.graph({ wait: false })`), so the first
 * payload after a cold start has no roots in it and the second or third does. Asking until
 * it lands is what a phone does anyway; a fixed sleep would be a flake on a loaded Mac.
 */
async function boardWhenWarm() {
  for (let i = 0; i < 60; i += 1) {
    const payload = await getJson('/api/questions');
    if ((payload.rootboard?.roots || []).length) return payload;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the epic board never warmed up — no roots after six seconds of asking');
}

/* ------------------------------------------------------------------ the client half */

const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/** Lift one declaration out of public/app.js — test/ownquestion.mjs's `lift`, unchanged. */
function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (!depth) return src.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${opener}`);
}

/** The real pill filter, over a real payload. `open` is what `state.open` would hold. */
function onPill(rows, board, open = []) {
  const context = vm.createContext({ Boolean, String, Object, Set });
  vm.runInContext(
    [lift(APP, 'function assignedToMe(rows)'), 'globalThis.out = assignedToMe(ROWS);'].join('\n'),
    Object.assign(context, { ROWS: rows, state: { rootboard: board, open: new Set(open) } })
  );
  return context.out.map((q) => q.key);
}

/** The board's own filter, for the one check that is about the two differing. */
function underBoard(rows, board, open = []) {
  const context = vm.createContext({ Boolean, String, Object, Set });
  vm.runInContext(
    [
      lift(APP, 'function isBoarded()'),
      lift(APP, 'function underOwnedRoots(rows)'),
      'globalThis.out = underOwnedRoots(ROWS);',
    ].join('\n'),
    Object.assign(context, { ROWS: rows, state: { rootboard: board, open: new Set(open) } })
  );
  return context.out.map((q) => q.key);
}

console.log('\na kind pill shows everything assigned to you\n');

try {
  await boardWhenWarm();
  // A second read, so both workspaces have been through the graph once — beta's failure is
  // cached like any other answer, and a row of beta's on the very first warm payload would
  // be unhomed for the uninteresting reason that nothing had been asked yet.
  const payload = await getJson('/api/questions');
  const board = payload.rootboard;
  const keys = payload.questions.map((q) => q.key);
  const assigned = board.assigned || {};

  await check('the fixture is the fixture: eight questions in alpha and one in beta', () => {
    assert.deepEqual(
      keys.slice().sort(),
      [...ASKING.map((id) => `alpha/${id}`), 'beta/zz-beta-asked'].sort(),
      'the sweep did not return what this suite is about to make claims over'
    );
    assert.equal(board.owned, true, 'the board is off entirely — cfg.me did not take');
    assert.deepEqual(
      board.roots.map((c) => c.id),
      ['zz-p0'],
      'the board is not the one root you own and have started'
    );
  });

  await check('THE SERVER MARKS A BEAD OF YOURS THAT IS NOT A ROOT, AND EVERYTHING UNDER IT', () => {
    // The whole seam, and it is asserted on the payload rather than through the client
    // because that is the half `under` cannot be widened into: these beads are not roots,
    // so no map keyed on roots can ever carry them.
    assert.equal(assigned['alpha/zz-mine'], true, 'a task carrying your owner: label is not marked');
    assert.equal(assigned['alpha/zz-mine.1'], true, 'a question under a task of yours is not marked');
    assert.equal(assigned['alpha/zz-mine.2.1'], true, 'the walk stops before the second generation');
    assert.equal(assigned['alpha/zz-solo'], true, 'a question carrying the label itself is not marked');
  });

  await check('and a root of yours you have NOT started, and one that has CLOSED', () => {
    // bc-6s96 is a rule about which epics lead the screen. It was never a rule about which
    // questions exist, and until this bead it was both.
    assert.equal(assigned['alpha/zz-later'], true, 'an unstarted root of yours is not yours');
    assert.equal(assigned['alpha/zz-later.1'], true, 'the question under it is off every screen');
    // "Whatever its status" is not a hedge: it is the difference between an epic ending and
    // its open questions being deleted.
    assert.equal(assigned['alpha/zz-done.1'], true, 'a question under a finished epic of yours is not marked');
  });

  await check('somebody else’s is not — this widens the narrowing, it does not remove it', () => {
    assert.equal(assigned['alpha/zz-theirs'], undefined, 'bob’s epic came back as yours');
    assert.equal(assigned['alpha/zz-theirs.1'], undefined, 'a question under bob’s epic came back as yours');
    // The parentless one is nobody's: it carries no owner label, which is what every bead
    // `/api/ask` files looks like. It reaches the screen through `unhomed` and only that.
    assert.equal(assigned['alpha/zz-asked'], undefined, 'an unowned parentless bead was claimed for you');
    assert.equal(board.unhomed['alpha/zz-asked'], true, 'the parentless question lost its only route in');
  });

  await check('it is keyed by BEAD and not by row, which is what a pull request needs', () => {
    // `under` and `unhomed` are per row and a pull request has no row in either. Two thirds
    // of these ids have no inbox row at all — `zz-mine` is asking nobody anything — and the
    // map carries them anyway, because the question "is this bead yours" is asked about
    // beads a pull request names rather than about rows the sweep produced.
    assert.equal(assigned['alpha/zz-p0'], true, 'the root itself is not in its own closure');
    assert.equal(assigned['alpha/zz-mine.2'], true, 'a quiet bead in the middle of the chain is missing');
    assert.ok(!ASKING.includes('zz-mine.2'), 'the fixture stopped proving the point — that bead has a row now');
    for (const key of Object.keys(assigned)) {
      assert.ok(!key.includes('pr:'), `${key} is not a bead — this map is keyed by bead id`);
    }
  });

  await check('THE BOARD’S OWN `under` IS UNCHANGED — bc-6s96 and bc-rfnr.2 both still hold', () => {
    assert.equal(board.under['alpha/zz-p0.9'], 'zz-p0', '`under` stopped answering for the rows it is for');
    assert.equal(board.under['alpha/zz-later.1'], undefined, '`under` grew the unstarted root back');
    assert.equal(board.under['alpha/zz-mine.1'], undefined, '`under` started answering for beads under no root');
    assert.equal(board.under['alpha/zz-theirs.1'], undefined, '`under` claimed bob’s row');
    assert.deepEqual(Object.keys(board.under), ['alpha/zz-p0.9'], '`under` is no longer the started-root map');
  });

  await check('a workspace whose graph could not be read contributes nothing and hides nothing', () => {
    // `Bd.graph` answers an empty shape rather than throwing, so beta reaches the loop with
    // no beads. Nothing there can be marked yours; every row of it is drawn regardless.
    for (const key of Object.keys(assigned)) {
      assert.ok(!key.startsWith('beta/'), `${key} was claimed for you out of a graph nothing could read`);
    }
    assert.equal(board.unhomed['beta/zz-beta-asked'], true, 'a question in an unreadable workspace is hidden');
    assert.ok(onPill(payload.questions, board).includes('beta/zz-beta-asked'));
  });

  await check('AND THE PILL ACTUALLY DRAWS THEM — the real filter, over the real payload', () => {
    // The acceptance criteria, end to end: every question of yours at every depth, plus the
    // two rows nothing else can hold, and bob's is not among them.
    assert.deepEqual(onPill(payload.questions, board).sort(), [
      'alpha/zz-asked',
      'alpha/zz-done.1',
      'alpha/zz-later.1',
      'alpha/zz-mine.1',
      'alpha/zz-mine.2.1',
      'alpha/zz-p0.9',
      'alpha/zz-solo',
      'beta/zz-beta-asked',
    ].sort());
  });

  await check('AND THE BOARD’S FILTER DOES NOT — which is the bug, stated as a test', () => {
    // The same rows through the filter the pills used to inherit. Four of the seven rows
    // above are gone, three of them because they are yours in a way `under` cannot express
    // and the fourth because the board is drawing it — on a screen the board is not on.
    assert.deepEqual(underBoard(payload.questions, board).sort(), [
      'alpha/zz-asked',
      'alpha/zz-done.1',
      'beta/zz-beta-asked',
    ].sort());
  });

  await check('a pull request follows the beads it names, and one naming none is kept', () => {
    // The first rule under which a delivery over a bead of yours reaches the PRs pill:
    // `underOwnedRoots` drops every pull request naming any bead at all, because its map
    // cannot tell yours from a stranger's. Both shapes of `beads` entry are read — the
    // sweep writes ids and one path writes `{ id, title, status }` — exactly as `inBead`
    // reads them.
    const pr = (n, beads) => ({ key: `pr:acme/thing#${n}`, workspace: 'alpha', pr: { beads } });
    const rows = [
      pr(1, ['zz-mine.1']),
      pr(2, []),
      pr(3, ['zz-theirs.1']),
      pr(4, [{ id: 'zz-mine.2' }]),
      pr(5, ['zz-theirs.1', 'zz-p0.9']),
    ];
    assert.deepEqual(onPill(rows, board), ['pr:acme/thing#1', 'pr:acme/thing#2', 'pr:acme/thing#4', 'pr:acme/thing#5']);
    assert.deepEqual(underBoard(rows, board), ['pr:acme/thing#2'], 'the board’s rule stopped being the narrow one');
  });

  await check('a chat and a JIRA ticket are drawn whatever the ownership says', () => {
    // Neither is a bead: a chat has none at all and is where a new epic gets filed, and a
    // ticket has none until bc-0i27.4 files one. Hiding either would make this filter the
    // one thing on the screen you could not get out of.
    const rows = [
      { key: 'chat:abc', workspace: 'alpha', session: { id: 'abc' } },
      { key: 'jira:TECH-1', workspace: 'alpha', jira: { key: 'TECH-1' } },
    ];
    assert.deepEqual(onPill(rows, board), ['chat:abc', 'jira:TECH-1']);
  });

  await check('unless its card is open, which is how a question of bob’s gets answered at all', () => {
    // `.card.open` is a full-screen sheet built out of an inbox row, and a notification
    // deep-links straight into it. A sheet opened over a row this filter had dropped comes
    // up empty, which reads as a tap the app ignored — the same exception, and the same
    // first-of-all-tests position, that `underOwnedRoots` makes for the same reason.
    assert.ok(!onPill(payload.questions, board).includes('alpha/zz-theirs.1'));
    assert.ok(onPill(payload.questions, board, ['alpha/zz-theirs.1']).includes('alpha/zz-theirs.1'));
    // And it is the open key that does it, not the fact that something is open.
    assert.ok(!onPill(payload.questions, board, ['alpha/zz-solo']).includes('alpha/zz-theirs.1'));
  });

  await check('an install that owns nothing is not narrowed at all', () => {
    // The two no-op cases: no `cfg.me` on this Mac, and a payload from a server that
    // predates the field. Narrowing to nothing there would hide the whole tracker behind a
    // screen indistinguishable from a quiet afternoon.
    assert.deepEqual(onPill(payload.questions, { ...board, owned: false }).sort(), keys.slice().sort());
    assert.deepEqual(onPill(payload.questions, { ...board, assigned: {} }).sort(), keys.slice().sort());
    assert.deepEqual(onPill(payload.questions, { ...board, assigned: undefined }).sort(), keys.slice().sort());
    // But it does NOT gate on `roots` the way `isBoarded` does. Having started nothing is
    // exactly the state bc-6s96 leaves you in, and it is when your questions most need to
    // still be reachable — the board is empty and the pills are the whole screen.
    assert.deepEqual(onPill(payload.questions, { ...board, roots: [] }).sort(), onPill(payload.questions, board).sort());
  });

  await check('and public/app.js still has both filters, because they are two questions', () => {
    // The cheap guard against the tidy-up that reads them as duplicates and keeps one: the
    // board's is a de-duplication of what its trees draw, the pills' is an ownership test,
    // and a page with only the first is this bead undone.
    assert.ok(APP.includes('function assignedToMe(rows)'), 'the pills’ filter is gone');
    assert.ok(APP.includes('function underOwnedRoots(rows)'), 'the board’s filter is gone');
  });
} finally {
  for (const s of servers || []) s.close?.();
  app.stop?.();
  await cleanupTmp(tmp);
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
