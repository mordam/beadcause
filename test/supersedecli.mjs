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

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, and a `bd` that writes to it.
 *
 * `refuse` in the world is how bd saying no is staged — a substring of the argv, and the
 * message it says no with. Every call is logged, because "nothing was written" is an
 * assertion about the log rather than about the tracker: a refused command that still
 * read three rows would pass a check on the issues alone.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2).filter((a, i, all) => a !== '--actor' && all[i - 1] !== '--actor');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
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
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }] }, null, 2)
);

const issue = (id, extra = {}) => ({ id, title: `bead ${id}`, status: 'open', issue_type: 'task', labels: [], ...extra });
const reset = (refuse = {}) =>
  fs.writeFileSync(
    WORLD,
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

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));

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

check('a missing argument prints the usage and names the workspaces', () => {
  reset();
  const { status, err } = supersede(['-b', 'zz-dup']);
  assert.equal(status, 1);
  assert.match(err, /usage: beadcause-supersede/);
  assert.match(err, /workspaces: demo/);
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
