/**
 * Where a bead nobody gave a parent lands — the other half of lib/underp0.js.
 *
 * bc-rfnr.8. That file is the rule: a bead that is not a P0 and has no P0 above it is
 * not workable, no advocate queues it and no launcher opens a session on it. This one
 * is what stops the daemon filing beads that are born failing it.
 *
 * **The failure, and why the pill is not enough.** A live sweep on the day bc-rfnr.7
 * landed found four cards from lib/notinmain.js — "never reached main, and <bead> is
 * closed over it" — sitting parentless, and they had to be adopted by hand before the
 * gate could be switched on. The next sweep files another one in exactly the same
 * state, and so does anything else that files without a parent. Two things are wrong
 * with such a bead and only one of them is on the agents screen:
 *
 * 1. It is **held**, which the advocate says out loud — a log line, a bus event and a
 *    `no P0 above this` pill on its card (lib/underp0.js).
 * 2. It is **invisible**, which nothing says at all. bc-rfnr.2's inbox draws only what
 *    descends from a P0 you own (`underOwnedP0s` in public/app.js), so a `human` card
 *    filed with no parent is not on the phone — and a `human` card is a *question*. The
 *    whole of this app is the promise that a question cannot be lost, and a card the
 *    daemon writes to a screen that will not draw it is that promise broken from
 *    inside. This is the half a pill on the agents screen cannot reach.
 *
 * ## What was decided
 *
 * bc-rfnr.8 offered three ways and asked for one rather than a patch at one caller:
 * parent at the filing seam, adopt orphans into the unsorted-backlog P0, or leave it as
 * something you tidy. The third fails (2) above. The first two are not alternatives —
 * they are the two arms of one answer, and this file is both:
 *
 * **The home is the P0 the *discovering* bead descends from — not the discovering bead
 * itself.** `from` is already on every agent-filed bead as a `discovered-from` edge, so
 * the daemon almost always knows which work turned this up; what it must not do is turn
 * that edge into a parent link. Two reasons, and the second is the one that bites:
 *
 * - lib/ancestry.js is explicit that a `discovered-from` trail must not pull a bead into
 *   a P0's descendants, because lib/filing.js puts one on everything an agent has ever
 *   filed. Writing the same relationship a second time as a `parent-child` edge is that
 *   rule defeated by the file it was written against.
 * - A task closes. bc-rfnr.7's own comment names the recurring shape — an open child of
 *   a non-P0 parent that has since closed is under nothing, is not parentless by any
 *   obvious query, and is held forever. Parenting every discovery under the task that
 *   found it would *manufacture* that shape on a schedule. A P0 closing is the end of an
 *   epic, which is the honest moment for what hangs off it to stop being work.
 *
 * **When there is no such P0, the unsorted-backlog P0 adopts it**, found by the
 * `unsorted` label on an open P0 rather than by an id in config. A label for
 * lib/ownership.js's reason: config.json is per-Mac and this graph is shared, so an id
 * in a settings file would name a different bead — or nothing — on the second machine,
 * and the whole point is that a bead lands somewhere real on whichever machine filed it.
 *
 * **Nothing here refuses, and nothing here falls back to a *wrong* home.** No `from`, a
 * `from` under nothing itself, no unsorted P0, a graph that could not be read: the
 * answer is no parent, which is exactly the bead that would have been filed before this
 * existed. The pill and the sheet's adopt control (public/graph.js) are still there for
 * that bead. Fail-open is lib/underp0.js's decision and this inherits it wholesale — a
 * filing seam that threw would turn a Dolt lock race into a discovery nobody kept.
 */
import { ancestorsOf } from './ancestry.js';
import { p0RootsOf } from './underp0.js';

/**
 * The label on the P0 that adopts what has no home. One spelling, and it is a label.
 *
 * `unsorted` rather than `catchall` because the tracker already distinguishes the two and
 * only one of them is this: the unsorted backlog is where a bead goes when *nobody has
 * decided* where it goes, and the answer to a bead sitting in it is usually "file this
 * under the epic it actually belongs to". That is precisely the state a bead the daemon
 * filed unattended is in. A catchall for work that has been looked at and genuinely has
 * no other home is a different pile, and one that filled itself automatically would stop
 * being it.
 */
export const UNSORTED_LABEL = 'unsorted';

/**
 * The P0 this bead descends from, or null — `hasP0Above` answering *which*.
 *
 * A P0 is above itself, matching lib/underp0.js, so asking this of a P0 answers the P0.
 * The nearest one wins on the vanishingly rare graph that has two in one line.
 */
export function p0Over(index, id) {
  const key = String(id || '').trim();
  if (!key) return null;
  const roots = p0RootsOf(index?.beads);
  if (!roots.size) return null;
  return [key, ...ancestorsOf(index?.parents, key)].find((step) => roots.has(step)) || null;
}

/**
 * The open P0 that adopts orphans, or null.
 *
 * **Two of them is not an error here.** Labels are rows on a graph several machines write
 * to (lib/ownership.js makes the same argument for `owner:`), so a second one can exist
 * without anybody having decided anything. Sorting and taking the first makes every
 * machine pick the same one until somebody takes the label off, which is a duplicate you
 * can find rather than two daemons quietly filing into different piles.
 */
export function unsortedP0(index) {
  const found = [];
  for (const id of p0RootsOf(index?.beads)) {
    const bead = index?.beads?.get?.(id);
    if ((bead?.labels || []).some((l) => String(l).trim().toLowerCase() === UNSORTED_LABEL)) found.push(id);
  }
  return found.sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }))[0] || null;
}

/**
 * Where this bead should land, over an index already in hand. `{ parent, why, gated }`.
 *
 * `parent` is `''` when there is no honest answer, and `why` is the phrase a log line or
 * a provenance note prints — empty in that case too, because "could not find a home" is
 * the caller's fact to report and not this function's opinion.
 *
 * **`gated` is what stops a caller lying on the way out.** With no parent found, whether
 * the bead is actually held depends on something this answer does not otherwise carry:
 * `hasP0Above` fails *open* on a workspace with no open P0 at all, so on a tracker that
 * has never raised one — or one whose export could not be read — a parentless bead is
 * perfectly workable. A warning saying "nothing will work this until you adopt it under
 * a P0" would then be a false claim printed at every single filing, which is a worse
 * failure than the silence it replaced. True means there are roots and the gate is live.
 *
 * An explicit `parent` always wins and is handed straight back. A caller that named one
 * has decided something; this file exists for the callers that have not.
 */
export function homeFor(index, { parent = '', from = '' } = {}) {
  const gated = p0RootsOf(index?.beads).size > 0;
  const named = String(parent || '').trim();
  if (named) return { parent: named, why: '', gated };

  const overFrom = p0Over(index, from);
  if (overFrom) return { parent: overFrom, why: `${overFrom}, the P0 ${String(from).trim()} belongs to`, gated };

  const unsorted = unsortedP0(index);
  if (unsorted) return { parent: unsorted, why: `${unsorted}, the unsorted backlog`, gated };

  return { parent: '', why: '', gated };
}

/**
 * The same question, over a tracker. Never throws, and `''` is a complete answer.
 *
 * `wait: true` (the default) where the inbox's own sweep uses `wait: false`, and for
 * `assertUnderP0`'s reason: this is on a write path, once per bead filed, and a caller
 * about to create a row that outlives the process can afford ~1.3s to put it in the
 * right place. The request path cannot, which is why the two disagree on purpose.
 *
 * A caller with no `bd`, or one whose workspace could not be exported, gets `''` — the
 * bead is filed exactly as it would have been before this existed. See the header.
 */
export async function homeIn(bd, workspace, { parent = '', from = '' } = {}) {
  const named = String(parent || '').trim();
  if (named) return { parent: named, why: '', gated: false };
  if (typeof bd?.graph !== 'function') return { parent: '', why: '', gated: false };
  try {
    return homeFor(await bd.graph(workspace), { from });
  } catch {
    return { parent: '', why: '', gated: false };
  }
}
