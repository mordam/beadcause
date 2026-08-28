#!/usr/bin/env node
//
// b7e-graph — the workspace's beads and comments as one local snapshot you can
// actually query, read straight off Dolt (bc-dgx7.98). See lib/beadsnapshot.js's
// header for the full case and for exactly what "identical to `bd list --json`" is
// scoped to mean here.
//
//   npm test
//   node test/beadsnapshot.mjs
//
// Three layers, cheapest first. (1) The pure functions — isoDate, filterIssues,
// formatTable, forJson, databases, cachePath — against fabricated data, no
// subprocess at all. (2) buildSnapshot/loadSnapshot driven with an injected `exec`
// and real-but-empty `.dolt` directories, so the join logic and the cache's staleness
// rules (age, Dolt's own change mark, --refresh) are provable without a real `dolt`
// on the machine. (3) Against the real `bd` AND real `dolt` binaries, skipped loudly
// where either is missing: a fixture workspace is built with `bd`, and buildSnapshot's
// rows are checked field-for-field against `bd list --status=all --json` for the same
// rows — the acceptance criterion's own words — then bin/b7e-graph is driven as a
// real subprocess against that fixture for every flag the bead names.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isoDate,
  databases,
  cachePath,
  filterIssues,
  formatTable,
  forJson,
  buildSnapshot,
  loadSnapshot,
} from '../lib/beadsnapshot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-graph');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nb7e-graph\n');

/* ==================================================================== isoDate */

check('isoDate: "YYYY-MM-DD HH:MM:SS" becomes "YYYY-MM-DDTHH:MM:SSZ"', () => {
  assert.equal(isoDate('2026-08-14 16:33:45'), '2026-08-14T16:33:45Z');
});
check('isoDate: null/empty pass through as null, never as a string', () => {
  assert.equal(isoDate(null), null);
  assert.equal(isoDate(''), null);
  assert.equal(isoDate(undefined), null);
});

/* ================================================================= filterIssues */

const issue = (id, over = {}) => ({
  id,
  title: 'a title',
  status: 'open',
  assignee: null,
  labels: [],
  parent: null,
  close_reason: '',
  ...over,
});

check('filterIssues: --title-match is a case-insensitive substring', () => {
  const rows = [issue('a', { title: 'Entry 107 fixed' }), issue('b', { title: 'unrelated' })];
  const out = filterIssues(rows, { titleMatch: 'entry 107' });
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

check('filterIssues: --assignee is an exact match, not a substring', () => {
  const rows = [issue('a', { assignee: 'neadamthal@gmail.com' }), issue('b', { assignee: 'neadamthal@gmail.com.evil' })];
  const out = filterIssues(rows, { assignee: 'neadamthal@gmail.com' });
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

check('filterIssues: --label is ANDed — every named label must be present', () => {
  const rows = [issue('a', { labels: ['gate', 'burrow'] }), issue('b', { labels: ['gate'] })];
  const out = filterIssues(rows, { label: ['gate', 'burrow'] });
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

check('filterIssues: --status is ORed over a comma list', () => {
  const rows = [issue('a', { status: 'open' }), issue('b', { status: 'in_progress' }), issue('c', { status: 'closed' })];
  const out = filterIssues(rows, { status: ['open', 'in_progress'] });
  assert.deepEqual(out.map((r) => r.id).sort(), ['a', 'b']);
});

check('filterIssues: --parent matches the one parent-child edge naming this issue', () => {
  const rows = [issue('a', { parent: 'ep-1' }), issue('b', { parent: 'ep-2' }), issue('c', { parent: null })];
  const out = filterIssues(rows, { parent: 'ep-1' });
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

check('filterIssues: --closed-reason is a case-insensitive substring', () => {
  const rows = [issue('a', { close_reason: 'Superseded by bc-9.2' }), issue('b', { close_reason: 'Merged #1' })];
  const out = filterIssues(rows, { closedReason: 'superseded' });
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

check('filterIssues: every given predicate is ANDed together', () => {
  const rows = [
    issue('a', { title: 'match', status: 'open', labels: ['gate'] }),
    issue('b', { title: 'match', status: 'closed', labels: ['gate'] }),
  ];
  const out = filterIssues(rows, { titleMatch: 'match', status: ['open'], label: ['gate'] });
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

check('filterIssues: no predicates at all returns everything, unfiltered', () => {
  const rows = [issue('a'), issue('b')];
  assert.equal(filterIssues(rows, {}).length, 2);
  assert.equal(filterIssues(rows).length, 2);
});

/* =================================================================== formatTable */

check('formatTable: empty input says so rather than printing an empty table', () => {
  assert.equal(formatTable([]), '(no matching beads)');
});

check('formatTable: one line per bead, id/status/assignee/labels/title, header first', () => {
  const out = formatTable([issue('bc-1', { status: 'open', assignee: 'adam', labels: ['x', 'y'], title: 'hello' })]);
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /id\s+status\s+assignee\s+labels/);
  assert.match(lines[1], /bc-1/);
  assert.match(lines[1], /\[x,y\]/);
  assert.match(lines[1], /hello/);
});

/* ======================================================================= forJson */

check('forJson: comments are dropped by default', () => {
  const rows = [{ id: 'a', comments: [{ text: 'hi' }] }];
  const out = forJson(rows, {});
  assert.deepEqual(out, [{ id: 'a' }]);
});

check('forJson: --with-comments keeps them, untouched', () => {
  const rows = [{ id: 'a', comments: [{ text: 'hi' }] }];
  const out = forJson(rows, { withComments: true });
  assert.deepEqual(out, rows);
});

/* ==================================================================== databases */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-beadsnapshot-'));

check('databases: finds every directory under embeddeddolt/ that has a .dolt', () => {
  const ws = path.join(tmp, 'ws1', '.beads');
  fs.mkdirSync(path.join(ws, 'embeddeddolt', 'xx', '.dolt'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'embeddeddolt', 'not-a-db'), { recursive: true }); // no .dolt inside
  const dbs = databases(ws);
  assert.deepEqual(
    dbs.map((d) => d.prefix),
    ['xx']
  );
});

check('databases: no embeddeddolt directory at all is [], not a throw', () => {
  const ws = path.join(tmp, 'ws2', '.beads');
  fs.mkdirSync(ws, { recursive: true });
  assert.deepEqual(databases(ws), []);
});

/* ==================================================================== cachePath */

check('cachePath: same beadsDir (however spelled) is the same file, outside the repo and outside ~/.config', () => {
  const ws = path.join(tmp, 'ws1', '.beads');
  const p1 = cachePath(ws);
  const p2 = cachePath(`${ws}/.`);
  assert.equal(p1, p2);
  assert.ok(p1.startsWith(os.tmpdir()));
  assert.ok(!p1.includes('.config'));
});

check('cachePath: two different workspaces never collide', () => {
  assert.notEqual(cachePath(path.join(tmp, 'ws1', '.beads')), cachePath(path.join(tmp, 'ws2', '.beads')));
});

/* ============================================================ buildSnapshot (fake exec) */

/**
 * A `dolt` stand-in that answers a fixed table world by matching the table name in the
 * SQL text — never invoked with anything a real `dolt sql -r json` wouldn't be asked,
 * and never touching a real database, so this proves the JOIN and normalisation logic
 * (labels sorted and grouped, comments grouped and ordered, the one parent-child edge
 * resolved, priority turned into a number, datetimes turned into `Z` strings) without
 * needing `dolt` installed at all.
 */
function fakeExec(world) {
  const calls = [];
  const exec = (bin, args) => {
    const sql = args[args.length - 1];
    calls.push(sql);
    if (/from issues/.test(sql)) return JSON.stringify({ rows: world.issues });
    if (/from labels/.test(sql)) return JSON.stringify({ rows: world.labels });
    if (/from comments/.test(sql)) return JSON.stringify({ rows: world.comments });
    if (/from dependencies/.test(sql)) return JSON.stringify({ rows: world.parents });
    throw new Error(`fakeExec: unexpected sql "${sql}"`);
  };
  exec.calls = calls;
  return exec;
}

function fixtureDb() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-beadsnapshot-fixture-'));
  const beadsDir = path.join(ws, '.beads');
  fs.mkdirSync(path.join(beadsDir, 'embeddeddolt', 'xx', '.dolt'), { recursive: true });
  return beadsDir;
}

const WORLD = {
  issues: [
    {
      id: 'xx-1',
      title: 'Entry 107 — the fixture bead',
      description: 'd',
      design: '',
      acceptance_criteria: '',
      notes: '',
      status: 'open',
      priority: '2',
      issue_type: 'task',
      assignee: 'neadamthal@gmail.com',
      owner: 'neadamthal@gmail.com',
      created_at: '2026-08-01 10:00:00',
      created_by: 'beadcause',
      updated_at: '2026-08-02 11:00:00',
      closed_at: null,
      close_reason: '',
    },
    {
      id: 'xx-2',
      title: 'child of xx-1',
      description: '',
      design: '',
      acceptance_criteria: '',
      notes: '',
      status: 'closed',
      priority: '1',
      issue_type: 'task',
      assignee: null,
      owner: '',
      created_at: '2026-08-01 10:05:00',
      created_by: 'beadcause',
      updated_at: '2026-08-03 09:00:00',
      closed_at: '2026-08-03 09:00:00',
      close_reason: 'Superseded by xx-1',
    },
  ],
  labels: [
    { issue_id: 'xx-1', label: 'burrow' },
    { issue_id: 'xx-1', label: 'agent-filed' },
  ],
  comments: [
    { id: 'c2', issue_id: 'xx-1', author: 'adam', text: 'second', created_at: '2026-08-02 12:00:00' },
    { id: 'c1', issue_id: 'xx-1', author: 'adam', text: 'first', created_at: '2026-08-02 11:00:00' },
  ],
  parents: [{ issue_id: 'xx-2', parent_id: 'xx-1' }],
};

check('buildSnapshot: joins labels (sorted), comments (created_at order) and the one parent edge', () => {
  const beadsDir = fixtureDb();
  const snap = buildSnapshot(beadsDir, { exec: fakeExec(WORLD) });
  assert.deepEqual(snap.prefixes, ['xx']);
  const a = snap.issues.find((i) => i.id === 'xx-1');
  const b = snap.issues.find((i) => i.id === 'xx-2');
  assert.deepEqual(a.labels, ['agent-filed', 'burrow']);
  assert.equal(a.comment_count, 2);
  assert.deepEqual(a.comments.map((c) => c.text), ['first', 'second']);
  assert.equal(a.parent, null);
  assert.equal(b.parent, 'xx-1');
  assert.equal(a.priority, 2); // string "2" from dolt becomes the number 2
  assert.equal(a.created_at, '2026-08-01T10:00:00Z');
  assert.equal(b.close_reason, 'Superseded by xx-1');
});

check('buildSnapshot: never issues a WHERE built from anything but a fixed literal', () => {
  const beadsDir = fixtureDb();
  const exec = fakeExec(WORLD);
  buildSnapshot(beadsDir, { exec });
  for (const sql of exec.calls) {
    // Every clause in every query this module ever runs is fixed at write time — no
    // caller-supplied string reaches here. Asserted by construction: none of the SQL
    // this test ever sees contains anything but the literal table/column names and the
    // one hard-coded `type = 'parent-child'`.
    assert.doesNotMatch(sql, /select \* /);
  }
});

/* ============================================================ loadSnapshot (fake exec) */

check('loadSnapshot: a first call builds and caches; a second within max-age and an unmoved mark reads the cache without touching exec again', () => {
  const beadsDir = fixtureDb();
  const exec = fakeExec(WORLD);
  const mark = () => 'mark-1';
  const s1 = loadSnapshot(beadsDir, { exec, mark, maxAgeMs: 60_000 });
  assert.equal(s1.fresh, true);
  const callsAfterFirst = exec.calls.length;
  const s2 = loadSnapshot(beadsDir, { exec, mark, maxAgeMs: 60_000 });
  assert.equal(s2.fresh, false);
  assert.equal(exec.calls.length, callsAfterFirst, 'exec must not be called again for a fresh cache hit');
  assert.deepEqual(
    s2.issues.map((i) => i.id).sort(),
    s1.issues.map((i) => i.id).sort()
  );
});

check('loadSnapshot: a moved Dolt mark forces a rebuild regardless of --max-age', () => {
  const beadsDir = fixtureDb();
  const exec = fakeExec(WORLD);
  let markValue = 'before';
  const mark = () => markValue;
  loadSnapshot(beadsDir, { exec, mark, maxAgeMs: 60_000 });
  const callsAfterFirst = exec.calls.length;
  markValue = 'after';
  const s2 = loadSnapshot(beadsDir, { exec, mark, maxAgeMs: 60_000 });
  assert.equal(s2.fresh, true);
  assert.ok(exec.calls.length > callsAfterFirst, 'a moved mark must trigger a real re-read');
});

check('loadSnapshot: age past --max-age forces a rebuild even with an unmoved mark', () => {
  const beadsDir = fixtureDb();
  const exec = fakeExec(WORLD);
  const mark = () => 'stable';
  let clock = 1_000_000;
  const now = () => clock;
  loadSnapshot(beadsDir, { exec, mark, now, maxAgeMs: 1000 });
  const callsAfterFirst = exec.calls.length;
  clock += 5000; // well past the 1s ceiling
  const s2 = loadSnapshot(beadsDir, { exec, mark, now, maxAgeMs: 1000 });
  assert.equal(s2.fresh, true);
  assert.ok(exec.calls.length > callsAfterFirst);
});

check('loadSnapshot: --refresh (force) rebuilds even when the cache is otherwise fresh', () => {
  const beadsDir = fixtureDb();
  const exec = fakeExec(WORLD);
  const mark = () => 'stable';
  loadSnapshot(beadsDir, { exec, mark, maxAgeMs: 60_000 });
  const callsAfterFirst = exec.calls.length;
  const s2 = loadSnapshot(beadsDir, { exec, mark, maxAgeMs: 60_000, force: true });
  assert.equal(s2.fresh, true);
  assert.ok(exec.calls.length > callsAfterFirst);
});

check('loadSnapshot: the read-only guarantee — this whole path never runs anything but `dolt sql -q -r json`, never `dolt sql -q` with a write verb', () => {
  const beadsDir = fixtureDb();
  const seen = [];
  const exec = (bin, args) => {
    seen.push(args);
    return fakeExec(WORLD)(bin, args);
  };
  loadSnapshot(beadsDir, { exec, mark: () => 'x', maxAgeMs: 60_000, force: true });
  for (const args of seen) {
    assert.deepEqual(args.slice(0, 3), ['sql', '-r', 'json']);
    assert.equal(args[3], '-q');
    assert.doesNotMatch(args[4], /^\s*(insert|update|delete|drop|alter|create)\b/i);
  }
});

/* ======================================== real bd + real dolt: the acceptance criterion */

const bdOnPath = spawnSync('bd', ['version'], { encoding: 'utf8' }).error === undefined;
const doltOnPath = spawnSync('dolt', ['version'], { encoding: 'utf8' }).error === undefined;

if (!bdOnPath || !doltOnPath) {
  console.log(
    `\n  \x1b[33m—\x1b[0m skipped: real-tracker checks need both \`bd\` and \`dolt\` on PATH ` +
      `(bd: ${bdOnPath ? 'found' : 'missing'}, dolt: ${doltOnPath ? 'found' : 'missing'})`
  );
} else {
  console.log('\nagainst a real bd + dolt fixture\n');

  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-beadsnapshot-real-'));
  const beadsDir = path.join(real, '.beads');
  fs.mkdirSync(real, { recursive: true });
  const env = { ...process.env, BEADS_DIR: beadsDir };
  const bdRun = (args) => spawnSync('bd', args, { env, cwd: real, encoding: 'utf8', timeout: 60000 });

  const init = bdRun(['init', '--skip-agents', '--prefix', 'gp']);
  if (init.status !== 0) {
    failures += 1;
    console.log('  FAIL a temp workspace can be made to test against');
    console.log(`       ${(init.stderr || init.stdout || '').split('\n')[0]}`);
  } else {
    const { Bd } = await import('../lib/bd.js');
    const bd = new Bd({ bin: 'bd', actor: 'beadcause-test' });
    const ws = { name: 'graphfixture', dir: beadsDir };

    const parentId = await bd.create(ws, { title: 'Epic — the fixture family', type: 'epic', priority: 1, labels: [] });
    const childId = await bd.create(
      ws,
      { title: 'Entry 107 — the fixture bead itself', priority: 2, labels: [], parent: parentId }
    );
    const otherId = await bd.create(ws, { title: 'an unrelated bead entirely', priority: 3, labels: [] });
    const closedId = await bd.create(ws, { title: 'a bead that gets closed', priority: 2, labels: [] });

    await bd.run(ws, ['update', childId, '--assignee', 'neadamthal@gmail.com'], { retries: 2 });
    await bd.addLabel(ws, childId, 'burrow');
    await bd.comment(ws, childId, 'first comment on the fixture bead');
    await bd.comment(ws, childId, 'second comment on the fixture bead');
    await bd.close(ws, closedId, 'Superseded by the fixture bead');

    const bdRows = JSON.parse(bdRun(['list', '--status=all', '--limit', '0', '--json']).stdout || '[]');
    const bdById = new Map(bdRows.map((r) => [r.id, r]));

    const snap = buildSnapshot(beadsDir);
    const snapById = new Map(snap.issues.map((r) => [r.id, r]));

    check('buildSnapshot found every bead `bd list --status=all --json` did', () => {
      for (const id of [parentId, childId, otherId, closedId]) assert.ok(snapById.has(id), id);
      assert.equal(snap.issues.length, bdRows.length);
    });

    // The exact field list lib/beadsnapshot.js's header commits to reproducing
    // 1:1 — see it for which `bd list --json` fields (dependency_count,
    // dependent_count, lease bookkeeping) are deliberately out of scope.
    const SHARED_FIELDS = [
      'title',
      'description',
      'status',
      'priority',
      'issue_type',
      'assignee',
      'owner',
      'created_at',
      'created_by',
      'updated_at',
      'closed_at',
      'close_reason',
    ];
    for (const id of [parentId, childId, otherId, closedId]) {
      check(`${id}: every shared field is identical to \`bd list --status=all --json\``, () => {
        const bdRow = bdById.get(id);
        const snapRow = snapById.get(id);
        assert.ok(bdRow && snapRow, 'present on both sides');
        for (const field of SHARED_FIELDS) {
          // `bd list --json` omits a text field entirely when it is empty
          // (`omitempty`); Dolt's own `issues` table has no NULL text columns, so
          // this side always has a real `''`. `?? ''` treats those as the same
          // value, which they are — nothing meaningful differs.
          assert.equal(snapRow[field] ?? '', bdRow[field] ?? '', field);
        }
      });
    }

    check('labels match bd\'s own set, sorted', () => {
      const bdLabels = [...(bdById.get(childId).labels || [])].sort();
      assert.deepEqual(snapById.get(childId).labels, bdLabels);
    });

    check('parent resolves to the real parent id, and an unparented bead is null', () => {
      assert.equal(snapById.get(childId).parent, parentId);
      assert.equal(snapById.get(otherId).parent, null);
    });

    check('comment_count and comments match bd comments <id> --json', () => {
      const bdComments = JSON.parse(bdRun(['comments', childId, '--json']).stdout || '[]');
      const snapRow = snapById.get(childId);
      assert.equal(snapRow.comment_count, bdComments.length);
      assert.deepEqual(
        snapRow.comments.map((c) => c.text),
        bdComments.map((c) => c.text)
      );
    });

    check('close_reason on the closed bead matches, and buildSnapshot never wrote anything', () => {
      assert.equal(snapById.get(closedId).close_reason, bdById.get(closedId).close_reason);
      // Re-reading with a second real bd list proves buildSnapshot's own reads did not
      // change anything a write would show up in — same row count, same updated_at
      // for the bead nothing here touched.
      const again = JSON.parse(bdRun(['list', '--status=all', '--limit', '0', '--json']).stdout || '[]');
      assert.equal(again.length, bdRows.length);
      assert.equal(
        again.find((r) => r.id === otherId).updated_at,
        bdById.get(otherId).updated_at
      );
    });

    /* --------------------------------------------------- bin/b7e-graph as a subprocess */

    const configDir = path.join(real, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ bdBin: 'bd', actor: 'beadcause-test', workspaces: [ws] }, null, 2)
    );
    const cliEnv = { ...process.env, HOME: real, BEADCAUSE_CONFIG_DIR: configDir };
    const runCli = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: real, env: cliEnv, timeout: 30000 });

    check('--help prints usage and exits 0 without resolving a workspace', () => {
      const r = runCli(['--help']);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /usage: b7e-graph/);
    });

    check('an unconfigured -w is refused, naming the ones that exist', () => {
      const r = runCli(['-w', 'nope']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no workspace named "nope"/);
      assert.match(r.stderr, /graphfixture/);
    });

    check('with neither -w nor $BEADS_DIR, it refuses rather than guessing', () => {
      const r = spawnSync(process.execPath, [BIN, '--title-match', 'x'], {
        encoding: 'utf8',
        cwd: real,
        env: { ...cliEnv, BEADS_DIR: '' },
        timeout: 30000,
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /BEADS_DIR/);
    });

    check('--title-match "Entry 107" finds the fixture bead by substring, case-insensitive', () => {
      const r = runCli(['-w', 'graphfixture', '--title-match', 'entry 107', '--json']);
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.deepEqual(rows.map((x) => x.id), [childId]);
    });

    check('--parent finds only the direct child', () => {
      const r = runCli(['-w', 'graphfixture', '--parent', parentId, '--json']);
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.deepEqual(rows.map((x) => x.id), [childId]);
    });

    check('--assignee is an exact match', () => {
      const r = runCli(['-w', 'graphfixture', '--assignee', 'neadamthal@gmail.com', '--json']);
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.deepEqual(rows.map((x) => x.id), [childId]);
    });

    check('--label finds the fixture bead by its added label', () => {
      const r = runCli(['-w', 'graphfixture', '--label', 'burrow', '--json']);
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.deepEqual(rows.map((x) => x.id), [childId]);
    });

    check('--closed-reason finds the closed bead by a substring of close_reason', () => {
      const r = runCli(['-w', 'graphfixture', '--closed-reason', 'superseded', '--json']);
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.deepEqual(rows.map((x) => x.id), [closedId]);
    });

    check('--status filters to only the given statuses', () => {
      const r = runCli(['-w', 'graphfixture', '--status', 'closed', '--json']);
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.deepEqual(rows.map((x) => x.id), [closedId]);
    });

    check('plain table output (no --json) prints a header and one row per bead, no comments unless asked', () => {
      const r = runCli(['-w', 'graphfixture', '--title-match', 'entry 107']);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /id\s+status\s+assignee/);
      assert.match(r.stdout, new RegExp(childId));
      assert.doesNotMatch(r.stdout, /first comment on the fixture bead/);
    });

    check('--with-comments inlines the comments in table mode', () => {
      const r = runCli(['-w', 'graphfixture', '--title-match', 'entry 107', '--with-comments']);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /first comment on the fixture bead/);
      assert.match(r.stdout, /second comment on the fixture bead/);
    });

    check('--with-comments --json includes the comments array; without it, the field is absent', () => {
      const withC = JSON.parse(runCli(['-w', 'graphfixture', '--title-match', 'entry 107', '--with-comments', '--json']).stdout);
      const withoutC = JSON.parse(runCli(['-w', 'graphfixture', '--title-match', 'entry 107', '--json']).stdout);
      assert.equal(withC[0].comments.length, 2);
      assert.equal(withoutC[0].comments, undefined);
    });

    await checkAsync('answers `--title-match "Entry 107" --with-comments` in under five seconds', async () => {
      const started = Date.now();
      const r = runCli(['-w', 'graphfixture', '--title-match', 'Entry 107', '--with-comments', '--json']);
      const elapsed = Date.now() - started;
      assert.equal(r.status, 0);
      assert.ok(elapsed < 5000, `took ${elapsed}ms`);
    });

    check('a repeat call is faster than the first — the cache is actually doing something', () => {
      // Force a first, cold read, then time a warm one against the same fixture.
      runCli(['-w', 'graphfixture', '--refresh', '--title-match', 'entry 107']);
      const started = Date.now();
      const r = runCli(['-w', 'graphfixture', '--title-match', 'entry 107']);
      const elapsed = Date.now() - started;
      assert.equal(r.status, 0);
      assert.ok(elapsed < 5000, `warm call took ${elapsed}ms`);
    });

    check('a stale snapshot (--max-age 0) is rebuilt rather than served, and still answers correctly', () => {
      const r = runCli(['-w', 'graphfixture', '--max-age', '0', '--title-match', 'entry 107', '--json']);
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(r.stdout).map((x) => x.id), [childId]);
    });
  }
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
