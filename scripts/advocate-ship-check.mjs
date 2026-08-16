#!/usr/bin/env node
//
// The Ship strip on the advocate card: the merges since the last deploy, and two taps.
//
//   node scripts/advocate-ship-check.mjs [--baseline] [--out=<dir>]
//
// bc-jznr.3. The queue itself is lib/release.js's and has a suite; the board's copy of
// this strip is public/prs.js's and has `scripts/prs-check.mjs`. What neither covers is
// the third thing: that the *advocate console* draws it, on the right card, and that the
// button on it arms before it deploys. That behaviour is only in public/monitor.js, and
// the endpoint underneath is the board's own — so no server test can tell whether one
// press sent one deploy or two, or whether the strip appeared on the card for the repo it
// is about.
//
// Four things it asserts, and the first tap is the one that matters:
//
//   - **The strip is on the advocate card**, above the folds, with the count on the
//     button and the merges readable underneath.
//   - **The first tap writes nothing.** It arms and says how many are about to go out —
//     on a page where the same press restarts the daemon you are reading it on.
//   - **The second sends `/api/release/ship`**, with the repo's *key*, because a
//     workspace can front forty checkouts and the wrong key is the wrong service.
//   - **A repo with nothing waiting draws no strip at all.** Everything merged being live
//     is the ordinary state and it should look like it rather than like a control you
//     decided not to press.
//
// Not part of `npm test`: it wants Chrome. `--baseline` serves the committed copies of
// the page's own scripts instead of the working ones, which is how to prove a failure is
// real. `--out=<dir>` writes a phone-sized picture in both schemes.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const BASELINE = process.argv.includes('--baseline');
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the fixture */

/** One advocate, doing nothing in particular — this file is about the strip over it. */
const ADVOCATE = (over = {}) => ({
  workspace: 'demo',
  limit: 2,
  queue: 0,
  workers: [],
  closing: [],
  paused: false,
  quiet: false,
  surveying: false,
  note: '',
  error: null,
  ready: [],
  giveUps: [],
  archive: null,
  lastSurveyAt: null,
  lastLaunchAt: null,
  lastProposalAt: null,
  ...over,
});

const WORK = () => ({
  workspaces: [
    { name: 'demo', working: [], sessions: [], error: null },
    { name: 'quiet', working: [], sessions: [], error: null },
  ],
  advocates: [ADVOCATE(), ADVOCATE({ workspace: 'quiet' })],
  elsewhere: [],
  globals: null,
  service: null,
  router: null,
  observing: false,
  seq: 1,
});

/**
 * The queue, mutable — because the strip's most important state is the one where it is
 * *absent*. `quiet` never has one, which is what makes "no strip" an assertion about the
 * rule rather than about the fixture being empty.
 */
let RELEASE = {
  count: 2,
  can: 'deploy',
  hint: 'runs `launchctl` · rebuilds APK · restarts beadcause',
  prs: [
    { number: 5, title: 'The one that rebuilt the APK', url: 'https://x/5', mergedAt: '2026-08-13T08:00:00Z', sha: 'ddddddd', bead: 'bc-c3d' },
    { number: 3, title: 'Merged and pushed, not shipped', url: 'https://x/3', mergedAt: '2026-08-13T07:00:00Z', sha: 'eeeeeee', bead: null },
  ],
};

const BOARD = () => ({
  unavailable: null,
  repos: [
    { workspace: 'demo', key: 'demo', repoName: null, prs: [], error: null, deployDeclared: true, release: RELEASE },
    { workspace: 'quiet', key: 'quiet', repoName: null, prs: [], error: null, deployDeclared: true, release: { count: 0, can: 'deploy', hint: '', prs: [] } },
  ],
  seq: 1,
});

const posted = [];
/* Presence is the page telling the daemon which view this device has open — it is not a
   write anybody pressed, and it lands on every load. Filtered here for the same reason
   scripts/card-thread-check.mjs filters it: 'nothing was written' has to mean nothing was
   written *by the tap*. */
const real = () => posted.filter((p) => p.path !== '/api/presence');
let reply = { status: 200, body: { ok: true, deploy: { id: 'd-ship1' } } };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** HEAD's copy of the page's own scripts, for `--baseline`. */
const BASE_FILES = {};
if (BASELINE) {
  for (const name of ['monitor.js', 'update.js', 'stream.js', 'style.css']) {
    try {
      BASE_FILES[name] = execFileSync('git', ['-C', ROOT, 'show', `HEAD:public/${name}`], { encoding: 'utf8' });
    } catch {
      /* a file HEAD does not have yet — the working copy is the only copy */
    }
  }
}

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
    if (p === '/api/work') return json(WORK());
    if (p === '/api/prs') return json(BOARD());
    if (p === '/api/questions') return json({ questions: [], workspaces: ['demo', 'quiet'], seq: 1 });
    // The poll: answered at once with nothing, rather than parked. A check that let the
    // page hold a real 25-second socket would spend its whole run waiting for it.
    if (p === '/api/poll') return json({ seq: 1, events: [] });
    if (p.startsWith('/api/')) return json({});

    const rel = p === '/' || p === '/monitor' || p === '/advocates' ? '/monitor.html' : p;
    const name = rel.replace(/^\/+/, '');
    if (BASE_FILES[name]) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)] });
      return res.end(BASE_FILES[name]);
    }
    const file = path.join(PUBLIC, name);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/* ----------------------------------------------------------------------- run */

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

/** The strip on one workspace's card: the button's words, the count, the merges. */
const STRIP = (ws) => `(() => {
  const card = document.querySelector('.mon-card[data-ws=${JSON.stringify(ws)}]');
  if (!card) return { card: false };
  const strip = card.querySelector('.release');
  if (!strip) return { card: true, strip: false };
  return {
    card: true,
    strip: true,
    button: strip.querySelector('[data-ship]')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    key: strip.querySelector('[data-ship]')?.dataset.ship || '',
    count: strip.querySelector('.release-count')?.textContent.trim() || '',
    say: strip.querySelector('.release-say')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    merges: [...strip.querySelectorAll('.release-list li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim()),
    said: strip.querySelector('.board-said')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    /* Above the folds, which is the point of putting it here at all: a queue you scroll
       past "Working now", "Up next" and "Thinking" to reach is a queue that stays
       unshipped. .mon-sec is what section() in public/monitor.js draws. */
    aboveFolds: (() => {
      const fold = card.querySelector('.mon-sec');
      if (!fold) return null;
      return Boolean(strip.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING);
    })(),
  };
})()`;

const tapShip = (ws) => `(() => {
  const b = document.querySelector('.mon-card[data-ws=${JSON.stringify(ws)}] [data-ship]');
  if (!b) return false;
  b.click();
  return true;
})()`;

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome('beadcause-advship-');
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

  await s.send('Page.navigate', { url: `${BASE}/monitor` });
  await sleep(700);
  await evalJs(s, `localStorage.setItem('beadcause.token', 'x')`);
  await s.send('Page.navigate', { url: `${BASE}/monitor` });
  await sleep(1800);

  console.log('the queue, on the card you were already looking at');

  const strip = await evalJs(s, STRIP('demo'));
  ok(strip.card, 'the advocate card is drawn');
  ok(strip.strip, 'and it carries the release strip');
  ok(strip.count === '2', `with the count on the button — "${strip.count}"`);
  ok(strip.button.startsWith('Ship'), `which says Ship — "${strip.button}"`);
  ok(strip.key === 'demo', `and carries the repo’s key, not its position — "${strip.key}"`);
  ok(strip.merges.length === 2, `both merges are readable under it — ${strip.merges.length}`);
  ok(/#5/.test(strip.merges[0] || ''), `the newest first — "${strip.merges[0] || ''}"`);
  ok(/not live/.test(strip.say), `and it says what that means — "${strip.say.slice(0, 60)}…"`);
  ok(/launchctl/.test(strip.say), 'naming the command, because on this repo it restarts the daemon you are reading it on');
  ok(strip.aboveFolds, 'drawn above the advocate’s own folds');

  const quiet = await evalJs(s, STRIP('quiet'));
  ok(quiet.card && quiet.strip === false, 'a repo with nothing waiting draws no strip at all');

  console.log('\ntwo taps, because the second one restarts something');

  await evalJs(s, tapShip('demo'));
  await sleep(200);
  const armed = await evalJs(s, STRIP('demo'));
  ok(real().length === 0, `the first tap sends nothing — ${JSON.stringify(real().map((p) => p.path))}`);
  ok(/sure\?/.test(armed.button), `and the button asks — "${armed.button}"`);
  ok(/all 2/.test(armed.button), 'saying how many are about to go out');

  await evalJs(s, tapShip('demo'));
  await sleep(500);
  ok(real().length === 1, `the second sends exactly one deploy — ${real().length}`);
  ok(real()[0]?.path === '/api/release/ship', `to the board’s own endpoint — ${real()[0]?.path}`);
  ok(real()[0]?.body?.key === 'demo', `for that repo’s key — ${JSON.stringify(real()[0]?.body)}`);
  const after = await evalJs(s, STRIP('demo'));
  ok(/d-ship1/.test(after.said), `and says which record to watch — "${after.said}"`);
  ok(!/sure\?/.test(after.button || ''), 'with the button no longer armed');

  console.log('\nand when the daemon refuses');

  posted.length = 0;
  reply = { status: 409, body: { error: 'nothing is waiting to ship in demo — everything merged is already live' } };
  await evalJs(s, tapShip('demo'));
  await sleep(150);
  await evalJs(s, tapShip('demo'));
  await sleep(500);
  const refused = await evalJs(s, STRIP('demo'));
  ok(/already live/.test(refused.said), `the refusal lands on the card in the daemon’s own words — "${refused.said}"`);

  if (outDir) {
    reply = { status: 200, body: { ok: true, deploy: { id: 'd-ship1' } } };
    await s.send('Page.navigate', { url: `${BASE}/monitor` });
    await sleep(1800);
    fs.mkdirSync(outDir, { recursive: true });
    for (const scheme of ['dark', 'light']) {
      await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await sleep(300);
      const shot = await s.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, `advocate-ship-${scheme}.png`), Buffer.from(shot.data, 'base64'));
    }
    console.log(`\n  screenshots in ${outDir}`);
  }
} finally {
  chrome.close();
  server.close();
}

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
process.exit(failures ? 1 : 0);
