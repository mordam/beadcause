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
 */

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
