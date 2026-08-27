/**
 * The next free `CHANGE_LOG.md` entry number in a repo like deluvia's, computed across
 * every branch this checkout knows about — not just whichever one happens to be checked
 * out — plus what an insertion would cost the G0 ledger that counts off that file.
 *
 * `bc-dgx7.61`, a session audit against six sessions (`dv-6cn`, `dv-aps`, `dv-90i`,
 * `dv-gsh`, `dv-i5v`, `dv-3rn.3`) that each worked this out by hand. `dv-6cn` allocated
 * an entry with `grep -n "^## Entry " CHANGE_LOG.md | tail -8`, a Python heredoc to
 * splice it in, and a second Python one-liner to recount the ledger — after first
 * pulling two memory notes to learn it needed to. `dv-3rn.3` found the number it picked
 * was already live on the trunk: two unrelated decisions both filed as `## Entry 078`,
 * because the number was allocated against one branch's tail rather than every branch's.
 * Four more sessions (`dv-90i`, `dv-gsh`, `dv-i5v`, `dv-aps`) filed no entry at all,
 * naming the same two costs as the reason: a re-measure of `docs/G0_CANON_LOCK.md`'s
 * §4 counts, and collision risk against ~20 other live worktrees nobody had looked at.
 *
 * A number is only "free" if no other branch has already claimed it, so this reads
 * `CHANGE_LOG.md` out of **every** local and remote branch `git for-each-ref` can see —
 * a branch with no worktree checked out for it right now still counts, which is the
 * whole point: `dv-3rn.3`'s collision was with a decision already sitting on the trunk,
 * not with anything the session had open.
 *
 * ## What counts as a collision, and what does not
 *
 * `CHANGE_LOG.md` already has a house convention for a genuine on-trunk collision — the
 * second `Entry 078` was renumbered `078b` rather than given a new high number, "so the
 * file stays in date order, matching the existing `023b` convention" (its own note, in
 * the file). `entryHeadings` below keeps that letter suffix as part of the entry's
 * identity, so `078` and `078b` are two different entries, not a duplicate — this must
 * not re-flag a collision the file has already resolved the house way.
 *
 * ## A number seen on many branches is not, by itself, a collision
 *
 * Every branch cut from `main` after entry 104 was written still carries entry 104 —
 * that is inheritance, not three branches independently claiming 104. The thing that
 * makes two occurrences of the same number a real collision is that they hold *different
 * decisions*: two unrelated entries that happen to share a number. So duplicates are
 * judged per entry, not per branch or per file, by comparing each heading's
 * **`Decision:`** field across every branch that has it — the one part of an entry that
 * names what was actually decided. A number every branch agrees on is not a duplicate,
 * however many of them carry it or however their `Status:` and `Chapters affected:`
 * checkboxes have since drifted (see below); the same number holding two different
 * `Decision:` texts *within one branch's file* — the original, un-suffixed `Entry 078`
 * collision — is caught the same way, since that branch's two headings produce two
 * distinct fingerprints for the one key.
 *
 * **Why not compare the whole entry.** `Status:` is a live field — `PENDING
 * PROPAGATION` becomes `PARTIALLY PROPAGATED` becomes `[PROPAGATED]` as work lands, and
 * on main's own Entry 001 it carries a running narrative ("verified 2026-08-07 (audit),
 * re-verified 2026-08-23...") that grows with every re-check. `Chapters affected:`
 * checkboxes tick independently on whichever branch propagated them. Comparing full
 * bodies flagged 68 of deluvia's own entries as "duplicates" this way on a first pass —
 * every one of them the *same* decision, just re-verified or partly propagated on
 * different branches — which would have buried the handful of entries that are a real
 * collision in noise nobody could act on.
 *
 * ## The ledger figures
 *
 * `docs/G0_CANON_LOCK.md` §4 quotes three counts back from `CHANGE_LOG.md` and
 * `scripts/check_g0_canon_lock.py` re-derives them the same way every time it runs:
 * the number of `^## Entry ` headings, and how many lines anywhere in the file read
 * `PENDING PROPAGATION` and `PARTIALLY`. `ledgerCounts` below is exactly that
 * derivation, against the delivery base only (`--base`, `main` by default) — so its
 * numbers are directly comparable to what the ledger's own gate would compute, and
 * `delta` is what those three figures become after one more entry, assumed `PENDING
 * PROPAGATION` on arrival because nothing has had a chance to check off a chapter yet.
 *
 * This module never writes anywhere — it reads refs `git show`/`git cat-file` can see
 * and nothing else. `bin/b7e-entry` is the argv parsing and the printing around it.
 */
import { git, ok, readRefFile } from './gitref.js';
import { pickBase } from './notinmain.js';

/**
 * Every `## Entry NNN[letter]` heading in a `CHANGE_LOG.md` body, in the order they
 * appear, each with its own `body` — the heading through to just before the next one
 * (or EOF), trimmed — and `fingerprint`, its `**Decision:**` field alone, whitespace-
 * collapsed. The template line inside the file's own "Entry Format" section (`## Entry
 * [NNN] — [DATE]`) never matches — `[NNN]` has no digits where this looks for them.
 */
export function entryHeadings(text) {
  if (!text) return [];
  const out = [];
  const re = /^## Entry (\d+)([A-Za-z]?)\b/gm;
  let m;
  while ((m = re.exec(text))) {
    // `digits` keeps the original zero-padded spelling ("090") for display and for the
    // duplicate key; `number` is the numeric value, for maxNumber only — the two only
    // disagree on leading zeros, and next-free must never print one.
    out.push({ number: Number(m[1]), digits: m[1], suffix: m[2] || '', index: m.index });
  }
  for (let i = 0; i < out.length; i += 1) {
    const end = i + 1 < out.length ? out[i + 1].index : text.length;
    out[i].body = text.slice(out[i].index, end).trim();
    out[i].heading = out[i].body.split('\n', 1)[0];
    out[i].fingerprint = decisionFingerprint(out[i].body);
  }
  return out;
}

/**
 * The `**Decision:**` field alone, collapsed to single spaces — what an entry is
 * *for*, with the fields that drift as work lands (`Status:`'s running re-verification
 * narrative, `Chapters affected:`'s checkboxes) left out. See the module doc's "Why not
 * compare the whole entry" for why this, and not the full body, is what identity here
 * means. Falls back to the whole body for an entry that carries no `Decision:` field at
 * all — an older or hand-written format this template does not otherwise expect.
 */
export function decisionFingerprint(body) {
  const m = /\*\*Decision:\*\*\s*([\s\S]*?)(?:\n\*\*|$)/.exec(body);
  return (m ? m[1] : body).replace(/\s+/g, ' ').trim();
}

/**
 * Words of 3+ letters, lowercased — short enough that "not"/"and" still tell two very
 * different decisions apart, but a decision's own significant vocabulary decides it.
 */
function words(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/**
 * How alike two `Decision:` fingerprints are, as a Jaccard ratio over their words —
 * shared words divided by every word either uses.
 *
 * Even the `**Decision:**` field is not immune to routine, unmerged editing: deluvia's
 * real `Entry 002` reads "NOT Slothen" on `main` and "NOT Sloth-hen" on an unmerged
 * branch that had corrected the spelling — the same decision, a five-character fix, not
 * a second decision claiming the number. Exact-string identity flagged 68 of deluvia's
 * own entries as duplicates on first measure; even restricting the compare to just the
 * `Decision:` field (dropping `Status:`'s narrative and `Chapters affected:`'s
 * checkboxes — see the module doc) still left this one and others like it, because nine
 * characters differing in a 200-word paragraph is still a difference under `===`. A
 * ratio catches "corrected a name" and "reworded a sentence" as the same decision while
 * still separating two paragraphs about unrelated topics, which share almost no
 * vocabulary at all.
 */
function decisionsAgree(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size && !B.size) return true;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  const union = A.size + B.size - shared;
  return union === 0 || shared / union >= SIMILARITY_THRESHOLD;
}

/** Below this, two `Decision:` fields are different decisions, not an edit of one. */
const SIMILARITY_THRESHOLD = 0.6;

/** The three figures `docs/G0_CANON_LOCK.md` §4 quotes, re-derived from one ref's text. */
export function ledgerCounts(text) {
  if (!text) return { entries: 0, pendingPropagation: 0, partially: 0 };
  return {
    entries: entryHeadings(text).length,
    pendingPropagation: (text.match(/PENDING PROPAGATION/g) || []).length,
    partially: (text.match(/PARTIALLY/g) || []).length,
  };
}

/**
 * Every local and remote branch this checkout can see, as `{ name, ref }` — `name` is
 * `origin/foo` for a remote-tracking branch, bare `foo` for a local one, so the two are
 * never confused with each other even when they agree. `origin/HEAD` (a symbolic
 * pointer, not a branch of its own) is dropped.
 */
export async function everyBranch(dir) {
  const out = await ok(git(dir, ['for-each-ref', '--format=%(refname:short) %(refname)', 'refs/heads', 'refs/remotes']));
  const branches = [];
  for (const line of String(out || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp < 0) continue;
    const name = trimmed.slice(0, sp);
    const ref = trimmed.slice(sp + 1);
    if (/(^|\/)HEAD$/.test(name)) continue; // origin/HEAD — symbolic, not a branch
    branches.push({ name, ref });
  }
  return branches;
}

/**
 * The whole answer: the next free entry number across every branch, every number
 * already claimed by more than one distinct decision and by which branches, and the
 * ledger's three figures with the delta one more entry would cause. Reads only —
 * nothing here ever writes to `file`.
 */
export async function scanChangeLog(dir, { file = 'CHANGE_LOG.md', base = 'main' } = {}) {
  const branches = await everyBranch(dir);

  let maxNumber = 0;
  const byKey = new Map(); // "096" or "078b" -> [{ fingerprint, heading, branches: [] }, ...]
  for (const b of branches) {
    // eslint-disable-next-line no-await-in-loop -- one branch at a time, a few dozen at most
    const content = await readRefFile(dir, b.ref, file);
    if (content === null) continue; // this branch has no such file
    for (const h of entryHeadings(content)) {
      maxNumber = Math.max(maxNumber, h.number);
      const key = `${h.digits}${h.suffix}`;
      if (!byKey.has(key)) byKey.set(key, []);
      const variants = byKey.get(key);
      // Single-linkage: join the first existing variant this one's Decision field
      // agrees with, rather than requiring an exact match — see decisionsAgree above.
      let variant = variants.find((v) => decisionsAgree(v.fingerprint, h.fingerprint));
      if (!variant) {
        variant = { fingerprint: h.fingerprint, heading: h.heading, branches: [] };
        variants.push(variant);
      }
      variant.branches.push(b.name);
    }
  }

  const duplicates = [];
  for (const [entry, variants] of byKey) {
    if (variants.length < 2) continue; // every occurrence agrees — inheritance, not a collision
    duplicates.push({ entry, variants: variants.map(({ heading, branches }) => ({ heading, branches })) });
  }
  duplicates.sort((a, b) => a.entry.localeCompare(b.entry, undefined, { numeric: true }));

  const baseInfo = await pickBase(dir, base);
  const baseContent = baseInfo ? await readRefFile(dir, baseInfo.ref, file) : null;
  const ledger = ledgerCounts(baseContent);
  const delta = {
    entries: ledger.entries + 1,
    // A fresh entry starts life unpropagated — nothing has had a chance yet to check
    // off a chapter — so it costs the PENDING PROPAGATION count one, not the PARTIALLY
    // one.
    pendingPropagation: ledger.pendingPropagation + 1,
    partially: ledger.partially,
  };

  return {
    file,
    base: baseInfo ? baseInfo.name : null,
    branchesScanned: branches.map((b) => b.name),
    nextFree: maxNumber + 1,
    duplicates,
    ledger,
    delta,
  };
}
