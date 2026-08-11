#!/usr/bin/env node
/**
 * The four verdicts on an unendorsed bead — endorse, revoke, adjust, ask for changes.
 *
 *     npm test
 *     node test/verdicts.mjs
 *
 * test/endorse.mjs proves the hold: an agent-filed bead carries `unendorsed`, nothing
 * queues it and nothing may open a session on it. This file proves the way out of the
 * hold, which is the half a person actually touches — and the half where being wrong is
 * expensive in both directions. A verdict that under-fires leaves work nobody can start;
 * one that over-fires closes a discovery, or endorses a bead over a stale list.
 *
 * What is asserted, and why each one is here rather than assumed:
 *
 * 1. **Endorse is idempotent.** It is the only verdict that changes what may be worked,
 *    so it is the only one that must survive a double tap on a train: two taps, one
 *    endorsement, no error card, and no second `bd` write.
 * 2. **Every verdict takes a list, and one bead's failure keeps the rest.** Dolt is
 *    single-writer and a group of six is six chances to lose a lock race. A group where
 *    the third id does not exist must still land the other five.
 * 3. **Held is required, except to endorse.** Between the queue being drawn and a thumb
 *    landing, the bead may have been endorsed on the laptop. Revoking it then would close
 *    work that had just been approved, over a list that was already wrong.
 * 4. **Adjust keeps the marker.** Fixing a title is not agreeing to the work. Only
 *    `endorse: true` on the same call does both.
 * 5. **The outcomes are real in the tracker.** An endorsed bead comes back through
 *    `bd ready` and past `assertEndorsed`; a revoked one is closed with its reason on the
 *    close; an adjusted one has the new fields and still cannot be worked.
 *
 * No real tracker and no iTerm. `bd` is a stub binary over a JSON file that logs its
 * argv, so the flags are asserted as they are actually passed — an adjust that reached
 * for `--set-labels` would take the hold off as collateral, and only the argv can show
 * that. The four endpoints are exercised over a real socket against `createApp`, because
 * the routes are where a verdict's guards live and a unit call would skip every one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-verdicts-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED, assertEndorsed } = await import(LIB('endorse.js'));
const { FILED_LABEL } = await import(LIB('filing.js'));
const {
  applyVerdict,
  normalizeEdits,
  updateFor,
  parseIds,
  statusFor,
  changeSummary,
  EDITABLE,
  MAX_IDS,
  REVOKED_PREFIX,
} = await import(LIB('verdict.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, and a `bd` that reads and writes it.
 *
 * `update` is implemented flag by flag — including `--add-label` / `--remove-label` as
 * repeatable strings — because the point of several assertions below is *which* flags
 * the adjust reached for. A stub that took the whole argv and applied a patch would
 * pass whatever the code did, including a `--set-labels` that wiped the hold.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
const all = () => Object.values(w.issues);
const one = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'ready') {
  const off = many('--exclude-label');
  const rows = all()
    .filter((i) => i.status === 'open' && !i.assignee)
    .filter((i) => !(i.labels || []).some((l) => off.includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (args.includes('--set-labels')) die('the verdicts must never replace a bead\\'s labels wholesale');
  const set = (flag, field) => { const v = one(flag); if (v !== null) issue[field] = v; };
  set('--title', 'title');
  set('--type', 'issue_type');
  set('--description', 'description');
  set('--acceptance', 'acceptance_criteria');
  set('--notes', 'notes');
  const p = one('--priority');
  if (p !== null) issue.priority = Number(String(p).replace(/^p/i, ''));
  issue.labels = issue.labels || [];
  for (const l of many('--add-label')) if (!issue.labels.includes(l)) issue.labels.push(l);
  const off = many('--remove-label');
  if (off.length) issue.labels = issue.labels.filter((l) => !off.includes(l));
  save();
  process.exit(0);
}
if (args[0] === 'close') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (issue.status === 'closed') die('Error: ' + args[1] + ' is already closed');
  issue.status = 'closed';
  issue.close_reason = one('--reason') || '';
  save();
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  issue.comments = issue.comments || [];
  issue.comments.push({ text: args[2], actor: one('--actor') || '' });
  save();
  process.exit(0);
}
if (args[0] === 'comments') {
  const issue = w.issues[args[1]];
  process.stdout.write(JSON.stringify((issue && issue.comments) || []));
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'remove') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.labels = (issue.labels || []).filter((l) => l !== args[3]);
  save();
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'add') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.labels = [...new Set([...(issue.labels || []), args[3]])];
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const clearCalls = () => fs.rmSync(BD_LOG, { force: true });

const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: 'as the agent filed it',
  acceptance_criteria: 'the way bd names it, which is not the way an edit does',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  ...extra,
});

/** Three beads an agent filed and one ordinary piece of work nobody has to endorse. */
const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'zz-one': issue('zz-one', { labels: [UNENDORSED, FILED_LABEL, 'api'] }),
          'zz-two': issue('zz-two', { labels: [UNENDORSED, FILED_LABEL] }),
          'zz-three': issue('zz-three', { labels: [UNENDORSED, FILED_LABEL] }),
          'zz-work': issue('zz-work', { labels: ['api'] }),
        },
      },
      null,
      2
    )
  );
};
reset();

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const ws = { name: 'demo', dir: wsDir };
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues;
const beadAt = (id) => world()[id];
const labelsOf = (id) => beadAt(id).labels;

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
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

console.log('\nendorse, revoke, adjust and ask for changes — singly and as a group\n');

/* ------------------------------------------------------------------ the parsing */

await check('one id and a list of ids are the same request', () => {
  assert.deepEqual(parseIds({ id: 'zz-one' }), ['zz-one']);
  assert.deepEqual(parseIds({ ids: ['zz-one', 'zz-two'] }), ['zz-one', 'zz-two']);
  assert.deepEqual(parseIds({ ids: 'zz-one,zz-two' }), ['zz-one', 'zz-two'], 'a comma string is a list too');
  assert.deepEqual(parseIds({ ids: ['zz-one', ' zz-one '] }), ['zz-one'], 'and the same bead twice is once');
  assert.deepEqual(parseIds({}), []);
});

await check('an edit names only the fields it names', () => {
  const edits = normalizeEdits({ priority: 'P3' });
  assert.deepEqual(edits, { priority: 3 }, `a re-prioritise must not carry a blank description: ${JSON.stringify(edits)}`);
  assert.deepEqual(normalizeEdits({ type: 'nonsense' }), { type: 'task' }, 'a type bd never heard of is clamped here');
  assert.deepEqual(normalizeEdits({ priority: 'high' }), { priority: 2 }, 'and so is a priority typed as a word');
  assert.deepEqual(normalizeEdits({ title: '   ' }), {}, 'a cleared title is not an edit — an untitled bead is not a bead');
  assert.deepEqual(
    normalizeEdits({ description: '', acceptance: '' }),
    {},
    'and neither is an emptied box — that is a form that failed to load far more often than a person erasing the work'
  );
  assert.deepEqual(normalizeEdits({ labels: [] }), { labels: [] }, 'but no labels at all is something you can mean');
  assert.deepEqual(normalizeEdits({}), {});
  assert.deepEqual(normalizeEdits(null), {});
  assert.deepEqual(normalizeEdits({ notes: 'nope', deps: ['zz-work'] }), {}, `only ${EDITABLE.join(', ')} may be adjusted`);
});

await check('the two labels the daemon owns cannot be set or cleared as ordinary labels', () => {
  const edits = normalizeEdits({ labels: ['api', UNENDORSED, FILED_LABEL, 'human'] });
  assert.deepEqual(edits.labels, ['api'], `the hold is not a label a form may hand back: ${JSON.stringify(edits)}`);

  const { update } = updateFor(beadAt('zz-one'), normalizeEdits({ labels: ['worker'] }));
  assert.deepEqual(update.addLabels, ['worker']);
  assert.deepEqual(update.removeLabels, ['api'], 'a label the card no longer lists is one you removed');
  assert.ok(!update.removeLabels.includes(UNENDORSED), 'but never the hold');
  assert.ok(!update.removeLabels.includes(FILED_LABEL), 'and never the provenance');
});

await check('an adjust that changes nothing is no write at all', () => {
  const bead = beadAt('zz-one');
  // Every one of the six, at the value the bead already has — including the two a bd
  // row does not call by the name an edit calls them. Reading `issue.type` off a row
  // gets `undefined`, which never matches, so a comparison against the wrong key would
  // rewrite every field of every bead on every save and say so on the thread.
  const same = normalizeEdits({
    title: bead.title,
    type: bead.issue_type,
    priority: bead.priority,
    description: bead.description,
    acceptance: bead.acceptance_criteria,
    labels: bead.labels.filter((l) => l !== UNENDORSED && l !== FILED_LABEL),
  });
  const { update, changed } = updateFor(bead, same);
  assert.deepEqual(changed, [], `a form posted unchanged must not touch the tracker: ${JSON.stringify(update)}`);
  assert.equal(changeSummary(bead, update), '', 'and leaves nothing on the thread');
});

/* --------------------------------------------------------------------- endorse */

await check('endorsing takes the marker off and the bead becomes workable', async () => {
  reset();
  const out = await applyVerdict(bd, ws, { verdict: 'endorse', ids: ['zz-one'] });
  assert.equal(out.failed.length, 0, JSON.stringify(out.failed));
  assert.equal(out.ok[0].endorsed, true);
  assert.deepEqual(labelsOf('zz-one'), [FILED_LABEL, 'api'], 'and only the marker comes off — provenance survives');
  // Both layers, because an endorsement that only half worked would pass either alone.
  const ready = (await bd.ready(ws)).map((r) => r.id);
  assert.ok(ready.includes('zz-one'), `an endorsed bead is in the queue, got ${ready.join(', ')}`);
  assert.equal((await assertEndorsed(bd, ws, 'zz-one')).id, 'zz-one', 'and past the gate at launch');
});

await check('a second tap is one endorsement, no error card, and no second write', async () => {
  clearCalls();
  const out = await applyVerdict(bd, ws, { verdict: 'endorse', ids: ['zz-one'] });
  assert.equal(out.failed.length, 0, 'the one verdict that must survive a double tap');
  assert.equal(out.ok[0].endorsed, false, 'and it says plainly that nothing happened');
  assert.equal(bdCalls().filter((c) => c[0] === 'label').length, 0, 'no write on a bead that was already endorsed');
});

await check('a group endorse is one call, and one missing bead does not lose the rest', async () => {
  reset();
  const out = await applyVerdict(bd, ws, { verdict: 'endorse', ids: ['zz-one', 'zz-gone', 'zz-three'] });
  assert.deepEqual(out.ok.map((r) => r.id), ['zz-one', 'zz-three'], 'the busy-week case: five of six is five, not none');
  assert.deepEqual(out.failed.map((r) => r.id), ['zz-gone']);
  assert.equal(out.failed[0].status, 404, `a bead that is gone is a 404, not a 500: ${out.failed[0].error}`);
  assert.equal(statusFor(out), 200, 'and the request as a whole worked, because most of it did');
  assert.ok(!labelsOf('zz-one').includes(UNENDORSED));
  assert.ok(!labelsOf('zz-three').includes(UNENDORSED));
  assert.ok(labelsOf('zz-two').includes(UNENDORSED), 'a bead nobody named is untouched');
});

/* ---------------------------------------------------------------------- revoke */

await check('revoking closes the bead with the reason, and keeps the marker', async () => {
  reset();
  const out = await applyVerdict(bd, ws, { verdict: 'revoke', ids: ['zz-two'], reason: `${REVOKED_PREFIX} — already fixed` });
  assert.equal(out.failed.length, 0, JSON.stringify(out.failed));
  const bead = beadAt('zz-two');
  assert.equal(bead.status, 'closed');
  assert.match(bead.close_reason, /already fixed/, 'the rejection stays on the record, not just the rejection');
  assert.ok(bead.labels.includes(UNENDORSED), 'still marked, so the history of what was filed and refused survives');
});

await check('revoking twice is not an error — the second tap means what the first did', async () => {
  const out = await applyVerdict(bd, ws, { verdict: 'revoke', ids: ['zz-two'], reason: 'again' });
  assert.equal(out.failed.length, 0, `a closed bead is "already", not a failure: ${JSON.stringify(out.failed)}`);
  assert.equal(out.ok[0].already, true);
  assert.equal(out.ok[0].revoked, false);
});

await check('and it refuses a bead that has already been endorsed', async () => {
  reset();
  await applyVerdict(bd, ws, { verdict: 'endorse', ids: ['zz-one'] });
  const out = await applyVerdict(bd, ws, { verdict: 'revoke', ids: ['zz-one'] });
  assert.equal(out.ok.length, 0);
  assert.equal(out.failed[0].status, 409, JSON.stringify(out.failed[0]));
  assert.equal(out.failed[0].unendorsed, true, 'the caller can tell a stale queue from a broken tracker');
  assert.equal(beadAt('zz-one').status, 'open', 'work approved a minute ago is not closed by a stale list');
  assert.equal(statusFor(out), 409, 'and a single-bead verdict still reads as a plain conflict');
});

/* ---------------------------------------------------------------------- adjust */

await check('adjusting rewrites the fields and keeps the bead held', async () => {
  reset();
  clearCalls();
  const edits = normalizeEdits({ title: 'Cache-bust site.js', priority: 'P3', labels: ['api', 'phone'] });
  const out = await applyVerdict(bd, ws, { verdict: 'adjust', ids: ['zz-one'], edits, actor: 'adam@example.com' });
  assert.equal(out.failed.length, 0, JSON.stringify(out.failed));
  assert.deepEqual(out.ok[0].changed.sort(), ['labels', 'priority', 'title']);
  assert.equal(out.ok[0].endorsed, false, 'fixing a title is not agreeing to the work');

  const bead = beadAt('zz-one');
  assert.equal(bead.title, 'Cache-bust site.js');
  assert.equal(bead.priority, 3);
  assert.deepEqual(bead.labels.sort(), [FILED_LABEL, UNENDORSED, 'api', 'phone'].sort(), 'the hold survives the edit');
  assert.equal(bead.description, 'as the agent filed it', 'and a field nobody named is not blanked');

  const update = bdCalls().find((c) => c[0] === 'update');
  assert.ok(update.includes('--add-label') && !update.includes('--set-labels'), `labels move one at a time: ${update.join(' ')}`);
  assert.equal(bdCalls().filter((c) => c[0] === 'update').length, 1, 'everything that moved moved in one write');
  assert.match(bead.comments.at(-1).text, /Adjusted before endorsement/, 'and the thread says what you rewrote');
});

await check('an adjusted bead still cannot be worked', async () => {
  await assert.rejects(
    () => assertEndorsed(bd, ws, 'zz-one'),
    (err) => err.status === 409 && err.unendorsed === true,
    'the whole point of keeping the marker'
  );
});

await check('adjust and endorse in one tap is one decision', async () => {
  reset();
  const out = await applyVerdict(bd, ws, {
    verdict: 'adjust',
    ids: ['zz-two'],
    edits: normalizeEdits({ priority: 4 }),
    endorse: true,
  });
  assert.deepEqual(out.ok[0].changed, ['priority']);
  assert.equal(out.ok[0].endorsed, true);
  assert.equal(beadAt('zz-two').priority, 4);
  assert.ok(!labelsOf('zz-two').includes(UNENDORSED));
  // And the double tap: the same call again, on a bead that is no longer held.
  const again = await applyVerdict(bd, ws, { verdict: 'adjust', ids: ['zz-two'], edits: normalizeEdits({ priority: 4 }), endorse: true });
  assert.equal(again.failed.length, 0, `adjust-and-endorse must survive being sent twice: ${JSON.stringify(again.failed)}`);
});

await check('but adjusting alone refuses a bead that is no longer held', async () => {
  const out = await applyVerdict(bd, ws, { verdict: 'adjust', ids: ['zz-two'], edits: normalizeEdits({ title: 'no' }) });
  assert.equal(out.failed[0].status, 409, JSON.stringify(out.failed[0]));
  assert.equal(beadAt('zz-two').title, 'bead zz-two', 'and nothing is written on the way to the refusal');
});

/* ------------------------------------------------------------- ask for changes */

await check('asking for changes leaves the bead exactly where it was, with your note on it', async () => {
  reset();
  const out = await applyVerdict(bd, ws, {
    verdict: 'changes',
    ids: ['zz-one'],
    note: 'This is the same as bc-9frx — say why it is not before I endorse it.',
    actor: 'adam@example.com',
  });
  assert.equal(out.failed.length, 0, JSON.stringify(out.failed));
  const bead = beadAt('zz-one');
  assert.match(bead.comments.at(-1).text, /same as bc-9frx/);
  assert.equal(bead.comments.at(-1).actor, 'adam@example.com', 'written as you — this one is a sentence a person said');
  assert.equal(bead.status, 'open');
  assert.ok(bead.labels.includes(UNENDORSED), 'still held, so the next session reads the objection before re-filing');
});

await check('and it refuses a bead that is not held, because there is nothing to object to yet', async () => {
  const out = await applyVerdict(bd, ws, { verdict: 'changes', ids: ['zz-work'], note: 'no' });
  assert.equal(out.failed[0].status, 409, JSON.stringify(out.failed[0]));
  assert.equal((beadAt('zz-work').comments || []).length, 0);
});

/* -------------------------------------------------------------- over the wire */

/**
 * The four endpoints, over a real socket, against the stub `bd`.
 *
 * The guards this reaches are only on the routes — the id shapes, the group cap, the
 * title-on-a-group refusal, the required note — and every one of them is the difference
 * between a client bug and a write nobody meant.
 */
const { createApp, listen } = await import(LIB('server.js'));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const cfg = {
  host: '127.0.0.1',
  port,
  baseUrl: `http://127.0.0.1:${port}`,
  token: 'verdict-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [ws],
  sessionDirs: { demo: path.join(tmp, 'no-such-checkout') },
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

const post = (pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
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

await check('POST /api/bead/endorse — a group in one request, a row per bead back', async () => {
  reset();
  const res = await post('/api/bead/endorse', { workspace: 'demo', ids: ['zz-one', 'zz-two'] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ok, true, `ok is a flag on the wire, whatever it is called inside: ${JSON.stringify(res.json.ok)}`);
  assert.deepEqual(res.json.results.map((r) => r.id), ['zz-one', 'zz-two']);
  assert.deepEqual(res.json.applied, ['zz-one', 'zz-two'], 'the ids that moved, so a queue knows which rows to drop');
  assert.ok(!labelsOf('zz-one').includes(UNENDORSED));
  assert.ok(!labelsOf('zz-two').includes(UNENDORSED));
});

await check('POST /api/bead/revoke — the reason you typed, under the fixed prefix', async () => {
  reset();
  const res = await post('/api/bead/revoke', { workspace: 'demo', id: 'zz-three', reason: 'the daemon already does this' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(beadAt('zz-three').status, 'closed');
  assert.equal(beadAt('zz-three').close_reason, `${REVOKED_PREFIX} — the daemon already does this`);
});

await check('and a revoke with nothing typed still closes with a reason worth reading later', async () => {
  reset();
  await post('/api/bead/revoke', { workspace: 'demo', id: 'zz-three' });
  assert.match(beadAt('zz-three').close_reason, new RegExp(REVOKED_PREFIX), '"closed" on its own answers nothing');
});

await check('POST /api/bead/adjust — edits land, and endorse: true does both', async () => {
  reset();
  const res = await post('/api/bead/adjust', {
    workspace: 'demo',
    id: 'zz-one',
    edits: { title: 'A better title', priority: 'P1' },
    endorse: true,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(beadAt('zz-one').title, 'A better title');
  assert.equal(beadAt('zz-one').priority, 1, 'your priority is yours — the agent-filed clamp is on filing, not on you');
  assert.ok(!labelsOf('zz-one').includes(UNENDORSED));
});

await check('POST /api/bead/changes — the note is the verdict, so it is required', async () => {
  reset();
  const empty = await post('/api/bead/changes', { workspace: 'demo', id: 'zz-one', note: '   ' });
  assert.equal(empty.status, 400, JSON.stringify(empty.json));
  assert.equal((beadAt('zz-one').comments || []).length, 0, 'and nothing is written on the way to the refusal');

  const res = await post('/api/bead/changes', { workspace: 'demo', id: 'zz-one', note: 'Which file is this in?' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.match(beadAt('zz-one').comments.at(-1).text, /Which file/);
  assert.ok(labelsOf('zz-one').includes(UNENDORSED));
});

await check('a bad id, an empty list or too many is refused before anything is written', async () => {
  reset();
  clearCalls();
  const none = await post('/api/bead/endorse', { workspace: 'demo' });
  assert.equal(none.status, 400, JSON.stringify(none.json));

  const junk = await post('/api/bead/endorse', { workspace: 'demo', ids: ['zz-one', '../../etc/passwd'] });
  assert.equal(junk.status, 400, `a group is refused whole, not half applied: ${JSON.stringify(junk.json)}`);

  const flood = await post('/api/bead/endorse', {
    workspace: 'demo',
    ids: Array.from({ length: MAX_IDS + 1 }, (_, i) => `zz-${i}`),
  });
  assert.equal(flood.status, 400, JSON.stringify(flood.json));

  assert.equal(bdCalls().length, 0, 'not one bd call between the three of them');
  assert.ok(labelsOf('zz-one').includes(UNENDORSED));
});

await check('an unknown workspace is a 400, and one title cannot be given to a group', async () => {
  const nowhere = await post('/api/bead/endorse', { workspace: 'not-a-workspace', id: 'zz-one' });
  assert.equal(nowhere.status, 400, JSON.stringify(nowhere.json));

  const shared = await post('/api/bead/adjust', { workspace: 'demo', ids: ['zz-one', 'zz-two'], edits: { title: 'one title' } });
  assert.equal(shared.status, 400, JSON.stringify(shared.json));
  assert.equal(beadAt('zz-one').title, 'bead zz-one');

  const nothing = await post('/api/bead/adjust', { workspace: 'demo', id: 'zz-one', edits: { notes: 'not adjustable' } });
  assert.equal(nothing.status, 400, `an adjust with nothing to adjust is a client bug: ${JSON.stringify(nothing.json)}`);

  // But a group re-prioritise is exactly the case the list is for.
  const group = await post('/api/bead/adjust', { workspace: 'demo', ids: ['zz-one', 'zz-two'], edits: { priority: 4 } });
  assert.equal(group.status, 200, JSON.stringify(group.json));
  assert.equal(beadAt('zz-one').priority, 4);
  assert.equal(beadAt('zz-two').priority, 4);
});

/* -------------------------------------------------------------------- the result */

console.log(`\n${ran - failures}/${ran} passed\n`);
for (const s of servers || []) s.close?.();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
