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
 * ## Who, here; which lines, next door
 *
 * This file answers *who is on this path* and nothing finer, and it stays that way: the
 * answer is a map lookup with no `await` in it, which is the race guarantee `claim()`
 * depends on. *Which lines* each side has changed is lib/regions.js, derived from git at
 * the moment of a refusal rather than accumulated here — recorded line numbers drift the
 * moment either branch inserts above them, and two worktrees' numbers are not in the same
 * coordinate system to begin with (bc-zedm). `refusalFor` takes that reading when there is
 * one and says the same thing it always said when there is not.
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
 * ## The bead is filled in from outside, and late
 *
 * A record's `bead` is the one field no client can supply: `scripts/claim-guard.sh` knows
 * the branch and nothing else, and turning a branch tail into a verified id needs the
 * tracker — not a thing to spawn in front of every Write. lib/claimbead.js resolves it in
 * the daemon once per branch and hands it to `attribute` below, which remembers it and
 * back-fills the claims already held. Everything else here is a report by a client.
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
// Formatting only. The git that produces those ranges is lib/regions.js's own, and it is
// never called from in here — see the note on `claim()` about why nothing in this file
// may await.
import { render } from './regions.js';

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

/**
 * (repo, branch) → the bead that branch is for, once something has worked it out.
 *
 * The hook cannot fill the `bead` field in — turning a branch tail into a verified id
 * needs the tracker, which is not a thing to spawn in front of every Write — so it is
 * resolved once per branch by lib/claimbead.js and handed here. Kept beside the records
 * rather than on them because it has to outlive them: a session claims a file, the claim
 * expires, and its next claim from the same branch must still arrive with the bead on it
 * rather than waiting for a second lookup that nothing would start.
 *
 * Unbounded on purpose, and it is bounded in fact: one entry per branch this daemon has
 * ever been shown, which is thirty on a busy laptop and gone on restart like everything
 * else in here.
 */
const beadOfBranch = new Map();

const str = (v) => (v == null ? '' : String(v).slice(0, MAX_LEN));

/**
 * One key from a repo and a path within it.
 *
 * `JSON.stringify` rather than joining on a separator, because both halves are file paths
 * and every cheap separator is legal in one of them — a NUL would do it and cannot be
 * written here, since `test/filter.mjs` fails the repo for an invisible control byte in
 * source, which is the right rule and caught this line. Two strings in an array cannot
 * collide however either one is spelled.
 *
 * `beadOfBranch` keys itself the same way, with the branch in the second slot: same
 * question ("which repo, and which thing in it"), same reason not to join on a character.
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
  //
  // `already` is the third state and its absence was a bug: a session that had insisted
  // and taken the file was demoted back to 'told' by its *next* edit, because the only
  // route to 'held' ran through 'told'. So a contested file refused every second edit for
  // as long as both sessions were on it, and "you will only be told once" — the sentence
  // this very message ends with — was false (bc-n1qq, found by the refusal firing twice
  // while lib/server.js was being edited for bc-zedm). Holding is not something you have
  // to keep re-earning.
  const already = Boolean(prev && prev.state === 'held');
  const insisted = Boolean(others.length && prev && prev.state === 'told');
  const state = !others.length || insisted || already ? 'held' : 'told';

  const record = {
    session: id,
    repo,
    file,
    label: str(payload.label) || repo.split('/').pop(),
    dir: str(payload.dir),
    branch: str(payload.branch),
    // What the client said, and failing that what was worked out about this branch
    // earlier — see `attribute`. A synchronous map lookup, because nothing on this path
    // is allowed to be anything else.
    bead: str(payload.bead) || beadOfBranch.get(key(repo, str(payload.branch))) || '',
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

/**
 * This branch is that bead — remembered, and written onto the claims already holding.
 *
 * The one write into this register that does not come from a client, and the reason it
 * exists is that the answer arrives *late*: the hook cannot afford to resolve a bead (see
 * lib/claimbead.js), so the daemon does it once per branch, asynchronously, and the
 * records that were created in the meantime have to be caught up. Back-filling rather
 * than re-claiming, because a claim is a decision about who holds a file and this is only
 * ever a name for work already held — nothing about `state`, `since` or `at` may move.
 *
 * Returns how many records were filled in, which is 0 on the first claim from a branch
 * and 0 again on every repeat, and is only ever interesting in a test.
 */
export function attribute(repo, branch, bead) {
  const r = str(repo);
  const b = str(branch);
  const id = str(bead);
  if (!r || !b || !id) return 0;
  beadOfBranch.set(key(r, b), id);
  let filled = 0;
  for (const bucket of paths.values()) {
    for (const rec of bucket.values()) {
      if (rec.repo !== r || rec.branch !== b || rec.bead === id) continue;
      rec.bead = id;
      filled += 1;
    }
  }
  return filled;
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
export function refusalFor(file, out, regions = null) {
  const who = out.holders
    .map((h) => {
      const where = h.branch || (h.dir ? h.dir.split('/').pop() : '') || 'somewhere unnamed';
      return `${h.bead ? `${h.bead} ` : ''}on ${where}`;
    })
    .join('; ');

  if (out.sameTree) {
    const dirty =
      regions && regions.sameTree ? ` That checkout is dirty at lines ${render(regions.dirty)}, and you are both writing those.` : '';
    return (
      `${file} is being edited by another session in this same worktree (${who}).${dirty} ` +
      `Two sessions writing one checkout is bc-utyr — one of them loses its work with no conflict marker to show for it. ` +
      `Stop: find out what that session is doing before you write here, or work in your own worktree.`
    );
  }

  const head = `${file} is already claimed by another session (${who}) — a different worktree, so nothing is overwritten now`;
  const tail = `Repeat the edit to claim it anyway; you will only be told once.`;

  // No regions is the pre-bc-zedm sentence, unchanged. It is reached whenever git could
  // not answer, and it has to keep working on its own: a refusal that degraded into
  // silence when the detail was unavailable would lose the warning to protect the
  // decoration.
  if (!regions || regions.sameTree) {
    return (
      `${head}, but both branches will change this file and one of you will resolve it at downmerge. ` +
      `Consider a file neither of you shares, or coordinate. ${tail}`
    );
  }

  const many = regions.holders.length > 1;
  // The base is named once, and again only if the next holder's is a different one —
  // which happens when two branches were cut at different times and is worth seeing
  // precisely because it is the case where the numbers are not all in one frame.
  const detail = regions.holders
    .map((h, i) => describe(h, many, i === 0 || h.base !== regions.holders[i - 1].base))
    .join(' ');
  // "Different regions" is only sayable if this session has regions of its own. Before
  // its first edit to a file it has none, and the honest verdict is a warning about where
  // not to go rather than a prediction about a merge that has nothing on one side.
  const blind = regions.holders.every((h) => !h.mine || !h.mine.base.length);

  const verdict = blind
    ? `You have not changed this file yet, so there is nothing to collide — keep out of those lines and it stays that way.`
    : regions.overlap
      ? `That is a conflict at downmerge, not a maybe: coordinate with them, or pick a file neither of you shares.`
      : `Those regions do not touch, so git should merge them cleanly — keep out of their lines and it stays that way.`;

  const unread = regions.unread ? ` (${regions.unread} further holder${regions.unread > 1 ? 's are' : ' is'} on it, unread.)` : '';
  return `${head}. ${detail}${unread} ${verdict} ${tail}`;
}

/**
 * One holder's half of the sentence.
 *
 * Every number printed is a line in a file somebody can actually open — the holder's in
 * the holder's copy, yours in yours — while the *comparison* behind `overlap` happened in
 * merge-base coordinates, which is the only frame in which the two are comparable but is
 * a frame neither reader has on disk. Printing base numbers would be more precise and
 * less useful; the base sha is named so the claim is checkable either way.
 */
function describe(h, many, showBase) {
  const them = many ? h.branch || h.bead || h.session : 'They';
  const is = many ? 'is' : 'are';
  const its = many ? 'its' : 'their';
  const base = showBase ? ` (${h.base})` : '';
  const theirs = render(h.theirs.now);

  if (h.theirs.newFile && (!h.mine || h.mine.newFile)) {
    return `This file does not exist in the merge base${base || ` (${h.base})`} — you are both creating it, so every line of it collides.`;
  }
  if (!h.mine || !h.mine.now.length) {
    return `${them} ${is} changing lines ${theirs} of ${its} copy.`;
  }
  const mine = render(h.mine.now);
  return h.overlap
    ? `${them} ${is} changing lines ${theirs} of ${its} copy and you are changing ${mine} of yours — the same region of the merge base${base}.`
    : `${them} ${is} changing lines ${theirs} of ${its} copy; yours are at ${mine} — a different region of the merge base${base}.`;
}

/** Tests, and nothing else: the register is process-lifetime state by design. */
export function reset() {
  paths.clear();
  beadOfBranch.clear();
}
