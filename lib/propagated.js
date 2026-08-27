/**
 * One `CHANGE_LOG.md` entry's own propagation checklist, verified against the tree
 * instead of trusted from its own `Status:` line or its own `[x]` marks.
 *
 * `bc-dgx7.82`, a session audit against four sessions (`dv-b5d.32`, `dv-2uu.5`,
 * `dv-gr6.5`, `dv-5eu`) that each independently discovered the same failure: an entry
 * stamped `[PROPAGATED]` whose checklist named a file as done while that file still
 * carried the pre-ruling value. `dv-b5d.32`'s own case — Entry 108 capped Othens at
 * 12'-15', `pipeline/lib/checks.py` still carried 12'-25' under a comment reading
 * "OPEN - do not narrow without dv-5i2.84", and `dv-5i2.84` *is* Entry 108 — is the
 * shape every fixture below reproduces. `lib/count.js` (`bin/b7e-count`) is the
 * primitive underneath: given a literal it counts occurrences at a ref. What this adds
 * is the entry-number-to-literal step — pulling the old/new pair a checklist row
 * stakes out from its own text — plus the per-row VERIFIED/STALE/UNVERIFIABLE
 * judgement `bin/b7e-propagated` prints.
 *
 * ## Why a synthetic fixture, not deluvia's own history, drives the tests
 *
 * The motivating incident is real and dated, but pinning a test to a specific commit
 * in a sibling checkout this repo's CI never clones is exactly the trap named in the
 * memory note `a-real-repo-assertion-in-a-test-rots-between-your-run-and-ci`: deluvia
 * is not fetched here, and its `CHANGE_LOG.md` keeps moving. `test/b7epropagated.mjs`
 * builds a tmp git repo whose Entry 108 fixture reproduces the same shape — a
 * checklist row naming `pipeline/lib/checks.py` and reading `[PROPAGATED]` while the
 * file itself still holds the old figure — and checks the mechanism against that,
 * the same choice `test/b7eentry.mjs` already made for the same reason.
 *
 * ## Reading only ever by ref, never the working tree
 *
 * Every read here goes through `readRefFile` (`git cat-file -p <ref>:<path>`) against
 * a resolved git ref — never `fs.readFileSync` against whatever happens to be checked
 * out. That is what makes "the bear line at the real path rather than in a worktree
 * copy" (the failure `dv-5eu` hit, from a naive tree `grep`) true by construction: a
 * `.claude/worktrees/*` copy is a second working directory, invisible to a ref read,
 * exactly as `lib/count.js`'s own docblock argues for the same reason.
 *
 * ## What "the claim" means, and why most rows are UNVERIFIABLE by design
 *
 * A checklist row is machine-checkable only when its own text stakes out an old value
 * and a new one — most of Entry 108's real rows ("§8 height band capped; the Sloth
 * Clade continuity note now splits tallest from most-massive") describe *what changed*
 * without quoting either figure, and there is no way to turn prose like that into a
 * literal to search for without guessing. `rowClaim` recognises exactly two shapes
 * that do quote both sides — see its own doc — and everything else is UNVERIFIABLE:
 * reported, not silently skipped, so a human reading the output knows the box was
 * never machine-checkable rather than assuming silence means it passed.
 */
import { readRefFile } from './gitref.js';
import { resolveRef } from './count.js';
import { entryHeadings, checklistRows, rowPath, rowClaim, findEntry, fieldOf } from './changelog.js';

// checklistRows/rowPath/rowClaim/findEntry moved to lib/changelog.js under bc-dgx7.100
// (b7e-changelog needs the same heading/span/checklist parsing this module already
// had, and re-deriving it a second time is exactly the drift this family exists to
// avoid) — re-exported here so nothing importing them from this module has to change.
export { checklistRows, rowPath, rowClaim, findEntry };

/** One row, checked against `dir` at `ref`. Never throws — a bad row is UNVERIFIABLE. */
async function verifyRow(dir, ref, row) {
  const filePath = rowPath(row.text);
  const result = { checked: row.checked, text: row.text, path: filePath, exists: null, claim: null, verdict: 'UNVERIFIABLE' };
  if (!filePath) return result;
  const content = await readRefFile(dir, ref, filePath);
  result.exists = content !== null;
  if (!result.exists) return result; // nothing to check a claim against
  const claim = rowClaim(row.text);
  if (!claim) return result; // named a path, staked out no checkable literal
  result.claim = claim;
  const hasOld = content.includes(claim.oldValue);
  const hasNew = content.includes(claim.newValue);
  result.verdict = hasOld ? 'STALE' : hasNew ? 'VERIFIED' : 'UNVERIFIABLE';
  return result;
}

/** The `**Status:**` field's own text, e.g. `[PROPAGATED]`, `PARTIALLY PROPAGATED`. */
const statusOf = (body) => fieldOf(body, 'Status');

/** Which statuses `--all` sweeps — the ones claiming the work already landed. */
const SWEEPABLE_STATUS = /\[PROPAGATED\]|PARTIALLY PROPAGATED/;

/** One entry's checklist, every row verified against `dir` at `ref`. */
export async function verifyEntry(dir, ref, headings, wanted) {
  const heading = findEntry(headings, wanted);
  if (!heading) return null;
  const rows = [];
  for (const row of checklistRows(heading.body)) {
    // eslint-disable-next-line no-await-in-loop -- a handful of rows per entry, at most
    rows.push(await verifyRow(dir, ref, row));
  }
  return {
    entry: `${heading.digits}${heading.suffix}`,
    heading: heading.heading,
    status: statusOf(heading.body),
    rows,
    stale: rows.some((r) => r.verdict === 'STALE'),
  };
}

/**
 * The whole answer for one run: one named entry, or (`all: true`) every entry whose
 * `Status:` claims the work already landed. Never writes anywhere — every read is
 * `readRefFile` against `ref`.
 */
export async function propagated(dir, { ref: refGiven, file = 'CHANGE_LOG.md', entry, all = false } = {}) {
  const ref = await resolveRef(dir, refGiven);
  const text = await readRefFile(dir, ref, file);
  if (text === null) throw new Error(`${file} not found at ${ref}`);
  const headings = entryHeadings(text);

  if (all) {
    const results = [];
    for (const h of headings) {
      if (!SWEEPABLE_STATUS.test(statusOf(h.body) || '')) continue;
      // eslint-disable-next-line no-await-in-loop -- a handful of sweepable entries, at most
      results.push(await verifyEntry(dir, ref, headings, `${h.digits}${h.suffix}`));
    }
    return { ref, file, entries: results.filter(Boolean), stale: results.some((r) => r && r.stale) };
  }

  const result = await verifyEntry(dir, ref, headings, entry);
  if (!result) throw new Error(`no Entry ${entry} in ${file} at ${ref}`);
  return { ref, file, entries: [result], stale: result.stale };
}
