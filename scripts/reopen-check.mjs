#!/usr/bin/env node
//
// Does closing the app and opening it again cost a sweep on the other three views?
//
//   node scripts/reopen-check.mjs [--baseline]
//
// `scripts/warm-check.mjs` asks this of the inbox and only the inbox — its claim 7 is
// bc-1kwl.14, and the store it proved durable is one store for every view. This is the
// rest of it (bc-1kwl.15): the advocates monitor, the chat launcher and the PR board,
// each closed and reopened, each measured against its own cold load.
//
// A close is `sessionStorage.clear()` and then a navigation. That is what a close
// actually does to storage — the session half gone, the disk half kept, a new document —
// and it needs no second browser target, so the whole run drives one page.
//
// Seven claims, in three groups.
//
//   1-3. **Each of the three paints from the disk, well inside its own cold time.** Two
//        numbers per view, because a fast reopen on its own would only prove the fixture
//        is fast: the cold load has to wait out the sweep, and the reopen has to beat it.
//        The fixture charges every boot payload the same 900ms, which is roughly a `bd`
//        sweep across seven workspaces on the Mac — the real numbers are worse and are on
//        bc-1kwl.1 (`/api/work` 7.0s, `/api/prs` 74s). The delay is the instrument here,
//        not a claim about the daemon: what is being measured is whether the first frame
//        waits for the answer, and it can only be measured against an answer that is slow
//        enough to notice.
//
//   4-6. **And the reopen does not go and re-sweep the two expensive paths.** This is the
//        one thing the durable store changed and nobody had gone back for. `prewarm` in
//        public/warm.js runs once per *document*, so it runs again on every reopen, and
//        it was written when a reopen found an empty store: fetching all five paths was
//        then the only way any tab was ever warm. With the store durable it is a second
//        copy of five payloads already on the disk — and two of them are the app's most
//        expensive requests, `/api/prs` at a `gh` call per repo and `/api/unendorsed` at
//        a `bd list` per workspace plus a `bd show` per row. Two minutes of the daemon's
//        day, in the background of every single app open, for nothing. Counted per view
//        rather than summed, because two of these sweeps are legitimate and always were —
//        the board's own arrival, and the monitor's **Ship** strip — and a total would
//        hide which number moved.
//
//     7. **And all six payloads are on the disk at once, inside the byte budget.** The
//        store only grows now, so the bound bc-1kwl.14 put on it is the one thing keeping
//        it finite — and this is the case it was written for. Both halves are asserted,
//        because either alone is satisfiable by the wrong thing: everything the run filled
//        is still held, *and* the total fits. A store that had given half of it up would
//        pass the second on its own.
//
// `--baseline` serves the committed `public/warm.js` instead of the working copy, and
// that is the whole swap: this branch changes one public file. Under it, claims 1-3 still
// pass — the three views have read their held payload at the top of their own boot since
// long before this, and bc-1kwl.14 is what made that payload survive a close, so the
// paint was already there to measure. Claims 4, 5 and 6 are the ones that fail, and their
// numbers are the old behaviour printed: a launcher reopen sweeping both, a monitor reopen
// sweeping the board *twice*, and even the board's own reopen — which has never re-fetched
// its own path, because `prewarm` skips the view it is on — going and re-sweeping the
// endorsement queue behind it. Three reopens, five sweeps beyond the two a page is drawing,
// and not a row on any screen that was not already on the disk.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'reopen-check-token';
const BASELINE = process.argv.includes('--baseline');
// What a `bd` sweep across seven workspaces costs, near enough. Every claim below is a
// comparison against this number, so it is named once.
const SWEEP_MS = 900;
// How long to leave a loaded page alone before touching the store or reading the request
// counter. The background warm waits 1200ms and then runs its five paths *sequentially*,
// so this has to outlast the whole queue at fixture speed — and it has to do so on both
// sides of a close, or the two runs are comparing different amounts of finished work. It
// was 4.8s and that was a third of a second short of whatever `VIEWS` puts last: the
// baseline then reported *nothing* swept where the answer is one, because the request it
// was waiting for had not been issued when the page navigated away. Which path that is is
// not this file's to know — bc-khoe.1 has since moved `/api/prs` up out of that place —
// so the slack is against the length of the queue, never against a named path.
const WARMED_MS = 3000 + 5 * SWEEP_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

let seq = 5;
const counts = { work: 0, consoles: 0, prs: 0, unendorsed: 0, questions: 0, admin: 0, poll: 0 };

/** One advocate on one repo — enough for `advocateCard` to draw a card with a `data-ws`. */
const work = () => ({
  workspaces: [{ name: 'demo', claimed: [], sessions: [], ready: [], working: [], counts: {} }],
  elsewhere: [],
  advocates: [
    {
      workspace: 'demo',
      paused: false,
      draining: false,
      surveying: false,
      workers: [],
      queue: 0,
      limit: 3,
      note: '',
      next: null,
      error: null,
      since: '2026-08-01T09:00:00Z',
    },
  ],
  roster: [{ workspace: 'demo', on: true }],
  globals: { cap: 3, inUse: 0 },
  observing: false,
  service: null,
  router: null,
  seq,
});

/** One conversation, so the launcher has a `.console-row` rather than its empty state. */
const consoles = () => ({
  workspaces: ['demo'],
  consoles: [
    {
      id: 'c1',
      workspace: 'demo',
      title: 'A conversation from last night',
      status: 'idle',
      beadCount: 0,
      created: [],
      seed: null,
      at: '2026-08-01T09:00:00Z',
    },
  ],
});

/** One repo with one open pull request — enough for the board to draw a `.work-card`. */
const board = () => ({
  unavailable: null,
  observing: false,
  counts: { review: 1, merged: 0, pushed: 0, deployed: 0, live: 0, closed: 0, owed: 1 },
  repos: [
    {
      workspace: 'demo',
      repo: 'acme/demo',
      base: 'main',
      error: null,
      note: null,
      deployTracked: true,
      deployDeclared: false,
      deployHint: '',
      release: null,
      prs: [
        {
          key: 'demo#4',
          workspace: 'demo',
          repo: 'acme/demo',
          base: 'main',
          branch: 'worktree-something-a1b',
          author: 'someone',
          url: 'https://example.invalid/pull/4',
          number: 4,
          title: 'Still open, waiting on a decision',
          state: 'OPEN',
          draft: false,
          updatedAt: '2026-08-01T08:00:00Z',
          mergedAt: null,
          mergeCommit: null,
          additions: 40,
          deletions: 4,
          files: 2,
          checks: { state: 'passing', passing: 2, failing: 0, pending: 0, failed: [], total: 2 },
          mergeable: 'MERGEABLE',
          beads: [],
          merged: false,
          pushed: false,
          local: false,
          deployed: false,
          shipped: null,
          deployTracked: true,
          deployDeclared: false,
          deployHint: '',
          stage: 'review',
          note: '',
        },
      ],
    },
  ],
});

const screen = () => ({
  questions: [],
  requests: [],
  workspaces: ['demo'],
  spaces: [],
  filter: { space: 'all', workspace: 'all' },
  summary: { sessions: 0, proposals: 0 },
  seq,
});

const adminStatus = () => ({ reopenIsFresh: false, at: 0, scopes: [], closed: [] });
const unendorsed = () => ({ beads: [], workspaces: ['demo'] });

/* ------------------------------------------------------------------ server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// The committed file, for --baseline. Read through git rather than from a second
// checkout, so the comparison is against HEAD of this very worktree.
const committed = (f) => execFileSync('git', ['show', `HEAD:${f}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });

// The pages the server maps onto one file. Mirrored here rather than imported, because
// what this check drives is the *URL* a notification or a home-screen icon opens.
const ALIAS = { '/': '/index.html', '/console': '/console.html', '/monitor': '/monitor.html', '/prs': '/monitor.html' };

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    /* The three boot payloads, each charged the same sweep. Counted before the delay, so
       a request that is merely still in flight is already on the counter — a claim about
       what was asked for cannot be satisfied by an answer that has not arrived yet. */
    if (p === '/api/work') {
      counts.work += 1;
      await sleep(SWEEP_MS);
      return json(work());
    }
    if (p === '/api/consoles') {
      counts.consoles += 1;
      await sleep(SWEEP_MS);
      return json(consoles());
    }
    if (p === '/api/prs') {
      counts.prs += 1;
      await sleep(SWEEP_MS);
      return json(board());
    }

    /* The two the background warm also fills. `/api/unendorsed` is charged the sweep it
       really is; the inbox's own is here because every view's warm queue includes it. */
    if (p === '/api/unendorsed') {
      counts.unendorsed += 1;
      await sleep(SWEEP_MS);
      return json(unendorsed());
    }
    if (p === '/api/questions') {
      counts.questions += 1;
      await sleep(SWEEP_MS);
      return json({ ...screen(), scope: 'human' });
    }
    if (p === '/api/admin') {
      counts.admin += 1;
      return json(adminStatus());
    }

    /* Parked, exactly as lib/events.js does. Nothing in this run moves the sequence, so
       every poll times out having cost nothing — which is the state a reopen settles
       into and the state the counts above are read in. */
    if (p === '/api/poll') {
      counts.poll += 1;
      const since = Number(url.searchParams.get('since') || 0);
      const wait = Math.min(Number(url.searchParams.get('wait') || 25), 30) * 1000;
      if (since >= seq && wait > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, wait);
          res.on('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (res.writableEnded || req.destroyed) return;
      return json({
        seq,
        resync: false,
        events: [],
        questions: null,
        requests: null,
        spaces: null,
        advocates: work().advocates,
        observing: false,
      });
    }

    // Everything else the pages poke at on boot — agents, deploys, presence, the space.
    // An empty body is a valid answer to all of them and keeps the fixture to the point.
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && p === '/warm.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(committed('public/warm.js'));
    }

    const file = path.join(PUBLIC, (ALIAS[p] || p).replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-reopen-');

const evalJs = async (expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  }
  return r.result.value;
};

/** How long until this view's own rows are on screen, from the navigation starting. */
async function timeToRows(url, selector) {
  const started = Date.now();
  await s.send('Page.navigate', { url });
  for (let i = 0; i < 400; i++) {
    if (await evalJs(`document.querySelectorAll(${JSON.stringify(selector)}).length > 0`)) return Date.now() - started;
    await sleep(20);
  }
  return null;
}

/**
 * The three views, by the URL a home-screen icon or a notification actually opens.
 *
 * `/prs` is `monitor.html` with the board chip up — the server maps it, and
 * public/montabs.js selects the chip from the path — so two of these are the same
 * document with a different pane in front, which is exactly how a thumb reaches them.
 */
const VIEWS = [
  { id: 'the advocates monitor', url: '/monitor', rows: '#mon article.mon-card[data-ws]', path: '/api/work' },
  { id: 'the chat launcher', url: '/console', rows: '#recent .console-row', path: '/api/consoles' },
  { id: 'the PR board', url: '/prs', rows: '#prs article.work-card', path: '/api/prs' },
];

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
    screenWidth: VP.width,
    screenHeight: VP.height,
  });

  console.log(
    `\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · sweep ${SWEEP_MS}ms · ${BASE}\n`
  );

  const reopens = [];
  for (const view of VIEWS) {
    /* A device that has never seen this view. Both stores go, which takes the token with
       them — every navigation below carries `?t=` for exactly that reason. */
    await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
    await evalJs('localStorage.clear(); sessionStorage.clear()');
    const cold = await timeToRows(`${BASE}${view.url}?t=${TOKEN}`, view.rows);
    // Long enough for this page's own request to have come back and been kept, and for
    // the background warm behind it to have finished filling everything else.
    await sleep(WARMED_MS);

    /* And now the close. Everything session-scoped goes; the disk does not. The
       in-memory half goes with the document on the navigation.

       Every held entry's clock goes back an hour first, and that is not a shortcut past
       the thing being measured — it *is* the case being measured. A reopen thirty seconds
       after a close is inside the background warm's 60-second floor, which has skipped
       every path since long before any of this; the reopen that matters is the one the
       next morning, and waiting out a real minute per view would put three minutes on a
       run that otherwise takes forty seconds. The store is asked for nothing it would not
       answer then: `at` is a number in the entry, and this is the number it would hold. */
    const before = { ...counts };
    await evalJs(
      `(() => {
        for (const k of Object.keys(localStorage)) {
          if (!k.startsWith('beadcause.warm:')) continue;
          const e = JSON.parse(localStorage.getItem(k));
          e.at -= 60 * 60 * 1000;
          localStorage.setItem(k, JSON.stringify(e));
        }
      })()`
    );
    await evalJs('sessionStorage.clear()');
    const warm = await timeToRows(`${BASE}${view.url}?t=${TOKEN}`, view.rows);
    check(
      `${view.id} reopens from the disk rather than from ${view.path}`,
      cold !== null && cold >= SWEEP_MS && warm !== null && warm < SWEEP_MS,
      `${warm}ms against ${cold}ms cold`
    );
    // Let the reopen settle the same way, so the background warm has had its turn before
    // anything is read off the counter.
    await sleep(WARMED_MS);
    reopens.push({ view, before, after: { ...counts } });
  }

  /* 4-6. what each reopen went and asked for behind the paint.

     Attributed per view rather than summed, because the three owe different numbers and a
     total would hide which one moved. Two of the sweeps counted here are legitimate and
     always were, and both are a page fetching a payload it is *drawing*:

       - The board's own page sweeps `/api/prs` on arrival, every time — `warmBoot` paints
         the held rows and `load()` runs behind them. That is exactly what the `MAINTAINED`
         table in public/app.js means by leaving this path to "the board's own sweep on
         arrival", and it is why the entry may be painted while stale at all.
       - The monitor spends one too, for the **Ship** strip on each advocate card
         (`loadBoard`, throttled): the number on that button is what a press acts on, so
         it is not something a held payload may answer.

     What must not happen is a *second* one behind either of those, from the background
     warm going and replacing an entry already on the disk. That is the whole difference
     between these numbers and the baseline's. */
  const spentBy = (url, key) => {
    const r = reopens.find((x) => x.view.url === url);
    return r.after[key] - r.before[key];
  };
  check(
    'the chat launcher reopens without sweeping the board or the endorsement queue at all',
    spentBy('/console', 'prs') === 0 && spentBy('/console', 'unendorsed') === 0,
    `${spentBy('/console', 'prs')} /api/prs, ${spentBy('/console', 'unendorsed')} /api/unendorsed`
  );
  check(
    'the monitor reopens on one board sweep — the Ship strip it draws, not a second copy of what it holds',
    spentBy('/monitor', 'prs') === 1 && spentBy('/monitor', 'unendorsed') === 0,
    `${spentBy('/monitor', 'prs')} /api/prs, ${spentBy('/monitor', 'unendorsed')} /api/unendorsed`
  );
  check(
    'and the board itself reopens on the one sweep it has always run behind its own first frame',
    spentBy('/prs', 'prs') === 1 && spentBy('/prs', 'unendorsed') === 0,
    `${spentBy('/prs', 'prs')} /api/prs, ${spentBy('/prs', 'unendorsed')} /api/unendorsed`
  );

  /* 6. the bound, with every view persisting.

     The store only grows now, so the one thing that keeps it finite is the byte budget —
     and the case it was written for is exactly this one: six payloads on the disk at once,
     none of them expiring. Asserted as both halves, because either alone is satisfiable
     by the wrong thing: everything the run filled is still held, *and* the total is inside
     the budget. A store that dropped half of it would pass the second on its own. */
  const held = await evalJs(
    `(() => {
      const out = {};
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('beadcause.warm:')) out[k.slice('beadcause.warm:'.length)] = localStorage.getItem(k).length;
      }
      return out;
    })()`
  );
  const bytes = Object.values(held).reduce((n, v) => n + v, 0);
  const budget = await evalJs('window.beadcause?.warm?.BUDGET_BYTES || 0');
  check(
    'every view the run touched is still held at once, inside the byte budget',
    Object.keys(held).length >= 5 && bytes < budget,
    `${Object.keys(held).length} entries, ${Math.round(bytes / 1024)}KB of ${Math.round(budget / 1024)}KB`
  );
} finally {
  close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
