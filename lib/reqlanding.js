/**
 * What happens to a requirement at the moment a bead lands.
 *
 * One function, called from `notePending` in lib/advocate.js, because that is the single
 * place in this system that knows a merge commit and a bead at the same time. Everything
 * bc-fvmx records as *evidence* rather than forecast is written from here.
 *
 * Three outcomes, and the third is the one that makes the feature honest:
 *
 * 1. **The bead names requirements.** The ids go onto the landing commit's note (the
 *    authoritative record — see lib/reqindex.js) and an `observed-from-diff` edge goes
 *    into the index, carrying the files that merge actually changed. This is the strongest
 *    evidence available anywhere in the system: not what somebody thought the bead was
 *    about, but what a diff in main did while closing it.
 * 2. **The bead names nothing and the corpus is readable.** It is labelled for gleaning
 *    (lib/reqglean.js) and the P0 advocate is asked, on its next run, what shipped here.
 *    The label is the queue.
 * 3. **There is no corpus on this machine.** Nothing happens at all — no note lines, no
 *    label, no index write. Every personal repo lands in this branch, and a landing there
 *    produces byte-for-byte the note it produced before bc-fvmx existed.
 *
 * **Nothing here throws into the sweep.** A landing that cannot be recorded is a landing
 * that is still a landing: the note is the thing that must be written, the index can be
 * rebuilt from it, and a graph that fails a merge sweep would be the worst possible
 * trade. Errors come back in the return value, and the caller logs them.
 */
import { readRequirements } from './beadreqs.js';
import { GLEAN_LABEL, withGlean } from './reqglean.js';
import { filesInMerge, noteLines, record } from './reqindex.js';

/**
 * Record one landing. Returns `{ extra, ids, files, glean, error }`.
 *
 * `extra` is what lib/sessionlog.js appends to the note — '' when there is nothing to say,
 * which is what keeps the old note shape intact for repos with no requirements.
 *
 * `glean` is true when this bead should be asked about later. It is only ever true where a
 * corpus exists: with no vocabulary on the machine there is nothing an advocate could be
 * asked to name, and labelling beads for a question nobody can answer would fill the
 * tracker with a permanent backlog.
 */
export async function recordLanding({
  main,
  sha,
  bead,
  workspace,
  issue = null,
  corpus = null,
  provenance = 'observed-from-diff',
} = {}) {
  const out = { extra: '', ids: [], files: [], glean: false, error: '' };
  if (!main || !sha) return out;
  if (!corpus?.ids?.size) return out;

  const { ids } = readRequirements(issue, corpus);
  try {
    out.files = await filesInMerge(main, sha);
  } catch {
    // A commit `git show` cannot read is one the note still belongs on. The file list is
    // the optional half of the record; the ids are not.
    out.files = [];
  }

  if (!ids.length) {
    out.glean = true;
    return out;
  }

  out.ids = ids;
  out.extra = noteLines({ ids, files: out.files });
  try {
    await record({
      ids,
      repo: main,
      commit: sha,
      bead,
      workspace,
      files: out.files,
      provenance,
    });
  } catch (err) {
    // The index is a cache and `rebuildFrom` exists precisely for this: the note is going
    // to be written either way, so the edge is recoverable and the landing is not at risk.
    out.error = err.message.split('\n')[0];
  }
  return out;
}

/**
 * Label a landed bead as owing a requirement, and write down what it landed as.
 *
 * Separated from `recordLanding` because it is the one part that writes to the *tracker*
 * rather than to git, and the caller owns the tracker client. Returns whether it wrote.
 *
 * The label and the block go on together, in one `bd update`, because they are one fact:
 * a bead carrying the label with no block is one the advocate can be asked about but
 * cannot answer cheaply, and that is precisely the brief that gets skipped.
 *
 * Already labelled means already asked. Re-writing the block on every sweep would move the
 * evidence to whichever landing was noticed last, and `notePending` retries — so the
 * commit recorded would drift away from the one that actually carried the work.
 */
export async function markForGlean(bd, workspace, id, issue = null, { commit = '', files = [] } = {}) {
  const labels = (issue?.labels || []).map((l) => String(l).trim());
  if (labels.includes(GLEAN_LABEL)) return false;
  const notes = withGlean(issue?.notes, { commit, files });
  await bd.update(workspace, id, { addLabels: [GLEAN_LABEL], ...(notes ? { notes } : {}) });
  return true;
}
