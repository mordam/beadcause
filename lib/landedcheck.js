/**
 * Say whether a bead's work is already on `main`, and under whose pull request —
 * `bin/b7e-landed` is the argv shell; this is the git and `bd` reading behind it.
 *
 * bc-khoe.47 names four sessions (`bc-42ow.4`, `bc-xl7n.55`, `bc-dgx7.5`, `bc-ka5y.15.3`)
 * that each answered "is this already done on main?" by hand, with a different chain of
 * `git`/`gh`/`bd` commands and a scratch worktree built to check it. This is the one
 * answer.
 *
 * ## The family, not just the bead
 *
 * A dotted id's siblings are found lexically, not through `bd`'s parent/child edges — a
 * bead keeps the dotted prefix it was filed under even after being reparented elsewhere
 * (`bc-68ou.10`), so the id string is the more stable handle than the live graph. `bc-
 * 42ow.4`'s family is `bc-42ow` and every `bc-42ow.N(.M...)`; commits are searched once,
 * by a regex over the whole family, because a plan group is routinely delivered as one
 * branch and one commit for two beads (`bc-42ow.3` and `bc-42ow.4`, both on #435) —
 * searching only the one id asked about would still find the commit (its body names
 * both), but searching the family is what surfaces the sibling as a first-class answer
 * rather than a fact buried in a commit body the caller still has to go and read.
 *
 * ## What counts as landed
 *
 * A commit on `base` naming the id, in its subject or its body. Squash-merge commits in
 * this repo always carry the merging pull request's number as a trailing `(#NNN)` on the
 * subject — `bc-42ow.3: A plan may not give the same file to two groups (#435)` — so
 * that number is read off the text rather than asked of GitHub, which costs nothing and
 * needs no network.
 *
 * `git log --grep` is asked with `-E` (POSIX extended regex) and a hand-rolled boundary
 * — `(^|[^A-Za-z0-9])id(...)([^A-Za-z0-9]|$)` — rather than `-P` with `\b`: `-P` needs
 * git built against PCRE, which is not guaranteed, and `-E`'s own `\b` is silently not a
 * word boundary at all in POSIX ERE (it matches nothing, which reads exactly like "no
 * commits found" and is the wrong kind of wrong to fail into).
 *
 * ## What counts as a collision, for an unlanded branch
 *
 * Two tiers. Literal: a file both the branch and `base` have touched since their
 * merge-base — `git diff --name-only` on both sides, the check every prior session did
 * by hand. Textual: a file `base` changed that *names* a file the branch changed, in its
 * own source at `base`'s tip — a file-list diff cannot see this, and it is exactly what
 * `bc-ka5y.15.3` missed: a file the branch wrote, never touched by `base` directly but
 * read by something `base` changed, so `test/orbit.mjs` went red on a conflict no
 * name-only diff shows. See `lib/affected.js` for the fuller version of this same idea
 * against test suites; this is one hop of it, because a bead's collision never needs
 * more than one.
 *
 * ## Finding the branch, when the tag does not spell the id
 *
 * `lib/notinmain.js`'s `ownsBranch` assumes every worktree branch ends in the bead id's
 * own `tagOf` — punctuation stripped, lowercased. In practice a session names its own
 * worktree (`EnterWorktree`'s `name`), and picks its own short tag by hand: `bc-khoe.43`
 * became `worktree-b7e-notes-kh43`, not `worktree-b7e-notes-khoe43`. `ownsBranch` misses
 * that branch entirely, and this tool cannot afford to: reporting "no evidence" about a
 * bead that has an open pull request right now is the one wrong answer worse than
 * running slow. So a bead `ownsBranch` finds nothing for gets a second pass — every
 * `worktree-*` branch is checked for a commit of its own (ahead of `base`) titled `<id>:
 * ...`, the same convention `beadIdFromBranch` reads in the other direction.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownsBranch } from './notinmain.js';
import { supersededBy } from './superseded.js';
import { available as prAvailable, list as prList } from './pr.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This repo's own root — same anchor `lib/gate.js` and its siblings use. */
export const REPO_ROOT = path.join(HERE, '..');

function run(dir, args) {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function lines(out) {
  return String(out || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The root of a dotted id's family: everything before its *last* dotted segment —
 * `bc-42ow.4` is `bc-42ow`, and `bc-ka5y.15.3` is `bc-ka5y.15`, not the whole `bc-ka5y`
 * epic. One dot up is the immediate sibling group a plan-group delivery actually shares
 * a branch with; the top-level epic can be hundreds of unrelated beads, and searching
 * that wide turns "the sibling this landed with" into a wall of every other commit the
 * epic ever had. An id with no dot at all (an epic's own id, or a bare bead) is its own
 * root — its family is then itself plus its direct dotted children, which is the one
 * case a family search does want the wider net, because there is no narrower one.
 */
export function familyRootOf(id) {
  const s = String(id || '').trim();
  const lastDot = s.lastIndexOf('.');
  return lastDot === -1 ? s : s.slice(0, lastDot);
}

/** Every id in `text` belonging to `root`'s family — `root` itself, or `root.N(.M...)`, deduplicated. */
export function familyIdsIn(text, root) {
  if (!root) return [];
  const re = new RegExp(`\\b${escapeRe(root)}(?:\\.[0-9]+)*\\b`, 'g');
  return [...new Set(String(text || '').match(re) || [])];
}

/** The pull request a squash-merge commit's subject names, `(#NNN)` at the end — or `null`. */
export function prNumberOf(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(String(subject || '').trim());
  return m ? Number(m[1]) : null;
}

/** `base` resolved to a ref that actually exists in `dir`: `origin/<base>` first, then `<base>` bare. */
export function resolveBase(dir, base) {
  for (const cand of [`origin/${base}`, base]) {
    if (run(dir, ['rev-parse', '--verify', '--quiet', cand]) != null) return cand;
  }
  return null;
}

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

/**
 * Every commit on `baseRef` naming a member of `root`'s family, oldest first as `git
 * log` orders them by default here (newest is `commits[commits.length - 1]`) —
 * `{ sha, subject, ids, pr }`. `ids` is every family id the commit's subject or body
 * names; `pr` is the number the subject's own trailing `(#NNN)` carries, or `null` for
 * a commit that never went through a squash merge that way.
 *
 * The boundary is hand-rolled rather than `\b` — see the file header for why — and it
 * is POSIX ERE, so `git log -E` is what this runs, not `-P`.
 */
export function familyCommits(dir, baseRef, root) {
  if (!root) return [];
  const pattern = `(^|[^A-Za-z0-9])${escapeRe(root)}(\\.[0-9]+)*([^A-Za-z0-9]|$)`;
  const out = run(dir, ['log', baseRef, '-E', `--grep=${pattern}`, `--format=%H${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`]);
  if (out == null) return [];
  const commits = [];
  for (const rec of out.split(RECORD_SEP)) {
    if (!rec.trim()) continue;
    const [sha, subject = '', body = ''] = rec.split(FIELD_SEP);
    if (!sha || !sha.trim()) continue;
    const ids = familyIdsIn(`${subject}\n${body}`, root);
    if (!ids.length) continue;
    commits.push({ sha: sha.trim(), subject: subject.trim(), ids, pr: prNumberOf(subject) });
  }
  return commits;
}

/** `bd show <id> --json`, one row or `null` — never throws, an unreachable `bd` is not this tool's business. */
export function bdShow(id) {
  let out;
  try {
    out = execFileSync('bd', ['show', id, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
  let rows;
  try {
    rows = JSON.parse(out);
  } catch {
    return null;
  }
  return Array.isArray(rows) ? rows.find((r) => r.id === id) || null : null;
}

/**
 * The bead id a caller meant when it gave none: the first family-shaped id — `<id>:` —
 * at the start of a commit subject unique to the current branch since `baseRef`. Every
 * worker commit in this repo is titled that way (`bc-khoe.44: b7e-swbump — ...`), so a
 * branch that has committed at all names its own bead in its first line. A branch with
 * no commits yet — the ordinary shape right after `EnterWorktree` — has nothing to read
 * this off and returns `null`; the caller has to be given the id explicitly then.
 */
export function beadIdFromBranch(dir, baseRef) {
  const out = run(dir, ['log', `${baseRef}..HEAD`, '--format=%s']);
  for (const subject of lines(out)) {
    const m = /^([a-z][a-z0-9]*-[a-z0-9.]+):/i.exec(subject);
    if (m) return m[1];
  }
  return null;
}

/** A branch's tip, local ref preferred over origin's — `null` if neither exists. */
export function tipOf(dir, branch) {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const out = run(dir, ['rev-parse', '--verify', '--quiet', ref]);
    if (out) return out.trim();
  }
  return null;
}

/** Every `worktree-*` branch this checkout knows about, local or on origin, once each. */
function worktreeBranchNames(dir) {
  const out = run(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-*', 'refs/remotes/origin/worktree-*']);
  const names = new Set();
  for (const l of lines(out)) names.add(l.replace(/^origin\//, ''));
  return [...names];
}

/**
 * Every `worktree-*` branch that is this bead's own — see the file header for why there
 * are two ways of deciding that. `baseRef` is only needed for the fallback pass; without
 * it (no ref resolved yet) only the tag match runs.
 */
export function branchesFor(dir, id, baseRef) {
  const all = worktreeBranchNames(dir);
  const byTag = all.filter((b) => ownsBranch(id, b));
  if (byTag.length || !baseRef) return byTag;

  const pattern = `(^|[^A-Za-z0-9])${escapeRe(id)}:`;
  return all.filter((b) => {
    const tip = tipOf(dir, b);
    if (!tip) return false;
    const out = run(dir, ['log', `${baseRef}..${tip}`, '-E', `--grep=${pattern}`, '--format=%H', '-1']);
    return !!(out && out.trim());
  });
}

/** How many commits `tip` has that `baseRef` does not. `null` if git could not answer. */
export function commitsAhead(dir, tip, baseRef) {
  const out = run(dir, ['rev-list', '--count', `${baseRef}..${tip}`]);
  if (out == null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

function changedFiles(dir, from, to) {
  return lines(run(dir, ['diff', '--name-only', `${from}..${to}`]));
}

function mergeBaseOf(dir, a, b) {
  const out = run(dir, ['merge-base', a, b]);
  return out ? out.trim() : null;
}

/** Does `content` name `basename` as a quoted literal — the `lib/affected.js` path-literal shape, one hop. */
function namesFile(content, basename) {
  return new RegExp(`['"\`]${escapeRe(basename)}['"\`]`).test(content);
}

/**
 * What `baseRef` has landed since the branch's merge-base that overlaps the branch's
 * own changes — `{ mergeBase, branchFiles, baseFiles, literal, textual }`. `literal` is
 * files both sides touched; `textual` is a file only `base` touched whose contents (at
 * `baseRef`'s tip) name a file only the branch touched — see the header for what this
 * catches that a name-only diff cannot. `null` if there is no merge-base to compare
 * from (an unrelated history, most likely — a usage mistake).
 */
export function collisionsSinceMergeBase(dir, branchTip, baseRef) {
  const mergeBase = mergeBaseOf(dir, branchTip, baseRef);
  if (!mergeBase) return null;
  const branchFiles = changedFiles(dir, mergeBase, branchTip);
  const baseFiles = changedFiles(dir, mergeBase, baseRef);
  const baseFileSet = new Set(baseFiles);
  const branchFileSet = new Set(branchFiles);
  const literal = branchFiles.filter((f) => baseFileSet.has(f));

  const textual = [];
  for (const bf of baseFiles) {
    if (branchFileSet.has(bf)) continue; // already the literal case
    const content = run(dir, ['show', `${baseRef}:${bf}`]);
    if (content == null) continue;
    for (const brf of branchFiles) {
      if (baseFileSet.has(brf)) continue; // already the literal case
      // The branch file's full repo-relative path first — `path.join(ROOT, 'public',
      // 'sound.wav')` and a bare `'public/sound.wav'` both carry it — and its bare
      // basename as a fallback, for a reference relative to some other base directory.
      if (namesFile(content, brf) || namesFile(content, brf.split('/').pop())) {
        textual.push({ branchFile: brf, reachedVia: bf });
      }
    }
  }

  return { mergeBase, branchFiles, baseFiles, literal, textual };
}

/**
 * What GitHub knows about `branch`, if anything — `{ open: {number, url} }`,
 * `{ merged: {number, url} }`, or `{}`. Best-effort: an unreachable or unauthenticated
 * `gh` is not evidence of anything, so this returns `{}` rather than throwing, and the
 * caller reports what git already found either way.
 */
export async function githubStateFor(dir, branch) {
  try {
    const gh = await prAvailable();
    if (!gh.ok) return {};
    const rows = (await prList(dir, { state: 'all', head: branch, limit: 10 })) || [];
    const mine = rows.filter((r) => r.branch === branch);
    const merged = mine.find((r) => String(r.state || '').toUpperCase() === 'MERGED');
    if (merged) return { merged: { number: merged.number, url: merged.url } };
    const open = mine.find((r) => String(r.state || '').toUpperCase() === 'OPEN');
    if (open) return { open: { number: open.number, url: open.url } };
    return {};
  } catch {
    return {};
  }
}

/**
 * The whole answer for one bead: `{ ok, id, base, verdict, ... }`.
 *
 * Verdicts: `landed` (a commit on `base` names it directly — `commits` carries which
 * one(s) and their pull requests); `superseded` (closed with a `superseded-by:` marker
 * — `supersededLanded` says whether *that* id's own family search finds a landing, so
 * "superseded" never has to be read as "therefore landed" or "therefore lost"); `un
 * landed` (a branch of its own exists, ahead of `base`, with no commit naming it there
 * — `collisions` is the two-tier overlap check, and `github` names an open or merged
 * pull request GitHub knows about that git alone did not resolve — a squash merge whose
 * subject never carried the id, or a delivery mid-flight); `no-evidence` (no commit, no
 * supersede marker, no branch — said plainly, not an empty list that reads like a
 * failed lookup).
 *
 * `family` is every family commit found regardless of verdict, always — the sibling
 * `bc-42ow.3` shows up here even when the bead asked about is `bc-42ow.4` and its own
 * `commits` array is empty for some other reason.
 */
export async function checkLanded(dir, id, { base = 'origin/main' } = {}) {
  const baseRef = resolveBase(dir, base);
  if (!baseRef) return { ok: false, id, reason: `neither origin/${base} nor ${base} resolves in ${dir}` };

  const root = familyRootOf(id);
  const family = familyCommits(dir, baseRef, root);
  const commits = family.filter((c) => c.ids.includes(id));
  const bead = bdShow(id);

  if (commits.length) {
    return { ok: true, id, base: baseRef, verdict: 'landed', commits, family, bead };
  }

  const superseded = bead ? supersededBy(bead) : '';
  if (superseded) {
    const otherId = superseded.includes('/') ? superseded.slice(superseded.indexOf('/') + 1) : superseded;
    const otherRoot = familyRootOf(otherId);
    const otherFamily = otherRoot === root ? family : familyCommits(dir, baseRef, otherRoot);
    const originalCommits = otherFamily.filter((c) => c.ids.includes(otherId));
    return {
      ok: true,
      id,
      base: baseRef,
      verdict: 'superseded',
      supersededBy: superseded,
      supersededLanded: originalCommits.length > 0,
      commits: originalCommits,
      family,
      bead,
    };
  }

  const branches = branchesFor(dir, id, baseRef);
  if (branches.length) {
    const branch = branches[0];
    const tip = tipOf(dir, branch);
    const ahead = tip ? commitsAhead(dir, tip, baseRef) : null;
    const collisions = tip ? collisionsSinceMergeBase(dir, tip, baseRef) : null;
    const github = await githubStateFor(dir, branch);
    return { ok: true, id, base: baseRef, verdict: 'unlanded', branch, tip, ahead, collisions, github, family, bead };
  }

  return { ok: true, id, base: baseRef, verdict: 'no-evidence', family, bead };
}
