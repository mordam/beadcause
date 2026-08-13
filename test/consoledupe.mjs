#!/usr/bin/env node
/**
 * The chat session says when a draft card is already a bead — and files it anyway.
 *
 *     npm test
 *     node test/consoledupe.mjs
 *
 * `POST /api/console/create` is "the only write in the whole console", and until
 * bc-pzti it was the only path into the tracker that never asked whether the thing it
 * was about to file already existed. Every sibling asks: lib/advocate.js flags a
 * proposal as it is written, `/api/respond` re-checks and *refuses* a duplicate the
 * card never mentioned, `bin/file.js` checks what a session files mid-work. lib/dupe.js
 * was simply never imported by lib/draft.js, and nothing between `normalizeDraft` and
 * `bd create` asked the tracker anything at all.
 *
 * What that cost is measured rather than imagined. Three epics for one history page,
 * filed from three chats inside 82 minutes:
 *
 *   bc-qsj6  15:14:49  independently worded, P2, 3 children
 *   bc-nib3  15:23:15  8m26s later, P1, 6 children — the one that survived
 *   bc-xpwh  16:37:13  word for word the same as bc-nib3, all 6 children
 *
 * The third would have been caught by a title comparison on any threshold. The first
 * would not, and it is the expensive one: it reached a finished, tested, unmergeable
 * branch writing the same two filenames as a bc-nib3 child.
 *
 * **So this asserts a warning, and asserts that it is only a warning.** That is the
 * decision on bc-x3e9, and it is the one place this differs from the approval path.
 * A proposal card is a question answered by a single tap, so a duplicate nobody was
 * shown is not something that tap consented to and the create is refused. A chat
 * session is the opposite: you are looking at the cards, you edited them over several
 * turns, and re-filing on purpose is a real thing to want. The button still says
 * **Create**, and the app states the fact rather than making the decision.
 *
 * Nothing here spawns an agent or an editor: a console with no seed sends no turn, so
 * `bd` is the only subprocess and it is a fake. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);
const PUBLIC = (name) => path.join(HERE, '..', 'public', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-consoledupe-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { createApp, listen } = await import(LIB('server.js'));

/* ------------------------------------------------------------------- harness */

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

/* ------------------------------------------------------------------ fixtures */

/** The real one, verbatim from bc-nib3 — the epic that survived. */
const REAL_TITLE = 'A history tab — every bead that has been closed, newest first';

const bead = (id, title, { status = 'open', labels = [] } = {}) => ({
  id,
  title,
  description: '',
  status,
  issue_type: 'feature',
  priority: 2,
  labels,
  created_at: '2026-08-11T15:23:15Z',
  updated_at: '2026-08-11T15:23:15Z',
});

const WS = { name: 'beadcause', dir: path.join(tmp, 'beadcause', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });
const CALLS = path.join(tmp, 'bd-calls.log');
const STATE = path.join(tmp, 'bd-state.json');

/**
 * A `bd` that answers from a fixture and records every call.
 *
 * `.cjs` deliberately: it is spawned by absolute path out of a temp directory, and the
 * extension is the only thing that settles how node parses it. `BD_LIST_FAILS` in the
 * state file is how the "the tracker is down" case is staged — `list` exits 1 and says
 * so on stderr, exactly as a bd with no database does.
 */
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, 'utf8'));
if (args[0] === 'list') {
  if (state.listFails) { process.stderr.write('no beads database found\\n'); process.exit(1); }
  const status = (args.find((a) => a.startsWith('--status=')) || '').slice('--status='.length).split(',').filter(Boolean);
  const rows = (state.issues || []).filter((i) => !status.length || status.includes(i.status));
  console.log(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'create') {
  const n = (state.created || 0) + 1;
  state.created = n;
  const id = 'bc-new' + n;
  state.issues.push({ id, title: args[args.indexOf('--title') + 1], status: 'open', labels: [], description: '' });
  fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(state));
  console.log(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'show') {
  const hit = (state.issues || []).find((i) => i.id === args[1]);
  console.log(JSON.stringify(hit ? [hit] : []));
  process.exit(0);
}
console.log('[]');
`,
  { mode: 0o755 }
);

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'test-token',
  bdBin: BD,
  actor: 'beadcause-test',
  workspaces: [WS],
  spaces: [],
  claudeSessionsDir: path.join(tmp, 'sessions'),
  advocates: { enabled: false, workspaces: [] },
  openSessions: false,
  agents: [],
  ntfy: {},
};
fs.mkdirSync(cfg.claudeSessionsDir, { recursive: true });

const setIssues = (issues, { listFails = false } = {}) =>
  fs.writeFileSync(STATE, JSON.stringify({ issues, created: 0, listFails }));
const calls = () =>
  fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const resetCalls = () => fs.writeFileSync(CALLS, '');
/** The sweep the flag costs: one `bd list` of everything that is not closed. */
const sweeps = () => calls().filter((c) => c[0] === 'list' && c.includes('--status=open,in_progress,blocked'));

const servers = listen(cfg, createApp(cfg).handler);
const PORT = await boundPort(servers);

const post = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/** A chat session with nothing seeded, so opening it spawns nothing. */
const openChat = async () => (await post('/api/console', { workspace: WS.name })).body.id;

const card = (ref, title, extra = {}) => ({
  ref,
  title,
  type: 'feature',
  priority: 2,
  description: 'Because it is worth doing.',
  ...extra,
});

const saveDraft = (id, beads) => post('/api/console/draft', { id, draft: { beads } });

/* ------------------------------------------------------ flagged on the card */

console.log('flagged on the draft card');

await check('the bc-xpwh shape: a card repeating an open bead is flagged as that bead', async () => {
  setIssues([bead('bc-nib3', REAL_TITLE, { status: 'in_progress' })]);
  const id = await openChat();
  const { body } = await saveDraft(id, [card('history', REAL_TITLE)]);
  assert.equal(body.draft.beads[0].duplicate?.id, 'bc-nib3');
  assert.equal(body.draft.beads[0].duplicate.status, 'in_progress', 'the state matters — somebody is on it now');
});

await check('and it says so in the same words a proposal card uses', async () => {
  setIssues([bead('bc-nib3', REAL_TITLE)]);
  const id = await openChat();
  const { body } = await saveDraft(id, [card('history', REAL_TITLE)]);
  // `dupeNote` in lib/proposal.js, written on the server precisely so this sentence
  // and the one on an advocate's card cannot drift apart.
  assert.equal(body.draft.beads[0].duplicate.note, `already open as bc-nib3 — “${REAL_TITLE}”`);
});

await check('a card proposing genuinely new work carries no flag', async () => {
  setIssues([bead('bc-nib3', REAL_TITLE)]);
  const id = await openChat();
  const { body } = await saveDraft(id, [card('swap', 'Bump the service worker cache when the shell changes')]);
  assert.equal(body.draft.beads[0].duplicate, null, 'null rather than undefined — the phone renders on it');
});

await check('a closed bead is not something to flag against', async () => {
  // A bead that is finished is not a reason to refuse filing a new one about the same
  // thing, so the sweep asks for open,in_progress,blocked and nothing else.
  setIssues([bead('bc-nib3', REAL_TITLE, { status: 'closed' })]);
  const id = await openChat();
  resetCalls();
  const { body } = await saveDraft(id, [card('history', REAL_TITLE)]);
  assert.equal(body.draft.beads[0].duplicate, null);
  assert.equal(sweeps().length, 1, `one sweep, and it must exclude closed: ${JSON.stringify(calls())}`);
});

await check('the bc-qsj6 shape is honestly NOT caught, which is why this warns', async () => {
  // The two epics that actually cost a branch were worded independently: they share
  // "a" and "of" and nothing else. Catching that needs the children or the acceptance
  // compared, not the title — so the second half of the fix is that a human reads the
  // card, and this test exists so nobody later reads a green run as "duplicates are
  // impossible now".
  setIssues([bead('bc-qsj6', 'A historical record of closed beads, and how to read it back')]);
  const id = await openChat();
  const { body } = await saveDraft(id, [card('history', REAL_TITLE)]);
  assert.equal(body.draft.beads[0].duplicate, null);
});

/* ------------------------------------------------------- warned, not refused */

console.log('\nwarned, never refused');

await check('a flagged card still creates, and nothing is skipped', async () => {
  setIssues([bead('bc-nib3', REAL_TITLE)]);
  const id = await openChat();
  const saved = await saveDraft(id, [card('history', REAL_TITLE)]);
  assert.equal(saved.body.draft.beads[0].duplicate?.id, 'bc-nib3', 'fixture check: the card must carry the flag');

  const { status, body } = await post('/api/console/create', { id, draft: { beads: [card('history', REAL_TITLE)] } });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.created.length, 1, `the create must stand: ${JSON.stringify(body)}`);
  // Not a warning either: warnings hold the conversation open to be read, and "you
  // already knew" is not something to keep a chat session open for.
  assert.deepEqual(body.warnings, []);
  assert.ok(calls().some((c) => c[0] === 'create'), 'bd create has to be reached');
});

await check('creating costs no sweep of its own — the answer was on the card', async () => {
  setIssues([bead('bc-nib3', REAL_TITLE)]);
  const id = await openChat();
  await saveDraft(id, [card('history', REAL_TITLE)]);
  resetCalls();
  await post('/api/console/create', { id, draft: { beads: [card('history', REAL_TITLE)] } });
  assert.equal(sweeps().length, 0, `the create path must not re-ask: ${JSON.stringify(calls())}`);
});

/* --------------------------------------------------------- what it costs */

console.log('\nwhat the check costs');

await check('editing a description is free — only a title can change the answer', async () => {
  setIssues([bead('bc-nib3', REAL_TITLE)]);
  const id = await openChat();
  await saveDraft(id, [card('history', REAL_TITLE)]);
  resetCalls();
  // The phone saves 700ms after you stop typing, so this is what writing two more
  // sentences into a description looks like from here.
  await saveDraft(id, [card('history', REAL_TITLE, { description: 'One more sentence.' })]);
  const after = await saveDraft(id, [card('history', REAL_TITLE, { description: 'One more sentence. And another.' })]);
  assert.equal(sweeps().length, 0, `same titles, no new sweep: ${JSON.stringify(calls())}`);
  assert.equal(after.body.draft.beads[0].duplicate?.id, 'bc-nib3', 'and the verdict is carried forward, not lost');
});

await check('rewriting a title does ask again, and the flag can come off', async () => {
  setIssues([bead('bc-nib3', REAL_TITLE)]);
  const id = await openChat();
  await saveDraft(id, [card('history', REAL_TITLE)]);
  resetCalls();
  const { body } = await saveDraft(id, [card('history', 'Something else entirely, about the graph page')]);
  assert.equal(sweeps().length, 1, `a changed title is a changed question: ${JSON.stringify(calls())}`);
  assert.equal(body.draft.beads[0].duplicate, null);
});

/* ------------------------------------------------- and it cannot lose a draft */

console.log('\nand it can never lose a draft');

await check('a bd that will not answer leaves the cards exactly as they were', async () => {
  setIssues([bead('bc-nib3', REAL_TITLE)], { listFails: true });
  const id = await openChat();
  const { status, body } = await saveDraft(id, [card('history', REAL_TITLE), card('two', 'A second bead')]);
  assert.equal(status, 200, 'a lookup that failed must not fail the save');
  assert.equal(body.draft.beads.length, 2, JSON.stringify(body));
  assert.equal(body.draft.beads[0].title, REAL_TITLE);
  assert.ok(!body.draft.beads[0].duplicate, 'unflagged, which is what every draft was before this existed');
});

await check('and the create still works with the tracker still down for reads', async () => {
  setIssues([bead('bc-nib3', REAL_TITLE)], { listFails: true });
  const id = await openChat();
  await saveDraft(id, [card('history', REAL_TITLE)]);
  const { body } = await post('/api/console/create', { id, draft: { beads: [card('history', REAL_TITLE)] } });
  assert.equal(body.created.length, 1, JSON.stringify(body));
});

/* ------------------------------------------------------------ what is drawn */

console.log('\nwhat the phone draws');

const consoleJs = fs.readFileSync(PUBLIC('console.js'), 'utf8');
const styleCss = fs.readFileSync(PUBLIC('style.css'), 'utf8');

await check('the warning is drawn on the collapsed card, not only the open one', () => {
  // The sheet opens with every card collapsed. A warning that lived among the fields
  // would be a warning nobody reads — which is the whole failure this is about.
  const collapsed = consoleJs.match(/if \(!isOpen\) return `<div class="bead card">(.*)<\/div>`;/);
  assert.ok(collapsed, 'the collapsed branch of beadHtml has moved');
  assert.match(collapsed[1], /\$\{dupe\}/, 'the collapsed card must carry the duplicate line');
  assert.match(consoleJs, /class="bead card open">\s*\$\{summary\}\s*\$\{dupe\}/, 'and so must the open one');
});

await check('nothing about it disables Create', () => {
  const btn = consoleJs.match(/function updateCreateButton\(\)[\s\S]*?\n {2}\}/);
  assert.ok(btn, 'updateCreateButton has moved');
  assert.ok(
    !/duplicate/.test(btn[0]),
    `the button must not know what a duplicate is — warn, do not refuse (bc-x3e9): ${btn[0]}`
  );
});

await check('the line is styled, and it says what a warning says', () => {
  assert.match(styleCss, /\.bead-dupe \{[^}]*var\(--warn\)/, '.bead-dupe must draw in the warning colour');
});

/* -------------------------------------------------------------------- the end */

for (const s of servers) s.close();
// Not a bare rmSync: writes under CONFIG_DIR schedule a git commit into the same tree,
// and `git init` still laying down .git/hooks under a directory being walked is
// ENOTEMPTY. See test/helpers/tmp.mjs.
await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
