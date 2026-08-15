#!/usr/bin/env node
//
// The change-management sample — bc-4r10.5.
//
//   npm test                        (runs it alongside the other suites)
//   node test/changesample.mjs      (on its own)
//
// Five properties, and each is something that would be quietly wrong otherwise:
//
// 1. **The population is complete.** A commit that reached the branch outside a pull
//    request is reported as a stray, not dropped. That commit is the exact thing a
//    change-management sample exists to find, and a tool that filtered it out would be
//    most confident precisely where it was most wrong.
// 2. **`unknown` is never counted as clean.** The first version of `tally` counted a row
//    with no *findings* as a row with a complete record, and a run against a checkout with
//    no tracker reported 47 of 47 changes clean. Pinned here because it reads as a
//    rounding decision and is the difference between an artefact and a lie.
// 3. **The three states are reachable, one at a time.** Every dimension is driven through
//    evidenced, absent and unknown from the records alone — which is what the split
//    between lib/changesample.js and lib/changegather.js is for.
// 4. **The sample is reproducible.** Same seed and same population, same rows, in any
//    process. An auditor's sample that a second run disagrees with is worthless, and the
//    only way to be sure is to assert it rather than to read the hash and believe it.
// 5. **It reads what the daemon actually writes.** The end-to-end runs `noteMerge` from
//    lib/sessionlog.js against a real throwaway repository and then reads it back with
//    `collect`. A fixture note would let this suite stay green through a change to the
//    note format that broke every report.
//
// Everything runs against a temp BEADCAUSE_CONFIG_DIR and a throwaway git repo. Nothing
// touches the real ~/.config/beadcause, any repo you work in, or any remote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { removeTreeSync } from './helpers/tmp.mjs';

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-changesample-'));
process.env.BEADCAUSE_CONFIG_DIR = store;
process.on('exit', () => removeTreeSync(store));

// Imported after the env is set: lib/release.js resolves CONFIG_DIR once, at module load,
// and the ledger this suite writes has to be the one it reads.
const {
  DIMENSION_KEYS,
  parseLanded,
  changeOf,
  population,
  evidenceFor,
  exceptionsOf,
  sampleOf,
  tally,
  describeSample,
  renderReport,
  hashKey,
} = await import('../lib/changesample.js');
const { collect } = await import('../lib/changegather.js');
const { noteMerge } = await import('../lib/sessionlog.js');

/* --------------------------------------------------------------- 1. the population */

console.log('the population');

check(
  'the note is read for the workspace and the bead',
  JSON.stringify(parseLanded('beadcause: landed beadcause/bc-0i27.24\nsession log: refs/x')) ===
    JSON.stringify({ workspace: 'beadcause', bead: 'bc-0i27.24' })
);
check('a note that is not a landing reads as none', parseLanded('beadcause: beadcause/bc-x — a title\nagent session 1 · done') === null);
check('an empty note reads as none', parseLanded('') === null && parseLanded(null) === null);

const commits = [
  { commit: 'a'.repeat(40), at: '2026-08-14T10:00:00Z', subject: 'bc-one: a thing (#322)', note: 'beadcause: landed beadcause/bc-one\n' },
  { commit: 'b'.repeat(40), at: '2026-08-13T10:00:00Z', subject: 'bc-two: another thing (#300)', note: '' },
  { commit: 'c'.repeat(40), at: '2026-08-12T10:00:00Z', subject: 'a hand merge nobody reviewed', note: '' },
  { commit: 'd'.repeat(40), at: '2026-08-11T10:00:00Z', subject: "Merge branch 'main' into worktree-x", note: '' },
];
const { changes, strays } = population(commits);

check('a commit with a pull request is a change', changes.length === 2, `got ${changes.length}`);
check('a commit without one is a stray, not a drop', strays.length === 2 && changes.length + strays.length === commits.length);
check('the bead comes off the note when there is one', changes[0].bead === 'bc-one' && changes[0].beadFrom === 'note');
check('and off the subject when there is not, marked as such', changes[1].bead === 'bc-two' && changes[1].beadFrom === 'subject');
check('the pull request number is read', changes[0].pr === 322 && changes[1].pr === 300);
check('a commit that is neither is not a change', changeOf(commits[2]) === null);

/* ------------------------------------------------------------------ 2. the evidence */

console.log('the evidence');

const change = changes[0];
const full = {
  bead: { id: 'bc-one', title: 'A thing', description: 'why it had to be done', labels: [] },
  merge: { id: 'bc-mrg', status: 'closed', tests: 'npm test, 227/227 green' },
  ship: { id: 'bc-shp', status: 'closed', closeReason: 'shipped' },
  release: { shippedAt: '2026-08-14T11:00:00Z', sha: 'a'.repeat(40) },
  archived: true,
  asked: true,
};
const clean = evidenceFor(change, full);
check(
  'every record present is every column evidenced',
  DIMENSION_KEYS.every((k) => clean[k].state === 'evidenced'),
  DIMENSION_KEYS.filter((k) => clean[k].state !== 'evidenced').join(', ')
);
check('and no findings', exceptionsOf(clean).length === 0);

const held = evidenceFor(change, { ...full, bead: { ...full.bead, labels: ['unendorsed'] } });
check('a bead still carrying `unendorsed` is a finding on authorisation', held.authorised.state === 'absent');

const noBead = evidenceFor({ ...change, bead: null, beadFrom: null }, { ...full, bead: null });
check('a change with no bead at all is a finding, not a dropped row', noBead.authorised.state === 'absent');

const noMerge = evidenceFor(change, { ...full, merge: null });
check('no merge bead is a finding on approval', noMerge.approved.state === 'absent');
check('and unknown on tested, because nothing recorded a test either way', noMerge.tested.state === 'unknown');

const openMerge = evidenceFor(change, { ...full, merge: { id: 'bc-mrg', status: 'open', tests: '' } });
check('a merge bead still open is a finding on approval', openMerge.approved.state === 'absent');
check('and an empty tests field is a finding rather than an unknown', openMerge.tested.state === 'absent');

const noArchive = evidenceFor(change, { ...full, archived: false });
check('no session archive is a finding on development', noArchive.developed.state === 'absent');

const ledgerOnly = evidenceFor(change, { ...full, ship: null });
check('the ledger alone evidences a deployment', ledgerOnly.deployed.state === 'evidenced');
const shipOnly = evidenceFor(change, { ...full, release: null });
check('and so does the ship bead alone, for merges that predate auto-ship', shipOnly.deployed.state === 'evidenced');
const neither = evidenceFor(change, { ...full, release: null, ship: null });
check('neither is unknown, not a finding — the ledger prunes', neither.deployed.state === 'unknown');

const unasked = evidenceFor(change, { ...full, asked: false });
check('a tracker that could not be read is six unknowns', DIMENSION_KEYS.every((k) => unasked[k].state === 'unknown'));
check('and no findings, because nothing was found out', exceptionsOf(unasked).length === 0);

/* -------------------------------------------------------------------- 3. the totals */

console.log('the totals');

const rows = [
  { ...change, evidence: clean, exceptions: exceptionsOf(clean) },
  { ...changes[1], evidence: noMerge, exceptions: exceptionsOf(noMerge) },
  { ...changes[1], commit: 'e'.repeat(40), evidence: unasked, exceptions: exceptionsOf(unasked) },
];
const t = tally(rows);
check('clean means every column evidenced, not merely no findings', t.clean === 1, `clean was ${t.clean}`);
check('a row of unknowns is counted as unanswered', t.unanswered === 1, `unanswered was ${t.unanswered}`);
check('and a row with a finding is counted as one', t.withExceptions === 1);
check('the three groups add up to the sample', t.clean + t.unanswered + t.withExceptions === t.sampled);
check(
  'the summary line states the unanswered rows out loud',
  describeSample({ totals: t, population: 3, strays: [] }).includes('nothing could be asked about')
);

/* ------------------------------------------------------------------ 4. the selection */

console.log('the selection');

const many = Array.from({ length: 200 }, (_, i) => ({
  commit: String(i).padStart(40, '0'),
  at: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  pr: i,
}));
const a = sampleOf(many, { size: 25, seed: 7 });
const b = sampleOf(many, { size: 25, seed: 7 });
const c = sampleOf(many, { size: 25, seed: 8 });
check('the same seed selects the same rows', a.map((r) => r.commit).join() === b.map((r) => r.commit).join());
check('a different seed selects different rows', a.map((r) => r.commit).join() !== c.map((r) => r.commit).join());
check('the size is honoured', a.length === 25);
check(
  'the order the population arrived in does not change the selection',
  sampleOf(many.slice().reverse(), { size: 25, seed: 7 })
    .map((r) => r.commit)
    .join() === a.map((r) => r.commit).join()
);
check('a population smaller than the sample comes back whole', sampleOf(many.slice(0, 4), { size: 25, seed: 7 }).length === 4);
check('the rows come back newest first', a.every((row, i) => i === 0 || a[i - 1].at >= row.at));
// Pinned to a literal, not merely to itself. The value is what makes a sample taken this
// year reproducible next year, so a change to the hash is a change to every artefact
// already in an audit file and should fail loudly rather than quietly re-select.
check('the hash is pinned, so a sample survives a change to this file', hashKey('7:abc') === 1138486444, String(hashKey('7:abc')));

/* ----------------------------------------------------------------- 5. end to end */

console.log('end to end, against a real repository');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-changerepo-'));
process.on('exit', () => removeTreeSync(repo));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@localhost');
git('config', 'user.name', 'test');

fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
git('add', '-A');
git('commit', '-qm', 'bc-t1: the first change (#101)');
const landed = git('rev-parse', 'HEAD');

fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
git('add', '-A');
git('commit', '-qm', 'a hand merge with no pull request');

fs.writeFileSync(path.join(repo, 'c.txt'), 'three\n');
git('add', '-A');
git('commit', '-qm', 'bc-t2: the second change (#102)');
const second = git('rev-parse', 'HEAD');

// Written by the daemon's own function rather than by hand — property 5.
await noteMerge(repo, { sha: landed, bead: 'bc-t1', workspace: 'demo', ref: 'refs/beadcause/sessions/bc-t1' });
await noteMerge(repo, { sha: second, bead: 'bc-t2', workspace: 'demo', ref: 'refs/beadcause/sessions/bc-t2' });
// An archive for one bead and not the other, so `developed` is driven both ways.
git('update-ref', 'refs/beadcause/sessions/bc-t1', landed);

fs.writeFileSync(
  path.join(store, 'releases.json'),
  JSON.stringify({ demo: { since: '2026-08-01T00:00:00Z', handled: { 101: { sha: landed, shippedAt: '2026-08-02T00:00:00Z' } } } })
);

const beads = [
  { id: 'bc-t1', title: 'The first change', description: 'because it was broken', labels: [], status: 'closed' },
  { id: 'bc-t2', title: 'The second change', description: 'because it was also broken', labels: [], status: 'closed' },
  {
    id: 'bc-m1',
    title: 'Merge #101',
    labels: ['merge-queue'],
    status: 'closed',
    description: ['```beadpr', 'bead: bc-t1', 'number: 101', 'branch: worktree-t1', 'base: main', 'tests: npm test, all green', '```'].join('\n'),
  },
];
const bd = { listAll: async () => beads };

const result = await collect({ dir: repo, bd, workspace: { name: 'demo' }, branch: 'main', size: 0, seed: 3, generatedAt: 'now' });

check('both pull requests are in the population', result.population === 2, `got ${result.population}`);
check('the commit that was not one is a stray', result.strays.length === 1 && result.strays[0].subject.startsWith('a hand merge'));
check('the tracker was reached', result.asked === true);

const one = result.sample.find((r) => r.pr === 101);
const two = result.sample.find((r) => r.pr === 102);
check('the bead comes from the note the daemon wrote', one?.bead === 'bc-t1' && one.beadFrom === 'note');
check('#101 is evidenced on every column', DIMENSION_KEYS.every((k) => one.evidence[k].state === 'evidenced'), JSON.stringify(one?.evidence));
check('#102 has no merge bead, so approval is a finding', two?.evidence.approved.state === 'absent');
check('#102 has no archive, so development is a finding', two?.evidence.developed.state === 'absent');
check('#102 has no ledger row, so deployment is unknown rather than a finding', two?.evidence.deployed.state === 'unknown');
check('the totals see one clean row and one with findings', result.totals.clean === 1 && result.totals.withExceptions === 1);
check('the ledger horizon is carried out', result.ledgerSince === '2026-08-01T00:00:00Z');

const report = renderReport(result);
check('the report names the criterion columns', DIMENSION_KEYS.every((k) => report.includes(`| ${k} |`)));
check('the report states the population and the seed', report.includes('2 changes landed') && report.includes('`3`'));
check('the report lists the finding under its pull request', report.includes('### #102'));
check('the report says the ledger prunes', report.includes('only goes back to 2026-08-01T00:00:00Z'));
check('the stray is reported rather than hidden', report.includes('outside a pull request') && report.includes('a hand merge'));

// A tracker that will not answer must read as a run that could not ask, never as a
// quarter of findings — the difference the whole `unknown` state exists for.
const blind = await collect({
  dir: repo,
  bd: {
    listAll: async () => {
      throw new Error('dolt is mid-write');
    },
  },
  workspace: { name: 'demo' },
  branch: 'main',
  size: 0,
  seed: 3,
  generatedAt: 'now',
});
check('a tracker that throws leaves the population intact', blind.population === 2);
check('and reports nothing as clean and nothing as a finding', blind.totals.clean === 0 && blind.totals.withExceptions === 0);
check('and says so at the top of the report', renderReport(blind).includes('The tracker could not be read'));

console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
