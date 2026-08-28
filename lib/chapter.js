/**
 * `b7e-chapter` — which file on disk holds a book or chapter, and which variant of it is
 * the one that governs. See bin/b7e-chapter for the argv shape; this is the resolution.
 *
 * bc-dgx7.123: five sessions (dv-afr.21, dv-afr.20, dv-5eu.19, dv-afr.15, dv-afr.17) each
 * re-derived this by hand, none the same way — a `grep` that assumed a filename pattern
 * one book does not follow, a `find` fallback, an `ls | grep` across three variants with
 * no way to tell which one is canon, a `beadcause-memory notes` lookup to learn that a
 * `.propagated.md` beats a draft for chapters a gate script covers. The repo already
 * answers most of this (`novel/SERIES_CHAPTER_LOG.md`, `scripts/build_series_log.py`)
 * and none of the five consulted it because none of them are this repo — deluvia is a
 * different checkout, and this file has to work from a `--dir` fixture that is not it.
 *
 * ## The convention this assumes
 *
 * A book lives at `<root>/novel/<dir>/`, where `<dir>` contains the book number as a
 * standalone token (`Book 2`, `Book2`, case-insensitive — `\bBook\s*0*N\b`, so `Book 12`
 * never matches a query for book `1`). Its book-level documents are `BOOK_N_OVERVIEW.md`
 * and/or `BOOK_N_SUMMARY.md` (a book carries one or the other, OVERVIEW preferred when
 * both exist — none is known to, but nothing here assumes it can't happen) plus an
 * optional `BOOK_N_CHAPTER_MAP.md` alongside either. A chapter is up to three files,
 * `CHAPTER_N.<infix>.md`, where `<infix>` classifies the variant: containing `propagated`
 * is the `propagated` variant, containing `summary` is `summary`, containing `draft` or
 * `text` is `prose` — anything else matching `CHAPTER_N.*.md` is `other`, reported but
 * unclassified rather than dropped.
 *
 * A **canon gate** is `<root>/scripts/check_ch<start>_<end>_canon.py`: it governs chapters
 * `start`..`end` of whichever book's directory name its own source text names verbatim,
 * and among the variants present for a governed chapter, the one whose classifying
 * keyword (`propagated`, `summary`, `draft`/`text`) appears in the script's source is the
 * canon-current one, cited by the script's path. A chapter no gate's range covers has no
 * canon-current variant — not "the newest" or "the prose", nothing, because guessing
 * would be exactly the mistake dv-5eu.19 spent three calls not making.
 *
 * **Archive twins** are anything otherwise matching either pattern that sits under a path
 * segment starting `_archive` (case-insensitive, e.g. `_archive_pre-restructure/`) or
 * anywhere under `.claude/worktrees-retired/` — both real precedents named in bc-dgx7.123.
 * They are never a result; they are always listed, by path, in their own section, so a
 * caller who greps for a filename does not silently pick the retired copy the way
 * dv-afr.21's `find` did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** True for a path (relative to the tree root, forward-slash or native separators) that
 * this file treats as an archived twin rather than a live document. */
export function isArchived(relPath) {
  const parts = relPath.split(path.sep).join('/').split('/');
  if (parts.some((p) => /^_archive/i.test(p))) return true;
  const joined = parts.join('/');
  return joined === '.claude/worktrees-retired' || joined.startsWith('.claude/worktrees-retired/');
}

function walk(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else if (entry.isFile()) onFile(full);
  }
}

/** The `<root>/novel/<dir>` whose name carries book number `n`, or `null`. */
export function findBookDir(root, n) {
  const novelDir = path.join(root, 'novel');
  let entries;
  try {
    entries = fs.readdirSync(novelDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const re = new RegExp(`\\bbook\\s*0*${n}\\b`, 'i');
  const match = entries.find((e) => e.isDirectory() && !/^_/.test(e.name) && re.test(e.name));
  return match ? { dir: path.join(novelDir, match.name), relDir: path.join('novel', match.name) } : null;
}

/** Every `novel/<dir>` that looks like a book, in the order `readdirSync` gives them. */
export function listBookDirs(root) {
  const novelDir = path.join(root, 'novel');
  let entries;
  try {
    entries = fs.readdirSync(novelDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || /^_/.test(e.name)) continue;
    const m = e.name.match(/\bbook\s*0*(\d+)\b/i);
    if (m) out.push({ number: Number(m[1]), dir: path.join(novelDir, e.name), relDir: path.join('novel', e.name), name: e.name });
  }
  return out.sort((a, b) => a.number - b.number);
}

const DOC_KINDS = ['OVERVIEW', 'SUMMARY', 'CHAPTER_MAP'];

/** Classify a `CHAPTER_N.<infix>.md` infix into a variant name, or `null` if unrecognised. */
export function classifyVariant(infix) {
  const lower = infix.toLowerCase();
  if (lower.includes('propagated')) return 'propagated';
  if (lower.includes('summary')) return 'summary';
  if (lower.includes('draft') || lower.includes('text')) return 'prose';
  return 'other';
}

function relTo(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Book-level docs (OVERVIEW/SUMMARY/CHAPTER_MAP) for book `n`: `{ resolved, archive }`,
 * each an array of `{ path, kind }` (absolute `path`, relative to `root`). */
export function findBookDocs(root, n) {
  const book = findBookDir(root, n);
  const resolved = [];
  const archive = [];
  const re = new RegExp(`^BOOK_0*${n}_(${DOC_KINDS.join('|')})\\.md$`, 'i');

  if (book) {
    walk(book.dir, (file) => {
      const m = re.exec(path.basename(file));
      if (!m) return;
      const rel = relTo(root, file);
      const kind = m[1].toUpperCase();
      (isArchived(rel) ? archive : resolved).push({ path: file, relPath: rel, kind });
    });
  }
  scanRetired(root, re, (file) => {
    const rel = relTo(root, file);
    const m = re.exec(path.basename(file));
    archive.push({ path: file, relPath: rel, kind: m[1].toUpperCase() });
  });

  // OVERVIEW is preferred over SUMMARY when a book somehow carries both; CHAPTER_MAP
  // always rides alongside whichever of those two is kept.
  const overview = resolved.find((d) => d.kind === 'OVERVIEW');
  const summary = resolved.find((d) => d.kind === 'SUMMARY');
  const chapterMap = resolved.find((d) => d.kind === 'CHAPTER_MAP');
  const kept = [overview ?? summary, chapterMap].filter(Boolean);
  return { book, resolved: kept, archive };
}

function scanRetired(root, re, onMatch) {
  const retired = path.join(root, '.claude', 'worktrees-retired');
  walk(retired, (file) => {
    if (re.test(path.basename(file))) onMatch(file);
  });
}

/** Every `CHAPTER_n.*.md` for book `n`, chapter `c`: `{ book, resolved, archive }`, each
 * result `{ path, relPath, variant, infix }`. */
export function findChapterFiles(root, n, c) {
  const book = findBookDir(root, n);
  const resolved = [];
  const archive = [];
  const re = new RegExp(`^CHAPTER_0*${c}(?!\\d)\\.(.+)\\.md$`, 'i');

  if (book) {
    walk(book.dir, (file) => {
      const m = re.exec(path.basename(file));
      if (!m) return;
      const rel = relTo(root, file);
      const row = { path: file, relPath: rel, variant: classifyVariant(m[1]), infix: m[1] };
      (isArchived(rel) ? archive : resolved).push(row);
    });
  }
  scanRetired(root, re, (file) => {
    const m = re.exec(path.basename(file));
    archive.push({ path: file, relPath: relTo(root, file), variant: classifyVariant(m[1]), infix: m[1] });
  });

  return { book, resolved, archive };
}

/** The canon gate covering book `n` chapter `c`, or `null`. `{ scriptRelPath, variant }` —
 * `variant` is which of `resolved`'s variants the gate's own source names, or `null` if
 * the gate covers this chapter but its source names no variant present on disk. */
export function findCanonGate(root, bookDirName, c, resolved) {
  const scriptsDir = path.join(root, 'scripts');
  let entries;
  try {
    entries = fs.readdirSync(scriptsDir);
  } catch {
    return null;
  }
  const re = /^check_ch(\d+)_(\d+)_canon\.py$/i;
  for (const name of entries) {
    const m = re.exec(name);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (c < start || c > end) continue;
    let src;
    try {
      src = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    } catch {
      continue;
    }
    if (!src.includes(bookDirName)) continue;
    const srcLower = src.toLowerCase();
    const hit = resolved.find((r) => r.variant && r.variant !== 'other' && srcLower.includes(r.variant));
    return { scriptRelPath: path.join('scripts', name).split(path.sep).join('/'), variant: hit ? hit.variant : null };
  }
  return null;
}

function lineCountOf(absPath) {
  let content;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  if (content === '') return 0;
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
}

function lastCommitOf(root, relPath) {
  try {
    const out = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h %s', '--', relPath], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Attach `lineCount`/`lastCommit` to a row that has `path`/`relPath`. Mutates and returns it. */
function annotate(root, row) {
  row.lineCount = lineCountOf(row.path);
  row.lastCommit = lastCommitOf(root, row.relPath);
  return row;
}

/**
 * The whole answer for `<book>` (and optional `<chapter>`) against tree `root`.
 *
 * No chapter: `{ mode: 'book', book, docs: [{path,relPath,kind,lineCount,lastCommit}],
 * archive: [...] }`. `book` is `null` (and `docs`/`archive` empty) when no `novel/`
 * directory names this book number at all.
 *
 * With a chapter: `{ mode: 'chapter', book, chapter, variants: [{path,relPath,variant,
 * infix,canonCurrent,canonReason,lineCount,lastCommit}], archive: [...] }`.
 */
export function resolveChapter(root, bookNumber, chapterNumber = null) {
  if (chapterNumber == null) {
    const { book, resolved, archive } = findBookDocs(root, bookNumber);
    return {
      mode: 'book',
      book,
      docs: resolved.map((r) => annotate(root, r)),
      archive: archive.map((r) => annotate(root, r)),
    };
  }

  const { book, resolved, archive } = findChapterFiles(root, bookNumber, chapterNumber);
  const gate = book ? findCanonGate(root, path.basename(book.dir), chapterNumber, resolved) : null;
  const variants = resolved.map((r) => {
    const row = annotate(root, r);
    row.canonCurrent = !!(gate && gate.variant && gate.variant === r.variant);
    row.canonReason = row.canonCurrent ? gate.scriptRelPath : null;
    return row;
  });
  return {
    mode: 'chapter',
    book,
    chapter: chapterNumber,
    variants,
    archive: archive.map((r) => annotate(root, r)),
  };
}

/** The whole map: every book `novel/` names, with which doc kinds it carries. Does not
 * descend into chapters — that is `resolveChapter` per book. */
export function mapBooks(root) {
  return listBookDirs(root).map(({ number, relDir }) => {
    const { resolved } = findBookDocs(root, number);
    return { number, relDir, kinds: resolved.map((r) => r.kind) };
  });
}
