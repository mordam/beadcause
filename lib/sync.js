/**
 * Keeping a tracker that two Macs share actually shared.
 *
 * Everything else in beadcause treats "the tracker" as one thing. It is one thing on
 * one machine: `~/beads/<name>/.beads` is an embedded Dolt database on this laptop's
 * disk, and a bead created here is visible here. Dolt can be pushed to a remote and
 * pulled from one — `bd dolt push` / `bd dolt pull` — and until this file **nothing in
 * beadcause had ever called either**. Five comments in lib/bd.js and lib/config.js talk
 * about embedded versus `bd dolt start` mode; not one line syncs anything. Syncing was
 * a thing a person types, which means on the days nobody typed it two engineers running
 * beadcause had two private issue graphs that never met.
 *
 * That is bead 0 of the federation epic (bc-hlu2), and it is bead 0 because everything
 * downstream of it — a second engineer installing against the team's tracker, a question
 * addressed to one person rather than broadcast, two advocates not opening a session on
 * the same bead — is arithmetic over a graph both machines can see. None of it means
 * anything while the graph is private.
 *
 * ## Which workspaces sync: the ones that have a remote, and nothing else
 *
 * Deliberately **not** a list in the config, and this is the one design decision here
 * worth arguing. The obvious shape is `sync.workspaces: ["climative"]` — say which are
 * shared, sync those. The trouble with it is that it is a second place to be right: a
 * workspace can have a Dolt remote and be absent from the list (so it silently does not
 * sync, which is the failure this file exists to prevent), or be in the list with no
 * remote (so every tick reports a failure about a workspace that is working exactly as
 * intended).
 *
 * `bd dolt remote list --json` already answers the question, from the workspace itself,
 * and it cannot disagree with itself. So: **a workspace with a remote is a workspace
 * that syncs, and a workspace without one is silent.** A solo install — every workspace
 * on this Mac today — configures nothing, is told nothing, and pays one cheap `bd` call
 * per workspace per interval to establish that there is nothing to do. The day somebody
 * runs `bd dolt remote add origin …`, sync starts on the next tick with nothing else
 * typed. That is the acceptance criterion for bc-hlu2 read literally: visible on the
 * other machine *without anybody typing a sync command*.
 *
 * Note what this deliberately does not do: it never *adds* a remote. Where a graph is
 * published is a decision with consequences no daemon should make on somebody's behalf
 * — the beadcause repo itself is public, and a remote pointed there would put every
 * bead, comment and answer on the open internet — so beadcause syncs a remote that
 * exists and never invents one. See the README section for the fuller argument.
 *
 * ## Pull, then push, and never the other way round
 *
 * A push against a remote that has moved is refused, so pushing first turns an ordinary
 * two-machine afternoon into an error every single tick. Pulling first is what merges
 * the other machine's beads into this one's history so there is something pushable —
 * and it is also the half that matters most, because a machine that pulls and never
 * pushes is merely behind, while a machine that pushes and never pulls is the one
 * writing over other people's work.
 *
 * ## Three ways it goes wrong, and only two of them are the same
 *
 * - **It failed.** Network down, `gh`/ssh not authorised, the tracker locked by one of
 *   the twenty agent sessions this laptop runs. Transient by nature, retried on the
 *   next interval, and the honest thing to say is "these two machines are drifting
 *   apart and here is what bd said".
 * - **It conflicted.** Two machines wrote the same bead and Dolt cannot merge them. This
 *   never resolves itself and it never will: the next tick hits the same conflict, and
 *   every tick after that. It is called out separately for exactly that reason — the
 *   remedy is a person at a keyboard, and a screen that files it under the same word as
 *   "the wifi dropped" is a screen that teaches you to ignore it.
 * - **It has no remote.** Not a failure at all, and reported as nothing.
 *
 * ## Quiet when it works, loud once when it does not
 *
 * A sync that worked says nothing. A tick that reports "synced 4 workspaces" every two
 * minutes is 720 lines a day that nobody reads, and the 721st — the one that says it
 * failed — is the one that scrolls past. So the *transitions* are what talk: the first
 * failure emits an event and pushes to the phone, and so does the recovery. Between
 * those two the record stands, on the inbox banner and in `trouble()`, for as long as
 * it is true. This is `pushCertificate`'s argument in lib/notify.js, applied one layer
 * down.
 *
 * ## Persisted after all, since bc-y3qk.7
 *
 * This used to argue the opposite — "a failure that did not survive the restart is not
 * a failure any more", the same case lib/sweep.js makes for itself — and the argument
 * was wrong for what this daemon actually does. Measured on 2026-08-17:
 * ~/Library/Logs/beadcause.log carried 505 restarts against 97 sync ticks, 85 of them
 * the first tick after a restart. On that tick `before` was always null, so an outage
 * already running read as a fresh `broke` — the 73-failure outage bc-y3qk.5 was filed
 * for did not announce itself once, days ago, as its own text assumed; it plausibly
 * announced itself ~73 times, once per restart. "Transitions only" only damps a *single
 * long-running process*, and a daemon that restarts on every deploy is not one.
 *
 * So `createSyncer` now takes an optional `initial` (seeds `last` from a caller-supplied
 * snapshot) and `save` (called with that snapshot after every `record()`). Both default
 * to nothing, which is exactly the old behaviour and what every test in test/sync.mjs
 * still exercises — this file still does not know where the snapshot lives or how it
 * gets there. lib/server.js is the wiring: `state.json`'s `sync` key, through
 * lib/config.js's `loadState`/`saveState`, which already commits every change to the
 * config directory's own git history (lib/commonrepo.js) and no-ops when nothing moved.
 * A daemon that has never wired the two in — a test, an old caller — keeps the
 * in-memory-only behaviour byte for byte.
 *
 * This does not fight the header's actual point, which survives untouched: a sync that
 * worked stays quiet, and only a transition talks. What was wrong was treating "this
 * process's memory" and "whether the outage is still happening" as the same fact — they
 * agree on a laptop that never restarts and disagree 85 times out of 97 on this one.
 */

// The one thing this file needs from lib/bd.js rather than from a `bd`: the ceiling a
// call gets when nobody says otherwise, which is the number `syncCeilingMs` below has to
// stay under. Taking it rather than restating it is the whole point — the bug this fixes
// was two files each picking two minutes for reasons of their own.
import { BD_TIMEOUT } from './bd.js';

/** The one line of an error worth putting on a phone. Same bar as lib/sweep.js. */
const oneLine = (err) => {
  const text = err && err.message ? String(err.message) : String(err ?? 'unknown error');
  const first =
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0] || '';
  // `bd … failed in <ws>: <what bd said>` — lib/bd.js's prefix, which repeats a
  // workspace name the row already carries and is half a phone's line width gone
  // before the reason starts. Trimmed here exactly as lib/sweep.js trims it.
  const colon = first.indexOf(': ');
  const trimmed = colon > 0 && /(failed|timed out) in /.test(first.slice(0, colon)) ? first.slice(colon + 2) : first;
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed || 'unknown error';
};

/**
 * Did Dolt refuse this because the two histories disagree?
 *
 * Text-matched, because that is the only thing `bd dolt pull` gives us — it exits
 * non-zero for a conflict and for a dead network alike, so the exit code cannot tell
 * them apart. Matched loosely on purpose: a false positive here calls a network blip a
 * conflict, which over-reports a problem that is already being reported; a false
 * negative files a divergence that will never clear under the word "retrying", which
 * is the one outcome this distinction exists to prevent.
 */
const CONFLICT_RE = /\bconflict|cannot be merged|merge is not fast.?forward|unresolved/i;

export const isConflict = (text) => CONFLICT_RE.test(String(text || ''));

/**
 * Did Dolt refuse this because the working set is dirty?
 *
 * ## What this actually is, measured rather than guessed (bc-y3qk.5)
 *
 * On 2026-08-17 the `architecture` workspace had not pulled in 73 logged ticks, every
 * one of them this string, and it is worth writing down what it turned out to be —
 * because every tool a person would reach for to diagnose it says there is nothing
 * wrong, and that is the whole reason it sat there for a week.
 *
 *     $ dolt status
 *     On branch main
 *     nothing to commit, working tree clean
 *
 *     $ dolt merge origin/main
 *     error: local changes would be stomped by merge:
 *             events
 *      Please commit your changes before you merge.
 *
 * `dolt status`, `dolt diff`, `dolt diff --stat`, the `dolt_status` system table and
 * `dolt_diff_summary('HEAD','WORKING')` **all reported nothing**, forty samples over a
 * minute never caught the working set dirty, and the merge still refused. The thing
 * that finally showed it was the root hashes:
 *
 *     WORKING  ehbvrnq671jopb3dj8h327q30hfl1jpu
 *     STAGED   eun4l4s6g958q52uv4660p1e42233cp2
 *     HEAD     eun4l4s6g958q52uv4660p1e42233cp2
 *
 * The working root genuinely differs from HEAD, and the difference is **physical rather
 * than logical** — the same rows, stored differently. Merge's guard compares roots, so
 * it fires; every diff a person can run compares *content*, so they all say clean. The
 * error is telling you to commit changes that do not exist, which is why "please commit
 * your changes" had been read as noise by every session that looked at it.
 *
 * Three things follow, and each of them is a design decision below rather than a note:
 *
 * - **It is not a race.** The two candidates on the bead were a collision with the
 *   twenty agent sessions writing this graph, and a daemon looking at a different
 *   working set from the CLI. Neither: a plain `dolt merge` typed by hand fails exactly
 *   as `bd dolt pull` does, deterministically, against a verifiably clean tree.
 * - **It is not transient, and no interval will fix it.** The state on the next tick is
 *   the state on this one. That is what `stuck` below exists to say, and why saying
 *   "it retries on every interval" about it is a lie the screen tells for a week.
 * - **The merge had nothing to do.** `main..origin/main` was **zero commits** — the
 *   guard fires before Dolt notices the merge is a no-op. So this failure can strand a
 *   workspace that is not even behind, which is exactly what happened: pull-then-push
 *   returns on the first failure, so **208 local commits never reached the team** while
 *   a no-op pull failed in front of them.
 *
 * The recovery that works is to make the working root match HEAD again. `bd dolt
 * commit` is the half a daemon may do unattended and is tried below; the other half —
 * `dolt checkout <the table the error names>`, which is what actually cleared it here —
 * **discards** working-set changes, so it stays a sentence in a notification for a
 * person to type, and never something this file does on its own.
 *
 * Matched on the remedy Dolt names as well as the refusal itself, because the wording
 * of the first half has moved between Dolt versions and the second half has not.
 */
const STUCK_RE = /stomped by merge|please commit your changes/i;

export const isStuck = (text) => STUCK_RE.test(String(text || ''));

/**
 * How many identical failures in a row before a sync stops calling itself transient.
 *
 * The general case, for every error that is *not* one of the shapes above: a dropped
 * network really is transient and really does clear, so the first few say so. But an
 * error that has been byte-identical five times running is no longer a blip — whatever
 * it is, the interval is not fixing it, and a screen that has said "retrying" ten times
 * has stopped carrying information.
 *
 * Five rather than two, because the interval is two minutes and a laptop shutting its
 * lid or an ssh agent locking for a few minutes is ordinary; ten minutes of the same
 * sentence is not.
 *
 * **Counted in memory inside `createSyncer`, and survives a restart when the caller
 * wires `initial`/`save` — see the header.** Before bc-y3qk.7 this streak almost never
 * reached five: this daemon restarted 505 times across the log it was measured on, and
 * 85 of the 97 sync lines in it follow a restart, so `before` was null on nearly every
 * tick and the count kept starting over at one. `isStuck` above still classifies on the
 * *shape* of the error rather than on how many times it has happened, and that is worth
 * keeping even now: a shape recognisable on the first tick needs no streak and no
 * persisted state at all, which is the cheaper and more robust of the two mechanisms
 * wherever it applies. `STUCK_AFTER` is what is left for everything `isStuck` cannot
 * name in advance.
 */
export const STUCK_AFTER = 5;

/**
 * How often a sync runs, in ms, with a floor.
 *
 * **The interval is not a performance knob.** It is the width of the window in which
 * two machines can act on stale information — the same window bc-bllw's duplicate
 * advocate sessions live in — so the argument for the default is about collisions and
 * not about load.
 *
 * Two minutes. The poll is thirty seconds and the release sweep is five minutes, and
 * this sits between them for a reason: it is the only sweep here that touches both the
 * network *and* Dolt's single writer, so it is genuinely more expensive than the
 * thirty-second reads — while a five-minute window is long enough for two advocates on
 * two Macs to both pick up the same ready bead and both open a session on it, which is
 * a wasted hour rather than a slow screen.
 *
 * The floor is thirty seconds rather than the five `pollSeconds` gets, because there is
 * no such thing as a usefully faster sync: a `git push` per workspace every few seconds
 * would spend more of the day holding the Dolt write lock than the agent sessions do,
 * and the collision window it closes is already smaller than the time it takes a person
 * to read a bead.
 */
export const SYNC_FLOOR_SECONDS = 30;

export const syncEveryMs = (cfg) => Math.max(SYNC_FLOOR_SECONDS, Number(cfg?.sync?.seconds) || 120) * 1000;

/**
 * How much of one interval a single `bd dolt` call may spend before it is killed.
 *
 * ## Why this number exists at all (bc-y3qk.2)
 *
 * `BD_TIMEOUT` is two minutes and the default `sync.seconds` is two minutes, and those
 * two numbers being equal is not a coincidence anybody arranged — they are defaults
 * picked in different files for unrelated reasons. What it produced is this: a tick that
 * burns its ceiling is **still running when the next tick is due**, so `sweep` skips
 * that workspace and logs *"still syncing from the last tick — skipped"*, and one lock
 * collision costs two intervals rather than one. Worse than it sounds, because pull and
 * push run in sequence: two full ceilings is four minutes, which is two skipped ticks
 * on a two-minute interval.
 *
 * "The interval is the retry" is the argument every one of these calls is built on. It
 * is only true while a call *finishes inside the interval*, and that is what this makes
 * true rather than assumed.
 *
 * ## Why a share of the interval and not a constant
 *
 * A constant would be the same bug written down again: `sync.seconds` is a setting, so
 * any fixed ceiling is wrong for somebody's interval. Two calls run in sequence, so each
 * gets at most `SYNC_CEILING_SHARE` of the interval and the pair fits inside it with
 * room to spare — 48s each on the default 120, leaving 24s of margin for the `bd`
 * spawns, the lock backoffs and the tick's own arithmetic.
 *
 * Capped at `BD_TIMEOUT`, because a very long interval is a statement about how stale
 * two Macs may get and not permission to let one `bd` run for an hour.
 */
export const SYNC_CEILING_SHARE = 0.4;

export const syncCeilingMs = (cfg) => Math.min(BD_TIMEOUT, Math.floor(syncEveryMs(cfg) * SYNC_CEILING_SHARE));

/** Is syncing on at all? Off is a real answer and it is the one a solo install wants. */
export const syncEnabled = (cfg) => cfg?.sync?.enabled !== false;

/**
 * Sync one workspace, once. Never throws.
 *
 * The outcome is a word rather than a boolean because there are four of them and three
 * of the four are not failures:
 *
 *   `no-remote` — nothing to do, say nothing
 *   `ok`        — pulled and pushed
 *   `failed`    — it did not work, and it may next time
 *   `conflict`  — it did not work, and it will not next time
 *
 * `pushed: false` on an `ok` is the ordinary read-only case: a pull that succeeded and
 * a push that had nothing to send is still a workspace in agreement with the remote.
 *
 * There is a fifth word since bc-y3qk.5, and it is the one this outcome set was missing:
 *
 *   `stuck`     — it did not work, and it will not next time either
 *
 * `failed` and `stuck` are both "it did not work", and separating them is the same
 * argument that separated `conflict` out in the first place: a screen that files "the
 * wifi dropped" and "this will still be here on Friday" under one word is a screen that
 * teaches you to ignore both. `conflict` stays its own word rather than absorbing this
 * one — a conflict is two people's work disagreeing and needs a decision about whose
 * wins, while a stuck sync is one machine unable to move and needs a command typed.
 *
 * `timeout` is the ceiling each `bd dolt` call runs under, and `null` — the default —
 * means bd's own `BD_TIMEOUT`. It is a parameter rather than something computed here
 * because this function sees one workspace and one tick, while the number is about the
 * *interval*, which only the caller knows. See `syncCeilingMs` and `sweep`.
 */
export async function syncOnce(bd, workspace, { recover = true, timeout = null } = {}) {
  // Passed on as an options object so a `bd` that has never heard of a ceiling — every
  // fake in test/sync.mjs — takes an ignored second argument rather than a broken call.
  const under = timeout ? { timeout } : {};
  // The directory a *person* would type this in, carried on the outcome so nothing
  // downstream has to guess it. `~/beads/<name>` was the obvious guess and it is already
  // wrong: a workspace can live anywhere — Climative's moved inside the `architecture`
  // checkout, because that is the repo the team clones — and a notification whose
  // suggested command is a path that does not exist is worse than one with no command
  // in it, since the first thing it teaches you is that the message is not to be trusted.
  const at = workspace?.dir ? workspace.dir.replace(/\/\.beads\/?$/, '') : null;
  let remote = null;
  try {
    remote = await bd.doltRemote(workspace);
  } catch (err) {
    return { workspace: workspace.name, dir: at, state: 'failed', at: nowIso(), error: oneLine(err), remote: null, phase: 'remote' };
  }
  if (!remote) return { workspace: workspace.name, dir: at, state: 'no-remote', at: nowIso(), remote: null };

  const classify = (text) => (isConflict(text) ? 'conflict' : isStuck(text) ? 'stuck' : 'failed');
  const fail = (phase, err, extra = {}) => {
    const error = oneLine(err);
    return {
      workspace: workspace.name,
      dir: at,
      state: classify(err?.message || error),
      at: nowIso(),
      error,
      remote,
      phase,
      ...extra,
    };
  };

  // Pull first — see the header. A push against a moved remote is refused, so the other
  // order reports a failure every tick on a tracker that is working perfectly.
  let stuckPull = null;
  try {
    await bd.doltPull(workspace, under);
  } catch (err) {
    let out = fail('pull', err);

    // The one recovery a daemon may attempt on its own, and only for the shape that
    // names it: Dolt refused the merge because the working set is dirty and told us to
    // commit it. Committing keeps the changes, which is what makes this safe to do
    // unattended on a tracker twenty agent sessions are writing — the other way out
    // (discarding them) is a person's decision and stays in the notification.
    //
    // Once, and only on the tick it is discovered. If the commit does not clear it —
    // and in the case this was measured against it will not, because the divergence is
    // physical and there is nothing to commit — the outcome carries `recovery` so the
    // screen can say what was already tried rather than suggesting it again.
    if (out.state === 'stuck' && recover && typeof bd?.doltCommit === 'function') {
      try {
        await bd.doltCommit(workspace, under);
        await bd.doltPull(workspace, under);
        out = null;
      } catch {
        // Whatever the recovery itself said — usually "nothing to commit", which is the
        // measured case — the thing worth reporting is still the refusal that started
        // this. Classifying on the *recovery's* error instead would file a stuck sync
        // as an ordinary failure and put the "it retries" sentence back on the screen.
        out = { ...out, recovery: 'commit-failed' };
      }
    }

    if (out) {
      // **A stuck pull must not strand the push.** A `failed` pull is usually the
      // network, so pushing behind it is a second two-minute timeout for nothing and we
      // stop here as we always have. A `stuck` pull is the opposite: the remote was
      // reachable and it was the local merge that refused, so the push is both viable
      // and the half that matters — it is what gets this Mac's beads out. Skipping it
      // is how 208 commits sat unshared behind a no-op pull for a week (bc-y3qk.5).
      if (out.state !== 'stuck') return out;
      stuckPull = out;
    }
  }

  try {
    await bd.doltPush(workspace, under);
  } catch (err) {
    // A push failure on top of a stuck pull is not news of its own — the pull is the
    // thing that needs a person, and reporting the push's error instead would hide it.
    return stuckPull || fail('push', err);
  }

  // Pushed, but still not pulling: this Mac's beads are out and everybody else's are
  // not arriving. Better than stranded in both directions, and not `ok`.
  if (stuckPull) return { ...stuckPull, pushed: true };
  return { workspace: workspace.name, dir: at, state: 'ok', at: nowIso(), remote };
}

const nowIso = () => new Date().toISOString();

/**
 * What each workspace's last sync did, and what changed since the one before it.
 *
 * The record is the whole point: a screen can only say "these machines are diverging"
 * if something remembers that the last three attempts failed, and a notification can
 * only be sent *once* if something remembers that it already was.
 *
 * Shaped to be driven by a test without a daemon or a real `bd`: `sweep` takes the
 * workspaces and does the calls, `record` takes an outcome that already happened. The
 * failure path is the one that matters and the one that is hardest to produce for real
 * — you cannot easily make two Macs disagree from inside a test — so it is the half
 * that is deliberately reachable with a fake.
 *
 * `initial` and `save` are how a restart stops forgetting — see the header. Neither is
 * required: omit both and this is exactly the in-memory-only syncer it always was,
 * which is what every existing test below still constructs. `initial` is a plain object
 * (workspace name → the last outcome `record` produced for it, i.e. what a prior `save`
 * call was handed) used to seed `last` before the first sweep. `save`, when given, is
 * called synchronously after every `record()` with the *whole* map as a plain object —
 * not a diff — because the caller's own writer (lib/config.js's `saveState`) is already
 * a read-modify-write over one key, and handing it anything less would let an untouched
 * workspace's last-known state quietly vanish from the file. A `save` that throws is
 * swallowed: losing this write degrades to the pre-bc-y3qk.7 behaviour on the next
 * restart, never to a crashed poll cycle.
 */
export function createSyncer({ bd = null, initial = null, save = null } = {}) {
  /** workspace name → the last outcome we recorded for it. Seeded from `initial`. */
  const last = new Map(initial && typeof initial === 'object' ? Object.entries(initial) : []);
  /** Guards against two syncs of the same workspace overlapping — see `sweep`. */
  const inflight = new Set();
  /**
   * Every workspace that has synced cleanly at least once since this daemon came up.
   *
   * It exists for one decision and it is `sweep`'s: whether this workspace's `bd dolt`
   * calls get the short ceiling or bd's full two minutes. A workspace that has pulled
   * and pushed once is in steady state — its pushes from then on are a handful of Dolt
   * commits — so a ceiling that fits inside the interval is right for it, and a tick it
   * cannot finish inside is a tick something is wrong in. A workspace that has *never*
   * synced may be doing the large first one, where a ceiling set too low is not a slow
   * tick but a sync that can never complete and reports as broken every time.
   *
   * Not the same question as "did the last tick work", which is what `last` holds: a
   * workspace that synced this morning and is failing now is still established, and
   * shortening its ceiling back to two minutes because of today's outage would put the
   * skipped ticks straight back.
   *
   * In memory and not persisted, like everything else here — so a restart costs one
   * generous tick per shared workspace and then it is short again, which is the safe
   * direction to be wrong in.
   */
  const established = new Set();

  /**
   * Fold one outcome in, and say what changed.
   *
   * `transition` is `null` on the ordinary tick — failed again, or worked again having
   * worked before — and that null is what keeps the monitor's event log and the phone's
   * notification tray usable. Only `broke` and `recovered` are worth a noise, and
   * `changed` says whether the *reason* moved (a network failure becoming a conflict),
   * because that is a different sentence on the same screen.
   */
  function record(raw) {
    const before = last.get(raw.workspace) || null;

    // How many ticks in a row this exact complaint has been made. "Exact" is the state
    // and the error text together: a workspace whose failure *reason* moved has not
    // been failing the same way, and restarting the count is what stops a wandering
    // series of unrelated blips from adding up to an escalation nobody can act on.
    const same = Boolean(before && before.state === raw.state && (before.error || '') === (raw.error || ''));
    const streak = same ? (before.streak || 1) + 1 : 1;

    // The general rule, for every error that is not one of the shapes `isStuck` already
    // knows: five identical failures is no longer a blip. Promoting here rather than in
    // `syncOnce` is deliberate — `syncOnce` sees one tick and cannot know it is the
    // fifth, and this is the only thing in the file that holds any history at all.
    const state = raw.state === 'failed' && streak >= STUCK_AFTER ? 'stuck' : raw.state;
    const out = { ...raw, state, streak };
    last.set(out.workspace, out);
    if (save) {
      try {
        save(Object.fromEntries(last));
      } catch {
        // Best-effort, and silently so — see the constructor doc. A `save` that cannot
        // write is not this sweep's failure to report; it is next restart's problem,
        // and it is the same problem this file had on every restart before bc-y3qk.7.
      }
    }

    const bad = (s) => s === 'failed' || s === 'conflict' || s === 'stuck';
    const wasBad = Boolean(before && bad(before.state));
    const isBad = bad(out.state);
    const transition = isBad && !wasBad ? 'broke' : !isBad && wasBad ? 'recovered' : null;

    // What is worth a second noise on a workspace that was already broken: the state
    // *word* changed. That covers a failure becoming a conflict, and it covers a
    // failure becoming stuck — both of which mean the first notification's promise that
    // it would retry has stopped being true, which is the one thing worth interrupting
    // somebody twice for. Once, because the word only changes once.
    const changed = Boolean(transition) || (isBad && wasBad && before.state !== out.state);
    return { ...out, transition, changed, before: before ? before.state : null };
  }

  return {
    record,

    /** The last outcome per workspace, for anything that wants the whole picture. */
    all: () => [...last.values()].sort((a, b) => a.workspace.localeCompare(b.workspace)),

    /** One workspace's last outcome, or null if it has never been swept. */
    get: (name) => last.get(name) || null,

    /**
     * Every workspace whose tracker is not in agreement with its remote, in the shape
     * lib/sweep.js's `trouble()` uses — so a payload carrying both puts them side by
     * side without a second shape to learn.
     *
     * `channel: 'sync'` rather than one of the three read channels, and in its own
     * field on the payload rather than merged into `trouble`. That is deliberate:
     * `mergeTrouble` keeps one row per workspace and the most recent wins, so a locked
     * Dolt read arriving a second after a divergence would *hide* the divergence — and
     * the two say completely different things. "This repo could not be read" is a
     * screen that is out of date. "This repo is not in sync" is a screen that is out of
     * date **on the other machine too, and neither of you can tell**.
     */
    trouble() {
      return [...last.values()]
        .filter((o) => o.state === 'failed' || o.state === 'conflict' || o.state === 'stuck')
        .map((o) => ({
          workspace: o.workspace,
          dir: o.dir || null,
          channel: 'sync',
          state: o.state,
          conflict: o.state === 'conflict',
          // Both of these mean "no interval is going to fix this", which is the one bit
          // a screen needs to pick its sentence, and neither of them means the other.
          stuck: o.state === 'stuck',
          streak: o.streak || 1,
          recovery: o.recovery || null,
          pushed: Boolean(o.pushed),
          error: o.error || 'the sync failed',
          phase: o.phase || null,
          remote: o.remote || null,
          at: o.at,
        }))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },

    /**
     * Sync every workspace, in parallel, and hand back what changed.
     *
     * Parallel because they are separate databases and separate remotes: nothing is
     * shared between two workspaces' syncs, and doing them in turn would make the
     * cycle's cost the *sum* of the slowest case rather than the slowest single one.
     * A `bd` that goes to the network gets two minutes before it is killed
     * (`BD_TIMEOUT`), and four workspaces in turn is eight minutes of a poll cycle.
     *
     * `inflight` is the guard that makes that safe. `setInterval` does not wait for an
     * async callback to finish, so a sync that outlives its interval would otherwise
     * have a second one started on top of it — two `bd dolt push` against one embedded
     * Dolt, fighting over the single write lock, each making the other slower. A
     * workspace already syncing is skipped rather than queued: the next tick is two
     * minutes away and there is nothing to catch up on.
     *
     * ## `ceiling`, and why it is handed in per sweep rather than read from a config
     *
     * The number is `syncCeilingMs(cfg)` and this file deliberately does not know what
     * `cfg` is — `createSyncer` takes a `bd` and nothing else, which is what lets the
     * whole failure path be driven by a fake. So the caller that has the config passes
     * the number (lib/server.js's `sweepSync`), and a caller that passes nothing gets
     * bd's own `BD_TIMEOUT`, which is what every one of these calls got before bc-y3qk.2.
     *
     * **`established` is what stops that being a regression.** A short ceiling is right
     * for a workspace whose sync is a going concern and wrong for one that has never
     * managed it, and those are not the same question as "did the last tick work" — see
     * the set's own note. The `inflight` guard above is still what makes an overrun safe;
     * this is what makes it rare.
     */
    async sweep(workspaces, { ceiling = null } = {}) {
      const all = workspaces || [];
      // Both lists are taken *before* anything is awaited, because `inflight` is what
      // this tick is about to change: reading it afterwards would report every
      // workspace this tick synced as one it skipped.
      const due = all.filter((w) => !inflight.has(w.name));
      const skipped = all.filter((w) => inflight.has(w.name)).map((w) => w.name);
      for (const w of due) inflight.add(w.name);
      const outs = await Promise.all(
        due.map(async (w) => {
          try {
            const timeout = ceiling && established.has(w.name) ? ceiling : null;
            const out = record(await syncOnce(bd, w, { timeout }));
            // `ok` and nothing else. A `no-remote` workspace never calls either verb, so
            // it has established nothing and would only be claiming a ceiling it has not
            // earned on the day somebody gives it a remote.
            if (out.state === 'ok') established.add(w.name);
            return out;
          } finally {
            inflight.delete(w.name);
          }
        })
      );
      return {
        results: outs,
        // What is worth a line, an event and a push: only the transitions.
        changed: outs.filter((o) => o.changed),
        skipped,
      };
    },
  };
}

/** Where a workspace's beads go, in as few characters as still identify the repo. */
export const remoteLabel = (remote) => (remote ? remote.url || remote.name || 'its remote' : 'its remote');

/** How a sync outcome reads in one line, on a log or in a notification. */
export function describeSync(out) {
  if (!out) return 'never synced';
  switch (out.state) {
    case 'ok':
      return `in sync with ${remoteLabel(out.remote)}`;
    case 'no-remote':
      return 'no Dolt remote — nothing to sync';
    case 'conflict':
      return `CONFLICT on ${out.phase || 'sync'} — ${out.error || 'Dolt could not merge the two histories'}`;
    // Deliberately does not contain the word "retrying", which is the whole point of the
    // state existing: this sentence replaces one that had been claiming a retry was
    // coming for 73 ticks. It says how long instead, because "stuck" with no number is
    // the same unfalsifiable reassurance in a different word.
    case 'stuck':
      return `STUCK on ${out.phase || 'sync'} after ${out.streak || 1} identical ${
        (out.streak || 1) === 1 ? 'failure' : 'failures'
      } — ${out.error || 'unknown error'}${out.pushed ? ' (this Mac’s beads did get out)' : ''}`;
    case 'failed':
      return `${out.phase || 'sync'} failed — ${out.error || 'unknown error'}`;
    default:
      return String(out.state);
  }
}
