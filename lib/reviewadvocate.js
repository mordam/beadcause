/**
 * The ReviewAdvocate — the agent that reads a pull request somebody else wrote and argues
 * with it, and whose verdict is what stands between a delivery and the merge queue.
 *
 * A worker delivers and stops (bc-r941). Today the branch goes straight onto the merge
 * queue, which judges its *checks* — conflicts, red suites, an approval policy — and
 * nothing at all judges the diff. bc-36xx puts a review in that gap: the ReviewAdvocate
 * reads the change, raises its comments, and the worker answers them until either there is
 * nothing unresolved left (it approves) or the two of them are stuck (it becomes a card
 * for Adam).
 *
 * ## Why a seventh kind and not a mode of the merge queue
 *
 * The same argument lib/mergeadvocate.js makes for being a sixth, and it is stronger here
 * rather than weaker. The difference between these two agents is their **permissions**, and
 * a mode would have to carry both sets and pick at runtime — the shape where a bug grants
 * the wider one. The merge queue may push, may merge to `main`, and is the only thing that
 * closes a work bead. This one may do none of that: it reads a diff, it says what it
 * thinks, and everything it can reach is read-only apart from the comment it writes its
 * verdict into. A reviewer that could merge the branch it had just approved would be the
 * same self-certification bc-r941 took away from the worker, arrived at from the other end.
 *
 * A kind also gets what a mode cannot: a foundation somebody can amend, a row on the agents
 * screen, and a mark of its own — so "which agent said this" is answerable off a pill.
 *
 * ## What a verdict is, and where it goes
 *
 * The output of a review is a **verdict**: the comments it raised, whether it approved, and
 * if not, why. That is a document, not a sentence, and this file owns its shape — which is
 * what `protocolOwner` in lib/foundation.js means and why it points here.
 *
 * It is written the way lib/plan.js writes a plan: a fenced JSON block between two markers,
 * in a **comment** on the merge-bead, with a human-readable sentence above it. Comments are
 * append-only, so a verdict cannot lose a race with the daemon rewriting `notes` in the same
 * minute; the round before this one is still on the bead, which is the only record of what
 * the reviewer objected to before the worker answered; and every surface that draws a bead
 * already draws comments, so a review is visible on the phone with no new UI at all.
 *
 * **The markers are `beadcause:verdict` and not `beadcause:review` on purpose.** bc-36xx.2
 * takes `<!-- beadcause:review -->` for the review *state* block in the merge-bead's
 * `notes` — the accumulated round count and the comments still open across rounds, beside
 * `<!-- beadcause:merge -->` and outliving it. These are two different documents with two
 * different lifetimes: a verdict is one review's output and never changes again, and the
 * state block is rewritten every round. One name over both would make a parser that took
 * whichever it found first, in whichever field it was handed.
 *
 * ## What this file is deliberately not
 *
 * - **Not the store.** Where review state lives across rounds is lib/mergebead.js's
 *   neighbourhood and bc-36xx.2's bead. This file parses and formats one verdict.
 * - **Not the gate.** Whether a verdict lets a branch onto the merge queue is
 *   `gateVerdict`'s neighbourhood in lib/mergeadvocate.js (bc-36xx.4).
 * - **Not the round cap.** Two rounds and then a card is Adam's answer on bc-nq0m, and the
 *   constant belongs beside `MAX_ATTEMPTS` in lib/mergebead.js (bc-36xx.7). What this file
 *   does is *say* the cap in the brief, because an agent that does not know a round is
 *   scarce spends it.
 * - **Not the account that approves, and not the `gh` call.** Which identity may approve is
 *   `reviewerFor` in lib/pr.js and the call that submits the review is `approve` beside it. What
 *   this file owns is what an approval *says*: `approvalNote` and `approvalComment` are the two
 *   texts that end up on the pull request, and `approvedReview` is what the merge-bead records
 *   afterwards. The reviewing agent still has no `gh pr review` grant and this is no longer a
 *   "not yet" — an agent shelling that command in its own window would approve as whichever
 *   login `gh` happens to be on, which on this Mac is sometimes the author of the branch. The
 *   daemon submits it, as an identity the agent cannot choose, once the verdict says to.
 */
import { debriefBrief, notesBrief } from './memory.js';

/** The kind, as lib/foundation.js keys it. One spelling, because agent ids are on disk. */
export const REVIEW_ADVOCATE = 'review-advocate';

/**
 * Where a verdict starts and ends inside a comment body.
 *
 * See the header for why this is not `beadcause:review`: that name belongs to the review
 * state block on the merge-bead's `notes`, and two documents sharing a marker is a parser
 * that reads whichever it was handed.
 */
export const VERDICT_OPEN = '<!-- beadcause:verdict -->';
export const VERDICT_CLOSE = '<!-- /beadcause:verdict -->';

/**
 * What a comment's severity may be, as a closed set.
 *
 * A closed vocabulary rather than free text, for the reason lib/requirements.js keeps one:
 * the *only* consumer that matters is a machine deciding whether this branch may proceed,
 * and "fairly important" is a severity a person can write and nothing can act on.
 *
 * The three are not a scale, they are three different asks:
 *
 * - `blocking` — the reviewer will not approve while it stands. It is a promise, and the
 *   brief spends a paragraph on what may and may not be one, because a reviewer that
 *   blocks on taste costs a worker a round and buys nothing.
 * - `suggestion` — worth doing, and never worth holding a merge for. The worker may take
 *   it or leave it and the branch still merges.
 * - `question` — the reviewer does not understand something and wants an answer, not a
 *   change. It is the cheapest comment there is and it is the one most often skipped in
 *   favour of a wrong `blocking`.
 */
export const SEVERITIES = ['blocking', 'suggestion', 'question'];

/** Does this severity hold up a merge? The one place that decides it. */
export const isBlocking = (c) => String(c?.severity || '').toLowerCase() === 'blocking';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Read a verdict out of a comment body, or null.
 *
 * Tolerant about what surrounds the block — a verdict comment carries a sentence above it
 * naming who reviewed, and may carry prose below it — and tolerant about the fence, which
 * is for the reader rather than for us. Unparseable JSON between the markers is `null`
 * rather than a throw, for `parsePlan`'s reason: a comment somebody hand-edited on a phone
 * must not be able to stop a tick.
 *
 * `null` here means *this comment is not a verdict*. It does not mean the verdict was bad —
 * that is `checkVerdict`, which is the half with sentences in it.
 */
export function parseVerdict(text) {
  const body = String(text ?? '');
  const from = body.indexOf(VERDICT_OPEN);
  if (from === -1) return null;
  const to = body.indexOf(VERDICT_CLOSE, from);
  const inner = to === -1 ? body.slice(from + VERDICT_OPEN.length) : body.slice(from + VERDICT_OPEN.length, to);
  const json = inner.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '').trim();
  if (!json) return null;
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.approved !== 'boolean') return null;
  return raw;
}

/**
 * The verdict a thread carries: the **last** comment that parses as one.
 *
 * Last rather than first, exactly as `planFrom` takes the last plan: a review is re-run
 * across rounds and the newest one is the verdict. The earlier ones stay on the bead, which
 * is the whole reason for writing them as comments.
 *
 * The three spellings of a comment body are the tolerant read lib/landed.js already uses.
 */
export function verdictFrom(comments) {
  let found = null;
  for (const c of comments || []) {
    const v = parseVerdict(c?.text ?? c?.body ?? c?.comment ?? '');
    if (v) found = v;
  }
  return found;
}

/**
 * Check a verdict an agent wrote, and hand back the normalised form that gets stored.
 *
 * `{ verdict, error }` rather than a throw, because both callers are loops over other
 * people's pull requests: a malformed verdict on one merge-bead must cost that one bead a
 * sentence, not the tick.
 *
 * Four rules, and each is a verdict the loop would be *wrong* about rather than one it
 * cannot render:
 *
 * 1. **Approved and blocking at once is refused.** It is the one contradiction the whole
 *    loop hinges on: the gate reads `approved` and the worker reads the comments, so a
 *    verdict saying both merges a branch while telling its author it must not. Which half
 *    to believe is not a default anything should pick.
 * 2. **A refusal has to say why.** "Not approved" with no sentence is a round burned on a
 *    worker guessing, and the bead's own acceptance criteria name this: the comments it
 *    raised, whether it approved, *and if not, why*.
 * 3. **Comment ids are unique, and missing ones are filled in.** The worker answers
 *    comments by id and the next round matches its answers back — so two comments sharing
 *    an id is one answer silently resolving both, which is the failure that looks like
 *    agreement. Missing ids are numbered rather than refused, because an id is bookkeeping
 *    the reviewer should not lose a whole round to forgetting.
 * 4. **A severity outside `SEVERITIES` is refused rather than coerced.** Defaulting an
 *    unknown one to `blocking` would let a typo hold a branch for ever; defaulting it to
 *    `suggestion` would let one wave a real objection through. Neither direction is safe,
 *    so it is a sentence back to the agent that wrote it.
 */
export function checkVerdict(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { verdict: null, error: 'it is not a verdict object' };
  if (typeof raw.approved !== 'boolean') return { verdict: null, error: '`approved` must be true or false' };

  const list = Array.isArray(raw.comments) ? raw.comments : [];
  const comments = [];
  const seen = new Set();
  for (const [i, c] of list.entries()) {
    if (!c || typeof c !== 'object') return { verdict: null, error: `comment ${i + 1} is not an object` };
    const severity = clean(c.severity).toLowerCase() || 'blocking';
    if (!SEVERITIES.includes(severity)) {
      return { verdict: null, error: `comment ${i + 1} has severity \`${severity}\`, which is not one of ${SEVERITIES.join(', ')}` };
    }
    const what = clean(c.what);
    if (!what) return { verdict: null, error: `comment ${i + 1} says nothing — \`what\` is the comment` };
    const id = clean(c.id) || `c${i + 1}`;
    if (seen.has(id)) return { verdict: null, error: `two comments share the id \`${id}\`, so one answer would resolve both` };
    seen.add(id);
    comments.push({
      id,
      file: clean(c.file),
      line: Number.isInteger(c.line) && c.line > 0 ? c.line : null,
      severity,
      what,
      why: clean(c.why),
    });
  }

  const why = clean(raw.why);
  if (raw.approved && comments.some(isBlocking)) {
    return { verdict: null, error: 'it approves and carries a blocking comment — one of those has to give' };
  }
  if (!raw.approved && !why) {
    return { verdict: null, error: 'it does not approve and does not say why' };
  }

  return {
    verdict: {
      pr: Number.isInteger(raw.pr) && raw.pr > 0 ? raw.pr : null,
      bead: clean(raw.bead) || null,
      round: Number.isInteger(raw.round) && raw.round > 0 ? raw.round : null,
      approved: raw.approved,
      why,
      comments,
    },
    error: '',
  };
}

/**
 * The human half of a verdict — the headline that names the agent, and the comments as
 * bullets. Everything a reader gets before the machine block starts.
 *
 * Split out because a verdict is now read in two places that must not disagree about who
 * approved: this file's comment on the merge-bead, and the body of the approving review
 * on GitHub (`approvalNote`). One builder, so the sentence Adam asked for cannot be true
 * of one of them and missing from the other.
 */
function verdictProse(verdict, { owner = 'a person' } = {}) {
  const v = verdict || {};
  const comments = Array.isArray(v.comments) ? v.comments : [];
  const blocking = comments.filter(isBlocking).length;
  const where = v.pr ? ` on #${v.pr}` : '';
  const headline = v.approved
    ? `**Approved${where} by the ReviewAdvocate — an agent, not ${owner}.**`
    : `**Not approved${where}. Reviewed by the ReviewAdvocate — an agent, not ${owner}.**`;
  const count = comments.length
    ? `${comments.length} comment${comments.length === 1 ? '' : 's'}, ${blocking} blocking.`
    : 'No comments.';

  return [
    `${headline} ${count}${v.why ? ` ${v.why}` : ''}`,
    '',
    ...comments.map((c) => {
      const at = c.file ? ` \`${c.file}${c.line ? `:${c.line}` : ''}\`` : '';
      return `- **${c.id}** (${c.severity})${at} — ${c.what}${c.why ? ` ${c.why}` : ''}`;
    }),
    comments.length ? '' : null,
  ].filter((l) => l !== null);
}

/**
 * The comment body a verdict is written as.
 *
 * The sentence above the block **names the agent**, and that is Adam's answer on bc-0cop
 * rather than decoration: *"the last comment on the PR should describe who is actually
 * approving (ie an agent, not me)"*. Every surface that carries a verdict onward — the
 * merge-bead, the pull request, the notification — starts from this text, so saying it once
 * here is what stops a review appearing under Adam's name on a repo whose diff he never
 * read. A verdict shown without that line is a person's approval as far as anyone can tell.
 */
export function formatVerdict(verdict, { owner = 'a person' } = {}) {
  const v = verdict || {};
  const comments = Array.isArray(v.comments) ? v.comments : [];

  return [
    ...verdictProse(v, { owner }),
    VERDICT_OPEN,
    '```json',
    // The block is the record, so it carries what `checkVerdict` normalised and nothing
    // else — the prose above it is derived and must never be what a later round parses.
    JSON.stringify({ pr: v.pr ?? null, bead: v.bead ?? null, round: v.round ?? null, approved: !!v.approved, why: v.why || '', comments }, null, 2),
    '```',
    VERDICT_CLOSE,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * The body of the approving review on GitHub.
 *
 * `formatVerdict`'s prose without the machine block, and the omission is the decision
 * here. The verdict block has exactly one home — a comment on the merge-bead — and a
 * second copy on the pull request would be a second thing a later round could parse,
 * which is how two records of one review start to disagree. What GitHub gets is the half
 * a person reads.
 *
 * The last line names the login, because the reviewer's *name* is the whole problem this
 * text exists to solve: GitHub's timeline says "NeanderthalMan approved these changes"
 * and there is nothing on the page to say that this is an agent's identity rather than
 * somebody who read the diff over coffee.
 */
export function approvalNote(verdict, { owner = 'a person', reviewer = '', bead = '', round = 0 } = {}) {
  const v = verdict || {};
  const who = clean(reviewer);
  const at = clean(bead) || clean(v.bead);
  const n = Number.isInteger(round) && round > 0 ? round : Number.isInteger(v.round) && v.round > 0 ? v.round : 0;

  const provenance = [
    who ? `Submitted as \`${who}\`, which is the identity the reviewer speaks as here and not a person.` : '',
    at ? `The verdict this came from is on \`${at}\`` + (n ? `, round ${n}.` : '.') : '',
    `${owner} has not read this diff.`,
  ]
    .filter(Boolean)
    .join(' ');

  return [...verdictProse(v, { owner }), provenance].join('\n');
}

/**
 * The comment that goes *under* the review, and it is the one thing on this pull request
 * Adam asked for by name: *"the last comment on the PR should describe who is actually
 * approving (ie an agent, not me)"*.
 *
 * Deliberately not the same text as `approvalNote`, because the two sit in different
 * places and answer different questions. The note is beside the green tick and says what
 * the reviewer thought. This is at the bottom of the thread, where somebody scrolling
 * lands, and it says what the *login* is — that the approval on this page was not a person
 * agreeing to the change, and what would have to happen for one to.
 *
 * It is only ever posted when a review really was submitted. With no review there is no
 * tick to be mistaken for a person's, and a comment disclaiming an approval that is not
 * there is noise on somebody's pull request.
 */
export function approvalComment({ owner = 'a person', reviewer = '', bead = '', agent = REVIEW_ADVOCATE, human = false } = {}) {
  const who = clean(reviewer);
  const at = clean(bead);

  return [
    `**That approval is an agent's, not ${owner}'s.**`,
    '',
    who
      ? `\`${who}\` is the account beadcause's **${agent}** reviews as — chosen because GitHub will not accept ` +
        `an approving review from the account that opened the pull request, which is the other login on the ` +
        `same machine. Nobody at a keyboard approved this.`
      : `beadcause's **${agent}** approved this. Nobody at a keyboard did.`,
    '',
    at ? `What it objected to, what it was answered with, and what it settled for is on \`${at}\`.` : '',
    human
      ? `${owner} still admits this one: the space it is in requires a human approval as well, so the agent's ` +
        `is necessary rather than sufficient.`
      : `That is the gate as configured here: an agent's approval is what releases a pull request to the merge ` +
        `queue, and a space that wants a human one as well switches that on per space.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * The review block, as it stands once a pull request has been approved — the state
 * lib/mergebead.js's `withReviewBlock` writes into the merge-bead's `notes`.
 *
 * The point of writing it at all is that the merge queue's gate then reads **one field on
 * a bead it has already loaded** instead of asking GitHub, per merge-bead, per tick,
 * whether somebody approved. `approvalUrl` is what makes that cheap answer checkable: it
 * is an anchor to the review itself, so a reader who doubts the field can go and look, and
 * can still do so when this bead is long closed.
 *
 * Two things it does *not* do, both deliberate:
 *
 * - **It does not resolve the comments.** Approving means nothing blocking is left, not
 *   that every suggestion was taken — a declined suggestion under an approval is ordinary,
 *   and marking it resolved here would erase the disagreement the next reviewer wants to
 *   see. Who marks a thread resolved is the reviewer's, one comment at a time.
 * - **It does not invent a round.** The count belongs to whatever is running the loop; this
 *   takes what it is given, falls back to what the block already said, and only reaches for
 *   1 when both are silent — because an approval that happened in no round at all would
 *   read as a pull request nobody reviewed.
 *
 * `submitted: false` is the one-login Mac, and it is a *recorded* approval rather than a
 * refused one: the verdict approved, and the only thing missing is GitHub's copy of it. So
 * `approvedBy` falls back to the agent kind rather than to a login that does not exist, and
 * the empty `approvalUrl` is the tell — an approval with no anchor was never on GitHub.
 */
export function approvedReview(
  state = {},
  { reviewer = '', at = '', url = '', submitted = false, round = 0, agent = REVIEW_ADVOCATE } = {}
) {
  const prior = Number(state?.round);
  const given = Number(round);
  const when = clean(at) || '';
  const who = clean(reviewer);

  return {
    round: Number.isInteger(given) && given > 0 ? given : Number.isInteger(prior) && prior > 0 ? prior : 1,
    verdict: 'approved',
    reviewer: submitted ? who : '',
    at: when,
    comments: Array.isArray(state?.comments) ? state.comments : [],
    approvedBy: submitted && who ? who : agent,
    approvedAt: when,
    approvalUrl: submitted ? clean(url) : '',
  };
}

/**
 * The brief, for one invocation — one pull request, one round of review.
 *
 * The *role* — what a ReviewAdvocate is, on every run — lives in lib/foundation.js and is
 * amendable. This is what it was asked *this time*, and the split is the one every other
 * agent here keeps: a foundation an agent can argue with, and a brief it cannot.
 *
 * A pure function of its arguments, like `mergeAdvocatePrompt` and `epicAdvocatePrompt`,
 * and for the same reason: what is under test is the text an unattended window is handed
 * before it argues with somebody's code, and a test must be able to drive every branch of
 * it with no tracker, no checkout and no window open.
 *
 * The one thing this brief must get across is what nothing else will say: **what a good
 * review comment is here**. An agent asked to review a diff will find something to say
 * about every hunk of it — that is what it is good at — and a review that raises eleven
 * comments costs the worker eleven answers and the epic a round it cannot get back. The
 * severity vocabulary is the mechanism; the paragraphs below are what makes it mean
 * something.
 */
export function reviewAdvocatePrompt(workspace, issue, spec, state = {}, extra = {}) {
  const {
    owner = 'the owner',
    reason = '',
    maxRounds = 0,
    notes = null,
    debriefs = [],
  } = extra;
  const round = Number.isInteger(state?.round) && state.round > 0 ? state.round : 1;
  const answered = Array.isArray(state?.comments) ? state.comments : [];
  const last = round > 1 && answered.length;

  const lines = [
    `You are the ReviewAdvocate for **${issue.id}** in \`${workspace}\`: pull request #${spec.number} in ` +
      `\`${spec.repo || workspace}\`, which carries the work for **${spec.bead}**.`,
    '',
    reason
      ? `You were opened because ${reason}.`
      : 'You were opened because this pull request has been delivered and nothing has reviewed it yet.',
    '',
    `- Branch: \`${spec.branch}\` → \`${spec.base}\``,
    `- Pull request: ${spec.url}`,
    `- Round: ${round}${maxRounds ? ` of ${maxRounds}` : ''}` +
      (maxRounds && round >= maxRounds ? ' — the last one before this becomes a card' : ''),
  ];
  if (spec.tests) lines.push('', `**What the worker said it ran:** ${spec.tests}`);
  if (spec.risk) lines.push('', `**What the worker flagged as risky:** ${spec.risk}`);
  if (spec.left) lines.push('', `**What the worker deliberately did not do:** ${spec.left}`);

  lines.push(
    '',
    '**Read before you object.** `gh pr diff` is the change; `gh pr view` is the worker’s own account of',
    `why it is that shape; \`bd show ${spec.bead}\` is what it was asked for. The single commonest wrong`,
    'review comment is one the description already answers, and it costs a whole round.'
  );

  if (last) {
    lines.push(
      '',
      '**This is not a fresh review. The worker has answered you, and your job this round is the answers.**',
      'Take each one on its merits:',
      '',
      ...answered.map((c) => {
        const at = c.file ? ` \`${c.file}${c.line ? `:${c.line}` : ''}\`` : '';
        const answer = clean(c.answer) || 'no answer recorded';
        return `- **${c.id}** (${c.severity})${at} — you said: ${clean(c.what)}\n  - The worker: ${answer}`;
      }),
      '',
      '- **Persuaded?** Drop the comment. Being argued out of one is the loop working, not you losing.',
      '- **Not persuaded?** Keep it, and say in one sentence what the answer does not settle. Repeating the',
      '  original comment unchanged is not scrutiny and the worker cannot act on it.',
      '- **Do not raise new blocking comments about code that was in the diff the first time.** If it did not',
      '  block then it does not block now; that is the loop that never ends. Something the worker’s *new*',
      '  commits introduced is fair, and is the only thing that is.'
    );
  } else {
    lines.push(
      '',
      '**What a good review comment is here.** You did not write this code and you are not its author’s',
      'editor. Every comment costs the worker an answer and this pull request a round, so the bar is not',
      '“could this be better” — it is “would I hold this branch for it”.',
      '',
      '- **It names a file and a line, says what is wrong, and says why it matters *here*.** A comment that',
      '  could have been written without reading this diff is one nobody can act on.',
      '- **It is about this diff.** Something wrong in the code the change landed next to is a bead, not a',
      '  review comment — say so in one line and move on. A review that widens into the file around it is',
      '  how a two-line fix acquires a week.',
      '- **`blocking` is a promise, not an emphasis.** It means you will not approve while it stands. Keep it',
      '  for correctness, data loss, a security hole, a broken contract with a caller, or a test that does',
      '  not test what it claims. Style, naming, structure and taste are `suggestion` — this repo has no',
      '  formatter and no style gate, and a reviewer that blocks on taste burns a worker’s round for nothing.',
      '- **If you cannot say what the fix would look like, it is a `question`.** Not understanding something',
      '  is a real and cheap thing to say. Dressing it as a `blocking` comment is how a reviewer holds a',
      '  branch hostage to its own confusion.',
      '- **Few and real beats many and plausible.** Three comments the worker acts on is a good review.',
      '  Eleven, most of which get declined, is a round spent teaching it to ignore you.'
    );
  }

  lines.push(
    '',
    '**Then write your verdict, and it is the whole of what survives you.** This window closes when you',
    `stop; the next thing that acts on this pull request reads ${issue.id}, not this conversation. Leave a`,
    'comment on it ending in exactly this block, with the fenced JSON between the markers:',
    '',
    '```',
    VERDICT_OPEN,
    '```json',
    JSON.stringify(
      {
        pr: spec.number,
        bead: spec.bead,
        round,
        approved: false,
        why: 'one sentence, when you are not approving — what has to change before you would',
        comments: [
          {
            id: 'c1',
            file: 'lib/example.js',
            line: 42,
            severity: 'blocking',
            what: 'what is wrong',
            why: 'why it matters here',
          },
        ],
      },
      null,
      2
    ),
    '```',
    VERDICT_CLOSE,
    '```',
    '',
    `\`severity\` is one of ${SEVERITIES.join(', ')} and nothing else — an unrecognised one is refused rather`,
    'than guessed at, and costs you the round. Every comment needs an `id`, because that is what the worker',
    'answers and what the next round matches its answer back to.',
    '',
    '**Approving is `approved: true` with no blocking comment left.** Suggestions and questions may stand',
    'under an approval — they are things the worker may take or leave, and they do not hold a merge. A',
    'verdict that approves while carrying a blocking comment is refused, because the gate would merge the',
    'branch while your own comment said it must not.'
  );

  if (maxRounds) {
    lines.push(
      '',
      `**There are ${maxRounds} rounds, and then this becomes a card for ${owner}.**` +
        (round >= maxRounds ? ' This is the last one.' : '') +
        ' That is a good ending and not a failure: a reviewer and a worker that genuinely disagree should' +
        ' arrive as one decision somebody can make in thirty seconds, not as an argument that runs all night.' +
        ' What it costs is a tap, so spend your rounds on what would actually change the branch.'
    );
  }

  const learned = notesBrief(notes || {}, issue, { who: 'ReviewAdvocate' });
  if (learned) lines.push(learned);
  const past = debriefBrief(debriefs || [], issue);
  if (past) lines.push(past);

  lines.push(
    '',
    '**What you may not do, and each of these belongs to somebody else.**',
    '',
    `- **You may not merge, push, or close anything.** The merge queue is the one door into \`${spec.base}\``,
    '  and it closes both beads when the merge lands. Your verdict is an input to it, never a substitute.',
    '- **You may not edit the branch.** Fixing what you objected to yourself would make you the author of',
    '  the code you are reviewing, which is the self-certification this whole queue exists to remove. Say',
    '  what is wrong; the worker changes it.',
    '- **You may not submit the review on GitHub yourself.** Which identity may approve a worker’s pull',
    '  request is settled elsewhere — the account that reviews here is deliberately not the account that',
    '  opens them — and the approving review is submitted for you once your verdict says so. You have no',
    '  `gh pr review` grant, and that is the reason.',
    '',
    `**What you learn about how reviews go in this repo belongs in \`beadcause-memory note\`** — which check`,
    'is always the flake, which file is always the one that breaks, what a real objection here usually turns',
    'out to be. Your verdict is about this branch; that is about the next twenty.'
  );

  return lines.join('\n');
}
