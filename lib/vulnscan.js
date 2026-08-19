/**
 * Dependency scanning, on a remediation clock — the other half of CC7.1.
 *
 * An incident is something that happened. A vulnerability is something that has not
 * happened yet and is sitting in `node_modules` waiting to, which is why it is scanned
 * for rather than reported. `npm audit` has been in the box the whole time; what it has
 * never had is a **deadline**, and a deadline is the entire difference between "we scan
 * our dependencies" and a control.
 *
 * **THE BEAD IS THE RECORD, AND ITS `created_at` IS THE CLOCK.** There is no state file
 * of first-seen dates, and that is the design rather than a shortcut. A remediation SLA
 * measured against a file this repo writes is measured against a file this repo can
 * rewrite; measured against a bead in the tracker it is measured against something with a
 * history, that somebody had to close, in a graph nobody edits by hand. So one advisory
 * against one package is one bead: filed the first time a scan sees it, closed when a
 * scan no longer does, and its age is how long the advisory has been open here.
 *
 * That reuses everything: the same tracker, the same board, the same advocate that would
 * pick it up. And it means the evidence question — "were the criticals fixed inside seven
 * days, in this period" — is answered by reading `created_at` and `closed_at` off beads
 * nobody was maintaining for the audit. Same argument as lib/incident.js, and for the
 * same reason.
 *
 * **Nothing in here writes.** `scan` runs `npm audit`, `reconcile` says what *would* be
 * filed and closed, and the caller decides. That split is what lets the whole of it be
 * tested against a fixture with no tracker anywhere near it, and it is why the sweep that
 * runs this can be a dozen lines.
 *
 * **Which criterion this is** is {@link CRITERIA}, in lib/controls.js's ids and without
 * importing it — the same leaf discipline lib/incident.js keeps, and the reason the one
 * thing borrowed from that module is a validator rather than a table. `SOC2.CC7.1` is
 * shared with nothing else in this repo: lib/incident.js explicitly does not claim it,
 * because the half of CC7.1 anybody here performs is this scan.
 */
import { execFile } from 'node:child_process';

import { crosswalkProblems } from './incident.js';

/** The class label. `bd list --label vulnerability` is the vulnerability register. */
export const VULN_LABEL = 'vulnerability';

/** `vulnpkg:<slug>` — which package a bead is about, and the key a scan matches on. */
export const PKG_PREFIX = 'vulnpkg:';

/**
 * **What this scan answers, in the corpus's ids.**
 *
 * One row, and the narrowness is the honest part. CC7.1 asks for a configuration baseline
 * *and* for newly disclosed vulnerabilities to be found; this finds the second kind, in
 * this repo's dependencies, on a deadline. The baseline half of CC7.1 — for the described
 * system, over a host estate this repo has never seen — is a Climative-held gap, and
 * lib/gapassessment.js is where that row lives. Claiming the whole criterion from a
 * `npm audit` wrapper is the shape of an overstatement an auditor finds in an afternoon.
 */
export const CRITERIA = Object.freeze([
  Object.freeze({
    id: 'SOC2.CC7.1',
    by: 'scan, reconcile, vulnClock',
    how:
      'npm audit is run against this repo\'s dependencies, each advisory becomes one bead per package, and its ' +
      'age against SLA_DAYS is read off the bead\'s created_at and closed_at. The remediation deadline is what ' +
      'turns "we scan our dependencies" into a control, and vulnEvidence answers whether it was met in a period.',
  }),
]);

{
  const problems = crosswalkProblems(CRITERIA, 'lib/vulnscan.js');
  if (problems.length) throw new Error(`lib/vulnscan.js crosswalk is broken:\n  - ${problems.join('\n  - ')}`);
}

/**
 * **The remediation SLA, in days, by npm's own severity word.**
 *
 * npm's four are taken as they are rather than being re-scored locally. A local scoring
 * pass sounds more rigorous and is worse: it is a judgement made by whoever is looking at
 * it on the day, it is not reproducible a year later, and the number that matters to
 * anybody reading a report is the published one.
 *
 * `info` is deliberately absent — not zero, absent. An informational advisory has no
 * deadline because it is not a finding, and giving it a 365-day one would put a bead on
 * the board that exists only to be ignored.
 */
export const SLA_DAYS = { critical: 7, high: 30, moderate: 90, low: 180 };

/** Worst first — the order the register is read in, and the tie-break for a bead's priority. */
export const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

const DAY_MS = 86_400_000;

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** A package name as a label: `@babel/core` → `babel-core`. Labels have no quoting story. */
export function pkgSlug(name) {
  return oneLine(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

/** How long this severity gets, in days. `null` means it has no deadline and no bead. */
export function slaDays(severity, config = null) {
  const key = oneLine(severity).toLowerCase();
  const over = config?.incidents?.vulnerabilityDays || {};
  const raw = over[key] ?? SLA_DAYS[key];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : SLA_DAYS[key] ?? null;
}

/**
 * **One `npm audit --json` → the findings, one per package.**
 *
 * v2 is the only report version this parses, and an older or newer one is an empty list
 * with a `why` rather than a throw: this runs from a sweep, and an npm upgrade that
 * changed the schema must not be able to take the daemon down. The empty answer is
 * distinguishable from "clean" by that field, which is what stops it reading as evidence
 * of nothing being wrong.
 *
 * `via` is the awkward part of the shape: it holds advisory objects for a *direct*
 * finding and bare package-name strings for a transitive one ("this is vulnerable because
 * that is"). Both are kept — the titles are what make the bead readable, and the names are
 * what explain why a package you have never heard of is in the tree.
 */
export function parseAudit(report) {
  if (!report || typeof report !== 'object') return { findings: [], why: 'the audit produced no JSON' };
  if (Number(report.auditReportVersion) !== 2) {
    return { findings: [], why: `unrecognised audit report version ${report.auditReportVersion ?? '(none)'}` };
  }
  const vulns = report.vulnerabilities && typeof report.vulnerabilities === 'object' ? report.vulnerabilities : {};
  const findings = [];
  for (const [name, entry] of Object.entries(vulns)) {
    if (!entry || typeof entry !== 'object') continue;
    const via = Array.isArray(entry.via) ? entry.via : [];
    const advisories = via
      .filter((v) => v && typeof v === 'object')
      .map((v) => ({
        title: oneLine(v.title),
        url: oneLine(v.url),
        severity: oneLine(v.severity).toLowerCase(),
        cvss: Number(v?.cvss?.score) || null,
      }));
    const through = via.filter((v) => typeof v === 'string').map(oneLine);
    findings.push({
      name: oneLine(entry.name) || oneLine(name),
      severity: oneLine(entry.severity).toLowerCase() || 'info',
      direct: Boolean(entry.isDirect),
      range: oneLine(entry.range),
      through,
      advisories,
      // `fixAvailable` is `true`, `false`, or an object naming the upgrade — and the
      // object is the interesting one, because `isSemVerMajor` is the difference between
      // a fix that is an `npm audit fix` and a fix that is a day's work.
      fix:
        entry.fixAvailable && typeof entry.fixAvailable === 'object'
          ? {
              name: oneLine(entry.fixAvailable.name),
              version: oneLine(entry.fixAvailable.version),
              major: Boolean(entry.fixAvailable.isSemVerMajor),
            }
          : entry.fixAvailable === true
            ? { name: '', version: '', major: false }
            : null,
    });
  }
  findings.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.name.localeCompare(b.name)
  );
  return { findings, why: '' };
}

/**
 * Run the scan. **Never rejects, and a non-zero exit is the normal case.**
 *
 * `npm audit` exits 1 when it found something, which is exactly when its output matters
 * most — a caller that treated the exit code as failure would throw away every report
 * that had anything in it and keep only the clean ones. So the code is ignored entirely
 * and stdout is what is read; the only real failure is stdout that will not parse, and
 * that comes back as `{ ok: false, why }` rather than a throw, because this runs from a
 * sweep and lib/crash.js should not be filing a bead about the vulnerability scanner.
 */
export function scan({ cwd = process.cwd(), npmBin = 'npm', timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      npmBin,
      ['audit', '--json'],
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout) => {
        const text = String(stdout || '').trim();
        if (!text) {
          resolve({ ok: false, why: oneLine(err?.message) || 'npm audit printed nothing', findings: [] });
          return;
        }
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (parseErr) {
          resolve({ ok: false, why: `npm audit printed something that is not JSON: ${oneLine(parseErr.message)}`, findings: [] });
          return;
        }
        const parsed = parseAudit(json);
        resolve({ ok: !parsed.why, why: parsed.why, findings: parsed.findings, metadata: json.metadata || null });
      }
    );
  });
}

/** The bead one finding becomes, the first time a scan sees it. */
export function vulnBead(finding, config = null) {
  const days = slaDays(finding.severity, config);
  const worst = finding.advisories.slice().sort((a, b) => (b.cvss || 0) - (a.cvss || 0))[0] || null;
  const fix = finding.fix
    ? finding.fix.version
      ? `\`${finding.fix.name || finding.name}@${finding.fix.version}\`${finding.fix.major ? ' — **a major version bump**, so it is not `npm audit fix`' : ''}`
      : 'yes, according to npm'
    : '**no fix is published yet** — which does not stop the clock; it changes what closing this looks like';
  return {
    title: `${finding.severity} advisory in ${finding.name}${worst?.title ? ` — ${worst.title}` : ''}`.slice(0, 140),
    type: 'task',
    priority: finding.severity === 'critical' ? 1 : finding.severity === 'high' ? 1 : 2,
    labels: [VULN_LABEL, `${PKG_PREFIX}${pkgSlug(finding.name)}`, `vulnsev:${finding.severity}`],
    description: [
      `\`npm audit\` reports a **${finding.severity}** advisory against \`${finding.name}\`${finding.range ? ` (${finding.range})` : ''}.`,
      '',
      '| | |',
      '|---|---|',
      `| **Severity** | ${finding.severity} |`,
      `| **Remediate within** | ${days == null ? 'no deadline — informational' : `${days} days of this bead being filed`} |`,
      `| **How it got here** | ${finding.direct ? 'a direct dependency' : `pulled in through ${finding.through.slice(0, 6).join(', ') || 'another package'}`} |`,
      `| **Fix available** | ${fix} |`,
      ...(worst?.url ? [`| **Advisory** | ${worst.url} |`] : []),
      '',
      finding.advisories.length > 1
        ? `${finding.advisories.length} advisories are open against this package: ${finding.advisories.map((a) => a.title || a.url).filter(Boolean).join('; ')}.`
        : '',
      '',
      '_Filed by the dependency scan, and closed by it: the next scan that no longer sees this package closes this ' +
        'bead. The days between the two are the remediation time, and they are the evidence — see lib/vulnscan.js._',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    acceptance: `\`npm audit\` no longer reports ${finding.name}${days == null ? '' : `, within ${days} days`}.`,
    rationale: 'Found by the dependency scan. Detection and recording are the same act here, as they are for an error.',
  };
}

/** Which package a vulnerability bead is about, from its labels. */
export function pkgOf(row) {
  const label = (row?.labels || []).find((l) => String(l).startsWith(PKG_PREFIX));
  return label ? String(label).slice(PKG_PREFIX.length) : '';
}

const stamp = (value) => {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
};

/**
 * One vulnerability bead → its remediation clock.
 *
 * Three-valued, exactly as `clockFor` in lib/incident.js is and for the same reason: an
 * advisory filed yesterday with seven days to run has neither met nor missed anything,
 * and a period report that counted it as missed would show a breach every time it was run
 * on a Monday.
 *
 * The severity is read off the bead's own `vulnsev:` label rather than re-scanned. A
 * finding can be re-scored upstream after the bead is filed, and the deadline that was
 * committed to is the one that was in force when it was detected — re-scoring a live
 * finding into a longer SLA is how a breach disappears.
 */
export function vulnClock(row = {}, { now = Date.now(), config = null } = {}) {
  const sevLabel = (row.labels || []).find((l) => String(l).startsWith('vulnsev:'));
  const severity = sevLabel ? String(sevLabel).slice('vulnsev:'.length) : 'info';
  const days = slaDays(severity, config);
  const found = stamp(row.created_at);
  const fixed = stamp(row.closed_at) ?? (row.status === 'closed' ? stamp(row.updated_at) : null);
  const due = found == null || days == null ? null : found + days * DAY_MS;
  const met = due == null ? null : fixed != null ? fixed <= due : now > due ? false : null;
  return {
    id: row.id || '',
    title: row.title || '',
    package: pkgOf(row),
    severity,
    days,
    found,
    fixed,
    due,
    daysOpen: found == null ? null : Math.max(0, Math.round(((fixed ?? now) - found) / DAY_MS)),
    met,
    overdue: met === false,
    open: fixed == null,
  };
}

/**
 * **What the scan and the tracker disagree about** — the whole of what a sweep would do.
 *
 * Three answers, and the middle one is the one that is easy to leave out: a package that
 * has stopped appearing in the audit has been remediated, and a register that only ever
 * files is a register that grows for ever and evidences nothing. Closing it is what puts
 * a `closed_at` on the bead, and `closed_at` is the entire measurement.
 *
 * Matching is by package slug and nothing else. Not by advisory id — a package with two
 * advisories against it is one upgrade and one bead, and splitting it would file a second
 * bead every time a new advisory landed against a package already on the board.
 */
export function reconcile(findings = [], rows = [], { now = Date.now(), config = null } = {}) {
  const live = (rows || []).filter((r) => r && r.status !== 'closed');
  const bySlug = new Map();
  for (const row of live) {
    const slug = pkgOf(row);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, row);
  }
  const seen = new Set();
  const file = [];
  for (const f of findings) {
    const slug = pkgSlug(f.name);
    seen.add(slug);
    // No deadline, no bead. An informational advisory is not a finding, and a board full
    // of beads nobody will ever action is how the ones that matter stop being read.
    if (slaDays(f.severity, config) == null) continue;
    if (bySlug.has(slug)) continue;
    file.push({ finding: f, bead: vulnBead(f, config) });
  }
  const close = [];
  for (const [slug, row] of bySlug) {
    if (seen.has(slug)) continue;
    const clock = vulnClock(row, { now, config });
    close.push({
      id: row.id,
      package: slug,
      reason: `\`npm audit\` no longer reports it — remediated in ${clock.daysOpen ?? '?'} days against a ${clock.days ?? '?'}-day SLA.`,
      clock,
    });
  }
  const overdue = live.map((r) => vulnClock(r, { now, config })).filter((c) => c.overdue);
  return { file, close, overdue };
}

/**
 * The evidence: of the advisories found in a period, how many were remediated in time.
 *
 * Bounded by *detection*, like `periodEvidence` in lib/incident.js — an advisory belongs
 * to the period it appeared in, not the period somebody got round to it, or a slow month
 * could be moved out of the window by being slower.
 */
export function vulnEvidence(clocks = [], { from = null, to = null } = {}) {
  const lo = from == null ? -Infinity : typeof from === 'number' ? from : Date.parse(from);
  const hi = to == null ? Infinity : typeof to === 'number' ? to : Date.parse(to);
  const inPeriod = clocks.filter((c) => c.found != null && c.found >= lo && c.found <= hi);
  const bySeverity = {};
  for (const s of SEVERITY_ORDER) {
    const n = inPeriod.filter((c) => c.severity === s).length;
    if (n) bySeverity[s] = n;
  }
  return {
    from: lo === -Infinity ? null : lo,
    to: hi === Infinity ? null : hi,
    total: inPeriod.length,
    bySeverity,
    remediation: {
      met: inPeriod.filter((c) => c.met === true).length,
      missed: inPeriod.filter((c) => c.met === false).length,
      pending: inPeriod.filter((c) => c.met === null).length,
    },
    open: inPeriod.filter((c) => c.open).length,
    overdue: inPeriod.filter((c) => c.overdue).length,
  };
}
