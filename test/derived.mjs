#!/usr/bin/env node
//
// b7e-derived — given a diff, name what in the tree is generated from it, and whether
// that generated file is now stale (bc-dgx7.1's session audit, moved to this tracker as
// bc-dgx7.124).
//
//   npm test
//   node test/derived.mjs
//
// lib/derived.js does the matching, the manifest reading and the running; this drives it
// against fabricated trees carrying a fake `.beadcause/derived.json`, a fake banner and a
// fake generator, so the suite does not depend on deluvia's contents — the acceptance
// criteria's own words. The three fixture generators mirror deluvia's real three
// (compendium/build.py, scripts/build_series_log.py, design/characters/build_prompts.py)
// closely enough that a change to the matching rules here is provably the same change
// deluvia would see, without this suite ever reading deluvia's checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-derived');

const derived = await import(path.join(ROOT, 'lib', 'derived.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-derived-test-'));

/** A fresh `<tmp>/<name>/` tree holding the given files at the given repo-relative paths. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
};

const MANIFEST_PATH = path.join('.beadcause', 'derived.json');

/**
 * The three generators the bead's own acceptance criteria names, restated as a fixture —
 * `run`/`check` are `true`/`false` rather than real Python, because what is under test is
 * the matching and the plumbing around exit codes, not deluvia's scripts.
 */
const DELUVIA_LIKE_GENERATORS = {
  generators: [
    {
      id: 'compendium/build.py',
      run: ['true'],
      check: ['false'], // always "stale", so the CLI's stale-reporting path gets exercised
      sources: ['compendium/**'],
      artifacts: [
        'compendium/web/data.js',
        'reference/maps/private/compendium.admin.js',
        'reference/maps/private/compendium.reader.js',
      ],
    },
    {
      id: 'scripts/build_series_log.py',
      run: ['true'],
      check: ['true'], // always "clean"
      sources: ['novel/**/CHAPTER_*.md'],
      artifacts: ['novel/SERIES_CHAPTER_LOG.md'],
    },
    {
      id: 'design/characters/build_prompts.py',
      sources: ['design/characters/*.sheet.md'],
      artifacts: ['design/characters/prompts/'],
    },
  ],
};

/* ===================================================================== *
 * 1. globToRegExp / matchesSource — the three glob shapes the acceptance
 *    criteria names
 * ===================================================================== */

console.log('\nglob matching\n');

check('a trailing ** matches anything under the prefix, any depth', () => {
  const re = derived.globToRegExp('compendium/**');
  assert.ok(re.test('compendium/species/alban-orves.md'));
  assert.ok(re.test('compendium/build.py'));
  assert.ok(!re.test('novel/CHAPTER_1.md'));
});

check('**/ crosses zero or more path segments', () => {
  const re = derived.globToRegExp('novel/**/CHAPTER_*.md');
  assert.ok(re.test('novel/Deluvia Book 3/CHAPTER_12.md'), 'one directory deep');
  assert.ok(re.test('novel/CHAPTER_1.md'), 'zero directories deep');
  assert.ok(re.test('novel/Deluvia Book 3/notes/CHAPTER_1.md'), '** crosses more than one segment too');
});

check('a lone * stops at a slash', () => {
  const re = derived.globToRegExp('design/characters/*.sheet.md');
  assert.ok(re.test('design/characters/elyra.sheet.md'));
  assert.ok(!re.test('design/characters/sub/elyra.sheet.md'), 'a single * must not cross a directory boundary');
});

check('matchesSource checks every source glob on a generator', () => {
  const g = { sources: ['a/*.md', 'b/**'] };
  assert.ok(derived.matchesSource(g, 'a/x.md'));
  assert.ok(derived.matchesSource(g, 'b/y/z.js'));
  assert.ok(!derived.matchesSource(g, 'c/x.md'));
});

/* ===================================================================== *
 * 2. loadManifest — present, absent, malformed, partially malformed
 * ===================================================================== */

console.log('\nloadManifest\n');

check('no .beadcause/derived.json at all is empty generators, no problems', () => {
  const dir = tree('no-manifest', { 'README.md': 'hi\n' });
  const { generators, problems } = derived.loadManifest(dir);
  assert.deepEqual(generators, []);
  assert.deepEqual(problems, []);
});

check('a well-formed manifest round-trips exactly', () => {
  const dir = tree('good-manifest', { [MANIFEST_PATH]: JSON.stringify(DELUVIA_LIKE_GENERATORS) });
  const { generators, problems } = derived.loadManifest(dir);
  assert.deepEqual(problems, []);
  assert.equal(generators.length, 3);
  assert.equal(generators[0].id, 'compendium/build.py');
  assert.deepEqual(generators[0].run, ['true']);
  assert.deepEqual(generators[0].check, ['false']);
  assert.equal(generators[2].run, null, 'a generator with no run command in the manifest gets null, not []');
});

check('unparseable JSON is a problem, not a silent empty list', () => {
  const dir = tree('bad-json', { [MANIFEST_PATH]: '{ not json' });
  const { generators, problems } = derived.loadManifest(dir);
  assert.deepEqual(generators, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not parse as JSON/);
});

check('one malformed generator entry is dropped and reported; the rest still load', () => {
  const dir = tree('one-bad-entry', {
    [MANIFEST_PATH]: JSON.stringify({
      generators: [
        { id: 'ok/gen.py', sources: ['ok/**'], artifacts: ['ok/out.js'] },
        { sources: ['no-id/**'], artifacts: ['x.js'] }, // no id
        { id: 'no-sources/gen.py', artifacts: ['y.js'] }, // no sources
        { id: 'no-artifacts/gen.py', sources: ['z/**'] }, // no artifacts
      ],
    }),
  });
  const { generators, problems } = derived.loadManifest(dir);
  assert.equal(generators.length, 1);
  assert.equal(generators[0].id, 'ok/gen.py');
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => /has no id/.test(p)));
  assert.ok(problems.some((p) => /no-sources\/gen\.py\) names no sources/.test(p)));
  assert.ok(problems.some((p) => /no-artifacts\/gen\.py\) names no artifacts/.test(p)));
});

/* ===================================================================== *
 * 3. findDerived — matched, unmatched, multiple artifacts, dedup
 * ===================================================================== */

console.log('\nfindDerived\n');

{
  const { generators } = DELUVIA_LIKE_GENERATORS;

  check('a source file reports every artifact its generator declares', () => {
    const { results, unmatched } = derived.findDerived(['compendium/species/alban-orves.md'], generators);
    assert.deepEqual(unmatched, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].generators.length, 1);
    assert.deepEqual(results[0].generators[0].artifacts, [
      'compendium/web/data.js',
      'reference/maps/private/compendium.admin.js',
      'reference/maps/private/compendium.reader.js',
    ]);
  });

  check('a chapter file reports SERIES_CHAPTER_LOG.md via build_series_log.py', () => {
    const { results } = derived.findDerived(['novel/Deluvia Book 3/CHAPTER_12.md'], generators);
    assert.equal(results.length, 1);
    assert.equal(results[0].generators[0].id, 'scripts/build_series_log.py');
    assert.deepEqual(results[0].generators[0].artifacts, ['novel/SERIES_CHAPTER_LOG.md']);
  });

  check('a character sheet reports the prompts directory', () => {
    const { results } = derived.findDerived(['design/characters/elyra.sheet.md'], generators);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].generators[0].artifacts, ['design/characters/prompts/']);
  });

  check('a file with no generator is reported unmatched, never silently dropped', () => {
    const { results, unmatched } = derived.findDerived(['README.md'], generators);
    assert.deepEqual(results, []);
    assert.deepEqual(unmatched, ['README.md']);
  });

  check('a mix of matched and unmatched files: each accounted for exactly once', () => {
    const { results, unmatched } = derived.findDerived(['compendium/species/alban-orves.md', 'README.md'], generators);
    assert.equal(results.length, 1);
    assert.deepEqual(unmatched, ['README.md']);
  });

  check('the touched-generators summary is deduplicated, first-seen order', () => {
    const { generators: touched } = derived.findDerived(
      ['compendium/a.md', 'compendium/b.md', 'novel/CHAPTER_1.md'],
      generators,
    );
    assert.deepEqual(
      touched.map((g) => g.id),
      ['compendium/build.py', 'scripts/build_series_log.py'],
    );
  });
}

/* ===================================================================== *
 * 4. runCheck / runRebuild — exit codes, declared vs. undeclared commands
 * ===================================================================== */

console.log('\nrunCheck / runRebuild\n');

{
  const dir = tree('run-check', { '.keep': '' });
  const clean = { id: 'clean-gen', check: ['true'], run: ['true'] };
  const stale = { id: 'stale-gen', check: ['false'], run: null };
  const undeclared = { id: 'undeclared-gen', check: null, run: null };

  check('an exit-0 check is clean', () => {
    assert.equal(derived.runCheck(dir, clean).status, 'clean');
  });
  check('a nonzero-exit check is stale', () => {
    assert.equal(derived.runCheck(dir, stale).status, 'stale');
  });
  check('no declared check command is its own status, not "clean"', () => {
    assert.equal(derived.runCheck(dir, undeclared).status, 'no-check');
  });
  check('an exit-0 run is "ran"', () => {
    assert.equal(derived.runRebuild(dir, clean).status, 'ran');
  });
  check('no declared run command is its own status', () => {
    assert.equal(derived.runRebuild(dir, undeclared).status, 'no-run');
  });
}

/* ===================================================================== *
 * 5. the CLI — argv, exit codes, --check / --rebuild
 * ===================================================================== */

console.log('\nthe CLI\n');

{
  const dir = tree('cli', { [MANIFEST_PATH]: JSON.stringify(DELUVIA_LIKE_GENERATORS) });

  check('a matched source file prints its artifacts and exits 0', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'compendium/species/alban-orves.md'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 3, 'one line per artifact, three artifacts declared');
    assert.ok(lines[0].startsWith('compendium/web/data.js\t'));
  });

  check('a file with no generator: reported on stderr, exit 1', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'README.md'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /README\.md/);
  });

  check('--check runs each generator\'s own check and reports stale exactly when it exits nonzero', () => {
    const run = spawnSync(
      process.execPath,
      [BIN, '--dir', dir, '--check', 'compendium/species/alban-orves.md', 'novel/CHAPTER_1.md'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 1, 'compendium/build.py\'s check always fails in this fixture');
    assert.match(run.stdout, /compendium\/web\/data\.js.*stale/);
    assert.match(run.stdout, /novel\/SERIES_CHAPTER_LOG\.md.*clean/);
  });

  check('--check on only the clean generator exits 0', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--check', 'novel/CHAPTER_1.md'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /clean/);
  });

  check('--rebuild runs the declared run command and reports a generator with none', () => {
    const run = spawnSync(
      process.execPath,
      [BIN, '--dir', dir, '--rebuild', 'design/characters/elyra.sheet.md'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0);
    assert.match(run.stdout, /no run command declared/);
  });

  check('--check and --rebuild together are refused with exit 2', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--check', '--rebuild'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });

  check('neither -w nor --dir is refused with exit 2', () => {
    const run = spawnSync(process.execPath, [BIN, 'compendium/x.md'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });

  check('an unrecognised flag is refused with exit 2', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--nope'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });

  check('an unknown -w workspace is refused with exit 2', () => {
    const run = spawnSync(process.execPath, [BIN, '-w', 'no-such-workspace-b7ederived-test'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no workspace named/);
  });

  check('a checkout with no manifest at all reports so and exits 0', () => {
    const empty = tree('cli-no-manifest', { 'README.md': 'hi\n' });
    const run = spawnSync(process.execPath, [BIN, '--dir', empty, 'README.md'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stderr, /no generators declared/);
  });

  check('a manifest that does not parse is refused with exit 2', () => {
    const broken = tree('cli-broken-manifest', { [MANIFEST_PATH]: '{ nope' });
    const run = spawnSync(process.execPath, [BIN, '--dir', broken, 'README.md'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /does not parse as JSON/);
  });
}

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall derived checks passed\n');
process.exit(failures ? 1 : 0);
