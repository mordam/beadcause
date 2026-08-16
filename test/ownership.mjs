#!/usr/bin/env node
/**
 * Who owns a P0 — and the guarantee that a Mac which does not know who it is writes nothing.
 *
 *     npm test
 *     node test/ownership.mjs
 *
 * bc-rfnr.1. The tracker had one field that said whose a bead was and it was `assignee`,
 * which three ordinary things overwrite: `bd update --claim` when a worker starts,
 * `Bd.reopen` when it stops, and every verdict that moves a bead between the two. So the
 * answer to "whose P0 is this" was erased by the first session that touched it. It is a
 * label now — `owner:<handle>` — for lib/lease.js's reason: a label is a row, two machines
 * writing two of them is not a conflict Dolt has to resolve, and after a sync both are
 * visible.
 *
 * Five properties, in the order they would break in:
 *
 * 1. **`me` unset is the old app, exactly.** Not a quiet default — a branch that cannot be
 *    entered. Every assertion about a stamped bead is repeated with `me` absent, because
 *    that is the configuration every existing install has, and the failure is silent: a
 *    P0 arrives owned by nobody in particular and nothing says so.
 * 2. **P0 and nothing else.** The stamp is on the priority somebody has to be answerable
 *    for. A P1 filed by the same daemon on the same machine must come out byte-for-byte
 *    the bead it came out before, or every filing path in the app has quietly changed.
 * 3. **An owner the caller named wins.** Triage files a P0 *for* somebody else; stamping
 *    this Mac's handle on top would give it two owners and make the second one a lie.
 * 4. **It survives what killed the assignee.** A claim and a reopen are asserted against
 *    the real `Bd` methods rather than reasoned about, because "labels are not touched by
 *    `--assignee ''`" is exactly the kind of true-today that a future flag makes false.
 * 5. **The ✎ cannot strip it.** `updateFor` expresses a label removal as "what the card no
 *    longer shows", and the owner is not something the card offers you to type — so
 *    adjusting a P0's title from the phone would otherwise hand it back to nobody.
 *
 * The last check is a different kind: the browser has its own copy of the prefix
 * (`ownersOn` in public/graph.js, because there is no module boundary between a page and
 * `lib/`), and a copy that drifts draws every P0 as unowned while the tracker says
 * otherwise. So the file is read and the string is asserted against this module's.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-ownership-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  OWNER_PREFIX,
  P0,
  isP0,
  isOwnerLabel,
  ownerLabel,
  ownersOf,
  ownerOf,
  ownersOn,
  ownedByMe,
  ownOwnerLabels,
  ownerUpdate,
} = await import(LIB('ownership.js'));
const { Bd } = await import(LIB('bd.js'));
const { isProtectedLabel, updateFor, normalizeEdits } = await import(LIB('verdict.js'));

/* ------------------------------------------------------------------- a fake `bd` */

/**
 * Every invocation, appended as argv — which is the whole of what these tests are about.
 *
 * `Bd.create` is not asked what it returns, it is asked what it *ran*: a unit test of
 * `ownOwnerLabels` would pass just as happily against a `create` that never called it,
 * which is the mistake test/addressee.mjs already names for the addressee stamp.
 */
const BD_LOG = path.join(tmp, 'bd.log');
const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const world = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(world, null, 2));
if (args[0] === 'create') { process.stdout.write(JSON.stringify({ id: 'zz-new' })); process.exit(0); }
if (args[0] === 'update') {
  const issue = world.issues[args[1]];
  if (issue) {
    for (let i = 2; i < args.length; i += 1) {
      if (args[i] === '--add-label') issue.labels = [...new Set([...(issue.labels || []), args[i + 1]])];
      if (args[i] === '--remove-label') issue.labels = (issue.labels || []).filter((l) => l !== args[i + 1]);
      if (args[i] === '--assignee') issue.assignee = args[i + 1];
      if (args[i] === '--status') issue.status = args[i + 1];
    }
    save();
  }
  process.stdout.write('{}');
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = world.issues[args[1]];
  if (!issue) { process.stderr.write('Error: no issue found matching "' + args[1] + '"'); process.exit(1); }
  process.stdout.write(JSON.stringify(issue));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const argvs = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const clear = () => fs.rmSync(BD_LOG, { force: true });

/** The `--label` values of the last command run, in the order they were pushed. */
const labelsPassed = () => {
  const args = argvs().at(-1) || [];
  return args.map((a, i) => (a === '--label' ? args[i + 1] : null)).filter(Boolean);
};

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const ws = { name: 'demo', dir: wsDir };

const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  status: 'open',
  issue_type: 'task',
  priority: 0,
  labels: [],
  ...extra,
});
const reset = () =>
  fs.writeFileSync(
    WORLD,
    JSON.stringify({ issues: { 'zz-p0': issue('zz-p0', { labels: ['owner:adam@example.com', 'inbox'] }) } }, null, 2)
  );
reset();

const labelsOf = (id) => JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues[id].labels;
const rowOf = (id) => JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues[id];

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

console.log('\nwho owns a P0\n');

/* -------------------------------------------------------- reading and writing it */

await check('a bead with no owner label is owned by nobody', () => {
  assert.deepEqual(ownersOf([]), []);
  assert.deepEqual(ownersOf(undefined), []);
  assert.deepEqual(ownersOf(['human', 'agent-filed', 'ownership']), []);
  assert.equal(ownerOf({ labels: ['inbox'] }), null);
  assert.equal(ownerOf(null), null);
});

await check('owner:<handle> is read, lowercased, trimmed and deduped', () => {
  assert.deepEqual(ownersOf(['inbox', 'owner:Adam@Example.com']), ['adam@example.com']);
  assert.deepEqual(ownersOf(['owner:bob', 'owner:BOB', 'owner:carol']), ['bob', 'carol']);
  assert.equal(ownerLabel('  Adam@Example.com '), 'owner:adam@example.com');
  assert.equal(OWNER_PREFIX, 'owner:');
});

await check('an empty handle is not an owner, and neither is a prefix that only looks like one', () => {
  // `owner:` alone would answer `bd list --label owner:` and nothing else, which is
  // worse than an honestly unowned bead.
  assert.deepEqual(ownersOf(['owner:', 'owner:   ']), []);
  assert.equal(ownerLabel(''), null);
  assert.equal(ownerLabel(null), null);
  assert.equal(isOwnerLabel('ownership'), false, 'it is not a prefix match on the word');
  assert.equal(isOwnerLabel('owner:adam'), true);
});

await check('two owners is drawn as two, not resolved down to one', () => {
  // Two machines wrote before either synced. Picking one and hiding the other is how a
  // tracker starts lying about who is answerable — see `ownersOf`.
  const both = { labels: ['owner:adam@example.com', 'owner:bob@example.com'] };
  assert.deepEqual(ownersOn(both), ['adam@example.com', 'bob@example.com']);
  assert.equal(ownerOf(both), 'adam@example.com', 'and the single-owner reader takes the first');
});

await check('P0 is a number, and it is the only priority this is about', () => {
  assert.equal(P0, 0);
  assert.equal(isP0({ priority: 0 }), true);
  assert.equal(isP0({ priority: '0' }), true, 'a bd row may carry it either way');
  assert.equal(isP0({ priority: 1 }), false);
  assert.equal(isP0({}), false);
  assert.equal(isP0(null), false);
});

/* ----------------------------------------------------------- whose Mac this is */

await check('ownedByMe is false in all three of the ways it can be false', () => {
  const mine = { labels: ['owner:adam@example.com'] };
  assert.equal(ownedByMe({ me: 'adam@example.com' }, mine), true);
  assert.equal(ownedByMe({ me: 'ADAM@example.com' }, mine), true, 'handles are case-insensitive');
  assert.equal(ownedByMe({}, mine), false, 'this Mac does not know who it is');
  assert.equal(ownedByMe({ me: 'adam@example.com' }, { labels: [] }), false, 'the bead names nobody');
  assert.equal(ownedByMe({ me: 'bob@example.com' }, mine), false, 'the bead names somebody else');
});

await check('a second address answers for the same person', () => {
  const cfg = { me: ['adam@example.com', 'neadamthal@gmail.com'] };
  assert.equal(ownedByMe(cfg, { labels: ['owner:neadamthal@gmail.com'] }), true);
  // But only the first is ever *written*: a P0 owned by both is no more owned, and
  // reads on the card as if two people had taken it.
  assert.deepEqual(ownOwnerLabels(cfg), ['owner:adam@example.com']);
});

await check('WITH me UNSET, THERE IS NO LABEL TO WRITE', () => {
  assert.deepEqual(ownOwnerLabels({}), []);
  assert.deepEqual(ownOwnerLabels({ me: null }), []);
  assert.deepEqual(ownOwnerLabels({ me: '' }), []);
});

/* --------------------------------------------------------------- the stamp on create */

await check('a P0 filed by this daemon carries this Mac’s handle', async () => {
  clear();
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test', me: 'adam@example.com' });
  await bd.create(ws, { title: 'a critical thing', priority: 0, labels: [] });
  assert.deepEqual(labelsPassed(), ['owner:adam@example.com']);
});

await check('and a question at P0 carries both stamps, because they answer different questions', async () => {
  clear();
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test', me: 'adam@example.com' });
  await bd.create(ws, { title: 'a critical question', priority: 0 });
  assert.deepEqual(labelsPassed(), ['human', 'for:adam@example.com', 'owner:adam@example.com']);
});

await check('NOTHING BUT P0 IS STAMPED', async () => {
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test', me: 'adam@example.com' });
  for (const priority of [1, 2, 3, 4]) {
    clear();
    await bd.create(ws, { title: 'ordinary work', priority, labels: ['worker'] });
    assert.deepEqual(labelsPassed(), ['worker'], `P${priority} was stamped`);
  }
});

await check('AND WITH me UNSET A P0 IS THE BEAD THIS DAEMON ALWAYS FILED', async () => {
  clear();
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
  await bd.create(ws, { title: 'a critical thing', priority: 0, labels: ['worker'] });
  assert.deepEqual(labelsPassed(), ['worker']);
  clear();
  await bd.create(ws, { title: 'a critical question', priority: 0 });
  assert.deepEqual(labelsPassed(), ['human'], 'and neither stamp appears');
});

await check('an owner the caller named wins — this is a default, not an override', async () => {
  clear();
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test', me: 'adam@example.com' });
  await bd.create(ws, { title: 'filed for a colleague', priority: 0, labels: ['owner:bob@example.com'] });
  assert.deepEqual(labelsPassed(), ['owner:bob@example.com'], 'two owners would make the second one a lie');
});

/* ------------------------------------------------- what killed the assignee field */

await check('the label survives a claim and a reopen — the two writes that erase an assignee', async () => {
  reset();
  const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test', me: 'adam@example.com' });
  // A claim, as `bd update --claim` leaves the row: assigned and in progress.
  await bd.update(ws, 'zz-p0', { notes: '' }, {});
  await bd.run(ws, ['update', 'zz-p0', '--status', 'in_progress', '--assignee', 'some-agent']);
  assert.ok(labelsOf('zz-p0').includes('owner:adam@example.com'), 'a claim took the owner off');
  assert.equal(rowOf('zz-p0').assignee, 'some-agent');
  // And the reopen that clears it again — the write the advocate needs and the one that
  // made `assignee` useless as a record of ownership.
  await bd.reopen(ws, 'zz-p0');
  assert.equal(rowOf('zz-p0').assignee, '', 'the assignee is gone, which is the point');
  assert.ok(labelsOf('zz-p0').includes('owner:adam@example.com'), 'and the owner is not');
});

/* --------------------------------------------------------------- the ✎ may not strip it */

await check('an owner label is protected from an adjust, the way the hold and the provenance are', () => {
  assert.equal(isProtectedLabel('unendorsed'), true);
  assert.equal(isProtectedLabel('agent-filed'), true);
  assert.equal(isProtectedLabel('owner:adam@example.com'), true);
  assert.equal(isProtectedLabel('inbox'), false);
});

await check('so adjusting a P0 from the phone cannot hand it back to nobody', () => {
  const bead = { id: 'zz-p0', title: 'old', priority: 0, labels: ['owner:adam@example.com', 'inbox', 'tracker'] };
  // What the ✎ posts is the label set the card is showing, and the card does not show
  // the owner — so "tracker" is a removal and the owner must not be collateral of it.
  const { update, changed } = updateFor(bead, normalizeEdits({ title: 'new', labels: ['inbox'] }));
  assert.deepEqual(update.removeLabels, ['tracker']);
  assert.ok(!(update.addLabels || []).length);
  assert.ok(changed.includes('labels'));
  assert.equal(update.title, 'new');
});

await check('and typing one into the label box does not set one either', () => {
  // The other direction of the same guard: ownership moves through `POST
  // /api/bead/owner` and nowhere else, so a handle typed into the ✎ is dropped rather
  // than becoming a second owner nobody can see the provenance of.
  const edits = normalizeEdits({ labels: ['inbox', 'owner:bob@example.com'] });
  assert.deepEqual(edits.labels, ['inbox']);
});

/* ------------------------------------------------------------------ moving it */

await check('setting the owner a bead already has is no write at all', () => {
  const bead = { labels: ['owner:adam@example.com', 'inbox'] };
  assert.deepEqual(ownerUpdate(bead, 'adam@example.com'), { addLabels: [], removeLabels: [] });
  assert.deepEqual(ownerUpdate(bead, 'ADAM@example.com '), { addLabels: [], removeLabels: [] }, 'however it is typed');
});

await check('moving it takes every other owner off, not just the ones that disagree', () => {
  const contested = { labels: ['owner:adam@example.com', 'owner:bob@example.com', 'inbox'] };
  assert.deepEqual(ownerUpdate(contested, 'bob@example.com'), {
    addLabels: [],
    removeLabels: ['owner:adam@example.com'],
  });
  assert.deepEqual(ownerUpdate(contested, 'carol@example.com'), {
    addLabels: ['owner:carol@example.com'],
    removeLabels: ['owner:adam@example.com', 'owner:bob@example.com'],
  });
});

await check('and handing it back to nobody is a thing you may say', () => {
  const bead = { labels: ['owner:adam@example.com', 'inbox'] };
  assert.deepEqual(ownerUpdate(bead, ''), { addLabels: [], removeLabels: ['owner:adam@example.com'] });
  assert.deepEqual(ownerUpdate(bead, null), { addLabels: [], removeLabels: ['owner:adam@example.com'] });
  assert.deepEqual(ownerUpdate({ labels: ['inbox'] }, ''), { addLabels: [], removeLabels: [] }, 'twice over is no write');
});

/* ------------------------------------------------- the browser's copy of the prefix */

await check('public/graph.js reads the same prefix this module writes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'graph.js'), 'utf8');
  const m = src.match(/const OWNER_PREFIX = '([^']+)';/);
  assert.ok(m, 'public/graph.js no longer declares OWNER_PREFIX — the sheet has stopped reading owners');
  assert.equal(m[1], OWNER_PREFIX, 'the page and the daemon disagree about what an owner label looks like');
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
