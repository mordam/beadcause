#!/usr/bin/env node
//
// What the control graph cannot evidence, said out loud — bc-eqn1.3.
//
//   npm test                          (runs it alongside the other suites)
//   node test/controlcoverage.mjs     (on its own)
//
// Pure, so this is arithmetic over a fixture graph and needs no repo, no config directory
// and no clock of its own — `coverage` takes `now`, which is what lets a staleness boundary
// be tested without waiting a year for one.
//
// Five properties:
//
// 1. **The denominator is the whole corpus**, not the ids in the graph. A coverage report
//    computed over what it happens to know is a report that reads as complete however
//    little it holds, which is the failure lib/reqcoverage.js was written to prevent and
//    the one an auditor is paid to find.
// 2. **Forecast is never counted as proof.** A `declared` edge is a bead saying it would;
//    only a merge or a person makes it evidence.
// 3. **The three findings are disjoint.** A control is unevidenced, forecast-only, stale
//    or current — never two of them. A finding counted twice is a finding closed twice.
// 4. **Guidance is never stale.** Nobody is certified against ISO/IEC 23894, 42005 or
//    5338, so a staleness finding on one would be a finding against a document that makes
//    no claim. `certifiable: false` is the flag, and it is lib/controls.js's, not a second
//    opinion here.
// 5. **An orphan is reported rather than hidden.** An id can leave the corpus long after
//    edges were recorded against it, and hiding that would make a rename read as a control
//    that was never exercised.
import { coverage, describeCoverage, REVIEW_MONTHS, STATES } from '../lib/controlcoverage.js';
import { corpus, FRAMEWORKS } from '../lib/controls.js';

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const NOW = new Date('2026-08-24T12:00:00Z');
const ago = (months, days = 0) => {
  const d = new Date(NOW.getTime());
  d.setMonth(d.getMonth() - months);
  d.setDate(d.getDate() - days);
  return d.toISOString();
};

const edge = (provenance, at, extra = {}) => ({
  commit: 'abc1234',
  repo: '/tmp/repo',
  bead: 'bc-1',
  workspace: 'beadcause',
  files: ['lib/auth.js'],
  provenance,
  at,
  ...extra,
});

/* -------------------------------------------------------------- the denominator */

console.log('the denominator is the corpus, not the graph');

const empty = coverage({}, { now: NOW });
const size = corpus().size;
check('an empty graph still counts every control', empty.totals.total === size, `${empty.totals.total} of ${size}`);
check('and every one of them is a finding by name', empty.unevidenced.length === size, String(empty.unevidenced.length));
check('nothing is proved', empty.totals.proved === 0 && empty.totals.covered === 0);
check('the sentence leads with the denominator', describeCoverage(empty).includes(`of ${size} controls`), describeCoverage(empty));
check(
  'and every framework is a row even with nothing recorded',
  empty.frameworks.length === Object.keys(FRAMEWORKS).length && empty.frameworks.every((f) => f.total > 0),
  JSON.stringify(empty.frameworks.map((f) => [f.token, f.total]))
);

/* --------------------------------------------------------- forecast versus proof */

console.log('\nforecast is not proof');

const graph = {
  'SOC2.CC6.1': [edge('observed-from-diff', ago(1))],
  'SOC2.CC7.2': [edge('declared', ago(1))],
  'ISO27001.A.8.3': [edge('human-confirmed', ago(5))],
  'ISO42001.A.6.2.8': [edge('observed-from-diff', ago(18))],
  'ISO5338.Technical.Verification': [edge('observed-from-diff', ago(30))],
  'SOC2.CC9.9': [edge('observed-from-diff', ago(1))],
};
const cov = coverage(graph, { now: NOW });

check('a merge is proof', cov.totals.proved === 4, String(cov.totals.proved));
check('a forecast is covered but not proved', cov.totals.forecast === 1 && cov.totals.covered === 5, JSON.stringify(cov.totals));
check('and it is a finding with a name on it', cov.forecastOnly.map((f) => f.id).join(',') === 'SOC2.CC7.2', JSON.stringify(cov.forecastOnly));
check('a person confirming counts as proof too', !cov.forecastOnly.some((f) => f.id === 'ISO27001.A.8.3'));
check('the sentence says both numbers', describeCoverage(cov).includes('1 forecast and not yet proved'), describeCoverage(cov));

/* --------------------------------------------------------------- the review clock */

console.log('\nevidence has a shelf life');

check('the window is a year unless somebody says otherwise', cov.reviewMonths === REVIEW_MONTHS && REVIEW_MONTHS === 12);
check('proof from eighteen months ago is stale', cov.stale.map((s) => s.id).join(',') === 'ISO42001.A.6.2.8', JSON.stringify(cov.stale));
check('and it says how far past the window it is', cov.stale[0]?.days > 150, JSON.stringify(cov.stale[0]));
check('proof from last month is not', cov.totals.current === 3, String(cov.totals.current));
check(
  'guidance is never stale, however old its evidence — nobody is certified against it',
  !cov.stale.some((s) => s.id.startsWith('ISO5338.')),
  JSON.stringify(cov.stale)
);

const quarter = coverage(graph, { now: NOW, reviewMonths: 3 });
check('a shorter window is a report over a shorter period, not a different corpus', quarter.totals.total === size);
check(
  'and it finds more — five-month-old proof is current over a year and stale over a quarter',
  quarter.stale.map((s) => s.id).sort().join(',') === 'ISO27001.A.8.3,ISO42001.A.6.2.8',
  JSON.stringify(quarter.stale.map((s) => s.id))
);
check('a nonsense window falls back to the default rather than to zero', coverage(graph, { now: NOW, reviewMonths: -4 }).reviewMonths === REVIEW_MONTHS);

/* ------------------------------------------------------------------- disjointness */

console.log('\nthe findings do not overlap');

const named = [...cov.unevidenced, ...cov.forecastOnly.map((f) => f.id), ...cov.stale.map((s) => s.id)];
check('no control is two findings at once', new Set(named).size === named.length, String(named.length - new Set(named).size));
check(
  'and the four states account for every control exactly once',
  cov.totals.unevidenced + cov.totals.forecast + cov.totals.stale + cov.totals.current === size,
  JSON.stringify(cov.totals)
);

// The reason disjointness holds is structural rather than asserted: there is one row per
// control with one `state` on it, and the four lists are that row-set filtered. A count
// that disagreed with its own list is the specific way a compliance report stops being
// believed, so the register and the findings are checked against each other here.
console.log('\none row per control, and the findings are a view of it');

check('there is a row for every control and no more', cov.controls.length === size, String(cov.controls.length));
check('each carries exactly one state', cov.controls.every((r) => STATES.includes(r.state)));
check(
  'and every finding list is that register filtered',
  cov.unevidenced.length === cov.controls.filter((r) => r.state === 'unevidenced').length &&
    cov.stale.length === cov.controls.filter((r) => r.state === 'stale').length &&
    cov.forecastOnly.length === cov.controls.filter((r) => r.state === 'forecast').length
);
check(
  'a row carries the name a screen needs beside a finding',
  cov.controls.every((r) => r.title.length > 0 && r.kind.length > 0),
  JSON.stringify(cov.controls.find((r) => !r.title))
);
check(
  'and not the definition, which is a paragraph 192 times over',
  cov.controls.every((r) => !('definition' in r))
);
check(
  'the per-control edge count is the graph, not a second tally',
  cov.controls.find((r) => r.id === 'SOC2.CC6.1').edges === 1 &&
    cov.controls.find((r) => r.id === 'SOC2.CC9.2').edges === 0
);

/* ----------------------------------------------------------------------- orphans */

console.log('\nan edge pointing at nothing');

check('an id the corpus no longer has is reported', cov.orphans.map((o) => o.id).join(',') === 'SOC2.CC9.9', JSON.stringify(cov.orphans));
check('and it is not counted as coverage of anything', cov.totals.covered === 5, String(cov.totals.covered));
check('the sentence mentions it', describeCoverage(cov).includes('the corpus no longer has'), describeCoverage(cov));
check('a graph with no orphans says nothing about them', !describeCoverage(coverage({}, { now: NOW })).includes('no longer has'));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
