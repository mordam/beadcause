#!/usr/bin/env node
/**
 * A bead the daemon files with no parent — where it lands, and why not there.
 *
 *     npm test
 *     node test/homing.mjs
 *
 * bc-rfnr.8, and the other half of test/underroot.mjs. That one asserts the rule; this
 * one asserts that the daemon stops filing beads that are born failing it.
 *
 * Eight properties, in the order they would break in:
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
 *    **Except where a caller says `unsorted: false`** (bc-arj0.5), which is the seam that
 *    keeps a daemon filing thirty self-closing beads a week out of the one pile whose
 *    contents are a question somebody has to answer. Asserted from both ends: the P0 is
 *    still found where there is one, and nothing else is substituted where there is not.
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
 *    one line: `hasRootAbove` over the tracker afterwards. Every other property here is a
 *    means to this one.
 * 7. **A seam that files one *kind* of bead names its own home, and it beats `from`**
 *    (bc-khoe.48). The rule in (1) is right for a discovery and wrong for a production
 *    line: which sessions evidenced a skill candidate is an accident of the hour, and
 *    following it put thirty-seven of them under twelve unrelated epics. Two halves are
 *    asserted, and the second is the one that makes the change safe to land — the named
 *    home wins over the root above `from`, and with **no root carrying the label the
 *    answer is byte-for-byte what it was**, so pointing a seam at a home nobody has
 *    raised yet does nothing at all. Reusing a label the work also carries is safe
 *    because only roots are looked at, and that is asserted against a P2 task carrying
 *    the identical label rather than argued.
 * 8. **A tracker that could not be read says so** (bc-0i27.17), and is not confused with
 *    a tracker that answered "nothing here". Both are `{ parent: '', gated: false }` and
 *    only one of them is a decision. Asserted through a real `Bd` over a `bd export`
 *    that exits non-zero, because that is where the lie was: `Bd.graph` does not throw,
 *    it hands back an empty index, so the unreadable tracker arrives wearing the exact
 *    shape `fileBeads` is told not to warn about. A stub with a throwing `graph` — the
 *    obvious test, and the one the bead asked for — passes against the broken code.
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

const { UNSORTED_LABEL, rootOver, unsortedRoot, rootLabelled, homeFor, homeIn } = await import(LIB('homing.js'));
const { indexFrom, PARENT_EDGE } = await import(LIB('ancestry.js'));
const { hasRootAbove } = await import(LIB('underroot.js'));
const { fileBeads } = await import(LIB('filing.js'));
const { Bd, forgetParents } = await import(LIB('bd.js'));
// The real string, not a copy — bc-mwhkg.2 pins homing.js's local literal against this
// so a rename on either side fails loudly here rather than silently reopening the bug.
const { ERROR_LABEL } = await import(LIB('errors.js'));

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

/** The label a seam names its own home by — `self-started-skills` in the live one. */
const HOME_LABEL = 'zz-programme';

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
  // bc-khoe.48: the epic a seam names as its own home, and — deliberately — a P2 task
  // carrying the identical label, because the real one does. Every skill candidate
  // carries `self-started-skills` as well as the epic that owns them, so a home found by
  // label is only safe while it looks at roots alone.
  row('zz-home', { priority: 0, labels: [HOME_LABEL] }),
  row('zz-home.1', { labels: [HOME_LABEL], dependencies: [parentEdge('zz-home.1', 'zz-home')] }),
  // bc-mwhkg.2: an app-error P0, filed automatically by lib/errors.js and closed the
  // moment the error stops — never a home for a discovery, however `rootOver` would
  // ordinarily answer it. One standing alone, and one with a root above it, so both
  // fallbacks (the next root up, and the backlog) are reachable.
  row('zz-apperror', { priority: 0, labels: [ERROR_LABEL] }),
  row('zz-apperror-nested', { priority: 0, labels: [ERROR_LABEL], dependencies: [parentEdge('zz-apperror-nested', 'zz-epic')] }),
];
const INDEX = indexFrom(LINES.join('\n'));

/* ------------------------------------------------------------- which P0 is above */

await check('a P0 is over itself, and over everything under it at any depth', () => {
  assert.equal(rootOver(INDEX, 'zz-epic'), 'zz-epic');
  assert.equal(rootOver(INDEX, 'zz-epic.1'), 'zz-epic');
  assert.equal(rootOver(INDEX, 'zz-epic.1.1'), 'zz-epic');
});

await check('and nothing is over a bead nothing decided, or over a closed P0’s child', () => {
  assert.equal(rootOver(INDEX, 'zz-loose'), null);
  assert.equal(rootOver(INDEX, 'zz-done.1'), null, 'a closed P0 is not a root, so it is not a home either');
  assert.equal(rootOver(INDEX, 'zz-never-heard-of-it'), null);
  assert.equal(rootOver(INDEX, ''), null);
});

/* --------------------------------------------------------------- the backlog P0 */

await check('the unsorted backlog is found by its label, and a closed one is not it', () => {
  assert.equal(unsortedRoot(INDEX), 'zz-pile');
  assert.equal(unsortedRoot(indexFrom(row('zz-done', { priority: 0, status: 'closed', labels: [UNSORTED_LABEL] }))), null);
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
  assert.equal(unsortedRoot(two), 'zz-also', 'sorted, so it is stable rather than export order');
  assert.equal(unsortedRoot(two), 'zz-also');
});

/* ------------------------------------------------- the home a seam names for itself */

await check('ROOTLABELLED FINDS THE OPEN ROOT CARRYING A LABEL, AND ONLY A ROOT', () => {
  // bc-khoe.48. The whole safety of reusing a label the *work* also carries is here:
  // `zz-home.1` is a P2 task with the identical label and must never be the answer, for
  // the same reason every child of the unsorted backlog inherits `unsorted` and is not
  // the pile.
  assert.equal(rootLabelled(INDEX, HOME_LABEL), 'zz-home');
  assert.equal(rootLabelled(INDEX, HOME_LABEL.toUpperCase()), 'zz-home', 'a label is matched case-insensitively');
  assert.equal(rootLabelled(INDEX, 'nobody-carries-this'), null);
  assert.equal(rootLabelled(INDEX, ''), null, 'no label named is not "find me any root"');
  assert.equal(rootLabelled(INDEX, '   '), null);
  assert.equal(rootLabelled(null, HOME_LABEL), null);
  const closed = indexFrom(row('zz-home', { priority: 0, status: 'closed', labels: [HOME_LABEL] }));
  assert.equal(rootLabelled(closed, HOME_LABEL), null, 'a closed epic is not a root, so it is not a home');
});

await check('and the backlog is now the same function, so the two cannot drift apart', () => {
  assert.equal(unsortedRoot(INDEX), rootLabelled(INDEX, UNSORTED_LABEL));
});

await check('A NAMED HOME BEATS THE ROOT THE DISCOVERY CAME FROM — bc-khoe.48', () => {
  // The point of the option. `from` is right for a one-off discovery and wrong for a
  // seam filing the same *kind* of bead every time: which work evidenced a skill
  // candidate is an accident of which sessions ended that hour, and following it put
  // thirty-seven candidates under twelve unrelated epics.
  const home = homeFor(INDEX, { from: 'zz-epic.1', homeLabel: HOME_LABEL });
  assert.equal(home.parent, 'zz-home');
  assert.notEqual(home.parent, 'zz-epic', 'the accident of who found it no longer decides');
  assert.match(home.why, /zz-home/);
  assert.match(home.why, new RegExp(HOME_LABEL), 'and says which label chose it');
});

await check('an explicit parent still beats a named home, and a named home beats the backlog', () => {
  assert.equal(homeFor(INDEX, { parent: 'zz-epic.1', homeLabel: HOME_LABEL }).parent, 'zz-epic.1');
  assert.equal(homeFor(INDEX, { homeLabel: HOME_LABEL }).parent, 'zz-home', 'no from at all, and it still lands home');
  assert.equal(homeFor(INDEX, { from: 'zz-loose', homeLabel: HOME_LABEL }).parent, 'zz-home');
  assert.equal(
    homeFor(INDEX, { from: 'zz-loose', homeLabel: HOME_LABEL, unsorted: false }).parent,
    'zz-home',
    'and `unsorted: false` refuses the pile, not the home'
  );
});

await check('POINTING A SEAM AT A HOME NOBODY HAS RAISED IS A NO-OP, NOT A PILE OF ORPHANS', () => {
  // The property that makes the change safe to land before the epic is labelled: with no
  // root carrying it, every answer is byte-for-byte the one the seam gave before.
  const before = homeFor(INDEX, { from: 'zz-epic.1' });
  assert.deepEqual(homeFor(INDEX, { from: 'zz-epic.1', homeLabel: 'not-raised-yet' }), before);
  assert.deepEqual(homeFor(INDEX, { from: 'zz-loose', homeLabel: 'not-raised-yet' }), homeFor(INDEX, { from: 'zz-loose' }));
  assert.deepEqual(homeFor(indexFrom(''), { homeLabel: HOME_LABEL }), { parent: '', why: '', gated: false, error: '' });
});

await check('a label is not an owner and not a priority — only an open P0 catches anything', () => {
  const not = indexFrom(
    [row('zz-task', { priority: 1, labels: [UNSORTED_LABEL] }), row('zz-two', { priority: 2, labels: [UNSORTED_LABEL] })].join('\n')
  );
  assert.equal(unsortedRoot(not), null);
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

await check('ROOTOVER(..., {includeSelf:false}) SKIPS THE BEAD ITSELF, EVEN A ROOT', () => {
  // The primitive the fix below is built on. The default is untouched — a root is still
  // above itself, which every other caller of `rootOver` relies on.
  assert.equal(rootOver(INDEX, 'zz-apperror'), 'zz-apperror', 'unchanged default: a root is over itself');
  assert.equal(rootOver(INDEX, 'zz-apperror', { includeSelf: false }), null, 'nothing above it once it is skipped');
  assert.equal(rootOver(INDEX, 'zz-apperror-nested', { includeSelf: false }), 'zz-epic', 'the next root up, once skipped');
  assert.equal(rootOver(INDEX, 'zz-epic', { includeSelf: false }), null, 'zz-epic has nothing above it either');
});

await check('AN APP-ERROR P0 IS NEVER ITS OWN HOME — bc-mwhkg.2', () => {
  // The whole bug: `rootOver` answers `from` itself whenever `from` is already a root,
  // which is right for an epic (property 1, above) and wrong for a P0 that lib/errors.js
  // closes the moment the fix ships, with no regard for what a session discovered while
  // reading it. Filing under it strands the child the instant it closes.
  const home = homeFor(INDEX, { from: 'zz-apperror' });
  assert.notEqual(home.parent, 'zz-apperror', 'it closes as soon as the error stops — never a home');
  assert.equal(home.parent, 'zz-pile', 'nothing else above it, so the backlog catches it, same as any orphan `from`');
  assert.match(home.why, /zz-pile/);
});

await check('and one with a root above it falls through to that root, not the backlog', () => {
  const home = homeFor(INDEX, { from: 'zz-apperror-nested' });
  assert.equal(home.parent, 'zz-epic');
  assert.notEqual(home.parent, 'zz-apperror-nested');
  assert.match(home.why, /zz-epic/);
});

await check('AND AN ORDINARY EPIC IS UNAFFECTED — STILL ITS OWN HOME, EXACTLY AS BEFORE', () => {
  // The property that makes this safe to land: nothing here changes unless `from` itself
  // carries `app-error`. An epic — the case property 1 already pins — is untouched.
  assert.equal(homeFor(INDEX, { from: 'zz-epic' }).parent, 'zz-epic');
});

await check('the label is pinned to lib/errors.js’s own ERROR_LABEL, not a copy that can drift', () => {
  // Imported for real at the top of this file rather than typed as 'app-error' again —
  // a rename in either lib/errors.js or lib/homing.js's local literal fails right here.
  const one = indexFrom(row('zz-e', { priority: 0, labels: [ERROR_LABEL] }));
  const home = homeFor(one, { from: 'zz-e' });
  assert.notEqual(home.parent, 'zz-e');
  assert.equal(home.parent, '', 'no unsorted pile in this tiny tracker, so nothing to fall to');
});

await check('UNSORTED: FALSE REFUSES THE BACKLOG AND KEEPS THE P0 — lib/release.js', () => {
  // A caller filing on a schedule, over beads that close themselves and that nothing
  // will ever open a session on, is not asking "which P0 does this belong to" thirty
  // times a week — it is burying the beads that are. What it must not lose is the other
  // half: where the P0 *is* knowable it is still the home, and only the fallback goes.
  assert.equal(homeFor(INDEX, { from: 'zz-epic.1', unsorted: false }).parent, 'zz-epic');
  assert.equal(homeFor(INDEX, { from: 'zz-loose', unsorted: false }).parent, '');
  assert.equal(homeFor(INDEX, { unsorted: false }).parent, '');
  assert.equal(homeFor(INDEX, { from: 'zz-loose', unsorted: false }).why, '', 'and it does not explain a home it did not give');
  assert.equal(homeFor(INDEX, { from: 'zz-loose', unsorted: false }).gated, true, '`gated` is about the graph, not about this');
  assert.equal(homeFor(INDEX, { parent: 'zz-pile', unsorted: false }).parent, 'zz-pile', 'a named parent still wins outright');
});

await check('and the same through homeIn, so a caller with only a tracker gets it too', async () => {
  const bd = { graph: async () => INDEX };
  assert.equal((await homeIn(bd, { name: 'zz' }, { from: 'zz-epic.1.1', unsorted: false })).parent, 'zz-epic');
  assert.equal((await homeIn(bd, { name: 'zz' }, { from: 'zz-loose', unsorted: false })).parent, '');
  assert.equal((await homeIn(bd, { name: 'zz' }, { from: 'zz-loose' })).parent, 'zz-pile', 'the default is unchanged');
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
  assert.deepEqual(homeFor(bare, { from: 'zz-loose' }), { parent: '', why: '', gated: true, error: '' });
  assert.deepEqual(homeFor(indexFrom(''), { from: 'zz-loose' }), { parent: '', why: '', gated: false, error: '' });
  assert.deepEqual(await homeIn(null, { name: 'zz' }, { from: 'zz-loose' }), { parent: '', why: '', gated: false, error: '' });
  assert.deepEqual(
    await homeIn(
      { graph: async () => { throw new Error('database is locked'); } },
      { name: 'zz' },
      { onWarn: () => {} }
    ),
    { parent: '', why: '', gated: false, error: 'database is locked' }
  );
});

await check('AN EXPORT THAT FAILED IS NOT "NOWHERE TO PUT IT" — IT SAYS SO, AND SAYS WHY', async () => {
  // bc-0i27.17. Both answers are `{ parent: '', gated: false }` and only one of them is
  // a decision: a workspace with no P0 is one where a parentless bead is workable, and a
  // workspace we could not read may have twenty. Before `error` the caller could not
  // tell, so the one case where a warning was genuinely owed — there ARE P0s, we simply
  // could not see them — was exactly the case that printed nothing.
  const said = [];
  const thrown = await homeIn(
    { graph: async () => { throw new Error('bd export: context deadline exceeded\nat Bd.graph'); } },
    { name: 'zz' },
    { from: 'zz-loose', onWarn: (m) => said.push(m) }
  );
  assert.equal(thrown.parent, '', 'still fail-open — the discovery is never lost over this');
  assert.equal(thrown.gated, false);
  assert.equal(thrown.error, 'bd export: context deadline exceeded', 'the first line, and no stack');
  assert.equal(said.length, 1, 'said once, not per bead and not never');
  assert.match(said[0], /could not read zz/, 'and names the workspace it could not read');
  assert.match(said[0], /context deadline exceeded/, 'and what actually happened');
  assert.match(said[0], /no parent/);

  // The other side of the same boolean, and the reason `error` had to be a third state
  // rather than making `gated` true: a tracker that answered "there are no P0s here" is
  // silent, exactly as before, because a warning there would be a lie at every filing.
  const quiet = [];
  const bd = { graph: async () => indexFrom([row('zz-a'), row('zz-b')].join('\n')) };
  const answered = await homeIn(bd, { name: 'zz' }, { from: 'zz-a', onWarn: (m) => quiet.push(m) });
  assert.deepEqual(answered, { parent: '', why: '', gated: false, error: '' });
  assert.deepEqual(quiet, [], 'nothing failed, so nothing is said');

  // And a caller that has no tracker at all never asked, so there is nothing to report.
  const none = [];
  assert.equal((await homeIn(null, { name: 'zz' }, { onWarn: (m) => none.push(m) })).error, '');
  assert.deepEqual(none, []);

  // The carrier itself: `homeFor` reads the stamp lib/bd.js puts on the index it invents
  // when it could not read one, and hands it out of every arm — including the arms that
  // found a home, because a stale-or-invented index that happened to answer is still a
  // fact the caller may want. A real reading never carries it.
  const stamped = Object.assign(indexFrom(''), { error: 'bd export failed in zz: no such database' });
  assert.equal(homeFor(stamped, { from: 'zz-loose' }).error, 'bd export failed in zz: no such database');
  assert.equal(homeFor(stamped, { from: 'zz-loose' }).parent, '', 'an index with nothing in it houses nothing');
  assert.equal(homeFor(INDEX, { from: 'zz-epic.1.1' }).error, '', 'and a tracker that answered says nothing');
});

await check('A WORKSPACE WITH NO P0 AT ALL IS NOT GATED, AND MUST NOT BE WARNED ABOUT', () => {
  // `hasRootAbove` fails open with no roots — a tracker nobody has raised a P0 in works
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

if (args[0] === 'export') {
  // The failure this whole file is about: a loaded Dolt that will not answer.
  if (w.failExport) { process.stderr.write(w.failExport + '\\n'); process.exit(1); }
  process.stdout.write(w.lines.join('\\n')); process.exit(0);
}
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
  assert.equal(hasRootAbove(world(), filed), true);
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

await check('FILEBEADS HANDS HOMELABEL THROUGH, AND `--parent` REALLY REACHES BD — bc-khoe.48', async () => {
  // Asserted through the real seam over the real argv rather than against `homeFor`,
  // for the reason property 5 of this file gives: a unit test of the decision passes
  // just as happily against a `fileBeads` that never passes the option on. Both halves
  // matter — the bead lands under the named home, and the `discovered-from` trail back
  // to the session that evidenced it survives, because that is what the parent link
  // never was.
  forgetParents();
  const res = await fileBeads(bd, ws, [{ title: 'b7e-something — filed by the audit' }], {
    from: 'zz-epic.1',
    homeLabel: HOME_LABEL,
  });
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.equal(res.home.parent, 'zz-home');
  assert.notEqual(res.home.parent, 'zz-epic', 'not the epic that happened to evidence it');
  assert.equal(world().parents.get(res.filed[0].id), 'zz-home');
  const filed = JSON.parse(fs.readFileSync(WORLD, 'utf8')).lines.map(JSON.parse).find((r) => r.id === res.filed[0].id);
  assert.ok(
    (filed.dependencies || []).some((d) => d.type === 'discovered-from' && d.depends_on_id === 'zz-epic.1'),
    'the provenance edge back to the evidencing work is untouched'
  );
});

await check('and with the home unraised it files exactly where it filed before', async () => {
  forgetParents();
  const res = await fileBeads(bd, ws, [{ title: 'b7e-else — before the epic was labelled' }], {
    from: 'zz-epic.1',
    homeLabel: 'not-raised-yet',
  });
  assert.equal(res.home.parent, 'zz-epic', 'the old rule, unchanged, which is what makes this safe to land first');
});

await check('FILEBEADS DOES NOT PARENT A DISCOVERY UNDER THE APP-ERROR P0 THAT FOUND IT — bc-mwhkg.2', async () => {
  // Asserted through the real seam and the real argv, not against `homeFor` alone, for
  // property 5's reason: a unit test of the decision passes just as happily against a
  // `fileBeads` that never called it. bc-mwhkg is exactly this shape — its own children
  // landed parented to it and were stranded the moment it closed.
  forgetParents();
  const res = await fileBeads(bd, ws, [{ title: 'discovered while working the crash' }], { from: 'zz-apperror' });
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.equal(res.home.parent, 'zz-pile', 'falls through to the unsorted backlog, not the P0 that will close first');
  assert.notEqual(res.home.parent, 'zz-apperror');
  assert.equal(world().parents.get(res.filed[0].id), 'zz-pile', 'and `--parent` really carried the backlog, not the P0');

  // The acceptance criterion itself: closing the P0 that discovered it — exactly what
  // happens to an app-error bead the moment its fix ships — must not strand the child.
  const afterClose = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
  afterClose.lines = afterClose.lines.map((l) => {
    const r = JSON.parse(l);
    return JSON.stringify(r.id === 'zz-apperror' ? { ...r, status: 'closed' } : r);
  });
  fs.writeFileSync(WORLD, JSON.stringify(afterClose, null, 2));
  assert.equal(hasRootAbove(world(), res.filed[0].id), true, 'still workable after the P0 that discovered it closes');
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

await check('AN EXPORT THAT FAILED IS SAID OUT LOUD, THROUGH THE REAL BD — bc-0i27.17', async () => {
  // The one that was missing, and the reason the bug survived the `catch` in `homeIn`:
  // `Bd.graph` does not throw. It logs, invents an empty index and returns it, so the
  // tracker that could not be read arrives as a tracker with no P0s in it — the one
  // shape `fileBeads` is specifically instructed not to warn about. Two of three beads
  // filed minutes apart landed parentless, unworkable and off the inbox, and the command
  // reported success. Driven through a real `Bd` over a real `bd export` because that is
  // the seam that was lying; a stub with a throwing `graph` would have passed all along.
  forgetParents();
  fs.writeFileSync(
    WORLD,
    JSON.stringify({
      lines: [row('zz-epic', { priority: 0 }), row('zz-loose')],
      failExport: 'error: cannot acquire lock on database zz',
    })
  );
  const warnings = [];
  const res = await fileBeads(bd, ws, [{ title: 'filed into the dark' }], {
    from: 'zz-loose',
    onWarn: (w) => warnings.push(w),
  });
  assert.equal(res.filed.length, 1, 'still fail-open — the discovery is never lost over this');
  assert.equal(res.filed[0].parent, null);
  assert.equal(res.home.parent, '');
  assert.equal(res.home.gated, false, 'and `gated` is untouched: we do not know that it is held');
  assert.match(res.home.error, /cannot acquire lock/, 'but we do know why we cannot say');
  const said = warnings.join('\n');
  assert.match(said, /could not read zz/, 'the workspace it could not read');
  assert.match(said, /cannot acquire lock/, 'and what actually happened, not a shrug');
  assert.match(said, /no parent/, 'and the consequence, on the session own stderr');
  forgetParents();
});

/* ------------------------------------------------------------------------ done */

cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
