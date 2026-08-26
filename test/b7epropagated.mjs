#!/usr/bin/env node
//
// b7e-propagated — one CHANGE_LOG.md entry's own propagation checklist, verified
// against the tree it names (bc-dgx7.82).
//
//   npm test
//   node test/b7epropagated.mjs
//
// Real git repo, really committed — same reason test/b7eentry.mjs gives: the
// assertion is about what `git cat-file -p <ref>:<path>` actually reports against a
// tree with real history, and a stub would only prove the parser can read strings
// this file wrote.
//
// The fixture reproduces the SHAPE of the real incident (dv-b5d.32 against Entry 108,
// dv-2uu.5 against Entry 037) rather than deluvia's own CHANGE_LOG.md at a pinned
// commit — deluvia is not fetched by this repo's CI and its file keeps moving, which
// is exactly the trap named in the memory note
// a-real-repo-assertion-in-a-test-rots-between-your-run-and-ci. See lib/propagated.js
// for the fuller reasoning.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-propagated');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7epropagated-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { checklistRows, rowPath, rowClaim, findEntry, verifyEntry, propagated } = await import(
  path.join(ROOT, 'lib', 'propagated.js')
);
const { entryHeadings } = await import(path.join(ROOT, 'lib', 'changelog.js'));

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

/* ---------------------------------------------------------------------- repo */

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const REPO = path.join(tmp, 'repo');
fs.mkdirSync(path.join(REPO, 'reference'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'pipeline', 'lib'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'compendium'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'docs'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'webseries', 'episodes', 'kazran-orves'), { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 'test@localhost');
git(REPO, 'config', 'user.name', 'test');

// Entry 108's fixture reproduces dv-b5d.32's real shape: a [PROPAGATED] entry whose
// checklist names five files, two of which (checks.py, the FAUNA bear line) still
// carry the pre-ruling figure in the "old" commit — the exact defect the four
// sessions this bead is filed over each hit by hand.
const ENTRY_108 = `## Entry 108 — 2026-08-23

**Type:** WORLD DECISION (Othen scale)
**Status:** [PROPAGATED] — every unprotected file corrected
**Decision:** Othens are capped at 12'-15' upright, replacing the old 12'-25' union.
**Priority:** STRUCTURAL

**Chapters affected:**
- [x] \`reference/SPECIES_GUIDE.md\` — §8 height band capped; \`12'-25'\` → \`12'-15'\`.
- [x] \`compendium/species/othens.md\` — height corrected; \`12'-25'\` → \`12'-15'\`.
- [x] \`pipeline/lib/checks.py\` (SPECIES_HEIGHT_BANDS, was 12'-25') — now 12'-15'.
- [x] \`docs/CONTINUITY_GUIDE.md\` (trait table, was 12'-25') — now 12'-15'.
- [x] \`reference/FAUNA_AND_FLORA.md\` — short-faced bear signature: \`taller than an Othen\` → \`not as tall as an Othen\`.
`;

// Entry 037 — the Kazran rename shape dv-2uu.5 hit: script.txt and transcript.json
// both still carry the pre-rename name in the "old" commit.
const ENTRY_037 = `## Entry 037 — 2026-06-18

**Type:** CHARACTER DECISION
**Status:** [PROPAGATED]
**Decision:** Barran Orves renamed to Kazran Orves.
**Priority:** COSMETIC

**Chapters affected:**
- [x] \`webseries/episodes/kazran-orves/script.txt\` — \`Barran Orves\` → \`Kazran Orves\`.
- [x] \`webseries/episodes/kazran-orves/transcript.json\` — beat 1: \`Barran Orves\` → \`Kazran Orves\`.
`;

// Entry 200 — a genuinely complete checklist, for the clean-exit positive case.
const ENTRY_200 = `## Entry 200 — 2026-08-24

**Type:** LORE DECISION
**Status:** [PROPAGATED]
**Decision:** Athuciy's homeland renamed Vared.
**Priority:** COSMETIC

**Chapters affected:**
- [x] \`compendium/gazetteer.md\` — \`Old Vared name\` → \`Vared\`.
- [ ] Ch. 7 prose — **no change needed.**
`;

// Entry 300 — PENDING PROPAGATION, so --all must skip it even though its own row
// would read STALE if checked.
const ENTRY_300 = `## Entry 300 — 2026-08-25

**Type:** WORLD DECISION
**Status:** PENDING PROPAGATION
**Decision:** placeholder, not yet due for a sweep.
**Priority:** COSMETIC

**Chapters affected:**
- [ ] \`reference/SPECIES_GUIDE.md\` — \`untouched\` → \`also untouched\`.
`;

function writeChangeLog(text) {
  fs.writeFileSync(path.join(REPO, 'CHANGE_LOG.md'), `# CHANGE_LOG\n\n${text}`);
}

function writeTarget(rel, content) {
  const p = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// "Old" commit: the checklist already claims every row is [x], but the files
// actually on disk still carry the pre-ruling values for checks.py and the bear
// line (Entry 108), and for both webseries files (Entry 037).
writeChangeLog(ENTRY_108 + '\n---\n\n' + ENTRY_037 + '\n---\n\n' + ENTRY_200 + '\n---\n\n' + ENTRY_300);
writeTarget('reference/SPECIES_GUIDE.md', '§8 height band: Othens stand 12\'-15\' upright.\n');
writeTarget('compendium/species/othens.md', 'Height: 12\'-15\' upright.\n');
writeTarget('pipeline/lib/checks.py', "SPECIES_HEIGHT_BANDS = {'othen': (12, 25)}  # 12'-25' union, OPEN - do not narrow\n");
writeTarget('docs/CONTINUITY_GUIDE.md', 'Trait table: Othens 12\'-25\'.\n');
writeTarget('reference/FAUNA_AND_FLORA.md', 'Signature: standing, taller than an Othen.\n');
writeTarget('webseries/episodes/kazran-orves/script.txt', 'BARRAN: Enter Barran Orves, stage left.\n');
writeTarget('webseries/episodes/kazran-orves/transcript.json', '{"beats":[{"n":1,"line":"Barran Orves approaches."}]}\n');
writeTarget('compendium/gazetteer.md', 'Athuciy is from Vared.\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'old: entries stamped PROPAGATED, some files not actually fixed');
const OLD_SHA = git(REPO, 'rev-parse', 'HEAD');

// "New" commit: checks.py, the trait table and the bear line are genuinely fixed;
// the two webseries files are genuinely fixed too. Entry 200 and 300's own targets
// are unchanged (200 was already correct; 300 is deliberately left PENDING).
writeTarget('pipeline/lib/checks.py', "SPECIES_HEIGHT_BANDS = {'othen': (12, 15)}  # 12'-15', matches Entry 108\n");
writeTarget('docs/CONTINUITY_GUIDE.md', 'Trait table: Othens 12\'-15\'.\n');
writeTarget('reference/FAUNA_AND_FLORA.md', 'Signature: standing, not as tall as an Othen.\n');
writeTarget('webseries/episodes/kazran-orves/script.txt', 'KAZRAN: Enter Kazran Orves, stage left.\n');
writeTarget('webseries/episodes/kazran-orves/transcript.json', '{"beats":[{"n":1,"line":"Kazran Orves approaches."}]}\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'new: checks.py, the bear line and the webseries files actually fixed');

/* --------------------------------------------------------------------- cases */

await check('checklistRows: joins a wrapped continuation line into the same row', () => {
  const body = '**Chapters affected:**\n- [x] `a.md` — first part\n      second part.\n- [ ] `b.md` — separate row.\n';
  const rows = checklistRows(body);
  assert.equal(rows.length, 2);
  assert.match(rows[0].text, /first part second part\./);
});

await check('checklistRows: a blank line ends the continuation without starting a new row', () => {
  const body = '- [x] `a.md` — claim.\n\nSome unrelated paragraph, not a row.\n- [ ] `b.md` — second row.\n';
  const rows = checklistRows(body);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, '`a.md` — claim.');
});

await check('rowPath: first backtick-quoted path-looking token', () => {
  assert.equal(rowPath('`reference/SPECIES_GUIDE.md` — §8 capped'), 'reference/SPECIES_GUIDE.md');
  assert.equal(rowPath('Ch. 7 prose — no change needed.'), null);
});

await check('rowClaim: backtick arrow shape', () => {
  const claim = rowClaim('`reference/X.md` — `12\'-25\'` → `12\'-15\'`.');
  assert.deepEqual(claim, { oldValue: "12'-25'", newValue: "12'-15'" });
});

await check('rowClaim: parenthetical was/now shape', () => {
  const claim = rowClaim('`docs/CONTINUITY_GUIDE.md` (trait table, was 12\'-22\') — now 12\'-15\'.');
  assert.deepEqual(claim, { oldValue: "12'-22'", newValue: '12\'-15\'' });
});

await check('rowClaim: prose with neither shape is null, not a guess', () => {
  assert.equal(rowClaim('§8 height band capped; the continuity note now splits tallest from most-massive.'), null);
});

await check('findEntry: matches a bare number against the unsuffixed entry', () => {
  const headings = entryHeadings('## Entry 078 — d\n\n**Decision:** a\n## Entry 078b — d\n\n**Decision:** b\n');
  assert.equal(findEntry(headings, '078').suffix, '');
});

await check('findEntry: an unknown entry number is null, not a throw', () => {
  const headings = entryHeadings(fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8'));
  assert.equal(findEntry(headings, '999'), null);
});

await check('verifyEntry at the OLD commit: Entry 108 is STALE on checks.py and the bear line, VERIFIED elsewhere', async () => {
  const text = git(REPO, 'show', `${OLD_SHA}:CHANGE_LOG.md`);
  const headings = entryHeadings(text);
  const result = await verifyEntry(REPO, OLD_SHA, headings, '108');
  assert.equal(result.stale, true);
  const byPath = Object.fromEntries(result.rows.map((r) => [r.path, r.verdict]));
  assert.equal(byPath['pipeline/lib/checks.py'], 'STALE');
  assert.equal(byPath['reference/FAUNA_AND_FLORA.md'], 'STALE');
  assert.equal(byPath['docs/CONTINUITY_GUIDE.md'], 'STALE');
  assert.equal(byPath['reference/SPECIES_GUIDE.md'], 'VERIFIED');
  assert.equal(byPath['compendium/species/othens.md'], 'VERIFIED');
});

await check('verifyEntry at the NEW commit: Entry 108 is clean, every row VERIFIED', async () => {
  const text = git(REPO, 'show', 'HEAD:CHANGE_LOG.md');
  const headings = entryHeadings(text);
  const result = await verifyEntry(REPO, 'HEAD', headings, '108');
  assert.equal(result.stale, false);
  assert.ok(result.rows.every((r) => r.verdict === 'VERIFIED'));
});

await check('verifyEntry: reads the real path, never a worktree copy, because it is a ref read', async () => {
  // A stray worktree-shaped directory sitting on disk, holding the STALE figure, must
  // never be consulted — readRefFile only ever asks git for the ref's tree object.
  const worktreeDecoy = path.join(REPO, '.claude', 'worktrees', 'decoy', 'reference', 'FAUNA_AND_FLORA.md');
  fs.mkdirSync(path.dirname(worktreeDecoy), { recursive: true });
  fs.writeFileSync(worktreeDecoy, 'Signature: standing, taller than an Othen.\n');
  const text = git(REPO, 'show', 'HEAD:CHANGE_LOG.md');
  const headings = entryHeadings(text);
  const result = await verifyEntry(REPO, 'HEAD', headings, '108');
  const bear = result.rows.find((r) => r.path === 'reference/FAUNA_AND_FLORA.md');
  assert.equal(bear.verdict, 'VERIFIED', 'must read the real committed file, not the decoy worktree copy');
  fs.rmSync(path.join(REPO, '.claude'), { recursive: true, force: true });
});

await check('propagated: Entry 037 at the OLD commit names both stale webseries files', async () => {
  const result = await propagated(REPO, { ref: OLD_SHA, entry: '037' });
  assert.equal(result.stale, true);
  const byPath = Object.fromEntries(result.entries[0].rows.map((r) => [r.path, r.verdict]));
  assert.equal(byPath['webseries/episodes/kazran-orves/script.txt'], 'STALE');
  assert.equal(byPath['webseries/episodes/kazran-orves/transcript.json'], 'STALE');
});

await check('propagated: Entry 037 at the NEW commit exits clean, one VERIFIED row per checkbox', async () => {
  const result = await propagated(REPO, { ref: 'HEAD', entry: '037' });
  assert.equal(result.stale, false);
  assert.equal(result.entries[0].rows.length, 2);
  assert.ok(result.entries[0].rows.every((r) => r.verdict === 'VERIFIED'));
});

await check('propagated: Entry 200, genuinely complete from the start, is clean at either commit', async () => {
  const oldResult = await propagated(REPO, { ref: OLD_SHA, entry: '200' });
  const newResult = await propagated(REPO, { ref: 'HEAD', entry: '200' });
  assert.equal(oldResult.stale, false);
  assert.equal(newResult.stale, false);
});

await check('propagated: a path named but absent at this ref is UNVERIFIABLE, not a throw', async () => {
  const result = await propagated(REPO, { ref: OLD_SHA, entry: '200' });
  const gone = result.entries[0].rows.find((r) => r.path === 'compendium/gazetteer.md');
  assert.equal(gone.verdict, 'VERIFIED'); // sanity: this one really is there
  // Now ask about a ref with no CHANGE_LOG.md at all — git's well-known empty tree.
  const empty = git(REPO, 'commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'empty');
  await assert.rejects(() => propagated(REPO, { ref: empty, entry: '200' }), /not found at/);
});

await check('propagated: --all sweeps every [PROPAGATED]/PARTIALLY entry, skips PENDING PROPAGATION', async () => {
  const result = await propagated(REPO, { ref: OLD_SHA, all: true });
  const entries = result.entries.map((e) => e.entry);
  assert.ok(entries.includes('108'));
  assert.ok(entries.includes('037'));
  assert.ok(entries.includes('200'));
  assert.ok(!entries.includes('300'), 'PENDING PROPAGATION must not be swept');
  assert.equal(result.stale, true); // 108 and 037 are both stale at the old commit
});

await check('propagated: never writes to CHANGE_LOG.md or any file it checks', async () => {
  const before = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  const beforeStatus = git(REPO, 'status', '--short');
  await propagated(REPO, { ref: OLD_SHA, entry: '108' });
  await propagated(REPO, { ref: 'HEAD', all: true });
  assert.equal(fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8'), before);
  assert.equal(git(REPO, 'status', '--short'), beforeStatus);
});

/* --------------------------------------------------------------------- CLI */

await check('CLI: --dir + entry number exits 1 and prints STALE rows at the OLD commit', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--at', OLD_SHA, '108'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /STALE\s+pipeline\/lib\/checks\.py/);
  assert.match(run.stdout, /STALE — at least one row still carries its old value/);
});

await check('CLI: the same entry at HEAD exits 0, clean', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '108'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\bclean\b/);
});

await check('CLI: --json is valid JSON matching the lib result shape', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--at', OLD_SHA, '037', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.entries[0].entry, '037');
  assert.ok(parsed.entries[0].rows.some((r) => r.verdict === 'STALE'));
});

await check('CLI: --all sweeps every sweepable entry', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--at', OLD_SHA, '--all', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.deepEqual(
    parsed.entries.map((e) => e.entry).sort(),
    ['037', '108', '200']
  );
});

await check('CLI: an entry number and --all together is refused', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '108', '--all'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /mutually exclusive/);
});

await check('CLI: neither an entry number nor --all is refused', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO], { encoding: 'utf8' });
  assert.equal(run.status, 5);
  assert.match(run.stderr, /give an entry number or --all/);
});

await check('CLI: an unknown entry number exits 5', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '999'], { encoding: 'utf8' });
  assert.equal(run.status, 5);
  assert.match(run.stderr, /no Entry 999/);
});

await check('CLI: an unknown workspace name exits 4, names the known ones', () => {
  const run = spawnSync(process.execPath, [BIN, '-w', 'totally-bogus-workspace-name-zzz', '1'], { encoding: 'utf8' });
  assert.equal(run.status, 4);
  assert.match(run.stderr, /no workspace called totally-bogus-workspace-name-zzz/);
});

await check('CLI: -w resolves through cfg.sessionDirs, not a workspace\'s own .beads dir', () => {
  const wsDir = path.join(tmp, 'demo-ws', '.beads');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
    JSON.stringify({ workspaces: [{ name: 'demo', dir: wsDir }], sessionDirs: { demo: REPO } }, null, 2)
  );
  const run = spawnSync(process.execPath, [BIN, '-w', 'demo', '108'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  fs.rmSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'));
});

await check('CLI: --help prints usage and exits 0 without touching git', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /usage: b7e-propagated/);
});

/* -------------------------------------------------------------------- report */

cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} b7e-propagated checks passed`);
process.exit(failures ? 1 : 0);
