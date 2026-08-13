/**
 * Which file each session is editing, right now.
 *
 * Thirty live worktrees against one repo, and until this the only occupancy answer
 * anything had was at *tree* granularity: `git worktree lock .` with a pid-bearing
 * reason (bc-7uie). Two sessions in two worktrees editing `lib/foo.js` never clobber
 * each other — separate checkouts — they collide at downmerge, as a semantic conflict
 * nobody sees until the merge. Nothing warned either of them, and nothing could answer
 * the question a session actually has when it arrives at a file: *is anyone on this?*
 *
 * This is the register that answers it. lib/presence.js is its near relative and the
 * shape is deliberately the same one — a TTL'd map, pruned as it is read, bounded field
 * by field because a report is a claim by a client rather than a fact.
 *
 * ## Why not the harness's own agent-ref comms API
 *
 * `ListAgents`/`SendMessage` is the obvious reach and it is the wrong primitive, for
 * four reasons that are worth keeping written down because it is the decision most
 * likely to be re-litigated (bc-q5c2):
 *
 * 1. **It cannot refuse.** The reason `git worktree lock` was chosen for tree occupancy
 *    is that the *attempt* is the check — exit 128, no gap between reading and taking. A
 *    broadcast has no such semantics: two sessions announce the same file in the same
 *    tick and both proceed, which is the check-then-act race that put conflict markers
 *    into `public/console.js` in bc-utyr. `claim()` below is the taking *and* the asking,
 *    in one synchronous call, for exactly that reason.
 * 2. **It has no state.** The useful question is not "let me tell everyone" at claim time
 *    but "is anyone on this?" at arrival time. A broadcast reaches only sessions that
 *    already exist; the one that starts ten minutes later learns nothing.
 * 3. **It is O(N) turns per claim** — an injected turn in a dozen other contexts, most
 *    irrelevant, and a busy peer reads it after its current turn, possibly after it has
 *    already written the file.
 * 4. **It sees only same-harness peers**, which README already worked out. The occupancy
 *    incident behind bc-7uie was a window opened *by hand*.
 *
 * ## Not lib/lease.js, and the difference is the scope
 *
 * That one is the **bead**-level claim, and it lives in the tracker because the tracker is
 * the one thing two Macs share: it exists so two advocates on two machines do not open two
 * windows on one bead. This is **file**-level, on one machine, and deliberately nowhere but
 * memory. The two do not overlap and neither makes the other redundant — a bead can be
 * legitimately held by one session while five other sessions edit files that bead's work
 * happens to touch.
 *
 * ## In memory, never on disk
 *
 * Same argument lib/presence.js makes about a phone's whereabouts, and it is stronger
 * here: a claim is worth exactly as long as the session holding it, and a record that
 * outlived the daemon would be a lie about who is editing something — the expensive
 * direction, because it makes a live session stand down for a dead one, which is how a
 * file becomes permanently un-editable. A restart forgets, every session re-claims on
 * its next edit, and "nothing here knows of a claim on this" is the correct answer.
 *
 * ## Two liveness signals, not one
 *
 * A TTL alone is a poor fit: a session mid-test-run legitimately goes quiet for twenty
 * minutes and is still on the file. So the TTL is generous (`TTL_MS`), and the decisive
 * signal is the second one — **a worktree that is no longer on disk holds nothing.**
 * Shipping removes the tree (`.claude/worktrees-retired/`), so `ship` releases every
 * claim a session held without knowing this file exists.
 *
 * ## Nothing here touches the bus
 *
 * Deliberate, and not an oversight. lib/server.js's poll treats any event that is not
 * `presence` as a reason to sweep `bd` — so an event per claim would put a tracker sweep
 * behind every keystroke-level edit in every session on this Mac. Claims are read by
 * asking (`GET /api/claims`), and until something follows them the way the mirror
 * follows presence, an event would be a cost with no reader.
 */
import fs from 'node:fs';

/**
 * How long a claim outlives the last edit that renewed it.
 *
 * Ninety minutes rather than presence's fifteen: a heartbeat is sent by a page every
 * half minute, but a claim is renewed only when the session touches that file again,
 * and the gap between two edits of one file spans a test run, a review and a downmerge.
 * The cost of erring long is a stale warning naming a session that has moved on; the
 * cost of erring short is silence in the case this exists for.
 */
export const TTL_MS = 90 * 60 * 1000;

/** Long enough for any repo-relative path in this tree; short enough to be no payload. */
const MAX_LEN = 300;

/**
 * pathKey → Map<session, record>, and a record is in one of two states.
 *
 * `held` and `told`, and that it is not a boolean is the whole design. A collision is not
 * a thing to forbid — two branches editing one file is ordinary, and a register that
 * refused it for ever would be a register everybody turns off. So the first attempt
 * against a file somebody else holds is **refused once, with the holder named**, and the
 * refusal *records the intent* as `told`: the session that has been told and means it
 * anyway claims the file on its next attempt. One wasted tool call buys the warning, and
 * nothing is permanently blocked.
 */
const paths = new Map();

const str = (v) => (v == null ? '' : String(v).slice(0, MAX_LEN));

/**
 * One key from a repo and a path within it.
 *
 * `JSON.stringify` rather than joining on a separator, because both halves are file paths
 * and every cheap separator is legal in one of them — a NUL would do it and cannot be
 * written here, since `test/filter.mjs` fails the repo for an invisible control byte in
 * source, which is the right rule and caught this line. Two strings in an array cannot
 * collide however either one is spelled.
 */
const key = (repo, file) => JSON.stringify([repo, file]);

/**
 * A session id, reduced to something safe to use as a map key and print in a refusal.
 *
 * The harness's is a uuid; a caller that invents its own gets the same treatment
 * lib/presence.js gives a device id, for the same reason — this string ends up in a
 * message a person reads.
 */
const sessionId = (v) => str(v).replace(/[^\w.-]/g, '');

/**
 * Is the tree this claim was made from still there? See the header.
 *
 * A `stat` that throws answers `true`: an unreadable path is a question this cannot
 * answer, and the expensive direction is dropping a live session's claim.
 */
const onDisk = (dir) => {
  try {
    return fs.existsSync(dir);
  } catch {
    return true;
  }
};

/**
 * Drop what has gone, as the register is read.
 *
 * `alive` is injectable for the tests, which have no worktrees; everything else leaves
 * it alone and pays one `existsSync` per record examined.
 */
function prune(now, alive = onDisk) {
  for (const [k, bucket] of paths) {
    for (const [id, rec] of bucket) {
      // `rec.dir &&` is the rule rather than the checker's business: a claim that named
      // no tree is not asserted to be dead, because "I cannot tell" is not "it is gone" —
      // the distinction lib/resolvers.js and lib/advocate.js both keep, and for the same
      // reason. Treating it as absence is what frees a file out from under a live session.
      if (now - Date.parse(rec.at) > TTL_MS || (rec.dir && !alive(rec.dir))) bucket.delete(id);
    }
    if (!bucket.size) paths.delete(k);
  }
}

/** Everything currently held on a path by somebody other than `session`. */
function othersOn(bucket, session) {
  return [...bucket.values()].filter((r) => r.session !== session && r.state === 'held');
}

/**
 * Claim a file — and find out in the same breath who else is on it.
 *
 * Returns `{ decision, record, holders, sameTree }`:
 *
 *   - `decision: 'held'` — it is yours. Either nobody else was on it, or you had already
 *     been told and came back anyway (`insisted` is true for the second case, because a
 *     log line that cannot tell those apart cannot tell a collision from a clean claim).
 *   - `decision: 'conflict'` — somebody else holds it, they are named in `holders`, and
 *     your intent is recorded so the next attempt succeeds.
 *
 * `sameTree` marks the dangerous kind: another session **in your own worktree**, which
 * is the bc-utyr shape rather than a merge-time collision, and the one case where two
 * sessions genuinely overwrite each other's bytes.
 *
 * There is no `await` anywhere in here on purpose. This is the whole race guarantee: two
 * requests arriving a moment apart cannot both observe an empty bucket, because the
 * observation and the write happen in one tick. lib/resolvers.js needs a lock to get the
 * same property; this gets it by having nothing to wait for.
 */
export function claim(session, payload = {}, now = Date.now(), { alive = onDisk } = {}) {
  const id = sessionId(session);
  const repo = str(payload.repo);
  const file = str(payload.file);
  if (!id || !repo || !file) return null;

  prune(now, alive);

  const k = key(repo, file);
  let bucket = paths.get(k);
  if (!bucket) paths.set(k, (bucket = new Map()));

  const stamp = new Date(now).toISOString();
  const prev = bucket.get(id);
  const others = othersOn(bucket, id);

  // Being told and coming back is the promotion. A session that was never told and finds
  // the file free is the ordinary case, and both end up 'held' — what differs is whether
  // anything was said, which is what `insisted` records.
  const insisted = Boolean(others.length && prev && prev.state === 'told');
  const state = !others.length || insisted ? 'held' : 'told';

  const record = {
    session: id,
    repo,
    file,
    label: str(payload.label) || repo.split('/').pop(),
    dir: str(payload.dir),
    branch: str(payload.branch),
    bead: str(payload.bead),
    state,
    at: stamp,
    // When this session arrived at this file — the age worth showing, and it has to
    // survive the renewals that keep the record alive. Same rule as presence's `since`.
    since: prev && prev.state === state ? prev.since : stamp,
  };
  bucket.set(id, record);

  return {
    decision: state === 'held' ? 'held' : 'conflict',
    insisted,
    record,
    holders: others,
    sameTree: others.some((r) => r.dir && record.dir && r.dir === record.dir),
  };
}

/** Who holds this path, other than `session`. A read; claims nothing. */
export function holders(repo, file, { session = '', now = Date.now(), alive = onDisk } = {}) {
  prune(now, alive);
  const bucket = paths.get(key(str(repo), str(file)));
  return bucket ? othersOn(bucket, sessionId(session)) : [];
}

/**
 * A session letting go — of one path, or of everything it held.
 *
 * Called when a session ends, and it is the honest half of the TTL: a session that says
 * it has gone should not leave a file looking busy for ninety minutes. Returns how many
 * records went, because "released 0" and "released 7" are different sentences in a log.
 */
export function release(session, { files = null } = {}) {
  const id = sessionId(session);
  if (!id) return 0;
  let gone = 0;
  for (const [k, bucket] of paths) {
    const rec = bucket.get(id);
    if (!rec) continue;
    if (files && !files.map((f) => str(f)).includes(rec.file)) continue;
    bucket.delete(id);
    gone += 1;
    if (!bucket.size) paths.delete(k);
  }
  return gone;
}

/** Every live claim, newest word first. */
export function list(now = Date.now(), { alive = onDisk } = {}) {
  prune(now, alive);
  const out = [];
  for (const bucket of paths.values()) out.push(...bucket.values());
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The files more than one session is holding — the answer to "what is about to collide",
 * without anyone having to read a flat list of claims and spot the repeats.
 *
 * Only `held` counts. A session that was told and has not come back is not on the file,
 * and listing it as a collision would report the warning as the thing it warned about.
 */
export function collisions(now = Date.now(), { alive = onDisk } = {}) {
  prune(now, alive);
  const out = [];
  for (const bucket of paths.values()) {
    const held = [...bucket.values()].filter((r) => r.state === 'held');
    if (held.length < 2) continue;
    // Only trees that were actually named can be compared. Two claims that both arrived
    // without a `dir` are not "in the same worktree", they are two unknowns, and calling
    // that the dangerous kind would put bc-utyr's wording on an ordinary collision.
    const trees = held.map((r) => r.dir).filter(Boolean);
    out.push({
      repo: held[0].repo,
      file: held[0].file,
      sessions: held.sort((a, b) => a.since.localeCompare(b.since)),
      sameTree: new Set(trees).size < trees.length,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * What the refusal says.
 *
 * It has to carry three things or it is not worth the tool call it costs: **who** holds
 * the file, **where** they are holding it from, and **what to do** — which is not "stop".
 * A collision across worktrees is ordinary and the honest instruction is to know about
 * it and choose; only the same-tree case is a genuine stop.
 */
export function refusalFor(file, out) {
  const who = out.holders
    .map((h) => {
      const where = h.branch || (h.dir ? h.dir.split('/').pop() : '') || 'somewhere unnamed';
      return `${h.bead ? `${h.bead} ` : ''}on ${where}`;
    })
    .join('; ');

  if (out.sameTree) {
    return (
      `${file} is being edited by another session in this same worktree (${who}). ` +
      `Two sessions writing one checkout is bc-utyr — one of them loses its work with no conflict marker to show for it. ` +
      `Stop: find out what that session is doing before you write here, or work in your own worktree.`
    );
  }
  return (
    `${file} is already claimed by another session (${who}) — a different worktree, so nothing is overwritten now, ` +
    `but both branches will change this file and one of you will resolve it at downmerge. ` +
    `Consider a file neither of you shares, or coordinate. Repeat the edit to claim it anyway; you will only be told once.`
  );
}

/** Tests, and nothing else: the register is process-lifetime state by design. */
export function reset() {
  paths.clear();
}
