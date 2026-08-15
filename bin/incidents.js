#!/usr/bin/env node
/**
 * The incident register, its clocks, and the evidence that the commitments were met.
 *
 *   beadcause-incidents -w beadcause                  the register, worst first
 *   beadcause-incidents -w beadcause --period 90d     what happened in the last 90 days
 *   beadcause-incidents -w beadcause --reviews        which resolved incidents owe a review
 *   beadcause-incidents -w beadcause --reviews --file file the ones that are owed
 *   beadcause-incidents -w beadcause --vulns          npm audit, on a remediation clock
 *   beadcause-incidents -w beadcause --vulns --file   file what is new, close what is fixed
 *
 * **Nothing here is a source of truth and that is the point.** Every number is derived,
 * on the spot, from timestamps bd wrote while people and agents did their ordinary work:
 * `created_at` detected it, `started_at` acknowledged it, `closed_at` resolved it. Run it
 * again next year over the same window and it gives the same answer, because there is no
 * record of the answer anywhere — only of the work. A log kept *for* an audit is a log
 * somebody maintains, and a log somebody maintains is one that gets maintained the week
 * before the audit.
 *
 * The arithmetic is all in lib/incident.js and lib/vulnscan.js, which know nothing about
 * a terminal and are tested without one. This file is the table.
 */
import path from 'node:path';

import { Bd } from '../lib/bd.js';
import { loadConfig } from '../lib/config.js';
import { beadToIssue } from '../lib/filing.js';
import {
  breaches,
  humanMinutes,
  INCIDENT_LABEL,
  periodEvidence,
  register,
  reviewBead,
  reviewsOwed,
  SEVERITIES,
} from '../lib/incident.js';
import { reconcile, scan, vulnClock, vulnEvidence, VULN_LABEL } from '../lib/vulnscan.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (...names) => names.some((n) => process.argv.includes(n));

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws) {
  console.error('usage: beadcause-incidents -w <workspace> [--period 90d] [--reviews|--vulns] [--file]');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

/** `90d`, `12h`, `30` (days) → milliseconds. A window nobody named is all of history. */
function windowMs(spec) {
  if (!spec) return null;
  const m = /^(\d+)\s*([dhw]?)$/i.exec(String(spec).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'd').toLowerCase();
  return n * (unit === 'h' ? 3_600_000 : unit === 'w' ? 604_800_000 : 86_400_000);
}

const now = Date.now();
const span = windowMs(arg('--period', '-p'));
const from = span ? now - span : null;
const doFile = has('--file');
const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

const pad = (text, width) => String(text).padEnd(width).slice(0, width);
const iso = (ms) => (ms == null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16));
const verdict = (met) => (met === true ? 'met' : met === false ? 'MISSED' : 'pending');

if (has('--vulns')) await vulns();
else await incidents();

/* ------------------------------------------------------------------ the incidents */

async function incidents() {
  // `listLabelAny` and not `listLabel`, because it keeps the closed ones. A register that
  // drops incidents when they are fixed can evidence nothing at all: every incident an
  // auditor samples is closed by the time they ask about it.
  const rows = await bd.listLabelAny(ws, INCIDENT_LABEL);
  const clocks = register(rows, { now, config: cfg });

  if (has('--reviews')) return reviews(clocks);

  if (!clocks.length) {
    console.log(`no incidents in ${ws.name} — nothing carries the \`${INCIDENT_LABEL}\` label yet.`);
    return;
  }

  console.log(`${ws.name} — ${clocks.length} incident${clocks.length === 1 ? '' : 's'}, worst first\n`);
  console.log(`${pad('id', 14)}${pad('sev', 6)}${pad('detected', 18)}${pad('ack', 12)}${pad('resolve', 12)}title`);
  for (const c of clocks) {
    const ack = `${humanMinutes(c.ackMinutes)} ${verdict(c.ackMet)}`;
    const res = `${humanMinutes(c.resolveMinutes)} ${verdict(c.resolveMet)}`;
    console.log(`${pad(c.id, 14)}${pad(c.severity, 6)}${pad(iso(c.detected), 18)}${pad(ack, 12)}${pad(res, 12)}${c.title.slice(0, 60)}`);
  }

  const late = breaches(clocks);
  if (late.length) {
    console.log(`\n${late.length} past a commitment right now:`);
    for (const c of late) {
      const which = [c.ackMet === false ? 'acknowledgement' : '', c.resolveMet === false ? 'resolution' : '']
        .filter(Boolean)
        .join(' and ');
      console.log(`  ${c.id} (${c.severity}) — ${which} — ${c.title.slice(0, 70)}`);
    }
  }

  const ev = periodEvidence(clocks, { from });
  console.log(`\n${span ? `in the last ${arg('--period', '-p')}` : 'all time'}: ${ev.total} incident${ev.total === 1 ? '' : 's'}` +
    ` — ${SEVERITIES.map((s) => `${s.id} ${ev.bySeverity[s.id]}`).join(' · ')}`);
  console.log(`  acknowledged: ${ev.acknowledgement.met} met · ${ev.acknowledgement.missed} missed · ${ev.acknowledgement.pending} still inside the window`);
  console.log(`  resolved:     ${ev.resolution.met} met · ${ev.resolution.missed} missed · ${ev.resolution.pending} still inside the window`);
  console.log(`  reviews:      ${ev.reviews.done}/${ev.reviews.owed} of the ones that owe one exist`);
  if (ev.unclassified) {
    console.log(`  ${ev.unclassified} carry no severity — filed before there was one, and counted at the default.`);
  }
}

/* ------------------------------------------- the reviews, and filing the ones owed */

async function reviews(clocks) {
  const owed = reviewsOwed(clocks);
  if (!owed.length) {
    console.log('every resolved incident that owes a post-incident review has one.');
    return;
  }
  console.log(`${owed.length} resolved incident${owed.length === 1 ? '' : 's'} owe a post-incident review:\n`);
  for (const c of owed) {
    console.log(`  ${pad(c.id, 14)}${pad(c.severity, 6)}resolved ${iso(c.resolved)} — ${c.title.slice(0, 60)}`);
  }
  if (!doFile) {
    console.log('\n--file files them.');
    return;
  }
  for (const c of owed) {
    // Held, not endorsed — deliberately unlike the incident itself. A P0 crash behind a
    // tap defeats the point of filing it automatically; a review is work somebody has to
    // sit down and do, and queueing that without being asked is how an advocate spends a
    // night on a form. The record exists either way, which is what the clock reads.
    const issue = beadToIssue(reviewBead(c, { workspace: ws.name }), { from: c.id });
    try {
      const id = await bd.create(ws, issue, { actor: cfg.actor });
      console.log(`filed ${id} — the review of ${c.id}`);
    } catch (err) {
      console.error(`could not file the review of ${c.id}: ${String(err.message).split('\n')[0]}`);
    }
  }
}

/* ------------------------------------------------------------- the vulnerabilities */

async function vulns() {
  // Where the scan runs: `--dir`, or wherever this was invoked. A workspace is a tracker
  // and not a checkout — `cfg.workspaces` carries a name and a `.beads` directory and
  // nothing that resolves to a `package.json` — so the tree being audited has to be said
  // rather than inferred, and the sensible default is the one you are standing in.
  const cwd = path.resolve(arg('--dir') || process.cwd());
  const found = await scan({ cwd });
  if (!found.ok && found.why) {
    console.error(`the scan did not produce a report: ${found.why}`);
    process.exitCode = 2;
    return;
  }
  const rows = await bd.listLabelAny(ws, VULN_LABEL);
  const plan = reconcile(found.findings, rows, { now, config: cfg });

  console.log(`${cwd} — npm audit reports ${found.findings.length} vulnerable package${found.findings.length === 1 ? '' : 's'}\n`);
  const clocks = rows.map((r) => vulnClock(r, { now, config: cfg }));
  const live = clocks.filter((c) => c.open);
  if (live.length) {
    console.log(`${pad('id', 14)}${pad('sev', 10)}${pad('found', 18)}${pad('sla', 8)}${pad('open', 8)}package`);
    for (const c of live.sort((a, b) => (a.due || 0) - (b.due || 0))) {
      console.log(`${pad(c.id, 14)}${pad(c.severity, 10)}${pad(iso(c.found), 18)}${pad(`${c.days ?? '—'}d`, 8)}${pad(`${c.daysOpen ?? '?'}d`, 8)}${c.package}${c.overdue ? '  ← OVERDUE' : ''}`);
    }
    console.log('');
  }
  console.log(`${plan.file.length} to file · ${plan.close.length} remediated and closable · ${plan.overdue.length} past their SLA`);
  for (const f of plan.file) console.log(`  new: ${f.finding.severity} in ${f.finding.name}`);
  for (const c of plan.close) console.log(`  fixed: ${c.package} (${c.id})`);

  const ev = vulnEvidence(clocks, { from });
  console.log(`\n${span ? `in the last ${arg('--period', '-p')}` : 'all time'}: ${ev.total} advisor${ev.total === 1 ? 'y' : 'ies'}` +
    ` — remediated ${ev.remediation.met} within SLA · ${ev.remediation.missed} outside it · ${ev.remediation.pending} still inside the window`);

  if (!doFile) {
    console.log('\n--file files the new ones and closes the fixed ones.');
    return;
  }
  for (const f of plan.file) {
    // Held for the same reason a review is: this is work, and the tap is where it is
    // decided. The bead's own `created_at` starts the remediation clock either way.
    const issue = beadToIssue(f.bead, {});
    try {
      const id = await bd.create(ws, issue, { actor: cfg.actor });
      console.log(`filed ${id} — ${f.finding.severity} in ${f.finding.name}`);
    } catch (err) {
      console.error(`could not file ${f.finding.name}: ${String(err.message).split('\n')[0]}`);
    }
  }
  for (const c of plan.close) {
    try {
      await bd.close(ws, c.id, c.reason, { actor: cfg.actor });
      console.log(`closed ${c.id} — ${c.package} is no longer reported`);
    } catch (err) {
      console.error(`could not close ${c.id}: ${String(err.message).split('\n')[0]}`);
    }
  }
}
