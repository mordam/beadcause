#!/usr/bin/env node
/**
 * A bead the daemon files with no parent — where it lands, and why not there.
 *
 *     npm test
 *     node test/homing.mjs
 *
 * bc-rfnr.8, and the other half of test/underp0.mjs. That one asserts the rule; this
 * one asserts that the daemon stops filing beads that are born failing it.
 *
 * Six properties, in the order they would break in:
 *
 * 1. **The home is the P0 the discovering bead is under — never the discovering bead.**
 *    The tempting version parents each discovery under whatever found it, which reads
 *    fine and manufactures, on a schedule, the exact shape bc-rfnr.7's comment names as
 *    the recurring failure: an open child of a non-P0 parent that has since closed. The
 *    assertion is written the wrong way round on purpose — it checks the parent is *not*
 *    `from` — because a change that "simplifies" this is the one that would pass a test
 *    asserting only that some parent was set.
 * 2. **The unsorted backlog catches what nothing discovered.** Found by a label on an
 *    open P0, not by an id in config: the graph is shared and config.json is per-Mac.
 * 3. **A closed P0 is not a home**, for the same reason it is not a root — the two must
 *    agree or a bead lands under something the phone does not draw.
 * 4. **Nothing is refused.** No `from`, no unsorted P0, no `bd`, an export that threw:
 *    the answer is the parentless bead that would have been filed before this existed.
 *    A filing seam that failed closed would turn a Dolt lock race into a lost discovery,
 *    which is worse than the hold it is avoiding.
 * 5. **`fileBeads` actually asks.** Asserted against a real `fileBeads` over a real
 *    `Bd.create`, not reasoned about — a unit test of `homeFor` would pass just as
 *    happily against a filing path that never called it.
 * 6. **And the bead it files is workable.** The acceptance criterion itself, asserted as
 *    one line: `hasP0Above` over the tracker afterwards. Every other property here is a
 *    means to this one.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-homing-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { UNSORTED_LABEL, p0Over, unsortedP0, homeFor, homeIn } = await import(LIB('homing.js'));
const { indexFrom, PARENT_EDGE } = await import(LIB('ancestry.js'));
const { hasP0Above } = await import(LIB('underp0.js'));
const { fileBeads } = await import(LIB('filing.js'));
const { Bd, forgetParents } = await import(LIB('bd.js'));

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nwhere a bead nobody gave a parent lands\n');

const row = (id, extra = {}) =>
  JSON.stringify({ id, title: `bead ${id}`, status: 'open', priority: 2, labels: [], dependencies: [], ...extra });
const parentEdge = (child, parent) => ({ issue_id: child, depends_on_id: parent, type: PARENT_EDGE });

/**
 * A tracker with a themed P0 and two levels under it, an unsorted-backlog P0, a P0 that
 * has closed over an open child, and a bead nothing has ever decided.
 */
const LINES = [
  row('zz-epic', { priority: 0, labels: ['owner:adam@example.com'] }),
  row('zz-epic.1', { dependencies: [parentEdge('zz-epic.1', 'zz-epic')] }),
  row('zz-epic.1.1', { dependencies: [parentEdge('zz-epic.1.1', 'zz-epic.1')] }),
  row('zz-pile', { priority: 0, labels: ['owner:adam@example.com', UNSORTED_LABEL] }),
  row('zz-done', { priority: 0, status: 'closed', labels: [UNSORTED_LABEL] }),
  row('zz-done.1', { dependencies: [parentEdge('zz-done.1', 'zz-done')] }),
  row('zz-loose'),
];
const INDEX = indexFrom(LINES.join('\n'));

/* ------------------------------------------------------------- which P0 is above */

await check('a P0 is over itself, and over everything under it at any depth', () => {
  assert.equal(p0Over(INDEX, 'zz-epic'), 'zz-epic');
  assert.equal(p0Over(INDEX, 'zz-epic.1'), 'zz-epic');
  assert.equal(p0Over(INDEX, 'zz-epic.1.1'), 'zz-epic');
});

await check('and nothing is over a bead nothing decided, or over a closed P0’s child', () => {
  assert.equal(p0Over(INDEX, 'zz-loose'), null);
  assert.equal(p0Over(INDEX, 'zz-done.1'), null, 'a closed P0 is not a root, so it is not a home either');
  assert.equal(p0Over(INDEX, 'zz-never-heard-of-it'), null);
  assert.equal(p0Over(INDEX, ''), null);
});

/* --------------------------------------------------------------- the backlog P0 */

await check('the unsorted backlog is found by its label, and a closed one is not it', () => {
  assert.equal(unsortedP0(INDEX), 'zz-pile');
  assert.equal(unsortedP0(indexFrom(row('zz-done', { priority: 0, status: 'closed', labels: [UNSORTED_LABEL] }))), null);
});

await check('two of them is a duplicate you can find, not two daemons filing into different piles', () => {
  // Labels are rows on a graph several machines write to (lib/ownership.js makes the same
  // argument for `owner:`), so a second one can exist without anybody deciding anything.
  // Every machine has to pick the *same* one until somebody takes the label off.
  const two = indexFrom(
    [
      row('zz-pile', { priority: 0, labels: [UNSORTED_LABEL] }),
      row('zz-also', { priority: 0, labels: ['Unsorted'] }),
    ].join('\n')
  );
  assert.equal(unsortedP0(two), 'zz-also', 'sorted, so it is stable rather than export order');
  assert.equal(unsortedP0(two), 'zz-also');
});

await check('a label is not an owner and not a priority — only an open P0 catches anything', () => {
  const not = indexFrom(
    [row('zz-task', { priority: 1, labels: [UNSORTED_LABEL] }), row('zz-two', { priority: 2, labels: [UNSORTED_LABEL] })].join('\n')
  );
  assert.equal(unsortedP0(not), null);
});

/* ---------------------------------------------------------------- the whole rule */

await check('THE HOME IS THE P0 THE DISCOVERY CAME FROM — NOT THE BEAD THAT FOUND IT', () => {
  const home = homeFor(INDEX, { from: 'zz-epic.1' });
  assert.equal(home.parent, 'zz-epic');
  assert.notEqual(home.parent, 'zz-epic.1', 'a task closes, and its open child is then held forever — bc-rfnr.7');
  assert.match(home.why, /zz-epic/);
});

await check('a from with nothing above it falls through to the backlog', () => {
  assert.equal(homeFor(INDEX, { from: 'zz-loose' }).parent, 'zz-pile');
  assert.equal(homeFor(INDEX, { from: 'zz-done.1' }).parent, 'zz-pile');
  assert.equal(homeFor(INDEX, {}).parent, 'zz-pile');
});

await check('a parent the caller named wins, and is not explained', () => {
  const home = homeFor(INDEX, { parent: 'zz-epic.1', from: 'zz-epic.1.1' });
  assert.equal(home.parent, 'zz-epic.1');
  assert.equal(home.why, '', 'nothing chose for them, so the bead has nothing to account for');
});

await check('NOTHING IS REFUSED — no backlog, no graph, no bd', async () => {
  // The bead that would have been filed before this existed. A filing seam that failed
  // closed would lose a discovery over a Dolt lock race, which is worse than the hold.
  const bare = indexFrom([row('zz-epic', { priority: 0 }), row('zz-loose')].join('\n'));
  assert.deepEqual(homeFor(bare, { from: 'zz-loose' }), { parent: '', why: '', gated: true });
  assert.deepEqual(homeFor(indexFrom(''), { from: 'zz-loose' }), { parent: '', why: '', gated: false });
  assert.deepEqual(await homeIn(null, { name: 'zz' }, { from: 'zz-loose' }), { parent: '', why: '', gated: false });
  assert.deepEqual(
    await homeIn({ graph: async () => { throw new Error('database is locked'); } }, { name: 'zz' }, {}),
    { parent: '', why: '', gated: false }
  );
});

await check('A WORKSPACE WITH NO P0 AT ALL IS NOT GATED, AND MUST NOT BE WARNED ABOUT', () => {
  // `hasP0Above` fails open with no roots — a tracker nobody has raised a P0 in works
  // exactly as it did before the gate existed. A parentless bead there is not held, so a
  // caller printing "nothing will work this until you adopt it" would be lying at every
  // single filing. `gated` is the difference, and it is the whole of why it exists.
  const none = indexFrom([row('zz-a'), row('zz-b')].join('\n'));
  assert.equal(homeFor(none, { from: 'zz-a' }).gated, false);
  assert.equal(homeFor(INDEX, { from: 'zz-loose' }).gated, true);
});

await check('and a named parent is taken without reading the tracker at all', async () => {
  const bd = { graph: async () => { throw new Error('this must not be called'); } };
  assert.equal((await homeIn(bd, { name: 'zz' }, { parent: 'zz-epic' })).parent, 'zz-epic');
});

/* ----------------------------------------------------- the seam, over a real bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(WORLD, JSON.stringify({ lines: LINES }, null, 2));

/**
 * A `bd` with the two commands this seam uses: `export`, which is where the shape comes
 * from, and `create`, which is where `--parent` has to actually appear. The argv is the
 * thing under test — a stub taking a JSON blob would prove nothing about the flags
 * `Bd.create` builds, and `--parent` is exactly the flag that goes missing.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const one = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(args[i + 1]); return out.filter(Boolean); };

if (args[0] === 'export') { process.stdout.write(w.lines.join('\\n')); process.exit(0); }
if (args[0] === 'show') {
  const row = w.lines.map(JSON.parse).find((r) => r.id === args[1]);
  if (!row) { process.stderr.write('error: no issue found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify([row])); process.exit(0);
}
if (args[0] === 'create') {
  const id = 'zz-new' + (w.lines.length + 1);
  const parent = one('--parent', '');
  // bd's own hierarchy rules are bd's; this stands in for any of them. A P0 that is a
  // crash \`bug\` rather than an epic is the realistic one — see lib/filing.js.
  if (parent === 'zz-crash') { process.stderr.write('Error: bugs cannot have children\\n'); process.exit(1); }
  const deps = many('--deps').map((d) => ({
    issue_id: id,
    depends_on_id: d.includes(':') ? d.slice(d.indexOf(':') + 1) : d,
    type: d.includes(':') ? d.slice(0, d.indexOf(':')) : 'blocks',
  }));
  if (parent) deps.push({ issue_id: id, depends_on_id: parent, type: 'parent-child' });
  w.lines.push(JSON.stringify({
    id, title: one('--title', ''), status: 'open', priority: Number(one('--priority', '2')),
    notes: one('--notes', ''), labels: many('--label'), dependencies: deps,
  }));
  fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
  process.stdout.write(JSON.stringify({ id })); process.exit(0);
}
process.stderr.write('unsupported: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);

const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
const ws = { name: 'zz', dir: tmp };
const world = () => indexFrom(JSON.parse(fs.readFileSync(WORLD, 'utf8')).lines.join('\n'));
const last = () => [...world().beads.keys()].filter((id) => id.startsWith('zz-new')).pop();

await check('FILEBEADS PUTS THE BEAD UNDER THE P0 THE WORK THAT FOUND IT IS UNDER', async () => {
  forgetParents();
  const res = await fileBeads(bd, ws, [{ title: 'a thing I tripped over' }], { from: 'zz-epic.1' });
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.equal(res.home.parent, 'zz-epic');
  assert.equal(res.filed[0].parent, 'zz-epic');
  assert.equal(world().parents.get(res.filed[0].id), 'zz-epic', 'and `--parent` really reached bd');
});

await check('AND THE BEAD IT FILED IS WORKABLE — the acceptance criterion, in one line', () => {
  const filed = last();
  assert.ok(filed, 'something was filed');
  assert.equal(hasP0Above(world(), filed), true);
});

await check('the bead says who chose the home, so moving it is not correcting a mistake', () => {
  const filed = world().beads.get(last());
  const notes = JSON.parse(fs.readFileSync(WORLD, 'utf8')).lines.map(JSON.parse).find((r) => r.id === filed.id).notes;
  assert.match(notes, /Filed under zz-epic/);
  assert.match(notes, /Move it if it belongs somewhere better/);
});

await check('nothing discovered it → the backlog, and the session is warned rather than left guessing', async () => {
  forgetParents();
  const warnings = [];
  const res = await fileBeads(bd, ws, [{ title: 'unprompted' }], { onWarn: (w) => warnings.push(w) });
  assert.equal(res.home.parent, 'zz-pile');
  assert.deepEqual(warnings, [], 'a home was found, so there is nothing to warn about');
  assert.equal(world().parents.get(res.filed[0].id), 'zz-pile');
});

await check('A PARENT BD REFUSES COSTS THE PARENT, NEVER THE BEAD', async () => {
  // The one field this may drop. bd's hierarchy is bd's — a P0 that is a crash `bug` is
  // dispatchable directly (bc-rfnr.4), so a session really can be working under one, and
  // losing the discovery over a parent nothing here chose is the wrong way round.
  forgetParents();
  fs.writeFileSync(
    WORLD,
    JSON.stringify({ lines: [row('zz-crash', { priority: 0, issue_type: 'bug' }), row('zz-loose')] }, null, 2)
  );
  const warnings = [];
  const res = await fileBeads(bd, ws, [{ title: 'found under a crash' }], {
    from: 'zz-crash',
    onWarn: (w) => warnings.push(w),
  });
  assert.equal(res.filed.length, 1, 'the bead survives');
  assert.equal(res.filed[0].parent, null, 'without the parent bd would not take');
  assert.match(warnings.join('\n'), /would not take .* under zz-crash/);
  const notes = JSON.parse(fs.readFileSync(WORLD, 'utf8')).lines.map(JSON.parse).find((r) => r.id === res.filed[0].id).notes;
  assert.doesNotMatch(notes, /Filed under/, 'and it does not claim a home it did not get');
});

await check('a tracker with nowhere to put it files the bead anyway, and says so', async () => {
  forgetParents();
  // A P0 in it, so the gate is live and the warning is true — see `gated` above.
  fs.writeFileSync(WORLD, JSON.stringify({ lines: [row('zz-epic', { priority: 0 }), row('zz-loose')] }, null, 2));
  const warnings = [];
  const res = await fileBeads(bd, ws, [{ title: 'homeless' }], { onWarn: (w) => warnings.push(w) });
  assert.equal(res.filed.length, 1, 'the discovery is never lost over the filing');
  assert.equal(res.home.parent, '');
  assert.equal(res.filed[0].parent, null);
  assert.match(warnings.join('\n'), /no parent/);
  assert.match(warnings.join('\n'), new RegExp(UNSORTED_LABEL), 'and names the fix, since nothing clears this on its own');
});

/* ------------------------------------------------------------------------ done */

cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
