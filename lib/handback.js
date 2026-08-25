/**
 * End a run that delivered nothing — put the bead back the one way the next tick
 * expects, instead of the four different ways bc-36xx.24, bc-ogicx.1, bc-zjab.10 and
 * bc-khoe.30.9 each did it by hand.
 *
 * All four wrote a comment and then reached for a different second and third step:
 * `bd unclaim` (assignee cleared, status never touched), `bd update --status=open` with
 * no unclaim (status set, assignee left on — the exact state lib/promoterun.js's own
 * comment calls "a holder"), the same in one call with no readback at all, and one that
 * stopped after `--status=open` and left the next session to run `--claim` again before
 * it could even start. Two of the four ended in a state their own log line claimed was
 * the opposite of. `Bd.reopenAbandoned` (lib/bd.js) already exists to be the single
 * house call for this — `--status open --assignee ''`, forced only when the plain write
 * is refused for holding a claim beadcause never had under its own name — and none of
 * the four called it.
 *
 * `handback` below is that call, plus the two things none of the four sessions did:
 * **refuse before writing** when the ask does not make sense (a closed bead has nothing
 * to hand back; `--human` on a bead that is not a decision is bc-ogicx.1's own label
 * pinned to a case it cannot mean), and **read the state back** rather than trust the
 * write — bc-ogicx.1's own `bd show` at the end of that session still carried an owner,
 * which its comment did not say. A caller that gets `ok: false` back has a bead that is
 * *not* open-and-unassigned no matter what got written on the way there, same discipline
 * as `bin/deliver.js` refusing to claim a merge it never saw.
 *
 * Takes a `Bd`-shaped object (`show`, `comment`, `reopenAbandoned`, `addLabel` — the
 * real class from lib/bd.js in production, a stub in a unit test) rather than a raw
 * `bd(...)` exec wrapper the way lib/farblock.js's `mark` does, because the whole point
 * of reusing `reopenAbandoned` is its retry-then-force logic — reimplementing that here
 * against a bare exec function is exactly the drift this module exists to stop.
 */

/** The three shapes a run without a delivery has actually ended in, so far. Advisory
 * only — nothing here changes for one value over another except the comment's own
 * header, so a caller unsure which one applies loses nothing by picking the closest. */
export const WHY_VALUES = ['timeout', 'handback', 'blocked'];

const DECISION_TYPE = 'decision';

function typeOf(row) {
  return String(row?.issue_type || row?.type || '').toLowerCase();
}

function stateLine(row) {
  if (!row) return 'gone — a bead this id no longer names';
  const status = String(row.status || 'unknown');
  const assignee = String(row.assignee || '').trim();
  return assignee ? `${status}, still held by ${assignee}` : status;
}

/**
 * Write the hand-back, then read it back. Returns:
 *
 *   - `refused` — set and nothing written, when the ask itself does not make sense.
 *   - `wrote` — one string per write actually made, in order, so a caller can tell a
 *     refusal after some writes (the readback disagreed) from a refusal before any.
 *   - `row` — the bead as read back after every write, not assumed from the arguments.
 *   - `ok` — `row` is open and unassigned. `false` with `wrote.length` non-zero is the
 *     case none of the four hand sessions checked for: something landed, but not the
 *     whole of it.
 */
export async function handback(bd, ws, id, { note, why = null, human = false } = {}) {
  const out = { refused: '', wrote: [], row: null, ok: false };
  const beadId = String(id || '').trim();
  const text = String(note || '').trim();

  if (!beadId) return { ...out, refused: 'a bead id is required' };
  if (!text) {
    return { ...out, refused: `pipe or point --note at the note for ${beadId} — nothing was written without it` };
  }
  if (why !== null && !WHY_VALUES.includes(why)) {
    return { ...out, refused: `--why must be one of ${WHY_VALUES.join(', ')}, not "${why}"` };
  }

  let row;
  try {
    row = await bd.show(ws, beadId);
  } catch (err) {
    return { ...out, refused: `${ws?.name || 'that workspace'} has no bead ${beadId}: ${String(err?.message || err).split('\n')[0]}` };
  }
  if (!row) return { ...out, refused: `${ws?.name || 'that workspace'} has no bead ${beadId}` };
  if (String(row.status || '').toLowerCase() === 'closed') {
    return { ...out, refused: `${beadId} is already closed — there is nothing left to hand back` };
  }
  if (human && typeOf(row) !== DECISION_TYPE) {
    return {
      ...out,
      refused: `--human is for a decision bead; ${beadId} is type "${typeOf(row) || 'unknown'}" — the human label belongs on the decision, not the work under it`,
    };
  }

  const commentText = why ? `Handing back (${why}): ${text}` : text;
  await bd.comment(ws, beadId, commentText);
  out.wrote.push('comment');

  await bd.reopenAbandoned(ws, beadId);
  out.wrote.push('status open, assignee cleared');

  if (human) {
    await bd.addLabel(ws, beadId, 'human');
    out.wrote.push('label human');
  }

  const after = await bd.show(ws, beadId);
  out.row = after;
  out.ok = Boolean(after) && String(after.status || '').toLowerCase() === 'open' && !String(after.assignee || '').trim();
  if (!out.ok) {
    out.refused = `${beadId} reads back as ${stateLine(after)} — not handed back`;
  }
  return out;
}

/** The printed report `bin/b7e-handback` builds from a `handback()` result. */
export function describeHandback(beadId, result) {
  const lines = [];
  if (result.refused && result.wrote.length === 0) {
    lines.push(`b7e-handback ${beadId}: refused — ${result.refused}`);
    return lines;
  }
  lines.push(`b7e-handback ${beadId}:`);
  for (const w of result.wrote) lines.push(`  wrote: ${w}`);
  lines.push(`  now: ${stateLine(result.row)}`);
  if (!result.ok) lines.push(`  ${result.refused}`);
  return lines;
}
