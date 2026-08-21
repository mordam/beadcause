/**
 * How long each request actually took, and where the time went.
 *
 * Before this there was no number anywhere. "The app feels slow, some screens worse
 * than others" was the whole of what anyone could say about it, which is not something
 * you can turn into a target and not something a cache can be judged against: a
 * caching change with no before-figure is indistinguishable from a placebo, and so is
 * a caching change that made one route faster and another slower.
 *
 * Three things are measured, because with any one of them missing the number does not
 * tell you what to do next:
 *
 *   - **Total wall time per route.** The budget is a *page load* under a second, and a
 *     page load is a handful of these, so a per-route figure is the unit a budget can
 *     be spent against.
 *   - **The subprocess share.** Nearly everything slow here is a `bd` sweep or a
 *     `gh pr list`, not our own code — `bd list --all` over 500 beads answers in about
 *     a second idle and took 28 seconds under a load average of 33 (see BD_TIMEOUT in
 *     lib/bd.js). A route that is 95% `bd` is a caching problem; a route that is 95%
 *     ours is a different bug entirely, and the two look identical from the outside.
 *     **Two numbers, and it is worth knowing why.** These routes fan out — one
 *     `/api/questions` is nine `bd` processes at once, one for each workspace — so the
 *     *sum* of their durations runs past the request's own wall clock and `total - sum`
 *     goes negative. Measured on the first real run of this module: a 1097ms
 *     `/api/questions` reporting 5773ms of `bd` across nine children, and an "ours" of
 *     minus four seconds, which is not a number about anything. So the sum is kept as
 *     *how much child work the request cost the machine* and the **union of the
 *     intervals** — the wall time during which at least one child was running — is what
 *     "the subprocess share" means and what `ours` is measured against. The ratio
 *     between the two is the fan-out, and it is why the ninth workspace is nearly free.
 *   - **Warm, stale and cold.** The caches in lib/ mean the *same* route has completely
 *     different costs, and averaging them together hides all of them: the average of a
 *     30ms cache hit and a 3s sweep is a number that has never happened. So every route
 *     keeps three sets of figures, and the cold one is the one a budget is about.
 *
 *     **Three rather than two, and the third one is the whole of bc-1kwl.2.** A
 *     stale-while-revalidate hit answers out of memory *and* spawns a refresh behind the
 *     response — so under the derivation below it would be counted **cold**, and the
 *     change the P0 exists to make would show up in these figures as no improvement at
 *     all. A successful conversion and a failed one would read identically. `cache()` is
 *     how the layer says which of the three it was, and `detached()` is how the refresh
 *     it started stops being charged to the request that happened to trigger it: that
 *     work is the daemon's, it lands in `background`, and charging seconds of it to a
 *     route that answered in five milliseconds is the same lie in the other direction.
 *   - **How long the event loop was busy while the request was open.** The three above
 *     say what a request cost and how much of it was a child process, and `ours` is what
 *     is left when the child wall time is subtracted. That subtraction cannot tell *this
 *     handler ran for fifty-two seconds* from *this handler waited fifty-two seconds for
 *     a loop somebody else was blocking*: both come out `all ours`. Not a hypothetical —
 *     on 2026-08-21 the retained daemon log held 132 requests for **static page assets**
 *     filed exactly that way, `/style.css` at 16.6s, `/` at 10.1s, `/freshness.js` at
 *     33.8s, none of them under `/api/`. A stylesheet read off disk has no code of its
 *     own to run and no child to wait on, so those seconds went somewhere neither of the
 *     first two numbers can name — and a *stale* `/api/questions`, the fastest kind of
 *     request there is, took 39.7s in the same window, which is a cache layer being
 *     defeated rather than a cache layer failing. `loopBusy` is the third number, and
 *     the note there says what it settles and what it deliberately does not (bc-1kwl.30).
 *
 * **Nothing has to be threaded through to make that work**, which is the whole reason
 * this is an `AsyncLocalStorage` and not a parameter. `bd` is called from a few hundred
 * places behind `Bd.run`, and `gh` from lib/pr.js; both of those are single
 * chokepoints, and both can ask "what request am I inside?" without any of their
 * callers knowing this file exists. A subprocess spawned with no request in scope — the
 * poll cycle, an advocate tick, the sync timer — lands in `background` instead, which
 * is worth having on its own: it is the daemon's own load, and it competes with the
 * phone for the same single-writer tracker.
 *
 * **Warm and cold are derived, not declared.** A route that spawned no subprocess was
 * answered out of memory; one that spawned something paid for it. That is exactly the
 * distinction the hand-rolled caches make, it needs no edit at any of their call sites,
 * and it is honest about the case that matters — a cache miss is a cache miss whether
 * the code calling it thinks of itself as cached or not. `cache()` is there for a route
 * that knows better (a stale-while-revalidate hit *does* spawn, in the background), and
 * lib/server.js's caches can adopt it one at a time as bc-1kwl.2 lands.
 *
 * **Long-polls are counted apart from everything else.** `/api/poll` parks for
 * twenty-five seconds *on purpose* and answering it any sooner would be the bug. Left
 * in the same bucket as a page load it does not merely look bad, it destroys every
 * aggregate it touches: one parked poll outweighs a hundred real requests. So the two
 * poll routes are flagged `parked`, kept out of the slow log and out of the
 * over-budget list, and still measured — their subprocess share is a real fact about
 * what a poll that *did* return costs the tracker.
 *
 * **Work a request starts and does not wait for is counted nowhere, on purpose.** A
 * dispatched agent, a deploy, an advocate launch: those keep spawning children long after
 * the response went out, in the request's own async context, so they are charged to a
 * record that has already closed and are never folded into anything. That is the right
 * answer rather than a gap — by then it is not on any request path, and re-opening a
 * closed record would put minutes of an agent's work onto the route that merely pressed
 * the button.
 *
 * Cheap enough to leave on always, and it has to be: instrumentation you switch on when
 * you go looking is instrumentation that is off for every complaint you did not
 * anticipate. Per request this is two `hrtime.bigint()` reads, one object, and an
 * `enterWith`. Per route it is two fixed-size buckets and a ring of the last forty
 * durations — bounded, in memory, and deliberately not persisted: the numbers are about
 * the build that is running, and a deploy restarts the daemon anyway.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

/**
 * The epic's page-load budget, and the default threshold for the slow log.
 *
 * One second is bc-1kwl's number rather than a guess at a good one, which is why it
 * lives here as a constant that the config key defaults to: a route named by this log
 * is a route missing the budget, not a route that is merely slower than its neighbours.
 */
export const BUDGET_MS = 1000;

/** Durations kept per bucket, for the percentiles. Forty is two screens of requests. */
const KEEP = 40;

/**
 * A ceiling on how many distinct route keys are held.
 *
 * Static paths are a bounded set and `/api/` paths are a fixed table, so in ordinary
 * use this is nowhere near reached. What it is really for is the unbounded one: a 404
 * is a route key too, and anything on the tailnet holding the token can ask for a
 * thousand paths that do not exist. Past the ceiling the counting continues under one
 * `other` key, and `overflow` says how much of the truth was folded into it — silence
 * there would be the worse failure, since a table that stops growing looks complete.
 */
const MAX_ROUTES = 400;
const OTHER = 'other';

/**
 * How much of a route's wall clock has to have gone on a busy loop before `starved`
 * names it.
 *
 * Half, which is a claim rather than a round number: a route past the budget that
 * spawned nothing and spent *most* of its life with the loop unavailable to it has no
 * reading left in which it is its own fault. Below that the
 * evidence is genuinely mixed and the list would be naming suspects instead of a
 * finding, which is the failure mode that makes a diagnostic list stop being read. The
 * real 2026-08-21 samples are not near the line — `/style.css` at 16.6s came in at 0.99
 * — so nothing turns on the exact value, and if it ever does that is itself worth
 * knowing.
 */
const STARVED_SHARE = 0.5;

/**
 * The routes that are *supposed* to take a long time. See the note above.
 *
 * Matched on the route key, so it is method-and-path exact rather than a prefix: a
 * route that merely lives under the same word is not a long-poll, and this list going
 * stale in the safe direction (a new long-poll missing from it) shows up immediately as
 * an absurd figure on that route rather than as quietly wrong figures on all of them.
 */
const PARKED = new Set(['GET /api/poll', 'GET /api/console/poll']);

const store = new AsyncLocalStorage();

/** Per-route buckets, keyed `<key>` → `{cold, warm}`. */
const routes = new Map();

/** Subprocess time spent with no request in scope — the daemon's own load. */
let background = kinds();
let overflow = 0;
let since = Date.now();

/** The slow-log threshold, in ms. `0` turns the log off; the counting is never off. */
let slowMs = BUDGET_MS;
let write = (line) => console.warn(line);

const bucket = () => ({ n: 0, ms: 0, max: 0, sub: 0, wall: 0, loop: 0, calls: 0, recent: [], statuses: {} });

/** The shape both a request record and `background` count subprocess time in. */
function kinds() {
  return { sub: 0, calls: 0, byKind: {} };
}

/**
 * How much wall time these `[from, to]` spans cover between them, counting an overlap once.
 *
 * The whole reason the subprocess share is a *union* rather than a sum: nine `bd`
 * processes running at once for 600ms each cost the request 600ms, not 5.4 seconds, and
 * only the union can be subtracted from the request's own duration without going
 * negative. The sum is kept beside it because it is a different true thing — what the
 * request cost the machine, which on a single-writer tracker is the number the *next*
 * request pays for.
 */
function union(spans) {
  if (!spans.length) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let [from, to] = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const [a, b] = sorted[i];
    if (a > to) {
      covered += to - from;
      from = a;
      to = b;
    } else if (b > to) to = b;
  }
  return covered + (to - from);
}

/**
 * Threshold and log sink. Called once at boot from lib/server.js with `slowRequestMs`.
 *
 * `write` is injectable for the suite only — a threshold test that has to read real
 * stderr is a test that either swallows the daemon's own output or is not hermetic.
 */
export function configure({ slowMs: ms, write: sink } = {}) {
  if (ms !== undefined && ms !== null && Number.isFinite(Number(ms))) slowMs = Math.max(0, Number(ms));
  if (sink) write = sink;
}

/** Forget every figure. For the suite, and for anything that wants a fresh window. */
export function reset() {
  routes.clear();
  background = kinds();
  overflow = 0;
  since = Date.now();
}

const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;

/**
 * Start timing one request, and put it in scope for everything it goes on to call.
 *
 * `enterWith` rather than `run(store, fn)` deliberately: the alternative is wrapping
 * the whole three-thousand-line handler in a callback, and a re-indent that large is a
 * diff nobody can review against a file five other sessions are editing. The cost is
 * that the context is set for the remainder of this async resource, which for an HTTP
 * request is exactly the scope wanted.
 */
export function begin(key) {
  const rec = {
    key: String(key || 'unknown'),
    t0: process.hrtime.bigint(),
    // The event-loop utilization counters as they stood when this request opened. Read
    // only ever as a delta against a later pair — see `loopBusy`.
    elu: performance.eventLoopUtilization(),
    sub: 0,
    calls: 0,
    byKind: {},
    // `[from, to]` per child, in ms since `t0`, so the overlapping ones can be counted once.
    spans: [],
    cache: null,
    ended: false,
  };
  store.enterWith(rec);
  return rec;
}

/** The request being served right now, or `null` off the request path. */
export const current = () => store.getStore() || null;

/**
 * Charge one finished child process to whatever request is in scope.
 *
 * `startedAt` is the `process.hrtime.bigint()` taken when the child was spawned — the
 * *interval* rather than the duration, because a request that ran nine of them at once
 * has to be able to count the overlap once. See `union`.
 *
 * Never throws and never needs a caller to check anything: with no request in scope it
 * charges `background` instead, which is the honest place for a poll tick's sweep.
 */
export function spend(kind, startedAt) {
  if (typeof startedAt !== 'bigint') return;
  const endedAt = process.hrtime.bigint();
  const d = Number(endedAt - startedAt) / 1e6;
  if (!Number.isFinite(d) || d < 0) return;
  const rec = store.getStore();
  const target = rec || background;
  target.sub += d;
  target.calls += 1;
  const slot = (target.byKind[kind] ||= { ms: 0, calls: 0 });
  slot.ms += d;
  slot.calls += 1;
  if (rec) {
    // Clamped at zero rather than trusted: a child spawned before this record began is
    // one whose caller is not the request being timed, and a negative offset would make
    // the union longer than the request.
    const from = Math.max(0, Number(startedAt - rec.t0) / 1e6);
    rec.spans.push([from, Math.max(from, Number(endedAt - rec.t0) / 1e6)]);
  }
}

/**
 * Time one subprocess call and charge it. The shape every chokepoint uses:
 *
 *     return measure('bd', () => new Promise(...));
 *
 * The timer covers the failure as well as the success, because a `bd` that spent the
 * whole two-minute ceiling and was killed is the single most expensive thing that can
 * happen on the request path and the one most worth seeing in the figures.
 */
export async function measure(kind, fn) {
  const started = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    spend(kind, started);
  }
}

/**
 * The three words `cache` accepts, **coldest first**. See below for what each one means.
 *
 * The order is load-bearing rather than alphabetical: it is the ranking `cache()` uses
 * to decide which of several reads in one request gets to name it.
 */
export const TEMPERATURES = ['cold', 'stale', 'warm'];

/**
 * Say outright how this request was served, overriding the derivation.
 *
 * Three words, and only lib/cache.js is in a position to know which applies:
 *
 *   - `warm`  — inside the freshness window, nothing spawned.
 *   - `stale` — answered from memory, with a refresh running behind the response. The
 *     fastest kind of request there is, and the one the derivation would file as `cold`.
 *   - `cold`  — nothing was kept and the request paid for the producer.
 *
 * Anything else is ignored rather than thrown on: a bad word here must not be able to
 * fail a request that was otherwise served correctly.
 *
 * **A request is as cold as its coldest read, so this only ever lowers.** It used to
 * assign, which was exactly right while a route read one key — and stopped being right
 * the moment the routes this instrument exists to judge began fanning out. One
 * `/api/questions` calls the cache layer about thirty times: `questions:<ws>`,
 * `foundation:<ws>` and `agentbeads:<ws>`, once each per workspace, and against the ten
 * workspaces configured here that is thirty writes to a single scalar — under one
 * `Promise.all`, so the one that won was whichever came home last. Measured on the live
 * daemon 2026-08-17, that produced three log lines
 * reading `slow GET /api/questions 47842ms stale`, `18419ms stale` and `12309ms stale`
 * — and a stale hit answers out of memory with its refresh already `detached`, so it
 * *cannot* spend forty-seven seconds of the request's own wall clock. Those requests
 * paid a cold producer on at least one key and were then relabelled by a warmer read
 * that happened to finish later.
 *
 * That is not a rounding error in the figures, it is the figures pointing the wrong
 * way: the mislabelling runs in the flattering direction, moving the very worst samples
 * out of `cold` and into `stale`, which the note above calls the fastest kind of
 * request there is. `overBudget` is filtered on those buckets, so a route was being
 * excused by the same fan-out that made it slow.
 *
 * Escalating instead of assigning is one comparison, needs no new field, and is honest
 * about what the user waited for: a single cold key in a fan-out **is** the wait. It is
 * deliberately done here rather than by having `allQuestions` report once at the end,
 * because the same shape is behind `/api/work` (`work:<ws>` per workspace) and
 * `/api/prs` (`board:` plus `prs:<checkout>`), and a per-caller fix would have to be
 * re-derived at every one of them and re-derived again at the next one.
 *
 * Note what it does **not** touch: the derivation. A route that declares `warm` is
 * still believed over a `calls > 0` that would derive `cold`, because a caller that
 * knows it was served from memory knows something the subprocess count does not.
 */
export function cache(state) {
  const rec = store.getStore();
  if (!rec) return;
  const rank = TEMPERATURES.indexOf(state);
  if (rank < 0) return;
  // `indexOf` of an unset `rec.cache` is -1, which is how the first call always lands.
  const held = TEMPERATURES.indexOf(rec.cache);
  if (held < 0 || rank < held) rec.cache = state;
}

/**
 * Run something with **no request in scope**, so what it spawns lands in `background`.
 *
 * The cache layer's background refresh starts inside the request that found the key
 * stale, and `spend` charges whatever record is in scope — so without this, the very
 * requests this instrumentation exists to show as fast would each carry a whole `bd`
 * sweep. `AsyncLocalStorage.exit` is the exact tool: the callback and everything it
 * awaits run outside the store, which is where a refresh nobody is waiting for belongs.
 *
 * Not the same as the work described above under "work a request starts and does not
 * wait for" — that lands nowhere because its record has already closed. This lands
 * somewhere, deliberately: a refresh is real load on a single-writer tracker, and
 * `background` is the honest column for it.
 */
export function detached(fn) {
  return store.exit(fn);
}

/** Warm unless it paid for a subprocess — see the note at the top. */
const temperature = (rec) => rec.cache || (rec.calls > 0 ? 'cold' : 'warm');

/**
 * How much of this request's wall clock the event loop was unavailable for.
 *
 * `total` and `children` say what the request cost and how much of it was somebody
 * else's process. Neither can see the case where a request took ten seconds because
 * *this* process was busy the whole time and never got round to it — and that case is
 * what the note at the top of this file is about. Until there is a number for it,
 * `all ours` covers two entirely different bugs and prints the same way for both.
 *
 * **`eventLoopUtilization` rather than `monitorEventLoopDelay`, and the reason is
 * concurrency.** Both live in `perf_hooks` and neither was used anywhere in this repo
 * before this. The delay monitor keeps one process-wide histogram sampled at a fixed
 * resolution, and the only way to ask it about a *window* is `reset()` — which would rob
 * every other request in flight of its own window, and there are a dozen of them on a
 * page load. Utilization is a pair of monotonic counters the loop already keeps, so a
 * delta between two reads is exact rather than sampled, costs two calls and no timer,
 * and composes across as many overlapping windows as there are sockets. `--cpu-prof` is
 * the other thing that was not here and it is not an alternative to either: it is a flag
 * handed to a process you are about to start, and this has to be on for the complaint
 * nobody anticipated. It stays the right tool for *attributing* what the number finds.
 *
 * **What it settles, and what it deliberately does not.** `active` is the request's wall
 * clock minus the time the loop spent asleep, so it is *the loop was not available*
 * rather than *this handler was computing*, and the difference is not pedantry: on this
 * Mac, with thirty agent windows and a hundred `bd` children against twelve cores, a
 * process that is runnable but not scheduled is not idle either, and a request waiting
 * through that waited for the same reason and wants the same fix. What it cannot say is
 * *whose* work it was. For a request with nothing of its own to run the answer follows
 * anyway — `/style.css` at 16.6s with 16.5s of `loop` was starved, and no cache can fix
 * a stylesheet — but for a handler that might genuinely be doing fifty seconds of work
 * the two readings are the same number, and only a profile separates them.
 *
 * What it *does* settle in both directions is the third possibility nobody could rule
 * out before: a `loop` far below `total` with no children means the request was waiting
 * on something that was neither the CPU nor a subprocess — a lock, a socket, a slow disk
 * — which is a different bug with a different fix and used to print as `all ours` beside
 * the other two. Measured on the real handlers on 2026-08-21 (bc-1kwl.30): a cold
 * `/api/queues` took 65.4s with 65.4s of children, 26ms of `ours` and **1.8s** of loop,
 * and the whole process burned 1.6s of CPU doing it — so the 52s of `ours` the live
 * daemon recorded on that route is not fifty-two seconds of handler that a profile could
 * find. There is none there to find.
 *
 * **Live rather than lagged**, which is what makes the `Server-Timing` header worth
 * setting from the middle of a request: `active` is derived as *now minus loop start
 * minus idle*, so a block still in progress is already in it and does not wait for the
 * loop to come round again. The one place it answers zero is before the loop has started
 * at all — a module body, which is the only code here that could ask — and zero is the
 * safe direction: it can lose a finding, never invent one.
 *
 * One measured caveat, because it is the sort of thing that gets rediscovered as a bug:
 * **running the daemon under `--cpu-prof` inflates this number.** The same cold
 * `/api/queues` read 1.8s of loop unprofiled and 40.3s profiled, on 0.9s of process CPU
 * both times — the sampler's per-millisecond interrupt is enough to stop libuv accruing
 * idle. Profile to attribute a figure, never to measure this one.
 *
 * Clamped into `[0, total]`. The two utilization reads are taken a hair apart from the
 * timestamps they are a share of, and a loop figure longer than the request it belongs
 * to is not a number about anything.
 */
function loopBusy(rec, total) {
  if (!rec || !rec.elu) return 0;
  const active = Number(performance.eventLoopUtilization(rec.elu)?.active);
  if (!Number.isFinite(active) || active <= 0) return 0;
  return Math.min(total, active);
}

/**
 * `Server-Timing`, so one request can be read on its own without an aggregate.
 *
 * This is what makes a single slow load explicable from a terminal — `curl -sD-` names
 * the route's own split — and it is what browser devtools draws in the waterfall. The
 * aggregate is the answer for the phone, which cannot show a response header.
 */
export function header(rec) {
  if (!rec) return '';
  const total = ms(rec.t0);
  const parts = [`total;dur=${total.toFixed(1)}`];
  // Each binary's own summed time, then the union under `children` — the one that can be
  // subtracted from `total`, and the pair whose ratio is how wide the fan-out was.
  for (const [kind, slot] of Object.entries(rec.byKind)) parts.push(`${kind};dur=${slot.ms.toFixed(1)}`);
  if (rec.spans.length) parts.push(`children;dur=${union(rec.spans).toFixed(1)}`);
  // Read here as well as in `end`, because the header goes out with the status line and
  // the record does not close until the response does — for a streamed file that is a
  // long way apart. The two figures are the same measurement over slightly different
  // windows, and each is right about its own.
  parts.push(`loop;dur=${loopBusy(rec, total).toFixed(1)}`);
  parts.push(`cache;desc=${temperature(rec)}`);
  return parts.join(', ');
}

/**
 * Close the record: fold it into its route's buckets, and log it if it missed the
 * threshold.
 *
 * Idempotent, because `finish` and `close` can both fire on one response and a request
 * counted twice is worse than one counted late.
 */
export function end(rec, status = 0) {
  if (!rec || rec.ended) return null;
  rec.ended = true;
  const total = ms(rec.t0);
  const temp = temperature(rec);
  const parked = PARKED.has(rec.key);

  let key = rec.key;
  if (!routes.has(key) && routes.size >= MAX_ROUTES) {
    overflow += 1;
    key = OTHER;
  }
  const route = routes.get(key) || { key, parked: key === OTHER ? false : parked, cold: bucket(), stale: bucket(), warm: bucket() };
  routes.set(key, route);

  // The wall time at least one child was running — the part of `total` that was not ours.
  // Never more than the request itself, whatever the children summed to.
  const wall = Math.min(total, union(rec.spans));
  // And the part of `total` during which the loop was not idle. Overlaps `wall` freely
  // and is subtracted from nothing: a request can be waiting on a child *and* on a loop
  // that is unavailable to it, and on a busy Mac usually is.
  const loop = loopBusy(rec, total);

  const b = route[temp];
  b.n += 1;
  b.ms += total;
  b.max = Math.max(b.max, total);
  b.sub += rec.sub;
  b.wall += wall;
  b.loop += loop;
  b.calls += rec.calls;
  b.recent.push(total);
  if (b.recent.length > KEEP) b.recent.shift();
  if (status) b.statuses[status] = (b.statuses[status] || 0) + 1;

  if (slowMs > 0 && total >= slowMs && !parked) {
    const split = Object.entries(rec.byKind)
      .map(([kind, slot]) => `${kind} ${Math.round(slot.ms)}ms`)
      .join(' + ');
    write(
      `[beadcause] slow ${rec.key} ${Math.round(total)}ms ${temp}` +
        (rec.calls
          ? ` — ${Math.round(wall)}ms of it waiting on ${rec.calls} child process(es) (${split} of work), ours ${Math.round(total - wall)}ms`
          : ' — no subprocess, all ours') +
        // Third on the line rather than folded into `ours`, because it is a different
        // question: `ours` is what was not a child process, and this is how much of the
        // request the loop was unavailable for. A static asset with the two nearly equal
        // was starved rather than slow.
        `; loop busy ${Math.round(loop)}ms`
    );
  }
  return { key: rec.key, ms: total, sub: rec.sub, wallMs: wall, loopMs: loop, temperature: temp, parked };
}

/**
 * Everything in one call: begin, the `Server-Timing` header, and the close.
 *
 * The whole of what lib/server.js has to do, so instrumenting a request is one line at
 * the top of the handler rather than a `try`/`finally` around a chain of two hundred
 * `return`s. `writeHead` is wrapped rather than the response listened to for the header
 * because a header can only be set before the status line goes out; the aggregate is
 * closed on `finish`/`close` instead, which is the only pair that fires for every
 * ending — a streamed file (`/api/asset`, every static file) never returns through the
 * handler at all, and a client that hangs up mid-response gets `close` alone.
 */
export function instrument(req, res, key) {
  const rec = begin(key);
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (...args) => {
    try {
      if (!res.headersSent) res.setHeader('server-timing', header(rec));
    } catch {
      /* a header set on a response already on the wire is not worth failing a request over */
    }
    return writeHead(...args);
  };
  const done = () => end(rec, res.statusCode);
  res.once('finish', done);
  res.once('close', done);
  return rec;
}

const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};

const round = (n) => Math.round(n * 10) / 10;

function stats(b) {
  if (!b.n) return null;
  const sorted = [...b.recent].sort((x, y) => x - y);
  return {
    n: b.n,
    avgMs: round(b.ms / b.n),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    maxMs: round(b.max),
    // The wall time the average request spent with at least one child running, and what
    // is left over for us. `subMs` is the other true number: how much child *work* the
    // request cost the machine, which on a single-writer tracker is what the next request
    // queues behind. The two differ by the fan-out — nine workspaces swept at once.
    subMs: round(b.wall / b.n),
    childWorkMs: round(b.sub / b.n),
    oursMs: round((b.ms - b.wall) / b.n),
    // How long the loop was unavailable while the average request of this shape was open,
    // and what share of it that was. A route that is over budget with no
    // children and a share near 1 was not slow, it was queued behind somebody else — see
    // `loopBusy`. The share is kept beside the figure because the figure alone is only
    // readable against the route's own total.
    loopMs: round(b.loop / b.n),
    loopShare: b.ms > 0 ? Math.round((b.loop / b.ms) * 100) / 100 : 0,
    fanout: b.wall > 0 ? Math.round((b.sub / b.wall) * 10) / 10 : 0,
    // What fraction of the average request was spent waiting on a child process. The
    // number that says whether a route is a caching problem or a code problem.
    subShare: b.ms > 0 ? Math.round((b.wall / b.ms) * 100) / 100 : 0,
    calls: round(b.calls / b.n),
    statuses: b.statuses,
  };
}

/**
 * Every route with its three sets of figures, worst first, plus the ones over budget.
 *
 * Sorted by a p95 rather than an average — ordering by the mean would put a route that
 * is fast a hundred times and catastrophic once below one that is mediocre throughout,
 * and it is the catastrophic one somebody is complaining about. The p95 it sorts on, and
 * the one `overBudget` is filtered on, is `worstMs`: the **worse of the cold and warm
 * p95s**, not the cold one. A request past the budget is past the budget whether or not
 * it spawned anything, and the case that proves it is real — `GET /api/session-log`
 * reads a transcript file, so it spawns nothing, so it is warm by the derivation, and it
 * took 1.5s. Filtering on the cold p95 would drop the one row in the table that has no
 * cold samples at all and is still the slowest thing on the page. `overBudget` names
 * them outright rather than leaving it to be read off the table, because "which routes
 * miss the second" is the question this whole module exists to answer — and anything
 * printing that list must not call it cold (bc-fg37).
 */
export function snapshot({ budgetMs = BUDGET_MS } = {}) {
  const rows = [];
  for (const route of routes.values()) {
    const cold = stats(route.cold);
    const stale = stats(route.stale);
    const warm = stats(route.warm);
    // Across all three temperatures, because being queued behind a blocked loop is not a
    // property of how the request was going to be served: a warm read and a cold sweep
    // wait in the same line, and splitting the evidence three ways would leave a route
    // with a handful of samples in each bucket looking innocent in all of them.
    const everyMs = route.cold.ms + route.stale.ms + route.warm.ms;
    const everyLoop = route.cold.loop + route.stale.loop + route.warm.loop;
    rows.push({
      route: route.key,
      parked: route.parked,
      cold,
      stale,
      warm,
      loopShare: everyMs > 0 ? Math.round((everyLoop / everyMs) * 100) / 100 : 0,
      calls: route.cold.calls + route.stale.calls + route.warm.calls,
      // The worst of the three, which is nearly always the cold one — but a route whose
      // stale path is somehow slower than its cold path is a bug worth being sorted to
      // the top for, and taking the max is how it gets there instead of being averaged
      // into invisibility. It caught one: `/api/questions` logging 48-second `stale`
      // samples was the last-write-wins scalar `cache()` used to be, and the note there
      // says what it turned out to be.
      worstMs: Math.max(cold?.p95Ms || 0, stale?.p95Ms || 0, warm?.p95Ms || 0),
    });
  }
  rows.sort((a, b) => b.worstMs - a.worstMs || a.route.localeCompare(b.route));
  return {
    since: new Date(since).toISOString(),
    uptimeMs: Date.now() - since,
    budgetMs,
    slowMs,
    requests: rows.reduce((n, r) => n + (r.cold?.n || 0) + (r.stale?.n || 0) + (r.warm?.n || 0), 0),
    routes: rows,
    overBudget: rows.filter((r) => !r.parked && r.worstMs > budgetMs).map((r) => r.route),
    // The routes that missed the budget without ever spawning anything and spent most of
    // their time with the loop busy — starved rather than slow, and therefore the one
    // list on this snapshot that no cache can shorten. Answered here rather than left to
    // whoever is printing, for the same reason `overBudget` is: a consumer applying a
    // rule of its own can disagree with the daemon about which routes it is about, and
    // one of them did (bc-fg37). `calls === 0` is the load-bearing half — a route that
    // paid for a child process has an ordinary explanation available and does not belong
    // in a list whose whole claim is that there is no such explanation.
    starved: rows
      .filter((r) => !r.parked && r.worstMs > budgetMs && r.calls === 0 && r.loopShare >= STARVED_SHARE)
      .map((r) => r.route),
    // Subprocess time the daemon spent on nobody's behalf: the poll cycle, the advocate
    // ticks, the sync timer. It is not on the request path and it is not free either —
    // embedded Dolt is single-writer, so this is what a phone's `bd` read queues behind.
    // Summed child work rather than a union, because there is no request window here for
    // an overlap to be measured against.
    background: { ms: round(background.sub), calls: background.calls, byKind: background.byKind },
    // How many distinct routes were dropped into `other` once the table filled.
    overflow,
  };
}
