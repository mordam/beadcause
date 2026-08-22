// The Trackers card on /admin, and the space picker it exists to clean up — bc-qid8b.
//
// Two things the unit suites cannot see, which is why this drives a real daemon and a
// real Chrome rather than asserting on strings:
//
//   * **The picker drew the strays twice.** `summarise()` emits a synthetic space named
//     "Other" for the strays it found beads in, and `paint()` looped that array *and*
//     called `strays()` — two `<optgroup label="Other">` and a repo listed under both.
//     test/spacebar.mjs asserts the markup; this asserts what a browser actually builds
//     out of it, which is the thing with the duplicate rows in it.
//   * **Retire is a press.** The row, the arm, the second press, and the config file
//     afterwards — the whole point being that the tracker leaves the picker without
//     anybody restarting anything.
//
// Isolated config dir, throwaway `.beads` directories, and a `bd` that answers `[]`, so
// this never reads or writes the real install on the machine it runs on.
//
//     node scripts/tracker-check.mjs [--shot out.png] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from '../test/helpers/net.mjs';
import { CHROME, launchChrome } from './helpers/chrome.mjs';
import { onExit, killAndRemoveSync } from '../lib/teardown.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'tracker-check-token';
const KEEP = process.argv.includes('--keep');
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i === -1 ? null : path.resolve(process.argv[i + 1] || 'trackers.png');
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the daemon */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-tracker-check-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const wsDir = (name) => {
  const dir = path.join(tmp, 'beads', name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(FAKE_BD, "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });

const port = await freePort();
const CONFIG = {
  port,
  host: '127.0.0.1',
  baseUrl: `http://127.0.0.1:${port}`,
  token: TOKEN,
  actor: 'beadcause-tracker-check',
  bdBin: FAKE_BD,
  // A container root, so discovery is real: `restorable` and the restore itself both ask
  // it, and a fixture that only listed names would let a broken lookup pass.
  workspaceRoots: [path.join(tmp, 'beads')],
  workspaces: ['alpha', 'beta', 'gamma', 'delta'].map((name) => ({ name, dir: wsDir(name) })),
  // `gamma` and `delta` are in no space — they are the strays the picker draws under
  // "Other", which is where the duplicate was.
  spaces: [
    { name: 'Work', workspaces: ['alpha'] },
    { name: 'Side', workspaces: ['beta'] },
  ],
  ntfy: { enabled: false },
  autoDispatch: false,
  openSessions: false,
  claudeSessions: false,
  terminal: false,
  tls: { enabled: false },
  monitor: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
  release: { beads: false },
  pollSeconds: 3600,
};
fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(CONFIG, null, 2));

const daemon = spawn(process.execPath, [path.join(ROOT, 'bin', 'beadcause.js')], {
  env: { ...process.env, BEADCAUSE_CONFIG_DIR: CONFIG_DIR },
  stdio: 'ignore',
});
// A daemon that outlives its check goes on listening out of a worktree the attic will
// later remove from under it — see the same note in scripts/space-check.mjs.
const disarmExit = onExit(() => killAndRemoveSync(daemon, KEEP ? null : tmp));

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

/** What is actually on disk — the half of a press a screenshot cannot show. */
const onDisk = () => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 140)}`);
  return r.result.value;
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log(`\ntrackers — daemon on :${port}, config in ${CONFIG_DIR}\n`);

const { s, close } = await launchChrome('beadcause-tracker-chrome-');
try {
  await s.send('Emulation.setDeviceMetricsOverride', { ...VP, mobile: true, deviceScaleFactor: VP.dpr });

  /* ------------------------------------------- 1. the picker, as a browser builds it */

  await s.send('Page.navigate', { url: `${BASE}/console?t=${TOKEN}` });
  await sleep(1500);

  // Asked of the live `<select>` rather than of its innerHTML: the duplicate was two
  // groups with the same label, so the thing worth counting is the options a browser
  // actually built.
  const picker = await evalJs(
    s,
    `(() => {
      const sel = document.querySelector('#space-pick');
      if (!sel) return null;
      return {
        groups: [...sel.querySelectorAll('optgroup')].map((g) => g.label),
        rows: [...sel.options].map((o) => o.value),
      };
    })()`
  );
  check('the picker is on the page', Boolean(picker));
  const others = (picker?.groups || []).filter((g) => g === 'Other');
  check('one "Other" group, not two', others.length === 1, `groups: ${(picker?.groups || []).join(', ')}`);
  const dupes = (picker?.rows || []).filter((v, i, a) => a.indexOf(v) !== i);
  check('and no row appears twice', dupes.length === 0, dupes.length ? `duplicated: ${dupes.join(', ')}` : 'every row once');
  check(
    'both strays are reachable, and "Other — all" with them',
    ['ws:gamma', 'ws:delta', 'space:Other'].every((v) => (picker?.rows || []).includes(v)),
    (picker?.rows || []).join(' ')
  );

  /* ------------------------------------------------------ 2. the card, and the press */

  await s.send('Page.navigate', { url: `${BASE}/admin?t=${TOKEN}` });
  await sleep(1800);

  const card = () =>
    evalJs(
      s,
      `(() => {
        const el = document.querySelector('#repos .admin-card');
        if (!el) return null;
        return {
          text: el.innerText.replace(/\\s+/g, ' ').trim(),
          rows: [...el.querySelectorAll('button[data-retire]')].map((b) => b.dataset.retire),
          restores: [...el.querySelectorAll('button[data-restore]')].map((b) => b.dataset.restore),
        };
      })()`
    );

  const before = await card();
  check('the Trackers card is on /admin', Boolean(before), before?.text?.slice(0, 90));
  check(
    'with a Retire button per tracker and nothing retired yet',
    before?.rows?.length === 4 && before?.restores?.length === 0,
    `retire: ${before?.rows?.join(', ')}`
  );

  // A row carries a filesystem path, which is one unbreakable token — every other row on
  // this page is prose, so `.admin-detail` had no `overflow-wrap` until bc-qid8b and the
  // path ran out past the card's right edge on a phone. Measured rather than eyeballed,
  // the way scripts/topbar-check.mjs measures the bar.
  const overflow = await evalJs(
    s,
    `(() => {
      const el = document.querySelector('#repos .admin-card');
      const over = [...el.querySelectorAll('.admin-detail')].filter((p) => p.scrollWidth > p.clientWidth + 1);
      return { card: el.scrollWidth - el.clientWidth, rows: over.map((p) => p.textContent.trim().slice(0, 40)) };
    })()`
  );
  check(
    'nothing runs out past the card — the dir wraps instead',
    overflow.card <= 1 && overflow.rows.length === 0,
    overflow.rows.length ? `overflowing: ${overflow.rows.join(' | ')}` : `card overflow ${overflow.card}px`
  );

  // First press arms rather than acts — the discipline the kill button and Revoke share.
  await evalJs(s, `document.querySelector('button[data-retire="gamma"]').click()`);
  await sleep(400);
  const armedText = await evalJs(s, `document.querySelector('button[data-retire="gamma"]').textContent`);
  check('the first press arms and says what the second will do', /Tap again/.test(armedText), armedText);
  check('and nothing is written yet', !('gamma' in (onDisk().workspaceDirs || {})), 'workspaceDirs untouched');

  await evalJs(s, `document.querySelector('button[data-retire="gamma"]').click()`);
  await sleep(1200);

  const after = await card();
  check('the second press retires it', onDisk().workspaceDirs?.gamma === null, `workspaceDirs.gamma = null`);
  check(
    'the row moves to Retired, with the way back on it',
    after?.rows?.length === 3 && after?.restores?.includes('gamma'),
    `retire: ${after?.rows?.join(', ')} · restore: ${after?.restores?.join(', ')}`
  );
  check('the tracker is still on disk — this is a line about what gets read', fs.existsSync(wsDir('gamma')));

  /* ------------------------------ 3. and it has left the picker, with no restart */

  await s.send('Page.navigate', { url: `${BASE}/console?t=${TOKEN}` });
  await sleep(1500);
  const afterPicker = await evalJs(
    s,
    `[...document.querySelectorAll('#space-pick option')].map((o) => o.value)`
  );
  check('the retired tracker is gone from the picker', !afterPicker.includes('ws:gamma'), afterPicker.join(' '));
  check('and the one beside it is still there', afterPicker.includes('ws:delta'));

  /* --------------------------------------------------------------- 4. bringing it back */

  await s.send('Page.navigate', { url: `${BASE}/admin?t=${TOKEN}` });
  await sleep(1800);
  await evalJs(s, `document.querySelector('button[data-restore="gamma"]').click()`);
  await sleep(1200);
  const restored = await card();
  check('Bring back needs no second press', restored?.rows?.includes('gamma'), `retire: ${restored?.rows?.join(', ')}`);
  check('and the key is gone from the file', !('gamma' in (onDisk().workspaceDirs || {})));

  if (SHOT) {
    // Clipped to the card rather than the page: it sits below the pause controls and the
    // devices list, so a viewport shot of /admin is three cards of something else.
    const box = await evalJs(
      s,
      `(() => {
        const el = document.querySelector('#repos .admin-card');
        el.scrollIntoView();
        const r = el.getBoundingClientRect();
        return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
      })()`
    );
    await sleep(300);
    const shot = await s.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { ...box, scale: VP.dpr },
    });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\n  screenshot → ${SHOT}`);
  }
} finally {
  await close();
  disarmExit();
  killAndRemoveSync(daemon, KEEP ? null : tmp);
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `\n\x1b[31m${failed.length} of ${results.length} failed\x1b[0m`
    : `\n\x1b[32mthe card and the picker both hold\x1b[0m`
);
process.exit(failed.length ? 1 : 0);
