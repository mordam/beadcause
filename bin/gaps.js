#!/usr/bin/env node
/**
 * The gap assessment as a command — every elected criterion, its state, and whose it is.
 *
 *   beadcause-gaps show                 every elected criterion, by category
 *   beadcause-gaps owners               what each owning function is carrying
 *   beadcause-gaps criterion <id>       one criterion in full, with what claims it
 *   beadcause-gaps declined             the categories that were considered and left out
 *   beadcause-gaps beads                the one-bead-per-criterion payload, for beadcause-file
 *
 * **`declined` is the one nobody thinks to run.** A gap assessment that lists what is in
 * scope cannot tell you whether privacy was declined or forgotten, and those are different
 * facts with the same shape. Every category is accounted for, in scope or out.
 *
 * `beads` emits rather than files, and that is deliberate. `lib/gapassessment.js` is the
 * register; thirty-eight beads typed once and never regenerated drift from it, and a
 * criterion quietly dropped from the tracker is the failure the register exists to refuse.
 * Pipe it into `beadcause-file` when the decomposition is wanted, and regenerate it when a
 * state changes:
 *
 *   beadcause-gaps beads | beadcause-file -w beadcause --from bc-4r10.4
 *
 * It reads. It writes nothing — no tracker, no repository, no ref. The register ships
 * compiled into the release, so this needs no config directory, no git and no network.
 *
 * `--json` on any verb for the payload rather than the rendering; both are the same
 * computation, which is what stops the readable artefact and the machine-readable one
 * disagreeing. `--strict` exits 1 when anything is not met, so a check can gate on it.
 */
import { boundaryFor } from '../lib/boundary.js';
import {
  ASSESSMENT,
  DECIDED_BY,
  ELECTED,
  HELD_BY,
  NOT_ELECTED,
  assess,
  beadFor,
  byOwner,
  counts,
  gaps,
  summarise,
} from '../lib/gapassessment.js';

const argv = process.argv.slice(2);
const VERBS = ['show', 'owners', 'criterion', 'declined', 'beads'];
const has = (n) => argv.includes(n);
const positional = argv.filter((a) => !a.startsWith('-'));
const verb = VERBS.includes(positional[0]) ? positional[0] : 'show';
const named = VERBS.includes(positional[0]) ? positional[1] : positional[0];

if (has('--help') || has('-h') || (positional[0] && !VERBS.includes(positional[0]))) {
  const bad = Boolean(positional[0]) && !VERBS.includes(positional[0]);
  const out = bad ? console.error : console.log;
  if (bad) out(`beadcause-gaps: no verb "${positional[0]}"`);
  out(
    [
      'beadcause-gaps show              every elected criterion, by category',
      'beadcause-gaps owners            what each owning function is carrying',
      'beadcause-gaps criterion <id>    one criterion in full, with what claims it',
      'beadcause-gaps declined          the categories considered and left out',
      'beadcause-gaps beads             the one-bead-per-criterion payload, for beadcause-file',
      '',
      '  --json      the payload rather than the rendering',
      '  --strict    exit 1 when anything is not met',
      '',
      `  subject: ${HELD_BY} · categories elected: ${ELECTED.join(', ')} (${DECIDED_BY.categories})`,
    ].join('\n')
  );
  process.exit(bad ? 1 : 0);
}

const boundary = boundaryFor(HELD_BY);
const rows = assess(ASSESSMENT, boundary);
const json = has('--json');
const MARK = { met: '✓', partial: '◐', absent: '·' };

const wrap = (s, width, indent) =>
  String(s || '')
    .split(/\s+/)
    .reduce((lines, word) => {
      const last = lines[lines.length - 1];
      if (last && (last + ' ' + word).length <= width) lines[lines.length - 1] = last + ' ' + word;
      else lines.push(word);
      return lines;
    }, [])
    .map((l) => indent + l)
    .join('\n');

function show() {
  if (json) return console.log(JSON.stringify({ summary: summarise(ASSESSMENT, boundary), counts: counts(ASSESSMENT, boundary), rows }, null, 2));
  console.log(summarise(ASSESSMENT, boundary));
  console.log();
  let category = null;
  for (const row of rows) {
    if (row.category !== category) {
      category = row.category;
      console.log(`── ${category} ${'─'.repeat(Math.max(0, 68 - category.length))}`);
    }
    const flag = row.confidence === 'provisional' ? ' (provisional)' : '';
    console.log(`  ${MARK[row.state]} ${row.id.padEnd(12)} ${row.title}`);
    console.log(`      ${row.state}${flag} · ${row.owner}`);
    console.log(wrap(row.why, 84, '      '));
    console.log();
  }
  const c = counts(ASSESSMENT, boundary);
  console.log(
    `${c.state.met} met · ${c.state.partial} partial · ${c.state.absent} absent · ` +
      `${c.confidence.provisional} of ${c.total} rest on a population nobody has enumerated`
  );
}

function owners() {
  const carried = byOwner(ASSESSMENT, boundary);
  if (json) return console.log(JSON.stringify(Object.fromEntries([...carried].map(([k, v]) => [k, v.map((r) => r.id)])), null, 2));
  for (const [role, list] of carried) {
    if (!list.length) {
      console.log(`${role}: nothing`);
      continue;
    }
    const n = list.filter((r) => r.state !== 'met').length;
    console.log(`${role} — ${list.length} criteri${list.length === 1 ? 'on' : 'a'}, ${n} not met`);
    for (const row of list) console.log(`  ${MARK[row.state]} ${row.id.padEnd(12)} ${row.title}`);
    console.log();
  }
}

function criterion() {
  const row = rows.find((r) => r.id === named || r.id === `SOC2.${named}`);
  if (!row) {
    console.error(`beadcause-gaps: "${named || '(none named)'}" is not an elected criterion in this assessment`);
    process.exit(1);
  }
  if (json) return console.log(JSON.stringify(row, null, 2));
  console.log(`${row.id} — ${row.title}`);
  console.log(`${row.state}${row.confidence === 'provisional' ? ' (provisional)' : ''} · owner: ${row.owner}`);
  console.log();
  console.log(wrap(row.why, 84, '  '));
  console.log();
  const field = (label, value) => {
    console.log(`  ${label}`);
    console.log(wrap(value || 'none', 84, '    '));
  };
  field('Control today', row.control);
  field('Evidence an auditor could sample today', row.evidence);
  if (row.bears) field('Bears on it without satisfying it', row.bears);
  if (row.held) field('Held', row.held);
  field('Claimed by, in the control corpus', row.claims.join(', '));
  field('Documented answer, in the policy set', row.documentedBy.join(', '));
  field('Tested against, by boundary census kind', row.population.join(', ') || 'documents and management, not an enumerated estate');
}

function declined() {
  if (json) return console.log(JSON.stringify({ elected: ELECTED, declined: NOT_ELECTED, decidedBy: DECIDED_BY }, null, 2));
  console.log(`Elected: ${ELECTED.join(', ')} — ${DECIDED_BY.categories}`);
  console.log();
  for (const c of NOT_ELECTED) {
    console.log(`${c.category} — ${c.label}: ${c.disposition} (${c.decision})`);
    console.log(wrap(c.why, 84, '  '));
    console.log();
  }
}

function beads() {
  const payload = gaps(ASSESSMENT, boundary).map(beadFor);
  if (json) return console.log(JSON.stringify(payload, null, 2));
  // YAML by hand rather than by a dependency: bin/file.js parses this shape, the strings
  // are all block scalars, and adding a package to emit five keys is not a trade worth
  // making for a payload this regular.
  const block = (s) =>
    String(s)
      .replace(/\s+$/, '')
      .split('\n')
      .map((l) => (l ? `      ${l}` : ''))
      .join('\n');
  for (const b of payload) {
    console.log(`- title: ${JSON.stringify(b.title)}`);
    console.log(`  type: ${b.type}`);
    console.log(`  priority: ${b.priority}`);
    console.log(`  complexity: ${b.complexity}`);
    console.log('  description: |');
    console.log(block(b.description));
    console.log(`  acceptance: ${JSON.stringify(b.acceptance)}`);
    console.log(`  rationale: ${JSON.stringify(b.rationale)}`);
  }
}

({ show, owners, criterion, declined, beads })[verb]();

if (has('--strict') && gaps(ASSESSMENT, boundary).length) process.exit(1);
