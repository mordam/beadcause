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
 * new registration file and no list in the config — an epic is enrolled when the tracker
 * says so, and the tracker is the one thing both doors read. Three things follow, and all
 * three are why it is done this way rather than with a registry:
 *
 *   - **The button and the sweep cannot disagree about who is enrolled**, because neither
 *     of them holds the fact — the tracker does.
 *   - **It survives losing `advocates.json`**, a restart, or a machine. A registry would
 *     have to be re-derived from the bead anyway to be trusted.
 *   - **Taking the record off un-enrols the epic**, which is the off switch that costs no
 *     new control: an advocate that concludes an epic needs no more supervision un-assigns
 *     itself, and nothing will re-open it.
 *
 * **Which record, and why there are two of them.** This file originally enrolled on the
 * advocate's own waiting-on block (`waitingOn`) — the last thing every window is told to
 * write before it exits — and named the cost of that out loud: *an advocate window that
 * dies before writing its sentence never enrols its epic, and a tap is needed again.* That
 * cost turned out to be most of the feature. On 2026-08-17, 10 of 40 open epics carried the
 * block, and an assignment Adam had made was reliably gone by the time he came back to it.
 *
 * So bc-r2b5.1 moved the record to the launch: both doors stamp `ADVOCATE_LABEL` the moment
 * a window is up, and `isEnrolled` accepts **either** carrier. The label is the assignment —
 * made when somebody assigns, and surviving a window that dies in its first second — and the
 * block goes on counting so that nothing already enrolled falls out on the deploy that ships
 * this. The button stays for the epic that carries neither, which is now only an epic nobody
 * has ever assigned.
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
 * **And a window that reached one of its two documented endings is not that failure, even
 * though the tracker cannot tell them apart.** A delivered bead and a handed-back bead are
 * left `in_progress`, assigned, with a lease that expires — which is the stall state exactly
 * — so the sweep reported every worker that did what the brief asked. `handedBack` and
 * `waitingOnMerge` are the two answers, both free off what this sweep already reads, and
 * the argument for each is above them. `supervised` is the third and it is not a worker's
 * ending at all: a sub-epic `in_progress` because Adam started it from the board, or
 * because an advocate of its own is on it, is being looked after by somebody who is not
 * this epic — and the brief's prescription for a stall would take it off their board.
 *
 * Nothing here spawns anything or reads a disk: a snapshot and a graph index in, a sentence
 * out, so test/reenter.mjs can drive every branch — a close, a file, a stall, a first sight,
 * a cooldown — without a tracker, a checkout or a window. `reenter` in lib/advocate.js is
 * the twenty lines that own the clock, the guard and the launch.
 */
import { byDoneThenId, childrenFrom, treeUnder } from './ancestry.js';
import { DELIVERY_LABEL } from './delivery.js';
import { isAssigned, isEnrolled, wantsAdvocate } from './epicadvocate.js';
import { MERGE_LABEL } from './mergebead.js';

/**
 * The label a question wears, and the one thing about a bead that says *Adam* is what it
 * is waiting for. A module-local constant, the way lib/inmain.js, lib/sweepcard.js and
 * five others hold it: it is the string bd stores and not a shape anything imports.
 */
const HUMAN_LABEL = 'human';

/** The edge `bd dep add <work> <question>` writes — lib/park.js's one command. */
const BLOCKS_EDGE = 'blocks';

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

/**
 * `treeUnder`'s rows with their labels put back on — and it is not a convenience.
 *
 * That function's shape is the **board's**, and its header says so: a flat pre-order array
 * a phone nests in one pass, deliberately carrying only what a card draws, measured at
 * 3.3KB of JSON for the largest P0 here. Labels are not in it and should not be, because
 * every inbox payload would pay for them.
 *
 * Nothing that goes over a wire reads *this* tree, though — it exists to answer two
 * questions about a child, and **both of them are asked of a label**: has this bead been
 * handed back (`human`), and is another Mac holding a live lease on it (`held:…`, through
 * `busy` in lib/advocate.js). The second one is the older of the two and had been quietly
 * unanswerable since this file was written: `leasesOf(undefined)` is `[]`, so the sweep's
 * own sentence — *"and no live lease elsewhere"* — was a claim it had no way to check, on
 * every child, in silence. The epic itself was fine, because `busy(epic)` is handed a bead
 * off the index rather than a row off this tree, which is exactly why the gap never showed
 * up in a suite.
 *
 * One `Map.get` per row off an index the caller already built, rather than widening a shape
 * that has a different reader and a measured cost.
 */
const labelled = (rows, beads) => rows.map((row) => ({ ...row, labels: beads.get(row.id)?.labels || [] }));

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
export function advocatedRoots(index, { wants = wantsAdvocate, enrolled = isEnrolled } = {}) {
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
    out.push({ epic: bead, kids, tree: labelled(treeUnder(kidsOf, beads, bead.id), beads) });
  }
  // Oldest id first and numerically, the order `byDoneThenId` uses for the same reason:
  // with one window per tick, the P0 that gets it must not depend on `Map` insertion
  // order — which is `bd export`'s order, which is nobody's decision.
  return out.sort((a, b) => String(a.epic.id).localeCompare(String(b.epic.id), 'en', { numeric: true }));
}

/**
 * The two endings a worker window reaches **without exiting** — and neither of them is a
 * stall, however exactly they resemble one.
 *
 * lib/advocate.js names them where `finish` is called, and its comment is the whole of the
 * problem this pair solves: *"both leave the bead open on purpose"* — **delivered**, a pull
 * request waiting on a tap, and **handback**, a question on the bead under a `human` label.
 * Both also leave it `in_progress`, assigned, with a lease that then expires, and that is
 * character for character the state the stall clock below tests for. So every bead that
 * reached one of the two endings the brief *asked* for was then reported to its epic's
 * advocate as *"in progress for over 1h with nothing on this Mac in a window on it"*.
 *
 * **Both fired on bc-xl7n inside one day and both were false** — bc-8t3b, whose pull
 * request #426 was open and whose delivery card was open beside it, and bc-xl7n.25, which
 * the daemon's own log said it had handed back. Neither is a loop: `reported` means a bead
 * fires once per stall episode. Each one is one whole unattended Epic Advocate window
 * opened on a false alarm, and until the question is answered or the branch merges the bead
 * sits in every later brief's child list as `in_progress` — which the advocate then spends
 * real calls disambiguating by hand, every pass, because nothing else can.
 *
 * **Both facts are free, which is why this is here rather than behind a `gh` call.**
 *
 * - `handedBack` is one label on a row the sweep already has. Not a read at all.
 * - `waitingOnMerge` is the same `bd export` the sweep is already looking at. Delivery is
 *   *structural*: bin/deliver.js parks the work bead behind whichever bead it filed —
 *   `pr-delivery` when the merge is Adam's to make, `merge-queue` when the queue's — with
 *   `bd dep add`, because the close gate refuses a bead with an open blocker and that is
 *   what stops a worker closing its own work. So the pull request is knowable off the edge
 *   without asking GitHub anything: a `blocks` edge to a bead that is open and carries one
 *   of those two labels *is* an open delivery, and it stops being one the moment the card
 *   is answered or the merge lands, which is exactly when the bead should be able to stall
 *   again.
 *
 * The asymmetry is deliberate and both directions of it matter. A bead whose question has
 * been answered, or whose merge has landed, drops straight back into the clock — so a
 * window that died *after* its ending was taken back is still a stall, an hour later, and
 * the clock restarts rather than resuming (see `stalls` below, which is rebuilt every
 * sweep). And a dead window with no pull request and no question is untouched by either of
 * these: that is the real failure the sweep exists for, and it still fires.
 */
export const handedBack = (row) => (row?.labels || []).includes(HUMAN_LABEL);

/**
 * The third ending that is not a stall, and the only one where reporting it does harm
 * rather than merely wasting a window.
 *
 * `in_progress` on a **root** does not mean the same thing it means on a work bead. A
 * worker's claim is written by the dispatcher and released when the window ends; an
 * epic's is written by *Adam*, from the phone, and it is the board — `boardMove` in
 * lib/server.js is one status write and its own docblock says why that is right: the
 * board has to be the same fact on every device, so it lives in the tracker rather than
 * in a pin only one screen can see. Nothing takes it off again except closing the epic or
 * pressing **Start** a second time. So a board-started epic is `in_progress` with no
 * worker, no lease, no `human` label and no delivery — the three exclusions above all
 * miss it — and it trips the clock for as long as it is on the board. Because a reported
 * id goes straight back into `reported` on every later sweep while the status holds, it
 * does not fire once and clear: it sits in the parent's re-entry reason permanently.
 *
 * **Measured on bc-xl7n.113, 2026-08-21.** Started from the root board at 11:14:24Z. It
 * ran correctly from that minute on — two children planned, both closed and merged, a
 * follow-up filed, a card raised, its own advocate's windows claiming and releasing it
 * cleanly — and every `bc-xl7n` re-entry reason from 16:27:37Z onward carried *"bc-xl7n.113
 * has been in progress for over 1h with nothing on this Mac in a window on it"*.
 *
 * **The cost is not the wasted window, it is what the brief then tells the advocate to
 * do.** `epicAdvocatePrompt` prescribes `bd update <id> --status open --assignee ""` for a
 * stalled child, and on a board-started epic that command is `boardMove`'s exact inverse:
 * it silently takes the epic off Adam's board, which is a fact only they own, and nothing
 * would say so. Advocates on this very epic have released claims on the strength of that
 * sentence before. The brief now carries the caveat as well, because a rule enforced in
 * one place and unstated in the other is a rule the next reader argues with.
 *
 * **Asked as `advocate-assigned` rather than as "is it on the board"**, because the wider
 * class is the one worth excluding and it is the cheaper read besides. The board is not
 * recorded anywhere but the status, so there is nothing to test for it — but a row
 * carrying this label has a **supervisor of its own**, and its state is that supervisor's
 * business rather than its parent's, whatever route put it there. Every board start
 * reaches it (the sweep and `POST /api/bead/advocate` both stamp the label at the launch)
 * and so does every other supervised sub-epic: 5 of the 6 non-closed `in_progress` epics
 * on 2026-08-21 had a parent, and each was a candidate row in some parent's child list.
 * One label on a row the sweep already has, like `handedBack` — not a read at all.
 *
 * The asymmetry that matters: a row is only excluded while it is *enrolled*. Take the
 * advocate off and the clock starts again, because then nobody is looking at it but its
 * parent — which is the direction where a real stall is still reported.
 */
export const supervised = (row) => isAssigned(row);

/**
 * Is a worker window this advocate is holding briefed on this bead?
 *
 * The first arm of `busy` in lib/advocate.js, lifted here because it is a pure question
 * about a worker record and because it now has three answers rather than one — and the
 * third is bc-2uj4.9.
 *
 * A window stands for its bead in three ways, and until this they were two:
 *
 *   - **`w.id`**, the ordinary case: one window, one bead.
 *   - **`w.batch`**, a batch head or a planner: the window's brief names every id in it,
 *     so all of them are being worked by the one session. `heldByChildren`'s upward guard
 *     is keyed on this field's *length*, which is why a group must not be written into it.
 *   - **`w.group.beads`**, one group of an epic's plan — the case that was missing.
 *
 * The third looks like the second and is a different field on purpose: `dispatchable`
 * hands the lead a *slice* of the subtree rather than the subtree, so a group's lead must
 * not hold its siblings' groups the way a batch head holds everything beneath it. Two
 * fields, one question — and the question this asks is the same for all three.
 *
 * **What the gap cost.** `lib/plan.js` never batches a group: `dispatchable` returns one
 * **lead** per group and holds the rest through `plannedInto`, which filters the ready
 * *queue* and nothing else. So the lead's worker record carried `batch: []`, the session
 * was named after the lead, and the fresh `held:` lease was staked on the lead — all
 * three of `busy`'s arms missed the group's other beads, which the one window had
 * nonetheless marked `in_progress` and was working. An hour later `reentryFor` reported a
 * stall against a bead that was mid-delivery and a P0 advocate was re-opened to deal with
 * it. Measured 2026-08-17 on bc-rfnr.9: worker pid 44145, `id: bc-rfnr.9.7`,
 * `group: { epic: bc-rfnr.9, name: "the board's own surface" }`, `batch: []`, its check-in
 * saying both beads were coded, tested and committed — while `advocates.json` held
 * `stalls: { "bc-rfnr.9.9": … }`.
 *
 * Reading the ids off the record rather than off the plan is what keeps this a pure
 * function: the record already knows them at dispatch — `bead.group.beads` is exactly the
 * list the brief was written from — where re-deriving them here would need the epic's plan
 * comment, which is a tracker read per row per sweep to answer a question the launch had
 * in its hand.
 *
 * **Not named `heldByWorker`, and that is a rule rather than a preference.** `heldBy*` in
 * this codebase is one specific family — the *hold lists* on the advocate record
 * (`heldByChildren`, `heldByUndecided` and the rest), every one of them an array
 * initialised as `heldByX: []` and named in `QUEUE_HOLDS` so the survey brief can say what
 * contention held work back. test/surveybrief.mjs pins that correspondence by grepping
 * lib/advocate.js for `/heldBy\w+/`, so a predicate merely *imported* into that file under
 * a `heldBy` name reds the suite as a hold list that is read and never initialised. The
 * suite is right and the first draft of this name was wrong: this is a question about one
 * worker, not a list of held beads.
 */
export const workerHolds = (workers, id) =>
  (workers || []).some((w) => w?.id === id || (w?.batch || []).includes(id) || (w?.group?.beads || []).includes(id));

/**
 * One pass over `index.edges`, building the map both functions below read from — a bead's
 * id to the open delivery or merge-queue card parked behind it, if any. Shared rather than
 * walked twice: `waitingOnMerge` only ever needed the question answered, but the id was
 * sitting right there in `edge.to` the whole time, and `epicAdvocatePrompt`'s child list
 * (bc-xl7n.99) wants the name of the thing it is waiting on, not just the fact of waiting.
 */
function parkedCards(index) {
  const beads = index?.beads;
  const edges = index?.edges;
  const map = new Map();
  if (!beads?.size || !edges?.size) return map;
  for (const edge of edges.values()) {
    if (String(edge?.type || '') !== BLOCKS_EDGE) continue;
    const card = beads.get(String(edge.to || ''));
    if (!card || String(card.status || 'open').toLowerCase() === 'closed') continue;
    const labels = card.labels || [];
    if (!labels.includes(DELIVERY_LABEL) && !labels.includes(MERGE_LABEL)) continue;
    map.set(String(edge.from || ''), String(edge.to || ''));
  }
  return map;
}

/**
 * `(row) => boolean` — is this bead parked behind a delivery nobody has answered yet?
 *
 * Built once per sweep off the index the sweep already holds, rather than asked per row,
 * because `edges` is keyed by the unordered pair (lib/ancestry.js: bd holds one edge per
 * pair whatever its type) and finding one bead's blockers means walking the lot. One pass
 * over the edge map, a Set of the ids that have one, and the predicate is a lookup.
 *
 * An index with no `edges` — the shape `Bd.graph` hands back after a failed export, and the
 * shape a test that only cares about parents builds — answers `false` for everything, which
 * is the old behaviour and the direction where a real stall is still reported.
 */
export function waitingOnMerge(index) {
  const map = parkedCards(index);
  return (row) => map.has(String(row?.id || ''));
}

/**
 * `(row) => string|null` — the same question as `waitingOnMerge`, answered with the id of
 * the delivery or merge-queue card parked behind this bead rather than a bare boolean.
 * Free off the same walk: nothing here reads anything `waitingOnMerge` did not already
 * read. For `epicAdvocatePrompt`'s child list (bc-xl7n.99), which wants to say *what* a
 * delivered child is waiting on, not only that it is waiting.
 */
export function waitingOnMergeCard(index) {
  const map = parkedCards(index);
  return (row) => map.get(String(row?.id || '')) || null;
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
 *
 * `delivered` is the other injected one, and it is injected for the opposite reason: its
 * answer is entirely about the graph, which this function is deliberately not handed —
 * `tree` is rows. `waitingOnMerge(index)` above is what the daemon passes, built once per
 * sweep; the default is "no deliveries", so a caller that has only rows keeps the old
 * behaviour rather than being silently told nothing has been delivered. The handback half
 * needs no injection at all: it is a label on the row.
 */
export function reentryFor(
  prev,
  tree = [],
  { busy = () => false, delivered = () => false, now = Date.now(), stallMinutes = REENTER_DEFAULTS.reenterStallMinutes } = {}
) {
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
    // The three endings sit beside `busy` rather than above it because they are the same
    // kind of answer — *somebody else's move is what this is waiting for* — and because
    // dropping out here is what makes the clock restart if the ending is taken back. See
    // `handedBack`, `waitingOnMerge` and `supervised`.
    if (kids[id] !== 'in_progress' || busy(row) || handedBack(row) || delivered(row) || supervised(row)) continue;
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
