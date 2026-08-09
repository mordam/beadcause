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
 * The transcript, as the CLI would have shown it.
 *
 * This is what makes the always-stored half small enough to keep forever: the raw
 * jsonl of a real session runs to megabytes, most of it tool-result payloads, and
 * the rendering is tens of kilobytes of the part a person would read. It reuses
 * `renderEvent` from lib/agentlog.js rather than a second renderer, so an archived
 * log and the live pane on the phone say the same thing in the same shape.
 */
function renderTranscripts(files) {
  const out = [];
  let bytes = 0;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
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
        return out;
      }
      out.push(rendered);
    }
  }
  return out;
}

const NOTES_REF = 'refs/notes/beadcause';
const sessionRef = (bead) => `refs/beadcause/sessions/${bead}`;

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
export async function mergeCommitFor(main, head) {
  const merged = await git(main, ['merge-base', '--is-ancestor', head, 'main']).then(() => true, () => false);
  if (!merged) return null;
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

export async function noteMerge(main, { sha, bead, workspace, ref }) {
  await note(main, sha, `beadcause: landed ${workspace}/${bead}\nsession log: ${ref}`);
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
    transcript: includeTranscript ? transcripts.map((t) => t.path) : [],
    transcriptBytes,
    archivedBy: 'beadcause',
  };

  // A work session's output goes to its iTerm window and nowhere else, so unless the
  // caller captured something, the transcript IS the log — rendered down to the part
  // worth reading.
  const lines = logLines.length ? logLines : renderTranscripts(transcripts);

  const entries = [
    ['meta.json', Buffer.from(JSON.stringify(meta, null, 2) + '\n')],
    ['session.log', Buffer.from((lines.join('\n') || '(no transcript was found for this session)') + '\n')],
  ];

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
  // cannot lose one another's entry.
  await git(main, ['update-ref', ref, commit, ...(parent ? [parent] : [])]);

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

  return { ref, commit, commits, branch, head, merged, transcriptBytes, includedTranscript: entries.length > 2 };
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

/** One archived session's files, by the ref-commit that holds it. */
export async function readArchived(dir, commit, file = 'session.log') {
  const main = await mainCheckout(dir);
  const text = await ok(git(main, ['cat-file', '-p', `${commit}:${file}`]));
  return text;
}
