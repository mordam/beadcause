/**
 * One advocate, many checkouts: what it queues, where it launches, and what it says.
 *
 * bc-l853.4. An advocate is one per *workspace*, and until Climative every workspace was
 * also one repo. Forty checkouts behind a single `cl-` graph breaks three things at once,
 * and this suite is one case per break:
 *
 *   - **the launch** — two beads naming two different repos are two windows in two
 *     checkouts, inside one workspace's `maxWorkers`, in the same tick;
 *   - **the card** — each worker row names the checkout its window is actually in,
 *     because "climative" no longer says where anything landed;
 *   - **the queue** — a bead naming a checkout nothing can resolve is *held*, with the
 *     reason on the card, rather than handed to a launch that refuses it. The refusal at
 *     launch time costs the bead one of its `maxAttemptsPerBead` and `break`s the launch
 *     loop, so one mislabelled bead would stop every other repo for the whole tick.
 *
 * And the fourth, which is the one that would fail silently: every sweep that asks a
 * *checkout* something has to ask all of them. A bead whose work sits in an open pull
 * request in `athena-service` looks, to a sweep that only ever asked `architecture`,
 * exactly like a bead nobody has started — bc-utyr with the repo name changed.
 *
 *     node test/repoqueue.mjs
 *
 * Built on test/prqueue.mjs's harness: `open` and `prs` are injected, so a tick that
 * would have opened an iTerm window pushes a record onto an array instead and nothing
 * here needs a `gh` on PATH. The one thing not faked is the resolution itself — `open`
 * calls the real `resolveSessionDir(cfg, ws, bead)`, so what the card reports is the
 * whole chain from the bead's label to a directory on disk, not a string this file made
 * up.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-repoqueue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
fs.mkdirSync(SESSIONS, { recursive: true });

/** The Climative tree in miniature, tokens and collision included. */
const ORG = path.join(tmp, 'climative.dev');
const CHECKOUTS = {
  architecture: 'architecture',
  'athena-service': 'as',
  // The real collision, in two repos rather than three: `as` is declared by
  // athena-service, audit-service and rules-engine-service on the actual Mac, and a
  // resolver that answered the first match would open a session in whichever sorted
  // first. See lib/repos.js.
  'audit-service': 'as',
  'building-service': 'bs',
};
for (const [name, token] of Object.entries(CHECKOUTS)) {
  fs.mkdirSync(path.join(ORG, name, 'config'), { recursive: true });
  fs.writeFileSync(path.join(ORG, name, 'config', 'config.yaml'), `serviceToken: ${token}\nother: yes\n`);
}

/** And an ordinary one-repo workspace, to prove nothing here reaches it. */
const PLAIN = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(PLAIN, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { resolveSessionDir } = await import(LIB('session.js'));
const { forgetRepos } = await import(LIB('repos.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, title, labels = [], over = {}) => ({
  id,
  title,
  priority: 2,
  issue_type: 'task',
  created_at: OLD,
  labels,
  ...over,
});

/** What `openWork` hands back for one checkout: bead id → the pull request carrying it. */
const carrying = (ids) => ({
  ok: true,
  reason: '',
  checked: ids.length,
  beads: new Map(
    ids.map((id) => [
      id,
      { number: 115, url: 'https://x/115', title: 'the PR', branch: 'b', draft: false, mergeable: 'MERGEABLE' },
    ])
  ),
});

const nothingOpen = () => carrying([]);
const cannotSay = (reason) => ({ ok: false, reason, checked: 0, beads: new Map() });

/**
 * One tick against a workspace of several checkouts.
 *
 * `approved` and `fallback` are per case because the whole point of the block is that it
 * is a list somebody writes: an unapproved repo has to be invisible, and a `default` that
 * does not resolve has to be a sentence rather than a guess.
 *
 * `prs` is keyed by checkout name, which is what makes the sweep's coverage assertable:
 * a fake that answered the same thing whatever it was asked could not tell "asked every
 * repo" from "asked the first one twice".
 */
async function tick({
  ready = [],
  approved = ['architecture', 'athena-service', 'building-service'],
  fallback = 'architecture',
  prs = null,
  overrides = {},
  repos = undefined,
} = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case: state, the activity file the launch stamps, and the worker
  // markers. Otherwise case N's worker is still in case N+1's queue.
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  // The repo list is memoised against the block and the token files' mtimes, and two
  // cases a millisecond apart can share a stamp. Nothing in the daemon needs this; a
  // suite rewriting the same paths in the same second does.
  forgetRepos();

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    spaces: [],
    workspaces: [{ name: 'climative', dir: path.join(os.homedir(), 'beads', 'climative', '.beads') }],
    repos:
      repos === undefined ? { climative: { root: ORG, default: fallback, approved } } : repos,
    sessionDirs: { climative: PLAIN },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Features with their own suites, each of which would otherwise run real git, a
      // real `gh` or a real agent against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      sessionLog: false,
      // Batching is the *fallback* since bc-jk4m — an epic nobody has planned goes to an
      // epic worker first, and only an epic that cannot be planned is batched. This suite
      // is about which checkout a batch opens in, so it turns planning off and tests the
      // fallback directly; test/epicplan.mjs owns the other branch.
      planEpics: false,
      holdOpenPrs: prs !== null,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const opened = [];
  const asked = [];
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => [],
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    // The real resolver, not a stub: this is the whole chain the card later reports.
    open: async (c, ws, b) => {
      const where = resolveSessionDir(c, ws, b);
      opened.push({ id: b.id, dir: where });
      return { dir: where, mode: 'test', term: null };
    },
    // Injected for the reason `open` is, and it is the more important of the two here:
    // the default is the real `openPlanSession`, which drives iTerm. A suite must never be
    // able to open a window by regressing.
    openPlan: async () => {
      throw new Error('openPlan must not be reached with planEpics off');
    },
    prs: async (_bd, _ws, where) => {
      const name = path.basename(where);
      asked.push(name);
      return (prs && prs[name]) || nothingOpen();
    },
  });
  await advocates.tick();
  return { opened, asked, card: advocates.snapshot().find((a) => a.workspace === 'climative') };
}

const openedIds = (r) => r.opened.map((o) => o.id).sort();
const repoOf = (card, id) => (card.workers.find((w) => w.id === id) || {}).repo || null;
const heldIds = (card) => card.heldByRepo.map((h) => h.id).sort();
const whyFor = (card, id) => (card.heldByRepo.find((h) => h.id === id) || {}).why || '';

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/* ------------------------------------------------------------------ the cases */

/** The acceptance criterion, in the smallest queue that can hold it. */
await check('two beads naming two repos are two windows, in one workspace tick', async () => {
  const r = await tick({
    ready: [bead('cl-1', 'Athena wants a thing', ['repo:as']), bead('cl-2', 'Buildings want another', ['repo:bs'])],
  });

  assert.deepEqual(openedIds(r), ['cl-1', 'cl-2'], 'both, in the same tick');
  const where = Object.fromEntries(r.opened.map((o) => [o.id, path.basename(o.dir)]));
  assert.equal(where['cl-1'], 'athena-service', `cl-1 landed in ${where['cl-1']}`);
  assert.equal(where['cl-2'], 'building-service', `cl-2 landed in ${where['cl-2']}`);
});

/** And the card says which of the forty each window is in — the other half of it. */
await check('the card names the checkout each worker is in', async () => {
  const { card } = await tick({
    ready: [bead('cl-1', 'a', ['repo:as']), bead('cl-2', 'b', ['repo:bs'])],
  });

  assert.equal(repoOf(card, 'cl-1'), 'athena-service');
  assert.equal(repoOf(card, 'cl-2'), 'building-service');
  assert.deepEqual(card.repos, ['architecture', 'athena-service', 'building-service'], 'and which repos it spans');
});

/** A bead carrying no token is the default repo's, which is a real answer. */
await check('a bead naming no repo belongs to the default one', async () => {
  const { card, opened } = await tick({ ready: [bead('cl-3', 'no label at all')] });
  assert.equal(path.basename(opened[0].dir), 'architecture');
  assert.equal(repoOf(card, 'cl-3'), 'architecture');
});

/** The cap is per workspace and stays per workspace — three repos, one limit. */
await check('maxWorkers counts the workspace, not the repo', async () => {
  const r = await tick({
    ready: [
      bead('cl-1', 'a', ['repo:as']),
      bead('cl-2', 'b', ['repo:bs']),
      bead('cl-3', 'c', ['repo:architecture']),
    ],
    overrides: { maxWorkers: 2 },
  });

  assert.equal(r.opened.length, 2, 'two windows across three repos, because the limit is 2');
  assert.equal(r.card.limit, 2, 'and the limit on the card is the workspace\'s, not a repo\'s');
  assert.equal(r.card.queue, 3, 'the third is queued rather than dropped — it waits for a slot');
  assert.match(r.card.note, /3 ready · opening 2 session/, r.card.note);
});

/**
 * The queue half. An unknown token is usually a repo nobody approved rather than a typo,
 * and the sentence says which — but the thing that matters here is that it is *held*
 * rather than launched-and-refused.
 */
await check('a bead naming a repo nothing approves is held, not launched', async () => {
  const { opened, card } = await tick({
    ready: [bead('cl-9', 'in a repo nobody approved', ['repo:ws'])],
  });

  assert.deepEqual(opened, [], 'no window');
  assert.equal(card.queue, 0, 'and out of the queue, not merely unpicked');
  assert.deepEqual(heldIds(card), ['cl-9'], 'held, and visible as held');
  assert.match(whyFor(card, 'cl-9'), /no approved climative repo declares/, whyFor(card, 'cl-9'));
  assert.match(whyFor(card, 'cl-9'), /athena-service \(as\)/, 'and says what is approved');
});

/** The collision, which is the one case where an answer exists and is withheld. */
await check('a token two approved repos both declare refuses rather than guesses', async () => {
  const { opened, card } = await tick({
    ready: [bead('cl-9', 'ambiguous', ['repo:as'])],
    approved: ['architecture', 'athena-service', 'audit-service'],
  });

  assert.deepEqual(opened, []);
  assert.deepEqual(heldIds(card), ['cl-9']);
  assert.match(whyFor(card, 'cl-9'), /will not guess between them/, whyFor(card, 'cl-9'));
  assert.match(whyFor(card, 'cl-9'), /audit-service/, 'and names both');
});

/** Two `repo:` labels is the same failure written by hand. */
await check('a bead labelled for two repos is held with its own sentence', async () => {
  const { card } = await tick({ ready: [bead('cl-9', 'two labels', ['repo:as', 'repo:bs'])] });
  assert.deepEqual(heldIds(card), ['cl-9']);
  assert.match(whyFor(card, 'cl-9'), /2 service tokens/, whyFor(card, 'cl-9'));
});

/**
 * The reason this is a filter rather than a refusal at launch time: one bead nothing can
 * place must not take the tick's other launches down with it. The old path would have
 * cost `cl-9` an attempt and hit `break`, and `cl-1` would have waited for the next tick.
 */
await check('a bead nothing can place does not stop the others launching', async () => {
  const { opened, card } = await tick({
    ready: [bead('cl-9', 'unplaceable', ['repo:ws']), bead('cl-1', 'fine', ['repo:as'])],
  });

  assert.deepEqual(openedIds({ opened }), ['cl-1'], 'the placeable one still gets its window');
  assert.deepEqual(heldIds(card), ['cl-9']);
  assert.equal(card.error, null, 'and it is not reported as a failure — it is a hold');
});

/** A queue emptied by this filter is not a clear one, and must not propose over it. */
await check('an emptied queue says why, and proposes nothing over it', async () => {
  const { card } = await tick({
    ready: [bead('cl-9', 'unplaceable', ['repo:ws'])],
    overrides: { propose: true },
  });

  assert.equal(card.queue, 0);
  assert.match(card.note, /naming no checkout this workspace can work in/, card.note);
  assert.equal(card.lastProposalAt, null, 'nothing was proposed over a queue this emptied itself');
});

/**
 * The sweep. Every checkout, not the workspace's default one — a fake keyed by repo is
 * what makes the difference between "asked all three" and "asked the first one" visible.
 */
await check('the open-PR sweep asks every approved checkout', async () => {
  const { asked } = await tick({
    ready: [bead('cl-1', 'a', ['repo:as'])],
    prs: { architecture: nothingOpen(), 'athena-service': nothingOpen(), 'building-service': nothingOpen() },
  });

  assert.deepEqual([...new Set(asked)].sort(), ['architecture', 'athena-service', 'building-service']);
});

/** And a pull request in one of the others holds its bead, naming the repo it is in. */
await check('a pull request in a non-default repo still holds its bead', async () => {
  const { opened, card } = await tick({
    ready: [bead('cl-1', 'a', ['repo:as'])],
    prs: { architecture: nothingOpen(), 'athena-service': carrying(['cl-1']), 'building-service': nothingOpen() },
  });

  assert.deepEqual(opened, [], 'held — bc-utyr, one repo along');
  assert.deepEqual(card.heldByPr.map((h) => h.id), ['cl-1']);
  assert.equal(card.heldByPr[0].repo, 'athena-service', 'and the card says which of the forty');
  assert.match(card.heldByPr[0].why, /in athena-service/, card.heldByPr[0].why);
});

/**
 * One checkout that will not answer is not the sweep failing. The others still have pull
 * requests open in them, and holding nothing back on the strength of one `gh` timing out
 * is the exact failure the sweep exists to prevent.
 */
await check('one checkout refusing does not throw away the others', async () => {
  const { opened, card } = await tick({
    ready: [bead('cl-1', 'a', ['repo:as'])],
    prs: {
      architecture: cannotSay('gh pr list failed — timed out'),
      'athena-service': carrying(['cl-1']),
      'building-service': nothingOpen(),
    },
  });

  assert.deepEqual(opened, [], 'the answer that did arrive is still acted on');
  assert.deepEqual(card.heldByPr.map((h) => h.id), ['cl-1']);
  assert.match(card.inflight.summary, /did not answer/, card.inflight.summary);
});

/** And nothing answering keeps the previous map, because an empty one holds nothing. */
await check('no checkout answering holds nothing new and says so', async () => {
  const { card } = await tick({
    ready: [bead('cl-1', 'a', ['repo:as'])],
    prs: {
      architecture: cannotSay('gh is not on PATH'),
      'athena-service': cannotSay('gh is not on PATH'),
      'building-service': cannotSay('gh is not on PATH'),
    },
  });

  assert.deepEqual(card.heldByPr, [], 'nothing held on a read that never happened');
  assert.match(card.inflight.summary, /skipped/, card.inflight.summary);
});

/**
 * An unapproved repo is invisible, whatever is on disk. `audit-service` exists, declares
 * a token, and is simply not on the list — so a bead naming it is held exactly like a
 * bead naming a repo that does not exist at all.
 */
await check('a repo on disk but not approved resolves to nothing', async () => {
  const { opened, card } = await tick({
    ready: [bead('cl-9', 'audit', ['repo:as'])],
    approved: ['architecture', 'building-service'],
  });

  assert.deepEqual(opened, []);
  assert.deepEqual(heldIds(card), ['cl-9']);
});

/**
 * And the case every other suite in this repo is: one workspace, one repo, nothing to
 * place. `multiRepo` is false, so not a label is read and not a `statSync` is paid —
 * and a stray `repo:` label holds nothing, because there is nothing for it to name.
 */
await check('a single-repo workspace is untouched, stray label and all', async () => {
  const { opened, card } = await tick({
    ready: [bead('cl-1', 'a'), bead('cl-2', 'b', ['repo:as'])],
    repos: {},
  });

  assert.deepEqual(openedIds({ opened }), ['cl-1', 'cl-2'], 'both launched');
  assert.deepEqual(card.heldByRepo, [], 'nothing held');
  assert.equal(card.repos, null, 'and the card draws no repo list at all');
  assert.deepEqual(
    card.workers.map((w) => w.repo),
    [null, null],
    'and no worker row claims to be in a repo'
  );
  assert.deepEqual([...new Set(opened.map((o) => o.dir))], [PLAIN], 'the sessionDirs answer, unchanged');
});

/**
 * Where this block meets bc-bhp9's batching: an epic hands its ready children to one
 * worker, and one worker opens in exactly one checkout — the epic's. So a child naming a
 * *different* approved repo must not be in that brief, or it gets worked in the wrong tree
 * while the brief reads perfectly reasonably.
 *
 * This case lives here rather than in test/epicqueue.mjs because `placeFor` is gated on
 * `multiRepo`: in a single-repo fixture every bead resolves to `repo: null`, they all
 * compare equal, and the guard is unreachable. The approved-repo block and the real
 * resolver are what make the question askable at all.
 */
await check('a batch does not cross checkouts', async () => {
  const { opened, card } = await tick({
    ready: [
      bead('cl-e', 'The epic', ['repo:architecture'], { issue_type: 'epic' }),
      bead('cl-e.1', 'First child', ['repo:architecture']),
      bead('cl-e.2', 'Second child', ['repo:architecture']),
      bead('cl-e.3', 'A child in another repo', ['repo:athena-service']),
    ],
    overrides: { maxWorkers: 4 },
  });

  assert.deepEqual(
    opened.map((o) => o.id),
    ['cl-e'],
    'one window, and it is the epic that carries the batch'
  );
  const batch = ((card.workers.find((w) => w.id === 'cl-e') || {}).batch || []).slice().sort();
  assert.deepEqual(batch, ['cl-e.1', 'cl-e.2'], 'only the children in the epic’s own checkout');
  assert.equal(repoOf(card, 'cl-e'), 'architecture', 'and the worker row names the checkout it opened in');
});

/* --------------------------------------------------------------------- report */

console.log('');
if (failures) {
  console.error(`${failures} of ${ran} checks failed`);
  process.exit(1);
}
console.log(`all ${ran} checks passed`);
