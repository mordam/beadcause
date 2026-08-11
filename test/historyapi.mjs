#!/usr/bin/env node
/**
 * The ledger endpoint: order, filters, paging, the session marker, and the four ways
 * each of them can quietly lie.
 *
 *     npm test
 *     node test/historyapi.mjs
 *
 * `GET /api/history` is the one route that answers a question about the past, and almost
 * every way it can be wrong is a way that *looks* right on screen. A list is the worst
 * shape for a silent bug: rows appear, they are plausible, and nothing about a page of
 * beads says which beads are missing from it. So the claims are asserted one at a time.
 *
 * 1. **`bd` is asked for everything, once.** `bd list` hides closed issues by default and
 *    stops at fifty without saying so, and the whole premise here is the closed ones —
 *    three hundred of them in this repo. Either default turns the ledger into a list of
 *    live work with a History label on it.
 * 2. **Newest-*updated* first, and stably.** Not newest-filed, which is what every other
 *    list here does: the bead you want after a night of unattended sessions is the one
 *    that just closed, and it may have been filed in April. The tie-break is not
 *    decoration — a delivery closes a bead and its epic in the same second, and without a
 *    second key those two rows can swap between pages of one scroll, which shows the
 *    reader a row twice or not at all.
 * 3. **A filter is honoured or refused, never dropped.** `status=close` matching nothing
 *    would draw an empty list under a control that says "closed", and an empty ledger is
 *    exactly what a space with no beads looks like. So a bad value is a 400 naming the
 *    word.
 * 4. **`more` is counted, not inferred.** `rows.length === limit` is wrong exactly once
 *    per list — on the page whose last row lands on the boundary — and the symptom is an
 *    infinite scroller that spins at the bottom for ever. That page is asserted directly.
 * 5. **Provenance is the label, not the byline.** `created_by` is a field an agent writes
 *    for itself, so a row whose byline says `beadcause` and whose labels do not carry
 *    `agent-filed` is a *human* bead. The fixture below contains that exact
 *    disagreement, because it is the one case where reading the easy field looks correct.
 * 6. **The session marker costs one `git` call, and cannot cost the list.** One
 *    `for-each-ref` for the page, asserted against a real repo with real refs — and a
 *    marker that throws, synchronously or otherwise, still leaves every row present.
 * 7. **The cache is per workspace and unfiltered**, so a filter chip and a whole scroll
 *    are one `bd` call between them rather than one each.
 *
 * The HTTP half boots the real `createApp` against a fake `bd` binary, for the reason
 * test/routes.mjs sets out at length: a suite that asserts a contract against its own
 * fake server can be green while the real server answers something else entirely.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-historyapi-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n').slice(0, 4).join('\n      ')}`);
  }
};
const acheck = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n').slice(0, 4).join('\n      ')}`);
  }
};

const history = await import(LIB('history.js'));
const { Bd, BD_TIMEOUT } = await import(LIB('bd.js'));
const { archivedBeads } = await import(LIB('sessionlog.js'));
const { ledger, matches, newestUpdatedFirst, parseQuery, toRow, forget, PAGE_DEFAULT, PAGE_MAX } = history;

const WS = { name: 'demo', dir: path.join(tmp, 'ws', '.beads') };
const OTHER = { name: 'second', dir: path.join(tmp, 'ws2', '.beads') };

/**
 * The fixture, and every field of it earns its place.
 *
 * `updated_at` deliberately does not follow `created_at`: bc-old was filed first and
 * touched last, which is the whole reason the order is by update. Two rows share a second
 * (bc-tie1 / bc-tie2) to pin the tie-break. bc-byline carries `created_by: 'beadcause'`
 * with no `agent-filed` label — the disagreement claim 5 is about.
 */
const ROWS = [
  {
    id: 'bc-old',
    title: 'Filed first, touched last',
    status: 'closed',
    priority: 0,
    issue_type: 'feature',
    created_at: '2026-04-01T09:00:00Z',
    updated_at: '2026-08-11T15:00:27Z',
    closed_at: '2026-08-11T15:00:27Z',
    close_reason: 'Landed as #113 as e8315969 — still owed: CAN BE DEPLOYED',
    created_by: 'neadamthal@gmail.com',
    description: 'x'.repeat(4000),
    labels: [],
  },
  {
    id: 'bc-tie1',
    title: 'Closed in the same second as its epic',
    status: 'closed',
    priority: 2,
    issue_type: 'task',
    created_at: '2026-08-10T09:00:00Z',
    updated_at: '2026-08-11T11:16:41Z',
    close_reason: '',
    created_by: 'beadcause',
    labels: ['agent-filed'],
  },
  {
    id: 'bc-tie2',
    title: 'The epic',
    status: 'closed',
    priority: 1,
    issue_type: 'epic',
    created_at: '2026-08-09T09:00:00Z',
    updated_at: '2026-08-11T11:16:41Z',
    created_by: 'neadamthal@gmail.com',
    labels: [],
  },
  {
    id: 'bc-byline',
    title: 'A byline that says beadcause and no label that does',
    status: 'open',
    priority: 3,
    issue_type: 'task',
    created_at: '2026-08-11T08:00:00Z',
    updated_at: '2026-08-11T08:30:00Z',
    // The trap: an agent wrote this byline and it is not provenance. See claim 5.
    created_by: 'beadcause',
    labels: ['history'],
  },
  {
    id: 'bc-defer',
    title: 'Deferred, and still part of the record',
    status: 'deferred',
    priority: 4,
    issue_type: 'chore',
    created_at: '2026-07-01T08:00:00Z',
    updated_at: '2026-07-02T08:00:00Z',
    created_by: 'beadcause',
    labels: ['agent-filed', 'unendorsed'],
  },
  {
    id: 'bc-nib3.1',
    title: 'Serve the bead ledger for a space',
    status: 'in_progress',
    priority: 1,
    issue_type: 'task',
    created_at: '2026-08-11T12:00:00Z',
    updated_at: '2026-08-11T12:33:00Z',
    created_by: 'beadcause',
    labels: ['api', 'history'],
  },
];

/** A `Bd` whose `run` records its argv and answers from a fixture. */
function fakeBd(rows = ROWS) {
  const bd = new Bd({ bin: '/nonexistent/bd', actor: 'beadcause-test' });
  bd.calls = [];
  bd.opts = [];
  bd.run = async (workspace, args, opts = {}) => {
    bd.calls.push(`${workspace.name}: ${args.join(' ')}`);
    bd.opts.push(opts);
    return JSON.stringify(typeof rows === 'function' ? rows(workspace) : rows);
  };
  return bd;
}

/** A clock the cache can be walked forwards past. */
function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

/* ================================================== what bd is asked for, and once */

console.log('\nasking bd for the whole ledger');

await (async () => {
  const bd = fakeBd();
  await bd.listAll(WS);
  const argv = bd.calls.join(' | ');

  check('`--all`, or the closed beads the ledger exists for are simply not in it', () => {
    assert.match(argv, /list --all/, argv);
  });

  check('`--limit 0`, because bd stops at fifty and says nothing', () => {
    assert.match(argv, /--limit 0/, argv);
  });

  check('no status, priority or label filter is pushed down — the sweep is cached, so it must fit every query', () => {
    assert.ok(!/--status|--priority|--label|--exclude-label/.test(argv), argv);
  });

  check('it runs under a ceiling well past thirty seconds, and does not cut its own', () => {
    // Measured at 28.6s on this Mac under a load average of 33 — twenty sessions and a
    // full suite, which is an ordinary afternoon here. Under 30s the call throws, the
    // workspace becomes a row in `errors`, and a repo with five hundred beads draws an
    // empty ledger. This asked for a timeout of its own when it was the only call that
    // had been measured; bc-f9dl made that the default for every `bd` invocation, so what
    // is left to check is that the default is generous and this caller does not narrow it.
    assert.ok(BD_TIMEOUT >= 60000, `BD_TIMEOUT is ${BD_TIMEOUT}`);
    const asked = bd.opts[0].timeout;
    assert.ok(asked === undefined || asked >= 60000, `timeout is ${asked}`);
  });

  check('and the lock retries, because it shares the workspace with every other session', () => {
    assert.ok(bd.opts[0].retries > 0, JSON.stringify(bd.opts[0]));
  });
})();

/* ============================================================ one bd row, one ledger row */

console.log("\none row, in the app's vocabulary rather than bd's");

await (async () => {
  const archived = new Set(['bc-old']);
  const row = toRow('demo', ROWS[0], archived);
  const noSession = toRow('demo', ROWS[3], archived);

  check('`issue_type` → `type`, `updated_at` → `updated`, `close_reason` → `closeReason`', () => {
    assert.equal(row.type, 'feature');
    assert.equal(row.updated, '2026-08-11T15:00:27Z');
    assert.match(row.closeReason, /^Landed as #113/);
  });

  check('`updated` is bd\'s own ISO string, passed through untouched', () => {
    assert.equal(row.updated, ROWS[0].updated_at);
    assert.equal(typeof row.updated, 'string');
  });

  check('`closeReason` is present and null when there is none, never absent', () => {
    assert.ok('closeReason' in noSession, 'the key has to be there for `row.closeReason ?? ""` to be safe');
    assert.equal(noSession.closeReason, null);
    // An empty string from bd is null too — the row is drawn conditionally on it.
    assert.equal(toRow('demo', ROWS[1], archived).closeReason, null);
  });

  check('the four long text fields are gone — this is a list, and the sheet has them', () => {
    for (const gone of ['description', 'acceptance', 'acceptance_criteria', 'design', 'notes']) {
      assert.ok(!(gone in row), `${gone} is still on the row`);
    }
  });

  check('`hasSession` is a boolean either way, not undefined for the rows without one', () => {
    assert.equal(row.hasSession, true);
    assert.equal(noSession.hasSession, false);
  });

  check('no archived set at all means false everywhere rather than a crash', () => {
    assert.equal(toRow('demo', ROWS[0]).hasSession, false);
  });

  check('provenance comes off the `agent-filed` label', () => {
    assert.equal(toRow('demo', ROWS[1], archived).provenance, 'agent');
    assert.equal(toRow('demo', ROWS[4], archived).provenance, 'agent');
  });

  check('and NOT off `created_by` — a beadcause byline with no label is a human bead', () => {
    const byline = toRow('demo', ROWS[3], archived);
    assert.equal(byline.createdBy, 'beadcause', 'the fixture has to carry the disagreement');
    assert.equal(byline.provenance, 'human');
  });

  check('the byline still rides along, for display', () => {
    assert.equal(row.createdBy, 'neadamthal@gmail.com');
  });
})();

/* ==================================================================== the order */

console.log('\nnewest-updated first');

await (async () => {
  const bd = fakeBd();
  const c = clock();
  forget();
  const out = await ledger(bd, [WS], { limit: 100 }, { now: c.now });

  check('by `updated`, not `created` — bc-old was filed first and is at the top', () => {
    assert.equal(out.rows[0].id, 'bc-old');
    assert.deepEqual(
      out.rows.map((r) => r.id),
      ['bc-old', 'bc-nib3.1', 'bc-tie1', 'bc-tie2', 'bc-byline', 'bc-defer']
    );
  });

  check('two beads updated in the same second are broken by id, so pages cannot shuffle', () => {
    const pair = [{ id: 'bc-tie2', updated: 'z' }, { id: 'bc-tie1', updated: 'z' }].sort(newestUpdatedFirst);
    assert.deepEqual(pair.map((r) => r.id), ['bc-tie1', 'bc-tie2']);
  });

  check('and the tie-break counts numerically — bc-goo.11 is not between .1 and .2', () => {
    const kids = [
      { id: 'bc-goo.11', updated: 'z' },
      { id: 'bc-goo.2', updated: 'z' },
      { id: 'bc-goo.1', updated: 'z' },
    ].sort(newestUpdatedFirst);
    assert.deepEqual(kids.map((r) => r.id), ['bc-goo.1', 'bc-goo.2', 'bc-goo.11']);
  });

  check('a row with no `updated` at all sorts last rather than throwing', () => {
    const rows = [{ id: 'a', updated: null }, { id: 'b', updated: '2026-01-01T00:00:00Z' }].sort(newestUpdatedFirst);
    assert.deepEqual(rows.map((r) => r.id), ['b', 'a']);
  });

  check('every status is in it — closed, deferred and in_progress alike', () => {
    assert.deepEqual([...new Set(out.rows.map((r) => r.status))].sort(), [
      'closed',
      'deferred',
      'in_progress',
      'open',
    ]);
  });
})();

/* ================================================================== the filters */

console.log('\nfour filters, each narrowing and all composing');

await (async () => {
  const c = clock();
  const run = async (query) => {
    forget();
    return ledger(fakeBd(), [WS], { limit: 100, ...query }, { now: c.now });
  };

  const closed = await run({ status: ['closed'] });
  check('status narrows', () => {
    assert.deepEqual(closed.rows.map((r) => r.id), ['bc-old', 'bc-tie1', 'bc-tie2']);
  });

  const twoStates = await run({ status: ['open', 'in_progress'] });
  check('and takes more than one state at a time', () => {
    assert.deepEqual(twoStates.rows.map((r) => r.id), ['bc-nib3.1', 'bc-byline']);
  });

  const p1 = await run({ priority: [1] });
  check('priority narrows', () => {
    assert.deepEqual(p1.rows.map((r) => r.id), ['bc-nib3.1', 'bc-tie2']);
  });

  const agent = await run({ provenance: 'agent' });
  check('provenance narrows on the label', () => {
    assert.deepEqual(agent.rows.map((r) => r.id), ['bc-tie1', 'bc-defer']);
  });

  const human = await run({ provenance: 'human' });
  check('and its other half is everything without the label, byline notwithstanding', () => {
    assert.deepEqual(human.rows.map((r) => r.id), ['bc-old', 'bc-nib3.1', 'bc-tie2', 'bc-byline']);
  });

  const sub = await run({ id: 'tie' });
  check('the id filter is a substring, not a prefix or an exact match', () => {
    assert.deepEqual(sub.rows.map((r) => r.id), ['bc-tie1', 'bc-tie2']);
  });

  const upper = await run({ id: 'NIB3' });
  check('and is case-insensitive, because the box is typed into on a phone', () => {
    assert.deepEqual(upper.rows.map((r) => r.id), ['bc-nib3.1']);
  });

  check('it does not match titles — "history" is in two of them and no id', () => {
    assert.equal(matches(toRow('demo', ROWS[5]), { id: 'ledger' }), false);
  });

  const both = await run({ status: ['closed'], priority: [1, 2], id: 'tie' });
  check('all four compose, ANDed', () => {
    assert.deepEqual(both.rows.map((r) => r.id), ['bc-tie1', 'bc-tie2']);
  });

  const none = await run({ status: ['blocked'] });
  check('a filter that matches nothing is an empty list with a zero total, not an error', () => {
    assert.deepEqual(none.rows, []);
    assert.equal(none.total, 0);
    assert.equal(none.more, false);
  });
})();

/* ================================================================ reading the query */

console.log('\nthe query string is honoured or refused, never half-understood');

await (async () => {
  const q = (obj) => parseQuery(new Map(Object.entries(obj)));

  check('an empty query is every bead, one default page', () => {
    const { query, error } = q({});
    assert.equal(error, undefined);
    assert.deepEqual(query, { status: null, priority: null, provenance: null, id: '', limit: PAGE_DEFAULT, offset: 0 });
  });

  check('a misspelled status is refused, and the message names the word', () => {
    const { error, query } = q({ status: 'close' });
    assert.match(error || '', /not a status: close/);
    assert.equal(query, undefined, 'a half-understood query must not come back at all');
  });

  check('a comma list of statuses is read as one filter', () => {
    assert.deepEqual(q({ status: 'open,closed' }).query.status, ['open', 'closed']);
  });

  check('P1 as readily as 1, because that is what the chip displays', () => {
    assert.deepEqual(q({ priority: 'P1' }).query.priority, [1]);
    assert.deepEqual(q({ priority: '1' }).query.priority, [1]);
    assert.deepEqual(q({ priority: 'P0,2' }).query.priority, [0, 2]);
  });

  check('priority 5 is refused — bd has 0 to 4 and nothing else', () => {
    assert.match(q({ priority: '5' }).error || '', /not a priority: 5/);
    assert.match(q({ priority: 'high' }).error || '', /not a priority: high/);
  });

  check('provenance is agent or human and nothing else', () => {
    assert.equal(q({ provenance: 'agent' }).query.provenance, 'agent');
    assert.equal(q({ provenance: 'HUMAN' }).query.provenance, 'human');
    assert.match(q({ provenance: 'agent-filed' }).error || '', /not a provenance/);
  });

  check('a limit past the ceiling is clamped rather than refused — the set is right, the page is not', () => {
    assert.equal(q({ limit: '5000' }).query.limit, PAGE_MAX);
  });

  check('but a limit of nought is refused, because it describes no page at all', () => {
    assert.match(q({ limit: '0' }).error || '', /at least 1/);
  });

  check('a non-numeric limit or offset is refused rather than becoming page one', () => {
    assert.match(q({ limit: 'ten' }).error || '', /whole number/);
    assert.match(q({ offset: '-5' }).error || '', /whole number/);
    assert.match(q({ offset: '2.5' }).error || '', /whole number/);
  });

  check('an absurd id filter is refused — that is a paste, not a filter', () => {
    assert.match(q({ id: 'x'.repeat(200) }).error || '', /characters/);
  });

  check('a URLSearchParams reads the same as a Map', () => {
    const { query } = parseQuery(new URLSearchParams('status=closed&priority=P0&provenance=agent&id=nib&limit=7&offset=14'));
    assert.deepEqual(query, {
      status: ['closed'],
      priority: [0],
      provenance: 'agent',
      id: 'nib',
      limit: 7,
      offset: 14,
    });
  });
})();

/* ==================================================================== the paging */

console.log('\npaged, with a `more` that was counted');

await (async () => {
  const c = clock();
  const page = async (query) => {
    forget();
    return ledger(fakeBd(), [WS], query, { now: c.now });
  };

  const first = await page({ limit: 2, offset: 0 });
  check('the first page is the first N of the order', () => {
    assert.deepEqual(first.rows.map((r) => r.id), ['bc-old', 'bc-nib3.1']);
    assert.equal(first.total, 6);
    assert.equal(first.more, true);
  });

  const second = await page({ limit: 2, offset: 2 });
  check('and the second page continues it rather than repeating it', () => {
    assert.deepEqual(second.rows.map((r) => r.id), ['bc-tie1', 'bc-tie2']);
    assert.equal(second.more, true);
  });

  const last = await page({ limit: 2, offset: 4 });
  check('THE BOUNDARY PAGE: a full page that is the last page says `more: false`', () => {
    assert.equal(last.rows.length, 2, 'this page has to be exactly `limit` long or it proves nothing');
    assert.equal(last.offset + last.rows.length, last.total);
    assert.equal(last.more, false, '`rows.length === limit` would have said true here and spun for ever');
  });

  const past = await page({ limit: 2, offset: 99 });
  check('an offset past the end is an empty page, not an error', () => {
    assert.deepEqual(past.rows, []);
    assert.equal(past.total, 6);
    assert.equal(past.more, false);
  });

  await acheck('`total` is what the filters matched, before paging', async () => {
    const filtered = await page({ limit: 1, status: ['closed'] });
    assert.equal(filtered.total, 3);
    assert.equal(filtered.rows.length, 1);
    assert.equal(filtered.more, true);
  });
})();

/* ============================================================ spaces and empty ones */

console.log('\nmore than one workspace, and none at all');

await (async () => {
  const c = clock();
  forget();
  const bd = fakeBd((ws) =>
    ws.name === 'demo'
      ? ROWS
      : [
          {
            id: 'sp-a',
            title: 'A bead in the other repo',
            status: 'closed',
            priority: 1,
            issue_type: 'task',
            created_at: '2026-08-01T00:00:00Z',
            updated_at: '2026-08-11T13:00:00Z',
            labels: [],
          },
        ]
  );
  const merged = await ledger(bd, [WS, OTHER], { limit: 100 }, { now: c.now });

  check("a space's repos are merged and interleaved by date, not concatenated", () => {
    assert.deepEqual(merged.rows.map((r) => r.id), [
      'bc-old',
      'sp-a',
      'bc-nib3.1',
      'bc-tie1',
      'bc-tie2',
      'bc-byline',
      'bc-defer',
    ]);
  });

  check('every row says which repo it came from, so a merged list can label them', () => {
    assert.equal(merged.rows.find((r) => r.id === 'sp-a').workspace, 'second');
    assert.equal(merged.rows.find((r) => r.id === 'sp-a').key, 'second/sp-a');
  });

  check('and the payload names the repos it swept', () => {
    assert.deepEqual(merged.workspaces, ['demo', 'second']);
  });

  await acheck('no workspaces at all is an empty ledger with a 0 total, not a throw', async () => {
    forget();
    const empty = await ledger(fakeBd(), [], {}, { now: c.now });
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.more, false);
    assert.deepEqual(empty.errors, []);
  });

  await acheck('a workspace with no beads is an empty list, not an error', async () => {
    forget();
    const empty = await ledger(fakeBd([]), [WS], {}, { now: c.now });
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.total, 0);
  });

  await acheck('a repo whose bd fell over is a row in `errors` and costs only its own rows', async () => {
    forget();
    const broken = new Bd({ bin: '/nonexistent/bd', actor: 'beadcause-test' });
    broken.run = async (workspace) => {
      if (workspace.name === 'second') throw new Error('bd list failed in second: dolt: database is locked\nand a second line');
      return JSON.stringify(ROWS);
    };
    const out = await ledger(broken, [WS, OTHER], { limit: 100 }, { now: c.now });
    assert.equal(out.rows.length, 6, 'the healthy repo still draws');
    assert.deepEqual(out.errors.map((e) => e.workspace), ['second']);
    assert.match(out.errors[0].error, /database is locked/);
    assert.ok(!out.errors[0].error.includes('\n'), 'one line, because it is drawn in a strip');
  });
})();

/* ============================================================ the session marker */

console.log('\nthe session marker: one git call, and it can never cost the list');

await (async () => {
  const c = clock();

  await acheck('one `archivedFor` call per workspace per sweep — never one per row', async () => {
    forget();
    let calls = 0;
    const out = await ledger(
      fakeBd(),
      [WS],
      { limit: 100 },
      {
        now: c.now,
        archivedFor: async () => {
          calls += 1;
          return new Set(['bc-old', 'bc-tie1']);
        },
      }
    );
    assert.equal(calls, 1, `${calls} calls for ${out.rows.length} rows`);
    assert.deepEqual(out.rows.filter((r) => r.hasSession).map((r) => r.id), ['bc-old', 'bc-tie1']);
  });

  await acheck('a marker that rejects leaves every row present and unmarked', async () => {
    forget();
    const out = await ledger(fakeBd(), [WS], { limit: 100 }, { now: c.now, archivedFor: async () => { throw new Error('no git here'); } });
    assert.equal(out.rows.length, 6);
    assert.deepEqual(out.errors, [], 'a decoration must not become an error about the repo');
    assert.equal(out.rows.every((r) => r.hasSession === false), true);
  });

  await acheck('and one that throws SYNCHRONOUSLY does too — resolveSessionDir does exactly that', async () => {
    forget();
    // The route resolves the marker through `resolveSessionDir`, which throws a 409 for a
    // workspace it cannot map to a checkout. Thrown before a promise exists, that would
    // escape a plain `.catch` and cost the workspace its whole ledger.
    const out = await ledger(
      fakeBd(),
      [WS],
      { limit: 100 },
      {
        now: c.now,
        archivedFor: () => {
          throw Object.assign(new Error('no directory maps to the demo workspace'), { status: 409 });
        },
      }
    );
    assert.equal(out.rows.length, 6);
    assert.deepEqual(out.errors, []);
  });
})();

/* ==================================================== archivedBeads against real refs */

console.log('\nreading the refs a session actually leaves behind');

await (async () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@localhost');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'f'), 'x\n');
  git('add', 'f');
  git('commit', '-qm', 'first');
  const head = git('rev-parse', 'HEAD');
  // Exactly how lib/sessionlog.js stores an archive: a ref per bead under the prefix.
  for (const bead of ['bc-old', 'bc-nib3.1', 'bc-goo.11']) {
    git('update-ref', `refs/beadcause/sessions/${bead}`, head);
  }

  await acheck('every bead with an archive comes back, and nothing else does', async () => {
    const set = await archivedBeads(repo);
    assert.deepEqual([...set].sort(), ['bc-goo.11', 'bc-nib3.1', 'bc-old']);
    assert.equal(set.has('bc-tie1'), false);
  });

  await acheck('a dotted bead id survives the ref round trip', async () => {
    const set = await archivedBeads(repo);
    assert.equal(set.has('bc-nib3.1'), true, 'lstrip=3 must not have eaten the suffix');
  });

  await acheck('the branch itself is not a bead — only the sessions prefix is read', async () => {
    const set = await archivedBeads(repo);
    assert.equal(set.has('main'), false);
    assert.equal(set.has('HEAD'), false);
  });

  await acheck('a repo with no archives at all is an empty set, not a failure', async () => {
    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: bare });
    const set = await archivedBeads(bare);
    assert.equal(set.size, 0);
  });

  await acheck('and a directory that is not a repo is an empty set, not a throw', async () => {
    const set = await archivedBeads(path.join(tmp, 'config'));
    assert.equal(set.size, 0);
  });
})();

/* ====================================================================== the cache */

console.log('\none sweep serves every filter and every page');

await (async () => {
  const c = clock();
  forget();
  const bd = fakeBd();

  await ledger(bd, [WS], { limit: 2 }, { now: c.now });
  await ledger(bd, [WS], { limit: 2, offset: 2 }, { now: c.now });
  await ledger(bd, [WS], { status: ['closed'] }, { now: c.now });
  await ledger(bd, [WS], { priority: [1], id: 'nib' }, { now: c.now });

  check('four presses of a filter bar and two pages of a scroll are one `bd` call', () => {
    assert.equal(bd.calls.length, 1, bd.calls.join(' | '));
  });

  await acheck('and the cached rows are the unfiltered set, so a widened filter needs no sweep', async () => {
    const wide = await ledger(bd, [WS], { limit: 100 }, { now: c.now });
    assert.equal(wide.total, 6);
    assert.equal(bd.calls.length, 1, bd.calls.join(' | '));
  });

  await acheck('`refresh` sweeps again on demand', async () => {
    await ledger(bd, [WS], {}, { now: c.now, refresh: true });
    assert.equal(bd.calls.length, 2);
  });

  await acheck('and the sweep is redone once the cache has expired', async () => {
    c.advance(history.CACHE_MS + 1);
    await ledger(bd, [WS], {}, { now: c.now });
    assert.equal(bd.calls.length, 3);
  });

  await acheck('the cache is per workspace, so one repo does not serve another', async () => {
    forget();
    const two = fakeBd();
    await ledger(two, [WS], {}, { now: c.now });
    await ledger(two, [OTHER], {}, { now: c.now });
    assert.equal(two.calls.length, 2, two.calls.join(' | '));
  });

  /**
   * The window before the first answer exists is the expensive one: a cold sweep is ~1s
   * idle and 28.6s under load here, which is plenty of time for the phone and the laptop
   * to both open the tab. The cache cannot help there — there is nothing in it yet — so
   * the in-flight sweep is shared instead.
   */
  await acheck('two requests arriving before the first sweep returns are ONE `bd` call', async () => {
    forget();
    const slow = fakeBd();
    const inner = slow.run;
    slow.run = (workspace, args, opts) => new Promise((resolve) => setTimeout(() => resolve(inner(workspace, args, opts)), 40));

    const [a, b] = await Promise.all([
      ledger(slow, [WS], { limit: 2 }, { now: c.now }),
      ledger(slow, [WS], { limit: 2, offset: 2 }, { now: c.now }),
    ]);
    assert.equal(slow.calls.length, 1, slow.calls.join(' | '));
    // And both got a real answer rather than one of them getting an empty list.
    assert.equal(a.total, 6);
    assert.equal(b.total, 6);
    assert.deepEqual(b.rows.map((r) => r.id), ['bc-tie1', 'bc-tie2']);
  });

  await acheck('a `refresh` joins one already in flight rather than starting a second', async () => {
    forget();
    const slow = fakeBd();
    const inner = slow.run;
    slow.run = (workspace, args, opts) => new Promise((resolve) => setTimeout(() => resolve(inner(workspace, args, opts)), 40));
    await Promise.all([
      ledger(slow, [WS], {}, { now: c.now }),
      ledger(slow, [WS], {}, { now: c.now, refresh: true }),
    ]);
    assert.equal(slow.calls.length, 1, slow.calls.join(' | '));
  });

  await acheck('and a sweep that failed is retried rather than remembered', async () => {
    forget();
    let attempt = 0;
    const flaky = new Bd({ bin: '/nonexistent/bd', actor: 'beadcause-test' });
    flaky.run = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('dolt: database is locked');
      return JSON.stringify(ROWS);
    };
    const first = await ledger(flaky, [WS], {}, { now: c.now });
    assert.equal(first.errors.length, 1, 'the first attempt has to fail for this to prove anything');
    const second = await ledger(flaky, [WS], {}, { now: c.now });
    assert.equal(second.errors.length, 0, 'a failed sweep must not be cached as the answer');
    assert.equal(second.total, 6);
  });
})();

/* ================================================================== the real server */

console.log('\nthe real server answers it');

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });
const ws2Dir = path.join(tmp, 'ws2');
fs.mkdirSync(path.join(ws2Dir, '.beads'), { recursive: true });

// A `bd` that answers `list --all` with the fixture and everything else with nothing.
const FAKE = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const rows = ${JSON.stringify(JSON.stringify(ROWS))};
if (args[0] === 'list' && args.includes('--all')) {
  process.stdout.write(process.env.BEADS_DIR.includes('ws2') ? '[]' : rows);
} else {
  process.stdout.write('[]');
}
`,
  { mode: 0o755 }
);

const TOKEN = 'historyapi-token';
const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: TOKEN,
  actor: 'beadcause-test',
  bdBin: FAKE,
  workspaces: [
    { name: 'demo', dir: path.join(wsDir, '.beads') },
    { name: 'second', dir: path.join(ws2Dir, '.beads') },
  ],
  spaces: [{ name: 'Work', workspaces: ['demo'] }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));
const { boundPort } = await import('./helpers/net.mjs');

/**
 * `app.handler`, and `boundPort` to read the port back off the listener.
 *
 * Two traps, both of which cost this suite a hang rather than a failure.
 * `listen(cfg, handler)` takes the **handler**, not the app — and `http.createServer`
 * reads a non-function first argument as its *options*, so passing the app object binds
 * a perfectly healthy socket with no request listener behind it and every request waits
 * for ever. And `listen` returns an array of listeners *before* they are up, which is
 * what `boundPort` is for: port 0, so nothing races the ~20 concurrent `npm test` runs
 * for a number, and awaiting it means the socket is listening when the first request
 * goes out. See test/helpers/net.mjs.
 */
const app = createApp({ ...cfg, port: 0 });
const servers = listen({ ...cfg, port: 0 }, app.handler);
const port = await boundPort(servers);

/**
 * `agent: false` on every request, and it is not decoration.
 *
 * Node's global agent has kept connections alive by default since v19, so a socket from
 * one of these requests is still open when the suite finishes — and `server.close()`
 * waits for exactly that. The suite passed every check and then hung for ever, which
 * `npm test` reports as a timeout with no failing assertion in sight.
 */
const ask = (query) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/history${query}`,
        method: 'GET',
        agent: false,
        headers: { 'x-beadcause-token': TOKEN },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* a non-JSON body is the assertion's problem, not this function's */
          }
          resolve({ status: res.statusCode, body: json, raw: body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

await acheck('a workspace answers with rows, newest-updated first', async () => {
  forget();
  const { status, body } = await ask('?workspace=demo');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.workspace, 'demo');
  assert.equal(body.rows[0].id, 'bc-old');
  assert.equal(body.total, 6);
  assert.equal(body.more, false);
});

await acheck('the row carries exactly what the list draws from', async () => {
  forget();
  const { body } = await ask('?workspace=demo&id=bc-old');
  const row = body.rows[0];
  for (const key of ['id', 'title', 'type', 'status', 'priority', 'updated', 'closeReason', 'hasSession', 'createdBy', 'provenance', 'labels']) {
    assert.ok(key in row, `${key} is missing from the row`);
  }
  assert.equal(typeof row.hasSession, 'boolean');
  assert.equal(typeof row.updated, 'string');
});

await acheck('paging over HTTP, and `more` on the boundary page', async () => {
  forget();
  const first = await ask('?workspace=demo&limit=2');
  assert.deepEqual(first.body.rows.map((r) => r.id), ['bc-old', 'bc-nib3.1']);
  assert.equal(first.body.more, true);
  const boundary = await ask('?workspace=demo&limit=2&offset=4');
  assert.equal(boundary.body.rows.length, 2);
  assert.equal(boundary.body.more, false);
});

await acheck('the filters narrow over HTTP and compose', async () => {
  forget();
  const { body } = await ask('?workspace=demo&status=closed&priority=P1,P2&id=tie');
  assert.deepEqual(body.rows.map((r) => r.id), ['bc-tie1', 'bc-tie2']);
});

await acheck('a bad status is a 400 naming the word, not an empty list', async () => {
  const { status, body } = await ask('?workspace=demo&status=close');
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /not a status: close/);
});

await acheck('a bad priority is a 400 too', async () => {
  const { status, body } = await ask('?workspace=demo&priority=9');
  assert.equal(status, 400);
  assert.match(body.error, /not a priority/);
});

await acheck('an unknown workspace is a 400 — the client is confused, not the ledger empty', async () => {
  const { status, body } = await ask('?workspace=nope');
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /unknown workspace/);
});

await acheck('an unknown space is a 404, matching GET /api/space', async () => {
  const { status, body } = await ask('?space=Nowhere');
  assert.equal(status, 404, JSON.stringify(body));
  assert.match(body.error, /no space called Nowhere/);
});

await acheck('a configured space answers with its own repos', async () => {
  forget();
  const { status, body } = await ask('?space=Work');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.workspaces, ['demo']);
  assert.equal(body.total, 6);
});

await acheck('`Other` is the repos in no space, and resolves rather than 404ing', async () => {
  forget();
  const { status, body } = await ask('?space=Other');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.workspaces, ['second']);
});

await acheck('no workspace and no space at all is every repo', async () => {
  forget();
  const { status, body } = await ask('');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.workspaces, ['demo', 'second']);
  assert.equal(body.workspace, '');
});

await acheck('a repo with nothing in it is an empty list and a 200', async () => {
  forget();
  const { status, body } = await ask('?workspace=second');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.rows, []);
  assert.equal(body.total, 0);
  assert.equal(body.more, false);
  assert.deepEqual(body.errors, []);
});

await acheck('and it needs the token like everything else under /api', async () => {
  const { status } = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/history?workspace=demo', method: 'GET', agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 401);
});

for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures
    ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m\n`
    : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`
);
process.exit(failures ? 1 : 0);
