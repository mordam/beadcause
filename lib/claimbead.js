/**
 * Which *bead* a file claim is for — resolved once per branch, in the daemon.
 *
 * A claim record has always carried a `bead` field and `scripts/claim-guard.sh` has
 * always left it empty, so a refusal read `held by worktree-park-epic-p9vx` rather than
 * `held by bc-p9vx`. That leads you to the right place, because every worktree on this
 * Mac ends in its bead's own tag — but it is one hop short of the id, and the hop is the
 * difference between a sentence you can act on and one you have to go and decode.
 *
 * ## Why not in the hook, where the branch is already known
 *
 * It was tried there and taken back out. The honest source in a session is its declared
 * title in the transcript, which cost a 20KB tail read and two more processes on **every
 * Write in every session on this Mac** — measured as part of the 128ms the first version
 * of that hook took, against 75ms for the folded one. The cheap alternative is the branch
 * tail, and a tail is a guess: `candidateTiers` in lib/beadref.js is explicit that a
 * guess must not pass as an answer, and verifying one needs the tracker prefix, which
 * needs `bd`, which is not a thing to spawn in front of an edit.
 *
 * The daemon already holds the workspaces and already talks to `bd`, and — this is the
 * whole reason the cost works out — the question is **per branch, not per claim**. Thirty
 * branches ever, against thousands of claims a day. So it is asked once, the answer is
 * kept, and every later claim from that branch is a map lookup.
 *
 * ## Verified, never guessed
 *
 * `worktree-park-epic-p9vx` yields the tail `p9vx`, and `bc-p9vx` is a *candidate*. It
 * becomes an answer only when `bd show` says that bead exists, exactly the way `beadsFor`
 * settles a pull request's tiers. A branch nobody named after a bead — `worktree-x-g15`,
 * a hand-made tree, `main` — produces candidates that resolve to nothing, and nothing is
 * what the field keeps.
 *
 * The one wrinkle is that the tag is **lossy**: `tagOf` in lib/notinmain.js strips the
 * punctuation a ref cannot hold, so `bc-p49x.5` and `bc-p49x5` both become `p49x5` and
 * the tail alone cannot tell them apart. Most beads with a live worktree here are the
 * children of an epic, so reading only the undotted form would leave the field empty for
 * most of this Mac — hence the trailing-digit candidates below. Where more than one of
 * them turns out to exist the branch genuinely is ambiguous, and the field stays empty:
 * two beads whose tags collide cannot be told apart by a branch name, and naming the
 * wrong one is worse than naming none.
 *
 * ## Never on the hot path
 *
 * `POST /api/claims` is the hottest write in the daemon and its budget is a map write —
 * see lib/claims.js on why `claim()` has no `await` in it. So nothing here is awaited by
 * a request: the first claim from a branch starts the lookup and answers without it, and
 * the answer is written onto the records by `attribute` when it arrives. Which costs the
 * very first refusal on a fresh branch its bead name and nothing else, since by the time
 * a *second* session collides with that branch the lookup is long settled.
 *
 * A tracker that could not be read is not an answer and is not cached — the same
 * distinction `prefixFor` makes about a workspace mid-write, and the one lib/homing.js
 * makes about an empty index. A bead that does not exist *is* an answer, and is.
 */
import { prefixFor } from './beadref.js';
import { ownWorkspace } from './deploy.js';

/**
 * `bd show` on an id nothing matches exits non-zero, so "no such bead" arrives as a
 * rejection wearing the same clothes as a Dolt lock or a timeout. Only this one is a
 * decision; the rest have to be asked again later, or a tracker that was busy for a
 * second silently costs a branch its bead for the life of the daemon.
 */
const MISSING_RE = /no issues? found/i;

/**
 * The ids a branch could be naming, strongest first.
 *
 * The tail is the segment after the last dash, which is where `tagOf` puts the id — and
 * an id's punctuation is gone by then. So the undotted reading comes first, and then the
 * readings that put a dot back in front of a trailing digit or two, which is the only
 * shape a child id has here (`bc-p49x.5`, `bc-goo.15`). A grandchild would need two dots
 * back and is not generated: none exists on this Mac, and every extra candidate is
 * another way to resolve to the wrong bead.
 */
export function candidateIds(prefix, branch) {
  if (!prefix) return [];
  const tail = String(branch || '')
    .split('-')
    .pop()
    .toLowerCase();
  if (!/^[a-z0-9]{2,12}$/.test(tail)) return [];
  const out = [`${prefix}-${tail}`];
  for (const n of [1, 2]) {
    const head = tail.slice(0, -n);
    const digits = tail.slice(-n);
    if (head.length >= 2 && /^[0-9]+$/.test(digits)) out.push(`${prefix}-${head}.${digits}`);
  }
  return out;
}

/**
 * The lookup, wired to a config and a `bd`.
 *
 * `attribute` is lib/claims.js's — kept as an argument rather than imported so this file
 * is drivable from a test without a register, and so the one write it performs is visible
 * at the call site in lib/server.js.
 */
export function createBranchBeads({ cfg, bd, attribute, log = console.log }) {
  // (repo, branch) → the promise of its answer. Keyed by both because two repos can carry
  // a branch of the same name and `main` is the obvious one. Never expires: a branch's
  // bead does not change, and the map is bounded by the branches this daemon has seen.
  const asked = new Map();

  /** Which workspace's tracker this checkout belongs to, or nothing. */
  const workspaceFor = (repo) => {
    try {
      const name = ownWorkspace(cfg, repo);
      return name ? (cfg.workspaces || []).find((w) => w.name === name) || null : null;
    } catch {
      // A config this Mac cannot resolve is not a reason to lose the claim it arrived
      // with. Same rule the rest of this file follows: no bead, never no answer.
      return null;
    }
  };

  /** Does this bead exist? Throws only when the *tracker* could not say. */
  const exists = async (ws, id) => {
    try {
      return Boolean(await bd.show(ws, id));
    } catch (err) {
      if (MISSING_RE.test(String((err && err.message) || ''))) return false;
      throw err;
    }
  };

  const resolve = async (repo, branch) => {
    const ws = workspaceFor(repo);
    if (!ws) return '';
    const prefix = await prefixFor(bd, ws);
    // No prefix is a tracker that could not be read — `prefixFor` swallows its own error
    // and answers null, and it answers null for a workspace with no beads in it at all.
    // Neither is a verdict about this branch, so neither may be cached as one. The cost of
    // saying so is one `bd list --limit 1` per edit in a repo whose tracker is genuinely
    // empty; the cost of the other reading is a Dolt lock lasting a second taking the bead
    // off every claim from that branch for the life of the daemon.
    if (!prefix) throw new Error(`no id prefix for ${ws.name} — an empty or unreadable tracker`);
    const ids = candidateIds(prefix, branch);
    if (!ids.length) return '';
    const found = [];
    for (const id of ids) if (await exists(ws, id)) found.push(id);
    // Two matches is an ambiguous tag rather than a choice — see the header.
    if (found.length > 1) log(`[beadcause] ${branch} could be ${found.join(' or ')} — leaving its claims unattributed`);
    return found.length === 1 ? found[0] : '';
  };

  return {
    /**
     * Start (or reuse) the lookup for this branch, and write the answer onto its claims.
     *
     * Returns the promise, which nothing on the request path awaits and every test does.
     */
    follow(repo, branch) {
      if (!repo || !branch) return Promise.resolve('');
      const k = JSON.stringify([repo, branch]);
      if (asked.has(k)) return asked.get(k);
      const pending = resolve(repo, branch).then(
        (id) => {
          if (id) attribute(repo, branch, id);
          return id;
        },
        (err) => {
          // Unreadable rather than absent: drop the memo so the next edit asks again.
          asked.delete(k);
          log(`[beadcause] could not resolve a bead for ${branch}: ${(err && err.message) || err}`);
          return '';
        }
      );
      asked.set(k, pending);
      return pending;
    },

    /** Tests, and anything that knows a tracker was replaced. */
    forget: () => asked.clear(),
  };
}
