/**
 * The static half of the browser checks — what can be known about them without Chrome.
 *
 * `scripts/*-check.mjs` is the only cover this repo has for layout, taps and anything
 * that happens on a phone, and none of it is in `npm test`: that suite is pure Node on
 * purpose, and these want a Chrome, ten seconds each and a machine with a screen's worth
 * of memory. `scripts/checks.mjs` runs them for real. This file is what runs in `npm
 * test` instead, and it exists because of how these checks actually rot.
 *
 * They do not rot by failing. They rot by pressing something that is no longer there.
 * Working bc-xqnj, the inbox's `[data-space]` chips were removed; `shade-check.mjs`
 * (since deleted with the feature it covered, in bc-ka5y.1) pressed those chips to
 * narrow the filter, so it broke outright, and `npm test` stayed
 * green for as long as nobody thought to run it by hand. The gap between "a selector left
 * public/" and "somebody noticed" is unbounded, and it is the whole of the problem —
 * a check that has silently not passed for a month is worse than no check, because the
 * next person to run it reads its failures as their own change breaking something.
 *
 * So: read every static selector each check presses, and assert every class, id and
 * data-attribute in it still appears somewhere in `public/`. That is a text search and
 * not a browser, which is exactly why it can live in `npm test` — it costs milliseconds
 * and it catches the one failure mode nobody was going to catch by remembering.
 *
 * ## What it deliberately cannot see
 *
 * A token that is *present* proves nothing about whether the check still passes: the
 * element may have moved, changed meaning, or stopped being reachable from the page the
 * check opens. Only `npm run checks` knows that. This is the smoke alarm, not the
 * inspection — it is tuned to have no false alarms, so that a finding is always real.
 *
 * Two things follow from that tuning, and both are choices:
 *
 * - **Interpolated selectors are skipped.** `` `[data-key="${key}"]` `` has no static
 *   text to search for, so it is not audited. `data-key` itself is picked up from the
 *   dozen places it is written plainly.
 * - **The check's own code counts as a home for a token.** Several checks serve their
 *   own fixture markup (`shot-check.mjs` shoots a page it wrote itself), so a class that
 *   lives only in the check is correct, not missing. Its *comments* are stripped first —
 *   a header that happens to name `.shade-ask` in prose must not be what keeps the audit
 *   quiet about `.shade-ask` having left `public/`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Where the browser checks live, and what marks a file as one. */
export const CHECK_DIR = 'scripts';
export const CHECK_SUFFIX = '-check.mjs';

/**
 * Every browser check on disk, sorted, as repo-relative paths.
 *
 * The directory is the inventory. There is no list to forget to add to, which is the
 * same property `scripts/test.mjs` bought for the suites and for the same reason: a
 * check nobody wired in is a check nobody runs.
 */
export function discover(root) {
  const dir = path.join(root, CHECK_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(CHECK_SUFFIX))
    .sort()
    .map((f) => `${CHECK_DIR}/${f}`);
}

/** The page sources a check is entitled to press: everything in public/ but the vendored bundles. */
export function pageSources(root) {
  const dir = path.join(root, 'public');
  if (!fs.existsSync(dir)) return [];
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) return e.name === 'vendor' ? [] : walk(full);
      return /\.(js|css|html)$/.test(e.name) ? [full] : [];
    });
  return walk(dir).sort();
}

/**
 * The DOM queries a check makes with a literal string.
 *
 * `closest` and `matches` are in here alongside `querySelector*` because they name the
 * same markup and break the same way; a template literal with a `${}` in it is dropped,
 * because there is no text in it to look for.
 */
const QUERY = /(?:querySelectorAll|querySelector|closest|matches)\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g;

export function selectorsIn(src) {
  const found = [];
  for (const m of src.matchAll(QUERY)) {
    const selector = m[2];
    if (selector.includes('${')) continue;
    if (!/[.#[]/.test(selector)) continue; // `li`, `br`, `button` — a tag name is not evidence
    found.push({ selector, line: src.slice(0, m.index).split('\n').length });
  }
  return found;
}

/**
 * The searchable names inside one selector.
 *
 * `.card.open [data-role="answer"]` yields `.card`, `.open`, `[data-role]` and the value
 * `answer` — each looked up on its own, because they are removed on their own.
 */
export function tokensOf(selector) {
  const out = [];
  for (const m of selector.matchAll(/\[\s*(data-[\w-]+)\s*(?:([~^|*$]?=)\s*(['"]?)([^\]'"]*)\3)?\s*\]/g)) {
    out.push({ kind: 'attribute', token: `[${m[1]}]`, name: m[1] });
    if (m[4]) out.push({ kind: 'value', token: `[${m[1]}="${m[4]}"]`, name: m[4] });
  }
  const attrless = selector.replace(/\[[^\]]*\]/g, ' ');
  for (const m of attrless.matchAll(/([.#])([A-Za-z][\w-]*)/g)) {
    out.push({ kind: m[1] === '.' ? 'class' : 'id', token: m[1] + m[2], name: m[2] });
  }
  return out;
}

/** Comments out, so a token named only in prose cannot vouch for itself. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/**
 * The other half of `stripComments` — the prose only, and none of the code.
 *
 * What `countClaims` below is looking for is a sentence, and in a `.mjs` every sentence is
 * in a comment. Reading the code as well is not merely noise: `test/checks.mjs` holds the
 * claim shapes it measures the detector against as string literals, so a scan of that
 * whole file would find its own fixtures and fail. `all ${ran} checks passed` would be the
 * other one.
 */
export function commentsOf(src) {
  const out = [];
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0]);
  for (const m of src.matchAll(/^[ \t]*\/\/.*$/gm)) out.push(m[0]);
  return out.join('\n');
}

const present = (haystack, name) =>
  new RegExp(`(?:^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\w-]|$)`).test(haystack);

/**
 * Audit one check against the pages it drives.
 *
 * Returns `{ checked, findings }` — how many tokens were looked up, and the ones that
 * appear nowhere but in the selector itself. A finding is a claim that the check will
 * fail the next time somebody runs it.
 */
export function auditSource(rel, src, pageText) {
  const own = stripComments(src).replace(QUERY, ' ');
  const findings = [];
  const seen = new Set();
  let checked = 0;
  for (const { selector, line } of selectorsIn(src)) {
    for (const { kind, token, name } of tokensOf(selector)) {
      if (seen.has(token)) continue;
      seen.add(token);
      checked += 1;
      if (present(pageText, name) || present(own, name)) continue;
      findings.push({ check: rel, line, selector, token, kind });
    }
  }
  return { checked, findings };
}

/**
 * The whole family at once.
 *
 * `{ checks, tokens, findings }` — every check audited, the total number of tokens
 * confirmed, and every token that has left `public/`. An empty `findings` is the state
 * this repo should be in; anything in it names a check, a line and the selector to look at.
 */
export function audit(root) {
  const pageText = pageSources(root)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const checks = discover(root);
  let tokens = 0;
  const findings = [];
  for (const rel of checks) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const result = auditSource(rel, src, pageText);
    tokens += result.checked;
    findings.push(...result.findings);
  }
  return { checks, tokens, findings };
}

/* ------------------------------------------------ how many checks there are, in prose */

/**
 * Prose that claims *how many* browser checks there are — the one fact about them that
 * must not be written down.
 *
 * `discover()` is the inventory and it is derived: adding a check is adding a file, which
 * is the whole property this module and `scripts/test.mjs` were built for. The prose was
 * not derived. *There are twenty-eight of them* was written once and then said
 * twenty-eight through every addition after it, in eleven places at once — four in
 * `scripts/checks.mjs`, one in `test/checks.mjs`, six in the README — plus every phrasing
 * spun off it, each carrying its own arithmetic: the set minus the one that hung, the set
 * minus the one with the stale selector. On 2026-08-11 `origin/main` claimed twenty-six
 * with twenty-seven on disk; one session bumped all eleven for the check it added, merged
 * a `main` that had added another without sweeping, and bumped the same eleven lines
 * again — in one sitting. By the time this was written the prose was six behind. Nobody
 * was ever going to keep that up, and a number that is reliably wrong is worse than no
 * number, because it reads as measured.
 *
 * So the numbers are gone from the present tense, and this is what stops them coming
 * back: the count is available at runtime everywhere it used to be claimed
 * (`npm run checks -- --list`, and the audit line the runner prints), so there is nothing
 * a number in a comment can say that is both true and durable.
 *
 * **It matches the shapes the claim was actually written in, not any number near the word
 * "check".** "ten to forty seconds", "a four-minute leash" and "twenty-four behavioural
 * halves" are facts about a check that do not go stale, and a linter that fired on those
 * would be turned off within a month. A number qualifying a noun of its own is not an
 * inventory count. What is reported is a number standing in for the set: `all …`,
 * `the other …`, `the real …`, `of the …`, `… checks`, `… scripts/*-check.mjs`.
 *
 * `exempt` is for the sentences that are *about the past* — the one about the first
 * end-to-end run has to go on saying twenty-six for as long as it is a story about that
 * run, and bumping it would be a lie rather than an update. Each entry is matched
 * literally and only the claims inside one are excused, so reworded history stops being
 * exempt rather than silently staying so; `unused` names the entries that matched
 * nothing, which is what catches an exemption left behind by a rewrite.
 *
 * Digits count as a number only in the two shapes that *name* the inventory. In the others a
 * figure is always some other tally — "13 of the 17 fail" is a sentence about one check's
 * assertions — while the claim about how many checks there are has, every time anybody wrote
 * it, been spelled out. And a figure preceded by `-` is the back half of a line range:
 * `install.sh:29-48 checks Darwin` is a sentence in which "checks" is a verb.
 *
 * The last discrimination is what a number *stands for*. In *all N of them* the number is
 * the set; in *all N worktrees* it modifies a noun and belongs to somebody else's tally. So
 * the determiner shapes require the number to stand alone — followed by punctuation, by
 * `of them`, by the inventory named, or by a verb, and never by a noun of its own. A quoted
 * number counts as standing alone, which errs towards reporting: that is the safe direction
 * for this, because a claim nobody is told about is the state it was written to end.
 */
const CLAIM_TENS = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const CLAIM_UNIT = '(?:one|two|three|four|five|six|seven|eight|nine)';
const CLAIM_WORD = `(${CLAIM_TENS}(?:[- ]${CLAIM_UNIT})?)`;
const CLAIM_ANY = `(${CLAIM_TENS}(?:[- ]${CLAIM_UNIT})?|(?<![\\d-])\\d{2,3})`;
const CLAIM_ALONE =
  '(?=$|\\s*[.,;:—)”"\'`]|\\s+(?:of them\\b|checks?\\b|`?scripts/|are\\b|were\\b|is\\b|was\\b|and\\b|to\\b|either\\b|today\\b|still\\b|have\\b|had\\b))';
const INVENTORY = `\`?scripts/\\*${CHECK_SUFFIX.replace(/\./g, '\\.')}\`?`;
const CLAIM_SHAPES = [
  `${CLAIM_ANY} ${INVENTORY}`,
  `${CLAIM_ANY} checks?\\b`,
  `\\ball ${CLAIM_WORD}\\b${CLAIM_ALONE}`,
  `\\bthe other ${CLAIM_WORD}\\b${CLAIM_ALONE}`,
  `\\bthe real ${CLAIM_WORD}\\b${CLAIM_ALONE}`,
  `\\bof the ${CLAIM_WORD}\\b${CLAIM_ALONE}`,
  `\\bthese ${CLAIM_WORD}\\b${CLAIM_ALONE}`,
];

/**
 * A block of comment, README or code, flattened into plain prose.
 *
 * A claim wraps: `two of the` ends one comment line and `twenty-six were red` begins the
 * next, so nothing can be found line by line. Leading `*`, `//` and `#` come off and all
 * whitespace collapses, which makes the text one string in which the wrap has gone.
 */
export function proseOf(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/|#{1,6}|-|\d+\.)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

/**
 * `{ claims, unused }` — every count claim in `text` that no `exempt` entry covers, and
 * every `exempt` entry that covered nothing. Both empty is the state this repo holds.
 */
export function countClaims(text, exempt = []) {
  const prose = proseOf(text);
  const spans = [];
  const unused = [];
  for (const literal of exempt) {
    let at = prose.indexOf(literal);
    if (at === -1) unused.push(literal);
    while (at !== -1) {
      spans.push([at, at + literal.length]);
      at = prose.indexOf(literal, at + 1);
    }
  }
  const covered = (at) => spans.some(([from, to]) => at >= from && at < to);
  const claims = [];
  const seen = new Set();
  for (const shape of CLAIM_SHAPES) {
    /* `d` for the number's own offset: two shapes can name one number, and it is the
       number that is exempt or not, not the phrase that happens to have found it. */
    for (const m of prose.matchAll(new RegExp(shape, 'gid'))) {
      const at = m.indices[1][0];
      if (covered(at) || seen.has(at)) continue;
      seen.add(at);
      claims.push({
        claim: m[0],
        context: prose.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).trim(),
      });
    }
  }
  return { claims, unused };
}
