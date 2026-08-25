/**
 * One keep, one refresher, and never a second one — the shared cache under bc-1kwl.2.
 *
 * A key, a producer and a freshness window. Past the window the kept value comes back
 * *now* and the producer runs behind the response, so the only request that ever waits
 * on `bd` or `gh` is the first one on a key nothing has been kept for.
 *
 * **This is not a new idea in this repo, and that is the point.** `Bd.graph`
 * (lib/bd.js) has carried four of the five properties below for a while, with the
 * measurements that justify each: a 60-second window, a `PARENT_INFLIGHT` map so nine
 * callers cause one `bd export`, last-good-on-failure, and a `wait: false` request path
 * that is stale-while-revalidate in everything but the name. Counted on 2026-08-13 there
 * were seven such caches — `Bd.graph`, the ledger's per-workspace sweep, the PR board's
 * 25s and the per-repo `gh` answers behind it, the endorsement queue's 15s, the auth
 * answer's 30s and the space picker's pending snapshot. Every one of them is correct and
 * every one of them re-derived the same argument. This file is that argument written
 * once, with the workspace-specific parts taken out; bc-1kwl.3 is the rest of them
 * moving onto it.
 *
 * ## The five properties
 *
 * **Stale-while-revalidate.** Past the window, the kept value returns synchronously
 * from memory and a refresh starts behind it. Nothing about the request path waits.
 *
 * **Single-flight, per key.** Two phones and a poll arriving together on an expired key
 * cause one producer call. The measurement in lib/bd.js is the whole argument: nine
 * workspaces asked twice is eighteen `bd export` spawns, and they queue behind each
 * other on a single-writer Dolt, so the second set is not merely wasted — it is slower
 * than the first, and it makes the first slower too.
 *
 * **Last good beats empty.** A producer that throws over a key that has a value leaves
 * that value readable and puts the failure on the envelope. A workspace that failed one
 * read has not lost its beads, and blanking a screen because one `bd` fell over is the
 * failure mode every hand-rolled cache in this repo already argues against.
 *
 * **Explicit invalidation, and therefore a key convention.** Keys are `<what>:<scope>`
 * — `ledger:sophab`, `prs:/Users/x/repo`, `queue:` for a thing with one instance. The
 * convention is not decoration: `dropPrefix('ledger:')` is how a write that changed one
 * kind of thing drops every scope of it without knowing which routes cached what, and a
 * prefix can only mean something if every caller spells its keys the same way. New
 * caller, new prefix, written here:
 *
 *     ledger:<workspace>     lib/history.js — one `bd list --all` per workspace
 *     board:                 lib/prboard.js — the whole swept PR board, one per daemon
 *     prs:<checkout>         lib/prboard.js — one checkout's `gh` slug and pull requests
 *     queue:<workspaces>     lib/endorsequeue.js — every held bead in the account's repos
 *     questions:<workspace>  lib/server.js — one `bd human list`, behind `allQuestions()`;
 *                            and lib/openquestion.js, which reads and fills the same key
 *                            to draw the open question naming a held bead
 *     foundation:<workspace> lib/server.js — one `bd list --label`, the foundation channel
 *     agentbeads:<workspace> lib/server.js — one `bd list --exclude-label human`
 *     work:<workspace>       lib/work.js — the four `bd` calls behind one console row
 *     skills:<workspaces>    lib/skills.js — the skill library, its candidates and the
 *                            audit ledger, three `git` calls per checkout and one
 *                            `bd list` per workspace
 *     graph:<workspace>      lib/graph.js — `bd graph --all --html` + `bd list --status`,
 *                            the workspace-wide graph page only; the per-bead form
 *                            (`?id=`) is not on this layer — see bc-1kwl.12
 *
 * `board:` and `prs:` are two prefixes for one screen on purpose: `forgetBoard(dir)` drops
 * the board by name and that one checkout's `gh` answers with it, because a caller that has
 * just merged something knows exactly which repo's answers went wrong. With no argument it
 * takes the whole `prs:` prefix, which is what a prefix is for.
 *
 * **The cold miss is the only wait, and it is bounded — by two different numbers for
 * two different questions — bc-19vt.1.** `ceilingMs` (`CEILING_MS`) is about the *slot*:
 * a refresh that never settles must stop holding the single-flight entry, or that key is
 * never refreshed again for the life of the process and the cache quietly becomes a
 * permanent snapshot. `bd` has its own 120-second ceiling and `gh` has whatever the
 * network gives it, so 150s is past both with room to spare. An abandoned refresh that
 * lands afterwards is still allowed to write, unless something newer arrived while it
 * was gone.
 *
 * `waitMs` is about the *caller* — how long **this** request's own `Promise.race` will
 * wait on that slot before it is told "not yet" — and it defaults to `ceilingMs`, so a
 * caller that never heard of the split sees no change. A caller that has somewhere
 * sensible to land a "could not read it yet" answer (an `unavailable` sentence, an
 * `errors[]` row — see `timedOut` below) can pass a much smaller one: the slot still
 * holds for the full 150 seconds, so the sweep that is already running keeps running and
 * still writes into the keep, but the request that arrived on the cold key stops
 * inheriting the slot's whole ceiling for no reason of its own. `lib/prboard.js` and
 * `lib/queues.js` are the two callers built to do this — see `WAIT_MS`.
 *
 * ## What this deliberately is not
 *
 * **Not persistent.** One daemon, one `Map`. A deploy restarts the process and every
 * key is cold again — which is a real cost, paid on the first read after every deploy,
 * and it is bc-1kwl.4's ("warm the cache at boot") rather than this file's. Warming
 * needs nothing added here: a poll tick calling `read(key, producer, { refresh: true })`
 * and ignoring the answer is a warm key.
 *
 * **Not evicted.** The key space is enumerable and bounded — a handful per workspace and
 * per checkout, all of them spelled by code in this repo rather than by anything a
 * request carries. Nothing here builds a key out of user input, and nothing should: that
 * is the change that would turn this paragraph into a leak.
 *
 * **Not a serializer.** The value is whatever the producer returned, by reference, and
 * callers must not mutate it — two readers of one stale entry hold the same object.
 * Every producer here already builds a fresh structure per sweep.
 *
 * ## It tells the instrument which of the three it was
 *
 * lib/timing.js decides warm from cold by whether the request spawned anything, which was
 * exactly right while two states were all there were. A stale hit answers from memory
 * *and* spawns — so left alone it would be filed under `cold`, and the change this file
 * exists to make would appear in the figures as no improvement at all. So every read says
 * outright which it was, and a background refresh is started `detached`, which puts its
 * `bd` seconds in the daemon's own column instead of on the request that happened to
 * trigger it. Both calls are no-ops off the request path, so warming from a poll tick
 * needs no special case.
 */
import * as timing from './timing.js';

/**
 * How long a refresh may hold its single-flight slot.
 *
 * Past `bd`'s own 120-second ceiling (BD_TIMEOUT in lib/bd.js) with room to spare, so a
 * `bd` that runs to its limit and is killed reports the failure through the normal path
 * rather than being abandoned here first — this is the backstop for a producer with *no*
 * ceiling of its own, which is `gh` and anything else reaching the network.
 */
export const CEILING_MS = 150_000;

/**
 * The suggested `waitMs` for a caller with somewhere sensible to land "not yet" —
 * bc-19vt.1.
 *
 * Not a default inside `read` itself — `waitMs` defaults to whatever `ceilingMs` the
 * call already has, which is the ordinary 150 seconds, so nothing regresses just by
 * this file existing. This is the number a caller opts *into*: short enough that a
 * phone stuck on a cold key is answered in seconds rather than parked for two and a
 * half minutes, long enough that a merely busy Mac usually finishes inside it anyway.
 * `lib/prboard.js`'s `collectBoard` and `lib/queues.js`'s `gatherMerges` pass it from
 * the two routes a person is actually watching (`/api/prs`, `/api/queues`) — an acting
 * call (Ship, Merge) still wants the real 150 seconds, because it needs an answer that
 * is true rather than a fast one, so it does not pass this.
 */
export const WAIT_MS = 5_000;

/**
 * The one thing a caller can tell apart from a producer that threw — bc-19vt.
 *
 * Every other failure out of `read` is the producer's own and means *this source is
 * broken*: `gh` refused, `bd` fell over, a checkout is gone. Running out of ceiling means
 * something quite different — the source is fine and the Mac is busy, the sweep is still
 * out there, and it will very probably land into the keep a few seconds after the request
 * that gave up on it. A caller that wants to answer "not yet" rather than "broken" has to
 * be able to see the difference, and matching on the message text is not seeing it.
 *
 * So the ceiling error carries a flag, and `timedOut(err)` is how you ask. Deliberately a
 * property rather than a subclass: the error crosses no module boundary that would keep
 * an `instanceof` honest, and every existing `catch (err)` here already treats it as an
 * ordinary Error and still does.
 */
export const timedOut = (err) => Boolean(err && err.cacheTimeout === true);

/** key → `{ at, value, error }`. `at` is when the value was produced. */
const kept = new Map();

/** key → `{ started, promise }` for the refresh in flight. See `startRefresh`. */
const running = new Map();

/**
 * key → how many times it has been invalidated. The only thing making `drop` reliable.
 *
 * A refresh that was already in flight when the key was dropped read the tracker *before*
 * whatever the drop was about, so its answer is exactly the answer the drop exists to get
 * rid of — and it lands afterwards, quietly undoing the invalidation. Not hypothetical:
 * it is what the ledger's own suite caught the first time this file was wired in, as one
 * repo serving another repo's rows.
 *
 * So a refresh carries the generation it started under and may only *write* if that is
 * still the current one. It is still allowed to finish and to answer whoever is waiting
 * on it — a ⟳ that raced a drop asked a real question and gets a real answer; what it may
 * not do is become the value the next reader sees.
 */
const generation = new Map();
const genOf = (key) => generation.get(key) || 0;

const clock = () => Date.now();
const first = (err) => String(err?.message || err || 'unknown').split('\n')[0];

/** `40ms`, `2.5s`, `150s` — a ceiling is quoted in the units it was set in. */
const secs = (msValue) => (msValue < 1000 ? `${Math.round(msValue)}ms` : `${Math.round(msValue / 100) / 10}s`);

/** What is kept for a key right now, without producing anything. For warming and tests. */
export const peek = (key) => kept.get(key) || null;

/**
 * Drop one key. The next read refetches instead of waiting out the window.
 *
 * Three things, and all three are needed for "the next read refetches" to be true: the
 * kept value goes, the single-flight slot goes so the next reader starts a sweep rather
 * than joining one that predates the drop, and the generation moves so the sweep already
 * out there cannot write itself back in. See `generation`.
 */
export function drop(key) {
  generation.set(key, genOf(key) + 1);
  running.delete(key);
  return kept.delete(key);
}

/** Drop every key under a prefix — `dropPrefix('ledger:')`. See the key convention above. */
export function dropPrefix(prefix) {
  let n = 0;
  // Through `drop`, not straight into the map: a prefix drop has to take the in-flight
  // sweeps and the generations with it, or it is a weaker thing than dropping each key
  // by name and the difference shows up only under load. `running` is included in the
  // keys walked because a key can be mid-first-sweep with nothing kept for it yet.
  for (const key of new Set([...kept.keys(), ...running.keys()])) if (key.startsWith(prefix)) n += Number(drop(key));
  return n;
}

/** Forget everything, including what is in flight. For the suite. */
export function clear() {
  for (const key of new Set([...kept.keys(), ...running.keys()])) generation.set(key, genOf(key) + 1);
  kept.clear();
  running.clear();
}

/**
 * Start a refresh for a key, or join the one already going.
 *
 * The `started` stamp is what makes an abandoned refresh safe to let land: it may only
 * write if nothing newer arrived while it was away. Without that, a sweep that took
 * three minutes could overwrite the answer from one that took three seconds, and the
 * cache would go *backwards* under exactly the load that made it slow.
 */
function startRefresh(key, producer, { now, ceilingMs }) {
  const already = running.get(key);
  if (already) return already.promise;

  const started = now();
  const gen = genOf(key);
  const job = Promise.resolve()
    .then(() => producer())
    .then((value) => {
      // Dropped while this was out: answer the caller, write nothing. See `generation`.
      if (genOf(key) !== gen) return value;
      const entry = kept.get(key);
      if (!entry || entry.at <= started) kept.set(key, { at: now(), value, error: null });
      return kept.get(key)?.value ?? value;
    })
    .catch((err) => {
      const entry = genOf(key) === gen ? kept.get(key) : null;
      if (!entry) throw err;
      // Last good beats empty. Logged on the way *into* failure rather than per attempt:
      // a tracker that is down is refreshed once per stale read, and a line each would be
      // the whole log. Staying broken quietly is the other failure, so the message is on
      // the envelope for as long as it lasts and the screen is what says so out loud.
      if (!entry.error) console.error(`[cache] ${key} is being served stale — ${first(err)}`);
      entry.error = first(err);
      return entry.value;
    });

  const slot = { started, promise: job };
  running.set(key, slot);

  // The slot's own ceiling. Not a cancellation — the producer is left to finish, and its
  // answer is still welcome under the `started` check above.
  const timer = setTimeout(() => {
    if (running.get(key) === slot) {
      running.delete(key);
      console.error(`[cache] ${key} gave up its refresh slot after ${secs(ceilingMs)} — the next read starts a fresh one`);
    }
  }, ceilingMs);
  timer.unref?.();
  const done = () => {
    clearTimeout(timer);
    if (running.get(key) === slot) running.delete(key);
  };
  job.then(done, done);

  return job;
}

/** The envelope every read returns. `stale` is about what is being *handed back*. */
const envelope = (entry, { now, freshMs, refreshing }) => ({
  value: entry.value,
  at: entry.at,
  ageMs: Math.max(0, now() - entry.at),
  stale: now() - entry.at >= freshMs,
  refreshing,
  error: entry.error || null,
});

/**
 * The staleness of a whole response, out of the pieces it was assembled from.
 *
 * Every route here fans out — the ledger sweeps one key per workspace, the board one per
 * checkout — so "was this answer kept?" is a question about the set, and the honest
 * summary is the *worst* of them: a page is as stale as its stalest part, and a page one
 * of whose parts is refreshing has a refresh on the way. Returns `null` for a fan-out
 * over nothing, which is a real case (`space=` matching no repo) and is not the same as
 * a fresh answer.
 */
export function combine(envelopes) {
  const list = (envelopes || []).filter(Boolean);
  if (!list.length) return null;
  return {
    stale: list.some((e) => e.stale),
    ageMs: Math.max(...list.map((e) => e.ageMs || 0)),
    refreshing: list.some((e) => e.refreshing),
    error: list.find((e) => e.error)?.error || null,
  };
}

/**
 * The header a route puts a kept answer's age on, and the one word that says which.
 *
 * **One convention, decided once, because five more routes are about to copy it**
 * (bc-1kwl.3). A header rather than a field in the body for the plain reason that not
 * every route here answers with an object — a body-level field would need an envelope
 * at each call site, and an envelope changes what every existing client parses.
 *
 * Deliberately not RFC 9211's `Cache-Status`, which covers this ground and is the
 * standard answer: it describes handling for *intermediaries*, and its way of saying
 * "stale" is a negative `ttl` — an inference, over a header a browser cache may also be
 * writing. What a screen needs is a word it can draw, from a name nothing else uses.
 *
 *     x-beadcause-kept: fresh; age=3
 *     x-beadcause-kept: stale; age=41; refreshing
 *
 * `age` is seconds, because that is what a person reads and what HTTP's own `Age` means.
 * **What failed is not in here**: a message does not belong in a header, and every route
 * on this layer already has somewhere honest to put one — the `errors[]` array that says
 * which workspace could not be read. The header says how old; the payload says what went
 * wrong; the screen needs both and they do not belong in the same place.
 */
export const KEPT_HEADER = 'x-beadcause-kept';

export function describe(kept) {
  if (!kept) return '';
  const parts = [kept.stale ? 'stale' : 'fresh', `age=${Math.round((kept.ageMs || 0) / 1000)}`];
  if (kept.refreshing) parts.push('refreshing');
  return parts.join('; ');
}

/**
 * The one entry point: what is kept for this key, and how old it is.
 *
 *     const { value, stale } = await read(`ledger:${ws.name}`, () => sweep(ws), { freshMs: 10_000 });
 *
 * - **Inside the window** — the kept value, no producer.
 * - **Past the window** — the kept value *now*, and a refresh behind it. `stale` is true
 *   on the envelope so the caller can say so on the wire (bc-1kwl.2.3).
 * - **Nothing kept** — awaits the producer, bounded by `waitMs` (default `ceilingMs`,
 *   the slot's own 150 seconds). The only wait there is, and the whole of what bc-1kwl.4
 *   exists to make rare — and, since bc-19vt.1, a wait a caller may shrink on its own
 *   without shrinking the slot: see `WAIT_MS`.
 * - **`refresh: true`** — the ⟳. Skip the keep, pay the cost, the user asked. It *joins*
 *   an in-flight refresh rather than starting a second one, which is the right reading of
 *   what refresh means: a sweep that began a moment ago and has not returned is reading
 *   the tracker now, so it is exactly as fresh as one started here would be.
 *
 * A producer that throws propagates only when there is nothing kept to serve instead —
 * a caller's error path (an `errors[]` row, a named workspace) is reachable on a cold
 * key and is deliberately not reachable over a good answer.
 */
export async function read(key, producer, { freshMs, now = clock, refresh = false, ceilingMs = CEILING_MS, waitMs = ceilingMs } = {}) {
  if (typeof key !== 'string' || !key) throw new TypeError('cache: a key must be a non-empty string');
  if (typeof producer !== 'function') throw new TypeError(`cache: ${key} needs a producer function`);
  if (!Number.isFinite(freshMs) || freshMs < 0) throw new TypeError(`cache: ${key} needs a freshness window in ms`);

  const entry = kept.get(key);

  if (!refresh && entry && now() - entry.at < freshMs) {
    timing.cache('warm');
    return envelope(entry, { now, freshMs, refreshing: running.has(key) });
  }

  if (!refresh && entry) {
    // Stale: hand back what we have and let the refresh land behind the response.
    //
    // `detached` is what keeps the refresh off this request's bill — see the note at the
    // top. The `catch` is for the window where the entry is dropped mid-flight and
    // `startRefresh` therefore rethrows: an unhandled rejection may not be the cost of a
    // cache hit.
    timing.detached(() => startRefresh(key, producer, { now, ceilingMs }).catch(() => {}));
    timing.cache('stale');
    return envelope(entry, { now, freshMs, refreshing: true });
  }

  // Cold, or a ⟳. This request really is paying for the producer, so it is *not*
  // detached: the seconds belong to the route, which is the number bc-1kwl's budget is
  // spent against. (A cold reader that joins a refresh already started in the background
  // is charged nothing for it — the work was under way for somebody else, and moving the
  // charge would mean charging it twice.)
  timing.cache('cold');

  // **But it is still told how long it waited**, which is a different thing from being
  // charged for the work and is the whole of bc-1kwl.33. `running.has` here, before
  // `startRefresh` decides, is the only moment at which "am I starting this sweep or
  // queueing behind one?" can be answered: a line later the slot exists either way. A
  // request that joined spawns nothing of its own, so without this it comes back as
  // `no subprocess, all ours` — the one shape the loop figure exists to leave meaning
  // *this handler really did run for a minute*, and on the two worst samples in the
  // 2026-08-21 log it was saying so of a request that had been idle the whole time.
  // Reporting only: nothing above this line moved.
  const waited = running.has(key) ? timing.joining() : null;
  // The slot always gets the full `ceilingMs` — that governs how long the *refresh*
  // may hold the single-flight entry, and shrinking it here would shrink it for every
  // other caller waiting on the same key, including one that never asked for a short
  // `waitMs` at all. See `startRefresh`.
  const job = startRefresh(key, producer, { now, ceilingMs });
  // But THIS caller only waits `waitMs` of it — bc-19vt.1. Bounded on its own, distinct
  // from the slot: a caller with somewhere sensible to land "not yet" (see `WAIT_MS`)
  // can give up in seconds while the sweep it started keeps running toward `ceilingMs`
  // and still lands into the keep for whoever asks next. A producer with no ceiling of
  // its own (`gh`) must not be able to park a request forever either way, which is why
  // this still defaults to `ceilingMs` for a caller that never asked for the split.
  let timer = null;
  let produced;
  try {
    produced = await Promise.race([
      job,
      new Promise((_, reject) => {
        // Not `unref`ed, unlike the slot's timer above: a request is waiting on this one,
        // and an unreferenced timer in an otherwise idle process is a promise that never
        // settles at all.
        timer = setTimeout(
          () =>
            reject(
              // Flagged, not merely worded: see `timedOut`. The sweep behind this is still
              // running and may still write, so a caller is entitled to say "not yet". Both
              // numbers ride on the error — `waitMs` is the one that actually ran out;
              // `ceilingMs` is the slot's, for a caller that wants to say both.
              Object.assign(new Error(`${key} did not answer within ${secs(waitMs)}`), { cacheTimeout: true, key, ceilingMs, waitMs })
            ),
          waitMs
        );
      }),
    ]);
  } catch (err) {
    // Whatever we have beats the throw, if we have anything: a refresh that failed over
    // a live key is the stale-with-an-error case, not an error.
    const after = kept.get(key);
    if (!after) throw err;
    if (!after.error) after.error = first(err);
    return envelope(after, { now, freshMs, refreshing: running.has(key) });
  } finally {
    clearTimeout(timer);
    // In the `finally` so the wait is recorded for the ceiling and the throw as well as
    // the answer: a request that queued sixty seconds behind a sweep and then gave up
    // waited the sixty seconds, and that is the sample most worth having.
    waited?.();
  }

  // Off the keep, unless a `drop` landed between the write and this line — in which case
  // the value the producer just returned is still the right answer to hand back, and
  // re-reading to obey the drop would only cost a second identical sweep.
  const fresh = kept.get(key) || { at: now(), value: produced, error: null };
  return envelope(fresh, { now, freshMs, refreshing: running.has(key) });
}
