#!/usr/bin/env node
/**
 * **Ship on the PR board** — the deploy where one is declared, the window where none is.
 *
 *     npm test
 *     node test/prship.mjs
 *
 * `test/ship.mjs` proves the *inbox's* Ship: a delivery card answered `SHIP:` merges
 * and then deploys. This is the other Ship, on /prs, over work that is already merged
 * — and until the deploy could be declared at all it was the odd one out, a button
 * that opened an iTerm window and asked a person to do it. The two now do the same
 * thing where the same thing is possible, and this file is about the fork between
 * them, because that fork is invisible from either side on its own.
 *
 * A real git repo with a real `origin`, a fake `gh` that lists a merged pull request,
 * a fake `bd`, and a declared "deploy" that is a script writing a file. Nothing here
 * restarts anything, and nothing opens a window — which is itself one of the claims.
 *
 * Four failures are worth the file:
 *
 * 1. **A repo that declared a deploy still opening a window.** The whole point of
 *    bc-5h3, and it is invisible from the response alone: a window is another process
 *    and a 200 either way. So the config here has `openSessions: false`, which makes
 *    the fallback answer 403 — the two paths become two different status codes and
 *    the fork can be asserted rather than inferred.
 * 2. **`openSessions: false` blocking the deploy.** It reads as a global off switch
 *    and it is not one: it is about *iTerm windows*, and a repo that wrote down its
 *    deploy has asked for something that opens none. That case is case 1's assertion
 *    from the other side.
 * 3. **Two deploys of one repo at once.** A phone in a pocket, or two taps in a room
 *    where the first one killed the daemon before it answered. The second must be a
 *    refusal naming the deploy already running, and — the part that would be silently
 *    wrong — must not leave a second record behind.
 * 4. **An unmerged pull request deploying anything.** Ship on an open PR has never
 *    meant anything; now that it can act rather than open a window, it must refuse
 *    *before* the fork, not inside whichever branch it took.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-prship-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load,
// and lib/deploy.js keeps its journal under it.
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
const check = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for `fn` to stop throwing, or give up. Deploys are another process. */
async function until(fn, { ms = 8000, every = 40 } = {}) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (Date.now() > deadline) throw last;
      await sleep(every);
    }
  }
}

/* ------------------------------------------------------------------ the repos */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@e',
    },
  }).trim();

/**
 * Two checkouts, because the fork is between two repos and not between two answers.
 * `demo` declares a deploy; `bare` is every repo that has declared nothing, which is
 * most of them. Both are real, with a real origin, because the board's lamps are
 * ancestry questions and a fake git would only prove the fake works.
 */
const repos = {};
for (const name of ['demo', 'bare']) {
  const origin = path.join(tmp, `${name}.git`);
  const dir = path.join(tmp, name);
  git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(tmp, 'clone', '--quiet', origin, dir);
  git(dir, 'config', 'user.email', 't@e');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '--quiet', '-m', 'one');
  git(dir, 'push', '--quiet', '-u', 'origin', 'main');
  repos[name] = { dir, origin, head: git(dir, 'rev-parse', 'HEAD') };
}

/* ------------------------------------------------------------------- fake gh */

const GH_STATE = path.join(tmp, 'gh-state.json');
const GH_LOG = path.join(tmp, 'gh-calls.log');

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(GH_STATE)}, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (args[0] === 'auth' && args[1] === 'status') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/' + require('node:path').basename(process.cwd()) }));
if (args[0] === 'pr' && args[1] === 'list') out(JSON.stringify(state[require('node:path').basename(process.cwd())] || []));
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

const rawPR = (over = {}) => ({
  number: 1,
  url: 'https://github.com/acme/demo/pull/1',
  title: 'zz-work: something small',
  state: 'MERGED',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'worktree-something-work',
  baseRefName: 'main',
  additions: 4,
  deletions: 1,
  changedFiles: 1,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: iso(1),
  mergeCommit: { oid: repos.demo.head },
  body: '',
  author: { login: 'someone' },
  createdAt: iso(2),
  updatedAt: iso(1),
  ...over,
});

fs.writeFileSync(
  GH_STATE,
  JSON.stringify({
    demo: [
      rawPR(),
      // Case 4: open, so Ship has nothing to act on however the repo is configured.
      rawPR({ number: 2, state: 'OPEN', mergedAt: null, mergeCommit: null, title: 'still open' }),
    ],
    bare: [rawPR({ number: 3, mergeCommit: { oid: repos.bare.head }, title: 'zz-work: the same, elsewhere' })],
  })
);

/* ------------------------------------------------------------------- fake bd */

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
// Enough of a tracker for the board: a prefix to recognise ids by, and one bead the
// pull request's title names — which is where the deploy record's \`bead\` comes from.
if (args[0] === 'list') { process.stdout.write(JSON.stringify([{ id: 'zz-a1b' }])); process.exit(0); }
if (args[0] === 'show') {
  process.stdout.write(JSON.stringify(args[1] === 'zz-work' ? [{ id: 'zz-work', title: 'the work', status: 'closed', labels: [], dependencies: [] }] : []));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/* ------------------------------------------------------- the "deploy" command */

/** Restarts nothing; leaves a file behind so "it ran" is a fact on disk. */
const DEPLOYED = path.join(tmp, 'deployed.txt');
const WRITER = path.join(BIN, 'writer');
fs.writeFileSync(
  WRITER,
  `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(DEPLOYED)}, process.cwd() + '\\n');
`,
  { mode: 0o755 }
);

/* ----------------------------------------------------------------- the config */

const beadsDir = (name) => {
  const d = path.join(tmp, 'beads', name, '.beads');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const base = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'prship-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [
    { name: 'demo', dir: beadsDir('demo') },
    { name: 'bare', dir: beadsDir('bare') },
  ],
  sessionDirs: { demo: repos.demo.dir, bare: repos.bare.dir },
  // Case 2, stated as configuration: no window may open in this test, and the deploy
  // must happen anyway. It is also what turns the fallback into a 403 we can assert.
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
  pr: { base: 'main' },
  deploys: {
    demo: { command: [WRITER], dir: repos.demo.dir, pull: false, graceMs: 0, restarts: false },
  },
};

const { createApp, listen } = await import(LIB('server.js'));
const { listDeploys } = await import(LIB('deploy.js'));

const cfg = { ...base, port: 0 };
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const request = (method, pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
          'x-beadcause-token': cfg.token,
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const post = (pathname, body) => request('POST', pathname, body);
const get = (pathname) => request('GET', pathname);

const records = () => listDeploys({ limit: 200 });

console.log('\nship, on the PR board\n');

/* ------------------------------------------------- what the board says it will do */

const board = await get('/api/prs?refresh=1');
const cardFor = (name) => (board.json.repos || []).find((r) => r.workspace === name);
const rowFor = (name, n) => (cardFor(name)?.prs || []).find((p) => p.number === n);

await check(() => assert.equal(board.status, 200), 'the board loads');
await check(
  () => assert.equal(cardFor('demo')?.deployDeclared, true),
  'a repo that declared a deploy says so on the card');
await check(
  () => assert.match(cardFor('demo')?.deployHint || '', /writer/),
  `and names the command the button will run — "${cardFor('demo')?.deployHint}"`);
await check(
  () => assert.equal(rowFor('demo', 1)?.deployDeclared, true),
  'and on the row, which is what the button is drawn from');
await check(
  () => assert.equal(cardFor('bare')?.deployDeclared, false),
  'a repo that declared nothing says that instead');
await check(
  () => assert.equal(cardFor('bare')?.deployHint, ''),
  'with no command to name, because there is none');

/* ------------------------------------------------------------ the declared deploy */

const shipped = await post('/api/pr/ship', { workspace: 'demo', number: 1 });

await check(() => assert.equal(shipped.status, 200), 'Ship on a merged pull request is accepted');
await check(
  () => assert.equal(shipped.json.via, 'deploy'),
  `and says which of the two it did — ${JSON.stringify(shipped.json.via)}`);
await check(() => assert.ok(shipped.json.deploy?.id, JSON.stringify(shipped.json)), 'a deploy record comes back');
await check(
  () => assert.equal(shipped.json.deploy.workspace, 'demo'),
  'for the repo the button was pressed in');
await check(
  () => assert.match(shipped.json.deploy.reason, /#1/),
  `and the record names the pull request it came from — "${shipped.json.deploy?.reason}"`);
await check(
  () => assert.equal(shipped.json.deploy.bead, 'zz-work'),
  'and the bead the pull request carried, so the deploys screen can say what shipped');

const settled = await until(() => {
  const rec = records().find((r) => r.id === shipped.json.deploy.id);
  assert.ok(rec && rec.status === 'ok', `still ${rec ? rec.status : 'absent'}`);
  return rec;
});
await check(() => assert.equal(settled.status, 'ok'), 'the runner outlives the request and settles it');
await check(
  () => assert.ok(fs.existsSync(DEPLOYED), 'the declared command left nothing behind'),
  'and the declared command actually ran');

/* --------------------------------------------------------- two at once, one repo */

// Held open so the second tap arrives while the first is still in flight — the pocket
// case, and the two-taps-in-a-room case, which are the same request twice.
const SLOW = path.join(BIN, 'slow');
fs.writeFileSync(SLOW, `#!/bin/sh\nsleep 3\n`, { mode: 0o755 });
cfg.deploys = { demo: { command: [SLOW], dir: repos.demo.dir, pull: false, graceMs: 0, restarts: false } };

const first = await post('/api/pr/ship', { workspace: 'demo', number: 1 });
const second = await post('/api/pr/ship', { workspace: 'demo', number: 1 });

await check(() => assert.equal(first.status, 200), 'a second ship of the same repo: the first is accepted');
await check(() => assert.equal(second.status, 409), 'and the second is refused');
await check(
  () => assert.match(second.json.error || '', /already running/),
  `saying which — "${second.json.error}"`);
await check(
  () => assert.equal(records().filter((r) => r.status === 'queued' || r.status === 'deploying' || r.status === 'pulling').length, 1),
  'and exactly one deploy is in flight, not two');

cfg.deploys = { ...base.deploys };

/* ------------------------------------------------- a repo that declared nothing */

const before = records().length;
const fallback = await post('/api/pr/ship', { workspace: 'bare', number: 3 });

await check(
  () => assert.equal(fallback.status, 403),
  `a repo with no declaration falls through to the session — ${fallback.status} ${JSON.stringify(fallback.json.error || '')}`);
await check(
  () => assert.match(fallback.json.error || '', /openSessions/),
  'refused here only because this test forbids windows, which is how the fork is visible at all');
await check(
  () => assert.equal(records().length, before),
  'and nothing was deployed on its behalf — no declaration, no deploy');

/* ---------------------------------------------------------- an unmerged pull request */

const open = await post('/api/pr/ship', { workspace: 'demo', number: 2 });

await check(() => assert.equal(open.status, 409), 'Ship on an open pull request is refused');
await check(
  () => assert.match(open.json.error || '', /not merged yet/),
  `in a sentence — "${open.json.error}"`);
await check(
  () => assert.equal(records().length, before),
  'and it is refused before the fork, so the declared deploy never starts either');

/* -------------------------------------------------------------------- verdict */

for (const s of servers) s.close();
app.stop?.();
try {
  execFileSync('rm', ['-rf', tmp]);
} catch {
  /* a temp directory is not worth failing over */
}

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m${ran}/${ran} passed\x1b[0m`);
process.exit(0);
