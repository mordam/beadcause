/**
 * Applying the edges a proposal declared — all of them, whatever any one of them does.
 *
 * bc-arj0.19. Filing bc-khoe from a chat proposal, `bd dep add bc-khoe.5 bc-45yl` was
 * refused — an edge of another type already existed between that pair, and bd holds one
 * edge per pair in either direction — and the creation path **stopped there**. The
 * proposal declared five dependencies; the three that came after the failing one were
 * never attempted. Nothing looked wrong afterwards: nine beads, the right parents, the
 * right text. What was missing was structure, on the beads furthest from where the error
 * was reported, and the error named neither of them.
 *
 * That is bc-arj0's own failure mode arriving by a new route. The dependency was
 * declared, and then existed only as prose in a description.
 *
 * ## The rule
 *
 * **Every declared edge is attempted.** A refusal is recorded against *that* edge and the
 * loop carries on to the next one. Nothing after a bad edge is abandoned, and nothing is
 * rolled back — beads has no transaction, and un-writing four good edges because a fifth
 * was impossible would lose more structure than it saved.
 *
 * **Every failure is reported by id, as the command that would fix it.** A line reading
 * "a dependency was refused" is a line whose reader now has to go and work out which one;
 * `bd dep add bc-khoe.5 bc-45yl — refused: …` is a line they can paste. The failures are
 * also summarised into a single `retryCommand` — every refused edge, joined with `; `, so
 * one paste retries the lot once whatever made them impossible has been dealt with.
 *
 * ## Two kinds of failure, and only one of them is pasteable
 *
 * - **Unresolved** — the proposal named something that is neither one of its own refs nor
 *   a bead the tracker owns to, or a bead named itself. There is no id to paste, so these
 *   are reported one line each and stay out of the retry command.
 * - **Refused** — both ends are real and bd said no. bd's reasons are worth reading (the
 *   commonest by far is the pair already carrying an edge of another type, which
 *   lib/mentions.js draws for free the moment either id appears in the other's prose), so
 *   the first line of what bd said is kept verbatim rather than translated.
 *
 * ## Where it is used
 *
 * The console's create (`/api/console/create` in lib/server.js) and the JIRA ingest
 * (lib/jiraingest.js) — the two places a batch of beads is created from a proposal that
 * declared edges between them. They had two spellings of the same warning and only one of
 * them survived a refusal; this is the one spelling and the one loop.
 *
 * Deliberately not `bd.addDep`'s own problem: a single edge that is refused *is* an error
 * for anything applying one edge on purpose (lib/park.js, a delivery, a supersede), and
 * those callers must keep hearing it as a throw.
 */

/**
 * The first line of whatever bd said, which is the part that names the reason — minus
 * lib/bd.js's own `bd dep add <a> <b> failed in <ws>: ` prefix, which would otherwise
 * repeat the command the warning has already spelled and push the reason off the end of
 * a phone. Same trim, and for the same reason, as `oneLine` in lib/sweep.js.
 */
export function refusalReason(err) {
  const text = String(err?.message ?? err ?? '').trim();
  const first = (text.split('\n').find((l) => l.trim()) || '').trim();
  const colon = first.indexOf(': ');
  const trimmed = colon > 0 && /(failed|timed out) in /.test(first.slice(0, colon)) ? first.slice(colon + 2) : first;
  return trimmed || 'bd refused it and said nothing';
}

/** The pasteable form of one edge. */
export function edgeCommand(from, to) {
  return `bd dep add ${from} ${to}`;
}

/**
 * One paste that retries every edge that could be retried — i.e. every refusal, since an
 * unresolved end has no id to name. Empty when there is nothing retryable, so a caller can
 * test it rather than counting.
 */
export function retryCommand(failed) {
  return (failed || [])
    .filter((f) => f.why === 'refused' && f.from && f.to)
    .map((f) => edgeCommand(f.from, f.to))
    .join('; ');
}

/**
 * Apply every edge in `rows`, and let no one of them cost the rest.
 *
 * `rows` are `{ from, dep, ref }` — `from` is a bead that exists, `dep` is whatever the
 * proposal wrote, a ref of its own or an id it expects the tracker to own to, and `ref`
 * is optional, the proposal's own name for the near end, used only to name it in a
 * warning when it is the near end that could not be resolved. `resolve`
 * turns a `dep` into a real id or null, and is the caller's because the console resolves
 * against ids it just minted plus one `bd show` per outside name, and the ingest against
 * its own map.
 *
 * Never throws. Returns `{ applied, failed, warnings }` — `warnings` being the lines,
 * already spelled, that both callers already had somewhere to put.
 */
export async function applyEdges(bd, workspace, rows, { resolve } = {}) {
  const applied = [];
  const failed = [];
  const warnings = [];
  const at = async (dep) => (resolve ? resolve(dep) : dep);

  for (const { from, dep, ref } of rows || []) {
    let to = null;
    try {
      to = from ? await at(dep) : null;
    } catch {
      to = null;
    }
    if (!from || !to) {
      failed.push({ from: from || null, dep, to: null, why: 'unresolved' });
      // `ref` is what the proposal called the near end, and is the only name there is
      // when the near end is what went missing.
      warnings.push(`${from || ref || dep}: dependency on ${dep} skipped — no such bead`);
      continue;
    }
    if (to === from) {
      failed.push({ from, dep, to, why: 'unresolved' });
      warnings.push(`${from}: dependency on ${dep} skipped — a bead cannot depend on itself`);
      continue;
    }
    try {
      await bd.addDep(workspace, from, to);
      applied.push({ from, to });
    } catch (err) {
      const reason = refusalReason(err);
      failed.push({ from, dep, to, why: 'refused', reason });
      warnings.push(`${edgeCommand(from, to)} — refused: ${reason}`);
    }
  }

  // The summary goes last, and only when it says something the lines above do not: how
  // much of the batch did land, and the one paste that retries the rest.
  if (failed.length) {
    const declared = applied.length + failed.length;
    const retry = retryCommand(failed);
    warnings.push(
      `${failed.length} of ${declared} declared ${declared === 1 ? 'dependency' : 'dependencies'}` +
        ` did not land; the other ${applied.length} did.` +
        (retry ? ` Paste to retry: ${retry}` : '')
    );
  }

  return { applied, failed, warnings };
}
