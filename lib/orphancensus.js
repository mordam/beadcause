/**
 * How many beads has this tracker filed under nothing? — bc-xl7n.83.
 *
 * lib/underroot.js already answers, one bead at a time, whether anything has decided a
 * given bead should happen (`hasRootAbove`), and lib/advocate.js's `withoutOrphans`
 * already uses that to hold every such bead out of the ready queue. Both were built and
 * both work. What neither does is count — and a run of epic-advocate passes on bc-xl7n
 * hand-wrote the same three-line script over `bd export` often enough that two of them
 * wrote down the same two traps as repo notes: test the bead itself for root-ness before
 * walking its ancestors, and keep walking through a *closed* parent rather than stopping
 * there. This file is that script, written once.
 *
 * **And it is not the same question `withoutOrphans` asks.** That function only ever
 * sees beads that reached the ready queue — a bead carrying `unendorsed`, `human`,
 * `container` or `ship`, or one that is blocked, deferred or already in progress, never
 * gets offered to it, and so an unrooted bead in any of those states is counted by
 * nothing at all, for as long as it stays that way. `orphanCensus` runs over every
 * non-closed bead in the export, which is the whole population the bead asks about.
 *
 * **The one population this deliberately gets wrong on purpose: the Merge #NNN genre.**
 * The merge queue files those cards with no parent at all and works them without a root
 * above them — that is what keeps them out of dispatch by the same mechanism this file
 * measures, and counting them as a defect would make the number this bead exists to
 * protect swing on nothing but delivery traffic. Excluded by what they *are* — the
 * `merge-queue` label (`lib/mergebead.js`) or the `pr-delivery` label (`lib/delivery.js`)
 * — never by pattern-matching a title, which is the trap their own filers already argue
 * against in their own headers.
 */
import { underAnyOf } from './ancestry.js';
import { rootsOf, NO_ROOT_ABOVE } from './underroot.js';
import { MERGE_LABEL } from './mergebead.js';
import { DELIVERY_LABEL } from './delivery.js';

const wsName = (workspace) => String(workspace?.name || workspace?.dir || '').trim();

const isClosed = (bead) => String(bead?.status || '').trim().toLowerCase() === 'closed';

/** The two labels a bead the merge queue itself files carries — see the header. */
function isMergeGenre(bead) {
  const labels = bead?.labels;
  if (!Array.isArray(labels)) return false;
  return labels.includes(MERGE_LABEL) || labels.includes(DELIVERY_LABEL);
}

/**
 * The whole census, over a `Bd.graph` index already in hand — no `bd` call in here, so a
 * caller that already paid for the export (the daemon sweep below, a repaint, a test)
 * pays nothing extra for the count.
 *
 * **Roots computed once, not once per bead.** `hasRootAbove` (lib/underroot.js) rebuilds
 * `rootsOf` on every call, which is the right shape for asking about one bead and the
 * wrong one for asking about all of them — this walks the export exactly once.
 *
 * **A tracker with no roots at all withholds nothing**, the same fail-open
 * `hasRootAbove` documents: a workspace nobody has filed a P0 or an epic in yet has no
 * orphans, because nothing has been decided about *anything* in it and singling out
 * every bead as unrooted would just be restating that.
 */
export function orphanCensus(index) {
  const beads = index?.beads;
  const parents = index?.parents;
  const roots = rootsOf(beads);
  let nonClosed = 0;
  let unrooted = 0;
  const ordinary = [];

  for (const bead of beads?.values?.() || beads || []) {
    if (!bead || isClosed(bead)) continue;
    nonClosed += 1;
    // A root is above itself (`underAnyOf` puts it in its own set), and a tracker with
    // no roots at all is the fail-open case — every bead is over the whole population,
    // so treating it as "no orphans" rather than "every bead is one" is the honest read.
    if (!roots.size || underAnyOf(parents, bead.id, roots)) continue;
    unrooted += 1;
    if (!isMergeGenre(bead)) ordinary.push(String(bead.id));
  }

  return { nonClosed, unrooted, mergeGenre: unrooted - ordinary.length, ordinary };
}

/** One line, for the log or a card — what a newly-found orphan is worth saying. */
export function describeOrphan(row) {
  if (!row?.id) return '';
  const rest =
    row.ordinary === 1
      ? `the only ordinary orphan of ${row.unrooted} unrooted bead(s)`
      : `${row.ordinary} ordinary orphan(s) now, of ${row.unrooted} unrooted bead(s)`;
  return `${row.id} — ${NO_ROOT_ABOVE} (${rest} across ${row.nonClosed} non-closed)`;
}

/**
 * The watcher the poll cycle ticks — shaped like `createEpicWatch` (lib/epicdone.js) and
 * `createSyncer` (lib/sync.js): the work lives in a module that hands back an outcome
 * rather than throwing, so anything that does reach the cycle's catch is this function's
 * own bug rather than a tracker being slow — the bar `sweepFailed` is for.
 *
 * **Logged once per bead per spell of being an ordinary orphan, not once per cycle.**
 * The same restraint every other hold in this app already uses (`withoutOrphans`,
 * `sweepAdopts`'s refusal log): a bead that stays unrooted for a day would otherwise be
 * the same line every cycle for as long as the daemon runs, which teaches nobody to read
 * it. What that buys is exactly what the bead asks for — **a rise is still noticeable**,
 * because every bead that newly becomes an ordinary orphan produces one line the moment
 * it does, whether the workspace already had none or already had fifty.
 *
 * **No "seeded, quietly" step, unlike `createEpicWatch`.** That suppression exists so a
 * daemon restart does not chime for milestones that happened while it was down — a
 * notification whose whole value is "this just happened". A census has no such moment:
 * the whole point is that the count is otherwise invisible, so the first pass after a
 * restart naming every ordinary orphan already on the tracker is the feature working,
 * not a false alarm.
 */
export function createOrphanWatch({ bd }) {
  /** workspace name → the ordinary-orphan ids the last successful pass saw. */
  const seen = new Map();

  /**
   * One pass over every workspace. Never throws.
   *
   * `newOrphans` is what is worth a log line, `counts` is the whole census per
   * workspace for a caller that wants the number rather than the transition, and
   * `errors` is for the log — a `bd export` that timed out leaves what this watcher
   * last knew about that workspace alone rather than reporting its orphans as cleared.
   */
  async function sweep(workspaces = []) {
    const out = { newOrphans: [], counts: [], errors: [] };
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
      // An empty index carrying `.error` is `bd.graph`'s own fail-open, not a throw — see
      // lib/epicdone.js's identical guard. Treating it as "no orphans" would report every
      // held bead as having been rehomed, and the next good pass would see them all as
      // new again.
      if (index?.error) {
        out.errors.push({ workspace: name, error: String(index.error).split('\n')[0] });
        continue;
      }

      const census = orphanCensus(index);
      out.counts.push({ workspace: name, ...census });

      const before = seen.get(name) || new Set();
      const now = new Set(census.ordinary);
      for (const id of now) {
        if (before.has(id)) continue;
        out.newOrphans.push({
          workspace: name,
          id,
          nonClosed: census.nonClosed,
          unrooted: census.unrooted,
          mergeGenre: census.mergeGenre,
          ordinary: census.ordinary.length,
        });
      }
      seen.set(name, now);
    }
    return out;
  }

  return { sweep };
}
