/**
 * Beads whose pull request merged somewhere beadcause was not looking.
 *
 * Everything that closes a bead here does it on the *inside* of an act it performed:
 * the tap on a delivery card merges and then closes (lib/server.js), and a worker that
 * merges its own pull request closes on the way out (bin/deliver.js). Both are correct
 * and both share one blind spot — **the merge button on github.com**. A pull request
 * merged there is merged as far as `main` is concerned and invisible as far as the
 * tracker is concerned, so the bead stays open, stays in `bd ready`, and the advocate
 * keeps opening fresh sessions onto work that is already in main.
 *
 * bc-4irq is the worked example and it cost two full sessions. #29 was merged at
 * 19:43:54 by the GitHub web identity; `~/Library/Logs/beadcause.log` has no `[pr] …
 * merged #29` line, because nothing here did it. Two hours later the advocate released
 * the slot ("still open after 2h"), and attempt 2 spent its whole life proving there was
 * nothing left to do.
 *
 * So: ask GitHub which pull requests merged, work out which beads they were for, and
 * close the ones still open — the same two writes a card merge makes, in the same
 * order. It is deliberately a *sweep* rather than a hook, because there is nothing to
 * hook: GitHub is not going to call this laptop, and a webhook would be a second way in
 * with its own failure modes for a question a periodic read answers exactly.
 *
 * Three rules, and each of them is a way this could do harm rather than good:
 *
 * 1. **GitHub's `MERGED` is the only evidence accepted.** Not local ancestry: a repo
 *    whose `main` has not been fetched in a day would close nothing, and one where a
 *    branch was merged by hand into a local main would close things that never reached
 *    origin. `state: MERGED` on a pull request means it is in the base branch on the
 *    remote, which is the fact the bead is about.
 *
 * 2. **A bead that already said it landed is left alone.** `Landed as #42` on an *open*
 *    bead means it was closed once and somebody reopened it — a human decision that this
 *    must not undo, and undoing it would be a fight rather than a bug: reopen, swept
 *    closed, reopen, swept closed. `bd` clears `closed_at` on reopen, so the bead's own
 *    fields cannot tell you this; its comments can, and that is what is read.
 *
 * 3. **The question closes before the work bead, and on the strength of the merge.** A
 *    delivery parks its bead behind the question with `bd dep add`, and bd will not close
 *    a bead with an open blocker — so the other order silently fails on exactly the case
 *    that most needs this: a worker that could not merge, a card in the inbox, and Adam
 *    merging from the pull request page instead of from the card. What bd would refuse is
 *    then asked outright, before a word is written, because of how rule 2 reads a comment
 *    this might have left.
 *
 *    The card closes *outside* the bead loop, which is bc-u579 and the tail of the same
 *    story. Inside it, a card only closed while a bead behind it was still open and
 *    unskipped — so three ordinary states left one on the phone for good: a work bead
 *    somebody closed by hand, a bead rule 2 leaves alone because it was reopened, and a
 *    pull request that resolves to no bead at all (hand-opened, or a prefix the tracker
 *    would not hand back this tick). Nothing else sweeps a delivery card, so "for good"
 *    is literal. The card asks one question — *merge #42?* — and `state: MERGED` is the
 *    whole answer to it; what became of the work bead afterwards is a different question
 *    and never made this one less answered. The ordering above survives the move, because
 *    outside the loop is still before it.
 *
 * Nothing here merges, pushes, deploys or opens anything. It reads GitHub and writes two
 * kinds of line to the tracker, and every failure is a returned sentence rather than a
 * throw — a sweep is a courtesy on top of the advocate's tick, and it may not be able to
 * take the tick down with it.
 */
import { beadsFor, candidateTiers, prefixFor } from './beadref.js';
import { parseDelivery, DELIVERY_LABEL } from './delivery.js';
import * as pr from './pr.js';

/**
 * How far back the sweep looks — and, now, how far back it actually reaches.
 *
 * This used to be a fortnight sitting behind a forty-row cap on the query, which meant
 * the cap decided and the fortnight was decoration: forty merged pull requests is under
 * a day on this repo, and a bead that fell out of the far end did not fall out for a
 * fortnight, it fell out *for good* — the next sweep asked the same question of a window
 * that had moved further forward, so nothing ever looked at it again. bc-8ug and bc-jin
 * are what that cost: both merged well inside the fourteen days, both roughly a hundred
 * pull requests back by the time anything swept, both left `in_progress` over shipped
 * work, bc-jin holding three beads out of `bd ready` behind it for two days, until
 * bc-4qmp closed them by hand.
 *
 * bc-4qmp made the stranding visible (`truncated`, below). This is the other half, and
 * it took three changes rather than a bigger number, because a bigger number is what the
 * cap was protecting against:
 *
 * 1. **The window goes into the query.** `pr.listMergedSince` asks GitHub for a span of
 *    time, bisecting when a slice comes back full, so the fortnight is the fortnight and
 *    the limit is only a guard against a runaway answer.
 * 2. **The fields shrink.** A merged pull request is not a merge decision, so the sweep
 *    stops asking for `statusCheckRollup` — measured at 15.9s against 2.2s for the same
 *    152 rows. Asking about a fortnight is now *cheaper in wall-clock* than asking about
 *    forty rows used to be.
 * 3. **The per-row `bd` work is gated on one query.** This is the one that mattered, and
 *    the reason the cap existed: `beadsFor` costs a `bd show` per candidate and there is
 *    a `bd comments` and a `bd show` behind every bead it resolves, so a wide window used
 *    to multiply subprocesses by how busy the fortnight had been. `candidateTiers` is
 *    pure string work, though, and one `bd list` says which beads are not closed — so a
 *    row naming no live bead is decided without spawning anything, and it is the rows
 *    that could actually close something that pay. A quiet fortnight and a frantic one
 *    now cost the same sweep.
 *
 * What deliberately did *not* change is retrying. A bead a transient refusal skipped
 * stays open, so it stays in the live set, so its pull request is examined again on every
 * tick for the full fourteen days — which is why the gate is built from open beads rather
 * than from a memo of pull requests already decided about.
 */
const RECENT_DAYS = 14;

/**
 * How many rows one query may answer with before the window is halved and asked again,
 * and the ceiling on the whole sweep.
 *
 * `PAGE_LIMIT` is not a window any more, so it costs nothing to be generous with: on a
 * repo merging 120 a day it is about four days, which is one query for the fortnight
 * most weeks and two on the worst of them. `MAX_ROWS` is the runaway guard — the point
 * past which the honest answer is `truncated` and a line in the log, not thirty seconds
 * of `gh` every ten minutes.
 */
const PAGE_LIMIT = 500;
const MAX_ROWS = 4000;

/**
 * Has this bead already been told it landed on this pull request?
 *
 * The guard behind rule 2 above, and the wording is load-bearing. `Landed as [#42](…)`
 * is what bin/deliver.js writes and what this file writes; `Delivered as [#42](…)` is
 * what a delivery that *could not* merge writes, and that one must not match — a bead
 * waiting on a question about #42 is precisely a bead this should close when #42 turns
 * out to have merged.
 */
async function alreadyLanded(bd, ws, id, number) {
  let comments;
  try {
    comments = await bd.comments(ws, id);
  } catch {
    // A tracker that will not answer is not evidence either way, and the safe reading
    // of "I cannot tell whether I already said this" is to say nothing.
    return true;
  }
  const re = new RegExp(`\\blanded as \\[?#${number}\\b`, 'i');
  return (comments || []).some((c) => re.test(String(c.text || c.body || c.comment || '')));
}

/**
 * Every open delivery question, indexed by the pull request it acts on.
 *
 * Read off the `beadpr` block rather than the title, because the block is the one place
 * in the codebase where a question states outright which PR it acts on — see
 * lib/delivery.js. The values are lists rather than single ids: two deliveries on one
 * branch is a state the tracker permits, and a sweep that closed only the first would
 * leave the other on the phone.
 *
 * Asked **once per sweep**, where it used to be asked once per merged pull request. It
 * is the same list every time and it is not cheap — `bd` here is a subprocess and a Dolt
 * read — so the old shape cost `bd` calls in proportion to how busy the fortnight had
 * been rather than to how many cards exist. Nothing reads it back mid-loop: a card is
 * closed at most once, because one pull request number appears in `merged` once.
 */
async function deliveryCards(bd, ws) {
  const by = new Map();
  let open;
  try {
    open = await bd.listLabel(ws, DELIVERY_LABEL);
  } catch {
    return by;
  }
  for (const q of open || []) {
    if (q.status === 'closed') continue;
    const d = parseDelivery([q.description, q.design, q.notes].filter(Boolean).join('\n\n'));
    if (!d || d.error) continue;
    const n = Number(d.number);
    if (!Number.isFinite(n)) continue;
    if (!by.has(n)) by.set(n, []);
    by.get(n).push(q.id);
  }
  return by;
}

/**
 * Every bead in this workspace that is not closed, as a set of ids — or `null`.
 *
 * The gate that makes a fortnight affordable, and the `null` is the important half.
 * Everything this is used for is a *skip*, so an unreadable tracker must not be allowed
 * to look like an empty one: a Dolt read mid-write returning nothing would silently
 * decide that no bead is live and sweep past every merged pull request in the window,
 * reporting a clean tick. `null` means "do not gate", which costs one expensive sweep
 * and cannot cost a missed close.
 *
 * Asked once per sweep for the same reason `deliveryCards` is: `bd` here is a subprocess
 * and a Dolt read, and the whole point is to pay for one of those instead of hundreds.
 */
async function liveBeads(bd, ws) {
  try {
    const rows = await bd.listLive(ws);
    const ids = new Set();
    for (const b of rows || []) if (b?.id) ids.add(String(b.id).toLowerCase());
    return ids;
  } catch {
    return null;
  }
}

/**
 * Could this pull request close anything at all, without asking `bd` about it?
 *
 * `candidateTiers` is pure — it reads the title, the branch and the body and never
 * touches the tracker — so every id this pull request could possibly resolve to is
 * knowable for free. If none of them is a bead that is currently open, then whatever
 * `beadsFor` would return is either closed or does not exist, and the loop below would
 * write nothing either way. Skipping is not an optimisation of the *answer*, it is the
 * same answer reached without spawning three subprocesses to hear it.
 *
 * Note it is deliberately generous: it flattens the tiers rather than respecting them.
 * A row whose strongest tier names a closed bead and whose weakest names an open one is
 * let through, and `beadsFor` then applies the tiering exactly as it always did and
 * returns the closed one. One wasted `bd show` on a rare shape is the right price for a
 * gate that can never change what the sweep decides.
 */
function couldCloseSomething(row, prefix, live) {
  if (!live) return true;
  for (const tier of candidateTiers(row, prefix)) for (const id of tier) if (live.has(id)) return true;
  return false;
}

/** What the bead is told, and what `bd show` will print about it months later. */
export function landedNote(row, base) {
  const sha = String(row.mergeCommit || '').slice(0, 8);
  return (
    `## Landed as [#${row.number}](${row.url})\n\n` +
    `Merged into \`${base}\`${sha ? ` as \`${sha}\`` : ''} on GitHub rather than from a delivery card, ` +
    `so nothing in beadcause closed this at the time. Closed by the advocate's sweep, which is ` +
    `also what stops a session being opened on work that is already in ${base}.`
  );
}

/** The close reason. Deliberately says where the merge happened; see lib/advocate.js. */
export function landedReason(row, base) {
  const sha = String(row.mergeCommit || '').slice(0, 8);
  return `Merged #${row.number}${sha ? ` as ${sha}` : ''} into ${base} on GitHub`;
}

/**
 * Sweep one repo. Returns what it closed and what it deliberately did not.
 *
 * `rows` exists for the tests and for a caller that has already asked GitHub this
 * minute; everything else leaves it alone and pays for the window (`pr.listMergedSince`,
 * usually one query), one `bd list` for the cards and one for the live beads.
 */
export async function reconcileLanded(bd, ws, dir, { base = 'main', limit = PAGE_LIMIT, rows = null, now = Date.now() } = {}) {
  const out = { ok: false, reason: '', checked: 0, closed: [], cards: [], skipped: [], truncated: null };

  const gh = await pr.available();
  if (!gh.ok) {
    out.reason = gh.reason;
    return out;
  }

  const cutoff = now - RECENT_DAYS * 86400000;
  let merged = rows;
  // Set only when this asked GitHub itself. An injected list is the caller's window and
  // not this function's, so its reach is judged by the old evidence further down: a list
  // that came back full and never reached the cutoff was decided by its own cap.
  let covered = null;
  let reachedCap = limit;
  if (!merged) {
    try {
      const fetched = await pr.listMergedSince(dir, { since: cutoff, until: now, limit, maxRows: MAX_ROWS });
      merged = fetched.rows;
      covered = fetched.complete;
      if (fetched.cap) reachedCap = fetched.cap;
    } catch (err) {
      out.reason = `gh pr list failed — ${String(err.message || err).split('\n')[0]}`;
      return out;
    }
  }

  const prefix = await prefixFor(bd, ws);
  if (!prefix) {
    // Every candidate id is built from the prefix, so without one there is nothing to
    // match and nothing to say. A tracker mid-write is the ordinary cause.
    out.reason = `cannot read an id prefix for ${ws.name}`;
    return out;
  }

  out.ok = true;
  const seen = new Map();
  const cards = await deliveryCards(bd, ws);
  const live = await liveBeads(bd, ws);
  let aged = 0;
  let oldest = null;

  for (const row of merged || []) {
    if (String(row.state || '').toUpperCase() !== 'MERGED') continue;
    if (row.mergedAt) oldest = row.mergedAt;
    // Aged out rather than dropped silently: an old merged PR whose bead is still open
    // is a different problem from the one this exists for, and the count travels back
    // so the caller can say how many it did not look at.
    if (row.mergedAt && new Date(row.mergedAt).getTime() < cutoff) {
      aged += 1;
      out.skipped.push({ number: row.number, why: `merged more than ${RECENT_DAYS} days ago` });
      continue;
    }
    out.checked += 1;

    // The questions first — see rule 3, for both halves of it. *Before* the beads,
    // because a card is what blocks the bead behind it and bd refuses that close while
    // it is open; and *outside* their loop, because a merged pull request with no bead
    // left open behind it is precisely where the card used to strand. A failure here is
    // worth reporting and is not worth abandoning the closes below for: the worst case
    // is a stale card, and a bead close will simply refuse if the dependency is really
    // what blocks it.
    const questions = [];
    for (const q of cards.get(Number(row.number)) || []) {
      try {
        await bd.close(ws, q, `Merged #${row.number} on GitHub before this was answered`);
        questions.push(q);
        out.cards.push({ id: q, number: row.number, url: row.url });
      } catch (err) {
        out.skipped.push({ id: q, number: row.number, why: `could not close the delivery question — ${String(err.message || err).split('\n')[0]}` });
      }
    }

    // And now the gate that lets the window be a fortnight at all. Every id this row
    // could resolve to is readable from the row itself; if not one of them is a bead
    // that is currently open, `beadsFor` can only come back with closed beads or with
    // nothing, and the loop under it would write nothing either way. So it is skipped
    // here instead — silently, because "a merged pull request whose beads are closed"
    // is not a state anybody needs telling about, and on a fortnight of merges it is
    // very nearly all of them. See `couldCloseSomething`.
    if (!couldCloseSomething(row, prefix, live)) continue;

    for (const bead of await beadsFor(bd, ws, prefix, row, seen)) {
      if (String(bead.status || '').toLowerCase() === 'closed') continue;
      if (await alreadyLanded(bd, ws, bead.id, row.number)) {
        out.skipped.push({ id: bead.id, number: row.number, why: 'it was closed on this PR once and reopened' });
        continue;
      }

      // Asked *before* the comment is written, and that order is the whole reason the
      // gate is consulted at all here. A comment saying "Landed as #42" on a bead the
      // close then refused would satisfy `alreadyLanded` on every future sweep — one
      // transient refusal would blind this to that bead permanently. `closeGate` writes
      // nothing and costs one `bd show`; see lib/bd.js for what it knows.
      //
      // `closeGate` answers `null` or an **object** — `{ kind, blockers, reason }` — and
      // the sentence is on `.reason`, which is how lib/server.js and lib/owed.js read it.
      // This file used to interpolate the object, so the one line the advocate prints
      // about a bead it could not close read `left bc-goo open — [object Object]`. A dry
      // run over the real fortnight hit it twelve times in one tick: every skip the
      // sweep reported was unreadable, which is a close cousin of not reporting it.
      let gate = null;
      try {
        gate = await bd.closeGate(ws, bead.id);
      } catch (err) {
        gate = `could not ask whether it can be closed — ${String(err.message || err).split('\n')[0]}`;
      }
      if (gate) {
        const why = typeof gate === 'string' ? gate : gate.reason || 'bd would refuse to close it';
        out.skipped.push({ id: bead.id, number: row.number, why });
        continue;
      }

      try {
        await bd.comment(ws, bead.id, landedNote(row, base));
      } catch {
        // The comment is the record and the close is the claim. A tracker that took
        // one and not the other should still make the claim — an open bead is what
        // costs a session, and a missing comment costs a sentence.
      }
      try {
        await bd.close(ws, bead.id, landedReason(row, base));
        out.closed.push({ id: bead.id, title: bead.title || '', number: row.number, url: row.url, sha: row.mergeCommit || '', questions });
      } catch (err) {
        out.skipped.push({ id: bead.id, number: row.number, why: `could not close it — ${String(err.message || err).split('\n')[0]}` });
      }
    }
  }

  // The window closed under us, and that is the one failure this sweep cannot see from
  // the inside. Everything older than the oldest row it saw is then not merely unswept
  // this tick — it is unswept for good, because the next tick asks about a window that
  // has moved further forward. bc-8ug and bc-jin are what fell through it. Nothing is
  // guessed and nothing extra is asked for: this is a report, and what to do about it
  // belongs to whoever reads it.
  //
  // Two ways to know, because there are two ways in. When this asked GitHub itself,
  // `pr.listMergedSince` knows outright whether it covered the span it was given —
  // `MAX_ROWS`, or a slice too narrow to halve. When the rows were handed in, that is
  // the caller's window and the only evidence available is the shape of the list: full
  // to its limit and never reaching the cutoff means the limit decided.
  const short = covered === null ? (merged || []).length >= limit && aged === 0 : !covered;
  if (short && oldest) {
    out.truncated = { limit: reachedCap, oldest, days: Math.max(0, Math.round((now - new Date(oldest).getTime()) / 86400000)) };
  }

  return out;
}

/**
 * One line for the log and the card. Empty when the sweep did nothing worth saying.
 *
 * Cards get their own clause rather than being folded into the bead count, because they
 * are the half that can now happen *alone*: a merged pull request with nothing open
 * behind it closes a card and no bead, and a summary that only counted beads would say
 * nothing at all about the tick that finally cleared the phone.
 */
export function describeLanded(result) {
  if (!result.ok) return result.reason ? `landed sweep skipped — ${result.reason}` : '';
  const cards = result.cards || [];
  const parts = [];
  if (result.closed.length) {
    const named = result.closed.map((c) => `${c.id} (#${c.number})`).join(', ');
    parts.push(`closed ${result.closed.length} bead${result.closed.length === 1 ? '' : 's'} merged on GitHub — ${named}`);
  }
  if (cards.length) {
    const named = cards.map((c) => `${c.id} (#${c.number})`).join(', ');
    parts.push(
      `${parts.length ? 'and ' : 'closed '}${cards.length} stale delivery card${cards.length === 1 ? '' : 's'}${parts.length ? '' : ' for a pull request already merged'} — ${named}`
    );
  }
  if (result.truncated && parts.length) parts.push(describeTruncation(result.truncated));
  return parts.join(', ');
}

/**
 * How far back the sweep actually reached, when the cap decided it and not the cutoff.
 *
 * Its own export because it belongs on two different clocks. `describeLanded` says what
 * one tick did and is written whenever a tick did something; this is a standing state —
 * true every ten minutes until the repo quietens down or the cap moves — so the caller
 * that logs it should log it when it *changes*, not when it holds. See lib/advocate.js.
 */
export function describeTruncation(t) {
  if (!t) return '';
  const reach = t.days <= 0 ? 'less than a day back' : `${t.days} day${t.days === 1 ? '' : 's'} back`;
  return (
    `the query cap of ${t.limit} was reached before the ${RECENT_DAYS}-day window — ` +
    `nothing merged earlier than ${String(t.oldest).slice(0, 10)} (${reach}) was looked at, ` +
    `and nothing will look at it later either`
  );
}

/** For the tests, and for anything that wants to state the window rather than assume it. */
export const windowDays = () => RECENT_DAYS;
