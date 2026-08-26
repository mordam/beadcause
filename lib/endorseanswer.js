/**
 * *Endorse bc-x* — the endorsement gesture, read out of the answer you gave a card.
 *
 * Endorsing exists in three places and until this file none of them was the inbox.
 * `POST /api/bead/endorse` is the door; the `/endorse` page and `bin/endorse.js` both
 * post to it. There is a fourth, and its docblock in lib/endorse.js is the whole
 * argument for this one: `POST /api/session` is *"the one door that endorses rather
 * than refuses"* — tapping **work on this** takes the marker off first and opens the
 * window second, because *"you tapping it is you present and choosing, so a refusal
 * here would send you to another screen to press a button and come back."*
 *
 * That reasoning applies word for word to an answer that says "endorse bc-xl7n.121".
 * It just only ever covered the bead the card is **on**, never one the answer **names**
 * — and twice, three days apart, an answer named one and nothing happened:
 *
 * - **2026-08-22**, answering bc-xl7n.124: *"bc-xl7n.121 endorsed so the class stops
 *   recurring."* Typed, recorded as prose, card closed, marker still on.
 * - **2026-08-25**, answering bc-ogicx.13 by **tapping** its own option: *"Run the
 *   update-branch on PR 703, and endorse bc-xl7n.121 so the stale-check hold gets a
 *   producer instead of a manual nudge each time."* Same ending.
 *
 * bc-xl7n.121 was still held three days later, one label away from dispatch, while ten
 * pull requests waited on the class fix it is.
 *
 * ## Why this reads prose when the handler above it refuses to
 *
 * `/api/respond` already declines to guess at a sentence: bc-wy06 typed **"Ship it"** on
 * a card whose affirmative option was a commission, and the answer now comes back
 * *"pick an option"* rather than being read as one. The comment there is explicit that
 * matching typed words against option labels *"reads 'ship it but not yet' as a
 * commission just as confidently as 'ship it'"*.
 *
 * This is not that, and the difference is the **id**. "Ship it" is a sentence whose
 * meaning has to be inferred; `bc-xl7n.121` is a name, written out, that can only be
 * one bead. What is inferred here is one bit — whether the sentence tells that bead to
 * be endorsed — and the reading is deliberately narrow enough that the inference is
 * nearly free: the word has to be there, the id has to be **adjacent to it**, and a
 * negation in front of the word takes the whole clause off the table.
 *
 * ## The prefix is what makes an id an id
 *
 * Ids are found with `mentionsIn` from lib/mentions.js, which needs the workspace's
 * prefix. That is not an economy, it is the precision: the general shape of a bead id
 * is also the shape of an ordinary hyphenated word, and the very sentence that filed
 * this bug contains **`update-branch`**, which any prefix-free pattern reads as a bead.
 * So an id in another workspace's prefix is not seen at all — an answer here endorses
 * in this workspace or not at all, and lib/server.js says so on the thread when the
 * reading comes up empty in a way you can act on.
 *
 * ## What is deliberately still a mistake nobody catches
 *
 * The bc-ogicx.13 option carried no `closes: false`, so it settled the bead even though
 * its response text was two imperatives. Widening `answerShape`'s commission guard from
 * *the card's options* to *the chosen response* would catch that whole class and is the
 * fuzziest of the three shapes this bug offered; it is not done here. What is done is
 * narrower and has a hard edge: an endorsement named in an answer is **performed**, and
 * an endorsement that could not be performed leaves the card open saying so, so the one
 * ending this class must never have — recorded as settled with the marker still on —
 * is unreachable for the endorsement half.
 */
import { mentionsIn } from './mentions.js';

/**
 * The most beads one answer may endorse.
 *
 * `WRITE_CAP` in lib/mentions.js is eight for a neighbouring reason — a single write
 * naming more than that is a list somebody pasted — and the same number is right here
 * for a different one. An option's `response` is authored by the agent that filed the
 * card and, tapped from the inbox *list* rather than from the open card, is sent
 * without being shown in full (public/app.js arms, then submits `opt.response`). So the
 * ceiling is what a person could plausibly have meant to endorse in one sentence, and
 * anything past it is reported rather than performed.
 */
export const ENDORSE_CAP = 8;

/** The verb, in every form an answer actually writes it. */
const ENDORSE = /^endors(?:e|es|ed|ing|ement|ements)$/;

/**
 * A negation in front of the verb, read over the few words before it.
 *
 * Whole-sentence matching was tried and is wrong: *"endorse bc-x — it is not blocked"*
 * negates nothing, and a sentence-wide `not` would drop it. What negates an
 * endorsement is what comes immediately before the word, so the window is the four
 * words in front of it, stopped at the end of the previous sentence — which is what
 * keeps *"Do not do that. Endorse bc-x."* out of this.
 *
 * Two-word forms are matched against the joined window rather than word by word,
 * because a bare `rather` or `instead` is not a refusal ("I would rather endorse bc-x")
 * and `rather than` is.
 */
const NEGATED = /\b(?:not|never|without|avoid(?:ing|s)?|un-?endors\w*|revok\w*|don'?t|doesn'?t|didn'?t|won'?t|cannot|can'?t|refus\w*)\b|\brather than\b|\binstead of\b|\bno need\b/i;

/** How far back in front of the verb a negation is looked for. */
const NEGATION_WINDOW = 4;

/**
 * Words allowed to sit between the verb and the first id it reaches.
 *
 * Nothing here is a verb or a preposition of its own — anything that could start a
 * second instruction has to stop the walk, which is what keeps *"endorse bc-x and close
 * bc-y"* from endorsing bc-y.
 */
const FILLERS = new Set(['the', 'bead', 'beads', 'both', 'of', 'issue', 'issues']);

/** What may sit *between* two ids without ending the list. */
const CONNECTORS = new Set(['and', 'plus', 'also']);

/** A token that is nothing but punctuation, and whether that punctuation joins a list. */
const JOINING_PUNCT = /^[,+&]+$/;

/**
 * One whitespace-delimited chunk of the answer, with the three facts the walk needs.
 *
 * `terminator` is the subtle one and it is why ids are matched *after* the edges are
 * stripped: `bc-xl7n.121.` ends a sentence and `bc-xl7n.121` does not, but the dotted
 * tail of an id is not punctuation and must survive. So the strip runs first, the id
 * test runs on what is left, and the trailing offcut is what decides the sentence.
 */
function tokenize(text, prefix) {
  const ids = new Set(mentionsIn(text, prefix));
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const trimmed = raw.replace(/[^a-z0-9]+$/i, '');
      const word = trimmed.replace(/^[^a-z0-9]+/i, '').toLowerCase();
      const tail = raw.slice(trimmed.length);
      return {
        raw,
        word,
        id: ids.has(word) ? word : null,
        // A colon is not one: "endorse: bc-x" is a label, not the end of a thought.
        terminator: /[.!?;]/.test(tail),
      };
    });
}

/**
 * The ids one occurrence of the verb reaches, forwards first and then backwards.
 *
 * Forwards is the ordinary shape — *"endorse bc-xl7n.121 so the stale-check hold gets a
 * producer"*. Backwards is the other real one and it is not symmetry for its own sake:
 * *"bc-xl7n.121 endorsed so the class stops recurring"* is how the first of the two
 * incidents was written, and a reading that only looked forwards would have missed it.
 *
 * Only one direction ever contributes. A verb with ids on both sides is a sentence
 * doing two things, and the one it is doing *to* comes after it.
 */
function reach(tokens, at) {
  const forward = [];
  for (let i = at + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.id) {
      forward.push(t.id);
      if (t.terminator) break;
      continue;
    }
    if (t.terminator) break;
    const joins = t.word ? (forward.length ? CONNECTORS.has(t.word) : FILLERS.has(t.word)) : JOINING_PUNCT.test(t.raw);
    if (!joins) break;
  }
  if (forward.length) return forward;

  const back = [];
  for (let i = at - 1; i >= 0; i--) {
    const t = tokens[i];
    // Checked before the id, unlike forwards: a terminator on this token ends the
    // *previous* sentence, so nothing at or before it belongs to this verb.
    if (t.terminator) break;
    if (t.id) {
      back.unshift(t.id);
      continue;
    }
    const joins = t.word ? (back.length ? CONNECTORS.has(t.word) : FILLERS.has(t.word)) : JOINING_PUNCT.test(t.raw);
    if (!joins) break;
  }
  return back;
}

/** The few words in front of the verb, stopped at the end of the previous sentence. */
function runUpTo(tokens, at) {
  const words = [];
  for (let i = at - 1; i >= 0 && words.length < NEGATION_WINDOW; i--) {
    if (tokens[i].terminator) break;
    words.unshift(tokens[i].word || tokens[i].raw);
  }
  return words.join(' ');
}

/**
 * What this answer says about endorsing beads: `{ endorse, declined, dropped }`.
 *
 * `endorse` is the ids to take the marker off, in the order the answer names them and
 * without repeats. `declined` is the ids it names next to a *negated* verb — reported
 * rather than silently ignored, because "I read this and did nothing" is the sentence
 * whose absence is the whole bug. `dropped` is what fell past `ENDORSE_CAP`.
 *
 * Pure: no tracker, no clock, no `bd`. Whether any of these beads exists, is already
 * endorsed, or may not be endorsed at all is `applyVerdict`'s to answer — see
 * lib/verdict.js, which reports each of those three separately and never throws for one
 * bead.
 */
export function endorsementsIn(text, { prefix } = {}) {
  const empty = { endorse: [], declined: [], dropped: [] };
  if (!prefix || !String(text || '').trim()) return empty;
  const tokens = tokenize(text, prefix);
  if (!tokens.some((t) => t.id)) return empty;

  const endorse = [];
  const declined = [];
  const seen = new Set();
  const say = (list, id) => {
    if (seen.has(id)) return;
    seen.add(id);
    list.push(id);
  };
  for (let i = 0; i < tokens.length; i++) {
    if (!ENDORSE.test(tokens[i].word)) continue;
    const negated = NEGATED.test(runUpTo(tokens, i));
    for (const id of reach(tokens, i)) say(negated ? declined : endorse, id);
  }
  return { endorse: endorse.slice(0, ENDORSE_CAP), declined, dropped: endorse.slice(ENDORSE_CAP) };
}

/**
 * What the thread is told, from what the reading asked for and what `bd` did about it.
 *
 * One line, on the answer itself, naming every bead in every state — endorsed, already
 * endorsed, refused, declined by the sentence, dropped past the cap. It is the whole
 * remedy for the failure this file exists about: an answer that mentioned an
 * endorsement and left no trace of whether it happened.
 *
 * `out` is an `applyVerdict` result, or null when the reading asked for nothing.
 */
export function endorsementNote(read, out) {
  const bits = [];
  const moved = (out?.ok || []).filter((r) => r.endorsed).map((r) => r.id);
  const already = (out?.ok || []).filter((r) => !r.endorsed).map((r) => r.id);
  if (moved.length) bits.push(`Endorsed: ${moved.join(', ')}.`);
  if (already.length) bits.push(`Already endorsed, so nothing to do: ${already.join(', ')}.`);
  for (const f of out?.failed || []) bits.push(`Could not endorse ${f.id} — ${f.error}.`);
  if (read?.declined?.length) {
    bits.push(`Not endorsed: ${read.declined.join(', ')} — this answer reads as declining to endorse ${read.declined.length === 1 ? 'it' : 'them'}.`);
  }
  if (read?.dropped?.length) {
    bits.push(`Not endorsed: ${read.dropped.join(', ')} — one answer endorses at most ${ENDORSE_CAP} beads.`);
  }
  return bits.join(' ');
}

/**
 * The same five facts as a value, for the answer's own reply — or `null` for the answer
 * that said nothing about endorsing anything, which is nearly all of them.
 *
 * Shaped by what happened rather than by `applyVerdict`'s wire body (lib/verdict.js),
 * because two of the five never reach `bd` at all: a sentence that *declines* to endorse
 * asks for no write, and an id past `ENDORSE_CAP` is never sent. A client reading
 * `applied` off a verdict body would see those two as simply absent, which is the
 * silence this whole file is about.
 */
export function endorsementResult(read, out) {
  if (!read?.endorse?.length && !read?.declined?.length && !read?.dropped?.length) return null;
  return {
    endorsed: (out?.ok || []).filter((r) => r.endorsed).map((r) => r.id),
    already: (out?.ok || []).filter((r) => !r.endorsed).map((r) => r.id),
    failed: (out?.failed || []).map((r) => ({ id: r.id, error: r.error })),
    declined: read.declined || [],
    dropped: read.dropped || [],
  };
}
