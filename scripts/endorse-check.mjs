#!/usr/bin/env node
//
// The endorsement queue, driven — a group tap, and a row at a time.
//
//   node scripts/endorse-check.mjs [--out=DIR]
//
// test/endorsequeue.mjs proves the sweep: what is in the queue, in what order, and
// where each bead came from. None of that says the *screen* works, and the screen is
// where the whole feature is spent — six discoveries filed overnight, and a thumb.
// The two ways this page could be wrong are both invisible from the server side:
//
//   - **A group tap that is not one request.** Six ticked beads must reach
//     /api/bead/endorse as one call carrying six ids, not six calls carrying one. Six
//     calls is six Dolt write locks taken in a row on a phone link, and the first one
//     that loses the race leaves you reading a list that no longer says what happened.
//   - **A destructive button that acts on the first press.** Revoke closes a bead.
//     It arms, and the assertion that matters is the negative one: after the first
//     press, *nothing has been written*.
//
// Same shape as scripts/shade-check.mjs and its siblings: the real public/*.js in a
// headless Chrome the size of a phone, against a fixture server in this process. No
// daemon, no bd, no bead is touched. The fixture records every write, so "which
// endpoint, with what body" is an assertion rather than something you read in a log.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'endorse-check-token';
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

/* ---------------------------------------------------------------- fixtures */

/** A held bead as /api/unendorsed hands it over — a card's vocabulary, not bd's. */
const bead = (workspace, id, at, from) => ({
  key: `${workspace}/${id}`,
  workspace,
  id,
  title: `Something an agent found: ${id}`,
  type: 'bug',
  priority: 2,
  status: 'open',
  description: `What the work is, for ${id}.`,
  acceptance: `How we would know ${id} is done.`,
  design: '',
  notes: `_Filed by an agent while working ${from || 'nothing'}._ How it was found: it fell over.`,
  labels: ['unendorsed', 'agent-filed'],
  filed: true,
  held: true,
  createdAt: at,
  updatedAt: at,
  commentCount: 0,
  from: from ? { id: from, title: 'the work it came out of', status: 'open', kind: 'discovered' } : null,
});

let BEADS = [
  bead('alpha', 'aa-new', '2026-08-09T10:00:00Z', 'aa-src'),
  bead('beta', 'bb-mid', '2026-08-05T10:00:00Z', null),
  bead('alpha', 'aa-old', '2026-08-01T10:00:00Z', 'aa-src'),
];

const SPACES = [
  { name: 'Work', workspaces: ['alpha'], quiet: false, muted: false, count: 2 },
  { name: 'Personal', workspaces: ['beta'], quiet: false, muted: false, count: 1 },
];

const payload = () => ({
  at: new Date('2026-08-10T12:00:00Z').toISOString(),
  beads: BEADS,
  counts: {
    total: BEADS.length,
    shown: BEADS.length,
    byWorkspace: BEADS.reduce((a, b) => ({ ...a, [b.workspace]: (a[b.workspace] || 0) + 1 }), {}),
  },
  truncated: 0,
  workspaces: ['alpha', 'beta'],
  errors: [],
});

/** Every write the page attempted, so "one request or six" is an assertion. */
const writes = [];

/** What has been said about each bead, by id — the discussion's half of the fixture. */
const THREADS = {};

/** What each verdict route answers — the same shape lib/verdict.js builds. */
function verdict(name, body) {
  const ids = body.ids || [body.id];
  const results = ids.map((id) => ({
    id,
    verdict: name,
    ok: true,
    title: id,
    ...(name === 'endorse' ? { endorsed: true } : {}),
    ...(name === 'revoke' ? { revoked: true, already: false } : {}),
    ...(name === 'adjust' ? { changed: Object.keys(body.edits || {}), endorsed: Boolean(body.endorse) } : {}),
    ...(name === 'changes' ? { noted: true } : {}),
  }));
  // Endorsing and revoking take the bead off the queue, which is what makes the next
  // fetch the only real evidence the tap worked.
  if (name === 'endorse' || name === 'revoke' || (name === 'adjust' && body.endorse)) {
    BEADS = BEADS.filter((b) => !ids.includes(b.id));
  }
  return { ok: true, verdict: name, results, applied: ids, failed: [] };
}

function serve() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const read = (fn) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => fn(JSON.parse(body || '{}')));
    };

    if (p === '/api/unendorsed') return json(payload());
    // The picker draws itself from this on a page that has not swept the tracker.
    if (p === '/api/spaces') {
      return json({ spaces: SPACES, workspaces: ['alpha', 'beta'], counts: { alpha: 2, beta: 1 }, filter: { space: 'all', workspace: 'all' }, waiting: 0 });
    }
    // Who you can put a question to. Four chips, as the daemon's own roster hands them
    // over — the page draws them and sends the id of whichever is pressed.
    if (p === '/api/agents') {
      return json({
        agents: [
          { id: 'answerer', name: 'Answerer', emoji: '💬', description: 'You answer the question, plainly.', builtin: true },
          { id: 'critic', name: 'Critic', emoji: '🧨', description: 'You argue the strongest case against it.', builtin: true },
        ],
        default: 'answerer',
      });
    }

    /**
     * The discussion. Deliberately *not* in the verdict list below: it writes a comment
     * and moves nothing, so the fixture leaves BEADS alone and only counts the thread —
     * which is what makes "the bead is still on the queue afterwards" an assertion
     * rather than a coincidence of this fixture forgetting to remove it.
     */
    if (p === '/api/bead/discuss' && req.method === 'POST') {
      return void read((parsed) => {
        writes.push({ path: p, ...parsed });
        const id = parsed.id || parsed.ids?.[0];
        THREADS[id] = [
          ...(THREADS[id] || []),
          { id: `c${(THREADS[id] || []).length + 1}`, author: 'adam@example.com', text: parsed.text, at: '2026-08-10T12:00:00Z', agent: null },
        ];
        const held = BEADS.find((b) => b.id === id);
        if (held) held.commentCount = THREADS[id].length;
        json({ ok: true, id, held: true, dispatched: true, agent: { id: parsed.agent, name: parsed.agent }, thread: THREADS[id] });
      });
    }
    if (p === '/api/bead/thread') {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      return json({ id, thread: THREADS[id] || [], running: false, activity: null });
    }

    const named = ['endorse', 'revoke', 'adjust', 'changes'].find((n) => p === `/api/bead/${n}`);
    if (named && req.method === 'POST') {
      return void read((parsed) => {
        writes.push({ path: p, ...parsed });
        json(verdict(named, parsed));
      });
    }
    if (p.startsWith('/api/')) {
      if (req.method === 'POST') return void read(() => json({}));
      return json({});
    }

    // The alias the real server keeps in `serveStatic`, repeated here for the one path
    // this fixture is ever asked for. A fixture that 404'd `/endorse` would report the
    // page as broken when what is broken is the fixture.
    const rel = p === '/' || p === '/endorse' ? (p === '/' ? 'index.html' : 'endorse.html') : p.replace(/^\/+/, '');
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
const { s, close } = await launchChrome('beadcause-endorse-');

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

const press = async (sel) => {
  const there = await evalJs(`document.querySelector(${JSON.stringify(sel)}) !== null`);
  if (there) await evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
  return there;
};

const text = () => evalJs(`document.getElementById('eq').textContent.replace(/\\s+/g, ' ').trim()`);

const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `endorse-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/** Fill a field in the adjust form the way a keyboard would, `input` and all. */
const type = (field, value) =>
  evalJs(`(() => {
    const el = document.querySelector('[data-edit=${JSON.stringify(field)}]');
    if (!el) return false;
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width, height: VP.height, deviceScaleFactor: VP.dpr,
    mobile: true, screenWidth: VP.width, screenHeight: VP.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\nthe endorsement queue · ${VP.width}x${VP.height} · ${BASE}\n`);

  // The token the way the pairing link delivers it, which is also how every sibling
  // check gets one onto the page: `?t=`, captured into localStorage on first load.
  await s.send('Page.navigate', { url: `${BASE}/endorse?t=${TOKEN}` });
  const drew = await waitFor(`document.querySelectorAll('.eq-bead').length === 3`, 15000);
  check('the queue draws every held bead', drew, await evalJs(`document.querySelectorAll('.eq-bead').length`));

  // Off the row keys, not off the id pills: a row carries a second `.pill.id` for the
  // bead it was discovered under, and reading those as the order would pass on a list
  // sorted by provenance.
  const order = await evalJs(`[...document.querySelectorAll('[data-row]')].map((b) => b.dataset.row)`);
  check(
    'newest first, across both workspaces',
    JSON.stringify(order) === JSON.stringify(['alpha/aa-new', 'beta/bb-mid', 'alpha/aa-old']),
    String(order)
  );

  const head = await text();
  check('with a count at the top', /3 beads waiting on you/.test(head), head.slice(0, 50));
  check('and the bead each one was found under', /Found while working/.test(head));
  await shot('list');

  /* ---- a row is the whole bead ---- */

  await press('[data-row="alpha/aa-new"]');
  await waitFor(`document.querySelector('.board-open') !== null`);
  const open = await text();
  check('unfolding shows what the work is', /What the work is, for aa-new/.test(open));
  check('and what done looks like', /How we would know aa-new is done/.test(open));
  check('and the agent’s own account of how it found it', /How it was found: it fell over/.test(open));
  const acts = await evalJs(`[...document.querySelectorAll('.board-open [data-act]')].map((b) => b.dataset.act)`);
  check(
    'all four verdicts are on the row',
    ['endorse', 'edit', 'changes', 'revoke'].every((a) => acts.includes(a)),
    String(acts)
  );
  await shot('open');

  /* ---- asking for changes needs the note, and says so ---- */

  await press('[data-act="changes"]');
  await sleep(300);
  check('Ask for changes with an empty box writes nothing', writes.length === 0);
  check('and says why rather than doing nothing quietly', /Type the objection first/.test(await text()));

  await evalJs(`(() => {
    const el = document.querySelector('[data-note]');
    el.value = 'This duplicates the thing you filed last week.';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await press('[data-act="changes"]');
  await sleep(600);
  const noted = writes.filter((w) => w.path === '/api/bead/changes').pop();
  check('with a note it reaches /api/bead/changes', Boolean(noted), JSON.stringify(noted));
  check('carrying the note and the bead', noted?.note?.startsWith('This duplicates') && noted?.ids?.[0] === 'aa-new');
  check('and the bead stays on the queue — a note is not a verdict on the work', await waitFor(`document.querySelectorAll('.eq-bead').length === 3`));

  /* ---- revoke arms ---- */

  writes.length = 0;
  await waitFor(`document.querySelector('[data-act="revoke"]') !== null`);
  await press('[data-act="revoke"]');
  await sleep(400);
  check('the first press of Revoke writes nothing at all', writes.length === 0, JSON.stringify(writes));
  check('the button says what the next press will do', /Revoke it — sure\?/.test(await text()));
  await shot('armed');

  // Folding the row is how you back out, and it must disarm — an armed button left
  // behind a fold is a bead you close by reopening a row.
  await press('[data-row="alpha/aa-new"]');
  await press('[data-row="alpha/aa-new"]');
  await sleep(300);
  check('folding the row disarms it', !/Revoke it — sure\?/.test(await text()));

  /* ---- the group tap ---- */

  await press('[data-pick="alpha/aa-new"]');
  await press('[data-pick="beta/bb-mid"]');
  const bar = await waitFor(`document.querySelector('.eq-bar') !== null`);
  check('ticking rows brings up the group bar', bar, await text().then((t) => t.slice(0, 40)));
  check('which says how many', /2 beads selected/.test(await text()));
  await shot('picked');

  writes.length = 0;
  await press('.eq-bar [data-act="endorse"]');
  await sleep(900);
  const posts = writes.filter((w) => w.path === '/api/bead/endorse');
  // Two workspaces, so two requests — one per tracker, which is what the route takes.
  // The claim is that each carries *its* ids together, not one request per bead.
  check('a group endorse is one request per workspace, not one per bead', posts.length === 2, JSON.stringify(posts));
  check(
    'and each carries the ids for its own tracker',
    posts.some((w) => w.workspace === 'alpha' && JSON.stringify(w.ids) === '["aa-new"]') &&
      posts.some((w) => w.workspace === 'beta' && JSON.stringify(w.ids) === '["bb-mid"]'),
    JSON.stringify(posts)
  );
  check('the endorsed beads leave the queue', await waitFor(`document.querySelectorAll('.eq-bead').length === 1`));
  check('and the page says what happened, where the rows used to be', /Endorsed 2 beads/.test(await text()), (await text()).slice(0, 60));
  await shot('endorsed');

  /* ---- adjust ---- */

  await press('[data-row="alpha/aa-old"]');
  await press('[data-act="edit"]');
  const form = await waitFor(`document.querySelector('[data-edit="title"]') !== null`);
  check('the ✎ opens the six fields', form);
  const fields = await evalJs(`[...document.querySelectorAll('[data-edit]')].map((e) => e.dataset.edit)`);
  check(
    'and only the six',
    JSON.stringify(fields) === JSON.stringify(['title', 'type', 'priority', 'description', 'acceptance', 'labels']),
    String(fields)
  );
  const labelBox = await evalJs(`document.querySelector('[data-edit="labels"]').value`);
  check('with the two labels the daemon owns kept out of the box', !/unendorsed|agent-filed/.test(labelBox), `"${labelBox}"`);

  writes.length = 0;
  await type('title', 'A title you would actually accept');
  await type('priority', '3');
  await press('[data-act="save"]');
  await sleep(700);
  const adjusted = writes.filter((w) => w.path === '/api/bead/adjust').pop();
  check('Save reaches /api/bead/adjust', Boolean(adjusted), JSON.stringify(adjusted));
  check('with the rewritten title and priority', adjusted?.edits?.title?.startsWith('A title you would') && Number(adjusted?.edits?.priority) === 3);
  check('and endorse false — a rewrite is not an agreement', adjusted?.endorse === false);
  check('so the bead is still on the queue', await waitFor(`document.querySelectorAll('.eq-bead').length === 1`));
  await shot('adjusted');

  /* ---- talking about one instead of deciding on it ---- */

  writes.length = 0;
  await waitFor(`document.querySelector('[data-act="talk"]') !== null`);
  await press('[data-act="talk"]');
  const panel = await waitFor(`document.querySelector('[data-talk]') !== null`);
  check('Discuss opens a thread on the row', panel);
  const chips = await evalJs(`[...document.querySelectorAll('[data-act="agent"]')].map((c) => c.dataset.agent)`);
  check('with the roster to choose from', JSON.stringify(chips) === JSON.stringify(['answerer', 'critic']), String(chips));

  await press('[data-act="send"]');
  await sleep(300);
  check('Send with an empty box writes nothing', writes.length === 0, JSON.stringify(writes));
  check('and says why, rather than doing nothing quietly', /Type the question first/.test(await text()));

  // The chip is the choice, so it has to be the one that travels with the question —
  // an agent you picked and a comment answered by the default is the whole feature
  // failing silently.
  await press('[data-act="agent"][data-agent="critic"]');
  await evalJs(`(() => {
    const el = document.querySelector('[data-talk]');
    el.value = 'Is this not the same as the thing you filed last week?';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await press('[data-act="send"]');
  await sleep(900);
  const asked = writes.filter((w) => w.path === '/api/bead/discuss').pop();
  check('the question reaches /api/bead/discuss', Boolean(asked), JSON.stringify(asked));
  check('carrying the chosen agent and one bead', asked?.agent === 'critic' && asked?.id === 'aa-old', JSON.stringify(asked));
  check('nothing was endorsed, adjusted or closed on the way', writes.every((w) => w.path === '/api/bead/discuss'), JSON.stringify(writes.map((w) => w.path)));
  check('the bead is still waiting on you afterwards', await waitFor(`document.querySelectorAll('.eq-bead').length === 1`));
  check('the thread is on the row', /same as the thing you filed last week/.test(await text()));
  await shot('discussing');

  // And the point of the count: a bead you have asked about must never fold away
  // looking like one nobody has opened.
  await press('[data-act="close-talk"]');
  await press('[data-row="alpha/aa-old"]');
  const counted = await waitFor(`/💬/.test(document.getElementById('eq').textContent)`);
  check('and the folded row says a thread exists', counted, (await text()).slice(0, 80));
  await shot('counted');
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
