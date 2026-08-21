#!/usr/bin/env node
/**
 * What every route has cost, as a table.
 *
 *   npm run timings                  # the running daemon, worst route first
 *   npm run timings -- --json        # the raw snapshot
 *   npm run timings -- --top 10      # just the worst ten
 *   node scripts/timings.mjs --url http://127.0.0.1:4318
 *
 * A *consumer*, like bin/monitor.js: everything here comes off `GET /api/timings` and
 * nothing was added to the server for it, so a wedged reader can never cost the daemon
 * a request. The figures themselves live in memory in the daemon (lib/timing.js) and
 * start over at every restart — which is what you want, because they are a claim about
 * the build that is running.
 *
 * Three columns are the point of the whole thing. **`sub%`** is how much of the average
 * request was spent waiting on a `bd`, `gh` or `git` child rather than in our own code: a
 * slow route at 0.95 is a caching problem, and a slow route at 0.05 is a bug in the
 * handler, and they are indistinguishable from a stopwatch. **`×`** is the fan-out — how
 * much child *work* that wait covered, so `9×` is nine workspaces swept at once and says
 * that the tenth workspace is nearly free while the first is not. And **cold, stale and
 * warm** are the same route on three sides of a cache; averaging them together produces a
 * number that has never once happened.
 *
 * **`loop`** is the fourth, and it is the only column on the table that a cache cannot
 * move. It is what share of the average request's wall clock the event loop was not
 * idle for — so a route over budget at `1.00` with no child process was not slow, it
 * was queued behind whatever else had the CPU, and the same route at `0.02` was waiting
 * on something that is neither the CPU nor a subprocess.
 * Those two used to print identically as `all ours`. The `blocked behind the loop` block
 * under the table names the first kind outright, the way `over budget` names the other
 * question this script exists to answer; lib/timing.js decides both lists.
 *
 * The middle column is the one bc-1kwl.2 added and the one to read a conversion by: a
 * **stale** request was answered out of memory while a refresh ran behind it, so it
 * should look like the warm column and not like the cold one. A route whose stale figures
 * resemble its cold figures is a route where the layer is not doing what it says — that
 * is what this column is for, and it is why a stale hit is not simply counted as warm.
 */
import { loadConfig } from '../lib/config.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`npm run timings — per-route request timings off the running daemon

  --json        the whole snapshot as JSON
  --top N       only the worst N routes (default all)
  --url U       the daemon to ask (default http://127.0.0.1:<configured port>)
  --parked      include the long-poll routes, which are slow on purpose`);
  process.exit(0);
}

const cfg = loadConfig();
const base = opt('--url', `http://127.0.0.1:${cfg.port || 4318}`).replace(/\/+$/, '');

let snap;
try {
  const res = await fetch(`${base}/api/timings`, { headers: { 'x-beadcause-token': cfg.token } });
  if (res.status === 401) {
    console.error('token rejected — is this the same ~/.config/beadcause as the daemon?');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${base}/api/timings answered ${res.status}`);
    process.exit(1);
  }
  snap = await res.json();
} catch (err) {
  console.error(`cannot reach ${base} — ${err.message}`);
  console.error('is the daemon running? `npm run swap:status` says.');
  process.exit(1);
}

if (argv.includes('--json')) {
  console.log(JSON.stringify(snap, null, 2));
  process.exit(0);
}

const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;

const mins = Math.round(snap.uptimeMs / 60000);
console.log(
  `\n${bold('beadcause request timings')} — ${snap.requests} requests over ${mins < 60 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`}` +
    dim(`  ·  budget ${snap.budgetMs}ms  ·  slow log at ${snap.slowMs || 'off'}\n`)
);

let rows = snap.routes.filter((r) => argv.includes('--parked') || !r.parked);
const top = Number(opt('--top', 0));
if (top > 0) rows = rows.slice(0, top);

const w = Math.min(40, Math.max(20, ...rows.map((r) => r.route.length)));
const short = `${'n'.padStart(5)} ${'p50'.padStart(7)} ${'p95'.padStart(7)}`;
const head = `${'route'.padEnd(w)}  ${'loop'.padStart(5)}  ${'n'.padStart(5)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'max'.padStart(7)} ${'sub%'.padStart(5)} ${'×'.padStart(5)}  ${short}  ${short}`;
console.log(dim(`${''.padEnd(w)}  ${''.padEnd(5)}  ${'—— cold ——'.padStart(41)}   ${'—— stale ——'.padStart(20)}   ${'—— warm ——'.padStart(20)}`));
console.log(dim(head));

const cell = (s, n) => String(s).padStart(n);
const blank = (n) => dim('·'.padStart(n));

// Which routes are over budget is the daemon's answer, not one recomputed here — it is
// `max(cold p95, warm p95)` against the budget, and a row reddened by a rule of its own
// can disagree with the list printed below it. It did: a route that is only ever warm
// and takes a second and a half (a transcript read spawns nothing, so it is warm by the
// derivation) was named in the list and left black in the table.
const overBudget = new Set(snap.overBudget);
// Same rule: which routes were starved rather than slow is the daemon's finding, and a
// route named below the table must be the one marked in it.
const starved = new Set(snap.starved || []);

for (const r of rows) {
  const c = r.cold;
  const h = r.warm;
  const over = overBudget.has(r.route);
  const name = r.parked ? dim(`${r.route} (parked)`.padEnd(w)) : (over ? red : (s) => s)(r.route.padEnd(w));
  const cold = c
    ? `${cell(c.n, 5)} ${cell(secs(c.p50Ms), 7)} ${cell(secs(c.p95Ms), 7)} ${cell(secs(c.maxMs), 7)} ${cell(c.subShare.toFixed(2), 5)} ${cell(c.fanout ? `${c.fanout}×` : '·', 5)}`
    : `${blank(5)} ${blank(7)} ${blank(7)} ${blank(7)} ${blank(5)} ${blank(5)}`;
  const three = (b) => (b ? `${cell(b.n, 5)} ${cell(secs(b.p50Ms), 7)} ${cell(secs(b.p95Ms), 7)}` : `${blank(5)} ${blank(7)} ${blank(7)}`);
  // Blank rather than `0.00` for a route with no samples yet, so an empty cell never
  // reads as a measured zero — the same reason every other column blanks.
  const loopCell = typeof r.loopShare === 'number' ? cell(r.loopShare.toFixed(2), 5) : blank(5);
  console.log(`${name}  ${starved.has(r.route) ? amber(loopCell) : loopCell}  ${cold}  ${three(r.stale)}  ${three(h)}`);
}

if (!rows.length) console.log(dim('  nothing has been asked for yet'));

if (snap.overBudget.length) {
  console.log(`\n${red('over budget')} — p95 past ${snap.budgetMs}ms, cold or warm:`);
  for (const route of snap.overBudget) console.log(`  ${route}`);
} else if (snap.requests) {
  console.log(`\nevery route inside the ${snap.budgetMs}ms budget.`);
}

if (snap.starved?.length) {
  console.log(
    `\n${amber('blocked behind the loop')} — over budget, spawned nothing, and spent most of it with the loop unavailable:`
  );
  for (const route of snap.starved) {
    const r = snap.routes.find((x) => x.route === route);
    console.log(`  ${route}${r ? dim(`  ${Math.round(r.loopShare * 100)}% of its wall clock`) : ''}`);
  }
  console.log(
    dim('  Nothing here is a caching problem — there was nothing to cache and no child to wait on.\n  What it was queued behind is a profile’s question, not this table’s.')
  );
}

const bg = Object.entries(snap.background.byKind || {})
  .map(([kind, s]) => `${kind} ${secs(s.ms)} in ${s.calls}`)
  .join(', ');
if (bg) {
  console.log(
    `\n${amber('off the request path')} — ${bg}` +
      dim('\n  the poll cycle, the advocate ticks and the sync timer. Not on any request, and not free\n  either: embedded Dolt is single-writer, so this is what a phone read queues behind.')
  );
}
if (snap.overflow) console.log(dim(`\n${snap.overflow} route(s) folded into "other" — the table is full (404s from a scan will do that).`));
console.log();
