/**
 * Who a question is *for* — and how one Mac works out that a question is not for it.
 *
 * **The failure this exists for.** Every push in lib/notify.js goes to one ntfy topic
 * and the inbox is one list, filtered only by space and workspace. On one Mac that is
 * correct: there is one person, and every question is theirs. On six Macs sharing a
 * tracker it is the same code doing something quite different — six daemons each read
 * the whole graph, each see every new `human` bead, and each independently buzz their
 * own phone about it. One question rings six phones and five of those people cannot act
 * on it. The fan-out did not appear with federation; it moved, from inside one process
 * to across six.
 *
 * **Space and workspace are not a substitute, and this is not a third level of them.**
 * Those two answer *which of my lives is this about*. This answers *whose decision is
 * this*, which is a different question with a different answer: two engineers on the
 * same repo want the same space, the same workspace, and different questions out of it.
 *
 * **The addressee is on the bead, in the shared graph — never in a daemon's local
 * state.** That is forced by federation rather than chosen: each Mac has to work out on
 * its own that a given question is not for the person holding it, and the tracker is the
 * only thing all six machines agree about. So it is a label, `for:<handle>`, which every
 * bd client can read, which survives a sync, and which is visible in `bd show` on any
 * machine. A bead may carry more than one.
 *
 * **Unaddressed means everyone, and that is today's behaviour.** No label, no addressee,
 * every phone rings — which is exactly what a single-person install has always done and
 * must keep doing. `for:everyone` says the same thing out loud, for a question filed
 * from a machine that would otherwise have stamped its own person on it.
 *
 * **And a Mac that does not know who it is is everybody.** `cfg.me` is unset by default,
 * and with it unset `addressedElsewhere` is false for every bead there has ever been: no
 * label can be *somebody else's* until this machine can say who it is. That is the whole
 * of the guarantee that a single-person install is byte-for-byte unchanged — not a
 * default that happens to be quiet, but a branch that cannot be entered.
 *
 * **Nothing is ever dropped.** The answer here feeds `quietReasonFor` in lib/spaces.js
 * as a third reason alongside `filtered` and `muted`, and it inherits that contract
 * exactly: the event is still emitted, the card still files, the badge still counts, the
 * inbox still shows it to everybody. The phone just stays dark. A question that reached
 * the wrong person is an annoyance; a question that reached nobody is the failure this
 * whole app exists to prevent, and an addressee that could lose one would not be worth
 * having.
 */

/** The label prefix. `for:adam@example.com`, and repeatable. */
export const ADDRESSEE_PREFIX = 'for:';

/**
 * Handles that mean "not addressed at all", written on the bead on purpose.
 *
 * A question genuinely for whoever is free needs a way to say so, because the asking
 * machine stamps its own person on anything that does not (see `bin/ask.js`). Without
 * this the only way back to "everyone" would be to leave the flag off and hope no
 * default had been configured, which is not a thing a session can check.
 */
const EVERYONE = new Set(['everyone', 'anyone', 'all', 'any', '*']);

/** Lowercased and squeezed. Addresses are case-insensitive and labels are strings. */
export function normalizeHandle(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

/**
 * The label for a handle, or null when there is nothing to say.
 *
 * Null for an empty handle and null for `everyone` — the second is the interesting one:
 * "this is for everybody" is the *absence* of an addressee, so writing it as a label
 * would be a second spelling of the default that every reader would then have to know
 * about. It is a word you may type, never a label a bead ends up carrying.
 */
export function addresseeLabel(handle) {
  const h = normalizeHandle(handle);
  if (!h || EVERYONE.has(h)) return null;
  return `${ADDRESSEE_PREFIX}${h}`;
}

/**
 * Every handle a bead is addressed to, read off its labels. `[]` is unaddressed.
 *
 * `for:` with nothing after it is dropped rather than read as a handle nobody has: a
 * bead addressed to the empty string is a bead that is silent on every machine at once,
 * which is the one outcome this file exists to make unreachable.
 */
export function addresseesOf(labels) {
  const out = [];
  for (const raw of Array.isArray(labels) ? labels : []) {
    const label = String(raw ?? '').trim();
    if (!label.toLowerCase().startsWith(ADDRESSEE_PREFIX)) continue;
    const handle = normalizeHandle(label.slice(ADDRESSEE_PREFIX.length));
    // `for:everyone` is read as what it means rather than as a handle, so a machine
    // configured as `everyone` could not quietly become the addressee of everything.
    if (!handle || EVERYONE.has(handle)) continue;
    if (!out.includes(handle)) out.push(handle);
  }
  return out;
}

/**
 * The handles this Mac's person answers to. `[]` when nobody has said.
 *
 * A list rather than one string because one person is routinely two identities in the
 * same graph — a work address on the commits at the office and a personal one on
 * everything else — and a question addressed to either of them is theirs.
 */
export function meHandles(cfg) {
  const raw = cfg?.me;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const v of list) {
    const h = normalizeHandle(v);
    // `me: "everyone"` would make this machine the addressee of every bead in the
    // graph, including the ones addressed to somebody else. It is a word about beads,
    // not a name anybody has.
    if (!h || EVERYONE.has(h) || out.includes(h)) continue;
    out.push(h);
  }
  return out;
}

/**
 * The handles on a question, wherever it came from.
 *
 * A built question carries `addressees` (`toQuestion` in lib/decision.js reads them once
 * per sweep); a raw `bd` row carries `labels` and nothing else. Both are handed to the
 * push path in practice, and neither caller should have to know which shape it is
 * holding.
 */
export function addresseesOn(q) {
  if (Array.isArray(q?.addressees)) return q.addressees.map(normalizeHandle).filter(Boolean);
  return addresseesOf(q?.labels);
}

/**
 * Is this bead addressed, and to somebody who is not this Mac?
 *
 * The one question the push path asks. False in all three of the ways it can be false,
 * and they are worth keeping distinct because only one of them is the feature working:
 * this machine does not know who it is (`me` unset — every install that has never heard
 * of this), the bead names nobody, or the bead names me among whoever else it names.
 */
export function addressedElsewhere(cfg, q) {
  const mine = meHandles(cfg);
  if (!mine.length) return false;
  const to = addresseesOn(q);
  if (!to.length) return false;
  return !to.some((h) => mine.includes(h));
}

/**
 * The labels a question filed *on this machine* should carry, or `[]`.
 *
 * The other half of the feature, and the half that makes it work without anybody
 * typing anything. The daemon reading a shared graph cannot tell whose session filed a
 * bead from `created_by`: it is `cfg.actor`, which is the literal string `beadcause`
 * until this machine sets `me` and `beadcause (carol@example.com)` afterwards
 * (lib/byline.js). Even then it is the wrong thing to route on — bare on every bead
 * filed before it existed, and a field an agent can write anything into. So the
 * addressee is not derived at read time. The machine doing the *asking* knows, so it
 * says so at write time, and the label rides the sync to the other five.
 *
 * Only the first handle. `me` is a list because one person answers to two addresses;
 * a question addressed to both of them would be no more theirs and would read on the
 * card as if two people had been asked.
 *
 * `[]` when `me` is unset, which is every install that has never heard of this: no
 * label, and a bead identical to the one filed before this existed.
 */
export function ownAddresseeLabels(cfg) {
  const label = addresseeLabel(meHandles(cfg)[0]);
  return label ? [label] : [];
}

/**
 * Is this label an addressee stamp? What a label filter has to ask, one label at a time.
 *
 * `for:everyone` answers **true** here and yields no handle in `addresseesOf`, which
 * looks like a disagreement and is not: the two are asked different questions. This one
 * is "does this string belong to the addressee vocabulary" — and a `for:everyone`
 * somebody typed does, so a rewrite that must not touch the addressing leaves it alone
 * rather than treating it as an ordinary label it is free to drop.
 */
export const isAddresseeLabel = (label) =>
  String(label ?? '')
    .trim()
    .toLowerCase()
    .startsWith(ADDRESSEE_PREFIX);

/**
 * What to add and what to take off to hand a question to somebody else — the whole of a
 * change, as a pair.
 *
 * `ownerUpdate` in lib/ownership.js with one word changed, and deliberately the same
 * shape for the same three reasons. Returned rather than applied, because the caller
 * holding a `bd` handle is not the caller that knows what the phone asked for. A no-op
 * is visible as one — re-addressing a question to the handle it already carries is
 * `{ addLabels: [], removeLabels: [] }`, and `Bd.update` with nothing in it runs no `bd`
 * at all, so a card that posts on every tap costs one `bd show` and no write. And every
 * existing `for:` label comes off rather than only the ones that disagree, because
 * *handing it to Carol* means Carol and not also whoever it was addressed to before —
 * leaving the others on would leave it ringing on their phones too, which is exactly
 * what pressing the button was meant to stop.
 *
 * **An empty handle is a legitimate answer and it means everyone.** That is not the
 * absence of a decision: `for:` labels are what make a question quiet on five Macs out of
 * six, so taking them all off is the act that puts it in front of whoever is free.
 * `everyone` and its synonyms spell the same thing out loud (`addresseeLabel` returns
 * null for them), which is why they are a word you may send and never a label a bead ends
 * up carrying.
 */
export function addresseeUpdate(issue, handle) {
  const want = addresseeLabel(handle);
  const current = (issue?.labels || []).map((l) => String(l ?? '').trim()).filter(isAddresseeLabel);
  return {
    addLabels: want && !current.includes(want) ? [want] : [],
    removeLabels: current.filter((l) => l !== want),
  };
}

/** "bob@example.com", or "bob@example.com and carol@example.com" — for a sentence. */
export function describeAddressees(handles) {
  const list = (handles || []).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
