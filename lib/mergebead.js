/**
 * The merge-bead — what a worker files instead of merging its own pull request.
 *
 * A worker's last act used to be the merge itself: `bin/deliver.js` pushed the branch,
 * opened the pull request, waited for its checks, merged it, and closed the work bead in
 * the same breath. That is one agent grading its own homework, and the cost was never
 * that it merged something wrong — it is that every judgement the worker *could not*
 * make became a card in Adam's inbox, and every judgement it could make was made with no
 * view of any other branch, no memory of the last five merges, and no way to fix what it
 * found.
 *
 * So the ending splits in two. The worker still pushes the branch and opens the pull
 * request; then it files one of these and stops. The MergeAdvocate (lib/mergeadvocate.js)
 * takes it from there: downmerge, gates, merge, and — when it lands — closes both beads.
 *
 * ## Three things on the bead, and they are different in kind
 *
 * **What it is about** is a `beadpr` block, and it is deliberately *the same block*
 * lib/delivery.js already writes on a delivery card: workspace, bead, repo, number, url,
 * branch, base, method, summary, tests, risk. Not a similar one — the same one, parsed by
 * the same `parseDelivery`, written by the same serialiser. Two carriers for one fact is
 * two things to rot, and this one has a specific way of rotting that would be invisible:
 * the failure path (lib/mergeadvocate.js) hands a refused merge to Adam as exactly the
 * delivery card the worker used to file, and it can only do that without re-deriving
 * anything if the merge-bead already carries the card's own block.
 *
 * **How it is going** is a separate marked block in `notes` — attempts, what refused it
 * last, the checks `main` was already failing when it merged. Separate because they have
 * opposite lifetimes: the `beadpr` block is written once and is true until the branch is
 * abandoned, and this one is rewritten every tick. Mixing them would mean rewriting the
 * identity of a pull request in order to record that its checks were slow.
 *
 * **How the review went** is a third marked block in the same `notes` field — the round,
 * the reviewer's comments, the worker's answer to each, the approval. A third lifetime,
 * and the argument for keeping it out of the queue's block is above `REVIEW_OPEN` below:
 * an admission resets the queue's counters on purpose, and an admitted pull request has
 * not un-reviewed itself.
 *
 * `notes` and not `design` for lib/epicadvocate.js's reason: notes survive a claim, a
 * reopen and a sync, `design` is the author's, and a `human` label would put the bead in
 * the inbox as a question — which it is not, until the failure path decides it is.
 *
 * ## One merge-bead per pull request
 *
 * Not one per delivery. `clearOpenCards` in bin/deliver.js exists because delivering
 * twice left two identical cards in the inbox, each one a blocker on the work bead's
 * close, and answering either was reported as having closed a bead that neither could
 * close. A merge-bead is a blocker on the work bead by construction — that is the whole
 * point of it — so the same pile in this shape is strictly worse. `openMergeBeadFor`
 * below is the finding half, and it matches the way `cardsForDelivery` does: on the pull
 * request *and* on the work bead, because a session that abandoned its branch and
 * delivered the same bead on a new one leaves the first merge-bead pointing at a pull
 * request nobody is ever going to merge.
 */
import YAML from 'yaml';
import { deliveryBlock, parseDelivery, slugOf } from './delivery.js';

/**
 * What marks a bead as a pull request waiting to be merged. Searchable:
 * `bd list --label=merge-queue`.
 *
 * A label rather than an issue type, because the type is what the close gate and the
 * board reason about and a merge-bead is an ordinary task in every one of those. And a
 * label rather than a title convention, because a title is the one field a human edits.
 */
export const MERGE_LABEL = 'merge-queue';

/**
 * Who a merge-bead is assigned to.
 *
 * Deliberately the same string as the agent kind id in lib/foundation.js's `BASELINES`
 * and `MERGE_ADVOCATE` in lib/mergeadvocate.js. It is not imported from either, because
 * this module is the leaf that both the filer (bin/deliver.js) and the advocate import,
 * and a cycle here is the one lib/agents.js already paid for once (bc-u4na). That the
 * three agree is pinned in test/mergebead.mjs rather than enforced by an import — an
 * assignee typo is a merge-bead nothing ever picks up and no error anywhere, which is
 * exactly the failure a test is for and a comment is not.
 */
export const MERGE_ASSIGNEE = 'merge-advocate';

/** Where the queue's own state lives inside `notes`, and how it finds it again. */
export const QUEUE_OPEN = '<!-- beadcause:merge -->';
export const QUEUE_CLOSE = '<!-- /beadcause:merge -->';

/**
 * How many times a merge-bead is retried before it stops being the queue's problem and
 * becomes Adam's.
 *
 * Three, and the number is doing real work rather than being round. The failures worth
 * retrying are the ones the world fixes on its own — a check that was still pending, a
 * flake, a base that moved under the merge — and every one of those is fixed or not
 * within a tick or two. Past that the retry is not waiting for anything; it is a queue
 * quietly re-running the same refusal forever, which from outside is indistinguishable
 * from the feature not working. See `raise` in lib/mergeadvocate.js for what happens
 * instead.
 */
export const MAX_ATTEMPTS = 3;

/**
 * How many times the queue will take a carded pull request **back** before it stops.
 *
 * bc-91srt. `cardedFor` and the reclaim in lib/mergequeue.js exist because a card
 * routinely outlives its reason, and taking one back costs nothing when the reason really
 * has lapsed. What it must not become is a cycle: a check that flaps green and red would
 * otherwise card, reclaim, card and reclaim for ever, and every lap of it puts a fresh
 * notification in front of Adam saying the same thing.
 *
 * Three, matching `MAX_ATTEMPTS`, and for the same argument rather than for symmetry: past
 * three the queue is not learning anything new about this pull request, and a fourth lap
 * is a queue arguing with a card instead of a human deciding. Past it the card stands, and
 * the tick says so out loud rather than going quiet — a cap nobody is told about is
 * indistinguishable from the feature not working.
 */
export const MAX_RECLAIMS = 3;

/** Is this row a merge-bead? Off the label, which is the only thing that says so. */
export const isMergeBead = (issue) =>
  (issue?.labels || []).some((l) => String(l).trim() === MERGE_LABEL);

/**
 * The whole of what a merge-bead is about, off the row the sweep already has.
 *
 * Every field the MergeAdvocate needs to act *without a worktree*, because by the time it
 * gets there the worker's worktree may well have been retired by lib/tidy.js. `null` when
 * the bead carries no block at all; `{ error }` when it carries one that will not parse,
 * which is `parseDelivery`'s own distinction and is kept rather than flattened: a block
 * that will not parse must not look like a bead with nothing behind it, or the queue
 * skips it in silence for the rest of its life.
 */
export function mergeSpec(issue) {
  const text = [issue?.description, issue?.design, issue?.notes].filter(Boolean).join('\n\n');
  return parseDelivery(text);
}

/**
 * The queue's own state — how many times this has been tried, and what happened.
 *
 * Defaults rather than nulls, because every caller wants a number to compare against
 * `MAX_ATTEMPTS` and a bead nothing has tried yet has been tried nought times. The one
 * field that stays null is `refused`: "nothing has refused this" and "something refused
 * it with an empty sentence" are different states, and the second is a bug worth seeing.
 */
export function queueState(issue) {
  const notes = String(issue?.notes || '');
  const from = notes.indexOf(QUEUE_OPEN);
  const empty = {
    attempts: 0,
    downmerges: 0,
    refused: null,
    at: null,
    baseline: [],
    resolving: false,
    reclaims: 0,
    held: false,
    heldUntil: null,
    reviewing: false,
    approved: false,
    approvedBy: '',
    approvedAt: '',
  };
  if (from < 0) return empty;
  const to = notes.indexOf(QUEUE_CLOSE, from);
  const body = (to < 0 ? notes.slice(from + QUEUE_OPEN.length) : notes.slice(from + QUEUE_OPEN.length, to)).trim();
  if (!body) return empty;
  let raw;
  try {
    raw = YAML.parse(body);
  } catch {
    // A block a human edited into invalid YAML reads as a bead nothing has tried, which
    // is the safe direction: it costs one more attempt, where the alternative — treating
    // it as exhausted — silently strands the pull request.
    return empty;
  }
  if (!raw || typeof raw !== 'object') return empty;
  const attempts = Number(raw.attempts);
  const downmerges = Number(raw.downmerges);
  return {
    attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 0,
    /**
     * How many times the base has been brought into this branch.
     *
     * Counted apart from `attempts` because a downmerge is not a refusal: a branch that
     * has been rebuilt three times because `main` kept moving underneath it has been
     * unlucky about timing, and folding the two would hand it to Adam as one that could
     * not be merged. See `MAX_DOWNMERGES` in lib/mergequeue.js.
     */
    downmerges: Number.isInteger(downmerges) && downmerges > 0 ? downmerges : 0,
    refused: raw.refused ? String(raw.refused).trim() : null,
    at: raw.at ? String(raw.at) : null,
    /** The checks `main` was already failing — see `newlyFailing` in lib/mergeadvocate.js. */
    baseline: Array.isArray(raw.baseline) ? raw.baseline.map((s) => String(s)) : [],
    /** A resolver window is open on this one; the queue leaves it alone until it is not. */
    resolving: !!raw.resolving,
    /**
     * How many times this bead has been taken **back** off a card — bc-91srt, capped by
     * `MAX_RECLAIMS`.
     *
     * Kept on the bead rather than in the daemon's memory because the thing it guards
     * against outlives a process: a check that flaps puts the pull request through the
     * same lap every few minutes, and a counter that resets on restart would never reach
     * its cap on the one Mac that restarts most. Deliberately **not** reset by
     * `admittedState` — an admission is Adam saying "merge this", which is a new
     * instruction about the merge, not a statement that the queue's own reclaiming has
     * been going well.
     */
    reclaims: Number.isInteger(Number(raw.reclaims)) && Number(raw.reclaims) > 0 ? Number(raw.reclaims) : 0,
    /**
     * The queue is holding this one because its **base** is red — bc-arf8, lib/redbase.js.
     *
     * A field of its own rather than only the sentence in `refused`, and for one reason:
     * the hold is the only thing written here that the queue itself has to *take back*.
     * Every other refusal is overwritten by the next verdict on the same branch, but a
     * hold that lifted leaves a branch nothing has judged since — so without a flag to
     * clear, `main is red` sits on a merge-bead reading as this branch's problem long
     * after the base went green. It is what tells the tick "this sentence is mine and it
     * is no longer true".
     */
    held: !!raw.held,
    /**
     * When the queue last **lifted** a hold on this branch — bc-91srt.
     *
     * `held` says the base is red now; this says it was, and stopped being, at a moment
     * the queue can name. The two are needed separately because the damage a red base
     * does outlives the hold: GitHub builds `refs/pull/N/merge`, so every check that ran
     * while the base was broken is a verdict on a merge with a broken base, and it stays
     * on the pull request afterwards because nothing re-runs it. Judging a branch on one
     * of those is what condemned #475 and #488 on 2026-08-18 — neither was ever broken.
     *
     * So the tick that lifts a hold writes the time, and `gateVerdict` refuses to count
     * a check that finished before it. It is cleared by the first verdict that was
     * actually measured after it, because by then it has done its job and a stamp that
     * outlives its purpose is one more thing to be wrong about.
     */
    heldUntil: raw.heldUntil ? String(raw.heldUntil) : null,
    /**
     * The queue is holding this one because **nobody has reviewed it** — bc-36xx.4,
     * lib/reviewgate.js.
     *
     * A flag for `held`'s reason and it is the same reason exactly: a wait the queue has
     * to be able to *take back*. Every refusal that is about the branch is overwritten by
     * the next verdict on the branch, but "waiting on a review" is about somebody else,
     * and the tick that stops waiting has no verdict of its own to write over it — so
     * without a flag saying *this sentence is mine*, a merge-bead would carry `nothing
     * has reviewed this` from the moment it was approved until the moment it merged, and
     * the queues board would draw it as a branch with a problem.
     *
     * Separate from `held` rather than one `waiting` flag with a sentence, because the
     * two are independent and can both be true: a base can go red while a review is
     * running, and the tick that lifts the hold must not also declare the review done.
     */
    reviewing: !!raw.reviewing,
    /**
     * Adam said this may land — bc-okja, and lib/mergeadmit.js is what writes it.
     *
     * The half of `gateVerdict`'s approval that GitHub cannot supply here: these pull
     * requests are opened by workers running under Adam's own token, and GitHub refuses
     * an approving review from the author of the branch. So a `requireApproval` space
     * would wait on a review that cannot exist, and this is the answer to it — an
     * approval given *to the queue*, in the queue's own block.
     *
     * In the state block rather than on a label for the reason every other field here is:
     * it is about one attempt to merge one branch, it is rewritten by the tick, and it
     * dies with the bead. `approvedBy` and `approvedAt` are carried because an approval
     * whose author is unrecoverable is the one thing worth having six months later.
     */
    approved: !!raw.approved,
    approvedBy: raw.approvedBy ? String(raw.approvedBy) : '',
    approvedAt: raw.approvedAt ? String(raw.approvedAt) : '',
  };
}

/** The state block, as it goes into `notes`. */
export function queueBlock(state) {
  const out = { attempts: Number(state?.attempts) || 0 };
  if (state?.downmerges) out.downmerges = Number(state.downmerges);
  if (state?.refused) out.refused = String(state.refused).replace(/\s+/g, ' ').trim().slice(0, 400);
  if (state?.at) out.at = String(state.at);
  if (state?.baseline?.length) out.baseline = state.baseline.map((s) => String(s)).slice(0, 6);
  if (state?.resolving) out.resolving = true;
  if (state?.reclaims) out.reclaims = Number(state.reclaims);
  if (state?.held) out.held = true;
  // Written only while it can still change a verdict — see `heldUntil` in `queueState`.
  // A stamp kept past the first verdict measured after it is one more thing to be wrong
  // about, so the tick that uses it is the tick that drops it.
  if (state?.heldUntil) out.heldUntil = String(state.heldUntil);
  if (state?.reviewing) out.reviewing = true;
  // Only when given, like every other optional field here: a block that carried
  // `approved: false` on every merge-bead in the workspace would read as a queue that
  // asks for approvals, on the ninety-nine per cent of them where nothing ever did.
  if (state?.approved) {
    out.approved = true;
    if (state.approvedBy) out.approvedBy = String(state.approvedBy);
    if (state.approvedAt) out.approvedAt = String(state.approvedAt);
  }
  return `${QUEUE_OPEN}\n${YAML.stringify(out).trimEnd()}\n${QUEUE_CLOSE}`;
}

/**
 * Every marker that delimits a block in `notes` — the queue's and the review's.
 *
 * A function rather than a constant only so it can name a marker declared further down
 * the file, and one list rather than two because of what `withBlock` needs it for: where a
 * block that has *lost its closing marker* ends. See there.
 */
const noteBlockMarkers = () => [QUEUE_OPEN, QUEUE_CLOSE, REVIEW_OPEN, REVIEW_CLOSE];

/**
 * `notes` with one marked block replaced — or added, if there was not one.
 *
 * A whole-field rewrite because bd has no way to edit part of a field, and the block is
 * cut out by its markers rather than by rewriting from scratch: anything else a human or
 * another agent wrote in `notes` survives, which is the reason the markers exist.
 *
 * The one case worth the extra line is a block whose **closing marker is gone** — a human
 * editing the field, a merge resolved badly, an agent that wrote half a block. There is
 * then nothing to cut to, and cutting to the end of the field deletes everything after it.
 * With one block in the field that cost a human's note; with two it is one state block
 * silently eating the other, and for the review block that means a merge-bead losing the
 * record of a review it has actually had. So an unclosed block ends where the next block
 * begins, and only what follows *no* marker at all is given up.
 */
function withBlock(notes, open, close, block) {
  const src = String(notes || '');
  const from = src.indexOf(open);
  if (from < 0) return src.trim() ? `${src.trimEnd()}\n\n${block}` : block;
  const to = src.indexOf(close, from);
  const after = from + open.length;
  const ends = to >= 0 ? [to + close.length] : noteBlockMarkers().map((m) => src.indexOf(m, after)).filter((i) => i >= 0);
  const tail = ends.length ? src.slice(Math.min(...ends)) : '';
  return `${src.slice(0, from)}${block}${tail}`.trim();
}

/** `notes` with the queue's state block replaced. */
export function withQueueBlock(notes, state) {
  return withBlock(notes, QUEUE_OPEN, QUEUE_CLOSE, queueBlock(state));
}

/**
 * ## A third block, because there is a third lifetime
 *
 * bc-36xx.2. The review loop puts a reviewer between the delivery and the merge, and what
 * it needs to keep is the shape of a conversation: which round this is, what the reviewer
 * objected to, what the worker said about each objection, and the approval once one
 * exists. That lives on this same bead, in `notes`, in a second marked block beside the
 * queue's — with its own markers, its own parser and its own serialiser.
 *
 * **Beside it and not inside it**, because the split in this file is by *lifetime* and
 * review state is a third one. `admittedState` (lib/mergeadmit.js) deliberately resets
 * `attempts`, `downmerges`, `refused` and `resolving` to nought when Adam admits a pull
 * request: that budget counts what the queue tried on its own, and an admission is a new
 * instruction rather than a fourth attempt. But an admitted pull request has not
 * *un-reviewed* itself — two rounds and a declined comment are exactly as true after the
 * admission as before it. Folding the review into `queueState` would erase its history at
 * the one moment it matters most, and erase it silently, because every writer of the queue
 * block rewrites the whole of it.
 *
 * Its own markers for `withQueueBlock`'s reason, and that reason is what makes two blocks
 * in one field safe: each parser finds its own pair and slices between them, so a tick
 * rewriting the queue's progress cannot touch the review, the reviewer cannot touch the
 * queue's attempt count, and anything a human wrote in `notes` outlives both. The cutting
 * itself is `withBlock` above, shared — the marker pairs are what differ, and the one case
 * where the two blocks can reach each other is documented there.
 */

/** Where the review loop's state lives inside `notes`, and how it finds it again. */
export const REVIEW_OPEN = '<!-- beadcause:review -->';
export const REVIEW_CLOSE = '<!-- /beadcause:review -->';

/**
 * What a round of review concluded.
 *
 * `changes` rather than "rejected", because it is the ordinary outcome: the reviewer read
 * the diff and has comments, and the worker is expected to answer them. `refused` is the
 * different thing — a reviewer that will not approve this pull request at all, which
 * escalates immediately rather than waiting out the round cap.
 *
 * A verdict that is none of these reads as *no verdict yet*, which is the safe direction
 * here and is the opposite of `queueState`'s: an unparseable queue block costs one more
 * attempt, where an unrecognised review verdict must never be the thing that lets an
 * unreviewed pull request through the gate. So the fallback holds the merge rather than
 * releasing it.
 */
export const REVIEW_VERDICTS = ['changes', 'approved', 'refused'];

/**
 * What the worker may say about one of the reviewer's comments — Adam's three, in his
 * words: "the worker considers the changes and either makes the suggested change, asks
 * for more clarity, or declines the comments".
 *
 * An empty answer is the fourth state and it is the one that matters most: it is the
 * comment the worker has not dealt with yet, and it is what `commentsForWorker` selects
 * on. Absent is not the same as declined, and a parser that flattened the two would turn
 * every unanswered objection into a settled one.
 */
export const REVIEW_ANSWERS = ['changed', 'clarify', 'declined'];

/**
 * How many of the reviewer's comments one merge-bead carries.
 *
 * A bound because `notes` is a single field rewritten every round and an unbounded list
 * of a reviewer's prose is how it stops being readable. Twenty is well past what a review
 * of one pull request produces, and when a review does exceed it the *unresolved* ones
 * are kept — a dropped objection is a review that silently passed, where a dropped
 * resolved comment is only history.
 */
export const MAX_REVIEW_COMMENTS = 20;

/**
 * How many rounds of review a pull request gets before it stops being the loop's problem
 * and becomes Adam's. `MAX_ATTEMPTS`'s sibling, and here rather than beside it because
 * this counts the round in the review block a few lines down, not the queue's attempts.
 *
 * Two, and it is Adam's number (bc-nq0m): *review, answer, re-review, escalate.* "Repeat
 * until there are no unresolved comments" is unbounded as written, and a reviewer and a
 * worker that genuinely disagree do not converge by being asked again — they burn a
 * session per round per side, for ever, and from outside that is indistinguishable from
 * the pull request being stuck. One round is too few, because the first re-read is where
 * a reviewer's misunderstanding is normally cleared up and it would be a shame to send
 * every one of those to a person. Past the second nothing new is being learned.
 *
 * What happens at the cap is the part worth being explicit about: unresolved comments
 * **escalate**, they do not lapse into an approval. A cap that released the merge would
 * be a review loop that rewards a worker for holding out for two rounds.
 */
export const MAX_REVIEW_ROUNDS = 2;

/** One line of somebody's prose, bounded — the shape `notes` can hold without rotting. */
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The commit a verdict was given for — the pull request's head sha at the moment the
 * reviewer wrote it down.
 *
 * Empty for anything that is not a sha, and empty is what a block written before this
 * field existed reads as. Both are the same state to the gate — *we cannot say what was
 * approved* — and that is deliberately the holding direction rather than the releasing
 * one, for the reason the whole block exists: this repo has no branch protection, so
 * GitHub does not dismiss an approving review when new commits land on the branch. An
 * approval given for one diff would otherwise sit there gating the merge of another, and
 * at sixty-odd merges a week nearly every approved pull request is pushed to again before
 * it lands. bc-36xx.4 is what compares this against the current head and asks whose
 * commits lie in between — a resolver's downmerge leaves the approval standing, a
 * worker's push sends it round again.
 *
 * Seven characters is the shortest abbreviation `gh` hands back, forty the full one, and
 * both are kept as they arrive rather than being expanded: the comparison against a head
 * is bc-36xx.4's, and it is the one that knows which end it has.
 */
const reviewSha = (v) => {
  const sha = String(v ?? '').trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : '';
};

/**
 * One of the reviewer's comments and the worker's answer to it, normalised.
 *
 * `null` for anything with no body, because a comment with nothing in it is not something
 * a worker can answer and carrying it would leave a round that can never be finished.
 *
 * The `id` is what an answer is matched back to, so it is never allowed to be empty: a
 * comment arriving without one is keyed by its position, which is stable for as long as
 * the reviewer's list is (and the reviewer rewrites the whole block when it is not).
 */
function reviewComment(raw, i = 0) {
  if (raw == null) return null;
  const src = typeof raw === 'string' ? { body: raw } : raw;
  if (typeof src !== 'object') return null;
  const body = String(src.body ?? '').trim().slice(0, 600);
  if (!body) return null;
  const line = Number(src.line);
  const answer = REVIEW_ANSWERS.includes(String(src.answer || '').trim()) ? String(src.answer).trim() : '';
  return {
    id: oneLine(src.id, 80) || `c${i + 1}`,
    /** Where in the diff, when the reviewer pointed at one — a comment need not be about a file. */
    path: oneLine(src.path, 200),
    line: Number.isInteger(line) && line > 0 ? line : null,
    body,
    answer,
    /** What the worker said about it, which is the whole of a `clarify` and most of a `declined`. */
    note: oneLine(src.note, 400),
    /** The reviewer has looked at the answer and is satisfied. Only the reviewer writes this. */
    resolved: !!src.resolved,
  };
}

/** The comments, normalised and bounded — unresolved kept first, so nothing objected to is lost. */
function reviewComments(list) {
  const all = (Array.isArray(list) ? list : []).map((c, i) => reviewComment(c, i)).filter(Boolean);
  if (all.length <= MAX_REVIEW_COMMENTS) return all;
  return [...all.filter((c) => !c.resolved), ...all.filter((c) => c.resolved)].slice(0, MAX_REVIEW_COMMENTS);
}

/**
 * Where the review has got to — off the block in `notes`, defaults for everything.
 *
 * `round: 0` because a pull request nobody has reviewed has been reviewed nought times,
 * and `verdict: null` because "nothing has judged this" is the state the gate holds a
 * merge on. `refused` stays null for `queueState`'s reason: a reviewer that refused with
 * an empty sentence is a bug worth seeing, not an absence.
 */
export function reviewState(issue) {
  const notes = String(issue?.notes || '');
  const empty = {
    round: 0,
    verdict: null,
    reviewer: '',
    at: null,
    reviewedSha: '',
    refused: null,
    comments: [],
    approvedBy: '',
    approvedAt: '',
    approvalUrl: '',
  };
  const from = notes.indexOf(REVIEW_OPEN);
  if (from < 0) return empty;
  const to = notes.indexOf(REVIEW_CLOSE, from);
  const body = (
    to < 0 ? notes.slice(from + REVIEW_OPEN.length) : notes.slice(from + REVIEW_OPEN.length, to)
  ).trim();
  if (!body) return empty;
  let raw;
  try {
    raw = YAML.parse(body);
  } catch {
    // A block somebody edited into invalid YAML reads as a pull request nobody has
    // reviewed — which holds the merge. The queue block's fallback is the permissive one
    // on purpose; this one cannot be, because the thing on the other side of it is a
    // merge that has not been looked at.
    return empty;
  }
  if (!raw || typeof raw !== 'object') return empty;
  const round = Number(raw.round);
  const verdict = REVIEW_VERDICTS.includes(String(raw.verdict || '').trim()) ? String(raw.verdict).trim() : null;
  return {
    /** Rounds *completed*, which is what the cap in bc-36xx.7 counts against. */
    round: Number.isInteger(round) && round > 0 ? round : 0,
    verdict,
    /** Which identity reviewed it — the reviewer login, not the agent kind. */
    reviewer: oneLine(raw.reviewer, 80),
    at: raw.at ? String(raw.at) : null,
    /**
     * What was reviewed, and it is written for *every* verdict rather than only for an
     * approval. A `changes` verdict wants it just as much: it is the only way a later
     * round can tell whether the worker actually pushed anything in answer to the
     * comments, or answered them in prose and changed nothing.
     */
    reviewedSha: reviewSha(raw.reviewedSha),
    refused: raw.refused ? oneLine(raw.refused, 400) : null,
    comments: reviewComments(raw.comments),
    /**
     * The approval, once there is one. Carried apart from `verdict` because six months on
     * the question about a merged pull request is who approved it and where that is
     * visible — and `approvalUrl` is the answer that does not depend on this bead still
     * existing.
     */
    approvedBy: verdict === 'approved' ? oneLine(raw.approvedBy, 80) : '',
    approvedAt: verdict === 'approved' && raw.approvedAt ? String(raw.approvedAt) : '',
    approvalUrl: verdict === 'approved' ? oneLine(raw.approvalUrl, 300) : '',
  };
}

/**
 * Which round a reviewer opened *now* would be conducting.
 *
 * `reviewState.round` counts rounds **completed**, and `withAnswers` deliberately does not
 * touch it — "the round belongs to the reviewer's passes". So the number a window is opened
 * under is one more than the block's, and it is arithmetic worth a name because getting it
 * wrong is silent: a second reviewer handed `round: 1` is handed the *first* round's brief
 * (lib/reviewadvocate.js branches on it) and re-reviews the whole diff instead of reading
 * the answers it was opened to read. That is the loop that never ends, arrived at by an
 * off-by-one.
 *
 * A pull request nobody has judged is round 1, which is the same answer read from the
 * absence of a block at all.
 */
export const nextReviewRound = (state) => {
  const done = Number(state?.round);
  return (Number.isInteger(done) && done > 0 ? done : 0) + 1;
};

/** The review block, as it goes into `notes`. Empty fields are dropped, like the queue's. */
export function reviewBlock(state) {
  const out = { round: Number(state?.round) > 0 ? Math.trunc(Number(state.round)) : 0 };
  const verdict = REVIEW_VERDICTS.includes(String(state?.verdict || '').trim())
    ? String(state.verdict).trim()
    : null;
  if (verdict) out.verdict = verdict;
  if (state?.reviewer) out.reviewer = oneLine(state.reviewer, 80);
  if (state?.at) out.at = String(state.at);
  // Unlike `approvedBy` below, this is not conditional on the verdict — see the field in
  // `reviewState`. It is conditional only on there being one, so the ninety-nine per cent
  // of merge-beads that no reviewer has looked at do not carry an empty sha apiece.
  const sha = reviewSha(state?.reviewedSha);
  if (sha) out.reviewedSha = sha;
  if (state?.refused) out.refused = oneLine(state.refused, 400);
  const comments = reviewComments(state?.comments);
  if (comments.length) {
    // Written field by field rather than as the whole normalised object, so the YAML a
    // person opens is the three or four things that are true about the comment rather than
    // every key the parser fills in, empty, under every one of them.
    out.comments = comments.map((c) => {
      const row = { id: c.id };
      if (c.path) row.path = c.path;
      if (c.line) row.line = c.line;
      row.body = c.body;
      if (c.answer) row.answer = c.answer;
      if (c.note) row.note = c.note;
      if (c.resolved) row.resolved = true;
      return row;
    });
  }
  if (verdict === 'approved') {
    if (state.approvedBy) out.approvedBy = oneLine(state.approvedBy, 80);
    if (state.approvedAt) out.approvedAt = String(state.approvedAt);
    if (state.approvalUrl) out.approvalUrl = oneLine(state.approvalUrl, 300);
  }
  return `${REVIEW_OPEN}\n${YAML.stringify(out).trimEnd()}\n${REVIEW_CLOSE}`;
}

/**
 * `notes` with the review block replaced — `withQueueBlock`'s twin, through the same cutter.
 *
 * One cutter and two marker pairs rather than two copies of the same five lines, because
 * the interesting case is the one where the two blocks meet: `withBlock` is where a block
 * that lost its closing marker is stopped at the next block's opening one, and that
 * argument has to hold for whichever of the two it happened to.
 */
export function withReviewBlock(notes, state) {
  return withBlock(notes, REVIEW_OPEN, REVIEW_CLOSE, reviewBlock(state));
}

/**
 * Has a reviewer approved this pull request?
 *
 * The one field the sweep reads, rather than a live `gh` call per merge-bead per tick —
 * bc-36xx.8 writes it at the moment the review is submitted.
 */
export const reviewApproved = (state) => state?.verdict === 'approved';

/** Nothing has judged this yet, so the gate holds it. Absence, not a negative verdict. */
export const reviewPending = (state) => !state?.verdict;

/**
 * Why this review has to reach a person, or `''` when it does not — the round cap, and
 * the flat refusal that does not wait for it.
 *
 * One function returning the sentence rather than a predicate beside a message builder,
 * because the sentence *is* the escalation: `raiseMergeCard` wants a `why` and the card
 * it writes is unreadable without one. Truthiness is the predicate.
 *
 * Two ways out, and they are different things. A **refusal** is a reviewer that will not
 * approve this pull request at all, and it escalates on round one — waiting out the cap
 * would be asking a worker to answer comments nobody is going to accept. The **cap** is
 * the ordinary disagreement: two rounds have been reviewed and it is still not approved,
 * whether that is a `changes` verdict standing or a third review that would be about to
 * start. Approved is approved at any round, so a review that took both of them and ended
 * well escalates nothing.
 */
export function reviewEscalation(state) {
  if (state?.verdict === 'refused') {
    return `The reviewer will not approve this pull request: ${state.refused || 'no reason was recorded.'}`;
  }
  if (reviewApproved(state)) return '';
  const round = Number(state?.round) || 0;
  if (round < MAX_REVIEW_ROUNDS) return '';
  const open = (state?.comments || []).filter((c) => !c.resolved).length;
  const still = open ? ` ${open} comment${open === 1 ? ' is' : 's are'} still unresolved.` : '';
  return (
    `The reviewer and the worker did not agree in ${MAX_REVIEW_ROUNDS} rounds of review, ` +
    `which is as many as this gets.${still}`
  );
}

/** The comments the worker still owes an answer on — its half of the round. */
export const commentsForWorker = (state) =>
  (state?.comments || []).filter((c) => !c.resolved && !c.answer);

/**
 * The answers the reviewer has not looked at yet.
 *
 * Every answered-but-unresolved comment, `changed` included, because Adam's rule is that
 * "any declined comments or further changes must be raised to the ReviewAdvocate for
 * scrutiny" — a change the worker made is a change somebody has to check, not a comment
 * that has closed itself.
 */
export const commentsForReviewer = (state) =>
  (state?.comments || []).filter((c) => !c.resolved && !!c.answer);

/**
 * A one-line title. The pull request first, because that is what the queue is a queue of.
 *
 * `d.title` is the *pull request's* title and a beadcause pull request title opens with the
 * bead id — so naming the bead here and then appending that title said it twice, and the
 * card in Adam's hand read `Merge #359 — bc-kneh: bc-kneh: A delivered pull request…`. The
 * prefix comes off the borrowed half rather than the id being dropped from ours: the id is
 * this line's own structure, where the pull request's copy of it is an accident of how the
 * other title happens to be built, and a pull request opened on github.com by hand has no
 * such prefix at all.
 */
export function mergeBeadTitle(d) {
  const bead = String(d?.bead || '').trim();
  const lead = bead ? new RegExp(`^${bead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\\u2014-]\\s*`, 'i') : null;
  const what = String(d?.title || d?.bead || '')
    .trim()
    .replace(lead || /(?!)/, '')
    .trim();
  return `Merge #${d.number}${bead ? ` — ${bead}` : ''}${what && what !== bead ? `: ${what}` : ''}`.slice(0, 160);
}

/**
 * The body a worker files: what this is, what will happen to it, and the block.
 *
 * Written for a person who has opened it wondering why their work has not landed, which
 * is the only reason anyone reads one of these by hand. So it says what is waiting on
 * what, in the order it will happen, and it names the work bead — because the *first*
 * question is always "is my bead stuck, and on what".
 */
export function mergeBeadBody(d, { tests = '' } = {}) {
  const parts = [
    `**${d.repo || d.workspace}** — pull request [#${d.number}](${d.url}) is ready to merge, and the ` +
      `worker that wrote it does not merge it.`,
    '',
    `The merge queue takes it from here: it brings \`${d.base}\` into \`${d.branch}\`, checks whatever ` +
      `\`${d.base}\` is not already failing, merges, and closes **${d.bead}** and this bead together. ` +
      `Nothing is owed by the session that filed it.`,
  ].join('\n');

  const why = [
    `**${d.bead} depends on this bead**, which is what stops the worker closing its own work: the ` +
      'close gate refuses a bead with an open blocker, so the dependency is the rule rather than a ' +
      'sentence in a brief.',
  ].join('\n');

  const ran = tests ? `**What the worker ran:** ${String(tests).trim()}` : '';

  // Blocks, joined by a blank line, with the empty ones dropped — rather than a single
  // string with `\n\n` sprinkled through it. The difference shows up on the one bead that
  // has no `--tests`: the sprinkled version leaves a double gap where the sentence would
  // have been, which reads on a phone as something having failed to render.
  return [parts, why, ran, '_What the merge acts on, in the form the server reads it:_', deliveryBlock(d)]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The merge-bead already open for this work, if there is one — the half that stops a
 * re-delivery filing a second.
 *
 * Two ways to be the same merge, and both are needed, for exactly `cardsForDelivery`'s
 * reasons: the **pull request** (number and repo, since a number alone is unique only
 * within a repo), and the **work bead**, which the pull request alone misses when a
 * session abandoned its branch and delivered the same bead on a new one.
 *
 * Nothing is matched on wording, because the wording is what a re-delivery changes.
 */
export function openMergeBeadFor(rows, { repo = '', number, bead = null } = {}) {
  const n = Number(number);
  const wantNumber = Number.isInteger(n) && n > 0 ? n : null;
  const wantSlug = String(repo || '').trim().toLowerCase();
  const wantBead = String(bead || '').trim().toLowerCase() || null;
  if (!wantNumber && !wantBead) return [];

  const sameRequest = (d) => {
    if (!wantNumber || Number(d.number) !== wantNumber) return false;
    const slug = slugOf(d);
    return !slug || !wantSlug || slug === wantSlug;
  };
  const sameBead = (d) => !!wantBead && String(d.bead || '').trim().toLowerCase() === wantBead;

  return (rows || [])
    .filter((r) => r && r.id && r.status !== 'closed' && isMergeBead(r))
    .map((r) => ({ row: r, d: mergeSpec(r) }))
    .filter(({ d }) => d && !d.error && (sameRequest(d) || sameBead(d)))
    .map(({ row, d }) => ({ id: row.id, bead: d.bead || null, number: Number(d.number) || null, title: row.title || '' }));
}
