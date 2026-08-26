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
import { entryHeadings } from './changelog.js';

/** A top-level checklist row: `- [ ]` or `- [x]`, never a nested sub-bullet. */
const CHECKBOX_RE = /^- \[([ xX])\] ?(.*)$/;

/**
 * Every checklist row in one entry's body, each with its own full text — the
 * checkbox's own line plus any indented continuation lines directly under it, since a
 * row's prose routinely wraps (Entry 108's `SPECIES_GUIDE.md` row is two lines) and a
 * nested sub-bullet of the same row (the `CHARACTER_CHEATSHEET` row's own detail
 * lines) is part of what that row claims, not a claim of its own — only a line
 * starting `- [ ]`/`- [x]` opens a new row.
 */
export function checklistRows(body) {
  const rows = [];
  let current = null;
  for (const line of body.split('\n')) {
    const m = CHECKBOX_RE.exec(line);
    if (m) {
      current = { checked: m[1].toLowerCase() === 'x', text: m[2] };
      rows.push(current);
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      current.text += ` ${line.trim()}`;
      continue;
    }
    if (line.trim() === '') current = null; // paragraph break ends the continuation
  }
  return rows;
}

/** The first backtick-quoted path-looking token in a row's text, or null. */
const PATH_RE = /`([^`\s]+\.[A-Za-z0-9]+)`/;
export function rowPath(text) {
  const m = PATH_RE.exec(text);
  return m ? m[1] : null;
}

/**
 * The old/new literal pair a row's own text stakes out, or null when it names none.
 *
 * Two shapes cover every checkable row this bead's own examples show:
 *   - a backtick-quoted arrow — `` `OLD` → `NEW` `` (also accepts an ASCII `->`), the
 *     shape a direct before/after swap uses (`` `Barran Orves` → `Kazran Orves` ``);
 *   - a parenthetical "was OLD" paired with "now NEW" elsewhere in the same row — the
 *     convention `dv-b5d.34`'s own two rows used ("trait table, was 12'-22') - now
 *     12'-15'.").
 * Anything else — a row that only describes the change in prose — returns null, and
 * `verifyRow` reports that as UNVERIFIABLE rather than guessing at a literal.
 */
export function rowClaim(text) {
  const arrow = /`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/.exec(text);
  if (arrow) return { oldValue: arrow[1], newValue: arrow[2] };
  const was = /\bwas\s+([^,()]+?)\)/i.exec(text);
  const now = /\bnow\s+([^.,;]+)/i.exec(text);
  if (was && now) return { oldValue: was[1].trim(), newValue: now[1].trim() };
  return null;
}

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
function statusOf(body) {
  const m = /^\*\*Status:\*\*\s*(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

/** Which statuses `--all` sweeps — the ones claiming the work already landed. */
const SWEEPABLE_STATUS = /\[PROPAGATED\]|PARTIALLY PROPAGATED/;

/**
 * One entry heading by number, with an optional letter suffix (`078b`).
 *
 * A bare number with no suffix given matches the entry with an empty suffix when one
 * exists; failing that, it matches only when exactly one entry anywhere carries that
 * number — an unsuffixed request against a `078`/`078b` pair with no bare `078` is
 * ambiguous and returns null rather than guessing which one was meant.
 */
export function findEntry(headings, wanted) {
  const m = /^(\d+)([A-Za-z]?)$/.exec(String(wanted ?? '').trim());
  if (!m) return null;
  const [, digits, suffix] = m;
  if (suffix) {
    return headings.find((h) => h.digits === digits && h.suffix.toLowerCase() === suffix.toLowerCase()) || null;
  }
  const candidates = headings.filter((h) => h.number === Number(digits));
  const bare = candidates.find((h) => h.suffix === '');
  if (bare) return bare;
  return candidates.length === 1 ? candidates[0] : null;
}

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
