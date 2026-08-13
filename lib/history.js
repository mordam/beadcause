/**
 * The ledger — every bead a space has ever had, newest-updated first, filtered and paged.
 *
 * There was no way to look back. The inbox is incoming work, the advocate console is
 * what is running now, the endorsement queue is what is waiting on a tap — and a bead
 * that closed last week was reachable only by remembering its id and typing it into
 * `/graph`. Three hundred closed beads in this repo alone, and their close reasons are
 * the best writing in the tracker ("Landed as #92 as 677b5a5b — still owed: DEPLOYED"),
 * so the record existed and nothing displayed it.
 *
 * This file is the read side of that: one payload a list can page through.
 *
 * **Everything is swept, and every filter is applied here rather than by `bd`.** That
 * looks backwards — `bd list` takes `--status`, `--priority` and `--label`, and pushing
 * a filter down to the tracker is normally the cheaper thing to do. It is the wrong
 * trade for this screen, for one reason: the sweep is *cached*, and a cache keyed by
 * the filter is a cache that misses on every press. A filter bar over a list is four
 * controls the finger moves through — narrow to closed, then to P1, then type three
 * characters of an id — and each of those would be a fresh `bd` invocation over the
 * whole workspace if the query were part of the key. Swept once and filtered in
 * process, the whole filter bar and every page of the scroll cost nothing until the
 * cache expires. The one `bd list --all` it does cost is ~1s and ~1.5MB of JSON on the
 * largest workspace here.
 *
 * **Paging is done here because bd cannot do it.** `bd list --offset` exists and is
 * documented as "only supported under `--proxied-server`", which is not the mode
 * anything here runs in; passing it to the embedded backend is accepted and ignored,
 * which would have made page 2 a second copy of page 1. So the rows are sorted and
 * sliced in this file, and `more` is computed from a total the server actually counted
 * rather than inferred from `rows.length === limit` — the inference is wrong exactly
 * once per list, on the page where the last row lands on the boundary, and the symptom
 * is an infinite scroller that spins forever at the bottom.
 *
 * **What is cached is the slim row, not bd's payload.** A `bd list --json` row carries
 * description, acceptance, design and notes — 1.5MB for 483 beads, most of it text no
 * list draws. Stripping first and caching second is what makes holding several
 * workspaces in memory for ten seconds unremarkable (~100KB each) instead of something
 * to think about. The one field that is kept but *shortened* is the close reason, which
 * is the only long prose a row draws at all — see `CLOSE_REASON_MAX`.
 *
 * **Provenance is the label, never the byline.** `created_by` is a field an agent can
 * write whatever it likes into (see `Bd.create`), so it is display only. The `agent-filed`
 * label is the actual mark — lib/filing.js stamps it on everything an agent files and
 * lib/verdict.js keeps it on through endorsement and revocation, precisely so that one
 * `bd list --label agent-filed` stays the honest history of the feature. So `provenance`
 * is derived from the label and `createdBy` rides along beside it, and the two will
 * sometimes disagree: when they do, the label is the true one.
 *
 * The session marker is `archivedBeads` in lib/sessionlog.js — one `for-each-ref` per
 * sweep rather than a lookup per row, for the same reason the filters are in process.
 */
import { FILED_LABEL } from './filing.js';

/** Rows per page when the caller does not say. Fifty is about three phone screens. */
export const PAGE_DEFAULT = 50;

/**
 * And the most one request may ask for.
 *
 * A ceiling rather than an error, because the shape of the request is not wrong — a
 * client asking for a thousand rows wants the whole ledger, which it is welcome to
 * have a page at a time. What it may not do is make one response big enough to be the
 * reason a phone stalls.
 */
export const PAGE_MAX = 200;

/** How long a swept workspace is served again before `bd` is asked afresh. */
export const CACHE_MS = 10000;

/**
 * The statuses bd stores, and the whole of what `status=` may name.
 *
 * Validated rather than passed through, even though nothing here reaches a shell: a
 * misspelled status silently matching nothing would draw an empty ledger, and an empty
 * ledger is indistinguishable from a space with no beads in it. A 400 naming the word
 * is the difference between "you typed `close`" and "there is nothing here".
 */
export const STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'];

/** The two things a bead's provenance can be. See the header — this is the label. */
export const PROVENANCES = ['agent', 'human'];

/** How long an id-substring may be. Past this it is not a filter, it is a paste. */
const MAX_ID_QUERY = 120;

/**
 * How much of a close reason a row carries, and why it is that number rather than all.
 *
 * This field used to go out whole — 1664 characters on the worst bead in this tracker —
 * and that was right at the time. The bead detail sheet rendered `close_reason` nowhere,
 * so there was no "tap through for the rest" to clamp *towards*: cutting it here would
 * have put the sentence nowhere in the app at all. bc-9cpg removed that reason. A closed
 * bead's sheet now draws its whole reason and its close time, and every row of this
 * ledger already links straight at it (`/graph?ws=…&id=…&open=1`), so the row's copy is
 * a preview of something one tap away rather than the only copy there is.
 *
 * **240 because that is more than the row can draw.** `.hist-why` clamps to two lines in
 * CSS, and two lines were measured at **94 characters** on a 393px phone and **226** at
 * the widest the page can ever be — `main.work` caps at 780px, so 226 is a ceiling and
 * not a wide-monitor figure. Anything past that is bytes on the wire and nodes in the
 * DOM for text no reader can reach on this page. Clamping *above* the ceiling rather
 * than at the ~200 the bead proposed is what keeps this invisible: the CSS clamp stays
 * the only clamp anybody sees, at every width, and this one only ever removes text that
 * was already undrawable. Measured on the 600 beads here: a 50-row page's close reasons
 * fall from 5454 to 3321 bytes, 39% off the one field that dominates a ledger page.
 *
 * The `…` matters for the readers that are not pixels. `-webkit-line-clamp` hides text
 * visually but a screen reader still reads all of it, so before this a listener got the
 * whole sentence and now gets 240 characters of it — the ellipsis is the only thing that
 * says so, and it is why this appends one instead of cutting silently.
 */
export const CLOSE_REASON_MAX = 240;

const clean = (v) => String(v ?? '').trim();

/**
 * The first `CLOSE_REASON_MAX` characters, ending on a word.
 *
 * The `+ 1` on the slice is what makes a word ending exactly on the boundary survive
 * whole: searching the first 240 characters alone cannot tell "…still owed" cut mid-word
 * from "…still owed " cut cleanly, and it would drop the last word of both. The fallback
 * to a hard cut is for the text that has no whitespace to back off to — a pasted URL, a
 * wrapped sha — where honouring the boundary would throw away most of the preview.
 */
const clampReason = (text) => {
  if (text.length <= CLOSE_REASON_MAX) return text;
  const boundary = text.slice(0, CLOSE_REASON_MAX + 1).search(/\s+\S*$/);
  const at = boundary > CLOSE_REASON_MAX / 2 ? boundary : CLOSE_REASON_MAX;
  return `${text.slice(0, at).trimEnd()}…`;
};

/**
 * One `bd` row → one row of the ledger.
 *
 * The renamings are the ones that always bite: bd calls them `issue_type`, `updated_at`
 * and `close_reason`, and a client reading `.type` or `.updated` off a raw row gets
 * `undefined` — the same trap `toRow` in lib/endorsequeue.js and `ROW_FIELD` in
 * lib/verdict.js exist for. Renamed once, here, so no page ever sees bd's vocabulary.
 *
 * `closeReason` is always present and `null` when there is none, rather than absent.
 * The list draws it conditionally, and `'closeReason' in row` being the test would make
 * a row from an older daemon read as "closed for no reason" instead of "not closed".
 * It is also the one field here that is *not* what bd holds — see `CLOSE_REASON_MAX`.
 * The whole sentence is on the sheet the row links to, which is the only screen that
 * can draw it, and nothing on this side filters or searches it (`matches` looks at the
 * id alone), so a clamped copy costs no behaviour.
 *
 * No description, acceptance, design or notes: this is a list, and the detail sheet the
 * rows open (`/api/bead`) already carries all four. That omission is most of why a page
 * of the ledger is a few kilobytes.
 */
export function toRow(workspace, issue, archived = null) {
  const labels = (issue?.labels || []).map(clean).filter(Boolean);
  const id = clean(issue?.id);
  return {
    key: `${workspace}/${id}`,
    workspace,
    id,
    title: clean(issue?.title) || id,
    type: clean(issue?.issue_type) || null,
    status: clean(issue?.status) || 'open',
    priority: issue?.priority ?? null,
    updated: issue?.updated_at || null,
    created: issue?.created_at || null,
    closed: issue?.closed_at || null,
    closeReason: clampReason(clean(issue?.close_reason)) || null,
    labels,
    // Display only. The line above it is the one that decides anything — see the header.
    createdBy: clean(issue?.created_by) || null,
    provenance: labels.includes(FILED_LABEL) ? 'agent' : 'human',
    // Whether a session was archived for this bead, from one ref listing per sweep.
    hasSession: archived ? archived.has(id) : false,
  };
}

/**
 * Newest-updated first, and stable.
 *
 * The tie-break is not decoration: a `bd` write stamps `updated_at` to the second, and
 * a delivery closes a bead and its epic in the same second often enough that two rows
 * really do collide. Without a second key their order is whatever the sweep happened to
 * return, which means the same list can shuffle between two pages of one scroll — and a
 * row that moves across a page boundary is a row the reader sees twice or not at all.
 * Numeric-aware, because bd's own ids run `bc-goo.1` through `bc-goo.11` and a plain
 * string sort files the eleventh child between the first and the second.
 */
export const newestUpdatedFirst = (a, b) =>
  String(b.updated || '').localeCompare(String(a.updated || '')) ||
  String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

/**
 * Read the query string, or say which parameter is wrong.
 *
 * Returns `{ query }` or `{ error }` — never a half-understood query. A filter that
 * cannot be honoured has to be refused rather than dropped: dropping `status=close`
 * shows every bead in the space under a control that says "closed", which is a screen
 * confidently telling you something false. The one exception is paging, where a limit
 * over the ceiling is clamped rather than refused, because the *set* it describes is
 * still right — see `PAGE_MAX`.
 *
 * Takes anything with a `.get`, so a `URLSearchParams` or a plain `Map` both work; the
 * tests use the second and the server the first.
 */
export function parseQuery(params) {
  const get = (k) => {
    const v = params?.get?.(k);
    return v === null || v === undefined ? '' : clean(v);
  };

  const query = { status: null, priority: null, provenance: null, id: '', limit: PAGE_DEFAULT, offset: 0 };

  const status = get('status');
  if (status) {
    const wanted = status
      .split(',')
      .map((s) => clean(s).toLowerCase())
      .filter(Boolean);
    const bad = wanted.find((s) => !STATUSES.includes(s));
    if (bad) return { error: `not a status: ${bad} — one of ${STATUSES.join(', ')}` };
    if (wanted.length) query.status = [...new Set(wanted)];
  }

  const priority = get('priority');
  if (priority) {
    const wanted = [];
    for (const raw of priority.split(',')) {
      // `P1` as readily as `1`: the app writes priorities as P0-P4 everywhere a person
      // reads them, and a filter chip that sends back what it displays is the obvious
      // client to write.
      const text = clean(raw).replace(/^[pP]/, '');
      if (!text) continue;
      if (!/^[0-4]$/.test(text)) return { error: `not a priority: ${clean(raw)} — 0 to 4, or P0 to P4` };
      wanted.push(Number(text));
    }
    if (wanted.length) query.priority = [...new Set(wanted)];
  }

  const provenance = get('provenance');
  if (provenance) {
    const want = provenance.toLowerCase();
    if (!PROVENANCES.includes(want)) {
      return { error: `not a provenance: ${provenance} — ${PROVENANCES.join(' or ')}` };
    }
    query.provenance = want;
  }

  const id = get('id');
  if (id.length > MAX_ID_QUERY) return { error: `id filter is ${id.length} characters — ${MAX_ID_QUERY} is the most` };
  query.id = id;

  // Both refused rather than coerced, and for the same reason a bad status is: `Number('')`
  // is 0 and `Number('two')` is NaN, and a NaN offset silently becoming page one is a
  // scroller that jumps to the top with nothing to say about why.
  for (const key of ['limit', 'offset']) {
    const raw = get(key);
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) return { error: `${key} must be a whole number, not ${raw}` };
    query[key] = Number(raw);
  }
  if (query.limit === 0) return { error: 'limit must be at least 1' };
  query.limit = Math.min(query.limit, PAGE_MAX);

  return { query };
}

/** Does this row survive the filters? All of them, ANDed — see `ledger`. */
export function matches(row, query) {
  if (query?.status && !query.status.includes(row.status)) return false;
  if (query?.priority && !query.priority.includes(row.priority)) return false;
  if (query?.provenance && row.provenance !== query.provenance) return false;
  // Case-insensitive substring, on the id alone. Deliberately not the title: the field
  // is one text box next to three pickers, and a box that matched both would answer
  // "nib3" with every bead whose *title* says history as well as the five under that
  // epic. Titles are searched by `bd search`, which is a different act.
  if (query?.id && !row.id.toLowerCase().includes(query.id.toLowerCase())) return false;
  return true;
}

/**
 * Every bead in one workspace, slim, with the session marker already on it.
 *
 * Cached per workspace for `CACHE_MS`, because one press of a filter chip is not a
 * reason to sweep a tracker — see the header. The cache is by workspace name and holds
 * the *unfiltered* set, so every filter and every page of one scroll is served from the
 * same sweep.
 */
const cached = new Map();

/**
 * The sweeps that have not come back yet, so two requests never pay for one twice.
 *
 * The cache above only helps once an answer exists, and the window before the first one
 * does is the expensive window: a cold sweep is ~1s idle and was measured at 28.6s under
 * load here, which is plenty of time for the phone and the laptop to both open the tab, or
 * for a ⟳ to land on a request still in flight. Without this each of those starts its own
 * `bd list --all` over the same workspace — the single most expensive call in the app, run
 * twice for one answer.
 *
 * A `refresh` joins an in-flight sweep rather than starting a second one, which is the
 * right reading of what refresh means: a sweep that began a moment ago and has not
 * returned is reading the tracker *now*, so it is exactly as fresh as one started here
 * would be, and starting the second is the cost this exists to prevent.
 */
const inflight = new Map();

/**
 * Throw the sweeps away — one workspace, or all of them.
 *
 * **Deliberately not wired to anything that writes a bead**, unlike `endorsementQueue`'s
 * `forget`, which a verdict drops because the row it changed has to *leave* a queue on
 * every other device. Nothing here is a queue: a bead that changed a moment ago is still
 * in the ledger, still at or near the top of it, and at worst its status is ten seconds
 * stale. Dropping the cache on every write would mean a busy afternoon — twenty sessions
 * closing beads — sweeping the tracker on nearly every request, which is the cost this
 * cache exists to avoid, paid to fix a row nobody was looking at.
 *
 * So this is for the tests, and for `refresh=1` on the request, which is the client
 * saying it wants the sweep redone now.
 */
export const forget = (workspace = null) => {
  if (workspace) {
    cached.delete(workspace);
    inflight.delete(workspace);
  } else {
    cached.clear();
    inflight.clear();
  }
};

async function sweep(bd, ws, { archivedFor, refresh, now }) {
  const hit = cached.get(ws.name);
  if (!refresh && hit && now() - hit.ms < CACHE_MS) return hit.rows;

  // Join a sweep already running for this workspace. See `inflight`.
  const running = inflight.get(ws.name);
  if (running) return running;

  const task = fetchRows(bd, ws, { archivedFor, now });
  inflight.set(ws.name, task);
  try {
    return await task;
  } finally {
    // Cleared whether it resolved or threw — a failed sweep must be retryable on the next
    // request rather than remembered as the answer.
    inflight.delete(ws.name);
  }
}

async function fetchRows(bd, ws, { archivedFor, now }) {
  const issues = await bd.listAll(ws);
  // One ref listing for the whole workspace. A failure here is an empty set rather than a
  // failed sweep: the marker is worth less than the list it decorates, and a repo whose
  // history would not draw because a decoration could not be computed is the worst
  // possible trade. `Promise.resolve().then` rather than `archivedFor(ws).catch` because
  // the throw is not always asynchronous — `resolveSessionDir`, which the server resolves
  // this through, throws synchronously with a 409 for a workspace it cannot map to a
  // checkout, and that would have escaped the `.catch` entirely and cost the workspace
  // its whole ledger through `ledger`'s error path.
  const archived = archivedFor
    ? await Promise.resolve()
        .then(() => archivedFor(ws))
        .catch(() => new Set())
    : new Set();
  const rows = (issues || []).filter((i) => i && i.id).map((i) => toRow(ws.name, i, archived));
  cached.set(ws.name, { ms: now(), rows });
  return rows;
}

/**
 * The ledger for a set of workspaces: filtered, ordered newest-updated first, one page.
 *
 * `workspaces` is resolved by the caller, because which repos a *space* holds is
 * config and this file has no opinion about config — one workspace for the page as it
 * is drawn today, several for a space that spans repos, all of them for `space=all`.
 * Rows carry their own `workspace`, so a merged list can label them.
 *
 * **A workspace whose `bd` fell over is a row in `errors`, not a failed request.** Six
 * repos where one has a corrupt Dolt directory should still show you the other five,
 * and the one that did not answer is named — a ledger that silently dropped a repo
 * would be telling you that repo has no history. Same shape, and the same reasoning, as
 * `endorsementQueue`.
 *
 * `total` is what the filters matched across every workspace, before paging; `more` is
 * whether anything is left after this page. Both are counted rather than inferred.
 */
export async function ledger(
  bd,
  workspaces,
  query = {},
  { archivedFor = null, refresh = false, now = () => Date.now() } = {}
) {
  const limit = Math.min(Math.max(1, Number(query.limit) || PAGE_DEFAULT), PAGE_MAX);
  const offset = Math.max(0, Number(query.offset) || 0);

  const errors = [];
  const perWorkspace = await Promise.all(
    (workspaces || []).map(async (ws) => {
      try {
        return await sweep(bd, ws, { archivedFor, refresh, now });
      } catch (err) {
        errors.push({ workspace: ws.name, error: String(err?.message || err).split('\n')[0] });
        return [];
      }
    })
  );

  const all = perWorkspace.flat().filter((row) => matches(row, query));
  all.sort(newestUpdatedFirst);
  const rows = all.slice(offset, offset + limit);

  return {
    at: new Date(now()).toISOString(),
    workspaces: (workspaces || []).map((w) => w.name),
    rows,
    total: all.length,
    limit,
    offset,
    // Counted, never `rows.length === limit`. See the header.
    more: offset + rows.length < all.length,
    errors,
  };
}
