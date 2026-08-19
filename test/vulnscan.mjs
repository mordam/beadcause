#!/usr/bin/env node
/**
 * A dependency advisory is a bead on a remediation clock.
 *
 *     npm test
 *     node test/vulnscan.mjs
 *
 * bc-4r10.9, the other half. `npm audit` has been in the box the whole time; what it has
 * never had is a deadline, and the deadline is the whole difference between "we scan our
 * dependencies" and a control.
 *
 * 1. **The v2 report parses, and anything else is an empty answer with a reason** —
 *    never a throw. This runs from a sweep, and an npm upgrade that changed the schema
 *    must not be able to take the daemon down; it must also not be able to look like a
 *    clean tree, which is what the `why` field is for.
 * 2. **The SLA is by npm's own severity word**, not re-scored locally. A local score is a
 *    judgement made on the day and it is not reproducible a year later.
 * 3. **`info` has no deadline and therefore no bead.** Not a 365-day one — a board full
 *    of beads nobody will ever action is how the ones that matter stop being read.
 * 4. **Reconciliation closes as well as files.** A package that has stopped appearing has
 *    been remediated, and `closed_at` is the entire measurement; a register that only
 *    ever files evidences nothing.
 * 5. **`met` is three-valued, exactly as it is for an incident.** An advisory filed
 *    yesterday with seven days to run has neither met nor missed anything.
 *
 * Nothing here runs `npm audit`, reaches the network or touches a real tracker.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-vulnscan-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { CRITERIA, PKG_PREFIX, SLA_DAYS, VULN_LABEL, parseAudit, pkgOf, pkgSlug, reconcile, slaDays, vulnBead, vulnClock, vulnEvidence } =
  await import(LIB('vulnscan.js'));
const { isControl } = await import(LIB('controls.js'));

const DAY = 86_400_000;
const T0 = Date.parse('2026-08-01T00:00:00Z');
const day = (n) => new Date(T0 + n * DAY).toISOString();

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

/** A v2 report shaped exactly as npm prints one, with the awkward parts kept. */
const REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    minimist: {
      name: 'minimist',
      severity: 'critical',
      isDirect: false,
      // The awkward part: advisory objects for a direct finding, bare strings for a
      // transitive one. Both shapes in one `via`, because npm really does that.
      via: [
        {
          source: 1179,
          name: 'minimist',
          title: 'Prototype Pollution in minimist',
          url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
          severity: 'critical',
          cvss: { score: 9.8 },
          range: '<0.2.1',
        },
        'mkdirp',
      ],
      effects: ['mkdirp'],
      range: '<0.2.1',
      nodes: ['node_modules/minimist'],
      fixAvailable: { name: 'mkdirp', version: '1.0.4', isSemVerMajor: true },
    },
    '@babel/traverse': {
      name: '@babel/traverse',
      severity: 'moderate',
      isDirect: true,
      via: [{ title: 'Something moderate', url: 'https://example.invalid/a', severity: 'moderate', cvss: { score: 5.1 } }],
      range: '<7.23.2',
      fixAvailable: true,
    },
    chatty: {
      name: 'chatty',
      severity: 'info',
      isDirect: true,
      via: [{ title: 'Nothing to do', severity: 'info' }],
      range: '*',
      fixAvailable: false,
    },
  },
  metadata: { vulnerabilities: { info: 1, low: 0, moderate: 1, high: 0, critical: 1, total: 3 } },
};

console.log('\na dependency advisory is a bead on a remediation clock\n');

await check('a v2 report parses into one finding per package, worst first', () => {
  const { findings, why } = parseAudit(REPORT);
  assert.equal(why, '');
  assert.deepEqual(findings.map((f) => f.name), ['minimist', '@babel/traverse', 'chatty']);
  const [worst] = findings;
  assert.equal(worst.severity, 'critical');
  assert.equal(worst.direct, false);
  assert.deepEqual(worst.through, ['mkdirp'], 'the bare strings say why a package you never chose is in the tree');
  assert.equal(worst.advisories[0].url, 'https://github.com/advisories/GHSA-xvch-5gv4-984h');
  assert.deepEqual(worst.fix, { name: 'mkdirp', version: '1.0.4', major: true }, 'a major bump is not `npm audit fix`');
  assert.deepEqual(findings[1].fix, { name: '', version: '', major: false }, 'and a bare true is still a fix');
  assert.equal(findings[2].fix, null);
});

await check('anything that is not a v2 report is an empty answer with a reason, never a throw', () => {
  for (const bad of [null, undefined, 'nonsense', 42, {}, { auditReportVersion: 3, vulnerabilities: { a: {} } }]) {
    const out = parseAudit(bad);
    assert.deepEqual(out.findings, []);
    assert.ok(out.why, `an empty list with no reason reads as a clean tree — ${JSON.stringify(bad)}`);
  }
  assert.equal(parseAudit({ auditReportVersion: 2, vulnerabilities: {} }).why, '', 'while genuinely clean says nothing');
});

await check('the SLA is npm’s own severity word, and info has no deadline at all', () => {
  assert.deepEqual(SLA_DAYS, { critical: 7, high: 30, moderate: 90, low: 180 });
  assert.equal(slaDays('critical'), 7);
  assert.equal(slaDays('info'), null, 'not 365 — an informational advisory is not a finding');
  assert.equal(slaDays('nonsense'), null);
  assert.equal(slaDays('high', { incidents: { vulnerabilityDays: { high: 14 } } }), 14, 'and it is configurable');
  assert.equal(slaDays('high', { incidents: { vulnerabilityDays: { high: 0 } } }), 30, 'but cannot be turned off');
});

await check('a package name becomes a label with no quoting story needed', () => {
  assert.equal(pkgSlug('@babel/traverse'), 'babel-traverse');
  assert.equal(pkgSlug('minimist'), 'minimist');
  assert.equal(pkgSlug(''), 'unnamed');
  assert.equal(pkgOf({ labels: [VULN_LABEL, `${PKG_PREFIX}babel-traverse`] }), 'babel-traverse');
  assert.equal(pkgOf({ labels: [] }), '');
});

await check('the bead says how it got here, whether there is a fix, and by when', () => {
  const { findings } = parseAudit(REPORT);
  const bead = vulnBead(findings[0]);
  assert.ok(bead.labels.includes(VULN_LABEL) && bead.labels.includes('vulnsev:critical'));
  assert.ok(bead.labels.includes(`${PKG_PREFIX}minimist`));
  assert.match(bead.description, /7 days/);
  assert.match(bead.description, /major version bump/, 'because that is the difference between a minute and a day');
  assert.match(bead.description, /pulled in through mkdirp/);
  assert.match(bead.acceptance, /npm audit no longer reports minimist|no longer reports minimist/);
});

/* --------------------------------------------------------------- reconciliation */

const row = (over = {}) => ({
  id: 'bc-v1',
  status: 'open',
  labels: [VULN_LABEL, `${PKG_PREFIX}minimist`, 'vulnsev:critical'],
  created_at: day(0),
  ...over,
});

await check('reconciliation files what is new, and files nothing twice', () => {
  const { findings } = parseAudit(REPORT);
  const fresh = reconcile(findings, [], { now: T0 });
  assert.deepEqual(fresh.file.map((f) => f.finding.name), ['minimist', '@babel/traverse'], 'and never the info one');
  const again = reconcile(findings, [row()], { now: T0 });
  assert.deepEqual(again.file.map((f) => f.finding.name), ['@babel/traverse'], 'the one already on the board is left alone');
});

await check('a package that has stopped appearing is closable, with how long it took', () => {
  const { findings } = parseAudit(REPORT);
  const gone = findings.filter((f) => f.name !== 'minimist');
  const plan = reconcile(gone, [row()], { now: T0 + 3 * DAY });
  assert.deepEqual(plan.close.map((c) => c.id), ['bc-v1']);
  assert.match(plan.close[0].reason, /3 days against a 7-day SLA/);
  assert.equal(plan.file.length, 1, 'and the other one is still owed a bead');
});

await check('a closed bead is not matched again, so a fixed-then-returned advisory files afresh', () => {
  const { findings } = parseAudit(REPORT);
  const closed = row({ status: 'closed', closed_at: day(2) });
  const plan = reconcile(findings, [closed], { now: T0 + 10 * DAY });
  assert.deepEqual(plan.file.map((f) => f.finding.name), ['minimist', '@babel/traverse']);
  assert.deepEqual(plan.close, [], 'and nothing tries to close what is already closed');
});

/* ------------------------------------------------------------------- the clock */

await check('the remediation clock is three-valued, like an incident’s', () => {
  const early = vulnClock(row(), { now: T0 + 2 * DAY });
  assert.equal(early.met, null, 'two days into a seven-day SLA');
  assert.equal(early.overdue, false);
  assert.equal(early.daysOpen, 2);

  const late = vulnClock(row(), { now: T0 + 20 * DAY });
  assert.equal(late.met, false);
  assert.equal(late.overdue, true);

  const fixed = vulnClock(row({ status: 'closed', closed_at: day(5) }), { now: T0 + 20 * DAY });
  assert.equal(fixed.met, true, 'five days against seven, however long ago that was');
  assert.equal(fixed.open, false);
  assert.equal(fixed.daysOpen, 5);
});

await check('the severity is read off the bead, not re-scanned — a re-score cannot erase a breach', () => {
  const c = vulnClock(row({ labels: [VULN_LABEL, `${PKG_PREFIX}minimist`, 'vulnsev:critical'] }), { now: T0 + 10 * DAY });
  assert.equal(c.severity, 'critical');
  assert.equal(c.days, 7);
  assert.equal(c.overdue, true, 'and it stays overdue whatever the advisory says today');
  const unlabelled = vulnClock(row({ labels: [VULN_LABEL] }), { now: T0 + 400 * DAY });
  assert.equal(unlabelled.days, null, 'a bead with no severity has no deadline rather than a made-up one');
  assert.equal(unlabelled.met, null);
});

await check('the evidence is bounded by detection, and pending is not a miss', () => {
  const clocks = [
    vulnClock(row({ id: 'a', created_at: day(-400), status: 'closed', closed_at: day(-395) }), { now: T0 + 3 * DAY }),
    vulnClock(row({ id: 'b', created_at: day(0), status: 'closed', closed_at: day(2) }), { now: T0 + 3 * DAY }),
    vulnClock(row({ id: 'c', created_at: day(1) }), { now: T0 + 3 * DAY }),
    vulnClock(row({ id: 'd', created_at: day(-30) }), { now: T0 + 3 * DAY }),
  ];
  const ev = vulnEvidence(clocks, { from: T0 });
  assert.equal(ev.total, 2, 'the two detected before the window are out of it');
  assert.equal(ev.remediation.met, 1);
  assert.equal(ev.remediation.missed, 0);
  assert.equal(ev.remediation.pending, 1);
  assert.equal(ev.open, 1);
  assert.deepEqual(ev.bySeverity, { critical: 2 });
});

await check('the scan claims CC7.1 and only the half of it that it performs', () => {
  // The corpus is imported by this suite and not by lib/vulnscan.js — the leaf keeps its
  // ids as literals so it still loads in a release without lib/controls.js, and this is
  // where they are held to it. The rest of the crosswalk, including that CC7.1 is claimed
  // here and nowhere else, is asserted in test/incident.mjs alongside its other half.
  assert.deepEqual(CRITERIA.map((c) => c.id), ['SOC2.CC7.1']);
  assert.ok(isControl('SOC2.CC7.1'), 'claimed against a corpus that does not have it');
  assert.match(CRITERIA[0].by, /scan/);
  assert.ok(CRITERIA[0].how.trim(), 'a claimed criterion with no sentence under it is a claim nobody can test');
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `all ${ran} checks passed`}`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
