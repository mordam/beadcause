#!/usr/bin/env node
//
// b7e-readme — where in README.md something belongs, in one call instead of four to ten
// failed greps (bc-khoe.46).
//
//   npm test
//   node test/b7ereadme.mjs
//
// Section 1 drives lib/readme.js directly against a small fabricated document — a
// 24,702-line README is not something a regression test should depend on holding still
// while it also asserts on it, and it changes under this test constantly: dozens of
// worktrees edit it concurrently (see beadcause-main-moves-constantly). Section 2 drives
// the real bin/b7e-readme against that same fixture, on disk, via --dir — the argv
// parsing, --json, --sketch, --anchor, --for and the exit codes. Section 3 is a small
// number of spot checks against THIS repo's real README, using slugs and headings old
// enough to be load-bearing elsewhere (the router section is linked from the README's own
// front matter) rather than anything a same-day edit is likely to move.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze, findByAnchor, searchSections, slug } from '../lib/readme.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-readme');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ===================================================================== *
 * 1. lib/readme.js against a fabricated document
 * ===================================================================== */

console.log('\nparsing and matching (fabricated document)');

// Line numbers below are asserted against this exact string, so keep any edit lined up
// with the comment beside each block.
const FIXTURE = [
  /* 1 */ '# Fixture',
  /* 2 */ '',
  /* 3 */ 'Front matter above every heading.',
  /* 4 */ '',
  /* 5 */ '## The router — why you never restart it', // slug has a double hyphen (em dash)
  /* 6 */ '',
  /* 7 */ 'A backend binds the port once.',
  /* 8 */ '',
  /* 9 */ '### A router older than its own source',
  /* 10 */ '',
  /* 11 */ 'off loopback from the router or straight off the tailnet.',
  /* 12 */ '',
  /* 13 */ '### The WebSocket goes through it too',
  /* 14 */ '',
  /* 15 */ 'nothing about the tailnet here.',
  /* 16 */ '',
  /* 17 */ '## HTTP API',
  /* 18 */ '',
  /* 19 */ '| Method | Path | Returns |',
  /* 20 */ '|---|---|---|',
  /* 21 */ '| GET | /api/poll | long-poll |',
  /* 22 */ '| GET | /api/health | ok |',
  /* 23 */ '',
  /* 24 */ '## Spaces',
  /* 25 */ '',
  /* 26 */ '### Space details',
  /* 27 */ '',
  /* 28 */ '```',
  /* 29 */ '│  ●  ▣⚙   [ Personal    ▾ ]  Config      ⟳    │',
  /* 30 */ '```',
  /* 31 */ '',
  /* 32 */ 'A plain shell fence, no box-drawing:',
  /* 33 */ '',
  /* 34 */ '```bash',
  /* 35 */ 'npm run swap:status',
  /* 36 */ '```',
  /* 37 */ '',
  /* 38 */ '## Unrelated',
  /* 39 */ '',
  /* 40 */ 'A second instance — observer mode also lives here, alone.',
].join('\n');

const a = analyze(FIXTURE);

check('slug: GitHub em-dash rule (spaces either side both become hyphens)', slug('A second instance — observer mode') === 'a-second-instance--observer-mode');

check(
  'headings: 8, in document order, at the right levels and lines',
  a.headings.length === 8 &&
    a.headings[0].title === 'Fixture' &&
    a.headings[1].title === 'The router — why you never restart it' &&
    a.headings[1].level === 2 &&
    a.headings[1].line === 5,
  JSON.stringify(a.headings.map((h) => [h.level, h.title, h.line]))
);

check(
  'fences: the picker is a sketch, the bash snippet is not',
  a.fences.length === 2 && a.fences[0].isSketch === true && a.fences[1].isSketch === false,
  JSON.stringify(a.fences)
);

check(
  'tables: the API table is found, and only it',
  a.tables.length === 1 && a.tables[0].startLine === 19 && a.tables[0].endLine === 22,
  JSON.stringify(a.tables)
);

{
  // single term: one row per distinct innermost heading, in document order
  const { mode, sections } = searchSections(a, ['tailnet']);
  check('single term: mode is "each"', mode === 'each');
  check(
    'single term: two distinct headings, in document order',
    sections.length === 2 && sections[0].slug === 'a-router-older-than-its-own-source' && sections[1].slug === 'the-websocket-goes-through-it-too',
    JSON.stringify(sections.map((s) => s.slug))
  );
}

{
  // multi-term: the smallest heading whose SUBTREE contains every term, even when no
  // single line (or single heading's own body) has all of them — "bind" is in the
  // router's own opening line, "tailnet" is two subsections down.
  const { mode, sections } = searchSections(a, ['tailnet', 'binds']);
  check('multi term (scattered across children): mode is "lca"', mode === 'lca');
  check(
    'multi term (scattered across children): resolves to the parent, not either child',
    sections.length === 1 && sections[0].slug === 'the-router--why-you-never-restart-it' && sections[0].startLine === 5 && sections[0].endLine === 16,
    JSON.stringify(sections)
  );
}

{
  // multi-term with no shared section at all: falls back to "each", one row per term's
  // own nearest heading, rather than claiming nothing was found.
  const { mode, sections } = searchSections(a, ['tailnet', '/api/poll']);
  check('multi term (no shared section): falls back to "each"', mode === 'each');
  check(
    'multi term (no shared section): both nearest sections reported',
    sections.some((s) => s.slug === 'a-router-older-than-its-own-source') && sections.some((s) => s.slug === 'http-api'),
    JSON.stringify(sections.map((s) => s.slug))
  );
}

{
  const { sections } = searchSections(a, ['/api/poll']);
  check(
    'table row is flagged kind "table", not "prose"',
    sections.length === 1 && sections[0].slug === 'http-api' && sections[0].kinds.includes('table'),
    JSON.stringify(sections)
  );
}

{
  const withoutSketch = searchSections(a, ['Personal']);
  check('"Personal" appears once, inside the sketch, unrestricted', withoutSketch.sections.length === 1 && withoutSketch.sections[0].kinds.includes('sketch'));
  const restricted = searchSections(a, ['Personal'], { sketchOnly: true });
  check('--sketch semantics: same single hit, still flagged sketch', restricted.sections.length === 1 && restricted.sections[0].kinds.includes('sketch'));
  const nowhere = searchSections(a, ['swap:status'], { sketchOnly: true });
  check('--sketch semantics: a term only in a plain (non-sketch) fence is excluded', nowhere.sections.length === 0, JSON.stringify(nowhere));
}

{
  const hits = findByAnchor(a, 'the-router--why-you-never-restart-it');
  check('--anchor reverse lookup: exact hit', hits.length === 1 && hits[0].startLine === 5 && hits[0].endLine === 16);
  const miss = findByAnchor(a, 'no-such-heading');
  check('--anchor reverse lookup: miss is an empty array, not a throw', Array.isArray(miss) && miss.length === 0);
}

/* ===================================================================== *
 * 2. bin/b7e-readme against the same fixture, on disk, via --dir
 * ===================================================================== */

console.log('\nthe CLI (fabricated tree, via --dir)');

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7ereadme-test-'));
fs.writeFileSync(path.join(tmp, 'README.md'), FIXTURE);
const run = (args) => spawnSync(process.execPath, [BIN, '--dir', tmp, ...args], { encoding: 'utf8' });

{
  const r = run(['/api/poll']);
  check('--for-less positional term also works; exits 0', r.status === 0, r.stderr);
  check('reports the table anchor', /#http-api/.test(r.stdout), r.stdout);
  check('reports the table kind', /\(table\)/.test(r.stdout), r.stdout);
}

{
  const r = run(['--for', '/api/poll']);
  check('--for exits 0 and matches the bare-positional form', r.status === 0 && /#http-api/.test(r.stdout), r.stdout);
}

{
  const r = run(['--anchor', 'the-router--why-you-never-restart-it']);
  check('--anchor exits 0', r.status === 0, r.stderr);
  check('--anchor reports the right line range', /README\.md:5-16/.test(r.stdout), r.stdout);
}

{
  const r = run(['nope-not-anywhere']);
  check('no match: exit 1, not a crash', r.status === 1, `status ${r.status}\n${r.stderr}`);
}

{
  const r = run(['--anchor', 'nope-not-anywhere']);
  check('--anchor miss: exit 1', r.status === 1, r.stderr);
}

{
  const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  check('no args: exit 2 (bad usage), not 0 or 1', r.status === 2, `status ${r.status}`);
  check('no args: usage on stderr', /b7e-readme/.test(r.stderr), r.stderr);
}

{
  const r = run(['tailnet', 'binds', '--json']);
  check('--json: exits 0', r.status === 0, r.stderr);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
    ok('--json: valid JSON');
  } catch (err) {
    bad('--json: valid JSON', err.message);
  }
  check(
    '--json: same LCA result as the direct call',
    parsed && parsed.mode === 'lca' && parsed.sections.length === 1 && parsed.sections[0].slug === 'the-router--why-you-never-restart-it',
    r.stdout
  );
}

{
  const r = run(['Personal', '--sketch']);
  check('--sketch via CLI: exits 0', r.status === 0, r.stderr);
  check('--sketch via CLI: reports the sketch kind', /\(sketch\)/.test(r.stdout), r.stdout);
}

{
  const r = run(['swap:status', '--sketch']);
  check('--sketch via CLI: a plain-fence-only term finds nothing (exit 1)', r.status === 1, `status ${r.status}\n${r.stdout}`);
}

{
  const r = run(['--anchor', 'x', 'y']);
  check('--anchor plus terms is refused (exit 2), not silently ignored', r.status === 2, `status ${r.status}`);
}

fs.rmSync(tmp, { recursive: true, force: true });

/* ===================================================================== *
 * 3. spot checks against this repo's real README.md
 * ===================================================================== */

console.log("\nagainst this repo's own README");

{
  const r = spawnSync(process.execPath, [BIN, '--anchor', 'the-router--why-you-never-restart-it'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  check(
    'the router section resolves — its anchor is linked from the README\'s own front matter, so a break here breaks that link too',
    r.status === 0 && /^README\.md:\d+-\d+ {2}\(prose\) {2}#the-router--why-you-never-restart-it$/m.test(r.stdout),
    r.stdout + r.stderr
  );
}

{
  const r = spawnSync(process.execPath, [BIN, '--for', '/api/poll', '--json'], { cwd: ROOT, encoding: 'utf8' });
  const parsed = r.status === 0 ? JSON.parse(r.stdout) : null;
  const httpApi = parsed && parsed.sections.find((s) => s.slug === 'http-api');
  check(
    'the HTTP API reference table is among the sections /api/poll turns up, flagged table',
    r.status === 0 && httpApi && httpApi.kinds.includes('table'),
    r.stdout + r.stderr
  );
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
