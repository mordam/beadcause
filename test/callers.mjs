#!/usr/bin/env node
//
// b7e-callers — who calls this, who imports it, and is anything wired to it at all (bc-36xx.24).
//
//   npm test
//   node test/callers.mjs
//
// lib/callers.js does the matching; this drives it against fabricated trees first (the
// same tree/tmp-dir shape test/affected.mjs uses), then against this repo's own five
// acceptance cases at the end, because those are what bc-36xx.24 is actually about.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-callers');

const callers = await import(path.join(ROOT, 'lib', 'callers.js'));

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-callers-test-'));

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

/* ===================================================================== *
 * 1. blankNonCode — comments, strings, template literals
 * ===================================================================== */

console.log('\nblankNonCode\n');

check('a // line comment is blanked, the newline survives', () => {
  const src = "const a = 1; // hello world\nconst b = 2;\n";
  const out = callers.blankNonCode(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(!/hello/.test(out));
  assert.ok(/const a = 1;/.test(out));
  assert.ok(/const b = 2;/.test(out));
});

check('a /* */ block comment spanning several lines keeps every line number', () => {
  const src = "const a = 1;\n/**\n * one\n * two\n */\nconst b = 2;\n";
  const out = callers.blankNonCode(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(!/one|two/.test(out));
  const line6 = out.split('\n')[5];
  assert.match(line6, /const b = 2;/);
});

check('a quoted string is blanked, its content included', () => {
  const out = callers.blankNonCode("const s = 'approvedReview lives here';\n");
  assert.ok(!/approvedReview/.test(out));
  assert.ok(/const s =/.test(out));
});

check('a double-quote inside a single-quoted string does not end it early', () => {
  const out = callers.blankNonCode(`const s = '<script src="/panes.js">';\nconst t = mark();\n`);
  assert.ok(/const t = mark\(\);/.test(out), 'code after the string must still read as code');
});

check('a template literal with a nested backtick inside ${…} does not desync the rest of the file', () => {
  // The exact shape that broke a naive hand-rolled scanner on test/panes.mjs: a
  // backtick string containing a double quote, immediately followed by more code.
  const src =
    "const at = (f) => HTML.indexOf(`<script src=\"/${f}\">`);\n" +
    "const call = mark('bead');\n";
  const out = callers.blankNonCode(src);
  assert.ok(/const call = mark\(/.test(out), `code after the template must still read as code:\n${out}`);
});

check('a call site inside a ${…} interpolation is still visible as code', () => {
  const out = callers.blankNonCode('const s = `value: ${approvedReview(x)}`;\n');
  assert.ok(/approvedReview\(x\)/.test(out), 'the interpolated call must not be blanked');
});

check('a regex literal is left as code, not blanked like a string', () => {
  const out = callers.blankNonCode("const re = /approvedReview/;\n");
  assert.ok(/approvedReview/.test(out));
});

/* ===================================================================== *
 * 2. definitionsFor — including the call/definition ambiguity
 * ===================================================================== */

console.log('\ndefinitionsFor\n');

check('an exported function is found', () => {
  const defs = callers.definitionsFor('foo', 'lib/a.js', 'export function foo(x) {\n  return x;\n}\n');
  assert.equal(defs.length, 1);
  assert.equal(defs[0].label, 'export function');
  assert.equal(defs[0].startLine, 1);
});

check('a method-shorthand definition is found', () => {
  const defs = callers.definitionsFor('mark', 'a.js', 'const views = {\n  mark(id) {\n    return id;\n  },\n};\n');
  assert.equal(defs.length, 1);
  assert.equal(defs[0].label, 'method');
  assert.equal(defs[0].startLine, 2);
});

check('a call passing an object literal argument is NOT a phantom method definition', () => {
  // The exact bc-36xx.24 regression: `openReviewAnswerSession(cfg, ws, …, {` looks,
  // read one line at a time, exactly like a method-shorthand head — and used to be
  // misread as one whose "body" was some unrelated brace several arguments later.
  const src =
    "async function caller() {\n" +
    "  const outcome = await resolveFor(\n" +
    "    key,\n" +
    "    number,\n" +
    "    () =>\n" +
    "      openReviewAnswerSession(cfg, ws, issue, spec, review, {\n" +
    "        dir,\n" +
    "        reason: 'x',\n" +
    "      }),\n" +
    "    { branch: spec.branch, owner: ownerName(cfg) }\n" +
    "  );\n" +
    "}\n";
  const defs = callers.definitionsFor('openReviewAnswerSession', 'lib/server.js', src);
  assert.deepEqual(defs, [], `expected no definitions, got ${JSON.stringify(defs)}`);
});

check('a call immediately followed by its own callback body ({ on the SAME closing paren) is still not a definition', () => {
  const src = "doThing(x, {\n  y: 1,\n});\n";
  const defs = callers.definitionsFor('doThing', 'a.js', src);
  assert.deepEqual(defs, []);
});

check('a real method definition still verifies against the stricter body check', () => {
  const src = "class C {\n  async run(a, b) {\n    return a + b;\n  }\n}\n";
  const defs = callers.definitionsFor('run', 'a.js', src);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].label, 'method');
});

check('a quote inside a regex literal does not run the body to the end of the file', () => {
  // The bc-36xx.24 round-1 regression, reduced from lib/beadfiles.js:130. The body walk is
  // a hand-rolled scanner, so the `"` in the regex used to open a string that closed at the
  // NEXT quote — three lines down, inside an unrelated string — leaving endLine pointing at
  // the end of the file and findCallers skipping every real call site in between.
  const src =
    "function normalize(raw) {\n" +
    "  return raw.replace(/^[\"']|[\"']$/g, '');\n" +
    "}\n" +
    "\n" +
    "function other() {\n" +
    "  return normalize('x');\n" +
    "}\n";
  const defs = callers.definitionsFor('normalize', 'lib/a.js', src);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].startLine, 1);
  assert.equal(defs[0].endLine, 3, `body ran to line ${defs[0].endLine}, swallowing the caller below it`);
});

check('a { } quantifier inside a regex literal does not unbalance the brace count', () => {
  const src = "function pad(s) {\n  return s.replace(/\\d{2,3}/g, '');\n}\n";
  const defs = callers.definitionsFor('pad', 'lib/a.js', src);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].endLine, 3);
});

check('blankForBraceWalk leaves the walk nothing but code punctuation, at the same offsets', () => {
  const src = 'const re = /a"b/;\nconst s = "keep";\nconst t = `x${ f({ y: 1 }) }z`;\n// note\n';
  const out = callers.blankForBraceWalk(src);
  assert.equal(out.length, src.length, 'must stay the same length or line numbers lie');
  assert.equal(out.split('\n').length, src.split('\n').length, 'every newline stays put');
  for (const gone of ['"', '`', '/a', 'keep', 'note', 'x$', 'z']) {
    assert.ok(!out.includes(gone), `${JSON.stringify(gone)} should be blanked`);
  }
  assert.ok(out.includes('f({ y: 1 })'), 'a ${…} expression is real code and stays');
  assert.equal(out.indexOf('f({'), src.indexOf('f({'), 'and stays at the same offset');
});

check('blankForBraceWalk survives a nested template with escaped backticks', () => {
  // The residual desync after the regex fix alone: `\`${x}\`` inside a template. 27 such
  // spans were still disagreeing with acorn until the whole non-code range was blanked.
  const src = 'function show(v) {\n  return `\\`${v}\\``;\n}\n\nfunction other() {\n  return show(1);\n}\n';
  const defs = callers.definitionsFor('show', 'lib/a.js', src);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].endLine, 3, `body ran to line ${defs[0].endLine}, swallowing the caller below it`);
});

check('blankForBraceWalk hands back unparseable text unchanged', () => {
  const src = 'function ( { this is not javascript\n';
  assert.equal(callers.blankForBraceWalk(src), src);
});

/* ===================================================================== *
 * 3. occurrencesFor — call / reference / import / comment classification
 * ===================================================================== */

console.log('\noccurrencesFor\n');

check('a call is classified "call"', () => {
  const occ = callers.occurrencesFor(tree('occ-call', { 'lib/a.js': 'foo(1, 2);\n' }), ['lib/a.js'], { name: 'foo' });
  assert.deepEqual(occ.map((o) => o.kind), ['call']);
});

check('an optional call (?.() ) is also classified "call"', () => {
  const occ = callers.occurrencesFor(tree('occ-optcall', { 'lib/a.js': 'x.foo?.(1);\n' }), ['lib/a.js'], { name: 'foo' });
  assert.deepEqual(occ.map((o) => o.kind), ['call']);
});

check('a dotted target is found through a chain wrapped across lines', () => {
  // 164 files here wrap a chain. A newline used to end the chain window outright, so
  // `views.mark` matched the single-line call at public/inboxfilter.js and nothing else —
  // the same silent miss as a regex-desynced body, one line-break wide.
  const occ = callers.occurrencesFor(
    tree('occ-wrapchain', { 'lib/a.js': 'window.beadcause\n  ?.views\n  ?.mark?.(id);\n' }),
    ['lib/a.js'],
    { name: 'mark', parentSegment: 'views' },
  );
  assert.deepEqual(occ.map((o) => o.kind), ['call']);
});

check('a chain wrapped with the dot trailing the previous line is found too', () => {
  const occ = callers.occurrencesFor(
    tree('occ-trailingdot', { 'lib/a.js': 'window.views.\n  mark(id);\n' }),
    ['lib/a.js'],
    { name: 'mark', parentSegment: 'views' },
  );
  assert.deepEqual(occ.map((o) => o.kind), ['call']);
});

check('a semicolon-less statement break is still a boundary, not a chain', () => {
  // The reason `\n` was a boundary in the first place: JavaScript needs no semicolon, so
  // `const a = foo` / `views2.mark(id)` are two statements and `views` must NOT match here.
  const occ = callers.occurrencesFor(
    tree('occ-asi', { 'lib/a.js': 'const a = views\nmark(id);\n' }),
    ['lib/a.js'],
    { name: 'mark', parentSegment: 'views' },
  );
  assert.deepEqual(occ, []);
});

check('a static import binding is classified "import"', () => {
  const occ = callers.occurrencesFor(
    tree('occ-import', { 'lib/a.js': "import { foo } from './b.js';\n" }),
    ['lib/a.js'],
    { name: 'foo' },
  );
  assert.deepEqual(occ.map((o) => o.kind), ['import']);
});

check('this repo\'s multi-line `{ … } = await import(…)` convention is also classified "import"', () => {
  const occ = callers.occurrencesFor(
    tree('occ-dynimport', {
      'test/x.mjs': "const {\n  bar,\n  foo,\n} = await import(LIB('a.js'));\n",
    }),
    ['test/x.mjs'],
    { name: 'foo' },
  );
  assert.deepEqual(occ.map((o) => o.kind), ['import']);
});

check('a comment mention is classified "comment"', () => {
  const occ = callers.occurrencesFor(
    tree('occ-comment', { 'lib/a.js': '// foo does the thing\nconst x = 1;\n' }),
    ['lib/a.js'],
    { name: 'foo' },
  );
  assert.deepEqual(occ.map((o) => o.kind), ['comment']);
});

check('a bare reference (passed as a value, never called) is classified "reference"', () => {
  const occ = callers.occurrencesFor(
    tree('occ-ref', { 'lib/a.js': 'const handlers = [foo];\n' }),
    ['lib/a.js'],
    { name: 'foo' },
  );
  assert.deepEqual(occ.map((o) => o.kind), ['reference']);
});

check('a dotted target only matches occurrences whose immediate parent chain matches', () => {
  const dir = tree('occ-dotted', {
    'a.js': "window.beadcause.views.mark('x');\nsomeOtherThing.mark('y');\nconst m = mark('z');\n",
  });
  const occ = callers.occurrencesFor(dir, ['a.js'], { name: 'mark', parentSegment: 'views' });
  assert.equal(occ.length, 1, `expected exactly one match, got ${JSON.stringify(occ)}`);
  assert.equal(occ[0].text, "window.beadcause.views.mark('x');");
});

check('a dotted target tolerates optional chaining anywhere in the preceding chain', () => {
  const dir = tree('occ-optchain', { 'a.js': "window.beadcause?.views?.mark?.(current());\n" });
  const occ = callers.occurrencesFor(dir, ['a.js'], { name: 'mark', parentSegment: 'views' });
  assert.equal(occ.length, 1);
  assert.equal(occ[0].kind, 'call');
});

/* ===================================================================== *
 * 4. verdictFor
 * ===================================================================== */

console.log('\nverdictFor\n');

check('a real call outside the definition\'s own file is "wired (N call sites)"', () => {
  const v = callers.verdictFor(new Set(['lib/a.js']), [{ file: 'lib/b.js', line: 1, kind: 'call' }]);
  assert.equal(v, 'wired (1 call site)');
});

check('a call only inside the definition\'s own file is "no caller outside its own file"', () => {
  const v = callers.verdictFor(new Set(['lib/a.js']), [{ file: 'lib/a.js', line: 9, kind: 'call' }]);
  assert.equal(v, 'no caller outside its own file');
});

check('no call anywhere, but a comment names it, is "mentioned only in comments"', () => {
  const v = callers.verdictFor(new Set(['lib/a.js']), [{ file: 'lib/b.js', line: 1, kind: 'comment' }]);
  assert.equal(v, 'mentioned only in comments');
});

check('a bare reference with no call and no comment is "referenced, but never called"', () => {
  const v = callers.verdictFor(new Set(['lib/a.js']), [{ file: 'lib/b.js', line: 1, kind: 'reference' }]);
  assert.equal(v, 'referenced, but never called');
});

check('nothing at all is "no reference found anywhere searched" — never a shrug', () => {
  const v = callers.verdictFor(new Set(['lib/a.js']), []);
  assert.equal(v, 'no reference found anywhere searched');
});

/* ===================================================================== *
 * 5. parseTarget
 * ===================================================================== */

console.log('\nparseTarget\n');

check('a bare name is "plain"', () => {
  assert.deepEqual(callers.parseTarget(ROOT, 'approvedReview').kind, 'plain');
});

check('module#export is "qualified"', () => {
  const t = callers.parseTarget(ROOT, 'lib/pr.js#approve');
  assert.equal(t.kind, 'qualified');
  assert.equal(t.module, 'lib/pr.js');
  assert.equal(t.name, 'approve');
});

check('a.b is "dotted", disambiguated by the immediate parent', () => {
  const t = callers.parseTarget(ROOT, 'views.mark');
  assert.equal(t.kind, 'dotted');
  assert.equal(t.name, 'mark');
  assert.equal(t.parentSegment, 'views');
});

check('a real, existing module path is "module"', () => {
  const t = callers.parseTarget(ROOT, 'lib/session.js');
  assert.equal(t.kind, 'module');
  assert.equal(t.module, 'lib/session.js');
});

check('a dotted-looking name that is not actually a file falls back to "dotted", not "module"', () => {
  const t = callers.parseTarget(ROOT, 'views.mark');
  assert.notEqual(t.kind, 'module');
});

/* ===================================================================== *
 * 6. moduleReport — imports, importedBy, cycle risk
 * ===================================================================== */

console.log('\nmoduleReport\n');

{
  const dir = tree('module-graph', {
    'lib/a.js': "import { b } from './b.js';\nexport const A = 1;\n",
    'lib/b.js': "export const B = 1;\n",
    'lib/c.js': "import { a } from './a.js';\nexport const C = 1;\n",
    'lib/d.js': "export const D = 1;\n",
  });

  check('imports and importedBy are direct edges', () => {
    const r = callers.moduleReport(dir, 'lib/a.js');
    assert.deepEqual(r.imports, ['lib/b.js']);
    assert.deepEqual(r.importedBy, ['lib/c.js']);
  });

  check('a file that already transitively imports the target would close a cycle if the target imported it back', () => {
    const r = callers.moduleReport(dir, 'lib/b.js');
    // lib/a.js -> lib/b.js already; lib/c.js -> lib/a.js -> lib/b.js transitively.
    assert.ok(r.wouldCloseCycleIfImported.includes('lib/a.js'));
    assert.ok(r.wouldCloseCycleIfImported.includes('lib/c.js'));
    assert.ok(!r.wouldCloseCycleIfImported.includes('lib/d.js'), 'an unrelated file is not a cycle risk');
  });

  check('a file already directly imported is not counted as a NEW cycle-closing edge', () => {
    const r = callers.moduleReport(dir, 'lib/a.js');
    assert.ok(!r.wouldCloseCycleIfImported.includes('lib/b.js'), 'already-imported files are not "new edge" candidates');
  });

  check('an unknown module path is reported as an error, not thrown', () => {
    const r = callers.moduleReport(dir, 'lib/nope.js');
    assert.ok(r.error);
  });
}

/* ===================================================================== *
 * 7. findCallers — end to end over a fabricated tree
 * ===================================================================== */

console.log('\nfindCallers end to end\n');

{
  const dir = tree('find-callers', {
    'lib/reviewadvocate.js':
      "export function approvedReview(state) {\n  return state;\n}\n\n" +
      "// elsewhere in the same file, well outside the definition's own doc comment:\n" +
      "// approvedReview is what the merge-bead records once a review lands.\n" +
      "function other() {}\n",
    'test/reviewadvocate.mjs': "const { approvedReview } = await import(LIB('reviewadvocate.js'));\napprovedReview({});\n",
  });

  check('test/ is excluded by default — a symbol only called from test/ reads as comment-only', () => {
    const r = callers.findCallers(dir, 'approvedReview', {});
    assert.equal(r.verdict, 'mentioned only in comments');
  });

  check('--tests includes test/, and the real call there is found', () => {
    const r = callers.findCallers(dir, 'approvedReview', { tests: true });
    assert.equal(r.verdict, 'wired (1 call site)');
    assert.ok(r.occurrences.some((o) => o.file === 'test/reviewadvocate.mjs' && o.kind === 'call'));
  });
}

/* ===================================================================== *
 * 8. bin/b7e-callers over the CLI — argv, --json, exit codes
 * ===================================================================== */

console.log('\nCLI\n');

{
  const dir = tree('cli', {
    'lib/a.js': "export function foo() {\n  return 1;\n}\n",
    'lib/b.js': "import { foo } from './a.js';\nfoo();\n",
  });

  check('a bare symbol prints a verdict and exits 0', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'foo'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /wired \(1 call site\)/);
  });

  check('--json prints one parseable object', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'foo', '--json'], { encoding: 'utf8' });
    const rec = JSON.parse(run.stdout);
    assert.equal(rec.verdict, 'wired (1 call site)');
    assert.equal(rec.definitions.length, 1);
  });

  check('a symbol with no definition anywhere exits 1', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'thisNameDoesNotExist'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
  });

  check('an unrecognised flag is refused with exit 2', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'foo', '--nope'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });

  check('missing target is refused with exit 2', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });

  check('--imports on a real module path prints the graph report', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'lib/a.js', '--imports'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /imported by \(1 direct\): lib\/b\.js/);
  });

  check('--imports on a target that is not a module path is refused with exit 2', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'foo', '--imports'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });

  check('a bare module path (no --imports flag) is understood as the module question too', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'lib/a.js'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /imported by \(1 direct\): lib\/b\.js/);
  });
}

/* ===================================================================== *
 * 9. the real repo — bc-36xx.24's own acceptance criteria
 * ===================================================================== */

console.log("\nthe real repo — bc-36xx.24's own acceptance\n");

/*
 * `approvedReview` and `plansFor` are two of the five acceptance cases, and both are
 * checked here the same way — *not* by pinning the answer.
 *
 * An earlier version of this file asserted `verdict === 'mentioned only in comments'` for
 * `approvedReview`, which was true of this tree on the day it was written and false eight
 * hours later: `bc-36xx.22` landed and `lib/mergequeue.js:977` now calls it for real. That
 * assertion was a fact about `lib/reviewadvocate.js`'s wiring, not about this tool, and it
 * went red in CI on a branch whose own code was correct. `plansFor` has the same shape of
 * rot already visible in the bead: `bc-zjab`'s "five suites" is a count from a three-symbol
 * grep in 2026-08, and `plansFor` has since moved to a nested function inside
 * `lib/advocate.js` with one caller — see the note recorded on `bc-36xx.24`.
 *
 * So what is asserted is what cannot rot: the tool finds every mention an independent
 * word-boundary scan of the same files finds (the `bc-36xx.5` failure was a *silent miss*,
 * a search scoped wrong that read as "nothing is there"), never shrugs about a name that
 * demonstrably exists, and says a verdict its own occurrence list actually supports.
 * Whichever way `lib/mergequeue.js` is wired next week, all three stay true.
 */

/** Every line of `files` under `root` where `\bname\b` occurs, as `file:line` strings. */
function rawMentions(root, name, files) {
  const re = new RegExp(`\\b${name}\\b`);
  const hits = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  return hits;
}

/**
 * The three properties above, for one real symbol on this real tree. `r` is a
 * `findCallers` result; `files` is the file list it searched.
 */
function assertHonestAbout(name, r, files) {
  assert.notEqual(
    r.verdict,
    'no reference found anywhere searched',
    `${name} exists in this tree, so the shrug verdict is always wrong for it`,
  );

  // no silent miss: every raw mention is either reported or inside a definition's own span
  const reported = new Set(r.occurrences.map((o) => `${o.file}:${o.line}`));
  const inOwnBody = (ref) => {
    const [file, line] = [ref.slice(0, ref.lastIndexOf(':')), Number(ref.slice(ref.lastIndexOf(':') + 1))];
    return r.definitions.some((d) => d.file === file && line >= d.docStart && line <= d.endLine);
  };
  const missed = rawMentions(callers.REPO_ROOT, name, files).filter((ref) => !reported.has(ref) && !inOwnBody(ref));
  assert.deepEqual(missed, [], `${name}: mentions no occurrence and no definition span accounts for`);

  // the verdict is supported by the occurrences the tool itself reported
  const ownFiles = new Set(r.definitions.map((d) => d.file));
  const external = r.occurrences.filter((o) => o.kind === 'call' && !ownFiles.has(o.file));
  if (external.length) assert.equal(r.verdict, `wired (${external.length} call site${external.length === 1 ? '' : 's'})`);
  else assert.doesNotMatch(r.verdict, /^wired/, `${name}: claimed wired with no external call in its own occurrence list`);

  // every occurrence called a `call` really is one, read back off the line it came from
  for (const o of r.occurrences.filter((x) => x.kind === 'call')) {
    assert.match(o.text, new RegExp(`\\b${name}\\b\\s*(\\?\\.)?\\s*\\(`), `${o.file}:${o.line} classified a call`);
  }
}

check('approvedReview: every mention accounted for, and a verdict its own occurrences support', () => {
  const r = callers.findCallers(callers.REPO_ROOT, 'approvedReview', {});
  assert.ok(r.definitions.length >= 1, 'expected a definition of approvedReview');
  const files = callers.listAllSourceFiles(callers.REPO_ROOT).filter((f) => !f.startsWith('test/'));
  assertHonestAbout('approvedReview', r, files);
});

check('plansFor --tests: the fifth acceptance case, checked the same way', () => {
  const r = callers.findCallers(callers.REPO_ROOT, 'plansFor', { tests: true });
  assert.ok(r.definitions.length >= 1, 'expected a definition of plansFor');
  assertHonestAbout('plansFor', r, callers.listAllSourceFiles(callers.REPO_ROOT));
});

check('openReviewAnswerSession: the lib/reviewanswer.js hit is classified a comment, not a call', () => {
  const r = callers.findCallers(callers.REPO_ROOT, 'openReviewAnswerSession', {});
  const hit = r.occurrences.find((o) => o.file === 'lib/reviewanswer.js');
  assert.ok(hit, 'expected an occurrence in lib/reviewanswer.js');
  assert.equal(hit.kind, 'comment');
});

check('views.mark: found through the ?. chain at public/inboxfilter.js', () => {
  const r = callers.findCallers(callers.REPO_ROOT, 'views.mark', { tests: true });
  assert.ok(
    r.occurrences.some((o) => o.file === 'public/inboxfilter.js' && o.kind === 'call'),
    `expected a call in public/inboxfilter.js, got ${JSON.stringify(r.occurrences)}`,
  );
});

check('lib/session.js --imports: importing lib/advocate.js would close a cycle', () => {
  const report = callers.moduleReport(callers.REPO_ROOT, 'lib/session.js');
  assert.ok(
    report.wouldCloseCycleIfImported.includes('lib/advocate.js'),
    'lib/advocate.js already transitively imports lib/session.js, so the reverse edge would cycle',
  );
});

check('every top-level function in this repo gets the extent acorn gives it', () => {
  // The whole-tree pin for the round-1 regex/template desync, and the check to run against
  // ANY future port of the findBody/matchBrace walk: a hand-rolled scanner and a real
  // parser must agree about where a function ends, or findCallers skips the wrong lines and
  // answers "no reference found anywhere searched" about code with a caller in it.
  const files = callers.listAllSourceFiles(callers.REPO_ROOT);
  const wrong = [];
  let checked = 0;
  for (const f of files) {
    // The gate runs suites in parallel, and test/call.mjs writes its fixture into test/ —
    // so a file this walk listed a moment ago can be gone by the time it is read. A file
    // that no longer exists has no extent to disagree about, and only ENOENT is forgiven:
    // the `checked` assertion below is what stops this quietly skipping the whole tree.
    let text;
    try {
      text = fs.readFileSync(path.join(callers.REPO_ROOT, f), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    let ast;
    try {
      ast = acorn.parse(text, { ecmaVersion: 2022, sourceType: 'module', allowHashBang: true, locations: true });
    } catch {
      continue; // blankForBraceWalk falls back to the raw text here by design
    }
    for (const node of ast.body) {
      const fn =
        node.type === 'FunctionDeclaration'
          ? node
          : node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration'
            ? node.declaration
            : null;
      if (!fn?.id) continue;
      checked += 1;
      const def = callers.definitionsFor(fn.id.name, f, text).find((d) => d.startLine === fn.loc.start.line);
      if (!def) wrong.push(`${f}:${fn.loc.start.line} ${fn.id.name} not found at all`);
      else if (def.endLine !== fn.loc.end.line) {
        wrong.push(`${f}:${fn.loc.start.line} ${fn.id.name} endLine ${def.endLine} vs acorn ${fn.loc.end.line}`);
      }
    }
  }
  assert.ok(checked > 2000, `expected the whole tree, only checked ${checked}`);
  assert.deepEqual(wrong.slice(0, 10), [], `${wrong.length} of ${checked} function extents disagree with acorn`);
});

check('never a shrug: a name nowhere in the tree says so plainly, exit 1', () => {
  const run = spawnSync(process.execPath, [BIN, 'thisIdentifierAppearsNowhereInBeadcause9x7q'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /no reference found anywhere searched|no definition/);
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall callers checks passed\n');
process.exit(failures ? 1 : 0);
