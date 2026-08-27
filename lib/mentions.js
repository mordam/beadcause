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

/**
 * The same cap for a single write — and it is much lower, because somebody is waiting.
 *
 * The sweep is an attended batch run: forty edges on one bead costs it a minute and
 * nobody is watching. The hook runs inside `bd.respond`, which is what a **tap on a
 * phone** runs, awaited on the request path — and a `bd dep relate` is about a second
 * and a half. At forty that is a minute of somebody holding a phone waiting for an
 * answer to be recorded that was already recorded before the first edge was drawn.
 *
 * Eight is well clear of what any one write actually produces. Over the whole of this
 * workspace's prose the sweep plans 1,308 pairs across 554 beads — 2.4 apiece, and that
 * is a bead's *entire* history of descriptions, notes and comments rolled together. A
 * single comment past eight is a list somebody pasted, and the honest thing to do with
 * a pasted list is to take the first eight and stop.
 */
export const WRITE_CAP = 8;

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

/**
 * The edge type bd says is already there, out of the sentence it refuses a write with.
 *
 * bd holds **one row per ordered pair**, so a second type on the same pair is refused
 * rather than merged:
 *
 *     Error: dependency bc-a -> bc-b already exists with type "relates-to"
 *     (requested "blocks"); remove it first with 'bd dep remove' then re-add
 *
 * Measured against the bd on this machine on 2026-08-17, and the direction matters more
 * than it looks: the refusal is about `a -> b` and nothing else. `bd dep relate` writes
 * **two** rows, one at each end, so a see-also drawn from prose refuses a declared edge
 * from either side — but removing only the row bd named leaves the other half of the
 * relate standing, and the pair then holds a `blocks` one way and a `relates-to` the
 * other. That is why `Bd.addDep` demotes both ends rather than the one it was told
 * about, and why this returns only what bd claimed rather than a verdict about the pair.
 *
 * Null for anything that is not this refusal — a Dolt lock, a bead that does not exist,
 * a timeout — so a caller's `isRelated` check never turns an error it did not understand
 * into permission to delete an edge.
 */
export function refusedEdgeType(message) {
  const m = /already exists with type ["'“]?([a-z0-9_-]+)["'”]?/i.exec(String(message || ''));
  return m ? m[1].trim().toLowerCase() : null;
}

/**
 * Which rows have to come off before a declared edge can be written — the whole rule,
 * pure, and `null` for "it stands, let the refusal through".
 *
 * **A declared edge outranks a see-also, and never the other way round.** The two are
 * not the same kind of statement: `blocks` came from somebody deciding this work waits
 * on that work, and a `relates-to` came from a word appearing in a paragraph — this
 * module's own doing, and it says so at the top: *mentioned near*, nothing more. So on a
 * collision the mention gives way. The reverse is already impossible and stays that way
 * by a different mechanism: `planFor` skips any pair the graph already joins, so a
 * mention never draws over an edge somebody declared, and neither pass demotes anything.
 *
 * That asymmetry is why `refused` is checked rather than assumed. `discovered-from` is
 * the case that matters — provenance is an older fact than whatever wants the pair now,
 * and lib/adoptsweep.js refuses on it for exactly the same reason. Anything that is not
 * a see-also gets `null`, and the caller reports bd's refusal unchanged.
 *
 * **Both ends, when both ends are a mention.** `bd dep relate` writes two rows and bd
 * refuses per ordered pair, so dropping only the row bd named leaves the other half
 * standing and the pair ends up holding a `blocks` one way and a `relates-to` the other
 * — two rows saying different things about the same two beads, which `bd show` prints
 * under two headings. `reverse` is the type of the `to → from` row as bd has it, or null
 * where there is none; anything not a see-also is left exactly where it is.
 *
 * `refused` is the type out of bd's own sentence (`refusedEdgeType`) rather than
 * anything read back afterwards, which is what makes this safe under a race: bd named
 * the row it was looking at in the breath it refused, and a demotion decided on a
 * second read could act on an edge somebody has since replaced.
 */
export function demoteRows(from, to, { refused = null, reverse = null } = {}) {
  const a = String(from || '').toLowerCase();
  const b = String(to || '').toLowerCase();
  if (!a || !b || !isRelated(refused)) return null;
  const rows = [[a, b]];
  if (isRelated(reverse)) rows.push([b, a]);
  return rows;
}

/* ------------------------------------------- the same rule, synchronously (bc-arj0.23)
 *
 * `Bd.addDep` above is the funnel for every declared edge the **daemon** writes, and it
 * is `async` all the way down because everything around it is. Two writers are not in the
 * daemon at all: `park` in lib/park.js — `beadcause-ask --blocks`, `beadcause-propose
 * --kind conflict`, `beadcause-deliver` — and `mark` in lib/superseded.js. Both run in a
 * worker's terminal over a synchronous `(argv) => stdout` runner built on `execFileSync`,
 * one command, one bead, exit and gone. Neither could reach `Bd.addDep`, so neither
 * carried the precedence rule.
 *
 * Nothing reachable today hits it, which is why bc-arj0.20 left it: both writers create
 * the far end of the edge moments before drawing it, and neither creates it through
 * `relateMentions`, so no see-also can get there first. That stops being true the moment
 * the prose sweep runs on a timer (bc-arj0.10) or anything files a question through
 * `Bd.create` — and the cost of being wrong is not symmetric. `mark`'s fallback is a note:
 * the `superseded-by:` label holds the bead either way. `park`'s fallback is to label the
 * work bead `human`, which takes it out of every queue **and does not come off when the
 * question is answered** — so a collision there does not lose an edge, it strands a bead
 * until somebody goes back to it deliberately.
 *
 * The judgement is `demoteRows` and `refusedEdgeType` above, unchanged and shared. What
 * follows is only the synchronous plumbing around them, kept here rather than in either
 * caller because this module imports nothing: lib/bd.js imports lib/superseded.js, so a
 * helper living in lib/park.js — which imports lib/bd.js — would close a cycle.
 */

/**
 * bd's own sentence, wherever it chose to print it — the string a refusal is read out of.
 *
 * Measured on 2026-08-27: `execFileSync` with no `stdio` option populates `err.stderr`
 * **and** echoes it to the parent's stderr, so the refusal is both on the session's
 * screen and available to parse. `err.message` is only ever `Command failed: <argv>`, and
 * is joined in anyway for the runner that does not pipe — test/park.mjs's stub throws
 * `new Error(res.stderr)`, which is the same sentence arriving under a different key.
 * An argv cannot contain `already exists with type`, so joining all three is safe.
 */
export function refusalText(err) {
  if (!err) return '';
  return [err.stderr, err.stdout, err.message].map((x) => String(x || '').trim()).filter(Boolean).join('\n');
}

/**
 * The type of one edge, in one direction, through a synchronous runner — `Bd.edgeType`'s
 * twin, and the same three facts hold.
 *
 * `bd dep list <from> --json` is that bead's **outgoing** rows with `dependency_type` on
 * each; `--direction up` would be the other question and is not asked here. A trailing
 * `--actor`, which all four sync runners append to every call, is accepted (measured
 * 2026-08-27). `null` for a pair with no edge that way *and* for a read that failed — the
 * caller treats both as "nothing of mine to remove", which is the safe answer either way.
 *
 * `JSON.parse` rather than `parseJson` from lib/bd.js, for the cycle in the section
 * header. bd prints `--json` output on stdout with nothing around it.
 */
export function edgeTypeSync(bd, from, to) {
  let rows;
  try {
    rows = JSON.parse(String(bd(['dep', 'list', String(from), '--json']) || '').trim() || 'null');
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const want = String(to || '').toLowerCase();
  const row = rows.find((r) => String(r?.id || '').toLowerCase() === want);
  return row ? String(row.dependency_type || '').trim().toLowerCase() || null : null;
}

/** What the demotion did, in one sentence, for a terminal rather than a daemon log. */
export const demotedNote = (from, to, type) =>
  `took the \`${type}\` a prose mention drew off ${from} → ${to}, so the declared edge could go in`;

/**
 * `bd dep add <from> <to>` through a synchronous runner, with the precedence rule applied.
 *
 * Returns `{ out, demoted }` — `out` is whatever bd printed, `demoted` is `''` on the
 * ordinary path and the type that was dropped when one was. **Throws exactly what bd
 * threw** when there is nothing to be done, so a caller's existing `catch` keeps reporting
 * bd's own words: a refusal over `discovered-from`, `parent-child` or anything else that
 * is not a see-also stands, unchanged and unquoted-over, and so does a lock.
 *
 * One retry and no loop, the same as `Bd.addDep`: the second `dep add` is against a pair
 * this process has just emptied, and if bd refuses that one too then something else is
 * writing the same pair — a caller that kept trying would be racing it rather than fixing
 * anything. The drop is not caught for the same reason; if it fails, the retry would fail
 * behind it and the caller should hear about the first thing that went wrong.
 */
export function addDeclaredEdge(bd, from, to) {
  const argv = ['dep', 'add', String(from), String(to)];
  try {
    return { out: bd(argv), demoted: '' };
  } catch (err) {
    const refused = refusedEdgeType(refusalText(err));
    if (!isRelated(refused)) throw err;
    // The other half of the relate, read before anything is deleted: `bd dep relate`
    // writes both rows, but a pair can hold a mention one way and something older the
    // other, and that older row is not this write's to take.
    const reverse = edgeTypeSync(bd, to, from);
    const rows = demoteRows(from, to, { refused, reverse });
    if (!rows) throw err;
    for (const [a, b] of rows) bd(['dep', 'remove', a, b]);
    return { out: bd(argv), demoted: refused };
  }
}
