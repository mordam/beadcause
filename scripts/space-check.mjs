#!/usr/bin/env node
//
// The space details card, in a phone-sized browser, against a real daemon.
//
//   node scripts/space-check.mjs [--keep] [--shot <file.png>]
//
// test/spacedetails.mjs proves the contract: `null` means inherit, a patch touches
// only what it names, the write reaches the running daemon *and* the file. None of
// that says the card draws, and none of it says a press reaches the endpoint — which
// is the whole feature, because every one of these settings was a config hand-edit
// until there was a button.
//
// So this one drives the real `public/monitor.js` in a headless Chrome the size of a
// phone, over a real `bin/beadcause.js` started on a temp config directory. Nothing is
// faked: the fake server is exactly how the shadowed `GET /api/foundation` handler
// survived a green suite for weeks (test/routes.mjs), and a settings screen is the
// last place to repeat that — a fixture would be free to answer `POST /api/space` the
// way the client wishes it did.
//
// Not part of `npm test`: it wants Chrome on the machine. Run it when you have touched
// the card, the picker it reads from, or the endpoint under it.
//
// `--keep` leaves the temp config directory behind, which is where to look when a
// press appears to work and the file says otherwise. `--shot <file.png>` writes a
// phone-sized picture of the card with every panel open — the one thing a list of
// ticks cannot tell you is whether a row per setting on a 393px screen reads as a card
// or as a wall.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from '../test/helpers/net.mjs';
import { SETTINGS } from '../lib/spaces.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'space-check-token';
const KEEP = process.argv.includes('--keep');
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i === -1 ? null : path.resolve(process.argv[i + 1] || 'space-details.png');
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the daemon */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-space-check-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

/** A workspace with a `.beads` directory and no tracker behind it — see `bdBin`. */
const wsDir = (name) => {
  const dir = path.join(tmp, 'beads', name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/* `bd` answers everything with an empty list, so the page has real advocates-and-
   sessions machinery running over nothing rather than a tracker sweep in the way. The
   settings card does not read `bd` at all, which is the point of it being cheap. */
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(FAKE_BD, "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });

const port = await freePort();
const CONFIG = {
  port,
  host: '127.0.0.1',
  baseUrl: `http://127.0.0.1:${port}`,
  token: TOKEN,
  actor: 'beadcause-space-check',
  bdBin: FAKE_BD,
  // Named here so `reconcileWorkspaces` has something to keep rather than going out and
  // discovering the real `~/beads` on the machine this runs on.
  workspaces: [
    { name: 'alpha', dir: wsDir('alpha') },
    { name: 'beta', dir: wsDir('beta') },
  ],
  spaces: [
    { name: 'Work', workspaces: ['alpha', 'beta'], quietHours: { from: '18:00', to: '09:00' } },
    { name: 'Side', workspaces: [], muted: true },
  ],
  pr: { autoMerge: true },
  ntfy: { enabled: false, detail: 'full', minimalWorkspaces: ['beta'] },
  autoDispatch: true,
  autoDispatchExclude: ['alpha'],
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
const spaceOnDisk = (name) => onDisk().spaces.find((s) => s.name === name) || {};

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

console.log(`\nspace details — daemon on :${port}, config in ${CONFIG_DIR}\n`);

const { s, close } = await launchChrome('beadcause-space-chrome-');
try {
  await s.send('Emulation.setDeviceMetricsOverride', { ...VP, mobile: true, deviceScaleFactor: VP.dpr });

  // `?t=` is how a browser that has never scanned the QR gets paired — the same pickup
  // the page does for the login window opened on the Mac at boot.
  await s.send('Page.navigate', { url: `${BASE}/monitor?t=${TOKEN}` });
  await sleep(1200);

  // Narrow to a space, through the picker rather than by writing state.json: the card
  // is drawn from `beadcause.space.filter`, so a filter set behind its back would test
  // the card and not the thing that feeds it.
  await evalJs(s, `window.beadcause.space.set({ space: 'Work', workspace: 'all' })`);
  await sleep(900);

  const card = () =>
    evalJs(
      s,
      `(() => {
        const el = document.querySelector('.space-card');
        if (!el) return null;
        return {
          title: el.querySelector('h2')?.textContent,
          state: el.querySelector('.mon-state')?.textContent,
          text: el.textContent.replace(/\\s+/g, ' '),
          rows: [...el.querySelectorAll('.space-what')].map((x) => x.textContent),
          // Which setting each row actually writes, read off the controls in it rather
          // than off its heading: the heading is a sentence for a human ("Agents may
          // answer unasked") and the key is what \`POST /api/space\` takes. Quiet hours
          // and quiet days are the two rows with bespoke controls instead of a
          // \`data-space-set\`, so they are named from the attribute they do carry.
          keys: [...el.querySelectorAll('.space-row')].map((r) => {
            const set = r.querySelector('[data-space-set]');
            if (set) return set.getAttribute('data-space-set');
            if (r.querySelector('[data-space-hours]')) return 'quietHours';
            if (r.querySelector('[data-space-day]')) return 'quietDays';
            return \`unknown: \${r.querySelector('.space-what')?.textContent || '?'}\`;
          }),
        };
      })()`
    );

  const first = await card();
  check('the card is drawn for the space the picker is on', first?.title === 'Work', first?.title || 'no card');

  // The panels are shut by default, like every other section on this page — and the
  // open set is in localStorage, so this profile may arrive with either. Open the one
  // under test the way a thumb does. Matched case-insensitively because the heading is
  // uppercased by the stylesheet and not by the markup.
  const open = async (title) =>
    evalJs(
      s,
      `(() => {
        const want = ${JSON.stringify(title)}.toLowerCase();
        const sum = [...document.querySelectorAll('.space-card .mon-sum')]
          .find((b) => b.textContent.toLowerCase().includes(want));
        if (sum && sum.getAttribute('aria-expanded') !== 'true') sum.click();
        return Boolean(sum);
      })()`
    );
  check('with a settings panel on it', await open('Settings'));
  await sleep(300);

  // Against `SETTINGS` rather than against a number: a count in this file is a number
  // that has to be moved every time a setting is added, and when it is not moved this
  // check greets the next person with a red they have to spend time proving is not
  // theirs — which is exactly what happened when `autoShip` landed (bc-qda7). The list
  // in lib/spaces.js is the same one the endpoint validates a patch against, so a
  // setting the card has no row for, and a row writing a key the server would reject,
  // both fail here and both fail by name.
  const opened = await card();
  const drawn = new Set(opened?.keys || []);
  const missingRow = SETTINGS.filter((k) => !drawn.has(k));
  const extraRow = [...drawn].filter((k) => !SETTINGS.includes(k));
  check(
    'carrying a row for every setting',
    missingRow.length === 0 && extraRow.length === 0 && drawn.size === (opened?.keys || []).length,
    [
      missingRow.length ? `no row for ${missingRow.join(', ')}` : '',
      extraRow.length ? `a row for ${extraRow.join(', ')}, which is not a setting` : '',
      (opened?.keys || []).join(', ') || 'none',
    ]
      .filter(Boolean)
      .join(' — ')
  );

  const press = async (selector) => {
    const hit = await evalJs(
      s,
      `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); return true; })()`
    );
    await sleep(700);
    return hit;
  };

  /* ------------------------------------------------------ a press that writes */

  const pressed = await press('[data-space-set="autoMerge"][data-value="false"]');
  const afterOff = await card();
  check('pressing Off on a three-state setting reaches the daemon', pressed && spaceOnDisk('Work').autoMerge === false, JSON.stringify(spaceOnDisk('Work')));
  check('and the card says so without a reload', /autoMerge changed/.test(afterOff?.text || ''), afterOff?.state);

  await press('[data-space-set="autoMerge"][data-value="null"]');
  check(
    'Inherit clears the key rather than storing a false',
    !('autoMerge' in spaceOnDisk('Work')),
    JSON.stringify(spaceOnDisk('Work'))
  );

  /* ------------------------------------------------------------- quiet days */

  await press('[data-space-day="sat"]');
  await press('[data-space-day="sun"]');
  check('a day toggles on and the list accumulates', JSON.stringify(spaceOnDisk('Work').quietDays) === '["sun","sat"]', JSON.stringify(spaceOnDisk('Work').quietDays));
  await press('[data-space-day="sat"]');
  check('and toggles back off', JSON.stringify(spaceOnDisk('Work').quietDays) === '["sun"]', JSON.stringify(spaceOnDisk('Work').quietDays));

  /* ------------------------------------------------------------ quiet hours */

  await evalJs(
    s,
    `(() => {
      const from = document.querySelector('#qh-from');
      const to = document.querySelector('#qh-to');
      from.value = '21:30';
      to.value = '07:15';
    })()`
  );
  await press('[data-space-hours="set"]');
  check(
    'the clocks write the window they are showing',
    JSON.stringify(spaceOnDisk('Work').quietHours) === '{"from":"21:30","to":"07:15"}',
    JSON.stringify(spaceOnDisk('Work').quietHours)
  );
  await press('[data-space-hours="clear"]');
  check('and Clear removes them outright', !('quietHours' in spaceOnDisk('Work')), JSON.stringify(spaceOnDisk('Work')));

  /* ------------------------------------------------------------ slack channel */

  /* The one control on the card you type into, and the only one with three answers
     rather than two — so all three are pressed here, and the *file* is what says which
     one landed. `""` and a missing key look identical on the screen and mean opposite
     things to `slackChannelFor`, which is the whole reason this section exists.

     `type` rather than `value =`: the field is drawn from a draft in the page's state
     and the draft is filled by the `input` event, so setting the property alone would
     test a path a thumb never takes — and would pass while a repaint quietly threw the
     typed id away. */
  const type = async (text) =>
    evalJs(
      s,
      `(() => {
        const el = document.querySelector('#slack-channel');
        if (!el) return false;
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    );

  check('the channel field is on the card', await type('C0SPACECHECK'));
  await press('[data-space-channel="set"]');
  check(
    'a typed channel reaches the daemon',
    spaceOnDisk('Work').slackChannel === 'C0SPACECHECK',
    JSON.stringify(spaceOnDisk('Work').slackChannel)
  );

  /* The claim no static read can make: this page repaints off a stream event rather
     than off your thumb, so a poll landing mid-type must not take the id away. */
  await type('C0HALFTYPED');
  await evalJs(s, `window.beadcause.monitor.refresh()`);
  await sleep(700);
  check(
    'and a repaint under your thumb does not take a half-typed one away',
    (await evalJs(s, `document.querySelector('#slack-channel')?.value`)) === 'C0HALFTYPED',
    await evalJs(s, `document.querySelector('#slack-channel')?.value`)
  );

  await press('[data-space-set="slackChannel"][data-value=""]');
  check(
    'Never stores an empty channel — the answer a missing key cannot give',
    spaceOnDisk('Work').slackChannel === '',
    JSON.stringify(spaceOnDisk('Work'))
  );
  check(
    'and the field goes back to what the space says rather than keeping the draft',
    (await evalJs(s, `document.querySelector('#slack-channel')?.value`)) === '',
    await evalJs(s, `document.querySelector('#slack-channel')?.value`)
  );

  await press('[data-space-set="slackChannel"][data-value="null"]');
  check(
    'and Inherit takes the key away, which is the other nothing',
    !('slackChannel' in spaceOnDisk('Work')),
    JSON.stringify(spaceOnDisk('Work'))
  );

  await type('');
  const blank = await press('[data-space-channel="set"]');
  check(
    'Set on a blank field is refused rather than guessed at',
    blank && !('slackChannel' in spaceOnDisk('Work')) && /Type a channel id/.test((await card())?.text || ''),
    JSON.stringify(spaceOnDisk('Work'))
  );

  /* --------------------------------------------------------------- muting */

  await press('[data-space-set="muted"][data-value="true"]');
  const muted = await card();
  check('muting says so on the card, in the words the push path uses', /questions still arrive/.test(muted?.text || ''), muted?.state);
  check(
    'and the picker in the bar above has the 🔕 without waiting for a poll',
    await evalJs(s, `document.querySelector('#space-pick').innerHTML.includes('Work 🔕')`)
  );
  await press('[data-space-set="muted"][data-value="null"]');

  /* -------------------------------------------------- what each repo resolves to */

  await open('What each repo resolves to');
  await sleep(300);
  const repos = await evalJs(
    s,
    `[...document.querySelectorAll('.space-repo')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`
  );
  check(
    'the per-repo panel shows the list that outranks the space, not the space',
    repos.some((r) => r.startsWith('beta') && r.includes('minimal push')) &&
      repos.some((r) => r.startsWith('alpha') && r.includes('no agent replies')),
    repos.join(' | ')
  );

  /* ------------------------------------------------------------ the rest of it */

  check(
    'the gear points at admin',
    await evalJs(s, `document.querySelector('#gear')?.getAttribute('href') === '/admin'`)
  );
  check(
    'and nothing the page already did has gone',
    await evalJs(
      s,
      `Boolean(document.querySelector('#mon-tabs') && document.querySelector('.tabbar') && document.getElementById('tally'))`
    )
  );

  if (SHOT) {
    // Back to the space, with both panels open — the picture is of the card, and a
    // shut card is a picture of a heading.
    await evalJs(s, `window.beadcause.space.set({ space: 'Work', workspace: 'all' })`);
    await sleep(900);
    await open('Settings');
    await open('What each repo resolves to');
    await sleep(400);
    const { data } = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
    console.log(`  ⤷ ${SHOT}`);
  }

  // On `All spaces` there is no one space these would belong to, and the card has to
  // say so rather than keep the last one it drew.
  await evalJs(s, `window.beadcause.space.set({ space: 'all', workspace: 'all' })`);
  await sleep(700);
  check(
    'widening to everything takes the card down and says why',
    await evalJs(
      s,
      `!document.querySelector('.space-card') && /Pick a space/.test(document.querySelector('.space-none')?.textContent || '')`
    )
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
