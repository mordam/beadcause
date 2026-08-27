#!/usr/bin/env node
//
// b7e-changelog — one CHANGE_LOG.md entry's line span, Type:/Status: fields,
// checklist and body, all with real file line numbers (bc-dgx7.100).
//
//   npm test
//   node test/b7echangelog.mjs
//
// Real git repo, really committed — same reason test/b7eentry.mjs and
// test/b7epropagated.mjs give: the assertion is about what `git cat-file -p
// <ref>:<path>` actually reports against a tree with real content, and a stub would
// only prove the parser can read strings this file wrote. Not deluvia's own
// CHANGE_LOG.md at a pinned commit, for the same reason named in the memory note
// a-real-repo-assertion-in-a-test-rots-between-your-run-and-ci: deluvia is not
// fetched by this repo's CI and its file keeps moving. The fixture reproduces the
// SHAPE the bead names instead — entries in descending, non-contiguous order (117,
// then 115 — 116 never existed), plus the two template headings every real file
// carries, which must never be counted as entries.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-changelog');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7echangelog-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { entryHeadings, fieldOf, checklistRows, findEntry, entryDetail, entryIndex, changelogLookup } = await import(
  path.join(ROOT, 'lib', 'changelog.js')
);

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
fs.mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 'test@localhost');
git(REPO, 'config', 'user.name', 'test');

// The template section every real CHANGE_LOG.md carries — "## Entry Format" and its
// own "## Entry [NNN] — [DATE]" line — neither has digits where entryHeadings looks
// for them, so both must be excluded from every count below.
const TEMPLATE = `## Entry Format

Describes how to write an entry.

## Entry [NNN] — [DATE]

**Type:** [TYPE]
**Status:** [STATUS]
**Decision:** [DECISION]

**Chapters affected:**
- [ ] placeholder
`;

// Entry 117: the shape dv-gr6.47 actually needed — a multi-line checklist row (a
// wrapped continuation) plus a second, single-line row.
const ENTRY_117 = `## Entry 117 — 2026-08-20

**Type:** WORLD DECISION
**Status:** PENDING PROPAGATION
**Decision:** Sloths are reclassified as a primary awe engine for Books 1-2.
**Priority:** STRUCTURAL

**Chapters affected:**
- [ ] \`reference/SPECIES_GUIDE.md\` — §8 height band capped; the sloth-clade
      continuity note now splits tallest from most-massive.
- [x] Book 2, Ch. 4 — reworded per the ruling.
`;

// 116 deliberately does not exist — the exact gap the bead's acceptance criteria
// names: entry 117 must end at the start of 115, not at a heading built from
// arithmetic on the number.
const ENTRY_115 = `## Entry 115 — 2026-08-18

**Type:** LORE DECISION
**Status:** [PROPAGATED]
**Decision:** Athuciy's homeland renamed Vared.

**Chapters affected:**
- [x] \`compendium/gazetteer.md\` — \`Old Vared name\` → \`Vared\`.
`;

// A handful more entries, purely to exercise "every entry present, no span overlaps
// its neighbour and none is empty" across more than two.
function makeEntry(num, date) {
  return `## Entry ${num} — ${date}\n\n**Type:** COSMETIC\n**Status:** [PROPAGATED]\n**Decision:** placeholder ${num}.\n\n**Chapters affected:**\n- [x] placeholder row ${num}.\n`;
}
const FILLER = [90, 91, 92, 93].map((n) => makeEntry(n, '2026-07-0' + (n - 89)));

const FULL_LOG = ['# CHANGE_LOG\n', TEMPLATE, ENTRY_117, ENTRY_115, ...FILLER].join('\n---\n\n');
fs.writeFileSync(path.join(REPO, 'CHANGE_LOG.md'), FULL_LOG);
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'base');

/* --------------------------------------------------------------------- lib */

await check('fieldOf: pulls one single-line **Field:** value', () => {
  assert.equal(fieldOf('**Type:** WORLD DECISION\n**Status:** X\n', 'Type'), 'WORLD DECISION');
  assert.equal(fieldOf('**Status:** X\n', 'Priority'), null);
});

await check('entryDetail: entry 117 spans exactly its own lines, ending before 115', () => {
  const text = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  const detail = entryDetail(text, '117');
  const lines = text.split('\n');
  assert.equal(lines[detail.startLine - 1], '## Entry 117 — 2026-08-20');
  // The next non-blank, non-separator content after this span must be Entry 115's
  // own heading, not some line still inside 117 — the exact failure a guessed
  // arithmetic range hits.
  let i = detail.endLine; // 0-indexed next line
  while (lines[i] !== undefined && (lines[i].trim() === '' || lines[i].trim() === '---')) i += 1;
  assert.equal(lines[i], '## Entry 115 — 2026-08-18');
});

await check('entryDetail: type, status and checklist (with continuation) parse out with line numbers', () => {
  const text = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  const detail = entryDetail(text, '117');
  assert.equal(detail.type, 'WORLD DECISION');
  assert.equal(detail.status, 'PENDING PROPAGATION');
  assert.equal(detail.checklist.length, 2);
  assert.match(detail.checklist[0].text, /continuity note now splits/); // wrapped line joined
  assert.equal(detail.checklist[0].checked, false);
  assert.equal(detail.checklist[1].checked, true);
  // Every checklist line number must actually point at that row's own "- [ ]"/"- [x]"
  // line in the file, not the continuation line or some other offset.
  const lines = text.split('\n');
  for (const row of detail.checklist) {
    assert.match(lines[row.line - 1], /^- \[[ xX]\]/, `line ${row.line} is not a checkbox line`);
  }
});

await check('entryDetail: an unknown entry number is null, not a throw', () => {
  const text = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  assert.equal(entryDetail(text, '116'), null);
});

await check('entryIndex: excludes both template headings — real entries only', () => {
  const text = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  const index = entryIndex(text);
  assert.equal(index.length, 6); // 117, 115, 90, 91, 92, 93 — never the two [NNN] template lines
  assert.ok(!index.some((e) => e.entry.includes('NNN')));
});

await check('entryDetail: no two entries in the file overlap, and none is empty', () => {
  const text = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  const headings = entryHeadings(text);
  const details = headings.map((h) => entryDetail(text, `${h.digits}${h.suffix}`));
  for (const d of details) assert.ok(d.endLine >= d.startLine, `${d.entry} is empty`);
  const sorted = [...details].sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].startLine > sorted[i - 1].endLine, `${sorted[i - 1].entry} overlaps ${sorted[i].entry}`);
  }
});

await check('changelogLookup: --ref works from a ref read, no temp file needed', async () => {
  const result = await changelogLookup(REPO, { ref: 'main', entry: '117' });
  assert.equal(result.entry, '117');
  assert.equal(result.ref, 'main');
});

await check('changelogLookup: an unknown entry rejects, names the entry and file', async () => {
  await assert.rejects(() => changelogLookup(REPO, { ref: 'main', entry: '116' }), /no Entry 116/);
});

await check('changelogLookup: --list returns the same index as entryIndex', async () => {
  const result = await changelogLookup(REPO, { ref: 'main', list: true });
  assert.equal(result.entries.length, 6);
});

await check('findEntry/checklistRows are re-exported from lib/propagated.js unchanged', async () => {
  const propagated = await import(path.join(ROOT, 'lib', 'propagated.js'));
  assert.equal(propagated.findEntry, findEntry);
  assert.equal(propagated.checklistRows, checklistRows);
});

/* --------------------------------------------------------------------- CLI */

await check('CLI: an entry number prints its span, fields, checklist and body with line numbers', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--ref', 'main', '117'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Entry 117, lines \d+-\d+/);
  assert.match(run.stdout, /Status: PENDING PROPAGATION/);
  assert.match(run.stdout, /^\d+: - \[ \] `reference\/SPECIES_GUIDE\.md`/m);
});

await check('CLI: entry 116 (never existed) exits non-zero and says so', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--ref', 'main', '116'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /no Entry 116/);
});

await check('CLI: --list prints every real entry, not the two template rows', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--ref', 'main', '--list'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /6 entries/);
  assert.match(run.stdout, /117\s+line \d+/);
  assert.match(run.stdout, /115\s+line \d+/);
});

await check('CLI: --json is valid JSON matching the lib result shape', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--ref', 'main', '117', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.entry, '117');
  assert.equal(parsed.checklist.length, 2);
  assert.ok(Array.isArray(parsed.body));
});

await check('CLI: --field status prints only the Status: value', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--ref', 'main', '117', '--field', 'status'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'PENDING PROPAGATION');
});

await check('CLI: --field checklist prints only the checklist rows, each with its line number', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--ref', 'main', '117', '--field', 'checklist'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\s*\d+: \[ \]/);
  assert.match(lines[1], /^\s*\d+: \[x\]/);
});

await check('CLI: an entry number and --list together is refused', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '117', '--list'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /mutually exclusive/);
});

await check('CLI: neither an entry number nor --list is refused', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO], { encoding: 'utf8' });
  assert.equal(run.status, 5);
  assert.match(run.stderr, /give an entry number or --list/);
});

await check('CLI: --field with --list is refused', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--list', '--field', 'status'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /applies to one entry/);
});

await check('CLI: an unknown --field value is refused', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '117', '--field', 'bogus'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--field must be one of/);
});

await check('CLI: an unknown workspace name exits 4, names the known ones', () => {
  const run = spawnSync(process.execPath, [BIN, '-w', 'totally-bogus-workspace-name-zzz', '1'], { encoding: 'utf8' });
  assert.equal(run.status, 4);
  assert.match(run.stderr, /no workspace called totally-bogus-workspace-name-zzz/);
});

await check("CLI: -w resolves through cfg.sessionDirs, not a workspace's own .beads dir", () => {
  const wsDir = path.join(tmp, 'demo-ws', '.beads');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
    JSON.stringify({ workspaces: [{ name: 'demo', dir: wsDir }], sessionDirs: { demo: REPO } }, null, 2)
  );
  const run = spawnSync(process.execPath, [BIN, '-w', 'demo', '--ref', 'main', '117'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  fs.rmSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'));
});

await check('CLI: --help prints usage and exits 0 without touching git', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /usage: b7e-changelog/);
});

await check('CLI: never writes to CHANGE_LOG.md', () => {
  const before = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  spawnSync(process.execPath, [BIN, '--dir', REPO, '--ref', 'main', '117'], { encoding: 'utf8' });
  spawnSync(process.execPath, [BIN, '--dir', REPO, '--ref', 'main', '--list'], { encoding: 'utf8' });
  assert.equal(fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8'), before);
});

/* -------------------------------------------------------------------- report */

cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} b7e-changelog checks passed`);
process.exit(failures ? 1 : 0);
