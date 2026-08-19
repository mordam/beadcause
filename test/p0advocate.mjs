#!/usr/bin/env node
/**
 * The way back in: a P0 card that has an advocate on it says where that advocate is.
 *
 *     npm test
 *     node test/p0advocate.mjs
 *
 * bc-d6yk. The card had one control — "Put an advocate on it" — and after you pressed it
 * the card said nothing at all: the button's own text was the only record of the launch,
 * the next poll rebuilt it into the same offer, and pressing it again was a 409. The
 * window you had just opened was findable only from the advocate console, which is the
 * screen you were not on.
 *
 * Three properties, and the middle one is the reason this is a function rather than a
 * `find` inlined into the card:
 *
 * 1. **The pid is matched with `namesBead`, not `includes`.** Every parent id is a prefix
 *    of its children's, so a worker on `bc-d6yk.1` matched `bc-d6yk` and the card would
 *    have linked you into somebody else's window — the exact failure lib/reap.js's
 *    `namesBead` was written for, arriving somewhere new. The launch door had the same
 *    bug in the other direction: it refused an advocate on a P0 because a child of it had
 *    a session open.
 * 2. **"Opening" is a state and it expires.** A window carries no bead id in its name
 *    until its first turn has run, so for about a minute after the launch there is
 *    nothing on disk to find. Remembering the launch covers that gap; the ten-minute
 *    lapse covers the launch that died before it ever named itself, which would otherwise
 *    leave a card whose only control had been taken away for good.
 * 3. **The card and the door agree.** They are one rule read twice, and the failure of
 *    disagreeing is specific: a card that offers a button whose only outcome is a refusal.
 *    There are two doors now rather than one — bc-goo.15 gave the advocate an automatic
 *    re-entry on child events (lib/reenter.js) — so the "opening" record is module state
 *    shared by both, and both are asserted to write it.
 *
 * The wiring is asserted against the source, the way test/beadsession.mjs asserts that
 * page never makes a non-GET. A unit test of `advocateSession` passes just as happily
 * against a `rootCard` that never calls it, and "the field reaches the card" is the whole
 * of what was asked for.
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
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-p0adv-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { ADVOCATE_LABEL, advocacyOn, advocateSession, OPENING_TTL_MS, PAUSED_LABEL, WAITING_OPEN, WAITING_CLOSE } =
  await import(LIB('epicadvocate.js'));

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
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

/** A live session record, as lib/claude.js hands them over. */
const session = (pid, name, extra = {}) => ({ pid, name, status: 'busy', at: null, ...extra });

/* ------------------------------------------------------------- who is on it */

check('a live session naming the P0 is the advocate, with the pid to link to', () => {
  const found = advocateSession([session(4242, 'Beadcause - bc-d6yk the P0 card')], 'bc-d6yk');
  assert.equal(found.pid, 4242);
  assert.equal(found.opening, false, 'a window that is up is not opening');
  assert.equal(found.status, 'busy', 'the card draws a busy advocate differently from a quiet one');
});

check('a session on a *child* is not the advocate on its parent', () => {
  // The whole reason this goes through `namesBead`. `bc-d6yk` is a prefix of `bc-d6yk.1`,
  // so `includes` says yes and the card links you into a worker's window.
  assert.equal(advocateSession([session(7, 'Beadcause - bc-d6yk.1 a child')], 'bc-d6yk'), null);
  // And the other direction: a bare parent id must not answer for a suffixed one.
  assert.equal(advocateSession([session(7, 'Beadcause - bc-d6yk parent')], 'bc-d6yk.1'), null);
});

check('an id sitting inside a longer word is not a match either', () => {
  assert.equal(advocateSession([session(7, 'Beadcause - bc-d6ykx something else')], 'bc-d6yk'), null);
});

check('nobody on it is null — which is the card offering the button', () => {
  assert.equal(advocateSession([], 'bc-d6yk'), null);
  assert.equal(advocateSession(null, 'bc-d6yk'), null, 'no session list at all must not throw');
  assert.equal(advocateSession([session(7, '')], 'bc-d6yk'), null, 'an unnamed window says nothing');
});

/* ------------------------------------------------------------ the launch gap */

check('a launch with no window yet reads as opening, with no pid', () => {
  const now = 1_000_000;
  const found = advocateSession([], 'bc-d6yk', { openedAt: now - 5_000, now });
  assert.equal(found.opening, true);
  assert.equal(found.pid, null, 'there is nothing to link to yet, and a link to nothing is worse than none');
});

check('the window wins over the memory of launching it', () => {
  const now = 1_000_000;
  const found = advocateSession([session(99, '🧭 bc-d6yk · beadcause')], 'bc-d6yk', { openedAt: now - 5_000, now });
  assert.equal(found.pid, 99);
  assert.equal(found.opening, false);
});

check('opening lapses, so a launch that died gives the button back', () => {
  const now = 1_000_000;
  assert.equal(advocateSession([], 'bc-d6yk', { openedAt: now - OPENING_TTL_MS, now }), null);
  assert.ok(advocateSession([], 'bc-d6yk', { openedAt: now - OPENING_TTL_MS + 1000, now }), 'just inside still holds');
});

/* ------------------------------------------------- what the card is told, bc-r2b5.1 */

/**
 * `advocate` alone was a boolean wearing a session's clothes, and the steady state of a
 * correctly-advocated epic was `null` — an Epic Advocate takes a turn and exits, so between
 * turns there is nothing running to find and the card drew the offer to assign it. These
 * cases are the six fields that make "assigned and idle" a state the card can say.
 */
const epic = (over = {}) => ({ id: 'bc-r2b5', title: 'an epic', status: 'open', labels: [], notes: '', ...over });
const waitingNote = (line) => `${WAITING_OPEN}\n${line}\n${WAITING_CLOSE}`;

check('assigned is true between turns, when no window is running at all', () => {
  const out = advocacyOn(epic({ labels: [ADVOCATE_LABEL] }), { record: { at: '2026-08-17T09:40:00Z', hold: null } });
  assert.equal(out.assigned, true, 'this is the bead: idle is not unassigned');
  assert.equal(out.session, null);
  assert.equal(out.by, 'label');
  assert.equal(out.lastAt, '2026-08-17T09:40:00Z', 'and "idle since 09:40" is a different card from "idle since a fortnight"');
  assert.equal(out.hold, null, 'nothing is being held — there was simply nothing to come back for');
});

check('the carrier is named, because the two have different un-assign gestures', () => {
  assert.equal(advocacyOn(epic({ notes: waitingNote('the merge queue') })).by, 'waiting');
  assert.equal(advocacyOn(epic({ labels: [ADVOCATE_LABEL] })).by, 'label');
  // The label wins when both are there: it is the one a control would remove.
  assert.equal(advocacyOn(epic({ labels: [ADVOCATE_LABEL], notes: waitingNote('review') })).by, 'label');
  const none = advocacyOn(epic());
  assert.equal(none.by, null);
  assert.equal(none.assigned, false, 'and an epic nobody has ever assigned still gets the offer');
});

check('paused is its own state, not an absence of one', () => {
  const out = advocacyOn(epic({ labels: [ADVOCATE_LABEL, PAUSED_LABEL] }));
  assert.equal(out.assigned, true);
  assert.equal(out.paused, true, 'assigned and stopped is a fourth state, and drawing it as either of the other two is wrong');
});

check('the hold is the sweep’s own sentence, with when it was decided', () => {
  const out = advocacyOn(epic({ labels: [ADVOCATE_LABEL] }), {
    record: { at: '2026-08-17T09:40:00Z', hold: { why: 'it is paused', at: '2026-08-17T11:00:00Z' } },
  });
  assert.equal(out.hold, 'it is paused');
  assert.equal(out.heldAt, '2026-08-17T11:00:00Z');
  // Three of the five reasons — the tick's one-window budget, a worker this advocate is
  // holding, a lease on another Mac — cannot be seen from a request path at all, which is
  // why this is reported rather than re-derived beside the card.
  assert.equal(advocacyOn(epic(), { record: null }).hold, null, 'no advocate in this workspace holds nothing');
});

check('the session is passed through rather than recomputed', () => {
  // So `advocate` and `advocacy.session` on the same card cannot disagree about whether a
  // window is up — one `advocateSession` call, two fields.
  const live = { pid: 42, name: 'Beadcause - bc-r2b5', status: 'idle', at: null, opening: false };
  assert.deepEqual(advocacyOn(epic({ labels: [ADVOCATE_LABEL] }), { session: live }).session, live);
});

check('finished is passed in, so this file stays a pure function of its arguments', () => {
  assert.equal(advocacyOn(epic()).finished, false, 'and it defaults to the claim nobody has made');
  assert.equal(advocacyOn(epic(), { finished: true }).finished, true);
});

check('every field is present on every answer, null rather than absent', () => {
  // The client half draws four states off these; a field that is sometimes missing and
  // sometimes null is a field every reader has to guard twice.
  assert.deepEqual(Object.keys(advocacyOn(epic())).sort(), [
    'assigned',
    'by',
    'finished',
    'heldAt',
    'hold',
    'lastAt',
    'paused',
    'session',
  ]);
});

/* ---------------------------------------------------------------- the wiring */

check('the card is actually given it', () => {
  const src = read('lib', 'server.js');
  // Hoisted to a `const` since bc-r2b5.1, because `advocacy` beside it needs the same
  // answer and two calls could disagree — so this pins the one call and both readers of
  // it rather than the inline expression it used to be.
  assert.match(
    src,
    /const session = advocateSession\(sessions, bead\.id, \{ openedAt: openedRecently\(/,
    'rootCard must still match its sessions its own way'
  );
  assert.match(src, /\n      advocate: session,/, 'rootCard must carry the advocate field');
  assert.match(src, /advocacy: advocacyOn\(bead, \{/, 'and the state the card is drawn from since bc-r2b5.1');
  assert.match(src, /record: advocates\.advocacy\(workspace, bead\.id\)/, 'including what the sweep last decided');
  assert.match(src, /finished: alreadyAsked\(bead\)/, 'and whether the finished-epic sweep has already asked');
  // Matched on the last argument rather than the whole call: bc-rfnr.9.1 re-keyed this
  // off a children index while this bead was in flight, and a test that pins every
  // argument of somebody else's function fails on their change rather than on ours.
  assert.match(src, /cards\.push\(rootCard\([^)]*, sessions\)\)/, 'the board must hand its snapshot down');
  assert.match(src, /const sessions = liveSessions\(cfg\);/, 'one read per board, not one per card');
});

check('the launch door and the card read the same rule', () => {
  const src = read('lib', 'server.js');
  const route = src.slice(src.indexOf("if (p === '/api/bead/advocate'"));
  assert.ok(!/name \|\| ''\)\.includes\(id\)/.test(route), 'the prefix-matching refusal is what this replaced');
  assert.match(route.slice(0, 2000), /advocateSession\(liveSessions\(cfg\), id/);
  assert.match(route.slice(0, 3000), /rememberAdvocateOpened\(/, 'a launch that worked has to be remembered');
  // bc-r2b5.1: and the tap is the assignment. `rememberAdvocateOpened` is module state
  // that dies with the process and covers the minute before the window names itself; this
  // is the durable half, on the bead, and it is what lib/reenter.js enrols on. Asserted to
  // be *after* the launch — an epic enrolled by a launch that was refused is one the sweep
  // would re-argue every three hours for ever.
  const stamp = route.indexOf(`bd.addLabel(ws, id, ADVOCATE_LABEL)`);
  assert.ok(stamp > 0, 'the button no longer records the assignment — this is bc-r2b5.1 regressing');
  assert.ok(route.indexOf('await openEpicAdvocateSession(') < stamp, 'the assignment is recorded after the window is up');
});

check('and so does the other door, through the same record', () => {
  // bc-goo.15 gave this a second caller: lib/reenter.js's sweep re-opens the advocate on
  // child events, from the advocate tick. The record of "a window is on its way up" is
  // module state in lib/epicadvocate.js rather than a `Map` in lib/server.js for exactly
  // that reason — a card that showed "opening" for the button's launch and re-offered the
  // button for the sweep's would be offering a control whose only outcome is a 409.
  const adv = read('lib', 'advocate.js');
  assert.match(adv, /rememberAdvocateOpened\(`\$\{a\.name\}\/\$\{epic\.id\}`\)/, 'the sweep forgets its own launch');
  assert.match(adv, /advocateSession\(sessions, epic\.id, \{ openedAt: openedRecently\(/, 'and it refuses a second one by the same rule');
  const epicadv = read('lib', 'epicadvocate.js');
  assert.match(epicadv, /const OPENED = new Map\(\)/, 'the record has moved back into one importer');
});

check('the card links to the session page, and only when there is a pid', () => {
  const app = read('public', 'app.js');
  const control = app.slice(app.indexOf('function p0Control('), app.indexOf('function p0SectionHtml('));
  assert.match(control, /adv\?\.pid/, 'the link is gated on a pid');
  assert.match(control, /\/session\?pid=\$\{encodeURIComponent\(adv\.pid\)\}/);
  assert.match(control, /disabled/, 'the opening state offers nothing to press');
  assert.match(control, /data-act="advocate"/, 'and the offer itself is still there');
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
