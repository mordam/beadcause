#!/usr/bin/env node
/**
 * Which run filed a bead — lib/sessionlog.js#filerSession and bin/whofiled.js.
 *
 *     npm test
 *     node test/whofiled.mjs
 *
 * bc-xl7n.145. `created_by` cannot answer "who filed this bead" — it is the git
 * identity of the workspace directory, the same for every session that has ever
 * written there. The chain that can already exists: `filed-while:<bead>`
 * (lib/filing.js) names the bead the filer was working, and that bead's own archive
 * (`refs/beadcause/sessions/<bead>`, lib/sessionlog.js) carries the session. This pins
 * that it resolves correctly — including picking the *right* session when the filer
 * bead was worked more than once — and that a chain that does not close says so.
 *
 * Two layers, real git throughout for the first and a real subprocess against a fake
 * `bd` for the second — same split as test/beadsession.mjs and test/b7efiled.mjs:
 *
 * 1. `filerSession` directly, against hand-built archive commits (no `bd`, no network).
 * 2. `bin/whofiled.js` end to end, against a fake `bd show` — the whole point being that
 *    a reader gets the answer from one command rather than assembling it from three.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const BIN = path.join(ROOT, 'bin', 'whofiled.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-whofiled-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ------------------------------------------------------------------ the fixture repo */

const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });

const git = (args, cwd = repo, extraEnv = {}) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'beadcause-test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'beadcause-test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      ...extraEnv,
    },
  });

git(['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
git(['add', '-A']);
git(['commit', '-qm', 'first']);

/**
 * An archive commit, written the way lib/sessionlog.js writes one — see
 * test/beadsession.mjs for why this is built by hand rather than through
 * `archiveSession` (a real transcript and a real branch cannot be faked convincingly,
 * and what is under test here is the reader). `at` controls both the commit's own
 * date, which is what `readArchive`'s `at` field reports, and defaults `meta.json`'s
 * `endedAt` to match it.
 */
function archive(bead, meta, { at } = {}) {
  const fullMeta = { endedAt: at || new Date().toISOString(), ...meta };
  const files = {
    'meta.json': JSON.stringify(fullMeta, null, 2) + '\n',
    'session.log': `session for ${bead}\n`,
  };
  const lines = [];
  for (const [name, body] of Object.entries(files)) {
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: body, encoding: 'utf8' }).trim();
    lines.push(`100644 blob ${sha}\t${name}`);
  }
  const tree = execFileSync('git', ['mktree'], { cwd: repo, input: lines.join('\n') + '\n', encoding: 'utf8' }).trim();
  const ref = `refs/beadcause/sessions/${bead}`;
  let parent = null;
  try {
    parent = git(['rev-parse', '--verify', '--quiet', ref]).trim() || null;
  } catch {
    parent = null;
  }
  const dateEnv = at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {};
  const commit = execFileSync(
    'git',
    ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `demo/${bead} · ended`],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, ...dateEnv } }
  ).trim();
  git(['update-ref', ref, commit]);
  return commit;
}

/* Filer bead with a single archived session — the ordinary case. */
const ONCE = 'zz-once';
const onceCommit = archive(
  ONCE,
  { bead: ONCE, workspace: 'demo', sessionId: 'session-once', startedAt: '2026-08-27T10:00:00Z', branch: 'worktree-once', worktree: '/tmp/wt-once', commits: ['aaa'] },
  { at: '2026-08-27T10:30:00Z' }
);

/* Filer bead worked twice — a stall, then a resumed session — and the bead this test
 * is chasing was filed during the SECOND one. Picking the newest archive would be
 * right here by accident; the first case below is built so that is not true. */
const TWICE = 'zz-twice';
archive(
  TWICE,
  { bead: TWICE, workspace: 'demo', sessionId: 'session-twice-a', startedAt: '2026-08-27T09:00:00Z', branch: 'worktree-twice', worktree: '/tmp/wt-twice' },
  { at: '2026-08-27T09:20:00Z' } // died early, filed nothing
);
const twiceSecondCommit = archive(
  TWICE,
  { bead: TWICE, workspace: 'demo', sessionId: 'session-twice-b', startedAt: '2026-08-27T09:25:00Z', branch: 'worktree-twice', worktree: '/tmp/wt-twice' },
  { at: '2026-08-27T10:00:00Z' } // this one filed the bead, at 09:40
);
// A THIRD archive, well after the second — proves the picker does not just grab the
// newest either; it has to find the one whose own window actually contains the moment.
archive(
  TWICE,
  { bead: TWICE, workspace: 'demo', sessionId: 'session-twice-c', startedAt: '2026-08-28T09:00:00Z', branch: 'worktree-twice-2' },
  { at: '2026-08-28T09:20:00Z' }
);

/* A filer bead never archived at all — the chain does not close. */
const GONE = 'zz-gone';

/* A filer whose sole archive has no `startedAt` to check containment against — the
 * best this can do is the nearest archive, flagged as a guess. */
const NOSTART = 'zz-nostart';
const nostartCommit = archive(NOSTART, { bead: NOSTART, workspace: 'demo', sessionId: 'session-nostart', branch: 'worktree-nostart' }, { at: '2026-08-27T12:00:00Z' });

/* ------------------------------------------------------------- filerSession, directly */

console.log('\nfilerSession — resolving the chain from a bead to its filer\'s session\n');

const { filerSession } = await import(LIB('sessionlog.js'));

await check('a filer with one archived session resolves to it', async () => {
  const r = await filerSession(repo, ONCE, '2026-08-27T10:15:00Z');
  assert.equal(r.sessions, 1);
  assert.equal(r.session.commit, onceCommit);
  assert.equal(r.session.meta.sessionId, 'session-once');
  assert.equal(r.exact, true);
});

await check('a filer worked twice: the session whose own window contains the filing wins, not the newest', async () => {
  const r = await filerSession(repo, TWICE, '2026-08-27T09:40:00Z');
  assert.equal(r.sessions, 3);
  assert.equal(r.session.commit, twiceSecondCommit, 'must not have picked the newest (session-twice-c) or the first (session-twice-a)');
  assert.equal(r.session.meta.sessionId, 'session-twice-b');
  assert.equal(r.exact, true);
});

await check('a filer never archived at all: the chain does not close, and it says so rather than guessing', async () => {
  const r = await filerSession(repo, GONE, '2026-08-27T10:15:00Z');
  assert.equal(r.sessions, 0);
  assert.equal(r.session, null);
  assert.equal(r.exact, false);
});

await check('a session with no startedAt to check: nearest archive, flagged as a guess and not a hit', async () => {
  const r = await filerSession(repo, NOSTART, '2026-08-27T12:05:00Z');
  assert.equal(r.sessions, 1);
  assert.equal(r.session.commit, nostartCommit);
  assert.equal(r.exact, false, 'nothing confirmed containment, so this must not read as exact');
});

await check('no createdAt at all: falls back to the newest archive, and says it is a guess', async () => {
  const r = await filerSession(repo, TWICE, null);
  assert.equal(r.session.meta.sessionId, 'session-twice-c', 'newest archive with nothing to match against');
  assert.equal(r.exact, false);
});

/* ------------------------------------------------------------------- bin/whofiled.js */

console.log("\nbeadcause-whofiled — one command instead of three\n");

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const ISSUES = ${JSON.stringify({
    'zz-filed-once': { id: 'zz-filed-once', labels: ['agent-filed', 'filed-while:zz-once'], created_at: '2026-08-27T10:15:00Z' },
    'zz-filed-twice': { id: 'zz-filed-twice', labels: ['agent-filed', 'filed-while:zz-twice'], created_at: '2026-08-27T09:40:00Z' },
    'zz-filed-gone': { id: 'zz-filed-gone', labels: ['agent-filed', 'filed-while:zz-gone'], created_at: '2026-08-27T10:15:00Z' },
    'zz-not-filed': { id: 'zz-not-filed', labels: ['human'], created_at: '2026-08-27T10:15:00Z' },
  })};
if (args[0] === 'show') {
  const issue = ISSUES[args[1]];
  if (!issue) { process.stderr.write('Error fetching ' + args[1] + ': no issue found matching "' + args[1] + '"\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const wsDir = path.join(repo, '.beads');
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

const run = (args) => {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
};

await check('resolves in one call: the chosen session, printed', () => {
  const r = run(['-w', 'demo', '-b', 'zz-filed-once']);
  assert.equal(r.status, 0);
  assert.match(r.out, /filed while working zz-once/);
  assert.match(r.out, /session-once/);
});

await check('picks the right one of several sessions on the filer, not just the newest', () => {
  const r = run(['-w', 'demo', '-b', 'zz-filed-twice']);
  assert.equal(r.status, 0);
  assert.match(r.out, /session-twice-b/);
  assert.ok(!r.out.includes('session-twice-c'), 'must not have printed the later, unrelated session');
});

await check('a chain that does not close says so, exit 1, not a blank success', () => {
  const r = run(['-w', 'demo', '-b', 'zz-filed-gone']);
  assert.equal(r.status, 1);
  assert.match(r.out, /chain does not close/);
});

await check('no filed-while label at all: exit 2, and it does not claim a session', () => {
  const r = run(['-w', 'demo', '-b', 'zz-not-filed']);
  assert.equal(r.status, 2);
  assert.match(r.out, /carries no filed-while label/);
});

await check('--json carries the machine-readable chain', () => {
  const r = run(['-w', 'demo', '-b', 'zz-filed-once', '--json']);
  assert.equal(r.status, 0);
  const payload = JSON.parse(r.out);
  assert.equal(payload.filedWhile, 'zz-once');
  assert.equal(payload.sessionId, 'session-once');
  assert.equal(payload.closed, true);
  assert.equal(payload.exact, true);
});

await check('an unknown bead is a named refusal, not a crash', () => {
  const r = run(['-w', 'demo', '-b', 'zz-does-not-exist']);
  assert.equal(r.status, 4);
  assert.match(r.err, /no bead zz-does-not-exist/);
});

await check('an unknown workspace is a named refusal', () => {
  const r = run(['-w', 'nope', '-b', 'zz-filed-once']);
  assert.equal(r.status, 4);
  assert.match(r.err, /no workspace named/);
});

await check('missing flags is bad usage, not a hang waiting on stdin', () => {
  const r = run(['-w', 'demo']);
  assert.equal(r.status, 3);
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
