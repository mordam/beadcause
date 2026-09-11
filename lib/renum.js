/**
 * `b7e-renum` — what a chapter number meant when a line citing it was written, and
 * which chapter that is today. See bin/b7e-renum for the argv shape; this is the git
 * archaeology underneath it.
 *
 * bc-xl7n.154: three sessions (dv-5i2.130, dv-5i2.129, dv-afr.41) each translated a
 * stale chapter citation by hand, each a different way — writing notes, a CHANGE_LOG
 * conversion note, proper-noun overlap against an archive. Deluvia's numbering has
 * moved under the text three times (Entry 065, Entry 147, the Book 2 restructure), and
 * a citation written before any of those still names the chapter that was true when it
 * was written, not the one that file resolves to today. This module answers both
 * halves at once: what a number meant **then** (at some ref/date/Entry), and what that
 * same chapter **is now** — found by asking git, not by hand.
 *
 * ## The two ways in
 *
 * `resolveCitation` takes a file and a line — the citing line itself, whose introducing
 * commit (via `git blame`) fixes the era the cited number belongs to, and whose text is
 * parsed for the number(s) cited (`citedNumbers`). The book is inferred from the file's
 * own path.
 *
 * `resolveBookAt` is the lower-level call both `resolveCitation` and a direct
 * `<book> <chapter> --at <ref>` query go through: given a book, a chapter number, and a
 * point in time, it finds what that chapter *was* at that time (`resolveThen`, against
 * the tree at that commit via `git ls-tree`/`git show`, since the file may since have
 * been renamed or removed from the working tree entirely) and then chases it forward to
 * what it *is now* (`resolveNow`, against the working tree via `lib/chapter.js`).
 *
 * ## Chasing forward — three methods, tried in order
 *
 * 1. **git rename-follow.** For every `CHAPTER_N.*` file that exists today in the book
 *    (living or archived — `lib/chapter.js`'s `isArchived` says which), `git log -M
 *    --name-status --follow` traces that file's own history back through every rename
 *    git ever recorded for it. If the historical path shows up anywhere in that trail,
 *    this is the same file under a new name — the highest-confidence answer, because it
 *    is git's own content-tracked identity, not a resemblance this code guessed at.
 * 2. **Identical H1 title.** When the renumber rewrote the file in place instead of
 *    `git mv`-ing it (so no rename survives to follow), the chapter's first `# ` heading
 *    usually didn't change. An exact, case-insensitive title match against every
 *    candidate is the second method.
 * 3. **Proper-noun overlap.** When neither of the above finds anything, `properNouns`
 *    scores every candidate by how many capitalized non-stopword tokens it shares with
 *    the historical content, and the highest-scoring candidate — if its lead over the
 *    runner-up clears `OVERLAP_MARGIN` — is reported as the match, with the top three
 *    candidates listed either way so a reader can second-guess it.
 *
 * Whichever method wins, the winning candidate's own `archived` field (set from
 * `lib/chapter.js`'s `isArchived` when the candidate pool is built — see
 * `allChapterFilesForBook`) is what decides "now" from "cut": a candidate under
 * `_archive_pre-restructure/` means the chapter did not survive the restructure under
 * any live number — it only ever moved sideways, into the archive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isArchived, classifyVariant, findChapterFiles } from './chapter.js';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** `git(...)`, or `null` on any failure — for a lookup where "absent" is an answer. */
function gitOk(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/* ===================================================================== *
 * resolving `--at <ref|date|Entry NNN>` to a commit
 * ===================================================================== */

const ENTRY_RE = /^entry\s+(\d+)\b/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * `at` → `{ sha, shortSha, date }`, or throws with a message naming what was tried.
 *
 * `Entry NNN` is resolved by finding the earliest commit that introduced the heading
 * text into `CHANGE_LOG.md` (`git log -S`, the "pickaxe" search — a commit where the
 * string's occurrence count changed — read `--reverse` so the first hit is the oldest).
 * A bare date is the last commit at or before it, read on `HEAD`. Anything else is
 * handed to `git rev-parse` as a ref outright.
 */
export function resolveAtRef(root, at) {
  const raw = String(at ?? '').trim();
  if (!raw) throw new Error('--at is required and must not be empty');

  let sha;
  const entryMatch = ENTRY_RE.exec(raw);
  if (entryMatch) {
    const n = entryMatch[1];
    const needle = `Entry ${n}`;
    const out = gitOk(root, ['log', '--reverse', `-S${needle}`, '--format=%H', '--', 'CHANGE_LOG.md']);
    const first = out ? out.split('\n').find(Boolean) : null;
    if (!first) throw new Error(`no commit in CHANGE_LOG.md history introduces "${needle}"`);
    sha = first.trim();
  } else if (DATE_RE.test(raw)) {
    const out = gitOk(root, ['rev-list', '-1', `--before=${raw} 23:59:59`, 'HEAD']);
    if (!out || !out.trim()) throw new Error(`no commit on HEAD at or before ${raw}`);
    sha = out.trim();
  } else {
    const out = gitOk(root, ['rev-parse', '--verify', '--quiet', `${raw}^{commit}`]);
    if (!out || !out.trim()) throw new Error(`"${raw}" is not a ref, a date (YYYY-MM-DD), or "Entry NNN"`);
    sha = out.trim();
  }

  const date = (gitOk(root, ['show', '-s', '--format=%aI', sha]) || '').trim() || null;
  return { sha, shortSha: sha.slice(0, 8), date };
}

/* ===================================================================== *
 * the book directory and chapter file(s), as they existed at a ref
 * ===================================================================== */

/** Mirrors `lib/chapter.js`'s `findBookDir`, against a historical tree instead of the
 * working tree — `git ls-tree` in place of `fs.readdirSync`. */
export function bookDirAtRef(root, sha, bookNumber) {
  const out = gitOk(root, ['ls-tree', '-r', '--name-only', sha, '--', 'novel']);
  if (!out) return null;
  const re = new RegExp(`\\bbook\\s*0*${bookNumber}\\b`, 'i');
  const seen = new Set();
  for (const line of out.split('\n')) {
    const m = /^novel\/([^/]+)\//.exec(line);
    if (m) seen.add(m[1]);
  }
  const match = [...seen].find((dir) => !/^_/.test(dir) && re.test(dir));
  return match ? { name: match, relDir: `novel/${match}` } : null;
}

/** Mirrors `lib/chapter.js`'s `findChapterFiles`, against the tree at `sha`. Never
 * reports an archived twin — `then` is asked about a citation's own era, and an era's
 * chapter is the one that was live in it, not whatever else the tree also carried. */
export function chapterFilesAtRef(root, sha, bookRelDir, chapterNumber) {
  const out = gitOk(root, ['ls-tree', '-r', '--name-only', sha, '--', bookRelDir]);
  if (!out) return [];
  const re = new RegExp(`^CHAPTER_0*${chapterNumber}(?!\\d)\\.(.+)\\.md$`, 'i');
  const rows = [];
  for (const relPath of out.split('\n')) {
    if (!relPath) continue;
    if (isArchived(relPath)) continue;
    const m = re.exec(path.basename(relPath));
    if (!m) continue;
    rows.push({ relPath, variant: classifyVariant(m[1]), infix: m[1] });
  }
  return rows;
}

/** A blob's content at a ref, or `null` if either the ref or the path is missing. */
export function blobAtRef(root, sha, relPath) {
  return gitOk(root, ['show', `${sha}:${relPath}`]);
}

/** The commit that most recently touched `relPath` at or before `sha` — `{short, date}`
 * or `null` if the path has no history reachable from `sha`. */
export function lastCommitAtRef(root, sha, relPath) {
  const out = gitOk(root, ['log', sha, '-1', '--format=%h%x00%aI', '--', relPath]);
  if (!out || !out.trim()) return null;
  const [short, date] = out.trim().split('\0');
  return { short, date };
}

/** The first `# ` heading, trimmed — a chapter's title, by the same convention every
 * chapter and interlude file in the corpus already follows. */
export function extractTitle(content) {
  const m = /^#\s+(.+?)\s*$/m.exec(content || '');
  return m ? m[1] : null;
}

/**
 * A title, stripped of its own leading `CHAPTER N:`/`INTERLUDE N:` — the number a
 * renumber is precisely what changes, so `"CHAPTER 27: THE FIRE FALLS"` and
 * `"CHAPTER 28: THE FIRE FALLS"` are the same subject under two different numbers and a
 * literal comparison would never call them equal. Comparing this instead of the raw
 * title is what makes "identical H1 title" a usable method at all against this corpus's
 * own convention (`# CHAPTER 1: THE HUNT BEGINS`) rather than one that can only ever
 * fire on a chapter whose number happened not to move.
 */
export function titleSubject(title) {
  if (!title) return null;
  return title.replace(/^(?:chapter|interlude)\s+\d+\s*[:\-–—]?\s*/i, '').trim().toLowerCase();
}

/** The bold `**Label:** value` metadata lines a chapter or interlude header carries —
 * `POV`, `Timeline`, `Placement`, whichever are present. Reported, never assumed. */
export function extractMeta(content) {
  const meta = {};
  const re = /^\*\*([A-Za-z ]+?):\*\*\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(content || ''))) {
    meta[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return meta;
}

/**
 * What chapter `chapterNumber` of `book` *was*, as of `at` (a ref/date/"Entry NNN").
 *
 * `variants` is one entry per file the era's tree carried for this chapter (a chapter
 * living as `.summary.md` and `.text.draft.md` both, say), each with its title, its
 * metadata, and the commit that most recently touched it by that point. `book: null`
 * means no `novel/` directory named this book number existed yet at that ref;
 * `variants: []` with a real `book` means the book existed but this chapter did not.
 */
export function resolveThen(root, book, chapterNumber, at) {
  const ref = resolveAtRef(root, at);
  const bookDir = bookDirAtRef(root, ref.sha, book);
  if (!bookDir) return { ref, book: null, bookDir: null, chapterNumber, variants: [] };

  const files = chapterFilesAtRef(root, ref.sha, bookDir.relDir, chapterNumber);
  const variants = files.map((f) => {
    const content = blobAtRef(root, ref.sha, f.relPath) || '';
    return {
      ...f,
      content,
      title: extractTitle(content),
      meta: extractMeta(content),
      commit: lastCommitAtRef(root, ref.sha, f.relPath),
    };
  });
  return { ref, book, bookDir, chapterNumber, variants };
}

/* ===================================================================== *
 * chasing a historical chapter forward to what it is now
 * ===================================================================== */

const CHAPTER_NUM_RE = /^CHAPTER_0*(\d+)(?!\d)\./i;

/**
 * Every `CHAPTER_N.*.md` the working tree carries for this book today, living and
 * archived alike — built by calling `lib/chapter.js`'s `findChapterFiles` once per
 * number the book's own directory listing names, so the file-matching rules stay the
 * one place `lib/chapter.js` already owns rather than a second copy of them here.
 *
 * **Deliberately never looks under `.claude/worktrees-retired/`.** `lib/chapter.js`'s
 * own docs say why a retired-worktree twin is reported at all: "so a caller who greps
 * for a filename does not silently pick the retired copy" — it is a warning, never a
 * legitimate resolution target, so it has no business winning a "what is this chapter
 * now" match. Counting it in would have been wrong even ignoring cost, and on the real
 * corpus it is also the expensive half: 14,000+ `CHAPTER_*` files across sixty retired
 * worktrees, against a couple hundred in the book itself — a candidate pool two orders
 * of magnitude bigger for git calls (`resolveNow`, one per candidate) that could only
 * ever have found a false positive.
 */
export function allChapterFilesForBook(root, bookDirRel) {
  const abs = path.join(root, bookDirRel);
  const numbers = new Set();
  const scan = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else {
        const m = CHAPTER_NUM_RE.exec(entry.name);
        if (m) numbers.add(Number(m[1]));
      }
    }
  };
  scan(abs);

  const bookNumMatch = /\bbook\s*0*(\d+)\b/i.exec(path.basename(bookDirRel));
  const bookNumber = bookNumMatch ? Number(bookNumMatch[1]) : null;
  if (bookNumber == null) return [];

  const rows = [];
  for (const n of numbers) {
    const { resolved, archive } = findChapterFiles(root, bookNumber, n);
    for (const r of resolved) rows.push({ ...r, chapterNumber: n, archived: false });
    for (const r of archive) {
      if (isArchived(r.relPath) && r.relPath.includes('worktrees-retired')) continue;
      rows.push({ ...r, chapterNumber: n, archived: true });
    }
  }
  return rows;
}

const RENAME_RE = /^R\d*\t(.+)\t(.+)$/;
const SHA_LINE_RE = /^[0-9a-f]{40}$/;

/**
 * Every commit reachable from `sha` (inclusive), as a `Set` of full shas.
 *
 * The one thing `nameAtRef` below needs to tell "this rename happened before the era
 * we're asking about" from "this rename happened after it" — a rename commit that is
 * itself in this set already has its effect baked into the tree at `sha`, because
 * `sha`'s own history includes it; a rename commit that is *not* in this set happened
 * on the way from `sha` to `HEAD` and has to be undone to get back to `sha`'s name.
 */
export function ancestorsOf(root, sha) {
  const out = gitOk(root, ['rev-list', sha]);
  return new Set(out ? out.split('\n').filter(Boolean) : []);
}

/**
 * What name did `candidateRelPath`'s own lineage carry as of `atSha`?
 *
 * Deluvia's renumbers are **chains**, not single moves — Entry 147 shifted 18 through
 * 35 up by one, which git records as eighteen separate renames, each landing a
 * *different* lineage on the filename the number below it just vacated. That is why
 * this cannot be "did `historicalRelPath` ever appear in this candidate's history": the
 * string `CHAPTER_27.summary.md` is `candidateRelPath` itself (today's Ch. 27) *and* is
 * also what today's Ch. 28 was called before the shift — the same filename names two
 * different lineages, one on each side of the renumber. Naive string membership treats
 * the candidate's own unremarkable current name as a "hit" against a historical query
 * for that same number, which is wrong whenever the shift reuses it.
 *
 * `git log -M --follow --name-status` on `candidateRelPath` gives this one lineage's
 * name across time, newest first. Walking it and undoing every rename that happened
 * *after* `atSha` (per `ancestors`, computed once by the caller and shared across every
 * candidate in one `resolveNow` call) recovers the name this exact lineage had at
 * `atSha` — which is then a plain string comparison against `historicalRelPath`, not a
 * guess about whether the two might be related.
 *
 * Returns `{ name, renamed }` — `renamed` is only true once at least one real rename
 * was undone to get there. Deluvia's own Entry 147 turned out to need this the hard
 * way: it renumbered chapters 18-35 by rewriting each file's *content* in place
 * (`CHAPTER_27.summary.md` got what had been chapter 26's text, `CHAPTER_28.summary.md`
 * got what had been chapter 27's), never `git mv`-ing anything — the diff for every
 * file in that commit is a plain modify, no `R` line anywhere. Without `renamed`, a
 * query for the old chapter 27 would see `CHAPTER_27.summary.md`'s name never change,
 * find its `atSha` name trivially equal to itself, and conclude "no change" —
 * mistaking "git recorded no rename" for "nothing happened", exactly backwards for a
 * rewrite-in-place renumber. The caller needs `renamed` to know when a same-name
 * "match" is a coincidence rather than evidence, and to fall back to title/overlap
 * matching instead of trusting it.
 */
export function nameAtRef(root, candidateRelPath, ancestors) {
  const out = gitOk(root, ['log', '-M', '--follow', '--name-status', '--format=%H', '--', candidateRelPath]);
  if (!out) return { name: candidateRelPath, renamed: false };
  let name = candidateRelPath;
  let renamed = false;
  let currentSha = null;
  for (const line of out.split('\n')) {
    if (SHA_LINE_RE.test(line)) {
      currentSha = line;
      continue;
    }
    const m = RENAME_RE.exec(line);
    if (!m) continue;
    // This commit's rename already has its effect baked into the tree at `atSha` — stop
    // undoing here; everything from this commit backward is already `atSha`'s own past.
    if (ancestors.has(currentSha)) break;
    if (m[2] === name) {
      name = m[1];
      renamed = true;
    }
  }
  return { name, renamed };
}

/** Capitalized, non-stopword tokens — the fallback signal when neither a rename nor a
 * title survived the rewrite. Deliberately coarse: this is a ranking, not a proof, and
 * the caller always shows its work (the score, and the runner-up) rather than asserting it. */
const STOPWORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'Chapter', 'Book', 'Interlude', 'Timeline', 'POV', 'Setting',
  'Time', 'Day', 'Days', 'After', 'Before', 'Placement', 'Voice', 'Length', 'Status', 'Purpose', 'What',
  'She', 'He', 'They', 'It', 'Note', 'Key', 'Characters', 'Emotional', 'Sensory', 'Scene', 'Scenes',
  'Arc', 'Summary', 'Detail', 'Expanded', 'Beats', 'Target', 'Words', 'Only', 'First', 'Second', 'Third',
  'When', 'Where', 'Why', 'How', 'Who', 'Her', 'His', 'Their', 'Its', 'Not', 'For', 'And', 'But', 'With',
]);

export function properNouns(content) {
  const found = new Set();
  const re = /\b[A-Z][a-zA-Z'-]{2,}\b/g;
  let m;
  while ((m = re.exec(content || ''))) {
    if (!STOPWORDS.has(m[0])) found.add(m[0]);
  }
  return found;
}

/** How far the winning score has to clear the runner-up before overlap counts as
 * "resolved" rather than merely "the best of several weak guesses". */
export const OVERLAP_MARGIN = 2;

/**
 * Chase a `resolveThen` variant forward to what it is (or was cut to) today.
 *
 * Tries rename-follow, then title match, then proper-noun overlap, in that order,
 * against every `CHAPTER_*` file the book has now — living and archived together, so
 * the same three methods answer both "what chapter is this now" and "this didn't
 * survive, it only moved into the archive": the winning candidate's own `archived` flag
 * is what tells those two apart, once a method has picked a winner at all.
 *
 * Returns `{ method, winner, candidates }` — `winner` is `null` when nothing crossed a
 * confident threshold, in which case `candidates` (top 3, by proper-noun score) is the
 * honest partial answer.
 *
 * `atSha` is the commit `thenVariant` was resolved against — see `nameAtRef` for why
 * rename-follow needs it and cannot just ask "was this string ever this path's name".
 */
export function resolveNow(root, bookDirRel, thenVariant, atSha) {
  const all = allChapterFilesForBook(root, bookDirRel);
  const sameVariant = all.filter((c) => c.variant === thenVariant.variant);
  const pool = sameVariant.length ? sameVariant : all;

  // `renamed` is required, not just `name === thenVariant.relPath` — see `nameAtRef`'s
  // own header for why a same-name "match" with no real rename behind it is exactly the
  // false positive a rewrite-in-place renumber (Entry 147) produces, not evidence.
  const ancestors = ancestorsOf(root, atSha);
  for (const c of pool) {
    const { name, renamed } = nameAtRef(root, c.relPath, ancestors);
    if (renamed && name === thenVariant.relPath) {
      return { method: 'git rename-follow', winner: c, candidates: [c] };
    }
  }

  // Title match: read each candidate's content once, reused below for overlap too.
  const withContent = pool.map((c) => {
    let content = '';
    try {
      content = fs.readFileSync(path.join(root, c.relPath), 'utf8');
    } catch {
      content = '';
    }
    return { ...c, content, title: extractTitle(content) };
  });

  const thenSubject = titleSubject(thenVariant.title);
  if (thenSubject) {
    const exact = withContent.filter((c) => titleSubject(c.title) === thenSubject);
    if (exact.length === 1) {
      return { method: 'identical H1 title', winner: exact[0], candidates: exact };
    }
  }

  const thenNouns = properNouns(thenVariant.content || '');
  const scored = withContent
    .map((c) => {
      const nouns = properNouns(c.content);
      let score = 0;
      for (const n of thenNouns) if (nouns.has(n)) score += 1;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  const top3 = scored.slice(0, 3);
  const best = top3[0];
  const runnerUp = top3[1];
  const confident = best && best.score > 0 && (!runnerUp || best.score - runnerUp.score >= OVERLAP_MARGIN);

  return {
    method: confident ? 'proper-noun overlap' : null,
    winner: confident ? best : null,
    candidates: top3,
  };
}

/**
 * The whole answer for one `<book> <chapter> --at <ref>` query: what it was then, and
 * one chased-forward result per variant `resolveThen` found. Shared by the direct
 * `<book> <chapter>` CLI mode and by `resolveCitation` below, once the latter has fixed
 * an era and a book from the citing line.
 */
export function resolveBookAt(root, book, chapterNumber, at) {
  const then = resolveThen(root, book, chapterNumber, at);
  const nowResults = then.variants.map((v) => ({ variant: v, ...resolveNow(root, then.bookDir?.relDir, v, then.ref.sha) }));
  return { then, nowResults };
}

/* ===================================================================== *
 * <file>:<line> mode — the citing line itself fixes the era
 * ===================================================================== */

/** Every distinct chapter number a line cites, in order of first appearance —
 * `"(from Ch. 14/23)"` yields `[14, 23]`, `"Placed after Ch. 7"` yields `[7]`. */
export function citedNumbers(lineText) {
  const nums = [];
  const seen = new Set();
  const push = (s) => {
    const n = Number(s);
    if (Number.isInteger(n) && !seen.has(n)) {
      seen.add(n);
      nums.push(n);
    }
  };
  const re = /\bch(?:apter)?s?\.?\s*(\d+)(?:\s*[/,]\s*(\d+))?/gi;
  let m;
  while ((m = re.exec(lineText || ''))) {
    push(m[1]);
    if (m[2]) push(m[2]);
  }
  return nums;
}

/** The book number a file belongs to, by walking up to its `novel/<dir>/` ancestor —
 * `{ book, bookDirRel }`, or `{ book: null, bookDirRel: null }` if it is not under one. */
export function inferBookFromPath(root, absFilePath) {
  const rel = path.relative(root, absFilePath).split(path.sep).join('/');
  const m = /^novel\/([^/]+)\//.exec(rel);
  if (!m) return { book: null, bookDirRel: null };
  const bookMatch = /\bbook\s*0*(\d+)\b/i.exec(m[1]);
  if (!bookMatch) return { book: null, bookDirRel: null };
  return { book: Number(bookMatch[1]), bookDirRel: `novel/${m[1]}` };
}

/** The commit that introduced `line` of `relPath`, as it stands in the working tree —
 * `{ sha, shortSha, date }`, or `null` for an uncommitted line (`git blame`'s all-zero
 * sha) or a file/line git has nothing to say about. */
export function blameLine(root, relPath, line) {
  const out = gitOk(root, ['blame', '-L', `${line},${line}`, '--porcelain', '--', relPath]);
  if (!out) return null;
  const sha = out.slice(0, 40);
  if (/^0{40}$/.test(sha)) return null;
  const date = (gitOk(root, ['show', '-s', '--format=%aI', sha]) || '').trim() || null;
  return { sha, shortSha: sha.slice(0, 8), date };
}

/**
 * The whole answer for a `<file>:<line>` query: one block per number the line cites.
 *
 * Each block is `{ citedNumber, then, now }`, where `then` is `resolveThen`'s result
 * (against the blame commit) and `now` is `resolveNow`'s (against the working tree) —
 * run once per variant `then` found, since a chapter can carry more than one file for
 * the same number and each can have chased forward to a different current chapter.
 */
export function resolveCitation(root, absFilePath, line) {
  const rel = path.relative(root, absFilePath).split(path.sep).join('/');
  const content = fs.readFileSync(absFilePath, 'utf8');
  const lines = content.split('\n');
  const lineText = lines[line - 1];
  if (lineText === undefined) throw new Error(`${rel} has no line ${line} (it has ${lines.length})`);

  const numbers = citedNumbers(lineText);
  if (!numbers.length) throw new Error(`no chapter number found on ${rel}:${line}: ${JSON.stringify(lineText.trim())}`);

  const { book } = inferBookFromPath(root, absFilePath);
  if (book == null) throw new Error(`${rel} is not under a novel/<Book N>/ directory — cannot infer which book this citation belongs to`);

  const blame = blameLine(root, rel, line);
  if (!blame) throw new Error(`${rel}:${line} has no git history (uncommitted, or git blame found nothing) — cannot fix an era for it`);

  const blocks = numbers.map((citedNumber) => {
    const { then, nowResults } = resolveBookAt(root, book, citedNumber, blame.sha);
    return { citedNumber, book, blame, then, nowResults };
  });

  return { file: rel, line, lineText, blocks };
}
