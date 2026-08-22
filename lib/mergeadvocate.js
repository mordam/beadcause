/**
 * The MergeAdvocate — the agent that merges other agents' work, and the only thing on
 * this Mac that closes a work bead.
 *
 * A worker files a merge-bead (lib/mergebead.js) and stops. This owns the queue of them:
 * for each one, bring the base into the branch, verify the checks the base is not already
 * failing, merge, and close the work bead and the merge-bead together. On failure it
 * assesses and resolves, or raises it to Adam as a card with the merge one tap away.
 *
 * ## Why a sixth kind and not a mode
 *
 * The same argument lib/epicadvocate.js makes for being a fifth: the difference between
 * these agents is their permissions, not their code path, and a mode has to carry both
 * and pick at runtime — which is the shape where a bug grants the wider one. lib/advocate.js
 * is `writes: false` because it may not invent work. This one merges to `main` and closes
 * two beads, which makes it the widest-reaching agent in the roster; that has to be
 * readable off a screen rather than inferable from a code path, and a kind gets what a
 * mode cannot: an amendable foundation, a row on the agents screen, and its own mark.
 *
 * ## What runs where, and why the split is not arbitrary
 *
 * **The deterministic half runs in the daemon, with no window at all.** Downmerge, wait
 * for checks, compare against the base, merge, close both beads. Every one of those is
 * something `bin/deliver.js` already did without an agent, and putting a language model
 * in front of `gh pr merge` would add judgement to the one part of this that has none.
 * What the daemon adds over the worker doing it is not intelligence, it is *position*:
 * one process, one registry, one merge at a time per repo — so five branches about to
 * conflict with each other stop each spending five minutes discovering it separately.
 *
 * **A window opens only when something refused.** That is where an agent earns its keep:
 * a conflicted downmerge somebody has to actually resolve, a check that went red and
 * needs reading. It is opened on the merge-bead the way lib/epicadvocate.js opens one on
 * a P0, it is re-entrant for the same reason, and — the constraint that falls out of that
 * — **everything it knows has to be on the merge-bead**, which is what `queueState` in
 * lib/mergebead.js is for.
 *
 * ## The one thing it may not re-invent
 *
 * `prPolicyFor` in lib/spaces.js already decides `autoMerge` and `requireApproval` per
 * space and per workspace, and lib/autoship.js decides whether the merge deploys itself.
 * This obeys all three. A space with auto-merge off still ends in Adam's tap — what
 * changed is who files the card, not whether one is filed — and the merge still
 * self-deploys through the settle window in lib/release.js rather than through anything
 * here. A queue in front of a deploy that already works must not grow a second one.
 */
import { MAX_ATTEMPTS, MERGE_ASSIGNEE, MERGE_LABEL, isMergeBead, mergeSpec, queueState } from './mergebead.js';

/** The kind, as lib/foundation.js keys it. One spelling, because agent ids are on disk. */
export const MERGE_ADVOCATE = 'merge-advocate';

/**
 * The checks this branch is failing that its base is **not** already failing — bc-y738,
 * answered by Adam in session on 2026-08-14.
 *
 * The strict reading of "verify the remaining gates" is that any red check stops the
 * merge, which is what `bin/deliver.js` does today ("a worker will not merge over a red
 * check — if it is a flake, that is your call to make"). It is also, on this repo, a
 * queue that merges nothing: `main` has been failing `test/reenter.mjs` for at least five
 * pushes (bc-f31f), so every branch inherits one red check before it has done anything,
 * and every pull request becomes a card — which is the state the MergeAdvocate exists to
 * end.
 *
 * A check that is red on the base is red on every branch cut from it and therefore says
 * nothing about *this* branch. What says something is the difference:
 *
 *     branch failing: [test/reenter, lint]
 *     base   failing: [test/reenter]
 *                new: [lint]              -> refuse, and raise the card
 *
 *     branch failing: [test/reenter]
 *     base   failing: [test/reenter]
 *                new: []                  -> merge, and name the baseline out loud
 *
 * Two conditions on that, both of which are the point rather than caveats. **Nothing new
 * gets through** — a check the branch broke is still a refusal, in the words of the check
 * that broke. And **it says so out loud**: what was merged over goes on the merge-bead and
 * into the notification, because a baseline that is silent is indistinguishable from no
 * gate at all, and bc-f31f is precisely the kind of red that stops being noticed once
 * something routes around it.
 *
 * **A null baseline is not an empty one.** `baseChecks` in lib/pr.js returns null when it
 * could not ask GitHub, and the caller must not read that as "the base is green" — that
 * reading turns every one of the base's red checks into a refusal. Unknown means fall
 * back to the strict rule, which is the safe direction: it stops merges rather than
 * letting them through.
 *
 * Names are compared exactly, because they are the same strings from the same GitHub API
 * folded through the same `rollup`. Normalising them here would be a second place for the
 * two sides to stop agreeing.
 */
export function newlyFailing(branchFailed, baseFailed) {
  const base = new Set((baseFailed || []).map((s) => String(s)));
  return [...new Set((branchFailed || []).map((s) => String(s)))].filter((name) => !base.has(name));
}

/**
 * Everything the gate decides, in one pure function of what GitHub said.
 *
 * Pure, and taking the two check rollups rather than fetching them, for the reason
 * `workPromptFor` in lib/session.js is pure: what is under test is the decision an
 * unattended queue makes about merging to `main`, and a test must be able to drive every
 * branch of it without a network, a checkout or a pull request.
 *
 * The order of the branches is not interchangeable, and it is `bin/deliver.js`'s order
 * because that order was already argued:
 *
 * 1. **Conflicting** first, because it is the only outcome with a *fix* rather than a
 *    verdict — the branch needs the base merged into it, which is the resolver's job, and
 *    the checks on a branch that cannot merge are about to be re-run anyway.
 * 2. **Still pending** — nothing has spoken, so there is nothing to be right about.
 * 3. **Newly failing** — the branch broke something. The names go in the sentence.
 * 4. **Awaiting approval**, and it is deliberately *not* a refusal: nothing was refused,
 *    because nothing was asked. bin/deliver.js keeps that distinction in a separate flag
 *    and it is kept here, because a card that says "it could not merge" over green checks
 *    and a satisfied policy sends you hunting for a switch that is already set the way you
 *    want it.
 * 5. **Merge.**
 *
 * `refused` is prose in the vocabulary of whatever refused, not of this file — GitHub's
 * own words when GitHub said no, the names of the checks when they are red, the number of
 * minutes when nothing reported. "Could not merge" is the one thing none of them says,
 * because that is the only part Adam can already see.
 */
export function gateVerdict({
  checks = null,
  baseline = null,
  baseHasChecks = null,
  mergeable = '',
  timedOut = false,
  waitMs = 0,
  reviewDecision = null,
  requireApproval = false,
  approved = false,
  checksAt = null,
  heldUntil = null,
} = {}) {
  const no = (refused, extra = {}) => ({
    merge: false,
    refused,
    awaitingApproval: false,
    conflicted: false,
    stale: false,
    baseline: [],
    ...extra,
  });

  if (String(mergeable || '').toUpperCase() === 'CONFLICTING') {
    return no(
      `GitHub reports the branch conflicts with its base, so the base has to come into the branch before ` +
        `anything can merge.`,
      { conflicted: true }
    );
  }

  const rollupOf = (c) => ({
    failed: c?.failed || [],
    failing: Number(c?.failing) || 0,
    pending: Number(c?.pending) || 0,
    total: Number(c?.total) || 0,
    state: String(c?.state || 'none'),
  });
  const branch = rollupOf(checks);

  if (timedOut || branch.state === 'pending') {
    const mins = Math.max(1, Math.round(Number(waitMs) / 60000));
    return no(
      `${branch.pending} of its ${branch.total} checks were still running after ${mins} minute${mins === 1 ? '' : 's'}, ` +
        `so it stopped waiting rather than merge over an unknown.`
    );
  }

  /**
   * A head commit with **zero** check runs is not the same thing as a head commit that
   * passed — bc-ysqd.1, and #480 on 2026-08-18 for what it costs to conflate the two.
   *
   * `rollup()` in lib/pr.js reports `state: 'none'` for an empty `statusCheckRollup`, and
   * nothing downstream used to distinguish that from `passing`: failing is 0 and pending
   * is 0 either way, so a commit nothing had ever run on fell straight through to
   * `merge: true`. That is exactly the shape a push authored with the Actions/Copilot
   * token leaves behind — it does not trigger a `pull_request` workflow, so the branch's
   * last real run stays on an older commit while the head it is about to merge has none.
   *
   * **Refused only when the base is known to run checks.** A workspace with no CI wired
   * up at all is a real configuration here, and refusing every `'none'` outright would
   * wedge it forever — every commit in a CI-less space is `'none'`, on both sides.
   * `baseHasChecks` is the caller's answer to "does *this* base have checks", asked once
   * per tick from the same `baseChecks` call already made for the baseline above, so this
   * costs nothing new. `false` is the only value that lets the merge through — a base
   * that positively has none either. `null` (the caller could not ask, or never checked)
   * falls back to refusing, for the same reason a null baseline falls back to the strict
   * rule below: guessing "this base has no checks" is the direction that would have let
   * #480 through, and neither guess is available here.
   */
  if (branch.state === 'none' && baseHasChecks !== false) {
    return no(
      `nothing ran on this commit at all — zero checks were reported for it, so there is nothing here that ` +
        `says this passed.`
    );
  }

  /**
   * A verdict measured against a base that is no longer there — bc-91srt.
   *
   * GitHub builds `refs/pull/N/merge`, so a check run is a verdict on **this branch
   * merged with the base as it stood when the run fired**. While the base is broken
   * every open pull request goes red, and those runs stay red afterwards because nothing
   * re-runs them. `newlyFailing` below cannot see any of that: it compares names against
   * the base's checks *now*, so once the base is repaired its failures drop out of the
   * baseline and the branch's stale red reads as a failure the branch introduced. #475
   * and #488 were both condemned that way on 2026-08-18, and neither was ever broken —
   * #475's own check was green by the time anybody looked.
   *
   * So a run that finished before the queue lifted its hold is **not evidence about this
   * branch**, and the honest answer is the one the pending branch above already gives:
   * wait. It costs no attempt, exactly as a pending check does, because nothing was
   * refused — nothing has been asked of this branch since the base came back. The
   * downmerge path re-runs the checks against what will actually land, which is what
   * makes this a wait rather than a deadlock: a branch whose checks predate the repair is
   * behind the repaired base by construction.
   *
   * **Both stamps have to be readable.** A missing or unparseable one means the question
   * cannot be asked, and then this must not answer it — falling through to the strict
   * rule is the direction that stops merges rather than letting them through.
   */
  const ranAt = Date.parse(String(checksAt || ''));
  const liftedAt = Date.parse(String(heldUntil || ''));
  if (Number.isFinite(ranAt) && Number.isFinite(liftedAt) && ranAt < liftedAt) {
    return no(
      `its checks last finished before the base came back, so they are a verdict on a base that is no longer ` +
        `there rather than on this branch. Nothing is counted against it until they have run again.`,
      { stale: true }
    );
  }

  // Unknown baseline falls back to the strict rule — see `newlyFailing`. `null` is the
  // only value that means unknown; an empty array is a base that is genuinely green.
  const known = Array.isArray(baseline);
  const already = known ? (baseline || []) : [];
  const fresh = known ? newlyFailing(branch.failed, already) : branch.failed;

  if (fresh.length) {
    const named = fresh.length ? ` (${fresh.join(', ')})` : '';
    const inherited = known && already.length
      ? ` The base is already failing ${already.join(', ')}, which is not counted against this branch — ` +
        `${fresh.length === 1 ? 'this one is' : 'these are'} new.`
      : '';
    return no(
      `${fresh.length} check${fresh.length === 1 ? '' : 's'} failing${named}.` +
        `${inherited} A merge queue will not merge over a check the branch broke — if it is a flake, that is your call.`
    );
  }

  // Everything green that this branch is answerable for. What it merged *over* travels
  // with the verdict, because the notification and the merge-bead both have to say it.
  const merged = known ? already.filter((name) => (branch.failed || []).includes(name)) : [];

  /**
   * Two ways to be approved, and the second exists because the first cannot happen here.
   *
   * `reviewDecision` is GitHub's, and it is the right answer wherever somebody else
   * reviews the branch. On this Mac nobody does: every pull request in the queue was
   * opened by a worker running under Adam's own token, and GitHub will not accept an
   * approving review from the author — so a `requireApproval` space would sit here
   * forever waiting on a review that is not available to give.
   *
   * `approved` is that approval given directly to the queue instead, off the merge-bead's
   * own state block (lib/mergeadmit.js, `beadcause-merge`). It is the same claim — *this
   * change is wanted* — from the same person, recorded where the queue can read it. What
   * it is not is a bypass: it is checked in this position and nowhere else, so a branch
   * with a failing check or a conflict is refused above with an approval sitting on it.
   */
  if (requireApproval && !approved && String(reviewDecision || '').toUpperCase() !== 'APPROVED') {
    return no('', { awaitingApproval: true, baseline: merged });
  }

  return { merge: true, refused: '', awaitingApproval: false, conflicted: false, stale: false, baseline: merged };
}

/**
 * The one sentence that must appear wherever a merge went out over a red check.
 *
 * Its own function because it is written in three places — the merge-bead, the close
 * reason, and the notification — and three copies of it is how two of them stop saying
 * it. Empty for the ordinary case, so a caller can concatenate it unconditionally.
 */
export function baselineNote(baseline) {
  const names = (baseline || []).map((s) => String(s)).filter(Boolean);
  if (!names.length) return '';
  return `Merged over ${names.length} check${names.length === 1 ? '' : 's'} the base is already failing: ${names.join(', ')}.`;
}

/**
 * The queue: every open merge-bead assigned to this agent, oldest first.
 *
 * Derived from the tracker rather than from a state file, for `assignedAdvocates`'
 * reason in lib/epicadvocate.js: a merge-bead belongs to the queue for as long as it is
 * open, and a list of windows gets that backwards — one whose window exited is still
 * queued, and one whose bead closed is not.
 *
 * Oldest first, by id rather than by a timestamp, because bd ids are allocated in order
 * and a stable order matters more here than a precise one: the alternative is a queue
 * that reshuffles between ticks, so the pull request that gets picked up is whichever
 * one happened to sort first this minute.
 *
 * Three exclusions, and each is a bead this would be wrong about rather than one it
 * cannot handle:
 *
 * - **A block that will not parse.** There is nothing to merge; acting would mean
 *   guessing at a pull request number. It stays in the list with its error so the caller
 *   can say so once, rather than skipping it silently for the rest of its life.
 * - **Out of attempts.** Past `MAX_ATTEMPTS` this is not a queue waiting for anything,
 *   it is a queue re-running one refusal forever. It becomes a card instead.
 * - **A resolver is on it.** One resolver per pull request is lib/resolvers.js's own
 *   rule and the reason its registry is in the daemon's memory; a queue that picked the
 *   same bead up again would be opening the second window that rule exists to prevent.
 *
 * The third one comes back as its own list rather than being dropped, and that is bc-91ft.
 * `resolving` is set when a resolver is *opened* and there is nothing anywhere that sets it
 * back — so for as long as this function answered by `continue`, a branch the queue handed
 * to a resolver left all three lists the moment it was handed over and never appeared in
 * any of them again. It was not deprioritised, it was unreachable: the resolver fixed the
 * branch, pushed it, GitHub reported it MERGEABLE and green, and the queue had no
 * representation of it left to act on. #339 sat clean and unmerged for an hour that way,
 * and nothing reported it, because a bead in none of the three lists is a bead no caller
 * can say a sentence about.
 *
 * So the exclusion stays — it is still wrong to merge a branch somebody is mid-merge in —
 * and it stops being *silent*. What clears the flag is `sweepMergeQueue`, which is the half
 * of this that can ask GitHub whether the conflict is still there; this function is pure
 * and has no business guessing.
 */
export function queueFor(beads, { assignee = MERGE_ASSIGNEE } = {}) {
  const rows = beads instanceof Map ? [...beads.values()] : Array.isArray(beads) ? beads : [];
  const want = String(assignee || '').trim().toLowerCase();
  const queued = [];
  const stuck = [];
  const broken = [];
  const resolving = [];
  for (const b of rows) {
    if (!isMergeBead(b)) continue;
    if (String(b?.status || '').toLowerCase() === 'closed') continue;
    if (want && String(b?.assignee || '').trim().toLowerCase() !== want) continue;
    const spec = mergeSpec(b);
    if (!spec || spec.error) {
      broken.push({ issue: b, spec: null, state: queueState(b), why: spec?.error || 'it carries no beadpr block' });
      continue;
    }
    const state = queueState(b);
    const entry = { issue: b, spec, state };
    if (state.resolving) {
      resolving.push(entry);
      continue;
    }
    if (state.attempts >= MAX_ATTEMPTS) stuck.push(entry);
    else queued.push(entry);
  }
  const byId = (x, y) => String(x.issue?.id || '').localeCompare(String(y.issue?.id || ''));
  return {
    queued: queued.sort(byId),
    stuck: stuck.sort(byId),
    broken: broken.sort(byId),
    resolving: resolving.sort(byId),
  };
}

/**
 * The pull requests this queue **gave up on** — every merge-bead it carded, still open.
 *
 * The inverse of `queueFor`, selected on the labels `raiseMergeCard` swaps: `merge-queue`
 * comes off and `human` plus the delivery label go on. That removal is the handover and it
 * stays a handover — nothing here merges anything, and nothing here decides a card was
 * wrong.
 *
 * ## Why a queue that hands over has to be able to take back
 *
 * `raiseMergeCard`'s doctrine is that the removal is one-way, and read as *the queue stops
 * acting* that is exactly right. What it also assumed, silently, is that **the reason
 * persists** — that a pull request handed over because a check was red is a pull request
 * with a red check when Adam looks at it. On this Mac that assumption is routinely false,
 * and the falseness is neither rare nor subtle:
 *
 *   - #475 was carded for a failing check. The check went green on its own; the card sat
 *     for a day, and the pull request merged within a minute of being put back.
 *   - #433 and #438 were carded while conflicting, with **passing checks**. A conflict is
 *     the one condition this queue is best at — it opens a resolver for exactly that — and
 *     both sat where no resolver would ever see them.
 *
 * None of those needed a decision. Each needed the queue to look again. A card that
 * outlives its reason is not a handover, it is a leak, and from outside it is
 * indistinguishable from a handover — which is why it went unnoticed for as long as it did.
 *
 * So this is the finding half of taking one back, and deliberately only that half: it
 * selects, and the caller (`sweepMergeQueue`) is what asks GitHub whether the recorded
 * refusal still holds. Pure, with no business guessing — `queueFor`'s own argument for
 * leaving `resolving` to the sweep.
 *
 * **What gets re-asked is the recorded refusal, not the pull request in general.** A card
 * whose sentence has gone stale is one the queue mis-holds; a card that is genuinely a
 * decision — Adam declined it, the approach was wrong — carries no lapsing sentence and is
 * never selected here, because nothing it says can stop being true.
 */
export function cardedFor(beads, { assignee = MERGE_ASSIGNEE, label = MERGE_LABEL, cardLabel = 'human' } = {}) {
  const rows = beads instanceof Map ? [...beads.values()] : Array.isArray(beads) ? beads : [];
  const want = String(assignee || '').trim().toLowerCase();
  const out = [];
  for (const b of rows) {
    if (String(b?.status || '').toLowerCase() === 'closed') continue;
    const labels = (b?.labels || []).map((l) => String(l).trim());
    // Still a merge-bead by assignment, no longer by label — precisely the state
    // `raiseMergeCard` leaves behind, and nothing else in the tree produces it.
    if (labels.includes(label)) continue;
    if (!labels.includes(cardLabel)) continue;
    if (want && String(b?.assignee || '').trim().toLowerCase() !== want) continue;
    const spec = mergeSpec(b);
    if (!spec || spec.error) continue;
    const state = queueState(b);
    // Nothing to withdraw. A card with no recorded sentence was not refused by the queue
    // — it is a delivery waiting on a decision, and putting it back would be the queue
    // taking work it was never given.
    if (!state.refused) continue;
    out.push({ issue: b, spec, state });
  }
  return out.sort((x, y) => String(x.issue?.id || '').localeCompare(String(y.issue?.id || '')));
}

/**
 * Open pull requests of ours that **no merge-bead is about** — bc-91srt.
 *
 * A pull request reaches this queue exactly one way: something files a merge-bead for it,
 * and the only things that do are `bin/deliver.js` and an admission. Nothing sweeps for
 * one. So a branch fixed and pushed *without* re-running deliver has no route back — and
 * it is invisible rather than merely late, because both lists anybody would look at
 * exclude it. `queueFor` cannot see it: there is no bead to select. And lib/inflight.js
 * deliberately **holds the work bead** whenever an open pull request carries it, so no
 * advocate opens a worker on it either. Held by one half, unqueued by the other, mentioned
 * by neither.
 *
 * Five pull requests were in that state on 2026-08-19, safe only because the sessions that
 * put them there were still alive to run deliver at the end. A window that dies takes its
 * pull request out of the system with it, and nothing anywhere says so.
 *
 * Pure, and answering with the pull requests rather than acting on them, because what to
 * *do* about one is not obvious and is not this file's call: the daemon can file a
 * merge-bead, raise it, or simply say it in the tick's line. What matters is that it stops
 * being unsayable.
 *
 * Every merge-bead's number counts as cover **whatever its labels** — carded or queued
 * alike — because the question is "is anything about this pull request", not "is it in the
 * queue". A card is not a strand; it is a handover, and reporting it here would bury the
 * real ones.
 */
export function strandedPrs(prs, beads, { assignee = MERGE_ASSIGNEE } = {}) {
  const rows = beads instanceof Map ? [...beads.values()] : Array.isArray(beads) ? beads : [];
  const want = String(assignee || '').trim().toLowerCase();
  const known = new Set();
  for (const b of rows) {
    if (String(b?.status || '').toLowerCase() === 'closed') continue;
    if (want && String(b?.assignee || '').trim().toLowerCase() !== want) continue;
    const spec = mergeSpec(b);
    if (!spec || spec.error) continue;
    const n = Number(spec.number);
    if (Number.isFinite(n)) known.add(n);
  }
  return (Array.isArray(prs) ? prs : [])
    .filter((pr) => {
      const n = Number(pr?.number);
      if (!Number.isFinite(n)) return false;
      // A draft is somebody still writing, exactly as lib/prsweep.js leaves one alone: it
      // has no business in a queue, so its absence from one is not a strand.
      if (pr?.isDraft) return false;
      if (String(pr?.state || 'OPEN').toUpperCase() !== 'OPEN') return false;
      return !known.has(n);
    })
    .sort((x, y) => Number(x.number) - Number(y.number));
}

/**
 * Is anything queued at all — asked of the cache that is already warm, before spending a
 * process on the answer.
 *
 * `sweepMergeQueue` needs each merge-bead's `description` (the `beadpr` block) and its
 * `notes` (the queue state), and `bd.graph()` carries neither for an ordinary bead — so
 * the queue's real read is `bd.listAgent`, one process per workspace. On a Mac with nine
 * workspaces that is nine spawns per poll cycle, for ever, to answer *no* on nearly every
 * one of them: the queue is empty most of the time, because most of the time nothing has
 * just been delivered.
 *
 * What `bd.graph()` *does* carry is `labels` and `assignee`, which is exactly enough to
 * answer "is there one here". It is one `bd export` per workspace per minute, already kept
 * warm by the epic board and lib/homing.js, so in a running daemon this costs nothing at all.
 *
 * **The cost of the gate is a minute of staleness**, and it is worth naming: a merge-bead
 * filed thirty seconds ago may not be in the cached index, so it waits one more cycle. A
 * pull request that waits an extra minute is not a cost anybody can feel; nine subprocess
 * spawns a minute on an idle laptop is.
 *
 * **A failed read is a yes.** `graph()` hands back `{ error }` rather than throwing when
 * the export fails, and reading that as "nothing queued" would stop the queue silently on
 * exactly the loaded Dolt where things are most likely to be waiting in it. Unknown falls
 * through to the real read, which is the direction that costs a spawn rather than a merge.
 */
export function anyQueued(index, { assignee = MERGE_ASSIGNEE, cardLabel = 'human' } = {}) {
  if (!index || index.error) return true;
  const beads = index.beads instanceof Map ? index.beads.values() : Array.isArray(index.beads) ? index.beads : null;
  if (!beads) return true;
  const want = String(assignee || '').trim().toLowerCase();
  for (const b of beads) {
    if (String(b?.status || '').toLowerCase() === 'closed') continue;
    if (want && String(b?.assignee || '').trim().toLowerCase() !== want) continue;
    if (isMergeBead(b)) return true;
    /**
     * **A card counts too, and without this the reclaim is dead code** — bc-91srt.
     *
     * This gate is what decides whether the sweep runs at all, and it was written when
     * the only thing the sweep could act on was a bead carrying `merge-queue`. Taking a
     * card back is by definition about a bead that has had that label *removed*, so a
     * workspace whose every merge-bead had been carded would answer "nothing queued"
     * for ever — and the one function written to rescue those beads would never be
     * reached. The failure would look exactly like the reclaim not working, in a
     * workspace where it is the only thing left to do.
     *
     * The cost this gate exists to avoid is bounded elsewhere rather than here: the
     * reclaim asks GitHub about a card at most once per `RECLAIM_COOLDOWN_MS`, so a
     * workspace sitting on ten cards spends ten views every ten minutes, not ten a
     * minute. Answering the cheap question honestly and bounding the expensive one is
     * the right way round — the alternative is a gate that lies about there being work.
     */
    const labels = (b?.labels || []).map((l) => String(l).trim());
    if (labels.includes(cardLabel)) return true;
  }
  return false;
}

/**
 * The brief, for one invocation — the failure path, which is the only thing that opens a
 * window here.
 *
 * The *role* — what a MergeAdvocate is, on every run — lives in lib/foundation.js and is
 * amendable. This is what it was asked *this time*, and the split is the one every other
 * agent here keeps: a foundation an agent can argue with, and a brief it cannot.
 *
 * The one thing this brief must get across, and it is the opposite of what a session
 * usually needs telling: **it did not write this code**. A worker opened on a bead knows
 * the reasons for its own diff and can fix a conflict properly. This agent is looking at
 * somebody else's branch with the reasons gone, and the failure mode is not that it
 * refuses too often — it is that it rewrites a stranger's intent to make a merge go
 * through. So the escalation is cheap and named: hand it back, with the sentence.
 *
 * **The window is bracketed by two things it has to say** (bc-kan5f), and they are not
 * the same statement. Step 1 is a *prediction*, posted on the pull request before the
 * tree is touched: what this is about to do and what it expects out of it. The closing
 * instruction at the foot is a *record*, on the bead, of what actually happened. Asking
 * for the prediction first is what makes the record worth reading — an advocate that
 * wrote "I expect this is the routine renumber" and then spent an hour has said something
 * the next window can use, and one that only ever reports afterwards has not. It also
 * fixes the thing the pull request could not say for itself: from GitHub's side a
 * conflicted branch is indistinguishable from an abandoned one, for as long as the
 * resolution takes.
 */
export function mergeAdvocatePrompt(workspace, issue, spec, state, { reason = '', owner = 'the owner', policy = {} } = {}) {
  const lines = [
    `You are the MergeAdvocate for **${issue.id}** in \`${workspace}\`: pull request #${spec.number} in ` +
      `\`${spec.repo || workspace}\`, which carries the work for **${spec.bead}**.`,
    '',
    reason ? `You were opened because ${reason}.` : 'You were opened because the merge did not go through on its own.',
    '',
    `- Branch: \`${spec.branch}\` → \`${spec.base}\``,
    `- Pull request: ${spec.url}`,
    `- Attempts so far: ${state.attempts}${state.attempts >= MAX_ATTEMPTS ? ' — this is the last one' : ''}`,
  ];
  if (state.refused) lines.push('', `**What stopped it last time:** ${state.refused}`);
  if (spec.tests) lines.push('', `**What the worker said it ran:** ${spec.tests}`);
  if (spec.risk) lines.push('', `**What the worker flagged as risky:** ${spec.risk}`);

  lines.push(
    '',
    '**Your job, in order.**',
    '',
    `1. Say on #${spec.number} that you have it, before you touch the tree. From GitHub's side a branch that ` +
      'will not merge simply sits there: nothing on the pull request says a resolution is underway, who is ' +
      'doing it, or what it is going to try — so the worker that opened it, and Adam scrolling past it on a ' +
      'phone, are reading a stalled branch. One comment, in your own words, covering what you are merging ' +
      `into what, what you expect to come out, and${state.attempts > 1 ? ' what stopped the last attempt' : ' any risk the worker flagged that you are going to read hardest'}: ` +
      `\`gh pr comment ${spec.number} --body '…'\`. Say what you *expect*, not what you hope — "this is the ` +
      'routine sw-cache renumber and I expect it green" and "these two sides disagree and I may hand it ' +
      'back" are the two useful things to have said in advance, and the second one is the more useful.',
    `2. Bring \`${spec.base}\` into \`${spec.branch}\` and resolve whatever conflicts that raises, in the ` +
      "branch's own checkout. Re-run the repo's tests afterwards — a clean merge of two working branches is not a " +
      'working tree.',
    '3. Push the branch. The checks re-run against what is actually going to land.',
    `4. If it is green — or red only where \`${spec.base}\` is already red — the queue merges it on its next ` +
      'tick: pushing a branch that no longer conflicts is what puts it back in front of the queue, which ' +
      'marked it as yours the moment it opened this window. You do not need to merge it by hand, and you ' +
      'should not.',
    '',
    '**You did not write this code, and that is the whole of what makes this job different.**',
    'The worker that wrote it knew why every line was there; you are looking at the diff with those reasons',
    'gone. Resolving a conflict by keeping whichever side makes the merge go through is the one failure that',
    'looks exactly like success from here — it merges, the checks pass, and the intent is quietly gone.',
    'Where the two sides genuinely disagree about what the code should do, that is not yours to settle.',
    '',
    `**Hand it back rather than guess.** Say so on ${issue.id} in one sentence naming what the two sides ` +
      `disagree about, and leave it for ${owner}. That is a good ending here, not a failure: this queue exists ` +
      'so that a merge nobody can make safely arrives as a decision rather than as a commit.',
    '',
    `**You may not close ${spec.bead}, and you may not merge by hand.** The queue closes both beads together ` +
      'when the merge lands, because the merge is what makes the work true. A bead closed here is a bead closed ' +
      'over work that is still on a branch.'
  );

  if (policy?.requireApproval) {
    lines.push(
      '',
      `**This repo waits for an approving review before anything merges.** Green checks are not enough on ` +
        `their own here, so even a perfect resolution ends with ${owner}'s tap. Do not read the wait as ` +
        'something you failed to fix.'
    );
  }

  lines.push(
    '',
    '**Before you exit, write down what you concluded.** You are re-entrant: this window closes and the next',
    `one starts from ${issue.id}, not from this conversation. Whatever you worked out about why this branch`,
    'would not merge belongs in a comment on it — including, especially, the case where you decided not to',
    'touch it.'
  );
  return lines.join('\n');
}

export { MERGE_ASSIGNEE, MERGE_LABEL, MAX_ATTEMPTS };
