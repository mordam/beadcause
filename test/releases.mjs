#!/usr/bin/env node
/**
 * The Releases view — the two queues as cards, and where the deploy strip went.
 *
 *     npm test
 *     node test/releases.mjs
 *
 * `test/queues.mjs` is the other half of this and checks the daemon: which rung a bead is
 * on, which entries exist at all, and when one ages off the board. What is here is the
 * page, and the page's whole job is to turn `rungs[]` into something answerable at a
 * glance. So the checks are about the four things that can go wrong in that translation,
 * none of which is visible by reading one function:
 *
 * 1. **The stage has to be readable without opening the card.** That is the claim the
 *    whole shape rests on — a page that only said where something was behind a fold would
 *    look identical in a screenshot and be useless in a pocket.
 *
 * 2. **`untracked` must never draw as done.** Three release rungs come off the router's
 *    handover trail and off nothing else (lib/handover.js), so a release that went live
 *    with no handover recorded has three rungs nobody observed. Ticking them from the
 *    entry's own stage would say a green verification passed that nobody ran — which
 *    reads exactly like the truth, and is the one way this screen could actually mislead.
 *
 * 3. **One renderer over both queues.** A merge entry and a release entry carry the same
 *    `rungs[]` shape on purpose (bc-khoe.6), and a card that started asking which queue it
 *    was in would be two renderers wearing one name. So both kinds are drawn from the same
 *    fixture here and asserted the same way.
 *
 * 4. **The strip actually left the board.** The point of bc-khoe.7 is not that a new page
 *    draws a deploy — it is that the PR board stopped. A `loadDeploys` left behind there
 *    would be an invisible second poll of `/api/deploys` on a screen that has nothing to
 *    draw from it, so the last section reads public/prs.js and says so.
 *
 * The client half runs the real `public/releases.js` in a vm with a hand-made document,
 * on top of the real `public/prcard.js` — the four helpers it borrows are taken from the
 * file that actually ships them, so a rename there fails here rather than in a browser.
 * And the static half at the foot is the other side of that: a stub document answering
 * every selector cannot notice an element missing from the HTML.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
}

console.log('\nthe releases view\n');

/* ================================================================== the fixture */

/** One rung, in the shape `rungsFor` hands back. */
const rung = (label, state, at = null) => ({
  id: label.toLowerCase().replace(/ /g, '-'),
  label,
  note: `what happens at ${label.toLowerCase()}`,
  at,
  state,
});

const MERGE_RUNGS = (at) =>
  ['Queued for merge', 'Downmerging', 'Resolving conflicts', 'Gate tests', 'Resolving issues'].map((label, i) =>
    rung(label, i < at ? 'done' : i === at ? 'now' : 'pending')
  );

/** The three the deploy journal cannot see — `handover: true` in lib/queues.js. */
const HANDOVER = new Set(['Deployed to green', 'Green verification', 'Swapping to blue']);

const RELEASE_RUNGS = (at, observed = {}) =>
  ['Merged', 'Building', 'Deploying', 'Deployed to green', 'Green verification', 'Swapping to blue', 'Live'].map(
    (label, i) => {
      const seen = observed[label] || null;
      return rung(
        label,
        seen ? 'done' : HANDOVER.has(label) ? 'untracked' : i < at ? 'done' : i === at ? 'now' : 'pending',
        seen
      );
    }
  );

const mergeEntry = (over = {}) => ({
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
  at: null,
  rungs: MERGE_RUNGS(3),
  ...over,
});

const releaseEntry = (over = {}) => ({
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
  rungs: RELEASE_RUNGS(0),
  ...over,
});

const repo = (over = {}) => ({
  key: 'demo',
  workspace: 'demo',
  repo: 'someone/demo',
  where: 'demo',
  base: 'main',
  deployDeclared: true,
  deployTracked: true,
  releasable: true,
  error: null,
  merge: [],
  release: [],
  ...over,
});

const queues = (over = {}) => ({
  at: '2026-08-09T09:00:00Z',
  repos: [repo()],
  orphans: [],
  counts: { merge: 0, release: 0 },
  unavailable: null,
  errors: [],
  observing: false,
  ...over,
});

/* ================================================================== the harness */

/** One turn of the macrotask queue drains every microtask behind it. */
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/**
 * The real files, in a room with the four elements they touch.
 *
 * `setTimeout` is faked rather than real: `scheduleDeploys` arms a thirty-second fallback
 * whenever there is no stream to follow, and a suite that let that one through would keep
 * node alive for half a minute after its last assertion. The armed timers are handed back
 * so the cadence itself can be asserted.
 */
function load({ token = 'tok', payload = queues(), deploys = { deploys: [], deployable: [] }, matches } = {}) {
  const mk = () => {
    const el = {
      innerHTML: '',
      hidden: false,
      scrollTop: 0,
      events: {},
      classes: new Set(),
      addEventListener(type, fn) {
        this.events[type] = fn;
      },
      classList: {
        add: (n) => el.classes.add(n),
        remove: (n) => el.classes.delete(n),
      },
    };
    return el;
  };

  const out = mk();
  const pulse = mk();
  const observing = mk();
  const refresh = mk();

  const store = new Map();
  if (token) store.set('beadcause.token', token);

  const listeners = [];
  const space = { matches: matches || (() => true), onChange: (fn) => listeners.push(fn) };

  const calls = [];
  const timers = [];
  const fetchStub = async (url, opts) => {
    const u = new URL(url, 'http://x');
    calls.push({ path: u.pathname, refresh: u.searchParams.get('refresh') === '1', token: opts?.headers?.['x-beadcause-token'] });
    if (u.pathname === '/api/queues') {
      if (payload === null) return { ok: false, status: 500, json: async () => ({ error: 'nope' }) };
      return { ok: true, status: 200, json: async () => payload };
    }
    if (u.pathname === '/api/deploys') return { ok: true, status: 200, json: async () => deploys };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const window = { beadcause: { space } };
  const ctx = vm.createContext({
    window,
    document: {
      getElementById: (id) =>
        id === 'releases' ? out : id === 'pulse' ? pulse : id === 'observing' ? observing : id === 'refresh' ? refresh : null,
    },
    localStorage: { getItem: (k) => store.get(k) ?? null },
    fetch: fetchStub,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    URL,
    URLSearchParams,
    encodeURIComponent,
    Object,
    JSON,
    Date,
    Number,
    Array,
    Boolean,
    String,
    Set,
    Map,
    RegExp,
    Promise,
    console,
  });
  // The real helper file first — `esc`, `plural`, `ago` and `graphUrl` come off it, so a
  // rename there is a failure here rather than a blank page on a phone.
  vm.runInContext(read('public/prcard.js'), ctx, { filename: 'prcard.js' });
  vm.runInContext(read('public/releases.js'), ctx, { filename: 'releases.js' });

  return {
    out,
    pulse,
    observing,
    refresh,
    calls,
    timers,
    /** Tap a card, the way the page's own delegated click handler sees it. */
    tap(key) {
      out.events.click({
        target: { closest: (sel) => (sel === '[data-card]' ? { dataset: { card: key } } : null) },
      });
    },
    /** The space picker moving, on this device or the other one. */
    pick(next) {
      space.matches = next;
      for (const fn of listeners) fn({ source: 'pick' });
    },
  };
}

/* ------------------------------------------------------------------ the readers */

const strip = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Every card drawn, as `{ classes, title, stage, open }`. */
const cardsOf = (h) =>
  String(h.out.innerHTML)
    .split('<article class="queue-card ')
    .slice(1)
    .map((chunk) => ({
      classes: chunk.slice(0, chunk.indexOf('"')).split(/\s+/).filter(Boolean),
      title: strip((chunk.match(/<span class="queue-title">([\s\S]*?)<\/span>\s*<span class="queue-line">/) || [])[1] || ''),
      stage: strip((chunk.match(/<span class="queue-stage">([\s\S]*?)<\/span>\s*<\/span>/) || [])[1] || ''),
      open: chunk.includes('class="queue-body"'),
    }));

/** The ladder inside whichever card is open, as `state:Label`. */
const rungsOf = (h) =>
  [...String(h.out.innerHTML).matchAll(/<li class="queue-rung ([a-z]+)">[\s\S]*?<span class="queue-rung-name">([^<]*)<\/span>/g)].map(
    (m) => `${m[1]}:${m[2]}`
  );

const sectionsOf = (h) =>
  [...String(h.out.innerHTML).matchAll(/data-sec="([a-z]+)">\s*<h2 class="queue-head">([\s\S]*?)<\/h2>/g)].map(
    (m) => `${m[1]}|${strip(m[2])}`
  );

/* ================================================ 1. the stage is the summary */

await check('a merge card says its stage without being opened', async () => {
  const h = load({ payload: queues({ repos: [repo({ merge: [mergeEntry()] })], counts: { merge: 1, release: 0 } }) });
  await settle();
  const [card] = cardsOf(h);
  assert.ok(card, 'no card drawn at all');
  assert.equal(card.stage, 'Gate tests');
  assert.equal(card.open, false, 'the card arrived unfolded — the summary is meant to be the collapsed state');
});

await check('and a release that is live says which release it went out in, not the word Live', async () => {
  const h = load({
    payload: queues({
      repos: [repo({ release: [releaseEntry({ stage: 'live', stageLabel: 'Live', ago: 0, rungs: RELEASE_RUNGS(6) })] })],
      counts: { merge: 0, release: 1 },
    }),
  });
  await settle();
  const [card] = cardsOf(h);
  // "Live" alone would be true and useless: the board keeps an entry one release past the
  // one that made it live, so *which* release is the whole of what distinguishes them.
  assert.equal(card.stage, 'live in what is running now');
  // `queue-good`, not `good`. Every class on the card is prefixed, kind and tone alike,
  // because `.release` is already the Ship strip's box on the PR board and a bare kind
  // class inherited its padding and its background.
  assert.ok(card.classes.includes('queue-good'), `a live release is not toned as one — ${card.classes.join(' ')}`);
});

await check('an entry one release back says so rather than reading as current', async () => {
  const h = load({
    payload: queues({
      repos: [repo({ release: [releaseEntry({ stage: 'live', stageLabel: 'Live', ago: 1, rungs: RELEASE_RUNGS(6) })] })],
    }),
  });
  await settle();
  assert.equal(cardsOf(h)[0].stage, 'live — one release back');
});

await check('both queues are drawn, each under its own heading and count', async () => {
  const h = load({
    payload: queues({
      repos: [repo({ merge: [mergeEntry()], release: [releaseEntry()] })],
      counts: { merge: 1, release: 1 },
    }),
  });
  await settle();
  const secs = sectionsOf(h);
  assert.deepEqual(secs, ['merge|Merging 1', 'release|Releasing 1']);
});

await check('and an empty queue says which kind of empty it is', async () => {
  const h = load({ payload: queues() });
  await settle();
  const words = strip(h.out.innerHTML);
  assert.match(words, /Nothing is waiting to merge/);
  assert.match(words, /Everything merged is live/);
});

/* ============================================== 2. one renderer over both queues */

await check('tapping a merge card opens the merge ladder, whole', async () => {
  const h = load({ payload: queues({ repos: [repo({ merge: [mergeEntry()] })] }) });
  await settle();
  h.tap('merge:demo:de-m01');
  assert.deepEqual(rungsOf(h), [
    'done:Queued for merge',
    'done:Downmerging',
    'done:Resolving conflicts',
    'now:Gate tests',
    'pending:Resolving issues',
  ]);
});

await check('tapping it again folds it', async () => {
  const h = load({ payload: queues({ repos: [repo({ merge: [mergeEntry()] })] }) });
  await settle();
  h.tap('merge:demo:de-m01');
  h.tap('merge:demo:de-m01');
  assert.deepEqual(rungsOf(h), []);
});

await check('and the same tap on a release card opens the release ladder — one renderer, not two', async () => {
  const h = load({ payload: queues({ repos: [repo({ release: [releaseEntry()] })] }) });
  await settle();
  h.tap('release:demo:40');
  const ladder = rungsOf(h);
  assert.equal(ladder.length, 7, `${ladder.length} rungs — the release ladder is seven`);
  assert.equal(ladder[0], 'now:Merged');
});

await check('only one card is open at a time', async () => {
  const h = load({ payload: queues({ repos: [repo({ merge: [mergeEntry()], release: [releaseEntry()] })] }) });
  await settle();
  h.tap('merge:demo:de-m01');
  h.tap('release:demo:40');
  assert.equal(cardsOf(h).filter((c) => c.open).length, 1);
});

await check('a refusal is on the card that was refused, in the sentence the queue wrote', async () => {
  const h = load({
    payload: queues({
      repos: [
        repo({
          merge: [
            mergeEntry({
              stage: 'conflicts',
              stageLabel: 'Resolving conflicts',
              refused: 'the branch conflicts with its base',
              rungs: MERGE_RUNGS(2),
            }),
          ],
        }),
      ],
    }),
  });
  await settle();
  h.tap('merge:demo:de-m01');
  assert.match(strip(h.out.innerHTML), /the branch conflicts with its base/);
});

/* =========================================== 3. untracked is never drawn as done */

await check('a release that is live still has three rungs nobody observed', async () => {
  const h = load({
    payload: queues({
      repos: [repo({ release: [releaseEntry({ stage: 'live', stageLabel: 'Live', ago: 0, rungs: RELEASE_RUNGS(6) })] })],
    }),
  });
  await settle();
  h.tap('release:demo:40');
  const ladder = rungsOf(h);
  assert.equal(
    ladder.filter((r) => r.startsWith('untracked:')).length,
    3,
    `the three the deploy journal cannot see were not drawn as untracked — ${JSON.stringify(ladder)}`
  );
  assert.ok(
    !ladder.some((r) => r === 'done:Green verification'),
    'a green verification nobody ran was ticked off by the entry having gone live'
  );
});

await check('and each of them says "not tracked" in a word, not only in a colour', async () => {
  const h = load({
    payload: queues({
      repos: [repo({ release: [releaseEntry({ stage: 'live', stageLabel: 'Live', ago: 0, rungs: RELEASE_RUNGS(6) })] })],
    }),
  });
  await settle();
  h.tap('release:demo:40');
  const said = [...String(h.out.innerHTML).matchAll(/<span class="queue-untracked">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.equal(said.length, 3);
  assert.ok(
    said.every((w) => /not tracked/i.test(w)),
    `the word is not on the rung — ${JSON.stringify(said)}`
  );
});

await check('but a handover that was recorded is done, with the time on it', async () => {
  const observed = {
    'Deployed to green': '2026-08-09T08:58:00Z',
    'Green verification': '2026-08-09T08:58:20Z',
    'Swapping to blue': '2026-08-09T08:58:30Z',
  };
  const h = load({
    payload: queues({
      repos: [
        repo({
          release: [
            releaseEntry({ stage: 'live', stageLabel: 'Live', ago: 0, rungs: RELEASE_RUNGS(6, observed) }),
          ],
        }),
      ],
    }),
  });
  await settle();
  h.tap('release:demo:40');
  const ladder = rungsOf(h);
  assert.ok(ladder.includes('done:Green verification'), `a recorded verification was not drawn as done — ${JSON.stringify(ladder)}`);
  assert.equal(
    [...String(h.out.innerHTML).matchAll(/queue-untracked/g)].length,
    0,
    'the word "not tracked" is still on a rung something did record'
  );
});

/* ====================================================== 4. what it asks for, and when */

await check('one request per endpoint at boot, and the token rides on both', async () => {
  const h = load();
  await settle();
  const paths = h.calls.map((c) => c.path).sort();
  assert.deepEqual(paths, ['/api/deploys', '/api/queues']);
  assert.ok(
    h.calls.every((c) => c.token === 'tok'),
    'a request went out unpaired'
  );
});

await check('the ⟳ forces the sweep rather than taking the kept answer', async () => {
  const h = load();
  await settle();
  h.refresh.events.click();
  await settle();
  const forced = h.calls.filter((c) => c.path === '/api/queues' && c.refresh);
  assert.equal(forced.length, 1, 'the refresh asked for the cached queues');
});

await check('with nothing deploying the strip arms the fallback tick and nothing faster', async () => {
  const h = load();
  await settle();
  const last = h.timers[h.timers.length - 1];
  assert.ok(last, 'no fallback timer at all — a page with no stream would never refresh');
  assert.equal(last.ms, 30000, `armed a ${last.ms}ms tick over an idle page`);
});

await check('a deploy in flight puts it on the fast one', async () => {
  const h = load({
    deploys: { deployable: ['demo'], deploys: [{ id: 'd1', workspace: 'demo', status: 'deploying', restarts: true, startedAt: '2026-08-09T08:59:00Z', steps: [] }] },
  });
  await settle();
  const last = h.timers[h.timers.length - 1];
  assert.equal(last.ms, 4000, `a deploy in flight is watched every ${last.ms}ms`);
  assert.match(strip(h.out.innerHTML), /restarting beadcause/);
});

await check('the picker narrows what is drawn without asking again', async () => {
  const h = load({ payload: queues({ repos: [repo({ merge: [mergeEntry()] })] }) });
  await settle();
  assert.equal(cardsOf(h).length, 1);
  const before = h.calls.length;
  h.pick(() => false);
  assert.equal(cardsOf(h).length, 0, 'a repo outside the space is still drawn');
  assert.equal(h.calls.length, before, 'moving the picker refetched a payload that already held every repo');
});

await check('a repo that can release nothing says so rather than looking like a quiet one', async () => {
  const h = load({
    payload: queues({ repos: [repo({ releasable: false, deployDeclared: false, deployTracked: false, merge: [mergeEntry()] })] }),
  });
  await settle();
  assert.match(strip(h.out.innerHTML), /Nothing is released from here in demo/);
});

await check('a tracker that would not answer is a line, not a queue with nothing in it', async () => {
  const h = load({ payload: queues({ errors: [{ workspace: 'other', error: 'dolt is mid-write' }] }) });
  await settle();
  assert.match(strip(h.out.innerHTML), /Could not read the merge queue in other/);
});

await check('an unpaired device is told to pair rather than shown an empty board', async () => {
  const h = load({ token: '' });
  await settle();
  assert.match(strip(h.out.innerHTML), /not paired/);
  assert.equal(h.calls.length, 0, 'asked the daemon for something with no token to ask with');
});

/* ================================================================ 5. static reads */

const HTML = read('public/releases.html');
const JS = read('public/releases.js');

await check('every id the script reaches for is in the document', () => {
  const wanted = [...JS.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 3, `expected the script to name its elements, found ${wanted.length}`);
  const missing = wanted.filter((id) => !HTML.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `no element for: ${missing.join(', ')}`);
});

await check('the page loads prcard before its own script, and the row and the drawer at all', () => {
  const order = [...HTML.matchAll(/<script src="\/([a-z]+)\.js"><\/script>/g)].map((m) => m[1]);
  assert.ok(order.includes('viewbar'), 'no pill row: a page you cannot leave');
  assert.ok(order.includes('drawer'), 'no drawer: a bead pill would cost your place in the list');
  assert.ok(order.includes('spacebar'), 'no space picker: nothing to narrow forty repos with');
  assert.ok(
    order.indexOf('prcard') < order.indexOf('releases'),
    'releases.js runs before prcard.js, and it takes four helpers off it at module scope'
  );
});

await check('the page keeps what it fetched, and paints it before asking', () => {
  // A view in `VIEWS` that neither reads nor writes its own entry is a payload warmed
  // for nobody — the background fill still pays for it and no screen is any faster.
  assert.match(HTML, /<script src="\/warm\.js"><\/script>/, 'no warm layer loaded at all');
  assert.match(JS, /warm\?\.read\?\.\('\/api\/queues'\)/, 'nothing reads the held queues');
  assert.match(JS, /warm\?\.write\?\.\('\/api\/queues'/, 'nothing keeps what came back');
  const warm = read('public/warm.js');
  assert.match(warm, /\{ id: 'releases', paths: \['\/api\/queues'\], holdOnly: true \}/);
});

await check('the pill row has a Releases pill pointing at the page', () => {
  const bar = read('public/viewbar.js');
  assert.match(bar, /id: 'releases'/);
  assert.match(bar, /href: '\/releases'/);
  // The three addresses are declared once, in the grammar, since bc-khoe.30.2 — the row
  // asks `viewOfPath` rather than carrying its own copy, which is why the pill lights on
  // all three. Asserted here because a pill whose paths nothing declares never lights at
  // all, and the row itself would look perfectly correct while it happened.
  const grammar = read('public/hashroute.js');
  assert.match(grammar, /id: 'releases'/);
  assert.match(grammar, /paths: \['\/releases', '\/deploys', '\/releases\.html'\]/);
});

await check('the service worker precaches the page and moved its version', () => {
  const sw = read('public/sw.js');
  for (const p of ['/releases', '/deploys', '/releases.html', '/releases.js']) {
    assert.ok(sw.includes(`'${p}'`), `${p} is not in the shell`);
  }
  const version = sw.match(/const CACHE = 'beadcause-v(\d+)'/);
  assert.ok(version, 'no cache version at all');
  assert.ok(Number(version[1]) >= 73, `the pill and the page it points at must arrive together — v${version[1]} predates them`);
});

await check('the daemon serves /releases and /deploys', () => {
  assert.match(read('lib/server.js'), /urlPath === '\/releases' \|\| urlPath === '\/deploys'\) urlPath = '\/releases\.html'/);
});

/* The point of bc-khoe.7 is not that a new page draws a deploy. It is that the board
   stopped — and a poll left behind there is invisible from the board itself, because
   nothing on it would draw what came back. */
await check('the PR board no longer asks for the deploy journal at all', () => {
  const prs = read('public/prs.js');
  assert.ok(!/fetch\(`?\/api\/deploys/.test(prs), 'public/prs.js still fetches /api/deploys');
  assert.ok(!/function deploysHtml/.test(prs), 'public/prs.js still draws the strip');
});

await check('and the board keeps the Ship button and the count over it', () => {
  const prs = read('public/prs.js');
  assert.match(prs, /release-count/, 'the count over Ship is gone with the strip — it is about the rows, not the deploy');
  assert.match(prs, /'\/api\/release\/ship'/, 'Ship no longer ships the queue');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
