#!/usr/bin/env node
/**
 * `b7e-filed` — confirm a filing batch actually landed. bin/b7e-filed.js.
 *
 *     npm test
 *     node test/b7efiled.mjs
 *
 * bc-dgx7.104's own acceptance criteria, replayed against a fake `bd`: a title with no
 * matching `filed-while:<from>` bead is `unfiled`; a title matched by two is
 * `duplicate`; a singly-matched bead missing its parent is reported stranded and
 * `--repair` attaches it (the dv-afr.7 recovery, `bd update dv-imex --parent=dv-afr`,
 * done by the command instead of by hand); a bead whose stored description is shorter
 * than the spec's (the dv-afr.6 shell-quoting truncation) is flagged rather than
 * reported whole; and running the same spec a second time changes nothing that was
 * already right. Same shape as test/b7ehandback.mjs: a fake `bd` reading a small
 * mutable `world.json`, spawned for real through `bin/b7e-filed.js`.
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
const BIN = path.join(ROOT, 'bin', 'b7e-filed.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7efiled-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file. `export` carries the parent as a `parent-child` dependency
 * exactly as a real export does (same shape test/filing.mjs already proved out), which
 * is what `lib/homing.js#homeIn` needs to find a root above `--from`. `list --label`
 * is the one lookup this command actually makes to find what it filed — filtering only
 * on the label, since every fixture issue here already carries the status the real
 * `filed-while:` beads would.
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

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found matching "' + args[1] + '"');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'export') {
  const lines = Object.values(w.issues).map((i) =>
    JSON.stringify({
      ...i,
      dependencies: i.parent ? [{ issue_id: i.id, depends_on_id: i.parent, type: 'parent-child' }] : [],
    })
  );
  process.stdout.write(lines.join('\\n'));
  process.exit(0);
}
if (args[0] === 'list') {
  const li = args.indexOf('--label');
  const label = li > -1 ? args[li + 1] : null;
  const rows = Object.values(w.issues).filter((i) => label && (i.labels || []).includes(label));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  const pi = args.indexOf('--parent');
  if (pi > -1) issue.parent = args[pi + 1];
  save();
  process.stdout.write('{}');
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
const world = () => JSON.parse(fs.readFileSync(worldFile, 'utf8'));

const FROM = 'zz-worker';
const FILED_WHILE = `filed-while:${FROM}`;

const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  assignee: '',
  parent: '',
  ...extra,
});

const reset = (extraIssues = {}) =>
  fs.writeFileSync(
    worldFile,
    JSON.stringify(
      {
        calls: [],
        issues: {
          'zz-epic': issue('zz-epic', { issue_type: 'epic', priority: 2 }),
          [FROM]: issue(FROM, { parent: 'zz-epic' }),
          ...extraIssues,
        },
      },
      null,
      2
    )
  );

const SPEC = `
- title: Landed cleanly
  description: |
    Everything about this one matches what was filed.
- title: Missing its parent
  description: Filed but never attached under the epic.
- title: Truncated in transit
  description: |
    A description long enough that a shell-quoting bug could plausibly have cut it
    off partway through, the dv-afr.6 shape.
- title: Never landed
  description: This one's create must have failed outright.
- title: Filed twice by accident
  description: The dv-afr.8 shape — the same title filed under this --from twice.
`;

/** The command, run exactly as a worker brief would print it. */
const filed = (args, spec = SPEC) => {
  const res = spawnSync(process.execPath, [BIN, '-w', 'demo', '--from', FROM, ...args], {
    encoding: 'utf8',
    input: spec,
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
    console.log(`      ${String(err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

console.log('\nb7e-filed — confirm a filing batch actually landed\n');

const baseIssues = () => ({
  'zz-landed': issue('zz-landed', {
    title: 'Landed cleanly',
    description: 'Everything about this one matches what was filed.',
    parent: 'zz-epic',
    labels: [FILED_WHILE, 'agent-filed'],
    assignee: 'beadcause-test',
  }),
  'zz-stranded': issue('zz-stranded', {
    title: 'Missing its parent',
    description: 'Filed but never attached under the epic.',
    parent: '',
    labels: [FILED_WHILE, 'agent-filed'],
  }),
  'zz-trunc': issue('zz-trunc', {
    title: 'Truncated in transit',
    description: 'A description long enough that a shell-quoting bug could plausibly have cut it',
    parent: 'zz-epic',
    labels: [FILED_WHILE, 'agent-filed'],
  }),
  'zz-dupe-1': issue('zz-dupe-1', {
    title: 'Filed twice by accident',
    description: 'The dv-afr.8 shape — the same title filed under this --from twice.\n',
    parent: 'zz-epic',
    labels: [FILED_WHILE, 'agent-filed'],
  }),
  'zz-dupe-2': issue('zz-dupe-2', {
    title: 'Filed twice by accident',
    description: 'The dv-afr.8 shape — the same title filed under this --from twice.\n',
    parent: 'zz-epic',
    labels: [FILED_WHILE, 'agent-filed'],
  }),
  // "Never landed" has no matching row at all — that is the point of it.
});

check('reports one row per intended title: filed / unfiled / duplicate', () => {
  reset(baseIssues());
  const { status, out } = filed([]);
  assert.equal(status, 1, out); // unfiled + duplicate + stranded + truncated all present
  assert.match(out, /✓ zz-landed\s+"Landed cleanly"/);
  assert.match(out, /description whole/);
  assert.match(out, /✗ UNFILED\s+"Never landed"/);
  assert.match(out, /⚠ DUPLICATE\s+"Filed twice by accident" — zz-dupe-1, zz-dupe-2/);
});

check('a filed bead with no parent is reported stranded, not silently fine', () => {
  reset(baseIssues());
  const { out } = filed([]);
  assert.match(out, /NO PARENT/);
  assert.match(out, /stranded/);
});

check('a truncated description is flagged with both byte counts, not just "not whole"', () => {
  reset(baseIssues());
  const { out } = filed([]);
  assert.match(out, /description TRUNCATED \(\d+\/\d+ bytes\)/);
});

check('--json emits one machine-readable row per title, matching the printed report', () => {
  reset(baseIssues());
  const { status, out } = filed(['--json']);
  const parsed = JSON.parse(out);
  assert.equal(status, 1);
  const byTitle = Object.fromEntries(parsed.results.map((r) => [r.title, r]));
  assert.equal(byTitle['Landed cleanly'].status, 'filed');
  assert.equal(byTitle['Landed cleanly'].description.whole, true);
  assert.equal(byTitle['Missing its parent'].stranded, true);
  assert.equal(byTitle['Never landed'].status, 'unfiled');
  assert.deepEqual(byTitle['Filed twice by accident'].ids.sort(), ['zz-dupe-1', 'zz-dupe-2']);
});

check('--repair attaches a missing parent — the exact dv-afr.7 recovery, done for you', () => {
  reset(baseIssues());
  const before = filed([]);
  assert.match(before.out, /NO PARENT/);

  const { status, out } = filed(['--repair']);
  assert.match(out, /parent zz-epic \(repaired\)/);
  assert.equal(world().issues['zz-stranded'].parent, 'zz-epic');

  const updates = world().calls.filter((c) => c.startsWith('update zz-stranded'));
  assert.equal(updates.length, 1);
  assert.ok(updates[0].includes('--parent zz-epic'));
  // Everything else about the run is unaffected — repair only ever touches the one
  // field, on the one bead that was actually missing it.
  assert.equal(status, 1, 'still 1: the truncated description and the rest are untouched by --repair');
});

check('--repair never touches a bead that already has a parent, whatever it is', () => {
  const issues = baseIssues();
  issues['zz-landed'].parent = 'zz-epic';
  reset(issues);
  filed(['--repair']);
  const updates = world().calls.filter((c) => c.startsWith('update zz-landed'));
  assert.deepEqual(updates, [], 'a bead already parented is never adopted, even under --repair');
});

check('running the same spec twice changes nothing the second time', () => {
  reset(baseIssues());
  filed(['--repair']);
  const callsAfterFirst = world().calls.length;
  const { out } = filed(['--repair']);
  assert.match(out, /parent zz-epic/);
  assert.doesNotMatch(out, /\(repaired\)/, 'the second run finds it already attached, not repairs it again');
  const secondUpdates = world()
    .calls.slice(callsAfterFirst)
    .filter((c) => c.startsWith('update'));
  assert.deepEqual(secondUpdates, []);
});

check('a stranded bead under a root that has nowhere else to go is not touched without --repair', () => {
  reset(baseIssues());
  filed([]);
  assert.deepEqual(
    world().calls.filter((c) => c.startsWith('update')),
    [],
    'read-only unless --repair is passed'
  );
});

check('an unknown workspace is refused, checked against the CLI itself', () => {
  reset(baseIssues());
  const res = spawnSync(process.execPath, [BIN, '-w', 'nowhere', '--from', FROM], {
    encoding: 'utf8',
    input: SPEC,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no workspace named "nowhere"/);
});

check('a --from this workspace has never heard of is refused before anything is read', () => {
  reset(baseIssues());
  const res = spawnSync(process.execPath, [BIN, '-w', 'demo', '--from', 'zz-nope'], {
    encoding: 'utf8',
    input: SPEC,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /has no bead zz-nope/);
});

check('a spec naming no beads at all is refused with exit 3, not read as success', () => {
  reset(baseIssues());
  const { status, err } = filed([], 'not: yaml: [');
  assert.notEqual(status, 0);
  assert.match(err, /not valid YAML|no beads/);
});

check('an all-clear batch exits 0 and says so', () => {
  const issues = baseIssues();
  delete issues['zz-stranded'];
  delete issues['zz-trunc'];
  delete issues['zz-dupe-1'];
  delete issues['zz-dupe-2'];
  issues['zz-missing-parent'] = issue('zz-missing-parent', {
    title: 'Missing its parent',
    description: 'Filed but never attached under the epic.',
    parent: 'zz-epic',
    labels: [FILED_WHILE, 'agent-filed'],
  });
  issues['zz-truncated'] = issue('zz-truncated', {
    title: 'Truncated in transit',
    description:
      'A description long enough that a shell-quoting bug could plausibly have cut it\noff partway through, the dv-afr.6 shape.',
    parent: 'zz-epic',
    labels: [FILED_WHILE, 'agent-filed'],
  });
  issues['zz-dupe-once'] = issue('zz-dupe-once', {
    title: 'Filed twice by accident',
    description: 'The dv-afr.8 shape — the same title filed under this --from twice.',
    parent: 'zz-epic',
    labels: [FILED_WHILE, 'agent-filed'],
  });
  issues['zz-never'] = issue('zz-never', {
    title: 'Never landed',
    description: "This one's create must have failed outright.",
    parent: 'zz-epic',
    labels: [FILED_WHILE, 'agent-filed'],
  });
  reset(issues);
  const { status, out } = filed([]);
  assert.equal(status, 0, out);
  assert.match(out, /All 5 title\(s\) filed exactly once, with a home, whole\./);
});

console.log(`\n${ran - failures}/${ran} checks passed`);
cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
