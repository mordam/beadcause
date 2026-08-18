/**
 * What a *proposal* may say about a bead that does not exist yet — and what only the
 * daemon may say about one that does.
 *
 * There are two places a form's labels reach `bd create`: the chat console's
 * **Create N beads** (`POST /api/console/create`) and the advocate proposal's approval
 * tap (`createProposed`, lib/server.js). Both passed the card's labels straight through
 * with no guard, while their sibling `POST /api/bead/adjust` ran every label through
 * `isProtectedLabel` (lib/verdict.js) precisely so the labels the daemon owns could not
 * be set from a form. So the two ends of the same tracker disagreed, and the
 * disagreement was silent.
 *
 * Two of these were always reachable — `slug('unendorsed')` is `unendorsed`. The rest
 * became reachable with bc-vriu.1, which stopped lib/draft.js slugging labels so the
 * structured ones survive: a good fix whose side effect is that `held:<stamp>:<handle>`
 * and `superseded-by:<id>` now arrive intact too. A card carrying `superseded-by:bc-x`
 * files a bead that is out of every queue from the moment it exists; one carrying
 * `unendorsed` files work no advocate will ever pick up. Neither is a thing the card
 * offers you to type, and neither said anything when it happened.
 *
 * ## The line, and it is not `isProtectedLabel`
 *
 * A label here is one of two things, and only one of them is a form's to write:
 *
 * - **A record of something that has already happened** — a session ran, a session holds
 *   it, an act was performed through a route, nobody has read it yet. A bead being
 *   created has no history, so every one of these is a claim about a past that does not
 *   exist. These are refused.
 * - **A statement about the bead** — who is answerable for it, whose decision it is,
 *   what kind of thing it is. A proposal is exactly the place to say one of those, and
 *   saying it on the way in saves a second act. These are allowed.
 *
 * That is a **different question** from the one `isProtectedLabel` answers, which is why
 * the two files do not share an answer and must not be collapsed into one. The ✎ posts
 * the label set the card is showing and "remove what I no longer see" is how a removal is
 * expressed there, so an adjust can destroy a label by *omission* — which is why
 * `owner:<handle>` and `for:<handle>` are protected from it. A create cannot destroy
 * anything by omission: there is no bead yet. So those two are refused by one guard and
 * allowed by the other, on purpose, and `PROPOSAL_EXCEPTIONS` below is the whole of the
 * difference between the two lists.
 *
 * ## Refused, and why each
 *
 * - **`unendorsed`** (lib/endorse.js) — the hold itself. Pressing the button *is* the
 *   reading that endorsement is: you saw the card. A bead filed already holding itself is
 *   work the advocate will never queue, and it lands in the endorsement queue asking you
 *   to endorse what you created thirty seconds ago. It moves by endorsing, which is a
 *   route of its own (`POST /api/verdict`).
 * - **`agent-filed`** (lib/filing.js) — provenance, and this is the one path that knows
 *   the truth: `actorFor(req)` records the press. `bd list --label agent-filed` is the
 *   honest history of what agents found unattended, and a bead nobody's agent filed
 *   counted in it makes that history worth less than no history.
 * - **`held:<stamp>:<handle>`** (lib/lease.js) — a lease held by a session that is
 *   *running*. Nothing has been dispatched, so it is held by nobody; the stamp is a clock
 *   reading, and one typed by hand expires at a time that never meant anything.
 * - **`ran:<model>`** (lib/ranmodel.js) — a record of what a session that has already
 *   finished was billed to. There has been no session. It is the only surviving copy of
 *   that fact, which is why the ✎ may not clear one — and the same argument says nothing
 *   may invent one.
 * - **`superseded-by:<id>`** (lib/superseded.js) — takes the bead out of every queue for
 *   good, from the moment it exists. It is one third of an act `bin/supersede.js`
 *   performs whole — the label, the graph edge, and the reason as a comment — and the
 *   label on its own is the third that hides the other two.
 * - **`ship`** (lib/shipbead.js) — a ship bead is minted by the release path and closed
 *   by a deploy. A hand-written one is a pull request board row with no pull request
 *   behind it, in a queue whose only exit is a deploy that will never come.
 *
 * ## Allowed, and why each
 *
 * - **`owner:<handle>`** (lib/ownership.js) — deliberately allowed, and pinned by
 *   test/draftlabels.mjs since bc-vriu.1. A chat filing a P0 for somebody else should be
 *   able to say so, and `Bd.create` already treats a named owner as winning over the
 *   stamp it would otherwise apply. This is the exception that made the bead a decision
 *   rather than a one-line fix.
 * - **`for:<handle>`** (lib/addressee.js) — the same argument aimed at the other
 *   question. The fan-out lib/addressee.js exists to stop is a question that reaches five
 *   phones because nobody said whose it was; a proposal naming one addressee is the
 *   opposite of that, not an instance of it.
 * - **`container`** (lib/container.js) — a statement about what kind of thing the bead
 *   is: furniture rather than work. There is no route that sets it and nothing records
 *   it, so the only way to file a standing root from a chat is to say so on the card. It
 *   is also the one refusal that would cost something real: a container filed by accident
 *   is one `bd label remove` away, and a container that could not be filed at all is a
 *   root nobody can make.
 * - **Everything else** — `human`, `tracker`, `complexity:<tier>`, whatever the work is
 *   about. A label is a value the tracker owns and this file has no opinion on the ones
 *   that mean nothing to the daemon.
 *
 * ## Dropped, not refused
 *
 * A card carrying one of the six does not fail the create — the label is dropped, the
 * bead is made, and a warning names the label and the reason. That is lib/draft.js's rule
 * ("everything here is repaired rather than rejected"), and it is the right one for the
 * same reason: a proposal is a conversation's output, and throwing away four good beads
 * to punish one bad label would be the more expensive failure. The console's warnings are
 * also what keeps the chat *open* after a create, so the sentence explaining what was
 * dropped is read on the screen that produced it.
 */
import { UNENDORSED } from './endorse.js';
import { FILED_LABEL } from './filing.js';
import { SHIP_LABEL } from './shipbead.js';
import { LEASE_PREFIX } from './lease.js';
import { SUPERSEDE_PREFIX } from './superseded.js';
import { RAN_PREFIX, isRanLabel } from './ranmodel.js';
import { RED_BASE_LABEL } from './redbase.js';
import { isOwnerLabel } from './ownership.js';
import { isAddresseeLabel } from './addressee.js';

const clean = (v) => String(v ?? '').trim();
const lower = (v) => clean(v).toLowerCase();
const hasPrefix = (label, prefix) => lower(label).startsWith(prefix);

/**
 * The two `isProtectedLabel` refuses that a proposal may still state.
 *
 * Named as predicates rather than as strings because both are prefixes with a handle
 * after them, and read by `daemonOnly` before anything else so the exception can never be
 * shadowed by a rule added below it. test/proposedlabels.mjs asserts this list against
 * `isProtectedLabel`'s own, so a further protected family added to lib/verdict.js cannot
 * land here undecided.
 */
export const PROPOSAL_EXCEPTIONS = [isOwnerLabel, isAddresseeLabel];

/** Is this one of the two a proposal may state despite the ✎ refusing it? */
export const isProposalException = (label) => PROPOSAL_EXCEPTIONS.some((is) => is(label));

/**
 * Every label a form may not set, with the sentence a warning carries.
 *
 * The reasons are written for whoever reads the warning on a phone: they say what the
 * label would have *done*, because "that one is protected" tells you nothing you can act
 * on. Order does not matter — the tests are disjoint — but the plain strings come first
 * because they are the ones this was always reachable through.
 */
export const DAEMON_ONLY = [
  {
    label: UNENDORSED,
    test: (l) => lower(l) === UNENDORSED,
    why: 'the endorsement hold is not a label a card may set — creating these beads is the endorsement, and one filed already held is work no advocate will queue',
  },
  {
    label: FILED_LABEL,
    test: (l) => lower(l) === FILED_LABEL,
    why: 'that marks a bead an agent filed unattended, and you filed this one — the create records who pressed the button',
  },
  {
    label: SHIP_LABEL,
    test: (l) => lower(l) === SHIP_LABEL,
    why: 'a ship bead is minted by a release and closed by a deploy, so a hand-written one waits for a deploy that never comes',
  },
  {
    label: RED_BASE_LABEL,
    test: (l) => lower(l) === RED_BASE_LABEL,
    why: 'that marks the bead the merge queue holds a whole repository behind while its base is red — one written by hand would stop every merge in that repo over a base nothing has measured',
  },
  {
    label: `${LEASE_PREFIX}…`,
    test: (l) => hasPrefix(l, LEASE_PREFIX),
    why: 'a lease belongs to a session that is running, and nothing has been dispatched yet',
  },
  {
    label: `${RAN_PREFIX}…`,
    test: (l) => isRanLabel(l),
    why: 'that records what a finished session was billed to, and this bead has never run',
  },
  {
    label: `${SUPERSEDE_PREFIX}…`,
    test: (l) => hasPrefix(l, SUPERSEDE_PREFIX),
    why: 'that would take the bead out of every queue the moment it exists — supersede it with bin/supersede.js, which writes the edge and the reason too',
  },
];

/**
 * Why this label is the daemon's alone, or `null` if a proposal may state it.
 *
 * Takes one label at a time, matching `isProtectedLabel` — the caller has a list and the
 * answer differs per label, so a whole-list verdict would tell it the wrong thing about
 * five of six.
 */
export const daemonOnly = (label) => {
  const l = clean(label);
  if (!l || isProposalException(l)) return null;
  return DAEMON_ONLY.find((rule) => rule.test(l))?.why || null;
};

/**
 * The labels to file, and a warning for each one that will not be.
 *
 * `ref` is the card's handle, so a warning on a five-card proposal says which card it is
 * about. Order is preserved and duplicates are left alone: `bd create` is passed the list
 * verbatim and this file is not in the business of tidying values the tracker owns.
 */
export function filterProposedLabels(labels, { ref = '' } = {}) {
  const kept = [];
  const warnings = [];
  for (const raw of labels || []) {
    const label = clean(raw);
    if (!label) continue;
    const why = daemonOnly(label);
    if (!why) {
      kept.push(label);
      continue;
    }
    warnings.push(`${ref ? `${ref}: ` : ''}dropped the label ${label} — ${why}`);
  }
  return { labels: kept, warnings };
}
