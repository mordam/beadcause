#!/usr/bin/env node
/**
 * The endorsement queue — what is waiting, in what order, and where each one came from.
 *
 *     npm test
 *     node test/endorsequeue.mjs
 *
 * test/filing.mjs proves a filed bead arrives held; test/endorse.mjs proves nothing may
 * work one; test/verdicts.mjs proves the four ways out. This is the list in between —
 * the screen that turns `3 held for endorsement` from a number on the advocate console
 * into three beads you can read and answer. Being wrong here is quiet in a way the
 * verdicts are not: a verdict that misfires tells you, and a queue that silently omits
 * a workspace tells you there is nothing to endorse in it.
 *
 * What is asserted, and why each is here rather than assumed:
 *
 * 1. **Provenance comes off the edge, not off the prose.** `bd list --json` carries
 *    every text field but not `dependencies[]`, so "found while working bc-x" is a
 *    second `bd show` per row — and the edge beats the parent when a bead has both,
 *    because "which work turned this up" and "which epic it lives under" are different
 *    questions and only the first explains why the bead exists.
 * 2. **The two renamings.** A row says `issue_type` and `acceptance_criteria`; a card
 *    says `type` and `acceptance`. Reading `.type` off a raw row is `undefined`, which
 *    is not a crash — it is a card with a blank where the kind of work should be.
 * 3. **Newest first, across every workspace at once.** The queue is one list, not one
 *    per repo: six discoveries overnight in three repos is one morning's reading.
 * 4. **A workspace that cannot be read is named, not dropped.** The whole failure this
 *    screen could have is showing an empty queue over a `bd` that fell over.
 * 5. **The cap is reported.** Sixty-one held beads draws sixty and says so. A silent
 *    truncation is the one bug that makes an emptying queue a lie.
 * 6. **A verdict drops the cache.** The sweep is cached for a few seconds; the phone
 *    that just endorsed something asks again immediately, and so does the laptop on its
 *    own poll — which is the one that would otherwise redraw a bead that is gone.
 *
 * No real tracker: `bd` is a stub binary over a JSON file. The route is exercised over
 * a real socket against `createApp`, because the cache interaction between the queue
 * and the verdict routes only exists inside a running app.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-endorsequeue-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const { FILED_LABEL, DISCOVERED_FROM } = await import(LIB('filing.js'));
const { endorsementQueue, forget, sourceOf, toRow, newestFirst, latestOf, QUEUE_MAX, COMMENT_PREVIEW } =
  await import(LIB('endorsequeue.js'));

const cache = await import(LIB('cache.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, keyed by workspace directory.
 *
 * Keyed by directory rather than by a single flat map because half of what is asserted
 * here is that several workspaces are swept and merged — a stub with one world could
 * not tell a queue that read them all from one that read the first twice. `BEADS_DIR`
 * is how `Bd.run` says which workspace it means, so the stub resolves the same way bd
 * itself does.
 *
 * `list` implements only the two flags `Bd.listLabel` sends, and refuses anything else,
 * so a future call site that reaches for a flag this stub silently ignored fails here
 * rather than passing against a fiction.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const one = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const dir = process.env.BEADS_DIR || '';
const world = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const w = world[dir];
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
if (!w) die('no beads database found in ' + dir);
if (w.broken) die('Error: dolt: could not open database');
const all = () => Object.values(w.issues || {});

if (args[0] === 'show') {
  const issue = (w.issues || {})[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found matching');
  // bd 1.2.1's flag, which is the whole reason the provenance pass costs no more than it
  // did. Without it here the stub would answer a \`showWithComments\` with no thread and
  // the suite would pass over a field that never arrives.
  const withComments = args.includes('--include-comments');
  const out = withComments ? { ...issue, comments: (w.comments || {})[args[1]] || [] } : issue;
  process.stdout.write(JSON.stringify([out]));
  process.exit(0);
}
if (args[0] === 'human' && args[1] === 'list') {
  if (w.humanBroken) die('Error: dolt: could not read');
  process.stdout.write(JSON.stringify(Object.values(w.questions || {})));
  process.exit(0);
}
if (args[0] === 'list') {
  const label = one('--label');
  const status = (args.find((a) => a.startsWith('--status=')) || '').slice('--status='.length);
  const want = status ? status.split(',') : null;
  const rows = all()
    .filter((i) => !label || (i.labels || []).includes(label))
    .filter((i) => !want || want.includes(i.status || 'open'));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'remove') {
  const issue = (w.issues || {})[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.labels = (issue.labels || []).filter((l) => l !== args[3]);
  fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(world, null, 2));
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

/** One held bead as `bd list --json` hands it back — bd's field names, not a card's. */
const held = (id, at, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: 'what the agent thought the work was',
  acceptance_criteria: 'how we would know it is done',
  notes: `_Filed by an agent while working xx-src, at the moment it found the work._`,
  status: 'open',
  issue_type: 'bug',
  priority: 2,
  labels: [UNENDORSED, FILED_LABEL],
  created_at: at,
  updated_at: at,
  ...extra,
});

/** The `dependencies[]` a `bd show` carries, in bd's own shape. */
const edge = (id, type, title = `the ${type} bead`) => ({ id, title, status: 'open', dependency_type: type });

/** One `bd comments` row, in bd's own shape — oldest first is the order it hands them over. */
const comment = (author, text, at) => ({ id: `${author}-${at}`, author, text, created_at: at });

/** One open `human` bead, as `bd human list` hands it back. */
const question = (id, extra = {}) => ({
  id,
  title: `Should we do something about it?`,
  description: '',
  notes: '',
  design: '',
  acceptance_criteria: '',
  status: 'open',
  issue_type: 'decision',
  priority: 1,
  labels: ['human'],
  created_at: '2026-08-10T09:00:00Z',
  ...extra,
});

function world(extra = {}) {
  return {
    [ALPHA.dir]: {
      issues: {
        'aa-old': held('aa-old', '2026-08-01T10:00:00Z', {
          dependencies: [edge('aa-src', DISCOVERED_FROM), edge('aa-epic', 'parent-child')],
        }),
        'aa-new': held('aa-new', '2026-08-09T10:00:00Z', { dependencies: [edge('aa-epic', 'parent-child')] }),
        // Endorsed already: no marker, so `bd list --label unendorsed` never sees it.
        'aa-live': held('aa-live', '2026-08-10T10:00:00Z', { labels: ['api'] }),
        // Revoked: keeps the marker on purpose (lib/verdict.js) and must stay out of
        // the queue anyway — the history is not the list of what is waiting.
        'aa-gone': held('aa-gone', '2026-08-10T11:00:00Z', { status: 'closed' }),
      },
      /**
       * The two things a *later* reader wrote, which is the whole of bc-xl7n.76.2.
       *
       * Every field of `held()` above is what the filing agent typed at the moment it
       * found the work. These are what somebody concluded afterwards — an advocate's
       * comment saying the work is already done, and open `human` beads naming beads by
       * id. That is the pair bc-wi3s carried on the morning a bulk endorse of 56 took it
       * anyway, and the row said nothing about either.
       */
      comments: {
        'aa-old': [
          comment('beadcause', 'Opened a window on it.', '2026-08-11T08:00:00Z'),
          comment(
            'bc-xl7n',
            'I ran the suite on main and it is green — this is finished work.',
            '2026-08-12T08:00:00Z'
          ),
        ],
      },
      questions: {
        // Names a queued bead in its description, the way an advocate's own ask does.
        'aa-ask': question('aa-ask', {
          title: 'Close aa-old rather than endorsing it?',
          description: 'aa-old is already finished work — the suite it names is green on main.',
          priority: 1,
        }),
        // Names a *child* of a queued bead. The parent must not inherit it — see
        // `namesIn`, and lib/beadref.js for the two ways this truncation has bitten.
        'aa-child': question('aa-child', { description: 'What about aa-new.3, is that separable?', priority: 0 }),
        // Names a bead that lives in another workspace. Questions are read per workspace
        // and joined per workspace: a `bb-mid` written in alpha's tracker is not that bead.
        'aa-cross': question('aa-cross', { description: 'And bb-mid?', priority: 2 }),
      },
    },
    [BETA.dir]: {
      issues: { 'bb-mid': held('bb-mid', '2026-08-05T10:00:00Z', { dependencies: [] }) },
    },
    [BROKEN.dir]: { broken: true },
    ...extra,
  };
}

const writeWorld = (w) => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
writeWorld(world());

const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

/* --------------------------------------------------------------------- harness */

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
    console.log(`      ${String(err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

console.log('\nthe endorsement queue\n');

/* ------------------------------------------------------------------- the row */

await check('a bd row becomes a card, with the two fields bd names differently', () => {
  const row = toRow('alpha', held('aa-x', '2026-08-01T10:00:00Z'));
  assert.equal(row.type, 'bug', 'issue_type is what a row calls it; a card reading .type would be blank');
  assert.equal(row.acceptance, 'how we would know it is done', 'acceptance_criteria, likewise');
  assert.equal(row.key, 'alpha/aa-x', 'keyed by workspace and id, the way every client keys a bead');
  assert.equal(row.held, true);
  assert.equal(row.filed, true);
  assert.equal(row.from, null, 'provenance is a second call and has not been made yet — null, not "nowhere"');
});

await check('a bead labelled by hand is on the queue but is not agent-filed', () => {
  const row = toRow('alpha', held('aa-y', '2026-08-01T10:00:00Z', { labels: [UNENDORSED] }));
  assert.equal(row.held, true, 'the marker is the whole of what puts it here');
  assert.equal(row.filed, false, 'and the missing provenance label is the tell that no agent filed it');
});

/* ------------------------------------------------------------------ provenance */

await check('the discovered-from edge beats the parent, because it is the one that explains the bead', () => {
  const from = sourceOf({ dependencies: [edge('aa-epic', 'parent-child'), edge('aa-src', DISCOVERED_FROM)] });
  assert.equal(from.id, 'aa-src');
  assert.equal(from.kind, 'discovered');
});

await check('and the parent answers when there is no edge at all', () => {
  const from = sourceOf({ dependencies: [edge('aa-epic', 'parent-child')] });
  assert.equal(from.id, 'aa-epic');
  assert.equal(from.kind, 'parent', 'drawn differently: "filed under" is not "found while working"');
  assert.equal(sourceOf({ parent: 'aa-epic' }).id, 'aa-epic', 'bd also puts it on its own field');
});

await check('a bead that came from nowhere says nothing rather than guessing', () => {
  assert.equal(sourceOf({ dependencies: [] }), null);
  assert.equal(sourceOf({}), null);
  assert.equal(sourceOf(null), null);
  assert.equal(
    sourceOf({ dependencies: [edge('aa-block', 'blocks')] }),
    null,
    'a blocker is not a provenance — it is what this bead is waiting on'
  );
});

/* -------------------------------------------------------------------- the sweep */

await check('every workspace at once, newest first, with the provenance filled in', async () => {
  forget();
  const out = await endorsementQueue(bd, [ALPHA, BETA, BROKEN]);
  assert.deepEqual(
    out.beads.map((b) => b.id),
    ['aa-new', 'bb-mid', 'aa-old'],
    'one list across repos, newest first — not one list per repo'
  );
  assert.equal(out.beads.find((b) => b.id === 'aa-old').from.id, 'aa-src', 'the edge, read by a second bd show');
  assert.equal(out.beads.find((b) => b.id === 'aa-new').from.id, 'aa-epic', 'and the parent where there is no edge');
  assert.equal(out.beads.find((b) => b.id === 'bb-mid').from, null);
});

await check('an endorsed bead and a revoked one are both off it', async () => {
  forget();
  const out = await endorsementQueue(bd, [ALPHA, BETA]);
  const ids = out.beads.map((b) => b.id);
  assert.ok(!ids.includes('aa-live'), 'the marker is gone, so it is ordinary work');
  assert.ok(
    !ids.includes('aa-gone'),
    'a revoked bead keeps the marker on purpose, but the history is not the queue'
  );
});

await check('a workspace whose bd fell over is named, and the others still come back', async () => {
  forget();
  const out = await endorsementQueue(bd, [ALPHA, BETA, BROKEN]);
  assert.equal(out.errors.length, 1, JSON.stringify(out.errors));
  assert.equal(out.errors[0].workspace, 'broken');
  assert.ok(out.beads.length >= 3, 'an empty queue over a broken repo is the one lie this screen could tell');
});

await check('the counts say how many, and where', async () => {
  forget();
  const out = await endorsementQueue(bd, [ALPHA, BETA, BROKEN]);
  assert.equal(out.counts.total, 3);
  assert.deepEqual(out.counts.byWorkspace, { alpha: 2, beta: 1 });
  assert.equal(out.truncated, 0);
});

await check('two beads filed in the same second still have an order', () => {
  const rows = [
    { id: 'zz-b', createdAt: '2026-08-01T10:00:00Z' },
    { id: 'zz-a', createdAt: '2026-08-01T10:00:00Z' },
  ].sort(newestFirst);
  assert.deepEqual(rows.map((r) => r.id), ['zz-a', 'zz-b'], 'a wobbling list is a list you cannot tick');
});

await check('over the cap, the queue draws what it can and says what it did not', async () => {
  const many = {};
  for (let i = 0; i < QUEUE_MAX + 1; i += 1) {
    const id = `cc-${String(i).padStart(3, '0')}`;
    // Ascending timestamps, so the newest is the last one written and the cap has to
    // drop from the *old* end rather than from wherever the sweep happened to stop.
    many[id] = held(id, `2026-08-01T10:${String(i).padStart(2, '0')}:00Z`, { dependencies: [] });
  }
  writeWorld({ ...world(), [BETA.dir]: { issues: many } });
  forget();
  const out = await endorsementQueue(bd, [BETA]);
  assert.equal(out.beads.length, QUEUE_MAX);
  assert.equal(out.counts.total, QUEUE_MAX + 1);
  assert.equal(out.truncated, 1, 'a silent truncation would read as "you have answered them all"');
  assert.equal(out.beads[0].id, `cc-${String(QUEUE_MAX).padStart(3, '0')}`, 'the newest survives the cap');
  writeWorld(world());
});

/* ------------------------------------------- what was learned after it was filed */

await check('the newest comment rides on the row, bounded, and its absence is null', () => {
  assert.equal(latestOf([]), null, 'a bead nobody has written on says nothing, rather than an empty quotation');
  assert.equal(latestOf(null), null);
  const one = latestOf([comment('a', 'first', '2026-08-01T00:00:00Z'), comment('b', 'last', '2026-08-02T00:00:00Z')]);
  assert.equal(one.text, 'last', '`bd comments` is oldest first, so the newest is the last of them');
  assert.equal(one.author, 'b');
  assert.equal(one.truncated, false);
  const long = latestOf([comment('a', 'x'.repeat(COMMENT_PREVIEW + 50), '2026-08-01T00:00:00Z')]);
  assert.equal(long.text.length, COMMENT_PREVIEW, 'sixty full evidence dumps is the megabyte this screen refuses');
  assert.equal(long.truncated, true, 'and it has to say it was cut, or the row quotes half a sentence as the whole');
});

await check('a bead with a thread carries what was last said on it — from the same spawn', async () => {
  cache.clear();
  const out = await endorsementQueue(bd, [ALPHA, BETA]);
  const old = out.beads.find((b) => b.id === 'aa-old');
  assert.equal(
    old.latestComment.text,
    'I ran the suite on main and it is green — this is finished work.',
    'the advocate said this is finished work; a row that showed only a 💬 2 is what let bc-wi3s through'
  );
  assert.equal(old.latestComment.author, 'bc-xl7n');
  assert.equal(old.from.id, 'aa-src', 'and the provenance edge still comes off that same one call');
  assert.equal(
    out.beads.find((b) => b.id === 'bb-mid').latestComment,
    null,
    'a bead nobody has said anything about draws nothing, not an empty quotation'
  );
});

await check('an open human bead that names a queued bead is on its row', async () => {
  cache.clear();
  const out = await endorsementQueue(bd, [ALPHA, BETA]);
  const old = out.beads.find((b) => b.id === 'aa-old');
  assert.deepEqual(
    old.questions.map((q) => q.id),
    ['aa-ask'],
    'somebody has an open question about this bead, and the row is the only place a bulk press can see it'
  );
  assert.equal(old.questions[0].title, 'Close aa-old rather than endorsing it?');
  assert.equal(old.questions[0].priority, 1, 'how urgent whoever asked thought it was');
  assert.equal(old.questions[0].key, 'alpha/aa-ask', 'keyed the way every client in this app keys a bead');
});

await check('a question about a child is not a question about its parent', async () => {
  cache.clear();
  const out = await endorsementQueue(bd, [ALPHA, BETA]);
  assert.deepEqual(
    out.beads.find((b) => b.id === 'aa-new').questions,
    [],
    '`aa-new.3` truncating to `aa-new` is bc-68ou twice over — a question about one child would flag the epic'
  );
});

await check('and a question in one workspace never reaches an id in another', async () => {
  cache.clear();
  const out = await endorsementQueue(bd, [ALPHA, BETA]);
  assert.deepEqual(
    out.beads.find((b) => b.id === 'bb-mid').questions,
    [],
    'alpha asking about `bb-mid` is alpha asking about a bead of its own that happens to share a name'
  );
});

await check('asked-and-nobody-has is [] and could-not-ask is null — and they are different sentences', async () => {
  cache.clear();
  const asked = await endorsementQueue(bd, [ALPHA, BETA]);
  assert.deepEqual(asked.beads.find((b) => b.id === 'bb-mid').questions, [], 'beta was read, and nothing names it');

  writeWorld({ ...world(), [BETA.dir]: { ...world()[BETA.dir], humanBroken: true } });
  cache.clear();
  const blind = await endorsementQueue(bd, [ALPHA, BETA]);
  assert.equal(
    blind.beads.find((b) => b.id === 'bb-mid').questions,
    null,
    '`[]` here would be the screen saying "nobody has asked" on the strength of a bd call that never came back'
  );
  assert.ok(
    blind.beads.find((b) => b.id === 'aa-old').questions.length,
    'and the workspace that did answer is unaffected — one broken repo must not blank the others'
  );
  writeWorld(world());
});

await check('the question list is shared with the inbox rather than swept twice', async () => {
  cache.clear();
  await endorsementQueue(bd, [ALPHA, BETA]);
  assert.ok(
    cache.peek('questions:alpha'),
    'the key is `questions:<workspace>` — the one `allQuestions()` in lib/server.js already keeps warm, ' +
      'so a running daemon spends no extra spawn on this at all'
  );
});

/* --------------------------------------------------------------------- the cache */

await check('a second sweep inside the window is served from memory, and refresh is not', async () => {
  forget();
  const first = await endorsementQueue(bd, [ALPHA, BETA]);
  writeWorld({ ...world(), [BETA.dir]: { issues: {} } });
  const again = await endorsementQueue(bd, [ALPHA, BETA]);
  assert.equal(again.at, first.at, 'the same answer, not a second sweep of every workspace');
  const fresh = await endorsementQueue(bd, [ALPHA, BETA], { refresh: true });
  assert.ok(!fresh.beads.some((b) => b.workspace === 'beta'), 'refresh really goes and looks');
  writeWorld(world());
  forget();
});

/* -------------------------------------------- a queue sweep that ran out of ceiling */

/* bc-774a2. `sweep` cannot throw for a tracker — it catches per workspace — but the wait on
   a *cold* key can still hit lib/cache.js's ceiling, and this is the most expensive sweep in
   the app bar one: a `bd list --label` per workspace plus up to forty `bd show`s. 37 child
   processes and 232 seconds of `bd` work behind this key is how it happened on 2026-08-24.
   That throw reached the route's catch-all as HTTP 500, which public/report.js reads as *the
   daemon is failing* and files a P0 incident bead about. `errors[]` is the shape /endorse
   already draws for a workspace that could not be read.

   Seeded through the cache's own key rather than by slowing the sweep down: what is under
   test is which of two failures `endorsementQueue` is looking at, and the real ceiling is
   150s. */

console.log('\nwhen the queue sweep does not come back in time\n');

{
  forget();
  let release;
  const held = cache.read('queue:alpha,beta', () => new Promise((resolve) => (release = resolve)), {
    freshMs: 10_000,
    ceilingMs: 5_000,
  });
  held.catch(() => {});

  const was = console.error;
  console.error = () => {};
  let out;
  try {
    out = await endorsementQueue(bd, [ALPHA, BETA], { ceilingMs: 30 });
  } finally {
    console.error = was;
  }

  await check('a cold queue sweep past its ceiling answers rather than throwing', () => {
    assert.deepEqual(out.beads, []);
    assert.match(out.errors[0]?.error || '', /did not answer within/);
  });
  await check('  — with every workspace in errors[], because none of them was reached', () =>
    assert.deepEqual(
      out.errors.map((e) => e.workspace),
      ['alpha', 'beta']
    )
  );
  await check('  — and the counts say nothing is waiting rather than being absent', () =>
    assert.deepEqual(out.counts, { total: 0, shown: 0, byWorkspace: {} })
  );
  await check('  — and no kept age, because nothing was kept to be old', () => assert.equal(out.kept, null));

  release({ beads: [], errors: [], counts: { total: 0, shown: 0, byWorkspace: {} } });
  await held.catch(() => {});
  forget();
}

/* bc-19vt.1's split, on this caller. The block above shrinks `ceilingMs` alone, shrinking
   the slot and this call's own wait together. `/api/unendorsed` shrinks neither — it passes
   `waitMs` on its own and leaves `ceilingMs` at the real default, so the sweep the slot is
   holding still gets the full 150 seconds while this one caller gives up in a few. */
{
  forget();
  let release;
  const held = cache.read('queue:alpha,beta', () => new Promise((resolve) => (release = resolve)), {
    freshMs: 10_000,
    ceilingMs: 5_000,
  });
  held.catch(() => {});

  const was = console.error;
  console.error = () => {};
  let out;
  try {
    out = await endorsementQueue(bd, [ALPHA, BETA], { waitMs: 30 });
  } finally {
    console.error = was;
  }

  await check("a short `waitMs` alone gives up in seconds, with `ceilingMs` left at the real default", () => {
    assert.deepEqual(out.beads, []);
    assert.match(out.errors[0]?.error || '', /did not answer within/);
  });

  release({ beads: [], errors: [], counts: { total: 0, shown: 0, byWorkspace: {} } });
  await held.catch(() => {});
  forget();
}

/* And the other half of the flag: only the *ceiling* converts. Anything else is a real
   failure and keeps its 500 — which is why lib/cache.js flags the ceiling error rather than
   leaving callers to match on its message.

   The clock stands in for that "anything else", and deliberately: `sweep` catches every
   tracker failure it can have — per workspace for `bd list`, inside `pool` for the
   provenance `bd show`s, inside lib/openquestion.js for the questions — so there is no
   broken `bd` that reaches this branch, and the branch is a guard against the failures
   nobody enumerated rather than against a tracker. A `now` that throws is one of those,
   and it proves the discriminator is `cache.timedOut` and not a bare catch. */
await check('anything that is not the ceiling comes back out, and still gets its 500', async () => {
  forget();
  await assert.rejects(
    endorsementQueue(bd, [ALPHA, BETA], {
      now: () => {
        throw new Error('the clock is gone');
      },
    }),
    /the clock is gone/
  );
  forget();
});

/* ---------------------------------------------------------------------- the route */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  host: '127.0.0.1',
  // Bound by the kernel and read back off the listener — see test/helpers/net.mjs.
  // A number picked up front loses a race the moment two `npm test` runs overlap,
  // and `listen()` answers that with `process.exit(1)`, which reads exactly like a
  // regression in whatever was under test.
  port: 0,
  baseUrl: 'http://127.0.0.1',
  token: 'endorsequeue-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [ALPHA, BETA],
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
// Resolves once the socket is up, so there is no boot loop to race against either.
const port = await boundPort(servers);

const call = (method, pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'x-beadcause-token': cfg.token,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

await check('GET /api/unendorsed is the queue, whole, with no workspace to name', async () => {
  forget();
  const res = await call('GET', '/api/unendorsed?refresh=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.beads.map((b) => b.id), ['aa-new', 'bb-mid', 'aa-old']);
  assert.equal(res.json.counts.total, 3);
  const one = res.json.beads[0];
  assert.ok(one.description && one.acceptance, 'the rows are fat on purpose — reading the bead is the decision');
  assert.ok(one.notes.includes('Filed by an agent'), 'including the agent’s own argument for it');
});

await check('endorsing drops the cache, so the next look is the truth and not the last sweep', async () => {
  await call('GET', '/api/unendorsed?refresh=1');
  const done = await call('POST', '/api/bead/endorse', { workspace: 'alpha', id: 'aa-new' });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual(done.json.applied, ['aa-new']);
  // No `?refresh=1`: the point is that a client which does *not* ask for a fresh sweep
  // — the laptop on its own poll — still sees the bead go.
  const after = await call('GET', '/api/unendorsed');
  assert.ok(
    !after.json.beads.some((b) => b.id === 'aa-new'),
    `an endorsed bead is not waiting on anybody: ${after.json.beads.map((b) => b.id).join(', ')}`
  );
});

for (const s of servers || []) s.close?.();
app.stop?.();

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
