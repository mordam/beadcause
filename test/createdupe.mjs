#!/usr/bin/env node
/**
 * A duplicate is caught at `bd create`, not only when a proposal is reviewed.
 *
 *     npm test
 *     node test/createdupe.mjs
 *
 * bc-arj0.6. lib/dupe.js was good and ran in one place: the **proposal** path, because
 * that is where the pair it was built from collided (bc-j6x and bc-ec6, byte-identical
 * titles, both approved, one worker window wasted). The duplicates that kept arriving
 * afterwards were not proposals. bc-297u/bc-syzm (`.chip` declared twice),
 * bc-767a/bc-giuc (the missing disarm) and bc-zjep/bc-zflo (the `/api/error` write) were
 * each filed by a worker mid-session, hours apart, and nothing joined them up until an
 * advocate pass read the titles by hand. At epic scale bc-xpwh was a verbatim copy of
 * bc-nib3 and it took a bead of its own to notice.
 *
 * So the check moved to the seam all of them actually went through — `Bd.create`, which
 * every bead beadcause files is born in — and the open question the bead left ("refuse,
 * or file and link") is answered **link**: refusing would lose work a session had
 * genuinely found, and at 0.9 title similarity a resemblance is not proof.
 *
 * Five things are worth a suite, and only the first is visible by reading one function:
 *
 * 1. **The pure halves.** `openRows` takes the graph index — the cheap, already-warm
 *    read — down to live rows, and `resemblanceNote` names the twin *by id*, because
 *    that id in the prose is the entire mechanism by which the edge gets drawn.
 * 2. **The edge is really drawn**, through the real `Bd` against a fake `bd` binary. A
 *    note saying "looks like bc-1" with no `bd dep relate` behind it would be exactly
 *    the state bc-arj0.4 was filed about: 1,633 references in prose and two edges.
 * 3. **Nothing is said twice.** lib/filing.js writes its own duplicate sentence and
 *    lib/server.js's approval refuses outright; a second paragraph from underneath them
 *    would be this seam talking over callers with more context than it has.
 * 4. **A question is not checked.** The sweep card, the stranded-branch finding and the
 *    merge card have formulaic titles by construction and each module already refuses to
 *    file its own twin — a resemblance paragraph on an inbox card is noise on the one
 *    surface where noise costs most.
 * 5. **It is a courtesy and can never fail the create.** A tracker that could not be read
 *    is the state every bead was filed in before this existed; losing a discovery over a
 *    see-also would be the wrong trade in the direction lib/filing.js already refuses.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-createdupe-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { openRows, resemblanceNote, LIVE_STATUSES } = await import(LIB('dupe.js'));
const { dupeNote } = await import(LIB('proposal.js'));
const { Bd, forgetParents, forgetTitles } = await import(LIB('bd.js'));

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
};
const acheck = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
};

console.log('a duplicate is caught at bd create');

/* ------------------------------------------------------------------- pure halves */

const index = (rows) => ({ parents: new Map(), beads: new Map(rows.map((r) => [r.id, r])) });

check('openRows keeps what somebody could still collide with, and drops what they could not', () => {
  const rows = openRows(
    index([
      { id: 'bc-1', title: 'Open one', status: 'open', labels: ['x'] },
      { id: 'bc-2', title: 'Being worked', status: 'in_progress', labels: [] },
      { id: 'bc-3', title: 'Waiting', status: 'blocked', labels: [] },
      { id: 'bc-4', title: 'Landed last week', status: 'closed', labels: [] },
      // A row with no title says nothing about anything and would score 0 anyway; it is
      // dropped so `findDuplicate` never has to reason about the empty set.
      { id: 'bc-5', title: '', status: 'open', labels: [] },
    ])
  );
  assert.deepEqual(rows.map((r) => r.id), ['bc-1', 'bc-2', 'bc-3']);
  // Labels survive, because `liveCandidates` reads them to tell a proposal question from
  // a bead — the one row whose own title must never be matched against.
  assert.deepEqual(rows[0].labels, ['x']);
  assert.equal(LIVE_STATUSES.has('closed'), false);
});

check('an index that could not be built is an empty list, not an exception', () => {
  // What `Bd.graph` hands back when the export failed: the shape is right, the map is
  // empty, and `error` is stamped on it. A throw here would be a lost bead.
  assert.deepEqual(openRows({ parents: new Map(), beads: new Map(), error: 'timed out' }), []);
  assert.deepEqual(openRows(null), []);
  assert.deepEqual(openRows({}), []);
});

check('the note names the twin by id, which is what draws the edge', () => {
  const note = resemblanceNote(dupeNote({ id: 'bc-297u', title: '.chip is declared twice', status: 'open' }));
  // Not decoration: `relateMentions` scans this prose for bead ids, so an id dropped
  // from the sentence is an edge that silently stops being drawn.
  assert.match(note, /bc-297u/);
  assert.match(note, /Looks like a duplicate/);
  // And it says which way the call went, because "filed anyway" is the surprising half.
  assert.match(note, /rather than refused/);
});

/* -------------------------------------------- the real Bd against a fake bd binary */

const CALLS = path.join(tmp, 'calls.log');
const ROWS = path.join(tmp, 'rows.jsonl');
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
if (args[0] === 'export') {
  if (!fs.existsSync(${JSON.stringify(ROWS)})) { process.stderr.write('no such workspace'); process.exit(1); }
  process.stdout.write(fs.readFileSync(${JSON.stringify(ROWS)}, 'utf8'));
  process.exit(0);
}
if (args[0] === 'create') {
  // A new id each time: two creates in one run must be two beads, or the second could
  // never be a duplicate of the first.
  const n = fs.existsSync(${JSON.stringify(path.join(tmp, 'seq'))})
    ? Number(fs.readFileSync(${JSON.stringify(path.join(tmp, 'seq'))}, 'utf8')) + 1
    : 1;
  fs.writeFileSync(${JSON.stringify(path.join(tmp, 'seq'))}, String(n));
  process.stdout.write(JSON.stringify({ id: 'bc-new' + n }));
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'relate') { process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const calls = () =>
  fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const WS = { name: 'demo', dir: wsDir };

/** A fresh workspace state: these rows on the tracker, nothing cached, no calls yet. */
const tracker = (rows) => {
  if (rows === null) fs.rmSync(ROWS, { force: true });
  else fs.writeFileSync(ROWS, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(CALLS, '');
  fs.rmSync(path.join(tmp, 'seq'), { force: true });
  forgetParents();
  forgetTitles();
};
const open = (id, title) => ({ id, title, status: 'open', labels: [], dependencies: [] });

/** The `--notes` the last `bd create` was given, or null. */
const notesWritten = () => {
  const create = calls().filter((c) => c[0] === 'create').pop();
  if (!create) return null;
  const at = create.lastIndexOf('--notes');
  return at === -1 ? null : create[at + 1];
};
/** Every `bd dep relate` pair the run drew. */
const related = () => calls().filter((c) => c[0] === 'dep' && c[1] === 'relate').map((c) => [c[2], c[3]]);

const newBd = () => new Bd({ bin: FAKE_BD, actor: 'beadcause' });

await acheck('a work bead filed over a live twin is filed, flagged, and linked to it', async () => {
  tracker([open('bc-297u', '.chip is declared twice in the stylesheet')]);
  const id = await newBd().create(WS, {
    title: '.chip is declared twice in the stylesheet',
    body: 'The second declaration wins and nobody meant it to.',
    labels: [],
  });
  // Filed, not refused: the whole call bc-arj0.6 left open.
  assert.equal(id, 'bc-new1');
  assert.match(notesWritten() || '', /Looks like a duplicate/);
  assert.match(notesWritten() || '', /bc-297u/);
  // And the graph record, drawn out of that sentence by `relateMentions`.
  assert.deepEqual(related(), [['bc-new1', 'bc-297u']]);
});

await acheck('a bead that resembles nothing is filed exactly as it was before', async () => {
  tracker([open('bc-297u', '.chip is declared twice in the stylesheet')]);
  const id = await newBd().create(WS, {
    title: 'The router never proxies a WebSocket upgrade',
    body: 'A socket opened against the daemon is answered with a 404.',
    labels: [],
  });
  assert.equal(id, 'bc-new1');
  assert.equal(notesWritten(), null, 'nothing was appended to a bead with no notes and no twin');
  assert.deepEqual(related(), []);
});

await acheck("a caller's own notes are kept and the flag is added under them", async () => {
  tracker([open('bc-297u', '.chip is declared twice in the stylesheet')]);
  await newBd().create(WS, {
    title: '.chip is declared twice in the stylesheet',
    notes: '_Filed by an agent while working bc-9d37._',
    labels: [],
  });
  const notes = notesWritten() || '';
  assert.match(notes, /Filed by an agent while working bc-9d37/);
  assert.match(notes, /Looks like a duplicate/);
  assert.ok(notes.indexOf('Filed by an agent') < notes.indexOf('Looks like a duplicate'), 'the caller speaks first');
});

await acheck('a caller that already named the twin is not talked over', async () => {
  // lib/filing.js writes its own duplicate sentence from a fuller read than this seam
  // has — pending proposals included. A second paragraph saying the same thing in worse
  // words is the failure mode of putting a net under a net.
  tracker([open('bc-297u', '.chip is declared twice in the stylesheet')]);
  await newBd().create(WS, {
    title: '.chip is declared twice in the stylesheet',
    notes: '**Looks like a duplicate** — already open as bc-297u. Filed anyway, flagged rather than dropped.',
    labels: [],
  });
  const notes = notesWritten() || '';
  assert.equal(notes.match(/Looks like a duplicate/g).length, 1);
  // The edge is still drawn, because it was always drawn from the prose rather than
  // from this check — the caller's own sentence names the same id.
  assert.deepEqual(related(), [['bc-new1', 'bc-297u']]);
});

await acheck('a question is not checked — an inbox card is a notification, not work', async () => {
  tracker([open('bc-297u', 'Two sessions are working bc-9d37')]);
  await newBd().create(WS, { title: 'Two sessions are working bc-9d37', body: 'Which one wins?' });
  // `labels` defaults to `['human']`, which is what /api/ask, the sweep card, the
  // stranded-branch finding and the advocate's proposal all file with.
  assert.equal((notesWritten() || '').includes('Looks like a duplicate'), false);
  assert.equal(calls().some((c) => c[0] === 'export'), false, 'and it costs no read at all');
});

await acheck('a batch that files the same title twice catches its own second bead', async () => {
  // The one duplicate the cache would otherwise hide: both creates happen well inside
  // its minute, so the second is only visible because the first was remembered.
  tracker([open('bc-1', 'Something else entirely')]);
  const bd = newBd();
  await bd.create(WS, { title: 'The disarm never runs when the window closes', labels: [] });
  await bd.create(WS, { title: 'The disarm never runs when the window closes', labels: [] });
  assert.match(notesWritten() || '', /Looks like a duplicate/);
  assert.deepEqual(related(), [['bc-new2', 'bc-new1']], 'the first bead drew nothing, the second linked back to it');
  // One export for the pair: the title list is cached on its own timer, so a session
  // filing three discoveries does not pay three full reads of the tracker.
  assert.equal(calls().filter((c) => c[0] === 'export').length, 1);
});

await acheck('a tracker that cannot be read files the bead anyway, unflagged', async () => {
  tracker(null);
  const was = console.error;
  console.error = () => {};
  let id;
  try {
    id = await newBd().create(WS, { title: '.chip is declared twice in the stylesheet', labels: [] });
  } finally {
    console.error = was;
  }
  assert.equal(id, 'bc-new1', 'the discovery is not lost over a see-also');
  assert.equal(notesWritten(), null);
});

await acheck('a bead is never a candidate for itself', async () => {
  // `rememberTitle` runs after the create; if it ran before, the bead would find its own
  // row and file a note about itself, and `relateMentions` would be asked for a self edge.
  tracker([]);
  await newBd().create(WS, { title: 'A title nothing else on the tracker shares', labels: [] });
  assert.equal(notesWritten(), null);
  assert.deepEqual(related(), []);
});

/* ------------------------------------------- and through bin/file.js, end to end */

/**
 * The whole seam as a worker actually reaches it — and the stdout contract, which is the
 * one thing about this that could break something unrelated.
 *
 * `bin/file.js` documents its stdout as one bead id per line, so a session writes
 * `ids=$(beadcause-file …)`. The duplicate line runs *inside* that command; on stdout it
 * would put a sentence of English in the middle of the ids, on exactly the filings this
 * feature exists to notice, and the failure would land in whatever the caller did with
 * `$ids` rather than anywhere near here.
 */
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause', workspaces: [{ name: 'demo', dir: wsDir }] }, null, 2)
);

check('beadcause-file over a live twin prints the id and nothing else on stdout', () => {
  tracker([open('bc-297u', '.chip is declared twice in the stylesheet')]);
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'file.js'), '-w', 'demo', '--from', 'bc-9d37'],
    {
      input: '- title: .chip is declared twice in the stylesheet\n  type: task\n  priority: 2\n',
      encoding: 'utf8',
      env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
    }
  );
  if (res.error) throw res.error;
  assert.equal(res.status, 0, `file.js exited ${res.status}: ${res.stderr}`);
  assert.equal(res.stdout, 'bc-new1\n');
  // The bead is still flagged and still linked — this is a stream question, not a
  // question about whether the check ran.
  assert.match(res.stderr, /already open as bc-297u/);
  assert.deepEqual(related(), [['bc-new1', 'bc-297u']]);
});

/* --------------------------------------------------------------------- the tally */

console.log(`\n${ran - failures}/${ran} checks passed`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
