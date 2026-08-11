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
// 7. **And you can answer it.** `POST /api/session-say` types into the session, reach
//    says whether that is possible, and both halves of the promise are pinned here: a
//    session that cannot be reached is refused with the reason rather than accepted and
//    dropped, and what you typed is what goes — the text is no longer flattened to one
//    line, so what is pinned instead is the two AppleScript statements that make a
//    multi-line message land whole. See the note above the send tests for what is
//    deliberately *not* exercised, and why.
//
// The session it reads is this very process: `liveSessions` liveness-checks every pid,
// so a fixture pid would be filtered out before the endpoint ever saw it. Nothing here
// touches a real workspace, a real ~/.claude, or bd.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';

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

// **launchd**, as a second session — and the choice of pid is the whole trick.
//
// The unreachable path has to be tested against something *alive*, or the 404 for a
// dead pid answers first and the reach check is never reached at all. It also has to be
// something that can never turn out to be reachable, because a "reachable" session in
// this test would be typed into for real: `write text` puts words in a live terminal,
// and a suite that did that on a laptop with iTerm open would inject a test string into
// whatever window happened to answer.
//
// pid 1 is both, permanently. It is always running; `liveSessions` counts it alive
// through the EPERM branch, which is exactly what that branch is for; and it has no
// controlling terminal, so `sessionReach` refuses it before any AppleScript is compiled.
const NO_TTY_PID = 1;
fs.writeFileSync(
  path.join(SESSIONS_DIR, `${NO_TTY_PID}.json`),
  JSON.stringify({
    pid: NO_TTY_PID,
    sessionId: 'ffffeeee-dddd-cccc-bbbb-aaaa00002222',
    name: 'a session with no terminal',
    cwd: CWD,
    status: 'idle',
    kind: 'claude',
    startedAt: STARTED,
    statusUpdatedAt: ACTIVE,
  })
);

/* --------------------------------------------------------------------- server */

const cfg = {
  port: 0,
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

const { createApp, listen } = await import(LIB('server.js'));
const servers = listen(cfg, createApp(cfg).handler);
const port = await boundPort(servers);

const call = (pathname, { token = cfg.token, body = null } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: payload === null ? 'GET' : 'POST',
        headers: {
          ...(token ? { 'x-beadcause-token': token } : {}),
          ...(payload === null ? {} : { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: text })
        );
      }
    );
    req.on('error', reject);
    req.end(payload ?? undefined);
  });

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

/* ================================================== and then you can answer it (bc-01p)
 *
 * Watching a session and not being able to say anything to it was the dead end. What
 * follows pins the parts of the answer that are load-bearing and silent when broken.
 *
 * **What is deliberately not here: a successful send.** Delivering a message means
 * `write text` into a live iTerm session, which is a real side effect on the machine
 * running the suite — a test that did it would type a fixture string into whatever
 * window answered, mid-turn, in a session doing real work. So the reach *rule* is
 * tested against a session that can never be reachable (see NO_TTY_PID), the rules about
 * the text are tested as the units they are, the shape of the send is read off the
 * AppleScript, and the delivery itself is left to the one place it can honestly be
 * tried: a phone, against a session you can see.
 */

const { oneLine, pasteSafe, sessionReach } = await import(LIB('session.js'));

/* --------------------------------------------------------------- reach, on the record */

const reachable = JSON.parse((await call(`/api/session-log?pid=${process.pid}`)).body || '{}');
check(() => {
  // Not `can: true`: whether *this* process is in an iTerm window depends on how the
  // suite was started — `npm test` in iTerm yes, over ssh or from the daemon no — and a
  // test that demanded one of those would fail for being run correctly. The invariant
  // the page actually leans on is that the answer is a boolean and never bare.
  assert.equal(typeof reachable.reach, 'object', `reach was ${JSON.stringify(reachable.reach)}`);
  assert.equal(typeof reachable.reach.can, 'boolean');
  assert.ok('tty' in reachable.reach, 'reach carries the tty it resolved');
}, 'the record says whether the session can be spoken to');

check(() => {
  // The second acceptance criterion, as an invariant rather than a wording: a refusal
  // always carries a sentence, because the page has nothing else to show and an empty
  // `why` would render as a session that silently offers nothing.
  if (reachable.reach.can) {
    assert.equal(reachable.reach.why, null, 'a reachable session has nothing to explain');
  } else {
    assert.ok(String(reachable.reach.why || '').trim().length > 10, JSON.stringify(reachable.reach));
  }
}, 'and a refusal is never bare — there is always a reason to show');

const noTty = JSON.parse((await call(`/api/session-log?pid=${NO_TTY_PID}`)).body || '{}');
check(() => {
  assert.equal(noTty.reach.can, false, JSON.stringify(noTty.reach));
  assert.equal(noTty.reach.tty, null);
  assert.match(noTty.reach.why, /no terminal/i);
}, 'a live session with no controlling terminal is unreachable, and says which way');

// Straight at the function, because the endpoint could only ever agree with it, and this
// is the join the whole feature rests on: pid → tty → the window showing it. Awaited out
// here because `check` is synchronous — a promise handed to it would report a pass before
// the assertion had run.
const direct = await sessionReach(NO_TTY_PID);
const nonsense = await sessionReach(-1);
check(() => {
  assert.equal(direct.can, false, JSON.stringify(direct));
  assert.equal(nonsense.can, false, JSON.stringify(nonsense));
}, 'sessionReach refuses a pid with no terminal and a pid that is not one');

/* ------------------------------------------------------------------- saying something */

const dumb = await call('/api/session-say', { body: { pid: process.pid, text: '   \n  ' } });
check(() => {
  assert.equal(dumb.status, 400);
  assert.match(JSON.parse(dumb.body).error, /nothing to say/);
}, 'whitespace is not a message — refused before anything is delivered');

const toDead = await call('/api/session-say', { body: { pid: DEAD, text: 'anyone there' } });
check(() => {
  assert.equal(toDead.status, 404);
  assert.match(JSON.parse(toDead.body).error, new RegExp(String(DEAD)));
}, 'a pid that has gone is a 404 naming it, not a message quietly dropped');

const toUnreachable = await call('/api/session-say', { body: { pid: NO_TTY_PID, text: 'hello?' } });
check(() => {
  const data = JSON.parse(toUnreachable.body);
  // 409 rather than 400: the request was fine, the session cannot take it. And the
  // reason rides along so a tab that has been open since before the window closed
  // corrects its own composer instead of offering the box a second time.
  assert.equal(toUnreachable.status, 409, toUnreachable.body);
  assert.match(data.error, /no terminal/i);
  assert.equal(data.reach?.can, false, `reach was ${JSON.stringify(data.reach)}`);
}, 'a session out of reach refuses with the reason, and hands the reason back');

const huge = await call('/api/session-say', { body: { pid: NO_TTY_PID, text: 'x'.repeat(9000) } });
check(() => {
  // Past ARG_MAX `osascript` fails, and the error it fails with reads as "that session
  // is gone" — which is the one lie this endpoint cannot tell. Refused up front, with a
  // number in it, and refused *before* the reach check so the message is about the
  // message rather than about the session.
  assert.equal(huge.status, 413, huge.body);
  assert.match(JSON.parse(huge.body).error, /9000 characters/);
}, 'a message too long to type is refused for being too long, not for the wrong reason');

const unauth = await call('/api/session-say', { token: '', body: { pid: NO_TTY_PID, text: 'hi' } });
check(() => {
  assert.equal(unauth.status, 401);
}, 'and typing into a session on this Mac needs the token, like everything else');

/* ------------------------------------------------------ what is done to the text (bc-75q2) */

// A successful send cannot be tested here — it would type into a real window — but the
// length refusal happens *before* the reach check, and it is computed on the text the
// endpoint is about to deliver. So a message whose flattened form would fit and whose
// real form does not tells the two behaviours apart from outside, with nothing delivered:
// 8028 characters over 730 paragraphs, which flattening would shrink to 7299 and let
// through as a 409 from the unreachable pid instead.
const PARAS = 'x'.repeat(9);
const manyLines = `${PARAS}\n\n`.repeat(730);
const long = await call('/api/session-say', { body: { pid: NO_TTY_PID, text: manyLines } });
check(() => {
  assert.equal(long.status, 413, `${long.status}: ${long.body}`);
  assert.match(
    JSON.parse(long.body).error,
    new RegExp(`${manyLines.trim().length} characters`),
    'the count is of the message as typed — a flattened one would be shorter, and would have fit'
  );
}, 'the endpoint measures the message with its newlines in it, because that is what it sends');

check(() => {
  // Still exported, still exact, and now a choice rather than a toll: `checkinMessage`
  // calls it because a check-in reads better as one line in a window someone is working
  // in. Nothing on the send path calls it any more, which is the point of the bead.
  assert.equal(oneLine('two\n\nparagraphs'), 'two paragraphs');
  assert.equal(oneLine('  trailing \n'), 'trailing');
  assert.equal(oneLine('a\n  b\n\tc'), 'a b c');
  assert.equal(oneLine('already one line'), 'already one line');
}, 'oneLine survives for the templates that want one line');

check(() => {
  // The one thing still done to a message on the way out. Inside a bracketed paste
  // Claude Code submits on CR and breaks a line on LF, so a stray `\r\n` would send the
  // first half and type the second half into the next turn — the exact failure the
  // flattening used to prevent, arriving by a different door.
  assert.equal(pasteSafe('first\r\nsecond'), 'first\nsecond');
  assert.equal(pasteSafe('old mac\rstyle'), 'old mac\nstyle');
  assert.equal(pasteSafe('already\nfine'), 'already\nfine');
  assert.ok(!/\r/.test(pasteSafe('a\r\nb\rc\n\r\nd')));
}, 'and a carriage return never reaches the pty, because it would submit mid-message');

/* ------------------------------------------------ the channel itself, in the AppleScript */

const applescript = fs.readFileSync(path.join(ROOT, 'scripts', 'message-session.applescript'), 'utf8');
check(() => {
  // Two comparisons, one line, and the second one is the whole of how a session this
  // daemon never opened is addressed. Drop it and the advocate's own workers go on
  // working — it kept their iTerm session ids — while every session started at the
  // keyboard silently answers `missing`, which is indistinguishable from a closed
  // window. That is the failure this check exists for.
  assert.match(applescript, /id of s\) as text\) is equal to wantedId or \(tty of s\) is equal to wantedId/);
}, 'the AppleScript addresses a session by its tty as well as by its id');

check(() => {
  // The whole of bc-75q2, in the two statements that replaced one. `newline no` is what
  // stops the paste submitting itself — without it `write text` presses return at the
  // end of the *first* line and the rest of the message is typed into the next turn,
  // which is the bug the flattening existed to hide. The bare `write text ""` after it
  // is the single Return that sends the lot as one turn; drop that and the message sits
  // in the composer forever, delivered and unsent, with `sent` reported to the phone.
  assert.match(applescript, /write text pasted newline no/, 'the paste must not press return');
  assert.match(applescript, /write text ""\s*$/m, 'and something has to press it exactly once');
  // Built here rather than passed through argv: the markers are the one part that must
  // be exactly right, and they are ESC bytes travelling through a shell-free execFile,
  // an AppleScript literal and a pty. One place to get them wrong is enough.
  assert.match(applescript, /ASCII character 27/);
  assert.match(applescript, /esc & "\[200~" & theText & esc & "\[201~"/);
}, 'and sends a multi-line message as a bracketed paste with one Return after it');

check(() => {
  // `/api/session-log` polls every two seconds. Without this guard, a phone opening a
  // session page would launch iTerm on the Mac to find out whether iTerm was running.
  assert.match(applescript, /is running\) then return "missing"/);
  const ttys = fs.readFileSync(path.join(ROOT, 'scripts', 'iterm-ttys.applescript'), 'utf8');
  assert.match(ttys, /if not \(application id "com\.googlecode\.iterm2" is running\) then return ""/);
}, 'and neither script ever launches iTerm to ask it a question');

check(() => {
  // The mirror of the transcript check above: one page types into a session, so there is
  // one place the composer can be.
  const senders = fs
    .readdirSync(path.join(ROOT, 'public'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.readFileSync(PUBLIC(f), 'utf8').includes('/api/session-say'));
  assert.deepEqual(senders, ['session.js'], `senders on /api/session-say: ${senders.join(', ')}`);
}, 'and public/session.js is the only page that talks back to one');

/* --------------------------------------------------------------------- teardown */

for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(failures ? `${failures} of ${ran} failed` : `${ran} checks passed`);
process.exit(failures ? 1 : 0);
