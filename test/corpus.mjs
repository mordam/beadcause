#!/usr/bin/env node
//
// b7e-count — one deterministic occurrence census for a literal, at a git ref (bc-dgx7.59).
// Four sessions (dv-i5v, dv-5i2.44, dv-nnk, dv-6cn) each hand-rolled a different
// pipeline for the same question and got different numbers back; this is that command.
//
//   npm test
//   node test/corpus.mjs
//
// Two kinds of proof, the same split test/census.mjs uses for the same reason: the
// counting in lib/corpus.js is exercised directly against small fabricated git trees
// (lib/fixture.js) — no `bd`, no workspace config, just `git grep` at a real ref — and
// then bin/b7e-count is driven as a real subprocess, both with `--dir` (the argv/wiring
// surface) and once with `-w` against a fabricated workspace config, to prove the
// acceptance criterion's own shape (`b7e-count -w <workspace> --ref <ref> <literal>...`)
// resolves to the right checkout without depending on a real, moving repo over the
// network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixture } from '../lib/fixture.js';
import { REPO_ROOT, resolveRef, countOccurrences, census } from '../lib/corpus.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-count');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nb7e-count\n');

/* ============================================================== lib/corpus.js */

const file = (p, content) => ({ type: 'file', path: p, content });
const commit = (message = 'commit') => ({ type: 'commit', message });

// One fixture, reused by every lib/corpus.js check below: three files, a term that
// appears more than once on the same line (the exact distinction dv-i5v's three
// pipelines disagreed on — a matching *line* is not the same number as a matching
// *occurrence*), a term that appears nowhere, and a nested `.claude/worktrees/` path
// standing in for a stray sibling git worktree sitting on disk.
const fx = buildFixture({
  name: 'corpus-lib',
  steps: [
    file('a.md', 'Athira met Athira again.\nA plain line.\n'),
    file('sub/b.md', 'Lady Athira arrived.\n'),
    file('sub/c.md', 'Arthir is the old name.\n'),
    file('.claude/worktrees/stale-sibling/a.md', 'Athira Athira Athira Athira\n'),
    commit('census fixture'),
  ],
});

check('countOccurrences: counts occurrences, not matching lines', () => {
  // "Athira met Athira again." is ONE line and TWO occurrences — `git grep -c` would
  // have said 1 here, which is exactly the gap between dv-i5v's `-lI` pipeline and its
  // `python3` one.
  const r = countOccurrences(fx.dir, 'main', 'Athira');
  assert.equal(r.occurrences, 3, `expected 3 (2 in a.md + 1 in sub/b.md's "Lady Athira"), got ${r.occurrences}`);
  assert.equal(r.files, 2);
});

check('countOccurrences: always excludes .claude/worktrees, so a stale sibling worktree cannot inflate the count', () => {
  const r = countOccurrences(fx.dir, 'main', 'Athira');
  assert.ok(
    !r.perFile.some((f) => f.path.includes('.claude/worktrees')),
    `a .claude/worktrees path leaked into the count: ${JSON.stringify(r.perFile)}`
  );
});

check('countOccurrences: perFile is sorted by count descending, path ascending on ties', () => {
  const r = countOccurrences(fx.dir, 'main', 'Athira');
  assert.deepEqual(r.perFile, [
    { path: 'a.md', count: 2 },
    { path: 'sub/b.md', count: 1 },
  ]);
});

check('countOccurrences: a pattern present nowhere is a clean zero, not a refusal', () => {
  const r = countOccurrences(fx.dir, 'main', 'NoSuchLiteralAnywhereInThisFixture');
  assert.deepEqual(r, { pattern: 'NoSuchLiteralAnywhereInThisFixture', regex: false, occurrences: 0, files: 0, perFile: [] });
});

check('countOccurrences: --regex runs an extended regex, not a fixed string', () => {
  const literal = countOccurrences(fx.dir, 'main', 'Ath[ei]ra');
  assert.equal(literal.occurrences, 0, 'the literal "Ath[ei]ra" appears nowhere in the fixture');
  const asRegex = countOccurrences(fx.dir, 'main', 'Ath[ei]ra', { regex: true });
  assert.equal(asRegex.occurrences, 3, 'as a regex it matches every "Athira" in the fixture, same as the -F count above');
});

check('countOccurrences: --paths narrows to a pathspec glob', () => {
  const r = countOccurrences(fx.dir, 'main', 'Athira', { paths: ['sub/*'] });
  assert.deepEqual(r.perFile, [{ path: 'sub/b.md', count: 1 }]);
});

check('countOccurrences: --exclude removes a path on top of the always-excluded two', () => {
  const r = countOccurrences(fx.dir, 'main', 'Athira', { excludes: ['a.md'] });
  assert.deepEqual(r.perFile, [{ path: 'sub/b.md', count: 1 }]);
});

check('countOccurrences: a bad --regex throws rather than silently matching nothing', () => {
  assert.throws(() => countOccurrences(fx.dir, 'main', 'Athira[', { regex: true }), /git grep failed/);
});

check('countOccurrences: running it twice on an unchanged tree returns byte-identical results', () => {
  const a = countOccurrences(fx.dir, 'main', 'Athira');
  const b = countOccurrences(fx.dir, 'main', 'Athira');
  assert.deepEqual(a, b);
});

check('census: one result per pattern, in the order given', () => {
  const rows = census(fx.dir, 'main', ['Athira', 'Arthir', 'NoSuchLiteralAnywhere']);
  assert.deepEqual(rows.map((r) => r.pattern), ['Athira', 'Arthir', 'NoSuchLiteralAnywhere']);
  assert.equal(rows[0].occurrences, 3);
  assert.equal(rows[1].occurrences, 1);
  assert.equal(rows[2].occurrences, 0);
});

check('resolveRef: an explicit ref that resolves is returned as-is', () => {
  assert.equal(resolveRef(fx.dir, 'main'), 'main');
});

check('resolveRef: an explicit ref that does not resolve throws, rather than silently falling back', () => {
  assert.throws(() => resolveRef(fx.dir, 'not-a-real-ref'), /does not resolve to a tree/);
});

check('resolveRef: with none given, falls back to main when origin/main does not resolve', () => {
  // fx has a bare `origin` remote registered but nothing pushed to it, so
  // `origin/main` does not resolve and the fallback to the local `main` is what a
  // workspace with no remote (or nothing pushed yet) needs.
  assert.equal(resolveRef(fx.dir, null), 'main');
});

check('resolveRef: with none given and no candidate resolving, throws — never guesses', () => {
  const empty = buildFixture({ name: 'corpus-unborn', steps: [] }); // no commits: main is unborn
  assert.throws(() => resolveRef(empty.dir, null), /neither origin\/main nor main resolves/);
});

check('REPO_ROOT is this checkout, not the fixture', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'package.json')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'bin', 'b7e-count')));
});

/* ============================================================== bin/b7e-count (--dir) */

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

check('--help prints usage and exits 0 without touching any tree', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-count/);
});

check('no pattern given is refused with usage on stderr, not a silent zero', () => {
  const { status, stderr } = run(['--dir', fx.dir]);
  assert.equal(status, 2);
  assert.match(stderr, /at least one pattern/);
});

check('-w and --dir together are refused', () => {
  const { status, stderr } = run(['-w', 'whatever', '--dir', fx.dir, 'Athira']);
  assert.equal(status, 2);
  assert.match(stderr, /mutually exclusive/);
});

check('--dir Athira reproduces the lib/corpus.js count through the real CLI', () => {
  const { status, stdout } = run(['--dir', fx.dir, '--ref', 'main', 'Athira']);
  assert.equal(status, 0);
  assert.match(stdout, /Athira: 3 occurrences across 2 files/);
});

check('--per-file adds the file breakdown; without it, only the summary line prints', () => {
  const plain = run(['--dir', fx.dir, '--ref', 'main', 'Athira']);
  assert.doesNotMatch(plain.stdout, /a\.md/);
  const withFiles = run(['--dir', fx.dir, '--ref', 'main', '--per-file', 'Athira']);
  assert.match(withFiles.stdout, /2\s+a\.md/);
  assert.match(withFiles.stdout, /1\s+sub\/b\.md/);
});

check('--json prints one parseable object per pattern, in order', () => {
  const { status, stdout } = run(['--dir', fx.dir, '--ref', 'main', '--json', 'Athira', 'Arthir']);
  assert.equal(status, 0);
  const rows = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pattern, 'Athira');
  assert.equal(rows[0].occurrences, 3);
  assert.equal(rows[1].pattern, 'Arthir');
  assert.equal(rows[1].occurrences, 1);
});

check('multiple patterns in one call are independent, not ORed together', () => {
  const { stdout } = run(['--dir', fx.dir, '--ref', 'main', 'Athira', 'Arthir', 'NoSuchLiteralAnywhere']);
  assert.match(stdout, /Athira: 3 occurrences across 2 files/);
  assert.match(stdout, /Arthir: 1 occurrence across 1 file/);
  assert.match(stdout, /NoSuchLiteralAnywhere: 0 occurrences across 0 files/);
});

check('--regex is wired through to lib/corpus.js', () => {
  const { stdout } = run(['--dir', fx.dir, '--ref', 'main', '--regex', 'Ath[ei]ra']);
  assert.match(stdout, /3 occurrences across 2 files/);
});

check('a bad --ref is refused with a clear message and exit 2', () => {
  const { status, stderr } = run(['--dir', fx.dir, '--ref', 'not-a-real-ref', 'Athira']);
  assert.equal(status, 2);
  assert.match(stderr, /does not resolve to a tree/);
});

check('running the same call twice returns byte-identical stdout', () => {
  const a = run(['--dir', fx.dir, '--ref', 'main', '--json', '--per-file', 'Athira', 'Arthir']);
  const b = run(['--dir', fx.dir, '--ref', 'main', '--json', '--per-file', 'Athira', 'Arthir']);
  assert.equal(a.stdout, b.stdout);
});

/* ============================================================== bin/b7e-count (-w) */

// The acceptance criterion's own shape is `-w <workspace> --ref <ref> <literal>...`, so
// this proves that wiring specifically: a fabricated `~/.config/beadcause/config.json`
// naming a workspace whose `.beads` directory sits *inside* the fixture checkout — the
// "a tracker that lives inside the repo it tracks" branch `resolveSessionDir`
// (lib/session.js) already documents for `sophab`/`deluvia`/`ehatt`/`beadcause` — so no
// `cfg.projectRoot` and no real `~/beads` is needed to prove it resolves to the right
// directory.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ecount-ws-'));
  const configDir = path.join(tmp, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  // loadConfig drops any workspace whose `dir` does not exist on disk — it never has to
  // hold beads for this test, only exist, since `resolveSessionDir`'s single-repo branch
  // only ever reads its dirname.
  const wsBeadsDir = path.join(fx.dir, '.beads');
  fs.mkdirSync(wsBeadsDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        actor: 'beadcause-test',
        workspaces: [{ name: 'fixture-ws', dir: wsBeadsDir }],
      },
      null,
      2
    )
  );
  const WS_ENV = { HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir };

  check('-w resolves a workspace name to its checkout and counts there', () => {
    const { status, stdout } = run(['-w', 'fixture-ws', '--ref', 'main', 'Athira'], WS_ENV);
    assert.equal(status, 0, stdout);
    assert.match(stdout, new RegExp(`^# ${fx.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} @ main`, 'm'));
    assert.match(stdout, /Athira: 3 occurrences across 2 files/);
  });

  check('-w with an unknown workspace name is refused, listing the ones it does know', () => {
    const { status, stderr } = run(['-w', 'not-a-real-workspace', 'Athira'], WS_ENV);
    assert.equal(status, 2);
    assert.match(stderr, /no workspace named not-a-real-workspace/);
    assert.match(stderr, /fixture-ws/);
  });
}

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exitCode = failures ? 1 : 0;
