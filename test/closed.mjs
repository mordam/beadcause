#!/usr/bin/env node
/**
 * What landed — the closed beads, in what order, and how a page of them is cut.
 *
 *     npm test
 *     node test/closed.mjs
 *
 * This is the one list in the app that pages, and everything worth asserting here is a
 * consequence of that. A screen that merely *displays* the wrong thing is a screen you
 * argue with; a paged one that cuts its slices wrongly loses rows silently, and a history
 * with a hole in it looks exactly like a week where nothing was finished.
 *
 * What is asserted, and why each is here rather than assumed:
 *
 * 1. **The order is newest-close-first and it is *total*.** The tie-break on id is not
 *    tidiness — it is what makes `offset` mean the same thing on the second request as on
 *    the first. Two beads closed in the same second under an unstable sort put one row on
 *    both pages and drop another off the end, and nothing on the page would say so. Beads
 *    closing in the same second is the normal case here, not a contrived one: a delivery
 *    closes its work bead and its merge card together.
 * 2. **The filter is applied *before* the slice, at both of its levels.** The whole reason
 *    this endpoint takes a filter at all (see lib/history.js). Narrowing after the slice
 *    is the bug it exists to prevent, and it is invisible from a single request — you have
 *    to ask for a page and count what came back.
 * 3. **A page is a page, and running off the end is empty rather than an error.** The
 *    picker can narrow while you are three pages down.
 * 4. **`limit` is clamped.** The point of paging is that one request cannot be the 1.29 MB
 *    download; a client asking for 99999 must not undo that.
 * 5. **A workspace whose `bd` threw is named in `errors` and the rest still answer.** The
 *    failure this screen could have is an empty history over a repo that fell over.
 * 6. **The reason arrives whole, and the fat fields do not arrive at all.** Both halves
 *    matter: the reason is the content of the row and is drawn nowhere else in the app,
 *    and a row carrying the description would make forty of them a download.
 * 7. **The three counts mean three different things.** `total`, `matched` and `shown` get
 *    confused for one another, and the page quotes `matched` out loud — "12 closed beads"
 *    over a month of work is the kind of number somebody repeats.
 * 8. **`closed` is on the advocate console's counts**, because that pill is the only door
 *    to this page and it is drawn from that field.
 *
 * No real tracker: `bd` is a stub binary over a JSON file, keyed by workspace directory so
 * that "one list across every repo" is a claim this stub could actually falsify. The route
 * is exercised over a real socket against `createApp`, because the clamping and the
 * defaulting live in the handler rather than in the module under it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-closed-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { closedHistory, forget, toRow, newestClosedFirst, PAGE_MAX, PAGE_DEFAULT } = await import(LIB('history.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, keyed by workspace directory — `BEADS_DIR` is how `Bd.run`
 * says which workspace it means, so the stub resolves the same way bd itself does.
 *
 * `list` honours only `--status=` and `--limit`, which is what `Bd.listStatus` sends, and
 * answers `[]` for anything else rather than everything: a future call site reaching for a
 * flag this stub silently ignored should come back empty here rather than pass against a
 * fiction. `status` answers the one summary field the console's `closed` count reads.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const dir = process.env.BEADS_DIR || '';
const world = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const w = world[dir];
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
if (!w) die('no beads database found in ' + dir);
if (w.broken) die('Error: dolt: could not open database');
const all = () => Object.values(w.issues || {});

if (args[0] === 'status') {
  const rows = all();
  process.stdout.write(JSON.stringify({ summary: {
    open_issues: rows.filter((i) => (i.status || 'open') === 'open').length,
    ready_issues: 0,
    blocked_issues: 0,
    in_progress_issues: 0,
    closed_issues: rows.filter((i) => i.status === 'closed').length,
  } }));
  process.exit(0);
}
if (args[0] === 'list') {
  const status = (args.find((a) => a.startsWith('--status=')) || '').slice('--status='.length);
  const want = status ? status.split(',') : null;
  process.stdout.write(JSON.stringify(all().filter((i) => !want || want.includes(i.status || 'open'))));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const dirOf = (name) => path.join(tmp, name, '.beads');
for (const name of ['alpha', 'beta', 'broken']) fs.mkdirSync(dirOf(name), { recursive: true });

const ALPHA = { name: 'alpha', dir: dirOf('alpha') };
const BETA = { name: 'beta', dir: dirOf('beta') };
const BROKEN = { name: 'broken', dir: dirOf('broken') };

/** One closed bead as `bd list --json` hands it back — bd's field names, not a row's. */
const closed = (id, at, extra = {}) => ({
  id,
  title: `bead ${id}`,
  // The three fat fields. Present on every row the stub serves, precisely so that their
  // absence from the payload is a thing this suite can prove rather than assume.
  description: 'a long description that has no business on a history row'.repeat(20),
  acceptance_criteria: 'how we would know it is done',
  notes: 'supplementary',
  status: 'closed',
  issue_type: 'task',
  priority: 2,
  labels: [],
  created_at: at,
  updated_at: at,
  closed_at: at,
  close_reason: `Landed as #1 as abc1234 — still owed: CAN BE DEPLOYED`,
  ...extra,
});

const AT = (n) => `2026-08-${String(n).padStart(2, '0')}T10:00:00Z`;

/* Two workspaces of history plus one that cannot be read. `same-*` in alpha share a
   closed_at to the second, which is what assertion 1 is about. */
fs.writeFileSync(
  WORLD,
  JSON.stringify({
    [ALPHA.dir]: {
      issues: {
        'aa-new': closed('aa-new', AT(9)),
        'aa-old': closed('aa-old', AT(1)),
        'aa-open': { ...closed('aa-open', AT(5)), status: 'open', closed_at: null, close_reason: '' },
        'same-b': closed('same-b', AT(7)),
        'same-a': closed('same-a', AT(7)),
      },
    },
    [BETA.dir]: {
      issues: {
        'bb-mid': closed('bb-mid', AT(8)),
        'bb-quiet': closed('bb-quiet', AT(2), { close_reason: '' }),
      },
    },
    [BROKEN.dir]: { broken: true },
  })
);

/* `bin`, not `bdBin` — `cfg.bdBin` is what createApp reads, and the constructor renames
   it. Getting that wrong is not a crash: `this.bin` is `undefined`, execFile fails for
   every workspace, and the sweep reports all three as errors and an empty history, which
   reads exactly like a filter that matches nothing. */
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

/** Run `fn` with `extra` issues grafted onto a workspace, and take them off afterwards. */
async function withIssues(dir, extra, fn) {
  const world = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
  Object.assign(world[dir].issues, extra);
  fs.writeFileSync(WORLD, JSON.stringify(world));
  forget();
  try {
    await fn();
  } finally {
    // In a `finally` deliberately: an assertion that throws mid-test used to skip the
    // cleanup, and the grafted bead then failed every check after it — six red tests over
    // one real failure, none of them naming the bead that was still there.
    for (const id of Object.keys(extra)) delete world[dir].issues[id];
    fs.writeFileSync(WORLD, JSON.stringify(world));
    forget();
  }
}

/* Two spaces, so both levels of the filter are real. `beta` is in no space at all, which
   is `Other` — the same synthetic group `matchesFilter` reads on the server. */
const CFG = {
  workspaces: [ALPHA, BETA, BROKEN],
  spaces: [{ name: 'Personal', workspaces: ['alpha'] }],
};

let ran = 0;
let failures = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const ids = (r) => r.beads.map((b) => b.id);

console.log('\nwhat landed\n');

/* ------------------------------------------------------------------- the row */

await check('a bd row becomes a history row, with issue_type renamed and the fat fields dropped', () => {
  const row = toRow('alpha', 'Personal', closed('aa-x', AT(3)));
  assert.equal(row.type, 'task', 'issue_type is what a row calls it; a row reading .type would be blank');
  assert.equal(row.key, 'alpha/aa-x');
  assert.equal(row.space, 'Personal', 'carried on the row so matchesFilter can be handed it as-is');
  assert.equal(row.closedAt, AT(3));
  assert.equal(row.reason, 'Landed as #1 as abc1234 — still owed: CAN BE DEPLOYED');
  for (const gone of ['description', 'acceptance', 'notes']) {
    assert.ok(!(gone in row), `${gone} on forty rows is a download, not a list`);
  }
});

await check('a bead closed without closed_at falls back to updated_at rather than sorting to the bottom for ever', () => {
  const row = toRow('alpha', null, { id: 'aa-y', title: 't', updated_at: AT(4), closed_at: null });
  assert.equal(row.closedAt, AT(4));
});

await check('the order is newest close first, and total — ties break on id, which is what makes offset stable', () => {
  const rows = [
    toRow('alpha', null, closed('same-b', AT(7))),
    toRow('alpha', null, closed('same-a', AT(7))),
    toRow('alpha', null, closed('aa-new', AT(9))),
  ].sort(newestClosedFirst);
  assert.deepEqual(rows.map((r) => r.id), ['aa-new', 'same-a', 'same-b']);
  // The claim being made is that the comparator is a total order, so assert it directly:
  // no two distinct rows may compare equal, or a sort is free to interleave them.
  assert.notEqual(newestClosedFirst(rows[1], rows[2]), 0, 'two rows that compare equal can swap between pages');
});

/* ------------------------------------------------------------------ the sweep */

await check('every workspace at once, closed only, newest first', async () => {
  forget();
  const r = await closedHistory(bd, CFG, { limit: 50 });
  assert.deepEqual(ids(r), ['aa-new', 'bb-mid', 'same-a', 'same-b', 'bb-quiet', 'aa-old']);
  assert.ok(!ids(r).includes('aa-open'), 'an open bead has not landed');
});

await check('a workspace whose bd threw is named, and the others still answer', async () => {
  forget();
  const r = await closedHistory(bd, CFG, { limit: 50 });
  assert.deepEqual(r.errors.map((e) => e.workspace), ['broken']);
  assert.ok(r.errors[0].error, 'named with a reason, not just named');
  assert.ok(!/\n/.test(r.errors[0].error), 'one line — this is drawn on a phone');
  assert.equal(r.counts.total, 6, 'a repo that could not be read must not silently shrink the history');
});

await check('the reason arrives whole, however long it is', async () => {
  await withIssues(ALPHA.dir, { 'aa-wordy': closed('aa-wordy', AT(10), { close_reason: 'x'.repeat(1700) }) }, async () => {
    const r = await closedHistory(bd, CFG, { limit: 50 });
    const row = r.beads.find((b) => b.id === 'aa-wordy');
    // Truncating it here would put the sentence nowhere a phone can reach: the bead detail
    // sheet does not draw close_reason at all.
    assert.equal(row.reason.length, 1700, 'the close reason is the content of this screen');
  });
});

await check('a bead closed with nothing said keeps an empty reason rather than inventing one', async () => {
  forget();
  const r = await closedHistory(bd, CFG, { limit: 50 });
  assert.equal(r.beads.find((b) => b.id === 'bb-quiet').reason, '');
});

/* ------------------------------------------------------------------ the slice */

await check('a page is a page, and `more` says whether asking again would bring anything', async () => {
  forget();
  const one = await closedHistory(bd, CFG, { limit: 2 });
  assert.deepEqual(ids(one), ['aa-new', 'bb-mid']);
  assert.equal(one.more, true);
  assert.equal(one.counts.shown, 2);

  const two = await closedHistory(bd, CFG, { offset: 2, limit: 2 });
  assert.deepEqual(ids(two), ['same-a', 'same-b'], 'page two continues rather than repeating');
  assert.equal(two.more, true);

  const three = await closedHistory(bd, CFG, { offset: 4, limit: 2 });
  assert.deepEqual(ids(three), ['bb-quiet', 'aa-old']);
  assert.equal(three.more, false, 'the last page must not offer another');
});

await check('every page together is every bead, exactly once — which is the whole promise of paging', async () => {
  forget();
  const seen = [];
  for (let offset = 0; ; offset += 2) {
    const page = await closedHistory(bd, CFG, { offset, limit: 2 });
    seen.push(...ids(page));
    if (!page.more) break;
    assert.ok(offset < 20, 'more never went false');
  }
  assert.deepEqual(seen, ['aa-new', 'bb-mid', 'same-a', 'same-b', 'bb-quiet', 'aa-old']);
  assert.equal(new Set(seen).size, seen.length, 'a row on two pages is a row that also fell off the end');
});

await check('an offset past the end is an empty page, not an error — the picker can narrow under you', async () => {
  forget();
  const r = await closedHistory(bd, CFG, { offset: 999, limit: 10 });
  assert.deepEqual(ids(r), []);
  assert.equal(r.more, false);
  assert.equal(r.counts.matched, 6, 'and it still says how much history there is');
});

await check('limit is clamped, so one request cannot undo paging', async () => {
  forget();
  assert.equal((await closedHistory(bd, CFG, { limit: 99999 })).limit, PAGE_MAX);
  assert.equal((await closedHistory(bd, CFG, { limit: 0 })).limit, PAGE_DEFAULT, 'nought is not a page');
  assert.equal((await closedHistory(bd, CFG, { limit: -5 })).limit, PAGE_DEFAULT);
  assert.equal((await closedHistory(bd, CFG, { offset: -20, limit: 2 })).offset, 0);
});

/* ------------------------------------------------------------------ the filter */

await check('the filter narrows before the slice, at the workspace level', async () => {
  forget();
  const r = await closedHistory(bd, CFG, { filter: { workspace: 'beta' }, limit: 2 });
  assert.deepEqual(ids(r), ['bb-mid', 'bb-quiet']);
  // The bug this endpoint's shape exists to prevent: narrowing afterwards would have made
  // this a page of two rows out of which one survived.
  assert.equal(r.counts.shown, 2, 'a page of two must be two rows of the repo you asked for');
  assert.equal(r.counts.matched, 2);
  assert.equal(r.counts.total, 6, 'and it still knows how much it did not show you');
  assert.equal(r.more, false);
});

await check('and at the space level, with a workspace in no space answering to Other', async () => {
  forget();
  const personal = await closedHistory(bd, CFG, { filter: { space: 'Personal' }, limit: 50 });
  assert.deepEqual(ids(personal), ['aa-new', 'same-a', 'same-b', 'aa-old']);
  const other = await closedHistory(bd, CFG, { filter: { space: 'Other' }, limit: 50 });
  assert.deepEqual(ids(other), ['bb-mid', 'bb-quiet']);
});

await check('an unnamed filter is everything, not nothing — silence is the one answer it must not mean', async () => {
  forget();
  const bare = await closedHistory(bd, CFG, { limit: 50 });
  const explicit = await closedHistory(bd, CFG, { filter: { space: 'all', workspace: 'all' }, limit: 50 });
  const empty = await closedHistory(bd, CFG, { filter: { space: '', workspace: null }, limit: 50 });
  assert.deepEqual(ids(bare), ids(explicit));
  assert.deepEqual(ids(bare), ids(empty));
  assert.deepEqual(bare.filter, { space: 'all', workspace: 'all' }, 'and it says back what it applied');
});

await check('byWorkspace counts the matched set, so All gets the tally that says where the history is', async () => {
  forget();
  const all = await closedHistory(bd, CFG, { limit: 1 });
  assert.deepEqual(all.counts.byWorkspace, { alpha: 4, beta: 2 });
  const narrowed = await closedHistory(bd, CFG, { filter: { workspace: 'beta' }, limit: 1 });
  assert.deepEqual(narrowed.counts.byWorkspace, { beta: 2 }, 'a tally over rows you cannot see is not a tally');
});

/* ------------------------------------------------------------------- the cache */

await check('the sweep is cached, and refresh is what redoes it', async () => {
  forget();
  let clock = 0;
  const now = () => clock;
  // Swept before the bead exists, so the cache genuinely predates it. Grafted by hand
  // rather than through `withIssues`, which drops the cache on the way in — here the stale
  // cache *is* what is under test, so it has to survive the graft.
  await closedHistory(bd, CFG, { limit: 50, now });
  const world = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
  world[ALPHA.dir].issues['aa-later'] = closed('aa-later', AT(11));
  fs.writeFileSync(WORLD, JSON.stringify(world));
  try {
    clock = 1000;
    const again = await closedHistory(bd, CFG, { limit: 50, now });
    assert.ok(!ids(again).includes('aa-later'), 'a second look inside the minute is the same sweep');

    const forced = await closedHistory(bd, CFG, { limit: 50, refresh: true, now });
    assert.equal(ids(forced)[0], 'aa-later', 'refresh is ⟳, and it is the whole invalidation story');
  } finally {
    delete world[ALPHA.dir].issues['aa-later'];
    fs.writeFileSync(WORLD, JSON.stringify(world));
    forget();
  }
});

/* --------------------------------------------------------------- over the wire */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  host: '127.0.0.1',
  // Bound by the kernel and read back off the listener, so two overlapping `npm test`
  // runs cannot make this suite fail as though it were a regression.
  port: 0,
  baseUrl: 'http://127.0.0.1',
  token: 'closed-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [ALPHA, BETA, BROKEN],
  spaces: CFG.spaces,
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const get = (pathname) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { 'x-beadcause-token': cfg.token } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.end();
  });

await check('GET /api/closed is the history, newest first, with no parameters at all', async () => {
  forget();
  const res = await get('/api/closed?refresh=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.beads.map((b) => b.id), ['aa-new', 'bb-mid', 'same-a', 'same-b', 'bb-quiet', 'aa-old']);
  assert.equal(res.json.limit, PAGE_DEFAULT, 'a caller that names no limit gets the module’s default');
  assert.deepEqual(res.json.filter, { space: 'all', workspace: 'all' });
  assert.deepEqual(res.json.errors.map((e) => e.workspace), ['broken']);
});

await check('the query carries the filter, the offset and the limit', async () => {
  const res = await get('/api/closed?space=Personal&offset=1&limit=2');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.beads.map((b) => b.id), ['same-a', 'same-b']);
  assert.equal(res.json.offset, 1);
  assert.equal(res.json.more, true);
  assert.deepEqual(res.json.filter, { space: 'Personal', workspace: 'all' });
});

await check('a nonsense query is answered rather than refused — nothing here is a 400', async () => {
  for (const q of ['limit=abc', 'limit=99999', 'offset=-3', 'offset=nope', 'offset=999999', 'workspace=ghost']) {
    const res = await get(`/api/closed?${q}`);
    assert.equal(res.status, 200, `${q} answered ${res.status}`);
    assert.ok(Array.isArray(res.json.beads), q);
    assert.ok(res.json.limit >= 1 && res.json.limit <= PAGE_MAX, `${q} left limit at ${res.json.limit}`);
    assert.ok(res.json.offset >= 0, `${q} left offset at ${res.json.offset}`);
  }
});

await check('the advocate console carries a `closed` count, which is the only door to this page', async () => {
  const res = await get('/api/work');
  assert.equal(res.status, 200);
  const alpha = res.json.workspaces.find((w) => w.name === 'alpha');
  assert.equal(alpha.counts.closed, 4, 'the pill is drawn from this, and bd status has always carried it');
  const broken = res.json.workspaces.find((w) => w.name === 'broken');
  assert.equal(broken.counts.closed, undefined, 'a repo that could not be read draws no pill rather than a nought');
});

for (const s of servers || []) s.close?.();
app.stop?.();

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
