#!/usr/bin/env node
/**
 * A live view of what beadcause is doing, on the Mac it runs on.
 *
 *   npm run monitor                 # foreground, in any terminal
 *   node bin/monitor.js --once      # render one frame and exit
 *   node bin/monitor.js --url http://127.0.0.1:4318
 *
 * The daemon does nearly all of its work invisibly: polling five workspaces,
 * deciding whether a space is allowed to interrupt right now, dispatching
 * unattended agents at comments. This is the window onto that.
 *
 * It is a *consumer*, not new instrumentation. Everything here comes from
 * `GET /api/poll` — the same long-poll feed the phone lives on — plus the local
 * status file agents write their progress into. Nothing was added to the server for
 * it, which is what guarantees that a wedged or closed monitor can never cost the
 * daemon a question.
 *
 * No dependencies, and no TUI library: the project has none, and a live view of
 * five workspaces is not worth acquiring one for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, CONFIG_DIR, CONFIG_PATH } from '../lib/config.js';
import { PHASES } from '../lib/activity.js';
import { isQuiet, quietUntil } from '../lib/spaces.js';

/* ------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, dflt) => {
  const i = argv.indexOf(n);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

if (flag('--help') || flag('-h')) {
  console.log(`usage: beadcause-monitor [--url <base>] [--once] [--no-alt]

  --once     render a single frame and exit (screenshots, cron, sanity checks)
  --no-alt   draw inline instead of taking over the screen
  --url      the daemon to watch (default http://127.0.0.1:<configured port>)`);
  process.exit(0);
}

const ONCE = flag('--once');
const STATUS_PATH = path.join(CONFIG_DIR, 'status.json');

let cfg = loadConfig();
const BASE = opt('--url', `http://127.0.0.1:${cfg.port || 4318}`).replace(/\/+$/, '');

const TTY = Boolean(process.stdout.isTTY);
// Piped somewhere and expected to keep running: a redrawn full-screen frame would
// be nonsense in a log file, so fall back to one line per event.
const LINE_MODE = !TTY && !ONCE;
const ALT = TTY && !ONCE && !flag('--no-alt');

/* --------------------------------------------------------------------- colour */

const mono = !TTY || Boolean(process.env.NO_COLOR);
const sgr = (code) => (mono ? (s) => String(s) : (s) => `\x1b[${code}m${s}\x1b[0m`);
const C = {
  dim: sgr(2),
  bold: sgr(1),
  red: sgr(31),
  green: sgr(32),
  yellow: sgr(33),
  blue: sgr(34),
  magenta: sgr(35),
  cyan: sgr(36),
  redBold: sgr('1;31'),
  cyanBold: sgr('1;36'),
};

/* ---------------------------------------------------------------------- width */

/*
 * Terminal columns, not code units. The box has a right-hand border, so a phase
 * icon miscounted by one column shears every line beneath it — and JS string length
 * is no guide at all: '⏳' is one code unit and two columns, '🤔' is two of each.
 * So the East-Asian-wide and emoji ranges are consulted directly, and the two
 * modifiers that change a *neighbour's* width are handled where they appear: U+FE0F
 * promotes the character before it to emoji presentation, and a ZWJ fuses the glyph
 * after it into the one before.
 */
const WIDE = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  // The scattered pre-emoji BMP characters that still render double-width.
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
];
const ZERO = [[0x0300, 0x036f], [0x200b, 0x200f], [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0x1f3fb, 0x1f3ff]];

const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (s) => [...SEGMENTER.segment(String(s))].map((g) => g.segment);

/** Columns occupied by one grapheme cluster. */
function clusterWidth(g) {
  let n = 0;
  let last = 0;
  let joined = false;
  for (const ch of g) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d) { joined = true; continue; }
    if (joined) { joined = false; continue; }
    if (cp === 0xfe0f) { if (last === 1) { n += 1; last = 2; } continue; }
    if (cp < 0x20) continue;
    last = inRanges(cp, ZERO) ? 0 : inRanges(cp, WIDE) ? 2 : 1;
    n += last;
  }
  return n;
}

const dw = (s) => graphemes(s).reduce((n, g) => n + clusterWidth(g), 0);

/** The longest prefix of `s` that fits in `max` columns. */
function cut(s, max) {
  let text = '';
  let width = 0;
  for (const g of graphemes(s)) {
    const w = clusterWidth(g);
    if (width + w > max) break;
    text += g;
    width += w;
  }
  return { text, width };
}

/* ------------------------------------------------------------ line composition */

/**
 * A run of styled text with a known column width.
 *
 * Colour is applied per part and never nested, because an ANSI reset in the middle
 * of a nested pair drops the outer style for the rest of the line — and measuring
 * happens at `add()` time, on the plain text, so escape codes can never leak into
 * the arithmetic.
 */
function seg() {
  const parts = [];
  let width = 0;
  const api = {
    add(text, colour) {
      const t = String(text ?? '');
      if (t) {
        parts.push([t, colour]);
        width += dw(t);
      }
      return api;
    },
    get width() {
      return width;
    },
    ansi() {
      return parts.map(([t, colour]) => (colour ? colour(t) : t)).join('');
    },
    /** Exactly `max` columns: space-padded, or truncated with an ellipsis. */
    render(max) {
      if (max <= 0) return '';
      if (width <= max) return api.ansi() + ' '.repeat(max - width);
      let out = '';
      let n = 0;
      for (const [t, colour] of parts) {
        const piece = cut(t, max - 1 - n);
        out += colour ? colour(piece.text) : piece.text;
        n += piece.width;
        if (piece.width < dw(t)) break;
      }
      return out + C.dim('…') + ' '.repeat(Math.max(0, max - n - 1));
    },
  };
  return api;
}

const BOX = { top: ['┌', '┐'], mid: ['├', '┤'], bottom: ['└', '┘'] };

let W = 100;

/** Content row: `left` from the margin, `right` flush to the border. */
function row(left, right) {
  const r = right && right.width ? right : null;
  const body = left.render(W - 4 - (r ? r.width + 2 : 0)) + (r ? '  ' + r.ansi() : '');
  return C.dim('│') + ' ' + body + ' ' + C.dim('│');
}

/** Horizontal rule, optionally labelled at either end. */
function rule(kind, left, right) {
  const [a, b] = BOX[kind];
  const lw = left && left.width ? left.width + 2 : 0;
  const rw = right && right.width ? right.width + 2 : 0;
  return (
    C.dim(a + '─') +
    (lw ? ' ' + left.ansi() + ' ' : '') +
    C.dim('─'.repeat(Math.max(1, W - 4 - lw - rw))) +
    (rw ? ' ' + right.ansi() + ' ' : '') +
    C.dim('─' + b)
  );
}

/* --------------------------------------------------------------------- format */

const pad2 = (n) => String(n).padStart(2, '0');

function ago(at, now) {
  if (!at) return '';
  const s = Math.round((now - new Date(at)) / 1000);
  if (Number.isNaN(s)) return '';
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** "09:00" for later today, "Mon 09:00" for anything further out. */
function clock(d, now) {
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}`;
}

function stamp(at) {
  const d = at ? new Date(at) : new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const priorityColour = (p) => (p === 0 ? C.redBold : p === 1 ? C.red : p === 2 ? C.yellow : C.dim);

const EVENT_COLOUR = {
  advocate: C.cyanBold,
  question: C.yellow,
  reply: C.green,
  commented: C.cyan,
  created: C.blue,
  activity: C.magenta,
  answered: C.dim,
  resync: C.red,
  monitor: C.dim,
};

/** One line of context per event type — what you would want to read at a glance. */
function eventDetail(e) {
  switch (e.type) {
    case 'question':
    case 'created':
      return `${e.title || ''}${e.quiet ? '  (quiet — not pushed)' : ''}`;
    case 'reply':
      return `from ${e.author || 'someone'}${e.text ? ` · ${e.text.replace(/\s+/g, ' ')}` : ''}`;
    case 'activity':
      return [e.activity?.phase, e.activity?.detail].filter(Boolean).join(' · ');
    case 'answered':
      return 'closed or answered elsewhere';
    case 'commented':
      return 'you commented — an agent should pick it up';
    case 'resync':
      return 'reconnected after falling off the event log';
    case 'advocate': {
      // The action is the verb and the key already carries the repo, so this line
      // is only what the verb doesn't say: which bead, and why.
      const what = [e.title, e.detail].filter(Boolean).join(' — ');
      return `${e.action || 'tick'}${what ? `  ${what}` : ''}`;
    }
    case 'monitor':
      return `watching ${BASE} — everything the daemon does appears here`;
    default:
      return '';
  }
}

/* ---------------------------------------------------------------------- state */

const state = {
  since: null, // null means "cold start": ask for the full picture
  questions: [],
  spaces: [],
  advocates: [],
  workspaces: [],
  events: [{ type: 'monitor', at: new Date().toISOString(), key: '' }], // newest first
  status: {}, // status.json, merged over each question's activity
  conn: 'connecting',
  connDetail: '',
};

let statusMtime = null;
let configMtime = null;

const mtimeOf = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Pick up the two local files that change without the server saying so.
 *
 * Agent progress is written straight to status.json by `lib/dispatch.js` and
 * `bin/status.js` without going through the event bus, so a monitor that only
 * listened to `/api/poll` would sit still for up to a poll interval while an agent
 * was visibly working. Reading the file is both cheaper and fresher than adding an
 * event for it. Config is reloaded on the same principle, so `npm run configure`
 * shows up here without a restart.
 */
function refreshLocal() {
  const sm = mtimeOf(STATUS_PATH);
  if (sm !== statusMtime) {
    statusMtime = sm;
    try {
      state.status = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
    } catch {
      state.status = {};
    }
  }
  const cm = mtimeOf(CONFIG_PATH);
  if (cm !== configMtime) {
    configMtime = cm;
    try {
      cfg = loadConfig();
    } catch {
      /* keep the config we have; a half-written file fixes itself next tick */
    }
  }
}

/* --------------------------------------------------------------------- render */

function spaceRows(now) {
  const spaces = state.spaces || [];

  if (!spaces.length) {
    // No spaces configured: one honest summary line rather than a row per workspace.
    const names = state.workspaces.length ? state.workspaces : cfg.workspaces.map((w) => w.name);
    const open = state.questions.length;
    return [
      row(
        seg()
          .add(`${names.length} workspace${names.length === 1 ? '' : 's'}`, C.bold)
          .add('  ')
          .add(names.join(' '), C.dim),
        seg().add(open ? `${open} open` : 'clear', open ? null : C.dim)
      ),
    ];
  }

  const nameW = Math.max(...spaces.map((s) => dw(s.name)));
  return spaces.map((s) => {
    // Recomputed locally rather than trusted from the poll: quiet turns on and off
    // on a clock, and the response that carried it may be 25 seconds old.
    const local = (cfg.spaces || []).find((x) => x.name === s.name);
    const quiet = local ? isQuiet(local, now) : s.quiet;
    const muted = local ? Boolean(local.muted) : s.muted;

    const left = seg()
      .add(s.name.padEnd(nameW), quiet ? C.dim : C.bold)
      .add('  ')
      .add(s.count ? `${s.count} open` : 'clear', s.count ? null : C.dim);

    // "push on" used to be printed for every space that wasn't quiet, without ever
    // asking whether push was configured — so a setup with ntfy off (the default,
    // and what this Mac runs) claimed a bell that could never ring. Not quiet only
    // means beadcause *would* push; whether anything leaves the machine is ntfy.
    const pushable = Boolean(cfg.ntfy?.enabled && cfg.ntfy?.topic);

    const right = seg();
    if (muted) right.add('🔇 muted', C.yellow);
    else if (quiet) {
      const until = local ? quietUntil(local, now) : null;
      right.add(`🔇 quiet${until ? ` until ${clock(until, now)}` : ''}`, C.yellow);
    } else right.add(pushable ? '🔔 push on' : '⊘ no push', C.dim);
    if (local?.autoDispatch === false) right.add('  ').add('no agents', C.dim);

    return row(left, right);
  });
}

/**
 * One line per advocate: what its repo's queue looks like, and what it is doing
 * about it.
 *
 * Deliberately in the head, above the questions, because it answers a different
 * question from the rest of this screen — not "what needs Adam", but "is anything
 * being got on with". A paused or quiet advocate is dimmed rather than hidden: an
 * advocate you cannot see is indistinguishable from a repo with nothing to do,
 * which is the exact confusion this whole feature exists to end.
 */
function advocateRows(now) {
  const rows = state.advocates || [];
  if (!rows.length) return [];

  const nameW = Math.max(...rows.map((a) => dw(a.workspace)));
  return [
    rule('mid', seg().add('advocates', C.dim)),
    ...rows.map((a) => {
      const idle = a.paused || a.quiet;
      const left = seg().add(a.workspace.padEnd(nameW), idle ? C.dim : C.bold).add('  ');
      const ready = a.queue ? ` · ${a.queue} ready` : '';

      // `state` is the word the note is checked against below, so the two can't
      // both say "paused" and eat half the line saying it twice.
      let state = 'clear';
      if (a.paused) left.add((state = `⏸ paused${ready}`), C.yellow);
      else if (a.quiet) left.add((state = `🔇 quiet${ready} — watching`), C.yellow);
      else if (a.surveying) left.add((state = '🔍 surveying for work to propose'), C.magenta);
      else if (a.workers.length)
        left.add((state = `▶ ${a.workers.length}/${a.limit} session${a.workers.length === 1 ? '' : 's'}${ready}`), C.green);
      else if (a.queue) left.add((state = `${a.queue} ready`), C.yellow);
      else left.add(state, C.dim);

      const said = state.toLowerCase();
      if (a.error) left.add('  ').add(`⚠ ${a.error}`, C.red);
      else if (a.note && !said.includes(a.note.toLowerCase().split(/[ ·—]/)[0])) left.add('  ').add(a.note, C.dim);

      // The right-hand column is the beads themselves: which one, how long, and
      // whether the session ever claimed it. An unclaimed worker ten minutes in is
      // the row that tells you a window was opened and then closed on you.
      const right = seg();
      a.workers.slice(0, 3).forEach((w, i) => {
        if (i) right.add(' ');
        right.add(w.id, C.cyan).add(`·${ago(w.at, now) || 'now'}`, C.dim);
        if (!w.claimed) right.add('?', C.yellow);
      });
      if (!a.workers.length && a.queue) right.add(a.next?.[0]?.id || `${a.queue}`, C.dim);

      return row(left, right);
    }),
  ];
}

/** The lines a question gets: what it is, and what is happening about it. */
function questionGroup(q, now) {
  const activity = state.status[q.key] || q.activity || null;
  const lines = [
    row(
      seg()
        .add(q.key, C.cyan)
        .add('  ')
        .add(q.priority === null || q.priority === undefined ? '  ' : `P${q.priority}`, priorityColour(q.priority))
        .add('  ')
        .add(q.question || q.title || q.id),
      seg().add(ago(q.createdAt, now), C.dim)
    ),
  ];

  const sub = seg().add('   ');
  const subRight = seg();
  if (activity) {
    const meta = PHASES[activity.phase] || { icon: '•', label: activity.phase };
    sub.add(meta.icon ? `${meta.icon} ` : '').add(meta.label, activity.phase === 'blocked' ? C.red : C.magenta);
    if (activity.detail) sub.add(' · ').add(activity.detail, C.dim);
    if (activity.actor) sub.add('  ').add(activity.actor, C.dim);
    subRight.add(ago(activity.at, now), C.dim);
  } else if (q.awaitingAgent) {
    sub.add('⏳ ').add('waiting on an agent', C.yellow);
  } else if (q.commentCount) {
    sub.add(`${q.commentCount} comment${q.commentCount === 1 ? '' : 's'}`, C.dim);
  } else {
    return lines;
  }
  lines.push(row(sub, subRight));
  return lines;
}

function frame() {
  refreshLocal();
  W = Math.max(56, Math.min(process.stdout.columns || 100, 160));
  const height = Math.max(18, process.stdout.rows || 40);
  const now = new Date();

  const conn =
    state.conn === 'live'
      ? seg().add('● live', C.green)
      : state.conn === 'connecting'
        ? seg().add('◌ connecting', C.yellow)
        : seg().add(`✕ offline${state.connDetail ? ` · ${state.connDetail}` : ''}`, C.red);

  const head = [
    rule(
      'top',
      seg().add('Beadcause', C.bold),
      seg().add(BASE.replace(/^https?:\/\//, ''), C.dim).add('  ').add(conn.ansi())
    ),
    ...spaceRows(now),
    ...advocateRows(now),
  ];

  const groups = state.questions.map((q) => questionGroup(q, now));
  const events = state.events.map((e) => {
    const detail = eventDetail(e);
    return row(
      seg()
        .add(stamp(e.at), C.dim)
        .add('  ')
        .add(String(e.type).padEnd(9), EVENT_COLOUR[e.type] || null)
        .add(e.key || '', C.cyan)
        .add(detail ? '  ' : '')
        .add(detail, C.dim),
      null
    );
  });

  // Two rules and a bottom border sit between the panes; one row is left free so a
  // non-alt-screen terminal does not scroll the top off as it draws.
  const body = Math.max(6, height - head.length - 3 - 1);
  const eventPane = Math.min(Math.max(3, Math.round(body * 0.4)), Math.max(3, events.length));
  const questionPane = body - eventPane;

  const shown = [];
  const total = groups.reduce((n, g) => n + g.length, 0);
  if (!groups.length) {
    shown.push(row(seg().add('Nothing is waiting on you.', C.dim), null));
  } else if (total <= questionPane) {
    for (const g of groups) shown.push(...g);
  } else {
    let used = 0;
    let count = 0;
    for (const g of groups) {
      if (used + g.length > questionPane - 1) break;
      shown.push(...g);
      used += g.length;
      count += 1;
    }
    shown.push(row(seg().add(`… ${groups.length - count} more`, C.dim), null));
  }
  while (shown.length < questionPane) shown.push(row(seg(), null));

  const tail = events.slice(0, eventPane);
  while (tail.length < eventPane) tail.push(row(seg(), null));

  return [
    ...head,
    rule('mid', seg().add(`questions (${state.questions.length})`, C.dim)),
    ...shown.slice(0, questionPane),
    rule('mid', seg().add('events', C.dim)),
    ...tail,
    rule(
      'bottom',
      TTY && !ONCE ? seg().add('q quit · r refresh', C.dim) : null,
      seg().add(`seq ${state.since ?? 0} · ${stamp()}`, C.dim)
    ),
  ];
}

function draw() {
  if (LINE_MODE) return;
  const out = frame();
  if (ALT) process.stdout.write('\x1b[H' + out.map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  else process.stdout.write(out.join('\n') + '\n');
}

/** The piped-into-a-log fallback: one line per event, no screen to take over. */
function logEvent(e) {
  const detail = eventDetail(e);
  console.log(`${stamp(e.at)}  ${String(e.type).padEnd(9)} ${e.key || ''}${detail ? `  ${detail}` : ''}`);
}

/* ----------------------------------------------------------------------- poll */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = true;
let inflight = null;
let refreshing = false;

function apply(data) {
  if (typeof data.seq === 'number') state.since = data.seq;
  if (Array.isArray(data.workspaces)) state.workspaces = data.workspaces;
  // Absent on a poll that timed out with nothing to say — keep what we have.
  if (data.questions) state.questions = data.questions;
  if (data.spaces) state.spaces = data.spaces;
  // Sent on every poll, changed or not: an advocate moves without any question
  // moving — a session it opened finishes, a slot frees — and a pane that only
  // updated when the inbox did would sit on a stale picture for hours.
  if (data.advocates) state.advocates = data.advocates;

  const arrived = [];
  if (data.resync) arrived.push({ type: 'resync', at: new Date().toISOString(), key: '' });
  arrived.push(...(data.events || []));
  for (const e of arrived) {
    state.events.unshift(e);
    if (LINE_MODE) logEvent(e);
  }
  state.events = state.events.slice(0, 200);
}

async function poll() {
  let backoff = 1000;
  while (running) {
    const url = state.since === null ? `${BASE}/api/poll` : `${BASE}/api/poll?since=${state.since}&wait=25`;
    inflight = new AbortController();
    const guard = setTimeout(() => inflight?.abort(), 40000);
    try {
      const res = await fetch(url, {
        headers: { 'x-beadcause-token': cfg.token },
        signal: inflight.signal,
      });
      if (res.status === 401) {
        state.conn = 'offline';
        state.connDetail = 'token rejected — is this the same ~/.config/beadcause as the daemon?';
        draw();
        await sleep(10000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      apply(await res.json());
      state.conn = 'live';
      state.connDetail = '';
      backoff = 1000;
    } catch (err) {
      if (!running) break;
      // `r` aborts the parked request on purpose; that is not a connection problem.
      if (refreshing && err.name === 'AbortError') {
        refreshing = false;
        continue;
      }
      state.conn = 'offline';
      state.connDetail = err.name === 'AbortError' ? 'no answer' : err.cause?.code || err.message.split('\n')[0];
      if (LINE_MODE) console.error(`[monitor] ${state.connDetail}`);
      draw();
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15000);
      continue;
    } finally {
      clearTimeout(guard);
      inflight = null;
    }
    draw();
  }
}

/* ------------------------------------------------------------------- lifecycle */

let ticker = null;

function quit(code = 0) {
  running = false;
  if (ticker) clearInterval(ticker);
  inflight?.abort();
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* already gone */
    }
  }
  if (ALT) process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.exit(code);
}

if (ONCE) {
  // A single frame still needs data, so do one cold poll and print what came back.
  try {
    const res = await fetch(`${BASE}/api/poll`, { headers: { 'x-beadcause-token': cfg.token } });
    if (res.ok) {
      apply(await res.json());
      state.conn = 'live';
    } else {
      state.conn = 'offline';
      state.connDetail =
        res.status === 401
          ? 'token rejected — is this the same ~/.config/beadcause as the daemon?'
          : `HTTP ${res.status}`;
    }
  } catch (err) {
    state.conn = 'offline';
    state.connDetail = err.cause?.code || err.message.split('\n')[0];
  }
  draw();
  process.exit(0);
}

if (ALT) process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l');
if (LINE_MODE) console.log(`[monitor] watching ${BASE}`);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === 'q' || key === '\u0003') return quit(0);
    if (key === 'r') {
      // Cold poll: drop `since` so the server sends the whole picture back.
      refreshing = true;
      state.since = null;
      inflight?.abort();
    }
  });
}

process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));

if (!LINE_MODE) {
  process.stdout.on('resize', draw);
  // Ages and the quiet-until clock move without any event arriving.
  ticker = setInterval(draw, 1000);
  draw();
}

await poll();
