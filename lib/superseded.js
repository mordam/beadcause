/**
 * `superseded-by:<id>` — the other reason a bead may not be worked.
 *
 * Two beads describing the same job is ordinary, and a worker that finds the second one
 * has always had the right instinct and the wrong tools. Closing a bead is not a
 * worker's call, so the move available was to park the duplicate behind the original
 * with `bd dep add` and write "when the original lands, close this as superseded rather
 * than working it" in a comment. That reads perfectly and holds right up until the
 * original lands — at which point closing the blocker makes the duplicate `bd ready`,
 * the advocate picks it up, and an unattended session is opened on a bead whose own
 * comments say not to work it.
 *
 * bc-e1kv is the worked example. It was parked behind bc-0nea with exactly that comment;
 * bc-0nea landed as #33, which unblocked bc-e1kv, which went ready, which opened a
 * session. That session did the only honest thing available — verified the fix really
 * was in `main`, and filed a question asking for the close — and its whole window went
 * on re-deriving a conclusion already written on the bead.
 *
 * The gap was that "superseded, pending approval to close" had no machine-readable form.
 * It lived in prose, so nothing between the blocker closing and a worker reading that
 * prose could act on it. So it becomes a label, and the label is what the rest of this
 * file is about:
 *
 * 1. **A filter**, in `Bd.ready` — a marked bead is out of every queue, exactly as an
 *    `unendorsed` one is. This is what keeps layer 2 from being reached, which is why it
 *    is not the guarantee.
 * 2. **A refusal**, in `openWorkSession` — the launcher asks the tracker itself, and a
 *    marked bead handed straight to it still cannot be worked. This *is* the guarantee.
 * 3. **A question**, here — `sweepSuperseded` below. When the named original closes, the
 *    advocate does not open a session on the duplicate: it puts the duplicate in the
 *    inbox as a card whose one tap is the close. The close stays Adam's, which is the
 *    whole reason a worker was not allowed to make it.
 *
 * The shape is deliberately lib/endorse.js's, because it is the same shape: a marker a
 * worker records as a fact, a decision that stays with Adam, and no session spent on it.
 * What is different is the ending. An `unendorsed` bead is waiting to be *let* into the
 * queue; a superseded one is waiting to be let *out of the tracker*, and that ask is a
 * card rather than a screen somebody has to remember to visit.
 *
 * **The card is the bead itself.** Not a separate question about it: answering a `human`
 * bead closes it (`respond` in lib/bd.js), so putting the ask on the duplicate makes one
 * tap the close, with nothing to keep in step and nothing to clean up afterwards. The
 * one option that does *not* close — "it is not the same job" — hands the bead back as
 * work, and that path takes the marker off again; see `release`.
 *
 * Nothing here opens, merges or deploys anything. It reads the tracker and writes three
 * lines to one bead, and every failure is a returned sentence rather than a throw: the
 * sweep is a courtesy on top of the advocate's tick and may not take the tick down.
 */

/** The marker's prefix. One spelling, in one place — three would be the same as none. */
export const SUPERSEDE_PREFIX = 'superseded-by:';

/** `superseded-by:bc-0nea`. What a worker writes, and what a sweep reads back. */
export const supersedeLabel = (id) => `${SUPERSEDE_PREFIX}${String(id || '').trim()}`;

/**
 * Ids are checked rather than trusted, and the reason is not injection — it is that a
 * label is free text and `superseded-by:` in front of a sentence would otherwise become
 * a permanent, unexplained hold on a bead nothing would ever ask about.
 *
 * The same shape lib/server.js requires of a bead id on the wire, subtasks included:
 * `bc-0nea`, `bc-3zo9.2`.
 */
const ID_RE = /^[a-z][a-z0-9]*-[a-z0-9.]+$/i;

/**
 * The bead this one is a duplicate of, or `''`.
 *
 * Takes a `bd --json` row, or anything carrying `labels`. A label whose id does not
 * parse is ignored — it is not a marker, so it holds nothing and says nothing.
 */
export function supersededBy(issue) {
  for (const raw of issue?.labels || []) {
    const label = String(raw).trim();
    if (!label.startsWith(SUPERSEDE_PREFIX)) continue;
    const id = label.slice(SUPERSEDE_PREFIX.length).trim();
    if (ID_RE.test(id)) return id;
  }
  return '';
}

/** Does this bead carry a marker at all? */
export const isSuperseded = (issue) => Boolean(supersededBy(issue));

/**
 * Why this bead may not be worked.
 *
 * `status: 409` and `superseded: true`, matching lib/endorse.js's refusal field for
 * field: a caller can tell this from a launch that failed, and the advocate has no
 * business retrying it — where iTerm refusing is worth a second go.
 */
export const refusal = (id, original) =>
  Object.assign(
    new Error(
      `${id || 'that bead'} may not be worked — it is ${supersedeLabel(original)}, so it is ${original}'s work rather than its own`
    ),
    { status: 409, superseded: true, supersededBy: original }
  );

/**
 * The gate, given a row the caller has already read from the tracker.
 *
 * Unlike `assertEndorsed` this takes no `bd` and makes no call: it sits immediately
 * after that one in `openWorkSession`, which has just paid for the `bd show` and hands
 * over what it read. Trusting a *caller-supplied* row would be the hole lib/endorse.js
 * closes; trusting the row the tracker itself just returned is the same fact, already
 * fetched, and a second `bd show` would only ask it again.
 */
export function assertNotSuperseded(issue) {
  const original = supersededBy(issue);
  if (original) throw refusal(issue?.id, original);
  return issue;
}

/** Where the sweep leaves its fingerprint, so it can tell its own work from a rewrite. */
const ASK_MARK = '<!-- beadcause:superseded -->';

/** Has this bead already been asked about? Read off the row `bd ready` returned. */
export const alreadyAsked = (issue) =>
  [issue?.description, issue?.design, issue?.notes].some((f) => String(f || '').includes(ASK_MARK));

/**
 * The card, as markdown with a `decision` block in it.
 *
 * Two options and both of them are real, which is the point of writing a block at all
 * rather than leaving the answer box empty: a card that offers only "close it" is a
 * leading question, and the answer that matters — "these are not the same job" — is the
 * one the marker got wrong.
 *
 * `closes: false` on the second is what makes it honest. Answering ordinarily closes a
 * bead, and closing this one on "keep it" would file the work as finished in the same
 * breath as ordering it (see lib/decision.js). Instead the bead is handed back, and the
 * marker comes off on the way — `release` below, called from the same answer.
 */
export function supersedeAsk(dup, original) {
  return `${ASK_MARK}
## ${original} is closed, and this was marked a duplicate of it

A worker found these two beads describing the same job and marked this one
\`${supersedeLabel(original)}\` rather than closing it, because closing a bead is not a
worker's call. ${original} has now closed, so this is the moment that call falls due.

Nothing will open a session on ${dup.id} while the marker is on it — not the advocate,
and not anything else. **This card is the only thing that takes it off**, one way or the
other, so an answer here is not tidying up: it is the decision.

Read ${original} first if the two titles are not obviously the same job. The worker
thought they were; it is the kind of thing that is obvious from one end and not the other.

\`\`\`decision
question: Close ${dup.id} as superseded by ${original}?
options:
  - id: close
    label: Close it — ${original} covered it
    response: "Superseded by ${original}, which is closed. Closing this rather than working it."
    hint: Nothing is ever opened on it
    recommended: true
  - id: keep
    label: Keep it — not the same job
    response: "Not a duplicate after all — ${original} did not cover this. The superseded marker comes off and this goes back into the queue as ordinary work."
    hint: The marker comes off and an advocate may pick it up
    closes: false
\`\`\`
`;
}

/**
 * Ask about every marked bead whose original has closed. Returns what it asked and what
 * it deliberately did not.
 *
 * `bd ready` is the right list to walk and not an approximation of one: a duplicate
 * parked behind its original is *blocked* until that original closes, so "ready and
 * marked" is exactly "the original just landed". It is also, by `--exclude-label human`,
 * "and not already in the inbox".
 *
 * Three writes per bead, in this order and for these reasons:
 *
 *   - **The comment**, first, so whatever fails after it the record is on the thread —
 *     the same discipline `respond` keeps.
 *   - **The ask appended to the notes**, because that is where the card's body and its
 *     `decision` block are read from (lib/decision.js). `--append-notes` rather than
 *     `--notes`, which would overwrite whatever the bead already said about itself.
 *   - **The `human` label**, last, because that write *is* "it is in the inbox". A card
 *     that appeared before its options were written would be a question with no answers.
 *
 * A missing or unreadable original is skipped rather than asked about. The tracker being
 * mid-write and the bead genuinely not existing are indistinguishable from here, and a
 * card saying "the bead it names is gone" would be wrong every time it was the former.
 * The bead stays held and the reason is logged every sweep, which is loud enough.
 */
export async function sweepSuperseded(bd, ws) {
  const out = { ok: false, reason: '', checked: 0, asked: [], skipped: [] };

  let rows;
  try {
    rows = await bd.readySuperseded(ws);
  } catch (err) {
    out.reason = `could not read the ready queue — ${String(err.message || err).split('\n')[0]}`;
    return out;
  }

  out.ok = true;
  for (const row of rows || []) {
    const original = supersededBy(row);
    if (!original) continue;
    out.checked += 1;

    if (alreadyAsked(row)) {
      // The label write is the only one that can fail after the ask is on the bead, and
      // this is what stops that failure asking again — and again — every ten minutes.
      out.skipped.push({ id: row.id, why: `it already carries the ask about ${original}` });
      continue;
    }

    let orig;
    try {
      orig = await bd.show(ws, original);
    } catch (err) {
      out.skipped.push({ id: row.id, why: `cannot read ${original} — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }
    if (!orig) {
      out.skipped.push({ id: row.id, why: `it names ${original}, which the tracker does not have` });
      continue;
    }
    if (String(orig.status || '').toLowerCase() !== 'closed') {
      // The ordinary case for a live pair, and not worth a line anywhere: the marker is
      // doing its job and the question is not due yet.
      continue;
    }

    try {
      await bd.comment(ws, row.id, `${original} has closed. Asking whether this goes with it — see the card in the inbox.`);
    } catch {
      // The comment is the record and the card is the ask. A tracker that took one and
      // not the other should still ask: a missing comment costs a sentence, and a
      // missing card costs a bead nobody is ever asked about again.
    }
    try {
      await bd.appendNotes(ws, row.id, supersedeAsk(row, original));
      await bd.addLabel(ws, row.id, 'human');
    } catch (err) {
      out.skipped.push({ id: row.id, why: `could not put it in the inbox — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }
    out.asked.push({ id: row.id, title: row.title || '', original });
  }

  return out;
}

/**
 * Take the marker off: the bead becomes ordinary work again.
 *
 * The other ending, and the *only* thing in the daemon that removes a marker. It is
 * called from one place — the answer that chose "keep it", which is a commission
 * (lib/bd.js) — because that answer is Adam saying outright that these are two jobs. A
 * commission that left the marker on would hand back a bead nothing may open a session
 * on, which is a card that lied about what its button did.
 *
 * Deliberately *not* wired to tapping "open a session" on the card the way endorsement
 * is. The two markers do not mean the same thing: `unendorsed` is "nobody has looked at
 * this", and looking at it is exactly what a tap does, where `superseded-by:` is a claim
 * about two beads that opening one of them to read is no verdict on.
 *
 * Idempotent, and cheap when there is nothing to do: a bead that carries no marker is
 * `{ released: false }` and no write at all, so the answer path can call this
 * unconditionally. `issueOrId` takes a row the caller already has, and asks only when it
 * is handed a bare id.
 */
export async function release(bd, workspace, issueOrId) {
  const id = typeof issueOrId === 'string' ? issueOrId : issueOrId?.id || '';
  if (!id) return { released: false, id: '' };
  let issue = issueOrId;
  if (typeof issueOrId === 'string' || !Array.isArray(issueOrId?.labels)) {
    try {
      issue = await bd.show(workspace, id);
    } catch {
      // Nothing to release that we can prove. The answer this rides on has already been
      // written; failing it now over a label would lose the answer rather than save the
      // marker.
      return { released: false, id };
    }
  }
  const original = supersededBy(issue);
  if (!original) return { released: false, id };
  await bd.removeLabel(workspace, id, supersedeLabel(original));
  return { released: true, id, supersededBy: original };
}

/** One line for the log and the card. Empty when the sweep found nothing to say. */
export function describeSuperseded(result) {
  if (!result.ok) return result.reason ? `superseded sweep skipped — ${result.reason}` : '';
  if (!result.asked.length) return '';
  const named = result.asked.map((a) => `${a.id} (superseded by ${a.original})`).join(', ');
  return `asked about ${result.asked.length} superseded bead${result.asked.length === 1 ? '' : 's'} — ${named}`;
}
