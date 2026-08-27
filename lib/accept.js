/**
 * `b7e-accept` — the pure half: finding the runnable invocations a bead's own
 * `acceptance_criteria` field quotes, and deciding which of them are safe to run.
 * `bin/b7e-accept` is the argv shell, the printing, and the one spawn per invocation.
 *
 * bc-dgx7.93, filed by the session audit against five sessions (`bc-dgx7.81`,
 * `bc-dgx7.85`, `bc-dgx7.77`, `bc-dgx7.82`, `bc-dgx7.84`) that each copied their own
 * bead's literal `` `b7e-already time ago` ``-style invocations into `Bash` by hand, one
 * call at a time, resolving the binary a different way each session.
 *
 * ## What counts as an invocation
 *
 * Every backtick-quoted span in a criterion sentence is a *candidate*, but only a span
 * whose first token — after stripping a leading `./bin/`, `bin/` or `node bin/` — names
 * a file that actually exists at `<root>/bin/<name>` is treated as one to run. That is
 * deliberately narrower than "anything that looks like a shell command": every literal
 * invocation quoted anywhere in this family (`bc-dgx7.81`, `bc-dgx7.82`) is a `b7e-*`
 * tool, and scoping to `<root>/bin/` is the exact resolution rule `bin/b7e-run` landed
 * for `bc-dgx7.87` — never whichever copy `PATH` would find (see memory note
 * `only-an-extensionless-bin-resolves-on-path`). A quoted file path, function name or
 * comparison tool (`grep "^export function"`, in `bc-dgx7.81`'s own criteria) is not a
 * candidate, because none of those resolve against this checkout's `bin/` — it stays
 * inert prose, exactly like the sentences that quote no invocation at all.
 *
 * A candidate whose text contains an angle-bracket placeholder (`<commit before
 * dv-b5d.32 landed>`, `bc-dgx7.82`'s own case) is reported **not runnable, verbatim** —
 * never guessed at. Inventing a value for it is exactly what `bc-dgx7.82`'s own session
 * spent five calls establishing was impossible to do honestly.
 *
 * ## What counts as safe to run
 *
 * `lib/tooldecl.js` is bc-wbrhi's derived registry: every `b7e-*` file in `bin/` says
 * what it is in its own header (`@grant read`, `@grant write` or `@grant excluded`), and
 * that is now the *only* place the decision lives — `lib/grants.js`'s own `GRANTS` map
 * no longer carries a `b7e-*` entry at all. So classification here reads the resolved
 * file's own declaration directly (`declarationsIn`, the same reader `lib/tooldecl.js`
 * runs over the whole of `bin/`), rather than importing the derived list — the target
 * may be a `--dir` outside this checkout, where the derived list (computed once, over
 * *this* checkout's `bin/`, at import time) would answer for the wrong tree entirely.
 * Anything that is not declared `read` — `write`, `excluded`, undeclared, or a `bin/`
 * file with no `b7e-` prefix at all (the write-shaped infrastructure scripts:
 * `deliver.js`, `file.js`, …, none of which declare anything) — is refused, never run.
 * That is what lets `b7e-accept` itself carry `@grant read` and sit on
 * `DEFAULT_TOOL_LIST`: nothing it can be pointed at can make it write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { targetFor } from './run.js';
import { declarationsIn, KINDS } from './tooldecl.js';

/** Every backtick-quoted span in a string, in order, with the backticks stripped. */
export function backtickSpans(text) {
  const spans = [];
  const re = /`([^`]*)`/g;
  let m;
  while ((m = re.exec(String(text || '')))) spans.push(m[1]);
  return spans;
}

/**
 * Split prose into sentences, without splitting on a period inside a backtick-quoted
 * span (`dv-b5d.32`, `transcript.json`, … all carry a literal `.` that is not a sentence
 * boundary). Whitespace — including the line wraps `bd`'s own text wrapping puts in —
 * is collapsed first, so a criterion's own multi-line wrap does not fracture it.
 */
export function splitCriteria(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = [];
  let start = 0;
  let inBacktick = false;
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '`') inBacktick = !inBacktick;
    if (inBacktick || ch !== '.') continue;
    const rest = normalized.slice(i + 1);
    // A sentence boundary: end of string, or a space then the start of the next one
    // (capital letter, digit or a fresh backtick-quoted span).
    if (rest === '' || /^\s+[A-Z0-9`]/.test(rest)) {
      sentences.push(normalized.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const tail = normalized.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences.filter(Boolean);
}

/** A leading `./bin/`, `bin/` or `node bin/`/`node ./bin/` — the shapes this family's own quoted invocations use. */
const BIN_PREFIX_RE = /^(?:node\s+)?(?:\.\/)?bin\//;

/** Any `<...>` run — a placeholder standing in for a value nobody supplied. */
const PLACEHOLDER_RE = /<[^<>]+>/;

/**
 * Whether one backtick-quoted span is a candidate invocation against `root`'s own
 * `bin/` — and if so, what it would run. `null` when the span's first token does not
 * name a file that exists there (a file path, a bare identifier, a tool this checkout
 * does not carry in `bin/`).
 */
export function candidateInvocation(span, root) {
  const raw = String(span || '').trim();
  if (!raw) return null;
  const stripped = raw.replace(BIN_PREFIX_RE, '');
  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const [command, ...args] = tokens;
  const target = targetFor(root, command);
  let isFile;
  try {
    isFile = fs.statSync(target).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return null;
  return { raw, command, args, target, hasPlaceholder: PLACEHOLDER_RE.test(raw) };
}

/** The first candidate invocation in a criterion's text, or `null`. */
export function findInvocation(criterionText, root) {
  for (const span of backtickSpans(criterionText)) {
    const c = candidateInvocation(span, root);
    if (c) return c;
  }
  return null;
}

/**
 * What `target` — a resolved `bin/` file — declares itself: `{ kind, reason }`, where
 * `kind` is `'read'` only when it is genuinely safe to run and `reason` explains any
 * other verdict. Reads the file directly rather than a derived registry, so a `--dir`
 * outside this checkout is judged by its own `bin/`, not this one's.
 */
export function classifyTarget(target) {
  const name = path.basename(target);
  if (!/^b7e-/.test(name)) {
    return { kind: 'write', reason: `${name} is not a b7e-* tool and carries no @grant declaration of its own` };
  }
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return { kind: 'write', reason: `could not read ${target}: ${err.code || err.message}` };
  }
  const found = declarationsIn(text);
  if (found.length === 0) return { kind: 'write', reason: `${name} declares no @grant at all` };
  if (found.length > 1) return { kind: 'write', reason: `${name} declares @grant ${found.length} times` };
  const [kind] = found;
  if (!KINDS.includes(kind)) {
    return { kind: 'write', reason: `${name} declares @grant ${kind}, which is not one of ${KINDS.join(', ')}` };
  }
  return { kind, reason: kind === 'read' ? null : `${name} is declared @grant ${kind}, not read` };
}

/**
 * What `b7e-accept` would do about one criterion sentence — never spawns anything.
 *
 * `runnable: true` means there is exactly one thing left to do: run `invocation.target`
 * with `invocation.args` and report the exit code. Every other shape (`refused`, a
 * placeholder, no invocation at all) is a verdict already, with nothing to execute.
 */
export function planCriterion(text, root) {
  const base = { text };
  const invocation = findInvocation(text, root);
  if (!invocation) {
    return { ...base, runnable: false, refused: false, invocation: null, reason: 'no invocation found in this criterion' };
  }
  if (invocation.hasPlaceholder) {
    return {
      ...base,
      runnable: false,
      refused: false,
      invocation,
      reason: `\`${invocation.raw}\` contains a placeholder — not executable as written, not guessed at`,
    };
  }
  const { kind, reason } = classifyTarget(invocation.target);
  if (kind !== 'read') {
    return { ...base, runnable: false, refused: true, invocation, kind, reason: `refused — ${reason}` };
  }
  return { ...base, runnable: true, refused: false, invocation, kind, reason: null };
}

/**
 * The whole plan for one bead's `acceptance_criteria` text: `{ empty, criteria }`.
 * `empty` is its own field rather than `criteria: []` doing double duty — an
 * acceptance_criteria of all prose, no quoted invocation anywhere, is a real plan with
 * every criterion `runnable: false`; a bead with *nothing written* is a different,
 * bad-usage-adjacent thing `bin/b7e-accept` exits `2` over.
 */
export function planBead(acceptanceCriteria, root) {
  const trimmed = String(acceptanceCriteria || '').trim();
  if (!trimmed) return { empty: true, criteria: [] };
  return { empty: false, criteria: splitCriteria(trimmed).map((text) => planCriterion(text, root)) };
}
