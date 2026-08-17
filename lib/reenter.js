/**
 * What re-opens an Epic Advocate — the half of bc-rfnr.3 that was never delivered.
 *
 * The agent's own brief says it out loud: *"You are re-entrant, not resident. You will be
 * re-opened on child events rather than left running — so write everything down on the
 * bead."* (`epicAdvocatePrompt` in lib/epicadvocate.js, and the role in lib/foundation.js.)
 * It duly wrote everything down. Until this file, **nothing ever came back to read it** —
 * `openEpicAdvocateSession` had exactly one caller, the button on the epic card, so an epic
 * advocate was a tap and not an assignment, and an agent that faithfully records its
 * conclusions and is never re-entered is the write-only diary bc-goo exists to disprove,
 * in its purest form. The route's own comment said so and named this as missing.
 *
 * **Enrolment is the bead, and that is the decision worth the most in here.** There is no
 * new registration file, no `advocated` label and no list in the config — an epic is enrolled
 * when its notes carry the advocate's own waiting-on block (`waitingOn`), which is written
 * by the last thing every advocate window is told to do before it exits. So the tap *is*
 * the enrolment: press the button once, the window it opens writes its sentence, and from
 * then on this sweep brings it back. Three things follow, and all three are why it is done
 * this way rather than with a registry:
 *
 *   - **The button and the sweep cannot disagree about who is enrolled**, because neither
 *     of them holds the fact — the tracker does.
 *   - **It survives losing `advocates.json`**, a restart, or a machine. A registry would
 *     have to be re-derived from the bead anyway to be trusted.
 *   - **Erasing the block un-enrols the epic**, which is the off switch that costs no new
 *     control: an advocate that concludes an epic needs no more supervision can take its own
 *     sentence off, and nothing will re-open it.
 *
 * The cost is honest: an advocate window that dies before writing its sentence never
 * enrols its epic, and a tap is needed again. That is the failure the button stays for, and
 * it is the one the acceptance on bc-goo.15 asks be kept.
 *
 * **Which events, and deliberately not all of them.** A child that *closed*, a child that
 * was *filed*, a child that *stalled* — the three the bead names. Not a child that started:
 * `open → in_progress` is a worker window coming up, which is the system working and needs
 * no supervisor to think about it, and on a subtree of thirty that flip is most of the
 * traffic there is. Over the whole **subtree** rather than direct children only, because a
 * epic whose children are epics has its real movement one level further down and the card
 * above it already counts descendants.
 *
 * **An advocate's own filings are news to its successor, and that is deliberate.** This
 * agent's job includes filing children, so a window that files three of them leaves three
 * `filed` events behind — and three hours later, at the earliest, another window opens to
 * see how they are going. That is not a loop: it terminates the moment the subtree stops
 * moving, because the snapshot has caught up by then. It is also the honest reading of what
 * a supervisor is for, which is why nothing here tries to attribute a filing to a window
 * and discount it; the daemon cannot tell which of two agents filed a bead, and guessing
 * would make the one signal this has less trustworthy rather than quieter.
 *
 * **A stall is measured in windows, not in timestamps.** `updated_at` says nothing useful
 * here — a comment bumps it and a dead window does not — so a stalled child is one the
 * tracker says is `in_progress` while *nothing on this Mac is in a window on it and no other
 * machine holds a live lease on it*, for `reenterStallMinutes`. That is the shape of the
 * real failure: a bead claimed by a session that died, sitting `in_progress` forever with
 * nobody coming back to it. It needs two sweeps to fire, because the clock starts the first
 * time the state is seen, which also means a launch racing a sweep can never read as a stall.
 *
 * Nothing here spawns anything or reads a disk: a snapshot and a graph index in, a sentence
 * out, so test/reenter.mjs can drive every branch — a close, a file, a stall, a first sight,
 * a cooldown — without a tracker, a checkout or a window. `reenter` in lib/advocate.js is
 * the twenty lines that own the clock, the guard and the launch.
 */
import { byDoneThenId, childrenFrom, treeUnder } from './ancestry.js';
import { waitingOn, wantsAdvocate } from './epicadvocate.js';

/**
 * The numbers, here rather than in lib/advocate.js's `DEFAULTS`, for the reason
 * `LEASE_DEFAULTS` and `REAP_DEFAULTS` are in their own files: the argument for each one
 * is in this header, and a tunable whose reason lives three files away from its value is
 * a tunable somebody changes without reading the reason.
 */
export const REENTER_DEFAULTS = {
  /**
   * Re-open the Epic Advocate when something moves under an enrolled epic. The whole
   * feature's off switch, and off leaves exactly what beadcause did before: a button.
   */
  reenterAdvocates: true,
  /**
   * How often the sweep looks. One `bd export` per workspace, and it is the *cached* one
   * the inbox already builds (`Bd.graph`, 60s), so on a daemon anybody has a phone open
   * against this costs nothing at all. Ten minutes rather than every tick because the
   * events it watches for happen a few times a day and being ten minutes late costs
   * nothing — see the cooldown.
   */
  reenterIntervalMinutes: 10,
  /**
   * The floor between two automatic windows on the same epic. **This is the rate limit the
   * acceptance asks be stated**, and three hours is a deliberate choice against being
   * responsive: the thing being spent is an unattended window that files beads, and the
   * failure to avoid is a Mac full of 🧭 windows arguing about a subtree while its
   * children get on with the work. Nothing waits on an advocate — advocacy does not gate
   * dispatch, which bc-goo's own waiting sentence says — so a supervisor that takes stock
   * three hours after a child landed is not late for anything. Bursts collapse: a
   * morning where four children close produces one window, briefed on all four.
   */
  reenterCooldownMinutes: 180,
  /**
   * How long a child sits `in_progress` with nobody in a window on it before that is a
   * stall worth waking a supervisor for. An hour, which is half of `workerTimeoutMinutes`
   * — the advocate's own reap already releases a *slot* at two hours, and this is the
   * question the reap never asks: the slot came back and the bead is still claimed.
   */
  reenterStallMinutes: 60,
};

/** Up to three ids by name, then a count — a sentence, not a list of thirty. */
function list(ids) {
  const names = ids.map((id) => `\`${id}\``);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/**
 * Every root in this workspace an advocate has already been on, with the two lists a
 * re-entry needs.
 *
 * `kids` is the **direct** children, which is what the brief draws and the same list
 * `POST /api/bead/advocate` hands it (`bd children`) — so a window opened by this sweep
 * and a window opened by the button read identically. `tree` is the **whole subtree**,
 * which is what the events are computed over. Two lists off one index rather than a
 * second tracker call for either.
 *
 * `wantsAdvocate` is the same gate the launch door refuses on, so this can never queue a
 * bead the launch would then reject: not a root, closed, unowned, or a crash bead. Injectable
 * only so a test can drive enrolment without building four labels; the daemon never
 * overrides either.
 */
export function advocatedRoots(index, { wants = wantsAdvocate, enrolled = waitingOn } = {}) {
  const beads = index?.beads;
  if (!beads?.size) return [];
  const kidsOf = childrenFrom(index.parents);
  const out = [];
  for (const bead of beads.values()) {
    if (!wants(bead) || !enrolled(bead)) continue;
    const kids = (kidsOf.get(bead.id) || [])
      .filter((id) => beads.has(id))
      .map((id) => beads.get(id))
      .sort(byDoneThenId);
    out.push({ epic: bead, kids, tree: treeUnder(kidsOf, beads, bead.id) });
  }
  // Oldest id first and numerically, the order `byDoneThenId` uses for the same reason:
  // with one window per tick, the P0 that gets it must not depend on `Map` insertion
  // order — which is `bd export`'s order, which is nobody's decision.
  return out.sort((a, b) => String(a.epic.id).localeCompare(String(b.epic.id), 'en', { numeric: true }));
}

/**
 * What has moved under this epic since the last look, as the sentence the window is opened
 * with — or `null`, which is most sweeps.
 *
 * `prev` is the record this returned last time (`null` on a first sight, which is silent:
 * with nothing to compare against every child looks new, and a daemon that fired on that
 * would open a window on every enrolled epic the first time it ever ran). The record it
 * hands back is what to store, and the caller decides whether to store it — see `reenter`
 * in lib/advocate.js on why a skipped event must keep the *old* snapshot rather than the
 * new one.
 *
 * `busy` is asked of a row rather than an id because all three of its answers are about
 * things this file must not know: a worker on this advocate, a live session naming the
 * bead, and a lease another Mac holds on it.
 */
export function reentryFor(prev, tree = [], { busy = () => false, now = Date.now(), stallMinutes = REENTER_DEFAULTS.reenterStallMinutes } = {}) {
  const seen = prev?.kids && typeof prev.kids === 'object' ? prev.kids : null;
  const kids = {};
  for (const row of tree) kids[String(row.id)] = String(row.status || 'open').toLowerCase();

  // The stall clock, rebuilt from the current tree every sweep: a child that is no longer
  // in this state drops out of both maps, which is what makes a stall that resolved itself
  // able to fire again if it comes back.
  const stalls = {};
  const reported = [];
  const stalled = [];
  for (const row of tree) {
    const id = String(row.id);
    if (kids[id] !== 'in_progress' || busy(row)) continue;
    const since = Number(prev?.stalls?.[id]) || now;
    stalls[id] = since;
    if ((prev?.stalled || []).includes(id)) {
      reported.push(id);
      continue;
    }
    if (now - since >= stallMinutes * 60000) {
      stalled.push(id);
      reported.push(id);
    }
  }

  const record = { kids, stalls, stalled: reported, at: prev?.at || null };
  if (!seen) return { first: true, reason: null, events: { closed: [], filed: [], stalled: [] }, record };

  // A child that closed, and a child that is *gone* with it. An id that has left the graph
  // entirely was deleted rather than closed, and it is the same news to a supervisor —
  // something it planned is no longer there — so it is named the same way rather than
  // being silently dropped, which is what a plain status comparison would do.
  const closed = Object.keys(kids).filter((id) => kids[id] === 'closed' && seen[id] && seen[id] !== 'closed');
  const gone = Object.keys(seen).filter((id) => !(id in kids));
  const filed = Object.keys(kids).filter((id) => !(id in seen));
  const shut = [...closed, ...gone].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));

  const parts = [];
  if (shut.length) parts.push(`${list(shut)} ${shut.length === 1 ? 'has' : 'have'} closed under it`);
  if (filed.length) parts.push(`${list(filed)} ${filed.length === 1 ? 'was' : 'were'} filed under it`);
  if (stalled.length) {
    const hours = Math.max(1, Math.round(stallMinutes / 60));
    const one = stalled.length === 1;
    parts.push(
      `${list(stalled)} ${one ? 'has' : 'have'} been in progress for over ${hours}h with nothing` +
        ` on this Mac in a window on ${one ? 'it' : 'them'} and no live lease elsewhere`
    );
  }
  return {
    first: false,
    reason: parts.length ? parts.join('; ') : null,
    events: { closed: shut, filed, stalled },
    record,
  };
}
