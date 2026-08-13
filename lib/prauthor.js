import { readArchive, readArchived } from './sessionlog.js';

/**
 * Which agent wrote this pull request — answered from the repo, or not at all.
 *
 * The full-screen PR view (bc-l8jp.7) asks for "which agent authored the work", and the
 * honest answer took some finding, because the obvious ones are all wrong:
 *
 * - **GitHub's `author.login`** is the account whose `gh` pushed the branch. On this Mac
 *   that is Adam for every pull request an advocate's session ever opened, which makes it
 *   the one field that can never tell two sessions apart.
 * - **`~/.config/beadcause/logs/`** is per-bead and is overwritten by the next attempt on
 *   the same bead, so the session that produced *this* branch may already be gone from it.
 * - **The advocate's `workers` array** is live state: it holds the windows open right now,
 *   and a merged pull request is by definition one whose window closed.
 *
 * What does know is the session archive lib/sessionlog.js writes into the repo's own refs
 * when a session ends: `refs/beadcause/sessions/<bead-id>`, a commit per session whose
 * `meta.json` carries the session id, the branch it worked on, when it started, when it
 * ended and how. That is the record of the thing that actually did the work, it is kept
 * next to the commits rather than on one laptop's disk, and it survives the worktree being
 * retired and the branch being deleted.
 *
 * So the lookup is: **the archived session whose branch is this pull request's branch.**
 *
 * ## Three answers, and none of them is a guess
 *
 * - `kind: 'session'` — an archive entry names this branch. This is the real answer, and
 *   `matched` is true.
 * - `kind: 'session'` with `matched: false` — the bead has archived sessions but none of
 *   them worked this branch. That happens for real: a bead worked twice, where the first
 *   attempt's branch is the one that opened the PR and the second is the one that ended
 *   last. Reported as the newest session *with the mismatch stated*, because "a session on
 *   this bead, but not this branch" is worth more than nothing and much less than a match.
 * - `kind: 'github'` — nothing is archived under any bead this row names, so the login is
 *   all there is. Also the answer for a pull request opened by hand, which is a perfectly
 *   ordinary thing for this board to be showing.
 *
 * Nothing here ever says "a beadcause worker" on the strength of the PR body's boilerplate.
 * bin/deliver.js writes that sentence into every pull request it opens, so matching on it
 * would attribute the work to "a worker session" whether or not one could be found — which
 * is exactly the failure this file is written to avoid: an attribution that is always
 * available and therefore says nothing.
 */

/** How many archived sessions per bead to read before giving up on a branch match. */
const MAX_SESSIONS = 12;

/** `meta.json` for one archive commit, or null for anything that is not readable JSON. */
async function metaOf(dir, commit) {
  let text;
  try {
    text = await readArchived(dir, commit, 'meta.json');
  } catch {
    return null;
  }
  // `readArchived` resolves to null rather than throwing for a commit git will not
  // read — an archive written before meta.json existed, a ref that has been gc'd.
  if (!text) return null;
  try {
    const meta = JSON.parse(text);
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

/** The shape the phone draws, built from one archive entry. */
const fromMeta = (meta, entry, bead, matched) => ({
  kind: 'session',
  matched,
  bead,
  // Eight characters is what identifies a session in Claude Code's own output, and the
  // rest of the uuid is no more useful on a phone. The whole id rides along anyway,
  // because it is what `git log refs/beadcause/sessions/<bead>` is searched with.
  sessionId: meta.sessionId || null,
  branch: meta.branch || null,
  worktree: meta.worktree || null,
  outcome: meta.outcome || null,
  startedAt: meta.startedAt || null,
  endedAt: meta.endedAt || entry?.at || null,
  commits: Array.isArray(meta.commits) ? meta.commits.length : 0,
  archive: entry?.commit || null,
});

/**
 * Who wrote the work behind one board row.
 *
 * `dir` is the repo's checkout — the archive lives in its object database, so this is
 * local git and nothing else; no network, and no `gh`. `row` is one entry from
 * lib/prboard.js, passed whole: the branch is what identifies the session and the beads
 * are which refs to look under.
 *
 * Never throws. An attribution is the last line of a facts list, and a repo with no
 * archive at all — a fresh clone, a tracker with no sessions ever run in it — is the
 * ordinary case rather than an error worth failing a screen over.
 */
export async function authorOf(dir, row, { limit = MAX_SESSIONS } = {}) {
  const login = String(row?.author || '');
  const branch = String(row?.branch || '');
  const beads = (row?.beads || []).map((b) => (typeof b === 'string' ? b : b?.id)).filter(Boolean);
  const github = { kind: 'github', matched: false, login, bead: beads[0] || null };
  if (!dir) return github;

  /** The newest archived session across every bead, for the fallback below. */
  let newest = null;

  for (const bead of beads) {
    let sessions = [];
    try {
      ({ sessions = [] } = await readArchive(dir, bead, { limit }));
    } catch {
      continue;
    }
    for (const entry of sessions) {
      const meta = await metaOf(dir, entry.commit);
      if (!meta) continue;
      // The match, and the only answer that is really an answer. Returned the moment it
      // is found: `readArchive` is newest-first, so the first branch match is the last
      // session that worked this branch, which is the one that opened the pull request.
      if (branch && meta.branch === branch) return { ...fromMeta(meta, entry, bead, true), login };
      if (!newest) newest = { ...fromMeta(meta, entry, bead, false), login };
    }
  }

  return newest || github;
}
