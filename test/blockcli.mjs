#!/usr/bin/env node
/**
 * `beadcause-block` — the command a worker runs to record a cross-tracker blocker.
 *
 *     npm test
 *     node test/blockcli.mjs
 *
 * test/farblock.mjs drives `mark` directly. Neither that nor the advocate sweep ever
 * touches the CLI, and the CLI is the only part of this a worker ever runs — the brief
 * would print one command, and everything the marker guarantees depends on that command
 * doing what it says. So this spawns `bin/block.js` against a fake `bd` in a temp
 * workspace and reads the tracker afterwards, the same shape test/supersedecli.mjs uses
 * for its sibling.
 *
 * Two workspaces, `demo` and `other`, each with its own `world.json` under its own
 * `BEADS_DIR` — the fake `bd` reads `process.env.BEADS_DIR` rather than a path baked in
 * at script-creation time, because `--on other/zz-far` from `-w demo` never touches
 * `other`'s tracker at all: the whole point of this marker is that it is written with
 * *no read* of the far side, only the whitelist check that its name is one this install
 * actually has.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-blockcli-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const FAKE_BD = path.join(tmp, 'bd');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2).filter((a, i, all) => a !== '--actor' && all[i - 1] !== '--actor');
const WORLD = path.join(process.env.BEADS_DIR, 'world.json');
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
w.calls.push(args.join(' '));
save();
for (const [match, message] of Object.entries(w.refuse || {})) {
  if (args.join(' ').includes(match)) die(message);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'add') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.labels = [...(issue.labels || []), args[3]];
  save();
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (args.includes('--status=open')) issue.status = 'open';
  save();
  process.exit(0);
}
if (args[0] === 'comment') {
  (w.comments[args[1]] = w.comments[args[1]] || []).push(args[2]);
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
// `other` exists only in cfg.workspaces — never as a directory this CLI reads from — to
// prove the mechanism never spawns a `bd` against it.
const otherDir = path.join(tmp, 'other', '.beads');
fs.mkdirSync(otherDir, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify(
    {
      bdBin: FAKE_BD,
      actor: 'beadcause-test',
      workspaces: [
        { name: 'demo', dir: wsDir },
        { name: 'other', dir: otherDir },
      ],
    },
    null,
    2
  )
);

const worldFile = (dir) => path.join(dir, 'world.json');
const issue = (id, extra = {}) => ({ id, title: `bead ${id}`, status: 'open', issue_type: 'task', labels: [], ...extra });
const reset = (refuse = {}) =>
  fs.writeFileSync(
    worldFile(wsDir),
    JSON.stringify(
      { calls: [], comments: {}, refuse, issues: { 'zz-work': issue('zz-work', { status: 'in_progress' }), 'zz-closed': issue('zz-closed', { status: 'closed' }) } },
      null,
      2
    )
  );

const world = () => JSON.parse(fs.readFileSync(worldFile(wsDir), 'utf8'));

/** The command, run exactly as a worker brief would print it: the reason on stdin. */
const block = (args, input = 'BLOCKED ON the charter amendment landing on the dv side.\n') => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'block.js'), '-w', 'demo', ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
};

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

console.log('\nthe command a worker runs to mark a cross-tracker block\n');

check('an ordinary target: the label, the comment, and the status back to open — no dep call at all', () => {
  reset();
  const { status, out } = block(['-b', 'zz-work', '--on', 'other/zz-far']);
  assert.equal(status, 0, out);
  const w = world();
  assert.deepEqual(w.issues['zz-work'].labels, ['blocked-by:other/zz-far']);
  assert.equal(w.issues['zz-work'].status, 'open', 'a bead left in_progress is invisible to the sweep forever');
  assert.equal(w.calls.some((c) => c.startsWith('dep')), false, 'no tracker spans both, so no edge is ever attempted');
  assert.match(w.comments['zz-work'][0], /Blocked on other\/zz-far — BLOCKED ON the charter amendment/);
  assert.match(out, /marked zz-work blocked-by:other\/zz-far/);
});

check('a bare id is refused before writing anything — this marker is cross-workspace only', () => {
  reset();
  const { status, err } = block(['-b', 'zz-work', '--on', 'dv-265']);
  assert.notEqual(status, 0);
  assert.match(err, /is not <workspace>\/<id>/);
  assert.deepEqual(world().calls, []);
});

check('an unknown workspace is refused before writing anything', () => {
  reset();
  const { status, err } = block(['-b', 'zz-work', '--on', 'sophab/sp-40x']);
  assert.notEqual(status, 0);
  assert.match(err, /sophab is not a workspace/);
  assert.deepEqual(world().calls, []);
});

check('a closed bead is refused — there is nothing left to hold', () => {
  reset();
  const { status, err } = block(['-b', 'zz-closed', '--on', 'other/zz-far']);
  assert.notEqual(status, 0);
  assert.match(err, /already closed/);
});

check('no body on stdin is refused before anything is written', () => {
  reset();
  const { status, err } = block(['-b', 'zz-work', '--on', 'other/zz-far'], '');
  assert.notEqual(status, 0);
  assert.match(err, /pipe in why/);
  assert.deepEqual(world().calls, []);
});

check('marking the same pair twice is a no-op that still exits zero', () => {
  reset();
  assert.equal(block(['-b', 'zz-work', '--on', 'other/zz-far']).status, 0);
  const { status, out } = block(['-b', 'zz-work', '--on', 'other/zz-far']);
  assert.equal(status, 0, out);
  assert.match(out, /already marked/);
  assert.equal(world().issues['zz-work'].labels.length, 1, 'no second label');
});

check('a comment that does not land still exits zero — the marker is what matters', () => {
  reset({ comment: 'Error: dolt is busy' });
  const { status, out, err } = block(['-b', 'zz-work', '--on', 'other/zz-far']);
  assert.equal(status, 0, out);
  assert.match(err, /did not land/);
  assert.deepEqual(world().issues['zz-work'].labels, ['blocked-by:other/zz-far'], 'the marker still landed');
});

console.log(`\n${ran - failures}/${ran} passed`);
cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
