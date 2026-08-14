/**
 * How much of the requirement graph is actually there — said out loud, per token.
 *
 * The failure that sinks a graph like this is not being wrong. It is being **partial while
 * reading as complete**: a screen that lists requirements and files, with no indication
 * that four fifths of the corpus has no edge at all, is a screen that gets used as an
 * index of the codebase and is silently wrong about everything it omits. Coverage here
 * will be partial for as long as this feature exists, because an edge is only created when
 * a merge lands naming a requirement — so the honest number has to be as prominent as the
 * data it qualifies.
 *
 * Three numbers per token, and each answers a different question:
 *
 * - **covered** — how many of this product's requirements have any edge at all. The
 *   headline, and the one that starts near zero and stays low.
 * - **observed** — how many are backed by a merge that actually happened, as opposed to
 *   something an advocate forecast. This is the number worth trusting; `declared`
 *   inflates the first one.
 * - **stub** — requirements in the corpus with no definition written yet
 *   (`IBR.fuel-type-x`). Counted separately so a token that is 0% covered because nobody
 *   has written it down is not confused with one that is 0% covered because nothing has
 *   shipped.
 *
 * And the measurement that decides whether any of this was worth building is not here: it
 * is whether the *reverse* lookup (lib/reqbrief.js) ever hands a session something it acts
 * on. Coverage says how much there is to read. Nothing says whether anybody read it, and
 * the honest thing is to admit that rather than to invent a proxy.
 *
 * Pure. `graph` is `everything()` from lib/reqindex.js, `corpus` is `loadCorpus`, and the
 * whole thing is a fold over two maps — so the console, the CLI and the test all compute
 * the same numbers from the same two inputs.
 */

/** The provenances, in the order a reader weighs them. Mirrors lib/reqindex.js. */
const ORDER = ['human-confirmed', 'observed-from-diff', 'declared'];

const strongest = (edges = []) => ORDER.find((p) => edges.some((e) => e.provenance === p)) || null;

/**
 * `{ tokens, totals, orphans }` — the whole picture from the corpus and the graph.
 *
 * `orphans` is edges recorded against ids the corpus does not have. It should be empty and
 * it is reported anyway: an id can leave the corpus (renamed, deleted, a file moved) long
 * after edges were recorded against it, and an orphan is the only visible symptom. Hiding
 * it would make a rename look like a requirement that was never implemented.
 */
export function coverage(corpus, graph = {}) {
  const byToken = new Map();
  const ids = corpus?.ids || new Map();

  for (const entry of ids.values()) {
    if (!byToken.has(entry.token)) {
      byToken.set(entry.token, { token: entry.token, total: 0, stub: 0, covered: 0, observed: 0, confirmed: 0, edges: 0 });
    }
    const t = byToken.get(entry.token);
    t.total += 1;
    if (entry.stub) t.stub += 1;
  }

  const orphans = [];
  for (const [id, edges] of Object.entries(graph)) {
    const entry = ids.get(id);
    if (!entry) {
      orphans.push({ id, edges: edges.length });
      continue;
    }
    const t = byToken.get(entry.token);
    if (!t || !edges.length) continue;
    t.covered += 1;
    t.edges += edges.length;
    const best = strongest(edges);
    if (best === 'human-confirmed') t.confirmed += 1;
    if (best === 'human-confirmed' || best === 'observed-from-diff') t.observed += 1;
  }

  const tokens = [...byToken.values()].sort((a, b) => b.covered - a.covered || a.token.localeCompare(b.token));
  const totals = tokens.reduce(
    (acc, t) => ({
      total: acc.total + t.total,
      stub: acc.stub + t.stub,
      covered: acc.covered + t.covered,
      observed: acc.observed + t.observed,
      confirmed: acc.confirmed + t.confirmed,
      edges: acc.edges + t.edges,
    }),
    { total: 0, stub: 0, covered: 0, observed: 0, confirmed: 0, edges: 0 }
  );
  return { tokens, totals, orphans: orphans.sort((a, b) => b.edges - a.edges) };
}

/**
 * One line a person can read, for the CLI and the log.
 *
 * States the denominator every time. "41 edges" alone is a number that sounds like
 * progress; "18 of 335 requirements carry an edge" is the same fact and cannot be
 * mistaken for coverage.
 */
export function describeCoverage({ totals, orphans = [] } = {}) {
  if (!totals?.total) return 'no requirements corpus is readable here';
  const pct = totals.total ? Math.round((totals.covered / totals.total) * 100) : 0;
  const parts = [
    `${totals.covered} of ${totals.total} requirements carry an edge (${pct}%)`,
    `${totals.observed} backed by a merge`,
    `${totals.edges} edge${totals.edges === 1 ? '' : 's'} in all`,
  ];
  if (totals.stub) parts.push(`${totals.stub} with no definition written yet`);
  if (orphans.length) parts.push(`${orphans.length} recorded against ids the corpus no longer has`);
  return parts.join(' · ');
}
