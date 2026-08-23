/**
 * The label vocabulary docs/APPROVAL_PIPELINE.md and docs/STUDIO_CHARTER.md define,
 * spelled once so `lib/approval.js` (the policy: no agent closes a `gate` or a
 * `needs-approval` bead) and `lib/approvalcard.js` (the display: where the ruling is,
 * drawn on both cards) cannot drift apart. They stay two files on purpose — merging
 * them would put a card renderer inside the rule that refuses a close, and make
 * lib/bd.js depend on a chip — but both read the same document, so they read the same
 * six constants rather than two private copies of them.
 *
 * `human` is deliberately not here. `lib/server.js`'s `HUMAN_LABEL` is the same string
 * for the whole app — it is what puts *any* bead on the phone — and the approval
 * pipeline reads it rather than defining its own meaning for it, so `lib/approvalcard.js`
 * keeps its own local copy the way it always has. Add it here only if a second reader of
 * that specific meaning shows up.
 */

/** Bare label: *"I am a gate"*. `gate:G0` is not this — see `GATE_PREFIX`. */
export const GATE_LABEL = 'gate';

/** `gate:G2` — *"I count towards G2"*, the namespaced counterpart to `GATE_LABEL`. */
export const GATE_PREFIX = 'gate:';

/** The bead is a review packet, waiting on Adam's ruling. */
export const NEEDS_APPROVAL = 'needs-approval';

/** An agent is working on it. Nothing has been asked of anybody yet. */
export const DRAFT_LABEL = 'draft';

/**
 * beadcause's own label, set on any commented-on bead in any workspace — the approval
 * pipeline reads it as `revise`, but only beside `NEEDS_APPROVAL`. The same string as
 * `lib/server.js`'s `REPLIED_LABEL`, which is what actually sets it; this is the
 * pipeline's own copy for reading it, the way `GATE_LABEL` is not `lib/bd.js`'s to own.
 */
export const REPLIED_LABEL = 'human-replied';

/** `revision:2` — the Nth pass on a deliverable, carried by the child that does it. */
export const REVISION_PREFIX = 'revision:';
