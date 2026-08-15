#!/usr/bin/env node
/**
 * The system boundary as a command — what is inside, what is carved out, who the report
 * is written for, and what the record admits it does not know.
 *
 *   beadcause-boundary show      [org]    the whole record, as a person reads it
 *   beadcause-boundary inside    [org]    what is inside the boundary, by kind
 *   beadcause-boundary carved    [org]    what is carved out, and what each still bears on
 *   beadcause-boundary entities  [org]    the named user entities
 *   beadcause-boundary subservice [org]   each one's carve-out or inclusive decision, and its CUECs
 *   beadcause-boundary gaps      [org]    what is not enumerated, and where the rest is held
 *   beadcause-boundary declare   [org]    the projection lib/election.js `declare` takes
 *
 * **`gaps` is the one worth running.** Six of the seven censuses in the shipped record are
 * partial, and the whole argument of lib/boundary.js is that a partial census is a finding
 * rather than a blank. A boundary tool that could only print what was written down would
 * be a tool that made an unsurveyed estate look finished.
 *
 * It reads. It writes nothing — no tracker, no repository, no ref. The register ships
 * compiled into the release, so this needs no config directory, no git and no network, and
 * runs the same on a machine that has never been enrolled.
 *
 * `--json` on any verb for the payload rather than the rendering; both are the same
 * computation, which is what stops the readable artefact and the machine-readable one
 * disagreeing. Exit 1 when a named organisation has no boundary, and — for `gaps` with
 * `--strict` — when there is at least one gap, so a check can gate on it.
 */
import {
  BOUNDARIES,
  boundaryFor,
  only,
  organisations,
  inside,
  carvedOut,
  userEntities,
  subservice,
  cuecs,
  gaps,
  declaration,
  summarise,
  KINDS,
  CENSUS_KINDS,
} from '../lib/boundary.js';

const argv = process.argv.slice(2);
const VERBS = ['show', 'inside', 'carved', 'entities', 'subservice', 'gaps', 'declare'];
const has = (n) => argv.includes(n);
const positional = argv.filter((a) => !a.startsWith('-'));
const verb = VERBS.includes(positional[0]) ? positional[0] : 'show';
const named = VERBS.includes(positional[0]) ? positional[1] : positional[0];

if (has('--help') || has('-h') || (positional[0] && !VERBS.includes(positional[0]) && !boundaryFor(positional[0]))) {
  const bad = positional[0] && !VERBS.includes(positional[0]) && !boundaryFor(positional[0]);
  const out = bad ? console.error : console.log;
  if (bad) out(`beadcause-boundary: no boundary recorded for "${positional[0]}"`);
  out(
    [
      'beadcause-boundary show       [org]   the whole record',
      'beadcause-boundary inside     [org]   what is inside the boundary',
      'beadcause-boundary carved     [org]   what is carved out, and what it still bears on',
      'beadcause-boundary entities   [org]   the named user entities',
      'beadcause-boundary subservice [org]   carve-out or inclusive, per organisation',
      'beadcause-boundary gaps       [org]   what is not enumerated, and where the rest is held',
      'beadcause-boundary declare    [org]   the projection lib/election.js `declare` takes',
      '',
      '  --json      the payload rather than the rendering',
      '  --strict    (gaps) exit 1 when there is at least one gap',
      '',
      `  organisations with a boundary in this release: ${organisations().join(', ') || '(none)'}`,
    ].join('\n')
  );
  process.exit(bad ? 1 : 0);
}

const record = named ? boundaryFor(named) : only();
if (!record) {
  console.error(
    named
      ? `beadcause-boundary: no boundary recorded for "${named}"`
      : `beadcause-boundary: this release ships ${organisations().length} boundaries — name one of ${organisations().join(', ')}`
  );
  process.exit(1);
}

const json = (v) => console.log(JSON.stringify(v, null, 2));
const bullet = (s) => `  ${s}`;
const wrap = (s, indent = 6) => {
  const pad = ' '.repeat(indent);
  const lines = [];
  let line = '';
  for (const word of String(s || '').split(/\s+/).filter(Boolean)) {
    if (line && (pad + line + ' ' + word).length > 96) {
      lines.push(pad + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(pad + line);
  return lines.join('\n');
};

function renderComponents(list) {
  if (!list.length) return [bullet('(none recorded — see `gaps`)')];
  const out = [];
  for (const kind of KINDS) {
    const of = list.filter((c) => c.kind === kind);
    if (!of.length) continue;
    out.push(bullet(`${kind}`));
    for (const c of of) {
      out.push(`    ${c.id} — ${c.label}`);
      out.push(wrap(c.why));
      if (c.bearsOn) out.push(wrap(`bears on: ${c.bearsOn}`));
    }
  }
  return out;
}

function renderGaps(list) {
  if (!list.length) return [bullet('nothing outstanding — every list is enumerated')];
  return list.flatMap((g) => [
    bullet(`${g.kind} — ${g.recorded} recorded${g.held ? `, the rest held in ${g.held}` : ''}`),
    wrap(g.why),
  ]);
}

if (verb === 'declare') {
  const d = declaration(record);
  if (has('--json')) json(d);
  else console.log([`name: ${d.name}`, 'description:', wrap(d.description, 2)].join('\n'));
  process.exit(0);
}

if (verb === 'inside') {
  const list = inside(record);
  if (has('--json')) json(list);
  else console.log([`Inside ${record.system}`, ...renderComponents(list)].join('\n'));
  process.exit(0);
}

if (verb === 'carved') {
  const list = carvedOut(record);
  if (has('--json')) json(list);
  else console.log([`Carved out of ${record.system}`, ...renderComponents(list)].join('\n'));
  process.exit(0);
}

if (verb === 'entities') {
  const list = userEntities(record);
  if (has('--json')) json(list);
  else {
    console.log(
      [
        `User entities of ${record.system}`,
        ...(list.length
          ? list.flatMap((e) => [bullet(`${e.label} (${e.id})`), wrap(e.why), wrap(`recorded from ${e.source || '—'}`)])
          : [bullet('(none named — see `gaps`)')]),
      ].join('\n')
    );
  }
  process.exit(0);
}

if (verb === 'subservice') {
  const list = subservice(record);
  const complementary = cuecs(record);
  if (has('--json')) json({ subservice: list, cuecs: complementary });
  else {
    console.log(
      [
        `Subservice organisations of ${record.system}`,
        ...(list.length
          ? list.flatMap((s) => [
              bullet(`${s.label} (${s.id}) — ${s.method}`),
              wrap(s.provides),
              ...(s.method === 'carve-out'
                ? (s.cuecs || []).map((c) => wrap(`CUEC: ${c}`))
                : [wrap('inclusive: its controls are in the test population')]),
            ])
          : [bullet('(none recorded — see `gaps`; an empty list here means unsurveyed, not none)')]),
      ].join('\n')
    );
  }
  process.exit(0);
}

if (verb === 'gaps') {
  const list = gaps(record);
  if (has('--json')) json(list);
  else console.log([`What ${record.serviceOrganisation}'s boundary does not yet know`, ...renderGaps(list)].join('\n'));
  process.exit(has('--strict') && list.length ? 1 : 0);
}

// show
if (has('--json')) {
  json({ ...record, gaps: gaps(record), declaration: declaration(record), summary: summarise(record) });
  process.exit(0);
}

const census = record.census || {};
console.log(
  [
    `${record.serviceOrganisation} — ${record.system}`,
    record.first ? '  the first service organisation recorded, and today the only one' : null,
    `  subject decided on ${record.decidedBy}`,
    '',
    'Scope statement',
    wrap(record.statement, 2),
    '',
    'Inside',
    ...renderComponents(inside(record)),
    '',
    'Carved out',
    ...renderComponents(carvedOut(record)),
    '',
    'User entities',
    ...(userEntities(record).length
      ? userEntities(record).map((e) => bullet(`${e.label} (${e.id}) — recorded from ${e.source || '—'}`))
      : [bullet('(none named)')]),
    '',
    'Subservice organisations',
    ...(subservice(record).length
      ? subservice(record).map((s) => bullet(`${s.label} — ${s.method}`))
      : [bullet('(none recorded — an empty list here means unsurveyed, not none)')]),
    '',
    'Census',
    ...CENSUS_KINDS.map((k) =>
      bullet(`${k.padEnd(12)} ${census[k]?.state || '—'}${census[k]?.held ? ` · held in ${census[k].held}` : ''}`)
    ),
    '',
    'Gaps',
    ...renderGaps(gaps(record)),
    '',
    summarise(record),
  ]
    .filter((l) => l !== null)
    .join('\n')
);
