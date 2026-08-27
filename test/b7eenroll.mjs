#!/usr/bin/env node
//
// b7e-enroll — what a new bin/ command still owes before an agent can call it
// (bc-khoe.27.11).
//
//   npm test
//   node test/b7eenroll.mjs
//
// Same split as test/b7eowes.mjs: the seven checks are pure functions, proved here
// against small fabricated fixtures in the real shape rather than a whole second
// checkout, and then run once for real against this repo's own tree — because a set
// of regexes that agree with themselves is not the same claim as a set of regexes
// that agree with lib/toolbelt.js and lib/grants.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-enroll');

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

const enroll = await import(BIN);

/* ===================================================================== *
 * naming
 * ===================================================================== */

console.log('\nderiving a command name from an argv token or a bin/ path\n');

check('a bare command name passes through', () => assert.equal(enroll.deriveName('b7e-say'), 'b7e-say'));
check('a bin/ path with a .js extension is stripped to the command name', () =>
  assert.equal(enroll.deriveName('bin/b7e-x.js'), 'b7e-x')
);
check('an extensionless bin/ path keeps its basename', () => assert.equal(enroll.deriveName('bin/b7e-x'), 'b7e-x'));

/* ===================================================================== *
 * 1. the bin/ file itself — b7e-* only
 * ===================================================================== */

console.log('\nthe bin/ file itself\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eenroll-'));
{
  const root = path.join(tmp, 'fresh');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });

  check('an unregistered name with no extensionless file at all is named', () => {
    const p = enroll.binFileProblem('b7e-x', root, { bin: {} });
    assert.match(p, /no extensionless file here yet/);
  });

  fs.writeFileSync(path.join(root, 'bin', 'b7e-x.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  check('a same-named .js file does not satisfy the extensionless requirement', () => {
    const p = enroll.binFileProblem('b7e-x', root, { bin: {} });
    assert.match(p, /no extensionless file here yet/);
  });

  fs.writeFileSync(path.join(root, 'bin', 'b7e-x'), 'console.log(1)\n', { mode: 0o755 });
  check('an extensionless file with no shebang is named', () => {
    const p = enroll.binFileProblem('b7e-x', root, { bin: {} });
    assert.match(p, /no '#!\/usr\/bin\/env node' shebang/);
  });

  // writeFileSync's `mode` only applies when the file is created, not on an overwrite
  // of one that already exists — chmod explicitly rather than relying on it.
  fs.writeFileSync(path.join(root, 'bin', 'b7e-x'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(root, 'bin', 'b7e-x'), 0o644);
  check('an extensionless file with a shebang but no exec bit is named', () => {
    const p = enroll.binFileProblem('b7e-x', root, { bin: {} });
    assert.match(p, /not executable/);
  });

  fs.chmodSync(path.join(root, 'bin', 'b7e-x'), 0o755);
  check('extensionless, executable, shebang — nothing to say', () => {
    assert.equal(enroll.binFileProblem('b7e-x', root, { bin: {} }), null);
  });

  check('once a name is registered, an existing .js target is trusted as-is', () => {
    // b7e-owes and b7e-say both still point at a `.js` file on main — relitigating an
    // *existing* mismatch is bc-jlop's job, not a fresh finding on every sweep.
    const p = enroll.binFileProblem('b7e-x', root, { bin: { 'b7e-x': 'bin/b7e-x.js' } });
    assert.equal(p, null);
  });

  check('a registered target that is actually missing is still named', () => {
    const p = enroll.binFileProblem('b7e-x', root, { bin: { 'b7e-x': 'bin/b7e-ghost' } });
    assert.match(p, /file is missing/);
  });
}

/* ===================================================================== *
 * 2 & 3. package.json / package-lock.json — universal
 * ===================================================================== */

console.log('\npackage.json and package-lock.json\n');

check('no package.json entry is named', () => {
  const p = enroll.packageJsonProblem('b7e-x', { bin: {} });
  assert.match(p, /package\.json: no "bin" entry for b7e-x/);
});
check('a package.json entry needs nothing further named here', () => {
  assert.equal(enroll.packageJsonProblem('b7e-x', { bin: { 'b7e-x': 'bin/b7e-x' } }), null);
});
check('with no package.json entry, package-lock.json is silent (packageJsonProblem already names the gap)', () => {
  assert.equal(enroll.packageLockProblem('b7e-x', { bin: {} }, { packages: { '': { bin: {} } } }), null);
});
check('a package.json entry with no matching lock entry is named — exact wording from the bead', () => {
  const p = enroll.packageLockProblem('b7e-x', { bin: { 'b7e-x': 'bin/b7e-x' } }, { packages: { '': { bin: {} } } });
  assert.equal(p, 'package-lock.json packages[""].bin: no b7e-x (test/lockfile.mjs, pinned first)');
});
check('a lock entry that disagrees with package.json is named', () => {
  const p = enroll.packageLockProblem(
    'b7e-x',
    { bin: { 'b7e-x': 'bin/b7e-x' } },
    { packages: { '': { bin: { 'b7e-x': 'bin/b7e-x.js' } } } }
  );
  assert.match(p, /b7e-x -> "bin\/b7e-x\.js", package\.json says "bin\/b7e-x"/);
});
check('package.json and package-lock.json agreeing is silent', () => {
  const p = enroll.packageLockProblem(
    'b7e-x',
    { bin: { 'b7e-x': 'bin/b7e-x' } },
    { packages: { '': { bin: { 'b7e-x': 'bin/b7e-x' } } } }
  );
  assert.equal(p, null);
});

/* ===================================================================== *
 * 4. a test that spawns it — b7e-* only
 * ===================================================================== */

console.log("\na test/*.mjs that spawns it — not a fixed filename\n");

{
  const testDir = path.join(tmp, 'testdir');
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'unrelated.mjs'), "const BIN = path.join(ROOT, 'bin', 'b7e-other');\n");
  check('no test spawns it — named', () => {
    const p = enroll.testFileProblem('b7e-x', testDir);
    assert.match(p, /no test spawns bin\/b7e-x/);
  });
  // The family's own convention: the TEST FILE's name never has to match — only that
  // some file under test/ builds the right path.join call. test/eyeball.mjs tests
  // b7e-eyeball; this fixture reuses that mismatch on purpose.
  fs.writeFileSync(path.join(testDir, 'eyeball.mjs'), "const BIN = path.join(ROOT, 'bin', 'b7e-x');\n");
  check('a differently-named test file that builds the right path is enough', () => {
    assert.equal(enroll.testFileProblem('b7e-x', testDir), null);
  });
  fs.writeFileSync(path.join(testDir, 'owesish.mjs'), "const BIN = path.join(ROOT, 'bin', 'b7e-y.js');\n");
  check('the .js-suffixed spelling of path.join also counts', () => {
    assert.equal(enroll.testFileProblem('b7e-y', testDir), null);
  });
}

/* ===================================================================== *
 * 5. README.md — b7e-* only
 * ===================================================================== */

console.log('\nthe README ### section\n');

check('no ### section naming it is named', () => {
  const p = enroll.readmeProblem('b7e-x', '### Something else — `b7e-y`\n');
  assert.match(p, /no ### section names b7e-x/);
});
check('a ### heading naming it, backtick-quoted, is enough', () => {
  assert.equal(enroll.readmeProblem('b7e-x', '### What it does — `b7e-x`\n'), null);
});
check('the name appearing outside a ### heading does not count', () => {
  const p = enroll.readmeProblem('b7e-x', 'See `b7e-x` mentioned in passing here.\n');
  assert.match(p, /no ### section names b7e-x/);
});

/* ===================================================================== *
 * 6 & 7. the DEFAULT_TOOL_LIST / lib/grants.js allowlist pair — b7e-* only
 * ===================================================================== */

console.log('\nthe DEFAULT_TOOL_LIST / lib/grants.js allowlist pair\n');

/*
 * The four cases are bc-khoe.27.11's and they have not changed. What changed in bc-wbrhi
 * is where the answer is read from: both registries now derive their b7e half from the
 * tool's own `@grant` line, so the fixture is a tool's source rather than two registries'
 * source text, and the classification is the map rather than a string to grep.
 *
 * The fourth case is the one worth reading twice. It used to be established by the bare
 * name appearing *anywhere* in the array's comments, which could not tell a decision from
 * a mention — a tool named in passing inside somebody else's paragraph read as settled.
 * `@grant excluded` is a thing somebody had to write about this tool.
 */
const DECLARED_READ = '#!/usr/bin/env node\n/**\n * Does a thing.\n *\n * @grant read\n */\n';
const DECLARED_EXCLUDED = '#!/usr/bin/env node\n/**\n * Does a thing.\n *\n * @grant excluded\n */\n';
const DECLARED_NOTHING = '#!/usr/bin/env node\n/**\n * Does a thing, and nobody has decided about it.\n */\n';
const CLASSIFIED = { 'Bash(b7e-x:*)': { kind: 'read' } };

check("granted and classified — this is bc-khoe.27.11's acceptance case 3, silent", () => {
  assert.equal(enroll.allowlistProblem('b7e-x', DECLARED_READ, CLASSIFIED), null);
});
check('granted and unclassified — exact wording from the bead', () => {
  const p = enroll.allowlistProblem('b7e-x', DECLARED_READ, { 'Bash(b7e-other:*)': { kind: 'read' } });
  assert.equal(p, 'lib/grants.js: Bash(b7e-x:*) is on DEFAULT_TOOL_LIST and unclassified (test/grants.mjs)');
});
check('not granted, but the tool records why not — silent (acceptance case 3)', () => {
  assert.equal(enroll.allowlistProblem('b7e-x', DECLARED_EXCLUDED, {}), null);
});
check('not granted, and nothing says why — named', () => {
  const p = enroll.allowlistProblem('b7e-x', DECLARED_NOTHING, {});
  assert.match(p, /no @grant line in its header/);
});
check('and a mention of the marker in prose is not a declaration', () => {
  // lib/tooldecl.js is 582 lines of the tools arguing about each other and it quotes the
  // marker while doing it. A paragraph saying what to write must not read as having
  // written it — which is the same class of mistake the old comment-scan made, and the
  // reason this case is pinned rather than left to the parser's good sense.
  const prose = '#!/usr/bin/env node\n/**\n * Say `@grant read` in the header, beside the reason.\n */\n';
  assert.match(enroll.allowlistProblem('b7e-x', prose, {}), /no @grant line in its header/);
});

/* ===================================================================== *
 * problemsFor: the b7e-* scoping
 * ===================================================================== */

console.log('\nproblemsFor scopes the five b7e-only checks correctly\n');

{
  const root = path.join(tmp, 'ctxroot');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const ctx = {
    root,
    pkg: { bin: {} },
    lock: { packages: { '': { bin: {} } } },
    readmeSrc: '',
    // No registry text any more — `grants` is the classification map, and the allowlist
    // answer comes from the tool's own file, which for a name with nothing in `bin/`
    // reads as no declaration at all. bc-wbrhi.
    grants: {},
    testDir: fs.mkdtempSync(path.join(tmp, 'emptytest-')),
  };

  check('an unregistered non-b7e- name owes only package.json — the other five do not apply', () => {
    const problems = enroll.problemsFor('block', ctx);
    assert.deepEqual(problems, ['package.json: no "bin" entry for block — add "block": "bin/block"']);
  });
  check('an unregistered b7e-* name owes five distinct findings — package-lock.json defers to package.json', () => {
    // packageLockProblem is silent when package.json has no entry yet — nothing to
    // compare the lock against, and packageJsonProblem already names that gap, so
    // reporting the lock too would be the same debt twice rather than a seventh one.
    const problems = enroll.problemsFor('b7e-z', ctx);
    assert.equal(problems.length, 5, problems.join('\n'));
    assert.ok(problems.some((p) => p.startsWith('package.json:')));
    assert.ok(problems.some((p) => p.startsWith('bin/b7e-z:')));
    assert.ok(problems.some((p) => p.startsWith('test/:')));
    assert.ok(problems.some((p) => p.startsWith('README.md:')));
    // Matched on what it says rather than on its prefix: since bc-wbrhi the allowlist
    // finding names the tool's own file, which is the same prefix `binFileProblem` uses,
    // so a `startsWith` here would be satisfied by that one and stop being a fifth claim.
    assert.ok(problems.some((p) => /no @grant line in its header/.test(p)));
  });
  check('once package.json is registered too, package-lock.json is checked independently — the sixth', () => {
    const registeredCtx = { ...ctx, pkg: { bin: { 'b7e-z': 'bin/b7e-z' } } };
    const problems = enroll.problemsFor('b7e-z', registeredCtx);
    assert.ok(
      problems.some((p) => p.startsWith('package-lock.json packages[""].bin: no b7e-z')),
      problems.join('\n')
    );
  });
}

await cleanupTmp(tmp);

/* ===================================================================== *
 * end to end, against this repo's own tree
 * ===================================================================== */

console.log('\nend to end, against this repo\n');

{
  const r = spawnSync(process.execPath, [BIN], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  check('exits 0 (nothing owed) or 1 (something is) — never a crash', () =>
    assert.ok(r.status === 0 || r.status === 1, `status ${r.status}\n${r.stderr}`)
  );
  const lines = r.stdout.split('\n').filter(Boolean);
  check('every line names one of the checks this file checks', () =>
    assert.ok(
      lines.every((l) =>
        /^\S+: (package\.json:|package-lock\.json |bin\/\S+:|test\/:|README\.md:|lib\/toolbelt\.js:|lib\/grants\.js:)/.test(
          l
        )
      ),
      lines.join('\n')
    )
  );
  // b7e-enroll registers itself in every registry this tool checks (bc-khoe.27.11 did
  // not want to ship the exact gap it exists to catch), so it should never appear.
  check('b7e-enroll does not name itself', () => assert.ok(!lines.some((l) => l.startsWith('b7e-enroll:')), lines.join('\n')));
  // The acceptance criterion this bead was filed with: `b7e-say` is missing its
  // DEFAULT_TOOL_LIST/grants.js pair. If this goes red because that landed, delete it —
  // it means b7e-enroll did what it was for.
  check('and it finds the known, filed b7e-say allowlist gap', () =>
    // Still the same gap and still the same tool — what moved in bc-wbrhi is where the
    // answer is read from, so the finding now names b7e-say's own file rather than the
    // registry it was absent from. Worth keeping pinned against the live repo: this and
    // b7e-packet are the two tools nobody has decided about, and a migration that had
    // quietly decided for them would show up here as silence.
    assert.ok(
      lines.some((l) => l.startsWith('b7e-say: ') && /no @grant line in its header/.test(l)),
      lines.join('\n')
    )
  );
}

console.log(failures ? `\n${failures} failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
