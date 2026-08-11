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
 * 3. **The question closes before the work bead.** A delivery parks its bead behind the
 *    question with `bd dep add`, and bd will not close a bead with an open blocker — so
 *    the other order silently fails on exactly the case that most needs this: a worker
 *    that could not merge, a card in the inbox, and Adam merging from the pull request
 *    page instead of from the card. What bd would refuse is then asked outright, before
 *    a word is written, because of how rule 2 reads a comment this might have left.
 *
 * Nothing here merges, pushes, deploys or opens anything. It reads GitHub and writes two
 * kinds of line to the tracker, and every failure is a returned sentence rather than a
 * throw — a sweep is a courtesy on top of the advocate's tick, and it may not be able to
 * take the tick down with it.
 */
import { beadsFor, prefixFor } from './beadref.js';
import { parseDelivery, DELIVERY_LABEL } from './delivery.js';
import * as pr from './pr.js';

/** How many merged pull requests to ask each repo about. A cap on the query. */
const QUERY_LIMIT = 40;

/** And how far back to consider them, whatever the query returned. */
const RECENT_DAYS = 14;

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
 * The open delivery questions that are about this pull request.
 *
 * Read off the `beadpr` block rather than the title, because the block is the one place
 * in the codebase where a question states outright which PR it acts on — see
 * lib/delivery.js. Usually none and never more than one, but it returns a list: two
 * deliveries on one branch is a state the tracker permits and a sweep that closed only
 * the first would leave the other on the phone.
 */
async function questionsFor(bd, ws, number) {
  let open;
  try {
    open = await bd.listLabel(ws, DELIVERY_LABEL);
  } catch {
    return [];
  }
  const out = [];
  for (const q of open || []) {
    if (q.status === 'closed') continue;
    const d = parseDelivery([q.description, q.design, q.notes].filter(Boolean).join('\n\n'));
    if (d && !d.error && Number(d.number) === Number(number)) out.push(q.id);
  }
  return out;
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
 * minute; everything else leaves it alone and pays for one `gh pr list`.
 */
export async function reconcileLanded(bd, ws, dir, { base = 'main', limit = QUERY_LIMIT, rows = null, now = Date.now() } = {}) {
  const out = { ok: false, reason: '', checked: 0, closed: [], skipped: [] };

  const gh = await pr.available();
  if (!gh.ok) {
    out.reason = gh.reason;
    return out;
  }

  let merged = rows;
  if (!merged) {
    try {
      merged = await pr.list(dir, { state: 'merged', limit });
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
  const cutoff = now - RECENT_DAYS * 86400000;
  const seen = new Map();

  for (const row of merged || []) {
    if (String(row.state || '').toUpperCase() !== 'MERGED') continue;
    // Aged out rather than dropped silently: an old merged PR whose bead is still open
    // is a different problem from the one this exists for, and the count travels back
    // so the caller can say how many it did not look at.
    if (row.mergedAt && new Date(row.mergedAt).getTime() < cutoff) {
      out.skipped.push({ number: row.number, why: `merged more than ${RECENT_DAYS} days ago` });
      continue;
    }
    out.checked += 1;

    for (const bead of await beadsFor(bd, ws, prefix, row, seen)) {
      if (String(bead.status || '').toLowerCase() === 'closed') continue;
      if (await alreadyLanded(bd, ws, bead.id, row.number)) {
        out.skipped.push({ id: bead.id, number: row.number, why: 'it was closed on this PR once and reopened' });
        continue;
      }

      // The question first — see rule 3. A failure here is worth reporting and is not
      // worth abandoning the close for: the worst case is a stale card, and the bead
      // close below will simply refuse if the dependency really is what blocks it.
      const questions = await questionsFor(bd, ws, row.number);
      for (const q of questions) {
        try {
          await bd.close(ws, q, `Merged #${row.number} on GitHub before this was answered`);
        } catch (err) {
          out.skipped.push({ id: q, number: row.number, why: `could not close the delivery question — ${String(err.message || err).split('\n')[0]}` });
        }
      }

      // Asked *before* the comment is written, and that order is the whole reason the
      // gate is consulted at all here. A comment saying "Landed as #42" on a bead the
      // close then refused would satisfy `alreadyLanded` on every future sweep — one
      // transient refusal would blind this to that bead permanently. `closeGate` writes
      // nothing and costs one `bd show`; see lib/bd.js for what it knows.
      let gate = null;
      try {
        gate = await bd.closeGate(ws, bead.id);
      } catch (err) {
        gate = `could not ask whether it can be closed — ${String(err.message || err).split('\n')[0]}`;
      }
      if (gate) {
        out.skipped.push({ id: bead.id, number: row.number, why: gate });
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

  return out;
}

/** One line for the log and the card. Empty when the sweep did nothing worth saying. */
export function describeLanded(result) {
  if (!result.ok) return result.reason ? `landed sweep skipped — ${result.reason}` : '';
  if (!result.closed.length) return '';
  const named = result.closed.map((c) => `${c.id} (#${c.number})`).join(', ');
  return `closed ${result.closed.length} bead${result.closed.length === 1 ? '' : 's'} merged on GitHub — ${named}`;
}
