/**
 * Who else is live on this bead right now — pid, worktree, work in hand, and how to
 * reach them.
 *
 * bc-7qo.24. Three sessions asked this by hand, on different beads, with a different
 * partial instrument each time. bc-7qo.11 guessed a worktree slug, had `EnterWorktree`
 * silently resume a *live* peer's tree, and only caught it when an `Edit` failed to
 * match a string it had read four minutes earlier — then spent several more calls on
 * `ps`, `cat .git/worktrees/<name>/locked` and two `ListAgents` round trips just to get
 * a messageable name. bc-xl7n.113.1 folded a bare `pgrep`/`lsof` cwd census into its
 * first tool call — a list with no bead, no branch, no dirty state in it. bc-xl7n.113.2
 * got there a third way, `cd`-ing into a sibling's worktree to read its uncommitted
 * diff directly. Measured cost: two windows built the identical fix independently, one
 * of the two committed and died without pushing, and a regression whose only test lived
 * in the dead tree still merged clean — because four windows on one bead was invisible
 * to `advocates.json`, which believed it held two.
 *
 * ## What this reuses, and why there is so little new code here
 *
 * - **`branchesFor`** (lib/prior.js) already answers "every worktree — live or
 *   retired — and every branch owning this bead's tag, whether pushed and how far
 *   ahead of main". A worktree entry there already tells `live` from `retired` by path
 *   prefix, because `git worktree list --porcelain` reports both in one call — retiring
 *   is `git worktree move`, not `remove`.
 * - **`liveSessions`** (lib/claude.js) is `~/.claude/sessions/*.json`, liveness-checked
 *   — pid, cwd, chosen name, busy/idle status. A worktree's row above and a session's
 *   `cwd` are matched through `realPath`, the same symlink-safe compare `lib/tidy.js`'s
 *   own occupancy check uses, for the same `/var` vs `/private/var` reason.
 * - **`liveProcessLines`** (lib/claude.js) closes the one gap neither of the above can:
 *   a session that has not yet run `EnterWorktree` — no branch, no worktree, sometimes
 *   not even its own rename done — leaving its argv the only thing naming the bead at
 *   all. `sessionCommand` (lib/session.js) puts the *qualified* `<workspace>/<id>` on
 *   `claude`'s own command line from the moment the shell reaches it.
 * - **`namesBead`** (lib/reap.js) is the one word-boundary match every one of the above
 *   already trusts to say "this text names this bead" — used here exactly as
 *   lib/advocate.js and lib/claude.js already use it, not reimplemented.
 *
 * ## The disk state a peer window is in — never the guard's line ranges
 *
 * `scripts/claim-guard.sh` / lib/claims.js report *intent* — what a session said it
 * was about to touch — and bc-7qo.11's own debrief is the record of reading that as if
 * it were the tree: only the first of three claimed ranges had actually been written.
 * `diskState` below is `git status --porcelain` in the worktree itself, nothing else —
 * `dirty` for uncommitted work, `committed-pushed`/`committed-unpushed` for commits
 * ahead of `main` depending on whether `origin/<branch>` already carries the tip, and
 * `empty` for a worktree that exists and has done nothing yet. A worktree this cannot
 * reach at all (registered, directory gone) reads as `gone`, same word `lib/prior.js`
 * uses for "no worktree left" on a branch with none.
 */
import { git, ok, mainCheckout } from './gitref.js';
import { realPath } from './tidy.js';
import { branchesFor } from './prior.js';
import { liveSessions, liveProcessLines } from './claude.js';
import { namesBead } from './reap.js';

/** A survey read before a decision, not instead of one — it must not itself hang. */
const STATUS_TIMEOUT_MS = 5000;

/** How old a session record's `startedAt` is right now, or null if it cannot say. */
function ageMs(startedAt) {
  if (!startedAt) return null;
  const at = Date.parse(startedAt);
  if (!Number.isFinite(at)) return null;
  const delta = Date.now() - at;
  return delta >= 0 ? delta : null;
}

/**
 * `dirty`, `committed-pushed`, `committed-unpushed`, `empty` or `gone` — the actual disk
 * state of one `branchesFor` row, read fresh, never inferred from the branch alone.
 *
 * `b.worktree` null means the branch itself has no worktree left (removed, or aged out
 * of the attic) — `git status` has nowhere to run, so this is `gone` regardless of how
 * far ahead the branch is; the row still carries `ahead`/`subject`/`pushed` from
 * `branchesFor` for whoever reads it. A worktree entry whose directory has actually
 * vanished (registered, `rm -rf`'d without `git worktree remove`) reads the same way —
 * `git status` there fails, and failing to answer is not the same claim as "nothing
 * uncommitted".
 */
async function diskState(main, b) {
  if (!b.worktree) return 'gone';
  const out = await ok(git(b.worktree.path, ['status', '--porcelain'], { timeout: STATUS_TIMEOUT_MS }));
  if (out === null) return 'gone';
  const dirty = out.split('\n').filter(Boolean).length;
  if (dirty) return 'dirty';
  if (!b.ahead) return 'empty';
  return b.pushed ? 'committed-pushed' : 'committed-unpushed';
}

/**
 * Every live window naming this bead right now, plus every dead tree its branch left
 * behind — one row each, from three sources layered cheapest-and-most-certain first.
 *
 * `workspace` is optional but is what lets the third source (argv, for a window that
 * has not renamed itself or cut a worktree yet) run at all — `linesNameBead`'s own
 * header explains why a bare id is not enough to match a process's whole command line
 * safely, so without a workspace that source is simply skipped, not guessed at.
 */
export async function windowsFor(dir, id, { cfg = {}, workspace = null } = {}) {
  const main = await mainCheckout(dir);
  const branches = await branchesFor(main, id);
  const sessions = liveSessions(cfg);
  const claimed = new Set();
  const rows = [];

  for (const b of branches) {
    // eslint-disable-next-line no-await-in-loop -- one branch's status at a time, same as lib/siblings.js
    const state = await diskState(main, b);
    const wtReal = b.worktree ? realPath(b.worktree.path) : null;
    const session = wtReal ? sessions.find((s) => s.cwd && realPath(s.cwd) === wtReal) : null;
    if (session) claimed.add(session.pid);
    rows.push({
      kind: 'branch',
      branch: b.branch,
      worktree: b.worktree,
      state,
      ahead: b.ahead,
      subject: b.subject,
      tip: b.tip,
      pushed: b.pushed,
      session: session
        ? { pid: session.pid, name: session.name || null, status: session.status || null, startedAt: session.startedAt, ageMs: ageMs(session.startedAt), source: 'record' }
        : null,
    });
  }

  // A window that names this bead but has no worktree yet — the gap before its first
  // `EnterWorktree`, which is exactly where bc-7qo.11 and two of its siblings were
  // standing when they collided. Matched by the session's own chosen name.
  for (const s of sessions) {
    if (claimed.has(s.pid)) continue;
    if (!namesBead(s.name, id)) continue;
    claimed.add(s.pid);
    rows.push({
      kind: 'session',
      branch: null,
      worktree: null,
      state: 'no-worktree',
      ahead: null,
      subject: '',
      tip: null,
      pushed: null,
      session: { pid: s.pid, name: s.name || null, status: s.status || null, startedAt: s.startedAt, ageMs: ageMs(s.startedAt), source: 'record' },
    });
  }

  // A window whose own rename has not landed yet, or silently failed — its argv still
  // carries the qualified `workspace/id` from the instant the shell reached `claude`.
  if (workspace) {
    const lines = await liveProcessLines().catch(() => []);
    for (const l of lines) {
      if (claimed.has(l.pid)) continue;
      if (!namesBead(l.args, `${workspace}/${id}`)) continue;
      claimed.add(l.pid);
      rows.push({
        kind: 'process',
        branch: null,
        worktree: null,
        state: 'no-worktree',
        ahead: null,
        subject: '',
        tip: null,
        pushed: null,
        session: { pid: l.pid, name: null, status: null, startedAt: null, ageMs: null, source: 'argv' },
      });
    }
  }

  return rows;
}

/** True when nothing anywhere names this bead — a bead nobody has ever opened a window on. */
export function isEmpty(rows) {
  return rows.length === 0;
}

/**
 * Every session-carrying name in `rows`, deduped — the caveat a printed report owes:
 * `ListAgents` is what actually resolves the address `SendMessage` will accept, and it
 * falls back to a short slug (`beadcause-2b`) exactly when two live sessions share one
 * display name — the same collision that cost bc-7qo.11 two failed `SendMessage` calls.
 * This cannot see that collision against *other* beads' windows, only within its own
 * rows, so it can only warn, never promise a name is unique.
 */
function ambiguousNames(rows) {
  const counts = new Map();
  for (const r of rows) {
    const name = r.session?.name;
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name));
}

/** One printed report for one bead's `windowsFor` result. */
export function describeWindows(id, rows) {
  const lines = [];
  if (isEmpty(rows)) {
    lines.push(`No live window and no branch or worktree anywhere names ${id}.`);
    return lines;
  }

  const dupes = ambiguousNames(rows);
  const age = (ms) => (ms === null ? 'unknown age' : ms < 60000 ? '<1m' : `${Math.round(ms / 60000)}m`);

  for (const r of rows) {
    const who = r.session
      ? `pid ${r.session.pid} (${age(r.session.ageMs)}${r.session.status ? `, ${r.session.status}` : ''})${
          r.session.source === 'argv' ? ' — argv only, not yet renamed' : ''
        }`
      : 'no live process';
    const title = r.session?.name ? `"${r.session.name}"` : '(no name yet)';
    const where = r.worktree
      ? `${r.worktree.state} worktree${r.worktree.locked ? ', locked' : ''} at ${r.worktree.path}`
      : r.branch
        ? 'no worktree (removed, or aged out)'
        : 'no worktree yet';
    const branch = r.branch ? ` on ${r.branch}` : '';
    const state =
      r.state === 'committed-unpushed'
        ? `${r.ahead} commit${r.ahead === 1 ? '' : 's'} ahead of main, not pushed${r.subject ? ` — newest: "${r.subject}"` : ''}`
        : r.state === 'committed-pushed'
          ? `${r.ahead} commit${r.ahead === 1 ? '' : 's'} ahead of main, pushed to origin`
          : r.state === 'dirty'
            ? 'uncommitted changes'
            : r.state === 'empty'
              ? 'nothing done yet'
              : r.state === 'gone'
                ? 'no working tree left to read'
                : 'no worktree yet';

    lines.push(`${who} — ${title}${branch}`);
    lines.push(`  ${where}; ${state}`);
    if (r.session?.name) {
      lines.push(
        `  SendMessage: "${r.session.name}"${dupes.has(r.session.name) ? ' (shared by another row here — call ListAgents to get the disambiguated name)' : ''}`
      );
    } else if (r.session) {
      lines.push('  SendMessage: not yet named — call ListAgents once its rename lands');
    }
  }
  return lines;
}
