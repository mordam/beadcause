#!/usr/bin/env node
/**
 * Save — a pass made with edit mode on becomes beads.
 *
 *     npm test
 *     node test/editsave.mjs
 *
 * public/editmode.js holds the conversation and test/editchanges.mjs covers it. This is
 * the far end: lib/edits.js turning that change list into the three-level shape Adam
 * asked for, against a `bd` that is a stub binary over a directory of JSON files — the
 * shape test/apperrors.mjs established, and for its reason: a stub that answered
 * everything whatever it was asked would pass whatever the code did.
 *
 * Four things are worth a suite, and three of them are about the ways this goes wrong
 * quietly.
 *
 * 1. **The shape, because it is the acceptance.** One session bead, N children, all of
 *    it under a standing P0 that exists — a bead with no P0 above it is not workable
 *    (bc-rfnr.7), so a pass filed without a root is a pass filed into a hole. And the
 *    session bead has to be an `epic`: a *task* with children is ordinary worker
 *    dispatch, and a worker's one sanctioned ending closes the bead it was opened on,
 *    which here would close the pass and orphan every edit under it.
 *
 * 2. **The root is found rather than recreated.** Every Save after the first has to land
 *    under the same container. The marker is what makes that safe — matching on a title
 *    is how two epics for one job appear the day somebody renames one — so the tests
 *    rename it, close it, and point the config at a bead that no longer exists.
 *
 * 3. **A child has to be workable cold.** No screen, no page, hours later: the anchor,
 *    the file and line, the note or the old and new string, and the filter that was on
 *    when it was said. A bead that says "make this bigger" is worth nothing.
 *
 * 4. **A failure keeps the pass.** The change list is the only copy of what was said. A
 *    tracker that dies half way through has to report exactly what it filed, because
 *    the phone drops those entries and keeps the rest — and a flat failure over three
 *    beads that exist would have them filed all over again.
 *
 * Nothing here reaches a real tracker or the network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-editsave-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const {
  EDIT_LABEL,
  EDIT_PRIORITY,
  ROOT_LABEL,
  ROOT_PRIORITY,
  ROOT_TITLE,
  SESSION_PRIORITY,
  acceptanceFor,
  beadsFor,
  bodyFor,
  filePass,
  labelsFor,
  normalizePass,
  rootFor,
  siteOf,
  titleFor,
} = await import(LIB('edits.js'));

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
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

console.log('\nedit mode — Save files the pass');

/* ------------------------------------------------------------------- the stub bd */

const BEADS = path.join(tmp, 'beads');
const FAIL_AFTER = path.join(tmp, 'fail-after');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * One file per bead, for test/apperrors.mjs's reason — no shared write, so nothing here
 * can look like a race that is really the fixture. `list` honours `--label` the way bd
 * does and hides closed beads unless asked, because `rootFor` leans on both.
 *
 * `fail-after` holds a number: the stub refuses every `create` past that many. That is
 * how the half-filed pass is staged, and it has to be a *file* rather than a flag on the
 * process because each `bd` call is a fresh one.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const DIR = ${JSON.stringify(BEADS)};
const file = (id) => path.join(DIR, id + '.json');
const read = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
const write = (i) => fs.writeFileSync(file(i.id), JSON.stringify(i, null, 2));
const all = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => read(path.basename(f, '.json'))).filter(Boolean);
const one = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (args[0] === 'list') {
  const need = many('--label');
  let rows = all();
  if (!args.includes('--all')) rows = rows.filter((i) => i.status !== 'closed');
  if (need.length) rows = rows.filter((i) => need.every((l) => (i.labels || []).includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'create') {
  let cap = null;
  try { cap = Number(fs.readFileSync(${JSON.stringify(FAIL_AFTER)}, 'utf8')); } catch { cap = null; }
  if (cap !== null && all().length >= cap) die('the tracker said no');
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
    parent: one('--parent') || '',
    created_at: new Date(Date.now() + all().length).toISOString(),
    comment_count: 0,
    comments: [],
    created_by: one('--actor') || '',
  });
  process.stdout.write(JSON.stringify({ id }));
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

const issues = () =>
  fs
    .readdirSync(BEADS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(BEADS, f), 'utf8')))
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
const bead = (id) => JSON.parse(fs.readFileSync(path.join(BEADS, `${id}.json`), 'utf8'));
const setBead = (i) => fs.writeFileSync(path.join(BEADS, `${i.id}.json`), JSON.stringify(i, null, 2));
const reset = ({ failAfter = null } = {}) => {
  fs.rmSync(BEADS, { recursive: true, force: true });
  fs.mkdirSync(BEADS, { recursive: true });
  fs.rmSync(FAIL_AFTER, { force: true });
  if (failAfter !== null) fs.writeFileSync(FAIL_AFTER, String(failAfter));
};
reset();

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const ws = { name: 'beadcause', dir: wsDir };
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause' });
const cfg = { me: ['adam@example.com'], edits: { workspace: null, root: null } };

/* ------------------------------------------------------------------ a real pass */

/** An anchor of the shape public/editmode.js actually produces. See `anchorFor`. */
const anchor = (over = {}) => ({
  page: '/',
  selector: 'div.card > button.card-act',
  chain: [{ sel: 'div.card' }, { sel: 'button.card-act' }],
  classes: ['card-act'],
  tag: 'button',
  key: 'beadcause/bc-1',
  text: { value: 'Show details', from: 'source', sites: [{ file: '/app.js', line: 3756 }], provider: 12 },
  source: {
    kind: 'class',
    query: 'class="card-act"',
    found: 1,
    sites: [{ file: '/app.js', line: 3756, at: 91240, text: '`<button class="card-act">Show details</button>`' }],
    tried: [{ kind: 'class', query: 'class="card-act"', found: 1 }],
  },
  editable: { ok: true, why: '' },
  resolved: true,
  ...over,
});

const CONTEXT = { view: 'the inbox', showing: 'what is waiting on you', space: 'work', kinds: 'questions' };

const PASS = {
  page: '/',
  view: 'the inbox',
  at: '2026-08-13T23:12:00Z',
  changes: [
    {
      id: 'e1',
      kind: 'retype',
      said: '“Show details” → “Show me”',
      anchor: anchor(),
      from: 'Show details',
      to: 'Show me',
      context: CONTEXT,
    },
    {
      id: 'e2',
      kind: 'describe',
      said: 'About “Show details”',
      anchor: anchor(),
      note: 'this should open the card, not a sheet',
      context: CONTEXT,
    },
    {
      id: 'e3',
      kind: 'point',
      said: '“Show details” above “The title”',
      anchor: anchor(),
      where: {
        rel: 'above',
        left: 'the card head',
        target: anchor({ text: { value: 'The title', from: 'data', sites: [], provider: 12 } }),
        said: '“Show details” above “The title”',
      },
      note: 'it belongs over the title, not under the buttons',
      context: CONTEXT,
    },
  ],
};

/* ============================================================== 1. what gets filed */

let first = null;
await check('one pass is one session bead, one child per change, all under a standing root', async () => {
  reset();
  first = await filePass(bd, ws, normalizePass(PASS), { cfg, actor: 'adam' });
  assert.equal(first.filed.length, 3, `filed ${first.filed.length}`);
  const root = bead(first.root.id);
  const session = bead(first.session.id);
  assert.equal(root.priority, ROOT_PRIORITY, 'the root is not a P0, so nothing under it is workable');
  assert.equal(session.parent, root.id, 'the pass is not under the root');
  for (const one of first.filed) assert.equal(bead(one.id).parent, session.id, `${one.id} is not under the pass`);
  assert.equal(issues().length, 5, 'a root, a pass and three edits');
});

await check('the pass is an epic, so a worker cannot be opened on it and close it', () => {
  // A *task* with children is ordinary worker dispatch (lib/advocate.js `batchesFor`),
  // and bin/deliver.js closes the bead it was given. That ending would close the pass.
  const session = bead(first.session.id);
  assert.equal(session.issue_type, 'epic', `the pass is a ${session.issue_type}`);
  assert.match(session.description, /not the work/i, 'nothing in the pass says it is a container');
  assert.match(session.title, /Edit pass on the inbox — 3 changes/);
});

await check('the priorities are the ones Adam asked for, and every bead is dispatchable', () => {
  assert.equal(bead(first.session.id).priority, SESSION_PRIORITY, 'the pass is not a P1');
  for (const one of first.filed) {
    const b = bead(one.id);
    assert.equal(b.priority, EDIT_PRIORITY, `${one.id} is a P${b.priority}`);
    // `advocates.minPriority` defaults to 3 — anything worse-ranked than that is never
    // dispatched, which would make "every one of them dispatchable" false.
    assert.ok(b.priority <= 3, `${one.id} is below the advocate's floor`);
  }
});

await check('nothing is held for endorsement — these are Adam’s own words, not a proposal', () => {
  for (const b of issues()) {
    assert.equal((b.labels || []).includes(UNENDORSED), false, `${b.id} is held for endorsement`);
    assert.equal((b.labels || []).includes(EDIT_LABEL), true, `${b.id} carries no provenance`);
    assert.equal((b.labels || []).includes('owner:adam@example.com'), true, `${b.id} is unowned`);
  }
});

await check('and an install that does not know who it is stamps no owner at all', () => {
  // `me` unset is the single-person default, and lib/ownership.js's guarantee is that
  // the whole mechanism is a branch that cannot be entered rather than a quiet default.
  assert.deepEqual(labelsFor({}), [EDIT_LABEL]);
  assert.deepEqual(labelsFor({ me: ['a@b.c'] }), [EDIT_LABEL, 'owner:a@b.c']);
});

/* ========================================================= 2. finding the root again */

await check('a second pass lands under the same root — it is found, not recreated', async () => {
  const second = await filePass(bd, ws, normalizePass(PASS), { cfg, actor: 'adam' });
  assert.equal(second.root.id, first.root.id, 'a second standing root');
  assert.equal(second.root.made, false);
  assert.equal(second.root.from, 'label');
  assert.equal(issues().filter((b) => (b.labels || []).includes(ROOT_LABEL)).length, 1);
});

await check('the root is found by its marker, not by its title', async () => {
  // A title match is how two containers for one job appear the day somebody renames one,
  // and this module would do it silently on every Save.
  const root = bead(first.root.id);
  assert.equal(root.title, ROOT_TITLE);
  setBead({ ...root, title: 'App improvements (renamed by hand)' });
  const found = await rootFor(bd, ws, cfg);
  assert.equal(found.id, root.id, 'renaming the root made a second one');
  assert.equal(found.made, false);
  setBead(root);
});

await check('a root named in the config wins, and a closed one is ignored rather than used', async () => {
  reset();
  const named = await rootFor(bd, ws, cfg); // makes one
  const withConfig = { ...cfg, edits: { root: named.id } };
  assert.equal((await rootFor(bd, ws, withConfig)).from, 'config');
  // Closed: a pass filed under it would be a pass nothing can reach.
  setBead({ ...bead(named.id), status: 'closed' });
  const after = await rootFor(bd, ws, withConfig);
  assert.notEqual(after.id, named.id, 'the pass was filed under a closed root');
  assert.equal(after.made, true, 'no root was made to replace the closed one');
  assert.equal(bead(after.id).issue_type, 'epic');
  assert.equal(bead(after.id).labels.includes(ROOT_LABEL), true, 'the new root carries no marker');
});

/* ==================================================== 3. what a child has to carry */

await check('a retype names the file and the line, and its acceptance is checkable', () => {
  const { edits } = beadsFor(normalizePass(PASS), { labels: [] });
  const one = edits[0];
  assert.equal(one.title, 'Retype “Show details” → “Show me” in app.js:3756');
  assert.match(one.body, /\*\*Was\*\* — “Show details”/);
  assert.match(one.body, /\*\*Should be\*\* — “Show me”/);
  assert.match(one.body, /app\.js:3756/);
  assert.match(one.acceptance, /app\.js:3756 reads “Show me”/);
});

await check('a describe carries the words, because the words are the whole of the edit', () => {
  const { edits } = beadsFor(normalizePass(PASS), { labels: [] });
  const one = edits[1];
  assert.match(one.title, /^“Show details”: this should open the card/);
  assert.match(one.body, /this should open the card, not a sheet/);
  assert.match(one.acceptance, /intent, not a string to paste in/);
});

await check('a point carries the relationship and refuses to carry pixels', () => {
  const { edits } = beadsFor(normalizePass(PASS), { labels: [] });
  const one = edits[2];
  assert.equal(one.title, 'Move “Show details” above “The title”');
  assert.match(one.body, /\*\*Relationship\*\* — above “The title”/);
  assert.match(one.body, /\*\*Out of\*\* — “the card head”/);
  assert.match(one.body, /56 pixels left/, 'nothing tells the agent not to chase geometry');
  assert.equal(/\bclientX\b|\bpageX\b|\d+px/.test(one.body), false, 'a position leaked into the bead');
});

await check('every child carries the anchor as JSON an agent can grep with', () => {
  for (const one of beadsFor(normalizePass(PASS), { labels: [] }).edits) {
    const block = one.body.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(block, 'no anchor record on the bead');
    const parsed = JSON.parse(block[1]);
    assert.equal(parsed.anchor.selector, 'div.card > button.card-act');
    assert.equal(parsed.anchor.source.sites[0].line, 3756, 'the one field the apply half needs is gone');
    assert.equal(parsed.anchor.text.from, 'source');
  }
});

await check('and where in the app it was said, which the anchor alone cannot say', () => {
  // The inbox is four filters deep and the element only exists under some of them.
  for (const one of beadsFor(normalizePass(PASS), { labels: [] }).edits) {
    assert.match(one.body, /\*\*Where in the app this was said\.\*\*/);
    assert.match(one.body, /\*\*showing\*\* — what is waiting on you/);
    assert.match(one.body, /\*\*kinds\*\* — questions/);
  }
  // And a pass made with nothing narrowed says nothing rather than saying "all".
  const bare = beadsFor(normalizePass({ ...PASS, changes: [{ ...PASS.changes[1], context: null }] }), { labels: [] });
  assert.equal(/Where in the app/.test(bare.edits[0].body), false);
});

await check('the pass itself lists what was said, in the order it was said', () => {
  const { session } = beadsFor(normalizePass(PASS), { labels: [] });
  const said = session.body.match(/^\d+\. \*\*(\w+)\*\*/gm).map((l) => l.split('**')[1]);
  assert.deepEqual(said, ['retype', 'describe', 'point']);
});

await check('a source search that found nothing says so rather than inventing a line', () => {
  const lost = anchor({ source: { kind: null, query: null, sites: [], found: 0, tried: [] } });
  assert.equal(siteOf(lost), '');
  const one = { kind: 'describe', note: 'move it', anchor: lost, said: 'About “x”' };
  assert.match(bodyFor(one, { surface: 'the inbox' }), /could not be traced to source/);
  assert.match(acceptanceFor({ ...one, kind: 'retype', to: 'y' }), /The one line of source that draws it/);
});

await check('an ambiguous search is reported as ambiguous, not narrowed by guessing', () => {
  const many = anchor({ source: { kind: 'class', query: '"q"', found: 3, sites: [{ file: '/app.js', line: 10 }], tried: [] } });
  assert.equal(siteOf(many), '');
  assert.match(bodyFor({ kind: 'describe', note: 'x', anchor: many }, { surface: '/' }), /3 sites — ambiguous/);
});

/* =========================================================== 4. nothing is lost */

await check('an empty pass files nothing at all', () => {
  const pass = normalizePass({ changes: [] });
  assert.equal(pass.changes.length, 0);
  assert.deepEqual(pass.dropped, []);
});

await check('a gesture with nothing said is dropped, and the drop is reported', () => {
  const pass = normalizePass({
    changes: [
      { id: 'e1', kind: 'point', anchor: anchor(), note: '   ' },
      { id: 'e2', kind: 'retype', anchor: anchor(), from: 'a', to: '' },
      { id: 'e3', kind: 'nonsense', note: 'hello' },
      { id: 'e4', kind: 'describe', anchor: anchor(), note: 'keep me' },
    ],
  });
  assert.equal(pass.changes.length, 1);
  assert.equal(pass.changes[0].id, 'e4');
  assert.equal(pass.dropped.length, 3, 'a change vanished without being reported');
  assert.match(pass.dropped[2].why, /not one of the three gestures/);
});

await check('a tracker that dies half way reports exactly what it filed', async () => {
  // The change list is the only copy of what was said. The phone drops the entries this
  // names and keeps the rest, so a flat failure over beads that exist files them twice.
  reset({ failAfter: 4 }); // the root, the pass, and two of the three edits
  let err = null;
  await filePass(bd, ws, normalizePass(PASS), { cfg }).catch((e) => (err = e));
  assert.ok(err, 'the failure was swallowed');
  assert.match(err.message, /filed 2 of 3/);
  assert.equal(err.partial.filed.length, 2);
  assert.deepEqual(
    err.partial.filed.map((f) => f.changeId),
    ['e1', 'e2']
  );
  assert.ok(err.partial.session.id, 'the pass bead that exists was not named');
});

await check('a title is a title, however long the words behind it were', () => {
  const long = 'x'.repeat(400);
  const one = { kind: 'describe', note: long, anchor: anchor({ text: { value: long, from: 'source' } }), said: '' };
  assert.ok(titleFor(one).length < 130, `${titleFor(one).length} characters of title`);
  assert.match(titleFor(one), /…/);
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall ${ran} good\n`);
process.exit(failures ? 1 : 0);
