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
// So this one drives the real `public/config.js` in a headless Chrome the size of a
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
import { onExit, killAndRemoveSync } from '../lib/teardown.js';

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
/**
 * And again for the endings the `finally` at the bottom cannot reach — bc-5isv.
 *
 * This is the only check that starts a *daemon*, and a daemon that outlives its check is
 * worse than a leaked Chrome: it goes on listening on a loopback port, out of a worktree
 * that the attic sweep will later remove out from under it, because a running process
 * does not lock a worktree. One was found doing exactly that, seven days after the run
 * that started it. `scripts/checks.mjs` SIGTERMs anything that overruns its timeout, and
 * a `finally` does not run on a signal. See lib/teardown.js.
 */
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
  // `/config` since bc-khoe.10. The card was a section of the advocate console and then
  // a chip on it; it is a page of its own now, so this check opens the page rather than
  // opening the console and tapping a chip to reach it.
  await s.send('Page.navigate', { url: `${BASE}/config?t=${TOKEN}` });
  await sleep(1200);

  /* ------------------------------------------- waiting for the page, not for a clock

     Every press on this card is two requests and a repaint, in that order: `POST
     /api/space`, then `GET /api/spaces` so the bar's 🔕 comes off the config that was
     just written, then `render()`. Each press used to be followed by a flat
     `sleep(700)`, which is a stopwatch bet that all three fit in that window.

     On a loaded Mac they do not, and the way it loses is not a timeout — it is a red
     that reads as a behaviour bug. `Clear` is only drawn while the space *has* quiet
     hours, so a press that arrives before the redraw finds no button, clicks nothing,
     and the assertion under it reports that Clear left the hours in place. The repo
     row does the same one press later. That is bc-khoe.67: three reds in one run,
     filed against a commit whose only change to public/config.js was the word
     "space" → "group".

     So the check waits for the page to stop talking to the daemon instead. `fetch` is
     counted here, and `quiet()` returns once every request a press started has
     finished and nothing new has started for ~150ms. It is bounded: a write that
     genuinely never lands still fails its own assertion, on the same wording, a few
     seconds later rather than 700ms later.

     Presence is excluded because it is the one request on this page nobody pressed —
     a 45-second heartbeat that would otherwise be free to satisfy "a request started"
     on behalf of a click that issued none. */
  await evalJs(
    s,
    `(() => {
      if (window.__bcReq) return true;
      const req = { started: 0, done: 0 };
      window.__bcReq = req;
      const real = window.fetch;
      window.fetch = (...a) => {
        const url = String(typeof a[0] === 'string' ? a[0] : a[0]?.url || '');
        if (url.includes('/api/presence')) return real(...a);
        req.started += 1;
        return real(...a).finally(() => {
          req.done += 1;
        });
      };
      return true;
    })()`
  );

  /** How many requests this page has started so far — the mark a `quiet()` waits past. */
  const started = async () => (await evalJs(s, `window.__bcReq.started`)) ?? 0;

  /**
   * Wait until the page has finished what the last action set going.
   *
   * `from` is the count taken *before* the action: without it a poll landing in the
   * moment between the click and its own `fetch` would read "nothing in flight" and
   * return while the write was still being assembled. Three consecutive quiet polls
   * rather than one, because a press's second request starts in the microtask after
   * its first resolves, and a single poll can land in that gap.
   *
   * `GRACE` is for the press that is *supposed* to send nothing. Set on a blank channel
   * field is refused in public/config.js without a request — that refusal is one of the
   * assertions below — and a wait keyed only on "a request started" would sit out its
   * whole deadline for it. A handler that does fetch calls it in the same task as the
   * click, so anything that has sent nothing 600ms later was never going to.
   */
  const GRACE = 600;
  const quiet = async (from, { ms = 12000 } = {}) => {
    const began = Date.now();
    const deadline = began + ms;
    let still = 0;
    while (Date.now() < deadline) {
      await sleep(50);
      const [s1, d1] = await evalJs(s, `[window.__bcReq.started, window.__bcReq.done]`);
      if (s1 === from && Date.now() - began > GRACE) return true;
      still = s1 > from && s1 === d1 ? still + 1 : 0;
      if (still >= 3) return true;
    }
    return false;
  };

  /** Run an expression that talks to the daemon, and wait for the page to catch up. */
  const settle = async (expr) => {
    const before = await started();
    const out = await evalJs(s, expr);
    await quiet(before);
    return out;
  };

  // Narrow to a space, through the picker rather than by writing state.json: the card
  // is drawn from `beadcause.space.filter`, so a filter set behind its back would test
  // the card and not the thing that feeds it.
  await settle(`window.beadcause.space.set({ space: 'Work', workspace: 'all' })`);

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
    const before = await started();
    const hit = await evalJs(
      s,
      `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); return true; })()`
    );
    // A selector that matched nothing sent nothing, so there is nothing to wait for —
    // and waiting the deadline out for it would turn one absent button into a
    // twelve-second pause. The `false` is what the assertion above it should say.
    if (hit) await quiet(before);
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

  const satOn = await press('[data-space-day="sat"]');
  const sunOn = await press('[data-space-day="sun"]');
  check(
    'a day toggles on and the list accumulates',
    satOn && sunOn && JSON.stringify(spaceOnDisk('Work').quietDays) === '["sun","sat"]',
    satOn && sunOn ? JSON.stringify(spaceOnDisk('Work').quietDays) : 'no day button on the card to press'
  );
  const satOff = await press('[data-space-day="sat"]');
  check(
    'and toggles back off',
    satOff && JSON.stringify(spaceOnDisk('Work').quietDays) === '["sun"]',
    satOff ? JSON.stringify(spaceOnDisk('Work').quietDays) : 'no day button on the card to press'
  );

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
  const setHours = await press('[data-space-hours="set"]');
  check(
    'the clocks write the window they are showing',
    setHours && JSON.stringify(spaceOnDisk('Work').quietHours) === '{"from":"21:30","to":"07:15"}',
    setHours ? JSON.stringify(spaceOnDisk('Work').quietHours) : 'no Set button on the card to press'
  );
  // Drawn only while the space *has* quiet hours, so an absent one means the press
  // above has not been redrawn yet rather than that Clear is broken — which is the
  // whole of bc-khoe.67, and why this one says which of the two it was.
  const clearedHours = await press('[data-space-hours="clear"]');
  check(
    'and Clear removes them outright',
    clearedHours && !('quietHours' in spaceOnDisk('Work')),
    clearedHours ? JSON.stringify(spaceOnDisk('Work')) : 'no Clear button on the card to press'
  );

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
  await settle(`window.beadcause.config.refresh()`);
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

  /* One row in that panel is a control, and it writes a *different body* from every
     other press on this card — `{space, workspace, settings}` rather than `{space,
     settings}`. That is exactly the shape a fixture would be free to get right while
     the page got it wrong, so it is pressed here against the real daemon and read back
     off the config file: the whole feature is that beadcause can stop holding while the
     repo beside it in the same space goes on holding. */
  const endorsed = await press('[data-repo-set="autoEndorse"][data-repo="alpha"][data-value="true"]');
  check(
    'a repo row`s On reaches the daemon as that repo`s own answer, not the space`s',
    endorsed && onDisk().autoEndorsePerWorkspace?.alpha === true && !('autoEndorse' in spaceOnDisk('Work')),
    JSON.stringify(onDisk().autoEndorsePerWorkspace || null)
  );
  check(
    'and the repo beside it in the same space is untouched — the point of the whole row',
    !('beta' in (onDisk().autoEndorsePerWorkspace || {})),
    JSON.stringify(onDisk().autoEndorsePerWorkspace || null)
  );
  const afterRepo = await evalJs(
    s,
    `[...document.querySelectorAll('.space-repo')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`
  );
  check(
    'the row redraws with the resolved tag and the pressed button agreeing',
    afterRepo.some((r) => r.startsWith('alpha') && r.includes('files endorsed')),
    afterRepo.find((r) => r.startsWith('alpha'))
  );

  await press('[data-repo-set="autoEndorse"][data-repo="alpha"][data-value="null"]');
  check(
    'and Inherit takes the key out rather than storing a false the space cannot override',
    !('alpha' in (onDisk().autoEndorsePerWorkspace || {})),
    JSON.stringify(onDisk().autoEndorsePerWorkspace || null)
  );

  /* The setting the per-repo layer was generalised for, pressed the same way and read
     back off the file the release queue's resolver reads. It is a different map from the
     one above, so a page that had learned only one field name would pass everything
     before this line and write nothing here. */
  const shipped = await press('[data-repo-set="autoShip"][data-repo="alpha"][data-value="true"]');
  check(
    'the ship row writes its own map, so one repo may ship itself while its space does not',
    shipped && onDisk().autoShipPerWorkspace?.alpha === true && !('autoShip' in spaceOnDisk('Work')),
    JSON.stringify(onDisk().autoShipPerWorkspace || null)
  );
  const afterShip = await evalJs(
    s,
    `[...document.querySelectorAll('.space-repo')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`
  );
  check(
    'and its tag says so while the repo beside it goes on waiting for the button',
    afterShip.some((r) => r.startsWith('alpha') && r.includes('ships itself')) &&
      afterShip.some((r) => r.startsWith('beta') && r.includes('waits for Ship')),
    afterShip.find((r) => r.startsWith('alpha'))
  );
  await press('[data-repo-set="autoShip"][data-repo="alpha"][data-value="null"]');

  /* --------------------------------------------- narrowed to one of those repos */

  /* The picker has two levels and this card only ever read the coarse one: pinning to
     `alpha` still drew beta beside it, under a heading that says "each repo" — the
     console answering a question about a repo you did not pick (bc-me2b). Pressed
     through the picker's own `set` rather than by editing state, because the fine level
     is exactly what the old card ignored and a fixture that set it directly would be
     testing this file rather than the page.

     The settings above stay the space's, and that is asserted here too: `quietDays` is
     not a property of a repo, and a card that had narrowed *those* would be promising a
     narrowing the config cannot express. */
  await settle(`window.beadcause.space.set({ space: 'Work', workspace: 'alpha' })`);
  await open('What alpha resolves to');
  await sleep(300);
  const pinned = await evalJs(
    s,
    `[...document.querySelectorAll('.space-repo')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`
  );
  check(
    'pinning the picker to one repo draws that repo alone, not its space`s five',
    pinned.length === 1 && pinned[0].startsWith('alpha'),
    pinned.join(' | ')
  );
  check(
    'and the panel heading names it rather than promising each of them',
    await evalJs(
      s,
      `[...document.querySelectorAll('.space-card .mon-sum')].some((x) => /What alpha resolves to/.test(x.textContent))`
    )
  );
  check(
    'while the settings above are still the whole space`s — a repo has no quiet days',
    await evalJs(
      s,
      `[...document.querySelectorAll('.space-card .space-what')].map((x) => x.textContent).includes('Quiet days')`
    )
  );
  await settle(`window.beadcause.space.set({ space: 'Work', workspace: 'all' })`);
  const widened = await evalJs(
    s,
    `[...document.querySelectorAll('.space-repo')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`
  );
  check(
    'and widening back to the space brings the repo beside it back',
    widened.length === 2,
    widened.map((r) => r.split(' ')[0]).join(', ')
  );

  /* ------------------------------- the four things that have to name one space */

  /*
    bc-ka5y.32, reported from the phone: change the space and the label immediately left
    of the ▾ keeps the old one, until the page is reloaded.

    The control is four readings of one selection, and only three of them are written by
    code. `.spacepick-shown` is the span the script fills; `select.title` is the whole
    name for a thumb that hovers; the card under the bar is what the page decided to
    draw — and `select.value` is *moved by the browser*, on the pick itself, with no line
    of ours involved. `paint()` used to set it only as a side effect of rebuilding the
    rows, behind a guard that skips the rebuild when the rows come out identical to the
    ones last written. So a value that moved without a `change` reaching the file was
    never put back by anything: not by the next payload, and not even by one that
    rebuilt every row, because identical rows are exactly the case the guard skips.

    Nothing in `node:vm` can see that half. test/spacebar.mjs's `<select>` is an object
    whose `value` is whatever the check last assigned to it, so it agrees by
    construction — the disagreement only exists in a control a browser is driving. Which
    is why the whole of it is asserted here, on a real pick, in one turn and then again
    after the page has handed the picker its next payload.
  */
  const facing = () =>
    evalJs(
      s,
      `(() => {
        const sel = document.querySelector('#space-pick');
        const sp = window.beadcause?.space;
        return {
          shown: document.querySelector('#space-shown')?.textContent,
          value: sel?.value,
          title: sel?.title,
          // What the row the dropdown is actually holding says. The one reading that
          // tells "nothing is selected" apart from "its first row is" — a <select> whose
          // value matches no option shows the first, and "All spaces" over a narrowed
          // list is the failure that looks most like success.
          row: sel?.selectedOptions?.[0]?.textContent,
          label: sp?.label(),
          card: document.querySelector('.space-card h2')?.textContent,
        };
      })()`
    );

  /** All four naming the same space, said as one check so a failure names which one drifted. */
  const agreeing = async (what, space) => {
    const f = await facing();
    const wrong = [
      f.shown === space ? '' : `the bar says ${JSON.stringify(f.shown)}`,
      f.value === `space:${space}` ? '' : `the select holds ${JSON.stringify(f.value)} (${JSON.stringify(f.row)})`,
      f.title === space ? '' : `its title says ${JSON.stringify(f.title)}`,
      f.card === space ? '' : `the card says ${JSON.stringify(f.card)}`,
    ].filter(Boolean);
    check(what, wrong.length === 0 && f.label === space, wrong.length ? wrong.join('; ') : space);
  };

  /* Through the control rather than through `space.set`: the value the browser moves is
     the whole subject, and a programmatic `set` never moves it. This is the pick. */
  const pickInBar = async (value) => {
    await evalJs(
      s,
      `(() => {
        const sel = document.querySelector('#space-pick');
        sel.value = ${JSON.stringify(value)};
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return sel.value;
      })()`
    );
    await sleep(900);
  };

  await pickInBar('space:Side');
  await agreeing('a pick names the new space in the bar, the select, its title and the card', 'Side');

  await pickInBar('space:Work');
  await agreeing('and picking back again moves all four, not three of them', 'Work');

  /* The next payload. A real one: pressing a setting on the card is what hands the picker
     a fresh `spaces` list (`saveSpace` in public/config.js), which is a `paint()` with
     nothing about the selection in it — the case a repaint is most likely to get wrong. */
  await press('[data-space-set="autoMerge"][data-value="false"]');
  await agreeing('and they still agree once the page has handed over its next payload', 'Work');
  await press('[data-space-set="autoMerge"][data-value="null"]');

  /* And the reported failure itself, staged the only way a check can stage it: the value
     moved with no `change` behind it, which is what the browser does on the pick and what
     a form restore does after a back navigation. Nothing has told the picker, so nothing
     could have corrected it yet — what is asserted is that the next paint puts it back
     rather than leaving the two to disagree until a reload. */
  await evalJs(s, `document.querySelector('#space-pick').value = 'space:Side'`);
  const behind = await facing();
  check(
    'the select`s value can move behind the picker`s back — the premise of the bug',
    behind.value === 'space:Side' && behind.shown === 'Work',
    `${behind.shown} / ${behind.value}`
  );
  await press('[data-space-set="autoMerge"][data-value="false"]');
  await agreeing('and the next paint puts it back rather than waiting for a reload', 'Work');
  await press('[data-space-set="autoMerge"][data-value="null"]');

  /* The other way they can part, and the reason the fallback matters: a filter outlives
     the config it was picked under, so a repo retired from /admin — or a space renamed in
     the config file — leaves the picker pinned to a name the next payload does not carry.
     With no row holding it the `<select>` shows its first, and the bar reads "All spaces"
     over a list that is still narrowed to the repo the label names.

     Driven through `adopt` because that is the seam every page feeds this file through
     and a retire is exactly this payload — a `workspaces` list with the name gone. The
     daemon reconciles a stale pin on the way out (`reconcileFilter`), so this is the
     window between the two, which is where the phone lives. */
  await settle(`window.beadcause.space.set({ space: 'Work', workspace: 'alpha' })`);
  await evalJs(s, `window.beadcause.space.adopt({ workspaces: ['beta'] })`);
  await sleep(400);
  const gone = await facing();
  check(
    'a repo the config no longer offers keeps its row rather than reading as All spaces',
    gone.value === 'ws:alpha' && gone.shown === 'alpha' && /alpha/.test(gone.row || ''),
    `${gone.shown} / ${gone.value} / ${JSON.stringify(gone.row)}`
  );
  await evalJs(s, `window.beadcause.space.adopt({ workspaces: ['alpha', 'beta'] })`);
  await sleep(300);
  await settle(`window.beadcause.space.set({ space: 'Work', workspace: 'all' })`);

  /* ------------------------------------------------------------ the rest of it */

  /* Where the card is drawn, which is the other half of bc-khoe.10. Everything above
     this line was pressed on /config — so this is the claim that the thirty checks before
     it were not quietly passing against a card still on the console. */
  check(
    'the card is the page — it is in #space, and this is /config',
    await evalJs(s, `Boolean(document.querySelector('#space .space-card')) && location.pathname === '/config'`)
  );
  check(
    'and the pill that reaches it is on the row, lit',
    await evalJs(
      s,
      `(() => {
        const row = document.querySelector('.viewbar');
        if (!row) return false;
        const lit = row.querySelector('[aria-current="page"]');
        return Boolean(lit && /config/i.test(lit.textContent));
      })()`
    )
  );

  if (SHOT) {
    // Back to the space, with both panels open — the picture is of the card, and a shut
    // card is a picture of a heading.
    await settle(`window.beadcause.space.set({ space: 'Work', workspace: 'all' })`);
    await open('Settings');
    await open('What each repo resolves to');
    await sleep(400);
    const { data } = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
    console.log(`  ⤷ ${SHOT}`);
  }

  // On `Everything` there is no one group these would belong to, and the card has to
  // say so rather than keep the last one it drew.
  await settle(`window.beadcause.space.set({ space: 'all', workspace: 'all' })`);
  check(
    'widening to everything takes the card down and says why',
    await evalJs(
      s,
      `!document.querySelector('.space-card') && /Pick a group/.test(document.querySelector('.space-none')?.textContent || '')`
    )
  );
} finally {
  disarmExit();
  close();
  // Through `killAndRemoveSync` rather than `kill()` and an `rmSync` beside it, which is
  // what this was and which fails the check *after* all 39 assertions have passed.
  //
  // `kill()` is not a wait — it returns once the signal is queued — and this daemon keeps
  // a git repository under its config directory, so the delete on the next line walks a
  // tree something is still writing into and throws `ENOTEMPTY` on `config/.git`. Nothing
  // catches it, so a run whose every assertion was green exits 1 on its own teardown.
  // Watched happening 2026-08-25, and `maxRetries: 3` cannot help: that is `rmSync`'s own
  // retry of a failed *unlink*, not of a directory being repopulated behind it. Same bug
  // and same fix as bc-beleq.1 in test/advswitch.mjs; lib/teardown.js is the one copy of
  // it, it never throws, and this file already imported it for the signal path.
  if (!KEEP) killAndRemoveSync(daemon, tmp);
  else {
    daemon.kill();
    console.log(`\nkept ${CONFIG_DIR}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n\x1b[31m${failed.length} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
