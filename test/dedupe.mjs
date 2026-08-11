/**
 * A bead cannot be proposed twice into existence.
 *
 * The failure, in full (bc-9frx): bc-j6x and bc-ec6 were the same bug — byte-identical
 * titles — proposed on the same day, both approved, both opened. The second worker
 * session found the fix already committed on the first one's branch and had to stop.
 * One wasted window, one wasted approval tap, and a near-miss on two pull requests
 * against the same lines of lib/foundation.js.
 *
 * The advocate was already told not to do it: the survey prompt says to skip "anything
 * already covered by an open bead". Prompt enforcement stood in for mechanical
 * enforcement, and the prompt lost — which is the same shape as the bug bc-j6x itself
 * described. So this asserts the mechanism that replaced it, at both points it acts:
 *
 * 1. **When the proposal is written.** Every row is compared against the live set and
 *    the near-identical ones are flagged, so the card that reaches the phone says what
 *    it looks like. That is the acceptance criterion: the approve tap is an informed one.
 * 2. **When the proposal is approved.** The card may have been written before the
 *    duplicate existed — the bc-j6x timeline exactly — and a tap cannot consent to
 *    something nothing on the card mentioned. So the live set is asked again and an
 *    unflagged duplicate is refused, out loud, on the thread.
 *
 * And the property that makes 1 worth anything at all: the flag survives being written
 * to the bead and read back, because the card is rendered from the stored
 * `beadproposal` block and not from whatever the advocate held in memory.
 *
 * Nothing here spawns an agent, touches the network beyond loopback, or writes outside
 * a temp directory. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-dedupe-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { titleSimilarity, findDuplicate, annotateDuplicates, pendingProposedTitles, liveCandidates, DUPE_THRESHOLD } =
  await import(LIB('dupe.js'));
const { parseProposal, proposalBody, proposalTitle } = await import(LIB('proposal.js'));
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

/** The real pair, verbatim from bc-j6x and bc-ec6. */
const REAL_TITLE = "The advocate's allowlist still has Bash(bd *), which includes create, close, delete and label";

const bead = (id, title, { status = 'open', labels = [], body = '' } = {}) => ({
  id,
  title,
  description: body,
  status,
  issue_type: 'bug',
  priority: 2,
  labels,
  created_at: '2026-08-10T10:00:00Z',
  updated_at: '2026-08-10T10:00:00Z',
});

/** A proposal exactly as the advocate files one — body written by the real writer. */
function proposalBead(id, workspace, beads, opts = {}) {
  return bead(id, proposalTitle(workspace, beads), {
    labels: ['human', 'advocate-proposal'],
    body: proposalBody(workspace, beads, opts),
  });
}

/** One proposed bead, through the normaliser so it has every field the real ones do. */
const proposed = (title, extra = {}) =>
  parseProposal(
    ['```beadproposal', `beads:`, `  - title: ${JSON.stringify(title)}`, `    description: Something worth doing.`, '```'].join(
      '\n'
    )
  ).beads.map((b) => ({ ...b, ...extra }))[0];

/* -------------------------------------------------------- what counts as one */

console.log('what counts as the same bead');

await check('two byte-identical titles are the same bead', () => {
  assert.equal(titleSimilarity(REAL_TITLE, REAL_TITLE), 1);
});

await check('and so is the same title with the punctuation moved', () => {
  const retyped = 'The advocates allowlist still has `Bash(bd *)` — which includes create, close, delete, and label';
  assert.ok(
    titleSimilarity(REAL_TITLE, retyped) >= DUPE_THRESHOLD,
    `backticks and a dash should not make a new bead (scored ${titleSimilarity(REAL_TITLE, retyped).toFixed(2)})`
  );
});

await check('one changed word in a short title is NOT the same bead', () => {
  const a = 'The router never proxies a WebSocket upgrade';
  const b = 'The router never proxies a WebSocket downgrade';
  assert.ok(
    titleSimilarity(a, b) < DUPE_THRESHOLD,
    `opposite beads share five words and must not merge (scored ${titleSimilarity(a, b).toFixed(2)})`
  );
});

await check('and neither are two beads about the same file', () => {
  const a = 'Cache-bust site.js so a shipped header change is visible';
  const b = 'Minify site.js so the first paint is not four hundred kilobytes';
  assert.ok(titleSimilarity(a, b) < DUPE_THRESHOLD, `scored ${titleSimilarity(a, b).toFixed(2)}`);
});

await check('an empty title matches nothing, rather than everything', () => {
  assert.equal(titleSimilarity('', ''), 0);
  assert.equal(findDuplicate('', [bead('bc-1', REAL_TITLE)]), null);
  assert.equal(findDuplicate(REAL_TITLE, [bead('bc-1', '')]), null);
});

await check('the oldest matching bead is the one named', () => {
  const hit = findDuplicate(REAL_TITLE, [bead('bc-ec6', REAL_TITLE), bead('bc-j6x', REAL_TITLE)]);
  assert.equal(hit.id, 'bc-ec6', 'bd lists oldest first, and the older bead is the one with work on it');
});

await check('a bead named in `ignore` is not a duplicate of itself', () => {
  assert.equal(findDuplicate(REAL_TITLE, [bead('bc-ec6', REAL_TITLE)], { ignore: ['bc-ec6'] }), null);
});

/* ------------------------------------------------------ flagged on the card */

console.log('\nflagged when the proposal is written');

await check('the bc-j6x/bc-ec6 pair: the second proposal is flagged as the first bead', () => {
  const live = liveCandidates([bead('bc-ec6', REAL_TITLE, { status: 'in_progress' })]);
  const [row] = annotateDuplicates([proposed(REAL_TITLE)], live);
  assert.equal(row.duplicate?.id, 'bc-ec6');
  assert.equal(row.duplicate.status, 'in_progress', 'the state matters — somebody is on it right now');
});

await check('a proposal of genuinely new work carries no flag', () => {
  const live = liveCandidates([bead('bc-ec6', REAL_TITLE)]);
  const [row] = annotateDuplicates([proposed('Cache-bust site.js so a shipped header change is visible')], live);
  assert.equal(row.duplicate, null);
});

await check('a closed bead is not something to flag against', () => {
  // `bd list --status=open,in_progress,blocked` is what the callers ask for, so a
  // closed bead never reaches here — asserted on the shape of the call, below.
  const [row] = annotateDuplicates([proposed(REAL_TITLE)], liveCandidates([]));
  assert.equal(row.duplicate, null);
});

await check('one survey proposing the same bead twice flags its own second row', () => {
  const rows = annotateDuplicates([proposed(REAL_TITLE), proposed(REAL_TITLE)], []);
  assert.equal(rows[0].duplicate, null, 'the first row is the original');
  assert.equal(rows[1].duplicate?.id, '#1', 'and the second points at the row above it');
});

await check('a proposal still waiting for an answer is a candidate too', () => {
  // The state bc-j6x and bc-ec6 were in for most of the day they collided: two cards
  // in the inbox, neither approved, so neither was a bead in any list bd would give.
  const pending = proposalBead('bc-q1', 'beadcause', [proposed(REAL_TITLE)]);
  const found = pendingProposedTitles([pending]);
  assert.deepEqual(found, [{ id: 'bc-q1', title: REAL_TITLE, status: 'proposed' }]);
  const [row] = annotateDuplicates([proposed(REAL_TITLE)], liveCandidates([pending]));
  assert.equal(row.duplicate?.id, 'bc-q1');
  assert.equal(row.duplicate.status, 'proposed', 'not "open" — it is waiting on the same person');
});

await check("a proposal's own synthesised title is never matched against", () => {
  // "Create a bead in beadcause: <title>" contains the proposed title, and matching it
  // would flag every bead in a proposal as a duplicate of the card it arrived on.
  const pending = proposalBead('bc-q1', 'beadcause', [proposed(REAL_TITLE)]);
  const candidates = liveCandidates([pending]);
  assert.ok(
    !candidates.some((c) => c.title.startsWith('Create a bead')),
    `the question's own title must not be a candidate: ${JSON.stringify(candidates.map((c) => c.title))}`
  );
});

await check('a pending proposal is excluded when the caller asks for beads only', () => {
  const pending = proposalBead('bc-q1', 'beadcause', [proposed(REAL_TITLE)]);
  assert.deepEqual(liveCandidates([pending], { pending: false }), []);
});

await check('a proposal whose block will not parse is skipped rather than thrown on', () => {
  const wrecked = bead('bc-q2', 'Create a bead in beadcause: something', {
    labels: ['human', 'advocate-proposal'],
    body: '```beadproposal\nbeads: [oh dear\n```',
  });
  assert.deepEqual(pendingProposedTitles([wrecked]), []);
});

/* ------------------------------------------------- and it survives the write */

console.log('\nthe flag survives being written to the bead');

await check('the card renders the warning, above the fold and on the row', () => {
  const rows = annotateDuplicates([proposed(REAL_TITLE)], liveCandidates([bead('bc-ec6', REAL_TITLE)]));
  const body = proposalBody('beadcause', rows);
  assert.ok(body.includes('bc-ec6'), 'the existing bead has to be named');
  assert.ok(/Possible duplicate/.test(body), 'and named as a duplicate on the row');
  // Before the first `###`, so it is on the card whether or not you scroll to the row.
  assert.ok(body.indexOf('already open as bc-ec6') < body.indexOf('### 1.'), 'the lead has to carry it too');
});

await check('and the block round-trips it, which is what the phone reads', () => {
  const rows = annotateDuplicates([proposed(REAL_TITLE)], liveCandidates([bead('bc-ec6', REAL_TITLE)]));
  const reparsed = parseProposal(proposalBody('beadcause', rows));
  assert.equal(reparsed.error, null);
  assert.deepEqual(reparsed.beads[0].duplicate, { id: 'bc-ec6', title: REAL_TITLE, status: 'open' });
});

await check('an unflagged proposal round-trips as unflagged, not as undefined', () => {
  const reparsed = parseProposal(proposalBody('beadcause', [proposed('Something entirely new')]));
  assert.equal(reparsed.beads[0].duplicate, null);
  assert.ok(!/Possible duplicate/.test(proposalBody('beadcause', [proposed('Something entirely new')])));
});

await check('a `duplicate` key that is not a verdict is dropped', () => {
  const parsed = parseProposal(
    ['```beadproposal', 'beads:', '  - title: A bead', '    duplicate: yes please', '```'].join('\n')
  );
  assert.equal(parsed.beads[0].duplicate, null);
});

/* ------------------------------------------------ refused at the point of approval */

console.log('\nrefused when the approval would open a second session');

/**
 * A `bd` that answers from a fixture and records every call.
 *
 * `.cjs` deliberately: it is spawned by absolute path from a temp directory, and the
 * extension is the only thing that settles how node parses it.
 */
const WS = { name: 'beadcause', dir: path.join(tmp, 'beadcause', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });
const CALLS = path.join(tmp, 'bd-calls.log');
const STATE = path.join(tmp, 'bd-state.json');

const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, 'utf8'));
const byId = (id) => (state.issues || []).find((i) => i.id === id) || null;
if (args[0] === 'show') { console.log(JSON.stringify([byId(args[1])].filter(Boolean))); process.exit(0); }
if (args[0] === 'list') {
  const status = (args.find((a) => a.startsWith('--status=')) || '').slice('--status='.length).split(',').filter(Boolean);
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : null;
  let rows = (state.issues || []).filter((i) => (!status.length || status.includes(i.status)));
  if (label) rows = rows.filter((i) => (i.labels || []).includes(label));
  console.log(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'human' && args[1] === 'list') {
  console.log(JSON.stringify((state.issues || []).filter((i) => (i.labels || []).includes('human') && i.status !== 'closed')));
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
if (args[0] === 'close') {
  const issue = byId(args[1]);
  if (issue) issue.status = 'closed';
  fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(state));
  console.log('closed');
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

const setIssues = (issues) => fs.writeFileSync(STATE, JSON.stringify({ issues, created: 0 }));
const calls = () =>
  fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const resetCalls = () => fs.writeFileSync(CALLS, '');

const servers = listen(cfg, createApp(cfg).handler);
const PORT = await boundPort(servers);

const approve = async (id, response = 'CREATE: file the proposed bead in beadcause.') => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
    body: JSON.stringify({ workspace: WS.name, id, response, create: [1] }),
  });
  return { status: res.status, body: await res.json() };
};

await check('the whole bc-9frx shape: an unflagged duplicate is not created', async () => {
  // The card was written when nothing looked like it. bc-ec6 was approved and claimed
  // in the meantime, so by the time this tap lands the work is already being done.
  const card = proposalBead('bc-q1', 'beadcause', [proposed(REAL_TITLE)]);
  setIssues([card, bead('bc-ec6', REAL_TITLE, { status: 'in_progress' })]);
  resetCalls();

  const { status, body } = await approve('bc-q1');
  assert.equal(status, 200);
  assert.deepEqual(body.created, [], 'nothing may be created');
  assert.equal(body.skipped.length, 1, 'and the refusal has to come back to the phone');
  assert.match(body.skipped[0], /bc-ec6/);
  assert.ok(
    !calls().some((c) => c[0] === 'create'),
    `bd create must never be reached: ${JSON.stringify(calls().filter((c) => c[0] === 'create'))}`
  );
  // Said out loud, on the thread, rather than quietly dropped.
  const comments = calls().filter((c) => c[0] === 'comment' && c[1] === 'bc-q1');
  assert.ok(comments.some((c) => /already/i.test(c[2]) && /bc-ec6/.test(c[2])), JSON.stringify(comments));
  // And the question is still answered and closed: the answer was not lost, only the
  // create it asked for, and a card left open would be answered a second time.
  assert.ok(calls().some((c) => c[0] === 'close' && c[1] === 'bc-q1'), 'the question still closes');
});

await check('a flagged duplicate you approved anyway IS created', async () => {
  // You were told on the card and tapped ✓. The existing bead may genuinely be a
  // different thing, and that is your call to make — not the daemon's to overrule.
  const rows = annotateDuplicates([proposed(REAL_TITLE)], liveCandidates([bead('bc-ec6', REAL_TITLE)]));
  assert.equal(rows[0].duplicate?.id, 'bc-ec6', 'fixture check: the card must carry the flag');
  setIssues([proposalBead('bc-q2', 'beadcause', rows), bead('bc-ec6', REAL_TITLE)]);
  resetCalls();

  const { body } = await approve('bc-q2');
  assert.equal(body.created.length, 1, `an informed tap has to stand: ${JSON.stringify(body)}`);
  assert.deepEqual(body.skipped, []);
});

await check('a flag naming some other bead does not excuse the duplicate found now', async () => {
  const rows = annotateDuplicates([proposed(REAL_TITLE)], [bead('bc-old', REAL_TITLE)]);
  assert.equal(rows[0].duplicate?.id, 'bc-old');
  // bc-old is gone; a different bead now carries the title, and nothing told you that.
  setIssues([proposalBead('bc-q3', 'beadcause', rows), bead('bc-ec6', REAL_TITLE)]);
  resetCalls();

  const { body } = await approve('bc-q3');
  assert.deepEqual(body.created, []);
  assert.match(body.skipped[0] || '', /bc-ec6/);
});

await check('an ordinary proposal of new work still creates, and asks bd once', async () => {
  const rows = annotateDuplicates([proposed('Cache-bust site.js so a shipped header change is visible')], []);
  setIssues([proposalBead('bc-q4', 'beadcause', rows), bead('bc-ec6', REAL_TITLE)]);
  resetCalls();

  const { body } = await approve('bc-q4');
  assert.equal(body.created.length, 1, JSON.stringify(body));
  assert.deepEqual(body.skipped, []);
  // The check costs one sweep of the live set, not one per proposed bead: this runs on
  // every approval and a per-row call would be a `bd` invocation per row.
  const sweeps = calls().filter((c) => c[0] === 'list' && c.some((a) => String(a).startsWith('--status=')));
  assert.equal(sweeps.length, 1, `one live sweep, got ${sweeps.length}: ${JSON.stringify(sweeps)}`);
  // Closed beads are never in it — a bead that has been finished is not a reason to
  // refuse filing a new one about the same thing.
  assert.ok(
    sweeps[0].some((a) => a === '--status=open,in_progress,blocked'),
    `the sweep must exclude closed: ${JSON.stringify(sweeps[0])}`
  );
});

await check('the proposal being answered is never a duplicate of itself', async () => {
  // Its own `beadproposal` block names the title being created. Without the exclusion
  // every approval on earth would refuse itself.
  const rows = annotateDuplicates([proposed('A bead nothing else resembles at all')], []);
  setIssues([proposalBead('bc-q5', 'beadcause', rows)]);
  resetCalls();
  const { body } = await approve('bc-q5');
  assert.equal(body.created.length, 1, `${JSON.stringify(body)}`);
});

await check('a live sweep that fails creates everything, rather than swallowing an approval', async () => {
  /**
   * A `bd` that cannot list, on a second server of its own — `Bd` reads `bdBin` once,
   * when the app is built, so this cannot be swapped in under the running one.
   *
   * The create must still happen. A duplicate costs a session; an outage that silently
   * ate approvals would cost the tracker, and the person tapping would have no way to
   * tell the two apart.
   */
  const broken = path.join(tmp, 'bd-broken.cjs');
  fs.writeFileSync(
    broken,
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'list' && args.some((a) => String(a).startsWith('--status='))) { console.error('boom'); process.exit(1); }
const state = JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, 'utf8'));
if (args[0] === 'show') { console.log(JSON.stringify((state.issues || []).filter((i) => i.id === args[1]))); process.exit(0); }
if (args[0] === 'create') { console.log(JSON.stringify({ id: 'bc-newX' })); process.exit(0); }
console.log('[]');
`,
    { mode: 0o755 }
  );
  const rows = annotateDuplicates([proposed('Another new bead')], []);
  setIssues([proposalBead('bc-q6', 'beadcause', rows)]);

  const blindCfg = { ...cfg, port: 0, bdBin: broken };
  const blind = listen(blindCfg, createApp(blindCfg).handler);
  blindCfg.port = await boundPort(blind);
  try {
    const res = await fetch(`http://127.0.0.1:${blindCfg.port}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
      body: JSON.stringify({ workspace: WS.name, id: 'bc-q6', response: 'CREATE: it', create: [1] }),
    });
    const body = await res.json();
    assert.deepEqual(body.created, ['bc-newX'], `${JSON.stringify(body)}`);
    assert.deepEqual(body.skipped, []);
  } finally {
    for (const s of blind) s.close();
  }
});

await check('declining still declines, and the response is still additive', async () => {
  const rows = annotateDuplicates([proposed('A bead you do not want')], []);
  setIssues([proposalBead('bc-q7', 'beadcause', rows)]);
  resetCalls();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
    body: JSON.stringify({ workspace: WS.name, id: 'bc-q7', response: 'Not now — do not create these.' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.created, []);
  // Every field the installed Android build and a cached service worker read is still
  // here, unchanged, alongside the new one.
  for (const field of ['ok', 'closed', 'created', 'declined', 'skipped']) {
    assert.ok(field in body, `${field} must still be on the response`);
  }
});

/* -------------------------------------------------------------------- the end */

for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
