#!/usr/bin/env node
//
// The requirement index, and the notes it is a cache of — bc-fvmx.5.
//
//   npm test                     (runs it alongside the other suites)
//   node test/reqindex.mjs       (on its own)
//
// Four properties, and each is a thing that would be silently wrong otherwise:
//
// 1. **The index is rebuildable from the git notes.** That is the whole reason the notes
//    are called the source of truth. If a rebuild does not reproduce the index, then the
//    index is holding something nothing else can restore, and every claim made about
//    recovering from a bad write is false. Asserted by wiping the store and rebuilding.
// 2. **Two products landing at once must not lose each other.** The shard-per-token ref
//    exists for this, and a compare-and-swap you have not raced is one you have not
//    tested — lib/memory.js's argument, and its incident.
// 3. **Recording the same landing twice records one edge.** `notePending` in
//    lib/advocate.js retries until the merge commit is found, so this genuinely happens,
//    and a graph that counted it twice would report two pieces of evidence where there is
//    one.
// 4. **The reverse lookup drops paths that no longer exist**, because a requirement whose
//    file was deleted must not put a dead path into a session's brief.
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

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reqindex-'));
process.env.BEADCAUSE_CONFIG_DIR = store;
process.on('exit', () => removeTreeSync(store));

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const { record, everything, edgesFor, edgesForFiles, noteLines, parseNote, rebuildFrom, filesInMerge, REQS_PREFIX } =
  await import('../lib/reqindex.js');
const { noteMerge } = await import('../lib/sessionlog.js');
const { recordLanding } = await import('../lib/reqlanding.js');
const { loadCorpus, forgetCorpus } = await import('../lib/requirements.js');
const { requirementsBlock } = await import('../lib/beadreqs.js');

/* ------------------------------------------------------------- a repo to land in */

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reqrepo-'));
process.on('exit', () => removeTreeSync(repo));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@localhost');
git('config', 'user.name', 'test');
fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
fs.writeFileSync(path.join(repo, 'lib', 'auth.js'), 'export const verify = () => true;\n');
fs.writeFileSync(path.join(repo, 'lib', 'gone.js'), 'export const gone = 1;\n');
git('add', '-A');
git('commit', '-qm', 'first');
const first = git('rev-parse', 'HEAD');

fs.writeFileSync(path.join(repo, 'lib', 'auth.js'), 'export const verify = () => false;\n');
git('add', '-A');
git('commit', '-qm', 'second');
const second = git('rev-parse', 'HEAD');

/* ------------------------------------------------------------------ recording */

console.log('recording an edge');

await record({
  ids: ['AS.verify'],
  repo,
  commit: second,
  bead: 'bc-1.2',
  workspace: 'beadcause',
  files: ['lib/auth.js'],
  provenance: 'observed-from-diff',
});

let edges = await edgesFor('AS.verify');
check('the edge is there', edges.length === 1 && edges[0].commit === second, JSON.stringify(edges));
check('with the files that landed', edges[0].files.join(',') === 'lib/auth.js');
check('and its provenance', edges[0].provenance === 'observed-from-diff');
check('an id with nothing recorded is empty, not an error', (await edgesFor('EN.Nothing.Here')).length === 0);
check('and so is an empty call', (await record({ ids: [], commit: second })).skipped === 'no requirements');
check('and a call with no commit refuses rather than writing', (await record({ ids: ['AS.x'] })).skipped === 'no commit');

await record({ ids: ['AS.verify'], repo, commit: second, bead: 'bc-1.2', workspace: 'beadcause', files: ['lib/auth.js'] });
edges = await edgesFor('AS.verify');
check('recording the same landing twice records one edge', edges.length === 1, String(edges.length));

/* --------------------------------------------------------------- concurrency */

console.log('\ntwo products landing at once');

const many = Array.from({ length: 6 }, (_, i) => i);
await Promise.all(
  many.map((i) =>
    record({
      ids: [`EN.Feature${i}`, 'AS.parallel'],
      repo,
      commit: `${'0'.repeat(39)}${i}`,
      bead: `bc-2.${i}`,
      workspace: 'beadcause',
      files: [`lib/f${i}.js`],
    })
  )
);
const graph = await everything();
const parallel = graph['AS.parallel'] || [];
check('every concurrent write to one id survives', parallel.length === 6, String(parallel.length));
check('and every id in the other shard is there', many.every((i) => (graph[`EN.Feature${i}`] || []).length === 1));

/* ------------------------------------------------------------ reverse lookup */

console.log('\nthe reverse lookup');

const hits = await edgesForFiles(['lib/auth.js'], { dirs: [repo] });
check('a file finds what it has carried', hits.length === 1 && hits[0].id === 'AS.verify', JSON.stringify(hits));

await record({ ids: ['AS.deleted'], repo, commit: first, bead: 'bc-3', workspace: 'beadcause', files: ['lib/deleted.js'] });
const dead = await edgesForFiles(['lib/deleted.js'], { dirs: [repo] });
check('a path that no longer exists is dropped from the answer', dead.length === 0, JSON.stringify(dead));
check('but the record itself is kept — it was true of that commit', (await edgesFor('AS.deleted')).length === 1);
check('with no dirs there is nothing to check against, so nothing is dropped', (await edgesForFiles(['lib/deleted.js'])).length === 1);

/* ------------------------------------------------------------------- the note */

console.log('\nthe note on the landing commit');

const lines = noteLines({ ids: ['AS.verify', 'EN.Feature1'], files: ['lib/auth.js'] });
check('the note names the requirements', lines.includes('requirements: AS.verify, EN.Feature1'), lines);
check('and the files', lines.includes('files: lib/auth.js'), lines);
check('nothing to say writes no lines', noteLines({}) === '');

const parsedNote = parseNote(`beadcause: landed beadcause/bc-1.2\nsession log: refs/x\n${lines}`);
check('and it reads back', parsedNote.ids.join(',') === 'AS.verify,EN.Feature1' && parsedNote.bead === 'bc-1.2', JSON.stringify(parsedNote));
check('a note from before this existed still parses', parseNote('beadcause: landed w/b-1\nsession log: r').ids.length === 0);

check('the files a merge touched are readable', (await filesInMerge(repo, second)).join(',') === 'lib/auth.js');

/* ------------------------------------------------------- the rebuild property */

console.log('\nthe index is a cache of the notes');

// A corpus, so `recordLanding` has a vocabulary — it is switched off entirely without one.
const corpusRoot = path.join(store, 'reqs');
fs.mkdirSync(corpusRoot, { recursive: true });
fs.writeFileSync(
  path.join(corpusRoot, 'as.technical-requirements.yaml'),
  '---\nfeature: auth\ntoken: AS\n\nrequirements:\n    AS.verify:\n        definition: verifies a credential\n'
);
forgetCorpus();
const corpus = loadCorpus(corpusRoot);

const issue = { id: 'bc-9', notes: requirementsBlock({ ids: ['AS.verify'] }) };
const landed = await recordLanding({ main: repo, sha: second, bead: 'bc-9', workspace: 'beadcause', issue, corpus });
check('a landing that names a requirement produces note lines', landed.extra.includes('AS.verify'), landed.extra);
check('and the files come off the merge', landed.files.join(',') === 'lib/auth.js', landed.files.join(','));
check('it does not ask for a glean', landed.glean === false);

const naming = await recordLanding({ main: repo, sha: first, bead: 'bc-10', workspace: 'beadcause', issue: { id: 'bc-10' }, corpus });
check('a landing that names none asks for a glean instead', naming.glean === true && naming.extra === '');
check('and with no corpus at all nothing happens', (await recordLanding({ main: repo, sha: first, bead: 'bc-11', corpus: null })).extra === '');

await noteMerge(repo, { sha: second, bead: 'bc-9', workspace: 'beadcause', ref: 'refs/beadcause/sessions/bc-9', extra: landed.extra });
const noteText = git('notes', '--ref=refs/notes/beadcause', 'show', second);
check('the note carries the requirement', noteText.includes('requirements: AS.verify'), noteText);
check('and still says what it always said', noteText.includes('beadcause: landed beadcause/bc-9'));

const beforeWipe = await everything();
// Wipe every shard **in the common repo**, which is where the index lives — not in the
// repo that landed the work. The index is now gone and only the notes remain.
const inStore = (...args) => execFileSync('git', ['-C', store, ...args], { encoding: 'utf8' }).trim();
for (const ref of inStore('for-each-ref', '--format=%(refname)', `${REQS_PREFIX}/`).split('\n').filter(Boolean)) {
  inStore('update-ref', '-d', ref);
}
const wiped = await everything();

const rebuilt = await rebuildFrom(repo);
const after = await everything();
check('the store really was empty first', Object.keys(wiped).length === 0, JSON.stringify(Object.keys(wiped)));
check('rebuilding from the notes finds the landing', rebuilt.commits >= 1 && (after['AS.verify'] || []).length === 1, JSON.stringify(rebuilt));
check(
  'and the rebuilt edge matches what was recorded',
  after['AS.verify']?.[0]?.commit === second && after['AS.verify'][0].files.join(',') === 'lib/auth.js',
  JSON.stringify(after['AS.verify'])
);
const once = JSON.stringify(await everything());
await rebuildFrom(repo);
check('a rebuild over a correct index changes nothing', JSON.stringify(await everything()) === once);
check('what the notes cannot restore is only what was never noted', Object.keys(beforeWipe).length > Object.keys(after).length);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
