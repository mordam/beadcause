import { shippedState } from './release.js';

/**
 * How far a pull request has got, as one word — and the only place that decides it.
 *
 * The facts were all here before this file was: `lib/pr.js` knows what GitHub says,
 * `lib/prboard.js` asks git whether the merge commit reached `origin/<base>` and
 * whether it is in the build this daemon booted from, and `lib/release.js` knows from
 * the deploy journal whether anything has been shipped since the merge. What none of
 * them had was a single ladder those facts climb, so the board sorted by one word, the
 * release queue counted by a second rule, and the inbox — which now draws pull requests
 * as cards (bc-l8jp.6) — would have needed a third. Three implementations of "where is
 * this PR" is how two screens come to disagree about the same pull request, which on
 * this subject is the whole failure: the reason the board exists is that "did it
 * actually ship?" must have one answer.
 *
 * So: one function, six rungs, and every screen reads `row.stage`.
 *
 * ## Why deployed and live are two rungs and not one
 *
 * They answer different questions and they go true at different times, which is the
 * same argument the board's three lamps are built on:
 *
 * - **deployed** — a deploy *ran* and carried this merge. That is the deploy journal's
 *   answer (`lib/deploy.js`, via `shippedState`): an `ok` record for this repo that
 *   started after the merge. It is the only answer available for a repo beadcause
 *   deploys but does not run — sophab goes out by `fly deploy`, and nothing on this Mac
 *   can then look at what is serving.
 * - **live** — it is in the build *this process is running*. Only beadcause can say
 *   that about itself, by ancestry against the commit it booted from, and it is the
 *   stronger claim: a deploy that ran is not proof that what came up is what went out.
 *
 * Collapsing them would mean either calling a `fly deploy` "live" (a claim nothing
 * here can check) or calling a merge that demonstrably is not running "deployed"
 * (which is the lie the board was written to stop). Six repos, one of which is the
 * daemon: both rungs are reachable in a real flow, which is the test.
 *
 * `closed` is on the table but off the ladder — closed without merging is not a rung
 * on the way anywhere, it is where a pull request stops. Which is why it is last in
 * `RANK` and why the inbox does not carry it at all (see public/inboxfilter.js): a
 * screen about work in flight should not be filled with work that was abandoned.
 */

/**
 * The ladder, in order, with what each rung means.
 *
 * The `note` is a real part of the payload rather than decoration: it is the title on
 * the lamp and the accessible name on the filter chip, and one word — "pushed" — is
 * not self-explanatory on either. public/prcard.js holds the same six ids with the
 * same labels, because a browser cannot import this file; `test/prstage.mjs` asserts
 * the two agree, which is the cheap version of sharing the table.
 */
export const STAGES = [
  {
    id: 'review',
    label: 'Review',
    note: 'Open on GitHub, waiting on a decision.',
  },
  {
    id: 'merged',
    label: 'Merged',
    note: 'Merged at GitHub. This Mac has not seen the merge commit on origin.',
  },
  {
    id: 'pushed',
    label: 'Pushed',
    note: 'On origin, and no deploy has carried it yet.',
  },
  {
    id: 'deployed',
    label: 'Deployed',
    note: 'A deploy ran that carried it. Whether what came up is what went out is not visible from here.',
  },
  {
    id: 'live',
    label: 'Live',
    note: 'In the build this daemon is running — the strongest answer there is, and only beadcause can give it about itself.',
  },
  {
    id: 'closed',
    label: 'Closed',
    note: 'Closed without merging. Not a rung on the way anywhere.',
  },
];

/** Every rung's id, in ladder order. */
export const STAGE_IDS = STAGES.map((s) => s.id);

/**
 * What you have to act on, first.
 *
 * A pull request waiting on a decision outranks one waiting on a deploy, which outranks
 * one that is done — and `closed` sinks below all of them because there is nothing to
 * do about it. The board sorts on this; it is here rather than in prboard.js so the
 * order and the words cannot be changed independently of each other.
 */
export const RANK = Object.fromEntries(STAGE_IDS.map((id, i) => [id, i]));

/**
 * Which rung this row is on.
 *
 * `deploys` is *this workspace's* deploy records, newest first — the same shape
 * `shippedState` takes, and the same journal `lib/release.js` counts the release queue
 * from. Passing none is not an error: it means nobody has read the journal, and the
 * ladder then stops at `pushed`, which is the honest answer rather than a guess in
 * either direction.
 *
 * Every branch is a fact somebody has already established. Nothing here re-derives
 * anything, and nothing here reaches for git or the network.
 */
export function stageOf(row, deploys = []) {
  if (!row) return 'review';
  if (row.state === 'CLOSED') return 'closed';
  if (row.state !== 'MERGED') return 'review';
  // The running build first, because it is the strongest claim and it makes the two
  // deploy rungs an order rather than a pair of overlapping flags.
  if (row.deployed === true) return 'live';
  // Not on origin as this Mac last looked — which includes the null case, where nobody
  // has looked at all. Neither is `pushed`, and neither is a deploy's fault.
  if (row.pushed !== true) return 'merged';
  return shippedState(row, deploys) === true ? 'deployed' : 'pushed';
}

/** The rung's row from the table, for a caller that wants the words. */
export const stageInfo = (id) => STAGES.find((s) => s.id === id) || null;
