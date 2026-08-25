#!/usr/bin/env node
//
// b7e-cites — every bead id quoted in this repo's own tree, joined to what the tracker
// now says about it (bc-4r10.22).
//
//   npm test
//   node test/cites.mjs
//
// lib/cites.js's pure halves (the walk, the matching, the pending-phrase judgement) are
// checked directly; the bin itself is driven as a real subprocess against a stub `bd`,
// for the same reason test/b7ews.mjs gives: the flags actually reaching `bd` — and, here,
// that the whole batch of ids goes out in ONE spawn rather than one per id — are the
// thing under test, and a stub that swallowed the argv would prove nothing about either.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-cites');

const { collectFiles, citationsIn, isPending, withStatus, staleFilter, PENDING_PHRASES } = await import(path.join(ROOT, 'lib', 'cites.js'));

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('\nb7e-cites\n');

/* -------------------------------------------------------------------- lib/cites.js */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-cites-'));

const write = (rel, text) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

write('README.md', '# tree\n\nSee tt-closed for the background.\n');
write('lib/foo.js', ['// tt-closed is done.', '// tt-pending is still to come.', '// tt-openp has not settled yet.', '// tt-unknown needs a look.', ''].join('\n'));
write('lib/bar.js', '// tt-onlyhere lives only in this file\n');
write('node_modules/dep/index.js', '// tt-closed leaked in here it must not count\n');
write('.claude/worktrees/x/lib/foo.js', '// tt-closed also leaked in a sibling worktree copy\n');
write('dist/bundle.js', '// tt-closed built output, must not count either\n');

check('collectFiles walks the fixed roots plus README.md, skipping node_modules/.claude/dist', () => {
  const files = collectFiles(tmp, null).sort();
  assert.deepEqual(files, ['README.md', 'lib/bar.js', 'lib/foo.js']);
});

check('collectFiles(root, paths) narrows to only the given files/directories', () => {
  const files = collectFiles(tmp, ['lib/bar.js']);
  assert.deepEqual(files, ['lib/bar.js']);
});

check('citationsIn finds one row per line, per id, under the given prefix', () => {
  const files = collectFiles(tmp, null);
  const rows = citationsIn(tmp, files, 'tt');
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, ['tt-closed', 'tt-closed', 'tt-onlyhere', 'tt-openp', 'tt-pending', 'tt-unknown']);
  const fooRow = rows.find((r) => r.file === 'lib/foo.js' && r.id === 'tt-pending');
  assert.equal(fooRow.line, 2);
  assert.match(fooRow.text, /still to come/);
});

check('citationsIn skips node_modules, .claude and dist even when not given a path filter', () => {
  const files = collectFiles(tmp, null);
  const rows = citationsIn(tmp, files, 'tt');
  assert.equal(
    rows.filter((r) => r.file.includes('node_modules') || r.file.includes('.claude') || r.file.includes('dist')).length,
    0
  );
});

check('citationsIn with `only` keeps just that one id, case-folded', () => {
  const files = collectFiles(tmp, null);
  const rows = citationsIn(tmp, files, 'tt', { only: 'TT-Closed' });
  assert.equal(rows.length, 2); // README.md and lib/foo.js — lib/bar.js never mentions it at all
  assert.ok(rows.every((r) => r.id === 'tt-closed'));
});

check('isPending matches the phrases the originating citations actually used', () => {
  assert.ok(isPending('bc-228x has not settled whose boundary this is'));
  assert.ok(isPending('the clauses are still to come'));
  assert.ok(isPending('lib/controls.js (bc-4r10.1) and lib/boundary.js (bc-4r10.2) are landing on main'));
  assert.ok(!isPending('bc-228x settled the subject'));
  assert.equal(PENDING_PHRASES.length > 0, true);
});

check('withStatus joins a found row and falls back to unknown for one the map has no entry for', () => {
  const rows = [{ file: 'a', line: 1, id: 'tt-closed', text: 'x' }, { file: 'a', line: 2, id: 'tt-ghost', text: 'y' }];
  const statusById = new Map([['tt-closed', { status: 'closed', title: 'Done' }]]);
  const joined = withStatus(rows, statusById);
  assert.equal(joined[0].status, 'closed');
  assert.equal(joined[0].title, 'Done');
  assert.equal(joined[1].status, 'unknown');
  assert.equal(joined[1].title, null);
});

check('staleFilter — acceptance criterion: a closed bead cited as unsettled is kept, the same sentence with the bead open is not', () => {
  const rows = [
    { file: 'a', line: 1, id: 'tt-pending', text: 'tt-pending is still to come.', status: 'closed', title: 'T' },
    { file: 'a', line: 2, id: 'tt-openpending', text: 'tt-openpending has not settled yet.', status: 'open', title: 'T' },
    { file: 'a', line: 3, id: 'tt-closed', text: 'tt-closed is done.', status: 'closed', title: 'T' },
    { file: 'a', line: 4, id: 'tt-unknown', text: 'tt-unknown needs a look.', status: 'unknown', title: null },
  ];
  const stale = staleFilter(rows);
  const ids = stale.map((r) => r.id).sort();
  assert.deepEqual(ids, ['tt-pending', 'tt-unknown']);
});

await cleanupTmp(tmp);

/* ---------------------------------------------------------------------- the stub bd */

const bdtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-cites-bd-'));
const configDir = path.join(bdtmp, 'config');
fs.mkdirSync(configDir, { recursive: true });

const FAKE_BD = path.join(bdtmp, 'bd');
const CALLS = path.join(bdtmp, 'calls.jsonl');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.BEADS_DIR;
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
const worldFile = path.join(dir, 'world.json');
const world = fs.existsSync(worldFile) ? JSON.parse(fs.readFileSync(worldFile, 'utf8')) : { issues: {} };
const args = process.argv.slice(2);
const verb = args[0];
if (verb === 'list') {
  const rows = Object.values(world.issues).slice(0, 1);
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (verb === 'show') {
  const ids = args.slice(1).filter((a) => !a.startsWith('-'));
  const found = ids.map((id) => world.issues[id]).filter(Boolean);
  const missing = ids.filter((id) => !world.issues[id]);
  for (const id of missing) process.stderr.write('Error fetching ' + id + ': no issue found matching "' + id + '"\\n');
  if (!found.length) {
    process.stdout.write(JSON.stringify({ error: 'no issues found matching the provided IDs' }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(found));
  process.exit(0);
}
process.stderr.write('stub bd: unexpected verb "' + verb + '"\\n');
process.exit(1);
`,
  { mode: 0o755 }
);

const WS = { name: 'cites-test', dir: path.join(bdtmp, 'cites-test', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });

const seed = (id, title, status) => ({ id, title, description: '', status, issue_type: 'task', priority: 2, labels: [] });
fs.writeFileSync(
  path.join(WS.dir, 'world.json'),
  JSON.stringify({
    issues: {
      'tt-closed': seed('tt-closed', 'Ordinary closed work', 'closed'),
      'tt-pending': seed('tt-pending', 'Not yet in main', 'closed'),
      'tt-openp': seed('tt-openp', 'Still being worked', 'open'),
    },
  })
);

fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [WS] }, null, 2)
);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-cites-tree-'));
write2(fixtureRoot, 'README.md', '# tree\n');
write2(fixtureRoot, 'lib/foo.js', ['// tt-closed is done.', '// tt-pending is still to come.', '// tt-openp has not settled yet.', '// tt-unknown needs a look.', ''].join('\n'));

function write2(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: fixtureRoot,
    env: { ...process.env, HOME: bdtmp, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}
const callCount = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).length : 0);

check('--help prints usage and exits 0, without ever calling bd', () => {
  const before = callCount();
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-cites/);
  assert.equal(callCount(), before, 'help must not spawn bd');
});

check('whole-tree --json, -w given: one row per citation, joined to the stub tracker', () => {
  const { status, stdout } = run(['--dir', fixtureRoot, '-w', 'cites-test', '--json']);
  assert.equal(status, 0);
  const rows = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId['tt-closed'].status, 'closed');
  assert.equal(byId['tt-closed'].title, 'Ordinary closed work');
  assert.equal(byId['tt-unknown'].status, 'unknown');
  assert.equal(byId['tt-unknown'].title, null);
});

check('one bd spawn carries every id in the batch, not one spawn per id', () => {
  const before = callCount();
  run(['--dir', fixtureRoot, '-w', 'cites-test', '--json']);
  const spawned = callCount() - before;
  // one `list --limit 1` (own-workspace prefix isn't asked here since --bead is not
  // used, but the whole-tree path still needs the prefix — see the next check) plus
  // one batched `show`.
  assert.ok(spawned <= 2, `expected at most 2 bd spawns for a whole-tree run, got ${spawned}`);
});

check('--stale keeps the closed+pending row and the unknown row, drops the open+pending one', () => {
  const { status, stdout } = run(['--dir', fixtureRoot, '-w', 'cites-test', '--stale', '--json']);
  assert.equal(status, 0);
  const rows = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, ['tt-pending', 'tt-unknown']);
});

check('--bead narrows to exactly that one id, everywhere it is quoted', () => {
  const { status, stdout } = run(['--dir', fixtureRoot, '-w', 'cites-test', '--bead', 'tt-closed', '--json']);
  assert.equal(status, 0);
  const rows = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'tt-closed');
  assert.equal(rows[0].line, 1);
});

check('--bead together with a path is refused', () => {
  const { status, stderr } = run(['--dir', fixtureRoot, '-w', 'cites-test', '--bead', 'tt-closed', 'lib/foo.js']);
  assert.equal(status, 2);
  assert.match(stderr, /--bead and a path/);
});

check('-w naming an unknown workspace is refused with exit 4', () => {
  const { status, stderr } = run(['--dir', fixtureRoot, '-w', 'nope']);
  assert.equal(status, 4);
  assert.match(stderr, /no workspace called nope/);
});

check('a narrowing path is honoured — only that file is scanned', () => {
  write2(fixtureRoot, 'lib/bar.js', '// tt-closed also mentioned here, but this path was not given\n');
  const { stdout } = run(['--dir', fixtureRoot, '-w', 'cites-test', '--bead', 'tt-closed']);
  // still just the one hit, from lib/foo.js — bar.js was written after the earlier
  // checks but no path was given there so it would have shown up too; this proves the
  // path filter itself, not just that bar.js is absent.
  const { stdout: narrowed } = run(['--dir', fixtureRoot, '-w', 'cites-test', 'lib/bar.js']);
  assert.match(narrowed, /lib\/bar\.js/);
  assert.doesNotMatch(narrowed, /lib\/foo\.js/);
});

await cleanupTmp(bdtmp);
await cleanupTmp(fixtureRoot);

/* --------------------------------------------------------------------------- done */

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
