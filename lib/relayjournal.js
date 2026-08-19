/**
 * The relay journal — what each role in a department relay did, written on the bead as it
 * runs, so a relay can be read from a phone without opening the window it is running in.
 *
 * lib/relay.js decides *who the agent is*; this is the trail that agent leaves behind it.
 * `dv-vzg` asked whether a relay should stop for a card after every role and the answer was
 * **(a) full relay** — *"Full Relay, but all the steps and handoffs are recorded in the bead
 * for me to view/access in the EpicCards"*. The recording is not a nicety attached to that
 * answer, it is the condition on it: one launch now carries a deliverable through four or
 * five roles with nobody watching, and the cost of that is a bad early choice propagating
 * through three more roles before anyone sees it. A relay stalled at step 2 and one quietly
 * working step 4 are identical from outside — the same argument lib/epicadvocate.js makes
 * for its waiting-on sentence, one grain finer, because here the steps are the thing.
 *
 * ## Why `notes`, when a ledger of things that happened wants comments
 *
 * A trail is append-only and comments are the append-only surface in this repo — bd stamps
 * each one with a time, nothing can rewrite an earlier one, and lib/plan.js and
 * lib/promoterun.js both store their blocks there. The relay brief wrote exactly that until
 * this landed: one `bd comment` per handoff.
 *
 * It goes in `notes` for one reason, and it is the half of the bead that renders it.
 * **`bd export` carries `notes` and does not carry comments** — `Bd.graph` builds the whole
 * board out of one export per workspace, and the epic card's tree is sixty of those rows.
 * Reading a comment-stored trail there is a `bd comments` spawn *per descendant per tick*,
 * which is not a slower version of this design, it is a board that cannot be drawn. The
 * same fact is why `waitingOn` reads notes. So: notes, and the append-only property is kept
 * by hand instead of being inherited.
 *
 * **Kept by hand means one appended block per entry, never a rewritten field.** Every other
 * marked block in this repo is one *current answer* that later writes replace, which is why
 * lib/mergebead.js needs a cutter and why that cutter has its own hardening note. This one
 * has no cutter and cannot have one: `bd update --append-notes` only ever adds, so an entry
 * physically cannot destroy an earlier entry, a hand-written note, or another agent's
 * block. Position is chronology — the same property lib/notinmain.js's `askMark` relies on.
 * The cost is that a journal is never tidied, which is the right side to fail on: the trail
 * of a relay that went wrong is the one thing worth keeping.
 *
 * ## Why the payload is JSON inside the comment
 *
 * A bead's `notes` is rendered as markdown on both surfaces that draw it (public/app.js and
 * public/graph.js), and DOMPurify drops comment nodes — so a block written this way draws
 * nothing at all, and the trail appears only where it is rendered *as* a trail. That is
 * lib/promoterun.js's shape rather than lib/epicadvocate.js's, and the difference is how
 * often it repeats: one waiting-on sentence reads fine as a stray line in the notes, and
 * six handoffs read as the field being full of debris. `-->` inside the payload is escaped
 * the way that file escapes it, because a role's own words are otherwise free to end the
 * comment early and take the rest of the notes out of the document with them.
 *
 * ## What a reader gets, and why there are two of them
 *
 * `relayTrail` is every entry, for the one bead somebody tapped. `relayMark` is the last
 * entry alone, for a row in a tree of sixty — the whole trail on every row of every card
 * would put a relay's entire history on the poll payload once per descendant per repaint,
 * to draw one line. Both answer `null` where there is no journal, which is every bead in
 * every workspace that has never been relayed, so a card with no relay on it is byte-for-
 * byte what it was.
 */

/** Opening marker. Anything between this and `RELAY_CLOSE` is one entry, as JSON. */
export const RELAY_OPEN = '<!-- beadcause:relay';
/** Closing marker, terminating the HTML comment so the block never draws. */
export const RELAY_CLOSE = '/beadcause:relay -->';

/**
 * The steps a journal entry may record.
 *
 * The first four are lib/relay.js's derived chain — draft, check, revise, file — and the
 * fifth is the one thing that chain cannot contain: a session that ran out of room and
 * handed the bead back part-way along. That is the entry the card most needs, because it
 * is the only one that says the relay is *not* going to move again until something else
 * launches, and the brief's hand-back used to leave it as prose in a comment.
 */
export const RELAY_STEPS = ['draft', 'check', 'revise', 'file', 'handback'];

/**
 * How much of one field is kept.
 *
 * A cap rather than a refusal, for `WAITING_MAX`'s reason: the entry is a line on a phone,
 * and a role that wrote three paragraphs into it has still said something worth recording.
 * Generous enough for a sentence with a clause in it, short enough that six of them are a
 * trail and not a document.
 */
export const RELAY_MAX = 240;

const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, RELAY_MAX);
const role = (v) => String(v ?? '').trim().toLowerCase().slice(0, 40);

/**
 * One entry, as it goes into `notes`.
 *
 * `at` is written here rather than left to the caller because it is the field the card is
 * actually read for — "clio, checking, forty minutes ago" is the sentence that separates
 * stalled from progressing, and a timestamp an agent types by hand is a timestamp that can
 * be wrong in the direction that matters. `bin/relaystep.js` is the only writer.
 *
 * Empty `role`, `step` or `note` answers `''` rather than writing a hollow entry: a trail
 * with a blank row in it is worse than one row shorter, because the blank row is indistinguishable
 * from a step that ran and said nothing.
 */
export function relayEntryBlock(entry = {}) {
  const out = {
    at: String(entry.at || new Date().toISOString()),
    role: role(entry.role),
    step: text(entry.step).toLowerCase(),
    note: text(entry.note),
  };
  if (!out.role || !out.step || !out.note) return '';
  const next = role(entry.next);
  if (next) out.next = next;
  const flag = text(entry.flag);
  if (flag) out.flag = flag;
  // Only the comment terminator, and only as a unicode escape — lossless, `JSON.parse`
  // gives the character back, and nothing else in the payload is touched.
  const json = JSON.stringify(out).replaceAll('-->', '--\\u003e');
  return `${RELAY_OPEN} ${json} ${RELAY_CLOSE}`;
}

/**
 * Every entry in a bead's notes, oldest first.
 *
 * Tolerant of garbage for lib/plan.js's reason: `notes` is a field a person can edit from a
 * terminal, and a half-deleted block must cost one row of a trail rather than throwing on
 * the request path that draws the board. An unparseable block is skipped and the scan
 * continues past it; a block with no closing marker ends the scan, because there is no
 * honest place to resume from.
 */
export function journalFrom(notes) {
  const src = String(notes || '');
  const out = [];
  let pos = 0;
  for (;;) {
    const from = src.indexOf(RELAY_OPEN, pos);
    if (from < 0) return out;
    const to = src.indexOf(RELAY_CLOSE, from + RELAY_OPEN.length);
    if (to < 0) return out;
    const body = src.slice(from + RELAY_OPEN.length, to).trim();
    pos = to + RELAY_CLOSE.length;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const step = String(parsed.step || '').trim().toLowerCase();
    const who = role(parsed.role);
    const note = text(parsed.note);
    if (!who || !step || !note) continue;
    out.push({
      at: String(parsed.at || ''),
      role: who,
      step,
      note,
      next: role(parsed.next) || null,
      flag: text(parsed.flag) || null,
    });
  }
}

/**
 * The whole trail, for the bead somebody opened — or `null` where there is none.
 *
 * `flagged` is a count rather than a boolean because it is the number the reader wants
 * before deciding to read the rows: one flag on a five-step relay is the ordinary case a
 * check exists to produce, and four is a deliverable in trouble. `handedBack` is read off
 * the *last* entry rather than off any of them, because a relay that was handed back and
 * then picked up again is running, not stopped.
 */
export function relayTrail(bead) {
  const entries = journalFrom(bead?.notes);
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  return {
    entries,
    last,
    flagged: entries.filter((e) => e.flag).length,
    handedBack: last.step === 'handback',
  };
}

/**
 * The last entry alone, for one row of a tree.
 *
 * `steps` is how many entries there are, which is the other half of what a single row can
 * say: "clio, check" without it could be step two of five or step five of five, and the
 * chain a relay is running is not on the bead once `--claim` has eaten the assignee
 * (lib/relay.js). So the row says how far it has got rather than how far it has to go,
 * which is the question this fact can actually answer.
 */
export function relayMark(bead) {
  const trail = relayTrail(bead);
  if (!trail) return null;
  const { role: who, step, at, flag } = trail.last;
  return { role: who, step, at, steps: trail.entries.length, flagged: trail.flagged, flag: flag || null };
}
