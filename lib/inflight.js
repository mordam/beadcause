/**
 * The bead whose work is already sitting in an open pull request.
 *
 * The other half of bc-utyr, and the more expensive half. On 2026-08-11 the advocate
 * opened a worker on bc-dmt while #115 — the pull request that *was* bc-dmt, built and
 * delivered by the previous attempt — was open, conflicting, and had two sessions on it
 * resolving the conflict. There was nothing for a worker to do, and worse than nothing:
 * the two briefs disagree about who merges. A worker's brief says to run
 * `bin/deliver.js`, which **merges**; a resolver's says outright that the merge is a tap
 * on the phone and is not its to make. Two briefs disagreeing about that is how a branch
 * gets merged out from under a review that had not finished.
 *
 * So: **an open pull request is work in flight, and the bead it carries is not ready.**
 *
 * ## Why this closes nothing and holds instead
 *
 * lib/landed.js is the near relative and it *closes*, because `state: MERGED` is proof
 * the work is in the base branch and there is nothing left to want. `state: OPEN` proves
 * something weaker and more useful: the work **exists**, on a branch, and what happens to
 * it next is a merge, a review, or a conflict resolution — none of which is a fresh
 * session's job. The bead is not done, so it must not be closed; it is also not *ready*,
 * so it must not get a window. Held is the only honest third thing, and held is what
 * `withoutTwins` already does one filter along in lib/advocate.js.
 *
 * ## Which way this errs, and why it is the opposite of the twin filter
 *
 * `withoutTwins` says outright that it must err toward doing the work twice rather than
 * not at all, because its evidence is a *title comparison* — two beads that read alike
 * may be two jobs. This one errs the other way, and the difference is the evidence: a
 * pull request naming a bead is not a resemblance, it is a branch with commits on it.
 * The cost of a wrong hold is one bead that waits, said out loud on the advocate's card
 * with the pull request number on it, until the PR merges or is closed — both of which
 * happen on their own. The cost of a wrong launch is the incident above.
 *
 * A bead that genuinely wants more than its open PR delivers is the case this is
 * unfair to, and it is deliberately unfair to it: the fix is to merge or close the pull
 * request, which is the thing that was going to have to happen anyway.
 *
 * ## What it deliberately does not catch
 *
 * **A draft pull request is still open**, and is still held. A draft is work on a branch
 * with somebody's intention attached; a second session writing the same feature beside
 * it is the same waste with a different label on it.
 *
 * **A pull request naming no bead holds nothing**, which is most hand-opened ones. There
 * is no bead to hold, and guessing one from the branch name is `beadsFor`'s job — it
 * already reads the delivery block, the title, the branch tag and the body's claims, in
 * that order, and verifies every candidate against the tracker before believing it.
 *
 * **`gh` that will not answer holds nothing back.** A network failure must not be able to
 * empty an advocate's queue, so the reason travels back and the caller keeps whatever it
 * knew before. That is the one place this errs toward the twin filter's direction, and it
 * has to: "I could not ask" is not evidence of anything.
 *
 * Nothing here closes, comments, merges, pushes or opens anything. It reads GitHub and
 * the tracker and returns a map, and every failure is a sentence in that map rather than
 * a throw — like every other sweep hanging off the advocate's tick, it may not take the
 * tick down with it.
 */
import { beadsFor, prefixFor } from './beadref.js';
import * as pr from './pr.js';

/** How many open pull requests to ask each repo about. A cap on the query. */
const QUERY_LIMIT = 40;

/**
 * Every bead an open pull request is carrying, indexed by id.
 *
 * `rows` exists for the tests and for a caller that has already asked GitHub this
 * minute; everything else leaves it alone and pays for one `gh pr list --state open`.
 *
 * The map's values are what a refusal has to be able to say — the number, the title and
 * the URL — because "held" with no way to see what it is held behind is the number you
 * have to go and check by hand, which is the thing lib/advocate.js's third rule is about.
 */
export async function openWork(bd, ws, dir, { limit = QUERY_LIMIT, rows = null } = {}) {
  const out = { ok: false, reason: '', checked: 0, beads: new Map() };

  const gh = await pr.available();
  if (!gh.ok) {
    out.reason = gh.reason;
    return out;
  }

  let open = rows;
  if (!open) {
    try {
      open = await pr.list(dir, { state: 'open', limit });
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
  for (const row of open || []) {
    // `--state open` is what was asked for, and this is not distrust of `gh` so much as
    // of the `rows` a caller may have handed in from a wider sweep: lib/prboard.js reads
    // `--state all`, and a merged pull request holding its bead out of the queue forever
    // is precisely the failure lib/landed.js exists to undo.
    if (String(row.state || '').toUpperCase() !== 'OPEN') continue;
    out.checked += 1;
    for (const bead of await beadsFor(bd, ws, prefix, row, seen)) {
      // First wins. Two open pull requests on one bead is a real state — bc-utyr's
      // sibling note records a bead that produced two full PRs — and the older one is
      // the one a sentence should name, because it is the one that has been waiting.
      if (out.beads.has(bead.id)) continue;
      out.beads.set(bead.id, {
        number: row.number,
        url: row.url || '',
        title: row.title || '',
        branch: row.branch || '',
        draft: Boolean(row.draft),
        mergeable: String(row.mergeable || '').toUpperCase(),
      });
    }
  }

  return out;
}

/**
 * Why this bead is not ready, in the words the card and the log use.
 *
 * The state of the pull request is in it, not just its number, because the three states
 * ask for three different things from whoever reads the card: a conflicting one wants
 * *Resolve conflicts*, a mergeable one wants a tap on the merge, and one GitHub has not
 * worked out yet wants nothing but a minute.
 */
export function inflightWhy(hit) {
  const state =
    hit.mergeable === 'CONFLICTING'
      ? 'and it conflicts with the base'
      : hit.mergeable === 'MERGEABLE'
        ? 'and it is waiting to be merged'
        : hit.draft
          ? 'and it is still a draft'
          : 'and it is open';
  return `#${hit.number} already carries this work ${state} — the branch is where it is, not a new session`;
}

/** One line for the log and the card. Empty when nothing is being held. */
export function describeInflight(result, held = []) {
  if (!result.ok) return result.reason ? `open-PR check skipped — ${result.reason}` : '';
  if (!held.length) return '';
  const named = held.map((h) => `${h.id} (#${h.number})`).join(', ');
  return `${held.length} bead${held.length === 1 ? '' : 's'} held behind an open pull request — ${named}`;
}
