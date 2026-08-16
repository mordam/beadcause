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
 * **Declared** — the bead says so itself. bc-42ow is the bead that makes this a field
 * written where beads are written (bin/plan.js, the console's create path), and until it
 * lands `declaredFiles` finds nothing on every bead in the tracker. That is the expected
 * state, not a fault: this reads the field defensively so that the day it exists, nothing
 * here has to change.
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

/** The fields a bead's prose can arrive in, in the order a reader would weigh them. */
const TEXT_FIELDS = ['title', 'description', 'design', 'acceptance_criteria', 'notes'];

const clean = (v) => (typeof v === 'string' ? v : '');

/**
 * The declared surface, whatever shape the field ends up in — bc-42ow's seam.
 *
 * Read from three plausible names rather than one, and from strings as well as arrays,
 * because the bead that decides the shape has a session running beside this one and the
 * two must not have to land together. An unrecognised shape yields nothing, which is the
 * same answer as a bead that has no surface — and a bead with no surface must dispatch.
 */
export function declaredFiles(row) {
  const raw = row?.surface ?? row?.files ?? row?.fileSurface ?? null;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  const out = [];
  for (const entry of list) {
    const file = clean(entry).trim().replace(/^\.\//, '');
    if (!file || file.length > 300 || NEVER.test(file)) continue;
    if (!out.includes(file)) out.push(file);
    if (out.length >= MAX_FILES) break;
  }
  return out;
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
 * One entry of a surface, as something a claimed path can be tested against.
 *
 * Exact, unless it carries a `*` — bc-42ow's field is a file **or glob** surface, and a
 * pattern that silently matched nothing here would be the worst of the three outcomes: a
 * bead that declared its files, a dispatcher that believed it had read them, and no hold.
 * `*` stops at a slash and `**` does not, which is the one glob convention everybody
 * already shares; everything else in the string is a literal, because a surface is a list
 * of paths and a path is full of regexp metacharacters.
 */
function matcher(entry) {
  if (!entry.includes('*')) return (file) => file === entry;
  const src = entry
    .split('**')
    .map((part) => part.split('*').map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  const re = new RegExp(`^${src}$`);
  return (file) => re.test(file);
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
