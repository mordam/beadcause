/**
 * A book's chapter and interlude manifest — one row per chapter or interlude, with its
 * header fields, its prose files and their measured word counts, and (for interludes) its
 * placement key — plus a derived block that flags what none of the five hand-built
 * versions caught until a reader noticed by chance: overlapping or gapped day/BP ranges
 * on the same thread, and an interlude placement key that is non-monotone or points past
 * the book's own last chapter.
 *
 * `bc-dgx7.103`, filed by the session audit against five deluvia sessions (`dv-afr.6`,
 * `dv-afr.7`, `dv-afr.8`, `dv-afr.9`, `dv-gr6.8`) that each built this table by hand, a
 * different way, before any judgement about the book itself could start: three different
 * shell-loop shapes over `CHAPTER_N.summary.md`/`INTERLUDE_NN.summary.md`, one of them
 * shelled out to a scratchpad script after the worktree guard refused its own loop. What
 * each of those loops was building — informally, inconsistently — is this.
 *
 * COUNTING CHAPTERS AND INTERLUDES reuses the exact regex shapes
 * `deluvia/scripts/build_series_log.py`'s `measure()` already settled on (its own header
 * explains why: a hand-kept mirror of the tree told every reader for three months that
 * two books had no chapters and a third had ten fewer than it did). Reimplemented here in
 * JS rather than imported, because this file must run without `deluvia` on disk at all
 * — the automated suite proves it against a fabricated fixture tree, and drift between
 * the two counters would be silent unless both were pinned to the same regex text. A
 * chapter file named `CHAPTER_18A_THE_PARTING.summary.md` is real and is read for its own
 * row here, but it does NOT count toward `chapters`/`summaries` in `totals` — the Python
 * pattern is `CHAPTER_(\d+)\.summary\.md$` with nothing between the digits and the
 * extension, and matching that blind spot is what makes `totals` agree with
 * `build_series_log.py`'s own count rather than silently correcting it out from under a
 * reader comparing the two.
 *
 * PARSING A HEADER is best-effort over real, inconsistently-shaped prose, not a strict
 * grammar. Five books were found using `**Timeline:**`, one using `**Thread:**`; a book's
 * own Chapter 1 can lack a `**Time:**` field entirely and put its only day mention inside
 * `**Setting:**`. `parseHeader` collects every `**Key:** value` line in the metadata block
 * (before the first `---` or the first `## ` heading) into a lowercased map and leaves
 * every downstream extractor to look at whichever of `time`/`setting`/`timeline`/`thread`
 * it needs, falling back through the same order a person skimming the file would.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * This process's own worktree root — `git rev-parse --show-toplevel` from `cwd` — so a
 * bare book number resolves against whichever repo the calling session is actually sitting
 * in (almost never this one), not against `beadcause`'s own tree. A small, deliberate
 * duplicate of the same three lines `lib/cites.js`, `lib/hunks.js`, `lib/where.js`,
 * `lib/run.js`, `lib/which.js` and `lib/prtree.js` already each carry their own copy of,
 * for the reason each of theirs gives: importing one would tie this file's landing order
 * to whichever of those branches happens to merge first.
 */
export function repoRoot(cwd = process.cwd(), fallback = cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

const CH_SUMMARY = /^CHAPTER_(\d+)\.summary\.md$/;
const CH_PROSE = /^CHAPTER_(\d+)\.text[^/]*\.md$/;
const CH_PROP = /^CHAPTER_(\d+)\.propagated\.md$/;
const IL_SUMMARY = /^INTERLUDE_([0-9]+)[^/]*\.summary\.md$/;
const IL_PROSE = /^INTERLUDE_([0-9]+)[A-Za-z0-9_]*\.md$/;

/** A bare integer resolves under `<root>/novel/Deluvia Book <n>`; anything else is a path, relative to `cwd`. */
export function resolveBookDir(bookArg, { root, cwd = process.cwd() } = {}) {
  if (/^\d+$/.test(bookArg)) {
    if (!root) throw new Error(`book number "${bookArg}" needs a repo root to resolve "novel/Deluvia Book ${bookArg}" against, and none was found`);
    return path.join(root, 'novel', `Deluvia Book ${bookArg}`);
  }
  return path.isAbsolute(bookArg) ? bookArg : path.join(cwd, bookArg);
}

/** Directory listing, either the working tree or a git ref, both filenames only. */
export function listDir(root, absDir, ref) {
  if (!ref) {
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
      throw new Error(`no such directory: ${absDir}`);
    }
    return fs.readdirSync(absDir);
  }
  const rel = path.relative(root, absDir).split(path.sep).join('/');
  let out;
  try {
    out = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${rel}`], { cwd: root, encoding: 'utf8' });
  } catch (err) {
    throw new Error(`git ls-tree ${ref}:${rel} failed — ${String(err.message).split('\n')[0]}`);
  }
  return out.split('\n').filter(Boolean);
}

/** One file's text, either the working tree or a git ref. */
export function readAt(root, absDir, filename, ref) {
  if (!ref) return fs.readFileSync(path.join(absDir, filename), 'utf8');
  const rel = path.relative(root, path.join(absDir, filename)).split(path.sep).join('/');
  try {
    return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: root, encoding: 'utf8' });
  } catch (err) {
    throw new Error(`git show ${ref}:${rel} failed — ${String(err.message).split('\n')[0]}`);
  }
}

/**
 * Classifies a directory listing exactly the way `build_series_log.py`'s `measure()`
 * does: `chapters` is the union of summary and prose numbers (a chapter file is a chapter
 * whether or not it has a summary), `planning` is every other `.md` not prefixed
 * `CHAPTER_`/`INTERLUDE_`. Also keeps, per number, every filename that matched — the row
 * builder below reads all of them, not just the one the count regex happened to catch.
 */
export function classify(names) {
  const byNum = (rx) => {
    const nums = new Set();
    const files = new Map();
    for (const name of names) {
      const m = rx.exec(name);
      if (!m) continue;
      const n = Number(m[1]);
      nums.add(n);
      if (!files.has(n)) files.set(n, []);
      files.get(n).push(name);
    }
    return { nums, files };
  };
  const summaries = byNum(CH_SUMMARY);
  const prose = byNum(CH_PROSE);
  const propagated = byNum(CH_PROP);
  const ilSummaries = byNum(IL_SUMMARY);
  const ilProseAll = byNum(IL_PROSE);
  // il_prose in the Python is IL_PROSE minus anything ending .summary.md
  const ilProse = { nums: new Set(), files: new Map() };
  for (const [n, files] of ilProseAll.files) {
    const kept = files.filter((f) => !f.endsWith('.summary.md'));
    if (kept.length) {
      ilProse.nums.add(n);
      ilProse.files.set(n, kept);
    }
  }
  const chapterNums = new Set([...summaries.nums, ...prose.nums]);
  const chapterFiles = new Map();
  for (const n of chapterNums) {
    const files = [...(summaries.files.get(n) || []), ...(prose.files.get(n) || []), ...(propagated.files.get(n) || [])];
    chapterFiles.set(n, files);
  }
  const ilNums = new Set([...ilSummaries.nums, ...ilProse.nums]);
  const ilFiles = new Map();
  for (const n of ilNums) {
    ilFiles.set(n, [...(ilSummaries.files.get(n) || []), ...(ilProse.files.get(n) || [])]);
  }
  const planning = names.filter((n) => n.endsWith('.md') && !n.startsWith('CHAPTER_') && !n.startsWith('INTERLUDE_'));
  return {
    chapterNums,
    chapterFiles,
    summaries,
    prose,
    propagated,
    ilNums,
    ilFiles,
    ilSummaries,
    ilProse,
    planning,
    // Files that named themselves CHAPTER_/INTERLUDE_ but matched none of the count
    // regexes — CHAPTER_18A_THE_PARTING.summary.md is exactly this shape. Surfaced so a
    // caller can tell "not counted" from "not there", never silently dropped.
    uncounted: names.filter(
      (n) =>
        (n.startsWith('CHAPTER_') || n.startsWith('INTERLUDE_')) &&
        !CH_SUMMARY.test(n) &&
        !CH_PROSE.test(n) &&
        !CH_PROP.test(n) &&
        !IL_SUMMARY.test(n) &&
        !IL_PROSE.test(n)
    ),
  };
}

const METADATA_END = /^\s*(---+\s*|##\s+.*)$/;
const FIELD_RE = /^\*\*([^*:]+):\*\*\s*(.*?)\s*$/;
const H1_RE = /^#\s*(.+?)\s*$/m;

/** The metadata block's `**Key:** value` lines, lowercased-and-trimmed keys, plus the raw H1. */
export function parseHeader(text) {
  const lines = text.split(/\r?\n/);
  const fields = new Map();
  let h1 = null;
  for (const line of lines) {
    const h = H1_RE.exec(line);
    if (h && h1 === null) {
      h1 = h[1];
      continue;
    }
    if (h1 !== null && METADATA_END.test(line)) break;
    const f = FIELD_RE.exec(line);
    if (f) {
      const key = f[1].trim().toLowerCase();
      if (!fields.has(key)) fields.set(key, f[2].trim());
    }
  }
  return { h1, fields };
}

const DAY_RANGE_RE = /\bDays?\s+(\d+)\s*(?:[–—-]\s*(\d+))?\b/;
const BP_RE = /~?\s*([\d][\d,]{1,})\s*BP\b/;
const YEAR_RE = /\bYear\s+(\d+)\b/;

/** Searches `time`, then `setting`, then the whole block, for the first `Day(s) N[-M]`. */
export function extractDayRange(fields) {
  for (const key of ['time', 'time of day', 'setting']) {
    const v = fields.get(key);
    if (!v) continue;
    const m = DAY_RANGE_RE.exec(v);
    if (m) return { start: Number(m[1]), end: m[2] ? Number(m[2]) : Number(m[1]), raw: m[0] };
  }
  return null;
}

export function extractBP(fields) {
  for (const key of ['time', 'setting']) {
    const v = fields.get(key);
    if (!v) continue;
    const m = BP_RE.exec(v);
    if (m) return { value: Number(m[1].replace(/,/g, '')), raw: m[0] };
  }
  return null;
}

export function extractYear(fields) {
  const v = fields.get('time');
  if (!v) return null;
  const m = YEAR_RE.exec(v);
  return m ? { value: Number(m[1]), raw: m[0] } : null;
}

/** `**Timeline:**` in five books, `**Thread:**` in three — same slot, two names. */
export function extractThread(fields) {
  const v = fields.get('timeline') || fields.get('thread');
  if (!v) return null;
  const m = /^([A-Za-z0-9]+)/.exec(v.trim());
  return { code: m ? m[1] : v.trim(), raw: v };
}

/** Best-effort: the first 1–3 digit number inside the POV field's own parenthetical. */
export function extractAge(fields) {
  const v = fields.get('pov');
  if (!v) return null;
  const paren = /\(([^)]*)\)/.exec(v);
  if (!paren) return null;
  const m = /\b(\d{1,3})\b/.exec(paren[1]);
  return m ? Number(m[1]) : null;
}

const WORD_TARGET_RE = /\*\*(?:Target word count|Length target)\s*:\*\*\s*([^\n]+)/i;

export function extractWordTarget(text) {
  const m = WORD_TARGET_RE.exec(text);
  if (!m) return null;
  const raw = m[1].trim();
  const nums = raw.match(/[\d,]+/g);
  return {
    raw,
    min: nums ? Number(nums[0].replace(/,/g, '')) : null,
    max: nums && nums[1] ? Number(nums[1].replace(/,/g, '')) : nums ? Number(nums[0].replace(/,/g, '')) : null,
  };
}

const PLACEMENT_RE = /after\s+chapter\s+(\d+)[^.]*?before\s+chapter\s+(\d+)/i;

export function extractPlacement(fields) {
  const v = fields.get('placement');
  if (!v) return null;
  const m = PLACEMENT_RE.exec(v);
  if (!m) return { raw: v, afterCh: null, beforeCh: null };
  return { raw: v, afterCh: Number(m[1]), beforeCh: Number(m[2]) };
}

/** Whitespace word count of a whole file's text — includes the header block, deliberately: it is what `wc -w` on the file gives, and every hand-built version this replaces measured the file, not "the prose part of" it. */
export function wordCount(text) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Sorted-by-day-start overlap/gap pairs within each thread. Rows without a day range are
 * skipped, not treated as zero. Compares each entry against the *widest-reaching* entry
 * seen so far in start order, not merely the one immediately before it — a chapter fully
 * nested inside an earlier one's range (rare, but real: a flashback or an aside dated
 * inside a day another chapter already spans) would otherwise report a false gap between
 * the nested chapter's own end and whatever comes next, when the containing chapter's
 * range was still covering those days the whole time.
 */
export function dayIssues(chapterRows) {
  const byThread = new Map();
  for (const row of chapterRows) {
    if (!row.dayRange || !row.thread) continue;
    const key = row.thread.code;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(row);
  }
  const overlaps = [];
  const gaps = [];
  for (const [thread, rows] of byThread) {
    const sorted = [...rows].sort((a, b) => a.dayRange.start - b.dayRange.start);
    let covered = null; // the entry with the furthest-reaching end seen so far
    for (const cur of sorted) {
      if (covered) {
        if (cur.dayRange.start <= covered.dayRange.end) {
          overlaps.push({
            thread,
            a: { num: covered.num, label: covered.label, range: covered.dayRange },
            b: { num: cur.num, label: cur.label, range: cur.dayRange },
          });
        } else if (cur.dayRange.start > covered.dayRange.end + 1) {
          gaps.push({
            thread,
            a: { num: covered.num, label: covered.label, range: covered.dayRange },
            b: { num: cur.num, label: cur.label, range: cur.dayRange },
            missing: [covered.dayRange.end + 1, cur.dayRange.start - 1],
          });
        }
      }
      if (!covered || cur.dayRange.end > covered.dayRange.end) covered = cur;
    }
  }
  return { overlaps, gaps };
}

/** Non-monotone or out-of-range interlude placement keys. */
export function placementIssues(interludeRows, maxChapterNum) {
  const issues = [];
  for (const row of interludeRows) {
    const p = row.placement;
    if (!p) continue;
    if (p.afterCh === null) {
      issues.push({ num: row.num, label: row.label, kind: 'unparseable', detail: p.raw });
      continue;
    }
    if (p.beforeCh !== p.afterCh + 1) {
      issues.push({
        num: row.num,
        label: row.label,
        kind: 'inconsistent',
        detail: `after Ch. ${p.afterCh} but before Ch. ${p.beforeCh} (expected ${p.afterCh + 1})`,
      });
    }
    if (maxChapterNum && (p.afterCh > maxChapterNum || p.beforeCh > maxChapterNum + 1)) {
      issues.push({
        num: row.num,
        label: row.label,
        kind: 'out-of-range',
        detail: `placement names Ch. ${Math.max(p.afterCh, p.beforeCh)}, past the book's last chapter (Ch. ${maxChapterNum})`,
      });
    }
  }
  const sorted = [...interludeRows]
    .filter((r) => r.placement && r.placement.afterCh !== null)
    .sort((a, b) => a.num - b.num);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.placement.afterCh < prev.placement.afterCh) {
      issues.push({
        num: cur.num,
        label: cur.label,
        kind: 'non-monotone',
        detail: `placed after Ch. ${cur.placement.afterCh}, before ${prev.label} (interlude #${prev.num}), which is placed after Ch. ${prev.placement.afterCh}`,
      });
    }
  }
  return issues;
}

function buildRow(num, files, root, absDir, ref, kind) {
  const preferred = files.find((f) => f.endsWith('.summary.md')) || files[0];
  const text = readAt(root, absDir, preferred, ref);
  const { h1, fields } = parseHeader(text);
  const fileRows = files.map((f) => {
    let words = null;
    try {
      words = wordCount(readAt(root, absDir, f, ref));
    } catch {
      words = null;
    }
    return { file: f, words };
  });
  const row = {
    num,
    label: h1 || (kind === 'chapter' ? `CHAPTER ${num}` : `INTERLUDE ${num}`),
    pov: fields.get('pov') || null,
    age: extractAge(fields),
    thread: extractThread(fields),
    setting: fields.get('setting') || null,
    dayRange: extractDayRange(fields),
    bp: extractBP(fields),
    year: extractYear(fields),
    wordTarget: extractWordTarget(text),
    status: fields.get('status') || null,
    files: fileRows,
  };
  if (kind === 'interlude') {
    row.placement = extractPlacement(fields);
    row.voice = fields.get('voice') || fields.get('voice mode') || null;
  }
  return row;
}

/**
 * The whole manifest for one book directory: one row per chapter, one per interlude
 * (both in numeric order), file-count totals shaped exactly like
 * `build_series_log.py`'s per-book block, and the derived overlap/gap/placement checks.
 */
export function buildManifest({ dir, root, ref = null } = {}) {
  const names = listDir(root, dir, ref);
  const c = classify(names);
  const chapters = [...c.chapterNums]
    .sort((a, b) => a - b)
    .map((n) => buildRow(n, c.chapterFiles.get(n), root, dir, ref, 'chapter'));
  const interludes = [...c.ilNums]
    .sort((a, b) => a - b)
    .map((n) => buildRow(n, c.ilFiles.get(n), root, dir, ref, 'interlude'));
  const maxChapterNum = chapters.length ? Math.max(...chapters.map((r) => r.num)) : 0;
  const { overlaps, gaps } = dayIssues(chapters);
  const placement = placementIssues(interludes, maxChapterNum);
  return {
    dir,
    ref,
    chapters,
    interludes,
    totals: {
      chapters: c.chapterNums.size,
      summaries: c.summaries.nums.size,
      prose: c.prose.nums.size,
      propagated: c.propagated.nums.size,
      interludeOutlines: c.ilSummaries.nums.size,
      interludeProse: c.ilProse.nums.size,
    },
    uncounted: c.uncounted,
    issues: { overlaps, gaps, placement },
  };
}
