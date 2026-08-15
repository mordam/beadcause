#!/usr/bin/env node
/**
 * The nonconformity register, its corrective actions, and the dated checks that say
 * they worked — and, kept firmly apart from all of it, the gate refusals.
 *
 *   beadcause-capa -w beadcause                     the register, worst first
 *   beadcause-capa -w beadcause --owed              incidents that breached and have no record
 *   beadcause-capa -w beadcause --owed --file       raise the ones that are owed
 *   beadcause-capa -w beadcause --raise bc-x        raise one by hand, from any bead
 *   beadcause-capa -w beadcause --raise bc-x --file --days 30
 *   beadcause-capa -w beadcause --checks            effectiveness checks, soonest due first
 *   beadcause-capa -w beadcause --refusals          what the gates refused — the control working
 *   beadcause-capa -w beadcause --period 90d        the evidence, both kinds counted apart
 *
 * **The two kinds never share a line in this output.** A nonconformity is a requirement
 * that was not met; a gate refusal is a control that stopped non-conformant work, which
 * is the system doing exactly what it was built to do. They are different sections with
 * different words, because the cheapest possible way to lose an audit is to hand
 * somebody a list where they look alike.
 *
 * Filing does three writes and the third is the one that matters: the record, the check,
 * and then the dependency that makes the check **block** the record from closing. If the
 * third fails the first two are still there and this says so loudly — a record with an
 * unblocking check is a form, and it should not be able to look like anything else.
 *
 * The arithmetic is all in lib/capa.js, which knows nothing about a terminal and is
 * tested without one. This file is the table.
 */
import { Bd } from '../lib/bd.js';
import {
  CHECK_LABEL,
  checksOverdue,
  dueOn,
  effectivenessBead,
  forcedCloses,
  NONCONFORMITY_LABEL,
  nonconformitiesOwed,
  nonconformityBead,
  periodEvidence,
  refusalsFrom,
  REFUSAL_LABEL,
  register,
  SECTIONS,
} from '../lib/capa.js';
import { loadConfig } from '../lib/config.js';
import { beadToIssue } from '../lib/filing.js';
import { humanMinutes, INCIDENT_LABEL, register as incidentRegister } from '../lib/incident.js';

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
  console.error('usage: beadcause-capa -w <workspace> [--owed|--raise <bead>|--checks|--refusals] [--period 90d] [--file]');
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
const day = (ms) => (ms == null ? '—' : new Date(ms).toISOString().slice(0, 10));

// The questions come out before anything is read: `--sections` is what somebody runs
// before they have a register at all, and it should not need a tracker to answer.
if (has('--sections')) {
  sections();
  process.exit(0);
}

const rows = await bd.listLabelAny(ws, NONCONFORMITY_LABEL);
const records = register(rows, { now });
const raisedAt = new Map(rows.map((r) => [r.id, Date.parse(r.created_at)]));

if (has('--refusals')) await refusals();
else if (has('--raise')) await raise();
else if (has('--owed')) await owed();
else if (has('--checks')) checks();
else registerTable();

/* --------------------------------------------------------------------- the register */

function registerTable() {
  if (!records.length) {
    console.log(`no nonconformities in ${ws.name} — nothing carries the \`${NONCONFORMITY_LABEL}\` label yet.`);
    console.log('--owed shows the incidents that breached a stated commitment and therefore owe one.');
    return;
  }

  console.log(`${ws.name} — ${records.length} nonconformity record${records.length === 1 ? '' : 's'}\n`);
  console.log(`${pad('id', 14)}${pad('status', 10)}${pad('check', 14)}${pad('due', 12)}${pad('unanswered', 34)}title`);
  for (const r of records) {
    const check = r.unchecked ? 'NONE' : `${r.checkId}${r.checkDone ? ' ✓' : ''}`;
    const due = r.checkDue ? `${r.checkDue}${r.checkOverdue ? ' OVERDUE' : ''}` : '—';
    const gaps = r.missing.length ? r.missing.join(', ') : '—';
    console.log(`${pad(r.id, 14)}${pad(r.status, 10)}${pad(check, 14)}${pad(due, 12)}${pad(gaps, 34)}${r.title.slice(0, 50)}`);
  }

  const forced = forcedCloses(records);
  if (forced.length) {
    console.log(`\n${forced.length} closed over an open effectiveness check — bd refuses that, so each was --forced:`);
    for (const r of forced) console.log(`  ${r.id} — check ${r.checkId} is still ${r.checkStatus || 'open'}`);
  }
  const late = checksOverdue(records);
  if (late.length) {
    console.log(`\n${late.length} effectiveness check${late.length === 1 ? '' : 's'} past their date:`);
    for (const r of late) console.log(`  ${r.checkId} was due ${r.checkDue} — the check of ${r.id}, ${r.title.slice(0, 50)}`);
  }
  const none = records.filter((r) => r.unchecked && !r.closed);
  if (none.length) {
    console.log(`\n${none.length} open record${none.length === 1 ? '' : 's'} with no effectiveness check at all — nothing is holding them:`);
    for (const r of none) console.log(`  ${r.id} — ${r.title.slice(0, 60)}`);
  }

  evidence();
}

function evidence() {
  const refs = [];
  const ev = periodEvidence(records, refs, { from, raisedAt });
  const n = ev.nonconformities;
  console.log(`\n${span ? `raised in the last ${arg('--period', '-p')}` : 'all time'}: ${n.total} record${n.total === 1 ? '' : 's'}`);
  console.log(`  ${n.open} open · ${n.complete} with all five sections answered · ${n.unchecked} with no check`);
  console.log(`  checks: ${n.checksDone} done · ${n.checksOverdue} overdue${n.forced ? ` · ${n.forced} closed over an open check` : ''}`);
  console.log('  gate refusals are counted separately and are not findings — `--refusals`.');
}

/* ---------------------------------------------------------------- the checks, dated */

function checks() {
  const withChecks = records.filter((r) => r.checkId);
  if (!withChecks.length) {
    console.log('no effectiveness checks — every record here is unblocked, which is the state this exists to prevent.');
    return;
  }
  const order = [...withChecks].sort((a, b) => String(a.checkDue).localeCompare(String(b.checkDue)));
  console.log(`${order.length} effectiveness check${order.length === 1 ? '' : 's'}, soonest due first\n`);
  console.log(`${pad('check', 14)}${pad('due', 14)}${pad('state', 12)}${pad('of', 14)}title`);
  for (const r of order) {
    const state = r.checkDone ? 'done' : r.checkOverdue ? 'OVERDUE' : 'waiting';
    console.log(`${pad(r.checkId, 14)}${pad(r.checkDue || '—', 14)}${pad(state, 12)}${pad(r.id, 14)}${r.title.slice(0, 50)}`);
  }
  console.log('\nA check that is open — deferred included — is a blocker, and bd refuses to close the record behind it.');
}

/* ------------------------------------------------------- what is owed and not raised */

async function owed() {
  // Breached is the one source that needs no judgement: the commitment was written down
  // before the incident, and it was missed. Everything else is `--raise`, by hand.
  const incidents = await bd.listLabelAny(ws, INCIDENT_LABEL);
  const clocks = incidentRegister(incidents, { now, config: cfg });
  const list = nonconformitiesOwed(clocks, records);
  if (!list.length) {
    console.log('every incident that missed a stated commitment already has a nonconformity record.');
    return;
  }
  console.log(`${list.length} resolved incident${list.length === 1 ? '' : 's'} missed a commitment and have no record:\n`);
  for (const c of list) {
    const which = [c.ackMet === false ? `acknowledged in ${humanMinutes(c.ackMinutes)}` : '', c.resolveMet === false ? `resolved in ${humanMinutes(c.resolveMinutes)}` : '']
      .filter(Boolean)
      .join(' and ');
    console.log(`  ${pad(c.id, 14)}${pad(c.severity, 6)}${which} — ${c.title.slice(0, 55)}`);
  }
  if (!doFile) {
    console.log('\n--file raises them, each with its dated effectiveness check.');
    return;
  }
  for (const c of list) {
    const which = c.ackMet === false && c.resolveMet === false ? 'acknowledgement and resolution' : c.ackMet === false ? 'acknowledgement' : 'resolution';
    await file({
      source: c.id,
      title: c.title,
      requirement: `the ${c.severity} ${which} commitment — stated before the incident and missed`,
    });
  }
}

/* ------------------------------------------------------------- raising one by hand */

async function raise() {
  const source = arg('--raise');
  if (!source || source.startsWith('--')) {
    console.error('--raise <bead> — the bead this nonconformity was found on. Add --requirement "…" to name what was not met.');
    process.exitCode = 1;
    return;
  }
  const row = await bd.show(ws, source).catch(() => null);
  if (!row) {
    console.error(`${source} is not a bead in ${ws.name} — a record has to be raised from something.`);
    process.exitCode = 1;
    return;
  }
  await file({ source, title: row.title || '', requirement: arg('--requirement') || '' });
}

/**
 * The three writes, in the order that leaves the least wrong behind if one fails.
 *
 * Record first, so the finding exists whatever happens next. Then the check. Then the
 * dependency — and only after that has landed is the record actually blocked, which is
 * why a failure there is shouted about rather than logged: a record whose check does not
 * block it looks exactly like one whose check does, and the difference is the entire
 * control.
 */
async function file({ source, title, requirement }) {
  const due = dueOn({ from: now, days: Number(arg('--days')) || undefined });
  const bead = nonconformityBead({ source, title, requirement, due });
  if (!doFile) {
    console.log(`${bead.title}\n\n${bead.description}\n\n--file files it, with its check.`);
    return;
  }

  let ncId = '';
  try {
    ncId = await bd.create(ws, beadToIssue(bead, { from: source }), { actor: cfg.actor });
    console.log(`raised ${ncId} — ${bead.title}`);
  } catch (err) {
    console.error(`could not raise the record for ${source}: ${String(err.message).split('\n')[0]}`);
    process.exitCode = 2;
    return;
  }

  const check = effectivenessBead({ nonconformity: ncId, title, due });
  let checkId = '';
  try {
    checkId = await bd.create(ws, beadToIssue(check, { from: ncId }), { actor: cfg.actor });
    console.log(`  check ${checkId} — due ${due}`);
  } catch (err) {
    console.error(`  ${ncId} HAS NO EFFECTIVENESS CHECK: ${String(err.message).split('\n')[0]}`);
    console.error('  nothing is holding that record closed. File one by hand before it is forgotten.');
    process.exitCode = 2;
    return;
  }

  try {
    await bd.addDep(ws, ncId, checkId);
    console.log(`  ${ncId} is blocked by ${checkId} — it cannot close until the check is answered`);
  } catch (err) {
    console.error(`  ${checkId} DOES NOT BLOCK ${ncId}: ${String(err.message).split('\n')[0]}`);
    console.error(`  run: bd dep add ${ncId} ${checkId} — until then the record can close unchecked`);
    process.exitCode = 2;
  }

  // Both beads are filed held — `beadToIssue` marks anything an agent filed unendorsed —
  // which is the review's argument in lib/incident.js and applies here word for word.
  //
  // Deferred until the day it is due, which is what makes the date real rather than
  // decorative: it is out of every queue until then and arrives on the date. A deferred
  // bead is still not closed, so it goes on blocking the record throughout.
  try {
    await bd.run(ws, ['defer', checkId, '--until', due], { retries: 3 });
    console.log(`  ${checkId} is deferred until ${due} — it comes back on its own date`);
  } catch (err) {
    console.error(`  could not defer ${checkId} to ${due}: ${String(err.message).split('\n')[0]} (the label still carries the date)`);
  }

  try {
    await bd.appendNotes(ws, ncId, `Effectiveness check: ${checkId}, due ${due}.`);
  } catch {
    /* the label and the edge both carry it; the note is a convenience */
  }
}

/* ---------------------------------------------- the other kind, in its own section */

/**
 * What the gates refused, and the sentence that has to be next to it every time.
 *
 * Reading a refusal as a failure is the expensive mistake this whole module is arranged
 * against, so the list does not merely avoid calling them failures — it says what they
 * are, above the table, where somebody skimming will hit it first.
 */
async function refusals() {
  const refused = await bd.listLabelAny(ws, REFUSAL_LABEL);
  console.log('Gate refusals — **the controls operating**, not findings. Each one is work a gate stopped');
  console.log('because it did not conform; none of them is a nonconformity and none is counted as one.\n');
  if (!refused.length) {
    console.log(`nothing in ${ws.name} carries \`${REFUSAL_LABEL}\` — no gate has refused anything yet.`);
    return;
  }
  const all = [];
  for (const row of refused) {
    const found = refusalsFrom(await bd.comments(ws, row.id), { bead: row.id });
    all.push(...found);
  }
  if (!all.length) {
    console.log(`${refused.length} bead${refused.length === 1 ? '' : 's'} carry the label but no refusal comment could be read from them.`);
    return;
  }
  all.sort((a, b) => (b.at || 0) - (a.at || 0));
  console.log(`${pad('when', 12)}${pad('bead', 14)}${pad('gate', 22)}${pad('control', 20)}what it refused`);
  for (const r of all) {
    console.log(`${pad(day(r.at), 12)}${pad(r.bead, 14)}${pad(r.gate, 22)}${pad(r.control, 20)}${String(r.subject || '').slice(0, 40)}`);
  }
  const ev = periodEvidence(records, all, { from, raisedAt });
  console.log(`\n${span ? `in the last ${arg('--period', '-p')}` : 'all time'}: ${ev.refusals.total} refusal${ev.refusals.total === 1 ? '' : 's'}`);
  for (const [control, n] of Object.entries(ev.refusals.byControl).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(control, 24)}${n}`);
  }
  console.log(`\nThese count ${ev.refusals.meaning}.`);
}

/* -------------------------------------------------------------- what a record asks */

/**
 * The five sections, printed — because the questions are most of the value and nobody
 * can answer a question they have to invent first. Same argument as `--tabletop`
 * printing its scenarios: the expensive part is the thinking, not the filing.
 */
function sections() {
  console.log('a nonconformity record answers five things, and the third is the one that decides:\n');
  for (const s of SECTIONS) console.log(`  ${pad(s.id, 16)}${s.heading}\n  ${pad('', 16)}${s.asks}\n`);
  console.log(`the check carries \`${CHECK_LABEL}\` and \`due:<day>\`, and blocks the record closing until it is answered.`);
}
