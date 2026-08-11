/**
 * Filing — a worker creates the bead itself, the moment it finds the work.
 *
 * This is the other half of lib/endorse.js. That file is the hold; this one is what
 * puts a bead under it. Together they are the whole trade: a session that trips over
 * work no longer has to choose between swallowing it and stopping to ask.
 *
 * **What changed, and why the old order was wrong.** A worker used to be told "do not
 * create beads — propose them", and `bin/propose.js` filed one `human` question
 * carrying the full text of everything it wanted. Nothing existed until a button was
 * pressed. The review was real, but it sat in front of the *filing*, and a session
 * that has found a bug at 02:00 cannot wait for a tap: it either abandons what it
 * found or it parks. So the review moved to the other side. The bead is created now,
 * it arrives carrying `unendorsed`, and **an unendorsed bead is not workable by
 * anything** — no advocate queues it, no launcher opens a session on it (see
 * lib/endorse.js). Endorsement is still a decision Adam makes before any agent time is
 * spent on it; it is simply no longer the thing the finder waits on.
 *
 * Three stamps go on every bead filed this way, and each answers a different question
 * you would ask three weeks later:
 *
 * 1. **`unendorsed`** — may this be worked? No, not until you say so. This is the one
 *    that has teeth, and its spelling lives in lib/endorse.js so there is exactly one.
 *    It is also the one stamp a space may switch off: `autoEndorse` in lib/spaces.js
 *    files without the hold, for a space where the tap was a formality. The other two
 *    are not optional — see `beadToIssue`.
 * 2. **`agent-filed`** — who decided this was work? An agent did, unprompted. One
 *    `bd list --label agent-filed` finds every bead that arrived this way, endorsed or
 *    not, which is the only way to audit the feature after the marker has come off.
 * 3. **`discovered-from:<bead>`** — how was it found? The edge back to the work that
 *    turned it up, so the trail survives the session that had the reason on screen.
 *    It is a `related` edge in bd's vocabulary, not a blocker: the work carries on.
 *
 * **The priority ceiling.** An agent-filed bead is clamped to `PRIORITY_FLOOR` or
 * lower-ranked, so what an agent decided was urgent cannot outrank what Adam chose.
 * This matters much less than it did before the hold existed — a held bead is not in
 * any queue at whatever priority — but it still decides where the bead lands the
 * moment it *is* endorsed, and "the agent said P0" is not a reason for it to be the
 * next thing worked. The clamp is recorded on the bead rather than applied silently,
 * because a session that filed at P0 was saying something worth reading.
 *
 * Nothing here writes the description the agent gave: `notes` carries the provenance,
 * the rationale and any duplicate warning, and the description stays exactly what was
 * filed. The endorsement queue (bc-3zo9.4) renders both, and a bead whose description
 * had a paragraph of daemon prose bolted onto it reads as beadcause's opinion rather
 * than as the work.
 */
import { UNENDORSED } from './endorse.js';
import { dupeNote } from './proposal.js';

/** Provenance: an agent decided this was work. Survives endorsement, unlike the marker. */
export const FILED_LABEL = 'agent-filed';

/**
 * The best an agent-filed bead may be. Numerically a floor because bd's priorities run
 * 0 (critical) to 4 (backlog) — P0 and P1 are Adam's to hand out.
 */
export const PRIORITY_FLOOR = 2;

/** bd's word for "this is where it came from", and not a blocker. See public/graph.js. */
export const DISCOVERED_FROM = 'discovered-from';

/** `P0`, `0`, `"1"` or nothing → a number bd will take, never worse than the floor. */
export function clampPriority(priority, floor = PRIORITY_FLOOR) {
  const p = Number(String(priority ?? floor).replace(/^p/i, ''));
  const asked = Number.isInteger(p) && p >= 0 && p <= 4 ? p : floor;
  return { priority: Math.max(asked, floor), asked, clamped: asked < floor };
}

/**
 * The `discovered-from` edge, unless the bead already named one.
 *
 * A YAML spec may carry its own `deps`, and one of them may already be a
 * `discovered-from` — an agent filing three beads that hang off each other, most
 * likely. Two edges of the same type between the same pair is noise on the graph
 * sheet, and an agent that wrote its own is more specific than the default.
 */
export function withDiscoveredFrom(deps, from) {
  const have = (deps || []).map((d) => String(d).trim()).filter(Boolean);
  if (!from) return have;
  const edge = `${DISCOVERED_FROM}:${from}`;
  const already = have.some((d) => d === edge || d === from || d.endsWith(`:${from}`));
  return already ? have : [...have, edge];
}

/**
 * The paragraph that says where this came from and what state it is in.
 *
 * Written for the person reading the endorsement queue with no memory of the session
 * that filed it, which is everyone by the next morning. It says the three things they
 * need before deciding: an agent filed this unprompted, it is doing nothing until they
 * say so, and here is what the agent's argument for it was.
 *
 * **An auto-endorsed bead gets the opposite sentence, and it matters more than the
 * first one.** With `autoEndorse` on for the space (lib/spaces.js) this bead is not
 * waiting for anybody: it is in `bd ready`, and the next advocate tick may open a
 * session on it. The reader of that bead is no longer somebody deciding whether to
 * allow it — they are somebody finding out it was allowed, possibly after the work has
 * already run — so the note has to say plainly that no human passed it and where the
 * setting that decided so lives. A bead saying "nothing will open a session on it until
 * you endorse it" over a session already running on it is the worst of the two errors.
 */
export function provenanceNotes(bead, { from = '', clamped = false, asked = null, endorsed = false } = {}) {
  const lines = [
    `_Filed by an agent${from ? ` while working ${from}` : ''}, at the moment it found the work._ ` +
      (endorsed
        ? 'It arrived **endorsed**: auto-endorsement is on for this space, so nobody read it before ' +
          'it became workable and an advocate may open a session on it. Turn that off on the ' +
          "space's details screen if you want the tap back."
        : `It is \`${UNENDORSED}\`: nothing will open a session on it until you endorse it.`),
  ];
  if (bead?.rationale) lines.push('', `**How it was found:** ${bead.rationale}`);
  if (clamped) {
    lines.push(
      '',
      `**Filed as P${asked}, held at P${PRIORITY_FLOOR}.** What an agent files may not outrank the ` +
        'work you chose; raise it yourself if it really is that.'
    );
  }
  if (bead?.duplicate) {
    lines.push(
      '',
      `**Looks like a duplicate** — ${dupeNote(bead.duplicate)}. Filed anyway, flagged rather than ` +
        'dropped: the agent that found it could not read the tracker, and a near-miss title is not ' +
        'proof of the same bug. Revoking it is one tap.'
    );
  }
  if (bead?.notes) lines.push('', bead.notes);
  return lines.join('\n');
}

/**
 * One normalised bead (lib/proposal.js shape) → the arguments `Bd.create` takes.
 *
 * Separate from `fileBeads` because it is the whole of the decision-making and none of
 * the I/O: what the labels are, what the priority becomes, what the edge is. A test
 * that wants to know whether the marker goes on should not have to run a tracker.
 */
export function beadToIssue(bead, { from = '', floor = PRIORITY_FLOOR, labels = [], endorsed = false } = {}) {
  const { priority, asked, clamped } = clampPriority(bead?.priority, floor);
  return {
    title: bead.title,
    type: bead.type || 'task',
    priority,
    body: bead.description || '',
    acceptance: bead.acceptance || '',
    design: bead.design || '',
    notes: provenanceNotes(bead, { from, clamped, asked, endorsed }),
    // The marker first: a reader of `bd show` should see why it is not being worked
    // before anything else. `bead.labels` is whatever the agent asked for, minus
    // `human` — lib/proposal.js already drops that, since a filed bead is not a
    // question and must not land in the inbox as one.
    //
    // `endorsed` is the one thing that drops it, and it drops *only* it: the space said
    // the tap was a formality, not that the provenance was. `agent-filed` and the
    // `discovered-from` edge below are what a bead filed this way can still be audited
    // by afterwards, and with the hold gone they are the only thing left that says an
    // agent decided this — so they are not conditional on anything.
    labels: [...(endorsed ? [] : [UNENDORSED]), FILED_LABEL, ...labels, ...(bead.labels || [])].filter(
      (l, i, all) => l && all.indexOf(l) === i
    ),
    deps: withDiscoveredFrom(bead.deps, from),
    clamped,
    asked,
    endorsed,
  };
}

/**
 * File them for real, one at a time, and report what happened to each.
 *
 * **One bead's failure does not lose the others.** Embedded Dolt is single-writer and
 * a create can lose a lock race (`Bd.create` retries four times, and then it is a real
 * error); a session filing three discoveries at 02:00 should not have the third eaten
 * because the second collided. So each is caught, and the caller gets both lists.
 *
 * `from` is verified before it becomes an edge. A `--from` naming a bead that is not
 * in this workspace — a typo, or the id of a bead in another repo's tracker — would
 * otherwise fail the whole `bd create` at the dep, and losing the bead over the
 * provenance is the wrong way round. It is dropped with a warning instead.
 *
 * `endorsed` is decided by the caller, not here — `bin/file.js` asks
 * `autoEndorseAllowed` for the workspace it was given. It is reported back on the
 * result as well as applied, because the one thing the filing session must not do is
 * tell Adam his bead is waiting for a tap when it is not: the sentence the command
 * prints has to come from what actually happened, not from what the brief said would.
 */
export async function fileBeads(
  bd,
  workspace,
  beads,
  { from = '', floor = PRIORITY_FLOOR, onWarn = () => {}, endorsed = false } = {}
) {
  let source = String(from || '').trim();
  if (source) {
    let known = false;
    try {
      known = await bd.exists(workspace, source);
    } catch {
      known = false;
    }
    if (!known) {
      onWarn(`${source} is not a bead in ${workspace.name || 'this workspace'} — filing without the ${DISCOVERED_FROM} edge`);
      source = '';
    }
  }

  const filed = [];
  const failed = [];
  for (const bead of beads || []) {
    const issue = beadToIssue(bead, { from: source, floor, endorsed });
    try {
      const id = await bd.create(workspace, issue);
      if (!id) throw new Error('bd create returned no id');
      filed.push({
        id,
        title: issue.title,
        priority: issue.priority,
        clamped: issue.clamped,
        endorsed,
        duplicate: bead.duplicate || null,
      });
    } catch (err) {
      failed.push({ title: issue.title, error: String(err?.message || err).split('\n')[0] });
    }
  }
  return { filed, failed, from: source, endorsed };
}
