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
 */
import { PHASES } from './activity.js';
import { shortActor } from './work.js';

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
 * Edges that are not a bead waiting on anything.
 *
 * The same split the sheet makes over `bd show --json`'s `dependencies[]`
 * (`relations`, public/graph.js): `parent-child` is where a bead *sits*, not what
 * it is stuck behind, and neither `discovered-from` nor `related` blocks anything.
 * An edge type nobody here has seen still counts, which leaves this on the same
 * side as bd's own number for anything new rather than silently hiding it.
 */
const NOT_WAITING = new Set(['parent-child', 'discovered-from', 'related']);

/**
 * How many live blockers each node has, counted off the edges bd itself drew.
 *
 * `bd list`'s `dependency_count` cannot answer this, and it is wrong twice over.
 * It counts the edge to a bead's **parent**, so every subtask arrived here
 * claiming to wait on something when the only edge it had was the one to the epic
 * above it; and it counts blockers that have since closed. bc-l8jp.7's three
 * "dependencies" were one live blocker, one closed one, and its parent.
 *
 * The links carry a `type`, so the count can be made of exactly the edges the
 * phrase on the card means. A closed source is skipped because a closed blocker
 * has stopped blocking — which also makes the two graphs agree: `bd graph --html
 * <id>` reaches into closed neighbours and draws their edges, where `--all`
 * prunes both, so the same bead would otherwise wait on more in the scoped view
 * than in the whole-workspace one.
 *
 * A graph whose `links` did not parse reports nobody waiting on anything, rather
 * than falling back to the count this exists to replace. That is the direction to
 * fail in: a bead that says it waits on something it does not is worse than one
 * that says nothing.
 */
function blockerCounts({ nodes, links }) {
  const closed = new Set();
  for (const n of nodes || []) if (n && n.status === 'closed') closed.add(n.id);
  const counts = new Map();
  for (const l of links || []) {
    if (!l || NOT_WAITING.has(l.type) || closed.has(l.source)) continue;
    counts.set(l.target, (counts.get(l.target) || 0) + 1);
  }
  return counts;
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
  const waiting = blockerCounts(graph);

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
      blocks: r.dependent_count ?? null,
      // Not from the list row: the graph's own edges, for the reasons on
      // `blockerCounts`. `blocks` above is still bd's number, and is wrong the same
      // way — a parent's children are counted among its dependents — but fixing it
      // is bc-cpzm, and the rows behind that pill on the sheet are bc-2ocm.
      waits: waiting.get(n.id) || 0,
      phase,
      icon: phase ? PHASES[phase]?.icon || '•' : null,
      detail: stored?.detail || '',
      moved: Boolean(updated && Date.parse(updated) >= cut),
    };
  });

  return { ...graph, nodes };
}
