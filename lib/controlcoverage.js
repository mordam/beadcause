/**
 * How much of the control corpus is actually evidenced — the internal-audit instrument.
 *
 * lib/reqcoverage.js exists because a requirement graph that reads as complete while it is
 * half covered is worse than no graph. The same is true here and the stakes are different
 * in kind: a requirement with no edge is a lookup that comes back empty, and a **control**
 * with no edge is a control nobody can show operated. An auditor's finding for the second
 * is not "your index is thin".
 *
 * So this answers four questions, and each of them is a finding somebody has to act on
 * rather than a number to admire:
 *
 * - **unevidenced** — every control with no edge at all. The list, not just the count,
 *   because "137 controls unevidenced" is a statistic and `SOC2.CC6.1` is a task.
 * - **forecastOnly** — controls whose only edges are `declared`. A bead said it would; no
 *   merge has shown it did. This is the one that quietly inflates every other number if the
 *   two provenances are added together, which is why lib/controlindex.js keeps them apart
 *   at the edge and why nothing here ever sums them.
 * - **stale** — controls that *are* proved, whose newest proof is older than the review
 *   period. Evidence from two years ago does not show a control operating now, and a
 *   programme with no clock reads as fully evidenced forever on the strength of one good
 *   quarter.
 * - **orphans** — edges recorded against ids the corpus no longer has. It should be empty
 *   and it is reported anyway: an id can leave the corpus long after edges were recorded
 *   against it, and an orphan is the only visible symptom. Hiding it would make a rename
 *   look like a control that was never exercised.
 *
 * ## The review period is one number, and guidance has none
 *
 * The tempting shape is a period per record — 192 numbers on 192 controls. Nobody would
 * choose those numbers; they would be copied down a column, and a field everybody copies is
 * a field that means nothing.
 *
 * What actually decides it is already on the framework. {@link REVIEW_MONTHS} is the
 * observation window — twelve months, the outside of what "operated throughout the period"
 * means for a SOC 2 Type II or an ISO surveillance year — and it applies to every record in
 * a **certifiable** framework. ISO/IEC 23894, 42005 and 5338 are guidance: nobody is
 * certified against them, nothing anybody signs cites them, and a "stale" finding on one
 * would be a finding against a document that makes no claim. `certifiable: false` on the
 * framework is the flag lib/controls.js already argued for, and reusing it is what stops
 * this file inventing a second, disagreeing opinion about what a guidance standard is.
 *
 * A caller may pass its own `reviewMonths`, because an observation window is a decision and
 * a report over a three-month window should measure against three months.
 *
 * ## Pure, and it takes its clock
 *
 * `graph` is `everything()` from lib/controlindex.js and the corpus is imported, because
 * unlike lib/reqcoverage.js there is no install where it might be missing. `now` is a
 * parameter so a suite can measure a staleness boundary without waiting a year for one.
 */
import { corpus, FRAMEWORKS, FRAMEWORK_TOKENS } from './controls.js';
import { PROVING } from './controlindex.js';

/** The observation window, in months. See the header: one number, and guidance has none. */
export const REVIEW_MONTHS = 12;

/** The provenances, in the order a reader weighs them. Mirrors lib/controlindex.js. */
const ORDER = ['human-confirmed', 'observed-from-diff', 'declared'];

const strongest = (edges = []) => ORDER.find((p) => edges.some((e) => e.provenance === p)) || null;

/** The newest edge that is evidence rather than intention, or null. */
function newestProof(edges = []) {
  let best = null;
  for (const e of edges) {
    if (!PROVING.includes(e.provenance)) continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    if (!best || at > best.at) best = { at, edge: e };
  }
  return best;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `now` minus `months`, as a timestamp. Calendar months, so a twelve-month window is the
 * same date last year rather than 365 days — which is what "annually" means to the person
 * who set the period, and what lib/documents.js's `addMonths` already assumes.
 */
function backTo(now, months) {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

/**
 * The whole picture — `{ frameworks, totals, unevidenced, forecastOnly, stale, orphans }`.
 *
 * The four lists are disjoint by construction and that is deliberate: a control appears in
 * exactly one of unevidenced, forecastOnly and stale, or in none of them because it is
 * proved and current. A control counted in two places is a finding somebody closes twice.
 */
export function coverage(graph = {}, { now = new Date(), reviewMonths = REVIEW_MONTHS } = {}) {
  const c = corpus();
  const months = Number.isInteger(reviewMonths) && reviewMonths > 0 ? reviewMonths : REVIEW_MONTHS;
  const cutoff = backTo(now instanceof Date ? now : new Date(now), months);

  const byFramework = new Map(
    FRAMEWORK_TOKENS.map((token) => [
      token,
      {
        token,
        name: FRAMEWORKS[token].name,
        certifiable: FRAMEWORKS[token].certifiable,
        total: 0,
        covered: 0,
        proved: 0,
        forecast: 0,
        stale: 0,
        current: 0,
        unevidenced: 0,
        edges: 0,
      },
    ])
  );
  for (const record of c.ids.values()) byFramework.get(record.framework).total += 1;

  const unevidenced = [];
  const forecastOnly = [];
  const stale = [];
  const orphans = [];

  for (const [id, edges] of Object.entries(graph)) {
    if (!c.ids.has(id)) orphans.push({ id, edges: (edges || []).length });
  }

  for (const record of c.ids.values()) {
    const row = byFramework.get(record.framework);
    const edges = graph[record.id] || [];
    if (!edges.length) {
      row.unevidenced += 1;
      unevidenced.push(record.id);
      continue;
    }
    row.covered += 1;
    row.edges += edges.length;
    const proof = newestProof(edges);
    if (!proof) {
      row.forecast += 1;
      forecastOnly.push({ id: record.id, at: strongestAt(edges), provenance: strongest(edges) });
      continue;
    }
    row.proved += 1;
    // Guidance is never stale: nobody is certified against it, so there is no period it
    // could have fallen out of. The flag is lib/controls.js's, not a second opinion here.
    if (!FRAMEWORKS[record.framework].certifiable) {
      row.current += 1;
      continue;
    }
    if (proof.at < cutoff) {
      row.stale += 1;
      stale.push({
        id: record.id,
        at: proof.edge.at,
        days: Math.round((cutoff - proof.at) / DAY_MS),
        commit: proof.edge.commit,
      });
      continue;
    }
    row.current += 1;
  }

  const frameworks = [...byFramework.values()];
  const totals = frameworks.reduce(
    (acc, f) => ({
      total: acc.total + f.total,
      covered: acc.covered + f.covered,
      proved: acc.proved + f.proved,
      forecast: acc.forecast + f.forecast,
      stale: acc.stale + f.stale,
      current: acc.current + f.current,
      unevidenced: acc.unevidenced + f.unevidenced,
      edges: acc.edges + f.edges,
    }),
    { total: 0, covered: 0, proved: 0, forecast: 0, stale: 0, current: 0, unevidenced: 0, edges: 0 }
  );

  return {
    reviewMonths: months,
    frameworks,
    totals,
    unevidenced: unevidenced.sort(),
    forecastOnly: forecastOnly.sort((a, b) => a.id.localeCompare(b.id)),
    stale: stale.sort((a, b) => b.days - a.days || a.id.localeCompare(b.id)),
    orphans: orphans.sort((a, b) => b.edges - a.edges || a.id.localeCompare(b.id)),
  };
}

/** The `at` of the strongest edge, for a control that has no proof at all. */
function strongestAt(edges) {
  const best = strongest(edges);
  return edges.find((e) => e.provenance === best)?.at || '';
}

/**
 * One line a person can read, for the CLI and the log.
 *
 * States the denominator every time, and states `proved` rather than `covered` as the
 * headline. "41 edges" sounds like progress; "9 of 192 controls are proved by a merge" is
 * the same fact and cannot be mistaken for a programme.
 */
export function describeCoverage({ totals, stale = [], orphans = [], reviewMonths = REVIEW_MONTHS } = {}) {
  if (!totals?.total) return 'no control corpus is readable here';
  const pct = Math.round((totals.proved / totals.total) * 100);
  const parts = [
    `${totals.proved} of ${totals.total} controls are proved by a merge (${pct}%)`,
    `${totals.forecast} forecast and not yet proved`,
    `${totals.unevidenced} with no evidence at all`,
  ];
  if (stale.length) parts.push(`${stale.length} whose newest proof is older than ${reviewMonths} months`);
  if (orphans.length) parts.push(`${orphans.length} recorded against ids the corpus no longer has`);
  return parts.join(' · ');
}
