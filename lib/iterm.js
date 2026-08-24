import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The same gate that stands in front of opening a window, read for closing one. See
// `closeEmptyWindows`.
import { mayLaunch } from './launchguard.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT_SCRIPT = path.join(ROOT, 'scripts', 'iterm-layout.jxa');
const EMPTY_SCRIPT = path.join(ROOT, 'scripts', 'close-empty-windows.applescript');

/**
 * The terminal windows this daemon opens: a profile of their own, and a place to put them.
 *
 * Two problems, one module, because they are the same problem seen twice — a session
 * window used to be whatever iTerm felt like making. It inherited the Default profile,
 * so a scrollback trimmed for a shell threw away the first half of an hour-long agent
 * session; and it landed wherever iTerm cascades, which with three displays and a dozen
 * live sessions means *on top of the window you are typing in*, on whichever screen you
 * happened to be working.
 *
 * So the windows get:
 *
 *   - **A dynamic profile**, written to disk by this daemon and picked up by iTerm
 *     without a restart. It inherits from Default (see `PARENT`) so it still looks like
 *     your terminal, and overrides only what a session needs to differ on.
 *   - **A card table.** One screen, a grid of slots, each window jittered inside its own
 *     slot so the set reads as cards dealt on a table rather than a stack of identical
 *     rectangles snapped to a grid. Cells tile and never overlap, so the jitter cannot
 *     make two cards cover each other however unlucky the hash.
 *
 * Everything here except `ensureProfile` and `probe` is a pure function of numbers, and
 * that is deliberate: the layout cannot be exercised for real without a Mac with the
 * right monitors plugged into it, so the arithmetic is kept where a test can reach it
 * and the two functions that touch the world stay thin enough to read.
 */

/** What the profile is called in iTerm's profile list, and what AppleScript asks for. */
export const PROFILE_NAME = 'Beadcause';

/**
 * The profile's identity to iTerm, stable forever.
 *
 * Dynamic profiles are keyed by Guid, not by name and not by filename: change this and
 * iTerm does not update the profile, it grows a second one — and every window already
 * open on the old Guid keeps it. It is not a UUID because it does not have to be one,
 * and a readable string is worth something the day you go looking for it in iTerm's
 * preferences.
 */
export const PROFILE_GUID = 'beadcause-session-card';

/**
 * Inherit from Default rather than specifying a whole profile.
 *
 * The alternative is writing font, colours, cursor, shell and forty other keys into this
 * file, which would mean session windows stop looking like your terminal the moment you
 * change your terminal. With a parent, the only keys here are the ones a session
 * genuinely needs, and everything else follows Default on its own.
 */
const PARENT = 'Default';

/** The directory iTerm watches. Overridable so a test never writes into a real iTerm. */
export function profileDir() {
  return (
    process.env.BEADCAUSE_ITERM_PROFILE_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'iTerm2', 'DynamicProfiles')
  );
}

export function profilePath(dir = profileDir()) {
  return path.join(dir, 'beadcause.json');
}

/**
 * The profile itself.
 *
 * `Screen` is iTerm's own display preference, and it is set even though the window's
 * bounds are assigned a moment later: without it the window is *born* on whichever
 * display iTerm last used and then jumps across the desk, and the jump is visible. With
 * it, the window appears on the right screen and only slides within it. -1 is iTerm's
 * "no preference", which is the right answer for a Mac with one display.
 *
 * The other three are what a session needs and a shell does not:
 *
 *   - **Unlimited scrollback**, because the interesting part of an agent session is
 *     usually the part that has already scrolled past, and a session that ran for an
 *     hour under a 1000-line default has dropped the evidence you came for.
 *   - **No prompt before closing.** A worker ends by closing its own window; a
 *     confirmation sheet there is a dialog nobody is in the room to answer, and it
 *     leaves dead windows on the table for the sweep to trip over.
 *   - **Normal window type**, so a Default profile set to full screen or full-width
 *     cannot quietly defeat the whole layout.
 */
export function profileDocument({ columns = 96, rows = 30, screen = -1 } = {}) {
  return {
    Profiles: [
      {
        Name: PROFILE_NAME,
        Guid: PROFILE_GUID,
        'Dynamic Profile Parent Name': PARENT,
        Columns: columns,
        Rows: rows,
        Screen: screen,
        'Window Type': 0,
        'Unlimited Scrollback': true,
        'Prompt Before Closing 2': 0,
      },
    ],
  };
}

/**
 * Write the profile, but only when it is not already exactly this.
 *
 * iTerm watches the directory and reloads every profile on each write, so rewriting on
 * every session open would reload them a dozen times an hour for nothing. The comparison
 * is on the serialised document rather than on mtime, so a hand-edited file is repaired
 * and an unchanged one is left alone.
 *
 * Failure is returned, never thrown. A profile that could not be written costs the
 * windows their scrollback; a throw here would cost you the session, and the session is
 * the point — which is also why the AppleScript falls back to the default profile rather
 * than erroring when the profile is not there yet.
 */
export function ensureProfile(opts = {}, dir = profileDir()) {
  const file = profilePath(dir);
  const body = `${JSON.stringify(profileDocument(opts), null, 2)}\n`;
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) {
      return { name: PROFILE_NAME, path: file, written: false };
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    return { name: PROFILE_NAME, path: file, written: true };
  } catch (err) {
    return { name: null, path: file, written: false, error: err.message };
  }
}

/* --------------------------------------------------------------- the card table */

/**
 * AppKit's coordinates, flipped into the ones iTerm's `bounds` speaks.
 *
 * NSScreen measures from the bottom left of the primary display with y growing upwards;
 * an iTerm window's `bounds` is measured from the *top* left with y growing down. So a
 * display stacked above the primary one has a positive y in AppKit and a negative top
 * here — and that is correct: a window on the monitor above this laptop really does live
 * at y = -2127.
 *
 * This is the one piece of arithmetic everything else depends on, which is why the probe
 * hands over raw AppKit numbers instead of doing it in JXA where nothing could test it.
 */
export function screenRects({ primaryHeight = 0, screens = [] } = {}) {
  return screens.map((s) => ({
    index: s.index,
    left: Math.round(s.x),
    top: Math.round(primaryHeight - (s.y + s.height)),
    width: Math.round(s.width),
    height: Math.round(s.height),
  }));
}

/**
 * Which display the table is laid on.
 *
 * `largest` by default, and that is not arbitrary: the point of a card table is fitting
 * several readable windows side by side, so the default should be the screen with the
 * most room — which on a laptop with nothing plugged in is the laptop, so one default is
 * right in both cases without being configured.
 *
 * A number is an index into the same order AppKit and iTerm use, so it agrees with the
 * `Screen` key in the profile. An index that no longer exists — a monitor unplugged
 * mid-week — falls back rather than failing: a card on the wrong screen is a nuisance, a
 * session that would not open is a problem.
 */
export function pickScreen(rects, choice = 'largest') {
  if (!rects.length) return null;
  const n = typeof choice === 'string' && /^\d+$/.test(choice) ? Number(choice) : choice;
  if (Number.isInteger(n)) return rects.find((r) => r.index === n) || rects[0];
  if (n === 'main') return rects.find((r) => r.index === 0) || rects[0];
  return rects.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
}

/**
 * A small, stable hash — several independent values out of one string, by salting.
 *
 * Deterministic on purpose. `Math.random` would put the same session somewhere different
 * every time it was reopened, and would leave the layout untestable; FNV-1a is six lines
 * and its distribution only has to be good enough to look unplanned.
 */
function hash(key, salt) {
  let h = 0x811c9dc5;
  const s = `${salt}:${key}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A hashed value in [0, 1). */
const unit = (key, salt) => hash(key, salt) / 0x100000000;

/**
 * The grid the cards are dealt into.
 *
 * Cells tile the screen exactly and a card sits *inside* its cell with the gap around
 * it, which is what makes overlap impossible rather than unlikely: the jitter below can
 * only move a card within the slack its own cell has, so two cards can never reach each
 * other. A screen too small for even one card gets a one-by-one grid with the card
 * shrunk to fit, because a card larger than the screen is worse than a small one.
 */
export function grid(screen, card = {}) {
  const gap = Math.max(0, card.gap ?? 24);
  const width = Math.max(120, card.width ?? 780);
  const height = Math.max(120, card.height ?? 540);
  const cols = Math.max(1, Math.floor(screen.width / (width + gap)));
  const rows = Math.max(1, Math.floor(screen.height / (height + gap)));
  const cellWidth = Math.floor(screen.width / cols);
  const cellHeight = Math.floor(screen.height / rows);
  return {
    cols,
    rows,
    cellWidth,
    cellHeight,
    width: Math.max(120, Math.min(width, cellWidth - gap)),
    height: Math.max(120, Math.min(height, cellHeight - gap)),
  };
}

/** Which cell a rectangle's centre falls in, or null if it is on another screen. */
function cellOf(rect, screen, g) {
  const cx = (rect[0] + rect[2]) / 2;
  const cy = (rect[1] + rect[3]) / 2;
  if (cx < screen.left || cx >= screen.left + screen.width) return null;
  if (cy < screen.top || cy >= screen.top + screen.height) return null;
  const col = Math.min(g.cols - 1, Math.floor((cx - screen.left) / g.cellWidth));
  const row = Math.min(g.rows - 1, Math.floor((cy - screen.top) / g.cellHeight));
  return row * g.cols + col;
}

/**
 * Deal one card: where this window goes, given the windows already on the table.
 *
 * The emptiest cell wins, so a table with room in it never stacks. Ties are broken by
 * the key's hash rather than by index, so two sessions opened a second apart do not both
 * take the top left and the table fills in an order that looks dealt rather than
 * queued. Once every cell holds one, the counts rise evenly and cards do begin to sit on
 * each other — which is the honest behaviour for a screen with more sessions on it than
 * it has room for.
 *
 * `key` is what makes it stable: the same session reopened lands in the same place, and
 * a test can assert an exact rectangle instead of a range.
 */
export function dealCard({ screen, card = {}, windows = [], key = '' }) {
  const g = grid(screen, card);
  const cells = new Array(g.cols * g.rows).fill(0);
  for (const w of windows) {
    const i = cellOf(w, screen, g);
    if (i !== null && i >= 0 && i < cells.length) cells[i] += 1;
  }

  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < cells.length; i++) {
    // The tiebreak is a fraction, so it can only ever separate cells that are level.
    const score = cells[i] + unit(key, `cell${i}`) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }

  const col = best % g.cols;
  const row = Math.floor(best / g.cols);
  const cellLeft = screen.left + col * g.cellWidth;
  const cellTop = screen.top + row * g.cellHeight;

  // Centre the card in its cell, then let it wander by up to `jitter` in each direction
  // — clamped to the slack the cell actually has, which is what keeps a card inside its
  // own cell on a screen too tight to wander on.
  const amp = Math.max(0, card.jitter ?? 18);
  const slackX = Math.max(0, g.cellWidth - g.width);
  const slackY = Math.max(0, g.cellHeight - g.height);
  const spreadX = Math.min(slackX, amp * 2);
  const spreadY = Math.min(slackY, amp * 2);
  const left = Math.round(cellLeft + (slackX - spreadX) / 2 + unit(key, 'x') * spreadX);
  const top = Math.round(cellTop + (slackY - spreadY) / 2 + unit(key, 'y') * spreadY);

  return { left, top, right: left + g.width, bottom: top + g.height, cell: { col, row } };
}

/** How a rectangle reaches AppleScript: four integers it can coerce and set as bounds. */
export const boundsArg = (rect) =>
  rect ? [rect.left, rect.top, rect.right, rect.bottom].map((n) => Math.round(n)).join(',') : '';

/**
 * …and back again: the same four integers, as the focus script prints them.
 *
 * `scripts/focus-session.applescript` returns the window's bounds *before* it changed
 * anything, and that string is the only record of where the window was — so a reading
 * that will not parse must be null rather than a rectangle of NaNs, which would be
 * saved as the thing to restore to and would move the window somewhere unreachable.
 */
export function parseBounds(text) {
  const parts = String(text || '')
    .trim()
    .split(',')
    .map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [left, top, right, bottom] = parts.map(Math.round);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/** Which measured screen a rectangle is on, by its centre. Null when nothing was measured. */
export function screenOf(rect, rects = []) {
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  return (
    rects.find(
      (s) => cx >= s.left && cx < s.left + s.width && cy >= s.top && cy < s.top + s.height
    ) || null
  );
}

/**
 * Twice as wide and twice as tall, about the same centre, kept on its screen.
 *
 * "Twice the size" is read as each edge doubled rather than the area doubled, which is
 * the reading that makes the window worth walking over to: a 780×540 card becomes
 * 1560×1080, which is most of a laptop display and a comfortable quarter of a 4K.
 *
 * **Clamped, not allowed to overflow.** A window doubled about its centre near an edge
 * would put half of itself past the screen, and the half that goes missing is as likely
 * to be the one with the prompt in it as not — a window you then have to drag back is
 * worse than one that grew a little less than asked. So the size is capped at the
 * screen, and the position is slid back inside it; a window already filling its screen
 * therefore does not move at all, which is the honest answer rather than a failure.
 *
 * **A null screen means nothing could be measured**, and then it does not grow about the
 * centre at all: it pins the top left corner and extends right and down. That is not a
 * lesser version of the same thing, it is the safe direction. Growing about the centre
 * without knowing where the screen edges are put a real window 368px off the left of a
 * real display the first time this ran — and the corner that goes missing that way is
 * the one with the window's controls on it, which is a window you cannot drag back.
 * Overflowing right and down is recoverable; overflowing up and left is not.
 */
export function magnify(rect, screen = null, factor = 2) {
  let width = Math.round(Math.max(1, rect.right - rect.left) * factor);
  let height = Math.round(Math.max(1, rect.bottom - rect.top) * factor);
  if (!screen) return { left: rect.left, top: rect.top, right: rect.left + width, bottom: rect.top + height };

  width = Math.min(width, screen.width);
  height = Math.min(height, screen.height);
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const left = Math.min(Math.max(Math.round(cx - width / 2), screen.left), screen.left + screen.width - width);
  const top = Math.min(Math.max(Math.round(cy - height / 2), screen.top), screen.top + screen.height - height);
  return { left, top, right: left + width, bottom: top + height };
}

/** The whole decision, from a probe reading: where a window goes when it is made big. */
export function enlarged(rect, measured = null, factor = 2) {
  return magnify(rect, screenOf(rect, screenRects(measured || {})), factor);
}

/* -------------------------------------------------------------------- the probe */

/**
 * Ask the Mac where its displays are, and where iTerm's windows already are.
 *
 * Five seconds, which is generous for a call that measures ~150ms with a dozen windows
 * open, and never fatal: a probe that fails resolves to null and the window opens
 * without bounds, exactly as it did before any of this existed. The layout is a
 * courtesy; the session is not.
 */
export function probe({ timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', LAYOUT_SCRIPT], { timeout }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const parsed = JSON.parse(String(stdout || '').trim());
        resolve(parsed && Array.isArray(parsed.screens) ? parsed : null);
      } catch {
        return resolve(null);
      }
    });
  });
}

/* ------------------------------------------------------- the windows left behind */

/**
 * What `scripts/close-empty-windows.applescript` printed, read back.
 *
 * Its own function, and exported, because it is the only part of that sweep a test can
 * reach: the script itself needs a Mac with iTerm on it and windows in the exact state
 * this exists to clean up — a state that cannot be manufactured, since iTerm closes a
 * window with its last tab every time you ask it to (measured, on 3.6.11) and only
 * occasionally fails to on its own. So the boundary is where the testing stops: the
 * script is read by eye, and everything downstream of its output is arithmetic.
 *
 * Anything that is not a count followed by ids reads as zero rather than as an error.
 * A sweep that could not be understood closed nothing, and that is the same outcome for
 * the caller as a sweep that found nothing — the honest one, too, since the script only
 * ever prints after it has finished closing.
 *
 * Two lines now, not one, and the second is the whole of bc-xl7n.110. The first is what
 * it has always been — a count and the ids behind it — except that the script now verifies
 * each one is really gone before it goes in there. The optional second line, `stuck 47768
 * 47792`, names the windows that were asked to close and did not, which used to be counted
 * as successes and announced 2,330 times. `stuck` is empty when the line is absent, which
 * is the ordinary case.
 *
 * A garbled first line still voids the whole read, `stuck` included. One rule rather than
 * two: output this did not understand is a sweep whose result is unknown, and reporting
 * half of an unknown result as a finding is how the last version of this got believed.
 */
export function parseClosedWindows(stdout) {
  const lines = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const head = lines.find((l) => !l.startsWith('stuck')) || '';
  const parts = head.split(/\s+/).filter(Boolean);
  const closed = Number(parts[0]);
  if (!Number.isInteger(closed) || closed < 0) return { closed: 0, ids: [], stuck: [] };
  const stuckLine = lines.find((l) => l.startsWith('stuck'));
  const stuck = stuckLine ? stuckLine.split(/\s+/).slice(1) : [];
  return { closed, ids: parts.slice(1, closed + 1), stuck };
}

/**
 * Which of this sweep's stuck windows have not been reported yet — and remember them.
 *
 * `reported` is the caller's Set and is updated in place; the return is the ids worth a
 * line. A window that will not close will be in *every* sweep from now until somebody
 * dismisses it by hand, and a line a tick is how a log stops being read — which is the
 * lesson bc-xl7n.110 is made of, since the 2,330 lines it was filed over were the same
 * handful of ids repeated. So each id is said once.
 *
 * An id is forgotten the moment it stops coming back, rather than kept for the life of the
 * daemon. iTerm reuses window ids freely, so a number that has gone quiet and returns is a
 * *different* frame, and it has never been reported: holding the id for ever would swallow
 * it. That is also what makes the memory bounded by what is on the desk now rather than by
 * how long the daemon has been up.
 */
export function unreportedStuck(reported, stuck = []) {
  const now = new Set(stuck);
  for (const id of reported) if (!now.has(id)) reported.delete(id);
  const fresh = stuck.filter((id) => !reported.has(id));
  for (const id of fresh) reported.add(id);
  return fresh;
}

/**
 * Close every iTerm window that has lost its last tab. See the script for what they are.
 *
 * Shaped like `probe` above and for the same reasons: five seconds, and never fatal. A
 * failure here is a blank window left on the desk for one more tick, which is exactly
 * where the daemon was before this existed — so the error is *returned* rather than
 * thrown, and the caller decides whether it is worth a line in the log.
 *
 * `closed`/`ids` are windows that were verified gone afterwards, and `stuck` names the ones
 * that took a close and stayed — see `parseClosedWindows`. A caller that logs `closed` is
 * logging an effect now rather than an attempt; a caller that logs `stuck` should do it
 * once per window and not once per tick, because the whole point of that list is that its
 * members do not change.
 *
 * Note what it does not take: a list of windows to close, or a window to spare. The
 * script asks iTerm and closes what it finds in the same Apple event, because the two
 * halves cannot be split without inventing a race that does not otherwise exist — a
 * window read as empty here and closed a second later is a window that could have been
 * given a tab in between (`create tab` targets `current window`, and open-handoff.sh
 * does exactly that). Inside one event there is no in between.
 */
export function closeEmptyWindows({ timeout = 5000 } = {}) {
  // A process that may not *open* a window on this Mac may not close one either, and
  // that is one rule rather than two: both are this daemon reaching out of its process
  // and moving something on somebody's desk. lib/launchguard.js already answers it, and
  // answers it for every suite at once — scripts/test.mjs sets `BEADCAUSE_NO_LAUNCH`, so
  // no test can drive iTerm here by forgetting to stub something. `refused` rather than
  // an error: nothing went wrong, and a caller that logged this would log it every tick.
  if (!mayLaunch()) return Promise.resolve({ closed: 0, ids: [], stuck: [], error: null, refused: true });
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', [EMPTY_SCRIPT], { timeout }, (err, stdout) => {
      if (err) return resolve({ closed: 0, ids: [], stuck: [], error: String(err.message || err).split('\n')[0] });
      resolve({ ...parseClosedWindows(stdout), error: null });
    });
  });
}

/* ------------------------------------------------------------ borrowing focus */

/** iTerm's bundle id, in the one place that has to compare against it. */
export const ITERM_BUNDLE_ID = 'com.googlecode.iterm2';

/**
 * Which app has the keyboard right now, as a bundle id.
 *
 * `lsappinfo`, not System Events. Asking System Events for the frontmost process is the
 * usual recipe and it needs an Automation grant — and this daemon runs under launchd,
 * where a TCC prompt may never be shown to anybody at all, so the usual recipe fails
 * invisibly and permanently on the one machine it has to work on. `lsappinfo` is a plain
 * command against the launch services database and needs nothing.
 *
 * Two calls because the first gives an ASN and only the second turns it into a bundle
 * id. Null on any failure, which the caller reads as "nothing to hand back to".
 */
export function frontmostApp({ timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    execFile('/usr/bin/lsappinfo', ['front'], { timeout }, (err, stdout) => {
      const asn = String(stdout || '').trim();
      if (err || !asn) return resolve(null);
      execFile('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', asn], { timeout }, (e2, out2) => {
        if (e2) return resolve(null);
        const m = String(out2 || '').match(/"CFBundleIdentifier"="([^"]+)"/);
        resolve(m ? m[1] : null);
      });
    });
  });
}

/**
 * Give the keyboard back to the app that had it.
 *
 * `open -b` rather than an `activate` of our own: the bundle id came from
 * `lsappinfo front` a second ago, so the app is running and this only raises it. Errors
 * are swallowed — this is the courtesy at the end of opening a session, and a session
 * that opened successfully must not be reported as failed because the app that had focus
 * quit while it was starting.
 */
export function restoreApp(bundleId, { timeout = 3000 } = {}) {
  if (!bundleId || bundleId === ITERM_BUNDLE_ID) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-b', bundleId], { timeout }, (err) => resolve(!err));
  });
}

/** The screen the profile should name before anything has been measured. */
function configuredScreen(settings) {
  const choice = settings.screen;
  if (Number.isInteger(choice)) return choice;
  if (typeof choice === 'string' && /^\d+$/.test(choice)) return Number(choice);
  return -1;
}

/**
 * The whole placement decision, from config to the two strings AppleScript takes.
 *
 * One function, because the caller should not have to know that a failed probe, an empty
 * screen list and a switched-off layout all end the same way — with a profile and no
 * bounds, which is a window that opens exactly as it used to.
 */
export async function placement(settings = {}, key = '') {
  // On a machine that has never had the profile, write it before the probe rather than
  // after: the probe costs ~150ms, and those are 150ms in which iTerm can notice the new
  // file, which is the difference between the *first* session of a new install opening on
  // the profile and falling back to Default. Only when it is absent — doing it every time
  // would write the configured screen and then the measured one, reloading iTerm's
  // profiles twice per session for no gain.
  if (!fs.existsSync(profilePath())) ensureProfile({ screen: configuredScreen(settings) });

  if (settings.layout === false) {
    const profile = ensureProfile({ screen: configuredScreen(settings) });
    return { profile: profile.name || '', bounds: '' };
  }

  const measured = await probe();
  const target = pickScreen(screenRects(measured || {}), settings.screen ?? 'largest');
  // The profile is written *after* the probe, because the screen it names is the screen
  // that was just chosen — that is what stops a window being born on the wrong display
  // and jumping across the desk on its way to the table.
  const profile = ensureProfile({ screen: target ? target.index : configuredScreen(settings) });
  if (!target) return { profile: profile.name || '', bounds: '' };

  const card = { ...(settings.card || {}), jitter: settings.jitter };
  const rect = dealCard({ screen: target, card, windows: (measured && measured.windows) || [], key });
  return { profile: profile.name || '', bounds: boundsArg(rect), screen: target.index };
}
