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

/** Every label a bead filed for this error carries, in the order they should be read. */
export function labelsFor(fp) {
  return [ERROR_LABEL, fp.atLabel, fp.msgLabel].filter(Boolean);
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
export function describe(report = {}, fp = fingerprint(report)) {
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
 * One report in, one of three outcomes out.
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

export async function intake(bd, workspace, report, { actor = null, from = '' } = {}) {
  const fp = fingerprint(report);
  const key = `${workspace?.name || '?'}::${fp.atLabel}::${fp.msgLabel}`;
  const after = inflight.get(key) || Promise.resolve();
  // `.then(f, f)` rather than `.then(f)`: a report whose predecessor *failed* must still
  // be filed. Otherwise one `bd` lock timeout silently swallows every later occurrence
  // of that error for as long as the daemon runs.
  const run = after.then(
    () => fileOne(bd, workspace, report, fp, { actor, from }),
    () => fileOne(bd, workspace, report, fp, { actor, from })
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

async function fileOne(bd, workspace, report, fp, { actor, from }) {
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
    return { action: 'commented', id: match.bead.id, fingerprint: fp, matchedOn: match.matchedOn };
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
    description: describe(report, fp),
    acceptance: 'The error stops being reported — no new occurrence comment on this bead after the fix is live.',
    labels: labelsFor(fp),
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
  return { action: regressionOf ? 'regressed' : 'created', id, fingerprint: fp, regressionOf };
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
