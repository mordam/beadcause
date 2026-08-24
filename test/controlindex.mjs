#!/usr/bin/env node
//
// The control graph, the note it is a cache of, and the landing that fills it — bc-eqn1.3.
//
//   npm test                        (runs it alongside the other suites)
//   node test/controlindex.mjs      (on its own)
//
// Six properties, and each is a thing that would be silently wrong otherwise:
//
// 1. **The index is rebuildable from the git notes.** That is the whole reason the notes
//    are called the source of truth. If a rebuild does not reproduce the index, then the
//    index is holding something nothing else can restore, and every claim about recovering
//    from a bad write is false. Asserted by wiping the store and rebuilding.
// 2. **A rebuild does not restamp `at`.** For a requirement this is tidiness; here it is
//    the review clock. If a repair command moved every `at` to today, every control would
//    read as freshly evidenced because somebody ran maintenance.
// 3. **Two frameworks landing at once must not lose each other.** The shard-per-framework
//    ref exists for this, and a compare-and-swap you have not raced is one you have not
//    tested.
// 4. **Recording the same landing twice records one edge.** `notePending` in
//    lib/advocate.js retries until the merge commit is found, and for a control an edge
//    counted twice is an overstated sample rather than a cosmetic error.
// 5. **A landing writes one `files:` line, whatever else is in the note.** Both halves of
//    the evidence layer want that line and `parseNote` reads the first match, so a
//    duplicate would not be an error — it would be a second list that looks authoritative
//    and is never read.
// 6. **An id the corpus does not have never reaches the store.** It comes back in
//    `dropped` instead, so an agent that invented it can be told.
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

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-ctlindex-'));
process.env.BEADCAUSE_CONFIG_DIR = store;
process.on('exit', () => removeTreeSync(store));

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const { record, everything, edgesFor, edgesForFiles, noteLines, fileLines, parseNote, rebuildFrom, CONTROLS_PREFIX } =
  await import('../lib/controlindex.js');
const { noteMerge } = await import('../lib/sessionlog.js');
const { recordControlLanding } = await import('../lib/controllanding.js');
const { controlsBlock, readControls, withControls } = await import('../lib/beadcontrols.js');


/* ------------------------------------------------------------- a repo to land in */

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-ctlrepo-'));
process.on('exit', () => removeTreeSync(repo));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@localhost');
git('config', 'user.name', 'test');
fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
fs.writeFileSync(path.join(repo, 'lib', 'auth.js'), 'export const verify = () => true;\n');
git('add', '-A');
git('commit', '-qm', 'first');
const first = git('rev-parse', 'HEAD');

fs.writeFileSync(path.join(repo, 'lib', 'auth.js'), 'export const verify = () => false;\n');
git('add', '-A');
git('commit', '-qm', 'second');
const second = git('rev-parse', 'HEAD');

/* ------------------------------------------------------------------- the block */

console.log('what a bead says it exercises');

const block = controlsBlock({ ids: ['SOC2.CC6.1', 'ISO42001.A.6.2.9', 'SOC2.CC6.1'] });
const read = readControls({ notes: `some prose\n\n${block}` });
check('a real control survives the read', read.ids.join(',') === 'SOC2.CC6.1', JSON.stringify(read));
check(
  'an invented one is dropped and named rather than kept',
  read.dropped.join(',') === 'ISO42001.A.6.2.9',
  JSON.stringify(read.dropped)
);
check('a bead with no block claims nothing, and that is not an error', readControls({ notes: 'nothing here' }).ids.length === 0);
check('an empty claim writes no block at all', controlsBlock({ ids: [] }) === '');

const both = withControls(`${block}\n\ntrailing prose`, { ids: ['ISO27001.A.8.3'] });
check('rewriting replaces rather than accretes', (both.match(/beadcause:controls/g) || []).length === 2, both);
check('and the prose around it survives', both.includes('trailing prose'), both);
check('the replacement is what reads back', readControls({ notes: both }).ids.join(',') === 'ISO27001.A.8.3');

/* ------------------------------------------------------------------ recording */

console.log('\nrecording an edge');

await record({
  ids: ['SOC2.CC6.1'],
  repo,
  commit: second,
  bead: 'bc-1.2',
  workspace: 'beadcause',
  files: ['lib/auth.js'],
  provenance: 'observed-from-diff',
});

let edges = await edgesFor('SOC2.CC6.1');
check('the edge is there', edges.length === 1 && edges[0].commit === second, JSON.stringify(edges));
check('with the files that landed', edges[0].files.join(',') === 'lib/auth.js');
check('and its provenance', edges[0].provenance === 'observed-from-diff');
check('a control with nothing recorded is empty, not an error', (await edgesFor('SOC2.CC9.2')).length === 0);
check('an empty call refuses', (await record({ ids: [], commit: second })).skipped === 'no controls');
check('a call with no commit refuses rather than writing', (await record({ ids: ['SOC2.CC6.1'] })).skipped === 'no commit');
check(
  'and an id whose framework is not one gets no shard of its own',
  (await record({ ids: ['SCO2.CC6.1'], repo, commit: second })).skipped === 'no framework'
);

await record({ ids: ['SOC2.CC6.1'], repo, commit: second, bead: 'bc-1.2', workspace: 'beadcause', files: ['lib/auth.js'] });
edges = await edgesFor('SOC2.CC6.1');
check('recording the same landing twice records one edge', edges.length === 1, String(edges.length));
check('and a later forecast does not downgrade a proof', edges[0].provenance === 'observed-from-diff', edges[0].provenance);

/* --------------------------------------------------------------- concurrency */

console.log('\ntwo frameworks landing at once');

const iso = ['A.5.1', 'A.5.2', 'A.5.3', 'A.5.4', 'A.5.5', 'A.5.6'];
await Promise.all(
  iso.map((local, i) =>
    record({
      ids: [`ISO27001.${local}`, 'SOC2.CC7.2'],
      repo,
      commit: `${'0'.repeat(39)}${i}`,
      bead: `bc-2.${i}`,
      workspace: 'beadcause',
      files: [`lib/f${i}.js`],
    })
  )
);
const graph = await everything();
check('every concurrent write to one id survives', (graph['SOC2.CC7.2'] || []).length === 6, String((graph['SOC2.CC7.2'] || []).length));
check('and every id in the other shard is there', iso.every((l) => (graph[`ISO27001.${l}`] || []).length === 1));

/* ------------------------------------------------------------ reverse lookup */

console.log('\nthe reverse lookup');

const hits = await edgesForFiles(['lib/auth.js'], { dirs: [repo] });
check('a file finds what it has evidenced', hits.length === 1 && hits[0].id === 'SOC2.CC6.1', JSON.stringify(hits));

await record({ ids: ['ISO42001.A.7.2'], repo, commit: first, bead: 'bc-3', workspace: 'beadcause', files: ['lib/deleted.js'] });
check('a path that no longer exists is dropped from the answer', (await edgesForFiles(['lib/deleted.js'], { dirs: [repo] })).length === 0);
check('but the record itself is kept — it was true of that commit', (await edgesFor('ISO42001.A.7.2')).length === 1);
check('with no dirs there is nothing to check against, so nothing is dropped', (await edgesForFiles(['lib/deleted.js'])).length === 1);

/* ------------------------------------------------------------------- the note */

console.log('\nthe note on the landing commit');

check('the note names the controls', noteLines({ ids: ['SOC2.CC6.1', 'ISO27001.A.8.3'] }) === 'controls: SOC2.CC6.1, ISO27001.A.8.3');
check('and writes no files line of its own', !noteLines({ ids: ['SOC2.CC6.1'] }).includes('files:'));
check('the files line is separate and its own function', fileLines({ files: ['lib/auth.js'] }) === 'files: lib/auth.js');
check('nothing to say writes no lines', noteLines({}) === '' && fileLines({}) === '');

const parsed = parseNote('beadcause: landed beadcause/bc-1.2\nsession log: refs/x\ncontrols: SOC2.CC6.1\nfiles: lib/auth.js');
check('and it reads back', parsed.ids.join(',') === 'SOC2.CC6.1' && parsed.bead === 'bc-1.2', JSON.stringify(parsed));
check('a note from before this existed still parses', parseNote('beadcause: landed w/b-1\nsession log: r').ids.length === 0);
check(
  'and a requirements-only note is not read as a control one',
  parseNote('beadcause: landed w/b-1\nrequirements: AS.verify\nfiles: lib/auth.js').ids.length === 0
);

/* ---------------------------------------------------------------- the landing */

console.log('\nwhat a landing does without being asked');

const issue = { id: 'bc-9', notes: controlsBlock({ ids: ['ISO27001.A.8.5', 'ISO42001.A.6.2.9'] }) };
const landed = await recordControlLanding({
  main: repo,
  sha: second,
  bead: 'bc-9',
  workspace: 'beadcause',
  issue,
});
check('a landing that names a control produces note lines', landed.extra.includes('controls: ISO27001.A.8.5'), landed.extra);
check('and the files come off the merge', landed.files.join(',') === 'lib/auth.js', landed.files.join(','));
check('the invented id never reaches the store', landed.ids.join(',') === 'ISO27001.A.8.5', JSON.stringify(landed.ids));
check('and comes back so the caller can say so', landed.dropped.join(',') === 'ISO42001.A.6.2.9', JSON.stringify(landed.dropped));
check('the edge is recorded as proof, not forecast', (await edgesFor('ISO27001.A.8.5'))[0]?.provenance === 'observed-from-diff');

const withReqs = await recordControlLanding({
  main: repo,
  sha: second,
  bead: 'bc-9',
  workspace: 'beadcause',
  issue,
  base: 'requirements: AS.verify\nfiles: lib/auth.js',
  files: ['lib/auth.js'],
});
check(
  'a note that already has a files line does not get a second one',
  (withReqs.extra.match(/^files:/gm) || []).length === 1,
  withReqs.extra
);
check('and the requirements half is untouched', withReqs.extra.includes('requirements: AS.verify'), withReqs.extra);

const quiet = await recordControlLanding({ main: repo, sha: first, bead: 'bc-10', workspace: 'beadcause', issue: { id: 'bc-10' } });
check('a bead claiming nothing leaves the note byte-for-byte as it was', quiet.extra === '' && quiet.ids.length === 0);
const carried = await recordControlLanding({
  main: repo,
  sha: first,
  bead: 'bc-10',
  workspace: 'beadcause',
  issue: { id: 'bc-10' },
  base: 'requirements: AS.verify',
});
check('even when the requirements half wrote one', carried.extra === 'requirements: AS.verify', carried.extra);

await noteMerge(repo, { sha: second, bead: 'bc-9', workspace: 'beadcause', ref: 'refs/beadcause/sessions/bc-9', extra: landed.extra });
const noteText = git('notes', '--ref=refs/notes/beadcause', 'show', second);
check('the note carries the control', noteText.includes('controls: ISO27001.A.8.5'), noteText);
check('and still says what it always said', noteText.includes('beadcause: landed beadcause/bc-9'));

/* ------------------------------------------------------- the rebuild property */

console.log('\nthe index is a cache of the notes');

const beforeWipe = await everything();
const wasAt = (await edgesFor('ISO27001.A.8.5'))[0]?.at;
check('a landing is dated by the commit, not by the clock', wasAt === git('log', '-1', '--format=%cI', second), wasAt);
// Wipe every shard **in the common repo**, which is where the index lives — not in the
// repo that landed the work. The index is now gone and only the notes remain.
const inStore = (...args) => execFileSync('git', ['-C', store, ...args], { encoding: 'utf8' }).trim();
for (const ref of inStore('for-each-ref', '--format=%(refname)', `${CONTROLS_PREFIX}/`).split('\n').filter(Boolean)) {
  inStore('update-ref', '-d', ref);
}
const wiped = await everything();
check('the store really was empty first', Object.keys(wiped).length === 0, JSON.stringify(Object.keys(wiped)));

const rebuilt = await rebuildFrom(repo);
const after = await everything();
check('rebuilding from the notes finds the landing', rebuilt.commits >= 1 && (after['ISO27001.A.8.5'] || []).length === 1, JSON.stringify(rebuilt));
check(
  'and the rebuilt edge matches what was recorded',
  after['ISO27001.A.8.5']?.[0]?.commit === second && after['ISO27001.A.8.5'][0].files.join(',') === 'lib/auth.js',
  JSON.stringify(after['ISO27001.A.8.5'])
);
check('what the notes cannot restore is only what was never noted', Object.keys(beforeWipe).length > Object.keys(after).length);

// The review clock, and the reason this assertion is here rather than in the coverage
// suite: a note carries no date, so a rebuild that stamped `new Date()` would mark every
// control freshly evidenced on the day somebody ran a repair — indistinguishable from good
// news, and the one failure a staleness report cannot survive.
check('the store the notes restored is dated the same as the one that was wiped', after['ISO27001.A.8.5']?.[0]?.at === wasAt, `${wasAt} -> ${after['ISO27001.A.8.5']?.[0]?.at}`);

const once = JSON.stringify(await everything());
await rebuildFrom(repo);
check('a rebuild over a correct index changes nothing', JSON.stringify(await everything()) === once);

/* ------------------------------------------------------------ never a gate */

console.log('\nnothing consults the graph for permission');

// test/requirements.mjs's property, over the control index, and here it matters more. A
// control graph is partial by construction — an edge exists only where a merge landed
// naming one — so a path that could withhold work on the strength of it would withhold it
// because nobody had written a block, which is not a compliance failure and is certainly
// not a reason to hold a bead. Asserted at the import boundary, which is where it would
// actually be broken: the first person to reach for `edgesForFiles` inside a hold
// predicate has to change this list and say why.
const LIB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib');
const READERS = new Set(['controlcoverage.js', 'controllanding.js', 'server.js']);
const importers = fs
  .readdirSync(LIB)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => /from '\.\/controlindex\.js'/.test(fs.readFileSync(path.join(LIB, f), 'utf8')));
check(
  'only the recorder, the coverage view and the server touch the index',
  importers.length > 0 && importers.every((f) => READERS.has(f)),
  importers.join(', ')
);

const advocate = fs.readFileSync(path.join(LIB, 'advocate.js'), 'utf8');
check(
  'the advocate records landings but never queries the graph',
  !/from '\.\/controlindex\.js'/.test(advocate) && /from '\.\/controllanding\.js'/.test(advocate)
);
check(
  'and lib/beadfiles.js, which decides holds, knows nothing about controls',
  !/control(index|coverage|landing|s)\.js/.test(fs.readFileSync(path.join(LIB, 'beadfiles.js'), 'utf8'))
);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
