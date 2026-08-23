/**
 * Where the *ruling* on a bead is — **the second axis, drawn beside the pull request.**
 *
 * `lib/prstage.js` owns one ladder and it is about a branch: review, merged, pushed,
 * deployed, live. It is the only place that decides that, deliberately, because three
 * modules once answered "where is this PR" three ways and two screens disagreed in front
 * of somebody. **Nothing here touches it, and nothing here is a rung on it.**
 *
 * This is a different question about a different object. deluvia's
 * `docs/APPROVAL_PIPELINE.md` defines a four-state machine over labels — draft →
 * in-review → approved (which is a close) → revise — and it is about a **deliverable**
 * and Adam's ruling on it, not about a branch. A chapter can be `in-review` with no pull
 * request in existence; a pull request can be `merged` while the thing it carries has
 * never been ruled on. dv-uhl put the two ways of holding that to Adam — teach `stageOf`
 * to take a ladder, or draw a second axis — and the answer was the second axis: *"the two
 * facts stay two facts because they genuinely are two facts — where the branch is, and
 * where the ruling is."* So a card reads `in-review · PR open`, and neither half is
 * derived from the other or capable of overwriting it.
 *
 * ## Derived here rather than in the browser, and `null` for most beads
 *
 * The same arrangement as `lib/modelcard.js`, for the same reason and with one
 * difference. The reason: `toQuestion` (lib/decision.js) is narrow on purpose and drops
 * `labels`, so an inbox chip has nothing to read client-side, and this state machine is a
 * **policy** rather than a prefix — a browser copy of it would keep drawing confidently
 * after APPROVAL_PIPELINE.md had moved. Both cards are handed the identical object so
 * they cannot disagree about a bead, which is the failure that matters: two plausible
 * answers with nothing on either screen to say which one lied.
 *
 * The difference: `modelCard` answers for *every* bead, because every bead is routed
 * somewhere and a blank chip would hide the untiered ones. This answers `null` for every
 * bead not in the pipeline, which today is every bead in every workspace but deluvia.
 * That is not a gap, it is the truth — a tracker where nothing is a review packet has no
 * rulings to report, and a chip saying so on eleven beadcause cards would be eleven chips
 * carrying no information. Every inbox payload pays for whatever is added to it, so the
 * absent case is the one worth getting right.
 *
 * **No workspace name appears in this file.** The pipeline is a label vocabulary, and a
 * workspace is in it exactly when its beads carry the labels. If sophab adopts the same
 * document tomorrow its cards light up with no change here — and a `workspace ===
 * 'deluvia'` test would be a second place the pipeline is defined, which is the thing
 * `lib/prstage.js`'s header is a whole essay against.
 *
 * ## Why `human-replied` on its own is not `revise`
 *
 * `human-replied` is beadcause's own label (`REPLIED_LABEL`, lib/server.js) and it is set
 * on *any* bead in *any* workspace the moment you comment without answering. Read alone
 * it would put a `revise` chip across half the beadcause tracker. It is `revise` only on
 * a bead that is a review packet — `needs-approval` — which is exactly what the document
 * means by the state: ward asked, Adam declined to rule, the ball is with the agent.
 *
 * ## The vocabulary this shares with lib/approval.js
 *
 * `lib/approval.js` is bc-bmry.2 and it is the **policy** half of the same document: an
 * agent may not close a `gate` or a `needs-approval` bead. This is the **display** half,
 * and they are deliberately separate files rather than one — merging them would put a
 * card renderer's concerns inside the rule that refuses a close, and make lib/bd.js
 * depend on a chip. The labels both read are lib/approvallabels.js's, a third file
 * neither imports from the other, so the two halves cannot spell one of them
 * differently without a test catching it.
 */
import {
  GATE_LABEL as GATE,
  GATE_PREFIX,
  NEEDS_APPROVAL,
  DRAFT_LABEL as DRAFT,
  REPLIED_LABEL as REPLIED,
  REVISION_PREFIX,
} from './approvallabels.js';

/** What actually puts a bead on the phone. Its absence beside `NEEDS_APPROVAL` is a bug. */
const HUMAN = 'human';

/**
 * The four states, with what each one means — the table both cards take their words
 * from, so neither can invent a fifth.
 *
 * In the document's order, which is the order they happen in, and `revise` is last
 * because it is not a rung after `approved`: it is the loop back to `draft`. There is no
 * `RANK` here and nothing sorts on it, which is the other way this is not
 * `lib/prstage.js` — that ladder exists so a board can put the pull request you must act
 * on first. This is a fact drawn beside another fact.
 */
export const APPROVAL_STATES = [
  {
    id: 'draft',
    label: 'draft',
    note: 'An agent is working on it. Nothing has been asked of anybody.',
  },
  {
    id: 'in-review',
    label: 'in-review',
    note: 'A review packet on the phone, waiting on a ruling.',
  },
  {
    id: 'approved',
    label: 'approved',
    note: 'Ruled on and closed — approval is the close, and only a tap can do it.',
  },
  {
    id: 'revise',
    label: 'revise',
    note: 'Commented on without being answered. Back with the agent, not with you.',
  },
];

/** Every state id, in the order above. */
export const APPROVAL_IDS = APPROVAL_STATES.map((s) => s.id);

/** The state's row from the table, for a caller that wants the words. */
export const approvalInfo = (id) => APPROVAL_STATES.find((s) => s.id === id) || null;

/**
 * Labels, trimmed, with a lower-cased twin for matching.
 *
 * Matched case-insensitively and *displayed* as written: bd does not normalise labels, so
 * `Gate:g2` is a label it will happily store, and `gate:G2` is the document's own spelling
 * with a capital G that a lower-cased chip would quietly correct.
 */
function labelsOf(bead) {
  return (bead?.labels || [])
    .map((l) => String(l ?? '').trim())
    .filter(Boolean)
    .map((raw) => ({ raw, key: raw.toLowerCase() }));
}

/**
 * Everything either card needs to draw the ruling, off a `bd --json` row — or `null` for
 * a bead that is not in the pipeline, which is most of them.
 *
 *   - `state` — one of `APPROVAL_IDS`, or `null`. Null *with a card present* is a real
 *     shape rather than a gap: a deliverable can carry `gate:G2` before ward has put it
 *     in any state, and the honest answer then is the gate plus silence about the ruling.
 *   - `label` / `note` — the words from `APPROVAL_STATES`, so no renderer writes its own.
 *   - `gates` — the `GN`s this bead counts towards, spelled as written. The cheap half of
 *     tally's readiness: *which* gate, not *how many are left*. The count is a query over
 *     a whole workspace and a card is handed one bead; see the README for why that half
 *     is deliberately not here.
 *   - `isGate` — the bare `gate` label: this bead *is* a gate rather than counting
 *     towards one.
 *   - `revision` — the N from `revision:N`, or `null`. It rides the child that does the
 *     pass rather than the packet, which is why it is its own field and not part of
 *     `revise`.
 *   - `problem` — the sentence for a bead whose labels say something the pipeline calls a
 *     bug, or `null`.
 *
 * Never throws and never guesses. No bead, no labels, labels that are numbers — `null`.
 */
export function approvalCard(bead) {
  const labels = labelsOf(bead);
  const has = (name) => labels.some((l) => l.key === name);
  const needsApproval = has(NEEDS_APPROVAL);
  const draft = has(DRAFT);
  const isGate = has(GATE);
  const gates = labels
    .filter((l) => l.key.startsWith(GATE_PREFIX) && l.key.length > GATE_PREFIX.length)
    .map((l) => l.raw.slice(GATE_PREFIX.length).trim())
    .filter((g, i, all) => g && all.indexOf(g) === i);
  const revision = revisionOf(labels);

  // The gate on the whole card. `human-replied` is missing from this list on purpose —
  // see the header: alone it is a beadcause-wide flag and would light up a tracker that
  // has never heard of an approval pipeline.
  if (!needsApproval && !draft && !isGate && !gates.length && revision === null) return null;

  const state = stateOf(bead, { needsApproval, draft, replied: has(REPLIED) });
  const info = approvalInfo(state);
  return {
    state,
    label: info?.label || '',
    note: info?.note || '',
    gates,
    isGate,
    revision,
    problem: problemWith({ needsApproval, human: has(HUMAN), isGate, gates, status: bead?.status }),
  };
}

/**
 * Which of the four, or `null`.
 *
 * The order of the branches is the whole of it, and two are worth the words:
 *
 * - **`approved` is a close.** APPROVAL_PIPELINE.md is blunt about it — "there is no
 *   'approved but still open' state" — and no agent may set it, because the only thing
 *   that can is Adam's tap. So this reads `status`, not a label, and a `needs-approval`
 *   bead that closed is approved however it closed. That last part is a deliberate
 *   over-reach: a packet closed by hand is one somebody decided about, and calling it
 *   `in-review` on the strength of the label still sitting there would have the card
 *   telling you a question is outstanding when it is not.
 * - **`revise` outranks `in-review`.** Between your comment and the agent's next pass the
 *   bead carries both labels, and the truer of the two is that it is no longer waiting on
 *   you. The document has the agent strip `needs-approval` when it opens the revision
 *   child; until that happens, this is what the card should say.
 *
 * A closed bead that is only a `draft` — or only a gate — gets `null` rather than a
 * state. It is not approved, and it is not in draft any more; it is finished work, and
 * the status pill beside the chip already says so.
 */
function stateOf(bead, { needsApproval, draft, replied }) {
  const closed = String(bead?.status || '').toLowerCase() === 'closed';
  if (needsApproval && closed) return 'approved';
  if (closed) return null;
  if (needsApproval && replied) return 'revise';
  if (needsApproval) return 'in-review';
  if (draft) return 'draft';
  return null;
}

/**
 * `revision:2` → `2`. Ignores a bare `revision:` and anything that is not a whole number.
 *
 * Digits rather than `Number()`, and that is not fussiness: `Number('')` is **0**, so a
 * bare `revision:` typed by hand would have read as revision zero and put a card on a
 * bead that is not in the pipeline at all. `Number('  2  ')` is also 2, which is fine, and
 * `Number('2e1')` is 20, which is not a revision anybody wrote.
 */
function revisionOf(labels) {
  for (const l of labels) {
    if (!l.key.startsWith(REVISION_PREFIX)) continue;
    const text = l.raw.slice(REVISION_PREFIX.length).trim();
    if (/^\d+$/.test(text)) return Number(text);
  }
  return null;
}

/**
 * The two label shapes the document calls bugs, as a sentence — or `null`.
 *
 * Both are invisible from the phone *by construction*, which is why they are worth
 * drawing at all. `needs-approval` without `human` is the worse one and comes first:
 * APPROVAL_PIPELINE.md says it "is always a bug", and it is the specific bug where the
 * packet never reaches the inbox — the inbox is `bd human list` — *and* the advocate,
 * whose whole definition of work is ready-minus-`human`, may open an unattended session
 * on it. A question nobody was asked, being answered by an agent.
 *
 * **Only the bead sheet can ever draw this one**, and that is the point rather than a
 * limitation: the inbox is the set of `human` beads, so a packet missing that label is by
 * definition not on the card that would have complained about it.
 *
 * Only while open, too. A packet that has been ruled on and closed is not waiting to
 * reach anybody, and flagging it would raise an alarm about something that already
 * happened.
 */
function problemWith({ needsApproval, human, isGate, gates, status }) {
  const closed = String(status || '').toLowerCase() === 'closed';
  if (needsApproval && !human && !closed) {
    return 'needs-approval without human — this never reaches the phone, and an advocate may open a session on it';
  }
  if (isGate && gates.length) {
    return 'a gate carries the bare `gate` label, never `gate:GN` — the namespaced one means it counts towards a gate';
  }
  return null;
}
