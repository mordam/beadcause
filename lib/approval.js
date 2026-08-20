/**
 * The one law: **no agent closes a gate, and no agent closes a bead that is waiting to be
 * approved.** The tap is the close — and, since bc-bmry.8, the tap is the merge too.
 *
 * This is deluvia's rule and it is written down there three times — docs/STUDIO_CHARTER.md
 * §2 and §6, docs/STUDIO_PLAN.md §6, restated for `ward` and `tally` in
 * docs/APPROVAL_PIPELINE.md — and until this file existed none of those three sentences was
 * read by anything. beadcause had no idea what a gate was: the only mention of the word in
 * lib/ was an unrelated capability marker and a node id in a flowchart. So a gate bead came
 * up ready like any other bead, an advocate opened an unattended session on it, and the
 * session ran its ordinary ending, which closes the bead the window was opened for.
 *
 * **It has already fired.** Delivering dv-b5d on 2026-08-10 closed the epic over six open
 * children, four of them gates. `scripts/studio_status.py` in deluvia is built around the
 * rule — it only ever reads, it contains no `bd` write of any kind, and it prints "only Adam
 * closes a gate" on every run — so the cost of a wrong close is not a row in a tracker: it
 * is a status board reporting G0 closed and G1/G4 unblocked, on a lie, which is the exact
 * silent failure the rule exists to prevent.
 *
 * Answered on dv-vry (2026-08-18) as *both*: the worker brief states the law in words **and**
 * beadcause refuses the close in code, so a brief that drifts cannot silently reopen the
 * hole. dv-8o5 is the same answer for the specific case — a worker delivers a gate bead with
 * `--review`, and beadcause learns not to close a bead carrying the bare `gate` label.
 *
 * ## And the merge itself, decided later, the same way
 *
 * bc-bmry.2 built the close refusal above and deliberately left the *merge* alone — a gate
 * bead's pull request still went on the merge queue like anything else, and the only thing
 * standing between it and `main` was a session remembering to type `--review`. That is
 * exactly the shape dv-vry's own general answer warns against: "a brief that drifts cannot
 * silently reopen the hole" was said about the close, and it is equally true of the merge —
 * a worker is a promise the code did not yet keep. bc-bmry.8 asked whether it should, and the
 * answer is the same *both*: `bin/deliver.js` now holds the merge itself, whether or not
 * `--review` was passed, the same way `editHold` already holds an in-app edit's. dv-8o5's own
 * words about the close — "costs a decision per gate session, which is the point of a gate"
 * — are the reason the wider cost (every gate delivery becomes a card instead of a queue
 * entry) is not a reason to leave the merge open: that cost is the one the label is for.
 *
 * ## What is held, and what deliberately is not
 *
 * The bare label `gate` means *I am a gate*. `gate:G0` means *I count towards G0* and is an
 * ordinary deliverable — the beads under a gate are exactly the work that moves it, and
 * holding those would stop the whole ladder rather than protecting it. So the match is
 * exact, on the whole label, and `startsWith('gate')` would be wrong in the one way that is
 * expensive to notice.
 *
 * `needs-approval` is the second half of the same law and comes from
 * docs/APPROVAL_PIPELINE.md's state machine — draft → in-review → approved → revise. A bead
 * sitting in that pipeline is waiting on a judgement nothing in a pull request is evidence
 * about.
 *
 * ## Why this is a rule about the *close reason*, and not about the bead
 *
 * The tempting shape is the one lib/endorse.js and lib/shipbead.js use — a filter plus a
 * refusal, so the bead never reaches a queue and cannot be worked at all. That is
 * `QUEUE_EXCLUDED`, it was on the table as dv-8o5's other option, and it is **not** what was
 * decided, for a reason that is easy to lose: a gate is not unworkable. Evidence gets
 * gathered against it, notes get written on it, and the answer chose to keep gate beads
 * dispatchable and stop only the close.
 *
 * More importantly, a blanket refusal would break the half of the law that matters most.
 * *The tap is the close* — when a gate is genuinely met, Adam closes it from the phone, and
 * the phone asks `Bd.gateFor` whether a close would be refused before it draws the button
 * (lib/server.js). A rule that refused every close would take the button away and leave a
 * gate that nothing on this machine could ever close.
 *
 * So the refusal keys on the *sentence the close would carry*. `isMergeReason` in lib/bd.js
 * already identifies the three sentences a merge writes — `Landed as #42` from a worker's own
 * delivery and from the tap on a delivery card, `Merged #212 as 72789c0b into main on GitHub`
 * from the sweep that notices a merge made on github.com — and every automated close of a
 * work bead in this program carries one of them. A close Adam asks for by name does not, and
 * goes through untouched.
 *
 * That is the same shape, and the same argument, as the epic rule sitting beside it: an epic
 * does not close because a branch sharing its name merged. Here it is stronger — a merge is
 * not merely poor evidence about a gate, it is not the gate's evidence at all.
 *
 * ## Where the rule is enforced, and why it is more than one place
 *
 * `Bd.gateFor` is the funnel for everything inside the daemon: the tap on a delivery card
 * (`finishWorkBead`, lib/server.js), the sweep that notices a merge on github.com
 * (lib/landed.js), and the retry minutes later that runs with nothing in hand but the stored
 * sentence (lib/owed.js). Two paths cannot ask it and are wired separately for the same
 * reason the epic rule is:
 *
 *  - **lib/mergequeue.js** closes the work bead directly after a merge, and already had the
 *    epic branch written out by hand beside it.
 *  - **bin/deliver.js** is a different process shelling out to `bd` synchronously. It cannot
 *    import a `Bd`, it attempts the close and handles the refusal, and it already checks the
 *    merge-reason half itself.
 *
 * Missing one of those is what "wired to all four doors or it looks broken exactly when Adam
 * happens to merge that way" means in practice.
 *
 * ## What this is not strong enough to be
 *
 * A `bd close` typed at a terminal still closes a gate. bd has no pre-close hook — `bd hooks`
 * installs git hooks and nothing else — so no rule beadcause holds can reach it. What this
 * covers is the only ending an unattended session has, which is the one that fired.
 */

/** The label that means *I am a gate*. Bare, exact — `gate:G0` is not this. */
export const GATE_LABEL = 'gate';

/** The label that means *this is waiting on a judgement*, from deluvia's approval pipeline. */
export const NEEDS_APPROVAL = 'needs-approval';

/** Both, in one place, because two spellings in two files is the same as no rule. */
export const APPROVAL_LABELS = [GATE_LABEL, NEEDS_APPROVAL];

/**
 * Which of the two labels holds this bead's close, or `''` for a bead neither holds.
 *
 * Takes a `bd --json` row, or anything with `labels`. Returns the label rather than a
 * boolean because every refusal below has to *say which one stopped it* — "it is a gate" and
 * "it is waiting to be approved" send a reader to two different documents, and a session
 * told only that something refused retries.
 */
export function approvalHold(issue) {
  const labels = (issue?.labels || []).map((label) => String(label).trim());
  return APPROVAL_LABELS.find((held) => labels.includes(held)) || '';
}

/**
 * The refusal, in the words that go on the bead and onto the phone.
 *
 * One sentence, written once, because it is said by five callers in four files and a
 * refusal that reads differently depending on which door it came through is a refusal
 * nobody can search for.
 *
 * It names the label, says what the close would have destroyed, and says what to do
 * instead — which for a session is `--review`, and for anybody reading afterwards is the
 * tap. A refusal that only says no is the one a session works around.
 */
export function approvalRefusal(label) {
  return label === NEEDS_APPROVAL
    ? 'a bead labelled `needs-approval` does not close on a merge — it is waiting on an approval, ' +
        'and merging its pull request is not that approval. Deliver with `--review` and let the tap close it'
    : 'a bead labelled `gate` does not close on a merge — a gate closes when the gate is met, ' +
        'which a merged pull request is no evidence about. Deliver with `--review` and let the tap close it';
}

/**
 * The one-line reason a *delivery* of one of these hands over instead of merging — the
 * merge-time twin of `approvalRefusal`, which is about the close. Written separately
 * rather than reused, because the two happen at different moments and are read by two
 * different audiences: the refusal explains a close that already failed, this explains a
 * merge `bin/deliver.js` chose not to attempt at all. Shaped like `EDIT_HOLD` in
 * lib/editwork.js — a standalone clause naming the bead, usable in a console line, a
 * comment, or a pull-request note without further framing.
 */
export function approvalMergeHold(label) {
  return label === NEEDS_APPROVAL
    ? 'this bead is labelled `needs-approval`, and it is waiting on a judgement a green pull ' +
        'request is not — it merges when the tap does, not on its own'
    : 'this bead is labelled `gate`, and a gate closes when the gate is met, which a pull ' +
        'request merging is no evidence about — it merges when the tap does, not on its own';
}

/**
 * The whole rule, for a caller that has the bead and the sentence its close would carry.
 *
 * Returns the refusal, or `''` when the close may go through — the same shape as
 * `Bd.gateFor`'s `null`, and deliberately not a throw: every caller here has already
 * merged something by the time it asks, and a refusal is a state to write down rather than
 * an error to unwind.
 *
 * `merged` is passed in rather than computed, because the one predicate that decides it —
 * `isMergeReason` — lives in lib/bd.js and importing it here would put a cycle between the
 * two files the moment lib/bd.js imports this one.
 */
export function approvalStop(issue, merged) {
  if (!merged) return '';
  const held = approvalHold(issue);
  return held ? approvalRefusal(held) : '';
}
