#!/usr/bin/env node
/**
 * The second engineer's install, for real: a bead pushed on one machine, read on the other.
 *
 *     npm test
 *     node test/onboard.mjs
 *
 * bc-146r. test/team.mjs pins the arithmetic — which states are refused, what the profile
 * may carry — with no `bd` anywhere near it. This is the other half, and it is the half
 * that answers the bead's acceptance criterion literally: *a second engineer with a clone
 * and the prerequisites ends up with a working beadcause pointed at the team's tracker.*
 * Nothing but the real thing can say that. The claim is about what `bd bootstrap` does with
 * a `sync.remote` somebody wrote into a `config.yaml`, and a stub of `bd` can only ever
 * confirm what this repo already believes about it — which, measured while writing this,
 * was wrong twice.
 *
 * **A `file://` Dolt remote is what makes it possible without a second Mac.** `bd dolt
 * remote add origin file:///…` is accepted, `bd dolt push` writes a real Dolt remote into
 * a directory, and `bd bootstrap` clones from it — so the whole two-machine story fits in
 * one `mkdtemp`: a *publisher* workspace stands in for the first engineer's Mac, and a
 * second workspace that does not exist yet stands in for the new one.
 *
 * Three things it proves, and the last is the reason the suite is worth its runtime:
 *
 * 1. **The bead arrives.** Created in the publisher, pushed, and read out of the second
 *    workspace after nothing but `npm run onboard` — no `bd init`, no `bd dolt remote add`
 *    typed by anybody, no instruction that is not in the README.
 * 2. **A second run is a no-op.** The first version of this script re-planned a bootstrap
 *    every time, because `bd bootstrap --dry-run --json` reports `has_existing: false` on
 *    a workspace whose database exists whenever `sync.remote` is configured — so a
 *    finished install printed `can't create database beads; database exists` as a warning.
 *    That is the trap in this whole feature, and it is invisible to any test with a fake.
 * 3. **A private tracker in the way stops the install.** Exit 1, and nothing cloned. That
 *    is the state a second engineer reaches by running `bd init` first, and letting it
 *    through hands them a Dolt conflict on every sync tick for as long as it stands.
 *
 * `bd` is slow enough that this is one of the heavier suites here — a clone, a push and a
 * handful of reads. It skips loudly rather than silently when `bd` is missing, in the shape
 * test/closegatereal.mjs established, because a suite that passes by doing nothing is worse
 * than one that is not there.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { removeTreeSync } from './helpers/tmp.mjs';
import { provisionBdWorkspace } from './helpers/bdtemplate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

console.log("a second engineer's install");

/* ------------------------------------------------------------------ is bd here? */

const version = spawnSync('bd', ['version'], { encoding: 'utf8', timeout: 30_000 });
if (version.status !== 0) {
  console.log(`  \x1b[33m•\x1b[0m SKIPPED — no \`bd\` on PATH, and this suite is only about what bd really does.`);
  console.log(`      Every other claim about the profile is in test/team.mjs, which needs nothing.`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-onboard-'));
// Sync, inside the exit handler — see test/tmpadoption.mjs: a bare recursive rmSync of a
// tree that holds a BEADCAUSE_CONFIG_DIR races the commit a config write schedules.
process.on('exit', () => removeTreeSync(tmp));

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(err.message).split('\n')[0]}`);
  }
};

/**
 * `bd`, never through a shell — `~/.zshenv` rewrites `BEADS_DIR` from the shell's working
 * directory, and this suite creates and clones databases. Same rule as
 * test/closegatereal.mjs, and for a sharper reason here.
 */
function bd(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('bd', args, {
    cwd,
    env: { ...process.env, BEADS_DIR: path.join(cwd, '.beads'), BEADS_ACTOR: 'test' },
    encoding: 'utf8',
    timeout: 240_000,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`bd ${args.join(' ')} in ${cwd} exited ${r.status}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r;
}

/**
 * A cached template stands in for `bd(cwd, ['init', '--skip-agents', '--prefix',
 * prefix])` — see test/helpers/bdtemplate.mjs. This suite needs two independent
 * workspaces (`tm`, the published tracker; `zz`, an unrelated one already in the way),
 * so it is templated per prefix like every other real-bd suite.
 */
function initWorkspace(cwd, prefix) {
  const r = provisionBdWorkspace({ prefix, destRoot: cwd });
  if (!r.ok) throw new Error(`bd init --prefix ${prefix} in ${cwd}: ${r.reason}`);
}

/** The real script, with its own profile and its own config directory. */
function onboard(teamFile, configDir, args = []) {
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'onboard.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, BEADCAUSE_TEAM_FILE: teamFile, BEADCAUSE_CONFIG_DIR: configDir },
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const writeTeam = (file, trackers, policy) => {
  fs.writeFileSync(file, JSON.stringify({ trackers, policy }, null, 2));
  return file;
};

/* ------------------------------------------------- the first engineer's machine */

const publisher = path.join(tmp, 'publisher');
const remote = path.join(tmp, 'remote');
fs.mkdirSync(path.join(publisher, '.beads'), { recursive: true, mode: 0o700 });
fs.mkdirSync(remote, { recursive: true });

initWorkspace(publisher, 'tm');
const created = bd(publisher, ['create', '--title', 'the bead the team can see', '--type', 'task', '-p', '2']);
const id = (created.stdout.match(/\b(tm-[a-z0-9]+)\b/) || [])[1];
bd(publisher, ['dolt', 'remote', 'add', 'origin', `file://${remote}`]);
bd(publisher, ['dolt', 'push']);

check('the publisher pushed a bead to a Dolt remote', () => {
  assert.ok(id, 'no issue id came back from bd create');
  assert.ok(fs.readdirSync(remote).includes('manifest'), 'the remote directory holds no Dolt manifest');
});

/* ------------------------------------------------- the second engineer's machine */

const secondDir = path.join(tmp, 'second', 'beads', 'acme');
const teamFile = writeTeam(path.join(tmp, 'team.json'), [
  { workspace: 'acme', dir: secondDir, remote: `file://${remote}` },
]);
const configDir = path.join(tmp, 'config-second');

{
  const r = onboard(teamFile, configDir, ['--dry-run']);
  check('a dry run says what it would do, and does none of it', () => {
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not on this Mac yet/);
    assert.match(r.out, /would/);
    assert.equal(fs.existsSync(secondDir), false, 'the dry run created the workspace');
  });
}

{
  const r = onboard(teamFile, configDir);
  check('the real run bootstraps the workspace from the remote', () => {
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(path.join(secondDir, '.beads', 'config.yaml')));
  });

  check('and the bead the other machine created is here, with nothing else typed', () => {
    const rows = JSON.parse(bd(secondDir, ['list', '--json']).stdout);
    assert.ok(
      rows.some((row) => row.id === id),
      `${id} is not in the second workspace: ${JSON.stringify(rows.map((x) => x.id))}`
    );
  });

  check('the shared-workspace policy was written without anybody being asked', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.deepEqual(cfg.autoDispatchExclude, ['acme']);
    assert.deepEqual(cfg.ntfy.minimalWorkspaces, ['acme']);
    assert.equal(cfg.autoEndorsePerWorkspace.acme, false);
  });

  check('and the per-machine half is still this machine\'s own', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    // Generated here, not carried in the profile — which is what makes six installs six
    // people rather than six copies of one.
    assert.match(cfg.ntfy.topic, /^beadcause-/);
    assert.ok(cfg.token && cfg.token.length > 8);
    assert.equal(cfg.me ?? null, null, 'a profile must not be able to say who this Mac is');
  });
}

{
  const r = onboard(teamFile, configDir);
  check('a second run is a no-op — the trap this suite exists for', () => {
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /in place, wired to/);
    assert.match(r.out, /nothing to do/);
    assert.doesNotMatch(r.out, /database exists/, 'it re-planned a bootstrap over the database it just cloned');
  });
}

/* --------------------------------------------- a private tracker in the way */

const inTheWay = path.join(tmp, 'inTheWay', 'beads', 'acme');
fs.mkdirSync(path.join(inTheWay, '.beads'), { recursive: true, mode: 0o700 });
initWorkspace(inTheWay, 'zz');
bd(inTheWay, ['create', '--title', 'a bead of my own', '--type', 'task', '-p', '2']);

{
  const teamTwo = writeTeam(path.join(tmp, 'team-two.json'), [
    { workspace: 'acme', dir: inTheWay, remote: `file://${remote}` },
  ]);
  const r = onboard(teamTwo, path.join(tmp, 'config-inTheWay'));
  check('a local tracker where the team\'s goes stops the install, at exit 1', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /unrelated histories/);
  });

  check('and nothing was cloned over it', () => {
    // The local bead is still the only one there, and no remote was written into its
    // config.yaml — the two ways this could have quietly gone wrong.
    const rows = JSON.parse(bd(inTheWay, ['list', '--json']).stdout);
    assert.equal(rows.length, 1, `${rows.length} beads in a workspace that had one`);
    const yaml = fs.readFileSync(path.join(inTheWay, '.beads', 'config.yaml'), 'utf8');
    assert.doesNotMatch(yaml, /remote:/, 'a remote was written into a workspace we refused to touch');
  });
}

/* ------------------------------------------------------ and with no profile at all */

{
  const r = onboard(path.join(tmp, 'no-such-team.json'), path.join(tmp, 'config-solo'));
  check('with no team.json it says one line and exits 0 — every solo install', () => {
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /no .*team\.json/);
    assert.doesNotMatch(r.out, /refused/);
  });
}

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} good\x1b[0m`}`);
process.exit(failures ? 1 : 0);
