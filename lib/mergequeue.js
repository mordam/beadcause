/**
 * The tick — one pass over the merge queue, in the daemon.
 *
 * lib/mergeadvocate.js decides; this does. One function, called once per workspace per
 * poll cycle, that walks the open merge-beads and moves each one exactly one step:
 * downmerge, wait, merge, or hand over. Then it stops. Nothing here blocks on a check
 * that is still running, and that is the shape rather than an optimisation — see below.
 *
 * ## Why it does not wait
 *
 * `bin/deliver.js` waited: `pr.settle` polls for up to five minutes and the worker sat
 * there. That was correct for a process whose only job was one pull request. A daemon
 * tick serving every workspace cannot spend five minutes on one branch, and it does not
 * need to: the next tick is a minute away and the pull request will still be there. So a
 * branch whose checks are pending is left exactly where it is, **without spending an
 * attempt**, and looked at again next time. The queue is a state machine driven by
 * GitHub's own state, not a procedure with waits in it.
 *
 * That is also what makes the retry budget mean something. `MAX_ATTEMPTS` counts
 * *refusals* — things that will not fix themselves by being looked at again — and never
 * counts waits. A pull request can sit in the queue for an hour of pending checks and
 * still have all three of its attempts.
 *
 * ## The five outcomes
 *
 * Per merge-bead, in this order, because each one makes the next meaningful:
 *
 * 1. **Gone** — the pull request is merged or closed already, on github.com or by a tap.
 *    Nothing to do but finish the bookkeeping the merge would have done: close both
 *    beads. A queue that treated this as an error would strand every pull request Adam
 *    merged from his phone.
 * 2. **Behind** — the base has moved. `pr.updateBranch` asks GitHub to merge it in, which
 *    is the downmerge, and the tick ends there: the checks are now re-running against
 *    what is actually going to land, and judging the old ones would be judging a diff
 *    that no longer exists.
 * 3. **Conflicted** — the downmerge will not go in on its own. This is the one case that
 *    needs an agent, and it gets a resolver window through lib/resolvers.js, which owns
 *    one-window-per-pull-request and the two-at-a-time cap.
 * 4. **Pending** — nothing has spoken. Leave it.
 * 5. **A verdict** — `gateVerdict` in lib/mergeadvocate.js. Merge, or record the refusal
 *    and let the attempt count carry it towards a card.
 *
 * ## What it must not become
 *
 * The merge itself goes through the existing door (`pr.merge`, the same call the button
 * on the phone makes) and the deploy is not this module's business at all: a merge to
 * `origin/main` is picked up by the settle window in lib/release.js, which already
 * debounces four merges into one deploy. A queue in front of a deploy that works must not
 * grow a second one.
 */
import { baselineNote, gateVerdict, queueFor } from './mergeadvocate.js';
import { MAX_ATTEMPTS, mergeSpec, queueState, withQueueBlock } from './mergebead.js';
import { oweClose } from './owed.js';

/**
 * How many merge-beads one tick will act on.
 *
 * Two, and the number is about `main` rather than about cost. Every merge moves the base
 * under every other branch in the queue, so the second merge in a tick is judged against
 * checks that ran before the first one landed — which is the stale-baseline problem this
 * whole queue exists to fix, reintroduced inside a single pass. Two is enough that a
 * backlog drains at a useful rate and small enough that the second one is looked at again
 * before a third goes out.
 *
 * Reads and downmerges are not merges and are not counted against it: a tick may update
 * ten branches and merge two.
 */
export const MERGES_PER_TICK = 2;

/**
 * How many times one pull request will be downmerged before it is judged as it stands.
 *
 * See the `BEHIND` branch below for the argument. Three, for the same reason
 * `MAX_ATTEMPTS` is three: the thing being waited for either resolves within a tick or
 * two or is not going to, and past that the wait has stopped being a wait.
 */
export const MAX_DOWNMERGES = 3;

const first = (err) => String(err?.message || err || '').split('\n')[0];
const iso = () => new Date().toISOString();

/**
 * One pass. Returns what happened, in a shape the advocate's note is built from and a
 * test can assert without a network.
 *
 * Everything effectful arrives as an argument, for `sweepInMain`'s reason in lib/inmain.js
 * and `workPromptFor`'s in lib/session.js: what is under test here is a decision procedure
 * that merges to `main`, and a test must be able to drive every branch of it without a
 * checkout, a tracker or GitHub.
 *
 * - `bd` — the tracker (lib/bd.js), for the rows, the notes and the two closes.
 * - `resolve(spec)` — the checkout a pull request's `gh` calls must run in, or a sentence
 *   saying why there isn't one. In a workspace of forty repos this is the whole of
 *   bc-l853.6: `gh pr merge 123` in the wrong checkout merges a different repo's #123,
 *   and it does not fail while doing it.
 * - `prApi` — lib/pr.js, injected so a test can hand back states rather than mock a
 *   process.
 * - `openResolver(entry, dir)` — a resolver window on a conflicted branch. Truthy when one
 *   opened; the bead is marked `resolving` so the queue leaves it alone until it is not.
 * - `raise(entry, why)` — hand it to Adam. lib/mergeadvocate.js's failure path.
 * - `afterMerge(entry, landed, dir)` — the sweep and the local `main`, which are
 *   lib/mergesweep.js's and lib/prboard.js's and belong to whatever wired this up.
 * - `markMerged(beadId)` — rename the window that delivered this branch from `QUEUED-`
 *   to `DONE-`, which is lib/retitle.js. Injected rather than imported for the reason
 *   everything else here is: a test asserting the queue said "this landed" should not
 *   have to own a `~/.claude` directory to hear it.
 */
export async function sweepMergeQueue(
  bd,
  ws,
  {
    rows = null,
    policy = {},
    resolve,
    prApi,
    openResolver = null,
    raise = null,
    afterMerge = null,
    markMerged = null,
    limit = MERGES_PER_TICK,
    log = () => {},
  } = {}
) {
  const out = { ok: false, reason: '', queued: 0, merged: [], updated: [], waiting: [], refused: [], raised: [], stuck: [] };

  let beads = rows;
  if (!beads) {
    try {
      beads = await bd.listAgent(ws);
    } catch (err) {
      out.reason = `bd list failed — ${first(err)}`;
      return out;
    }
  }

  const { queued, stuck, broken } = queueFor(beads);
  out.ok = true;
  out.queued = queued.length;
  out.stuck = stuck.map((e) => e.issue.id);

  /**
   * The two populations that never move on their own, dealt with before the queue.
   *
   * A merge-bead out of attempts and one whose block will not parse are both beads the
   * queue is done with, and the worst thing it could do with either is leave it sitting
   * there looking queued. `raise` turns each into a card; without one wired up they are
   * still reported, because a merge-bead nobody is acting on and nobody has said anything
   * about is the failure mode this whole epic replaces.
   */
  for (const entry of [...stuck, ...broken]) {
    if (!raise) continue;
    const why =
      entry.why ||
      `it has been tried ${entry.state.attempts} times and stopped at the same place each time. ${entry.state.refused || ''}`.trim();
    try {
      const raised = await raise(entry, why);
      if (raised) out.raised.push(entry.issue.id);
    } catch (err) {
      log(`could not hand ${entry.issue.id} over — ${first(err)}`);
    }
  }

  let merges = 0;

  for (const entry of queued) {
    if (merges >= limit) {
      // Said out loud rather than silently truncated: a queue that stops after two and
      // reports nothing reads as a queue with two things in it. See the note on
      // MERGES_PER_TICK for why it stops at all.
      out.waiting.push(...queued.slice(queued.indexOf(entry)).map((e) => e.issue.id));
      log(`${queued.length - merges} more on the queue — ${limit} merges is one tick's worth`);
      break;
    }

    const { issue, spec, state } = entry;
    let where;
    try {
      where = await resolve(spec);
    } catch (err) {
      await record(bd, ws, issue, state, first(err), []);
      out.refused.push(issue.id);
      continue;
    }
    if (!where?.dir) {
      await record(bd, ws, issue, state, where?.reason || `no checkout on this Mac is ${spec.repo}`, []);
      out.refused.push(issue.id);
      continue;
    }

    let view;
    try {
      view = await prApi.view(where.dir, spec.number);
    } catch (err) {
      // A pull request `gh` will not answer about is not a refusal — it is a network, a
      // rate limit or a token, and none of those is this branch's fault. Left where it is.
      log(`${issue.id}: could not read #${spec.number} — ${first(err)}`);
      out.waiting.push(issue.id);
      continue;
    }

    /* ------------------------------------------------------------------- 1. gone */
    if (String(view.state || '').toUpperCase() !== 'OPEN') {
      const how = view.mergedAt ? `merged as ${String(view.mergeCommit || '').slice(0, 8) || 'a commit'}` : 'closed';
      if (view.mergedAt) {
        await finish(bd, ws, issue, spec, {
          landed: view,
          baseline: [],
          how: `#${spec.number} was ${how} outside the queue`,
          markMerged,
        });
        out.merged.push(issue.id);
      } else {
        // Closed unmerged is Adam declining it, and the work bead does **not** close: the
        // whole point of a decline is that the work goes back in the queue.
        await bd
          .close(ws, issue.id, `#${spec.number} was closed without merging, so there is nothing left to merge.`, { overClaim: true })
          .catch((err) => log(`${issue.id}: could not close over a closed pull request — ${first(err)}`));
        out.refused.push(issue.id);
      }
      continue;
    }

    const mergeState = String(view.mergeState || '').toUpperCase();
    const mergeable = String(view.mergeable || '').toUpperCase();

    /* ------------------------------------------------------------- 3. conflicted */
    // Before `behind`, because a conflicted branch is also behind and asking GitHub to
    // update it would only produce the refusal we already have in hand.
    if (mergeable === 'CONFLICTING' || mergeState === 'DIRTY') {
      const opened = openResolver ? await openResolver(entry, where.dir).catch((err) => log(`${issue.id}: ${first(err)}`)) : null;
      if (opened) {
        await note(bd, ws, issue, { ...state, resolving: true, at: iso(), refused: 'the branch conflicts with its base' });
        out.raised.push(issue.id);
      } else {
        await record(
          bd,
          ws,
          issue,
          state,
          `the branch conflicts with \`${spec.base}\` and nothing could be opened to resolve it.`,
          []
        );
        out.refused.push(issue.id);
      }
      continue;
    }

    /* ------------------------------------------------------------------ 2. behind */
    /**
     * The downmerge — and the one place this loop could starve a pull request forever.
     *
     * A branch is `BEHIND` whenever anything has landed since it was last updated, and
     * updating it re-runs its checks. On a busy afternoon `main` can move faster than CI
     * finishes, so a queue that unconditionally downmerged-and-waited would hand each
     * branch a fresh base every tick and never once get as far as judging it. The pull
     * request would look busy and never merge, which is the failure mode hardest to
     * notice: every individual tick is doing something sensible.
     *
     * `MAX_DOWNMERGES` is the bound. Past it the branch is judged as it stands — which is
     * safe, because being behind is not by itself a reason GitHub will refuse a merge
     * (only a repo with "require branches to be up to date" turns it into one, and that
     * refusal comes back through `pr.merge` as a sentence like any other). What the
     * downmerge buys is that the checks ran against something close to what will land,
     * and three attempts at that is as much as it is worth spending.
     *
     * Counted separately from `attempts`, deliberately: a downmerge is not a refusal, and
     * folding the two would mean a branch that was merely unlucky about timing being
     * handed to Adam as one that could not be merged.
     */
    if (mergeState === 'BEHIND' && (state.downmerges || 0) < MAX_DOWNMERGES) {
      const { updated, reason } = await prApi.updateBranch(where.dir, spec.number);
      if (updated) {
        await note(bd, ws, issue, { ...state, downmerges: (state.downmerges || 0) + 1, at: iso() });
        out.updated.push(issue.id);
        log(`${issue.id}: brought ${spec.base} into ${spec.branch} — its checks are re-running`);
      } else {
        // Not an attempt, and not a downmerge either. GitHub refusing an update is very
        // often a race with somebody else's merge landing a second earlier, and the next
        // tick asks again.
        out.waiting.push(issue.id);
        log(`${issue.id}: could not bring ${spec.base} in — ${reason}`);
      }
      continue;
    }
    if (mergeState === 'BEHIND') {
      log(`${issue.id}: behind ${spec.base} for the ${MAX_DOWNMERGES}th time — judging it as it stands rather than chasing a base that keeps moving`);
    }

    /* ----------------------------------------------------------------- 4 and 5 */
    const baseline = await prApi.baseChecks(where.dir, spec.base).catch(() => null);
    const verdict = gateVerdict({
      checks: view.checks,
      baseline: baseline ? baseline.failed : null,
      mergeable,
      timedOut: false,
      reviewDecision: view.reviewDecision,
      requireApproval: !!policy.requireApproval,
      // Adam's own approval, given to the queue rather than to GitHub — see the branch in
      // `gateVerdict` and lib/mergeadmit.js. It rides on the bead, so it survives the tick
      // that raised the card asking for it.
      approved: !!state.approved,
    });

    if (!verdict.merge && !verdict.refused && verdict.awaitingApproval) {
      // A wait, not a refusal — nothing was asked, so nothing was refused. It costs no
      // attempt and it is raised once rather than every tick: `raise` is what puts the
      // card in the inbox where the approval is one tap, and the `resolving` flag is
      // reused to mean "somebody has been asked about this one".
      if (!state.resolving && raise) {
        const raised = await raise(entry, '', { approval: true, baseline: verdict.baseline }).catch((err) =>
          log(`${issue.id}: ${first(err)}`)
        );
        if (raised) await note(bd, ws, issue, { ...state, resolving: true, at: iso() });
      }
      out.waiting.push(issue.id);
      continue;
    }

    if (!verdict.merge) {
      /**
       * Pending is `gateVerdict`'s refusal and this tick's wait, and the disagreement is
       * deliberate rather than an oversight.
       *
       * That sentence — "N of M checks were still running after five minutes" — was
       * written for `bin/deliver.js`, a process whose whole job was one pull request and
       * which really had waited. Nothing here waits, so nothing here has run out of
       * patience: the next tick is a minute away. Spending an attempt on it would mean a
       * pull request with slow CI reaching Adam as a card three ticks after it was filed,
       * with nothing wrong with it.
       */
      if (String(view.checks?.state || '') === 'pending') {
        out.waiting.push(issue.id);
        continue;
      }
      await record(bd, ws, issue, state, verdict.refused, verdict.baseline);
      out.refused.push(issue.id);
      continue;
    }

    /* --------------------------------------------------------------- the merge */
    let landed;
    try {
      // `deleteBranch: false` for lib/tidy.js's reason, which is unchanged by the merge
      // moving here: the worktree sweep finds out a pull request landed by asking about
      // its branch, so the branch outliving the merge is load-bearing.
      landed = await prApi.merge(where.dir, spec.number, { method: spec.method, deleteBranch: false });
    } catch (err) {
      await record(bd, ws, issue, state, first(err).replace(/[.!?]?$/, '.'), verdict.baseline);
      out.refused.push(issue.id);
      continue;
    }

    merges += 1;
    if (afterMerge) {
      try {
        await afterMerge(entry, landed, where);
      } catch (err) {
        // The merge has happened. Nothing this throws can un-happen it, and a sweep that
        // failed is a red chip on a board rather than a lost merge — lib/mergesweep.js
        // makes the same argument about its own record.
        log(`${issue.id}: merged #${spec.number}, but the sweep behind it did not run — ${first(err)}`);
      }
    }
    await finish(bd, ws, issue, spec, { landed, baseline: verdict.baseline, how: '', markMerged });
    out.merged.push(issue.id);
  }

  return out;
}

/**
 * Write the queue's state back, and nothing else.
 *
 * A read-modify-write of the whole `notes` field, because bd has no way to edit part of
 * one — `withQueueBlock` cuts the block out by its markers so anything else in there
 * survives.
 */
async function note(bd, ws, issue, state) {
  const notes = withQueueBlock(issue.notes || '', state);
  await bd.update(ws, issue.id, { notes }).catch(() => {});
}

/** A refusal: one more attempt, the sentence, and what it was measured against. */
async function record(bd, ws, issue, state, refused, baseline) {
  const attempts = (state.attempts || 0) + 1;
  await note(bd, ws, issue, { ...state, attempts, refused, baseline, at: iso(), resolving: false });
  const left = MAX_ATTEMPTS - attempts;
  await bd
    .comment(
      ws,
      issue.id,
      `The merge queue did not merge this: ${refused}` +
        (left > 0
          ? ` It will try again — ${left} attempt${left === 1 ? '' : 's'} left.`
          : ' That was its last attempt, so this is now a decision rather than a retry.')
    )
    .catch(() => {});
}

/**
 * Both beads, closed together, in the order the close gate allows.
 *
 * The merge-bead first, and it has to be: the work bead depends on it, and the gate
 * refuses a close over an open blocker. That dependency is the entire mechanism by which
 * a worker cannot close its own work, so it is also the thing that dictates the order
 * here — which is worth saying, because "close the work, then tidy up the queue entry" is
 * the order it reads like it should be.
 *
 * **An epic work bead stays open.** `landHere` in bin/deliver.js carved that out and the
 * carve-out travels with the close: an umbrella epic is finished when its theme is, and a
 * branch that shared its name merging is no evidence about that.
 *
 * Every close is best-effort and says so on failure rather than throwing. The merge has
 * already happened by the time any of this runs; a tracker that will not take the close
 * is a bead to fix, not a merge to undo.
 */
async function finish(bd, ws, issue, spec, { landed, baseline, how, markMerged = null }) {
  const sha = String(landed?.mergeCommit || '').slice(0, 8);
  const where = `#${spec.number}${sha ? ` as ${sha}` : ''}`;
  const over = baselineNote(baseline);

  /**
   * The window that delivered this, told that it landed — before either close, because
   * this is the only moment anything knows both the bead and the fact of the merge, and
   * because the reaper is about to close the window on the strength of those closes.
   *
   * It is a claim about the *window*, not about the bead's lifecycle, which is why it
   * happens above the epic carve-out below: an umbrella epic stays open over a merged
   * branch, but the session that wrote the branch is just as finished either way, and a
   * window left saying `QUEUED-` forever reads as still waiting on a queue that is done
   * with it. Best-effort, and never allowed to stand between a merge and its close.
   */
  if (markMerged && spec.bead) {
    try {
      await markMerged(spec.bead);
    } catch (err) {
      console.error(`[merge-queue] ${spec.bead}: merged ${where} but its window kept its old name — ${first(err)}`);
    }
  }

  await bd
    .close(ws, issue.id, `${how || `Merged ${where}`}.${over ? ` ${over}` : ''}`, { overClaim: true })
    .catch((err) => console.error(`[merge-queue] ${issue.id}: merged ${where} but the merge-bead did not close — ${first(err)}`));

  const work = spec.bead;
  if (!work) return;

  let row = null;
  try {
    row = await bd.show(ws, work);
  } catch {
    /* Gone, renamed, or a tracker that will not answer. Said below rather than guessed at. */
  }
  if (row && String(row.issue_type || '').toLowerCase() === 'epic') {
    await bd
      .comment(ws, work, `This epic stays **open** over ${where}: an epic closes when its theme is done, not when a branch sharing its name merges.`)
      .catch(() => {});
    return;
  }

  await bd
    .comment(ws, work, `Merged ${where} by the merge queue.${over ? ` ${over}` : ''}`)
    .catch(() => {});

  const reason = `Merged ${where}.${over ? ` ${over}` : ''}`;
  try {
    await bd.close(ws, work, reason, { overClaim: true });
  } catch (err) {
    /**
     * A refused close is a state, not a rumour — lib/owed.js, and the same handling
     * `landHere` in bin/deliver.js gave it before the merge moved here.
     *
     * The ordinary cause is another blocker on the work bead that has nothing to do with
     * this pull request, and it clears on its own. What must not happen is the one thing
     * the tap on the phone used to do: report it as closed. bc-ec6 stayed open over a
     * merged pull request with two separate comments claiming otherwise, and the whole
     * reason it was hard to see is that everything upstream said it had worked.
     */
    const why = first(err);
    console.error(`[merge-queue] ${work}: merged ${where} but the work bead did not close — ${why}`);
    try {
      oweClose({ workspace: ws?.name || String(ws), id: work, reason, why });
    } catch {
      /* The log line above is the record of last resort. */
    }
    await bd
      .comment(ws, work, `This is merged and this bead did **not** close: ${why}. beadcause retries the close once that clears.`)
      .catch(() => {});
  }
}

/** One line for the advocate's card, or `''` when the queue had nothing to say. */
export function describeMergeQueue(out) {
  if (!out?.ok) return out?.reason ? `merge queue: ${out.reason}` : '';
  const bits = [];
  if (out.merged.length) bits.push(`merged ${out.merged.length}`);
  if (out.updated.length) bits.push(`${out.updated.length} downmerged`);
  if (out.refused.length) bits.push(`${out.refused.length} refused`);
  if (out.raised.length) bits.push(`${out.raised.length} handed over`);
  if (out.waiting.length) bits.push(`${out.waiting.length} waiting`);
  if (!bits.length) return '';
  return `merge queue: ${bits.join(' · ')}`;
}
