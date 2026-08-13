/**
 * One file, one holder — and the second session is told rather than blocked for ever.
 *
 * lib/claims.js is the register behind `scripts/claim-guard.sh`, and the claims worth
 * asserting are the ones that fail silently if they are wrong:
 *
 *   - **the asking is the taking** — two claims on one path in the same tick produce one
 *     holder and one refusal, not two holders. This is the case a check-then-act passes,
 *     and it is the shape of bc-utyr: one press, two requests, a moment apart;
 *   - **refused once, then yours** — a collision across worktrees is ordinary, so a
 *     register that refused it permanently is one that gets turned off. The refusal
 *     records the intent and the next attempt succeeds;
 *   - **the same worktree is the dangerous kind** — the only case where two sessions
 *     overwrite each other's bytes, and it has to be distinguishable in the refusal from
 *     the ordinary merge-time collision;
 *   - **a tree that is gone holds nothing** — shipping removes the worktree, and a claim
 *     that outlived it would make a live session stand down for a dead one, which is how
 *     a file becomes permanently un-editable;
 *   - **a restart forgets** — the register is process-lifetime state on purpose, for the
 *     reason lib/presence.js gives about a phone's whereabouts.
 *
 *     node test/claims.mjs
 *
 * No daemon and no worktrees: `alive` is injected everywhere, so a case about a tree that
 * has gone is a function returning false rather than an `rm -rf`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Before anything under lib/ that reads config is imported: CONFIG_DIR resolves once, at
// module load, and the daemon's own config is not this suite's to read.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-claims-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { claim, holders, release, list, collisions, refusalFor, reset, TTL_MS } = await import(
  path.join(HERE, '..', 'lib', 'claims.js')
);

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
function verify(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/**
 * A case that starts from an empty register.
 *
 * The HTTP section below uses `verify` instead, because its cases are one conversation
 * with a running daemon — a `reset()` between them would wipe the claim the next request
 * is about, which is exactly how the insist case first passed while asserting nothing.
 */
function check(name, fn) {
  reset();
  verify(name, fn);
}

const T0 = Date.parse('2026-08-12T13:00:00Z');
const MIN = 60000;
const REPO = '/Users/adam/projects/beadcause';

/** Every test injects `alive`, because none of these worktrees exist. */
const live = { alive: () => true };

/** A session asking for a file. Defaults describe one worktree; override `dir` for two. */
function ask(session, file, { now = T0, dir = `/wt/${session}`, branch = `worktree-${session}`, bead = '', repo = REPO } = {}) {
  return claim(session, { repo, file, dir, branch, bead, label: 'beadcause' }, now, live);
}

/* ------------------------------------------------------------------ the cases */

check('a file nobody holds is claimed, and says so', () => {
  const out = ask('s1', 'lib/foo.js');
  assert.equal(out.decision, 'held');
  assert.equal(out.insisted, false);
  assert.deepEqual(out.holders, [], 'nobody to name');
  assert.equal(out.record.state, 'held');
  assert.equal(out.record.since, out.record.at, 'a fresh claim arrived when it was made');
});

check('the asking is the taking — two claims in one tick are one holder and one refusal', () => {
  // No `await` between them, which is the point: this is what two requests a moment
  // apart look like to a single-threaded daemon, and both would pass a read-then-write.
  const first = ask('s1', 'lib/foo.js');
  const second = ask('s2', 'lib/foo.js');

  assert.equal(first.decision, 'held');
  assert.equal(second.decision, 'conflict');
  assert.equal(second.holders.length, 1, 'exactly one holder is named');
  assert.equal(second.holders[0].session, 's1');
  assert.equal(list(T0, live).filter((r) => r.state === 'held').length, 1, 'one holder, not two');
});

check('a refusal names where the holder is, not just that somebody is', () => {
  ask('s1', 'lib/foo.js', { branch: 'worktree-park-epic-p9vx', bead: 'bc-p9vx' });
  const out = ask('s2', 'lib/foo.js');
  const reason = refusalFor('lib/foo.js', out);

  assert.match(reason, /bc-p9vx/, 'the holder’s bead');
  assert.match(reason, /worktree-park-epic-p9vx/, 'the holder’s branch');
  assert.match(reason, /downmerge/, 'and what the cost actually is');
});

check('told once, then it is yours — the second attempt claims it', () => {
  ask('s1', 'lib/foo.js');
  const refused = ask('s2', 'lib/foo.js');
  assert.equal(refused.decision, 'conflict');

  const again = ask('s2', 'lib/foo.js', { now: T0 + MIN });
  assert.equal(again.decision, 'held', 'a session that was told and means it anyway gets the file');
  assert.equal(again.insisted, true, 'and the log can tell that apart from a clean claim');
  assert.equal(again.holders.length, 1, 'the other session still holds it too — both are on it now');
  assert.equal(collisions(T0 + MIN, live).length, 1, 'which is exactly what a collision is');
});

check('a session that was told and never came back is not a collision', () => {
  ask('s1', 'lib/foo.js');
  ask('s2', 'lib/foo.js');
  assert.deepEqual(collisions(T0, live), [], 'the warning is not the thing it warned about');
});

check('two sessions in ONE worktree is the dangerous kind, and reads differently', () => {
  ask('s1', 'lib/foo.js', { dir: '/wt/shared', branch: 'worktree-shared' });
  const out = ask('s2', 'lib/foo.js', { dir: '/wt/shared', branch: 'worktree-shared' });

  assert.equal(out.sameTree, true);
  const reason = refusalFor('lib/foo.js', out);
  assert.match(reason, /same worktree/i);
  assert.match(reason, /bc-utyr/, 'the incident is named, because this one is a stop');
  assert.doesNotMatch(reason, /Repeat the edit/, 'and it does not invite you to insist');
});

check('the same session editing the same file again renews without re-arriving', () => {
  const first = ask('s1', 'lib/foo.js');
  const again = ask('s1', 'lib/foo.js', { now: T0 + 20 * MIN });

  assert.equal(again.decision, 'held');
  assert.equal(again.record.since, first.record.since, 'since survives a renewal');
  assert.notEqual(again.record.at, first.record.at, 'at does not');
});

check('one repo-relative path in two repos is two files', () => {
  ask('s1', 'lib/foo.js', { repo: '/projects/beadcause' });
  const out = ask('s2', 'lib/foo.js', { repo: '/projects/sophab' });
  assert.equal(out.decision, 'held', 'nothing is shared between two checkouts of different repos');
});

check('a repo and a path cannot be run together into somebody else’s key', () => {
  // Both halves are file paths, so every cheap separator is legal in one of them. These
  // two are the same string concatenated and must still be two different files.
  ask('s1', 'bar.js', { repo: '/projects/beadcause/lib' });
  const out = ask('s2', 'lib/bar.js', { repo: '/projects/beadcause' });
  assert.equal(out.decision, 'held', 'two files, not one');
});

check('a claim expires rather than parking a file for ever', () => {
  ask('s1', 'lib/foo.js');
  assert.equal(holders(REPO, 'lib/foo.js', { session: 's2', now: T0 + TTL_MS - MIN, ...live }).length, 1, 'still held before the TTL');
  assert.equal(holders(REPO, 'lib/foo.js', { session: 's2', now: T0 + TTL_MS + MIN, ...live }).length, 0, 'gone after it');

  const out = ask('s2', 'lib/foo.js', { now: T0 + TTL_MS + MIN });
  assert.equal(out.decision, 'held', 'and the file is free, not merely unreported');
});

check('a worktree that is no longer on disk holds nothing', () => {
  ask('s1', 'lib/foo.js', { dir: '/wt/shipped' });
  // What `ship` leaves behind: the tree is gone, the session with it, and the TTL has
  // not run. Without this the file stays busy for ninety minutes after a merge.
  const gone = { alive: (dir) => dir !== '/wt/shipped' };
  const out = claim('s2', { repo: REPO, file: 'lib/foo.js', dir: '/wt/s2' }, T0 + MIN, gone);
  assert.equal(out.decision, 'held');
  assert.equal(list(T0 + MIN, gone).length, 1, 'and the dead claim is not merely hidden, it is dropped');
});

check('a missing dir is not evidence of absence', () => {
  // A caller that sent no dir at all must not have its claim pruned by the disk check —
  // "I cannot tell" is not "it is gone", the same distinction lib/resolvers.js keeps.
  claim('s1', { repo: REPO, file: 'lib/foo.js' }, T0, { alive: () => false });
  assert.equal(list(T0, { alive: () => false }).length, 1);
});

check('a session lets go of one file, or of everything', () => {
  ask('s1', 'lib/foo.js');
  ask('s1', 'lib/bar.js');
  ask('s2', 'lib/baz.js');

  assert.equal(release('s1', { files: ['lib/foo.js'] }), 1, 'one named file');
  assert.equal(list(T0, live).length, 2);
  assert.equal(release('s1'), 1, 'and the rest on session end');
  assert.deepEqual(
    list(T0, live).map((r) => r.session),
    ['s2'],
    'nobody else is touched'
  );
  assert.equal(release('s1'), 0, 'releasing twice is not an error, it is nothing');
});

check('a released file is free immediately, not after the TTL', () => {
  ask('s1', 'lib/foo.js');
  release('s1');
  const out = ask('s2', 'lib/foo.js', { now: T0 + MIN });
  assert.equal(out.decision, 'held');
  assert.deepEqual(out.holders, []);
});

check('a restart forgets every claim', () => {
  ask('s1', 'lib/foo.js');
  reset(); // What a daemon restart is: the register is process-lifetime state on purpose.
  assert.deepEqual(list(T0, live), []);
  assert.equal(ask('s2', 'lib/foo.js').decision, 'held', 'a fresh daemon asserts nothing about a window it cannot address');
});

check('reading who holds a file claims nothing', () => {
  ask('s1', 'lib/foo.js');
  holders(REPO, 'lib/foo.js', { session: 's2', now: T0, ...live });
  holders(REPO, 'lib/foo.js', { session: 's2', now: T0, ...live });
  assert.equal(list(T0, live).length, 1, 'two reads by s2 did not put s2 in the register');
});

check('a claim missing its session, repo or file is refused outright', () => {
  assert.equal(claim('', { repo: REPO, file: 'lib/foo.js' }, T0, live), null);
  assert.equal(claim('s1', { repo: '', file: 'lib/foo.js' }, T0, live), null);
  assert.equal(claim('s1', { repo: REPO, file: '' }, T0, live), null);
  assert.deepEqual(list(T0, live), [], 'and nothing half-written is left behind');
});

check('every field is bounded, because a report is a claim by a client', () => {
  const out = claim('s/1 ../etc'.repeat(80), { repo: 'r'.repeat(900), file: 'f'.repeat(900) }, T0, live);
  assert.ok(out.record.session.length <= 300);
  assert.ok(out.record.repo.length <= 300);
  assert.ok(out.record.file.length <= 300);
  assert.doesNotMatch(out.record.session, /[/ ]/, 'a session id is a key and ends up in a message a person reads');
});

check('collisions name the sessions oldest-arrival first', () => {
  ask('s1', 'lib/foo.js', { now: T0 });
  ask('s2', 'lib/foo.js', { now: T0 + MIN }); // told
  ask('s2', 'lib/foo.js', { now: T0 + 2 * MIN }); // insisted → held
  const [hit] = collisions(T0 + 2 * MIN, live);

  assert.equal(hit.file, 'lib/foo.js');
  assert.equal(hit.sameTree, false, 'two worktrees, so this is a merge-time collision');
  assert.deepEqual(
    hit.sessions.map((s) => s.session),
    ['s1', 's2'],
    'the one that has been waiting is named first'
  );
});

/* ------------------------------------------------------------- the round trip */
//
// The half a unit test cannot reach: the hook talks to this over HTTP, so the shape of
// the answer is part of the contract. Real directories here rather than an injected
// `alive` — the endpoint uses the module's own disk check, and a suite that stubbed it
// would not notice the day that check starts pruning everything.

reset();
const { createApp, listen } = await import(path.join(HERE, '..', 'lib', 'server.js'));

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'claims-test-token',
  actor: 'beadcause-test',
  workspaces: [],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const call = (pathname, opts = {}) => {
  // Content-Length rather than chunked, and it is not tidiness: Node's client does not
  // chunk a DELETE (`useChunkedEncodingByDefault` is false for it), so a body written
  // without a length goes out unframed, the server reads it as the head of the next
  // request, and the answer is a bodiless 400 that looks exactly like a rejected claim.
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: {
          'content-type': 'application/json',
          ...(payload ? { 'content-length': payload.length } : {}),
          ...(opts.headers || { 'x-beadcause-token': cfg.token }),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
};

// Two real trees, because the endpoint's liveness check is a real `existsSync`.
const treeA = path.join(tmp, 'wt-a');
const treeB = path.join(tmp, 'wt-b');
fs.mkdirSync(treeA);
fs.mkdirSync(treeB);
const post = (body) => call('/api/claims', { method: 'POST', body });

const a = await post({ session: 'http-a', repo: tmp, file: 'lib/foo.js', dir: treeA, branch: 'worktree-a-aaa1', bead: 'bc-aaa1' });
const b = await post({ session: 'http-b', repo: tmp, file: 'lib/foo.js', dir: treeB, branch: 'worktree-b-bbb2' });

verify('POST /api/claims answers held, then conflict', () => {
  assert.equal(a.status, 200);
  assert.equal(a.body.decision, 'held');
  assert.equal(a.body.reason, '', 'nothing to say when the file was free');
  assert.equal(b.status, 200);
  assert.equal(b.body.decision, 'conflict');
  assert.equal(b.body.holders[0].branch, 'worktree-a-aaa1');
  assert.match(b.body.reason, /bc-aaa1/, 'the refusal the hook prints names the holder’s bead');
});

const insist = await post({ session: 'http-b', repo: tmp, file: 'lib/foo.js', dir: treeB, branch: 'worktree-b-bbb2' });
const listed = await call('/api/claims');

verify('a second POST from the refused session claims it, and GET shows the collision', () => {
  assert.equal(insist.body.decision, 'held');
  assert.equal(insist.body.insisted, true);
  assert.equal(listed.body.claims.length, 2);
  assert.equal(listed.body.collisions.length, 1);
  assert.equal(listed.body.collisions[0].file, 'lib/foo.js');
  assert.equal(listed.body.collisions[0].sameTree, false);
});

const bad = await post({ session: 'http-c', repo: tmp });
const gone = await call('/api/claims', { method: 'DELETE', body: { session: 'http-a' } });
const after = await call('/api/claims');

verify('a claim with no file is a 400, and DELETE releases what a session held', () => {
  assert.equal(bad.status, 400, 'a request missing a required field is refused, not stored');
  assert.equal(gone.body.released, 1);
  assert.deepEqual(
    after.body.claims.map((c) => c.session),
    ['http-b']
  );
  assert.deepEqual(after.body.collisions, [], 'and the collision goes with it');
});

const noToken = await call('/api/claims', { headers: { 'content-type': 'application/json' } });
verify('claims are behind the token like every other /api route', () => {
  assert.equal(noToken.status, 401);
});

// The tree is removed while the claim is still inside its TTL — what `ship` does.
fs.rmSync(treeB, { recursive: true, force: true });
const orphaned = await call('/api/claims');
verify('a shipped worktree stops holding its files without anyone releasing them', () => {
  assert.deepEqual(orphaned.body.claims, []);
});

/* ----------------------------------------------------------------- the client */
//
// `scripts/claim-guard.sh` against this same running server, because the hook FAILS OPEN
// on purpose: no daemon, no token, no `jq`, a timeout — all of them exit 0 and say
// nothing. Which means a hook that is broken in any way at all produces exactly the same
// output as a hook that found nothing to report, and nothing anywhere would notice. This
// is the only test that can tell those apart.

reset();
const HOOK = path.join(HERE, '..', 'scripts', 'claim-guard.sh');
const REPO_DIR = path.join(HERE, '..'); // this worktree — a real git tree, which the hook requires

// Derived the same way the hook derives it, rather than by counting `..` segments: the
// suite has to pass both from a worktree (where main is three levels up) and from the main
// checkout itself (where it is the tree the suite is in).
const MAIN_CHECKOUT = path.dirname(
  execFileSync('git', ['-C', REPO_DIR, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
);

/**
 * How the refusal will name the tree the holder is holding from — derived, not assumed.
 *
 * `refusalFor` says "on <branch>", falling back to the directory's own name when git has
 * no branch to give. This used to be asserted as the literal `worktree-`, which is true of
 * every checkout on Adam's Mac and of nothing else: bc-rcrt ran the suite on a CI runner,
 * where the tree is a detached-HEAD clone in `/Users/runner/work/...`, and the assertion
 * failed over a refusal that had named the holder perfectly well. The promise is that the
 * reason says *where*, so ask git the same question the hook asks and look for that.
 */
const BRANCH = execFileSync('git', ['-C', REPO_DIR, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const WHERE_RE = new RegExp(`on ${(BRANCH || path.basename(REPO_DIR)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

// The config the hook reads to find the daemon. Same CONFIG_DIR the server is using.
fs.writeFileSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'), JSON.stringify({ token: cfg.token, port }));

/**
 * Run the hook as Claude Code runs it: payload on stdin, decision on stdout.
 *
 * `spawn` and not `spawnSync`, and the difference is the whole test rather than a style
 * preference: the daemon under test is *in this process*, and `spawnSync` blocks the event
 * loop until the child exits — so the hook's `curl` connects, waits, and times out against
 * a server that cannot answer until the hook it is answering has finished. It reads as the
 * hook failing to claim anything, which is indistinguishable from the hook being broken.
 */
const hook = (payload, { mode = 'guard', configDir = process.env.BEADCAUSE_CONFIG_DIR } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [...(process.env.CLAIM_TRACE ? ['-x'] : []), HOOK, mode], {
      cwd: REPO_DIR,
      env: { ...process.env, BEADCAUSE_CONFIG_DIR: configDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(JSON.stringify(payload));
  });

const edit = (session, file = 'lib/hooked.js') => ({
  session_id: session,
  cwd: REPO_DIR,
  tool_name: 'Edit',
  tool_input: { file_path: path.join(REPO_DIR, file) },
});

const firstEdit = await hook(edit('hook-a'));
const claimed = await call('/api/claims');

verify('the hook claims the file a Write is about to touch, and says nothing', () => {
  assert.equal(firstEdit.code, 0);
  assert.equal(firstEdit.stdout, '', 'silence is what an uncontested edit costs');
  const mine = claimed.body.claims.find((c) => c.session === 'hook-a');
  // The hook's stderr rides the failure message: a fail-open client that broke silently
  // is otherwise a test failure with nothing in it to act on.
  assert.ok(mine, `the claim reached the daemon — hook stderr: ${firstEdit.stderr || '(none)'}`);
  assert.equal(mine.file, 'lib/hooked.js', 'keyed by the repo-relative path');
  assert.equal(mine.repo, MAIN_CHECKOUT, 'and by the MAIN checkout, not this worktree — two worktrees must collide');
  assert.equal(mine.dir, REPO_DIR, 'while the tree it is held from is this one');
});

const secondEdit = await hook(edit('hook-b'));
verify('a second session editing that file is denied once, with the holder named', () => {
  assert.equal(secondEdit.code, 0, 'a deny is still a successful hook run');
  const out = JSON.parse(secondEdit.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /lib\/hooked\.js/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, WHERE_RE, 'where the holder is');
});

const insistedEdit = await hook(edit('hook-b'));
verify('and the same session insisting is allowed through', () => {
  assert.equal(insistedEdit.stdout, '', 'told once, then it is yours');
});

const releasedHook = await hook({ session_id: 'hook-a' }, { mode: 'release' });
verify('release mode lets go of everything the session held', () => {
  assert.equal(releasedHook.code, 0);
});
const released = await call('/api/claims');
verify('and the daemon has forgotten it', () => {
  assert.equal(
    released.body.claims.filter((c) => c.session === 'hook-a').length,
    0,
    'a session that ended is not still holding lib/hooked.js for ninety minutes'
  );
});

// The failure mode that matters. This Mac runs this hook in front of every edit in every
// session; if a missing or unreadable config could deny, one bad install would stop all of
// them writing anything.
const blind = await hook(edit('hook-c'), { configDir: path.join(tmp, 'nothing-here') });
verify('no daemon config at all is silence, not a blocked edit', () => {
  assert.equal(blind.code, 0);
  assert.equal(blind.stdout, '');
});

const odd = await hook({ session_id: 'hook-d', tool_name: 'Bash', tool_input: { command: 'ls' } });
verify('a tool call with no file path is not the hook’s business', () => {
  assert.equal(odd.code, 0);
  assert.equal(odd.stdout, '');
});

for (const s of servers) s.close();
cleanupTmp(tmp);

/* --------------------------------------------------------------------- report */

console.log(`\n${ran - failures}/${ran} claims checks passed`);
process.exit(failures ? 1 : 0);
