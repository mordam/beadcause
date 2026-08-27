/**
 * Which `bin/b7e-*` command answers a question — `bin/b7e-which` is the argv shell; this
 * is the reading, the parsing and the ranking.
 *
 * bc-dgx7.65, filed by the session audit against five sessions (bc-9ntye.6, bc-19vt.1,
 * bc-dgx7.52, bc-dgx7.53, bc-9ntye.3) that each needed one of the thirty-odd `b7e-*`
 * commands and went looking for it a different way — `ls bin/ | grep -i ...`, a memory
 * lookup, opening files cold — and three came away with a name and no idea what it did.
 * Every command already answers this for itself: its own docblock opens with the
 * question it exists to answer and — since bc-wbrhi — declares in the same docblock
 * whether `dispatch` may call it (`@grant read`, `write` or `excluded`), and `README.md`
 * has a `### ` section naming it. What used to be three registries is now two places,
 * one of which is the file itself, and nothing before this read any of them.
 *
 * **Candidates are read off `bin/` itself**, the same union `bin/b7e-enroll`'s own
 * `candidateNames` already uses (package.json's `bin` map, plus any stray `b7e-*` file
 * under `bin/` that map does not point to yet) — so a command that lands in a branch and
 * has not been registered anywhere else yet still shows up here, which is the whole
 * point: the index needs no edit of its own when a new command ships.
 *
 * **The question is the docblock's opening paragraph**, not just its first physical
 * line — most of the family wraps its intro across two source lines
 * (```` `b7e-gates` — which gate runners are on this Mac, whose worktree each one is, and
 * ending only mine.```` is two lines in the file) and stopping at the first physical
 * newline would hand back half a sentence. The paragraph ends at the first blank comment
 * line, or at the first line that is itself a usage example (trimmed text starting with
 * the bare command name) for a docblock with no blank line between its intro and its
 * usage block. A backtick-quoted `` `name` — `` prefix, where a docblock opens with one,
 * is stripped; roughly a fifth of the family (`b7e-def`, `b7e-apply`, `b7e-brief`, ...)
 * does not open that way at all, and its question is just the paragraph as written.
 *
 * **A docblock with nothing readable before its first blank line or usage example is
 * `malformed: true`, `question: null`** — excluded from ranked search results (nothing to
 * score it against) but still listed in the bare, unranked index, because "missing a
 * question" is itself something worth being able to see rather than something this
 * silently hides a command behind.
 *
 * **Ranking is plain word-overlap**, deliberately not fuzzy or stemmed: a query is
 * lowercased, split on non-word characters and stripped of a short stopword list, and
 * each surviving token is looked for as a whole word — in the command's own name (split
 * on `-`), then its question, then its usage lines, then the rest of its docblock, each
 * tier scored higher than the next and only the best tier per token counted. Exact
 * matching is what keeps a plural or a different inflection from scoring — `b7e-gates`'s
 * "gate runners" does not answer a query for "the whole suite" just because "runners"
 * contains "run" as a substring.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze, readReadme } from './readme.js';
// The one reader of a `@grant` line, shared rather than re-spelled — this runs against
// `--dir <root>`, another tree entirely, so it takes the text and not the module's own
// scan of this checkout. bc-wbrhi.
import { declarationsIn } from './tooldecl.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Used only when `cwd` is not inside any git worktree at all — this file's own checkout. */
const FALLBACK_ROOT = path.join(HERE, '..');

/**
 * The root to read `bin/` from: the CALLING session's own worktree, not this file's.
 * Same reasoning and the same `git rev-parse --show-toplevel` shellout as
 * `bin/b7e-enroll`'s `repoRoot` — per memory note only-an-extensionless-bin-resolves-on-
 * path, the `bin/b7e-which` that actually runs for any invocation is always the MAIN
 * CHECKOUT's copy, so a `HERE`-based root would answer for the main checkout regardless
 * of which worktree the caller is really sitting in — backwards for a tool whose whole
 * point is that a command added in an uncommitted branch already appears in the index.
 */
export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return FALLBACK_ROOT;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ===================================================================== *
 * candidate names — the same union bin/b7e-enroll's candidateNames uses
 * ===================================================================== */

export function candidateNames(root, pkg) {
  const fromPkg = Object.keys(pkg.bin || {}).filter((n) => n.startsWith('b7e-'));
  const binDir = path.join(root, 'bin');
  const files = fs.readdirSync(binDir).filter((f) => fs.statSync(path.join(binDir, f)).isFile());
  const registeredTargets = new Set(Object.values(pkg.bin || {}).map((v) => path.basename(v)));
  const strays = files
    .filter((f) => f.startsWith('b7e-') && !registeredTargets.has(f))
    .map((f) => (f.endsWith('.js') ? f.slice(0, -3) : f));
  return [...new Set([...fromPkg, ...strays])].sort();
}

/** Where a candidate's own source lives — package.json's bin map when it has an entry
 * (honouring a `.js`-suffixed target like `bin/b7e-owes.js`), else the bare `bin/<name>`
 * a not-yet-registered stray would be. */
export function fileFor(root, name, pkg) {
  const rel = (pkg.bin && pkg.bin[name]) || path.join('bin', name);
  return path.join(root, rel);
}

/* ===================================================================== *
 * docblock parsing
 * ===================================================================== */

/**
 * The top `/** ... *\/` docblock of `src`, split into: `question` (the opening
 * paragraph, backtick-name prefix stripped, or `null` if there is none to read),
 * `usage` (every line whose trimmed text starts with the bare command name, verbatim),
 * and `raw` (the whole docblock body, for the lowest-tier ranking search).
 */
export function parseDocblock(src, name) {
  const m = /\/\*\*([\s\S]*?)\*\//.exec(src || '');
  if (!m) return { question: null, usage: [], raw: '' };
  const rawLines = m[1].split('\n').map((l) => l.replace(/^[ \t]*\*[ \t]?/, ''));
  const nameRe = new RegExp(`^${escapeRe(name)}(\\s|$)`);
  const prefixRe = new RegExp('^`' + escapeRe(name) + '`\\s*[—-]\\s*');

  const usage = [];
  for (const l of rawLines) {
    const t = l.trim();
    if (t && nameRe.test(t)) usage.push(t);
  }

  const paraLines = [];
  let started = false;
  for (const l of rawLines) {
    const t = l.trim();
    if (!t) {
      if (started) break; // blank line ends the opening paragraph
      continue; // a leading blank line, right after `/**` — not the end, just not started yet
    }
    if (nameRe.test(t)) break; // a usage example, with no blank line ahead of it
    started = true;
    paraLines.push(t);
  }
  let question;
  if (paraLines.length) {
    question = paraLines.join(' ').replace(prefixRe, '').trim();
  } else {
    // A docblock that opens straight into a usage example with no prose ahead of it —
    // none of the family does this today, but fall back to whatever the first non-blank
    // line is rather than reporting nothing.
    const first = rawLines.map((l) => l.trim()).find(Boolean);
    question = first ? first.replace(prefixRe, '').trim() : null;
  }

  return { question: question || null, usage, raw: m[1] };
}

/* ===================================================================== *
 * whether it is on the agent allowlist
 * ===================================================================== */

/**
 * `{ granted: true }` when the tool declares itself on `DEFAULT_TOOL_LIST`;
 * `{ granted: false, decided: true }` when it declares itself deliberately off it; and
 * `{ granted: false, decided: false }` when dispatch's reach into it has never been
 * decided at all.
 *
 * **Read from the tool's own `@grant` line since bc-wbrhi**, where it used to be read
 * out of `lib/toolbelt.js`'s source text — `Bash(<name>:*)` appearing in the array meant
 * granted, and the bare name appearing anywhere in its comments meant decided. That
 * second reading is why this could be wrong in the one direction that matters: a tool
 * mentioned in passing inside somebody else's paragraph read as *decided about*, which is
 * a decision nobody made. A declaration cannot be made by accident.
 */
export function allowlistStatus(name, src) {
  const [kind] = declarationsIn(src || '');
  if (kind === 'read' || kind === 'write') return { granted: true, decided: true };
  if (kind === 'excluded') return { granted: false, decided: true };
  return { granted: false, decided: false };
}

/* ===================================================================== *
 * its README anchor
 * ===================================================================== */

/** The first `### ` heading whose title backtick-quotes `name`, or `null` — the same
 * shape bin/b7e-enroll's readmeProblem matches, here returning the heading rather than
 * just a pass/fail, via lib/readme.js's own analyze() so the slug can never drift from
 * what test/anchors.mjs already validates. */
export function readmeAnchorFor(name, readmeAnalysis) {
  const re = new RegExp('`' + escapeRe(name) + '`');
  const h = readmeAnalysis.headings.find((h) => re.test(h.title));
  return h ? { title: h.title, slug: h.slug, line: h.line } : null;
}

/* ===================================================================== *
 * building the whole index
 * ===================================================================== */

export function loadContext(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const readmeAnalysis = analyze(readReadme(root));
  // No `toolbeltSrc` since bc-wbrhi: the allowlist answer is in each tool's own file now,
  // and `entryFor` has already read that to parse the docblock.
  return { root, pkg, readmeAnalysis };
}

export function entryFor(root, name, ctx) {
  const { pkg, readmeAnalysis } = ctx;
  const file = fileFor(root, name, pkg);
  let src = '';
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    // Missing entirely — a package.json entry with nothing on disk, e.g. bc-dgx7.65's
    // own reason bin/b7e-enroll exists. Reported below as malformed rather than thrown.
  }
  const { question, usage, raw } = parseDocblock(src, name);
  return {
    name,
    file: path.relative(root, file),
    question,
    usage,
    raw,
    malformed: !question,
    allowlist: allowlistStatus(name, src),
    readme: readmeAnchorFor(name, readmeAnalysis),
  };
}

/** Every real b7e-* command in `root`, name-sorted — the bare, unranked index. */
export function fullIndex(root) {
  const ctx = loadContext(root);
  return candidateNames(root, ctx.pkg).map((name) => entryFor(root, name, ctx));
}

/* ===================================================================== *
 * ranking a query against the index
 * ===================================================================== */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'this', 'that', 'these', 'those', 'are', 'of', 'to', 'in', 'on',
  'for', 'and', 'or', 'with', 'at', 'by', 'it', 'its', 'be', 'do', 'does', 'did', 'was',
  'were', 'will', 'would', 'should', 'could', 'can', 'i', 'you', 'your', 'my', 'me', 'we',
  'us', 'as', 'if', 'so', 'than', 'then', 'there', 'here', 'from', 'into', 'about', 'am',
  'been', 'being', 'not', 'no', 'yes',
]);

function words(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

/** Every content word in `query`, lowercased and stopword-filtered — what a match is
 * scored against. */
export function queryTokens(query) {
  return words(query).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** How well one index entry answers `qTokens` — the highest tier each token is found
 * in (name > question > usage > the rest of the docblock), summed. 0 when nothing
 * matches at all, which is what search() below filters out. */
export function scoreEntry(entry, qTokens) {
  if (!qTokens.length) return 0;
  const nameWords = new Set(entry.name.split('-'));
  const questionWords = new Set(words(entry.question));
  const usageWords = new Set(words(entry.usage.join(' ')));
  const bodyWords = new Set(words(entry.raw));
  let score = 0;
  for (const t of qTokens) {
    if (nameWords.has(t)) score += 5;
    else if (questionWords.has(t)) score += 3;
    else if (usageWords.has(t)) score += 2;
    else if (bodyWords.has(t)) score += 1;
  }
  return score;
}

/** `entries` (from fullIndex) ranked against `query`, highest score first, ties broken
 * by name — entries that scored 0 (nothing matched at all) are dropped. An empty array
 * is an ordinary answer, not a failure: see bin/b7e-which's own exit codes. */
export function search(entries, query) {
  const qTokens = queryTokens(query);
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, qTokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .map((r) => ({ ...r.entry, score: r.score }));
}
