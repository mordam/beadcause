/**
 * Keeping what a session did, next to the commits it made.
 *
 * An advocate's session is the one kind of work here nobody watched. The window
 * closes itself when it exits, the rendered log in `~/.config/beadcause/logs/` is
 * per-bead and is overwritten by the next run, and Claude Code's own transcript
 * lives under `~/.claude/projects/` — outside the repo, on one laptop, deleted
 * whenever that directory is cleared. Three months later the commit is all that is
 * left, and the commit does not say which bead it was, which agent wrote it, or
 * what it was asked.
 *
 * So the log goes into the repo, in refs, exactly the way beads carries Dolt data on
 * `refs/dolt/*` — and it is worth being precise about which half of that trick is
 * being borrowed:
 *
 * - **Transport.** A ref outside `refs/heads/*` and `refs/tags/*` is invisible to
 *   `git log`, `git branch`, `git status` and `git checkout`; it is never fetched or
 *   pushed unless it is named; and it keeps its objects alive against `gc`. That is
 *   what makes a payload able to ride inside a repo without touching its file tree.
 *   Dolt then layers a database inside those objects. We don't need one: the payload
 *   is a log file, so plain blobs are enough.
 * - **Anchoring.** Dolt does *not* attach anything to a code commit — its history is
 *   its own. Attaching data to a commit hash is what `git notes` is for, and that is
 *   the other half here.
 *
 * Both, therefore:
 *
 *   refs/beadcause/sessions/<bead-id>   a commit per session, chained, whose tree is
 *                                       meta.json + session.log [+ transcript.jsonl]
 *   refs/notes/beadcause                a few lines on each commit the session made,
 *                                       and on the merge that later brought it into
 *                                       main — so `git log --notes=beadcause` reads
 *                                       as "which bead, which agent, what outcome"
 *
 * Read them with plain git, which is the point of storing them this way:
 *
 *   git log --notes=beadcause main
 *   git log refs/beadcause/sessions/bc-bk6
 *   git cat-file -p refs/beadcause/sessions/bc-bk6:session.log
 *
 * **Nothing here is pushed by default**, and that is deliberate rather than
 * incidental: a transcript carries absolute paths, environment, and whatever tool
 * output scrolled past it. `git push origin 'refs/beadcause/*:refs/beadcause/*'` is
 * an explicit act, and on a shared repo it should stay one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderEvent } from './agentlog.js';
import { git, gitInput, hashObject, mainCheckout, ok } from './gitref.js';
// Tier 4 is written by the agent through lib/memory.js and lands here — see the section
// on it there for why the store is staged in one file and consumed in the other.
import { stagedDebrief, clearDebrief, renderDebrief } from './memory.js';
import * as pr from './pr.js';
// What the run actually cost, as opposed to what it was routed to — bc-nc6o.3. The
// vocabulary and the reading of a transcript line are there; finding the transcript is
// here, because this file already had to (a session that enters a worktree writes under
// two project slugs, and both halves are the same conversation).
import { modelsInTranscript, ranDiverged } from './ranmodel.js';
// The attic's own two answers, borrowed rather than re-derived: which worktrees git knows
// about, and when one of them was retired. lib/tidy.js owns both — see `worktreeState`.
import { parseWorktrees, realPath, retiredAt } from './tidy.js';

const HOME = os.homedir();

// Re-exported because this file is where callers first met it, and lib/gitref.js —
// which now owns it, since lib/foundation.js needs the same plumbing — is an
// implementation detail of how these payloads get written.
export { mainCheckout };

/** Refuse to store a transcript bigger than this. Something has gone wrong at 64MB. */
const MAX_TRANSCRIPT = 64 * 1024 * 1024;

/** And the readable rendering is capped too: 4MB of text is nobody's session log. */
const MAX_RENDERED = 4 * 1024 * 1024;

/**
 * One pass over the transcript files: `{ lines, models }`.
 *
 * `lines` is the transcript as the CLI would have shown it, and is what makes the
 * always-stored half small enough to keep forever: the raw jsonl of a real session runs
 * to megabytes, most of it tool-result payloads, and the rendering is tens of kilobytes
 * of the part a person would read. It reuses `renderEvent` from lib/agentlog.js rather
 * than a second renderer, so an archived log and the live pane on the phone say the same
 * thing in the same shape.
 *
 * `models` is every model an assistant turn actually ran on (bc-nc6o.3), collected here
 * rather than by a second reader for the obvious reason: this is the one place in the
 * archive where those megabytes are already open.
 */
function readTranscripts(files) {
  const out = [];
  const models = [];
  let bytes = 0;
  let truncated = false;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    // The models are collected off the same read rather than a second one: a transcript
    // runs to megabytes and this is the only place it is already open.
    for (const id of modelsInTranscript(text)) if (!models.includes(id)) models.push(id);
    if (truncated) continue;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const rendered = renderEvent(event);
      if (!rendered) continue;
      bytes += rendered.length + 1;
      if (bytes > MAX_RENDERED) {
        out.push('… (rendering truncated)');
        truncated = true;
        break;
      }
      out.push(rendered);
    }
  }
  // Truncating the *rendering* must not truncate the models: a session that changed model
  // in its last ten minutes is exactly the session whose log ran long, and the one the
  // whole of `ran:` exists for. So the scan above happens per file before the cap, and
  // `truncated` only stops the part that has a size budget.
  return { lines: out, models };
}

const NOTES_REF = 'refs/notes/beadcause';
export const SESSIONS_PREFIX = 'refs/beadcause/sessions';
const sessionRef = (bead) => `${SESSIONS_PREFIX}/${bead}`;

/**
 * How Claude Code names the directory it keeps a transcript in: the cwd with every
 * non-alphanumeric character replaced by a dash. Derived rather than reversed —
 * the mapping loses information, so the only reliable direction is to slugify each
 * worktree we know about and look for a match.
 */
const slug = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Every transcript file for one session id, oldest first.
 *
 * Usually one. It is a list because a session that enters a worktree starts writing
 * under that directory's project slug instead, and both halves are the same
 * conversation — concatenating them is valid, since the format is one JSON object
 * per line.
 */
function findTranscripts(sessionId) {
  const root = path.join(HOME, '.claude', 'projects');
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const p = path.join(root, dir, `${sessionId}.jsonl`);
    try {
      out.push({ path: p, dir, mtime: fs.statSync(p).mtimeMs });
    } catch {
      /* not this one */
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/**
 * Every model one finished session actually ran on, newest transcript last (bc-nc6o.3).
 *
 * The bead's copy of this is written whether or not the workspace keeps session logs —
 * `sessionLog: false` means "do not put a log in the repo", not "do not know what the
 * bill was for" — so the advocate needs an answer even where no archive is going to
 * produce one, and gets it here. On the ordinary path it does not call this at all: the
 * archive hands the same list back, having read the file once for the log anyway. The
 * other caller is the archive *failing*, which is exactly when the bead is the only place
 * this can survive.
 *
 * Usually one model. Two means the session moved mid-run, which is the case the whole
 * label exists for. `[]` means no transcript survived, which is not a failure worth
 * saying anything about: a window Adam closed and then cleared out of `~/.claude` has
 * left no evidence, and inventing the routed model as the answer would turn "we do not
 * know" into "it ran on what we planned" — the one lie this file is here to prevent.
 */
export function ranModelsOf(sessionId) {
  if (!sessionId) return [];
  const files = findTranscripts(sessionId);
  if (!files.length) return [];
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    for (const id of modelsInTranscript(text)) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Which worktree the session actually worked in.
 *
 * Not `cwd` from its session record: that is the directory it was *launched* in and
 * is never updated, so a session that entered a worktree still reads as being in the
 * main checkout. The transcript's own directory is the honest signal — Claude Code
 * writes it under the slug of wherever it is running.
 */
export async function worktreeOfSession(main, sessionId) {
  const transcripts = findTranscripts(sessionId);
  if (!transcripts.length) return null;
  const list = (await git(main, ['worktree', 'list', '--porcelain'])).split('\n');
  const paths = list.filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim());
  // Newest first: if it moved, the last place it wrote is where the work ended up.
  for (const t of [...transcripts].reverse()) {
    const hit = paths.find((p) => slug(p) === t.dir);
    if (hit) return hit;
  }
  return null;
}

/**
 * The commits this session is responsible for.
 *
 * `branch --not main` is the right answer while the work is still on its branch. Once
 * it has been merged that set is empty, so the fallback is the branch's own commits
 * since the session started — which is a heuristic, and is recorded as one in
 * meta.json rather than presented as certainty.
 */
async function sessionCommits(main, branch, startedAt) {
  const unmerged = (await ok(git(main, ['rev-list', branch, '--not', 'main'])))?.trim();
  if (unmerged) return { commits: unmerged.split('\n').filter(Boolean), how: 'not-in-main' };
  if (!startedAt) return { commits: [], how: 'none' };
  const since = (await ok(git(main, ['rev-list', branch, `--since=${startedAt}`, '--max-count=50'])))?.trim();
  return { commits: since ? since.split('\n').filter(Boolean) : [], how: 'since-session-start' };
}

/** The commit on main that brought `head` in, or null while it is still unmerged. */
export async function mergeCommitFor(main, head, { branch = '', usePr = false } = {}) {
  const merged = await git(main, ['merge-base', '--is-ancestor', head, 'main']).then(() => true, () => false);
  if (!merged) {
    /**
     * The second way work lands, and now the usual one.
     *
     * A squash-merged pull request writes a *new* commit on main carrying the
     * branch's tree and none of its history, so `--is-ancestor` is false forever and
     * the note that says which commit brought a session's work in would never be
     * written — while the entry waiting to write it sat in `pendingNotes` being
     * retried on every sweep, for good.
     *
     * GitHub knows the answer, and knows it exactly: `mergeCommit` is the squash
     * commit itself, which is a better anchor than the ancestry walk below could
     * ever produce. Asked only after the local test has said no, and only when a
     * caller passes the branch — so a repo with no `gh` behaves as it always did.
     */
    if (!usePr || !branch) return null;
    const request = await pr.viewForBranch(main, branch);
    return request?.state === 'MERGED' ? request.mergeCommit || null : null;
  }
  // The last commit on the ancestry path from `head` to main is the one that landed
  // it — a merge commit normally, or the tip itself for a fast-forward.
  const out = (await ok(git(main, ['rev-list', '--ancestry-path', `${head}..main`])))?.trim();
  if (!out) return head; // already on main directly
  const lines = out.split('\n').filter(Boolean);
  return lines[lines.length - 1];
}

/** One tiny note per commit. Never the log itself — a note is read in `git log`. */
async function note(main, sha, text) {
  // `add -f` overwrites rather than failing on a commit that already carries one,
  // which is what re-noting a merge has to do.
  await ok(git(main, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-m', text, sha]));
}

/**
 * Note the commit that landed a bead — and, when it fulfils any, what it fulfils.
 *
 * The requirement lines are the **authoritative** half of bc-fvmx's graph, which is why
 * they go here rather than only into the index: this note is anchored to an immutable
 * commit, is written once, and survives everything an index cannot. lib/reqindex.js can
 * be rebuilt from a repo's notes and is rebuilt from them in test/reqindex.mjs; nothing
 * can rebuild the notes.
 *
 * `extra` stays optional and empty produces byte-for-byte the note that shipped before
 * it, so a repo with no requirements — which is every personal one — reads the same.
 */
export async function noteMerge(main, { sha, bead, workspace, ref, extra = '' }) {
  const tail = String(extra || '').trim();
  await note(main, sha, `beadcause: landed ${workspace}/${bead}\nsession log: ${ref}${tail ? `\n${tail}` : ''}`);
  return sha;
}

/**
 * Archive one finished session.
 *
 * Returns what it wrote, or `{ skipped }` with a reason — a session that produced no
 * commits and no transcript is not a failure, it is a session that was closed before
 * it did anything, and the log should say which.
 */
export async function archiveSession(dir, session) {
  const {
    workspace,
    bead,
    sessionId = null,
    startedAt = null,
    endedAt = new Date().toISOString(),
    exitCode = null,
    outcome = 'ended',
    logLines = [],
    includeTranscript = false,
    title = '',
    // What the launcher routed this window to, and the tier it routed by (bc-nc6o.2).
    // Recorded beside what actually ran, because either on its own is unreadable: the
    // selection alone cannot be checked and the outcome alone cannot be explained.
    model = null,
    tier = null,
  } = session;

  const main = await mainCheckout(dir);
  const worktree = sessionId ? await worktreeOfSession(main, sessionId) : null;
  const branch = worktree
    ? (await ok(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])))?.trim() || null
    : null;

  const { commits, how } = branch ? await sessionCommits(main, branch, startedAt) : { commits: [], how: 'no-branch' };

  const transcripts = sessionId ? findTranscripts(sessionId) : [];
  const transcriptBytes = transcripts.reduce((n, t) => {
    try {
      return n + fs.statSync(t.path).size;
    } catch {
      return n;
    }
  }, 0);

  // Read once, here, because both halves below want it: the readable log, and the models
  // the run was actually billed to. A caller supplying its own `logLines` still gets the
  // second — the log it captured says nothing about which model produced it.
  const read = transcripts.length ? readTranscripts(transcripts) : { lines: [], models: [] };
  const ranModels = read.models;

  const meta = {
    bead,
    workspace,
    title,
    outcome,
    exitCode,
    sessionId,
    startedAt,
    endedAt,
    branch,
    worktree,
    commits,
    // How `commits` was decided, because one of the two ways is a heuristic and a
    // reader three months from now cannot tell which was used.
    commitsFrom: how,
    // The routing decision and its outcome, as three separate facts rather than one
    // number (bc-nc6o.3). `model` is what the window was opened on and `tier` is what
    // that was decided from; `ran` is every model id the transcript shows an assistant
    // turn on, which is usually the same one and is a *list* because a session somebody
    // typed `/model` in halfway through genuinely ran on two. `ranDiverged` is stored
    // rather than left to be recomputed: it is the question this whole record exists to
    // answer, and it should be answerable from the file alone three months from now,
    // without the reader having to know which aliases map onto which ids.
    model: model || null,
    tier: tier ?? null,
    ran: ranModels,
    ranDiverged: ranDiverged(model, ranModels),
    transcript: includeTranscript ? transcripts.map((t) => t.path) : [],
    transcriptBytes,
    archivedBy: 'beadcause',
  };

  // A work session's output goes to its iTerm window and nowhere else, so unless the
  // caller captured something, the transcript IS the log — rendered down to the part
  // worth reading.
  const lines = logLines.length ? logLines : read.lines;

  // What the session said about itself, if it said anything. Read *before* the tree is
  // built and cleared *after* the ref lands, so a failure anywhere between the two leaves
  // the debrief staged for the next archive rather than consumed by one that never
  // committed. `tip` is what makes the clear a compare-and-swap — see `clearDebrief`.
  const { entries: debriefs, tip: debriefTip } = await stagedDebrief(main, bead);
  const memory = renderDebrief(debriefs);

  const entries = [
    ['meta.json', Buffer.from(JSON.stringify(meta, null, 2) + '\n')],
    ['session.log', Buffer.from((lines.join('\n') || '(no transcript was found for this session)') + '\n')],
  ];

  // A session that wrote nothing gets no `memory.md` at all, rather than an empty one.
  // The page distinguishes the two and says different things about them: no file means
  // "it had nothing worth your time", an empty file means something wrote a blank — and
  // an archive that always carried the name would make the first sentence unsayable.
  if (memory.trim()) entries.push(['memory.md', Buffer.from(memory)]);

  if (includeTranscript && transcripts.length) {
    if (transcriptBytes > MAX_TRANSCRIPT) {
      entries[1][1] = Buffer.concat([entries[1][1], Buffer.from(`\n(transcript omitted — ${transcriptBytes} bytes)\n`)]);
    } else {
      const parts = [];
      for (const t of transcripts) {
        try {
          parts.push(fs.readFileSync(t.path));
        } catch {
          /* a transcript that vanished mid-archive is not worth failing over */
        }
      }
      if (parts.length) entries.push(['transcript.jsonl', Buffer.concat(parts)]);
    }
  }

  // Asked of the entry list by name rather than by counting it. It used to be
  // `entries.length > 2`, which was true exactly when a transcript had been pushed and
  // stopped being true the moment `memory.md` became a fourth thing that might be there.
  const includedTranscript = entries.some(([n]) => n === 'transcript.jsonl');

  const blobs = [];
  for (const [name, buf] of entries) blobs.push([name, await hashObject(main, buf)]);

  const tree = (
    await gitInput(main, ['mktree'], blobs.map(([name, sha]) => `100644 blob ${sha}\t${name}`).join('\n') + '\n')
  ).trim();

  const ref = sessionRef(bead);
  const parent = (await ok(git(main, ['rev-parse', '--verify', '--quiet', ref])))?.trim() || null;
  const subject = `${workspace}/${bead} · ${outcome}${commits.length ? ` · ${commits.length} commit(s)` : ''}`;
  const body = [
    subject,
    '',
    title ? `${title}\n` : '',
    `session ${sessionId || '(unknown)'}`,
    ...(branch ? [`branch ${branch}`] : []),
    ...commits.map((c) => `commit ${c}`),
  ]
    .filter((l) => l !== null)
    .join('\n');

  const commit = (
    await git(main, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', body])
  ).trim();

  // Compare-and-swap against the parent we read, so two advocates archiving at once
  // cannot lose one another's entry. The empty string is not a formality — it is git's
  // way of saying "and the ref must not exist", and leaving the argument off on the
  // *first* archive for a bead means "overwrite whatever is there", which is the one
  // case where every writer reads null at once and all of them think they are creating
  // it. Same argument, at length, beside `commitToRef` in lib/gitref.js.
  await git(main, ['update-ref', ref, commit, parent || '']);

  // Taken, so drop the staging ref — after the archive is durable, never before, and only
  // if nothing was written while this ran. A debrief that loses that race stays staged and
  // rides along with the next archive for this bead, carrying its own timestamp.
  if (debriefTip) await clearDebrief(main, bead, debriefTip);

  // The note on each commit the session made. Small on purpose: it is read inline in
  // `git log`, and a 40KB note there would make history unreadable.
  const noteText = [
    `beadcause: ${workspace}/${bead}${title ? ` — ${title}` : ''}`,
    `agent session ${sessionId || '(unknown)'} · ${outcome}`,
    `session log: git cat-file -p ${ref}:session.log`,
  ].join('\n');
  for (const sha of commits) await note(main, sha, noteText);

  // If it has already landed, note the landing now; otherwise the caller keeps it
  // pending and the sweep re-notes it when the branch reaches main.
  //
  // Only when the session actually committed something. A session that made no
  // commits sits on a branch that is trivially an ancestor of main, and noting a
  // "landing" for it would put this bead's name on a merge it had nothing to do with.
  const head = branch && commits.length ? (await ok(git(main, ['rev-parse', branch])))?.trim() || null : null;
  const merged = head ? await mergeCommitFor(main, head) : null;
  if (merged) await noteMerge(main, { sha: merged, bead, workspace, ref });

  return {
    ref,
    commit,
    commits,
    branch,
    head,
    merged,
    transcriptBytes,
    includedTranscript,
    debriefs: debriefs.length,
    // Handed back so the caller can put it on the bead. The archive is where the exact
    // ids live; the bead is where the fact is read, and only the advocate can write there.
    ran: ranModels,
  };
}

/** What is archived for a bead: one row per session, newest first. */
export async function readArchive(dir, bead, { limit = 20 } = {}) {
  const main = await mainCheckout(dir);
  const ref = sessionRef(bead);
  const log = await ok(git(main, ['log', '--format=%H%x00%aI%x00%s', `--max-count=${limit}`, ref]));
  if (!log) return { ref, sessions: [] };
  const sessions = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, at, subject] = line.split('\0');
      return { commit, at, subject };
    });
  return { ref, sessions };
}

/**
 * Every bead in this repo that has a session archived for it — one git call, whatever
 * the size of the list.
 *
 * `readArchive` above answers "what is archived for *this* bead", which is the right
 * shape for a detail sheet and the wrong one for a list: the ledger
 * ([`GET /api/history`](#the-ledger-behind-the-history-tab)) draws a marker per row, and asking per row
 * would be one `git log` and one `mainCheckout` per bead on the page — fifty processes
 * to decide fifty booleans, on a screen that scrolls.
 *
 * A ref *is* the index. Every archive lives at `refs/beadcause/sessions/<bead-id>`, so
 * the whole set is one `for-each-ref` over that prefix, and `lstrip=3` hands back bead
 * ids rather than ref names. On this repo that is 174 refs in about ten milliseconds.
 *
 * A set rather than a list because every caller asks it the same question — `has(id)` —
 * and a caller handed an array would write `.includes` inside its own row loop, which
 * is the per-row cost coming back in a different disguise.
 *
 * **An empty set is what a repo without any of this looks like**, and it is deliberately
 * not distinguishable from a failure: a checkout that is not a git repo, a `dir` that
 * has been retired, a repo where no session has ever been archived. None of those is
 * something a list of beads should refuse to load over — the honest answer for every
 * one of them is "no row here has a session", which is exactly true for the last and
 * harmless for the others.
 */
export async function archivedBeads(dir) {
  const main = await ok(mainCheckout(dir));
  if (!main) return new Set();
  const out = await ok(git(main, ['for-each-ref', '--format=%(refname:lstrip=3)', SESSIONS_PREFIX]));
  if (!out) return new Set();
  return new Set(
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  );
}

/**
 * The debriefs archived for some beads — tier 4, read back.
 *
 * The write half is `debrief` in lib/memory.js and the storage note is there; this is the
 * other end, and it is here because the archive is what actually holds them: a debrief
 * lives as `memory.md` in a session's tree, so reading one is walking a bead's archive
 * newest-first until a session that left one turns up.
 *
 * Two limits, and they are different questions. `perBead` is how many runs at one bead are
 * worth quoting — one, for the push into a brief, because the last run is the one that
 * knows the current state of the work. `scan` bounds how far back to look *for* that one,
 * because most sessions leave no debrief at all and a bead with thirty archived runs and
 * none of them carrying a memory would otherwise be thirty `cat-file`s answering "no".
 *
 * Tolerant throughout, like `archivedBeads` and for the same reason: a repo that is not a
 * checkout, a bead never archived, a tree without the file — every one of them means "no
 * report here", and none is worth failing to open a session over.
 */
export async function readDebriefs(dir, beads, { perBead = 1, scan = 10 } = {}) {
  const main = await ok(mainCheckout(dir));
  if (!main) return [];
  const out = [];
  for (const bead of beads || []) {
    const history = await ok(
      git(main, ['log', '--format=%H%x00%aI', `--max-count=${scan}`, sessionRef(bead)])
    );
    if (!history) continue;
    let found = 0;
    for (const line of history.split('\n').filter(Boolean)) {
      if (found >= perBead) break;
      const [commit, at] = line.split('\0');
      const text = await ok(git(main, ['cat-file', '-p', `${commit}:memory.md`]));
      if (!text || !text.trim()) continue;
      out.push({ bead, commit, at, text: text.trim() });
      found += 1;
    }
  }
  return out;
}

/** One archived session's files, by the ref-commit that holds it. */
export async function readArchived(dir, commit, file = 'session.log') {
  const main = await mainCheckout(dir);
  const text = await ok(git(main, ['cat-file', '-p', `${commit}:${file}`]));
  return text;
}

/* ------------------------------------------------- reading one of them back, in full */

/** Where the sweep in lib/tidy.js puts a worktree it is finished with. */
const RETIRED_DIR = path.join('.claude', 'worktrees-retired');

/**
 * Where the worktree a session worked in has got to.
 *
 * `meta.json` records the path as it was *during* the session — `.claude/worktrees/<name>`
 * — and a session that finished weeks ago has almost certainly had that directory moved
 * out from under it. So the recorded path is a key to look up, never a place to read:
 *
 *   - **live** — still registered at exactly that path. Somebody is probably in it.
 *   - **retired** — soft-deleted into `.claude/worktrees-retired/<name>` by the sweep in
 *     lib/tidy.js, which *moves* the directory and leaves the registration pointing at
 *     the new place. So the recorded path is gone from `git worktree list` while the
 *     work is still on disk, and `.note` beside it says when. Not permanent: the same
 *     sweep removes it after `ATTIC_DAYS`.
 *   - **gone** — neither, which is the ordinary end state and not an error.
 *
 * Order matters and the order is not obvious: a retired worktree is **still a registered
 * worktree**, under its attic path, so "is it in `git worktree list`" answers yes for
 * both of the first two states. What separates them is *which path* the registration
 * carries, which is why this matches on the recorded path rather than on the name.
 *
 * There is no file browser in this app, so this deliberately answers "where did it go",
 * not "what is in it". The one thing worth looking at is the diff, and the diff lives on
 * GitHub: `pr` is the pull request for the branch where there is one, asked for only when
 * a caller passes `usePr` and `gh` can answer at all — a page load should not wait on the
 * network to say that a directory has been tidied away.
 */
export async function worktreeState(main, dir, branch = null, { usePr = false } = {}) {
  const name = path.basename(dir);
  const registered = parseWorktrees((await ok(git(main, ['worktree', 'list', '--porcelain']))) || '');
  // Through symlinks, not `path.resolve` — and this is the difference between "live" and
  // "gone" rather than a nicety. git reports worktree paths fully resolved; a path that
  // reached `meta.json` from anywhere else can keep a symlinked prefix, and on macOS
  // `/var/folders/…` and `/private/var/folders/…` are the same directory sharing not one
  // character of their first eight. Compared with `path.resolve` alone, a worktree
  // somebody is sitting in reads as removed. lib/tidy.js's `realPath` is the same answer
  // for the same reason, one layer down.
  const here = registered.find((w) => realPath(w.path) === realPath(dir));

  const atticDir = path.join(main, RETIRED_DIR, name);
  const retired = !here && fs.existsSync(atticDir);

  const state = here ? 'live' : retired ? 'retired' : 'gone';
  const stamp = retired ? retiredAt(`${atticDir}.note`) : null;

  return {
    name,
    path: dir,
    state,
    /**
     * The main checkout is a registered worktree too, and a real session records it.
     *
     * `worktreeOfSession` answers with whatever directory the session was actually running
     * in, which for anything that never called EnterWorktree is the checkout itself — and
     * that comes back here as `live`, correctly, under the repo's own name. "Its worktree:
     * live, beadcause" is true and reads as though the session had one. So the fact is
     * carried rather than folded into a fourth state: it is still live, it is just not a
     * worktree, and the page says the second part.
     */
    isMain: realPath(dir) === realPath(main),
    // Where it is *now*, which for a retired one is not where it was.
    at: here ? here.path : retired ? atticDir : null,
    // Somebody is sitting in a live one often enough that it is worth saying.
    locked: here ? here.locked : false,
    // The attic is not permanent — `.note` is what says how close this one is to being
    // swept, and an entry that predates the convention has no answer rather than a guess.
    retiredAt: stamp ? new Date(stamp).toISOString() : null,
    branch: branch || here?.branch || null,
    pr: branch && usePr && (await pr.available()).ok ? summarisePr(await pr.viewForBranch(main, branch)) : null,
  };
}

/** Only the fields a link needs: the whole `gh pr view` payload is a card's worth of JSON. */
function summarisePr(view) {
  if (!view) return null;
  const { number, url, title, state, isDraft, additions, deletions, changedFiles, mergedAt } = view;
  return { number, url, title, state, isDraft, additions, deletions, changedFiles, mergedAt };
}

/**
 * Everything the archived-session page states, for one bead, in one answer.
 *
 * `/session?pid=…` is live-only by construction and 404s once the process has gone,
 * which is the right answer for a live session and no answer at all for a bead that
 * closed in June. This is what the archived counterpart reads, and it is one call for
 * the same reason `/api/session-log` is: the facts, which session they belong to, and
 * *which of the three things this page shows even exist* have to agree, and three
 * requests that can each fail separately cannot promise that.
 *
 * `files` is the whole point of it. Each of the three sections — the memories, the log,
 * the worktree — is absent independently: a bead closed by hand from the phone has no
 * session at all, a session that crashed may have a log and no memory. Listing the tree
 * lets the page say "not available" as a *fact it was told*, rather than by firing a read
 * and rendering whatever the failure looked like — which is how you end up with a link
 * that opens an empty pane.
 *
 * Reads only, and never opens the archived files themselves: their text comes back
 * through `/api/session-archive?commit=&file=`, which is already the one place allowed to
 * name a file inside one of these trees.
 */
export async function readSessionDetail(dir, bead, { commit = null, limit = 20, usePr = false } = {}) {
  const main = await mainCheckout(dir);
  const { ref, sessions } = await readArchive(dir, bead, { limit });

  // A named commit has to be one of this bead's own sessions. Not a security boundary —
  // `/api/session-archive` is the reader and it does its own checking — but a commit from
  // another bead's ref would render as this bead's session, which is worse than a 404.
  const chosen = commit ? sessions.find((s) => s.commit === commit) : sessions[0];
  if (!chosen) return { ref, sessions, session: null, worktree: null };

  const files = ((await ok(git(main, ['ls-tree', '--name-only', chosen.commit]))) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let meta = null;
  if (files.includes('meta.json')) {
    const raw = await ok(git(main, ['cat-file', '-p', `${chosen.commit}:meta.json`]));
    try {
      meta = raw ? JSON.parse(raw) : null;
    } catch {
      // A meta.json we cannot parse is a session archived by something that has since
      // changed shape. The log and the memories are still readable, so this is a hole in
      // the metrics rather than a failed page.
      meta = null;
    }
  }

  return {
    ref,
    sessions,
    session: { ...chosen, files, meta },
    worktree: meta?.worktree ? await worktreeState(main, meta.worktree, meta.branch || null, { usePr }) : null,
  };
}
