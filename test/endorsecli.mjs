#!/usr/bin/env node
/**
 * Endorsing from a session — the preflight, and the one thing the command must never do.
 *
 *     npm test
 *     node test/endorsecli.mjs
 *
 * bc-7cp1. `unendorsed` is the label that decides whether an unattended agent session may
 * be opened on a bead nobody has read (lib/endorse.js), and `bin/endorse.js` is a way to
 * take it off from a terminal. That is a genuinely useful thing and it is also the exact
 * shape of the accident already on the record: one press of "Endorse all" cleared
 * twenty-five ship beads, because the press acted on a list nothing had named
 * (lib/shipbead.js).
 *
 * So the suite is about the edges rather than the happy path, and there are four of them:
 *
 * 1. **Every bead is named, and one refusal refuses the run.** Not "mostly applied and
 *    reported" — `verdictIds` in lib/server.js already argues that a group with one bad
 *    id should be refused whole, and it matters more from a command line, where the ids
 *    were typed one at a time and a re-run costs one line.
 *
 * 2. **A closed bead carrying the marker is refused.** This one is not obvious and is
 *    easy to "fix" in the wrong direction. The marker is deliberately left on a revoked
 *    bead so `bd list --label unendorsed` stays the honest record of what was filed and
 *    never worked; endorsing one erases that and starts nothing, because nothing opens a
 *    session on a closed bead.
 *
 * 3. **Already endorsed is not an error.** The route is idempotent by construction and
 *    the CLI must not be stricter than it, or a group of three where one was tapped on
 *    the phone a minute ago would refuse all three.
 *
 * 4. **It goes through the daemon and takes no label off itself.** This is asserted
 *    against the source, because it is the property no behavioural test can see: a
 *    `bd label remove` would leave the bead endorsed and every other device still drawing
 *    it as held until a cache turned over. It is also the shortcut anybody optimising
 *    this file would reach for first.
 *
 * There is deliberately no test for an `--all` or a filter, because there is deliberately
 * no `--all` or filter — and #4's assertion is what would catch one arriving.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * A file with its comments taken out — what the last three checks assert against.
 *
 * The first draft of them read the whole source, and both failed on their own
 * documentation: `bin/endorse.js` explains at length *why* it does not run
 * `bd label remove`, and `lib/endorsecli.js` cites `bd list --label unendorsed` as the
 * history a closed bead's marker preserves. A shape assertion that a file cannot
 * describe its own reasoning without tripping is one that gets deleted the first time it
 * is in somebody's way, so it reads the code.
 */
const codeOf = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-endorsecli-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { endorsePlan, idsProblem, normalizeIds, readResult, MAX_IDS } = await import(
  path.join(ROOT, 'lib', 'endorsecli.js')
);

/* ------------------------------------------------------------------- the fixtures */

const row = (id, { labels = [], status = 'open', title = `bead ${id}` } = {}) => ({
  id,
  title,
  status,
  labels,
});

const HELD = row('zz-a', { labels: ['agent-filed', 'unendorsed'] });
const HELD_TOO = row('zz-b', { labels: ['unendorsed'] });
const ENDORSED = row('zz-c', { labels: ['agent-filed'] });
const CLOSED_HELD = row('zz-d', { labels: ['unendorsed'], status: 'closed' });
const CLOSED_ENDORSED = row('zz-e', { labels: [], status: 'closed' });
const SHIP = row('zz-f', { labels: ['ship', 'unendorsed'] });
const HELD_HUMAN = row('zz-g', { labels: ['unendorsed', 'human'] });
const HELD_BLOCKED = row('zz-h', { labels: ['unendorsed'], status: 'blocked' });

const ALL = [HELD, HELD_TOO, ENDORSED, CLOSED_HELD, CLOSED_ENDORSED, SHIP, HELD_HUMAN, HELD_BLOCKED];

/* ------------------------------------------------------------------- a stub tracker */

/**
 * A `bd` that answers `show` for the fixtures above and nothing else.
 *
 * It reproduces the one behaviour the CLI leans on and would otherwise have to guess at:
 * `bd show a b c` prints the rows it found, complains on stderr about the ones it did
 * not, and exits 0 — *unless* it found none at all, where it exits 1 with an `{error}`
 * object on stdout rather than an array. Measured against the real bd 1.1.2 on
 * 2026-08-17; both shapes reach `endorsePlan` as "no row for that id".
 */
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const ALL = ${JSON.stringify(ALL)};
if (args[0] !== 'show') { process.stderr.write('unexpected: ' + args.join(' ') + '\\n'); process.exit(2); }
const ids = args.slice(1).filter((a) => !a.startsWith('--'));
const found = ids.map((id) => ALL.find((r) => r.id === id)).filter(Boolean);
for (const id of ids) if (!found.some((r) => r.id === id)) {
  process.stderr.write('Error fetching ' + id + ': no issue found matching "' + id + '"\\n');
}
if (!found.length) {
  process.stdout.write(JSON.stringify({ error: 'no issues found matching the provided IDs' }));
  process.exit(1);
}
process.stdout.write(JSON.stringify(found));
`,
  { mode: 0o755 }
);

const WS = { name: 'zz', dir: path.join(tmp, 'zz', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', token: 'test-token', workspaces: [WS] }, null, 2)
);

/* -------------------------------------------------------------------- a stub daemon */

/** Every request the CLI made, so the body it posts can be asserted rather than assumed. */
const posted = [];
/** What the next POST is answered with. Set per test. */
let answer = { status: 200, body: {} };

const daemon = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    posted.push({ url: req.url, token: req.headers['x-beadcause-token'], body: JSON.parse(raw || '{}') });
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
});
await new Promise((done) => daemon.listen(0, '127.0.0.1', done));
const URL_BASE = `http://127.0.0.1:${daemon.address().port}`;

/**
 * Run the command the way a skill would, against the stub tracker and the stub daemon.
 *
 * **Asynchronous on purpose, and it must stay that way.** `spawnSync` blocks this
 * process's event loop until the child exits, and the daemon the child is posting to is
 * listening *on this loop* — so a synchronous spawn is a deadlock with no error message,
 * just a suite that hangs until something kills it. Awaiting `spawn` keeps the server
 * answering while the child runs.
 */
function run(args, { url = URL_BASE, workspace = WS.name } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'endorse.js'), '-w', workspace, '--url', url, ...args], {
      env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

/** The 200 the route gives for a list that all applied — `verdictBody` over `applyVerdict`. */
const applied = (ids) => ({
  status: 200,
  body: {
    workspace: WS.name,
    ok: true,
    verdict: 'endorse',
    results: ids.map((id) => ({ id, verdict: 'endorse', ok: true, endorsed: true, title: `bead ${id}` })),
    applied: ids,
    failed: [],
  },
});

/* --------------------------------------------------------------------- the harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

console.log('\nendorsing beads from a session\n');

/* ------------------------------------------------------- 1. the plan, without a tracker */

await check('a held bead is what gets posted, and nothing else is invented', async () => {
  const plan = endorsePlan(ALL, ['zz-a']);
  assert.deepEqual(
    plan.post.map((p) => p.id),
    ['zz-a']
  );
  assert.equal(plan.refused.length, 0);
  assert.equal(plan.already.length, 0);
  assert.equal(plan.ok, true);
});

await check('an id the tracker has never heard of is a refusal, not a silent drop', async () => {
  const plan = endorsePlan(ALL, ['zz-a', 'zz-nope']);
  assert.equal(plan.ok, false, 'a typo passed the preflight');
  assert.deepEqual(
    plan.refused.map((r) => [r.id, r.code]),
    [['zz-nope', 'missing']]
  );
  // Still computed for the good one, so the report can say what it *would* have done.
  assert.deepEqual(
    plan.post.map((p) => p.id),
    ['zz-a']
  );
});

await check('a closed bead that still carries the marker is refused, and the reason says why', async () => {
  const plan = endorsePlan(ALL, ['zz-d']);
  assert.equal(plan.ok, false);
  assert.equal(plan.refused[0].code, 'closed');
  assert.match(plan.refused[0].why, /record that it was never worked/, 'the refusal does not explain the history');
  assert.equal(plan.post.length, 0);
});

await check('a closed bead that is already endorsed is nothing to do, not a refusal', async () => {
  // Different fact from the one above, and the distinction is the whole point: there is
  // no marker to erase here, so there is nothing to protect and nothing to complain about.
  const plan = endorsePlan(ALL, ['zz-e']);
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.already.map((a) => a.id),
    ['zz-e']
  );
  assert.equal(plan.already[0].closed, true);
});

await check('a ship bead is refused — endorsing one means nothing and only a deploy closes it', async () => {
  const plan = endorsePlan(ALL, ['zz-f']);
  assert.equal(plan.ok, false);
  assert.equal(plan.refused[0].code, 'ship');
});

await check('an already-endorsed bead does not refuse the beads beside it', async () => {
  const plan = endorsePlan(ALL, ['zz-a', 'zz-c', 'zz-b']);
  assert.equal(plan.ok, true, 'a double tap refused a group');
  assert.deepEqual(
    plan.post.map((p) => p.id),
    ['zz-a', 'zz-b']
  );
  assert.deepEqual(
    plan.already.map((a) => a.id),
    ['zz-c']
  );
});

await check('the same bead named twice is one bead, endorsed once', async () => {
  const plan = endorsePlan(ALL, ['zz-a', 'zz-a']);
  assert.deepEqual(
    plan.post.map((p) => p.id),
    ['zz-a']
  );
  assert.deepEqual(normalizeIds([' zz-a ', 'zz-a', '', 'zz-b']), ['zz-a', 'zz-b']);
});

await check('`human` and `blocked` ride along as notes, because the endorsement still will not start anything', async () => {
  const human = endorsePlan(ALL, ['zz-g']);
  assert.equal(human.post.length, 1, 'a human bead was refused rather than noted');
  assert.match(human.post[0].notes.join(' '), /human/, 'nothing says the queue still will not take it');
  const blocked = endorsePlan(ALL, ['zz-h']);
  assert.equal(blocked.post.length, 1);
  assert.match(blocked.post[0].notes.join(' '), /bd ready/, 'nothing says it is still dep-blocked');
});

await check('no ids at all is refused, and so is a group past the route’s own limit', async () => {
  assert.match(idsProblem([]), /at least one bead/);
  assert.equal(idsProblem(['zz-a']), '');
  assert.match(idsProblem(Array.from({ length: MAX_IDS + 1 }, (_, i) => `zz-${i}`)), new RegExp(`${MAX_IDS} is the most`));
  assert.equal(MAX_IDS, 100, 'the limit drifted from lib/verdict.js');
});

await check('the result reads a bead endorsed between the read and the write as a race, not a failure', async () => {
  const plan = endorsePlan(ALL, ['zz-a', 'zz-b']);
  const out = readResult(
    {
      results: [
        { id: 'zz-a', ok: true, endorsed: true, title: 'bead zz-a' },
        { id: 'zz-b', ok: true, endorsed: false, title: 'bead zz-b' },
      ],
    },
    plan
  );
  assert.deepEqual(
    out.moved.map((r) => r.id),
    ['zz-a']
  );
  assert.deepEqual(
    out.raced.map((r) => r.id),
    ['zz-b']
  );
  assert.equal(out.failed.length, 0);
});

await check('a per-bead failure in a 200 is a failure, however cheerful the envelope', async () => {
  // `statusFor` gives a group where one bead lost a lock race a 200 with a failure row in
  // it. A client reading only the status code reports a clean endorse over a bead that
  // did not move.
  const out = readResult(
    { ok: false, results: [{ id: 'zz-a', ok: false, error: 'resource busy', status: 500 }] },
    endorsePlan(ALL, ['zz-a'])
  );
  assert.equal(out.moved.length, 0);
  assert.deepEqual(
    out.failed.map((r) => r.id),
    ['zz-a']
  );
});

/* ------------------------------------------------------------- 2. the command itself */

await check('it names every bead before it moves any of them', async () => {
  answer = applied(['zz-a', 'zz-b']);
  posted.length = 0;
  const res = await run(['zz-a', 'zz-b']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /will endorse zz-a/, 'a bead was endorsed without being named first');
  assert.match(res.stderr, /will endorse zz-b/);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, '/api/bead/endorse');
  assert.deepEqual(posted[0].body, { workspace: 'zz', ids: ['zz-a', 'zz-b'] });
  assert.equal(posted[0].token, 'test-token', 'the daemon was called without the token');
  assert.match(res.stdout, /^endorsed zz-a/m, 'stdout does not record what moved');
});

await check('one refused bead refuses the run, and nothing is posted', async () => {
  answer = applied(['zz-a']);
  posted.length = 0;
  const res = await run(['zz-a', 'zz-d']);
  assert.equal(res.status, 3, 'a group with a refused bead was not refused whole');
  assert.match(res.stderr, /REFUSED zz-d/);
  assert.equal(posted.length, 0, 'it posted anyway — the good half was applied');
});

await check('--dry-run writes nothing and says so', async () => {
  posted.length = 0;
  const res = await run(['--dry-run', 'zz-a']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(posted.length, 0, '--dry-run reached the daemon');
  assert.match(res.stderr, /nothing written/);
});

await check('a list where nothing is held posts nothing at all', async () => {
  posted.length = 0;
  const res = await run(['zz-c']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(posted.length, 0, 'it posted an empty endorse');
  assert.match(res.stderr, /nothing held/);
});

await check('a bead that fails inside a 200 is reported and exits non-zero', async () => {
  answer = {
    status: 200,
    body: {
      ok: false,
      verdict: 'endorse',
      results: [
        { id: 'zz-a', ok: true, endorsed: true, title: 'bead zz-a' },
        { id: 'zz-b', ok: false, error: 'database is busy', status: 500 },
      ],
      applied: ['zz-a'],
      failed: [{ id: 'zz-b', error: 'database is busy' }],
    },
  };
  const res = await run(['zz-a', 'zz-b']);
  assert.equal(res.status, 5, 'a partial endorse reported success');
  assert.match(res.stdout, /^endorsed zz-a/m, 'the half that landed was not reported as landed');
  assert.match(res.stderr, /could not endorse zz-b/);
});

await check('a rejected token is its own exit code, and says where to look', async () => {
  answer = { status: 401, body: { error: 'unauthorized' } };
  const res = await run(['zz-a']);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /~\/\.config\/beadcause/);
});

await check('a daemon that is not there is not mistaken for a refusal', async () => {
  // Port 1 is reserved and nothing is listening: the same shape as the launchd agent
  // being down, which must not read as "the beads were refused".
  const res = await run(['zz-a'], { url: 'http://127.0.0.1:1' });
  assert.equal(res.status, 4);
  assert.match(res.stderr, /could not reach the daemon/);
  assert.match(res.stderr, /nothing was endorsed/, 'it does not say whether anything moved');
});

await check('an unknown workspace is refused before the tracker is touched', async () => {
  posted.length = 0;
  const res = await run(['zz-a'], { workspace: 'nope' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no workspace called nope/);
  assert.equal(posted.length, 0);
});

/* ------------------------------------------------------------ 3. the shape of the thing */

await check('it endorses through the daemon and never by taking the label off itself', async () => {
  const code = codeOf('bin/endorse.js');
  assert.match(code, /\/api\/bead\/endorse/, 'it does not post to the route');
  assert.ok(
    !/removeLabel|bd\.update\(|bd\.close\(|bd\.comment\(/.test(code),
    'it writes to the tracker directly — the cache drop and the bus emit are what take a judged bead off every device'
  );
  // Reading is fine and is the preflight; writing is not.
  assert.match(code, /bd\.json\(ws, \['show'/, 'the preflight does not read the beads it is about to move');
});

await check('there is no --all and no filter', async () => {
  const code = codeOf('bin/endorse.js') + codeOf('lib/endorsecli.js');
  assert.ok(!/'--all'|"--all"/.test(code), 'an --all arrived — a list nothing named is the twenty-five-ship-bead press');
  assert.ok(!/'--label'|'--filter'|'--status'/.test(code), 'a filter arrived');
});

await check('the guard is prose, on purpose, and the file says whose decision that was', async () => {
  // bc-1f5o, answered 2026-08-17: Adam-invoked only, no code refusal, the rule about
  // initiative rather than identity. While the question was open this assertion required
  // a `TODO(bc-1f5o)` marker, so the marker could not outlive the decision or the
  // decision the marker; now that it is answered it holds the other half — that the file
  // still says *why* there is no enforcement here, so the absence reads as a decision
  // rather than as an oversight somebody should helpfully fix.
  const src = read('bin/endorse.js');
  assert.ok(!/TODO\(bc-1f5o\)/.test(src), 'the TODO outlived the decision it was waiting on');
  assert.match(src, /bc-1f5o/, 'nothing points at the bead the guard was decided on');
  assert.match(src, /initiative, not identity/, 'the rule itself is not written down where the code is');
  // And the enforcement is still absent, which is the decision — not an accident.
  const code = codeOf('bin/endorse.js') + codeOf('lib/endorsecli.js');
  assert.ok(!/agent-filed|filedBy|whoFiled/.test(code), 'a code refusal arrived that Adam declined');
});

daemon.close();
console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
