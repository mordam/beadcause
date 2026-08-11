/**
 * Talking about an unendorsed bead — the thing you do instead of deciding.
 *
 * lib/verdict.js is the four ways a held bead stops being held: endorse it, revoke it,
 * rewrite it, or say what is wrong with it. Every one of them is an answer. This file is
 * the case those four have no room for — **you do not know yet.** A bead filed at 02:00
 * says an hour of unattended agent should go on something, and half the time the honest
 * response is a question: is this not already bc-9frx, which file would it even touch,
 * what breaks if we leave it. Without somewhere to ask that, the queue offers a choice
 * between approving work you have not understood and turning down work that might have
 * been right, and both of those are guesses.
 *
 * **Almost none of this is new, which is the point.** Commenting on a bead already
 * dispatches an agent to answer (lib/dispatch.js), and the roster in lib/agents.js is
 * already the four shapes a question about a proposal takes — answer it, go and find the
 * evidence, argue the other side, tell me what is left to decide. What was missing was
 * not a conversation; it was a conversation that **does not resolve the bead**.
 *
 * So the whole of this module is that guarantee, in three parts:
 *
 * 1. **The bead must still be held, and it still is afterwards.** `say` refuses a bead
 *    that has already been endorsed — the same refusal revoke and ask-for-changes give,
 *    for the same reason: between the queue being drawn and a thumb landing on it, the
 *    bead may have been decided on the laptop, and a thread opened on a decision that has
 *    already been made reads as if it had not been. Nothing here writes a label.
 * 2. **The agent cannot resolve it either, by construction and not by instruction.** The
 *    reply agent's allowlist (`DEFAULT_TOOL_LIST` in lib/agents.js) names the read-only
 *    `bd` verbs one at a time; `label`, `update`, `close`, `create` and `delete` are not
 *    among them, so an agent in this thread physically cannot take the marker off, close
 *    the bead, or file a replacement for it. The prompt says so too (`held` in
 *    lib/dispatch.js), but the prompt is the courtesy and the allowlist is the guard.
 * 3. **The thread is visible from the row it belongs to.** A bead being talked about must
 *    not read as one nobody has looked at — that is the state the queue exists to empty.
 *    `threadOf` is what the row unfolds into, and `bd list`'s own `comment_count` is what
 *    the folded row counts (see `toRow` in lib/endorsequeue.js).
 *
 * **Why nothing here labels the bead `human-replied`, unlike `/api/comment`.** That flag
 * is the *inbox's* mailbox: it marks a `bd human` question you have answered so
 * `checkReplies` knows to watch the thread and push the agent's answer to your phone. An
 * unendorsed bead is not a question and is not in `allQuestions()`, so the flag would
 * mark a bead nothing is watching — the push would not arrive either way. The reply
 * arrives because the queue page asks for the thread again while an agent is running,
 * and the row says so while it waits. A flag that does nothing but look like it does
 * something is worse than no flag.
 */
import { isHeld, refusal, UNENDORSED } from './endorse.js';
import { loadBead } from './verdict.js';

/**
 * How long a message may be. The same bound as an ask-for-changes note, because it is
 * the same thing arriving at the same `bd comment` — a paragraph, not an essay, typed
 * with a thumb.
 */
export const DISCUSS_MAX = 8000;

const clean = (v) => String(v ?? '').trim();

/**
 * Say something on a held bead, and leave it exactly as held as it was.
 *
 * Written as you (`actor`), like ask-for-changes and unlike every label move in
 * lib/endorse.js: this one *is* a sentence somebody said, and the next session reading
 * the thread should see whose. The bead is loaded first rather than commented on
 * blind — an id that has been endorsed since the page was drawn must be refused before
 * anything is written, not discovered afterwards by a comment sitting on decided work.
 */
export async function say(bd, ws, id, { text, actor = null } = {}) {
  const body = clean(text).slice(0, DISCUSS_MAX);
  if (!body) throw Object.assign(new Error('nothing to say — the comment is the discussion'), { status: 400 });

  const issue = await loadBead(bd, ws, id);
  if (!isHeld(issue)) {
    throw refusal(
      id,
      `it is not ${UNENDORSED} — it has already been endorsed, so there is nothing left to talk about before deciding`
    );
  }

  await bd.comment(ws, id, body, { actor });
  // The row goes back to the caller because the caller needs it: the dispatcher reads a
  // bead's own text to spot a thread that is itself an amendment request, and a second
  // `bd show` for a bead this function has just held in its hand is a call on a phone's
  // round trip that buys nothing.
  return { id, title: clean(issue.title), text: body, issue };
}

/**
 * One `bd comments` row → one bubble.
 *
 * The one thing the client cannot work out for itself is **who is on the other end**. A
 * comment's author is a bare string: `beadcause` for the daemon, an address for you if
 * you are signed in, and the *agent's id* for a reply, because that is what the dispatch
 * prompt tells it to pass (`--actor ${agent.id}`). So an author that names somebody on
 * the roster is resolved here into the name and emoji the chip was drawn with, and
 * anything else is a person. Doing it on the phone would mean a second fetch and a
 * thread that painted every agent as a stranger until it landed.
 *
 * **The roster arrives as an argument rather than being read from `cfg` here.** The
 * original reason was a load-order trap and is now gone: lib/agents.js and
 * lib/foundation.js used to be a cycle whose evaluation order decided whether it loaded,
 * an `import` of agents.js from this file is early enough in lib/server.js's import list
 * to reach agents first, and the daemon died at boot on `Cannot access
 * 'DEFAULT_TOOL_LIST' before initialization`. bc-u4na moved the list into
 * lib/toolbelt.js, so importing agents.js from anywhere is safe again — and taking the
 * roster as an argument is still the right shape, because the caller already has it in
 * hand (`rosterNow()`) and this file then needs to know nothing about config at all.
 *
 * Deliberately not `agentFor`, which falls back to the default agent: a reply from an
 * agent you have since deleted keeps its own author and no chip, rather than being
 * relabelled as the Answerer. The conversation happened, whatever the config says now.
 * Same rule, and the same reason, as `withAgentNames` in lib/agents.js.
 */
export function toBubble(agents, comment) {
  const author = clean(comment?.author);
  const agent = (agents || []).find((a) => a?.id === author) || null;
  return {
    id: comment?.id || null,
    author,
    text: String(comment?.text ?? ''),
    at: comment?.created_at || comment?.at || null,
    agent: agent ? { id: agent.id, name: agent.name, emoji: agent.emoji || '🤖' } : null,
  };
}

/** The whole thread on one bead, oldest first — the order `bd comments` already gives. */
export async function threadOf(bd, agents, ws, id) {
  const comments = await bd.comments(ws, id);
  return (comments || []).map((c) => toBubble(agents, c));
}
