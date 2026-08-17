/**
 * The worker's answer to a review — what a delivered worker is told when its pull request
 * comes back with comments on it, and what it may write in reply.
 *
 * **Not `handback`**, which this bead's own title calls it and which is taken: that word
 * already means the *claim* a dead window was still holding (`handBack` in lib/advocate.js,
 * test/handback.mjs). Two mechanisms under one name is a grep that answers with the other
 * one, so the review round is `reviewanswer` everywhere.
 *
 * bc-36xx.6. lib/reviewadvocate.js is the other end of this conversation: a reviewer reads
 * the diff, raises comments and writes a verdict. This file is the answer to it. Adam's
 * sentence is the whole specification — *"all reviewer comments are handed back to the
 * worker. the worker considers the changes and either makes the suggested change, asks for
 * more clarity, or declines the comments"* — and those three are already the vocabulary in
 * lib/mergebead.js's `REVIEW_ANSWERS`.
 *
 * ## The worker is reopened per round, and does not sit through one
 *
 * bc-sa29, answered 2026-08-17. The reviewer posts its comments and exits; a sweep opens a
 * *new* worker window on the branch with the unresolved comments in its brief; that window
 * answers, pushes and exits. No process spans a round.
 *
 * That is not a reversal of bc-r941, which is the decision that took the merge away from
 * the worker in the first place. bc-r941's actual claim was that nothing *outside a
 * session* may hold work in its head, and it survives here by making the round durable —
 * the review block on the merge-bead is the conversation, and every window that touches it
 * reads it from there. It has to be that way round: this daemon restarts itself on its own
 * merges several times a day, so "the worker is still sitting there waiting" was always a
 * claim about a process that routinely dies.
 *
 * ## The one answer the worker does not get to give
 *
 * It may not decide a comment is settled. `resolved` is the reviewer's field and its
 * comment in lib/mergebead.js says so — *"Only the reviewer writes this."* The worker
 * replies to each comment and pushes; the reviewer reads the replies on its next pass and
 * resolves the ones it accepts, leaving the rest open.
 *
 * That is also what makes the rest of Adam's sentence — *"any declined comments or further
 * changes must be raised to the ReviewAdvocate for scrutiny"* — true by construction
 * rather than by a second mechanism. A declined comment is simply one the worker did not
 * resolve **and cannot**, so it arrives in front of the reviewer next round on its own; so
 * does a `changed`, because a change somebody made is a change somebody has to check. See
 * `commentsForReviewer`, which selects exactly that population.
 *
 * So `checkAnswers` **refuses** a `resolved` rather than dropping it. Dropping it silently
 * would leave the worker believing it had closed a thread that is still open, which is the
 * one misunderstanding this loop cannot afford: it is the difference between "I answered
 * three comments" and "I finished the review".
 *
 * ## Why the answers arrive through a command
 *
 * `bin/answer.js`, and not the worker editing `notes` with `bd update`. The review block is
 * one field shared with the merge queue's own state block, rewritten by a daemon tick that
 * knows nothing about this window; a worker composing YAML into it by hand gets three
 * things right out of four, and the fourth is somebody's round. The command reads the
 * block, applies the answers through `withAnswers` below, and writes the field back through
 * `withReviewBlock` — the same cutter every other writer of that field uses.
 *
 * ## What this file is deliberately not
 *
 * - **Not the sweep.** What notices that a review has comments and opens the window is the
 *   caller's; `openReviewAnswerSession` in lib/session.js is the door, and the tick that knocks
 *   on it belongs with the rest of the review gate (bc-36xx.4/.5).
 * - **Not the round count.** A worker's reply does not advance a round and nothing here
 *   writes one: `round` counts *reviewer* passes, which is what the cap in bc-36xx.7 is a
 *   cap on. A worker that answered three times without pushing anything has spent nothing,
 *   and that falls out of this file writing only `answer` and `note`.
 * - **Not the approval.** Whether a push after an approval invalidates it is bc-36xx.10's
 *   sha and bc-36xx.4's judgement. What this file owes that decision is that the worker's
 *   push is the worker's own commits on its own branch — never a merge performed on its
 *   behalf — which is what the brief says in the paragraph about pushing.
 */
import YAML from 'yaml';
import { REVIEW_ANSWERS, commentsForWorker } from './mergebead.js';
import { debriefBrief, notesBrief } from './memory.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Where a comment is, as one string — `lib/x.js:42`, or nothing when it is about the change as a whole. */
export const commentAt = (c) => (c?.path ? `${c.path}${c.line ? `:${c.line}` : ''}` : '');

/**
 * The answers a worker wrote, out of the document it handed in.
 *
 * YAML, and a list, because that is what the brief prints and what a heredoc in a terminal
 * survives. Three shapes are accepted and they are the three a session actually writes: a
 * bare list, a mapping with `answers:` in it, and a single answer written as one mapping
 * because there was only one comment.
 *
 * `null` for anything unparseable rather than a throw, and the caller turns that into a
 * sentence — `checkAnswers` is where every other refusal is worded, and a YAML syntax error
 * printed as a stack trace to an unattended window is a window that gives up.
 */
export function parseAnswers(text) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  let raw;
  try {
    raw = YAML.parse(body);
  } catch {
    return null;
  }
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return null;
  if (Array.isArray(raw.answers)) return raw.answers;
  return [raw];
}

/**
 * Check what the worker wrote against the comments it was actually asked about, and hand
 * back the normalised answers.
 *
 * `{ answers, error }` rather than a throw, for `checkVerdict`'s reason one file over: the
 * thing reading this is an agent in a window nobody is watching, and what it needs back is
 * a sentence it can act on. Every refusal below names the id it is about.
 *
 * Six rules, and each is an answer the loop would be *wrong* about rather than one it
 * cannot render:
 *
 * 1. **An id that is not in the block is refused.** A typo in an id is otherwise an answer
 *    that lands nowhere: the worker believes it replied, the reviewer sees an unanswered
 *    comment, and the round is spent on a misunderstanding neither of them can see.
 * 2. **An answer outside `REVIEW_ANSWERS` is refused rather than coerced.** Same argument
 *    as the reviewer's severities: guessing "declined" from "reject" would put words in the
 *    worker's mouth on the one field the next round is judged on.
 * 3. **`resolved` is refused, loudly.** The reviewer's field, and the header says why this
 *    is a refusal rather than a quiet drop.
 * 4. **`clarify` and `declined` must say why.** A decline with no sentence is a comment the
 *    reviewer cannot act on and a round burned learning nothing — and "asks for more
 *    clarity" with no question in it is not a question. `changed` may stand alone, because
 *    the diff is its own account, though the brief asks for a line anyway.
 * 5. **Two answers to one comment is refused.** Last-wins would silently discard the first,
 *    and which of the two the worker meant is not a default anything should pick.
 * 6. **A comment the reviewer has already resolved may not be answered.** It is settled;
 *    an answer to it is a worker acting on a stale copy of the block, and the honest reply
 *    is to say so rather than to record an answer nobody will read.
 */
export function checkAnswers(raw, state) {
  const list = Array.isArray(raw) ? raw : null;
  if (!list) return { answers: [], error: 'the answers are not a YAML list — see the brief for the shape' };
  if (!list.length) return { answers: [], error: 'there are no answers in it' };

  const comments = Array.isArray(state?.comments) ? state.comments : [];
  const byId = new Map(comments.map((c) => [String(c.id), c]));
  const answers = [];
  const seen = new Set();

  for (const [i, a] of list.entries()) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { answers: [], error: `answer ${i + 1} is not a mapping` };
    const id = clean(a.id);
    if (!id) return { answers: [], error: `answer ${i + 1} names no comment — every answer needs the \`id\` the reviewer gave it` };
    const comment = byId.get(id);
    if (!comment) {
      const known = comments.map((c) => `\`${c.id}\``).join(', ') || 'none at all';
      return { answers: [], error: `there is no comment \`${id}\` on this review — the ids are ${known}` };
    }
    if (seen.has(id)) return { answers: [], error: `\`${id}\` is answered twice, and which one you meant is not something this can guess` };
    seen.add(id);
    if (comment.resolved) {
      return {
        answers: [],
        error: `\`${id}\` is already resolved — the reviewer has settled it, so there is nothing to answer`,
      };
    }
    if ('resolved' in a) {
      return {
        answers: [],
        error:
          `\`${id}\` carries \`resolved\`, and that is the reviewer's field and not yours. Answer it — changed, ` +
          'clarify or declined — and the reviewer decides next round whether your answer settles it.',
      };
    }
    const answer = clean(a.answer).toLowerCase();
    if (!REVIEW_ANSWERS.includes(answer)) {
      return {
        answers: [],
        error: `\`${id}\` answers \`${answer || '(nothing)'}\`, which is not one of ${REVIEW_ANSWERS.join(', ')}`,
      };
    }
    const note = clean(a.note);
    if (!note && answer !== 'changed') {
      return {
        answers: [],
        error:
          `\`${id}\` is \`${answer}\` with no \`note\` — a ${answer === 'declined' ? 'decline' : 'question'} the ` +
          'reviewer cannot read is a round spent on nothing',
      };
    }
    answers.push({ id, answer, note: note.slice(0, 400) });
  }

  return { answers, error: '' };
}

/**
 * The review state with the worker's answers folded in — and nothing else touched.
 *
 * Only `answer` and `note`, on the comments named. `round`, `verdict`, `reviewer` and every
 * `resolved` already in the block come through untouched, and that is the whole of what
 * makes a reply cost nothing: the round belongs to the reviewer's passes, the verdict
 * stands until a reviewer replaces it, and a settled comment stays settled.
 *
 * A pure function of its arguments, so the command that writes the field and the test that
 * asserts what it wrote are looking at the same thing.
 */
export function withAnswers(state, answers) {
  const by = new Map((Array.isArray(answers) ? answers : []).map((a) => [String(a.id), a]));
  const comments = (Array.isArray(state?.comments) ? state.comments : []).map((c) => {
    const a = by.get(String(c.id));
    if (!a || c.resolved) return c;
    return { ...c, answer: a.answer, note: a.note || c.note || '' };
  });
  return { ...state, comments };
}

/**
 * What the worker's reply reads as on the bead — the comment beside the block.
 *
 * The block is what the next round parses; this is what a person opening the bead sees, and
 * the two are written from the same answers so they cannot disagree. It names the head
 * commit when the caller could work one out, because the question anybody has about a reply
 * is *what did it actually push* — and it is the one fact the block itself does not carry.
 */
export function answerComment(answers, { round = 0, sha = '', pushed = null } = {}) {
  const list = Array.isArray(answers) ? answers : [];
  const counts = REVIEW_ANSWERS.map((k) => [k, list.filter((a) => a.answer === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  const where = sha ? ` The branch is at \`${String(sha).slice(0, 12)}\`.` : '';
  const moved = pushed === false ? ' Nothing new was pushed — this reply is words only.' : '';

  return [
    `**The worker answered${round ? ` round ${round}` : ''}** — ${counts || 'nothing'}.${where}${moved}`,
    '',
    ...list.map((a) => `- **${a.id}** — ${a.answer}${a.note ? `: ${a.note}` : ''}`),
    '',
    'Nothing here is resolved: the ReviewAdvocate reads these next round and settles the ones it accepts.',
  ].join('\n');
}

/**
 * The brief for one reopened worker — one pull request, one round of answers.
 *
 * A pure function of its arguments, for `reviewAdvocatePrompt`'s reason and
 * `workPromptFor`'s: what is under test is the whole of what an unattended window is told
 * before it changes somebody's branch, and a suite must be able to drive every branch of it
 * with no tracker, no checkout and no window open.
 *
 * The three things it must get across, because nothing else will say them:
 *
 * - **This is not a fresh start.** The branch exists, the pull request exists, and the
 *   session that wrote them is gone. A worker that does not know this opens a new branch,
 *   and then there are two.
 * - **Declining is allowed.** A worker that believes it has to agree with every comment
 *   makes changes it thinks are wrong, which is worse than an argument the reviewer can
 *   read. Said plainly, and said with what it costs — the comment survives into the next
 *   round either way.
 * - **Finishing is not yours to declare.** Only the reviewer resolves. Without this the
 *   ending an agent invents is "no unresolved comments", written by itself, about itself.
 */
export function reviewAnswerPrompt(workspace, issue, spec, state = {}, extra = {}) {
  const {
    owner = 'the owner',
    reason = '',
    maxRounds = 0,
    answer = 'beadcause-answer',
    notes = null,
    debriefs = [],
  } = extra;
  const round = Number.isInteger(state?.round) && state.round > 0 ? state.round : 1;
  const owed = commentsForWorker(state);
  const resolved = (state?.comments || []).filter((c) => c.resolved);
  const bead = spec?.bead || issue?.id;

  const lines = [
    `You are the worker for **${bead}** in \`${workspace}\`: pull request #${spec.number} in ` +
      `\`${spec.repo || workspace}\`, which **you delivered and something else reviewed**.`,
    '',
    reason ? `You were opened because ${reason}.` : 'You were opened because the ReviewAdvocate has comments on it and they are yours to answer.',
    '',
    `- Branch: \`${spec.branch}\` → \`${spec.base}\` — **it already exists, and it is the one you push to**`,
    `- Pull request: ${spec.url}`,
    `- Review round: ${round}${maxRounds ? ` of ${maxRounds}` : ''}`,
    `- The review lives on **${issue.id}**, in its \`notes\` — that is where your answers go`,
    '',
    '**The window that wrote this branch is gone, and you are not it.** Nothing is held over from that',
    'session: what it decided is in the pull request description and the commits, and what it was asked for',
    `is \`bd show ${bead}\`. Read the diff before you read the comments — \`gh pr diff ${spec.number}\` — because`,
    'half of what a review objects to is explained by the two lines above the hunk it is pointing at.',
  ];

  if (state?.refused) lines.push('', `**The reviewer's sentence about this round:** ${clean(state.refused)}`);

  lines.push('', `**What you owe an answer on — ${owed.length || 'nothing'}${owed.length ? '' : ' at all'}:**`, '');
  if (owed.length) {
    for (const c of owed) {
      const at = commentAt(c);
      lines.push(`- **${c.id}**${at ? ` \`${at}\`` : ''} — ${c.body}`);
    }
  } else {
    lines.push(
      '- Nothing is outstanding. If that is genuinely so, say nothing and stop — an answer to a comment',
      '  nobody raised is refused, and a push with no comment behind it is a branch the reviewer has to',
      '  read again for no reason.'
    );
  }
  if (resolved.length) {
    lines.push(
      '',
      `${resolved.length} other comment${resolved.length === 1 ? ' has' : 's have'} already been resolved by the ` +
        'reviewer and are not yours to reopen.'
    );
  }

  lines.push(
    '',
    '**Three answers, and you give exactly one to each comment.**',
    '',
    '- **`changed`** — you made the change. The diff is the argument; a line saying what you did helps the',
    '  reviewer find it.',
    '- **`clarify`** — you do not yet know what is being asked, or you think the comment rests on something',
    '  untrue about the code. Ask the question. This is the cheapest of the three and the one most often',
    '  skipped in favour of a guess at what the reviewer meant.',
    '- **`declined`** — you read it, you understood it, and you are not doing it. Say why in one sentence.',
    '  **Declining is a legitimate answer and not a fight.** A worker that makes every change it is asked',
    '  for, including the ones it thinks are wrong, is worse for this branch than an argument the reviewer',
    '  can read and settle. What it costs is nothing extra: a declined comment is simply one you did not',
    '  resolve, so it goes back in front of the reviewer next round exactly like the rest.',
    '',
    '**You do not resolve anything, and there is no answer that means "done".** Only the ReviewAdvocate',
    'marks a comment settled — it reads your answers on its next pass and resolves the ones it accepts,',
    'leaving the rest open. So do not write `resolved` (it is refused), do not report that the review is',
    'finished, and do not treat having answered everything as approval. Whether this branch is done being',
    'reviewed is a finding somebody else makes about your work, which is the entire point of there being a',
    'reviewer at all.',
    '',
    '**Record your answers with one command, when the code is already pushed:**',
    '',
    `    ${answer} -w ${workspace} -b ${issue.id} <<'EOF'`,
    ...(owed.length ? owed : [{ id: 'c1' }]).slice(0, 3).map(
      (c) => `    - id: ${c.id}\n      answer: changed|clarify|declined\n      note: <one line — what you did, what you are asking, or why not>`
    ),
    '    EOF',
    '',
    'It writes them into the review block on the bead and comments what you said, which is the whole of what',
    'survives this window. An id it does not recognise, an answer outside those three, or a `resolved` is',
    'refused with a sentence — read it and run the command again rather than editing `notes` by hand.'
  );

  lines.push(
    '',
    '**Push to this branch, and only ever this branch.**',
    '',
    `- \`git push\` onto \`${spec.branch}\`. Do not open a new branch, do not open a second pull request, and`,
    `  do not re-run the delivery command — #${spec.number} is already open and already queued, and a second`,
    '  one is two things Adam has to answer for one piece of work.',
    `- **Never merge or push \`${spec.base}\`.** Not \`git merge\`, not \`gh pr merge\`, not "just this once".`,
    '  The merge queue is the one door into it and this branch is in the queue already.',
    `- Do not close ${bead} — the merge closes it, and the merge is not yours.`,
    '- Run this repo\'s own gate before you push. The reviewer reads a red branch as a worse version of the',
    '  one it already objected to, and a check your answer broke costs the round it was supposed to save.',
    '- **Your commits are what makes this a new state to review.** Push your own work onto the branch; do not',
    '  ask anything else to land it for you. A branch that has moved because somebody merged the base into it',
    '  has not answered anybody.'
  );

  if (maxRounds) {
    lines.push(
      '',
      `**There are ${maxRounds} rounds, and then this stops being a conversation and becomes a card for ${owner}.**` +
        (round >= maxRounds ? ' This is the last one.' : '') +
        ' That is a good ending rather than a failure — a reviewer and a worker who genuinely disagree should' +
        ` arrive in front of ${owner} as one decision, not as an argument that runs all night. What it costs is a` +
        ' tap, so spend the round on the comments that would actually change the branch.'
    );
  }

  const learned = notesBrief(notes || {}, issue, { who: 'worker' });
  if (learned) lines.push(learned);
  const past = debriefBrief(debriefs || [], issue);
  if (past) lines.push(past);

  lines.push(
    '',
    '**Before you stop, leave a report** — `beadcause-memory debrief "<what the reviewer wanted and what you',
    'did about it>"`. The next window on this branch is the next round of this same review, and it starts',
    'with what you write there.',
    '',
    'Then stop. This window closes when you go quiet; the bead is what the next thing reads.'
  );

  return lines.join('\n');
}
