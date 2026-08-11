#!/usr/bin/env node
//
// Can you tell what has shipped, and land what hasn't, from a phone?
//
//   node scripts/prs-check.mjs [--baseline] [--out=DIR]
//
// The PR board's whole claim is that its three lamps are true and its three buttons
// do what they say. test/prboard.mjs proves the first half on the daemon's side —
// this is the other half: the real public/prs.js, in a headless Chrome the size of a
// phone, against a stubbed /api/prs, with every POST recorded so that "it merged"
// is an assertion about what went over the wire rather than about what the screen
// said afterwards.
//
// Four things are worth a browser to check, and they are the four that would be
// silently wrong otherwise:
//
//   • **A lamp with three states.** On, off, and the hollow ring that means nobody
//     has looked. Drawn from the same fixture the daemon would send, so a row that
//     collapses "unknown" into "no" fails here.
//   • **Merge is armed, and so is a Ship that deploys.** The first press must send
//     nothing. A phone in a pocket that merges on one tap is the single worst thing on
//     this screen, and the only proof is the absence of a request. Ship joined it the
//     day it stopped opening a window you could watch and started running the repo's
//     declared deploy — in the repos that declare one, which is what its label and the
//     line under it say before you touch it.
//   • **Which buttons exist.** Merge only while it is open, Ship only once it is
//     merged. Not greyed out — absent, so there is nothing to think about.
//   • **A refusal is readable.** A merge GitHub will not do comes back as a sentence
//     under the row you pressed, not a toast that has already gone.
//   • **A deploy in flight is on the screen.** Which repo, which step, and — when it
//     ends — which of the four endings it got, including the two that mean nobody
//     knows. Plus the case only a browser can show: the daemon going away mid-restart
//     has to read as the deploy working, not as the page breaking, and the board that
//     was already drawn has to survive it.
//
// `--baseline` serves HEAD's prs.js and style.css instead of the working copy, so a
// failure can be told apart from a flake. Against a main with no board at all, every
// case fails at once, which is what that should look like.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 3 };
const BASELINE = process.argv.includes('--baseline');
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the fixture */

/* One repo, five rows, one per rung of the ladder — including the row nobody has looked
   at, which is the case a two-state lamp gets wrong. */
const row = (over) => ({
  workspace: 'demo',
  repo: 'acme/demo',
  base: 'main',
  branch: 'worktree-something-a1b',
  author: 'someone',
  url: 'https://example.invalid/pull/1',
  title: 'a pull request',
  state: 'MERGED',
  draft: false,
  updatedAt: '2026-08-09T08:00:00Z',
  mergedAt: '2026-08-09T07:00:00Z',
  mergeCommit: 'b'.repeat(40),
  additions: 40,
  deletions: 4,
  files: 2,
  checks: { state: 'none', passing: 0, failing: 0, pending: 0, failed: [], total: 0 },
  mergeable: 'MERGEABLE',
  beads: [],
  merged: true,
  pushed: true,
  local: true,
  deployed: true,
  shipped: true,
  deployTracked: true,
  // The default is the repo that has declared no deploy, because that is most of them
  // — and it is the row whose Ship still opens a window on the Mac. The one that
  // deploys from here is a row of its own below, so both are on screen at once.
  deployDeclared: false,
  deployHint: '',
  stage: 'live',
  note: '',
  ...over,
});

/**
 * The release queue on the card — what one deploy would make live.
 *
 * Mutable, because the strip's most important state is the one where it is *absent*:
 * a repo with nothing waiting draws no box at all, and an empty box explaining that
 * would be the ordinary state of the page dressed up as a control you declined to
 * press. See `releaseHtml` in public/prs.js.
 */
let RELEASE = {
  // Two, not three, and #2 is the one left out on purpose: it is merged with a Pushed
  // lamp nobody can read, and a deploy fast-forwards to `origin` — so a merge this Mac
  // has not seen there could not be picked up by pressing this. A fixture that queued
  // it anyway would be a screen agreeing with a daemon that never says that.
  count: 2,
  can: 'deploy',
  hint: 'runs `launchctl` · rebuilds APK · restarts beadcause',
  prs: [
    { number: 5, title: 'Merged in a repo that wrote its deploy down', url: 'https://x/5', mergedAt: '2026-08-09T08:00:00Z', sha: 'ddddddd', bead: 'de-c3d' },
    { number: 3, title: 'Merged and pushed, not shipped', url: 'https://x/3', mergedAt: '2026-08-09T07:00:00Z', sha: 'eeeeeee', bead: null },
  ],
};

const BOARD = () => ({
  unavailable: null,
  observing: false,
  build: { dir: '/Users/x/repos/demo', commit: 'a'.repeat(40), short: 'aaaaaaa', at: '2026-08-09T09:00:00Z' },
  // `ship` is absent, not zero, when there is no queue to report — a daemon predating
  // the queue sends no such key, and nothing may read an invented nought. (There was a
  // tab badge fed from these numbers; the PRs tab is gone with bc-l8jp.6 and so is it.)
  counts: { review: 1, merged: 1, pushed: 2, deployed: 0, live: 1, closed: 0, owed: 3, ...(RELEASE ? { ship: RELEASE.count } : {}) },
  repos: [
    {
      workspace: 'demo',
      repo: 'acme/demo',
      base: 'main',
      error: null,
      note: null,
      deployTracked: true,
      deployDeclared: true,
      deployHint: 'runs `launchctl` · rebuilds APK · restarts beadcause',
      release: RELEASE,
      prs: [
        row({
          key: 'demo#4',
          number: 4,
          title: 'Still open, waiting on a decision',
          state: 'OPEN',
          mergedAt: null,
          mergeCommit: null,
          merged: false,
          pushed: false,
          local: false,
          deployed: false,
          shipped: null,
          stage: 'review',
          checks: { state: 'passing', passing: 2, failing: 0, pending: 0, failed: [], total: 2 },
          beads: [{ id: 'de-a1b', title: 'the bead it is for', status: 'open' }],
        }),
        row({
          key: 'demo#3',
          number: 3,
          title: 'Merged and pushed, not shipped',
          deployed: false,
          shipped: false,
          stage: 'pushed',
          note: 'Merged and pushed — but not in the build that is running. Ship it.',
        }),
        row({
          key: 'demo#2',
          number: 2,
          title: 'Merged somewhere this Mac has not fetched',
          pushed: null,
          local: null,
          deployed: null,
          shipped: null,
          stage: 'merged',
          note: 'Nothing here has seen that commit yet — this Mac may not have fetched.',
        }),
        row({
          key: 'demo#5',
          number: 5,
          title: 'Merged in a repo that wrote its deploy down',
          deployed: false,
          shipped: false,
          stage: 'pushed',
          deployDeclared: true,
          deployHint: 'runs `launchctl` · rebuilds APK · restarts beadcause',
          note: 'Merged and pushed — but not in the build that is running. Ship it.',
        }),
        row({ key: 'demo#1', number: 1, title: 'Shipped and running' }),
      ],
    },
  ],
});

/* One deploy record per shape the strip has to draw. The fields are the ones
   lib/deploy.js actually writes — a fixture that invented a `step` field would prove
   the page can read a record no daemon will ever send it. */
const deploy = (over) => ({
  id: 'd-abc',
  workspace: 'demo',
  dir: '/Users/x/repos/demo',
  base: 'main',
  bead: null,
  reason: '',
  restarts: false,
  status: 'ok',
  requestedAt: '2026-08-09T08:59:00Z',
  startedAt: '2026-08-09T08:59:01Z',
  finishedAt: '2026-08-09T08:59:41Z',
  heartbeatAt: '2026-08-09T08:59:41Z',
  pid: 1234,
  from: 'c'.repeat(40),
  to: 'd'.repeat(40),
  changed: ['lib/thing.js'],
  steps: [{ name: 'git fetch', command: ['git', 'fetch'], code: 0, ms: 420 }],
  error: null,
  ...over,
});

/** What GET /api/deploys answers with. Swapped per case; `null` makes it unreachable. */
let DEPLOYS = { deploys: [], deployable: ['demo'] };

/* ------------------------------------------------------------------- the server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** Every POST the page made, in order. The assertions read this, not the screen. */
const posted = [];
/** What the next acting call answers with. Set per case. */
let reply = { status: 200, body: { ok: true } };

// HEAD's copy of the files under test, for --baseline. Written once, served instead.
const headFile = (rel) => {
  try {
    return execFileSync('git', ['show', `HEAD:public/${rel}`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
};
const BASE_FILES = BASELINE ? { 'prs.js': headFile('prs.js'), 'style.css': headFile('style.css') } : {};

function serve() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const json = (b, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (req.method === 'POST' && p.startsWith('/api/')) {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        posted.push({ path: p, body: JSON.parse(body || '{}') });
        json(reply.body, reply.status);
      });
      return;
    }
    if (p === '/api/prs') {
      // The one case a stubbed board cannot fake from the outside: while the daemon is
      // being restarted by the deploy the page is watching, *neither* endpoint answers.
      if (!DEPLOYS) return res.destroy();
      return json(BOARD());
    }
    if (p === '/api/deploys') {
      if (!DEPLOYS) return res.destroy();
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      if (id) {
        const rec = (DEPLOYS.deploys || []).find((d) => d.id === id);
        return rec ? json({ deploy: rec, log: 'the runner said this\nand then this\n' }) : json({ error: 'no' }, 404);
      }
      return json(DEPLOYS);
    }
    if (p.startsWith('/api/')) return json({});

    let rel = p === '/prs' || p === '/pulls' ? '/prs.html' : p;
    const name = rel.replace(/^\/+/, '');
    if (BASE_FILES[name]) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)] });
      return res.end(BASE_FILES[name]);
    }
    const file = path.join(PUBLIC, rel === '/' ? 'index.html' : name);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/* ------------------------------------------------------------------- chrome */

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const p = msg.id != null && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error('could not attach to Chrome'));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

async function launch() {
  const port = 9700 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-prs-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error('Chrome never exposed a page target');
  const s = await connect(target.webSocketDebuggerUrl);
  return {
    s,
    close: () => {
      s.close();
      proc.kill();
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Chrome is still letting go of a temp dir */
      }
    },
  };
}

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

let failures = 0;
const ok = (pass, msg) => {
  if (!pass) failures++;
  console.log(`  ${pass ? '✓' : '✗'} ${msg}`);
};

/* --------------------------------------------------------------------- probes */

/**
 * The lamps on one row, as `state:Label` — plus the sentence a screen reader gets.
 *
 * The label and the state are read separately on purpose. The state is carried by
 * colour and by the shape of the dot, neither of which a reader can see, so the lamp
 * also holds an `.sr-only` "yes / no / not known". A lamp that lost that would still
 * look right and still pass a test that only read the class.
 */
const LAMPS = (n) => `(() => {
  const row = [...document.querySelectorAll('#prs .board-pr')].find((el) =>
    el.querySelector('.board-num')?.textContent === '#${n}');
  if (!row) return null;
  return [...row.querySelectorAll('.lamp')].map((l) => {
    const said = l.textContent.replace(/\\s+/g, ' ').trim();
    return l.className.replace('lamp ', '') + ':' + said.split(':')[0].trim();
  });
})()`;

/** The same lamps as a reader hears them: "Merged: yes", "Deployed: not known". */
const SPOKEN = (n) => `(() => {
  const row = [...document.querySelectorAll('#prs .board-pr')].find((el) =>
    el.querySelector('.board-num')?.textContent === '#${n}');
  if (!row) return null;
  return [...row.querySelectorAll('.lamp')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim());
})()`;

/** Open a row and list the buttons it offers. */
const OPEN_ROW = (n) => `(() => {
  const row = [...document.querySelectorAll('#prs .board-pr')].find((el) =>
    el.querySelector('.board-num')?.textContent === '#${n}');
  if (!row) return null;
  row.querySelector('[data-pr]').click();
  return true;
})()`;

const BUTTONS = `(() => [...document.querySelectorAll('#prs .board-actions .board-btn')]
  .map((b) => b.textContent.trim()))()`;

const clickAct = (act) => `(() => {
  const b = document.querySelector('#prs [data-act=${JSON.stringify(act)}]');
  if (!b) return false;
  b.click();
  return true;
})()`;

const SAID = `(() => {
  const el = document.querySelector('#prs .board-said');
  return el ? { text: el.textContent.trim(), bad: el.classList.contains('bad') } : null;
})()`;

/**
 * The deploy strip, one entry per row, as `tone+live|what it says`.
 *
 * The tone is read off the class rather than off a colour, and the sentence is read
 * whole — including the `.sr-only` "deploy:" a reader hears, since the workspace and
 * its state are two spans that only a screen makes into one phrase.
 */
const STRIP = `(() => [...document.querySelectorAll('#prs .deploy')].map((el) =>
  [...el.classList].filter((c) => c !== 'deploy').sort().join('+') + '|' +
  el.querySelector('.deploy-what').textContent.replace(/\\s+/g, ' ').trim()))()`;

const BANNER = `document.querySelector('#prs .deploy-banner')?.textContent.trim() || ''`;

/** Unfold the deploy strip's first row. */
const OPEN_DEPLOY = `(() => {
  const b = document.querySelector('#prs .deploy [data-deploy]');
  if (!b) return false;
  b.click();
  return true;
})()`;

/** What is behind it: the sentence, every step with its verdict, and the log. */
const DEPLOY_BODY = `(() => {
  const el = document.querySelector('#prs .deploy-body');
  if (!el) return null;
  return {
    why: el.querySelector('.deploy-why')?.textContent.trim() || '',
    steps: [...el.querySelectorAll('.deploy-step')].map((s) =>
      (s.classList.contains('bad') ? '✗ ' : '✓ ') + s.querySelector('.deploy-step-name').textContent.trim()),
    out: [...el.querySelectorAll('.deploy-out')].map((p) => p.textContent.trim()),
    log: el.querySelector('.deploy-log')?.textContent.trim() || '',
  };
})()`;

/* ----------------------------------------------------------------------- run */

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const chrome = await launch();
const { s } = chrome;

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
  });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/prs` });
  await sleep(900);
  await evalJs(s, `localStorage.setItem('beadcause.token', 'x')`);
  await s.send('Page.navigate', { url: `${BASE}/prs` });
  await sleep(1600);

  /* ------------------------------------------------------------- the lamps */

  console.log('what the lamps say');

  ok(
    (await evalJs(s, `document.querySelectorAll('#prs .board-pr').length`)) === 5,
    `every pull request is drawn — ${await evalJs(s, `document.querySelectorAll('#prs .board-pr').length`)} rows`
  );

  const shipped = await evalJs(s, LAMPS(1));
  ok(
    JSON.stringify(shipped) === JSON.stringify(['on:Merged', 'on:Pushed', 'on:Deployed', 'on:Live']),
    `a shipped one lights all four — ${JSON.stringify(shipped)}`
  );

  const owed = await evalJs(s, LAMPS(3));
  ok(
    JSON.stringify(owed) === JSON.stringify(['on:Merged', 'on:Pushed', 'off:Deployed', 'off:Live']),
    `merged and pushed but not running is two lit, two dark — ${JSON.stringify(owed)}`
  );

  const unknown = await evalJs(s, LAMPS(2));
  ok(
    unknown[1] === 'unknown:Pushed' && unknown[2] === 'unknown:Deployed' && unknown[3] === 'unknown:Live',
    `what nobody has looked at is neither on nor off — ${JSON.stringify(unknown)}`
  );

  const open = await evalJs(s, LAMPS(4));
  ok(
    JSON.stringify(open) === JSON.stringify(['off:Merged', 'off:Pushed', 'off:Deployed', 'off:Live']),
    `an open one lights nothing — ${JSON.stringify(open)}`
  );

  const spoken = await evalJs(s, SPOKEN(2));
  ok(
    JSON.stringify(spoken) ===
      JSON.stringify(['Merged: yes', 'Pushed: not known', 'Deployed: not known', 'Live: not known']),
    `and a reader hears the state, which colour alone would not carry — ${JSON.stringify(spoken)}`
  );

  ok(
    await evalJs(s, `!!document.querySelector('#prs .pill.id')`),
    'the bead a pull request is for is on its row, and links into the graph'
  );
  ok(
    /aaaaaaa/.test(await evalJs(s, `document.querySelector('#prs .board-build')?.textContent || ''`)),
    'and the page says which commit "deployed" is measured against'
  );

  /* ------------------------------------------------------------ which buttons */

  console.log('\nwhat each row lets you do');

  await evalJs(s, OPEN_ROW(4));
  await sleep(200);
  let btns = await evalJs(s, BUTTONS);
  ok(/Merge/.test(btns.join('|')), `an open one offers the merge — ${btns.join(', ')}`);
  ok(!/Ship/.test(btns.join('|')), 'and no ship, because there is nothing to ship yet');

  await evalJs(s, OPEN_ROW(4));
  await evalJs(s, OPEN_ROW(3));
  await sleep(200);
  btns = await evalJs(s, BUTTONS);
  ok(/Ship/.test(btns.join('|')), `a merged one offers the ship — ${btns.join(', ')}`);
  ok(!/Merge/.test(btns.join('|')), 'and no merge, because it is already merged');
  ok(/Comment/.test(btns.join('|')), 'and you can always say something');

  /* -------------------------------------------------------------- the arming */

  console.log('\nmerging takes two taps');

  await evalJs(s, OPEN_ROW(3));
  await evalJs(s, OPEN_ROW(4));
  await sleep(200);
  posted.length = 0;

  await evalJs(s, clickAct('merge'));
  await sleep(300);
  ok(posted.length === 0, `the first tap sends nothing — ${posted.length} request(s)`);
  ok(
    /sure\?/i.test(await evalJs(s, `document.querySelector('#prs [data-act="merge"]')?.textContent || ''`)),
    `and the button now says what it is about to do — "${await evalJs(
      s,
      `document.querySelector('#prs [data-act="merge"]')?.textContent.trim() || ''`
    )}"`
  );

  reply = { status: 200, body: { ok: true, alreadyMerged: false, land: { note: 'fast-forwarded main to origin/main' } } };
  await evalJs(s, clickAct('merge'));
  await sleep(600);
  ok(posted.length === 1 && posted[0].path === '/api/pr/merge', `the second tap merges — ${JSON.stringify(posted[0])}`);
  ok(posted[0]?.body.number === 4 && posted[0]?.body.workspace === 'demo', 'and names the pull request it was pressed on');
  const merged = await evalJs(s, SAID);
  ok(
    /Merged #4/.test(merged?.text || '') && /fast-forwarded/.test(merged?.text || ''),
    `both halves are reported, not one word over the pair — "${merged?.text}"`
  );

  /* --------------------------------------------------------------- a refusal */

  console.log('\nwhen GitHub says no');

  await s.send('Page.navigate', { url: `${BASE}/prs` });
  await sleep(1500);
  await evalJs(s, OPEN_ROW(4));
  await sleep(200);
  posted.length = 0;
  reply = { status: 409, body: { error: '#4 conflicts with main — the branch needs a rebase before it can merge' } };
  await evalJs(s, clickAct('merge'));
  await evalJs(s, clickAct('merge'));
  await sleep(600);
  const refused = await evalJs(s, SAID);
  ok(refused?.bad === true, 'the refusal is marked as one');
  ok(/rebase/.test(refused?.text || ''), `and it is GitHub's own sentence, under the row — "${refused?.text}"`);

  /* ------------------------------------------------------------ ship, comment */

  console.log('\nshipping and saying something');

  await s.send('Page.navigate', { url: `${BASE}/prs` });
  await sleep(1500);
  await evalJs(s, OPEN_ROW(3));
  await sleep(200);
  posted.length = 0;
  reply = { status: 200, body: { ok: true, via: 'session', dir: '/Users/x/repos/demo', mode: 'default' } };
  const shipLabel = await evalJs(s, `document.querySelector('#prs [data-act="ship"]')?.textContent.trim() || ''`);
  ok(/on the Mac/.test(shipLabel), `a repo with no declared deploy says the window in the label — "${shipLabel}"`);
  ok(
    /no deploy beadcause can run/.test(
      await evalJs(s, `document.querySelector('#prs .board-hint')?.textContent || ''`)
    ),
    'and says why underneath it'
  );
  await evalJs(s, clickAct('ship'));
  await sleep(600);
  ok(posted.length === 1 && posted[0].path === '/api/pr/ship', `ship opens a session — ${posted[0]?.path}`);
  ok(posted[0]?.body.number === 3, 'for the row it was pressed on');
  ok(
    /repos\/demo/.test((await evalJs(s, SAID))?.text || ''),
    `and says where the window is coming up — "${(await evalJs(s, SAID))?.text}"`
  );

  /* ------------------------------------------------- the ship that deploys here */

  // The other half of the same button, and the one that can act without anyone
  // watching: no window to stop, so it arms like Merge does.
  console.log('\nand where the deploy is declared, it deploys');

  await s.send('Page.navigate', { url: `${BASE}/prs` });
  await sleep(1500);
  await evalJs(s, OPEN_ROW(5));
  await sleep(200);
  posted.length = 0;
  ok(
    /launchctl/.test(await evalJs(s, `document.querySelector('#prs .board-hint')?.textContent || ''`)),
    `the row names the command Ship will run — "${await evalJs(s, `document.querySelector('#prs .board-hint')?.textContent.trim() || ''`)}"`
  );
  await evalJs(s, clickAct('ship'));
  await sleep(300);
  ok(posted.length === 0, `the first tap sends nothing — ${posted.length} request(s)`);
  ok(
    /sure\?/i.test(await evalJs(s, `document.querySelector('#prs [data-act="ship"]')?.textContent || ''`)),
    `and the button says it is about to deploy — "${await evalJs(
      s,
      `document.querySelector('#prs [data-act="ship"]')?.textContent.trim() || ''`
    )}"`
  );

  reply = { status: 200, body: { ok: true, via: 'deploy', deploy: { id: 'd-abc123', workspace: 'demo' }, number: 5 } };
  await evalJs(s, clickAct('ship'));
  await sleep(600);
  ok(posted.length === 1 && posted[0].path === '/api/pr/ship', `the second tap deploys — ${posted[0]?.path}`);
  ok(posted[0]?.body.number === 5, 'for the row it was pressed on');
  const deploying = await evalJs(s, SAID);
  ok(
    /Deploying demo/.test(deploying?.text || '') && !/window/.test(deploying?.text || ''),
    `and it says a deploy is running, not a window opening — "${deploying?.text}"`
  );
  ok(/d-abc123/.test(deploying?.text || ''), 'naming the record, because the outcome arrives later');

  await s.send('Page.navigate', { url: `${BASE}/prs` });
  await sleep(1500);
  await evalJs(s, OPEN_ROW(3));
  await sleep(200);

  posted.length = 0;
  reply = { status: 200, body: { ok: true } };
  await evalJs(
    s,
    `(() => { const t = document.querySelector('#prs [data-say]');
      t.value = 'this needs a note';
      t.dispatchEvent(new Event('input', { bubbles: true })); })()`
  );
  await evalJs(s, clickAct('send'));
  await sleep(600);
  ok(
    posted.length === 1 && posted[0].path === '/api/pr/comment' && posted[0].body.text === 'this needs a note',
    `a comment goes to the pull request with what you typed — ${JSON.stringify(posted[0])}`
  );

  posted.length = 0;
  await evalJs(
    s,
    `(() => { const t = document.querySelector('#prs [data-say]');
      t.value = '   ';
      t.dispatchEvent(new Event('input', { bubbles: true })); })()`
  );
  await evalJs(s, clickAct('send'));
  await sleep(400);
  ok(posted.length === 0, 'an empty one is not sent at all');

  /* ---------------------------------------------------------- the deploy strip */

  console.log('\nwhat is deploying right now');

  ok(
    (await evalJs(s, `document.querySelectorAll('#prs .deploy').length`)) === 0,
    'a repo nobody has deployed from here gets no strip at all'
  );

  // A restart in flight — the case the whole strip exists for, since the deploy is
  // about to kill the daemon serving this page.
  DEPLOYS = {
    deployable: ['demo'],
    deploys: [
      deploy({
        id: 'd-live',
        status: 'deploying',
        restarts: true,
        finishedAt: null,
        bead: 'de-a1b',
        reason: 'shipped from the inbox',
        steps: [
          { name: 'git fetch', command: ['git', 'fetch'], code: 0, ms: 380 },
          { name: 'git merge --ff-only', command: ['git', 'merge'], code: 0, ms: 90 },
        ],
      }),
    ],
  };
  await evalJs(s, `document.getElementById('prs-refresh').click()`);
  await sleep(900);
  let strip = await evalJs(s, STRIP);
  ok(strip.length === 1 && /live/.test(strip[0]), `a deploy in flight is on the screen — ${JSON.stringify(strip)}`);
  ok(
    /demo deploy: running the deploy · restarting beadcause/.test(strip[0] || ''),
    `and says which repo, which step, and that this page is about to go — "${strip[0]}"`
  );
  ok(
    (await evalJs(s, `document.querySelectorAll('#prs .board-pr').length`)) === 5,
    'the board underneath is untouched'
  );

  await evalJs(s, OPEN_DEPLOY);
  await sleep(700);
  let body = await evalJs(s, DEPLOY_BODY);
  ok(
    JSON.stringify(body?.steps) === JSON.stringify(['✓ git fetch', '✓ git merge --ff-only']),
    `unfolding it lists what has actually run — ${JSON.stringify(body?.steps)}`
  );
  ok(/the runner said this/.test(body?.log || ''), 'and fetches what the runner printed');
  ok(await evalJs(s, `!!document.querySelector('#prs .deploy-body .pill.id')`), 'the bead that asked for it is a link');
  await evalJs(s, OPEN_DEPLOY);

  /* ------------------------------------------------- the daemon going away */

  console.log('\nwhen the deploy takes the daemon with it');

  DEPLOYS = null;
  // Its own clock, four seconds while something is live. Nothing is clicked here on
  // purpose: the page has to notice the daemon is gone without being asked.
  await sleep(6000);
  ok(/restarting/.test(await evalJs(s, BANNER)), `the dropped connection reads as the deploy — "${await evalJs(s, BANNER)}"`);
  ok(
    (await evalJs(s, `document.querySelectorAll('#prs .board-pr').length`)) === 5,
    'and the board that was already drawn is still there to come back to'
  );
  ok(
    !/Can't reach the server/.test(await evalJs(s, `document.getElementById('prs').textContent`)),
    'not the generic failure, which would have thrown away the thing that explains it'
  );

  /* ------------------------------------------------------------ the four endings */

  console.log('\nhow it ended');

  DEPLOYS = {
    deployable: ['demo'],
    deploys: [
      deploy({
        id: 'd-live',
        status: 'unconfirmed',
        restarts: true,
        finishedAt: '2026-08-09T09:00:10Z',
        error: 'The deploy command ran and the runner did not outlive it — which is what a restart looks like from here.',
        steps: [{ name: 'git fetch', command: ['git', 'fetch'], code: 0, ms: 380 }],
      }),
      deploy({
        id: 'd-bad',
        status: 'failed',
        error: 'the deploy command failed (exit 1)',
        steps: [
          { name: 'git fetch', command: ['git', 'fetch'], code: 0, ms: 380 },
          { name: 'deploy', command: ['launchctl', 'kickstart'], code: 1, ms: 1200, output: 'Could not find service\n' },
        ],
      }),
    ],
  };
  await sleep(6000);
  strip = await evalJs(s, STRIP);
  ok(await evalJs(s, `!${BANNER}`), 'the banner goes when the daemon answers again');
  ok(
    /warn/.test(strip[0] || '') && /unconfirmed/.test(strip[0] || ''),
    `a restart nobody outlived is unconfirmed, not a tick — ${JSON.stringify(strip[0])}`
  );
  ok(
    /bad/.test(strip[1] || '') && /failed/.test(strip[1] || ''),
    `and a real failure is marked as one — ${JSON.stringify(strip[1])}`
  );

  await evalJs(s, OPEN_DEPLOY);
  await sleep(700);
  body = await evalJs(s, DEPLOY_BODY);
  ok(/did not outlive it/.test(body?.why || ''), `the ending says what is not known, in words — "${body?.why}"`);

  await evalJs(s, OPEN_DEPLOY);
  await evalJs(
    s,
    `(() => document.querySelectorAll('#prs .deploy [data-deploy]')[1].click())()`
  );
  await sleep(700);
  body = await evalJs(s, DEPLOY_BODY);
  ok(
    JSON.stringify(body?.steps) === JSON.stringify(['✓ git fetch', '✗ deploy']),
    `a failed deploy shows the step it broke at — ${JSON.stringify(body?.steps)}`
  );
  ok(
    body?.out.length === 1 && /Could not find service/.test(body.out[0]),
    `with what that step printed, and nothing from the ones that worked — ${JSON.stringify(body?.out)}`
  );

  /* ------------------------------------------------------------ the release queue */

  /**
   * The strip above the rows: how many merges one deploy would make live.
   *
   * The number is the whole point of it, so it is read as its own element rather than
   * out of the button's text — a count folded into the label would vanish the moment
   * the button arms and rewrites itself, which is exactly when you most want to know
   * what you are about to ship. Four claims, and the last one is the quiet one: a repo
   * with nothing waiting draws no strip at all.
   */
  console.log('\nthe release queue');

  DEPLOYS = { deploys: [], deployable: ['demo'] };
  const QUEUE = RELEASE;
  await s.send('Page.navigate', { url: `${BASE}/prs` });
  await sleep(1500);
  posted.length = 0;

  ok(
    (await evalJs(s, `document.querySelector('#prs .release-count')?.textContent.trim() || ''`)) === '2',
    'the count is drawn over the button, as its own element'
  );
  ok(
    /one deploy ships them all/i.test(await evalJs(s, `document.querySelector('#prs .release-say')?.textContent || ''`)),
    'and the sentence says a deploy ships the lot, which is what a deploy has always done'
  );
  ok(
    (await evalJs(s, `document.querySelectorAll('#prs .release-list li').length`)) === 2,
    'it lists what is going out, so the number is checkable'
  );
  ok(
    !/#2/.test(await evalJs(s, `document.querySelector('#prs .release-list')?.textContent || ''`)),
    'and leaves out the merge this Mac has not seen on origin — no deploy could pick it up'
  );
  ok(
    (await evalJs(s, `!!document.querySelector('#prs .release-list .pill.id')`)),
    'and links the ship bead filed for a merge that has one'
  );

  await evalJs(s, clickAct('release'));
  await sleep(300);
  ok(posted.length === 0, `the first tap sends nothing — ${posted.length} request(s)`);
  const armed = await evalJs(s, `document.querySelector('#prs [data-act="release"]')?.textContent.trim() || ''`);
  ok(/all 2/i.test(armed), `and the armed button says how many it is about to ship — "${armed}"`);

  reply = { status: 200, body: { ok: true, deploy: { id: 'd-rel99', workspace: 'demo' }, release: { count: 2 } } };
  await evalJs(s, clickAct('release'));
  await sleep(600);
  ok(
    posted.length === 1 && posted[0].path === '/api/release/ship',
    `the second tap ships the queue — ${posted[0]?.path}`
  );
  ok(
    posted[0]?.body.workspace === 'demo' && posted[0]?.body.number === undefined,
    'naming the repo and no pull request — it is the whole queue, not a row'
  );
  const said = await evalJs(s, SAID);
  ok(/d-rel99/.test(said?.text || ''), `and says which record to watch — "${said?.text}"`);

  RELEASE = { count: 0, can: 'deploy', hint: '', prs: [] };
  await s.send('Page.navigate', { url: `${BASE}/prs` });
  await sleep(1500);
  ok(
    (await evalJs(s, `!document.querySelector('#prs .release')`)),
    'and a repo with nothing waiting draws no strip at all — everything being live is the ordinary state'
  );
  RELEASE = null;
  await s.send('Page.navigate', { url: `${BASE}/prs` });
  await sleep(1500);
  ok(
    (await evalJs(s, `!document.querySelector('#prs .release') && !!document.querySelector('#prs .board-pr')`)),
    'a board from a daemon that has no queue to send still draws its rows'
  );
  // Put the queue back *and reload*, because the screenshots below are of whatever is
  // on screen right now: the strip is the new thing on this page, and a picture without
  // it would leave out the one part worth looking at.
  RELEASE = QUEUE;

  if (outDir) {
    await s.send('Page.navigate', { url: `${BASE}/prs` });
    await sleep(1500);
    fs.mkdirSync(outDir, { recursive: true });
    for (const scheme of ['dark', 'light']) {
      await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await sleep(300);
      const shot = await s.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, `prs-${scheme}.png`), Buffer.from(shot.data, 'base64'));
    }
    console.log(`\n  screenshots in ${outDir}`);
  }
} finally {
  chrome.close();
  server.close();
}

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
process.exit(failures ? 1 : 0);
