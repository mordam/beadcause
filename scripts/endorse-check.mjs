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
//   - **A queue that has quietly stopped being true.** This page came off its 45-second
//     refetch and onto the daemon's event log (bc-bsgn), which is faster and very much
//     cheaper and has one new way to be wrong: a wake that arrives while you are typing
//     must not repaint over your thumb, and must not be dropped either. The fixture keeps
//     a log and counts sweeps, so both halves — and the cost of an idle queue, which is
//     zero — are assertions rather than impressions.
//   - **Endorse all reaching past the picker.** The one tap that releases the whole
//     page must act on exactly the rows drawn under the current filter — so it is
//     driven twice, once wide open and once narrowed to a single repo, and the
//     assertion in the narrowed run is about the bead in the space you were *not*
//     looking at still being there afterwards. It arms too, for the same negative
//     assertion Revoke gets.
//
// Same shape as scripts/launcher-check.mjs and its siblings: the real public/*.js in a
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
const bead = (workspace, id, at, from, later = {}) => ({
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
  // What was learned *after* the bead was filed, and the only two fields on this payload
  // that were not written by the filing agent. Null and empty by default, because that is
  // what most rows carry and a fixture where every row is flagged proves nothing about a
  // row that is.
  latestComment: null,
  questions: [],
  ...later,
});

/* A function rather than a literal, because the Endorse all section needs a *list* to
   act on and the sections before it have spent most of one. Re-seeding and pressing the
   page's own ⟳ is how it gets one back without a second Chrome. */
const seed = () => [
  bead('alpha', 'aa-new', '2026-08-09T10:00:00Z', 'aa-src'),
  bead('beta', 'bb-mid', '2026-08-05T10:00:00Z', null),
  /**
   * The bead bc-xl7n.76.2 is about, in miniature.
   *
   * bc-wi3s was finished work: an advocate had run the suite, found it green, written that
   * on the bead as a comment, and filed an open P1 recommending it be closed rather than
   * endorsed. The endorse sweep took it anyway in a batch of 56, because the row it drew
   * said neither thing. Both now ride on the payload, so both have to reach the screen
   * *folded* — the press that misfires is the one made without opening anything.
   */
  bead('alpha', 'aa-old', '2026-08-01T10:00:00Z', 'aa-src', {
    commentCount: 2,
    latestComment: {
      author: 'bc-xl7n',
      at: '2026-08-09T08:00:00Z',
      text: 'I ran the suite on main and it is green — this is finished work.',
      truncated: false,
    },
    questions: [
      { key: 'alpha/aa-ask', workspace: 'alpha', id: 'aa-ask', title: 'Close aa-old rather than endorsing it?', priority: 1 },
    ],
  }),
];

let BEADS = seed();

/**
 * The one bead `bd` will refuse, when a section wants a partial failure.
 *
 * A group of six where the fifth lost a Dolt write lock is a 200 carrying a row per
 * bead, and the failure this fixture exists to catch is the client folding that into a
 * flat "done" — so one id answers `ok: false` and stays on the queue, exactly as the
 * real `applyVerdict` leaves it.
 */
let FAILING = null;

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

/**
 * The daemon's event log, as much of it as this page can tell apart.
 *
 * The real one is an ordered counter every view parks on (`/api/poll`, lib/server.js).
 * What matters here is only its shape — a sequence, the events past it, and a request
 * that *waits* rather than answering empty — because the page's whole refresh rule is
 * written against it: park, wake, decide whether this event could have changed the
 * queue, and sweep only then.
 */
let SEQ = 0;
const LOG = [];
const WAITERS = [];

/** Push an event the way the daemon does, and answer everybody parked on the log. */
function emit(type) {
  SEQ += 1;
  LOG.push({ type, seq: SEQ });
  for (const answer of WAITERS.splice(0)) answer();
}

/**
 * How many times the page has gone and swept.
 *
 * The assertion this whole section is for. `/api/unendorsed` is a `bd list` per
 * workspace and then a `bd show` per row, so "did it refetch" is not a detail of the
 * implementation here — it is the cost the delta stream exists to stop paying, and the
 * only way to see it from outside is to count.
 */
let sweeps = 0;

/**
 * How long the sweep is held before it answers, in ms.
 *
 * The queue is the most expensive boot in the app — every workspace listed, then a
 * `bd show` per row — so the wait in front of it is the thing a person actually
 * experiences on arriving. Holding the response is the only way to ask, from outside,
 * whether the page drew anything while it waited.
 */
let SLOW = 0;

/** What has been said about each bead, by id — the discussion's half of the fixture. */
const THREADS = {};

/** What each verdict route answers — the same shape lib/verdict.js builds. */
function verdict(name, body) {
  const ids = body.ids || [body.id];
  const results = ids.map((id) =>
    id === FAILING
      ? { id, verdict: name, ok: false, status: 500, error: 'bd lost the write lock' }
      : {
          id,
          verdict: name,
          ok: true,
          title: id,
          ...(name === 'endorse' ? { endorsed: true } : {}),
          ...(name === 'revoke' ? { revoked: true, already: false } : {}),
          ...(name === 'adjust' ? { changed: Object.keys(body.edits || {}), endorsed: Boolean(body.endorse) } : {}),
          ...(name === 'changes' ? { noted: true } : {}),
        }
  );
  const landed = results.filter((r) => r.ok).map((r) => r.id);
  // Endorsing and revoking take the bead off the queue, which is what makes the next
  // fetch the only real evidence the tap worked — and a bead that did *not* go through
  // stays on it, which is what makes the partial failure visible on the next sweep.
  if (name === 'endorse' || name === 'revoke' || (name === 'adjust' && body.endorse)) {
    BEADS = BEADS.filter((b) => !landed.includes(b.id));
  }
  return {
    ok: results.every((r) => r.ok),
    verdict: name,
    results,
    applied: landed,
    failed: results.filter((r) => !r.ok),
  };
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

    if (p === '/api/unendorsed') {
      sweeps += 1;
      const body = payload();
      if (SLOW) return void setTimeout(() => json(body), SLOW);
      return json(body);
    }

    /**
     * The log the page parks on.
     *
     * A request with no `since` is a client asking where in the log it is: answered at
     * once, which is what `cold: true` is for. One that names a place either gets what
     * has happened since or is held — held, not answered empty, because a poll that
     * answered immediately would turn the page's loop into a busy one and this fixture
     * would be the thing that made it look fine.
     */
    if (p === '/api/poll') {
      const since = new URL(req.url, 'http://x').searchParams.get('since');
      if (since === null) return json({ seq: SEQ, events: [] });
      const from = Number(since);
      const answer = () => json({ seq: SEQ, events: LOG.filter((e) => e.seq > from) });
      if (SEQ > from) return answer();
      WAITERS.push(answer);
      // A page that navigated away or a socket the browser dropped: forget the waiter
      // rather than answering into a closed response later.
      return void req.on('close', () => {
        const at = WAITERS.indexOf(answer);
        if (at >= 0) WAITERS.splice(at, 1);
      });
    }
    // The picker draws itself from this on a page that has not swept the tracker.
    if (p === '/api/spaces') {
      return json({ spaces: SPACES, workspaces: ['alpha', 'beta'], filter: { space: 'all', workspace: 'all' } });
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

  /* ---- what was learned after the bead was filed, on the folded row ---- */

  // The whole of bc-xl7n.76.2. Every other line on a folded row is the filing agent's own
  // words; these two are what somebody concluded afterwards, and they are the only lines
  // on the page that argue *against* the tap beside them. Asserted folded and with the
  // sweep counter held still, because "you can see it if you open the row" is exactly the
  // state a bulk endorse sails past.
  const flagged = await evalJs(
    `(() => { const el = document.querySelector('[data-row="alpha/aa-old"] .eq-ask'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; })()`
  );
  check('an open question naming a bead is on its folded row', /An open question names this bead/.test(flagged || ''), String(flagged));
  check('and it names the question and what it asks', /aa-ask/.test(flagged || '') && /Close aa-old rather than endorsing it\?/.test(flagged || ''));

  const said = await evalJs(
    `(() => { const el = document.querySelector('[data-row="alpha/aa-old"] .eq-last'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; })()`
  );
  check('and the last thing anybody said about it, quoted', /this is finished work/.test(said || ''), String(said));
  check('with whoever said it', /bc-xl7n/.test(said || ''));

  check(
    'both drawn off the one sweep the page has already made',
    sweeps === 1,
    `${sweeps} sweeps — a row that had to fetch its own thread would draw the flag a second too late`
  );

  const quiet = await evalJs(
    `document.querySelectorAll('[data-row="alpha/aa-new"] .eq-ask, [data-row="beta/bb-mid"] .eq-ask').length`
  );
  check('and nothing at all on the rows nobody has asked about', quiet === 0, `${quiet} flags`);

  // Two new lines on a row on a 393px screen, one of which deliberately *wraps* where
  // everything else here truncates. A question that pushed the page sideways would be a
  // warning you have to scroll to finish reading, on the one row you were meant not to
  // skim.
  const wide = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
  check('and the page still does not scroll sideways', wide <= 1, `${wide}px over`);
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
  // The chips arrive a paint after the box does, and that is deliberate on the page's
  // side: `openTalk` renders the panel first and *then* awaits `loadAgents()`, so a
  // roster that will not load never stops you asking. Waiting on `[data-talk]` and
  // reading the chips in the same breath is therefore a race, and it is one this check
  // lost about one run in four — a red that reads as the roster having broken.
  await waitFor(`document.querySelectorAll('[data-act="agent"]').length > 0`);
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

  /* ---- Endorse all: no ticking at all, and it arms ---- */

  // A whole queue again. The sections above have spent most of the fixture, and every
  // assertion below is a count — so the list is re-seeded and the page's own ⟳ pressed,
  // which is the same fetch the 45-second poll makes.
  BEADS = seed();
  await press('#eq-refresh');
  check('the queue reloads on ⟳', await waitFor(`document.querySelectorAll('.eq-bead').length === 3`));

  check('nothing is ticked, so there is no group bar', await evalJs(`document.querySelector('.eq-bar') === null`));
  const allSeen = await text();
  check('but Endorse all is on the header, naming the count', /Endorse all 3/.test(allSeen), allSeen.slice(0, 60));

  writes.length = 0;
  await press('.eq-all');
  await sleep(400);
  check('the first tap of Endorse all writes nothing at all', writes.length === 0, JSON.stringify(writes));
  const allArmed = await text();
  check('and the button says what the second tap will do', /Endorse all 3 — sure\?/.test(allArmed));
  // The bead this control could most easily get wrong is one in a repo you were not
  // thinking about, so the count is broken down by tracker before it acts.
  check(
    'naming every repo the tap covers',
    /2 in alpha/.test(allArmed) && /1 in beta/.test(allArmed),
    allArmed.slice(0, 220)
  );
  await shot('all-armed');

  await press('.eq-all');
  await sleep(1400);
  const allPosts = writes.filter((w) => w.path === '/api/bead/endorse');
  check('the second tap is one request per workspace, not one per bead', allPosts.length === 2, JSON.stringify(allPosts));
  check(
    'and each carries every drawn bead in its own tracker',
    allPosts.some((w) => w.workspace === 'alpha' && JSON.stringify([...w.ids].sort()) === '["aa-new","aa-old"]') &&
      allPosts.some((w) => w.workspace === 'beta' && JSON.stringify(w.ids) === '["bb-mid"]'),
    JSON.stringify(allPosts)
  );
  check('the queue empties', await waitFor(`document.querySelectorAll('.eq-bead').length === 0`));
  check('and says so where the rows used to be', /Endorsed 3 beads/.test(await text()), (await text()).slice(0, 80));
  await shot('all-endorsed');

  /* ---- and it acts on what is drawn, never on what merely exists ---- */

  BEADS = seed();
  await evalJs(`window.beadcause.space.set({ space: 'all', workspace: 'alpha' })`);
  await press('#eq-refresh');
  check('narrowed to one repo, the queue draws only its beads', await waitFor(`document.querySelectorAll('.eq-bead').length === 2`));
  const narrowed = await text();
  check('and Endorse all counts what is drawn, not what exists', /Endorse all 2/.test(narrowed), narrowed.slice(0, 60));

  writes.length = 0;
  await press('.eq-all');
  await sleep(400);
  const narrowArmed = await text();
  check(
    'the armed hint says what the picker is holding back',
    /1 bead in another space stays held/.test(narrowArmed),
    narrowArmed.slice(0, 260)
  );
  await press('.eq-all');
  await sleep(1400);
  const scoped = writes.filter((w) => w.path === '/api/bead/endorse');
  check(
    'it endorses the drawn workspace and only that one',
    scoped.length === 1 && scoped[0].workspace === 'alpha',
    JSON.stringify(scoped)
  );
  // The assertion the whole control turns on: a tap made while looking at one space
  // must not have reached into another one's queue.
  check(
    'the bead in the space you were not looking at is untouched',
    BEADS.length === 1 && BEADS[0].id === 'bb-mid',
    JSON.stringify(BEADS.map((b) => b.id))
  );
  await shot('all-scoped');

  /* ---- a group where one bead did not go through says which ---- */

  await evalJs(`window.beadcause.space.set({ space: 'all', workspace: 'all' })`);
  BEADS = seed();
  FAILING = 'aa-old';
  await press('#eq-refresh');
  await waitFor(`document.querySelectorAll('.eq-bead').length === 3`);
  await press('.eq-all');
  await sleep(400);
  await press('.eq-all');
  await sleep(1600);
  const partial = await text();
  check('a bead that did not go through is named rather than swallowed', /aa-old did not/.test(partial), partial.slice(0, 200));
  check('and it is still sitting on the queue afterwards', await waitFor(`document.querySelectorAll('.eq-bead').length === 1`));
  await shot('all-partial');
  FAILING = null;

  /* ---- following the log instead of a clock ---- */

  BEADS = seed();
  await press('#eq-refresh');
  await waitFor(`document.querySelectorAll('.eq-bead').length === 3`);
  // The ⟳ above is the last thing that asks on purpose. Everything below is about what
  // the page does when *nothing* is pressed, which used to be: sweep every workspace
  // every forty-five seconds, filed bead or not.
  await sleep(400);

  let swept = sweeps;
  emit('presence');
  await sleep(700);
  check(
    'a thumb moving on somebody else\'s phone does not sweep every workspace',
    sweeps === swept,
    `${sweeps - swept} sweeps`
  );

  swept = sweeps;
  BEADS = [bead('alpha', 'aa-fresh', '2026-08-11T10:00:00Z', 'aa-src'), ...BEADS];
  emit('created');
  const landed = await waitFor(`document.body.textContent.includes('aa-fresh')`, 5000);
  // The point of the whole change: a bead filed by a worker in the next room is on the
  // phone in the moment it was filed, rather than up to forty-five seconds later.
  check('a bead filed while you are looking lands on the screen', landed);
  check('and it cost exactly one sweep', sweeps === swept + 1, `${sweeps - swept} sweeps`);

  // A wake that arrives mid-sentence. The old timer skipped these ticks outright; this
  // has to skip the repaint and still not lose the news.
  await press('[data-row="alpha/aa-fresh"]');
  await waitFor(`document.querySelector('[data-act="talk"]') !== null`);
  await press('[data-act="talk"]');
  await waitFor(`document.querySelector('[data-talk]') !== null`);
  await evalJs(`(() => {
    const el = document.querySelector('[data-talk]');
    el.value = 'Half a question, still being typed';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  swept = sweeps;
  BEADS = [bead('beta', 'bb-later', '2026-08-12T10:00:00Z', null), ...BEADS];
  emit('endorsement');
  await sleep(800);
  check('a wake mid-sentence does not sweep', sweeps === swept, `${sweeps - swept} sweeps`);
  check(
    'and the half-typed question is still in the box',
    (await evalJs(`document.querySelector('[data-talk]')?.value`)) === 'Half a question, still being typed'
  );
  check('so the news has not been drawn yet', !(await text()).includes('bb-later'));

  // Emptying the box is what releases it — and nothing else on this page repaints for a
  // keystroke, so if the wake were not taken here it would wait for the next tap.
  await evalJs(`(() => {
    const el = document.querySelector('[data-talk]');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  check(
    'the moment the box is empty, the wake it deferred is taken',
    await waitFor(`document.body.textContent.includes('bb-later')`, 5000),
    `${sweeps - swept} sweeps`
  );
  await shot('streamed');

  /* ---- and arriving on the page at all ---- */

  // A second visit in the same tab, with the sweep held for two and a half seconds.
  // This is the half of the complaint the stream does not answer: the log keeps a page
  // you are already looking at true, and does nothing whatever for the wait in front of
  // one you have just opened. The warm layer is what draws the queue you were last
  // shown while the request is still in the air.
  BEADS = seed();
  SLOW = 2500;
  swept = sweeps;
  await s.send('Page.navigate', { url: `${BASE}/endorse` });
  const instant = await waitFor(`document.querySelectorAll('.eq-bead').length > 0`, 1500);
  check('a queue is on screen before the sweep has answered', instant);
  check('and it was drawn without a second sweep', sweeps === swept + 1, `${sweeps - swept} sweeps`);
  await shot('warm');
  SLOW = 0;
  // The held sweep still lands, and what it says wins — a warm frame is the last true
  // thing this device saw, never an answer to the question being asked now.
  check(
    'then the real answer replaces it',
    await waitFor(`document.querySelectorAll('.eq-bead').length === 3`, 6000)
  );
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
