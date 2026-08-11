#!/usr/bin/env node
//
// Can you decide a pull request from a phone?
//
//   node scripts/prfull-check.mjs [--baseline] [--out=DIR]
//
// `test/prfull.mjs` proves the daemon's half — what the view is drawn from, and what the
// two new endpoints refuse. This is the other half: the real `public/app.js` in a headless
// Chrome the size of a phone, against a stubbed `/api/prs` and `/api/pr/detail`, with every
// POST recorded so that "it merged" is an assertion about what went over the wire rather
// than about what the screen said afterwards.
//
// Six things are worth a browser, and every one of them would be silently wrong otherwise:
//
//   • **Tapping a row opens the whole screen.** Not an inline expansion — the same fixed
//     `.card.open` sheet a question opens into, with the tab bar covered and one card open
//     at a time. Measured against the viewport, because "full screen" is geometry.
//   • **Merge is armed, and the first press sends nothing.** The only proof is the absence
//     of a request. A phone in a pocket that merges on one tap is the worst thing on this
//     screen, and it is exactly the thing a screenshot cannot show.
//   • **Close keeps its reason box.** The first press swaps the buttons for a panel with a
//     textarea; the words typed into it are what goes over the wire; and the panel says
//     that no bead moves, which is the sentence the whole close design rests on.
//   • **A conflicted pull request offers a path, not a refusal.** Resolve conflicts and
//     Cancel, in place of merge — and Cancel sends nothing at all.
//   • **The facts are on the sheet.** Bead, agent, branch and the datetimes, drawn from
//     `/api/pr/detail` rather than from the row — including the agent line that has to say
//     "on a different branch" rather than quietly claiming a match.
//   • **A poll does not eat what you typed.** The inbox repaints every 25 seconds; a
//     half-written comment on an open pull request must survive it, and the sheet must not
//     collapse under it.
//
// `--baseline` serves HEAD's app.js and style.css instead of the working copy, which is how
// you tell a real failure from a flake: against a main without the full view, every case
// fails at once. `--out=DIR` saves the shots worth eyeballing.
import { spawn, execFileSync } from 'node:child_process';
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
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const TOKEN = 'prfull-check-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the fixture */

/* Two pull requests: one mergeable, one GitHub reports as conflicting. Both open, because
   the inbox's default sub-filter is `unmerged` and a merged row would not be in the list at
   all — which is bc-l8jp.6's rule and not this check's subject. */
const row = (over) => ({
  workspace: 'demo',
  repo: 'acme/demo',
  base: 'main',
  branch: 'worktree-something-a1b',
  author: 'someone',
  url: 'https://example.invalid/pull/42',
  title: 'a pull request worth deciding',
  number: 42,
  key: 'demo#42',
  state: 'OPEN',
  draft: false,
  createdAt: '2026-08-08T08:00:00Z',
  updatedAt: '2026-08-09T08:00:00Z',
  mergedAt: null,
  mergeCommit: null,
  additions: 40,
  deletions: 4,
  files: 2,
  checks: { state: 'passing', passing: 3, failing: 0, pending: 0, failed: [], total: 3 },
  mergeable: 'MERGEABLE',
  beads: [{ id: 'bc-abc', title: 'the work' }],
  merged: false,
  pushed: false,
  local: false,
  deployed: false,
  shipped: false,
  deployTracked: true,
  deployDeclared: true,
  deployHint: '`launchctl kickstart -k`',
  stage: 'review',
  note: '',
  ...over,
});

const CLEAN = row({});
const DIRTY = row({
  number: 43,
  key: 'demo#43',
  url: 'https://example.invalid/pull/43',
  title: 'the one that conflicts',
  branch: 'worktree-other-b2c',
  mergeable: 'CONFLICTING',
  note: 'Conflicts with main — it needs a rebase before it can merge.',
});

const BOARD = {
  unavailable: null,
  observing: false,
  build: { commit: 'c'.repeat(40), short: 'ccccccc', at: '2026-08-09T06:00:00Z' },
  counts: { review: 2, merged: 0, pushed: 0, deployed: 0, live: 0, closed: 0, owed: 0 },
  at: '2026-08-09T08:30:00Z',
  repos: [
    {
      workspace: 'demo',
      repo: 'acme/demo',
      dir: '/tmp/demo',
      base: 'main',
      error: null,
      deployTracked: true,
      deployDeclared: true,
      deployHint: '`launchctl kickstart -k`',
      prs: [CLEAN, DIRTY],
      release: { count: 0, prs: [], can: 'nothing' },
    },
  ],
};

const DESCRIPTION = 'What changed and why, in the words of whoever wrote it.\n\n- one thing\n- another\n';

/** The detail response per number: the fresh half, plus the two attributions worth drawing. */
const DETAIL = {
  42: () => ({
    row: CLEAN,
    pr: {
      number: 42,
      url: CLEAN.url,
      title: CLEAN.title,
      state: 'OPEN',
      draft: false,
      mergeable: 'MERGEABLE',
      mergeState: 'CLEAN',
      branch: CLEAN.branch,
      base: 'main',
      additions: 40,
      deletions: 4,
      files: 2,
      checks: CLEAN.checks,
      reviewDecision: null,
      mergedAt: null,
      mergeCommit: null,
      body: DESCRIPTION,
      author: 'someone',
      createdAt: CLEAN.createdAt,
      updatedAt: CLEAN.updatedAt,
    },
    agent: {
      kind: 'session',
      matched: true,
      bead: 'bc-abc',
      sessionId: 'deadbeef-1111-2222-3333-444444444444',
      branch: CLEAN.branch,
      outcome: 'done',
      startedAt: '2026-08-08T06:00:00Z',
      endedAt: '2026-08-08T07:30:00Z',
      commits: 7,
      login: 'someone',
    },
    unavailable: null,
  }),
  43: () => ({
    row: DIRTY,
    pr: {
      ...DETAIL[42]().pr,
      number: 43,
      url: DIRTY.url,
      title: DIRTY.title,
      branch: DIRTY.branch,
      mergeable: 'CONFLICTING',
      mergeState: 'DIRTY',
      body: 'the conflicting one',
    },
    // The case the attribution has to state rather than smooth over: a session on the bead,
    // on a branch that is not this one.
    agent: {
      kind: 'session',
      matched: false,
      bead: 'bc-abc',
      sessionId: 'feedface-5555-6666-7777-888888888888',
      branch: 'worktree-something-else-z9z',
      outcome: 'timeout',
      startedAt: '2026-08-07T06:00:00Z',
      endedAt: '2026-08-07T07:00:00Z',
      commits: 2,
      login: 'someone',
    },
    unavailable: null,
  }),
};

/* ------------------------------------------------------------------- server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const committed = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });
const BASELINED = ['/app.js', '/style.css', '/prcard.js'];

/** Every write the page attempted. `/api/presence` is the page reporting where it is. */
const writes = [];
const real = () => writes.filter((w) => w.path !== '/api/presence');

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // No beads at all: the list is nothing but pull requests, which is the screen this is
    // about and keeps every selector below unambiguous.
    if (p === '/api/questions') {
      return json({ questions: [], workspaces: ['demo'], spaces: [], scope: 'human', summary: null });
    }
    if (p === '/api/prs') return json(BOARD);
    if (p === '/api/pr/detail') {
      const make = DETAIL[Number(url.searchParams.get('number'))];
      return make ? json(make()) : json({ error: 'not found' }, 404);
    }
    if (req.method === 'POST' && p.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        writes.push({ path: p, ...JSON.parse(body || '{}') });
        // Enough of each answer for the card to say what happened.
        if (p === '/api/pr/merge') return json({ ok: true, pr: { number: 42 }, land: { note: 'fast-forwarded main' }, cards: [] });
        if (p === '/api/pr/close') return json({ ok: true, number: 42, reason: 'not the one', beads: ['bc-abc'] });
        if (p === '/api/pr/conflicts') return json({ ok: true, number: 43, branch: DIRTY.branch, dir: '/tmp/demo', mode: 'auto' });
        json({ ok: true });
      });
    }
    if (p.startsWith('/api/')) return json({});

    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    if (BASELINE && BASELINED.includes(`/${rel}`)) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] });
      return res.end(committed(`public/${rel}`));
    }
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------- chrome */

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const q = msg.id != null && pending.get(msg.id);
      if (!q) return;
      pending.delete(msg.id);
      msg.error ? q.reject(new Error(msg.error.message)) : q.resolve(msg.result);
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
  const port = 9800 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-prfull-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
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
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 140)}`);
  return r.result.value;
};

/* ---------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launch();

const KEY = (n) => JSON.stringify(`pr:demo#${n}`);
const CARD = (n) => `document.querySelector('.card[data-key=' + JSON.stringify(${KEY(n)}) + ']')`;

const waitFor = async (expr, ms = 8000) => {
  for (let i = 0; i < ms / 200; i++) {
    if (await evalJs(s, expr)) return true;
    await sleep(200);
  }
  return false;
};

const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `prfull-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/**
 * Open a pull request the way a thumb does: tap the row.
 *
 * A no-op on one that is already open, which is the state an act leaves it in — the sheet
 * stays up so the sentence about what happened can be read twice.
 */
const openPr = async (n) => {
  if (!(await evalJs(s, `${CARD(n)}?.classList.contains('open') === true`))) {
    await evalJs(s, `${CARD(n)}.querySelector('[data-act="pr-open"]')?.click()`);
  }
  await waitFor(`${CARD(n)}?.classList.contains('open') === true`);
  // The detail lands a beat later; the facts and the description come with it.
  await waitFor(`!!${CARD(n)}?.querySelector('.md, .pr-quiet')`);
  await sleep(400);
};

/** What the sheet is, measured against the viewport rather than described. */
const SHEET = (n) => `(() => {
  const card = ${CARD(n)};
  if (!card) return { there: false };
  const box = card.getBoundingClientRect();
  const cs = getComputedStyle(card);
  const bar = document.querySelector('.tabbar');
  const barBox = bar ? bar.getBoundingClientRect() : null;
  const text = card.textContent.replace(/\\s+/g, ' ');
  const facts = {};
  for (const div of card.querySelectorAll('.pr-facts > div')) {
    facts[div.querySelector('dt').textContent.trim()] = div.querySelector('dd').textContent.trim();
  }
  return {
    there: true,
    open: card.classList.contains('open'),
    fixed: cs.position === 'fixed',
    fullWidth: Math.round(box.width) >= innerWidth - 1,
    fullHeight: Math.round(box.height) >= innerHeight - 1,
    // The sheet is drawn over the tab bar deliberately: it is one gesture deep, and the
    // way out is Collapse.
    overTabbar: !!barBox && Number(cs.zIndex) > Number(bar ? getComputedStyle(bar).zIndex : 0),
    openCards: document.querySelectorAll('.card.open').length,
    collapse: !!card.querySelector('[data-act="collapse"]'),
    description: (card.querySelector('.brief .md')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    github: [...card.querySelectorAll('a[target="_blank"]')].map((a) => a.getAttribute('href')),
    facts,
    merge: card.querySelector('[data-act="pr-merge-go"]')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    closeBtn: card.querySelector('[data-act="pr-close"]')?.textContent.trim() || '',
    comment: !!card.querySelector('[data-role="pr-comment"]'),
    conflicts: card.querySelector('[data-act="pr-conflicts"]')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    cancel: !!card.querySelector('[data-act="pr-cancel"]'),
    said: card.querySelector('.pr-said')?.textContent.trim() || '',
    conflictNote: (card.querySelector('.pr-conflict')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    reasonBox: !!card.querySelector('[data-role="pr-reason"]'),
    text,
  };
})()`;

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
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelectorAll('.card.pr-card').length >= 2`);

  /* ---- 1. the shut row is a button, and tapping it opens the whole screen ---- */
  const shut = await evalJs(
    s,
    `(() => {
      const card = ${CARD(42)};
      const row = card.querySelector('[data-act="pr-open"]');
      return {
        isButton: row?.tagName === 'BUTTON',
        // The title must not be a link while the row is a button: nested interactive
        // elements are resolved differently by different phones.
        titleLink: !!card.querySelector('.pr-title-link'),
        wide: row ? Math.round(row.getBoundingClientRect().width) : 0,
        cardWide: Math.round(card.getBoundingClientRect().width),
      };
    })()`
  );
  check('a shut pull request row is a button, not a link out', shut.isButton && !shut.titleLink, JSON.stringify(shut));
  check('and it is the whole width of the card', shut.wide >= shut.cardWide - 30, `${shut.wide} of ${shut.cardWide}`);

  await openPr(42);
  const sheet = await evalJs(s, SHEET(42));
  await shot('open');
  check('tapping it opens full screen, not inline', sheet.open && sheet.fixed, JSON.stringify({ open: sheet.open, fixed: sheet.fixed }));
  check('the sheet is the viewport', sheet.fullWidth && sheet.fullHeight, JSON.stringify({ w: sheet.fullWidth, h: sheet.fullHeight }));
  check('over the tab bar, one gesture deep', sheet.overTabbar === true, String(sheet.overTabbar));
  check('exactly one card is open', sheet.openCards === 1, `${sheet.openCards} open`);
  check('and there is a way back to the list', sheet.collapse === true, String(sheet.collapse));
  check('nothing was written by opening it', real().length === 0, JSON.stringify(real().map((w) => w.path)));

  /* ---- 2. what it says: the description, the link, the facts ---- */
  check('the description is on it', /in the words of whoever wrote it/.test(sheet.description), JSON.stringify(sheet.description.slice(0, 60)));
  check('with a link out to the pull request', sheet.github.includes('https://example.invalid/pull/42'), JSON.stringify(sheet.github));
  check('the bead is named', sheet.facts.bead === 'bc-abc', JSON.stringify(sheet.facts));
  check('the branch and base are named', /worktree-something-a1b → main/.test(sheet.facts.branch || ''), JSON.stringify(sheet.facts.branch));
  check('the authoring agent is named', /session deadbeef · done · 7 commits/.test(sheet.facts.agent || ''), JSON.stringify(sheet.facts.agent));
  check('and the datetimes are', Boolean(sheet.facts.opened && sheet.facts.touched), JSON.stringify(sheet.facts));

  /* ---- 3. merge is armed: the first press sends nothing ---- */
  check('merge is offered', /Merge & push #42/.test(sheet.merge), JSON.stringify(sheet.merge));
  await evalJs(s, `${CARD(42)}.querySelector('[data-act="pr-merge-go"]')?.click()`);
  await sleep(300);
  const armed = await evalJs(s, SHEET(42));
  await shot('armed');
  check('the first press sends nothing', real().length === 0, JSON.stringify(real().map((w) => w.path)));
  check('and says what the second one will do', /Tap again/.test(armed.merge), JSON.stringify(armed.merge));
  await evalJs(s, `${CARD(42)}.querySelector('[data-act="pr-merge-go"]')?.click()`);
  await sleep(600);
  const merged = real().filter((w) => w.path === '/api/pr/merge');
  check('the second press merges', merged.length === 1, JSON.stringify(real().map((w) => w.path)));
  check('naming the pull request and the repo', merged[0]?.number === 42 && merged[0]?.workspace === 'demo', JSON.stringify(merged[0]));
  const after = await evalJs(s, SHEET(42));
  check('and the card says what happened', /Merged #42/.test(after.said), JSON.stringify(after.said));

  /* ---- 4. close keeps its reason box, and the words go over the wire ---- */
  writes.length = 0;
  await evalJs(s, `${CARD(42)}.querySelector('[data-act="pr-close"]')?.click()`);
  await sleep(300);
  const closing = await evalJs(s, SHEET(42));
  await shot('closing');
  check('closing asks for a reason first', closing.reasonBox === true, String(closing.reasonBox));
  check('and sends nothing on the way there', real().length === 0, JSON.stringify(real().map((w) => w.path)));
  check(
    'the panel says no bead moves, and where that is done instead',
    /left exactly as/.test(closing.conflictNote) && /Decline/.test(closing.conflictNote),
    JSON.stringify(closing.conflictNote.slice(0, 140))
  );
  await evalJs(
    s,
    `(() => {
      // Null-safe throughout, so a --baseline run — where none of these boxes exists —
      // reports every case as a failure rather than dying halfway down the file.
      const box = ${CARD(42)}.querySelector('[data-role="pr-reason"]');
      if (!box) return;
      box.value = 'not the one';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  await evalJs(s, `${CARD(42)}.querySelector('[data-act="pr-close-go"]')?.click()`);
  await sleep(700);
  const closed = real().filter((w) => w.path === '/api/pr/close');
  check('the close carries the reason you typed', closed[0]?.reason === 'not the one', JSON.stringify(closed[0]));

  /* ---- 5. a conflicted pull request offers the path, and cancel sends nothing ---- */
  writes.length = 0;
  await openPr(43);
  const dirty = await evalJs(s, SHEET(43));
  await shot('conflict');
  check('a conflicted pull request offers resolve-conflicts', /Resolve conflicts/.test(dirty.conflicts), JSON.stringify(dirty.conflicts));
  check('and a cancel beside it', dirty.cancel === true, String(dirty.cancel));
  check('with merge and close gone — there is nothing to decide yet', dirty.merge === '' && dirty.closeBtn === '', JSON.stringify({ merge: dirty.merge, close: dirty.closeBtn }));
  check(
    'the sentence says what the session will do and what it will not',
    /which is work, not a decision/.test(dirty.conflictNote) && /merge stays yours/.test(dirty.conflictNote),
    JSON.stringify(dirty.conflictNote.slice(0, 160))
  );
  check(
    'the agent line admits the archive knows a different branch',
    /not this one/.test(dirty.facts.agent || ''),
    JSON.stringify(dirty.facts.agent)
  );
  await evalJs(s, `${CARD(43)}.querySelector('[data-act="pr-conflicts"]')?.click()`);
  await sleep(300);
  check('resolve-conflicts is armed too — it opens an unattended session', real().length === 0, JSON.stringify(real().map((w) => w.path)));
  await evalJs(s, `${CARD(43)}.querySelector('[data-act="pr-conflicts"]')?.click()`);
  await sleep(700);
  const opened = real().filter((w) => w.path === '/api/pr/conflicts');
  check('the second press opens it', opened.length === 1 && opened[0].number === 43, JSON.stringify(opened[0] || null));

  writes.length = 0;
  await openPr(43);
  await evalJs(s, `${CARD(43)}.querySelector('[data-act="pr-cancel"]')?.click()`);
  await sleep(400);
  const cancelled = await evalJs(s, `document.querySelectorAll('.card.open').length`);
  check('cancel closes the sheet', cancelled === 0, `${cancelled} still open`);
  check('and sends nothing', real().length === 0, JSON.stringify(real().map((w) => w.path)));

  /* ---- 6. a poll must not eat what you typed ---- */
  writes.length = 0;
  await openPr(42);
  await evalJs(
    s,
    `(() => {
      const box = ${CARD(42)}.querySelector('[data-role="pr-comment"]');
      if (!box) return;
      box.value = 'half a thought';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  await evalJs(s, `document.querySelector('#refresh').click()`);
  await sleep(1400);
  const survived = await evalJs(
    s,
    `(() => {
      const card = ${CARD(42)};
      return {
        open: !!card?.classList.contains('open'),
        draft: card?.querySelector('[data-role="pr-comment"]')?.value || '',
      };
    })()`
  );
  check('a refresh leaves the sheet open', survived.open === true, String(survived.open));
  check('and the comment you were writing with it', survived.draft === 'half a thought', JSON.stringify(survived.draft));
  check('none of that wrote anything', real().length === 0, JSON.stringify(real().map((w) => w.path)));
} finally {
  close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
