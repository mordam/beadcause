#!/usr/bin/env node
/**
 * A reported error becomes one bead, and the second occurrence becomes one comment.
 *
 *     npm test
 *     node test/apperrors.mjs
 *
 * The feature (bc-p38c.1) is easy to get right in the direction that shows: an error is
 * posted and a P0 bead appears. Every way it goes wrong is on the *other* side — a bead
 * per occurrence, from a page that reports on every render. So this file spends most of
 * its assertions on the three dedupe outcomes and on the one race that produces them:
 *
 * 1. **The same error twice** → one bead, one comment. The acceptance criterion.
 * 2. **The same error from a line that has moved** → still the same bead, matched on the
 *    message, and the bead *learns* the new `file:line` so the next one matches directly.
 * 3. **The same error whose only match is closed** → a new bead with a `discovered-from`
 *    edge to the closed one. Not a reopen: a regression that quietly reopens the old
 *    bead loses the fact that it was ever fixed.
 * 4. **Three at once** → still one bead. `window.onerror` fires, the render runs again,
 *    and three requests are in flight before the first `bd create` returns. bd's own
 *    lock retry does not help here, because those three creates do not conflict.
 * 5. **Fifty in a row** → one bead and *two* comments, the second of which says there
 *    were forty-eight more (bc-5f9b). One bead was only half of it: a comment per report
 *    is a bd write per report on a tracker only one process can write at a time, and a
 *    bead nobody can read. So the assertions are on both halves — the comments bounded,
 *    the count inside them not.
 *
 * The `bd` is a stub binary over a JSON file, in the shape test/endorse.mjs established:
 * it implements `--label-any`, `--all` and the status filter the way bd implements them,
 * because the lookup under test *is* those flags — a stub that returned everything
 * whatever it was asked would pass whatever the code did. It logs its argv, so the flags
 * are asserted as they are actually passed rather than as they are meant to be.
 *
 * Nothing here reaches a real tracker, iTerm, or the network beyond loopback.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-apperr-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const { FILED_LABEL, DISCOVERED_FROM } = await import(LIB('filing.js'));
// bc-rfnr.4's other half: the crash P0 that must not get a planning agent.
const { wantsAdvocate } = await import(LIB('epicadvocate.js'));
const {
  intake,
  flushErrorWindows,
  isNewBead,
  WINDOW_MS,
  WINDOW_MAX_MS,
  fingerprint,
  normalizeSource,
  normalizeMessage,
  frameFromStack,
  pickMatch,
  titleFor,
  labelsFor,
  ERROR_LABEL,
  ERROR_PRIORITY,
  AT_PREFIX,
  MSG_PREFIX,
} = await import(LIB('errors.js'));

/* ------------------------------------------------------------------- the stub bd */

const BEADS = path.join(tmp, 'beads');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker as a directory — **one file per bead**, and that is not a style choice.
 *
 * The first version of this stub kept the whole world in one JSON file and allocated
 * ids from a counter inside it. Under `Promise.all` that is a read-modify-write race
 * between two `bd` *processes*: both read, both increment, the second write wins, and
 * two distinct errors come back holding the same id with one bead on disk. It reads
 * exactly like the serialisation bug the test was written to disprove, which is the
 * worst way for a fixture to be wrong. One file per bead has no shared write at all,
 * and the id is claimed with `wx` — the first process to create `zz-3.json` owns 3.
 *
 * `list` honours `--label-any` (OR), `--label` (AND) and `--all` the way bd does,
 * because the lookup under test *is* those flags: a stub that returned everything
 * whatever it was asked would pass whatever the code did.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const DIR = ${JSON.stringify(BEADS)};
const file = (id) => path.join(DIR, id + '.json');
const read = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
const write = (i) => fs.writeFileSync(file(i.id), JSON.stringify(i, null, 2));
const all = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => read(path.basename(f, '.json'))).filter(Boolean);
const one = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (args[0] === 'list') {
  const any = many('--label-any');
  const need = many('--label');
  let rows = all();
  if (!args.includes('--all')) rows = rows.filter((i) => i.status !== 'closed');
  if (need.length) rows = rows.filter((i) => need.every((l) => (i.labels || []).includes(l)));
  if (any.length) rows = rows.filter((i) => any.some((l) => (i.labels || []).includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'create') {
  if (fs.existsSync(path.join(DIR, '..', 'fail-create'))) die('the tracker said no');
  // Claim an id atomically: whoever wins the exclusive create owns the number.
  let id = null;
  for (let n = 1; n < 500 && !id; n++) {
    try { fs.writeFileSync(file('zz-' + n), '{}', { flag: 'wx' }); id = 'zz-' + n; } catch { /* taken */ }
  }
  if (!id) die('out of ids');
  write({
    id,
    title: one('--title') || '',
    description: one('--description') || '',
    acceptance: one('--acceptance') || '',
    notes: one('--notes') || '',
    issue_type: one('--type') || 'task',
    priority: Number(one('--priority') ?? 2),
    status: 'open',
    labels: many('--label'),
    deps: many('--deps'),
    comment_count: 0,
    comments: [],
    created_by: one('--actor') || '',
  });
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = read(args[1]) || die('no issue ' + args[1]);
  issue.comments.push(args[2]);
  issue.comment_count = issue.comments.length;
  write(issue);
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'add') {
  const issue = read(args[2]) || die('no issue ' + args[2]);
  if (!issue.labels.includes(args[3])) issue.labels.push(args[3]);
  write(issue);
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = read(args[1]) || die('no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const clearCalls = () => fs.rmSync(BD_LOG, { force: true });
const issues = () =>
  fs
    .readdirSync(BEADS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(BEADS, f), 'utf8')))
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
const bead = (id) => JSON.parse(fs.readFileSync(path.join(BEADS, `${id}.json`), 'utf8'));
const setBead = (i) => fs.writeFileSync(path.join(BEADS, `${i.id}.json`), JSON.stringify(i, null, 2));
const FAIL_FLAG = path.join(tmp, 'fail-create');
const reset = async ({ failCreate = false } = {}) => {
  // A coalescing window is module state and outlives the check that opened it. Closed
  // here, while the bead it belongs to still exists: a window left open would make the
  // next check's first repeat vanish into a count, and the summary comment it writes
  // would go to a bead id that has been deleted underneath it.
  await flushErrorWindows();
  fs.rmSync(BEADS, { recursive: true, force: true });
  fs.mkdirSync(BEADS, { recursive: true });
  fs.rmSync(FAIL_FLAG, { force: true });
  if (failCreate) fs.writeFileSync(FAIL_FLAG, '1');
  clearCalls();
};
await reset();

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const ws = { name: 'demo', dir: wsDir };
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
/**
 * The same tracker, on a Mac that knows whose it is — for bc-rfnr.4 alone.
 *
 * `me` is what `Bd.create` stamps an owner off, and it is unset on `bd` above on
 * purpose: every other assertion in this file is about a bead filed by an install that
 * has never heard of ownership, which is what every existing install is.
 */
const ownedBd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test', me: 'adam@example.com' });

/** One realistic browser report, as `window.onerror` would hand it over. */
const REPORT = {
  message: "Cannot read properties of undefined (reading 'title')",
  source: 'https://mac.tail1234.ts.net:4318/app.js?v=27',
  line: 3315,
  column: 18,
  url: 'https://mac.tail1234.ts.net:4318/#bc-p38c',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)',
  at: '2026-08-11T12:00:00.000Z',
  kind: 'error',
};

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 10).join('\n       ')}`);
  }
}

console.log('\na reported error is one bead, however many times it happens\n');

/* -------------------------------------------------------------- the fingerprint */

await check('the same file spelled four ways is one file', () => {
  const want = 'public/app.js';
  assert.equal(normalizeSource('https://mac.tail1234.ts.net:4318/public/app.js?v=27'), want, 'phone, cache-busted');
  assert.equal(normalizeSource('http://127.0.0.1:4317/public/app.js'), want, 'a desktop tab on the bare daemon');
  assert.equal(normalizeSource('file:///Users/adammorgan/checkout/public/app.js'), want, 'the daemon itself');
  assert.equal(normalizeSource('/public/app.js#frag'), want, 'and a bare path with a fragment');
  assert.equal(
    normalizeSource('/Users/adammorgan/neadamthal.projects/beadcause/.claude/worktrees/x-1/lib/server.js'),
    'lib/server.js',
    'a worktree is not a different bug from the main checkout'
  );
  assert.equal(normalizeSource(''), '');
  assert.equal(normalizeSource(null), '');
});

await check('the message is normalised over what differs between two occurrences', () => {
  assert.equal(
    normalizeMessage('fetch https://host:4318/api/bead?id=bc-4f2 failed'),
    normalizeMessage('fetch https://host:4318/api/bead?id=bc-9aa failed'),
    'one broken fetch, two beads asked for'
  );
  assert.equal(normalizeMessage('deploy 20260811T120000 failed'), normalizeMessage('deploy 20260811T130000 failed'));
  assert.notEqual(normalizeMessage('exit 1'), normalizeMessage('exit 2'), 'small numbers are kept — they mean things');
  assert.equal(normalizeMessage('  Failed   to fetch\n'), 'failed to fetch', 'and whitespace is not a difference');
});

await check('a stack is read in both dialects, and the first real frame wins', () => {
  const v8 = frameFromStack(
    'TypeError: x is not a function\n    at render (https://host/app.js:120:9)\n    at tick (https://host/app.js:9:1)'
  );
  assert.deepEqual(v8, { source: 'https://host/app.js', line: 120, column: 9 });
  const bare = frameFromStack('Error: nope\n    at /Users/a/lib/server.js:44:7');
  assert.deepEqual(bare, { source: '/Users/a/lib/server.js', line: 44, column: 7 });
  const safari = frameFromStack('render@https://host/app.js:120:9\nglobal code@https://host/app.js:1:1');
  assert.deepEqual(safari, { source: 'https://host/app.js', line: 120, column: 9 }, 'the phone runs Safari');
  assert.equal(frameFromStack('Script error.'), null);
  assert.equal(frameFromStack(''), null);
});

await check('a report with no source at all still has a fingerprint', () => {
  // `window.onerror` for a cross-origin script is handed "Script error." and nothing
  // else. That report is worth less than a full one and much more than a red toast.
  const fp = fingerprint({ message: 'Script error.' });
  assert.equal(fp.at, '');
  assert.equal(fp.atLabel, '', 'nothing to key on by source');
  assert.ok(fp.msgLabel.startsWith(MSG_PREFIX), 'and the message is the only key there is');
  assert.deepEqual(labelsFor(fp), [ERROR_LABEL, fp.msgLabel], 'so no empty label reaches bd');
});

await check('the fingerprint is stable across the noise and moves with the line', () => {
  const a = fingerprint(REPORT);
  assert.equal(a.at, 'app.js:3315', 'the daemon serves public/ at the root, so the URL really is /app.js');
  assert.ok(a.atLabel.startsWith(AT_PREFIX) && a.msgLabel.startsWith(MSG_PREFIX));
  const later = fingerprint({ ...REPORT, source: 'http://127.0.0.1:4317/app.js?v=31', at: 'whenever' });
  assert.deepEqual({ at: later.at, m: later.msgLabel }, { at: a.at, m: a.msgLabel }, 'same bug, same everything');
  const moved = fingerprint({ ...REPORT, line: 3402 });
  assert.notEqual(moved.atLabel, a.atLabel, 'the line moved, so the primary key moved');
  assert.equal(moved.msgLabel, a.msgLabel, 'and the backup did not — which is the whole point of it');
});

await check('the title leads with the symptom and is cut to fit a card', () => {
  const fp = fingerprint(REPORT);
  const title = titleFor(REPORT, fp);
  assert.ok(title.startsWith('Cannot read properties'), `the message leads: ${title}`);
  assert.ok(title.endsWith('app.js:3315'), `and the place is on the end: ${title}`);
  const long = titleFor({ message: 'x'.repeat(400) }, fp);
  assert.ok(long.length <= 120, `cut, got ${long.length}`);
  assert.ok(long.includes('…'), 'and it says it was cut');
  assert.equal(titleFor({}, { at: '' }), 'an error with no message');
});

/* ---------------------------------------------------------------- the four outcomes */

await check('the first report files a P0 bug, endorsed, labelled as a class', async () => {
  await reset();
  const out = await intake(bd, ws, REPORT);
  assert.equal(out.action, 'created');
  const rows = issues();
  assert.equal(rows.length, 1, 'one bead');
  const bead = rows[0];
  assert.equal(bead.priority, ERROR_PRIORITY, 'P0 — the advocate sorts highest-priority-first with no change');
  assert.equal(bead.issue_type, 'bug');
  assert.ok(bead.labels.includes(ERROR_LABEL), '`bd list --label app-error` is every one of these');
  assert.ok(bead.labels.includes(FILED_LABEL), 'and the provenance stamp survives, as for anything agent-filed');
  assert.ok(
    !bead.labels.includes(UNENDORSED),
    'but NOT held: a P0 crash behind a tap defeats the point — ' + JSON.stringify(bead.labels)
  );
  assert.ok(bead.description.includes('app.js:3315'), 'the readable fingerprint is on the bead');
  assert.ok(bead.description.includes(REPORT.userAgent), 'along with everything the report carried');
  assert.doesNotMatch(bead.notes, /auto-endorsement is on for this repo/, 'and it does not blame a policy setting');
  assert.match(bead.notes, /it is a program that failed/, 'it says why it arrived endorsed in its own words');
});

await check('A CRASH P0 CARRIES THE SERVICE OWNER — bc-rfnr.4', async () => {
  // Nothing in lib/errors.js does this and nothing should: the stamp is `Bd.create`'s,
  // on every P0 it files, so the crash path gets it by being P0 rather than by knowing
  // about ownership. Asserted here anyway, because bc-rfnr.4's acceptance is about this
  // bead and a change to that condition would be invisible from test/ownership.mjs —
  // where nothing is a crash — and from here, where nothing knew who it was.
  await reset();
  const out = await intake(ownedBd, ws, REPORT);
  assert.equal(out.action, 'created');
  const filed = bead(out.id);
  assert.ok(
    filed.labels.includes('owner:adam@example.com'),
    'the P0 that just broke has somebody answerable for it — ' + JSON.stringify(filed.labels)
  );
  // And the other half of the same bead: it is exempt from the planning agent. A crash
  // P0 that opened an EpicAdvocate would be a window spun up to plan a stack trace.
  assert.equal(wantsAdvocate({ ...filed, status: 'open' }), false, 'a stack trace is not an epic');
});

await check('and an install that does not know who it is files exactly what it always did', async () => {
  // The guarantee the whole ownership feature rests on, asked on the crash path because
  // that is the one path that files a P0 without anybody choosing to.
  await reset();
  const out = await intake(bd, ws, REPORT);
  assert.deepEqual(
    bead(out.id).labels.filter((l) => String(l).startsWith('owner:')),
    [],
    'no owner, no guess'
  );
});

await check('posting the same error twice yields one bead and one comment', async () => {
  await reset();
  const first = await intake(bd, ws, REPORT);
  const second = await intake(bd, ws, { ...REPORT, at: '2026-08-11T12:05:00.000Z' });
  assert.equal(second.action, 'commented');
  assert.equal(second.id, first.id, 'the same bead');
  const rows = issues();
  assert.equal(rows.length, 1, `one bead, got ${rows.length}: ${rows.map((r) => r.title).join(' | ')}`);
  assert.equal(rows[0].comments.length, 1, 'and exactly one comment');
  assert.match(rows[0].comments[0], /Occurrence 2|happened again/);
  assert.match(rows[0].comments[0], /12:05/, 'the comment says when');
  assert.match(rows[0].comments[0], /app\.js:3315/, 'and where');
});

await check('the lookup asks bd for either fingerprint, closed beads included, in one call', async () => {
  await reset();
  await intake(bd, ws, REPORT);
  clearCalls();
  await intake(bd, ws, REPORT);
  const list = bdCalls().filter((c) => c[0] === 'list');
  assert.equal(list.length, 1, `one lookup per report, got ${list.length}`);
  const call = list[0];
  assert.ok(call.includes('--all'), `closed beads are in scope or a regression is invisible — ${call.join(' ')}`);
  const any = call[call.indexOf('--label-any') + 1].split(',');
  const fp = fingerprint(REPORT);
  assert.deepEqual(any.sort(), [fp.atLabel, fp.msgLabel].sort(), 'both keys, OR-ed, in one call');
  assert.ok(call.includes('--limit') && call[call.indexOf('--limit') + 1] === '0', 'and no page limit');
});

await check('posting from a line that has moved still matches, on the message', async () => {
  await reset();
  const first = await intake(bd, ws, REPORT);
  // An unrelated edit above the throw site. Without the message fingerprint every
  // subsequent report would file a fresh P0 whenever somebody added an import.
  const moved = await intake(bd, ws, { ...REPORT, line: 3402 });
  assert.equal(moved.action, 'commented');
  assert.equal(moved.id, first.id);
  assert.equal(moved.matchedOn, 'message', 'matched on the backup, because the primary key moved');
  assert.equal(issues().length, 1, 'still one bead');
  assert.match(issues()[0].comments[0], /line has moved/, 'and the comment says so, so the drift is on the record');
});

await check('and the bead learns the new line, so the next report matches directly', async () => {
  await reset();
  await intake(bd, ws, REPORT);
  await intake(bd, ws, { ...REPORT, line: 3402 });
  const movedLabel = fingerprint({ ...REPORT, line: 3402 }).atLabel;
  assert.ok(issues()[0].labels.includes(movedLabel), 'the new file:line went on the bead');
  // That second report opened a coalescing window, and a third inside it would be
  // counted without ever reaching the lookup — which is the point of the window and
  // useless for the claim under test here. Close it: the next report is a later one.
  await flushErrorWindows();
  clearCalls();
  const third = await intake(bd, ws, { ...REPORT, line: 3402 });
  assert.equal(third.matchedOn, 'source', 'so the third report hits the primary key, not the backup');
  assert.equal(issues().length, 1);
  assert.equal(issues()[0].comments.length, 2);
});

await check('an error whose only match is closed files a new bead, linked to it', async () => {
  await reset();
  const first = await intake(bd, ws, REPORT);
  // Somebody fixed it and closed the bead. Then it came back.
  const closed = bead(first.id);
  closed.status = 'closed';
  setBead(closed);

  const again = await intake(bd, ws, { ...REPORT, at: '2026-08-12T09:00:00.000Z' });
  assert.equal(again.action, 'regressed');
  assert.notEqual(again.id, first.id, 'a NEW bead — reopening loses the fact that it was ever fixed');
  assert.equal(issues().length, 2);
  const fresh = bead(again.id);
  assert.ok(
    fresh.deps.includes(`${DISCOVERED_FROM}:${first.id}`),
    `linked back to the closed one — got ${JSON.stringify(fresh.deps)}`
  );
  assert.equal(fresh.status, 'open');
  assert.equal(fresh.priority, ERROR_PRIORITY);
  assert.match(fresh.notes, /regression/i, 'and it says why it is a second bead');
  assert.equal(bead(first.id).comments.length, 0, 'the closed bead is not commented on or touched');
});

await check('a live bead wins over a closed one carrying the same fingerprint', async () => {
  await reset();
  const first = await intake(bd, ws, REPORT);
  const closed = bead(first.id);
  closed.status = 'closed';
  setBead(closed);
  const second = await intake(bd, ws, REPORT); // files the regression bead
  const third = await intake(bd, ws, REPORT);
  assert.equal(third.action, 'commented', 'the third report is an occurrence of the regression, not a fourth bead');
  assert.equal(third.id, second.id);
  assert.equal(issues().length, 2, 'and a regression does not file one bead per occurrence either');
});

await check('pickMatch prefers live over closed, and source over message', () => {
  const fp = fingerprint(REPORT);
  const closedBySource = { id: 'a', status: 'closed', labels: [fp.atLabel] };
  const openByMessage = { id: 'b', status: 'open', labels: [fp.msgLabel] };
  const openBySource = { id: 'c', status: 'open', labels: [fp.atLabel, fp.msgLabel] };
  assert.equal(pickMatch([closedBySource, openByMessage], fp).bead.id, 'b', 'live beats closed');
  assert.equal(pickMatch([openByMessage, openBySource], fp).bead.id, 'c', 'and the primary key beats the backup');
  assert.equal(pickMatch([openBySource], fp).matchedOn, 'source');
  assert.equal(pickMatch([openByMessage], fp).matchedOn, 'message');
  assert.equal(pickMatch([{ id: 'd', status: 'open', labels: ['unrelated'] }], fp), null);
  assert.equal(pickMatch([], fp), null);
});

/* -------------------------------------------------------------------- the race */

await check('three reports of one error at once are still one bead', async () => {
  // The case this exists for: a page whose render throws reports, re-renders, and
  // reports again before the first `bd create` has returned. bd's own single-writer
  // retry does not help — these creates do not conflict, they succeed.
  await reset();
  const outs = await Promise.all([
    intake(bd, ws, REPORT),
    intake(bd, ws, { ...REPORT, at: '2026-08-11T12:00:01.000Z' }),
    intake(bd, ws, { ...REPORT, at: '2026-08-11T12:00:02.000Z' }),
  ]);
  assert.equal(issues().length, 1, `one bead, got ${issues().length}`);
  assert.equal(outs.filter((o) => o.action === 'created').length, 1, 'exactly one of the three filed it');
  assert.equal(issues()[0].comments.length, 1, 'the second of them became a comment');
  assert.equal(
    outs.filter((o) => o.action === 'coalesced').length,
    1,
    'and the third was counted into the window that comment opened, not written (bc-5f9b)'
  );
});

await check('two different errors at once are not serialised behind each other', async () => {
  await reset();
  const [a, b] = await Promise.all([
    intake(bd, ws, REPORT),
    intake(bd, ws, { ...REPORT, message: 'Failed to fetch', source: '/public/console.js', line: 155 }),
  ]);
  assert.notEqual(a.id, b.id);
  assert.equal(issues().length, 2, 'two bugs, two beads');
});

await check('a failed report does not poison every later occurrence of it', async () => {
  // The chain the race test relies on must recover: if the first report's `bd create`
  // fails, the next report has to be filed rather than inheriting the rejection.
  await reset({ failCreate: true });
  await assert.rejects(() => intake(bd, ws, REPORT));
  fs.rmSync(FAIL_FLAG, { force: true });
  const out = await intake(bd, ws, REPORT);
  assert.equal(out.action, 'created', 'the tracker came back, so the error is filed');
  assert.equal(issues().length, 1);
});

/* -------------------------------------------------------- the coalescing window */

/**
 * One bead was only half of it. The dedupe stops a render loop filing forty beads and
 * then writes forty comments on the one it filed — a bead nobody can read, and a `bd`
 * write per report against a tracker only one process can write at a time. So the
 * assertions here are on both halves of the bargain: the comments are bounded, and the
 * number inside them is not.
 */

await check('a burst is one comment, and the count inside it is every report', async () => {
  await reset();
  const N = 50;
  const outs = [];
  for (let i = 0; i < N; i += 1) {
    // A ten-second window, driven by `flushErrorWindows` rather than slept through: the
    // question is what a burst costs the tracker, and a test that waits out a real
    // window is a test that measures setTimeout.
    const at = `2026-08-11T12:00:${String(i).padStart(2, '0')}.000Z`;
    outs.push(await intake(bd, ws, { ...REPORT, at }, { windowMs: 10_000 }));
  }
  assert.equal(issues().length, 1, 'one bead, as ever');
  assert.equal(issues()[0].comments.length, 1, `${N} reports, ${issues()[0].comments.length} comments while it is open`);
  assert.equal(outs.filter((o) => o.action === 'coalesced').length, N - 2, 'the first files, the second comments');
  assert.equal(outs.at(-1).count, N - 2, 'and every one after that is counted');

  await flushErrorWindows();
  const comments = issues()[0].comments;
  assert.equal(comments.length, 2, 'the window closing is the second comment and the last');
  assert.match(comments[1], new RegExp(`\\*\\*${N - 2} more occurrences\\*\\*`), comments[1]);
  assert.match(comments[1], /12:00:02/, 'from the first occurrence it counted');
  assert.match(comments[1], /12:00:49/, 'to the last');
  assert.match(comments[1], /app\.js:3315/, 'and it still says where');
});

await check('a coalesced report costs the tracker nothing — not even the lookup', async () => {
  // The half of this that is not about readability. `bd list` takes the same
  // single-writer lock `bd comment` does, so a window that skipped only the write would
  // still be ten lock acquisitions a second in front of eight worker sessions.
  await reset();
  await intake(bd, ws, REPORT, { windowMs: 10_000 });
  await intake(bd, ws, REPORT, { windowMs: 10_000 });
  clearCalls();
  for (let i = 0; i < 20; i += 1) await intake(bd, ws, REPORT, { windowMs: 10_000 });
  assert.equal(bdCalls().length, 0, `20 reports and ${bdCalls().length} bd calls`);
});

await check('the window closes on its own, with nobody to ask it to', async () => {
  // `flushErrorWindows` is the seam the checks above drive; the daemon has no such
  // caller, so the timer is what actually has to work.
  await reset();
  await intake(bd, ws, REPORT, { windowMs: 40 });
  await intake(bd, ws, REPORT, { windowMs: 40 });
  await intake(bd, ws, { ...REPORT, at: '2026-08-11T12:00:09.000Z' }, { windowMs: 40 });
  assert.equal(issues()[0].comments.length, 1, 'nothing written yet');
  await new Promise((r) => setTimeout(r, 500));
  const comments = issues()[0].comments;
  assert.equal(comments.length, 2, 'the timer wrote the summary');
  assert.match(comments[1], /\*\*1 more occurrence\*\*/, `singular, and no s: ${comments[1]}`);
});

await check('a window that closes empty is dropped, so a rare error still gets its own comment', async () => {
  await reset();
  await intake(bd, ws, REPORT, { windowMs: 40 });
  await intake(bd, ws, REPORT, { windowMs: 40 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(issues()[0].comments.length, 1, 'a window that counted nothing writes nothing');
  const third = await intake(bd, ws, REPORT, { windowMs: 40 });
  assert.equal(third.action, 'commented', 'an error that happens twice a week is not made to wait an hour');
  assert.equal(issues()[0].comments.length, 2);
});

await check('and a window that keeps closing full gets wider each time', async () => {
  // Otherwise a fixed minute is 1,440 comments a day, which is the unreadable bead
  // again by a slower route. Driven by polling rather than by sleeping for a known
  // window: the assertion is that it widens, and a loaded laptop is allowed to be late.
  await reset();
  await intake(bd, ws, REPORT, { windowMs: 40 });
  await intake(bd, ws, REPORT, { windowMs: 40 });
  let widened = null;
  for (let i = 0; i < 60 && !widened; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
    const out = await intake(bd, ws, REPORT, { windowMs: 40 });
    if (out.action === 'coalesced' && out.windowMs > 40) widened = out;
  }
  assert.ok(widened, 'a window that closed non-empty opened a wider one');
  assert.ok(widened.windowMs >= 80, `got ${widened?.windowMs}ms`);
  assert.ok(WINDOW_MAX_MS >= WINDOW_MS, 'and the widening has a ceiling');
  const comments = issues()[0].comments;
  assert.ok(comments.length < 8, `bounded even while it never stops: ${comments.length} comments`);
});

await check('only a new bead is news, and a coalesced report is not', () => {
  // Both callers push a `created` event for a new bead and stay quiet otherwise, so
  // that a page in a render loop cannot wake every parked poller. They used to ask
  // `action !== 'commented'`, which said yes to this one.
  assert.equal(isNewBead('created'), true);
  assert.equal(isNewBead('regressed'), true);
  assert.equal(isNewBead('commented'), false);
  assert.equal(isNewBead('coalesced'), false);
});

/* ------------------------------------------------------------------ the endpoint */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  host: '127.0.0.1',
  // Port 0, and the real one read back off the listener — see test/helpers/net.mjs.
  // ~20 sessions run this suite at once and a number somebody typed loses that race.
  port: 0,
  baseUrl: 'http://127.0.0.1',
  token: 'apperr-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [ws],
  sessionDirs: {},
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

const post = (pathname, body, onPort = port) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: onPort,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-beadcause-token': cfg.token,
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
    req.write(payload);
    req.end();
  });

for (let i = 0; i < 100; i += 1) {
  try {
    await post('/api/nothing', {});
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}

await check('POST /api/error files it, and a second post comments', async () => {
  await reset();
  const first = await post('/api/error', REPORT);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.ok, true);
  assert.equal(first.json.action, 'created');
  assert.equal(first.json.key, `demo/${first.json.id}`);
  const second = await post('/api/error', REPORT);
  assert.equal(second.json.action, 'commented');
  assert.equal(second.json.id, first.json.id);
  assert.equal(issues().length, 1);
});

await check('the workspace is optional — the reporter is a page, not a repo', async () => {
  await reset();
  const res = await post('/api/error', { ...REPORT, workspace: undefined });
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.equal(res.json.key, `demo/${res.json.id}`, 'and it defaults to the daemon’s own workspace');
  const named = await post('/api/error', { ...REPORT, workspace: 'nope' });
  assert.equal(named.status, 400, 'but a workspace that was named and does not exist is still an error');
});

await check('a message is required, and nothing else is', async () => {
  await reset();
  const empty = await post('/api/error', { source: '/app.js', line: 1 });
  assert.equal(empty.status, 400);
  assert.match(String(empty.json.error), /message/);
  assert.equal(issues().length, 0);
  const bare = await post('/api/error', { message: 'Script error.' });
  assert.equal(bare.json.ok, true, `a cross-origin onerror carries nothing else — ${JSON.stringify(bare.json)}`);
  assert.equal(issues().length, 1);
});

await check('a tracker that is down is an answer, never a 500', async () => {
  // This endpoint is called *by* error handling. A 5xx here is reported to it, and the
  // page reports its own reporting, forever.
  await reset({ failCreate: true });
  const res = await post('/api/error', REPORT);
  assert.equal(res.status, 200, 'a 5xx would be reported back to this same endpoint');
  assert.equal(res.json.ok, false);
  assert.ok(res.json.reason, 'and it says what went wrong, so the page can log it and stop');
});

await check('the endpoint is registered once, on POST', async () => {
  const { assertRoutes } = await import(LIB('server.js'));
  const routes = assertRoutes(app.handler);
  assert.ok(routes.includes('POST /api/error'), 'it is in the table createApp asserts over');
  assert.ok(!routes.includes('GET /api/error'), 'and only on POST — a GET must not file anything');
});

/* ------------------------------------------------- whose board an unnamed report lands on */

/**
 * The workspace a page's error defaults to — bc-xl7n.130.
 *
 * Every check above runs against a daemon with exactly ONE workspace, where the first
 * configured one and the daemon's own are the same graph and the routing cannot be
 * observed at all. That is why this shipped broken: the endpoint defaulted to
 * `workspaces[0]`, discovery sorts workspaces by name, and on a Mac whose own repo does
 * not win the alphabet every browser-reported crash was filed onto a *different team's*
 * tracker — by beadcause, at P0, under a personal identity.
 *
 * So the fixture is the fixture the bug needs: two workspaces, and the daemon's own is
 * deliberately LAST. `sessionDirs` is what makes it the daemon's own — it is the question
 * `ownWorkspace` asks, "which workspace's sessions open in this checkout".
 */
const otherDir = path.join(tmp, 'other', '.beads');
const ownDir = path.join(tmp, 'own', '.beads');
for (const d of [otherDir, ownDir]) fs.mkdirSync(d, { recursive: true });

const OTHER = { name: 'aaa-somebody-else', dir: otherDir };
const OWN = { name: 'zzz-this-app', dir: ownDir };

const ownedCfg = {
  ...cfg,
  port: 0,
  workspaces: [OTHER, OWN],
  sessionDirs: { [OWN.name]: path.join(HERE, '..') },
};
const ownedApp = createApp(ownedCfg);
const ownedServers = listen(ownedCfg, ownedApp.handler);
const ownedPort = await boundPort(ownedServers);

// The same two workspaces, and nothing tying either to this checkout — the install that
// cannot answer the question at all.
const rootlessCfg = { ...cfg, port: 0, workspaces: [OTHER, OWN], sessionDirs: {} };
const rootlessApp = createApp(rootlessCfg);
const rootlessServers = listen(rootlessCfg, rootlessApp.handler);
const rootlessPort = await boundPort(rootlessServers);

await check("an unnamed report goes to the daemon's own workspace, not the first configured one", async () => {
  await reset();
  const res = await post('/api/error', REPORT, ownedPort);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.match(
    String(res.json.key),
    new RegExp(`^${OWN.name}/`),
    `a crash in this app must not be filed onto whichever tracker sorts first — got ${res.json.key}`
  );
});

await check('a caller that does name a workspace is still obeyed', async () => {
  await reset();
  const res = await post('/api/error', { ...REPORT, workspace: OTHER.name }, ownedPort);
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.match(String(res.json.key), new RegExp(`^${OTHER.name}/`), 'an explicit workspace outranks the default');
});

await check('a daemon that cannot name its own workspace still files, rather than refusing', async () => {
  // Deliberately unlike POST /api/edits, which refuses when it cannot tell. An edit pass
  // that is turned away is still on the screen to retype; a crash report that is turned
  // away is gone. A bead on the wrong board can be moved — one never filed is not news.
  await reset();
  const res = await post('/api/error', REPORT, rootlessPort);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ok, true, 'a report is never dropped for want of a routing answer');
  assert.match(String(res.json.key), new RegExp(`^${OTHER.name}/`), 'and it falls back to the first workspace');
});

/* -------------------------------------------------------------------- the result */

for (const s of [...servers, ...ownedServers, ...rootlessServers]) s.close();
await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
