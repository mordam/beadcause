#!/usr/bin/env node
/**
 * `b7e-handback` — end a run that delivered nothing, and put the bead back the one way
 * the next tick expects. lib/handback.js and bin/b7e-handback.
 *
 *     npm test
 *     node test/b7ehandback.mjs
 *
 * bc-dgx7.34's own acceptance criteria are what this replays: comment, then open and
 * unassigned (`Bd.reopenAbandoned`, forced only when the plain write is refused for
 * holding a claim it never had), `--human` refused on a bead that is not type
 * `decision`, the note crossing as a file rather than a shell argument, and a readback
 * that disagrees ending the run non-zero rather than printed over. Same shape as
 * test/blockcli.mjs: a fake `bd` reading a small mutable `world.json`, spawned for real
 * through `bin/b7e-handback`, because the CLI's own argv handling is the one part of
 * this a worker actually runs.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ehandback-'));
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
  if (w.reassignGuard && !args.includes('--force')) {
    die('cannot reassign ' + args[1] + ': held by "someone@example.com" (in_progress); coordinate with the holder (bd mail someone@example.com) — pass --force only if their claim is abandoned (crashed agent, expired lease), or use bd reclaim');
  }
  if (!w.noopUpdate) {
    const si = args.indexOf('--status');
    if (si > -1) issue.status = args[si + 1];
    const ai = args.indexOf('--assignee');
    if (ai > -1) issue.assignee = args[ai + 1];
    save();
  }
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
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify(
    {
      bdBin: FAKE_BD,
      actor: 'beadcause-test',
      workspaces: [{ name: 'demo', dir: wsDir }],
    },
    null,
    2
  )
);

const worldFile = path.join(wsDir, 'world.json');
const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  status: 'in_progress',
  issue_type: 'task',
  assignee: 'beadcause-test',
  labels: [],
  ...extra,
});
const reset = (extra = {}) =>
  fs.writeFileSync(
    worldFile,
    JSON.stringify(
      {
        calls: [],
        comments: {},
        refuse: {},
        issues: {
          'zz-work': issue('zz-work'),
          'zz-decision': issue('zz-decision', { issue_type: 'decision' }),
          'zz-closed': issue('zz-closed', { status: 'closed', assignee: '' }),
        },
        ...extra,
      },
      null,
      2
    )
  );

const world = () => JSON.parse(fs.readFileSync(worldFile, 'utf8'));

const noteFile = path.join(tmp, 'note.md');
fs.writeFileSync(noteFile, 'Out of time; harness half written, CLI half is not.\n');

/** The command, run exactly as a worker brief would print it. */
const handback = (args) => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'b7e-handback'), '-w', 'demo', ...args], {
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

console.log('\nb7e-handback — end a run that delivered nothing\n');

check('an ordinary handback: comment, open, unassigned, read back and confirmed', () => {
  reset();
  const { status, out } = handback(['-b', 'zz-work', '--note', noteFile]);
  assert.equal(status, 0, out);
  const w = world();
  assert.equal(w.issues['zz-work'].status, 'open');
  assert.equal(w.issues['zz-work'].assignee, '', 'reopenAbandoned clears the assignee, not just the status');
  assert.equal(w.comments['zz-work'][0], 'Out of time; harness half written, CLI half is not.');
  assert.match(out, /wrote: comment/);
  assert.match(out, /wrote: status open, assignee cleared/);
  assert.match(out, /now: open/);
});

check('--why folds into the comment header without changing what gets written', () => {
  reset();
  const { status } = handback(['-b', 'zz-work', '--note', noteFile, '--why', 'timeout']);
  assert.equal(status, 0);
  assert.match(world().comments['zz-work'][0], /^Handing back \(timeout\): Out of time/);
});

check('an invalid --why is refused before anything is written', () => {
  reset();
  const { status, err } = handback(['-b', 'zz-work', '--note', noteFile, '--why', 'confused']);
  assert.notEqual(status, 0);
  assert.match(err, /--why must be one of timeout, handback, blocked/);
  assert.deepEqual(world().calls, []);
});

check('--human on a decision bead adds the label alongside the ordinary handback', () => {
  reset();
  const { status, out } = handback(['-b', 'zz-decision', '--note', noteFile, '--human']);
  assert.equal(status, 0, out);
  const w = world();
  assert.deepEqual(w.issues['zz-decision'].labels, ['human']);
  assert.equal(w.issues['zz-decision'].status, 'open');
  assert.match(out, /wrote: label human/);
});

check('--human on an ordinary task is refused before writing anything — the label is not its to carry', () => {
  reset();
  const { status, err } = handback(['-b', 'zz-work', '--note', noteFile, '--human']);
  assert.notEqual(status, 0);
  assert.match(err, /--human is for a decision bead/);
  const w = world();
  assert.equal(w.issues['zz-work'].status, 'in_progress', 'nothing was written');
  assert.equal(w.comments['zz-work'], undefined);
  assert.deepEqual(
    w.calls.filter((c) => !c.startsWith('show')),
    []
  );
});

check('a closed bead is refused — there is nothing left to hand back', () => {
  reset();
  const { status, err } = handback(['-b', 'zz-closed', '--note', noteFile]);
  assert.notEqual(status, 0);
  assert.match(err, /already closed/);
  assert.deepEqual(
    world().calls.filter((c) => !c.startsWith('show')),
    []
  );
});

check('an empty note is refused before bd is ever spawned', () => {
  reset();
  const empty = path.join(tmp, 'empty.md');
  fs.writeFileSync(empty, '   \n');
  const { status, err } = handback(['-b', 'zz-work', '--note', empty]);
  assert.notEqual(status, 0);
  assert.match(err, /the note is empty/);
  assert.deepEqual(world().calls, []);
});

check('an unknown workspace is refused, checked against the CLI itself, not just the fake', () => {
  reset();
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'b7e-handback'), '-w', 'nowhere', '-b', 'zz-work', '--note', noteFile], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no workspace named "nowhere"/);
  assert.deepEqual(world().calls, []);
});

check('a reassign guard on the plain reopen is stepped over exactly the way reopenAbandoned always has', () => {
  reset({ reassignGuard: true });
  const { status, out } = handback(['-b', 'zz-work', '--note', noteFile]);
  assert.equal(status, 0, out);
  const w = world();
  assert.equal(w.issues['zz-work'].status, 'open');
  assert.equal(w.issues['zz-work'].assignee, '');
  const updates = w.calls.filter((c) => c.startsWith('update'));
  assert.equal(updates.length, 2, 'the plain attempt, refused, then the forced one');
  assert.ok(updates[1].includes('--force'));
});

check('a write that lands but does not stick — the readback disagrees, and the run ends non-zero', () => {
  reset({ noopUpdate: true });
  const { status, out } = handback(['-b', 'zz-work', '--note', noteFile]);
  assert.notEqual(status, 0);
  assert.equal(world().issues['zz-work'].status, 'in_progress', 'the fake bd really did not apply it');
  assert.match(out, /wrote: comment/, 'the comment did land');
  assert.match(out, /not handed back/);
});

check('--json carries the same facts the printed report does', () => {
  reset();
  const { status, out } = handback(['-b', 'zz-work', '--note', noteFile, '--why', 'blocked', '--json']);
  assert.equal(status, 0, out);
  const payload = JSON.parse(out);
  assert.equal(payload.bead, 'zz-work');
  assert.equal(payload.why, 'blocked');
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.wrote, ['comment', 'status open, assignee cleared']);
  assert.equal(payload.row.status, 'open');
});

check('the note reads from stdin when --note is omitted, never as a shell argument', () => {
  reset();
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'b7e-handback'), '-w', 'demo', '-b', 'zz-work'], {
    input: 'Piped straight in, no heredoc to mangle it.\n',
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(world().comments['zz-work'][0], 'Piped straight in, no heredoc to mangle it.');
});

console.log(`\n${ran - failures}/${ran} passed`);
cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
