#!/usr/bin/env node
/**
 * A P0 card carries its own tree — every descendant, not only the ones asking something.
 *
 *     npm test
 *     node test/p0tree.mjs
 *
 * bc-rfnr.9.1. The board's first answer was `under`: one string per *inbox row* naming
 * the P0 it descends from, which is exactly what a list needs to narrow itself and
 * exactly the wrong shape for a card that expands. `under` is keyed by row, and most of
 * a P0's descendants have no row — nobody is being asked about them — so the map has its
 * hole precisely where the feature is. The card would have drawn "16 open" over a tree
 * of three.
 *
 * Five properties, and the last three are the ones that would go quietly wrong:
 *
 * 1. **A bead with no pending question is in the tree.** The whole bead. If this suite
 *    only ever asserted beads that also have inbox rows it would pass against `under`
 *    renamed, which is the near-miss worth spending a fixture on.
 * 2. **The shape nests in one pass**: flat, pre-order, every row's `parent` either the
 *    P0 or a row before it, plus a `depth` so an indent needs no walk at all.
 * 3. **The counts on the card and the rows in the tree are one answer.** They were two
 *    walks of the same graph, and two walks eventually disagree — a card reading "9
 *    open" over eight rows, where neither number looks wrong on its own.
 * 4. **`pending` does not depend on which list you are looking at.** It is read off the
 *    `human` label in the same snapshot the tree came from, not off the rows below —
 *    `/api/questions?scope=agent` sweeps no questions at all, and the board is drawn in
 *    every scope, so a rows-derived answer would have gone quiet about a bead that is
 *    genuinely waiting on you.
 * 5. **It costs no `bd`.** The tree rides the cached `Bd.graph` — one `bd export` per
 *    workspace, cached a minute, never built on the request path — so a second repaint
 *    inside that minute must spawn nothing. bc-1kwl's budget is a page under 1s and the
 *    export sweep measured 7.3s cold across nine workspaces; a tree built per request
 *    would have paid that on the poll every phone parks on.
 *
 * And the failure direction, which is the acceptance criterion this shares with the rest
 * of the board: a workspace whose graph cannot be read contributes an empty tree and no
 * card, and the payload for every other workspace arrives intact.
 *
 * The real `bd` is never run: `cfg.bdBin` is a fake that answers `export` with JSONL and
 * `human list` with rows, logs every argv, and fails outright for one workspace. No
 * network beyond loopback, nothing written outside a temp directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-p0tree-'));
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

/** One `bd export` line. */
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

/**
 * A P0 of yours with four descendants and a grandchild, one of somebody else's, one of
 * yours you have not started, and a bead under nothing.
 *
 * `zz-p0.1.1` is the fixture this suite exists for: two levels down, nobody is being
 * asked about it, so it is in no inbox row and `under` has never heard of it. `zz-p0.10`
 * is the one with a question pending, and is also where a plain string sort would file
 * the tenth child between the first and the second.
 *
 * `zz-later` is bc-6s96's: yours, P0, open, and never started. It is the whole difference
 * between a board and a backlog, and the only reason it is staged here rather than in a
 * suite of its own is that the three claims it makes are each one line against a payload
 * this file already has warm — no card, no `under` for its question, and *not* `unhomed`,
 * which is the one a narrower `roots` gets wrong for free.
 */
const EXPORT = [
  row('zz-p0', { status: 'in_progress', priority: 0, issue_type: 'epic', title: 'The P0 itself', labels: [`owner:${ME}`] }),
  row('zz-p0.1', { status: 'in_progress', assignee: ME, dependencies: [parentEdge('zz-p0.1', 'zz-p0')] }),
  // Relayed (bc-bmry.4): the journal `bin/relaystep.js` appends lives in `notes`, and
  // `notes` is on the export row — which is the whole reason the trail is stored there
  // rather than in comments. This row is what proves the mark survives the trip from a
  // `bd export` line to a tree row on the board.
  row('zz-p0.1.1', {
    notes: [
      '<!-- beadcause:relay {"at":"2026-08-18T12:00:00.000Z","role":"aria","step":"draft","note":"the outline","next":"clio"} /beadcause:relay -->',
      '<!-- beadcause:relay {"at":"2026-08-18T12:40:00.000Z","role":"clio","step":"check","note":"fact pass","flag":"two dates unsourced"} /beadcause:relay -->',
    ].join('\n'),
    dependencies: [parentEdge('zz-p0.1.1', 'zz-p0.1')],
  }),
  // Closed, and still carrying the label — a question that was answered by closing the
  // bead rather than by answering it. Nothing is waiting on you here.
  row('zz-p0.2', { status: 'closed', labels: ['human'], dependencies: [parentEdge('zz-p0.2', 'zz-p0')] }),
  row('zz-p0.10', { labels: ['human'], dependencies: [parentEdge('zz-p0.10', 'zz-p0')] }),
  row('zz-theirs', { priority: 0, labels: ['owner:bob@example.com'] }),
  row('zz-theirs.1', { dependencies: [parentEdge('zz-theirs.1', 'zz-theirs')] }),
  row('zz-later', { priority: 0, issue_type: 'epic', title: 'A P0 of yours you have not started', labels: [`owner:${ME}`] }),
  row('zz-later.1', { labels: ['human'], dependencies: [parentEdge('zz-later.1', 'zz-later')] }),
  row('zz-orphan'),
]
  .map((r) => JSON.stringify(r))
  .join('\n');

/** The beads in that tracker asking you something — one under each of your two P0s. */
const HUMAN = ['zz-p0.10', 'zz-later.1'].map((id) => ({
  id,
  title: `bead ${id}`,
  description: 'Which way?',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: ['human'],
  created_at: '2026-08-13T08:00:00Z',
  updated_at: '2026-08-13T08:00:00Z',
}));

/* ------------------------------------------------------------------ the fake bd */

const WS = ['alpha', 'beta'].map((name) => {
  const dir = path.join(tmp, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return { name, dir };
});

const BD_LOG = path.join(tmp, 'bd.log');
fs.writeFileSync(BD_LOG, '');
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const ws = String(process.env.BEADS_DIR || '').includes('beta') ? 'beta' : 'alpha';
fs.appendFileSync(${JSON.stringify(BD_LOG)}, ws + ' ' + args.join(' ') + '\\n');
// beta is the workspace this Mac cannot read — a Dolt write lock, an expired checkout, a
// tracker somebody is mid-migration on. Every other answer here has to survive it.
if (ws === 'beta') { process.stderr.write('bd: database is locked'); process.exit(1); }
if (args[0] === 'export') { process.stdout.write(${JSON.stringify(EXPORT)}); process.exit(0); }
if (args[0] === 'human' && args[1] === 'list') { process.stdout.write(${JSON.stringify(JSON.stringify(HUMAN))}); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const exportsIn = (ws) =>
  fs
    .readFileSync(BD_LOG, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith(`${ws} export`)).length;

/* -------------------------------------------------------------------- the daemon */

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'p0tree-token',
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
 * The board is deliberately not built on the request path — `Bd.graph({ wait: false })`
 * answers with whatever is on hand and refreshes behind it — so the first payload after
 * a cold start has no P0s in it, by design, and the second or third does. Asking until it
 * lands is what a phone does anyway; a fixed sleep would be a flake on a loaded Mac.
 */
async function boardWhenWarm() {
  for (let i = 0; i < 60; i += 1) {
    const payload = await getJson('/api/questions');
    if ((payload.rootboard?.roots || []).length) return payload;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the epic board never warmed up — no roots after six seconds of asking');
}

console.log('\na P0 card carries its own tree\n');

try {
  const cold = await getJson('/api/questions');
  const payload = await boardWhenWarm();
  const [card, ...rest] = payload.rootboard.roots;
  const tree = card.tree || [];
  const byId = new Map(tree.map((r) => [r.id, r]));

  await check('a cold board answers with no P0s rather than waiting for `bd export`', () => {
    // The `wait: false` contract, and the state the client already reads as "do not
    // narrow anything". If this ever starts arriving warm, the export moved onto the
    // request path and bc-1kwl's page budget went with it.
    assert.equal(cold.rootboard.owned, true, 'the board is off entirely — cfg.me did not take');
    assert.deepEqual(cold.rootboard.roots, [], 'the first payload waited for the tracker');
  });

  await check('the board is the P0s you own, and each one carries a tree', () => {
    assert.deepEqual(rest, [], 'somebody else’s P0 is on your board');
    assert.equal(card.id, 'zz-p0');
    assert.ok(Array.isArray(card.tree), '/api/questions carries no tree at all');
  });

  await check('A P0 OF YOURS YOU HAVE NOT STARTED DRAWS NO CARD — the board is not the backlog', () => {
    // bc-6s96. zz-later is yours, P0 and open; the only thing it is not is `in_progress`.
    // Before this rule it drew a card indistinguishable from the one above it, and 42 of
    // them drew a screen you scroll rather than a week you read.
    assert.deepEqual(
      payload.rootboard.roots.map((c) => c.id),
      ['zz-p0'],
      'an unstarted P0 is still on the board'
    );
  });

  await check('AND ITS QUESTION LEAVES THE LIST WITHOUT BEING CALLED UNHOMED', () => {
    // The decided consequence, and the one thing it must not become. `under` is keyed on
    // the board's roots, so the row drops out of the narrowed list — that is intended, and
    // it comes back the moment the epic is started. `unhomed` means "no open P0 above this
    // at all", which is false here: zz-later is open. Marking it would put the row back on
    // the screen through the map that exists for beads nobody has homed, which is both a
    // lie about the tracker and this feature quietly not working.
    assert.equal(payload.rootboard.under['alpha/zz-later.1'], undefined, '`under` still names a P0 that is off the board');
    assert.equal(
      payload.rootboard.unhomed['alpha/zz-later.1'],
      undefined,
      'a row under an unstarted P0 of yours was reclassified as having no P0 above it'
    );
    // And the sweep did fetch it, so the two assertions above are about a row that exists.
    assert.equal(payload.questions.some((q) => q.key === 'alpha/zz-later.1'), true, 'the fixture question never arrived');
  });

  await check('A DESCENDANT NOBODY IS ASKING ABOUT IS IN THE TREE — the whole bead', () => {
    // zz-p0.1.1 has no `human` label, so it has no inbox row, so it is in no `under`
    // map anywhere. A tree derived from the rows cannot contain it, and this assertion
    // is the only thing separating this feature from `under` under another name.
    assert.deepEqual(
      tree.map((r) => r.id),
      ['zz-p0.1', 'zz-p0.1.1', 'zz-p0.10', 'zz-p0.2']
    );
    assert.equal(payload.rootboard.under['alpha/zz-p0.1.1'], undefined, 'the row map has grown a row it should not have');
    assert.equal(payload.rootboard.under['alpha/zz-p0.10'], 'zz-p0', '`under` stopped answering for the rows that do exist');
  });

  await check('it nests in one pass: pre-order, a parent on every row, a depth on every row', () => {
    const drawn = new Set(['zz-p0']);
    for (const r of tree) {
      assert.ok(drawn.has(r.parent), `${r.id} names a parent that has not been drawn yet`);
      drawn.add(r.id);
    }
    assert.equal(byId.get('zz-p0.1').depth, 1);
    assert.equal(byId.get('zz-p0.1.1').depth, 2, 'a grandchild at depth 1 would draw flat under the P0');
    assert.equal(byId.get('zz-p0.1.1').parent, 'zz-p0.1');
  });

  await check('a row carries what a row draws, and the key the rest of the inbox is filed under', () => {
    assert.deepEqual(byId.get('zz-p0.1'), {
      id: 'zz-p0.1',
      title: 'bead zz-p0.1',
      issue_type: 'task',
      status: 'in_progress',
      priority: 2,
      assignee: ME,
      parent: 'zz-p0',
      depth: 1,
      key: 'alpha/zz-p0.1',
      pending: false,
      // Who is in this bead's window right now, for the expansion's "what happened to
      // it" (bc-rfnr.9.5). `null` here because this suite runs no sessions — and the
      // field is asserted rather than skipped precisely because it is the cheap half:
      // the live pid rides the poll on the row, so a row that stopped carrying it would
      // take the live link off every open bead without a word.
      session: null,
      // And where a department relay on it has got to (bc-bmry.4). `null` here for the
      // ordinary reason it is null on almost every row in every tracker: nothing has
      // relayed this bead, so its notes carry no journal. Asserted rather than skipped
      // for `session`'s reason — the mark rides the poll on the row, and a row that
      // stopped carrying it would take the relay off the whole board without a word.
      relay: null,
    });
  });

  await check('a relayed bead carries where its relay got to, off the export row', () => {
    // The end-to-end the pure suite cannot reach: a journal written into `notes` reaches a
    // tree row on the board as the last step alone. bc-bmry.4.
    assert.deepEqual(byId.get('zz-p0.1.1').relay, {
      role: 'clio',
      step: 'check',
      at: '2026-08-18T12:40:00.000Z',
      steps: 2,
      flagged: 1,
      flag: 'two dates unsourced',
    });
    // And the whole trail is not on it: sixty rows carrying every entry is a relay's
    // history on the poll payload once per descendant per repaint, to draw one line.
    assert.ok(!('entries' in byId.get('zz-p0.1.1').relay));
  });

  await check('`pending` is the bead’s own question, and a closed one is not pending', () => {
    assert.equal(byId.get('zz-p0.10').pending, true, 'the one bead asking something does not say so');
    assert.deepEqual(
      tree.filter((r) => r.pending).map((r) => r.id),
      ['zz-p0.10']
    );
    // zz-p0.2 still carries `human` and has closed. A question that closed is not one
    // waiting on you, and the label alone would have said it was.
    assert.equal(byId.get('zz-p0.2').pending, false);
    // And it is a boolean, not the row: the row is already in `questions`, and two
    // copies of one answer's state on one payload is two things to keep in step.
    assert.equal(payload.questions.some((q) => q.key === 'alpha/zz-p0.10'), true);
  });

  await check('AND IT SURVIVES A SCOPE THAT SWEEPS NO QUESTIONS AT ALL', () => {
    // The reason `pending` is read off the label rather than off the rows the list is
    // drawn from: `scope=agent` runs no `human` sweep, so a rows-derived answer would
    // say nothing is waiting on you on a screen the board is still drawn on. That is
    // the app's one unforgivable failure — a question on a screen that will not show it.
    return getJson('/api/questions?scope=agent').then((agentScope) => {
      assert.deepEqual(agentScope.questions, [], 'this scope is supposed to sweep no questions');
      const same = agentScope.rootboard.roots[0].tree.find((r) => r.id === 'zz-p0.10');
      assert.equal(same.pending, true, 'the bead waiting on you went quiet when the scope changed');
    });
  });

  await check('THE COUNTS ON THE CARD AND THE ROWS IN THE TREE ARE ONE ANSWER', () => {
    const live = tree.filter((r) => r.status !== 'closed');
    assert.equal(card.open, live.length);
    assert.equal(card.open, 3, 'zz-p0.2 is closed and is not what is left');
    assert.equal(card.inFlight, live.filter((r) => r.status === 'in_progress').length);
    assert.equal(card.inFlight, 1);
  });

  await check('a closed descendant is still sent, because the filter over it is the client’s', () => {
    // bc-rfnr.9.6 defaults the board to not-closed, which it can only do if the closed
    // ones arrived. The card's counts are of what is left; the tree is the board.
    assert.equal(byId.get('zz-p0.2').status, 'closed');
  });

  await check('A WORKSPACE THAT CANNOT BE READ CONTRIBUTES AN EMPTY TREE, NOT A FAILURE', () => {
    // beta's `bd` exits 1 on everything. The acceptance criterion is that this costs
    // beta's cards and nothing else — a board that threw here would take the inbox with
    // it, on the one payload the phone parks on.
    assert.ok(exportsIn('beta') > 0, 'beta was never asked, so this proves nothing');
    assert.deepEqual(payload.rootboard.roots.map((c) => c.workspace), ['alpha']);
    assert.equal(payload.rootboard.owned, true);
    assert.ok(Array.isArray(payload.trouble), 'a repo that could not be read says so somewhere');
  });

  await check('AND IT COSTS NO `bd`: a second repaint inside the minute spawns nothing', () => {
    // The whole reason this rides `Bd.graph` rather than walking the tracker: 7.3s of
    // `bd export` across nine workspaces, once a minute, not once a repaint.
    const before = exportsIn('alpha');
    return getJson('/api/questions').then((again) => {
      assert.equal(exportsIn('alpha'), before, 'the tree was rebuilt from the tracker on the request path');
      assert.equal(again.rootboard.roots[0].tree.length, tree.length, 'the second repaint drew a different tree');
    });
  });
} finally {
  for (const s of servers || []) s.close?.();
  app.stop?.();
  await cleanupTmp(tmp);
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
