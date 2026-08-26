/**
 * Was this bead's question answered, and which bead in the family actually carries
 * the answer?
 *
 * bc-dgx7.84: four sessions rebuilt this by hand, four different ways, out of `bd show`,
 * `bd comments` and a python-parsed notes dump — because the fact already lives in two
 * places nothing read together. `lib/decision.js` (`toQuestion`) parses the `decision`
 * block a bead's description/design/notes carries, if any. `lib/answered.js` is
 * beadcause's own record of what you chose, kept in `state.json` precisely so a
 * re-arriving card can say "you said this already" — and it is the *only* place a
 * deferral shows up at all, because deferring answers a card without writing anything
 * to the bead (see `lib/decision.js`'s `defersFlag`: "nothing about the bead moves").
 * This file reads both, plus the bead's own status and its `human-replied` label, and
 * turns them into one verdict per bead in a chain.
 *
 * **What each ending actually looks like on the bead**, from `lib/bd.js`:
 *
 *   - **closed** — `respond()`: a comment, then `bd close` with reason
 *     `'Answered via Beadcause'`. The bead is done; nothing left to ask.
 *   - **commissioned** — `commission()`: a comment, the `human` label removed, the
 *     bead reopened and unclaimed. Still open, but out of the inbox and back in
 *     `bd ready` — an instruction to go build it, not a verdict.
 *   - **deferred** — no `bd` write at all. `state.json`'s `answered` record is the
 *     only trace; the bead itself is untouched, still `human`-labelled, still open.
 *
 * So the state.json record is read first and decides `closed` vs `commissioned` vs
 * `deferred` from what actually happened to the bead around it — a closed bead is
 * `closed`, an open bead missing its `human` label is `commissioned`, and an open bead
 * that still has it is `deferred`. Without a state.json record (answered directly with
 * a plain `bd comment`, or the 30-day TTL has since pruned it), the fallback is the
 * bead's own `status`/`close_reason` and the `human-replied` label lib/server.js's
 * `/api/comment` is the only thing that sets — see `REPLIED_LABEL` below.
 */
import { toQuestion } from './decision.js';
import { answeredBefore, answeredAgo } from './answered.js';
import { REPLIED_LABEL } from './approvallabels.js';

/**
 * Which option's `response` a recorded answer matches, if any.
 *
 * `recordAnswer` (lib/answered.js) trims the response to 400 characters before it is
 * stored, so an exact match is only safe up to that length — compared as a prefix
 * both ways so a long option response and a long recorded one still line up.
 */
export function matchOption(decision, responseText) {
  const text = String(responseText || '').trim();
  if (!decision?.options?.length || !text) return null;
  const cap = (s) => String(s || '').trim().slice(0, 400);
  return (
    decision.options.find((o) => {
      const r = cap(o.response);
      return r && (text === r || text.startsWith(r) || r.startsWith(text));
    }) || null
  );
}

/**
 * What actually happened to the bead, given a recorded state.json answer.
 * `null` when there is no such record — the caller falls back to status alone.
 */
function outcomeFromRecord(issue) {
  if (issue.status === 'closed') return 'closed';
  const labels = issue.labels || [];
  return labels.includes('human') ? 'deferred' : 'commissioned';
}

/**
 * The verdict for one bead: does it carry a question, and — if so — was it answered.
 *
 * `answered` is the `answered` map out of `state.json` (`loadState().answered`), or
 * `null`/`{}` to skip that check entirely — every caller of this that has no state to
 * read (a plain fixture, a bead outside beadcause's own workspace) still gets a
 * correct answer from status and labels alone, just a less specific one.
 */
export function evaluateBead(wsName, issue, answered) {
  const { decision } = toQuestion(wsName, issue);
  const closed = issue.status === 'closed';
  const humanReplied = (issue.labels || []).includes(REPLIED_LABEL);
  const key = `${wsName}/${issue.id}`;
  const recorded = answeredBefore(answered, key);

  let state = 'not-a-question';
  let outcome = null;
  let chosenOption = null;
  const evidence = [];

  if (decision) {
    if (recorded) {
      state = 'answered';
      outcome = outcomeFromRecord(issue);
      chosenOption = matchOption(decision, recorded.response);
      const ago = answeredAgo(recorded.at);
      evidence.push(
        `beadcause recorded an answer${ago ? ` ${ago}` : ''}${recorded.response ? `: "${recorded.response}"` : ''}`,
      );
    } else if (closed) {
      state = 'answered';
      outcome = 'closed';
      evidence.push(issue.close_reason ? `closed — ${issue.close_reason}` : 'closed, no reason recorded');
    } else if (humanReplied) {
      state = 'answered';
      outcome = 'replied';
      evidence.push('carries human-replied — answered on the thread, not yet closed or handed off');
    } else {
      state = 'unanswered';
      evidence.push('open, carries a decision block, no recorded answer');
    }
  } else {
    evidence.push('carries no decision block');
  }

  return {
    id: issue.id,
    title: issue.title || issue.id,
    hasDecision: !!decision,
    question: decision?.question || '',
    closed,
    closeReason: issue.close_reason || null,
    humanReplied,
    recorded,
    commentCount: (issue.comments || []).length,
    state,
    outcome,
    chosenOption: chosenOption ? { id: chosenOption.id, label: chosenOption.label, closes: chosenOption.closes, defers: chosenOption.defers } : null,
    evidence,
  };
}

/**
 * Walk from a bead up through its parents, one `bd show` per hop, stopping at the
 * first bead with no parent — or at `maxDepth`, a guard against a cycle `bd` itself
 * cannot create but a hand-edited fixture can.
 *
 * `--family` in the bead's own acceptance criteria: "walk ancestors rather than the
 * bead alone", not the sibling walk `b7e-prior --family` does — the two commands
 * answer different questions and happen to share a flag name.
 */
export async function ancestorChain(bd, ws, beadId, { family = false, maxDepth = 20 } = {}) {
  const chain = [];
  const seen = new Set();
  let id = beadId;
  while (id && !seen.has(id) && chain.length < maxDepth) {
    seen.add(id);
    const issue = await bd.showWithComments(ws, id);
    if (!issue) break;
    chain.push(issue);
    if (!family) break;
    id = issue.parent || null;
  }
  return chain;
}

/**
 * The whole answer: every bead in the chain, evaluated, plus which one — if any —
 * actually carries the answer. `null` when nothing in the chain does.
 */
export async function beadAnswer(bd, ws, beadId, { family = false, answered = {} } = {}) {
  const chain = await ancestorChain(bd, ws, beadId, { family });
  const results = chain.map((issue) => evaluateBead(ws.name, issue, answered));
  const carrier = results.find((r) => r.state === 'answered') || null;
  return { bead: beadId, family, results, carrier };
}
