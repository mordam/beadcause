/**
 * Every occurrence of a retired figure, split into two lists: still a live assertion,
 * or the record of its own retirement — `bin/b7e-retired` is the argv shell; this is
 * the matching and the classification.
 *
 * `bc-dgx7.129`: a session audit found the same shape of work in four deluvia sessions
 * (`dv-5i2.97`, `dv-5i2.92`, `dv-5i2.96`, `dv-5i2.98`), each hand-grepping a corpus for a
 * superseded number and then hand-sorting the hits — and no two sorted them the same
 * way, because the sorting, not the search, is where the calls went. A pure grep would
 * false-positive on: a table row that names the old figure *in order to retire it*
 * ("Superseded figures (Entry 040)"); a `CHANGE_LOG.md` entry whose whole body is the
 * decision text that did the retiring; a "Notes for Adam" worklog paragraph reporting
 * that the drift was found and already filed; and a number that means something else
 * entirely ("80–100 m wide" is a canal, not a sea level). This module is those four
 * checks plus a fifth (`--unit`) made mechanical, so the search and the sort are one
 * call instead of a grep and a judgement.
 *
 * ## The four rules that demote a match out of LIVE, checked in this order
 *
 * 1. **`--datum-dir`** — the file sits under a directory declared to be on another
 *    datum entirely (deluvia's `reference/regions/cycle1/` is deliberately at a −100 m
 *    standard while the rest of the corpus reads −65 m). Checked first because it is a
 *    fact about the whole file, not about the sentence the match sits in.
 * 2. **`--unit`** — the noun the number is supposed to modify does not appear near the
 *    match. "Sea levels 80–100 m lower" passes (the phrase `sea level` sits right next
 *    to the figure); "180 km long, 80–100 m wide" does not — same figure, same file
 *    family, a different thing being measured. Skipped entirely when `--unit` is not
 *    given, in which case every match is assumed to be on-unit.
 * 3. **Inside a `CHANGE_LOG.md` entry body** — reuses `entryHeadings` from
 *    `lib/changelog.js` rather than re-deriving a `## Entry NNN` span a second way; see
 *    that module for why a line-number guess at where one entry ends is not safe here.
 * 4. **A markdown table row (or its header row), or a heading, naming
 *    Superseded/Retired/Entry NNN** — the row *is* the record: "Sea level '−80–100 m' |
 *    Superseded figures (Entry 040) | −65 m current" is not an assertion that the
 *    figure still holds, it is the file's own note that it does not, filed for
 *    prompt-writers to recognise the phrasing and not re-copy it.
 * 5. **Inside a "Notes for Adam" / worklog block** — a heading of that name is a
 *    session's own running report, not canon; "`SUNDALAND.md` still says '80–100 m
 *    lower' ... filed as its own bead" is the finding that produced this very tool, not
 *    a fresh assertion of the retired figure.
 *
 * Nothing here writes. Working-tree files are read with `fs`; `--rev` reads through
 * `git cat-file` (`lib/gitref.js`'s `readRefFile`) so a stray `.claude/worktrees/*`
 * checkout, or the working tree's own uncommitted edits, is never read by accident.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, readRefFile } from './gitref.js';
import { entryHeadings } from './changelog.js';

/** Directories a working-tree walk never descends into — never source, often huge. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', '.beads', 'dist', 'build', 'coverage']);

/** Any dash-like character a copyeditor or a template might have used for one. */
const DASH_CLASS = '[-‐‑‒–—−]';

/**
 * `value` as a `RegExp` that matches it wherever the punctuation drifted: every literal
 * `-` in `value` stands for hyphen, en dash, em dash *or* minus sign (deluvia's own
 * region files use `–`, U+2013, throughout; `--value` is typed with a plain `-`), and a
 * run of spaces matches a run of any whitespace. Everything else is escaped literally.
 */
export function valuePattern(value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withDash = escaped.replace(/-/g, DASH_CLASS);
  const withSpace = withDash.replace(/ +/g, '\\s+');
  return new RegExp(withSpace, 'gi');
}

/**
 * Does `unit` (e.g. `"sea level"`) appear within a short window of one match on `line`?
 * Tolerates a trailing `s` (`"sea levels"`) since the figure is nearly always plural in
 * prose even when the flag is given singular. `true` when no `unit` was given at all —
 * the check is opt-in, not a requirement.
 */
export function unitNearby(line, matchIndex, matchLen, unit) {
  if (!unit) return true;
  const WINDOW = 60;
  const start = Math.max(0, matchIndex - WINDOW);
  const end = Math.min(line.length, matchIndex + matchLen + WINDOW);
  const window = line.slice(start, end);
  const escaped = String(unit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}s?`, 'i').test(window);
}

/** The nearest markdown heading (`^#{1,6} `) at or above `lines[idx]`, or `null`. */
export function nearestHeadingAbove(lines, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    const m = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (m) return { line: i, text: m[1].trim() };
  }
  return null;
}

const SUPERSEDED_RE = /superseded|retired|entry\s*\d+/i;
const NOTES_RE = /notes for adam|worklog/i;

/**
 * The match's own row names Superseded/Retired/Entry NNN, or sits in a table whose
 * header row does, or sits under a heading that does — any one is the record of a
 * retirement, not an assertion of one. Returns a human sentence, or `null`.
 */
export function tableOrHeadingRule(lines, idx) {
  const row = lines[idx];
  if (/^\s*\|/.test(row) && SUPERSEDED_RE.test(row)) {
    return `a table row naming Superseded/Retired/Entry NNN: "${row.trim()}"`;
  }
  const heading = nearestHeadingAbove(lines, idx);
  if (heading && SUPERSEDED_RE.test(heading.text)) {
    return `under a heading naming Superseded/Retired: "${heading.text}"`;
  }
  if (/^\s*\|/.test(row)) {
    let top = idx;
    while (top > 0 && /^\s*\|/.test(lines[top - 1])) top -= 1;
    if (top !== idx && SUPERSEDED_RE.test(lines[top])) {
      return `a table whose header row names Superseded/Retired/Entry NNN: "${lines[top].trim()}"`;
    }
  }
  return null;
}

/** The match sits under a "Notes for Adam" / worklog heading — a report, not canon. */
export function notesForAdamRule(lines, idx) {
  const heading = nearestHeadingAbove(lines, idx);
  if (heading && NOTES_RE.test(heading.text)) {
    return `inside a "${heading.text}" block`;
  }
  return null;
}

/** `CHANGE_LOG.md`, `CHANGELOG.md`, `changelog.md` — never a file that merely mentions one. */
export function isChangeLogFile(relPath) {
  const base = path.basename(relPath, path.extname(relPath));
  return /^change.?log$/i.test(base);
}

/** The 1-indexed line `charIndex` falls on, within `text`. */
function lineNumberAt(text, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * `line1` (1-indexed) falls inside some `## Entry NNN` body in `text` — reusing
 * `entryHeadings` (`lib/changelog.js`) rather than re-deriving the span, for the exact
 * reason that module's own header gives: a number-arithmetic guess at where one entry
 * ends walks past a gap in the numbering into the wrong entry.
 */
export function changeLogEntryRule(text, line1) {
  for (const h of entryHeadings(text)) {
    const startLine = lineNumberAt(text, h.index);
    const endLine = startLine + h.body.split('\n').length - 1;
    if (line1 >= startLine && line1 <= endLine) {
      return `inside CHANGE_LOG Entry ${h.digits}${h.suffix}'s body (line ${startLine}-${endLine})`;
    }
  }
  return null;
}

/** `relPath` sits under `datumDir` (a leading-path match, `/`-normalised either way). */
function underDir(relPath, datumDir) {
  const norm = (s) => s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const file = norm(relPath);
  const dir = norm(datumDir);
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * One match's verdict: `{ live: true, reason }` (why it counts as an assertion) or
 * `{ live: false, rule, reason }` (which of the five demoted it, and the detail).
 */
export function classifyMatch({ relPath, text, lines, lineIdx, matchIndex, matchLen, value, instead, unit, datumDirs }) {
  for (const d of datumDirs || []) {
    if (underDir(relPath, d)) {
      return { live: false, rule: 'datum-dir', reason: `${relPath} is declared on another datum (--datum-dir ${d})` };
    }
  }
  if (!unitNearby(lines[lineIdx], matchIndex, matchLen, unit)) {
    return { live: false, rule: 'unit-mismatch', reason: `does not modify "${unit}" here — a different unit` };
  }
  if (isChangeLogFile(relPath)) {
    const r = changeLogEntryRule(text, lineIdx + 1);
    if (r) return { live: false, rule: 'changelog-entry', reason: r };
  }
  const t = tableOrHeadingRule(lines, lineIdx);
  if (t) return { live: false, rule: 'superseded-table-or-heading', reason: t };
  const n = notesForAdamRule(lines, lineIdx);
  if (n) return { live: false, rule: 'notes-for-adam', reason: n };
  const reason = `still asserts '${value}'${unit ? ` as ${unit}` : ''}${instead ? `, not '${instead}'` : ''}`;
  return { live: true, reason };
}

/** Every match of `value` in `text`, classified — `relPath` is used for the file-scoped rules. */
export function scanText(relPath, text, { value, instead, unit, datumDirs }) {
  const re = valuePattern(value);
  const lines = text.split('\n');
  const out = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const verdict = classifyMatch({
        relPath,
        text,
        lines,
        lineIdx,
        matchIndex: m.index,
        matchLen: m[0].length,
        value,
        instead,
        unit,
        datumDirs,
      });
      out.push({ file: relPath, line: lineIdx + 1, text: line.trim(), ...verdict });
      if (m[0].length === 0) re.lastIndex += 1; // never spin on a zero-width match
    }
  }
  return out;
}

/** Extensions never worth reading as text — a cheap pre-filter before the null-byte sniff. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.mp3', '.mp4', '.mov', '.wav', '.blend', '.glb', '.gltf', '.woff', '.woff2', '.ttf',
  '.eot',
]);

/** `content` reads as text, not a binary blob wearing a text-ish extension. */
function looksLikeText(buf) {
  const scan = buf.subarray(0, Math.min(buf.length, 8192));
  return !scan.includes(0);
}

/** Every file under `dir` matching `pathspecs` (prefix match; `[]` means everything), skipping SKIP_DIRS and binaries. */
export function walkWorkingTree(dir, pathspecs) {
  const specs = (pathspecs || []).map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
  const matches = (rel) => !specs.length || specs.some((s) => rel === s || rel.startsWith(`${s}/`));
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(childAbs, childRel);
      } else if (e.isFile() && matches(childRel)) {
        if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

/** Every file matching `pathspecs` at `rev` (`git ls-tree -r --name-only`). */
export async function listFilesAtRev(dir, rev, pathspecs) {
  const args = ['ls-tree', '-r', '--name-only', rev];
  if (pathspecs && pathspecs.length) args.push('--', ...pathspecs);
  const out = await git(dir, args);
  return String(out || '')
    .split('\n')
    .filter(Boolean)
    .filter((f) => !BINARY_EXT.has(path.extname(f).toLowerCase()));
}

/**
 * The whole answer: every match of `value` under `dir`, split into `live` and
 * `recorded`. `rev` given reads through git at that ref; omitted reads the working
 * tree directly off disk (uncommitted edits included — the point of not defaulting to
 * a ref here is that `bin/b7e-retired` is meant to be run against exactly what is
 * about to be committed).
 */
export async function classify(dir, { value, instead, unit, datumDirs = [], rev = null, pathspecs = [] } = {}) {
  const files = rev ? await listFilesAtRev(dir, rev, pathspecs) : walkWorkingTree(dir, pathspecs);
  const all = [];
  for (const relPath of files) {
    // eslint-disable-next-line no-await-in-loop -- one file at a time; a corpus is a few hundred at most
    const text = rev ? await readRefFile(dir, rev, relPath) : readWorkingFile(dir, relPath);
    if (text === null) continue;
    if (!looksLikeText(Buffer.from(text.slice(0, 8192)))) continue;
    all.push(...scanText(relPath, text, { value, instead, unit, datumDirs }));
  }
  return {
    live: all.filter((r) => r.live),
    recorded: all.filter((r) => !r.live),
  };
}

function readWorkingFile(dir, relPath) {
  try {
    return fs.readFileSync(path.join(dir, relPath), 'utf8');
  } catch {
    return null;
  }
}
