#!/usr/bin/env node
/**
 * The system description as a command — Section 3 of a SOC 2 report, generated.
 *
 *   beadcause-description show       [org]   the whole description, as markdown
 *   beadcause-description sections   [org]   one line per section: what state it is in, and why
 *   beadcause-description holes      [org]   everything the description admits it does not know
 *   beadcause-description criteria   [org]   the criteria in scope, and what claims to meet each
 *   beadcause-description assertion  [org]   the management assertion draft, and what stops it being signed
 *
 * **`holes` is the one worth running.** A description that could only print what was
 * written down would be a document that made an unsurveyed estate look finished, and
 * `holes` is the errand list that comes out of refusing to do that.
 *
 * The criteria in scope come from the install's own election (`lib/election.js`) when it
 * has one, and from the categories the policy set is written against when it does not —
 * in which case the document says `presumed` on its face. That is the one thing here that
 * reads state: the registers themselves ship compiled into the release, so everything else
 * runs on a machine that has never been enrolled, and an install with no election reads
 * back as nothing rather than as a failure.
 *
 * `--json` on any verb for the payload rather than the rendering, both from the same
 * computation. `--period 2026-09-01..2026-12-01` or `--as-of 2026-09-01` states the period,
 * which nothing records yet (bc-j0o3) and which the assertion cannot be signed without.
 * `--sign "Name" --title "Chief Executive"` names who is going to sign — naming is not
 * signing, and nothing here signs anything.
 *
 * Exit 1 when a named organisation has no boundary; with `--strict`, also when the
 * description has a section nothing can write (`show`, `sections`), a hole (`holes`), or
 * anything at all stopping the assertion being signed (`assertion`), so a readiness check
 * can gate on it.
 */
import { boundaryFor, only, organisations } from '../lib/boundary.js';
import { COMMITMENTS, suppliable } from '../lib/commitments.js';
import { current, scope } from '../lib/election.js';
import {
  assertion,
  describe,
  holes,
  render,
  renderAssertion,
  summarise,
  unwritable,
} from '../lib/systemdescription.js';

const argv = process.argv.slice(2);
const VERBS = ['show', 'sections', 'holes', 'criteria', 'assertion'];
const has = (n) => argv.includes(n);
const value = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const FLAGS_WITH_VALUES = ['--period', '--as-of', '--sign', '--title'];
const positional = argv.filter((a, i) => !a.startsWith('-') && !FLAGS_WITH_VALUES.includes(argv[i - 1]));
const verb = VERBS.includes(positional[0]) ? positional[0] : 'show';
const named = VERBS.includes(positional[0]) ? positional[1] : positional[0];

const USAGE = [
  'beadcause-description show      [org]   the whole description, as markdown',
  'beadcause-description sections  [org]   one line per section, and what state it is in',
  'beadcause-description holes     [org]   everything the description admits it does not know',
  'beadcause-description criteria  [org]   the criteria in scope, and what claims to meet each',
  'beadcause-description assertion [org]   the management assertion draft, unsigned',
  '',
  '  --json                       the payload rather than the rendering',
  '  --period FROM..TO            the observation period, as YYYY-MM-DD..YYYY-MM-DD',
  '  --as-of DATE                 a Type I description, at a date',
  '  --sign NAME --title TITLE    who is going to sign the assertion. Naming is not signing',
  '  --strict                     exit 1 when something is missing, so a check can gate on it',
  '',
  `  organisations with a boundary in this release: ${organisations().join(', ') || '(none)'}`,
];

if (has('--help') || has('-h') || (positional[0] && !VERBS.includes(positional[0]) && !boundaryFor(positional[0]))) {
  const bad = positional[0] && !VERBS.includes(positional[0]) && !boundaryFor(positional[0]);
  const out = bad ? console.error : console.log;
  if (bad) out(`beadcause-description: no boundary recorded for "${positional[0]}"`);
  out(USAGE.join('\n'));
  process.exit(bad ? 1 : 0);
}

const record = named ? boundaryFor(named) : only();
if (!record) {
  console.error(
    named
      ? `beadcause-description: no boundary recorded for "${named}"`
      : `beadcause-description: this release ships ${organisations().length} boundaries — name one of ${organisations().join(', ')}`
  );
  process.exit(1);
}

/** The period the caller stated, or `null`. Refused loudly rather than quietly dropped. */
function period() {
  const range = value('--period');
  const asOf = value('--as-of');
  if (range && asOf) {
    console.error('beadcause-description: --period and --as-of say different things about the same report; pass one');
    process.exit(1);
  }
  if (asOf) return { kind: 'as-of', asOf };
  if (!range) return null;
  const [from, to] = range.split('..');
  return { kind: 'over', from, to };
}

/**
 * What this install has elected, or nothing.
 *
 * `current()` never throws and never blocks — a machine with no common repo, no git or no
 * ref reads back as nothing — so an unenrolled install falls through to the presumption
 * and says so on the document rather than failing to produce one.
 */
const elected = scope(await current());
/**
 * The commitments register is the one supplied section this CLI passes — see
 * `lib/commitments.js`. Environment, changes and incidents stay unsupplied: nothing here
 * lands a register for them, and a flag would make a hand-written section one step away.
 */
const description = describe(record, {
  criteria: elected.length ? elected : null,
  period: period(),
  supplied: { commitments: suppliable(COMMITMENTS) },
});

const json = (v) => console.log(JSON.stringify(v, null, 2));
const strict = has('--strict');

if (verb === 'holes') {
  const list = holes(description);
  if (has('--json')) json(list);
  else if (!list.length) console.log(`Nothing outstanding — every section of ${record.serviceOrganisation}'s description is complete`);
  else {
    console.log(`What ${record.serviceOrganisation}'s system description does not yet know`);
    for (const h of list) {
      console.log(`  ${h.section} · ${h.of}${h.held ? ` — held in ${h.held}` : ''}`);
      console.log(`      ${h.why}`);
    }
    for (const s of unwritable(description)) {
      console.log(`  ${s.id} · the whole section — held in ${s.heldElsewhere}`);
    }
  }
  process.exit(strict && (list.length || unwritable(description).length) ? 1 : 0);
}

if (verb === 'sections') {
  const rows = description.sections.map((s) => ({
    id: s.id,
    title: s.title,
    state: s.state,
    entries: s.entries.length,
    holes: s.holes.length,
    from: s.from,
  }));
  if (has('--json')) json(rows);
  else {
    console.log(`${record.serviceOrganisation} — ${record.system}`);
    for (const r of rows) {
      console.log(
        `  ${r.state.padEnd(12)} ${r.id.padEnd(15)} ${String(r.entries).padStart(3)} entr${r.entries === 1 ? 'y ' : 'ies'}` +
          `  ${r.holes ? `${r.holes} hole${r.holes === 1 ? '' : 's'}` : ''}`
      );
    }
    console.log(`\n${summarise(description)}`);
  }
  process.exit(strict && unwritable(description).length ? 1 : 0);
}

if (verb === 'criteria') {
  const section = description.sections.find((s) => s.id === 'criteria');
  if (has('--json')) json({ ...description.criteria, entries: section.entries });
  else {
    console.log(
      `${description.criteria.elected.length} criteri${description.criteria.elected.length === 1 ? 'on' : 'a'} in scope` +
        `${description.criteria.presumed ? ' (presumed from the policy set — no election is recorded on this install)' : ''}`
    );
    for (const e of section.entries) {
      console.log(`  ${e.id.padEnd(14)} ${e.title}`);
      console.log(
        `      ${e.documentedBy.length ? e.documentedBy.map((p) => `${p.title} (${p.adoption})`).join('; ') : 'no policy claims it'}` +
          `${e.alsoSatisfies.length ? ` · also satisfied by ${e.alsoSatisfies.join(', ')}` : ''}`
      );
    }
    if (description.criteria.elsewhere.length) {
      console.log(`\n  ${description.criteria.elsewhere.length} elected control(s) are not trust services criteria and do not appear in a SOC 2 description:`);
      console.log(`      ${description.criteria.elsewhere.join(', ')}`);
    }
    for (const id of description.criteria.dropped) console.log(`\n  dropped: ${id} is not in the control corpus`);
  }
  process.exit(strict && description.criteria.dropped.length ? 1 : 0);
}

if (verb === 'assertion') {
  const draft = assertion(description, { signatory: value('--sign'), title: value('--title') });
  if (has('--json')) json(draft);
  else console.log(renderAssertion(draft));
  process.exit(strict && draft.problems.length ? 1 : 0);
}

// show
if (has('--json')) json(description);
else console.log(render(description));
process.exit(strict && !description.writable ? 1 : 0);
