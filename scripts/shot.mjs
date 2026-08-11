#!/usr/bin/env node
//
// A picture of the running app, for an agent that has only ever read the source.
//
//   node scripts/shot.mjs [path] [--desktop] [--full] [--wait SEL] [--settle MS]
//                         [--out FILE] [--base URL] [--strict]
//
// Almost everything in flight in this repo is visual — how the graph fits a phone,
// where a card lands after it reflows, whether a pane collapses — and until now the
// agent that wrote it shipped it unseen. This renders a page of the running daemon
// to a PNG that the agent can then Read, which is a capability it already has.
//
// Four things about it are deliberate, and each of them is a bug that was going to
// happen otherwise:
//
//   - THE PHONE IS THE DEFAULT. beadcause is a phone app. A 1280px shot is a shot of
//     the one layout nobody uses, and it hides the exact failures worth catching.
//     `--desktop` when the bug is specifically a wide-window one.
//   - THE TOKEN IS NEVER ON THE COMMAND LINE, AND NEVER IN THE OUTPUT. It comes from
//     loadConfig(), goes into localStorage before the page's own scripts run, and —
//     because localStorage rides on no navigation, so a *document* request carrying
//     no credential is bounced to sign-in — onto the URL as `?t=` as well. Agent shell
//     commands and agent stdout both get echoed into transcripts, quoted into beads
//     and read on a phone; a secret that reaches the screen once needs rotating. So
//     the URL this navigates with and the URL it prints are two different strings:
//     see URL_TO_SHOOT and URL_SHOWN. They were one string for a while, which put the
//     live token in the log of every screenshot ever taken (bc-sqab).
//   - IT WAITS FOR load, NEVER FOR AN IDLE NETWORK. The app holds a WebSocket open
//     for live updates, so the network is never idle and an idle-wait would time out
//     on every page that rendered perfectly.
//   - CONSOLE ERRORS ARE OUTPUT, NOT DECORATION. A screenshot shows you a blank
//     panel; it does not show you the 401 behind it, and that is precisely the case
//     where a picture on its own actively misleads. Errors, page exceptions, failed
//     requests and any response >= 400 are collected, deduped, and printed under the
//     path of the PNG.
//
// It drives a headless Chrome over the DevTools protocol on Node's global WebSocket,
// the same way scroll-check.mjs and its siblings already do, so it adds no
// dependency and no downloaded browser. Chrome is looked up in the usual places and
// can be pointed at with CHROME_PATH.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------- the chrome */

// The one hardcoded path the other check scripts use, plus the places Chrome
// actually lives when it is not there. CHROME_PATH wins, because the honest answer
// to "it moved" is to let the caller say where it went rather than to ship a browser.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/opt/homebrew/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const findChrome = () => CHROME_CANDIDATES.find((c) => fs.existsSync(c)) || null;

/* ----------------------------------------------------------------- the cli */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

// Flags that take a value, so the value cannot later be mistaken for the path.
const VALUED = ['out', 'wait', 'settle', 'base', 'width', 'height'];
const claimed = new Set();
for (const name of VALUED) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) claimed.add(i + 1);
}

// Accepts both `--out F` and `--out=F`. An agent composing this from a bead will
// write whichever it happens to remember, and being wrong about it should not cost
// a round trip.
function opt(name, fallback = null) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

const positional = argv.filter((a, i) => !a.startsWith('--') && !claimed.has(i));

if (flag('help') || flag('h')) {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log(src.split('\n').slice(1, 7).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

const cfg = loadConfig();
const BASE = (opt('base') || `http://127.0.0.1:${cfg.port}`).replace(/\/+$/, '');
const TARGET = positional[0] || '/';
const URL_TO_SHOOT = (() => {
  const raw = /^https?:/.test(TARGET) ? TARGET : `${BASE}${TARGET.startsWith('/') ? '' : '/'}${TARGET}`;
  // The token on the URL as well as in localStorage, and it is not belt-and-braces:
  // with Google sign-in configured, a *document* request carrying no credential is
  // answered with a redirect to the login page (lib/server.js), and localStorage is
  // injected too late to matter — it rides on no navigation at all. So this headless
  // Chrome presents the token the way every other non-browser caller does, and
  // photographs the page rather than the login screen.
  //
  // Only ever added to this daemon's own address. A `--base` pointing somewhere else
  // is somebody shooting a different site, and the token is not theirs to receive.
  try {
    const u = new URL(raw);
    if (cfg.token && raw.startsWith(BASE) && !u.searchParams.has('t')) u.searchParams.set('t', cfg.token);
    return u.toString();
  } catch {
    return raw;
  }
})();

// What the report prints. The token above is a credential — it is what guards the
// daemon over the tailnet — and this script's whole output goes into an agent's
// transcript, so printing the URL verbatim writes it into every session log of every
// screenshot ever taken. The value is masked rather than dropped so the line still
// says a token was presented, which is the difference between "the page needed no
// credential" and "the page got one" when you are reading back why a shot came out
// as the login screen.
const URL_SHOWN = (() => {
  try {
    const u = new URL(URL_TO_SHOOT);
    if (u.searchParams.has('t')) u.searchParams.set('t', 'redacted');
    return u.toString();
  } catch {
    return URL_TO_SHOOT;
  }
})();

// iPhone 14 Pro, the device the other check scripts emulate, so a shot and a check
// are describing the same pixels. Desktop is a plain 2x laptop window.
const PHONE = { width: 390, height: 844, dpr: 3, mobile: true };
const DESKTOP = { width: 1280, height: 900, dpr: 2, mobile: false };
const VP = { ...(flag('desktop') ? DESKTOP : PHONE) };
if (opt('width')) VP.width = Number(opt('width'));
if (opt('height')) VP.height = Number(opt('height'));

const FULL = flag('full');
const STRICT = flag('strict');
const WAIT_SEL = opt('wait');
// `load` fires when the document is there, not when the app has finished asking the
// tracker what to draw, so every shot waits a beat past it. Pages that fan out over
// every workspace need more than a beat: that is what --wait and --settle are for.
const SETTLE = Number(opt('settle', FULL ? 2000 : 1200));

// `.claude/shots/` rather than anywhere in the tree the app serves: a PNG of the
// inbox is a picture of real beads, and it has no business being committed or
// fetchable. Gitignored for the same reason.
const SHOT_DIR = path.join(ROOT, '.claude', 'shots');
const slug =
  (TARGET.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'index').slice(0, 48);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const OUT = path.resolve(opt('out') || path.join(SHOT_DIR, `${slug}-${stamp}.png`));

/* ------------------------------------------------------------------ driver */

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.method) {
        for (const fn of listeners) fn(msg.method, msg.params);
        return;
      }
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
        on: (fn) => listeners.push(fn),
        close: () => ws.close(),
      });
  });
}

async function launch(chrome) {
  // Derived from the pid so two agents shooting at the same moment do not fight over
  // one debugging port — which they will, because concurrent agents are the point.
  const port = 9600 + (process.pid % 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-shot-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Offscreen renderers are throttled to about a frame a second, which is plenty
      // to photograph a half-drawn graph and file it as a layout bug.
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
  if (!target) {
    proc.kill();
    throw new Error('Chrome never exposed a page target');
  }
  const s = await connect(target.webSocketDebuggerUrl);
  return {
    s,
    close: () => {
      try {
        s.close();
      } catch {
        /* already gone */
      }
      proc.kill();
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Chrome is still letting go of a temp dir */
      }
    },
  };
}

/* --------------------------------------------------------- what went wrong */

// Deduped by the text, because one broken fetch inside a render loop says the same
// thing forty times and a wall of it buries the other three problems.
const problems = new Map();
const note = (kind, text) => {
  if (!text) return;
  const key = `${kind} ${text}`;
  problems.set(key, { kind, text, n: (problems.get(key)?.n || 0) + 1 });
};

// Set when the main document itself never arrived. Chrome renders its own error page
// and the protocol reports no error at all, so without this a shot of "This site
// can't be reached" exits 0 and reads to an agent as a page that rendered.
let docFailed = null;

const partText = (a) =>
  a.value ?? a.description ?? (a.preview ? a.preview.description : null) ?? a.unserializableValue ?? '';

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

function watch(s) {
  s.on((method, p) => {
    if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      note('console.error', (p.args || []).map(partText).filter(Boolean).join(' ').trim().slice(0, 300));
    } else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      note('pageerror', (d.exception?.description || d.text || 'uncaught exception').split('\n')[0].slice(0, 300));
    } else if (method === 'Network.loadingFailed') {
      // A cancelled request is the app tidying up after itself, not a failure.
      if (!p.canceled) {
        note('request failed', `${p.errorText} (${p.type || 'request'})`);
        if (p.type === 'Document') docFailed = p.errorText;
      }
    } else if (method === 'Network.responseReceived' && p.response.status >= 400) {
      note('http', `${p.response.status} ${pathOf(p.response.url)}`);
    }
  });
}

/* ------------------------------------------------------------------- shoot */

async function fullClip(s) {
  const m = await s.send('Page.getLayoutMetrics');
  const c = m.cssContentSize || m.contentSize;
  return { x: 0, y: 0, width: Math.ceil(c.width), height: Math.ceil(c.height), scale: 1 };
}

async function capture(s) {
  // Without the explicit clip, a full-page capture of a document taller than the
  // viewport is clipped to the viewport anyway, which looks exactly like --full
  // silently not working.
  const r = await s.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: FULL,
    ...(FULL ? { clip: await fullClip(s) } : {}),
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(r.data, 'base64'));
}

/* --------------------------------------------------------------------- run */

const chrome = findChrome();
if (!chrome) {
  console.error('No Chrome found. Looked in:\n  ' + CHROME_CANDIDATES.join('\n  ') + '\nSet CHROME_PATH to point at one.');
  process.exit(1);
}

const { s, close } = await launch(chrome);
let failure = null;

try {
  watch(s);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Network.enable');

  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: VP.mobile,
    screenWidth: VP.width,
    screenHeight: VP.height,
  });
  // maxTouchPoints is validated as 1..16 even when disabling, so it stays at 5 and
  // `enabled` is the only thing that moves. Passing 0 with enabled:false is what an
  // honest reading of the protocol suggests, and it is a hard error.
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: VP.mobile, maxTouchPoints: 5 });
  await s.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  // Pinned so two shots taken a week apart differ only where the app does: the app
  // follows the system scheme, and an animation caught mid-flight is a diff every
  // single time.
  await s.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: 'dark' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  if (VP.mobile) {
    await s.send('Network.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    });
  }

  // The pairing step. This runs before any of the page's own scripts, on every
  // document, so the app finds itself already paired and never draws the setup
  // dialog over the thing we came to photograph. The try/catch is for opaque
  // origins (about:blank), where touching localStorage throws.
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('beadcause.token', ${JSON.stringify(cfg.token || '')}); } catch (e) {}`,
  });

  let onLoad;
  const loaded = new Promise((resolve) => {
    onLoad = resolve;
  });
  s.on((method) => {
    if (method === 'Page.loadEventFired') onLoad(true);
  });

  await s.send('Page.navigate', { url: URL_TO_SHOOT });
  // `load`, not an idle network — see the header. The race is against a timeout, so
  // a page that never fires load still yields a picture of whatever it did manage.
  await Promise.race([loaded, sleep(20000)]);

  if (WAIT_SEL) {
    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      const r = await s.send('Runtime.evaluate', {
        expression: `!!document.querySelector(${JSON.stringify(WAIT_SEL)})`,
        returnByValue: true,
      });
      found = r.result.value === true;
      if (!found) await sleep(250);
    }
    if (!found) note('wait', `--wait ${WAIT_SEL} never appeared (15s)`);
  }

  await sleep(SETTLE);
  await capture(s);
} catch (e) {
  failure = e;
  // A run that produces nothing sends the agent back to guessing from source, and
  // the error state is usually the single most informative frame there is.
  try {
    await capture(s);
  } catch {
    /* nothing left to photograph */
  }
} finally {
  close();
}

/* ------------------------------------------------------------------ report */

const rel = path.relative(process.cwd(), OUT);
if (fs.existsSync(OUT)) {
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(rel.startsWith('..') ? OUT : rel);
  console.log(
    `  ${URL_SHOWN} - ${VP.width}x${VP.height} @${VP.dpr}x${VP.mobile ? ' mobile' : ''}${FULL ? ' full-page' : ''} - ${kb} KB`
  );
} else {
  console.log('(no screenshot was produced)');
}

if (failure) console.log(`\n  FAILED: ${failure.message}`);
else if (docFailed) console.log(`\n  FAILED: the page never loaded (${docFailed}) — what you are looking at is Chrome's error page`);

if (problems.size) {
  console.log('\nwhat the page complained about');
  for (const { kind, text, n } of problems.values()) {
    console.log(`  ${kind}: ${text}${n > 1 ? `  (x${n})` : ''}`);
  }
  console.log('\nA screenshot shows a blank panel. It does not show the error behind it, which is what this list is for.');
} else if (!failure) {
  console.log('\n  no console errors, no failed requests');
}

process.exit(failure || docFailed || (STRICT && problems.size) ? 1 : 0);
