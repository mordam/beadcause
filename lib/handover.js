import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR } from './config.js';
import { writeJsonAtomic } from './atomic.js';

/**
 * What the router did at the moment the service changed hands — bc-khoe.8.
 *
 * The release ladder has seven rungs and three of them had nothing behind them: *deployed
 * to green*, *green verification* and *swapping to blue*. Every one of those three
 * happens, on this Mac, several times a day; none of them was written down anywhere. So
 * lib/queues.js drew them `untracked` — honest, and the honest answer was "nothing here
 * can see it".
 *
 * This is what can see it. `bin/router.js` spawns a backend on an internal port,
 * health-checks it, promotes it and drains the old one, and it is the only process that
 * knows when each of those three things happened. At the handover it writes one record
 * saying so.
 *
 * ## Why this is not a deploy record, and not `restart.json` either
 *
 * Both of those exist already and neither could carry this.
 *
 * **Not the deploy journal.** lib/deploy.js argues it at length and the argument has not
 * changed: a swap wearing a deploy record would turn up in `listDeploys`, and from there
 * in the deploy history and — through `unannounced` — in a push announcing a deploy nobody
 * pressed Ship on. `npm run swap` is run by hand, by the ship skill, and by the router
 * itself every time `lib/` moves on disk. The journal is a list of things somebody pressed
 * Ship on and it has to stay one.
 *
 * **Not `restart.json`.** That file is deliberately a *single fact that overwrites
 * itself* — the last time the port changed hands — because what reads it only ever asks
 * "was there a handover in the last thirty seconds", and a stamp answers that by
 * arithmetic with nothing to clean up. A queue entry asks a different question: *which*
 * handover carried release 42, which is a question about a handover that is no longer the
 * last one. The two shapes cannot be the same file, and the older one is left exactly as
 * it was: `reportingQuiet` goes on reading a stamp, and a hand-run swap goes on hushing
 * what it always hushed.
 *
 * ## Three times, written once, after the fact
 *
 * A record is written at the handover and carries all three moments — spawned, answered,
 * promoted — rather than being opened at the spawn and updated as the swap proceeds. That
 * is deliberate and it costs something worth naming: because the record only exists once
 * the swap has *finished*, those first two rungs are only ever drawn as `done`. A card can
 * never show you a verification in progress.
 *
 * What it buys is that every record here is a handover that actually happened. A record
 * opened at the spawn would have to be closed by something, and the two ways a swap ends
 * without a handover — a build that is condemned, and one that is merely slow and is
 * retried on a widening window (lib/startup.js) — are exactly the cases where nothing
 * comes back to close it. Half-written records that mean "either it is verifying right
 * now or it died twenty minutes ago" would put a rung mid-flight on a screen for a swap
 * that never took, which is the same over-claim the `untracked` state was drawn to avoid.
 * A failed swap has its own trail, and it is a loud one: the log, the 503 body, `npm run
 * swap:status` and the console health line, all off `explain()`.
 *
 * ## Churn, so no history
 *
 * The file is rewritten whole on every handover and holds the last `KEEP_HANDOVERS` of them, so a
 * commit per swap in the common repo would be the same twenty rows written twenty times
 * over. It is ignored there for that reason (lib/commonrepo.js), and lib/evidence.js
 * records it under NOT_EVIDENCE with the same argument: what shipped and whether it took
 * is the deploy record and the running build, both of which are registered. This is the
 * router's observation of the swap that carried one, kept long enough to be joined to it
 * and no longer.
 */

/** Where the trail lives. Beside `restart.json`, and nothing like it — see the header. */
export const HANDOVER_PATH = path.join(CONFIG_DIR, 'handovers.json');

/**
 * How many handovers are kept.
 *
 * Deliberately shorter than the forty deploy records it points into (`KEEP` in
 * lib/deploy.js), because a handover whose deploy has aged out of the journal cannot be
 * attributed to anything and is a row nobody can join. It is longer than the *queue* needs
 * — an entry leaves the release board one release after it went live — because the router
 * swaps on its own whenever `lib/` moves, so several handovers can sit between two
 * releases and a ring the size of the queue would drop the one that mattered.
 */
export const KEEP_HANDOVERS = 20;

/**
 * Write down that the service has just changed hands.
 *
 * Called from `bin/router.js` at the promotion, in the same lazily-imported breath as
 * `markRestart` and under the same contract: **best-effort, never fatal**. A router that
 * cannot write this is a router whose release board shows three rungs it cannot see, which
 * is what it showed yesterday; it is never a reason to fail a swap.
 *
 * `deploy` is the id of the deploy record this handover belongs to, or null — the router
 * asks lib/deploy.js for it (`restartingDeploy`) rather than this file guessing from
 * timestamps. Null is the ordinary case and not a gap: a swap the router did because
 * `lib/` moved belongs to no deploy at all, and saying so is the whole of what is true
 * about it.
 */
export function recordHandover(rec = {}) {
  const at = rec.at || new Date().toISOString();
  const entry = {
    at,
    // The two moments before it, as far as the router observed them. Both may be null:
    // the record is worth writing for the handover alone, and a caller that has lost
    // track of when it spawned must not lose the fact that it promoted.
    spawnedAt: rec.spawnedAt || null,
    healthyAt: rec.healthyAt || null,
    build: rec.build || null,
    pid: Number.isFinite(rec.pid) ? rec.pid : null,
    // The internal port the new backend came up on — the "green" of blue/green, which
    // otherwise appears nowhere anybody can read after the fact.
    port: Number.isFinite(rec.port) ? rec.port : null,
    reason: rec.reason ? String(rec.reason) : '',
    deploy: rec.deploy ? String(rec.deploy) : null,
  };
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // Newest first, matching `listDeploys`, so a reader that wants the last one does not
    // have to know how long the list is.
    writeJsonAtomic(HANDOVER_PATH, { handovers: [entry, ...listHandovers()].slice(0, KEEP_HANDOVERS) });
    return entry;
  } catch {
    return null;
  }
}

/**
 * The trail, newest first — `[]` when there is none.
 *
 * A file we cannot read is not evidence that nothing ever swapped, and inventing a
 * handover from an unreadable one would put a time under a rung nobody observed. Absent,
 * half-written and hand-mangled all answer the same way, which is the same direction
 * `lastRestart` chose next door.
 */
export function listHandovers() {
  try {
    const raw = JSON.parse(fs.readFileSync(HANDOVER_PATH, 'utf8'));
    const rows = Array.isArray(raw) ? raw : raw?.handovers;
    if (!Array.isArray(rows)) return [];
    return rows.filter((r) => r && typeof r === 'object' && typeof r.at === 'string' && r.at);
  } catch {
    return [];
  }
}

/**
 * The handover that carried this deploy, or null.
 *
 * **The earliest one that claims it**, which is the same end `releasedBy` counts from in
 * lib/queues.js and for a stronger version of the same reason. The router attributes a
 * handover to the newest unsettled restarting deploy it can find, and there is a window in
 * which that is wrong: an `unconfirmed` record from twenty minutes ago is still the newest
 * one when somebody runs `npm run swap` by hand. Both handovers then name it, and the
 * earlier of the two is the one the deploy actually caused — so the later, looser claim
 * cannot overwrite the real time.
 */
export function handoverFor(deployId, handovers = []) {
  if (!deployId) return null;
  const id = String(deployId);
  const mine = (handovers || []).filter((h) => h?.deploy && String(h.deploy) === id);
  if (!mine.length) return null;
  return mine.reduce((oldest, h) => (String(h.at) < String(oldest.at) ? h : oldest));
}

/**
 * A handover's three moments, keyed by the release rung each one is evidence of.
 *
 * Here rather than in lib/queues.js because the mapping is a fact about this record: the
 * router spawns onto the green port, health-checks it, and promotes it, and those are
 * *deployed to green*, *green verification* and *swapping to blue* in that order. A rung
 * whose moment was not recorded is left out entirely rather than being given the
 * handover's own time — a rung with a borrowed time on it is a rung nobody observed.
 */
export function observedRungs(handover) {
  if (!handover) return {};
  const out = {};
  if (handover.spawnedAt) out.green = handover.spawnedAt;
  if (handover.healthyAt) out.verifying = handover.healthyAt;
  if (handover.at) out.swapping = handover.at;
  return out;
}
