#!/usr/bin/env node
//
// b7e-register — apply the registrations a new bin/ command owes (bc-dgx7.75).
//
//   npm test
//   node test/b7eregister.mjs
//
// Same split as test/b7eenroll.mjs, whose checks this command is the applier for: the
// edits are pure string functions, proved here against small fixtures in the real shape
// of each file, and then the whole command is run for real against a fabricated
// checkout — because functions that agree with themselves are not the same claim as
// functions whose output satisfies b7e-enroll's own checks. The last section is the
// bead's acceptance criterion, run: on a tree with bin/b7e-x written and nothing
// registered, one call leaves only the README section and the test owed.
//
// The command is SMALLER than its bead describes, and that is the interesting thing to
// keep pinned. bc-wbrhi deleted two of the four registries bc-dgx7.75 named — a tool
// declares `@grant read|write|excluded` in its own header now and lib/tooldecl.js
// derives DEFAULT_TOOL_LIST and the lib/grants.js classification from that — so the
// check below that no b7e-* line is ever written into lib/grants.js is not paranoia:
// test/tooldecl.mjs fails the repo for exactly that, and it is the shape this command
// was originally specified to produce.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';
import * as enroll from '../lib/enroll.js';
import { declarationsIn, KINDS } from '../lib/tooldecl.js';
import { GRANTS } from '../lib/grants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-register');

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
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eregister-'));

/* ===================================================================== *
 * fixtures — each file in the shape the real one is in
 * ===================================================================== */

// package.json: the worker tools in the order they were written, then a sorted b7e-*
// block. That split is the whole reason insertionIndex reads a family and not the map.
const PKG = `{
  "name": "beadcause",
  "version": "0.1.0",
  "bin": {
    "beadcause": "bin/beadcause.js",
    "beadcause-monitor": "bin/monitor.js",
    "beadcause-file": "bin/file.js",
    "b7e-affected": "bin/b7e-affected",
    "b7e-def": "bin/b7e-def",
    "b7e-readme": "bin/b7e-readme",
    "b7e-ws": "bin/b7e-ws"
  },
  "scripts": {
    "test": "node scripts/test.mjs"
  }
}
`;

// package-lock.json: sorted throughout, and indented two levels deeper. The key SETS
// match package.json's and the ORDERS do not — memory note
// package-lock-bin-order-differs-from-package-json.
const LOCK = `{
  "name": "beadcause",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "beadcause",
      "bin": {
        "b7e-affected": "bin/b7e-affected",
        "b7e-def": "bin/b7e-def",
        "b7e-readme": "bin/b7e-readme",
        "b7e-ws": "bin/b7e-ws",
        "beadcause": "bin/beadcause.js",
        "beadcause-file": "bin/file.js",
        "beadcause-monitor": "bin/monitor.js"
      },
      "dependencies": {}
    },
    "node_modules/acorn": {
      "version": "8.0.0",
      "bin": {
        "acorn": "bin/acorn"
      }
    }
  }
}
`;

const TOOLDECL = `export const KINDS = Object.freeze(['read', 'write', 'excluded']);

/* ===================================================================================
   The argument — why each of these is on the list, and why the rest are not.
   =================================================================================== */

  // Read-only by construction — it only ever reads. See bin/b7e-def.
  //   → Bash(b7e-def:*) — declared \`@grant read\` in bin/b7e-def
`;

// A brand-new command, as b7e-scaffold would leave it: a header docblock and no
// declaration in it yet.
const TOOL = `#!/usr/bin/env node
/**
 * Does the thing.
 *
 * Exit code: 0 when it worked.
 */
import fs from 'node:fs';
console.log(fs.constants.F_OK);
`;

/* ===================================================================== *
 * where a new key goes in a bin map
 * ===================================================================== */

console.log('\nwhere a new key goes in a bin map\n');

const pkgEntries = (src) => {
  const lines = src.split('\n');
  return enroll.binEntries(lines, enroll.binBlockRange(lines));
};

check('a b7e-* name lands alphabetically among the b7e-* keys, not at the end of the map', () => {
  const entries = pkgEntries(PKG);
  const { index } = enroll.insertionIndex(entries, 'b7e-register');
  assert.equal(entries[index].key, 'b7e-ws');
  assert.equal(entries[index - 1].key, 'b7e-readme');
});

check('a name after every member of its family goes below the last of them', () => {
  const entries = pkgEntries(PKG);
  const { index } = enroll.insertionIndex(entries, 'b7e-zzz');
  assert.equal(entries[index - 1].key, 'b7e-ws');
  assert.equal(index, entries.length); // b7e-ws happens to be the last key in package.json
});

check('the same name lands in a different place in the lock, because the lock is sorted throughout', () => {
  const lines = LOCK.split('\n');
  const entries = enroll.binEntries(lines, enroll.binBlockRange(lines, { lock: true }));
  const { index } = enroll.insertionIndex(entries, 'b7e-zzz');
  assert.equal(entries[index].key, 'beadcause');
});

check('a beadcause-* name goes below the last beadcause-* key, leaving that block in its written order', () => {
  // The worker-tool block is NOT alphabetical, so nothing in it sorts after
  // beadcause-zebra and the rule falls through to "below the last of the family" —
  // which is bin/file.js here, not the end of the map.
  const entries = pkgEntries(PKG);
  const { index } = enroll.insertionIndex(entries, 'beadcause-zebra');
  assert.equal(entries[index - 1].key, 'beadcause-file');
  assert.equal(entries[index].key, 'b7e-affected');
});

check('a name whose family has no members yet appends at the end of the map', () => {
  const entries = pkgEntries(PKG);
  const { index } = enroll.insertionIndex(entries, 'zz-new');
  assert.equal(index, entries.length);
});

check('--after overrides the alphabet', () => {
  const entries = pkgEntries(PKG);
  const { index } = enroll.insertionIndex(entries, 'b7e-register', { after: 'b7e-affected' });
  assert.equal(entries[index].key, 'b7e-def');
});

check('--after a key that is not there is an error, not a silent append', () => {
  const { error, index } = enroll.insertionIndex(pkgEntries(PKG), 'b7e-register', { after: 'b7e-ghost' });
  assert.equal(index, undefined);
  assert.match(error, /no such entry/);
});

/* ===================================================================== *
 * writing the bin maps
 * ===================================================================== */

console.log('\nwriting the two bin maps\n');

check('package.json gains exactly one line, in the b7e-* block, with the file indent', () => {
  const next = enroll.insertBinKey(PKG, 'b7e-register', 'bin/b7e-register');
  const added = next.split('\n').filter((l) => !PKG.split('\n').includes(l));
  assert.deepEqual(added, ['    "b7e-register": "bin/b7e-register",']);
  assert.match(next, /"b7e-readme": "bin\/b7e-readme",\n    "b7e-register": "bin\/b7e-register",\n    "b7e-ws"/);
});

check('the result still parses, and every other key keeps its value', () => {
  const next = JSON.parse(enroll.insertBinKey(PKG, 'b7e-register', 'bin/b7e-register'));
  const before = JSON.parse(PKG);
  assert.equal(next.bin['b7e-register'], 'bin/b7e-register');
  for (const [k, v] of Object.entries(before.bin)) assert.equal(next.bin[k], v);
  assert.equal(Object.keys(next.bin).length, Object.keys(before.bin).length + 1);
});

check('an insertion at the end of the map moves the comma rather than writing invalid JSON', () => {
  const next = enroll.insertBinKey(PKG, 'zz-new', 'bin/zz-new');
  assert.equal(JSON.parse(next).bin['zz-new'], 'bin/zz-new');
  assert.match(next, /"b7e-ws": "bin\/b7e-ws",\n    "zz-new": "bin\/zz-new"\n/);
});

check('the lock is edited under packages[""] and not under a dependency that also has a bin map', () => {
  const next = enroll.insertBinKey(LOCK, 'b7e-register', 'bin/b7e-register', { lock: true });
  const parsed = JSON.parse(next);
  assert.equal(parsed.packages[''].bin['b7e-register'], 'bin/b7e-register');
  assert.deepEqual(Object.keys(parsed.packages['node_modules/acorn'].bin), ['acorn']);
});

check('the lock diff is exactly one line — the acceptance criterion, and what npm would have written', () => {
  const next = enroll.insertBinKey(LOCK, 'b7e-register', 'bin/b7e-register', { lock: true });
  const before = LOCK.split('\n');
  const after = next.split('\n');
  assert.equal(after.length, before.length + 1);
  const added = after.filter((l, i) => l !== before[i] && !before.includes(l));
  assert.deepEqual(added, ['        "b7e-register": "bin/b7e-register",']);
  // What `npm install --package-lock-only` produces: the whole map still sorted.
  const keys = Object.keys(JSON.parse(next).packages[''].bin);
  assert.deepEqual(keys, [...keys].sort());
});

check('a key that is already there with the same target changes nothing', () => {
  assert.equal(enroll.insertBinKey(PKG, 'b7e-def', 'bin/b7e-def'), PKG);
});

check('a key that is already there pointing somewhere else is corrected, not duplicated', () => {
  const next = enroll.insertBinKey(PKG, 'b7e-def', 'bin/b7e-def.js');
  assert.equal(JSON.parse(next).bin['b7e-def'], 'bin/b7e-def.js');
  assert.equal(next.split('\n').length, PKG.split('\n').length);
});

/* ===================================================================== *
 * the @grant line — check 6, and since bc-wbrhi the whole of the decision
 * ===================================================================== */

console.log('\nthe @grant line in the tool own header\n');

for (const kind of KINDS) {
  check(`@grant ${kind} lands at the end of the header docblock, where lib/tooldecl.js reads it`, () => {
    const next = enroll.insertGrantLine(TOOL, kind, 'It only ever reads.');
    assert.deepEqual(declarationsIn(next), [kind]);
    assert.match(next, new RegExp(` \\* @grant ${kind}\\n \\*/\\n`));
  });
}

check('the reason goes in beside it, wrapped, in the house form', () => {
  const next = enroll.insertGrantLine(TOOL, 'read', 'It only ever reads. '.repeat(15));
  const added = next.split('\n').filter((l) => l.startsWith(' * ') && !TOOL.includes(l));
  assert.ok(added.length > 2, `${added.length} comment lines`);
  assert.ok(
    added.every((l) => l.length <= 96),
    added.map((l) => l.length).join(',')
  );
});

check('the code below the header is untouched', () => {
  const next = enroll.insertGrantLine(TOOL, 'read', 'It only ever reads.');
  assert.ok(next.endsWith("import fs from 'node:fs';\nconsole.log(fs.constants.F_OK);\n"), next.slice(-120));
  assert.ok(next.startsWith('#!/usr/bin/env node\n/**\n * Does the thing.\n'), next.slice(0, 80));
});

check('a file that already declares is left alone — two @grant lines is a tooldecl problem', () => {
  const once = enroll.insertGrantLine(TOOL, 'read', 'It only ever reads.');
  assert.equal(enroll.insertGrantLine(once, 'excluded', 'Actually it writes.'), once);
  assert.equal(declarationsIn(once).length, 1);
});

check('a file with no header docblock is an error rather than a guess at where to put it', () => {
  assert.throws(() => enroll.insertGrantLine('#!/usr/bin/env node\nconsole.log(1);\n', 'read', 'x'), /docblock/);
});

/* ===================================================================== *
 * the paragraph in lib/tooldecl.js
 * ===================================================================== */

console.log('\nthe argument paragraph\n');

check('a granted tool gets a paragraph and the arrow line saying where its entry comes from', () => {
  const next = enroll.insertArgumentParagraph(TOOLDECL, 'b7e-x', 'read', 'It only ever reads.');
  assert.match(next, /\n {2}\/\/ It only ever reads\. See bin\/b7e-x\.\n/);
  assert.match(next, /\n {2}\/\/ {3}→ Bash\(b7e-x:\*\) — declared `@grant read` in bin\/b7e-x\n$/);
});

check('an excluded tool gets the paragraph and no arrow — there is no entry to point at', () => {
  const next = enroll.insertArgumentParagraph(TOOLDECL, 'b7e-x', 'excluded', 'It writes.');
  assert.match(next, /b7e-x is deliberately NOT on this list\. It writes\. See bin\/b7e-x\./);
  // The fixture's own b7e-def block carries one, so only the appended part may not.
  const appended = next.slice(TOOLDECL.replace(/\n+$/, '').length);
  assert.ok(!appended.includes('→'), appended);
});

check('it appends, leaving every existing paragraph byte-identical', () => {
  const next = enroll.insertArgumentParagraph(TOOLDECL, 'b7e-x', 'read', 'It only ever reads.');
  assert.ok(next.startsWith(TOOLDECL.replace(/\n+$/, '')), 'the existing run was rewritten');
});

check('a tool already argued for is left alone', () => {
  assert.equal(enroll.insertArgumentParagraph(TOOLDECL, 'b7e-def', 'read', 'x'), TOOLDECL);
});

/* ===================================================================== *
 * the patch --dry-run prints
 * ===================================================================== */

console.log('\nthe patch\n');

check('identical text is an empty patch, not a zero-line hunk', () => {
  assert.equal(enroll.unifiedDiff('package.json', PKG, PKG), '');
});

check('an insertion is one hunk with one + line and no - line', () => {
  const next = enroll.insertBinKey(PKG, 'b7e-register', 'bin/b7e-register');
  const patch = enroll.unifiedDiff('package.json', PKG, next).split('\n');
  assert.equal(patch.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length, 1);
  assert.equal(patch.filter((l) => l.startsWith('-') && !l.startsWith('---')).length, 0);
  assert.equal(patch.filter((l) => l.startsWith('@@')).length, 1);
});

check('the hunk header counts the lines the hunk actually holds', () => {
  const next = enroll.insertBinKey(PKG, 'b7e-register', 'bin/b7e-register');
  const patch = enroll.unifiedDiff('package.json', PKG, next).split('\n');
  const [, oldCount, newCount] = /@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(patch.find((l) => l.startsWith('@@')));
  const body = patch.slice(3).filter((l) => l !== '');
  assert.equal(Number(oldCount), body.filter((l) => l.startsWith(' ') || l.startsWith('-')).length);
  assert.equal(Number(newCount), body.filter((l) => l.startsWith(' ') || l.startsWith('+')).length);
});

/* ===================================================================== *
 * end to end — the bead's acceptance criterion, on a fabricated checkout
 * ===================================================================== */

console.log('\nend to end, on a fabricated checkout\n');

const REGISTRIES = ['package.json', 'package-lock.json', 'lib/tooldecl.js', 'bin/b7e-x'];

const makeCheckout = (name, { readme = '', testFile = null } = {}) => {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), PKG);
  fs.writeFileSync(path.join(root, 'package-lock.json'), LOCK);
  fs.writeFileSync(path.join(root, 'lib', 'tooldecl.js'), TOOLDECL);
  fs.writeFileSync(path.join(root, 'README.md'), readme);
  if (testFile) fs.writeFileSync(path.join(root, 'test', 'b7ex.mjs'), testFile);
  fs.writeFileSync(path.join(root, 'bin', 'b7e-x'), TOOL, { mode: 0o755 });
  fs.chmodSync(path.join(root, 'bin', 'b7e-x'), 0o755);
  return root;
};

const run = (root, args) =>
  spawnSync(process.execPath, [BIN, ...args, '--dir', root], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });

const readAll = (root) => REGISTRIES.map((f) => fs.readFileSync(path.join(root, f), 'utf8'));

{
  const root = makeCheckout('bare');
  const r = run(root, ['b7e-x', '--kind', 'read', '--why', 'It only ever reads and prints what it found.']);

  check('it exits 1 — something is still owed, and says which two', () => {
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /README\.md: no ### section names b7e-x/);
    assert.match(r.stdout, /test\/: no test spawns bin\/b7e-x/);
  });

  check('and ONLY those two — everything a tool can write is written (the acceptance criterion)', () => {
    const owed = r.stdout.split('still owed —')[1].split('\n').filter(Boolean);
    assert.equal(owed.length, 2, r.stdout);
  });

  check('package.json and the lock agree, and the lock gained exactly one line', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.bin['b7e-x'], 'bin/b7e-x');
    assert.equal(lock.packages[''].bin['b7e-x'], 'bin/b7e-x');
    const lines = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8').split('\n');
    assert.equal(lines.length, LOCK.split('\n').length + 1);
  });

  check('the tool declares itself, which is what DEFAULT_TOOL_LIST is derived from', () => {
    const src = fs.readFileSync(path.join(root, 'bin', 'b7e-x'), 'utf8');
    assert.deepEqual(declarationsIn(src), ['read']);
    // And b7e-enroll's own check 6/7 pair is satisfied, given a map that classifies it.
    assert.equal(enroll.allowlistProblem('b7e-x', src, { 'Bash(b7e-x:*)': { kind: 'read' } }), null);
  });

  check('the paragraph landed in lib/tooldecl.js with its arrow line', () => {
    const src = fs.readFileSync(path.join(root, 'lib', 'tooldecl.js'), 'utf8');
    assert.match(src, /→ Bash\(b7e-x:\*\) — declared `@grant read` in bin\/b7e-x/);
  });

  check('NOTHING was written into a lib/grants.js — test/tooldecl.mjs fails the repo for that', () => {
    // The registry this command was specified to write, and the one it must not: since
    // bc-wbrhi the b7e half of lib/grants.js is spread from the declarations, and a
    // hand-written 'Bash(b7e-*:*)': line there is a test failure rather than a
    // registration. The fixture has no lib/grants.js at all, so a tool that still wanted
    // to write one would have crashed above.
    assert.ok(!fs.existsSync(path.join(root, 'lib', 'grants.js')));
    for (const f of ['package.json', 'package-lock.json', 'lib/tooldecl.js']) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      assert.ok(!/'Bash\(b7e-x:\*\)':/.test(src), `${f} carries a hand-written classification`);
    }
  });

  check('running it a second time is a no-op that says so, and does not double any entry', () => {
    const before = readAll(root);
    const again = run(root, ['b7e-x', '--kind', 'read', '--why', 'It only ever reads and prints what it found.']);
    assert.match(again.stdout, /already registered everywhere a tool can write/);
    assert.deepEqual(readAll(root), before);
  });

  check('--dry-run on an already-registered name prints an empty patch (the acceptance criterion)', () => {
    const dry = run(root, ['b7e-x', '--kind', 'read', '--why', 'x', '--dry-run']);
    assert.ok(!dry.stdout.includes('@@'), dry.stdout);
    assert.match(dry.stdout, /already registered everywhere a tool can write/);
  });
}

{
  const root = makeCheckout('complete', {
    readme: '### Reads a thing — `b7e-x`\n\nWhat it does.\n',
    testFile: "const p = path.join(ROOT, 'bin', 'b7e-x');\n",
  });
  const r = run(root, ['b7e-x', '--kind', 'excluded', '--why', 'It writes to the checkout it runs in.']);
  check('on a tree that already has its README section and its test, one call ends at nothing owed', () => {
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /nothing owed/);
  });
  check('an excluded tool is a decision — declared, argued for, and not granted', () => {
    const src = fs.readFileSync(path.join(root, 'bin', 'b7e-x'), 'utf8');
    assert.deepEqual(declarationsIn(src), ['excluded']);
    // Check 6 passes on an excluded tool with no classification anywhere, which is the
    // whole point of `excluded` being a decision rather than an absence.
    assert.equal(enroll.allowlistProblem('b7e-x', src, {}), null);
    assert.ok(!fs.readFileSync(path.join(root, 'lib', 'tooldecl.js'), 'utf8').includes('→ Bash(b7e-x'));
  });
}

{
  const root = makeCheckout('dry');
  const before = readAll(root);
  const r = run(root, ['b7e-x', '--kind', 'read', '--why', 'It only ever reads.', '--dry-run']);
  check('--dry-run prints a patch for all four files and writes none of them', () => {
    assert.equal(r.stdout.match(/^--- a\//gm).length, 4, r.stdout);
    assert.deepEqual(readAll(root), before);
  });
  check('and says outright that nothing was written', () => assert.match(r.stdout, /nothing was written/));
}

/* ===================================================================== *
 * refusals — the things it will not decide for you
 * ===================================================================== */

console.log('\nrefusals\n');

{
  const root = makeCheckout('refuse');
  const before = readAll(root);

  check('no --kind is a refusal, not a default', () => {
    const r = run(root, ['b7e-x', '--why', 'It only reads.']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /is required and has no default/);
  });

  check('a --kind outside @grant own vocabulary is refused the same way', () => {
    const r = run(root, ['b7e-x', '--kind', 'withheld', '--why', 'It only reads.']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /read\|write\|excluded/);
  });

  check('no --why is a refusal — it is what the registration says', () => {
    const r = run(root, ['b7e-x', '--kind', 'read']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--why is required/);
  });

  check('a name with no file in bin/ is refused — it registers a command, it does not write one', () => {
    const r = run(root, ['b7e-ghost', '--kind', 'read', '--why', 'It only reads.']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /nothing there to register/);
  });

  check('an unknown flag is refused with the usage rather than ignored', () => {
    const r = run(root, ['b7e-x', '--kind', 'read', '--why', 'x', '--fabricate']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag --fabricate/);
  });

  check('nothing was written by any of those five', () => assert.deepEqual(readAll(root), before));

  check('a bare bin/ path is accepted as the name, the way b7e-enroll takes one', () => {
    const r = run(root, ['bin/b7e-x', '--kind', 'read', '--why', 'It only ever reads.']);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).bin['b7e-x'], 'bin/b7e-x');
  });
}

await cleanupTmp(tmp);

/* ===================================================================== *
 * against this repo's own tree
 * ===================================================================== */

console.log('\nagainst this repo\n');

{
  // b7e-register registered itself with itself, so there is nothing left for it to do
  // here — and a non-empty result would mean the applier and this checkout disagree
  // about what a registration looks like.
  const edits = enroll.registerEdits(ROOT, 'b7e-register', { kind: 'excluded', why: 'It writes.' });
  check('this repo is already registered by its own rules — no edit is outstanding', () =>
    assert.deepEqual(
      edits.map((e) => e.rel),
      []
    )
  );

  check('and b7e-enroll agrees, for every one of the seven', () => {
    const owed = enroll.problemsFor('b7e-register', enroll.loadContext(ROOT, enroll.derivedGrants(ROOT)));
    assert.deepEqual(owed, [], owed.join('\n'));
  });

  check('the derived map matches what lib/grants.js was built from — check 7 is not a second opinion', () => {
    // Every granted b7e-* tool in this checkout, re-derived, must be exactly the set
    // lib/grants.js already carries. If these ever disagree the wiring has come apart,
    // which is the one thing check 7 exists to catch now that it is otherwise free.
    const derived = Object.keys(enroll.derivedGrants(ROOT)).sort();
    const live = Object.keys(GRANTS)
      .filter((k) => /^Bash\(b7e-/.test(k))
      .sort();
    assert.deepEqual(derived, live);
  });

  check('it declares itself excluded, so nothing derives a grant for it', () => {
    const src = fs.readFileSync(BIN, 'utf8');
    assert.deepEqual(declarationsIn(src), ['excluded']);
  });
}

console.log(failures ? `\n${failures} failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
