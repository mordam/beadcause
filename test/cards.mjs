#!/usr/bin/env node
//
// Session windows: a profile of their own, dealt onto one screen like cards.
//
//   npm test
//   node test/cards.mjs
//
// None of this can be exercised for real by a test. The layout only means anything on a
// Mac with particular monitors plugged into it, the profile only means anything to a
// running iTerm, and the focus dance can only be observed by a person watching the
// screen. So the arithmetic was pushed into pure functions in lib/iterm.js and this file
// pins the parts a reasonable refactor breaks silently:
//
// 1. **The coordinate flip.** AppKit measures from the bottom left of the primary
//    display with y growing up; iTerm's `bounds` measures from the top left with y
//    growing down. The fixture below is a real reading from a real three-display Mac,
//    paired with real window rectangles from the same moment, so the flip is checked
//    against measurement rather than against my arithmetic. Get this wrong by one screen
//    height and every window is dealt onto a monitor that isn't there.
// 2. **Cards never overlap.** The whole promise of the layout. Twenty windows dealt onto
//    a 4K screen, each one fed back in as an obstacle for the next, and no two of the
//    resulting rectangles may intersect — which holds because a card can only wander
//    inside its own cell, not because the jitter happens to be small.
// 3. **The jitter is a hash, not a die roll.** `Math.random` here would put the same
//    session somewhere new every time it reopened and would make this file impossible to
//    write. Same key, same table, same rectangle.
// 4. **The emptiest cell wins.** A table with room in it never stacks, and the tiebreak
//    between equally empty cells is the key's hash — so two sessions opened a second
//    apart do not both take the top left.
// 5. **The profile is written only when it changed.** iTerm reloads every profile on
//    each write to the directory it watches; a rewrite per session open would reload
//    them a dozen times an hour to no purpose.
// 6. **The AppleScript's contract.** Five arguments, a rectangle set as `bounds` and not
//    as `position`/`size` (those raise -10000 on 3.6.11), a fallback to the default
//    profile, `text item delimiters` set *outside* the tell block, and the delay before
//    the keyboard is handed back. Each of those is a thing that was got wrong once and
//    fails in a way no unit test could see.
//
// Nothing here writes into a real iTerm: `BEADCAUSE_ITERM_PROFILE_DIR` moves the profile
// into a temp directory before lib/iterm.js is imported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-cards-'));
// Before anything under lib/ is imported: the profile directory is read through an env
// var that a test must own, or this suite edits the profile list of the iTerm you are
// reading its output in.
process.env.BEADCAUSE_ITERM_PROFILE_DIR = path.join(tmp, 'DynamicProfiles');

const iterm = await import(path.join(ROOT, 'lib', 'iterm.js'));
const {
  PROFILE_NAME,
  PROFILE_GUID,
  profileDocument,
  profilePath,
  ensureProfile,
  screenRects,
  pickScreen,
  grid,
  dealCard,
  boundsArg,
  restoreApp,
  ITERM_BUNDLE_ID,
} = iterm;

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

console.log('session windows');

/* ------------------------------------------------------------------ the profile */

check(() => {
  const p = profileDocument().Profiles[0];
  assert.equal(p.Name, PROFILE_NAME);
  assert.equal(p.Guid, PROFILE_GUID);
  // The parent is the whole reason this is eight keys and not fifty: session windows
  // must keep looking like the terminal whose font and colours you actually chose.
  assert.equal(p['Dynamic Profile Parent Name'], 'Default');
}, 'the profile inherits from Default and keeps one stable Guid');

check(() => {
  const p = profileDocument().Profiles[0];
  assert.equal(p['Unlimited Scrollback'], true, 'an hour of agent output must survive');
  assert.equal(p['Prompt Before Closing 2'], 0, 'a worker closes its own window with nobody in the room');
  assert.equal(p['Window Type'], 0, 'a full-screen Default profile must not defeat the layout');
}, 'and overrides exactly what a session needs and a shell does not');

check(() => {
  assert.equal(profileDocument().Profiles[0].Screen, -1, 'no display preference by default');
  assert.equal(profileDocument({ screen: 2 }).Profiles[0].Screen, 2);
}, 'the chosen display is named in the profile, so the window is born there rather than jumping');

check(() => {
  const first = ensureProfile({ screen: 2 });
  assert.equal(first.written, true);
  assert.equal(first.name, PROFILE_NAME);
  assert.equal(JSON.parse(fs.readFileSync(first.path, 'utf8')).Profiles[0].Screen, 2);
}, 'writing it creates the directory iTerm watches');

check(() => {
  assert.equal(ensureProfile({ screen: 2 }).written, false);
}, 'writing the same thing again writes nothing — iTerm reloads every profile on each write');

check(() => {
  assert.equal(ensureProfile({ screen: 1 }).written, true);
  assert.equal(JSON.parse(fs.readFileSync(profilePath(), 'utf8')).Profiles[0].Screen, 1);
}, 'a different screen does rewrite it');

check(() => {
  fs.writeFileSync(profilePath(), '{ half a file');
  assert.equal(ensureProfile({ screen: 1 }).written, true);
  assert.equal(JSON.parse(fs.readFileSync(profilePath(), 'utf8')).Profiles[0].Guid, PROFILE_GUID);
}, 'and so does a file somebody broke by hand');

check(() => {
  // A path whose parent is a file: mkdir cannot succeed, and the point is that it comes
  // back as a value. A throw here would cost you the session, and the session is what
  // the profile exists to dress up.
  const wall = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(wall, 'x');
  const res = ensureProfile({}, path.join(wall, 'DynamicProfiles'));
  assert.equal(res.name, null);
  assert.ok(res.error, 'the reason comes back with it');
}, 'a profile that cannot be written is reported, never thrown');

/* ------------------------------------------------------------------ the displays */

// Measured on 2026-08-10 from a MacBook Pro with a portrait monitor and a 4K above it:
// `osascript -l JavaScript scripts/iterm-layout.jxa`. The window rectangles are from the
// same reading, straight out of iTerm's `bounds`, which is what makes this a check on
// the flip rather than a restatement of it.
const MEASURED = {
  primaryHeight: 1169,
  screens: [
    { index: 0, x: 0, y: 0, width: 1800, height: 1125 },
    { index: 1, x: 79, y: 1169, width: 1080, height: 1920 },
    { index: 2, x: 1159, y: 1169, width: 3840, height: 2160 },
  ],
  windows: [
    [3083, -2127, 3668, -1669],
    [301, -1634, 886, -411],
    [0, 44, 585, 502],
  ],
};

const rects = screenRects(MEASURED);

check(() => {
  assert.deepEqual(rects[0], { index: 0, left: 0, top: 44, width: 1800, height: 1125 });
}, 'the primary display starts below the menu bar, at y = 44');

check(() => {
  assert.deepEqual(rects[2], { index: 2, left: 1159, top: -2160, width: 3840, height: 2160 });
}, 'a display stacked above the primary one has a negative top — that is what iTerm means');

check(() => {
  // Each measured window must land inside the screen it was actually on. This is the
  // assertion that fails if the flip is off by a screen height in either direction.
  const inside = (w, s) =>
    w[0] >= s.left && w[2] <= s.left + s.width && w[1] >= s.top && w[3] <= s.top + s.height;
  assert.ok(inside(MEASURED.windows[0], rects[2]), 'the window on the 4K is on the 4K');
  assert.ok(inside(MEASURED.windows[1], rects[1]), 'the window on the portrait monitor is on it');
  assert.ok(inside(MEASURED.windows[2], rects[0]), 'the window on the laptop is on the laptop');
}, 'and real windows land inside the real screens they were read from');

check(() => {
  assert.equal(pickScreen(rects).index, 2, 'largest by area');
  assert.equal(pickScreen(rects, 'main').index, 0);
  assert.equal(pickScreen(rects, 1).index, 1);
  assert.equal(pickScreen(rects, '1').index, 1, 'a number that came through JSON as a string');
}, 'the table is laid on the largest screen unless told otherwise');

check(() => {
  assert.equal(pickScreen(rects, 9).index, 0, 'a monitor that was unplugged falls back');
  assert.equal(pickScreen([], 'largest'), null, 'and no screens at all is a null, not a throw');
}, 'a screen that is not there costs a placement, never a session');

/* --------------------------------------------------------------------- the table */

const table = rects[2];
const CARD = { width: 780, height: 540, gap: 24, jitter: 18 };
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

check(() => {
  const g = grid(table, CARD);
  assert.ok(g.cols >= 4 && g.rows >= 3, `a 4K screen holds a real hand of cards, got ${g.cols}x${g.rows}`);
  assert.ok(g.width <= g.cellWidth - CARD.gap, 'the card sits inside its cell with the gap around it');
  assert.ok(g.height <= g.cellHeight - CARD.gap);
}, 'the grid tiles the screen and the card fits inside one cell');

check(() => {
  const a = dealCard({ screen: table, card: CARD, windows: [], key: 'bc-abcd · fix the thing' });
  const b = dealCard({ screen: table, card: CARD, windows: [], key: 'bc-abcd · fix the thing' });
  assert.deepEqual(a, b);
}, 'the same session reopened lands on the same square of the table');

check(() => {
  const a = dealCard({ screen: table, card: CARD, windows: [], key: 'bc-one' });
  const b = dealCard({ screen: table, card: CARD, windows: [], key: 'bc-two' });
  assert.notDeepEqual(a.cell, b.cell, 'two sessions on an empty table do not both take the top left');
}, 'and two different sessions do not stack on an empty table');

check(() => {
  const dealt = [];
  const windows = [];
  for (let i = 0; i < 20; i++) {
    const rect = dealCard({ screen: table, card: CARD, windows, key: `bc-${i}` });
    dealt.push(rect);
    windows.push([rect.left, rect.top, rect.right, rect.bottom]);
  }
  const g = grid(table, CARD);
  const room = g.cols * g.rows;
  for (let i = 0; i < Math.min(dealt.length, room); i++) {
    for (let j = i + 1; j < Math.min(dealt.length, room); j++) {
      assert.ok(!overlaps(dealt[i], dealt[j]), `cards ${i} and ${j} overlap`);
    }
  }
}, 'cards dealt onto an empty table never cover each other');

check(() => {
  const windows = [];
  const g = grid(table, CARD);
  for (let i = 0; i < g.cols * g.rows; i++) {
    const rect = dealCard({ screen: table, card: CARD, windows, key: `bc-${i}` });
    windows.push([rect.left, rect.top, rect.right, rect.bottom]);
  }
  const cells = new Set(windows.map((w) => `${w[0]},${w[1]}`));
  assert.equal(cells.size, g.cols * g.rows, 'every cell got exactly one card before any got two');
}, 'the emptiest cell wins, so a table with room in it fills before it stacks');

check(() => {
  for (const key of ['bc-a', 'bc-b', 'bc-c', 'bc-d', 'bc-e']) {
    const r = dealCard({ screen: table, card: CARD, key });
    assert.ok(r.left >= table.left, `${key} ran off the left`);
    assert.ok(r.top >= table.top, `${key} ran off the top`);
    assert.ok(r.right <= table.left + table.width, `${key} ran off the right`);
    assert.ok(r.bottom <= table.top + table.height, `${key} ran off the bottom`);
  }
}, 'no card ever lands off the edge of the table');

check(() => {
  const snapped = ['bc-a', 'bc-b', 'bc-c'].map((key) =>
    dealCard({ screen: table, card: { ...CARD, jitter: 0 }, key })
  );
  const offsets = new Set(
    snapped.map((r) => {
      const g = grid(table, CARD);
      return `${(r.left - table.left) % g.cellWidth},${(r.top - table.top) % g.cellHeight}`;
    })
  );
  assert.equal(offsets.size, 1, 'jitter 0 means every card sits at the same spot in its cell');
}, 'the wander is a setting, and turning it off snaps the cards to the grid');

check(() => {
  // A phone-sized screen: one cell, a card shrunk to fit, and still no negative width.
  const tiny = { index: 0, left: 0, top: 0, width: 400, height: 300 };
  const r = dealCard({ screen: tiny, card: CARD, key: 'bc-tiny' });
  assert.ok(r.right - r.left >= 120 && r.bottom - r.top >= 120, 'the card is still a window');
  assert.ok(r.left >= 0 && r.top >= 0, 'and it starts on the screen');
}, 'a screen too small for a card gets one shrunken card, not a negative rectangle');

check(() => {
  assert.equal(boundsArg({ left: 1, top: -2, right: 3, bottom: 4 }), '1,-2,3,4');
  assert.equal(boundsArg(null), '', 'no rectangle is an empty argument, which the script reads as "cascade"');
}, 'a rectangle reaches AppleScript as four integers it can coerce');

await checkAsync(async () => {
  assert.equal(await restoreApp(null), false);
  assert.equal(await restoreApp(ITERM_BUNDLE_ID), false, 'handing focus back to iTerm is the AppleScript’s job');
}, 'there is nothing to hand the keyboard back to when iTerm already had it');

/* ------------------------------------------------------- what AppleScript is told */

const script = fs.readFileSync(path.join(ROOT, 'scripts', 'open-session.applescript'), 'utf8');

check(() => {
  for (const n of ['item 3 of argv', 'item 4 of argv', 'item 5 of argv']) {
    assert.ok(script.includes(n), `the script never reads ${n}`);
  }
  assert.ok(/if \(count of argv\) > 2/.test(script), 'and it tolerates a caller that passes only two');
}, 'the profile, the bounds and the focus choice all arrive as argv');

check(() => {
  assert.ok(/set bounds of newWindow to rect/.test(script));
  // position/size/origin/frame are all in iTerm's dictionary and every one of them
  // raises -10000 on 3.6.11. Reaching for them again is the obvious refactor and it
  // silently stops placing windows.
  assert.ok(!/set (position|size|origin|frame) of/.test(script), 'those handlers do not work');
}, 'geometry is one rectangle set as bounds, because bounds is the only setter iTerm honours');

check(() => {
  assert.ok(/create window with profile theProfile/.test(script));
  assert.ok(/create window with default profile/.test(script), 'the fallback for an iTerm that has not loaded it yet');
}, 'the profile is asked for, and a missing profile still opens a window');

check(() => {
  const tellAt = script.indexOf('tell application id');
  const delimiterAt = script.indexOf("text item delimiters");
  assert.ok(delimiterAt > 0 && delimiterAt < tellAt, 'set inside the tell block, iTerm answers -10006');
}, 'the rectangle is parsed before the tell block, where text item delimiters still belong to AppleScript');

check(() => {
  const at = script.indexOf('select priorWindow');
  assert.ok(at > 0, 'nothing hands the keyboard back');
  assert.ok(/delay 0\.4[\s\S]{0,200}select priorWindow/.test(script), 'without the beat, select loses the race');
}, 'the keyboard goes back to the window that had it, after a beat long enough to win');

/* --------------------------------------------------------- what the caller passes */

const session = fs.readFileSync(path.join(ROOT, 'lib', 'session.js'), 'utf8');

check(() => {
  assert.ok(/placement\(windows, tabTitle\)/.test(session), 'the placement is keyed on the tab title, which carries the bead id');
  assert.ok(/\[SCRIPT, command, tabTitle, profile, bounds,/.test(session), 'the script is called with all five');
}, 'the launcher hands the script a profile and a rectangle');

check(() => {
  assert.ok(/takeFocus \? 'take-focus' : 'return-focus'/.test(session));
  assert.ok(/if \(prior\) restoreApp\(prior\)/.test(session), 'the cross-app half of handing focus back');
}, 'and says whether the window may keep the keyboard');

const config = fs.readFileSync(path.join(ROOT, 'lib', 'config.js'), 'utf8');

check(() => {
  assert.ok(/cfg\.sessionWindows = \{ \.\.\.defaults\(\)\.sessionWindows/.test(config));
  assert.ok(/cfg\.sessionWindows\.card = \{ \.\.\.defaults\(\)\.sessionWindows\.card/.test(config), 'two levels, or a card edited by hand loses its other dimension');
}, 'a config written before any of this existed still gets every default under sessionWindows');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
