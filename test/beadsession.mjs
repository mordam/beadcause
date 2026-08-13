#!/usr/bin/env node
//
// What a session left behind, for a bead whose session has finished.
//
//   npm test
//   node test/beadsession.mjs
//
// `/session?pid=…` cannot be this page and never could: it resolves a *running process*
// and 404s once the pid has gone, which is right for a session that exited between the
// refresh and the tap and useless for a bead that closed in June. `/bead-session` is the
// archived counterpart, addressed by workspace and bead, and it reads what the session
// wrote into `refs/beadcause/sessions/<bead>` when it exited.
//
// What is pinned here is **absence**, because absence is the design rather than an edge
// case. The page shows three things — the memories, the log, where the worktree went — and
// each is missing independently: a bead closed by hand from the phone had no session at
// all, a session that crashed may have a log and no memory, a session that never entered a
// worktree has no worktree to have gone anywhere. Every one of those has to read as an
// ordinary state and not as a broken page, and the way that is achieved is the thing most
// likely to be undone by a reasonable-looking refactor:
//
// 1. **The page is told which files exist, it does not find out by trying.**
//    `session.files[]` is the archived tree, listed. Take that away and each section has
//    to fire a read and infer absence from a 404 — which is how you get a link that opens
//    an empty pane, and a section that says "not available" only after a request that
//    might have failed for a completely different reason.
// 2. **`memory.md` is readable through `/api/session-archive`.** That handler allows a
//    fixed set of names on purpose, so a crafted `file` cannot walk into arbitrary tree
//    content; a reader added without the name on the list is a page whose main section can
//    never work.
// 3. **A retired worktree is still a *registered* worktree.** The sweep in lib/tidy.js
//    *moves* the directory into `.claude/worktrees-retired/` and the registration follows
//    it, so "is it in `git worktree list`" answers yes for both live and retired. What
//    separates them is which path the registration carries — which is why `worktreeState`
//    matches on the path `meta.json` recorded rather than on the worktree's name.
// 4. **A bead with no archive at all is not an error.** Most beads in a tracker were never
//    worked by a session. `{session: null}` and a page that says so, never a 404.
// 5. **It reads and does nothing else.** A static assertion on the client, because
//    read-only is the kind of property that survives right up until someone adds a
//    convenience button.
//
// Real git throughout — a fixture repo in a temp dir with real archive commits written
// with the same plumbing lib/sessionlog.js uses, and a real worktree added and retired.
// No `bd`, no advocates, no poller, and nothing that leaves the machine: `pr=1` is never
// asked for here, which is the only thing on this path that would want `gh`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const PUBLIC = (f) => path.join(ROOT, 'public', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-beadsession-'));
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

const git = (args, cwd = repo) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'beadcause-test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'beadcause-test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });

git(['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
git(['add', '-A']);
git(['commit', '-qm', 'first']);
const head = git(['rev-parse', 'HEAD']).trim();

/**
 * An archive commit, written the way lib/sessionlog.js writes one.
 *
 * Not through `archiveSession` itself: that derives the worktree from a real Claude Code
 * transcript directory and the commit list from a real branch, neither of which can be
 * faked convincingly — and what is being tested here is the *reader*, which cares only
 * about the shape of the tree. So the tree is built by hand, which also makes it possible
 * to write a `memory.md` before anything in the app writes one.
 */
function archive(bead, files) {
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
  const commit = git([
    'commit-tree',
    tree,
    ...(parent ? ['-p', parent] : []),
    '-m',
    `demo/${bead} · ended`,
  ]).trim();
  git(['update-ref', ref, commit]);
  return commit;
}

/* Three worktrees, one in each of the three states the page has to tell apart. */
const liveWt = path.join(repo, '.claude', 'worktrees', 'live-aaa');
git(['worktree', 'add', '-q', '-b', 'worktree-live-aaa', liveWt]);

const retiredWt = path.join(repo, '.claude', 'worktrees', 'retired-bbb');
git(['worktree', 'add', '-q', '-b', 'worktree-retired-bbb', retiredWt]);
const atticRoot = path.join(repo, '.claude', 'worktrees-retired');
fs.mkdirSync(atticRoot, { recursive: true });
// Exactly what the sweep does: move the directory, keep the registration pointing at the
// new place, and stamp a `.note` beside it. `git worktree move` is what re-registers it.
git(['worktree', 'move', retiredWt, path.join(atticRoot, 'retired-bbb')]);
fs.writeFileSync(
  path.join(atticRoot, 'retired-bbb.note'),
  `2026-08-09T12:00:00.000Z  retired by beadcause after ${head}\n`
);

const goneWt = path.join(repo, '.claude', 'worktrees', 'gone-ccc');

/* -------------------------------------------------------------------- the archives */

const FULL = 'bc-full';
const fullMeta = {
  bead: FULL,
  workspace: 'demo',
  title: 'A session that left everything',
  outcome: 'ended',
  exitCode: 0,
  sessionId: '11111111-2222-3333-4444-555555555555',
  startedAt: '2026-08-09T10:00:00.000Z',
  endedAt: '2026-08-09T11:30:00.000Z',
  branch: 'worktree-live-aaa',
  worktree: liveWt,
  commits: [head],
  commitsFrom: 'not-in-main',
  transcriptBytes: 1_700_000,
  archivedBy: 'beadcause',
};
const fullCommit = archive(FULL, {
  'meta.json': JSON.stringify(fullMeta, null, 2) + '\n',
  'session.log': 'the log of a session that finished\n',
  'memory.md': 'What surprised me: the attic is not permanent.\n',
});

/* The common case today: a log and metrics, and no memory at all. */
const BARE = 'bc-bare';
const bareCommit = archive(BARE, {
  'meta.json':
    JSON.stringify(
      { ...fullMeta, bead: BARE, title: '', worktree: path.join(atticRoot, '..', 'worktrees', 'retired-bbb'), branch: 'worktree-retired-bbb' },
      null,
      2
    ) + '\n',
  'session.log': 'a session that wrote no memory\n',
});

/* A worktree that has been removed outright, which is where a landed one ends up. */
const GONE = 'bc-gone';
const goneCommit = archive(GONE, {
  'meta.json': JSON.stringify({ ...fullMeta, bead: GONE, worktree: goneWt, branch: 'worktree-gone-ccc' }, null, 2) + '\n',
  'session.log': 'its worktree is gone\n',
});

/* Two sessions on one bead — what happens whenever the first attempt handed it back. */
const TWICE = 'bc-twice';
archive(TWICE, { 'meta.json': JSON.stringify({ ...fullMeta, bead: TWICE, worktree: null }, null, 2) + '\n', 'session.log': 'first\n' });
const secondCommit = archive(TWICE, {
  'meta.json': JSON.stringify({ ...fullMeta, bead: TWICE, worktree: null }, null, 2) + '\n',
  'session.log': 'second\n',
});

/* A session archived by something older than the metrics: no meta.json at all. */
const NOMETA = 'bc-nometa';
archive(NOMETA, { 'session.log': 'no metrics for this one\n' });

/* ------------------------------------------------------- the reader, on its own first */

console.log('\nwhat a finished session left behind\n');

const { readSessionDetail, worktreeState } = await import(LIB('sessionlog.js'));
const { mainCheckout } = await import(LIB('gitref.js'));

await check('the tree is listed, so the page knows what exists before it asks', async () => {
  const d = await readSessionDetail(repo, FULL);
  assert.equal(d.session.commit, fullCommit);
  assert.deepEqual([...d.session.files].sort(), ['memory.md', 'meta.json', 'session.log']);
  assert.equal(d.session.meta.title, 'A session that left everything');
  assert.equal(d.session.meta.commitsFrom, 'not-in-main');
});

await check('a session with no memory says so by omission, not by a failed read', async () => {
  const d = await readSessionDetail(repo, BARE);
  assert.ok(d.session.files.includes('session.log'));
  assert.ok(!d.session.files.includes('memory.md'), 'memory.md must not be listed for a tree without one');
});

await check('a live worktree is live, and a retired one is not', async () => {
  const live = await readSessionDetail(repo, FULL);
  assert.equal(live.worktree.state, 'live');
  assert.equal(live.worktree.branch, 'worktree-live-aaa');
  assert.equal(live.worktree.pr, null, 'no gh call unless asked for one');

  // The case the ordering exists for: this worktree is *still registered*, under its
  // attic path, so "is it in `git worktree list`" is true for both states.
  const retired = await readSessionDetail(repo, BARE);
  assert.equal(retired.worktree.state, 'retired');
  assert.equal(retired.worktree.retiredAt, '2026-08-09T12:00:00.000Z');
  assert.ok(retired.worktree.at.includes('worktrees-retired'), `at was ${retired.worktree.at}`);
});

await check('and a worktree that was removed outright is gone, which is not a fault', async () => {
  const d = await readSessionDetail(repo, GONE);
  assert.equal(d.worktree.state, 'gone');
  assert.equal(d.worktree.retiredAt, null);
  assert.equal(d.worktree.at, null);
});

await check('a session that ran in the main checkout says so rather than claiming a worktree', async () => {
  // The main checkout is a registered worktree like any other, so this comes back `live`
  // under the repo's own name — true, and it reads as though the session had a worktree
  // kept for it. Real archives in this repo are full of these.
  const bead = 'bc-inmain';
  archive(bead, {
    'meta.json': JSON.stringify({ ...fullMeta, bead, worktree: repo, branch: 'main' }, null, 2) + '\n',
    'session.log': 'no worktree was entered\n',
  });
  const d = await readSessionDetail(repo, bead);
  assert.equal(d.worktree.state, 'live');
  assert.equal(d.worktree.isMain, true, 'the checkout itself must be distinguishable from a worktree');

  const live = await readSessionDetail(repo, FULL);
  assert.equal(live.worktree.isMain, false);
});

await check('a session that never entered a worktree has no worktree, not a broken one', async () => {
  const d = await readSessionDetail(repo, TWICE);
  assert.equal(d.worktree, null);
});

await check('a bead with no archive at all is an empty answer, not a failure', async () => {
  const d = await readSessionDetail(repo, 'bc-never');
  assert.equal(d.session, null);
  assert.deepEqual(d.sessions, []);
  assert.equal(d.worktree, null);
  assert.equal(d.ref, 'refs/beadcause/sessions/bc-never');
});

await check('an unparseable meta.json is a hole in the metrics, not a failed page', async () => {
  const bead = 'bc-broken';
  archive(bead, { 'meta.json': 'not json at all\n', 'session.log': 'still readable\n' });
  const d = await readSessionDetail(repo, bead);
  assert.equal(d.session.meta, null);
  assert.ok(d.session.files.includes('session.log'), 'the log survives a bad meta.json');
});

await check('a session archived before the metrics existed reads with no meta.json', async () => {
  const d = await readSessionDetail(repo, NOMETA);
  assert.equal(d.session.meta, null);
  assert.deepEqual(d.session.files, ['session.log']);
});

await check('the newest session is the default, and an older one is reachable by commit', async () => {
  const newest = await readSessionDetail(repo, TWICE);
  assert.equal(newest.sessions.length, 2);
  assert.equal(newest.session.commit, secondCommit);

  const older = newest.sessions[1].commit;
  const back = await readSessionDetail(repo, TWICE, { commit: older });
  assert.equal(back.session.commit, older);
});

await check("a commit from another bead's ref is not this bead's session", async () => {
  const d = await readSessionDetail(repo, TWICE, { commit: goneCommit });
  assert.equal(d.session, null, 'a commit outside this ref must not render as this bead');
});

await check('worktreeState answers for a path that was never a worktree', async () => {
  const main = await mainCheckout(repo);
  const wt = await worktreeState(main, path.join(repo, '.claude', 'worktrees', 'never-existed'));
  assert.equal(wt.state, 'gone');
  assert.equal(wt.name, 'never-existed');
});

/* --------------------------------------------------------------- through the server */

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'beadsession-token',
  actor: 'beadcause-test',
  workspaces: [{ name: 'demo', dir: wsDir }],
  // Points the archive reader at the fixture repo, which is what a real install resolves
  // from `projectRoot` and what this test cannot rely on having.
  sessionDirs: { demo: repo },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const app = createApp({ ...cfg, port });
const servers = listen({ ...cfg, port }, app.handler);

const get = (pathname, { auth = true } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers: auth ? { 'x-beadcause-token': cfg.token } : {},
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on('error', reject);
    req.end();
  });

const json = async (pathname) => {
  const res = await get(pathname);
  return { status: res.status, data: JSON.parse(res.body || '{}') };
};

for (let i = 0; i < 100; i += 1) {
  try {
    await get('/icon.svg');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}

await check('GET /api/bead-session carries the tree listing, the metrics and the worktree', async () => {
  const { status, data } = await json(`/api/bead-session?workspace=demo&id=${FULL}`);
  assert.equal(status, 200);
  assert.equal(data.id, FULL);
  assert.equal(data.workspace, 'demo');
  assert.deepEqual([...data.session.files].sort(), ['memory.md', 'meta.json', 'session.log']);
  assert.equal(data.session.meta.outcome, 'ended');
  assert.equal(data.worktree.state, 'live');
});

await check('and none of the archived text rides on it — that is the other endpoint', async () => {
  const { data } = await json(`/api/bead-session?workspace=demo&id=${FULL}`);
  assert.equal(data.session.text, undefined);
  assert.ok(!JSON.stringify(data).includes('the log of a session that finished'));
});

await check('memory.md is readable through /api/session-archive', async () => {
  const { status, data } = await json(`/api/session-archive?workspace=demo&commit=${fullCommit}&file=memory.md`);
  assert.equal(status, 200);
  assert.match(data.text, /the attic is not permanent/);
});

await check('and the allowlist still refuses anything else', async () => {
  const { status } = await json(`/api/session-archive?workspace=demo&commit=${fullCommit}&file=../../etc/passwd`);
  assert.equal(status, 400);
});

await check('a tree with no memory 404s that read rather than inventing one', async () => {
  const { status } = await json(`/api/session-archive?workspace=demo&commit=${bareCommit}&file=memory.md`);
  assert.equal(status, 404);
});

await check('a bead nothing ever ran on answers, and says nothing ran', async () => {
  const { status, data } = await json('/api/bead-session?workspace=demo&id=bc-nothing');
  assert.equal(status, 200, 'a bead with no session must not 404 — most beads have none');
  assert.equal(data.session, null);
  assert.ok(data.ref.endsWith('bc-nothing'));
});

await check('a bead id that is not one is refused, and so is a bad commit', async () => {
  assert.equal((await json('/api/bead-session?workspace=demo&id=../../etc')).status, 400);
  assert.equal((await json(`/api/bead-session?workspace=demo&id=${FULL}&commit=nonsense`)).status, 400);
});

await check('it needs the token, like everything else under /api', async () => {
  const res = await get(`/api/bead-session?workspace=demo&id=${FULL}`, { auth: false });
  assert.equal(res.status, 401);
});

await check('/bead-session and /archive both serve the page, with no token in the URL', async () => {
  for (const p of ['/bead-session', '/archive', '/beadsession.html']) {
    const res = await get(p, { auth: false });
    assert.equal(res.status, 200, `${p} answered ${res.status}`);
    assert.ok(res.body.includes('/beadsession.js'), `${p} did not serve the page`);
  }
});

/* ------------------------------------------------------- what the page itself promises */

const CLIENT = fs.readFileSync(PUBLIC('beadsession.js'), 'utf8');

await check('every section has the words "not available" for its own missing piece', async () => {
  // Three of them, one per section, so a refactor that folds the three into one generic
  // "nothing here" cannot pass this while losing the reason each of them gives.
  const nots = CLIENT.match(/Not available\./g) || [];
  assert.ok(nots.length >= 3, `found ${nots.length} — the memories, the log and the worktree each need one`);
  assert.match(CLIENT, /files\.includes\('memory\.md'\)/, 'the memory section must ask the listing, not the server');
  assert.match(CLIENT, /files\.includes\('session\.log'\)/, 'and so must the log section');
});

await check('the page reads and does nothing else — no non-GET request anywhere in it', async () => {
  assert.ok(!/method:\s*'(POST|PUT|DELETE|PATCH)'/.test(CLIENT), 'a write appeared on a page that only reads');
  assert.ok(!/sendBeacon/.test(CLIENT), 'sendBeacon is a POST');
});

await check('and it does not poll: nothing behind it can change', async () => {
  assert.ok(!/setInterval/.test(CLIENT), 'an archive commit is immutable — a poll asks a settled question');
});

await check('the drawer owns it, so a tap from a list keeps your place in the list', async () => {
  const drawer = fs.readFileSync(PUBLIC('drawer.js'), 'utf8');
  assert.match(drawer, /'\/bead-session'/);
  assert.match(drawer, /'\/beadsession\.html'/);
});

await check('and the service worker ships the page with the stylesheet it needs', async () => {
  const sw = fs.readFileSync(PUBLIC('sw.js'), 'utf8');
  for (const p of ['/bead-session', '/archive', '/beadsession.html', '/beadsession.js']) {
    assert.ok(sw.includes(`'${p}'`), `${p} is not in the service worker shell`);
  }
});

/* ------------------------------------------------- and what it actually draws, in a vm */

/**
 * The real `public/beadsession.js`, run in a room with the four things it touches.
 *
 * The repo pattern (test/spacebar.mjs, test/dictate.mjs): the real file, not a rewrite of
 * its logic — a rewrite could pass every case here while the phone shipped something else.
 * The stubs record rather than render, so `out.innerHTML` is the string the page decided
 * on, which is exactly what these cases want to read.
 *
 * `querySelector` answers `null` on purpose. That makes every `repaint()` fall through to
 * a full `render()`, which is the page's own fallback path and leaves the final innerHTML
 * carrying the settled state of all three sections — the thing worth asserting. A stub DOM
 * that answered every selector would prove less, not more: it cannot see a missing element.
 */
async function draw(query, answers) {
  const el = () => ({
    innerHTML: '',
    textContent: '',
    dataset: {},
    querySelector: () => null,
    addEventListener() {},
    classList: { add() {}, remove() {} },
  });
  const nodes = { beadsession: el(), pulse: el(), 'arc-title': el(), 'arc-close': el() };
  const asked = [];

  const ctx = vm.createContext({
    window: { beadcause: {} },
    document: {
      getElementById: (id) => nodes[id] || null,
      title: '',
    },
    location: { search: query },
    localStorage: { getItem: (k) => (k === 'beadcause.token' ? 'tok' : null) },
    URLSearchParams,
    JSON,
    fetch: async (url) => {
      asked.push(url);
      const hit = answers(url);
      return {
        ok: hit.status === undefined || hit.status < 400,
        status: hit.status || 200,
        json: async () => hit.body,
      };
    },
  });
  vm.runInContext(CLIENT, ctx, { filename: 'beadsession.js' });

  // The load is async and the IIFE does not hand it back, so settle by waiting on the
  // stub's own microtasks. Bounded rather than fixed: nothing here touches a clock.
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  return { html: nodes.beadsession.innerHTML, title: nodes['arc-title'].textContent, asked };
}

const detailFor = (id) => ({
  body: {
    workspace: 'demo',
    id,
    ref: `refs/beadcause/sessions/${id}`,
    sessions: [{ commit: 'a'.repeat(40), at: '2026-08-09T11:30:00.000Z', subject: `demo/${id} · ended` }],
    session: {
      commit: 'a'.repeat(40),
      at: '2026-08-09T11:30:00.000Z',
      subject: `demo/${id} · ended`,
      files: id === 'bc-full' ? ['meta.json', 'session.log', 'memory.md'] : ['meta.json', 'session.log'],
      meta: { ...fullMeta, bead: id },
    },
    worktree:
      id === 'bc-full'
        ? { name: 'live-aaa', path: liveWt, state: 'live', at: liveWt, locked: false, retiredAt: null, branch: 'worktree-live-aaa', pr: null }
        : null,
  },
});

const route = (id) => (url) => {
  if (url.startsWith('/api/bead-session')) return detailFor(id);
  if (url.includes('file=memory.md')) return { body: { text: 'the attic is not permanent' } };
  if (url.includes('file=session.log')) return { body: { text: 'LOGLINE-FROM-THE-ARCHIVE' } };
  return { body: {} };
};

await check('the page draws the memory, the log and the worktree, in that order', async () => {
  const { html, title } = await draw('?workspace=demo&id=bc-full', route('bc-full'));
  assert.match(title, /^bc-full/, `header was ${title}`);
  assert.match(html, /the attic is not permanent/);
  assert.match(html, /LOGLINE-FROM-THE-ARCHIVE/);
  assert.match(html, /Still live/);
  // The order is the argument the page makes: what it learned, then what it did, then
  // where the work went.
  assert.ok(
    html.indexOf('Memories') < html.indexOf('The log') && html.indexOf('The log') < html.indexOf('Its worktree'),
    'the three sections are out of order'
  );
  assert.ok(!/Not available/.test(html), 'nothing should be missing for this session');
});

await check('a missing memory is "not available" with the other two sections intact', async () => {
  const { html, asked } = await draw('?workspace=demo&id=bc-bare', route('bc-bare'));
  const memory = html.slice(html.indexOf('Memories'), html.indexOf('The log'));
  assert.match(memory, /Not available\./, 'the memories section must say so');
  assert.match(html, /LOGLINE-FROM-THE-ARCHIVE/, 'and the log must still be there');
  // The whole point of `files[]`: it does not go looking for what it was told is absent.
  assert.ok(!asked.some((u) => u.includes('memory.md')), `it asked anyway: ${asked.join(' ')}`);
});

await check('an archived raw transcript is named, never offered as a link', async () => {
  const withRaw = (url) => {
    if (!url.startsWith('/api/bead-session')) return route('bc-full')(url);
    const d = detailFor('bc-full');
    d.body.session.files = ['meta.json', 'session.log', 'memory.md', 'transcript.jsonl'];
    return d;
  };
  const { html, asked } = await draw('?workspace=demo&id=bc-full', withRaw);
  assert.match(html, /raw transcript is archived beside it/);
  assert.ok(!asked.some((u) => u.includes('transcript.jsonl')), 'a phone must not fetch megabytes of jsonl');
  assert.ok(!/href="[^"]*transcript\.jsonl/.test(html), 'and must not be offered a link to it');
});

await check('a session with no worktree says so where the worktree would be', async () => {
  const { html } = await draw('?workspace=demo&id=bc-bare', route('bc-bare'));
  const wt = html.slice(html.indexOf('Its worktree'));
  assert.match(wt, /Not available\./);
  assert.ok(!/<a /.test(wt), 'nothing to tap when there is nothing to show');
});

await check('a bead nothing ran on renders a page saying so, not an error', async () => {
  const { html } = await draw('?workspace=demo&id=bc-nothing', () => ({
    body: { workspace: 'demo', id: 'bc-nothing', ref: 'refs/beadcause/sessions/bc-nothing', sessions: [], session: null, worktree: null },
  }));
  assert.match(html, /No session was archived for bc-nothing/);
  assert.ok(!/⚠/.test(html) && !/error/i.test(html), `it read as a failure: ${html.slice(0, 200)}`);
});

await check('no bead in the URL is a sentence, not a request', async () => {
  const { html, asked } = await draw('?workspace=demo', () => ({ body: {} }));
  assert.match(html, /No bead named/);
  assert.deepEqual(asked, [], 'it asked the daemon for a bead it does not have');
});

await check('every id the script reaches for is in beadsession.html', async () => {
  // The other half of a stub DOM that answers every selector: it cannot see an element
  // that is not in the document, so the document is read separately.
  const page = fs.readFileSync(PUBLIC('beadsession.html'), 'utf8');
  for (const m of CLIENT.matchAll(/getElementById\('([^']+)'\)/g)) {
    assert.ok(page.includes(`id="${m[1]}"`), `#${m[1]} is not in beadsession.html`);
  }
  assert.ok(page.includes('/beadsession.js'), 'the page must load its own script');
  assert.ok(page.includes('/drawer.js'), 'and the drawer, so it can be a panel');
});

for (const s of servers || []) s.close?.();
app.stop?.();

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
