#!/usr/bin/env node
/**
 * `beadcause-supersede` — the command a worker runs instead of typing three `bd` lines.
 *
 *     npm test
 *     node test/supersedecli.mjs
 *
 * test/superseded.mjs drives `mark` directly and test/epicedgereal.mjs drives it against
 * the real binary. Neither runs the CLI, and the CLI is the only part of this a worker
 * ever touches: the brief prints one command, and everything the marker guarantees
 * depends on that command doing what the brief says it does.
 *
 * So this spawns `bin/supersede.js` the way the brief tells a worker to spawn it — the
 * reason on stdin — against a fake `bd` in a temp workspace, and reads the tracker
 * afterwards. What it is really asserting is the two things a wrapper is easy to get
 * wrong: that a refusal writes **nothing at all** and exits non-zero, and that a partial
 * failure — the comment not landing — still exits zero, because a caller told the
 * command failed marks the bead a second time.
 *
 * Two workspaces, `demo` and `other`, each with its own `world.json` under its own
 * `BEADS_DIR` — the fake `bd` reads `process.env.BEADS_DIR` rather than a path baked in
 * at script-creation time, which is what makes it possible to tell the two trackers
 * apart at all. That is the shape bc-xl7n.71 is about: `--original other/zz-remote`
 * from `-w demo` has to read `zz-remote` out of `other`'s tracker, never `demo`'s.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-supersedecli-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file per `BEADS_DIR`, and a `bd` that writes to it.
 *
 * `refuse` in the world is how bd saying no is staged — a substring of the argv, and the
 * message it says no with. Every call is logged, because "nothing was written" is an
 * assertion about the log rather than about the tracker: a refused command that still
 * read three rows would pass a check on the issues alone.
 *
 * `WORLD` is computed from `process.env.BEADS_DIR` rather than baked into the script at
 * creation time, which is the whole point: `bin/supersede.js` spawns this same binary
 * against two different `BEADS_DIR`s for a cross-workspace pair, and only a `bd` that
 * actually looks at its own environment can tell `demo` from `other`.
 */
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
if (args[0] === 'dep') { process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
// The other tracker — a different BEADS_DIR, a different world.json, no relation to
// `wsDir` beyond both being workspaces this beadcause install knows about.
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
      {
        calls: [],
        comments: {},
        refuse,
        issues: {
          'zz-dup': issue('zz-dup', { status: 'in_progress' }),
          'zz-orig': issue('zz-orig'),
          'zz-epic': issue('zz-epic', { issue_type: 'epic' }),
        },
      },
      null,
      2
    )
  );
/** The `other` tracker, seeded independently — `zz-remote` is the cross-workspace original. */
const resetOther = () =>
  fs.writeFileSync(
    worldFile(otherDir),
    JSON.stringify({ calls: [], comments: {}, refuse: {}, issues: { 'zz-remote': issue('zz-remote') } }, null, 2)
  );

const world = (dir = wsDir) => JSON.parse(fs.readFileSync(worldFile(dir), 'utf8'));

/** The command, run exactly as the worker brief prints it: the reason on stdin. */
const supersede = (args, input = 'Both are the same fix in lib/router.js.\n') => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'supersede.js'), '-w', 'demo', ...args], {
    input,
    encoding: 'utf8',
    // HOME into the temp tree, so workspace discovery finds no real ~/beads to reconcile.
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

console.log('\nthe command a worker runs to mark a duplicate\n');

check('an ordinary original: the label, the blocking edge, the comment, and the status back to open', () => {
  reset();
  const { status, out } = supersede(['-b', 'zz-dup', '--original', 'zz-orig']);
  assert.equal(status, 0, out);
  const w = world();
  assert.deepEqual(w.issues['zz-dup'].labels, ['superseded-by:zz-orig']);
  assert.equal(w.issues['zz-dup'].status, 'open', 'a bead left in_progress is invisible to the sweep forever');
  assert.ok(w.calls.includes('dep add zz-dup zz-orig'), `calls: ${w.calls.join(' | ')}`);
  assert.match(w.comments['zz-dup'][0], /Superseded by zz-orig — Both are the same fix/);
  assert.match(out, /marked zz-dup superseded-by:zz-orig/);
});

check('an epic original: the see-also, and the sentence saying what is holding the bead', () => {
  reset();
  const { status, out } = supersede(['-b', 'zz-dup', '--original', 'zz-epic']);
  assert.equal(status, 0, out);
  const w = world();
  assert.ok(w.calls.includes('dep relate zz-dup zz-epic'), `calls: ${w.calls.join(' | ')}`);
  assert.equal(
    w.calls.some((c) => c.startsWith('dep add')),
    false,
    'bd would refuse a blocking edge onto an epic, so it is never attempted'
  );
  assert.match(out, /held by the marker rather than by the graph/);
});

check('it never writes the `human` label, whichever kind of original it is', () => {
  reset();
  supersede(['-b', 'zz-dup', '--original', 'zz-epic']);
  assert.equal(
    world().calls.some((c) => /^label add \S+ human/.test(c)),
    false,
    'the sweep excludes the inbox by that label — writing it here prevents the card for good'
  );
});

check('a typo in the original writes nothing at all, and says so on stderr', () => {
  reset();
  const { status, err } = supersede(['-b', 'zz-dup', '--original', 'zz-nope']);
  assert.equal(status, 1);
  assert.match(err, /no bead zz-nope here/);
  const w = world();
  assert.deepEqual(w.issues['zz-dup'].labels, []);
  assert.equal(w.issues['zz-dup'].status, 'in_progress', 'and the bead is left exactly as it was');
  assert.deepEqual(
    w.calls.filter((c) => !c.startsWith('show')),
    [],
    `only the two reads: ${w.calls.join(' | ')}`
  );
  assert.deepEqual(w.comments, {}, 'and no comment explaining a marker that does not exist');
});

check('an empty reason is refused before anything is read', () => {
  reset();
  const { status, err } = supersede(['-b', 'zz-dup', '--original', 'zz-orig'], '   \n');
  assert.equal(status, 1);
  assert.match(err, /pipe in why/);
  assert.deepEqual(world().calls, [], 'the reason is what the card sends them to, so it is not optional');
});

check('a comment that will not land is a warning, not a failure — the marker is already on', () => {
  // Exiting non-zero here would be the worst of both: the bead is marked, and the caller
  // has been told the command failed, so it marks it again or writes the marker by hand.
  reset({ comment: 'Error: the tracker is mid-write' });
  const { status, err } = supersede(['-b', 'zz-dup', '--original', 'zz-orig']);
  assert.equal(status, 0);
  assert.match(err, /is marked, but the comment did not land/);
  assert.deepEqual(world().issues['zz-dup'].labels, ['superseded-by:zz-orig']);
});

check('running it twice is a no-op that says so, rather than a second comment', () => {
  reset();
  supersede(['-b', 'zz-dup', '--original', 'zz-orig']);
  const before = world().calls.length;
  const { status, out } = supersede(['-b', 'zz-dup', '--original', 'zz-orig']);
  assert.equal(status, 0, out);
  assert.match(out, /already marked superseded-by:zz-orig/);
  assert.equal(world().comments['zz-dup'].length, 1, 'and no second copy of the reason on the thread');
  assert.equal(
    world().calls.length - before,
    2,
    `only the two reads on the second run: ${world().calls.slice(before).join(' | ')}`
  );
});

check('a missing argument prints the usage and names the workspaces', () => {
  reset();
  const { status, err } = supersede(['-b', 'zz-dup']);
  assert.equal(status, 1);
  assert.match(err, /usage: beadcause-supersede/);
  assert.match(err, /workspaces: demo/);
});

/* ------------------------------------------------- cross-workspace, bc-xl7n.71 */

check('a workspace-qualified original is read from its own tracker, not -w\'s', () => {
  reset();
  resetOther();
  const { status, out } = supersede(['-b', 'zz-dup', '--original', 'other/zz-remote']);
  assert.equal(status, 0, out);
  assert.deepEqual(world().issues['zz-dup'].labels, ['superseded-by:other/zz-remote']);
  assert.equal(world().issues['zz-dup'].status, 'open');
  assert.match(world().comments['zz-dup'][0], /Superseded by other\/zz-remote/);
  // The read happened against `other`'s own tracker — that log is otherwise empty.
  assert.deepEqual(world(otherDir).calls, ['show zz-remote --json'], `other calls: ${world(otherDir).calls.join(' | ')}`);
  // And demo's tracker was never asked to `show` zz-remote itself — only the qualified
  // label and comment name it, on the duplicate's own row. The two BEADS_DIRs were never
  // crossed.
  assert.equal(
    world().calls.some((c) => c.startsWith('show zz-remote')),
    false,
    `demo calls: ${world().calls.join(' | ')}`
  );
});

check('a cross-workspace pair gets no graph edge, and says so out loud', () => {
  reset();
  resetOther();
  const { status, out } = supersede(['-b', 'zz-dup', '--original', 'other/zz-remote']);
  assert.equal(status, 0, out);
  assert.equal(
    world().calls.some((c) => c.startsWith('dep')),
    false,
    'there is no tracker that spans both, so no edge was even attempted'
  );
  assert.match(out, /different tracker/);
  assert.match(out, /held by the marker rather than by the graph/);
});

check('an unknown workspace name is refused before either tracker is touched', () => {
  reset();
  resetOther();
  const { status, err } = supersede(['-b', 'zz-dup', '--original', 'ghost-workspace/zz-remote']);
  assert.equal(status, 1);
  assert.match(err, /ghost-workspace is not a workspace/);
  assert.deepEqual(world().calls, [], 'demo: nothing written');
  assert.deepEqual(world(otherDir).calls, [], 'other: never even asked');
});

check('a qualified original that does not exist in its own tracker is a typo, not a crash', () => {
  reset();
  resetOther();
  const { status, err } = supersede(['-b', 'zz-dup', '--original', 'other/zz-missing']);
  assert.equal(status, 1);
  assert.match(err, /no bead other\/zz-missing here/);
  assert.deepEqual(world().issues['zz-dup'].labels, [], 'demo: the duplicate is untouched');
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
