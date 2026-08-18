#!/usr/bin/env node
//
// Does the Skills view read on a phone — and does it still say what it cannot measure?
//
//   node scripts/skills-check.mjs [--shot FILE] [--keep]
//
// test/skills.mjs holds the payload: which state a candidate is in, what the ledger adds
// up to, that `untracked` is never empty. None of that is a claim about a screen, and the
// three ways bc-dgx7.5 actually fails all are:
//
//   1. **The untracked four quietly stop being drawn.** The whole design of the page is
//      that a screen with a candidate list and no adoption section reads as a healthy
//      programme rather than an incomplete one. A render change that dropped the section,
//      or a payload that stopped carrying it, would look *better* — fewer apologies on a
//      tidy screen — and would be the one regression nobody reports.
//   2. **A candidate is on screen and its bead is not reachable from it.** That is the
//      bead's second acceptance sentence, and the failure is silent: a row that draws its
//      title as text rather than a link looks identical until somebody taps it.
//   3. **It overflows 393px.** Every long string here comes from somewhere else — a bead
//      title, a `Revoked before endorsement …` reason, a repo key like
//      `climative/athena-service` — so the page is only ever as narrow as the widest thing
//      the tracker hands it, which is not a thing its author can see.
//
// It runs against a stub server rather than the daemon: the payload is `/api/skills`'s and
// nothing else on the page fetches, so a check that needed a tracker, a checkout and an
// audit ledger to prove a screen draws would be a check nobody runs. The fixture is
// deliberately the *rich* case — two skills, all four candidate states, a miss, two
// checkouts — because every empty list draws the same and the crowded screen is where a
// layout gives way. The empty case is checked too, on the one thing that must survive it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const KEEP = process.argv.includes('--keep');
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i === -1 || i === process.argv.length - 1 ? null : path.resolve(process.argv[i + 1]);
})();
// The phone. This app is a phone app, and 393px is where the long strings above give way.
const VP = { width: 393, height: 852, dpr: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------ the fixture */

const FULL = {
  workspace: '',
  space: 'all',
  library: [
    {
      command: 'b7e-context',
      where: ['beadcause'],
      candidate: { id: 'bc-dgx7.31', workspace: 'beadcause', state: 'accepted' },
    },
    { command: 'b7e-landed', where: ['beadcause', 'climative/athena-service'], candidate: null },
  ],
  candidates: {
    counts: { filed: 4, waiting: 1, accepted: 1, declined: 1, superseded: 1 },
    rows: [
      {
        id: 'bc-9kq1',
        workspace: 'beadcause',
        title: 'b7e-debrief — read every debrief on a bead family in one call',
        command: 'b7e-debrief',
        state: 'waiting',
        status: 'open',
        priority: 2,
        at: '2026-08-17T09:00:00Z',
        movedAt: '2026-08-17T09:00:00Z',
        closeReason: '',
        supersededBy: '',
      },
      {
        id: 'bc-dgx7.31',
        workspace: 'beadcause',
        title: 'b7e-context — one command assembles a session opening context',
        command: 'b7e-context',
        state: 'accepted',
        status: 'closed',
        priority: 2,
        at: '2026-08-15T09:00:00Z',
        movedAt: '2026-08-17T09:00:00Z',
        closeReason: 'Merged #431 as 0f2a11cc into main',
        supersededBy: '',
      },
      {
        id: 'bc-9kq4',
        workspace: 'beadcause',
        title: 'b7e-tidy — sweep the retired worktrees older than two days',
        command: 'b7e-tidy',
        state: 'declined',
        status: 'closed',
        priority: 2,
        at: '2026-08-14T09:00:00Z',
        movedAt: '2026-08-17T09:00:00Z',
        closeReason: 'Revoked before endorsement — the ship skill already sweeps the attic',
        supersededBy: '',
      },
      {
        id: 'bc-9kq5',
        workspace: 'climative',
        title: 'b7e-notes — read the repo notes for a checkout',
        command: 'b7e-notes',
        state: 'superseded',
        status: 'open',
        priority: 2,
        at: '2026-08-13T09:00:00Z',
        movedAt: '2026-08-17T09:00:00Z',
        closeReason: '',
        supersededBy: 'bc-dgx7.31',
      },
    ],
  },
  audit: {
    runs: 3,
    audited: 21,
    misses: [{ slug: 'b7e-context', existing: 'b7e-context', sessions: ['bc-a', 'bc-b', 'bc-c'], key: 'beadcause' }],
    lastAt: '2026-08-17T08:20:00Z',
    enabled: true,
    every: 5,
    cooldownMinutes: 60,
    max: 12,
    minSessions: 3,
  },
  checkouts: [
    {
      key: 'beadcause',
      workspace: 'beadcause',
      repo: '',
      dir: '/x',
      library: ['b7e-context', 'b7e-landed'],
      runs: 3,
      audited: 21,
      filed: 4,
      at: '2026-08-17T08:20:00Z',
      problem: '',
    },
    {
      key: 'climative/athena-service',
      workspace: 'climative',
      repo: 'athena-service',
      dir: '/y',
      library: ['b7e-landed'],
      runs: 0,
      audited: 0,
      filed: 0,
      at: null,
      problem: '',
    },
  ],
  untracked: [
    { id: 'calls', metric: 'Calls per skill, and how many distinct sessions made them', why: 'Nothing records a skill call yet, and neither a shell nor an exited session leaves a trace of one.', owed: 'bc-dgx7.6' },
    { id: 'adopt', metric: 'Time to adopt — a skill landing to its first call by a session that did not build it', why: 'Both ends are missing: nothing stamps the shipping moment and nothing records the call.', owed: 'bc-dgx7.6' },
    { id: 'dead', metric: 'Dead skills — no call in thirty days', why: 'A skill with no calls recorded is indistinguishable from one whose calls nothing records.', owed: 'bc-dgx7.6' },
    { id: 'bytes', metric: 'Prompt bytes removed, and cost per session before and after', why: 'Nothing measures a prompt either side of the swap that would remove them.', owed: 'bc-dgx7.4' },
  ],
  errors: [],
};

// Every list empty — which is exactly what this install answers today, and the state the
// page is most likely to be *read* in for the next few weeks.
const EMPTY = {
  ...FULL,
  library: [],
  candidates: { counts: { filed: 0, waiting: 0, accepted: 0, declined: 0, superseded: 0 }, rows: [] },
  audit: { ...FULL.audit, runs: 0, audited: 0, misses: [], lastAt: null },
  checkouts: [],
};

/* ------------------------------------------------------------------- the server */

let payload = FULL;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(url.pathname === '/api/skills' ? payload : {}));
    return;
  }
  // The one alias this page has that matters here; the rest is public/ served flat.
  const rel = url.pathname === '/skills' ? '/skills.html' : url.pathname;
  const file = path.join(PUBLIC, rel);
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const { s, close } = await launchChrome('beadcause-skills-');
const send = (method, params = {}) => s.send(method, params);
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw');
  return r.result.value;
};

/** Load the page with a token in place — public/skills.js refuses an unpaired device. */
async function open(which) {
  payload = which;
  await send('Page.navigate', { url: `${base}/skills` });
  await sleep(300);
  await evaluate(`localStorage.setItem('beadcause.token','check')`);
  await send('Page.navigate', { url: `${base}/skills` });
  for (let i = 0; i < 60; i += 1) {
    await sleep(100);
    if (await evaluate(`!!document.querySelector('#skills .section-label')`).catch(() => false)) return true;
  }
  return false;
}

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
  });
  const errors = [];
  // `on` takes one callback for every event, not an event name — see scripts/helpers/chrome.mjs.
  s.on((method, params) => {
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails?.exception?.description || 'exception');
  });

  console.log('the Skills view, in a browser\n');

  check('the page draws from the payload', await open(FULL), 'no .section-label after 6s');

  /* 1 — what nothing measures is on the screen, not implied by its absence. */
  const untracked = await evaluate(`document.querySelectorAll('#skills .skill-chip.is-untracked').length`);
  check(
    `every untracked metric is drawn (${untracked}/${FULL.untracked.length})`,
    untracked === FULL.untracked.length,
    'the section that stops this screen reading as complete is missing rows'
  );
  const owed = await evaluate(
    `[...document.querySelectorAll('#skills .skill-row.is-untracked')].every(r => /bc-[a-z0-9.]+/.test(r.textContent))`
  );
  check('and each names the bead that would measure it', owed, 'a "not tracked" with no bead is an apology, not a plan');

  /* 2 — a candidate's bead is reachable, which is half the bead's acceptance. */
  const reachable = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('#skills .skill-list')].map(l => l.querySelectorAll('.skill-open').length);
      const links = [...document.querySelectorAll('#skills a.skill-open')].map(a => a.getAttribute('href'));
      return { count: links.length, graph: links.filter(h => /^\\/graph\\?ws=[^&]+&id=/.test(h)).length, rows };
    })()
  `);
  check(
    `every candidate row opens its bead (${reachable.graph}/${FULL.candidates.rows.length})`,
    reachable.graph === FULL.candidates.rows.length,
    `${reachable.count} links, ${reachable.graph} of them addressed at /graph?ws=&id=`
  );
  const endorse = await evaluate(
    `[...document.querySelectorAll('#skills a.skill-act')].map(a => a.getAttribute('href')).filter(h => h.startsWith('/endorse?bead=')).length`
  );
  check('and a held one also links to where it is taken off hold', endorse >= 1, 'no /endorse?bead= link for a waiting candidate');

  /* 3 — the phone. Every long string here came from a tracker, so this is the assertion
         the page's author could not have made by looking at it. */
  const over = await evaluate(
    `[...document.querySelectorAll('#skills *')].filter(e => e.getBoundingClientRect().right > ${VP.width} + 1)
       .map(e => (e.className || e.tagName) + ' :: ' + (e.textContent || '').trim().slice(0, 40))`
  );
  check(`nothing runs past ${VP.width}px`, over.length === 0, over.slice(0, 4).join('\n      '));
  check('and the page itself does not scroll sideways', await evaluate(`document.documentElement.scrollWidth <= ${VP.width} + 1`));

  /* The four states are told apart by more than a word — a chip class each, which is what
     the stylesheet hangs the one filled state off. */
  const states = await evaluate(
    `[...new Set([...document.querySelectorAll('#skills .skill-chip')].flatMap(c => [...c.classList].filter(x => x.startsWith('is-'))))].sort()`
  );
  for (const want of ['is-waiting', 'is-accepted', 'is-declined', 'is-superseded']) {
    check(`${want} is drawn as its own chip`, states.includes(want), `chips found: ${states.join(', ')}`);
  }

  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\n  shot: ${SHOT}`);
  }

  /* The empty install — every list at zero, which is what this Mac answers today. The one
     thing that must survive it is the section that says what is not measured: a page with
     nothing on it *and* no untracked list is a page that reads as "nothing to see". */
  check('the empty install still draws', await open(EMPTY), 'no .section-label after 6s on the empty payload');
  const stillThere = await evaluate(`document.querySelectorAll('#skills .skill-chip.is-untracked').length`);
  check(
    'and still says what it cannot measure',
    stillThere === EMPTY.untracked.length,
    'the untracked list is conditional on there being data, which is exactly backwards'
  );
  const emptySays = await evaluate(`(document.querySelector('#skills .empty')?.textContent || '').includes('b7e')`);
  check('an empty library says what a skill would be', emptySays, 'no .empty explaining the state');

  check('no exception on either pass', errors.length === 0, errors.join('\n      '));
} finally {
  close();
  server.close();
  if (KEEP) console.log(`\nkept: ${base} is gone, but the fixture is in this file`);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : `\n\x1b[32mall good\x1b[0m\n`);
process.exit(failures ? 1 : 0);
