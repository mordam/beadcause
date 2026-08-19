#!/usr/bin/env node
//
// The control corpus — SOC 2, 27001 and 42001 in one closed vocabulary — bc-4r10.1.
//
//   npm test                    (runs it alongside the other suites)
//   node test/controls.mjs      (on its own)
//
// Nothing here touches git, a tracker or the network: the corpus ships with beadcause, so
// this suite is the corpus checking itself. Which is the point — a closed vocabulary is
// only worth anything if something fails when it stops being closed.
//
// What is worth asserting, and why each one is here rather than assumed:
//
// 1. **The counts are pinned.** 61 + 93 + 38. The 2022 revision of 27001 consolidated 114
//    controls into 93; a corpus that quietly regrew to 114, or lost eleven in an edit,
//    would keep validating ids and every report over it would still look fine.
// 2. **A local id collides across frameworks and must not collide in the corpus.** `A.5.2`
//    is roles-and-responsibilities in 27001 and the impact assessment process in 42001.
//    This is the single reason the framework token is inside the id, so it is tested.
// 3. **The crosswalk is closed in both directions.** An edge to an id nobody minted is
//    refused at build time; here that refusal is exercised rather than trusted.
// 4. **The inverse is exactly the inverse.** `satisfiedBy` is computed, and a computed
//    index that has drifted from what it was computed from is worse than no index.
// 5. **The gap is an exact list.** Fifteen SOC 2 criteria have no inbound edge, for two
//    stated reasons. Pinned, because the failure mode this whole file guards against is
//    somebody making the matrix look full — and the honest fix (27001 clauses, 27701) will
//    change this list, and should have to say so.
// 6. **An id nobody minted is refused and said out loud.** Dropped silently, an advocate
//    writes the same invented control every run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  FRAMEWORKS,
  FRAMEWORK_TOKENS,
  corpus,
  control,
  isControl,
  byFramework,
  frameworkOf,
  crosswalk,
  satisfiedBy,
  unclaimed,
  controlsIn,
  keepControls,
} = await import('../lib/controls.js');

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const C = corpus();

/* ------------------------------------------------------------- the frameworks */

console.log('the framework axis, closed');

check('exactly three frameworks', FRAMEWORK_TOKENS.length === 3, FRAMEWORK_TOKENS.join(', '));
check(
  'every framework declares a token equal to its key, a name, an edition and a kind',
  FRAMEWORK_TOKENS.every((t) => {
    const f = FRAMEWORKS[t];
    return f.token === t && f.name && f.edition && (f.kind === 'criterion' || f.kind === 'control');
  })
);
check('SOC 2 holds criteria, both ISO standards hold controls', FRAMEWORKS.SOC2.kind === 'criterion' && FRAMEWORKS.ISO27001.kind === 'control' && FRAMEWORKS.ISO42001.kind === 'control');
check('a token nobody minted is not a framework', frameworkOf('NIST80053.AC-2') === null && byFramework('NIST80053').length === 0);
check('the token in a real id resolves', frameworkOf('ISO27001.A.8.3') === 'ISO27001');

/* ------------------------------------------------------------------ the counts */

console.log('\nthe counts, pinned');

check('61 Trust Services Criteria', byFramework('SOC2').length === 61, String(byFramework('SOC2').length));
check('93 ISO/IEC 27001:2022 Annex A controls', byFramework('ISO27001').length === 93, String(byFramework('ISO27001').length));
check('38 ISO/IEC 42001:2023 Annex A controls', byFramework('ISO42001').length === 38, String(byFramework('ISO42001').length));
check('192 records in one corpus, and the index agrees with the tables', C.size === 192 && C.ids.size === 192);

// The 27001 themes, by their own counts — a consolidation that lost a whole theme would
// still leave the total right if something else grew.
const theme = (n) => byFramework('ISO27001').filter((r) => r.group === String(n)).length;
check('27001 themes are 37 organizational, 8 people, 14 physical, 34 technological', theme(5) === 37 && theme(6) === 8 && theme(7) === 14 && theme(8) === 34, [theme(5), theme(6), theme(7), theme(8)].join('/'));

const cc = byFramework('SOC2').filter((r) => r.group === 'CC');
check('33 of the criteria are the common criteria, the rest are the elective categories', cc.length === 33 && byFramework('SOC2').length - cc.length === 28, String(cc.length));

/* -------------------------------------------------------------- record integrity */

console.log('\nevery record');

check('has an id of the shape FRAMEWORK.local, matching its own framework field', [...C.ids.values()].every((r) => r.id === `${r.framework}.${r.local}` && FRAMEWORKS[r.framework]));
check('carries a title and a definition, neither of them empty', [...C.ids.values()].every((r) => r.title.trim().length > 3 && r.definition.trim().length > 20));
check('resolves to a named group in its own framework', [...C.ids.values()].every((r) => r.group && r.groupName === FRAMEWORKS[r.framework].groups[r.group]));
check('carries the kind its framework declares', [...C.ids.values()].every((r) => r.kind === FRAMEWORKS[r.framework].kind));
check('is frozen, because the corpus is shared with every caller in the process', (() => {
  const r = control('SOC2.CC6.1');
  try {
    r.title = 'mutated';
  } catch {
    /* strict-mode throw is the other acceptable answer */
  }
  return control('SOC2.CC6.1').title !== 'mutated' && Object.isFrozen(r);
})());

// The reason the framework token lives inside the id rather than beside it.
const iso27 = control('ISO27001.A.5.2');
const iso42 = control('ISO42001.A.5.2');
check(
  'the same local id in two frameworks is two different records',
  iso27 && iso42 && iso27.local === iso42.local && iso27.id !== iso42.id && iso27.title !== iso42.title,
  `${iso27?.title} vs ${iso42?.title}`
);

/* ------------------------------------------------------------------ the crosswalk */

console.log('\nthe crosswalk');

const declared = [...C.ids.values()].flatMap((r) => r.crosswalk.map((t) => [r.id, t]));
check('213 declared edges, and every one of them resolves', declared.length === C.edges && declared.every(([, t]) => isControl(t)), String(declared.length));
check('no edge points at itself', declared.every(([from, to]) => from !== to));
check(
  'edges live on controls only — no criterion declares one',
  byFramework('SOC2').every((r) => r.crosswalk.length === 0)
);
check(
  'and every ISO control declares at least one, so none is a dead end',
  byFramework('ISO27001').every((r) => r.crosswalk.length) && byFramework('ISO42001').every((r) => r.crosswalk.length),
  [...byFramework('ISO27001'), ...byFramework('ISO42001')].filter((r) => !r.crosswalk.length).map((r) => r.id).join(' ')
);
check(
  '42001 reaches 27001 as well as SOC 2 — the same implementation under three names',
  crosswalk('ISO42001.A.6.2.8').includes('ISO27001.A.8.15') && crosswalk('ISO42001.A.6.2.8').includes('SOC2.CC7.2')
);

// The inverse index, against the thing it was computed from.
const rebuilt = new Map();
for (const [from, to] of declared) {
  if (!rebuilt.has(to)) rebuilt.set(to, []);
  rebuilt.get(to).push(from);
}
check(
  'satisfiedBy is exactly the inverse of the declared edges, for every id in the corpus',
  [...C.ids.keys()].every((id) => {
    const expected = (rebuilt.get(id) || []).slice().sort();
    return JSON.stringify(satisfiedBy(id)) === JSON.stringify(expected);
  })
);
check('CC6.1 is satisfied by more than one 27001 control and by 42001 as well', satisfiedBy('SOC2.CC6.1').filter((id) => id.startsWith('ISO27001.')).length >= 5 && satisfiedBy('SOC2.CC6.1').some((id) => id.startsWith('ISO42001.')));
check('an id with nothing pointing at it answers with an empty list, not undefined', Array.isArray(satisfiedBy('SOC2.CC1.2')) && satisfiedBy('SOC2.CC1.2').length === 0);

/* ------------------------------------------------------------------- the gap list */

console.log('\nthe gap, stated rather than papered over');

// Two reasons, and they are different reasons. Split so a change to one is legible.
const CLAUSE_TERRITORY = ['SOC2.CC1.2', 'SOC2.CC3.3', 'SOC2.CC5.2'];
const PRIVACY_27701_TERRITORY = [
  'SOC2.PI1.4', 'SOC2.PI1.5',
  'SOC2.P2.1', 'SOC2.P3.2', 'SOC2.P5.1', 'SOC2.P5.2',
  'SOC2.P6.1', 'SOC2.P6.2', 'SOC2.P6.3', 'SOC2.P6.4', 'SOC2.P6.5', 'SOC2.P6.7',
];
assert.equal(CLAUSE_TERRITORY.length + PRIVACY_27701_TERRITORY.length, 15);

check(
  'exactly fifteen criteria have no inbound edge, and they are exactly these fifteen',
  JSON.stringify(unclaimed('SOC2')) === JSON.stringify([...CLAUSE_TERRITORY, ...PRIVACY_27701_TERRITORY]),
  unclaimed('SOC2').join(' ')
);
check(
  'of the common criteria, only the three that are management-system clause matter',
  JSON.stringify(unclaimed('SOC2').filter((id) => control(id).group === 'CC')) === JSON.stringify(CLAUSE_TERRITORY)
);
check(
  'every other common criterion is claimed by at least one ISO control',
  cc.filter((r) => !CLAUSE_TERRITORY.includes(r.id)).every((r) => satisfiedBy(r.id).length > 0),
  cc.filter((r) => !CLAUSE_TERRITORY.includes(r.id) && !satisfiedBy(r.id).length).map((r) => r.id).join(' ')
);
check('the availability, confidentiality and processing-integrity categories are reached too', ['SOC2.A1.1', 'SOC2.A1.2', 'SOC2.A1.3', 'SOC2.C1.1', 'SOC2.C1.2', 'SOC2.PI1.1', 'SOC2.PI1.2', 'SOC2.PI1.3'].every((id) => satisfiedBy(id).length > 0));

/* --------------------------------------------------- refusing what nobody minted */

console.log('\nan id nobody minted');

check('is not a control', !isControl('ISO42001.A.6.2.9') && !isControl('SOC2.CC6.9') && !isControl('ISO27001.A.8.35'));
check('and neither is an empty, blank or non-string one', !isControl('') && !isControl('   ') && !isControl(null) && !isControl(undefined) && !isControl({}));
check('control() answers null rather than undefined', control('SOC2.CC6.9') === null && control(null) === null);
check('a real id with surrounding whitespace still resolves', control('  ISO27001.A.8.3  ')?.id === 'ISO27001.A.8.3');

const kept = keepControls(['ISO27001.A.8.3', 'ISO42001.A.6.2.9', 'SOC2.CC6.1', 'ISO27001.A.8.3', '', 'nonsense']);
check('keepControls keeps what resolves', JSON.stringify(kept.ids) === JSON.stringify(['ISO27001.A.8.3', 'SOC2.CC6.1']), JSON.stringify(kept.ids));
check('and reports what it dropped rather than swallowing it', JSON.stringify(kept.dropped) === JSON.stringify(['ISO42001.A.6.2.9', 'nonsense']), JSON.stringify(kept.dropped));
check('a repeated id is kept once, on either side', keepControls(['SOC2.CC6.1', 'SOC2.CC6.1', 'x.y', 'x.y']).ids.length === 1 && keepControls(['SOC2.CC6.1', 'SOC2.CC6.1', 'x.y', 'x.y']).dropped.length === 1);
check('a non-array, or nothing at all, is an empty answer and not a throw', JSON.stringify(keepControls()) === JSON.stringify({ ids: [], dropped: [] }) && keepControls('SOC2.CC6.1').ids.length === 0);

/* ------------------------------------------------------------- ids written in prose */

console.log('\nids written in prose');

const prose = 'This exercises ISO27001.A.8.3 and SOC2.CC6.1, alongside ISO42001.A.6.2.8. It does not exercise ISO42001.A.6.2.9, and lib/controls.js is not an id.';
check('are found by shape and then kept only if the corpus has them', JSON.stringify(controlsIn(prose)) === JSON.stringify(['ISO27001.A.8.3', 'SOC2.CC6.1', 'ISO42001.A.6.2.8']), JSON.stringify(controlsIn(prose)));
check('a trailing sentence period is not part of the id', controlsIn('It satisfies SOC2.CC7.2.').includes('SOC2.CC7.2'));
check('an id at the very end of the text, with no punctuation, is still found', controlsIn('see ISO27001.A.5.1')[0] === 'ISO27001.A.5.1');
check('a repeat is returned once', controlsIn('SOC2.CC6.1 and again SOC2.CC6.1').length === 1);
check('empty prose is an empty answer', controlsIn('').length === 0 && controlsIn(null).length === 0 && controlsIn(undefined).length === 0);
check('a bare local id with no framework token is not an id', controlsIn('the control A.8.3 covers it').length === 0);

/* ------------------------------------------------------ the corpus is not a copy */

console.log('\nthe corpus is a vocabulary, not a copy of three standards');

// The paraphrase rule from the file header, made checkable. A definition that grew into a
// block quote of normative text is the shape this corpus must never take — it exists to
// join a bead to a control, not to reproduce three copyrighted documents.
const longest = [...C.ids.values()].reduce((a, r) => (r.definition.length > a.definition.length ? r : a));
check('no definition has grown into a block quote of normative text', longest.definition.length < 320, `${longest.id} at ${longest.definition.length} chars`);
check('and none of them is presented as a quotation', [...C.ids.values()].every((r) => !/^\s*["“]/.test(r.definition)));

// It ships with beadcause and reads nothing: an absent corpus here is a broken build, not a
// state to degrade into, so there must be no filesystem or config dependency to be absent.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'controls.js'), 'utf8');
check('lib/controls.js imports nothing — no fs, no config, nothing to be missing at runtime', !/^import\s/m.test(src), (src.match(/^import .*/m) || [])[0] || '');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
