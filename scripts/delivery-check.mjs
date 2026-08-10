#!/usr/bin/env node
//
// Can you decide a merge, and adjust a bead, from a phone?
//
//   node scripts/delivery-check.mjs [--baseline] [--keep] [--out=<dir>]
//
// Two surfaces, one harness, because they are the two places where a tap now
// writes something new: the delivery card, whose answer merges a pull request into
// main, and the ✎ on a proposal row, whose answer files a bead in your words rather
// than an agent's.
//
// Both are checked the same way and for the same reason as scripts/proposal-check.mjs:
// the real public/app.js, in a headless Chrome the size of a phone, against a
// fixture built by lib/delivery.js and parsed back by lib/decision.js — so the
// fixture is a real round trip and nothing here touches a bead, a repo or GitHub.
// The `gh` half is a stubbed /api/pr, which is the boundary the app actually sees.
//
// `--baseline` serves HEAD's app.js and style.css instead of the working copy, so a
// failure here can be told apart from a flake — it is HEAD of *this* worktree, so it
// answers "did my uncommitted change break this", not "did this branch". Against a
// main that has no delivery card at all, every case in the first four groups fails
// at once, which is what it should look like.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { deliveryBody, deliveryTitle } from '../lib/delivery.js';
import { proposalBody, proposalTitle } from '../lib/proposal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'delivery-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(2);
}
if (!fs.existsSync(path.join(PUBLIC, 'vendor', 'marked.js'))) {
  // A fresh worktree has no public/vendor — it is gitignored and built. Without it
  // the app throws on its first markdown render and the list never appears, which
  // looks exactly like a bug in whatever you just changed.
  console.error('public/vendor is missing — run `npm run vendor` first');
  process.exit(2);
}

/* ---------------------------------------------------------------- fixtures */

const WS = 'demo';

// A delivery whose summary is a bulleted list, because that is what a session
// actually writes and a list rendered as one run-on line is a list you skip.
const DELIVERY = {
  workspace: WS,
  bead: 'dc-work',
  repo: 'someone/demo',
  number: 42,
  url: 'https://github.com/someone/demo/pull/42',
  branch: 'bead/dc-work-cache-bust',
  base: 'main',
  method: 'squash',
  title: 'Cache-bust site.js on deploy',
  summary: [
    'The script tag now carries a `?v=` built from the file hash:',
    '',
    '- the hash comes from the file, not the clock',
    '- an unreloaded browser gets the new file on its next navigation',
  ].join('\n'),
  tests: 'npm test — 281 passing',
  risk: 'The template is stamped at build time, so a dev server without a build step serves no query string at all.',
  left: 'The android asset pipeline still hard-codes its own path.',
};

const issue = (id, title, description, extra = {}) => ({
  id,
  title,
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-09T10:00:00Z',
  updated_at: '2026-08-09T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description,
  ...extra,
});

// With a deploy declared, which is the four-button card — the widest this ever gets,
// and the one worth looking at on a 393px screen. `deployHint` is what a real
// `beadcause-deliver` would have passed, verbatim.
const DELIVERY_Q = {
  ...toQuestion(
    WS,
    issue(
      'dc-pr',
      deliveryTitle(DELIVERY),
      deliveryBody(DELIVERY, { context: '**7 files**, +210 −33.', ship: 'runs `launchctl` · rebuilds apk · restarts beadcause' })
    )
  ),
  comments: [],
};

// Two beads, so "adjust one and leave the other alone" is checkable.
const BEADS = [
  {
    title: 'Cache-bust site.js on deploy',
    type: 'task',
    priority: 3,
    description: 'The script tag carries no `?v=`, so a shipped change looks absent.',
    acceptance: 'A deploy changes the URL of the script.',
    design: '',
    notes: '',
    rationale: 'Every deploy so far has needed a "hard-reload it" message afterwards.',
    labels: ['deploy'],
    deps: [],
  },
  {
    title: 'Drop the unused qr dependency',
    type: 'chore',
    priority: 4,
    description: 'Nothing imports it since the pairing screen moved.',
    acceptance: '',
    design: '',
    notes: '',
    rationale: '',
    labels: [],
    deps: [],
  },
];

const PROPOSAL_Q = {
  ...toQuestion(WS, issue('dc-prop', proposalTitle(WS, BEADS), proposalBody(WS, BEADS))),
  comments: [],
};

const QUESTIONS = [DELIVERY_Q, PROPOSAL_Q];
const PR_KEY = DELIVERY_Q.key;
const PROP_KEY = PROPOSAL_Q.key;

if (!DELIVERY_Q.delivery) {
  console.error('the fixture did not parse back into a delivery — lib/delivery.js changed shape');
  process.exit(1);
}
if (!PROPOSAL_Q.proposal?.beads?.length) {
  console.error('the fixture did not parse back into a proposal — lib/proposal.js changed shape');
  process.exit(1);
}

/**
 * What `/api/pr` would say, in the three states worth drawing differently.
 *
 * Swapped between assertions by writing `prState`, so the card is checked against a
 * *changing* GitHub rather than one frozen shape — which is the whole reason the
 * live half is fetched separately in the first place.
 */
const PR_STATES = {
  clean: {
    number: 42,
    url: DELIVERY.url,
    title: DELIVERY.title,
    state: 'OPEN',
    draft: false,
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    branch: DELIVERY.branch,
    base: 'main',
    additions: 210,
    deletions: 33,
    files: 7,
    checks: { total: 3, passing: 3, failing: 0, pending: 0, failed: [], state: 'passing' },
    reviewDecision: null,
    mergedAt: null,
    mergeCommit: null,
  },
  failing: null,
  conflicting: null,
  noChecks: null,
};
PR_STATES.failing = {
  ...PR_STATES.clean,
  checks: { total: 3, passing: 2, failing: 1, pending: 0, failed: ['build'], state: 'failing' },
};
PR_STATES.conflicting = { ...PR_STATES.clean, mergeable: 'CONFLICTING' };
PR_STATES.noChecks = {
  ...PR_STATES.clean,
  checks: { total: 0, passing: 0, failing: 0, pending: 0, failed: [], state: 'none' },
};

let prState = 'clean';
// Every /api/respond the page sends, so "the button promised X" can be checked
// against what actually went on the wire — which is the only thing the server sees.
const posted = [];

/* ------------------------------------------------------------------ server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const committed = (f) => execFileSync('git', ['show', `HEAD:public/${f}`], { cwd: ROOT });

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (p === '/api/questions') {
      return json({ questions: QUESTIONS, workspaces: [WS], spaces: [], scope: 'human' });
    }
    if (p === '/api/question') {
      const q = QUESTIONS.find((x) => x.id === url.searchParams.get('id'));
      return q ? json(q) : json({ error: 'not found' });
    }
    if (p === '/api/pr') {
      return json({ delivery: DELIVERY_Q.delivery, pr: PR_STATES[prState], unavailable: null });
    }
    if (p === '/api/respond') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        try {
          posted.push(JSON.parse(body));
        } catch {
          posted.push({ unparsed: body });
        }
        json({ ok: true, closed: true, created: [], declined: [] });
      });
    }
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && (p === '/app.js' || p === '/style.css')) {
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] });
      return res.end(committed(p.slice(1)));
    }
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------ chrome */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-delivery-'));
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
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 160)}`);
  return r.result.value;
};

/* ------------------------------------------------------------------- probe */

const CARD = (key) => `document.querySelector('.card[data-key=${JSON.stringify(key)}]')`;
const DELIV = `document.querySelector('.delivery')`;

/** Everything the delivery block is currently saying, read off the DOM as it is. */
const PR_VIEW = `(() => {
  const d = ${DELIV};
  if (!d) return null;
  const go = d.querySelector('.pr-merge');
  return {
    link: d.querySelector('.pr-link')?.getAttribute('href') || '',
    num: d.querySelector('.pr-num')?.textContent.trim() || '',
    branch: d.querySelector('.pr-branch')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    chips: [...d.querySelectorAll('.pr-chip')].map((c) => ({
      text: c.textContent.replace(/\\s+/g, ' ').trim(),
      cls: [...c.classList].filter((x) => x !== 'pr-chip').join(','),
    })),
    merge: go ? { text: go.textContent.replace(/\\s+/g, ' ').trim(), disabled: go.disabled } : null,
    ship: (() => {
      const b = d.querySelector('.pr-ship');
      if (!b) return null;
      return {
        text: b.textContent.replace(/\\s+/g, ' ').trim(),
        what: b.querySelector('.pr-ship-what')?.textContent.trim() || '',
        disabled: b.disabled,
        right: Math.round(b.getBoundingClientRect().right),
        // Two lines is the design. One would wrap into a paragraph at this width.
        lines: Math.round(b.getBoundingClientRect().height / parseFloat(getComputedStyle(b).fontSize)),
      };
    })(),
    buttons: [...d.querySelectorAll('[data-act]')].map((b) => b.dataset.act),
    width: Math.round(d.getBoundingClientRect().width),
    right: Math.round(d.getBoundingClientRect().right),
  };
})()`;

const ROW = (n) => `document.querySelector('.prop-row[data-idx="${n}"]')`;

const ROW_VIEW = (n) => `(() => {
  const row = ${ROW(n)};
  if (!row) return null;
  return {
    title: row.querySelector('.prop-title')?.textContent.trim() || '',
    pills: [...row.querySelectorAll('.prop-meta .pill')].map((p) => p.textContent.trim()),
    adjusted: !!row.querySelector('.pill.adjusted'),
    editing: row.classList.contains('is-editing'),
    yes: row.querySelector('.prop-btn.yes')?.getAttribute('aria-pressed'),
    fields: [...row.querySelectorAll('[data-role="edit-field"]')].map((f) => f.dataset.field),
    right: Math.round(row.getBoundingClientRect().right),
  };
})()`;

const setField = (key, n, field, value) => `(() => {
  const el = document.querySelector('[data-role="edit-field"][data-key=${JSON.stringify(key)}][data-idx="${n}"][data-field="${field}"]');
  if (!el) return false;
  el.value = ${JSON.stringify(String(value))};
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return true;
})()`;

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launch();

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

  console.log(
    `\n${BASELINE ? 'BASELINE (HEAD:public/app.js + style.css)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`
  );

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('.card[data-key]')`)) break;
  }
  if (!(await evalJs(s, `!!document.querySelector('.card[data-key]')`))) throw new Error('the list never rendered');

  /* ---------------------------------------------------- 1. the delivery card */

  console.log('\nthe pull request, before you decide anything\n');

  // The live half arrives after the card; give the fetch a beat to land.
  await sleep(700);
  let v = await evalJs(s, PR_VIEW);

  check('the card draws at all', !!v, v ? `#${v.num}` : 'no .delivery block');
  check('it links to the real PR', v?.link === DELIVERY.url, v?.link);
  check(
    'it names both branches, so you know what is going where',
    /bead\/dc-work-cache-bust/.test(v?.branch || '') && /main/.test(v?.branch || ''),
    v?.branch
  );
  check(
    'the summary the session wrote is on the card, as a list',
    (await evalJs(s, `${CARD(PR_KEY)}.querySelectorAll('li').length`)) >= 2,
    `${await evalJs(s, `${CARD(PR_KEY)}.querySelectorAll('li').length`)} list item(s)`
  );

  const chipText = (v?.chips || []).map((c) => c.text).join(' | ');
  check('the diffstat is live, from gh and not from the bead', /7 files/.test(chipText) && /\+210/.test(chipText), chipText);
  check(
    'passing checks are counted and coloured',
    v?.chips.some((c) => /3 checks passing/.test(c.text) && c.cls === 'good'),
    chipText
  );
  check(
    'all four actions are offered, in a repo that has a deploy',
    ['pr-merge', 'pr-ship', 'pr-changes', 'pr-decline'].every((a) => v?.buttons.includes(a)),
    (v?.buttons || []).join(', ')
  );
  check('the block stays inside the phone', (v?.right ?? 999) <= VP.width, `right edge ${v?.right}px of ${VP.width}px`);
  // Four is the ceiling this card was told to respect. The failure it is protecting
  // against is not "the button is missing" — it is four full-width buttons pushing the
  // card into a menu, or the ship hint wrapping into a paragraph nobody reads.
  check(
    'Ship says what it will actually do, on its own second line',
    /restarts beadcause/.test(v?.ship?.what || ''),
    v?.ship?.what
  );
  check('and it stays inside the phone too', (v?.ship?.right ?? 999) <= VP.width, `right edge ${v?.ship?.right}px`);
  check(
    'in two lines, not a paragraph',
    (v?.ship?.lines ?? 99) <= 3,
    `${v?.ship?.lines} line-heights tall — "${v?.ship?.text}"`
  );

  /* --------------------------------------------- 2. what gh says changes it */

  console.log('\nand what GitHub says changes what it offers\n');

  const reload = async (state) => {
    prState = state;
    // Drop the cached live half and re-render, the way re-opening the app would.
    await evalJs(s, `location.reload()`);
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      if (await evalJs(s, `!!${DELIV}`)) break;
    }
    await sleep(700);
    return evalJs(s, PR_VIEW);
  };

  v = await reload('failing');
  check(
    'a failing check is named, not just counted',
    v?.chips.some((c) => /1 check failing: build/.test(c.text) && c.cls === 'bad'),
    (v?.chips || []).map((c) => c.text).join(' | ')
  );
  check(
    'but a red check does not disable merge — a flake is your call, not the app’s',
    v?.merge && !v.merge.disabled,
    `disabled=${v?.merge?.disabled}`
  );

  v = await reload('conflicting');
  check(
    'a conflict does disable it, and the button says why',
    v?.merge?.disabled === true && /conflicts with main/.test(v.merge.text),
    v?.merge?.text
  );

  v = await reload('noChecks');
  check(
    'no CI is not the same as green — it says "no checks", quietly',
    v?.chips.some((c) => c.text === 'no checks' && c.cls === 'quiet') &&
      !v.chips.some((c) => c.cls === 'good' && /passing/.test(c.text)),
    (v?.chips || []).map((c) => `${c.text}[${c.cls}]`).join(' | ')
  );

  /* ------------------------------------------------------- 3. merging it */

  console.log('\nmerging takes two taps, and says what it sent\n');

  v = await reload('clean');
  posted.length = 0;
  await evalJs(s, `${DELIV}.querySelector('[data-act="pr-merge"]').click()`);
  await sleep(300);
  const armed = await evalJs(s, PR_VIEW);
  check(
    'one tap arms rather than merges',
    posted.length === 0 && /Tap again to confirm/.test(armed?.merge?.text || ''),
    `${posted.length} request(s) sent, button "${armed?.merge?.text}"`
  );

  await evalJs(s, `${DELIV}.querySelector('[data-act="pr-merge"]').click()`);
  await sleep(600);
  check('the second tap sends it', posted.length === 1, `${posted.length} request(s)`);
  check(
    'and it carries the MERGE: marker, which is the whole of the consent',
    /^MERGE:/.test(posted[0]?.response || ''),
    JSON.stringify(posted[0]?.response || '').slice(0, 90)
  );
  check(
    'the marker names the PR and the bead it closes',
    /#42/.test(posted[0]?.response || '') && /dc-work/.test(posted[0]?.response || ''),
    posted[0]?.response
  );

  /* -------------------------------------------------- 3b. shipping is the wider one */

  console.log('\nand shipping is the same two taps, with a different word\n');

  v = await reload('clean');
  posted.length = 0;
  await evalJs(s, `${DELIV}.querySelector('[data-act="pr-ship"]').click()`);
  await sleep(300);
  const shipArmed = await evalJs(s, PR_VIEW);
  check(
    'one tap arms rather than deploys',
    posted.length === 0 && /Tap again to confirm/.test(shipArmed?.ship?.text || ''),
    `${posted.length} request(s) sent, button "${shipArmed?.ship?.text}"`
  );
  check(
    'and arming ship does not arm merge — they are one tap apart and not the same act',
    !/Tap again to confirm/.test(shipArmed?.merge?.text || ''),
    shipArmed?.merge?.text
  );

  await evalJs(s, `${DELIV}.querySelector('[data-act="pr-ship"]').click()`);
  await sleep(600);
  check('the second tap sends it', posted.length === 1, `${posted.length} request(s)`);
  check(
    'and it carries SHIP:, never MERGE: — the one is not a longer spelling of the other',
    /^SHIP:/.test(posted[0]?.response || ''),
    JSON.stringify(posted[0]?.response || '').slice(0, 90)
  );
  check(
    'naming the PR and the repo it will deploy',
    /#42/.test(posted[0]?.response || '') && /deploy demo/.test(posted[0]?.response || ''),
    posted[0]?.response
  );

  v = await reload('conflicting');
  check(
    'a conflict disables ship as well as merge — a PR GitHub will not take is not one to ship',
    v?.ship?.disabled === true,
    `disabled=${v?.ship?.disabled}`
  );

  /* ------------------------------------------- 4. asking for changes is prose */

  console.log('\nasking for changes is a sentence, not a button\n');

  v = await reload('clean');
  posted.length = 0;
  await evalJs(s, `${DELIV}.querySelector('[data-act="pr-changes"]').click()`);
  await sleep(600);

  check(
    'it opens the card and puts you in the box instead of answering',
    posted.length === 0 && (await evalJs(s, `!!document.querySelector('.card.open [data-role="answer"]')`)),
    `${posted.length} request(s) sent`
  );
  check(
    'and the button over that box says what it will do',
    /Request changes/.test(await evalJs(s, `document.querySelector('.card.open [data-act="answer"]').textContent.trim()`)),
    await evalJs(s, `document.querySelector('.card.open [data-act="answer"]').textContent.trim()`)
  );

  await evalJs(
    s,
    `(() => {
      const box = document.querySelector('.card.open [data-role="answer"]');
      box.value = 'The hash should come from the built file, not the source.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.card.open [data-act="answer"]').click();
    })()`
  );
  await sleep(700);
  check(
    'typed prose travels with the CHANGES: marker',
    /^CHANGES: /.test(posted[0]?.response || ''),
    JSON.stringify(posted[0]?.response || '').slice(0, 90)
  );
  check(
    'and the note itself is kept verbatim, for the session that reads it next',
    /built file, not the source/.test(posted[0]?.response || ''),
    posted[0]?.response?.slice(0, 80)
  );
  check(
    'no free-text answer can ever merge anything — that needs the button',
    !/^MERGE:/.test(posted[0]?.response || ''),
    'prose fails towards "not merged"'
  );

  /* ------------------------------------------- 4b. declining, with direction */

  console.log('\ndeclining is two steps, and the direction is optional\n');

  v = await reload('clean');
  posted.length = 0;
  await evalJs(s, `${DELIV}.querySelector('[data-act="pr-decline"]').click()`);
  await sleep(600);

  check(
    'the first tap sends nothing — it opens the panel instead',
    posted.length === 0 && (await evalJs(s, `!!document.querySelector('.pr-decline')`)),
    `${posted.length} request(s) sent`
  );
  check(
    'and the panel says what declining does that requesting changes does not',
    /back in the queue/.test(await evalJs(s, `document.querySelector('.pr-decline').textContent`)) &&
      /abandoned/.test(await evalJs(s, `document.querySelector('.pr-decline').textContent`)),
    'names the abandoned branch and the requeued bead'
  );
  check(
    'the three ordinary buttons are gone while you are declining',
    !(await evalJs(s, `!!${DELIV}.querySelector('[data-act="pr-merge"]')`)),
    'merge is not reachable mid-decline'
  );
  check(
    'the box below is relabelled for the direction, and says it is optional',
    /Optional/.test(await evalJs(s, `document.querySelector('.card.open [data-role="answer"]').placeholder`)),
    await evalJs(s, `document.querySelector('.card.open [data-role="answer"]').placeholder`)
  );

  // Cancel has to actually cancel — a decline you backed out of must leave merge
  // exactly where it was.
  await evalJs(s, `document.querySelector('[data-act="pr-decline-cancel"]').click()`);
  await sleep(400);
  check(
    'cancelling puts the three buttons back and sends nothing',
    posted.length === 0 && (await evalJs(s, `!!${DELIV}.querySelector('[data-act="pr-merge"]')`)),
    `${posted.length} request(s) sent`
  );

  // With direction.
  await evalJs(s, `${DELIV}.querySelector('[data-act="pr-decline"]').click()`);
  await sleep(500);
  await evalJs(
    s,
    `(() => {
      const box = document.querySelector('.card.open [data-role="answer"]');
      box.value = 'Do it in the poller, not the router — the router cannot see the workspace.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.pr-decline [data-act="pr-decline-go"]').click();
    })()`
  );
  await sleep(700);
  check(
    'confirming sends the DECLINE: marker',
    /^DECLINE: /.test(posted[0]?.response || ''),
    JSON.stringify(posted[0]?.response || '').slice(0, 90)
  );
  check(
    'and carries the direction verbatim, which is the whole point of it',
    /poller, not the router/.test(posted[0]?.response || ''),
    posted[0]?.response?.slice(0, 80)
  );

  // Without direction — an empty box is a complete answer here, unlike changes.
  v = await reload('clean');
  posted.length = 0;
  await evalJs(s, `${DELIV}.querySelector('[data-act="pr-decline"]').click()`);
  await sleep(500);
  await evalJs(s, `document.querySelector('.pr-decline [data-act="pr-decline-go"]').click()`);
  await sleep(700);
  check(
    'a decline with an empty box still goes — the direction is optional',
    /^DECLINE: /.test(posted[0]?.response || ''),
    posted[0]?.response
  );

  /* ------------------------------------------------------------ 5. adjusting */

  console.log('\nadjusting a proposed bead before it exists\n');

  await evalJs(s, `location.reload()`);
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!${CARD(PROP_KEY)}`)) break;
  }
  await evalJs(s, `${CARD(PROP_KEY)}.querySelector('[data-act="toggle"]').click()`);
  await sleep(500);

  let r1 = await evalJs(s, ROW_VIEW(1));
  check('a proposal row offers a third control', !!(await evalJs(s, `!!${ROW(1)}.querySelector('.prop-btn.edit')`)), '✓ ✎ ✕');
  check('which is not pressed to begin with', r1?.editing === false, `editing=${r1?.editing}`);

  await evalJs(s, `${ROW(1)}.querySelector('.prop-btn.edit').click()`);
  await sleep(400);
  r1 = await evalJs(s, ROW_VIEW(1));

  check('tapping ✎ opens the editor', r1?.editing === true, `editing=${r1?.editing}`);
  check(
    'and approves the row, because adjusting is the strongest way of saying you want it',
    r1?.yes === 'true',
    `approved=${r1?.yes}`
  );
  check(
    'the five things worth changing are all there',
    ['title', 'description', 'acceptance', 'type', 'priority'].every((f) => r1?.fields.includes(f)),
    (r1?.fields || []).join(', ')
  );
  check('the editor stays inside the phone', (r1?.right ?? 999) <= VP.width, `right edge ${r1?.right}px of ${VP.width}px`);

  await evalJs(s, setField(PROP_KEY, 1, 'title', 'Cache-bust site.js — and the stylesheet too'));
  await evalJs(s, setField(PROP_KEY, 1, 'priority', '1'));
  await sleep(300);
  r1 = await evalJs(s, ROW_VIEW(1));
  check('the row heading follows what you typed', /and the stylesheet too/.test(r1?.title || ''), r1?.title);
  check('and the row says it has been adjusted', r1?.adjusted === true, `flag=${r1?.adjusted}`);

  // The one that matters most: a background poll must not eat a rewrite.
  await evalJs(s, `window.beadcause?.refresh?.() || fetch('/api/questions')`);
  await sleep(800);
  r1 = await evalJs(s, ROW_VIEW(1));
  check(
    'a refresh does not throw your rewrite away',
    /and the stylesheet too/.test(r1?.title || ''),
    r1?.title?.slice(0, 60)
  );

  const r2 = await evalJs(s, ROW_VIEW(2));
  check('the bead you did not touch is untouched', r2?.adjusted === false && /qr dependency/.test(r2?.title || ''), r2?.title);

  /* -------------------------------------------- 6. what the edits ride on */

  console.log('\nand what gets sent when you press create\n');

  posted.length = 0;
  await evalJs(s, `${ROW(2)}.querySelector('.prop-btn.no').click()`);
  await sleep(200);
  await evalJs(s, `document.querySelector('.prop-go').click()`);
  await sleep(300);
  await evalJs(s, `document.querySelector('.prop-go').click()`);
  await sleep(700);

  const sent = posted[0] || {};
  check('the create names only the bead you approved', JSON.stringify(sent.create) === '[1]', JSON.stringify(sent.create));
  check(
    'the rewrite rides with it, keyed by the number you were looking at',
    /and the stylesheet too/.test(sent.edits?.['1']?.title || ''),
    JSON.stringify(sent.edits || null).slice(0, 100)
  );
  check('including the priority you changed', sent.edits?.['1']?.priority === 1, `P${sent.edits?.['1']?.priority}`);
  check(
    'and the declined bead sends no edits at all',
    !sent.edits?.['2'],
    Object.keys(sent.edits || {}).join(',') || 'none'
  );
  check('the sentence says the count too, for the record it leaves', /adjusted/.test(sent.response || ''), sent.response);

  /* ------------------------------------------------------------ screenshots */

  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    prState = 'failing';
    await evalJs(s, `location.reload()`);
    await sleep(1500);
    await evalJs(s, `${DELIV}?.scrollIntoView({ block: 'center' })`);
    await sleep(300);
    const shot = await s.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, 'delivery.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`\n  → ${file}`);
  }

  if (KEEP) {
    console.log(`\n  serving at ${BASE}/?t=${TOKEN} — ctrl-c to stop\n`);
    await new Promise(() => {});
  }
} finally {
  if (!KEEP) {
    close();
    server.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
