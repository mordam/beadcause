#!/usr/bin/env node
/**
 * lib/skills.js — the numbers behind the Skills view, and the four that are not numbers.
 *
 *     npm test
 *     node test/skills.mjs
 *
 * bc-dgx7.5's acceptance is that every number on the page is either measured or labelled
 * untracked, and that a candidate bead is reachable. Three of those are things that fail
 * *quietly*, which is why they are asserted here rather than eyeballed:
 *
 * 1. **A candidate's state is read off fields something else writes**, and the three
 *    markers overlap. A revoke closes the bead and deliberately leaves the `unendorsed`
 *    hold on it, so the obvious marker test counts every declined candidate as one still
 *    waiting on you — a screen that reports four beads asking for a decision when nothing
 *    is. The order in `candidateState` is the whole of the fix and it is pinned below.
 * 2. **The untracked list is data, not prose.** A page whose adoption section is missing
 *    reads as a healthy programme rather than an incomplete screen, so the entries are
 *    checked to exist, to be distinct, and each to name the bead that would make it real.
 * 3. **Nothing here may throw at the route.** A repo that has moved, a `bd` that fell
 *    over, a workspace naming no checkout — each is a sentence on the screen. A page that
 *    500s because one of forty checkouts is gone is a page nobody can read the other
 *    thirty-nine on.
 *
 * The git is real and the ledger is written by lib/sessionaudit.js's own `writeRun`,
 * because the point of reading it is that it survived a restart and a fake would be a
 * test of the fake. The tracker is a stub that records what it was asked.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-skills-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  CANDIDATE_STATES,
  UNTRACKED,
  candidateState,
  checkoutsOf,
  commandOf,
  readCandidates,
  readCheckout,
  skillsView,
} = await import(LIB('skills.js'));
const { CANDIDATE_LABEL, SKILL_LABEL, candidateBead, writeRun } = await import(LIB('sessionaudit.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const { REVOKED_REASON } = await import(LIB('verdict.js'));
const { supersedeLabel } = await import(LIB('superseded.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const checks = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checksAsync = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ------------------------------------------------------------------- the repo */

const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
execFileSync('git', ['-C', repo, 'init', '-q', '--initial-branch=main']);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'beadcause@localhost']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'beadcause']);
fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
execFileSync('git', ['-C', repo, 'add', 'README.md']);
execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'fixture']);

const cfg = { workspaces: [{ name: 'beadcause', dir: path.join(repo, '.beads') }], sessionDirs: { beadcause: repo } };
const ws = cfg.workspaces[0];

/* ------------------------------------------------- what state a candidate is in */

console.log('\nthe four states, and the order they are decided in');

const held = { id: 'bc-1', title: 'b7e-context — one command assembles a session context', labels: [SKILL_LABEL, CANDIDATE_LABEL, UNENDORSED], status: 'open' };

checks('a candidate arrives waiting', () => assert.equal(candidateState(held), 'waiting'));

checks('endorsed — the hold gone — is accepted', () => {
  assert.equal(candidateState({ ...held, labels: [SKILL_LABEL, CANDIDATE_LABEL] }), 'accepted');
});

checks('and stays accepted once it has shipped and closed', () => {
  assert.equal(
    candidateState({ ...held, labels: [SKILL_LABEL, CANDIDATE_LABEL], status: 'closed', close_reason: 'Merged #431 into main' }),
    'accepted'
  );
});

/* The one that has to be pinned. lib/verdict.js closes a revoked bead and leaves the
   `unendorsed` marker on it on purpose, so a state read that looked at labels first would
   report every declined candidate as one still waiting on an answer. */
checks('a revoke is declined, not waiting — the hold is still on the bead', () => {
  const revoked = { ...held, status: 'closed', close_reason: REVOKED_REASON };
  assert.ok(revoked.labels.includes(UNENDORSED), 'the fixture must keep the marker or it proves nothing');
  assert.equal(candidateState(revoked), 'declined');
});

checks('superseded outranks both — it may be held and it may be closed', () => {
  const gone = { ...held, labels: [...held.labels, supersedeLabel('bc-dgx7.3')], status: 'closed', close_reason: REVOKED_REASON };
  assert.equal(candidateState(gone), 'superseded');
});

checks('every state a row can be in is one the page draws', () => {
  const seen = new Set(
    [
      held,
      { ...held, labels: [SKILL_LABEL] },
      { ...held, status: 'closed', close_reason: REVOKED_REASON },
      { ...held, labels: [...held.labels, supersedeLabel('bc-2')] },
    ].map(candidateState)
  );
  for (const s of seen) assert.ok(CANDIDATE_STATES.includes(s), `${s} is not in CANDIDATE_STATES`);
});

/* -------------------------------------------------------------- the command name */

console.log('\nthe command a candidate proposes');

checks('is read off the title the audit agent writes', () => {
  const bead = candidateBead({
    command: 'b7e-context',
    title: 'one command assembles a session opening context',
    sessions: ['bc-a', 'bc-b', 'bc-c'],
    evidence: 'three sessions each read the same five things',
    takes: 'a bead id',
    returns: 'markdown',
    where: 'bin/b7e-context.js',
  });
  assert.equal(commandOf(bead), 'b7e-context');
});

checks('a title somebody rewrote yields no command rather than a wrong one', () => {
  assert.equal(commandOf({ title: 'assemble the context, somehow' }), '');
  assert.equal(commandOf({ title: 'b7e- — a hyphen and nothing else' }), '');
});

/* ------------------------------------------------------------- what is not tracked */

console.log('\nthe metrics nothing records');

checks('there are some, and each says what it is', () => {
  assert.ok(UNTRACKED.length >= 4, `only ${UNTRACKED.length} untracked metrics listed`);
  for (const u of UNTRACKED) {
    assert.ok(u.id, 'an entry with no id');
    assert.ok(u.metric?.length > 10, `${u.id}: no metric written`);
    assert.ok(u.why?.length > 30, `${u.id}: "not tracked" with no reason is an apology, not a plan`);
  }
});

checks('and each names the bead that would make it a number', () => {
  for (const u of UNTRACKED) assert.match(u.owed || '', /^bc-[a-z0-9.]+$/, `${u.id}: owed is "${u.owed}"`);
});

checks('no metric is listed twice', () => {
  const ids = UNTRACKED.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(', '));
});

/* --------------------------------------------------------------- one checkout */

console.log('\none checkout — its library and its ledger');

checks('a workspace with a checkout resolves to one unit', () => {
  const found = checkoutsOf(cfg, ws);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'beadcause');
  assert.equal(found[0].dir, repo);
});

checks('and one whose directory has gone is a sentence, not a throw', () => {
  const broken = { workspaces: [{ name: 'gone', dir: '/nowhere/.beads' }], sessionDirs: { gone: '/nowhere/at/all' } };
  const found = checkoutsOf(broken, broken.workspaces[0]);
  assert.equal(found.length, 1);
  assert.ok(found[0].problem, 'a missing checkout must say so');
  assert.equal(found[0].dir, null);
});

await checksAsync('an empty repo has an empty library and an empty ledger', async () => {
  const row = await readCheckout({ key: 'beadcause', workspace: 'beadcause', repo: '', dir: repo, problem: '' });
  assert.deepEqual(row.library, []);
  assert.equal(row.runs, 0);
  assert.equal(row.audited, 0);
  assert.equal(row.problem, '');
});

await checksAsync('a checkout that is not there answers rather than throwing', async () => {
  const row = await readCheckout({ key: 'gone', workspace: 'gone', repo: '', dir: null, problem: '' });
  assert.ok(row.problem, 'no problem recorded');
  assert.deepEqual(row.library, []);
});

// The library the way `skillLibrary` reads one: a file in `bin/` *or* a key in the bin
// map. Both, here, because the union is what the audit agent decides candidate-versus-miss
// against and a view that disagreed with it would call a shipped command a candidate.
fs.writeFileSync(path.join(repo, 'bin', 'b7e-context.js'), '#!/usr/bin/env node\n');
fs.writeFileSync(
  path.join(repo, 'package.json'),
  JSON.stringify({ name: 'fixture', bin: { 'b7e-brief': 'bin/b7e-brief.js', beadcause: 'bin/beadcause.js' } }, null, 2)
);

await checksAsync('a shipped command is found in bin/ and in the bin map, and nothing else is', async () => {
  const row = await readCheckout({ key: 'beadcause', workspace: 'beadcause', repo: '', dir: repo, problem: '' });
  assert.deepEqual(row.library, ['b7e-brief', 'b7e-context']);
});

// One real run through lib/sessionaudit.js's own writer, so what is read back is what a
// restarted daemon would read back.
const run = {
  at: '2026-08-17T12:00:00.000Z',
  sessions: [
    { bead: 'bc-a', commit: 'a'.repeat(40), at: '2026-08-17T11:00:00Z' },
    { bead: 'bc-b', commit: 'b'.repeat(40), at: '2026-08-17T11:30:00Z' },
  ],
  filed: [{ bead: 'bc-cand1', slug: 'b7e-context', title: 'b7e-context — assembles a session context' }],
  misses: [{ slug: 'b7e-brief', existing: 'b7e-brief', sessions: ['bc-a', 'bc-b', 'bc-c'] }],
  dropped: [],
  error: null,
};
await writeRun(repo, run);

await checksAsync('the ledger is read back — runs, archives read, and the miss', async () => {
  const row = await readCheckout({ key: 'beadcause', workspace: 'beadcause', repo: '', dir: repo, problem: '' });
  assert.equal(row.runs, 1);
  assert.equal(row.audited, 2);
  assert.equal(row.filed, 1);
  assert.equal(row.misses.length, 1);
  assert.equal(row.misses[0].slug, 'b7e-brief');
  assert.equal(row.at, run.at);
});

/* ------------------------------------------------------------------ the tracker */

console.log('\nthe candidates');

const rows = [
  {
    id: 'bc-cand1',
    title: 'b7e-context — assembles a session context',
    labels: [SKILL_LABEL, CANDIDATE_LABEL],
    status: 'open',
    priority: 2,
    created_at: '2026-08-17T12:00:00Z',
    updated_at: '2026-08-17T13:00:00Z',
  },
  {
    id: 'bc-cand2',
    title: 'b7e-landed — did this branch land',
    labels: [SKILL_LABEL, CANDIDATE_LABEL, UNENDORSED],
    status: 'open',
    priority: 2,
    created_at: '2026-08-16T12:00:00Z',
  },
  {
    id: 'bc-cand3',
    title: 'b7e-tidy — sweep the retired worktrees',
    labels: [SKILL_LABEL, CANDIDATE_LABEL, UNENDORSED],
    status: 'closed',
    close_reason: REVOKED_REASON,
    created_at: '2026-08-15T12:00:00Z',
  },
  {
    id: 'bc-cand4',
    title: 'b7e-notes — read the repo notes',
    labels: [SKILL_LABEL, CANDIDATE_LABEL, UNENDORSED, supersedeLabel('bc-cand2')],
    status: 'open',
    created_at: '2026-08-14T12:00:00Z',
  },
];

/**
 * The stub refuses a workspace *name* exactly the way the real `Bd` does.
 *
 * `assertWorkspaceObject` in lib/bd.js throws for a string, and this file's first live run
 * passed `ws.name` — which the caller's own catch turned into one line in `errors[]` and
 * an empty candidate list. That reads on the page as "nothing has been filed", which was
 * false: five candidates were sitting in the tracker. A fake that accepted either shape
 * would have been green through the whole of it, so this one does not.
 */
const bd = {
  asked: [],
  async listLabelAny(workspace, label) {
    if (!workspace || typeof workspace !== 'object' || !workspace.dir) {
      throw new Error('bd list: needs the workspace object `{name, dir}`. See bc-ygwa.');
    }
    this.asked.push(`${workspace.name}/${label}`);
    return rows;
  },
};

await checksAsync('the workspace goes to bd as the object, never as its name', async () => {
  bd.asked.length = 0;
  const got = await readCandidates(bd, ws);
  assert.equal(got.problem, '', `bd refused the argument: ${got.problem}`);
  assert.deepEqual(bd.asked, [`beadcause/${CANDIDATE_LABEL}`]);
});

await checksAsync('one query per workspace, on the candidate label, closed rows included', async () => {
  bd.asked.length = 0;
  const got = await readCandidates(bd, ws);
  assert.deepEqual(bd.asked, [`beadcause/${CANDIDATE_LABEL}`]);
  assert.equal(got.rows.length, 4);
  assert.equal(got.problem, '');
});

await checksAsync('newest filed first, whatever order the tracker returned', async () => {
  const got = await readCandidates(bd, ws);
  assert.deepEqual(
    got.rows.map((r) => r.id),
    ['bc-cand1', 'bc-cand2', 'bc-cand3', 'bc-cand4']
  );
});

await checksAsync('a tracker that falls over is a sentence, not a 500', async () => {
  const broken = {
    async listLabelAny() {
      throw new Error('bd: database is locked');
    },
  };
  const got = await readCandidates(broken, ws);
  assert.deepEqual(got.rows, []);
  assert.match(got.problem, /locked/);
});

/* --------------------------------------------------------------- the whole screen */

console.log('\nthe whole screen');

const view = await skillsView(bd, cfg, [ws]);

checks('the four counts, and a filed total that is all of them', () => {
  const c = view.candidates.counts;
  assert.equal(c.filed, 4);
  assert.equal(c.waiting, 1, 'only bc-cand2 is genuinely waiting');
  assert.equal(c.accepted, 1);
  assert.equal(c.declined, 1);
  assert.equal(c.superseded, 1);
  assert.equal(c.waiting + c.accepted + c.declined + c.superseded, c.filed);
});

checks('the library is the union across checkouts, each command saying where it is', () => {
  assert.deepEqual(
    view.library.map((s) => s.command),
    ['b7e-brief', 'b7e-context']
  );
  assert.deepEqual(view.library[0].where, ['beadcause']);
});

checks('a shipped command names the candidate that proposed it', () => {
  const shipped = view.library.find((s) => s.command === 'b7e-context');
  assert.equal(shipped.candidate?.id, 'bc-cand1');
  assert.equal(shipped.candidate?.state, 'accepted');
  // And one nothing proposed says nothing rather than guessing at a bead.
  assert.equal(view.library.find((s) => s.command === 'b7e-brief').candidate, null);
});

checks('the audit half is the ledger, aggregated, with the checkout on every miss', () => {
  assert.equal(view.audit.runs, 1);
  assert.equal(view.audit.audited, 2);
  assert.equal(view.audit.lastAt, run.at);
  assert.equal(view.audit.misses.length, 1);
  assert.equal(view.audit.misses[0].key, 'beadcause', 'a miss with no checkout on it cannot be placed');
});

checks('the thresholds are on the payload, so the page can say when it will next run', () => {
  assert.equal(typeof view.audit.enabled, 'boolean');
  assert.ok(view.audit.every >= 1);
  assert.ok(view.audit.minSessions >= 1);
  assert.ok(view.audit.max >= view.audit.minSessions);
});

checks('what nothing measures rides along with everything that does', () => {
  assert.deepEqual(view.untracked, UNTRACKED);
});

checks('every candidate row carries what a link to its bead needs', () => {
  for (const r of view.candidates.rows) {
    assert.ok(r.id, 'a row with no bead id is a row you cannot open');
    assert.ok(r.workspace, `${r.id}: no workspace, so /graph cannot be addressed`);
  }
});

checks('the checkouts are reported apart from the candidates — two grains, not one', () => {
  assert.equal(view.checkouts.length, 1);
  assert.equal(view.checkouts[0].key, 'beadcause');
  assert.equal(view.checkouts[0].runs, 1);
  // The misses are on `audit` with their checkout, not duplicated per row.
  assert.equal(view.checkouts[0].misses, undefined);
});

await checksAsync('a workspace whose checkout has gone is an error row, and the rest still draws', async () => {
  const mixed = {
    workspaces: [...cfg.workspaces, { name: 'gone', dir: '/nowhere/.beads' }],
    sessionDirs: { ...cfg.sessionDirs, gone: '/nowhere/at/all' },
  };
  const got = await skillsView(bd, mixed, mixed.workspaces);
  assert.ok(got.errors.some((e) => e.startsWith('gone:')), got.errors.join(' | '));
  assert.equal(got.library.length, 2, 'the good checkout still reported its library');
  assert.ok(got.candidates.counts.filed > 0, 'the good workspace still reported its candidates');
});

await checksAsync('nothing picked is an empty screen rather than a throw', async () => {
  const got = await skillsView(bd, cfg, []);
  assert.deepEqual(got.library, []);
  assert.equal(got.candidates.counts.filed, 0);
  assert.equal(got.audit.runs, 0);
  assert.deepEqual(got.errors, []);
  assert.equal(got.untracked.length, UNTRACKED.length, 'the untracked list is not conditional on there being data');
});

cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall good\x1b[0m\n');
process.exit(failures ? 1 : 0);
