/**
 * `blocked-by:<workspace>/<id>` — a blocker that lives in a tracker `bd dep add` cannot
 * reach.
 *
 * bc-bmry.7. bc-bmry.6 named dv-265 as the thing it was waiting on, in prose: "BLOCKED
 * ON the charter amendment (dv side)". dv-265 is in the deluvia tracker; bc-bmry.6 is in
 * beadcause's. `bd dep add` reads both ids from *one* `BEADS_DIR`, so there is no edge
 * that could ever be written — the block existed only as a sentence a human wrote in the
 * description. `bd ready` had no reason to think bc-bmry.6 was anything but ordinary
 * open work, so it sat in every queue, the advocate opened an unattended window on it,
 * and the session's whole job was to read the description, discover the block, and stop.
 * That is the failure this file exists to stop happening a second time.
 *
 * The shape is bc-xl7n.71's (lib/superseded.js), because it is the same shape: two
 * trackers, no edge that can span them, so the fact goes on a label instead. What is
 * different is the ending. A `superseded-by:` marker is waiting to be let *out of the
 * tracker* — closing it is a judgement only Adam can make, so the sweep asks. A
 * `blocked-by:` marker is waiting to be let *back into the queue* — the far bead closing
 * is a fact, not a judgement, so the sweep here just clears the marker and says so in a
 * comment. No card, no `human` label, nothing for Adam to tap. See `sweepFarBlocks`.
 *
 * Two layers, same discipline as every other hold in this repo:
 *
 * 1. **A filter**, in `Bd.ready` — a marked bead is out of every queue, exactly as a
 *    `superseded-by:` one is, and for the identical reason: the marker carries the far
 *    id in it, so there is no fixed string for `--exclude-label` and the filter is a row
 *    check and nothing else.
 * 2. **A refusal**, in `openWorkSession` — the launcher asks the tracker itself, and a
 *    marked bead handed straight to it still cannot be worked.
 *
 * Deliberately **workspace-qualified only** — `<workspace>/<id>`, never a bare id. A
 * same-tracker block already has a real mechanism (`bd dep add`, lib/park.js), which
 * draws an edge bd itself understands and which every other tool already reads
 * correctly. This marker exists for the one case a real edge cannot cover; accepting a
 * bare id here would just be a second, weaker way to spell what `bd dep add` already
 * does properly, and two ways to hold the same bead is one more than a reader can trust.
 */

/** The marker's prefix. One spelling, in one place — three would be the same as none. */
export const BLOCK_PREFIX = 'blocked-by:';

/** `blocked-by:deluvia/dv-265`. What gets written, and what the sweep reads back. */
export const blockLabel = (workspace, id) => `${BLOCK_PREFIX}${String(workspace || '').trim()}/${String(id || '').trim()}`;

/**
 * `<workspace>/<id>` — the only shape a target may take. The workspace half is
 * deliberately permissive here — `[^/\s]+`, not a charset guess at what a directory
 * basename may contain — because the real check is `parseBlockTarget`'s whitelist below,
 * not this pattern. Mirrors `QUALIFIED_RE` in lib/superseded.js.
 */
const QUALIFIED_RE = /^([^/\s]+)\/([a-z][a-z0-9]*-[a-z0-9.]+)$/i;

/**
 * Parse a marker's target into its two halves. Unlike `parseSupersedeTarget`, a bare id
 * is not a valid shape at all — see the file header for why — so failure to match
 * `QUALIFIED_RE` is refused the same way an unknown workspace is.
 *
 * Returns `{ workspace, id }` on success. On failure returns `{ workspace: '', id: '',
 * reason }`, where `reason` is the sentence both `mark` and `beadcause-block` refuse
 * with — there is exactly one place that decides what a bad target says.
 */
export function parseBlockTarget(raw, knownWorkspaces = null) {
  const s = String(raw || '').trim();
  const m = QUALIFIED_RE.exec(s);
  if (!m) {
    return {
      workspace: '',
      id: '',
      reason: `${s || 'that'} is not <workspace>/<id>, and a marker naming one holds a bead nothing could ever clear`,
    };
  }
  const [, wsName, id] = m;
  const known = Array.isArray(knownWorkspaces) ? knownWorkspaces : [];
  if (!known.includes(wsName)) {
    return {
      workspace: '',
      id: '',
      reason: `${wsName} is not a workspace this beadcause knows about, and a marker naming one holds a bead nothing can ever check`,
    };
  }
  return { workspace: wsName, id };
}

/**
 * The bead this one is blocked on, as `<workspace>/<id>`, or `''`. Takes a `bd --json`
 * row, or anything carrying `labels`. A label whose target does not parse as
 * `<workspace>/<id>` is ignored — it is not a marker, so it holds nothing. No workspace
 * whitelist check here, same as `supersededBy`: reading trusts what `mark` already
 * validated when the label was written.
 */
export function blockedByFar(issue) {
  for (const raw of issue?.labels || []) {
    const label = String(raw).trim();
    if (!label.startsWith(BLOCK_PREFIX)) continue;
    const target = label.slice(BLOCK_PREFIX.length).trim();
    if (QUALIFIED_RE.test(target)) return target;
  }
  return '';
}

/** Does this bead carry the marker at all? */
export const isBlockedElsewhere = (issue) => Boolean(blockedByFar(issue));

/**
 * Why this bead may not be worked.
 *
 * `status: 409` and `blockedElsewhere: true`, matching lib/endorse.js's and
 * lib/superseded.js's refusal shape field for field: a caller can tell this from a
 * launch that failed, and the advocate has no business retrying it.
 */
export const refusal = (id, target) =>
  Object.assign(new Error(`${id || 'that bead'} may not be worked — it is ${BLOCK_PREFIX}${target}, waiting on ${target} in another tracker`), {
    status: 409,
    blockedElsewhere: true,
    blockedByFar: target,
  });

/**
 * The gate, given a row the caller already read from the tracker.
 *
 * Same shape as `assertNotSuperseded`: no `bd` and no call, because it sits immediately
 * after `assertEndorsed` in `openWorkSession`, which has just paid for the `bd show` and
 * hands over what it read.
 */
export function assertNotBlockedElsewhere(issue) {
  const target = blockedByFar(issue);
  if (target) throw refusal(issue?.id, target);
  return issue;
}

/** The first line of whatever `bd` said, rather than `execFileSync`'s account of the exit code. */
const said = (err) => {
  const captured = String(err?.stderr || '').trim() || String(err?.stdout || '').trim();
  const line = (captured || String(err?.message ?? err ?? '')).split('\n').filter(Boolean)[0] || '';
  return /^Command failed:/.test(line.trim()) ? 'bd refused it and said why on the line above' : line.trim();
};

/**
 * Put the marker on: the two writes, in the order that cannot leave a bead worse than it
 * started.
 *
 * `bd` is a **synchronous** runner, `(argv) => stdout`, the same shape `bin/supersede.js`
 * takes — not the async `Bd` its sibling in lib/superseded.js does. This runs in a
 * worker's terminal, one command, one bead, exit and gone.
 *
 * `row` is handed in rather than fetched — the caller has already paid for the `bd show`
 * deciding whether to call this at all.
 *
 * **Order: label, then status.** The label is the guarantee — it is what `Bd.ready`
 * filters and what `openWorkSession` refuses on — so it goes first, because a failure
 * afterwards then leaves a bead that is *held* and short of nothing but a status flip,
 * rather than one that never got marked at all. Status is second and is not
 * housekeeping: a worker reaches this having *claimed* its own bead, `bd ready` returns
 * open rows only, and a marked bead left `in_progress` is invisible to
 * `sweepFarBlocks` forever — held, with nothing ever checking whether the far bead has
 * closed.
 *
 * There is deliberately no third write: unlike `mark` in lib/superseded.js there is no
 * edge to attempt, because there is no case here where one is even possible — every
 * target this function accepts is cross-workspace by construction (`parseBlockTarget`
 * refuses anything else), and no tracker spans two Dolt databases.
 *
 * Never throws. Returns `{ marked, held, reopened, alreadyMarked, refused, notes }`.
 * `refused` is a sentence and nothing was written; `held: true` on success, always,
 * because the marker alone is the whole mechanism here.
 */
export function mark(bd, id, target, { row = null, knownWorkspaces = null } = {}) {
  const out = { marked: false, held: false, reopened: false, alreadyMarked: false, refused: '', notes: [] };
  const beadId = String(id || '').trim();
  const raw = String(target || '').trim();

  if (!beadId || !raw) return { ...out, refused: 'both the bead and what it is blocked on have to be named' };
  const parsed = parseBlockTarget(raw, knownWorkspaces);
  if (parsed.reason) return { ...out, refused: parsed.reason };
  if (!row) return { ...out, refused: `no bead ${beadId} here — nothing was written` };
  if (String(row.status || '').toLowerCase() === 'closed') {
    return { ...out, refused: `${beadId} is already closed, so there is nothing to hold` };
  }

  const label = blockLabel(parsed.workspace, parsed.id);
  const carried = blockedByFar(row);
  if (carried) {
    if (carried.toLowerCase() === `${parsed.workspace}/${parsed.id}`.toLowerCase()) {
      // A re-run, and it must look like one — the same discipline `mark` in
      // lib/superseded.js uses for its own already-marked case.
      return { ...out, marked: true, held: true, alreadyMarked: true, notes: [`${beadId} was already marked ${label} — nothing to do`] };
    }
    return {
      ...out,
      refused:
        `${beadId} already carries ${BLOCK_PREFIX}${carried}. Two markers on one bead is two blockers nothing can ` +
        `reconcile, so take the first one off deliberately if ${raw} is the better answer.`,
    };
  }

  try {
    bd(['label', 'add', beadId, label]);
    out.marked = true;
    out.held = true;
  } catch (err) {
    return { ...out, refused: `could not label ${beadId} — ${said(err)}. Nothing else was written.` };
  }

  if (String(row.status || '').toLowerCase() === 'in_progress') {
    try {
      bd(['update', beadId, '--status=open']);
      out.reopened = true;
    } catch (err) {
      out.notes.push(
        `${beadId} is still \`in_progress\` (${said(err)}) — and \`bd ready\` is open rows only, so nothing will ` +
          `ever check whether ${raw} has closed. Run \`bd update ${beadId} --status=open\` before you leave.`
      );
    }
  }

  return out;
}

/**
 * Clear every marked bead whose far blocker has closed. Returns what it checked and
 * what it deliberately skipped.
 *
 * `bd.readyFarBlocked` is the right list to walk, not `bd.ready` — `Bd.ready` itself
 * filters `isBlockedElsewhere` rows out (the whole point of the marker), so asking it
 * here would mean this sweep could never see the very beads it exists to check.
 * `readyFarBlocked` runs the same underlying `bd ready --json` with none of that
 * filtering, exactly the way `readySuperseded` does for `superseded-by:` beads — a
 * marked bead has no local edge holding it (the whole reason it needed a label at all),
 * so bd's own dependency graph still counts it `open`/unblocked and still returns the row.
 *
 * A missing or unreadable far bead is skipped rather than acted on. The tracker being
 * mid-write and the bead genuinely not existing are indistinguishable from here, and
 * clearing the marker on a guess would be the one mistake this mechanism exists to
 * prevent — a bead let back into the queue on evidence that was actually a hiccup.
 *
 * `workspaces` is `cfg.workspaces`, the full list, so a marker's workspace half can be
 * resolved to a `{ name, dir }` to hand `bd.show`. Every write this function makes (the
 * label removal, the comment) still lands on `ws` — only the *reading* of the far bead
 * crosses over. Omit `workspaces` and every marked bead is simply unreadable from here —
 * skipped and logged, same as an unknown workspace name.
 */
export async function sweepFarBlocks(bd, ws, { workspaces = null } = {}) {
  const out = { ok: false, reason: '', checked: 0, cleared: [], skipped: [] };

  let rows;
  try {
    rows = await bd.readyFarBlocked(ws);
  } catch (err) {
    out.reason = `could not read the ready queue — ${String(err.message || err).split('\n')[0]}`;
    return out;
  }

  const knownWorkspaces = (workspaces || []).map((w) => w.name);

  out.ok = true;
  for (const row of rows || []) {
    const raw = blockedByFar(row);
    if (!raw) continue;
    out.checked += 1;

    const target = parseBlockTarget(raw, knownWorkspaces);
    if (target.reason) {
      out.skipped.push({ id: row.id, why: `it names ${raw}, and ${target.reason}` });
      continue;
    }
    const farWs = (workspaces || []).find((w) => w.name === target.workspace);
    if (!farWs) {
      out.skipped.push({ id: row.id, why: `it names ${raw}, a workspace this sweep was not given` });
      continue;
    }

    let far;
    try {
      far = await bd.show(farWs, target.id);
    } catch (err) {
      out.skipped.push({ id: row.id, why: `cannot read ${target.id} in ${target.workspace} — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }
    if (!far) {
      out.skipped.push({ id: row.id, why: `it names ${raw}, which the ${target.workspace} tracker does not have` });
      continue;
    }
    if (String(far.status || '').toLowerCase() !== 'closed') {
      // The ordinary case for a live block, and not worth a line anywhere: the marker
      // is doing its job and there is nothing to clear yet.
      continue;
    }

    try {
      await bd.removeLabel(ws, row.id, blockLabel(target.workspace, target.id));
    } catch (err) {
      out.skipped.push({ id: row.id, why: `could not clear the marker — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }
    try {
      await bd.comment(ws, row.id, `${raw} has closed in ${target.workspace} — the cross-tracker block is cleared, and this is ordinary work again.`);
    } catch {
      // The label removal is the half that matters — it is what puts the bead back in
      // every queue. A comment that did not land costs a sentence of context, not the fix.
    }
    out.cleared.push({ id: row.id, title: row.title || '', target: raw });
  }

  return out;
}

/** One line for the log and the monitor card. Empty when the sweep found nothing to say. */
export function describeFarBlocks(result) {
  if (!result.ok) return result.reason ? `far-block sweep skipped — ${result.reason}` : '';
  if (!result.cleared.length) return '';
  const named = result.cleared.map((c) => `${c.id} (was blocked on ${c.target})`).join(', ');
  return `cleared ${result.cleared.length} cross-tracker block${result.cleared.length === 1 ? '' : 's'} — ${named}`;
}
