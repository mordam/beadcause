/**
 * What the Node suite actually executes — per file, per function, and nothing else.
 *
 * The gates here answer pass or fail. `npm test` runs 219 suites and prints a colour;
 * `npm run checks` drives Chrome and prints another. Neither has ever been able to say
 * *how much of the code they went near*, so the question "is this change tested?" has
 * only ever had a human answer. bc-sj8k.4 wants a candidate card to show the evidence
 * behind a pull request and named coverage as the one field it could not render out of
 * what exists. This file is that field.
 *
 * ## The number on the card would not have changed a decision. The list of names does.
 *
 * bc-vriu.2 asked, before any of it was built, whether a coverage figure would actually
 * change an approve-or-decline or would just be a number on a card, and said to close
 * rather than build if the honest answer was the second. The honest answer is that it
 * depends entirely on which figure:
 *
 * - **A percentage would not.** Nobody declines a candidate at 71% and approves it at
 *   74%, and a repo-wide percentage moves by fractions when a candidate lands, so the
 *   delta is noise. It is wallpaper — a number that makes a card look rigorous while
 *   being unable to be wrong.
 * - **"nothing in the suite ever executes the file you changed" would.** That is a fact
 *   about *this* candidate, it is binary, it is exact, and it is the thing you would
 *   want to know before approving a diff by using it for ninety seconds. It is also the
 *   thing a human reviewer cannot get any other way: `git log` will not tell you, and a
 *   green gate says nothing at all, because a suite that never imports a file passes
 *   just as loudly as one that exercises every branch of it.
 *
 * So the report is a per-file, per-function list, and `coverageForFiles` — the export a
 * card calls — projects it onto the paths a candidate touches. The totals exist because
 * they are free, not because they are the point.
 *
 * ## Functions, not lines, and that is not a shortcut
 *
 * V8 hands back byte ranges, and folding those into line coverage is the ordinary thing
 * to do. It would lie here. Every file in this repo argues its case in prose before it
 * does anything — this header is a third of this file — and those comment lines sit
 * inside the module's own range, which V8 marks executed the moment anything imports the
 * file. Line coverage over this tree would therefore report roughly "how much of the
 * file is commentary", climb whenever somebody explained themselves better, and be
 * highest on the files nobody tests but everybody documents. Counting them as
 * uncovered instead is no better: a stripper accurate enough to tell a comment from a
 * template literal containing a `//` is a real parser, and getting it subtly wrong
 * produces a number that is wrong without looking wrong.
 *
 * Functions dodge all of it. V8 reports them by name with an invocation count, exactly,
 * with no interpretation: `stageInfo` in lib/prstage.js was called 0 times, and there is
 * no arrangement of comments that changes that. It is also the more useful grain — an
 * uncovered *function* has a name you can go and read, where an uncovered *line* is a
 * number you have to go and look up.
 *
 * ## A file that no suite imported at all is the strongest signal, and V8 cannot report it
 *
 * V8 only knows about scripts it compiled, so a file nothing ever imported produces no
 * entry — it is absent from the coverage output in exactly the same way a file that does
 * not exist is. Absent reads as zero to nobody. So `foldCoverage` walks `SCOPE` on disk
 * and diffs it against what V8 saw: those files come back `loaded: false`, with a null
 * function count, because V8 never parsed them and inventing a denominator for them
 * would be exactly the kind of made-up number this bead warned against.
 *
 * ## Where the report lives, and why not beside the tree it measured
 *
 * The raw V8 output stays in the checkout it was measured in (`.coverage/`, ignored) —
 * it is hundreds of megabytes and it is meaningless anywhere else. The folded report
 * goes to `CONFIG_DIR/coverage.json`, because the reader is the daemon and the daemon
 * does not know which checkout is canonical: every session runs in a worktree under
 * `.claude/worktrees/`, and a report written to a repo root is invisible from all of
 * them and gone when that worktree is retired. It is churn in the config repo's sense —
 * overwritten by every run and meaningless against any commit but the one stamped in it
 * — so it is in the ignore list in lib/commonrepo.js.
 *
 * That stamp is load-bearing rather than decorative. Coverage is a claim about one tree,
 * a full pass takes the better part of an hour, and nothing is going to re-measure per
 * candidate. So a card showing this must be able to say *when* it was measured and
 * against *what*, and `coverageForFiles` hands the commit back with every answer so the
 * card can age it rather than presenting an hour-old fact as a live one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_DIR } from './config.js';
import { writeJsonAtomic } from './atomic.js';

/**
 * The directories this measures — the two that are the daemon's own Node code.
 *
 * `public/` is deliberately out: it is browser code, `npm test` reaches it only by
 * evaluating lifted fragments in a `vm` (see test/graphsheet.mjs and its neighbours),
 * and a vm-compiled script's coverage is filed under whatever filename the vm was
 * given. What actually exercises `public/` is `npm run checks`, which drives real
 * Chrome and is not measured here at all. Reporting a number for it out of the Node
 * suite would understate it by most of its real coverage.
 *
 * `scripts/` is out for the opposite reason: it is the checks and the tooling, and it
 * is the harness rather than the thing under test.
 */
export const SCOPE = ['lib', 'bin'];

/** Where the folded report is published for the daemon to read. */
export const REPORT_PATH = path.join(CONFIG_DIR, 'coverage.json');

/** Every `.js`/`.mjs` under `SCOPE`, repo-relative and sorted. */
export function scopeFiles(root, scope = SCOPE) {
  const out = [];
  for (const dir of scope) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      out.push(`${dir}/${entry.name}`);
    }
  }
  return out.sort();
}

/**
 * Line number (1-based) for a character offset, given the offsets every line starts at.
 * Binary search, because this runs once per uncovered function across a whole tree.
 */
function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The character offset each line begins at, so `lineAt` can be a search and not a scan. */
function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

/**
 * One V8 script entry folded into named functions.
 *
 * The entry whose range spans the whole file is the module body rather than a function —
 * it is what tells us the file was imported at all — so it is taken out and reported as
 * `loaded`. Everything left is a real function; anonymous ones are labelled by where
 * they start, which is enough to find them and is honest about not having a name.
 *
 * `ranges[0]` is the function's own extent and its count is its invocation count; the
 * ranges after it are the block coverage inside it, which is deliberately not read. This
 * says whether a function ran, not which of its branches did — see the header.
 */
function foldScript(src, functions) {
  const starts = lineStarts(src);
  const out = new Map();
  let loaded = false;
  for (const fn of functions) {
    const range = fn.ranges?.[0];
    if (!range) continue;
    const whole = range.startOffset === 0 && range.endOffset >= src.length && !fn.functionName;
    if (whole) {
      if (range.count > 0) loaded = true;
      continue;
    }
    const key = `${range.startOffset}:${range.endOffset}`;
    const line = lineAt(starts, range.startOffset);
    const name = fn.functionName || `(anonymous):${line}`;
    const prev = out.get(key);
    if (prev) prev.count = Math.max(prev.count, range.count);
    else out.set(key, { name, line, count: range.count });
  }
  return { loaded, functions: [...out.values()].sort((a, b) => a.line - b.line) };
}

/**
 * Fold a directory of `NODE_V8_COVERAGE` output into one report.
 *
 * Every process the run spawned wrote its own `coverage-*.json` there — the runner, each
 * suite, and every daemon a suite started — so the same file appears many times over and
 * a function is covered if *any* of them called it. Files outside `root` (node_modules,
 * Node's own internals) are dropped, as are files outside `SCOPE`.
 *
 * Unreadable and half-written JSON is skipped rather than thrown on: a process killed by
 * a signal mid-flush leaves one, which is a normal outcome of a suite that ends by
 * killing a daemon, and losing the whole report to it would be absurd.
 */
export function foldCoverage(rawDir, { root, scope = SCOPE, commit = null } = {}) {
  const wanted = new Set(scopeFiles(root, scope));
  // V8 reports the resolved path, and macOS hands out `/var/folders/...` for a directory
  // whose real name is `/private/var/folders/...`. Comparing the two as strings silently
  // matches nothing, and a report where every file came back "never imported" is not
  // obviously wrong — it is exactly what a genuinely untested tree looks like.
  let base = root;
  try {
    base = fs.realpathSync(root);
  } catch {
    /* a root that is not there yields an empty report either way */
  }
  const seen = new Map();
  let processes = 0;
  let skipped = 0;

  const entries = fs.existsSync(rawDir)
    ? fs.readdirSync(rawDir).filter((f) => f.startsWith('coverage-') && f.endsWith('.json'))
    : [];

  for (const file of entries) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
    } catch {
      skipped += 1;
      continue;
    }
    processes += 1;
    for (const script of parsed.result || []) {
      if (!script.url?.startsWith('file://')) continue;
      let abs;
      try {
        abs = fileURLToPath(script.url);
      } catch {
        continue;
      }
      const rel = path.relative(base, abs);
      if (!wanted.has(rel)) continue;
      let src;
      try {
        src = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const folded = foldScript(src, script.functions || []);
      const prev = seen.get(rel);
      if (!prev) {
        seen.set(rel, folded);
        continue;
      }
      prev.loaded = prev.loaded || folded.loaded;
      const byName = new Map(prev.functions.map((f) => [`${f.name}:${f.line}`, f]));
      for (const fn of folded.functions) {
        const hit = byName.get(`${fn.name}:${fn.line}`);
        if (hit) hit.count = Math.max(hit.count, fn.count);
        else prev.functions.push(fn);
      }
      prev.functions.sort((a, b) => a.line - b.line);
    }
  }

  const files = [...wanted].map((rel) => {
    const folded = seen.get(rel);
    if (!folded) return { path: rel, loaded: false, functions: null, uncovered: [] };
    const uncovered = folded.functions.filter((f) => f.count === 0);
    return {
      path: rel,
      loaded: folded.loaded,
      functions: { total: folded.functions.length, covered: folded.functions.length - uncovered.length },
      uncovered: uncovered.map((f) => ({ name: f.name, line: f.line })),
    };
  });

  const measured = files.filter((f) => f.functions);
  return {
    generated: new Date().toISOString(),
    commit,
    root,
    scope,
    processes,
    unreadable: skipped,
    totals: {
      files: files.length,
      loaded: files.filter((f) => f.loaded).length,
      functions: measured.reduce((n, f) => n + f.functions.total, 0),
      covered: measured.reduce((n, f) => n + f.functions.covered, 0),
    },
    files,
  };
}

/** Publish a folded report where the daemon can read it. */
export function saveReport(report, target = REPORT_PATH) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeJsonAtomic(target, report);
  return target;
}

/** The last published report, or null — absent and unreadable are the same answer. */
export function readReport(target = REPORT_PATH) {
  try {
    const report = JSON.parse(fs.readFileSync(target, 'utf8'));
    return report && Array.isArray(report.files) ? report : null;
  } catch {
    return null;
  }
}

/**
 * The card-facing projection: what the suite covers of the files a candidate changes.
 *
 * Given the paths in a pull request's diff, this answers the one question that could
 * change an approve-or-decline — *is there anything in the suite that even runs this?* —
 * and refuses to answer anything it cannot. Paths outside `SCOPE` come back as
 * `outOfScope` rather than as zeroes, because "public/app.js is 0% covered by the Node
 * suite" is true and misleading: what covers it is `npm run checks`, which this never
 * measured.
 *
 * `untested` is the field a card should lead with. Everything else is context for it.
 */
export function coverageForFiles(report, paths) {
  const given = [...new Set((paths || []).map((p) => String(p).replace(/^\.\//, '')))].sort();
  if (!report) return { measured: false, commit: null, generated: null, files: [], untested: [], outOfScope: given };

  const scope = report.scope || SCOPE;
  const byPath = new Map(report.files.map((f) => [f.path, f]));
  const outOfScope = [];
  const files = [];

  for (const rel of given) {
    if (!scope.some((dir) => rel.startsWith(`${dir}/`))) {
      outOfScope.push(rel);
      continue;
    }
    const hit = byPath.get(rel);
    // In scope, but not in the report: added by this candidate after the measurement.
    // Unknown, and said so — it is not the same claim as "nothing ran it".
    if (!hit) files.push({ path: rel, loaded: null, functions: null, uncovered: [] });
    else files.push(hit);
  }

  return {
    measured: true,
    commit: report.commit || null,
    generated: report.generated || null,
    files,
    untested: files.filter((f) => f.loaded === false).map((f) => f.path),
    outOfScope,
  };
}

/**
 * One line for a terminal or a card byline. The totals, and the count that matters.
 *
 * Deliberately leads with the file count rather than the percentage — see the header for
 * why the percentage is the byline and not the point.
 */
export function summaryLine(report) {
  if (!report) return 'no coverage has been measured';
  const { files, loaded, functions, covered } = report.totals;
  const untested = files - loaded;
  const pct = functions ? Math.round((covered / functions) * 1000) / 10 : 0;
  const head = untested
    ? `${untested} of ${files} files are never imported by the suite`
    : `all ${files} files are imported by the suite`;
  return `${head}; ${covered}/${functions} functions executed (${pct}%)`;
}
