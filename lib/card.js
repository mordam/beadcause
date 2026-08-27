/**
 * The label a bead carries when it exists only to ask a question — never to be built.
 *
 * bc-7qo.9: nothing separated *work that landed* from *a card the daemon filed and Adam
 * answered*, once both are closed. bc-xl7n.15 ("#244 left 1 conflicting pull request
 * behind it") and bc-xl7n.35 ("a sweep card whose record is dropped can never close")
 * are siblings under bc-9d37, both closed, both carrying `inbox`/`tracker`/`unsorted` —
 * and only the second was ever built. The first is one of a family of near-identical
 * sweep cards whose entire life is a report and a tap.
 *
 * **This is narrower than `human`, on purpose.** `human` also lands on a decision made
 * mid-flight through a bead that still owes code once answered — test/promotework.mjs
 * pins `whyNotWork({labels:['human','p0']}) === ''` for exactly that reason, and a bead
 * of type `decision` is not automatically exempt either: bc-3muu.9 was `type: decision`,
 * fully answered, and still had to land a branch because its acceptance asked for the
 * answer to be *recorded* in code. `human` and `decision` both say "Adam had to look at
 * this"; neither says "and closing it is the whole of what this bead was for". `card`
 * says the second thing, and only the filer can say it truthfully — after the fact there
 * is nothing left to key on but a `decision` block in the description, which the graph
 * index does not carry.
 *
 * **Written once, at filing time, by whatever raises the card** — a merge-conflict sweep
 * report (lib/sweepcard.js), an advocate's proposal asking which of several beads to
 * endorse (lib/advocate.js). Not everything that sets `human` qualifies: a bead already
 * marked `superseded-by:<id>` (lib/superseded.js) is excluded from landed work through
 * that prefix already, on the same reasoning — see `NOT_WORK` in lib/promote.js, the one
 * place this label is read.
 *
 * A closed bead filed before this label existed carries no `card` and still reads as
 * work — bc-xl7n.15 among them. Backfilling those by hand is a separate question this
 * file does not answer.
 */
export const CARD_LABEL = 'card';
