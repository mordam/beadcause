/**
 * Reported errors become tracker state — a P0 bead, or a comment on the one that
 * already covers it.
 *
 * Today an error in the *browser* is a red toast and nothing else: `public/app.js`,
 * `public/console.js`, `public/foundations.js` and `public/term.js` each have their own
 * local `toast(msg, bad)`, and nothing in there catches an uncaught exception at all. The
 * error is seen, shown, and lost. This is the other end of that — the daemon side of
 * bc-p38c, and the piece the browser reporter (bc-p38c.2) and the daemon's own crash
 * handler (lib/crash.js, bc-p38c.4) both go through.
 *
 * **Filing is the easy half; not filing the same thing forty times is the hard half.**
 * One broken selector on a page that re-renders on every poll is not forty bugs, and a
 * tracker that says it is has been made useless by the feature meant to help it. So
 * every report is fingerprinted, and the fingerprint is what decides between three
 * outcomes:
 *
 * - **no match** — a new P0 bead, titled from the message.
 * - **a match that is open** — a comment on it saying this happened again, with when,
 *   where and how many times. No second bead.
 * - **a match that is closed** — a *new* bead, with a `discovered-from` edge to the
 *   closed one. Deliberately not a reopen: a bug that comes back after being fixed is a
 *   regression, and a regression that silently reopens the old bead loses the fact that
 *   it was ever fixed, along with the commit that was supposed to have fixed it. The
 *   edge is what carries "we have been here before" to whoever picks it up.
 *
 * **And the comment has a throttle of its own**, because "one bead" was only half of it.
 * A page that re-renders and throws again reports several times a second, and the
 * serialisation below turns that into one bead and then a comment for every single
 * report, indefinitely — a bead nobody can read, at the cost of a `bd` write each on a
 * tracker only one process can write at a time. So the second occurrence comments and
 * opens a coalescing window; everything inside it is counted, not written, and the
 * window closes with one line saying how many there were. See `WINDOW_MS`.
 *
 * **Two fingerprints, in a deliberate order.** The primary key is the source
 * `file:line` the error came from, because that is the most specific thing a report
 * carries — two different bugs on the same line are vanishingly rarer than two
 * different lines with the same generic message ("Failed to fetch"). The backup is the
 * message text, and it exists for exactly one case: an unrelated edit above the throw
 * site moves the line, every subsequent report gets a new primary key, and without the
 * backup the same bug files a fresh P0 every time somebody adds an import. So a lookup
 * asks for *either* label, and a bead matched on the message alone **learns the new
 * `file:line`** — the next report hits the primary key directly and the bead
 * accumulates every line the bug has lived on.
 *
 * Both are hashes rather than the text itself, for two unglamorous reasons: a bd label
 * has no quoting story and a message can contain anything at all, and a stack frame
 * path is long enough to make `bd show` unreadable. The readable form is in the
 * description, where a person can see it; the labels are for lookup.
 *
 * Nothing here talks to HTTP, and nothing here knows what a request is: `POST
 * /api/error` in lib/server.js is a dozen lines that unpack a body and call `intake`.
 * That split is what lets lib/crash.js file the daemon's own uncaught errors through the
 * same path without a loopback request to itself — and it earns its keep: a crash cannot
 * be relied on to be able to make an HTTP call to a server it has just broken.
 */
import crypto from 'node:crypto';

import { beadToIssue, DISCOVERED_FROM } from './filing.js';
import {
  commitmentNote,
  escalated,
  INCIDENT_LABEL,
  incidentLabels,
  severityFromLabels,
  severityOf,
} from './incident.js';

/**
 * The class label. One `bd list --label app-error` is every error the app has ever
 * filed, which is the question you ask the morning after a bad deploy.
 */
export const ERROR_LABEL = 'app-error';

/** `file:line` — the primary key. */
export const AT_PREFIX = 'errat:';

/** The normalised message — the backup, for when the line has moved. */
export const MSG_PREFIX = 'errmsg:';

/**
 * An error is P0 by construction, and this is the one place that says so.
 *
 * `lib/filing.js` clamps an agent-filed bead to P2 or worse, because what an agent
 * *decided* was work may not outrank what Adam chose. A reported error is not a
 * decision — the program did not think this might be worth doing, it failed — so the
 * floor is lowered to 0 for this path alone, and the advocate then picks it up ahead of
 * everything else with no change of its own (lib/advocate.js sorts the queue
 * highest-priority-then-oldest).
 *
 * This path — together with `intake` passing `endorsed: true` — is the one that
 * deliberately skips two of the six places that decide whether something may run with
 * nobody watching; lib/authority.js is the map of all of them and says which two.
 */
export const ERROR_PRIORITY = 0;

/** How much of a message becomes the title before it is cut. */
const TITLE_LIMIT = 110;

/** Hash width. 12 hex is 48 bits — collision-free at any volume this will ever see. */
const HASH_LEN = 12;

const hash = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, HASH_LEN);

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * A stack frame's file, reduced to something two machines agree on.
 *
 * The same file arrives spelled four ways depending on who is reporting: the phone
 * sends `https://mac.tail1234.ts.net:4318/app.js?v=27`, a desktop tab sends
 * `http://127.0.0.1:4317/app.js`, the daemon sends
 * `file:///Users/adammorgan/…/lib/server.js`, and a service worker sends `/sw.js`. All
 * four are one file, and a fingerprint that disagrees files four beads for one bug.
 *
 * So the origin goes, the query string goes (`?v=27` is the cache-buster public/sw.js
 * adds, and it changes on every release), and what is left is a path. The daemon's own
 * absolute paths keep their last two segments — `lib/server.js` — because the checkout
 * root differs between the main checkout and each of the ~30 worktrees, and a bug is
 * not a different bug for having been noticed from a worktree.
 */
export function normalizeSource(source) {
  let s = oneLine(source);
  if (!s) return '';
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  s = s.replace(/^file:\/\//i, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length > 2) return parts.slice(-2).join('/');
  return parts.join('/');
}

/**
 * The message, reduced to what makes two occurrences the same bug.
 *
 * Timestamps, ids, ports and hex blobs are what differ between two occurrences of one
 * bug — `fetch /api/bead?id=bc-4f2 failed` and `fetch /api/bead?id=bc-9aa failed` are
 * the same broken fetch — so each is replaced with a placeholder rather than left to
 * split the fingerprint. The replacements are deliberately conservative: three digits
 * or more, hex runs of eight or more, and whole URLs. A two-digit number stays, because
 * `Cannot read properties of undefined (reading '0')` and `(reading '1')` are usually
 * the same bug but `exit 1` and `exit 2` are usually not, and the cheaper mistake is
 * the one that files a second bead you can close.
 *
 * The digit rule is deliberately **not** anchored on word boundaries. A compact
 * timestamp — `20260811T120000`, which is how a deploy run is stamped — has a letter in
 * the middle of it, so `\b\d{3,}\b` matches neither half and two occurrences a day
 * apart file two beads. Unanchored, both normalise to `<n>t<n>`.
 */
export function normalizeMessage(message) {
  return oneLine(message)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d{3,}/g, '<n>')
    .toLowerCase();
}

/**
 * The first frame of a stack, for a report that carried no explicit `source`.
 *
 * `window.onerror` hands the browser the file and line as arguments, so the common
 * browser path never needs this; an `unhandledrejection` and the daemon's own
 * `uncaughtException` carry only an Error, whose stack is the only thing that says
 * where. Both stack dialects are accepted — V8's `at fn (file:line:col)` and its bare
 * `at file:line:col`, and Safari/Firefox's `fn@file:line:col` — because the phone is
 * the reporter this exists for and Safari is what the phone runs.
 */
export function frameFromStack(stack) {
  for (const raw of String(stack || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^[A-Za-z]*Error\b/.test(line)) continue;
    const m =
      /\(?([a-z][a-z0-9+.-]*:\/\/[^\s()]+?|\/[^\s():]+?|[A-Za-z]:[^\s():]+?):(\d+):(\d+)\)?$/i.exec(line) ||
      /@([^\s@]+?):(\d+):(\d+)$/.exec(line);
    if (m) return { source: m[1], line: Number(m[2]), column: Number(m[3]) };
  }
  return null;
}

/**
 * One report → the two fingerprints and the readable form of each.
 *
 * `at` is empty when a report carries neither a source nor a parseable stack — a
 * `window.onerror` from a cross-origin script is the real case, where the browser
 * refuses to say more than "Script error." Then the message is the *only* key there is,
 * which is why the lookup asks for either label rather than requiring both.
 */
export function fingerprint(report = {}) {
  const frame = report.source ? null : frameFromStack(report.stack);
  const source = normalizeSource(report.source || frame?.source || '');
  const rawLine = report.source ? report.line : (report.line ?? frame?.line);
  const line = Number.isFinite(Number(rawLine)) && Number(rawLine) > 0 ? Number(rawLine) : null;
  const at = source ? (line ? `${source}:${line}` : source) : '';
  const message = normalizeMessage(report.message);
  return {
    at,
    message,
    atLabel: at ? `${AT_PREFIX}${hash(at)}` : '',
    msgLabel: message ? `${MSG_PREFIX}${hash(message)}` : '',
  };
}

/**
 * Every label a bead filed for this error carries, in the order they should be read.
 *
 * The severity is optional and absent means absent — a caller that has not classified
 * the report gets exactly the three labels this always returned. Where it *is* given, it
 * adds two: `incident`, which is the register (lib/incident.js), and the severity id,
 * which is what makes `bd list --label sev1` the question "what has taken the daemon
 * down" rather than a hand-read of every `app-error` ever filed.
 */
export function labelsFor(fp, sev = null) {
  return [ERROR_LABEL, fp.atLabel, fp.msgLabel, ...(sev ? incidentLabels(sev) : [])].filter(Boolean);
}

/**
 * A bead's title: the message, on one line, cut to something a card can hold.
 *
 * The message leads rather than the file, because the list of these is read as a list
 * of *symptoms* — you recognise "Failed to fetch /api/poll" long before you recognise
 * app.js:3315. The file goes on the end when there is room, since two identical
 * messages from two places are exactly the case where the title alone is useless.
 */
export function titleFor(report, fp) {
  const message = oneLine(report?.message) || 'an error with no message';
  const room = TITLE_LIMIT - (fp?.at ? fp.at.length + 4 : 0);
  const cut = message.length > room ? `${message.slice(0, Math.max(20, room - 1)).trimEnd()}…` : message;
  return fp?.at ? `${cut} — ${fp.at}` : cut;
}

/**
 * The bead body: everything the report carried, laid out for somebody who was not
 * there.
 *
 * The fingerprints are written out in readable form as well as being labels, because
 * the labels are hashes and a person looking at this bead three weeks later needs to
 * know *what it was matched on* to judge whether a later occurrence really is the same
 * bug. That is the whole of why this paragraph exists.
 */
export function describe(report = {}, fp = fingerprint(report), { severity: sev = null, config = null } = {}) {
  const lines = [];
  lines.push(oneLine(report.message) || '_(the report carried no message)_');
  lines.push('');
  const facts = [
    ['Where', fp.at || '_unknown — the report carried no source and no parseable stack_'],
    ['Page', oneLine(report.url) || '—'],
    ['Kind', oneLine(report.kind) || 'error'],
    ['First seen', oneLine(report.at) || new Date().toISOString()],
    ['User agent', oneLine(report.userAgent) || '—'],
  ];
  lines.push('| | |', '|---|---|');
  for (const [k, v] of facts) lines.push(`| **${k}** | ${v} |`);
  if (report.stack) {
    lines.push('', '```', String(report.stack).split('\n').slice(0, 24).join('\n'), '```');
  }
  // The commitment, stated on the bead at the moment it is filed rather than only in a
  // config file. It has to have been knowable at the time for the measurement to mean
  // anything — see `commitmentNote` in lib/incident.js.
  if (sev) lines.push('', commitmentNote(sev, config));
  lines.push(
    '',
    `_Fingerprints: \`${fp.at || '(none)'}\` by source, \`${fp.message || '(none)'}\` by message. A later ` +
      'report matching either comments here instead of filing a second bead — see lib/errors.js._'
  );
  return lines.join('\n');
}

/** What goes on the bead the second and every subsequent time this error happens. */
export function occurrenceNote(report = {}, { count = null, matchedOn = 'source' } = {}) {
  const when = oneLine(report.at) || new Date().toISOString();
  const where = oneLine(report.url) || 'an unknown page';
  const nth = count ? `Occurrence ${count}` : 'It happened again';
  const fp = fingerprint(report);
  const at = fp.at ? ` from \`${fp.at}\`` : '';
  const drift =
    matchedOn === 'message'
      ? ' Matched on the **message**, not the source — the line has moved since this bead was filed, and ' +
        'the new one has been added to it so the next report matches directly.'
      : '';
  return `**${nth}** — ${when}, on ${where}${at}.${drift}`;
}

/**
 * Which of the beads carrying one of our labels this report belongs to.
 *
 * Preference order, and each step is doing work: a live bead beats a closed one (a
 * regression against a closed bead is a *new* bead, so a live match must win before we
 * ever consider the closed one); a source match beats a message match (the primary key
 * is more specific); and the newest wins among equals, because a bug filed twice before
 * this dedupe existed should collect its occurrences on the one somebody is actually
 * looking at.
 */
export function pickMatch(rows, fp) {
  const has = (row, label) => label && (row.labels || []).includes(label);
  const live = (row) => row && row.status !== 'closed';
  const rank = (row) => (live(row) ? 0 : 2) + (has(row, fp.atLabel) ? 0 : 1);
  const best = (rows || [])
    .filter((r) => r && (has(r, fp.atLabel) || has(r, fp.msgLabel)))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')) ||
        String(b.id).localeCompare(String(a.id), 'en', { numeric: true })
    )[0];
  if (!best) return null;
  return { bead: best, closed: !live(best), matchedOn: has(best, fp.atLabel) ? 'source' : 'message' };
}

/**
 * Every bead in this workspace carrying either fingerprint, closed ones included.
 *
 * `--all` is what puts the closed ones in, and they are load-bearing: without them a
 * regression is indistinguishable from a bug nobody has ever seen, and the edge back to
 * the fix that did not hold is the most useful thing on the new bead. `--label-any` is
 * an OR, so this is one `bd` call for both keys rather than two — which matters because
 * this runs on every reported error, and a page in a render loop reports fast.
 */
export async function findByFingerprint(bd, workspace, fp) {
  const labels = [fp.atLabel, fp.msgLabel].filter(Boolean);
  if (!labels.length) return [];
  const args = ['list', '--all', '--label-any', labels.join(','), '--limit', '0'];
  return (await bd.json(workspace, args, { retries: 2 })) || [];
}

/**
 * **How long one fingerprint's occurrences are folded into a single comment.**
 *
 * The dedupe above stops a render loop filing forty beads. It does nothing about the
 * forty *comments*, and for the case it was built for that is the same failure wearing
 * another hat: a view whose render throws re-renders and throws again, so one bead
 * collects a comment several times a second, indefinitely. Two things go wrong at once
 * — the bead becomes unreadable behind thousands of near-identical lines, and every one
 * of those lines is a `bd` write against an embedded single-writer Dolt that ~8 worker
 * sessions are also writing to. The second is the one that hurts somebody who is not
 * looking at this bead at all.
 *
 * So the first repeat is commented immediately — that is the useful one, the moment an
 * error stops being a one-off — and it opens a window. Everything inside the window is
 * *counted* and nothing is written: no comment, and no lookup either, because the count
 * happens before `bd list` is reached and the read takes the same lock the write does.
 * When the window closes, one comment says how many there were and between when.
 *
 * **The window doubles each time it closes non-empty**, up to `WINDOW_MAX_MS`. A burst
 * that lasts ten seconds costs one extra comment; a page that has been looping since
 * yesterday costs about a dozen, because by then the window is an hour wide. A fixed
 * minute would have been 1,440 comments a day, which is a bead nobody can read by a
 * slower route. A window that closes with nothing in it is dropped, so an error that
 * happens twice a week is never delayed by an hour: it always gets its own comment.
 */
export const WINDOW_MS = 60_000;

/** The ceiling the backoff climbs to. Beyond an hour, "it is still happening" is stale. */
export const WINDOW_MAX_MS = 60 * 60_000;

/**
 * Which outcomes are a bead that did not exist a moment ago.
 *
 * Both callers — `POST /api/error` in lib/server.js and the daemon's own handler in
 * lib/crash.js — push a `created` event onto the bus for a new bead and deliberately
 * stay silent for a comment, because a comment on a bead already on somebody's screen
 * moves nothing on the inbox and a page in a render loop would otherwise wake every
 * parked poller. Both used to spell that `action !== 'commented'`, which quietly became
 * wrong the moment a third non-bead outcome existed. It is one predicate now.
 */
export const isNewBead = (action) => action === 'created' || action === 'regressed';

/**
 * The one comment a whole window becomes.
 *
 * It carries the count and the span rather than a list, because the list is what made
 * the bead unreadable. The count is exact: every report inside the window was seen and
 * added, and nothing was sampled or dropped.
 */
export function coalescedNote({ count = 0, first = '', last = '', url = '', at = '', ms = WINDOW_MS } = {}) {
  const where = oneLine(url) || 'an unknown page';
  const from = at ? ` from \`${at}\`` : '';
  const when =
    first && last && first !== last ? `between ${first} and ${last}` : `at ${first || last || 'an unknown time'}`;
  const width = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`;
  return (
    `**${count} more occurrence${count === 1 ? '' : 's'}** — ${when}, on ${where}${from}. ` +
    'Folded into this one line rather than a comment each: one comment per report is one `bd` write per ' +
    'report on a single-writer tracker, and a bead you cannot read. ' +
    `While it keeps happening, at most one more of these every ${width} — widening as it goes. See lib/errors.js.`
  );
}

/** The open window per fingerprint, if there is one. Per process, like `inflight`. */
const windows = new Map();

const windowKey = (workspace, fp) => `${workspace?.name || '?'}::${fp.atLabel}::${fp.msgLabel}`;

function armWindow(key, w) {
  w.timer = setTimeout(() => {
    void closeWindow(key);
  }, w.ms);
  // Unrefed: a window is a nicety on a comment, and a daemon that cannot exit because
  // one is pending is a worse bug than a summary line nobody got.
  w.timer.unref?.();
}

function openWindow(key, { bd, workspace, actor, id, at, ms }) {
  const w = { bd, workspace, actor, id, at, ms, count: 0, first: '', last: '', url: '', timer: null };
  windows.set(key, w);
  armWindow(key, w);
  return w;
}

/**
 * The window is up: write the summary, if there is anything to summarise.
 *
 * The replacement window is armed **before** the comment is awaited, not after. A `bd`
 * write takes seconds under lock, and a report arriving during those seconds must be
 * counted into the next window rather than finding no window at all and commenting —
 * which is exactly the storm this exists to stop, let in through the moment of closing.
 */
async function closeWindow(key, { reopen = true } = {}) {
  const w = windows.get(key);
  if (!w) return null;
  clearTimeout(w.timer);
  if (!w.count) {
    windows.delete(key);
    return null;
  }
  if (reopen) openWindow(key, { ...w, ms: Math.min(w.ms * 2, WINDOW_MAX_MS) });
  else windows.delete(key);
  try {
    await w.bd.comment(w.workspace, w.id, coalescedNote(w), { actor: w.actor });
  } catch (err) {
    // Swallowed on purpose. This runs from a timer with nobody to return to, so a throw
    // here is an `unhandledRejection` on the daemon — which lib/crash.js would file as a
    // crash, about the error filer, from inside the error filer.
    console.error(`[beadcause] could not write the occurrence summary on ${w.id}: ${err.message}`);
  }
  return w;
}

/**
 * Close every open window now, writing whatever each has counted.
 *
 * Nothing in the daemon calls this: shutdown gets two seconds for everything it owes
 * (bin/beadcause.js) and a `bd` write does not reliably fit in them, so a restart loses
 * a summary line and the next report opens a fresh window — which is the cheap half of
 * the trade. It exists as the seam a test drives instead of sleeping through a real
 * window, and as the place to hang a graceful flush if one is ever wanted.
 */
export async function flushErrorWindows() {
  const out = [];
  for (const key of [...windows.keys()]) {
    const closed = await closeWindow(key, { reopen: false });
    if (closed) out.push({ id: closed.id, count: closed.count });
  }
  return out;
}

/**
 * One report in, one of four outcomes out — the fourth being nothing at all, on purpose.
 *
 * **Coalesced** is that fourth: a window is already open on this fingerprint, so the
 * report is added to a count and no `bd` call is made, in either direction. It is
 * checked inside `fileOne` rather than out here, so it is asked *after* the chain has
 * given us our turn: three reports that arrive together must not each decide there is no
 * window, when the first of them is about to open one.
 *
 * **Serialised per fingerprint, and that is not decoration.** The case this exists for
 * is a page whose render throws: `window.onerror` fires, the reporter posts, the render
 * runs again, and three requests are in flight before the first `bd create` returns.
 * Without the chain all three miss each other's bead and file three P0s for one bug —
 * the exact failure this whole module exists to prevent, arriving through the door it
 * was built to guard. bd's own single-writer retry does not help: those three creates
 * do not conflict, they succeed.
 *
 * The chain is per-process and per-fingerprint, so two different errors still file
 * concurrently and a second daemon is not slowed by the first. Two daemons on one
 * workspace could still race, but there is only ever one (lib/service.js), and a
 * duplicate bead is a bead you close rather than an error you lose.
 */
const inflight = new Map();

export async function intake(bd, workspace, report, { actor = null, from = '', windowMs = WINDOW_MS, config = null } = {}) {
  const fp = fingerprint(report);
  const key = windowKey(workspace, fp);
  const after = inflight.get(key) || Promise.resolve();
  // `.then(f, f)` rather than `.then(f)`: a report whose predecessor *failed* must still
  // be filed. Otherwise one `bd` lock timeout silently swallows every later occurrence
  // of that error for as long as the daemon runs.
  const run = after.then(
    () => fileOne(bd, workspace, report, fp, { actor, from, windowMs, config }),
    () => fileOne(bd, workspace, report, fp, { actor, from, windowMs, config })
  );
  // The tail the next report queues behind. Never a rejected promise: an unhandled
  // rejection sitting in a Map is an `unhandledRejection` on the daemon, which lib/crash.js
  // would take as a crash and try to file — a bead about the bead-filer. Its own
  // `fromFilingPath` guard would catch that one, but not being the thing that needs
  // catching is cheaper than being caught.
  const tail = run.then(
    () => {},
    () => {}
  );
  inflight.set(key, tail);
  // Dropped once nothing is behind it, so the map does not grow one entry per distinct
  // error for the life of the process.
  tail.then(() => {
    if (inflight.get(key) === tail) inflight.delete(key);
  });
  return run;
}

async function fileOne(bd, workspace, report, fp, { actor, from, windowMs, config = null }) {
  const key = windowKey(workspace, fp);
  // How bad this is, decided from the report itself and before anything is written. See
  // `severityOf` in lib/incident.js — it reads the `kind` the reporter gave, which is the
  // only thing either reporter knows about impact.
  const sev = severityOf(report);

  /* ------------------------------------- a window is open on it: count it and stop */
  // Before the lookup, not after it. A read takes the same single-writer lock a write
  // does, so a page reporting ten times a second costs `bd` nothing at all in here.
  const open = windows.get(key);
  if (open) {
    const when = oneLine(report.at) || new Date().toISOString();
    open.count += 1;
    open.first ||= when;
    open.last = when;
    open.url = oneLine(report.url) || open.url;
    return { action: 'coalesced', id: open.id, count: open.count, windowMs: open.ms, fingerprint: fp };
  }

  const rows = await findByFingerprint(bd, workspace, fp);
  const match = pickMatch(rows, fp);

  /* ---------------------------------------------- it is already open: comment on it */
  if (match && !match.closed) {
    const count = occurrenceCount(match.bead);
    await bd.comment(workspace, match.bead.id, occurrenceNote(report, { count, matchedOn: match.matchedOn }), {
      actor,
    });
    // The line moved and we matched on the message: teach the bead its new address, so
    // the next report hits the primary key instead of coming back through the backup.
    if (match.matchedOn === 'message' && fp.atLabel && !(match.bead.labels || []).includes(fp.atLabel)) {
      try {
        await bd.addLabel(workspace, match.bead.id, fp.atLabel);
      } catch {
        /* the comment landed, which is the part that matters */
      }
    }
    // The same bug forty times is worse than the same bug once, and the bead's severity
    // has to move with that or a real outage sits at sev3 for a week. Only written when
    // the label would actually change — this is the hot path, and an escalation that
    // rewrote the same two labels on every repeat would be a `bd` write per occurrence on
    // a single-writer tracker, which is the exact cost the coalescing window exists to
    // avoid. See `escalated` in lib/incident.js for why it cannot reach sev1.
    // The worse of the two before the count is even consulted. The same fingerprint can
    // arrive from a `toast` on Monday and an `uncaughtException` on Tuesday — one bug,
    // two reporters, and the second one is the one that says what it costs. Severity only
    // ever moves up: a bead does not become less serious because the next report of it
    // came from somewhere quieter.
    const now = severityFromLabels(match.bead.labels);
    const worst = now && now.rank <= sev.rank ? now : sev;
    const up = escalated(worst, { occurrences: count || 0, escalateAt: config?.incidents?.escalateAt });
    if (up.id !== (now?.id || '')) {
      try {
        await bd.addLabel(workspace, match.bead.id, up.id);
        if (now) await bd.removeLabel(workspace, match.bead.id, now.id);
        if (!(match.bead.labels || []).includes(INCIDENT_LABEL)) {
          await bd.addLabel(workspace, match.bead.id, INCIDENT_LABEL);
        }
      } catch {
        /* the comment landed, which is the part that matters */
      }
    }
    // And the window opens here, on the FIRST repeat rather than on the bead. The bead
    // itself is news and its second occurrence is the news that it is not a one-off;
    // everything after that is volume, and volume is what gets counted.
    openWindow(key, { bd, workspace, actor, id: match.bead.id, at: fp.at, ms: windowMs });
    return { action: 'commented', id: match.bead.id, fingerprint: fp, matchedOn: match.matchedOn, severity: up.id };
  }

  /* ------------------------------------- it was fixed and it is back: a linked bead */
  const regressionOf = match?.closed ? match.bead.id : '';
  const deps = [];
  if (regressionOf) deps.push(`${DISCOVERED_FROM}:${regressionOf}`);
  else if (from) deps.push(`${DISCOVERED_FROM}:${from}`);

  const bead = {
    title: titleFor(report, fp),
    type: 'bug',
    priority: ERROR_PRIORITY,
    description: describe(report, fp, { severity: sev, config }),
    acceptance: 'The error stops being reported — no new occurrence comment on this bead after the fix is live.',
    labels: labelsFor(fp, sev),
    deps,
    rationale: regressionOf
      ? `Reported by the app itself. It matched ${regressionOf}, which is **closed** — so this is a regression, ` +
        'filed as its own bead rather than reopening that one, and linked to it.'
      : 'Reported by the app itself, the moment it happened.',
  };

  const issue = beadToIssue(bead, {
    floor: ERROR_PRIORITY,
    endorsed: true,
    endorsedNote:
      'It arrived **endorsed**, unlike everything else an agent files: this is not an agent’s judgement that ' +
      'something might be worth doing, it is a program that failed. Nothing would be gained by holding a P0 ' +
      'crash behind a tap, and the whole point is that the advocate picks it up before you have read it.',
  });
  const id = await bd.create(workspace, issue, { actor });
  if (!id) throw new Error('bd created the bead but returned no id');
  return { action: regressionOf ? 'regressed' : 'created', id, fingerprint: fp, regressionOf, severity: sev.id };
}

/**
 * Which occurrence this is, from what the row already knows.
 *
 * Deliberately not a `bd comments` call: this runs on the hot path of a page that may
 * be reporting several times a second, and the count is a nicety on a comment while the
 * read is not free. bd carries a comment count on the row where it has one; where it
 * does not, the note simply says "it happened again" and says nothing false.
 */
function occurrenceCount(row) {
  const n = Number(row?.comment_count ?? row?.comments_count ?? row?.commentCount);
  return Number.isFinite(n) && n > 0 ? n + 1 : null;
}
