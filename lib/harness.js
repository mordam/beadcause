/**
 * The house test harness, computed from `test/` rather than written down.
 *
 * There is a shape every suite in this repo has — a shebang, a docblock whose first
 * indented lines are how you run it, a `HERE`/`ROOT`/`LIB` preamble, a `check`/`ok`/`bad`
 * helper, and an ending that counts what passed — and until this file existed it was
 * written down nowhere. So every session that wrote a suite went and read a neighbouring
 * one to copy it: bc-zjab.2 read five ranges across three files before it could write
 * test/plandispatch.mjs, bc-bmry.3 read three across two before test/relay.mjs, bc-arf8
 * two before test/redbase.mjs. A different neighbour each time, and a different answer
 * each time — which is the actual cost, because "the house shape" then means whatever the
 * last person happened to open.
 *
 * **Nothing here is a template.** A hard-coded skeleton would be a second source of truth
 * for a shape with four hundred witnesses, and it would be wrong the first time the
 * convention moved — and *right-looking* for months afterwards. Every line this module emits
 * is voted for by the suites already in `test/`: each is decomposed into the same seven
 * slots, and the shape of a kind is the slot-by-slot majority among the suites of that kind.
 * If the repo changes how it opens a suite, the output changes with it.
 *
 * The vote happens twice, over two different things, and `roleOf` is the seam: a majority of
 * a kind decides **which bindings a suite of this kind has**, and a plurality of the suites
 * that have each one decides **how it is written**. Counting exact text alone answers the
 * wrong question — 232 lib suites agree almost unanimously that a suite opens with a `ROOT`
 * and disagree a dozen ways about how to spell it.
 *
 * ## The four kinds
 *
 * Which preamble you want is decided entirely by what you are testing, and there are four
 * answers, which `classifySuite` reads off an existing suite the same way:
 *
 * - **`lib`** — a pure export out of `lib/`. The default, and the largest group.
 * - **`app`** — a function lifted out of `public/app.js` and run in a `vm`. That file is
 *   one IIFE with nothing exported, so a renderer is sliced out by brace-matching; the
 *   `lift` helper that does it is byte-identical in every suite that has one, which is
 *   exactly the sort of thing a majority vote finds without being told.
 * - **`tick`** — an advocate tick driven against a fake tracker, with `open` injected so a
 *   tick that would have opened an iTerm window pushes a bead id onto an array instead.
 * - **`bin`** — a command under `bin/` driven end to end as a subprocess.
 *
 * ## What the `app` kind owes that the others do not
 *
 * A function lifted out of `public/app.js` is lifted by *several suites at once*, because
 * each one lists the renderer under test **and every function it calls**. Add a call to a
 * new helper and those suites die with `<name> is not defined` from inside the vm — a file
 * you did not touch, and quite possibly one another session is editing. bc-bmry.4 found
 * its three (`p0card.mjs`, `p0bead.mjs`, `p0start.mjs`) only by watching 26 of 55
 * assertions fail. `appSymbolReport` answers that question before the suite is written: it
 * finds the symbol's **direct** callers in `public/app.js` and names every suite whose lift
 * list holds one of them, with the exact opener string each will need. Direct only — see
 * `appCallers` for why the transitive version is both useless here and wrong.
 *
 * ## Why the output has to run
 *
 * The acceptance for this is that the emitted file runs green with zero assertions before
 * anything is added to it — otherwise the first thing a session does with it is debug it,
 * which is the cost it was meant to remove. A pure majority vote does not guarantee that:
 * a slot can win on its own and reference a binding that lost. So `renderSkeleton` finishes
 * with a completion pass — anything the assembled file names but never binds is looked up in
 * the corpus and its commonest declaration pulled in. The declarations are still the repo's
 * own text; the pass only decides which of them are owed, and it is bounded twice over so
 * that a shape it cannot complete is *reported* rather than papered over.
 */
import fs from 'node:fs';
import path from 'node:path';
import { blankComments } from './evidence.js';

export const KINDS = ['lib', 'app', 'tick', 'bin'];

/** What each kind is, in one line — printed by `--kinds` and in the generated docblock. */
export const KIND_BLURB = {
  lib: 'a pure export out of lib/, imported and called directly',
  app: 'a function lifted out of public/app.js and run in a node:vm',
  tick: 'an advocate tick driven against a fake tracker, with `open` injected',
  bin: 'a command under bin/ driven end to end as a subprocess',
};

/* --------------------------------------------------------------- the corpus */

/**
 * Which of the four kinds a suite is, read off its source.
 *
 * Ordered, not scored, and the order is the point: a suite that lifts out of
 * `public/app.js` *and* spawns a bin is an app suite, because the lifting is what decides
 * its preamble. The last branch is a default rather than a test, so every suite lands
 * somewhere and the corpus has no unclassified tail.
 */
export function classifySuite(source) {
  const code = blankComments(String(source));
  // The app marker is read off the *code alone*, strings blanked as well as comments,
  // because it is a call rather than a name: `lift(APP, '…')` survives the blanking but a
  // suite that merely quotes that call inside an assertion does not. This file's own suite
  // is the case — it asserts on the exact opener string, and read the lenient way it
  // classified itself as an app suite and joined the corpus it was measuring.
  //
  // The other two markers are module names, which live in strings by construction, so they
  // are read off the comment-blanked copy instead. Same rule, opposite consequence.
  //
  // And the marker is the lifting, not the mention: a suite that merely reads public/app.js
  // as text is a static read and wants a lib preamble. Widening this to `public/app.js`
  // doubles the group with suites that share none of its shape, and `lift` — the one helper
  // that kind cannot do without — then loses its majority to them.
  if (/\blift\(\s*APP\s*,/.test(blankLiterals(code))) return 'app';
  if (/advocate\.js/.test(code) && /\btick\(/.test(code)) return 'tick';
  if (/(execFileSync|spawnSync|execFile\(|spawn\(|fork\()/.test(code) && /(['"]bin['"]|\/bin\/)/.test(code)) return 'bin';
  return 'lib';
}

/** Every suite under `test/`, read once, classified, with its own name noted. */
export function readSuites(root) {
  const dir = path.join(root, 'test');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .map((file) => {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      return { file, stem: file.replace(/\.mjs$/, ''), source, kind: classifySuite(source) };
    });
}

/* ------------------------------------------------------------ decomposition */

const NAME_TOKEN = '@@NAME@@';

/** The suite's own name written out of a line, so two suites can vote for one text. */
function generalise(line, stem) {
  if (!stem) return line;
  return line.split(stem).join(NAME_TOKEN);
}

/** …and written back in, when the shape is rendered for a suite that has a name again. */
export function specialise(text, stem) {
  return text.split(NAME_TOKEN).join(stem);
}

/**
 * String and template contents blanked too, on top of `blankComments`.
 *
 * Only the bracket counting below reads this, and it reads it because of one escape: a
 * suite that prints in colour writes `\x1b[32m`, which is an unmatched `[` inside a string.
 * Counting it opens a bracket that never closes, so the statement after it never ends and
 * the whole file collapses into one — which is exactly what happened, silently, to 241 of
 * the 411 suites before this existed. Template holes are blanked with everything else,
 * which is sound for this purpose because a hole is balanced by construction.
 */
export function blankLiterals(code) {
  let out = '';
  let i = 0;
  let last = '';
  const pad = (ch) => (ch === '\n' ? '\n' : ' ');
  // Where a `/` can begin a regex rather than divide. Needed for the same reason as the
  // escape above and it bites harder: `/[&<>"']/g` holds a lone double quote, so a scanner
  // that does not know it is a regex opens a string there and blanks the next forty lines
  // of real code. `blankComments` has already removed every `//` and `/*`, so a slash that
  // survives to here is one of exactly these two things.
  const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>']);
  const REGEX_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|of|in|do|else|await|yield)$/;
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && (REGEX_AFTER.has(last) || REGEX_KEYWORD.test(out.trimEnd()))) {
      out += '/';
      i += 1;
      let klass = false;
      while (i < code.length) {
        const d = code[i];
        if (d === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (d === '[') klass = true;
        else if (d === ']') klass = false;
        else if (d === '/' && !klass) break;
        else if (d === '\n') break;
        out += ' ';
        i += 1;
      }
      if (code[i] === '/') {
        out += '/';
        i += 1;
      }
      last = '/';
      continue;
    }
    if (c === "'" || c === '"') {
      out += c;
      i += 1;
      while (i < code.length && code[i] !== c) {
        if (code[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += pad(code[i]);
        i += 1;
      }
      if (i < code.length) out += c;
      i += 1;
      last = c;
      continue;
    }
    if (c === '`') {
      out += '`';
      i += 1;
      let holes = 0;
      let brace = 0;
      while (i < code.length) {
        const d = code[i];
        if (d === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (d === '$' && code[i + 1] === '{') {
          holes += 1;
          out += '  ';
          i += 2;
          continue;
        }
        if (holes > 0 && d === '{') brace += 1;
        else if (holes > 0 && d === '}') {
          if (brace > 0) brace -= 1;
          else holes -= 1;
        } else if (d === '`' && holes === 0) break;
        out += pad(d);
        i += 1;
      }
      if (i < code.length) out += '`';
      i += 1;
      last = '`';
      continue;
    }
    out += c;
    if (c.trim()) last = c;
    i += 1;
  }
  return out;
}

/**
 * Split a source into top-level statements, each `{ text, start, end }` over whole lines.
 *
 * Line-based and depth-counted over the blanked copy, which is enough here and nothing like
 * a parser: every suite in this corpus writes its top level one statement per line-run with
 * the continuation indented, so a statement ends at the first line that closes every bracket
 * it opened. A file that did something stranger would produce one enormous statement and
 * simply lose its vote, which is the safe direction.
 */
export function statements(source) {
  const lines = source.split('\n');
  const code = blankLiterals(blankComments(source)).split('\n');
  const out = [];
  let depth = 0;
  let start = null;
  for (let i = 0; i < lines.length; i += 1) {
    const bare = code[i] ?? '';
    if (start === null) {
      if (bare.trim() === '') continue;
      start = i;
    }
    for (const ch of bare) {
      if (ch === '{' || ch === '(' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    }
    if (depth <= 0) {
      depth = 0;
      out.push({ text: lines.slice(start, i + 1).join('\n'), start, end: i });
      start = null;
    }
  }
  if (start !== null) out.push({ text: lines.slice(start).join('\n'), start, end: lines.length - 1 });
  return out;
}

const HARNESS_MEMBER = /^(let (failures|ran|passed)\b|const (check|ok|bad|fail|pass) =|(async )?function (check|ok|bad)\()/;
const ENDING_MEMBER = /^(console\.(log|error)\(|process\.exit\(|await [A-Za-z_$][\w$]*\(|fs\.rm|if \(!?failures\))/;
const DECLARES = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^(?:async )?function\s+([A-Za-z_$][\w$]*)/;

/**
 * The slots of one suite: the same seven questions asked of every file in the corpus.
 *
 * `run` is the *first* indented block of the docblock, which is where every suite here puts
 * the two lines saying how to run it — and only the first, because a docblock that argues in
 * bullets indents those too and they are argument rather than shape. `preamble` is everything
 * between the imports and the counters. `helpers` are top-level function declarations below
 * the harness, which is how `lift` is found without being named.
 */
export function slotsOf(source, stem) {
  const lines = source.split('\n');
  const shebang = lines[0]?.startsWith('#!') ? lines[0] : null;

  // The run lines are an indented block inside the docblock — but so is every bullet
  // continuation, and half the docblocks in this repo argue in bullets before they say how
  // to run the file. The block is picked by what is in it rather than by where it is, and
  // the test is that it **names the suite itself**: a run line is a command you could type,
  // and the command names the file. That needs no list of command words, which matters —
  // a list would be one more thing written down here rather than read off the corpus, and
  // it is exactly what made this answer `npm test` for a corpus that says `yarn verify`.
  const names = (l) => l.includes(NAME_TOKEN);
  const run = [];
  let block = [];
  for (const line of lines) {
    if (line === ' */') break;
    if (/^ \* {4,}\S/.test(line)) block.push(generalise(line, stem));
    else if (block.some(names)) break;
    else block = [];
  }
  if (block.some(names)) run.push(...block);

  const sts = statements(source);
  const isImport = (s) => /^import[ {*]/.test(s.text);
  const imports = sts.filter(isImport).map((s) => generalise(s.text, stem));

  const harnessAt = sts.findIndex((s) => HARNESS_MEMBER.test(s.text));
  const lastImport = sts.map(isImport).lastIndexOf(true);
  const preamble = sts
    .slice(lastImport + 1, harnessAt === -1 ? sts.length : harnessAt)
    .map((s) => generalise(s.text, stem));

  const harness = [];
  const bound = new Set();
  if (harnessAt > -1) {
    for (let i = harnessAt; i < sts.length; i += 1) {
      if (!HARNESS_MEMBER.test(sts[i].text)) break;
      const d = DECLARES.exec(sts[i].text);
      if (d) bound.add(d[1] || d[2]);
      harness.push(generalise(sts[i].text, stem));
    }
  }

  // Walking back from the last line, the ending is everything that tears down and counts.
  // It stops at the first `check(...)` call rather than at a list of allowed statements,
  // because `await check(…)` and `await cleanupTmp(tmp)` are the same shape and only the
  // suite's own harness bindings tell them apart.
  const ending = [];
  for (let i = sts.length - 1; i >= 0; i -= 1) {
    const call = /^(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(sts[i].text);
    if (call && bound.has(call[1])) break;
    if (!ENDING_MEMBER.test(sts[i].text)) break;
    ending.unshift(generalise(sts[i].text, stem));
  }

  // Below the harness, the declarations rather than the checks. This is how `lift` and the
  // `APP` it reads are found for the app kind without either being named here: they are
  // simply the two things most app suites declare in that position.
  const body = sts.slice(harnessAt === -1 ? 0 : harnessAt + harness.length, sts.length - ending.length);
  const helpers = body.filter((s) => DECLARES.test(s.text)).map((s) => generalise(s.text, stem));

  return { shebang, run, imports, preamble, harness, ending, helpers };
}

/* ------------------------------------------------------------------- voting */

/**
 * How much of a kind has to write something for it to be part of that kind's shape.
 *
 * Not half, and the difference is not a rounding preference. Rank what the 232 lib suites
 * declare and there is a plateau — `HERE` 192, `tmp` 129, `LIB` 115, `ROOT` 112, the two
 * config-dir lines 100 and 98 — and then a cliff to 53. That plateau *is* the preamble;
 * `LIB` and `ROOT` sit one and four suites below half, so a strict majority cuts the middle
 * out of it and emits a `LIB`-less lib suite. Two fifths clears the plateau and leaves the
 * cliff well below, in every one of the four kinds.
 */
const MOST = 0.4;

function tally(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

/** The most common value, ties broken by the text so the answer never depends on order. */
function modal(values) {
  let best = null;
  let bestN = 0;
  for (const [v, n] of tally(values)) {
    if (n > bestN || (n === bestN && best !== null && v < best)) {
      best = v;
      bestN = n;
    }
  }
  return best === null ? null : { value: best, count: bestN };
}

/**
 * What a statement *is*, for voting: the binding it makes, or the call it is.
 *
 * Voting on exact text answers the wrong question. Two hundred suites agree almost
 * unanimously that a lib suite opens with a `ROOT`, and disagree about a dozen ways on how
 * to spell it; count the spellings and `ROOT` loses a majority it plainly has. So the vote
 * happens twice, over two different things — a majority of the suites decides **which
 * bindings a suite of this kind has**, and a plurality of the suites that have each one
 * decides **how it is written**. That is the sense in which the output is the majority
 * shape rather than any one file's.
 */
export function roleOf(text) {
  const imp = /^import[ {*]/.test(text) && /from\s+(['"])([^'"]+)\1/.exec(text);
  if (imp) return `import ${imp[2]}`;
  const decl =
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(text) || /^(?:async )?function\s+([A-Za-z_$][\w$]*)/.exec(text);
  if (decl) return `bind ${decl[1]}`;
  const call = /^(await\s+)?([A-Za-z_$][\w$.]*)\s*\(/.exec(text);
  if (call) return `call ${call[2]}`;
  const head = /^(if|for|while|switch|try)\b/.exec(text);
  if (head) return `${head[1]} ${text.split('\n')[0].trim()}`;
  return `text ${text}`;
}

/**
 * The roles a majority of these suites fill, each written the way most of them write it.
 *
 * Position is the mean index among the suites that have the role, which is what keeps
 * `import fs` above `import path` without anything being told the order: nearly every suite
 * writes them the same way round, so the means separate.
 */
function majorityByRole(lists, n, { threshold = MOST } = {}) {
  const seen = new Map();
  for (const list of lists) {
    const once = new Set();
    list.forEach((text, i) => {
      const role = roleOf(text);
      const e = seen.get(role) || { count: 0, positions: 0, texts: [] };
      if (!once.has(role)) {
        e.count += 1;
        e.positions += i;
        once.add(role);
      }
      e.texts.push(text);
      seen.set(role, e);
    });
  }
  return [...seen.entries()]
    .filter(([, e]) => agreed(e, threshold, n))
    .sort((a, b) => a[1].positions / a[1].count - b[1].positions / b[1].count || (a[0] < b[0] ? -1 : 1))
    .map(([, e]) => modal(e.texts).value);
}

/**
 * Both halves of the vote have to carry: the role, and the spelling of it.
 *
 * A role most of a kind fills, but which every one of them writes differently, has no house
 * shape to print — emitting one suite's private version of it would be the copying this
 * command exists to stop, dressed up as a majority. So the modal text needs a second suite
 * behind it before it is anybody's shape.
 */
function agreed(entry, threshold, n) {
  return entry.count > threshold * n && (modal(entry.texts)?.count ?? 0) >= 2;
}

/** The whole-block slots: a block wins only if at least half the kind writes one at all. */
function majorityBlock(values, n) {
  const present = values.filter(Boolean);
  if (present.length * 2 < n) return null;
  return modal(present)?.value ?? null;
}

/**
 * The declarations, voted once and *then* placed — above the harness or below it.
 *
 * Because a suite may declare the same thing on either side of its `check` helper, and
 * counting the two positions as two roles splits the support of anything written in both —
 * which is how `lift`, the one helper an app suite cannot do without, once fell out of the
 * app shape entirely. Support is counted per suite across both sections; where it then goes
 * is the side most of them put it.
 */
function majorityPlaced(perSuite, n, { threshold = MOST } = {}) {
  const seen = new Map();
  for (const { preamble, helpers } of perSuite) {
    const once = new Set();
    for (const [where, list] of [
      ['preamble', preamble],
      ['helpers', helpers],
    ]) {
      list.forEach((text, i) => {
        const role = roleOf(text);
        const e = seen.get(role) || { count: 0, positions: 0, texts: [], where: [] };
        if (!once.has(role)) {
          e.count += 1;
          e.positions += i;
          once.add(role);
        }
        e.texts.push(text);
        e.where.push(where);
        seen.set(role, e);
      });
    }
  }
  const won = [...seen.entries()]
    .filter(([, e]) => agreed(e, threshold, n))
    .sort((a, b) => a[1].positions / a[1].count - b[1].positions / b[1].count || (a[0] < b[0] ? -1 : 1));
  return {
    preamble: won.filter(([, e]) => modal(e.where).value === 'preamble').map(([, e]) => modal(e.texts).value),
    helpers: won.filter(([, e]) => modal(e.where).value === 'helpers').map(([, e]) => modal(e.texts).value),
  };
}

/**
 * The house shape for one kind — every slot decided separately, by the suites of that kind.
 *
 * A kind with too few suites to have a majority of its own falls back to the whole corpus
 * rather than emitting something one file happened to do; `basis` says which happened, so
 * a caller can print it instead of implying more agreement than there was.
 */
export function deriveShape(suites, kind, { minimum = 8 } = {}) {
  const own = suites.filter((s) => s.kind === kind);
  const from = own.length >= minimum ? own : suites;
  const slots = from.map((s) => slotsOf(s.source, s.stem));
  const n = slots.length;
  const placed = majorityPlaced(slots, n);
  const ending = majorityByRole(
    slots.map((s) => s.ending),
    n
  );

  // One coherence rule the vote cannot reach on its own: a scratch directory that is made
  // and never removed is a suite that litters `os.tmpdir()` every time it runs, and the two
  // halves are decided by two independent votes that can disagree. So if `tmp` is created
  // and nothing in the ending mentions it, the corpus's own commonest teardown is added.
  // Which line that is stays derived — `cleanupTmp`, `removeTree` and a bare `fs.rmSync` are
  // all in use here and this does not pick between them.
  const makesTmp = [...placed.preamble, ...placed.helpers].some((t) => /^const tmp = /.test(t));
  if (makesTmp && !ending.some((t) => /\btmp\b/.test(t))) {
    const teardowns = slots.flatMap((s) => s.ending.filter((t) => /\btmp\b/.test(t) && !/^console\./.test(t)));
    const teardown = modal(teardowns)?.value;
    if (teardown) ending.unshift(teardown);
  }

  return {
    kind,
    basis: own.length >= minimum ? 'kind' : 'corpus',
    sampleSize: n,
    kindSize: own.length,
    shebang: majorityBlock(
      slots.map((s) => s.shebang),
      n
    ),
    run: majorityByRole(
      slots.map((s) => s.run),
      n
    ),
    imports: majorityByRole(
      slots.map((s) => s.imports),
      n
    ),
    preamble: placed.preamble,
    harness: majorityByRole(
      slots.map((s) => s.harness),
      n
    ),
    helpers: placed.helpers,
    ending,
  };
}

/** The shape of one named suite, for `--like` — the same slots, with no vote at all. */
export function shapeOf(suite) {
  const s = slotsOf(suite.source, suite.stem);
  return {
    kind: suite.kind,
    basis: 'like',
    like: suite.file,
    sampleSize: 1,
    kindSize: 1,
    shebang: s.shebang,
    run: s.run,
    imports: s.imports,
    preamble: s.preamble,
    harness: s.harness,
    helpers: s.helpers,
    ending: s.ending,
  };
}

/**
 * The suites of a kind that most nearly are the shape — what to read when you want more.
 *
 * Scored by how many of the derived lines a suite actually has, so the seeds are the ones
 * the vote was won on rather than the ones somebody remembered.
 */
export function seedSuites(suites, shape, limit = 3) {
  const own = suites.filter((s) => s.kind === shape.kind);
  const want = [...shape.imports, ...shape.preamble, ...shape.harness, ...shape.ending];
  return own
    .map((s) => {
      const slots = slotsOf(s.source, s.stem);
      const have = new Set([...slots.imports, ...slots.preamble, ...slots.harness, ...slots.ending]);
      return { file: s.file, score: want.filter((w) => have.has(w)).length };
    })
    .sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1))
    .slice(0, limit);
}

/* ---------------------------------------------- the app kind's extra answer */

const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export',
  'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null',
  'of', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
  'with', 'yield', 'async', 'static', 'get', 'set',
]);

/**
 * Every top-level declaration inside `public/app.js`'s IIFE, with the span it occupies.
 *
 * Two shapes, because the file has two: `function name(args) {` ends at its balanced
 * closing brace, and `const name = (` ends at the first semicolon outside every bracket.
 * That is the same split `lift` makes, and for the same reason — brace-matching alone
 * truncates a `const esc = (…) => …;` one-liner at its object literal.
 */
/**
 * The exact string a `lift(APP, …)` call has to be given for this declaration.
 *
 * `lift` finds its target with `indexOf`, so the opener is a literal prefix and not a
 * pattern: a function is named with its whole parameter list (`'function p0RowHtml(card,
 * row)'`) and an arrow with everything up to the bracket (`'const esc = ('`) or, where there
 * is no bracket, up to and including the space after the equals (`'const STATUS_LABEL = '`).
 * Getting it wrong fails loudly — `public/app.js no longer declares …` — which is why this
 * is computed from the file rather than typed out.
 */
function liftOpener(code, at, isFunction) {
  if (isFunction) {
    let depth = 0;
    for (let i = code.indexOf('(', at); i > -1 && i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') {
        depth -= 1;
        if (!depth) return code.slice(at, i + 1);
      }
    }
    return code.slice(at, code.indexOf('\n', at));
  }
  const eq = code.indexOf('=', at);
  const rest = code.slice(eq + 1);
  const lead = /^\s*/.exec(rest)[0];
  return code.slice(at, eq + 1 + lead.length + (rest[lead.length] === '(' ? 1 : 0));
}

export function appDeclarations(source) {
  const code = blankComments(String(source));
  const decls = [];
  const re = /^(\s*)(?:(?:async )?function ([A-Za-z_$][\w$]*)\s*\(|(?:const|let) ([A-Za-z_$][\w$]*)\s*=)/gm;
  let m;
  while ((m = re.exec(code))) {
    const name = m[2] || m[3];
    const at = m.index + m[1].length;
    let end;
    if (m[2]) {
      let depth = 0;
      end = code.length;
      for (let i = code.indexOf('{', at); i > -1 && i < code.length; i += 1) {
        if (code[i] === '{') depth += 1;
        else if (code[i] === '}') {
          depth -= 1;
          if (!depth) {
            end = i + 1;
            break;
          }
        }
      }
    } else {
      let depth = 0;
      end = code.length;
      for (let i = at; i < code.length; i += 1) {
        const c = code[i];
        if (c === '{' || c === '(' || c === '[') depth += 1;
        else if (c === '}' || c === ')' || c === ']') depth -= 1;
        else if (c === ';' && depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    decls.push({ name, at, end, body: code.slice(at, end), opener: liftOpener(code, at, Boolean(m[2])) });
  }
  return decls;
}

/**
 * Which declarations name this one in their body — and **only** the ones that name it.
 *
 * Not the transitive closure, which is the mistake worth writing down: `public/app.js` is
 * one IIFE whose renderers all reach each other eventually, so walking the call graph up
 * from any symbol reaches 581 of its 600 declarations and names three quarters of the app
 * suites. It is also the wrong question. A lift is a *textual slice* of a function's body,
 * so the only suite a new callee breaks is one that lifted a function whose text mentions
 * it — one hop, never two. A suite that lifted `F`, where `F` calls `G` and `G` calls the
 * new symbol, has an unlifted `G` and is already broken for a reason that has nothing to
 * do with this change.
 */
export function appCallers(decls, symbol) {
  const word = new RegExp(`(?<![\\w$.])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
  return decls
    .filter((d) => d.name !== symbol && word.test(d.body))
    .map((d) => d.name)
    .sort();
}

/** The `lift(APP, '…')` openers a suite lists, reduced to the names they name. */
export function liftedNames(source) {
  const code = blankComments(String(source));
  const out = new Set();
  const re = /lift\(\s*APP\s*,\s*(['"])((?:(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(code))) {
    const opener = m[2];
    const name = /^(?:async )?function\s+([A-Za-z_$][\w$]*)/.exec(opener) || /^(?:const|let)\s+([A-Za-z_$][\w$]*)/.exec(opener);
    if (name) out.add(name[1]);
  }
  return [...out];
}

/**
 * The suites a new `public/app.js` function is about to break, named before it breaks them.
 *
 * A suite is listed if its lift list holds a **direct** caller of the symbol, because that
 * caller's lifted text names something the vm has never heard of and the whole renderer
 * dies with `<name> is not defined`. Suites that already lift the symbol are listed too and
 * marked `already`, so `owed` is the actual edit list and the rest is context — a session
 * adding a *second* call to an existing helper owes the same edit in the same files, and
 * dropping a suite from the answer the moment it catches up would make this quietly wrong
 * for the next one.
 *
 * bc-bmry.4 is the case: `p0RelayHtml` is called by `p0RowHtml` alone, `p0RowHtml` is lifted
 * by four suites, and three of them had never heard of the new helper. It found them by
 * watching 26 of 55 assertions fail.
 */
export function appSymbolReport(root, symbol, suites = readSuites(root)) {
  const appPath = path.join(root, 'public', 'app.js');
  if (!fs.existsSync(appPath)) return { symbol, known: false, callers: [], suites: [], owed: [] };
  const decls = appDeclarations(fs.readFileSync(appPath, 'utf8'));
  const own = decls.find((d) => d.name === symbol);
  const known = Boolean(own);
  const openers = [own, ...appCallers(decls, symbol).map((n) => decls.find((d) => d.name === n))]
    .filter(Boolean)
    .map((d) => d.opener);
  const callers = appCallers(decls, symbol);
  const wanted = new Set([symbol, ...callers]);

  const hits = [];
  for (const s of suites) {
    const lifted = liftedNames(s.source);
    if (!lifted.length) continue;
    const via = lifted.filter((n) => wanted.has(n) && n !== symbol).sort();
    if (!via.length) continue;
    hits.push({ file: s.file, via, already: lifted.includes(symbol) });
  }
  hits.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { symbol, known, callers, openers, suites: hits, owed: hits.filter((h) => !h.already).map((h) => h.file) };
}

/* ---------------------------------------------------------------- rendering */

/**
 * Every binding the corpus knows how to declare, and the text it usually declares it with.
 *
 * This is what the completion pass spends: a slot can win the vote on its own and reference
 * something that lost, and the honest repair is the corpus's own line for the missing name
 * rather than one invented here.
 */
export function declarationIndex(suites) {
  const index = new Map();
  const add = (name, text) => {
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(text);
  };
  for (const suite of suites) {
    for (const s of statements(suite.source)) {
      const text = generalise(s.text, suite.stem);
      if (/^import[ {*]/.test(s.text)) {
        for (const name of importedNames(s.text)) add(name, text);
        continue;
      }
      const decl =
        /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(s.text) ||
        /^(?:async )?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(s.text);
      if (decl) add(decl[1], text);
    }
  }
  const best = new Map();
  for (const [name, texts] of index) {
    const ranked = [...tally(texts).entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
    best.set(name, ranked);
  }
  return best;
}

/** The bindings one `import` statement introduces — default, namespace and named alike. */
function importedNames(text) {
  const out = [];
  const head = /^import\s+([\s\S]*?)\s+from\s/.exec(text);
  if (!head) return out;
  const clause = head[1];
  const braced = /\{([\s\S]*)\}/.exec(clause);
  const before = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ');
  for (const word of before.split(/\s+/)) {
    if (/^[A-Za-z_$][\w$]*$/.test(word) && word !== 'as' && word !== 'default') out.push(word);
  }
  const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (star) out.push(star[1]);
  for (const part of (braced?.[1] ?? '').split(',')) {
    const as = /(?:as\s+)?([A-Za-z_$][\w$]*)\s*$/.exec(part.trim());
    if (as) out.push(as[1]);
  }
  return out;
}

const GLOBALS = new Set([...Object.getOwnPropertyNames(globalThis), 'console', 'process', 'globalThis', 'arguments']);

/**
 * Names the text reads and never binds — comments, strings and template bodies taken out.
 *
 * Deliberately over-eager about what counts as *bound* and under-eager about what counts as
 * *read*, because the caller acts on the answer: a name wrongly called missing gets somebody
 * else's line pasted into the file, and a name wrongly called present gets nothing, which
 * the very next `node test/<name>.mjs` reports honestly. Object keys (`{ recursive: true }`)
 * and anything after a dot are not reads at all.
 */
function undeclared(text) {
  const code = blankLiterals(blankComments(text.replace(/^#!.*/, '')));
  const bound = new Set();
  const bind = (list) => {
    for (const part of String(list).split(',')) {
      const as = /(?:as\s+)?([A-Za-z_$][\w$]*)/.exec(part.trim().replace(/[=:][\s\S]*$/, ''));
      if (as) bound.add(as[1]);
    }
  };
  for (const line of code.split('\n')) {
    if (/^import[ {*]/.test(line)) for (const n of importedNames(`${line} from 'x'`)) bound.add(n);
  }
  // Run as separate sweeps rather than one alternation: a single pattern tries its branches
  // left to right and the `function <name>` branch consumes the declaration before the
  // parameter branch can see it, so every parameter of every named function reads as a free
  // variable — which is how `lift(src, opener)` had a `const src = …` pasted in above it.
  const NAMES = [
    /(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
    /([A-Za-z_$][\w$]*)\s*=>/g,
    /for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  ];
  const LISTS = [
    /(?:const|let|var)\s*\{([^}]*)\}/g,
    /(?:const|let|var)\s*\[([^\]]*)\]/g,
    /catch\s*\(([^)]*)\)/g,
    /\(([^)]*)\)\s*=>/g,
    /function\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g,
    /function\s*\(([^)]*)\)/g,
  ];
  let m;
  for (const re of NAMES) while ((m = re.exec(code))) bound.add(m[1]);
  for (const re of LISTS) while ((m = re.exec(code))) bind(m[1]);
  const used = new Set();
  const word = /(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g;
  while ((m = word.exec(code))) {
    const w = m[1];
    if (RESERVED.has(w) || GLOBALS.has(w) || bound.has(w)) continue;
    if (code.slice(m.index + w.length).startsWith(':')) continue; // an object key, not a read
    if (/\bimport\s*$/.test(code.slice(0, m.index))) continue;
    used.add(w);
  }
  return [...used];
}

const DOC_WRAP = 92;

/** How many declarations the completion pass may pull in before it gives up and says so. */
const COMPLETION_CAP = 8;

function wrapProse(prefix, words) {
  const out = [];
  let line = prefix;
  for (const word of words.split(' ')) {
    if (line.length + word.length + 1 > DOC_WRAP && line !== prefix) {
      out.push(line);
      line = `${prefix}${word}`;
    } else line = line === prefix ? `${prefix}${word}` : `${line} ${word}`;
  }
  if (line !== prefix) out.push(line);
  return out;
}

/**
 * Assemble the shape into a file that runs.
 *
 * The order is the corpus's own: shebang, docblock, imports, preamble, harness, the shared
 * helpers that live below it, a marked-out space for the checks, and the ending. Then the
 * completion pass, which is the part that makes the acceptance true — it looks at what the
 * assembled file reads and does not declare, and pulls in the corpus's declaration for each
 * until nothing is missing or nothing more is known.
 */
export function renderSkeleton(shape, opts = {}) {
  const { stem = 'newsuite', subject = null, siblings = null, seeds = [], declarations = new Map() } = opts;
  const at = (text) => specialise(text, stem);

  const imports = shape.imports.map(at);
  const preamble = shape.preamble.map(at);
  const harness = shape.harness.map(at);
  // A binding can win in two positions at once — plenty of suites declare their fixtures
  // above the harness and plenty below it — and emitting both would be a redeclaration the
  // file cannot even parse.
  const above = new Set([...preamble, ...harness].map((t) => roleOf(t)));
  const helpers = shape.helpers.map(at).filter((t) => !above.has(roleOf(t)));
  const ending = shape.ending.map(at);

  const doc = [];
  doc.push('/**');
  doc.push(` * ${subject ? `${subject} — ` : ''}<one line saying what has to hold, and why it could stop holding>`);
  doc.push(' *');
  for (const line of shape.run.length ? shape.run.map(at) : [' *     npm test', ` *     node test/${stem}.mjs`]) doc.push(line);
  doc.push(' *');
  doc.push(
    ...wrapProse(
      ' * ',
      'Replace this paragraph with the argument: what breaks if this is wrong, how it broke ' +
        'before, and why these checks are the ones that would have caught it. Every suite in ' +
        'this repo argues rather than lists, and a suite that only lists reads as unfinished ' +
        'beside its neighbours.'
    )
  );
  doc.push(' *');
  doc.push(` * Generated by b7e-harness --kind ${shape.kind}: ${KIND_BLURB[shape.kind] ?? ''}`.trimEnd());
  if (shape.basis === 'like') doc.push(` * The shape is test/${shape.like}'s own, copied slot by slot.`);
  else
    doc.push(
      ` * The shape is the majority of ${shape.sampleSize} suite${shape.sampleSize === 1 ? '' : 's'}` +
        `${shape.basis === 'corpus' ? ' across the whole corpus (too few of this kind to vote on their own)' : ` of this kind`}.`
    );
  if (seeds.length) doc.push(` * Nearest existing suites, if you want to see one finished: ${seeds.map((s) => `test/${s.file}`).join(', ')}.`);
  if (siblings) {
    doc.push(' *');
    if (!siblings.known) {
      doc.push(
        ...wrapProse(
          ' * ',
          `SIBLING SUITES — public/app.js does not declare \`${siblings.symbol}\` yet, so nothing ` +
            'calls it and there is nothing to name. Add the function and its first call, then ask ' +
            'again: the answer is computed from who calls it, and before the call exists the ' +
            'honest answer is "unknown", not "none".'
        )
      );
    } else if (!siblings.suites.length) {
      doc.push(
        ...wrapProse(
          ' * ',
          `SIBLING SUITES — none. \`${siblings.symbol}\` is called by ` +
            `${siblings.callers.length ? siblings.callers.join(', ') : 'nothing in public/app.js'}, and no suite ` +
            'lifts any of that, so this file is the only one that has to change.'
        )
      );
    } else {
      doc.push(
        ...wrapProse(
          ' * ',
          `SIBLING SUITES — \`${siblings.symbol}\` is called by ${siblings.callers.join(', ')}, which ` +
            'other suites lift into a vm. Each lift list is the renderer AND every function it calls, ' +
            'so a list without this one dies with `' +
            siblings.symbol +
            ' is not defined` from inside the vm — a suite you did not touch. Add the lift there before ' +
            'you run anything.'
        )
      );
      for (const s of siblings.suites) {
        doc.push(` *   test/${s.file} — lifts ${s.via.join(', ')}${s.already ? '  [already lifts it]' : '  <- owed'}`);
      }
    }
  }
  doc.push(' */');

  // How you reach the thing under test, left commented so the file runs before it tests
  // anything. Which line it is depends on where the subject lives, not on the kind: a
  // command is spawned, a module is imported, a renderer is sliced out and put in a vm.
  const opening = [];
  if (siblings?.known && siblings.openers.length) {
    opening.push(
      '// The lift list is the renderer AND every function it calls, in dependency order.',
      `// vm.runInContext([${siblings.openers.map((o) => `lift(APP, '${o.replace(/\n/g, ' ')}')`).join(', ')}].join('\\n'), ctx);`
    );
  } else if (subject) {
    const rel = subject.replace(/^\.\//, '');
    const base = path.basename(rel);
    if (rel.startsWith('bin/')) {
      opening.push(
        `// const CMD = path.join(ROOT, 'bin', '${base}');`,
        "// const run = (...args) => execFileSync(process.execPath, [CMD, ...args], { encoding: 'utf8' });"
      );
    } else if (preamble.some((line) => /^const LIB = /.test(line))) {
      opening.push(`// const { /* what you are testing */ } = await import(LIB('${base}'));`);
    } else {
      opening.push(`// const { /* what you are testing */ } = await import(path.join(ROOT, '${rel}'));`);
    }
  }

  const CHECKS = [
    '/* ------------------------------------------------------------------ the checks */',
    '',
    '// Nothing yet. Write them here; the ending below counts whatever you add.',
  ];
  const DONE = '/* --------------------------------------------------------------------- done */';

  // `imports`, `preamble` and `harness` are the sections the completion pass may still grow,
  // so the file is assembled from the arrays each round rather than patched in place.
  const assemble = () => {
    const parts = [];
    // The shebang leads the docblock rather than standing apart from it: every suite in
    // the corpus writes `#!/usr/bin/env node` on the line immediately above `/**`.
    parts.push(shape.shebang ? [at(shape.shebang), ...doc] : doc);
    if (imports.length) parts.push(imports);
    if (preamble.length) parts.push(preamble);
    if (harness.length) parts.push(harness);
    if (helpers.length) parts.push(helpers);
    if (opening.length) parts.push(opening);
    parts.push(CHECKS);
    if (ending.length) parts.push([DONE, '', ...ending]);
    return `${parts.map((s) => s.join('\n')).join('\n\n')}\n`;
  };

  // The completion pass. Everything above won a vote on its own; this is what makes them
  // agree with each other.
  //
  // Two rules keep it from running away, and both were learned the expensive way — the
  // first version of this pulled in seventy declarations and produced a thousand-line file
  // made of other suites' fixtures. **A candidate is only taken if it introduces no new
  // unknown of its own**, which is what stops `const bin = path.join(tmp, …)` dragging in a
  // temp directory, a config dir and four more lines behind it; and there is a hard cap, so
  // a shape that cannot be completed says so in `missing` rather than pasting its way out.
  let text = assemble();
  const added = [];
  for (let pass = 0; pass < COMPLETION_CAP; pass += 1) {
    const before = undeclared(text);
    const missing = before.filter((n) => declarations.has(n) && !added.includes(n));
    if (!missing.length || added.length >= COMPLETION_CAP) break;
    let grew = false;
    for (const name of missing) {
      if (added.length >= COMPLETION_CAP) break;
      const seen = new Set(undeclared(text));
      const candidate = declarations
        .get(name)
        .map((t) => at(t))
        .find((t) => {
          const after = undeclared(`${text}\n${t}`);
          return !after.includes(name) && after.every((n) => seen.has(n));
        });
      if (!candidate) continue;
      added.push(name);
      grew = true;
      // A binding the harness itself reads belongs *in* the harness — `check` delegating to
      // `ok`/`bad` is the commonest case, and putting the pair up in the preamble would
      // split one three-line helper across two sections of the file.
      const inHarness = harness.findIndex((s) => undeclared(s).includes(name));
      const inPreamble = preamble.findIndex((s) => undeclared(s).includes(name));
      if (/^import[ {*]/.test(candidate)) imports.push(candidate);
      else if (inHarness > -1) harness.splice(inHarness, 0, candidate);
      else if (inPreamble > -1) preamble.splice(inPreamble, 0, candidate);
      else preamble.push(candidate);
      text = assemble();
    }
    if (!grew) break;
  }

  return { text, added, missing: undeclared(text).filter((n) => !added.includes(n)) };
}

/* --------------------------------------------------------------- the answer */

/** The suite name a `--for` implies: the file's stem, or the symbol, lowercased. */
export function suiteNameFor(target) {
  if (!target) return 'newsuite';
  const base = target.includes('/') || target.endsWith('.js') ? path.basename(target).replace(/\.[^.]+$/, '') : target;
  return base.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'newsuite';
}

/**
 * The whole answer for one request — the shape, the file, and what the app kind owes.
 *
 * One entry point so the CLI is argv parsing and printing and nothing else, and so a suite
 * can ask the same question the command does without going through a subprocess.
 */
export function harness(root, { kind, like, target, name } = {}) {
  const suites = readSuites(root);
  if (!suites.length) throw new Error(`no suites under ${path.join(root, 'test')}`);

  let shape;
  if (like) {
    const file = path.basename(like);
    const suite = suites.find((s) => s.file === file);
    if (!suite) throw new Error(`no such suite: test/${file}`);
    shape = shapeOf(suite);
  } else {
    const want = kind || 'lib';
    if (!KINDS.includes(want)) throw new Error(`unknown kind: ${want} (one of ${KINDS.join(', ')})`);
    shape = deriveShape(suites, want);
  }

  const stem = name || suiteNameFor(target);
  const looksLikeFile = Boolean(target && (target.includes('/') || /\.[cm]?js$/.test(target)));
  const subject = looksLikeFile ? target : null;
  const siblings = shape.kind === 'app' && target && !looksLikeFile ? appSymbolReport(root, target, suites) : null;
  const seeds = shape.basis === 'like' ? [] : seedSuites(suites, shape);
  const declarations = declarationIndex(suites);

  const { text, added, missing } = renderSkeleton(shape, { stem, subject, siblings, seeds, declarations });
  return { shape, stem, subject, siblings, seeds, added, missing, text, counts: countKinds(suites) };
}

/** How many suites of each kind the corpus holds — what `--kinds` prints. */
export function countKinds(suites) {
  const out = {};
  for (const kind of KINDS) out[kind] = suites.filter((s) => s.kind === kind).length;
  return out;
}
