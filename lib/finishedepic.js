/**
 * An epic whose children have all closed, and nobody has said whether the theme is done.
 *
 * **And, since bc-xl7n.137, the one other bead that says of itself that its children are
 * the work**: the review follow-up parent lib/reviewfollowup.js files, which is a `task`
 * with `review-followup:<repo>#<n>:r<round>` on it and whose acceptance criteria are
 * literally "every child is closed". Everything below is written about an epic and holds
 * for it word for word — see `isCandidate` for why the population is those two and not
 * every parent, and lib/advocate.js's `heldByChildren` for the other half of that bead,
 * which is what keeps a worker off the same parent while its children are still in flight.
 *
 * bc-xl7n.74. `batchesFor` (lib/advocate.js) skips an epic whose ready children are below
 * `minBatchBeads` — and an epic with **zero** ready children is always below it, whatever
 * the floor is set to. That epic falls through the hierarchy filter and is dispatched as
 * an ordinary ready bead, exactly the case bc-xl7n.14 fixed for a *standing root* by
 * giving containers a machine-readable label. This is the other shape: not a root with
 * nothing under it yet, but a **themed** epic that had a definition of done, reached it,
 * and now has nothing open underneath it. `bc-xl7n.8` is the worked example — 3/3 children
 * closed, `bd show` itself already saying "eligible for close" — and the advocate opened a
 * worker window on it anyway. A worker's one sanctioned ending is `bin/deliver.js`, which
 * needs a branch to push, and a finished epic has none: `bin/deliver.js` exits 2 with "no
 * commits that origin/main does not". The window's only honest ending was a hand-written
 * card, which is a whole session spent producing the one tap this file now offers for free.
 *
 * The shape is lib/superseded.js's and lib/inmain.js's, because it is the same shape: a
 * fact a sweep can establish, a decision that stays with Adam, and no session spent on it.
 * One line on the thread, an ask with a `decision` block appended to the notes so the
 * judgement is one tap from a phone, and the `human` label — which is also the whole of the
 * saving, because `bd ready` excludes `human` and an advocate that cannot see a bead cannot
 * open a session on it. **The card is the bead itself**: answering a `human` bead closes it
 * (`respond` in lib/bd.js), so one tap really is the close.
 *
 * Unlike lib/inmain.js, the close **is** offered here, and deliberately: that file's
 * `closeOffer` withholds it from every epic on principle — "an epic finishes when its theme
 * does, not when a branch sharing its name lands" — because a branch match is coincidental
 * evidence about a bead that happens to mention a ref. "Every child this tracker knows about
 * is closed" is not coincidental in the same way; it is the exact fact bd's own `bd show`
 * already reports as "eligible for close". Recommending the close costs nothing — tapping
 * an option only pre-fills the answer box — and the other option hands the epic straight
 * back to `bd ready` with the finding on it, so a wrong guess here costs one tap to undo,
 * never a stranded epic.
 *
 * **Direct children only, matching the very check that lets this fall through.**
 * `batchesFor`'s and `heldByChildren`'s epic branch both read `bd.children`, which is one
 * level — a grandchild that is open with no live worker on it is a gap those two already
 * accept (a stale claim, or a reclaim) rather than a gap worth a `bd export` per epic per
 * sweep. Asking the identical question here means this sweep and the dispatch path it
 * guards can never disagree about which epics qualify.
 *
 * ## The second question: an epic that was worked as one job, and the work is in main
 *
 * bc-jvt0.5. Everything above is about an epic whose *children* finished. bc-jvt0.4 made a
 * second kind of finished epic possible: one an advocate read, decided did not want
 * splitting, and dispatched as itself. That epic never closes on its own merge —
 * `epicStaysOpen` in bin/deliver.js and the same carve-out in lib/mergequeue.js both leave
 * it open **and claimed** on purpose, so the next tick cannot hand it to a second worker to
 * be refused again. And the sweep above cannot catch it either: it walks `bd ready`, which
 * is "open, unblocked, **nobody on it**", and skips a childless epic by name because "no
 * children" has until now meant a standing root nobody has filled yet. So the work merges,
 * the epic sits open and claimed for ever, and nothing asks about it.
 *
 * Hence a second question, deliberately keyed on a **different population, different
 * evidence and a different fingerprint** from the first:
 *
 * - **Population** — `bd list --label whole-job`, not `bd ready`. It has to be a list that
 *   includes a claimed bead, because *claimed* is the state this case is stuck in, and it
 *   has to be narrow because it is the only list here that is not already filtered down to
 *   claimable work. `WHOLE_LABEL` is both: only an advocate that decided "do it whole"
 *   writes it (lib/plan.js, lib/epicadvocate.js), so no epic that was never judged can be
 *   asked about this way.
 * - **Evidence** — not "every child closed" but "a branch this epic owns is in `main`",
 *   which is `landingMerge` in lib/inmain.js, imported rather than re-derived: the second
 *   parent rule there is what tells a real merge from an unstarted worktree branch, and a
 *   second implementation of it is how the two come to disagree. The branch comes from
 *   `worktreeBranches` + `ownsBranch` (lib/notinmain.js) and **not** from the bead's own
 *   text the way `sweepInMain` reads it: a delivering worker writes its branch into a
 *   *comment* (`Delivered as #N on <branch>`), which is in none of the fields that sweep
 *   scans, so a scan of the epic's prose would find nothing on precisely the beads this
 *   exists for. The tag test is the same one either way.
 * - **Fingerprint** — `WHOLE_MARK`, its own, so the two questions cannot suppress each
 *   other by accident; `alreadyAsked` with no argument reads either, which is what keeps a
 *   bead from collecting both cards and what the P0 board's "Done" affordance reads
 *   (`advocacy.finished`, lib/server.js).
 *
 * **This does not widen lib/inmain.js's rule that an epic is never offered a close on a
 * merge, and it must not be read as arguing with it.** That refusal is about a branch name
 * found in some prose on a bead that may hold a subtree — coincidental evidence, and
 * closing takes the subtree with it. Here the epic was *dispatched as the work*, by a
 * decision recorded on the bead, with nothing under it: the close is offered because the
 * three facts together say the job is done, and any one of them alone would not.
 *
 * Nothing here closes, reopens, merges or deploys anything. It reads the tracker and writes
 * three lines to one bead, and every failure is a returned sentence rather than a throw — a
 * sweep is a courtesy on top of the advocate's tick and may not take the tick down with it.
 */
import { CONTAINER } from './container.js';
import { WHOLE_LABEL } from './plan.js';
import { isFollowUpParent } from './reviewfollowup.js';
import { landingMerge } from './inmain.js';
import { ownsBranch, pickBase, tipOf, worktreeBranches } from './notinmain.js';

/** The label that puts a bead in the inbox and takes it out of every advocate queue. */
const HUMAN_LABEL = 'human';

/** bd's word for a bead that holds work under it rather than being work. */
const EPIC = 'epic';

/** Where the sweep leaves its fingerprint, so it can tell its own work from a rewrite. */
const ASK_MARK = '<!-- beadcause:finishedepic -->';

/**
 * And the second question's own, because it is a different question about a different fact.
 *
 * Two marks rather than one so neither can silence the other by accident: an epic whose
 * children all closed and an epic that was worked as one job are different findings, and a
 * bead that acquired the first would otherwise be permanently unaskable about the second.
 * They are still mutually exclusive *in practice* — see `alreadyAsked` — and that is a
 * decision about how many cards one bead may carry, not an artefact of sharing a string.
 */
const WHOLE_MARK = '<!-- beadcause:wholeepic -->';

/**
 * Has this epic already been asked about? Read off the row the tracker returned.
 *
 * Three fields, lib/superseded.js's set: the notes are where the card actually lives, and
 * description/design are checked because a bead is somebody's to edit — an ask moved by
 * hand is still an ask, and asking again over the top of it would be the sweep arguing
 * with a human.
 *
 * **With no `mark` it reads either question's fingerprint, and both sweeps call it that
 * way.** One bead, one card: a bead already carrying "every child is closed" must not also
 * acquire "the work is in main", because they are two answer boxes over one judgement and
 * whichever is tapped second is answering a question the first already settled. Passing a
 * mark asks the narrower question, which is what a caller wanting to know *which* card is
 * there — a test, or a reader of the thread — actually means.
 */
export const alreadyAsked = (issue, mark = null) => {
  const marks = mark ? [String(mark)] : [ASK_MARK, WHOLE_MARK];
  return [issue?.description, issue?.design, issue?.notes].some((f) =>
    marks.some((m) => String(f || '').includes(m))
  );
};

/**
 * The line on the thread. Short: the card carries the reasoning, this carries the fact.
 */
export const finishedEpicComment = (open, total, { followUp = false } = {}) =>
  `Every one of its ${total} child${total === 1 ? '' : 'ren'} is closed and none is open. Asking whether the ` +
  `${followUp ? 'follow-up' : 'theme'} is finished — see the card in the inbox. Nothing has been closed.`;

/**
 * The card: markdown with a `decision` block in it, appended to the notes.
 *
 * The close is recommended and the other option is a commission (`closes: false`), exactly
 * lib/superseded.js's shape — see the header for why an epic gets the offer here where
 * lib/inmain.js withholds it. Nothing interpolated into the block comes from arbitrary
 * prose: `id` is a bead id and `total` is a count, so nothing here needs quoting the way a
 * branch name or a commit subject would.
 */
export function finishedEpicAsk(id, total, { followUp = false } = {}) {
  const noun = followUp ? 'review follow-up' : 'epic';
  const kids = `${total} child${total === 1 ? '' : 'ren'}`;
  return `${ASK_MARK}
## Every child of ${id} is closed

All ${kids} of this ${noun} ${total === 1 ? 'is' : 'are'} closed, and nothing under
it is open. \`bd show\` already reads this as "eligible for close" — that is a fact about the
tracker, and whether ${
    followUp
      ? 'each of those findings was really dealt with is a judgement only you can make'
      : 'the *theme* is actually finished is a judgement only you can make'
  }.

**Nothing has been closed and nothing will be.** What this label is doing is keeping a
worker window from being opened on ${followUp ? 'a bead' : 'an epic'} that has no diff left to deliver — a worker's
only ending is \`bin/deliver.js\`, and there is nothing here for it to push. If this stays
open and unanswered, nothing else happens to it: no session, no notification, just a bead
sitting out of the queue until you tap one of these.
${
    followUp
      ? '\nThis one is a **review follow-up**: it was filed when a pull request merged over comments\n' +
        'its reviewer had not settled, one child per comment, and its own acceptance criteria are\n' +
        '*every child is closed*. So the tracker has already answered the question the bead was\n' +
        'written with — this is asking whether you agree that each finding really was dealt with,\n' +
        'including any that was closed as not worth doing.\n'
      : ''
  }
\`\`\`decision
question: Every child of ${id} is closed — is the ${noun} finished?
options:
  - id: close
    label: ${followUp ? 'Close it — every finding is dealt with' : 'Close it — the theme is done'}
    response: "All ${kids} are closed. Closing the ${noun} as finished."
    hint: Nothing left to deliver
    recommended: true
  - id: keep
    label: Keep it open — more belongs here
    response: "Not finished — more belongs under this ${noun} than what has closed so far. Handing it back as ordinary work with nothing open underneath it yet."
    hint: Back to bd ready, still with no open child
    closes: false
\`\`\`
`;
}

/** Is this row typed as an epic? */
const isEpicRow = (row) => String(row?.issue_type || row?.type || '').toLowerCase() === EPIC;

/**
 * Is this row worth asking `bd.children` about at all?
 *
 * `bd.ready` has already done most of the work: a container, a ship bead, an unendorsed
 * one, a superseded one and anything already in the inbox never reach here, because they
 * never reach `bd ready`. All that is left to check is the type and the fingerprint.
 *
 * **And since bc-xl7n.137, one bead that is not typed as an epic** — the review follow-up
 * parent lib/reviewfollowup.js files. Everything the header says about a finished epic is
 * true of it word for word: its content is its children, its own acceptance criteria are
 * *every child is closed*, and there is no diff left for `bin/deliver.js` to push. It was
 * dispatched as ordinary work for exactly the reason bc-xl7n.8 was, and it is worse off
 * than an epic in one respect — `maxAttemptsPerBead` retires it into `givenUp` after the
 * second wasted window, which leaves it open and unaskable for ever rather than merely
 * open.
 *
 * **Type-independent evidence, deliberately not a type-independent population.** "Every
 * child this tracker knows about is closed" would be as true of an ordinary task with
 * subtasks, and the card would still be wrong there: a task's body is usually the work, so
 * its children closing says nothing about whether *it* is done, and a card would take
 * legitimate ready work out of the queue to ask a question with no answer. Measured in the
 * beadcause workspace on 2026-08-28: 5 open non-epics have children at all, and two of
 * them are of that kind. So the population is the beads that say of themselves that their
 * children are the work — an epic by its type, a follow-up parent by the keyed
 * `review-followup:` label lib/reviewfollowup.js writes to the parent and to nothing else.
 * A finding *child* carries the plain label and never the keyed one, and has no children
 * of its own either way.
 */
function isCandidate(row) {
  if (!isEpicRow(row) && !isFollowUpParent(row)) return false;
  if (alreadyAsked(row)) return false;
  return true;
}

/**
 * Sweep one workspace. Returns what it flagged and what it did not.
 *
 * `rows` exists for the tests and for a caller that has already read `bd ready` this tick;
 * everything else pays for one. `bd.ready` is the right list to walk rather than an
 * approximation of one: it is exactly the queue `batchesFor` and the ordinary dispatch path
 * build their own picture from, so an epic that qualifies here is an epic that would
 * otherwise have been handed to `heldByChildren` and found workable.
 */
export async function sweepFinishedEpics(bd, ws, { rows = null } = {}) {
  const out = { ok: false, reason: '', checked: 0, flagged: [], skipped: [] };

  let beads = rows;
  if (!beads) {
    try {
      beads = await bd.ready(ws);
    } catch (err) {
      out.reason = `could not read the ready queue — ${String(err.message || err).split('\n')[0]}`;
      return out;
    }
  }

  out.ok = true;
  for (const bead of beads || []) {
    if (!isCandidate(bead)) continue;
    out.checked += 1;

    let children;
    try {
      children = await bd.children(ws, bead.id);
    } catch (err) {
      out.skipped.push({ id: bead.id, why: `could not read its children — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }
    const total = (children || []).length;
    // No children at all is not "finished" — it is a standing root a survey has not
    // reached yet, or an epic brand new this tick. Nothing to say about either.
    if (!total) {
      out.skipped.push({ id: bead.id, why: 'no children at all — nothing to declare finished', quiet: true });
      continue;
    }
    const open = (children || []).filter((c) => c && c.status !== 'closed');
    if (open.length) {
      out.skipped.push({ id: bead.id, why: `${open.length} child${open.length === 1 ? '' : 'ren'} still open`, quiet: true });
      continue;
    }

    // Which of the two questions this is — see `isCandidate`. The card differs in its
    // nouns and in one paragraph, and in nothing else: the fact, the fingerprint, the
    // recommendation and the way out are the same, because the finding is the same.
    const followUp = !isEpicRow(bead);
    try {
      await bd.comment(ws, bead.id, finishedEpicComment(open.length, total, { followUp }));
    } catch {
      // The ask below is the part that matters — the comment is only the record.
    }

    try {
      // The ask, then the label, in that order: the notes are where the card's body and
      // its `decision` block are read from (lib/decision.js), and the label *is* "it is
      // in the inbox". A card that appeared before its options were written would be a
      // question with no answers.
      await bd.appendNotes(ws, bead.id, finishedEpicAsk(bead.id, total, { followUp }));
      await bd.addLabel(ws, bead.id, HUMAN_LABEL);
    } catch (err) {
      out.skipped.push({ id: bead.id, why: `could not put it in the inbox — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }

    out.flagged.push({ id: bead.id, title: bead.title || '', total, followUp });
  }

  return out;
}

/* ------------------------------------------ the epic that was worked as one job */

/**
 * The line on the thread. Short: the card carries the reasoning, this carries the fact.
 */
export const wholeEpicComment = (branch, baseName, landing) =>
  `This epic was worked as one job, and \`${branch}\` is already in \`${baseName}\`` +
  `${landing?.commit ? ` as \`${String(landing.commit).slice(0, 8)}\`` : ''} with nothing open under it. ` +
  `Asking whether it can be closed — see the card in the inbox. Nothing has been closed.`;

/**
 * The card: markdown with a `decision` block in it, appended to the notes.
 *
 * **The close is recommended here where lib/inmain.js stars nothing**, and the difference
 * is the difference between the two findings rather than a difference of nerve. That card
 * carries one fact — a branch whose name appears somewhere on the bead is in `main` — and
 * says outright that the fact cannot tell whether the *bead* is finished. This one carries
 * three, and they are about the bead itself: an advocate read it and recorded that it is
 * one job, that job was dispatched as the epic, and the branch the epic owns has landed.
 * There is nothing under it left to do and no session that could do anything but say so.
 *
 * The other option is a commission (`closes: false`), which is what makes the card
 * answerable both ways: it drops the `human` label and calls `reopenAbandoned`, so "not
 * finished" hands the epic back to `bd ready` **unclaimed** — the one thing the delivery
 * deliberately would not do — with this finding still on it.
 *
 * Quoting, and it is load-bearing: every scalar that could open on the branch name is
 * double-quoted, because a backtick is a reserved indicator at the start of a YAML plain
 * scalar and the failure is silent — lib/decision.js reports the parse error and the card
 * falls back to a free-text box, which looks exactly like a card nobody wrote options for.
 * The landing commit's *subject* is arbitrary text somebody wrote and stays out of the
 * block entirely, in the markdown above where a stray quote is only a stray quote.
 */
export function wholeEpicAsk(id, branch, landing, baseName) {
  const sha = String(landing?.commit || '').slice(0, 8);
  // Stripped of the three characters that would end a fence, start emphasis, or open a
  // code span in the middle of somebody else's sentence.
  const subject = landing?.subject ? String(landing.subject).replace(/[*_`]/g, '') : '';
  return `${WHOLE_MARK}
## ${id} was worked as one job, and that work is in \`${baseName}\`

Its advocate read this epic and decided it did not want splitting — so instead of children
it got a worker, and that worker's branch \`${branch}\` came into \`${baseName}\`${sha ? ` as \`${sha}\`` : ''}${
    subject ? ` — *${subject}*` : ''
  }.
Nothing is open underneath it.

An epic does not close on its own merge: \`bin/deliver.js\` and the merge queue both leave
one open on purpose, because an umbrella epic finishes when its *theme* does and not when a
branch sharing its name lands. That rule is right for the umbrella and it is why this bead
is still here — but this epic was not an umbrella, it was the work, and the work is in. So
the judgement left is yours and it is a small one: is the theme finished, or was the one
job a first step?

**Nothing has been closed and nothing will be.** The epic is also still *claimed*, which is
what has been keeping a second worker from being opened on it to be refused; tapping "keep
it open" takes both that and the \`human\` label off, and it goes back to \`bd ready\` as
ordinary work with this finding on it.

\`\`\`decision
question: "${id} was worked as one job and \`${branch}\` is in ${baseName} — is the epic finished?"
options:
  - id: close
    label: Close it — the work is in main
    response: "Closed: ${id} was worked as one job, and that work is in ${baseName}${sha ? ` as \`${sha}\`` : ''}."
    hint: ${sha ? `Landed as ${sha}, nothing open under it` : 'Nothing open under it'}
    recommended: true
  - id: keep
    label: Keep it open — the one job was a first step
    response: "Not finished: what landed on \`${branch}\` was a step rather than the whole of ${id}. Handing it back as ordinary work."
    hint: Back to \`bd ready\`, unclaimed
    closes: false
\`\`\`
`;
}

/**
 * Is this row one of the second question's? Read off the row `bd list --label` returned.
 *
 * The label is most of it and the list has already done the rest — `listLabel` drops
 * closed beads — so what is left is the three ways a labelled epic can still be the wrong
 * bead to ask. A **container** is a standing root somebody marked as never being work, and
 * a whole-job decision on one would be a contradiction rather than an instruction. A bead
 * already carrying **`human`** is in the inbox with a card on it, and a second card is two
 * answer boxes over one judgement. And a **non-epic** carrying the label is somebody
 * else's write, not this mechanism's.
 */
function isWholeCandidate(row) {
  if (String(row?.issue_type || row?.type || '').toLowerCase() !== EPIC) return false;
  // `listLabel` has already dropped these; a caller handing over rows of its own may not
  // have, and "is this closed epic finished" is the one question with no answer in it.
  if (String(row?.status || '').toLowerCase() === 'closed') return false;
  const labels = (row?.labels || []).map((l) => String(l).trim());
  if (!labels.includes(WHOLE_LABEL)) return false;
  if (labels.includes(HUMAN_LABEL) || labels.includes(CONTAINER)) return false;
  if (alreadyAsked(row)) return false;
  return true;
}

/**
 * Sweep one workspace against one checkout, for the epic that was worked as itself.
 *
 * `rows` is for the tests and for a caller that has already read the label this tick.
 * `dir` is a checkout, because "is it in main" is a question about the repo the branch was
 * cut from and about no other — the caller runs this once per approved checkout, exactly
 * as `flagInMain` does.
 *
 * **The git work is done once for the whole sweep and the per-epic filter is in memory.**
 * One `for-each-ref` gives every `worktree-…` branch this checkout knows about, and
 * `ownsBranch` narrows it to a bead's own by tag. The alternative — a `rev-parse` per bead
 * — is a subprocess per epic per interval to establish what that one call already answered.
 *
 * Order of the two remaining reads is deliberate: git first, `bd.children` second. A
 * whole-job epic whose branch has not landed yet is the ordinary state of one being worked
 * right now, and it is settled without touching the tracker at all.
 */
export async function sweepWholeEpics(bd, ws, dir, { base = 'main', rows = null } = {}) {
  const out = { ok: false, reason: '', checked: 0, flagged: [], skipped: [] };
  const first = (err) => String(err?.message || err).split('\n')[0];

  let beads = rows;
  if (!beads) {
    try {
      beads = await bd.listLabel(ws, WHOLE_LABEL);
    } catch (err) {
      out.reason = `could not read the whole-job epics — ${first(err)}`;
      return out;
    }
  }

  const live = (beads || []).filter(isWholeCandidate);
  // Nothing to ask git about, which is the ordinary answer in every workspace where no
  // advocate has yet decided an epic is one job. Reported as a clean sweep rather than as
  // a checkout that could not be read, because the checkout was never opened.
  if (!live.length) {
    out.ok = true;
    return out;
  }

  const baseRef = await pickBase(dir, base);
  if (!baseRef) {
    out.reason = `neither origin/${base} nor ${base} is a ref in this checkout`;
    return out;
  }
  let branches;
  try {
    branches = await worktreeBranches(dir);
  } catch (err) {
    out.reason = `could not list the branches in this checkout — ${first(err)}`;
    return out;
  }

  out.ok = true;
  for (const bead of live) {
    out.checked += 1;

    const mine = branches.filter((b) => ownsBranch(bead.id, b));
    if (!mine.length) {
      out.skipped.push({ id: bead.id, why: 'no branch of its own in this checkout', quiet: true });
      continue;
    }

    // The first of its own branches that something took *into* the base. A whole-job epic
    // has one, but a re-delivery after a handback leaves two, and either landing is the
    // answer — what is being established is "the work is in", not which branch carried it.
    let landed = null;
    let unreadable = '';
    for (const branch of mine) {
      const tip = await tipOf(dir, branch);
      if (!tip) continue;
      const merge = await landingMerge(dir, tip.sha, baseRef.ref);
      if (merge.landed) {
        landed = { branch, ...merge };
        break;
      }
      // "git could not answer" is not "it has not landed" and must never be filed as one —
      // see `landingMerge`. Kept for the log line and nothing else: a sweep that cannot
      // read one branch has still read the others.
      if (merge.unknown) unreadable = `${branch} — ${merge.why}`;
    }
    if (!landed) {
      out.skipped.push({
        id: bead.id,
        why: unreadable || `nothing of its own has landed in ${baseRef.name} yet`,
        quiet: !unreadable,
      });
      continue;
    }

    let children;
    try {
      children = await bd.children(ws, bead.id);
    } catch (err) {
      out.skipped.push({ id: bead.id, why: `could not read its children — ${first(err)}` });
      continue;
    }
    // Children filed under it *after* the decision — a worker splitting the job as it went,
    // or work discovered from it. Whatever landed, the theme is not finished while one of
    // them is open, and the sweep above is the one that asks once they all close.
    const open = (children || []).filter((c) => c && c.status !== 'closed');
    if (open.length) {
      out.skipped.push({
        id: bead.id,
        why: `${open.length} bead${open.length === 1 ? '' : 's'} filed under it since ${open.length === 1 ? 'is' : 'are'} still open`,
        quiet: true,
      });
      continue;
    }

    try {
      await bd.comment(ws, bead.id, wholeEpicComment(landed.branch, baseRef.name, landed));
    } catch {
      // The ask below is the part that matters — the comment is only the record.
    }

    try {
      // The ask, then the label, for `sweepFinishedEpics`'s reason: the notes are where the
      // card's body and its options are read from, and the label *is* "it is in the inbox".
      await bd.appendNotes(ws, bead.id, wholeEpicAsk(bead.id, landed.branch, landed, baseRef.name));
      await bd.addLabel(ws, bead.id, HUMAN_LABEL);
    } catch (err) {
      out.skipped.push({ id: bead.id, why: `could not put it in the inbox — ${first(err)}` });
      continue;
    }

    out.flagged.push({
      id: bead.id,
      title: bead.title || '',
      branch: landed.branch,
      base: baseRef.name,
      commit: landed.commit || '',
    });
  }

  return out;
}

/** One line for the log and the card. Empty when the sweep found nothing worth saying. */
export function describeWholeEpics(result) {
  if (!result.ok) return result.reason ? `whole-job epic sweep skipped — ${result.reason}` : '';
  if (!result.flagged.length) return '';
  const named = result.flagged.map((f) => `${f.id} (${f.branch} in ${f.base})`).join(', ');
  return `flagged ${result.flagged.length} finished whole-job epic${result.flagged.length === 1 ? '' : 's'} — ${named}`;
}

/** One line for the log and the card. Empty when the sweep found nothing worth saying. */
export function describeFinishedEpics(result) {
  if (!result.ok) return result.reason ? `finished-epic sweep skipped — ${result.reason}` : '';
  if (!result.flagged.length) return '';
  const named = result.flagged.map((f) => `${f.id} (${f.total}/${f.total} closed)`).join(', ');
  // "epic" only while they all are — a follow-up parent is a task, and a console line that
  // calls it an epic is the sweep reporting something other than what it did (bc-xl7n.137).
  const noun = result.flagged.every((f) => !f.followUp) ? 'epic' : 'parent';
  return `flagged ${result.flagged.length} finished ${noun}${result.flagged.length === 1 ? '' : 's'} — ${named}`;
}
