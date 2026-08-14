/**
 * Which *lines* of a file each side has changed — the specificity a claim refusal was
 * missing.
 *
 * lib/claims.js answers *who* is on a file, and until this that was the whole of the
 * warning. It fired identically for the two cases a reader most needs told apart: two
 * sessions rewriting one function, and two sessions at opposite ends of a thousand-line
 * file. The second is ordinary and merges clean, so a message that cannot tell it from
 * the first teaches you to skip the message — which is how a guard stops working without
 * anybody turning it off (bc-zedm).
 *
 * ## Derived, never stored
 *
 * The obvious build is to record line numbers onto the claim as edits arrive. It does not
 * work, for two reasons that both bite immediately:
 *
 * 1. **Numbers drift.** A session that inserts forty lines at the top of a file has
 *    invalidated every number it recorded before, and nothing in a claim record can know
 *    that happened. The register would go on asserting a line it no longer means.
 * 2. **Two sessions' numbers are in different files.** Separate checkouts, separately
 *    edited: "A touched 120" and "B touched 120" are not statements about the same line,
 *    so comparing them answers nothing.
 *
 * So nothing is stored. Every range here is read out of git at the moment somebody asks,
 * in the one coordinate system the two branches share — the **merge base**, the file as
 * it stood before either of them started. That also disposes of the lifecycle question a
 * stored version would have had: there is nothing to invalidate on merge, rebase or
 * downmerge, because once the work lands the merge base advances past it and the diff
 * empties itself.
 *
 * ## Where the cost is paid, and where it must not be
 *
 * `POST /api/claims` is the hottest write in the daemon — a `PreToolUse` hook in front of
 * every Write and Edit in every session on this Mac — and its budget is a map write and
 * nothing else. So none of this runs on that path. It runs *after* `claims.claim()` has
 * returned `conflict`, which happens a few times a day, and it is the only reason it can
 * afford to spawn git at all. `scripts/claim-guard.sh` is unchanged by it and pays
 * nothing.
 *
 * Everything fails open. A repo git cannot read, a worktree that has been shipped out
 * from under a claim, a `merge-base` with no answer: all of them return `null`, and
 * `refusalFor` falls back to the wording it had before this file existed. A missing
 * detail in a warning is a cost; a hung git in front of an edit is not acceptable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git } from './gitref.js';

/**
 * Git's own default context, and the reason the comparison pads.
 *
 * Two hunks that do not overlap still conflict if they are close enough that their
 * *context* lines do — a merge is decided with three lines either side, so ranges three
 * apart are already touching as far as git is concerned. Padding by the same number is
 * what keeps "these should merge cleanly" from being a promise this cannot keep.
 */
const CONTEXT = 3;

/** A conflict is rare. A slow git in the middle of one is still not worth waiting on. */
const TIMEOUT_MS = 2000;

/** More holders than this on one file and the message is unreadable however it is built. */
const MAX_HOLDERS = 3;

/** How many ranges are printed before the rest become a count. */
const MAX_SPANS = 6;

/**
 * git, or nothing.
 *
 * The only error handling in this file, and it is deliberate: every caller below treats
 * `null` as "cannot say", never as "nothing changed". The two are different answers and
 * conflating them is what would put "you are in different regions" on a file this could
 * not actually read.
 */
async function read(dir, args) {
  try {
    return await git(dir, args, { timeout: TIMEOUT_MS });
  } catch {
    return null;
  }
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * One side of a hunk header as a range.
 *
 * A zero-length side is an insertion *between* two lines rather than a change to any
 * line, and that is not the same fact: `after 564` is where new code went, `564–575` is
 * code that was rewritten. Both are kept because both are printed, and collapsing them
 * would make a pure insertion read as though it had overwritten the line above it.
 */
const span = (start, len) =>
  len > 0 ? { from: start, to: start + len - 1 } : { from: start, to: start, insert: true };

/** Both sides of every hunk in a `--unified=0` diff: `base` to compare with, `now` to print. */
function parse(diff) {
  const base = [];
  const now = [];
  for (const line of diff.split('\n')) {
    const m = HUNK.exec(line);
    if (!m) continue;
    base.push(span(Number(m[1]), m[2] === undefined ? 1 : Number(m[2])));
    now.push(span(Number(m[3]), m[4] === undefined ? 1 : Number(m[4])));
  }
  return { base, now };
}

/** Do these two ranges collide once git's context is allowed for? */
const touches = (a, b) => a.from - CONTEXT <= b.to + CONTEXT && b.from - CONTEXT <= a.to + CONTEXT;

/** Does anything in one set of base ranges touch anything in the other? */
export const overlaps = (as, bs) => as.some((a) => bs.some((b) => touches(a, b)));

/**
 * Ranges as a person reads them.
 *
 * Capped, because a file somebody has rewritten produces forty hunks and a refusal that
 * lists forty hunks is a refusal nobody finishes reading. The count of what was dropped
 * stays, so the message never claims to be the whole story when it is not — the same
 * rule the workflow guidance states as "no silent caps".
 */
export function render(spans) {
  if (!spans || !spans.length) return '';
  const shown = spans
    .slice(0, MAX_SPANS)
    .map((r) => (r.insert ? `after ${r.from}` : r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`))
    .join(', ');
  return spans.length > MAX_SPANS ? `${shown}, +${spans.length - MAX_SPANS} more` : shown;
}

/**
 * What one worktree has done to one file since `base` — committed and uncommitted alike.
 *
 * One `git diff` covers both, which is the reason it is a diff against a base commit
 * rather than `git log -p`: a session mid-work has most of its changes in the working
 * tree, and a comparison that saw only its commits would report a busy session as idle.
 */
async function changedSince(dir, file, base) {
  const diff = await read(dir, ['diff', '--unified=0', base, '--', file]);
  if (diff === null) return null;

  const out = parse(diff);
  out.newFile = /^--- \/dev\/null$/m.test(diff);
  if (out.base.length) return out;

  // An empty diff is not always "unchanged". A file git has never seen is invisible to
  // `git diff`, and a file created independently in two worktrees is the most total
  // collision there is — every line of it. `ls-files` tells that apart from a file nobody
  // has touched, and it is paid only in the empty case.
  const tracked = await read(dir, ['ls-files', '--', file]);
  if (tracked === null || tracked.trim()) return out;

  // Untracked *and* on disk. Both halves are needed: a claim can name a path that does not
  // exist in this tree at all — a Write that was refused never created its file — and
  // "you are both creating this" would be a sentence about a file only one of you has.
  const body = onDiskText(dir, file);
  if (body === null) return out;
  const lines = body.split('\n').length - (body.endsWith('\n') ? 1 : 0);
  if (lines < 1) return out;
  return { base: [{ from: 0, to: 0, insert: true }], now: [{ from: 1, to: lines }], newFile: true };
}

/** The file as this worktree has it, or null if it is not there. */
function onDiskText(dir, file) {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8');
  } catch {
    return null;
  }
}

/** This worktree's tip, which is what a merge base is taken between. */
const head = async (dir) => (await read(dir, ['rev-parse', 'HEAD']))?.trim() || null;

/**
 * The regions behind one refused claim.
 *
 * Returns `null` whenever it cannot say something true — no worktree on the record, git
 * unreadable, no common ancestor — and `refusalFor` then says what it always said.
 *
 * Two shapes, because the two collisions are not the same question:
 *
 *   - `{ sameTree: true, dirty }` — one checkout, one working tree, and the two sessions
 *     are writing the same bytes. There is no diff that separates whose lines are whose,
 *     so what is reported is where the tree is dirty, which is where the damage is.
 *   - `{ holders: [...], overlap }` — a holder per worktree, each with its own merge base
 *     (two branches cut at different times do not share one), the ranges each side has in
 *     its own file to print, and whether they collide once mapped back to that base.
 */
export async function regionsForClaim(out) {
  if (!out || out.decision !== 'conflict') return null;
  const me = out.record;
  if (!me || !me.dir || !me.file) return null;

  if (out.sameTree) {
    const dirty = await changedSince(me.dir, me.file, 'HEAD');
    return dirty && dirty.now.length ? { sameTree: true, dirty: dirty.now } : null;
  }

  const mine = await head(me.dir);
  if (!mine) return null;

  const found = await Promise.all(
    out.holders.slice(0, MAX_HOLDERS).map(async (h) => {
      if (!h.dir) return null;
      const theirs = await head(h.dir);
      if (!theirs) return null;
      // Taken from *this* worktree, which can only answer because every worktree of a repo
      // shares one object store — the same fact that lets the register key a claim by the
      // main checkout rather than by whichever tree happened to make it.
      const base = (await read(me.dir, ['merge-base', mine, theirs]))?.trim();
      if (!base) return null;
      const [ours, them] = await Promise.all([
        changedSince(me.dir, me.file, base),
        changedSince(h.dir, h.file, base),
      ]);
      if (!them) return null;
      return {
        session: h.session,
        branch: h.branch,
        bead: h.bead,
        base: base.slice(0, 7),
        // `mine` is allowed to be null or empty and is not a failure: the first edit of a
        // session against a file happens before that session has changed anything in it,
        // which is exactly when this warning is most useful.
        mine: ours,
        theirs: them,
        overlap: Boolean(ours && overlaps(ours.base, them.base)),
      };
    })
  );

  const holders = found.filter(Boolean);
  if (!holders.length) return null;
  return {
    sameTree: false,
    holders,
    overlap: holders.some((h) => h.overlap),
    // Said out loud rather than quietly dropped: a message that describes three of five
    // holders and does not mention the other two reads as if it had covered them all.
    unread: Math.max(0, out.holders.length - MAX_HOLDERS),
  };
}

/**
 * The same reading for a collision that nobody is claiming right now — what `GET
 * /api/claims` hands back when it is asked for regions.
 *
 * The first session on the file (oldest, since `collisions()` sorts by arrival) stands in
 * for "mine" and the rest are holders. There is no asymmetry to preserve here: an overlap
 * is a property of the pair, not of who asked.
 */
export async function regionsForCollision(c) {
  if (!c || !Array.isArray(c.sessions) || c.sessions.length < 2) return null;
  const [first, ...rest] = c.sessions;
  return regionsForClaim({ decision: 'conflict', record: first, holders: rest, sameTree: c.sameTree });
}
