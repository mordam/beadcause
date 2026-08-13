#!/usr/bin/env node
/**
 * The cancel earmark — the one record in this app that is not allowed to expire.
 *
 *     npm test
 *     node test/jiracancel.mjs
 *
 * A JIRA ticket assigned to you comes back every minute, forever, and gets one held epic
 * on the way past (lib/jiraepic.js). Cancel is the answer that says this ticket does not
 * need a bead at all — and the whole of whether it works is whether the record outlives
 * everything that would otherwise un-make it.
 *
 * Five things, and each of them is a way the feature turns into a loop rather than a bug:
 *
 * 1. **Keyed by the ticket, never by the bead.** A ticket can be cancelled in the minute
 *    between arriving and its epic being filed — or on a machine whose `bd create` has
 *    been failing all morning — so a record keyed on a bead id would be a record that
 *    could not be written for exactly the tickets most in need of one. Beadify has to
 *    find it with nothing in hand but the ticket.
 * 2. **It survives a restart**, which here means: it is in `state.json` on disk, not in
 *    a map in a process. Asserted against the file rather than against the module,
 *    because a getter that answers correctly out of memory is what a restart breaks.
 * 3. **It is not pruned when the row leaves the inbox.** This is the one that separates
 *    it from `quiet` and `ringing`, and it is the loop: JIRA goes on saying the ticket is
 *    assigned to you, so a record dropped because the row went away is un-cancelled by
 *    the very next sweep — every minute, forever. The check walks a ticket out of the
 *    list and back into it.
 * 4. **Both halves are filtered.** The row on the screen *and* the ticket list the epic
 *    filer is about to act on. Filtering only the first would leave a cancel that hid a
 *    ticket while quietly filing it a fresh bead on every restart, which reads as working
 *    right up until you look at the tracker.
 * 5. **It is reversible**, which is what lets it be this absolute. Beadify lifts it and
 *    the ticket is a row again.
 *
 * No `bd`, no network: this file is `state.json` and two filters. The acts that read it —
 * approve, cancel, beadify and the routes behind them — are `test/jiragate.mjs`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-jiracancel-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { STATE_PATH, loadState, saveState } = await import(LIB('config.js'));
const {
  STATE_KEY,
  cancelKey,
  cancelTicket,
  cancelledKeys,
  cancelledRecord,
  isCancelled,
  liveResults,
  liveTickets,
  readCancelled,
  uncancelTicket,
} = await import(LIB('jiracancel.js'));

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

/** Start every check from an empty earmark list without touching the rest of state. */
const reset = () => saveState({ [STATE_KEY]: {} });

/** One ticket, in the shape lib/jirapoll.js holds them. */
const ticket = (workspace, key, extra = {}) => ({
  workspace,
  key,
  summary: `about ${key}`,
  status: 'To Do',
  updated: '2026-08-13T10:00:00Z',
  url: `https://x.atlassian.net/browse/${key}`,
  ...extra,
});

console.log('\nthe cancel earmark\n');

/* ------------------------------------------------------------------ the key */

check('it is keyed by the ticket, so a ticket with no bead can still be cancelled', () => {
  reset();
  const rec = cancelTicket({ workspace: 'alpha', key: 'TECH-1' });
  assert.equal(rec.bead, null, 'no bead is a real answer — the epic may not have been filed yet');
  assert.equal(isCancelled('alpha', 'TECH-1'), true);
  assert.equal(cancelledRecord('alpha', 'TECH-1').key, 'TECH-1', 'found with nothing but the ticket in hand');
});

check('two workspaces pointed at one project do not cancel each other', () => {
  reset();
  cancelTicket({ workspace: 'alpha', key: 'TECH-1' });
  assert.equal(isCancelled('alpha', 'TECH-1'), true);
  assert.equal(isCancelled('beta', 'TECH-1'), false, 'JIRA is configured per workspace and so is the decision');
  assert.equal(cancelKey('beta', 'TECH-1'), 'beta/TECH-1');
});

check('cancelling again keeps the record that can be reversed', () => {
  reset();
  cancelTicket({ workspace: 'alpha', key: 'TECH-1' });
  const again = cancelTicket({ workspace: 'alpha', key: 'TECH-1', bead: 'aa-epic' });
  assert.equal(again.bead, 'aa-epic', 'the second tap knew the bead id the first did not');
  assert.equal(Object.keys(readCancelled()).length, 1, 'and it replaced the record rather than adding one');
});

/* -------------------------------------------------------------- the restart */

check('it is on disk, which is the whole of surviving a restart', () => {
  reset();
  cancelTicket({ workspace: 'alpha', key: 'TECH-1', bead: 'aa-epic', by: 'adam' });
  // Read the file rather than the module: an answer that is only right in memory is
  // exactly what a daemon restart takes away.
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert.deepEqual(Object.keys(raw[STATE_KEY]), ['alpha/TECH-1']);
  assert.equal(raw[STATE_KEY]['alpha/TECH-1'].bead, 'aa-epic');
  assert.equal(raw[STATE_KEY]['alpha/TECH-1'].by, 'adam');
});

check('and a junk field reads as nothing cancelled rather than everything', () => {
  reset();
  // The permissive direction on purpose: the failure it produces is a ticket coming back
  // onto a screen where you can cancel it again, never one that silently never appears.
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ...loadState(), [STATE_KEY]: 'nonsense' }));
  assert.deepEqual(readCancelled(), {});
  reset();
  saveState({ [STATE_KEY]: { 'alpha/': { workspace: 'alpha' }, ok: { workspace: 'a', key: 'B-1' } } });
  assert.deepEqual(Object.keys(readCancelled()), ['ok'], 'a record naming no ticket can match nothing, so it goes');
});

/* --------------------------------------------------------- it does not expire */

check('a ticket that leaves the inbox and comes back is still cancelled', () => {
  reset();
  cancelTicket({ workspace: 'alpha', key: 'TECH-1' });
  // Gone from JIRA's answer for a while — reassigned, or the site was down.
  assert.deepEqual(liveTickets([ticket('alpha', 'TECH-2')]).map((t) => t.key), ['TECH-2']);
  // And back. This is the sweep that would file it a second epic if anything here
  // expired: nothing pruned the record while the row was away, because nothing here
  // prunes at all.
  const back = liveTickets([ticket('alpha', 'TECH-1'), ticket('alpha', 'TECH-2')]);
  assert.deepEqual(back.map((t) => t.key), ['TECH-2'], 'still cancelled, with no clock anywhere in it');
});

check('the epic filer is filtered too, not only the screen', () => {
  reset();
  cancelTicket({ workspace: 'alpha', key: 'TECH-1' });
  const results = [
    { workspace: 'alpha', state: 'ok', tickets: [ticket('alpha', 'TECH-1'), ticket('alpha', 'TECH-2')] },
    { workspace: 'beta', state: 'ok', tickets: [ticket('beta', 'TECH-1')] },
  ];
  const live = liveResults(results);
  assert.deepEqual(live[0].tickets.map((t) => t.key), ['TECH-2'], 'no epic is raised for a cancelled ticket');
  assert.deepEqual(live[1].tickets.map((t) => t.key), ['TECH-1'], 'and the other workspace is untouched');
  assert.deepEqual(results[0].tickets.length, 2, 'the poller’s own answer is not mutated under it');
});

check('with nothing cancelled both filters hand the list straight back', () => {
  reset();
  const tickets = [ticket('alpha', 'TECH-1')];
  assert.equal(liveTickets(tickets), tickets, 'the same array — a payload every parked phone rebuilds');
  const results = [{ workspace: 'alpha', tickets }];
  assert.equal(liveResults(results), results);
  assert.equal(cancelledKeys().size, 0);
});

/* ------------------------------------------------------------- and it reverses */

check('beadify lifts it, and the record it hands back names the bead to reopen', () => {
  reset();
  cancelTicket({ workspace: 'alpha', key: 'TECH-1', bead: 'aa-epic' });
  const lifted = uncancelTicket('alpha', 'TECH-1');
  assert.equal(lifted.bead, 'aa-epic', 'which is how beadify knows what to reopen rather than re-file');
  assert.equal(isCancelled('alpha', 'TECH-1'), false);
  assert.deepEqual(liveTickets([ticket('alpha', 'TECH-1')]).map((t) => t.key), ['TECH-1'], 'a row again');
  assert.equal(uncancelTicket('alpha', 'TECH-1'), null, 'and a ticket that was never away is null, not an error');
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
