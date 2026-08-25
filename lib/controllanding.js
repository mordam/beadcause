/**
 * What happens to a control at the moment a bead lands — and who owns the note.
 *
 * lib/reqlanding.js is the sibling: one function, called from `notePending` in
 * lib/advocate.js, because that is the single place in this system that knows a merge
 * commit and a bead at the same time. Everything recorded as *proof* rather than forecast
 * is written from here, and the reason it is written here rather than by the worker is the
 * bead's own sentence — a merge naming a control writes the edge **without anyone
 * remembering to**. A control programme whose evidence depends on somebody remembering is
 * a control programme with a gap exactly where the week was busy.
 *
 * ## This module composes the whole note, and that is the awkward part
 *
 * A landing note has one `files:` line because a landing has one diff. Both halves of the
 * evidence layer want it: lib/reqindex.js's `noteLines` writes `requirements:` and
 * `files:`, and lib/controlindex.js needs `files:` too when there is no requirements
 * corpus on this machine — which is every personal install and this repo's own.
 *
 * `parseNote` on both sides reads the **first** match of a key. Two `files:` lines would
 * therefore not be an error, a warning, or anything visible: one would be read and the
 * other would sit in the note looking authoritative. So the composition is explicit and
 * lives in one place. {@link recordControlLanding} takes the requirements half's `extra`,
 * adds the `controls:` line, and adds `files:` only if the string it was handed does not
 * already carry one.
 *
 * The alternative — each half writing its own note fragment and something concatenating
 * them — is the version that produces the duplicate, and it produces it only on installs
 * that have both, which is the smallest population and the one that matters most.
 *
 * ## Three outcomes, and the third is why this is safe to wire in
 *
 * 1. **The bead names controls.** The ids go onto the landing commit's note (the
 *    authoritative record) and an `observed-from-diff` edge goes into the index, carrying
 *    the files that merge actually changed.
 * 2. **The bead names controls that do not resolve.** They are dropped, and `dropped`
 *    comes back so the caller can say so out loud. lib/beadcontrols.js's argument: an
 *    agent that is not told writes the same invented id every run.
 * 3. **The bead names nothing.** Nothing happens — no note lines, no index write. Most
 *    beads exercise no control, and a landing there produces byte-for-byte the note it
 *    produced before any of this existed. There is no equivalent of `req-glean` here on
 *    purpose: a control the corpus has and nothing claims is already visible, by name, as
 *    `unevidenced` in lib/controlcoverage.js, and labelling every unremarkable bead to ask
 *    an advocate about SOC 2 would be a queue with no end.
 *
 * **Nothing here throws into the sweep.** A landing that cannot be recorded is still a
 * landing: the note is the thing that must be written, the index can be rebuilt from it,
 * and a graph that failed a merge sweep would be the worst possible trade. Errors come back
 * in the return value and the caller logs them.
 */
import { readControls } from './beadcontrols.js';
import { commitDate, fileLines, noteLines, record } from './controlindex.js';
import { filesInMerge } from './gitref.js';

/** Does this note text already carry a `files:` line? See the header. */
const hasFiles = (text) => /^files:\s*\S/m.test(String(text || ''));

/**
 * Record one landing. Returns `{ extra, ids, dropped, files, error }`.
 *
 * `extra` is the **whole** tail of the note, requirements included — it is `base` with the
 * control lines spliced in, so the caller passes this to `noteMerge` instead of what
 * lib/reqlanding.js handed it. When the bead names no control it is `base` unchanged,
 * which is what keeps the note byte-for-byte identical for the beads that name nothing.
 *
 * `files` is what the caller already worked out, if it did. lib/reqlanding.js computes it
 * and then returns early on an install with no requirements corpus, so an empty list is
 * ambiguous between "nothing to compute" and "not computed" — and this asks git itself
 * rather than either believing that or importing the requirements layer to find out. The
 * helper is in lib/gitref.js for exactly that reason.
 */
export async function recordControlLanding({
  main,
  sha,
  bead,
  workspace,
  issue = null,
  base = '',
  files = [],
  provenance = 'observed-from-diff',
} = {}) {
  const out = { extra: String(base || ''), ids: [], dropped: [], files: [...files], error: '' };
  if (!main || !sha) return out;

  const { ids, dropped } = readControls(issue);
  out.dropped = dropped;
  if (!ids.length) return out;
  out.ids = ids;

  if (!out.files.length) {
    try {
      out.files = await filesInMerge(main, sha);
    } catch {
      // A commit `git show` cannot read is one the note still belongs on. The file list is
      // the optional half of the record; the ids are not.
      out.files = [];
    }
  }

  const lines = [noteLines({ ids })];
  if (!hasFiles(out.extra)) {
    const line = fileLines({ files: out.files });
    if (line) lines.push(line);
  }
  out.extra = [out.extra.trim(), ...lines.filter(Boolean)].filter(Boolean).join('\n');

  try {
    await record({
      ids,
      repo: main,
      commit: sha,
      bead,
      workspace,
      files: out.files,
      provenance,
      // The date the merge landed, not the date the daemon noticed it. `notePending`
      // retries until the merge commit is found, which can be hours, and this is the
      // number a review period is measured against — see `commitDate`.
      at: await commitDate(main, sha).catch(() => null),
    });
  } catch (err) {
    // The index is a cache and `rebuildFrom` exists precisely for this: the note is going
    // to be written either way, so the edge is recoverable and the landing is not at risk.
    out.error = err.message.split('\n')[0];
  }
  return out;
}
