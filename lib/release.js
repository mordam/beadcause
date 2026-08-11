import fs from 'node:fs';
import path from 'node:path';

import { resolveAutoShip } from './autoship.js';
import { writeJsonAtomic } from './atomic.js';
import { CONFIG_DIR } from './config.js';
import { UNENDORSED } from './endorse.js';

/**
 * The release queue: what has merged and is not running yet.
 *
 * lib/pr.js merges. lib/deploy.js deploys. lib/prboard.js says, per pull request,
 * whether each of those has happened. What none of them had was the thing in between —
 * **the set of merges waiting on one deploy** — and that set is the whole of what a
 * release is on this Mac. Six sessions a day merge through GitHub; each merge lands on
 * `origin/main` and stops there; a single `launchctl kickstart` makes all of them live
 * at once. Until this file, the only record that four merges were sitting unshipped was
 * four notifications that had scrolled past.
 *
 * Two things come out of that set and they are the two halves of bc-5r0v:
 *
 * 1. **A number**, which is what the Ship button wears. Four merges and one deploy is
 *    not four ships — it is one, and the number says how much of the day's work it
 *    would make live. See `releaseFor`.
 * 2. **A bead per merge**, filed when the merge is seen and closed when it ships. The
 *    notification a delivery sends says "still owed: deploy" and is gone by morning; a
 *    bead is still there, in the tracker Adam already reads, and it settles itself.
 *
 * ## What counts as shipped, and why it is never a guess
 *
 * Three states, as everywhere on this board: shipped, not shipped, and *we cannot say*
 * — and the third one never files a bead and never closes one. A merge is shipped when
 * one of two things is true, and they are evidence of different strengths:
 *
 * - **It is in the build that is running.** Only beadcause can know this about itself
 *   (`deployTracked` in lib/prboard.js), and where it is knowable it is the strongest
 *   answer there is: not "a deploy ran" but "the process serving you has this commit".
 * - **A deploy that exited 0 pulled after the merge landed.** For every other repo the
 *   running build is invisible, so the deploy journal is the evidence. The test is a
 *   clock and it is deliberately the conservative end of one: `startedAt` is *before*
 *   the runner's fast-forward, so a merge GitHub timestamped earlier than that is
 *   certainly in what the pull brought down. A merge a second later may also be in it,
 *   and is not counted — under-claiming leaves a bead open one deploy too long, and
 *   over-claiming closes a bead over work that never shipped.
 *
 * `unconfirmed` and `lost` settle nothing, ever. They are the two words lib/deploy.js
 * has for "nobody knows", and a queue that drained on them would be inventing the one
 * fact it exists to report.
 *
 * ## Why a merge has to be *pushed* before it joins the queue
 *
 * A deploy fast-forwards its checkout to `origin/<base>`. A merge GitHub has performed
 * but that this Mac has not yet seen on `origin/main` cannot be shipped by pressing the
 * button, because the pull would not bring it down — so it is not in the queue, and the
 * board's own note ("this Mac may not have fetched") is already the right sentence for
 * it. The queue is what a deploy *would actually make live*, not everything that merged.
 *
 * ## Why the ledger exists at all
 *
 * Almost everything here is derived from the board and the deploy journal, and derived
 * state needs no file. One thing is not derivable: **when beadcause started watching.**
 * The board carries three weeks of merged pull requests, and a daemon meeting a repo for
 * the first time — a new install, a new workspace, this feature's own first run — would
 * otherwise file a dozen beads for work that shipped a fortnight ago. So the first sight
 * of a workspace records a watermark and files nothing, and only merges after it are the
 * queue's business. The rest of the ledger is bookkeeping around that: which bead was
 * filed for which pull request, so a bead closed by hand is not filed again.
 *
 * An unreadable ledger therefore **stops the sweep filing** rather than defaulting to an
 * empty one. An empty ledger means "never seen any of these repos", which on a Mac with
 * three weeks of history is the one reading that produces a flood.
 *
 * ## Shipping it without being asked
 *
 * Everything above ends at a bead that waits for a tap. Where auto-ship is on for a merge
 * — lib/autoship.js decides that, space by space and epic by epic — this sweep runs the
 * repo's declared deploy itself, and the bead then closes on exactly the evidence it
 * always did. Four things make that safe enough to leave running unattended:
 *
 * 1. **A settle window, not a trigger.** The first eligible merge arms a timer on the
 *    workspace and nothing happens; merges arriving while it runs join the same batch and
 *    do not restart it. A deploy of this repo restarts beadcause itself, so four merges in
 *    ten minutes have to be one deploy — which is what pressing Ship does today.
 * 2. **One attempt per merge, ever.** Firing stamps `autoShipAt` on every merge in the
 *    batch *before* the deploy starts, so a deploy that fails leaves its beads open, the
 *    Ship button armed, and nothing arming again. There is no retry loop here, by
 *    construction: only a merge nobody has tried yet can arm the window.
 * 3. **The ledger is written before the deploy is spawned**, and the sweep gives up on a
 *    workspace whose ledger will not write. A beadcause deploy SIGKILLs the process that
 *    asked for it, and the one state that must survive that is "I already tried these".
 * 4. **A repo with no declared deploy is untouched.** beadcause cannot ship it, so it
 *    still files the bead and waits for a session, exactly as before.
 */

/** The label a ship bead carries. One string, one place. */
export const SHIP_LABEL = 'ship';

/** Where the watermark and the filed-bead record live. */
export const LEDGER_PATH = path.join(CONFIG_DIR, 'releases.json');

/** How long a settled entry is kept before it is pruned. Long enough to be history. */
const KEEP_DAYS = 45;

/**
 * How long an armed workspace waits before its auto-ship fires.
 *
 * Ten minutes, because it is the coalescing that matters rather than the promptness: the
 * merges this batches are ones that would otherwise sit unshipped until somebody noticed
 * them, so ten minutes late is not late, and each one saved is a restart of the daemon
 * you may be reading this on. Deliberately *not* called a quiet window — `quietHours` and
 * `isQuiet` in lib/spaces.js already mean notification silence and this is not that.
 *
 * The sweep's own clock is coarser than this (`release.seconds`, five minutes), so the
 * real wait is this rounded up to the next sweep. That is fine and it is why the window
 * lives in the ledger as a timestamp rather than in a `setTimeout`: a timer would not
 * survive the deploy it is waiting to start.
 */
const SETTLE_SECONDS = 600;

const settleMs = (cfg) => Math.max(0, Number(cfg?.release?.settleSeconds ?? SETTLE_SECONDS)) * 1000;

/* ------------------------------------------------------------------ the marker */

/**
 * The line in a ship bead's description that ties it back to its pull request.
 *
 * A parseable marker rather than a title convention, for the reason lib/prboard.js
 * gives about reading beads out of pull requests and then applies in the other
 * direction: a title is prose and prose gets edited. This line is the one thing on the
 * bead that must survive somebody rewording it, and it is what makes filing idempotent
 * without trusting the ledger — see `openShipBeads`.
 */
export const shipMarker = (repo, number) => `ship: ${repo}#${number}`;

const MARKER_RE = /^[ \t]*ship:[ \t]*(\S+?)#(\d+)[ \t]*$/m;

/** `{repo, number}` from anything carrying a marker line, or null. */
export function markerOf(text) {
  const m = MARKER_RE.exec(String(text || ''));
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/* ------------------------------------------------------------------ the ledger */

/**
 * The ledger, or `null` when there is a file here that cannot be read.
 *
 * The two absences are different and only one of them is safe. **No file** is a first
 * run: an empty ledger is exactly right, every workspace gets a watermark, and nothing
 * is filed. **A file that will not parse** is a ledger whose watermarks are unknown, and
 * treating that as a first run would re-watermark today and lose the record of every
 * bead already filed — which is how the same merge gets two beads. So it returns null,
 * and the sweep does nothing but say so.
 */
export function loadLedger() {
  let raw;
  try {
    raw = fs.readFileSync(LEDGER_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    return null;
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveLedger(ledger) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeJsonAtomic(LEDGER_PATH, ledger);
}

/** One workspace's entry, created empty rather than absent so callers need no guard. */
const entryFor = (ledger, name) => {
  if (!ledger[name] || typeof ledger[name] !== 'object') ledger[name] = { since: null, handled: {} };
  if (!ledger[name].handled || typeof ledger[name].handled !== 'object') ledger[name].handled = {};
  return ledger[name];
};

/** Drop entries that settled long enough ago that nobody is going to ask about them. */
function prune(entry, now) {
  const cutoff = now - KEEP_DAYS * 86400000;
  for (const [number, rec] of Object.entries(entry.handled)) {
    if (!rec?.shippedAt) continue;
    if (Date.parse(rec.shippedAt) < cutoff) delete entry.handled[number];
  }
}

/* -------------------------------------------------------------------- the queue */

/**
 * Has this merge been made live?
 *
 * `deploys` is this workspace's records, newest first — the caller reads the journal
 * once for the whole sweep rather than once per row.
 *
 * Returns true, false, or `null` for the state that must never be either: the merge
 * commit has not reached `origin/<base>` as this Mac has seen it, so no deploy could
 * have picked it up and nothing here can say whether one will. A null neither files a
 * bead nor closes one.
 */
export function shippedState(row, deploys = []) {
  if (!row?.merged) return null;
  // The strongest answer there is, and only beadcause can give it about itself.
  if (row.deployed === true) return true;
  if (row.pushed !== true) return null;

  const merged = Date.parse(row.mergedAt || '');
  if (!Number.isFinite(merged)) return null;

  // `ok` only. `unconfirmed` is the ordinary ending of a deploy that restarts the
  // daemon asking for it, and it means the command ran with nobody left to say what
  // happened — for beadcause that gap is closed by `row.deployed` above, once the new
  // process is up, and for anything else it stays open, which is the truth.
  const shipped = deploys.some(
    (d) => d.status === 'ok' && Number.isFinite(Date.parse(d.startedAt || '')) && Date.parse(d.startedAt) > merged
  );
  return shipped ? true : false;
}

/**
 * What one deploy of this repo would make live, newest merge first.
 *
 * Derived entirely from the board and the journal — no git, no network. The rows are
 * the board's own, so everything a caller needs to draw one (the title, the URL, the
 * merge commit) is already on them.
 */
export function owedFor(card, deploys = []) {
  return (card?.prs || [])
    .filter((p) => p.merged && shippedState(p, deploys) === false)
    .sort((a, b) => String(b.mergedAt || '').localeCompare(String(a.mergedAt || '')));
}

/**
 * The release strip for one repo card: the number on the button and what it covers.
 *
 * `can` is what pressing it would do, in the vocabulary `POST /api/pr/ship` already
 * uses: `deploy` where the repo has declared one, `session` where it has not and the
 * fallback is a window on the Mac. A repo whose queue is empty gets `count: 0` and the
 * front end draws no strip at all — an empty queue is the ordinary state and it should
 * look like it.
 */
export function releaseFor(card, deploys = [], ledger = {}) {
  const owed = owedFor(card, deploys);
  const handled = ledger?.[card?.workspace]?.handled || {};
  return {
    count: owed.length,
    can: card?.deployDeclared ? 'deploy' : 'session',
    hint: card?.deployHint || '',
    prs: owed.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      mergedAt: p.mergedAt || null,
      sha: p.mergeCommit ? String(p.mergeCommit).slice(0, 7) : '',
      // The ship bead, when one was filed. Null is ordinary: a merge that predates the
      // watermark, or a repo where filing is off.
      bead: handled[String(p.number)]?.bead || null,
    })),
  };
}

/**
 * Put the queue on every card, and the total on the board.
 *
 * A copy rather than a mutation: `collectBoard` caches the object it returns and hands
 * the same one to every request for the next 25 seconds, so writing into it would make
 * the queue as stale as the sweep it rode in on — and the deploy journal underneath it
 * changes every few seconds while something is shipping.
 */
export function decorateBoard(board, ledger = {}, deploys = []) {
  if (!board?.repos) return board;
  const repos = board.repos.map((card) => ({
    ...card,
    release: releaseFor(card, byWorkspace(deploys).get(card.workspace) || [], ledger),
  }));
  return {
    ...board,
    repos,
    counts: { ...(board.counts || {}), ship: repos.reduce((n, c) => n + c.release.count, 0) },
  };
}

/** Deploy records grouped by the repo they belong to, order preserved (newest first). */
function byWorkspace(deploys) {
  const map = new Map();
  for (const d of deploys || []) {
    if (!map.has(d.workspace)) map.set(d.workspace, []);
    map.get(d.workspace).push(d);
  }
  return map;
}

/** The `reason` a queue-started deploy carries, so its record says what it was for. */
export function shipReason(queue) {
  const numbers = (queue?.prs || []).map((p) => `#${p.number}`);
  if (!numbers.length) return 'Shipped from the release queue';
  const named = numbers.slice(0, 6).join(', ');
  const rest = numbers.length > 6 ? ` and ${numbers.length - 6} more` : '';
  return `Shipped the release queue — ${named}${rest}`;
}

/* -------------------------------------------------------------------- the beads */

/** A ship bead's title. The number leads, because that is what it is *about*. */
export const shipTitle = (row) => `Ship #${row.number}: ${String(row.title || '').trim() || 'merged work'}`;

function shipBody(card, row, owner, auto = false) {
  const sha = row.mergeCommit ? ` as \`${String(row.mergeCommit).slice(0, 7)}\`` : '';
  return [
    shipMarker(card.repo, row.number),
    '',
    `[#${row.number}](${row.url}) merged into \`${row.base}\`${sha}${row.author ? ` — ${row.author}` : ''}.`,
    '',
    card.deployDeclared
      ? `It is on \`origin/${row.base}\` and it is not live. One deploy of ${card.workspace} ships it${
          card.deployHint ? ` — ${card.deployHint}` : ''
        }, along with everything else merged since the last one.`
      : `It is on \`origin/${row.base}\` and it is not live. ${card.workspace} declares no deploy beadcause can run, so shipping it is a session on the Mac.`,
    '',
    // The last line is the one that changes when auto-ship is on, and it has to: the
    // sentence "shipping is your tap" is what this bead promised, and a bead promising a
    // tap over work that is about to deploy itself is the worst kind of wrong — it reads
    // like something is waiting for you when nothing is.
    auto
      ? `**This ships itself.** Auto-ship is on for it, so the release queue runs ${card.workspace}'s ` +
        `declared deploy within the settle window and this closes when the merge is live. **Ship** on the ` +
        `pull request board does the same thing now, and nothing will open a session on it either way.`
      : `Press **Ship** on the pull request board and this closes itself. Nothing else has to happen to it, and ` +
        `nothing will open a session on it — shipping is ${owner}'s tap, not an agent's.`,
  ].join('\n');
}

/**
 * The ship beads a workspace has open, by pull request number.
 *
 * Read from the tracker rather than from the ledger, and that is the point: this is
 * what makes filing idempotent whatever state the ledger is in. A bead closed by hand
 * is simply not here, which is how "Adam decided that one did not need tracking" reads
 * differently from "it was never filed" — the ledger tells those two apart, this call
 * says what is live.
 */
async function openShipBeads(bd, ws, repo) {
  let rows;
  try {
    rows = await bd.listLabel(ws, SHIP_LABEL);
  } catch {
    // A workspace mid-write has no answer this tick. Null rather than an empty map:
    // "no ship beads" and "could not ask" must not file the same beads twice.
    return null;
  }
  const found = new Map();
  for (const row of rows || []) {
    const mark = markerOf([row.description, row.design, row.notes].filter(Boolean).join('\n'));
    if (mark && mark.repo === repo) found.set(mark.number, row);
  }
  return found;
}

/**
 * The settle window for one workspace: arm it, hold it, or fire it.
 *
 * `ready` is the merges that may auto-ship and have not been tried — everything about
 * *whether* is already decided by the time this is called, and all that is left is
 * *when*. Returns whether the ledger in memory changed.
 *
 * Four states, and the ordering between them is the behaviour:
 *
 * - **Nothing ready** disarms. The window is not a countdown that survives its reason:
 *   the merges it was armed for may have shipped on somebody's tap in the meantime, and
 *   an armed workspace with nothing owed would fire a deploy of nothing at all.
 * - **Ready and unarmed** starts the clock and does nothing else. This is the merge that
 *   *would* have deployed on sight, and not doing so is the whole point.
 * - **Ready and armed, inside the window** does nothing, and specifically does not touch
 *   `armedAt`. A merge arriving now joins the batch — it is in `ready` and it will be
 *   stamped and shipped with the rest — without pushing the deploy further away. A window
 *   that reset on every arrival never closes on a busy morning.
 * - **Ready and armed, window elapsed** fires, once.
 *
 * ## The order inside a fire is not an implementation detail
 *
 * Stamp every merge in the batch, disarm, **write the ledger, and only then start the
 * deploy.** A beadcause deploy SIGKILLs this process within a second or two of the
 * spawn, so anything written after it is written by nobody; a batch that deployed and
 * did not record the attempt would come back after the restart still eligible, still
 * owed if the deploy went wrong, and would fire again — an unattended retry loop against
 * the thing that restarts the server, which is precisely what must not exist here.
 *
 * A ledger that will not write therefore **cancels the fire** and puts the entry back as
 * it was, rather than deploying and hoping. And a `ship` that throws leaves the stamps in
 * place: that deploy did not start, the beads stay open, the Ship button stays armed, and
 * nothing here tries again. One attempt per merge, whatever happens to it.
 */
async function settle(entry, { ready, ledger, cfg, ws, card, wsDeploys, now, ship, result }) {
  if (!ready.length) {
    if (!entry.armedAt) return false;
    entry.armedAt = null;
    return true;
  }

  const armed = Date.parse(entry.armedAt || '');
  if (!Number.isFinite(armed)) {
    // Unarmed, or an `armedAt` that will not parse — a hand-edited ledger, most likely.
    // Both are "start the clock now", which is the reading that cannot fire early.
    entry.armedAt = new Date(now).toISOString();
    result.armed.push({ workspace: ws.name, at: entry.armedAt, numbers: ready.map((r) => r.number) });
    return true;
  }
  if (now - armed < settleMs(cfg)) return false;

  const at = new Date(now).toISOString();
  for (const r of ready) {
    const rec = entry.handled[r.key];
    if (rec) rec.autoShipAt = at;
  }
  entry.armedAt = null;

  try {
    saveLedger(ledger);
  } catch (err) {
    for (const r of ready) delete entry.handled[r.key]?.autoShipAt;
    entry.armedAt = new Date(armed).toISOString();
    result.skipped.push(
      `${ws.name}: not auto-shipping — ${LEDGER_PATH} will not write (${err.message}), and a deploy nobody recorded would run again`
    );
    return false;
  }

  // Read after the filing, so the queue carries the beads this same tick created — the
  // deploy record links to one of them, and a null there is a notification that cannot
  // say what it shipped.
  const queue = releaseFor(card, wsDeploys, ledger);
  try {
    const rec = await ship(ws, queue, { numbers: ready.map((r) => r.number) });
    result.shipped.push({
      workspace: ws.name,
      deploy: rec?.id || null,
      numbers: ready.map((r) => r.number),
      count: queue.count,
      why: ready[0]?.why || '',
    });
  } catch (err) {
    result.skipped.push(
      `${ws.name}: auto-ship did not start — ${String(err.message).split('\n')[0]}. The beads are open and Ship still works; nothing here will try again.`
    );
  }
  return true;
}

/**
 * One pass of the queue over one board: file what merged, close what shipped, and ship
 * what is allowed to ship itself.
 *
 * Called on its own slow clock (see `startPoller` in lib/server.js) rather than on the
 * board's, because it writes to a tracker and the board is redrawn every time a phone
 * looks at it. Everything it does is idempotent, so a missed tick costs nothing but
 * time and a doubled one costs nothing at all.
 *
 * `ship` is the one thing here that is injected rather than imported, and it is the only
 * thing in this file that starts a process. Two reasons, and the second is the real one:
 * a deploy is lib/deploy.js's business and this file has no opinion about how one is run,
 * and **a caller that passes no `ship` cannot auto-ship anything** — so the whole feature
 * is off for every caller that has not asked for it, including every existing test. It is
 * called as `ship(ws, queue, { numbers })` and may throw; a throw is one deploy that did
 * not start, never a retry, because the ledger has already recorded the attempt.
 *
 * Returns what it did, for the log and for the test. It throws nothing: a workspace
 * whose tracker is busy is a workspace this tick skipped, and it must not take the
 * other five down with it.
 */
export async function sweepReleases(
  bd,
  cfg,
  board,
  { owner = 'you', deploys = [], now = Date.now(), ship = null } = {}
) {
  const result = { filed: [], closed: [], watermarked: [], armed: [], shipped: [], skipped: [], error: null };
  // One memo for the whole sweep: four merges under one epic walk the same two beads,
  // and the walk is a `bd show` per level. See lib/autoship.js.
  const opinions = new Map();
  if (cfg?.release?.beads === false) {
    result.skipped.push('filing is off (release.beads: false)');
    return result;
  }

  const ledger = loadLedger();
  if (!ledger) {
    // Deliberately fatal to the sweep and to nothing else. See `loadLedger`.
    result.error = `${LEDGER_PATH} cannot be read, so nothing was filed — a lost watermark files every old merge again`;
    return result;
  }

  const grouped = byWorkspace(deploys);
  let dirty = false;

  for (const card of board?.repos || []) {
    const ws = (cfg.workspaces || []).find((w) => w.name === card.workspace);
    if (!ws || !card.repo || card.error) continue;

    // Only where beadcause can tell whether it shipped. A repo with no declared deploy
    // and no visible build has no event that could ever close one of these, and a bead
    // that can only be closed by hand is a chore this file invented rather than found.
    if (!card.deployDeclared && !card.deployTracked) continue;

    const entry = entryFor(ledger, ws.name);
    const wsDeploys = grouped.get(ws.name) || [];
    const merged = (card.prs || []).filter((p) => p.merged);

    // First sight of this repo: write the watermark, remember what was already merged,
    // and file nothing. Three weeks of history is on this board and none of it is news.
    if (!entry.since) {
      entry.since = new Date(now).toISOString();
      for (const row of merged) {
        entry.handled[String(row.number)] = {
          bead: null,
          sha: row.mergeCommit || null,
          mergedAt: row.mergedAt || null,
          filedAt: null,
          shippedAt: entry.since,
          note: 'merged before beadcause was watching this repo',
        };
      }
      result.watermarked.push({ workspace: ws.name, at: entry.since, merged: merged.length });
      dirty = true;
      continue;
    }

    const open = await openShipBeads(bd, ws, card.repo);
    if (!open) {
      result.skipped.push(`${ws.name}: could not read its ship beads`);
      continue;
    }

    // Whether this workspace could ship anything by itself. Both halves are required and
    // neither is about policy: no `ship` and nothing here starts a process at all, and a
    // repo that declares no deploy has nothing for it to start.
    const canAutoShip = typeof ship === 'function' && Boolean(card.deployDeclared);
    // The merges that would arm, or fire, this workspace's settle window.
    const ready = [];

    for (const row of merged) {
      const key = String(row.number);
      const rec = entry.handled[key] || null;
      const state = shippedState(row, wsDeploys);
      const bead = open.get(row.number) || null;

      if (state === true) {
        if (bead) {
          try {
            await bd.close(
              ws,
              bead.id,
              `Shipped — #${row.number} is live${row.deployed === true ? ' in the build that is running' : ''}.`
            );
            result.closed.push({ workspace: ws.name, number: row.number, bead: bead.id });
          } catch (err) {
            // The only write here that can be retried for free: the bead is still open,
            // still marked, and the next tick finds it again.
            result.skipped.push(`${ws.name}: could not close ${bead.id} — ${String(err.message).split('\n')[0]}`);
            continue;
          }
        }
        if (rec && !rec.shippedAt) {
          rec.shippedAt = new Date(now).toISOString();
          dirty = true;
        }
        continue;
      }

      // Not shipped, or not knowable. Either way nothing is filed for a merge that
      // predates the watermark — `mergedAt` is GitHub's own timestamp, which is what
      // makes "before we were watching" a fact rather than a guess about clocks.
      if (state !== false) continue;
      const mergedAt = Date.parse(row.mergedAt || '');
      if (!Number.isFinite(mergedAt) || mergedAt < Date.parse(entry.since)) continue;

      /**
       * Does this one ship itself?
       *
       * Asked before the bead is filed, because the bead's last line says whether
       * anything is waiting for a tap and it must not say the wrong one. Asked for a
       * merge already filed too — that is the ordinary way auto-ship gets switched on
       * over a queue that is already there — and *not* asked for one already tried,
       * which is the whole of "no retry loop": a walk that is never made is a batch that
       * can never re-arm.
       */
      const verdict =
        canAutoShip && !rec?.autoShipAt ? await resolveAutoShip(bd, cfg, ws, row, { seen: opinions }) : null;
      if (verdict && !verdict.known) result.skipped.push(`${ws.name}: #${row.number} — ${verdict.why}`);
      // Filed on an earlier tick, still owed, and allowed to go: it joins this
      // workspace's batch. A bead the ledger has lost track of deliberately does not —
      // there would be nowhere to stamp the attempt, and an attempt nobody recorded is
      // the retry loop this whole design is built to make impossible.
      const auto = Boolean(verdict?.known && verdict.auto);
      if (rec && auto) ready.push({ number: row.number, key, why: verdict.why });

      if (rec || bead) continue;

      let id = null;
      try {
        id = await bd.create(ws, {
          title: shipTitle(row),
          body: shipBody(card, row, owner, auto),
          type: 'task',
          priority: 2,
          // The `ship` label is what this file finds it by. `unendorsed` is the guarantee that
          // nothing opens a session on it: shipping is a button, and an agent handed
          // this bead could only ever re-read a pull request that is already merged.
          // See lib/endorse.js — the marker is a filter in every queue *and* a refusal
          // in the launcher.
          labels: [SHIP_LABEL, UNENDORSED],
          acceptance: `The merge commit for #${row.number} is in what ${card.workspace} is running.`,
        });
      } catch (err) {
        result.skipped.push(`${ws.name}: could not file for #${row.number} — ${String(err.message).split('\n')[0]}`);
        continue;
      }
      if (!id) {
        result.skipped.push(`${ws.name}: filing for #${row.number} returned no id`);
        continue;
      }
      entry.handled[key] = {
        bead: id,
        sha: row.mergeCommit || null,
        mergedAt: row.mergedAt || null,
        filedAt: new Date(now).toISOString(),
        shippedAt: null,
      };
      result.filed.push({ workspace: ws.name, number: row.number, bead: id });
      dirty = true;
      // Filed this tick, and it may go: the bead and the batch are the same act.
      if (auto) ready.push({ number: row.number, key, why: verdict.why });
    }

    if (canAutoShip) {
      const fired = await settle(entry, { ready, ledger, cfg, ws, card, wsDeploys, now, ship, result });
      if (fired) dirty = true;

    }

    prune(entry, now);
  }

  if (dirty) {
    try {
      saveLedger(ledger);
    } catch (err) {
      // The beads are filed and the ledger is not. The next tick finds them through
      // `openShipBeads` and files nothing twice, which is exactly why that check reads
      // the tracker rather than this file.
      result.error = `filed, but ${LEDGER_PATH} could not be written — ${err.message}`;
    }
  }
  return result;
}
