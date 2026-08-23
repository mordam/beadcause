#!/usr/bin/env node
/**
 * `b7e-sandbox` (bc-zjab.6) — a disposable beadcause install and `bd` tracker, and the
 * one thing it must never do: reach the real one.
 *
 *     npm test
 *     node test/sandbox.mjs
 *
 * Four sessions (bc-zjab.1, bc-y3qk.1, bc-bmry.4, bc-bmry.3) each built a throwaway
 * `BEADCAUSE_CONFIG_DIR` and a `bd` workspace by hand; bc-bmry.4 ran its new binary twice
 * against the *live* tracker on its own bead and then wiped its notes clearing up. The
 * acceptance line this suite is built around is the same one that incident is the
 * argument for: nothing is written under `~/.config/beadcause` or `~/beads`, whatever
 * `HOME` happens to resolve to when the command runs — checked here with a subprocess
 * whose `HOME` is a fixture this file controls, rather than trusted from inside the
 * process that is supposed to be avoiding it.
 *
 * `--bd real` is skipped, loudly, where `bd` is not installed — same reasoning and same
 * shape as test/closegatereal.mjs and test/attribution.mjs: a machine without the
 * tracker cannot answer the question, and failing here would say something untrue about
 * the code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-sandbox');
const PLAN_BIN = path.join(ROOT, 'bin', 'plan.js');

const { createSandbox, sandboxRoot, findRealBd } = await import(path.join(ROOT, 'lib', 'sandbox.js'));

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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\nb7e-sandbox\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sandbox-test-'));
const seedPath = path.join(scratch, 'seed.yaml');
fs.writeFileSync(
  seedPath,
  [
    'beads:',
    '  - ref: epic',
    '    title: sandbox test epic',
    '    type: epic',
    '  - ref: g1',
    '    title: first group bead',
    '    parent: epic',
    '  - ref: g2',
    '    title: second group bead',
    '    parent: epic',
  ].join('\n')
);
const planPath = path.join(scratch, 'plan.yaml');
fs.writeFileSync(
  planPath,
  [
    'groups:',
    '  - name: only-group',
    '    beads: [zz-1.1, zz-1.2]',
    '    prs:',
    '      - repo: beadcause',
    '        title: sandbox smoke plan',
    '    prompt: |',
    '      Sandbox smoke plan for test/sandbox.mjs.',
  ].join('\n')
);

/* -------------------------------------------------------------------------- fake mode */

{
  const result = createSandbox({ name: 'suite-fake', bdMode: 'fake', workspaces: [{ name: 'alpha' }], seedPath });

  check(() => assert.equal(result.dir, path.join(sandboxRoot(), 'suite-fake')), 'the sandbox dir is named for --name, under sandboxRoot()');
  check(() => assert.ok(fs.existsSync(result.configDir)), 'the config dir exists');
  check(() => assert.ok(fs.existsSync(result.workspaces[0].dir)), "the workspace's tracker dir exists");
  check(() => assert.ok(fs.existsSync(result.workspaces[0].checkoutDir)), "the workspace's checkout dir exists, unpinned and empty");
  check(
    () => assert.equal(result.env, `BEADCAUSE_CONFIG_DIR=${result.configDir} BEADS_DIR=${result.workspaces[0].dir}`),
    'the printed env prefix names both variables, in that order'
  );

  const cfg = JSON.parse(fs.readFileSync(path.join(result.configDir, 'config.json'), 'utf8'));
  check(() => assert.deepEqual(cfg.workspaces, []), 'the written config starts `workspaces: []` — the real machine\'s list must never leak in through defaults()');
  check(() => assert.deepEqual(cfg.workspaceDirs, { alpha: result.workspaces[0].dir }), 'workspaceDirs names only the fixture workspace');
  check(
    () => assert.ok(!fs.existsSync(cfg.workspaceRoots[0])),
    'workspaceRoots points at a path that does not exist, so discovery finds nothing under it'
  );

  check(() => assert.equal(result.seeded.length, 3), 'seeding created three beads');
  const [epic, g1, g2] = result.seeded;
  check(() => assert.equal(epic.id, 'zz-1'), 'the first top-level seed bead is zz-1 — this repo\'s own dotted convention');
  check(() => assert.equal(g1.id, 'zz-1.1'), 'a bead seeded with parent: epic becomes zz-1.1');
  check(() => assert.equal(g2.id, 'zz-1.2'), 'and the next one under the same parent becomes zz-1.2');

  const store = JSON.parse(fs.readFileSync(path.join(result.workspaces[0].dir, 'store.json'), 'utf8'));
  check(() => assert.equal(store.beads['zz-1.1'].parent, 'zz-1'), "the child's own record carries its parent");
  check(() => assert.equal(store.beads['zz-1'].title, 'sandbox test epic'), 'the epic record carries the seeded title');
}

/* --------------------------------------------------------- fake bd answers `bd show` */

{
  const result = createSandbox({ name: 'suite-fakebd', bdMode: 'fake', workspaces: [{ name: 'alpha' }], seedPath });
  const bdBin = result.bdBin;
  const env = { ...process.env, BEADS_DIR: result.workspaces[0].dir };
  const show = spawnSync(bdBin, ['show', 'zz-1', '--json'], { env, encoding: 'utf8' });
  check(() => assert.equal(show.status, 0), 'the fake bd answers `show <seeded-id> --json` with exit 0');
  check(() => assert.equal(JSON.parse(show.stdout)[0]?.title, 'sandbox test epic'), 'and the row it returns carries the seeded title');

  const missing = spawnSync(bdBin, ['show', 'zz-999', '--json'], { env, encoding: 'utf8' });
  check(() => assert.notEqual(missing.status, 0), 'the fake bd refuses an unknown id, same as the real one');

  const list = spawnSync(bdBin, ['list', '--parent', 'zz-1', '--all', '--limit', '0', '--json'], { env, encoding: 'utf8' });
  check(() => assert.equal(JSON.parse(list.stdout).length, 2), '`list --parent` answers both children');
}

/* -------------------------------------------------------------- torn down, or kept */

{
  const first = createSandbox({ name: 'suite-rerun', bdMode: 'fake', workspaces: [{ name: 'alpha' }], seedPath });
  check(() => assert.equal(first.seeded.length, 3), 'the first run seeded three beads');

  const second = createSandbox({ name: 'suite-rerun', bdMode: 'fake', workspaces: [{ name: 'alpha' }] });
  check(() => assert.equal(second.seeded.length, 0), 'a second run of the same --name with no --seed starts clean, not carrying the first run\'s beads');
  const store = JSON.parse(fs.readFileSync(path.join(second.workspaces[0].dir, 'store.json'), 'utf8'));
  check(() => assert.deepEqual(store.beads, {}), 'and the tracker itself was torn down, not merely re-labelled');
}

{
  createSandbox({ name: 'suite-kept', bdMode: 'fake', workspaces: [{ name: 'alpha' }], keep: true });
  check(
    () => assert.throws(() => createSandbox({ name: 'suite-kept', bdMode: 'fake', workspaces: [{ name: 'alpha' }] }), /kept by a previous run/),
    '--keep makes a later same-name run refuse rather than delete it'
  );
}

/* --------------------------------------------------- bin/plan.js, end to end (fake) */

{
  const result = createSandbox({ name: 'suite-plan', bdMode: 'fake', workspaces: [{ name: 'alpha' }], seedPath });
  const env = { ...process.env, BEADCAUSE_CONFIG_DIR: result.configDir, BEADS_DIR: result.workspaces[0].dir };
  const run = spawnSync('node', [PLAN_BIN, '-w', 'alpha', '-b', 'zz-1', '-f', planPath], { env, encoding: 'utf8' });
  check(() => assert.equal(run.status, 0, `stderr: ${run.stderr}`), 'bin/plan.js runs to completion against the seeded sandbox, from one env prefix');
  check(() => assert.match(run.stdout, /planned zz-1/), 'and its own success line names the epic it planned');

  const cfg = JSON.parse(fs.readFileSync(path.join(result.configDir, 'config.json'), 'utf8'));
  check(
    () => assert.deepEqual(Object.keys(cfg.workspaceDirs), ['alpha']),
    "after bin/plan.js has run, the sandbox's own config still names only the fixture workspace — nothing this machine's real ~/beads holds leaked in"
  );
}

/* ------------------------------------------------------------------------ containment */

{
  const fakeHome = fs.mkdtempSync(path.join(scratch, 'fake-home-'));
  const env = { ...process.env, HOME: fakeHome };
  delete env.BEADCAUSE_CONFIG_DIR;
  const run = spawnSync('node', [BIN, '--name', 'suite-home', '--workspace', 'alpha', '--seed', seedPath, '--json'], {
    env,
    encoding: 'utf8',
  });
  check(() => assert.equal(run.status, 0, `stderr: ${run.stderr}`), 'the CLI runs with HOME pointed at an empty fixture directory');
  check(
    () => assert.deepEqual(fs.readdirSync(fakeHome), []),
    'and writes nothing at all under that HOME — not `.config/beadcause`, not `beads`, nothing'
  );

  let printed;
  check(() => {
    printed = JSON.parse(run.stdout);
  }, 'and still prints a well-formed result');
  check(() => assert.ok(!printed.dir.startsWith(fakeHome)), "the sandbox it built lives under os.tmpdir(), not under the HOME it was run with");
}

/* ---------------------------------------------------------------------- the CLI itself */

{
  const help = spawnSync('node', [BIN, '--help'], { encoding: 'utf8' });
  check(() => assert.equal(help.status, 0), '--help exits 0');
  check(() => assert.match(help.stdout, /usage: b7e-sandbox/), 'and prints a usage line');

  const bad1 = spawnSync('node', [BIN, '--nonsense'], { encoding: 'utf8' });
  check(() => assert.notEqual(bad1.status, 0), 'an unrecognised flag is refused rather than ignored');

  const badMode = spawnSync('node', [BIN, '--name', 'suite-badmode', '--bd', 'sideways'], { encoding: 'utf8' });
  check(() => assert.notEqual(badMode.status, 0), '--bd anything but fake/real is refused');

  const dupe = spawnSync('node', [BIN, '--name', 'suite-dupe', '--workspace', 'x', '--workspace', 'x'], { encoding: 'utf8' });
  check(() => assert.notEqual(dupe.status, 0), 'the same --workspace name given twice is refused');
}

/* ------------------------------------------------------------------- --bd real, or skipped */

const realBd = findRealBd();
if (!realBd) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so --bd real cannot be exercised here');
} else {
  const version = spawnSync(realBd, ['version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    console.log('  \x1b[33m—\x1b[0m skipped: `bd` is on PATH but would not run');
  } else {
    const result = createSandbox({ name: 'suite-real', bdMode: 'real', workspaces: [{ name: 'beta' }], seedPath });
    check(() => assert.equal(result.bdMode, 'real'), 'a real sandbox reports bdMode: real');
    check(() => assert.equal(result.bdBin, realBd), 'and hands back the real bd path it found');
    check(() => assert.equal(result.seeded.length, 3), 'seeding through the real binary still created three beads');

    const epicId = result.seeded[0].id;
    const env = { ...process.env, BEADS_DIR: result.workspaces[0].dir };
    const show = spawnSync(realBd, ['show', epicId, '--json'], { env, encoding: 'utf8', timeout: 30000 });
    check(() => assert.equal(show.status, 0, `stderr: ${show.stderr}`), '--bd real: the real `bd show --json` answers about the seeded epic');
    check(
      () => assert.equal(JSON.parse(show.stdout)[0]?.title, 'sandbox test epic'),
      'and the row it returns carries the seeded title, from the real tracker'
    );

    check(
      () => assert.ok(!result.workspaces[0].dir.startsWith(path.join(os.homedir(), 'beads'))),
      '--bd real still lives under os.tmpdir(), never under ~/beads'
    );
  }
}

/* ------------------------------------------------------------------------ bad input */

check(() => assert.throws(() => createSandbox({ name: '', workspaces: [{ name: 'a' }] })), 'createSandbox refuses an empty --name');
check(() => assert.throws(() => createSandbox({ name: 'x', bdMode: 'sideways', workspaces: [{ name: 'a' }] })), 'createSandbox refuses a bad --bd value');
check(() => assert.throws(() => createSandbox({ name: 'x', workspaces: [] })), 'createSandbox refuses zero workspaces');
check(
  () => assert.throws(() => createSandbox({ name: 'x', workspaces: [{ name: 'a', checkoutDir: path.join(scratch, 'no-such-dir') }] })),
  'createSandbox refuses a --workspace=<dir> that does not exist'
);

// Only the `suite-*` sandboxes this run itself created — never the whole of
// `sandboxRoot()`, which this machine's real, concurrent use of the same command also
// shares. `npm test` gives this process its own `$TMPDIR` (scripts/test.mjs, bc-5isv),
// so this is belt and suspenders rather than the only thing standing between this file
// and somebody else's fixture; run directly (`node test/sandbox.mjs`, no `$TMPDIR`
// override) it is the only thing.
for (const entry of fs.existsSync(sandboxRoot()) ? fs.readdirSync(sandboxRoot()) : []) {
  if (entry.startsWith('suite-')) fs.rmSync(path.join(sandboxRoot(), entry), { recursive: true, force: true });
}
fs.rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
