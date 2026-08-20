#!/usr/bin/env node
/**
 * The crosswalk matrix as a command — what answers what, and what nothing answers.
 *
 *   beadcause-crosswalk matrix              every obligation and what claims to satisfy it
 *   beadcause-crosswalk shared [n]          controls answering n standards at once (3)
 *   beadcause-crosswalk uncovered           in-scope obligations nothing claims — the check
 *   beadcause-crosswalk undecided           obligations waiting on a statement of applicability
 *   beadcause-crosswalk control <id>        one record, both directions, and its indirect reach
 *   beadcause-crosswalk csv                 the dense grid, for a spreadsheet
 *
 * **`matrix` reads down the columns and `shared` reads along the rows, and that is the whole
 * difference between them.** A crosswalk answers two questions that look like one: *is this
 * obligation covered* is a column, and *does this control earn its keep three times over* is
 * a row. Drawn as an actual grid in a terminal it answers neither — two hundred columns is
 * not a thing anybody reads — so `csv` is where the grid lives, because a spreadsheet is
 * where a blank column is found by eye. All three are the same computation.
 *
 * `uncovered` is the one to gate on. It is deliberately narrower than "every empty column":
 * an Annex A control whose applicability nobody has decided yet is not an obligation, and
 * listing it as an uncovered one would bury the fourteen that genuinely are. `undecided`
 * counts those out loud instead, so the narrowing is visible rather than quiet.
 *
 * It reads. It writes nothing — no tracker, no repository, no ref — and every cell is asked
 * of the corpus on the call rather than stored anywhere, so this needs no config directory,
 * no git and no network.
 *
 * `--json` on any verb for the payload rather than the rendering, `--framework <token>` to
 * narrow to one standard, and `--strict` to exit 1 when anything in scope is unclaimed.
 */
import { FRAMEWORKS } from '../lib/controls.js';
import {
  DECIDED_BY,
  ELECTED,
  HELD_BY,
  columns,
  counts,
  csv,
  matrix,
  reach,
  rows,
  shared,
  summarise,
  uncovered,
  undecided,
} from '../lib/crosswalkreport.js';

const argv = process.argv.slice(2);
const VERBS = ['matrix', 'shared', 'uncovered', 'undecided', 'control', 'csv'];
const has = (n) => argv.includes(n);
const valueOf = (n) => {
  const at = argv.indexOf(n);
  return at >= 0 ? argv[at + 1] : null;
};
const positional = argv.filter((a, i) => !a.startsWith('-') && argv[i - 1] !== '--framework');
const verb = VERBS.includes(positional[0]) ? positional[0] : 'matrix';
const named = VERBS.includes(positional[0]) ? positional[1] : positional[0];

const HELP = [
  'beadcause-crosswalk matrix          every obligation and what claims to satisfy it',
  'beadcause-crosswalk shared [n]      controls answering n standards at once (default 3)',
  'beadcause-crosswalk uncovered       in-scope obligations nothing claims — the check',
  'beadcause-crosswalk undecided       obligations waiting on a statement of applicability',
  'beadcause-crosswalk control <id>    one record, both directions, and its indirect reach',
  'beadcause-crosswalk csv             the dense grid, for a spreadsheet',
  '',
  '  --json                the payload rather than the rendering',
  '  --framework <token>   narrow to one standard',
  '  --strict              exit 1 when anything in scope is unclaimed',
  '',
  `  subject: ${HELD_BY} · categories elected: ${ELECTED.join(', ')} (${DECIDED_BY.categories})`,
  `  applicability of an Annex A control is ${DECIDED_BY.applicability}'s, and is not decided yet`,
];

const token = valueOf('--framework');
if (token && !FRAMEWORKS[token]) {
  console.error(`beadcause-crosswalk: "${token}" is not a framework — ${Object.keys(FRAMEWORKS).join(', ')}`);
  process.exit(1);
}
if (has('--help') || has('-h') || (positional[0] && !VERBS.includes(positional[0]))) {
  const bad = Boolean(positional[0]) && !VERBS.includes(positional[0]);
  const out = bad ? console.error : console.log;
  if (bad) out(`beadcause-crosswalk: no verb "${positional[0]}"`);
  out(HELP.join('\n'));
  process.exit(bad ? 1 : 0);
}

// `--framework` narrows whichever axis the verb is about: the obligations a column view
// lists, the records a row view lists. `matrix --framework SOC2` is still answered by
// controls from every standard, which is the whole point of asking.
const scope = token ? { frameworks: [token] } : {};
const json = has('--json');
// Covered is a filled mark, an in-scope hole is an empty one, and the two that are not
// findings get their own glyphs — so a blank column can be read without the legend.
const MARK = { declined: '–', undecided: '?' };
const markOf = (c) => (c.covered ? '●' : c.inScope ? '○' : MARK[c.applicability]);

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

const rule = (label) => console.log(`── ${label} ${'─'.repeat(Math.max(0, 74 - label.length))}`);

function renderColumns(list, { why = false } = {}) {
  let framework = null;
  let group = null;
  for (const c of list) {
    if (c.framework !== framework) {
      framework = c.framework;
      group = null;
      console.log();
      rule(FRAMEWORKS[c.framework].name);
    }
    if (c.group !== group) {
      group = c.group;
      console.log(`  ${c.groupName || c.group}`);
    }
    console.log(`    ${markOf(c)} ${c.id.padEnd(26)} ${c.title}`);
    if (c.claimedBy.length) console.log(`        claimed by ${c.claimedBy.join(', ')}`);
    else if (why) console.log(`        nothing in the corpus claims it · ${c.applicability}`);
  }
}

function matrixVerb() {
  const cols = columns(scope);
  if (json) return console.log(JSON.stringify({ summary: summarise(), counts: counts(scope), ...matrix(scope) }, null, 2));
  console.log(summarise());
  renderColumns(cols);
  console.log();
  const c = counts(scope);
  console.log(
    `${c.covered} of ${c.obligations} obligations have something pointed at them · ` +
      `${c.uncovered} in scope and unclaimed · ${c.applicability.undecided} undecided · ${c.applicability.declined} declined`
  );
}

function sharedVerb() {
  const min = Number.isInteger(Number(named)) && named ? Number(named) : 3;
  const list = shared(min, scope);
  if (json) return console.log(JSON.stringify(list, null, 2));
  console.log(
    `${list.length} record${list.length === 1 ? '' : 's'} answer${list.length === 1 ? 's' : ''} ${min} ` +
      `certifiable standard${min === 1 ? '' : 's'} at once, of ${rows(scope).length} that claim anything at all`
  );
  console.log();
  for (const row of list) {
    console.log(`  ${row.id.padEnd(26)} ${row.title}`);
    console.log(`      ${row.frameworks.join(' + ')}${row.guidance ? ' · guidance, so its own standard is not counted' : ''}`);
    console.log(wrap(`answers ${row.covers.join(', ')}`, 84, '      '));
    console.log();
  }
}

function uncoveredVerb() {
  const list = uncovered(scope);
  if (json) return console.log(JSON.stringify(list, null, 2));
  if (!list.length) {
    console.log('Nothing in scope is unclaimed. Every elected criterion and every mandatory clause has an edge pointed at it.');
    return;
  }
  console.log(
    `${list.length} obligation${list.length === 1 ? ' is' : 's are'} in scope and nothing in the corpus claims ` +
      `${list.length === 1 ? 'it' : 'them'} — work no other standard's control does for you.`
  );
  renderColumns(list, { why: true });
}

function undecidedVerb() {
  const list = undecided(scope);
  if (json) return console.log(JSON.stringify(list, null, 2));
  const withEdges = list.filter((c) => c.covered).length;
  console.log(
    `${list.length} Annex A controls, applicability undecided — ${DECIDED_BY.applicability} is the statement that decides it. ` +
      `${withEdges} already have something pointed at them.`
  );
  console.log('Until that lands they are counted here rather than reported as gaps, which would inflate the list with controls that may be excluded.');
  renderColumns(list);
}

function controlVerb() {
  const wanted = String(named || '').trim();
  const col = columns().find((c) => c.id === wanted);
  const row = rows().find((r) => r.id === wanted);
  if (!col && !row) {
    console.error(`beadcause-crosswalk: "${wanted || '(none named)'}" is not in the control corpus`);
    process.exit(1);
  }
  const record = col || row;
  const indirect = [...reach(wanted)].filter((id) => !(row?.covers || []).includes(id)).sort();
  if (json) return console.log(JSON.stringify({ column: col || null, row: row || null, indirect }, null, 2));
  console.log(`${record.id} — ${record.title}`);
  console.log(`${FRAMEWORKS[record.framework].name} · ${record.groupName || record.group} · ${record.kind}`);
  if (col) console.log(`applicability: ${col.applicability}${col.inScope ? ' (in scope)' : ''}`);
  console.log();
  const field = (label, value) => {
    console.log(`  ${label}`);
    console.log(wrap(value && value.length ? value : 'nothing', 84, '    '));
  };
  field('Claimed by — what says it satisfies this', (col?.claimedBy || []).join(', '));
  field('Answers — what this claims to satisfy', (row?.covers || []).join(', '));
  if (row) field('Standards it touches at once', `${row.frameworks.join(' + ')} (span ${row.span})`);
  // Kept apart from the two above on purpose: a cell is a claim somebody defends to an
  // auditor, and a transitive reach is an argument about why work is not duplicated.
  field('Reaches indirectly, through those — not a claim, and not a cell', indirect.join(', '));
}

function csvVerb() {
  console.log(csv(scope));
}

({ matrix: matrixVerb, shared: sharedVerb, uncovered: uncoveredVerb, undecided: undecidedVerb, control: controlVerb, csv: csvVerb })[verb]();

if (has('--strict') && uncovered(scope).length) process.exit(1);
