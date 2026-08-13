#!/usr/bin/env node
//
// The session-count steppers on the advocates console: dial, then Apply.
//
//   node scripts/stepper-check.mjs [--keep] [--shot <file.png>]
//
// The number of sessions an advocate may open at once, and the total across every
// advocate, are the two settings on this page that spend money and open windows. Each
// ± used to POST on the press, so 1 → 5 was four writes to config.json and four
// applies on a running daemon with no moment in the middle to change your mind. Now
// the number moves in the page and Apply is the write — see bc-0jnq.
//
// That behaviour is *only* in public/monitor.js: the endpoint under it is unchanged, so
// no server test can tell whether the client sends one request or four. This drives the
// real page in a headless Chrome against a real `bin/beadcause.js`, counts the requests
// that leave the page, and reads the config file the daemon wrote — the two halves that
// together say "one press, one write".
//
// Not part of `npm test`: it wants Chrome. `--keep` leaves the temp config directory
// behind, which is where to look when a press appears to work and the file says
// otherwise. `--shot <file.png>` writes a phone-sized picture of a stepper mid-
// adjustment, which is the one thing a list of ticks cannot show you: whether a pill
// with Apply inside it still reads as one control.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The daemon is a child reading a config.json this writes, so the port has to be known
// before the process that binds it exists — which is exactly what `freePort` is for.
import { freePort } from '../test/helpers/net.mjs';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'stepper-check-token';
const KEEP = process.argv.includes('--keep');
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i === -1 ? null : path.resolve(process.argv[i + 1] || 'stepper.png');
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the daemon */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-stepper-check-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const wsDir = (name) => {
  const dir = path.join(tmp, 'beads', name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const port = await freePort();

/* `bd` answers everything with an empty list, so there is a real advocate with a real
   queue of nothing: it surveys, finds no work, and launches no windows. The steppers
   are about how many sessions it *may* open, which is a number it holds whether or not
   there is anything to open. */
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(FAKE_BD, "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });

const CONFIG = {
  port,
  host: '127.0.0.1',
  baseUrl: `http://127.0.0.1:${port}`,
  token: TOKEN,
  actor: 'beadcause-stepper-check',
  bdBin: FAKE_BD,
  workspaces: [{ name: 'alpha', dir: wsDir('alpha') }],
  spaces: [],
  advocates: {
    enabled: true,
    workspaces: ['alpha'],
    maxWorkers: 1,
    maxWorkersLimit: 9,
    globalMaxWorkers: 6,
    // Everything that would reach out of the process is off: an empty queue is the
    // one state that makes an advocate want to *propose* beads, and that spawns
    // `claude`. Nothing here needs it — the queue is not what is under test.
    propose: false,
    sessionLog: false,
    closeFinishedSessions: false,
    sweepFinishedWindows: false,
  },
  openSessions: false,
  claudeSessions: false,
  terminal: false,
  tls: { enabled: false },
  monitor: { enabled: false },
  ntfy: { enabled: false },
  release: { beads: false },
  pollSeconds: 3600,
};
fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(CONFIG, null, 2));

const daemon = spawn(process.execPath, [path.join(ROOT, 'bin', 'beadcause.js')], {
  env: { ...process.env, BEADCAUSE_CONFIG_DIR: CONFIG_DIR },
  stdio: 'ignore',
});

const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 80; i += 1) {
  try {
    const r = await fetch(`${BASE}/api/health`, { headers: { 'x-beadcause-token': TOKEN } });
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(150);
}

/** What is actually on disk now — the half of a press a screenshot cannot show. */
const onDisk = () => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
const repoLimit = () => onDisk().advocates?.perWorkspace?.alpha?.maxWorkers;
const globalLimit = () => onDisk().advocates?.globalMaxWorkers;

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
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log(`\nworker steppers — daemon on :${port}, config in ${CONFIG_DIR}\n`);

const { s, close } = await launchChrome('beadcause-stepper-chrome-');
try {
  await s.send('Emulation.setDeviceMetricsOverride', { ...VP, mobile: true, deviceScaleFactor: VP.dpr });
  // `?t=` is how a browser that has never scanned the QR gets paired.
  await s.send('Page.navigate', { url: `${BASE}/monitor?t=${TOKEN}` });
  await sleep(1400);

  /* Every request that leaves the page, counted. This is the assertion the feature is
     *about* — four presses used to be four of these — and it has to be counted in the
     page rather than in the daemon, because a client that batched nothing and a client
     that batched everything both end up with the same number in config.json. */
  await evalJs(
    s,
    `(() => {
      window.__posts = [];
      window.__failAdvocate = false;
      const f = window.fetch;
      window.fetch = (...a) => {
        const url = String(a[0] || '');
        if (url.includes('/api/advocate')) {
          window.__posts.push(JSON.parse(a[1]?.body || '{}'));
          // A refusal on demand, for the last section. Injected here rather than
          // provoked with a bad credential because the page reads its token once at
          // load: the point is what the *client* does with a no, not how it earns one.
          // And a slow one, for the in-flight section: the write is a loopback POST
          // and settles in single-figure milliseconds, so the disabled control it is
          // supposed to leave behind is otherwise unobservable.
          if (window.__delayAdvocate)
            return new Promise((r) => setTimeout(() => r(f(...a)), window.__delayAdvocate));
          if (window.__failAdvocate)
            return Promise.resolve(
              new Response(JSON.stringify({ error: 'refused by stepper-check' }), {
                status: 403,
                headers: { 'content-type': 'application/json' },
              })
            );
        }
        return f(...a);
      };
      return true;
    })()`
  );
  const posts = () => evalJs(s, `window.__posts`);

  /** The state of one stepper, as a thumb sees it. `sel` is what the pill sits inside. */
  const pill = (sel) =>
    evalJs(
      s,
      `(() => {
        const el = document.querySelector(${JSON.stringify(sel)} + ' .adv-limit');
        if (!el) return null;
        const steps = [...el.querySelectorAll('.adv-step')];
        const apply = el.querySelector('.adv-apply');
        return {
          number: Number(el.querySelector('b')?.textContent),
          pending: el.classList.contains('pending'),
          apply: apply ? apply.textContent.trim() : null,
          applyOff: apply ? apply.disabled : null,
          stepsOff: steps.map((b) => b.disabled),
        };
      })()`
    );

  const REPO = '.mon-card[data-ws="alpha"]';
  const GLOBAL = '.svc-set';

  const press = async (sel, ms = 120) => {
    const hit = await evalJs(
      s,
      `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.disabled) return false; b.click(); return true; })()`
    );
    await sleep(ms);
    return hit;
  };

  /* ------------------------------------------------------- settled, then moved */

  const at_rest = await pill(REPO);
  check('the stepper draws the number the daemon holds', at_rest?.number === 1, JSON.stringify(at_rest));
  check('and offers no Apply until it has been moved', at_rest?.apply === null, JSON.stringify(at_rest));

  for (let i = 0; i < 3; i += 1) await press(`${REPO} .adv-limit .adv-step:nth-of-type(2)`);
  const moved = await pill(REPO);
  check('three presses on + reach 4 without leaving the page', moved?.number === 4, JSON.stringify(moved));
  check('nothing was sent', (await posts()).length === 0, JSON.stringify(await posts()));
  check('nothing was written', repoLimit() === undefined, JSON.stringify(onDisk().advocates?.perWorkspace));
  check('and the pill says the number is yours, not the daemon’s', moved?.pending === true && moved?.apply === 'Apply');

  /* ------------------------------------------ a repaint must not eat the number */

  await press('#refresh', 900);
  const survived = await pill(REPO);
  check(
    'a refresh mid-adjustment leaves the pending number alone',
    survived?.number === 4 && survived?.apply === 'Apply',
    JSON.stringify(survived)
  );

  /* ------------------------------------------------------ down to live, and back */

  for (let i = 0; i < 3; i += 1) await press(`${REPO} .adv-limit .adv-step:nth-of-type(1)`);
  const back = await pill(REPO);
  check(
    'stepping back to the live number settles the control again',
    back?.number === 1 && back?.apply === null && back?.pending === false,
    JSON.stringify(back)
  );
  for (let i = 0; i < 3; i += 1) await press(`${REPO} .adv-limit .adv-step:nth-of-type(2)`);

  /* ---------------------------------------------------------------- the write */

  await press(`${REPO} .adv-apply`, 1200);
  const applied = await pill(REPO);
  const sent = await posts();
  check('Apply sends exactly one request', sent.length === 1, JSON.stringify(sent));
  check(
    'carrying the workspace, the action and the number',
    sent[0]?.workspace === 'alpha' && sent[0]?.action === 'limit' && sent[0]?.value === 4,
    JSON.stringify(sent[0])
  );
  check('the daemon wrote it', repoLimit() === 4, JSON.stringify(onDisk().advocates?.perWorkspace));
  check(
    'and the control settles on what came back',
    applied?.number === 4 && applied?.apply === null,
    JSON.stringify(applied)
  );

  /* ------------------------------------------- the ceiling is still the ceiling */

  for (let i = 0; i < 9; i += 1) await press(`${REPO} .adv-limit .adv-step:nth-of-type(2)`);
  const capped = await pill(REPO);
  check(
    'the + stops at maxWorkersLimit rather than dialling past it',
    capped?.number === 9 && capped?.stepsOff?.[1] === true,
    JSON.stringify(capped)
  );

  if (SHOT) {
    const { data } = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
    console.log(`  ⤷ ${SHOT}`);
  }

  /* ------------------------------------------------------- the global cap, once */

  const globalBefore = await pill(GLOBAL);
  check('the global cap draws the same control', globalBefore?.number === 6, JSON.stringify(globalBefore));
  for (let i = 0; i < 2; i += 1) await press(`${GLOBAL} .adv-limit .adv-step:nth-of-type(1)`);
  const globalMoved = await pill(GLOBAL);
  check(
    'two presses down reach 4 and are still unsent',
    globalMoved?.number === 4 && globalLimit() === 6,
    `${JSON.stringify(globalMoved)} on disk ${globalLimit()}`
  );
  const before = (await posts()).length;
  await press(`${GLOBAL} .adv-apply`, 1200);
  const globalSent = (await posts()).slice(before);
  check('and one Apply writes the total across every advocate', globalLimit() === 4, String(globalLimit()));
  check(
    'as a single globalLimit request with no workspace on it',
    globalSent.length === 1 && globalSent[0]?.action === 'globalLimit' && globalSent[0]?.workspace === undefined,
    JSON.stringify(globalSent)
  );

  /* ------------------------------------------------- while the write is in flight */

  // Pending is 9 here, from the ceiling press above.
  await evalJs(s, `window.__delayAdvocate = 1200`);
  await evalJs(s, `document.querySelector(${JSON.stringify(`${REPO} .adv-apply`)}).click()`);
  await sleep(250);
  const inflight = await pill(REPO);
  check(
    'the whole control is disabled while the write is in flight',
    inflight?.applyOff === true && inflight?.stepsOff?.every(Boolean),
    JSON.stringify(inflight)
  );
  check('and says so where the button was', inflight?.apply === '…', JSON.stringify(inflight));
  // A poll landing mid-write must not hand the buttons back — the disabled state is in
  // `state`, not in the markup, and this is the press that proves it.
  await press('#refresh', 300);
  const stillBusy = await pill(REPO);
  check(
    'a repaint mid-write leaves it disabled',
    stillBusy?.applyOff === true && stillBusy?.stepsOff?.every(Boolean),
    JSON.stringify(stillBusy)
  );
  await sleep(1600);
  const settled = await pill(REPO);
  await evalJs(s, `window.__delayAdvocate = 0`);
  check(
    'and it comes back enabled on the daemon’s answer',
    settled?.number === 9 && settled?.apply === null && repoLimit() === 9,
    `${JSON.stringify(settled)} on disk ${repoLimit()}`
  );

  /* ------------------------------------------------------- a refusal is visible */

  // The one failure mode that used to be invisible: applying repaints the page, so a
  // note appended to the pressed button's card would go with the old DOM — and that is
  // the press whose failure most has to be seen.
  const wasOnDisk = repoLimit();
  await evalJs(s, `window.__failAdvocate = true`);
  await press(`${REPO} .adv-limit .adv-step:nth-of-type(1)`);
  await press(`${REPO} .adv-apply`, 1200);
  const refused = await pill(REPO);
  const said = await evalJs(
    s,
    `[...document.querySelectorAll(${JSON.stringify(REPO)} + ' .adv-note.bad')].map((n) => n.textContent).join(' | ')`
  );
  check(
    'a refused Apply keeps the number it was holding',
    refused?.number === 8 && refused?.pending === true && refused?.apply === 'Apply',
    JSON.stringify(refused)
  );
  check('says why, on the card that was repainted under it', /stepper-check/.test(said), said || 'nothing said');
  check(
    'and hands the control back',
    refused?.applyOff === false && !refused?.stepsOff?.every(Boolean),
    JSON.stringify(refused)
  );
  check(
    'having written nothing — the file still says what the last good Apply left',
    repoLimit() === wasOnDisk,
    `${repoLimit()} (was ${wasOnDisk})`
  );
} finally {
  close();
  daemon.kill();
  if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  else console.log(`\nkept ${CONFIG_DIR}`);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n\x1b[31m${failed.length} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
