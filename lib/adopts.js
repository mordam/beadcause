/**
 * The `Adopts:` line — an epic naming the beads it claims, read by something at last.
 *
 * Seven epics on the bc graph wrote one unprompted, naming ninety beads between them,
 * and until 2026-08-13 `grep -rn 'Adopts' lib/ bin/ test/` returned nothing: it was
 * prose in a description, read by no code and by no agent that had not happened to
 * open that description. Six of the seven then closed on a pull request merge with
 * sixty of their adoptees still open, and the classification went with them —
 * bc-ka5y named twenty-three and closed as "Merged #212 as 72789c0b into main".
 *
 * So the convention is real, agents reach for it on their own, and the only thing
 * missing was a parser. This is it, and it is deliberately its own file rather than a
 * regex inside `Bd.gateFor`: two things want it and they are not in the same place.
 * The gate below it (lib/bd.js) refuses to close an epic over a list nothing applied,
 * and the applier bc-arj0.2 builds will reparent the named beads on the tick. One
 * parser or the gate and the applier disagree about what the line says, which is a
 * worse failure than either of them being absent — an epic held closed over an
 * adoption the applier does not think exists is unfixable from the phone.
 *
 * ## What counts as the list
 *
 * The shape every one of the seven wrote, unprompted and identically:
 *
 *     Adopts: bc-7utr, bc-04wd, bc-297u, bc-syzm, bc-izs0, bc-5orx, bc-jdwc,
 *     bc-ugd4, bc-tkq9, bc-stci, bc-nh19, bc-0fi2, bc-767a, bc-giuc.
 *
 *     bc-297u and bc-syzm are the same duplicate-`.chip` bug filed twice.
 *
 * A line beginning `Adopts:`, then ids separated by commas and newlines, ending at a
 * full stop. **The paragraph under it is prose that names beads too** — "bc-297u and
 * bc-syzm are the same duplicate" — and those are not adoptions, so the scan stops at
 * the first token that is not an id, a comma or the word `and`. bc-huk9 puts a
 * `**Verified …**` line directly under its list with no blank line between, which is
 * exactly that case: four adoptions, and the sha in the sentence below is not a fifth.
 *
 * Ids are matched by shape rather than against a prefix — `bc-`, `cl-`, `al-` and
 * whatever the next workspace calls itself — including the dotted children (`bc-arj0.3`),
 * because an epic adopting one is a thing that happens and dropping the suffix would
 * silently adopt its parent instead.
 */

/** A bead id as bd writes it: a short prefix, a slug, and any number of `.n` children. */
const ID = /^[a-z][a-z0-9]{0,7}-[a-z0-9]+(?:\.\d+)*$/i;

/** Ornament an id can pick up in prose — a trailing full stop, a bullet's backtick. */
const TRIM_LEFT = /^[(\[`*_"']+/;
const TRIM_RIGHT = /[.,;:)\]`*_"']+$/;

/**
 * Every bead id named by an `Adopts:` line in this text, lowercased and deduplicated.
 *
 * Text with no such line answers `[]`, which is the ordinary case: only an epic writes
 * one, and most epics have not.
 *
 * More than one `Adopts:` line is read as one list. Nothing writes two today, but a
 * description edited twice easily could, and taking only the first would drop the half
 * somebody added most recently — the opposite of what an editor meant by adding it.
 */
export function adoptedIds(text) {
  const src = String(text || '');
  if (!src) return [];
  const out = [];
  const seen = new Set();

  // `^` per line rather than anywhere, so "this epic adopts: nothing" mid-sentence is
  // prose and not a list. Leading whitespace and a markdown bullet are allowed, because
  // a list under a heading is written that way as often as not.
  const heads = /^[^\S\n]*(?:[-*+][^\S\n]+)?adopts:[^\S\n]*/gim;
  let head;
  while ((head = heads.exec(src))) {
    let rest = src.slice(heads.lastIndex);
    // A blank line ends the list whatever else is going on, so a stray id in the next
    // paragraph cannot be swept in by a list that forgot its full stop.
    const para = rest.search(/\n[^\S\n]*\n/);
    if (para >= 0) rest = rest.slice(0, para);

    for (const raw of rest.split(/[\s,]+/)) {
      const tok = raw.replace(TRIM_LEFT, '').replace(TRIM_RIGHT, '');
      if (!tok) continue;
      // The one connective the seven actually wrote — "bc-a, bc-b and bc-c".
      if (tok.toLowerCase() === 'and') continue;
      // Anything else that is not an id is the prose under the list, and everything
      // after it belongs to that sentence rather than to the adoption.
      if (!ID.test(tok)) break;
      const id = tok.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    // `lastIndex` is where the head ended, not where the list did. Leaving it there is
    // right: the next `exec` searches the list's own text for another `Adopts:` line,
    // finds none, and carries on past it.
  }
  return out;
}

/**
 * The same, for an issue as `bd show --json` hands it over.
 *
 * Four fields are read, because the line is written whereever the agent was typing.
 * All seven of the real ones are in `description`; `notes` is where a later pass adds
 * one, and both of the others are cheap to include and would be baffling to exclude —
 * an adoption written into the acceptance criteria is still an adoption, and a gate
 * that ignored it would be refusing to see a line the author can plainly read.
 */
export function adoptedBy(issue) {
  if (!issue) return [];
  const text = ['description', 'notes', 'design', 'acceptance_criteria']
    .map((k) => issue[k] || '')
    .filter(Boolean)
    .join('\n\n');
  // An epic naming itself is a typo, not a cycle worth reporting: drop it here so the
  // gate cannot hold a bead open against its own id.
  const self = String(issue.id || '').toLowerCase();
  return adoptedIds(text).filter((id) => id !== self);
}
