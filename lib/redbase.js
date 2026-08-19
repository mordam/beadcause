/**
 * The red-base runbook — hold the merge queue while the base is failing, and drive the fix.
 *
 * bc-arf8. Adam's rule, written down on 2026-08-17 after doing it by hand: *when main's
 * CI fails, hold the merge worker, file a P0 for the failure, open a session on it
 * immediately, and once the fix is merged close the P0 and resume the merge worker.*
 * This module is the decision half of that; lib/server.js is the hand.
 *
 * ## Why this is not a contradiction of `newlyFailing`
 *
 * lib/mergeadvocate.js merges *over* a check the base is already failing, deliberately
 * (bc-y738): a check red on the base is red on every branch cut from it and says nothing
 * about this branch, so counting it would be a queue that merges nothing. That is right
 * in the small and wrong in the large. On 2026-08-17 `main` was red from 13:49 and ten
 * merges landed on top of it, every one inheriting the red, because the gate asked *is
 * this branch's fault* and nothing at all asked *is the base broken*. The gate's own
 * comment names the hazard — "bc-f31f is precisely the kind of red that stops being
 * noticed once something routes around it".
 *
 * So the two halves are: **keep merging over a red base, but only while somebody is
 * actively fixing it.** `newlyFailing` is unchanged and stays the per-branch rule; this
 * is a standing condition about the base, and while it holds the queue lands nothing.
 *
 * ## The deadlock, which is the whole design constraint
 *
 * The fix's own pull request has to merge *while the hold is on*. A hold that stopped
 * that would wedge the repo: the base stays red, the hold stays on, and the only way out
 * is a person. So the bead the fix is delivered under is exempt — `exemptFrom` below —
 * and everything else waits. A fix that lands under some *other* bead is still one tap
 * away on the pull request board, because the hold lives inside the queue and touches
 * none of the three doors a person merges through.
 *
 * ## Why the hold is derived and not stored
 *
 * There is no record in CONFIG_DIR and there is deliberately not going to be one. The
 * hold is exactly "GitHub says this base is failing **and** there is an open bead about
 * it", both of which are readings taken this tick — the argument `queueFor` in
 * lib/mergeadvocate.js already makes about the queue itself, and the one lib/sweepcard.js
 * learned the hard way (bc-xl7n.35: eight of thirteen cards outlived the record that was
 * supposed to find them again, after which nothing could amend or close them). The bead
 * is found by its own title and its own label, so a daemon that restarts, a record that
 * is lost and a bead somebody retitled all degrade the same way: the next tick files a
 * fresh one rather than losing the ability to say anything.
 *
 * **Which makes the title load-bearing.** `holdTitle` is the key. Retitle the bead by
 * hand and this stops recognising it, files a second, and holds against that instead —
 * which is why the body says so in the bead itself.
 */

/**
 * The label every hold bead carries — its provenance, and what makes the search cheap.
 *
 * A label rather than a title match alone because the title is a sentence a person might
 * reasonably improve; the pair is what `findHold` asks for, so a retitled bead is still
 * *visible* as one of these even where it is no longer matched. It is deliberately not in
 * `QUEUE_EXCLUDED` (lib/advocate.js): a hold bead is ordinary P0 work and the workspace
 * advocate picking it up is a second door onto the fix, not a mistake.
 */
export const RED_BASE_LABEL = 'red-base';

/**
 * Priority zero, and it is the one number here that is not a preference.
 *
 * Everything else in the tracker is waiting behind this: a red base makes every branch
 * in the repo unmergeable by the queue, so a P1 that sorted below somebody's feature
 * would be a bead that describes the reason nothing else can land while being scheduled
 * after it. It is also what makes the bead a *root* — `isRoot` in lib/underroot.js is
 * `isP0 || isEpic` — which is what lets `openWorkSession` dispatch it with no parent to
 * find, on a tracker where homing is the slow part.
 */
export const HOLD_PRIORITY = 0;

const line = (err) => String(err?.message || err).split('\n')[0];
const names = (list) => [...new Set((list || []).map((s) => String(s || '').trim()).filter(Boolean))];

/** The names of the failing checks, in one clause, capped like every other list here. */
const named = (failed) => {
  const all = names(failed);
  if (!all.length) return '';
  const shown = all.slice(0, 6);
  return `${shown.join(', ')}${all.length > shown.length ? `, and ${all.length - shown.length} more` : ''}`;
};

/**
 * The bead's title, which is also the key this whole module is found by.
 *
 * `key` is the *unit* — a workspace name where a workspace is one repo, `workspace/repo`
 * where it is forty — and not the workspace, because "main is red" is a fact about a
 * repository. A workspace of forty checkouts has forty independent answers and one bead
 * per workspace would hold thirty-nine repos over the fortieth's broken test.
 *
 * The base is in it for the same reason: deluvia lands on `atlas/public-launch`, so a
 * title naming `main` would be a bead about a branch that workspace never merges into.
 */
export function holdTitle(key, base = 'main') {
  return `\`${String(base || 'main')}\` is red in ${String(key || 'this repo')} — the merge queue is holding`;
}

/** Is this row one of these? The label, which is the half a retitle cannot take off. */
export function isHoldBead(issue) {
  return (issue?.labels || []).some((l) => String(l).trim().toLowerCase() === RED_BASE_LABEL);
}

/**
 * The open hold bead for one base, out of whatever rows are in hand.
 *
 * Takes rows rather than a tracker so the caller can hand it the `bd.graph` index that is
 * already warm — one `bd export` per workspace per minute, kept hot by the epic board and
 * lib/homing.js, carrying `title`, `labels` and `status` and therefore carrying exactly
 * this question's answer for free. See `anyQueued` in lib/mergeadvocate.js for the same
 * trade made about the queue.
 *
 * Closed rows are skipped rather than remembered, and that is the automatic half of the
 * runbook: a hold bead the merge of its own fix closed is gone, so the hold is gone with
 * it and nothing has to be told to lift.
 */
export function findHold(rows, { key, base = 'main' } = {}) {
  const want = holdTitle(key, base);
  const list = rows instanceof Map ? [...rows.values()] : Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (String(row?.status || '').toLowerCase() === 'closed') continue;
    if (!isHoldBead(row)) continue;
    if (String(row?.title || '').trim() !== want) continue;
    return row;
  }
  return null;
}

/**
 * What this tick should do about one base — the whole decision, as a pure function of
 * what GitHub said and what the tracker holds.
 *
 * Four acts, and the two that do nothing are as deliberate as the two that do:
 *
 * - **`file`** — the base is failing and nothing is open about it. File the P0, open a
 *   session on it. This is the only act that starts anything.
 * - **`hold`** — failing, and the bead is already there. Nothing to write. This is the
 *   steady state and it must stay silent: a tick every thirty seconds that commented,
 *   amended or re-notified would make a broken afternoon unreadable.
 * - **`clear`** — the base is green again and the bead is still open. Close it.
 * - **`none`** — everything else.
 *
 * **Unknown is never red, and never green.** `baseChecks` in lib/pr.js returns `null`
 * when it could not ask GitHub — a rate limit, a token, a network — and both readings of
 * that are wrong in a way that costs something real: as *red* it files a P0 and opens an
 * unattended window over a GitHub outage, and as *green* it lifts a live hold and closes
 * a P0 somebody is working. So unknown does neither, which leaves the hold exactly as it
 * found it and asks again next tick. Note this is the opposite direction to `gateVerdict`,
 * which falls back to the strict rule on an unknown baseline — and it is the same
 * principle both times: the safe direction is the one that does not merge and does not
 * decide.
 *
 * **Pending is not green either.** `main`'s checks re-run on every merge, so a base with
 * a run in flight is a base nobody knows about yet; clearing on it would lift the hold
 * for the two minutes between a push and its first red check, every single time.
 */
export function baseVerdict({ baseline = null, open = null } = {}) {
  const failed = names(baseline?.failed);
  const state = String(baseline?.state || '').toLowerCase();

  if (!baseline || !state || state === 'pending') {
    return { red: false, unknown: true, failed, act: 'none' };
  }
  if (state === 'failing' || failed.length) {
    return { red: true, unknown: false, failed, act: open ? 'hold' : 'file' };
  }
  return { red: false, unknown: false, failed: [], act: open ? 'clear' : 'none' };
}

/**
 * Is this merge-bead exempt from the hold?
 *
 * The deadlock, in one predicate: the work bead the hold was filed as *is* the fix, so a
 * pull request delivered under it is the one thing that must still go through. Everything
 * else in the queue is a branch that would land on a base nobody can vouch for.
 *
 * **Only the bead itself, not its descendants**, and that is a choice rather than an
 * omission. Walking down would mean a graph read on a path that is already asking GitHub
 * about every queued pull request, to widen an exemption whose whole purpose is to be
 * narrow — and the escape it would buy is already there and cheaper: a fix that landed
 * under some other bead is one tap on the pull request board, which the hold does not
 * touch. The bead's own body says so, because that is where somebody looking at a held
 * queue will read it.
 */
export function exemptFrom(hold, spec) {
  if (!hold?.bead) return false;
  return String(spec?.bead || '').trim() === String(hold.bead).trim();
}

/**
 * The one sentence a held pull request carries, in the vocabulary of what actually
 * stopped it.
 *
 * Written once here because it is read in three places — the queue's log line, the state
 * block on the merge-bead, and the queue's line on the advocate card — and three copies
 * is how two of them stop agreeing. It names the bead, because the only useful thing a
 * person can do about a held pull request is go and look at what is holding it.
 */
export function holdRefusal(hold) {
  const base = String(hold?.base || 'main');
  const list = named(hold?.failed);
  return (
    `\`${base}\` is red${list ? ` (${list})` : ''}, so the merge queue is holding rather than landing anything on top of it` +
    `${hold?.bead ? ` — ${hold.bead} is the fix` : ''}.`
  );
}

/**
 * The bead. P0, typed as a bug, and written for the session that is about to be opened on
 * it rather than for a reader browsing the tracker.
 *
 * Three things it has to say that nothing else will:
 *
 * 1. **What is actually failing**, by name, as GitHub reported it this minute — a session
 *    opened on "main is red" with no names spends its first ten minutes finding out.
 * 2. **That the queue is holding because of it**, which is the part that makes it a P0
 *    rather than a chore: every other branch in the repo is waiting behind this bead.
 * 3. **How to get out from under it**, both ways — deliver the fix under this bead, or
 *    merge from the board if it lands under another one.
 *
 * The stamp is UTC with an explicit `Z`, for lib/notinmain.js's reason: a reading taken
 * at an instant sits in a tracker for days, and every card and brief around it talks ADT.
 */
export function holdBody({ key, base = 'main', failed = [], at = '', url = '' } = {}) {
  const list = named(failed) || 'checks GitHub did not name';
  return [
    `\`${base}\` is failing its checks in **${key}**, so **the beadcause merge queue is holding**: nothing else ` +
      `will land on this base until this is fixed.`,
    '',
    `**Failing as of ${at || 'this reading'}:** ${list}`,
    url ? `\n${url}` : '',
    '',
    `**Why the queue stopped rather than merging over it.** The gate normally merges over a check the base is ` +
      `already failing — a check red on the base is red on every branch cut from it and says nothing about the ` +
      `branch (bc-y738). That is right per branch and wrong as a standing condition: it is how ten pull requests ` +
      `landed on a red \`main\` on 2026-08-17, each inheriting the red. So the queue keeps that rule and adds ` +
      `this one — merge over a red base only while somebody is fixing it. You are that somebody.`,
    '',
    `**What to do.** Find out what broke it, fix it, and deliver **under this bead**. A pull request whose work ` +
      `bead is this one is the single exemption from the hold, so it merges through the queue exactly as usual. ` +
      `If the fix lands under a different bead instead, that pull request is still one tap away on the pull ` +
      `request board — the hold lives inside the queue and does not touch the buttons.`,
    '',
    `**This bead closes itself.** The next tick that finds \`${base}\` green again closes it and the hold lifts. ` +
      `Nothing has to be resumed by hand. Do not retitle it: the queue finds this bead by its exact title, and a ` +
      `retitled one is a hold nothing can lift and a second bead on the next tick.`,
  ]
    .filter((line) => line !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** What the bead is done when it is done. Deliberately about the base, not about a diff. */
export function holdAcceptance(base = 'main') {
  return (
    `\`${base}\` is green on GitHub again. The merge queue lifts its hold and closes this bead on the tick that ` +
    `sees it, so nothing here is finished by a commit — it is finished by the base passing.`
  );
}

/** The close reason, when the base comes back. Names what is green, because a bare "fixed" is unauditable. */
export function clearReason(base = 'main', at = '') {
  return (
    `\`${base}\` is green again${at ? ` as of ${at}` : ''}, so the merge queue has lifted its hold. ` +
    `Closed by beadcause — this bead is a standing condition, and the condition is over.`
  );
}

/** The bead, as `Bd.create` takes one. Built here so the daemon's filer is three lines. */
export function holdIssue({ key, base = 'main', failed = [], at = '', url = '' } = {}) {
  return {
    title: holdTitle(key, base),
    type: 'bug',
    priority: HOLD_PRIORITY,
    body: holdBody({ key, base, failed, at, url }),
    acceptance: holdAcceptance(base),
    /**
     * No `unendorsed`, and it is the one place in this repo where an agent-filed bead
     * deliberately arrives workable.
     *
     * The hold is Adam's own written rule (bc-arf8) applied to a fact GitHub reported,
     * not a discovery an agent made and would like permission to pursue — and the marker
     * exists to put *that* in front of a person before a window opens. Holding this one
     * behind a tap would leave the queue stopped until somebody looked at their phone,
     * which is precisely the human in the loop the bead exists to remove.
     */
    labels: [RED_BASE_LABEL],
  };
}

/**
 * One base, one tick: read, decide, and do the one thing the decision asks for.
 *
 * Everything effectful arrives as an argument, for `sweepMergeQueue`'s reason in
 * lib/mergequeue.js: what is under test is a procedure that files a P0 and opens an
 * unattended window on this Mac, and a test must be able to drive every branch of it
 * without GitHub, a tracker or iTerm. lib/server.js is then a handful of adapters onto
 * doors that already exist.
 *
 * - `checks()` — the base's own check rollup, or `null` for a GitHub that would not
 *   answer. `pr.baseChecks`.
 * - `rows()` — whatever the open beads of this workspace are, for `findHold`, or `null`
 *   for a tracker that could not be asked. The `bd.graph` index carries `title`, `labels`
 *   and `status` and is already warm, so this costs nothing in a running daemon.
 * - `file(issue)` — `bd.create`, answering the new id.
 * - `close(id, reason)` — the close that lifts the hold.
 * - `settle()` — whatever cached `rows()` needs telling that it just changed. Without it
 *   a P0 filed thirty seconds ago is invisible to the next tick and a second one is filed
 *   on top of it.
 * - `announce(id)` — the bus event, so a parked phone finds out. On the change only, for
 *   lib/sync.js's reason: a base red for an hour must not wake every device every tick.
 * - `open(id)` — the window on the fix. Every refusal belongs to the caller, because the
 *   caller is what knows about sessions.
 *
 * `last` is what this process knew a tick ago and it is a *fallback*, never the source:
 * a reading that failed leaves the hold exactly as it found it rather than lifting it,
 * which is the direction that costs a wait rather than a bad merge. See the header.
 *
 * Returns `{ hold, act, id }` — `hold` is what lib/mergequeue.js consults, and `null`
 * means nothing is holding this base.
 */
export async function sweepBase({ key, base = 'main', last = null } = {}, {
  checks,
  rows,
  file,
  close,
  settle = null,
  announce = null,
  open = null,
  log = () => {},
} = {}) {
  const at = new Date().toISOString();
  const baseline = await checks().catch(() => null);
  const known = await rows().catch(() => null);

  // A tracker that could not be asked cannot answer "is there already a bead about this",
  // and both wrong answers cost something real: a second P0 with a second window behind
  // it, or a hold lifted over an outage. So it decides nothing and keeps what it knows.
  if (!known) return { hold: last, act: 'unknown', id: last?.bead || '' };

  const open_ = findHold(known, { key, base });
  const verdict = baseVerdict({ baseline, open: open_ });

  if (verdict.act === 'file') {
    let id = '';
    try {
      id = await file(holdIssue({ key, base, failed: verdict.failed, at }));
    } catch (err) {
      log(`could not file the P0 for a red ${base} in ${key} — ${line(err)}`);
      return { hold: last, act: 'unknown', id: last?.bead || '' };
    }
    const hold = { bead: id, key, base, failed: verdict.failed };
    log(`${base} is red in ${key} (${verdict.failed.join(', ')}) — filed ${id}, and the merge queue is holding`);
    if (settle) await settle().catch(() => {});
    if (announce) announce(id);
    if (open) await open(id).catch(() => {});
    return { hold, act: 'file', id };
  }

  if (verdict.act === 'clear') {
    try {
      await close(open_.id, clearReason(base, at));
    } catch (err) {
      // A close bd refused leaves the bead open, so the hold stays on — the safe
      // direction, and the next tick tries again. Said out loud, because a hold that will
      // not lift is exactly the thing nobody would think to go looking for.
      log(`${base} is green again in ${key} but ${open_.id} would not close — ${line(err)}`);
      return { hold: { bead: open_.id, key, base, failed: last?.failed || [] }, act: 'stuck', id: open_.id };
    }
    log(`${base} is green again in ${key} — closed ${open_.id}, and the hold is off`);
    if (settle) await settle().catch(() => {});
    if (announce) announce(open_.id);
    return { hold: null, act: 'clear', id: open_.id };
  }

  if (!open_) return { hold: null, act: 'none', id: '' };

  /**
   * `hold`, and the unknown half of `none`. Two things happen on the steady state and
   * neither of them writes: the failing names are carried forward from the last real
   * reading, so a held pull request still names checks during an outage; and the window
   * is offered again, because a session that exited without fixing the base leaves a P0
   * nobody is on and the runbook's whole promise is that somebody always is. Every
   * refusal in `open` is cheap and none of them writes anything.
   */
  const hold = { bead: open_.id, key, base, failed: verdict.failed.length ? verdict.failed : last?.failed || [] };
  if (open) await open(open_.id).catch(() => {});
  return { hold, act: verdict.act, id: open_.id };
}
