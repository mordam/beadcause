#!/usr/bin/env node
//
// Does the launcher's repo row filter, does ＋ still start, and are the dismissed
// ones out of the way?
//
//   node scripts/launcher-check.mjs [--baseline] [--keep]
//
// The row used to be the start button: tapping a repo opened a new conversation
// in it, and every conversation from every repo sat in one pile underneath. It is
// a tab bar now — All on the left, one tab per repo, the list below filtered to
// the tab — which moves starting onto a ＋ of its own. That swap is exactly the
// kind of change that half-lands: the filter works and ＋ starts in the wrong
// repo, or All has no way to start anything at all.
//
// The second filter over the same list is the one the ✕ writes. Closing a row is
// soft — the transcript stays and saying anything reopens it — so the list is the
// live conversations and a toggle beside the tabs gives the dismissed ones back.
// What that can break is a screen rather than a function, which is why it is here
// as well as in test/dismissed.mjs: a repo whose conversations have all been
// dismissed has to read as filtered rather than as empty, and the control that
// unfilters it has to be findable at 393px beside four tabs and a ＋.
//
// The third thing here is a dot, and it is here because a browser is the only thing
// that can see it. A conversation mid-turn draws a spark in its phase slot, and for
// months it drew one that was 0px wide (bc-7vzr) — `.spark` is sized in px and
// `.console-row` never made the slot a flex parent. Every test of that row read HTML,
// and the HTML is identical either way.
//
// Same shape as console-check.mjs: the real public/console.{js,html} and
// public/style.css in a headless Chrome the size of a phone, against a fixture
// `/api/consoles` served from this process, so nothing here talks to a daemon or
// touches a bead. `--baseline` serves the committed copies instead of the working
// ones — baseline has no tabs at all, so it must fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'launcher-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
for (const v of ['marked.js', 'purify.js']) {
  if (!fs.existsSync(path.join(PUBLIC, 'vendor', v))) {
    console.error(`public/vendor/${v} is missing — run \`npm run vendor\` first.`);
    process.exit(1);
  }
}

/* ---------------------------------------------------------------- fixtures */

const at = (n) => new Date(Date.UTC(2026, 7, 1, 10, n)).toISOString();

// Four repos, and deliberately two of them with nothing to list: one never talked to
// at all — a tab is how you reach it to start — and one whose only conversation has
// been dismissed, which is the same empty list for an entirely different reason.
const WORKSPACES = ['beadcause', 'sophab', 'deluvia', 'ehatt'];

const row = (id, workspace, title, extra = {}) => ({
  id,
  agent: 'console',
  workspace,
  title,
  seed: null,
  status: 'idle',
  closedAt: null,
  messageCount: 2,
  beadCount: 0,
  created: [],
  createdAt: at(0),
  updatedAt: at(9),
  ...extra,
});

const CONSOLES = [
  // Mid-turn, so the phase slot draws a spark rather than 💬. It is a *live* row on a
  // repo that has other live rows, which is the case the launcher actually has to draw:
  // the whole point of the dot is telling this row apart from the ones beside it.
  row('bc-1', 'beadcause', 'The launcher is one pile', { status: 'thinking' }),
  row('bc-2', 'beadcause', 'A finished one', { closedAt: at(5) }),
  // Started from /foundations, not from here — same record, same workspace, so it
  // lands under beadcause's tab looking exactly like the two above it unless the
  // row says who it is with. The server names the agent; see lib/agents.js.
  row('bc-3', 'beadcause', 'Chat with the critic', { agent: 'critic', agentName: 'Critic', agentEmoji: '🧨' }),
  row('sp-1', 'sophab', 'Hero openings'),
  row('sp-2', 'sophab', 'Pricing tiers'),
  row('eh-1', 'ehatt', 'The only one ehatt ever had', { closedAt: at(6) }),
];

/** What each tab lists by default — the live ones — and what it is holding back. */
const COUNTS = { all: 4, beadcause: 2, sophab: 2, deluvia: 0, ehatt: 0 };
const DISMISSED = { all: 2, beadcause: 1, sophab: 0, deluvia: 0, ehatt: 1 };

// One thread to land in, so a ＋ that navigates arrives somewhere real.
const THREAD = {
  id: 'started',
  workspace: 'sophab',
  title: 'Just started',
  status: 'idle',
  error: null,
  seq: 1,
  seed: null,
  created: [],
  closedAt: null,
  draft: null,
  messages: [{ role: 'user', text: 'Hello.', at: at(0) }],
};

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

// Read through git rather than from a second checkout, so --baseline compares
// against HEAD of this very worktree.
const committed = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });
const BASELINED = ['/console.js', '/console.html', '/style.css'];
// Every launcher control below is reached with `?.`, because under --baseline half
// of them do not exist yet and a baseline run has to *report* that as failures
// rather than die on the first missing button.

const parked = new Set();
/** Every POST /api/console the page made, in order — what ＋ actually asked for. */
const started = [];
/** The server-owned space filter, which is where the selected repo now lives. */
let filter = { space: 'all', workspace: 'all' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/consoles') return json({ consoles: CONSOLES, workspaces: WORKSPACES });
    /* The repo tabs are a face of the space picker now (public/spacebar.js), so which
       repo the launcher is on is a value on the server rather than in localStorage —
       which is exactly what makes it survive a reload here. Two endpoints, and the
       fixture has to hold the value between them or the tab would come back as All. */
    if (p === '/api/spaces') {
      return json({ spaces: [], workspaces: WORKSPACES, counts: {}, filter, waiting: 0 });
    }
    if (p === '/api/filter' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        filter = { space: parsed.space || 'all', workspace: parsed.workspace || 'all' };
        json({ ok: true, filter, dismissAsk: null });
      });
    }
    if (p === '/api/console' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        started.push(JSON.parse(body || '{}'));
        json({ id: THREAD.id });
      });
    }
    if (p === '/api/console') return json(url.searchParams.get('id') === THREAD.id ? THREAD : { error: 'not found' });
    // The long poll never returns: the fixture never changes, and answering it
    // would spin the page's poll loop for the length of the run.
    if (p === '/api/console/poll') return void parked.add(res);
    if (p.startsWith('/api/')) return json({});

    const rel = p === '/console' ? 'console.html' : p.replace(/^\/+/, '') || 'index.html';
    // Against `/console`, not `/console.html`: the page is reached by the route,
    // and a baseline that quietly served the working copy's HTML would be a
    // baseline that passes half the run.
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

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 140)}`);
  return r.result.value;
};

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// The tab bar as the screen has it: which repo, what it says, which one is on.
const TABS = `[...document.querySelectorAll('#ws-row [data-ws]')].map((b) => ({
  ws: b.dataset.ws,
  text: b.textContent.trim(),
  on: b.getAttribute('aria-selected') === 'true',
  stop: b.tabIndex === 0,
}))`;

// Which repo each visible conversation belongs to. The first pill on a row is its
// workspace; an agent chat and a closed row each carry another one after it.
const ROWS = `[...document.querySelectorAll('#recent .console-row')].map(
  (r) => r.querySelector('.pill').textContent.trim()
)`;

// What each row says about who it is with: the mark in the phase slot, and the
// agent pill if it has one.
//
// The spark is measured rather than found, because finding it proves nothing: the
// markup carries `<span class="spark">` whether or not anything is drawn, so a check
// that queried for it passed for months against a launcher with no visible dot at
// all (bc-7vzr). `.spark` is sized in px, so with no flex parent it lays out as an
// empty inline box — width 0 — and it defaults to `var(--muted)`, so even laid out it
// can be the same dead grey as an idle row. Hence the rect, the paint and the
// animation, one each for the three ways this goes wrong.
const MARKS = `(() => {
  // What \`var(--accent)\` actually resolves to under whichever theme Chrome is in —
  // the token text off :root would be a string to compare against a painted rgb().
  const probe = document.createElement('span');
  probe.style.cssText = 'display:none;background:var(--accent)';
  document.body.appendChild(probe);
  const accent = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return {
    accent,
    rows: [...document.querySelectorAll('#recent .console-row')].map((r) => {
      const spark = r.querySelector('.spark');
      const css = spark && getComputedStyle(spark);
      return {
        id: (r.querySelector('[data-close]')?.dataset.close) || '',
        title: r.querySelector('.work-title').textContent.trim(),
        phase: r.querySelector('.work-phase').textContent.trim(),
        agentPill: r.querySelector('.pill.agent')?.textContent.trim() || null,
        spark: spark ? Math.round(spark.getBoundingClientRect().width) : null,
        sparkPaint: css ? css.backgroundColor : null,
        sparkAnim: css ? css.animationName : null,
      };
    }),
  };
})()`;

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-launcher-');

// `--out=<dir>` writes what the assertions are describing. This is a layout
// change on a phone, and a row of passing assertions says nothing about whether
// the tabs and the ＋ fit beside each other at 393px.
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `launcher-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/** Land on the launcher and wait for it to have drawn its tabs. */
const openLauncher = async (query = '') => {
  await s.send('Page.navigate', { url: `${BASE}/console${query}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#recent .console-row, #recent .empty')`)) return;
  }
  throw new Error('the launcher never rendered');
};

const tapTab = async (ws) => {
  await evalJs(s, `document.querySelector('#ws-row [data-ws="${ws}"]')?.click()`);
  await sleep(250);
};

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

  /* ---- a tab per repo, plus All ---- */
  await openLauncher(`?t=${TOKEN}`);
  const tabs = await evalJs(s, TABS);
  check(
    'All leads the row, then one tab per repo',
    tabs.map((t) => t.ws).join(',') === `all,${WORKSPACES.join(',')}`,
    tabs.map((t) => t.ws).join(',') || 'no tabs at all'
  );
  check('All is what an unvisited launcher opens on', tabs[0]?.on === true, JSON.stringify(tabs[0]));
  check(
    'each tab carries how many conversations it would list',
    tabs[0]?.text === `All ${COUNTS.all}` &&
      tabs[1]?.text === `beadcause ${COUNTS.beadcause}` &&
      tabs[2]?.text === `sophab ${COUNTS.sophab}`,
    tabs.map((t) => t.text).join(' | ')
  );
  check(
    'a repo with nothing in it still gets a tab, and reports no count',
    tabs[3]?.ws === 'deluvia' && tabs[3]?.text === 'deluvia',
    JSON.stringify(tabs[3])
  );
  check(
    'and so does one whose conversations have all been dismissed',
    tabs[4]?.ws === 'ehatt' && tabs[4]?.text === 'ehatt',
    JSON.stringify(tabs[4])
  );
  check(
    'only the selected tab is in the tab order',
    tabs.filter((t) => t.stop).length === 1 && tabs.find((t) => t.stop)?.ws === 'all',
    tabs.filter((t) => t.stop).map((t) => t.ws).join(',')
  );
  check('All shows every live conversation', (await evalJs(s, ROWS)).length === COUNTS.all, `${(await evalJs(s, ROWS)).length}`);
  await shot('all');

  /* ---- the dismissed ones are hidden, and the toggle says how many ---- */
  const titles = `[...document.querySelectorAll('#recent .work-title')].map((t) => t.textContent.trim())`;
  const TOGGLE = `(() => {
    const b = document.querySelector('#ws-dismissed');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const css = getComputedStyle(b);
    return {
      hidden: b.hidden || r.width === 0,
      text: b.textContent.trim().replace(/\\s+/g, ' '),
      pressed: b.getAttribute('aria-pressed'),
      label: b.getAttribute('aria-label'),
      right: Math.round(r.right),
      paint: [css.backgroundColor, css.color, css.borderColor].join(' / '),
    };
  })()`;

  const hidden = await evalJs(s, titles);
  const off = await evalJs(s, TOGGLE);
  check(
    'a dismissed conversation is not on the default list',
    !hidden.includes('A finished one') && hidden.length === COUNTS.all,
    hidden.join(' | ')
  );
  check(
    'the toggle says how many are being kept back, and fits beside the tabs',
    off?.hidden === false && off?.text === `Dismissed ${DISMISSED.all}` && off?.right <= VP.width,
    JSON.stringify(off)
  );
  check('and it reads as off until it is pressed', off?.pressed === 'false', JSON.stringify(off?.pressed));

  await evalJs(s, `document.querySelector('#ws-dismissed')?.click()`);
  await sleep(250);
  const shownTitles = await evalJs(s, titles);
  const on = await evalJs(s, TOGGLE);
  const dismissedRows = await evalJs(
    s,
    `[...document.querySelectorAll('#recent .console-row')].filter((r) => r.classList.contains('closed'))
       .map((r) => ({
         title: r.querySelector('.work-title').textContent.trim(),
         mark: [...r.querySelectorAll('.pill')].map((p) => p.textContent.trim()).join(','),
         href: r.querySelector('a')?.getAttribute('href') || null,
         x: !!r.querySelector('[data-close]'),
       }))`
  );
  check(
    'pressing it puts them back on the list',
    shownTitles.includes('A finished one') && shownTitles.length === COUNTS.all + DISMISSED.all,
    shownTitles.join(' | ')
  );
  check('and says so', on?.pressed === 'true' && /^Hide /.test(on?.label || ''), JSON.stringify(on));
  // A control whose only tell is an attribute is a control nobody can see is on. The
  // chips press the same way everywhere in the app; this is that paint, on this one.
  check(
    'and looks it — a pressed chip is painted, not just labelled',
    Boolean(on?.paint) && on.paint !== off?.paint,
    `${off?.paint} → ${on?.paint}`
  );
  check(
    'each of them is marked dismissed, and is still the way back into it',
    dismissedRows.length === DISMISSED.all &&
      dismissedRows.every((r) => /dismissed/.test(r.mark) && /^\/console\?id=/.test(r.href || '')),
    JSON.stringify(dismissedRows)
  );
  check(
    'and carries no ✕ — there is nothing left to dismiss',
    dismissedRows.every((r) => !r.x),
    JSON.stringify(dismissedRows.filter((r) => r.x))
  );
  const withThem = await evalJs(s, TABS);
  check(
    'the tab counts move with what the list is showing',
    withThem[0]?.text === `All ${COUNTS.all + DISMISSED.all}` &&
      withThem[1]?.text === `beadcause ${COUNTS.beadcause + DISMISSED.beadcause}`,
    withThem.map((t) => t.text).join(' | ')
  );
  await shot('dismissed');

  /* ---- the choice survives the trip into a conversation and back ---- */
  await openLauncher();
  const kept = await evalJs(s, TOGGLE);
  check(
    'it is still showing them after a reload — the same tab, one navigation later',
    kept?.pressed === 'true' && (await evalJs(s, titles)).includes('A finished one'),
    JSON.stringify(kept)
  );
  await evalJs(s, `document.querySelector('#ws-dismissed')?.click()`);
  await sleep(250);

  /* ---- a repo whose conversations have all been dismissed ---- */
  await tapTab('ehatt');
  const allGone = await evalJs(
    s,
    `({
      rows: document.querySelectorAll('#recent .console-row').length,
      note: (document.querySelector('#recent .empty')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      toggle: document.querySelector('#ws-dismissed')?.textContent.trim().replace(/\\s+/g, ' ') || null,
    })`
  );
  check(
    'a repo whose conversations are all dismissed reads as filtered, not as empty',
    allGone.rows === 0 && /dismissed/i.test(allGone.note) && !/yet/.test(allGone.note),
    JSON.stringify(allGone)
  );
  check(
    'and the control that would show them is on the screen with its count',
    allGone.toggle === `Dismissed ${DISMISSED.ehatt}`,
    String(allGone.toggle)
  );
  await shot('all-dismissed');
  await tapTab('all');

  /* ---- an agent chat is not a chat session ---- */
  const seen = await evalJs(s, MARKS);
  const marks = seen.rows;
  const agentRow = marks.find((m) => m.title === 'Chat with the critic');
  const plainRows = marks.filter((m) => m.title !== 'Chat with the critic');
  check(
    'a chat started from /foundations says which agent it is with',
    agentRow?.agentPill === '🧨 Critic',
    JSON.stringify(agentRow)
  );
  check(
    "and draws that agent's emoji where a chat session draws 💬",
    agentRow?.phase === '🧨',
    `${agentRow?.phase} vs ${plainRows.map((m) => m.phase).join(',')}`
  );
  check(
    'a chat session carries no agent pill — it is what the mark is read against',
    plainRows.every((m) => m.agentPill === null),
    JSON.stringify(plainRows.filter((m) => m.agentPill))
  );

  /* ---- and a conversation mid-turn says so, visibly ---- */
  const busyRow = marks.find((m) => m.title === 'The launcher is one pile');
  const idleRows = marks.filter((m) => m.title !== 'The launcher is one pile');
  check(
    'a conversation mid-turn draws a spark in the phase slot',
    busyRow?.spark !== null,
    JSON.stringify(busyRow)
  );
  check(
    'and it is on the screen — a bare span with no flex parent lays out 0px wide',
    (busyRow?.spark || 0) > 0,
    `the dot is ${busyRow?.spark}px wide`
  );
  check(
    'and it is the accent, breathing — not the dead grey of an idle row',
    busyRow?.sparkPaint === seen.accent && busyRow?.sparkAnim === 'breathe',
    `${busyRow?.sparkPaint} / ${busyRow?.sparkAnim} vs accent ${seen.accent}`
  );
  check(
    'no other row draws one — it is the tell, not decoration',
    idleRows.every((m) => m.spark === null),
    JSON.stringify(idleRows.filter((m) => m.spark !== null).map((m) => m.title))
  );

  /* ---- selecting one filters the list to it ---- */
  await tapTab('sophab');
  await shot('repo');
  const only = await evalJs(s, ROWS);
  check(
    'selecting a repo shows only that repo',
    only.length === COUNTS.sophab && only.every((w) => w === 'sophab'),
    only.join(',') || 'nothing'
  );
  const after = await evalJs(s, TABS);
  check(
    'and the tab bar says which one',
    after.filter((t) => t.on).length === 1 && after.find((t) => t.on)?.ws === 'sophab',
    after.filter((t) => t.on).map((t) => t.ws).join(',')
  );

  /* ---- the row and the dropdown above it are one control ---- */
  const pick = async (value) => {
    await evalJs(
      s,
      `(() => {
        const el = document.querySelector('#space-pick');
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change'));
        return true;
      })()`
    );
    await sleep(400);
  };
  await pick('ws:beadcause');
  const viaBar = await evalJs(s, ROWS);
  const barTab = await evalJs(s, TABS);
  check(
    'the space picker in the top bar filters the same list',
    viaBar.length === COUNTS.beadcause && viaBar.every((w) => w === 'beadcause'),
    viaBar.join(',') || 'nothing'
  );
  check(
    'and the row follows it, rather than disagreeing with it',
    barTab.find((t) => t.on)?.ws === 'beadcause',
    JSON.stringify(barTab.find((t) => t.on))
  );
  // Back where the rest of the run expects to be.
  await pick('ws:sophab');

  /* ---- the selection survives a reload ---- */
  await openLauncher();
  const back = await evalJs(s, TABS);
  const backRows = await evalJs(s, ROWS);
  check(
    'the tab you left on is the tab you come back to',
    back.find((t) => t.on)?.ws === 'sophab' && backRows.length === COUNTS.sophab,
    `${back.find((t) => t.on)?.ws} · ${backRows.length} rows`
  );

  /* ---- ＋ starts one in the selected repo ---- */
  started.length = 0;
  await evalJs(s, `document.querySelector('#ws-new')?.click()`);
  await sleep(1200);
  check(
    '＋ starts a conversation in the selected repo',
    started.length === 1 && started[0]?.workspace === 'sophab',
    JSON.stringify(started)
  );
  const landed = await evalJs(
    s,
    `({ thread: !document.querySelector('#thread').hidden, launcher: !document.querySelector('#launcher') || document.querySelector('#launcher').hidden, url: location.search })`
  );
  check('and lands you in the thread it made', landed.thread && landed.launcher, JSON.stringify(landed));

  /* ---- on All there is no repo, so ＋ asks ---- */
  await openLauncher();
  await tapTab('all');
  started.length = 0;
  await evalJs(s, `document.querySelector('#ws-new')?.click()`);
  await sleep(300);
  const picker = await evalJs(
    s,
    `({
      open: document.querySelector('#ws-pick') ? !document.querySelector('#ws-pick').hidden : false,
      expanded: document.querySelector('#ws-new')?.getAttribute('aria-expanded') ?? null,
      repos: [...document.querySelectorAll('#ws-pick-row [data-ws]')].map((b) => b.dataset.ws),
    })`
  );
  check(
    '＋ on All asks which repo rather than going dead',
    picker.open && picker.repos.join(',') === WORKSPACES.join(','),
    JSON.stringify(picker)
  );
  check('and says it is open', picker.expanded === 'true', String(picker.expanded));
  check('nothing was started by the asking', started.length === 0, JSON.stringify(started));
  await shot('picker');

  await evalJs(s, `document.querySelector('#ws-pick-row [data-ws="deluvia"]')?.click()`);
  await sleep(1200);
  check(
    'picking one from there starts it in that repo',
    started.length === 1 && started[0]?.workspace === 'deluvia',
    JSON.stringify(started)
  );

  /* ---- an empty repo says so, and says how to fix it ---- */
  await openLauncher();
  await tapTab('deluvia');
  const empty = await evalJs(
    s,
    `({
      rows: document.querySelectorAll('#recent .console-row').length,
      label: document.querySelector('#recent-label')?.hidden,
      note: (document.querySelector('#recent .empty')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    })`
  );
  check(
    'a repo with no conversations says so and names ＋',
    empty.rows === 0 && empty.label === true && /deluvia/.test(empty.note) && /＋/.test(empty.note),
    JSON.stringify(empty)
  );

  /* ---- the retired per-device key is not read any anymore ----

     `beadcause.console.repo` was this page's own memory of which repo you were in, and
     the space picker replaced it with a value on the server. The key is deliberately
     *not* migrated: a tab tapped on one device last week is exactly what the selection
     stopped being, and reading it at startup would narrow the whole app — the
     notifications included — on the strength of it. So writing it must change nothing.
     A repo that has *left the config* is the server's problem now, and reconcileFilter
     is where it is solved — see test/spacebar.mjs. */
  await evalJs(s, `localStorage.setItem('beadcause.console.repo', 'a-repo-that-was-removed')`);
  await openLauncher();
  const recovered = await evalJs(s, TABS);
  check(
    'the retired per-device repo key is ignored — the picker owns the selection',
    recovered.find((t) => t.on)?.ws === 'deluvia',
    JSON.stringify(recovered.find((t) => t.on))
  );
  await tapTab('all');
  const widened = await evalJs(s, ROWS);
  check('and All is still the way back out to every repo', widened.length === COUNTS.all, String(widened.length));

  /* ---- opening one by id is untouched ---- */
  await s.send('Page.navigate', { url: `${BASE}/console?id=${THREAD.id}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#thread .msg')`)) break;
  }
  const byId = await evalJs(
    s,
    `({
      thread: !!document.querySelector('#thread .msg'),
      launcher: document.querySelector('#launcher').hidden,
      composer: !document.querySelector('#composer').hidden,
    })`
  );
  check(
    'opening a conversation by id still bypasses the launcher entirely',
    byId.thread && byId.launcher && byId.composer,
    JSON.stringify(byId)
  );
} finally {
  if (!KEEP) close();
  for (const res of parked) res.destroy();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
