#!/usr/bin/env node
/**
 * The auditor engagement as a command — the sequence, the two dates, and what is holding them.
 *
 *   beadcause-engagement show                    the sequence, the dates and the letter
 *   beadcause-engagement dates                   the Type I as-of and the window open date
 *   beadcause-engagement letter                  the four terms, and which of them resolve
 *   beadcause-engagement firms                   the classes, the questions, what a quote must cover
 *   beadcause-engagement bridge <end> <asked>    the bridge state between two dates
 *
 * **`dates` never prints a date, and that is the verb.** The Type I as-of date and the Type
 * II window open date are the two things `bc-4r10.13` is named for, and both are derived
 * from readiness rather than chosen: the window opens when the controls demonstrably
 * operate, and opening it earlier produces a report containing exceptions rather than a
 * shorter timeline. So this prints whether a date may be set at all and the criteria holding
 * the gate — today thirty-eight of them.
 *
 * `firms` is what to take into a readiness call. It prints the three classes the choice is
 * between, the two questions from `bc-4r10.13` that actually separate them, and what a quote
 * has to cover to be comparable to another quote.
 *
 * It reads. It writes nothing — no tracker, no repository, no ref. The register ships
 * compiled into the release, so this needs no config directory, no git and no network.
 *
 * `--json` on any verb for the payload rather than the rendering; both are the same
 * computation, which is what stops the readable artefact and the machine-readable one
 * disagreeing. `--strict` exits 1 while no date is settable, so a check can gate on it.
 */
import { boundaryFor } from '../lib/boundary.js';
import {
  DECIDED_BY,
  ELECTED,
  FIRM_CLASSES,
  HELD_BY,
  QUOTE_TERMS,
  REPORT_PLAN,
  SEPARATING,
  bridge,
  engagement,
  letter,
  nonGoal,
  platformPurchase,
  render,
  schedule,
  selection,
  summarise,
} from '../lib/engagement.js';

const argv = process.argv.slice(2);
const VERBS = ['show', 'dates', 'letter', 'firms', 'bridge'];
const has = (n) => argv.includes(n);
const positional = argv.filter((a) => !a.startsWith('-'));
const verb = VERBS.includes(positional[0]) ? positional[0] : 'show';
const rest = VERBS.includes(positional[0]) ? positional.slice(1) : positional;

if (has('--help') || has('-h') || (positional[0] && !VERBS.includes(positional[0]))) {
  const bad = Boolean(positional[0]) && !VERBS.includes(positional[0]);
  const out = bad ? console.error : console.log;
  if (bad) out(`beadcause-engagement: no verb "${positional[0]}"`);
  out(
    [
      'beadcause-engagement show                  the sequence, the dates and the letter',
      'beadcause-engagement dates                 the Type I as-of and the window open date',
      'beadcause-engagement letter                the four terms, and which of them resolve',
      'beadcause-engagement firms                 the classes, the questions, what a quote must cover',
      'beadcause-engagement bridge <end> <asked>  the bridge state between two dates',
      '',
      '  --json      the payload rather than the rendering',
      '  --strict    exit 1 while no date is settable',
      '',
      `  subject: ${HELD_BY} · categories elected: ${ELECTED.join(', ')} (${DECIDED_BY.categories})`,
      `  report: Type I and Type II, ${REPORT_PLAN.sameDay ? 'one date' : 'sequenced'} (${DECIDED_BY.type})`,
    ].join('\n')
  );
  process.exit(bad ? 1 : 0);
}

const boundary = boundaryFor(HELD_BY);
const json = has('--json');

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
  if (json) return console.log(JSON.stringify(engagement(undefined, boundary), null, 2));
  console.log(render(undefined, boundary));
  console.log();
  const sel = selection();
  console.log('FIRM');
  console.log(wrap(sel.why, 84, '  '));
  const tooling = nonGoal(undefined, boundary);
  console.log();
  console.log('TOOLING');
  console.log(wrap(tooling.why, 84, '  '));
}

function dates() {
  const s = schedule(undefined, boundary);
  if (json) return console.log(JSON.stringify({ ...s, purchase: platformPurchase(s.typeTwoOpensOn) }, null, 2));
  console.log(`Type I as-of         ${s.typeOneAsOf || 'not settable'}`);
  console.log(`Type II window opens ${s.typeTwoOpensOn || 'not settable'}`);
  console.log();
  console.log(wrap(s.why, 84, '  '));
  console.log();
  for (const which of ['typeOne', 'typeTwo']) {
    const g = s[which];
    const label = which === 'typeOne' ? 'Type I' : 'Type II';
    console.log(`${label} — ${g.gate} gate: ${g.open ? 'open' : `shut, ${g.holding.length} holding`}`);
    if (!g.open) console.log(wrap(g.holding.join(' '), 84, '  '));
    console.log();
  }
  const purchase = platformPurchase(s.typeTwoOpensOn);
  console.log(
    purchase
      ? `Compliance platform: buy between ${purchase.from} and ${purchase.to} (${DECIDED_BY.tooling}).`
      : `Compliance platform: no purchase window, because the observation window has no date (${DECIDED_BY.tooling}).`
  );
}

function letterVerb() {
  const l = letter({ boundary });
  if (json) return console.log(JSON.stringify(l, null, 2));
  console.log(`Engagement letter — ${l.engaged || 'no firm engaged'}`);
  console.log();
  for (const term of l.terms) {
    console.log(`${term.resolved ? '✓' : '·'} ${term.id}`);
    console.log(wrap(term.names, 84, '    '));
    console.log(wrap(term.says, 84, '    '));
    console.log(wrap(`resolves from: ${term.from}`, 84, '    '));
    console.log();
  }
  console.log(
    l.unresolved.length
      ? `${l.unresolved.length} of ${l.terms.length} terms cannot be filled in yet: ${l.unresolved.join(', ')}`
      : 'Every term resolves.'
  );
}

function firms() {
  if (json) return console.log(JSON.stringify({ classes: FIRM_CLASSES, separating: SEPARATING, quote: QUOTE_TERMS, selection: selection() }, null, 2));
  console.log(selection().why);
  console.log();
  for (const c of FIRM_CLASSES) {
    console.log(`── ${c.id} ${'─'.repeat(Math.max(0, 68 - c.id.length))}`);
    console.log(wrap(c.label, 84, '  '));
    for (const [label, value] of [
      ['cost', c.cost],
      ['credibility', c.credibility],
      ['risk', c.risk],
    ]) {
      console.log(`  ${label}`);
      console.log(wrap(value, 84, '    '));
    }
    console.log(`  bundles evidence tooling: ${c.bundlesTooling ? 'yes' : 'no'}`);
    console.log();
  }
  console.log('ASK EACH FIRM');
  for (const q of SEPARATING) {
    console.log(wrap(q.asks, 84, '  '));
    console.log(wrap(`predicts: ${q.predicts}`, 84, '    '));
    console.log();
  }
  console.log('A QUOTE IS COMPARABLE WHEN IT COVERS');
  for (const t of QUOTE_TERMS) {
    console.log(`  ${t.required ? 'required' : 'optional'}  ${t.id}`);
    console.log(wrap(t.asks, 84, '    '));
  }
}

function bridgeVerb() {
  const [end, asked] = rest;
  const b = bridge(end, asked);
  if (json) return console.log(JSON.stringify({ periodEnd: end || null, requestedOn: asked || null, ...b }, null, 2));
  if (!b.state) {
    console.error(`beadcause-engagement: ${b.why}`);
    process.exit(1);
  }
  console.log(`${end} → ${asked}: ${b.state}`);
  console.log(wrap(b.why, 84, '  '));
}

({ show, dates, letter: letterVerb, firms, bridge: bridgeVerb })[verb]();

if (has('--strict') && !schedule(undefined, boundary).settable) process.exit(1);
