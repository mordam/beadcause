#!/usr/bin/env node
//
// b7e-register — apply the four registrations a new bin/ command owes (bc-dgx7.75).
//
//   npm test
//   node test/b7eregister.mjs
//
// Same split as test/b7eenroll.mjs, whose checks this command is the applier for: the
// edits are pure string functions, proved here against small fixtures in the real shape
// of each file, and then the whole command is run for real against a fabricated
// checkout — because four functions that agree with themselves are not the same claim
// as four functions whose output satisfies b7e-enroll's own regexes. The last section
// is the bead's acceptance criterion, run: on a tree with bin/b7e-x written and nothing
// registered, one call leaves only the README section and the test owed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';
import * as enroll from '../lib/enroll.js';

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

const TOOLBELT = `export const SOMETHING_ELSE = ['Bash(b7e-ghost:*)'];

export const DEFAULT_TOOL_LIST = [
  'Read',
  // Read-only by construction.
  'Bash(b7e-def:*)',
  // b7e-gate is deliberately NOT on this list: it runs the suite.
];

export const DEFAULT_TOOLS = DEFAULT_TOOL_LIST.join(' ');
`;

const GRANTS = `export const GRANTS = Object.freeze({
  'Bash(npm test:*)': { kind: 'write', granted: ['merge-advocate'] },

  /* ---------------------------------------------------------------- read tools */
  Read: { kind: 'read' },
  'Bash(b7e-def:*)': { kind: 'read' },

  /* -------------------------------------------------------------- its own memory */
  'Bash(beadcause-memory:*)': { kind: 'memory' },
});
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
  // which is bin/file.js here, three lines above the b7e-* block, not the end of the map.
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
  assert.equal(parsed.packages['node_modules/acorn'].bin['b7e-register'], undefined);
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
 * DEFAULT_TOOL_LIST and lib/grants.js
 * ===================================================================== */

console.log('\nDEFAULT_TOOL_LIST and lib/grants.js\n');

check('a read command gets a wrapped paragraph and the grant itself', () => {
  const next = enroll.insertToolbeltEntry(TOOLBELT, 'b7e-register', { kind: 'read', why: 'It only reads.' });
  assert.match(next, /\n {2}\/\/ It only reads\. See bin\/b7e-register\.\n {2}'Bash\(b7e-register:\*\)',\n\];/);
});

check('a withheld command gets the paragraph and no grant — which is as real a registration', () => {
  const next = enroll.insertToolbeltEntry(TOOLBELT, 'b7e-register', { kind: 'withheld', why: 'It writes.' });
  assert.ok(!next.includes("'Bash(b7e-register:*)'"), next);
  assert.match(next, /b7e-register is deliberately NOT on this list\. It writes\. See bin\/b7e-register\./);
  check('and b7e-enroll reads that comment as the decision it is', () =>
    assert.equal(enroll.allowlistProblem('b7e-register', next, GRANTS), null)
  );
});

check('the entry lands inside DEFAULT_TOOL_LIST, not in the other array above it', () => {
  const next = enroll.insertToolbeltEntry(TOOLBELT, 'b7e-register', { kind: 'read', why: 'It only reads.' });
  const listText = enroll.toolListText(next);
  assert.ok(listText.includes('b7e-register'), listText);
  assert.ok(!next.slice(0, next.indexOf('export const DEFAULT_TOOL_LIST')).includes('b7e-register'));
});

check('a long justification is wrapped rather than written as one very long line', () => {
  const why = 'It only ever reads. '.repeat(20);
  const next = enroll.insertToolbeltEntry(TOOLBELT, 'b7e-register', { kind: 'read', why });
  const added = next.split('\n').filter((l) => l.startsWith('  // ') && !TOOLBELT.includes(l));
  assert.ok(added.length > 3, `${added.length} comment lines`);
  assert.ok(
    added.every((l) => l.length <= 98),
    added.map((l) => l.length).join(',')
  );
});

check('a name already decided about is left alone, however it was decided', () => {
  assert.equal(enroll.insertToolbeltEntry(TOOLBELT, 'b7e-def', { kind: 'read', why: 'x' }), TOOLBELT);
  assert.equal(enroll.insertToolbeltEntry(TOOLBELT, 'b7e-gate', { kind: 'read', why: 'x' }), TOOLBELT);
});

check('a mention outside the array does not count as a decision', () => {
  // 'Bash(b7e-ghost:*)' is in SOMETHING_ELSE above the array, which is exactly the
  // slice toolListText exists to cut away.
  const next = enroll.insertToolbeltEntry(TOOLBELT, 'b7e-ghost', { kind: 'read', why: 'It only reads.' });
  assert.notEqual(next, TOOLBELT);
});

check('lib/grants.js gains the classification after the last read tool, before the memory block', () => {
  const next = enroll.insertGrantsEntry(GRANTS, 'b7e-register');
  assert.match(next, /'Bash\(b7e-def:\*\)': \{ kind: 'read' \},\n {2}'Bash\(b7e-register:\*\)': \{ kind: 'read' \},/);
  assert.ok(next.indexOf('b7e-register') < next.indexOf('beadcause-memory'), next);
});

check('classifying twice is a no-op', () => {
  const once = enroll.insertGrantsEntry(GRANTS, 'b7e-register');
  assert.equal(enroll.insertGrantsEntry(once, 'b7e-register'), once);
});

/* ===================================================================== *
 * the sibling-name trap the array documents about itself
 * ===================================================================== */

console.log('\nnaming a sibling in a justification\n');

check('a justification naming an undecided sibling is reported, because it would close that gap', () => {
  assert.deepEqual(enroll.siblingsCleared('For the b7e-nobody reason above.', 'b7e-register', TOOLBELT), [
    'b7e-nobody',
  ]);
});

check('naming a sibling the array has already decided about is fine — half the real paragraphs do it', () => {
  assert.deepEqual(enroll.siblingsCleared('For the b7e-gate reason above.', 'b7e-register', TOOLBELT), []);
  assert.deepEqual(enroll.siblingsCleared('Read-only like b7e-def.', 'b7e-register', TOOLBELT), []);
});

check('naming itself is not naming a sibling', () => {
  assert.deepEqual(enroll.siblingsCleared('See bin/b7e-register.', 'b7e-register', TOOLBELT), []);
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

const makeCheckout = (name, { readme = '', testFile = null } = {}) => {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), PKG);
  fs.writeFileSync(path.join(root, 'package-lock.json'), LOCK);
  fs.writeFileSync(path.join(root, 'lib', 'toolbelt.js'), TOOLBELT);
  fs.writeFileSync(path.join(root, 'lib', 'grants.js'), GRANTS);
  fs.writeFileSync(path.join(root, 'README.md'), readme);
  if (testFile) fs.writeFileSync(path.join(root, 'test', 'b7ex.mjs'), testFile);
  fs.writeFileSync(path.join(root, 'bin', 'b7e-x'), '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.chmodSync(path.join(root, 'bin', 'b7e-x'), 0o755);
  return root;
};

const run = (root, args) =>
  spawnSync(process.execPath, [BIN, ...args, '--dir', root], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });

{
  const root = makeCheckout('bare');
  const r = run(root, ['b7e-x', '--kind', 'read', '--why', 'It only ever reads and prints what it found.']);

  check('it exits 1 — something is still owed, and says which two', () => {
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /README\.md: no ### section names b7e-x/);
    assert.match(r.stdout, /test\/: no test spawns bin\/b7e-x/);
  });

  check('and ONLY those two — the four it can write are written (the acceptance criterion)', () => {
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

  check('the grant and its classification both landed, which is what test/grants.mjs wants', () => {
    const toolbelt = fs.readFileSync(path.join(root, 'lib', 'toolbelt.js'), 'utf8');
    const grants = fs.readFileSync(path.join(root, 'lib', 'grants.js'), 'utf8');
    assert.ok(toolbelt.includes("'Bash(b7e-x:*)',"), toolbelt);
    assert.ok(grants.includes("'Bash(b7e-x:*)': { kind: 'read' },"), grants);
    assert.equal(enroll.allowlistProblem('b7e-x', toolbelt, grants), null);
  });

  check('running it a second time is a no-op that says so, and does not double any entry', () => {
    const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const again = run(root, ['b7e-x', '--kind', 'read', '--why', 'It only ever reads and prints what it found.']);
    assert.match(again.stdout, /already registered in all four/);
    assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  });

  check('--dry-run on an already-registered name prints an empty patch (the acceptance criterion)', () => {
    const dry = run(root, ['b7e-x', '--kind', 'read', '--why', 'x', '--dry-run']);
    assert.ok(!dry.stdout.includes('@@'), dry.stdout);
    assert.match(dry.stdout, /already registered in all four/);
  });
}

{
  const root = makeCheckout('complete', {
    readme: '### Reads a thing — `b7e-x`\n\nWhat it does.\n',
    testFile: "const p = path.join(ROOT, 'bin', 'b7e-x');\n",
  });
  const r = run(root, ['b7e-x', '--kind', 'withheld', '--why', 'It writes to the checkout it runs in.']);
  check('on a tree that already has its README section and its test, one call ends at nothing owed', () => {
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /nothing owed/);
  });
  check('and a withheld command is not classified in lib/grants.js — nothing granted it', () => {
    const grants = fs.readFileSync(path.join(root, 'lib', 'grants.js'), 'utf8');
    assert.ok(!grants.includes('b7e-x'), grants);
  });
}

{
  const root = makeCheckout('dry');
  const before = ['package.json', 'package-lock.json', 'lib/toolbelt.js', 'lib/grants.js'].map((f) =>
    fs.readFileSync(path.join(root, f), 'utf8')
  );
  const r = run(root, ['b7e-x', '--kind', 'read', '--why', 'It only ever reads.', '--dry-run']);
  check('--dry-run prints a patch for all four and writes none of them', () => {
    assert.equal(r.stdout.match(/^--- a\//gm).length, 4, r.stdout);
    const after = ['package.json', 'package-lock.json', 'lib/toolbelt.js', 'lib/grants.js'].map((f) =>
      fs.readFileSync(path.join(root, f), 'utf8')
    );
    assert.deepEqual(after, before);
  });
  check('and says outright that nothing was written', () => assert.match(r.stdout, /nothing was written/));
}

/* ===================================================================== *
 * refusals — the three things it will not decide for you
 * ===================================================================== */

console.log('\nrefusals\n');

{
  const root = makeCheckout('refuse');

  check('no --kind is a refusal, not a default', () => {
    const r = run(root, ['b7e-x', '--why', 'It only reads.']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--kind read\|withheld is required and has no default/);
  });

  check('a --kind that is neither is refused the same way', () => {
    const r = run(root, ['b7e-x', '--kind', 'maybe', '--why', 'It only reads.']);
    assert.equal(r.status, 2);
  });

  check('no --why is a refusal — the paragraph is the registration', () => {
    const r = run(root, ['b7e-x', '--kind', 'read']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--why is required/);
  });

  check('a --why naming an undecided sibling is refused, with what to do instead', () => {
    const r = run(root, ['b7e-x', '--kind', 'read', '--why', 'Read-only, for the b7e-nobody reason.']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /b7e-nobody/);
    assert.match(r.stderr, /by description instead/);
  });

  check('a name with no file in bin/ is refused — it registers a command, it does not write one', () => {
    const r = run(root, ['b7e-ghost', '--kind', 'read', '--why', 'It only reads.']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /nothing there to register/);
  });

  check('nothing was written by any of those five', () => {
    assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), PKG);
    assert.equal(fs.readFileSync(path.join(root, 'lib', 'toolbelt.js'), 'utf8'), TOOLBELT);
  });

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
  const edits = enroll.registerEdits(ROOT, 'b7e-register', { kind: 'withheld', why: 'It writes.' });
  check('this repo is already registered by its own rules — no edit is outstanding', () =>
    assert.deepEqual(
      edits.map((e) => e.rel),
      []
    )
  );

  const ctx = enroll.loadContext(ROOT);
  check('and b7e-enroll agrees, for the four this command writes', () => {
    const owed = enroll.problemsFor('b7e-register', ctx);
    assert.deepEqual(owed, [], owed.join('\n'));
  });
}

console.log(failures ? `\n${failures} failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
