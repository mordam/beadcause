#!/usr/bin/env node
//
// Pointing the Mac at a session's window — and putting it back.
//
//   npm test
//   node test/focus.mjs
//
// `/session?pid=…` grew a button that brings that session's iTerm window to the front
// and doubles it in place, and closing the view puts the window back at exactly the
// bounds it had. None of that can be exercised for real: it only means anything on a Mac
// with iTerm open, and a test that drove the real thing would resize whichever window
// answered. So the arithmetic lives in pure functions in lib/iterm.js, the rules live in
// lib/focus.js over a window made of numbers, and this file pins the four things a
// reasonable refactor breaks in a way nobody would notice until a window was stuck:
//
// 1. **The saved rectangle is read before anything is changed, and written once.** It is
//    the only record of where the window was. Re-read on a second tap it would be the
//    *enlarged* rectangle, and the window would have no way back — which is precisely
//    the acceptance criterion "doubling and restoring twice in a row leaves it where it
//    started".
// 2. **A restore consumes the record.** Dropped before the window is touched, so a lease
//    sweep firing in the same moment cannot apply the same bounds twice, and a second
//    close is a no-op rather than a complaint.
// 3. **The clamp.** A window doubled about its centre near a screen edge would put half
//    of itself off the display, and the half that goes missing is as likely as not to be
//    the one with the prompt in it. The three-display fixture is a real reading, so the
//    clamp is checked against measurement rather than against my arithmetic.
// 4. **The lease.** A phone that locks, a tab swiped away and a discarded page all stop
//    polling and send nothing. What puts the window back then is the sweep, measured off
//    the poll the page was already making — and a lease that stopped being renewed by
//    `/api/session-log` would strand a double-size window on the desk with nothing left
//    that knew how big it used to be.
//
// The two calls that touch the Mac are parameters of every function under test (`ask`
// and `measure`), which is the only reason any of this is reachable from node.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// lib/focus.js reaches lib/session.js, which reaches lib/iterm.js — and that writes a
// dynamic profile into the real iTerm's directory on import unless this is set first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-focus-'));
process.env.BEADCAUSE_ITERM_PROFILE_DIR = path.join(tmp, 'DynamicProfiles');

const { parseBounds, screenOf, magnify, enlarged, boundsArg } = await import(
  path.join(ROOT, 'lib', 'iterm.js')
);
const focus = await import(path.join(ROOT, 'lib', 'focus.js'));
const { bringUp, putBack, sweep, touch, forget, isHeld, stopSweep, LEASE_MS } = focus;

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checkAsync = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* --------------------------------------------------------------- the arithmetic */

check(() => {
  assert.deepEqual(parseBounds('0,44,585,502'), { left: 0, top: 44, right: 585, bottom: 502 });
  assert.deepEqual(parseBounds(' 3083 , -2127 , 3668 , -1669 '), {
    left: 3083,
    top: -2127,
    right: 3668,
    bottom: -1669,
  });
}, 'a reading from the AppleScript comes back as a rectangle, negatives and spaces and all');

check(() => {
  for (const junk of ['missing', '', '1,2,3', '1,2,3,4,5', 'a,b,c,d', null, undefined]) {
    assert.equal(parseBounds(junk), null, `${JSON.stringify(junk)} parsed as a rectangle`);
  }
  // A degenerate rectangle is the shape a partial read produces, and saving it as the
  // thing to restore to would collapse the window to nothing.
  assert.equal(parseBounds('100,100,100,100'), null, 'a zero-size rectangle is not a window');
  assert.equal(parseBounds('300,100,100,400'), null, 'nor is an inside-out one');
}, 'and anything that is not four sane integers is null, never a rectangle of NaNs');

check(() => {
  assert.equal(boundsArg(parseBounds('0,44,585,502')), '0,44,585,502');
}, 'the two directions agree, which is what lets a saved reading be set back verbatim');

// The same measurement test/cards.mjs uses: a MacBook Pro with a portrait monitor and a
// 4K above it, read from `osascript -l JavaScript scripts/iterm-layout.jxa` on
// 2026-08-10, paired with real window rectangles from the same moment.
const MEASURED = {
  primaryHeight: 1169,
  screens: [
    { index: 0, x: 0, y: 0, width: 1800, height: 1125 },
    { index: 1, x: 79, y: 1169, width: 1080, height: 1920 },
    { index: 2, x: 1159, y: 1169, width: 3840, height: 2160 },
  ],
};

const SCREEN = { index: 0, left: 0, top: 44, width: 1800, height: 1125 };

check(() => {
  const r = magnify({ left: 500, top: 300, right: 1000, bottom: 700 }, SCREEN);
  assert.equal(r.right - r.left, 1000, 'twice as wide');
  assert.equal(r.bottom - r.top, 800, 'twice as tall');
  assert.equal((r.left + r.right) / 2, 750, 'about the same centre');
  assert.equal((r.top + r.bottom) / 2, 500);
}, '"twice the size" is each edge doubled, about the centre it already had');

check(() => {
  // Hard against the left edge of the laptop screen. Doubling about the centre would
  // put a quarter of the window at a negative x, which is off the display.
  const r = magnify({ left: 0, top: 44, right: 600, bottom: 444 }, SCREEN);
  assert.equal(r.left, 0, 'slid back onto the screen rather than allowed to overflow');
  assert.equal(r.top, 44);
  assert.equal(r.right, 1200);
  assert.ok(r.right <= SCREEN.left + SCREEN.width && r.bottom <= SCREEN.top + SCREEN.height);
}, 'a window at the edge grows inwards, because half a window is worse than a small one');

check(() => {
  const r = magnify({ left: 100, top: 100, right: 1700, bottom: 1000 }, SCREEN);
  assert.equal(r.right - r.left, SCREEN.width, 'capped at the screen, not twice the screen');
  assert.equal(r.bottom - r.top, SCREEN.height);
  assert.deepEqual(
    { l: r.left, t: r.top },
    { l: SCREEN.left, t: SCREEN.top },
    'and it lands on the screen, not straddling its corner'
  );
}, 'a window already most of its screen grows to the screen and stops');

check(() => {
  const rect = { left: 500, top: 300, right: 1000, bottom: 700 };
  // Not centred: with nothing measured there is no edge to clamp to, and growing about
  // the centre put a real window 368px off the left of a real display the first time
  // this ran. The corner that goes missing that way is the one you drag the window by.
  assert.deepEqual(magnify(rect, null), { left: 500, top: 300, right: 1500, bottom: 1100 });
}, 'a failed probe grows the window from its top left, which is the recoverable direction');

check(() => {
  // The window that was really on the 4K, from the same reading.
  const onThe4k = { left: 3083, top: -2127, right: 3668, bottom: -1669 };
  const r = enlarged(onThe4k, MEASURED);
  assert.equal(r.right - r.left, 1170, 'doubled');
  // The 4K's top edge is y = -2160; doubling about the centre would have started at
  // -2356, which is on no display at all.
  assert.equal(r.top, -2160, 'clamped to the top of the display it is actually on');
  assert.equal(r.bottom - r.top, 916);
}, 'and the screen it is clamped to is the one it is on — a negative top is a real display');

check(() => {
  const onTheLaptop = { left: 0, top: 44, right: 585, bottom: 502 };
  assert.equal(screenOf(onTheLaptop, []), null, 'nothing measured is not a wrong screen');
  const rects = [SCREEN, { index: 2, left: 1159, top: -2160, width: 3840, height: 2160 }];
  assert.equal(screenOf(onTheLaptop, rects).index, 0);
  assert.equal(screenOf({ left: 3083, top: -2127, right: 3668, bottom: -1669 }, rects).index, 2);
}, 'a window belongs to the screen its centre is on');

/* ------------------------------------------------------------------- the rules */

/** A window made of numbers, answering the two things the real script answers. */
function fakeWindow(rect, { tty = '/dev/ttys004' } = {}) {
  const w = {
    tty,
    rect: { ...rect },
    fronts: 0,
    sets: 0,
    gone: false,
    async ask(handle, { bounds = null, front = false } = {}) {
      assert.equal(handle, tty, 'the window was addressed by the handle it was held with');
      if (w.gone) return null;
      // The real script reads before it writes, and the reading is what goes back.
      const before = { ...w.rect };
      if (front) w.fronts += 1;
      if (bounds) {
        w.sets += 1;
        w.rect = { ...bounds };
      }
      return before;
    },
  };
  return w;
}

const measure = async () => MEASURED;
const START = { left: 0, top: 44, right: 600, bottom: 444 };

await checkAsync(async () => {
  const w = fakeWindow(START);
  forget(11);
  const r = await bringUp(11, w.tty, { ask: w.ask, measure });
  assert.equal(r.ok, true);
  assert.equal(w.fronts, 1, 'it came to the front');
  assert.equal(w.rect.right - w.rect.left, 1200, 'and it is twice as wide as it was');
  assert.ok(isHeld(11), 'and the daemon knows it is holding it');
  forget(11);
}, 'one tap raises the window and doubles it');

await checkAsync(async () => {
  const w = fakeWindow(START);
  forget(12);
  await bringUp(12, w.tty, { ask: w.ask, measure });
  const enlargedRect = { ...w.rect };
  // The tap you make when you have lost the window behind Chrome again.
  const again = await bringUp(12, w.tty, { ask: w.ask, measure });
  assert.equal(again.again, true, 'the second tap knows it is a second tap');
  assert.equal(w.fronts, 2, 'and it does raise it again — that is what the tap means');
  assert.deepEqual(w.rect, enlargedRect, 'but it does not double the doubled window');
  await putBack(12, { ask: w.ask });
  assert.deepEqual(w.rect, START, 'and the way back is still the rectangle from before the first tap');
  forget(12);
}, 'a second tap re-raises without overwriting the way back — why the saved rectangle is written once');

await checkAsync(async () => {
  const w = fakeWindow(START);
  forget(13);
  for (const round of [1, 2]) {
    await bringUp(13, w.tty, { ask: w.ask, measure });
    const back = await putBack(13, { ask: w.ask });
    assert.equal(back.restored, true);
    assert.deepEqual(w.rect, START, `round ${round} did not leave it where it started`);
  }
  forget(13);
}, 'doubling and restoring twice in a row leaves the window exactly where it started');

await checkAsync(async () => {
  const w = fakeWindow(START);
  forget(14);
  await bringUp(14, w.tty, { ask: w.ask, measure });
  await putBack(14, { ask: w.ask });
  const sets = w.sets;
  // A close racing the lease sweep, or a beacon that arrived twice.
  const second = await putBack(14, { ask: w.ask });
  assert.equal(second.restored, false, 'nothing held is not an error');
  assert.equal(w.sets, sets, 'and it did not set the same bounds a second time');
  assert.equal(isHeld(14), false);
}, 'a restore consumes the record, so a second one is a no-op rather than a second move');

await checkAsync(async () => {
  const w = fakeWindow(START);
  w.gone = true;
  forget(15);
  const r = await bringUp(15, w.tty, { ask: w.ask, measure });
  assert.equal(r.ok, false);
  assert.equal(r.gone, true);
  assert.equal(isHeld(15), false, 'a window that was never resized must not be remembered');
}, 'a window closed by hand is gone, and leaves no phantom for the sweep to act on');

await checkAsync(async () => {
  const w = fakeWindow(START);
  forget(16);
  await bringUp(16, w.tty, { ask: w.ask, measure });

  // The page is still open and polling: /api/session-log calls touch() every two seconds.
  const now = Date.now();
  touch(16, now);
  assert.deepEqual(await sweep(now + LEASE_MS - 1, { ask: w.ask }), [], 'not yet');
  assert.notDeepEqual(w.rect, START, 'so the window is still big');

  // …and then the phone locks, or the tab is swiped away, and nothing touches it again.
  const swept = await sweep(now + LEASE_MS + 1, { ask: w.ask });
  assert.deepEqual(swept, [16]);
  assert.deepEqual(w.rect, START, 'the window went back on its own');
  assert.equal(isHeld(16), false);
}, 'a lease that stops being renewed puts the window back, which is what covers a locked phone');

await checkAsync(async () => {
  const w = fakeWindow(START);
  forget(17);
  await bringUp(17, w.tty, { ask: w.ask, measure });
  const enlargedRect = { ...w.rect };

  // macOS refusing the Apple event, which is what a TCC denial looks like from here.
  const refuse = async () => {
    throw Object.assign(new Error('macOS blocked beadcause from controlling iTerm'), { status: 403 });
  };
  await assert.rejects(() => putBack(17, { ask: refuse }));
  assert.ok(isHeld(17), 'the only record of where that window belongs was thrown away');
  assert.deepEqual(w.rect, enlargedRect, 'and the window is still big, so it still needs it');

  // The next sweep finds it lapsed — the lease was not reset by the failed attempt —
  // and this time the call gets through.
  const swept = await sweep(Date.now() + LEASE_MS + 1, { ask: w.ask });
  assert.deepEqual(swept, [17]);
  assert.deepEqual(w.rect, START, 'the retry put it back');
  forget(17);
}, 'a refused restore keeps the record so the sweep can try again, rather than stranding the window');

await checkAsync(async () => {
  forget(18);
  const w = fakeWindow(START);
  await bringUp(18, w.tty, { ask: w.ask, measure });
  const refuse = async () => {
    throw new Error('nope');
  };
  for (let i = 0; i < 5; i++) await putBack(18, { ask: refuse }).catch(() => {});
  assert.equal(isHeld(18), false, 'it retried forever, logging a refusal every twenty seconds');
}, 'but it gives up after three — a permission that was denied does not heal itself');

stopSweep();

/* ------------------------------------------------ what AppleScript is told, and asked */

const script = fs.readFileSync(path.join(ROOT, 'scripts', 'focus-session.applescript'), 'utf8');

check(() => {
  assert.ok(/set bounds of window id targetId to rect/.test(script), 'nothing sets the window geometry');
  // position/size/origin/frame are all in iTerm's dictionary and every one of them
  // raises -10000 on 3.6.11. Reaching for them is the obvious refactor and it silently
  // stops moving windows. Same rule as open-session.applescript.
  assert.ok(!/set (position|size|origin|frame) of/.test(script), 'those handlers do not work');
}, 'geometry is one rectangle set as bounds, because bounds is the only setter iTerm honours');

check(() => {
  const read = script.indexOf('set found to bounds of window id targetId');
  const write = script.indexOf('set bounds of window id targetId to rect');
  assert.ok(read > 0 && write > 0, 'the script neither reads nor writes the bounds');
  assert.ok(read < write, 'read after the write, the saved rectangle is the enlarged one');
}, 'the window is measured before it is moved — that reading is the whole way back');

check(() => {
  const tellAt = script.indexOf('tell application id');
  const delimiterAt = script.indexOf('text item delimiters');
  assert.ok(delimiterAt > 0 && delimiterAt < tellAt, 'set inside the tell block, iTerm answers -10006');
}, 'the rectangle is parsed before the tell block, where text item delimiters still belong to AppleScript');

check(() => {
  assert.ok(/if not \(application id "com.googlecode.iterm2" is running\) then return "missing"/.test(script));
}, 'it never launches iTerm to find out whether a window is there');

check(() => {
  assert.ok(/\(id of s\) as text\) is equal to wantedId/.test(script), 'the advocate’s own workers');
  assert.ok(/\(tty of s\) is equal to wantedId/.test(script), 'and every session started at the keyboard');
}, 'both kinds of handle are matched, exactly as message-session.applescript matches them');

check(() => {
  assert.ok(/\bactivate\b/.test(script), 'without activate, iTerm stays behind the browser');
  assert.ok(/select window id targetId/.test(script), 'without select, you get iTerm’s last window');
}, 'raising the window is activate *and* select — neither alone puts that window in front');

check(() => {
  // `repeat with w in windows` hands you `item N of every window` — a position in a
  // list `activate` is allowed to reorder, so acting through it can move a different
  // window than the one that was found. iTerm also answers -1728 for `contents of w`,
  // which is the obvious way to try to pin it down. The id is the stable handle, and
  // this was got wrong once against a real iTerm.
  assert.ok(/set targetId to id of w/.test(script), 'the window is not pinned by id');
  assert.ok(!/bounds of target\b/.test(script), 'a list position is not a window');
}, 'and it acts on `window id`, not on the loop position it was found at');

/* --------------------------------------------------------- what the caller does */

const server = fs.readFileSync(path.join(ROOT, 'lib', 'server.js'), 'utf8');

check(() => {
  assert.ok(/touchFocus\(pid\)/.test(server), 'the poll no longer renews the lease');
  assert.ok(/focused: isHeld\(pid\)/.test(server), 'the page cannot tell whether the window is up');
}, '/api/session-log renews the lease and reports whether the window is held');

check(() => {
  const at = server.indexOf("p === '/api/session-focus'");
  assert.ok(at > 0, 'there is no endpoint');
  const body = server.slice(at, at + 1600);
  const restore = body.indexOf("body.action === 'restore'");
  const gate = body.indexOf('reach.can');
  assert.ok(restore > 0 && gate > 0);
  assert.ok(restore < gate, 'a restore must not be gated on reach, or a closed window strands');
  assert.ok(/liveSessions\(cfg\)\.find\(\(s\) => s\.pid === pid\)/.test(body), 'focusing a dead pid');
}, 'focusing is gated on reach and a live session; restoring is gated on neither, deliberately');

const page = fs.readFileSync(path.join(ROOT, 'public', 'session.js'), 'utf8');

check(() => {
  assert.ok(/addEventListener\('pagehide'/.test(page), 'nothing restores the window when the view closes');
  // A phone that locks fires visibilitychange, and shrinking the window at that moment
  // is exactly what this feature must not do — you are on your way to the Mac. So the
  // word may be discussed in a comment and must never be listened for.
  assert.ok(!/addEventListener\(\s*'visibilitychange'/.test(page), 'a lock is not a close');
  assert.ok(/navigator\.sendBeacon/.test(page), 'a fetch from a document being torn down may never leave');
}, 'the close sends a restore on pagehide, and a locked phone is left to the lease');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
