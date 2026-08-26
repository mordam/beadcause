/**
 * The tree-wide walk and the markdown half of `b7e-claims`: every file under some root,
 * what a target argument actually names, and the prose sentences that name it back.
 * `bin/b7e-claims` is the CLI; this is the walk and the matching, pure. `lib/probes.js`
 * is the other half — gate scripts (`scripts/*.py`-shaped) and the numeric literals
 * inside them that would move if the target changed.
 *
 * bc-dgx7.60 is the audit: five sessions in the deluvia tracker (dv-6cn, dv-gsh, dv-nnk,
 * dv-i5v, dv-ek4) each hand-derived "who else talks about this file, before I touch it" —
 * because that repo's gates assert the *broken* state positively, so fixing a thing turns
 * unrelated scripts and prose red, far from the file that changed. Each described the
 * derivation afterwards as the bulk of the work. This is the command that replaces it.
 *
 * **This walker is its own copy, not `lib/cites.js`'s.** `collectFiles` there is scoped to
 * *this* repo's own fixed roots (`lib`, `bin`, `test`, `scripts`, `public`, `android` +
 * `README.md`) — right for citing a bead id inside beadcause, wrong for a target that
 * lives in an arbitrary other checkout (deluvia's `reference/`, `compendium/`, `novel/`,
 * ... have none of those names). `walk` below takes the whole tree from `root` instead,
 * with only the exclusions any checkout needs (`.git`, `node_modules`, build output) —
 * `.claude` is one of them, which is also what keeps a sibling worktree's own copy of a
 * file (deluvia keeps dozens live at once) from ever being a second hit.
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.claude',
  '__pycache__',
  'venv',
  'dist',
  'build',
  '.gradle',
  '.idea',
  '_attic',
  'coverage',
  '.coverage',
]);

const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

function walk(root, absDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // gone, or never existed — not this scan's problem
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never followed — a worktree's node_modules is one
    if (e.name.startsWith('.venv')) continue;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      walk(root, abs, out);
    } else if (e.isFile()) {
      out.push(toRel(root, abs));
    }
  }
}

/** Every file under `root`, repo-relative and forward-slashed, sorted. */
export function collectAll(root) {
  const out = [];
  walk(root, root, out);
  return out.sort();
}

/** The prose half scans over these. */
export function markdownFiles(root) {
  return collectAll(root).filter((rel) => rel.toLowerCase().endsWith('.md'));
}

/** `lib/probes.js` scans over these. */
export function pythonFiles(root) {
  return collectAll(root).filter((rel) => rel.toLowerCase().endsWith('.py'));
}

/** `TAG123.45`-shaped — an audit's own section id (`S5.1`, `B10`, `G0`), never a filename. */
const SECTION_RE = /^[A-Za-z]{1,4}\d+(?:\.\d+)*$/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What `raw` names, and the strings that would name it back in someone else's prose or
 * code.
 *
 *  - `section`  a bare id like `S5.1` — matched as a whole word (`\bS5\.1\b`), so a URL
 *    slug or a longer identifier that merely contains the digits is not a false claim.
 *  - `path`     a `/`-bearing argument — matched as the exact path, its bare basename,
 *    and (when it has an extension) its stem, because prose rarely spells the full
 *    relative path back out.
 *  - `basename` anything else — matched as itself and its stem, so a mention of
 *    `LORE_PROPOSAL_electric_universe.md` still catches `LORE_PROPOSAL_electric_universe`
 *    used bare.
 */
export function classifyTarget(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (SECTION_RE.test(s)) return { kind: 'section', id: s, basename: null, needles: [s] };
  const stemOf = (base) => (base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base);
  if (s.includes('/')) {
    const base = path.basename(s);
    return { kind: 'path', path: s, basename: base, needles: [...new Set([s, base, stemOf(base)])] };
  }
  return { kind: 'basename', path: null, basename: s, needles: [...new Set([s, stemOf(s)])] };
}

/**
 * The sentence inside `line` that contains character offset `matchIndex` — split on
 * `.`/`!`/`?` followed by whitespace or end-of-line, punctuation kept with the sentence
 * it ends. Falls back to the whole trimmed line for a heading, list item or table row
 * with no sentence punctuation at all, which is most of what a CHANGE_LOG entry is.
 */
export function sentenceAround(line, matchIndex) {
  const bounds = [];
  const re = /[.!?](?=\s|$)/g;
  let start = 0;
  let m;
  while ((m = re.exec(line))) {
    bounds.push([start, m.index + 1]);
    start = m.index + 1;
  }
  bounds.push([start, line.length]);
  for (const [a, b] of bounds) {
    if (matchIndex >= a && matchIndex < b) return line.slice(a, b).trim();
  }
  return line.trim();
}

/**
 * One row per line where a markdown file names `target` — `path:line`, plus the
 * sentence that names it. A line matching more than one needle (the path and its own
 * basename both appearing, say) contributes one row, not two — `break` below.
 */
export function claimsInProse(root, files, target) {
  const out = [];
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue; // gone between the walk and the read
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const needle of target.needles) {
        const idx =
          target.kind === 'section'
            ? (() => {
                const wm = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(needle)}(?![A-Za-z0-9_])`).exec(line);
                return wm ? wm.index : -1;
              })()
            : line.indexOf(needle);
        if (idx === -1) continue;
        out.push({ file: rel, line: i + 1, needle, sentence: sentenceAround(line, idx) });
        break;
      }
    }
  }
  return out;
}
