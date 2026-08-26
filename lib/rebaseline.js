/**
 * A gate's own "expected X — got Y" turned into the edit, everywhere X is written —
 * `bin/b7e-rebaseline` is the argv shell; this is the parsing, the locating and the
 * rewriting.
 *
 * bc-dgx7.76, filed by the session audit (`lib/sessionaudit.js`) against five sessions
 * (`dv-gr6.41`, `dv-gr6.43`, `dv-b5d.4.3`, `dv-3rn.1`, `dv-b5d.14`) that each changed a
 * file a gate script measures, watched the gate go red with an exact expected-vs-measured
 * pair, and then hand-propagated the new number into every place the old one was
 * written. No two did it the same way — a `scratchpad/rebaseline.py`, a second one, a
 * placeholder trick (write `0`, re-run the gate, `sed -i ''` the measured value back in),
 * two `Edit` calls plus three more into a doc, a hand reimplementation of the check's own
 * `check_unreferenced` copied out of the script's source — and none of them got it in one
 * pass. `dv-gr6.43` then had to do the whole thing a second time, because the merge it did
 * next conflicted in exactly the two files `dv-gr6.41` had re-baselined concurrently.
 *
 * Four `beadcause-memory` notes already warn about this tax (`check-saga-audit-rebaseline`
 * — "FOUR script edits plus a doc edit — miss one and the gate stays red or, worse, goes
 * green"), and every one of them is a warning to a human. None of them does the
 * arithmetic. This does.
 *
 * ## It is the other half of `b7e-count`, not a second copy of it
 *
 * `b7e-count` (bc-dgx7.59) answers "where is this literal written, and how many times".
 * This answers "what is that number *now*, read off the gate's own measurement, and which
 * of those sites belong to that assertion" — which is the half every one of the five
 * sessions above had to do by hand *after* finding the sites.
 *
 * ## Running the gate is `lib/checks.js`, deliberately
 *
 * Discovery and running are `manifestFor`/`discoverChecks`/`runChecks` from
 * `lib/checks.js` (bc-dgx7.57), unchanged and un-widened. A repo no manifest recognises
 * is refused here exactly as `b7e-checks` refuses it — teaching *this* file a second,
 * private way to find a repo's gate scripts is how the two answers start disagreeing, and
 * a new repo shape belongs in that file's `MANIFESTS` where both commands see it.
 *
 * ## Why a site needs an anchor before it may be rewritten
 *
 * The dangerous version of this command is the one that rewrites every `12` in the tree
 * because a check measured 12. So a site is only *in the plan* when its own context — its
 * line, the few lines above it, the nearest heading above it, the nearest constant
 * assignment above it — names the check: its bracketed id (`[S5.2]`), or a distinctive
 * word from its label plus, when the label carries a qualifier number ("Ch 4"), that
 * number too. Everything else carrying the old literal is still *reported*, under "not
 * rewritten", because "here are five more places that number is written and I did not
 * touch them" is exactly what `dv-b5d.4.3` needed and did not have. A site two different
 * stale checks both claim is ambiguous and is never rewritten by either.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * A number as a gate prints one: optionally signed, optionally comma-grouped. The
 * `(?:,\d{3})*` is exact rather than a loose `[\d,]*` for one reason that bit
 * immediately — a dict literal ends its entries with a comma (`4: 4090,`), and a
 * comma-anything rule reads that trailing comma as the start of a group and then refuses
 * the whole token for being malformed. A comma only joins a number when three digits
 * follow it.
 */
const NUM = String.raw`[+-]?\d+(?:,\d{3})*`;

/**
 * The expected/measured pair, in the spellings the five sessions actually hit, tried in
 * order. The `[^0-9\n]{0,40}?` between the two numbers is load-bearing: it stops the
 * "got" half being matched across some *third* number further down the line, which is
 * how a lazy `.*?` turns "expected 4090 -- got 4536 (was 4001)" into the wrong pair.
 */
export const PAIR_PATTERNS = [
  new RegExp(String.raw`\bexpected\b\s*[:=]?\s*(${NUM})[^0-9\n]{0,40}?\bgot\b\s*[:=]?\s*(${NUM})`, 'i'),
  new RegExp(String.raw`==\s*(${NUM})[^0-9\n]{0,40}?\bgot\b\s*[:=]?\s*(${NUM})`, 'i'),
  new RegExp(String.raw`\b(?:want|wanted|should be)\b\s*[:=]?\s*(${NUM})[^0-9\n]{0,40}?\bgot\b\s*[:=]?\s*(${NUM})`, 'i'),
];

/** A line a gate means as a failure. */
const FAIL_LINE = /(^|\s)(FAIL(?:ED|URE)?|ERROR|✗|✘|❌)\b|^\s*(✗|✘|❌)/;

/**
 * A line in the *tree* that is a gate's own report line rather than a baseline — the
 * `print("FAIL [S8.1] widget count == 4090 -- got 4536")` inside the script that emitted
 * the failure in the first place. It carries both numbers and is anchored by its own check
 * id, so nothing else here would hold it back, and rewriting it edits the message rather
 * than the constant: the gate stays exactly as red and now lies about what it wanted.
 * Found by this command's own suite, on a fixture whose check printed literals.
 */
export function isReportLine(line) {
  // Deliberately laxer than FAIL_LINE, which anchors the marker to a word boundary a
  // *printed* line has: in source the marker is inside a string literal
  // (`print("FAIL [S8.1] …")`), so the character before it is a quote, and FAIL_LINE says
  // no. Carrying both a failure word and a whole expected/got pair on one line is enough.
  if (!/FAIL(?:ED|URE)?|ERROR|✗|✘|❌/.test(line)) return false;
  return PAIR_PATTERNS.some((re) => re.test(line));
}

/** "2 checks failed", "3 of 9 FAILED" — a tally, not a finding. Never out of scope. */
const TALLY_LINE = /^[^A-Za-z]*\d+\s+(?:of\s+\d+\s+)?(?:checks?|tests?|assertions?|gates?)?\s*(?:failed|FAIL|failures?)\b/i;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'but', 'not', 'with', 'from', 'that', 'this', 'than', 'has', 'have',
  'was', 'were', 'are', 'its', 'all', 'any', 'out', 'per', 'via', 'see', 'must', 'should',
  'expected', 'got', 'fail', 'failed', 'failure', 'error', 'check', 'checks', 'want', 'wanted',
]);

/** Never walked, whatever the tree holds — the same two `lib/count.js` always excludes. */
const ALWAYS_SKIPPED = ['.git/', '.claude/worktrees/', 'node_modules/'];

/** Bigger than any file a gate constant is written in; a match past this is not worth the read. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** `+2,499` → `2499`. `null` when it is not a number after all. */
export function numeric(text) {
  const n = Number(String(text).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * `newValue`, written the way `oldText` was written — comma grouping and an explicit
 * leading `+` both preserved. A doc table saying `4,090` gets `4,536`, not `4536`; a
 * delta written `+2499` stays signed. Getting this wrong is not cosmetic: a gate that
 * parses its own doc back (deluvia's does) reads a regrouped number as a different one.
 */
export function formatLike(oldText, newValue) {
  const grouped = oldText.includes(',');
  const plussed = oldText.startsWith('+');
  const n = Number(newValue);
  const negative = n < 0;
  let digits = String(Math.abs(n));
  if (grouped) digits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (negative) return `-${digits}`;
  return plussed ? `+${digits}` : digits;
}

/**
 * Every number token on `line`, with the exact text and its offset — boundary-checked so
 * `4090` is never found inside `4,090`, `S3.1`, `v1.4090` or `40901`.
 */
export function numberTokens(line) {
  const out = [];
  const re = new RegExp(NUM, 'g');
  let m;
  while ((m = re.exec(line)) !== null) {
    const text = m[0];
    const start = m.index;
    const end = start + text.length;
    const prev = start > 0 ? line[start - 1] : '';
    const prevPrev = start > 1 ? line[start - 2] : '';
    const next = line[end] ?? '';
    const nextNext = line[end + 1] ?? '';
    if (/[0-9A-Za-z_]/.test(prev)) continue;
    if (prev === '.' && /\d/.test(prevPrev)) continue;
    // `1,234` is one token, never `1` and a stray `234` — a bare three-digit run right
    // after a digit and a comma is a group this scan already consumed as part of
    // something else.
    if (prev === ',' && /\d/.test(prevPrev) && /^\d{3}$/.test(text)) continue;
    if (/[0-9A-Za-z_]/.test(next)) continue;
    if (next === '.' && /\d/.test(nextNext)) continue;
    const value = numeric(text);
    if (value === null) continue;
    out.push({ text, value, index: start });
  }
  return out;
}

/* ------------------------------------------------------------------------- parsing */

/**
 * One check's output, split into the pairs this command can act on and the failure lines
 * it cannot. A pair whose two halves are equal is dropped — a gate that prints
 * "expected 12 -- got 12" on a line it also called a failure is failing about something
 * else, and re-baselining 12 to 12 would be a no-op edit dressed up as a fix.
 */
export function parseFailures(out, { check = null } = {}) {
  const pairs = [];
  const unparsed = [];
  for (const raw of String(out || '').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    if (!line.trim()) continue;
    if (!FAIL_LINE.test(line)) continue;
    if (TALLY_LINE.test(line)) continue;
    let matched = null;
    for (const re of PAIR_PATTERNS) {
      const m = line.match(re);
      if (m) {
        matched = m;
        break;
      }
    }
    if (!matched) {
      unparsed.push({ check, line: line.trim() });
      continue;
    }
    const expected = matched[1];
    const measured = matched[2];
    const expectedValue = numeric(expected);
    const measuredValue = numeric(measured);
    if (expectedValue === null || measuredValue === null) {
      unparsed.push({ check, line: line.trim() });
      continue;
    }
    if (expectedValue === measuredValue) continue;
    pairs.push({
      check,
      checkId: checkIdOf(line),
      label: labelOf(line, matched),
      expected,
      measured,
      expectedValue,
      measuredValue,
      line: line.trim(),
    });
  }
  return { pairs, unparsed };
}

/** The bracketed section id a gate stamps its findings with — `[S3.1]`, `[S5.2]`. */
function checkIdOf(line) {
  const m = line.match(/\[([^\]\s]{1,24})\]/);
  return m ? m[1] : null;
}

/** What the failure is *about*: the line, minus its FAIL marker, its `[id]` and the pair. */
function labelOf(line, matched) {
  let label = line.slice(0, matched.index);
  label = label.replace(/^\s*(FAIL(?:ED|URE)?|ERROR|✗|✘|❌)\b[:\-—\s]*/i, '');
  label = label.replace(/\[[^\]\s]{1,24}\]/, ' ');
  label = label.replace(/[=\-—:]+\s*$/, '');
  return label.replace(/\s+/g, ' ').trim();
}

/** Every stale pair across a `runChecks` result set, failing checks only, deduped. */
export function collectFailures(results) {
  const pairs = [];
  const unparsed = [];
  const seen = new Set();
  for (const r of results) {
    if (r.ok) continue;
    const parsed = parseFailures(r.out, { check: r.name });
    for (const p of parsed.pairs) {
      const key = `${p.check}::${p.checkId}::${p.label}::${p.expected}::${p.measured}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(p);
    }
    unparsed.push(...parsed.unparsed);
  }
  return { pairs, unparsed };
}

/* ------------------------------------------------------------------------ anchoring */

const words = (s) =>
  String(s)
    .toLowerCase()
    // `4,090` counts as one token, not `4` and `090` — otherwise a chapter-4 qualifier
    // matches any row whose *number* happens to start with a 4.
    .replace(/(?<=\d),(?=\d)/g, '')
    .match(/[a-z0-9]+/g) || [];

/**
 * What a site's context must name before this command will rewrite it: the check's
 * bracketed id, the distinctive words of its label, and any qualifier number the label
 * carries ("Ch **4** prose words"). A pair with none of the three anchors nothing — by
 * design, and reported as such rather than guessed at.
 */
export function anchorsFor(pair) {
  const labelWords = words(pair.label);
  const wordAnchors = [...new Set(labelWords.filter((w) => /[a-z]/.test(w) && w.length >= 3 && !STOPWORDS.has(w)))];
  const qualifiers = [...new Set(labelWords.filter((w) => /^\d+$/.test(w)))].filter(
    (q) => numeric(q) !== pair.expectedValue && numeric(q) !== pair.measuredValue
  );
  return { checkId: pair.checkId ? pair.checkId.toLowerCase() : null, words: wordAnchors, qualifiers };
}

const HEADING = /^\s{0,3}#{1,6}\s/;
const CONST_ASSIGN = /^\s*(?:export\s+|const\s+|let\s+|var\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*[:=]/;

/**
 * The text a site is judged by: its own line, the lines just above it (six for a table
 * row, whose header is what actually names the columns), the nearest heading above it,
 * and the nearest constant assignment above it — a dict entry `4: 4090` says nothing on
 * its own, and `PROSE_WORDS = {` two lines up says everything.
 */
export function contextFor(lines, i) {
  const line = lines[i];
  const before = /^\s*\|/.test(line) ? 6 : 2;
  const parts = lines.slice(Math.max(0, i - before), i + 1);
  for (let j = i - 1; j >= 0 && j >= i - 300; j -= 1) {
    if (HEADING.test(lines[j])) {
      parts.push(lines[j]);
      break;
    }
  }
  for (let j = i - 1; j >= 0 && j >= i - 80; j -= 1) {
    if (CONST_ASSIGN.test(lines[j])) {
      parts.push(lines[j]);
      break;
    }
  }
  return parts.join('\n');
}

/** Whether `context` names the check `anchors` came from, and by which anchor. */
export function anchored(anchors, context) {
  const contextToks = words(context);
  const toks = new Set(contextToks);
  if (anchors.checkId) {
    // A `[S3.1]` id is two tokens once split (`s3`, `1`), so match the id's own token run
    // in sequence rather than as a single word.
    const idToks = words(anchors.checkId);
    if (idToks.length && containsRun(contextToks, idToks)) return { ok: true, by: anchors.checkId };
  }
  const hitWords = anchors.words.filter((w) => toks.has(w));
  if (!hitWords.length) return { ok: false, by: null };
  if (anchors.qualifiers.length && !anchors.qualifiers.some((q) => toks.has(q))) {
    return { ok: false, by: null };
  }
  return { ok: true, by: hitWords.join('+') };
}

function containsRun(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let all = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/* --------------------------------------------------------------------------- files */

/**
 * The files to search: what git tracks in `dir` when it is a checkout (so an ignored
 * build directory, and a stale sibling worktree under `.claude/worktrees/`, are never
 * walked into — the exact inflation `lib/count.js`'s docblock records), else a plain
 * recursive walk for a tree that is not a repo at all.
 */
export function listTreeFiles(dir) {
  let files;
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    files = out.split('\0').filter(Boolean);
  } catch {
    files = walk(dir, '');
  }
  return files.filter((f) => !ALWAYS_SKIPPED.some((p) => f === p.slice(0, -1) || f.startsWith(p)));
}

function walk(root, rel) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      out.push(...walk(root, child));
    } else if (e.isFile()) {
      out.push(child);
    }
  }
  return out;
}

/** Text, or `null` for a file that is too big, unreadable, or binary. */
export function readTextFile(full) {
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
  if (text.includes('\0')) return null;
  return text;
}

const DOCLIKE = /\.(md|markdown|mdx|rst|txt|adoc|org)$/i;
const SELFTESTY = /(^|\/)(tests?|fixtures?|selftests?|__tests__)\//i;
const SELFTEST_NAME = /(^|[._-])(test|tests|spec|selftest|fixture|fixtures)([._-]|$)/i;

/**
 * Which of the bead's three buckets a site falls in — "the script", "the doc it mirrors"
 * and "a selftest fixture" — plus `elsewhere` for a site that is none of the three, which
 * is reported under its own heading rather than quietly filed as a doc.
 */
export function bucketFor(file, scriptPaths) {
  if (scriptPaths.has(file)) return 'script';
  if (SELFTESTY.test(file) || SELFTEST_NAME.test(path.basename(file))) return 'selftest';
  if (DOCLIKE.test(file)) return 'doc';
  return 'elsewhere';
}

/* ---------------------------------------------------------------------- the plan */

/**
 * Every site in `dir` carrying any stale pair's old literal, anchored, bucketed, and
 * marked ambiguous where two stale pairs with *different* new values both claim it.
 *
 * One pass over the tree for all the pairs at once, not one pass per pair: a repo with
 * nine stale assertions is still one read of each file.
 */
export function findSites(dir, pairs, { scriptPaths = new Set(), files = null } = {}) {
  const anchorsByPair = pairs.map((p) => anchorsFor(p));
  const wanted = new Map();
  pairs.forEach((p, idx) => {
    if (!wanted.has(p.expectedValue)) wanted.set(p.expectedValue, []);
    wanted.get(p.expectedValue).push(idx);
  });

  const sites = pairs.map(() => []);
  for (const file of files || listTreeFiles(dir)) {
    const text = readTextFile(path.join(dir, file));
    if (text === null) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/\d/.test(line)) continue;
      let tokens = null;
      let context = null;
      for (const [value, idxs] of wanted) {
        for (const idx of idxs) {
          if (tokens === null) tokens = numberTokens(line);
          const hits = tokens.filter((t) => t.value === value);
          if (!hits.length) continue;
          if (context === null) context = contextFor(lines, i);
          const report = isReportLine(line);
          const hit = report ? { ok: false, by: null } : anchored(anchorsByPair[idx], context);
          for (const t of hits) {
            sites[idx].push({
              file,
              line: i + 1,
              col: t.index,
              oldText: t.text,
              newText: formatLike(t.text, pairs[idx].measuredValue),
              bucket: bucketFor(file, scriptPaths),
              associated: hit.ok,
              anchor: hit.by,
              ambiguous: false,
              reportLine: report,
              raw: line,
              text: line.trim(),
            });
          }
        }
      }
    }
  }

  // A site two stale pairs both claim, disagreeing about what it should become, is
  // nobody's to rewrite — `dv-gr6.43` hit exactly this shape when two chapters' counts
  // were re-baselined concurrently and the doc held both.
  const claimed = new Map();
  sites.forEach((list, idx) => {
    for (const s of list) {
      if (!s.associated) continue;
      const key = `${s.file}::${s.line}::${s.col}`;
      if (!claimed.has(key)) claimed.set(key, []);
      claimed.get(key).push({ idx, s });
    }
  });
  for (const claims of claimed.values()) {
    if (claims.length < 2) continue;
    const distinct = new Set(claims.map((c) => c.s.newText));
    if (distinct.size === 1) {
      // Same answer from both — keep one, drop the duplicate edit.
      claims.slice(1).forEach((c) => {
        c.s.duplicate = true;
      });
      continue;
    }
    claims.forEach((c) => {
      c.s.ambiguous = true;
    });
  }

  return sites;
}

/**
 * The definition site: where the constant this assertion reads actually lives. Preferred
 * in the gate script itself and on a line that assigns something (`PROSE_WORDS = {`,
 * `4: 4090,`), because that is the one a human would have gone looking for first —
 * falling back to the first anchored site anywhere rather than claiming there is none.
 */
export function definitionSite(sites) {
  const anchored_ = sites.filter((s) => s.associated && !s.ambiguous);
  const inScript = anchored_.filter((s) => s.bucket === 'script');
  const assigning = inScript.find((s) => /[:=]/.test(String(s.raw ?? s.text).slice(0, Math.max(0, s.col))) || CONST_ASSIGN.test(s.text));
  return assigning || inScript[0] || anchored_[0] || null;
}

/**
 * The whole answer for one tree: every stale assertion, where its number is written, what
 * `--write` would change, and every failure that is not an expected/got pair at all.
 */
export function buildPlan(dir, results, { only = [], scriptPaths = new Set(), files = null } = {}) {
  const { pairs, unparsed } = collectFailures(results);
  const selected = only.length
    ? pairs.filter((p) => only.some((o) => matchesOnly(p, o)))
    : pairs;
  const siteLists = selected.length ? findSites(dir, selected, { scriptPaths, files }) : [];

  const checks = selected.map((p, idx) => {
    const sites = siteLists[idx] || [];
    return {
      ...p,
      anchors: anchorsFor(p),
      definition: definitionSite(sites),
      sites,
      edits: sites.filter((s) => s.associated && !s.ambiguous && !s.duplicate && s.oldText !== s.newText),
    };
  });

  const edits = checks.flatMap((c) => c.edits);
  const filesTouched = [...new Set(edits.map((e) => e.file))].sort();
  return {
    dir,
    checks,
    outOfScope: unparsed,
    skipped: pairs.length - selected.length,
    edits,
    filesTouched,
  };
}

function matchesOnly(pair, only) {
  const needle = String(only).toLowerCase();
  if (pair.checkId && pair.checkId.toLowerCase() === needle) return true;
  return pair.label.toLowerCase().includes(needle);
}

/**
 * Apply a plan's edits, bottom-up within each file so an earlier edit can never move a
 * later one's offset. Refuses the whole file — never half of it — if what is on disk no
 * longer reads the way the plan says, which is the one way a plan built minutes ago can
 * be wrong.
 */
export function applyPlan(plan) {
  const byFile = new Map();
  for (const e of plan.edits) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  const changed = [];
  const refused = [];
  let applied = 0;
  for (const [file, edits] of [...byFile.entries()].sort()) {
    const full = path.join(plan.dir, file);
    const text = readTextFile(full);
    if (text === null) {
      refused.push({ file, why: 'unreadable now' });
      continue;
    }
    const lines = text.split('\n');
    const ordered = [...edits].sort((a, b) => b.line - a.line || b.col - a.col);
    let stale = null;
    for (const e of ordered) {
      const line = lines[e.line - 1];
      if (line === undefined || line.slice(e.col, e.col + e.oldText.length) !== e.oldText) {
        stale = e;
        break;
      }
    }
    if (stale) {
      refused.push({ file, why: `${file}:${stale.line} no longer reads "${stale.oldText}" — re-run the plan` });
      continue;
    }
    for (const e of ordered) {
      const line = lines[e.line - 1];
      lines[e.line - 1] = line.slice(0, e.col) + e.newText + line.slice(e.col + e.oldText.length);
      applied += 1;
    }
    fs.writeFileSync(full, lines.join('\n'));
    changed.push(file);
  }
  return { changed, refused, applied };
}

/** The gate scripts a manifest found, as tree-relative paths — what "the script" means. */
export function scriptPathsOf(checks) {
  const out = new Set();
  for (const c of checks) {
    const first = (c.argv || []).find((a) => typeof a === 'string' && /\.(py|sh|js|mjs|rb|pl)$/.test(a));
    if (first) out.add(first.replace(/^\.\//, ''));
    const named = String(c.name || '').replace(/\s*\(.*\)\s*$/, '');
    if (/\.(py|sh|js|mjs|rb|pl)$/.test(named)) out.add(named);
  }
  return out;
}
