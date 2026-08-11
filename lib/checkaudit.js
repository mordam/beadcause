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
 * pressed those chips to narrow the filter, so it broke outright, and `npm test` stayed
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
