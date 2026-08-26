/**
 * `b7e-notes` — which notes and debriefs are worth reading before working a bead,
 * found by an index over the store's own keys rather than guessed at (bc-khoe.43).
 *
 * `bin/b7e-notes.js` is the argv parsing and the printing; this is the matching, and it
 * answers three different questions rather than one ranked list, because the evidence
 * is three different kinds:
 *
 *   - **bead** — does a note name this bead or one of its ancestors, or read like the
 *     bead itself does? `family()` in lib/memory.js only reaches the immediate parent
 *     (`bc-goo.11` also answers to `bc-goo`, which is all `relevantNotes` needs for one
 *     bead's own brief) — `ancestorIds` below walks every dotted prefix, because a
 *     session asking on purpose should reach as far up the tree as the bead itself does:
 *     `bc-khoe.27.1` also answers to `bc-khoe.27` and to `bc-khoe`.
 *   - **paths** — does a note mention one of the files this bead will touch, or a test
 *     suite that `lib/affected.js` says covers one of them? Substring, not similarity —
 *     a path either appears in a note or it does not, and the case this was built
 *     against (bc-khoe.43's own acceptance criteria: `test/landcheck.mjs` finds
 *     `landcheck-outruns-a-300s-suite-timeout` without that note naming the bead at
 *     all) is exactly a path with nothing else to go on.
 *   - **debriefs** — what earlier runs at this bead's own family (itself, its parent,
 *     its siblings) already reported. The same set `beadcause-memory debriefs` reaches
 *     (`debriefFamily` in lib/memory.js), returned inline instead of needing a second
 *     command — see bin/beadcause-memory's `debriefs` case for the read this mirrors.
 *
 * Nothing here writes anything and nothing here is a new store: every function reads
 * the same two refs `beadcause-memory` already reads (tier 1 notes, tier 4 debriefs).
 */
import path from 'node:path';
import { tokens, similarity, RELEVANT, DEBRIEF_KEEP, DEBRIEF_CHARS, debriefFamily, notesIn } from './memory.js';
import { debriefBeads, readDebriefs } from './sessionlog.js';
import { surfaceOf } from './beadfiles.js';
import { findAffected, toRepoRel, REPO_ROOT } from './affected.js';

// Re-exported rather than re-picked: `debriefBrief` in lib/memory.js already decided
// what "too much" means for the ordinary worker brief, and a caller of `capDebriefs`
// below (including test/b7enotes.mjs) should be able to name that same number without
// a second import.
export { DEBRIEF_KEEP, DEBRIEF_CHARS };

/**
 * The ids a note could name that would make it about this bead's *lineage*, not just
 * the bead itself: its own id, every dotted prefix of it, and whatever `parent` the
 * tracker actually recorded (which may not agree with the dots, for a bead that was
 * reparented after filing — bc-khoe.43 has seen exactly that happen to a sibling).
 *
 * Matched later as a case-insensitive substring against `${key} ${value}`, the same
 * test `family()` in lib/memory.js uses for the immediate parent alone.
 */
export function ancestorIds(bead) {
  const id = String(bead?.id ?? '').trim().toLowerCase();
  const ids = new Set();
  if (id) ids.add(id);
  let cur = id;
  while (cur.includes('.')) {
    cur = cur.slice(0, cur.lastIndexOf('.'));
    if (cur) ids.add(cur);
  }
  const parent = String(bead?.parent ?? '').trim().toLowerCase();
  if (parent) ids.add(parent);
  return [...ids];
}

/** Everything about a bead that is words, in the order it was written — same fields
 * `relevantNotes` in lib/memory.js reads, so a bead scores the same way in both places. */
const beadText = (bead) =>
  [bead?.title, bead?.description, bead?.acceptance_criteria, bead?.acceptance, bead?.design, bead?.notes, (bead?.labels || []).join(' ')]
    .filter(Boolean)
    .join('\n');

/**
 * Group 1: notes that name this bead's lineage, or read like it does.
 *
 * `named` is unconditional, exactly as it is in `relevantNotes` — a note that spells
 * out `bc-khoe.1` is right about that bead close to always, so precision here does not
 * need the similarity floor. `RELEVANT` is `relevantNotes`'s own calibration (a note
 * similar to nothing scores about 1.0; the right one scores 2 to 5) and is reused
 * rather than re-picked, so this and the brief a worker is opened with never disagree
 * about what "reads like the bead" means.
 */
export function notesForBead(notesAll, bead, { keep = 8, floor = RELEVANT } = {}) {
  const ids = ancestorIds(bead);
  const want = tokens(beadText(bead));
  return Object.entries(notesAll || {})
    .map(([key, entry]) => {
      const value = String(entry?.value ?? '');
      const named = ids.filter((id) => `${key} ${value}`.toLowerCase().includes(id));
      return {
        key,
        value,
        at: entry?.at ?? '',
        reason: named.length ? `names ${named[0]}` : 'reads like this bead',
        named: named.length > 0,
        score: similarity(want, tokens(`${key.replace(/-/g, ' ')} ${value}`)),
      };
    })
    .filter((n) => n.value && (n.named || n.score >= floor))
    .sort((a, b) => Number(b.named) - Number(a.named) || b.score - a.score || String(b.at).localeCompare(String(a.at)))
    .slice(0, keep);
}

/** Directory names too generic to mean anything on their own — every third note in this
 * repo's store mentions `lib/` or `test/`, so splitting a path into its parts and keeping
 * these would turn every path into a match against everything. */
const GENERIC = new Set(['lib', 'bin', 'src', 'test', 'tests', 'public', 'scripts', 'node', 'main', 'index']);

const EXT_RE = /\.[A-Za-z0-9]+$/;

/**
 * The strings that would make a note "about" one file: the path itself, its basename,
 * both with the extension stripped, and any word-length piece of the filename — so
 * `test/landcheck.mjs` is found by a note that says "landcheck" and one that quotes the
 * whole path, but not by one that only says "test".
 */
function pathCandidates(file, { strict = false } = {}) {
  const rel = String(file || '').replace(/^\.\//, '');
  if (!rel) return [];
  const base = path.basename(rel);
  // `strict` is for a suite this file only DERIVED (via lib/affected.js), never one the
  // caller actually named: `lib/superseded.js` alone is transitively imported by ~50
  // suites in this repo, and half of them are named after one ordinary English word —
  // `session.mjs`, `check.mjs`, `landed.mjs` — so decomposing those into bare words
  // turns "which suite covers this" into "every note that ever says the word session".
  // The full filename, WITH its extension, is specific enough to keep; the bare stem is
  // not.
  if (strict) return [rel, base].filter((s) => s.length >= 4);
  const stem = rel.replace(EXT_RE, '');
  const baseStem = base.replace(EXT_RE, '');
  const out = new Set([rel, base, stem, baseStem].filter((s) => s.length >= 4));
  for (const part of baseStem.split(/[-_/]/)) {
    if (part.length >= 4 && !GENERIC.has(part)) out.add(part);
  }
  return [...out];
}

/**
 * Does this note text mention that candidate — a real match, not `thing` inside
 * `nothing`.
 *
 * A candidate containing `/` or `.` is a path shape (`lib/thing.js`, `test/landcheck`)
 * and is specific enough that a plain substring is safe — nothing in ordinary prose
 * accidentally spells one. A bare word (`thing`, `landcheck`, from splitting a filename
 * apart) is not: `nothing`, `something` and `anything` all contain `thing`, which a raw
 * `includes` found inside this file's own first test fixture before this existed. Word
 * boundaries only bite that shape, so a path candidate keeps the cheaper check.
 */
function mentions(haystack, candidate) {
  if (candidate.includes('/') || candidate.includes('.')) return haystack.includes(candidate);
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(haystack);
}

/**
 * Which suites `lib/affected.js` — the same matching `b7e-affected` uses — says cover
 * these files. A note that names the suite covering a file is as much "about this
 * path" as one that names the path outright, and asking here is one function call
 * rather than a second index.
 */
function suitesFor(root, files) {
  try {
    const { results } = findAffected(root, files);
    return [...new Set(results.flatMap((r) => r.matches.map((m) => m.suite)))];
  } catch {
    // A root that is not this repo's shape (no bin/lib/public/scripts/test) answers
    // "no suites", not a crash — the path candidates below still work on their own.
    return [];
  }
}

/**
 * Group 2: notes that name one of these files, or a suite covering one of them.
 *
 * Substring, not `similarity()` — a single-file "wanted" bag is too small for the
 * cosine floor to ever clear (one shared token against a fifty-token note scores
 * under 1.5 even when that token is the whole reason the note exists), and the
 * acceptance case this exists for is precisely a note that names nothing but the
 * path. Candidates are checked longest-first, so a note matching both the full path
 * and one of its generic parts is credited with the specific reason.
 *
 * **A file the caller actually named always outranks one this only derived.**
 * `lib/superseded.js` alone can be transitively imported by fifty-odd suites, so
 * "covers a file this bead touches" is a real but *weak* signal next to "this is one
 * of the files themselves" — without the split, a note that happens to mention a
 * recently-touched, unrelated covering suite by its bare filename could crowd out the
 * note actually about the path asked for, purely on a tie-break by recency.
 */
export function notesForPaths(notesAll, paths, { root = REPO_ROOT, keep = 8 } = {}) {
  const files = (paths || []).map((p) => toRepoRel(root, root, p)).filter(Boolean);
  if (!files.length) return [];
  const suites = suitesFor(root, files).filter((s) => !files.includes(s));

  const byCandidate = new Map();
  for (const file of files) {
    for (const cand of pathCandidates(file)) {
      if (!byCandidate.has(cand)) byCandidate.set(cand, { file, given: true });
    }
  }
  for (const suite of suites) {
    for (const cand of pathCandidates(suite, { strict: true })) {
      if (!byCandidate.has(cand)) byCandidate.set(cand, { file: suite, given: false });
    }
  }
  const candidates = [...byCandidate.entries()].sort((a, b) => b[0].length - a[0].length);
  if (!candidates.length) return [];

  const out = [];
  for (const [key, entry] of Object.entries(notesAll || {})) {
    const value = String(entry?.value ?? '');
    if (!value) continue;
    const haystack = `${key} ${value}`.toLowerCase();
    const hit = candidates.find(([cand]) => mentions(haystack, cand.toLowerCase()));
    if (!hit) continue;
    const [cand, { file, given }] = hit;
    out.push({ key, value, at: entry?.at ?? '', reason: `names ${file} (as "${cand}")`, matched: cand, given, file });
  }
  return out
    .sort((a, b) => Number(b.given) - Number(a.given) || b.matched.length - a.matched.length || String(b.at).localeCompare(String(a.at)))
    .slice(0, keep);
}

/**
 * Group 3: what earlier runs at this bead's own family already reported — itself, its
 * parent, its siblings under that parent. The exact set `beadcause-memory debriefs`
 * reaches; wired here so a session asking for notes gets this in the same call instead
 * of needing a second command to ask (bc-khoe.43's own acceptance criteria: bc-j52g had
 * to run `beadcause-memory debriefs bc-j52g` separately to learn this).
 *
 * `perBead: 1` — the newest run at each family member, matching what `debriefBrief`
 * assumes it was handed (see `capDebriefs` below). A bead directly under a long-running
 * P0 epic answers to a `parent` whose own history can be dozens of visits deep and one
 * archive commit long — measured at 215KB for `bc-khoe` itself while building this —
 * and there is no reason to read that twice.
 */
export async function siblingDebriefs(dir, bead, { perBead = 1, scan } = {}) {
  const ids = await debriefBeads(dir);
  const family = debriefFamily(ids, bead);
  if (!family.length) return [];
  return readDebriefs(dir, family, { perBead, ...(scan ? { scan } : {}) });
}

/**
 * Bound `siblingDebriefs`' list the way `debriefBrief` bounds the brief section it
 * builds from the same shape, minus the markdown rendering: `keep` entries at most, and
 * every entry after the first clipped once the running total passes `chars`. The first
 * is always taken whole, for `debriefBrief`'s own reason — a budget that can silently
 * empty the single most relevant report is worse than a long one.
 */
export function capDebriefs(list, { keep = DEBRIEF_KEEP, chars = DEBRIEF_CHARS } = {}) {
  const picked = [];
  let spent = 0;
  for (const d of (list || []).slice(0, keep)) {
    const text = String(d?.text ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    if (!picked.length) {
      picked.push({ ...d, text });
      spent += text.length;
      continue;
    }
    const room = chars - spent;
    if (room < 200) break;
    picked.push({ ...d, text: text.length > room ? `${text.slice(0, room)}\n… (clipped — the rest is at \`beadcause-memory debriefs ${d.bead}\`)` : text });
    spent += Math.min(text.length, room);
  }
  return { picked, more: Math.max(0, (list || []).length - picked.length) };
}

/**
 * The files a bead is about, when the caller did not name any: whatever the bead
 * declares or guesses about its own surface (lib/beadfiles.js) — the same field a
 * plan or a claim would read.
 */
export function defaultPaths(bead, root = REPO_ROOT) {
  return surfaceOf(bead, [root]).files;
}

/**
 * Everything this file knows about one bead, in one call — the shape `bin/b7e-notes`
 * prints and the shape a test can assert against directly.
 */
export async function gather(dir, bead, paths, opts = {}) {
  const root = opts.root || dir || REPO_ROOT;
  const usedPaths = paths && paths.length ? paths : defaultPaths(bead, root);
  const notesAll = await notesIn(dir, opts.agent || 'worker');
  const rawDebriefs = await siblingDebriefs(dir, bead, opts.debriefs);
  const { picked: debriefs, more: moreDebriefs } = capDebriefs(rawDebriefs, opts.debriefCap);
  return {
    paths: usedPaths,
    bead: notesForBead(notesAll, bead, opts.bead),
    files: notesForPaths(notesAll, usedPaths, { root, ...(opts.files || {}) }),
    debriefs,
    moreDebriefs,
  };
}
