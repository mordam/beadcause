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
 * ## The six outcomes
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
 * 3. **Unreviewed** — where a workspace asks for a review, nothing merges until one has
 *    happened: no verdict is a wait, a reviewer's comments open the worker's window
 *    again, and a refusal or the round cap becomes a card. lib/reviewgate.js, bc-36xx.4.
 * 4. **Conflicted** — the downmerge will not go in on its own. This is the one case that
 *    needs an agent, and it gets a resolver window through lib/resolvers.js, which owns
 *    one-window-per-pull-request and the two-at-a-time cap. And exactly one window: a
 *    resolver that ends with the branch still conflicting has *declined* it, which is an
 *    ending its brief offers it, and that is a refusal like any other rather than a reason
 *    to open the next one — bc-5mdsw, and `declined` in lib/mergebead.js.
 * 5. **Pending** — nothing has spoken. Leave it.
 * 6. **A verdict** — `gateVerdict` in lib/mergeadvocate.js. Merge, or record the refusal
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
import { baselineNote, cardedFor, failureNote, gateVerdict, queueFor, strandedPrs } from './mergeadvocate.js';
import {
  MAX_ATTEMPTS,
  MAX_RECLAIMS,
  MERGE_LABEL,
  mergeSpec,
  queueState,
  refusalKey,
  reviewState,
  withQueueBlock,
  withReviewBlock,
} from './mergebead.js';
import { DELIVERY_LABEL } from './delivery.js';
import { judgeReview, reviewGated, reviewRefusal } from './reviewgate.js';
import { REVIEW_ADVOCATE, approvalComment, approvalNote, approvedReview } from './reviewadvocate.js';
import { freshVerdict, inlineComments, reviewFromVerdict } from './reviewsync.js';
import { fileReviewFollowUp, followUpFrom, followUpOwed, followUpSentence } from './reviewfollowup.js';
import { advocatedRootOver } from './followupnudge.js';
import { homeIn } from './homing.js';
import { oweClose } from './owed.js';
import { approvalHold, approvalRefusal } from './approval.js';
import { exemptFrom, holdRefusal } from './redbase.js';

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
 * - `resolverOn(entry)` — and the other end of it: is a resolver *still* on this pull
 *   request, live or in line for one of the two slots? lib/resolvers.js is the answer and
 *   the daemon is the only process that may hold it, which is why this arrives as a
 *   function rather than an import. `false` on a branch that still conflicts is the one
 *   thing `resolving` cannot say by itself — the window ended without making the branch
 *   mergeable — and it is what turns a stand-down into a spent attempt (bc-5mdsw). Not
 *   wired, and the branch is simply left flagged, exactly as it was before.
 * - `openAnswer(entry, dir)` — the worker again, on a pull request its reviewer has
 *   commented on (`openReviewAnswerSession`, lib/session.js). Truthy when one opened, or
 *   when this Mac is at its cap and it is in line; the same three-answers-count reading
 *   `openResolver` documents, because it is the same registry.
 * - `openReview(entry, dir, outcome)` — the reviewer, on a pull request nothing has judged yet
 *   (`openReviewAdvocateSession`, lib/session.js). The same registry and the same reading
 *   again, and it is the *other half* of `openAnswer`: between them they are the whole
 *   review loop, one window at a time per pull request whichever of them opened it.
 *   `outcome` is the gate's own decision, passed on because `outcome.why` is the sentence
 *   the window is opened *because* — "nothing has reviewed this pull request yet" and "the
 *   worker has answered every comment from round 1" are two very different briefs, and the
 *   gate is the only thing that already knows which one this is.
 * - `raise(entry, why)` — hand it to Adam. lib/mergeadvocate.js's failure path.
 * - `afterMerge(entry, landed, dir)` — the sweep and the local `main`, which are
 *   lib/mergesweep.js's and lib/prboard.js's and belong to whatever wired this up.
 * - `markMerged(beadId)` — rename the window that delivered this branch from `QUEUED-`
 *   to `DONE-`, which is lib/retitle.js. Injected rather than imported for the reason
 *   everything else here is: a test asserting the queue said "this landed" should not
 *   have to own a `~/.claude` directory to hear it.
 * - `tellAdvocate({ root, title, followUp, spec, issue })` — the Epic Advocate of the root a review
 *   follow-up was just filed under, told that it is there (bc-9ntye.3, `tellEpicAdvocate`
 *   in lib/followupnudge.js). Injected for `markMerged`'s reason one step stronger: the
 *   real one types into an iTerm window, and a suite that merged a fake pull request must
 *   never be able to reach a session on Adam's Mac. Called on the few merges that actually
 *   filed a follow-up under an *advocated* root, and on no others — see `askAdvocate`.
 * - `holdFor(spec, where)` — is this pull request's base red, and is somebody fixing it?
 *   lib/redbase.js, and the reason it is a *function* of the spec rather than a flag on
 *   the sweep: "the base is red" is a fact about one repository on one branch, and a
 *   workspace of forty checkouts has forty independent answers. Asked here, at the point
 *   a merge is about to be judged, so the reading is taken exactly where the harm is and
 *   costs nothing at all in a workspace with an empty queue.
 * - `owner` — whose pull request this is, for the sentences a folded-in review verdict
 *   carries onto GitHub (`approvalNote`, `approvalComment`, lib/reviewadvocate.js): "Adam
 *   has not read this diff" and its like. Not asked of anything on the happy path where no
 *   verdict is waiting to be folded in.
 */
/**
 * How long a carded pull request is left alone between re-askings — bc-91srt.
 *
 * Ten minutes, and the number is about what it is watching rather than about cost alone.
 * A card's reason lapses on the world's schedule: a check run finishes, a base is
 * repaired, a resolver pushes. None of that happens at tick resolution, so asking every
 * minute buys nothing and spends a GitHub round trip per card per workspace to learn the
 * same answer ten times over.
 *
 * It is also what makes `anyQueued` safe to widen. That gate now answers *yes* while any
 * card exists, which is what makes the reclaim reachable at all; this is the bound that
 * stops the honest answer becoming a busy loop.
 */
const RECLAIM_COOLDOWN_MS = 10 * 60 * 1000;

export async function sweepMergeQueue(
  bd,
  ws,
  {
    rows = null,
    policy = {},
    resolve,
    prApi,
    openResolver = null,
    resolverOn = null,
    openAnswer = null,
    openReview = null,
    raise = null,
    /**
     * Does a bead this workspace files arrive workable, or held? — `autoEndorseAllowed`
     * in lib/spaces.js, asked by the caller and handed in rather than read here.
     *
     * It is on the queue's options because of bc-9ntye.2: a merge over open review
     * findings files a follow-up bead, and a follow-up born `unendorsed` in a workspace
     * that endorses everything automatically is work nothing will ever open a session on
     * — which is the whole of what the epic asked for, undone by a default. Off unless
     * asked, for `reviewGated`'s reason: a caller that has not answered the question gets
     * the hold rather than a bead let loose on an answer nobody gave.
     */
    autoEndorse = false,
    afterMerge = null,
    markMerged = null,
    /**
     * Who is told that a review follow-up landed — bc-9ntye.3, and `null` is a queue that
     * files the bead and tells nobody, which is every existing caller and every test that
     * does not care. See the callback list above and lib/followupnudge.js for why the
     * silent case is correct rather than a gap: an unclaimed bead under a root is already
     * what `bd ready` and the re-entry sweep are for.
     */
    tellAdvocate = null,
    holdFor = null,
    owner = 'a person',
    limit = MERGES_PER_TICK,
    log = () => {},
  } = {}
) {
  const out = {
    ok: false,
    reason: '',
    queued: 0,
    merged: [],
    updated: [],
    waiting: [],
    refused: [],
    raised: [],
    stuck: [],
    reclaimed: [],
    restored: [],
    stranded: [],
    held: [],
    awaiting: [],
    answering: [],
    reviewing: [],
  };

  let beads = rows;
  if (!beads) {
    try {
      beads = await bd.listAgent(ws);
    } catch (err) {
      out.reason = `bd list failed — ${first(err)}`;
      return out;
    }
  }

  const { queued, stuck, broken, resolving } = queueFor(beads);
  out.ok = true;

  /**
   * Give back the branches a resolver has already fixed — bc-91ft.
   *
   * `resolving` is written when a resolver window is *opened* (the conflicted path below)
   * and nothing anywhere writes it back. The only reset in the tree is `admittedState` in
   * lib/mergeadmit.js, which is a human re-approving — so until this ran, a branch the
   * queue handed to a resolver needed Adam to approve it a second time no matter how
   * completely the resolver had done its job. #339 was resolved, pushed, green on its own
   * checks and MERGEABLE for an hour while the queue could not see it at all.
   *
   * **The flag is right and stays.** lib/server.js records it for all three of opened,
   * queued and reused precisely so a branch merely waiting for a resolver slot is not
   * mistaken for one nothing can fix and does not start spending its attempts. What was
   * missing is the other end: it means *in progress*, and nothing ever observed it
   * finishing.
   *
   * **So ask GitHub rather than trust the flag**, which is `recheck`'s argument in
   * lib/resolvers.js one layer up: a claim made when the window opened is worth less than
   * the answer now, because in between a resolver may have pushed, Adam may have merged it
   * from his phone, or `main` may have moved again. A pull request that is no longer
   * CONFLICTING is one whose resolver has nothing left to do — conflict is the only reason
   * this path opens one — so the flag comes off and the bead rejoins the queue *this*
   * tick, judged by every gate below exactly as if it had never conflicted.
   *
   * **Anything unknown leaves it flagged**, which is the direction that costs a tick
   * rather than a merge: no checkout, `gh` refusing to answer, a state that is still dirty
   * — all of them mean the resolver may still be in that tree, and merging a branch
   * somebody is mid-merge in is bc-utyr with the queue holding the knife. Left alone, it
   * is asked again next tick.
   */
  for (const entry of resolving) {
    const { issue, spec, state } = entry;
    let view;
    let unresolved = false;
    try {
      const where = await resolve(spec);
      if (!where?.dir) throw new Error(where?.reason || `no checkout on this Mac is ${spec.repo}`);
      const answer = await prApi.mergeability(where.dir, spec.number, { timeoutMs: 0 });
      view = answer.pr;
      unresolved = !!answer.unresolved;
    } catch (err) {
      log(`${issue.id}: still marked as being resolved, and could not check #${spec.number} — ${first(err)}`);
      continue;
    }
    /**
     * `UNKNOWN` is the absence of GitHub having said anything, and it is not a resolution.
     *
     * Mergeability is computed asynchronously and comes back `UNKNOWN` for every open pull
     * request for a window right after a merge lands — which is precisely when this sweep
     * runs. The old read here tested `!== 'CONFLICTING'`, so a non-answer cleared the flag,
     * the branch rejoined the queue still conflicting, went round the conflicted path and
     * got another resolver, spending nothing each lap. Eight of those laps for #488 in one
     * log. `mergeability` in lib/pr.js is the answer and has been since the first week —
     * lib/prsweep.js has routed every candidate through it all along; this file simply
     * never adopted it. At `timeoutMs: 0` it costs the same one `gh pr view` it always did
     * and adds only the reading, because a tick does not wait: see the top of this file.
     */
    if (unresolved) continue;
    const settled = String(view.mergeable || '').toUpperCase() !== 'CONFLICTING' && String(view.mergeState || '').toUpperCase() !== 'DIRTY';
    if (settled) {
      await note(bd, ws, issue, { ...state, resolving: false, declined: false, refused: null, at: iso() });
      queued.push({ ...entry, state: { ...state, resolving: false, declined: false, refused: null } });
      out.reclaimed.push(issue.id);
      log(`${issue.id}: #${spec.number} no longer conflicts, so it is back on the queue`);
      continue;
    }
    /**
     * And the ending nothing here could see until bc-5mdsw: the resolver is **gone** and
     * the branch still conflicts.
     *
     * `resolverOn` is the daemon's own registry (lib/resolvers.js) — the same one that
     * decides one window per pull request — asked whether it still holds this one, live or
     * in line for a slot. A record it still holds, a record restored across a restart with
     * no handle, or a queued entry all answer *yes*: something is on it, leave it alone.
     * Nothing at all is the honest ending a resolver's brief offers it, where both sides
     * of the conflict are load-bearing and only Adam can say which wins — and it is the
     * one thing `resolving` on its own cannot distinguish from work in progress.
     *
     * So it spends an attempt, which is the whole of the bug: a resolver spends none, the
     * flag came off only when the branch stopped conflicting, and a branch that never
     * stopped conflicting therefore had no route to `MAX_ATTEMPTS` and no route to a card.
     * #488 collected nine windows on byte-identical state and never ejected; it escaped
     * only because its conflict eventually turned into a red check, which is a *different*
     * path and one that does record.
     *
     * `declined` goes on with it so the door does not open again — see `queueState` in
     * lib/mergebead.js. Without a predicate wired up this is skipped entirely and the flag
     * stays, which is the old behaviour and the safe direction: not knowing whether a
     * window is open must never be read as knowing that none is.
     */
    if (!resolverOn) continue;
    let held;
    try {
      held = await resolverOn(entry);
    } catch (err) {
      log(`${issue.id}: could not tell whether a resolver is still on #${spec.number} — ${first(err)}`);
      continue;
    }
    if (held) continue;
    await record(bd, ws, issue, { ...state, declined: true }, declinedRefusal(spec), []);
    out.refused.push(issue.id);
    log(`${issue.id}: #${spec.number} still conflicts and no resolver is on it any more`);
  }
  /**
   * And the cards whose reason has lapsed — bc-91srt.
   *
   * `raiseMergeCard` takes `merge-queue` off the bead, and that removal is the handover:
   * the queue stops acting, and it should. What went unnoticed is that the handover also
   * assumed the *reason* persists, and on this Mac it routinely does not — #475 was carded
   * for a red check that went green on its own; #433 and #438 for conflicts, with their
   * checks passing. None of the three needed a decision from anybody. Each needed the
   * queue to look again, and none of them could be looked at, because a bead without the
   * label appears in no list this file reads.
   *
   * **The test is the gate itself, re-run.** Not a re-reading of the sentence, which is
   * prose in the vocabulary of whatever refused it, and not a rule per refusal, which is
   * the same judgement written twice and drifting apart. If the gate now says *merge*, the
   * card is stale. If it says *conflicted*, the card is stale in the more useful way: a
   * conflict is the one thing this queue fixes by itself, by opening a resolver. Any other
   * answer means the card is still right, and it stays exactly where it is.
   *
   * **Capped, and said out loud when the cap bites.** A check that flaps would otherwise
   * send the same pull request round this lap for ever, and every lap notifies.
   * `MAX_RECLAIMS` is the backstop; past it the card stands and the log says so, because a
   * cap nobody is told about reads as the feature not working.
   *
   * The approval is deliberately **not** written here, and that is the whole line between
   * this and `admittedState`: taking a card back says *the queue can act again*, where an
   * admission says *Adam wants this merged*. Fabricating the second from the first would
   * merge a `requireApproval` pull request nobody ever tapped.
   */
  for (const entry of cardedFor(beads)) {
    const { issue, spec, state } = entry;
    /**
     * Asked at most once per cooldown, which is what keeps `anyQueued` honest.
     *
     * That gate now answers *yes* while any card exists, so a workspace sitting on ten of
     * them would otherwise spend ten `gh pr view` calls a minute for ever, on beads whose
     * whole point is that nobody is acting on them. A card's reason lapses on the world's
     * schedule — a check finishing, a base moving — and none of that is worth watching at
     * tick resolution.
     */
    const looked = Date.parse(String(state.at || ''));
    if (Number.isFinite(looked) && Date.now() - looked < RECLAIM_COOLDOWN_MS) continue;
    if (state.reclaims >= MAX_RECLAIMS) {
      log(`${issue.id}: #${spec.number} has been taken back ${state.reclaims} times already — leaving it as a card`);
      continue;
    }
    let view;
    let baseline;
    try {
      const where = await resolve(spec);
      if (!where?.dir) throw new Error(where?.reason || `no checkout on this Mac is ${spec.repo}`);
      view = await prApi.view(where.dir, spec.number);
      baseline = await prApi.baseChecks(where.dir, spec.base).catch(() => null);
    } catch (err) {
      // Unknown leaves the card alone — the direction that costs a tick rather than a
      // handover taken back on no evidence.
      log(`${issue.id}: carded, and could not check #${spec.number} — ${first(err)}`);
      continue;
    }
    if (String(view.state || 'OPEN').toUpperCase() !== 'OPEN') continue;
    const now = gateVerdict({
      checks: view.checks,
      baseline: baseline ? baseline.failed : null,
      baseHasChecks: baseline ? baseline.state !== 'none' : null,
      mergeable: String(view.mergeable || '').toUpperCase(),
      reviewDecision: view.reviewDecision,
      requireApproval: !!policy.requireApproval,
      approved: !!state.approved,
      checksAt: view.checks?.at || null,
      heldUntil: state.heldUntil || null,
    });
    if (!now.merge && !now.conflicted) continue;
    try {
      await bd.update(ws, issue.id, {
        notes: withQueueBlock(issue.notes || '', {
          ...state,
          attempts: 0,
          refused: null,
          resolving: false,
          reclaims: (state.reclaims || 0) + 1,
          at: iso(),
        }),
        addLabels: [MERGE_LABEL],
        removeLabels: ['human', DELIVERY_LABEL],
      });
    } catch (err) {
      log(`${issue.id}: could not take #${spec.number} back — ${first(err)}`);
      continue;
    }
    out.restored.push(issue.id);
    log(`${issue.id}: #${spec.number} is back on the queue — it was handed over because ${state.refused}`);
  }

  /**
   * And the pull requests **nothing is about** — bc-91srt, `strandedPrs` for the whole of
   * why one can exist.
   *
   * Reported and not acted on. What to do about a strand is a real decision — file a
   * merge-bead for it, raise it, or leave it for the session that is still writing it —
   * and none of them is obviously right for every case, where *saying it* is right for
   * all of them. The failure this closes is not that a stranded pull request goes
   * unmerged; it is that it goes unmentioned, in both of the lists anybody would look at,
   * for as long as it exists.
   *
   * **Only the checkouts this sweep already resolved**, which is the honest limit and
   * worth naming rather than hiding: the pull requests are listed per directory, and a
   * directory is only known here by way of a merge-bead that pointed at it. So a
   * workspace whose merge-beads have *all* gone — the one case where every pull request
   * in it is stranded — is the case this cannot see. Closing that properly needs the
   * workspace's own repo list rather than the queue's, and a sweep over forty Climative
   * checkouts every tick is not a thing to add on the way past.
   */
  if (typeof prApi?.list === 'function') {
    const dirs = new Map();
    for (const entry of [...queued, ...stuck, ...broken, ...resolving]) {
      const spec = entry?.spec;
      if (!spec?.repo || dirs.has(spec.repo)) continue;
      try {
        const where = await resolve(spec);
        if (where?.dir) dirs.set(spec.repo, where.dir);
      } catch {
        /* A repo with no checkout here cannot be listed; it is not a strand, it is absent. */
      }
    }
    for (const [repo, dir] of dirs) {
      let open;
      try {
        open = await prApi.list(dir, { state: 'open' });
      } catch (err) {
        log(`could not list the open pull requests in ${repo} — ${first(err)}`);
        continue;
      }
      for (const pr of strandedPrs(open, beads)) {
        out.stranded.push(pr.number);
        log(
          `#${pr.number} in ${repo} is open and no merge-bead is about it — nothing will merge it, and ` +
            `nothing will open a worker on it either while its bead is held in flight`
        );
      }
    }
  }

  queued.sort((x, y) => String(x.issue?.id || '').localeCompare(String(y.issue?.id || '')));

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
          tellAdvocate,
          prApi,
          dir: where.dir,
          state,
          // Whatever a reviewer had already written about it, even though the merge itself
          // happened elsewhere: a pull request Adam merged from his phone still went out
          // over an agent's approval, and the closing comment is where the page says so.
          review: reviewState(issue),
          owner,
          autoEndorse,
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

    /* ------------------------------------------------------- 1a. the base is red */
    /**
     * The hold — bc-arf8, and lib/redbase.js for the whole argument.
     *
     * **After `gone` and before everything else**, and both halves of that position are
     * load-bearing. After, because a pull request somebody merged from the phone still
     * has two beads to close and a hold that swallowed that would strand every merge Adam
     * made while the base was red — including, on the day it matters most, the fix's. And
     * before the downmerge, the resolver and the gate, because every one of those is
     * preparation for a merge that is not going to happen this tick: bringing a red base
     * into a branch re-runs its checks against a base that is about to move again, and
     * handing a conflict to a resolver spends one of this Mac's two windows on a rebase
     * that will need doing again after the fix lands.
     *
     * **It costs no attempt and files nothing.** A hold is a wait, exactly as a pending
     * check is — nothing was refused, because nothing was asked of this branch. It must
     * not become `raise` either, however much a card looks like the right way to say it:
     * `raiseMergeCard` takes `merge-queue` *off* the bead, which is a one-way handover to
     * Adam, so a hold that raised would turn a two-minute red into a queue full of pull
     * requests that never come back on their own. What says it instead is the state block,
     * the log line, and `describeMergeQueue`'s count.
     *
     * The state write is guarded on the sentence having changed, so a base that is red for
     * an hour is one write per bead rather than one every thirty seconds — and the sentence
     * carries the hold bead's id, so it changes when the fix bead does.
     */
    const hold = holdFor ? await holdFor(spec, where).catch(() => null) : null;
    if (hold && !exemptFrom(hold, spec)) {
      const why = holdRefusal(hold);
      if (state.refused !== why) await note(bd, ws, issue, { ...state, held: true, refused: why, at: iso() });
      out.held.push(issue.id);
      log(`${issue.id}: holding #${spec.number} — ${why}`);
      continue;
    }
    /**
     * And the sentence taken back the moment it stops being true.
     *
     * The one refusal here the queue has to *withdraw*: every other one is overwritten by
     * the next verdict on the same branch, but a branch that was only ever held has had no
     * verdict — so `main is red` would sit on the merge-bead reading as this branch's own
     * problem, and draw it as *Resolving issues* on the queues board, for as long as it
     * took the base to come back and this branch to be judged. `state` is then reused
     * below, so the tick that lifts the hold judges the branch on the same pass.
     */
    if (state.held) {
      /**
       * And the moment it lifted is kept — bc-91srt.
       *
       * Taking the sentence back is not the whole of the damage a red base does. GitHub
       * builds `refs/pull/N/merge`, so every check that ran while the base was broken is a
       * verdict on a merge with a broken base, and it stays on the pull request afterwards
       * because nothing re-runs it. Judged against a base that is now green, that stale red
       * reads as a failure this branch introduced — which is how #475 and #488 were
       * condemned on 2026-08-18, neither having ever been broken.
       *
       * `gateVerdict` is what uses the stamp, and it drops it as soon as a verdict measured
       * after it exists. Written here rather than there because this is the only place that
       * knows *when*: by the time the gate runs, the hold is already gone.
       */
      Object.assign(state, { held: false, refused: null, heldUntil: iso() });
      await note(bd, ws, issue, state);
    }

    /* ------------------------------------------------- 1b. has anybody reviewed it */
    /**
     * The review gate — bc-36xx.4, and lib/reviewgate.js for the whole argument.
     *
     * **After the hold and before the downmerge**, and both halves of that are the same
     * argument the hold makes one branch up: everything below this point is preparation
     * for a merge that is not going to happen this tick. Bringing the base into a branch
     * nobody has reviewed re-runs its checks and moves the diff *under the reviewer*;
     * handing its conflict to a resolver spends one of this Mac's two windows on a rebase
     * that will need doing again after the review. So a pull request waiting on a review
     * waits exactly where it is.
     *
     * **It costs no attempt and files nothing**, for the reason `awaitingApproval` does
     * not either: nothing was asked of this branch, so nothing refused it. What says it
     * is the state block, the log line and `describeMergeQueue`'s count — never `raise`,
     * which takes `merge-queue` off the bead and is a one-way handover to Adam. The one
     * exception is the escalation below, which is the loop *ending* rather than waiting.
     *
     * Off unless the workspace asked for it. See `reviewGated`: a gate that holds until a
     * verdict appears, in a workspace where nothing ever writes one, is not a slow queue
     * but a stopped one.
     */
    const gated = reviewGated(spec, state, policy);
    /**
     * Read a reviewer's verdict back onto the block before the gate reads it — bc-36xx.22.
     *
     * The comment a ReviewAdvocate writes and the block this gate reads are two different
     * documents on the same bead (`lib/reviewadvocate.js`'s header), and until now nothing
     * turned the first into the second — a reviewer could approve for ever and the gate
     * would keep opening another one. Folded in *here*, one line above `judgeReview`, so a
     * verdict that lands this tick is judged this tick rather than costing a whole extra
     * pass: `syncReviewVerdict` writes the tracker and hands back the state it wrote, and
     * `judgeReview` below reads that rather than re-parsing `issue.notes` a second time.
     */
    let review = reviewState(issue);
    if (gated) {
      const synced = await syncReviewVerdict(bd, ws, prApi, issue, spec, {
        dir: where.dir,
        headSha: view.headSha,
        owner,
        policy,
      }).catch((err) => {
        log(`${issue.id}: could not fold the reviewer's verdict onto #${spec.number} — ${first(err)}`);
        return null;
      });
      if (synced) {
        issue.notes = synced.notes;
        review = synced.review;
        log(
          `${issue.id}: round ${review.round} of the review is on the block now — ${review.verdict}` +
            (synced.submitted ? ', and the review went out on GitHub' : ', but there was no second account to submit it as')
        );
      }
    }

    const outcome = gated
      ? await judgeReview(prApi, where.dir, { review, head: view.headSha }).catch((err) => {
          // Holding, not merging. Everything inside the gate that cannot establish an
          // answer already holds (see `pushedSince`), and a throw is the same state
          // arriving by another route — the one direction that must never fall through to
          // the merge is the one where the queue does not know what it is merging.
          log(`${issue.id}: could not judge the review of #${spec.number} — ${first(err)}`);
          return { act: 'review', why: `the review on this bead could not be read — ${first(err)}`, stale: false };
        })
      : null;

    if (outcome && outcome.act === 'escalate') {
      /**
       * The one review outcome that becomes a card: a reviewer that will not approve this
       * at all, or two rounds that did not agree (`reviewEscalation`, lib/mergebead.js).
       *
       * `raise` rather than a sentence on the bead, because unlike every other branch here
       * this is not a wait — nothing further is going to happen to it on its own, and a
       * merge-bead nobody is acting on and nobody has said anything about is the failure
       * mode this whole queue replaces. Nothing is written when the raise fails, so the
       * next tick tries again, which is the retry `raiseMergeCard` is built to have.
       */
      const raised = raise
        ? await raise(entry, outcome.why, { review: true }).catch((err) => log(`${issue.id}: ${first(err)}`))
        : null;
      // A raise that did not go through is a wait rather than a review: nothing was
      // written, so the next tick tries again — which is the retry `raiseMergeCard` is
      // built to have, and `awaiting` would count it as a pull request nobody has looked
      // at when the truth is that somebody has and it could not be handed over.
      if (raised) out.raised.push(issue.id);
      else out.waiting.push(issue.id);
      log(`${issue.id}: the review of #${spec.number} has to reach a person — ${outcome.why}`);
      continue;
    }

    if (outcome && outcome.act !== 'merge') {
      /**
       * Waiting — on a reviewer, or on the worker answering what a reviewer said.
       *
       * The window is opened every tick it is owed rather than being flagged, because the
       * durable record of whether it is owed is the review block itself: a comment with no
       * answer on it is the whole of the question, and it stops being true the moment the
       * worker writes one through `bin/answer.js`. One window per pull request is
       * `resolveFor`'s job in lib/server.js, exactly as it is for a resolver, and a tick
       * that cannot open one simply says so and waits.
       */
      if (outcome.act === 'answer' && openAnswer) {
        const opened = await openAnswer(entry, where.dir).catch((err) => log(`${issue.id}: ${first(err)}`));
        if (opened) out.answering.push(issue.id);
      }
      /**
       * And the other half of it — bc-36xx.5. `review` is *nobody has judged this*, which
       * is the state every delivered pull request starts in and the state it returns to
       * every time the worker finishes answering, so this is the door the loop goes round.
       *
       * Opened every tick it is owed, exactly as the answer above is, and for the same
       * reason: the durable record of whether a review is owed is the review block on the
       * bead, and it stops saying so the moment a verdict is written. A flag here would be
       * a second answer to a question the block already answers, and a wrong one after a
       * daemon restart — which is precisely the trap the registry has (`resolveFor`,
       * lib/server.js) and precisely why nothing is written here to paper over it.
       *
       * A tick that cannot open one is not a refusal and files nothing. `out.awaiting`
       * below already says this pull request is waiting on a review, which stays true
       * whether a window went up for it this tick or the next.
       */
      if (outcome.act === 'review' && openReview) {
        const opened = await openReview(entry, where.dir, outcome).catch((err) => log(`${issue.id}: ${first(err)}`));
        if (opened) out.reviewing.push(issue.id);
      }
      // Guarded on the sentence having changed, for the hold's reason: a review that takes
      // an hour is one write per bead rather than one every thirty seconds.
      const why = reviewRefusal(outcome);
      if (!state.reviewing || state.refused !== why) {
        await note(bd, ws, issue, { ...state, reviewing: true, refused: why, at: iso() });
      }
      out.awaiting.push(issue.id);
      log(`${issue.id}: #${spec.number} is ${why}`);
      continue;
    }

    /**
     * And the sentence taken back the moment it stops being true — the hold's lesson,
     * applied to the other thing this queue waits on that is not about the branch. `state`
     * is reused below so the tick that sees the approval judges the branch on the same
     * pass, rather than a merge costing one more tick than it needed to.
     */
    if (state.reviewing) {
      Object.assign(state, { reviewing: false, refused: null });
      await note(bd, ws, issue, state);
    }

    const mergeState = String(view.mergeState || '').toUpperCase();
    const mergeable = String(view.mergeable || '').toUpperCase();
    const conflicted = mergeable === 'CONFLICTING' || mergeState === 'DIRTY';

    /**
     * And `declined` taken back the moment it stops being true — the same take-back
     * `held` and `reviewing` above get, for the same reason and with the same shape.
     *
     * It is a sentence about a window that is not here any more, and the thing that makes
     * it false is the branch ceasing to conflict — Adam pushed the resolution himself,
     * `main` moved so that it no longer collides, the branch was rebuilt. Left standing it
     * would refuse a resolver to a branch that has a *new* conflict months later, over a
     * window that stood down from a different one. `state` is reused so this tick judges
     * the branch on the same pass.
     */
    if (state.declined && !conflicted) {
      Object.assign(state, { declined: false });
      await note(bd, ws, issue, state);
    }

    /* ------------------------------------------------------------- 3. conflicted */
    // Before `behind`, because a conflicted branch is also behind and asking GitHub to
    // update it would only produce the refusal we already have in hand.
    if (conflicted) {
      // A conflict a resolver has already declined does not get another one — bc-5mdsw.
      // The window that stood down read this exact branch against this exact base; a
      // second one re-derives the same hand-back at the cost of a whole session, which is
      // what nine windows on #488 were. It refuses instead, and three of those carry it to
      // the card the stand-down should have produced in the first place.
      const opened =
        state.declined || !openResolver ? null : await openResolver(entry, where.dir).catch((err) => log(`${issue.id}: ${first(err)}`));
      if (opened) {
        await note(bd, ws, issue, { ...state, resolving: true, at: iso(), refused: 'the branch conflicts with its base' });
        out.raised.push(issue.id);
      } else {
        await record(
          bd,
          ws,
          issue,
          state,
          state.declined
            ? declinedRefusal(spec)
            : `the branch conflicts with \`${spec.base}\` and nothing could be opened to resolve it.`,
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
      baseHasChecks: baseline ? baseline.state !== 'none' : null,
      mergeable,
      timedOut: false,
      reviewDecision: view.reviewDecision,
      requireApproval: !!policy.requireApproval,
      // Adam's own approval, given to the queue rather than to GitHub — see the branch in
      // `gateVerdict` and lib/mergeadmit.js. It rides on the bead, so it survives the tick
      // that raised the card asking for it.
      approved: !!state.approved,
      // What the branch's checks were measured against — see the stale branch in
      // `gateVerdict`. Both are ordinary nulls on the overwhelming majority of ticks: a
      // bead that was never held has no stamp, and the gate then cannot ask the question
      // at all, which is the direction that stops merges rather than letting them through.
      checksAt: view.checks?.at || null,
      heldUntil: state.heldUntil || null,
    });

    /**
     * The stamp has done its job the moment a verdict measured after it exists.
     *
     * Dropped rather than left, for `held`'s own reason one branch up: a field the queue
     * writes about a condition that has ended is a field that reads as current for as long
     * as it sits there. Once the checks have run since the base came back, they are simply
     * this branch's checks again, and nothing should be asking what they were measured
     * against.
     */
    if (state.heldUntil && !verdict.stale) {
      Object.assign(state, { heldUntil: null });
      await note(bd, ws, issue, state);
    }

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
      /**
       * And a verdict measured against a base that is gone is a wait for the same reason
       * — bc-91srt, and `gateVerdict`'s stale branch for the whole of why.
       *
       * It must not reach `record`. Nothing was asked of this branch since the base came
       * back, so nothing refused it, and spending an attempt here is precisely how a pull
       * request that was never broken becomes a card: three ticks inside one outage and
       * #475 was gone. The sentence is still written, because a wait nobody can read is
       * how the last one hid — but written only when it changed, for the hold's reason
       * one branch up.
       */
      if (verdict.stale) {
        if (state.refused !== verdict.refused) await note(bd, ws, issue, { ...state, refused: verdict.refused, at: iso() });
        out.waiting.push(issue.id);
        log(`${issue.id}: #${spec.number} — ${verdict.refused}`);
        continue;
      }
      /**
       * What the red check actually said — bc-xl7n.116.
       *
       * The refusal above names the check and nothing else, and on a repo with one check
       * called `test` that is the same sentence for every red pull request there has ever
       * been. The fact that decides whether this is a two-line fix or a flake is inside
       * the log, and reading it has cost an advocate or a human a trip to GitHub every
       * time — #543 on 2026-08-21, where the answer was a bare `fs.rmSync` in the suite
       * the branch itself adds and accepting the flake reading would have turned `main`
       * red for everybody.
       *
       * **Only on a refusal about a check**, which is what `broke` is: `gateVerdict` fills
       * it with the names the branch is red on and the base is not, and leaves it empty on
       * every other refusal. GitHub said no, no checkout, a timeout — none of those has a
       * check log to read.
       *
       * **And only once per distinct refusal.** The download is the failing job's whole
       * log, which on this repo is about two megabytes, and a refusal the queue is going to
       * repeat verbatim for three ticks has nothing new in it. A refusal that *changed* is
       * a different failure and gets a fresh read; one that could not be read leaves the
       * refusal exactly the sentence it would have been.
       */
      let failure = [];
      if (verdict.broke?.length) {
        const unchanged = refusalKey(state.refused) === refusalKey(verdict.refused);
        failure = unchanged && state.failure?.length ? state.failure : [];
        if (!failure.length && prApi.checkFailure) {
          failure = await prApi.checkFailure(where.dir, view.checks?.failedUrls || []).catch(() => []);
        }
      }
      await record(bd, ws, issue, state, verdict.refused, verdict.baseline, failure);
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
    await finish(bd, ws, issue, spec, {
      landed,
      baseline: verdict.baseline,
      how: '',
      markMerged,
      tellAdvocate,
      prApi,
      dir: where.dir,
      state,
      // The block as this tick left it — `syncReviewVerdict` may have written the approval
      // moments ago, and the closing comment has to name the approval that released *this*
      // merge rather than whatever the bead said when the tick began.
      review,
      owner,
      autoEndorse,
    });
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

/**
 * Fold a fresh verdict off the merge-bead's comments onto its review block, and submit the
 * real review on GitHub — bc-36xx.22, and lib/reviewsync.js for the pure translation this
 * wraps in the writes it needs. `null` when there is nothing fresh: the ordinary tick, since
 * a review is minutes of somebody reading a diff and most ticks land in between.
 *
 * The one call this always costs when the gate applies at all is `bd.comments` — the
 * durable record of whether a verdict is waiting is the comments themselves, in the same
 * shape `holdFor` and the gate itself already cost a call apiece to answer their own
 * questions.
 *
 * Runs under `reviewerFor`'s identity, resolved once and reused for the body's provenance
 * line and the submission itself. A second GitHub account nobody promised is the ordinary
 * case here (`reviewerFor`, lib/pr.js) and every path below already handles a `null` one:
 * the block is written either way, `submitted` says whether GitHub actually has a copy of
 * it, and `approvedReview` is what makes an unsubmitted approval read as *recorded* rather
 * than refused.
 *
 * `approve()` for a bare approval; `submitReview()` — general since #533 — for anything
 * that carries inline comments, approving or not, because `approve()` has no way to attach
 * one. The disclaimer comment (`approvalComment`, "that approval is an agent's, not
 * yours") only ever follows an approval that actually went out: nothing on a
 * `REQUEST_CHANGES` review could be mistaken for a person's tick, and a bare approval
 * already carries its own disclaimer as `approve()`'s trailing `note`.
 */
async function syncReviewVerdict(bd, ws, prApi, issue, spec, { dir, headSha = '', owner = 'a person', policy = {} } = {}) {
  const state = reviewState(issue);
  const comments = await bd.comments(ws, issue.id);
  const verdict = freshVerdict(comments, state);
  if (!verdict) return null;

  let identity = null;
  try {
    identity = prApi.reviewerFor ? await prApi.reviewerFor(dir) : null;
  } catch {
    identity = null;
  }
  const reviewer = identity?.login || '';
  const body = approvalNote(verdict, { owner, reviewer, bead: issue.id, round: verdict.round });
  const inline = inlineComments(verdict);
  const disclaimer = () => approvalComment({ owner, reviewer, bead: issue.id, agent: REVIEW_ADVOCATE, human: !!policy.requireApproval });

  let submission;
  if (verdict.approved && !inline.length) {
    submission = await prApi.approve(dir, spec.number, { body, note: disclaimer() });
  } else {
    const event = verdict.approved ? 'APPROVE' : 'REQUEST_CHANGES';
    submission = await prApi.submitReview(dir, spec.number, { event, body, comments: inline });
    if (verdict.approved && submission?.submitted) {
      await prApi.comment(dir, spec.number, disclaimer()).catch(() => {});
    }
  }

  const folded = { ...state, ...reviewFromVerdict(verdict, { headSha, reviewer }) };
  const next = verdict.approved
    ? {
        ...folded,
        ...approvedReview(folded, {
          reviewer,
          at: submission?.at || iso(),
          url: submission?.url || '',
          submitted: !!submission?.submitted,
          round: verdict.round,
        }),
      }
    : folded;

  const notes = withReviewBlock(issue.notes || '', next);
  await bd.update(ws, issue.id, { notes });
  return { notes, review: reviewState({ notes }), submitted: !!submission?.submitted };
}

/**
 * The sentence a stand-down refuses with — bc-5mdsw, and it is deliberately factual.
 *
 * `record` counts *the same* refusal, comparing the sentences, so this has to read the
 * same every tick or the three attempts would restart on each one and never reach the
 * card. That rules out quoting the resolver: its own `RESOLVER_SAYS` comment is a
 * different sentence each round, and a new window would leave a new one.
 *
 * It also says only what is known. Nothing here watched a session decide anything — what
 * was observed is a registry that no longer holds this pull request and a branch GitHub
 * still calls conflicting, so that is what it says, rather than claiming an intent the
 * queue is in no position to have.
 */
const declinedRefusal = (spec) =>
  `the branch still conflicts with \`${spec.base}\` and no resolver is on it any more — the window that was ` +
  `opened on it ended without making it mergeable, so this one is yours to settle.`;

/**
 * A refusal: one more attempt, the sentence, and what it was measured against.
 *
 * ## Attempts count the *same* refusal, not any three — bc-91srt
 *
 * `MAX_ATTEMPTS` exists to stop a queue re-running one refusal for ever, and its own
 * argument names the failures worth retrying: "a check that was still pending, a flake, a
 * base that moved under the merge". Every one of those is a *different* sentence from the
 * one before it. Counting any three refusals treats a branch that was unlucky three
 * different ways exactly like one that is definitively broken, and the second is the only
 * thing the eject was ever meant to catch — a pull request stuck at the same place, where
 * trying again is the thing that cannot help.
 *
 * So a refusal that differs from the recorded one starts the count again. What that
 * preserves is the guarantee people actually rely on: **a branch stuck at one place still
 * ejects after three**, which is the case `raiseMergeCard` is for. What it stops is the
 * queue giving up on a branch nothing has said the same thing about twice.
 *
 * Compared on the sentence because the sentence is the queue's own vocabulary for what
 * refused it — the names of the checks when they are red, GitHub's words when GitHub said
 * no. Two ticks refusing for the same reason produce the same string; two different
 * reasons cannot. Compared through `refusalKey`, which is exactly what `queueBlock` puts
 * the stored one through — whitespace collapsed, so a sentence that only re-wrapped is not
 * read as a new one, and cut at 400, so a refusal long enough to be truncated on the way in
 * still matches itself on the way out. Comparing the raw sentence against a stored one that
 * had been cut is a comparison that can never match, and a merge-bead that never matches
 * never reaches `MAX_ATTEMPTS` and never becomes a card.
 */
async function record(bd, ws, issue, state, refused, baseline, failure = []) {
  // Through `refusalKey` on both sides, because the stored one has been through it: the
  // block collapses whitespace and cuts at 400, and a comparison against the uncut
  // sentence is one that can never match on a refusal long enough to be cut — which is a
  // merge-bead pinned at one attempt for ever. See `refusalKey` in lib/mergebead.js.
  const same = (a, b) => refusalKey(a) === refusalKey(b);
  const attempts = same(state.refused, refused) ? (state.attempts || 0) + 1 : 1;
  // The excerpt is about *this* refusal, so a different refusal drops it rather than
  // carrying the last one's log under the new sentence. Empty means the queue could not
  // read one, and the previous one is no more current for that.
  await note(bd, ws, issue, { ...state, attempts, refused, failure, baseline, at: iso(), resolving: false });
  const left = MAX_ATTEMPTS - attempts;
  const said = failureNote(failure);
  await bd
    .comment(
      ws,
      issue.id,
      `The merge queue did not merge this: ${refused}` +
        (left > 0
          ? ` It will try again — ${left} attempt${left === 1 ? '' : 's'} left.`
          : ' That was its last attempt, so this is now a decision rather than a retry.') +
        (said ? `\n\n${said}` : '')
    )
    .catch(() => {});
}

/**
 * What the merge looked like from the queue's seat, as one comment (bc-kan5f).
 *
 * **The hard part of this is not what to include, it is what the queue is entitled to
 * say.** A merge has two witnesses and they saw different things. The MergeAdvocate knows
 * the conflicts, which side it kept and why, the suites it ran and against which tree —
 * and it already writes that down, on the merge bead, because the brief's last
 * instruction makes it. The queue knows none of that. What the queue knows is the shape
 * of the passage: how many windows were opened on it, how many times the base had to be
 * brought in underneath it, what the base was already failing when it went in, who
 * approved it and when — and whether that was a person or an agent, which is the one thing
 * here a reader cannot infer from a login — and how long the whole thing took.
 *
 * So this reports the second of those and *points at* the first. The alternative — a
 * report that reads the advocate's comments and summarises them — was rejected: a summary
 * of somebody else's account, written by a process that did not watch the merge, is the
 * exact shape of a confident falsehood, and the queue would be the last thing anybody
 * thought to doubt. Every number below is one this function is holding in its own hand.
 *
 * `downmerges` is the one worth naming out loud in prose rather than leaving as a count.
 * It is how many times `main` moved under the branch while it waited, which is the single
 * most useful fact about a busy day and the one nothing else records — a branch merged at
 * the fourth attempt with three downmerges was not a bad branch, it was an unlucky one,
 * and a month later that distinction is unrecoverable from anywhere else.
 *
 * Returns markdown. Pure, so test/mergequeue.mjs can assert on it without a merge.
 */
export function mergeReport(
  spec,
  { landed = null, state = {}, review = null, baseline = [], queuedAt = null, now = Date.now(), how = '', owner = 'a person', findings = '' } = {}
) {
  const sha = String(landed?.mergeCommit || '').slice(0, 8);
  const attempts = Number(state.attempts) || 0;
  const downmerges = Number(state.downmerges) || 0;
  /**
   * Two ways a queued pull request ends up merged, and the report must not claim the
   * wrong one. `how` is set only on the path where the queue found it *already* merged —
   * Adam's thumb on the phone, or github.com — and saying "merged by the beadcause merge
   * queue" there would be the queue taking credit for a tap. Everything below `how` is
   * still true either way: the attempts and downmerges happened, whoever finished it.
   */
  const lines = [
    how
      ? `**${how.replace(/^./, (c) => c.toUpperCase())}.** The queue was holding it and has done the bookkeeping the merge would have done.`
      : `**Merged into \`${spec.base}\`${sha ? ` as \`${sha}\`` : ''}** by the beadcause merge queue.`,
    '',
  ];

  const passage = [];
  /* One window is the ordinary case and says nothing; two or more is the story. */
  if (attempts > 1) {
    passage.push(
      `- **${attempts} attempts.** A MergeAdvocate window was opened on this branch ${attempts} times — ` +
        'each one a tick where the gates refused it and it went back for work.'
    );
  } else if (attempts === 1) {
    passage.push('- **One attempt.** It was refused once, resolved, and taken on the next tick.');
  }
  if (downmerges > 0) {
    passage.push(
      `- **The base moved under it ${downmerges} time${downmerges === 1 ? '' : 's'}.** ` +
        `\`${spec.base}\` was brought into the branch ${downmerges === 1 ? 'once' : `${downmerges} times`} ` +
        'while it waited, so what merged was tested against a base that kept arriving.'
    );
  }
  if (!passage.length) passage.push('- **Straight through.** No refusal, no downmerge: it was mergeable when the queue first read it.');

  const over = baselineNote(baseline);
  if (over) passage.push(`- **${over.replace(/^\s*/, '').replace(/^./, (c) => c.toUpperCase())}**`);
  if (state.approvedBy) {
    passage.push(`- **Approved by ${state.approvedBy}**${state.approvedAt ? ` at ${state.approvedAt}` : ''}.`);
  }
  /**
   * And who *reviewed* it, said as plainly as it can be said — bc-36xx.9, and it is Adam's
   * standing rider on bc-0cop: *the last comment on the PR should describe who is actually
   * approving (ie an agent, not me)*.
   *
   * `approvalComment` (lib/reviewadvocate.js) already says this, and it is not enough on
   * its own: it is posted at the moment the review goes out, which on a busy pull request
   * is a dozen comments above the bottom of the thread, and it is posted *only* when a
   * review actually reached GitHub. A one-login Mac approves with `submitted: false` — a
   * recorded approval with no GitHub review behind it and therefore no disclaimer — and
   * then the whole page says nothing at all about who released the merge. This line is on
   * the closing comment, which is the last thing on the thread and is posted either way.
   *
   * The two lines above and below each other are the two gates, and the pair is the point:
   * `state.approvedBy` is a person's tap through `/merge` and this is an agent's reading of
   * the diff. In a `requireApproval` space both appear, which is exactly what "necessary
   * and not sufficient" looks like written down.
   */
  if (review?.verdict === 'approved') {
    const who = String(review.approvedBy || REVIEW_ADVOCATE);
    const login = who !== REVIEW_ADVOCATE ? who : '';
    const round = Number(review.round) > 0 ? Number(review.round) : 0;
    passage.push(
      `- **Approved by an agent, not ${owner}.** beadcause's **${REVIEW_ADVOCATE}** read this diff and ` +
        `approved it${round ? ` at round ${round}` : ''}` +
        (login
          ? `, submitted as \`${login}\` — which is an identity beadcause reviews as and not somebody at a keyboard.`
          : ', and there was no second GitHub account to submit it under, so the approval is recorded on the bead rather than on this page.') +
        (review.approvalUrl ? ` [The review itself](${review.approvalUrl}).` : '')
    );
  }
  /**
   * And that it went in over findings nobody had settled — bc-9ntye.2, and it is the line
   * on this page most likely to be the only notice anybody gets.
   *
   * It goes here rather than into the closing paragraph because this is the passage a
   * reader scans, and "approved by an agent" two bullets above would otherwise be the last
   * word on the review. The heading says *open review findings* rather than "the review
   * did not hold it", because a `blocking` one still does — what reaches this line then is
   * a pull request Adam admitted himself, and the queue must not describe his tap as the
   * reviewer having been overruled by a rule. `findings` already names the bead the work
   * went to (`followUpSentence`, lib/reviewfollowup.js), and it is carried whole: the
   * queue's rule about not paraphrasing somebody else's account holds here too.
   */
  if (findings) passage.push(`- **Open review findings.** ${findings}`);
  const took = elapsed(queuedAt, now);
  if (took) passage.push(`- **${took}** from reaching the queue to merging.`);

  lines.push(...passage);
  lines.push(
    '',
    `The queue reports its own half only: how this branch got through, not what was in it. ` +
      `What the advocate actually did — the conflicts, which side it kept, the suites it ran and against ` +
      `which tree — is on **${spec.bead ? `${spec.bead}` : 'the work bead'}**'s merge bead, written by the ` +
      'window that did it. Nothing here is a summary of that; a process that did not watch the merge has no ' +
      'business paraphrasing one.'
  );
  return lines.join('\n');
}

/** How long, in the words a one-line report can use. Empty when it cannot be known. */
function elapsed(from, now) {
  const start = from ? Date.parse(from) : NaN;
  if (!Number.isFinite(start) || start <= 0 || now <= start) return '';
  const mins = Math.round((now - start) / 60000);
  if (mins < 1) return 'Under a minute';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Where a merge's open review findings go, and the one lookup filing them costs — bc-9ntye.2.
 *
 * Everything expensive is behind the `owed` guard, and it has to be: this runs on **every**
 * merge, and a follow-up is owed only on the few that went over an unresolved comment. A
 * cleanly approved pull request — which is most of them — costs one array filter and stops,
 * with no tracker call of any kind.
 *
 * The home is lib/homing.js's ordinary answer over a `from` lib/reviewfollowup.js chooses:
 * `graph` is cached for a minute and the sweep has already read it this tick, so the
 * lookup is free in the steady state and the `catch` covers the workspace that will not
 * export at all. See `followUpFrom` for why the work bead itself is usually the wrong
 * thing to climb from — it is closing in the next few lines.
 */
async function followUpFor(bd, ws, issue, spec, review, { landedAs = '', autoEndorse = false } = {}) {
  if (!followUpOwed(review).length) return null;
  const log = (msg) => console.error(`[merge-queue] ${issue.id}: ${msg}`);
  let home = { parent: '' };
  try {
    const index = typeof bd?.graph === 'function' ? await bd.graph(ws).catch(() => null) : null;
    home = await homeIn(bd, ws, { from: followUpFrom(index, spec.bead), onWarn: log });
  } catch (err) {
    // `homeIn` does not throw, and a bead filed parentless is a bead filed rather than a
    // merge sequence stopped — the same direction everything else on this path takes.
    log(`could not work out where a review follow-up belongs — ${first(err)}`);
  }
  return fileReviewFollowUp(bd, ws, { issue, spec, review, parent: home.parent, landedAs, endorsed: autoEndorse, log });
}

/**
 * And the epic advocate that now has a bead under it, told so — bc-9ntye.3.
 *
 * **Behind two guards, in this order, and both of them are about cost.** `tellAdvocate`
 * unwired is every caller that predates this and every test that does not care; a
 * `followUp` that is not `filed` is the three cases lib/reviewfollowup.js collapses to
 * `null`-ish — nothing owed, already filed by an earlier tick, or the tracker refused. A
 * follow-up an earlier tick filed was announced by that tick, and saying it twice would
 * type the same paragraph into a window that has already acted on it.
 *
 * So the graph read below happens only on a merge that has just filed a follow-up, which
 * is the rare one: `bd.graph` is cached for a minute and `followUpFor` read it moments
 * ago, so in the steady state this is the same object again and costs nothing at all.
 *
 * The climb starts from `followUpFrom(index, spec.bead)` rather than from the work bead,
 * because that is the value `homeIn` was handed — so the root this finds is by
 * construction the root the follow-up was actually parented onto, and the message can say
 * "filed under" and be right. `advocatedRootOver` answers `''` for a root nothing advocates
 * and for no root at all, which is the bead's own "then do nothing": an open unassigned
 * bead under a root is already what `bd ready` means.
 *
 * Best-effort throughout, like everything else `finish` calls. `tellEpicAdvocate` does not
 * throw and the `catch` is for a wired callback that is not it.
 */
async function askAdvocate(bd, ws, issue, spec, followUp, { tellAdvocate = null } = {}) {
  if (!tellAdvocate || !followUp?.filed || !followUp?.id) return null;
  const log = (msg) => console.error(`[merge-queue] ${issue.id}: ${msg}`);
  let root = '';
  // The root's own title, off the index that just answered which root it is — free, and it
  // is what makes the message name the epic rather than only its id. An advocate window is
  // on exactly one epic and knows its id perfectly well; the title is what makes the line
  // readable to a person scrolling that window back afterwards.
  let title = '';
  try {
    const index = typeof bd?.graph === 'function' ? await bd.graph(ws).catch(() => null) : null;
    root = advocatedRootOver(index, followUpFrom(index, spec.bead));
    title = root ? String(index?.beads?.get?.(root)?.title || '') : '';
  } catch (err) {
    log(`could not work out whether ${followUp.id} landed under an advocated epic — ${first(err)}`);
    return null;
  }
  if (!root) return null;
  try {
    return await tellAdvocate({ root, title, followUp, spec, issue });
  } catch (err) {
    // A window that could not be told is a bead that waits for the re-entry sweep, which
    // is where it would have waited anyway. Never allowed near the closes below it.
    log(`${followUp.id} is under ${root} and its advocate was not told — ${first(err)}`);
    return null;
  }
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
async function finish(
  bd,
  ws,
  issue,
  spec,
  { landed, baseline, how, markMerged = null, tellAdvocate = null, prApi = null, dir = '', state = {}, review = null, owner = 'a person', autoEndorse = false }
) {
  const sha = String(landed?.mergeCommit || '').slice(0, 8);
  const where = `#${spec.number}${sha ? ` as ${sha}` : ''}`;
  const over = baselineNote(baseline);

  /**
   * What the reviewer raised that this merge went over, as work — bc-9ntye.2.
   *
   * **First of everything below**, because every sentence after it wants to name the bead:
   * the report on the pull request, the merge-bead's close reason and the comment on the
   * work bead all say "it merged with findings open, and they are *there*", which is the
   * epic's own acceptance criterion and is the whole difference between this and dropping
   * a review on the floor. Filing after them would mean either three writes that cannot
   * name it or a second pass that says the same thing twice.
   *
   * It answers `null` on every one of *nothing owed*, *already filed by a previous tick*
   * and *the tracker refused* — lib/reviewfollowup.js never throws, for the reason the
   * report below is wrapped: the merge has happened and nothing here can un-happen it.
   */
  const followUp = await followUpFor(bd, ws, issue, spec, review, { landedAs: sha, autoEndorse });
  const findings = followUpSentence(followUp);

  /**
   * And the advocate of the root it landed under, told about it — bc-9ntye.3.
   *
   * **Here rather than in `afterMerge`, and the bead that asked for it said `afterMerge`.**
   * That callback fires several lines above, *before* this function runs, so at the moment
   * it is called the follow-up does not exist and there is no bead id to hand anybody. It
   * is the same ordering bc-9ntye.5 is filed about, hit from the other side. The nudge
   * needs the bead, so it goes where the bead is minted.
   *
   * Immediately after `followUpFor` and before every write below it, for that function's
   * own reason inverted: those writes are the merge's account of itself and none of them
   * depends on this, but a window told twenty seconds sooner is a window told while it is
   * still deciding what to do next. Nothing here can stand between the merge and the two
   * closes — `askAdvocate` returns `null` for every failure there is.
   */
  await askAdvocate(bd, ws, issue, spec, followUp, { tellAdvocate });

  /**
   * The report, on the pull request and on the bead (bc-kan5f), before either close.
   *
   * Before, for `markMerged`'s reason and one of its own: the closes are what the reaper
   * watches, and a report posted after them races a window that may already be gone. The
   * pull request gets it because that is where somebody lands from a link six months
   * later; the bead gets it because that is where the next session on this work looks,
   * and the two readers never meet.
   *
   * **Wrapped so it cannot reach the merge.** It is the same rule `afterMerge` above is
   * written to and for the same reason: the merge has happened, and nothing this throws
   * can un-happen it. A report that failed is a comment nobody got, which is a small loss;
   * a report that threw into the close path would strand a merged pull request with two
   * open beads, which is the failure the whole close sequence exists to avoid. `prApi` is
   * optional so every existing caller and every test that does not care keeps working.
   */
  const report = mergeReport(spec, { landed, state, review, baseline, how, owner, findings, queuedAt: issue?.created || issue?.createdAt || null });
  if (prApi?.comment && dir) {
    try {
      await prApi.comment(dir, spec.number, report);
    } catch (err) {
      console.error(`[merge-queue] ${issue.id}: merged ${where} but the report did not reach #${spec.number} — ${first(err)}`);
    }
  }
  await bd.comment(ws, issue.id, report).catch((err) => console.error(`[merge-queue] ${issue.id}: merged ${where} but the report did not reach the bead — ${first(err)}`));

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
    .close(ws, issue.id, `${how || `Merged ${where}`}.${over ? ` ${over}` : ''}${findings ? ` ${findings}` : ''}`, { overClaim: true })
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
      .comment(
        ws,
        work,
        `This epic stays **open** over ${where}: an epic closes when its theme is done, not when a branch sharing its name merges.` +
          (findings ? ` ${findings}` : '')
      )
      .catch(() => {});
    return;
  }
  /**
   * The one law, and this is the door it is most likely to arrive at: a worker delivers,
   * the queue merges, and the queue closes what the worker was opened for. **No agent
   * closes a gate and no agent closes a bead waiting to be approved** — lib/approval.js
   * for the whole argument, and for why the rule keys on the merge sentence rather than
   * holding the bead out of every queue.
   *
   * Written out here rather than asked of `Bd.gateFor` for the same reason the epic branch
   * above is: this path does not ask the gate at all. It closes and handles the refusal,
   * which is right for a blocker that clears on its own and wrong for a rule that never
   * will — an owed close for a gate bead would be retried every thirty seconds for the
   * life of the machine, and lib/owed.js drops it precisely so that cannot happen. Asking
   * first is one `bd show` this path has already paid for.
   *
   * The claim is left on it, deliberately, exactly as `epicStaysOpen` leaves an epic's:
   * a gate bead that goes back to `bd ready` unclaimed is one the next advocate tick opens
   * another unattended window on, to be refused again. Assigned and open is what keeps it
   * out of the queue until somebody deals with it on purpose.
   */
  const held = approvalHold(row);
  if (row && held) {
    console.error(`[merge-queue] ${work}: merged ${where} and left it open — ${approvalRefusal(held)}`);
    await bd
      .comment(ws, work, `Merged ${where} by the merge queue, and this bead stays **open**: ${approvalRefusal(held)}.${findings ? ` ${findings}` : ''}`)
      .catch(() => {});
    return;
  }

  await bd
    .comment(ws, work, `Merged ${where} by the merge queue.${over ? ` ${over}` : ''}${findings ? ` ${findings}` : ''}`)
    .catch(() => {});

  const reason = `Merged ${where}.${over ? ` ${over}` : ''}${findings ? ` ${findings}` : ''}`;
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
  // Said out loud because being unsayable is exactly what was wrong with it (bc-91ft): a
  // branch whose resolver had finished left every list this line counts, so the queue's
  // own report of a tick that should have merged it read `''`. Optional because callers
  // predating the field hand this a plain object.
  if (out.reclaimed?.length) bits.push(`${out.reclaimed.length} back from a resolver`);
  // Said as plainly as the resolver's own reclaim, and for the identical reason (bc-91srt):
  // a pull request the queue took back off a card left no trace anybody could read, so the
  // tick that fixed the leak reported nothing at all.
  if (out.restored?.length) bits.push(`${out.restored.length} taken back off a card`);
  // Counted rather than only logged, because a strand is the one thing here that no other
  // number would ever move: it is a pull request outside every list this tick reasons about.
  if (out.stranded?.length) bits.push(`${out.stranded.length} open with no merge-bead`);
  if (out.updated.length) bits.push(`${out.updated.length} downmerged`);
  // First among the things that did not move, because it is the only one of them that is
  // about the *base* rather than about a branch: "3 refused" reads as three bad pull
  // requests, and "3 held — main is red" is one broken repo. Optional for the reason
  // `reclaimed` is: callers predating the field hand this a plain object.
  if (out.held?.length) bits.push(`${out.held.length} held — the base is red`);
  // Beside the hold and for its reason: neither is a branch with a problem, and a queue
  // that reported "4 waiting" over four pull requests nobody has looked at says nothing
  // about the one thing that would move them. Optional for `held`'s reason — a caller
  // predating the field hands this a plain object.
  if (out.awaiting?.length) bits.push(`${out.awaiting.length} awaiting review`);
  if (out.refused.length) bits.push(`${out.refused.length} refused`);
  if (out.raised.length) bits.push(`${out.raised.length} handed over`);
  if (out.waiting.length) bits.push(`${out.waiting.length} waiting`);
  if (!bits.length) return '';
  return `merge queue: ${bits.join(' · ')}`;
}
