/**
 * Every file, sha, branch and count a bead quotes — checked against the tree it names.
 * `bin/b7e-quoted` is the argv shell and the printing; this is the extraction and the
 * checking.
 *
 * bc-dgx7.74, filed by the session audit (`lib/sessionaudit.js`) against five sessions
 * that each discovered, by hand and one of them expensively, that their own bead's
 * literal examples had rotted between the session that wrote them down and the session
 * asked to act on them:
 *
 *   - **bc-dgx7.60** quoted four claims about `reference/deluvia.archaeo-anthro-overview.md`.
 *     The file no longer exists: it was renamed to `reference/REAL_WORLD_EVIDENCE.md`
 *     while resolving the very finding that produced the quote.
 *   - **bc-dgx7.59** quoted counts `243/50`, `86/33`, `98/23` at `-w deluvia --ref
 *     origin/main`. That ref had moved; recovering the quoted figures took a fetch, a
 *     hunt for the measuring commit and a recount at `4b0b54cd^`.
 *   - **bc-dgx7.58** said deluvia's checkout was on `atlas/public-launch`. It is on
 *     `main`, and `atlas/public-launch` has diverged from `origin/main`.
 *   - **bc-dgx7.57** said "12 checks" where discovery found 19.
 *   - **bc-khoe.67** blamed PR 584 / `e60d0b87`. Twenty minutes went into the wrong
 *     module before `git show e60d0b87 -- public/config.js` settled that the commit
 *     touches nothing the failing check exercises.
 *
 * ## The direction is the whole point
 *
 * `b7e-cites` goes **tree → beads** (every bead id this repo's source quotes, joined to
 * what the tracker now says). `b7e-claims` goes **file → prose** (every assertion made
 * about a file you are about to change). Nothing went **bead → tree**, and that is the
 * direction every one of those five sessions had to walk on foot.
 *
 * ## Four kinds of quoted thing, and only three of them can be checked
 *
 * Paths, commit shas and branch names are all answerable by git, against a named ref, in
 * one call each. **Counts are not**, and this file does not pretend otherwise. Matching
 * "243/50" to the census that produced it needs the pattern, the pathspec and the ref
 * that were in the measuring session's head, and none of that survives into the prose.
 * So a count is *surfaced with its sentence* and marked `unchecked`, with the command
 * that would settle it (`b7e-count`) named next to it. A row that says "I could not
 * check this, here is how you would" is worth having; a row that guessed would be worse
 * than nothing, because the whole failure this exists for is a plausible-looking figure
 * nobody re-measured.
 *
 * ## Extraction is deliberately conservative in one direction and not the other
 *
 * A missed artifact costs the session the hand-check it was already doing. A *wrong*
 * artifact — `origin/main` reported as a missing file, a priority number reported as a
 * rotted count — costs it trust in every other row, which is the failure that makes a
 * tool like this get switched off. So the classifiers below refuse rather than guess:
 * a slashed token with no file extension is a branch and never a path, a `refs/…` token
 * is neither, and a bare number is a count only in one of two named shapes.
 */
import { execFileSync } from 'node:child_process';

/* --------------------------------------------------------------------------- git */

function git(dir, args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** git's stdout, or `null` when it exited non-zero — for reads where "no" is an answer. */
function gitOk(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

/** The branch the checkout is actually standing on — `null` on a detached HEAD. */
export function currentBranch(dir) {
  const out = gitOk(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  return !out || out === 'HEAD' ? null : out;
}

/* -------------------------------------------------------------------- the corpus */

/**
 * Every field of a bead that can carry a quote, in the order a reader meets them.
 *
 * `acceptance_criteria` is in here and it matters most: three of the five sessions above
 * found the rot in the acceptance criteria specifically, because that is the field a
 * session reads as an instruction rather than as background. Comments are last and are
 * labelled by index, so a row can be traced back to the comment that made the claim.
 */
export function fieldsOf(issue) {
  const out = [];
  const push = (field, text) => {
    if (text && String(text).trim()) out.push({ field, text: String(text) });
  };
  push('title', issue?.title);
  push('description', issue?.description);
  push('design', issue?.design);
  push('notes', issue?.notes);
  push('acceptance', issue?.acceptance_criteria ?? issue?.acceptance);
  const comments = issue?.comments || [];
  comments.forEach((c, i) => push(`comment ${i + 1}`, typeof c === 'string' ? c : c?.text ?? c?.body));
  return out;
}

/**
 * The sentence a token sits in, trimmed to something quotable.
 *
 * Sentence rather than line: these fields are hard-wrapped prose, so the line a path
 * falls on is routinely half of the claim being made about it — the bc-dgx7.60 quote
 * that started all this is broken across two lines mid-phrase. Split on sentence
 * enders followed by whitespace, keep the one containing the offset, and cap it so a
 * paragraph with no full stop in it cannot take over the report.
 */
export function sentenceAt(text, index, { max = 200 } = {}) {
  const before = text.slice(0, index);
  const after = text.slice(index);
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n\n'), before.lastIndexOf('! '), before.lastIndexOf('? '));
  const endRel = after.search(/[.!?](?:\s|$)|\n\n/);
  const from = start === -1 ? 0 : start + 1;
  const to = endRel === -1 ? text.length : index + endRel + 1;
  const raw = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/* ---------------------------------------------------------------- classification */

/** Trailing prose punctuation and the markup a quote is usually wrapped in. */
function strip(token) {
  return token
    .replace(/^[`'"([{<]+/, '')
    .replace(/[`'"),.;:\]}>]+$/, '')
    .replace(/[.,;:]+$/, '');
}

/**
 * A path's last segment must end in a real-looking extension.
 *
 * `[A-Za-z][A-Za-z0-9]{0,7}` and not `\w+`: a numeric tail is a version (`bd 1.2.1`), a
 * date (`2026.08.25`) or a bead's dotted child suffix (`bc-dgx7.74`), and all three
 * would otherwise arrive here as files that do not exist.
 */
const EXTENSION = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * A slashed token whose every segment is a number is a ratio, not a branch.
 *
 * `243/50` is bc-dgx7.59's own census pair, written three times in one sentence, and
 * without this every one of them arrived in the BRANCHES section as a branch this
 * checkout has never heard of — three loud wrong rows above the two right ones.
 */
const RATIO = /^\d+(?:\/\d+)+$/;

/**
 * Things that are shaped like a path or a branch and are neither.
 *
 * The leading-slash rule earns its place twice over: `~/neadamthal.projects/deluvia`
 * reaches here as `/neadamthal.projects/deluvia` (the `~` is not a token character) and
 * `https://github.com/mordam/beadcause/pull/731` as `//github.com/…` (nor is the colon),
 * so neither is caught by the scheme. An absolute path names a place on a machine and a
 * URL names a page; a repo-relative tree has neither.
 */
const NOT_AN_ARTIFACT = /^(?:\/|https?:|refs\/|[a-z]+:\/\/|[A-Za-z0-9-]+\.(?:com|org|net|io|dev|ai|co)\/)/i;

/**
 * A commit sha, as written in prose: 7–40 hex characters with at least one `a-f` in it.
 *
 * The letter is the whole test. A seven-digit run of decimals is a number far more often
 * than it is an abbreviated commit, and there is no way to tell them apart afterwards —
 * a sha that happens to be all digits is missed, which costs a row, where a line number
 * reported as a missing commit costs the report's credibility.
 */
const SHA = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

/** Tokens that could be a path or a branch: no whitespace, no shell punctuation. */
const TOKEN = /[A-Za-z0-9_@.\-/]*[A-Za-z0-9_\-/][A-Za-z0-9_@.\-/]*/g;

/**
 * Words that follow a number without making it a count worth re-measuring.
 *
 * Durations and clock words, mostly: "twenty minutes went into the wrong module" is the
 * bc-khoe.67 narrative, not a census anybody should recount.
 */
const NOT_COUNTABLE = new Set([
  'minutes', 'minute', 'hours', 'hour', 'days', 'day', 'weeks', 'week', 'months', 'month',
  'years', 'year', 'seconds', 'second', 'ms', 'am', 'pm', 'and', 'or', 'to', 'of', 'in',
  'at', 'on', 'is', 'was', 'were', 'the', 'a', 'an', 'for', 'by', 'with', 'as',
]);

/**
 * `N/M` written as a pair — the census shape bc-dgx7.59 quoted three of.
 *
 * Bounded to 1–7 digits a side so a date (`2026/08/25`) and a path fragment cannot reach
 * this, and required to be surrounded by non-path characters so `lib/12/34` cannot either.
 */
const PAIR = /(?<![\w/.-])(\d{1,7})\/(\d{1,7})(?![\w/.-])/g;

/** `19 checks`, `41 call sites`, `four hundred files` is not caught and does not need to be. */
const COUNTED = /(?<![\w.\-/])(\d{1,3}(?:,\d{3})+|\d{1,7})\s+([a-z][a-z-]{1,20})/g;

/* ------------------------------------------------------------------- extraction */

/**
 * Every artifact one field's text quotes, as `{kind, value, field, sentence}`.
 *
 * Order within a field is the order they are written, and the caller dedupes across
 * fields — a path named in both the description and the acceptance criteria is one
 * artifact quoted twice, and it is checked once and reported with both sentences.
 */
export function artifactsIn(field, text) {
  const rows = [];
  const at = (kind, value, index) => rows.push({ kind, value, field, sentence: sentenceAt(text, index) });

  for (const m of text.matchAll(SHA)) at('commit', m[0], m.index);

  for (const m of text.matchAll(TOKEN)) {
    const token = strip(m[0]);
    if (!token || token.length < 3 || NOT_AN_ARTIFACT.test(token)) continue;
    // A sha already claimed by the pass above must not come back as a bare branch name.
    if (/^[0-9a-f]{7,40}$/.test(token)) continue;
    const last = token.slice(token.lastIndexOf('/') + 1);
    // A trailing `_` or `-` means the token was cut short by a character this scan does
    // not take — almost always a glob. `scripts/check_*.py` arrives as `scripts/check_`,
    // and reporting that as an absent file is a wrong row about a real directory.
    if (/[_-]$/.test(last)) continue;
    // `EXTENSION` insists on a name *before* the dot as well as a letter-led one after
    // it, so `packages[""].bin` and `test/<name>.mjs` — both of which reach here as the
    // bare fragments `.bin` and `.mjs`, the brackets and angles having ended the token —
    // are not files. A dotted bead id (`bc-dgx7.74`) and a version (`1.2.1`) fail the
    // same test on the other side of the dot.
    if (EXTENSION.test(last)) {
      at('path', token, m.index);
    } else if (token.includes('/') && !RATIO.test(token)) {
      // A slashed token with no extension is genuinely both shapes here — `bin/b7e-gate`
      // is a file (every command in this family is extensionless) and `atlas/public-launch`
      // is a branch, and nothing about the text tells them apart. So the classification is
      // deferred to `quoted()`, which asks the tree instead of guessing. See `settle`.
      at('ambiguous', token, m.index);
    } else if (/^worktree-[A-Za-z0-9][\w.-]*$/.test(token)) {
      // The one bare shape that is unmistakable in this family of repos, and worth a row
      // even when the checkout has never heard of it — "that branch is not here" is the
      // answer a session delivering onto it needs.
      at('branch', token, m.index);
    } else if (/^[A-Za-z0-9][\w.]*[-_][\w.-]*[A-Za-z0-9]$/.test(token)) {
      // Any other hyphenated word could be a branch (`mirror-of-main`) or could be
      // ordinary prose (`hard-coded`, `read-only`, `pre-canon`), and nothing in the text
      // separates them. `settle` keeps it only if the checkout actually has a ref by that
      // name, which is the one test that cannot produce a wrong row.
      at('bare', token, m.index);
    }
  }

  for (const m of text.matchAll(PAIR)) at('count', `${m[1]}/${m[2]}`, m.index);
  for (const m of text.matchAll(COUNTED)) {
    if (NOT_COUNTABLE.has(m[2])) continue;
    at('count', `${m[1]} ${m[2]}`, m.index);
  }

  return rows;
}

/** Every artifact the whole bead quotes, deduped by kind+value, sentences merged. */
export function artifactsOf(issue) {
  const byKey = new Map();
  for (const { field, text } of fieldsOf(issue)) {
    for (const row of artifactsIn(field, text)) {
      const key = `${row.kind} ${row.value}`;
      const seen = byKey.get(key);
      if (seen) {
        if (!seen.quotes.some((q) => q.field === row.field && q.sentence === row.sentence)) {
          seen.quotes.push({ field: row.field, sentence: row.sentence });
        }
      } else {
        byKey.set(key, { kind: row.kind, value: row.value, quotes: [{ field: row.field, sentence: row.sentence }] });
      }
    }
  }
  return [...byKey.values()];
}

/* ------------------------------------------------------------------ the checking */

const MAX_RENAME_HOPS = 5;

/**
 * The second, permissive rename pass — and why there has to be one.
 *
 * bc-dgx7.74's own acceptance criteria say this command must report
 * `reference/deluvia.archaeo-anthro-overview.md` as **renamed** to
 * `reference/REAL_WORLD_EVIDENCE.md`. At git's default 50% similarity it is not a rename
 * at all: the commit that did it (deluvia `7ae86887`, "retire the forked pre-canon
 * overview, keep its evidence as REAL_WORLD_EVIDENCE.md") rewrote enough of the file that
 * `--name-status` reports a plain `A` and a plain `D`. At `-M10%` git calls it `R032` —
 * a 32% match — and the commit subject confirms it. Since a rename that rewrites most of
 * the file is exactly the rename a bead's quote is most likely to have missed, the
 * permissive pass runs, and what it finds is reported as a rename **with its similarity
 * score**, so a reader can see the difference between "git is certain" and "git thinks
 * so at 32%". Second pass only, and only over the one commit that removed the file, so it
 * costs nothing on the ordinary answer.
 */
const WEAK_RENAME = '-M10%';

/** The `R<score>`/`D` entry for `name` in one commit's name-status, at a given threshold. */
function statusFor(dir, sha, name, threshold) {
  const status = gitOk(dir, ['show', '--first-parent', threshold, '--name-status', '--format=%h%x00%aI', sha]);
  if (!status) return null;
  const [header, ...lines] = status.split('\n');
  const [short, at] = header.split('\0');
  const fields = lines.map((l) => l.split('\t'));
  return {
    short,
    at: at ? at.slice(0, 10) : null,
    renamed: fields.find((f) => f[0]?.startsWith('R') && f[1] === name) || null,
    deleted: fields.find((f) => f[0] === 'D' && f[1] === name) || null,
  };
}

/**
 * Where a path that is not at `ref` went — one `R` entry at a time, up to five hops.
 *
 * `git log --follow` is the obvious reach and it answers the *other* question: it walks
 * backwards from a name that still exists. What is needed here is forwards from a name
 * that does not, so the walk is: the newest commit in `ref`'s history that touched this
 * path is the one that removed it, and that commit's own rename-detected name-status
 * says whether it was a delete or a rename and to what. Following the new name in turn
 * is what survives a file renamed twice, which `reference/` in deluvia has been.
 */
export function renameOf(dir, ref, filePath) {
  let name = filePath;
  const chain = [];
  for (let hop = 0; hop < MAX_RENAME_HOPS; hop += 1) {
    const sha = gitOk(dir, ['rev-list', '-n', '1', ref, '--', name])?.trim();
    // Nothing in this ref's whole history ever touched that name. Distinguished from
    // "it was here and went away" on purpose: the two are different findings, and the
    // first one is usually a bead quoting a path that belongs to another repo.
    if (!sha) return chain.length ? { to: name, chain } : { never: true };
    let seen = statusFor(dir, sha, name, '-M');
    if (!seen) return chain.length ? { to: name, chain } : null;
    let weak = false;
    if (!seen.renamed && seen.deleted) {
      const loose = statusFor(dir, sha, name, WEAK_RENAME);
      if (loose?.renamed) {
        seen = loose;
        weak = true;
      }
    }
    if (!seen.renamed) {
      if (seen.deleted) return { deletedIn: seen.short, at: seen.at, chain };
      return chain.length ? { to: name, chain } : null;
    }
    const similarity = Number(seen.renamed[0].slice(1)) || null;
    chain.push({ from: name, to: seen.renamed[2], commit: seen.short, at: seen.at, similarity, weak });
    name = seen.renamed[2];
    if (gitOk(dir, ['cat-file', '-e', `${ref}:${name}`]) !== null) return { to: name, chain };
  }
  return { to: name, chain, truncated: true };
}

/**
 * One path, against the tree at `ref`.
 *
 * A bare basename (`README.md`, `CHANGE_LOG.md`) is looked up across the whole tree
 * rather than at the root, because that is how prose names a file — and the answer is
 * every place it is, capped, since "present, but in three places" is a real answer and
 * silently picking one of them is how a session ends up reading the wrong file.
 */
export function checkPath(dir, ref, filePath) {
  // Asked of the ref by name first, whether or not the token has a slash in it: a bare
  // `bin` or `test` is a directory at the root and answers here, and only a name that is
  // *not* in the tree by that spelling falls through to the basename search below.
  if (gitOk(dir, ['cat-file', '-e', `${ref}:${filePath}`]) !== null) return { state: 'present', at: filePath };
  if (filePath.includes('/')) {
    const moved = renameOf(dir, ref, filePath);
    if (moved?.to) return { state: 'renamed', to: moved.to, chain: moved.chain };
    if (moved?.deletedIn) return { state: 'deleted', deletedIn: moved.deletedIn, at: moved.at };
    return { state: 'absent' };
  }
  const listed = gitOk(dir, ['ls-tree', '-r', '--name-only', ref]) || '';
  const matches = listed.split('\n').filter((p) => p && p.slice(p.lastIndexOf('/') + 1) === filePath);
  if (matches.length === 1) return { state: 'present', at: matches[0] };
  if (matches.length > 1) return { state: 'present', at: matches[0], alsoAt: matches.slice(1, 6) };
  return { state: 'absent' };
}

/**
 * One commit sha, and — the bc-khoe.67 question — whether it touches anything this bead
 * also names.
 *
 * Not "does the commit exist", which is the cheap half. The twenty minutes bc-khoe.67
 * lost went on a commit that *does* exist and is irrelevant, and the one command that
 * would have settled it was its `--stat` against the paths the bead's own failure detail
 * named. So the intersection is computed here rather than left to the reader: `touches`
 * is every path the bead quotes that this commit changed, and an empty list next to a
 * non-empty `beadPaths` is the finding.
 */
export function checkCommit(dir, sha, beadPaths = []) {
  const type = gitOk(dir, ['cat-file', '-t', sha])?.trim();
  if (type !== 'commit') return { state: type ? 'not-a-commit' : 'unknown', type: type || null };
  const header = gitOk(dir, ['show', '-s', '--format=%h%x00%s%x00%aI%x00%an', sha]) || '';
  const [short, subject, at, author] = header.trim().split('\0');
  const changed = (gitOk(dir, ['show', '--first-parent', '--name-only', '--format=', sha]) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const wanted = new Set(beadPaths);
  const touches = changed.filter((p) => wanted.has(p));
  return {
    state: 'present',
    short,
    subject,
    at: at ? at.slice(0, 10) : null,
    author,
    files: changed.length,
    touches,
    checkedAgainst: beadPaths.length,
  };
}

/**
 * One branch name, against what the checkout is actually on.
 *
 * Three states, and the middle one is the bc-dgx7.58 finding: the branch exists, the
 * checkout is not on it, and it has diverged from the branch the checkout *is* on. A
 * bead that says "deluvia's checkout is on atlas/public-launch" is not wrong because the
 * branch is missing — it is wrong because nine commits went one way and fourteen the
 * other, and a session that believed the sentence read the wrong tree.
 */
export function checkBranch(dir, name, current) {
  const tip = gitOk(dir, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])?.trim();
  if (!tip) return { state: 'unknown' };
  if (current && name === current) return { state: 'checked-out', current };
  if (!current) return { state: 'present', current: null };
  const counts = gitOk(dir, ['rev-list', '--left-right', '--count', `${current}...${name}`])?.trim();
  if (!counts) return { state: 'present', current };
  const [behindCurrent, aheadOfCurrent] = counts.split(/\s+/).map(Number);
  if (!behindCurrent && !aheadOfCurrent) return { state: 'same-commit', current };
  return { state: 'diverged', current, currentAhead: behindCurrent, branchAhead: aheadOfCurrent };
}

/** Backticked prose that is a command line rather than a thing anybody counted. */
const IS_COMMAND = /^-|^(?:git|bd|npm|node|npx|grep|ls|cd|b7e-|beadcause)\b|\s-{1,2}[A-Za-z]/;

/**
 * The literal a count row was probably measuring, for the `b7e-count` hint.
 *
 * Backticked or double-quoted, in the same sentence, and only when exactly one candidate
 * survives — two of them means guessing which one the number belongs to, and a hint
 * naming the wrong pattern is worse than a hint naming none. `git fetch` and `-w deluvia
 * --ref origin/main` are both backticked in bc-dgx7.74's own body and neither is a thing
 * that was counted, which is what `IS_COMMAND` is for; a candidate containing the count's
 * own digits is the number being quoted back at itself ("12 checks"), not its subject.
 */
export function literalNear(sentence, count = '') {
  const digits = String(count).match(/\d+/g) || [];
  const found = [...sentence.matchAll(/`([^`]{2,60})`|"([^"]{2,60})"/g)].map((m) => m[1] ?? m[2]);
  const words = [
    ...new Set(
      found.filter((s) => !/\s{2,}/.test(s) && !IS_COMMAND.test(s) && !digits.some((d) => s.includes(d)))
    ),
  ];
  return words.length === 1 ? words[0] : null;
}

/* ------------------------------------------------------------------- the report */

/**
 * Every artifact `issue` quotes, checked against `dir` at `ref`.
 *
 * Paths are checked first and their results feed the commit rows, which is the only
 * ordering constraint in here: "does this commit touch any path the bead names" needs
 * the bead's paths resolved to where they actually are, so a commit is not reported as
 * touching nothing merely because the bead quoted the pre-rename name.
 */
/**
 * Directory names that make a slashed token a path even in a tree that has no such
 * directory — the cross-repo case, which is the whole reason `-w` exists.
 *
 * `bin/b7e-base` quoted in a `bc-` bead and checked against deluvia resolves to nothing
 * on either side: deluvia has no `bin/`, and it is not a branch anywhere. Without this it
 * came back as an unknown *branch*, which is a wrong row about a real path.
 */
const SOURCE_DIRS = new Set(['lib', 'bin', 'test', 'tests', 'scripts', 'src', 'docs', 'doc', 'public', 'reference', 'android', 'ios', 'tools', 'app', 'assets', 'config', 'novel', 'compendium']);

/** A first segment that names a remote makes the rest a remote-tracking branch. */
function remotesOf(dir) {
  return new Set((gitOk(dir, ['remote']) || '').split('\n').filter(Boolean));
}

/**
 * Is this slashed, extensionless token a path, a branch, or neither? — asked of the tree
 * rather than guessed, and `null` for the tokens that are only prose.
 *
 * In order: a thing that is actually in the tree at `ref` is a path (this is how
 * `bin/b7e-gate` and every other extensionless command in this family resolves); a name
 * git will verify as a commit is a branch. When it is neither — a path the bead named
 * before it existed, a branch nobody has fetched, a sentence truncated mid-word — the tie
 * goes to the token's *first segment*: a remote makes it a branch, a source directory
 * makes it a path.
 *
 * And when none of that applies it is **dropped**, which is the important half. `ahead/
 * behind` and `read/write` are ordinary English written with a slash in it, and a report
 * that opens with two branches this checkout has never heard of is a report whose real
 * findings get read as more of the same. A slashed token earns a row only by resolving,
 * or by looking like a ref (a `-`, `_`, `.` or digit somewhere in it).
 */
function settle(dir, ref, token, topLevel, remotes, refNames, kind) {
  const bare = token.replace(/\/+$/, '');
  // A hyphenated bare word is a branch only if this checkout genuinely has one by that
  // name. Nothing else: a guess here is a row about a word.
  if (kind === 'bare') return refNames.has(bare) ? 'branch' : null;
  if (gitOk(dir, ['cat-file', '-e', `${ref}:${bare}`]) !== null) return 'path';
  if (gitOk(dir, ['rev-parse', '--verify', '--quiet', `${bare}^{commit}`])) return 'branch';
  const head = bare.split('/')[0];
  if (remotes.has(head)) return 'branch';
  if (topLevel.has(head) || SOURCE_DIRS.has(head)) return 'path';
  return /[-_.\d]/.test(bare) ? 'branch' : null;
}

export function quoted(dir, ref, issue, { workspace = null } = {}) {
  const current = currentBranch(dir);
  const raw = artifactsOf(issue);

  const topLevel = new Set((gitOk(dir, ['ls-tree', '--name-only', ref]) || '').split('\n').filter(Boolean));
  const remotes = remotesOf(dir);
  // Every ref this checkout has, in one call rather than a `rev-parse` per candidate
  // word — a bead's prose carries a hundred hyphenated words and two of them are branches.
  const refNames = new Set(
    (gitOk(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']) || '').split('\n').filter(Boolean)
  );
  // Settling can collapse two rows into one — `bin/` and `bin/b7e-gate` stay distinct,
  // but a token written both with and without its trailing slash does not, so the merge
  // is repeated here rather than only at extraction.
  const rows = [];
  for (const r of raw) {
    const settled =
      r.kind === 'ambiguous' || r.kind === 'bare'
        ? { ...r, kind: settle(dir, ref, r.value, topLevel, remotes, refNames, r.kind), value: r.value.replace(/\/+$/, '') }
        : r;
    if (!settled.kind) continue;
    const seen = rows.find((x) => x.kind === settled.kind && x.value === settled.value);
    if (!seen) rows.push(settled);
    else for (const q of settled.quotes) if (!seen.quotes.some((s) => s.field === q.field && s.sentence === q.sentence)) seen.quotes.push(q);
  }

  const paths = rows.filter((r) => r.kind === 'path').map((r) => ({ ...r, result: checkPath(dir, ref, r.value) }));
  // The commit intersection is taken against where each path *is*, not against the name
  // the bead used — a renamed path's new name is what the commit that renamed it, and
  // everything after it, actually touched.
  const beadPaths = [...new Set(paths.flatMap((p) => [p.value, p.result.at, p.result.to].filter(Boolean)))];

  // A hex run that does not resolve is reported only when it has a digit in it. Seven
  // letters drawn from `a-f` is a rare but real English word — `defaced` is one — and a
  // word reported as an unknown commit is exactly the kind of wrong row that makes a
  // reader stop believing the right ones. A digitless sha that does not resolve is
  // missed instead, which is the harmless direction.
  const commits = rows
    .filter((r) => r.kind === 'commit')
    .map((r) => ({ ...r, result: checkCommit(dir, r.value, beadPaths) }))
    .filter((r) => r.result.state === 'present' || /\d/.test(r.value));
  const branches = rows.filter((r) => r.kind === 'branch').map((r) => ({ ...r, result: checkBranch(dir, r.value, current) }));
  const counts = rows
    .filter((r) => r.kind === 'count')
    .map((r) => {
      const literal = r.quotes.map((q) => literalNear(q.sentence, r.value)).find(Boolean) || null;
      const verify = literal
        ? `b7e-count${workspace ? ` -w ${workspace}` : ''} --ref ${ref} ${JSON.stringify(literal)}`
        : null;
      return { ...r, result: { state: 'unchecked', literal, verify } };
    });

  return { bead: issue?.id || null, title: issue?.title || null, dir, ref, branch: current, workspace, paths, commits, branches, counts };
}

/**
 * The states that mean "this quote has rotted" — what `--strict` exits non-zero on.
 *
 * `unchecked` is not in here and must not be: a count nobody could check is not a
 * finding, it is the honest absence of one, and a gate that went red on every count in
 * every bead would be a gate nobody leaves on.
 */
export const ROTTED = new Set(['absent', 'deleted', 'renamed', 'unknown', 'not-a-commit', 'diverged']);

/** Every row whose state says the bead is now quoting something untrue. */
export function findings(report) {
  const rows = [...report.paths, ...report.commits, ...report.branches];
  const out = rows.filter((r) => ROTTED.has(r.result.state));
  // A commit that exists but touches none of the paths the bead names is the bc-khoe.67
  // finding, and its state is `present` — the rot is in the claim, not in the commit.
  for (const c of report.commits) {
    if (c.result.state === 'present' && c.result.checkedAgainst > 0 && !c.result.touches.length) out.push(c);
  }
  return out;
}
