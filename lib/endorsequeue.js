/**
 * The endorsement queue — every bead nobody has looked at yet, as one list.
 *
 * Three files make up this feature and they are three different jobs. lib/filing.js
 * puts a bead under the hold the moment a worker finds the work; lib/endorse.js *is*
 * the hold, and refuses to let anything open a session on one; lib/verdict.js is the
 * four things you can say about one. None of them can tell you **what is waiting**,
 * and until this file there was nowhere on a phone that could: a held bead was a
 * muted pill on the advocate console reading `3 held for endorsement`, with no way to
 * see which three, let alone act on them.
 *
 * So: one sweep, every workspace, newest first.
 *
 * **Why the rows are fat and the list is short.** Everywhere else in this app a list
 * endpoint is deliberately slim — `agentBeads` in lib/server.js strips a `bd list` down
 * to what a folded row draws, because seven workspaces of full descriptions is most of
 * a megabyte on a phone. This one carries the whole bead: title, type, priority,
 * description, acceptance and the provenance note. That is not an oversight, it is the
 * screen's premise. You are being asked whether an hour of unattended agent should be
 * spent on this, and a decision made off a title is not a decision — it is a rubber
 * stamp with extra steps. The payload stays small because the *list* is short: an
 * endorsement queue with sixty beads in it means nobody has looked at their phone for
 * a week, which is a different problem from a slow request.
 *
 * **`bd list` cannot tell you where a bead came from, so `bd show` is asked.** The list
 * row carries labels, notes and every text field, but not `dependencies[]` — and the
 * `discovered-from` edge is the whole of "which bead the work was found under", which
 * is the one thing on this screen you cannot reconstruct from the bead's own words.
 * One `bd show` per row is the price, bounded by `PROVENANCE_MAX` and run a few at a
 * time, and it is a *read*: it never queues behind Dolt's single writer. A show that
 * fails costs the row its provenance line and nothing else — a queue that would not
 * load because one edge could not be read would be the worst possible trade.
 *
 * **Closed beads are not in it.** A revoked bead keeps the marker on purpose (see
 * lib/verdict.js) so `bd list --label unendorsed` stays the honest history of the
 * feature — but the history is not the queue, and a screen that showed you every bead
 * you have ever turned down is a screen you stop opening. `Bd.listLabel` asks for
 * open, in_progress and blocked only, which is exactly the set still waiting on you.
 *
 * **And ship beads are not in it either.** lib/release.js files one per merged pull request
 * carrying `unendorsed`, but not because anybody is being asked about it — there, the marker
 * was doing duty as "nothing may open a session on this". This screen's premise is the other
 * question, *should an hour of unattended agent be spent on this bead?*, and for a ship bead
 * there is no answer to give: only a deploy closes one. They are the highest-frequency thing
 * filed here, one per merge, so `newestFirst` put them permanently at the front of
 * `QUEUE_MAX` — "Endorse all" did not merely happen to reach them, it reached them first.
 * Twenty-five in one press on 2026-08-11, and three unattended windows opened on the
 * results. They are filtered out below, and the promise no longer rests on this screen's own
 * marker at all. See lib/shipbead.js.
 */
import { UNENDORSED, isHeld } from './endorse.js';
import { DISCOVERED_FROM, FILED_LABEL } from './filing.js';
import { isShipBead } from './shipbead.js';

/**
 * How many beads the queue will draw.
 *
 * A cap rather than paging, because paging an endorsement queue is designing for the
 * failure case: sixty unendorsed beads is not a list to page through, it is a backlog
 * to answer. What is over the cap is *counted* and said so on the page — a truncation
 * you are not told about is the one that makes a screen lie.
 */
export const QUEUE_MAX = 60;

/** How many of those get their provenance looked up. See the header. */
export const PROVENANCE_MAX = 40;

/** How many `bd show` calls are in flight at once. Reads, so this is politeness. */
export const PROVENANCE_CONCURRENCY = 4;

/** How long a swept queue is served again before the sweep is redone. */
export const CACHE_MS = 15000;

/** Edge types that mean "this is where it came from" rather than "this waits on that". */
const PROVENANCE_EDGES = new Set([DISCOVERED_FROM, 'related']);

/**
 * Is this bead waiting on your judgement? The marker, minus the ship beads.
 *
 * The two clauses are the two paragraphs at the top of this file, and they are one
 * predicate rather than two tests at each call site because the second one is the half
 * that gets forgotten. `unendorsed` alone was the whole rule until lib/release.js started
 * filing ship beads with it as a "nothing may open a session on this" hold, and the
 * twenty-five that "Endorse all" reached in one press are what it cost. Anything drawing a
 * held bead — this file's queue, and the inbox's endorsements kind (`agentBeads` in
 * lib/server.js) — asks here, so the two screens cannot disagree about what is on them.
 */
export const awaitingEndorsement = (issue) => isHeld(issue) && !isShipBead(issue);

const clean = (v) => String(v ?? '').trim();

/**
 * Where this bead came from — the `discovered-from` edge, or the parent, or nothing.
 *
 * The edge wins over the parent when both exist, and they often do: an agent working a
 * child of an epic files a discovery, and the new bead may be given the epic as a
 * parent as well. "Found while working bc-3zo9.4" is the sentence that explains why
 * this bead exists; "under bc-3zo9" is only where it lives, which the graph already
 * says.
 *
 * `related` is accepted alongside `discovered-from` because bd stores the discovery
 * edge as a related-kind edge, and a bead filed before lib/filing.js named the type
 * carries the plain one. Taking either is closer to the truth than insisting on the
 * spelling and drawing no provenance at all.
 */
export function sourceOf(issue) {
  const rows = Array.isArray(issue?.dependencies) ? issue.dependencies.filter(Boolean) : [];
  const edge =
    rows.find((r) => clean(r.dependency_type) === DISCOVERED_FROM) ||
    rows.find((r) => PROVENANCE_EDGES.has(clean(r.dependency_type)));
  if (edge?.id) {
    return { id: clean(edge.id), title: clean(edge.title), status: clean(edge.status), kind: 'discovered' };
  }

  const parent = rows.find((r) => clean(r.dependency_type) === 'parent-child') || null;
  const id = clean(parent?.id || issue?.parent);
  if (!id) return null;
  return { id, title: clean(parent?.title), status: clean(parent?.status), kind: 'parent' };
}

/**
 * One `bd` row → one card's worth of bead.
 *
 * The two renamings are the ones that bite: a row carries `issue_type` and
 * `acceptance_criteria`, and a client reading `.type` off a raw row gets `undefined` —
 * the same trap `ROW_FIELD` in lib/verdict.js exists for. They are renamed here, once,
 * so the page never sees bd's vocabulary.
 *
 * `held` is computed rather than assumed. Every row in this queue came from a query on
 * the marker, so it is true by construction today — but the flag is what the client
 * uses to decide whether the verdicts are offered, and a bead that lost the marker
 * between the sweep and the paint should draw as one it cannot revoke rather than as a
 * button that 409s.
 */
export function toRow(workspace, issue) {
  const labels = (issue?.labels || []).map(clean).filter(Boolean);
  return {
    key: `${workspace}/${issue.id}`,
    workspace,
    id: clean(issue.id),
    title: clean(issue.title) || clean(issue.id),
    type: clean(issue.issue_type) || null,
    priority: issue?.priority ?? null,
    status: clean(issue.status) || 'open',
    description: clean(issue.description),
    acceptance: clean(issue.acceptance_criteria),
    design: clean(issue.design),
    // The paragraph lib/filing.js wrote: how the agent found it, whether the priority
    // was clamped, whether it looks like a duplicate. It is the agent's argument, and
    // it is the half of the card that is not the work itself.
    notes: clean(issue.notes),
    labels,
    filed: labels.includes(FILED_LABEL),
    held: isHeld(issue),
    createdAt: issue?.created_at || null,
    updatedAt: issue?.updated_at || null,
    commentCount: issue?.comment_count ?? 0,
    // Filled in by the provenance pass, which is a second `bd` call and may not have
    // run. `null` means "not known", never "it came from nowhere" — see the header.
    from: null,
  };
}

/** Newest first, and stable: two beads filed in the same second sort by id. */
export const newestFirst = (a, b) =>
  String(b.createdAt || '').localeCompare(String(a.createdAt || '')) ||
  String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

/** Run `work` over `items`, `limit` at a time. Never rejects: a thrown item is skipped. */
async function pool(items, limit, work) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await work(next).catch(() => {});
    }
  });
  await Promise.all(runners);
}

/**
 * Ask the tracker where each of these came from, and hang it on the row.
 *
 * Mutates the rows in place, which is the honest shape here: the caller wants the same
 * list back with one more field on it, and rebuilding the array would only hide that.
 * Bounded twice — `PROVENANCE_MAX` rows, `PROVENANCE_CONCURRENCY` at a time — because
 * this is the only unbounded thing on the sweep and the queue is drawn on a phone.
 */
export async function addProvenance(bd, workspaces, rows) {
  const byName = new Map((workspaces || []).map((w) => [w.name, w]));
  await pool(rows.slice(0, PROVENANCE_MAX), PROVENANCE_CONCURRENCY, async (row) => {
    const ws = byName.get(row.workspace);
    if (!ws) return;
    const issue = await bd.show(ws, row.id);
    if (issue) row.from = sourceOf(issue);
  });
  return rows;
}

let cached = null;

/** Throw the cache away — for a test, and for a verdict that has just changed the list. */
export const forget = () => {
  cached = null;
};

/**
 * The whole queue: every held bead in every workspace, newest first.
 *
 * A workspace whose `bd` fell over is a row in `errors` and not a failed request. Six
 * workspaces where one has a corrupt Dolt directory should still show you the other
 * five — and the one that did not answer is named, because a queue that silently
 * dropped a repo would tell you there is nothing to endorse in it.
 *
 * `counts.total` is every held bead found, `beads` is at most `QUEUE_MAX` of them, and
 * `truncated` is the difference. The page says so when it is not zero.
 */
export async function endorsementQueue(bd, workspaces, { refresh = false, now = () => Date.now() } = {}) {
  if (!refresh && cached && now() - cached.ms < CACHE_MS) return cached.value;

  const errors = [];
  const perWorkspace = await Promise.all(
    (workspaces || []).map(async (ws) => {
      try {
        const rows = await bd.listLabel(ws, UNENDORSED);
        // Ship beads are not waiting on a judgement, so they are not on this screen. See
        // the header, and lib/shipbead.js for what one press of "Endorse all" did to them.
        return (rows || []).filter(awaitingEndorsement).map((r) => toRow(ws.name, r));
      } catch (err) {
        errors.push({ workspace: ws.name, error: String(err?.message || err).split('\n')[0] });
        return [];
      }
    })
  );

  const all = perWorkspace.flat().sort(newestFirst);
  const beads = all.slice(0, QUEUE_MAX);
  await addProvenance(bd, workspaces, beads);

  const byWorkspace = {};
  for (const row of all) byWorkspace[row.workspace] = (byWorkspace[row.workspace] || 0) + 1;

  const value = {
    at: new Date(now()).toISOString(),
    beads,
    counts: { total: all.length, shown: beads.length, byWorkspace },
    truncated: Math.max(0, all.length - beads.length),
    workspaces: (workspaces || []).map((w) => w.name),
    errors,
  };
  cached = { ms: now(), value };
  return value;
}
