/**
 * The git plumbing behind `bin/b7e-hunks` — every conflict hunk in the working tree,
 * addressable by a stable `<file>#<n>` id, with both sides read out safely.
 *
 * bc-dgx7.78 names three deluvia sessions (`dv-3rn.1`, `dv-b5d.14`, `dv-gr6.43`) that each
 * spent most of a run resolving merge conflicts one hunk at a time, each inventing its own
 * enumerator by hand — an `awk` state machine, `grep -n '^<<<<<<< HEAD|^=======$|^>>>>>>> '`,
 * `git show :2:`/`:3:` into scratch files, a dozen near-identical `re.subn` heredocs. None
 * of that decided anything (which side wins is still the judgement); it was all the same
 * three sub-tasks retyped every time: list what is conflicted, print a wide hunk without
 * overflowing an agent's output cap, and take a side without leaving a marker behind.
 *
 * Discovery is git's own unmerged-file list — `git diff --name-only --diff-filter=U` — the
 * same set `git status` reports as `UU`/`AA`/`DD`/etc. That is deliberately narrower than a
 * full-repo grep for `<<<<<<<`: this repo's own README is 600KB of Markdown and a bare
 * content scan would have to worry about `=======` occurring as a setext heading underline
 * (see `lib/conflicted.js`'s note on the same hazard). A hunk itself is still found purely
 * structurally — `<<<<<<<` → optional `|||||||` (diff3) → `=======` → `>>>>>>>` — so a false
 * `=======` elsewhere in a conflicted file is never mistaken for a separator: the state
 * machine only looks for one once a real `<<<<<<<` has opened.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { markersIn, isBinary } from './conflicted.js';

const OURS_RE = /^<{7}(?: (.*?))?\r?$/;
const BASE_RE = /^\|{7}(?: (.*?))?\r?$/;
const SEP_RE = /^={7}\r?$/;
const THEIRS_RE = /^>{7}(?: (.*?))?\r?$/;

/** Every path git currently considers unmerged, repo-relative, in git's own order. */
export function conflictedFiles(repoRoot) {
  let out;
  try {
    out = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `repoRoot`'s git toplevel, or `null` if `dir` is not inside a git repository.
 */
export function repoRootOf(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Every conflict hunk in `text`, in order of appearance, 1-indexed by position within the
 * file — the id a hunk gets (`#1`, `#2`, …) is exactly this order, so it stays stable
 * across calls as long as the file's own marker content does not change out from under it.
 * Resolving one hunk in a file changes the numbering of every hunk after it in that same
 * file (there is genuinely one fewer hunk above them now) — pass every id you mean to take
 * in a file together, in one `--take` call, rather than one id per call across several.
 *
 * Supports both merge styles: plain two-way (`<<<<<<<` / `=======` / `>>>>>>>`) and diff3
 * three-way (an extra `|||||||` base section before the `=======`). A hunk that never finds
 * its closing `=======`/`>>>>>>>` is dropped rather than guessed at — an unterminated marker
 * means the file is not actually in git's conflicted shape, and inventing a boundary would
 * silently mis-address every hunk after it.
 */
export function parseHunks(text) {
  const lines = text.split('\n');
  const hunks = [];
  let i = 0;
  while (i < lines.length) {
    const oursStart = lines[i].match(OURS_RE);
    if (!oursStart) {
      i += 1;
      continue;
    }
    const startLine = i + 1;
    const oursLabel = oursStart[1] || '';
    i += 1;

    const oursLines = [];
    while (i < lines.length && !BASE_RE.test(lines[i]) && !SEP_RE.test(lines[i])) {
      oursLines.push(lines[i]);
      i += 1;
    }

    let baseLines = null;
    if (i < lines.length && BASE_RE.test(lines[i])) {
      i += 1;
      baseLines = [];
      while (i < lines.length && !SEP_RE.test(lines[i])) {
        baseLines.push(lines[i]);
        i += 1;
      }
    }

    if (i >= lines.length || !SEP_RE.test(lines[i])) break; // unterminated — not a real hunk
    i += 1; // past =======

    const theirsLines = [];
    while (i < lines.length && !THEIRS_RE.test(lines[i])) {
      theirsLines.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) break; // unterminated — not a real hunk

    const theirsMatch = lines[i].match(THEIRS_RE);
    const theirsLabel = theirsMatch[1] || '';
    const endLine = i + 1;
    i += 1;

    hunks.push({
      index: hunks.length + 1,
      startLine,
      endLine,
      oursLabel,
      theirsLabel,
      oursLines,
      baseLines,
      theirsLines,
    });
  }
  return hunks;
}

/** `{file, hunks}` for one repo-relative file, read off disk as it stands right now. */
export function hunksForFile(repoRoot, file) {
  const abs = path.join(repoRoot, file);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return { file, hunks: [], missing: true };
  }
  if (isBinary(buf)) return { file, hunks: [], binary: true };
  return { file, hunks: parseHunks(buf.toString('utf8')) };
}

/** `{file, hunks}` for every file git currently considers unmerged, hunks may be empty. */
export function allHunks(repoRoot) {
  return conflictedFiles(repoRoot).map((file) => hunksForFile(repoRoot, file));
}

/** A `<file>#<n>` id split into its parts, or `null` if it is not shaped like one. */
export function parseId(id) {
  const m = /^(.+)#(\d+)$/.exec(id);
  if (!m) return null;
  return { file: m[1], index: Number(m[2]) };
}

/** One line, cut to `width` chars with a trailing count of what was dropped. */
export function truncate(line, width) {
  if (line == null) return '<empty>';
  if (line.length <= width) return line || '<blank>';
  return `${line.slice(0, width)}…[+${line.length - width} chars]`;
}

/**
 * Resolve a batch of `{file, index, side}` edits against the working tree, all-or-nothing:
 * every id is checked to name a real hunk in its file *before* anything is written, the same
 * shape `bin/b7e-apply` uses for the same reason — a patch that is half-valid should not
 * half-apply, leaving the caller to work out which half landed.
 *
 * Edits to the same file are applied together, from the bottom of the file up, so replacing
 * one hunk never shifts the line numbers of another hunk in the same file still waiting to
 * be applied. Hunks in that file not named in `edits` are left byte-for-byte untouched.
 *
 * Returns `{ error }` if any id was invalid, naming every bad one — nothing is written in
 * that case. Otherwise returns `{ applied }`, one entry per edit, in the order given.
 */
export function takeHunks(repoRoot, edits) {
  const byFile = new Map();
  for (const e of edits) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }

  const parsedByFile = new Map();
  const bad = [];
  for (const file of byFile.keys()) {
    const abs = path.join(repoRoot, file);
    if (!fs.existsSync(abs)) {
      bad.push(`${file}#? — no such file`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    const hunks = parseHunks(text);
    parsedByFile.set(file, { text, hunks });
  }

  for (const e of edits) {
    const parsed = parsedByFile.get(e.file);
    const found = parsed && parsed.hunks.find((h) => h.index === e.index);
    if (found) continue;
    if (!parsed) continue; // already reported as "no such file" above
    const hint = parsed.hunks.length
      ? `file now has ${parsed.hunks.length} hunk(s) — resolving an earlier hunk in the same file renumbers the ones after it; re-run b7e-hunks to see current ids`
      : 'file has no hunks left — already resolved';
    bad.push(`${e.file}#${e.index} — no such hunk (${hint})`);
  }
  if (bad.length) return { error: `unresolved hunk id(s): ${bad.join(', ')}` };

  const applied = [];
  for (const [file, fileEdits] of byFile) {
    const { text, hunks } = parsedByFile.get(file);
    const lines = text.split('\n');
    const byIndex = new Map(fileEdits.map((e) => [e.index, e]));
    // Bottom-up so an earlier hunk's line numbers are never shifted by a later replacement.
    const ordered = [...hunks].filter((h) => byIndex.has(h.index)).sort((a, b) => b.startLine - a.startLine);
    for (const h of ordered) {
      const e = byIndex.get(h.index);
      const replacement = e.side === 'ours' ? h.oursLines : h.theirsLines;
      lines.splice(h.startLine - 1, h.endLine - h.startLine + 1, ...replacement);
      applied.push({ file, index: h.index, side: e.side, startLine: h.startLine, endLine: h.endLine, lines: replacement.length });
    }
    fs.writeFileSync(path.join(repoRoot, file), lines.join('\n'));
  }

  applied.sort((a, b) => edits.findIndex((e) => e.file === a.file && e.index === a.index) - edits.findIndex((e) => e.file === b.file && e.index === b.index));
  return { applied };
}

/**
 * Stage every one of `files` that is clean — reads the working-tree content and reuses
 * `markersIn` from `lib/conflicted.js` so this is the exact same detection the committed-
 * conflict-marker check runs, rather than a second implementation that could disagree with
 * it. A file that still carries a marker is refused, never staged — the dv-3rn.1 failure
 * this whole command exists to close off: `git add` marks a conflict resolved by touching
 * it, not by inspecting it, so it will happily stage a file mid-merge with markers still in it.
 */
export function stageFiles(repoRoot, files) {
  const staged = [];
  const refused = [];
  for (const file of files) {
    const abs = path.join(repoRoot, file);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      refused.push({ file, reason: 'no such file' });
      continue;
    }
    const markers = markersIn(text);
    if (markers.length) {
      refused.push({ file, reason: `${markers.length} marker${markers.length === 1 ? '' : 's'} remain`, markers });
      continue;
    }
    execFileSync('git', ['add', '--', file], { cwd: repoRoot });
    staged.push(file);
  }
  return { staged, refused };
}
