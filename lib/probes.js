/**
 * The gate half of `b7e-claims`: python source that names a target by string literal
 * ("gate probes"), and the numeric literals inside those same gates that would move if
 * the target's referencedness changed ("BLOCKERS-style enumerations"). `lib/corpus.js`
 * is the markdown half; `bin/b7e-claims` is the CLI that joins both.
 *
 * Built against deluvia's `scripts/check_saga_audit.py`, the repo bc-dgx7.60 exists to
 * stop re-deriving by hand, but nothing here names that file — the shapes it matches
 * (a `check(id, description, condition)` call, a docstring or `# TAG -- ...` comment
 * naming an audit section, an ALL_CAPS module constant compared inside one of those
 * checks) are the conventions of that whole *family* of scripts, not one file's syntax.
 *
 * NO PYTHON PARSER. Everything below is line-and-regex matching, same tradeoff
 * `bin/b7e-def` makes for JS: good enough for the disciplined, heavily-commented style
 * these audit scripts are actually written in, not a substitute for reading the file
 * when a literal spans multiple lines or a `check(` call is built dynamically.
 */
import fs from 'node:fs';
import path from 'node:path';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CHECK_CALL_RE = /\bcheck\(\s*["']([^"']+)["']/;
const MODULE_COMMENT_SECTION_RE = /^#\s*([A-Za-z]{1,4}\d+(?:\.\d+)*)\b\s*--/;
const DEF_RE = /^def\s+(\w+)\s*\(/;
const DOCSTRING_SECTION_RE = /^\s*(?:"""|''')\s*([A-Za-z]{1,4}\d+(?:\.\d+)*)\b/;

/** The section id a `def` block's own docstring opens with, looked up within 3 lines. */
function sectionIdForFuncAt(lines, defLineIdx) {
  for (let j = defLineIdx + 1; j < Math.min(lines.length, defLineIdx + 4); j += 1) {
    const t = lines[j];
    if (!t.trim()) continue;
    const m = DOCSTRING_SECTION_RE.exec(t);
    return m ? m[1] : null;
  }
  return null;
}

/**
 * One row per line where a python file names `target` by string literal — `path:line`,
 * the id of the `check(...)` call it belongs to (or the enclosing function's own
 * section id, or the nearest `# TAG -- ...` comment above it, in that order of
 * preference), and the trimmed source line.
 */
export function claimsInPython(root, files, target) {
  const out = [];
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    let funcSectionId = null;
    let checkId = null;
    let commentId = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const defM = DEF_RE.exec(line);
      if (defM) {
        funcSectionId = sectionIdForFuncAt(lines, i);
        checkId = null;
      }
      const commentM = !/^\s/.test(line) ? MODULE_COMMENT_SECTION_RE.exec(line) : null;
      if (commentM) commentId = commentM[1];
      const checkM = CHECK_CALL_RE.exec(line);
      if (checkM) checkId = checkM[1];

      for (const needle of target.needles) {
        const idx =
          target.kind === 'section'
            ? (() => {
                const wm = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(needle)}(?![A-Za-z0-9_])`).exec(line);
                return wm ? wm.index : -1;
              })()
            : line.indexOf(needle);
        if (idx === -1) continue;
        out.push({
          file: rel,
          line: i + 1,
          checkId: checkM ? checkM[1] : checkId || funcSectionId || commentId || null,
          needle,
          text: line.trim(),
        });
        break;
      }
    }
  }
  return out;
}

/** `def name(...):` at column 0 to the line before the next one, or EOF. Module scope only. */
function functionBodies(lines) {
  const defs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = DEF_RE.exec(lines[i]);
    if (m) defs.push({ start: i, name: m[1] });
  }
  return defs.map((d, idx) => ({
    ...d,
    end: idx + 1 < defs.length ? defs[idx + 1].start : lines.length,
    sectionId: sectionIdForFuncAt(lines, d.start),
  }));
}

/** `NAME = <literal>` at column 0 — the fragile constants a `check(...)` compares against. */
function moduleConstants(lines) {
  const out = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s/.test(line) || line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out.set(m[1], { value: m[2], line: i + 1 });
  }
  return out;
}

/** `os.path.join(root, "reference")`-shaped literals inside a function's own body. */
function directoryLiteralsIn(bodyLines) {
  const dirs = new Set();
  const re = /os\.path\.join\(\s*root\s*,\s*["']([^"']+)["']/g;
  for (const line of bodyLines) {
    let m;
    while ((m = re.exec(line))) dirs.add(m[1]);
  }
  return dirs;
}

/**
 * Which directory, under `root`, a `path`/`basename` target actually lives in — a
 * `path` target is trusted as given; a bare `basename` is resolved by finding the one
 * markdown file under `root` with that name. Ambiguous (0 or 2+ matches) resolves to
 * `null`, which is "no numeric-literal check to make", not an error — the prose and
 * gate-probe halves still run.
 */
function resolveTargetDir(root, mdFiles, target) {
  if (target.kind === 'path') return path.dirname(target.path);
  if (target.kind !== 'basename') return null;
  const matches = mdFiles.filter((rel) => path.basename(rel) === target.basename);
  if (matches.length !== 1) return null;
  return path.dirname(matches[0]);
}

/**
 * A gate's numeric literal is "at risk" from a target when: the literal is an ALL_CAPS
 * module constant, it is compared (`==`, `!=`, `>=`, `<=`) somewhere inside a function
 * that both (a) enumerates files under the target's own directory
 * (`os.path.join(root, "<that dir>")` appearing literally in the function body) and
 * (b) filters to markdown (`.md` appears literally in the function body too, so a
 * source-file line-count check over the same directory doesn't false-positive).
 *
 * This is deliberately structural, not computed: it does not re-run the enumeration to
 * ask whether the constant's *current* value is still correct, only whether editing the
 * target could move it — "would move if it changed" is the bead's own phrasing, not
 * "is currently wrong". `check_saga_audit.py`'s S5.2 (`UNREFERENCED = 14`) is the
 * motivating case: nothing in that function's source names any one reference file, so
 * the literal-string half above never finds it, and dv-gsh cost two red gate runs
 * learning that merely *naming* an orphan file elsewhere still moves this count.
 */
export function numericLiteralsAtRisk(root, files, target, mdFiles) {
  const targetDir = resolveTargetDir(root, mdFiles, target);
  if (!targetDir) return [];
  const out = [];
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const consts = moduleConstants(lines);
    for (const fn of functionBodies(lines)) {
      const bodyLines = lines.slice(fn.start, fn.end);
      if (!directoryLiteralsIn(bodyLines).has(targetDir)) continue;
      if (!bodyLines.some((l) => /\.md\b/.test(l))) continue;
      for (const [name, info] of consts) {
        const boundary = new RegExp(`\\b${name}\\b`);
        const usedInComparison = bodyLines.some((l) => boundary.test(l) && /==|!=|>=|<=/.test(l));
        if (!usedInComparison) continue;
        out.push({
          file: rel,
          line: info.line,
          checkId: fn.sectionId || null,
          constName: name,
          constValue: info.value,
          reason: `${fn.name}() enumerates markdown files under ${targetDir}/ and compares a count against ${name} — editing this file's referencedness elsewhere can move it`,
        });
      }
    }
  }
  const seen = new Set();
  return out.filter((h) => {
    const key = `${h.file}:${h.line}:${h.constName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
