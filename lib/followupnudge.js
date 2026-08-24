/**
 * Telling a root's Epic Advocate that a review follow-up just landed under it — bc-9ntye.3.
 *
 * bc-9ntye.2 files the follow-up: a merge that went over unresolved review findings leaves
 * a bead behind, parented onto the root the work bead descended from (`followUpFrom`,
 * lib/reviewfollowup.js). This file is the sentence after that one. The bead is filed and
 * open and unclaimed, which is already what `bd ready` means — so **most of the time
 * nothing here needs to run at all**, and that is the design rather than a gap in it.
 *
 * ## The one case the ready queue does not cover, and why it is the common one
 *
 * A root with an Epic Advocate on it is not scheduled by `bd ready` alone. Its advocate is
 * what dispatches work under it, one window at a time, and the re-entry sweep is what
 * starts that advocate: `reentryFor` (lib/reenter.js) compares the subtree against the
 * snapshot it kept and opens a window when something *was filed under it*. A follow-up
 * filed by a merge is exactly such an event, so the no-window case is already handled and
 * this file deliberately adds nothing to it.
 *
 * What that sweep does **not** do is interrupt. Its five holds are in `reenter`
 * (lib/advocate.js) and the fourth of them is *"a session already names it"*: while an
 * Epic Advocate window is live on the root, the sweep declines to open a second one, which
 * is right — one window per epic is the rule the launch door refuses on. But an advocate
 * window plans and dispatches near the top of its turn and then supervises for the rest of
 * it. A bead filed into its tree twenty minutes in is invisible to it: it read `bd
 * children` once, the graph has moved, and nothing tells it. So the follow-up waits for
 * that window to end *and* for the re-entry cooldown (three hours by default) to lapse
 * before anything looks at it again.
 *
 * That window being live is not the rare case — it is the likely one, because a merge is
 * itself an event under that epic and the same advocate is usually the reason a worker was
 * on the branch at all. So the nudge is a message into a window that is already open, and
 * it is the same channel `epicPause` uses for the same reason: `messageSession` is the one
 * way anything on this Mac can say something to a session that is already running.
 *
 * ## What counts as "an advocated epic"
 *
 * `wantsAdvocate` **and** `isEnrolled`, which is the pair `advocatedRoots` (lib/reenter.js)
 * already uses, and it is used here rather than re-derived so this and the sweep can never
 * disagree about which roots have an advocate. Each half answers a different question and
 * neither is sufficient:
 *
 * - `wantsAdvocate` is the launch door's gate — a root, open, owned, not a crash bead. It
 *   is a *display* predicate: it is true of every epic that could have an advocate,
 *   including the great many that never have.
 * - `isEnrolled` is whether one has actually been on it, by either carrier — the
 *   `advocate-assigned` label or a `waitingOn` block in the notes.
 *
 * A root that passes `wantsAdvocate` alone has no advocate to tell, and messaging nothing
 * is not the failure — *saying* that a root has been told when it has not is, because the
 * merge report and the daemon log both quote this. Note that `wantsAdvocate` accepts a P0
 * task root as well as an epic, which is what "advocated epic" means everywhere else in
 * this repo (`epicAdvocates`, `advocatedRoots`, the epic board all include them); the bead
 * asked for the epic and this is that phrase's ordinary reading here.
 *
 * ## Everything effectful is injected, and nothing here can fail a merge
 *
 * `sessions`, `reach` and `say` are the three things this does *to* a Mac and all three
 * are injectable for `createAdvocates`' reason: the real ones read a live process table
 * and drive iTerm through an Apple event, which no suite should need. `tellEpicAdvocate`
 * never throws — it is called from `finish` in lib/mergequeue.js, on a path with one rule
 * over all others: the merge has already happened, and nothing between it and the two
 * closes behind it may stand in their way. A window that could not be reached is a bead
 * that waits for the re-entry sweep, which is where it would have waited anyway.
 */
import { rootOver } from './homing.js';
import { advocateSession, isEnrolled, wantsAdvocate } from './epicadvocate.js';
import { liveSessions } from './claude.js';
import { messageSession, sessionReach } from './session.js';

/** The first line of whatever went wrong, which is all a log line has room for. */
const first = (err) => String(err?.message || err || '').split('\n')[0].trim();

/**
 * The advocated root over a bead, or `''` — `rootOver` answering *which*, then the same
 * two questions `advocatedRoots` asks of every root it queues.
 *
 * `from` is the bead to climb from, and the caller chooses it rather than this file: on the
 * merge path it is `followUpFrom(index, workBead)`, which is the very same value `homeIn`
 * was handed, so the root this answers is by construction the root the follow-up was filed
 * under. Climbing from the work bead itself would answer differently for a P0 work bead —
 * `followUpFrom` exists for that reason and its docblock has the argument.
 *
 * An index that could not be read (`Bd.graph`'s empty stand-in) has no roots in it, so this
 * answers `''` and the merge writes nothing about an advocate. That is the safe direction:
 * the bead is filed either way and the re-entry sweep reads the graph again on its own
 * clock.
 */
export function advocatedRootOver(index, from, { wants = wantsAdvocate, enrolled = isEnrolled } = {}) {
  const id = rootOver(index, from);
  if (!id) return '';
  const row = index?.beads?.get?.(id);
  if (!row) return '';
  return wants(row) && enrolled(row) ? id : '';
}

/**
 * What the advocate's window is told, and it is written to be acted on rather than read.
 *
 * Multi-line, like `pauseMessage` and unlike the check-in, for the same reason: this is a
 * change to what is under the epic, not a question with a deadline, and a change of plan
 * flattened into one line is a change of plan that gets skimmed. `messageSession` sends it
 * as typed and submits it as one turn.
 *
 * Three things it has to say and nothing else. **The bead exists** — with its id, because
 * an id is the only part of this the advocate can act on. **Where it came from** — a merge
 * that went over a reviewer's findings, so the advocate does not go looking for a pull
 * request to re-review; there is nothing to review, it merged. And **that closing a child
 * is a real answer**, which is the same sentence `followUpBody` puts on the bead itself:
 * these are a reviewer's findings, not a plan, and an advocate that reads them as work it
 * must dispatch in full will spend windows on suggestions somebody should simply decline.
 *
 * It does not tell the advocate to drop what it is doing. It cannot know what that window
 * is holding, and a message that overrides an advocate's own judgement about its epic is
 * the one thing this channel should never carry — `epicPause` is what exists for that, and
 * it is a person's decision.
 */
export function nudgeMessage(root, followUp, spec, { title = '' } = {}) {
  const id = String(followUp?.id || '');
  const n = followUp?.comments?.length || 0;
  const kids = followUp?.children?.length || 0;
  const pr = spec?.number ? `#${spec.number}` : 'a pull request';
  const work = String(spec?.bead || '');
  return [
    `** BEADCAUSE ** ${id} was just filed under ${root}${title ? ` — ${title}` : ''}.`,
    '',
    `${pr} merged with ${n} review finding${n === 1 ? '' : 's'} still open. Under bc-9ntye those stop`,
    `being another round of review and become work, and ${id} is that work${
      kids ? ` — with ${kids} child${kids === 1 ? '' : 'ren'}, one per finding` : ''
    }.`,
    work ? `The branch was ${work}'s and it is in \`main\`; there is nothing left to review.` : '',
    '',
    `It arrived after you last read this epic's children, so nothing else will tell you about it until`,
    `your window ends. Take it into what you are already doing: **\`bd show ${id}\`**, then start a worker`,
    'on it, or on whichever of its children is worth one, exactly as you would any other child.',
    '',
    '**Closing a child is a real answer.** These are one reviewer\'s findings on a diff that has already',
    'landed — a finding that is wrong, already fixed, or not worth doing is closed with that as the',
    'reason. Dispatching all of them because they are there is the failure this is most likely to cause.',
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
}

/**
 * Tell the advocate, if there is a window to tell — the impure half, and it never throws.
 *
 * Three answers and they are deliberately distinct, because the log line and the merge
 * report both quote this and "we did not need to" must never be reported as "we did":
 *
 * - **`told`** — the message landed in a live window.
 * - **`missing`** — a session named the root, and by the time we typed the window had gone.
 *   The re-entry sweep will open a fresh one on the `filed` event; nothing is owed.
 * - **`none`** — nothing on this Mac names the root. The ordinary case, and the one that
 *   needs no code: `reentryFor` sees the follow-up as a bead filed under the epic and opens
 *   a window on it in its own time.
 *
 * `why` carries `sessionReach`'s own sentence when a session exists and cannot be typed
 * into — headless, or a terminal iTerm is not showing. That is a real state and not a
 * failure of this: a session run over the SDK has no input line, and saying so beats
 * silence.
 */
export async function tellEpicAdvocate(
  cfg,
  { root = '', followUp = null, spec = null, title = '' } = {},
  { sessions = null, reach = sessionReach, say = messageSession, now = Date.now() } = {}
) {
  const id = String(root || '').trim();
  if (!id || !followUp?.id) return { state: 'none', root: id, pid: null, why: '' };

  let live = null;
  try {
    live = advocateSession(sessions || liveSessions(cfg), id, { now });
  } catch (err) {
    return { state: 'none', root: id, pid: null, why: first(err) };
  }
  // `opening` is a launch this Mac made that nothing on disk has caught up with yet: there
  // is no pid, so there is nothing to type into — and there is nothing owed either, since a
  // window coming up now reads the epic's children as its first act and will see the bead.
  if (!live?.pid) return { state: 'none', root: id, pid: null, why: '' };

  let where;
  try {
    where = await reach(live.pid);
  } catch (err) {
    return { state: 'none', root: id, pid: live.pid, why: first(err) };
  }
  if (!where?.can) return { state: 'none', root: id, pid: live.pid, why: String(where?.why || '') };

  try {
    const answer = await say(where.tty, nudgeMessage(id, followUp, spec, { title }));
    return answer === 'missing'
      ? { state: 'missing', root: id, pid: live.pid, why: `${where.tty} is no longer an iTerm session` }
      : { state: 'told', root: id, pid: live.pid, why: '' };
  } catch (err) {
    // iTerm refusing an Apple event is not the window being gone, and the two must not be
    // reported as the same thing — `messageSession` makes the same distinction and for the
    // same reason one step up: `missing` frees things out from under a session that is
    // still working.
    return { state: 'none', root: id, pid: live.pid, why: first(err) };
  }
}

/**
 * The log line, or `''` for the ordinary nothing-to-say — `describeMarked`'s shape in
 * lib/retitle.js, and the same argument: the caller decides whether a sentence is worth a
 * line, and a helper that logged for itself would be a second voice in the daemon's output.
 */
export function describeNudge(result, followUp) {
  const bead = String(followUp?.id || '');
  if (!result || !bead) return '';
  if (result.state === 'told') {
    return `told ${result.root}'s advocate about ${bead}${result.pid ? ` (pid ${result.pid})` : ''}`;
  }
  if (result.state === 'missing') {
    return `${result.root}'s advocate window had gone before ${bead} could be handed to it — the re-entry sweep has it`;
  }
  return result.why ? `could not reach ${result.root}'s advocate about ${bead} — ${result.why}` : '';
}
