/**
 * An epic finished — the one arrival in lib/news.js that nothing could raise.
 *
 * `epicDoneEvent` has been sitting in lib/news.js since bc-ka5y.15.1 with nothing
 * calling it, and the reason is written into its own doc comment: the *shape* of the
 * card was settled there and the *moment* was left here, because the moment is a
 * judgement rather than a webhook.
 *
 * ## Why this is a diff of the tracker and not a hook on a close
 *
 * Nothing closes an epic on its own in this app. lib/bd.js refuses an epic close on a
 * merge reason — "a pull request is no evidence about a theme" — after six epics closed
 * that way on 2026-08-12/13 with sixty adoptees still open, and bd has no pre-close hook
 * to teach either (`bd hooks` installs git hooks and nothing else). So an epic closes
 * because a person decided it had, and the deciding happens in four different places:
 * a tap on this app, `bd close` typed at a terminal on this Mac, a worker session an
 * advocate opened, or the same on the other Mac arriving over `bd dolt pull`. Three of
 * those four are other processes. There is no call site to hook, only a row that changes,
 * which is why this is a sweep that remembers what it last saw.
 *
 * ## The one suppression, and why it is `actor` rather than a list of handlers
 *
 * **An epic you closed yourself, from the app in your hand, must not chime.** A
 * notification for your own tap is the fastest way to teach somebody that a sound means
 * nothing, and it is the *only* one of the four sources above where the phone already
 * knows: you were looking at it when it happened.
 *
 * What marks a close as yours is the `actor` on it. `actorFor(req)` in lib/server.js is
 * `sessionOf(req)?.email || null` — a signed-in browser or app session and nothing else.
 * Every token caller (an agent, `bin/deliver.js`, an ntfy action button, the poller
 * itself) passes null and always has, so `actor` is already, exactly, "a person tapped
 * this here". `Bd.run` is the single funnel every `bd close` this daemon spawns goes
 * through, so `rememberHandClose` is called from there rather than from the handlers:
 * a fifth path that closes an epic from a tap gets the suppression without knowing this
 * file exists, which is the property that matters most — the failure mode of forgetting
 * is a false chime, and a false chime is the whole bug.
 *
 * The ledger is deliberately *not* drained by the sweep that reads it. `bd.graph` is
 * cached for sixty seconds and shared with the inbox, so the beat right after a tap
 * routinely reads a graph in which the epic is still open; the transition is seen a
 * minute later, and a ledger drained on the first read would have forgotten by then.
 * It expires on a clock instead, and the clock is generous because an entry costs a
 * map key and a false chime costs the sound its meaning.
 *
 * ## Two more closes that are not a milestone
 *
 * A **superseded** epic and an **unendorsed** one both close for reasons that are the
 * opposite of finishing: the first is a duplicate being tidied away, the second is a
 * proposal being turned down. Neither is in the acceptance for bc-ka5y.15.2, and both
 * would usually be a tap and so already silent — but only usually, and "the epic is
 * finished" over a rejected proposal is the same lesson as chiming at your own tap.
 * They are dropped here rather than in the emitter because they are a fact about the
 * bead, and lib/news.js only ever sees the four fields the card is drawn from.
 *
 * ## State is in memory on purpose
 *
 * The snapshot is what the last sweep saw, and it is seeded rather than acted on the
 * first time a workspace is read — so a daemon that has just come up says nothing about
 * the epics that were already closed when it started, which is `sweptReleasesAt`'s
 * argument in lib/server.js and the same safe direction. What that costs is an epic
 * closed while the daemon was down going unannounced, and that is the right thing to
 * lose: a chime for something that finished yesterday is noise, and the epic is on every
 * screen either way. Nothing here reaches `CONFIG_DIR` or a `refs/beadcause` ref, so
 * there is no state file to gitignore and nothing for lib/evidence.js to claim.
 */

import { childrenFrom, treeUnder } from './ancestry.js';
import { isEpic } from './ownership.js';
import { isSuperseded } from './superseded.js';
import { UNENDORSED } from './endorse.js';

/** How long a close made by a tap stays remembered. See the header. */
const HAND_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * And a ceiling, so a daemon nobody ever sweeps cannot grow one.
 *
 * Six hours of taps is nowhere near this on any real Mac — the number is here because
 * an unbounded map fed by a request path is a leak whatever the traffic, and the oldest
 * entry is by construction the least likely to still be needed.
 */
const HAND_CAP = 500;

/** workspace name → bead id → when the tap that closed it happened. */
const handClosed = new Map();

const wsName = (workspace) => String(workspace?.name || workspace?.dir || '').trim();

/**
 * A person closed this bead from this app. Called by `Bd.run` for every `bd close` that
 * carries an explicit actor — see the header for why that is the whole rule.
 *
 * Records the id whatever type of bead it is: `Bd.run` has an argv and no row, asking bd
 * what it was would put a read in front of every close, and an id that is not an epic is
 * a map entry nothing ever looks up.
 */
export function rememberHandClose(workspace, id, now = Date.now()) {
  const ws = wsName(workspace);
  const bead = String(id || '').trim();
  if (!ws || !bead) return;
  let mine = handClosed.get(ws);
  if (!mine) {
    mine = new Map();
    handClosed.set(ws, mine);
  }
  mine.set(bead, now);
  prune(now);
}

/** Was this close a tap in this app, recently enough to still be the one we are seeing? */
export function closedByHand(workspace, id, now = Date.now()) {
  const at = handClosed.get(wsName(workspace))?.get(String(id || '').trim());
  return Boolean(at && now - at < HAND_TTL_MS);
}

/** Drop what has expired, then the oldest of whatever is left over the cap. */
function prune(now) {
  let total = 0;
  for (const [ws, mine] of handClosed) {
    for (const [bead, at] of mine) if (now - at >= HAND_TTL_MS) mine.delete(bead);
    if (!mine.size) handClosed.delete(ws);
    else total += mine.size;
  }
  if (total <= HAND_CAP) return;
  const all = [];
  for (const [ws, mine] of handClosed) for (const [bead, at] of mine) all.push({ ws, bead, at });
  all.sort((a, b) => a.at - b.at);
  for (const row of all.slice(0, total - HAND_CAP)) {
    const mine = handClosed.get(row.ws);
    mine?.delete(row.bead);
    if (mine && !mine.size) handClosed.delete(row.ws);
  }
}

/** For suites, which share a module registry across cases. Never called by the daemon. */
export function forgetHandCloses() {
  handClosed.clear();
}

/**
 * How many beads are finished under an epic — children *and* adoptees.
 *
 * Both halves, because both are what "under it" means here and the close gate in
 * lib/bd.js already holds an epic open over either: a hierarchical epic keeps its work
 * as `bc-x.1`…`bc-x.9`, and a grouping epic names it in an `Adopts:` line that
 * lib/adopts.js parses into `index.adopts`. Counting only the first would tell you an
 * epic of eleven adopted beads finished with `0 beads closed under it`, which reads as
 * a bug in the count rather than as the shape of the epic.
 *
 * The whole subtree rather than the direct children, and de-duplicated across the two
 * halves, because an adoptee that later became a real child would otherwise be counted
 * twice. Closed only — an epic can be closed over a `deferred` child (bd's gate is on
 * open children and a person may force past it), and calling a deferred bead finished
 * would be this file inventing a fact.
 */
export function closedUnder(index, id) {
  const beads = index?.beads;
  if (!beads?.get) return 0;
  const under = new Set();
  for (const row of treeUnder(childrenFrom(index.parents || new Map()), beads, id)) under.add(row.id);
  for (const adoptee of index.adopts?.get?.(id) || []) if (adoptee !== id) under.add(adoptee);
  let closed = 0;
  for (const bead of under) if (String(beads.get(bead)?.status || '').trim().toLowerCase() === 'closed') closed += 1;
  return closed;
}

/**
 * Is this a close worth a sound? See "Two more closes that are not a milestone" above.
 */
const worthSaying = (row) =>
  !isSuperseded(row) && !(row.labels || []).some((l) => String(l).trim().toLowerCase() === UNENDORSED);

/**
 * The watcher the poll cycle ticks — one per daemon, holding what the last sweep saw.
 *
 * Shaped like `createSyncer` in lib/sync.js, and for its reason: the work lives in a
 * module that returns an **outcome** rather than throwing, so anything that does reach
 * the cycle's catch is the cycle's own bookkeeping — the bar `sweepFailed` is for.
 */
export function createEpicWatch({ bd }) {
  /** workspace name → the ids of every epic that was *not* closed last time we looked. */
  const open = new Map();

  /**
   * One pass over every workspace. Never throws.
   *
   * `done` is what the phone gets, `errors` is for the log, and `seeded` names the
   * workspaces this pass only learned the shape of — which is every workspace on the
   * first beat after a restart and none of them after that.
   */
  async function sweep(workspaces = [], { now = Date.now() } = {}) {
    const out = { done: [], errors: [], seeded: [] };
    for (const workspace of workspaces || []) {
      const name = wsName(workspace);
      if (!name) continue;
      let index;
      try {
        index = await bd.graph(workspace);
      } catch (err) {
        out.errors.push({ workspace: name, error: String(err?.message || err).split('\n')[0] });
        continue;
      }
      // A `bd export` that timed out comes back as an *empty index carrying `.error`*
      // rather than as a throw, and treating that as fact is the trap: every epic would
      // read as having vanished, the snapshot would be overwritten with nothing, and the
      // next successful pass would see the whole tracker as newly filed. Skip the
      // workspace entirely and leave what we last knew about it alone.
      if (index?.error) {
        out.errors.push({ workspace: name, error: String(index.error).split('\n')[0] });
        continue;
      }

      const before = open.get(name) || null;
      const stillOpen = new Set();
      for (const [id, row] of index.beads || new Map()) {
        if (!isEpic(row)) continue;
        const closed = String(row.status || '').trim().toLowerCase() === 'closed';
        if (!closed) {
          stillOpen.add(id);
          continue;
        }
        // A transition, and only a transition: an epic that was already closed when this
        // daemon came up is not news, and neither is one that has been closed all week.
        if (!before || !before.has(id)) continue;
        if (!worthSaying(row)) continue;
        if (closedByHand(workspace, id, now)) continue;
        out.done.push({ workspace: name, id, title: row.title || '', closed: closedUnder(index, id) });
      }
      if (!before) out.seeded.push(name);
      open.set(name, stillOpen);
    }
    return out;
  }

  return { sweep };
}
