#!/usr/bin/env node
//
// Does a tab tap draw from memory, and does one event move one row?
//
//   node scripts/warm-check.mjs [--baseline] [--keep]
//
// Two claims, both of which are about time and neither of which any unit test can
// make. `test/warm.mjs` holds the store, the reconciler's decisions and the two
// endpoints agreeing; what it cannot hold is whether the inbox actually paints
// before its own request has left, or whether a repaint really leaves the forty
// cards that did not change alone. Those are facts about a browser.
//
// So: the real public/*.js in a headless Chrome the size of a phone, against a
// fixture served from this process — nothing here talks to a daemon or touches a
// bead. The fixture answers `/api/questions` after a deliberate 900ms, which is
// roughly what a `bd` sweep across seven workspaces costs on the Mac, and counts
// every request. The measurements are then simply true or false:
//
//   1. A cold load waits out the sweep. (The control. Without it the rest proves
//      nothing — a fast second load could just mean a fast fixture.)
//   2. Coming back to the tab draws cards well inside that, from what was kept.
//   3. Nothing on the page asks for the whole list again on a timer: the refresh is
//      a parked `/api/poll`, so an idle inbox costs no sweep at all.
//   4. One bead changing replaces one card. Proved by stamping every card node
//      before the change and reading which stamps survived it — a rebuilt list
//      loses all of them, and a stamp is something the app knows nothing about, so
//      it cannot agree with a bug in the thing it is checking.
//   5. The Advocates tab is warm *and stays warm* while you sit on the inbox. The
//      background fill happens once per document and the TTL then drops what it
//      fetched, so an inbox left open — which is how this app is used — had a cold
//      Advocates tab for all but its first fifteen minutes, with nothing able to put
//      it back (bc-xxzz). The claims are about requests, not seconds: the roster
//      arriving on a wake restamps the held payload for free, an event that `bd`
//      would answer differently re-asks once, and neither can happen inside the
//      floor. The TTL itself is fifteen minutes and no check can sit out a quarter of
//      an hour — what is measurable, and what actually broke, is whether the entry's
//      clock advances at all while nothing is being fetched.
//   6. And so are the board and the switches — every *other* warmed path, which bc-xxzz
//      left with the same hole (bc-27er). Same shape of claim and same unit: three
//      stamps move across the idle window for no request at all; an event that moved
//      one of them stops its restamp rather than papering over it; and then the two
//      that are in-memory reads on the daemon — `/api/admin`, `/api/consoles` — are
//      re-asked once each, while `/api/prs` is never re-asked on any wake, because it
//      is a `gh` call per repo. That last one is a decision rather than a gap: see
//      `MAINTAINED` in public/app.js. To measure it at all the inbox's kind filter is
//      set to `Questions` partway through, because an inbox drawing PR cards sweeps
//      `/api/prs` on its own minute and every count here would be unattributable.
//
// `--baseline` serves the committed public/app.js and public/warm.js instead of the
// working copies, which is how you check that a failure here is a real one. What
// baseline fails is only ever the claims the working copy adds: on the branch that wrote
// 2, 3, 4 and 5 it failed those, and on the one that wrote 6 it failed three of that
// claim's five lines — the two it still passes are the ones that say a *moved* entry is
// left alone, which a baseline that maintains nothing satisfies by doing nothing. They
// are guards against the next change, not evidence for this one. A baseline that fails
// nothing at all is a stale comparison rather than a pass, and the run says so.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'warm-check-token';
const BASELINE = process.argv.includes('--baseline');
// What a `bd human list` sweep across seven workspaces costs, near enough. The whole
// check is a comparison against this number, so it is named once.
const SWEEP_MS = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

const BEAD = (n) => ({
  id: `wm-${n}`,
  title: `A question waiting (${n})`,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: `Short brief ${n}.`,
});

const ISSUES = [1, 2, 3, 4, 5].map(BEAD);
let questions = ISSUES.map((i) => ({ ...toQuestion('demo', i), comments: [] }));
const KEY = questions[2].key; // the one that will change

let seq = 5;
/**
 * What the advocates board is made of, and what the poll carries for free.
 *
 * Two halves on purpose, because the whole of claim 5 is which half costs a request:
 * `roster` rides every wake whatever woke it, and `claimed` is the `bd` half that has
 * no event and can only be re-asked.
 */
let roster = [{ workspace: 'demo', paused: false, surveying: false, next: null }];
let claimed = 'wm-1';
/** The event the next non-timed-out poll reports. Roster-only or not is the question. */
let lastEvent = { type: 'commented' };
/** Whoever is parked on /api/poll, waiting for the sequence to move. */
const parked = new Set();
function bump(event = { type: 'commented' }) {
  lastEvent = event;
  seq += 1;
  for (const fn of [...parked]) fn();
  parked.clear();
}

const counts = { questions: 0, poll: 0, pollSweeps: 0, work: 0, admin: 0, consoles: 0, prs: 0 };

/** What `/api/work` answers — the shape lib/server.js sends, cut to what is read here. */
const work = () => ({
  workspaces: [{ name: 'demo', claimed: [{ id: claimed }], sessions: [], ready: [], counts: {} }],
  elsewhere: [],
  advocates: roster,
  globals: { cap: 3, inUse: 0 },
  observing: false,
  service: null,
  router: null,
  seq,
});

/**
 * The other three payloads the inbox holds for pages you have not opened yet.
 *
 * Each is cut to what the page reading it actually looks at — an `Array` in the field the
 * warm layer checks before it will keep the entry, because a payload it cannot recognise
 * is one it re-fetches rather than half-patches. Every one of them answers instantly:
 * claim 6 is about *how many* requests each path costs, never how long one takes, and
 * charging the board a sweep here would only make the run longer.
 */
const adminStatus = () => ({
  reopenIsFresh: false,
  at: 0,
  scopes: [
    {
      id: 'all',
      label: 'Everything',
      workspaces: ['demo'],
      advocates: {
        total: roster.length,
        pausedCount: roster.filter((a) => a.paused).length,
        ours: 0,
        workers: 0,
      },
      terminals: { live: 0, closed: 0 },
    },
  ],
  closed: [],
});

const consoles = () => ({ consoles: [], workspaces: ['demo'] });

const board = () => ({ repos: [{ workspace: 'demo', prs: [] }], observing: false, unavailable: null });

/** The screen both endpoints answer with — the same shape lib/server.js sends. */
const screen = () => ({
  questions,
  requests: [],
  workspaces: ['demo'],
  spaces: [],
  filter: { space: 'all', workspace: 'all' },
  dismissAsk: null,
  summary: { sessions: 0, proposals: 0, questions: questions.length },
  seq,
});

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

// The committed files, for --baseline. Read through git rather than from a second
// checkout so the comparison is against HEAD of this very worktree.
const committed = (f) =>
  // stderr ignored: on the branch that introduces warm.js there is no HEAD copy of it,
  // and git saying so on every request is noise over the run it is the whole point of.
  execFileSync('git', ['show', `HEAD:${f}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (p === '/api/questions') {
      counts.questions += 1;
      await sleep(SWEEP_MS); // the sweep this whole change exists to stop paying for
      return json({ ...screen(), scope: 'human' });
    }

    // Two `bd` calls per workspace on the Mac, so it is charged the same sweep the
    // inbox is — the point of the whole preload being that you never wait for it.
    if (p === '/api/work') {
      counts.work += 1;
      await sleep(SWEEP_MS);
      return json(work());
    }

    if (p === '/api/poll') {
      counts.poll += 1;
      const since = Number(url.searchParams.get('since') || 0);
      const wait = Math.min(Number(url.searchParams.get('wait') || 25), 30) * 1000;
      if (since >= seq && wait > 0) {
        // Park, exactly as lib/events.js does: resolve when something moves, or time
        // out with nulls — which is the case that must cost nothing.
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            parked.delete(done);
            resolve();
          };
          const timer = setTimeout(done, wait);
          parked.add(done);
          res.on('close', done);
        });
      }
      if (res.writableEnded || req.destroyed) return;
      // The advocate roster and the observer flag ride *every* answer, whatever woke it
      // and including the quiet one — that is what lib/server.js does, and it is the
      // whole reason a held `/api/work` can be kept current for nothing.
      const free = { advocates: roster, observing: false };
      if (since >= seq)
        return json({ seq, resync: false, events: [], questions: null, requests: null, spaces: null, ...free });
      counts.pollSweeps += 1;
      await sleep(SWEEP_MS);
      return json({ seq, resync: false, events: [{ ...lastEvent, seq }], ...screen(), ...free });
    }

    // The one route this fixture owns rather than the app: it is how the check makes
    // something happen on the daemon's side of the wire.
    if (p === '/fixture/change') {
      questions = questions.map((q) => (q.key === KEY ? { ...q, title: 'This one changed' } : q));
      bump();
      return json({ ok: true, seq });
    }

    /* An advocate pausing: a roster-only event. The snapshot on the poll already says
       so, so nothing may be re-asked for it — and the held payload must take it anyway. */
    if (p === '/fixture/pause') {
      roster = roster.map((a) => ({ ...a, paused: true }));
      bump({ type: 'advocate', action: 'paused', workspace: 'demo' });
      return json({ ok: true, seq });
    }

    /* And a bead being claimed: the `bd` half, behind no event that carries it. This is
       the one that has to cost a request — once, and not inside the floor. */
    if (p === '/fixture/claim') {
      claimed = 'wm-9';
      bump({ type: 'claimed', workspace: 'demo', id: 'wm-9' });
      return json({ ok: true, seq });
    }

    /* The three paths this page holds warm for views nobody has tapped. Counted rather
       than delayed: the whole of claim 6 is which of them a wake is allowed to *ask for*
       again, and on the daemon two of them are in-memory reads while `/api/prs` is a `gh`
       call per repo — which is why one of the three is never asked for here at all. */
    if (p === '/api/admin') {
      counts.admin += 1;
      return json(adminStatus());
    }
    if (p === '/api/consoles') {
      counts.consoles += 1;
      return json(consoles());
    }
    if (p === '/api/prs') {
      counts.prs += 1;
      return json(board());
    }

    // Everything else the app pokes at on boot — agents, deploys, foundations. An empty
    // body is a valid answer to all of them and keeps the fixture to the point.
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && (p === '/app.js' || p === '/warm.js')) {
      let body;
      try {
        body = committed(`public${p}`);
      } catch {
        // warm.js does not exist at HEAD on the branch that introduces it, and that
        // is exactly the baseline: a page with no warm layer at all.
        res.writeHead(404).end('no');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(body);
    }

    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  }
  return r.result.value;
};

/** How long until the list is on screen, from the moment the navigation started. */
async function timeToCards(s, url) {
  const started = Date.now();
  await s.send('Page.navigate', { url });
  for (let i = 0; i < 200; i++) {
    if (await evalJs(s, `document.querySelectorAll('.card[data-key]').length >= 5`)) return Date.now() - started;
    await sleep(20);
  }
  return null;
}

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-warm-');

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

  /* 1. cold — the control */
  const cold = await timeToCards(s, `${BASE}/?t=${TOKEN}`);
  check(
    'a cold load waits out the sweep, which is what the rest is measured against',
    cold !== null && cold >= SWEEP_MS,
    `${cold}ms`
  );

  // Let the boot settle: the poll has to be parked and the payload kept before a tab
  // switch can mean anything. Long enough for the background warm to have finished too
  // — it waits 1200ms before starting and `/api/work` is a sweep — because claim 5 is
  // about which document filled that entry, and a navigation landing mid-warm would
  // make the answer depend on the fixture's latency rather than on the code.
  await sleep(2600);
  const kept = await evalJs(s, `Object.keys(sessionStorage).filter((k) => k.startsWith('beadcause.warm:'))`);
  check('and it keeps what it drew, for the next document', (kept || []).length > 0, JSON.stringify(kept));

  /* Take pull requests out of the inbox's kind filter, for the rest of the run.
     The inbox draws PR cards of its own when the filter wants them, and then it sweeps
     `/api/prs` on its own minute — which is the *other* thing that keeps that entry warm
     and would make every `/api/prs` count below unattributable. With `PRs` deselected the
     board is exactly what claim 6 is about: a payload held for a page reached from a row,
     which this document is not itself drawing and must therefore never go and re-ask for.
     Every fixture question is a plain bead, so `Questions` keeps all five cards. */
  await evalJs(s, `localStorage.setItem('beadcause.kinds', '["question"]')`);

  /* 2. away and back — the tab tap */
  await s.send('Page.navigate', { url: `${BASE}/prs?t=${TOKEN}` });
  await sleep(800);
  const askedBefore = counts.questions;
  const warm = await timeToCards(s, `${BASE}/?t=${TOKEN}`);
  // When this document started, which is when its floor on re-asking `/api/work` starts
  // running. Claim 5's last part has to be outside that floor to mean anything.
  const loadedAt = Date.now();
  check(
    'coming back draws the list from memory, well inside one sweep',
    warm !== null && warm < SWEEP_MS,
    `${warm}ms against ${cold}ms cold`
  );
  check(
    'and it drew before any answer could have arrived — the cards are not a fast fetch',
    warm !== null && warm < SWEEP_MS && counts.questions === askedBefore,
    `${counts.questions - askedBefore} sweeps asked for during the paint`
  );

  /* 3. idle — the refresh is a parked poll, not a sweep on a clock
     The wait is 27 seconds and it has to be: the timer this replaces fired every 25,
     so any shorter window passes with the old code still in place and proves nothing.
     This is the slowest thing in the file and it is the check the change is for. */
  await sleep(600);
  const sweepsAtRest = counts.questions;
  const pollsAtRest = counts.poll;
  // Read the held advocates payload before the idle window, so claim 5 can say whether
  // the quiet wake at the end of it restamped the entry or merely left it to age.
  const heldWork = async () =>
    JSON.parse((await evalJs(s, `sessionStorage.getItem('beadcause.warm:/api/work')`)) || 'null');
  const workBefore = await heldWork();
  const workAsksAtRest = counts.work;
  // And the same reading for the other three, which is the whole of claim 6: a stamp that
  // moves while the request count does not is an entry the log alone kept alive.
  const stampOf = async (path) =>
    Number(JSON.parse((await evalJs(s, `sessionStorage.getItem('beadcause.warm:${path}')`)) || 'null')?.at) || 0;
  const restStamps = {
    admin: await stampOf('/api/admin'),
    consoles: await stampOf('/api/consoles'),
    prs: await stampOf('/api/prs'),
  };
  const restAsks = { admin: counts.admin, consoles: counts.consoles, prs: counts.prs };
  await sleep(27000);
  check(
    'the inbox follows the event log — 27 idle seconds cost no sweep at all',
    counts.questions === sweepsAtRest,
    `${counts.questions - sweepsAtRest} sweeps in 27s idle, where the old timer would have made one`
  );
  check(
    'and it is parked on /api/poll rather than merely silent',
    pollsAtRest > 0 && counts.poll > pollsAtRest,
    `${counts.poll} polls`
  );

  /* 4. one bead moves — one card is rebuilt */
  const stamped = await evalJs(
    s,
    `(() => {
      let n = 0;
      for (const c of document.querySelectorAll('.card[data-key]')) c.dataset.stamp = 'mark' + n++;
      return n;
    })()`
  );
  await fetch(`${BASE}/fixture/change`);
  // The parked poll returns, then answers with a sweep of its own.
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await evalJs(s, `!!document.querySelector('.card[data-key] h2, .card[data-key] .title')`)) break;
  }
  await sleep(1500);
  const survived = await evalJs(
    s,
    `(() => {
      const out = { total: 0, stamped: 0, changedStillStamped: null };
      for (const c of document.querySelectorAll('.card[data-key]')) {
        out.total += 1;
        if (c.dataset.stamp) out.stamped += 1;
        if (c.dataset.key === ${JSON.stringify(KEY)}) out.changedStillStamped = Boolean(c.dataset.stamp);
      }
      return out;
    })()`
  );
  const changedText = await evalJs(
    s,
    `(() => {
      const c = document.querySelector('.card[data-key=' + JSON.stringify(${JSON.stringify(KEY)}) + ']');
      return c ? c.textContent.includes('This one changed') : false;
    })()`
  );
  check('the change arrives at all', changedText === true, changedText ? '' : 'the card never took the new title');
  check(
    'the card that changed is rebuilt',
    survived.changedStillStamped === false,
    `stamp ${survived.changedStillStamped === false ? 'gone' : 'still there'}`
  );
  check(
    'and every card that did not change is left exactly as it was',
    survived.total === stamped && survived.stamped === stamped - 1,
    `${survived.stamped}/${survived.total} original nodes kept, of ${stamped}`
  );

  /* 5. the tab you have not tapped yet — warm, and staying warm */

  check(
    'the Advocates payload is fetched behind the inbox, without being asked for',
    Boolean(workBefore?.data?.workspaces) && workAsksAtRest === 1,
    `${workAsksAtRest} /api/work in the background${workBefore?.data?.workspaces ? '' : ' — and nothing held'}`
  );
  const workAfterIdle = await heldWork();
  check(
    'and 27 idle seconds keep it alive rather than ageing it out — no request, a new stamp',
    Number(workAfterIdle?.at) > Number(workBefore?.at) && counts.work === workAsksAtRest,
    `stamp ${Number(workAfterIdle?.at) - Number(workBefore?.at)}ms newer, ${counts.work - workAsksAtRest} extra sweeps`
  );
  check(
    'a bead moving inside the floor does not become a second sweep for a tab nobody tapped',
    counts.work === workAsksAtRest,
    `${counts.work} /api/work so far, ${Math.round((Date.now() - loadedAt) / 1000)}s into a 60s floor`
  );

  /* 6. the board and the switches — the other three warmed paths, same hole */

  const idleStamps = {
    admin: await stampOf('/api/admin'),
    consoles: await stampOf('/api/consoles'),
    prs: await stampOf('/api/prs'),
  };
  check(
    '/admin, the chats and the board are kept young by the log alone — three new stamps, no requests',
    idleStamps.admin > restStamps.admin &&
      idleStamps.consoles > restStamps.consoles &&
      idleStamps.prs > restStamps.prs &&
      counts.admin === restAsks.admin &&
      counts.consoles === restAsks.consoles &&
      counts.prs === restAsks.prs,
    `+${idleStamps.admin - restStamps.admin}/${idleStamps.consoles - restStamps.consoles}/${
      idleStamps.prs - restStamps.prs
    }ms, ${counts.admin - restAsks.admin + (counts.consoles - restAsks.consoles) + (counts.prs - restAsks.prs)} requests`
  );

  /* An advocate pausing: on the poll already, so it must land in the held payload for
     nothing at all. This is the half of the advocates board that costs no request. */
  await fetch(`${BASE}/fixture/pause`);
  await sleep(2500);
  const paused = await heldWork();
  check(
    'an advocate pausing lands in the held payload off the poll, with no request at all',
    paused?.data?.advocates?.[0]?.paused === true && counts.work === workAsksAtRest,
    `paused ${String(paused?.data?.advocates?.[0]?.paused)}, ${counts.work - workAsksAtRest} extra sweeps`
  );
  /* And the same event seen from the board's side. An advocate is one of the five things
     that can move a lamp on it (`BOARD_EVENTS` in public/stream.js), so the held board is
     one the log has just contradicted — and a stamp put forward here would be a fresh
     clock over a payload we know to be wrong. It keeps its own age and the TTL takes it,
     which is exactly where the board started. */
  const movedStamps = { admin: await stampOf('/api/admin'), prs: await stampOf('/api/prs') };
  check(
    'an event that moved them stops the restamp rather than being papered over',
    movedStamps.prs === idleStamps.prs && movedStamps.admin === idleStamps.admin,
    `board ${movedStamps.prs === idleStamps.prs ? 'held' : 'restamped'}, /admin ${
      movedStamps.admin === idleStamps.admin ? 'held' : 'restamped'
    } — only /api/work folds a snapshot of now and may keep its clock`
  );
  check(
    'and an event inside the floor costs no request on any of the cheap paths either',
    counts.admin === restAsks.admin && counts.consoles === restAsks.consoles && counts.prs === restAsks.prs,
    `${counts.admin - restAsks.admin} admin, ${counts.consoles - restAsks.consoles} consoles, ${
      counts.prs - restAsks.prs
    } prs, ${Math.round((Date.now() - loadedAt) / 1000)}s into a 60s floor`
  );

  /* And the `bd` half, which no event carries. Outside the floor this time, because
     inside it the honest answer is "not yet" — which the claim above is about. */
  const waitOutFloor = 61000 - (Date.now() - loadedAt);
  if (waitOutFloor > 0) await sleep(waitOutFloor);
  await fetch(`${BASE}/fixture/claim`);
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    if (counts.work > workAsksAtRest) break;
  }
  await sleep(SWEEP_MS + 400);
  const claimedHeld = await heldWork();
  check(
    'and a claimed bead — which no event carries — is re-asked once, so the board is not an hour old',
    counts.work === workAsksAtRest + 1 && claimedHeld?.data?.workspaces?.[0]?.claimed?.[0]?.id === 'wm-9',
    `${counts.work - workAsksAtRest} sweep(s), holding ${claimedHeld?.data?.workspaces?.[0]?.claimed?.[0]?.id}`
  );
  /* The same wake, from the other three paths' point of view. It is outside the floor and
     it moved something, so the two that are in-memory reads on the daemon go and ask —
     once each, which is what stops /admin and the chat launcher being blank on arrival at
     the end of a long afternoon. */
  check(
    'the same wake re-asks /admin and the chats once each — cheap on the daemon, and the tab is not blank',
    counts.admin === restAsks.admin + 1 && counts.consoles === restAsks.consoles + 1,
    `${counts.admin - restAsks.admin} admin, ${counts.consoles - restAsks.consoles} consoles`
  );
  /* And the board, which is a `gh` call per repo: never, on any wake, for the whole run.
     This is the decision the bead was filed to make rather than a limitation — the inbox
     sweeps the board on its own minute when the kind filter wants pull requests, and when
     it does not, nobody pays a sweep per minute for a page that may never be opened. */
  const prsHeld = await stampOf('/api/prs');
  check(
    'and the board is never re-asked for at all — a `gh` sweep is not spent on a page nobody opened',
    counts.prs === restAsks.prs && prsHeld > movedStamps.prs,
    `${counts.prs - restAsks.prs} /api/prs since the idle window, and the entry is ${
      prsHeld > movedStamps.prs ? 'young again off the log' : 'still ageing'
    }`
  );
} finally {
  close();
  server.close();
  for (const fn of parked) fn();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
