#!/usr/bin/env node
//
// Can you tell where something is, and whether it is out, from a phone?
//
//   node scripts/releases-check.mjs [--baseline] [--out=DIR]
//
// `test/queues.mjs` proves the daemon's half — that every rung comes off evidence
// somebody wrote down. This is the other half: the real public/releases.js, in a
// headless Chrome the size of a phone, against a stubbed /api/queues and /api/deploys.
//
// Four things are worth a browser here, and they are the four that would be silently
// wrong otherwise:
//
//   • **The stage is the collapsed summary.** A card has to say where the work is
//     without being opened. A page that only said it behind a fold would look fine in
//     a screenshot and be useless in a pocket.
//   • **The whole card is the tap target.** Not the chevron — so the tap is aimed at
//     the middle of the title, where a thumb actually lands, and the ladder has to open.
//   • **`untracked` is never a tick.** Three release rungs are observed by the router's
//     handover trail and by nothing else. On a release that went live with no handover
//     recorded they must read as *not tracked*, in a word, on a screen — a page that
//     filled them in from the current stage would say a verification passed that nobody
//     ran, and that reads exactly like the truth.
//   • **A deploy in flight is on the screen, and the daemon going away is the deploy
//     working.** These cases came here from scripts/prs-check.mjs with the strip itself
//     (bc-khoe.7): while a deploy is restarting beadcause, *neither* endpoint answers,
//     and the page has to say why rather than draw the generic failure.
//
// `--baseline` serves HEAD's releases.js and style.css instead of the working copy, so a
// failure can be told apart from a flake. Against a HEAD with no such page, every case
// fails at once, which is what that should look like.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aliasPage, pageAliases } from '../lib/pagealias.js';
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

/* The two ladders, as lib/queues.js states them. Restated here rather than imported so
   that a rung renamed on the daemon and not on the screen shows up as a failing string
   rather than as two files agreeing with each other about the wrong thing. */
const MERGE_RUNGS = ['Queued for merge', 'Downmerging', 'Resolving conflicts', 'Gate tests', 'Resolving issues'];
const RELEASE_RUNGS = [
  'Merged',
  'Building',
  'Deploying',
  'Deployed to green',
  'Green verification',
  'Swapping to blue',
  'Live',
];

/** `rungs[]` exactly as `rungsFor` builds it: position arithmetic, `handover` held out. */
const rungs = (labels, at, { handover = [], observed = {} } = {}) =>
  labels.map((label, i) => {
    const seen = observed[label] || null;
    return {
      id: label.toLowerCase().replace(/ /g, '-'),
      label,
      note: `what happens at ${label.toLowerCase()}`,
      at: seen,
      state: seen ? 'done' : handover.includes(label) ? 'untracked' : i < at ? 'done' : i === at ? 'now' : 'pending',
    };
  });

/** The three the deploy journal cannot see. See RELEASE_STAGES in lib/queues.js. */
const HANDOVER = ['Deployed to green', 'Green verification', 'Swapping to blue'];

const QUEUES = () => ({
  at: '2026-08-09T09:00:00Z',
  repos: [
    {
      key: 'demo',
      workspace: 'demo',
      repo: 'someone/demo',
      where: 'demo',
      base: 'main',
      deployDeclared: true,
      deployTracked: true,
      releasable: true,
      error: null,
      merge: [
        {
          kind: 'merge',
          workspace: 'demo',
          key: 'demo',
          where: 'demo',
          bead: 'de-a1b',
          mergeBead: 'de-m01',
          number: 41,
          url: 'https://x/41',
          title: 'A branch the gate is still thinking about',
          branch: 'worktree-thing-a1b',
          base: 'main',
          stage: 'gate',
          stageLabel: 'Gate tests',
          note: 'Waiting on the checks.',
          attempts: 1,
          downmerges: 1,
          attemptsLeft: 2,
          refused: null,
          approved: false,
          at: '2026-08-09T08:40:00Z',
          rungs: rungs(MERGE_RUNGS, 3),
        },
        {
          kind: 'merge',
          workspace: 'demo',
          key: 'demo',
          where: 'demo',
          bead: 'de-c3d',
          mergeBead: 'de-m02',
          number: 42,
          url: 'https://x/42',
          title: 'A branch that will not go in on its own',
          branch: 'worktree-other-c3d',
          base: 'main',
          stage: 'conflicts',
          stageLabel: 'Resolving conflicts',
          note: 'The downmerge would not go in on its own.',
          attempts: 2,
          downmerges: 1,
          attemptsLeft: 1,
          refused: 'the branch conflicts with its base',
          approved: false,
          at: '2026-08-09T08:45:00Z',
          rungs: rungs(MERGE_RUNGS, 2),
        },
      ],
      release: [
        {
          kind: 'release',
          workspace: 'demo',
          key: 'demo',
          where: 'demo',
          bead: 'de-e5f',
          beads: ['de-e5f'],
          shipBead: null,
          number: 40,
          url: 'https://x/40',
          title: 'Merged and waiting for the settle window',
          mergedAt: '2026-08-09T08:50:00Z',
          sha: 'abcdef0',
          stage: 'merged',
          stageLabel: 'Merged',
          note: 'Merged and on origin, waiting for a release.',
          deploy: null,
          ago: null,
          handover: null,
          rungs: rungs(RELEASE_RUNGS, 0, { handover: HANDOVER }),
        },
        {
          kind: 'release',
          workspace: 'demo',
          key: 'demo',
          where: 'demo',
          bead: 'de-g7h',
          beads: ['de-g7h', 'de-i9j'],
          shipBead: 'de-s01',
          number: 39,
          url: 'https://x/39',
          title: 'Went out in the release that is running now',
          mergedAt: '2026-08-09T07:10:00Z',
          sha: '9876543',
          stage: 'live',
          stageLabel: 'Live',
          note: 'In what this repo is running.',
          deploy: { id: 'd-old', status: 'ok', startedAt: '2026-08-09T07:20:00Z' },
          ago: 0,
          // Nothing recorded a handover for this one, which is the ordinary case for a
          // repo the router is not in front of — and the whole reason the three rungs
          // below it stay `untracked` rather than being ticked off by `live`.
          handover: null,
          rungs: rungs(RELEASE_RUNGS, 6, { handover: HANDOVER }),
        },
      ],
    },
  ],
  orphans: [],
  counts: { merge: 2, release: 2 },
  unavailable: null,
  errors: [],
  observing: false,
});

/* One deploy record per shape the strip has to draw. The fields are the ones
   lib/deploy.js actually writes — a fixture that invented a `step` field would prove
   the page can read a record no daemon will ever send it. */
const deploy = (over) => ({
  id: 'd-abc',
  workspace: 'demo',
  dir: '/Users/x/repos/demo',
  base: 'main',
  bead: null,
  reason: '',
  restarts: false,
  status: 'ok',
  requestedAt: '2026-08-09T08:59:00Z',
  startedAt: '2026-08-09T08:59:01Z',
  finishedAt: '2026-08-09T08:59:41Z',
  heartbeatAt: '2026-08-09T08:59:41Z',
  pid: 1234,
  from: 'c'.repeat(40),
  to: 'd'.repeat(40),
  changed: ['lib/thing.js'],
  steps: [{ name: 'git fetch', command: ['git', 'fetch'], code: 0, ms: 420 }],
  error: null,
  ...over,
});

/** What GET /api/deploys answers with. Swapped per case; `null` makes it unreachable. */
let DEPLOYS = { deploys: [], deployable: ['demo'] };

/* ------------------------------------------------------------------- the server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// HEAD's copy of the files under test, for --baseline. Written once, served instead.
const headFile = (rel) => {
  try {
    return execFileSync('git', ['show', `HEAD:public/${rel}`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
};
const BASE_FILES = BASELINE ? { 'releases.js': headFile('releases.js'), 'style.css': headFile('style.css') } : {};

/* The extensionless URLs the daemon answers to, read out of lib/server.js rather than
   restated — every one of them is in the service worker's SHELL, and a fixture that
   404d on one would fail the install and post the failure to /api/error. See
   lib/pagealias.js. */
const ALIASES = pageAliases();

function serve() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const json = (b, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (p === '/api/queues') {
      // The one case a stub cannot fake from the outside: while the daemon is being
      // restarted by the deploy the page is watching, *neither* endpoint answers.
      if (!DEPLOYS) return res.destroy();
      return json(QUEUES());
    }
    if (p === '/api/deploys') {
      if (!DEPLOYS) return res.destroy();
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      if (id) {
        const rec = (DEPLOYS.deploys || []).find((d) => d.id === id);
        return rec ? json({ deploy: rec, log: 'the runner said this\nand then this\n' }) : json({ error: 'no' }, 404);
      }
      return json(DEPLOYS);
    }
    if (p.startsWith('/api/')) return json({});

    const rel = aliasPage(p, ALIASES);
    const name = rel.replace(/^\/+/, '');
    if (BASE_FILES[name]) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)] });
      return res.end(BASE_FILES[name]);
    }
    const file = path.join(PUBLIC, rel === '/' ? 'index.html' : name);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

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

/* --------------------------------------------------------------------- probes */

/**
 * Every card, as `kind+tone|title|what the collapsed summary says`.
 *
 * The stage is read out of the *collapsed* card on purpose: that it is readable without
 * a tap is the claim, so a probe that opened the card first could not tell a summary
 * from a fold.
 */
const CARDS = `(() => [...document.querySelectorAll('#releases .queue-card')].map((el) =>
  [...el.classList].filter((c) => c !== 'queue-card' && c !== 'unfolded').sort().join('+').replace(/queue-/g, '') + '|' +
  el.querySelector('.queue-title').textContent.replace(/\\s+/g, ' ').trim() + '|' +
  el.querySelector('.queue-stage').textContent.replace(/\\s+/g, ' ').trim()))()`;

/** The ladder inside whichever card is open, as `state:Label`. */
const RUNGS = `(() => [...document.querySelectorAll('#releases .queue-card.unfolded .queue-rung')].map((el) =>
  [...el.classList].filter((c) => c !== 'queue-rung')[0] + ':' +
  el.querySelector('.queue-rung-name').textContent.trim()))()`;

/** The words on screen against the rungs nothing observed. */
const UNTRACKED = `(() => [...document.querySelectorAll('#releases .queue-card.unfolded .queue-untracked')]
  .map((el) => el.textContent.trim()))()`;

/** The two section headings and their counts. */
const SECTIONS = `(() => [...document.querySelectorAll('#releases .queue-sec')].map((el) =>
  el.dataset.sec + '|' + el.querySelector('.queue-head').textContent.replace(/\\s+/g, ' ').trim()))()`;

/**
 * The deploy strip, one entry per row, as `tone+live|what it says`.
 *
 * The tone is read off the class rather than off a colour, and the sentence is read
 * whole — including the `.sr-only` "deploy:" a reader hears, since the workspace and its
 * state are two spans that only a screen makes into one phrase.
 */
const STRIP = `(() => [...document.querySelectorAll('#releases .deploy')].map((el) =>
  [...el.classList].filter((c) => c !== 'deploy').sort().join('+') + '|' +
  el.querySelector('.deploy-what').textContent.replace(/\\s+/g, ' ').trim()))()`;

const BANNER = `document.querySelector('#releases .deploy-banner')?.textContent.trim() || ''`;

/** Unfold the deploy strip's first row. */
const OPEN_DEPLOY = `(() => {
  const b = document.querySelector('#releases .deploy [data-deploy]');
  if (!b) return false;
  b.click();
  return true;
})()`;

/** What is behind it: the sentence, every step with its verdict, and the log. */
const DEPLOY_BODY = `(() => {
  const el = document.querySelector('#releases .deploy-body');
  if (!el) return null;
  return {
    why: el.querySelector('.deploy-why')?.textContent.trim() || '',
    steps: [...el.querySelectorAll('.deploy-step')].map((s) =>
      (s.classList.contains('bad') ? '✗ ' : '✓ ') + s.querySelector('.deploy-step-name').textContent.trim()),
    out: [...el.querySelectorAll('.deploy-out')].map((p) => p.textContent.trim()),
    log: el.querySelector('.deploy-log')?.textContent.trim() || '',
  };
})()`;

/* ----------------------------------------------------------------------- run */

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome('beadcause-releases-');
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

  await s.send('Page.navigate', { url: `${BASE}/releases` });
  await sleep(900);
  await evalJs(s, `localStorage.setItem('beadcause.token', 'x')`);
  await s.send('Page.navigate', { url: `${BASE}/releases` });
  await sleep(1600);

  /* ------------------------------------------------------------- the two queues */

  console.log('the two queues');

  const secs = await evalJs(s, SECTIONS);
  ok(
    secs.length === 2 && /^merge\|Merging 2/.test(secs[0] || '') && /^release\|Releasing 2/.test(secs[1] || ''),
    `both queues are drawn, each with its own count — ${JSON.stringify(secs)}`
  );

  const cards = await evalJs(s, CARDS);
  ok(cards.length === 4, `one card per entry, both kinds — ${cards.length} drawn`);
  ok(
    /^live\+merge\|/.test(cards[0] || '') && /Gate tests$/.test(cards[0] || ''),
    `a merge card says its stage without being opened — "${cards[0]}"`
  );
  ok(
    /^merge\+warn\|/.test(cards[1] || '') && /Resolving conflicts$/.test(cards[1] || ''),
    `and a branch that will not go in reads as one at a glance — "${cards[1]}"`
  );
  ok(
    /^live\+release\|/.test(cards[2] || '') && /Merged$/.test(cards[2] || ''),
    `a release card waiting for the settle window says so — "${cards[2]}"`
  );
  ok(
    /^good\+release\|/.test(cards[3] || '') && /live in what is running now$/.test(cards[3] || ''),
    `and one that is out says which release it went out in — "${cards[3]}"`
  );

  /* --------------------------------------------------------------- it fits the phone */

  /**
   * Nothing on this page is wider than the phone — and this is the assertion that would
   * have caught the bug it was written for.
   *
   * `.work`, which is what every scroller in this app is, carries `margin: 0 auto`. An
   * auto cross-axis margin on a flex item turns `align-self: stretch` **off**, so the
   * scroller is sized `fit-content` — `min(max-content, max(min-content, available))`.
   * A card title with `white-space: nowrap` makes min-content the whole string, so one
   * long pull request title made the page 56px wider than the phone and every card,
   * every heading and the deploy strip hung off the right-hand edge. `body { overflow:
   * hidden }` clipped it, so there was no scrollbar and nothing said it had happened —
   * the screen simply had its right edge missing.
   */
  console.log('\nit fits the phone');

  const fit = await evalJs(s, `(() => {
    const m = document.querySelector('main.pagescroll');
    const over = [...document.querySelectorAll('#releases *')]
      .filter((el) => Math.round(el.getBoundingClientRect().right) > innerWidth)
      .map((el) => el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
    return { main: Math.round(m.getBoundingClientRect().width), vw: innerWidth, over: [...new Set(over)] };
  })()`);
  ok(fit.main <= fit.vw, `the scroller is the width of the phone — ${fit.main} against ${fit.vw}`);
  ok(fit.over.length === 0, `nothing hangs off the right-hand edge — ${JSON.stringify(fit.over)}`);

  /* -------------------------------------------------------- the card is the target */

  console.log('\nthe whole card is the tap target');

  // Aimed at the title, which is where a thumb lands — not at the chevron, which is a
  // hint about what a tap does and never the thing you have to hit.
  await evalJs(s, `document.querySelectorAll('#releases .queue-card .queue-title')[0].click()`);
  await sleep(200);
  let rungs4 = await evalJs(s, RUNGS);
  ok(
    rungs4.length === 5 && rungs4.join(' ') === 'done:Queued for merge done:Downmerging done:Resolving conflicts now:Gate tests pending:Resolving issues',
    `tapping the title opens the whole merge ladder — ${JSON.stringify(rungs4)}`
  );
  ok(
    (await evalJs(s, `!!document.querySelector('#releases .queue-card.unfolded .queue-rung-note')`)),
    'and the rung it is on carries the sentence explaining it'
  );

  await evalJs(s, `document.querySelectorAll('#releases .queue-card .queue-title')[0].click()`);
  await sleep(200);
  ok((await evalJs(s, RUNGS)).length === 0, 'and tapping it again folds it');

  /* ------------------------------------------------------- untracked is not a tick */

  console.log('\na rung nobody observed');

  // The live one: everything before it is behind it, and the three the deploy journal
  // cannot see are still untracked. This is the assertion the whole ladder exists for.
  await evalJs(s, `document.querySelectorAll('#releases .queue-card .queue-title')[3].click()`);
  await sleep(200);
  const ladder = await evalJs(s, RUNGS);
  ok(
    ladder.length === 7 && !ladder.some((r) => r.startsWith('done:Green verification')),
    `a green verification nobody recorded is never ticked — ${JSON.stringify(ladder)}`
  );
  ok(
    ladder.filter((r) => r.startsWith('untracked:')).length === 3,
    `the three the journal cannot see are untracked, on a release that is live — ${JSON.stringify(ladder)}`
  );
  ok(
    ladder.includes('now:Live'),
    'and the entry itself is on the last rung, which is what makes the three above it a claim rather than a gap'
  );
  const words = await evalJs(s, UNTRACKED);
  ok(
    words.length === 3 && words.every((w) => /not tracked/i.test(w)),
    `each of them says so in a word, not just in a colour — ${JSON.stringify(words)}`
  );
  await evalJs(s, `document.querySelectorAll('#releases .queue-card .queue-title')[3].click()`);
  await sleep(200);

  /* ---------------------------------------------------------- the deploy strip */

  console.log('\nwhat is deploying right now');

  ok(
    (await evalJs(s, `document.querySelectorAll('#releases .deploy').length`)) === 0,
    'a repo nobody has deployed from here gets no strip at all'
  );

  // A restart in flight — the case the whole strip exists for, since the deploy is
  // about to kill the daemon serving this page.
  DEPLOYS = {
    deployable: ['demo'],
    deploys: [
      deploy({
        id: 'd-live',
        status: 'deploying',
        restarts: true,
        finishedAt: null,
        bead: 'de-a1b',
        reason: 'shipped from the board',
        steps: [
          { name: 'git fetch', command: ['git', 'fetch'], code: 0, ms: 380 },
          { name: 'git merge --ff-only', command: ['git', 'merge'], code: 0, ms: 90 },
        ],
      }),
    ],
  };
  await evalJs(s, `document.getElementById('refresh').click()`);
  await sleep(900);
  let strip = await evalJs(s, STRIP);
  ok(strip.length === 1 && /live/.test(strip[0]), `a deploy in flight is on the screen — ${JSON.stringify(strip)}`);
  ok(
    /demo deploy: running the deploy · restarting beadcause/.test(strip[0] || ''),
    `and says which repo, which step, and that this page is about to go — "${strip[0]}"`
  );
  ok(
    (await evalJs(s, `document.querySelectorAll('#releases .queue-card').length`)) === 4,
    'the queues underneath are untouched'
  );

  await evalJs(s, OPEN_DEPLOY);
  await sleep(700);
  let body = await evalJs(s, DEPLOY_BODY);
  ok(
    JSON.stringify(body?.steps) === JSON.stringify(['✓ git fetch', '✓ git merge --ff-only']),
    `unfolding it lists what has actually run — ${JSON.stringify(body?.steps)}`
  );
  ok(/the runner said this/.test(body?.log || ''), 'and fetches what the runner printed');
  ok(
    await evalJs(s, `!!document.querySelector('#releases .deploy-body .pill.id')`),
    'the bead that asked for it is a link'
  );
  await evalJs(s, OPEN_DEPLOY);

  /* ------------------------------------------------- the daemon going away */

  console.log('\nwhen the deploy takes the daemon with it');

  DEPLOYS = null;
  // Its own clock, four seconds while something is live. Nothing is clicked here on
  // purpose: the page has to notice the daemon is gone without being asked.
  await sleep(6000);
  ok(/restarting/.test(await evalJs(s, BANNER)), `the dropped connection reads as the deploy — "${await evalJs(s, BANNER)}"`);
  ok(
    (await evalJs(s, `document.querySelectorAll('#releases .queue-card').length`)) === 4,
    'and the queues that were already drawn are still there to come back to'
  );
  ok(
    !/Can't reach the server/.test(await evalJs(s, `document.getElementById('releases').textContent`)),
    'not the generic failure, which would have thrown away the thing that explains it'
  );

  /* ------------------------------------------------------------ the four endings */

  console.log('\nhow it ended');

  DEPLOYS = {
    deployable: ['demo'],
    deploys: [
      deploy({
        id: 'd-live',
        status: 'unconfirmed',
        restarts: true,
        finishedAt: '2026-08-09T09:00:10Z',
        error: 'The deploy command ran and the runner did not outlive it — which is what a restart looks like from here.',
        steps: [{ name: 'git fetch', command: ['git', 'fetch'], code: 0, ms: 380 }],
      }),
      deploy({
        id: 'd-bad',
        status: 'failed',
        error: 'the deploy command failed (exit 1)',
        steps: [
          { name: 'git fetch', command: ['git', 'fetch'], code: 0, ms: 380 },
          { name: 'deploy', command: ['launchctl', 'kickstart'], code: 1, ms: 1200, output: 'Could not find service\n' },
        ],
      }),
    ],
  };
  await sleep(6000);
  strip = await evalJs(s, STRIP);
  ok(await evalJs(s, `!${BANNER}`), 'the banner goes when the daemon answers again');
  ok(
    /warn/.test(strip[0] || '') && /unconfirmed/.test(strip[0] || ''),
    `a restart nobody outlived is unconfirmed, not a tick — ${JSON.stringify(strip[0])}`
  );
  ok(
    /bad/.test(strip[1] || '') && /failed/.test(strip[1] || ''),
    `and a real failure is marked as one — ${JSON.stringify(strip[1])}`
  );

  await evalJs(s, OPEN_DEPLOY);
  await sleep(700);
  body = await evalJs(s, DEPLOY_BODY);
  ok(/did not outlive it/.test(body?.why || ''), `the ending says what is not known, in words — "${body?.why}"`);

  await evalJs(s, OPEN_DEPLOY);
  await evalJs(s, `(() => document.querySelectorAll('#releases .deploy [data-deploy]')[1].click())()`);
  await sleep(700);
  body = await evalJs(s, DEPLOY_BODY);
  ok(
    JSON.stringify(body?.steps) === JSON.stringify(['✓ git fetch', '✗ deploy']),
    `a failed deploy shows the step it broke at — ${JSON.stringify(body?.steps)}`
  );
  ok(
    body?.out.length === 1 && /Could not find service/.test(body.out[0]),
    `with what that step printed, and nothing from the ones that worked — ${JSON.stringify(body?.out)}`
  );

  if (outDir) {
    await s.send('Page.navigate', { url: `${BASE}/releases` });
    await sleep(1500);
    fs.mkdirSync(outDir, { recursive: true });
    for (const scheme of ['dark', 'light']) {
      await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await sleep(300);
      const shot = await s.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, `releases-${scheme}.png`), Buffer.from(shot.data, 'base64'));
    }
    console.log(`\n  screenshots in ${outDir}`);
  }
} finally {
  chrome.close();
  server.close();
}

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
process.exit(failures ? 1 : 0);
