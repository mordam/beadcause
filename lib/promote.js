/**
 * The promotion bead — one per epic, filed when the epic's work is in main.
 *
 * This is the unit a release agent carries through UAT and production (bc-y8k4): one
 * image per repo, deployed to UAT, tested there, then the **same image** promoted to
 * production and tested again. It is filed here, by the advocate, at the one moment
 * anything in this daemon can be sure the epic's work exists as a thing to promote —
 * when every bead the epic's plan named has closed.
 *
 * ## Why it is not a `ship` bead, and why that matters more than it looks
 *
 * lib/release.js already files something people call a release bead, and the two settle on
 * different evidence for different facts:
 *
 * | | `ship` (lib/release.js) | `promote` (here) |
 * |---|---|---|
 * | one per | **merge** | **epic** |
 * | means | this merge is not running on this Mac yet | this feature has not been through UAT and production yet |
 * | closed by | a `launchctl kickstart` that made it live | a release agent that promoted and verified it |
 * | scope | one laptop | the environments the product actually ships to |
 *
 * A single epic produces one promotion bead and, on the way, four or five ship beads —
 * one per pull request that merged. Two things called a release bead, settling on
 * different evidence, is a board that lies: a green ship bead would read as "released"
 * to anyone who had not learned the distinction, over work that has never been near UAT.
 * So they differ in **both** of the two things a board sorts on — a distinct label
 * (`promote` against `ship`) and a distinct type (`chore` against `task`) — and every
 * query in this file goes through `PROMOTE_LABEL` rather than through a title match.
 *
 * ## What makes it safe to file unattended
 *
 * - **Only a planned epic gets one.** The plan is what says which beads are the epic's
 *   work; without one there is no set to be complete, and nothing is filed.
 * - **Only when every bead the plan named has *closed*** — asked of the tracker's own rows,
 *   not of the queue. A bead closes on merge (bin/deliver.js merges and closes in one
 *   breath; lib/landed.js closes the ones that merged on github.com), so a plan whose beads
 *   are all closed is the epic's work being in main. Where the tracker cannot say — a bead
 *   it has no row for, an export that failed — `dispatchable` reports not-done and nothing
 *   is filed, which is lib/release.js's own rule: we-cannot-say settles nothing, ever.
 *
 *   **This was a queue check until bc-4bet.2, and a queue check reads not-ready as done.**
 *   `unendorsed` beads are excluded from the survey's queue by design (lib/endorse.js), and
 *   so is anything blocked behind a dependency — so a group nobody had started looked
 *   exactly like a group that had finished, and bc-1kwl.9 was filed saying "every bead under
 *   bc-1kwl is closed, so its work is in main" over an epic two thirds of whose planned work
 *   had never begun. The bead below asks a release agent for UAT and production on the
 *   strength of that sentence; a false premise stated as fact is worse than no bead.
 * - **Exactly once**, guaranteed by a label on the epic rather than by a ledger, because
 *   the guarantee has to survive a daemon restarted between the tick that filed and the
 *   tick that would file again.
 * - **`unendorsed`**, like every other bead this daemon files for itself. The release
 *   agent that will work it does not exist yet, and until Adam has looked at one of these
 *   nothing should open a window on it. lib/endorse.js is the gate; this is just another
 *   bead going through it.
 */

import { PROMOTED_LABEL } from './plan.js';
import { UNENDORSED } from './endorse.js';
import { SHIP_LABEL } from './shipbead.js';
import { CONTAINER } from './container.js';
import { SUPERSEDE_PREFIX } from './superseded.js';
import { childrenFrom, treeUnder } from './ancestry.js';
import { homeIn } from './homing.js';

/** The label a promotion bead carries. Not `ship`, and the difference is the point. */
export const PROMOTE_LABEL = 'promote';

/** And its type, the second half of that distinction. */
export const PROMOTE_TYPE = 'chore';

/**
 * The labels that say a closed bead under an epic is not work that landed.
 *
 * Every one of them is a bead nothing was built for. A `ship` bead closes on a
 * `launchctl kickstart`; a `promote` bead is this bead's own twin; a `container` is a
 * heading. Put any of them on a UAT list and the release agent goes looking for a feature
 * that does not exist.
 *
 * Deliberately short, and deliberately biased towards *including*: the defect this list
 * exists inside of (bc-y8k4.1) is a promotion that tested four of nine things and passed,
 * so a bead wrongly on the list costs a minute of an agent's confusion and a bead wrongly
 * off it costs a release. A closed question under an epic is therefore still work here —
 * it is noise, and noise is the cheap failure.
 *
 * **`unendorsed` is not on this list, and that was measured rather than reasoned.** It
 * reads like the strongest exclusion there is — nobody ever agreed the bead should be
 * worked, so a closed one was surely closed *instead* of being done — and on this tracker
 * it is false. bc-9d37.12 and bc-9d37.14 are both closed, both still carry `unendorsed`,
 * and both are named as landed work in bc-y8k4.1's own measurement of that epic: a session
 * working a neighbour fixed them and closed them, and nothing takes the label off on the
 * way. Excluding it would have dropped two of the nine beads this bead exists to stop being
 * dropped. It *is* excluded from `open` in `landedWork`, where it means the opposite thing:
 * an open unendorsed bead is a discovery nothing will open a window on, not work in flight.
 */
export const NOT_WORK = [SHIP_LABEL, PROMOTE_LABEL, CONTAINER];

/**
 * Why this closed bead under an epic is *not* what that epic shipped — `''` when it is.
 *
 * A reason rather than a boolean because the first question anybody asks of a derived list
 * is "where is bc-x", and a tool that can only answer "not in the list" makes them go and
 * read the labels by hand.
 */
export function whyNotWork(row) {
  const labels = (row?.labels || []).map((l) => String(l).trim());
  const excluded = labels.find((l) => NOT_WORK.includes(l));
  if (excluded) return excluded;
  // Superseded work is work somebody else did, under another id. Naming it here sends the
  // release agent to test a bead whose whole content is "this was the same job as bc-x".
  const dup = labels.find((l) => l.startsWith(SUPERSEDE_PREFIX));
  return dup || '';
}

/** Is this closed bead under an epic part of what that epic shipped? Takes a graph row. */
export const isWork = (row) => !whyNotWork(row);

/**
 * What an epic's work actually was — asked of the tracker, at the moment of asking.
 *
 * **This is the answer to bc-y8k4.1, and the reason it is a function rather than a line in
 * the body below.** A promotion bead's body is written once, at filing time, and cannot
 * grow. That is correct for an epic whose plan is its final word, and wrong for the normal
 * shape here: a P0 advocate is re-entered on child events precisely so it can file what the
 * first plan missed, so an epic goes on closing work for days after its plan completes.
 * Measured on bc-9d37 — its promotion bead named four beads and the epic closed nine, and
 * the most visible behaviour change of the lot was among the five that landed after.
 *
 * The image promoted is right regardless; it is main's merge build and contains everything.
 * What goes wrong is what the release agent is told to **exercise in UAT** — and a
 * promotion that tests the wrong things and *passes* is worse than one that fails.
 *
 * So one place decides what an epic's work was, and it is the tracker, which cannot go
 * stale. The filed body is the reason the card exists; this is the test plan, and it is
 * derived when somebody asks rather than when the bead was written.
 *
 * **The whole subtree, not the direct children**, because a group's beads may hang off a
 * task rather than off the epic, and a missing bead is the failure being fixed.
 *
 * Answers `{ beads, skipped, open, error }`: what to test, what was closed and deliberately
 * left out and why, and what is still open under the epic. The last two are there because
 * the first question anybody asks of a derived list is *where is bc-x* — and an epic with
 * open work under it is a promotion that should not have been filed at all (bc-4bet.2),
 * which whoever holds this list is the last reader in a position to notice.
 *
 * **An unreadable tracker is `error` and an empty list, never a short one.** `Bd.graph`
 * hands back an empty index carrying `.error` when `bd export` times out, and treating that
 * as "the epic closed nothing" is the same lie in a new place — the caller must be able to
 * say *I could not find out* rather than draw a list of none. A `bd` with no `graph` at all
 * (a fake in a suite, an older shim) is that same state, as in lib/homing.js.
 */
export async function landedWork(bd, workspace, epicId) {
  const empty = (error) => ({ beads: [], skipped: [], open: [], error });
  if (typeof bd?.graph !== 'function') return empty('no tracker graph to ask');
  let index;
  try {
    index = await bd.graph(workspace);
  } catch (err) {
    return empty(String(err?.message || err).split('\n')[0]);
  }
  if (!index || index.error) return empty(index?.error || 'could not read the tracker');
  const byId = (a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
  const rows = treeUnder(childrenFrom(index.parents), index.beads, epicId);
  const beads = [];
  const skipped = [];
  const open = [];
  for (const r of rows) {
    const row = { id: r.id, title: r.title || '' };
    if (r.status !== 'closed') {
      // Not part of the list, and not silence either: an epic promoted with open work under
      // it is bc-4bet.2's defect, and a release agent holding this list is the last reader
      // who can notice. `unendorsed` is excluded *here* and nowhere else — see NOT_WORK: an
      // open one is a discovery nothing will open a window on, and workers file those under
      // a live epic constantly, so counting them would say every epic has open work.
      const labels = (index.beads.get(r.id)?.labels || []).map((l) => String(l).trim());
      if (isWork(index.beads.get(r.id)) && !labels.includes(UNENDORSED)) open.push(row);
      continue;
    }
    const why = whyNotWork(index.beads.get(r.id));
    if (why) skipped.push({ ...row, why });
    else beads.push(row);
  }
  return { beads: beads.sort(byId), skipped: skipped.sort(byId), open: open.sort(byId), error: '' };
}

const title = (epic) => `Promote ${epic.id} — ${epic.title || '(untitled)'}`;

/** One line per bead, titles clipped so a forty-bead epic is still a readable card. */
const line = (b) => `- \`${b.id}\` — ${String(b.title).length > 90 ? `${String(b.title).slice(0, 89)}…` : b.title}`;

/**
 * What the release agent is handed.
 *
 * The plan is the source for the **repos**, which is the second thing the plan earns: it is
 * the only place that says which repos this epic's work landed in, and one image per repo
 * per merge build is exactly what has to be promoted. A body assembled from the closed
 * beads alone would have to guess at that from labels.
 *
 * It is deliberately **not** the source for what to test, and that is bc-y8k4.1. The list
 * of beads here is a snapshot dated at the top of it, and the body says outright that the
 * tracker is the authority and how to ask it — because this text is frozen the moment it is
 * written and the epic is not. See `landedWork`.
 */
function body(epic, plan, work, { workspace = '' } = {}) {
  const repos = [...new Set(plan.groups.flatMap((g) => g.prs.map((p) => p.repo)))];
  const planned = plan.groups.flatMap((g) => g.beads);
  const ws = workspace || '<workspace>';
  const derived = !work?.error && (work?.beads || []).length ? work.beads : null;
  return [
    `Every bead under **${epic.id}** is closed, so its work is in \`main\`. What is left is`,
    `promotion: the merge build for each repo below goes to UAT, is tested there, and the`,
    `same image is then promoted to production and tested again.`,
    '',
    `**Repos** (one image each): ${repos.map((r) => `\`${r}\``).join(', ')}`,
    '',
    `**Ask the tracker what to test — not this bead.** This body was written when the bead`,
    `was filed and cannot grow, and an epic goes on closing work after its first plan`,
    `completes: an advocate is re-entered on child events precisely so it can file what the`,
    `plan missed. Before you exercise anything, re-derive the list:`,
    '',
    '```',
    `beadcause-promotework -w ${ws} -e ${epic.id}`,
    '```',
    '',
    `That is every closed bead under ${epic.id} that is real work — ship beads, promotion`,
    `beads, containers and superseded ones are not — and it is the list to test. The image is`,
    `right either way; what goes stale is what you are told to exercise, and a promotion that`,
    `tests the wrong things and passes is worse than one that fails.`,
    '',
    derived
      ? `**What had landed when this was filed** (${derived.length}, and there may be more by now):`
      : `**What the plan named** (the tracker could not be read when this was filed${work?.error ? ` — ${work.error}` : ''}):`,
    '',
    ...(derived ? derived.map(line) : planned.map((id) => `- \`${id}\``)),
    '',
    `**How it was planned** — the repo each group's pull requests landed in:`,
    '',
    ...plan.groups.map((g) => `- **${g.name}** — ${g.beads.join(', ')} → ${g.prs.length} PR${g.prs.length === 1 ? '' : 's'} in \`${g.prs[0].repo}\``),
    '',
    `This is not a \`ship\` bead. Those are one per merge and close when a \`launchctl\``,
    `kickstart makes that merge live on this Mac; this one is one per epic and closes when`,
    `the work has been through UAT and production. See lib/promote.js.`,
  ].join('\n');
}

/**
 * File the promotion bead for an epic whose plan is complete — or say why not.
 *
 * Returns `{ filed: <id> }`, `{ skipped: <reason> }` or `{ already: true }`. Never throws:
 * this runs inside an advocate tick, and a tracker mid-write must not be able to take an
 * advocate down. A failure is a line in the log and a retry on the next tick, which is safe
 * precisely because the label is written after the bead and re-filing is what the label
 * prevents.
 *
 * `epic` is the row the survey already read, so its labels are in hand; the label check
 * costs nothing on the ordinary tick where nothing is complete.
 */
export async function filePromotion(bd, workspace, epic, plan) {
  if ((epic.labels || []).includes(PROMOTED_LABEL)) return { already: true };
  let id = null;
  // Under the same P0 as the epic being promoted (lib/homing.js) — the P0, not the epic
  // itself, because this bead outlives it: the epic closes when its children land, and a
  // promotion left open under a closed non-P0 parent is held forever with nothing saying
  // why. bc-rfnr.8.
  const { parent } = await homeIn(bd, workspace, { from: epic.id });
  // Derived here as well as by whoever works the bead, because the two answer different
  // questions: this one is what had landed at filing time — including work the plan never
  // named — and the command in the body is what has landed by the time anybody promotes.
  // A tracker that will not answer costs the snapshot and nothing else; the body says so
  // and still tells the agent how to ask.
  const work = await landedWork(bd, workspace, epic.id);
  try {
    id = await bd.create(workspace, {
      title: title(epic),
      body: body(epic, plan, work, { workspace: workspace?.name || '' }),
      type: PROMOTE_TYPE,
      priority: 2,
      parent,
      labels: [PROMOTE_LABEL, UNENDORSED],
      acceptance: `The merge build carrying ${epic.id}'s work has been deployed to UAT, tested there, and the same image promoted to production and tested again.`,
    });
  } catch (err) {
    return { skipped: `could not file a promotion bead for ${epic.id} — ${String(err.message).split('\n')[0]}` };
  }
  if (!id) return { skipped: `filing a promotion bead for ${epic.id} returned no id` };
  // After the bead, never before: a label written first and a `create` that then failed
  // would be an epic that says it was promoted with nothing carrying the promotion. The
  // other order costs, at worst, a second bead if the daemon dies in between — and a
  // duplicate that Adam can close beats a release nobody files.
  try {
    await bd.addLabel(workspace, epic.id, PROMOTED_LABEL);
  } catch (err) {
    return { filed: id, warn: `filed ${id} but could not mark ${epic.id} promoted — ${String(err.message).split('\n')[0]}` };
  }
  return { filed: id };
}
