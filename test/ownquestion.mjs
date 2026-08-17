#!/usr/bin/env node
/**
 * A question with no P0 above it is drawn — the one you filed from your own phone.
 *
 *     npm test
 *     node test/ownquestion.mjs
 *
 * bc-i7tw. bc-rfnr.2 narrowed the inbox to what descends from a P0 you own, and the
 * narrowing is a single map: `rootboard.under`, one entry per row, the id of the P0 it
 * hangs off. A row that is not in it is not drawn. That is right for a bead under
 * somebody else's epic — it is on their screen — and it is the app's one unforgivable
 * failure for a bead under *nothing*, because there is no other screen. `/api/ask` is
 * the phone's share target and files with no parent; `/api/console/create` does the same
 * for a draft that names none. So the sharpest version: you file a question from your
 * phone, `bd` has it, `bd human list` returns it, and the inbox you filed it on will not
 * draw it, with nothing anywhere saying so.
 *
 * bc-rfnr.8 fixed this for the beads the *daemon* files by giving them a parent at the
 * filing seam (lib/homing.js). It could not fix it for a person, because auto-adopting
 * what a person filed is a decision about the tracker's shape rather than about a
 * screen — and because a fix at the filing seam is only ever as good as the graph cache
 * was at that moment. This is the other half and it needs neither: the server says which
 * rows hang off no P0 *at all* (`rootboard.unhomed`), and the client draws those whatever
 * the board says.
 *
 * Five properties, and the middle three are the ones a refactor takes away quietly:
 *
 * 1. **The parentless question is drawn**, with the board active and P0s owned. This is
 *    the acceptance criterion, and it is asserted through the *real* `underOwnedRoots`
 *    lifted out of public/app.js over the *real* `/api/questions` payload — the two
 *    halves of the fix, joined, because either one alone still leaves the card missing.
 * 2. **A question under somebody else's open P0 is still hidden.** bc-rfnr.2 is not
 *    being undone. The two cases are one absence in `under` and the whole bug was
 *    treating them as one fact; a fix that showed both would be the flat list back.
 * 3. **A question under a P0 that has *closed* is drawn.** A closed P0 is not a root
 *    (lib/underroot.js) and its descendants stop being pulled onto the board with it, so
 *    an open question under a finished epic is under nothing — the exact shape
 *    lib/homing.js warns about, held forever and, until this, seen by nobody.
 * 4. **A workspace whose graph could not be read hides none of its rows.** `rootBoard`'s
 *    own comment has claimed this since bc-rfnr.2 and it was not true: an unreadable
 *    workspace contributed no `under` entries, which is precisely how a row is hidden.
 *    `Bd.graph` swallowing a failure into an empty shape is what reaches this path.
 * 5. **A pull request still follows its beads.** `unhomed` is a claim about ancestry and
 *    a PR row is keyed `pr:<repo>#<n>`, which has none — the server marks only bead rows,
 *    and the client's PR rule is asked first either way.
 *
 * The real `bd` is never run: `cfg.bdBin` is a fake that answers `export` with JSONL and
 * `human list` with a JSON array, and fails `export` alone for one workspace — which is
 * how "this tracker could not be read" is staged beside a healthy one in the same run.
 * No browser: the client half is sliced out of public/app.js and run in a `node:vm`, the
 * way test/jirarow.mjs does it, because `underOwnedRoots` touches no DOM.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-ownquestion-'));
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
const question = (id, extra = {}) => row(id, { labels: ['human'], ...extra });

/**
 * Four questions, and which of them the inbox may draw is four different answers.
 *
 * `zz-asked` is what this suite exists for: no parent at all, which is every bead
 * `/api/ask` has ever filed. `zz-theirs.1` is the control — under an open P0 that is not
 * yours, so it stays hidden and proves the narrowing is still on. `zz-done.1` is the case
 * nobody would have thought to stage: its P0 closed underneath it. `zz-later.1` is
 * bc-6s96's: under a P0 that is yours and open and *not started*, so it is hidden like
 * bob's rather than rescued like the orphan — the one case where the two maps have to
 * disagree, and the row is in neither.
 */
const EXPORT = [
  row('zz-p0', {
    status: 'in_progress',
    priority: 0,
    issue_type: 'epic',
    title: 'A P0 of yours, started',
    labels: [`owner:${ME}`],
  }),
  question('zz-p0.9', { dependencies: [parentEdge('zz-p0.9', 'zz-p0')] }),
  row('zz-theirs', { priority: 0, issue_type: 'epic', labels: ['owner:bob@example.com'] }),
  question('zz-theirs.1', { dependencies: [parentEdge('zz-theirs.1', 'zz-theirs')] }),
  row('zz-later', {
    priority: 0,
    issue_type: 'epic',
    title: 'A P0 of yours you have not started yet',
    labels: [`owner:${ME}`],
  }),
  question('zz-later.1', { dependencies: [parentEdge('zz-later.1', 'zz-later')] }),
  row('zz-done', {
    priority: 0,
    issue_type: 'epic',
    status: 'closed',
    title: 'A P0 of yours that landed',
    labels: [`owner:${ME}`],
  }),
  question('zz-done.1', { dependencies: [parentEdge('zz-done.1', 'zz-done')] }),
  // The share target's own bead: filed thirty seconds ago, from the phone this is drawn on.
  question('zz-asked', { title: 'Should the porch light go on a timer?' }),
]
  .map((r) => JSON.stringify(r))
  .join('\n');

/** `bd human list` — the rows the inbox is built from. Same four, in `bd`'s own shape. */
const humanRow = (id, title) => ({
  id,
  title,
  description: '',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: ['human'],
  created_at: '2026-08-14T08:00:00Z',
  updated_at: '2026-08-14T08:00:00Z',
});
const HUMAN_ALPHA = [
  humanRow('zz-p0.9', 'bead zz-p0.9'),
  humanRow('zz-theirs.1', 'bead zz-theirs.1'),
  humanRow('zz-later.1', 'bead zz-later.1'),
  humanRow('zz-done.1', 'bead zz-done.1'),
  humanRow('zz-asked', 'Should the porch light go on a timer?'),
];
/** beta's tracker answers its questions and refuses its graph — see the fake below. */
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
// beta is the workspace whose *shape* this Mac cannot read — a Dolt write lock, a
// checkout mid-migration. Its questions still arrive; nothing knows what is above them.
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
  token: 'ownquestion-token',
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
 * The board is never built on the request path (`Bd.graph({ wait: false })`), so the
 * first payload after a cold start has no P0s in it and the second or third does. Asking
 * until it lands is what a phone does anyway; a fixed sleep would be a flake on a loaded
 * Mac. Copied from test/p0tree.mjs, which pays the same cost for the same reason.
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

/**
 * Lift one declaration out of public/app.js — test/jirarow.mjs's `lift`, unchanged.
 *
 * The file is one IIFE with nothing exported, so this is the only way to run a piece of
 * it without a document. Both declarations wanted here are the `function` shape, so only
 * that half is needed; brace-matching does not track strings, which is sound over these
 * two and unsound in general, and it fails loudly rather than quietly — the slice stops
 * parsing and this suite goes red with a SyntaxError naming the line.
 */
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

/** The real filter, over a real payload. `board` is what `state.rootboard` would hold. */
function drawn(rows, board) {
  const context = vm.createContext({ Boolean, String, Object });
  vm.runInContext(
    [
      lift(APP, 'function isBoarded()'),
      lift(APP, 'function underOwnedRoots(rows)'),
      'globalThis.out = underOwnedRoots(ROWS);',
    ].join('\n'),
    Object.assign(context, { ROWS: rows, state: { rootboard: board } })
  );
  return context.out.map((q) => q.key);
}

console.log('\na question with no P0 above it is drawn\n');

try {
  await boardWhenWarm();
  // A second read, so `unhomed` is asserted off a payload where *both* workspaces have
  // been through the graph once — beta's failure is cached like any other answer, and a
  // row of beta's on the very first warm payload would be unhomed for the uninteresting
  // reason that nothing had been asked yet.
  const payload = await getJson('/api/questions');
  const board = payload.rootboard;
  const keys = payload.questions.map((q) => q.key);

  await check('the fixture is the fixture: five questions in alpha and one in beta', () => {
    assert.deepEqual(
      keys.slice().sort(),
      [
        'alpha/zz-asked',
        'alpha/zz-done.1',
        'alpha/zz-later.1',
        'alpha/zz-p0.9',
        'alpha/zz-theirs.1',
        'beta/zz-beta-asked',
      ].sort(),
      'the sweep did not return what this suite is about to make claims over'
    );
    assert.equal(board.owned, true, 'the board is off entirely — cfg.me did not take');
    assert.deepEqual(board.roots.map((c) => c.id), ['zz-p0'], 'the board is not the one root you own and have started');
  });

  await check('THE QUESTION YOU FILED WITH NO PARENT IS MARKED, AND `under` DOES NOT KNOW IT', () => {
    // The whole seam. `under` cannot carry this — there is no P0 for it to name — which
    // is why it needs a second map rather than a sentinel in the first.
    assert.equal(board.unhomed['alpha/zz-asked'], true, 'the parentless question is in no map at all');
    assert.equal(board.under['alpha/zz-asked'], undefined, '`under` grew an entry it has no P0 for');
    assert.equal(board.under['alpha/zz-p0.9'], 'zz-p0', '`under` stopped answering for the rows that do have a P0');
    assert.equal(board.unhomed['alpha/zz-p0.9'], undefined, 'a bead under your own P0 is not unhomed');
  });

  await check('a question under somebody else’s open P0 is neither — bc-rfnr.2 still narrows', () => {
    assert.equal(board.under['alpha/zz-theirs.1'], undefined, 'it is not under a P0 of yours');
    assert.equal(
      board.unhomed['alpha/zz-theirs.1'],
      undefined,
      'a bead under bob’s P0 was called unhomed — the fix has become "show everything"'
    );
  });

  await check('a question under a P0 of yours you have NOT STARTED is neither, and leaves the list', () => {
    // bc-6s96, end to end and in one place: the row is in no map, so the client's own
    // filter drops it. That is the decided cost of narrowing the board to what you have
    // started — the question is not moved anywhere and it returns the moment the epic is
    // claimed. The assertion that matters is the middle one: `unhomed` would have put it
    // straight back on the screen while claiming no P0 sits above it, which is false.
    assert.equal(board.under['alpha/zz-later.1'], undefined, 'it is under a P0 that is off the board');
    assert.equal(board.unhomed['alpha/zz-later.1'], undefined, 'an unstarted P0 of yours is still a P0 above this row');
    assert.equal(
      drawn(payload.questions, board).includes('alpha/zz-later.1'),
      false,
      'the list did not follow the narrowed board'
    );
  });

  await check('a question under a P0 that has CLOSED is unhomed', () => {
    // A closed P0 is not a root (lib/underroot.js) and the board stops pulling its
    // descendants in with it, so this bead is genuinely under nothing — the shape
    // lib/homing.js names as held forever, and it was invisible as well.
    assert.equal(board.unhomed['alpha/zz-done.1'], true, 'an open question under a finished epic is drawn nowhere');
  });

  await check('A WORKSPACE WHOSE GRAPH COULD NOT BE READ HIDES NONE OF ITS ROWS', () => {
    // `Bd.graph` answers an empty shape rather than throwing, so beta reaches the row
    // loop with no beads and no P0s — and every row of a workspace nothing is known
    // about must be shown, not dropped. `rootBoard`'s comment has said so since bc-rfnr.2.
    assert.equal(board.unhomed['beta/zz-beta-asked'], true, 'a question in an unreadable workspace is hidden');
    assert.deepEqual(board.roots.map((c) => c.workspace), ['alpha'], 'beta contributed a card it cannot have');
  });

  await check('AND THE INBOX ACTUALLY DRAWS IT — the real filter, over the real payload', () => {
    // The acceptance criterion, end to end: the board is active, P0s are owned, and the
    // question descends from no P0 of yours.
    assert.deepEqual(
      drawn(payload.questions, board).sort(),
      ['alpha/zz-asked', 'alpha/zz-done.1', 'alpha/zz-p0.9', 'beta/zz-beta-asked'].sort()
    );
  });

  await check('AND WITHOUT `unhomed` IT DOES NOT — which is the bug, stated as a test', () => {
    // The same rows through the same function with the new map taken away. If this ever
    // stops differing from the check above, the client stopped reading it.
    assert.deepEqual(drawn(payload.questions, { ...board, unhomed: {} }), ['alpha/zz-p0.9']);
  });

  await check('a pull request still follows its beads, and `unhomed` cannot speak for it', () => {
    // Its key is `pr:<repo>#<n>`, which is no bead's id, so the server never marks one —
    // and the client asks the PR rule first regardless, which is what this pins. A PR
    // naming a bead under bob's P0 stays hidden; one naming nothing stays visible.
    for (const key of Object.keys(board.unhomed)) {
      assert.ok(!key.includes('pr:'), `${key} is not a bead row and has no ancestry to claim`);
    }
    const pr = (n, beads) => ({ key: `pr:acme/thing#${n}`, workspace: 'alpha', pr: { beads } });
    const rows = [pr(1, ['zz-theirs.1']), pr(2, [])];
    const poisoned = { ...board, unhomed: { ...board.unhomed, 'pr:acme/thing#1': true } };
    assert.deepEqual(drawn(rows, poisoned), ['pr:acme/thing#2']);
  });

  await check('and none of it applies to an install that owns no P0 — the flat list, untouched', () => {
    // The three no-op cases `underOwnedRoots` opens with. `unhomed` must not become a way
    // to narrow a screen that was never being narrowed.
    assert.deepEqual(drawn(payload.questions, { ...board, owned: false }).sort(), keys.slice().sort());
    assert.deepEqual(drawn(payload.questions, { ...board, roots: [] }).sort(), keys.slice().sort());
  });
} finally {
  for (const s of servers || []) s.close?.();
  app.stop?.();
  await cleanupTmp(tmp);
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
