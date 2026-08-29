/**
 * Every canon assertion about one named thing, with its source line — the read behind
 * `bin/b7e-dossier`.
 *
 * bc-dgx7.101 is the audit: six sessions in the deluvia tracker (`dv-gr6.5`, `dv-5eu.1.3`,
 * `dv-nsy.2`, `dv-2uu.5`, `dv-b5d.28`, `dv-b5d.32`) each opened by reconstructing what the
 * corpus already says about one entity — a character, a place, a species — before deciding
 * anything, and no two did it the same way. One of them found a real contradiction (Book 3
 * Ch. 5 made Korgath 43 where `reference/CHARACTER_CONCURRENCY.md:54` says 173) only
 * because one grep in a hand-typed list of eight happened to be the right one; another ran
 * the same sweep as an audit, found three stale statements, and had nothing to tell it
 * there were only three. This is that sweep, done the same way every time.
 *
 * ## What it is not
 *
 * Not `lib/corpus.js` / `b7e-claims`, which takes a **file** and asks what other files
 * assert about it. This takes a **name** and asks what every file asserts about it — a
 * different axis, and the contradictions it surfaces are between two sources neither of
 * which is the file under edit.
 *
 * ## The three moving parts
 *
 * 1. **The source set** is an ordered list of globs, from config, never hardcoded — see
 *    `sourcesFor`. Order is the whole point: it is what makes the first block canon and a
 *    later one derived prose, and it is what "in source order" means in the printed report.
 * 2. **A hit** is a line that names the subject, *or* a line carrying a field value inside
 *    a section whose heading names the subject (`### §8 — Othens` and then a bare
 *    `- Height: ...` bullet, which no grep for the name would ever find). Not the whole
 *    section: a line has to say something.
 * 3. **A field** is either an explicit `Label: value` at the head of a line, or one of the
 *    handful of shapes prose states without a label — an age, a lifespan, a height, a
 *    death. `FIELD_READERS` is that list; everything else about this module is generic.
 *
 * ## Numbers are read in both spellings, and that is not a nicety
 *
 * Reference files write `173 years old`; a drafted chapter writes `a hundred and
 * seventy-three years old`. The disagreement bc-dgx7.101 is named after is exactly a
 * digit against a word-run — `43` in `CHAPTER_5.propagated.md` against `173` in
 * `CHARACTER_CONCURRENCY.md` — so a reader that only understood digits would miss the one
 * finding the bead exists to reproduce. `numberBefore` handles both.
 *
 * ## What counts as a disagreement
 *
 * Two values of the same field disagree unless one *contains* the other: `15 ft` inside
 * `12-15 ft` is one source being more specific, not a contradiction, while `15-25 ft`
 * against `12-15 ft` is two incompatible claims. Non-numeric values disagree when they
 * differ after normalisation. It is a shortlist to look at, never a verdict — which is why
 * a disagreement does not change the exit code.
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectAll } from './corpus.js';

const run = promisify(execFile);

/**
 * The ordered source set used where config names none.
 *
 * Canon-shaped directories first and a catch-all last, so a repo that has never been
 * configured still gets a useful ordering rather than an alphabetical one — and a repo
 * with none of these directories still gets every markdown file it has.
 */
export const DEFAULT_SOURCES = ['reference/**/*.md', 'docs/**/*.md', 'compendium/**/*.md', '**/*.md'];

/* ------------------------------------------------------------------ globbing */

/** One glob to one anchored regexp. `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // A `**/` may match nothing at all, so `**/*.md` also matches a top-level file.
        if (glob[i + 2] === '/') {
          out += '(?:[^/]*(?:/|$))*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Every file matching `globs`, in glob order then alphabetical, each file once.
 *
 * The dedupe is what lets a catch-all sit at the end of the list without re-printing
 * everything the earlier, more specific globs already claimed: a canon glob first and a
 * whole-tree glob last gives canon-then-the-rest, not canon-then-canon-again.
 */
export function orderFiles(files, globs) {
  const out = [];
  const seen = new Set();
  for (const glob of globs) {
    const re = globToRegExp(glob);
    for (const rel of files.filter((f) => re.test(f)).sort()) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

/* --------------------------------------------------------------- reading a tree */

/** Every file in `root` at `ref`, or in the working tree when `ref` is null. */
export async function treeFiles(root, ref) {
  if (!ref) return collectAll(root);
  const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', ref], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split('\n').filter(Boolean);
}

/** One file's text at `ref`, or from the working tree — `null` if it is not there. */
export async function readSource(root, rel, ref) {
  if (!ref) {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await run('git', ['cat-file', '-p', `${ref}:${rel}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- the numbers */

const UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** `forty three` is 43, `hundred and seventy three` is 173, anything else is null. */
export function wordsToNumber(text) {
  const tokens = String(text)
    .toLowerCase()
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t !== 'and' && t !== 'a');
  if (!tokens.length) return null;
  let total = 0;
  let current = 0;
  let any = false;
  for (const t of tokens) {
    if (t in UNITS) {
      current += UNITS[t];
    } else if (t in TENS) {
      current += TENS[t];
    } else if (t === 'hundred') {
      current = (current || 1) * 100;
    } else if (t === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
    } else {
      return null;
    }
    any = true;
  }
  return any ? total + current : null;
}

/**
 * The number immediately before `prefix` ends, in digits or in words.
 *
 * Longest run wins, so `was a hundred and seventy three` reads 173 rather than 3: the
 * scan starts at the earliest token that could still be part of the number and takes the
 * first suffix that parses whole.
 */
export function numberBefore(prefix) {
  const toks = String(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9,.\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!toks.length) return null;
  const last = toks[toks.length - 1];
  if (/^\d[\d,]*(?:\.\d+)?$/.test(last)) return Number(last.replace(/,/g, ''));
  for (let i = Math.max(0, toks.length - 7); i < toks.length; i += 1) {
    const n = wordsToNumber(toks.slice(i).join(' '));
    if (n !== null) return n;
  }
  return null;
}

/* ------------------------------------------------------------------ the fields */

/** En dash, em dash or hyphen — a corpus uses all three for the same range. */
const DASH = '[\\u2013\\u2014-]';
const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `12'0"` is 12, `15'` is 15, `5'4"` is 5.33 — feet, as a number. */
function feet(ft, inches) {
  const n = Number(ft) + (inches ? Number(inches) / 12 : 0);
  return Math.round(n * 100) / 100;
}

/** A range or a point, rendered the one way so two spellings of it compare equal. */
function span(lo, hi, unit) {
  const one = (n) => String(Math.round(Number(n) * 100) / 100);
  return hi === null || hi === undefined || Number(hi) === Number(lo)
    ? `${one(lo)} ${unit}`
    : `${one(lo)}-${one(hi)} ${unit}`;
}

const HEIGHT_CUE = /\b(height|tall|tallest|upright|stature|stands?|standing|reared|rears|reach(?:es|ed)?)\b/i;

/**
 * The shapes prose states without a label. Each reader is given the whole line and
 * returns `[{field, value, lo?, hi?, unit?}]` — several per line is normal, and a line
 * that says nothing returns nothing.
 *
 * Deliberately short. Everything a corpus writes as `Label: value` is already picked up
 * generically by `labelledFields`, so what is left here is only what prose says in
 * sentences: how old something is, how long its kind lives, how big it is, whether it is
 * dead. Adding a fifth is adding a regexp, not a mechanism.
 */
export const FIELD_READERS = [
  {
    field: 'age',
    read(line) {
      const out = [];
      for (const m of line.matchAll(/([^.;:!?]{0,80}?)\s+years?\s+(?:old|of\s+age)\b/gi)) {
        const n = numberBefore(m[1]);
        if (n !== null && n > 0) out.push({ field: 'age', value: `${n} years`, lo: n, hi: n, unit: 'years' });
      }
      for (const m of line.matchAll(/\baged\s+(\d{1,4})\b/gi)) {
        out.push({ field: 'age', value: `${m[1]} years`, lo: Number(m[1]), hi: Number(m[1]), unit: 'years' });
      }
      return out;
    },
  },
  {
    field: 'lifespan',
    read(line) {
      const re = new RegExp(
        `\\b(?:live|lives|living|lifespans?[^.\\n]{0,24}?)\\s*(?:for|of|to|up\\s+to|is|are|:)?\\s*` +
          `(\\d{1,4})\\s*(?:${DASH}\\s*(\\d{1,4}))?\\s*years\\b`,
        'gi'
      );
      const out = [];
      for (const m of line.matchAll(re)) {
        const lo = Number(m[1]);
        const hi = m[2] === undefined ? lo : Number(m[2]);
        out.push({ field: 'lifespan', value: span(lo, hi, 'years'), lo, hi, unit: 'years' });
      }
      return out;
    },
  },
  {
    field: 'height',
    read(line) {
      const out = [];
      const cued = HEIGHT_CUE.test(line);
      // `(?!')` after the apostrophe is the possessive guard, and it is not theoretical:
      // "That is Ch. 33's chapter" reads as 33 feet without it, and a chapter number is
      // the commonest three-digit-and-an-apostrophe in a manuscript corpus. A bare
      // `15'` also needs the line to be about size at all; `12'0"` and `15'-25'` say so
      // themselves and do not.
      const ftIn = new RegExp(
        `(\\d{1,3})\\s*'(?![A-Za-z])\\s*(?:(\\d{1,2})\\s*")?(?:\\s*${DASH}\\s*(\\d{1,3})\\s*'(?![A-Za-z])\\s*(?:(\\d{1,2})\\s*")?)?`,
        'g'
      );
      for (const m of line.matchAll(ftIn)) {
        const bare = m[2] === undefined && m[3] === undefined;
        if (bare && !cued) continue;
        const lo = feet(m[1], m[2]);
        const hi = m[3] === undefined ? lo : feet(m[3], m[4]);
        out.push({ field: 'height', value: span(lo, hi, 'ft'), lo, hi, unit: 'ft' });
      }
      // A bare number with a unit is a height only where the line is talking about size.
      if (cued) {
        const united = new RegExp(
          `(\\d{1,4}(?:\\.\\d+)?)\\s*(?:${DASH}\\s*(\\d{1,4}(?:\\.\\d+)?)\\s*)?(ft|feet|foot|metres|meters|metre|meter|m|cm|inches|inch)\\b`,
          'gi'
        );
        for (const m of line.matchAll(united)) {
          const unit = /^(ft|feet|foot)$/i.test(m[3])
            ? 'ft'
            : /^(m|metres?|meters?)$/i.test(m[3])
              ? 'm'
              : m[3].toLowerCase().replace(/^inches?$/, 'in');
          const lo = Number(m[1]);
          const hi = m[2] === undefined ? lo : Number(m[2]);
          out.push({ field: 'height', value: span(lo, hi, unit), lo, hi, unit });
        }
      }
      return out;
    },
  },
  {
    field: 'status',
    read(line) {
      const out = [];
      if (/\b(dies|died|dead|killed|slain|deceased|perishes|perished)\b/i.test(line)) out.push({ field: 'status', value: 'dead' });
      if (/\b(alive|survives|survived|still\s+living)\b/i.test(line)) out.push({ field: 'status', value: 'alive' });
      return out;
    },
  },
];

/** Longest a labelled value may be before it is prose rather than a field. */
const MAX_LABELLED_VALUE = 60;

/**
 * `- Height: 12'0"`, `**Type:** WORLD DECISION` — a label at the head of a line.
 *
 * Anchored at the start (after an optional bullet and optional bold) on purpose: a colon
 * mid-sentence is punctuation, not a field, and matching one turns every second line of
 * prose into a fictitious assertion.
 *
 * **And the value has to look like a value.** Measured against deluvia's real corpus this
 * is the difference between a report and a wall: every chapter summary there is a run of
 * `emotional arc:`, `canon notes:`, `writing notes:` followed by three sentences, all of
 * them anchored, all of them labelled, none of them a field — one name pulled 60 of those
 * into FIELDS and buried the four that mattered. So a value stops at
 * `MAX_LABELLED_VALUE` characters and at the first sentence break, and a label is at most
 * three words. Nothing is lost by it: a long line that genuinely states a height or an age
 * is still read by `FIELD_READERS` below, which does not care how the line is punctuated.
 */
export function labelledFields(line) {
  const m = /^\s*([-*+]\s+|\d+\.\s+)?(\*\*|__)?([A-Z][A-Za-z][A-Za-z /_-]{0,24}?)(?:\*\*|__)?\s*:\s*(\S.*)$/.exec(line);
  if (!m) return [];
  const [, bullet, bold, label, rest] = m;
  const field = label.trim().toLowerCase().replace(/\s+/g, ' ');
  const words = field.split(' ').length;
  if (words > 3) return [];
  // A one-word label at the head of a line is a field wherever it appears (`Height:`,
  // `POV:`). A multi-word one has to be marked as one — a bullet or bold — or an English
  // sentence beginning "He said:" becomes a field called `he said`, and a chapter
  // summary's `emotional arc:` becomes one called `emotional arc`.
  if (words > 1 && !bullet && !bold) return [];
  const value = rest.replace(/\*\*|__|`/g, '').trim();
  if (!value || value.length > MAX_LABELLED_VALUE || /[.!?](\s|$)/.test(value)) return [];
  return [{ field, value, labelled: true }];
}

/**
 * Every field one line asserts — the labelled one, if any, plus the prose shapes.
 *
 * A label that names a field one of the readers already understands is dropped in favour
 * of the reader's own answer: `Age: 173 years old` labelled reads `173 years old` and read
 * as prose reads `173 years`, and carrying both makes a field disagree with itself in
 * every report it appears in. The reader wins because it normalises — that is the whole
 * reason two spellings of one number can be compared at all.
 */
export function fieldsIn(line) {
  const readerFields = new Set(FIELD_READERS.map((r) => r.field));
  const out = labelledFields(line).filter((f) => !readerFields.has(f.field));
  for (const reader of FIELD_READERS) out.push(...reader.read(line));
  const seen = new Set();
  return out.filter((f) => {
    const key = `${f.field}::${f.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------- the names */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One matcher for every spelling of the subject.
 *
 * Word-bounded and plural-tolerant (`Othen` also finds `Othens`, `Othen's`), and every
 * character escaped — `dv-5eu.1.3` lost two of its eight calls to `grep` refusing a name
 * with parentheses in it, which is not a failure this is allowed to repeat.
 */
export function nameMatcher(names) {
  const alts = names.map((n) => `${escapeRe(n)}(?:'s|’s|es|s)?`).join('|');
  return new RegExp(`(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])`, 'i');
}

/* ------------------------------------------------------------------- the scan */

/** `#`-headings with their line numbers, so a hit can name the section it is in. */
export function headingsOf(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ line: i + 1, depth: m[1].length, text: m[2].replace(/\*\*|__|`/g, '').trim() });
  });
  return out;
}

function headingAt(headings, line) {
  let found = null;
  for (const h of headings) {
    if (h.line > line) break;
    found = h;
  }
  return found;
}

/**
 * One file's hits: the lines that name the subject, plus the lines carrying a field
 * inside a section whose heading names it.
 *
 * The second half is the one a grep cannot do. A `### §8 - Othens` heading followed by a
 * bare `- Height: ...` bullet states the species' height and never repeats the species'
 * name; every one of the six sessions in bc-dgx7.101 read those bullets by eye after a
 * grep had pointed them at the heading.
 */
export function scanFile(rel, text, matcher, { maxPerFile = 40 } = {}) {
  const headings = headingsOf(text);
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const heading = headingAt(headings, i + 1);
    const named = matcher.test(raw);
    const inNamedSection = !named && heading ? matcher.test(heading.text) : false;
    if (!named && !inNamedSection) continue;
    const fields = fieldsIn(raw);
    // A line inside the section earns its place only by asserting something; a line that
    // names the subject is a hit either way, because that is what was asked for.
    if (!named && !fields.length) continue;
    hits.push({
      file: rel,
      line: i + 1,
      heading: heading ? heading.text : null,
      text: clip(raw.trim()),
      via: named ? 'name' : 'section',
      fields,
    });
    if (hits.length >= maxPerFile) break;
  }
  return hits;
}

/* -------------------------------------------------------------- the two summaries */

/** The fields `FIELD_READERS` states — always summarised, however few sources say them. */
const READER_FIELDS = new Set(FIELD_READERS.map((r) => r.field));

/**
 * Every distinct value found for each field that **recurs**, in source order, with where
 * each came from.
 *
 * "Recurs" is the bead's own word and it is doing work: a labelled field only one source
 * in the corpus ever writes is that source's own bookkeeping, not a property of the
 * subject, and summarising it says nothing two sources could ever disagree about. So a
 * labelled field earns a row by appearing in two or more files; the four `FIELD_READERS`
 * fields are always kept, because a lone age *is* the answer to "how old is this". A
 * one-file corpus has nothing to recur across, so the rule stands down there.
 */
export function fieldSummary(hits) {
  const byField = new Map();
  const filesPerField = new Map();
  for (const hit of hits) {
    for (const f of hit.fields) {
      if (!byField.has(f.field)) {
        byField.set(f.field, new Map());
        filesPerField.set(f.field, new Set());
      }
      filesPerField.get(f.field).add(hit.file);
      const values = byField.get(f.field);
      if (!values.has(f.value)) values.set(f.value, { value: f.value, lo: f.lo, hi: f.hi, unit: f.unit, sources: [] });
      const entry = values.get(f.value);
      if (entry.sources.length < 8) entry.sources.push({ file: hit.file, line: hit.line, text: hit.text });
    }
  }
  const oneFileCorpus = new Set(hits.map((h) => h.file)).size <= 1;
  return [...byField.entries()]
    .filter(([field]) => oneFileCorpus || READER_FIELDS.has(field) || filesPerField.get(field).size > 1)
    .map(([field, values]) => ({ field, values: [...values.values()] }))
    .sort((a, b) => {
      const rank = (f) => (READER_FIELDS.has(f.field) ? 0 : 1);
      return rank(a) - rank(b) || a.field.localeCompare(b.field);
    });
}

/** Does one value's interval sit wholly inside the other's? Then it is not a contradiction. */
function nests(a, b) {
  if (a.lo === undefined || b.lo === undefined || a.unit !== b.unit) return false;
  const inside = (x, y) => x.lo >= y.lo && x.hi <= y.hi;
  return inside(a, b) || inside(b, a);
}

/** Most distinct values a non-numeric field may have before it is a list, not a dispute. */
const MAX_TEXT_VARIANTS = 4;

/**
 * The fields whose sources do not agree.
 *
 * A field with one value is quiet. A field with two is a disagreement unless one is simply
 * more specific than the other — see `nests`, and the module docstring for why a point
 * inside a range is not a finding.
 *
 * A field with no numbers in it is compared only when the comparison could mean something:
 * a handful of short values (`Kazran Orve` against `Alban Orve`) is a contradiction worth
 * a look, and twenty distinct paragraphs are twenty chapters each describing themselves.
 * Nothing here can tell whether two English sentences contradict one another, and
 * pretending otherwise is what makes a report unreadable.
 */
export function disagreements(summary) {
  const out = [];
  for (const { field, values } of summary) {
    if (values.length < 2) continue;
    const numeric = values.every((v) => v.lo !== undefined);
    if (!numeric && (values.length > MAX_TEXT_VARIANTS || values.some((v) => v.value.length > 40))) continue;
    const conflicting = values.some((a, i) => values.some((b, j) => j > i && !nests(a, b)));
    if (conflicting) out.push({ field, values });
  }
  return out;
}

/* -------------------------------------------------------------------- the whole */

/**
 * The dossier: every source that says something about `names`, in source order, with
 * the two summaries over the fields they state.
 */
export async function dossier(root, names, { sources = DEFAULT_SOURCES, ref = null, maxPerFile = 40 } = {}) {
  const matcher = nameMatcher(names);
  const files = orderFiles(await treeFiles(root, ref), sources);
  const blocks = [];
  for (const rel of files) {
    const text = await readSource(root, rel, ref);
    if (text === null) continue;
    // Cheap reject before the line walk: most files in a corpus never name the subject at
    // all, and the section rule cannot fire in a file whose text has no match either.
    if (!matcher.test(text)) continue;
    const hits = scanFile(rel, text, matcher, { maxPerFile });
    if (hits.length) blocks.push({ file: rel, hits });
  }
  const allHits = blocks.flatMap((b) => b.hits);
  const summary = fieldSummary(allHits);
  return { names, ref, sources, blocks, fields: summary, disagrees: disagreements(summary) };
}

/**
 * The ordered glob list for one workspace and one `--kind`.
 *
 * `dossier.sourcesPerWorkspace[<name>]` is either an array — that workspace's own set,
 * whatever the kind — or an object keyed by kind with a `default` entry beside the named
 * ones. An unknown kind falls through to `default`, and a workspace nobody has configured
 * falls through to `dossier.sources`, so nothing has to be configured for this to work.
 */
export function sourcesFor(cfg, wsName, kind) {
  const block = cfg?.dossier || {};
  const base = Array.isArray(block.sources) && block.sources.length ? block.sources : DEFAULT_SOURCES;
  const entry = wsName ? (block.sourcesPerWorkspace || {})[wsName] : null;
  if (Array.isArray(entry)) return entry.length ? entry : base;
  if (entry && typeof entry === 'object') {
    const picked = (kind && entry[kind]) || entry.default;
    if (Array.isArray(picked) && picked.length) return picked;
  }
  return base;
}
