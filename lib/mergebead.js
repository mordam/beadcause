/**
 * The merge-bead — what a worker files instead of merging its own pull request.
 *
 * A worker's last act used to be the merge itself: `bin/deliver.js` pushed the branch,
 * opened the pull request, waited for its checks, merged it, and closed the work bead in
 * the same breath. That is one agent grading its own homework, and the cost was never
 * that it merged something wrong — it is that every judgement the worker *could not*
 * make became a card in Adam's inbox, and every judgement it could make was made with no
 * view of any other branch, no memory of the last five merges, and no way to fix what it
 * found.
 *
 * So the ending splits in two. The worker still pushes the branch and opens the pull
 * request; then it files one of these and stops. The MergeAdvocate (lib/mergeadvocate.js)
 * takes it from there: downmerge, gates, merge, and — when it lands — closes both beads.
 *
 * ## Two things on the bead, and they are different in kind
 *
 * **What it is about** is a `beadpr` block, and it is deliberately *the same block*
 * lib/delivery.js already writes on a delivery card: workspace, bead, repo, number, url,
 * branch, base, method, summary, tests, risk. Not a similar one — the same one, parsed by
 * the same `parseDelivery`, written by the same serialiser. Two carriers for one fact is
 * two things to rot, and this one has a specific way of rotting that would be invisible:
 * the failure path (lib/mergeadvocate.js) hands a refused merge to Adam as exactly the
 * delivery card the worker used to file, and it can only do that without re-deriving
 * anything if the merge-bead already carries the card's own block.
 *
 * **How it is going** is a separate marked block in `notes` — attempts, what refused it
 * last, the checks `main` was already failing when it merged. Separate because they have
 * opposite lifetimes: the `beadpr` block is written once and is true until the branch is
 * abandoned, and this one is rewritten every tick. Mixing them would mean rewriting the
 * identity of a pull request in order to record that its checks were slow.
 *
 * `notes` and not `design` for lib/epicadvocate.js's reason: notes survive a claim, a
 * reopen and a sync, `design` is the author's, and a `human` label would put the bead in
 * the inbox as a question — which it is not, until the failure path decides it is.
 *
 * ## One merge-bead per pull request
 *
 * Not one per delivery. `clearOpenCards` in bin/deliver.js exists because delivering
 * twice left two identical cards in the inbox, each one a blocker on the work bead's
 * close, and answering either was reported as having closed a bead that neither could
 * close. A merge-bead is a blocker on the work bead by construction — that is the whole
 * point of it — so the same pile in this shape is strictly worse. `openMergeBeadFor`
 * below is the finding half, and it matches the way `cardsForDelivery` does: on the pull
 * request *and* on the work bead, because a session that abandoned its branch and
 * delivered the same bead on a new one leaves the first merge-bead pointing at a pull
 * request nobody is ever going to merge.
 */
import YAML from 'yaml';
import { deliveryBlock, parseDelivery, slugOf } from './delivery.js';

/**
 * What marks a bead as a pull request waiting to be merged. Searchable:
 * `bd list --label=merge-queue`.
 *
 * A label rather than an issue type, because the type is what the close gate and the
 * board reason about and a merge-bead is an ordinary task in every one of those. And a
 * label rather than a title convention, because a title is the one field a human edits.
 */
export const MERGE_LABEL = 'merge-queue';

/**
 * Who a merge-bead is assigned to.
 *
 * Deliberately the same string as the agent kind id in lib/foundation.js's `BASELINES`
 * and `MERGE_ADVOCATE` in lib/mergeadvocate.js. It is not imported from either, because
 * this module is the leaf that both the filer (bin/deliver.js) and the advocate import,
 * and a cycle here is the one lib/agents.js already paid for once (bc-u4na). That the
 * three agree is pinned in test/mergebead.mjs rather than enforced by an import — an
 * assignee typo is a merge-bead nothing ever picks up and no error anywhere, which is
 * exactly the failure a test is for and a comment is not.
 */
export const MERGE_ASSIGNEE = 'merge-advocate';

/** Where the queue's own state lives inside `notes`, and how it finds it again. */
export const QUEUE_OPEN = '<!-- beadcause:merge -->';
export const QUEUE_CLOSE = '<!-- /beadcause:merge -->';

/**
 * How many times a merge-bead is retried before it stops being the queue's problem and
 * becomes Adam's.
 *
 * Three, and the number is doing real work rather than being round. The failures worth
 * retrying are the ones the world fixes on its own — a check that was still pending, a
 * flake, a base that moved under the merge — and every one of those is fixed or not
 * within a tick or two. Past that the retry is not waiting for anything; it is a queue
 * quietly re-running the same refusal forever, which from outside is indistinguishable
 * from the feature not working. See `raise` in lib/mergeadvocate.js for what happens
 * instead.
 */
export const MAX_ATTEMPTS = 3;

/** Is this row a merge-bead? Off the label, which is the only thing that says so. */
export const isMergeBead = (issue) =>
  (issue?.labels || []).some((l) => String(l).trim() === MERGE_LABEL);

/**
 * The whole of what a merge-bead is about, off the row the sweep already has.
 *
 * Every field the MergeAdvocate needs to act *without a worktree*, because by the time it
 * gets there the worker's worktree may well have been retired by lib/tidy.js. `null` when
 * the bead carries no block at all; `{ error }` when it carries one that will not parse,
 * which is `parseDelivery`'s own distinction and is kept rather than flattened: a block
 * that will not parse must not look like a bead with nothing behind it, or the queue
 * skips it in silence for the rest of its life.
 */
export function mergeSpec(issue) {
  const text = [issue?.description, issue?.design, issue?.notes].filter(Boolean).join('\n\n');
  return parseDelivery(text);
}

/**
 * The queue's own state — how many times this has been tried, and what happened.
 *
 * Defaults rather than nulls, because every caller wants a number to compare against
 * `MAX_ATTEMPTS` and a bead nothing has tried yet has been tried nought times. The one
 * field that stays null is `refused`: "nothing has refused this" and "something refused
 * it with an empty sentence" are different states, and the second is a bug worth seeing.
 */
export function queueState(issue) {
  const notes = String(issue?.notes || '');
  const from = notes.indexOf(QUEUE_OPEN);
  const empty = { attempts: 0, downmerges: 0, refused: null, at: null, baseline: [], resolving: false };
  if (from < 0) return empty;
  const to = notes.indexOf(QUEUE_CLOSE, from);
  const body = (to < 0 ? notes.slice(from + QUEUE_OPEN.length) : notes.slice(from + QUEUE_OPEN.length, to)).trim();
  if (!body) return empty;
  let raw;
  try {
    raw = YAML.parse(body);
  } catch {
    // A block a human edited into invalid YAML reads as a bead nothing has tried, which
    // is the safe direction: it costs one more attempt, where the alternative — treating
    // it as exhausted — silently strands the pull request.
    return empty;
  }
  if (!raw || typeof raw !== 'object') return empty;
  const attempts = Number(raw.attempts);
  const downmerges = Number(raw.downmerges);
  return {
    attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 0,
    /**
     * How many times the base has been brought into this branch.
     *
     * Counted apart from `attempts` because a downmerge is not a refusal: a branch that
     * has been rebuilt three times because `main` kept moving underneath it has been
     * unlucky about timing, and folding the two would hand it to Adam as one that could
     * not be merged. See `MAX_DOWNMERGES` in lib/mergequeue.js.
     */
    downmerges: Number.isInteger(downmerges) && downmerges > 0 ? downmerges : 0,
    refused: raw.refused ? String(raw.refused).trim() : null,
    at: raw.at ? String(raw.at) : null,
    /** The checks `main` was already failing — see `newlyFailing` in lib/mergeadvocate.js. */
    baseline: Array.isArray(raw.baseline) ? raw.baseline.map((s) => String(s)) : [],
    /** A resolver window is open on this one; the queue leaves it alone until it is not. */
    resolving: !!raw.resolving,
  };
}

/** The state block, as it goes into `notes`. */
export function queueBlock(state) {
  const out = { attempts: Number(state?.attempts) || 0 };
  if (state?.downmerges) out.downmerges = Number(state.downmerges);
  if (state?.refused) out.refused = String(state.refused).replace(/\s+/g, ' ').trim().slice(0, 400);
  if (state?.at) out.at = String(state.at);
  if (state?.baseline?.length) out.baseline = state.baseline.map((s) => String(s)).slice(0, 6);
  if (state?.resolving) out.resolving = true;
  return `${QUEUE_OPEN}\n${YAML.stringify(out).trimEnd()}\n${QUEUE_CLOSE}`;
}

/**
 * `notes` with the state block replaced — or added, if there was not one.
 *
 * A whole-field rewrite because bd has no way to edit part of a field, and the block is
 * cut out by its markers rather than by rewriting from scratch: anything else a human or
 * another agent wrote in `notes` survives, which is the reason the markers exist.
 */
export function withQueueBlock(notes, state) {
  const src = String(notes || '');
  const from = src.indexOf(QUEUE_OPEN);
  const block = queueBlock(state);
  if (from < 0) return src.trim() ? `${src.trimEnd()}\n\n${block}` : block;
  const to = src.indexOf(QUEUE_CLOSE, from);
  const tail = to < 0 ? '' : src.slice(to + QUEUE_CLOSE.length);
  return `${src.slice(0, from)}${block}${tail}`.trim();
}

/** A one-line title. The pull request first, because that is what the queue is a queue of. */
export function mergeBeadTitle(d) {
  const what = String(d?.title || d?.bead || '').trim();
  return `Merge #${d.number}${d.bead ? ` — ${d.bead}` : ''}${what && what !== d.bead ? `: ${what}` : ''}`.slice(0, 160);
}

/**
 * The body a worker files: what this is, what will happen to it, and the block.
 *
 * Written for a person who has opened it wondering why their work has not landed, which
 * is the only reason anyone reads one of these by hand. So it says what is waiting on
 * what, in the order it will happen, and it names the work bead — because the *first*
 * question is always "is my bead stuck, and on what".
 */
export function mergeBeadBody(d, { tests = '' } = {}) {
  const parts = [
    `**${d.repo || d.workspace}** — pull request [#${d.number}](${d.url}) is ready to merge, and the ` +
      `worker that wrote it does not merge it.`,
    '',
    `The merge queue takes it from here: it brings \`${d.base}\` into \`${d.branch}\`, checks whatever ` +
      `\`${d.base}\` is not already failing, merges, and closes **${d.bead}** and this bead together. ` +
      `Nothing is owed by the session that filed it.`,
  ].join('\n');

  const why = [
    `**${d.bead} depends on this bead**, which is what stops the worker closing its own work: the ` +
      'close gate refuses a bead with an open blocker, so the dependency is the rule rather than a ' +
      'sentence in a brief.',
  ].join('\n');

  const ran = tests ? `**What the worker ran:** ${String(tests).trim()}` : '';

  // Blocks, joined by a blank line, with the empty ones dropped — rather than a single
  // string with `\n\n` sprinkled through it. The difference shows up on the one bead that
  // has no `--tests`: the sprinkled version leaves a double gap where the sentence would
  // have been, which reads on a phone as something having failed to render.
  return [parts, why, ran, '_What the merge acts on, in the form the server reads it:_', deliveryBlock(d)]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The merge-bead already open for this work, if there is one — the half that stops a
 * re-delivery filing a second.
 *
 * Two ways to be the same merge, and both are needed, for exactly `cardsForDelivery`'s
 * reasons: the **pull request** (number and repo, since a number alone is unique only
 * within a repo), and the **work bead**, which the pull request alone misses when a
 * session abandoned its branch and delivered the same bead on a new one.
 *
 * Nothing is matched on wording, because the wording is what a re-delivery changes.
 */
export function openMergeBeadFor(rows, { repo = '', number, bead = null } = {}) {
  const n = Number(number);
  const wantNumber = Number.isInteger(n) && n > 0 ? n : null;
  const wantSlug = String(repo || '').trim().toLowerCase();
  const wantBead = String(bead || '').trim().toLowerCase() || null;
  if (!wantNumber && !wantBead) return [];

  const sameRequest = (d) => {
    if (!wantNumber || Number(d.number) !== wantNumber) return false;
    const slug = slugOf(d);
    return !slug || !wantSlug || slug === wantSlug;
  };
  const sameBead = (d) => !!wantBead && String(d.bead || '').trim().toLowerCase() === wantBead;

  return (rows || [])
    .filter((r) => r && r.id && r.status !== 'closed' && isMergeBead(r))
    .map((r) => ({ row: r, d: mergeSpec(r) }))
    .filter(({ d }) => d && !d.error && (sameRequest(d) || sameBead(d)))
    .map(({ row, d }) => ({ id: row.id, bead: d.bead || null, number: Number(d.number) || null, title: row.title || '' }));
}
