#!/usr/bin/env node
/**
 * The four registries `.gitattributes` union-merges carry no entry twice.
 *
 *     npm test
 *     node test/unionmerge.mjs
 *
 * ## Why there is a `.gitattributes` at all
 *
 * Adding one b7e tool is a new `bin/b7e-X`, a new `lib/X.js` and a new `test/b7eX.mjs` —
 * none of which can conflict, because nothing else has ever seen them — plus one line in
 * each of four registries that every other branch in flight is also appending to. Those
 * four lines are where the conflict load of this repo comes from, and it is not close.
 *
 * Measured on 2026-08-26 (bc-8479e) by merging all 34 open pull request branches onto
 * `origin/main` in a scratch clone, in the order they would reach the head of the queue:
 * **13 of the 34 conflicted.** `lib/grants.js` in 10 of them, `lib/toolbelt.js` in 5,
 * `package.json` and `package-lock.json` in 2, `README.md` in 3 — and `lib/server.js` in
 * exactly one, which was the only conflict in the whole set where the two sides had
 * anything to say to each other. Every other one was both sides adding a line.
 *
 * Ten of the fourteen branches touching `lib/grants.js` insert at the same line, 333,
 * after the last b7e grant, because there is only one place to put it. So one of them
 * landing conflicts the other nine — and each of those conflicts costs a resolver window,
 * which is one of this Mac's two session slots, plus a full `npm test` re-run, for a line
 * nobody had to think about. bc-9d37 built that resolver and it works; the point of the
 * `.gitattributes` is that it should only ever fire on the `lib/server.js`-shaped one.
 *
 * The same 34-branch simulation with `merge=union` on the four took the conflicts from
 * 13 to 4, all four of them `README.md`.
 *
 * ## Why that needs a check, and what exactly this one is guarding
 *
 * Union's trade is that it resolves an append **silently**: where both sides added lines
 * at one spot it keeps both, in order, and says nothing. That is right for a list. It is
 * wrong the moment the two sides did not append but *edited* — two branches changing one
 * grant's `kind` from `read` to `write` leave the key in the file twice, and both a JS
 * object literal and a JSON object keep the last one and discard the first without a
 * murmur. The file parses. The suites pass. One of the two branches has silently lost.
 *
 * Nothing here could see that before this file existed. `test/grants.mjs` asks whether
 * every grant is *classified* and never whether one is classified twice, and it cannot
 * ask: by the time it holds `GRANTS`, the duplicate has already collapsed. So the
 * question has to be put to the **source text**, and the answer is the same one in all
 * four files — more keys in the text than in the parsed value means one was swallowed.
 *
 * That is the whole design, and it is why the counts are cross-checked rather than just
 * the names: a name-based scan that quietly stops matching passes forever over nothing,
 * which is the way every check of this shape rots. Here the text count has to *equal*
 * `Object.keys(GRANTS).length`, so a scan that stops seeing keys fails immediately
 * instead of going green.
 *
 * ## The two halves of `package.json`
 *
 * `package-lock.json` carries its own copy of the root package's `bin` map — which is why
 * a one-line bin addition shows up as a conflict in both files, in lockstep. Union merges
 * the two independently, so the new failure mode this change introduces is the two maps
 * *disagreeing*: `npm` would then install a binary the manifest does not declare, or miss
 * one it does. So the two are asserted identical, not merely each internally consistent.
 *
 * ## What is deliberately not checked
 *
 * **That `package.json`'s bin map matches `bin/`.** It does not, on purpose:
 * `bin/router.js` and `bin/status.js` are spawned by path and are not npm entry points.
 * Deriving the map from the directory is bc-wbrhi's job and it will have to keep those
 * two out; asserting equality here would make a working repo red and teach somebody to
 * "fix" it by declaring two binaries that should not exist.
 *
 * **`README.md`.** It conflicts more often than anything except `lib/grants.js` and it is
 * still not on the union list, because it is 36,601 lines of prose. A duplicated list
 * entry is a thing a scan can see and this file now fails on; a duplicated *paragraph* in
 * a 2.6MB document reads as writing, and there is nothing anywhere that would catch it. A
 * conflict in a document is a question worth stopping on. The check below asserts no
 * Markdown path is union-merged, so that argument has to be made again rather than
 * quietly reversed.
 *
 * **The set of union'd files is closed.** The live check names exactly four. A fifth file
 * gaining `merge=union` fails here, and the failure is the point: whoever adds it has to
 * come to this file and say how a duplicate in it would be caught.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const { GRANTS } = await import(path.join(ROOT, 'lib', 'grants.js'));
const { DEFAULT_TOOL_LIST } = await import(path.join(ROOT, 'lib', 'toolbelt.js'));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};

/** The paths `.gitattributes` declares `merge=union` for, in the order it declares them. */
export function unionPaths(text) {
  const paths = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [pattern, ...attrs] = t.split(/\s+/);
    if (attrs.includes('merge=union')) paths.push(pattern);
  }
  return paths;
}

/**
 * The lines inside one literal, found by its opening line and closed by indentation.
 *
 * `null` rather than an empty array when the opener is gone, and every caller treats that
 * as a failure. A region finder that answers "no lines" to a renamed export is how a scan
 * like this passes forever over nothing — the counts below would agree at zero and agree
 * for the wrong reason.
 */
export function blockLines(src, openerRe) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => openerRe.test(l));
  if (start === -1) return null;
  const indent = lines[start].match(/^\s*/)[0];
  for (let i = start + 1; i < lines.length; i += 1) {
    const t = lines[i].trimStart();
    if ((t.startsWith('}') || t.startsWith(']')) && lines[i].match(/^\s*/)[0] === indent)
      return lines.slice(start + 1, i);
  }
  return null;
}

/**
 * The indentation of a literal's own members — the least indented thing inside it.
 *
 * Derived rather than assumed, because the three files put their members at three
 * different depths: two spaces in `lib/grants.js`, four in `package.json`, eight in the
 * lock's root package entry.
 */
export function memberIndent(lines) {
  let indent = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const own = line.match(/^\s*/)[0];
    if (indent === null || own.length < indent.length) indent = own;
  }
  return indent ?? '';
}

/**
 * Keys of an object literal, one per line, at the literal's own depth and no deeper.
 *
 * Three spellings, because `GRANTS` uses all three: `'Bash(b7e-x:*)'` for a pattern with
 * punctuation in it, `"b7e-x"` in the JSON files, and a bare `Write:` for the built-in
 * tools whose names are already identifiers.
 *
 * The depth is what makes the bare form safe to read. `kind:` and `why:` are bare keys
 * too, and a grant with an argument spelled out over several lines has plenty of them —
 * they sit one level in, and a key of the literal itself never does.
 */
export function quotedKeys(lines) {
  const indent = memberIndent(lines);
  const key = new RegExp(`^${indent}(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\\w$]*))\\s*:`);
  const keys = [];
  for (const line of lines) {
    const m = line.match(key);
    if (m) keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return keys;
}

/** Quoted entries of an array literal, one per line. Comment lines carry no quote to match. */
export function quotedEntries(lines) {
  const entries = [];
  for (const line of lines) {
    const m = line.match(/^\s*'([^']+)',?\s*$/);
    if (m) entries.push(m[1]);
  }
  return entries;
}

/** Every value appearing more than once, once each, in the order they first appear. */
export function duplicates(list) {
  const seen = new Set();
  const dupes = new Set();
  for (const v of list) (seen.has(v) ? dupes : seen).add(v);
  return [...dupes];
}

console.log('\nthe union-merged registries carry no entry twice\n');

/* ------------------------------------------------------------------ 1. the declaration */

const EXPECTED = ['lib/grants.js', 'lib/toolbelt.js', 'package.json', 'package-lock.json'];
const attributesPath = path.join(ROOT, '.gitattributes');

if (!fs.existsSync(attributesPath)) {
  bad('.gitattributes exists', 'without it every branch conflicts on lib/grants.js:333 again — see the header');
} else {
  const attributes = fs.readFileSync(attributesPath, 'utf8');
  const declared = unionPaths(attributes);

  const missing = EXPECTED.filter((p) => !declared.includes(p));
  const extra = declared.filter((p) => !EXPECTED.includes(p));

  if (!missing.length && !extra.length) {
    ok(`the four registries are union-merged, and only those four (${EXPECTED.join(', ')})`);
  } else if (missing.length) {
    bad(
      `${missing.length} registry no longer union-merged: ${missing.join(', ')}`,
      'every branch in flight starts conflicting on it again — 10 of 14 did on lib/grants.js'
    );
  } else {
    bad(
      `${extra.length} file union-merged that this suite does not guard: ${extra.join(', ')}`,
      'union resolves an edit-vs-edit silently, so add the duplicate check for it here first'
    );
  }

  const prose = declared.filter((p) => /\.(md|markdown|txt|html)$/i.test(p));
  if (!prose.length) ok('and no document is union-merged — a duplicated paragraph reads as writing');
  else
    bad(
      `${prose.length} document union-merged: ${prose.join(', ')}`,
      'a section quietly appearing twice in 36,601 lines of prose is caught by nothing'
    );
}

/* --------------------------------------------------------------- 2. the two JS registries */

const grantsSrc = fs.readFileSync(path.join(ROOT, 'lib', 'grants.js'), 'utf8');
const grantsBlock = blockLines(grantsSrc, /^export const GRANTS = Object\.freeze\(\{/);

if (!grantsBlock) {
  bad('the GRANTS literal is still found in lib/grants.js', 'the scan below has nothing to read — it was not passing, it was blind');
} else {
  const keys = quotedKeys(grantsBlock);
  const dupes = duplicates(keys);
  if (!dupes.length && keys.length === Object.keys(GRANTS).length)
    ok(`GRANTS declares each of its ${keys.length} patterns once`);
  else if (dupes.length)
    bad(
      `GRANTS declares ${dupes.length} pattern(s) twice: ${dupes.join(', ')}`,
      'the object keeps the last and discards the first — one of the two branches has silently lost'
    );
  else
    bad(
      `GRANTS: ${keys.length} keys in the text against ${Object.keys(GRANTS).length} in the object`,
      'the scan and the module disagree, so one of them is not reading what it thinks it is'
    );

  if (keys.length >= 60) ok('and it was read against the real list, not a handful of lines');
  else bad('GRANTS was read against the real list', `only ${keys.length} keys — the check above passed over nothing`);
}

const toolbeltSrc = fs.readFileSync(path.join(ROOT, 'lib', 'toolbelt.js'), 'utf8');
const toolbeltBlock = blockLines(toolbeltSrc, /^export const DEFAULT_TOOL_LIST = \[/);

if (!toolbeltBlock) {
  bad('the DEFAULT_TOOL_LIST literal is still found in lib/toolbelt.js', 'the scan below has nothing to read');
} else {
  const entries = quotedEntries(toolbeltBlock);
  const dupes = duplicates(entries);
  if (!dupes.length && entries.length === DEFAULT_TOOL_LIST.length)
    ok(`DEFAULT_TOOL_LIST names each of its ${entries.length} tools once`);
  else if (dupes.length)
    bad(
      `DEFAULT_TOOL_LIST names ${dupes.length} tool(s) twice: ${dupes.join(', ')}`,
      'an array keeps both, so the tool is granted twice on every --allowedTools line'
    );
  else
    bad(
      `DEFAULT_TOOL_LIST: ${entries.length} entries in the text against ${DEFAULT_TOOL_LIST.length} in the array`,
      'the scan is missing a line shape the list actually uses'
    );

  if (entries.length >= 40) ok('and it too was read against the real list');
  else bad('DEFAULT_TOOL_LIST was read against the real list', `only ${entries.length} entries`);
}

/* -------------------------------------------------------------- 3. the two bin maps */

const BIN_OPENER = /^\s*"bin":\s*\{/;
const manifestSrc = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const lockSrc = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');

// The lock's first `"bin"` is the root package's own, under the `""` entry. Every later one
// belongs to a dependency, where two packages declaring the same binary name is normal.
const manifestBin = blockLines(manifestSrc, BIN_OPENER);
const lockBin = blockLines(lockSrc, BIN_OPENER);

if (!manifestBin || !lockBin) {
  bad('both bin maps are still found', `package.json: ${manifestBin ? 'found' : 'missing'}, package-lock.json: ${lockBin ? 'found' : 'missing'}`);
} else {
  const declared = quotedKeys(manifestBin);
  const mirrored = quotedKeys(lockBin);
  const manifest = JSON.parse(manifestSrc);

  const dupes = duplicates(declared);
  if (!dupes.length && declared.length === Object.keys(manifest.bin).length)
    ok(`package.json declares each of its ${declared.length} binaries once`);
  else if (dupes.length)
    bad(
      `package.json declares ${dupes.length} binary name(s) twice: ${dupes.join(', ')}`,
      'JSON keeps the last, so one branch\'s tool is on disk and not on PATH'
    );
  else
    bad(
      `package.json bin: ${declared.length} keys in the text against ${Object.keys(manifest.bin).length} parsed`,
      'the scan and JSON.parse disagree'
    );

  const lockDupes = duplicates(mirrored);
  if (lockDupes.length)
    bad(
      `package-lock.json's root bin map declares ${lockDupes.length} name(s) twice: ${lockDupes.join(', ')}`,
      'the lock is where npm reads the map from on a clean install'
    );
  else if ([...declared].sort().join('\n') === [...mirrored].sort().join('\n'))
    ok(`and package-lock.json mirrors all ${mirrored.length} of them`);
  else {
    const only = (a, b) => a.filter((x) => !b.includes(x));
    bad(
      'package.json and package-lock.json disagree about the bin map',
      `manifest only: ${only(declared, mirrored).join(', ') || 'none'}; lock only: ${only(mirrored, declared).join(', ') || 'none'}` +
        ' — the two are union-merged independently, so this is the divergence to expect'
    );
  }

  /*
   * Compared as sets, not in order: `package.json` leads with `beadcause` and the lock
   * sorts alphabetically, so the two have never agreed line for line and npm does not
   * care. Which names are present is the thing union could get wrong.
   */
}

/* --------------------------------------------------- 4. every check above, proved to bite */

/*
 * A guard nobody has ever seen fail is a guard nobody knows the shape of, and "it found no
 * duplicates" is equally true of a function that can no longer find anything. So each
 * scan is run against a made-up file it should reject, and one it should not.
 */

const CLEAN_GRANTS = [
  'export const GRANTS = Object.freeze({',
  "  'Bash(b7e-already:*)': { kind: 'read' },",
  "  'Bash(b7e-window:*)': { kind: 'read' },",
  "  'Bash(bd close:*)': {",
  '    kind: "write",',
  "    why: 'Closes a bead: a write, and one nothing else can undo.',",
  '  },',
  '});',
  '',
  'export const WRITES_FALSE_EXCEPTIONS = Object.freeze({',
  "  'Bash(b7e-window:*)': 'the same pattern, in a different literal',",
  '});',
].join('\n');

const cleanKeys = quotedKeys(blockLines(CLEAN_GRANTS, /^export const GRANTS = Object\.freeze\(\{/) ?? []);
if (cleanKeys.length === 3 && !duplicates(cleanKeys).length)
  ok('a nested object and a multi-line grant are read as one key each, not several');
else bad('a nested grant is one key', `got ${JSON.stringify(cleanKeys)}`);

if (!cleanKeys.includes('the same pattern, in a different literal') && cleanKeys.includes('Bash(b7e-window:*)'))
  ok('and the region stops at its own closing brace — a pattern reused in WRITES_FALSE_EXCEPTIONS is not a duplicate');
else bad('the region stops at its closing brace', `read past it: ${JSON.stringify(cleanKeys)}`);

const DUPED_GRANTS = CLEAN_GRANTS.replace(
  "  'Bash(b7e-window:*)': { kind: 'read' },",
  "  'Bash(b7e-window:*)': { kind: 'read' },\n  'Bash(b7e-window:*)': { kind: 'write' },"
);
const dupedKeys = quotedKeys(blockLines(DUPED_GRANTS, /^export const GRANTS = Object\.freeze\(\{/) ?? []);
if (duplicates(dupedKeys).join() === 'Bash(b7e-window:*)')
  ok('the read-vs-write collapse union would leave behind is caught');
else bad('a duplicated grant is caught', `duplicates: ${JSON.stringify(duplicates(dupedKeys))}`);

if (blockLines('export const SOMETHING_ELSE = Object.freeze({\n});', /^export const GRANTS = Object\.freeze\(\{/) === null)
  ok('a renamed export is a failure rather than an empty scan');
else bad('a renamed export fails loudly', 'the finder answered with lines it could not have read');

const LIST = ['export const DEFAULT_TOOL_LIST = [', '  // a comment about the next one', "  'Bash(b7e-run:*)',", "  'Read',", '];'].join(
  '\n'
);
const listEntries = quotedEntries(blockLines(LIST, /^export const DEFAULT_TOOL_LIST = \[/) ?? []);
if (listEntries.join() === 'Bash(b7e-run:*),Read') ok('a comment inside the tool list is not an entry');
else bad('a comment is not an entry', `got ${JSON.stringify(listEntries)}`);

const DUPED_BIN = ['  "bin": {', '    "b7e-window": "bin/b7e-window",', '    "b7e-window": "bin/b7e-window",', '  },'].join('\n');
if (duplicates(quotedKeys(blockLines(DUPED_BIN, BIN_OPENER) ?? [])).join() === 'b7e-window')
  ok('a bin map with the same name twice is caught, at JSON indentation');
else bad('a duplicated bin entry is caught', 'the JSON scan missed it');

const NESTED_BIN = ['      "bin": {', '        "acorn": "bin/acorn"', '      },', '      "bin": {', '        "acorn": "bin/acorn"', '      }'].join(
  '\n'
);
if (quotedKeys(blockLines(NESTED_BIN, BIN_OPENER) ?? []).join() === 'acorn')
  ok('and only the first bin map is read — two dependencies shipping the same binary name is not a duplicate');
else bad('only the root bin map is read', 'the scan ran into a dependency and would cry wolf');

const ATTRS = ['# a comment', '', 'lib/grants.js      merge=union', 'README.md          merge=union', 'issues.jsonl -merge linguist-generated'].join(
  '\n'
);
const parsed = unionPaths(ATTRS);
if (parsed.join() === 'lib/grants.js,README.md')
  ok('.gitattributes is read for union lines only — a comment and a -merge line are not declarations');
else bad('.gitattributes is read correctly', `got ${JSON.stringify(parsed)}`);

if (parsed.some((p) => /\.md$/i.test(p))) ok('and a document sneaking onto the union list is what the prose check looks for');
else bad('a document on the union list is detectable', 'the specimen was not recognised');

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
