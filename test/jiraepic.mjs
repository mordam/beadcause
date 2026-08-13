#!/usr/bin/env node
/**
 * lib/jiraepic.js — one epic per ticket, and the four ways "exactly once" goes wrong.
 *
 *     npm test
 *     node test/jiraepic.mjs
 *
 * test/jira-poll.mjs covers the read that produces the tickets. What is worth a second
 * file is what happens to each of them once, and only once, forever:
 *
 * 1. **The ref, before anything is created.** `external_ref: jira-<KEY>` is the link in
 *    both directions and the only one a sweep can *ask about*. A tick whose tickets are
 *    all already in the map must make no `bd` call at all, and a tick that finds one
 *    missing must go back to the tracker rather than trust the map — including for the
 *    epic that was closed last month, which is not in any list of open work.
 * 2. **The two nets under it.** A near-verbatim title (lib/dupe.js), and a title that
 *    *opens with* the ticket key. Both adopt rather than skip, because a skip leaves the
 *    ticket with nothing findable by ref and re-decides itself by fuzzy matching on every
 *    restart. Neither may take a ref away from a bead that already carries one, and
 *    neither may fire on a bead that merely mentions the key.
 * 3. **The hold has teeth.** The epic carries `unendorsed`, and the guarantee is not the
 *    queue filter — it is `assertEndorsed`, which the launcher runs against the tracker.
 *    An epic handed straight to it must still be refused. `autoEndorse` is the one switch
 *    that drops the marker, and the note has to say plainly which of the two happened.
 * 4. **A failure must not become a duplicate, or a spin.** A `bd list` that throws files
 *    nothing; a `create` that throws is not retried on the very next tick, because a
 *    ticket bd will never accept would otherwise buy a full read of the workspace every
 *    minute for as long as it exists.
 *
 * No tracker and no network: `bd` is a fake that records every call and keeps its rows in
 * an array, which is exactly the shape the real `listAll` hands back.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-jiraepic-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  createEpicFiler,
  epicIssue,
  epicNotes,
  epicTitle,
  existingFor,
  opensWithKey,
  refFor,
  refIndex,
  refOn,
  RETRY_MS,
  TICKET_LABEL,
  TITLE_MAX,
} = await import(LIB('jiraepic.js'));
const { UNENDORSED, assertEndorsed } = await import(LIB('endorse.js'));
const { titleSimilarity, DUPE_THRESHOLD } = await import(LIB('dupe.js'));
const { ticketFrom } = await import(LIB('jirapoll.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const checks = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checksAsync = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const WS = { name: 'climative', dir: path.join(tmp, 'beads', 'climative', '.beads') };
const CFG = { workspaces: [WS] };

/** A ticket in lib/jirapoll.js's shape — `ticketFrom` builds exactly this. */
const ticket = (key, over = {}) => ({
  workspace: 'climative',
  key,
  summary: `${key} needs doing`,
  status: 'In Progress',
  updated: '2026-08-13T10:00:00.000+0000',
  url: `https://climative.atlassian.net/browse/${key}`,
  assignee: 'adam@climative.ai',
  ...over,
});

/** One workspace's `sweep()` result, as lib/jirapoll.js returns it. */
const okResult = (tickets, workspace = 'climative') => [{ workspace, state: 'ok', tickets, changed: true }];

/**
 * `bd`, holding rows in an array and counting every call.
 *
 * `listAll` hands back copies, like the real one, so a filer that mutated what it read
 * would be caught rather than quietly agreeing with itself.
 */
function fakeBd({ rows = [], p0s = [], createFails = null, listFails = null } = {}) {
  const calls = [];
  let next = 0;
  return {
    calls,
    rows,
    of: (id) => rows.find((r) => r.id === id),
    async listAll() {
      calls.push('listAll');
      if (listFails) throw new Error(listFails);
      return rows.map((r) => ({ ...r, labels: [...(r.labels || [])] }));
    },
    async create(workspace, issue) {
      calls.push(`create ${issue.title}${issue.parent ? ` under ${issue.parent}` : ''}`);
      const why = typeof createFails === 'function' ? createFails(issue) : createFails;
      if (why) throw new Error(why);
      next += 1;
      const id = `bc-new${next}`;
      rows.push({
        id,
        title: issue.title,
        status: 'open',
        priority: issue.priority,
        issue_type: issue.type,
        labels: [...issue.labels],
        external_ref: issue.externalRef,
        notes: issue.notes,
        parent: issue.parent || '',
      });
      return id;
    },
    async update(workspace, id, fields) {
      calls.push(`update ${id} ${JSON.stringify(fields)}`);
      const row = rows.find((r) => r.id === id);
      if (row && fields.externalRef) row.external_ref = fields.externalRef;
    },
    async comment(workspace, id) {
      calls.push(`comment ${id}`);
    },
    async show(workspace, id) {
      calls.push(`show ${id}`);
      return rows.find((r) => r.id === id) || null;
    },
    async graph() {
      calls.push('graph');
      return { parents: new Map(), beads: new Map(p0s.map((b) => [b.id, b])) };
    },
  };
}

/** An open P0 carrying `unsorted` — what lib/homing.js adopts an orphan into. */
const UNSORTED_P0 = { id: 'bc-back', title: 'Unsorted backlog', status: 'open', priority: 0, labels: ['unsorted'] };

/* ------------------------------------------------------------------------ the ref and the title */

console.log('\nthe ref, and the title the nets read');
{
  check('one spelling of the ref, and it is bd’s own', refFor('TECH-1') === 'jira-TECH-1');
  check('a ref read off a row survives either spelling of the field', refOn({ external_ref: ' jira-X ' }) === 'jira-X');
  check('and a row without one is the empty string, never undefined', refOn({}) === '' && refOn(null) === '');

  check(
    'the key leads the title',
    epicTitle(ticket('TECH-1', { summary: 'Fix the login redirect loop' })) === 'TECH-1 — Fix the login redirect loop'
  );
  check('a ticket with no summary is still a title — the key', epicTitle(ticket('TECH-2', { summary: '' })) === 'TECH-2');
  check(
    'a summary with a newline in it is collapsed — bd titles are one line',
    epicTitle(ticket('TECH-3', { summary: 'Fix\n  the   thing' })) === 'TECH-3 — Fix the thing'
  );
  const long = epicTitle(ticket('TECH-4', { summary: 'x'.repeat(400) }));
  check(`a long summary is cut at ${TITLE_MAX}`, long.length <= TITLE_MAX && long.endsWith('…'), `${long.length} chars`);

  // The whole reason the key leads: two tickets that say the same thing must not read as
  // one bead filed twice, or the second one never gets an epic at all.
  const a = epicTitle(ticket('TECH-11', { summary: 'Fix the login redirect loop' }));
  const b = epicTitle(ticket('TECH-12', { summary: 'Fix the login redirect loop' }));
  check(
    'two tickets with an identical summary are not duplicates of each other',
    titleSimilarity(a, b) < DUPE_THRESHOLD,
    `scored ${titleSimilarity(a, b)}`
  );
}

console.log('\nthe third net is anchored, and that is what makes it safe');
{
  check('a bead titled with the key is the ticket’s own', opensWithKey('TECH-1 — fix the thing', 'TECH-1'));
  check('however it was punctuated', opensWithKey('TECH-1: fix the thing', 'TECH-1') && opensWithKey('[TECH-1] fix', 'TECH-1'));
  check('case does not decide it', opensWithKey('tech-1 fix the thing', 'TECH-1'));
  check(
    'but a bead that merely mentions the ticket is not its epic',
    !opensWithKey('Follow-up to TECH-1', 'TECH-1'),
    'adopting this would take the ref away from the bead that should have had it'
  );
  check('and a longer key is not matched by a shorter one', !opensWithKey('TECH-12 — other work', 'TECH-1'));
  check('a key with no ticket is never a match', !opensWithKey('anything at all', ''));
}

/* ------------------------------------------------------------------------------- the bead itself */

console.log('\nwhat the epic is');
{
  const issue = epicIssue(ticket('TECH-1'));
  check('an epic', issue.type === 'epic');
  check('at P1, as specified — not lib/filing.js’s agent-filed floor', issue.priority === 1);
  check('carrying the ref', issue.externalRef === 'jira-TECH-1');
  check('held', issue.labels.includes(UNENDORSED) && issue.endorsed === false);
  check('and auditable after the hold comes off', issue.labels.includes(TICKET_LABEL));
  check('the marker leads the labels — it is why the bead is not being worked', issue.labels[0] === UNENDORSED);
  check('the body names the ticket, its state and where it is', /TECH-1/.test(issue.body) && /In Progress/.test(issue.body) && /browse\/TECH-1/.test(issue.body));
  check(
    'and the JIRA assignee, because owner is not the place for it',
    /assigned to adam@climative\.ai/.test(issue.body),
    'bd takes owner from the git identity of the directory it runs in — see the header'
  );
  check('acceptance is the ticket, not this bead', /TECH-1 is resolved in JIRA/.test(issue.acceptance));
  check('the note says nothing will work it until it is endorsed', /nothing will open a session on it/.test(issue.notes));

  const anon = epicIssue(ticket('TECH-2', { assignee: null }));
  check(
    'a site that will not say who it is assigned to still says it is yours',
    /assigned to you/.test(anon.body),
    'the query that found this ticket was "assigned to me" — an empty name is a fact about the site'
  );

  const free = epicIssue(ticket('TECH-3'), { endorsed: true });
  check('autoEndorse drops the marker', !free.labels.includes(UNENDORSED) && free.endorsed === true);
  check('and only the marker — the provenance is not optional', free.labels.includes(TICKET_LABEL));
  check(
    'and the note says so plainly, because its reader is finding out rather than deciding',
    /arrived \*\*endorsed\*\*/.test(free.notes) && /nobody read it/.test(free.notes),
    'a bead claiming to wait for a tap over a session already running on it is the worse error'
  );

  check('a homed epic says who chose the home', /Filed under bc-back, the unsorted backlog/.test(epicNotes(ticket('TECH-4'), { homed: 'bc-back, the unsorted backlog' })));
  check('and an adopted one says it was adopted', /Adopted rather than filed/.test(epicNotes(ticket('TECH-5'), { adopted: 'its title opens with the ticket key' })));
}

console.log('\nthe shape it is handed is the shape the poller builds');
{
  // Not a fixture of my own: `ticketFrom` is lib/jirapoll.js's contract, and the two
  // modules are coupled by it. A field renamed on that side and not this one would leave
  // every epic titled after `undefined` with nobody the wiser until one was read.
  const issue = epicIssue(
    ticketFrom(
      {
        key: 'TECH-9',
        fields: {
          summary: 'Fix the login redirect loop',
          status: { name: 'In Progress' },
          updated: '2026-08-13T10:00:00.000+0000',
          assignee: { emailAddress: 'adam@climative.ai', displayName: 'Adam Morgan' },
        },
      },
      { workspace: 'climative', url: 'https://climative.atlassian.net' }
    )
  );
  check('the title is built from the real ticket shape', issue.title === 'TECH-9 — Fix the login redirect loop');
  check('the ref too', issue.externalRef === 'jira-TECH-9');
  check('and the body carries the url the poller built, not the REST one', /https:\/\/climative\.atlassian\.net\/browse\/TECH-9/.test(issue.body));
  check('with the status and the assignee off the same row', /In Progress/.test(issue.body) && /adam@climative\.ai/.test(issue.body));
  check('and nothing in it reads `undefined`', !/undefined/.test(`${issue.title}${issue.body}${issue.acceptance}${issue.notes}`));
}

console.log('\nthe hold is a refusal, not merely a queue filter');
await checksAsync('an epic handed straight to the launcher is still refused', async () => {
  const issue = epicIssue(ticket('TECH-1'));
  const row = { id: 'bc-e1', title: issue.title, labels: issue.labels };
  const bd = fakeBd({ rows: [row] });
  await assert.rejects(
    () => assertEndorsed(bd, WS, 'bc-e1'),
    (err) => err.unendorsed === true && err.status === 409,
    'assertEndorsed let the epic through — the filter is not the guarantee'
  );
});
await checksAsync('and an auto-endorsed one is not', async () => {
  const issue = epicIssue(ticket('TECH-1'), { endorsed: true });
  const bd = fakeBd({ rows: [{ id: 'bc-e2', title: issue.title, labels: issue.labels }] });
  assert.ok(await assertEndorsed(bd, WS, 'bc-e2'));
});

/* --------------------------------------------------------------------------------- exactly once */

console.log('\nfiled exactly once');
await checksAsync('one ticket, one epic, however many times it is swept', async () => {
  const bd = fakeBd();
  const filer = createEpicFiler({ bd });
  const first = await filer.sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(first.filed.length, 1, 'the first sweep filed nothing');
  assert.equal(bd.rows.length, 1);
  assert.equal(bd.rows[0].external_ref, 'jira-TECH-1');

  const before = bd.calls.length;
  await filer.sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  await filer.sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(bd.rows.length, 1, 'a second epic was filed for the same ticket');
  assert.equal(bd.calls.length, before, `a quiet tick cost ${bd.calls.length - before} bd calls; it must cost none`);
});

await checksAsync('a restart trusts the tracker, not its memory — and files nothing', async () => {
  const bd = fakeBd();
  await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  bd.calls.length = 0;
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(out.filed.length, 0);
  assert.equal(bd.rows.length, 1, 'the fresh filer raised a second epic');
  assert.deepEqual(bd.calls, ['listAll'], `it read ${bd.calls.join(', ')}`);
});

await checksAsync('an epic that was closed last month still counts as filed', async () => {
  const bd = fakeBd({
    rows: [{ id: 'bc-old', title: 'TECH-1 — TECH-1 needs doing', status: 'closed', labels: [], external_ref: 'jira-TECH-1' }],
  });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(out.filed.length, 0);
  assert.equal(bd.rows.length, 1, 'a closed epic is not in any list of open work — but it is still the one epic');
});

await checksAsync('the same key twice in one answer is still one epic', async () => {
  const bd = fakeBd();
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1'), ticket('TECH-1')]));
  assert.equal(out.filed.length, 1, 'both rows were decided against the same pre-create snapshot');
  assert.equal(bd.rows.length, 1);
});

await checksAsync('a ticket reassigned away and then handed back gets no second epic', async () => {
  // bc-uz6e: "leave it alone, let the engineer reassign it". Nothing here reacts to a
  // ticket's absence, so the only thing that has to hold is what happens when it returns.
  const bd = fakeBd();
  const filer = createEpicFiler({ bd });
  await filer.sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  await filer.sweep(CFG, [WS], okResult([])); // reassigned away — it stops coming back
  assert.equal(bd.rows.length, 1, 'something reacted to the ticket leaving');
  assert.equal(String(bd.rows[0].status), 'open', 'the epic was gated or closed behind the engineer');

  bd.calls.length = 0;
  await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(bd.rows.length, 1, 'a returning ticket was filed a second epic');
  assert.deepEqual(bd.calls, ['listAll']);
});

await checksAsync('one workspace’s ref never satisfies another’s ticket', async () => {
  const bd = fakeBd({ rows: [{ id: 'bc-a', title: 'x', status: 'open', labels: [], external_ref: 'jira-TECH-2' }] });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(out.filed.length, 1, 'TECH-1 got no epic');
  assert.equal(out.filed[0].ref, 'jira-TECH-1');
});

/* ------------------------------------------------------------------------------- the other nets */

console.log('\nthe second and third nets adopt rather than skip');
await checksAsync('a bead with the same title is linked, not duplicated', async () => {
  const rows = [{ id: 'bc-hand', title: 'TECH-1 — TECH-1 needs doing', status: 'open', labels: [] }];
  const bd = fakeBd({ rows });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(bd.rows.length, 1, 'a second epic was filed beside the one that already existed');
  assert.equal(out.filed[0].adopted, 'title');
  assert.equal(rows[0].external_ref, 'jira-TECH-1', 'the ref was not written, so the match is re-made on every restart');
  assert.ok(bd.calls.some((c) => c.startsWith('comment bc-hand')), 'nothing said so on the bead');
});

await checksAsync('and so is one whose title merely opens with the key', async () => {
  const rows = [{ id: 'bc-hand', title: 'TECH-1: something else entirely', status: 'open', labels: [] }];
  const bd = fakeBd({ rows });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(out.filed[0].adopted, 'key');
  assert.equal(bd.rows.length, 1);
});

await checksAsync('an adoption sticks — the next sweep finds it by ref', async () => {
  const bd = fakeBd({ rows: [{ id: 'bc-hand', title: 'TECH-1: something else entirely', status: 'open', labels: [] }] });
  await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  bd.calls.length = 0;
  const again = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(again.filed.length, 0, 'the adoption was re-decided by fuzzy matching');
  assert.deepEqual(bd.calls, ['listAll']);
});

await checksAsync('a bead that merely mentions the ticket gets its own epic instead', async () => {
  const bd = fakeBd({ rows: [{ id: 'bc-other', title: 'Follow-up to TECH-1', status: 'open', labels: [] }] });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(out.filed[0].adopted, null, 'a bead about the ticket was adopted as the ticket');
  assert.equal(bd.rows.length, 2);
});

await checksAsync('a bead already linked to something else is never taken', async () => {
  const bd = fakeBd({
    rows: [{ id: 'bc-gh', title: 'TECH-1 — TECH-1 needs doing', status: 'open', labels: [], external_ref: 'gh-9' }],
  });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(out.filed[0].adopted, null, 'somebody else’s link was overwritten');
  assert.equal(bd.of('bc-gh').external_ref, 'gh-9');
});

checks('and a pending proposal is not a bead the ref can be written onto', () => {
  const rows = [
    { id: 'bc-q', title: 'TECH-1 — TECH-1 needs doing', status: 'open', labels: ['advocate-proposal', 'human'] },
  ];
  assert.equal(existingFor(ticket('TECH-1'), rows), null, 'a question’s id would have been adopted as the epic');
});

checks('refIndex resolves a doubled ref to the older bead on every machine', () => {
  const index = refIndex([
    { id: 'bc-1', external_ref: 'jira-TECH-1' },
    { id: 'bc-2', external_ref: 'jira-TECH-1' },
  ]);
  assert.equal(index.get('jira-TECH-1').id, 'bc-1');
});

/* ------------------------------------------------------------------------------------- the cost */

console.log('\nwhat it costs when nothing has arrived');
await checksAsync('a JIRA read that failed files nothing and asks nothing', async () => {
  const bd = fakeBd();
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], [
    { workspace: 'climative', state: 'failed', tickets: [ticket('TECH-1')], error: 'token expired' },
  ]);
  assert.deepEqual(bd.calls, [], `it called ${bd.calls.join(', ')} off a stand-in answer`);
  assert.equal(out.filed.length, 0);
});

await checksAsync('a workspace that is switched off is not in the results at all', async () => {
  const bd = fakeBd();
  await createEpicFiler({ bd }).sweep(CFG, [WS], [{ workspace: 'climative', state: 'off', tickets: [] }]);
  assert.deepEqual(bd.calls, []);
});

await checksAsync('a result naming a workspace this config does not have is skipped', async () => {
  const bd = fakeBd();
  await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')], 'gone'));
  assert.deepEqual(bd.calls, []);
});

/* ---------------------------------------------------------------------------------- the failures */

console.log('\na failure is not a duplicate, and not a spin');
await checksAsync('a tracker read that throws files nothing at all', async () => {
  const bd = fakeBd({ listFails: 'dolt is mid-write' });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(out.filed.length, 0);
  assert.equal(out.failed.length, 1);
  assert.deepEqual(bd.calls, ['listAll'], 'it created something without being able to see what was there');
});

await checksAsync('a create that throws is reported, and left alone until the retry is due', async () => {
  const bd = fakeBd({ createFails: 'bd would not take that title' });
  const filer = createEpicFiler({ bd });
  const first = await filer.sweep(CFG, [WS], okResult([ticket('TECH-1')]), { now: 1000 });
  assert.equal(first.failed.length, 1);
  assert.equal(first.failed[0].workspace, 'climative');

  bd.calls.length = 0;
  await filer.sweep(CFG, [WS], okResult([ticket('TECH-1')]), { now: 1000 + RETRY_MS - 1 });
  assert.deepEqual(bd.calls, [], `it re-read the whole workspace ${bd.calls.length} times inside the backoff`);

  await filer.sweep(CFG, [WS], okResult([ticket('TECH-1')]), { now: 1000 + RETRY_MS });
  assert.ok(bd.calls.includes('listAll'), 'the retry never came');
});

await checksAsync('and one ticket failing does not cost the others theirs', async () => {
  const bd = fakeBd({ createFails: (issue) => (issue.title.startsWith('TECH-1 ') ? 'no' : null) });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1'), ticket('TECH-2')]));
  assert.equal(out.failed.length, 1);
  assert.equal(out.filed.length, 1);
  assert.equal(out.filed[0].key, 'TECH-2');
});

/* --------------------------------------------------------------------------------------- the home */

console.log('\nwhere it lands');
await checksAsync('the unsorted backlog P0 adopts it, so it is workable the moment it is endorsed', async () => {
  const bd = fakeBd({ p0s: [UNSORTED_P0] });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(bd.of(out.filed[0].id).parent, 'bc-back');
  assert.match(bd.of(out.filed[0].id).notes, /Filed under bc-back/);
});

await checksAsync('a tracker with no P0 at all files it parentless rather than refusing', async () => {
  const bd = fakeBd();
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(bd.of(out.filed[0].id).parent, '');
  assert.doesNotMatch(bd.of(out.filed[0].id).notes, /Filed under/);
});

await checksAsync('and a parent bd refuses costs the parent, never the epic', async () => {
  const bd = fakeBd({ p0s: [UNSORTED_P0], createFails: (issue) => (issue.parent ? 'that parent will take no children' : null) });
  const out = await createEpicFiler({ bd }).sweep(CFG, [WS], okResult([ticket('TECH-1')]));
  assert.equal(out.filed.length, 1, 'the ticket lost its epic over where it was going to live');
  assert.equal(bd.of(out.filed[0].id).parent, '');
  assert.doesNotMatch(bd.of(out.filed[0].id).notes, /Filed under/, 'the note claims a home the bead does not have');
});

/* ------------------------------------------------------------------------------------ the wiring */

console.log('\nwired into the poll cycle, and into bd');
{
  const server = fs.readFileSync(LIB('server.js'), 'utf8');
  check(
    'the filer is built beside the poller',
    /const jiraEpics = createEpicFiler\(\{ bd \}\)/.test(server),
    'nothing files an epic — the tickets arrive and stop there'
  );
  check(
    'and swept off the read that just happened',
    /await app\.jiraEpics\?\.sweep\(cfg, cfg\.workspaces, out\.results\)/.test(server),
    'the filing is not in sweepJira'
  );
  check(
    'off `results` rather than `changed`, so a create that failed is retried',
    !/jiraEpics\?\.sweep\(cfg, cfg\.workspaces, out\.changed\)/.test(server)
  );
  check(
    'and the endorsement queue’s cache is dropped when something was filed',
    /if \(epics\.filed\.length\) forgetQueue\(\)/.test(server),
    'the queue would serve a list without the new epic for another fifteen seconds'
  );
  check('the filer is on the app, so a test can reach it', /jira, jiraEpics \}/.test(server));

  const bdSrc = fs.readFileSync(LIB('bd.js'), 'utf8');
  check(
    'bd create passes the ref through',
    /if \(externalRef\) args\.push\('--external-ref', String\(externalRef\)\)/.test(bdSrc)
  );
  check(
    'and so does bd update — which is what makes an adoption stick',
    (bdSrc.match(/args\.push\('--external-ref', String\(externalRef\)\)/g) || []).length === 2,
    'only one of create/update carries it'
  );
}

console.log(failures ? `\n${failures} failed` : '\nall good');
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
