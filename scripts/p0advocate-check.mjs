#!/usr/bin/env node
//
// The P0 card's one control, in a thumb — put an advocate on it, then go and see it.
//
//   node scripts/p0advocate-check.mjs [--baseline] [--out=<dir>]
//
// bc-d6yk. The server half is test/p0advocate.mjs: which live session is a P0's
// advocate, and the ten minutes where a launch has happened but no window has named
// itself yet. What that cannot reach is the half this feature actually *is* — a control
// on a card on a phone — and it can fail in three ways with every unit test passing:
//
//   • **The card must stop offering a launch the moment you make one.** The old card
//     kept the offer, so the honest second tap was a 409 and the window you had opened
//     was findable only from the advocate console. This has to hold *before* the next
//     poll, which is 25 seconds away.
//   • **The way in has to be a real link into `/session?pid=…`**, with the pid the
//     server named. A button that opened nothing, or a link built from the bead id,
//     would look identical on the card and go nowhere.
//   • **It must open over the inbox, not away from it.** public/drawer.js owns
//     `/session` links, and a control drawn outside that path — or a `location.href =`
//     — costs your place in the list to glance at a window. Asserted by driving it: the
//     drawer opens, the iframe points at the pid, and the tab underneath never
//     navigated.
//
// Same shape as endorse-check.mjs and its siblings: the real public/app.js in a headless
// Chrome the size of a phone, against fixtures served from this process, so it never
// touches a daemon, a bead or iTerm. `--baseline` serves the committed app.js, which
// has never heard of any of this, so it must fail.
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
const TOKEN = 'p0advocate-check-token';
const BASELINE = process.argv.includes('--baseline');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const BASELINED = ['/app.js', '/style.css'];
const committed = (rel) => execFileSync('git', ['-C', ROOT, 'show', `HEAD:${rel}`]);

/* ---------------------------------------------------------------- fixtures */

const WS = 'alpha';
const P0 = 'a-p0';
const PID = 4242;

const bead = (id, title) => ({
  id,
  title,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: 'A short brief, with nothing clever in it.',
});

// One question, and it hangs off the P0 — with a board on, the list below it is that
// P0's descendants and nothing else (`underOwnedP0s`), so a row that is not under one
// would leave the screen looking broken for a reason that has nothing to do with this.
const QUESTIONS = [{ ...toQuestion(WS, bead(`${P0}.1`, 'A child of the epic')), space: 'Work', comments: [] }];

/** The card, as `p0Card` in lib/server.js builds it. `advocate` is what this file drives. */
let advocate = null;
const board = () => ({
  owned: true,
  under: { [`${WS}/${P0}.1`]: P0 },
  p0s: [
    {
      key: `${WS}/${P0}`,
      workspace: WS,
      id: P0,
      title: 'Make the phone the whole interface',
      status: 'open',
      issue_type: 'epic',
      owners: ['adam'],
      open: 6,
      inFlight: 1,
      waitingOn: 'the endorsement queue, before anything else can move',
      advocate,
    },
  ],
});

/** Every write the page attempted, so "which endpoint, with what" is an assertion. */
const writes = [];

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const read = (fn) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => fn(JSON.parse(body || '{}')));
    };

    if (p === '/api/questions') {
      return json({
        questions: QUESTIONS,
        requests: [],
        workspaces: [WS],
        spaces: [{ name: 'Work', workspaces: [WS], quiet: false, muted: false, count: 1 }],
        filter: { space: 'all', workspace: 'all' },
        p0board: board(),
        summary: { sessions: 0, proposals: 0 },
        scope: 'human',
      });
    }
    // The launch. It answers exactly as the daemon does and opens nothing — what is
    // under test is what the card does either side of it.
    if (p === '/api/bead/advocate' && req.method === 'POST') {
      return void read((parsed) => {
        writes.push({ path: p, ...parsed });
        json({ workspace: parsed.workspace, id: parsed.id, opened: true, repo: null });
      });
    }
    if (p.startsWith('/api/')) {
      if (req.method === 'POST') return void read(() => json({}));
      return json({});
    }

    // `/session` is a page the daemon rewrites to session.html, and the drawer loads it
    // in an iframe. Served the same way here so the drawer has something real to open.
    const rel = p === '/' ? 'index.html' : p === '/session' ? 'session.html' : p.replace(/^\/+/, '');
    if (BASELINE && BASELINED.includes(`/${rel}`)) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] });
      return res.end(committed(`public/${rel}`));
    }
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return void res.writeHead(404).end('no');
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
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-p0advocate-');

const evalJs = async (expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

const waitFor = async (expr, ms = 8000) => {
  for (let i = 0; i < ms / 150; i++) {
    if (await evalJs(expr)) return true;
    await sleep(150);
  }
  return false;
};

const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `p0advocate-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/** The control, from outside — and where in the DOM it is, which decides whether it works. */
const CONTROL = `(() => {
  const el = document.querySelector('.p0-card .p0-advocate');
  return {
    there: !!el,
    tag: el?.tagName || '',
    act: el?.dataset?.act || '',
    href: el?.getAttribute('href') || '',
    disabled: !!el?.disabled,
    inList: !!el && el.closest('#list') !== null,
    text: (el?.textContent || '').replace(/\\s+/g, ' ').trim(),
  };
})()`;

const press = async (sel) => {
  const there = await evalJs(`document.querySelector(${JSON.stringify(sel)}) !== null`);
  if (there) await evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
  return there;
};

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width, height: VP.height, deviceScaleFactor: VP.dpr,
    mobile: true, screenWidth: VP.width, screenHeight: VP.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelector('.p0-card') !== null`, 15000);

  /* ---- nobody on it: the offer, exactly as it was ---- */

  let c = await evalJs(CONTROL);
  check('a P0 with nobody on it offers the launch', c.there && c.act === 'advocate', c.text);
  check('and the control is inside #list, so the tap is delegated to at all', c.inList);
  await shot('offered');

  /* ---- the tap, and what the card says before any poll comes back ---- */

  const tapped = await press('.p0-card .p0-advocate');
  await sleep(800);
  const sent = writes.filter((w) => w.path === '/api/bead/advocate').pop();
  check('tapping it reaches /api/bead/advocate', tapped && Boolean(sent));
  check('naming the workspace and the bead', sent?.workspace === WS && sent?.id === P0, JSON.stringify(sent || {}));

  c = await evalJs(CONTROL);
  check('the card stops offering a launch it has just made', c.there && c.act !== 'advocate', c.text);
  check('and says one is opening rather than going quiet', /opening/i.test(c.text), c.text);
  check('with nothing to press, because there is no pid yet', c.disabled);
  await shot('opening');

  /* ---- the window comes up: a way in ---- */

  // What the next sweep would carry once the session has renamed itself into something
  // `namesBead` can find (lib/epicadvocate.js).
  advocate = { pid: PID, name: `Beadcause - ${P0} the epic`, status: 'busy', at: null, opening: false };
  await press('#refresh');
  const linked = await waitFor(`document.querySelector('.p0-card a.p0-advocate') !== null`, 6000);
  c = await evalJs(CONTROL);
  check('once there is a window, the card is a way into it', linked && c.tag === 'A', c.text);
  check(`and it links to the pid the server named`, c.href === `/session?pid=${PID}`, c.href);
  check('the link is still inside #list', c.inList);
  await shot('linked');

  /* ---- and it opens over the inbox rather than away from it ---- */

  const where = await evalJs(`location.pathname + location.search`);
  await press('.p0-card a.p0-advocate');
  const drawn = await waitFor(`document.querySelector('.drawer-wrap.open') !== null`, 6000);
  const frame = await evalJs(`document.querySelector('.drawer-frame')?.getAttribute('src') || ''`);
  const stillHere = await evalJs(`location.pathname + location.search`);
  check('tapping it opens the drawer', drawn);
  check('pointed at the session', frame.includes(`/session?pid=${PID}`), frame);
  check('and the inbox underneath never navigated', stillHere === where, `${where} → ${stillHere}`);
  check('the P0 card is still there behind it', await evalJs(`document.querySelector('.p0-card') !== null`));
  await shot('drawer');
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
