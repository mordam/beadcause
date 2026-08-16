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
  mergeable = '',
  timedOut = false,
  waitMs = 0,
  reviewDecision = null,
  requireApproval = false,
  approved = false,
} = {}) {
  const no = (refused, extra = {}) => ({
    merge: false,
    refused,
    awaitingApproval: false,
    conflicted: false,
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

  return { merge: true, refused: '', awaitingApproval: false, conflicted: false, baseline: merged };
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
 */
export function queueFor(beads, { assignee = MERGE_ASSIGNEE } = {}) {
  const rows = beads instanceof Map ? [...beads.values()] : Array.isArray(beads) ? beads : [];
  const want = String(assignee || '').trim().toLowerCase();
  const queued = [];
  const stuck = [];
  const broken = [];
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
    if (state.resolving) continue;
    if (state.attempts >= MAX_ATTEMPTS) stuck.push(entry);
    else queued.push(entry);
  }
  const byId = (x, y) => String(x.issue?.id || '').localeCompare(String(y.issue?.id || ''));
  return { queued: queued.sort(byId), stuck: stuck.sort(byId), broken: broken.sort(byId) };
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
 * warm by the P0 board and lib/homing.js, so in a running daemon this costs nothing at all.
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
export function anyQueued(index, { assignee = MERGE_ASSIGNEE } = {}) {
  if (!index || index.error) return true;
  const beads = index.beads instanceof Map ? index.beads.values() : Array.isArray(index.beads) ? index.beads : null;
  if (!beads) return true;
  const want = String(assignee || '').trim().toLowerCase();
  for (const b of beads) {
    if (String(b?.status || '').toLowerCase() === 'closed') continue;
    if (!isMergeBead(b)) continue;
    if (want && String(b?.assignee || '').trim().toLowerCase() !== want) continue;
    return true;
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
    `1. Bring \`${spec.base}\` into \`${spec.branch}\` and resolve whatever conflicts that raises, in the ` +
      "branch's own checkout. Re-run the repo's tests afterwards — a clean merge of two working branches is not a " +
      'working tree.',
    '2. Push the branch. The checks re-run against what is actually going to land.',
    `3. If it is green — or red only where \`${spec.base}\` is already red — the queue merges it on its next ` +
      'tick. You do not need to merge it by hand, and you should not.',
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
