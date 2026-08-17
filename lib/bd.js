import { execFile } from 'node:child_process';
// A leaf that imports nothing, so this costs the import graph nothing — see the note at
// the top of lib/timing.js for what it is for.
import { spend } from './timing.js';
import { UNENDORSED } from './endorse.js';
import { SHIP_LABEL } from './shipbead.js';
import { CONTAINER } from './container.js';
import { isSuperseded } from './superseded.js';
import { ownAddresseeLabels } from './addressee.js';
// The byline `this.actor` becomes — derived in the constructor rather than by the
// callers, so no filing path can be added that writes anonymously. See lib/byline.js.
import { bylineFor } from './byline.js';
import { isEpic, isP0, ownOwnerLabels, ownersOf } from './ownership.js';
// `byDoneThenId` lives there rather than here because the epic board's tree sorts its
// siblings with it too, and the order children are read in is one decision.
import { indexFrom, byDoneThenId } from './ancestry.js';
// Also a leaf that imports nothing: the judgement about which bead ids in a paragraph
// earn an edge is pure, and only the spawning half of it lives here.
import { demoteRows, isRelated, mentionsIn, planFor, prefixOf, refusedEdgeType, WRITE_CAP } from './mentions.js';
// The duplicate check, and the one sentence that names what a row duplicates. Both are
// pure — titles in, verdict out — and neither reaches back here, so the create seam can
// import them without a cycle. See `duplicateOf`.
import { findDuplicate, liveCandidates, openRows, resemblanceNote } from './dupe.js';
import { dupeNote } from './proposal.js';
// The `Adopts:` line an epic writes to claim work, parsed in one place because the gate
// below and the applier that reparents them have to agree about what it says.
import { adoptedBy } from './adopts.js';

/**
 * Adapter around the `bd` CLI.
 *
 * Two things matter here:
 *
 * 1. We spawn `bd` DIRECTLY, never through a shell. `~/.zshenv` runs
 *    `_bd_set_workspace`, which rewrites BEADS_DIR from the shell's cwd — so
 *    `BEADS_DIR=... zsh -c 'bd ...'` silently resolves to the wrong workspace.
 *    execFile does no shell startup, so the BEADS_DIR we pass is the one that
 *    sticks, and one daemon can serve every workspace at once.
 *
 * 2. Embedded Dolt is single-writer. A write racing an agent session's write
 *    fails on the lock, so writes retry with backoff. Do NOT reach for
 *    BEADS_DOLT_SHARED_SERVER to dodge that: the workspaces pin
 *    dolt_mode="embedded" in .beads/metadata.json, and forcing shared mode makes
 *    every command fail against a Dolt server that isn't running. It's
 *    config-gated (`sharedServer: true`) for anyone who has run `bd dolt start`.
 *
 * 3. **Who a write is attributed to is per-call, not per-daemon.** `this.actor` is
 *    the default and it is the byline — "beadcause", or "beadcause (carol@example.com)"
 *    on a machine that has said who it is (see lib/byline.js and the constructor
 *    below) — right for everything the daemon does on its own, and wrong for the one
 *    caller that has a name of its own: a browser holding a
 *    Google session (lib/auth.js). Every write method therefore takes `{ actor }`,
 *    and the handlers for the things a person *says* or *decides* — an answer, a
 *    comment, a dismissal note, the beads a "yes" files, the verdict a pull request
 *    gets — pass the signed-in address so the bead's history says who said it.
 *    Omitting it is the old behaviour exactly, which is what keeps the token callers
 *    (ntfy, the Android app, `curl`) writing as they always have.
 *
 *    **What `--actor` actually writes on a create is `created_by`, and never
 *    `owner`.** Worth stating because the opposite was assumed, and it is the whole
 *    reason attributing a create is safe: `owner` comes from the *git identity* of
 *    the directory bd runs in, is untouched by the flag and by BEADS_ACTOR, and is
 *    what `bd ready` and beadcause's own agent list read as "whose queue is this".
 *    Verified against the real binary in `test/attribution.mjs`, which files one bead
 *    each way and asserts both come back ready with the same owner.
 */

const LOCK_RE = /(lock|locked|another process|resource busy|database is busy)/i;

/**
 * A bd that does not know a flag this repo has started passing.
 *
 * Cobra's three phrasings, and what they have in common is the thing that makes a retry
 * safe: the call did nothing at all — nothing read, nothing filed — so a caller that can
 * do without the flag may ask again without it, and one that cannot must not mistake this
 * for an empty answer. Shared by `showWithComments` and `create`, the two places a newer
 * bd's flag is offered to a binary that may be older.
 */
const UNKNOWN_FLAG_RE = /unknown flag|unknown shorthand|flag provided but not defined/i;

/**
 * The flag that stops `bd create --parent` copying the parent's labels onto the child.
 *
 * Named once because `create` both pushes it and filters it back out of the argv on the
 * fallback path, and two spellings there would retry with the flag still on — failing
 * identically, forever, on the one binary the fallback exists for.
 */
const NO_INHERIT_LABELS = '--no-inherit-labels';

/**
 * A refusal that will say exactly the same thing however many times it is asked.
 *
 * `LOCK_RE` above is a substring match on `lock`, and bd's sentence for a pair that
 * already holds an edge ends `(requested "blocks")` — so **every refused `bd dep add`
 * looks like Dolt lock contention**, and a write with four retries spends five spawns
 * and four seconds of backoff before reporting something that was decided in the first
 * millisecond. Nobody noticed while a refused edge was a rare accident; bc-arj0.20 makes
 * it a routine event on a request path — `/api/console/create` is a tap on a phone —
 * where four wasted seconds per declared dependency is the difference between a
 * proposal that files and one that looks hung.
 *
 * Deliberately one sentence and not a general narrowing of `LOCK_RE`. The broad match
 * costs a pointless backoff wherever bd says "blocked by" as well, which is worth
 * fixing on its own terms rather than as a side effect of this.
 */
const TERMINAL_RE = /already exists with type/i;

/**
 * bd 1.2.1 refusing a close because the bead is assigned to somebody other than the actor.
 *
 *     cannot close bc-xl7n.36: assignee is "neadamthal@gmail.com",
 *       actor is "beadcause (neadamthal@gmail.com)"; reclaim or use --force to override
 *
 * Matched on the two halves that carry the meaning — *assignee is* and *actor is* — rather
 * than on the whole sentence, so a reworded message keeps matching for as long as it is
 * still about those two names. It has already been reworded once: bc-9d37.12 is four checks
 * that broke when 1.2.1 rephrased the *blocked* refusal, which is exactly the failure mode
 * to design against here.
 *
 * Deliberately narrow in the other direction. Every other refusal — a live blocker, open
 * children, an epic closing on a merge reason — must **not** match, because the caller's
 * response to a match is `--force`, and `--force` lifts all of those too. A regex that
 * drifted wide would turn one bug into the silent closing of gated beads.
 *
 * Exported because `bin/deliver.js` is a different process that shells out to `bd` directly
 * and needs the same answer from the same sentence; two copies of this would drift apart on
 * the next rewording, and only one of them would be tested.
 */
export const CLAIM_GUARD_RE =
  /cannot close[^:]*:\s*(?:assignee is\b[\s\S]*\bactor is\b|held by\s*"[^"]*"\s*\(in[ _]progress\))/i;

/**
 * ## The second wording, and why it is an alternation rather than a second regex
 *
 * bd 1.2.1 refuses a *reassign* of a claimed bead in different words entirely —
 *
 *     cannot reassign bc-3muu.12: held by "neadamthal@gmail.com" (in_progress);
 *       coordinate with the holder (bd mail …) — pass --force only if their claim is
 *       abandoned (crashed agent, expired lease), or use bd reclaim
 *
 * — and bc-q6qc was filed on the hypothesis that a `close` comes back in those words
 * too, which would explain a merged bead that never closed. **It does not, on bd
 * 1.2.1.** Measured against the binary rather than reasoned about: a close refused over
 * a claim says *assignee is / actor is* whether the bead is flat or dotted, whether it
 * is a child of an epic, and whether the lease is live or long expired. So this half of
 * the alternation matches nothing bd says today, and `assertClosed` below is what
 * actually catches the bug the bead was filed for.
 *
 * It is here anyway because it costs one alternation and the rewording it guards
 * against has already happened once to a neighbouring sentence (bc-9d37.12). Note what
 * it does **not** widen towards, which is the whole objection above: every refusal
 * `--force` must never be reached for — a live blocker, open children, an epic closing
 * on a merge reason — names none of `held by`, a quoted holder and `(in_progress)` in
 * one line. The `cannot close` anchor is shared by both halves for the same reason, so
 * neither can match the *reassign* sentence the wording was copied from.
 */

/** Did this error come back as that refusal? Reads the message and both streams. */
export function isClaimGuard(err) {
  if (!err) return false;
  const said = `${err.message || ''}\n${err.stderr || ''}\n${err.stdout || ''}`;
  return CLAIM_GUARD_RE.test(said);
}

/**
 * bd 1.2.1 refusing to *clear* the claim on a bead somebody else is holding.
 *
 *     cannot reassign bc-xl7n.61: held by "neadamthal@gmail.com" (in_progress);
 *       coordinate with the holder (bd mail neadamthal@gmail.com) — pass --force only if
 *       their claim is abandoned (crashed agent, expired lease), or use bd reclaim
 *
 * The sentence the block above says matches nothing, said about a different write. A close
 * refused over a claim says *assignee is / actor is*; a **reassign** refused over the same
 * claim says this, and the two share no wording at all — which is why `CLAIM_GUARD_RE` is
 * anchored on `cannot close` and this is a separate export rather than a third alternation
 * in it. Widening that one to cover this would hand `--force` to five close paths on a
 * sentence none of them can produce.
 *
 * **Why anything matches it at all** (bc-xl7n.85). Every worker window claims its bead as
 * its first act, under the human's git identity, and every write beadcause makes is stamped
 * `beadcause`. So on the paths that put a bead *back* — `handBack` in lib/advocate.js, the
 * last step of `bin/plan.js` — actor and assignee never match, by construction, and the
 * reopen is refused every single time. Measured in the daemon log on 2026-08-17: 20 distinct
 * beads refused, four of them still `in_progress` under no window at all, one for two days.
 *
 * Narrow in the same direction as its neighbour, and for the same reason: the caller's
 * response to a match is `--force`, so it must name the holder, the quoted handle and
 * `(in_progress)` together. A blocker, open children or an epic's merge reason names none
 * of them, and the leading `cannot reassign` keeps it off every close refusal besides.
 */
export const REASSIGN_GUARD_RE = /cannot reassign[^:]*:\s*held by\s*"[^"]*"\s*\(in[ _]progress\)/i;

/** Did this error come back as *that* refusal? Reads the message and both streams. */
export function isReassignGuard(err) {
  if (!err) return false;
  const said = `${err.message || ''}\n${err.stderr || ''}\n${err.stdout || ''}`;
  return REASSIGN_GUARD_RE.test(said);
}

/**
 * Statuses that mean the bead is still live — the whole basis of `assertClosed`.
 *
 * Named the open way round on purpose. bd's done state is configurable (`bd update
 * --force` documents moving an issue "into closed (or a configured done status)"), so a
 * list of what counts as *closed* would read a workspace using its own word for it as
 * an open bead, and turn every successful close there into a failure. A list of what
 * counts as *open* fails the other way: an unfamiliar status is read as closed, which
 * can only ever miss this bug rather than invent it. Same direction as `assertClosed`'s
 * treatment of a tracker that will not answer, and for the same reason.
 *
 * Exported for bin/deliver.js, which is a different process shelling out to `bd`
 * synchronously and asking the same question about the same row; two lists of what
 * counts as open would drift apart the first time bd gained a status, and only one of
 * them would be tested.
 */
export const LIVE_STATUSES = new Set(['open', 'in_progress', 'in progress', 'blocked', 'ready', 'deferred']);

/**
 * How many times the three sweep reads retry a *lock* before giving up.
 *
 * Reads used not to retry at all, on the reasoning that a read is cheap to repeat on
 * the next poll. That reasoning was wrong about what the failure costs: the poll is
 * thirty seconds away, and in the meantime the inbox has drawn the repo as empty and
 * told you there is nothing to answer (bc-ksdc). A write has retried since the
 * beginning for exactly the collision this is — around twenty agent sessions share
 * these workspaces and embedded Dolt is single-writer.
 *
 * Two rather than the four a write gets, because a read is on the request path: this
 * is at most 400ms + 800ms added to a sweep that already failed, and only ever for an
 * error that matches LOCK_RE. Anything else still fails on the first attempt, at once.
 */
const SWEEP_RETRIES = 2;

/**
 * The parent map, per workspace, and how long one is good for. See `Bd.parents`.
 *
 * Module-level rather than per-instance because the daemon builds exactly one `Bd` and a
 * test builds several against the same fixtures; a cache that a second instance could not
 * see would be a cache that never hit in the one place it is measured. `forgetParents`
 * exists for the tests and for a caller that has just reparented something and would
 * rather not draw a minute of the old shape.
 */
const PARENT_CACHE = new Map();
const PARENT_TTL_MS = 60_000;

/**
 * The refresh in flight per workspace, so a cold cache is read once and not nine times.
 *
 * Without it, `rootBoard` asking for nine workspaces in a loop while a poll is already
 * building the same nine is eighteen `bd export` spawns for one answer — and they queue
 * behind each other on a single-writer Dolt, so the second set is not merely wasted, it
 * is slower than the first.
 */
const PARENT_INFLIGHT = new Map();

/**
 * What a workspace looks like before anything has been read about it.
 *
 * Every field `indexFrom` builds, empty rather than missing: a caller reaching for
 * `index.adopts` on the stand-in should find nothing to do, not a TypeError on a path
 * that only runs while the daemon is warming up.
 */
const EMPTY_GRAPH = { parents: new Map(), beads: new Map(), adopts: new Map(), edges: new Map() };

/** Drop the cached parent map — every workspace, or one of them. */
export function forgetParents(name = null) {
  if (name === null) PARENT_CACHE.clear();
  else PARENT_CACHE.delete(name);
}

/**
 * The live titles the create-time duplicate check compares against — a cache of its own,
 * over the same rows, and it is separate from `PARENT_CACHE` for one specific reason.
 *
 * `create` calls `forgetParents` whenever it files a bead under a parent, because the
 * shape it just changed is exactly what that cache holds. Reading titles out of the same
 * entry would mean a session filing three discoveries paid a full `bd export` for each of
 * them: warm, dropped, warm, dropped. The list of open titles does not go stale for the
 * reason the parent map does — a bead's *position* moved, not its title — so it is held
 * on its own timer and topped up by hand.
 *
 * Sixty seconds, the same window the rest of this file already accepts, and the staleness
 * is in the harmless direction: a bead filed in the last minute is missed by the check
 * once, and `Bd.rememberTitle` closes even that for the batch that filed it. The duplicates
 * this exists for — bc-297u/bc-syzm, bc-767a/bc-giuc, bc-zjep/bc-zflo — were filed hours
 * apart.
 */
const TITLES_CACHE = new Map();
const TITLES_TTL_MS = 60_000;

/** Drop the cached title list — every workspace, or one of them. For the tests. */
export function forgetTitles(name = null) {
  if (name === null) TITLES_CACHE.clear();
  else TITLES_CACHE.delete(name);
}

/**
 * How long any one `bd` invocation gets before it is killed — two minutes, and the
 * number is measured rather than picked.
 *
 * It used to be thirty seconds, and thirty seconds is a ceiling this laptop clears on an
 * ordinary afternoon. The largest read here — `bd list --all` over 503 beads — answers in
 * **about a second idle and took 28.6 seconds under a load average of 33**: twenty agent
 * sessions and a full `npm test`, which is what a Tuesday looks like on this machine, not
 * a pathological case. `Bd.listAll` was given a ceiling of its own when that was measured
 * (bc-nib3.1), and that fixed one call site out of seven — while the six it did not fix
 * are the *small* reads that run on a timer, across every workspace, every thirty seconds.
 *
 * **A timeout is not a slow answer, it is a broken workspace.** `execFile` kills the
 * child, `run` rejects, and every caller downstream reads that as "this repo failed": the
 * sweep puts it in `trouble` (lib/sweep.js), `/api/work` draws it as an error, and
 * lib/history.js turns it into a row in `errors[]`. So the failure mode of a busy laptop
 * was repos reporting as broken while bd was merely slow — and on a thirty-second poll it
 * recurred for as long as the load lasted.
 *
 * **A default rather than a ceiling per call**, because a per-call ceiling is exactly what
 * was already tried and it is one call site away from the same bug every time somebody
 * adds a read. Reads are the argument for the number and writes get it too, which is
 * deliberate on both counts:
 *
 *  - **A read cannot block anything.** None of these queues behind Dolt's single writer,
 *    so a ceiling nobody hits costs one slow request and nothing else.
 *  - **A killed write is worse than a slow one.** What the old default did to a write on
 *    a loaded machine was SIGTERM it mid-`bd`; waiting is the safer of the two.
 *  - **A timeout never retries** (see `run`), so this is one ceiling per call and not
 *    four — which is what would have made two minutes on the request path indefensible.
 *
 * The cost of being wrong in this direction is that a genuinely hung `bd` is noticed a
 * minute and a half later than it was. The cost of being wrong in the other direction is
 * the screen this app exists never to show: a repo full of open questions, drawn as quiet.
 */
export const BD_TIMEOUT = 120_000;

/**
 * A close reason that is evidence of a merge and nothing else.
 *
 * Three sentences reach `bd close --reason` when a pull request lands, and they are all
 * written in this repo: `Landed as #42` from a worker's own delivery and from the tap on
 * a delivery card (bin/deliver.js, lib/server.js), and `Merged #212 as 72789c0b into
 * main on GitHub` from the sweep that notices a merge made on github.com
 * (`landedReason` in lib/landed.js). Matching the sentence rather than taking a flag from
 * the caller is deliberate and is the whole reason this is a predicate: **lib/owed.js
 * retries a refused close minutes later with nothing in hand but the stored reason**, so
 * a rule that lived in the callers would be bypassed by the retry — and by every record
 * already sitting in `owed-closes.json` written by a beadcause that had no such rule.
 *
 * Used by `gateFor` for one refusal only: an **epic** cannot close on one of these. A
 * work bead closing because its pull request merged is the ordinary, correct case and is
 * left alone. See the `merge-reason` branch below for why an epic is different.
 */
export function isMergeReason(reason) {
  return /(^|\W)(landed as\s+#\d+|merged\s+#\d+|merged\s+pull\s+request)/i.test(String(reason || ''));
}

/** Seconds, because that is what a ceiling is argued about in — but never a rounded `0s`. */
const fmtMs = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);

export class Bd {
  /**
   * `me` is who this Mac is, and it decides two different things.
   *
   * The first is routing: it is stamped onto every question this daemon files, as a
   * `for:<handle>` label, so the other five phones can stay dark about it
   * (lib/addressee.js). The second is the byline, and it is derived **here** rather
   * than at the four call sites that build a `Bd` — `actor` arrives as the *base*
   * (`cfg.actor`, "beadcause") and `this.actor` is what actually goes on the bead,
   * `beadcause (carol@example.com)` once this machine can say whose it is. Deriving it
   * in the constructor is what makes it impossible to add a fifth call site that files
   * anonymously; see lib/byline.js for why the base comes first in the string.
   *
   * With `me` absent — the default, and every install that has never heard of this —
   * nothing is stamped, every question is everybody's, and the byline is the bare base
   * exactly as it has always been.
   */
  constructor({ bin, actor, sharedServer = false, me = null }) {
    this.bin = bin;
    this.actor = bylineFor({ actor, me });
    this.sharedServer = sharedServer;
    this.me = me;
  }

  /**
   * `actor` overrides who this one command is written as. See `Bd.actor` above for
   * why it is a flag and not just an env var.
   *
   * Null or absent means `this.actor` — "beadcause" — which is what every caller
   * meant before there was anything else to be, and what every caller without a face
   * still means: an ntfy action button, the Android app, `curl`, the poller. Only a
   * request carrying a signed-in session has an address to pass here, and only the
   * handlers for the things a *person* says pass it (see lib/server.js).
   */
  run(workspace, rawArgs, { retries = 0, timeout = BD_TIMEOUT, actor = null } = {}) {
    const who = actor || this.actor;
    const env = {
      ...process.env,
      BEADS_DIR: workspace.dir,
      BEADS_ACTOR: who,
    };
    if (this.sharedServer) env.BEADS_DOLT_SHARED_SERVER = '1';
    else delete env.BEADS_DOLT_SHARED_SERVER;

    // BEADS_ACTOR is NOT enough: a workspace config.yaml with `actor: "…"` beats
    // the env var — observed with a workspace pinning a personal address — so
    // comments written from the phone came back attributed to the human rather
    // than to beadcause, and reply-detection then notified you about your own
    // comments. The --actor flag does win.
    const args = [...rawArgs, '--actor', who];
    const attempt = (left) =>
      new Promise((resolve, reject) => {
        // Every `bd` this daemon spawns goes through here, which is why this is the one
        // place the timing hook needs: it charges this child's wall time to whichever
        // request is in scope, and to the daemon's own `background` when there is none.
        // Nothing above it knows about it and nothing below it can escape it. Charged
        // per *attempt* rather than around the retry loop, so a read that waited out
        // two Dolt-lock backoffs reports all three spawns and counts none of them
        // twice. See lib/timing.js.
        const spawned = process.hrtime.bigint();
        execFile(
          this.bin,
          args,
          { env, cwd: workspace.dir, timeout, maxBuffer: 32 * 1024 * 1024 },
          (err, stdout, stderr) => {
            spend('bd', spawned);
            if (!err) return resolve(stdout);
            const detail = `${stderr || ''}${stdout || ''}`;
            // A child *we* killed is not a child that failed, and it is the one error here
            // that arrives with nothing to explain itself: the timeout above SIGTERMs bd
            // mid-answer, so stderr is empty and `err.message` is Node's own "Command
            // failed". Undecorated, that reads downstream — in `trouble`, in `errors[]`, on
            // the phone — as a broken tracker rather than a slow one. `killed` is set when
            // maxBuffer is blown as well, which is a real failure, so that one is left to
            // fall through and say so.
            const timedOut = Boolean(err.killed) && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            // And it must not be retried. A retry is for the Dolt lock, where waiting is the
            // fix; here it would spend the whole ceiling again on a machine that has just
            // proved it is too busy to answer inside it.
            if (!timedOut && left > 0 && LOCK_RE.test(detail) && !TERMINAL_RE.test(detail)) {
              const wait = (retries - left + 1) * 400;
              return setTimeout(() => attempt(left - 1).then(resolve, reject), wait);
            }
            // `bd … <verb> in <ws>: <sentence>` on both branches, because lib/sweep.js
            // strips everything up to that colon before the phone sees it — so the half
            // that has to survive a four-inch screen is the half after it.
            const e = new Error(
              timedOut
                ? `bd ${args.join(' ')} timed out in ${workspace.name}: still running after ${fmtMs(timeout)}, killed rather than broken`
                : `bd ${args.join(' ')} failed in ${workspace.name}: ${detail.trim() || err.message}`
            );
            e.timedOut = timedOut;
            e.stdout = stdout;
            e.stderr = stderr;
            reject(e);
          }
        );
      });
    return attempt(retries);
  }

  async json(workspace, args, opts) {
    const out = await this.run(workspace, [...args, '--json'], opts);
    return parseJson(out);
  }

  /** Open issues carrying the `human` label, with their full description. */
  async listHuman(workspace) {
    const rows = await this.json(workspace, ['human', 'list'], { retries: SWEEP_RETRIES });
    return (rows || []).filter((r) => r && r.status !== 'closed');
  }

  async show(workspace, id) {
    const rows = await this.json(workspace, ['show', id]);
    return (rows || [])[0] || null;
  }

  /**
   * A bead and its thread in **one** spawn — what the sheet behind `/api/bead` waits on.
   *
   * bc-kki5. The route used to ask `show` and then `comments`, and the sheet waited on
   * the sum of two `bd` processes. Spawn *count* is the whole game on this tracker (see
   * the note on `graph` below: a single call answered in 6.4 seconds on an ordinary
   * loaded afternoon), so the fix is to make one call do both, not to overlap two.
   *
   * **Overlapping them was tried first and does not work.** Measured on this Mac over 32
   * paired runs, alternating which form went first so drift in machine load cancels: two
   * `bd` reads started together cost ~2.2× one alone, and `Promise.all` came out a wash
   * against the serial pair — a median of 126–361ms *worse*, ahead in only 10 of 32. Not
   * lock contention: zero of 20 rounds tripped `LOCK_RE`, so the retry backoff never
   * fired. Embedded Dolt simply gives two concurrent readers no real concurrency, and on
   * a Mac sitting at load 10–20 with two dozen agent sessions on it they only take the
   * page cache from each other. One spawn beat two in **13 of 14** pairs, median 1376ms
   * → 1012ms. That is the difference between a measurement and an intuition.
   *
   * **`comments: null` on a bead with no thread**, where `bd comments` answers `[]` — so
   * it is normalised here rather than at the callers, which is where the old shape is
   * already assumed.
   *
   * **The payload is otherwise identical**, checked field by field against the two-call
   * form over real beads. One key differs and it is the right one to lose: a plain
   * `bd show` marks a bead that has a thread `comments_omitted: true`, and with the
   * thread actually present that would be a lie. Nothing in this repo reads it.
   *
   * **Falls back to the two calls if the flag is not there.** `--include-comments`
   * exists in bd 1.2.1; this repo's notes were written against 1.1.2 and nothing pins a
   * minimum. An unknown flag makes `bd` exit non-zero having answered nothing, so
   * without this a sheet on an older bd would not be slow, it would be *broken* — a much
   * worse trade than the 395ms. Probed once and remembered, so the slow path costs one
   * wasted spawn for the life of the daemon rather than one per tap.
   */
  async showWithComments(workspace, id) {
    if (this.noIncludeComments !== true) {
      try {
        const rows = await this.json(workspace, ['show', id, '--include-comments']);
        const issue = (rows || [])[0] || null;
        this.noIncludeComments = false;
        return issue && { ...issue, comments: issue.comments || [] };
      } catch (err) {
        // Only an unrecognised flag falls back. A bead that does not exist, a Dolt that
        // could not be read, a timeout — those have to keep reaching the caller as
        // themselves, because `/api/bead` tells a 404 from a 500 by reading this message.
        if (!UNKNOWN_FLAG_RE.test(String(err?.message || ''))) throw err;
        this.noIncludeComments = true;
        console.error('[beadcause] this bd has no `show --include-comments` — falling back to two calls per bead sheet');
      }
    }
    const issue = await this.show(workspace, id);
    return issue && { ...issue, comments: await this.comments(workspace, id) };
  }

  async comments(workspace, id) {
    try {
      return (await this.json(workspace, ['comments', id])) || [];
    } catch {
      return [];
    }
  }

  /**
   * Would `bd close` refuse this bead, and why?
   *
   * bd has two gates on a close, and answering a question tripped either of them
   * the same way: the comment went in, the close threw, and the whole answer came
   * back to the phone as an error over a question that had in fact been answered.
   * The card stayed in the inbox looking untouched, so it got answered again —
   * five beads across two workspaces ended up carrying the same answer two and
   * three times over.
   *
   * There is no `--dry-run` on `bd close` (and `--readonly` refuses the operation
   * before it evaluates anything), so the gates are asked about rather than
   * attempted. Both are **measured** against the binary rather than guessed at, and
   * measured is now literal: test/closegatereal.mjs builds each of these shapes in a
   * throwaway workspace and asserts that what this returns and what `bd close` then
   * does are the same answer. bd 1.1.2, on 2026-08-11:
   *
   *   - **blocked by open issues** — the `blocks` dependencies `bd show` already
   *     returns, minus the closed ones. This is the same list bd names, and `bd show`
   *     carries only *outgoing* edges, so what blocks this bead is all that is there.
   *   - **an epic with open children** — one extra call, and only for an epic,
   *     because children are not in `dependencies` at all.
   *
   * Two things about that pair are easy to assume the other way round, and both cost
   * somebody an hour:
   *
   *   - **The open-children gate is on every parent, not on the word `epic`** — since
   *     bd 1.2.1 (bc-xl7n.39), which refuses any close with `N open child issue(s)`
   *     whatever the type. It used to be the word alone, and that is worth keeping in
   *     view because it is why bc-5864 exists: bc-rk2o closed by bin/deliver.js while
   *     bc-rk2o.1 was still open, read as bd permitting a close this gate would have
   *     refused. bc-rk2o is a feature, so on bd 1.1.x nothing disagreed with anything —
   *     and on 1.2.1 that same close is refused by the binary. Only the *merge-reason*
   *     and *`Adopts:`* rules below are still epic-only.
   *   - **Not-closed is what counts, not open.** `in_progress` and `deferred` are both
   *     still a child, and both still a blocker — which is why the filters here are
   *     `!== 'closed'` and not a list of the statuses that gate.
   *
   * **bin/deliver.js does not ask this, and that is agreement rather than a second
   * opinion.** It attempts the close and handles the refusal (`oweClose`, then a
   * comment saying so in bd's own words), because a delivery has already merged by
   * then and has somewhere to put a refusal. A tap on a card has not: it is about to
   * write a comment it cannot take back. Same rules, both paths — one asks first, the
   * other cleans up after, and bd is the thing refusing in both.
   *
   * Reordering to close-before-comment would have been the other way to learn
   * this, and it trades one lost answer for another: a close that succeeds and a
   * comment that then fails on the Dolt lock leaves the bead closed with nothing
   * recorded on it. Asking first costs one `bd show` and writes nothing either way.
   *
   * ## Two gates that are beadcause's own, and bd does not share them
   *
   * Everything above models what the binary already refuses. The two below are rules
   * bd has no way to hold, and they are marked as such in test/closegatereal.mjs, where
   * every other case asserts that the gate and the binary agree and these two assert
   * that they deliberately do not:
   *
   *   - **an epic with an unapplied `Adopts:` entry** — the line is prose in a
   *     description, so bd sees an epic with no children and closes it.
   *   - **an epic closing on a merge reason** — bd is told a sentence, not a claim about
   *     a theme.
   *
   * bd cannot be taught either: it has no pre-close hook (`bd hooks` installs git hooks
   * and nothing else, measured on bd 1.1.2), so a `bd close` typed at a terminal still
   * closes an epic over both. Which is why the rule lives on the *paths beadcause
   * closes through* rather than only in the gate — every one of them asks, including
   * lib/owed.js's retry minutes later, and bin/deliver.js checks the merge-reason half
   * itself because it is a different process that attempts the close rather than asking.
   *
   * Returns `null` when the close would go through. Anything else is the reason
   * it would not, in the words the phone shows you.
   */
  async closeGate(workspace, id, { reason = '' } = {}) {
    let issue;
    try {
      issue = await this.show(workspace, id);
    } catch {
      // Not being able to ask is not the same as being refused. Let the close
      // itself be the judge rather than blocking an answer on a failed lookup.
      return null;
    }
    return this.gateFor(workspace, issue, { reason });
  }

  /**
   * The gate, given an issue `show` has already returned.
   *
   * Split out because two callers want it from one lookup: `closeGate` above, and
   * `hold` below, which needs the comment count off the same issue and should not
   * pay for a second `bd show` to get it.
   *
   * `reason` is the sentence the close would carry, where the caller has one. It is
   * optional and everything above the epic branch ignores it — a caller that only wants
   * to know whether a bead *could* close (the hold, the phone drawing a card) passes
   * nothing and gets the same answer it always did.
   */
  async gateFor(workspace, issue, { reason = '' } = {}) {
    if (!issue) return null;

    const blockers = (issue.dependencies || [])
      .filter((d) => d && d.dependency_type === 'blocks' && d.status !== 'closed')
      .map((d) => ({ id: d.id, title: d.title || '' }));
    if (blockers.length) {
      return { kind: 'blocked', blockers, reason: `blocked by ${blockers.map((b) => b.id).join(', ')}` };
    }

    const isEpic = issue.issue_type === 'epic';

    if (isEpic) {
      // **An epic does not close because a branch that shared its name merged.** This is
      // the only gate here bd cannot have an opinion about, and it is the one that cost
      // the most: six epics closed on 2026-08-12 and 2026-08-13 with sixty adoptees still
      // open between them, every one of them on a merge reason, and each took its
      // classification of that work with it. An umbrella epic is finished when its theme
      // is — a judgement nothing in a pull request is evidence about — so the merge is
      // recorded on it as a comment and the epic stays open for somebody to close on
      // purpose. Checked before the children below because it needs no `bd` call and
      // because it is the more useful sentence of the two: "your close is asking the
      // wrong question" rather than "not yet".
      if (isMergeReason(reason)) {
        return {
          kind: 'merge-reason',
          blockers: [],
          reason: 'an epic does not close on a merge — a pull request is no evidence about the theme',
        };
      }
    }

    // **The open-children gate is on every parent since bd 1.2.1, not only on epics.**
    // It used to be the word `epic` alone — a feature, task, bug or chore closed over as
    // many open children as it liked — which is what bc-5864 was filed about and then
    // withdrawn over. That is no longer bd's behaviour: 1.2.1 refuses any close with
    // `N open child issue(s); close children first or use --force to override`,
    // whatever the parent's type. Leaving this branch inside the epic test was the
    // *inventing-a-gate*'s opposite and the worse of the two failures test/closegatereal.mjs
    // names — the phone would offer a close bd then refuses, having already written the
    // comment it cannot take back. Measured against the real binary on 2026-08-14
    // (bc-xl7n.39); test/closegatereal.mjs pins both parent types.
    //
    // `kind` stays `'epic'` deliberately, even where the parent is not one. Two sentences
    // in public/app.js key off it — "its children are closed", "the children" — and both
    // read correctly for any parent, so renaming it would be a wider diff than the fact
    // it records. The `reason` below is what the phone actually shows, and that one does
    // say which it is.
    //
    // The cost is a `bd list --parent` on every gated bead rather than only on epics, and
    // there is no cheap pre-check to skip it: `dependent_count` on a `bd show` counts
    // dependency edges, not children (bc-w156 reports 3 with one child). bd 1.2.1's new
    // `--brief` would cut the payload ~93%, but using it here would hard-break every
    // older binary rather than degrading, so it is left for when 1.2.1 is a floor rather
    // than a request.
    let children = [];
    try {
      children = await this.children(workspace, issue.id);
    } catch {
      return null;
    }
    const open = children.filter((c) => c.status !== 'closed').map((c) => ({ id: c.id, title: c.title }));
    if (open.length) {
      return {
        kind: 'epic',
        blockers: open,
        reason: `${isEpic ? 'an epic' : 'a parent'} with ${open.length} open child ${
          open.length === 1 ? 'issue' : 'issues'
        }`,
      };
    }

    if (isEpic) {

      // And the beads it only *says* it holds. An `Adopts:` line is the convention agents
      // reach for when an epic claims work, and until it is applied those beads are not
      // children — so bd sees an epic with nothing under it and closes it happily, which
      // is exactly how bc-ka5y closed over twenty-three of them. A named bead counts as a
      // child here whatever its status: an entry that was never applied is a piece of
      // structure this close would destroy even where the bead behind it has since
      // finished, because nothing then records that it was ever part of this theme.
      //
      // The fix is to apply the adoption rather than to delete the line, and it costs no
      // extra `bd` call to notice — the children are already in hand and the line is in
      // the description this gate was handed.
      const held = new Set(children.map((c) => String(c.id).toLowerCase()));
      const unapplied = adoptedBy(issue)
        .filter((id) => !held.has(id))
        .map((id) => ({ id, title: '' }));
      if (unapplied.length) {
        return {
          kind: 'adopts',
          blockers: unapplied,
          reason:
            `an epic with ${unapplied.length} unapplied \`Adopts:\` ${unapplied.length === 1 ? 'entry' : 'entries'} ` +
            `(${unapplied.map((b) => b.id).join(', ')}) — adopt them or drop them from the line`,
        };
      }
    }
    return null;
  }

  /**
   * A bead's children — all of them, closed included.
   *
   * This is a second `bd` call and there is no way around it. `bd show --json` does
   * not carry children: on bc-goo, an epic with seven, it returns `dependent_count: 7`
   * and no rows whatsoever. The *text* output of `bd show` has a CHILDREN section, the
   * JSON has nothing to read it from — so `bd list --parent` is the one that knows.
   *
   * Each of the three flags is load-bearing:
   *
   *  - **`--all`**, because `bd list` hides closed issues by default, and on a finished
   *    epic the closed children are nearly all of what there is to show. bc-goo comes
   *    back as one row without it and seven with.
   *  - **`--limit 0`**, because the default is 50 and the truncation is silent. A list
   *    that prints "6/7 done" beside itself cannot be quietly cut off at fifty.
   *  - `--json`, via `json()`.
   *
   * Rows arrive with the full description on every one of them — kilobytes each, for a
   * list that draws an id and a title — so only what is drawn survives the trip.
   *
   * Two callers, and neither may have the list pre-filtered: `gateFor` above deciding
   * whether an epic is a question or a question's future, and lib/advocate.js deciding
   * whether an epic is work or the *sum* of work already in its queue. Both ask the same
   * thing of it — are any of these still open — which is why `--all` is here and no
   * `status` filter is. The sheet used to be the third; it reads children out of
   * `dependents` below now, because it wants what a bead blocks off the same call.
   *
   * **Order is decided here**, because bd's own is neither id nor status: bc-goo prints
   * its seven as 5, 7, 1, 4, 6, 2, 3. Open work first and the closed tail last is what
   * makes folding the closed ones away cheap to look at — the rows that go are the ones
   * at the bottom, and nothing above them moves.
   */
  async children(workspace, id) {
    const rows = (await this.json(workspace, ['list', '--parent', id, '--all', '--limit', '0'])) || [];
    return rows
      .filter(Boolean)
      .map((r) => ({
        id: r.id,
        title: r.title || '',
        status: r.status || 'open',
        issue_type: r.issue_type || '',
        priority: r.priority ?? null,
      }))
      .sort(byDoneThenId);
  }

  /**
   * Every bead with an edge pointing *at* this one — what `dependent_count` counts.
   *
   * The count is in `bd show --json`; the rows behind it are not, exactly as with the
   * children. `bd dep list <id> --direction=up` is the one that knows, and it hands over
   * a full issue row per edge **plus the `dependency_type` that says what kind of edge it
   * is** — which is the whole reason the sheet asks this rather than `list --parent`:
   *
   *   - `parent-child` rows **are** the children. Verified against a live workspace:
   *     `dep list bc-goo --direction=up -t parent-child` and `list --parent bc-goo --all`
   *     answer with the same eleven ids, closed ones included, because parenthood in bd
   *     *is* a row in `dependencies` — the issues table has no parent column at all.
   *   - everything else is what the bead actually blocks, or was discovered from it, or
   *     is merely related to it. Three groups the sheet can label honestly, where
   *     `dependent_count` was one number that called all of them "blocks".
   *
   * So one call serves both blocks, and the sheet's second round trip stays its only
   * one. Nothing here needs `--all` or `--limit`: `bd dep list` neither hides closed
   * issues nor truncates — it walks the edges, and there is no page over them.
   *
   * Rows arrive with the full description on every one, same as `children`, so only what
   * is drawn survives the trip. Order is ours for the same reason and by the same rule:
   * open work first, closed tail last.
   *
   * **This throws for a bead that does not exist**, where `children` answers `[]` —
   * `bd dep list` resolves the id first and exits non-zero, `bd list --parent` does not.
   * The one caller turns that into a 404 rather than a 500 (lib/server.js).
   */
  async dependents(workspace, id) {
    const rows = (await this.json(workspace, ['dep', 'list', id, '--direction=up'])) || [];
    return rows
      .filter(Boolean)
      .map((r) => ({
        id: r.id,
        title: r.title || '',
        status: r.status || 'open',
        issue_type: r.issue_type || '',
        priority: r.priority ?? null,
        // The one field `children` has no use for and this cannot do without.
        dependency_type: r.dependency_type || '',
      }))
      .sort(byDoneThenId);
  }

  /**
   * What a dismissal has to remember, and what it has to watch.
   *
   * Dismissing acknowledges a card and takes it out of the inbox. It closes
   * nothing — so the bead is still open, and something has to decide when it is
   * worth showing you again. Two things can, and which one applies is decided here,
   * off one `bd show`:
   *
   *   - **A gate** — the epic's open children, the blocker still open. The card
   *     comes back when that clears, because that is the moment it becomes
   *     something you can act on. This is the case you actually hit: an epic with
   *     thirty open children is not a question, it is a question's future.
   *   - **A comment count**, for a bead with no gate at all. Nothing about it is
   *     going to change on its own, so the only honest trigger is somebody saying
   *     something new on the thread.
   *
   * `comments` is `comment_count` off the same `show`, not a second `bd comments`
   * call — the list rows do not carry it, which is the whole reason the reply
   * poller costs an extra call per watched thread.
   */
  async hold(workspace, id) {
    let issue;
    try {
      issue = await this.show(workspace, id);
    } catch {
      return null;
    }
    if (!issue) return null;
    return { gate: await this.gateFor(workspace, issue), comments: Number(issue.comment_count) || 0 };
  }

  /**
   * Closing a **question**, over the claim guard — and the other half of bc-9d37.13.
   *
   * That bead widened five close paths to step over `isClaimGuard` with `--force`, and
   * ruled a question out of the five on purpose: *"a card is answered, not delivered"*.
   * It was right about the evidence and it left the answer path broken. Adam hit it the
   * same morning on bc-jrvh — the close threw, the comment was already written, the card
   * stayed in the inbox and got answered again, three times over four comments — and
   * opened bc-ko7n for it.
   *
   * **Reclaim rather than `--force`, and here that is not the same trade as over there.**
   * bc-9d37.13's objection to reclaiming is that it erases who did the work, and on a
   * delivered work bead that is decisive: the assignee is the record of the session that
   * built the branch, and a merge is no reason to forget it. On a question it is the
   * opposite. The assignee of a card is an artifact of some worker window having touched
   * it — nobody claimed a question in order to own it, and `bd ready` skipping it is the
   * only thing that claim was ever doing. There is nothing there to preserve, so the
   * narrow instrument is available, and Adam chose it (2026-08-14). `--force` would lift
   * the blocker and epic gates with it; dropping the assignee lifts exactly the one rule
   * standing in the way.
   *
   * Lazy, for the reason a delivery's is: try the close as it has always been tried, and
   * reach for the clear only when the claim guard is what refused. `run` retries only on
   * LOCK_RE, so a refusal comes straight back rather than after four backoffs, and an
   * unclaimed question is never written to on its way out. Order still holds for the
   * close that lands — the assignee is gone before it.
   *
   * `--assignee ''` alone, not the reopen path's `--status open --assignee ''`: this is
   * on its way to closing the bead, so the status is not its business. Measured against
   * bd 1.2.1 — the clear is permitted from an actor that is not the assignee, and it is
   * idempotent on a bead that has none.
   *
   * Deliberately *not* modelled in `gateFor`. The gate is what the phone draws a card
   * from and what lib/owed.js and lib/landed.js skip on, so a branch there for a refusal
   * both halves now recover from would make every bead any session ever claimed read as
   * unclosable — the "inventing a gate" failure test/closegatereal.mjs exists to catch.
   * That file pins the agreement instead: gate silent, close succeeds.
   *
   * **And it does not take `assertClosed`, which `close` does.** Not an oversight — the
   * two failures are not the same size. A delivery close that silently does not happen is
   * invisible by construction (bc-q6qc): the merge is done, the window is gone, and an
   * assigned open bead is skipped by `bd ready`, so nothing anywhere will mention it
   * again. A *question* whose close silently did not happen stays in the inbox with its
   * answer on the thread, which Adam sees within the hour and which `Bd.answerOnce` and
   * lib/answered.js are both already built to survive. **bc-2uj4.8** is the bead for doing
   * it here too, and what it costs is honest fixtures in five suites whose fake `bd`
   * currently serves a fixed row reading `open` after closing it.
   */
  async closeAnswered(workspace, id, reason, { actor = null } = {}) {
    const args = ['close', id, '--reason', reason];
    try {
      return await this.run(workspace, args, { retries: 4, actor });
    } catch (err) {
      if (!isClaimGuard(err)) throw err;
      // Said out loud for the same reason `close` says it: a guard is being stepped over,
      // and the worst version of that is the silent one.
      console.error(`[bd] ${id}: dropping the claim to close it — this is an answer, and the assignee is not ${actor || this.actor}`);
      await this.run(workspace, ['update', id, '--assignee', ''], { retries: 4, actor });
      return await this.run(workspace, args, { retries: 4, actor });
    }
  }

  /**
   * Write the answer, unless it is already the last thing said on the thread.
   *
   * The duplicate answers on bc-jrvh were the close failing three times, and the close
   * is fixed above — but the shape that turned one refusal into three identical comments
   * is not specific to that refusal. `respond` writes the comment first on purpose, so
   * *any* failure after it leaves the answer on the thread and the card in the inbox,
   * and the honest thing for the next attempt to do is finish the half that did not
   * happen rather than repeat the half that did.
   *
   * So the comment is skipped when the newest comment on the bead is the same text.
   * Only the newest, and only an exact match: "you already said this, an hour ago and
   * six comments up" is a real answer worth writing again, and lib/answered.js is what
   * tells you about that case on the card. This is narrower — it is the retry of an
   * answer that half-landed a moment ago.
   *
   * One `bd comments` on a path that already spends several writes, and it fails open:
   * `comments` swallows its own errors and returns `[]`, so a tracker that cannot be
   * read writes the answer, which is the direction that loses nothing.
   */
  async answerOnce(workspace, id, response, { actor = null } = {}) {
    const said = await this.comments(workspace, id);
    const last = said.length ? said[said.length - 1] : null;
    if (last && String(last.text ?? last.body ?? last.comment ?? '').trim() === String(response).trim()) return false;
    await this.run(workspace, ['comment', id, response], { retries: 4, actor });
    return true;
  }

  /**
   * Answer and close.
   *
   * This is what `bd human respond` is meant to do, but it is broken in bd 1.1.2
   * ("resolving issue ID: storage is nil") — so do the two steps it documents
   * ourselves. Comment first: if the close then fails on the Dolt lock, the
   * answer is already recorded rather than lost.
   *
   * The caller is expected to have asked `closeGate` first — this still throws if
   * bd refuses, because a gate that appeared between the check and the write is a
   * real failure and not something to swallow. The one refusal it does not throw on is
   * bd's claim guard, which `closeAnswered` reclaims past; that one is not a gate at all,
   * it is beadcause's own byline being read as somebody else. See there.
   *
   * Comment-first is why both halves are written the way they are. Whatever fails after
   * the answer lands leaves the card in the inbox to be answered again, so `answerOnce`
   * makes the repeat finish the close rather than say the same thing twice. That is the
   * shape bc-jrvh's three identical answers came out of.
   *
   * Both writes carry the same `actor`, so a bead answered from a signed-in browser
   * has that address on the comment *and* on the close. Splitting them — the answer
   * from the person, the close from the daemon — would read six months later as two
   * people, which is the exact confusion this is meant to end.
   */
  async respond(workspace, id, response, { actor = null } = {}) {
    await this.answerOnce(workspace, id, response, { actor });
    await this.closeAnswered(workspace, id, 'Answered via Beadcause', { actor });
    // After the close rather than before it, for the same reason the close is after the
    // comment: the two writes the caller asked for happen first and whatever else fails,
    // and an answer naming three other beads is the single most worth-linking sentence
    // on the whole tracker — it is the one written by the person.
    await this.relateMentions(workspace, id, response);
  }

  /**
   * Answer and hand the work back — `respond` for an option that commissions.
   *
   * The other ending an answer can have. "Build both as written" is not a full stop,
   * and closing on it files the work as finished at the moment it is ordered; the
   * session that picks it up then has to reopen the bead to do what it was just told
   * to do, and the reopen is what walks the card back into the inbox. See the
   * `closes: false` note in lib/decision.js for the bead that taught us this.
   *
   * Three writes, in this order and for these reasons:
   *
   *   - **The comment**, first, exactly as in `respond`: whatever else fails after
   *     it, the answer is on the thread rather than lost.
   *   - **The `human` label comes off**, which is the whole of "out of the inbox".
   *     The inbox is `bd human list` and an advocate's queue is `bd ready
   *     --exclude-label human`, so this one write moves the bead from the first to
   *     the second — it is the same fact read from two sides, not two states to keep
   *     in step.
   *   - **Open, and unclaimed.** `bd ready` skips an assigned bead, and a question
   *     picked up by an agent session carries that agent. Handing back work nobody
   *     can claim would be a quieter version of the failure this replaces.
   *
   * Throws if any of them do, like `respond` does on a refused close — none of these
   * has a gate the way a close does, so a failure here is the Dolt lock or nothing,
   * and `retries` is the answer to that.
   *
   * `stayInInbox` is for the one commission whose work is **not** a bead: answering a
   * conflict sweep's hand-back opens a resolver window on a branch (bc-9d37.8), and the
   * card the answer was given on stays a card — it amends itself as that window gets on
   * with it and closes itself when the branch comes back mergeable. Taking `human` off it
   * would do both halves of this wrong at once: the card would vanish from the inbox
   * while it was still the only thing reporting what it had started, and it would land in
   * an advocate's ready queue, where the next tick would open a *worker* on a summary of
   * a sweep. The label stays; the bead is still open, which is all that "handed back"
   * means here.
   */
  async commission(workspace, id, response, { actor = null, stayInInbox = false } = {}) {
    await this.answerOnce(workspace, id, response, { actor });
    // The label and the status are the daemon moving a bead between two queues, not
    // anybody speaking, so they stay written as beadcause. What a reader wants a name
    // on is the sentence that ordered the work, and that is the comment above.
    if (!stayInInbox) await this.removeLabel(workspace, id, 'human');
    await this.reopen(workspace, id);
    await this.relateMentions(workspace, id, response);
  }

  /**
   * Say something on the way past — the only mark a dismissal leaves on a bead.
   *
   * **Dismissing used to close the bead, and that was the wrong shape entirely.**
   * "I am not dealing with this now" is not "this is decided": an epic with thirty
   * open children is not a question you can answer, and closing it to get it off
   * the screen would have thrown away the thing it was tracking. So the
   * acknowledgement lives in beadcause's own state, the bead is untouched, and
   * this exists for the one case where you typed something first.
   *
   * A comment rather than a close reason, because an agent watching the thread
   * reads comments — a close reason is a line only `bd show` prints. A wordless
   * dismissal calls nothing at all: bd should have no idea it happened.
   */
  async noteOnly(workspace, id, note, { actor = null } = {}) {
    if (!String(note || '').trim()) return;
    await this.run(workspace, ['comment', id, note], { retries: 4, actor });
    await this.relateMentions(workspace, id, note);
  }

  /**
   * Did that close actually happen? Throws if the bead is demonstrably still open.
   *
   * **A zero exit is not a close.** bc-q6qc: bc-3muu.12 was merged as #339, took the
   * comment `finish` writes immediately before the close, and stayed `in_progress` for a
   * day — with no `[bd] … closing over the claim guard` line, no `[merge-queue] … did not
   * close` line and an empty `owed-closes.json`. All three are written by code either side
   * of this call, so their absence says the close neither threw nor forced: `bd close`
   * came back 0 and the row did not move. Nothing above could tell that from success, so
   * the merge-queue card said `merged 1`, the bead said it merged, and the bead was open.
   * That is bc-ec6's failure class — every layer reporting a close it never had.
   *
   * One `bd show` on a path that already spends a write, so it costs a spawn per merge
   * rather than per tick. What it buys is that the *only* two endings left are closed and
   * loudly owed: the throw travels out to whichever caller wrapped this — `finish` in
   * lib/mergequeue.js, the sweep in lib/landed.js, the delivery in bin/deliver.js — and
   * every one of them already knows how to log it, `oweClose` it and say so on the bead.
   *
   * **Fails towards believing the close.** A tracker that throws, a row that has been
   * renamed away, a status this file has never heard of: none of those is evidence that
   * the close did not happen, and inventing a failure from one would put a landed bead in
   * `owed-closes.json` to be retried every thirty seconds for ever. Only a row that comes
   * back saying, in one of bd's own live words, that it is still open counts.
   */
  async assertClosed(workspace, id) {
    let row = null;
    try {
      row = await this.show(workspace, id);
    } catch {
      // "I cannot tell" is not "it did not close". See above.
      return;
    }
    if (!row) return;
    const status = String(row.status || '').trim().toLowerCase();
    if (!LIVE_STATUSES.has(status)) return;
    const err = new Error(`bd exited 0 closing ${id} and the bead is still ${status} — the close did not happen`);
    err.unclosed = status;
    throw err;
  }

  /**
   * Close an issue with a reason of the caller's choosing.
   *
   * Distinct from `respond`, which closes the *question* with a fixed reason. This
   * closes the bead a question was *about* — the work bead a merged pull request
   * finishes — and the reason there should say what landed, since that line is what
   * `bd show` prints months later when the PR is a number nobody remembers.
   *
   * `actor` for the same reason `respond` takes one: tapping Merge closes two beads,
   * the question and the work, and they are one act. Two names across them would read
   * as two people, which is the exact confusion bc-vq21 set out to end.
   *
   * ## `overClaim`, and why it is a second attempt rather than a flag on the first
   *
   * bd 1.2.1 refuses a close when the bead's assignee is not the actor. That is the
   * ordinary state of **every delivered work bead**: the brief tells a worker to
   * `bd update --claim`, which sets the assignee to its git identity, while everything
   * beadcause runs carries the byline `beadcause (…)` so `created_by` says which machine
   * filed it. The two strings differ, so from 2026-08-14 07:21 no delivery could close
   * the bead it had just merged — bc-9d37.13, and the symptom was quiet: an assigned
   * open bead is skipped by `bd ready`, so nothing crashed and nothing re-opened, the
   * tracker simply filled with work that said it was in flight hours after it landed.
   *
   * `--force` clears that refusal, and it is measured rather than inferred: `bd close
   * --help` documents it as covering "pinned issues or unsatisfied gates" and says
   * nothing about the claim guard, but it lifts the claim guard too. **It also lifts
   * everything else** — open children, live blockers, the epic gates — which is why it
   * must not simply be passed on every delivery close. `Bd.gateFor` and `sweepOwed`'s
   * `blocked` path are built on bd refusing those, and a blanket `--force` would quietly
   * close a bead that was still legitimately gated.
   *
   * So: try the close as it has always been tried, and reach for `--force` **only when
   * the thing that refused was the claim guard specifically**. A close refused by a
   * blocker does not match, does not force, and is still owed and retried exactly as
   * before. That is the whole of the widening.
   *
   * The alternative — reclaim first, `bd update --assignee <actor>` — also works and was
   * measured working. It is not used because it rewrites the assignee to the daemon on
   * every delivered bead, so the tracker would permanently forget who did the work. A
   * closed bead keeping its worker's name is worth more than a guard that has already
   * been satisfied by the merge.
   */
  async close(workspace, id, reason, { actor = null, overClaim = false } = {}) {
    try {
      await this.run(workspace, ['close', id, '--reason', reason], { retries: 4, actor });
      await this.assertClosed(workspace, id);
    } catch (err) {
      // Deliberately *not* widened to `err.unclosed`. A close bd said nothing about is a
      // close nobody can explain, and `--force` is a guess at the explanation — the one
      // guess that also lifts open children, live blockers and the epic gates. A refusal
      // it can explain exits non-zero with a sentence, which is what `isClaimGuard` reads;
      // a silent one goes out to the caller and becomes an owed close, which is the
      // acceptance bc-q6qc asks for: closed, or loudly owed, never silently open.
      if (!overClaim || !isClaimGuard(err)) throw err;
      // Said out loud: this is a guard being deliberately stepped over, and the one thing
      // worse than stepping over it is doing so silently. One line, naming the bead, so a
      // close that should not have happened is findable afterwards.
      console.error(`[bd] ${id}: closing over the claim guard — the work is merged and the assignee is not ${actor || this.actor}`);
      await this.run(workspace, ['close', id, '--reason', reason, '--force'], { retries: 4, actor });
      // And again after the force, because `--force` is exactly the call whose failure
      // would otherwise be invisible: nothing is left to try, so a silent one here is the
      // end of the road rather than a step on it.
      await this.assertClosed(workspace, id);
    }
    // A close reason is the one line `bd show` still prints months later, and it is
    // where "superseded by bc-x" and "this is the same job as bc-y, which landed" get
    // written. Closed at both ends is exactly when a see-also earns its keep, because
    // by then nobody is going to open either description again.
    await this.relateMentions(workspace, id, reason);
  }

  /**
   * Put a closed or in-progress bead back in the ready queue.
   *
   * What "request changes" needs: the work bead was claimed by the session that
   * built the branch, and a claimed bead never comes back through `bd ready`. So
   * asking for changes reopens it and drops the claim, which is the only signal the
   * advocate reads — without it your note would sit on a bead nothing would ever
   * pick up again.
   */
  async reopen(workspace, id) {
    await this.run(workspace, ['update', id, '--status', 'open', '--assignee', ''], { retries: 3 });
  }

  /**
   * The same write, for a claim whose holder is **gone** — and only for that.
   *
   * `reopen` above is refused outright by bd 1.2.1 whenever the assignee is not the actor,
   * and on the two paths that put a *worker's* bead back that is not an edge case, it is
   * every time (see `REASSIGN_GUARD_RE`): the window claimed the bead as the human and
   * beadcause is doing the releasing. The bead then stays `in_progress` and assigned, which
   * takes it out of `bd ready` — so the one thing that would ever have retried it is the
   * hand-back that just failed, and nothing comes back for it. Twenty of them, four still
   * sitting (bc-xl7n.85).
   *
   * **`--force`, and the refusal itself is what says so**: *"pass --force only if their
   * claim is abandoned (crashed agent, expired lease)"*. Both callers have already
   * established exactly that before they get here — `handBack` is called *because* the
   * window is gone, and `bin/plan.js` is the holder, releasing its own claim through an
   * actor string that does not match it. That is the whole reason this is a second method
   * and not a flag on `reopen`: the review path in lib/server.js and `commission` reopen
   * beads whose claim is **live**, where the guard is doing the job it was added for, and
   * a shared parameter is one careless `true` away from lifting it there too.
   *
   * Lazy, like `closeAnswered`'s clear: try it as `reopen` has always tried it, and reach
   * for the flag only when the guard is what refused. `run` retries on lock contention
   * alone, so a refusal comes straight back rather than after three backoffs, and a bead
   * nobody was holding is never forced. Said out loud when it happens, because the worst
   * version of stepping over a guard is the quiet one.
   *
   * What `--force` costs here is close to nothing, which is not true of the flag in
   * general: on `bd update` it lifts this guard and the gates around moving an issue into
   * a *done* status, and the argv is pinned one line below at `--status open`. Do not
   * reach for this method for any other write.
   */
  async reopenAbandoned(workspace, id) {
    try {
      return await this.reopen(workspace, id);
    } catch (err) {
      if (!isReassignGuard(err)) throw err;
      console.error(`[bd] ${id}: forcing the claim off — its holder is gone, and the bead cannot come back while it is on`);
      return await this.run(workspace, ['update', id, '--status', 'open', '--assignee', '', '--force'], {
        retries: 3,
      });
    }
  }

  /**
   * Move a bead between `open` and `in_progress` — the status write and nothing else.
   *
   * What the P0 board needs (bc-s8mc): starting an epic from the phone is *only* a status
   * write, because that is what the board reads. Deliberately not `bd update --claim`,
   * which is the same status plus an assignee: the assignee of an epic is whoever is
   * actually working it, an EpicAdvocate writes itself in there when one opens, and a tap
   * on a picker saying "this is what my week is about" is not a claim to be doing it right
   * now. `reopen` above is the neighbouring write and is deliberately not reused for the
   * reverse direction either — it clears the assignee, which on an epic being taken off
   * the board would throw away who is on it as a side effect of a screen decision.
   *
   * The graph cache is refreshed after the write, the way `adopt` refreshes it, and for a
   * sharper reason: the board is drawn from `graph({ wait: false })`, which answers from
   * a cache held for a minute. Without this the card you just asked for would not appear
   * for up to sixty seconds — the write having worked, the screen having nothing to say
   * about it, which is exactly the "silently absent card" this feature must not have.
   */
  async setStatus(workspace, id, status, { actor = null, refresh = true } = {}) {
    await this.run(workspace, ['update', id, '--status', String(status)], { retries: 4, actor });
    if (refresh) await this.graph(workspace, { refresh: true }).catch(() => {});
  }

  /**
   * Rewrite the fields of a bead that already exists — one `bd update`, whatever moved.
   *
   * What "adjust" needs (lib/verdict.js): a bead filed by an agent whose title is wrong
   * or whose priority is optimistic, corrected before it is endorsed. Everything that
   * moves goes in one invocation rather than one per field, because each is a Dolt
   * write on a single-writer database and six of them is six chances to lose a lock
   * race over what the caller thinks of as one edit.
   *
   * Labels move as `--add-label` / `--remove-label` and never `--set-labels`. The
   * difference matters: a bead carries labels this daemon manages — `unendorsed` is the
   * hold itself — and a replacing write would take them off as collateral of an edit
   * that never mentioned them. What may be added and removed is decided in
   * lib/verdict.js, which knows which labels are nobody's to set.
   *
   * A call with nothing to do runs nothing at all, so a client that posts its whole
   * form on every save costs a `bd show` and no write.
   */
  async update(
    workspace,
    id,
    { title, type, priority, description, acceptance, notes, externalRef, addLabels = [], removeLabels = [] } = {},
    { actor = null } = {}
  ) {
    const args = ['update', id];
    if (title) args.push('--title', String(title));
    if (type) args.push('--type', String(type));
    /**
     * The link to whatever raised this outside the tracker — `jira-TECH-1`, `gh-9`.
     *
     * On `update` and not only on `create` because of the one case that needs it: on a
     * tracker somebody has been working by hand, a ticket's epic is often a bead that
     * already exists, and lib/jiraepic.js adopts that rather than filing a second one
     * beside it. Writing the ref is what makes the adoption stick — without it the same
     * fuzzy title match is re-made on every restart, forever.
     */
    if (externalRef) args.push('--external-ref', String(externalRef));
    if (priority !== undefined && priority !== null && priority !== '') args.push('--priority', String(priority));
    if (description) args.push('--description', String(description));
    if (acceptance) args.push('--acceptance', String(acceptance));
    if (notes) args.push('--notes', String(notes));
    for (const label of addLabels) args.push('--add-label', String(label));
    for (const label of removeLabels) args.push('--remove-label', String(label));
    if (args.length === 2) return;
    await this.run(workspace, args, { retries: 4, actor });
    // Only the fields that actually moved. A save that rewrote the title alone must not
    // re-link what the description said last week — that prose has not been written
    // here, and whatever it named was linked when it was.
    await this.relateMentions(workspace, id, [title, description, acceptance, notes].filter(Boolean).join('\n\n'));
  }

  /**
   * Every live bead's title in this workspace, cheap enough to ask before every create.
   *
   * One `bd export`, shared with `graph` — which the epic board, lib/homing.js and the
   * dispatch gate keep warm on a running daemon, so the steady-state cost of the check
   * below is a `Map` walk and no spawn at all. Held for a minute on its own timer; see
   * `TITLES_CACHE` for why it is not the parent cache's entry.
   */
  async liveTitles(workspace) {
    const key = workspace?.name || workspace?.dir || '';
    const hit = TITLES_CACHE.get(key);
    if (hit && Date.now() - hit.at < TITLES_TTL_MS) return hit.rows;
    const rows = openRows(await this.graph(workspace));
    TITLES_CACHE.set(key, { at: Date.now(), rows });
    return rows;
  }

  /**
   * A bead just filed, folded into the cached list so the next create in the same batch
   * can see it.
   *
   * The case this is for is one session filing three discoveries in one pipe, two of
   * which it worded almost identically — which is a duplicate nothing else here would
   * catch, because the second create happens well inside the cache's minute. Only into a
   * list that already exists: filling a cold entry from one row would answer "nothing
   * resembles this" about a workspace of eight hundred beads.
   */
  rememberTitle(workspace, row) {
    const hit = TITLES_CACHE.get(workspace?.name || workspace?.dir || '');
    if (hit && row?.id && row?.title) hit.rows.push({ id: row.id, title: row.title, status: 'open', labels: [] });
  }

  /**
   * The live bead this title is a near-verbatim copy of, or null — the whole of the
   * create-time half of bc-arj0.6.
   *
   * lib/dupe.js was written for the proposal path, because that is where the pair it was
   * built from (bc-j6x / bc-ec6) collided. The duplicates that kept arriving afterwards
   * were not proposals: bc-297u/bc-syzm, bc-767a/bc-giuc and bc-zjep/bc-zflo were each
   * filed by a worker mid-session, hours apart, and nothing joined them up until somebody
   * read the titles by hand weeks later. At epic scale bc-xpwh was a verbatim copy of
   * bc-nib3 and it took a bead of its own to notice.
   *
   * So the check moved to the seam every one of them actually went through. Every bead
   * beadcause files — a worker's discovery, an approved proposal, a console draft, a JIRA
   * epic, a crash the daemon files on itself, an edit filed from the app — is created
   * here, so a call site added next month is covered without knowing this exists. That is
   * the same argument the addressee and owner stamps in `create` are here for.
   *
   * **Questions are not checked, and that is the one exclusion.** A `human` bead is a card
   * addressed to a phone, not work: the sweep card, the stranded-branch finding and the
   * merge card all have formulaic titles by construction, each of those modules already
   * refuses to file its own twin, and a resemblance paragraph on an inbox card is noise on
   * the one surface where noise costs most. Nothing is excluded on the *candidate* side —
   * a work bead that reads like an open question is worth knowing about.
   *
   * **It never throws and it never blocks the create.** A tracker that cannot be read is
   * the state every bead was filed in before this existed, and losing a discovery over a
   * courtesy would be the wrong trade in the same direction lib/filing.js already refuses.
   */
  async duplicateOf(workspace, title, { ignore = [], labels = [] } = {}) {
    if (!title || (labels || []).includes('human')) return null;
    try {
      const rows = await this.liveTitles(workspace);
      if (!rows.length) return null;
      // `pending: false`: the graph index carries no descriptions, so there is no
      // `beadproposal` block to read out of a proposal question. Every caller that has
      // the full rows still runs the pending half — see `openRows`.
      return findDuplicate(title, liveCandidates(rows, { ignore, pending: false }));
    } catch {
      return null;
    }
  }

  /**
   * File a new issue and return its id.
   *
   * Same shape as `bin/ask.js`, but the body arrives over HTTP rather than a pipe,
   * so there's no shell to quote a fenced decision block past. The optional fields
   * exist for approved advocate proposals, which carry everything a hand-written
   * bead would — what done looks like, the design call, what it hangs off — and
   * would otherwise be flattened into one description on the way in.
   *
   * `actor` is separate from the fields because it is not one: it is who filed this,
   * not anything about the bead. It lands in `created_by` — a byline — and leaves
   * `owner` alone, so a bead you filed from your phone is still in the same queue,
   * still returned by `bd ready`, and still offered to the advocate. See the note on
   * the class above; that distinction is the reason this parameter exists at all.
   */
  async create(
    workspace,
    {
      title,
      body = '',
      priority = 1,
      type = 'task',
      labels = ['human'],
      acceptance = '',
      design = '',
      notes = '',
      deps = [],
      parent = '',
      externalRef = '',
    },
    { actor = null } = {}
  ) {
    /**
     * Is this already filed? — bc-arj0.6, and the one place it can be asked of every
     * caller at once. See `duplicateOf` for what is checked and what is not.
     *
     * The verdict becomes a paragraph in the bead's own notes, which is also what draws
     * the edge: the id is in the prose, so `relateMentions` at the bottom of this method
     * wires the pair without a second write of its own. Nothing is said twice — a caller
     * that already named the duplicate itself (lib/filing.js writes its own sentence, and
     * lib/server.js's approval refuses outright over one the card did not mention) has
     * said it better, with context this seam does not have.
     */
    const dup = await this.duplicateOf(workspace, title, { labels });
    const said = dup && mentionsIn([body, acceptance, design, notes].join('\n\n'), prefixOf(dup.id)).includes(dup.id);
    let filedNotes = notes;
    if (dup && !said) {
      filedNotes = [notes, resemblanceNote(dupeNote(dup))].filter(Boolean).join('\n\n');
      // stderr and not stdout, which is not a style choice: `bin/file.js` documents its
      // stdout as one bead id per line so `$(beadcause-file …)` is a list, and this line
      // runs *inside* that command. A `console.log` here would put a sentence of English
      // in the middle of the ids, on exactly the filings this exists to notice. The
      // daemon captures both streams, so nothing is lost at the other call sites.
      console.error(`[beadcause] "${title}" is ${dupeNote(dup)} — filing it linked to that one`);
    }
    const args = ['create', '--title', title, '--type', type, '--priority', String(priority)];
    /**
     * A question filed by this daemon is this Mac's person's question.
     *
     * Here rather than at each of the four call sites — an advocate's proposal, an
     * agent's foundation request, an error the app filed on itself, a release — because
     * they have exactly one thing in common and it is the thing that matters: they were
     * all written by *this* machine, on a graph five others can see. A fifth call site
     * added next month gets it for free, and a call site that forgot would be a
     * question ringing six phones with nothing to say it should not have.
     *
     * **Only when the bead is a question.** `labels` is `['human']` by default and
     * something else entirely for the work beads lib/filing.js creates, which nobody is
     * notified about and which belong to whoever picks them up. Addressing one of those
     * would be claiming work rather than routing a decision.
     */
    const own = labels.includes('human') ? ownAddresseeLabels({ me: this.me }) : [];
    /**
     * A root filed by this daemon is this Mac's person's root.
     *
     * Here for the reason the addressee above is here — one write path, five call sites,
     * and a sixth added next month that would otherwise have to remember. The difference
     * is the condition: an addressee is stamped on a *question*, because that is the kind
     * of bead a phone rings about, and an owner is stamped on a **root** — an epic at any
     * priority, or a P0 (`isRoot`, lib/ownership.js) — because that is the kind of bead
     * somebody has to be answerable for. The two are independent and a bead can carry
     * both — a P0 question is a decision you own.
     *
     * **The type is in the condition since bc-htoy**, and its absence was the sharpest
     * edge of the old rule. Filing an epic through this path gave it no owner unless you
     * had also called it the most urgent thing on the tracker, so the daemon's own epics
     * arrived unowned — off the board, with no advocate, invisible to the sweep that
     * would have picked them up — and the only fix was to inflate the priority.
     *
     * **But an unendorsed epic is not yours, and that asymmetry is the whole of the care
     * this widening needed.** lib/jiraepic.js files every ingested ticket as an
     * `unendorsed` P1 epic — which is to say, exactly the shape that just became a root —
     * so a stamp that did not ask would have handed this Mac's person ownership of the
     * entire JIRA backlog on the next sweep: forty cards on the board, forty entries on
     * the advocate roster, and the inbox below narrowed to their descendants. Ownership is
     * a claim that somebody agreed to carry this, and `unendorsed` is the label that says
     * nobody has yet. The P0 half is deliberately left as it was — an unendorsed P0 was
     * stamped before this bead and still is, because changing it would be a second
     * behaviour change smuggled in beside the first.
     *
     * Not clamped anywhere on the way in, deliberately: lib/filing.js already holds an
     * agent-filed bead at `PRIORITY_FLOOR`, so what reaches this line at P0 is a bead a
     * person chose the priority of, and an owner is exactly what that bead should carry.
     * A caller that never mentioned an owner gets one anyway, which is the whole feature —
     * see lib/ownership.js for why an unowned root is the state bc-rfnr.5 exists to clear.
     *
     * **An owner the caller named wins.** A root filed *for* somebody else — the triage
     * adopting a bead, a console draft naming a colleague — arrives with its own
     * `owner:` label, and stamping this Mac's on top would give it two owners and make
     * the second one a lie. So this is a default and not an override.
     */
    const ownable = isP0({ priority }) || (isEpic({ type }) && !labels.includes(UNENDORSED));
    const mine = ownable && !ownersOf(labels).length ? ownOwnerLabels({ me: this.me }) : [];
    for (const label of [...labels, ...own, ...mine]) args.push('--label', label);
    if (body) args.push('--description', body);
    if (acceptance) args.push('--acceptance', acceptance);
    if (design) args.push('--design', design);
    if (filedNotes) args.push('--notes', filedNotes);
    /**
     * What raised this outside the tracker, and the reason it is here rather than in a
     * description: it is the *lookup key*. lib/jiraepic.js has to answer "does this JIRA
     * ticket already have an epic" before it creates one, on every sweep, forever — and a
     * ref in a paragraph is a thing you can read but not ask about. `bd list --json`
     * carries `external_ref` on every row, so one list answers it for a whole workspace.
     */
    if (externalRef) args.push('--external-ref', String(externalRef));
    // `bd create --deps` takes 'type:id' or a bare id, and is repeatable.
    for (const dep of deps) args.push('--deps', dep);
    // A bead created without its parent has to be re-parented by hand afterwards,
    // and the console's drafts hang whole trees off one another.
    if (parent) args.push('--parent', parent);
    /**
     * And it is born carrying its own labels only — bc-xl7n.60.
     *
     * `bd create --parent` copies the parent's labels onto the child, and several of the
     * markers this daemon writes are statements about **one bead at one moment** rather
     * than properties of a subtree. `container` (lib/container.js) says "this is
     * furniture, never work it"; `human` (lib/park.js) routes a bead to the inbox as a
     * question; `held:<stamp>:<handle>` (lib/lease.js) is a lease on a window that was
     * opened on somebody else. Inherited, every one of them is false of the child, and the
     * first two are not cosmetic: both are in `QUEUE_EXCLUDED` (lib/endorse.js), which
     * lib/advocate.js passes as `excludeLabels`, so the child is out of every queue *after*
     * it is endorsed — endorsing it looks like it worked and changes nothing — and
     * `assertNotContainer` refuses it 409 at the worker and the planner's door. It reads as
     * ordinary open work on every screen and is dispatched by nothing.
     *
     * Measured rather than reasoned: in the three hours after bc-xl7n was marked a
     * container every bead filed under it inherited the marker, and seven more arrived in
     * seven hours on 2026-08-17 before a hand stripped them. It is the busiest filing
     * target in the graph — every ship follow-up, sweep card and advocate finding lands
     * there by construction — which is what makes "a hand strips it afterwards" a standing
     * chore rather than a mitigation.
     *
     * **Only `create` inherits.** `bd update <id> --parent` does not, measured against
     * 1.2.1 on 2026-08-17 — so lib/adoptsweep.js moving a bead under an epic is not a
     * second door onto this and `setParent` below needs nothing.
     *
     * **Off wholesale rather than filtered to those markers**, which is the choice worth
     * defending. Every caller of this method already passes the exact labels it means:
     * lib/filing.js composes them (`unendorsed`, `agent-filed`, the tier), lib/sweepcard.js
     * and lib/notinmain.js pass `[HUMAN_LABEL]`, and the addressee and owner stamps above
     * are decided right here — so there is nothing a child was getting from its parent that
     * anybody had chosen for it. Filtering would mean reading the parent's labels back to
     * re-add the survivors, a bd call this path does not otherwise make, behind a list that
     * has to be extended every time a marker is invented — and a list nobody extends is how
     * `held:` came to be handed down in the first place. The topical labels a child loses
     * are read on roots or not at all: `unsortedP0` (lib/homing.js) is the only reader of
     * `unsorted` and it asks P0 roots, and `inbox` and `tracker` have no reader here.
     *
     * **Falls back if the flag is not there**, the same shape and for the same reason as
     * `showWithComments`: `--no-inherit-labels` exists in bd 1.2.1, nothing in this repo
     * pins a minimum, and an unknown flag makes bd exit non-zero having filed nothing. A
     * hard failure would lose the bead outright, where degrading loses only the fix — which
     * is where this repo stood yesterday. One wasted spawn for the life of the daemon:
     * `LOCK_RE` does not match an unknown flag, so `retries` never fires on it.
     */
    const noInherit = Boolean(parent) && this.inheritsLabelsRegardless !== true;
    if (noInherit) args.push(NO_INHERIT_LABELS);
    let created;
    try {
      created = await this.json(workspace, args, { retries: 4, actor });
    } catch (err) {
      if (!noInherit || !UNKNOWN_FLAG_RE.test(String(err?.message || ''))) throw err;
      this.inheritsLabelsRegardless = true;
      // stderr for the reason the duplicate line above is on stderr: `bin/file.js`
      // documents its stdout as one bead id per line, and this runs inside that capture.
      console.error(
        '[beadcause] this bd has no `create --no-inherit-labels` — a bead filed under a parent will inherit its labels, `container` and `human` included'
      );
      created = await this.json(workspace, args.filter((a) => a !== NO_INHERIT_LABELS), { retries: 4, actor });
    }
    /**
     * A bead born under a parent is a bead the cached shape has never heard of.
     *
     * `graph` holds a minute (see it for why), and a walk upwards from an id that is not
     * in the index finds no ancestors — so for that minute `hasRootAbove` answers **false**
     * about a bead that was deliberately given a P0 above it, and lib/underroot.js says so
     * out loud: a skipped tick, a bus event and a `nothing decided above this` pill making a claim
     * that is not true. bc-rfnr.8 files under a P0 precisely to avoid that pill, and
     * without this line it would produce one on the way in.
     *
     * Dropped rather than rebuilt, unlike `adopt`. That call is one tap answering one
     * hold and can afford the export; this one runs three times in a row for a session
     * filing three discoveries, and three exports for one answer is the cost `graph`'s
     * in-flight map exists to refuse. The next reader pays for one, which it was going
     * to within the minute anyway.
     *
     * The cost lands on the `wait: false` readers rather than on this call: for the
     * second or two before the rebuild arrives, `rootBoard` has no shape and answers an
     * empty `roots`, which the client already treats as "do not narrow anything" — the
     * flat inbox for one repaint. That is the same state a warming daemon is in for its
     * first seven seconds, and it is the safe direction: over-showing.
     */
    if (parent) forgetParents(workspace?.name || workspace?.dir || '');
    const id = created?.id || created?.issue?.id || null;
    /**
     * The bead that names another bead in the sentence explaining why it exists.
     *
     * This is the highest-value moment of the lot. "Found while working bc-3zo9.4",
     * "the same defect as bc-767a", "blocked until bc-2tr is decided" are all written
     * here, on the way in, by whoever knew — and lib/filing.js already turns exactly one
     * of those into an edge (`discovered-from`). Everything else in the paragraph was
     * being thrown away, on a bead nobody will read the description of again.
     *
     * The `deps` and `parent` this create just wired are read back rather than assumed:
     * `relateMentions` asks bd what this bead is already joined to, which is both cheaper
     * to reason about than tracking the flags and correct for an id that arrived in
     * `deps` as `discovered-from:bc-x` rather than as a bare id.
     */
    if (id) await this.relateMentions(workspace, id, [title, body, acceptance, design, filedNotes].filter(Boolean).join('\n\n'));
    // Into the cached title list, so a batch filing the same thing twice catches its own
    // second bead. After the mentions rather than before, because nothing should be able
    // to make this bead a candidate for itself. See `rememberTitle`.
    if (id) this.rememberTitle(workspace, { id, title });
    return id;
  }

  /**
   * Move a bead under a parent — `bd update <id> --parent <parent>`.
   *
   * The one write bc-rfnr.7's refusal can be answered with. A bead with nothing decided
   * above it is not workable, the sheet offers a root to adopt it, and this is what that
   * tap runs; an
   * empty parent detaches it again, which is how a bead adopted under the wrong epic is
   * put back rather than left worse.
   *
   * **The cached shape is dropped on the way out, not left to expire.** `graph` caches for
   * a minute (see it for why), and this is the one call whose entire purpose is to change
   * what that cache says. Without the refresh the phone's own promise — adopt it and it
   * becomes workable, with no other change — would be true up to a minute later, which on
   * a 30-second advocate tick is a bead you fixed being refused again in front of you.
   *
   * It does **not** renumber: `bc-9zz` adopted under `bc-rfnr` keeps its flat id, and a
   * bead moved out of an epic keeps the id it had inside it. That is bd's behaviour rather
   * than a choice here, and it is exactly why lib/ancestry.js walks edges instead of
   * trusting the dots in an id.
   *
   * **`refresh: false` is for the caller applying a batch of them**, which is
   * lib/adoptsweep.js and nothing else. The refresh is a whole `bd export` — a second or
   * more on a loaded Dolt — and one per adoption is what turns applying an epic's
   * twenty-three-bead list into twenty-three of them for one answer. That caller
   * refreshes once when it has finished writing. Anything answering a tap leaves it
   * alone: the phone's promise is that the bead is workable *now*, and it is the cache
   * that would otherwise say otherwise for the next minute.
   */
  async adopt(workspace, id, parent, { actor = null, refresh = true } = {}) {
    await this.run(workspace, ['update', id, '--parent', String(parent || '')], { retries: 4, actor });
    if (refresh) await this.graph(workspace, { refresh: true }).catch(() => {});
  }

  /**
   * `bd dep add <issue> <depends-on>` — issue is blocked until depends-on closes.
   *
   * **A declared edge outranks a prose-mention see-also, and this is where that is
   * enforced for everything in the daemon.** bd holds one row per ordered pair and
   * refuses a second type on it, so a bead whose description says *why* it waits on
   * bc-x — naming bc-x, which is the description doing its job — arrives here already
   * joined to bc-x by the `relates-to` that `relateMentions` drew on the way past, and
   * the dependency the proposal actually declared is refused. That is bc-arj0.20, and
   * it is the exact shape of proposal this app asks people to write.
   *
   * Ordering the two writes so declared edges went first would have hidden it rather
   * than settled it: the prose sweep runs on its own afterwards (bc-arj0.10), so the
   * collision can arrive long after the bead was filed, on a pair nobody is writing.
   * So the rule is about precedence, not sequence — the see-also is taken off and the
   * declared edge is written in its place, both ends of it, and `demoteRows` in
   * lib/mentions.js holds the whole judgement about when that is allowed. Anything
   * bd refuses over an edge that is *not* a mention — `discovered-from` above all —
   * is refused here too, unchanged, and reaches the caller as the error it always was.
   *
   * One retry and no loop. The second `dep add` is against a pair this process has
   * just emptied; if bd refuses that one as well then something else is writing the
   * same pair, and a session that kept trying would be racing it rather than fixing
   * anything.
   */
  async addDep(workspace, id, dependsOn) {
    const args = ['dep', 'add', String(id), String(dependsOn)];
    try {
      return await this.run(workspace, args, { retries: 4 });
    } catch (err) {
      const refused = refusedEdgeType(err?.message);
      if (!isRelated(refused)) throw err;
      // The other half of the relate, read before anything is deleted: `bd dep relate`
      // writes both rows, but a pair can hold a mention one way and something older the
      // other, and that older row is not this write's to take.
      const reverse = await this.edgeType(workspace, dependsOn, id);
      const rows = demoteRows(id, dependsOn, { refused, reverse });
      if (!rows) throw err;
      for (const [a, b] of rows) await this.dropDep(workspace, a, b);
      console.log(
        `[beadcause] ${id} → ${dependsOn}: dropped the \`${refused}\` a prose mention drew, so the declared edge could go in`
      );
      return await this.run(workspace, args, { retries: 4 });
    }
  }

  /**
   * The type of one edge, in one direction — `to → from` is a different question from
   * `from → to` and bd answers them separately.
   *
   * `bd dep list <id>` without `--direction` is that bead's **outgoing** rows and
   * carries `dependency_type` on each, which is the cheapest way to ask; `linkedTo`
   * below wants both directions and pays two spawns for it, and this one deliberately
   * does not. Null for a pair with no edge that way, and null for a read that failed —
   * the one caller treats both as "nothing of mine to remove", which is the safe answer
   * either way.
   */
  async edgeType(workspace, from, to) {
    const rows = (await this.json(workspace, ['dep', 'list', String(from)]).catch(() => [])) || [];
    const want = String(to || '').toLowerCase();
    const row = rows.find((r) => String(r?.id || '').toLowerCase() === want);
    return row ? String(row.dependency_type || '').trim().toLowerCase() || null : null;
  }

  /**
   * Take the edge back off: `bd dep remove <issue> <depends-on>`.
   *
   * What a merge needs. A delivery parks its work bead behind its merge card, so
   * answering that card cannot close the work bead — the card is still open at the
   * moment the merge runs, and bd refuses a close over an open blocker. The card is
   * being answered in the same breath, which is exactly when the edge stops meaning
   * anything, so the merge drops it rather than leaving the close to fail.
   */
  dropDep(workspace, id, dependsOn) {
    return this.run(workspace, ['dep', 'remove', id, dependsOn], { retries: 3 });
  }

  /**
   * Does this id exist in this workspace?
   *
   * The console's drafts may name real beads in `dependsOn` — that is how "this new
   * work waits on the one we started from" is written — and a ref and an id are not
   * reliably distinguishable by shape. So the tracker is asked rather than the regex
   * trusted, and an id that isn't there is reported instead of failing the whole
   * create at `bd dep add`.
   */
  async exists(workspace, id) {
    try {
      return Boolean(await this.show(workspace, id));
    } catch {
      return false;
    }
  }

  /**
   * Claimable work: open, unblocked, not deferred, nobody on it.
   *
   * `bd ready` applies the blocker-aware semantics itself, which is the reason to
   * use it over `list --status=open` — "ready" is a question about the dependency
   * graph, and reimplementing it here would drift from bd's own answer the first
   * time a dependency type was added. An advocate pushing at a blocked bead is
   * pushing at something only another bead can move.
   *
   * `--limit 0` overrides bd's default of 100. An advocate that saw the first
   * hundred beads of a busy repo and called the rest done would be wrong in the
   * one direction that matters.
   *
   * **`unendorsed` is excluded whatever the caller asks for.** Not a default a caller
   * can talk past: a bead nothing may open a session on is not claimable work, so
   * "ready" must never name one, and a stale call site passing `{ excludeLabel:
   * 'human' }` on its own would otherwise put the hole in lib/endorse.js's first layer
   * straight back. `--exclude-label` is a repeatable string slice in bd (checked against
   * 1.1.2 rather than assumed: repeated and comma-joined both exclude ANY of them), and the
   * rows are filtered here as well — the rows carry `labels`, the check costs nothing,
   * and this way the queue is right even against a bd that quietly ignored the flag.
   *
   * **And `superseded-by:<id>` is excluded too**, for the same reason and by a weaker
   * mechanism. A bead a worker has marked a duplicate of another is not claimable work
   * either — see lib/superseded.js — but the label carries the original's id in it, so
   * there is no fixed string to hand `--exclude-label` and the filter is the row check
   * below and nothing else. That is why the refusal in `openWorkSession` matters more
   * here than it does for endorsement: this half is one call site away from a hole.
   *
   * **And `ship` is excluded whatever the caller asks for**, by the same mechanism and for
   * a stronger version of the same reason. A ship bead is one merged pull request waiting
   * for a deploy, and only the deploy closes it — there is no state an agent could put it
   * in, so it is not claimable work by anything that reads this list. It used to be kept
   * out by being filed `unendorsed`, which is a marker one tap of "Endorse all" removes;
   * twenty-five of them came back into this queue that way. See lib/shipbead.js.
   *
   * `excludeLabel` is still read, for a caller written before this took a list.
   */
  async ready(workspace, { excludeLabels = null, excludeLabel = null } = {}) {
    const asked = [].concat(excludeLabels ?? excludeLabel ?? ['human']).filter(Boolean).map(String);
    const labels = [...new Set([...asked, UNENDORSED, SHIP_LABEL, CONTAINER])];
    const args = ['ready', '--limit', '0'];
    for (const label of labels) args.push('--exclude-label', label);
    const rows = (await this.json(workspace, args)) || [];
    return rows.filter(
      (r) => !isSuperseded(r) && !(r?.labels || []).some((l) => labels.includes(String(l).trim()))
    );
  }

  /**
   * The other side of that filter: ready, not in the inbox, and marked a duplicate.
   *
   * What lib/superseded.js sweeps. "Ready" is the whole of the timing — a duplicate
   * parked behind its original is blocked until the original closes, so a marked bead
   * turning up here *is* the event the sweep exists for.
   *
   * `--exclude-label human` does double duty: a bead already asked about carries it, so
   * this list is "not yet asked" without a second thought. There is no `--label` to
   * narrow it with the way `readyHeld` can — the id is in the label — so this pays for
   * a full `bd ready --json`, which is why it runs on the sweep interval and not on the
   * tick.
   */
  async readySuperseded(workspace) {
    const args = ['ready', '--limit', '0', '--exclude-label', 'human'];
    const rows = (await this.json(workspace, args)) || [];
    return rows.filter((r) => isSuperseded(r));
  }

  /**
   * The beads `ready` above deliberately never returns: ready in every other way, and
   * held for endorsement.
   *
   * Only a count is wanted (lib/work.js), and it is wanted because the alternative is a
   * monitor that says "9 ready" over a queue of 4 and no explanation of the other five.
   * A separate call rather than one unfiltered `bd ready` because held beads are few and
   * `bd ready --json` carries every row's whole description — a busy workspace is 88KB
   * of it, on a screen that refreshes every twenty seconds.
   *
   * **Ship beads are not in it, and that is what keeps the pill and its destination in
   * agreement.** `N held for endorsement` on the advocate console is a *link* to
   * /endorse, and lib/endorsequeue.js does not draw ship beads — a count of thirteen
   * over a screen showing one is the kind of number you stop believing. They are held in
   * the tracker's eyes (lib/release.js still files them with the marker) and in nobody
   * else's: no decision is waiting on you for a merged pull request. See
   * `readyShip` for the other half, which is why they come out of `ready` as well.
   */
  async readyHeld(workspace) {
    const args = ['ready', '--label', UNENDORSED, '--exclude-label', SHIP_LABEL, '--limit', '0'];
    const rows = (await this.json(workspace, args)) || [];
    return rows.filter((r) => !(r?.labels || []).some((l) => String(l).trim() === SHIP_LABEL));
  }

  /**
   * The other set `ready` above never returns: ready in every other way, and a ship bead.
   *
   * Only a count is wanted, for `readyHeld`'s reason turned around. `bd status` counts a
   * ship bead as ready — it is open and nothing blocks it — but nothing will ever open a
   * session on one (lib/shipbead.js), so a monitor quoting `ready_issues` raw states as
   * waiting work a number of beads whose only remaining act is your tap on Ship.
   *
   * It has to be its own call rather than a subtraction inside `readyHeld`, because the
   * two sets only partly overlap: a ship bead filed today carries `unendorsed` and one
   * that "Endorse all" reached does not, and the second kind is exactly the cohort that
   * caused the incident. Counting only the held ones would leave twelve of them on the
   * board's ready number with nothing to explain them.
   */
  async readyShip(workspace) {
    const args = ['ready', '--label', SHIP_LABEL, '--limit', '0'];
    return (await this.json(workspace, args)) || [];
  }

  /**
   * Issues carrying a label **whatever their status** — closed ones included.
   *
   * `listLabel` below is the right default and this is not a loosening of it: a label
   * normally marks something still to do, and a closed bead has been dealt with. bc-fvmx
   * has the one case where the opposite is true. Its `req-glean` label is applied at the
   * moment a bead *lands*, which is to say the moment it closes, and asking what shipped
   * without a requirement is a question about finished work by definition. Filtered the
   * usual way it would return nothing, forever, and read as "nothing owes a requirement".
   */
  async listLabelAny(workspace, label) {
    const args = ['list', '--label', label, '--status=open,in_progress,blocked,closed', '--limit', '0'];
    return (await this.json(workspace, args, { retries: SWEEP_RETRIES })) || [];
  }

  /** Live issues carrying a label — how an advocate finds its own outstanding ask. */
  async listLabel(workspace, label) {
    const args = ['list', '--label', label, '--status=open,in_progress,blocked', '--limit', '0'];
    const rows = (await this.json(workspace, args, { retries: SWEEP_RETRIES })) || [];
    return rows.filter((r) => r && r.status !== 'closed');
  }

  /** Issue counts for a whole workspace, in one call. */
  async status(workspace) {
    const out = await this.json(workspace, ['status']);
    return out?.summary || null;
  }

  /**
   * The other half of the tracker: every live bead that is NOT a question.
   *
   * "Live" is open, in_progress or blocked — deferred and closed are deliberately
   * out, since neither is anything an agent is on. The `human` exclusion is done by
   * bd rather than here so the rows never cross the process boundary at all: a
   * workspace like climative is 88KB of `bd list --json` because every row carries
   * its whole description, and the questions are already in hand from listHuman.
   *
   * `--limit 0` overrides bd's default of 50. Without it a busy workspace reports
   * its first fifty beads and the count on the phone reads as the whole truth.
   */
  async listAgent(workspace) {
    const args = [
      'list',
      '--status=open,in_progress,blocked',
      '--exclude-label',
      'human',
      '--limit',
      '0',
    ];
    return (await this.json(workspace, args, { retries: SWEEP_RETRIES })) || [];
  }

  /**
   * Every issue in a state — `in_progress` is what "an agent is on this" means.
   *
   * `status` is passed to bd verbatim, so it takes a comma list as readily as one
   * state: `'open,in_progress,blocked'` is how the graph gets the dates for every
   * live bead at once. Unlike listAgent this excludes nothing, because a `human`
   * bead is a node in the graph like any other.
   *
   * `--limit 0` because bd's own default is 50: without it a busy workspace would
   * silently report the first fifty and the sessions view would look complete.
   */
  async listStatus(workspace, status) {
    return (await this.json(workspace, ['list', `--status=${status}`, '--limit', '0'])) || [];
  }

  /**
   * Every issue that is *not closed*, in one call — bd's own default filter, unnamed.
   *
   * The twin of `listAll` below and for the same reason: a hand-written status list is
   * a second copy of bd's definition of "live", free to drift from it and silent when
   * it does. `bd list` with no `--status` hides closed issues and nothing else, so what
   * comes back is exactly the set a future state nobody here has heard of would join.
   * Measured on this workspace on 2026-08-11: 578 issues, 427 of them closed, 151 back.
   *
   * The one caller is lib/landed.js, where this replaces up to three `bd show`
   * subprocesses *per merged pull request* with one query per sweep. That is the whole
   * reason the sweep can afford to look at a fortnight — see the header there.
   */
  async listLive(workspace) {
    return (await this.json(workspace, ['list', '--limit', '0'], { retries: SWEEP_RETRIES })) || [];
  }

  /**
   * The shape of a workspace — `{ parents, beads }` for the whole graph, cached.
   *
   * `bd export` and not `bd list`, and lib/ancestry.js is the whole argument: the list
   * rows carry no parent at all, `bd show` is one spawn per bead, and walking downwards
   * with `bd list --parent` is a spawn per node against a Dolt that answered a single
   * call in 6.4 seconds on an ordinary loaded afternoon here. The export is one spawn for
   * the entire graph and carries the edges typed, which is the only way to honour
   * bc-rfnr.2's "descendants only" — `blocks` and `discovered-from` ride in the same
   * array and would otherwise re-admit most of the backlog.
   *
   * **Cached across repaints, per workspace, for a minute**, and — the part that matters —
   * **never built on the request path.** Measured on this Mac on 2026-08-13, idle, one
   * `bd export` per configured workspace: 729ms, 874ms, 1256ms, 1846ms, 468ms, 461ms,
   * 621ms, 441ms, 624ms. **7.3 seconds for the nine.** That is a whole minute's worth of
   * work landing on whichever poll happens to find the cache cold, and bc-1kwl is a live
   * P0 whose budget is *page loads under 1s, deltas within 5s* — so awaiting this on
   * `/api/questions` would have broken another P0's acceptance to satisfy this one's.
   *
   * So `wait: false` returns whatever is on hand and starts the refresh behind it. The
   * cost is honest and small: for the first ~7 seconds after a restart the inbox has no
   * P0 section, and then it does. `owned: true` with an empty `roots` is a state the client
   * already treats as "do not narrow anything" (`underOwnedRoots`), so a warming daemon
   * shows the flat list rather than an empty one.
   *
   * Sixty seconds because the thing being cached moves only when somebody deliberately
   * reparents a bead, and a minute of staleness draws one card in the wrong section.
   *
   * **A failure is an empty map, not a throw.** Every caller's fallback for "I do not
   * know what is above this" has to be decided by the caller — the inbox shows everything
   * (bc-rfnr.2) and the dispatch gate withholds nothing (bc-rfnr.7) — and both of those
   * are reachable only if this returns. The error is logged where it happens, once per
   * expiry rather than once per repaint, because the cache is written either way.
   *
   * **And the empty one says it is empty *because* of a failure — `error` on the index,
   * which is bc-0i27.17.** Not returning is what makes every caller's fallback reachable;
   * it is also what makes "there is nothing above this bead" and "I could not find out"
   * arrive as the same answer, and lib/homing.js files a bead on the strength of it. A
   * bead filed under nothing on a tracker that has no P0s is workable; the same bead on a
   * tracker with twenty is held and off the inbox, and the difference is a `bd export`
   * that timed out — which is likeliest on exactly the loaded Dolt where the most beads
   * are being filed. So the stand-in carries the reason it is a stand-in. The last good
   * answer never does: a stale reading is still a reading, and its P0s are real.
   */
  graph(workspace, { refresh = false, wait = true } = {}) {
    const key = workspace?.name || workspace?.dir || '';
    const hit = PARENT_CACHE.get(key);
    if (!refresh && hit && Date.now() - hit.at < PARENT_TTL_MS) return Promise.resolve(hit.index);

    let job = PARENT_INFLIGHT.get(key);
    if (!job) {
      job = this.run(workspace, ['export'], { retries: SWEEP_RETRIES })
        .then(indexFrom)
        .catch((err) => {
          const why = String(err?.message || err).split('\n')[0];
          console.error(`[beadcause] could not read the shape of ${key} — ${why}`);
          // The last good answer beats an empty one: a workspace that failed a single
          // read has not lost its P0s, and blanking the board would hide them until the
          // next success. Empty only when there has never been a good answer — and that
          // empty one is built here rather than shared, so it can carry `error`. See the
          // note above: EMPTY_GRAPH is the module's "nothing yet", not "this failed".
          return hit?.index || { parents: new Map(), beads: new Map(), adopts: new Map(), edges: new Map(), error: why };
        })
        .then((index) => {
          PARENT_CACHE.set(key, { at: Date.now(), index });
          PARENT_INFLIGHT.delete(key);
          return index;
        });
      PARENT_INFLIGHT.set(key, job);
    }
    // `wait: false` — the request path. Take what is on hand and let the refresh land in
    // the background for the next repaint. See the measurement in the note above.
    return wait ? job : Promise.resolve(hit?.index || EMPTY_GRAPH);
  }

  /**
   * Has this workspace's shape ever been read? The question `wait: false` swallows.
   *
   * `graph(ws, { wait: false })` answers an empty shape for a workspace it has not
   * exported yet and for one that is genuinely empty, and those are the same object to
   * every caller — which is fine for the epic board, where the honest reading of both is
   * "no P0s here". It is not fine for a search box: "no bead matches `bc-0x`" and "I have
   * not read this tracker yet" are different sentences, and drawing the first over the
   * second is the box telling you a bead does not exist thirty seconds after you filed
   * it. So the search asks this and says which (see `/api/beads`).
   *
   * Deliberately *has an entry*, not *is fresh*: a minute-old graph is a graph, and the
   * refresh behind it is already running. This is about the cold start and nothing else.
   */
  graphReady(workspace) {
    return PARENT_CACHE.has(workspace?.name || workspace?.dir || '');
  }

  /** Just the parent map, for a caller that has no use for the rows. See `graph`. */
  async parents(workspace, opts) {
    return (await this.graph(workspace, opts)).parents;
  }

  /**
   * Every issue this workspace has ever had, closed and deferred ones included.
   *
   * `--all` rather than a status list, and the difference is not cosmetic: bd's default
   * filter hides closed issues, and `--all` is documented as overriding *the default
   * filter* rather than as a synonym for naming all five states. A future state nobody
   * here has heard of is in this answer and would not be in a hand-written list — which
   * matters for the one caller, the ledger (lib/history.js), whose whole premise is that
   * it shows you everything.
   *
   * What it still excludes is what bd hides from every list: gates, infrastructure beads
   * (agent/role/message) and template molecules. Those are machinery rather than work,
   * and the flags that reveal them are deliberately not passed — the ledger is a record
   * of what was *done*, not of what the tracker keeps about itself.
   *
   * Nothing is filtered here — not status, not priority, not label — even though bd
   * would happily do all three. The reason is the cache on the other side: see the
   * header of lib/history.js. This is a read, so it never queues behind Dolt's single
   * writer, and it is the most expensive `bd` call in the app (~1s and ~1.5MB of JSON
   * on the largest workspace here), which is why exactly one thing calls it and that
   * thing caches the answer.
   *
   * **This is the call the timeout was measured on**, and it no longer carries one of its
   * own: 503 beads answer in about a second idle and took 28.6 seconds here under a load
   * average of 33, which is the whole argument for `BD_TIMEOUT` above. It had a private
   * 120s ceiling first (bc-nib3.1); that is now the default every call gets, and a
   * per-call number here would only be a second copy of the same decision, free to drift
   * from it. What a timeout costs *this* caller is worth naming anyway: it throws,
   * `ledger` turns the workspace into a row in `errors`, and the History tab draws an
   * empty ledger for a repo with five hundred beads in it.
   */
  async listAll(workspace) {
    return (await this.json(workspace, ['list', '--all', '--limit', '0'], { retries: SWEEP_RETRIES })) || [];
  }

  /**
   * This workspace's Dolt remote as `{name, url}`, or `null` if it has none.
   *
   * The one question lib/sync.js asks before it does anything, and the reason syncing
   * needs no list in the config: a workspace answers for itself whether it is shared.
   * `--json` is real here — `bd dolt remote list --json` prints `[]` on a solo
   * workspace and `[{name, url, sql_url}]` on a shared one, measured against bd 1.1.2 —
   * which matters because the human-readable form is the sentence "No remotes
   * configured." and parsing prose for a *default off* is how a workspace ends up
   * silently not syncing.
   *
   * The **url** is carried and not just the name, because every screen that says
   * anything about this wants to say where: "in sync with origin" is a sentence that
   * cannot be checked, and on a shared tracker the one thing worth being sure of is
   * which repo your beads are going to.
   *
   * A read, so no lock retry, and `null` for a malformed answer rather than a throw:
   * the caller's next move on `null` is to do nothing, which is the safe direction. A
   * remote that cannot be *listed* is a workspace we should leave alone, not one we
   * should start pushing at.
   */
  async doltRemote(workspace) {
    const rows = await this.json(workspace, ['dolt', 'remote', 'list']);
    if (!Array.isArray(rows) || !rows.length) return null;
    const first = rows[0];
    if (typeof first === 'string') return { name: first, url: null };
    const name = first?.name || first?.remote || null;
    const url = first?.url || first?.sql_url || null;
    return name || url ? { name: name || 'origin', url } : null;
  }

  /**
   * Bring the remote's beads in, and send this machine's out. See lib/sync.js.
   *
   * `retries: 0` on both, and that is a departure from every other write here worth
   * saying out loud. Writes retry four times through Dolt's single-writer lock because
   * a lock collision is an ordinary Tuesday on a laptop running twenty agent sessions;
   * these two do not, because they are the only `bd` calls in the app that go to the
   * *network*, and a retry of a two-minute network timeout is four minutes of a poll
   * cycle spent on a workspace that will be tried again in two minutes anyway. The
   * interval is the retry.
   *
   * They keep `BD_TIMEOUT` rather than taking a shorter ceiling of their own. A push is
   * a git push under the hood: killing one mid-flight loses the push and nothing else —
   * the remote either took the whole thing or none of it — so the cost of waiting is
   * only ever a slow tick, while the cost of a ceiling set too low is a large first
   * sync that can never complete and reports as broken every time.
   */
  doltPull(workspace) {
    return this.run(workspace, ['dolt', 'pull'], { retries: 0 });
  }

  doltPush(workspace) {
    return this.run(workspace, ['dolt', 'push'], { retries: 0 });
  }

  /**
   * The interactive dependency graph as a standalone HTML page: `bd graph --html`
   * for one issue, or every open issue in the workspace when `id` is null.
   *
   * Read-only, so no lock retry — a read never loses to Dolt's single writer. It used to
   * ask for 60s, which was generous against a 30s default and is a *cut* against
   * `BD_TIMEOUT`: `--all` walks the whole graph, which is more work than any list call
   * here makes, so the last thing it should carry is the shortest ceiling in the file.
   */
  graphHtml(workspace, id) {
    const args = id ? ['graph', '--html', id] : ['graph', '--all', '--html'];
    return this.run(workspace, args);
  }

  /** Answer without closing — for questions you want to keep open. */
  async comment(workspace, id, text, { actor = null } = {}) {
    await this.run(workspace, ['comment', id, text], { retries: 4, actor });
    await this.relateMentions(workspace, id, text);
  }

  /**
   * Every bead this one already has an edge to, in **both** directions and of any type.
   *
   * Two spawns rather than one because bd has no `--direction=both`, and one direction
   * is not enough for the question this answers. `bd show --json` carries only the
   * outgoing half: bc-arj0, an epic with eight children, comes back with an empty
   * `dependencies[]` and `dependent_count: 8`, because a `parent-child` edge is stored
   * on the child. So an epic writing a comment that names its own children would, on a
   * one-direction read, look unlinked to every one of them.
   *
   * That is not a cosmetic miss. `bd dep relate` **refuses** a pair that already carries
   * an edge of another type — *"already exists with type parent-child"* — and it refuses
   * it having already written the first of its two rows, so a relate over a parent-child
   * edge leaves a one-ended see-also behind *and* reports failure. Reading both
   * directions first is what keeps that from happening at all.
   */
  async linkedTo(workspace, id) {
    const [down, up] = await Promise.all([
      this.json(workspace, ['dep', 'list', String(id)]).catch(() => []),
      this.json(workspace, ['dep', 'list', String(id), '--direction', 'up']).catch(() => []),
    ]);
    const out = new Set();
    for (const row of [...(down || []), ...(up || [])]) {
      const neighbour = String(row?.id || '').toLowerCase();
      if (neighbour) out.add(neighbour);
    }
    return out;
  }

  /**
   * Draw a `relates-to` edge for every bead this prose names — the write-time half of
   * bc-arj0.4.
   *
   * The tracker held 1,350 bead references in prose and one `related` edge, so "the same
   * defect as bc-767a" and "see also bc-rcrt" were reachable only by reading the
   * paragraph they were written in. This is what stops that gap reopening: a mention
   * written through this class becomes an edge in the same breath, and lib/mentions.js
   * holds the judgement about which mentions earn one.
   *
   * **It costs nothing when there is nothing to do, and that is the design.** The regex
   * runs first, in process: prose naming no bead — most comments — spawns nothing at all.
   * Prose that does name one costs two reads, and a *write* only for a pair with no edge
   * yet, which after the first sweep is nearly never. Reads do not take Dolt's single
   * writer, so the steady state of a comment repeating the same three ids is two reads
   * and no lock at all.
   *
   * **Nothing here may fail the write it hangs off.** The comment is what the caller was
   * asked to do; an edge is a courtesy on top of it, and a tracker that refused to record
   * an answer because a see-also would not draw would be far worse than one with a
   * missing edge. So every failure is swallowed, and what is returned is the ids actually
   * drawn — which is also how the tests see what happened.
   *
   * One `bd dep relate` per pair rather than one bulk `--file` for all of them, unlike
   * the sweep: bulk wiring validates the whole batch and rejects **every** line if one id
   * has since been deleted, and here the batch is two or three pairs, where a per-pair
   * failure costs only that pair. `WRITE_CAP` rather than the sweep's — `respond` is what
   * a tap on a phone runs, awaited on the request path, and see that constant for the
   * arithmetic.
   */
  async relateMentions(workspace, id, text) {
    try {
      const self = String(id || '').toLowerCase();
      const prefix = prefixOf(self);
      if (!prefix) return [];
      if (!mentionsIn(text, prefix).some((m) => m !== self)) return [];
      const linked = await this.linkedTo(workspace, self);
      const made = [];
      for (const to of planFor({ id: self, prose: text, linked, cap: WRITE_CAP })) {
        try {
          await this.run(workspace, ['dep', 'relate', self, to], { retries: 3 });
          made.push(to);
        } catch {
          // A bead named in prose that has since been deleted, or an edge somebody else
          // drew between the read above and this write. Neither is worth a line in
          // `errors[]`, and neither says anything about the write that got us here.
        }
      }
      return made;
    } catch {
      return [];
    }
  }

  /**
   * Add to what a bead says about itself, without reading it first.
   *
   * `--append-notes` rather than `--notes`, and the difference is the whole reason this
   * exists: `--notes` replaces the field, so a caller adding a paragraph would have to
   * read the bead, concatenate, and write back — three steps with a lost write in the
   * middle of them. bd does the append itself, with a newline separator.
   *
   * Notes rather than the description because a description is what the bead *is*, and
   * everything appended here is something that happened to it afterwards. The card reads
   * both (lib/decision.js), so a `decision` block works from either.
   */
  async appendNotes(workspace, id, text) {
    await this.run(workspace, ['update', id, '--append-notes', text], { retries: 4 });
    await this.relateMentions(workspace, id, text);
  }

  // `bd label add <issue-id...> <label>` — id first, label last.
  addLabel(workspace, id, label) {
    return this.run(workspace, ['label', 'add', id, label], { retries: 3 });
  }

  removeLabel(workspace, id, label) {
    return this.run(workspace, ['label', 'remove', id, label], { retries: 3 });
  }

  /**
   * Who owns this bead — bc-okja, and it is deliberately not a field on `update` above.
   *
   * `update` is the field-setting method and every one of its fields is *content*: a
   * title, a description, a label. An assignee is not content, it is the thing the merge
   * queue and every advocate **select on** (`queueFor` in lib/mergeadvocate.js takes only
   * beads assigned to `merge-advocate`), so a caller writing one is moving a bead between
   * queues rather than editing it. Its own method, so that shows up at the call site.
   *
   * An empty string unassigns, which is what bd itself does with `--assignee=`.
   */
  assign(workspace, id, who) {
    return this.run(workspace, ['update', id, `--assignee=${String(who ?? '')}`], { retries: 3 });
  }
}

/**
 * bd prints clean JSON with --json, but a stray warning line on stdout would
 * break JSON.parse, so pull out the first balanced array/object.
 */
export function parseJson(out) {
  const text = (out || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to slicing */
  }
  const starts = [text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (end <= start) return null;
  return JSON.parse(text.slice(start, end + 1));
}
