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
 * - **Only when that set is empty of ready and running work** — every named bead closed.
 *   A bead closes on merge (bin/deliver.js merges and closes in one breath; lib/landed.js
 *   closes the ones that merged on github.com), so an empty set is the epic's work being
 *   in main. Where the tracker cannot say, `dispatchable` reports not-done and nothing is
 *   filed, which is lib/release.js's own rule: we-cannot-say settles nothing, ever.
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

/** The label a promotion bead carries. Not `ship`, and the difference is the point. */
export const PROMOTE_LABEL = 'promote';

/** And its type, the second half of that distinction. */
export const PROMOTE_TYPE = 'chore';

const title = (epic) => `Promote ${epic.id} — ${epic.title || '(untitled)'}`;

/**
 * What the release agent is handed.
 *
 * The plan is the source for every line of it, which is the second thing the plan earns:
 * it is the only place that says which repos this epic's work landed in, and one image per
 * repo per merge build is exactly what has to be promoted. A body assembled from the
 * closed beads instead would have to guess at that from labels.
 */
function body(epic, plan) {
  const repos = [...new Set(plan.groups.flatMap((g) => g.prs.map((p) => p.repo)))];
  const beads = plan.groups.flatMap((g) => g.beads);
  return [
    `Every bead under **${epic.id}** is closed, so its work is in \`main\`. What is left is`,
    `promotion: the merge build for each repo below goes to UAT, is tested there, and the`,
    `same image is then promoted to production and tested again.`,
    '',
    `**Repos** (one image each): ${repos.map((r) => `\`${r}\``).join(', ')}`,
    '',
    `**What landed**, as the epic worker planned it:`,
    '',
    ...plan.groups.map((g) => `- **${g.name}** — ${g.beads.join(', ')} → ${g.prs.length} PR${g.prs.length === 1 ? '' : 's'} in \`${g.prs[0].repo}\``),
    '',
    `**Beads** (${beads.length}): ${beads.join(', ')}`,
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
  try {
    id = await bd.create(workspace, {
      title: title(epic),
      body: body(epic, plan),
      type: PROMOTE_TYPE,
      priority: 2,
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
