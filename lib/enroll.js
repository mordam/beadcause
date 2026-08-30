/**
 * The registries a new `bin/` command owes an entry in — read by the linter
 * (`bin/b7e-enroll`) and written by the applier (`bin/b7e-register`).
 *
 * bc-khoe.27.11 put the *reading* half in code: seven checks, one per place a new command
 * incurs debt in, so that no session has to re-derive them by hand. bc-dgx7.75 is the
 * other half of the same argument. Five sessions (bc-dgx7.57, bc-dgx7.58, bc-dgx7.59,
 * bc-dgx7.60, bc-dgx7.61) each shipped a `b7e-*` command, each ran `b7e-enroll <name>`
 * afterwards to check the registrations — and each typed those registrations by hand
 * first, four different ways: two alphabetical neighbours grepped out of package.json to
 * find an insertion point, `npm install --package-lock-only` against a hand-edited lock,
 * a read-only sibling grepped for the comment convention. The registry knowledge lived
 * twice, once in this file's checks and once in each session's fingers, and the second
 * copy was the one that went wrong.
 *
 * So the checks and the edits are the same knowledge and live in the same module. What
 * the checks match is what the edits produce, and a change to one is a change to both.
 * Everything above the applier section is a **verbatim move** out of `bin/b7e-enroll`,
 * which is now the reading half's CLI over this file and re-exports it.
 *
 * ## What is left to apply, after bc-wbrhi
 *
 * bc-dgx7.75 was filed on 2026-08-25 against four registries. bc-wbrhi landed on
 * 2026-08-26 and deleted two of them: a `b7e-*` tool now declares `@grant read`,
 * `@grant write` or `@grant excluded` in its own header, `lib/tooldecl.js` assembles
 * `DEFAULT_TOOL_LIST` and the `lib/grants.js` classification from those declarations,
 * and `test/tooldecl.mjs` **fails** a hand-written `b7e-*` line in `lib/grants.js`. Half
 * of what this bead asked for was delivered by removing the work rather than automating
 * it, which is the better fix and leaves this one smaller. What a tool can still write:
 *
 *   package.json `bin`                 — a one-line insertion, alphabetical within the
 *                                        name's own family block (see insertionIndex).
 *   package-lock.json packages[""].bin — the same line in the same order `npm install
 *                                        --package-lock-only` would have produced.
 *   bin/<name>'s own header            — the `@grant` line, which is check 6 and which
 *                                        decides both derived registries at once.
 *   lib/tooldecl.js                    — the paragraph arguing for that grant, appended
 *                                        where the other sixty-three live.
 *
 * The three it will not write are the three that are not registrations: `bin/<name>`
 * itself is the command (that is b7e-scaffold's job), and `test/<name>.mjs` and the
 * README `###` section are a proof and an explanation, where a generated one of either
 * would be a registration pretending to be work. `b7e-enroll` goes on reporting those
 * two as owed after `b7e-register` has run, which is the intended shape: the applier
 * clears what is mechanical and leaves what needs a person.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { declarationsIn, KINDS, readDeclarations } from './tooldecl.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Used only when `cwd` is not inside any git worktree at all — this file's own checkout. */
const FALLBACK_ROOT = path.join(HERE, '..');

/**
 * The root to check: the CALLING session's own worktree, not this script's. Per memory
 * note only-an-extensionless-bin-resolves-on-path, the bin/ file that actually executes
 * for any b7e-* command is always the MAIN CHECKOUT's copy — lib/foundation.js puts the
 * main checkout's bin/ first on PATH — so a HERE-based root would always answer for the
 * main checkout regardless of which worktree the agent is really sitting in, which is
 * backwards for a tool whose whole job is catching an uncommitted, not-yet-merged
 * registration before it ships. Same repoRoot(cwd) pattern as lib/repogrep.js
 * (bc-4r10.21): shell out to git rather than walk up looking for a marker file, so a
 * worktree resolves to its own root and not its main checkout's.
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

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readText = (p) => fs.readFileSync(p, 'utf8');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ===================================================================== *
 * naming a candidate
 * ===================================================================== */

/**
 * The command name an argv token or a bin/ filename resolves to: a bare command name
 * passes through unchanged, `bin/b7e-x.js` or `b7e-x.js` becomes `b7e-x` — the same
 * derivation whether the file is registered yet or was just created.
 */
export function deriveName(arg) {
  let base = arg.includes('/') ? path.basename(arg) : arg;
  if (base.endsWith('.js')) base = base.slice(0, -3);
  return base;
}

/**
 * Every command worth checking with no argument given: every key in package.json's
 * `bin` map, plus any `b7e-*` file directly under bin/ that map does not already
 * point to — a stray, freshly-added skill with no registration yet. Restricted to
 * `b7e-*` on purpose: bin/ also holds scripts like `router.js` and `status.js` that
 * are never meant to be a package.json `bin` entry at all (spawned by absolute path,
 * not typed by name), and sweeping every unregistered file in bin/ reported those as
 * "missing a bin entry" — noise this tool exists to cut through, not add to.
 */
export function candidateNames(root, pkg) {
  const fromPkg = Object.keys(pkg.bin || {});
  const binDir = path.join(root, 'bin');
  const files = fs.readdirSync(binDir).filter((f) => fs.statSync(path.join(binDir, f)).isFile());
  const registeredTargets = new Set(Object.values(pkg.bin || {}).map((v) => path.basename(v)));
  const strays = files
    .filter((f) => f.startsWith('b7e-') && !registeredTargets.has(f))
    .map((f) => (f.endsWith('.js') ? f.slice(0, -3) : f));
  return [...new Set([...fromPkg, ...strays])].sort();
}

/* ===================================================================== *
 * 1. the bin/ file itself
 * ===================================================================== */

/**
 * A tool's own source, or `''` when there is nothing to read.
 *
 * Resolved the way `binFileProblem` resolves it — through `package.json`'s `bin` entry
 * when there is one, so the two `.js`-suffixed names (`b7e-owes`, `b7e-say`) are read
 * from the file they actually point at rather than from an extensionless one that does
 * not exist.
 */
export function sourceOf(name, root, pkg) {
  const rel = (pkg.bin && pkg.bin[name]) || path.join('bin', name);
  try {
    return readText(path.join(root, rel));
  } catch {
    return '';
  }
}

export function binFileProblem(name, root, pkg) {
  const registered = pkg.bin && pkg.bin[name];
  const rel = registered || path.join('bin', name);
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    if (registered) return `${rel}: file is missing — package.json's "bin" entry points here and nothing is there`;
    return (
      `bin/${name}: no extensionless file here yet — a new command needs one (a package.json rename ` +
      `resolves only after an npm link this install has never had; see memory note ` +
      `only-an-extensionless-bin-resolves-on-path)`
    );
  }
  const stat = fs.statSync(file);
  if (!(stat.mode & 0o111)) return `${rel}: not executable — chmod +x`;
  if (!readText(file).startsWith('#!/usr/bin/env node')) return `${rel}: no '#!/usr/bin/env node' shebang`;
  return null;
}

/* ===================================================================== *
 * 2 & 3. package.json and package-lock.json
 * ===================================================================== */

export function packageJsonProblem(name, pkg) {
  const got = pkg.bin && pkg.bin[name];
  if (got !== undefined) return null;
  return `package.json: no "bin" entry for ${name} — add "${name}": "bin/${name}"`;
}

export function packageLockProblem(name, pkg, lock) {
  const pkgVal = pkg.bin && pkg.bin[name];
  if (pkgVal === undefined) return null; // packageJsonProblem already names this gap
  const lockVal = lock.packages && lock.packages[''] && lock.packages[''].bin && lock.packages[''].bin[name];
  if (lockVal === undefined) {
    return `package-lock.json packages[""].bin: no ${name} (test/lockfile.mjs, pinned first)`;
  }
  if (lockVal !== pkgVal) {
    return (
      `package-lock.json packages[""].bin: ${name} -> ${JSON.stringify(lockVal)}, ` +
      `package.json says ${JSON.stringify(pkgVal)} (test/lockfile.mjs)`
    );
  }
  return null;
}

/* ===================================================================== *
 * 4. a test that spawns it
 * ===================================================================== */

export function testFileProblem(name, testDir) {
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.mjs'));
  const re = new RegExp(`path\\.join\\(\\s*ROOT,\\s*'bin',\\s*'${escapeRe(name)}(?:\\.js)?'\\s*\\)`);
  for (const f of files) {
    if (re.test(readText(path.join(testDir, f)))) return null;
  }
  return (
    `test/: no test spawns bin/${name} (no path.join(ROOT, 'bin', '${name}') anywhere under test/ — ` +
    `scripts/test.mjs discovers a new test/<name>.mjs with no wiring, but nothing exists yet)`
  );
}

/* ===================================================================== *
 * 5. README.md
 * ===================================================================== */

export function readmeProblem(name, readmeSrc) {
  const re = new RegExp('^### .*`' + escapeRe(name) + '`', 'm');
  if (re.test(readmeSrc)) return null;
  return `README.md: no ### section names ${name} — a feature is not finished here until the README says it exists`;
}

/* ===================================================================== *
 * 6 & 7. the declaration, and the classification derived from it
 * ===================================================================== */

/**
 * Checks 6 and 7, now one question asked of the tool's own file — bc-wbrhi.
 *
 * These used to be two readings of two registries' source text: `Bash(<name>:*)` appearing
 * in `DEFAULT_TOOL_LIST` meant granted, the bare name appearing anywhere in that array's
 * comments meant *decided not to grant*, and a granted name absent from `lib/grants.js`
 * meant unclassified. Both registries now derive their `b7e-*` half from the declaration
 * in each tool's header, so there is one thing to read and it is the thing that decides.
 *
 * **This is stricter than what it replaces, in the one direction that was wrong.** The old
 * "the name appears in a comment" reading could not tell a decision from a mention: a tool
 * named in passing inside somebody else's paragraph read as settled, and the `b7e-hunks`
 * paragraph in lib/tooldecl.js says so out loud — it exists partly to *make* a decision
 * that had been implied by an accidental name collision. `@grant excluded` cannot be
 * written by accident.
 *
 * Check 7 comes free and is kept as an assertion rather than dropped: `lib/grants.js`
 * spreads exactly the granted declarations, so a granted tool cannot be unclassified
 * unless the two have been wired apart — which is worth failing on rather than assuming.
 */
export function allowlistProblem(name, src, grants) {
  const [kind] = declarationsIn(src || '');
  if (!kind) {
    return (
      `bin/${name}: no @grant line in its header — dispatch cannot call ${name} at all until this is decided. ` +
      `Say '@grant read', '@grant write', or '@grant excluded' with the reason beside it (lib/tooldecl.js)`
    );
  }
  if (kind === 'excluded') return null; // a recorded decision not to grant it
  if (!KINDS.includes(kind)) {
    return `bin/${name}: @grant ${kind} is not one of ${KINDS.join(', ')} (lib/tooldecl.js)`;
  }
  if (!grants[`Bash(${name}:*)`]) {
    return `lib/grants.js: Bash(${name}:*) is on DEFAULT_TOOL_LIST and unclassified (test/grants.mjs)`;
  }
  return null;
}

/* ===================================================================== *
 * all seven, for one name
 * ===================================================================== */

export function problemsFor(name, ctx) {
  const { root, pkg, lock, readmeSrc, grants, testDir } = ctx;
  const problems = [packageJsonProblem(name, pkg), packageLockProblem(name, pkg, lock)];
  // The other five are the `b7e-*` "skill" checklist — see bin/b7e-enroll's header for why
  // the rest of bin/ (worker tools, run by absolute path with no PATH resolution, no
  // exec bit and no dedicated README section) does not owe any of them.
  if (name.startsWith('b7e-')) {
    problems.push(
      binFileProblem(name, root, pkg),
      testFileProblem(name, testDir),
      readmeProblem(name, readmeSrc),
      // The tool's own file. `binFileProblem` above has already reported a missing one,
      // so this reads it tolerantly rather than reporting the same absence twice — an
      // empty string carries no declaration, which is the honest answer for a file that
      // is not there.
      allowlistProblem(name, sourceOf(name, root, pkg), grants)
    );
  }
  return problems.filter(Boolean);
}

/**
 * Everything the seven checks read, for one tree.
 *
 * `grants` is passed in rather than imported here so that a caller can hand over a map
 * of its own — `bin/b7e-enroll` hands over the real `GRANTS`, and a suite driving a
 * fabricated `--dir` tree hands over whatever that tree should be judged against. Note
 * what check 7 is really asserting since bc-wbrhi: the two registries agree by
 * construction, so it is a property of the code doing the reading rather than of the
 * tree being read.
 */
/**
 * The classification map a given tree's `bin/` would produce, computed now.
 *
 * `lib/grants.js` spreads `B7E_GRANTS`, which `lib/tooldecl.js` derives **once, at import
 * time**, from the `bin/` beside itself. Both facts bite a tool that writes a `@grant`
 * line and then wants to report what is still owed: the imported map was built before
 * the write, so a tool it has just granted reads as unclassified, and under `--dir` it
 * was built from the wrong tree entirely. Re-deriving is the honest answer to "what does
 * this tree say now" — and re-deriving *by the same function* is what keeps it an answer
 * about the repo rather than a second opinion about it.
 */
export function derivedGrants(root) {
  const { declared } = readDeclarations(path.join(root, 'bin'));
  return Object.fromEntries(
    declared.filter((d) => d.kind !== 'excluded').map((d) => [`Bash(${d.name}:*)`, { kind: d.kind }])
  );
}

export function loadContext(root, grants = {}) {
  return {
    root,
    pkg: readJson(path.join(root, 'package.json')),
    lock: readJson(path.join(root, 'package-lock.json')),
    readmeSrc: readText(path.join(root, 'README.md')),
    grants,
    testDir: path.join(root, 'test'),
  };
}

/* ===================================================================== *
 * the applier half — the same registries, written
 * ===================================================================== */

/** The files an edit can land in, in the order b7e-register applies them. */
export const REGISTRY_FILES = Object.freeze(['package.json', 'package-lock.json', 'lib/tooldecl.js']);

const splitLines = (src) => src.split('\n');

/**
 * The `bin` map's own line range in one of the two JSON files, found textually rather
 * than by parsing: the whole point of these edits is that everything not being added
 * comes out byte-identical, and a JSON.stringify round trip reformats the file. The
 * lock's root entry is `packages[""]`, whose `bin` is the first one after the `"": {`
 * line; package.json's is the only top-level one.
 */
export function binBlockRange(lines, { lock = false } = {}) {
  let from = 0;
  if (lock) {
    const rootIdx = lines.findIndex((l) => /^\s*"":\s*\{\s*$/.test(l));
    if (rootIdx === -1) throw new Error('package-lock.json: no packages[""] entry');
    from = rootIdx;
  }
  const open = lines.findIndex((l, i) => i >= from && /^(\s*)"bin":\s*\{\s*$/.test(l));
  if (open === -1) throw new Error(`${lock ? 'package-lock.json' : 'package.json'}: no "bin" map`);
  const indent = lines[open].match(/^(\s*)/)[1];
  const closeRe = new RegExp(`^${indent}\\},?\\s*$`);
  for (let i = open + 1; i < lines.length; i += 1) {
    if (closeRe.test(lines[i])) return { open, close: i };
  }
  throw new Error('unterminated "bin" map');
}

const ENTRY_RE = /^(\s*)"([^"]+)":\s*"([^"]*)"(,?)\s*$/;

/** Every `"name": "bin/file"` line in a bin map, as `{ line, indent, key, value }`. */
export function binEntries(lines, range) {
  const out = [];
  for (let i = range.open + 1; i < range.close; i += 1) {
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) throw new Error(`unexpected line in a "bin" map: ${lines[i]}`);
    out.push({ line: i, indent: m[1], key: m[2], value: m[3] });
  }
  return out;
}

/**
 * Where a new key belongs in a bin map, and this is the rule the five sessions
 * bc-dgx7.75 was filed over each re-derived by grepping two neighbours: **alphabetical
 * within the name's own family block**, a family being everything before the first
 * dash. It is not "alphabetical in the file", because neither file is: package.json
 * lists the `beadcause-*` worker tools in the order they were written and only the
 * `b7e-*` block after them is sorted, while the lock is sorted throughout (memory note
 * package-lock-bin-order-differs-from-package-json — the key SETS match, the orders do
 * not, and npm does not rewrite either on install). Reading the family rather than the
 * whole map is what makes one rule right for both files: for a `b7e-*` name it lands
 * alphabetically among the `b7e-*` keys in each, which in the lock is also its
 * alphabetical place overall — exactly the one line `npm install --package-lock-only`
 * would have written.
 *
 * A family with no members yet appends at the end of the map, and `after` overrides the
 * lot: it puts the key directly below the named sibling, for the case where a family's
 * order means something other than the alphabet.
 */
export function insertionIndex(entries, name, { after = null } = {}) {
  if (after) {
    const at = entries.findIndex((e) => e.key === after);
    if (at === -1) return { error: `--after ${after}: no such entry in this bin map` };
    return { index: at + 1 };
  }
  const family = name.split('-')[0];
  const kin = entries.filter((e) => e.key === family || e.key.startsWith(`${family}-`));
  if (!kin.length) return { index: entries.length };
  const greater = kin.find((e) => e.key > name);
  if (greater) return { index: entries.indexOf(greater) };
  return { index: entries.indexOf(kin[kin.length - 1]) + 1 };
}

/**
 * The bin map with `name -> target` in it. Returns the source unchanged when the entry
 * is already there and already agrees; rewrites the value when it disagrees, which is
 * the shape `packageLockProblem` reports and the one thing here that is a correction
 * rather than an addition.
 */
export function insertBinKey(src, name, target, { after = null, lock = false } = {}) {
  const lines = splitLines(src);
  const range = binBlockRange(lines, { lock });
  const entries = binEntries(lines, range);
  const existing = entries.find((e) => e.key === name);
  if (existing) {
    if (existing.value === target) return src;
    lines[existing.line] = lines[existing.line].replace(`"${existing.value}"`, `"${target}"`);
    return lines.join('\n');
  }
  const where = insertionIndex(entries, name, { after });
  if (where.error) throw new Error(where.error);
  const indent = entries.length ? entries[0].indent : `${lines[range.open].match(/^(\s*)/)[1]}  `;
  const at = where.index === entries.length ? range.close : entries[where.index].line;
  lines.splice(at, 0, `${indent}"${name}": "${target}",`);
  // Commas last, over the whole block: an insertion at the end makes the previously-last
  // line need one, and an insertion anywhere makes the new line need one. Rewriting every
  // entry's comma from its position is the only version of this with no special case.
  const rewritten = binEntries(lines, binBlockRange(lines, { lock }));
  rewritten.forEach((e, i) => {
    lines[e.line] = `${e.indent}"${e.key}": "${e.value}"${i === rewritten.length - 1 ? '' : ','}`;
  });
  return lines.join('\n');
}

/** One wrapped comment paragraph, at the width the rest of the file is written to. */
export function wrapComment(text, prefix = '  // ', width = 98) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && `${prefix + cur} ${w}`.length > width) {
      lines.push(prefix + cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(prefix + cur);
  return lines;
}

/**
 * The tool's own file with its `@grant` line in it — check 6, and since bc-wbrhi the one
 * edit that decides both derived registries at once.
 *
 * Written in the house form the other eighty-eight are in: the reason as a short
 * paragraph at the end of the header docblock, a blank comment line, then the
 * declaration on a line of its own. `lib/tooldecl.js`'s `GRANT_RE` allows only comment
 * furniture before `@grant` and refuses a file that declares twice, so this returns the
 * source untouched when there is already a declaration rather than adding a second one.
 */
export function insertGrantLine(src, kind, why) {
  if (declarationsIn(src).length) return src;
  const lines = splitLines(src);
  const open = lines.findIndex((l) => /^\/\*\*/.test(l));
  if (open === -1) throw new Error('no /** header docblock to declare in');
  const close = lines.findIndex((l, i) => i > open && /^\s*\*\/\s*$/.test(l));
  if (close === -1) throw new Error('unterminated header docblock');
  const block = [' *', ...wrapComment(why, ' * ', 96), ' *', ` * @grant ${kind}`];
  lines.splice(close, 0, ...block);
  return lines.join('\n');
}

/**
 * lib/tooldecl.js with the paragraph arguing for this grant appended to the sixty-three
 * already there.
 *
 * Nothing checks for it — bc-wbrhi's own check is the `@grant` line, not the prose — but
 * every one of the others has one, and for an excluded tool the paragraph is the only
 * place the argument exists at all. Appended at the end, which is where the run has
 * always grown (the b7e-recard block is last because it was added last) and is the
 * same take-both-sides conflict every other branch in flight resolves there.
 *
 * A granted tool's block is followed by the `→` line bc-wbrhi added when it moved this
 * run out of `lib/toolbelt.js`, saying where the entry now comes from; an excluded one
 * has no entry to point at and gets none.
 */
export function insertArgumentParagraph(src, name, kind, why) {
  if (new RegExp(`bin/${escapeRe(name)}\\b`).test(src)) return src;
  const body = kind === 'excluded' ? `${name} is deliberately NOT on this list. ${why}` : String(why);
  const block = wrapComment(`${body} See bin/${name}.`);
  if (kind !== 'excluded') {
    block.push(`  //   → Bash(${name}:*) — declared \`@grant ${kind}\` in bin/${name}`);
  }
  return `${src.replace(/\n+$/, '')}\n\n${block.join('\n')}\n`;
}

/**
 * Every edit the registries need for one command, as `{ rel, before, after }` — computed
 * against what is on disk and applied by the caller, so `--dry-run` and a real run
 * differ only in whether the result is written. An already-registered name yields an
 * empty array, which is what makes the command safe to re-run.
 */
export function registerEdits(root, name, { kind, why, after = null, target = null } = {}) {
  const rel = target || `bin/${name}`;
  const files = [
    ['package.json', (src) => insertBinKey(src, name, rel, { after })],
    ['package-lock.json', (src) => insertBinKey(src, name, rel, { after, lock: true })],
    [rel, (src) => insertGrantLine(src, kind, why)],
    ['lib/tooldecl.js', (src) => insertArgumentParagraph(src, name, kind, why)],
  ];
  const edits = [];
  for (const [f, apply] of files) {
    const before = readText(path.join(root, f));
    let next;
    try {
      next = apply(before);
    } catch (err) {
      throw new Error(`${f}: ${err.message}`);
    }
    if (next !== before) edits.push({ rel: f, before, after: next });
  }
  return edits;
}

/**
 * A unified diff of one edit. Every edit here is a single contiguous region — an
 * insertion, or one line's value rewritten — so trimming the common prefix and suffix
 * finds it exactly, with no diff algorithm needed and no chance of a hunk that does not
 * apply.
 */
export function unifiedDiff(rel, before, after, context = 3) {
  if (before === after) return '';
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  const aTo = a.length - tail;
  const bTo = b.length - tail;
  const ctxStart = Math.max(0, head - context);
  const ctxEndA = Math.min(a.length, aTo + context);
  const ctxEndB = Math.min(b.length, bTo + context);
  const out = [`--- a/${rel}`, `+++ b/${rel}`];
  out.push(`@@ -${ctxStart + 1},${ctxEndA - ctxStart} +${ctxStart + 1},${ctxEndB - ctxStart} @@`);
  for (let i = ctxStart; i < head; i += 1) out.push(` ${a[i]}`);
  for (let i = head; i < aTo; i += 1) out.push(`-${a[i]}`);
  for (let i = head; i < bTo; i += 1) out.push(`+${b[i]}`);
  for (let i = aTo; i < ctxEndA; i += 1) out.push(` ${a[i]}`);
  return `${out.join('\n')}\n`;
}

export function applyEdits(root, edits) {
  for (const e of edits) fs.writeFileSync(path.join(root, e.rel), e.after);
}
