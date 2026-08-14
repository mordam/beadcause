/**
 * Bead ids written in prose, turned into edges the graph can be walked over.
 *
 * Measured on this workspace on 2026-08-13, over 850 beads: the prose held **1,633**
 * references from one bead to another, 710 pairs were already joined by an edge of some
 * kind, and the whole graph contained **two** see-also edges — one drawn by hand days
 * earlier, the other minutes before this was started. "The same defect as bc-767a",
 * "see also bc-rcrt", "sits in bc-42ow's neighbourhood" are all real relationships, and
 * none of them was reachable by `bd show`, `bd dep tree`, the graph page or a dispatch
 * brief. So every session rebuilt the neighbourhood by reading descriptions, and mostly
 * did not bother.
 *
 * Two halves, and this module is the shared middle of both: a **sweep** over the prose
 * that already exists (scripts/relate-sweep.mjs), and a **write-time hook** so a bead
 * id that appears in a description, a note or a comment becomes an edge as it is
 * written (`relateMentions` in lib/bd.js).
 *
 * **What an edge here claims, and what it deliberately does not.** lib/beadref.js
 * argues the precision case and it is the right argument for the question it asks —
 * "which bead is this pull request *for*" decides what gets closed, so a delivery whose
 * body ended "nothing was done about bc-2tr, which this unblocks" must not count as
 * four claims. This asks a weaker question and answers it honestly: `relates-to` means
 * *mentioned near*, nothing more. The bead that says it did not touch bc-2tr is still a
 * bead a reader of bc-2tr wants to know exists. So there is no verb tier here — a
 * mention is the relationship — and the precision instead comes from what is refused:
 * a pair the graph already joins by any edge at all, an id that does not exist, a bead's
 * own id, and a runaway.
 *
 * **`relates-to`, not `related`.** bd 1.1.2 writes `bd dep relate` as two rows of type
 * `relates-to`, one at each end. Every reader in this repo was written against the
 * spelling `related` — lib/graph.js's `NOT_BLOCKING`, public/graph.js's `RELATED` —
 * because the one edge that existed when they were written was made by hand under the
 * older name. Left alone, the first sweep would have drawn 1,308 edges the phone
 * rendered as "Waits on", which is the one thing a loose see-also must never say. Both spellings are accepted everywhere; `RELATED_EDGE` is the one that is
 * written.
 */

/** What `bd dep relate` actually stores, at both ends. */
export const RELATED_EDGE = 'relates-to';

/**
 * Both spellings, for every reader that has to decide whether an edge blocks.
 *
 * `related` is bd's older name for the same thing and one edge here still carries it
 * (bc-dte → bc-tlk, 2026-08-09). Accepting both costs a set lookup and means no reader
 * has to know which era an edge came from.
 */
export const RELATED_EDGES = new Set(['related', RELATED_EDGE]);

/**
 * The most edges one bead's prose may draw in a single pass.
 *
 * Not a precision knob — a runaway guard. The honest case for a high number is the
 * epic whose description names twenty-three adoptees: it really does relate to all
 * twenty-three, and capping that at five would throw away the exact structure this
 * exists to capture. The case for having a number at all is the comment nobody
 * intended as a list — a queue dump, a sweep report, a paste of `bd ready` — which can
 * name every open bead in the workspace and would wire one bead to two hundred.
 *
 * Forty is measured, not chosen: on this workspace on 2026-08-13, exactly one bead
 * reaches it — bc-xl7n, the catch-all root, whose prose names 55 beads because naming
 * every kind of work there is *is* what it is for. The next largest is 28. So the cap
 * sits in the gap between the biggest real description and the only bead behaving like
 * a list, and it is far below what a queue dump would produce.
 */
export const MENTION_CAP = 40;

/** `bc` from `bc-arj0.4` — the workspace's prefix, free, with no `bd` call to ask for it. */
export function prefixOf(id) {
  const prefix = String(id || '').split('-')[0];
  // Checked rather than trusted, for lib/beadref.js's reason: this string is
  // interpolated into a regex, and a prefix is a short word by construction.
  return /^[a-z0-9]{1,10}$/i.test(prefix) ? prefix.toLowerCase() : null;
}

/**
 * Every bead id this text names, in the order it names them, without repeats.
 *
 * The dotted tail is the part lib/beadref.js's pattern deliberately does not have:
 * that one asks which bead a pull request is for and `bc-arj0` is a fine answer, but
 * "see also bc-rfnr.9.1" means the child and not the epic, and an edge to the wrong
 * end of a family is worse than no edge. A dot is only consumed when digits follow it,
 * so a sentence ending "…as in bc-arj0." yields `bc-arj0` rather than a broken id.
 */
export function mentionsIn(text, prefix) {
  if (!prefix) return [];
  const re = new RegExp(`\\b${prefix}-[a-z0-9]{2,10}(?:\\.\\d{1,3})*\\b`, 'gi');
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(re)) {
    const id = m[0].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Every field of a bead that holds prose, as one string.
 *
 * `bd export` carries four of the five — description, acceptance criteria, design and
 * notes — and the title as well, because a title naming another bead ("the same defect
 * as bc-767a") is the shortest and most deliberate mention there is. Comments are the
 * fifth and are not in the export; the sweep fetches them separately and passes them
 * in, which is why this takes them rather than reaching for them.
 */
export function proseOf(row, comments = []) {
  const parts = [
    row?.title,
    row?.description,
    row?.acceptance_criteria ?? row?.acceptance,
    row?.design,
    row?.notes,
    row?.close_reason,
    ...(Array.isArray(comments) ? comments.map((c) => (typeof c === 'string' ? c : c?.text)) : []),
  ];
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Which of the beads this prose names deserve an edge — the whole judgement, pure.
 *
 * `linked` is every id this bead already has an edge to, of any type and in either
 * direction. `known` answers "does this id exist": the sweep passes the whole
 * workspace's id set, and the write-time hook passes null, which means *do not filter*
 * — that path checks existence by letting bd refuse, because asking would cost a spawn
 * per mention and bd's refusal is free and authoritative.
 *
 * An id that does not exist is the one thing that must not reach a bulk `bd dep add
 * --file`: bulk wiring validates the whole batch and rejects **all** of it on the first
 * unresolvable id, so one typo in one description would silently cost a sweep of eight
 * hundred good edges. That asymmetry is the reason `known` exists at all.
 */
export function planFor({ id, prose, linked = [], known = null, cap = MENTION_CAP } = {}) {
  const self = String(id || '').toLowerCase();
  const prefix = prefixOf(self);
  if (!prefix) return [];
  const already = new Set([...linked].map((x) => String(x || '').toLowerCase()));
  const out = [];
  for (const mentioned of mentionsIn(prose, prefix)) {
    if (mentioned === self) continue;
    if (already.has(mentioned)) continue;
    if (known && !known.has(mentioned)) continue;
    already.add(mentioned);
    out.push(mentioned);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * One bead and its new neighbours → the rows `bd dep add --file` takes.
 *
 * Both directions, because that is what `bd dep relate` writes and what makes the edge
 * the same word from either end: bd stores a relate as two rows, and a sweep that wrote
 * one of them would leave half the pairs visible only from the side that happened to do
 * the mentioning — which is the side that already knew.
 */
export function edgeRows(id, ids) {
  const from = String(id || '').toLowerCase();
  return (ids || []).flatMap((to) => [
    { from, to, type: RELATED_EDGE },
    { from: to, to: from, type: RELATED_EDGE },
  ]);
}

/**
 * Every id this bead is already joined to, off `bd show --json`'s `dependencies[]`.
 *
 * Both ends of every edge type, deliberately. A parent naming its child in a paragraph,
 * a bead naming the bead it was discovered from, a delivery naming what it supersedes —
 * all of those are already in the graph with a type that says more than a see-also can,
 * and drawing one over the top would add a row saying less and make `bd show` print the
 * pair twice under two headings. So a pair with **any** edge is left alone, and a
 * `blocks` edge drawn from the other side counts as much as one drawn from this one:
 * `dependencies[]` on a `bd show` carries both ends, which is the same conflation that
 * makes bd's own counts untrustworthy (see lib/graph.js) and is exactly what is wanted
 * here. It is also what makes both passes idempotent — the second run sees the edges
 * the first drew and plans nothing.
 */
export function linkedIds(issue) {
  const rows = Array.isArray(issue?.dependencies) ? issue.dependencies.filter(Boolean) : [];
  const out = new Set();
  for (const r of rows) {
    for (const key of ['id', 'issue_id', 'depends_on_id']) {
      const v = String(r?.[key] || '').toLowerCase();
      if (v) out.add(v);
    }
  }
  out.delete(String(issue?.id || '').toLowerCase());
  return out;
}

/** Does this edge type mean "neither end is holding the other up"? */
export const isRelated = (type) => RELATED_EDGES.has(String(type ?? '').trim());
