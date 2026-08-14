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

/* ------------------------------------------------------- putting the marker on (bc-28ef)
 *
 * Everything above is about a marker that already exists. This is the other half: the
 * writes that put one there, which until bc-28ef were two lines of prose in the worker
 * brief (lib/session.js) — and were got wrong in three different ways, each of which
 * reads as success.
 *
 * **`bd dep add <dup> <an epic>` is refused.** bd will only let a task be blocked by a
 * non-epic — the same one-line rule lib/park.js is built around, from the other side:
 *
 *     $ bd dep add bc-nqrr bc-4m2j
 *     Error: tasks can only block other tasks, not epics
 *
 * That matters because adoption by an epic is how this tracker gathers duplicates. So a
 * bead superseded by an epic took the label and no edge at all, and the graph recorded
 * nothing about a relationship somebody had just established.
 *
 * **And no other edge type can stand in for the hold.** Measured against the real binary
 * on 2026-08-14 (test/epicedgereal.mjs pins it): of the ten types `bd dep add --type`
 * accepts, `blocks` is the *only* one bd refuses across the epic boundary — and it is
 * also the only one that takes a bead out of `bd ready`. `tracks`, `relates-to`,
 * `supersedes`, `parent-child` and the rest all go in against an epic and every one of
 * them leaves the bead exactly as ready as it was. There is no clever second choice; the
 * hold and the refusal are the same property.
 *
 * Which is survivable, because **the hold was never what timed the card**. `sweepSuperseded`
 * reads the original and asks nothing until it is `closed`, so a marked bead with no
 * blocking edge is swept over, silently, every pass until the original really does land.
 * What the missing edge costs is the graph record — and on a tracker whose whole
 * complaint is that structure lives in prose (bc-arj0), that is the part worth fixing.
 *
 * So when the original is an epic the edge drawn is `relates-to`, via `bd dep relate`:
 * symmetric, so there is no direction to get backwards, drawn as `RELATED ↔` at both
 * ends, and the same edge lib/bd.js's `relateMentions` already uses for "these two beads
 * are connected". `supersedes` was the obvious candidate and is the wrong one — bd
 * renders it as `DEPENDS ON` on the duplicate and `BLOCKS` on the epic while blocking
 * nothing whatsoever, which is a lie told in the one place somebody would go to check.
 * `parent-child` is worse: it would make the duplicate a child of the epic, and bc-arj0.3
 * means an epic cannot close over an open child — so the epic would end up held by the
 * duplicate, which is the hold pointing backwards.
 *
 * **A pair may hold exactly one edge**, of any type, in either direction. Any existing
 * edge — the `discovered-from` that `bin/file.js --from` leaves behind is the common one
 * — makes every other type refuse, `bd update --parent` included. Here that refusal is
 * *success*: the pair is linked, which was the whole point of the edge, and destroying
 * provenance to swap one link for another is not a trade this may make on its own.
 */

/** The edge that actually holds a bead out of `bd ready`, and the only one bd polices. */
export const HOLDING_EDGE = 'blocks';

/** What is drawn instead when `blocks` is not available: a see-also, in both directions. */
export const RELATED_EDGE = 'relates-to';

/**
 * Which edge this pair can have, from the original's type. Pure, and the whole rule.
 *
 * An unknown or unreadable type is treated as a task — the same guess `questionType`
 * makes, and the same reason: it is what every bead that is not an epic is, and the
 * failure if it is wrong is a refused `dep add` that `mark` already reports.
 */
export const edgeFor = (originalType) =>
  String(originalType || '').trim().toLowerCase() === 'epic' ? RELATED_EDGE : HOLDING_EDGE;

/** `dep add` for a blocking edge, `dep relate` for a see-also — bd spells them differently. */
const edgeArgv = (edge, dup, original) =>
  edge === RELATED_EDGE ? ['dep', 'relate', dup, original] : ['dep', 'add', dup, original];

/** bd already has an edge between these two, whatever type it asked for. */
const alreadyLinked = (said) => /already exists with type/i.test(String(said || ''));

/** The first line bd actually said, rather than execFileSync's account of the exit code. */
const said = (err) => {
  const captured = String(err?.stderr || '').trim() || String(err?.stdout || '').trim();
  const line = (captured || String(err?.message ?? err ?? '')).split('\n').filter(Boolean)[0] || '';
  return /^Command failed:/.test(line.trim()) ? 'bd refused it and said why on the line above' : line.trim();
};

/**
 * Put the marker on: the three writes, in the one order that cannot leave a bead worse
 * than it started.
 *
 * `bd` is a **synchronous** runner, `(argv) => stdout`, the one bin/ask.js and
 * bin/propose.js build over `execFileSync` — not the async `Bd` its neighbours in this
 * file take. The difference is not an oversight: the sweep runs inside the daemon and
 * this runs in a worker's terminal, one command, one bead, exit and gone.
 *
 * Rows are handed in rather than fetched, exactly as `assertNotSuperseded` takes one:
 * the caller has already paid for both `bd show`s deciding whether to call this at all.
 *
 * **Order: label, then status, then edge**, which inverts the sweep's and is worth the
 * sentence. The label is the guarantee — it is what `Bd.ready` filters and what
 * `openWorkSession` refuses on — so it goes first, because every later failure then
 * leaves a bead that is *held* and short of a record, rather than one that is released
 * and unmarked. Status is second and is not housekeeping: a worker reaches this having
 * claimed its own bead, `bd ready` returns open rows only, and a marked bead left
 * `in_progress` is invisible to `readySuperseded` forever — held, with nobody ever asked.
 * The edge is last because it is the only one of the three that can fail harmlessly.
 *
 * Never throws. Returns what happened:
 *
 *   `{ marked, held, edge, reopened, refused, notes }`
 *
 * `refused` is a sentence and nothing was written; `held: false` says out loud that the
 * bead is out of the queue by the label alone.
 */
export function mark(bd, dup, original, { dupRow = null, originalRow = null } = {}) {
  const out = { marked: false, held: false, edge: '', reopened: false, refused: '', notes: [] };
  const id = String(dup || '').trim();
  const orig = String(original || '').trim();

  if (!id || !orig) return { ...out, refused: 'both the duplicate and the original have to be named' };
  if (id.toLowerCase() === orig.toLowerCase()) return { ...out, refused: `${id} cannot supersede itself` };
  if (!ID_RE.test(orig)) {
    return { ...out, refused: `${orig} is not a bead id, and a marker naming one holds a bead nothing ever asks about` };
  }
  if (!dupRow) return { ...out, refused: `no bead ${id} here — nothing was written` };
  if (!originalRow) return { ...out, refused: `no bead ${orig} here — nothing was written` };
  if (String(dupRow.status || '').toLowerCase() === 'closed') {
    return { ...out, refused: `${id} is already closed, so there is nothing to hold` };
  }

  const carried = supersededBy(dupRow);
  if (carried && carried.toLowerCase() === orig.toLowerCase()) {
    return { ...out, marked: true, notes: [`${id} was already marked ${supersedeLabel(orig)} — nothing to do`] };
  }
  if (carried) {
    return {
      ...out,
      refused:
        `${id} already carries ${supersedeLabel(carried)}. Two markers on one bead is two cards about ` +
        `one close, so take the first one off deliberately if ${orig} is the better answer.`,
    };
  }

  try {
    bd(['label', 'add', id, supersedeLabel(orig)]);
    out.marked = true;
  } catch (err) {
    return { ...out, refused: `could not label ${id} — ${said(err)}. Nothing else was written.` };
  }

  if (String(dupRow.status || '').toLowerCase() === 'in_progress') {
    try {
      bd(['update', id, '--status=open']);
      out.reopened = true;
    } catch (err) {
      out.notes.push(
        `${id} is still \`in_progress\` (${said(err)}) — and \`bd ready\` is open rows only, so nothing will ` +
          `ever raise the close card for it. Run \`bd update ${id} --status=open\` before you leave.`
      );
    }
  }

  const edge = edgeFor(originalRow.issue_type || originalRow.type);
  try {
    bd(edgeArgv(edge, id, orig));
    out.edge = edge;
    out.held = edge === HOLDING_EDGE;
  } catch (err) {
    const why = said(err);
    if (alreadyLinked(why)) {
      out.notes.push(`${id} and ${orig} already have an edge between them, so none was drawn — ${why}`);
    } else {
      out.notes.push(`could not draw the ${edge} edge — ${why}. ${id} is marked, which is the half that holds it.`);
    }
  }
  if (edge === RELATED_EDGE) {
    out.notes.push(
      `${orig} is an epic, and bd will not let a task be blocked by one. Drew a \`${RELATED_EDGE}\` edge ` +
        `instead: ${id} is out of every queue by the marker rather than by the graph, and the close card ` +
        `still waits for ${orig} to close.`
    );
  }
  return out;
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
