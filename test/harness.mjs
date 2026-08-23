#!/usr/bin/env node
/**
 * The house test harness, printed instead of copied off a neighbour — bc-zjab.11.
 *
 *     npm test
 *     node test/harness.mjs
 *
 * Six sessions wrote a suite in this repo and all six opened a different neighbouring suite
 * first, to copy its preamble. That is what `b7e-harness` replaces, and the only way it can
 * keep replacing it is by **computing** the shape from `test/` rather than holding a copy of
 * it: a template would be a second source of truth for something with four hundred
 * witnesses, and it would be wrong the first time the convention moved and right-looking for
 * months afterwards. So the two things this file has to hold down are:
 *
 * 1. **The output runs.** Not "parses" — runs, green, with zero assertions in it, for each of
 *    the four kinds. It is generated into a sandbox and executed here, because a skeleton
 *    whose first act is to make somebody debug it has cost more than it saved. This is the
 *    bead's acceptance, verbatim.
 * 2. **The output is the corpus's.** Every line emitted is looked for, byte for byte, in the
 *    real suites of that kind — and separately, the whole derivation is run against a small
 *    fabricated corpus that writes its preamble a different way, to show the answer follows
 *    the corpus rather than the corpus happening to agree with something hard-coded here.
 *
 * Then the app kind's extra, which is the expensive half and the reason the bead is
 * complexity:high: a function lifted out of `public/app.js` is listed in several suites at
 * once, and bc-bmry.4 found its three by watching 26 of 55 assertions fail. Those three are
 * named by id below, because "it names some suites" is not the promise.
 *
 * And the two scanner bugs that cost the most to find, pinned as regressions rather than
 * described: a `\x1b[32m` escape is an unmatched bracket inside a string, and `/[&<>"']/g`
 * holds a lone double quote inside a regex. Either one, uncounted, collapses a whole suite
 * into a single statement — silently, and in the direction that looks like agreement.
 *
 * No `bd`, no network, no daemon. Four `node` subprocesses over generated files in a
 * throwaway tree whose `lib/`, `public/` and `test/helpers/` are symlinks to this checkout.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(HERE, '..', 'lib', name);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-harness-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  KINDS,
  appCallers,
  appDeclarations,
  appSymbolReport,
  blankLiterals,
  classifySuite,
  deriveShape,
  harness,
  liftedNames,
  readSuites,
  roleOf,
  slotsOf,
  statements,
} = await import(LIB('harness.js'));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const throws = (name, fn, detail = '') => {
  try {
    fn();
    bad(name, detail || 'it returned instead of throwing');
  } catch {
    ok(name);
  }
};

const CLI = path.join(ROOT, 'bin', 'b7e-harness');
const SUITES = readSuites(ROOT);

/**
 * A tree a generated suite can actually run in: `test/` is real and writable, everything the
 * skeleton reaches sideways is a symlink back to this checkout.
 *
 * Not `test/` itself, deliberately. `scripts/test.mjs` discovers `test/*.mjs` by `readdir`
 * with no wiring and no exclusions, so a scratch suite written beside the real ones is one a
 * concurrent `npm test` would pick up and run — and a crash here would leave it there.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(tmp, 'tree-'));
  for (const link of ['lib', 'public', 'bin', 'scripts', 'node_modules', 'package.json']) {
    if (fs.existsSync(path.join(ROOT, link))) fs.symlinkSync(path.join(ROOT, link), path.join(dir, link));
  }
  fs.mkdirSync(path.join(dir, 'test'));
  fs.symlinkSync(path.join(ROOT, 'test', 'helpers'), path.join(dir, 'test', 'helpers'));
  return dir;
}

/* ---------------------------------------------------- the acceptance: it runs */

console.log('\nthe four kinds, generated and run');

// One `--for` per kind that a session would plausibly type, and one that exercises the app
// kind's symbol path rather than its file path.
const FOR = { lib: 'lib/prbase.js', app: 'p0RelayHtml', tick: 'lib/advocate.js', bin: 'bin/deliver.js' };

const tree = sandbox();
for (const kind of KINDS) {
  const answer = harness(ROOT, { kind, target: FOR[kind] });
  const file = path.join(tree, 'test', `${answer.stem}.mjs`);
  fs.writeFileSync(file, answer.text);

  let status = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 60_000 });
  } catch (err) {
    status = err.status ?? 'killed';
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  check(`--kind ${kind} runs green with nothing in it`, status === 0, `exit ${status}\n      ${out.split('\n').join('\n      ')}`);
  check(
    `--kind ${kind} counts zero, rather than passing because it asserted nothing it could fail`,
    /\b0\b/.test(out) || /all checks passed/.test(out),
    `it printed ${JSON.stringify(out.trim())}, which does not say how many checks ran`
  );
  check(
    `--kind ${kind} leaves the count and the exit code to the ending it was given`,
    answer.text.includes('process.exit(') || answer.text.includes('process.exit('),
    'no ending at all — a suite that cannot fail the runner is not a suite'
  );
}

check(
  'and the completion pass stays bounded — it repairs a shape, it does not assemble one',
  KINDS.every((kind) => harness(ROOT, { kind, target: FOR[kind] }).added.length <= 8),
  KINDS.map((kind) => `${kind}: ${harness(ROOT, { kind, target: FOR[kind] }).added.join(', ')}`).join('\n      ')
);

{
  // The specific repair it exists for, and where it has to put it. `check` delegates to
  // `ok`/`bad` in most of this repo and they are declared beside it, not up in the preamble
  // — a three-line helper split across two sections of the file is worse than no helper.
  const lib = harness(ROOT, { kind: 'lib', target: 'lib/prbase.js' });
  const usesOk = /\bok\(/.test(lib.text);
  const declaresOk = /^const ok = /m.test(lib.text);
  check('a helper the check helper calls is pulled in rather than left dangling', !usesOk || declaresOk, lib.added.join(', '));
  if (usesOk && declaresOk) {
    check(
      'and it lands with the harness, not in the preamble above it',
      lib.text.indexOf('let failures = 0;') < lib.text.indexOf('const ok = ('),
      'ok/bad ended up above the counters'
    );
  }
}

{
  // A scratch directory created and never removed is a suite that litters os.tmpdir() on
  // every run, and the two halves are two independent votes that can disagree.
  for (const kind of KINDS) {
    const shape = deriveShape(SUITES, kind);
    const makes = [...shape.preamble, ...shape.helpers].some((t) => /^const tmp = /.test(t));
    if (!makes) continue;
    check(
      `--kind ${kind} tears down the scratch directory it creates`,
      shape.ending.some((t) => /\btmp\b/.test(t)),
      shape.ending.join('\n      ')
    );
  }
}

/* ------------------------------------------ the acceptance: it is the corpus's */

console.log('\nevery line emitted is a line the corpus already writes');

// Two suites, not one, and the difference is the whole claim: a line only one file writes is
// that file's habit, and emitting it would be the copying this command exists to replace. The
// bar is deliberately low because the app kind is 17 suites, not 232 — the strong numbers are
// asserted separately, below, where they are actually available.
for (const kind of KINDS) {
  const shape = deriveShape(SUITES, kind);
  const own = SUITES.filter((s) => s.kind === kind);
  const lines = [...shape.imports, ...shape.preamble, ...shape.harness, ...shape.helpers, ...shape.ending];
  const tally = lines.map((line) => ({ line, n: own.filter((s) => s.source.includes(line.split('@@NAME@@').join(s.stem))).length }));
  check(
    `--kind ${kind}: all ${lines.length} derived lines are written by two or more ${kind} suites`,
    tally.every((e) => e.n >= 2),
    tally
      .filter((e) => e.n < 2)
      .map((e) => `${e.n}x  ${e.line.split('\n')[0]}`)
      .join('\n      ')
  );
  // And each is the *commonest* way this kind writes that role — recomputed here from the
  // sources rather than trusted, because "a line the corpus writes" and "the line the corpus
  // usually writes" are different claims and only the second one is the promise.
  const spellings = new Map();
  for (const s of own) {
    const sl = slotsOf(s.source, s.stem);
    for (const text of [...sl.imports, ...sl.preamble, ...sl.harness, ...sl.helpers, ...sl.ending]) {
      const role = roleOf(text);
      if (!spellings.has(role)) spellings.set(role, new Map());
      const per = spellings.get(role);
      per.set(text, (per.get(text) || 0) + 1);
    }
  }
  const beaten = lines.filter((line) => {
    const per = spellings.get(roleOf(line));
    const mine = per?.get(line) ?? 0;
    return [...(per?.values() ?? [])].some((v) => v > mine);
  });
  check(
    `--kind ${kind}: and each is the commonest spelling of its role, not merely one of them`,
    beaten.length === 0,
    beaten.map((l) => l.split('\n')[0]).join('\n      ')
  );
}

check(
  'the HERE line is the one 192 lib suites write, character for character',
  deriveShape(SUITES, 'lib').preamble.includes('const HERE = path.dirname(fileURLToPath(import.meta.url));'),
  deriveShape(SUITES, 'lib').preamble.join('\n      ')
);

check(
  'and the preamble is the whole of HERE/ROOT/LIB, not the two of them that clear a strict majority',
  ['HERE', 'ROOT', 'LIB'].every((n) => deriveShape(SUITES, 'lib').preamble.some((t) => t.startsWith(`const ${n} `))),
  deriveShape(SUITES, 'lib').preamble.map((t) => t.split('\n')[0]).join('\n      ')
);

{
  // The claim the whole design rests on, made falsifiable: a corpus that opens its suites a
  // different way gets a different answer. Nothing in lib/harness.js knows the word `BASE`.
  const other = path.join(tmp, 'other-repo');
  fs.mkdirSync(path.join(other, 'test'), { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    fs.writeFileSync(
      path.join(other, 'test', `made${i}.mjs`),
      [
        '/**',
        ' * A suite from another house entirely.',
        ' *',
        ` *     yarn verify test/made${i}.mjs`,
        ' */',
        "import assert from 'node:assert/strict';",
        '',
        "const BASE = new URL('..', import.meta.url).pathname;",
        '',
        'let failures = 0;',
        'const check = (name, cond) => {',
        '  if (!cond) failures += 1;',
        '};',
        '',
        `check('something', true);`,
        '',
        'process.exit(failures ? 1 : 0);',
        '',
      ].join('\n')
    );
  }
  const made = harness(other, { kind: 'lib', target: 'lib/whatever.js' });
  check(
    'point it at a corpus with another convention and the output follows that one',
    made.text.includes("const BASE = new URL('..', import.meta.url).pathname;"),
    made.text
  );
  check(
    "and nothing of this repo's own shape leaks into it",
    !made.text.includes('fileURLToPath') && !made.text.includes('beadcause-'),
    made.text
  );
  check(
    'including the run line, which is that corpus\'s command and not `npm test`',
    made.text.includes('yarn verify') && !made.text.includes('npm test'),
    made.text.split('\n').slice(0, 10).join('\n      ')
  );
}

check(
  'lib/harness.js holds no copy of the shape it prints',
  !fs
    .readFileSync(LIB('harness.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .includes('const HERE = path.dirname'),
  'the preamble is written down in the module, which is the second source of truth this exists to avoid'
);

/* ------------------------------------------------ what the app kind owes extra */

console.log('\nthe suites a new public/app.js function is about to break');

const relay = appSymbolReport(ROOT, 'p0RelayHtml', SUITES);

check('public/app.js is read and the symbol found', relay.known, 'p0RelayHtml is no longer declared in public/app.js');

for (const file of ['p0card.mjs', 'p0bead.mjs', 'p0start.mjs']) {
  check(
    `it names test/${file} — one of the three bc-bmry.4 found by watching 26 of 55 assertions fail`,
    relay.suites.some((s) => s.file === file),
    relay.suites.map((s) => s.file).join(', ') || 'it named nothing at all'
  );
}

check(
  'the answer is the direct callers, not the transitive closure',
  relay.callers.length <= 3 && relay.callers.includes('p0RowHtml'),
  `${relay.callers.length} callers: ${relay.callers.slice(0, 12).join(', ')}` +
    ' — walking the call graph up reaches almost every declaration in that file and names three quarters of the app suites'
);

check(
  'so the list stays the length of an edit rather than the length of the directory',
  relay.suites.length <= 8,
  relay.suites.map((s) => s.file).join(', ')
);

check(
  'a suite that already lifts it is still listed, and marked, so `owed` is the edit list',
  relay.suites.some((s) => s.already) && relay.owed.every((f) => !relay.suites.find((s) => s.file === f).already),
  relay.suites.map((s) => `${s.file}${s.already ? ' [already]' : ' [owed]'}`).join(', ')
);

check(
  'the lift opener it prints is the exact string those suites already pass',
  relay.openers.includes('function p0RowHtml(card, row)') &&
    fs.readFileSync(path.join(ROOT, 'test', 'p0card.mjs'), 'utf8').includes("lift(APP, 'function p0RowHtml(card, row)')"),
  relay.openers.join(' | ')
);

check(
  'and it reaches the generated file, where it will be read before the suite is written',
  ['p0card.mjs', 'p0bead.mjs', 'p0start.mjs'].every((f) => harness(ROOT, { kind: 'app', target: 'p0RelayHtml' }).text.includes(`test/${f}`)),
  harness(ROOT, { kind: 'app', target: 'p0RelayHtml' }).text.split('\n').slice(0, 40).join('\n      ')
);

{
  // Asked about a name public/app.js has never heard of, the honest answer is "nothing calls
  // it yet", not "no suites" — which would read as permission to write the suite and run it.
  const unknown = appSymbolReport(ROOT, 'p0NoSuchThingHtml', SUITES);
  check('a symbol the file does not declare is reported as unknown, not as clear', !unknown.known && unknown.suites.length === 0);
  check(
    'and the generated file says so rather than staying silent',
    harness(ROOT, { kind: 'app', target: 'p0NoSuchThingHtml' }).text.includes('does not declare'),
    harness(ROOT, { kind: 'app', target: 'p0NoSuchThingHtml' }).text.split('\n').slice(0, 30).join('\n      ')
  );
}

{
  const decls = appDeclarations(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
  check('public/app.js parses into hundreds of top-level declarations', decls.length > 200, `${decls.length}`);
  check('both shapes are found — the functions and the arrow consts', decls.some((d) => d.opener.startsWith('function ')) && decls.some((d) => d.opener.startsWith('const ')));
  check(
    'an arrow with no bracket keeps the space after its equals, which is what lift indexes on',
    decls.filter((d) => /^const [A-Z_]+ = $/.test(d.opener)).length > 0,
    decls.filter((d) => d.opener.startsWith('const ') && !d.opener.endsWith('(')).map((d) => JSON.stringify(d.opener)).slice(0, 5).join(', ')
  );
  check('a declaration is never its own caller', appCallers(decls, 'p0RowHtml').every((n) => n !== 'p0RowHtml'));
}

check(
  'a lift list is read back as the names it lifts',
  liftedNames(fs.readFileSync(path.join(ROOT, 'test', 'p0card.mjs'), 'utf8')).includes('p0RowHtml'),
  'test/p0card.mjs lifts p0RowHtml and this did not see it'
);

/* --------------------------------------------------- the two silent scanner bugs */

console.log('\nthe two ways a suite silently becomes one statement');

check(
  'a colour escape is an unmatched bracket inside a string, and is not counted',
  blankLiterals("console.log(`\\x1b[32m ok`);").split('[').length === 1,
  JSON.stringify(blankLiterals("console.log(`\\x1b[32m ok`);"))
);

check(
  'a regex holding a lone double quote does not open a string',
  blankLiterals(`const esc = (s) => s.replace(/[&<>"']/g, 'x');\nconst next = 1;`).includes('const next = 1;'),
  JSON.stringify(blankLiterals(`const esc = (s) => s.replace(/[&<>"']/g, 'x');\nconst next = 1;`))
);

check(
  'and a division is still a division',
  blankLiterals('const half = total / 2;\nconst next = 1;').includes('const half = total / 2;'),
  JSON.stringify(blankLiterals('const half = total / 2;\nconst next = 1;'))
);

check(
  'so a suite that prints in colour splits into its statements rather than one',
  statements(fs.readFileSync(path.join(ROOT, 'test', 'modelcard.mjs'), 'utf8')).length > 20,
  `${statements(fs.readFileSync(path.join(ROOT, 'test', 'modelcard.mjs'), 'utf8')).length} statements`
);

{
  // The corpus-wide version of the same claim: this is the number that went from 170 to 371
  // when the two bugs above were fixed, and it is what the whole vote is drawn from.
  const withEnding = SUITES.filter((s) => slotsOf(s.source, s.stem).ending.length).length;
  check(
    'and nine in ten suites hand the vote an ending, rather than collapsing before they reach it',
    withEnding > SUITES.length * 0.85,
    `${withEnding}/${SUITES.length}`
  );
}

check(
  'the ending stops at the checks — `await check(…)` and `await cleanupTmp(tmp)` are the same shape',
  slotsOf(fs.readFileSync(path.join(ROOT, 'test', 'plandispatch.mjs'), 'utf8'), 'plandispatch').ending.every((t) => !/^await check\(/.test(t)),
  slotsOf(fs.readFileSync(path.join(ROOT, 'test', 'plandispatch.mjs'), 'utf8'), 'plandispatch').ending.join('\n      ')
);

/* ------------------------------------------------------------- classification */

console.log('\nwhich kind a suite is');

const KIND_OF = {
  'plandispatch.mjs': 'tick',
  'modelcard.mjs': 'app',
  'p0card.mjs': 'app',
  'prbase.mjs': 'bin',
  'lockfile.mjs': 'lib',
};
for (const [file, want] of Object.entries(KIND_OF)) {
  const suite = SUITES.find((s) => s.file === file);
  check(`test/${file} is a ${want} suite`, suite && suite.kind === want, suite ? `it is ${suite.kind}` : 'no such suite');
}

check('every suite lands in one of the four kinds, so the corpus has no unclassified tail', SUITES.every((s) => KINDS.includes(s.kind)));

check(
  'a suite that merely reads public/app.js as text is not an app suite',
  classifySuite("const APP = read('public/app.js');\nassert.match(APP, /something/);") === 'lib',
  'widening the app test to the mention doubles the group with suites that share none of its shape'
);

check(
  'and every app suite is one that actually lifts',
  SUITES.filter((s) => s.kind === 'app').every((s) => liftedNames(s.source).length > 0),
  SUITES.filter((s) => s.kind === 'app' && !liftedNames(s.source).length).map((s) => s.file).join(', ')
);

check(
  'each kind has enough suites to vote on its own, so no kind falls back to the corpus',
  KINDS.every((kind) => deriveShape(SUITES, kind).basis === 'kind'),
  KINDS.map((kind) => `${kind}: ${deriveShape(SUITES, kind).basis}`).join(', ')
);

/* ------------------------------------------------------------------- the command */

console.log('\nb7e-harness itself');

// `spawnSync`, not `execFileSync`, because half of what is being asserted here is on
// stderr — `execFileSync` returns stdout alone and hands back stderr only when the command
// fails, which is exactly when this command has nothing interesting to say.
const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
};

{
  const r = run(['--kinds']);
  check('--kinds runs and names all four', r.status === 0 && KINDS.every((k) => r.out.includes(k)), `exit ${r.status}\n      ${r.out}`);
}

{
  const r = run(['--kind', 'lib', '--for', 'lib/prbase.js']);
  check('the skeleton goes to stdout, so `> test/x.mjs` is the whole workflow', r.status === 0 && r.out.startsWith('#!/usr/bin/env node'), r.out.slice(0, 200));
  check('and nothing but the skeleton does', r.out.trimEnd().endsWith('process.exit(failures ? 1 : 0);'), r.out.slice(-200));
}

{
  const r = run(['--kind', 'app', '--for', 'p0RelayHtml']);
  check(
    'the app kind says on stderr which suites are owed a lift, where it cannot be missed',
    r.status === 0 && /p0start\.mjs/.test(String(r.err ?? '')),
    `stderr: ${r.err}`
  );
}

check('an unknown kind is refused rather than guessed at', run(['--kind', 'nonesuch']).status === 2);
check('a tree with no test/ is refused with its own code', run(['--dir', path.join(tmp, 'empty')]).status === 4);
check('--kind and --like together are refused', run(['--kind', 'lib', '--like', 'test/prbase.mjs']).status === 2);
check('--like naming a suite that is not there is refused', run(['--like', 'test/nosuchsuite.mjs']).status === 4);

{
  const r = run(['--kind', 'lib', '--for', 'lib/prbase.js', '--json']);
  const parsed = r.status === 0 ? JSON.parse(r.out) : null;
  check('--json carries the text and what it took to get there', Boolean(parsed?.text && Array.isArray(parsed.completed)), r.out.slice(0, 200));
  check('--name overrides the stem the target implies', run(['--kind', 'lib', '--for', 'lib/prbase.js', '--name', 'chosen']).out.includes('node test/chosen.mjs'));
}

throws('harness() refuses a kind it does not have', () => harness(ROOT, { kind: 'nonesuch' }));
throws('and a --like that names nothing', () => harness(ROOT, { like: 'test/nosuchsuite.mjs' }));

{
  const like = harness(ROOT, { like: 'test/plandispatch.mjs', target: 'lib/beadfiles.js' });
  check('--like copies one suite slot by slot rather than voting', like.shape.basis === 'like' && like.shape.like === 'plandispatch.mjs');
  check(
    'and it is that suite, not the majority — its own ending, its own check helper',
    like.text.includes('async function check(name, fn) {') && like.text.includes('await quiesce();'),
    like.text.slice(-400)
  );
}

/* --------------------------------------------------------------------- done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
