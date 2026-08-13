/**
 * Who owns a P0 — the one label that answers "what am I answerable for".
 *
 * **Not lib/owner.js, and the two names are worth keeping apart.** That file answers
 * *whose beadcause this is* — one string in config.json, the name every agent prompt says
 * out loud, and there is exactly one of it per install. This file answers *whose bead is
 * this*, which is a per-bead fact on a graph six people share, and on a single-person Mac
 * the two happen to name the same human — which is precisely why they would be merged by
 * accident and why the merge would only break on the day federation made them differ.
 * `ownerName(cfg)` is the service owner; `ownerOf(issue)` is who took this P0.
 *
 * **The failure this exists for.** The tracker is 132 live beads and one of them says
 * whose problem it is, by accident: `assignee`, which is whatever the last agent to run
 * `bd update --claim` wrote there. Nothing on the phone says which P0 is yours, so the
 * inbox sorts by urgency and hopes; and `bd list` on a second Mac cannot answer the
 * question at all, because the field it would have to read is a record of who is *doing*
 * it rather than who is answerable for it. Those are different questions and only one of
 * them survives an agent picking the work up.
 *
 * **The assignee cell cannot carry this, and the reason is mechanical rather than
 * aesthetic.** Three things write it and all three are the machinery working as intended:
 * `bd update --claim` sets it when a worker starts, `Bd.reopen` in lib/bd.js clears it
 * (`--assignee ''`) so the advocate can see the bead again, and `applyVerdict` moves the
 * bead through states that do both. An owner recorded there is erased by the first
 * session that touches the bead, which is precisely when you most want to know whose it
 * was. And on six Macs sharing one Dolt tracker a *cell* is a genuine write conflict —
 * two machines, two values, one of them lost — where a label is simply a second row and
 * after a sync both machines can see both. That argument is not new here; it is the one
 * lib/lease.js already makes for `held:<stamp>:<handle>`, and this file is the same
 * mechanism aimed at a slower-moving fact.
 *
 * So ownership is `owner:<handle>`, and the handle vocabulary is deliberately not a new
 * one — `meHandles` and `normalizeHandle` come from lib/addressee.js, so the string that
 * addresses a question to you is the same string that says you own a P0. Two spellings
 * of one person is the bug that makes `bd list --label owner:<handle>` quietly wrong.
 *
 * **A Mac that does not know who it is writes nothing.** `cfg.me` is unset by default,
 * `ownOwnerLabels` is `[]` with it unset, and every bead this daemon files is then
 * byte-for-byte the bead it filed before this existed. That is the same guarantee
 * lib/addressee.js and lib/lease.js make, out of the same setting, and it is a branch
 * that cannot be entered rather than a default that happens to be quiet.
 *
 * **An unowned P0 is a state, not an error.** Nothing here throws, nothing refuses, and
 * no queue is filtered on it. A P0 with no owner draws as unowned on the card and is
 * exactly what bc-rfnr.5's one-time triage exists to clear — and treating it as a fault
 * would mean the tracker was broken for as long as it took to run that once.
 */
import { meHandles, normalizeHandle } from './addressee.js';

/** The label prefix. `owner:adam@example.com`, and at most one is meaningful. */
export const OWNER_PREFIX = 'owner:';

/**
 * The priority that gets an owner. P0 and nothing else.
 *
 * A number rather than a string because that is what a `bd --json` row carries, and
 * named rather than inlined because three files ask the same question — the stamp in
 * lib/bd.js, the inbox's P0 section, and the gate that decides a bead has a P0 above it.
 * Three literal zeroes is three places for the answer to drift apart.
 */
export const P0 = 0;

/** Is this bead a P0? Takes a `bd --json` row, or anything with a `priority`. */
export const isP0 = (issue) => Number(issue?.priority) === P0;

/**
 * The label for a handle, or null when there is nothing to say.
 *
 * Null for an empty handle, for the reason lib/addressee.js returns null for one: a
 * bead owned by the empty string is a bead that answers `bd list --label owner:` and
 * nothing else, which is worse than an honestly unowned one.
 */
export function ownerLabel(handle) {
  const h = normalizeHandle(handle);
  return h ? `${OWNER_PREFIX}${h}` : null;
}

/**
 * Every owner handle on a bead, read off its labels. `[]` is unowned.
 *
 * A list, even though one owner is the whole point, because labels are rows and two
 * machines can write two of them before either syncs — exactly the collision lib/lease.js
 * resolves by string sort. Here the collision is far rarer and much less urgent, so it is
 * *reported* rather than resolved: `ownerOf` takes the first, and a card drawing two
 * owners is a truthful drawing of a bead two people claimed. Silently picking one and
 * hiding the other is how a tracker ends up lying about who is answerable.
 */
export function ownersOf(labels) {
  const out = [];
  for (const raw of Array.isArray(labels) ? labels : []) {
    const label = String(raw ?? '').trim();
    if (!label.toLowerCase().startsWith(OWNER_PREFIX)) continue;
    const handle = normalizeHandle(label.slice(OWNER_PREFIX.length));
    if (!handle || out.includes(handle)) continue;
    out.push(handle);
  }
  return out;
}

/** Is this label an ownership claim? What a label filter has to ask, one bead at a time. */
export const isOwnerLabel = (label) => ownersOf([label]).length > 0;

/** The owner of a bead, or null. Takes a `bd --json` row, or anything with `labels`. */
export const ownerOf = (issue) => ownersOf(issue?.labels)[0] || null;

/** Every owner on a bead — for a card that would rather show two than pick one. */
export const ownersOn = (issue) => ownersOf(issue?.labels);

/**
 * Is this bead owned by the person holding this Mac?
 *
 * False in all three of the ways it can be false, and they are worth keeping distinct
 * because only one of them is the feature working: this machine does not know who it is
 * (`me` unset — every install that has never heard of this), the bead names nobody, or
 * the bead names somebody else. The first is why an install with no `cfg.me` sees an
 * inbox with an empty P0 section rather than one full of other people's work.
 */
export function ownedByMe(cfg, issue) {
  const mine = meHandles(cfg);
  if (!mine.length) return false;
  return ownersOf(issue?.labels).some((h) => mine.includes(h));
}

/**
 * The owner label a bead filed *on this machine at P0* should carry, or `[]`.
 *
 * The half that makes this work without anybody typing anything, and it is
 * `ownAddresseeLabels`'s argument with one word changed: the daemon reading a shared
 * graph cannot tell whose session filed a bead — `created_by` is the literal string
 * `beadcause` on every machine — so ownership cannot be derived at read time. The
 * machine doing the writing knows, so it says so at write time and the label rides the
 * sync to the other five.
 *
 * Only the first handle, for `ownAddresseeLabels`' reason: `me` is a list because one
 * person answers to two addresses, and a P0 owned by both of them is no more owned and
 * reads on the card as if two people had taken it.
 */
export function ownOwnerLabels(cfg) {
  const label = ownerLabel(meHandles(cfg)[0]);
  return label ? [label] : [];
}

/**
 * What to add and what to take off to move a bead's owner — the whole of a change.
 *
 * Returned as a pair rather than applied, because the caller that has a `bd` handle is
 * not the caller that knows what the phone asked for, and because a no-op has to be
 * visible as one: setting the owner a bead already has is `{ addLabels: [],
 * removeLabels: [] }`, and `Bd.update` with nothing in it runs no `bd` at all. A phone
 * that posts the whole sheet on every save then costs one `bd show` and no write.
 *
 * **Every existing owner label comes off, not just the ones that disagree.** Ownership is
 * a single fact and the only way a bead has two is that two machines wrote before either
 * synced (see `ownersOf`); somebody resolving that from the sheet means *this handle,
 * not the others*, and leaving the losers on would make the resolution invisible.
 *
 * A null or empty handle is "nobody owns this" and is a legitimate thing to say — it is
 * how a P0 filed against the wrong person gets handed back to the triage that assigns it.
 */
export function ownerUpdate(issue, handle) {
  const want = ownerLabel(handle);
  const current = (issue?.labels || []).map((l) => String(l ?? '').trim()).filter(isOwnerLabel);
  return {
    addLabels: want && !current.includes(want) ? [want] : [],
    removeLabels: current.filter((l) => l !== want),
  };
}
