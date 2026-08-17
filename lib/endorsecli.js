/**
 * Which of the beads named on a command line may be endorsed — decided before anything
 * is written, and separately from the writing.
 *
 * bc-7cp1. `bin/endorse.js` is the other door onto the verdict `/endorse` has always
 * had a button for: a session, in a checkout, with the bead in front of it, saying *yes,
 * work on this*. The daemon does the act (lib/verdict.js), the route is the only thing
 * that may take the marker off, and this file is the part that has to be right before
 * either of them is reached — the preflight, held here rather than in the CLI for the
 * reason `lib/mergeadmit.js` is not in `bin/merge.js`: a decision a person is going to
 * lean on should be a function with a test beside it, not prose interpreted at 03:00.
 *
 * ## Why there is a preflight at all
 *
 * `POST /api/bead/endorse` is already idempotent, already refuses a ship bead, and
 * already reports per-bead failures rather than losing a group to one bad id. So a CLI
 * could post the ids it was handed and print what came back, and it would be correct.
 *
 * What it would not be is *legible*, and legibility is the whole safety property here.
 * The incident this feature is written against is in lib/shipbead.js: one press of
 * "Endorse all" took the marker off twenty-five ship beads, and nothing in between said
 * which twenty-five. An endorsement is the step that makes unreviewed work dispatchable
 * — the next thing that happens is an unattended agent session — so the thing worth
 * building is not a faster endorse, it is one that **names every bead before it moves
 * it**. That needs the rows read first, which means a preflight, which means the
 * refusals may as well be made here where they can be explained.
 *
 * ## Refused whole, or not at all
 *
 * If any named bead is refused, nothing is posted. That is `verdictIds`' own rule in
 * lib/server.js — *a group where the sixth id is junk should be refused whole, not half
 * applied and then reported* — and it is stricter here on purpose: the ids came off a
 * command line one at a time, so a re-run without the bad one costs a line, where a
 * half-applied group costs somebody working out which half.
 *
 * ## What is a refusal and what is merely nothing to do
 *
 * The distinction is whether endorsing would be *wrong* or simply *already true*:
 *
 * - **Already endorsed** is nothing to do. The second tap of a double tap means the same
 *   as the first (see `endorseOne`), so a bead that is not held is reported and skipped,
 *   and a command naming three beads where one has already been endorsed still endorses
 *   the other two.
 * - **Closed and still held** is a refusal, and the reason is not obvious: the marker is
 *   deliberately *left on* a revoked bead so `bd list --label unendorsed` stays the
 *   honest history of what was filed and never worked (lib/verdict.js). Endorsing one
 *   erases that record and gains nothing, since nothing opens a session on a closed
 *   bead. Note this shape is common and is not always a revoke — a closed bead can carry
 *   the marker simply because a session working next door fixed the thing and closed it.
 * - **A ship bead** is a refusal, for lib/shipbead.js' reason: it is not a proposal,
 *   only a deploy closes one, and endorsing it means nothing. The route refuses it too;
 *   refusing it here is what makes the refusal say *why* rather than arrive as a row in
 *   a failure list.
 * - **No such bead** is a refusal, because an id that is gone is a typo, and the next
 *   thing a typo does on a shared tracker is endorse somebody else's bead.
 *
 * ## And what is only worth saying out loud
 *
 * Two things do not stop an endorsement and do change what it achieves, so they ride
 * along as notes rather than as refusals. A bead that also carries `human` stays out of
 * every advocate queue after the marker comes off, because `human` is in the same
 * `QUEUE_EXCLUDED` list; a bead bd calls `blocked` stays out of `bd ready` until its
 * dependencies close. In both cases the endorsement is real and the bead still will not
 * be picked up, and somebody who was not told that is somebody who comes back in an hour
 * asking why nothing started.
 */
import { UNENDORSED, isHeld } from './endorse.js';
import { SHIP_LABEL } from './shipbead.js';
import { MAX_IDS } from './verdict.js';

export { MAX_IDS };

const clean = (v) => String(v ?? '').trim();

/** Does this row carry that exact label? Exact, never `startsWith` — see `promote`/`promoted`. */
const carries = (row, label) => (row?.labels || []).some((l) => clean(l) === label);

/**
 * The ids as they will be acted on: trimmed, de-duplicated, order preserved.
 *
 * The same normalisation `parseIds` does on the wire, applied here so that "three ids,
 * two of them the same" is reported as the two beads it is rather than endorsed twice
 * and counted as three.
 */
export const normalizeIds = (list) => [...new Set((list || []).map(clean).filter(Boolean))];

/**
 * Why a list of ids cannot be acted on at all, or `''`.
 *
 * `MAX_IDS` is the route's own limit and is repeated rather than discovered, so a group
 * of two hundred is refused by the thing that can name the beads instead of by an HTTP
 * 400 that names none of them.
 */
export function idsProblem(ids) {
  if (!ids.length) return 'name at least one bead to endorse';
  if (ids.length > MAX_IDS) return `${ids.length} beads in one endorse — ${MAX_IDS} is the most`;
  return '';
}

/** Things true of a bead that survive the endorsement and change what it achieves. */
function notesFor(row) {
  const notes = [];
  if (carries(row, 'human')) {
    notes.push('also carries `human`, which is in the same queue exclusion — no advocate will pick it up while that is on');
  }
  if (clean(row?.status) === 'blocked') {
    notes.push('bd calls it blocked, so it stays out of `bd ready` until what it depends on closes');
  }
  return notes;
}

/**
 * The plan: what to post, what is already done, and what is refused and why.
 *
 * `rows` is whatever the tracker answered for those ids, in any order and possibly short
 * — `bd show a b c` prints the ones it found and complains on stderr about the ones it
 * did not, so an id with no row is the tracker saying it has never heard of it.
 *
 * Nothing here writes, asks or throws. Given the same rows it gives the same plan, which
 * is what makes the refusals testable without a tracker.
 */
export function endorsePlan(rows, ids) {
  const byId = new Map((Array.isArray(rows) ? rows : []).filter(Boolean).map((r) => [clean(r.id), r]));
  const post = [];
  const already = [];
  const refused = [];

  for (const id of normalizeIds(ids)) {
    const row = byId.get(id);
    if (!row) {
      refused.push({ id, title: '', code: 'missing', why: 'the tracker has no bead by that id' });
      continue;
    }
    const title = clean(row.title);
    const held = isHeld(row);
    const closed = clean(row.status) === 'closed';

    if (carries(row, SHIP_LABEL)) {
      refused.push({
        id,
        title,
        code: 'ship',
        why: `it is a \`${SHIP_LABEL}\` bead — not a proposal, and only a deploy closes one, so endorsing it means nothing`,
      });
      continue;
    }
    if (closed && held) {
      refused.push({
        id,
        title,
        code: 'closed',
        why: `it is closed, and the \`${UNENDORSED}\` marker on a closed bead is the record that it was never worked — taking it off erases that and starts nothing`,
      });
      continue;
    }
    if (!held) {
      already.push({ id, title, closed, why: closed ? 'already endorsed, and closed' : 'already endorsed' });
      continue;
    }
    post.push({ id, title, notes: notesFor(row) });
  }

  return { post, already, refused, ok: refused.length === 0 };
}

/**
 * What the API said, lined up against what was asked — because the two can differ.
 *
 * A row that came back `endorsed: false` is a bead that lost its marker between the
 * preflight and the post, which is not an error and is worth saying: on a tracker a
 * dozen sessions share, "somebody else got there first" is the ordinary explanation and
 * the alarming-sounding one.
 */
export function readResult(body, plan) {
  const results = Array.isArray(body?.results) ? body.results : [];
  const asked = new Map(plan.post.map((p) => [p.id, p]));
  const rows = results.map((r) => ({
    id: clean(r.id),
    title: clean(r.title) || asked.get(clean(r.id))?.title || '',
    ok: Boolean(r.ok),
    // `endorsed` is the write, `ok` is the call — a bead already endorsed is ok and false.
    endorsed: Boolean(r.ok && r.endorsed),
    error: clean(r.error),
  }));
  return {
    rows,
    moved: rows.filter((r) => r.endorsed),
    raced: rows.filter((r) => r.ok && !r.endorsed),
    failed: rows.filter((r) => !r.ok),
  };
}
