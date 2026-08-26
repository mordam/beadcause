#!/usr/bin/env node
/**
 * `b7e-moment` — what else was this machine doing at a given instant. lib/moment.js and
 * bin/b7e-moment.
 *
 *     npm test
 *     node test/b7emoment.mjs
 *
 * bc-dgx7.55's own acceptance criteria are what this replays: pointed with
 * `--log`/`--deploys` at a fixture whose contents are known, it names the deploy, the
 * merges and the sibling beads inside the window, and prints an explicit "nothing" for
 * each source that has none; run against the real bc-l8ub it reproduces the 18:33/18:36
 * pairing with bc-y8wf; and the daemon log is read by streaming, never buffered whole.
 *
 * Two halves: `lib/moment.js`'s pure functions and `scanLog`, checked directly and
 * fast; then `bin/b7e-moment` itself, spawned for real against fixtures — a fake `bd`
 * reading a small mutable `world.json` (same shape as test/b7ehandback.mjs) for the
 * bead-id path, and plain files for `--log`/`--deploys`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';
import {
  parseWindow,
  windowFor,
  occurrencesFrom,
  siblingsIn,
  deploysIn,
  deploysFrom,
  mergesIn,
  classifyLine,
  scanLog,
  LOG_LINE_CAP,
} from '../lib/moment.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-moment');

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
const acheck = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

console.log('\nb7e-moment — what else was this machine doing at a moment\n');
console.log('lib/moment.js — the pure functions\n');

check('parseWindow reads minutes, seconds, hours and a bare number as minutes', () => {
  assert.equal(parseWindow('15m'), 15 * 60_000);
  assert.equal(parseWindow('90s'), 90_000);
  assert.equal(parseWindow('2h'), 2 * 3_600_000);
  assert.equal(parseWindow('30'), 30 * 60_000);
  assert.equal(parseWindow('bogus'), null);
  assert.equal(parseWindow(''), null);
});

check('windowFor centres on `at` and widens by windowMs either side', () => {
  const w = windowFor('2026-08-22T18:36:30.000Z', 15 * 60_000);
  assert.equal(w.at, '2026-08-22T18:36:30.000Z');
  assert.equal(w.start, '2026-08-22T18:21:30.000Z');
  assert.equal(w.end, '2026-08-22T18:51:30.000Z');
  assert.equal(windowFor('not a date', 1000), null);
});

check('occurrencesFrom picks out only the occurrence-note shapes lib/errors.js writes', () => {
  const comments = [
    { text: 'an ordinary comment', created_at: '2026-08-01T00:00:00Z' },
    { text: '**Occurrence 2** — 2026-08-02T00:00:00Z, on /console from app.js:10.', created_at: '2026-08-02T00:00:00Z' },
    { text: '**It happened again** — 2026-08-03T00:00:00Z, on /console.', created_at: '2026-08-03T00:00:00Z' },
    { text: '**4 more occurrences** — between a and b, on /console.', created_at: '2026-08-04T00:00:00Z' },
  ];
  const found = occurrencesFrom(comments);
  assert.equal(found.length, 3);
  assert.equal(found[0].at, '2026-08-02T00:00:00Z', 'sorted oldest first');
});

check('occurrencesFrom on a bead that has never recurred is empty, not absent', () => {
  assert.deepEqual(occurrencesFrom([{ text: 'unrelated', created_at: '2026-08-01T00:00:00Z' }]), []);
  assert.deepEqual(occurrencesFrom([]), []);
  assert.deepEqual(occurrencesFrom(null), []);
});

check('siblingsIn keeps only other beads created inside the window, sorted by time', () => {
  const rows = [
    { id: 'bc-a', created_at: '2026-08-22T18:10:00Z' }, // before window
    { id: 'bc-b', created_at: '2026-08-22T18:33:16Z' }, // inside
    { id: 'bc-c', created_at: '2026-08-22T18:36:30Z' }, // this is the target — excluded
    { id: 'bc-d', created_at: '2026-08-22T19:10:00Z' }, // after window
    { id: 'bc-e', created_at: null }, // unparseable — dropped, not crashed on
  ];
  const win = { start: '2026-08-22T18:21:30Z', end: '2026-08-22T18:51:30Z' };
  const found = siblingsIn(rows, { ...win, exclude: 'bc-c' });
  assert.deepEqual(
    found.map((r) => r.id),
    ['bc-b']
  );
});

check('deploysIn keeps a record whose life overlaps the window, in-flight or not', () => {
  const win = { start: '2026-08-22T18:21:30Z', end: '2026-08-22T18:51:30Z' };
  const records = [
    { id: 'before', requestedAt: '2026-08-22T17:00:00Z', finishedAt: '2026-08-22T17:05:00Z' }, // long before
    { id: 'spans', requestedAt: '2026-08-22T18:00:00Z', finishedAt: '2026-08-22T19:00:00Z' }, // spans it
    { id: 'inFlight', requestedAt: '2026-08-22T18:40:00Z' }, // no finishedAt — still running
    { id: 'after', requestedAt: '2026-08-22T20:00:00Z', finishedAt: '2026-08-22T20:05:00Z' },
  ];
  const now = Date.parse('2026-08-22T18:45:00Z');
  const found = deploysIn(records, win, now).map((r) => r.id);
  assert.deepEqual(found.sort(), ['inFlight', 'spans'].sort());
});

check('classifyLine matches the exact shapes the real daemon log uses', () => {
  assert.equal(classifyLine('2026-08-22T18:33:12Z [cache] board: gave up its refresh slot after 150s'), 'cache');
  assert.equal(classifyLine('2026-08-22T18:33:12Z [beadcause] slow GET /api/queues 150057ms cold'), 'slow');
  assert.equal(classifyLine('2026-08-22T18:33:12Z Error: something broke'), 'error');
  assert.equal(classifyLine('2026-08-22T18:33:12Z [beadcause] an ordinary line'), null);
});

const scanTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7emoment-'));

await acheck('scanLog keeps only lines inside the window and counts slow/[cache]/error', async () => {
  const logFile = path.join(scanTmp, 'small.log');
  fs.writeFileSync(
    logFile,
    [
      '2026-08-22T18:10:00.000Z [beadcause] before the window',
      '2026-08-22T18:33:12.100Z [beadcause] slow GET /api/queues 150057ms cold',
      '2026-08-22T18:33:12.200Z [cache] board: gave up its refresh slot after 150s',
      '2026-08-22T18:33:12.300Z Error: something broke',
      '  a continuation line with no stamp of its own',
      '2026-08-22T18:50:00.000Z [beadcause] after the window',
      '',
    ].join('\n')
  );
  const win = windowFor('2026-08-22T18:33:12Z', 15 * 60_000);
  const r = await scanLog(logFile, win);
  assert.equal(r.exists, true);
  assert.equal(r.lines.length, 4, 'the 3 stamped lines in the window plus their unstamped continuation');
  assert.deepEqual(r.counts, { slow: 1, cache: 1, error: 1 });
  assert.equal(r.lines[3].text.trim(), 'a continuation line with no stamp of its own');
  assert.equal(r.lines[3].at, null, 'a continuation carries no stamp of its own, even though it counted');
});

await acheck('scanLog on a file that does not exist says so rather than throwing', async () => {
  const win = windowFor('2026-08-22T18:33:12Z', 60_000);
  const r = await scanLog(path.join(scanTmp, 'nope.log'), win);
  assert.equal(r.exists, false);
  assert.deepEqual(r.lines, []);
});

await acheck('scanLog caps the lines it keeps and still counts what it drops', async () => {
  const logFile = path.join(scanTmp, 'many.log');
  const at = Date.parse('2026-08-22T18:33:00.000Z');
  const lines = [];
  for (let i = 0; i < LOG_LINE_CAP + 40; i += 1) {
    lines.push(`${new Date(at + i).toISOString()} [beadcause] line ${i}`);
  }
  fs.writeFileSync(logFile, lines.join('\n') + '\n');
  const win = windowFor('2026-08-22T18:33:00.000Z', 60_000);
  const r = await scanLog(logFile, win);
  assert.equal(r.lines.length, LOG_LINE_CAP);
  assert.equal(r.omitted, 40);
});

await acheck('scanLog never calls a whole-file read function while scanning a multi-MB file', async () => {
  const logFile = path.join(scanTmp, 'big.log');
  const fd = fs.openSync(logFile, 'w');
  // Well outside the window, so every line is walked and none is retained — this
  // exercises the full file, not just the handful of lines the other checks use.
  const line = `2026-01-01T00:00:00.000Z [beadcause] ${'x'.repeat(200)}\n`;
  const chunk = line.repeat(2000);
  const targetBytes = 6 * 1024 * 1024; // a few MB — cheap enough for `npm test`, big enough that a whole-file read would show
  let written = 0;
  while (written < targetBytes) {
    fs.writeSync(fd, chunk);
    written += Buffer.byteLength(chunk);
  }
  fs.closeSync(fd);
  assert.ok(fs.statSync(logFile).size > 5 * 1024 * 1024, 'fixture really is multi-MB');

  // A heap-size diff around the call was tried first and dropped: `global.gc` is only
  // available under `--expose-gc`, which plain `node test/b7emoment.mjs` does not pass,
  // so the "before"/"after" heap reading was really measuring whatever V8 had not yet
  // collected — noisy in a way that would flake this suite under load, not a real
  // signal. Watching for the actual whole-file APIs (`fs.readFileSync`,
  // `fs.promises.readFile`) being called on this exact path is a direct, deterministic
  // check of the same claim instead of a proxy for it.
  const originalReadFileSync = fs.readFileSync;
  const originalReadFile = fs.promises.readFile;
  let calledWhole = false;
  fs.readFileSync = (...args) => {
    if (path.resolve(String(args[0])) === logFile) calledWhole = true;
    return originalReadFileSync(...args);
  };
  fs.promises.readFile = (...args) => {
    if (path.resolve(String(args[0])) === logFile) calledWhole = true;
    return originalReadFile(...args);
  };
  let r;
  try {
    const win = windowFor('2026-08-22T18:33:00.000Z', 60_000); // matches none of the fixture's lines
    r = await scanLog(logFile, win);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.promises.readFile = originalReadFile;
  }
  assert.equal(r.lines.length, 0, 'every line in the fixture is outside the window');
  assert.equal(calledWhole, false, 'scanLog read the log with a whole-file API rather than streaming it');
});

check('lib/moment.js\'s scanLog never calls a whole-file read on the log path', () => {
  // A static backstop beside the functional one above: `fs.readFileSync`/`fs.readFile(`
  // on `logFile` would defeat the whole point even if it happened to pass the memory
  // check on a quiet machine.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'moment.js'), 'utf8');
  const scanLogSrc = src.slice(src.indexOf('export async function scanLog'));
  assert.ok(!/readFileSync\(logFile|readFile\(logFile/.test(scanLogSrc));
  assert.ok(/createReadStream/.test(scanLogSrc));
});

/* --------------------------------------------------------------------------- mergesIn */

const gitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7emoment-git-'));
execFileSync('git', ['init', '-q'], { cwd: gitTmp });
// Oldest first, matching how a real history is actually built — `git log
// --since/--until` stops walking as soon as it meets a commit older than `--since`,
// so a child committed *earlier* than its own parent (which reversing this order would
// produce) would hide every ancestor behind it, however recent. That is a real git
// footgun, not a fixture detail: it is exactly what a rebase or a bad system clock
// produces, and it is worth knowing this reader inherits it from `git log` itself.
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'long before it'], {
  cwd: gitTmp,
  env: { ...process.env, GIT_AUTHOR_DATE: '2026-08-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-08-01T00:00:00Z' },
});
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'inside the window'], {
  cwd: gitTmp,
  env: { ...process.env, GIT_AUTHOR_DATE: '2026-08-22T18:33:00Z', GIT_COMMITTER_DATE: '2026-08-22T18:33:00Z' },
});

await acheck('mergesIn finds only the commit inside the window', async () => {
  const win = windowFor('2026-08-22T18:33:00Z', 15 * 60_000);
  const r = await mergesIn(gitTmp, win);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.commits.length, 1);
  assert.equal(r.commits[0].subject, 'inside the window');
});

await acheck('mergesIn on a directory with no git repo answers with an error, not a throw', async () => {
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7emoment-nogit-'));
  const win = windowFor('2026-08-22T18:33:00Z', 60_000);
  const r = await mergesIn(notGit, win);
  assert.ok(r.error, 'a directory with no repo says so rather than throwing');
  cleanupTmp(notGit);
});

/* -------------------------------------------------------------------- deploysFrom fixture */

const deployTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7emoment-deploys-'));
fs.writeFileSync(
  path.join(deployTmp, 'abc123.json'),
  JSON.stringify({ id: 'abc123', workspace: 'beadcause', status: 'succeeded', requestedAt: '2026-08-22T18:32:00Z', finishedAt: '2026-08-22T18:34:00Z' })
);
fs.writeFileSync(path.join(deployTmp, 'not-json.json'), 'not valid json at all');
fs.writeFileSync(path.join(deployTmp, 'ignored.txt'), 'not a deploy record');

check('deploysFrom reads a directory of records, dropping unreadable ones silently', () => {
  const rows = deploysFrom(deployTmp);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'abc123');
});

check('deploysFrom on a directory that does not exist is empty, not a throw', () => {
  assert.deepEqual(deploysFrom(path.join(deployTmp, 'nope')), []);
});

console.log('\nbin/b7e-moment — the CLI\n');

/* ------------------------------------------------------------------------- CLI: fixtures */

check('--at with --log/--deploys fixtures names the deploy and prints explicit "nothing" for empty sources', () => {
  const logFile = path.join(scanTmp, 'small.log');
  const res = spawnSync(process.execPath, [BIN, '--at', '2026-08-22T18:33:12Z', '--window', '15m', '--log', logFile, '--deploys', deployTmp], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /abc123\s+2026-08-22T18:32:00Z .. 2026-08-22T18:34:00Z/);
  // The header is printed bold, so an ANSI reset sits between the colon and the
  // newline — `.*` covers that escape without hard-coding the exact codes used.
  assert.match(res.stdout, /sibling app-error beads in the window:.*\n\s*nothing/);
  assert.match(res.stdout, /slow GET \/api\/queues 150057ms cold/);
  assert.match(res.stdout, /\[cache\] board: gave up its refresh slot/);
});

check('--json carries the same five keys the printed report is built from', () => {
  const logFile = path.join(scanTmp, 'small.log');
  const res = spawnSync(process.execPath, [BIN, '--at', '2026-08-22T18:33:12Z', '--window', '15m', '--log', logFile, '--deploys', deployTmp, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(payload).sort(), ['bead', 'deploys', 'log', 'merges', 'siblings', 'window'].sort());
  assert.equal(payload.bead, null, 'no bead id was given');
  assert.equal(payload.deploys[0].id, 'abc123');
  assert.equal(payload.log.counts.slow, 1);
});

check('a log fixture that does not exist is reported as "does not exist", not a crash', () => {
  const res = spawnSync(process.execPath, [BIN, '--at', '2026-08-22T18:33:12Z', '--log', path.join(scanTmp, 'nope.log')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /does not exist on this Mac/);
});

/* --------------------------------------------------------------------------- CLI: usage */

check('neither a bead id nor --at is a usage error', () => {
  const res = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /need a bead id or --at/);
});

check('a bead id and --at together is a usage error, not a silent pick', () => {
  const res = spawnSync(process.execPath, [BIN, 'bc-x', '--at', '2026-08-22T18:33:12Z'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /two ways of naming the same moment/);
});

check('an unparseable --at is refused before anything else runs', () => {
  const res = spawnSync(process.execPath, [BIN, '--at', 'not-a-timestamp'], { encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not a parseable timestamp/);
});

check('an unparseable --window is refused with the bad value named', () => {
  const res = spawnSync(process.execPath, [BIN, '--at', '2026-08-22T18:33:12Z', '--window', 'bogus'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--window "bogus" doesn't look like a duration/);
});

console.log('\nbin/b7e-moment — the bead-id path, against a fake bd\n');

/* ------------------------------------------------------------------ CLI: fake-bd fixture */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7emoment-cli-'));
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
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found matching "' + args[1] + '"');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'list' && args[1] === '--label') {
  const label = args[2];
  const rows = Object.values(w.issues).filter((i) => (i.labels || []).includes(label));
  process.stdout.write(JSON.stringify(rows));
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
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }] }, null, 2)
);

const worldFile = path.join(wsDir, 'world.json');
fs.writeFileSync(
  worldFile,
  JSON.stringify({
    issues: {
      'bc-target': {
        id: 'bc-target',
        title: 'GET /api/queues failed',
        status: 'open',
        created_at: '2026-08-22T18:36:30.000Z',
        labels: ['app-error'],
        comments: [
          { text: '**Occurrence 2** — 2026-08-22T19:00:00Z, on /console.', created_at: '2026-08-22T19:00:00Z' },
          { text: 'an ordinary comment, not an occurrence note', created_at: '2026-08-22T19:05:00Z' },
        ],
      },
      'bc-sibling': {
        id: 'bc-sibling',
        title: 'GET /api/poll failed',
        status: 'closed',
        created_at: '2026-08-22T18:33:16.000Z',
        labels: ['app-error'],
        comments: [],
      },
      'bc-other': {
        id: 'bc-other',
        title: 'not an error bead',
        status: 'open',
        created_at: '2026-08-22T18:34:00.000Z',
        labels: [],
        comments: [],
      },
    },
  })
);

const runCli = (args) =>
  spawnSync(process.execPath, [BIN, '-w', 'demo', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });

check('a bead id reads its own created_at, its own occurrence, and a sibling app-error bead — never the unlabelled one', () => {
  const res = runCli(['bc-target', '--window', '15m', '--log', path.join(scanTmp, 'nope.log'), '--deploys', path.join(deployTmp, 'nope')]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Moment: 2026-08-22T18:36:30\.000Z/);
  assert.match(res.stdout, /Occurrence 2.*2026-08-22T19:00:00Z/);
  assert.match(res.stdout, /bc-sibling\s+2026-08-22T18:33:16\.000Z/);
  assert.ok(!res.stdout.includes('bc-other'), 'a bead with no app-error label is never a sibling');
});

check('--json on the bead-id path carries the bead id and its occurrences', () => {
  const res = runCli(['bc-target', '--json', '--log', path.join(scanTmp, 'nope.log'), '--deploys', path.join(deployTmp, 'nope')]);
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.bead.id, 'bc-target');
  assert.equal(payload.bead.occurrences.length, 1);
  assert.equal(payload.siblings[0].id, 'bc-sibling');
});

check('an unknown bead id is refused with its own exit code, distinct from a workspace read failure', () => {
  const res = runCli(['bc-nope-at-all']);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /no such bead in demo/);
});

check('an unknown workspace is refused before any bd call', () => {
  const res = spawnSync(process.execPath, [BIN, '-w', 'nowhere', 'bc-target'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  assert.equal(res.status, 4);
  assert.match(res.stderr, /no workspace named "nowhere"/);
});

console.log(`\n${ran - failures}/${ran} passed`);
cleanupTmp(scanTmp);
cleanupTmp(gitTmp);
cleanupTmp(deployTmp);
cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
