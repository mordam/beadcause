/**
 * What becomes of a reviewer's comments when the branch merges anyway — bc-9ntye.2.
 *
 * Under bc-9ntye the review stops gating the merge: a `blocking` comment still holds a
 * branch and everything else — a suggestion, a question, a piece of structure the
 * reviewer would have written differently — stops being a round and becomes work of its
 * own. This file is the "work of its own" half. One follow-up bead per pull request per
 * verdict round, with one child per comment the merge went over, filed at the moment the
 * merge lands (lib/mergequeue.js's `finish`).
 *
 * **Narrowing what holds a branch is bc-9ntye.1's, not this file's**, and the two are
 * independent: this hangs off the fact of a merge over unresolved comments, which is
 * already reachable without it — an approving verdict that still carries a suggestion, or
 * a pull request Adam admitted himself through `/merge` over the gate. What bc-9ntye.1
 * changes is how *often* that happens, not whether this runs.
 *
 * ## Why the follow-up cannot hang off either bead you would reach for first
 *
 * Both beads in front of it are about to close. The merge-bead closes in the same breath
 * as the merge, by construction — it is the queue's own entry and its whole life is one
 * pull request. The **work bead** closes with it too, unless it is an epic. An open child
 * of a closed parent is the exact shape lib/homing.js was written against: it is under
 * nothing, it is not parentless by any obvious query, and bc-rfnr.7 holds it for ever
 * while every screen draws it as ordinary open work.
 *
 * So the parent is the **root the work bead descends from** — the same answer
 * lib/homing.js gives every other bead this daemon files, reached the same way, and the
 * one lib/advocate.js can then dispatch under (bc-9ntye.3 is what asks that root's
 * advocate to start a worker). `followUpFrom` is the whole of the difference: it hands
 * `homeIn` a `from` that is safe to climb from rather than the work bead itself, because
 * "a root is above itself" (`rootOver`, lib/homing.js) would otherwise answer *the P0
 * task that is closing this second* for a work bead that happens to be a P0.
 *
 * An **epic** work bead is the one case where the work bead itself is the right parent,
 * and it needs no special pleading: `finish` explicitly leaves an epic open over a merge
 * ("an epic closes when its theme is done, not when a branch sharing its name merges"),
 * so it is a parent that survives, and hanging the follow-up under it is what puts the
 * work back in front of that epic's own advocate.
 *
 * ## Idempotence is a label, and it is keyed on the round rather than the merge
 *
 * The sweep re-reads the same review block on every tick and `finish` is best-effort
 * throughout — a crash between the filing and the close leaves the merge-bead open, and
 * the next tick arrives at exactly the same state. Filing a second copy of somebody's
 * review would be the loud failure; so the first thing this does is ask the tracker
 * whether a bead already carries `review-followup:<repo>#<n>:r<round>`, over **every**
 * status including closed (`listLabelAny`), because a follow-up that has already been
 * worked and closed must not be filed again either.
 *
 * The round is in the key rather than only the pull request, deliberately. A pull request
 * that goes round twice — reviewed, answered, re-reviewed — and merges over what is left
 * of round 2 has genuinely different findings from round 1's, and one bead per pull
 * request would silently swallow the second set. Two beads on the same pull request name
 * their rounds and are readable side by side.
 *
 * ## What is filed, and what is deliberately not
 *
 * - **P2, and never higher.** lib/filing.js's `PRIORITY_FLOOR` is the rule and the
 *   argument travels: an agent's finding may not outrank the work Adam chose. A reviewer
 *   that thought otherwise had `blocking` available and would have held the branch.
 * - **Not `agent-filed`.** That label is provenance for a bead an agent filed of its own
 *   accord out of a session; this is the daemon acting on somebody else's verdict, and
 *   lib/jiraepic.js makes the same choice for the same reason (`jira-ticket` rather than
 *   `agent-filed`). `review-followup` is the queryable provenance here.
 * - **Nothing is filed for a comment the worker already answered `changed`.** That is a
 *   change the worker says it made on the branch that just merged; filing it as work
 *   would ask for it a second time. Everything else the reviewer raised and nobody
 *   resolved is filed — including a `declined`, with the worker's own words on the child,
 *   because "the worker declined this" is context for whoever picks it up rather than a
 *   settlement, and including a `blocking` one in the one case it can still be reached:
 *   Adam admitting the pull request himself through `/merge` over the gate. A blocking
 *   finding that merged anyway is the *last* comment worth dropping on the floor.
 */
import { isEpic } from './ownership.js';
import { UNENDORSED } from './endorse.js';

/** Provenance: this bead exists because a review found something and the branch merged anyway. */
export const FOLLOWUP_LABEL = 'review-followup';

/** The keyed half of the same label — one per pull request per round, and the thing asked about. */
export const FOLLOWUP_KEY_PREFIX = 'review-followup:';

/**
 * The best a follow-up may be, and it is `PRIORITY_FLOOR`'s number for `PRIORITY_FLOOR`'s
 * reason: what an agent noticed does not outrank what a person chose to work on.
 */
export const FOLLOWUP_PRIORITY = 2;

/** How much of a reviewer's sentence reaches a bead title before it is cut. */
export const TITLE_MAX = 120;

/** One line, bounded — a bd title may not carry a newline and a reviewer's prose may. */
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The first line of whatever went wrong, which is all a log line has room for. */
const first = (err) => String(err?.message || err || '').split('\n')[0].trim();

/** `Climative/architecture` → `climative/architecture`; a label is compared literally. */
const slug = (repo) => String(repo || '').trim().toLowerCase();

/**
 * The label one pull request's round of findings is filed under — the idempotence key.
 *
 * The repo is in it because a pull request number is unique only within a repository and
 * one workspace here covers forty checkouts, and the round is in it for the reason the
 * header gives. Empty when the number or the round is missing, and an empty key is a
 * refusal to file at all rather than a bead filed under a key nothing can find again.
 *
 * The **workspace** stands in for a repo a delivery did not name — `repo` is nullable on
 * `parseDelivery`'s spec, and one namespace shared by forty checkouts is still a namespace
 * where a literal `unknown` would let #42 in one repo suppress #42 in another.
 */
export function followUpKey({ repo = '', workspace = '', number = null, round = 0 } = {}) {
  const n = Number(number);
  const r = Number(round);
  if (!Number.isInteger(n) || n <= 0) return '';
  if (!Number.isInteger(r) || r <= 0) return '';
  return `${FOLLOWUP_KEY_PREFIX}${slug(repo) || slug(workspace) || 'unknown'}#${n}:r${r}`;
}

/**
 * The comments a merge went over — what the follow-up is one child per.
 *
 * Unresolved, because a resolved comment is one the reviewer has looked at again and is
 * satisfied by. Not `changed`, because that is work the worker says is already on the
 * branch that merged. Everything else — no answer at all, `clarify`, `declined` — is a
 * finding nothing has dealt with, whatever its severity. See the header for why severity
 * is carried onto the child rather than filtered on here.
 */
export const followUpOwed = (review) =>
  (review?.comments || []).filter((c) => c && !c.resolved && String(c.answer || '') !== 'changed');

/**
 * Which bead the follow-up should be homed *from* — never one the merge is about to close.
 *
 * Handed to `homeIn` as `from`, so everything downstream of it is lib/homing.js's ordinary
 * rule: the root that bead descends from, then the unsorted backlog, then nothing.
 *
 * - An **epic** work bead answers itself, because `finish` leaves an epic open over a
 *   merge and `rootOver` puts a root above itself — so the follow-up lands under the epic
 *   whose theme it belongs to.
 * - Any other work bead answers its **parent**, which is one step further up than
 *   `homeIn` would have climbed from the work bead itself. For an ordinary task under an
 *   epic the two agree; for a P0 task, which is a root, they do not — and the one that
 *   disagrees is the one that would have parented an open bead under a bead closing this
 *   second.
 * - A work bead with no parent at all answers `''`, which is `homeIn` falling through to
 *   the unsorted backlog. That is the honest home for a finding on loose work: somebody
 *   has to decide where it belongs, and that is exactly what the backlog means.
 */
export function followUpFrom(index, bead) {
  const id = String(bead || '').trim();
  if (!id) return '';
  const row = index?.beads?.get?.(id);
  if (row && isEpic(row)) return id;
  /**
   * One step up, and the index that has never heard of this bead falls here too — a work
   * bead filed inside the last minute is not in it, since `graph` caches for one. That is
   * the safe direction: an unknown bead answers `''` and lands in the unsorted backlog,
   * where a guess would have parented it under something that may be closing.
   */
  return String(index?.parents?.get?.(id) || '').trim();
}

/** `lib/example.js:42`, or `''` for a comment about the diff as a whole. */
const where = (c) => {
  const path = oneLine(c?.path || c?.file, 200);
  if (!path) return '';
  const line = Number(c?.line);
  return Number.isInteger(line) && line > 0 ? `${path}:${line}` : path;
};

/**
 * The follow-up's own title.
 *
 * The pull request number leads for `epicTitle`'s reason in lib/jiraepic.js: it is what
 * makes two of these un-confusable to lib/dupe.js and to a person reading `bd ready`,
 * where every other word in the line is the same every time. The work bead's id rides
 * along because naming it is also what draws the `relates-to` edge back to it
 * (`relateMentions`, lib/bd.js) — one sentence, one edge, and no second write.
 */
export function followUpTitle(spec, comments, { round = 0 } = {}) {
  const n = comments.length;
  const bead = oneLine(spec?.bead, 40);
  return oneLine(
    `Review follow-up #${spec?.number}${bead ? ` — ${bead}` : ''}: ${n} finding${n === 1 ? '' : 's'} ` +
      `the merge did not wait for${round ? ` (round ${round})` : ''}`,
    TITLE_MAX
  );
}

/** One comment's title, and it opens with where the reviewer was pointing. */
export function childTitle(comment, { number = null } = {}) {
  const at = where(comment);
  const lead = at || (number ? `#${number}` : 'the diff');
  return oneLine(`${lead} — ${oneLine(comment?.body, TITLE_MAX)}`, TITLE_MAX);
}

/**
 * A comment's severity as a word. `reviewComment` (lib/mergebead.js) lands an unrecognised
 * or absent one as `''` on purpose — a *defined* unknown — so it is said as `unrated` here
 * rather than left as a gap where a reader would supply the wrong word for themselves.
 */
const severityOf = (c) => oneLine(c?.severity, 40) || 'unrated';

/**
 * The follow-up's description: what merged, what was still open when it did, and where the
 * whole of it can be read.
 *
 * Written for somebody who has opened this in `bd show` months later with no memory of the
 * pull request, which is the only way one of these is ever read. So it says what happened
 * to the branch first — a reader's first question is always "did this land?" — and only
 * then what is owed.
 */
export function followUpBody(spec, comments, { mergeBead = '', round = 0, landedAs = '' } = {}) {
  const n = comments.length;
  const link = spec?.url ? `[#${spec.number}](${spec.url})` : `#${spec?.number}`;
  const lines = [
    `**${link} merged with ${n} review finding${n === 1 ? '' : 's'} still open.** Under bc-9ntye a review no ` +
      'longer holds a branch unless it found something `blocking`; everything else it raised becomes work ' +
      'rather than another round of review, and this is that work.',
    '',
    `The reviewer's round ${round || 1} verdict is on ${mergeBead ? `**${mergeBead}**` : 'the merge bead'}, in the ` +
      '`beadcause:review` block in its notes, with every comment it raised and whatever the worker said back. ' +
      'Nothing here paraphrases it: one child below per finding, in the reviewer\'s own words.',
  ];
  if (spec?.bead) {
    lines.push(
      '',
      `The work itself was **${spec.bead}**. This bead is not that work reopened — the branch merged and, ` +
        'unless it is an epic, that bead closed with it. It is what a reviewer would have asked for in a ' +
        'second round, filed where it can be scheduled against everything else instead of holding a pull ' +
        'request open.'
    );
  }
  if (landedAs) lines.push('', `Merged as \`${landedAs}\`.`);
  lines.push(
    '',
    '**Closing a child is a real answer.** A finding that turns out to be wrong, already fixed, or not worth ' +
      "doing is closed with that as the reason — the reviewer's comment is evidence, not an instruction."
  );
  return lines.join('\n');
}

/** One child's description — the comment, whole, and what the worker had already said about it. */
export function childBody(comment, spec, { mergeBead = '', round = 0 } = {}) {
  const at = where(comment);
  const lines = [
    `**${severityOf(comment)}** — raised by beadcause's ReviewAdvocate on ` +
      `${spec?.url ? `[#${spec.number}](${spec.url})` : `#${spec?.number}`}` +
      `${at ? `, at \`${at}\`` : ', about the diff as a whole'}.`,
    '',
    `> ${oneLine(comment?.body, 600)}`,
  ];
  if (comment?.why) lines.push('', `Why it matters, in the reviewer's words: ${oneLine(comment.why, 400)}`);
  if (comment?.answer) {
    lines.push(
      '',
      `**The worker answered \`${oneLine(comment.answer, 40)}\`**${comment.note ? `: ${oneLine(comment.note, 400)}` : '.'} ` +
        'That answer was never re-reviewed — the branch merged instead — so it is context rather than a settlement.'
    );
  }
  lines.push(
    '',
    `The branch merged over this${round ? ` at round ${round}` : ''}: it was not \`blocking\`, or it was ` +
      `admitted past the gate. The verdict it came from is on ${mergeBead ? `**${mergeBead}**` : 'the merge bead'}.`
  );
  return lines.join('\n');
}

/**
 * Everything the filer would write, without a tracker to write it to — the pure half.
 *
 * Separate from `fileReviewFollowUp` for lib/filing.js's reason: this is the whole of the
 * decision and none of the I/O, so a test asking what a follow-up says about a `declined`
 * comment needs no `bd`, no GitHub and no merge. `null` when nothing is owed, which is
 * the ordinary case on every pull request a reviewer approved cleanly.
 */
export function followUpPlan(spec, review, { mergeBead = '', parent = '', landedAs = '', labels = [] } = {}) {
  const round = Number(review?.round) || 0;
  const key = followUpKey({ repo: spec?.repo, workspace: spec?.workspace, number: spec?.number, round });
  const comments = followUpOwed(review);
  if (!key || !comments.length) return null;
  return {
    key,
    round,
    comments,
    parent: {
      title: followUpTitle(spec, comments, { round }),
      type: 'task',
      priority: FOLLOWUP_PRIORITY,
      body: followUpBody(spec, comments, { mergeBead, round, landedAs }),
      acceptance:
        'Every child is closed — each one either done, or closed with the reason it was not worth doing. ' +
        'Nothing here is finished by re-reviewing the pull request; it merged.',
      parent,
      labels: [FOLLOWUP_LABEL, key, ...labels],
    },
    children: comments.map((c) => ({
      title: childTitle(c, { number: spec?.number }),
      type: 'task',
      priority: FOLLOWUP_PRIORITY,
      body: childBody(c, spec, { mergeBead, round }),
      labels: [FOLLOWUP_LABEL, ...labels],
    })),
  };
}

/**
 * File it, once — the impure half, and every failure in it is best-effort.
 *
 * It runs after a merge that has already happened, from `finish` in lib/mergequeue.js,
 * which is a path with one rule over all others: nothing here may stand between a merge
 * and the two closes behind it. So this never throws. A tracker that would not take the
 * follow-up leaves a line in the daemon log and `null` for the caller's sentence, which
 * costs a bead somebody has to notice; a throw would strand a merged pull request with
 * two open beads, which is the failure the whole close sequence is ordered to avoid.
 *
 * Returns `{ id, key, children, comments }`, or `null` for *nothing owed*, *already
 * filed*, and *could not file* alike — the caller's only question is whether it has a
 * bead id to name, and `filed` distinguishes the three for a test and for the log.
 */
export async function fileReviewFollowUp(
  bd,
  workspace,
  { issue = null, spec = null, review = null, parent = '', landedAs = '', endorsed = false, log = () => {} } = {}
) {
  if (!bd || !spec) return null;
  /**
   * `endorsed` defaults to *false*, which is the opposite of what the epic wants and is
   * still the right default here: a caller that has not asked lib/spaces.js gets the hold
   * rather than a bead born workable in a workspace whose answer was never read. The
   * workspaces that auto-endorse — beadcause among them — pass `true`, and the follow-up
   * takes its turn in `bd ready` exactly as bc-9ntye asks.
   *
   * The marker goes on the children as well as on the parent. `bd create --parent` no
   * longer hands labels down (`--no-inherit-labels`, lib/bd.js), so a held parent with
   * unheld children would be five beads in every queue under one nobody has endorsed.
   */
  const plan = followUpPlan(spec, review, {
    mergeBead: issue?.id || '',
    parent,
    landedAs,
    labels: endorsed ? [] : [UNENDORSED],
  });
  if (!plan) return null;

  /**
   * Has this round already been filed? — over every status, closed included.
   *
   * A follow-up that was filed, worked and closed an hour ago must not be filed again by
   * a sweep that re-read the same block, and `listLabel` (live only) would answer *no*
   * about exactly that bead. `listLabelAny` is the one that cannot.
   *
   * A tracker that will not answer holds the filing rather than duplicating it, which is
   * the same direction every other unanswerable question in this loop takes: a missing
   * follow-up is a bead somebody notices, a second copy of a reviewer's whole verdict is
   * noise nobody can tell from the first.
   */
  let already;
  try {
    already = await bd.listLabelAny(workspace, plan.key);
  } catch (err) {
    log(`could not ask ${workspace?.name || 'the tracker'} whether ${plan.key} is already filed — ${first(err)}`);
    return null;
  }
  if ((already || []).length) {
    const found = already[0];
    return { id: found?.id || '', key: plan.key, children: [], comments: plan.comments, filed: false, already: true };
  }

  let id;
  try {
    id = await bd.create(workspace, plan.parent);
  } catch (err) {
    log(`merged over ${plan.comments.length} review finding(s) and could not file the follow-up — ${first(err)}`);
    return null;
  }
  if (!id) return null;

  /**
   * The children, one per finding, each caught on its own.
   *
   * Embedded Dolt is single-writer and a create can lose a lock race; `fileBeads` makes
   * the same argument about a session filing three discoveries at 02:00. A child that
   * collided must not take the four beside it with it, and the parent is already filed by
   * this point — so a partial tree is a bead with a body naming what is missing, which is
   * recoverable, where a throw here would be a merge sequence stopped halfway.
   */
  const children = [];
  for (const child of plan.children) {
    try {
      const kid = await bd.create(workspace, { ...child, parent: id });
      if (kid) children.push(kid);
    } catch (err) {
      log(`${id}: a review finding did not become a child — ${first(err)}`);
    }
  }
  return { id, key: plan.key, children, comments: plan.comments, filed: true, already: false };
}

/**
 * The sentence the merge report and the close reason carry when a branch merged over open
 * findings — `''` when it did not, so every caller can append it unconditionally.
 *
 * It names the bead, which is the epic's own acceptance criterion: a card or a closing
 * comment saying "merged with open review findings" and not saying *where they went* is
 * the same dead end as the comment that used to say a bead had closed when it had not.
 */
export function followUpSentence(result) {
  if (!result?.id) return '';
  const n = result.comments?.length || 0;
  const kids = result.children?.length || 0;
  if (result.already) {
    return `It merged over ${n} open review finding${n === 1 ? '' : 's'}, already filed as **${result.id}**.`;
  }
  return (
    `It merged with ${n} review finding${n === 1 ? '' : 's'} still open — they are **${result.id}**` +
    `${kids ? `, one child per finding` : ''}, not another round of review.`
  );
}
