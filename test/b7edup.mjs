#!/usr/bin/env node
/**
 * `b7e-dup` — is this already filed? lib/dup.js and bin/b7e-dup.
 *
 *     npm test
 *     node test/b7edup.mjs
 *
 * Two beads asked for this command and both are replayed here, because they are the same
 * question asked from opposite ends and only one of them is about beads that are still
 * open:
 *
 * - **bc-dgx7.106** — four sessions each answered "has somebody already filed this?" with
 *   a different tool: a whole-tracker `bd list --status=all --json` dump eyeballed by
 *   hand, several `gh pr view`/`gh pr diff` calls, a `dolt sql` fallback after a Dolt-lock
 *   timeout. That is the ranking half: shared words, shared files, shared `identifiers`.
 * - **bc-dgx7.67** — six sessions guessed words at `bd search` instead, and **four of the
 *   six answers they wanted were closed or superseded beads**, which `lib/dupe.js` cannot
 *   see at all (`LIVE_STATUSES`). That is the half this file leans on hardest: a closed
 *   row has to arrive carrying the bead that superseded it, the reason it closed, and the
 *   pull request named inside that reason, or it reads as "nothing here".
 *
 * The headline case is real history, ids and all. `bc-1tno1` is a closed P0 whose whole
 * outcome was `bin/supersede.js` onto `bc-xl7n.134` — the same bug filed 3h43m earlier —
 * after two dead `bd search` queries. Section 4 replays it against the fake tracker: one
 * call, given only `bc-1tno1`'s own title, has to end at `bc-xl7n.134`.
 *
 * `bd` is a stub here rather than the real binary (test/helpers/bdtemplate.mjs's
 * workspaces cost ~28s to lay and nothing in these assertions is about what `bd` does with
 * a write) — but every row it hands back has the shape `Bd.listAll` really returns,
 * `close_reason` and `labels` included, which is the only thing the closed half reads.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';
import {
  supersededBy,
  closedBy,
  titleVerdict,
  isClosed,
  withSuccessors,
  queryFor,
  scoreAll,
  rankCandidates,
  quotedTerms,
  CANDIDATE_FLOOR,
} from '../lib/dup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-dup');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7edup-'));
process.on('exit', () => removeTreeSync(tmp));

/* ------------------------------------------------------------------- harness */

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 10).join('\n       ')}`);
  }
};

/* -------------------------------------------------------------------- world */

/** Rows in the shape `Bd.listAll` returns — `close_reason` and `labels` are the point. */
const ROWS = [
  {
    id: 'bc-1tno1',
    title: 'GET /api/questions failed — HTTP 502 — api/questions',
    description:
      'The router answered HTTP 502 on /api/questions, twice in four minutes. The upstream error is\n' +
      '`socket hang up` against a retired backend: the request was still in flight when the swap\n' +
      'retired the old listener, and the drain window closed underneath it. Nothing in the daemon log\n' +
      'names the request; the router simply stops answering it and the caller sees a 502.',
    status: 'closed',
    priority: 0,
    assignee: '',
    close_reason: 'Answered via Beadcause',
    labels: ['agent-filed', 'incident', 'superseded-by:bc-xl7n.134'],
  },
  {
    id: 'bc-xl7n.134',
    title: 'The router kills a live request at DRAIN_MS and answers 502 — /api/queues runs longer than the 60s drain',
    description:
      'A request still in flight when a backend is retired is cut at `DRAIN_MS` and the caller sees\n' +
      'HTTP 502 with `socket hang up` upstream. The drain window is fixed, so any request that outlives\n' +
      'it — /api/queues routinely does — is killed rather than allowed to finish against the old\n' +
      'listener. The router should hold a retired backend open until its last request drains.',
    status: 'closed',
    priority: 2,
    assignee: 'neadamthal@gmail.com',
    close_reason: 'Merged #737 as bb322781.',
    labels: ['agent-filed', 'shipped'],
  },
  {
    id: 'bc-open1',
    title: 'The advocate opens a second window on a bead already claimed',
    description: 'Two windows, one bead. `advocates.json` is read before the claim lands.',
    status: 'open',
    priority: 1,
    assignee: '',
    close_reason: null,
    labels: [],
  },
  {
    id: 'bc-chain1',
    title: 'Duplicate windows on one pull request, first hop',
    description: 'Two resolver windows took the same pull request.',
    status: 'closed',
    priority: 2,
    assignee: '',
    close_reason: 'Superseded.',
    labels: ['superseded-by:bc-chain2'],
  },
  {
    id: 'bc-chain2',
    title: 'Duplicate windows on one pull request, second hop',
    description: 'Two resolver windows took the same pull request, restated.',
    status: 'closed',
    priority: 2,
    assignee: '',
    close_reason: 'Superseded again.',
    labels: ['superseded-by:bc-chain3'],
  },
  {
    id: 'bc-chain3',
    title: 'Duplicate windows on one pull request, the live one',
    description: 'Two resolver windows took the same pull request; this is the bead still open.',
    status: 'open',
    priority: 1,
    assignee: '',
    close_reason: null,
    labels: [],
  },
  {
    id: 'bc-elsewhere',
    title: 'Superseded onto a bead this tracker does not hold',
    description: 'Moved to another workspace entirely.',
    status: 'closed',
    priority: 2,
    assignee: '',
    close_reason: 'Moved.',
    labels: ['superseded-by:dv-5eu.35'],
  },
];

const byId = Object.fromEntries(ROWS.map((r) => [r.id, r]));

/* ------------------------------------------------------------------ fake bd */

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const rows = ${JSON.stringify(ROWS)};
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const verb = args[0];
if (verb === 'list') { process.stdout.write(JSON.stringify(rows)); process.exit(0); }
if (verb === 'show') {
  const hit = rows.find((r) => r.id === args[1]);
  if (!hit) die('Error fetching ' + args[1] + ': no issue found matching "' + args[1] + '"');
  process.stdout.write(JSON.stringify([hit]));
  process.exit(0);
}
die('stub bd: unexpected verb "' + verb + '"');
`,
  { mode: 0o755 }
);

const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify(
    {
      bdBin: FAKE_BD,
      actor: 'beadcause-test',
      // A real directory — `reconcileWorkspaces` drops an entry whose `dir` is not there
      // — but deliberately not a checkout: `guessedFiles` then has nothing to confirm a
      // path against and `priorWork` has no repo to run git in, which is the honest shape
      // for a tracker-only workspace and keeps this suite off the network.
      workspaces: [{ name: 'dup-ws', dir: path.join(tmp, 'tracker') }],
    },
    null,
    2
  )
);

fs.mkdirSync(path.join(tmp, 'tracker'), { recursive: true });

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: stripAnsi(res.stdout || ''), stderr: stripAnsi(res.stderr || '') };
}

/* ================================================ 1. reading a row's verdict */

console.log('\n1. what a row says about itself\n');

check('supersededBy lifts the label', () => {
  assert.equal(supersededBy(byId['bc-1tno1']), 'bc-xl7n.134');
  assert.equal(supersededBy(byId['bc-open1']), null);
});

check('supersededBy is not confused by a neighbouring label', () => {
  assert.equal(supersededBy({ labels: ['shipped', 'not-superseded-by:bc-x', 'superseded-by:bc-y'] }), 'bc-y');
});

check('closedBy lifts the pull request out of the merge queue reason', () => {
  const c = closedBy(byId['bc-xl7n.134']);
  assert.equal(c.pr, 737);
  assert.equal(c.sha, 'bb322781');
  assert.equal(c.reason, 'Merged #737 as bb322781.');
});

check('closedBy still reports a reason with no pull request in it', () => {
  const c = closedBy(byId['bc-1tno1']);
  assert.equal(c.reason, 'Answered via Beadcause');
  assert.equal(c.pr, null);
});

check('closedBy is null for a bead nobody closed', () => {
  assert.equal(closedBy(byId['bc-open1']), null);
});

check('isClosed calls open, in_progress and blocked live', () => {
  assert.equal(isClosed({ status: 'open' }), false);
  assert.equal(isClosed({ status: 'in_progress' }), false);
  assert.equal(isClosed({ status: 'blocked' }), false);
  assert.equal(isClosed({ status: 'closed' }), true);
});

check('titleVerdict clears lib/dupe.js own bar on a title typed twice', () => {
  const same = titleVerdict(byId['bc-1tno1'].title, byId['bc-1tno1']);
  assert.equal(same.verbatim, true);
  assert.equal(same.titleScore, 1);
  const other = titleVerdict(byId['bc-1tno1'].title, byId['bc-open1']);
  assert.equal(other.verbatim, false);
});

/* ============================================== 2. following a superseded-by */

console.log('\n2. the chain out of a superseded bead\n');

const rankedOf = (title, opts = {}) => scoreAll(queryFor({ id: null, title }), ROWS, opts);

check('withSuccessors adds the bead a hit was superseded onto', () => {
  const seed = [{ id: 'bc-1tno1', supersededBy: 'bc-xl7n.134', workspace: 'dup-ws' }];
  const out = withSuccessors(seed, ROWS);
  assert.deepEqual(out.map((r) => r.id), ['bc-1tno1', 'bc-xl7n.134']);
  assert.equal(out[1].via, 'bc-1tno1');
  assert.equal(out[1].closedBy.pr, 737);
});

check('it follows a chain to the bead still open', () => {
  const out = withSuccessors([{ id: 'bc-chain1', supersededBy: 'bc-chain2' }], ROWS);
  assert.deepEqual(out.map((r) => r.id), ['bc-chain1', 'bc-chain2', 'bc-chain3']);
  assert.equal(out[2].status, 'open');
});

check('a chain that loops back stops rather than spinning', () => {
  const loop = [
    { id: 'a', title: 'a', status: 'closed', labels: ['superseded-by:b'] },
    { id: 'b', title: 'b', status: 'closed', labels: ['superseded-by:a'] },
  ];
  const out = withSuccessors([{ id: 'a', supersededBy: 'b' }], loop);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
});

check('a successor in another tracker is still named, marked missing', () => {
  const out = withSuccessors([{ id: 'bc-elsewhere', supersededBy: 'dv-5eu.35' }], ROWS);
  assert.deepEqual(out.map((r) => r.id), ['bc-elsewhere', 'dv-5eu.35']);
  assert.equal(out[1].missing, true);
});

check('a successor already in the ranking is not repeated', () => {
  const seed = [
    { id: 'bc-1tno1', supersededBy: 'bc-xl7n.134' },
    { id: 'bc-xl7n.134', supersededBy: null },
  ];
  const out = withSuccessors(seed, ROWS);
  assert.deepEqual(out.map((r) => r.id), ['bc-1tno1', 'bc-xl7n.134']);
});

/* ================================================== 3. closed beads and rank */

console.log('\n3. ranking, with the closed half switched on and off\n');

check('a ranked row carries status, priority and the closed verdict', () => {
  const hit = rankedOf(byId['bc-1tno1'].title).find((r) => r.id === 'bc-1tno1');
  assert.ok(hit, 'bc-1tno1 did not rank at all');
  assert.equal(hit.status, 'closed');
  assert.equal(hit.priority, 0);
  assert.equal(hit.closed, true);
  assert.equal(hit.supersededBy, 'bc-xl7n.134');
  assert.equal(hit.verbatim, true);
});

check('--no-closed drops closed beads and keeps the live ones', () => {
  const withThem = rankedOf('duplicate windows on one pull request');
  const without = rankedOf('duplicate windows on one pull request', { closed: false });
  assert.ok(withThem.some((r) => r.id === 'bc-chain1'), 'the closed hop should rank by default');
  assert.ok(!without.some((r) => r.closed), 'no closed row survives closed:false');
  assert.ok(without.some((r) => r.id === 'bc-chain3'), 'the open bead still ranks');
});

check('the query bead never ranks against itself', () => {
  const q = queryFor(byId['bc-1tno1']);
  assert.ok(!scoreAll(q, ROWS).some((r) => r.id === 'bc-1tno1'));
});

check('a title nothing is about ranks nothing', () => {
  assert.deepEqual(rankedOf('zzqqx flurb wibbletronic marmalade'), []);
});

check('rankCandidates cuts to the limit, best first', () => {
  const out = rankCandidates(queryFor({ id: null, title: 'duplicate windows on one pull request' }), ROWS, { limit: 2 });
  assert.equal(out.length, 2);
  assert.ok(out[0].score >= out[1].score);
  assert.ok(out[0].score >= CANDIDATE_FLOOR);
});

check('quotedTerms reads backticked identifiers and drops a whole block', () => {
  const q = quotedTerms('the `DRAIN_MS` cut, `socket hang up`');
  assert.ok(q.has('DRAIN_MS'));
  assert.ok(q.has('socket hang up'));
  assert.equal(quotedTerms(`\`${'x'.repeat(200)}\``).size, 0);
});

/* ============================================ 4. bc-dgx7.67's own acceptance */

console.log("\n4. bc-dgx7.67's acceptance: bc-1tno1's title has to end at bc-xl7n.134\n");

check('one call, given only the title, names bc-xl7n.134', () => {
  const { status, stdout } = run(['-w', 'dup-ws', '--title', byId['bc-1tno1'].title, '--limit', '4']);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /bc-xl7n\.134/);
});

check('it says bc-1tno1 was superseded rather than leaving it a bare [closed]', () => {
  const { stdout } = run(['-w', 'dup-ws', '--title', byId['bc-1tno1'].title, '--limit', '4']);
  assert.match(stdout, /superseded by bc-xl7n\.134/);
  assert.match(stdout, /bc-xl7n\.134 .*supersedes bc-1tno1/);
});

check('the pull request that closed the live bead rides along', () => {
  const { stdout } = run(['-w', 'dup-ws', '--title', byId['bc-1tno1'].title, '--limit', '4']);
  assert.match(stdout, /Merged #737 as bb322781\./);
});

check('a near-verbatim title is called that, by lib/dupe.js own bar', () => {
  const { stdout } = run(['-w', 'dup-ws', '--title', byId['bc-1tno1'].title, '--limit', '4']);
  assert.match(stdout, /near-verbatim title/);
});

check('a title matching nothing says so once, at exit 0', () => {
  const { status, stdout } = run(['-w', 'dup-ws', '--title', 'zzqqx flurb wibbletronic marmalade']);
  assert.equal(status, 0);
  assert.match(stdout, /Nothing in dup-ws reads like/);
  assert.equal(stdout.trim().split('\n').length, 1);
});

check('the empty answer says --no-closed narrowed it, when it did', () => {
  const { stdout } = run(['-w', 'dup-ws', '--no-closed', '--title', 'zzqqx flurb wibbletronic marmalade']);
  assert.match(stdout, /drop --no-closed/);
});

check('--json carries the closed half as fields, one object per line', () => {
  const { status, stdout } = run(['-w', 'dup-ws', '--title', byId['bc-1tno1'].title, '--limit', '4', '--json']);
  assert.equal(status, 0, stdout);
  const rows = stdout.trim().split('\n').map((l) => JSON.parse(l));
  const seed = rows.find((r) => r.id === 'bc-1tno1');
  assert.equal(seed.supersededBy, 'bc-xl7n.134');
  assert.equal(seed.closed, true);
  assert.equal(seed.verbatim, true);
  const next = rows.find((r) => r.id === 'bc-xl7n.134');
  assert.equal(next.via, 'bc-1tno1');
  assert.equal(next.closedBy.pr, 737);
});

check('-b takes the bead own text, and finds what its title alone would', () => {
  const { status, stdout } = run(['-w', 'dup-ws', '-b', 'bc-1tno1', '--limit', '4']);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /bc-xl7n\.134/);
  assert.ok(!/^bc-1tno1 /m.test(stdout), 'the query bead ranked against itself');
});

/* ================================================================ 5. refusals */

console.log('\n5. how it refuses\n');

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-dup/);
});

check('a missing -w is refused at 2', () => {
  const { status, stderr } = run(['--title', 'anything']);
  assert.equal(status, 2);
  assert.match(stderr, /-w\/--workspace is required/);
});

check('neither --bead nor --title is refused at 2', () => {
  const { status, stderr } = run(['-w', 'dup-ws']);
  assert.equal(status, 2);
  assert.match(stderr, /pass --bead <id> or --title/);
});

check('both --bead and --title is refused at 2', () => {
  const { status, stderr } = run(['-w', 'dup-ws', '-b', 'bc-1tno1', '--title', 'x']);
  assert.equal(status, 2);
  assert.match(stderr, /two ways of saying what to rank against/);
});

check('a --limit that is not a positive number is refused at 2', () => {
  const { status, stderr } = run(['-w', 'dup-ws', '--title', 'x', '--limit', 'lots']);
  assert.equal(status, 2);
  assert.match(stderr, /--limit must be a positive number/);
});

check('a workspace no config names is refused at 4', () => {
  const { status, stderr } = run(['-w', 'not-a-workspace', '--title', 'x']);
  assert.equal(status, 4);
  assert.match(stderr, /no workspace named not-a-workspace/);
});

check('--also naming an unknown workspace is refused at 4', () => {
  const { status, stderr } = run(['-w', 'dup-ws', '--also', 'nope', '--title', 'x']);
  assert.equal(status, 4);
  assert.match(stderr, /no workspace named nope/);
});

check('a tracker that cannot be read is 5, not "no such bead"', () => {
  // The distinction dv-gr6.64 paid two minutes for: a Dolt lock and a missing bead reject
  // the same way, and only the wording tells them apart.
  const lockedBd = path.join(tmp, 'bd-locked');
  fs.writeFileSync(lockedBd, '#!/bin/sh\necho "Error: database is locked" >&2\nexit 1\n', { mode: 0o755 });
  const lockedDir = path.join(tmp, 'config-locked');
  fs.mkdirSync(lockedDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockedDir, 'config.json'),
    JSON.stringify({ bdBin: lockedBd, actor: 'beadcause-test', workspaces: [{ name: 'dup-ws', dir: path.join(tmp, 'tracker') }] }, null, 2)
  );
  const res = spawnSync(process.execPath, [BIN, '-w', 'dup-ws', '-b', 'bc-1tno1'], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: lockedDir },
  });
  assert.equal(res.status, 5, res.stderr);
  assert.match(stripAnsi(res.stderr || ''), /could not read dup-ws\/bc-1tno1/);
});

check('a bead the tracker does not have is refused at 4', () => {
  const { status, stderr } = run(['-w', 'dup-ws', '-b', 'bc-nope']);
  assert.equal(status, 4);
  assert.match(stderr, /has no bead bc-nope/);
});

/* ---------------------------------------------------------------- verdict */

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
