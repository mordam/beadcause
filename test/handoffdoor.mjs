#!/usr/bin/env node
/**
 * The third door: `POST /api/handoff`, and the brief it sends.
 *
 *     npm test
 *     node test/handoffdoor.mjs
 *
 * bc-s336, out of bc-ol4d. The `/handoff` skill on this Mac used to end by driving iTerm
 * with AppleScript; it now asks the local daemon to open the successor and falls back to
 * the script when no daemon answers. The question bc-ol4d was filed to settle is *which
 * door*, and the answer was neither of the two that already existed — which is the whole
 * of what this pins, because both wrong answers look right from the outside:
 *
 * 1. **`POST /api/bead/advocate` refuses every handoff, and always has.** `wantsAdvocate`
 *    needs a *root* — an epic at any priority, or a P0 — carrying an owner (an `owner:`
 *    label, lib/ownership.js); the skill files handoffs `--type=task --priority=1
 *    --labels=handoff` and never claims them, *on purpose* — a handoff is the top of the
 *    next session's queue, not an epic on the board. So that door is a 409 for every
 *    handoff there has ever been. This is asserted against `wantsAdvocate` itself rather
 *    than described, because the day somebody relaxes that gate is the day this door stops
 *    being needed and nothing else would say so.
 *
 *    **bc-htoy relaxed exactly half of it and this is where that was checked.** Epics no
 *    longer need to be P0 to be owned or advocated — but a handoff is a `task`, so it is
 *    still turned away, and the assertions below pin both halves: the widening reaches a
 *    P1 epic and stops short of a P1 task.
 * 2. **`POST /api/session` would take it and brief it wrong**, which is worse. `promptFor`
 *    says "don't answer it on my behalf … we'll decide together" and ends by telling the
 *    session to `bd close` the bead `--reason "Answered in a Claude session"`. A successor
 *    briefed that way *discusses* the handoff and marks it answered instead of doing the
 *    work it describes — a failure that reads as success from every screen. So the two
 *    briefs are asserted to be different in exactly that respect: this one must not carry
 *    the discuss-and-close instructions, and must carry the claim-and-continue ones.
 * 3. **The brief is the words the fallback has been sending all along.** `open-handoff.sh`
 *    lives outside this repo (and outside every checkout of it), so there is nothing here
 *    to diff it against; what is pinned instead are the four load-bearing sentences, so a
 *    rewrite that drops one fails here rather than in a session six hours later that
 *    quietly did the wrong thing. The `--json | jq` form is one of them: bare `bd show`
 *    pretty-prints the description and eats the backticks, fences and long paths a handoff
 *    exists to hand over.
 *
 * The route's own guards are asserted against the source, the way test/p0advocate.mjs
 * asserts its wiring: every path through this door either opens an iTerm window or is a
 * refusal, so there is nothing here it would be honest to call and assert the result of.
 * A test that started the real server and posted to it would open a window on whoever ran
 * `npm test`.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-handoffdoor-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { handoffPromptFor } = await import(LIB('session.js'));
const { wantsAdvocate } = await import(LIB('epicadvocate.js'));

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

/**
 * A handoff bead exactly as `/handoff` Step 2 files it: `--type=task --priority=1
 * --labels=handoff`, never `--claim`ed. Note ownership here is an `owner:<handle>` label
 * (lib/ownership.js) and not the `assignee` field — a bead can be assigned and still
 * unowned, and `wantsAdvocate` asks for the label.
 */
const handoffBead = (over = {}) => ({
  id: 'bc-hb7j',
  title: 'Handoff — /handoff should ask the local beadcause to open the successor',
  type: 'task',
  priority: 1,
  status: 'open',
  labels: ['handoff'],
  ...over,
});

/* ------------------------------------------- why neither existing door would do */

check('the advocate door refuses a handoff, on both counts', () => {
  const bead = handoffBead();
  assert.equal(wantsAdvocate(bead), false, 'a P1 task with no owner is not advocatable');
  assert.equal(wantsAdvocate({ ...bead, priority: 0 }), false, 'still not — nobody owns it');
  assert.equal(
    wantsAdvocate({ ...bead, labels: ['handoff', 'owner:adam'] }),
    false,
    'still not — it is a task, and bc-htoy widened the gate to epics rather than to everything owned'
  );
  // And the pair together is what the skill would have to file to get in, which is the
  // change bc-ol4d rejected: it would put every handoff on the board, owned, forever.
  assert.equal(wantsAdvocate({ ...bead, priority: 0, labels: ['handoff', 'owner:adam'] }), true);
  // The other way in since bc-htoy, and the one that must *not* let a handoff through:
  // being an epic is enough at any priority, so the type is now the whole of what turns
  // this bead away. A regression that read the type loosely would show up right here.
  assert.equal(
    wantsAdvocate({ ...bead, type: 'epic', labels: ['handoff', 'owner:adam'] }),
    true,
    'a P1 epic with an owner is advocatable — that is bc-htoy'
  );
  assert.equal(
    wantsAdvocate({ ...bead, issue_type: 'epic', labels: ['handoff', 'owner:adam'] }),
    true,
    'and by `issue_type` too, which is the spelling a bd export carries'
  );
});

check('the handoff brief is not the discuss-a-question brief', () => {
  const brief = handoffPromptFor('beadcause', 'bc-hb7j');
  // The three sentences `promptFor` sends that would turn a successor into a discussion.
  assert.ok(!/don't answer it on my behalf/i.test(brief), 'a handoff is work, not a question to weigh in on');
  assert.ok(!/we'll decide together/i.test(brief));
  assert.ok(!/Answered in a Claude session/.test(brief), 'a successor must never close its handoff as answered');
  assert.ok(!/bd close /.test(brief), 'and must not be told to close it at all — the work decides that');
});

/* --------------------------------------------------- what the successor is told */

check('read it, claim it, continue from Next action', () => {
  const brief = handoffPromptFor('beadcause', 'bc-hb7j');
  assert.match(brief, /bd show bc-hb7j --json \| jq -r '\.\[0\]\.description'/, 'the byte-exact read');
  assert.match(brief, /bd update bc-hb7j --claim/, 'the successor claims the handoff it was opened for');
  assert.match(brief, /## Next action/, 'and continues from the one section that says what to do');
  assert.match(brief, /UNVERIFIED/, 'a claim the handoff marked unverified is verified before it is relied on');
  assert.match(brief, /beadcause\/bc-hb7j/, 'the workspace is named, so `bd` in the window is unambiguous');
});

check('bare `bd show` is warned off by name, not just avoided', () => {
  const brief = handoffPromptFor('beadcause', 'bc-hb7j');
  // The reason travels with the instruction: a session told only "use --json" reaches for
  // the shorter command the moment the longer one is inconvenient. What it eats — the
  // backticks, the fences, the hard wrap — is the whole content of a handoff.
  assert.match(brief, /never with a bare `bd show`/i);
  assert.match(brief, /hard-wraps/);
});

check('the session names itself after the handoff', () => {
  assert.match(handoffPromptFor('beadcause', 'bc-hb7j'), /Name this session "Beadcause - handoff bc-hb7j"/);
  assert.match(handoffPromptFor('sophab', 'sp-1a2'), /Name this session "Sophab - handoff sp-1a2"/);
});

check('a multi-repo workspace tells the window which checkout it is', () => {
  const plain = handoffPromptFor('architecture', 'cl-4o4');
  assert.ok(!/checkout/.test(plain), 'a single-repo workspace says nothing about repos');
  const scoped = handoffPromptFor('architecture', 'cl-4o4', { name: 'athena-service', token: 'athena-service' });
  assert.match(scoped, /athena-service/, 'and a scoped one names it');
  assert.match(scoped, /bd update cl-4o4 --claim/, 'without displacing the instructions');
});

/* ------------------------------------------------------------------ the wiring */

check('the route exists and is a POST', () => {
  const src = read('lib', 'server.js');
  assert.match(src, /if \(p === '\/api\/handoff' && req\.method === 'POST'\)/);
  assert.match(src, /openHandoffSession,/, 'and the opener is imported rather than reimplemented here');
});

check('the guards, in the order a refusal is cheapest', () => {
  const src = read('lib', 'server.js');
  const route = src.slice(src.indexOf("if (p === '/api/handoff'"));
  const door = route.slice(0, route.indexOf('/api/terminals'));
  assert.match(door, /cfg\.openSessions === false/, 'this door opens a session, so the switch applies to it');
  assert.match(door, /if \(OBSERVING\)/, 'an observer instance must not open windows on another Mac');
  assert.match(door, /BEAD_ID_RE\.test\(id\)/, 'nothing that is not a bead id goes near a command line');
  assert.match(door, /=== 'handoff'/, 'and the brief is only true of a handoff');
});

check('a bead that is gone is a 404, not a 500 with bd’s command line in it', () => {
  const src = read('lib', 'server.js');
  const route = src.slice(src.indexOf("if (p === '/api/handoff'"));
  const door = route.slice(0, route.indexOf('/api/terminals'));
  // This shipped wrong once and nothing noticed, which is the argument for pinning it.
  // `bd.show` **throws** for an id bd does not have — it does not resolve null — so the
  // `if (!issue) return 404` this door was written with was dead code, and a missing bead
  // came back 500 with bd's whole command line in the body, the actor's email address
  // included. Verified live against the running daemon on 2026-08-14 before the fix.
  //
  // The caller falls back to iTerm on any non-200, so the wrong status changed no
  // behaviour and would have sat there indefinitely. `loadBead` (lib/verdict.js) is the
  // one place bd's two spellings of "no such bead" are known, and the advocate door
  // already reads through it.
  assert.match(door, /await loadBead\(bd, ws, id\)/, 'the read goes through loadBead');
  assert.ok(!/await bd\.show\(ws, id\)/.test(door), 'and never a bare bd.show, whose null branch cannot fire');
});

check('never two successors on one handoff', () => {
  const src = read('lib', 'server.js');
  const route = src.slice(src.indexOf("if (p === '/api/handoff'"));
  const door = route.slice(0, route.indexOf('/api/terminals'));
  // The same rule the P0 door uses and for the same reason — `advocateSession` asks "is a
  // live session named after this bead, or did we launch one in the last minute", which
  // has nothing to do with advocacy. A `/handoff` retried through a slow launch must not
  // get a second window onto the same work.
  assert.match(door, /advocateSession\(liveSessions\(cfg\), id/);
  assert.match(door, /rememberAdvocateOpened\(/, 'a launch that worked has to be remembered');
  assert.match(door, /already\.opening/, 'and the minute before it names itself is a state, not a free second window');
});

check('it endorses, like the door beside it', () => {
  const src = read('lib', 'server.js');
  const route = src.slice(src.indexOf("if (p === '/api/handoff'"));
  const door = route.slice(0, route.indexOf('/api/terminals'));
  // A handoff bead was filed by an agent moments ago, so it is held (lib/endorse.js). The
  // person who ran `/handoff` is present and asking; sending them to the endorsement queue
  // to release their own successor would be absurd.
  assert.match(door, /await endorse\(bd, ws, issue\)/);
});

check('the window is a worker session, not an agent one', () => {
  const src = read('lib', 'session.js');
  const fn = src.slice(src.indexOf('export async function openHandoffSession('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /resolveSessionRepo\(cfg, workspace, bead\)/, "the bead's repo: label picks the checkout");
  assert.match(body, /handoffPromptFor\(workspace\.name, id, repo\)/);
  assert.ok(!/agent: /.test(body), 'no foundation override — a handoff successor is an ordinary worker');
  assert.match(body, /bead: id, workspace: workspace\.name/, 'and it is registered against its bead');
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
