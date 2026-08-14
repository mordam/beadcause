/**
 * One press of *Resolve conflicts* is one session, and so is two presses.
 *
 * bc-utyr: one press produced two resolver sessions, both briefed identically, both sent
 * into the single worktree the branch was checked out in. One of them ran `git merge
 * --abort` between the other's resolution and its `git add && git commit`, and the commit
 * that came out carried unresolved conflict markers into `public/console.js` with two
 * parents and the shape of an ordinary merge. `test/dismissed.mjs` went 2/16. A human
 * reading the diff is the only reason it was caught.
 *
 * `resolveFor` in lib/resolvers.js is the fix, and there are four claims worth asserting
 * because three of them fail silently:
 *
 *   - **a second press opens nothing** — the whole bug, and it is asserted as the count of
 *     launches rather than as a status code, because a route that answered 200 and opened
 *     a window would pass a status assertion;
 *   - **and the live session is told** — the useful half of what the press was asking for.
 *     A dedupe that merely refuses is a button that stops working;
 *   - **two presses at once are still one window** — the actual shape of the incident. One
 *     press, two requests, a moment apart. This is the case a check-then-launch passes;
 *   - **"I cannot ask" is never "it is gone"** — a handle-less record and a macOS refusal
 *     both hold, because treating either as absence is what opens the second window. The
 *     same distinction `reclaim` keeps in lib/advocate.js.
 *
 *     node test/resolvers.mjs
 *
 * No iTerm, no `gh`, no daemon: `launch` and `say` are both injected, so a case that
 * would have opened a window pushes onto an array instead.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before lib/session.js is reached through the import below: CONFIG_DIR resolves once, at
// module load, and the daemon's own config is not this suite's to read.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-resolvers-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { resolveFor, find, remember, forget, list, reset, nudgeMessage } = await import(LIB('resolvers.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

const T0 = Date.parse('2026-08-11T13:45:00Z');
const MIN = 60000;

/** A press. `launch` records that a window would have opened and hands back a handle. */
function press(state, { number = 115, workspace = 'beadcause', now = T0, term = 'iterm-1', say, fail = null, sweptAfter = null, instruction = '' } = {}) {
  return resolveFor(
    workspace,
    number,
    async () => {
      if (fail) throw fail;
      state.opened.push({ number, at: now });
      return { dir: '/repo', mode: 'acceptEdits', term };
    },
    {
      branch: 'worktree-chat-tabs-dmt',
      owner: 'Adam',
      now,
      sweptAfter,
      instruction,
      say:
        say ||
        (async (handle, text) => {
          state.said.push({ handle, text });
          return 'sent';
        }),
    }
  );
}

const fresh = () => ({ opened: [], said: [] });

/* ------------------------------------------------------------------ the cases */

await check('the first press opens a window and remembers the handle', async () => {
  const state = fresh();
  const out = await press(state);

  assert.equal(state.opened.length, 1, 'one window');
  assert.equal(out.opened.term, 'iterm-1');
  assert.deepEqual(state.said, [], 'nothing to say to — there was no session yet');

  const rec = find('beadcause', 115, T0);
  assert.ok(rec, 'the session is remembered');
  assert.equal(rec.term, 'iterm-1');
  assert.equal(rec.branch, 'worktree-chat-tabs-dmt', 'the branch comes off the caller row, not off the launch result');
});

/**
 * The whole bug, in the smallest form it takes: press, then press again.
 */
await check('a second press opens nothing and tells the session that has it', async () => {
  const state = fresh();
  await press(state);
  const out = await press(state, { now: T0 + 4 * MIN });

  assert.equal(state.opened.length, 1, 'still one window — this is bc-utyr');
  assert.ok(out.reused, `expected a reuse, got ${JSON.stringify(out)}`);
  assert.equal(state.said.length, 1, 'and the live session was told');
  assert.equal(state.said[0].handle, 'iterm-1', 'told through the handle the first press captured');
  assert.match(state.said[0].text, /#115/, state.said[0].text);
  assert.match(out.note, /already has a session/, out.note);
  assert.match(out.note, /worktree-chat-tabs-dmt/, 'the sentence names where it is');
});

/**
 * The shape the incident actually took: one press, two requests, neither of them able to
 * see the other because the check and the launch had an `await` between them. Both are
 * started before either is awaited, which is the only way to reproduce it.
 */
await check('two presses at once are still one window', async () => {
  const state = fresh();
  const [a, b] = await Promise.all([press(state), press(state, { term: 'iterm-2' })]);

  assert.equal(state.opened.length, 1, 'one window for two simultaneous presses');
  const reused = [a, b].filter((r) => r.reused);
  const opened = [a, b].filter((r) => r.opened);
  assert.equal(opened.length, 1, 'exactly one of them opened it');
  assert.equal(reused.length, 1, 'and the other was told about it rather than refused');
  assert.equal(state.said.length, 1, 'one nudge, into the window that did open');
  assert.equal(state.said[0].handle, 'iterm-1', 'the second request found the first request’s handle');
});

/** Ten presses, all at once. The lock is a queue, not a two-slot guard. */
await check('ten presses at once are still one window', async () => {
  const state = fresh();
  const all = await Promise.all(Array.from({ length: 10 }, () => press(state)));

  assert.equal(state.opened.length, 1, 'one window');
  assert.equal(all.filter((r) => r.opened).length, 1);
  assert.equal(all.filter((r) => r.reused).length, 9);
  assert.equal(state.said.length, 9, 'and each of the nine was answered by the live session');
});

/**
 * The resolver finished and its window closed. Then the button has to work again — a
 * dedupe that outlives the thing it is deduping is a button that stops working.
 */
await check('a session that is gone is replaced rather than believed', async () => {
  const state = fresh();
  await press(state);
  const out = await press(state, {
    now: T0 + 40 * MIN,
    term: 'iterm-2',
    say: async () => 'missing',
  });

  assert.equal(state.opened.length, 2, 'the second press opened a window, because nothing was there');
  assert.ok(out.opened, `expected an open, got ${JSON.stringify(out)}`);
  assert.equal(find('beadcause', 115, T0 + 40 * MIN).term, 'iterm-2', 'and the new handle replaced the dead one');
});

/**
 * macOS refusing the Apple event is not evidence about the session. Treating it as one
 * frees the slot — here, opens the window — out from under an agent that is working.
 */
await check('iTerm refusing to talk is not the session being gone', async () => {
  const state = fresh();
  await press(state);
  const out = await press(state, {
    now: T0 + MIN,
    say: async () => {
      throw Object.assign(new Error('macOS blocked beadcause from controlling iTerm.'), { status: 403 });
    },
  });

  assert.equal(state.opened.length, 1, 'nothing opened on the strength of a refusal');
  assert.equal(out.status, 403, JSON.stringify(out));
  assert.match(out.error, /could not reach the session already on #115/, out.error);
});

/**
 * The third state, and the reason there are three: an iTerm that reports no session id
 * leaves a record nothing can ask. "I cannot ask" holds, and says the age out loud.
 */
await check('a session with no handle holds, and says how old it is', async () => {
  const state = fresh();
  await press(state, { term: null });
  const out = await press(state, { now: T0 + 12 * MIN });

  assert.equal(state.opened.length, 1, 'no second window over a session nothing can ask about');
  assert.equal(out.status, 409, JSON.stringify(out));
  assert.match(out.error, /12 minutes ago/, out.error);
  assert.match(out.error, /cannot be asked/, out.error);
  assert.match(out.error, /worktree-chat-tabs-dmt/, 'and says which window to go and look at');
});

/** And it ages out, so the button is never stranded for good on that Mac. */
await check('an unaskable session is not believed forever', async () => {
  const state = fresh();
  await press(state, { term: null });
  const out = await press(state, { now: T0 + 31 * MIN, term: 'iterm-2' });

  assert.equal(state.opened.length, 2, 'past the blind window it opens again');
  assert.ok(out.opened, JSON.stringify(out));
});

/**
 * A launch that failed is a window that did not open, so nothing may be remembered from
 * it — and the next press has to be able to try. Both halves of that are the lock: a
 * `finally` that did not release would wedge this pull request for the life of the daemon.
 */
await check('a launch that throws leaves nothing behind, and the next press still works', async () => {
  const state = fresh();
  await assert.rejects(() => press(state, { fail: new Error('iTerm would not open') }), /iTerm would not open/);
  assert.equal(find('beadcause', 115, T0), null, 'nothing remembered from a window that never opened');

  const out = await press(state, { now: T0 + MIN });
  assert.equal(state.opened.length, 1, 'and the retry opened one');
  assert.ok(out.opened, JSON.stringify(out));
});

/** Two pull requests are two locks. One resolver must not hold up another repo's. */
await check('different pull requests do not queue behind each other', async () => {
  const state = fresh();
  await Promise.all([press(state, { number: 115 }), press(state, { number: 116 }), press(state, { workspace: 'sophab', number: 115 })]);

  assert.equal(state.opened.length, 3, 'three distinct pull requests, three windows');
  assert.equal(list(T0).length, 3);
  assert.ok(find('sophab', 115, T0), 'the workspace is part of the key, not just the number');
});

/* ------------------------------------------------------- the record, on its own */

await check('a record with a handle survives the blind window and dies at the TTL', async () => {
  remember('beadcause', 115, { term: 'iterm-1', branch: 'b' }, new Date(T0));
  assert.ok(find('beadcause', 115, T0 + 60 * MIN), 'half an hour is only the blind window');
  assert.equal(find('beadcause', 115, T0 + 5 * 60 * MIN), null, 'and four hours is the whole of it');
});

await check('forget drops one and reset drops the lot', async () => {
  remember('beadcause', 115, { term: 'a' }, new Date(T0));
  remember('beadcause', 116, { term: 'b' }, new Date(T0));
  assert.equal(forget('beadcause', 115), true);
  assert.equal(find('beadcause', 115, T0), null);
  assert.equal(list(T0).length, 1);
  reset();
  assert.equal(list(T0).length, 0);
});

/**
 * What lands in the window. It has to say that no second session is coming — otherwise
 * the session reads it as a fresh instruction and starts the merge again, which is the
 * thing the whole file exists to prevent.
 */
await check('the nudge says a press happened and that nothing new is being opened', async () => {
  const text = nudgeMessage(115, 'Adam');
  assert.match(text, /^\*\* BEADCAUSE \*\*/, text);
  assert.match(text, /Adam pressed Resolve conflicts on #115 again/, text);
  assert.match(text, /no second session is being opened/, text);
  assert.match(text, /starting a second merge in this tree/, text);
  assert.equal(text.includes('\n'), false, 'one line — it lands in a window somebody is working in');
});

/**
 * bc-9d37.6. The sweep is now the *common* caller of this line, and until it carried a
 * reason the window was told a person had pressed a button — which is the falsehood
 * bc-9d37.2 removed from the brief one file over, arriving by the other door.
 */
await check('a swept nudge names the merge and never claims a press', async () => {
  const text = nudgeMessage(115, 'Adam', { sweptAfter: 204 });
  assert.match(text, /^\*\* BEADCAUSE \*\*/, text);
  assert.match(text, /Nobody pressed anything/, text);
  assert.match(text, /#204 merged/, text);
  assert.doesNotMatch(text, /pressed Resolve conflicts/, text);
  assert.match(text, /no second session is being opened/, text);
  assert.equal(text.includes('\n'), false, 'one line');
});

await check('a swept nudge that cannot name the merge invents no number', async () => {
  // `Number(true)` is 1, and "#1 merged" is the confident falsehood the guard is for.
  const text = nudgeMessage(115, 'Adam', { sweptAfter: true });
  assert.match(text, /Nobody pressed anything/, text);
  assert.match(text, /A pull request merged/, text);
  assert.doesNotMatch(text, /#1 merged/, text);
});

/**
 * The third case, and the one the two beads in this group share: Adam answered the sweep
 * card about a pull request that already has a live resolver. That *is* new work, so it
 * must not fall through to "there is nothing new to do".
 */
await check('an answered nudge carries the instruction and does not say there is nothing to do', async () => {
  const text = nudgeMessage(115, 'Adam', { sweptAfter: 204, instruction: 'take main’s renderRow\nand keep our tests' });
  assert.match(text, /answered the sweep card about #115/, text);
  assert.match(text, /take main’s renderRow and keep our tests/, text, 'newlines folded — this lands in a window');
  assert.doesNotMatch(text, /nothing new to do/, text);
  assert.doesNotMatch(text, /pressed Resolve conflicts/, text);
  assert.equal(text.includes('\n'), false, 'one line');
});

await check('resolveFor hands the reason it was given to the session that already has it', async () => {
  const state = { opened: [], said: [] };
  await press(state);
  const out = await press(state, { now: T0 + 5 * MIN, sweptAfter: 204 });
  assert.ok(out.reused, JSON.stringify(out));
  assert.match(state.said[0].text, /Nobody pressed anything/, state.said[0].text);
  assert.match(out.note, /told it the sweep found this one again/, out.note);

  const answered = await press(state, { now: T0 + 6 * MIN, instruction: 'take main’s renderRow' });
  assert.ok(answered.reused, JSON.stringify(answered));
  assert.match(state.said[1].text, /take main’s renderRow/, state.said[1].text);
  assert.match(answered.note, /gave it your answer/, answered.note);
});

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
