/**
 * Take a bead a studio role is holding — one call in place of the three-round-trip
 * recovery bc-dgx7.97 found seven sessions doing by hand: `bd update <id> --claim`,
 * refused because the assignee named was a routing role rather than a live claim, a
 * memory lookup to learn that the refusal is not a collision, and only then the
 * atomic reassign that actually works. All seven paid for that lookup themselves,
 * every time, before reading a line of the repo they were there to work.
 *
 * `lib/bd.js`'s `CLAIM_ROLE_GUARD_RE` / `claimedBy` say who a plain `--claim`
 * refusal names as the holder; they cannot say whether taking the bead over is
 * *safe*, because bd's own wording never distinguishes a role from a real claim —
 * from its side an assignee is set and it is not you, either way. That is this
 * file's one job: safe when the holder is a name in the workspace's own role
 * roster (`rolesOf`), refused — by name, never guessed past — otherwise, on the
 * assumption a holder outside that roster may be a real person or a live window
 * actually working the bead right now.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The label `take()` writes so `--release` knows what to give back and to whom. */
const TAKEN_PREFIX = 'taken-from:';

/**
 * The workspace's own studio roster, if it names one — every directory under
 * `<root>/ai-context/agents/`. Not a beadcause convention, deluvia's own: it is
 * where bc-dgx7.97's seven prior sessions' actual holders live (sinew, vox, aria,
 * tally, clio, all five among the nineteen names there). A workspace that names no
 * such directory reads back an empty roster, which is the safe default — nothing
 * outside a real roster is ever guessed to be a role, so an unrecognised holder is
 * always refused rather than taken on a hunch.
 */
export function rolesOf(root) {
  if (!root) return [];
  const dir = path.join(root, 'ai-context', 'agents');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The message for a write this call attempted but bd did not apply. */
function guardMessage(beadId, err) {
  const said = String(err?.message || err || '').split('\n')[0];
  if (/precondition/i.test(said)) {
    return `${beadId} moved between the read and the write here — somebody else won the race; re-read and decide again rather than retrying the same guard`;
  }
  return said;
}

/**
 * Give a bead back to the role it was taken from — the other half of `take()`,
 * for a session that is done and would rather hand the relay on than leave the
 * bead sitting `in_progress` under its own name.
 */
async function release(bd, ws, id, row, { dryRun = false } = {}) {
  const labels = row.labels || [];
  const takenLabel = labels.find((l) => l.startsWith(TAKEN_PREFIX));
  if (!takenLabel) {
    return { ok: false, refused: `${id} carries no ${TAKEN_PREFIX} label — b7e-take never took it, so there is nothing recorded to give back` };
  }
  const role = takenLabel.slice(TAKEN_PREFIX.length);
  const actor = String(bd.actor || '').trim();
  if (String(row.assignee || '') !== actor) {
    return { ok: false, refused: `${id} is held by "${row.assignee || '(nobody)'}", not this actor — nothing here to release` };
  }
  if (dryRun) return { ok: true, dryRun: true, released: true, role, would: { assignee: role, status: 'open' } };
  try {
    await bd.casAssign(ws, id, { from: actor, to: role, status: 'open', removeLabel: takenLabel });
  } catch (err) {
    return { ok: false, refused: guardMessage(id, err) };
  }
  const after = await bd.show(ws, id);
  return { ok: true, released: true, role, row: after };
}

/**
 * `take(bd, ws, id, opts)` — see the module docstring for the rule this follows.
 *
 *   - `opts.release` — give the bead back to the role it was taken from, instead.
 *   - `opts.dryRun` — decide and report, write nothing.
 *   - `opts.root` — the checkout to read the role roster from (see `rolesOf`);
 *     omitted or unresolvable reads back an empty roster, never a guess.
 *
 * Returns `{ ok, refused, role, row, released, dryRun, would }` — `refused` is set
 * and nothing was written whenever `ok` is false; `role` is the holder taken from
 * or given back (null when the bead was simply unassigned); `row` is the bead read
 * back after a real write, and `would` describes one that a dry run did not make.
 */
export async function take(bd, ws, id, { release: doRelease = false, dryRun = false, root = null } = {}) {
  const beadId = String(id || '').trim();
  if (!beadId) return { ok: false, refused: 'a bead id is required' };

  let row;
  try {
    row = await bd.show(ws, beadId);
  } catch (err) {
    return { ok: false, refused: `${ws?.name || 'that workspace'} has no bead ${beadId}: ${String(err?.message || err).split('\n')[0]}` };
  }
  if (!row) return { ok: false, refused: `${ws?.name || 'that workspace'} has no bead ${beadId}` };
  if (String(row.status || '').toLowerCase() === 'closed') {
    return { ok: false, refused: `${beadId} is closed — nothing to take` };
  }

  if (doRelease) return release(bd, ws, beadId, row, { dryRun });

  const actor = String(bd.actor || '').trim();

  if (!row.assignee || String(row.assignee) === actor) {
    if (dryRun) return { ok: true, dryRun: true, role: null, would: { assignee: actor, status: 'in_progress' } };
    try {
      await bd.run(ws, ['update', beadId, '--claim']);
    } catch (err) {
      return { ok: false, refused: guardMessage(beadId, err) };
    }
    const after = await bd.show(ws, beadId);
    return { ok: true, role: null, row: after };
  }

  const roles = rolesOf(root);
  if (!roles.includes(row.assignee)) {
    return {
      ok: false,
      refused: `${beadId} is held by "${row.assignee}" (status ${row.status}) — not a name in this workspace's role roster, so it may be a real person or a live window actually working it; coordinate with the holder rather than taking it`,
      holder: row.assignee,
    };
  }

  if (dryRun) return { ok: true, dryRun: true, role: row.assignee, would: { assignee: actor, status: 'in_progress' } };

  try {
    await bd.casAssign(ws, beadId, { from: row.assignee, to: actor, status: 'in_progress', addLabel: `${TAKEN_PREFIX}${row.assignee}` });
  } catch (err) {
    return { ok: false, refused: guardMessage(beadId, err) };
  }
  const after = await bd.show(ws, beadId);
  return { ok: true, role: row.assignee, row: after };
}

/** The printed report `bin/b7e-take` builds from a `take()` result. */
export function describeTake(beadId, result) {
  if (!result.ok) return [`b7e-take ${beadId}: refused — ${result.refused}`];
  if (result.dryRun) {
    const w = result.would;
    const from = result.role ? `taken from "${result.role}"` : 'is already unassigned or yours';
    if (result.released) return [`b7e-take ${beadId}: would release back to "${result.role}" — dry run, nothing written`];
    return [`b7e-take ${beadId}: ${from}; would leave it ${w.assignee} / ${w.status} — dry run, nothing written`];
  }
  const row = result.row || {};
  if (result.released) return [`b7e-take ${beadId}: released back to "${result.role}" — now ${row.status}`];
  const from = result.role ? `taken from "${result.role}"` : 'was unassigned';
  return [`b7e-take ${beadId}: ${from}, now ${row.assignee || '(unassigned)'} / ${row.status}`];
}
