#!/usr/bin/env node
//
// One session detail, reachable from everywhere a session is listed.
//
//   npm test
//   node test/session.mjs
//
// A session appears in three lists — the advocate console's worker and "Claude sessions"
// rows, its Elsewhere card, and the mirror — and the detail behind it used to exist in
// exactly one place: folded inline under the row on /sessions, a page that has since been
// merged into the console precisely because giving every row this one address left it a
// strict duplicate. So the same tap on the same session used to mean "show me what it is
// doing" in one place and nothing at all in the others. `/session?pid=…` is that detail
// with an address, and this file pins the parts of the move that a reasonable refactor
// breaks silently:
//
// 1. **`/api/session-log` carries the whole record, not just the transcript.** The page
//    has no `/api/work` payload behind it to have taken the cwd, the workspace and the
//    start time out of, so a response trimmed back to `{pid, sessionId, status}` — which
//    is exactly what it used to return — leaves the facts pane empty with nothing on
//    screen to say why. One request for the lot also means the facts and the transcript
//    can never disagree about which conversation the process is on, which matters
//    because `/clear` gives it a new one without the pid changing.
// 2. **A pid that is not running is a 404 that says so.** "It finished" and "it has done
//    nothing yet" must not read the same, and the page stops polling on the 404 rather
//    than asking forever about a pid that will never come back.
// 3. **`file` comes back even with no lines**, so an empty pane says where it looked.
// 4. **`/session` is a page**, served like /doc and /graph — and it must not need a
//    token in the URL, because it takes it from localStorage and asks the API itself.
// 5. **The drawer owns `/session`.** One line in public/drawer.js decides whether a tap
//    on a row navigates the tab away or opens a panel over it, and nothing about it is
//    visible from the server.
// 6. **One reader of the transcript endpoint, and one address for a session.** That is
//    the whole of what this bead asked for: if a list grows its own inline pane again, or
//    links somewhere else, the detail has stopped being in one place.
//
// The session it reads is this very process: `liveSessions` liveness-checks every pid,
// so a fixture pid would be filtered out before the endpoint ever saw it. Nothing here
// touches a real workspace, a real ~/.claude, or bd.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const PUBLIC = (f) => path.join(ROOT, 'public', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-session-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\none session detail, one address\n');

/* ------------------------------------------------------------------- fixtures */

const { slugFor } = await import(LIB('transcript.js'));

// A checkout under a project root, so `workspaceFor` has something to map: the rule is
// `<projectRoot>/<repo>` → `~/beads/<repo>/.beads`, and the workspace's dir is compared
// as a path rather than opened, so nothing has to exist under the home directory.
const PROJECTS = path.join(tmp, 'projects');
const CWD = path.join(PROJECTS, 'demo', '.claude', 'worktrees', 'a-thing-4e7');
fs.mkdirSync(CWD, { recursive: true });

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
const PROMPT = 'what is this session actually doing';

const SESSIONS_DIR = path.join(tmp, 'claude', 'sessions');
const PROJECTS_DIR = path.join(tmp, 'claude', 'projects');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(PROJECTS_DIR, slugFor(CWD)), { recursive: true });

const STARTED = Date.now() - 90 * 60 * 1000;
const ACTIVE = Date.now() - 30 * 1000;

// This process, so the liveness check passes. A record for a made-up pid is dropped by
// liveSessions before the endpoint sees it, which is the whole reason it exists.
fs.writeFileSync(
  path.join(SESSIONS_DIR, `${process.pid}.json`),
  JSON.stringify({
    pid: process.pid,
    sessionId: SESSION_ID,
    name: 'Beadcause - bc-h2s one session detail',
    cwd: CWD,
    status: 'busy',
    kind: 'claude',
    startedAt: STARTED,
    statusUpdatedAt: ACTIVE,
  })
);

fs.writeFileSync(
  path.join(PROJECTS_DIR, slugFor(CWD), `${SESSION_ID}.jsonl`),
  [
    JSON.stringify({ type: 'user', message: { content: PROMPT } }),
    // A line in a shape this does not know: one bad entry must not cost the others.
    '{"type":"file-history-snapshot"',
    '',
  ].join('\n')
);

/* --------------------------------------------------------------------- server */

const cfg = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'session-test-token',
  actor: 'beadcause-test',
  projectRoot: PROJECTS,
  fallbackWorkspace: 'demo',
  workspaces: [{ name: 'demo', dir: path.join(os.homedir(), 'beads', 'demo', '.beads') }],
  claudeSessionsDir: SESSIONS_DIR,
  claudeProjectsDir: [PROJECTS_DIR],
  openSessions: false,
  autoDispatch: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

// A port picked up front rather than `port: 0`: listen() binds asynchronously and hands
// the servers back immediately, so address() is still null on the next line.
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const { createApp, listen } = await import(LIB('server.js'));
const servers = listen({ ...cfg, port }, createApp({ ...cfg, port }).handler);

const call = (pathname, { token = cfg.token } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers: token ? { 'x-beadcause-token': token } : {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
      }
    );
    req.on('error', reject);
    req.end();
  });

for (let i = 0; i < 100; i += 1) {
  try {
    await call('/api/health');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/* --------------------------------------------------- the record, not just the log */

const live = await call(`/api/session-log?pid=${process.pid}`);
const rec = JSON.parse(live.body || '{}');

check(() => {
  assert.equal(live.status, 200);
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.sessionId, SESSION_ID);
  assert.equal(rec.status, 'busy');
}, 'a live pid answers with that session');

check(() => {
  // The four fields the facts pane on /session?pid=… has nowhere else to get. This is
  // the regression: the endpoint used to return pid, sessionId and status only, which
  // is everything the inline pane needed and not enough for a page of its own.
  assert.equal(rec.name, 'Beadcause - bc-h2s one session detail', 'name');
  assert.equal(rec.cwd, CWD, 'cwd');
  assert.equal(rec.kind, 'claude', 'kind');
  assert.equal(new Date(rec.startedAt).getTime(), STARTED, 'startedAt');
}, 'and with the whole record — name, cwd, kind and when it started');

check(() => {
  // A worktree resolves to its parent repo's workspace, which is what makes the row
  // and the detail agree about which tracker this session writes to.
  assert.equal(rec.workspace, 'demo');
  assert.equal(rec.where, path.basename(CWD));
}, 'including which workspace a shell in that directory would use');

check(() => {
  assert.ok(rec.file && rec.file.endsWith(`${SESSION_ID}.jsonl`), `file was ${JSON.stringify(rec.file)}`);
  assert.ok(
    (rec.lines || []).some((l) => l.includes(PROMPT)),
    `lines were ${JSON.stringify(rec.lines)}`
  );
}, 'the transcript is tailed from the file the session id names');

check(() => {
  // One unparseable line in a file being appended to right now must not cost the
  // three hundred around it.
  assert.equal((rec.lines || []).length, 1, JSON.stringify(rec.lines));
}, 'and a half-written line is skipped rather than throwing');

/* ---------------------------------------------- a transcript with nothing in it yet */

// Only bookkeeping entries — the shapes a terminal never showed. A session a minute old
// looks exactly like this, and the pane has to be able to tell "nothing yet" from "no
// file at all", which it can only do if `file` comes back either way.
fs.writeFileSync(
  path.join(PROJECTS_DIR, slugFor(CWD), `${SESSION_ID}.jsonl`),
  `${JSON.stringify({ type: 'system', subtype: 'mode', mode: 'default' })}\n`
);
const quiet = JSON.parse((await call(`/api/session-log?pid=${process.pid}`)).body || '{}');
check(() => {
  assert.deepEqual(quiet.lines, []);
  assert.ok(quiet.file && quiet.file.endsWith(`${SESSION_ID}.jsonl`), `file was ${JSON.stringify(quiet.file)}`);
}, 'a transcript with nothing worth showing still says where it looked');

/* ------------------------------------------------------------ a pid that has gone */

// Not merely unused: a pid this process cannot be. Picked high and checked, because a
// recycled pid would make this case pass for the wrong reason.
const DEAD = (() => {
  for (let candidate = 999999; candidate > 900000; candidate -= 7) {
    try {
      process.kill(candidate, 0);
    } catch (err) {
      if (err.code !== 'EPERM') return candidate;
    }
  }
  return 999999;
})();

const gone = await call(`/api/session-log?pid=${DEAD}`);
check(() => {
  assert.equal(gone.status, 404);
  assert.match(JSON.parse(gone.body).error, new RegExp(String(DEAD)));
}, 'a pid that is not running is a 404 naming it, not an empty pane');

const nameless = await call('/api/session-log');
check(() => {
  assert.equal(nameless.status, 404);
  assert.match(JSON.parse(nameless.body).error, /none given/);
}, 'and no pid at all says so rather than picking one');

const unauthorised = await call(`/api/session-log?pid=${process.pid}`, { token: '' });
check(() => {
  assert.equal(unauthorised.status, 401);
}, 'a transcript is the most sensitive thing here — no token, no read');

/* ------------------------------------------------------------------- the page */

const page = await call('/session');
check(() => {
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /src="\/session\.js"/);
  // Both halves of the drawer, exactly as /doc.html and /graph.html load it.
  assert.match(page.body, /src="\/drawer\.js"/);
}, '/session serves the session page, with the drawer loaded');

const withPid = await call(`/session?pid=${process.pid}`);
check(() => {
  assert.equal(withPid.status, 200);
  assert.equal(withPid.body, page.body);
}, 'and the pid rides in the query rather than choosing a different page');

const noToken = await call('/session', { token: '' });
check(() => {
  assert.equal(noToken.status, 200);
}, 'the page itself needs no token — it takes one from localStorage and asks the API');

/* ------------------------------------------- one address, and the drawer owns it */

const drawer = fs.readFileSync(PUBLIC('drawer.js'), 'utf8');
check(() => {
  const line = drawer.split('\n').find((l) => l.includes('const DETAIL'));
  assert.ok(line, 'no DETAIL set in public/drawer.js');
  assert.ok(line.includes("'/session'"), line.trim());
  // The .html twin matters: serveStatic rewrites /session to /session.html, so a
  // request that arrives already spelled that way must be recognised too.
  assert.ok(line.includes("'/session.html'"), line.trim());
}, 'the drawer owns /session, so a row opens over the tab rather than navigating it away');

/* Every page in public/ that lists a session. `work.js` was one until the sessions view
   was merged into the advocate console; the list is short enough to name, and a new page
   that lists sessions and forgets the address belongs here rather than in a glob. */
const LISTS = ['monitor.js', 'mirror.js'];
for (const file of LISTS) {
  const src = fs.readFileSync(PUBLIC(file), 'utf8');
  check(() => {
    // assert.ok rather than assert.match: a failing match prints the whole file, and
    // twenty thousand characters of client source says less than one sentence.
    assert.ok(/\/session\?pid=/.test(src), `public/${file} never mentions /session?pid=`);
  }, `public/${file} sends a session row to the one address`);
}

check(() => {
  // The whole point of the bead: the transcript has one reader, so there is one place
  // the detail can be. A second fetch of it here is a second detail view growing back.
  const readers = fs
    .readdirSync(path.join(ROOT, 'public'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.readFileSync(PUBLIC(f), 'utf8').includes('/api/session-log'));
  assert.deepEqual(readers, ['session.js'], `readers of /api/session-log: ${readers.join(', ')}`);
}, 'and public/session.js is the only page that reads a transcript');

/* --------------------------------------------------------------------- teardown */

for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(failures ? `${failures} of ${ran} failed` : `${ran} checks passed`);
process.exit(failures ? 1 : 0);
