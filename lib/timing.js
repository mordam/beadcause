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

const bucket = () => ({ n: 0, ms: 0, max: 0, sub: 0, wall: 0, calls: 0, recent: [], statuses: {} });

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

/** The three words `cache` accepts. See below for what each one means. */
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
 */
export function cache(state) {
  const rec = store.getStore();
  if (rec && TEMPERATURES.includes(state)) rec.cache = state;
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
 * `Server-Timing`, so one request can be read on its own without an aggregate.
 *
 * This is what makes a single slow load explicable from a terminal — `curl -sD-` names
 * the route's own split — and it is what browser devtools draws in the waterfall. The
 * aggregate is the answer for the phone, which cannot show a response header.
 */
export function header(rec) {
  if (!rec) return '';
  const parts = [`total;dur=${ms(rec.t0).toFixed(1)}`];
  // Each binary's own summed time, then the union under `children` — the one that can be
  // subtracted from `total`, and the pair whose ratio is how wide the fan-out was.
  for (const [kind, slot] of Object.entries(rec.byKind)) parts.push(`${kind};dur=${slot.ms.toFixed(1)}`);
  if (rec.spans.length) parts.push(`children;dur=${union(rec.spans).toFixed(1)}`);
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

  const b = route[temp];
  b.n += 1;
  b.ms += total;
  b.max = Math.max(b.max, total);
  b.sub += rec.sub;
  b.wall += wall;
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
          : ' — no subprocess, all ours')
    );
  }
  return { key: rec.key, ms: total, sub: rec.sub, wallMs: wall, temperature: temp, parked };
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
    rows.push({
      route: route.key,
      parked: route.parked,
      cold,
      stale,
      warm,
      // The worst of the three, which is nearly always the cold one — but a route whose
      // stale path is somehow slower than its cold path is a bug worth being sorted to
      // the top for, and taking the max is how it gets there instead of being averaged
      // into invisibility.
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
