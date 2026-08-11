/**
 * What has actually been finished — every closed bead, newest first, as one paged list.
 *
 * Everything else in this app is about work that is not done. The inbox is what needs
 * answering, the advocate console is what is running, the PR board is what is waiting to
 * land, and the endorsement queue is what nobody has looked at yet. There was nowhere at
 * all to look at what *landed*: beadcause had 369 closed beads and the only reader for
 * them was `bd list --status=closed` in a terminal.
 *
 * ## The close reason is the row, and this is the only place it is legible
 *
 * A bead's `close_reason` here is not bookkeeping. `bin/deliver.js` writes the sentence
 * that says what happened — `Landed as #113 as e8315969 — still owed: CAN BE DEPLOYED —
 * lib/server.js changed, so the router needs main on disk before it swaps` — and the
 * other endings are just as load-bearing: `Answered via Beadcause`, a revoke's reason, a
 * supersede. So the reason is drawn on the row rather than folded away behind it, and it
 * is sent **in full**.
 *
 * In full deliberately, and it is the one place this file spends bytes where the
 * neighbouring sweeps save them. The bead detail sheet does not render `close_reason` at
 * all (grep public/graph.js — it draws the status, never the reason), so clamping it here
 * would put the sentence *nowhere* in the app: there is no "tap through for the rest".
 * The longest reason in this tracker is 1664 characters and five of 369 are over 531, so
 * the cost is a handful of tall rows rather than a heavy page, and public/history.js
 * clamps those visually with an expander over text it already holds.
 *
 * Everything else on the row **is** slim, for the reason `agentBeads` in lib/server.js is:
 * no description, no acceptance, no notes. One workspace's closed beads are 1.29MB raw and
 * 129KB with those three fields dropped, which is the difference between a list and a
 * download. This is the opposite trade from lib/endorsequeue.js next door, and on purpose:
 * there the decision *is* reading the bead, so the rows are fat and the list is capped.
 * Here you are scanning a history, so the rows are thin and the list is paged.
 *
 * ## Why this endpoint filters by space and the others do not
 *
 * `public/prs.js` and `public/endorse.js` both narrow to the space picker's selection on
 * the *client*, and this file's first draft did the same. It cannot work here, and the
 * reason is paging rather than taste: a page of 30 rows swept across seven workspaces,
 * narrowed afterwards on the client, is a page of *three* rows once one repo is selected —
 * with a "show more" that pages through six repos of beads you asked not to see to find
 * the next three you did. Whoever slices has to be whoever pages. So `filter` comes in on
 * the query and `matchesFilter` — the same two-level test lib/spaces.js applies to decide
 * whether a bead may ring your phone — is applied before the slice, and the client sends
 * what the picker has selected rather than filtering what comes back.
 *
 * ## The sweep is cached whole, and paged out of the cache
 *
 * `bd list --status=closed` is ~0.55s per workspace and its answer is the least volatile
 * thing in the tracker — a bead that closed an hour ago will still have closed an hour
 * ago. So one sweep fills a cache of every closed bead in every workspace, sorted, and
 * every page and every move of the picker is then served out of it for `CACHE_MS`. Paging
 * a list whose order is recomputed per request is how a row appears twice: `newestClosedFirst`
 * is a total order, ties broken on id, precisely so that `offset` means the same thing on
 * the second request as it did on the first.
 *
 * **Nothing drops this cache on a write, and that is a decision.** `announceVerdict` in
 * lib/server.js drops the endorsement queue's the instant a verdict lands, because there a
 * stale row is a button that 409s. Nothing on this screen is actionable: a bead closed in
 * the last minute is a row arriving late, and ⟳ sends `refresh=1`. Against that, the
 * hooks would have to go in six files — `bd.close` is called from lib/server.js twice,
 * lib/verdict.js, lib/landed.js, lib/owed.js and lib/release.js — and would still be
 * *wrong*, because the process that closes most beads in this tracker is `bin/deliver.js`,
 * a worker session in a different process whose close the daemon cannot observe at all. A
 * rule that is uniformly a minute old beats one that is instant for three closes out of
 * seven and silently a minute old for the rest.
 *
 * A workspace whose `bd` fell over is a row in `errors` and not a failed request, the same
 * bargain lib/endorsequeue.js makes: six repos of history should not be withheld because
 * the seventh has a Dolt lock, and the one that did not answer is named, because a history
 * that silently dropped a repo would read as a repo where nothing has ever been finished.
 */
import { matchesFilter, spaceFor } from './spaces.js';

/** How many rows a page holds when the caller does not say. */
export const PAGE_DEFAULT = 30;

/**
 * The most a single page may hold.
 *
 * A cap on the *page* rather than on the list, which is the whole difference between this
 * screen and the endorsement queue's `QUEUE_MAX`: there, everything over the cap is a
 * backlog you are told about and cannot reach; here it is simply the next page. What this
 * number protects is one request — a client asking for `limit=100000` must not be able to
 * turn a paged endpoint back into the 1.29MB download it exists to avoid.
 */
export const PAGE_MAX = 100;

/** How long a swept history is served again before the sweep is redone. See the header. */
export const CACHE_MS = 60000;

const clean = (v) => String(v ?? '').trim();

/**
 * One `bd` row → one row of history.
 *
 * `issue_type` is renamed, because a client reading `.type` off a raw bd row gets
 * `undefined` — the same trap `ROW_FIELD` in lib/verdict.js and `toRow` in
 * lib/endorsequeue.js both exist for. `space` is carried on the row rather than looked up
 * at filter time so that `matchesFilter` can be handed a row as-is, exactly as the push
 * path hands it a question.
 *
 * `closedAt` falls back to `updated_at`. A bead closed by something that did not stamp
 * `closed_at` is rare — nothing in this tracker has one missing — but a row that sorted to
 * the bottom of a newest-first list forever would be the one closed bead you could never
 * find, and the update time is within seconds of the truth.
 */
export function toRow(workspace, space, issue) {
  return {
    key: `${workspace}/${issue.id}`,
    workspace,
    space: space || null,
    id: clean(issue.id),
    title: clean(issue.title) || clean(issue.id),
    type: clean(issue.issue_type) || null,
    priority: issue?.priority ?? null,
    closedAt: issue?.closed_at || issue?.updated_at || null,
    // In full, and the header says why: there is nowhere else in the app to read it.
    reason: clean(issue.close_reason),
    labels: (issue?.labels || []).map(clean).filter(Boolean),
    // Which epic it was a child of, when it was one. Cheap — `bd list` carries it — and it
    // is the one relation that makes a bare subtask title ("The list itself") mean
    // something in a flat list of 369.
    parent: clean(issue.parent) || null,
  };
}

/**
 * Newest close first, and a **total** order: two beads closed in the same second sort by
 * id. Paging depends on that second clause rather than merely being tidied by it — see the
 * header.
 */
export const newestClosedFirst = (a, b) =>
  String(b.closedAt || '').localeCompare(String(a.closedAt || '')) ||
  String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

let cached = null;

/** Throw the cache away — for a test, and for anything that has just closed a bead. */
export const forget = () => {
  cached = null;
};

/** The whole sorted history, swept at most once per `CACHE_MS`. */
async function sweep(bd, cfg, { refresh, now }) {
  if (!refresh && cached && now() - cached.ms < CACHE_MS) return cached.value;

  const workspaces = cfg?.workspaces || [];
  const errors = [];
  const perWorkspace = await Promise.all(
    workspaces.map(async (ws) => {
      try {
        const space = spaceFor(cfg, ws.name)?.name || null;
        const rows = await bd.listStatus(ws, 'closed');
        return (rows || []).filter((r) => r?.id).map((r) => toRow(ws.name, space, r));
      } catch (err) {
        errors.push({ workspace: ws.name, error: String(err?.message || err).split('\n')[0] });
        return [];
      }
    })
  );

  const value = {
    at: new Date(now()).toISOString(),
    rows: perWorkspace.flat().sort(newestClosedFirst),
    workspaces: workspaces.map((w) => w.name),
    errors,
  };
  cached = { ms: now(), value };
  return value;
}

/**
 * One page of closed beads, newest first, inside `filter`.
 *
 * `counts` answers three different questions and they are three fields because two of
 * them get confused for each other: `total` is every closed bead in every workspace,
 * `matched` is how many are inside the selection — what the page says out loud and what
 * `more` is computed against — and `shown` is the length of this page. `byWorkspace`
 * counts the matched set, so a picker on `All` gets the per-repo tally that says where the
 * history actually is.
 *
 * `offset` past the end is an empty page rather than an error. The picker can narrow while
 * you are three pages down, and 400ing at that is a screen that breaks on an ordinary tap.
 */
export async function closedHistory(
  bd,
  cfg,
  { filter = null, offset = 0, limit = PAGE_DEFAULT, refresh = false, now = () => Date.now() } = {}
) {
  const { at, rows, workspaces, errors } = await sweep(bd, cfg, { refresh, now });

  const want = { space: clean(filter?.space) || 'all', workspace: clean(filter?.workspace) || 'all' };
  const matched = rows.filter((r) => matchesFilter(want, r));

  /* Clamped rather than validated, and both of these read anything unusable as "not
     given" rather than as the nearest legal value. That distinction is the whole reason
     they are written out: `Math.max(1, …)` on the limit turned `limit=-5` into a page of
     **one row** while `limit=0` got the default, which is two different answers to the
     same nonsense — and a one-row page is the kind of bug that reads as a history with
     almost nothing in it. */
  const wantOffset = Math.floor(Number(offset));
  const from = Number.isFinite(wantOffset) && wantOffset > 0 ? wantOffset : 0;
  const wantLimit = Math.floor(Number(limit));
  const size = Number.isFinite(wantLimit) && wantLimit > 0 ? Math.min(PAGE_MAX, wantLimit) : PAGE_DEFAULT;
  const beads = matched.slice(from, from + size);

  const byWorkspace = {};
  for (const row of matched) byWorkspace[row.workspace] = (byWorkspace[row.workspace] || 0) + 1;

  return {
    at,
    beads,
    offset: from,
    limit: size,
    // Whether asking for the next page would return anything. Computed here rather than
    // left to the client to derive from three numbers, because "is there more" is the one
    // thing the button at the foot of the list is drawn from.
    more: from + beads.length < matched.length,
    counts: { total: rows.length, matched: matched.length, shown: beads.length, byWorkspace },
    filter: want,
    workspaces,
    errors,
  };
}
