/**
 * Which files a bead is likely to touch — asked before anything has opened a window on it.
 *
 * lib/claims.js can already answer "is anyone on this file?", and scripts/claim-guard.sh
 * asks it at `PreToolUse`, which is one step too late to be cheap. By the time that hook
 * fires the session exists, has been briefed, has read the tree and has a plan; the
 * refusal costs a wasted tool call *by design* — refused once, with the holder named —
 * and the session that means it insists and proceeds. That is right for an edit and wrong
 * for a **dispatch**, where standing down costs nothing at all.
 *
 * The advocate already declines to open a window for five other reasons (`withoutLeases`,
 * `withoutTwins`, `withoutOpenPrs`, `withoutLiveSessions`, `heldByChildren`). File
 * occupancy is the same kind of reason and the register is already there. This module is
 * the missing half: the question the advocate cannot answer from a `bd ready` row alone —
 * *which files would this bead touch?* — so the claim register has something to be matched
 * against. It adds no state and no lock. It reads the same map, one step earlier.
 *
 * ## Two provenances, and they are not the same evidence
 *
 * **Declared** — the bead says so itself, in a fenced `beadfiles` block in its own
 * description. bc-42ow is the bead that makes this a field written where beads are
 * written (bin/plan.js, the console's create path); this file owns the only reading of
 * it and `formatSurface`/`withSurface` below own the only writing, so the two halves
 * cannot come to spell the block differently.
 *
 * The description, rather than `--notes`, `--design` or a label, is measured and not
 * preferred. `bd list --json` carries `description` on every row and carries neither
 * `notes` nor `design` — those cost a `bd show` **per bead** — and the advocate asks this
 * of every candidate on every tick, so a surface in `notes` would put one tracker read
 * per candidate behind a thirty-second timer. Labels are the other free field and are the
 * wrong shape: a path is full of `/` and `.`, five files would be five labels, and bd's
 * label vocabulary is one flat namespace that `repo:`, `human` and the lease markers
 * already mean something in.
 *
 * **Guessed** — the paths written in the bead's own text, kept only if they name a file
 * that is actually on disk in the checkout that bead would be worked in. The existence
 * check is what makes the guess worth anything: it is what separates `lib/advocate.js`
 * from a package name, a URL or a path that used to exist.
 *
 * The two are kept apart all the way to the card because the advocate does different
 * things with them, and bc-hrno is the decision that says so: **a guess must not withhold
 * work.** A declaration is a forecast somebody made on purpose; a guess is this file
 * pattern-matching prose. Holding a bead out of the queue on the second one is the
 * expensive direction — the same argument `withoutTwins` makes about title comparisons,
 * and the opposite of the one lib/inflight.js makes about an open pull request, whose
 * evidence is a branch with commits on it. See `holdGuessedFiles` in lib/advocate.js:
 * off by default, and what it gates is whether the guess may *hold* rather than whether
 * it may *speak*.
 *
 * ## What this is not
 *
 * Not a lock and not a fence. A held file does not stop the session that gets dispatched
 * anyway from editing it — lib/claims.js already handles that case correctly, at edit
 * time, by naming the holder once and yielding. The only thing decided here is whether
 * this is a good *moment* to open a window, which is a question with a free answer.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * A path written in prose.
 *
 * At least one slash and a short extension, because both halves are what separate a path
 * from an ordinary word: `advocate` is a noun, `lib/advocate.js` is a file. The trailing
 * lookahead is what lets the sentence keep its punctuation — `lib/advocate.js's header`
 * and `see bin/plan.js.` both yield the path and neither yields the apostrophe.
 */
const PATH_RE = /(?<![\w/.-])[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z]\w{0,4}(?![\w/])/g;

/** Paths that are on disk and still never a bead's work. */
const NEVER = /^(?:node_modules|\.git|\.claude\/worktrees)\//;

/**
 * How much of a bead's text is read, and how many paths are taken from it.
 *
 * Bounded for the same reason lib/claims.js bounds a claim field by field: this runs over
 * every ready bead on every tick, a description is whatever somebody pasted into it, and
 * a bead quoting a directory listing must not turn one survey into four hundred `stat`
 * calls. A bead that genuinely names more than `MAX_FILES` files has already told us the
 * thing worth knowing several times over.
 */
const MAX_TEXT = 20000;
const MAX_FILES = 24;
const MAX_LEN = 300;

/**
 * The `beadfiles` fence.
 *
 * Spelled exactly as this repo spells `beads` (lib/draft.js), `beadproposal`
 * (lib/proposal.js) and `decision` (lib/decision.js) — the same tolerance of `~~~`, the
 * same forgiveness of trailing spaces on the fence line — because a person who has
 * written one of those has already learned this one.
 *
 * What is *inside* it is the one place this parts company with its neighbours: they carry
 * YAML and this carries one path per line. It has to. `*` is YAML's alias indicator, so a
 * path beginning with one is a parse error rather than a path — `files: [*.js]` fails
 * with "unresolved alias" — and a glob is the single most useful thing anybody writes into
 * a surface. Lines cost nothing to quote and nothing to escape, and `#` is a comment.
 */
const BLOCK_RE = /(^|\n)(?:```|~~~)[ \t]*beadfiles[ \t]*\r?\n([\s\S]*?)(?:```|~~~)[ \t]*(?=\r?\n|$)/;

/** Global, for the writers below, which have to replace every block rather than the first. */
const BLOCK_RE_G = new RegExp(BLOCK_RE.source, 'g');

/** The fields a bead's prose can arrive in, in the order a reader would weigh them. */
const TEXT_FIELDS = ['title', 'description', 'design', 'acceptance_criteria', 'notes'];

const clean = (v) => (typeof v === 'string' ? v : '');

/**
 * One entry of a surface, as this file stores and compares it.
 *
 * `./`, a leading `/`, a doubled `/` and a Windows `\` are four spellings of one path,
 * and two beads that spell a file differently would read as disjoint — which is the one
 * failure this whole field exists to prevent. A `..` is dropped outright rather than
 * resolved: a surface that climbs out of the checkout is not a claim this can check
 * against `claims.list()`, and normalising it away would turn nonsense into a
 * confident-looking path. A trailing `/` becomes `dir/**`, because "everything under
 * lib/" is the second most useful thing a surface can say and `matcher` below already
 * speaks that glob.
 *
 * Over-long and never-a-bead's-work paths yield nothing rather than being truncated into
 * something that would match the wrong file.
 */
function normalizeEntry(raw) {
  let s = clean(raw).trim().replace(/^["']|["']$/g, '').trim();
  if (!s || s.startsWith('#')) return '';
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  if (!s || s === '.' || s.split('/').includes('..')) return '';
  if (s.endsWith('/')) s = `${s}**`;
  return s.length > MAX_LEN || NEVER.test(s) ? '' : s;
}

/**
 * A list of entries, cleaned, deduplicated and capped — where both sources meet.
 *
 * Both the block and the legacy property names come through here, so a surface means the
 * same thing however it arrived and neither source can grow a bound of its own. The cap
 * drops the overflow rather than refusing the bead: a bead naming more than `MAX_FILES`
 * files has said the thing worth knowing several times over, and refusing it outright
 * would withhold work over a long list, which is the expensive direction.
 *
 * Dedupe is exact rather than case-folded, though this Mac's filesystem is not. Folding
 * here would drop one of two entries somebody wrote on purpose, and the place case
 * actually decides something is where two surfaces are matched against each other —
 * bc-42ow.4's question, not this one's.
 */
function normalizeFiles(list) {
  const out = [];
  for (const entry of list) {
    const file = normalizeEntry(entry);
    if (!file || out.includes(file)) continue;
    out.push(file);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/**
 * A surface as it arrives from somewhere that is not a block — a list, or one string.
 *
 * The one exported normaliser, and the reason it is exported at all: bc-42ow.2 gives the
 * field three writers before a description exists — the `beadproposal` block an advocate
 * emits (lib/proposal.js), the `beads` block a chat session emits (lib/draft.js), and the
 * card a person edits on their phone — and every one of them stores the parsed list on a
 * bead-to-be rather than rendering a block on the spot. A second normaliser over there
 * would be the same failure a second *fence* over there would be: two spellings of one
 * path read as two files, which is precisely what the field exists to prevent. So they
 * call this and store what the block would have stored.
 *
 * A string is split on whitespace and commas, because that is what a text input on a
 * phone hands back and what the property names have always taken; a block splits on lines
 * alone, since one path per line is what it is for.
 */
export function normalizeSurface(raw) {
  if (Array.isArray(raw)) return normalizeFiles(raw);
  return typeof raw === 'string' ? normalizeFiles(raw.split(/[\s,]+/)) : [];
}

/**
 * The paths in a `beadfiles` block, or `[]`.
 *
 * `[]` for text with no block, for a block with nothing in it, for a block of nothing but
 * comments, and for one full of things that are not paths. All four mean the same thing —
 * nobody said — and none of them is an error worth reporting, because the answer to an
 * unreadable surface has to be the answer to no surface: **dispatch**. A declaration is a
 * forecast somebody wrote at filing time, before anyone read the code, and a field that
 * could withhold work by being malformed would be worse than no field.
 */
export function parseSurface(text) {
  const m = clean(text).match(BLOCK_RE);
  return m ? normalizeFiles(m[2].split('\n')) : [];
}

/**
 * The declared surface — bc-42ow's field, and the only reading of it there is.
 *
 * The block in the description is where a bead really carries one. **The three property
 * names stay, as a fallback**, rather than being deleted now that the real field exists:
 * bc-mp8c chose them defensively so neither bead had to land first, and they still earn
 * their one `??` chain, because a surface can be in hand before a description exists — a
 * draft on the console, an advocate's proposal, the argument object `Bd.create` takes —
 * and a caller already holding a parsed list should not have to render a block to be
 * understood. Nothing in the tracker writes them, so on a `bd` row this is the block and
 * nothing else.
 *
 * A property that yields no usable entry falls through to the block rather than winning
 * empty-handed: `files: []` means "I am holding no list", not "this bead has no surface".
 * An unrecognised shape yields nothing, which is the same answer as a bead with no
 * surface — and a bead with no surface dispatches.
 */
export function declaredFiles(row) {
  const declared = normalizeSurface(row?.surface ?? row?.files ?? row?.fileSurface ?? null);
  if (declared.length) return declared;
  // `body` is what `Bd.create` calls a description before the bead exists — one field
  // under two names, not two places to look.
  return parseSurface(row?.description ?? row?.body ?? '');
}

/**
 * The block, as it is written into a description. Empty in, empty out.
 *
 * The writer lives here, beside the reader, for lib/prstage.js's reason: a format with
 * two implementations is how two screens come to disagree about one thing. The console's
 * filing path (bc-42ow.2) and the plan path (bc-42ow.3) call this rather than each
 * spelling a fence of their own, and anything they write is a thing `parseSurface` can
 * read back, because both ends normalise through `normalizeFiles`.
 */
export function formatSurface(files) {
  const list = normalizeSurface(Array.isArray(files) ? files : clean(files));
  return list.length ? ['```beadfiles', ...list, '```'].join('\n') : '';
}

/**
 * The description with the block taken out — what a card shows above the machinery.
 *
 * The blank run left behind is collapsed to one paragraph break, because this is also how
 * `withSurface` makes room for a new block: a description edited five times would
 * otherwise grow five blank lines where its surface keeps being lifted out and put back.
 */
export const withoutSurface = (description) =>
  clean(description).replace(BLOCK_RE_G, '$1').replace(/\n{3,}/g, '\n\n').trim();

/**
 * A description carrying this surface, with any block already in it replaced.
 *
 * Replacing rather than appending, and replacing *every* block rather than the first,
 * because a bead corrected and re-filed would otherwise carry two and `parseSurface`
 * reads the first: a corrected surface that silently loses to the one it corrects is
 * worse than no correction at all. An empty list takes the block out and leaves the prose,
 * which is how a surface is withdrawn.
 */
export function withSurface(description, files) {
  const body = withoutSurface(description);
  const block = formatSurface(files);
  if (!block) return body;
  return body ? `${body}\n\n${block}` : block;
}

/** Is this path a file that exists, in this checkout? A directory is not a claimable thing. */
function isFile(dir, file) {
  try {
    return fs.statSync(path.join(dir, file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The paths a bead's own text names, kept only where one is really there.
 *
 * The existence check is deliberately per *checkout*: a Climative bead naming
 * `src/index.ts` names a file that exists in thirty of the forty repos, and the one it
 * means is the one the bead would be worked in. `dirs` is already narrowed to that by the
 * caller (`repoDirs` and the bead's own `repo:` token), so a path kept here is a path that
 * exists where the work would happen.
 */
export function guessedFiles(row, dirs = []) {
  if (!dirs.length) return [];
  let text = '';
  for (const field of TEXT_FIELDS) {
    text += `\n${clean(row?.[field])}`;
    if (text.length >= MAX_TEXT) break;
  }
  const seen = new Set();
  const out = [];
  for (const hit of text.slice(0, MAX_TEXT).matchAll(PATH_RE)) {
    const file = hit[0].replace(/^\.\//, '');
    if (seen.has(file) || NEVER.test(file)) continue;
    seen.add(file);
    if (dirs.some((d) => isFile(d, file))) out.push(file);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/**
 * A bead's file surface and where it came from.
 *
 * Declared wins outright rather than being merged with the guess. Mixing them would
 * produce a surface whose strength no reader could name, and strength is the whole of
 * what the caller does with this: it decides whether the bead may be held or only spoken
 * about. A bead that declares its files has said what it means to touch, and the prose
 * around that declaration is commentary.
 */
export function surfaceOf(row, dirs = []) {
  const declared = declaredFiles(row);
  if (declared.length) return { files: declared, source: 'declared' };
  return { files: guessedFiles(row, dirs), source: 'guessed' };
}

/** Two directory paths that are the same place, symlinks and trailing slashes included. */
function sameDir(a, b) {
  if (!a || !b) return false;
  const x = path.resolve(a);
  const y = path.resolve(b);
  if (x === y) return true;
  try {
    return fs.realpathSync(x) === fs.realpathSync(y);
  } catch {
    return false;
  }
}

/**
 * Do these two patterns have any path in common?
 *
 * Not "does A match B" — bc-42ow.3 and bc-42ow.4 both compare a surface against another
 * *surface*, so both sides may be globs and `lib/**` against `lib/pr*.js` is a real pair.
 * The question is therefore whether any string exists that both would match, which for a
 * language this small is decidable exactly rather than approximated.
 *
 * The language is three things and no more: `*` inside a segment, `**` for any run of
 * segments, and a literal. Deliberately not full glob — no `?`, no `[a-z]`, no brace
 * expansion — because every one of those is another way for a declaration to mean
 * something other than what the person writing it thought, and this is a field people
 * write by hand at two in the morning.
 *
 * Memoised on the `(i, j)` pair it has already tried. Both walks are the ordinary wildcard
 * backtrack, which is exponential on the shape `a*a*a*a*b` — and an entry is up to
 * `MAX_LEN` characters of whatever somebody typed into a bead, so the bound has to come
 * from the code rather than from good manners. The visited set makes it O(len(a) x len(b));
 * nothing needs to cache a `true`, because a `true` returns all the way out on the first
 * one found.
 */
function segsIntersect(a, b) {
  const seen = new Set();
  const go = (i, j) => {
    const key = i * (b.length + 1) + j;
    if (seen.has(key)) return false;
    seen.add(key);
    if (i === a.length) return b.slice(j).every((s) => s === '**');
    if (j === b.length) return a.slice(i).every((s) => s === '**');
    // `**` matches no segments at all (skip it) or one more of the other side's (consume
    // theirs and stay put), which is the whole of what makes it different from `*`.
    if (a[i] === '**') return go(i + 1, j) || go(i, j + 1);
    if (b[j] === '**') return go(i, j + 1) || go(i + 1, j);
    return charsIntersect(a[i], b[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

/** The same question one level down, within a segment, where `*` matches any run but `/`. */
function charsIntersect(a, b) {
  if (a === b) return true;
  if (!a.includes('*') && !b.includes('*')) return false;
  const seen = new Set();
  const go = (i, j) => {
    const key = i * (b.length + 1) + j;
    if (seen.has(key)) return false;
    seen.add(key);
    if (i === a.length) return /^\**$/.test(b.slice(j));
    if (j === b.length) return /^\**$/.test(a.slice(i));
    if (a[i] === '*') return go(i + 1, j) || go(i, j + 1);
    if (b[j] === '*') return go(i, j + 1) || go(i + 1, j);
    return a[i] === b[j] && go(i + 1, j + 1);
  };
  return go(0, 0);
}

/**
 * Two entries of a surface that are the same file — the one comparison, used three ways.
 *
 * `occupiedBy` asks it of a surface entry against a path somebody has claimed, `overlap`
 * asks it of two surface entries, and both are that same question with a literal on one
 * side or on neither. One engine rather than two is bc-42ow's standing constraint — the
 * reason `formatSurface` lives beside `parseSurface`, and lib/prstage.js's argument: a plan
 * that computed overlap differently from the dispatcher would be the worst outcome
 * available, two mechanisms that both believe they are reading one field.
 *
 * Folded to lower case, which is the one place a surface is case-insensitive and it is
 * deliberate. `normalizeFiles` dedupes *exactly*, because dropping one of two entries
 * somebody wrote on purpose is a loss; this compares two paths on a filesystem that does
 * not distinguish them, so `lib/Plan.js` and `lib/plan.js` are one file, and two windows
 * opened on the belief that they are two is precisely what this field exists to prevent.
 */
const samePath = (a, b) => segsIntersect(a.toLowerCase().split('/'), b.toLowerCase().split('/'));

/**
 * One entry of a surface, as something a claimed path can be tested against.
 *
 * Exact, unless it carries a `*` — bc-42ow's field is a file **or glob** surface, and a
 * pattern that silently matched nothing here would be the worst of the three outcomes: a
 * bead that declared its files, a dispatcher that believed it had read them, and no hold.
 */
const matcher = (entry) => (file) => samePath(entry, file);

/**
 * Where two surfaces meet — the pairs, not a boolean.
 *
 * The pairs, because every sentence this feeds has to be able to name the file. "It
 * overlaps with bc-xyz" is a hold you have to go and work out for yourself; "both expect to
 * touch lib/advocate.js" is one you can act on, which is lib/advocate.js's third rule and
 * `validatePlan`'s reason for naming both groups rather than only the second one.
 *
 * Capped at three: two surfaces that both say `lib/` would otherwise produce a sentence as
 * long as both declarations put together.
 *
 * Either side may be a list or a raw string, because the callers hold their surfaces in
 * different shapes — a plan group's `files:` is a YAML list, a bead's is whatever
 * `declaredFiles` returned — and both go through `normalizeSurface`, so neither side can
 * be compared in a spelling the other would have normalised away.
 */
export function overlap(a, b, { limit = 3 } = {}) {
  const left = normalizeSurface(a);
  const right = normalizeSurface(b);
  const hits = [];
  for (const x of left) {
    for (const y of right) {
      if (!samePath(x, y)) continue;
      // `path` is the phrase a sentence uses, and the two spellings are not interchangeable:
      // "lib/plan.js and lib/**" reads as two files, which is exactly the wrong reading of
      // a pattern that contains the other. Named first, covering pattern second.
      hits.push({ a: x, b: y, path: x === y ? x : `${x} (covered by ${y})` });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** Do these two surfaces expect to touch a file in common? An empty surface never does. */
export const collides = (a, b) => overlap(a, b, { limit: 1 }).length > 0;

/**
 * What a bead deferred behind another bead's surface says — bc-42ow.4's sentence.
 *
 * Three things, in the order lib/claims.js's refusal puts them: **which** bead it is behind,
 * **what** the two share, and that this is a forecast rather than a verdict — because the
 * reader's next question is whether it is wrong, and a sentence that will not admit it
 * might be reads as a rule. It says *deferred* rather than blocked on purpose: the loser
 * comes up on the next tick, with nothing to release and nobody to ask.
 */
export function describeOverlap(otherId, hits, { where = 'is ahead of it in this tick' } = {}) {
  const files = hits.map((h) => h.path);
  const what =
    files.length === 1
      ? `both expect to touch ${files[0]}`
      : `both expect to touch ${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}`;
  return `${otherId} ${where}, and ${what} — a declared overlap, so this one waits for the next tick`;
}

/**
 * Where this bead's surface meets a claim somebody is holding right now.
 *
 * `records` is `claims.list()` — already pruned of dead trees and expired records as it
 * was read, so there is nothing to age out here and nothing to release: the hold this
 * feeds lasts exactly as long as the claim does, and a worktree that ships stops holding
 * anything on the next tick without this file knowing that shipping exists.
 *
 * Only `held` counts, for the reason `claims.collisions()` gives: a session that was told
 * about a file and has not come back is not on it, and treating the warning as the thing
 * it warned about would hold a bead behind a session that stood down.
 *
 * The claim's `repo` is the **main checkout**, not the worktree the edit is happening in —
 * that is claim-guard.sh's whole point, since two worktrees editing one logical file are
 * exactly the collision worth catching, so the key has to be the thing they share.
 */
export function occupiedBy(files, dirs, records = []) {
  if (!files.length || !dirs.length || !records.length) return [];
  const wants = files.map(matcher);
  const hits = [];
  for (const rec of records) {
    if (!rec || rec.state !== 'held' || !wants.some((m) => m(rec.file))) continue;
    if (!dirs.some((d) => sameDir(d, rec.repo))) continue;
    hits.push(rec);
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || String(a.since).localeCompare(String(b.since)));
}

/**
 * Where a claim is being held from, in the words a person would use for it.
 *
 * The bead comes second and in brackets rather than instead of the branch: a branch is
 * where the work *is* and is what you would go and look at, and the bead is what you would
 * type into `bd show`. It is present only when the daemon managed to resolve it — see
 * lib/claimbead.js, which is the reason a claim knows its bead at all, and which answers
 * nothing at all for a tree somebody named by hand.
 */
const whereOf = (rec) => {
  const where = rec.branch || (rec.dir ? path.basename(rec.dir) : '') || rec.session || 'a session that named no tree';
  return rec.bead ? `${where} (${rec.bead})` : where;
};

/**
 * What the card and the log say.
 *
 * Three things or it is not worth saying: **which file**, **who is on it**, and **how we
 * know this bead wants it** — because the third is what tells a reader whether to believe
 * the other two. A declared surface and a guess produce a differently-worded sentence on
 * purpose: one of them is a forecast somebody wrote down, and the other is this file
 * having read the description.
 */
export function busyWhy(hits, source = 'guessed') {
  const named = hits
    .slice(0, 3)
    .map((h) => `${h.file} on ${whereOf(h)}`)
    .join(', ');
  const more = hits.length > 3 ? `, and ${hits.length - 3} more` : '';
  const how = source === 'declared' ? 'which this bead declares' : "which this bead's text names";
  return `another session is editing ${named}${more} — ${how}`;
}
