#!/usr/bin/env node
/**
 * lib/jiraresolved.js — a ticket that was resolved, and the four vanishings that were not.
 *
 *     npm test
 *     node test/jiraresolved.mjs
 *
 * test/jiraepic.mjs covers the epic being filed. This covers what happens the day its
 * ticket is resolved, which is the one act in this epic that *closes* a bead, and every
 * way that act can be wrong is a way to close somebody's work by accident.
 *
 * 1. **The split, both halves.** Unendorsed → closed with a reason naming the resolution.
 *    Endorsed → left completely alone, and told once. That is bc-jrvh's answer and it is
 *    `cancelTicketAndEpic`'s line, so the two must not drift apart.
 * 2. **The decision is made against the tracker, never against memory.** The filer's map
 *    carries `held`, and it can be a minute stale in exactly the direction that matters —
 *    an epic endorsed on the other machine still reads held in it. `actionFor` takes a row
 *    and the sweep re-reads the bead, and this file asserts both.
 * 3. **Four things vanish and are not resolutions.** A read that *failed*; a ticket
 *    *cancelled* in beadcause; a ticket whose resolution comes back null (reassigned —
 *    bc-uz6e's answer, which this must not touch); and a ticket nothing ever knew about.
 * 4. **Once, forever.** A resolved ticket stays resolved, so a second tick must make no
 *    JIRA call and no `bd` call at all. The record is written *after* the write, so a `bd`
 *    that threw leaves the ticket unrecorded — the failure that must not silently look
 *    like success.
 * 5. **And the cost guards**: the six-hour backoff on a still-open answer, and the cap on
 *    how many tickets one workspace may be asked about on one tick.
 *
 * No tracker and no network: `bd` is a fake that records every call, and JIRA is a fake
 * `fetchImpl` in exactly the shape test/jira.mjs serves.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-jiraresolved-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  actionFor,
  createResolvedSweep,
  forgetResolved,
  keyOfRef,
  MAX_CHECKS,
  readResolved,
  RECHECK_MS,
  recordResolved,
  resolvedKey,
  resolvedNote,
  resolvedReason,
  RESOLVED_PREFIX,
  SEEN_KEY,
  STATE_KEY,
} = await import(LIB('jiraresolved.js'));
const { RESOLUTION_FIELDS, resolutionOf } = await import(LIB('jira.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const { cancelTicket } = await import(LIB('jiracancel.js'));
const { refFor } = await import(LIB('jiraepic.js'));
const { CANCELLED_PREFIX } = await import(LIB('jiragate.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
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
const SITE = {
  workspace: 'climative',
  enabled: true,
  url: 'https://climative.atlassian.net',
  email: 'adam@climative.ai',
  projects: [],
  token: 'x',
  problem: null,
};
const settingsOk = () => SITE;

/** A ticket in lib/jirapoll.js's shape. */
const ticket = (key) => ({ workspace: 'climative', key, summary: `${key} needs doing`, status: 'In Progress', updated: '2026-08-13T10:00:00.000+0000' });

/** One workspace's `sweep()` result, as lib/jirapoll.js returns it. */
const result = (tickets, over = {}) => [{ workspace: 'climative', state: 'ok', tickets, changed: true, ...over }];

/** A filer, reduced to the two things the sweep asks it: the map, and one epic. */
const fakeFiler = (byKey) => ({
  knownFor: () => new Map(Object.entries(byKey).map(([key, id]) => [refFor(key), id])),
  epicFor: (_name, key) => (byKey[key] ? { id: byKey[key], held: true } : null),
});

/** A bead row as `bd show` hands it back. */
const row = (id, { status = 'open', held = true, title = 'TECH-1 — needs doing' } = {}) => ({
  id,
  title,
  status,
  labels: held ? [UNENDORSED, 'jira-ticket'] : ['jira-ticket'],
});

/** `bd`, recording every call, with one row per id. */
function fakeBd({ rows = {}, closeFails = null, showFails = null } = {}) {
  const calls = [];
  return {
    calls,
    rows,
    async show(_ws, id) {
      calls.push(`show ${id}`);
      if (showFails) throw new Error(showFails);
      return rows[id] ? { ...rows[id], labels: [...(rows[id].labels || [])] } : null;
    },
    async close(_ws, id, reason) {
      calls.push(`close ${id}`);
      if (closeFails) throw new Error(closeFails);
      if (rows[id]) rows[id] = { ...rows[id], status: 'closed', reason };
    },
    async comment(_ws, id, text) {
      calls.push(`comment ${id}`);
      rows[id] = { ...(rows[id] || {}), lastComment: text };
    },
    async reopen(_ws, id) {
      calls.push(`reopen ${id}`);
      if (rows[id]) rows[id] = { ...rows[id], status: 'open' };
    },
  };
}

/**
 * JIRA, in the shape lib/atlassian.js calls `fetchImpl` with. `answers` is key → the
 * `resolution` object, and `undefined` means the site 404s that key.
 */
function fakeJira(answers, { fails = null } = {}) {
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    if (fails) throw new Error(fails);
    const key = String(url).split('/issue/')[1]?.split('?')[0] || '';
    if (!(key in answers)) return { ok: false, status: 404, text: async () => JSON.stringify({ errorMessages: ['no such issue'] }) };
    const resolution = answers[key];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ key, fields: { summary: `${key} needs doing`, status: { name: resolution ? 'Done' : 'In Progress' }, resolution } }),
    };
  };
  impl.seen = seen;
  return impl;
}

/** Nothing in `state.json` from the last block. */
const wipeState = () => {
  for (const k of Object.keys(readResolved())) {
    const [workspace, key] = k.split('/');
    forgetResolved(workspace, key);
  }
};

/* ------------------------------------------------------------------ the pure decision */

console.log('\nwhat is owed to an epic, from its row alone');
{
  check('a held epic is closed', actionFor(row('bc-a', { held: true })) === 'close');
  check('an endorsed one is only commented', actionFor(row('bc-a', { held: false })) === 'comment');
  check(
    'a closed one is neither — and is still recorded, so it is asked once and not every tick',
    actionFor(row('bc-a', { status: 'closed' })) === 'already-closed'
  );
  check('a ref pointing at nothing is `gone`', actionFor(null) === 'gone');
  check('and so is a row with no id, which is what a bd that answered oddly looks like', actionFor({ status: 'open' }) === 'gone');
  check(
    'an in-progress held epic is closed like any other',
    actionFor({ ...row('bc-a'), status: 'in_progress' }) === 'close',
    'the hold is the whole of the question — an unendorsed bead nobody may work is not work in flight'
  );

  check('the resolution reader says nothing is resolved when the field is absent', resolutionOf({ fields: {} }).resolved === false);
  check('null resolution is still open — the reassigned case', resolutionOf({ fields: { resolution: null } }).resolved === false);
  check('an object with no name is still resolved', resolutionOf({ fields: { resolution: {} } }).resolved === true);
  check("and the name is carried through", resolutionOf({ fields: { resolution: { name: "Won't Do" } } }).resolution === "Won't Do");
  check('a missing issue altogether is not a resolution', resolutionOf(null).resolved === false);
  check('`resolution` is asked for by name', RESOLUTION_FIELDS.includes('resolution'));
  check('`jira-TECH-1` reads back as `TECH-1`', keyOfRef(refFor('TECH-1')) === 'TECH-1');
  check('and a ref that is not one of ours reads as nothing', keyOfRef('gh-42') === '');

  check('the close reason names the ticket and the resolution', resolvedReason('TECH-1', 'Done').includes('TECH-1') && resolvedReason('TECH-1', 'Done').includes('Done'));
  check('and opens with a fixed prefix, so closed beads read as a class', resolvedReason('TECH-1', 'Done').startsWith(RESOLVED_PREFIX));
  check(
    'which is not the cancel prefix — two different things happened',
    RESOLVED_PREFIX !== CANCELLED_PREFIX,
    'a bead closed with its resolution and one closed by a tap must not read identically'
  );
  check('a site that gave no resolution name still says something', resolvedReason('TECH-1', '').includes('resolved'));
  check(
    'the note on an endorsed epic says it is being left alone',
    /left alone/i.test(resolvedNote('TECH-1', 'Done')) && /once/i.test(resolvedNote('TECH-1', 'Done')),
    'a bare "the ticket is resolved" on a bead with a branch reads as an instruction to stop'
  );
}

/* ------------------------------------------------------------------------- both halves */

console.log('\nthe split — closed if it was never endorsed, told if it was');
await checksAsync('an unendorsed epic is closed, with the resolution in the reason', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-e1': row('bc-e1', { held: true }) } });
  const jira = fakeJira({ 'TECH-1': { name: 'Done' } });
  const sweep = createResolvedSweep({ bd, fetchImpl: jira });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-1': 'bc-e1' }), settings: settingsOk });

  if (out.closed.length !== 1) throw new Error(`closed ${out.closed.length}, wanted 1`);
  if (out.closed[0].resolution !== 'Done') throw new Error(`resolution ${out.closed[0].resolution}`);
  if (!bd.calls.includes('close bc-e1')) throw new Error(`bd calls: ${bd.calls.join(', ')}`);
  if (!String(bd.rows['bc-e1'].reason).startsWith(RESOLVED_PREFIX)) throw new Error(`reason: ${bd.rows['bc-e1'].reason}`);
  if (jira.seen.length !== 1) throw new Error(`${jira.seen.length} JIRA reads for one vanished ticket`);
  if (!jira.seen[0].includes('/issue/TECH-1')) throw new Error(`asked ${jira.seen[0]}`);
});

await checksAsync('an endorsed epic is left alone and commented — never closed', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-e2': row('bc-e2', { held: false }) } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({ 'TECH-2': { name: "Won't Do" } }) });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-2': 'bc-e2' }), settings: settingsOk });

  if (out.closed.length) throw new Error('closed an endorsed epic — beadcause does not undo work because JIRA changed its mind');
  if (out.commented.length !== 1) throw new Error(`commented ${out.commented.length}`);
  if (bd.calls.some((c) => c.startsWith('close'))) throw new Error(`bd calls: ${bd.calls.join(', ')}`);
  if (bd.rows['bc-e2'].status !== 'open') throw new Error('the bead moved');
  if (!/Won't Do/.test(bd.rows['bc-e2'].lastComment)) throw new Error(`comment: ${bd.rows['bc-e2'].lastComment}`);
});

await checksAsync('the tracker decides, not the filer’s map — an epic endorsed since it was read', async () => {
  wipeState();
  // The map says held; the row says otherwise, because it was endorsed on the other
  // machine a minute ago. Closing on the map would close work somebody just approved.
  const bd = fakeBd({ rows: { 'bc-e3': row('bc-e3', { held: false }) } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({ 'TECH-3': { name: 'Done' } }) });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-3': 'bc-e3' }), settings: settingsOk });

  if (out.closed.length) throw new Error('closed a bead the map called held and the tracker called endorsed');
  if (!bd.calls.includes('show bc-e3')) throw new Error('never asked the tracker at all');
});

await checksAsync('an epic already closed is neither closed again nor commented', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-e4': row('bc-e4', { status: 'closed' }) } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({ 'TECH-4': { name: 'Done' } }) });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-4': 'bc-e4' }), settings: settingsOk });

  if (out.closed.length || out.commented.length) throw new Error('wrote to a closed bead');
  if (bd.calls.some((c) => c.startsWith('close') || c.startsWith('comment'))) throw new Error(`bd calls: ${bd.calls.join(', ')}`);
  if (!readResolved()[resolvedKey('climative', 'TECH-4')]) throw new Error('not recorded, so it would be asked again every tick');
});

/* ------------------------------------------- the vanishings that are not a resolution */

console.log('\nfour things vanish, and only one of them is a resolution');
await checksAsync('a ticket whose resolution is null is left completely alone (bc-uz6e)', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-r1': row('bc-r1') } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({ 'TECH-5': null }) });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-5': 'bc-r1' }), settings: settingsOk });

  if (out.closed.length || out.commented.length) throw new Error('acted on a ticket that is merely somebody else’s now');
  if (bd.calls.length) throw new Error(`touched the tracker: ${bd.calls.join(', ')}`);
  if (readResolved()[resolvedKey('climative', 'TECH-5')]) throw new Error('recorded a reassignment as a resolution');
});

await checksAsync('a workspace whose JIRA read failed is skipped outright', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-r2': row('bc-r2') } });
  const jira = fakeJira({ 'TECH-6': { name: 'Done' } });
  const sweep = createResolvedSweep({ bd, fetchImpl: jira });
  // The last good answer is being served, and it happens not to hold TECH-6.
  const out = await sweep.sweep(CFG, [WS], result([], { state: 'failed' }), { filer: fakeFiler({ 'TECH-6': 'bc-r2' }), settings: settingsOk });

  if (jira.seen.length) throw new Error('asked JIRA about a ticket that vanished because JIRA was down');
  if (bd.calls.length || out.closed.length) throw new Error('closed an epic over an outage');
});

await checksAsync('a cancelled ticket vanishes identically and must not be touched', async () => {
  wipeState();
  cancelTicket({ workspace: 'climative', key: 'TECH-7', bead: 'bc-r3' });
  const bd = fakeBd({ rows: { 'bc-r3': row('bc-r3') } });
  const jira = fakeJira({ 'TECH-7': { name: 'Done' } });
  const sweep = createResolvedSweep({ bd, fetchImpl: jira });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-7': 'bc-r3' }), settings: settingsOk });

  if (jira.seen.length) throw new Error('bought a JIRA read for a ticket the cancel already dealt with');
  if (bd.calls.length || out.closed.length) throw new Error('re-closed an epic the cancel closed');
});

await checksAsync('a ticket still in the list is not vanished at all', async () => {
  wipeState();
  const jira = fakeJira({ 'TECH-8': { name: 'Done' } });
  const sweep = createResolvedSweep({ bd: fakeBd(), fetchImpl: jira });
  await sweep.sweep(CFG, [WS], result([ticket('TECH-8')]), { filer: fakeFiler({ 'TECH-8': 'bc-r4' }), settings: settingsOk });
  if (jira.seen.length) throw new Error('asked about a ticket that arrived this very tick');
});

await checksAsync('and a quiet tick costs nothing at all — not even the settings', async () => {
  wipeState();
  let asked = 0;
  const jira = fakeJira({});
  const sweep = createResolvedSweep({ bd: fakeBd(), fetchImpl: jira });
  await sweep.sweep(CFG, [WS], result([ticket('TECH-9')]), {
    filer: fakeFiler({ 'TECH-9': 'bc-r5' }),
    settings: () => {
      asked += 1;
      return SITE;
    },
  });
  if (asked) throw new Error('resolved the site — three `bd config get` spawns — with nothing to ask it');
  if (jira.seen.length) throw new Error('read JIRA on a tick where nothing had vanished');
});

/* -------------------------------------------------------------------- once, and forever */

console.log('\nwritten once');
await checksAsync('a second tick makes no JIRA call and no bd call', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-o1': row('bc-o1') } });
  const jira = fakeJira({ 'TECH-10': { name: 'Done' } });
  const sweep = createResolvedSweep({ bd, fetchImpl: jira });
  const filer = fakeFiler({ 'TECH-10': 'bc-o1' });
  await sweep.sweep(CFG, [WS], result([]), { filer, settings: settingsOk });
  const after = bd.calls.length;
  await sweep.sweep(CFG, [WS], result([]), { filer, settings: settingsOk });

  if (jira.seen.length !== 1) throw new Error(`${jira.seen.length} JIRA reads across two ticks`);
  if (bd.calls.length !== after) throw new Error(`bd was called again: ${bd.calls.join(', ')}`);
});

await checksAsync('and a fresh process reads the record off disk rather than re-deciding', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-o2': row('bc-o2') } });
  const jira = fakeJira({ 'TECH-11': { name: 'Done' } });
  await createResolvedSweep({ bd, fetchImpl: jira }).sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-11': 'bc-o2' }), settings: settingsOk });
  // A new sweep object is a restarted daemon: nothing in memory, everything on disk.
  const fresh = createResolvedSweep({ bd, fetchImpl: jira });
  await fresh.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-11': 'bc-o2' }), settings: settingsOk });
  if (jira.seen.length !== 1) throw new Error(`${jira.seen.length} reads — the record did not survive the restart`);
});

await checksAsync('a bd close that throws leaves the ticket unrecorded, so the next tick retries', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-o3': row('bc-o3') }, closeFails: 'dolt is locked' });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({ 'TECH-12': { name: 'Done' } }) });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-12': 'bc-o3' }), settings: settingsOk });

  if (out.failed.length !== 1) throw new Error(`failed ${out.failed.length}, wanted 1`);
  if (readResolved()[resolvedKey('climative', 'TECH-12')]) throw new Error('recorded a close that never happened');
  if (out.closed.length) throw new Error('reported a close that threw');
  // And on the *next* tick, not in six hours: a lost Dolt lock race is not a still-open
  // answer, and the backoff belongs only to the answer it was written for.
  if (sweep.askedFor('climative', 'TECH-12') !== null) throw new Error('backed off a resolution it had already read');
  bd.calls.length = 0;
  const again = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-12': 'bc-o3' }), settings: settingsOk });
  if (!bd.calls.includes('close bc-o3')) throw new Error(`the next tick did not retry: ${bd.calls.join(', ')}`);
  if (again.failed.length !== 1) throw new Error('the retry was not reported either');
});

await checksAsync('a JIRA read that throws is not an answer of no, and is asked again', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-o4': row('bc-o4') } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({}, { fails: 'the network is down' }) });
  const filer = fakeFiler({ 'TECH-13': 'bc-o4' });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer, settings: settingsOk });

  if (out.failed.length !== 1) throw new Error('a failed read was not reported');
  if (sweep.askedFor('climative', 'TECH-13') !== null) throw new Error('backed off a question it never managed to ask');
  const again = await sweep.sweep(CFG, [WS], result([]), { filer, settings: settingsOk });
  if (again.failed.length !== 1) throw new Error('the next tick did not try again');
});

/* --------------------------------------------------------- the restart hole (bc-0i27.23) */

console.log('\na workspace whose tickets all resolve while the daemon is down');
await checksAsync('the epic still closes on the tick after a restart, off state.json rather than the filer', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-p1': row('bc-p1') } });
  const jira = fakeJira({ 'TECH-60': { name: 'Done' } });
  const sweep = createResolvedSweep({ bd, fetchImpl: jira });
  // Before the restart: the ticket is still live, so nothing has vanished — but a sweep
  // with a non-empty filer map writes its own copy of it down as it goes.
  await sweep.sweep(CFG, [WS], result([ticket('TECH-60')]), { filer: fakeFiler({ 'TECH-60': 'bc-p1' }), settings: settingsOk });
  if (bd.calls.length) throw new Error('touched the tracker before anything had vanished');
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'state.json'), 'utf8'));
  if (raw[SEEN_KEY]?.climative?.[refFor('TECH-60')] !== 'bc-p1') throw new Error(`snapshot: ${JSON.stringify(raw[SEEN_KEY])}`);

  // Restart: a fresh sweep object, and the filer's map comes back empty — `fileFor` never
  // re-reads a workspace whose live ticket list is also empty, which is bc-0i27.23's hole.
  const fresh = createResolvedSweep({ bd, fetchImpl: jira });
  const out = await fresh.sweep(CFG, [WS], result([]), { filer: fakeFiler({}), settings: settingsOk });

  if (out.closed.length !== 1) throw new Error(`closed ${out.closed.length} — the snapshot did not survive the restart`);
  if (bd.rows['bc-p1'].status !== 'closed') throw new Error('the epic never moved');
});

await checksAsync('a non-empty filer map is trusted over whatever the snapshot last said', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-p2': row('bc-p2'), 'bc-p3': row('bc-p3') } });
  const jira = fakeJira({ 'TECH-61': { name: 'Done' } });
  const sweep = createResolvedSweep({ bd, fetchImpl: jira });
  await sweep.sweep(CFG, [WS], result([ticket('TECH-61')]), { filer: fakeFiler({ 'TECH-61': 'bc-p2' }), settings: settingsOk });

  // The next tick's filer map is non-empty and disagrees with what was written down —
  // TECH-61 is gone from it entirely — and it must win outright: a fresh, non-empty read
  // is never second-guessed against a stale snapshot from before it.
  const out = await sweep.sweep(CFG, [WS], result([ticket('TECH-62')]), { filer: fakeFiler({ 'TECH-62': 'bc-p3' }), settings: settingsOk });
  if (out.closed.length) throw new Error('closed an epic the fresh filer map does not even mention any more');
});

await checksAsync('a tick that changes nothing writes nothing to state.json', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-p4': row('bc-p4') } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({}) });
  const filer = fakeFiler({ 'TECH-63': 'bc-p4' });
  const statePath = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'state.json');
  await sweep.sweep(CFG, [WS], result([ticket('TECH-63')]), { filer, settings: settingsOk });
  const before = fs.statSync(statePath).mtimeMs;
  await new Promise((r) => setTimeout(r, 5));
  await sweep.sweep(CFG, [WS], result([ticket('TECH-63')]), { filer, settings: settingsOk });
  if (fs.statSync(statePath).mtimeMs !== before) throw new Error('rewrote the snapshot for a workspace where nothing had moved');
});

await checksAsync('a ticket the site 404s is reported and not recorded', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-o5': row('bc-o5') } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({}) });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-14': 'bc-o5' }), settings: settingsOk });
  if (!out.failed.length) throw new Error('a 404 passed silently');
  if (readResolved()[resolvedKey('climative', 'TECH-14')]) throw new Error('a ticket nobody could read was marked dealt with');
});

/* ------------------------------------------------------------------------ what it costs */

console.log('\nthe two cost guards');
await checksAsync('a still-open answer is backed off, not re-asked every minute', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-c1': row('bc-c1') } });
  const jira = fakeJira({ 'TECH-15': null });
  const sweep = createResolvedSweep({ bd, fetchImpl: jira });
  const filer = fakeFiler({ 'TECH-15': 'bc-c1' });
  const now = 1_000_000;
  await sweep.sweep(CFG, [WS], result([]), { filer, settings: settingsOk, now });
  await sweep.sweep(CFG, [WS], result([]), { filer, settings: settingsOk, now: now + 60_000 });
  if (jira.seen.length !== 1) throw new Error(`${jira.seen.length} reads a minute apart`);

  await sweep.sweep(CFG, [WS], result([]), { filer, settings: settingsOk, now: now + RECHECK_MS });
  if (jira.seen.length !== 2) throw new Error('never asked again — a colleague resolving it would go unnoticed for ever');
});

await checksAsync('one workspace is asked about at most MAX_CHECKS tickets a tick', async () => {
  wipeState();
  const many = {};
  const answers = {};
  const rows = {};
  for (let i = 0; i < MAX_CHECKS + 3; i += 1) {
    many[`TECH-2${i}`] = `bc-m${i}`;
    answers[`TECH-2${i}`] = { name: 'Done' };
    rows[`bc-m${i}`] = row(`bc-m${i}`);
  }
  const jira = fakeJira(answers);
  const sweep = createResolvedSweep({ bd: fakeBd({ rows }), fetchImpl: jira });
  const out = await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler(many), settings: settingsOk });
  if (jira.seen.length !== MAX_CHECKS) throw new Error(`${jira.seen.length} reads in one tick, cap is ${MAX_CHECKS}`);
  if (out.results[0].held !== 3) throw new Error(`held ${out.results[0].held}, wanted 3 — what was left is counted, not dropped`);
});

await checksAsync('a workspace whose site is misconfigured asks nothing and says nothing twice', async () => {
  wipeState();
  const jira = fakeJira({ 'TECH-30': { name: 'Done' } });
  const sweep = createResolvedSweep({ bd: fakeBd(), fetchImpl: jira });
  const out = await sweep.sweep(CFG, [WS], result([]), {
    filer: fakeFiler({ 'TECH-30': 'bc-x1' }),
    settings: () => ({ ...SITE, problem: 'no JIRA credential for climative' }),
  });
  if (jira.seen.length) throw new Error('tried to read a site with no credential');
  if (out.failed.length) throw new Error('reported as a failure what the poller already reports as trouble');
});

/* ------------------------------------------------------------------------- the way back */

console.log('\nthe way back — a resolution can be reversed');
await checksAsync('a returning ticket drops its record and reopens the epic this sweep closed', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-b1': row('bc-b1') } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({ 'TECH-40': { name: 'Done' } }) });
  await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-40': 'bc-b1' }), settings: settingsOk });
  if (bd.rows['bc-b1'].status !== 'closed') throw new Error('never closed it in the first place');

  const out = await sweep.sweep(CFG, [WS], result([ticket('TECH-40')]), { filer: fakeFiler({ 'TECH-40': 'bc-b1' }), settings: settingsOk });
  if (out.restored.length !== 1) throw new Error(`restored ${out.restored.length}`);
  if (bd.rows['bc-b1'].status !== 'open') throw new Error('the epic is still closed and nothing will ever raise another');
  if (readResolved()[resolvedKey('climative', 'TECH-40')]) throw new Error('the record survived the ticket coming back');
  if (!/Reopened/.test(bd.rows['bc-b1'].lastComment)) throw new Error('reopened without saying why');
});

await checksAsync('but an epic that was only commented on is not reopened — it never closed', async () => {
  wipeState();
  const bd = fakeBd({ rows: { 'bc-b2': row('bc-b2', { held: false }) } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({ 'TECH-41': { name: 'Done' } }) });
  await sweep.sweep(CFG, [WS], result([]), { filer: fakeFiler({ 'TECH-41': 'bc-b2' }), settings: settingsOk });
  const before = bd.calls.length;
  const out = await sweep.sweep(CFG, [WS], result([ticket('TECH-41')]), { filer: fakeFiler({ 'TECH-41': 'bc-b2' }), settings: settingsOk });

  if (out.restored.length) throw new Error('reopened a bead that was never closed');
  if (bd.calls.length !== before) throw new Error(`touched the tracker: ${bd.calls.slice(before).join(', ')}`);
  if (readResolved()[resolvedKey('climative', 'TECH-41')]) throw new Error('the record should still be dropped, so a second resolution is noticed');
});

await checksAsync('and one somebody reopened by hand is left exactly where it is', async () => {
  wipeState();
  recordResolved({ workspace: 'climative', key: 'TECH-42', bead: 'bc-b3', action: 'close', resolution: 'Done' });
  const bd = fakeBd({ rows: { 'bc-b3': row('bc-b3', { status: 'open' }) } });
  const sweep = createResolvedSweep({ bd, fetchImpl: fakeJira({}) });
  const out = await sweep.sweep(CFG, [WS], result([ticket('TECH-42')]), { filer: fakeFiler({ 'TECH-42': 'bc-b3' }), settings: settingsOk });

  if (bd.calls.some((c) => c.startsWith('reopen'))) throw new Error('reopened a bead that was already open');
  if (out.restored.length) throw new Error('reported a reopen that did not happen');
});

/* ------------------------------------------------------------------------- the record */

console.log('\nthe record');
{
  wipeState();
  recordResolved({ workspace: 'climative', key: 'TECH-50', bead: 'bc-s1', action: 'close', resolution: 'Done' });
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'state.json'), 'utf8'));
  check('it lands under its own key in state.json', Boolean(raw[STATE_KEY]?.['climative/TECH-50']));
  check('keyed by the ticket, never by the bead', resolvedKey('climative', 'TECH-50') === 'climative/TECH-50');
  check('a record with no key at all is refused', recordResolved({ workspace: 'climative', key: '' }) === null);
  check('and one that is not an object is dropped on read', Object.keys(readResolved()).length === 1);
  check('forgetting it hands back what was dropped', forgetResolved('climative', 'TECH-50')?.bead === 'bc-s1');
  check('and forgetting nothing is null rather than an error', forgetResolved('climative', 'TECH-50') === null);
  wipeState();
}

/* ------------------------------------------------------------------------- the wiring */

console.log('\nwired into the poll cycle');
{
  const server = fs.readFileSync(LIB('server.js'), 'utf8');
  check('the sweep is created beside the filer', /createResolvedSweep\(\{ bd \}\)/.test(server));
  check('and it is on the app, so a test can reach it', /return \{[^}]*\bjiraResolved\b/.test(server));
  check(
    'it is handed the unfiltered results, not the cancel-filtered ones',
    /app\.jiraResolved\?\.sweep\(cfg, cfg\.workspaces, out\.results/.test(server),
    '`live` has cancelled tickets taken out of it, and a ticket missing from the list is exactly what this reads as vanished'
  );
  check('it is handed the filer, which is the only thing that knows which epic', /filer: app\.jiraEpics/.test(server));
  check(
    'and the poller’s settings, so the by-key read reuses the ten-minute memo',
    /settings: \(workspace\) => app\.jira\.settings\(cfg, workspace\)/.test(server)
  );
  check(
    'the endorsement queue’s cache is dropped when a bead moved',
    /if \(resolved\.closed\.length \|\| resolved\.restored\.length\) forgetQueue\(\)/.test(server),
    'that screen draws held beads, and would go on offering approve on a closed one'
  );
  check(
    'and no bus event — a held bead is out of every queue and every count',
    !/emit\(\{ type: 'jira-resolved'/.test(server),
    'an event here would wake every parked phone to redraw an identical inbox'
  );

  const poll = fs.readFileSync(LIB('jirapoll.js'), 'utf8');
  check('the poller exposes its memoised settings rather than a second resolution', /settings\(cfg, workspace\) \{\s*return settingsFor\(memoBd/.test(poll));

  const epic = fs.readFileSync(LIB('jiraepic.js'), 'utf8');
  check(
    'and lib/jiraepic.js no longer claims nothing reacts to a vanished ticket',
    /lib\/jiraresolved\.js/.test(epic),
    'that header said "nothing sweeps for epics whose ticket has gone", which is now only true of that file'
  );

  const readme = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8');
  check('the README has a section for it', /### A ticket that is resolved/.test(readme));
  check('which says both halves of the split', /still unendorsed → close it/i.test(readme) && /has been endorsed → leave it completely alone/i.test(readme));
}

console.log(failures ? `\n${failures} failed` : '\nall good');
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
