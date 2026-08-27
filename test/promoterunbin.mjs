#!/usr/bin/env node
/**
 * `beadcause-promoterun` against the real binary — a real tracker, a real driver module.
 *
 * bc-7qo.14. test/promoterun.mjs proves `carry()` itself, against a `bd` that is a plain
 * JS object and a driver that is another one — no CLI in front of either, no `bd` binary,
 * no module ever loaded off disk. That is right for the logic and it cannot prove the
 * *caller* works, because the caller's whole job is arg-parsing, dynamically loading a
 * driver **module** and turning `carry()`'s answer into an exit code — none of which the
 * lib suite exercises. This is that half, in the same shape test/closegatereal.mjs uses
 * for the close gate: a fresh `bd init`, a real epic and a real closed work bead, a real
 * promotion bead with the title and body `lib/promote.js` actually writes, and a driver
 * that is a file on disk, imported by the CLI exactly as it would be in production — never
 * an object handed to it in-process. `beadcause-promoterun` is spawned as a real
 * subprocess throughout; nothing here calls `carry()` directly.
 *
 *     npm test
 *     node test/promoterunbin.mjs
 *
 * Skipped, loudly, where `bd` is not installed — same as test/attribution.mjs and
 * test/closegatereal.mjs. A machine without the tracker cannot answer any of this.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';
import { provisionBdWorkspace } from './helpers/bdtemplate.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'promoterun.js');

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('\nbeadcause-promoterun, against the real bd\n');

const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
if (!bdOnPath) {
  console.log('  — skipped: no `bd` on PATH, so a real promotion bead cannot be carried here');
  console.log('\n0/0 passed\n');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-promoterunbin-'));
const beadsDir = path.join(tmp, '.beads');

// Never through a shell — same reason test/closegatereal.mjs gives: ~/.zshenv rewrites
// BEADS_DIR from the shell's cwd, and this file both closes beads and spawns the real CLI.
const bdEnv = { ...process.env, BEADS_DIR: beadsDir };

// A cached template stands in for `bd init --skip-agents --prefix pr` — see
// test/helpers/bdtemplate.mjs.
const init = provisionBdWorkspace({ prefix: 'pr', destRoot: tmp });
if (!init.ok) {
  console.error(`  FAIL a temp workspace can be made to ask in — ${init.reason}`);
  await cleanupTmp(tmp);
  console.log('\n1/1 failed\n');
  process.exit(1);
}

// `BEADCAUSE_CONFIG_DIR` isolates the config file this CLI reads its workspace list
// from — it does NOT isolate workspace *discovery*, which still walks the real
// `workspaceRoots` default (`~/beads`) alongside whatever `workspaceDirs` names. That is
// fine: discovery only checks a `.beads` directory exists, never runs `bd` against what
// it finds, so every real workspace on this Mac shows up in the list unread and untouched
// — the fixture is reached because `workspaceDirs` names it explicitly, which wins.
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ workspaceDirs: { promoterunbin: beadsDir } }));
const cliEnv = { ...process.env, BEADCAUSE_CONFIG_DIR: configDir };

const { Bd } = await import(path.join(ROOT, 'lib', 'bd.js'));
const bd = new Bd({ bin: 'bd', actor: 'beadcause' });
const ws = { name: 'promoterunbin', dir: beadsDir };

const driverPath = (name, body) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body);
  return p;
};

const PASSING_DRIVER = driverPath(
  'driver.mjs',
  [
    "async function step(name) {",
    "  if (name === 'deployToUat' || name === 'promoteToProd') return { state: 'passed', image: 'sha256:cafebabe' };",
    "  return { state: 'passed', checks: [{ name: 'smoke', state: 'passed' }] };",
    "}",
    "export const deployToUat = () => step('deployToUat');",
    "export const testInUat = () => step('testInUat');",
    "export const promoteToProd = () => step('promoteToProd');",
    "export const testInProd = () => step('testInProd');",
    '',
  ].join('\n')
);

const INCOMPLETE_DRIVER = driverPath('baddriver.mjs', "export const deployToUat = async () => ({ state: 'passed', image: 'x' });\n");

/** A fresh epic with one closed work bead under it, and a promotion bead over it. */
async function fixture({ label, extraLabels = [], repos = 'demo-repo' }) {
  const epic = await bd.create(ws, { title: `${label} — the epic`, type: 'epic', priority: 2, body: 'x', labels: [] });
  const work = await bd.create(ws, { title: `${label} — the work that landed`, type: 'task', priority: 2, body: 'x', parent: epic, labels: [] });
  await bd.close(ws, work, 'done');
  const body = `Every bead under **${epic}** is closed.\n\n**Repos** (one image each): \`${repos}\`\n\n- \`${work}\``;
  const promo = await bd.create(ws, {
    title: `Promote ${epic} — the epic`,
    type: 'task',
    priority: 2,
    body,
    labels: ['promote', ...extraLabels],
  });
  return { epic, work, promo };
}

const cli = (args) =>
  run(process.execPath, [BIN, ...args], { env: cliEnv, cwd: tmp })
    .then((r) => ({ ...r, code: 0 }))
    .catch((err) => err);

/* -------------------------------------------------------------------------- usage */

await check('refuses with no arguments — usage, and it says the driver is not bc-y8k4.3', async () => {
  const r = await cli([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: beadcause-promoterun -w <workspace> -b <promotion bead> --driver/);
  assert.match(r.stderr, /bc-y8k4\.3.*is still open/s, 'and says why there is no default driver to fall back to');
});

await check('refuses an unknown workspace rather than guessing one', async () => {
  const r = await cli(['-w', 'nope', '-b', 'x-1', '--driver', PASSING_DRIVER]);
  assert.equal(r.code, 1);
});

/* --------------------------------------------------------------------- the driver */

await check('a driver module that will not load is refused before the bead is touched', async () => {
  const { promo } = await fixture({ label: 'unreached by a bad driver path' });
  const r = await cli(['-w', 'promoterunbin', '-b', promo, '--driver', path.join(tmp, 'does-not-exist.mjs')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not load driver/);
  const row = await bd.show(ws, promo);
  assert.equal(row.status, 'open', 'never claimed — the load failure is before anything is touched');
});

await check('a driver missing a call is refused, and says which ones', async () => {
  const { promo } = await fixture({ label: 'refused for an incomplete driver' });
  const r = await cli(['-w', 'promoterunbin', '-b', promo, '--driver', INCOMPLETE_DRIVER]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no testInUat, no promoteToProd, no testInProd/);
  const row = await bd.show(ws, promo);
  assert.equal(row.status, 'open', 'assertDriver refuses before the bead is claimed');
});

/* --------------------------------------------------------------------- the refusals */

await check('an unendorsed promotion bead is refused, and never claimed', async () => {
  const { promo } = await fixture({ label: 'still unendorsed', extraLabels: ['unendorsed'] });
  const r = await cli(['-w', 'promoterunbin', '-b', promo, '--driver', PASSING_DRIVER]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /not endorsed/);
  const row = await bd.show(ws, promo);
  assert.equal(row.status, 'open');
  assert.equal(String(row.assignee || '').trim(), '');
});

await check('a bead that is not a promotion bead at all is refused', async () => {
  const plain = await bd.create(ws, { title: 'an ordinary bead', type: 'task', priority: 2, body: 'x', labels: [] });
  const r = await cli(['-w', 'promoterunbin', '-b', plain, '--driver', PASSING_DRIVER]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /is not a promotion bead/);
});

/* ----------------------------------------------------------------------- the real run */

await check('carries a real promotion bead to a verified close, against a driver loaded off disk', async () => {
  const { epic, work, promo } = await fixture({ label: 'the whole way through', repos: 'demo-repo' });
  const r = await cli(['-w', 'promoterunbin', '-b', promo, '--driver', PASSING_DRIVER, '--json']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.bead, promo);
  assert.equal(out.epic, epic);
  assert.equal(out.closed, true);
  assert.equal(out.legs.length, 1);
  assert.equal(out.legs[0].repo, 'demo-repo');
  assert.equal(out.legs[0].verified, true);
  assert.equal(out.legs[0].image, 'sha256:cafebabe');
  assert.deepEqual(out.legs[0].steps.map((s) => s.state), ['passed', 'passed', 'passed', 'passed']);
  assert.deepEqual(out.work.map((b) => b.id), [work]);

  const row = await bd.show(ws, promo);
  assert.equal(row.status, 'closed');
  assert.match(row.notes || row.close_reason || '', /./, 'a close reason exists, whatever field bd surfaces it under');
  const comments = await bd.comments(ws, promo);
  assert.equal(comments.length, 1);
  assert.match(comments.at(-1).text ?? comments.at(-1).body ?? '', /Promotion run/);
  assert.match(comments.at(-1).text ?? comments.at(-1).body ?? '', /beadcause:promotion/, 'the ledger is on the bead, for the next run to read');
});

await check('the non-JSON path prints the same record `carry` wrote to the bead', async () => {
  const { promo } = await fixture({ label: 'printed without --json' });
  const r = await cli(['-w', 'promoterunbin', '-b', promo, '--driver', PASSING_DRIVER]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Promotion run/);
  assert.match(r.stdout, new RegExp(`Production is verified, so ${promo} is closed\\.`));
});

await cleanupTmp(tmp);

console.log(failures ? `\n${ran - failures}/${ran} passed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
