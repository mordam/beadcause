/**
 * Which held beads somebody has an **open question about** — the one thing the endorse
 * row could not say.
 *
 * lib/endorsequeue.js carries the whole bead on purpose: title, type, priority,
 * description, acceptance, notes, labels and the provenance edge, because "a decision
 * made off a title is not a decision, it is a rubber stamp with extra steps". Every one
 * of those fields is something the *filing agent* wrote, at the moment it found the
 * work, before anybody had looked at it. None of them can carry what was learned
 * afterwards — and the thing that is learned afterwards is almost always the reason not
 * to endorse.
 *
 * **The measurement this exists for.** bc-wi3s (`test/wsshape.mjs is red on main`) had
 * been finished work since 2026-08-18: the bc-xl7n epic advocate ran the suite, found it
 * green, wrote the evidence on the bead as a comment, and filed bc-xl7n.101 — a `human`
 * bead, P1, open — recommending it be closed rather than endorsed. On 2026-08-20 the
 * endorse sweep took it anyway, in a batch of 56, and it went into a 105-deep ready
 * queue as ordinary work. The row said nothing about any of it. An advocate's instrument
 * for *do not work this* is a card, and **a card loses a race with a bulk endorse it
 * cannot see** — so the card has to be on the row.
 *
 * **A question names a bead by writing its id, and that is the whole of the join.**
 * There is no edge to read: `bd human` beads are questions put to a person, and
 * lib/decision.js's block is prose with options in it. The id appears in the title, the
 * description, the notes (which is where `--append-notes` puts a decision block), the
 * design field, or the acceptance criteria, and any of those is somebody meaning *this
 * bead*. So the text is scanned.
 *
 * **Scanned against the ids already in hand, never against a pattern.** The tempting
 * shape is a bead-id regex per workspace prefix, and it is the shape that produced
 * bc-68ou's bug twice over: `bc-xl7n.101` matched as `bc-xl7n`, so a question about a
 * child was read as a question about the P0 epic above it. Here the queue is already
 * holding the exact set of ids it wants an answer for — sixty of them at most — so the
 * ids come out of the question's prose *whole* (dotted suffix and all, `idsIn`) and are
 * then intersected with that set. A junk token the loose pattern picks up (`endorse-check`,
 * `read-only`) matches no queue row and costs nothing; a child id can never collapse to
 * its parent, because nothing ever truncates.
 *
 * **One `bd human list` per workspace, on the key the inbox already keeps warm.** This is
 * the same call `allQuestions()` in lib/server.js makes on its own poll, under the same
 * `questions:<workspace>` key on lib/cache.js — so on a running daemon this sweep almost
 * never spawns anything at all, and on a cold one it pays for a read the inbox was about
 * to pay for anyway. Sharing the key rather than minting a second one is deliberate: two
 * keys would mean two `bd human list` calls per workspace per cycle for one answer, which
 * is precisely the cost bc-1kwl exists to hold down.
 *
 * **A workspace that could not be read leaves `questions` null, not empty.** Same rule as
 * the provenance edge next door, and for a sharper reason: `[]` on this field is the
 * sentence *nobody has asked anything about this bead*, and saying that on the strength of
 * a `bd` call that never came back is the exact failure this whole feature is about. But
 * *could not be read* means **nothing at all behind the key** — a refresh that fell over a
 * key the cache is still holding is stale, not missing, and the list it is holding keeps
 * drawing its flags. Blanking a whole workspace's ⚑ for one transient `bd human list` would
 * be the same sentence said the same way, with a good answer sitting right there unread.
 * `public/endorse.js` spends the distinction in the one place it can be acted on: the
 * *Endorse all* confirm, which is the only control in this app that presses on *nothing
 * here has a question against it* for sixty beads at once.
 */
import * as cache from './cache.js';
import { DELIVERY_LABEL } from './delivery.js';

/**
 * How long a swept question list is served again before it is asked for afresh.
 *
 * Ten seconds, which is `INBOX_FRESH_MS` in lib/server.js, and it is written out here
 * rather than imported because importing it would mean this leaf module importing the
 * daemon. They are two readers of one key and they are allowed to disagree about it: the
 * window only decides *who pays* for the next sweep, and whichever of them asks first
 * past its own window fills the key for both.
 */
export const QUESTIONS_FRESH_MS = 10_000;

/** How many questions a row will name. Three is already a bead nobody should bulk-endorse. */
export const QUESTIONS_PER_ROW = 3;

/** Fields of a question that can name a bead. `notes` is where a decision block lands. */
const QUESTION_FIELDS = ['title', 'description', 'notes', 'design', 'acceptance_criteria'];

/**
 * **Two things wear the `human` label and are not somebody asking about a bead**, and
 * excluding them is the whole of the join's precision.
 *
 * A `human` **epic** is a **standing board card**: the epic *is* the work, the label puts
 * it on the P0 board, and its notes are an advocate's running log that names every bead it
 * has touched this week. Measured against the live beadcause tracker on 2026-08-23, before
 * this line existed: 17 open `human` beads, four of them epics, and those four produced
 * *every* false positive — three unrelated held beads flagged because `bc-9d37`'s and
 * `bc-rfnr.9`'s notes happen to mention them.
 *
 * A `pr-delivery` card is the same shape for the same reason, and it is the one the first
 * measurement could not see because beadcause's own tracker had none open that day. It is a
 * **merge** card — lib/mergeraise.js relabels a merge-bead into one when the queue hands a
 * pull request back — so its question is *should this branch merge*, never *should an hour
 * of unattended agent be spent on this bead*, and its body is a `beadpr` block (lib/delivery.js)
 * whose title and summary name every bead the branch touched. Measured against the
 * configured `architecture` workspace on 2026-08-24: **77 held beads, 46 open `human` beads,
 * 28 held rows flagged — and every one of the 18 questions doing the flagging was a
 * `pr-delivery` card.** `cl-ae8` (*Merge #569? cl-tcg*) alone named five further beads on
 * the same root cause, so five held rows each drew "An open question names this bead" about
 * a merge decision that was not about them. With the exclusion the same measurement is
 * **0**, and beadcause's own is unchanged: `bc-xl7n.77.1` ("Do the three Climative network
 * beads belong in this tracker?") still flags the three beads it genuinely names.
 *
 * That is a third of one configured workspace's queue drawing a ⚑ that means nothing, on
 * the first production sweep — which is the difference between a warning and a row you
 * learn to scroll past, and the second of those costs the feature everything it is for.
 *
 * **Both are exclusions of a class, not of a case**, and the class is *a card the machinery
 * raises about its own progress*, whose text names beads for bookkeeping. A `human` task,
 * bug or decision that is not one of those is the other thing entirely — somebody asking
 * about something, once, and naming what they mean.
 */
const labelled = (issue, label) =>
  (issue?.labels || []).some((l) => String(l ?? '').trim().toLowerCase() === label);

const notAQuestion = (issue) =>
  String(issue?.issue_type ?? '').trim().toLowerCase() === 'epic' || labelled(issue, DELIVERY_LABEL);

/**
 * Every bead id shaped token in a piece of text, whole.
 *
 * `(?:\.\d+)*` is the half that matters and it is bc-68ou's lesson written down twice
 * (see lib/beadref.js): without it `bc-xl7n.101` comes back as `bc-xl7n`, and a question
 * about one child of an epic reads as a question about the epic and therefore about all
 * of its children. The pattern is otherwise deliberately loose — no workspace prefix is
 * asked for — because the caller intersects with real ids and a false match has nothing
 * to hit.
 */
const ID_RE = /\b[a-z][a-z0-9]{0,9}-[a-z0-9]{2,10}(?:\.\d+)*\b/gi;

const clean = (v) => String(v ?? '').trim();

export const idsIn = (text) => [...String(text ?? '').matchAll(ID_RE)].map((m) => m[0].toLowerCase());

/** Every bead this question names, across all the fields a person could have written it in. */
export function namesIn(issue) {
  const found = new Set();
  for (const field of QUESTION_FIELDS) for (const id of idsIn(issue?.[field])) found.add(id);
  return found;
}

/**
 * One `bd human list` row → what a row says about it.
 *
 * Four fields and no more: this is a line on somebody else's card, not a card. What it
 * has to carry is enough to decide *should I stop and read that instead of endorsing
 * this* — which is the question's own words and how urgent whoever filed it thought it
 * was — plus the key every client in this app already uses to open a bead.
 */
export const toQuestionRef = (workspace, issue) => ({
  key: `${workspace}/${clean(issue?.id)}`,
  workspace,
  id: clean(issue?.id),
  title: clean(issue?.title),
  priority: issue?.priority ?? null,
});

/** Loudest first: a P0 asked about this bead outranks a P3, and ties settle by id. */
const loudestFirst = (a, b) =>
  (a.priority ?? 9) - (b.priority ?? 9) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

/**
 * Hang the open questions on the rows — mutating them in place, like `addShowFields`.
 *
 * Only the workspaces that actually have rows in this queue are read: on an install with
 * seven repos and three held beads in one of them, asking the other six for their `human`
 * beads would be six spawns spent to learn nothing. A workspace whose read fails leaves
 * its rows' `questions` at `null` — see the header for why that is not `[]`.
 */
export async function addOpenQuestions(bd, workspaces, rows, { now = () => Date.now(), refresh = false } = {}) {
  const byName = new Map((workspaces || []).map((w) => [w.name, w]));
  const wanted = new Map();
  for (const row of rows || []) {
    if (!byName.has(row.workspace)) continue;
    if (!wanted.has(row.workspace)) wanted.set(row.workspace, new Map());
    wanted.get(row.workspace).set(String(row.id).toLowerCase(), row);
  }

  await Promise.all(
    [...wanted].map(async ([name, byId]) => {
      let questions;
      try {
        const got = await cache.read(`questions:${name}`, () => bd.listHuman(byName.get(name)), {
          freshMs: QUESTIONS_FRESH_MS,
          now,
          refresh,
        });
        // **A failed refresh over a live key is stale, not missing.** lib/cache.js's own
        // rule is *last good beats empty*: a producer that throws over a key that already
        // has a value leaves the value readable and puts the failure on the envelope.
        // Throwing on `got.error` regardless discarded a question list that was sitting
        // right there, and blanked every ⚑ in the workspace for one transient
        // `bd human list` — which is `[]` said on the strength of a `bd` call that never
        // came back, the exact sentence the header refuses to let this file say. So the
        // error is only fatal when there is nothing behind it; `read` throws of its own
        // accord in that case, because a cold failure has no entry to serve.
        if (!Array.isArray(got.value)) throw new Error(got.error || `questions:${name} answered nothing`);
        questions = got.value;
      } catch {
        // The rows keep `null`. A queue that would not load because one repo's question
        // list could not be read would be the worst possible trade — the same one
        // `addShowFields` refuses next door.
        return;
      }
      for (const row of byId.values()) row.questions = [];
      for (const q of questions) {
        if (notAQuestion(q)) continue;
        const ref = toQuestionRef(name, q);
        if (!ref.id) continue;
        for (const id of namesIn(q)) {
          // A question that names itself is not a question *about* another bead — and a
          // held bead carrying `human` is in both lists at once, which is the one way
          // this could draw a row pointing at itself.
          if (id === ref.id.toLowerCase()) continue;
          const row = byId.get(id);
          if (row) row.questions.push(ref);
        }
      }
      for (const row of byId.values()) {
        if (row.questions) row.questions = row.questions.sort(loudestFirst).slice(0, QUESTIONS_PER_ROW);
      }
    })
  );
  return rows;
}
