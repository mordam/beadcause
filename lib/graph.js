/**
 * The dependency graph, as data.
 *
 * beadcause used to serve `bd graph --html` straight through, which was free but
 * wrong in three ways on a phone: the page arrives all at once after a wait long
 * enough to read as broken (5.0s for deluvia's 108 nodes), its 130x40 nodes
 * truncate every title, and there is nowhere to go from a node you tapped. So we
 * take bd's numbers and draw them ourselves — see public/graph.js.
 *
 * The numbers come out of that same HTML page rather than `bd graph --all --json`,
 * for two reasons: the page embeds exactly the render model we want — id, title,
 * status, priority, type and the *layer* bd has already computed, plus typed links —
 * where `--json` returns whole issue descriptions we'd throw away (deluvia's are
 * several hundred KB). It is a two-line surface, and if bd ever changes the shape,
 * `nodes`/`links` simply come back empty rather than half-parsed.
 *
 * What that page does *not* carry is time: no created_at, no updated_at, no
 * started_at. So it can only answer "what exists", and the second half of this file
 * folds `bd list`'s dates back on to answer "what is happening".
 *
 * The third part, `workspaceGraph`/`warmGraphs`, is the plumbing rather than the
 * shape: `bd graph --all --html` was the single worst request in the app (120.1s at
 * the tail) because nothing kept an answer between requests. See the doc comment on
 * `workspaceGraph` for why the fix is a key spelled by code and not by anything a
 * request carries (bc-1kwl.12).
 */
import { PHASES } from './activity.js';
import { shortActor } from './work.js';
import { RELATED_EDGES } from './mentions.js';
import * as cache from './cache.js';

const ARRAY_RE = (name) => new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`);

function pull(html, name) {
  const m = ARRAY_RE(name).exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * `{ nodes, links }` from a `bd graph --html` page.
 *
 * A workspace with nothing open isn't an error: bd prints "No open issues found"
 * as bare text, and that has to reach the client as an empty graph rather than a
 * parse failure, or an idle workspace looks like a broken one.
 */
export function parseGraph(html) {
  const nodes = pull(html, 'nodes');
  const links = pull(html, 'links');
  if (!nodes) return { nodes: [], links: [], empty: true };
  return {
    nodes,
    // Links reference nodes by id; d3 mutates them into object refs on the client,
    // so they are handed over exactly as bd wrote them.
    links: links || [],
    empty: nodes.length === 0,
  };
}

/* ------------------------------------------------------------------ live data */

const HOUR = 3600 * 1000;

/**
 * Edges where neither end is blocking the other.
 *
 * The same split the sheet makes over `bd show --json`'s `dependencies[]`
 * (`relations`, public/graph.js): `parent-child` is where a bead *sits*, not what
 * it is stuck behind, and neither `discovered-from` nor a see-also blocks anything.
 * An edge type nobody here has seen still counts, which leaves this on the same
 * side as bd's own numbers for anything new rather than silently hiding it.
 *
 * **Both spellings of the see-also, and the second one is the one bd writes.** This set
 * said only `related` until bc-arj0.4, which is the name of the single hand-made edge
 * that existed when it was written; `bd dep relate` stores `relates-to`. That was
 * harmless while the tracker held one such edge and became load-bearing the moment a
 * sweep drew hundreds of them, because every one would have arrived on a card counted
 * as a live blocker — a bead announcing that it waits on eight beads it merely mentions.
 */
const NOT_BLOCKING = new Set(['parent-child', 'discovered-from', ...RELATED_EDGES]);

/**
 * Each node's live blockers, and the live beads it holds up — both counted off the
 * edges bd itself drew.
 *
 * Neither of bd's two counts can answer either question, and the reason to stop
 * asking them is not one bug but that **`bd show` and `bd list` do not agree with
 * each other**, so a count taken off a row is only as true as whichever command
 * happened to fill it. Both halves were measured against this workspace on
 * 2026-08-11:
 *
 *  - **`bd show --json` counts the `parent-child` edge** among a bead's plain
 *    dependencies, at both of its ends. bc-goo, an epic that blocks nothing, comes
 *    back `dependent_count: 11` — its eleven children — which is where the "blocks 7"
 *    this replaces was seen when it had seven of them (bc-cpzm).
 *  - **`bd list --json` does not**, and every epic here reports `dependent_count: 0`
 *    over as many as six open children. What it *does* count at both ends is
 *    neighbours that have since **closed**: bc-nib3.4 blocks two beads, one of them
 *    finished, and the row says two. bc-l8jp.7's three "dependencies" were one live
 *    blocker and one closed one (bc-ne8u).
 *
 * The rows behind this graph are `bd list`'s, so the closed half is the one that was
 * actually reaching the card — but it is the disagreement that decides the approach.
 * The links carry a `type`, so each count can be made of exactly the edges the phrase
 * on the card means, and neither number moves when bd changes its mind. The two are
 * one walk in opposite directions, which is why they are one loop.
 *
 * **An edge with a closed end at either end counts for neither.** A closed blocker has
 * stopped blocking, and a closed bead has stopped being held up — so the relationship
 * is live only while both ends are. Testing one end would leave the two cards over one
 * edge contradicting each other: a finished bead announcing that it holds up work,
 * beside the bead it names saying it is waiting on nothing. It also makes the two
 * graphs agree, which is the other half of why the test is here at all: `bd graph
 * --html <id>` reaches into closed neighbours and draws their edges, where `--all`
 * prunes node and edge together, so the same bead would otherwise wait on — and block —
 * more in the scoped view than in the whole-workspace one.
 *
 * A graph whose `links` did not parse reports nobody waiting on and nobody blocking
 * anything, rather than falling back to the counts this exists to replace. That is the
 * direction to fail in: a bead that says it is holding up work it is not is worse than
 * one that says nothing.
 */
function typedCounts({ nodes, links }) {
  const closed = new Set();
  for (const n of nodes || []) if (n && n.status === 'closed') closed.add(n.id);
  const waits = new Map();
  const blocks = new Map();
  for (const l of links || []) {
    if (!l || NOT_BLOCKING.has(l.type) || closed.has(l.source) || closed.has(l.target)) continue;
    waits.set(l.target, (waits.get(l.target) || 0) + 1);
    blocks.set(l.source, (blocks.get(l.source) || 0) + 1);
  }
  return { waits, blocks };
}

/**
 * The cut-off for "moved this session".
 *
 * Anchored on the oldest live Claude Code session in this workspace: while agents
 * are running, "this session" is a real interval with a real start, and a bead
 * touched inside it moved *because of them*. With nothing running there is no
 * session to be inside, so it falls back to a fixed two-hour window — "recently",
 * which is the weaker claim and the honest one. The caller is told which it got,
 * because "moved this session" and "moved recently" are different sentences and the
 * phone should not say the first one when it means the second.
 *
 * Capped at a day either way. A session left open since Tuesday would otherwise
 * mark the entire graph as moved, and a mark that lands on everything says nothing.
 */
export function movedSince(sessions, workspace, now = Date.now()) {
  const starts = (sessions || [])
    .filter((s) => s.workspace === workspace && s.startedAt)
    .map((s) => Date.parse(s.startedAt))
    .filter(Number.isFinite);
  const kind = starts.length ? 'session' : 'recent';
  const anchor = starts.length ? Math.min(...starts) : now - 2 * HOUR;
  return { since: new Date(Math.max(anchor, now - 24 * HOUR)).toISOString(), kind };
}

/**
 * Fold what `bd list` knows onto the nodes `bd graph` drew.
 *
 * The dates are the whole difference between "what exists" and "what is happening":
 * `updated_at` is what makes a node recently-moved, `started_at` is how long an
 * agent has been on it, `created_at` is how long it has been waiting.
 *
 * A node with no matching row keeps everything it arrived with and gains nulls. That
 * is the normal case for a bead-scoped graph, which reaches into closed neighbours
 * the live list deliberately excludes — those still draw, they just have no age.
 */
export function enrichGraph(graph, rows, { since, activity = {}, workspace = '' } = {}) {
  const live = new Map();
  for (const r of rows || []) if (r && r.id) live.set(r.id, r);
  const cut = Date.parse(since) || 0;
  const { waits: waiting, blocks: blocking } = typedCounts(graph);

  const nodes = graph.nodes.map((n) => {
    const r = live.get(n.id) || {};
    const updated = r.updated_at || null;
    // `agent:<phase>` is the cross-session signal — any tool can set it with
    // `bd set-state`, where status.json only knows what came through beadcause.
    const stored = activity[`${workspace}/${n.id}`];
    const labelled = (r.labels || []).find((l) => l.startsWith('agent:'));
    const claimed = stored?.phase || (labelled ? labelled.slice(6) : null);
    const phase = claimed && claimed !== 'idle' ? claimed : null;
    return {
      ...n,
      // Prefer the list's own answer: the same field from the same database, read
      // fresher than the graph page's copy. Owner is the fallback because an
      // unassigned bead still has one, and whose bead it is is worth showing.
      actor: shortActor(r.assignee || n.assignee || r.owner),
      created_at: r.created_at || null,
      updated_at: updated,
      started_at: r.started_at || null,
      comments: r.comment_count ?? null,
      // Neither of these is from the list row: both are counted off the graph's own
      // typed edges, for the reasons on `typedCounts` — where the two numbers bd
      // offers here disagree with the two `bd show` offers for the same bead, and
      // both of them count neighbours that have closed. The *rows* behind that
      // `blocks` pill on the sheet are still bc-2ocm; this is only the count.
      blocks: blocking.get(n.id) || 0,
      waits: waiting.get(n.id) || 0,
      phase,
      icon: phase ? PHASES[phase]?.icon || '•' : null,
      detail: stored?.detail || '',
      moved: Boolean(updated && Date.parse(updated) >= cut),
    };
  });

  return { ...graph, nodes };
}

/* ------------------------------------------------------------- the workspace-wide sweep */

/**
 * The workspace-wide graph — one key per workspace, on the shared layer. bc-1kwl.12.
 *
 * `bd graph --all --html` walks the whole dependency graph and was the single worst
 * request in the app: 120.1s at the tail, 46 requests p50 20.4s (measured 2026-08-17,
 * after bc-1kwl.3/.4/.7 had already covered everything else). It is cacheable exactly
 * the way lib/cache.js's key convention (lib/cache.js:69-72) asks for: this is the
 * *default* load of the graph page, `id`-less, so the key is spelled by code —
 * `graph:<workspace>` — and never by anything a request carries. The per-bead form
 * (`?id=`) is a different case, reaches into the same key space `BEAD_ID_RE` bounds
 * elsewhere, and stayed off this layer on purpose — see bc-1kwl.12's notes for the
 * three-way decision still open about it.
 *
 * 60 seconds, not the inbox's ten: this page is opened by hand, not polled, and the
 * sweep behind it is two orders of magnitude more expensive than anything else the
 * layer holds. It is also `Bd.graph`'s own long-standing window for the same shape of
 * call (`PARENT_TTL_MS` in lib/bd.js) — a precedent already settled on 60s for "how
 * fresh does bd's dependency graph need to be".
 */
export const GRAPH_FRESH_MS = 60_000;
const GRAPH_PREFIX = 'graph:';
export const graphKey = (name) => `${GRAPH_PREFIX}${name}`;

/** The two bd calls the workspace-wide graph page needs, bundled as one cache value. */
async function sweepWorkspaceGraph(bd, ws) {
  const [html, rows] = await Promise.all([
    bd.graphHtml(ws, null),
    // The annotation is a bonus, not the payload: a list that fails still leaves a
    // drawable graph, with every node simply undated and unmarked. Losing the whole
    // graph over it would be a bad trade.
    bd.listStatus(ws, 'open,in_progress,blocked').catch(() => []),
  ]);
  return { html, rows };
}

/**
 * `{ html, rows }` for one workspace's whole graph, and how old that answer is — the
 * envelope, not the pair. `refresh` reaches the layer unchanged: skip what is kept,
 * pay the cost, the caller asked.
 */
export const workspaceGraph = (bd, ws, { refresh = false } = {}) =>
  cache.read(graphKey(ws.name), () => sweepWorkspaceGraph(bd, ws), { freshMs: GRAPH_FRESH_MS, refresh });

/**
 * Fill each workspace's graph key if nothing is kept for it, and never otherwise.
 * bc-1kwl.12, on the shape bc-1kwl.4 built for exactly this — `warmBoard`
 * (lib/prboard.js) and `endorsequeue.warm`.
 *
 * **Cold-only, not the `moved`-gated shape `WARMABLES` uses in lib/server.js.** Those
 * keys are cheap enough (~1s) that re-sweeping them whenever a workspace's tracker
 * moves is a fair trade. A graph sweep is two orders of magnitude more expensive, so
 * warming it on the same gate would mean re-running a multi-second-to-two-minute `bd`
 * call every time anyone touched a busy workspace — exactly the daemon-load-with-
 * nobody-looking cost bc-1kwl.5 exists to hold down. So this asks only "is anything
 * kept for this workspace's graph at all?" — true at boot and after any invalidation,
 * false forever after that, on however old the answer gets.
 *
 * Sequential across workspaces, like every other pass `warmKeys` runs: a graph sweep
 * queues behind Dolt's single writer the same as any other `bd` call, so running these
 * concurrently would only make the first ones slower. Returns the workspaces it
 * filled, for the log line and for the suite.
 */
export async function warmGraphs(bd, workspaces) {
  const filled = [];
  for (const ws of workspaces) {
    if (cache.peek(graphKey(ws.name))) continue;
    await workspaceGraph(bd, ws).catch(() => {});
    filled.push(ws.name);
  }
  return filled;
}
